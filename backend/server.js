/**
EdgeTrade — Isolated Backend (server.js) — FIXED BASE (PART 1/2)
Cold-Start / Zero-Latency Footprint Engine — MULTI-SYMBOL & SPOT-SPACE ANCHOR
Paste PART 2 immediately after this part (end of file).
*/
const express = require('express');
require('dotenv').config();
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const { URL } = require('url');
// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 4000;
const DEFAULT_SYMBOL = (process.env.SYMBOL || 'btcusdt').toLowerCase();
const CANDLE_INTERVAL = '1m';
const MAX_CANDLE_HISTORY = 1000;
const IDLE_SLEEP_MS = 15 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 30 * 1000;
const RECONNECT_DELAY_MS = 3000;
const MAX_AWAKE_MARKETS = 40;
const PULSE_BUCKET_MS = 300000;
const MAX_PULSE_BUCKETS = 288;
const WHALE_WALL_THRESHOLD = 5000000;   // $5M => save to DB
const LIQ_WALL_MIN = 1000000;           // $1M => show on liquidity map (noise kam)
const WALL_HEARTBEAT_MS = 60000;
const WALL_CHANGE_PCT = 0.10;
const BINANCE_REST_BASE = 'https://data-api.binance.vision/api/v3'; // geo-neutral public market-data host
const BINANCE_REST_KLINES = (symbol, interval, limit) =>
  `${BINANCE_REST_BASE}/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`;
const BINANCE_WS_URL = (symbol) =>
  `wss://stream.binance.com:9443/stream?streams=${symbol}@trade/${symbol}@kline_${CANDLE_INTERVAL}`;
const BINANCE_WS_DEPTH_URL = (symbol) =>
  `wss://stream.binance.com:9443/ws/${symbol}@depth20@1000ms`;
const BYBIT_WS_URL = 'wss://stream.bybit.com/v5/public/linear';
const DELTA_WS_URL = 'wss://socket.delta.exchange';
// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------
const markets = new Map();
const wallMemory = new Map(); // symbol -> Array<{side,price,total,lastInsertMs}>
function makeEmptyFootprintCandle(time) {
  return { time: time != null ? time : null, open: null, high: null, low: null, close: null, volume: 0, levels: {} };
}
function makePulseState() {
  return {
    lastPrice: 0, oi: 0, oiUpdatedAt: null,
    bucketStart: null, bucketVolume: 0, bucketCvd: 0,
    buckets: [], verdict: 'Neutral', verdictType: 'neutral', bias: 'neutral',
  };
}
function createMarket(symbol) {
  return {
    symbol, awake: false, lastActivity: 0,
    masterPrices: { delta: null, binance: null, bybit: null },
    whaleTracker: { retailBuy: 0, retailSell: 0, smBuy: 0, smSell: 0, openPrice: null, currentPhase: 0 },
    candles: [], footprintHistory: [], liveFootprint: makeEmptyFootprintCandle(), hourlyRollup: [],
    sockets: { binance: null, bybit: null, delta: null },
    reconnectTimers: { binance: null, bybit: null, delta: null },
    clients: new Set(),
    pulse: makePulseState(),
    flow: makeFlowState(),
    liquidity: { bids: [], asks: [], lastUpdateTime: null, awake: false, lastActivity: 0, socket: null, reconnectTimer: null, clients: new Set() },
  };
}
function getOrCreateMarket(symbol) {
  let market = markets.get(symbol);
  if (!market) { market = createMarket(symbol); markets.set(symbol, market); }
  return market;
}
function touchActivity(market) { market.lastActivity = Date.now(); }
function bucketPrice(price) {
  const p = Number(price);
  if (p >= 1000) return Math.round(p).toString();
  if (p >= 10) return (Math.round(p * 10) / 10).toString();
  return (Math.round(p * 10000) / 10000).toString();
}
const round2 = (n) => Number(Number(n).toFixed(2));
// ---------------------------------------------------------------------------
// SHADOW PROCESSING & BACKFILL
// ---------------------------------------------------------------------------
async function fetchInitialCandles(symbol) {
  const url = BINANCE_REST_KLINES(symbol, CANDLE_INTERVAL, MAX_CANDLE_HISTORY);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance REST klines failed: ${res.status}`);
  const raw = await res.json();
  return raw.map((k) => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}
const BACKFILL_MINUTES = 1440;
const BACKFILL_MAX_TRADES = 200000;
const BACKFILL_TIMEOUT_MS = 25000;
async function backfillFootprintHistory(market) {
  const endTime = Date.now();
  const startTime = endTime - BACKFILL_MINUTES * 60 * 1000;
  const deadline = Date.now() + BACKFILL_TIMEOUT_MS;
  let trades = [];
  let fromId = null;
  try {
    while (trades.length < BACKFILL_MAX_TRADES && Date.now() < deadline) {
      const url = fromId == null
        ? `${BINANCE_REST_BASE}/aggTrades?symbol=${market.symbol.toUpperCase()}&startTime=${startTime}&endTime=${endTime}&limit=1000`
        : `${BINANCE_REST_BASE}/aggTrades?symbol=${market.symbol.toUpperCase()}&fromId=${fromId + 1}&limit=1000`;
      const res = await fetch(url);
      if (!res.ok) break;
      const page = await res.json();
      if (!page.length) break;
      trades = trades.concat(page);
      fromId = page[page.length - 1].a;
      if (page[page.length - 1].T >= endTime || page.length < 1000) break;
    }
  } catch (err) { return; }
  if (!trades.length) return;
  const byMinute = new Map();
  trades.forEach((t) => {
    const openTime = Math.floor(t.T / 60000) * 60000;
    if (!byMinute.has(openTime)) byMinute.set(openTime, makeEmptyFootprintCandle(openTime));
    const fp = byMinute.get(openTime);
    const bucket = bucketPrice(t.p);
    if (!fp.levels[bucket]) fp.levels[bucket] = { spot: { buy: 0, sell: 0, trades: 0 }, perp: { buy: 0, sell: 0, trades: 0 } };
    const side = fp.levels[bucket].spot;
    const qty = parseFloat(t.q);
    if (t.m) side.sell += qty; else side.buy += qty;
    side.trades += 1;
    fp.volume += qty;
  });
  const ohlcByTime = new Map(market.candles.map((c) => [c.time, c]));
  const sortedTimes = [...byMinute.keys()].sort((a, b) => a - b);
  const built = sortedTimes.map((t) => {
    const fp = byMinute.get(t);
    const ohlc = ohlcByTime.get(t);
    if (ohlc) { fp.open = ohlc.open; fp.high = ohlc.high; fp.low = ohlc.low; fp.close = ohlc.close; }
    return fp;
  });
  const currentOpenTime = market.candles.length ? market.candles[market.candles.length - 1].time : null;
  if (built.length && built[built.length - 1].time === currentOpenTime) market.liveFootprint = built.pop();
  market.footprintHistory = built.slice(-MAX_CANDLE_HISTORY);
}
// ---------------------------------------------------------------------------
// EXCHANGE WS (BINANCE, BYBIT, DELTA)
// ---------------------------------------------------------------------------
function connectDelta(market) {
  clearTimeout(market.reconnectTimers.delta);
  const ws = new WebSocket(DELTA_WS_URL);
  market.sockets.delta = ws;
  const deltaSymbol = market.symbol.toUpperCase();
  ws.on('open', () => {
    console.log(`[delta-anchor] connected (${market.symbol})`);
    ws.send(JSON.stringify({ type: 'subscribe', payload: { channels: [{ name: 'v2/ticker', symbols: [deltaSymbol] }] } }));
  });
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'v2/ticker' && msg.mark_price) market.masterPrices.delta = parseFloat(msg.mark_price);
  });
  ws.on('close', () => { if (market.awake) market.reconnectTimers.delta = setTimeout(() => connectDelta(market), RECONNECT_DELAY_MS); });
  ws.on('error', () => ws.close());
}
function connectBinance(market) {
  clearTimeout(market.reconnectTimers.binance);
  const ws = new WebSocket(BINANCE_WS_URL(market.symbol));
  market.sockets.binance = ws;
  ws.on('open', () => console.log(`[binance] connected (${market.symbol})`));
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const payload = msg.data;
    if (!payload) return;
    if (payload.e === 'trade') {
      handleTradeTick(market, { price: payload.p, qty: payload.q, isBuyerMaker: payload.m, time: payload.T, exchange: 'binance', source: 'spot' });
    } else if (payload.e === 'kline') {
      market.masterPrices.binance = parseFloat(payload.k.c);
      handleKlineUpdate(market, payload.k);
    }
  });
  ws.on('close', () => { if (market.awake) market.reconnectTimers.binance = setTimeout(() => connectBinance(market), RECONNECT_DELAY_MS); });
  ws.on('error', () => ws.close());
}
function connectBybit(market) {
  clearTimeout(market.reconnectTimers.bybit);
  const ws = new WebSocket(BYBIT_WS_URL);
  market.sockets.bybit = ws;
  const bybitSymbol = market.symbol.toUpperCase();
  ws.on('open', () => {
    ws.send(JSON.stringify({ op: 'subscribe', args: [`publicTrade.${bybitSymbol}`] }));
    ws.pingInterval = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'ping' })); }, 20000);
  });
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.topic && msg.topic.startsWith('publicTrade') && Array.isArray(msg.data)) {
      msg.data.forEach((t) => {
        market.masterPrices.bybit = parseFloat(t.p);
        handleTradeTick(market, { price: t.p, qty: t.v, isBuyerMaker: t.S === 'Sell', time: t.T, exchange: 'bybit', source: 'perp' });
      });
    }
  });
  ws.on('close', () => {
    clearInterval(ws.pingInterval);
    if (market.awake) market.reconnectTimers.bybit = setTimeout(() => connectBybit(market), RECONNECT_DELAY_MS);
  });
  ws.on('error', () => ws.close());
}
// Spot book is already in chart space (Binance spot) => NO offset applied.
function connectLiquidityDepth(market) {
  clearTimeout(market.liquidity.reconnectTimer);
  const ws = new WebSocket(BINANCE_WS_DEPTH_URL(market.symbol));
  market.liquidity.socket = ws;
  ws.on('open', () => console.log(`[liquidity] connected (${market.symbol})`));
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(msg.bids) || !Array.isArray(msg.asks)) return;
    market.liquidity.bids = msg.bids.map(([price, qty]) => ({ price: parseFloat(price), qty: parseFloat(qty) }));
    market.liquidity.asks = msg.asks.map(([price, qty]) => ({ price: parseFloat(price), qty: parseFloat(qty) }));
    market.liquidity.lastUpdateTime = Date.now();
    broadcastToLiquidityClients(market, { type: 'depth', bids: market.liquidity.bids, asks: market.liquidity.asks, time: market.liquidity.lastUpdateTime });
  });
  ws.on('close', () => { if (market.liquidity.awake) market.liquidity.reconnectTimer = setTimeout(() => connectLiquidityDepth(market), RECONNECT_DELAY_MS); });
  ws.on('error', () => ws.close());
}
function wakeLiquidity(market) {
  market.liquidity.lastActivity = Date.now();
  if (market.liquidity.awake) return;
  market.liquidity.awake = true;
  connectLiquidityDepth(market);
}
function sleepLiquidity(market) {
  if (!market.liquidity.awake) return;
  if (market.liquidity.socket) market.liquidity.socket.close();
  clearTimeout(market.liquidity.reconnectTimer);
  market.liquidity.awake = false;
  market.liquidity.bids = []; market.liquidity.asks = []; market.liquidity.lastUpdateTime = null;
  if (!market.awake && market.clients.size === 0 && market.liquidity.clients.size === 0) markets.delete(market.symbol);
}
function broadcastToLiquidityClients(market, payload) {
  if (!market.liquidity.clients.size) return;
  const msg = JSON.stringify(payload);
  market.liquidity.clients.forEach((client) => { if (client.readyState === WebSocket.OPEN) client.send(msg); });
}
// ---------------------------------------------------------------------------
// FOOTPRINT ROLLUP / ROTATION
// ---------------------------------------------------------------------------
const MAX_HOURLY_ROLLUP = 48;
function foldIntoHourlyRollup(market, candle) {
  const hourStart = Math.floor(candle.time / 3600000) * 3600000;
  let bucket = market.hourlyRollup[market.hourlyRollup.length - 1];
  if (!bucket || bucket.time !== hourStart) {
    bucket = { time: hourStart, levels: {} };
    market.hourlyRollup.push(bucket);
    if (market.hourlyRollup.length > MAX_HOURLY_ROLLUP) market.hourlyRollup.shift();
  }
  for (const price of Object.keys(candle.levels || {})) {
    const src = candle.levels[price];
    if (!bucket.levels[price]) bucket.levels[price] = { spot: { buy: 0, sell: 0, trades: 0 }, perp: { buy: 0, sell: 0, trades: 0 } };
    const dst = bucket.levels[price];
    dst.spot.buy += src.spot.buy; dst.spot.sell += src.spot.sell; dst.spot.trades += src.spot.trades;
    dst.perp.buy += src.perp.buy; dst.perp.sell += src.perp.sell; dst.perp.trades += src.perp.trades;
  }
}
function ensureLiveFootprintCandle(market, candleOpenTime) {
  if (market.liveFootprint.time === candleOpenTime) return true;
  if (market.liveFootprint.time != null && candleOpenTime < market.liveFootprint.time) return false;
  if (market.liveFootprint.time != null) {
    market.footprintHistory.push(market.liveFootprint);
    if (market.footprintHistory.length > MAX_CANDLE_HISTORY) market.footprintHistory.shift();
    foldIntoHourlyRollup(market, market.liveFootprint);
    broadcastToMarket(market, {
      type: 'candle_closed',
      candle: { time: market.liveFootprint.time, open: market.liveFootprint.open, high: market.liveFootprint.high, low: market.liveFootprint.low, close: market.liveFootprint.close },
    });
  }
  market.liveFootprint = makeEmptyFootprintCandle(candleOpenTime);
  market.whaleTracker = { retailBuy: 0, retailSell: 0, smBuy: 0, smSell: 0, openPrice: null, currentPhase: 0 };
  return true;
}
// Anchor space = Binance SPOT (chart candles are spot). Perp ticks de-based to spot.
function handleTradeTick(market, { price, qty, isBuyerMaker, time, exchange, source }) {
  touchActivity(market);
  const p = parseFloat(price);
  const q = parseFloat(qty);
  if (!isFinite(p) || !isFinite(q)) return;
  market.pulse.lastPrice = p;
  market.pulse.bucketCvd += isBuyerMaker ? -q : q;
  market.pulse.bucketVolume += q;
  observeTrade(market, p, q, isBuyerMaker);
  const candleOpenTime = Math.floor(time / 60000) * 60000;
  if (!ensureLiveFootprintCandle(market, candleOpenTime)) return;
  let adjustedPrice = p;
  const exPrice = market.masterPrices[exchange];
  if (exchange !== 'binance' && exPrice && market.masterPrices.binance) {
    adjustedPrice = p - (exPrice - market.masterPrices.binance);
  }
  const bucket = bucketPrice(adjustedPrice);
  const level = market.liveFootprint.levels[bucket] || { spot: { buy: 0, sell: 0, trades: 0 }, perp: { buy: 0, sell: 0, trades: 0 } };
  const side = level[source];
  if (isBuyerMaker) side.sell += q; else side.buy += q;
  side.trades += 1;
  market.liveFootprint.levels[bucket] = level;
  market.liveFootprint.volume += q;
  broadcastToMarket(market, { type: 'tick', price: adjustedPrice, qty: q, side: isBuyerMaker ? 'sell' : 'buy', source, time });
}
function handleKlineUpdate(market, k) {
  const candle = { time: k.t, open: parseFloat(k.o), high: parseFloat(k.h), low: parseFloat(k.l), close: parseFloat(k.c), volume: parseFloat(k.v) };
  if (market.candles.length && market.candles[market.candles.length - 1].time === candle.time) {
    market.candles[market.candles.length - 1] = candle;
  } else {
    market.candles.push(candle);
    if (market.candles.length > MAX_CANDLE_HISTORY) market.candles.shift();
  }
  pushSwing(market, candle.high, candle.low);
  ensureLiveFootprintCandle(market, k.t);
  if (market.liveFootprint.time === candle.time) {
    market.liveFootprint.open = candle.open;
    market.liveFootprint.high = candle.high;
    market.liveFootprint.low = candle.low;
    market.liveFootprint.close = candle.close;
  }
}
// ---------------------------------------------------------------------------
// WAKE / SLEEP
// ---------------------------------------------------------------------------
async function wakeUp(symbol) {
  const market = getOrCreateMarket(symbol);
  touchActivity(market);
  if (market.awake) return { alreadyAwake: true, symbol };
  if (countAwakeMarkets() >= MAX_AWAKE_MARKETS) return { alreadyAwake: false, symbol, error: 'server_at_capacity', candleCount: 0 };
  market.awake = true;
  try { market.candles = await fetchInitialCandles(symbol); } catch (err) { market.candles = []; }
  market.footprintHistory = [];
  market.liveFootprint = makeEmptyFootprintCandle();
  market.pulse = makePulseState();
  await seedPulseBucketsFromDB(market);
  await backfillFootprintHistory(market);
  connectDelta(market);
  connectBinance(market);
  connectBybit(market);
  return { alreadyAwake: false, symbol, candleCount: market.candles.length, footprintCandleCount: market.footprintHistory.length };
}
function sleep(market) {
  if (!market.awake) return;
  if (market.sockets.binance) market.sockets.binance.close();
  if (market.sockets.bybit) market.sockets.bybit.close();
  if (market.sockets.delta) market.sockets.delta.close();
  clearTimeout(market.reconnectTimers.binance);
  clearTimeout(market.reconnectTimers.bybit);
  clearTimeout(market.reconnectTimers.delta);
  market.awake = false;
  market.candles = [];
  market.footprintHistory = [];
  market.liveFootprint = makeEmptyFootprintCandle();
  if (market.clients.size === 0 && !market.liquidity.awake && market.liquidity.clients.size === 0) markets.delete(market.symbol);
}
function countAwakeMarkets() {
  let n = 0;
  for (const m of markets.values()) if (m.awake) n++;
  return n;
}
setInterval(() => {
  const now = Date.now();
  for (const market of markets.values()) {
    if (market.awake && market.clients.size === 0 && now - market.lastActivity > IDLE_SLEEP_MS) sleep(market);
    if (market.liquidity.awake && market.liquidity.clients.size === 0 && now - market.liquidity.lastActivity > IDLE_SLEEP_MS) sleepLiquidity(market);
  }
}, IDLE_CHECK_INTERVAL_MS);

// ---------------------------------------------------------------------------
// FLOW INTELLIGENCE ENGINE (retail / pro / whale classification + traps)
// ---------------------------------------------------------------------------
function makeFlowState() {
  return {
    hist: new Map(), histSum: new Map(), studyTrades: 0, dayKey: null,
    pct: { p50: 800, p75: 10000, p90: 40000, p95: 100000, p99: 400000 },
    cls: { retail: { buy: 0, sell: 0 }, pro: { buy: 0, sell: 0 }, whale: { buy: 0, sell: 0 } },
    clips: [], absorb: new Map(), swing: [], swingHigh: null, swingLow: null,
    armedUp: null, armedDn: null,
    herd: { side: null, share: 0, until: 0 }, trap: null, recentSmart: null,
    lastEventTs: {},
  };
}
function histIdx(usd) { return Math.max(0, Math.floor(Math.log2(Math.max(1, usd)))); }
function pushSwing(market, high, low) {
  const f = market.flow; if (!f) return;
  f.swing.push({ high, low }); if (f.swing.length > 30) f.swing.shift();
  f.swingHigh = Math.max(...f.swing.map(s => s.high));
  f.swingLow = Math.min(...f.swing.map(s => s.low));
}
function flowCooldown(f, key, ms) { const n = Date.now(); if (f.lastEventTs[key] && n - f.lastEventTs[key] < ms) return false; f.lastEventTs[key] = n; return true; }
function saveFlowEvent(ev) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  fetch(`${SUPABASE_URL}/rest/v1/flow_events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }, body: JSON.stringify([ev]) }).catch(e => console.error('flow event save:', e.message));
}
function emitFlowEvent(market, type, side, usd, price, meta) {
  const ev = { symbol: market.symbol.toUpperCase(), ts: Date.now(), type, side, usd: round2(usd), price: round2(price), meta: meta || {} };
  if (market.clients.size) broadcastToMarket(market, { type: 'flow_event', data: ev });
  saveFlowEvent(ev);
  if (type === 'SPLIT_EXEC' || type === 'ABSORPTION' || type === 'WHALE_PRINT') market.flow.recentSmart = { side, ts: ev.ts, type };
  if (type === 'TRAP') market.flow.trap = { side, ts: ev.ts, action: (meta && meta.action) || '', text: (meta && meta.text) || '' };
}
function percentilesFromHist(f) {
  const total = [...f.hist.values()].reduce((a, b) => a + b, 0);
  if (total < 500) return null;
  const keys = [...f.hist.keys()].sort((a, b) => a - b);
  const targets = { p50: 0.5, p75: 0.75, p90: 0.9, p95: 0.95, p99: 0.99 };
  const order = ['p50', 'p75', 'p90', 'p95', 'p99'];
  const out = {}; let acc = 0, ti = 0;
  for (const k of keys) { acc += f.hist.get(k); while (ti < order.length && acc >= total * targets[order[ti]]) { out[order[ti]] = Math.pow(2, k + 1); ti++; } }
  while (ti < order.length) { out[order[ti]] = Math.pow(2, keys[keys.length - 1] + 1); ti++; }
  return out;
}
function recalibrateFlow(market) {
  const f = market.flow; const p = percentilesFromHist(f);
  if (p) f.pct = p;
  const day = new Date().toISOString().slice(0, 10);
  if (f.dayKey !== day) {
    f.dayKey = day;
    if (SUPABASE_URL && SUPABASE_KEY) {
      const total = [...f.hist.values()].reduce((a, b) => a + b, 0);
      const vol = [...f.histSum.values()].reduce((a, b) => a + b, 0);
      fetch(`${SUPABASE_URL}/rest/v1/flow_size_stats`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'resolution=merge-duplicates' }, body: JSON.stringify([{ symbol: market.symbol.toUpperCase(), day, p50: round2(f.pct.p50), p75: round2(f.pct.p75), p90: round2(f.pct.p90), p95: round2(f.pct.p95), p99: round2(f.pct.p99), max_usd: round2(Math.pow(2, [...f.hist.keys()].reduce((m, k) => Math.max(m, k), 0) + 1)), trades: total, volume_usd: round2(vol) }]) }).catch(e => console.error('flow stats save:', e.message));
    }
  }
}
function observeTrade(market, price, qty, isBuyerMaker) {
  const f = market.flow; if (!f) return;
  const usd = price * qty; const side = isBuyerMaker ? 'sell' : 'buy';
  const i = histIdx(usd);
  f.hist.set(i, (f.hist.get(i) || 0) + 1); f.histSum.set(i, (f.histSum.get(i) || 0) + usd); f.studyTrades++;
  const cls = usd >= f.pct.p95 ? 'whale' : usd >= f.pct.p75 ? 'pro' : 'retail';
  f.cls[cls][side] += usd;
  f.clips.push({ t: Date.now(), side, usd, price, cls });
  if (f.clips.length > 500) f.clips.splice(0, f.clips.length - 500);
  detectWhalePrint(market, usd, side, price);
  detectSplit(market, side);
  detectAbsorption(market, price, usd, side);
  detectSweep(market, price);
  detectHerd(market);
}
function detectWhalePrint(market, usd, side, price) {
  const f = market.flow;
  if (usd < Math.max(f.pct.p99, 500000)) return;
  if (!flowCooldown(f, 'WP' + side, 20000)) return;
  emitFlowEvent(market, 'WHALE_PRINT', side, usd, price, {});
}
function detectSplit(market, side) {
  const f = market.flow; const now = Date.now();
  const win = f.clips.filter(c => c.side === side && now - c.t <= 90000 && c.cls !== 'whale');
  const sum = win.reduce((s, c) => s + c.usd, 0);
  if (win.length >= 10 && sum >= 250000) {
    if (!flowCooldown(f, 'SPLIT' + side, 180000)) return;
    const prices = win.map(c => c.price);
    const pMin = Math.min(...prices), pMax = Math.max(...prices);
    emitFlowEvent(market, 'SPLIT_EXEC', side, sum, (pMin + pMax) / 2, { prints: win.length, pMin: round2(pMin), pMax: round2(pMax), action: side === 'buy' ? 'ACCUMULATION' : 'DISTRIBUTION' });
    f.clips = f.clips.filter(c => !(c.side === side && now - c.t <= 90000 && c.cls !== 'whale'));
  }
}
function detectAbsorption(market, price, usd, side) {
  const f = market.flow; const key = bucketPrice(price); const now = Date.now();
  let a = f.absorb.get(key);
  if (!a) { a = { buy: 0, sell: 0, first: now, price }; f.absorb.set(key, a); }
  if (side === 'buy') a.buy += usd; else a.sell += usd;
  if (now - a.first > 60000) {
    const dom = a.buy > a.sell ? 'buy' : 'sell';
    const domUsd = Math.max(a.buy, a.sell);
    if (domUsd >= 300000 && Math.abs(price - a.price) / a.price <= 0.0002) {
      const passive = dom === 'buy' ? 'sell' : 'buy';
      if (flowCooldown(f, 'ABS' + passive, 120000)) emitFlowEvent(market, 'ABSORPTION', passive, domUsd, price, { taker: dom });
    }
    f.absorb.delete(key);
  }
  if (f.absorb.size > 200) f.absorb.clear();
}
function detectSweep(market, price) {
  const f = market.flow; const now = Date.now();
  if (f.swingHigh == null || f.swingLow == null) return;
  if (!f.armedUp && price > f.swingHigh) f.armedUp = now;
  if (f.armedUp && price < f.swingHigh) {
    if (now - f.armedUp <= 180000 && flowCooldown(f, 'SWEEPsell', 120000)) emitFlowEvent(market, 'SWEEP', 'sell', 0, f.swingHigh, { grab: 'above' });
    f.armedUp = null;
  }
  if (!f.armedDn && price < f.swingLow) f.armedDn = now;
  if (f.armedDn && price > f.swingLow) {
    if (now - f.armedDn <= 180000 && flowCooldown(f, 'SWEEPbuy', 120000)) emitFlowEvent(market, 'SWEEP', 'buy', 0, f.swingLow, { grab: 'below' });
    f.armedDn = null;
  }
}
function detectHerd(market) {
  const f = market.flow; const r = f.cls.retail; const tot = r.buy + r.sell;
  if (tot < 100000) return;
  const side = r.buy > r.sell ? 'buy' : 'sell';
  const share = Math.max(r.buy, r.sell) / tot;
  if (share >= 0.7) {
    f.herd = { side, share, until: Date.now() + 300000 };
    if (flowCooldown(f, 'HERD' + side, 300000)) emitFlowEvent(market, 'RETAIL_HERD', side, tot, market.pulse.lastPrice || 0, { share: round2(share) });
    const sm = f.recentSmart;
    if (sm && Date.now() - sm.ts < 300000 && sm.side !== side && flowCooldown(f, 'TRAP', 300000)) {
      const action = sm.side === 'buy' ? 'ACCUMULATING (buying)' : 'DISTRIBUTING (selling)';
      emitFlowEvent(market, 'TRAP', side, 0, market.pulse.lastPrice || 0, { smartSide: sm.side, action, text: `Big money trapping ${side.toUpperCase()} retailers (herd ${(share * 100).toFixed(0)}%) while ${action}. Avoid ${side} side.` });
    }
  }
}
function flowStatePayload(market) {
  const f = market.flow;
  return { cls: f.cls, pct: f.pct, herd: f.herd, trap: f.trap, studyTrades: f.studyTrades, recentSmart: f.recentSmart };
}
// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
async function saveWhaleEventToDB(symbol, time, price, phase, rSell, smBuy) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/whale_events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ symbol: symbol.toUpperCase(), timestamp_ms: time, price, phase, retail_amount: rSell, whale_amount: smBuy }),
    });
  } catch (e) { console.error('DB Save Error:', e); }
}
function savePulseSnapshot(market, bucketStart, close, volume, cvd, oi) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  if (!(close > 0) || !(volume > 0)) return; // zero-price / empty-bucket guard
  fetch(`${SUPABASE_URL}/rest/v1/market_pulse_5m`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
    body: JSON.stringify([{
      symbol: market.symbol.toUpperCase(), timestamp_ms: bucketStart,
      price_close: round2(close), volume: round2(volume), cvd: round2(cvd), open_interest: round2(oi || 0),
    }]),
  }).catch(e => console.error('Pulse 5m Save Error:', e.message));
}
async function seedPulseBucketsFromDB(market) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    const since = Date.now() - MAX_PULSE_BUCKETS * PULSE_BUCKET_MS;
    const snaps = await fetch(`${SUPABASE_URL}/rest/v1/market_pulse_5m?symbol=eq.${market.symbol.toUpperCase()}&timestamp_ms=gte.${since}&order=timestamp_ms.asc`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
    }).then(r => r.json());
    if (Array.isArray(snaps)) {
      market.pulse.buckets = snaps.map(s => ({ time: s.timestamp_ms, close: s.price_close, volume: s.volume, cvd: s.cvd, oi: s.open_interest })).filter(b => b.close > 0);
    }
  } catch (e) { /* memory-only fallback */ }
}
app.get('/api/whale-history', async (req, res) => {
  const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.json([]);
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/whale_events?symbol=eq.${symbol}&order=timestamp_ms.desc&limit=500`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
    });
    const data = await response.json();
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/whale-walls', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.json([]);
  try {
    const oneMinAgo = Date.now() - (60 * 1000);
    const wallSymbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const response = await fetch(`${SUPABASE_URL}/rest/v1/whale_walls?symbol=eq.${wallSymbol}&total_value_usd=gte.10000000&timestamp_ms=gte.${oneMinAgo}&order=total_value_usd.desc`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
    });
    const data = response.ok ? await response.json() : [];
    const walls = data || [];
    const filteredWalls = [];
    for (const w of walls) {
      if (filteredWalls.length >= 5) break;
      if (!filteredWalls.some(fw => Math.abs(parseFloat(fw.price) - parseFloat(w.price)) < 100)) filteredWalls.push(w);
    }
    res.json(filteredWalls);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/wakeup', async (req, res) => {
  const symbol = (req.body?.symbol || DEFAULT_SYMBOL).toLowerCase();
  try { const result = await wakeUp(symbol); res.json({ ok: true, ...result }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post('/api/wakeup-liquidity', (req, res) => {
  const symbol = (req.body?.symbol || DEFAULT_SYMBOL).toLowerCase();
  wakeLiquidity(getOrCreateMarket(symbol));
  res.json({ ok: true, symbol });
});
app.get('/api/wakeup-liquidity', (req, res) => {
  const symbol = (req.query.symbol || DEFAULT_SYMBOL).toLowerCase();
  wakeLiquidity(getOrCreateMarket(symbol));
  res.json({ ok: true, symbol });
});
app.get('/api/status', (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toLowerCase() : null;
  if (symbol) {
    const market = markets.get(symbol);
    return res.json(market ? {
      symbol, awake: market.awake, candleCount: market.candles.length, footprintCandleCount: market.footprintHistory.length,
      lastActivity: market.lastActivity, idleForMs: market.lastActivity ? Date.now() - market.lastActivity : null, connectedClients: market.clients.size,
    } : { symbol, awake: false, candleCount: 0, footprintCandleCount: 0, connectedClients: 0 });
  }
  const summary = [...markets.values()].map((m) => ({ symbol: m.symbol, awake: m.awake, connectedClients: m.clients.size }));
  res.json({ totalMarkets: markets.size, awakeMarkets: countAwakeMarkets(), totalConnectedClients: summary.reduce((s, m) => s + m.connectedClients, 0), markets: summary });
});
app.get('/api/liquidity-status', (req, res) => {
  const symbol = (req.query.symbol || DEFAULT_SYMBOL).toLowerCase();
  const market = markets.get(symbol);
  if (!market) return res.json({ symbol, awake: false, bidCount: 0, askCount: 0 });
  res.json({
    symbol, awake: market.liquidity.awake, lastUpdateTime: market.liquidity.lastUpdateTime,
    ageMs: market.liquidity.lastUpdateTime ? Date.now() - market.liquidity.lastUpdateTime : null, connectedClients: market.liquidity.clients.size,
    bidCount: market.liquidity.bids.length, askCount: market.liquidity.asks.length, topBids: market.liquidity.bids.slice(0, 5), topAsks: market.liquidity.asks.slice(0, 5),
  });
});
// ---------------------------------------------------------------------------
// PROFILE FOLDING + CLUSTERING (single source of truth for POC/HVN)
// ---------------------------------------------------------------------------
function foldProfile(market, sinceMs) {
  const prof = new Map();
  const add = (levels) => {
    for (const k in (levels || {})) {
      const L = levels[k];
      const tot = L.spot.buy + L.spot.sell + L.perp.buy + L.perp.sell;
      if (tot > 0) prof.set(k, (prof.get(k) || 0) + tot);
    }
  };
  const firstTime = market.footprintHistory.length ? market.footprintHistory[0].time : Infinity;
  let approx = false;
  if (sinceMs >= firstTime) {
    for (const c of market.footprintHistory) if (c.time + 60000 > sinceMs) add(c.levels);
    add(market.liveFootprint.levels);
  } else {
    approx = true;
    const hourStart = Math.floor(Date.now() / 3600000) * 3600000;
    for (const h of market.hourlyRollup) if (h.time < hourStart && h.time + 3600000 > sinceMs) add(h.levels);
    for (const c of market.footprintHistory) if (c.time >= hourStart && c.time + 60000 > sinceMs) add(c.levels);
    add(market.liveFootprint.levels);
  }
  return { prof, approx };
}
function clusterProfile(prof, gapPct = 0.0004) {
  const arr = [...prof.entries()].map(([p, v]) => ({ price: parseFloat(p), vol: v })).sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const item of arr) {
    const last = clusters[clusters.length - 1];
    if (last && (item.price - last.lastPrice) <= item.price * gapPct) {
      last.vol += item.vol; last.sum += item.price * item.vol; last.lastPrice = item.price;
    } else {
      clusters.push({ vol: item.vol, sum: item.price * item.vol, lastPrice: item.price });
    }
  }
  clusters.forEach((c) => { c.price = c.sum / c.vol; });
  clusters.sort((a, b) => b.vol - a.vol);
  return clusters;
}
// ---------------------------------------------------------------------------
// PULSE AI ENDPOINT
// ---------------------------------------------------------------------------
app.get('/api/pulse-ai', async (req, res) => {
  const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
  const tf = req.query.tf || '1h';
  const tfMs = { '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 }[tf] || 3600000;
  const now = Date.now();
  const market = markets.get(symbol.toLowerCase());
  let buckets = [];
  if (market && market.awake) {
    const p = market.pulse;
    buckets = p.buckets.filter((b) => b.time >= now - tfMs);
    if (p.lastPrice > 0) buckets.push({ time: p.bucketStart ?? now, close: p.lastPrice, volume: p.bucketVolume, cvd: p.bucketCvd, oi: p.oi });
  }
  let pocSource = 'profile';
  if (buckets.length < 2 && SUPABASE_URL && SUPABASE_KEY) {
    try {
      const snaps = await fetch(`${SUPABASE_URL}/rest/v1/market_pulse_5m?symbol=eq.${symbol}&timestamp_ms=gte.${now - tfMs}&order=timestamp_ms.asc`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      }).then(r => r.json());
      if (snaps && snaps.length >= 2) buckets = snaps.map(s => ({ time: s.timestamp_ms, close: s.price_close, volume: s.volume, cvd: s.cvd, oi: s.open_interest }));
      pocSource = 'db-approx';
    } catch (e) { /* fall through */ }
  }
  if (buckets.length < 2) return res.json({ waiting: true, message: 'Accumulating rolling data...' });
  const valid = buckets.filter(b => b.close > 0);
  if (valid.length < 2) return res.json({ waiting: true, message: 'Accumulating rolling data...' });
  const past = valid[0];
  const current = valid[valid.length - 1];
  const priceDelta = current.close - past.close;
  const oiDelta = (current.oi || 0) - (past.oi || 0);
  const cvdDelta = valid.reduce((s, b) => s + (b.cvd || 0), 0);
  let poc = current.close;
  let clusters = [];
  let approx = true;
  if (market && market.awake) {
    const folded = foldProfile(market, now - tfMs);
    clusters = clusterProfile(folded.prof);
    approx = folded.approx;
    if (clusters.length) poc = clusters[0].price;
  }
  if (!clusters.length && pocSource === 'db-approx') {
    let maxVol = 0;
    valid.forEach(s => { if ((s.volume || 0) > maxVol) { maxVol = s.volume; poc = s.close; } });
  }
  pocSource = clusters.length ? (approx ? 'profile-approx' : 'profile') : 'db-approx';
  let verdict = 'Neutral Chop Zone';
  let type = 'neutral';
  if (priceDelta > 0) {
    if (oiDelta > 0 && cvdDelta > 0) { verdict = '🟢 REAL UP: Fresh Longs. Safe to ride.'; type = 'real'; }
    else if (oiDelta < 0) { verdict = '⚠️ FAKE UP (TRAP): Short Squeeze. Reversal likely.'; type = 'trap'; }
    else if (oiDelta > 0 && cvdDelta <= 0) { verdict = '🛑 FAKE UP: Absorption. Heavy Limit Selling at Top.'; type = 'trap'; }
  } else if (priceDelta < 0) {
    if (oiDelta > 0 && cvdDelta < 0) { verdict = '🔴 REAL DOWN: Fresh Shorts. Safe to drop.'; type = 'real'; }
    else if (oiDelta < 0) { verdict = '⚠️ FAKE DOWN (TRAP): Long Liquidation. Prepare for bounce.'; type = 'trap'; }
    else if (oiDelta > 0 && cvdDelta >= 0) { verdict = '🛑 FAKE DOWN: Absorption. Heavy Limit Buying at Bottom.'; type = 'trap'; }
  }
  let bias = priceDelta > 0 ? 'bull' : priceDelta < 0 ? 'bear' : 'neutral';
  const pricePct = past.close > 0 ? (priceDelta / past.close) * 100 : 0;
  if (pricePct > 0.8 && cvdDelta > 0) {
    verdict = 'Massive Pump: The market is rising fast with heavy buying volume. It is very risky to sell right now.';
    type = 'real'; bias = 'bull';
  } else if (pricePct < -0.8 && cvdDelta < 0) {
    verdict = 'Severe Dump: The market is falling heavily with strong selling pressure. It is very risky to buy right now.';
    type = 'real'; bias = 'bear';
  } else if (verdict.includes('FAKE DOWN')) {
    verdict = 'Fake Downward Move: Sellers are being trapped. The price is likely to bounce back up soon.'; bias = 'bull';
  } else if (verdict.includes('FAKE UP')) {
    verdict = 'Fake Upward Move: Buyers are being trapped. The price is likely to drop back down soon.'; bias = 'bear';
  } else if (verdict.includes('REAL UP')) {
    verdict = 'Real Upward Trend: Strong and healthy buying volume. The upward movement is safe to trust.'; bias = 'bull';
  } else if (verdict.includes('REAL DOWN')) {
    verdict = 'Real Downward Trend: Strong and consistent selling. The downward movement is safe to trust.'; bias = 'bear';
  }
  if (market) { market.pulse.verdict = verdict; market.pulse.verdictType = type; market.pulse.bias = bias; }
  const livePrice = market && market.pulse.lastPrice > 0 ? market.pulse.lastPrice : current.close;
  res.json({
    tf,
    poc: round2(poc),
    top5Poc: clusters.slice(0, 5).map(c => ({ price: round2(c.price), vol: round2(c.vol) })),
    hvn: clusters.slice(1, 4).map((c, i) => ({ rank: i + 1, price: round2(c.price), vol: round2(c.vol) })),
    lastPrice: round2(livePrice),
    oi: round2(market ? market.pulse.oi : current.oi || 0),
    oiDelta: round2(oiDelta),
    cvd: round2(market ? market.pulse.bucketCvd : current.cvd || 0),
    cvdDelta: round2(cvdDelta),
    verdict, type, bias, pocSource,
    distanceToPoc: livePrice > 0 ? round2(livePrice - poc) : null,
  });
});
function saveFlowClass5m(market, bucketStart) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !market.flow) return;
  const f = market.flow; const c = f.cls;
  fetch(`${SUPABASE_URL}/rest/v1/flow_class_5m`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'resolution=merge-duplicates' }, body: JSON.stringify([{ symbol: market.symbol.toUpperCase(), ts: bucketStart, retail_cvd: round2(c.retail.buy - c.retail.sell), pro_cvd: round2(c.pro.buy - c.pro.sell), whale_cvd: round2(c.whale.buy - c.whale.sell), retail_share: round2((c.retail.buy + c.retail.sell) > 0 ? Math.max(c.retail.buy, c.retail.sell) / (c.retail.buy + c.retail.sell) : 0.5), herd_side: f.herd && f.herd.until > Date.now() ? f.herd.side : null, trap: !!(f.trap && Date.now() - f.trap.ts < 300000) }]) }).catch(e => console.error('flow 5m save:', e.message));
}
app.get('/api/flow-events', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.json([]);
  const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
  const since = Number(req.query.since || Date.now() - 86400000);
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/flow_events?symbol=eq.${symbol}&ts=gte.${since}&order=ts.asc&limit=1000`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    res.json(r.ok ? await r.json() : []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/flow-summary', (req, res) => {
  const market = markets.get((req.query.symbol || 'btcusdt').toLowerCase());
  if (!market || !market.flow) return res.json({ waiting: true });
  res.json(flowStatePayload(market));
});
// ---------------------------------------------------------------------------
// WS SERVERS
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
function sendSnapshot(ws, market) {
  ws.send(JSON.stringify({
    type: 'snapshot', symbol: market.symbol, candles: market.candles, footprintHistory: market.footprintHistory,
    liveFootprint: market.liveFootprint, hourlyRollup: market.hourlyRollup,
  }));
}
async function attachToMarket(ws, symbol) {
  const market = getOrCreateMarket(symbol);
  touchActivity(market);
  market.clients.add(ws);
  ws.symbol = symbol;
  if (!market.awake) await wakeUp(symbol).catch(() => {});
  sendSnapshot(ws, market);
}
function detachFromMarket(ws) {
  if (!ws.symbol) return;
  const market = markets.get(ws.symbol);
  if (!market) return;
  market.clients.delete(ws);
  touchActivity(market);
}
wss.on('connection', (ws, req) => {
  const reqUrl = new URL(req.url, 'http://localhost');
  const symbol = (reqUrl.searchParams.get('symbol') || DEFAULT_SYMBOL).toLowerCase();
  attachToMarket(ws, symbol);
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg && msg.type === 'subscribe' && typeof msg.symbol === 'string') {
      const newSymbol = msg.symbol.toLowerCase();
      if (newSymbol !== ws.symbol) { detachFromMarket(ws); attachToMarket(ws, newSymbol); }
      return;
    }
    if (ws.symbol) { const market = markets.get(ws.symbol); if (market) touchActivity(market); }
  });
  ws.on('close', () => detachFromMarket(ws));
});
const wssLiquidity = new WebSocket.Server({ noServer: true });
function sendLiquiditySnapshot(ws, market) {
  ws.send(JSON.stringify({ type: 'snapshot', symbol: market.symbol, bids: market.liquidity.bids, asks: market.liquidity.asks, time: market.liquidity.lastUpdateTime }));
}
function attachToLiquidity(ws, symbol) {
  const market = getOrCreateMarket(symbol);
  market.liquidity.lastActivity = Date.now();
  market.liquidity.clients.add(ws);
  ws.liqSymbol = symbol;
  if (!market.liquidity.awake) wakeLiquidity(market);
  sendLiquiditySnapshot(ws, market);
}
function detachFromLiquidity(ws) {
  if (!ws.liqSymbol) return;
  const market = markets.get(ws.liqSymbol);
  if (!market) return;
  market.liquidity.clients.delete(ws);
  market.liquidity.lastActivity = Date.now();
}
wssLiquidity.on('connection', (ws, req) => {
  const reqUrl = new URL(req.url, 'http://localhost');
  const symbol = (reqUrl.searchParams.get('symbol') || DEFAULT_SYMBOL).toLowerCase();
  attachToLiquidity(ws, symbol);
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg && msg.type === 'subscribe' && typeof msg.symbol === 'string') {
      const newSymbol = msg.symbol.toLowerCase();
      if (newSymbol !== ws.liqSymbol) { detachFromLiquidity(ws); attachToLiquidity(ws, newSymbol); }
    }
  });
  ws.on('close', () => detachFromLiquidity(ws));
});
function broadcastToMarket(market, payload) {
  if (!market.clients.size) return;
  const msg = JSON.stringify(payload);
  market.clients.forEach((client) => { if (client.readyState === WebSocket.OPEN) client.send(msg); });
}
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/ws/footprint') wss.handleUpgrade(request, socket, head, (ws) => { wss.emit('connection', ws, request); });
  else if (pathname === '/ws/liquidity') wssLiquidity.handleUpgrade(request, socket, head, (ws) => { wssLiquidity.emit('connection', ws, request); });
  else socket.destroy();
});
// ---------------------------------------------------------------------------
// DEEP LIQUIDITY & WHALE WALL TRACKER (clustered, with lifecycle)
// ---------------------------------------------------------------------------
let deepLiquidityCache = { bids: [], asks: [] };
function clusterDepthWalls(orders, side, minWallUsd) {
  const walls = [];
  let acc = 0, sum = 0, levels = 0;
  for (const [p, q] of orders) {
    const price = parseFloat(p);
    const notional = price * parseFloat(q);
    if (!isFinite(notional)) continue;
    acc += notional; sum += price * notional; levels += 1;
    if (acc >= minWallUsd) {
      walls.push({ price: sum / acc, total: acc, side, levels });
      acc = 0; sum = 0; levels = 0;
    }
  }
  // Display cap: sirf top 8 walls per side - 1000-level book se
  // 100+ lines ban ke chart spaghetti ho jaata tha.
  walls.sort((a, b) => b.total - a.total);
  return walls.slice(0, 8);
}
async function fetchDeepLiquidity(symbol) {
  let anyLiquidityClient = false;
  for (const m of markets.values()) if (m.liquidity.awake) { anyLiquidityClient = true; break; }
  if (!anyLiquidityClient) return; // don't waste rate limits when nobody is watching
  try {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol.toUpperCase()}&limit=1000`);
    if (!res.ok) return;
    const data = await res.json();
    const bidWalls = clusterDepthWalls(data.bids || [], 'BUY', LIQ_WALL_MIN);
    const askWalls = clusterDepthWalls(data.asks || [], 'SELL', LIQ_WALL_MIN);
    deepLiquidityCache.bids = bidWalls;
    deepLiquidityCache.asks = askWalls;
    const msg = JSON.stringify({ type: 'liquidity_map', bids: bidWalls, asks: askWalls });
    if (wssLiquidity.clients) {
      wssLiquidity.clients.forEach(client => { if (client.readyState === 1) client.send(msg); });
    }
    if (SUPABASE_URL && SUPABASE_KEY) persistWhaleWalls(symbol, bidWalls.concat(askWalls));
  } catch (err) { console.error('[Liquidity Engine] Error:', err.message); }
}
function persistWhaleWalls(symbol, walls) {
  const key = symbol.toUpperCase();
  const mem = wallMemory.get(key) || [];
  const now = Date.now();
  const matched = new Set();
  const inserts = [];
  for (const w of walls) {
    if (w.total < WHALE_WALL_THRESHOLD) continue;
    const prevIdx = mem.findIndex(m => m.side === w.side && Math.abs(m.price - w.price) <= w.price * 0.0005);
    if (prevIdx === -1) {
      inserts.push(w);
      mem.push({ side: w.side, price: w.price, total: w.total, lastInsertMs: now });
      matched.add(mem.length - 1);
    } else {
      const prev = mem[prevIdx];
      const changed = Math.abs(w.total - prev.total) / Math.max(prev.total, 1) >= WALL_CHANGE_PCT;
      const heartbeat = now - prev.lastInsertMs >= WALL_HEARTBEAT_MS;
      if (changed || heartbeat) inserts.push(w);
      prev.price = w.price; prev.total = w.total; prev.lastInsertMs = now;
      matched.add(prevIdx);
    }
  }
  for (let i = mem.length - 1; i >= 0; i--) if (!matched.has(i)) mem.splice(i, 1);
  wallMemory.set(key, mem);
  if (!inserts.length) return;
  fetch(`${SUPABASE_URL}/rest/v1/whale_walls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
    body: JSON.stringify(inserts.map(w => ({
      symbol: key, timestamp_ms: now, side: w.side, price: round2(w.price), total_value_usd: round2(w.total),
    }))),
  }).catch(e => console.error('Wall Save Error:', e.message));
}
setInterval(() => fetchDeepLiquidity('BTCUSDT'), 15000);
// ----------------------------------------------------------
// PULSE ENGINE (per-market, 10s cadence, 5m bucket rolls)
// ----------------------------------------------------------
setInterval(async () => {
  const now = Date.now();
  for (const market of markets.values()) {
    if (!market.awake) continue;
    const p = market.pulse;
    try {
      const oiRes = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${market.symbol.toUpperCase()}`);
      const oiData = await oiRes.json();
      const currentOI = oiData?.result?.list?.[0]?.openInterest ? parseFloat(oiData.result.list[0].openInterest) : 0;
      if (currentOI > 0) { p.oi = currentOI; p.oiUpdatedAt = now; }
    } catch (e) { /* keep last OI */ }
    const curBucket = Math.floor(now / PULSE_BUCKET_MS) * PULSE_BUCKET_MS;
    if (p.bucketStart == null) p.bucketStart = curBucket;
    if (curBucket > p.bucketStart) {
      savePulseSnapshot(market, p.bucketStart, p.lastPrice, p.bucketVolume, p.bucketCvd, p.oi);
      if (p.lastPrice > 0 && p.bucketVolume > 0) {
        p.buckets.push({ time: p.bucketStart, close: p.lastPrice, volume: p.bucketVolume, cvd: p.bucketCvd, oi: p.oi });
        if (p.buckets.length > MAX_PULSE_BUCKETS) p.buckets.shift();
      }
      if (market.flow) { saveFlowClass5m(market, p.bucketStart); recalibrateFlow(market); market.flow.cls = { retail: { buy: 0, sell: 0 }, pro: { buy: 0, sell: 0 }, whale: { buy: 0, sell: 0 } }; }
      p.bucketStart = curBucket; p.bucketVolume = 0; p.bucketCvd = 0;
    }
    broadcastToMarket(market, {
      type: 'pulse',
      data: { lastPrice: p.lastPrice, cvd: p.bucketCvd, oi: p.oi, verdict: p.verdict, verdictType: p.verdictType, bias: p.bias, oiUpdatedAt: p.oiUpdatedAt },
    });
    if (market.flow) broadcastToMarket(market, { type: 'flow_state', data: flowStatePayload(market) });
  }
}, 10000);
// ----------------------------------------------------------
// SHUTDOWN
// ----------------------------------------------------------
function shutdown() {
  console.log('[system] shutting down...');
  for (const market of markets.values()) { sleep(market); sleepLiquidity(market); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
app.get('/', (req, res) => res.json({ ok: true, service: 'edgetrade-backend' }));
app.get('/healthz', (req, res) => res.json({ ok: true }));
server.listen(PORT, '0.0.0.0', () => { console.log(`[system] EdgeTrade backend listening on port ${PORT}`); });
