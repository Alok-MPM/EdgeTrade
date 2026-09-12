// ══════════════════════════════════════════════════════════════════════════
// AGENT INSTRUCTION — 3 STEPS, IN ORDER
// STEP 1: chart-terminal/liquidity.js -> REPLACE ENTIRE FILE (SECTION A below)
// STEP 2: commit that change — message: "fix: liquidity symbol-aware + basis-aligned"
// STEP 3: PUSH ALL local commits on main to origin main (this includes the
//         already-committed pulse.js + footprint.js changes).
//         Command: git push origin main
//         If rejected: git pull --rebase origin main, then git push origin main.
// Do NOT modify any other file. Do NOT create branches.
//
// ─────────────────────── SECTION A: liquidity.js ───────────────────────────
(function () {
if (typeof chartEngine === 'undefined' || typeof window.chartOverlayUtils === 'undefined') return;
const CONFIG = {
  wsUrl: 'wss://m-edgetrade-api-server.onrender.com/ws/liquidity',
  reconnectMs: 3000,
  basisRefreshMs: 60000,
  colors: { buy: '76, 175, 125', sell: '224, 82, 82', text: 'rgba(234, 236, 239, 0.9)' }
};
const state = { active: false, ws: null, wsReconnect: null, bids: [], asks: [], overlay: null, unsubscribeRedraw: null, symbol: null, basis: 0, basisTimer: null };
function currentSymbol() { return (typeof marketStore !== 'undefined') ? marketStore.getState().symbol : 'BTCUSDT'; }
// Walls PERP price space mein aati hain; chart (edge/spot) SPOT space mein hai.
// basis = perpMid - spotMid; draw price = wall.price - basis.
async function refreshBasis(symbol) {
  try {
    const [spot, perp] = await Promise.all([
      fetch(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${symbol}`).then(r => r.json()),
      fetch(`https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=${symbol}`).then(r => r.json())
    ]);
    const spotMid = (parseFloat(spot.bidPrice) + parseFloat(spot.askPrice)) / 2;
    const perpMid = (parseFloat(perp.bidPrice) + parseFloat(perp.askPrice)) / 2;
    if (isFinite(spotMid) && isFinite(perpMid) && spotMid > 0) state.basis = perpMid - spotMid;
  } catch (e) { /* keep last basis */ }
  if (state.active) requestAnimationFrame(render);
}
function connect(symbol) {
  if (state.ws) { state.ws.onclose = null; try { state.ws.close(); } catch (e) {} state.ws = null; }
  clearTimeout(state.wsReconnect);
  try { state.ws = new WebSocket(`${CONFIG.wsUrl}?symbol=${symbol.toLowerCase()}`); }
  catch (e) { state.wsReconnect = setTimeout(() => { if (state.active) connect(symbol); }, CONFIG.reconnectMs); return; }
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
  state.ws.onclose = () => { if (state.active) state.wsReconnect = setTimeout(() => connect(state.symbol || symbol), CONFIG.reconnectMs); };
  state.ws.onerror = () => { try { state.ws.close(); } catch (e) {} };
}
function render() {
  if (!state.active || !state.overlay) return;
  const series = chartEngine.getSeries();
  if (!series) return;
  const { ctx, canvas } = state.overlay;
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  if (!state.bids.length && !state.asks.length) return;
  const allValues = [...state.bids, ...state.asks].map(p => p.total);
  const maxValue = Math.max(...allValues, 1);
  drawZones(state.bids, 'buy', ctx, canvas.clientWidth, maxValue, series);
  drawZones(state.asks, 'sell', ctx, canvas.clientWidth, maxValue, series);
}
function drawZones(zones, side, ctx, width, maxValue, series) {
  const colorRGB = side === 'buy' ? CONFIG.colors.buy : CONFIG.colors.sell;
  zones.forEach((z) => {
    const y = series.priceToCoordinate(z.price - state.basis);
    if (y === null || y < 0 || y > ctx.canvas.height) return;
    const intensity = Math.min(1, Math.max(0.3, z.total / maxValue));
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(${colorRGB}, ${intensity})`;
    ctx.shadowBlur = 12 * intensity;
    ctx.shadowColor = `rgb(${colorRGB})`;
    ctx.stroke();
    ctx.shadowBlur = 0;
    const label = `${side === 'buy' ? 'B' : 'S'}: ${fmtUsd(z.total)}`;
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillStyle = CONFIG.colors.text;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, width - 65, y - 2);
  });
}
function fmtUsd(n) {
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.active) return;
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
  connect(state.symbol || currentSymbol());
});
if (typeof marketStore !== 'undefined') {
  marketStore.onSymbolChange(({ symbol }) => {
    if (!state.active) return;
    state.symbol = symbol;
    state.bids = []; state.asks = [];
    connect(symbol);
    refreshBasis(symbol);
  });
}
function toggle() {
  state.active = !state.active;
  if (state.active) {
    state.symbol = currentSymbol();
    if (!state.overlay) {
      state.overlay = window.chartOverlayUtils.createOverlayCanvas('klineMainChart', 'liq-overlay');
      new ResizeObserver(() => { if (state.overlay) state.overlay.resize(); requestAnimationFrame(render); }).observe(document.getElementById('klineMainChart'));
    }
    state.overlay.canvas.style.display = 'block';
    state.overlay.resize();
    const chart = chartEngine.getInstance();
    if (chart) state.unsubscribeRedraw = window.chartOverlayUtils.subscribeVisibleRangeRedraw(chart, render);
    connect(state.symbol);
    refreshBasis(state.symbol);
    clearInterval(state.basisTimer);
    state.basisTimer = setInterval(() => refreshBasis(state.symbol), CONFIG.basisRefreshMs);
  } else {
    clearInterval(state.basisTimer); state.basisTimer = null;
    clearTimeout(state.wsReconnect);
    if (state.ws) { state.ws.onclose = null; try { state.ws.close(); } catch (e) {} state.ws = null; }
    if (state.overlay) { state.overlay.clear(); state.overlay.canvas.style.display = 'none'; }
    if (state.unsubscribeRedraw) { state.unsubscribeRedraw(); state.unsubscribeRedraw = null; }
    state.bids = []; state.asks = [];
  }
  return state.active;
}
window.liquidity = { toggle };
})();
// ── END OF SECTION A — ab STEP 2 (commit) aur STEP 3 (push all) karo. ──
// ══════════════════════════════════════════════════════════════════════════
