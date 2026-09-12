// ══════════════════════════════════════════════════════════════════════════
// PASTE / AGENT INSTRUCTION
// FILE: chart-terminal/pulse.js
// ACTION: REPLACE ENTIRE FILE (single part — ~175 lines, 460-line limit ke andar)
// NOTE: Fixed backend ke naye fields use karta hai (poi: poc, oi, oiDelta,
//       cvdDelta, bias, distanceToPoc, pocSource, top5Poc). Purane backend
//       ke saath bhi graceful fallback. Koi doosri file modify mat karna.
// ══════════════════════════════════════════════════════════════════════════
(function () {
const REST_BASE = 'https://m-edgetrade-api-server.onrender.com';
const WS_BASE = 'wss://m-edgetrade-api-server.onrender.com/ws/footprint';
const REFRESH_MS = 20000; // box khula rahe to POC/verdict khud taaza hote rahen
let isVisible = false;
let refreshTimer = null;
let ws = null;
let wsReconnectTimer = null;
let currentSymbol = (typeof marketStore !== 'undefined') ? marketStore.getState().symbol : 'BTCUSDT';
const box = document.createElement('div');
box.id = 'pulse-box';
box.style.cssText = `position: fixed; top: 70px; right: 20px; width: 340px; max-height: calc(100vh - 90px); overflow-y: auto; background: #0f0f12; border-left: 1px solid #2a2a30; z-index: 999999; display: none; flex-direction: column; padding: 20px; font-family: 'JetBrains Mono', monospace; box-shadow: 0 10px 30px rgba(0,0,0,0.5);`;
box.innerHTML = `
    <h3 style="color: #EAECEF; margin-top: 0; font-size: 14px; border-bottom: 1px solid #2a2a30; padding-bottom: 10px;">⚡ Market Pulse AI</h3>
    <div style="margin-top: 15px;">
        <div style="color: #8b8b96; font-size: 11px;">Current POC (Point of Control)</div>
        <div id="p-poc" style="color: #f5cb42; font-size: 18px; font-weight: bold;">Loading...</div>
    </div>
    <div style="margin-top: 15px;">
        <div style="display: flex; align-items: center; justify-content: space-between; color: #8b8b96; font-size: 11px;">
            <span>Open Interest (OI)</span>
            <select id="tf-selector" style="background: #1a1a20; color: #EAECEF; border: 1px solid #2a2a30; padding: 3px; font-size: 11px;">
                <option value="5m">5m</option>
                <option value="15m">15m</option>
                <option value="1h" selected>1h</option>
                <option value="4h">4h</option>
                <option value="1d">1d</option>
            </select>
        </div>
        <div id="p-oi" style="color: #EAECEF; font-size: 14px;">Loading...</div>
        <div id="p-oidelta" style="color: #8b8b96; font-size: 10px; margin-top: 2px;">—</div>
    </div>
    <div style="margin-top: 15px;">
        <div style="color: #8b8b96; font-size: 11px;">Cum. Volume Delta (CVD, window)</div>
        <div id="p-cvd" style="font-size: 14px;">Loading...</div>
        <div id="p-cvd-live" style="color: #8b8b96; font-size: 10px; margin-top: 2px;">—</div>
    </div>
    <div style="margin-top: 25px; background: #1a1a20; padding: 12px; border-radius: 6px; border: 1px solid #2a2a30;">
        <div style="color: #8b8b96; font-size: 11px; margin-bottom: 5px;">Backend Verdict</div>
        <div id="p-verdict" style="font-size: 14px; font-weight: bold; margin-bottom: 8px;">Analyzing...</div>
        <div id="p-narrative" style="color: #EAECEF; font-size: 12px; line-height: 1.4;">Waiting for tick data...</div>
    </div>
    <button onclick="window.pulse.toggle()" style="margin-top: auto; background: #2a2a30; color: white; border: none; padding: 10px; cursor: pointer; border-radius: 4px;">Close Pulse Box</button>
`;
document.body.appendChild(box);
function fmtPrice(n) { return '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 }); }
function signed(n) { const v = Number(n); return (v > 0 ? '+' : '') + v.toFixed(2); }
function verdictColor(data) {
  if (data.bias === 'bull') return '#4CAF7D';
  if (data.bias === 'bear') return '#E05252';
  if (data.bias) return '#f5cb42';
  return data.type === 'real' ? '#4CAF7D' : (data.type === 'trap' ? '#E05252' : '#f5cb42');
}
const updatePulseFromApi = async () => {
  const tf = document.getElementById('tf-selector').value;
  const verdictEl = document.getElementById('p-verdict');
  try {
    const res = await fetch(`${REST_BASE}/api/pulse-ai?tf=${encodeURIComponent(tf)}&symbol=${encodeURIComponent(currentSymbol)}`);
    const data = await res.json();
    if (data.waiting || data.error) {
      verdictEl.innerText = data.message || data.error || 'Waiting...';
      verdictEl.style.color = '#f5cb42';
      document.getElementById('p-poc').innerText = 'Loading...';
      document.getElementById('p-narrative').innerText = 'Waiting for tick data...';
      return;
    }
    // POC — single source: data.poc (profile-folded). Panel text aur chart line dono isi se.
    document.getElementById('p-poc').innerText = fmtPrice(data.poc);
    if (Array.isArray(data.top5Poc) && data.top5Poc.length) {
      window.dispatchEvent(new CustomEvent('drawPocLines', { detail: data.top5Poc }));
    }
    // POC/HVN chart lines chart-engine.js own karta hai (drawPocLines event se)
    // OI — absolute value OI label ke neeche; window delta alag line pe
    if (typeof data.oi === 'number' && data.oi > 0) document.getElementById('p-oi').innerText = data.oi.toLocaleString() + ' BTC';
    document.getElementById('p-oidelta').innerText = `Δ(${tf}): ${signed(data.oiDelta)} BTC`;
    // CVD — window delta main line; live 5m bucket alag line (WS update karta hai)
    const cvdEl = document.getElementById('p-cvd');
    cvdEl.innerText = signed(data.cvdDelta);
    cvdEl.style.color = Number(data.cvdDelta) >= 0 ? '#4CAF7D' : '#E05252';
    // Verdict — color usi logic se jo text decide karta hai (bias), fallback type
    verdictEl.innerText = data.verdict || 'Neutral';
    verdictEl.style.color = verdictColor(data);
    // Distance — backend-computed (null-guarded), client-side mix nahi
    const dist = (data.distanceToPoc != null) ? Number(data.distanceToPoc).toFixed(2) : '—';
    document.getElementById('p-narrative').innerText = `Distance to POC: ${dist}${data.pocSource ? '  [' + data.pocSource + ']' : ''}`;
  } catch (error) {
    verdictEl.innerText = 'Pulse API unavailable';
    verdictEl.style.color = '#E05252';
  }
};
document.getElementById('tf-selector').addEventListener('change', updatePulseFromApi);
// WS — sirf live OI + live 5m bucket delta ke liye. POC/verdict REST ka kaam hai.
function connectWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(`${WS_BASE}?symbol=${currentSymbol.toLowerCase()}`);
  ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type !== 'pulse' || !isVisible) return;
    const d = msg.data || {};
    if (typeof d.oi === 'number' && d.oi > 0) document.getElementById('p-oi').innerText = d.oi.toLocaleString() + ' BTC';
    if (typeof d.cvd === 'number') {
      const el = document.getElementById('p-cvd-live');
      el.innerText = `live 5m: ${signed(d.cvd)}`;
      el.style.color = d.cvd >= 0 ? '#4CAF7D' : '#E05252';
    }
  };
  ws.onclose = () => { clearTimeout(wsReconnectTimer); wsReconnectTimer = setTimeout(connectWs, 3000); };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}
if (typeof marketStore !== 'undefined') {
  marketStore.onSymbolChange(({ symbol }) => {
    currentSymbol = symbol;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'subscribe', symbol: symbol }));
    if (isVisible) updatePulseFromApi();
  });
}
window.pulse = {
  toggle: () => {
    isVisible = !isVisible;
    box.style.display = isVisible ? 'flex' : 'none';
    if (isVisible) {
      connectWs();
      updatePulseFromApi();
      clearInterval(refreshTimer);
      refreshTimer = setInterval(updatePulseFromApi, REFRESH_MS);
    } else {
      clearInterval(refreshTimer); refreshTimer = null;
      window.dispatchEvent(new CustomEvent('drawPocLines', { detail: [] }));
    }
    return isVisible;
  },
};
// Pulse button ab chart-cockpit.js own karta hai (ctc-pulse-btn) — DOM scan loop removed.
})();
