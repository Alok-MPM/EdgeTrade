// ══════════════════════════════════════════════════════════════════════════
// chart-terminal/market-store.js
//
// SINGLE SOURCE OF TRUTH for all live Binance market data used by the chart
// terminal. No other chart-terminal module is allowed to open its own
// WebSocket or call Binance directly — everything goes through this file.
//
//   Binance WS  →  market-store.js  →  (events)  →  every other module
//
// Other modules only ever do two things with this file:
//   1. marketStore.onXxx(callback)   — subscribe to a data stream
//   2. marketStore.setSymbol(...) / marketStore.setInterval(...) — control it
//
// This file renders NOTHING. No DOM writes, no HTML, no CSS. Pure data.
// ══════════════════════════════════════════════════════════════════════════

(function () {

  const BINANCE_REST = 'https://api.binance.com/api/v3';
  const BINANCE_WS = 'wss://stream.binance.com:9443';

  // Reconnect backoff so a dropped connection doesn't spam retries.
  const RECONNECT_DELAY_MS = 2000;
  const MAX_RECONNECT_DELAY_MS = 15000;

  // ── Internal state ────────────────────────────────────────────────────
  const state = {
    symbol: 'BTCUSDT',       // active chart symbol, uppercase, no slash
    interval: '1m',          // active chart timeframe
    watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'], // Market Overview panel
    latestPrice: null,
    latestDepth: null,       // { bids: [...], asks: [...] }
  };

  // ── Internal sockets (never exposed directly) ─────────────────────────
  let klineSocket = null;
  let depthSocket = null;
  let watchlistSocket = null;

  let klineReconnectAttempt = 0;
  let depthReconnectAttempt = 0;
  let watchlistReconnectAttempt = 0;

  // ── Pub/sub ────────────────────────────────────────────────────────────
  // Each list holds callback functions. Keep it plain arrays — no need for
  // anything fancier at this scale.
  const listeners = {
    kline: [],        // fires on every live candle tick: (candle) => {}
    klineHistory: [],  // fires once after fetchCandles resolves: (candles[]) => {}
    depth: [],         // fires on every order book update: ({bids, asks}) => {}
    ticker: [],        // fires per watchlist symbol update: ({symbol, close, open}) => {}
    symbolChange: [],  // fires when setSymbol/setInterval changes context: ({symbol, interval}) => {}
    error: [],         // fires on any socket error: ({stream, error}) => {}
  };

  function on(stream, cb) {
    if (!listeners[stream]) { console.warn('[market-store] unknown stream:', stream); return; }
    listeners[stream].push(cb);
  }
  function off(stream, cb) {
    if (!listeners[stream]) return;
    listeners[stream] = listeners[stream].filter(fn => fn !== cb);
  }
  function emit(stream, payload) {
    listeners[stream].forEach(cb => {
      try { cb(payload); } catch (err) { console.error('[market-store] listener error on', stream, err); }
    });
  }

  // ── REST: historical candles ──────────────────────────────────────────
  async function fetchCandles(symbol = state.symbol, interval = state.interval, limit = 300) {
    const url = `${BINANCE_REST}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Binance klines fetch failed: ' + res.status);
    const raw = await res.json();
    const candles = raw.map(k => ({
      timestamp: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
    emit('klineHistory', candles);
    return candles;
  }

  // ── WS: live kline (candle) stream ────────────────────────────────────
  function connectKline(symbol = state.symbol, interval = state.interval) {
    if (klineSocket) { klineSocket.onclose = null; klineSocket.close(); klineSocket = null; }

    const url = `${BINANCE_WS}/ws/${symbol.toLowerCase()}@kline_${interval}`;
    klineSocket = new WebSocket(url);

    klineSocket.onopen = () => { klineReconnectAttempt = 0; };

    klineSocket.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const k = msg.k;
      const candle = {
        timestamp: k.t,
        open: parseFloat(k.o),
        high: parseFloat(k.h),
        low: parseFloat(k.l),
        close: parseFloat(k.c),
        volume: parseFloat(k.v),
        isClosed: k.x, // true when this candle has finished forming
      };
      state.latestPrice = candle.close;
      emit('kline', candle);
    };

    klineSocket.onerror = (err) => emit('error', { stream: 'kline', error: err });

    klineSocket.onclose = () => {
      // Only auto-reconnect if this socket is still the "current" one —
      // prevents a stale closing socket from reconnecting after setSymbol()
      // has already moved on to a new symbol/interval.
      if (klineSocket && klineSocket.url !== url) return;
      scheduleReconnect('kline', () => connectKline(state.symbol, state.interval));
    };
  }

  // ── WS: live order book depth stream ──────────────────────────────────
  function connectDepth(symbol = state.symbol) {
    if (depthSocket) { depthSocket.onclose = null; depthSocket.close(); depthSocket = null; }

    const url = `${BINANCE_WS}/ws/${symbol.toLowerCase()}@depth20@100ms`;
    depthSocket = new WebSocket(url);

    depthSocket.onopen = () => { depthReconnectAttempt = 0; };

    depthSocket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      state.latestDepth = { bids: data.bids, asks: data.asks };
      emit('depth', state.latestDepth);
    };

    depthSocket.onerror = (err) => emit('error', { stream: 'depth', error: err });

    depthSocket.onclose = () => {
      if (depthSocket && depthSocket.url !== url) return;
      scheduleReconnect('depth', () => connectDepth(state.symbol));
    };
  }

  // ── WS: fixed watchlist ticker stream (Market Overview panel) ─────────
  // Independent of the active chart symbol — persists across symbol/tab
  // switches, exactly like the current site's behavior.
  function connectWatchlist(symbols = state.watchlist) {
    if (watchlistSocket) { watchlistSocket.onclose = null; watchlistSocket.close(); watchlistSocket = null; }

    const streams = symbols.map(s => s.toLowerCase() + '@miniTicker').join('/');
    const url = `${BINANCE_WS}/stream?streams=${streams}`;
    watchlistSocket = new WebSocket(url);

    watchlistSocket.onopen = () => { watchlistReconnectAttempt = 0; };

    watchlistSocket.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const d = msg.data;
      if (!d || !d.s) return;
      emit('ticker', { symbol: d.s, close: parseFloat(d.c), open: parseFloat(d.o) });
    };

    watchlistSocket.onerror = (err) => emit('error', { stream: 'watchlist', error: err });

    watchlistSocket.onclose = () => {
      if (watchlistSocket && watchlistSocket.url !== url) return;
      scheduleReconnect('watchlist', () => connectWatchlist(state.watchlist));
    };
  }

  // ── Reconnect helper with capped exponential backoff ───────────────────
  const attemptCounters = { kline: 0, depth: 0, watchlist: 0 };
  function scheduleReconnect(name, reconnectFn) {
    attemptCounters[name] = (attemptCounters[name] || 0) + 1;
    const delay = Math.min(RECONNECT_DELAY_MS * attemptCounters[name], MAX_RECONNECT_DELAY_MS);
    setTimeout(() => {
      reconnectFn();
    }, delay);
  }

  // ── Public control API ─────────────────────────────────────────────────

  // Switches the active chart symbol/interval: refetches history, resubscribes
  // kline + depth sockets. This is the ONE function chart-cockpit.js should
  // call when the user picks a new market or timeframe.
  async function setSymbol(symbol, interval = state.interval) {
    state.symbol = symbol.toUpperCase();
    state.interval = interval;
    attemptCounters.kline = 0;
    attemptCounters.depth = 0;
    emit('symbolChange', { symbol: state.symbol, interval: state.interval });
    await fetchCandles(state.symbol, state.interval);
    connectKline(state.symbol, state.interval);
    connectDepth(state.symbol);
  }

  async function setInterval_(interval) {
    return setSymbol(state.symbol, interval);
  }

  function setWatchlist(symbols) {
    state.watchlist = symbols;
    attemptCounters.watchlist = 0;
    connectWatchlist(symbols);
  }

  // Call once, on page load, after the chart-terminal is ready to receive data.
  function init({ symbol = state.symbol, interval = state.interval, watchlist = state.watchlist } = {}) {
    state.symbol = symbol.toUpperCase();
    state.interval = interval;
    state.watchlist = watchlist;
    fetchCandles(state.symbol, state.interval).catch(err => emit('error', { stream: 'klineHistory', error: err }));
    connectKline(state.symbol, state.interval);
    connectDepth(state.symbol);
    connectWatchlist(state.watchlist);
  }

  function disconnectAll() {
    [klineSocket, depthSocket, watchlistSocket].forEach(sock => {
      if (sock) { sock.onclose = null; sock.close(); }
    });
    klineSocket = depthSocket = watchlistSocket = null;
  }

  function getState() {
    // Shallow copy so consumers can't mutate internal state by accident.
    return { ...state };
  }

  // ── Expose ───────────────────────────────────────────────────────────
  window.marketStore = {
    init,
    setSymbol,
    setInterval: setInterval_,
    setWatchlist,
    fetchCandles,
    disconnectAll,
    getState,

    onKline: (cb) => on('kline', cb),
    offKline: (cb) => off('kline', cb),
    onKlineHistory: (cb) => on('klineHistory', cb),
    offKlineHistory: (cb) => off('klineHistory', cb),
    onDepth: (cb) => on('depth', cb),
    offDepth: (cb) => off('depth', cb),
    onTicker: (cb) => on('ticker', cb),
    offTicker: (cb) => off('ticker', cb),
    onSymbolChange: (cb) => on('symbolChange', cb),
    offSymbolChange: (cb) => off('symbolChange', cb),
    onError: (cb) => on('error', cb),
    offError: (cb) => off('error', cb),
  };

})();

// ══════════════════════════════════════════════════════════════════════════
// USAGE (for the next modules — chart-engine.js, order-book.js, etc.):
//
//   marketStore.init({ symbol: 'BTCUSDT', interval: '1m' });
//
//   marketStore.onKlineHistory(candles => chart.applyNewData(candles));
//   marketStore.onKline(candle => chart.updateData(candle));
//   marketStore.onDepth(({bids, asks}) => renderOrderBook(bids, asks));
//   marketStore.onTicker(({symbol, close, open}) => updateWatchlistRow(symbol, close, open));
//
//   // when user picks a new market/timeframe in chart-cockpit.js:
//   marketStore.setSymbol('ETHUSDT', '5m');
// ══════════════════════════════════════════════════════════════════════════
