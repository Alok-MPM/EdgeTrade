/**
 * EdgeTrade — Isolated Backend (server.js)
 * -----------------------------------------
 * Cold-Start / Zero-Latency Footprint Engine — MULTI-SYMBOL
 *
 * Responsibilities:
 *  1. /api/wakeup    -> wakes a specific symbol's market, opens exchange WS in background
 *  2. Shadow buffer  -> per-symbol: maintains last 200 candles + live tick-by-tick footprint in RAM
 *  3. /ws/footprint  -> when frontend connects for a symbol, instantly pushes that symbol's buffered data
 *  4. Auto-sleep     -> per-symbol: if a market has zero connected clients for 15 minutes, closes ITS
 *                       exchange connections only (other symbols' connections are unaffected)
 *
 * ── MULTI-SYMBOL REWRITE (Jul 2026) ─────────────────────────────────────────
 * The original version kept ONE global symbol + ONE set of exchange sockets,
 * and broadcast every update to EVERY connected client regardless of which
 * symbol they were viewing. That breaks the moment two users look at two
 * different symbols at the same time — both would get a mixed feed.
 *
 * Now every symbol gets its own isolated `Market` object (own candles, own
 * footprint buffer, own Binance/Bybit sockets, own client list, own
 * awake/sleep lifecycle). A Binance/Bybit connection for a symbol only
 * exists while at least one frontend client is actually watching it —
 * this also means we don't blow through exchange WS connection limits by
 * opening a socket per symbol regardless of demand.
 *
 * FRONTEND CONTRACT:
 *  - Connect to:  wss://<host>/ws/footprint?symbol=btcusdt
 *  - To switch symbol on an already-open connection (e.g. user changes the
 *    chart's symbol without a full page reload), send:
 *      { "type": "subscribe", "symbol": "ethusdt" }
 *    The server will detach the socket from the old market (unsubscribing
 *    if it was the last client there) and attach it to the new one,
 *    immediately sending a fresh snapshot for the new symbol.
 *
 *  - EVERY price level carries separate `spot` and `perp` sub-buckets
 *    (Binance spot trades vs Bybit linear-perpetual trades). This backend
 *    never merges them — "Spot" / "Futures" / "Edge (Aggregate)" are all
 *    the SAME data read three different ways on the frontend:
 *      Spot     -> level.spot
 *      Futures  -> level.perp
 *      Edge     -> level.spot + level.perp (summed client-side)
 *    Switching type on the frontend is instant and local — no re-subscribe,
 *    no extra backend request, because nothing needs to be re-fetched.
 *
 *  - NOTE: the candle body itself (open/high/low/close) is still Spot-only
 *    (from Binance's kline stream) regardless of which footprint type is
 *    selected — there's no separate perp candle shape. Switching type only
 *    changes which volume numbers appear inside the boxes, not the candle.
 *
 *  - snapshot also includes `hourlyRollup`: coarse, per-hour price-level
 *    totals (same spot/perp shape as footprintHistory, just one bucket per
 *    hour instead of per minute), covering up to MAX_HOURLY_ROLLUP hours.
 *    This is what Order Flow's 4H/1D views read from — footprintHistory
 *    alone only covers MAX_CANDLE_HISTORY minutes, nowhere near a full day.
 *    For 1M/5M/15M/1H, sum the relevant minutes out of footprintHistory
 *    instead (finer-grained, and well within its range already).
 */

const express = require('express');
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
const MAX_CANDLE_HISTORY = 200;
const IDLE_SLEEP_MS = 15 * 60 * 1000;      // 15 minutes with zero clients on a symbol
const IDLE_CHECK_INTERVAL_MS = 30 * 1000;  // check every 30s
const RECONNECT_DELAY_MS = 3000;

// Safety valve — caps how many symbols can be "awake" (holding live exchange
// sockets) at once. Prevents one server instance from silently opening
// hundreds of Binance/Bybit connections if traffic spreads across many
// symbols at once. Tune this once real traffic patterns are known; for now
// it just stops an unbounded blow-up.
const MAX_AWAKE_MARKETS = 40;

const BINANCE_REST_KLINES = (symbol, interval, limit) =>
  `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`;

const BINANCE_WS_URL = (symbol) =>
  `wss://stream.binance.com:9443/stream?streams=${symbol}@trade/${symbol}@kline_${CANDLE_INTERVAL}`;

const BYBIT_WS_URL = 'wss://stream.bybit.com/v5/public/linear';

// ---------------------------------------------------------------------------
// STATE — one Market per symbol (the "Shadow" buffer, now per-symbol)
// ---------------------------------------------------------------------------
const markets = new Map(); // symbol (lowercase) -> Market

function makeEmptyFootprintCandle(time) {
  return {
    time: time != null ? time : null,
    open: null,
    high: null,
    low: null,
    close: null,
    volume: 0,
    levels: {}, // { priceLevel(string): { spot: {buy,sell,trades}, perp: {buy,sell,trades} } }
    // "spot" = Binance spot trade stream, "perp" = Bybit linear-perpetual trade
    // stream. Kept separate (never pre-merged) so the frontend can render
    // Spot-only, Futures-only, or Edge/Aggregate (spot+perp summed) purely
    // by choosing how to read this same data — no re-subscribe needed to
    // switch "type".
  };
}

function createMarket(symbol) {
  return {
    symbol,
    awake: false,
    lastActivity: 0,

    candles: [],              // last MAX_CANDLE_HISTORY closed candles
    footprintHistory: [],     // completed footprint candles (parallel to candles)
    liveFootprint: makeEmptyFootprintCandle(), // currently-forming candle footprint
    hourlyRollup: [],         // coarse hourly buy/sell-per-level totals, for Order Flow's 4H/1D views (see foldIntoHourlyRollup)

    sockets: { binance: null, bybit: null },
    reconnectTimers: { binance: null, bybit: null },

    clients: new Set(), // ws connections currently watching this symbol
  };
}

function getOrCreateMarket(symbol) {
  let market = markets.get(symbol);
  if (!market) {
    market = createMarket(symbol);
    markets.set(symbol, market);
  }
  return market;
}

function touchActivity(market) {
  market.lastActivity = Date.now();
}

// Round price into a footprint "bucket" (tick size). Kept simple/generic.
// IMPORTANT: the frontend's live-tick aggregation must mirror this EXACT
// rounding logic, or its buckets will misalign with footprintHistory (which
// was bucketed here). If this function ever changes, the frontend's copy
// must change with it in the same pass.
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
// FOOTPRINT HISTORY BACKFILL — best-effort, bounded lookback
//
// Unlike OHLC candles (one REST call gets 200 of them instantly), footprint
// needs raw trade-level data to rebuild — there's no equivalent "give me
// 200 candles of price-level detail" endpoint. Binance's aggTrades REST
// endpoint can supply that, but only for Binance spot (Bybit has no public
// REST trade-history endpoint we can lean on the same way), and pulling a
// full 200-candle lookback for a busy pair like BTCUSDT would mean tens of
// thousands of trades per wake — too slow/heavy to do on every connect.
//
// So this is intentionally BOUNDED: only the last BACKFILL_MINUTES get
// backfilled, spot-side only. Perp (Bybit) levels on backfilled candles
// stay at 0 until live data starts arriving. This trades completeness for
// a fast, predictable wake-up — full-session footprint still builds up
// correctly candle-by-candle as the market runs, same as before.
// ---------------------------------------------------------------------------
const BACKFILL_MINUTES = 100;       // ~100 candles of footprint history on wake, as requested
const BACKFILL_MAX_TRADES = 40000;  // soft cap — the timeout below will usually trigger first for busy pairs
const BACKFILL_TIMEOUT_MS = 8000;   // hard wall-clock cap — wake-up NEVER hangs waiting on REST pagination, regardless of pair volume. Whatever's fetched by then is used; the rest fills in naturally as the market runs live.

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
  } catch (err) {
    console.error(`[system] footprint backfill failed (${market.symbol}):`, err.message);
    return; // leave footprintHistory empty — a clean empty state beats a half-populated one
  }

  if (!trades.length) return;

  // Bucket into candle-aligned footprint entries — same aggregation as the
  // live path (handleTradeTick), just replayed over the fetched history.
  const byMinute = new Map(); // candleOpenTime(ms) -> footprint candle
  trades.forEach((t) => {
    const openTime = Math.floor(t.T / 60000) * 60000;
    if (!byMinute.has(openTime)) byMinute.set(openTime, makeEmptyFootprintCandle(openTime));
    const fp = byMinute.get(openTime);
    const bucket = bucketPrice(t.p);
    if (!fp.levels[bucket]) {
      fp.levels[bucket] = { spot: { buy: 0, sell: 0, trades: 0 }, perp: { buy: 0, sell: 0, trades: 0 } };
    }
    const side = fp.levels[bucket].spot; // spot-only — see note above
    const qty = parseFloat(t.q);
    if (t.m) side.sell += qty; else side.buy += qty; // t.m = isBuyerMaker, same convention as the live stream
    side.trades += 1;
    fp.volume += qty;
  });

  // Stitch each bucket onto its real OHLC shape from market.candles so
  // open/high/low/close aren't left null.
  const ohlcByTime = new Map(market.candles.map((c) => [c.time, c]));
  const sortedTimes = [...byMinute.keys()].sort((a, b) => a - b);
  const built = sortedTimes.map((t) => {
    const fp = byMinute.get(t);
    const ohlc = ohlcByTime.get(t);
    if (ohlc) { fp.open = ohlc.open; fp.high = ohlc.high; fp.low = ohlc.low; fp.close = ohlc.close; }
    return fp;
  });

  // The most recent bucket is the still-forming candle — that belongs in
  // liveFootprint, not footprintHistory, so it isn't duplicated once real
  // ticks start arriving from connectBinance()/connectBybit() right after.
  const currentOpenTime = market.candles.length ? market.candles[market.candles.length - 1].time : null;
  if (built.length && built[built.length - 1].time === currentOpenTime) {
    market.liveFootprint = built.pop();
  }

  market.footprintHistory = built.slice(-MAX_CANDLE_HISTORY);
}

// ---------------------------------------------------------------------------
// EXCHANGE WS — Binance (trade + kline combined stream), scoped to a market
// ---------------------------------------------------------------------------
function connectBinance(market) {
  clearTimeout(market.reconnectTimers.binance);

  const ws = new WebSocket(BINANCE_WS_URL(market.symbol));
  market.sockets.binance = ws;

  ws.on('open', () => {
    console.log(`[binance] connected (${market.symbol})`);
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
      handleTradeTick(market, {
        price: payload.p,
        qty: payload.q,
        isBuyerMaker: payload.m, // true = sell-side aggressor
        time: payload.T,
        source: 'spot',
      });
    } else if (payload.e === 'kline') {
      handleKlineUpdate(market, payload.k);
    }
  });

  ws.on('close', () => {
    console.log(`[binance] disconnected (${market.symbol}), reconnecting...`);
    if (market.awake) {
      market.reconnectTimers.binance = setTimeout(() => connectBinance(market), RECONNECT_DELAY_MS);
    }
  });

  ws.on('error', (err) => {
    console.error(`[binance] error (${market.symbol}):`, err.message);
    ws.close();
  });
}

// ---------------------------------------------------------------------------
// EXCHANGE WS — Bybit (linear perp trade stream, supplementary flow data)
// ---------------------------------------------------------------------------
function connectBybit(market) {
  clearTimeout(market.reconnectTimers.bybit);

  const ws = new WebSocket(BYBIT_WS_URL);
  market.sockets.bybit = ws;
  const bybitSymbol = market.symbol.toUpperCase();

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
        handleTradeTick(market, {
          price: t.p,
          qty: t.v,
          isBuyerMaker: t.S === 'Sell',
          time: t.T,
          source: 'perp',
        });
      });
    }
  });

  ws.on('close', () => {
    clearInterval(ws.pingInterval);
    console.log(`[bybit] disconnected (${bybitSymbol}), reconnecting...`);
    if (market.awake) {
      market.reconnectTimers.bybit = setTimeout(() => connectBybit(market), RECONNECT_DELAY_MS);
    }
  });

  ws.on('error', (err) => {
    console.error(`[bybit] error (${bybitSymbol}):`, err.message);
    ws.close();
  });
}

// ---------------------------------------------------------------------------
// TICK -> FOOTPRINT AGGREGATION (per market)
// ---------------------------------------------------------------------------
// ── Single source of truth for "which candle is currently live" ───────────
// Previously, liveFootprint only rotated to a new candle when the kline
// stream's k.x (close) flag arrived. But trades and klines are two
// SEPARATE Binance event streams multiplexed on the same connection, with
// no ordering guarantee between them — so a handful of the new candle's
// first real trades could arrive (as 'trade' events) BEFORE the kline
// stream's "previous candle closed" confirmation did, and got bucketed
// into the OLD candle instead. This is what caused the reported bug: a new
// candle's early trades landing in the previous candle's footprint, with
// the new candle appearing empty until the (delayed) kline close event
// finally rotated it — a rolling one-candle-lagged contamination.
//
// Fix: derive "which candle" purely from a timestamp, and let WHICHEVER
// event (trade or kline) notices the boundary first perform the rotation.
// Only rotates FORWARD — a stray, out-of-order late trade for an
// already-closed, already-committed candle is dropped rather than
// ── Hourly rollup — for Order Flow's 4H/1D timeframes ──────────────────
// footprintHistory only keeps MAX_CANDLE_HISTORY (200) raw 1-minute
// candles — nowhere near enough for a 4H (240 min) or 1D (1440 min) view.
// Rather than keep 1440 minutes of full price-level detail in RAM forever
// (expensive, and REST backfill can't practically reach that far back
// anyway — see backfillFootprintHistory's own bounded-lookback note),
// every candle gets folded into a coarser HOURLY bucket the moment it
// closes. MAX_HOURLY_ROLLUP hours of these small buckets comfortably
// covers both 4H and 1D using a fraction of the memory.
const MAX_HOURLY_ROLLUP = 48; // hours — 2 days, well past 1D's own need

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
    if (!bucket.levels[price]) {
      bucket.levels[price] = { spot: { buy: 0, sell: 0, trades: 0 }, perp: { buy: 0, sell: 0, trades: 0 } };
    }
    const dst = bucket.levels[price];
    dst.spot.buy += src.spot.buy; dst.spot.sell += src.spot.sell; dst.spot.trades += src.spot.trades;
    dst.perp.buy += src.perp.buy; dst.perp.sell += src.perp.sell; dst.perp.trades += src.perp.trades;
  }
}


function ensureLiveFootprintCandle(market, candleOpenTime) {
  if (market.liveFootprint.time === candleOpenTime) return true; // already correct — nothing to do

  if (market.liveFootprint.time != null && candleOpenTime < market.liveFootprint.time) {
    return false; // late/out-of-order data for a candle that's already closed — caller should drop it
  }

  if (market.liveFootprint.time != null) {
    // The previously-live candle has genuinely finished — commit it now,
    // regardless of whether the kline stream's own close flag has arrived
    // yet or not.
    market.footprintHistory.push(market.liveFootprint);
    if (market.footprintHistory.length > MAX_CANDLE_HISTORY) market.footprintHistory.shift();
    foldIntoHourlyRollup(market, market.liveFootprint);
    broadcastToMarket(market, {
      type: 'candle_closed',
      candle: {
        time: market.liveFootprint.time,
        open: market.liveFootprint.open,
        high: market.liveFootprint.high,
        low: market.liveFootprint.low,
        close: market.liveFootprint.close,
      },
    });
  }

  market.liveFootprint = makeEmptyFootprintCandle(candleOpenTime);
  return true;
}

function handleTradeTick(market, { price, qty, isBuyerMaker, time, source }) {
  touchActivity(market); // exchange activity keeps this market's shadow buffer "fresh", not user activity

  // Which candle does THIS trade's own timestamp actually belong to? —
  // decided here, not assumed from whatever liveFootprint currently
  // happens to reference.
  const candleOpenTime = Math.floor(time / 60000) * 60000;
  if (!ensureLiveFootprintCandle(market, candleOpenTime)) return; // stray late trade for an already-closed candle

  const bucket = bucketPrice(price);
  const level = market.liveFootprint.levels[bucket] || {
    spot: { buy: 0, sell: 0, trades: 0 },
    perp: { buy: 0, sell: 0, trades: 0 },
  };
  const side = level[source]; // 'spot' or 'perp' sub-bucket

  // isBuyerMaker true => the aggressor was a SELL (hit the bid)
  if (isBuyerMaker) {
    side.sell += parseFloat(qty);
  } else {
    side.buy += parseFloat(qty);
  }
  side.trades += 1;
  market.liveFootprint.levels[bucket] = level;
  market.liveFootprint.volume += parseFloat(qty);

  broadcastToMarket(market, {
    type: 'tick',
    price: parseFloat(price),
    qty: parseFloat(qty),
    side: isBuyerMaker ? 'sell' : 'buy',
    source, // 'spot' | 'perp' — frontend routes this into the matching sub-bucket
    time,
  });
}

function handleKlineUpdate(market, k) {
  const candle = {
    time: k.t,
    open: parseFloat(k.o),
    high: parseFloat(k.h),
    low: parseFloat(k.l),
    close: parseFloat(k.c),
    volume: parseFloat(k.v),
  };

  // update the in-progress candle (last one) live
  if (market.candles.length && market.candles[market.candles.length - 1].time === candle.time) {
    market.candles[market.candles.length - 1] = candle;
  } else {
    market.candles.push(candle);
    if (market.candles.length > MAX_CANDLE_HISTORY) market.candles.shift();
  }

  // Same rotation function as handleTradeTick — whichever stream notices
  // the new candle first "wins" and rotates; the other just confirms.
  const rotated = ensureLiveFootprintCandle(market, k.t);
  if (rotated) {
    market.liveFootprint.open = candle.open;
    market.liveFootprint.high = candle.high;
    market.liveFootprint.low = candle.low;
    market.liveFootprint.close = candle.close;
  }
}

// ---------------------------------------------------------------------------
// WAKE / SLEEP LIFECYCLE (per market)
// ---------------------------------------------------------------------------
async function wakeUp(symbol) {
  const market = getOrCreateMarket(symbol);
  touchActivity(market);

  if (market.awake) return { alreadyAwake: true, symbol };

  if (countAwakeMarkets() >= MAX_AWAKE_MARKETS) {
    console.warn(`[system] MAX_AWAKE_MARKETS (${MAX_AWAKE_MARKETS}) reached — refusing to wake ${symbol}`);
    return { alreadyAwake: false, symbol, error: 'server_at_capacity', candleCount: 0 };
  }

  console.log(`[system] waking up for ${symbol}...`);
  market.awake = true;

  try {
    market.candles = await fetchInitialCandles(symbol);
  } catch (err) {
    console.error(`[system] failed to fetch initial candles (${symbol}):`, err.message);
    market.candles = [];
  }

  market.footprintHistory = [];
  market.liveFootprint = makeEmptyFootprintCandle();
  await backfillFootprintHistory(market); // best-effort — leaves history empty on failure rather than blocking wakeup indefinitely

  connectBinance(market);
  connectBybit(market);

  return { alreadyAwake: false, symbol, candleCount: market.candles.length, footprintCandleCount: market.footprintHistory.length };
}

function sleep(market) {
  if (!market.awake) return;
  console.log(`[system] ${market.symbol} going to sleep (idle timeout reached)`);

  if (market.sockets.binance) market.sockets.binance.close();
  if (market.sockets.bybit) market.sockets.bybit.close();
  clearTimeout(market.reconnectTimers.binance);
  clearTimeout(market.reconnectTimers.bybit);

  market.awake = false;
  market.candles = [];
  market.footprintHistory = [];
  market.liveFootprint = makeEmptyFootprintCandle();

  // Free the market entry entirely once it's asleep AND nobody's watching —
  // keeps the `markets` Map from growing forever across many symbols over
  // time. A market only reaches here with clients.size > 0 during shutdown,
  // where deleting the entry doesn't matter (process is exiting anyway).
  if (market.clients.size === 0) markets.delete(market.symbol);
}

function countAwakeMarkets() {
  let n = 0;
  for (const m of markets.values()) if (m.awake) n++;
  return n;
}

setInterval(() => {
  const now = Date.now();
  for (const market of markets.values()) {
    if (market.awake && market.clients.size === 0 && now - market.lastActivity > IDLE_SLEEP_MS) {
      sleep(market);
    }
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
  const symbol = req.query.symbol ? String(req.query.symbol).toLowerCase() : null;

  if (symbol) {
    const market = markets.get(symbol);
    return res.json(market ? {
      symbol,
      awake: market.awake,
      candleCount: market.candles.length,
      footprintCandleCount: market.footprintHistory.length,
      lastActivity: market.lastActivity,
      idleForMs: market.lastActivity ? Date.now() - market.lastActivity : null,
      connectedClients: market.clients.size,
    } : { symbol, awake: false, candleCount: 0, footprintCandleCount: 0, connectedClients: 0 });
  }

  // No symbol given — summary across all currently-tracked markets.
  const summary = [...markets.values()].map((m) => ({
    symbol: m.symbol,
    awake: m.awake,
    connectedClients: m.clients.size,
  }));
  res.json({
    totalMarkets: markets.size,
    awakeMarkets: countAwakeMarkets(),
    totalConnectedClients: summary.reduce((sum, m) => sum + m.connectedClients, 0),
    markets: summary,
  });
});

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// WEBSOCKET SERVER — frontend-facing, zero-latency delivery, per-symbol rooms
// ---------------------------------------------------------------------------
const wss = new WebSocket.Server({ server, path: '/ws/footprint' });

function sendSnapshot(ws, market) {
  ws.send(JSON.stringify({
    type: 'snapshot',
    symbol: market.symbol,
    candles: market.candles,
    footprintHistory: market.footprintHistory,
    liveFootprint: market.liveFootprint,
    hourlyRollup: market.hourlyRollup, // Order Flow's 4H/1D views read from this
  }));
}

// Attaches a client socket to a market: joins its client room, auto-wakes
// the market if needed, and sends an immediate snapshot. Used both on
// initial connect and when a client sends a `subscribe` message to switch
// symbols on an already-open socket.
async function attachToMarket(ws, symbol) {
  const market = getOrCreateMarket(symbol);
  touchActivity(market);
  market.clients.add(ws);
  ws.symbol = symbol;

  if (!market.awake) {
    await wakeUp(symbol).catch((err) => console.error(`[system] auto-wake failed (${symbol}):`, err.message));
  }

  sendSnapshot(ws, market);
}

function detachFromMarket(ws) {
  if (!ws.symbol) return;
  const market = markets.get(ws.symbol);
  if (!market) return;
  market.clients.delete(ws);
  touchActivity(market); // client leaving still counts as recent activity — don't sleep instantly on the last disconnect, let the idle timer decide
}

wss.on('connection', (ws, req) => {
  const reqUrl = new URL(req.url, 'http://localhost');
  const symbol = (reqUrl.searchParams.get('symbol') || DEFAULT_SYMBOL).toLowerCase();

  console.log(`[client] connected for ${symbol}, sending buffered snapshot`);
  attachToMarket(ws, symbol);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg && msg.type === 'subscribe' && typeof msg.symbol === 'string') {
      const newSymbol = msg.symbol.toLowerCase();
      if (newSymbol !== ws.symbol) {
        console.log(`[client] switching ${ws.symbol} -> ${newSymbol}`);
        detachFromMarket(ws);
        attachToMarket(ws, newSymbol);
      }
      return;
    }

    // any other message (e.g. a client-side ping) counts as activity
    if (ws.symbol) {
      const market = markets.get(ws.symbol);
      if (market) touchActivity(market);
    }
  });

  ws.on('close', () => {
    console.log(`[client] disconnected (was watching ${ws.symbol})`);
    detachFromMarket(ws);
  });
});

function broadcastToMarket(market, payload) {
  if (!market.clients.size) return;
  const msg = JSON.stringify(payload);
  market.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// ---------------------------------------------------------------------------
// GRACEFUL SHUTDOWN
// ---------------------------------------------------------------------------
function shutdown() {
  console.log('[system] shutting down...');
  for (const market of markets.values()) sleep(market);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`[system] EdgeTrade backend listening on port ${PORT}`);
  console.log(`[system] POST /api/wakeup { symbol } to warm up, connect to ws://<host>/ws/footprint?symbol=<symbol> for live data`);
});
