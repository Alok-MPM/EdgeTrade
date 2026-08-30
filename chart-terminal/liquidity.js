// ══════════════════════════════════════════════════════════════════════════
// chart-terminal/liquidity.js
// Architecture: Aggregated Liquidity Pools (Smart Money Zones)
// ══════════════════════════════════════════════════════════════════════════

(function () {

  if (typeof marketStore === 'undefined' || typeof chartEngine === 'undefined' || typeof window.chartOverlayUtils === 'undefined') {
    console.error('[liquidity] market-store.js, chart-engine.js, and chart-overlay-utils.js must be loaded first.');
    return;
  }

  // ── Configuration ──────────────────────────────────────────────────────
  const CONFIG = {
    wsUrl: 'wss://edgetrade-backend.onrender.com/ws/liquidity',
    reconnectMs: 3000,
    topPoolsCount: 8,       // Increased to show more zones
    clusterGapPx: 16,       // Merge orders within 16px of each other
    barHeight: 14,
    maxBarWidth: 140,
    colors: {
      buy:  { rgb: '76,175,125',  hex: '#4CAF7D' },
      sell: { rgb: '224,82,82',   hex: '#E05252' },
      text: '#EAECEF'
    }
  };

  // ── State ────────────────────────────────────────────────────────────
  const state = {
    active: false,
    symbol: null,
    bids: [],
    asks: [],
    ws: null,
    reconnectTimer: null,
    overlay: null,
    unsubscribeRedraw: null
  };

  // ── Style & Status Badge ─────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .liq-overlay{position:absolute;top:0;left:0;pointer-events:none;z-index:4;}
    .liq-status{position:absolute;top:34px;right:8px;z-index:6;display:none;
      font-family:'JetBrains Mono',monospace;font-size:10px;padding:3px 8px;
      border-radius:6px;background:rgba(20,20,20,0.85);color:#EAECEF;
      border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(4px);}
    .liq-status.visible{display:block;}
    .liq-status.ok{color:#4CAF7D; border-color: rgba(76,175,125,0.3);}
    .liq-status.err{color:#E05252; border-color: rgba(224,82,82,0.3);}
  `;
  document.head.appendChild(style);

  let statusEl = null;
  function ensureStatusBadge() {
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.className = 'liq-status';
      document.getElementById('klineMainChart')?.appendChild(statusEl);
    }
    statusEl.classList.add('visible');
  }

  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = 'LIQ: ' + text;
    statusEl.className = 'liq-status visible';
    if (kind) statusEl.classList.add(kind);
  }

  // ── Network Layer ────────────────────────────────────────────────────
  function connect(symbol) {
    state.symbol = symbol;
    if (state.ws) { state.ws.onclose = null; state.ws.close(); }
    
    setStatus('connecting...', null);
    
    try {
        state.ws = new WebSocket(`${CONFIG.wsUrl}?symbol=${symbol.toLowerCase()}`);
    } catch(e) {
        setStatus('bad URL', 'err');
        state.reconnectTimer = setTimeout(() => { if (state.active) connect(state.symbol); }, CONFIG.reconnectMs);
        return;
    }

    state.ws.onopen = () => setStatus('Live', 'ok');

    state.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'snapshot' || msg.type === 'depth') {
          state.bids = msg.bids || [];
          state.asks = msg.asks || [];
          requestAnimationFrame(render);
        }
      } catch (err) {}
    };

    state.ws.onclose = (ev) => {
        setStatus(`closed (${ev.code})`, 'err');
        if (state.active) state.reconnectTimer = setTimeout(() => connect(state.symbol), CONFIG.reconnectMs); 
    };
    state.ws.onerror = () => state.ws.close();
  }

  // ── Engine Subscription ──────────────────────────────────────────────
  marketStore.onSymbolChange(({ symbol }) => {
    if (!state.active) return;
    state.bids = []; state.asks = [];
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'subscribe', symbol }));
      setStatus('syncing...', null);
    } else {
      connect(symbol);
    }
  });

  // ── Core Clustering Logic (The Secret Sauce) ─────────────────────────
  // Merges nearby orders into massive liquidity pools instead of hiding them
  function clusterLiquidity(orders, series) {
    if (!orders || !orders.length) return [];

    const mapped = orders.map(o => ({
      price: o.price,
      total: o.price * o.qty,
      y: series.priceToCoordinate(o.price)
    })).filter(o => o.y !== null);

    mapped.sort((a, b) => b.price - a.price); // Top to bottom

    const clusters = [];
    let current = null;

    for (const item of mapped) {
      if (!current) {
        current = { ...item };
        clusters.push(current);
      } else {
        if (Math.abs(current.y - item.y) <= CONFIG.clusterGapPx) {
          current.total += item.total;
          current.y = (current.y + item.y) / 2; // Center of gravity
        } else {
          current = { ...item };
          clusters.push(current);
        }
      }
    }

    return clusters.sort((a, b) => b.total - a.total).slice(0, CONFIG.topPoolsCount);
  }

  // ── Rendering ────────────────────────────────────────────────────────
  function render() {
    if (!state.active || !state.overlay) return;
    const chart = chartEngine.getInstance();
    const series = chartEngine.getSeries();
    if (!chart || !series) return;
    
    const { ctx, canvas } = state.overlay;
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

    const bidPools = clusterLiquidity(state.bids, series);
    const askPools = clusterLiquidity(state.asks, series);
    
    const allValues = [...bidPools, ...askPools].map(p => p.total);
    const maxValue = Math.max(...allValues, 1);

    let priceScaleWidth = 60; 
    try { priceScaleWidth = chart.priceScale('right').width(); } catch(e) {}
    const rightEdge = canvas.clientWidth - priceScaleWidth;

    drawPools(bidPools, 'buy', ctx, rightEdge, maxValue);
    drawPools(askPools, 'sell', ctx, rightEdge, maxValue);
  }

  function drawPools(pools, side, ctx, rightEdge, maxValue) {
    ctx.textBaseline = 'middle';
    const c = side === 'buy' ? CONFIG.colors.buy : CONFIG.colors.sell;

    pools.forEach((pool) => {
      const barW = Math.max(8, (pool.total / maxValue) * CONFIG.maxBarWidth);
      const x = rightEdge - barW;
      const y = pool.y - (CONFIG.barHeight / 2);

      // Gradient heatmap effect
      const grad = ctx.createLinearGradient(x, 0, rightEdge, 0);
      grad.addColorStop(0, `rgba(${c.rgb}, 0.1)`);
      grad.addColorStop(1, `rgba(${c.rgb}, 0.6)`);

      ctx.fillStyle = grad;
      ctx.fillRect(x, y, barW, CONFIG.barHeight);
      
      // Right edge border accent
      ctx.fillStyle = c.hex;
      ctx.fillRect(rightEdge - 2, y, 2, CONFIG.barHeight);

      // Label
      const label = fmtUsd(pool.total);
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.fillStyle = CONFIG.colors.text;
      window.chartOverlayUtils.drawTextIfFits(ctx, label, x - 6, pool.y, 'right', 70);
    });
  }

  function fmtUsd(n) {
    const abs = Math.abs(n);
    if (abs >= 1e6) return '$' + (abs / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return '$' + (abs / 1e3).toFixed(1) + 'K';
    return '$' + abs.toFixed(0);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────
  function toggle() {
    state.active = !state.active;
    
    if (state.active) {
      if (!state.overlay) {
        state.overlay = window.chartOverlayUtils.createOverlayCanvas('klineMainChart', 'liq-overlay');
        new ResizeObserver(() => { state.overlay?.resize(); requestAnimationFrame(render); }).observe(document.getElementById('klineMainChart'));
      }
      state.overlay.canvas.style.display = 'block';
      state.overlay.resize();
      ensureStatusBadge();
      
      const chart = chartEngine.getInstance();
      if (chart) state.unsubscribeRedraw = window.chartOverlayUtils.subscribeVisibleRangeRedraw(chart, render);
      
      connect(marketStore.getState().symbol);
    } else {
      if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
      clearTimeout(state.reconnectTimer);
      if (state.overlay) { state.overlay.clear(); state.overlay.canvas.style.display = 'none'; }
      if (statusEl) statusEl.classList.remove('visible');
      if (state.unsubscribeRedraw) { state.unsubscribeRedraw(); state.unsubscribeRedraw = null; }
      state.bids = []; state.asks = [];
    }
    
    return state.active;
  }

  window.liquidity = { toggle };

})();
