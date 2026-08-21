// ══════════════════════════════════════════════════════════════════════════
// chart-terminal/liquidity.js
// ══════════════════════════════════════════════════════════════════════════

(function () {

  if (typeof marketStore === 'undefined' || typeof chartEngine === 'undefined' || typeof window.chartOverlayUtils === 'undefined') {
    console.error('[liquidity] market-store.js, chart-engine.js, and chart-overlay-utils.js must all be loaded before liquidity.js');
    return;
  }

  // UPDATED URL: Ab sidha backend ko hit karega 1006 error nahi aayega
  const LIQUIDITY_WS_BASE = 'wss://edgetrade-backend.onrender.com/ws/liquidity';
  const RECONNECT_DELAY_MS = 3000;
  const TOP_ORDERS_COUNT = 6; 
  const MAX_BAR_WIDTH = 130; 
  const BAR_HEIGHT = 14;

  const COLOR = { buy: '76,175,125', sell: '224,82,82', text: '#EAECEF' };

  // ── State ────────────────────────────────────────────────────────────
  let active = false;
  let currentSymbol = null;
  let bids = []; 
  let asks = [];

  let ws = null;
  let wsReconnectTimer = null;

  let overlay = null; 
  let unsubscribeTimeRange = null;

  // ── Style ────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .liq-overlay{position:absolute;top:0;left:0;pointer-events:none;z-index:4;}
    .liq-status{position:absolute;top:34px;right:8px;z-index:6;display:none;
      font-family:'JetBrains Mono',monospace;font-size:10px;padding:3px 8px;
      border-radius:6px;background:rgba(20,20,20,0.75);color:#EAECEF;
      max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .liq-status.visible{display:block;}
    .liq-status.ok{color:#4CAF7D;}
    .liq-status.err{color:#E05252;}
  `;
  document.head.appendChild(style);

  // ── Status badge ───────────────────────────────────────────────────────
  let statusEl = null;
  function ensureStatusBadge() {
    const container = document.getElementById('klineMainChart');
    if (!container) return;
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.className = 'liq-status';
      container.appendChild(statusEl);
    }
    statusEl.classList.add('visible');
  }
  function hideStatusBadge() {
    if (statusEl) statusEl.classList.remove('visible');
  }
  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = 'LIQ: ' + text;
    statusEl.classList.remove('ok', 'err');
    if (kind) statusEl.classList.add(kind);
  }

  // ── Public toggle ──────────────────────────────────────────────────────
  function toggle() {
    active = !active;
    if (active) activate(); else deactivate();
    return active;
  }

  function activate() {
    ensureCanvas();
    ensureStatusBadge();
    subscribeChartRedraws();
    connect(marketStore.getState().symbol);
    render();
  }

  function deactivate() {
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    clearTimeout(wsReconnectTimer);
    if (overlay) { overlay.clear(); overlay.canvas.style.display = 'none'; }
    hideStatusBadge();
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

  // ── WebSocket ────────────────────────────────────────────────────────
  function connect(symbol) {
    currentSymbol = symbol;
    if (ws) { ws.onclose = null; ws.close(); }
    
    setStatus('connecting...', null);
    
    try {
        ws = new WebSocket(`${LIQUIDITY_WS_BASE}?symbol=${symbol.toLowerCase()}`);
    } catch(e) {
        setStatus('bad URL', 'err');
        wsReconnectTimer = setTimeout(() => { if (active) connect(currentSymbol); }, RECONNECT_DELAY_MS);
        return;
    }

    ws.onopen = () => setStatus('live', 'ok');

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type !== 'snapshot' && msg.type !== 'depth') return;
      bids = msg.bids || [];
      asks = msg.asks || [];
      render();
    };

    ws.onclose = (ev) => {
        setStatus('closed (' + ev.code + ')', 'err');
        if (active) wsReconnectTimer = setTimeout(() => connect(currentSymbol), RECONNECT_DELAY_MS); 
    };
    ws.onerror = () => ws.close();
  }
    // ── Canvas + redraw sync ───────────────────────────────────────────────
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
    const chart = chartEngine.getInstance();
    const series = chartEngine.getSeries();
    if (!chart || !series) return;
    const { ctx, canvas } = overlay;
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

    const topBids = [...bids].sort((a, b) => (b.price * b.qty) - (a.price * a.qty)).slice(0, TOP_ORDERS_COUNT);
    const topAsks = [...asks].sort((a, b) => (b.price * b.qty) - (a.price * a.qty)).slice(0, TOP_ORDERS_COUNT);
    const allValues = [...topBids, ...topAsks].map((o) => o.price * o.qty);
    const maxValue = Math.max(...allValues, 1);

    let priceScaleWidth = 60; 
    try {
        priceScaleWidth = chart.priceScale('right').width();
    } catch(e) {}
    
    const rightEdge = canvas.clientWidth - priceScaleWidth;

    drawSide(topBids, 'buy', series, rightEdge, maxValue);
    drawSide(topAsks, 'sell', series, rightEdge, maxValue);
  }

  function drawSide(orders, side, series, rightEdge, maxValue) {
    const { ctx } = overlay;
    ctx.textBaseline = 'middle';
    
    const occupiedY = []; // overlap rokne ke liye tracking
    const MIN_GAP = 16;   // 14px bar height + 2px extra spacing

    orders.forEach((order) => {
      const y = series.priceToCoordinate(order.price);
      if (y === null) return;

      // Agar yeh naya order purane drawn order ke bohot paas hai, toh usko skip karo
      const isOverlapping = occupiedY.some(drawnY => Math.abs(y - drawnY) < MIN_GAP);
      if (isOverlapping) return; 

      occupiedY.push(y); // Safe space ko mark kar diya

      const value = order.price * order.qty;
      const barW = Math.max(6, (value / maxValue) * MAX_BAR_WIDTH);
      const colorKey = side === 'buy' ? COLOR.buy : COLOR.sell;

      ctx.fillStyle = `rgba(${colorKey},0.35)`;
      ctx.fillRect(rightEdge - barW, y - BAR_HEIGHT / 2, barW, BAR_HEIGHT);
      ctx.strokeStyle = `rgba(${colorKey},0.7)`;
      ctx.strokeRect(rightEdge - barW, y - BAR_HEIGHT / 2, barW, BAR_HEIGHT);

      const label = fmtUsd(value);
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.fillStyle = COLOR.text;
      
      window.chartOverlayUtils.drawTextIfFits(ctx, label, rightEdge - barW - 5, y, 'right', 70);
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
