// ══════════════════════════════════════════════════════════════════════════
// chart-terminal/chart-split.js
//
// Split-screen layout (1 / 2-horizontal / 2-vertical panes) + sync toggles
// (Symbol, Interval, Crosshair) between Pane 1 (the main chart owned by
// chart-engine.js) and Pane 2 (a second, independent Lightweight Charts
// instance + its own Binance connection, owned entirely by this file).
//
// IMPORTANT: this file does NOT modify chart-cockpit.js. It injects its own
// "Layout" button into the existing #ctc-cockpit toolbar at init() time.
// This keeps every file independently editable — if you need to change
// anything about split-screen, this is the ONLY file you open.
//
// Depends on: market-store.js, chart-engine.js, chart-cockpit.js (all three
// must load first — chart-cockpit.js builds #ctc-cockpit which this file
// injects into).
// ══════════════════════════════════════════════════════════════════════════

(function () {

  if (typeof marketStore === 'undefined' || typeof chartEngine === 'undefined') {
    console.error('[chart-split] market-store.js and chart-engine.js must load before chart-split.js');
    return;
  }

  const BINANCE_REST = 'https://api.binance.com/api/v3';
  const BINANCE_WS = 'wss://stream.binance.com:9443';

  // ── Style ────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .cs-panes{display:flex;gap:10px;width:100%;height:620px;flex-shrink:0;}
    /* Fullscreen gives .chart-workspace a real, definite viewport height
       (position:fixed;inset:0 from index.css), so here — and only here —
       it's safe to let the panes flex-fill that height instead of staying
       locked at 620px, otherwise a dead gap is left below the chart. */
    .chart-workspace.ct-chart-fullscreen .cs-panes{height:auto;flex:1 1 auto;min-height:0;}
    .cs-panes.layout-1{}
    .cs-panes.layout-2h{flex-direction:row;}
    .cs-panes.layout-2v{flex-direction:column;}
    .cs-pane{flex:1;min-width:0;min-height:0;position:relative;display:flex;flex-direction:column;background:var(--bg2,#111317);border:1px solid var(--border,rgba(255,255,255,0.08));border-radius:8px;overflow:hidden;}
    /* Lightweight Charts' own canvas is transparent by design (chart-engine.js
       never sets a pane background) — it always relied on this container's CSS
       background showing through. That's fine at normal size, but on the
       big, sudden resize into fullscreen the canvas can lag a beat behind,
       exposing whatever's underneath. Forcing the background directly on
       the chart's own container (not just an ancestor) means there's never
       a gap to show through, regardless of canvas resize timing. */
    #klineMainChart,#klineChart2{background:var(--bg2,#111317);}
    .cs-pane{cursor:pointer;}
    .cs-pane.cs-pane-active{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold) inset;}
    .cs-pane-hidden{display:none;}
    .cs-pane-label{position:absolute;top:6px;left:8px;z-index:5;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted,#8a8f98);background:rgba(0,0,0,0.4);padding:2px 6px;border-radius:4px;}

    .cs-dd{padding:10px;min-width:230px;left:auto;right:0;}
    .cs-grid-list{display:flex;gap:8px;margin-bottom:10px;}
    .cs-grid-opt{width:42px;height:42px;flex:0 0 auto;border:1px solid var(--border,rgba(255,255,255,0.1));border-radius:6px;cursor:pointer;display:flex;padding:6px;gap:3px;background:var(--bg);}
    .cs-grid-opt.active{border-color:var(--gold);background:var(--gold-dim);}
    .cs-grid-opt-1{}
    .cs-grid-opt-1 .cs-swatch{width:100%;height:100%;border:1.5px solid var(--muted,#8a8f98);border-radius:2px;background:transparent;box-sizing:border-box;}
    .cs-grid-opt-2h{flex-direction:row;}
    .cs-grid-opt-2h .cs-swatch{flex:1;border:1.5px solid var(--muted,#8a8f98);border-radius:2px;background:transparent;box-sizing:border-box;}
    .cs-grid-opt-2v{flex-direction:column;}
    .cs-grid-opt-2v .cs-swatch{flex:1;border:1.5px solid var(--muted,#8a8f98);border-radius:2px;background:transparent;box-sizing:border-box;}
    .cs-grid-opt.active .cs-swatch{border-color:var(--gold);}

    .cs-sync-title{font-size:11px;color:var(--muted,#8a8f98);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;}
    .cs-sync-row{display:flex;align-items:center;justify-content:space-between;padding:6px 0;font-size:12.5px;color:var(--text,#EAECEF);}
    .cs-toggle{position:relative;width:34px;height:20px;flex-shrink:0;}
    .cs-toggle input{opacity:0;width:0;height:0;}
    .cs-toggle-slider{position:absolute;inset:0;background:var(--bg4);border-radius:20px;cursor:pointer;transition:0.15s;}
    .cs-toggle-slider::before{content:'';position:absolute;width:14px;height:14px;left:3px;top:3px;background:#fff;border-radius:50%;transition:0.15s;}
    .cs-toggle input:checked + .cs-toggle-slider{background:var(--gold);}
    .cs-toggle input:checked + .cs-toggle-slider::before{transform:translateX(14px);}

    .cs-icon-btn{padding:7px 10px;}
    .cs-ico{display:flex;width:15px;height:15px;gap:2px;flex-shrink:0;}
    .cs-ico i{border:1.5px solid currentColor;border-radius:2px;display:block;box-sizing:border-box;}
    .cs-ico-1{}
    .cs-ico-1 i{width:100%;height:100%;}
    .cs-ico-2h{flex-direction:row;}
    .cs-ico-2h i{flex:1;height:100%;}
    .cs-ico-2v{flex-direction:column;}
    .cs-ico-2v i{width:100%;flex:1;}
    .cs-ico-fs{width:15px;height:15px;position:relative;flex-shrink:0;}
    .cs-ico-fs i{position:absolute;width:6px;height:6px;border:1.5px solid currentColor;}
    .cs-ico-fs i:nth-child(1){top:0;left:0;border-right:none;border-bottom:none;}
    .cs-ico-fs i:nth-child(2){top:0;right:0;border-left:none;border-bottom:none;}
    .cs-ico-fs i:nth-child(3){bottom:0;left:0;border-right:none;border-top:none;}
    .cs-ico-fs i:nth-child(4){bottom:0;right:0;border-left:none;border-top:none;}

    /* Fullscreen must fully own the screen. Instead of relying on
       z-index/paint order (fragile — some mobile browsers don't repaint a
       freshly-fixed element right away, letting old content flash through),
       we explicitly remove the side panels and bottom dock from the render
       tree for the duration of fullscreen. This makes bleed-through
       impossible rather than just visually unlikely. */
    .top-row:has(.chart-workspace.ct-chart-fullscreen) .ct-terminal-side-col{display:none;}
    .workspace-shell:has(.chart-workspace.ct-chart-fullscreen) .bottom-dock{display:none;}
  `;
  document.head.appendChild(style);

  // ── State ────────────────────────────────────────────────────────────
  let layout = '1'; // '1' | '2h' | '2v'
  let sync = { symbol: false, interval: false, crosshair: false };

  let pane2Instance = null; // LightweightCharts chart object for pane 2
  let pane2Series = null;   // its candlestick series
  let pane2Socket = null;
  let pane2DepthSocket = null;
  let pane2Symbol = 'ETHUSDT';
  let pane2Interval = '1m';

  // ── Active-pane bridge ────────────────────────────────────────────────
  // Which pane is "selected" for trading purposes. Defaults to pane 1.
  // order-book.js / trade-terminal.js subscribe here instead of reading
  // pane2's data directly — this file stays the only thing that ever
  // touches pane2's Binance connection.
  let activePane = 1;
  const activeChangeListeners = [];
  const pane2DepthListeners = [];
  const pane2PriceListeners = [];

  function getActiveSymbol() {
    return activePane === 2 ? pane2Symbol : marketStore.getState().symbol;
  }

  function setActivePane(n) {
    if (activePane === n) return;
    activePane = n;
    const p1 = document.getElementById('cs-pane-1');
    const p2 = document.getElementById('cs-pane-2');
    if (p1) p1.classList.toggle('cs-pane-active', n === 1);
    if (p2) p2.classList.toggle('cs-pane-active', n === 2);
    activeChangeListeners.forEach(cb => cb({ pane: activePane, symbol: getActiveSymbol() }));
  }

  let paneStackEl = null; // the pre-existing container the main chart lives in

  // Per-tab layout memory. chart-cockpit.js owns the tabs array — this file
  // never modifies it, only reads window.chartCockpit.getActiveTab().id to
  // detect when the user has switched tabs, so layout/split state stays
  // isolated per tab instead of leaking into newly-created tabs.
  let tabLayoutState = {}; // tabId -> { layout, sync, pane2Symbol, pane2Interval }
  let currentTabId = null;

  // ── Public init ─────────────────────────────────────────────────────
  function init(opts = {}) {
    const cockpit = document.getElementById('ctc-cockpit');
    const chartContainerId = opts.chartContainerId || 'klineMainChart';
    const mainChartEl = document.getElementById(chartContainerId);
    if (!cockpit || !mainChartEl) {
      console.error('[chart-split] cockpit or main chart container not found — is chart-cockpit.js initialized first?');
      return;
    }

    injectLayoutButton(cockpit);
    wrapMainChartForSplit(mainChartEl, chartContainerId);
    bindSyncListeners();

    // Seed per-tab state for whichever tab is active at load time.
    if (window.chartCockpit && typeof window.chartCockpit.getActiveTab === 'function') {
      const activeTab = window.chartCockpit.getActiveTab();
      if (activeTab) {
        currentTabId = activeTab.id;
        tabLayoutState[currentTabId] = { layout, sync: { ...sync }, pane2Symbol, pane2Interval };
      }
    }

    setupTabClickDetection();
  }

  // Detecting tab switches purely via marketStore's onSymbolChange (see
  // bindSyncListeners below) misses the common case where the new tab has
  // the SAME symbol/interval as the one you left (e.g. every tab still on
  // default BTCUSDT/1m) — marketStore has nothing to report, so that event
  // never fires and the split-layout never resets. To catch every switch
  // reliably, also react directly to clicks on the tabs bar / add-tab
  // button. chart-cockpit.js's own click handlers on these same elements
  // were already bound (in chartCockpit.init(), which always runs before
  // chartSplit.init() — see the USAGE note at the bottom of this file) and
  // update activeTabId synchronously before yielding, so by the time this
  // listener runs, window.chartCockpit.getActiveTab() already reflects the
  // new tab. This never modifies chart-cockpit.js — it only adds another
  // listener alongside its existing ones.
  function setupTabClickDetection() {
    const tabsList = document.getElementById('ctc-tabs-list');
    const addBtn = document.getElementById('ctc-tab-add');
    if (tabsList) tabsList.addEventListener('click', () => handleTabChangeIfNeeded());
    if (addBtn) addBtn.addEventListener('click', () => handleTabChangeIfNeeded());
  }

  // ── Inject the "Layout" pill + dropdown into the existing cockpit ─────
  function injectLayoutButton(cockpit) {
    const divider = document.createElement('div');
    divider.className = 'ctc-divider';
    cockpit.appendChild(divider);

    const wrap = document.createElement('div');
    wrap.className = 'ctc-wrap';
    wrap.id = 'cs-layout-wrap';
    wrap.innerHTML = `
      <button class="ctc-pill cs-icon-btn" id="cs-layout-btn" title="Layout / Split screen">${layoutIconHtml(layout)}</button>
      <div class="ctc-dd cs-dd" id="cs-layout-dd">
        <div class="cs-grid-list">
          <div class="cs-grid-opt cs-grid-opt-1 active" data-layout="1"><div class="cs-swatch"></div></div>
          <div class="cs-grid-opt cs-grid-opt-2h" data-layout="2h"><div class="cs-swatch"></div><div class="cs-swatch"></div></div>
          <div class="cs-grid-opt cs-grid-opt-2v" data-layout="2v"><div class="cs-swatch"></div><div class="cs-swatch"></div></div>
        </div>
        <div class="cs-sync-title">Sync in layout</div>
        <div class="cs-sync-row"><span>Symbol</span>${toggleHtml('symbol', sync.symbol)}</div>
        <div class="cs-sync-row"><span>Interval</span>${toggleHtml('interval', sync.interval)}</div>
        <div class="cs-sync-row"><span>Crosshair</span>${toggleHtml('crosshair', sync.crosshair)}</div>
      </div>
    `;
    cockpit.appendChild(wrap);

    // Fullscreen — self-contained, toggles the same .ct-chart-fullscreen
    // class that index.js's "F" keyboard shortcut already uses on
    // .chart-workspace (see index.css). Doesn't touch index.js at all;
    // both just flip the same DOM class independently. Since split-screen's
    // panes live inside .chart-workspace (wrapMainChartForSplit wraps the
    // chart that's already mounted there), fullscreen covers split-screen
    // automatically — no extra wiring needed.
    const fsBtn = document.createElement('button');
    fsBtn.className = 'ctc-pill cs-icon-btn';
    fsBtn.id = 'cs-fullscreen-btn';
    fsBtn.title = 'Fullscreen chart';
    fsBtn.innerHTML = fullscreenIconHtml();
    fsBtn.onclick = (e) => {
      e.stopPropagation();
      const ws = document.querySelector('.chart-workspace');
      if (!ws) return;
      const isFs = ws.classList.toggle('ct-chart-fullscreen');
      fsBtn.classList.toggle('on', isFs);
      fsBtn.title = isFs ? 'Exit fullscreen' : 'Fullscreen chart';

      // The .cs-panes container CSS resizes correctly right away, but on a
      // sudden, class-toggle-driven jump this large, the chart canvas can
      // lag a beat behind autoSize's own ResizeObserver on some mobile
      // browsers — it can stay drawn at its old size, leaving the
      // (correctly-sized) container looking empty below it.
      // requestAnimationFrame waits one frame so the browser has actually
      // applied the new CSS box size before we force each chart to resize
      // at it explicitly (Lightweight Charts' resize() needs width/height,
      // unlike klinecharts' old no-arg resize()).
      requestAnimationFrame(() => {
        const mainInstance = chartEngine.getInstance ? chartEngine.getInstance() : null;
        const mainEl = document.getElementById('klineMainChart');
        if (mainInstance && mainEl && typeof mainInstance.resize === 'function') {
          mainInstance.resize(mainEl.clientWidth, mainEl.clientHeight);
        }
        const pane2El = document.getElementById('klineChart2');
        if (pane2Instance && pane2El && typeof pane2Instance.resize === 'function') {
          pane2Instance.resize(pane2El.clientWidth, pane2El.clientHeight);
        }
      });
    };
    cockpit.appendChild(fsBtn);

    document.getElementById('cs-layout-btn').onclick = (e) => {
      e.stopPropagation();
      document.querySelectorAll('.ctc-dd.open').forEach(dd => { if (dd.id !== 'cs-layout-dd') dd.classList.remove('open'); });
      document.getElementById('cs-layout-dd').classList.toggle('open');
    };
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#cs-layout-wrap')) document.getElementById('cs-layout-dd').classList.remove('open');
    });

    wrap.querySelectorAll('[data-layout]').forEach(el => {
      el.onclick = () => setLayout(el.getAttribute('data-layout'));
    });
    wrap.querySelectorAll('.cs-toggle input').forEach(input => {
      input.onchange = () => { sync[input.dataset.syncKey] = input.checked; if (input.dataset.syncKey === 'symbol' && input.checked) syncPane2ToPane1(); };
    });
  }

  function toggleHtml(key, checked) {
    return `<label class="cs-toggle"><input type="checkbox" data-sync-key="${key}" ${checked ? 'checked' : ''}><span class="cs-toggle-slider"></span></label>`;
  }

  // Small icon shown on the Layout button itself — mirrors whichever split
  // mode is currently active, so the button always reads at a glance
  // instead of needing a text label.
  function layoutIconHtml(mode) {
    if (mode === '2h') return '<span class="cs-ico cs-ico-2h"><i></i><i></i></span>';
    if (mode === '2v') return '<span class="cs-ico cs-ico-2v"><i></i><i></i></span>';
    return '<span class="cs-ico cs-ico-1"><i></i></span>';
  }

  function fullscreenIconHtml() {
    return '<span class="cs-ico-fs"><i></i><i></i><i></i><i></i></span>';
  }

  // ── Wrap the existing single chart container in a 2-pane flex shell ──
  function wrapMainChartForSplit(mainChartEl, chartContainerId) {
    const parent = mainChartEl.parentElement;
    const stack = document.createElement('div');
    stack.className = 'cs-panes layout-1';
    stack.id = 'cs-panes';
    parent.insertBefore(stack, mainChartEl);

    const pane1 = document.createElement('div');
    pane1.className = 'cs-pane cs-pane-active';
    pane1.id = 'cs-pane-1';
    pane1.innerHTML = `<div class="cs-pane-label">${marketStore.getState().symbol}</div>`;
    pane1.appendChild(mainChartEl);
    pane1.addEventListener('click', () => setActivePane(1));
    stack.appendChild(pane1);

    const pane2 = document.createElement('div');
    pane2.className = 'cs-pane cs-pane-hidden';
    pane2.id = 'cs-pane-2';
    pane2.innerHTML = `<div class="cs-pane-label">${pane2Symbol}</div><div id="klineChart2" style="width:100%;height:100%;"></div>`;
    pane2.addEventListener('click', () => setActivePane(2));
    stack.appendChild(pane2);

    paneStackEl = stack;

    marketStore.onSymbolChange(({ symbol }) => {
      const label = pane1.querySelector('.cs-pane-label');
      if (label) label.textContent = symbol;
    });
  }

  // ── Layout switching ────────────────────────────────────────────────
  function setLayout(mode) {
    layout = mode;
    document.querySelectorAll('#cs-layout-dd [data-layout]').forEach(el => el.classList.toggle('active', el.getAttribute('data-layout') === mode));
    paneStackEl.className = 'cs-panes layout-' + mode;
    const pane2 = document.getElementById('cs-pane-2');

    const layoutBtn = document.getElementById('cs-layout-btn');
    if (layoutBtn) {
      layoutBtn.innerHTML = layoutIconHtml(mode);
      layoutBtn.classList.toggle('on', mode !== '1');
    }

    if (mode === '1') {
      pane2.classList.add('cs-pane-hidden');
      teardownPane2();
      setActivePane(1);
    } else {
      pane2.classList.remove('cs-pane-hidden');
      if (!pane2Instance) initPane2();
    }
  }

  // ── Pane 2: fully independent chart + Binance connection ─────────────
  function initPane2() {
    if (typeof LightweightCharts === 'undefined') return;
    const el = document.getElementById('klineChart2');
    if (!el) { console.error('[chart-split] pane 2 container not found'); return; }

    pane2Instance = LightweightCharts.createChart(el, {
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
    pane2Series = pane2Instance.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: '#4CAF7D',
      downColor: '#E05252',
      borderVisible: false,
      wickUpColor: '#4CAF7D',
      wickDownColor: '#E05252',
    });

    if (sync.symbol) { pane2Symbol = marketStore.getState().symbol; }
    if (sync.interval) { pane2Interval = marketStore.getState().interval; }
    loadPane2(pane2Symbol, pane2Interval);
    setupCrosshairSync();
  }

  async function loadPane2(symbol, interval) {
    pane2Symbol = symbol;
    pane2Interval = interval;
    const label = document.querySelector('#cs-pane-2 .cs-pane-label');
    if (label) label.textContent = symbol;
    if (activePane === 2) activeChangeListeners.forEach(cb => cb({ pane: 2, symbol: pane2Symbol }));

    try {
      const res = await fetch(`${BINANCE_REST}/klines?symbol=${symbol}&interval=${interval}&limit=300`);
      const raw = await res.json();
      const data = raw.map(k => ({
        time: Math.floor(k[0] / 1000),
        open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]),
      }));
      if (pane2Series) pane2Series.setData(data);
    } catch (err) {
      console.error('[chart-split] pane 2 history fetch failed:', err);
    }

    if (pane2Socket) { pane2Socket.onclose = null; pane2Socket.close(); }
    pane2Socket = new WebSocket(`${BINANCE_WS}/ws/${symbol.toLowerCase()}@kline_${interval}`);
    pane2Socket.onmessage = (event) => {
      const k = JSON.parse(event.data).k;
      const close = parseFloat(k.c);
      if (pane2Series) {
        pane2Series.update({ time: Math.floor(k.t / 1000), open: parseFloat(k.o), high: parseFloat(k.h), low: parseFloat(k.l), close });
      }
      pane2PriceListeners.forEach(cb => cb(close));
    };

    // Order-book depth for pane 2 — mirrors what market-store.js does for
    // pane 1, kept fully separate so pane 1's own connection is untouched.
    if (pane2DepthSocket) { pane2DepthSocket.onclose = null; pane2DepthSocket.close(); }
    pane2DepthSocket = new WebSocket(`${BINANCE_WS}/ws/${symbol.toLowerCase()}@depth20@100ms`);
    pane2DepthSocket.onmessage = (event) => {
      const d = JSON.parse(event.data);
      const bids = (d.bids || []).map(([price, qty]) => { price = parseFloat(price); qty = parseFloat(qty); return { price, qty, total: price * qty }; });
      const asks = (d.asks || []).map(([price, qty]) => { price = parseFloat(price); qty = parseFloat(qty); return { price, qty, total: price * qty }; });
      pane2DepthListeners.forEach(cb => cb({ bids, asks }));
    };
  }

  function teardownPane2() {
    if (pane2Socket) { pane2Socket.onclose = null; pane2Socket.close(); pane2Socket = null; }
    if (pane2DepthSocket) { pane2DepthSocket.onclose = null; pane2DepthSocket.close(); pane2DepthSocket = null; }
    if (pane2Instance) pane2Instance.remove();
    pane2Instance = null;
    pane2Series = null;
  }

  // ── Sync: symbol + interval (Pane 1 → Pane 2, one direction only) ────
  function bindSyncListeners() {
    marketStore.onSymbolChange(({ symbol, interval }) => {
      // A tab switch also fires a symbol change (chart-cockpit's switchTab
      // calls marketStore.setSymbol). Handle that case FIRST and bail out —
      // otherwise the normal "keep pane 2 in sync" logic below would treat
      // a tab switch as just another symbol change and leave the previous
      // tab's split-layout (and pane 2) sitting on top of the new tab.
      if (handleTabChangeIfNeeded()) return;

      if (!pane2Instance) return;
      const nextSymbol = sync.symbol ? symbol : pane2Symbol;
      const nextInterval = sync.interval ? interval : pane2Interval;
      if (nextSymbol !== pane2Symbol || nextInterval !== pane2Interval) loadPane2(nextSymbol, nextInterval);
    });
  }

  // ── Tab-awareness (reads chart-cockpit's tabs, never writes to them) ──
  function handleTabChangeIfNeeded() {
    if (!window.chartCockpit || typeof window.chartCockpit.getActiveTab !== 'function') return false;
    const activeTab = window.chartCockpit.getActiveTab();
    if (!activeTab || activeTab.id === currentTabId) return false;

    // Save the tab we're leaving so its split-layout is restored if the
    // user comes back to it later.
    if (currentTabId !== null) {
      tabLayoutState[currentTabId] = { layout, sync: { ...sync }, pane2Symbol, pane2Interval };
    }
    currentTabId = activeTab.id;

    const saved = tabLayoutState[currentTabId];
    if (saved) {
      // Returning to a tab that already had a layout — restore it exactly.
      sync = { ...saved.sync };
      pane2Symbol = saved.pane2Symbol;
      pane2Interval = saved.pane2Interval;
      updateSyncTogglesUI();
      setLayout(saved.layout);
    } else {
      // Brand-new tab — always starts single-pane with just its own symbol,
      // regardless of what layout was active on the tab we came from.
      sync = { symbol: false, interval: false, crosshair: false };
      pane2Symbol = activeTab.symbol;
      pane2Interval = activeTab.interval;
      updateSyncTogglesUI();
      setLayout('1');
    }
    return true;
  }

  function updateSyncTogglesUI() {
    document.querySelectorAll('#cs-layout-dd .cs-toggle input').forEach(input => {
      input.checked = !!sync[input.dataset.syncKey];
    });
  }

  function syncPane2ToPane1() {
    if (!pane2Instance) return;
    const st = marketStore.getState();
    loadPane2(st.symbol, sync.interval ? st.interval : pane2Interval);
  }

  // ── Sync: crosshair (Lightweight Charts has a real API for this —
  // subscribeCrosshairMove() to read the hovered point on pane 1, and
  // setCrosshairPosition()/clearCrosshairPosition() to mirror it onto
  // pane 2. Still wrapped in try/catch as a safety net in case a future
  // library version changes these method names). ───────────────────────
  function setupCrosshairSync() {
    try {
      const mainInstance = chartEngine.getInstance();
      const mainSeries = chartEngine.getSeries ? chartEngine.getSeries() : null;
      if (!mainInstance || !mainSeries || !pane2Instance || !pane2Series) return;

      mainInstance.subscribeCrosshairMove((param) => {
        if (!sync.crosshair || !pane2Instance || !pane2Series) return;

        if (!param || param.time === undefined) {
          pane2Instance.clearCrosshairPosition();
          return;
        }
        const point = param.seriesData ? param.seriesData.get(mainSeries) : null;
        if (!point) return;
        const price = point.close !== undefined ? point.close : point.value;
        pane2Instance.setCrosshairPosition(price, param.time, pane2Series);
      });
    } catch (err) {
      console.warn('[chart-split] crosshair sync not available for this Lightweight Charts version:', err);
    }
  }

  // ── Expose ───────────────────────────────────────────────────────────
  window.chartSplit = {
    init, setLayout, getLayout: () => layout, getSync: () => ({ ...sync }), handleTabChangeIfNeeded,
    getActivePane: () => activePane,
    getActiveSymbol,
    onActiveChange: (cb) => activeChangeListeners.push(cb),
    onPane2Depth: (cb) => pane2DepthListeners.push(cb),
    onPane2Price: (cb) => pane2PriceListeners.push(cb),
  };

})();

// ══════════════════════════════════════════════════════════════════════════
// USAGE (call AFTER chartCockpit.init()):
//
//   chartCockpit.init({ mountId: 'chart-terminal-root', chartContainerId: 'klineMainChart' });
//   chartSplit.init({ chartContainerId: 'klineMainChart' });
//
// Adds a "Layout" button into the existing cockpit toolbar automatically —
// no HTML needs to be added anywhere. Pane 2 only connects to Binance once
// the user actually picks a 2-pane layout (no wasted sockets on page load).
//
// TODO (future, not in this version): Time range / date-range sync between
// panes — needs Lightweight Charts' subscribeVisibleTimeRangeChange /
// setVisibleRange hooks, kept out for now to keep this file focused. Add as
// a small addition here when needed.
// ══════════════════════════════════════════════════════════════════════════
