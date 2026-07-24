// ══════════════════════════════════════════════════════════════════════════
// chart-terminal/chart-engine.js
//
// Owns the klinecharts instance. Responsible for:
//   - Initializing the chart into a container
//   - Feeding it historical + live candle data (from market-store.js ONLY —
//     this file never touches Binance or a WebSocket directly)
//   - Chart type switching (candle / hollow / ohlc / area)
//   - Indicator create/remove (MA, EMA, BOLL, VOL, MACD, RSI, KDJ)
//
// This file does NOT own any toolbar buttons or dropdown UI — that belongs
// to chart-cockpit.js, which calls the public functions exposed below.
//
// Depends on: market-store.js (must be loaded first) and the klinecharts
// CDN script (already loaded in index.html <head>).
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
  let chartInstance = null;
  let containerId = 'klineMainChart';
  let currentChartType = 'candle_solid';
  let activeIndicators = {}; // { MA: paneId, RSI: paneId, ... }

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

  // Indicators that render as an overlay on the candle pane itself, vs. ones
  // that get their own separate pane below the chart.
  const OVERLAY_ON_CANDLE = { MA: true, EMA: true, BOLL: true, VOL: false, MACD: false, RSI: false, KDJ: false };

  const CHART_TYPE_STYLE_MAP = {
    candle_solid: 'candle_solid',
    candle_stroke: 'candle_stroke',
    ohlc: 'ohlc',
    area: 'area',
  };

  // ── Init ────────────────────────────────────────────────────────────────
  // Call once the DOM container exists. Wires itself to market-store so it
  // automatically re-renders whenever the active symbol/interval changes.
  function init(opts = {}) {
    containerId = opts.containerId || containerId;

    if (typeof klinecharts === 'undefined') {
      console.error('[chart-engine] klinecharts library not found — check the CDN <script> tag in index.html');
      return null;
    }

    const container = document.getElementById(containerId);
    if (!container) {
      console.error('[chart-engine] container not found:', containerId);
      return null;
    }

    if (chartInstance) return chartInstance; // already initialized, don't double-init

    chartInstance = klinecharts.init(containerId);
    if (!chartInstance) {
      console.error('[chart-engine] klinecharts.init() returned null');
      return null;
    }

    chartInstance.setStyles({
      grid: { show: true, horizontal: { color: '#2a2a2a' }, vertical: { color: '#2a2a2a' } },
      candle: { bar: { upColor: '#4CAF7D', downColor: '#E05252', noChangeColor: '#888888' }, type: currentChartType },
    });

    // Countdown badge — a plain DOM overlay, NOT a klinecharts overlay, so it
    // never interferes with chart pan/zoom (pointer-events: none).
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
      currentCandleTimestamp = null; // old candle's timestamp is stale for the new interval/symbol
    });

    // Seed interval from whatever market-store is already set to (covers the
    // case where marketStore.init() ran before chartEngine.init()).
    const initialState = marketStore.getState();
    currentIntervalMs = INTERVAL_MS[initialState.interval] || INTERVAL_MS['1m'];

    startCountdown();

    return chartInstance;
  }

  function applyHistory(candles) {
    if (!chartInstance) return;
    chartInstance.applyNewData(candles);
    if (candles.length) currentCandleTimestamp = candles[candles.length - 1].timestamp;
  }

  function applyLiveCandle(candle) {
    if (!chartInstance) return;
    chartInstance.updateData(candle);
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
    chartInstance.setStyles({ candle: { type } });
    currentChartType = type;
  }

  function getChartType() {
    return currentChartType;
  }

  // ── Indicators ─────────────────────────────────────────────────────────
  // Toggle on/off. overlayOnCandle can be passed explicitly, otherwise falls
  // back to the sensible default per indicator name.
  function toggleIndicator(name, overlayOnCandle) {
    if (!chartInstance) return;

    if (activeIndicators[name]) {
      chartInstance.removeIndicator(activeIndicators[name], name);
      delete activeIndicators[name];
      return false; // now inactive
    }

    const overlay = overlayOnCandle !== undefined ? overlayOnCandle : !!OVERLAY_ON_CANDLE[name];
    const paneId = overlay
      ? chartInstance.createIndicator(name, true, { id: 'candle_pane' })
      : chartInstance.createIndicator(name);

    activeIndicators[name] = paneId;
    return true; // now active
  }

  function isIndicatorActive(name) {
    return !!activeIndicators[name];
  }

  function getActiveIndicators() {
    return { ...activeIndicators };
  }

  // ── Access / cleanup ──────────────────────────────────────────────────
  function getInstance() {
    return chartInstance;
  }

  function destroy() {
    if (chartInstance && typeof klinecharts.dispose === 'function') {
      klinecharts.dispose(containerId);
    }
    chartInstance = null;
    activeIndicators = {};

    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (countdownEl && countdownEl.parentNode) { countdownEl.parentNode.removeChild(countdownEl); }
    countdownEl = null;
    currentCandleTimestamp = null;
  }

  // ── Expose ───────────────────────────────────────────────────────────
  window.chartEngine = {
    init,
    setChartType,
    getChartType,
    toggleIndicator,
    isIndicatorActive,
    getActiveIndicators,
    getInstance,
    destroy,
  };

})();

// ══════════════════════════════════════════════════════════════════════════
// USAGE (for chart-cockpit.js):
//
//   chartEngine.init({ containerId: 'klineMainChart' });
//   marketStore.init({ symbol: 'BTCUSDT', interval: '1m' }); // any order is fine,
//                                                              // engine binds its
//                                                              // listeners in init()
//
//   // timeframe dropdown click:
//   marketStore.setInterval('5m');   // engine auto re-renders via its market-store listeners
//
//   // chart type dropdown click:
//   chartEngine.setChartType('area');
//
//   // indicator toggle click:
//   const isNowOn = chartEngine.toggleIndicator('MA');
//   button.classList.toggle('active-tool', isNowOn);
// ══════════════════════════════════════════════════════════════════════════
