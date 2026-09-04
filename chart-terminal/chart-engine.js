// ══════════════════════════════════════════════════════════════════════════
// chart-terminal/chart-engine.js
//
// Owns the TradingView Lightweight Charts instance. Responsible for:
//   - Initializing the chart into a container
//   - Feeding it historical + live candle data (from market-store.js ONLY —
//     this file never touches Binance or a WebSocket directly)
//   - Chart type switching (candle / hollow / ohlc / area)
//
// Indicators (MA/EMA/BOLL/VOL/MACD/RSI/KDJ) and drawing tools are NOT
// available in Lightweight Charts — no built-in indicator/drawing engine.
// This file keeps the same public API (toggleIndicator / isIndicatorActive /
// getActiveIndicators) as safe no-ops so chart-cockpit.js's existing buttons
// don't throw or get stuck "active" — hide/disable those buttons in
// chart-cockpit.js's UI itself; this is just the data-layer fallback.
//
// This file does NOT own any toolbar buttons or dropdown UI — that belongs
// to chart-cockpit.js, which calls the public functions exposed below.
//
// Depends on: market-store.js (must be loaded first) and the Lightweight
// Charts CDN script, which MUST be swapped in index.html BEFORE this file
// loads. Replace the old klinecharts <script> tag with:
//
//   <script src="https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js"></script>
//
// which exposes the global `LightweightCharts` namespace (v5 API — uses
// chart.addSeries(LightweightCharts.CandlestickSeries, opts) style calls).
// ══════════════════════════════════════════════════════════════════════════

(function () {

  if (typeof marketStore === 'undefined') {
    console.error('[chart-engine] market-store.js must be loaded before chart-engine.js');
    return;
  }

  // ── Countdown badge style ───────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .ce-countdown{position:absolute;top:8px;right:8px;background:rgba(20,20,20,0.75);color:#EAECEF;font-family:'JetBrains Mono',monospace;font-size:11px;padding:3px 8px;border-radius:6px;pointer-events:none;z-index:5;letter-spacing:0.5px;}
  `;
  document.head.appendChild(style);

  // ── Internal state ────────────────────────────────────────────────────
  let chartInstance = null;   // LightweightCharts chart object
  let seriesInstance = null;  // current active series (candlestick/bar/area)
  let containerId = 'klineMainChart';
  let currentChartType = 'candle_solid';

  // Our own copy of the data — needed because Lightweight Charts can't morph
  // a series' type in place. To change chart type we remove the old series
  // and add a new one, then replay this buffer onto it.
  let candleBuffer = []; // [{ timestamp, open, high, low, close, volume }, ...]

  // Duration of each interval in milliseconds — used to compute the next
  // candle's close time for the countdown badge.
  const INTERVAL_MS = {
    '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000,
    '1h': 3600000, '2h': 7200000, '4h': 14400000, '6h': 21600000, '12h': 43200000,
    '1d': 86400000, '1w': 604800000, '1M': 2592000000,
  };

  // ── Countdown state ─────────────────────────────────────────────────────
  let countdownEl = null;
  let countdownTimer = null;
  let currentCandleTimestamp = null; // start time (ms) of the currently forming candle
  let currentIntervalMs = INTERVAL_MS['1m'];

  // Kept identical to the old chart-engine so chart-cockpit.js's dropdown
  // doesn't need to change which string values it sends in.
  const CHART_TYPE_STYLE_MAP = {
    candle_solid: 'candle_solid',
    candle_stroke: 'candle_stroke', // hollow candle
    ohlc: 'ohlc',
    area: 'area',
  };

  const UP_COLOR = '#4CAF7D';
  const DOWN_COLOR = '#E05252';

  // ── Init ────────────────────────────────────────────────────────────────
  function init(opts = {}) {
    containerId = opts.containerId || containerId;

    if (typeof LightweightCharts === 'undefined') {
      console.error('[chart-engine] LightweightCharts library not found — check the CDN <script> tag in index.html');
      return null;
    }

    const container = document.getElementById(containerId);
    if (!container) {
      console.error('[chart-engine] container not found:', containerId);
      return null;
    }

    if (chartInstance) return chartInstance; // already initialized, don't double-init

    chartInstance = LightweightCharts.createChart(container, {
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: '#B0B4BB',
      },
      grid: {
        vertLines: { color: '#2a2a2a' },
        horzLines: { color: '#2a2a2a' },
      },
      autoSize: true,
      timeScale: { timeVisible: true, secondsVisible: false },
    });

    createSeries(currentChartType);

    // Countdown badge — a plain DOM overlay, sits on top of the chart canvas.
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    countdownEl = document.createElement('div');
    countdownEl.className = 'ce-countdown';
    countdownEl.textContent = '--:--';
    container.appendChild(countdownEl);

    // Bind to market-store — this is the ONLY place chart-engine receives data.
    marketStore.onKlineHistory(applyHistory);
    marketStore.onKline(applyLiveCandle);
    marketStore.onSymbolChange(({ interval }) => {
      currentIntervalMs = INTERVAL_MS[interval] || INTERVAL_MS['1m'];
      currentCandleTimestamp = null;
      candleBuffer = [];
    });

    const initialState = marketStore.getState();
    currentIntervalMs = INTERVAL_MS[initialState.interval] || INTERVAL_MS['1m'];

    startCountdown();

    return chartInstance;
  }

  // ── Series creation per chart type ──────────────────────────────────────
  async function drawWhaleWalls(series) {
    try {
      const res = await fetch('https://m-edgetrade-api-server.onrender.com/api/whale-walls');
      const walls = await res.json();
      if (!walls.length) return;

      const maxVal = Math.max(...walls.map(w => w.total_value_usd));

      walls.forEach(w => {
        const alpha = Math.max(0.2, w.total_value_usd / maxVal);
        const color = w.side === 'BUY' ? `rgba(76, 175, 80, ${alpha})` : `rgba(255, 82, 82, ${alpha})`;
        const valM = (w.total_value_usd / 1000000).toFixed(1) + 'M';

        series.createPriceLine({
          price: parseFloat(w.price),
          color: color,
          lineWidth: 2,
          lineStyle: 3,
          axisLabelVisible: true,
          title: `${w.side} $${valM}`
        });
      });
    } catch (e) { console.error(e); }
  }

  function createSeries(type) {
    if (!chartInstance) return;
    if (seriesInstance) {
      chartInstance.removeSeries(seriesInstance);
      seriesInstance = null;
    }

    switch (type) {
      case 'candle_stroke': // hollow candle — up candles outlined only, down candles solid
        seriesInstance = chartInstance.addSeries(LightweightCharts.CandlestickSeries, {
          upColor: 'rgba(0,0,0,0)',
          downColor: DOWN_COLOR,
          borderVisible: true,
          borderUpColor: UP_COLOR,
          borderDownColor: DOWN_COLOR,
          wickUpColor: UP_COLOR,
          wickDownColor: DOWN_COLOR,
        });
        break;
      case 'ohlc':
        seriesInstance = chartInstance.addSeries(LightweightCharts.BarSeries, {
          upColor: UP_COLOR,
          downColor: DOWN_COLOR,
        });
        break;
      case 'area':
        seriesInstance = chartInstance.addSeries(LightweightCharts.AreaSeries, {
          lineColor: '#D4B886',
          topColor: 'rgba(212,184,134,0.35)',
          bottomColor: 'rgba(212,184,134,0.02)',
        });
        break;
      case 'candle_solid':
      default:
        seriesInstance = chartInstance.addSeries(LightweightCharts.CandlestickSeries, {
          upColor: UP_COLOR,
          downColor: DOWN_COLOR,
          borderVisible: false,
          wickUpColor: UP_COLOR,
          wickDownColor: DOWN_COLOR,
        });
        break;
    }

      if (type === 'candle_stroke' || type === 'candle_solid') drawWhaleWalls(seriesInstance);

    // Re-apply whatever data we already have onto the fresh series.
    if (candleBuffer.length) seriesInstance.setData(toSeriesData(candleBuffer, type));
  }

  // ── Data shaping ─────────────────────────────────────────────────────────
  // market-store candles look like { timestamp (ms), open, high, low, close, volume }.
  // Lightweight Charts wants `time` in seconds; area series wants a single
  // `value` instead of OHLC.
  function toSeriesData(candles, type) {
    if (type === 'area') {
      return candles.map(c => ({ time: Math.floor(c.timestamp / 1000), value: c.close }));
    }
    return candles.map(c => ({
      time: Math.floor(c.timestamp / 1000),
      open: c.open, high: c.high, low: c.low, close: c.close,
    }));
  }

  function toSeriesPoint(c, type) {
    if (type === 'area') return { time: Math.floor(c.timestamp / 1000), value: c.close };
    return { time: Math.floor(c.timestamp / 1000), open: c.open, high: c.high, low: c.low, close: c.close };
  }

  function applyHistory(candles) {
    if (!chartInstance || !seriesInstance) return;
    candleBuffer = candles.slice();
    seriesInstance.setData(toSeriesData(candleBuffer, currentChartType));
    if (candles.length) currentCandleTimestamp = candles[candles.length - 1].timestamp;
  }

  function applyLiveCandle(candle) {
    if (!chartInstance || !seriesInstance) return;

    // Keep our buffer in sync (replace last candle if same timestamp, else push).
    const last = candleBuffer[candleBuffer.length - 1];
    if (last && last.timestamp === candle.timestamp) {
      candleBuffer[candleBuffer.length - 1] = candle;
    } else {
      candleBuffer.push(candle);
    }

    seriesInstance.update(toSeriesPoint(candle, currentChartType));
    currentCandleTimestamp = candle.timestamp;
  }

  // ── Countdown to next candle close ──────────────────────────────────────
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

  // ── Chart type ─────────────────────────────────────────────────────────
  function setChartType(type) {
    if (!chartInstance || !CHART_TYPE_STYLE_MAP[type] || type === currentChartType) return;
    currentChartType = type;
    createSeries(type);
  }

  function getChartType() {
    return currentChartType;
  }

  // ── Indicators — NOT AVAILABLE in Lightweight Charts yet ────────────────
  // Kept as safe no-ops (same function names/signatures as before) so
  // chart-cockpit.js's existing indicator buttons don't error out or get
  // stuck in a fake "active" state.
  function toggleIndicator(name) {
    console.info(`[chart-engine] Indicators not available yet on Lightweight Charts (${name}). Coming in a later pass.`);
    return false;
  }

  function isIndicatorActive() {
    return false;
  }

  function getActiveIndicators() {
    return {};
  }

  // ── Access / cleanup ──────────────────────────────────────────────────
  function getInstance() {
    return chartInstance;
  }

  function getSeries() {
    return seriesInstance;
  }

  function destroy() {
    if (chartInstance) {
      chartInstance.remove();
    }
    chartInstance = null;
    seriesInstance = null;
    candleBuffer = [];

    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (countdownEl && countdownEl.parentNode) { countdownEl.parentNode.removeChild(countdownEl); }
    countdownEl = null;
    currentCandleTimestamp = null;
  }

  let pocLines = [];
  window.addEventListener('drawPocLines', (e) => {
    const top5Poc = e.detail;
    pocLines.forEach(line => seriesInstance.removePriceLine(line));
    pocLines = [];
    top5Poc.forEach((pocPrice, index) => {
      const line = seriesInstance.createPriceLine({
        price: pocPrice,
        color: '#FFD700',
        lineWidth: index === 0 ? 3 : 1,
        lineStyle: 0,
        axisLabelVisible: true,
        title: index === 0 ? 'POC' : `HVN ${index}`
      });
      pocLines.push(line);
    });
  });

  // ── Expose ───────────────────────────────────────────────────────────
  window.chartEngine = {
    init,
    setChartType,
    getChartType,
    toggleIndicator,
    isIndicatorActive,
    getActiveIndicators,
    getInstance,
    getSeries,
    destroy,
  };

})();

// ══════════════════════════════════════════════════════════════════════════
// USAGE (for chart-cockpit.js) — UNCHANGED from the klinecharts version:
//
//   chartEngine.init({ containerId: 'klineMainChart' });
//   marketStore.init({ symbol: 'BTCUSDT', interval: '1m' });
//
//   // timeframe dropdown click:
//   marketStore.setInterval('5m');
//
//   // chart type dropdown click:
//   chartEngine.setChartType('area');
//
//   // indicator toggle click — now a safe no-op, always returns false:
//   const isNowOn = chartEngine.toggleIndicator('MA');
//   button.classList.toggle('active-tool', isNowOn); // will just stay off
// ══════════════════════════════════════════════════════════════════════════
