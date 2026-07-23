// ══════════════════════════════════════════════════════════════════════════
// chart-terminal/market-store.js
//
// SINGLE SOURCE OF TRUTH for all live market data used by the chart
// terminal. No other chart-terminal module is allowed to open its own
// WebSocket or call a broker directly — everything goes through this file.
//
//   Binance / Bybit WS  →  market-store.js  →  (events)  →  every other module
//
// Other modules only ever do three things with this file:
//   1. marketStore.onXxx(callback)                       — subscribe to a data stream
//   2. marketStore.setSymbol(...) / setInterval(...)      — control active market
//   3. marketStore.setBroker('binance' | 'bybit')         — switch data source
//
// Only ONE broker is "active" at a time (same model as symbol/interval) —
// switching broker re-points every socket at the new source. This keeps the
// architecture simple: one candle stream, one depth stream, in flight at once.
//
// VOLUME / ORDER BOOK ARE IN DOLLARS (quote-asset value), not base-asset qty:
//   - candle.volume      → dollar (quote) volume  [candle.volumeBase = asset qty, kept for reference]
//   - depth level        → { price, qty, total }  where total = price * qty (dollars)
//
// This file renders NOTHING. No DOM writes, no HTML, no CSS. Pure data.
// ══════════════════════════════════════════════════════════════════════════

(function () {

  // ── Broker registry ─────────────────────────────────────────────────────
  const BROKERS = {
    binance: {
      id: 'binance',
      rest: 'https://api.binance.com/api/v3',
      ws: 'wss://stream.binance.com:9443',
    },
    bybit: {
      id: 'bybit',
      rest: 'https://api.bybit.com/v5/market',
      ws: 'wss://stream.bybit.com/v5/public/linear', // USDT perpetual (linear) category
      category: 'linear',
    },
  };

  // Binance-style interval strings ('1m','1h','1d',...) are the canonical
  // format used everywhere in this file's public API. Convert to Bybit's
  // interval codes only at the Bybit boundary.
  const BYBIT_INTERVAL_MAP = {
    '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
    '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720',
    '1d': 'D', '1w': 'W', '1M': 'M',
  };
  function toBybitInterval(interval) {
    return BYBIT_INTERVAL_MAP[interval] || interval;
  }

  // Reconnect backoff so a dropped connection doesn't spam retries.
  const RECONNECT_DELAY_MS = 2000;
  const MAX_RECONNECT_DELAY_MS = 15000;

  // Bybit public WS needs a client ping roughly every 20s or it disconnects.
  const BYBIT_PING_INTERVAL_MS = 20000;

  // ── Internal state ────────────────────────────────────────────────────
  const state = {
    broker: 'binance',       // active data source: 'binance' | 'bybit'
    symbol: 'BTCUSDT',       // active chart symbol, uppercase, no slash
    interval: '1m',          // active chart timeframe (canonical, Binance-style)
    watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'], // Market Overview panel (always Binance)
    latestPrice: null,
    latestDepth: null,       // { bids: [{price,qty,total}], asks: [...] }
  };

  // ── Internal sockets (never exposed directly) ─────────────────────────
  let klineSocket = null;
  let depthSocket = null;
  let watchlistSocket = null;

  let klineReconnectAttempt = 0;
  let depthReconnectAttempt = 0;
  let watchlistReconnectAttempt = 0;

  // Bybit orderbook is delta-based — we maintain a local price->qty book and
  // re-derive the top levels on every message. Reset whenever depth reconnects.
  let bybitDepthBook = null; // { bids: Map<price,qty>, asks: Map<price,qty> }

  // Bybit requires a client-side ping heartbeat per open connection.
  const pingIntervals = { kline: null, depth: null, watchlist: null };
  function startBybitPing(sock, name) {
    clearBybitPing(name);
    pingIntervals[name] = setInterval(() => {
      if (sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ op: 'ping' }));
      }
    }, BYBIT_PING_INTERVAL_MS);
  }
  function clearBybitPing(name) {
    if (pingIntervals[name]) { clearInterval(pingIntervals[name]); pingIntervals[name] = null; }
  }

  // ── Pub/sub ────────────────────────────────────────────────────────────
  const listeners = {
    kline: [],         // fires on every live candle tick: (candle) => {}  — candle has {broker, symbol, ...}
    klineHistory: [],  // fires once after fetchCandles resolves: (candles[]) => {}
    depth: [],         // fires on every order book update: ({broker, symbol, bids, asks}) => {}
    ticker: [],        // fires per watchlist symbol update: ({symbol, close, open}) => {}
    symbolChange: [],  // fires when setSymbol/setInterval/setBroker changes context: ({symbol, interval, broker}) => {}
    error: [],         // fires on any socket error: ({stream, broker, error}) => {}
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

  // ── Helpers ──────────────────────────────────────────────────────────────
  // Converts a raw [price, qty] order-book level into dollar terms.
  function toDollarLevel(price, qty) {
    const p = parseFloat(price);
    const q = parseFloat(qty);
    return { price: p, qty: q, total: p * q };
  }

  // ── REST: historical candles ──────────────────────────────────────────
  async function fetchCandles(symbol = state.symbol, interval = state.interval, limit = 300, broker = state.broker) {
    if (broker === 'bybit') {
      const bybitInterval = toBybitInterval(interval);
      const url = `${BROKERS.bybit.rest}/kline?category=${BROKERS.bybit.category}&symbol=${symbol}&interval=${bybitInterval}&limit=${limit}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Bybit klines fetch failed: ' + res.status);
      const json = await res.json();
      if (json.retCode !== 0) throw new Error('Bybit klines error: ' + json.retMsg);
      const list = json.result && json.result.list ? json.result.list : [];
      // Bybit returns newest-first — reverse to chronological ascending order.
      const candles = list.slice().reverse().map(k => ({
        timestamp: Number(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[6]),      // turnover = dollar (quote) volume
        volumeBase: parseFloat(k[5]),  // base asset volume
      }));
      emit('klineHistory', candles);
      return candles;
    }

    // default: binance
    const url = `${BROKERS.binance.rest}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Binance klines fetch failed: ' + res.status);
    const raw = await res.json();
    const candles = raw.map(k => ({
      timestamp: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[7]),      // quote asset volume = dollar volume
      volumeBase: parseFloat(k[5]),  // base asset volume
    }));
    emit('klineHistory', candles);
    return candles;
  }

  // ── WS: live kline (candle) stream ────────────────────────────────────
  function connectKline(symbol = state.symbol, interval = state.interval, broker = state.broker) {
    if (klineSocket) { klineSocket.onclose = null; try { klineSocket.close(); } catch (e) {} klineSocket = null; }
    clearBybitPing('kline');

    if (broker === 'bybit') {
      const url = BROKERS.bybit.ws;
      const bybitInterval = toBybitInterval(interval);
      const topic = `kline.${bybitInterval}.${symbol}`;
      const sock = new WebSocket(url);
      klineSocket = sock;

      sock.onopen = () => {
        klineReconnectAttempt = 0;
        sock.send(JSON.stringify({ op: 'subscribe', args: [topic] }));
        startBybitPing(sock, 'kline');
      };

      sock.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.topic !== topic || !msg.data) return;
        const list = Array.isArray(msg.data) ? msg.data : [msg.data];
        list.forEach(k => {
          const candle = {
            broker: 'bybit',
            symbol,
            timestamp: Number(k.start),
            open: parseFloat(k.open),
            high: parseFloat(k.high),
            low: parseFloat(k.low),
            close: parseFloat(k.close),
            volume: parseFloat(k.turnover),   // dollar (quote) volume
            volumeBase: parseFloat(k.volume), // base asset volume
            isClosed: !!k.confirm,
          };
          state.latestPrice = candle.close;
          emit('kline', candle);
        });
      };

      sock.onerror = (err) => emit('error', { stream: 'kline', broker: 'bybit', error: err });

      sock.onclose = () => {
        clearBybitPing('kline');
        if (klineSocket !== sock) return; // a newer connection has already replaced this one
        scheduleReconnect('kline', () => connectKline(state.symbol, state.interval, state.broker));
      };
      return;
    }

    // default: binance
    const url = `${BROKERS.binance.ws}/ws/${symbol.toLowerCase()}@kline_${interval}`;
    const sock = new WebSocket(url);
    klineSocket = sock;

    sock.onopen = () => { klineReconnectAttempt = 0; };

    sock.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const k = msg.k;
      const candle = {
        broker: 'binance',
        symbol,
        timestamp: k.t,
        open: parseFloat(k.o),
        high: parseFloat(k.h),
        low: parseFloat(k.l),
        close: parseFloat(k.c),
        volume: parseFloat(k.q),      // quote asset volume = dollar volume
        volumeBase: parseFloat(k.v),  // base asset volume
        isClosed: k.x, // true when this candle has finished forming
      };
      state.latestPrice = candle.close;
      emit('kline', candle);
    };

    sock.onerror = (err) => emit('error', { stream: 'kline', broker: 'binance', error: err });

    sock.onclose = () => {
      if (klineSocket !== sock) return;
      scheduleReconnect('kline', () => connectKline(state.symbol, state.interval, state.broker));
    };
  }

  // ── WS: live order book depth stream ──────────────────────────────────
  function connectDepth(symbol = state.symbol, broker = state.broker) {
    if (depthSocket) { depthSocket.onclose = null; try { depthSocket.close(); } catch (e) {} depthSocket = null; }
    clearBybitPing('depth');

    if (broker === 'bybit') {
      bybitDepthBook = { bids: new Map(), asks: new Map() };
      const url = BROKERS.bybit.ws;
      const topic = `orderbook.50.${symbol}`;
      const sock = new WebSocket(url);
      depthSocket = sock;

      sock.onopen = () => {
        depthReconnectAttempt = 0;
        sock.send(JSON.stringify({ op: 'subscribe', args: [topic] }));
        startBybitPing(sock, 'depth');
      };

      sock.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.topic !== topic || !msg.data) return;
        applyBybitDepthMessage(msg.type, msg.data, symbol);
      };

      sock.onerror = (err) => emit('error', { stream: 'depth', broker: 'bybit', error: err });

      sock.onclose = () => {
        clearBybitPing('depth');
        if (depthSocket !== sock) return;
        scheduleReconnect('depth', () => connectDepth(state.symbol, state.broker));
      };
      return;
    }

    // default: binance
    const url = `${BROKERS.binance.ws}/ws/${symbol.toLowerCase()}@depth20@100ms`;
    const sock = new WebSocket(url);
    depthSocket = sock;

    sock.onopen = () => { depthReconnectAttempt = 0; };

    sock.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const bids = (data.bids || [])
        .map(([price, qty]) => toDollarLevel(price, qty))
        .sort((a, b) => b.price - a.price)
        .slice(0, 20);
      const asks = (data.asks || [])
        .map(([price, qty]) => toDollarLevel(price, qty))
        .sort((a, b) => a.price - b.price)
        .slice(0, 20);
      state.latestDepth = { bids, asks };
      emit('depth', { broker: 'binance', symbol, bids, asks });
    };

    sock.onerror = (err) => emit('error', { stream: 'depth', broker: 'binance', error: err });

    sock.onclose = () => {
      if (depthSocket !== sock) return;
      scheduleReconnect('depth', () => connectDepth(state.symbol, state.broker));
    };
  }

  // Bybit orderbook.50 delivers a full "snapshot" first, then "delta" messages
  // where a level with qty "0" means "remove this price". We keep a running
  // book locally and re-derive the sorted top-20 dollar-value levels each time.
  function applyBybitDepthMessage(type, data, symbol) {
    if (!bybitDepthBook) bybitDepthBook = { bids: new Map(), asks: new Map() };
    if (type === 'snapshot') {
      bybitDepthBook.bids.clear();
      bybitDepthBook.asks.clear();
    }

    (data.b || []).forEach(([price, qty]) => {
      const q = parseFloat(qty);
      if (q === 0) bybitDepthBook.bids.delete(price);
      else bybitDepthBook.bids.set(price, q);
    });
    (data.a || []).forEach(([price, qty]) => {
      const q = parseFloat(qty);
      if (q === 0) bybitDepthBook.asks.delete(price);
      else bybitDepthBook.asks.set(price, q);
    });

    const bids = [...bybitDepthBook.bids.entries()]
      .map(([price, qty]) => toDollarLevel(price, qty))
      .sort((a, b) => b.price - a.price)
      .slice(0, 20);
    const asks = [...bybitDepthBook.asks.entries()]
      .map(([price, qty]) => toDollarLevel(price, qty))
      .sort((a, b) => a.price - b.price)
      .slice(0, 20);

    state.latestDepth = { bids, asks };
    emit('depth', { broker: 'bybit', symbol, bids, asks });
  }

  // ── WS: fixed watchlist ticker stream (Market Overview panel) ─────────
  // Always Binance — independent of the active chart symbol/broker, persists
  // across symbol/tab switches, exactly like the current site's behavior.
  function connectWatchlist(symbols = state.watchlist) {
    if (watchlistSocket) { watchlistSocket.onclose = null; try { watchlistSocket.close(); } catch (e) {} watchlistSocket = null; }

    const streams = symbols.map(s => s.toLowerCase() + '@miniTicker').join('/');
    const url = `${BROKERS.binance.ws}/stream?streams=${streams}`;
    const sock = new WebSocket(url);
    watchlistSocket = sock;

    sock.onopen = () => { watchlistReconnectAttempt = 0; };

    sock.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const d = msg.data;
      if (!d || !d.s) return;
      emit('ticker', { symbol: d.s, close: parseFloat(d.c), open: parseFloat(d.o) });
    };

    sock.onerror = (err) => emit('error', { stream: 'watchlist', broker: 'binance', error: err });

    sock.onclose = () => {
      if (watchlistSocket !== sock) return;
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

  // Switches the active chart symbol/interval/broker: refetches history,
  // resubscribes kline + depth sockets. This is the ONE function
  // chart-cockpit.js should call when the user picks a new market, timeframe,
  // or broker.
  async function setSymbol(symbol, interval = state.interval, broker = state.broker) {
    if (!BROKERS[broker]) { console.warn('[market-store] unknown broker:', broker); return; }
    state.symbol = symbol.toUpperCase();
    state.interval = interval;
    state.broker = broker;
    attemptCounters.kline = 0;
    attemptCounters.depth = 0;
    emit('symbolChange', { symbol: state.symbol, interval: state.interval, broker: state.broker });
    await fetchCandles(state.symbol, state.interval, 300, state.broker);
    connectKline(state.symbol, state.interval, state.broker);
    connectDepth(state.symbol, state.broker);
  }

  async function setInterval_(interval) {
    return setSymbol(state.symbol, interval, state.broker);
  }

  // Switches only the broker, keeping the same symbol/interval where possible.
  async function setBroker(broker, symbol = state.symbol, interval = state.interval) {
    return setSymbol(symbol, interval, broker);
  }

  function setWatchlist(symbols) {
    state.watchlist = symbols;
    attemptCounters.watchlist = 0;
    connectWatchlist(symbols);
  }

  // Call once, on page load, after the chart-terminal is ready to receive data.
  function init({ symbol = state.symbol, interval = state.interval, watchlist = state.watchlist, broker = state.broker } = {}) {
    state.symbol = symbol.toUpperCase();
    state.interval = interval;
    state.watchlist = watchlist;
    state.broker = BROKERS[broker] ? broker : 'binance';
    fetchCandles(state.symbol, state.interval, 300, state.broker).catch(err => emit('error', { stream: 'klineHistory', broker: state.broker, error: err }));
    connectKline(state.symbol, state.interval, state.broker);
    connectDepth(state.symbol, state.broker);
    connectWatchlist(state.watchlist);
  }

  function disconnectAll() {
    [klineSocket, depthSocket, watchlistSocket].forEach(sock => {
      if (sock) { sock.onclose = null; try { sock.close(); } catch (e) {} }
    });
    klineSocket = depthSocket = watchlistSocket = null;
    clearBybitPing('kline');
    clearBybitPing('depth');
    clearBybitPing('watchlist');
    bybitDepthBook = null;
  }

  function getState() {
    // Shallow copy so consumers can't mutate internal state by accident.
    return { ...state };
  }

  function getBrokers() {
    return Object.keys(BROKERS);
  }

  // ── Expose ───────────────────────────────────────────────────────────
  window.marketStore = {
    init,
    setSymbol,
    setInterval: setInterval_,
    setBroker,
    setWatchlist,
    fetchCandles,
    disconnectAll,
    getState,
    getBrokers,

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
//   marketStore.init({ symbol: 'BTCUSDT', interval: '1m', broker: 'binance' });
//
//   marketStore.onKlineHistory(candles => chart.applyNewData(candles));
//   marketStore.onKline(candle => chart.updateData(candle));
//   // candle.volume is DOLLAR volume; candle.volumeBase is asset qty.
//
//   marketStore.onDepth(({broker, symbol, bids, asks}) => renderOrderBook(bids, asks));
//   // each level is {price, qty, total} — total is the DOLLAR value (price * qty).
//
//   marketStore.onTicker(({symbol, close, open}) => updateWatchlistRow(symbol, close, open));
//
//   // when user picks a new market/timeframe in chart-cockpit.js:
//   marketStore.setSymbol('ETHUSDT', '5m');
//
//   // when user switches broker (e.g. a broker selector in chart-cockpit.js):
//   marketStore.setBroker('bybit');              // keeps current symbol/interval
//   marketStore.setBroker('bybit', 'ETHUSDT');    // switch broker + symbol together
//
//   marketStore.getBrokers();  // ['binance', 'bybit'] — for building the broker selector UI
// ══════════════════════════════════════════════════════════════════════════
