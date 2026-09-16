(function () {
if (typeof chartEngine === 'undefined' || typeof window.chartOverlayUtils === 'undefined') return;
const WS_BASE = 'wss://m-edgetrade-api-server.onrender.com/ws/footprint';
const REST_BASE = 'https://m-edgetrade-api-server.onrender.com';
const RECONNECT_MS = 3000;
const state = { ws: null, wsReconnect: null, events: [], live: null, symbol: null, overlay: null, unsub: null, bannerEl: null, boxEl: null, panelOn: false, layers: { whale: true, sweep: true, absorb: true, herd: true } };
const style = document.createElement('style');
style.textContent = `.fi-banner{position:absolute;top:44px;left:50%;transform:translateX(-50%);z-index:9;background:rgba(255,82,82,0.14);border:1px solid #E05252;color:#ff8a8a;font-family:'JetBrains Mono',monospace;font-size:11.5px;padding:7px 12px;border-radius:8px;max-width:80%;text-align:center;pointer-events:none;} .fi-box{position:fixed;top:70px;left:20px;width:250px;background:#0f0f12;border:1px solid #2a2a30;border-radius:10px;z-index:999998;display:none;padding:14px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#EAECEF;} .fi-box h4{margin:0 0 8px;font-size:12px;color:#D4B886;} .fi-row{display:flex;justify-content:space-between;margin:3px 0;} .fi-muted{color:#8b8b96;}`;
document.head.appendChild(style);
function currentSymbol() { return (typeof marketStore !== 'undefined') ? marketStore.getState().symbol : 'BTCUSDT'; }
function ensureOverlay() {
  if (!state.overlay) {
    state.overlay = window.chartOverlayUtils.createOverlayCanvas('klineMainChart', 'fi-overlay');
    const chart = chartEngine.getInstance();
    if (chart) state.unsub = window.chartOverlayUtils.subscribeVisibleRangeRedraw(chart, render);
    new ResizeObserver(() => { if (state.overlay) { state.overlay.resize(); render(); } }).observe(document.getElementById('klineMainChart'));
  }
  state.overlay.canvas.style.display = 'block';
  state.overlay.resize();
}
function ensureBanner() {
  if (!state.bannerEl) { state.bannerEl = document.createElement('div'); state.bannerEl.className = 'fi-banner'; state.bannerEl.style.display = 'none'; document.getElementById('klineMainChart').appendChild(state.bannerEl); }
}
function ensureBox() {
  if (!state.boxEl) {
    state.boxEl = document.createElement('div'); state.boxEl.className = 'fi-box';
    state.boxEl.innerHTML = `<h4>🧠 Flow Intel</h4><div class="fi-row fi-muted"><span>Thresholds</span><span id="fi-pct">—</span></div><div class="fi-row"><span>Retail CVD</span><span id="fi-retail">—</span></div><div class="fi-row"><span>Pro CVD</span><span id="fi-pro">—</span></div><div class="fi-row"><span>Whale CVD</span><span id="fi-whale">—</span></div><div class="fi-row fi-muted"><span>Retail herd</span><span id="fi-herd">none</span></div><div class="fi-row fi-muted"><span>Study trades</span><span id="fi-study">0</span></div><div class="fi-row" style="margin-top:6px;color:#ff8a8a;" id="fi-trap-row"><span id="fi-trap"></span></div>`;
    document.body.appendChild(state.boxEl);
  }
  state.boxEl.style.display = state.panelOn ? 'block' : 'none';
}
function usd(n) { const a = Math.abs(n); if (a >= 1e6) return '$' + (a / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return '$' + (a / 1e3).toFixed(1) + 'K'; return '$' + a.toFixed(0); }
function updatePanel() {
  if (!state.panelOn || !state.live) return;
  const L = state.live;
  const set = (id, t, c) => { const el = document.getElementById(id); if (el) { el.textContent = t; if (c) el.style.color = c; } };
  set('fi-pct', `R<${usd(L.pct.p75)} W>${usd(L.pct.p95)}`);
  const rc = L.cls.retail.buy - L.cls.retail.sell, pc = L.cls.pro.buy - L.cls.pro.sell, wc = L.cls.whale.buy - L.cls.whale.sell;
  set('fi-retail', (rc >= 0 ? '+' : '') + usd(rc), rc >= 0 ? '#4CAF7D' : '#E05252');
  set('fi-pro', (pc >= 0 ? '+' : '') + usd(pc), pc >= 0 ? '#4CAF7D' : '#E05252');
  set('fi-whale', (wc >= 0 ? '+' : '') + usd(wc), wc >= 0 ? '#4CAF7D' : '#E05252');
  set('fi-herd', L.herd && L.herd.until > Date.now() ? `${L.herd.side} ${(L.herd.share * 100).toFixed(0)}%` : 'none');
  set('fi-study', String(L.studyTrades || 0));
  const trapFresh = L.trap && Date.now() - L.trap.ts < 300000;
  set('fi-trap', trapFresh ? '⚠ ' + L.trap.text : '');
}
function updateBanner() {
  ensureBanner();
  const trapFresh = state.live && state.live.trap && Date.now() - state.live.trap.ts < 300000;
  state.bannerEl.style.display = trapFresh ? 'block' : 'none';
  if (trapFresh) state.bannerEl.textContent = '⚠ TRAP: ' + state.live.trap.text;
}
function pushEvent(ev) {
  if (state.events.some(e => e.ts === ev.ts && e.type === ev.type && e.side === ev.side)) return;
  state.events.push(ev);
  if (state.events.length > 800) state.events.shift();
  render();
}
async function loadHistory(symbol) {
  try {
    const since = Date.now() - 3 * 86400000;
    const res = await fetch(`${REST_BASE}/api/flow-events?symbol=${symbol}&since=${since}`);
    const rows = await res.json();
    (rows || []).forEach(r => pushEvent({ symbol: r.symbol, ts: r.ts, type: r.type, side: r.side, usd: r.usd, price: r.price, meta: r.meta || {} }));
  } catch (e) {}
}
function render() {
  if (!state.overlay) return;
  const series = chartEngine.getSeries(); const chart = chartEngine.getInstance();
  if (!series || !chart) return;
  const { ctx, canvas } = state.overlay;
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  const ts = chart.timeScale();
  state.events.forEach(ev => drawEvent(ev, ts, series, ctx, canvas));
}
function drawEvent(ev, ts, series, ctx, canvas) {
  const sec = Math.floor(ev.ts / 1000);
  const x = ts.timeToCoordinate(sec);
  if (x === null || x < -80 || x > canvas.clientWidth + 80) return;
  const L = state.layers;
  if (ev.type === 'SPLIT_EXEC' && L.whale) {
    const y1 = series.priceToCoordinate(ev.meta.pMax), y2 = series.priceToCoordinate(ev.meta.pMin);
    const x2 = ts.timeToCoordinate(sec + 120) || x + 40;
    ctx.fillStyle = 'rgba(212,184,134,0.16)'; ctx.fillRect(x, y1, Math.max(20, x2 - x), Math.max(6, y2 - y1));
    ctx.strokeStyle = 'rgba(212,184,134,0.7)'; ctx.strokeRect(x, y1, Math.max(20, x2 - x), Math.max(6, y2 - y1));
    ctx.fillStyle = '#D4B886'; ctx.font = '10px JetBrains Mono, monospace'; ctx.textAlign = 'left';
    ctx.fillText((ev.meta.action === 'ACCUMULATION' ? 'ACC ' : 'DIS ') + usd(ev.usd), x + 3, y1 - 3);
  } else if (ev.type === 'WHALE_PRINT' && L.whale) {
    const y = series.priceToCoordinate(ev.price); if (y === null) return;
    ctx.fillStyle = ev.side === 'buy' ? '#4CAF7D' : '#E05252';
    ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 5, y); ctx.closePath(); ctx.fill();
  } else if (ev.type === 'SWEEP' && L.sweep) {
    const y = series.priceToCoordinate(ev.price); if (y === null) return;
    const up = ev.side === 'buy';
    ctx.strokeStyle = up ? '#4CAF7D' : '#E05252'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y + (up ? 10 : -10)); ctx.lineTo(x, y + (up ? -4 : 4)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 4, y + (up ? 2 : -2)); ctx.lineTo(x + 4, y + (up ? 2 : -2)); ctx.lineTo(x, y + (up ? -5 : 5)); ctx.closePath(); ctx.fillStyle = up ? '#4CAF7D' : '#E05252'; ctx.fill();
  } else if (ev.type === 'ABSORPTION' && L.absorb) {
    const y = series.priceToCoordinate(ev.price); if (y === null) return;
    const x2 = ts.timeToCoordinate(sec + 60) || x + 24;
    ctx.fillStyle = 'rgba(90,200,250,0.28)'; ctx.fillRect(x, y - 3, Math.max(14, x2 - x), 6);
  } else if (ev.type === 'RETAIL_HERD' && L.herd) {
    const x2 = ts.timeToCoordinate(sec + 300) || x + 60;
    ctx.fillStyle = ev.side === 'buy' ? 'rgba(76,175,125,0.07)' : 'rgba(224,82,82,0.07)';
    ctx.fillRect(x, 0, Math.max(30, x2 - x), canvas.clientHeight);
    ctx.fillStyle = ev.side === 'buy' ? '#4CAF7D' : '#E05252'; ctx.font = '10px JetBrains Mono, monospace'; ctx.textAlign = 'left';
    ctx.fillText(`HERD ${ev.side.toUpperCase()} ${(ev.meta.share * 100).toFixed(0)}%`, x + 3, 14);
  }
}
function connect(symbol) {
  if (state.ws) { state.ws.onclose = null; try { state.ws.close(); } catch (e) {} state.ws = null; }
  clearTimeout(state.wsReconnect);
  state.symbol = symbol;
  state.ws = new WebSocket(`${WS_BASE}?symbol=${symbol.toLowerCase()}`);
  state.ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'flow_event') pushEvent(msg.data);
    else if (msg.type === 'flow_state') { state.live = msg.data; updatePanel(); updateBanner(); }
  };
  state.ws.onclose = () => { state.wsReconnect = setTimeout(() => connect(state.symbol), RECONNECT_MS); };
  state.ws.onerror = () => { try { state.ws.close(); } catch (e) {} };
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
  connect(state.symbol || currentSymbol());
});
if (typeof marketStore !== 'undefined') {
  marketStore.onSymbolChange(({ symbol }) => { state.events = []; connect(symbol); loadHistory(symbol); render(); });
}
function anyLayerOn() { return Object.values(state.layers).some(v => v); }
function toggleLayer(name) {
  state.layers[name] = !state.layers[name];
  if (anyLayerOn()) { ensureOverlay(); render(); } else if (state.overlay) { state.overlay.clear(); state.overlay.canvas.style.display = 'none'; }
  return state.layers[name];
}
function togglePanel() { state.panelOn = !state.panelOn; ensureBox(); updatePanel(); return state.panelOn; }
connect(currentSymbol());
loadHistory(currentSymbol());
window.flowIntel = { toggleLayer, togglePanel, isActive: () => anyLayerOn() };
})();
