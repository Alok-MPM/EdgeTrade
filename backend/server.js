/**
 * EdgeTrade — Isolated Backend (server.js)
 * -----------------------------------------
 * Cold-Start / Zero-Latency Footprint Engine — MULTI-SYMBOL & DYNAMIC OFFSET
 */

const express = require('express');
require('dotenv').config();
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const { URL } = require('url');

// --- MARKET PULSE MEMORY ---
let marketPulse = { cvd: 0, oi: 0, poc: 0, profile: {}, lastPrice: 0, narrative: "Syncing data...", verdict: "Neutral" };

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

const BINANCE_REST_KLINES = (symbol, interval, limit) =>
  `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`;

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

function makeEmptyFootprintCandle(time) {
  return {
    time: time != null ? time : null,
    open: null, high: null, low: null, close: null, volume: 0, levels: {},
  };
}

function createMarket(symbol) {
  return {
    symbol, awake: false, lastActivity: 0,
    masterPrices: { delta: null, binance: null, bybit: null }, // SPREAD TRACKER
    whaleTracker: { retailBuy: 0, retailSell: 0, smBuy: 0, smSell: 0, openPrice: null, currentPhase: 0 },
    candles: [], footprintHistory: [], liveFootprint: makeEmptyFootprintCandle(), hourlyRollup: [],
    sockets: { binance: null, bybit: null, delta: null },
    reconnectTimers: { binance: null, bybit: null, delta: null },
    clients: new Set(),
    liquidity: {
      bids: [], asks: [], lastUpdateTime: null, awake: false, lastActivity: 0,
      socket: null, reconnectTimer: null, clients: new Set(),
    },
  };
}

function getOrCreateMarket(symbol) {
  let market = markets.get(symbol);
  if (!market) { market = createMarket(symbol); markets.set(symbol, market); }
  return market;
}

function touchActivity(market) {
  market.lastActivity = Date.now();
}

function bucketPrice(price) {
  const p = Number(price);
  if (p >= 1000) return Math.round(p).toString();        
  if (p >= 10) return (Math.round(p * 10) / 10).toString(); 
  return (Math.round(p * 10000) / 10000).toString();      
}

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
        ? `https://api.binance.com/api/v3/aggTrades?symbol=${market.symbol.toUpperCase()}&startTime=${startTime}&endTime=${endTime}&limit=1000`
        : `https://api.binance.com/api/v3/aggTrades?symbol=${market.symbol.toUpperCase()}&fromId=${fromId + 1}&limit=1000`;
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
  if (built.length && built[built.length - 1].time === currentOpenTime) {
    market.liveFootprint = built.pop();
  }
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
    ws.send(JSON.stringify({
      type: 'subscribe', payload: { channels: [{ name: 'v2/ticker', symbols: [deltaSymbol] }] }
    }));
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'v2/ticker' && msg.mark_price) {
      market.masterPrices.delta = parseFloat(msg.mark_price);
    }
  });

  ws.on('close', () => {
    if (market.awake) market.reconnectTimers.delta = setTimeout(() => connectDelta(market), RECONNECT_DELAY_MS);
  });
  ws.on('error', () => ws.close());
}

function connectBinance(market) {
  clearTimeout(market.reconnectTimers.binance);
  const ws = new WebSocket(BINANCE_WS_URL(market.symbol));
  market.sockets.binance = ws;

  ws.on('open', () => console.log(`[binance] connected (${market.symbol})`));
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const payload = msg.data;
    if (!payload) return;

    if (payload.e === 'trade') {
      handleTradeTick(market, { price: payload.p, qty: payload.q, isBuyerMaker: payload.m, time: payload.T, exchange: 'binance', source: 'spot' });
    } else if (payload.e === 'kline') {
      market.masterPrices.binance = parseFloat(payload.k.c);
      handleKlineUpdate(market, payload.k);
    }
  });

  ws.on('close', () => {
    if (market.awake) market.reconnectTimers.binance = setTimeout(() => connectBinance(market), RECONNECT_DELAY_MS);
  });
  ws.on('error', () => ws.close());
}

function connectBybit(market) {
  clearTimeout(market.reconnectTimers.bybit);
  const ws = new WebSocket(BYBIT_WS_URL);
  market.sockets.bybit = ws;
  const bybitSymbol = market.symbol.toUpperCase();

  ws.on('open', () => {
    ws.send(JSON.stringify({ op: 'subscribe', args: [`publicTrade.${bybitSymbol}`] }));
    ws.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'ping' }));
    }, 20000);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
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
function connectLiquidityDepth(market) {
  clearTimeout(market.liquidity.reconnectTimer);
  const ws = new WebSocket(BINANCE_WS_DEPTH_URL(market.symbol));
  market.liquidity.socket = ws;

  ws.on('open', () => console.log(`[liquidity] connected (${market.symbol})`));
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(msg.bids) || !Array.isArray(msg.asks)) return;

    let offset = 0;
    if (market.masterPrices.delta && market.masterPrices.binance) {
        offset = market.masterPrices.binance - market.masterPrices.delta;
    }

    market.liquidity.bids = msg.bids.map(([price, qty]) => ({ price: parseFloat(price) - offset, qty: parseFloat(qty) }));
    market.liquidity.asks = msg.asks.map(([price, qty]) => ({ price: parseFloat(price) - offset, qty: parseFloat(qty) }));
    market.liquidity.lastUpdateTime = Date.now();

    broadcastToLiquidityClients(market, { type: 'depth', bids: market.liquidity.bids, asks: market.liquidity.asks, time: market.liquidity.lastUpdateTime });
  });

  ws.on('close', () => {
    if (market.liquidity.awake) market.liquidity.reconnectTimer = setTimeout(() => connectLiquidityDepth(market), RECONNECT_DELAY_MS);
  });
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
  market.liquidity.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

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

// THE DYNAMIC SPREAD CALCULATOR APPLIED TO TRADES
function handleTradeTick(market, { price, qty, isBuyerMaker, time, exchange, source }) {
  touchActivity(market); 
    const p = parseFloat(price);
    const q = parseFloat(qty);
    marketPulse.lastPrice = p;
    marketPulse.cvd += isBuyerMaker ? -q : q;
    const pulseBucket = Math.round(p / 10) * 10;
    marketPulse.profile[pulseBucket] = (marketPulse.profile[pulseBucket] || 0) + q;


  const candleOpenTime = Math.floor(time / 60000) * 60000;
  if (!ensureLiveFootprintCandle(market, candleOpenTime)) return; 

  let adjustedPrice = parseFloat(price);
  if (market.masterPrices.delta && market.masterPrices[exchange]) {
      const offset = market.masterPrices[exchange] - market.masterPrices.delta;
      adjustedPrice = adjustedPrice - offset;
  }

  // --- END WHALE ABSORPTION TRACKER ---

  const bucket = bucketPrice(adjustedPrice);
  const level = market.liveFootprint.levels[bucket] || { spot: { buy: 0, sell: 0, trades: 0 }, perp: { buy: 0, sell: 0, trades: 0 } };
  const side = level[source]; 

  if (isBuyerMaker) side.sell += parseFloat(qty); else side.buy += parseFloat(qty);
  side.trades += 1;
  market.liveFootprint.levels[bucket] = level;
  market.liveFootprint.volume += parseFloat(qty);

  broadcastToMarket(market, { type: 'tick', price: adjustedPrice, qty: parseFloat(qty), side: isBuyerMaker ? 'sell' : 'buy', source, time });
}

function handleKlineUpdate(market, k) {
  const candle = { time: k.t, open: parseFloat(k.o), high: parseFloat(k.h), low: parseFloat(k.l), close: parseFloat(k.c), volume: parseFloat(k.v) };
  if (market.candles.length && market.candles[market.candles.length - 1].time === candle.time) {
    market.candles[market.candles.length - 1] = candle;
  } else {
    market.candles.push(candle);
    if (market.candles.length > MAX_CANDLE_HISTORY) market.candles.shift();
  }

  const rotated = ensureLiveFootprintCandle(market, k.t);
  if (rotated) {
    market.liveFootprint.open = candle.open; market.liveFootprint.high = candle.high; market.liveFootprint.low = candle.low; market.liveFootprint.close = candle.close;
  }
}

async function wakeUp(symbol) {
  const market = getOrCreateMarket(symbol);
  touchActivity(market);

  if (market.awake) return { alreadyAwake: true, symbol };
  if (countAwakeMarkets() >= MAX_AWAKE_MARKETS) return { alreadyAwake: false, symbol, error: 'server_at_capacity', candleCount: 0 };

  market.awake = true;
  try { market.candles = await fetchInitialCandles(symbol); } catch (err) { market.candles = []; }

  market.footprintHistory = [];
  market.liveFootprint = makeEmptyFootprintCandle();
  await backfillFootprintHistory(market); 

  connectDelta(market); // WAKE MASTER ANCHOR
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
      body: JSON.stringify({ symbol: symbol.toUpperCase(), timestamp_ms: time, price, phase, retail_amount: rSell, whale_amount: smBuy })
    });
  } catch (e) { console.error('DB Save Error:', e); }
}

app.get('/api/whale-history', async (req, res) => {
  const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.json([]);
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/whale_events?symbol=eq.${symbol}&order=timestamp_ms.desc&limit=500`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const data = await response.json();
    res.json(data || []);
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.get('/api/whale-walls', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.json([]);
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/whale_walls?total_value_usd=gte.10000000&order=total_value_usd.desc&limit=20`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const data = await response.json();
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.post('/api/wakeup', async (req, res) => {
  const symbol = (req.body?.symbol || DEFAULT_SYMBOL).toLowerCase();
  try { const result = await wakeUp(symbol); res.json({ ok: true, ...result }); } 
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/wakeup-liquidity', (req, res) => {
  const symbol = (req.body?.symbol || DEFAULT_SYMBOL).toLowerCase();
  const market = getOrCreateMarket(symbol);
  wakeLiquidity(market);
  res.json({ ok: true, symbol });
});

app.get('/api/wakeup-liquidity', (req, res) => {
  const symbol = (req.query.symbol || DEFAULT_SYMBOL).toLowerCase();
  const market = getOrCreateMarket(symbol);
  wakeLiquidity(market);
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
  res.json({ totalMarkets: markets.size, awakeMarkets: countAwakeMarkets(), totalConnectedClients: summary.reduce((sum, m) => sum + m.connectedClients, 0), markets: summary });
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

  app.get('/api/pulse-ai', async (req, res) => {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const tf = req.query.tf || '1h'; // default 1 hour
    
    // Timeframe to milliseconds
    const tfMs = { '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 }[tf] || 3600000;
    const now = Date.now();
    
    if (!SUPABASE_URL || !SUPABASE_KEY) return res.json({ error: 'Database not connected' });

    try {
      const snaps = await fetch(`${SUPABASE_URL}/rest/v1/market_pulse_5m?symbol=eq.${symbol}&timestamp_ms=gte.${now - tfMs}&order=timestamp_ms.asc`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      }).then(r => r.json());

      if (!snaps || snaps.length < 2) return res.json({ waiting: true, message: "Accumulating rolling data..." });

      const past = snaps[0];
      const current = snaps[snaps.length - 1];

      const priceDelta = current.price_close - past.price_close;
      const oiDelta = current.open_interest - past.open_interest;
      const cvdDelta = current.cvd - past.cvd;

      // POC (Magnet) Calculation for this timeframe
      let maxVol = 0;
      let poc = current.price_close;
      snaps.forEach(s => { if (s.volume > maxVol) { maxVol = s.volume; poc = s.price_close; } });

      // Institutional Trap Logic Engine
      let verdict = "Neutral Chop Zone";
      let type = "neutral";

      if (priceDelta > 0) {
        if (oiDelta > 0 && cvdDelta > 0) { verdict = "🟢 REAL UP: Fresh Longs. Safe to ride."; type = "real"; }
        else if (oiDelta < 0) { verdict = "⚠️ FAKE UP (TRAP): Short Squeeze. Reversal likely."; type = "trap"; }
        else if (oiDelta > 0 && cvdDelta <= 0) { verdict = "🛑 FAKE UP: Absorption. Heavy Limit Selling at Top."; type = "trap"; }
      } else if (priceDelta < 0) {
        if (oiDelta > 0 && cvdDelta < 0) { verdict = "🔴 REAL DOWN: Fresh Shorts. Safe to drop."; type = "real"; }
        else if (oiDelta < 0) { verdict = "⚠️ FAKE DOWN (TRAP): Long Liquidation. Prepare for bounce."; type = "trap"; }
        else if (oiDelta > 0 && cvdDelta >= 0) { verdict = "🛑 FAKE DOWN: Absorption. Heavy Limit Buying at Bottom."; type = "trap"; }
      }

      const profileArr = Object.entries(marketPulse.profile || {}).map(([p, v]) => ({ price: parseFloat(p), vol: v }));
      profileArr.sort((a, b) => b.vol - a.vol);
      const top5Poc = [];
      for (const item of profileArr) {
        if (top5Poc.length >= 3) break;
        if (!top5Poc.some(poc => Math.abs(poc - item.price) < 50)) {
          top5Poc.push(item.price);
        }
      }

      res.json({ 
        tf, 
        poc, 
        top5Poc,
        lastPrice: marketPulse.lastPrice,
        oiDelta: oiDelta.toFixed(2), 
        cvdDelta: cvdDelta.toFixed(2), 
        verdict, 
        type,
        distanceToPoc: (current.price_close - poc).toFixed(2) 
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

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
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
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
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
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
  if (pathname === '/ws/footprint') { wss.handleUpgrade(request, socket, head, (ws) => { wss.emit('connection', ws, request); }); } 
  else if (pathname === '/ws/liquidity') { wssLiquidity.handleUpgrade(request, socket, head, (ws) => { wssLiquidity.emit('connection', ws, request); }); } 
  else { socket.destroy(); }
});

function shutdown() {
  console.log('[system] shutting down...');
  for (const market of markets.values()) { sleep(market); sleepLiquidity(market); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.listen(PORT, () => { console.log(`[system] EdgeTrade backend listening on port ${PORT}`); });

// --- DEEP LIQUIDITY & WHALE WALL TRACKER ---
let deepLiquidityCache = { bids: [], asks: [] };
const WHALE_WALL_THRESHOLD = 5000000; // $5 Million (Massive wall filter)

async function fetchDeepLiquidity(symbol) {
  try {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol.toUpperCase()}&limit=1000`);
    if (!res.ok) return;
    const data = await res.json();
        
    const BUCKET_SIZE = 50;
        
    const processWalls = async (orders, side) => {
      const buckets = new Map();
      orders.forEach(([p, q]) => {
        const price = parseFloat(p);
        const qty = parseFloat(q);
        const bucketPrice = Math.round(price / BUCKET_SIZE) * BUCKET_SIZE;
        const val = price * qty;
        buckets.set(bucketPrice, (buckets.get(bucketPrice) || 0) + val);
      });
            
      let walls = Array.from(buckets.entries())
        .map(([price, total]) => ({ price: parseFloat(price), total }))
        .filter(b => b.total > 500000)
                .sort((a, b) => b.total - a.total);

      // DATABASE LOGIC: Save massive $5M+ walls to Supabase
      let massiveWalls = walls.filter(b => b.total >= WHALE_WALL_THRESHOLD);
      if (massiveWalls.length > 0 && typeof SUPABASE_URL !== 'undefined' && SUPABASE_URL && SUPABASE_KEY) {
        const timestamp = Date.now();
        const insertData = massiveWalls.map(w => ({
          symbol: symbol.toUpperCase(),
          timestamp_ms: timestamp,
          side: side,
          price: w.price,
          total_value_usd: w.total
        }));
                
        fetch(`${SUPABASE_URL}/rest/v1/whale_walls`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify(insertData)
        }).catch(e => console.error("Wall Save Error:", e.message));
      }
      return walls;
    };

    deepLiquidityCache.bids = await processWalls(data.bids, 'BUY');
    deepLiquidityCache.asks = await processWalls(data.asks, 'SELL');

    const msg = JSON.stringify({ type: 'liquidity_map', ...deepLiquidityCache });
    if (typeof wssLiquidity !== 'undefined' && wssLiquidity.clients) {
      wssLiquidity.clients.forEach(client => {
        if (client.readyState === 1 /* OPEN */) client.send(msg);
      });
    }
  } catch (err) { console.error('[Liquidity Engine] Error:', err.message); }
}

setInterval(() => fetchDeepLiquidity('BTCUSDT'), 15000);


// --- MARKET PULSE AI ENGINE (V2: ROLLING 5M ENGINE) ---
let currentPulseStartTime = Math.floor(Date.now() / 300000) * 300000;

setInterval(async () => {
  try {
    const symbol = 'BTCUSDT';
    // Fetch real-time Open Interest (Using Bybit to bypass Binance US IP Block on Render)
    const oiRes = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`);
    const oiData = await oiRes.json();
    const currentOI = oiData?.result?.list?.[0]?.openInterest ? parseFloat(oiData.result.list[0].openInterest) : 0;
    if (currentOI) marketPulse.oi = currentOI;

    const now = Date.now();
    const current5mInterval = Math.floor(now / 300000) * 300000;

    // End of 5-minute bucket: Save snapshot to Supabase and Reset local memory
    if (current5mInterval > currentPulseStartTime) {
            
      // Calculate total volume for this specific 5m bucket
      let bucketVol = 0;
      for (let p in marketPulse.profile) bucketVol += marketPulse.profile[p];

      if (typeof SUPABASE_URL !== 'undefined' && SUPABASE_KEY) {
        fetch(`${SUPABASE_URL}/rest/v1/market_pulse_5m`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
          body: JSON.stringify([{
            symbol: symbol,
            timestamp_ms: currentPulseStartTime,
            price_close: marketPulse.lastPrice || 0,
            volume: bucketVol || 0,
            cvd: marketPulse.cvd || 0,
            open_interest: currentOI || marketPulse.oi || 0
          }])
        }).catch(e => console.error("Pulse 5m Save Error:", e.message));
      }

      // Reset local variables for the next 5-minute window
      currentPulseStartTime = current5mInterval;
      marketPulse.cvd = 0; 
      marketPulse.profile = {}; 
    }

    // Transmit basic live pulse to frontend (Advanced AI logic will be fetched via REST API)
    const btcMarket = markets.get('btcusdt');
    if (btcMarket) broadcastToMarket(btcMarket, { type: 'pulse', data: marketPulse });

  } catch (err) {}
}, 10000); // Check every 10 seconds to respect rate limits
