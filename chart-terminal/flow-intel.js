(function () {
if (typeof chartEngine === 'undefined' || typeof window.chartOverlayUtils === 'undefined') return;
const WS_BASE = 'wss://m-edgetrade-api-server.onrender.com/ws/footprint';
const REST_BASE = 'https://m-edgetrade-api-server.onrender.com';
const RECONNECT_MS = 3000;
const state = { ws: null, wsReconnect: null, events: [], live: null, record: null, symbol: null, overlay: null, unsub: null, bannerEl: null, boxEl: null, outEl: null, panelOn: false, outOn: false, layers: { whale: true, sweep: true, absorb: true, herd: true } };
const style = document.createElement('style');
style.textContent = `.fi-banner{position:absolute;top:44px;left:50%;transform:translateX(-50%);z-index:9;background:rgba(255,82,82,0.16);border:1px solid #E05252;color:#ff8a8a;font-family:'JetBrains Mono',monospace;font-size:11.5px;padding:7px 12px;border-radius:8px;max-width:80%;text-align:center;pointer-events:none;} .fi-box{position:fixed;top:70px;left:20px;width:250px;background:#0f0f12;border:1px solid #2a2a30;border-radius:10px;z-index:999998;display:none;padding:14px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#EAECEF;} .fi-box2{position:fixed;top:70px;left:290px;width:270px;max-height:calc(100vh - 100px);overflow-y:auto;background:#0f0f12;border:1px solid #2a2a30;border-radius:10px;z-index:999998;display:none;padding:14px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#EAECEF;} .fi-row{display:flex;justify-content:space-between;margin:3px 0;} .fi-muted{color:#8b8b96;}`;
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
function ensureBanner() { if (!state.bannerEl) { state.bannerEl = document.createElement('div'); state.bannerEl.className = 'fi-banner'; state.bannerEl.style.display = 'none'; document.getElementById('klineMainChart').appendChild(state.bannerEl); } }
function ensureBox() {
  if (!state.boxEl) {
    state.boxEl = document.createElement('div'); state.boxEl.className = 'fi-box';
    state.boxEl.innerHTML = `<h4 style="margin:0 0 8px;font-size:12px;color:#D4B886;">🧠 Flow Intel</h4><div class="fi-row fi-muted"><span>Thresholds</span><span id="fi-pct">—</span></div><div class="fi-row"><span>Retail CVD</span><span id="fi-retail">—</span></div><div class="fi-row"><span>Pro CVD</span><span id="fi-pro">—</span></div><div class="fi-row"><span>Whale CVD</span><span id="fi-whale">—</span></div><div class="fi-row fi-muted"><span>Retail herd</span><span id="fi-herd">none</span></div><div class="fi-row fi-muted"><span>Study trades</span><span id="fi-study">0</span></div>`;
    document.body.appendChild(state.boxEl);
  }
  state.boxEl.style.display = state.panelOn ? 'block' : 'none';
}
function ensureOutBox() {
  if (!state.outEl) {
    state.outEl = document.createElement('div'); state.outEl.className = 'fi-box2';
    state.outEl.innerHTML = `<h4 style="margin:0 0 8px;font-size:12px;color:#D4B886;">📈 Market Outlook</h4><div id="fo-call" style="font-size:16px;font-weight:bold;margin-bottom:4px;">—</div><div class="fi-row fi-muted"><span>Confidence</span><span id="fo-conf">—</span></div><div class="fi-row fi-muted"><span>Horizon</span><span id="fo-horizon">60m</span></div><div id="fo-reasons" style="margin:6px 0;color:#8b8b96;font-size:10px;line-height:1.6;"></div><div style="border-top:1px solid #2a2a30;margin:6px 0;"></div><div class="fi-row"><span>Record</span><span id="fo-record">—</span></div><div id="fo-history" style="margin-top:6px;font-size:10px;line-height:1.8;color:#8b8b96;"></div>`;
    document.body.appendChild(state.outEl);
  }
  state.outEl.style.display = state.outOn ? 'block' : 'none';
  if (state.outOn) { updateOutBox(); fetchRecord(); }
}
function usd(n) { const a = Math.abs(n); if (a >= 1e6) return '$' + (a / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return '$' + (a / 1e3).toFixed(1) + 'K'; return '$' + a.toFixed(0); }
function chip(ctx, text, x, y, bg, fg) {
  ctx.font = '10px JetBrains Mono, monospace';
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = bg; ctx.fillRect(x, y - 10, w, 14);
  ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + 4, y - 3);
}
function updatePanel() {
  if (!state.panelOn || !state.live) return;
  const L = state.live;
  const set = (id, t, c) => { const el = document.getElementById(id); if (el) { el.textContent = t; if (c) el.style.color = c; } };
  set('fi-pct', `R<${usd(L.bounds ? L.bounds.retailMax : L.pct.p75)} W>${usd(L.bounds ? L.bounds.whaleMin : L.pct.p95)}`);
  const rc = L.cls.retail.buy - L.cls.retail.sell, pc = L.cls.pro.buy - L.cls.pro.sell, wc = L.cls.whale.buy - L.cls.whale.sell;
  set('fi-retail', (rc >= 0 ? '+' : '') + usd(rc), rc >= 0 ? '#4CAF7D' : '#E05252');
  set('fi-pro', (pc >= 0 ? '+' : '') + usd(pc), pc >= 0 ? '#4CAF7D' : '#E05252');
  set('fi-whale', (wc >= 0 ? '+' : '') + usd(wc), wc >= 0 ? '#4CAF7D' : '#E05252');
  set('fi-herd', L.herd && L.herd.until > Date.now() ? `${L.herd.side} ${(L.herd.share * 100).toFixed(0)}%` : 'none');
  set('fi-study', String(L.studyTrades || 0));
}
function updateOutBox() {
  if (!state.outOn) return;
  const o = state.live ? state.live.outlook : null;
  const call = document.getElementById('fo-call');
  if (call) { call.textContent = o ? o.call.toUpperCase() : '—'; call.style.color = o ? (o.call === 'bull' ? '#4CAF7D' : o.call === 'bear' ? '#E05252' : '#f5cb42') : '#8b8b96'; }
  const conf = document.getElementById('fo-conf'); if (conf) conf.textContent = o ? Math.abs(o.score) + '/100' : '—';
  const rs = document.getElementById('fo-reasons'); if (rs) rs.innerHTML = o && o.reasons && o.reasons.length ? o.reasons.map(r => '• ' + r).join('<br>') : 'abhi koi strong signal nahi';
  const rec = document.getElementById('fo-record');
  if (rec && state.record && state.record.stats) rec.textContent = `${state.record.stats.correct}/${state.record.stats.total} (${state.record.stats.accuracyPct}%)`;
  const hist = document.getElementById('fo-history');
  if (hist && state.record && state.record.history) {
    hist.innerHTML = state.record.history.map(h => { const t = new Date(h.ts); const hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'); return `${hh} ${h.call.toUpperCase()} ${h.correct ? '✓' : '✗'} ${h.actual_pct > 0 ? '+' : ''}${h.actual_pct}%`; }).join('<br>') || 'koi resolved call nahi abhi';
  }
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
  if (state.events.length > 900) state.events.shift();
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
async function fetchRecord() {
  try {
    const res = await fetch(`${REST_BASE}/api/outlook?symbol=${currentSymbol()}`);
    const d = await res.json();
    state.record = d;
    updateOutBox();
    (d.history || []).forEach(h => pushEvent({ ts: h.ts, type: 'OUTLOOK_HIST', side: h.call, usd: 0, price: 0, meta: { correct: h.correct, pct: h.actual_pct } }));
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
  if (ev.type === 'OUTLOOK' || ev.type === 'OUTLOOK_HIST') {
    ctx.strokeStyle = 'rgba(212,184,134,0.4)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.clientHeight); ctx.stroke(); ctx.setLineDash([]);
    const tag = (ev.side || '').toUpperCase() + (ev.meta && ev.meta.correct === true ? ' ✓' : ev.meta && ev.meta.correct === false ? ' ✗' : '');
    chip(ctx, '📈' + tag, x + 2, 74, 'rgba(212,184,134,0.9)', '#111317');
    return;
  }
  if (ev.type === 'SPLIT_EXEC' && L.whale) {
    const y1 = series.priceToCoordinate(ev.meta.pMax), y2 = series.priceToCoordinate(ev.meta.pMin);
    if (y1 === null || y2 === null) return;
    const x2 = ts.timeToCoordinate(sec + 120) || x + 40;
    const w = Math.max(20, x2 - x), h = Math.max(8, y2 - y1);
    ctx.fillStyle = 'rgba(212,184,134,0.22)'; ctx.fillRect(x, y1, w, h);
    ctx.strokeStyle = 'rgba(212,184,134,0.9)'; ctx.lineWidth = 1.5; ctx.strokeRect(x, y1, w, h);
    chip(ctx, (ev.meta.action === 'ACCUMULATION' ? 'ACC ' : 'DIS ') + usd(ev.usd), x + 2, y1 - 4, 'rgba(212,184,134,0.95)', '#111317');
  } else if (ev.type === 'WHALE_PRINT' && L.whale) {
    const y = series.priceToCoordinate(ev.price); if (y === null) return;
    ctx.fillStyle = ev.side === 'buy' ? '#4CAF7D' : '#E05252';
    ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 7); ctx.lineTo(x - 6, y); ctx.closePath(); ctx.fill();
    chip(ctx, usd(ev.usd), x + 8, y, ev.side === 'buy' ? 'rgba(76,175,125,0.95)' : 'rgba(224,82,82,0.95)', '#fff');
  } else if (ev.type === 'SWEEP' && L.sweep) {
    const y = series.priceToCoordinate(ev.price); if (y === null) return;
    const up = ev.side === 'buy';
    ctx.strokeStyle = up ? '#4CAF7D' : '#E05252'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(x, y + (up ? 14 : -14)); ctx.lineTo(x, y + (up ? -2 : 2)); ctx.stroke();
    chip(ctx, 'SWEEP ' + (up ? '↑' : '↓'), x + 4, y + (up ? 26 : -18), up ? 'rgba(76,175,125,0.95)' : 'rgba(224,82,82,0.95)', '#fff');
  } else if (ev.type === 'ABSORPTION' && L.absorb) {
    const y = series.priceToCoordinate(ev.price); if (y === null) return;
    const x2 = ts.timeToCoordinate(sec + 60) || x + 24;
    ctx.fillStyle = 'rgba(90,200,250,0.4)'; ctx.fillRect(x, y - 4, Math.max(16, x2 - x), 8);
    chip(ctx, 'ABS ' + usd(ev.usd), x + 2, y - 8, 'rgba(90,200,250,0.95)', '#111317');
  } else if (ev.type === 'RETAIL_HERD' && L.herd) {
    const x2 = ts.timeToCoordinate(sec + 300) || x + 60;
    const w = Math.max(30, x2 - x);
    ctx.fillStyle = ev.side === 'buy' ? 'rgba(76,175,125,0.16)' : 'rgba(224,82,82,0.16)';
    ctx.fillRect(x, 0, w, canvas.clientHeight);
    ctx.strokeStyle = ev.side === 'buy' ? 'rgba(76,175,125,0.6)' : 'rgba(224,82,82,0.6)';
    ctx.setLineDash([3, 3]); ctx.strokeRect(x, 0, w, canvas.clientHeight); ctx.setLineDash([]);
    chip(ctx, `HERD ${ev.side.toUpperCase()} ${(ev.meta.share * 100).toFixed(0)}%`, x + 4, 96, ev.side === 'buy' ? 'rgba(76,175,125,0.95)' : 'rgba(224,82,82,0.95)', '#fff');
  }
}
function connect(symbol) {
  if (state.ws) { state.ws.onclose = null; try { state.ws.close(); } catch (e) {} state.ws = null; }
  clearTimeout(state.wsReconnect);
  state.symbol = symbol;
  state.ws = new WebSocket(`${WS_BASE}?symbol=${symbol.toLowerCase()}`);
  state.ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'flow_event') { pushEvent(msg.data); if (msg.data.type === 'OUTLOOK' && state.outOn) updateOutBox(); }
    else if (msg.type === 'flow_state') { state.live = msg.data; updatePanel(); updateBanner(); updateOutBox(); }
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
  marketStore.onSymbolChange(({ symbol }) => { state.events = []; connect(symbol); loadHistory(symbol); fetchRecord(); render(); });
}
function anyLayerOn() { return Object.values(state.layers).some(v => v); }
function toggleLayer(name) {
  state.layers[name] = !state.layers[name];
  ensureOverlay();
  if (anyLayerOn()) render(); else { state.overlay.clear(); }
  return state.layers[name];
}
function togglePanel() { state.panelOn = !state.panelOn; ensureBox(); updatePanel(); return state.panelOn; }
function toggleOutlook() { state.outOn = !state.outOn; ensureOutBox(); return state.outOn; }
ensureOverlay();
connect(currentSymbol());
loadHistory(currentSymbol());
fetchRecord();
setInterval(fetchRecord, 300000);
window.flowIntel = { toggleLayer, togglePanel, toggleOutlook, isActive: () => anyLayerOn() };
})();