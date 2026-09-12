// ══════════════════════════════════════════════════════════════════════════
// PASTE / AGENT INSTRUCTION
// FILE: chart-terminal/whale-tracker.js
// ACTION: REPLACE ENTIRE FILE (single part — ~130 lines, 460-limit ke andar)
// NOTE: Client-side bugs fix. Markers tabhi dikhte hain jab backend mein
//       whale-absorption phase engine add hoga (batch 2 — abhi producer
//       missing hai, isliye ye file abhi khaali rahegi: expected hai).
// ══════════════════════════════════════════════════════════════════════════
(function () {
const WS_BASE = 'wss://m-edgetrade-api-server.onrender.com/ws/footprint';
const REST_BASE = 'https://m-edgetrade-api-server.onrender.com';
const RECONNECT_DELAY_MS = 3000;
const MAX_MARKERS = 200;
let ws = null;
let wsReconnectTimer = null;
let activeMarkers = [];
let markerKeys = new Set(); // dedupe by time+phase, not just second
let isEnabled = false;
let currentSymbol = 'BTCUSDT';
async function loadHistory(symbol) {
  try {
    const res = await fetch(`${REST_BASE}/api/whale-history?symbol=${symbol}`);
    if (!res.ok) return;
    const history = await res.json();
    (history || []).forEach(item => {
      addMarkerData({ time: item.timestamp_ms, price: item.price, message: item.phase || '', rSell: item.retail_amount || 0, smBuy: item.whale_amount || 0 }, false);
    });
    updateChartMarkers();
  } catch (e) { console.error('[whale-tracker] history load failed', e); }
}
function connect(symbol) {
  if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} ws = null; }
  clearTimeout(wsReconnectTimer);
  if (!isEnabled) return;
  currentSymbol = symbol;
  activeMarkers = [];
  markerKeys = new Set();
  loadHistory(symbol);
  ws = new WebSocket(`${WS_BASE}?symbol=${symbol.toLowerCase()}`);
  ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'whale_alert') addMarkerData(msg, true);
  };
  ws.onclose = () => { if (isEnabled) wsReconnectTimer = setTimeout(() => connect(currentSymbol), RECONNECT_DELAY_MS); };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}
// Phase 1 = absorption (retail panic-sell into smart-money limit buy) => bearish-pressure marker
// Phase 3 = markup => bullish marker; default neutral gold circle
function markerStyle(message) {
  if (message.includes('Phase 1')) return { color: '#E05252', position: 'aboveBar', shape: 'arrowDown' };
  if (message.includes('Phase 3')) return { color: '#4CAF7D', position: 'belowBar', shape: 'arrowUp' };
  return { color: '#D4B886', position: 'belowBar', shape: 'circle' };
}
function addMarkerData(data, shouldUpdateInstantly) {
  if (!isEnabled) return;
  const timeInSeconds = Math.floor(data.time / 1000);
  const key = timeInSeconds + '|' + (data.message || '');
  if (markerKeys.has(key)) return;
  markerKeys.add(key);
  const st = markerStyle(data.message || '');
  activeMarkers.push({
    time: timeInSeconds, position: st.position, color: st.color, shape: st.shape,
    text: `${data.message}\nR-Sell: $${((data.rSell || 0) / 1000).toFixed(0)}k\nSM-Buy: $${((data.smBuy || 0) / 1000).toFixed(0)}k`,
  });
  if (activeMarkers.length > MAX_MARKERS) {
    activeMarkers = activeMarkers.slice(-MAX_MARKERS);
    markerKeys = new Set(activeMarkers.map(m => m.time + '|' + m.text.split('\n')[0]));
  }
  if (shouldUpdateInstantly) updateChartMarkers();
}
function updateChartMarkers() {
  const series = (window.chartEngine && window.chartEngine.getSeries) ? window.chartEngine.getSeries() : null;
  if (!series) return;
  activeMarkers.sort((a, b) => a.time - b.time);
  if (typeof series.setMarkers === 'function') {
    series.setMarkers(activeMarkers); // lightweight-charts v4
  } else if (window.LightweightCharts && typeof window.LightweightCharts.createSeriesMarkers === 'function') {
    if (!updateChartMarkers._plugin) updateChartMarkers._plugin = window.LightweightCharts.createSeriesMarkers(series, activeMarkers);
    else updateChartMarkers._plugin.setMarkers(activeMarkers); // v5 plugin API
  }
}
function clearChartMarkers() {
  const series = (window.chartEngine && window.chartEngine.getSeries) ? window.chartEngine.getSeries() : null;
  if (!series) return;
  if (typeof series.setMarkers === 'function') series.setMarkers([]);
  else if (updateChartMarkers._plugin) updateChartMarkers._plugin.setMarkers([]);
}
function toggle() {
  isEnabled = !isEnabled;
  if (isEnabled) {
    connect((window.marketStore && window.marketStore.getState) ? window.marketStore.getState().symbol : 'BTCUSDT');
  } else {
    clearTimeout(wsReconnectTimer);
    if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} ws = null; }
    activeMarkers = [];
    markerKeys = new Set();
    clearChartMarkers();
  }
  return isEnabled;
}
function bindSymbolChange() {
  if (window.marketStore) window.marketStore.onSymbolChange(({ symbol }) => { if (isEnabled) connect(symbol); });
  else setTimeout(bindSymbolChange, 1000);
}
bindSymbolChange();
window.whaleTracker = { toggle };
})();
