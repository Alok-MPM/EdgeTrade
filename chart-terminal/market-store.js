// ══════════════════════════════════════════════════════════════════════════
// chart-terminal/market-store.js
//
// SINGLE SOURCE OF TRUTH for all live market data used by the chart
// terminal. No other chart-terminal module is allowed to open its own
// WebSocket or call a broker directly — everything goes through this file.
//
//   Binance / Bybit WS  →  market-store.js  →  (events)  →  every other module
//
// Other modules only ever do two things with this file:
//   1. marketStore.onXxx(callback)                       — subscribe to a data stream
//   2. marketStore.setSymbol(...) / setInterval(...)      — control active market
//
// ALL brokers in ACTIVE_BROKERS run SIMULTANEOUSLY — this is an AGGREGATE
// feed, not a switchable single source. Every candle and every order-book
// level emitted to the rest of the app is the SUM across all active brokers
// (e.g. Binance + Bybit volume added together). Modules never see per-broker
// data separately.
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

  // Brokers that are aggregated together. Always all of these, all the time.
  const ACTIVE_BROKERS = ['binance', 'bybit'];

  // ── Internal state ────────────────────────────────────────────────────
  const state = {
    symbol: 'BTCUSDT',       // active chart symbol, uppercase, no slash
    interval: '1m',          // active chart timeframe (canonical, Binance-style)
    watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'], // Market Overview panel (always Binance)
    latestPrice: null,
    latestDepth: null,       // { bids: [{price,qty,total}], asks: [...] } — merged across brokers
  };

  // ── Internal sockets (never exposed directly) — one PER broker per stream ──
  const klineSockets = { binance: null, bybit: null };
  const depthSockets = { binance: null, bybit: null };
  let watchlistSocket = null;
  let watchlistReconnectAttempt = 0;

  // Latest raw (already dollar-denominated) candle / depth levels from EACH
  // broker — used to build the merged/aggregate candle and order book.
  const brokerCandle = { binance: null, bybit: null };
  const brokerDepthLevels = { binance: null, bybit: null };

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
    kline: [],         // fires on every live candle tick: (candle) => {}  — MERGED across all brokers
    klineHistory: [],  // fires once after fetchCandles resolves: (candles[]) => {}  — MERGED
    depth: [],         // fires on every order book update: ({symbol, bids, asks}) => {}  — MERGED
    ticker: [],        // fires per watchlist symbol update: ({symbol, close, open}) => {}
    symbolChange: [],  // fires when setSymbol/setInterval changes context: ({symbol, interval, brokers}) => {}
    error: [],         // fires on any socket error: ({stream, broker, error}) => {}  — broker = which one failed
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

  // ── REST: historical candles per broker (internal helper, not exposed) ─
  async function fetchOneBrokerCandles(broker, symbol, interval, limit) {
    if (broker === 'bybit') {
      const bybitInterval = toBybitInterval(interval);
      const url = `${BROKERS.bybit.rest}/kline?category=${BROKERS.bybit.category}&symbol=${symbol}&interval=${bybitInterval}&limit=${limit}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Bybit klines fetch failed: ' + res.status);
      const json = await res.json();
      if (json.retCode !== 0) throw new Error('Bybit klines error: ' + json.retMsg);
      const list = json.result && json.result.list ? json.result.list : [];
      // Bybit returns newest-first — reverse to chronological ascending order.
      return list.slice().reverse().map(k => ({
        timestamp: Number(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[6]),      // turnover = dollar (quote) volume
        volumeBase: parseFloat(k[5]),  // base asset volume
      }));
    }

    // default: binance
    const url = `${BROKERS.binance.rest}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Binance klines fetch failed: ' + res.status);
    const raw = await res.json();
    return raw.map(k => ({
      timestamp: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[7]),      // quote asset volume = dollar volume
      volumeBase: parseFloat(k[5]),  // base asset volume
    }));
  }

  // ── REST: historical candles — AGGREGATE across all active brokers ─────
  // Fetches every broker's history in parallel, then merges candles that
  // share the same timestamp bucket: price (OHLC) comes from the first
  // broker present in that bucket, volume is SUMMED across all of them.
  async function fetchCandles(symbol = state.symbol, interval = state.interval, limit = 300) {
    const results = await Promise.allSettled(
      ACTIVE_BROKERS.map(b => fetchOneBrokerCandles(b, symbol, interval, limit))
    );

    const byTimestamp = new Map();
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') {
        console.warn('[market-store] history fetch failed for', ACTIVE_BROKERS[i], r.reason);
        return;
      }
      r.value.forEach(c => {
        if (!byTimestamp.has(c.timestamp)) byTimestamp.set(c.timestamp, []);
        byTimestamp.get(c.timestamp).push(c);
      });
    });

    const candles = [...byTimestamp.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([timestamp, parts]) => ({
        timestamp,
        open: parts[0].open,
        high: Math.max(...parts.map(p => p.high)),
        low: Math.min(...parts.map(p => p.low)),
        close: parts[0].close,
        volume: parts.reduce((sum, p) => sum + p.volume, 0),
        volumeBase: parts.reduce((sum, p) => sum + p.volumeBase, 0),
      }));

    emit('klineHistory', candles);
    return candles;
  }

  // ── WS: live kline (candle) stream — one socket PER broker, always both ──
  function connectKline(symbol = state.symbol, interval = state.interval) {
    ACTIVE_BROKERS.forEach(broker => connectKlineForBroker(broker, symbol, interval));
  }

  const klineAttempts = { binance: 0, bybit: 0 };

  function connectKlineForBroker(broker, symbol, interval) {
    if (klineSockets[broker]) { klineSockets[broker].onclose = null; try { klineSockets[broker].close(); } catch (e) {} klineSockets[broker] = null; }
    clearBybitPing('kline_' + broker);
    brokerCandle[broker] = null; // stale candle from old symbol/interval must not leak into the merge

    if (broker === 'bybit') {
      const url = BROKERS.bybit.ws;
      const bybitInterval = toBybitInterval(interval);
      const topic = `kline.${bybitInterval}.${symbol}`;
      const sock = new WebSocket(url);
      klineSockets.bybit = sock;

      sock.onopen = () => {
        klineAttempts.bybit = 0;
        sock.send(JSON.stringify({ op: 'subscribe', args: [topic] }));
        startBybitPing(sock, 'kline_bybit');
      };

      sock.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.topic !== topic || !msg.data) return;
        const list = Array.isArray(msg.data) ? msg.data : [msg.data];
        list.forEach(k => {
          brokerCandle.bybit = {
            timestamp: Number(k.start),
            open: parseFloat(k.open),
            high: parseFloat(k.high),
            low: parseFloat(k.low),
            close: parseFloat(k.close),
            volume: parseFloat(k.turnover),   // dollar (quote) volume
            volumeBase: parseFloat(k.volume), // base asset volume
            isClosed: !!k.confirm,
          };
          emitMergedCandle();
        });
      };

      sock.onerror = (err) => emit('error', { stream: 'kline', broker: 'bybit', error: err });

      sock.onclose = () => {
        clearBybitPing('kline_bybit');
        if (klineSockets.bybit !== sock) return; // a newer connection has already replaced this one
        scheduleReconnect('kline_bybit', () => connectKlineForBroker('bybit', state.symbol, state.interval));
      };
      return;
    }

    // binance
    const url = `${BROKERS.binance.ws}/ws/${symbol.toLowerCase()}@kline_${interval}`;
    const sock = new WebSocket(url);
    klineSockets.binance = sock;

    sock.onopen = () => { klineAttempts.binance = 0; };

    sock.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const k = msg.k;
      brokerCandle.binance = {
        timestamp: k.t,
        open: parseFloat(k.o),
        high: parseFloat(k.h),
        low: parseFloat(k.l),
        close: parseFloat(k.c),
        volume: parseFloat(k.q),      // quote asset volume = dollar volume
        volumeBase: parseFloat(k.v),  // base asset volume
        isClosed: k.x, // true when this candle has finished forming
      };
      emitMergedCandle();
    };

    sock.onerror = (err) => emit('error', { stream: 'kline', broker: 'binance', error: err });

    sock.onclose = () => {
      if (klineSockets.binance !== sock) return;
      scheduleReconnect('kline_binance', () => connectKlineForBroker('binance', state.symbol, state.interval));
    };
  }

  // Merges the latest per-broker candle into ONE aggregate candle and emits
  // it — ONLY using broker parts whose timestamp matches the just-arrived
  // candle's bucket, so a slower broker's stale previous-bucket candle never
  // gets summed into the new bucket. This is what fixes the volume-spike bug:
  // previously a leftover candle from the last minute could get added to the
  // new minute's volume, producing sudden multi-hundred-K / multi-million jumps.
  function emitMergedCandle() {
    const timestamps = ACTIVE_BROKERS.filter(b => brokerCandle[b]).map(b => brokerCandle[b].timestamp);
    if (!timestamps.length) return;
    const latestTs = Math.max(...timestamps);
    const parts = ACTIVE_BROKERS.map(b => brokerCandle[b]).filter(c => c && c.timestamp === latestTs);
    if (!parts.length) return;

    const merged = {
      timestamp: latestTs,
      open: parts[0].open,
      high: Math.max(...parts.map(p => p.high)),
      low: Math.min(...parts.map(p => p.low)),
      close: parts[parts.length - 1].close,
      volume: parts.reduce((sum, p) => sum + p.volume, 0),
      volumeBase: parts.reduce((sum, p) => sum + p.volumeBase, 0),
      isClosed: parts.every(p => p.isClosed),
    };
    state.latestPrice = merged.close;
    emit('kline', merged);
  }

  // ── WS: live order book depth stream — one socket PER broker, always both ──
  function connectDepth(symbol = state.symbol) {
    ACTIVE_BROKERS.forEach(broker => connectDepthForBroker(broker, symbol));
  }

  function connectDepthForBroker(broker, symbol) {
    if (depthSockets[broker]) { depthSockets[broker].onclose = null; try { depthSockets[broker].close(); } catch (e) {} depthSockets[broker] = null; }
    clearBybitPing('depth_' + broker);
    brokerDepthLevels[broker] = null; // stale book from old symbol must not leak into the merge

    if (broker === 'bybit') {
      bybitDepthBook = { bids: new Map(), asks: new Map() };
      const url = BROKERS.bybit.ws;
      const topic = `orderbook.50.${symbol}`;
      const sock = new WebSocket(url);
      depthSockets.bybit = sock;

      sock.onopen = () => {
        sock.send(JSON.stringify({ op: 'subscribe', args: [topic] }));
        startBybitPing(sock, 'depth_bybit');
      };

      sock.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.topic !== topic || !msg.data) return;
        applyBybitDepthMessage(msg.type, msg.data);
      };

      sock.onerror = (err) => emit('error', { stream: 'depth', broker: 'bybit', error: err });

      sock.onclose = () => {
        clearBybitPing('depth_bybit');
        if (depthSockets.bybit !== sock) return;
        scheduleReconnect('depth_bybit', () => connectDepthForBroker('bybit', state.symbol));
      };
      return;
    }

    // binance
    const url = `${BROKERS.binance.ws}/ws/${symbol.toLowerCase()}@depth20@100ms`;
    const sock = new WebSocket(url);
    depthSockets.binance = sock;

    sock.onmessage = (event) => {
      const data = JSON.parse(event.data);
      brokerDepthLevels.binance = {
        bids: (data.bids || []).map(([price, qty]) => toDollarLevel(price, qty)),
        asks: (data.asks || []).map(([price, qty]) => toDollarLevel(price, qty)),
      };
      emitMergedDepth(symbol);
    };

    sock.onerror = (err) => emit('error', { stream: 'depth', broker: 'binance', error: err });

    sock.onclose = () => {
      if (depthSockets.binance !== sock) return;
      scheduleReconnect('depth_binance', () => connectDepthForBroker('binance', state.symbol));
    };
  }

  // Bybit orderbook.50 delivers a full "snapshot" first, then "delta" messages
  // where a level with qty "0" means "remove this price". We keep a running
  // book locally and re-derive the sorted dollar-value levels each time.
  function applyBybitDepthMessage(type, data) {
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

    brokerDepthLevels.bybit = {
      bids: [...bybitDepthBook.bids.entries()].map(([price, qty]) => toDollarLevel(price, qty)),
      asks: [...bybitDepthBook.asks.entries()].map(([price, qty]) => toDollarLevel(price, qty)),
    };
    emitMergedDepth(state.symbol);
  }

  // Merges order-book levels from EVERY broker that has reported data so far
  // into ONE combined book: levels landing on the same price are summed
  // (qty + qty, total + total). Fires as soon as ANY broker has data — it
  // does NOT wait for every broker to be ready, which is what was causing
  // "Loading order book..." to hang forever after Bybit was added.
  function emitMergedDepth(symbol) {
    const bidMap = new Map();
    const askMap = new Map();

    ACTIVE_BROKERS.forEach(broker => {
      const levels = brokerDepthLevels[broker];
      if (!levels) return; // this broker hasn't sent anything yet — merge with what we have
      levels.bids.forEach(l => addLevel(bidMap, l));
      levels.asks.forEach(l => addLevel(askMap, l));
    });

    const bids = [...bidMap.values()].sort((a, b) => b.price - a.price).slice(0, 20);
    const asks = [...askMap.values()].sort((a, b) => a.price - b.price).slice(0, 20);

    state.latestDepth = { bids, asks };
    emit('depth', { symbol, bids, asks });
  }

  function addLevel(map, level) {
    const existing = map.get(level.price);
    if (existing) {
      existing.qty += level.qty;
      existing.total += level.total;
    } else {
      map.set(level.price, { price: level.price, qty: level.qty, total: level.total });
    }
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

  // Switches the active chart symbol/interval: refetches history, resubscribes
  // kline + depth sockets for EVERY active broker. This is the ONE function
  // chart-cockpit.js should call when the user picks a new market or timeframe.
  async function setSymbol(symbol, interval = state.interval) {
    state.symbol = symbol.toUpperCase();
    state.interval = interval;
    emit('symbolChange', { symbol: state.symbol, interval: state.interval, brokers: ACTIVE_BROKERS });
    await fetchCandles(state.symbol, state.interval, 300);
    connectKline(state.symbol, state.interval);
    connectDepth(state.symbol);
  }

  async function setInterval_(interval) {
    return setSymbol(state.symbol, interval);
  }

  function setWatchlist(symbols) {
    state.watchlist = symbols;
    connectWatchlist(symbols);
  }

  // Call once, on page load, after the chart-terminal is ready to receive data.
  function init({ symbol = state.symbol, interval = state.interval, watchlist = state.watchlist } = {}) {
    state.symbol = symbol.toUpperCase();
    state.interval = interval;
    state.watchlist = watchlist;
    fetchCandles(state.symbol, state.interval, 300).catch(err => emit('error', { stream: 'klineHistory', error: err }));
    connectKline(state.symbol, state.interval);
    connectDepth(state.symbol);
    connectWatchlist(state.watchlist);
  }

  function disconnectAll() {
    ACTIVE_BROKERS.forEach(b => {
      if (klineSockets[b]) { klineSockets[b].onclose = null; try { klineSockets[b].close(); } catch (e) {} klineSockets[b] = null; }
      if (depthSockets[b]) { depthSockets[b].onclose = null; try { depthSockets[b].close(); } catch (e) {} depthSockets[b] = null; }
      clearBybitPing('kline_' + b);
      clearBybitPing('depth_' + b);
    });
    if (watchlistSocket) { watchlistSocket.onclose = null; try { watchlistSocket.close(); } catch (e) {} watchlistSocket = null; }
    clearBybitPing('watchlist');
    bybitDepthBook = null;
    brokerCandle.binance = brokerCandle.bybit = null;
    brokerDepthLevels.binance = brokerDepthLevels.bybit = null;
  }

  function getState() {
    // Shallow copy so consumers can't mutate internal state by accident.
    return { ...state };
  }

  function getBrokers() {
    return ACTIVE_BROKERS; // brokers currently being aggregated together
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
//   marketStore.init({ symbol: 'BTCUSDT', interval: '1m' });
//   // Binance + Bybit both connect automatically and stay aggregated — there
//   // is no per-broker switch anymore, every event below is already merged.
//
//   marketStore.onKlineHistory(candles => chart.applyNewData(candles));
//   marketStore.onKline(candle => chart.updateData(candle));
//   // candle.volume is the SUMMED dollar volume across all active brokers;
//   // candle.volumeBase is the summed asset qty.
//
//   marketStore.onDepth(({symbol, bids, asks}) => renderOrderBook(bids, asks));
//   // each level is {price, qty, total} — total is the SUMMED dollar value
//   // (price * qty) across brokers, merged onto matching price levels.
//
//   marketStore.onTicker(({symbol, close, open}) => updateWatchlistRow(symbol, close, open));
//
//   // when user picks a new market/timeframe in chart-cockpit.js:
//   marketStore.setSymbol('ETHUSDT', '5m');
//
//   marketStore.getBrokers();  // ['binance', 'bybit'] — which brokers are being aggregated
// ══════════════════════════════════════════════════════════════════════════
