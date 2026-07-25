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
//   3. marketStore.setMarketType('spot'|'perp'|'combined') — control which brokers aggregate
//
// THREE MARKET-TYPE MODES (see MODES below), only one active at a time:
//   'spot'     → Binance spot     + Bybit spot
//   'perp'     → Binance USDT-M perp (futures) + Bybit linear (perp)
//   'combined' → all four of the above, summed together
// Whichever brokers are active for the current mode run SIMULTANEOUSLY —
// this is an AGGREGATE feed within that mode, not a switchable single
// source. Modules never see per-broker data separately. BUT: only VOLUME is
// summed across the active brokers — price (open/high/low/close) always
// comes from that mode's single primary broker. Mixing high/low across spot
// and perp produces fake wicks (perp price can briefly spike or wick beyond
// spot during fast moves/liquidations), so price action must stay
// single-source while volume aggregates underneath it.
//
// VOLUME / ORDER BOOK ARE IN DOLLARS (quote-asset value), not base-asset qty:
//   - candle.volume      → dollar (quote) volume  [candle.volumeBase = asset qty, kept for reference]
//   - depth level        → { price, qty, total }  where total = price * qty (dollars)
//
// This file renders NOTHING. No DOM writes, no HTML, no CSS. Pure data.
// ══════════════════════════════════════════════════════════════════════════

(function () {

  // ── Broker registry ─────────────────────────────────────────────────────
  // Keyed by composite id "<exchange>-<marketType>" so spot and perp are
  // always separate broker entries, never conflated. `exchange` and
  // `marketType` are read by every function below instead of comparing
  // against a hardcoded literal like 'bybit' or 'binance'.
  const BROKERS = {
    'binance-spot': {
      id: 'binance-spot',
      exchange: 'binance',
      marketType: 'spot',
      rest: 'https://api.binance.com/api/v3',
      ws: 'wss://stream.binance.com:9443',
    },
    'binance-perp': {
      id: 'binance-perp',
      exchange: 'binance',
      marketType: 'perp',
      rest: 'https://fapi.binance.com/fapi/v1',   // USDT-M perpetual futures
      ws: 'wss://fstream.binance.com',
    },
    'bybit-spot': {
      id: 'bybit-spot',
      exchange: 'bybit',
      marketType: 'spot',
      rest: 'https://api.bybit.com/v5/market',
      ws: 'wss://stream.bybit.com/v5/public/spot',
      category: 'spot',
    },
    'bybit-perp': {
      id: 'bybit-perp',
      exchange: 'bybit',
      marketType: 'perp',
      rest: 'https://api.bybit.com/v5/market',
      ws: 'wss://stream.bybit.com/v5/public/linear', // USDT perpetual (linear) category
      category: 'linear',
    },
  };

  // Which broker ids are aggregated together for each market-type mode, and
  // which one of them is PRIMARY (source of OHLC) in that mode — every other
  // active broker only contributes its VOLUME to the aggregate. OHLC is
  // NEVER mixed across brokers (fake-wick reasoning above still applies:
  // perp price can wick beyond spot during fast moves/liquidations).
  //
  // Default mode is 'spot' — matches the volumes that were already
  // confirmed correct before Bybit (perp) was added, so behavior doesn't
  // silently change until a UI toggle explicitly calls setMarketType().
  const MODES = {
    spot:     { brokers: ['binance-spot', 'bybit-spot'],                               primary: 'binance-spot' },
    perp:     { brokers: ['binance-perp', 'bybit-perp'],                               primary: 'binance-perp' },
    combined: { brokers: ['binance-spot', 'binance-perp', 'bybit-spot', 'bybit-perp'], primary: 'binance-spot' },
  };
  const DEFAULT_MODE = 'spot';

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
    symbol: 'BTCUSDT',       // active chart symbol, uppercase, no slash
    interval: '1m',          // active chart timeframe (canonical, Binance-style)
    marketType: DEFAULT_MODE, // 'spot' | 'perp' | 'combined' — which brokers are aggregated
    watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'], // Market Overview panel (always Binance spot)
    latestPrice: null,
    latestDepth: null,       // { bids: [{price,qty,total}], asks: [...] } — merged across brokers
  };

  // Brokers currently aggregated together — ALWAYS derived from
  // state.marketType, never hardcoded. This is what every function below
  // must call instead of referencing a fixed broker list.
  function activeBrokerIds() {
    return (MODES[state.marketType] || MODES[DEFAULT_MODE]).brokers;
  }
  function primaryBrokerId() {
    return (MODES[state.marketType] || MODES[DEFAULT_MODE]).primary;
  }

  // ── Internal sockets (never exposed directly) — one PER broker per stream ──
  const klineSockets = { 'binance-spot': null, 'binance-perp': null, 'bybit-spot': null, 'bybit-perp': null };
  const depthSockets = { 'binance-spot': null, 'binance-perp': null, 'bybit-spot': null, 'bybit-perp': null };
  let watchlistSocket = null;
  let watchlistReconnectAttempt = 0;

  // Latest raw (already dollar-denominated) candle / depth levels from EACH
  // broker — used to build the merged/aggregate candle and order book.
  const brokerCandle = { 'binance-spot': null, 'binance-perp': null, 'bybit-spot': null, 'bybit-perp': null };
  const brokerDepthLevels = { 'binance-spot': null, 'binance-perp': null, 'bybit-spot': null, 'bybit-perp': null };

  // Bybit orderbook is delta-based — we maintain a local price->qty book per
  // Bybit broker (spot and perp are two INDEPENDENT connections/books now,
  // not one) and re-derive the top levels on every message. Reset whenever
  // that broker's depth socket reconnects.
  const bybitDepthBooks = { 'bybit-spot': null, 'bybit-perp': null }; // { bids: Map<price,qty>, asks: Map<price,qty> }

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
    const cfg = BROKERS[broker];

    if (cfg.exchange === 'bybit') {
      const bybitInterval = toBybitInterval(interval);
      const url = `${cfg.rest}/kline?category=${cfg.category}&symbol=${symbol}&interval=${bybitInterval}&limit=${limit}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(cfg.id + ' klines fetch failed: ' + res.status);
      const json = await res.json();
      if (json.retCode !== 0) throw new Error(cfg.id + ' klines error: ' + json.retMsg);
      const list = json.result && json.result.list ? json.result.list : [];
      // Bybit returns newest-first — reverse to chronological ascending order.
      return list.slice().reverse().map(k => ({
        broker: cfg.id,
        timestamp: Number(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[6]),      // turnover = dollar (quote) volume
        volumeBase: parseFloat(k[5]),  // base asset volume
      }));
    }

    // binance (spot or perp — cfg.rest already points at the right host:
    // api.binance.com for spot, fapi.binance.com for perp; response shape
    // is identical between the two so parsing doesn't need to branch)
    const url = `${cfg.rest}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(cfg.id + ' klines fetch failed: ' + res.status);
    const raw = await res.json();
    return raw.map(k => ({
      broker: cfg.id,
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
  // share the same timestamp bucket: price (OHLC) ALWAYS comes from
  // the current mode's primary broker (never mixed with another broker's high/low — that's
  // what was creating fake wicks). Volume is SUMMED across all of them.
  async function fetchCandles(symbol = state.symbol, interval = state.interval, limit = 300) {
    const activeBrokers = activeBrokerIds();
    const results = await Promise.allSettled(
      activeBrokers.map(b => fetchOneBrokerCandles(b, symbol, interval, limit))
    );

    const byTimestamp = new Map();
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') {
        console.warn('[market-store] history fetch failed for', activeBrokers[i], r.reason);
        return;
      }
      r.value.forEach(c => {
        if (!byTimestamp.has(c.timestamp)) byTimestamp.set(c.timestamp, []);
        byTimestamp.get(c.timestamp).push(c);
      });
    });

    const primary = primaryBrokerId();
    const candles = [...byTimestamp.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([timestamp, parts]) => {
        const primaryPart = parts.find(p => p.broker === primary) || parts[0];
        return {
          timestamp,
          open: primaryPart.open,
          high: primaryPart.high,
          low: primaryPart.low,
          close: primaryPart.close,
          volume: parts.reduce((sum, p) => sum + p.volume, 0),
          volumeBase: parts.reduce((sum, p) => sum + p.volumeBase, 0),
        };
      });

    emit('klineHistory', candles);
    return candles;
  }

  // ── WS: live kline (candle) stream — one socket PER active broker ──────
  function connectKline(symbol = state.symbol, interval = state.interval) {
    activeBrokerIds().forEach(broker => connectKlineForBroker(broker, symbol, interval));
  }

  const klineAttempts = {};

  function connectKlineForBroker(broker, symbol, interval) {
    const cfg = BROKERS[broker];
    if (klineSockets[broker]) { klineSockets[broker].onclose = null; try { klineSockets[broker].close(); } catch (e) {} klineSockets[broker] = null; }
    clearBybitPing('kline_' + broker);
    brokerCandle[broker] = null; // stale candle from old symbol/interval must not leak into the merge

    if (cfg.exchange === 'bybit') {
      const url = cfg.ws;
      const bybitInterval = toBybitInterval(interval);
      const topic = `kline.${bybitInterval}.${symbol}`;
      const sock = new WebSocket(url);
      klineSockets[broker] = sock;

      sock.onopen = () => {
        klineAttempts[broker] = 0;
        sock.send(JSON.stringify({ op: 'subscribe', args: [topic] }));
        startBybitPing(sock, 'kline_' + broker);
      };

      sock.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.topic !== topic || !msg.data) return;
        const list = Array.isArray(msg.data) ? msg.data : [msg.data];
        list.forEach(k => {
          brokerCandle[broker] = {
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

      sock.onerror = (err) => emit('error', { stream: 'kline', broker, error: err });

      sock.onclose = () => {
        clearBybitPing('kline_' + broker);
        if (klineSockets[broker] !== sock) return; // a newer connection has already replaced this one
        scheduleReconnect('kline_' + broker, () => connectKlineForBroker(broker, state.symbol, state.interval));
      };
      return;
    }

    // binance (spot or perp — cfg.ws already points at the right host:
    // stream.binance.com for spot, fstream.binance.com for perp)
    const url = `${cfg.ws}/ws/${symbol.toLowerCase()}@kline_${interval}`;
    const sock = new WebSocket(url);
    klineSockets[broker] = sock;

    sock.onopen = () => { klineAttempts[broker] = 0; };

    sock.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const k = msg.k;
      brokerCandle[broker] = {
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

    sock.onerror = (err) => emit('error', { stream: 'kline', broker, error: err });

    sock.onclose = () => {
      if (klineSockets[broker] !== sock) return;
      scheduleReconnect('kline_' + broker, () => connectKlineForBroker(broker, state.symbol, state.interval));
    };
  }

  // Merges the latest per-broker candle into ONE aggregate candle and emits
  // it — ONLY using broker parts whose timestamp matches the just-arrived
  // candle's bucket, so a slower broker's stale previous-bucket candle never
  // gets summed into the new bucket (fixes the earlier volume-spike bug).
  //
  // Price (open/high/low/close) ALWAYS comes from the current mode's primary broker — never
  // mixed with another broker's high/low. Mixing created fake wicks, since
  // Bybit (futures/perp) can briefly spike beyond Binance (spot) during fast
  // moves or liquidations even though neither market alone printed that wick.
  // Only volume is summed across every broker that has data for this bucket.
  function emitMergedCandle() {
    const activeBrokers = activeBrokerIds();
    const timestamps = activeBrokers.filter(b => brokerCandle[b]).map(b => brokerCandle[b].timestamp);
    if (!timestamps.length) return;
    const latestTs = Math.max(...timestamps);
    const parts = activeBrokers
      .filter(b => brokerCandle[b] && brokerCandle[b].timestamp === latestTs)
      .map(b => ({ broker: b, candle: brokerCandle[b] }));
    if (!parts.length) return;

    const primary = parts.find(p => p.broker === primaryBrokerId()) || parts[0];

    const merged = {
      timestamp: latestTs,
      open: primary.candle.open,
      high: primary.candle.high,
      low: primary.candle.low,
      close: primary.candle.close,
      volume: parts.reduce((sum, p) => sum + p.candle.volume, 0),
      volumeBase: parts.reduce((sum, p) => sum + p.candle.volumeBase, 0),
      isClosed: parts.every(p => p.candle.isClosed),
    };
    state.latestPrice = merged.close;
    emit('kline', merged);
  }

  // ── WS: live order book depth stream — one socket PER active broker ────
  function connectDepth(symbol = state.symbol) {
    activeBrokerIds().forEach(broker => connectDepthForBroker(broker, symbol));
  }

  function connectDepthForBroker(broker, symbol) {
    const cfg = BROKERS[broker];
    if (depthSockets[broker]) { depthSockets[broker].onclose = null; try { depthSockets[broker].close(); } catch (e) {} depthSockets[broker] = null; }
    clearBybitPing('depth_' + broker);
    brokerDepthLevels[broker] = null; // stale book from old symbol must not leak into the merge

    if (cfg.exchange === 'bybit') {
      bybitDepthBooks[broker] = { bids: new Map(), asks: new Map() };
      const url = cfg.ws;
      const topic = `orderbook.50.${symbol}`;
      const sock = new WebSocket(url);
      depthSockets[broker] = sock;

      sock.onopen = () => {
        sock.send(JSON.stringify({ op: 'subscribe', args: [topic] }));
        startBybitPing(sock, 'depth_' + broker);
      };

      sock.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.topic !== topic || !msg.data) return;
        applyBybitDepthMessage(broker, msg.type, msg.data);
      };

      sock.onerror = (err) => emit('error', { stream: 'depth', broker, error: err });

      sock.onclose = () => {
        clearBybitPing('depth_' + broker);
        if (depthSockets[broker] !== sock) return;
        scheduleReconnect('depth_' + broker, () => connectDepthForBroker(broker, state.symbol));
      };
      return;
    }

    // binance (spot or perp — cfg.ws already points at the right host)
    const url = `${cfg.ws}/ws/${symbol.toLowerCase()}@depth20@100ms`;
    const sock = new WebSocket(url);
    depthSockets[broker] = sock;

    sock.onmessage = (event) => {
      const data = JSON.parse(event.data);
      brokerDepthLevels[broker] = {
        bids: (data.bids || []).map(([price, qty]) => toDollarLevel(price, qty)),
        asks: (data.asks || []).map(([price, qty]) => toDollarLevel(price, qty)),
      };
      emitMergedDepth(symbol);
    };

    sock.onerror = (err) => emit('error', { stream: 'depth', broker, error: err });

    sock.onclose = () => {
      if (depthSockets[broker] !== sock) return;
      scheduleReconnect('depth_' + broker, () => connectDepthForBroker(broker, state.symbol));
    };
  }

  // Bybit orderbook.50 delivers a full "snapshot" first, then "delta" messages
  // where a level with qty "0" means "remove this price". We keep a running
  // book locally PER Bybit broker (spot and perp books are independent) and
  // re-derive the sorted dollar-value levels each time.
  function applyBybitDepthMessage(brokerId, type, data) {
    if (!bybitDepthBooks[brokerId]) bybitDepthBooks[brokerId] = { bids: new Map(), asks: new Map() };
    const book = bybitDepthBooks[brokerId];
    if (type === 'snapshot') {
      book.bids.clear();
      book.asks.clear();
    }

    (data.b || []).forEach(([price, qty]) => {
      const q = parseFloat(qty);
      if (q === 0) book.bids.delete(price);
      else book.bids.set(price, q);
    });
    (data.a || []).forEach(([price, qty]) => {
      const q = parseFloat(qty);
      if (q === 0) book.asks.delete(price);
      else book.asks.set(price, q);
    });

    brokerDepthLevels[brokerId] = {
      bids: [...book.bids.entries()].map(([price, qty]) => toDollarLevel(price, qty)),
      asks: [...book.asks.entries()].map(([price, qty]) => toDollarLevel(price, qty)),
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

    activeBrokerIds().forEach(broker => {
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
    const url = `${BROKERS['binance-spot'].ws}/stream?streams=${streams}`;
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
    emit('symbolChange', { symbol: state.symbol, interval: state.interval, brokers: activeBrokerIds() });
    await fetchCandles(state.symbol, state.interval, 300);
    connectKline(state.symbol, state.interval);
    connectDepth(state.symbol);
  }

  async function setInterval_(interval) {
    return setSymbol(state.symbol, interval);
  }

  // Switches which brokers are aggregated — 'spot' | 'perp' | 'combined' —
  // for the CURRENT symbol/interval: refetches history and reconnects
  // kline+depth using the new broker set. This is the function chart-cockpit's
  // Spot/Perp/Combined toggle should call; symbol/interval are untouched.
  async function setMarketType(mode) {
    if (!MODES[mode]) { console.warn('[market-store] unknown market type:', mode); return; }
    state.marketType = mode;
    emit('symbolChange', { symbol: state.symbol, interval: state.interval, brokers: activeBrokerIds() });
    await fetchCandles(state.symbol, state.interval, 300);
    connectKline(state.symbol, state.interval);
    connectDepth(state.symbol);
  }

  function getMarketType() {
    return state.marketType;
  }

  function setWatchlist(symbols) {
    state.watchlist = symbols;
    connectWatchlist(symbols);
  }

  // Call once, on page load, after the chart-terminal is ready to receive data.
  function init({ symbol = state.symbol, interval = state.interval, watchlist = state.watchlist, marketType = state.marketType } = {}) {
    state.symbol = symbol.toUpperCase();
    state.interval = interval;
    state.watchlist = watchlist;
    state.marketType = MODES[marketType] ? marketType : DEFAULT_MODE;
    fetchCandles(state.symbol, state.interval, 300).catch(err => emit('error', { stream: 'klineHistory', error: err }));
    connectKline(state.symbol, state.interval);
    connectDepth(state.symbol);
    connectWatchlist(state.watchlist);
  }

  function disconnectAll() {
    // Cleans up EVERY broker's sockets, not just the currently active mode's
    // — a mode switch earlier in the session may have left other brokers'
    // sockets open, so this must not rely on activeBrokerIds().
    Object.keys(BROKERS).forEach(b => {
      if (klineSockets[b]) { klineSockets[b].onclose = null; try { klineSockets[b].close(); } catch (e) {} klineSockets[b] = null; }
      if (depthSockets[b]) { depthSockets[b].onclose = null; try { depthSockets[b].close(); } catch (e) {} depthSockets[b] = null; }
      clearBybitPing('kline_' + b);
      clearBybitPing('depth_' + b);
      brokerCandle[b] = null;
      brokerDepthLevels[b] = null;
    });
    if (watchlistSocket) { watchlistSocket.onclose = null; try { watchlistSocket.close(); } catch (e) {} watchlistSocket = null; }
    clearBybitPing('watchlist');
    Object.keys(bybitDepthBooks).forEach(b => { bybitDepthBooks[b] = null; });
  }

  function getState() {
    // Shallow copy so consumers can't mutate internal state by accident.
    return { ...state };
  }

  function getBrokers() {
    return activeBrokerIds(); // brokers currently being aggregated together
  }

  // ── Expose ───────────────────────────────────────────────────────────
  window.marketStore = {
    init,
    setSymbol,
    setInterval: setInterval_,
    setMarketType,
    getMarketType,
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
//   marketStore.init({ symbol: 'BTCUSDT', interval: '1m', marketType: 'spot' });
//   // marketType defaults to 'spot' if omitted. All brokers for that mode
//   // connect automatically and stay aggregated — every event below is
//   // already merged, there's no per-broker switch to manage.
//
//   marketStore.onKlineHistory(candles => chart.applyNewData(candles));
//   marketStore.onKline(candle => chart.updateData(candle));
//   // candle.volume is the SUMMED dollar volume across the CURRENT mode's
//   // active brokers; candle.volumeBase is the summed asset qty.
//
//   marketStore.onDepth(({symbol, bids, asks}) => renderOrderBook(bids, asks));
//   // each level is {price, qty, total} — total is the SUMMED dollar value
//   // (price * qty) across the current mode's brokers, merged onto matching
//   // price levels.
//
//   marketStore.onTicker(({symbol, close, open}) => updateWatchlistRow(symbol, close, open));
//
//   // when user picks a new market/timeframe in chart-cockpit.js:
//   marketStore.setSymbol('ETHUSDT', '5m');
//
//   // when user picks a new Spot/Perp/Combined mode in chart-cockpit.js:
//   marketStore.setMarketType('perp');   // 'spot' | 'perp' | 'combined'
//   marketStore.getMarketType();         // currently active mode
//
//   marketStore.getBrokers();  // e.g. ['binance-spot','bybit-spot'] — which
//                               // broker ids are being aggregated right now
// ══════════════════════════════════════════════════════════════════════════
