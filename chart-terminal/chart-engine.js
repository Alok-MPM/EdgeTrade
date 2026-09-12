// ══════════════════════════════════════════════════════════════════════════
// PASTE INSTRUCTION
// FILE: chart-terminal/chart-engine.js
// ACTION: REPLACE ENTIRE FILE (single part — ~330 lines, 460-limit ke andar)
// NOTE: Whale-wall lifecycle (symbol-aware fetch + 45s refresh + prune),
//       POC/HVN single-owner (drawPocLines, guarded), buffer cap.
//       Companion surgical blocks (server.js + pulse.js) Box 2 mein hain.
// ══════════════════════════════════════════════════════════════════════════
(function () {
if (typeof marketStore === 'undefined') {
console.error('[chart-engine] market-store.js must be loaded before chart-engine.js');
return;
}
const REST_BASE = 'https://m-edgetrade-api-server.onrender.com';
const WALL_REFRESH_MS = 45000; // backend walls ~60s mein expire hoti hain; usse tez refresh
const MAX_CANDLE_BUFFER = 2000;
const style = document.createElement('style');
style.textContent = `.ce-countdown{position:absolute;top:8px;right:8px;background:rgba(20,20,20,0.75);color:#EAECEF;font-family:'JetBrains Mono',monospace;font-size:11px;padding:3px 8px;border-radius:6px;pointer-events:none;z-index:5;letter-spacing:0.5px;}`;
document.head.appendChild(style);
let chartInstance = null;
let seriesInstance = null;
let containerId = 'klineMainChart';
let currentChartType = 'candle_solid';
let candleBuffer = [];
const INTERVAL_MS = {
'1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000,
'1h': 3600000, '2h': 7200000, '4h': 14400000, '6h': 21600000, '12h': 43200000,
'1d': 86400000, '1w': 604800000, '1M': 2592000000,
};
let countdownEl = null;
let countdownTimer = null;
let currentCandleTimestamp = null;
let currentIntervalMs = INTERVAL_MS['1m'];
const CHART_TYPE_STYLE_MAP = { candle_solid: 'candle_solid', candle_stroke: 'candle_stroke', ohlc: 'ohlc', area: 'area' };
const UP_COLOR = '#4CAF7D';
const DOWN_COLOR = '#E05252';
// ── Whale wall price-lines lifecycle (single owner: yahan) ────────────
let wallLines = [];
let wallSeries = null;
let wallRefreshTimer = null;
let wallSymbol = null;
// ── POC/HVN price-lines lifecycle (single owner: yahan, event-driven) ─
let pocLines = [];
let pocSeries = null;
function init(opts = {}) {
containerId = opts.containerId || containerId;
if (typeof LightweightCharts === 'undefined') {
  console.error('[chart-engine] LightweightCharts library not found — check the CDN <script> tag in index.html');
  return null;
}
const container = document.getElementById(containerId);
if (!container) { console.error('[chart-engine] container not found:', containerId); return null; }
if (chartInstance) return chartInstance;
chartInstance = LightweightCharts.createChart(container, {
  layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#B0B4BB' },
  grid: { vertLines: { color: '#2a2a2a' }, horzLines: { color: '#2a2a2a' } },
  autoSize: true,
  timeScale: { timeVisible: true, secondsVisible: false },
});
createSeries(currentChartType);
if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
countdownEl = document.createElement('div');
countdownEl.className = 'ce-countdown';
countdownEl.textContent = '--:--';
container.appendChild(countdownEl);
marketStore.onKlineHistory(applyHistory);
marketStore.onKline(applyLiveCandle);
marketStore.onSymbolChange(({ symbol, interval }) => {
  currentIntervalMs = INTERVAL_MS[interval] || INTERVAL_MS['1m'];
  currentCandleTimestamp = null;
  candleBuffer = [];
  pruneWallLines();
  refreshWhaleWalls(symbol);
});
const initialState = marketStore.getState();
currentIntervalMs = INTERVAL_MS[initialState.interval] || INTERVAL_MS['1m'];
wallSymbol = initialState.symbol;
refreshWhaleWalls(initialState.symbol);
clearInterval(wallRefreshTimer);
wallRefreshTimer = setInterval(() => refreshWhaleWalls(), WALL_REFRESH_MS);
startCountdown();
return chartInstance;
}
function pruneWallLines() {
if (wallSeries && wallSeries === seriesInstance) {
  wallLines.forEach(l => { try { wallSeries.removePriceLine(l); } catch (e) {} });
}
wallLines = [];
wallSeries = null;
}
async function refreshWhaleWalls(symbol) {
if (symbol) wallSymbol = symbol;
if (!chartInstance || !seriesInstance) return;
try {
  const res = await fetch(`${REST_BASE}/api/whale-walls?symbol=${encodeURIComponent((wallSymbol || 'BTCUSDT').toUpperCase())}`);
  const walls = await res.json();
  pruneWallLines();
  if (!Array.isArray(walls) || !walls.length) return;
  const maxVal = Math.max(...walls.map(w => w.total_value_usd));
  walls.forEach(w => {
    const alpha = Math.max(0.2, w.total_value_usd / maxVal);
    const color = w.side === 'BUY' ? `rgba(76, 175, 80, ${alpha})` : `rgba(255, 82, 82, ${alpha})`;
    const line = seriesInstance.createPriceLine({
      price: parseFloat(w.price), color: color, lineWidth: 2, lineStyle: 3,
      axisLabelVisible: true, title: `${w.side} ${(w.total_value_usd / 1000000).toFixed(1)}M`,
    });
    wallLines.push(line);
  });
  wallSeries = seriesInstance;
} catch (e) { console.error('[chart-engine] whale walls fetch failed', e); }
}
function createSeries(type) {
if (!chartInstance) return;
if (seriesInstance) { chartInstance.removeSeries(seriesInstance); seriesInstance = null; }
switch (type) {
  case 'candle_stroke':
    seriesInstance = chartInstance.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: 'rgba(0,0,0,0)', downColor: DOWN_COLOR, borderVisible: true,
      borderUpColor: UP_COLOR, borderDownColor: DOWN_COLOR, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
    });
    break;
  case 'ohlc':
    seriesInstance = chartInstance.addSeries(LightweightCharts.BarSeries, { upColor: UP_COLOR, downColor: DOWN_COLOR });
    break;
  case 'area':
    seriesInstance = chartInstance.addSeries(LightweightCharts.AreaSeries, {
      lineColor: '#D4B886', topColor: 'rgba(212,184,134,0.35)', bottomColor: 'rgba(212,184,134,0.02)',
    });
    break;
  case 'candle_solid':
  default:
    seriesInstance = chartInstance.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
    });
    break;
}
refreshWhaleWalls(); // har chart type pe walls (pehle sirf candle modes thi)
if (candleBuffer.length) seriesInstance.setData(toSeriesData(candleBuffer, type));
}
function toSeriesData(candles, type) {
if (type === 'area') return candles.map(c => ({ time: Math.floor(c.timestamp / 1000), value: c.close }));
return candles.map(c => ({ time: Math.floor(c.timestamp / 1000), open: c.open, high: c.high, low: c.low, close: c.close }));
}
function toSeriesPoint(c, type) {
if (type === 'area') return { time: Math.floor(c.timestamp / 1000), value: c.close };
return { time: Math.floor(c.timestamp / 1000), open: c.open, high: c.high, low: c.low, close: c.close };
}
function applyHistory(candles) {
if (!chartInstance || !seriesInstance) return;
candleBuffer = candles.slice(-MAX_CANDLE_BUFFER);
seriesInstance.setData(toSeriesData(candleBuffer, currentChartType));
if (candles.length) currentCandleTimestamp = candles[candles.length - 1].timestamp;
}
function applyLiveCandle(candle) {
if (!chartInstance || !seriesInstance) return;
const last = candleBuffer[candleBuffer.length - 1];
if (last && last.timestamp === candle.timestamp) {
  candleBuffer[candleBuffer.length - 1] = candle;
} else {
  candleBuffer.push(candle);
  if (candleBuffer.length > MAX_CANDLE_BUFFER) candleBuffer.shift();
}
seriesInstance.update(toSeriesPoint(candle, currentChartType));
currentCandleTimestamp = candle.timestamp;
}
function startCountdown() {
if (countdownTimer) clearInterval(countdownTimer);
countdownTimer = setInterval(updateCountdown, 1000);
updateCountdown();
}
function updateCountdown() {
if (!countdownEl) return;
if (!currentCandleTimestamp) { countdownEl.textContent = '--:--'; return; }
const remainingMs = (currentCandleTimestamp + currentIntervalMs) - Date.now();
countdownEl.textContent = formatCountdown(remainingMs);
}
function formatCountdown(ms) {
const totalSec = Math.max(0, Math.floor(ms / 1000));
const h = Math.floor(totalSec / 3600);
const m = Math.floor((totalSec % 3600) / 60);
const s = totalSec % 60;
const pad = (n) => String(n).padStart(2, '0');
return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function setChartType(type) {
if (!chartInstance || !CHART_TYPE_STYLE_MAP[type] || type === currentChartType) return;
currentChartType = type;
createSeries(type);
}
function getChartType() { return currentChartType; }
// Indicators — abhi no-op (custom series/plugins se batch-3 mein banenge,
// sirf wo jo tum use karte ho). Buttons ko throw nahi hone denge.
function toggleIndicator(name) {
console.info(`[chart-engine] Indicators not available yet on Lightweight Charts (${name}). Coming in a later pass.`);
return false;
}
function isIndicatorActive() { return false; }
function getActiveIndicators() { return {}; }
// ── POC/HVN lines — single owner yahan. pulse.js sirf event dispatch karta hai.
window.addEventListener('drawPocLines', (e) => {
const top5Poc = Array.isArray(e.detail) ? e.detail : [];
if (!seriesInstance) { pocLines = []; pocSeries = null; return; }
if (pocSeries && pocSeries === seriesInstance) {
  pocLines.forEach(l => { try { pocSeries.removePriceLine(l); } catch (err) {} });
}
pocLines = [];
pocSeries = seriesInstance;
top5Poc.forEach((pocObj, index) => {
  const volText = pocObj.vol > 1000 ? (pocObj.vol / 1000).toFixed(1) + 'k' : pocObj.vol.toFixed(1);
  const line = seriesInstance.createPriceLine({
    price: pocObj.price,
    color: '#FFD700',
    lineWidth: index === 0 ? 3 : 1,
    lineStyle: 0,
    axisLabelVisible: index === 0, // POC ka axis label ek hi baar (duplicate se bachat)
    title: index === 0 ? `POC (${volText})` : `HVN ${index} (${volText})`,
  });
  pocLines.push(line);
});
});
function getInstance() { return chartInstance; }
function getSeries() { return seriesInstance; }
function destroy() {
clearInterval(wallRefreshTimer); wallRefreshTimer = null;
pruneWallLines();
pocLines = []; pocSeries = null;
if (chartInstance) chartInstance.remove();
chartInstance = null;
seriesInstance = null;
candleBuffer = [];
if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
if (countdownEl && countdownEl.parentNode) countdownEl.parentNode.removeChild(countdownEl);
countdownEl = null;
currentCandleTimestamp = null;
}
window.chartEngine = { init, setChartType, getChartType, toggleIndicator, isIndicatorActive, getActiveIndicators, getInstance, getSeries, destroy };
})();
// ══════════════════════════════════════════════════════════════════════════
// USAGE (chart-cockpit.js ke liye unchanged):
//   chartEngine.init({ containerId: 'klineMainChart' });
//   marketStore.init({ symbol: 'BTCUSDT', interval: '1m' });
//   marketStore.setInterval('5m');  chartEngine.setChartType('area');
// ══════════════════════════════════════════════════════════════════════════
