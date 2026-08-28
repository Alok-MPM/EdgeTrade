// ══════════════════════════════════════════════════════════════════════════
// chart-terminal/market-store.js
// ══════════════════════════════════════════════════════════════════════════

(function () {

  // ── Broker registry ─────────────────────────────────────────────────────
  const BROKERS = {
    'delta-perp': {
      id: 'delta-perp',
      exchange: 'delta',
      marketType: 'perp',
      displayName: 'Delta Exchange',
      rest: 'https://api.delta.exchange/v2',
      ws: 'wss://socket.delta.exchange',
    },
    'binance-spot': {
      id: 'binance-spot',
      exchange: 'binance',
      marketType: 'spot',
      displayName: 'Binance',
      rest: 'https://api.binance.com/api/v3',
      ws: 'wss://stream.binance.com:9443',
    },
    'binance-perp': {
      id: 'binance-perp',
      exchange: 'binance',
      marketType: 'perp',
      displayName: 'Binance',
      rest: 'https://fapi.binance.com/fapi/v1',
      ws: 'wss://fstream.binance.com',
    },
    'bybit-spot': {
      id: 'bybit-spot',
      exchange: 'bybit',
      marketType: 'spot',
      displayName: 'Bybit',
      rest: 'https://api.bybit.com/v5/market',
      ws: 'wss://stream.bybit.com/v5/public/spot',
      category: 'spot',
    },
    'bybit-perp': {
      id: 'bybit-perp',
      exchange: 'bybit',
      marketType: 'perp',
      displayName: 'Bybit',
      rest: 'https://api.bybit.com/v5/market',
      ws: 'wss://stream.bybit.com/v5/public/linear',
      category: 'linear',
    },
  };

  const MODES = {
    spot:     { brokers: ['binance-spot', 'bybit-spot', 'delta-perp'], primary: 'delta-perp' },
    perp:     { brokers: ['binance-perp', 'bybit-perp', 'delta-perp'], primary: 'delta-perp' },
    combined: { brokers: ['binance-spot', 'binance-perp', 'bybit-spot', 'bybit-perp', 'delta-perp'], primary: 'delta-perp' },
  };
  const DEFAULT_MODE = 'spot';

  // Dynamic Spread Tracker (Exchange Price - Master Delta Price)
  const priceOffsets = { 'binance-spot': 0, 'binance-perp': 0, 'bybit-spot': 0, 'bybit-perp': 0, 'delta-perp': 0 };

  const BYBIT_INTERVAL_MAP = {
    '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
    '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720',
    '1d': 'D', '1w': 'W', '1M': 'M',
  };
  function toBybitInterval(interval) { return BYBIT_INTERVAL_MAP[interval] || interval; }

  const RECONNECT_DELAY_MS = 2000;
  const MAX_RECONNECT_DELAY_MS = 15000;
  const BYBIT_PING_INTERVAL_MS = 20000;

  // ── Internal state ────────────────────────────────────────────────────
  const state = {
    symbol: 'BTCUSDT',
    interval: '1m',
    marketType: DEFAULT_MODE,
    source: 'edge',
    watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'],
    latestPrice: null,
    latestDepth: null,
  };

  function activeBrokerIds() {
    if (state.source !== 'edge' && BROKERS[state.source]) return [state.source];
    return (MODES[state.marketType] || MODES[DEFAULT_MODE]).brokers;
  }
  function primaryBrokerId() {
    if (state.source !== 'edge' && BROKERS[state.source]) return state.source;
    return (MODES[state.marketType] || MODES[DEFAULT_MODE]).primary;
  }

  const klineSockets = { 'binance-spot': null, 'binance-perp': null, 'bybit-spot': null, 'bybit-perp': null, 'delta-perp': null };
  const depthSockets = { 'binance-spot': null, 'binance-perp': null, 'bybit-spot': null, 'bybit-perp': null, 'delta-perp': null };
  let watchlistSocket = null;
  let watchlistReconnectAttempt = 0;

  const brokerCandle = { 'binance-spot': null, 'binance-perp': null, 'bybit-spot': null, 'bybit-perp': null, 'delta-perp': null };
  const brokerDepthLevels = { 'binance-spot': null, 'binance-perp': null, 'bybit-spot': null, 'bybit-perp': null, 'delta-perp': null };
  const bybitDepthBooks = { 'bybit-spot': null, 'bybit-perp': null };

  const pingIntervals = { kline: null, depth: null, watchlist: null };
  function startBybitPing(sock, name) {
    clearBybitPing(name);
    pingIntervals[name] = setInterval(() => {
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ op: 'ping' }));
    }, BYBIT_PING_INTERVAL_MS);
  }
  function clearBybitPing(name) {
    if (pingIntervals[name]) { clearInterval(pingIntervals[name]); pingIntervals[name] = null; }
  }

  const listeners = { kline: [], klineHistory: [], depth: [], ticker: [], symbolChange: [], symbolListsReady: [], error: [] };
  function on(stream, cb) { if (!listeners[stream]) return; listeners[stream].push(cb); }
  function off(stream, cb) { if (!listeners[stream]) return; listeners[stream] = listeners[stream].filter(fn => fn !== cb); }
  function emit(stream, payload) { listeners[stream].forEach(cb => { try { cb(payload); } catch (err) { console.error(err); } }); }

  function toDollarLevel(price, qty) {
    const p = parseFloat(price), q = parseFloat(qty);
    return { price: p, qty: q, total: p * q };
  }

  async function fetchOneBrokerCandles(broker, symbol, interval, limit) {
    const cfg = BROKERS[broker];

    if (cfg.exchange === 'delta') {
      const res = await fetch(`${cfg.rest}/history/candles?symbol=${symbol}&resolution=${interval.replace('m','')}`);
      if (!res.ok) throw new Error(cfg.id + ' fetch failed');
      const json = await res.json();
      return (json.result || []).map(k => ({ broker: cfg.id, timestamp: k.time * 1000, open: parseFloat(k.open), high: parseFloat(k.high), low: parseFloat(k.low), close: parseFloat(k.close), volume: parseFloat(k.volume), volumeBase: parseFloat(k.volume) }));
    }

    if (cfg.exchange === 'bybit') {
      const bybitInterval = toBybitInterval(interval);
      const url = `${cfg.rest}/kline?category=${cfg.category}&symbol=${symbol}&interval=${bybitInterval}&limit=${limit}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(cfg.id + ' fetch failed');
      const json = await res.json();
      if (json.retCode !== 0) throw new Error(cfg.id + ' error: ' + json.retMsg);
      const list = json.result && json.result.list ? json.result.list : [];
      return list.slice().reverse().map(k => ({
        broker: cfg.id, timestamp: Number(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[6]), volumeBase: parseFloat(k[5]),
      }));
    }

    const url = `${cfg.rest}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(cfg.id + ' fetch failed');
    const raw = await res.json();
    return raw.map(k => ({
      broker: cfg.id, timestamp: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[7]), volumeBase: parseFloat(k[5]),
    }));
  }

  async function fetchCandles(symbol = state.symbol, interval = state.interval, limit = 300) {
    const activeBrokers = activeBrokerIds();
    const results = await Promise.allSettled(activeBrokers.map(b => fetchOneBrokerCandles(b, symbol, interval, limit)));
    const byTimestamp = new Map();
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
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
          timestamp, open: primaryPart.open, high: primaryPart.high, low: primaryPart.low, close: primaryPart.close,
          volume: parts.reduce((sum, p) => sum + p.volume, 0), volumeBase: parts.reduce((sum, p) => sum + p.volumeBase, 0),
        };
      });
    emit('klineHistory', candles);
    return candles;
  }

  const brokerSymbolCache = {};
  let symbolListsLoaded = false;

  async function fetchOneBrokerSymbols(broker) {
    const cfg = BROKERS[broker];
    if (cfg.exchange === 'delta') return []; // Skip for delta symbol cache

    if (cfg.exchange === 'bybit') {
      const url = `${cfg.rest}/tickers?category=${cfg.category}`;
      const res = await fetch(url);
      const json = await res.json();
      const list = json.result && json.result.list ? json.result.list : [];
      return list.map(t => t.symbol).filter(s => s.endsWith('USDT'));
    }
    const url = `${cfg.rest}/ticker/24hr`;
    const res = await fetch(url);
    const raw = await res.json();
    return raw.map(t => t.symbol).filter(s => s.endsWith('USDT') && !/(UP|DOWN|BULL|BEAR)USDT$/.test(s));
  }

  async function loadBrokerSymbolLists() {
    symbolListsLoaded = false;
    const ids = Object.keys(BROKERS);
    const results = await Promise.allSettled(ids.map(b => fetchOneBrokerSymbols(b)));
    results.forEach((r, i) => { brokerSymbolCache[ids[i]] = r.status === 'fulfilled' ? new Set(r.value) : new Set(); });
    symbolListsLoaded = true;
    emit('symbolListsReady', {});
  }

  function areSymbolListsReady() { return symbolListsLoaded; }
  function getBrokersForSymbol(symbol, marketType) {
    const sym = symbol.toUpperCase();
    return getBrokersForMarketType(marketType).filter(b => { const set = brokerSymbolCache[b.id]; return set ? set.has(sym) : false; });
  }
  function connectKline(symbol = state.symbol, interval = state.interval) {
    activeBrokerIds().forEach(broker => connectKlineForBroker(broker, symbol, interval));
  }

  const klineAttempts = {};

  function connectKlineForBroker(broker, symbol, interval) {
    const cfg = BROKERS[broker];
    if (klineSockets[broker]) { klineSockets[broker].onclose = null; try { klineSockets[broker].close(); } catch (e) {} klineSockets[broker] = null; }
    clearBybitPing('kline_' + broker);
    brokerCandle[broker] = null; 

    if (cfg.exchange === 'delta') {
      const sock = new WebSocket(cfg.ws);
      klineSockets[broker] = sock;
      sock.onopen = () => sock.send(JSON.stringify({ type: 'subscribe', payload: { channels: [{ name: `candlestick_${interval}`, symbols: [symbol] }] } }));
      sock.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === `candlestick_${interval}` && msg.candlestick) {
          const k = msg.candlestick;
          brokerCandle[broker] = { timestamp: k.time * 1000, open: parseFloat(k.open), high: parseFloat(k.high), low: parseFloat(k.low), close: parseFloat(k.close), volume: parseFloat(k.volume), volumeBase: parseFloat(k.volume), isClosed: false };
          emitMergedCandle();
        }
      };
      sock.onclose = () => { if (klineSockets[broker] === sock) scheduleReconnect('kline_' + broker, () => connectKlineForBroker(broker, symbol, interval)); };
      return;
    }

    if (cfg.exchange === 'bybit') {
      const bybitInterval = toBybitInterval(interval);
      const topic = `kline.${bybitInterval}.${symbol}`;
      const sock = new WebSocket(cfg.ws);
      klineSockets[broker] = sock;
      sock.onopen = () => { klineAttempts[broker] = 0; sock.send(JSON.stringify({ op: 'subscribe', args: [topic] })); startBybitPing(sock, 'kline_' + broker); };
      sock.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.topic !== topic || !msg.data) return;
        const list = Array.isArray(msg.data) ? msg.data : [msg.data];
        list.forEach(k => {
          brokerCandle[broker] = { timestamp: Number(k.start), open: parseFloat(k.open), high: parseFloat(k.high), low: parseFloat(k.low), close: parseFloat(k.close), volume: parseFloat(k.turnover), volumeBase: parseFloat(k.volume), isClosed: !!k.confirm };
          emitMergedCandle();
        });
      };
      sock.onerror = (err) => emit('error', { stream: 'kline', broker, error: err });
      sock.onclose = () => { clearBybitPing('kline_' + broker); if (klineSockets[broker] === sock) scheduleReconnect('kline_' + broker, () => connectKlineForBroker(broker, state.symbol, state.interval)); };
      return;
    }

    const url = `${cfg.ws}/ws/${symbol.toLowerCase()}@kline_${interval}`;
    const sock = new WebSocket(url);
    klineSockets[broker] = sock;
    sock.onopen = () => { klineAttempts[broker] = 0; };
    sock.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const k = msg.k;
      brokerCandle[broker] = { timestamp: k.t, open: parseFloat(k.o), high: parseFloat(k.h), low: parseFloat(k.l), close: parseFloat(k.c), volume: parseFloat(k.q), volumeBase: parseFloat(k.v), isClosed: k.x };
      emitMergedCandle();
    };
    sock.onerror = (err) => emit('error', { stream: 'kline', broker, error: err });
    sock.onclose = () => { if (klineSockets[broker] === sock) scheduleReconnect('kline_' + broker, () => connectKlineForBroker(broker, state.symbol, state.interval)); };
  }

  function emitMergedCandle() {
    const activeBrokers = activeBrokerIds();
    const timestamps = activeBrokers.filter(b => brokerCandle[b]).map(b => brokerCandle[b].timestamp);
    if (!timestamps.length) return;
    const latestTs = Math.max(...timestamps);
    const parts = activeBrokers.filter(b => brokerCandle[b] && brokerCandle[b].timestamp === latestTs).map(b => ({ broker: b, candle: brokerCandle[b] }));
    if (!parts.length) return;

    const primaryBroker = primaryBrokerId();
    const primary = parts.find(p => p.broker === primaryBroker) || parts[0];

    if (primary.broker === 'delta-perp') {
        parts.forEach(p => { priceOffsets[p.broker] = p.candle.close - primary.candle.close; });
    }

    const merged = {
      timestamp: latestTs, open: primary.candle.open, high: primary.candle.high, low: primary.candle.low, close: primary.candle.close,
      volume: parts.reduce((sum, p) => sum + p.candle.volume, 0), volumeBase: parts.reduce((sum, p) => sum + p.candle.volumeBase, 0),
      isClosed: parts.every(p => p.candle.isClosed),
    };
    state.latestPrice = merged.close;
    emit('kline', merged);
  }

  function connectDepth(symbol = state.symbol) {
    activeBrokerIds().forEach(broker => connectDepthForBroker(broker, symbol));
  }

  function connectDepthForBroker(broker, symbol) {
    const cfg = BROKERS[broker];
    if (cfg.exchange === 'delta') return; // Rely on Binance/Bybit for volume depth

    if (depthSockets[broker]) { depthSockets[broker].onclose = null; try { depthSockets[broker].close(); } catch (e) {} depthSockets[broker] = null; }
    clearBybitPing('depth_' + broker);
    brokerDepthLevels[broker] = null; 

    if (cfg.exchange === 'bybit') {
      bybitDepthBooks[broker] = { bids: new Map(), asks: new Map() };
      const topic = `orderbook.50.${symbol}`;
      const sock = new WebSocket(cfg.ws);
      depthSockets[broker] = sock;
      sock.onopen = () => { sock.send(JSON.stringify({ op: 'subscribe', args: [topic] })); startBybitPing(sock, 'depth_' + broker); };
      sock.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.topic !== topic || !msg.data) return;
        applyBybitDepthMessage(broker, msg.type, msg.data);
      };
      sock.onerror = (err) => emit('error', { stream: 'depth', broker, error: err });
      sock.onclose = () => { clearBybitPing('depth_' + broker); if (depthSockets[broker] === sock) scheduleReconnect('depth_' + broker, () => connectDepthForBroker(broker, state.symbol)); };
      return;
    }

    const url = `${cfg.ws}/ws/${symbol.toLowerCase()}@depth20@100ms`;
    const sock = new WebSocket(url);
    depthSockets[broker] = sock;
    sock.onmessage = (event) => {
      const data = JSON.parse(event.data);
      brokerDepthLevels[broker] = { bids: (data.bids || []).map(([price, qty]) => toDollarLevel(price, qty)), asks: (data.asks || []).map(([price, qty]) => toDollarLevel(price, qty)) };
      emitMergedDepth(symbol);
    };
    sock.onerror = (err) => emit('error', { stream: 'depth', broker, error: err });
    sock.onclose = () => { if (depthSockets[broker] === sock) scheduleReconnect('depth_' + broker, () => connectDepthForBroker(broker, state.symbol)); };
  }

  function applyBybitDepthMessage(brokerId, type, data) {
    if (!bybitDepthBooks[brokerId]) bybitDepthBooks[brokerId] = { bids: new Map(), asks: new Map() };
    const book = bybitDepthBooks[brokerId];
    if (type === 'snapshot') { book.bids.clear(); book.asks.clear(); }
    (data.b || []).forEach(([price, qty]) => { const q = parseFloat(qty); if (q === 0) book.bids.delete(price); else book.bids.set(price, q); });
    (data.a || []).forEach(([price, qty]) => { const q = parseFloat(qty); if (q === 0) book.asks.delete(price); else book.asks.set(price, q); });
    brokerDepthLevels[brokerId] = { bids: [...book.bids.entries()].map(([price, qty]) => toDollarLevel(price, qty)), asks: [...book.asks.entries()].map(([price, qty]) => toDollarLevel(price, qty)) };
    emitMergedDepth(state.symbol);
  }

  function emitMergedDepth(symbol) {
    const bidMap = new Map();
    const askMap = new Map();

    activeBrokerIds().forEach(broker => {
      const levels = brokerDepthLevels[broker];
      if (!levels) return;
      const offset = priceOffsets[broker] || 0;
      levels.bids.forEach(l => { const adjustedPrice = l.price - offset; addLevel(bidMap, { price: adjustedPrice, qty: l.qty, total: l.total }); });
      levels.asks.forEach(l => { const adjustedPrice = l.price - offset; addLevel(askMap, { price: adjustedPrice, qty: l.qty, total: l.total }); });
    });

    const bids = [...bidMap.values()].sort((a, b) => b.price - a.price).slice(0, 20);
    const asks = [...askMap.values()].sort((a, b) => a.price - b.price).slice(0, 20);

    state.latestDepth = { bids, asks };
    emit('depth', { symbol, bids, asks });
  }

  function addLevel(map, level) {
    const existing = map.get(level.price);
    if (existing) { existing.qty += level.qty; existing.total += level.total; } 
    else { map.set(level.price, { price: level.price, qty: level.qty, total: level.total }); }
  }

  function connectWatchlist(symbols = state.watchlist) {
    if (watchlistSocket) { watchlistSocket.onclose = null; try { watchlistSocket.close(); } catch (e) {} watchlistSocket = null; }
    const streams = symbols.map(s => s.toLowerCase() + '@miniTicker').join('/');
    const url = `${BROKERS['binance-spot'].ws}/stream?streams=${streams}`;
    const sock = new WebSocket(url);
    watchlistSocket = sock;
    sock.onopen = () => { watchlistReconnectAttempt = 0; };
    sock.onmessage = (event) => { const msg = JSON.parse(event.data); const d = msg.data; if (!d || !d.s) return; emit('ticker', { symbol: d.s, close: parseFloat(d.c), open: parseFloat(d.o) }); };
    sock.onerror = (err) => emit('error', { stream: 'watchlist', broker: 'binance', error: err });
    sock.onclose = () => { if (watchlistSocket === sock) scheduleReconnect('watchlist', () => connectWatchlist(state.watchlist)); };
  }

  const attemptCounters = { kline: 0, depth: 0, watchlist: 0 };
  function scheduleReconnect(name, reconnectFn) {
    attemptCounters[name] = (attemptCounters[name] || 0) + 1;
    const delay = Math.min(RECONNECT_DELAY_MS * attemptCounters[name], MAX_RECONNECT_DELAY_MS);
    setTimeout(() => { reconnectFn(); }, delay);
  }

  async function setSymbol(symbol, interval = state.interval) {
    state.symbol = symbol.toUpperCase(); state.interval = interval;
    emit('symbolChange', { symbol: state.symbol, interval: state.interval, brokers: activeBrokerIds() });
    await fetchCandles(state.symbol, state.interval, 300);
    connectKline(state.symbol, state.interval); connectDepth(state.symbol);
  }

  async function setInterval_(interval) { return setSymbol(state.symbol, interval); }

  async function setMarketType(mode) {
    if (!MODES[mode]) return;
    state.marketType = mode;
    emit('symbolChange', { symbol: state.symbol, interval: state.interval, brokers: activeBrokerIds() });
    await fetchCandles(state.symbol, state.interval, 300);
    connectKline(state.symbol, state.interval); connectDepth(state.symbol);
  }
  function getMarketType() { return state.marketType; }

  function disconnectBrokerStreams(broker) {
    if (klineSockets[broker]) { klineSockets[broker].onclose = null; try { klineSockets[broker].close(); } catch (e) {} klineSockets[broker] = null; }
    if (depthSockets[broker]) { depthSockets[broker].onclose = null; try { depthSockets[broker].close(); } catch (e) {} depthSockets[broker] = null; }
    clearBybitPing('kline_' + broker); clearBybitPing('depth_' + broker);
    brokerCandle[broker] = null; brokerDepthLevels[broker] = null;
    if (bybitDepthBooks[broker] !== undefined) bybitDepthBooks[broker] = null;
  }

  async function setSource(source) {
    if (source !== 'edge' && !BROKERS[source]) return;
    state.source = source;
    const newActive = activeBrokerIds();
    Object.keys(BROKERS).forEach(b => { if (!newActive.includes(b)) disconnectBrokerStreams(b); });
    emit('symbolChange', { symbol: state.symbol, interval: state.interval, brokers: newActive });
    await fetchCandles(state.symbol, state.interval, 300);
    connectKline(state.symbol, state.interval); connectDepth(state.symbol);
  }
  function getSource() { return state.source; }

  function getBrokersForMarketType(marketType) {
    return Object.values(BROKERS).filter(b => b.marketType === marketType).map(b => ({ id: b.id, exchange: b.exchange, displayName: b.displayName, marketType: b.marketType }));
  }
  function setWatchlist(symbols) { state.watchlist = symbols; connectWatchlist(symbols); }

  function init({ symbol = state.symbol, interval = state.interval, watchlist = state.watchlist, marketType = state.marketType } = {}) {
    state.symbol = symbol.toUpperCase(); state.interval = interval; state.watchlist = watchlist;
    state.marketType = MODES[marketType] ? marketType : DEFAULT_MODE;
    fetchCandles(state.symbol, state.interval, 300).catch(err => emit('error', { stream: 'klineHistory', error: err }));
    connectKline(state.symbol, state.interval); connectDepth(state.symbol); connectWatchlist(state.watchlist);
    loadBrokerSymbolLists();
  }

  function disconnectAll() {
    Object.keys(BROKERS).forEach(b => {
      if (klineSockets[b]) { klineSockets[b].onclose = null; try { klineSockets[b].close(); } catch (e) {} klineSockets[b] = null; }
      if (depthSockets[b]) { depthSockets[b].onclose = null; try { depthSockets[b].close(); } catch (e) {} depthSockets[b] = null; }
      clearBybitPing('kline_' + b); clearBybitPing('depth_' + b);
      brokerCandle[b] = null; brokerDepthLevels[b] = null;
    });
    if (watchlistSocket) { watchlistSocket.onclose = null; try { watchlistSocket.close(); } catch (e) {} watchlistSocket = null; }
    clearBybitPing('watchlist'); Object.keys(bybitDepthBooks).forEach(b => { bybitDepthBooks[b] = null; });
  }

  function getState() { return { ...state }; }
  function getBrokers() { return activeBrokerIds(); }

  window.marketStore = {
    init, setSymbol, setInterval: setInterval_, setMarketType, getMarketType, setSource, getSource,
    getBrokersForMarketType, getBrokersForSymbol, loadBrokerSymbolLists, areSymbolListsReady, setWatchlist,
    fetchCandles, disconnectAll, getState, getBrokers,
    onKline: (cb) => on('kline', cb), offKline: (cb) => off('kline', cb),
    onKlineHistory: (cb) => on('klineHistory', cb), offKlineHistory: (cb) => off('klineHistory', cb),
    onDepth: (cb) => on('depth', cb), offDepth: (cb) => off('depth', cb),
    onTicker: (cb) => on('ticker', cb), offTicker: (cb) => off('ticker', cb),
    onSymbolChange: (cb) => on('symbolChange', cb), offSymbolChange: (cb) => off('symbolChange', cb),
    onSymbolListsReady: (cb) => on('symbolListsReady', cb), offSymbolListsReady: (cb) => off('symbolListsReady', cb),
    onError: (cb) => on('error', cb), offError: (cb) => off('error', cb),
  };

})();
