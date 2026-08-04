// ══════════════════════════════════════════════════════════════════════════
// chart-terminal/order-flow.js
//
// Order Flow panel — a self-contained BOX (no chart overlay, no canvas, no
// coordinate-sync with the candlestick chart). This was a deliberate
// decision: footprint.js's hardest bugs all came from syncing per-price-
// level drawing to chart pixel coordinates. Order Flow sidesteps that
// entire category of risk by never touching the chart at all — it's plain
// HTML/CSS rows in a panel, same as Order Book.
//
// While active, this REPLACES the Order Book panel (#order-book-root) —
// per explicit decision. It does this non-invasively: order-book.js is
// never modified, never told to stop, never has its listeners touched.
// Its render functions all do `document.getElementById(...)` fresh on
// every tick and safely no-op if the element isn't there (already true of
// order-book.js's existing code) — so overwriting the container's HTML is
// enough to "hide" it, and restoring the saved HTML on deactivate is
// enough to bring it back to life (order-book.js's still-active listeners
// pick the matching-ID elements right back up on their next tick).
//
// Integration contract (matches chart-cockpit.js's existing wiring exactly
// — chart-cockpit.js already calls window.orderflow.toggle() itself, no
// separate button-binding needed here):
//   window.orderflow.toggle() -> returns true/false (now active or not)
//
// Depends on: market-store.js (must load first).
// ══════════════════════════════════════════════════════════════════════════

(function () {

  if (typeof marketStore === 'undefined') {
    console.error('[order-flow] market-store.js must load before order-flow.js');
    return;
  }

  const FOOTPRINT_WS_BASE = 'wss://m-edgetrade-api-server.onrender.com/ws/footprint'; // same backend/endpoint as footprint.js
  const RECONNECT_DELAY_MS = 3000;
  const REFRESH_INTERVAL_MS = 1200; // timeframe windows are time-relative — re-aggregate periodically even with no new tick. Fast enough to feel live, cheap enough since this is plain DOM/CSS, not canvas.
  const TOP_LEVELS_COUNT = 6;
  const MAX_HISTORY = 200;

  const TIMEFRAMES = [
    { id: '1m', label: '1M', minutes: 1 },
    { id: '5m', label: '5M', minutes: 5 },
    { id: '15m', label: '15M', minutes: 15 },
    { id: '1h', label: '1H', minutes: 60 },
    { id: '4h', label: '4H', hours: 4 },   // reads hourlyRollup, not footprintHistory — see aggregate()
    { id: '1d', label: '1D', hours: 24 },  // reads hourlyRollup, not footprintHistory — see aggregate()
  ];

  // ── State ────────────────────────────────────────────────────────────
  let active = false;
  let currentSymbol = null;
  let currentTimeframe = '5m';

  let footprintHistory = [];
  let liveFootprint = null;
  let hourlyRollup = [];

  let ws = null;
  let wsReconnectTimer = null;
  let refreshTimer = null;

  let mountEl = null;
  let savedOrderBookHTML = null; // snapshot of Order Book's DOM, restored on deactivate
  let lastRowPrices = []; // previous render's top-level price order, for smooth in-place updates

  // Server-time anchor — lets us estimate "what time is it right now" using
  // the SERVER's clock (via whatever timestamp arrived in the last message),
  // corrected forward by local elapsed time since then. This replaces
  // relying on the device's own clock entirely for anything that decides
  // WHICH period/candle a moment belongs to — device clocks can drift and
  // silently pull in the wrong data. It still ticks smoothly every second
  // locally, it just stays anchored to server truth.
  let serverTimeAnchor = null; // { serverTime, receivedAtClientTime }
  let countdownTimer = null;

  function noteServerTime(t) {
    if (t == null) return;
    serverTimeAnchor = { serverTime: t, receivedAtClientTime: Date.now() };
  }
  function estimatedServerNow() {
    if (!serverTimeAnchor) return Date.now(); // no server data yet — best we can do until the first message arrives
    return serverTimeAnchor.serverTime + (Date.now() - serverTimeAnchor.receivedAtClientTime);
  }

  // ── Style ────────────────────────────────────────────────────────────
  // Reuses the same CSS custom properties order-book.js does
  // (--bg2/--gold/--text/--muted/--green/--red/--border/--bg4) so this
  // panel looks native to the app rather than like a bolted-on extra.
  const style = document.createElement('style');
  style.textContent = `
    .of-panel{background:var(--bg2);border:1px solid var(--border,rgba(255,255,255,0.08));border-radius:12px;padding:10px;display:flex;flex-direction:column;height:100%;box-sizing:border-box;font-family:'Outfit',sans-serif;}
    .of-header{display:flex;align-items:baseline;justify-content:space-between;gap:6px;margin-bottom:8px;font-family:'Cormorant Garamond',serif;}
    .of-header-left{display:flex;align-items:baseline;gap:6px;}
    .of-countdown{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text,#EAECEF);background:rgba(255,255,255,0.06);padding:3px 8px;border-radius:6px;letter-spacing:0.5px;}
    .of-title{font-size:17px;font-weight:600;color:var(--text,#EAECEF);}
    .of-symbol{font-size:13px;color:var(--gold);font-family:'JetBrains Mono',monospace;}

    .of-tf-tabs{display:flex;gap:4px;margin-bottom:10px;flex-wrap:wrap;}
    .of-tf-tabs button{font-family:'JetBrains Mono',monospace;font-size:11px;padding:4px 9px;border-radius:6px;border:1px solid var(--border,rgba(255,255,255,0.08));background:transparent;color:var(--muted,#8a8f98);cursor:pointer;}
    .of-tf-tabs button.active{background:var(--gold);color:#111317;border-color:var(--gold);font-weight:600;}
    .of-tf-tabs button:hover:not(.active){color:var(--text,#EAECEF);}

    .of-summary{display:flex;justify-content:space-between;font-size:13px;font-family:'JetBrains Mono',monospace;margin-bottom:5px;}
    .of-summary-buy{color:var(--green,#4CAF7D);}
    .of-summary-sell{color:var(--red,#E05252);}
    .of-pressure-bar{display:flex;height:6px;border-radius:4px;overflow:hidden;background:var(--bg4);margin-bottom:12px;}
    .of-pressure-buy{background:var(--green,#4CAF7D);height:100%;transition:width 0.5s ease;}
    .of-pressure-sell{background:var(--red,#E05252);height:100%;transition:width 0.5s ease;}

    .of-levels-title{font-size:10.5px;color:var(--muted,#8a8f98);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;}
    .of-levels{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:3px;}
    .of-empty{color:var(--muted,#8a8f98);font-size:12px;padding:10px 2px;}

    .of-level-row{display:grid;grid-template-columns:1fr 64px 1fr;align-items:center;gap:4px;font-family:'JetBrains Mono',monospace;font-size:11px;height:20px;}
    .of-level-price{text-align:center;color:var(--muted,#8a8f98);}
    .of-level-buy, .of-level-sell{display:flex;align-items:center;gap:4px;position:relative;height:14px;}
    .of-level-buy{justify-content:flex-end;}
    .of-level-sell{justify-content:flex-start;}
    .of-level-bar{height:100%;border-radius:3px;min-width:2px;transition:width 0.4s ease;}
    .of-level-bar.buy{background:rgba(76,175,125,0.45);}
    .of-level-bar.sell{background:rgba(224,82,82,0.45);}
    .of-level-amt{color:var(--text,#EAECEF);font-size:10.5px;white-space:nowrap;}
  `;
  document.head.appendChild(style);

  // ── Public toggle — matches chart-cockpit.js's existing call exactly ──
  function toggle() {
    active = !active;
    if (active) activate(); else deactivate();
    return active;
  }

  function activate() {
    mountEl = document.getElementById('order-book-root');
    if (!mountEl) { console.error('[order-flow] #order-book-root not found'); active = false; return; }

    savedOrderBookHTML = mountEl.innerHTML; // so deactivate() can hand the panel back to Order Book untouched
    currentSymbol = marketStore.getState().symbol;
    renderShell();
    connect(currentSymbol);
    refreshTimer = setInterval(render, REFRESH_INTERVAL_MS);
    countdownTimer = setInterval(updateCountdown, 1000);
  }

  function deactivate() {
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    clearTimeout(wsReconnectTimer);
    clearInterval(refreshTimer);
    clearInterval(countdownTimer);
    refreshTimer = null;
    countdownTimer = null;
    serverTimeAnchor = null;

    if (mountEl && savedOrderBookHTML !== null) {
      mountEl.innerHTML = savedOrderBookHTML; // order-book.js's own listeners pick the restored elements right back up
    }
    savedOrderBookHTML = null;
    footprintHistory = [];
    liveFootprint = null;
    hourlyRollup = [];
    lastRowPrices = [];
  }

  marketStore.onSymbolChange(({ symbol }) => {
    if (!active) return;
    footprintHistory = []; liveFootprint = null; hourlyRollup = []; lastRowPrices = [];
    currentSymbol = symbol;
    const label = document.getElementById('of-symbol-label');
    if (label) label.textContent = formatSymbol(symbol);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', symbol }));
    } else {
      connect(symbol);
    }
  });

  // ── WebSocket — same backend/contract as footprint.js ──────────────────
  function connect(symbol) {
    if (ws) { ws.onclose = null; ws.close(); }
    ws = new WebSocket(`${FOOTPRINT_WS_BASE}?symbol=${symbol.toLowerCase()}`);

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'snapshot') {
        footprintHistory = msg.footprintHistory || [];
        liveFootprint = msg.liveFootprint || null;
        hourlyRollup = msg.hourlyRollup || [];
        if (liveFootprint && liveFootprint.time != null) noteServerTime(liveFootprint.time);
      } else if (msg.type === 'tick') {
        noteServerTime(msg.time);
        applyTick(msg);
        return; // render() runs on its own timer — no need to redraw the whole panel on every single tick
      } else if (msg.type === 'candle_closed') {
        noteServerTime(msg.candle.time);
        if (liveFootprint) {
          footprintHistory.push(liveFootprint);
          if (footprintHistory.length > MAX_HISTORY) footprintHistory.shift();
        }
        liveFootprint = { time: msg.candle.time, levels: {} };
      } else {
        return;
      }
      render();
    };

    ws.onclose = () => { if (active) wsReconnectTimer = setTimeout(() => connect(currentSymbol), RECONNECT_DELAY_MS); };
    ws.onerror = () => ws.close();
  }

  function applyTick(msg) {
    if (!liveFootprint) return;
    const bucket = bucketPrice(msg.price);
    if (!liveFootprint.levels[bucket]) {
      liveFootprint.levels[bucket] = { spot: { buy: 0, sell: 0, trades: 0 }, perp: { buy: 0, sell: 0, trades: 0 } };
    }
    const side = liveFootprint.levels[bucket][msg.source];
    if (!side) return;
    if (msg.side === 'sell') side.sell += msg.qty; else side.buy += msg.qty;
    side.trades += 1;
  }

  // Mirrors backend/server.js's bucketPrice() EXACTLY — same rule as
  // footprint.js. If the backend's version ever changes, this one (and
  // footprint.js's copy) must change with it in the same pass.
  function bucketPrice(price) {
    const p = Number(price);
    if (p >= 1000) return Math.round(p).toString();
    if (p >= 10) return (Math.round(p * 10) / 10).toString();
    return (Math.round(p * 10000) / 10000).toString();
  }

  // ── Aggregation ──────────────────────────────────────────────────────
  // 1M/5M/15M/1H sum minutes out of footprintHistory (fine-grained, well
  // within its range). 4H/1D read hourlyRollup instead — footprintHistory
  // alone doesn't go back far enough for those. Either way, the still-
  // forming liveFootprint is merged on top so the current minute is
  // always reflected, even in the 4H/1D views.
  const PERIOD_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };

  // Boundary-aligned to the SAME clock marks candles use (e.g. 1H candles
  // start at :00 past the hour, 4H at 00:00/04:00/08:00 UTC etc.) — not
  // "N minutes before now". This is what makes Order Flow's window always
  // mean "this candle/period, from when it opened", exactly mirroring what
  // the main chart is showing, rather than a trailing window that can span
  // across two different candles depending on the exact second you look.
  function periodStart(tf, refTime) {
    const size = PERIOD_MS[tf] || PERIOD_MS['5m'];
    return Math.floor(refTime / size) * size;
  }

  // ── Countdown — time remaining until the CURRENT period (matching
  // whichever timeframe tab is selected) closes. Ticks every second using
  // the local clock for smoothness, but the period boundary itself is
  // always computed from estimatedServerNow() — only the animation is
  // local, the actual boundary decision never is.
  function updateCountdown() {
    const el = document.getElementById('of-countdown');
    if (!el) return;
    const size = PERIOD_MS[currentTimeframe] || PERIOD_MS['5m'];
    const referenceNow = estimatedServerNow();
    const start = periodStart(currentTimeframe, referenceNow);
    const end = start + size;
    const remainingMs = Math.max(0, end - referenceNow);
    el.textContent = formatCountdown(remainingMs);
  }

  function formatCountdown(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  // ── Aggregation ──────────────────────────────────────────────────────
  // 1M/5M/15M/1H sum minutes out of footprintHistory (fine-grained, well
  // within its range). 4H/1D read hourlyRollup instead — footprintHistory
  // alone doesn't go back far enough for those. Either way, the still-
  // forming liveFootprint is merged on top so the current minute is
  // always reflected.
  function aggregate(tf) {
    const def = TIMEFRAMES.find(t => t.id === tf) || TIMEFRAMES[1];
    const referenceNow = estimatedServerNow(); // server-anchored, not the device clock — see serverTimeAnchor above
    const start = periodStart(tf, referenceNow);
    const levels = {};

    if (def.hours) {
      hourlyRollup.forEach((bucket) => { if (bucket.time >= start) mergeLevelsInto(levels, bucket.levels); });
    } else {
      footprintHistory.forEach((candle) => { if (candle.time >= start) mergeLevelsInto(levels, candle.levels); });
    }
    if (liveFootprint) mergeLevelsInto(levels, liveFootprint.levels);

    return levels;
  }

  function mergeLevelsInto(target, source) {
    for (const price of Object.keys(source || {})) {
      const s = source[price];
      if (!target[price]) target[price] = { buy: 0, sell: 0 };
      target[price].buy += s.spot.buy + s.perp.buy;   // Edge (Aggregate) — spot + perp combined, no type toggle in v1
      target[price].sell += s.spot.sell + s.perp.sell;
    }
  }

  // ── Render ──────────────────────────────────────────────────────────
  function renderShell() {
    mountEl.innerHTML = `
      <div class="of-panel">
        <div class="of-header">
          <span class="of-header-left"><span class="of-title">Order Flow</span><span class="of-symbol" id="of-symbol-label">${formatSymbol(currentSymbol)}</span></span>
          <span class="of-countdown" id="of-countdown">--:--</span>
        </div>
        <div class="of-tf-tabs" id="of-tf-tabs">
          ${TIMEFRAMES.map(tf => `<button data-tf="${tf.id}" class="${tf.id === currentTimeframe ? 'active' : ''}">${tf.label}</button>`).join('')}
        </div>
        <div class="of-summary">
          <span class="of-summary-buy">Buy <span id="of-buy-total">$0</span></span>
          <span class="of-summary-sell"><span id="of-sell-total">$0</span> Sell</span>
        </div>
        <div class="of-pressure-bar"><div class="of-pressure-buy" id="of-pressure-buy" style="width:50%;"></div><div class="of-pressure-sell" id="of-pressure-sell" style="width:50%;"></div></div>
        <div class="of-levels-title" id="of-levels-title">Top price levels — ${currentTfLabel()}</div>
        <div class="of-levels" id="of-levels-body"><div class="of-empty">Connecting…</div></div>
      </div>
    `;

    document.getElementById('of-tf-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tf]');
      if (!btn) return;
      currentTimeframe = btn.dataset.tf;
      document.querySelectorAll('#of-tf-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tf === currentTimeframe));
      const titleEl = document.getElementById('of-levels-title');
      if (titleEl) titleEl.textContent = 'Top price levels — ' + currentTfLabel();
      updateCountdown();
      render();
    });
  }

  function currentTfLabel() {
    const def = TIMEFRAMES.find(t => t.id === currentTimeframe);
    return def ? def.label : currentTimeframe;
  }

  function render() {
    if (!active) return;
    const levels = aggregate(currentTimeframe);
    const priceKeys = Object.keys(levels).map(Number);

    let totalBuyUsd = 0, totalSellUsd = 0;
    const rows = priceKeys.map((p) => {
      const l = levels[p];
      const buyUsd = l.buy * p, sellUsd = l.sell * p;
      totalBuyUsd += buyUsd; totalSellUsd += sellUsd;
      return { price: p, buyUsd, sellUsd, total: buyUsd + sellUsd };
    }).sort((a, b) => b.total - a.total).slice(0, TOP_LEVELS_COUNT);

    setText('of-buy-total', fmtUsd(totalBuyUsd));
    setText('of-sell-total', fmtUsd(totalSellUsd));
    const totalAll = totalBuyUsd + totalSellUsd;
    const buyPct = totalAll > 0 ? (totalBuyUsd / totalAll * 100) : 50;
    setWidth('of-pressure-buy', buyPct.toFixed(0) + '%');
    setWidth('of-pressure-sell', (100 - buyPct).toFixed(0) + '%');

    const body = document.getElementById('of-levels-body');
    if (!body) return;
    if (!rows.length) { body.innerHTML = '<div class="of-empty">No trades yet in this window.</div>'; lastRowPrices = []; return; }

    const maxTotal = Math.max(...rows.map((r) => r.total), 1);
    const newPrices = rows.map((r) => r.price);
    // Same set of price levels, same order as last render? Update the
    // EXISTING dom nodes in place so the CSS width transition actually has
    // something to animate FROM. A full innerHTML rebuild creates brand
    // new elements every time, which paint straight at their final width
    // with nothing to glide from — that was the real reason it felt like
    // it was "snapping" instead of updating smoothly.
    const sameShape = newPrices.length === lastRowPrices.length && newPrices.every((p, i) => p === lastRowPrices[i]);

    if (sameShape) {
      rows.forEach((r) => {
        const row = body.querySelector(`[data-price="${r.price}"]`);
        if (!row) return;
        row.querySelector('[data-buy-amt]').textContent = fmtUsd(r.buyUsd);
        row.querySelector('[data-sell-amt]').textContent = fmtUsd(r.sellUsd);
        row.querySelector('[data-buy-bar]').style.width = Math.max(2, r.buyUsd / maxTotal * 100).toFixed(0) + '%';
        row.querySelector('[data-sell-bar]').style.width = Math.max(2, r.sellUsd / maxTotal * 100).toFixed(0) + '%';
      });
    } else {
      // Row set/order actually changed (a level entered/left the top N, or
      // reordered) — nothing to smoothly animate between different rows,
      // so just rebuild.
      body.innerHTML = rows.map((r) => `
        <div class="of-level-row" data-price="${r.price}">
          <div class="of-level-buy"><span class="of-level-amt" data-buy-amt>${fmtUsd(r.buyUsd)}</span><div class="of-level-bar buy" data-buy-bar style="width:${Math.max(2, r.buyUsd / maxTotal * 100).toFixed(0)}%"></div></div>
          <div class="of-level-price">${r.price}</div>
          <div class="of-level-sell"><div class="of-level-bar sell" data-sell-bar style="width:${Math.max(2, r.sellUsd / maxTotal * 100).toFixed(0)}%"></div><span class="of-level-amt" data-sell-amt>${fmtUsd(r.sellUsd)}</span></div>
        </div>
      `).join('');
    }
    lastRowPrices = newPrices;
  }

  function fmtUsd(n) {
    const abs = Math.abs(n);
    if (abs >= 1e6) return '$' + (abs / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return '$' + (abs / 1e3).toFixed(1) + 'K';
    return '$' + abs.toFixed(0);
  }
  function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
  function setWidth(id, width) { const el = document.getElementById(id); if (el) el.style.width = width; }
  function formatSymbol(sym) { return (sym || '').replace(/USDT$/, '') + '/USDT'; }

  window.orderflow = { toggle };

})();

// ══════════════════════════════════════════════════════════════════════════
// BEFORE THIS GOES LIVE:
//   Add <script src="chart-terminal/order-flow.js"></script> to index.html,
//   right after footprint.js (uncomment the existing commented-out line —
//   it currently points at "orderflow.js", double check the filename
//   matches whatever you save this as).
//
// v1 scope notes (intentional, not oversights):
//   - Edge (Aggregate) only — no Spot/Futures type toggle yet. Easy
//     fast-follow later: mirror footprint.js's readLevel()-per-type
//     pattern once this is confirmed stable.
//   - No per-candle chart drawing at all, by design — that's what keeps
//     this in the "low risk" category compared to footprint.
// ══════════════════════════════════════════════════════════════════════════
