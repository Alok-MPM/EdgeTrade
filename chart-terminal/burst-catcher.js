(function () {
if (typeof chartEngine === 'undefined' || typeof window.chartOverlayUtils === 'undefined' || typeof marketStore === 'undefined') return;
const WS_BASE = 'wss://m-edgetrade-api-server.onrender.com/ws/footprint';
const REST_BASE = 'https://m-edgetrade-api-server.onrender.com';
const IST = 19800;
const state = { active: true, ws: null, wsT: null, st: null, events: [], rows: [], overlay: null, unsub: null, strip: null, list: null, listOpen: false, symbol: null };
const style = document.createElement('style');
style.textContent = `.bc-strip{position:absolute;top:34px;left:8px;z-index:8;max-width:72%;background:rgba(15,15,18,0.93);border:1px solid #2a2a30;border-radius:8px;padding:7px 10px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#EAECEF;cursor:pointer;line-height:1.55;} .bc-list{position:absolute;top:80px;left:8px;z-index:8;width:320px;max-height:42%;overflow-y:auto;background:#0f0f12;border:1px solid #2a2a30;border-radius:8px;padding:8px;font-family:'JetBrains Mono',monospace;font-size:10px;display:none;line-height:1.6;} .bc-row{padding:3px 0;border-bottom:1px dashed #2a2a30;}`;
document.head.appendChild(style);
function rs(move, entry) { return entry > 0 ? Math.round(200 * 200 * (move / entry) - 40) : 0; }
function ensureUI() {
  const cont = document.getElementById('klineMainChart');
  if (!cont || state.strip) return;
  state.strip = document.createElement('div'); state.strip.className = 'bc-strip'; state.strip.textContent = '🎯 Burst-Catcher loading...';
  state.list = document.createElement('div'); state.list.className = 'bc-list';
  cont.appendChild(state.strip); cont.appendChild(state.list);
  state.strip.onclick = () => { state.listOpen = !state.listOpen; state.list.style.display = state.listOpen ? 'block' : 'none'; renderList(); };
}
function renderList() {
  if (!state.list) return;
  state.list.innerHTML = (state.rows.slice(0, 12).map(r => {
    const t = new Date(r.ts_entry).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true, hour: 'numeric', minute: '2-digit' });
    const mv = r.move_usd != null ? (r.move_usd >= 0 ? '+' : '-') + '$' + Math.abs(Math.round(r.move_usd)) : '—';
    const pnl = (r.move_usd != null && r.entry_price) ? ((rs(r.move_usd, r.entry_price) >= 0 ? '+' : '') + '₹' + Math.abs(rs(r.move_usd, r.entry_price))) : '';
    return `<div class="bc-row">${t} ${(r.side || '').toUpperCase()} ${r.join || ''} → ${r.outcome || 'OPEN'} · ${mv} ${pnl}</div>`;
  }).join('')) || 'koi burst record nahi abhi';
}
function updateStrip() {
  if (!state.strip) return;
  const s = state.st;
  if (!s) { state.strip.textContent = '🎯 Burst-Catcher: backend se state ka wait...'; return; }
  const evw = s.evw ? '⚠EVENT(SL×1.5) ' : '';
  if (s.phase === 'IN' && s.pos) {
    const lp = marketStore.getLatestPrice ? (marketStore.getLatestPrice() || s.pos.entry) : s.pos.entry;
    const sign = s.pos.side === 'bull' ? 1 : -1;
    const move = (lp - s.pos.entry) * sign;
    state.strip.innerHTML = `${evw}🎯 <b style="color:${s.pos.side === 'bull' ? '#4CAF7D' : '#E05252'}">${s.pos.side.toUpperCase()}</b> · entry ${s.pos.entry} · SL ${s.pos.sl} (${s.pos.join}) · run ${move >= 0 ? '+' : '-'}$${Math.abs(Math.round(move))} · ≈₹${rs(move, s.pos.entry)} fees ke baad`;
  } else if (s.phase === 'ARMED' && s.burst) {
    state.strip.innerHTML = `${evw}⏳ BURST ${s.burst.dir.toUpperCase()} · range $${s.burst.range} · ${s.burst.volMult}x vol — pullback (38-62%) ya breakout ka wait`;
  } else if (s.phase === 'TRAP-WATCH') {
    state.strip.innerHTML = `⚠ TRAP-SUSPECT burst — trade nahi (retail herd / OI against)`;
  } else {
    const pri = s.priors && s.priors.stats ? ` · hist: PB ${s.priors.stats.pullback.winPct}%/${s.priors.stats.pullback.n} BO ${s.priors.stats.breakout.winPct}%/${s.priors.stats.breakout.n}` : ' · hist: mining pending';
    const last = state.rows[0];
    const lastTxt = last ? ` · last: ${last.outcome} ${last.move_usd != null ? (last.move_usd >= 0 ? '+$' + Math.round(last.move_usd) : '-$' + Math.abs(Math.round(last.move_usd))) : ''}` : '';
    state.strip.innerHTML = `${evw}🎯 FLAT — burst scan on${pri}${lastTxt}`;
  }
}
function render() {
  if (!state.active || !state.overlay) return;
  const series = chartEngine.getSeries(); const chart = chartEngine.getInstance();
  if (!series || !chart) return;
  const { ctx, canvas } = state.overlay;
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  const ts = chart.timeScale();
  const drawMark = (sec, price, color, label, dy) => {
    const x = ts.timeToCoordinate(sec + IST); if (x === null || x < -60 || x > canvas.clientWidth + 60) return;
    const y = series.priceToCoordinate(price); if (y === null) return;
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    if (label) { ctx.font = '10px JetBrains Mono, monospace'; const w = ctx.measureText(label).width + 8; ctx.fillStyle = color; ctx.fillRect(x + 6, y - 8 + (dy || 0), w, 14); ctx.fillStyle = '#111317'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(label, x + 10, y - 1 + (dy || 0)); }
  };
  state.rows.forEach(r => {
    if (r.entry_price) drawMark(Math.floor(r.ts_entry / 1000), r.entry_price, r.side === 'bull' ? '#4CAF7D' : '#E05252', `${r.join || ''} ${r.outcome || 'OPEN'}`, -18);
    if (r.resolved && r.exit_price) drawMark(Math.floor(r.ts_exit / 1000), r.exit_price, (r.move_usd || 0) >= 0 ? '#D4B886' : '#8b8b96', `${r.outcome} ${r.move_usd != null ? (r.move_usd >= 0 ? '+$' + Math.round(r.move_usd) : '-$' + Math.abs(Math.round(r.move_usd))) : ''}`, 14);
  });
  state.events.forEach(ev => {
    if (ev.kind === 'TRAP-SKIP') drawMark(Math.floor(ev.ts / 1000), ev.price, '#f5cb42', 'TRAP-SKIP', -18);
  });
  if (state.st && state.st.phase === 'IN' && state.st.pos) {
    const y = series.priceToCoordinate(state.st.pos.sl);
    if (y !== null) { ctx.strokeStyle = '#E05252'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.clientWidth, y); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = '#E05252'; ctx.font = '10px JetBrains Mono, monospace'; ctx.textAlign = 'left'; ctx.fillText('TRAIL SL ' + state.st.pos.sl, 6, y - 5); }
  }
}
function connect(symbol) {
  if (state.ws) { state.ws.onclose = null; try { state.ws.close(); } catch (e) {} state.ws = null; }
  clearTimeout(state.wsT);
  state.symbol = symbol;
  state.ws = new WebSocket(`${WS_BASE}?symbol=${symbol.toLowerCase()}`);
  state.ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'burst_state') { state.st = msg.data; updateStrip(); render(); }
    else if (msg.type === 'burst_event') {
      if (!state.events.some(x => x.ts === msg.data.ts && x.kind === msg.data.kind)) { state.events.push(msg.data); if (state.events.length > 200) state.events.shift(); }
      if (msg.data.kind === 'ENTRY' || msg.data.kind === 'EXIT') loadRows();
      updateStrip(); render();
    }
  };
  state.ws.onclose = () => { state.wsT = setTimeout(() => connect(state.symbol), 3000); };
  state.ws.onerror = () => { try { state.ws.close(); } catch (e) {} };
}
async function loadRows() {
  try {
    const r = await fetch(`${REST_BASE}/api/burst-signals?symbol=${marketStore.getState().symbol}&limit=40`);
    state.rows = await r.json() || [];
    updateStrip(); renderList(); render();
  } catch (e) {}
}
function ensureOverlay() {
  if (!state.overlay) {
    state.overlay = window.chartOverlayUtils.createOverlayCanvas('klineMainChart', 'bc-overlay');
    const chart = chartEngine.getInstance();
    if (chart) state.unsub = window.chartOverlayUtils.subscribeVisibleRangeRedraw(chart, render);
    new ResizeObserver(() => { if (state.overlay) { state.overlay.resize(); render(); } }).observe(document.getElementById('klineMainChart'));
  }
  state.overlay.canvas.style.display = 'block'; state.overlay.resize();
}
function toggle() {
  state.active = !state.active;
  ensureUI();
  if (state.active) { ensureOverlay(); connect(marketStore.getState().symbol); loadRows(); state.strip.style.display = 'block'; }
  else { if (state.ws) { state.ws.onclose = null; try { state.ws.close(); } catch (e) {} state.ws = null; } if (state.overlay) { state.overlay.clear(); state.overlay.canvas.style.display = 'none'; } state.strip.style.display = 'none'; state.list.style.display = 'none'; }
  return state.active;
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.active && (!state.ws || state.ws.readyState !== WebSocket.OPEN)) connect(state.symbol || marketStore.getState().symbol); });
marketStore.onSymbolChange(({ symbol }) => { if (!state.active) return; state.rows = []; state.events = []; connect(symbol); loadRows(); });
ensureUI(); ensureOverlay(); connect(marketStore.getState().symbol); loadRows(); updateStrip();
window.burstCatcher = { toggle, isActive: () => state.active };
})();
