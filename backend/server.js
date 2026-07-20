/**
 * EdgeTrade — Isolated Backend (server.js)
 * -----------------------------------------
 * Cold-Start / Zero-Latency Footprint Engine
 *
 * Responsibilities:
 *  1. /api/wakeup   -> wakes the server, opens exchange WS connections in background
 *  2. Shadow buffer -> maintains last 200 candles + live tick-by-tick footprint in RAM
 *  3. /ws/footprint -> when frontend connects, instantly pushes pre-buffered data
 *  4. Auto-sleep    -> if idle for 15 minutes, closes exchange connections to save resources
 *
 * NOTE: This file is fully standalone. No frontend code included/touched.
 */

const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 4000;
const DEFAULT_SYMBOL = (process.env.SYMBOL || 'btcusdt').toLowerCase();
const CANDLE_INTERVAL = '1m';
const MAX_CANDLE_HISTORY = 200;
const IDLE_SLEEP_MS = 15 * 60 * 1000;      // 15 minutes
const IDLE_CHECK_INTERVAL_MS = 30 * 1000;  // check every 30s
const RECONNECT_DELAY_MS = 3000;

const BINANCE_REST_KLINES = (symbol, interval, limit) =>
  `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`;

const BINANCE_WS_URL = (symbol) =>
  `wss://stream.binance.com:9443/stream?streams=${symbol}@trade/${symbol}@kline_${CANDLE_INTERVAL}`;

const BYBIT_WS_URL = 'wss://stream.bybit.com/v5/public/linear';

// ---------------------------------------------------------------------------
// STATE (in-memory — the "Shadow" buffer)
// ---------------------------------------------------------------------------
const state = {
  awake: false,
  lastActivity: 0,
  symbol: DEFAULT_SYMBOL,

  candles: [],              // last MAX_CANDLE_HISTORY closed candles
  footprintHistory: [],     // completed footprint candles (parallel to candles)
  liveFootprint: makeEmptyFootprintCandle(), // currently-forming candle footprint

  sockets: {
    binance: null,
    bybit: null,
  },
  reconnectTimers: {
    binance: null,
    bybit: null,
  },
};

function makeEmptyFootprintCandle() {
  return {
    time: null,
    open: null,
    high: null,
    low: null,
    close: null,
    volume: 0,
    levels: {}, // { priceLevel(string): { buy: number, sell: number, trades: number } }
  };
}

function touchActivity() {
  state.lastActivity = Date.now();
}

// Round price into a footprint "bucket" (tick size). Kept simple/generic.
function bucketPrice(price) {
  const p = Number(price);
  if (p >= 1000) return Math.round(p).toString();        // $1 buckets for big-priced assets
  if (p >= 10) return (Math.round(p * 10) / 10).toString(); // $0.1 buckets
  return (Math.round(p * 10000) / 10000).toString();      // fine buckets for small-priced assets
}

// ---------------------------------------------------------------------------
// SHADOW PROCESSING — initial REST fetch of last 200 candles
// ---------------------------------------------------------------------------
async function fetchInitialCandles(symbol) {
  const url = BINANCE_REST_KLINES(symbol, CANDLE_INTERVAL, MAX_CANDLE_HISTORY);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance REST klines failed: ${res.status}`);
  const raw = await res.json();

  return raw.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ---------------------------------------------------------------------------
// EXCHANGE WS — Binance (trade + kline combined stream)
// ---------------------------------------------------------------------------
function connectBinance(symbol) {
  clearTimeout(state.reconnectTimers.binance);

  const ws = new WebSocket(BINANCE_WS_URL(symbol));
  state.sockets.binance = ws;

  ws.on('open', () => {
    console.log(`[binance] connected (${symbol})`);
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const payload = msg.data;
    if (!payload) return;

    if (payload.e === 'trade') {
      handleTradeTick({
        price: payload.p,
        qty: payload.q,
        isBuyerMaker: payload.m, // true = sell-side aggressor
        time: payload.T,
      });
    } else if (payload.e === 'kline') {
      handleKlineUpdate(payload.k);
    }
  });

  ws.on('close', () => {
    console.log('[binance] disconnected, reconnecting...');
    if (state.awake) {
      state.reconnectTimers.binance = setTimeout(() => connectBinance(symbol), RECONNECT_DELAY_MS);
    }
  });

  ws.on('error', (err) => {
    console.error('[binance] error:', err.message);
    ws.close();
  });
}

// ---------------------------------------------------------------------------
// EXCHANGE WS — Bybit (linear perp trade stream, supplementary flow data)
// ---------------------------------------------------------------------------
function connectBybit(symbol) {
  clearTimeout(state.reconnectTimers.bybit);

  const ws = new WebSocket(BYBIT_WS_URL);
  state.sockets.bybit = ws;
  const bybitSymbol = symbol.toUpperCase().replace('USDT', 'USDT'); // e.g. BTCUSDT

  ws.on('open', () => {
    console.log(`[bybit] connected (${bybitSymbol})`);
    ws.send(JSON.stringify({ op: 'subscribe', args: [`publicTrade.${bybitSymbol}`] }));
    // Bybit requires a ping every ~20s to stay alive
    ws.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'ping' }));
    }, 20000);
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.topic && msg.topic.startsWith('publicTrade') && Array.isArray(msg.data)) {
      msg.data.forEach((t) => {
        handleTradeTick({
          price: t.p,
          qty: t.v,
          isBuyerMaker: t.S === 'Sell',
          time: t.T,
          source: 'bybit',
        });
      });
    }
  });

  ws.on('close', () => {
    clearInterval(ws.pingInterval);
    console.log('[bybit] disconnected, reconnecting...');
    if (state.awake) {
      state.reconnectTimers.bybit = setTimeout(() => connectBybit(symbol), RECONNECT_DELAY_MS);
    }
  });

  ws.on('error', (err) => {
    console.error('[bybit] error:', err.message);
    ws.close();
  });
}

// ---------------------------------------------------------------------------
// TICK -> FOOTPRINT AGGREGATION
// ---------------------------------------------------------------------------
function handleTradeTick({ price, qty, isBuyerMaker, time }) {
  touchActivity(); // exchange activity keeps the shadow buffer "fresh", not user activity

  const bucket = bucketPrice(price);
  const level = state.liveFootprint.levels[bucket] || { buy: 0, sell: 0, trades: 0 };

  // isBuyerMaker true => the aggressor was a SELL (hit the bid)
  if (isBuyerMaker) {
    level.sell += parseFloat(qty);
  } else {
    level.buy += parseFloat(qty);
  }
  level.trades += 1;
  state.liveFootprint.levels[bucket] = level;
  state.liveFootprint.volume += parseFloat(qty);

  broadcastToClients({
    type: 'tick',
    price: parseFloat(price),
    qty: parseFloat(qty),
    side: isBuyerMaker ? 'sell' : 'buy',
    time,
  });
}

function handleKlineUpdate(k) {
  const candle = {
    time: k.t,
    open: parseFloat(k.o),
    high: parseFloat(k.h),
    low: parseFloat(k.l),
    close: parseFloat(k.c),
    volume: parseFloat(k.v),
  };

  // update the in-progress candle (last one) live
  if (state.candles.length && state.candles[state.candles.length - 1].time === candle.time) {
    state.candles[state.candles.length - 1] = candle;
  } else {
    state.candles.push(candle);
    if (state.candles.length > MAX_CANDLE_HISTORY) state.candles.shift();
  }

  state.liveFootprint.time = candle.time;
  state.liveFootprint.open = candle.open;
  state.liveFootprint.high = candle.high;
  state.liveFootprint.low = candle.low;
  state.liveFootprint.close = candle.close;

  if (k.x) {
    // candle closed — commit footprint to history, start a fresh one
    state.footprintHistory.push(state.liveFootprint);
    if (state.footprintHistory.length > MAX_CANDLE_HISTORY) state.footprintHistory.shift();
    state.liveFootprint = makeEmptyFootprintCandle();

    broadcastToClients({ type: 'candle_closed', candle });
  }
}

// ---------------------------------------------------------------------------
// WAKE / SLEEP LIFECYCLE
// ---------------------------------------------------------------------------
async function wakeUp(symbol = state.symbol) {
  touchActivity();

  if (state.awake) return { alreadyAwake: true };

  console.log(`[system] waking up for ${symbol}...`);
  state.awake = true;
  state.symbol = symbol;

  try {
    state.candles = await fetchInitialCandles(symbol);
  } catch (err) {
    console.error('[system] failed to fetch initial candles:', err.message);
    state.candles = [];
  }

  state.footprintHistory = [];
  state.liveFootprint = makeEmptyFootprintCandle();

  connectBinance(symbol);
  connectBybit(symbol);

  return { alreadyAwake: false, symbol, candleCount: state.candles.length };
}

function sleep() {
  if (!state.awake) return;
  console.log('[system] going to sleep (idle timeout reached)');

  if (state.sockets.binance) state.sockets.binance.close();
  if (state.sockets.bybit) state.sockets.bybit.close();
  clearTimeout(state.reconnectTimers.binance);
  clearTimeout(state.reconnectTimers.bybit);

  state.awake = false;
  state.candles = [];
  state.footprintHistory = [];
  state.liveFootprint = makeEmptyFootprintCandle();
}

setInterval(() => {
  if (state.awake && Date.now() - state.lastActivity > IDLE_SLEEP_MS) {
    sleep();
  }
}, IDLE_CHECK_INTERVAL_MS);

// ---------------------------------------------------------------------------
// EXPRESS APP
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/wakeup', async (req, res) => {
  const symbol = (req.body?.symbol || DEFAULT_SYMBOL).toLowerCase();
  try {
    const result = await wakeUp(symbol);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    awake: state.awake,
    symbol: state.symbol,
    candleCount: state.candles.length,
    footprintCandleCount: state.footprintHistory.length,
    lastActivity: state.lastActivity,
    idleForMs: state.lastActivity ? Date.now() - state.lastActivity : null,
    connectedClients: wss ? wss.clients.size : 0,
  });
});

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// WEBSOCKET SERVER — frontend-facing, zero-latency delivery
// ---------------------------------------------------------------------------
const wss = new WebSocket.Server({ server, path: '/ws/footprint' });

wss.on('connection', (ws) => {
  touchActivity();
  console.log('[client] connected, sending buffered snapshot');

  // Auto-wake if a client connects while asleep (e.g. wakeup call was missed)
  if (!state.awake) {
    wakeUp().catch((err) => console.error('[system] auto-wake failed:', err.message));
  }

  // Instantly deliver whatever is already buffered — zero-latency handoff
  ws.send(
    JSON.stringify({
      type: 'snapshot',
      symbol: state.symbol,
      candles: state.candles,
      footprintHistory: state.footprintHistory,
      liveFootprint: state.liveFootprint,
    })
  );

  ws.on('message', () => {
    // any message (e.g. a client-side ping) counts as activity
    touchActivity();
  });

  ws.on('close', () => {
    console.log('[client] disconnected');
  });
});

function broadcastToClients(payload) {
  if (!wss.clients.size) return;
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// ---------------------------------------------------------------------------
// GRACEFUL SHUTDOWN
// ---------------------------------------------------------------------------
function shutdown() {
  console.log('[system] shutting down...');
  sleep();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`[system] EdgeTrade backend listening on port ${PORT}`);
  console.log(`[system] POST /api/wakeup to warm up, connect to ws://<host>/ws/footprint for live data`);
});

