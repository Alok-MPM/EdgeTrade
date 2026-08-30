// ══════════════════════════════════════════════════════════════════════════
// chart-terminal/liquidity.js - Smart Money Resting Liquidity ($50 Buckets)
// ══════════════════════════════════════════════════════════════════════════

(function () {
  if (typeof chartEngine === 'undefined' || typeof window.chartOverlayUtils === 'undefined') return;

  const CONFIG = {
    wsUrl: 'wss://edgetrade-backend.onrender.com/ws/liquidity',
    reconnectMs: 3000,
    colors: {
      buy:  '76, 175, 125', // Green for resting Bids
      sell: '224, 82, 82',  // Red for resting Asks
      text: 'rgba(234, 236, 239, 0.9)'
    }
  };

  const state = { active: false, ws: null, bids: [], asks: [], overlay: null, unsubscribeRedraw: null };

  function connect() {
    if (state.ws) { state.ws.onclose = null; state.ws.close(); }
    try {
        state.ws = new WebSocket(CONFIG.wsUrl);
    } catch(e) { setTimeout(() => { if (state.active) connect(); }, CONFIG.reconnectMs); return; }

    state.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'liquidity_map') {
          state.bids = msg.bids || [];
          state.asks = msg.asks || [];
          requestAnimationFrame(render);
        }
      } catch (err) {}
    };
    state.ws.onclose = () => { if (state.active) setTimeout(connect, CONFIG.reconnectMs); };
  }

  function render() {
    if (!state.active || !state.overlay) return;
    const series = chartEngine.getSeries();
    if (!series) return;
    
    const { ctx, canvas } = state.overlay;
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

    const allValues = [...state.bids, ...state.asks].map(p => p.total);
    const maxValue = Math.max(...allValues, 1);

    drawZones(state.bids, 'buy', ctx, canvas.clientWidth, maxValue, series);
    drawZones(state.asks, 'sell', ctx, canvas.clientWidth, maxValue, series);
  }

  function drawZones(zones, side, ctx, width, maxValue, series) {
    const colorRGB = side === 'buy' ? CONFIG.colors.buy : CONFIG.colors.sell;

    zones.forEach((z) => {
      const y = series.priceToCoordinate(z.price);
      if (y === null || y < 0 || y > ctx.canvas.height) return;

      // Glow intensity max value ke hisaab se
      const intensity = Math.min(1, Math.max(0.3, z.total / maxValue));

      // 1. Draw Thin Glowing Line
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(${colorRGB}, ${intensity})`;
      ctx.shadowBlur = 12 * intensity; // Glow Effect
      ctx.shadowColor = `rgb(${colorRGB})`;
      ctx.stroke();

      // Reset Shadow for Text
      ctx.shadowBlur = 0;

      // 2. Draw Amount Text Right Above the Line
      const label = `${side === 'buy' ? 'B' : 'S'}: ${fmtUsd(z.total)}`;
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.fillStyle = CONFIG.colors.text;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom'; // Line ke theek upar
      
      // Right edge se thoda peeche (e.g. price scale margin)
      ctx.fillText(label, width - 65, y - 2); 
    });
  }

  function fmtUsd(n) {
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n.toFixed(0);
  }

  function toggle() {
    state.active = !state.active;
    if (state.active) {
      if (!state.overlay) {
        state.overlay = window.chartOverlayUtils.createOverlayCanvas('klineMainChart', 'liq-overlay');
        new ResizeObserver(() => { state.overlay?.resize(); requestAnimationFrame(render); }).observe(document.getElementById('klineMainChart'));
      }
      state.overlay.canvas.style.display = 'block';
      state.overlay.resize();
      
      const chart = chartEngine.getInstance();
      if (chart) state.unsubscribeRedraw = window.chartOverlayUtils.subscribeVisibleRangeRedraw(chart, render);
      connect();
    } else {
      if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
      if (state.overlay) { state.overlay.clear(); state.overlay.canvas.style.display = 'none'; }
      if (state.unsubscribeRedraw) { state.unsubscribeRedraw(); state.unsubscribeRedraw = null; }
      state.bids = []; state.asks = [];
    }
    return state.active;
  }

  window.liquidity = { toggle };
})();
