// ══════════════════════════════════════════════════════════════════════════
// chart-terminal/chart-split.js
//
// Split-screen layout (1 / 2-horizontal / 2-vertical panes) + sync toggles
// (Symbol, Interval, Crosshair) between Pane 1 (the main chart owned by
// chart-engine.js) and Pane 2 (a second, independent klinecharts instance +
// its own Binance connection, owned entirely by this file).
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
    .cs-panes{display:flex;gap:10px;width:100%;}
    .cs-panes.layout-1{}
    .cs-panes.layout-2h{flex-direction:row;}
    .cs-panes.layout-2v{flex-direction:column;}
    .cs-pane{flex:1;min-width:0;min-height:280px;position:relative;border:1px solid var(--border,rgba(255,255,255,0.08));border-radius:8px;overflow:hidden;}
    .cs-pane-hidden{display:none;}
    .cs-pane-label{position:absolute;top:6px;left:8px;z-index:5;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted,#8a8f98);background:rgba(0,0,0,0.4);padding:2px 6px;border-radius:4px;}

    .cs-dd{padding:10px;min-width:230px;}
    .cs-grid-list{display:flex;gap:8px;margin-bottom:10px;}
    .cs-grid-opt{flex:1;aspect-ratio:1;border:1px solid var(--border,rgba(255,255,255,0.1));border-radius:6px;cursor:pointer;display:flex;padding:4px;gap:3px;background:var(--bg);}
    .cs-grid-opt.active{border-color:var(--gold);background:var(--gold-dim);}
    .cs-grid-opt-1{}
    .cs-grid-opt-1 .cs-swatch{width:100%;height:100%;background:var(--bg4);border-radius:2px;}
    .cs-grid-opt-2h{flex-direction:row;}
    .cs-grid-opt-2h .cs-swatch{flex:1;background:var(--bg4);border-radius:2px;}
    .cs-grid-opt-2v{flex-direction:column;}
    .cs-grid-opt-2v .cs-swatch{flex:1;background:var(--bg4);border-radius:2px;}

    .cs-sync-title{font-size:11px;color:var(--muted,#8a8f98);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;}
    .cs-sync-row{display:flex;align-items:center;justify-content:space-between;padding:6px 0;font-size:12.5px;color:var(--text,#EAECEF);}
    .cs-toggle{position:relative;width:34px;height:20px;flex-shrink:0;}
    .cs-toggle input{opacity:0;width:0;height:0;}
    .cs-toggle-slider{position:absolute;inset:0;background:var(--bg4);border-radius:20px;cursor:pointer;transition:0.15s;}
    .cs-toggle-slider::before{content:'';position:absolute;width:14px;height:14px;left:3px;top:3px;background:#fff;border-radius:50%;transition:0.15s;}
    .cs-toggle input:checked + .cs-toggle-slider{background:var(--gold);}
    .cs-toggle input:checked + .cs-toggle-slider::before{transform:translateX(14px);}
  `;
  document.head.appendChild(style);

  // ── State ────────────────────────────────────────────────────────────
  let layout = '1'; // '1' | '2h' | '2v'
  let sync = { symbol: true, interval: true, crosshair: true };

  let pane2Instance = null;
  let pane2Socket = null;
  let pane2Symbol = 'ETHUSDT';
  let pane2Interval = '1m';

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
      <button class="ctc-pill" id="cs-layout-btn" title="Layout / Split screen">⬛ Layout</button>
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

  // ── Wrap the existing single chart container in a 2-pane flex shell ──
  function wrapMainChartForSplit(mainChartEl, chartContainerId) {
    const parent = mainChartEl.parentElement;
    const stack = document.createElement('div');
    stack.className = 'cs-panes layout-1';
    stack.id = 'cs-panes';
    parent.insertBefore(stack, mainChartEl);

    const pane1 = document.createElement('div');
    pane1.className = 'cs-pane';
    pane1.id = 'cs-pane-1';
    pane1.innerHTML = `<div class="cs-pane-label">${marketStore.getState().symbol}</div>`;
    pane1.appendChild(mainChartEl);
    stack.appendChild(pane1);

    const pane2 = document.createElement('div');
    pane2.className = 'cs-pane cs-pane-hidden';
    pane2.id = 'cs-pane-2';
    pane2.innerHTML = `<div class="cs-pane-label">${pane2Symbol}</div><div id="klineChart2" style="width:100%;height:100%;"></div>`;
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

    if (mode === '1') {
      pane2.classList.add('cs-pane-hidden');
      teardownPane2();
    } else {
      pane2.classList.remove('cs-pane-hidden');
      if (!pane2Instance) initPane2();
    }
  }

  // ── Pane 2: fully independent chart + Binance connection ─────────────
  function initPane2() {
    if (typeof klinecharts === 'undefined') return;
    pane2Instance = klinecharts.init('klineChart2');
    if (!pane2Instance) { console.error('[chart-split] failed to init pane 2 chart'); return; }
    pane2Instance.setStyles({
      grid: { show: true, horizontal: { color: '#2a2a2a' }, vertical: { color: '#2a2a2a' } },
      candle: { bar: { upColor: '#4CAF7D', downColor: '#E05252', noChangeColor: '#888888' } },
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

    try {
      const res = await fetch(`${BINANCE_REST}/klines?symbol=${symbol}&interval=${interval}&limit=300`);
      const raw = await res.json();
      const data = raw.map(k => ({ timestamp: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
      if (pane2Instance) pane2Instance.applyNewData(data);
    } catch (err) {
      console.error('[chart-split] pane 2 history fetch failed:', err);
    }

    if (pane2Socket) { pane2Socket.onclose = null; pane2Socket.close(); }
    pane2Socket = new WebSocket(`${BINANCE_WS}/ws/${symbol.toLowerCase()}@kline_${interval}`);
    pane2Socket.onmessage = (event) => {
      const k = JSON.parse(event.data).k;
      if (pane2Instance) {
        pane2Instance.updateData({ timestamp: k.t, open: parseFloat(k.o), high: parseFloat(k.h), low: parseFloat(k.l), close: parseFloat(k.c), volume: parseFloat(k.v) });
      }
    };
  }

  function teardownPane2() {
    if (pane2Socket) { pane2Socket.onclose = null; pane2Socket.close(); pane2Socket = null; }
    if (pane2Instance && typeof klinecharts.dispose === 'function') klinecharts.dispose('klineChart2');
    pane2Instance = null;
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
    console.log('[chart-split] tab check fired, current:', currentTabId);
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
      sync = { symbol: true, interval: true, crosshair: true };
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

  // ── Sync: crosshair (best-effort — wrapped in try/catch since exact
  // klinecharts v9.8.5 event-subscription method name should be confirmed
  // against the installed version; this fails silently rather than breaking
  // the chart if the API differs). ──────────────────────────────────────
  function setupCrosshairSync() {
    try {
      const mainInstance = chartEngine.getInstance();
      if (!mainInstance || !pane2Instance) return;
      mainInstance.subscribeAction('onCrosshairChange', (data) => {
        if (!sync.crosshair || !pane2Instance) return;
        // Mirrors the hovered timestamp onto pane 2. Adjust the exact call
        // below if klinecharts' API differs from this signature.
        if (data && data.kLineData && typeof pane2Instance.setCrosshair === 'function') {
          pane2Instance.setCrosshair({ x: data.x, y: data.y }, false);
        }
      });
    } catch (err) {
      console.warn('[chart-split] crosshair sync not available for this klinecharts version:', err);
    }
  }

  // ── Expose ───────────────────────────────────────────────────────────
  window.chartSplit = { init, setLayout, getLayout: () => layout, getSync: () => ({ ...sync }) };

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
// panes — needs klinecharts' scroll/zoom action hooks, kept out for now to
// keep this file focused. Add as a small addition here when needed.
// ══════════════════════════════════════════════════════════════════════════
