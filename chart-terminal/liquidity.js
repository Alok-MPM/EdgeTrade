// ══════════════════════════════════════════════════════════════════════════
// chart-terminal/liquidity.js
//
// Liquidity overlay — deliberately NOT a heatmap (Bookmap/MMT-style color-
// gradient grids are intentionally hard to read at a glance: you have to
// learn to interpret shade intensity, and the exact size is often not
// shown at all). Instead: the biggest resting bid/ask orders near the
// current price are drawn as clean horizontal bars anchored at their real
// price against the chart's own price axis — bar LENGTH encodes size
// (easier to compare at a glance than color shade), and every bar always
// carries its exact dollar value as text. Only 2 colors, ever: green for
// resting buy orders, red for resting sell orders.
//
// SCOPE (Step 1, honest limitation): the backend currently captures only
// the top ~20 bid/ask levels each side (Binance depth20@1000ms) — for a
// pair like BTC that's often within a dollar or two of price, not a wall
// sitting far away. This shows the biggest of THOSE nearby resting
// orders, not deep book structure. Deeper capture is a future step.
//
// This is a canvas overlay on the chart (like footprint.js), but only
// draws in a narrow strip near the right edge (the price-axis area) —
// it never touches the candles themselves.
//
// Integration contract (matches chart-cockpit.js's existing wiring, same
// as order-flow.js): window.liquidity.toggle() -> returns true/false.
//
// Depends on: market-store.js, chart-engine.js, chart-overlay-utils.js.
// ══════════════════════════════════════════════════════════════════════════

(function () {

  if (typeof marketStore === 'undefined' || typeof chartEngine === 'undefined' || typeof window.chartOverlayUtils === 'undefined') {
    console.error('[liquidity] market-store.js, chart-engine.js, and chart-overlay-utils.js must all be loaded before liquidity.js');
    return;
  }

  const LIQUIDITY_WS_BASE = 'wss://m-edgetrade-api-server.onrender.com/ws/liquidity'; // same backend host as footprint/order-flow, different path
  const RECONNECT_DELAY_MS = 3000;
  const TOP_ORDERS_COUNT = 6; // per side — keeps it readable, not a wall of numbers
  const MAX_BAR_WIDTH = 130; // px, longest a bar can draw regardless of size
  const BAR_HEIGHT = 14;

  const COLOR = { buy: '76,175,125', sell: '224,82,82', text: '#EAECEF' };

  // ── State ────────────────────────────────────────────────────────────
  let active = false;
  let currentSymbol = null;
  let bids = []; // [{price, qty}]
  let asks = [];

  let ws = null;
  let wsReconnectTimer = null;

  let overlay = null; // { canvas, ctx, resize, clear, destroy } from chartOverlayUtils
  let unsubscribeTimeRange = null;

  // ── Style ────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `.liq-overlay{position:absolute;top:0;left:0;pointer-events:none;z-index:4;}`;
  document.head.appendChild(style);

  // ── Public toggle — matches chart-cockpit.js's existing call ──────────
  function toggle() {
    active = !active;
    if (active) activate(); else deactivate();
    return active;
  }

  function activate() {
    ensureCanvas();
    subscribeChartRedraws();
    connect(marketStore.getState().symbol);
    render();
  }

  function deactivate() {
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    clearTimeout(wsReconnectTimer);
    if (overlay) { overlay.clear(); overlay.canvas.style.display = 'none'; }
    if (unsubscribeTimeRange) { unsubscribeTimeRange(); unsubscribeTimeRange = null; }
    bids = []; asks = [];
  }

  marketStore.onSymbolChange(({ symbol }) => {
    if (!active) return;
    bids = []; asks = [];
    currentSymbol = symbol;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', symbol }));
    } else {
      connect(symbol);
    }
  });

  // ── WebSocket — own connection to /ws/liquidity, fully separate from
  // footprint/order-flow's own connections ───────────────────────────
  function connect(symbol) {
    currentSymbol = symbol;
    if (ws) { ws.onclose = null; ws.close(); }
    ws = new WebSocket(`${LIQUIDITY_WS_BASE}?symbol=${symbol.toLowerCase()}`);

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type !== 'snapshot' && msg.type !== 'depth') return;
      bids = msg.bids || [];
      asks = msg.asks || [];
      render();
    };

    ws.onclose = () => { if (active) wsReconnectTimer = setTimeout(() => connect(currentSymbol), RECONNECT_DELAY_MS); };
    ws.onerror = () => ws.close();
  }

  // ── Canvas + redraw sync — same shared utilities footprint.js uses ────
  function ensureCanvas() {
    if (!overlay) {
      overlay = window.chartOverlayUtils.createOverlayCanvas('klineMainChart', 'liq-overlay');
      if (!overlay) { console.error('[liquidity] could not create overlay canvas'); return; }
      const container = document.getElementById('klineMainChart');
      new ResizeObserver(() => { overlay.resize(); render(); }).observe(container);
    }
    overlay.canvas.style.display = 'block';
    overlay.resize();
  }

  function subscribeChartRedraws() {
    const chart = chartEngine.getInstance();
    if (!chart) return;
    unsubscribeTimeRange = window.chartOverlayUtils.subscribeVisibleRangeRedraw(chart, render);
  }

  // ── Render ──────────────────────────────────────────────────────────
  function render() {
    if (!active || !overlay) return;
    const series = chartEngine.getSeries();
    if (!series) return;
    const { ctx, canvas } = overlay;
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

    const topBids = [...bids].sort((a, b) => (b.price * b.qty) - (a.price * a.qty)).slice(0, TOP_ORDERS_COUNT);
    const topAsks = [...asks].sort((a, b) => (b.price * b.qty) - (a.price * a.qty)).slice(0, TOP_ORDERS_COUNT);
    const allValues = [...topBids, ...topAsks].map((o) => o.price * o.qty);
    const maxValue = Math.max(...allValues, 1);

    const rightEdge = canvas.clientWidth;

    drawSide(topBids, 'buy', series, rightEdge, maxValue);
    drawSide(topAsks, 'sell', series, rightEdge, maxValue);
  }

  function drawSide(orders, side, series, rightEdge, maxValue) {
    const { ctx } = overlay;
    orders.forEach((order) => {
      const y = series.priceToCoordinate(order.price);
      if (y === null) return;

      const value = order.price * order.qty;
      const barW = Math.max(6, (value / maxValue) * MAX_BAR_WIDTH);
      const colorKey = side === 'buy' ? COLOR.buy : COLOR.sell;

      ctx.fillStyle = `rgba(${colorKey},0.35)`;
      ctx.fillRect(rightEdge - barW, y - BAR_HEIGHT / 2, barW, BAR_HEIGHT);
      ctx.strokeStyle = `rgba(${colorKey},0.7)`;
      ctx.strokeRect(rightEdge - barW, y - BAR_HEIGHT / 2, barW, BAR_HEIGHT);

      // Label always shows the exact $ value — never just relying on bar
      // length/color alone to communicate size.
      const label = fmtUsd(value);
      ctx.font = '10px JetBrains Mono, monospace';
      window.chartOverlayUtils.drawTextIfFits(ctx, label, rightEdge - barW - 5, y + 3, 'right', 70);
    });
  }

  function fmtUsd(n) {
    const abs = Math.abs(n);
    if (abs >= 1e6) return '$' + (abs / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return '$' + (abs / 1e3).toFixed(1) + 'K';
    return '$' + abs.toFixed(0);
  }

  window.liquidity = { toggle };

})();

// ══════════════════════════════════════════════════════════════════════════
// BEFORE THIS GOES LIVE:
//   Add <script src="chart-terminal/liquidity.js"></script> to index.html,
//   right after order-flow.js.
//
// Scope notes:
//   - Only the biggest ~6 resting orders per side are shown (by $ value,
//     not raw quantity) — keeps it a quick read instead of 40 overlapping
//     bars. Everything smaller stays hidden by design.
//   - Bars are drawn from the chart's right edge inward, at each order's
//     real price (via series.priceToCoordinate) — they move with the
//     chart automatically on pan/zoom, same mechanism as footprint.js.
//   - "Zone grouping" (combining many nearby raw price levels into wider
//     bins) was discussed but isn't needed yet — Step 1's ~20-level depth
//     is naturally already a narrow price band, so the top orders by size
//     ARE effectively the meaningful zones. Revisit if/when deeper book
//     capture is added later.
// ══════════════════════════════════════════════════════════════════════════
