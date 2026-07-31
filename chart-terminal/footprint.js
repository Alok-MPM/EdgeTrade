// ══════════════════════════════════════════════════════════════════════════
// chart-terminal/footprint.js
//
// Footprint overlay for the main chart. Draws directly onto a <canvas> that
// sits on top of #klineMainChart (NOT DOM nodes per cell — a footprint grid
// can have 15-20 boxes per candle × 100+ visible candles, which would be
// thousands of <div>s and would crawl on mobile. Canvas stays light).
//
// Owns: the "Footprint" toggle button already sitting in chart-cockpit.js's
// toolbar (#ctc-footprint-btn), plus its own small Spot/Futures/Edge type
// switcher that only appears while footprint mode is active.
//
// Talks to:
//   - marketStore.js   -> current symbol (to know what to subscribe to)
//   - chart-engine.js  -> chart.timeScale() / series.priceToCoordinate() to
//                         place boxes at the exact x/y the candles are drawn
//                         at (so panning/zooming the chart keeps everything
//                         aligned automatically, no separate zoom logic here)
//   - EdgeTrade backend -> wss://<backend>/ws/footprint?symbol=<symbol>
//
// ── DATA MODEL ──────────────────────────────────────────────────────────
// Every price level from the backend carries BOTH a `spot` and a `perp`
// sub-bucket (Binance spot trades vs Bybit linear-perp trades), never
// pre-merged. That is what makes the 3 types possible without re-fetching:
//   Spot     -> level.spot
//   Futures  -> level.perp
//   Edge     -> level.spot + level.perp (summed right here, client-side)
// Switching type is instant and local — no reconnect, no backend request.
//
// ── DIAGONAL IMBALANCE (not same-level comparison) ─────────────────────
// A price level's SELL volume is compared against the BUY volume ONE
// BUCKET BELOW it (not the buy box sitting next to it at the same price).
// Same logic mirrored upward: a level's BUY volume is compared against the
// SELL volume ONE BUCKET ABOVE it. This mirrors how market orders actually
// sweep the book — diagonally, not level-for-level — which is the standard
// convention used by professional order-flow tools (ATAS, Bookmap, etc).
// Threshold: 300% (3x) — a level lights up as "imbalanced" only past that.
//
// ── PERFORMANCE ─────────────────────────────────────────────────────────
// Below a pixel-per-candle threshold, the detailed box grid is skipped
// entirely in favor of a single compact delta-colored strip per candle —
// keeps rendering light when zoomed out over many candles, and keeps
// unreadable micro-text off the screen.
// ══════════════════════════════════════════════════════════════════════════

(function () {

  if (typeof marketStore === 'undefined' || typeof chartEngine === 'undefined') {
    console.error('[footprint] market-store.js and chart-engine.js must be loaded before footprint.js');
    return;
  }

  // TODO: fill in the actual Render/Railway backend host before deploying.
  // This is the ONLY thing in this file that needs a manual edit.
  const FOOTPRINT_WS_BASE = 'wss://m-edgetrade-api-server.onrender.com/ws/footprint';

  const IMBALANCE_RATIO = 3;      // 300% — standard diagonal-imbalance threshold
  const DETAIL_MIN_SPACING = 46;  // px per candle below which we fall back to compact mode
  const DELTA_MIN_SPACING = 20;   // px per candle below which delta text is skipped entirely (would overlap)
  const DELTA_STRIP_HEIGHT = 18;  // px — fixed-height band for delta numbers
  const DELTA_STRIP_BOTTOM_MARGIN = 26; // px reserved for the chart's own time-axis labels below it
  const MAX_HISTORY = 200;
  const RECONNECT_DELAY_MS = 3000;

  const COLOR = {
    buy: '76,175,125',   // #4CAF7D
    sell: '224,82,82',   // #E05252
    text: '#EAECEF',
  };

  // ── Style (canvas overlay + type switcher pills) ────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .fp-overlay{position:absolute;top:0;left:0;pointer-events:none;z-index:4;}
    .fp-type-switch{position:absolute;top:34px;left:8px;z-index:6;display:none;
      background:rgba(20,20,20,0.75);border-radius:6px;padding:3px;gap:2px;
      font-family:'Outfit',sans-serif;}
    .fp-type-switch.visible{display:flex;}
    .fp-status{position:absolute;top:34px;right:8px;z-index:6;display:none;
      font-family:'JetBrains Mono',monospace;font-size:10px;padding:3px 8px;
      border-radius:6px;background:rgba(20,20,20,0.75);color:#EAECEF;
      max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .fp-status.visible{display:block;}
    .fp-status.ok{color:#4CAF7D;}
    .fp-status.err{color:#E05252;}
    .fp-type-btn{padding:3px 9px;font-size:11px;border-radius:4px;color:#B0B4BB;
      cursor:pointer;user-select:none;background:transparent;}
    .fp-type-btn.active{background:#D4B886;color:#111317;font-weight:600;}
  `;
  document.head.appendChild(style);

  // ── State ────────────────────────────────────────────────────────────
  let active = false;
  let currentSymbol = null;
  let currentType = 'edge'; // 'spot' | 'perp' | 'edge'

  let footprintHistory = []; // committed candles from backend
  let liveFootprint = null;  // currently-forming candle

  let ws = null;
  let wsReconnectTimer = null;

  let canvas = null;
  let ctx = null;
  let resizeObserver = null;
  let unsubscribeTimeRange = null;

  // ── Bucketing — MUST mirror backend/server.js's bucketPrice() EXACTLY.
  // If the backend's version ever changes, this one has to change with it
  // in the same pass, or footprint boxes will silently land on the wrong
  // price rows. ─────────────────────────────────────────────────────────
  function bucketPrice(price) {
    const p = Number(price);
    if (p >= 1000) return Math.round(p).toString();
    if (p >= 10) return (Math.round(p * 10) / 10).toString();
    return (Math.round(p * 10000) / 10000).toString();
  }

  function bucketSize(priceStr) {
    const p = Number(priceStr);
    if (p >= 1000) return 1;
    if (p >= 10) return 0.1;
    return 0.0001;
  }

  function makeEmptyFootprint(time) {
    return { time, open: null, high: null, low: null, close: null, volume: 0, levels: {} };
  }

  // ── Toggle button (already exists in chart-cockpit.js's toolbar) ───────
  // Uses event DELEGATION on document, not a direct getElementById lookup —
  // chart-cockpit.js's toolbar HTML doesn't exist in the DOM yet at the
  // moment footprint.js's script tag runs (chart-terminal boots lazily,
  // gated by the chartTerminalBooted flag, only once the user actually
  // opens the Chart tab). A direct lookup here would silently find nothing
  // and the button would never respond to clicks. Delegation checks at
  // click-time instead of bind-time, so it works no matter when the
  // cockpit's HTML actually gets injected.
  function bindButton() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('#ctc-footprint-btn');
      if (!btn) return;
      active ? deactivate() : activate();
    });
  }

  function activate() {
    active = true;
    const btn = document.getElementById('ctc-footprint-btn');
    if (btn) btn.classList.add('active');

    ensureCanvas();
    ensureTypeSwitch();
    ensureStatusBadge();
    connect(marketStore.getState().symbol);
    subscribeChartRedraws();
    render();
  }

  function deactivate() {
    active = false;
    const btn = document.getElementById('ctc-footprint-btn');
    if (btn) btn.classList.remove('active');

    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    clearTimeout(wsReconnectTimer);
    if (canvas) { ctx.clearRect(0, 0, canvas.width, canvas.height); canvas.style.display = 'none'; }
    hideTypeSwitch();
    hideStatusBadge();
    if (unsubscribeTimeRange) { unsubscribeTimeRange(); unsubscribeTimeRange = null; }
  }

  // ── Status badge — visible, on-screen connection state. Exists so a
  // connection problem is visible directly on a phone screen, without
  // needing to open DevTools (not always practical on mobile). ──────────
  let statusEl = null;
  function ensureStatusBadge() {
    const container = document.getElementById('klineMainChart');
    if (!container) return;
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.className = 'fp-status';
      container.appendChild(statusEl);
    }
    statusEl.classList.add('visible');
  }
  function hideStatusBadge() {
    if (statusEl) statusEl.classList.remove('visible');
  }
  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = 'FP: ' + text;
    statusEl.classList.remove('ok', 'err');
    if (kind) statusEl.classList.add(kind);
  }

  // ── WebSocket — connects only while footprint mode is active ──────────
  function connect(symbol) {
    currentSymbol = symbol;
    if (ws) { ws.onclose = null; ws.close(); }

    setStatus('connecting to ' + FOOTPRINT_WS_BASE.replace('wss://', ''), null);

    try {
      ws = new WebSocket(`${FOOTPRINT_WS_BASE}?symbol=${symbol.toLowerCase()}`);
    } catch (err) {
      // Malformed URL (e.g. still has "YOUR-BACKEND-HOST", a stray space,
      // or missing wss://) throws synchronously right here — this is the
      // #1 most common cause of "nothing happens" and would otherwise be
      // invisible without DevTools.
      setStatus('bad URL — ' + err.message, 'err');
      wsReconnectTimer = setTimeout(() => { if (active) connect(currentSymbol); }, RECONNECT_DELAY_MS);
      return;
    }

    ws.onopen = () => setStatus('connected (' + symbol.toUpperCase() + ')', 'ok');

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'snapshot') {
        footprintHistory = msg.footprintHistory || [];
        liveFootprint = msg.liveFootprint || makeEmptyFootprint(null);
        setStatus('live — ' + footprintHistory.length + ' candles', 'ok');
      } else if (msg.type === 'tick') {
        applyTick(msg);
      } else if (msg.type === 'candle_closed') {
        if (liveFootprint) {
          footprintHistory.push(liveFootprint);
          if (footprintHistory.length > MAX_HISTORY) footprintHistory.shift();
        }
        liveFootprint = makeEmptyFootprint(msg.candle.time);
        liveFootprint.open = msg.candle.open;
        liveFootprint.high = msg.candle.high;
        liveFootprint.low = msg.candle.low;
        liveFootprint.close = msg.candle.close;
      } else {
        return; // unknown message — don't waste a render pass
      }
      render();
    };

    ws.onclose = (ev) => {
      // ev.code tells us WHY it closed — 1006 usually means the connection
      // never actually reached the server (network/URL/mixed-content
      // block), which is exactly the failure mode we're chasing.
      setStatus('closed (code ' + ev.code + ') — retrying...', 'err');
      if (active) wsReconnectTimer = setTimeout(() => connect(currentSymbol), RECONNECT_DELAY_MS);
    };
    ws.onerror = () => ws.close();
  }

  function applyTick(msg) {
    if (!liveFootprint) return;
    const bucket = bucketPrice(msg.price);
    if (!liveFootprint.levels[bucket]) {
      liveFootprint.levels[bucket] = { spot: { buy: 0, sell: 0, trades: 0 }, perp: { buy: 0, sell: 0, trades: 0 } };
    }
    const side = liveFootprint.levels[bucket][msg.source];
    if (!side) return; // unknown source — ignore rather than mis-bucket it
    if (msg.side === 'sell') side.sell += msg.qty; else side.buy += msg.qty;
    side.trades += 1;
    liveFootprint.volume += msg.qty;
  }

  marketStore.onSymbolChange(({ symbol }) => {
    if (!active) return;
    footprintHistory = [];
    liveFootprint = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', symbol }));
      currentSymbol = symbol;
    } else {
      connect(symbol);
    }
  });

  // ── Canvas setup — sized to #klineMainChart, redraws on container resize ─
  function ensureCanvas() {
    const container = document.getElementById('klineMainChart');
    if (!container) return;

    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'fp-overlay';
      container.appendChild(canvas);
      ctx = canvas.getContext('2d');
      resizeObserver = new ResizeObserver(() => { resizeCanvas(); render(); });
      resizeObserver.observe(container);
    }
    canvas.style.display = 'block';
    resizeCanvas();
  }

  function resizeCanvas() {
    const container = document.getElementById('klineMainChart');
    if (!container || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = container.clientWidth * dpr;
    canvas.height = container.clientHeight * dpr;
    canvas.style.width = container.clientWidth + 'px';
    canvas.style.height = container.clientHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function subscribeChartRedraws() {
    const chart = chartEngine.getInstance();
    if (!chart) return;
    const handler = () => render();
    chart.timeScale().subscribeVisibleTimeRangeChange(handler);
    unsubscribeTimeRange = () => chart.timeScale().unsubscribeVisibleTimeRangeChange(handler);
  }

  // ── Type switcher (Spot / Futures / Edge) ───────────────────────────────
  let typeSwitchEl = null;
  function ensureTypeSwitch() {
    const container = document.getElementById('klineMainChart');
    if (!container) return;
    if (!typeSwitchEl) {
      typeSwitchEl = document.createElement('div');
      typeSwitchEl.className = 'fp-type-switch';
      typeSwitchEl.innerHTML = `
        <div class="fp-type-btn" data-type="spot">Spot</div>
        <div class="fp-type-btn" data-type="perp">Futures</div>
        <div class="fp-type-btn" data-type="edge">Edge</div>
      `;
      container.appendChild(typeSwitchEl);
      typeSwitchEl.addEventListener('click', (e) => {
        const t = e.target.getAttribute('data-type');
        if (!t || t === currentType) return;
        currentType = t;
        updateTypeSwitchUI();
        render();
      });
      updateTypeSwitchUI();
    }
    typeSwitchEl.classList.add('visible');
  }

  function updateTypeSwitchUI() {
    if (!typeSwitchEl) return;
    typeSwitchEl.querySelectorAll('.fp-type-btn').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-type') === currentType);
    });
  }

  function hideTypeSwitch() {
    if (typeSwitchEl) typeSwitchEl.classList.remove('visible');
  }

  // ── Reading a level for the currently-selected type ─────────────────────
  function readLevel(level) {
    if (!level) return { buy: 0, sell: 0 };
    if (currentType === 'spot') return level.spot;
    if (currentType === 'perp') return level.perp;
    return { buy: level.spot.buy + level.perp.buy, sell: level.spot.sell + level.perp.sell };
  }

  // ── Render ──────────────────────────────────────────────────────────
  function render() {
    if (!active || !canvas || !ctx) return;
    const chart = chartEngine.getInstance();
    const series = chartEngine.getSeries();
    if (!chart || !series) return;

    // Area charts don't have per-candle highs/lows to anchor boxes to —
    // skip drawing rather than render nonsense on top of a line.
    if (chartEngine.getChartType() === 'area') {
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      return;
    }

    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

    const timeScale = chart.timeScale();
    let barSpacing = 6;
    try { barSpacing = timeScale.options().barSpacing || 6; } catch (e) { /* fall back to default */ }

    const allCandles = liveFootprint ? [...footprintHistory, liveFootprint] : footprintHistory;

    if (barSpacing >= DELTA_MIN_SPACING) drawDeltaStripBackground();

    allCandles.forEach((candle) => {
      if (!candle || candle.time == null) return;
      const x = timeScale.timeToCoordinate(Math.floor(candle.time / 1000));
      if (x === null || x < -60 || x > canvas.clientWidth + 60) return; // offscreen cull

      const levels = Object.keys(candle.levels || {}).map(Number).sort((a, b) => b - a);
      let totalBuy = 0, totalSell = 0;
      levels.forEach((p) => {
        const d = readLevel(candle.levels[p]);
        totalBuy += d.buy; totalSell += d.sell;
      });
      const delta = totalBuy - totalSell;

      if (barSpacing < DETAIL_MIN_SPACING) {
        drawCompact(x, delta);
      } else {
        drawDetailed(x, barSpacing, candle, levels, series);
      }
      // Skip delta text at very tight spacing — neighboring labels would
      // overlap and become unreadable rather than useful.
      if (barSpacing >= DELTA_MIN_SPACING) drawDeltaRow(x, delta);
    });
  }

  function drawCompact(x, delta) {
    ctx.fillStyle = delta >= 0 ? `rgba(${COLOR.buy},0.55)` : `rgba(${COLOR.sell},0.55)`;
    ctx.fillRect(x - 1, 4, 2, 10);
  }

  function drawDetailed(x, spacing, candle, levels, series) {
    const boxW = Math.min(spacing - 4, 76);
    const half = boxW / 2;
    const rowH = 13;

    levels.forEach((price) => {
      const y = series.priceToCoordinate(price);
      if (y === null) return;

      const level = candle.levels[price];
      const cur = readLevel(level);
      const size = bucketSize(price);

      // ── Diagonal imbalance: this level's sell vs ONE BUCKET BELOW's buy,
      // and this level's buy vs ONE BUCKET ABOVE's sell — not same-row. ──
      const belowKey = bucketPrice(price - size);
      const aboveKey = bucketPrice(price + size);
      const belowBuy = candle.levels[belowKey] ? readLevel(candle.levels[belowKey]).buy : 0;
      const aboveSell = candle.levels[aboveKey] ? readLevel(candle.levels[aboveKey]).sell : 0;

      const sellImbalanced = belowBuy > 0 && cur.sell >= belowBuy * IMBALANCE_RATIO;
      const buyImbalanced = aboveSell > 0 && cur.buy >= aboveSell * IMBALANCE_RATIO;

      ctx.fillStyle = sellImbalanced ? `rgba(${COLOR.sell},0.6)` : `rgba(${COLOR.sell},0.22)`;
      ctx.fillRect(x - half, y - rowH / 2, half - 1, rowH);

      ctx.fillStyle = buyImbalanced ? `rgba(${COLOR.buy},0.6)` : `rgba(${COLOR.buy},0.22)`;
      ctx.fillRect(x + 1, y - rowH / 2, half - 1, rowH);

      if (boxW > 34) { // only bother drawing text if there's room to read it
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.fillStyle = COLOR.text;
        ctx.textAlign = 'right';
        ctx.fillText(fmt(cur.sell), x - 3, y + 3);
        ctx.textAlign = 'left';
        ctx.fillText(fmt(cur.buy), x + 3, y + 3);
      }
    });
  }

  // Fixed-height band along the bottom of the canvas — deltas line up in a
  // clean, readable row regardless of price, instead of following each
  // candle's own (varying) low, which is what was causing the scattered,
  // overlapping numbers seen on screen before this fix.
  function drawDeltaStripBackground() {
    const h = canvas.clientHeight;
    ctx.fillStyle = 'rgba(20,20,20,0.35)';
    ctx.fillRect(0, h - DELTA_STRIP_BOTTOM_MARGIN - DELTA_STRIP_HEIGHT, canvas.clientWidth, DELTA_STRIP_HEIGHT);
  }

  function drawDeltaRow(x, delta) {
    const y = canvas.clientHeight - DELTA_STRIP_BOTTOM_MARGIN - DELTA_STRIP_HEIGHT / 2 + 3;
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = delta >= 0 ? '#4CAF7D' : '#E05252';
    ctx.fillText((delta >= 0 ? '+' : '') + fmt(delta), x, y);
  }

  function fmt(n) {
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'K';
    if (Math.abs(n) >= 1) return n.toFixed(1);
    return n.toFixed(3);
  }

  // ── Init ────────────────────────────────────────────────────────────
  bindButton();

  window.footprintOverlay = { activate, deactivate, isActive: () => active };

})();

// ══════════════════════════════════════════════════════════════════════════
// BEFORE THIS GOES LIVE:
//   1. Set FOOTPRINT_WS_BASE (top of file) to the actual Render/Railway URL.
//   2. Add <script src="chart-terminal/footprint.js"></script> to index.html,
//      right after chart-cockpit.js (uncomment the line that's already there).
//   3. DETAIL_MIN_SPACING (46px) and the imbalance ratio (3x / 300%) are
//      tuning knobs — good starting values, adjust after eyeballing it live.
// ══════════════════════════════════════════════════════════════════════════
