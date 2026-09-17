(function () {
if (typeof chartEngine === 'undefined' || typeof window.chartOverlayUtils === 'undefined') return;
const WS_BASE = 'wss://m-edgetrade-api-server.onrender.com/ws/footprint';
const REST_BASE = 'https://m-edgetrade-api-server.onrender.com';
const RECONNECT_MS = 3000;
const state = { ws: null, wsReconnect: null, events: [], live: null, record: null, symbol: null, overlay: null, unsub: null, bannerEl: null, boxEl: null, outEl: null, drillEl: null, panelOn: false, outOn: false, layers: { whale: true, sweep: true, absorb: true, herd: true } };
const style = document.createElement('style');
 style.textContent = `.fi-banner{position:absolute;top:44px;left:50%;transform:translateX(-50%);z-index:9;background:rgba(255,82,82,0.16);border:1px solid #E05252;color:#ff8a8a;font-family:'JetBrains Mono',monospace;font-size:11.5px;padding:7px 12px;border-radius:8px;max-width:80%;text-align:center;pointer-events:none;} .fi-box{position:fixed;top:70px;left:20px;width:300px;background:#0f0f12;border:1px solid #2a2a30;border-radius:10px;z-index:999998;display:none;padding:14px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#EAECEF;} .fi-box2{position:fixed;top:70px;left:340px;width:330px;max-height:calc(100vh - 100px);overflow-y:auto;background:#0f0f12;border:1px solid #2a2a30;border-radius:10px;z-index:999998;display:none;padding:14px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#EAECEF;} .fi-row{display:flex;justify-content:space-between;margin:3px 0;} .fi-muted{color:#8b8b96;} .fo-hrow{padding:4px 2px;border-bottom:1px dashed #2a2a30;cursor:pointer;} .fo-hrow:hover{background:#1a1a20;} @media (max-width:560px){.fi-box,.fi-box2{width:calc(100vw - 24px) !important;left:12px !important;top:64px !important;max-height:calc(100vh - 80px);}}`;
document.head.appendChild(style);
function currentSymbol() { return (typeof marketStore !== 'undefined') ? marketStore.getState().symbol : 'BTCUSDT'; }
function usd(n) { const a = Math.abs(n); if (a >= 1e6) return '$' + (a / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return '$' + (a / 1e3).toFixed(1) + 'K'; return '$' + a.toFixed(0); }
function chip(ctx, text, x, y, bg, fg) { ctx.font = '10px JetBrains Mono, monospace'; const w = ctx.measureText(text).width + 8; ctx.fillStyle = bg; ctx.fillRect(x, y - 10, w, 14); ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + 4, y - 3); }
function ensureOverlay() {
  if (!state.overlay) {
    state.overlay = window.chartOverlayUtils.createOverlayCanvas('klineMainChart', 'fi-overlay');
    const chart = chartEngine.getInstance();
    if (chart) state.unsub = window.chartOverlayUtils.subscribeVisibleRangeRedraw(chart, render);
    new ResizeObserver(() => { if (state.overlay) { state.overlay.resize(); render(); } }).observe(document.getElementById('klineMainChart'));
  }
  state.overlay.canvas.style.display = 'block'; state.overlay.resize();
}
function ensureBanner() { if (!state.bannerEl) { state.bannerEl = document.createElement('div'); state.bannerEl.className = 'fi-banner'; state.bannerEl.style.display = 'none'; document.getElementById('klineMainChart').appendChild(state.bannerEl); } }
function ensureBox() {
  if (!state.boxEl) {
    state.boxEl = document.createElement('div'); state.boxEl.className = 'fi-box';
    state.boxEl.innerHTML = `<h4 style="margin:0 0 8px;font-size:12px;color:#D4B886;">🧠 Flow Intel</h4><div class="fi-row fi-muted"><span>Thresholds</span><span id="fi-pct">—</span></div><div class="fi-row"><span>Retail CVD</span><span id="fi-retail">—</span></div><div class="fi-row"><span>Pro CVD</span><span id="fi-pro">—</span></div><div class="fi-row"><span>Whale CVD</span><span id="fi-whale">—</span></div><div class="fi-row fi-muted"><span>Retail herd</span><span id="fi-herd">none</span></div><div class="fi-row fi-muted"><span>Study trades</span><span id="fi-study">0</span></div><div style="margin-top:8px;color:#8b8b96;font-size:9.5px;line-height:1.5;border-top:1px dashed #2a2a30;padding-top:6px;">CVD = market orders ka net paisa (buy − sell). + matlab aggressive buyers tod rahe, − matlab sellers. Retail = &lt;$1K trades · Pro = $1K–$100K · Whale = $100K+. Herd = retail ek side crowd → aksar ulta hota hai.</div>`;
    document.body.appendChild(state.boxEl);
  }
  state.boxEl.style.display = state.panelOn ? 'block' : 'none';
}
function ensureOutBox() {
  if (!state.outEl) {
    state.outEl = document.createElement('div'); state.outEl.className = 'fi-box2';
    state.outEl.innerHTML = `<h4 style="margin:0 0 8px;font-size:12px;color:#D4B886;">📈 Market Outlook</h4><div id="fo-call" style="font-size:16px;font-weight:bold;margin-bottom:4px;">—</div><div id="fo-action" style="font-size:12px;font-weight:bold;margin-bottom:6px;">—</div><div id="fo-pattern" style="font-size:10.5px;color:#D4B886;margin-bottom:4px;">—</div><div id="fo-pyramid" style="font-size:10.5px;color:#8b8b96;margin-bottom:4px;">—</div><div id="fo-tpsl" style="font-size:10.5px;color:#EAECEF;margin-bottom:4px;">—</div><div id="fo-desc" style="font-size:9.5px;color:#8b8b96;line-height:1.5;margin-bottom:4px;">—</div><div id="fo-regime" style="font-size:9.5px;color:#D4B886;margin-bottom:4px;">—</div><div id="fo-tune" style="font-size:9.5px;color:#8b8b96;margin-bottom:4px;">—</div><div class="fi-row fi-muted"><span>Confidence</span><span id="fo-conf">—</span></div><div class="fi-row fi-muted"><span>Horizon</span><span id="fo-horizon">—</span></div><div class="fi-row fi-muted"><span>Time left</span><span id="fo-left">—</span></div><div id="fo-reasons" style="margin:6px 0;color:#8b8b96;font-size:10px;line-height:1.6;"></div><div style="border-top:1px solid #2a2a30;margin:6px 0;"></div><div class="fi-row"><span>Record</span><span id="fo-record">—</span></div><div class="fi-row fi-muted"><span>Model</span><span id="fo-model">—</span></div><div style="color:#8b8b96;font-size:10px;margin:4px 0 2px;">History (click for full record):</div><div id="fo-history"></div>`;
    document.body.appendChild(state.outEl);
  }
  state.outEl.style.display = state.outOn ? 'block' : 'none';
  if (state.outOn) { updateOutBox(); fetchRecord(); }
}
function ensureDrill() { if (!state.drillEl) { state.drillEl = document.createElement('div'); state.drillEl.className = 'fi-box2'; document.body.appendChild(state.drillEl); } }
function computeAction() {
  const L = state.live; if (!L) return '—';
  const trapFresh = L.trap && Date.now() - L.trap.ts < 300000;
  if (trapFresh) return trapFresh.side === 'buy' ? '⚠ TRAP: avoid BUY → SELL side prefer' : '⚠ TRAP: avoid SELL → BUY side prefer';
  const o = L.outlook; if (!o) return '—';
  const conf = Math.abs(o.score);
  if (conf < 40 || o.call === 'range') return '⛔ NO TRADE — wait (confidence low)';
  return o.call === 'bull' ? '✅ BUY side ja sakte ho (conf ' + conf + ')' : '✅ SELL side ja sakte ho (conf ' + conf + ')';
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
  const act = document.getElementById('fo-action');
  if (act) { const a = computeAction(); act.textContent = a; act.style.color = a.indexOf('BUY') >= 0 && a.indexOf('avoid BUY') < 0 ? '#4CAF7D' : a.indexOf('SELL') >= 0 && a.indexOf('avoid SELL') < 0 ? '#E05252' : '#f5cb42'; }
  const conf = document.getElementById('fo-conf'); if (conf) conf.textContent = o ? Math.abs(o.score) + '/100' : '—';
  const hz = document.getElementById('fo-horizon'); if (hz) hz.textContent = o ? '1H candle' : '—';
  state.horizonEnd = o && o.horizonEnd ? o.horizonEnd : null;
  const rs = document.getElementById('fo-reasons'); if (rs) rs.innerHTML = o && o.reasons && o.reasons.length ? o.reasons.map(r => '• ' + r).join('<br>') : 'abhi koi strong signal nahi';
  const rec = document.getElementById('fo-record');
  if (rec && state.record && state.record.stats) { const s = state.record.stats; rec.textContent = `ALL ${s.correct}/${s.total} (${s.accuracyPct}%) · DIR ${s.dirCorrect}/${s.dirTotal} (${s.dirPct}%)`; }
  const md = document.getElementById('fo-model');
  if (md && state.record && state.record.model) md.textContent = state.record.model.samples ? `learned · n=${state.record.model.samples}` : 'priors (seekh raha hai)';
  const o2 = state.live ? state.live.outlook : null;
  const pt = document.getElementById('fo-pattern');
  if (pt) pt.textContent = o2 && o2.pattern ? `⏰ range-but-move pattern (sim ${o2.pattern.sim}) — past moves ~${o2.pattern.medianMin}m baad aaye; break watch karo` : '—';
  const py = document.getElementById('fo-pyramid');
  if (py) py.textContent = o2 && o2.pyramid ? `PYRAMID: ${o2.pyramid.level} pe add (guard ${o2.pyramid.guard}) · size ${o2.pyramid.size}` : '—';
  const tpsl = document.getElementById('fo-tpsl');
  if (tpsl) tpsl.textContent = o2 && o2.tp ? `TP ${o2.tp} · SL ${o2.sl} (vol-based, RR 1:2)` : 'TP/SL: range mode — koi trade nahi';
  const dsc = document.getElementById('fo-desc');
  if (dsc) dsc.textContent = o2 && o2.desc ? o2.desc : '—';
  const rg = document.getElementById('fo-regime');
  if (rg && state.record && state.record.model && state.record.model.regime) {
    const R = state.record.model.regime;
    rg.textContent = 'Regime record: ' + Object.keys(R).slice(0, 4).map(k => `${k} ${R[k].win}/${R[k].n}`).join(' · ');
  } else if (rg) rg.textContent = '—';
  const tn = document.getElementById('fo-tune');
  if (tn && state.record && state.record.model && state.record.model.regimeTune) {
    const T = state.record.model.regimeTune;
    tn.textContent = 'Self-tuning: ' + Object.keys(T).map(k => `${k}: SL ×${T[k].slMult}, conf +${T[k].confBoost} (stop-hunt ${Math.round(T[k].slHunt * 100)}%)`).join(' · ');
  } else if (tn) tn.textContent = '—';
  const hist = document.getElementById('fo-history');
  if (hist && state.record && state.record.history) {
    hist.innerHTML = state.record.history.map((h, i) => { const hh = new Date(h.ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true, hour: 'numeric', minute: '2-digit' }); const mv = h.move_usd != null ? (h.move_usd >= 0 ? '+' : '-') + '$' + Math.abs(Math.round(h.move_usd)) : ((h.actual_pct || 0) > 0 ? '+' : '') + h.actual_pct + '%';
    const ob = h.outcome === 'SL_THEN_TP' ? 'SL→TP' : h.outcome === 'TP_THEN_SL' ? 'TP→SL' : (h.outcome || '—');
    const du = h.move_dur_min != null ? ` · ${h.move_dur_min}m` : '';
    return `<div class="fo-hrow" data-i="${i}">${hh} ${h.call.toUpperCase()} ${h.correct ? '✓' : '✗'} ${mv}${du} · ${ob}</div>`; }).join('') || 'koi resolved call nahi abhi';
    hist.querySelectorAll('.fo-hrow').forEach(el => { el.onclick = () => openDrill(state.record.history[parseInt(el.getAttribute('data-i'), 10)]); });
  }
}
function openDrill(h) {
  if (!h) return;
  ensureDrill();
  const c = h.context || {};
  const d = state.drillEl;
  d.innerHTML = `<h4 style="margin:0 0 8px;font-size:12px;color:#D4B886;">📋 Call Record</h4>
  <div style="margin:4px 0;"><button id="fd-back" style="background:#2a2a30;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;">← Back</button></div>
  <div class="fi-row fi-muted"><span>Time</span><span>${new Date(h.ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true, hour: 'numeric', minute: '2-digit', day: '2-digit', month: 'short' })} IST</span></div>
  <div class="fi-row"><span>Call</span><span style="color:${h.call === 'bull' ? '#4CAF7D' : h.call === 'bear' ? '#E05252' : '#f5cb42'}">${h.call.toUpperCase()} (conf ${Math.abs(h.score || 0)})</span></div>
  <div class="fi-row"><span>Result</span><span style="color:${h.correct ? '#4CAF7D' : '#E05252'}">${h.correct ? 'PASS ✓' : 'FAIL ✗'} · market ${h.actual_dir} ${h.actual_pct > 0 ? '+' : ''}${h.actual_pct}%</span></div>
  <div class="fi-row fi-muted"><span>Start price</span><span>${h.price_at_call || '—'}</span></div>
  <div class="fi-row fi-muted"><span>End price</span><span>${h.end_price || '—'}</span></div>
  <div class="fi-row"><span>Move</span><span style="color:${(h.move_usd || 0) >= 0 ? '#4CAF7D' : '#E05252'}">${h.move_usd != null ? (h.move_usd >= 0 ? '+' : '-') + '$' + Math.abs(Math.round(h.move_usd)) + ' (' + ((h.actual_pct || 0) > 0 ? '+' : '') + h.actual_pct + '%)' : '—'}</span></div>
  <div class="fi-row fi-muted"><span>Max move</span><span>${h.max_move_usd != null ? (h.max_move_usd >= 0 ? '+' : '-') + '$' + Math.abs(Math.round(h.max_move_usd)) : '—'}</span></div>
  <div class="fi-row fi-muted"><span>Move aaya</span><span>${h.move_start_min != null ? h.move_start_min + 'm baad · countdown ' + h.countdown_at_move + 'm' : 'move nahi aaya'}</span></div>
  <div class="fi-row fi-muted"><span>Move chala</span><span>${h.move_dur_min != null ? h.move_dur_min + ' min tak' : '—'}</span></div>
  <div class="fi-row fi-muted"><span>SL / TP</span><span>${h.sl_price || '—'} / ${h.tp_price || '—'}</span></div>
  <div class="fi-row"><span>Outcome</span><span style="color:${(h.outcome || '').startsWith('TP') ? '#4CAF7D' : (h.outcome || '').startsWith('SL') ? '#E05252' : '#f5cb42'}">${h.outcome || '—'}${h.first_touch_min != null ? ' · first touch ' + h.first_touch_min + 'm' : ''}</span></div>
  ${h.outcome === 'SL_THEN_TP' ? '<div style="color:#E05252;font-size:10px;margin:2px 0;">⚠ SL pehle hit (stop-hunt), phir TP — real 200x trade SL mein out hota. Is setup mein SL chhota mat rakho.</div>' : ''}
  <div class="fi-row fi-muted"><span>Against move</span><span>${h.against_usd != null ? (h.against_usd >= 0 ? '+' : '-') + '$' + Math.abs(Math.round(h.against_usd)) : '—'}</span></div>
  <div class="fi-row fi-muted"><span>Regime</span><span>${h.regime || '—'}</span></div>
  <div class="fi-row fi-muted"><span>Aapke liye</span><span>${(h.user_call || 'range').toUpperCase()}${h.pattern_bucket ? ' · ' + h.pattern_bucket : ''}</span></div>
  ${h.desc_text ? `<div style="color:#8b8b96;font-size:9.5px;line-height:1.5;margin-top:4px;">${h.desc_text}</div>` : ''}
  <div style="border-top:1px solid #2a2a30;margin:6px 0;"></div>
  <div style="color:#8b8b96;font-size:10px;margin-bottom:4px;">US WAQT KA MARKET CONTEXT:</div>
  <div class="fi-row"><span>Retail CVD</span><span>${c.retail_cvd != null ? usd(c.retail_cvd) : '—'}</span></div>
  <div class="fi-row"><span>Pro CVD</span><span>${c.pro_cvd != null ? usd(c.pro_cvd) : '—'}</span></div>
  <div class="fi-row"><span>Whale CVD</span><span>${c.whale_cvd != null ? usd(c.whale_cvd) : '—'}</span></div>
  <div class="fi-row fi-muted"><span>Retail herd</span><span>${c.herd ? c.herd.side + ' ' + Math.round(c.herd.share * 100) + '%' : 'none'}</span></div>
  <div style="border-top:1px solid #2a2a30;margin:6px 0;"></div>
  <div style="color:#8b8b96;font-size:10px;line-height:1.6;">${(h.reasons || []).map(r => '• ' + r).join('<br>') || '—'}</div>`;
  d.style.display = 'block';
  document.getElementById('fd-back').onclick = () => { d.style.display = 'none'; };
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
    (d.history || []).forEach(h => pushEvent({ ts: h.ts, type: 'OUTLOOK_HIST', side: h.call, usd: 0, price: 0, meta: { correct: h.correct } }));
  } catch (e) {}
}
function drawHUD(ctx, canvas) {
  if (!state.live) return;
  const c = state.live.cls;
  const defs = [['RETAIL', c.retail], ['PRO', c.pro], ['WHALE', c.whale]];
  const y0 = canvas.clientHeight - 34;
  ctx.fillStyle = 'rgba(15,15,18,0.88)'; ctx.fillRect(0, y0 - 8, canvas.clientWidth, 42);
  let x = 8;
  defs.forEach(([name, o]) => {
    const tot = o.buy + o.sell;
    ctx.font = '9px JetBrains Mono, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#8b8b96'; ctx.fillText(name, x, y0); x += 42;
    const wB = tot > 0 ? (o.buy / tot) * 80 : 40, wS = tot > 0 ? (o.sell / tot) * 80 : 40;
    ctx.fillStyle = 'rgba(76,175,125,0.85)'; ctx.fillRect(x, y0 - 4, wB, 8);
    ctx.fillStyle = 'rgba(224,82,82,0.85)'; ctx.fillRect(x + wB, y0 - 4, wS, 8);
    ctx.fillStyle = '#EAECEF'; ctx.fillText((o.buy - o.sell >= 0 ? '+' : '') + usd(o.buy - o.sell), x + 86, y0); x += 170;
  });
}
function render() {
  if (!state.overlay) return;
  const series = chartEngine.getSeries(); const chart = chartEngine.getInstance();
  if (!series || !chart) return;
  const { ctx, canvas } = state.overlay;
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  const ts = chart.timeScale();
  const L = state.layers;
  if (L.herd && state.live && state.live.herd && state.live.herd.until > Date.now() && state.live.herd.ts) {
    const hx = ts.timeToCoordinate(Math.floor(state.live.herd.ts / 1000) + 19800);
    const hx2 = ts.timeToCoordinate(Math.floor(Date.now() / 1000) + 19800);
    if (hx !== null) {
      const w = Math.max(30, (hx2 == null ? hx + 30 : hx2) - hx);
      ctx.fillStyle = state.live.herd.side === 'buy' ? 'rgba(76,175,125,0.16)' : 'rgba(224,82,82,0.16)';
      ctx.fillRect(hx, 0, w, canvas.clientHeight);
      ctx.strokeStyle = state.live.herd.side === 'buy' ? 'rgba(76,175,125,0.6)' : 'rgba(224,82,82,0.6)';
      ctx.setLineDash([3, 3]); ctx.strokeRect(hx, 0, w, canvas.clientHeight); ctx.setLineDash([]);
      chip(ctx, `LIVE HERD ${state.live.herd.side.toUpperCase()} ${(state.live.herd.share * 100).toFixed(0)}%`, hx + 4, 96, state.live.herd.side === 'buy' ? 'rgba(76,175,125,0.95)' : 'rgba(224,82,82,0.95)', '#fff');
    }
  }
  state.events.forEach(ev => drawEvent(ev, ts, series, ctx, canvas));
  if (L.whale || L.sweep || L.absorb || L.herd) drawHUD(ctx, canvas);
}
function drawEvent(ev, ts, series, ctx, canvas) {
  const sec = Math.floor(ev.ts / 1000) + 19800;
  const x = ts.timeToCoordinate(sec);
  if (x === null || x < -80 || x > canvas.clientWidth + 80) return;
  const L = state.layers;
  if (ev.type === 'OUTLOOK' || ev.type === 'OUTLOOK_HIST') {
    ctx.strokeStyle = 'rgba(212,184,134,0.4)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.clientHeight); ctx.stroke(); ctx.setLineDash([]);
    chip(ctx, '📈' + (ev.side || '').toUpperCase() + (ev.meta && ev.meta.correct === true ? '✓' : ev.meta && ev.meta.correct === false ? '✗' : ''), x + 2, 74, 'rgba(212,184,134,0.9)', '#111317');
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
    chip(ctx, `HERD ${ev.side.toUpperCase()} ${(ev.meta.share * 100).toFixed(0)}%`, x + 4, 116, ev.side === 'buy' ? 'rgba(76,175,125,0.95)' : 'rgba(224,82,82,0.95)', '#fff');
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
    else if (msg.type === 'flow_state') { state.live = msg.data; updatePanel(); updateBanner(); updateOutBox(); render(); }
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
function toggleLayer(name) { state.layers[name] = !state.layers[name]; ensureOverlay(); render(); return state.layers[name]; }
function togglePanel() { state.panelOn = !state.panelOn; ensureBox(); updatePanel(); return state.panelOn; }
function toggleOutlook() { state.outOn = !state.outOn; ensureOutBox(); if (!state.outOn && state.drillEl) state.drillEl.style.display = 'none'; return state.outOn; }
ensureOverlay();
connect(currentSymbol());
loadHistory(currentSymbol());
fetchRecord();
setInterval(fetchRecord, 300000);
setInterval(() => {
  const el = document.getElementById('fo-left');
  if (!el) return;
  if (!state.outOn || !state.horizonEnd) { el.textContent = '—'; return; }
  const ms = state.horizonEnd - Date.now();
  if (ms <= 0) { el.textContent = 'window khatam → re-decide...'; return; }
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  el.textContent = m + 'm ' + String(s).padStart(2, '0') + 's';
}, 1000);
window.flowIntel = { toggleLayer, togglePanel, toggleOutlook, isActive: () => anyLayerOn() };
})();
