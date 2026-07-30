// ══════════════════════════════════════════════════════════════════════════
// chart-terminal/chart-cockpit.js
//
// Renders the chart toolbar ("cockpit") and the Chrome-style tabs row above
// it. Fully self-contained: injects its own <style>, builds its own HTML,
// and wires every button. Talks to marketStore + chartEngine only — never
// touches Binance or the chart library directly.
//
// Indicators button (ƒx) was removed (Jul 2026) along with the TradingView
// Lightweight Charts migration — no built-in indicator engine on that
// library yet, so the dropdown, its state, and chartEngine.toggleIndicator
// call-sites were all pulled out rather than left disabled. Re-add as its
// own module later once a custom indicator layer is built on top of
// Lightweight Charts.
//
// SCOPE NOTE: this file does NOT yet include the old split-screen "Layout /
// Sync" popup from the previous monolith — that's a separate, more complex
// phase-2 feature and was intentionally left out so this file stays a
// manageable size. Add it as its own module later if/when needed.
//
// Depends on: market-store.js, chart-engine.js (both must load first).
// ══════════════════════════════════════════════════════════════════════════

(function () {

  if (typeof marketStore === 'undefined' || typeof chartEngine === 'undefined') {
    console.error('[chart-cockpit] market-store.js and chart-engine.js must load before chart-cockpit.js');
    return;
  }

  // ── Style ────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .ctc-tabs-bar{display:flex;align-items:center;gap:4px;padding:6px 10px;background:var(--bg2);border-bottom:1px solid var(--border,rgba(255,255,255,0.08));overflow-x:auto;}
    .ctc-tabs-list{display:flex;gap:4px;flex:1;overflow-x:auto;}
    .ctc-tab{display:flex;align-items:center;gap:6px;padding:7px 12px;border-radius:8px 8px 0 0;background:var(--bg3);color:var(--muted,#8a8f98);font-family:'JetBrains Mono',monospace;font-size:12px;cursor:pointer;white-space:nowrap;border:1px solid transparent;}
    .ctc-tab.active{background:var(--bg4);color:var(--gold);border-color:var(--border,rgba(255,255,255,0.08));border-bottom-color:transparent;}
    .ctc-tab-close{opacity:0.5;font-size:14px;line-height:1;padding:0 2px;}
    .ctc-tab-close:hover{opacity:1;color:var(--red,#E05252);}
    .ctc-tab-add{display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;background:transparent;border:1px solid var(--border,rgba(255,255,255,0.08));color:var(--muted,#8a8f98);cursor:pointer;flex-shrink:0;}
    .ctc-tab-add:hover{color:var(--gold);border-color:var(--gold);}

    .ctc-cockpit{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg2);flex-wrap:wrap;}
    .ctc-divider{width:1px;height:22px;background:var(--border,rgba(255,255,255,0.08));}
    .ctc-wrap{position:relative;}
    .ctc-pill{display:flex;align-items:center;gap:6px;padding:7px 12px;border-radius:8px;background:var(--bg3);color:var(--text,#EAECEF);font-family:'Outfit',sans-serif;font-size:12.5px;font-weight:500;border:1px solid transparent;cursor:pointer;white-space:nowrap;}
    .ctc-pill:hover{border-color:var(--border,rgba(255,255,255,0.12));}
    .ctc-pill.on{background:var(--gold-dim);color:var(--gold);border-color:var(--gold);}
    .ctc-chevron{width:12px;height:12px;opacity:0.6;}

    .ctc-dd{display:none;position:absolute;top:calc(100% + 6px);left:0;background:var(--bg3);border:1px solid var(--border,rgba(255,255,255,0.1));border-radius:10px;padding:6px;z-index:40;box-shadow:0 12px 30px rgba(0,0,0,0.35);min-width:150px;}
    .ctc-dd.open{display:block;}
    .ctc-dd-search{width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border,rgba(255,255,255,0.1));background:var(--bg);color:var(--text,#EAECEF);font-size:12px;margin-bottom:6px;box-sizing:border-box;}
    .ctc-dd-item{padding:8px 10px;border-radius:6px;font-size:12.5px;color:var(--text,#EAECEF);cursor:pointer;font-family:'JetBrains Mono',monospace;display:flex;align-items:center;justify-content:space-between;gap:10px;}
    .ctc-dd-item:hover{background:var(--bg4);}
    .ctc-dd-item.active{color:var(--gold);background:var(--gold-dim);}
    .ctc-dd-list{max-height:260px;overflow-y:auto;}

    .ctc-dd-tabs{display:flex;gap:4px;margin-bottom:6px;padding:2px;background:var(--bg);border-radius:6px;}
    .ctc-dd-tab{flex:1;text-align:center;padding:6px 4px;border-radius:5px;font-size:11.5px;font-family:'Outfit',sans-serif;font-weight:500;color:var(--muted,#8a8f98);cursor:pointer;}
    .ctc-dd-tab.active{background:var(--gold-dim);color:var(--gold);}
    .ctc-dd-broker-tag{font-family:'Outfit',sans-serif;font-size:11px;color:var(--muted,#8a8f98);flex-shrink:0;}
    .ctc-dd-item.active .ctc-dd-broker-tag{color:var(--gold);}
    .ctc-source-tag{font-family:'Outfit',sans-serif;font-size:10.5px;color:var(--muted,#8a8f98);background:var(--bg4);border-radius:5px;padding:2px 6px;}

    .ctc-ai-btn{background:var(--gold);color:var(--gold-text);}
    .ctc-ai-btn:hover{filter:brightness(1.1);}
  `;
  document.head.appendChild(style);

  // ── State ────────────────────────────────────────────────────────────
  let tabs = [{ id: 1, symbol: 'BTCUSDT', interval: '1m', chartType: 'candle_solid', source: 'edge' }];
  let activeTabId = 1;
  let nextTabId = 2;
  let binanceMarkets = null; // cached top-150 USDT pair list — the searchable symbol universe for ALL 3 dropdown tabs (Edge/Spot/Perp); Spot/Perp tabs filter this list down to whichever brokers actually carry each symbol, via marketStore.getBrokersForSymbol()
  let dropdownMarketTab = 'edge'; // which of the 3 dropdown tabs (Edge/Spot/Perpetual) is currently open
  let marketSearchQuery = ''; // last-typed search text, kept so re-renders (e.g. when symbol lists finish loading) preserve it

  let mountEl = null;

  const CHART_TYPE_LABELS = { candle_solid: 'Candle', candle_stroke: 'Hollow', ohlc: 'OHLC', area: 'Area' };
  const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];

  // ── Public init ─────────────────────────────────────────────────────
  function init(opts = {}) {
    mountEl = document.getElementById(opts.mountId || 'chart-terminal-root');
    if (!mountEl) { console.error('[chart-cockpit] mount element not found'); return; }

    render();
    chartEngine.init({ containerId: opts.chartContainerId || 'klineMainChart' });
    marketStore.init({ symbol: tabs[0].symbol, interval: tabs[0].interval });

    loadBinanceMarkets(); // fire and forget, populates dropdown when ready

    // Spot/Perp dropdown rows depend on marketStore's per-broker symbol
    // availability cache (Phase 3) — that loads async in the background,
    // so re-render the currently-open list once it's ready (harmless no-op
    // if the dropdown isn't open or the Edge tab is active).
    marketStore.onSymbolListsReady(() => renderCurrentMarketList());

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.ctc-wrap')) closeAllDropdowns();
    });
  }

  // ── Render ──────────────────────────────────────────────────────────
  function render() {
    mountEl.innerHTML = `
      <div class="ctc-tabs-bar">
        <div class="ctc-tabs-list" id="ctc-tabs-list"></div>
        <button class="ctc-tab-add" id="ctc-tab-add" title="New chart tab">+</button>
      </div>
      <div class="ctc-cockpit" id="ctc-cockpit">
        <div class="ctc-wrap" id="ctc-market-wrap">
          <button class="ctc-pill" id="ctc-market-btn" style="font-family:'JetBrains Mono',monospace;">
            <span id="ctc-market-label">${formatSymbol(activeTab().symbol)}</span>
            <span class="ctc-source-tag" id="ctc-market-source">${brokerDisplayName(activeTab().source)}</span>
            <svg class="ctc-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <div class="ctc-dd" id="ctc-market-dd">
            <div class="ctc-dd-tabs" id="ctc-dd-tabs">
              <div class="ctc-dd-tab active" data-dd-tab="edge">Edge</div>
              <div class="ctc-dd-tab" data-dd-tab="spot">Spot</div>
              <div class="ctc-dd-tab" data-dd-tab="perp">Perpetual</div>
            </div>
            <input type="text" class="ctc-dd-search" id="ctc-market-search" placeholder="Search market...">
            <div class="ctc-dd-list" id="ctc-market-list"><div style="padding:8px;color:var(--muted,#8a8f98);font-size:12px;">Loading markets...</div></div>
          </div>
        </div>

        <div class="ctc-divider"></div>

        <div class="ctc-wrap" id="ctc-tf-wrap">
          <button class="ctc-pill" id="ctc-tf-btn"><span id="ctc-tf-label">${activeTab().interval}</span>
            <svg class="ctc-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <div class="ctc-dd" id="ctc-tf-dd">
            <div class="ctc-dd-list">${TIMEFRAMES.map(tf => `<div class="ctc-dd-item${tf === activeTab().interval ? ' active' : ''}" data-tf="${tf}">${tf}</div>`).join('')}</div>
          </div>
        </div>

        <div class="ctc-wrap" id="ctc-ct-wrap">
          <button class="ctc-pill" id="ctc-ct-btn"><span id="ctc-ct-label">${CHART_TYPE_LABELS[activeTab().chartType]}</span>
            <svg class="ctc-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <div class="ctc-dd" id="ctc-ct-dd">
            <div class="ctc-dd-list">${Object.keys(CHART_TYPE_LABELS).map(t => `<div class="ctc-dd-item${t === activeTab().chartType ? ' active' : ''}" data-ct="${t}">${CHART_TYPE_LABELS[t]}</div>`).join('')}</div>
          </div>
        </div>

        <div class="ctc-divider"></div>

        <button class="ctc-pill" id="ctc-footprint-btn" title="Footprint chart">Footprint</button>
        <button class="ctc-pill" id="ctc-orderflow-btn" title="Order Flow">Order Flow</button>
        <button class="ctc-pill" id="ctc-liquidity-btn" title="Liquidity">Liquidity</button>

        <div class="ctc-divider"></div>

        <button class="ctc-pill ctc-ai-btn" id="ctc-ai-btn" title="AI Assistant">✨ AI</button>
      </div>
    `;

    renderTabs();
    bindEvents();
  }

  function renderTabs() {
    const list = document.getElementById('ctc-tabs-list');
    list.innerHTML = tabs.map(t => `
      <div class="ctc-tab${t.id === activeTabId ? ' active' : ''}" data-tab-id="${t.id}">
        <span>${formatSymbol(t.symbol)}</span>
        ${tabs.length > 1 ? `<span class="ctc-tab-close" data-close-tab="${t.id}">×</span>` : ''}
      </div>
    `).join('');
  }

  // ── Events ──────────────────────────────────────────────────────────
  function bindEvents() {
    document.getElementById('ctc-tab-add').onclick = addTab;

    document.getElementById('ctc-tabs-list').addEventListener('click', (e) => {
      const closeId = e.target.getAttribute('data-close-tab');
      if (closeId) { closeTab(parseInt(closeId, 10)); return; }
      const tabEl = e.target.closest('.ctc-tab');
      if (tabEl) switchTab(parseInt(tabEl.getAttribute('data-tab-id'), 10));
    });

    document.getElementById('ctc-market-btn').onclick = () => toggleDropdown('ctc-market-dd');
    document.getElementById('ctc-tf-btn').onclick = () => toggleDropdown('ctc-tf-dd');
    document.getElementById('ctc-ct-btn').onclick = () => toggleDropdown('ctc-ct-dd');

    document.getElementById('ctc-dd-tabs').addEventListener('click', (e) => {
      const tabName = e.target.getAttribute('data-dd-tab');
      if (tabName) selectDropdownTab(tabName);
    });

    document.getElementById('ctc-tf-dd').addEventListener('click', (e) => {
      const tf = e.target.getAttribute('data-tf');
      if (tf) selectTimeframe(tf);
    });
    document.getElementById('ctc-ct-dd').addEventListener('click', (e) => {
      const ct = e.target.getAttribute('data-ct');
      if (ct) selectChartType(ct);
    });
    document.getElementById('ctc-market-search').addEventListener('input', (e) => filterMarketList(e.target.value));

    // Footprint / Order Flow / Liquidity — these call into their own modules
    // (footprint.js / orderflow.js / liquidity.js) IF loaded. Until those are
    // built and their <script> tags uncommented, clicking just logs a notice
    // instead of breaking.
    document.getElementById('ctc-footprint-btn').onclick = () => toggleFeatureModule('footprint', 'ctc-footprint-btn');
    document.getElementById('ctc-orderflow-btn').onclick = () => toggleFeatureModule('orderflow', 'ctc-orderflow-btn');
    document.getElementById('ctc-liquidity-btn').onclick = () => toggleFeatureModule('liquidity', 'ctc-liquidity-btn');

    document.getElementById('ctc-ai-btn').onclick = () => {
      if (window.aiAssistant && typeof window.aiAssistant.open === 'function') {
        window.aiAssistant.open();
      } else {
        console.warn('[chart-cockpit] ai-assistant.js not loaded yet');
      }
    };
  }

  function toggleFeatureModule(moduleName, btnId) {
    const mod = window[moduleName]; // e.g. window.footprint
    const btn = document.getElementById(btnId);
    if (mod && typeof mod.toggle === 'function') {
      const isOn = mod.toggle();
      btn.classList.toggle('on', isOn);
    } else {
      console.warn(`[chart-cockpit] ${moduleName}.js not loaded yet`);
    }
  }

  function toggleDropdown(id) {
    const dd = document.getElementById(id);
    const wasOpen = dd.classList.contains('open');
    closeAllDropdowns();
    if (!wasOpen) dd.classList.add('open');
  }
  function closeAllDropdowns() {
    document.querySelectorAll('.ctc-dd.open').forEach(dd => dd.classList.remove('open'));
  }

  // ── Actions ─────────────────────────────────────────────────────────
  function activeTab() {
    return tabs.find(t => t.id === activeTabId);
  }

  async function selectTimeframe(tf) {
    closeAllDropdowns();
    const tab = activeTab();
    if (tf === tab.interval) return;
    tab.interval = tf;
    document.getElementById('ctc-tf-label').textContent = tf;
    document.querySelectorAll('#ctc-tf-dd .ctc-dd-item').forEach(el => el.classList.toggle('active', el.getAttribute('data-tf') === tf));
    await marketStore.setInterval(tf);
  }

  function selectChartType(type) {
    closeAllDropdowns();
    const tab = activeTab();
    if (type === tab.chartType) return;
    tab.chartType = type;
    document.getElementById('ctc-ct-label').textContent = CHART_TYPE_LABELS[type];
    document.querySelectorAll('#ctc-ct-dd .ctc-dd-item').forEach(el => el.classList.toggle('active', el.getAttribute('data-ct') === type));
    chartEngine.setChartType(type);
  }

  async function selectMarket(symbol, source) {
    closeAllDropdowns();
    const tab = activeTab();
    if (symbol === tab.symbol && source === tab.source) return;
    tab.symbol = symbol;
    tab.source = source;
    document.getElementById('ctc-market-label').textContent = formatSymbol(symbol);
    document.getElementById('ctc-market-source').textContent = brokerDisplayName(source);
    renderTabs();
    // Source first (so the aggregate/single-broker active-set is correct),
    // then symbol — marketStore.setSource() re-fetches with whatever symbol
    // is current at that moment, so either order converges correctly; this
    // order just reads more naturally (pick the source, then the market).
    await marketStore.setSource(source);
    await marketStore.setSymbol(symbol, tab.interval);
  }

  // ── Tabs ────────────────────────────────────────────────────────────
  async function addTab() {
    const fromSymbol = activeTab().symbol;
    const tab = { id: nextTabId++, symbol: fromSymbol, interval: '1m', chartType: 'candle_solid', source: 'edge' };
    tabs.push(tab);
    await switchTab(tab.id);

    // A brand-new tab ALWAYS starts single-pane, no matter what layout the
    // previous tab had. Forced unconditionally here — does not depend on
    // chart-split's internal saved-state logic.
    if (window.chartSplit && typeof window.chartSplit.setLayout === 'function') {
      window.chartSplit.setLayout('1');
    }
  }

  async function switchTab(id) {
    if (id === activeTabId) return;
    activeTabId = id;
    const tab = activeTab();

    // Restore this tab's saved config into market-store + chart-engine.
    document.getElementById('ctc-market-label').textContent = formatSymbol(tab.symbol);
    document.getElementById('ctc-market-source').textContent = brokerDisplayName(tab.source);
    document.getElementById('ctc-tf-label').textContent = tab.interval;
    document.getElementById('ctc-ct-label').textContent = CHART_TYPE_LABELS[tab.chartType];
    chartEngine.setChartType(tab.chartType);

    renderTabs();

    // Tell chart-split.js the active tab changed, directly — no reliance on
    // click-listener timing/order (that approach was unreliable).
    if (window.chartSplit && typeof window.chartSplit.handleTabChangeIfNeeded === 'function') {
      window.chartSplit.handleTabChangeIfNeeded();
    }

    await marketStore.setSource(tab.source);
    await marketStore.setSymbol(tab.symbol, tab.interval);
  }

  function closeTab(id) {
    if (tabs.length <= 1) return;
    const idx = tabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    tabs.splice(idx, 1);
    if (activeTabId === id) {
      const next = tabs[Math.max(0, idx - 1)];
      switchTab(next.id);
    } else {
      renderTabs();
    }
  }

  // ── Market list (search dropdown) ──────────────────────────────────
  // Candidate symbol universe for ALL 3 dropdown tabs (Edge/Spot/Perpetual)
  // — Binance's top-150-by-volume USDT pairs, same list the dropdown has
  // always used. Spot/Perp tabs don't change this candidate list; they
  // just filter it down, per symbol, to whichever brokers actually carry
  // it (marketStore.getBrokersForSymbol). A symbol that exists on a broker
  // but isn't in Binance's top-150 (e.g. a small-cap only on Bybit spot)
  // won't surface here yet — acceptable for now since it matches today's
  // existing scope; can be widened later with a broker-agnostic candidate
  // list if that gap turns out to matter in practice.
  async function loadBinanceMarkets() {
    try {
      const res = await fetch('https://api.binance.com/api/v3/ticker/24hr');
      const data = await res.json();
      binanceMarkets = data
        .filter(t => t.symbol.endsWith('USDT') && !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol))
        .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, 150)
        .map(t => t.symbol);
    } catch (err) {
      console.error('[chart-cockpit] failed to load market list:', err);
      binanceMarkets = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
    }
    renderCurrentMarketList();
  }

  // Switches which dropdown tab (Edge/Spot/Perpetual) is showing, re-renders
  // the list under the CURRENT search query (search text is preserved across
  // tab switches, same as TradingView's picker).
  function selectDropdownTab(tabName) {
    if (tabName === dropdownMarketTab) return;
    dropdownMarketTab = tabName;
    document.querySelectorAll('#ctc-dd-tabs .ctc-dd-tab').forEach(el => el.classList.toggle('active', el.getAttribute('data-dd-tab') === tabName));
    renderCurrentMarketList();
  }

  // Single entry point that (re-)renders the list for whichever dropdown
  // tab is active, under the current search query. Called on: initial load,
  // search input, dropdown-tab switch, and once symbol-availability data
  // finishes loading (marketStore's 'symbolListsReady' event).
  function renderCurrentMarketList() {
    if (!binanceMarkets) return; // still loading Binance's list — nothing to render yet
    const q = marketSearchQuery.toUpperCase();
    const matches = q ? binanceMarkets.filter(s => s.includes(q)) : binanceMarkets;

    if (dropdownMarketTab === 'edge') {
      renderEdgeRows(matches);
    } else {
      renderBrokerRows(matches, dropdownMarketTab);
    }
  }

  // Edge tab: one row per symbol, always labeled 'EdgeTrade' — selecting
  // one sets source='edge' (the existing combined/aggregate mode).
  function renderEdgeRows(symbols) {
    const el = document.getElementById('ctc-market-list');
    if (!el) return;
    const tab = activeTab();
    el.innerHTML = symbols.map(s => `
      <div class="ctc-dd-item${s === tab.symbol && tab.source === 'edge' ? ' active' : ''}" data-symbol="${s}" data-source="edge">
        <span>${formatSymbol(s)}</span><span class="ctc-dd-broker-tag">EdgeTrade</span>
      </div>
    `).join('');
    el.querySelectorAll('[data-symbol]').forEach(item => {
      item.onclick = () => selectMarket(item.getAttribute('data-symbol'), item.getAttribute('data-source'));
    });
  }

  // Spot/Perpetual tabs: expands each matching symbol into one row PER
  // broker that actually carries it on that market type — e.g. searching
  // "BTC" under Spot shows "BTC/USDT — Binance" AND "BTC/USDT — Bybit" as
  // two separate, individually-selectable rows (TradingView-style).
  function renderBrokerRows(symbols, marketType) {
    const el = document.getElementById('ctc-market-list');
    if (!el) return;

    if (!marketStore.areSymbolListsReady()) {
      el.innerHTML = `<div style="padding:8px;color:var(--muted,#8a8f98);font-size:12px;">Loading ${marketType === 'spot' ? 'Spot' : 'Perpetual'} brokers...</div>`;
      return;
    }

    const tab = activeTab();
    const rows = [];
    symbols.forEach(sym => {
      marketStore.getBrokersForSymbol(sym, marketType).forEach(broker => {
        rows.push({ symbol: sym, brokerId: broker.id, displayName: broker.displayName });
      });
    });

    if (!rows.length) {
      el.innerHTML = `<div style="padding:8px;color:var(--muted,#8a8f98);font-size:12px;">No ${marketType === 'spot' ? 'Spot' : 'Perpetual'} listings found.</div>`;
      return;
    }

    el.innerHTML = rows.map(r => `
      <div class="ctc-dd-item${r.symbol === tab.symbol && r.brokerId === tab.source ? ' active' : ''}" data-symbol="${r.symbol}" data-source="${r.brokerId}">
        <span>${formatSymbol(r.symbol)}</span><span class="ctc-dd-broker-tag">${r.displayName}</span>
      </div>
    `).join('');
    el.querySelectorAll('[data-symbol]').forEach(item => {
      item.onclick = () => selectMarket(item.getAttribute('data-symbol'), item.getAttribute('data-source'));
    });
  }

  function filterMarketList(query) {
    marketSearchQuery = query;
    renderCurrentMarketList();
  }

  // Resolves a tab's `source` ('edge' or a specific broker id) into the
  // label shown in the market pill / dropdown rows — reads the REAL
  // displayName from market-store's broker registry (Phase 1), never
  // hardcoded, so a future new broker's name shows up correctly automatically.
  function brokerDisplayName(source) {
    if (source === 'edge') return 'EdgeTrade';
    const marketType = source.endsWith('-perp') ? 'perp' : 'spot';
    const found = marketStore.getBrokersForMarketType(marketType).find(b => b.id === source);
    return found ? found.displayName : source;
  }

  function formatSymbol(sym) {
    return sym.replace(/USDT$/, '') + '/USDT';
  }

  // ── Expose ───────────────────────────────────────────────────────────
  window.chartCockpit = { init, getActiveTab: activeTab, getTabs: () => [...tabs] };

})();

// ══════════════════════════════════════════════════════════════════════════
// USAGE (index.html, once ready to switch on the new chart terminal):
//
//   chartCockpit.init({
//     mountId: 'chart-terminal-root',
//     chartContainerId: 'klineMainChart'
//   });
//
// This single call initializes tabs, cockpit toolbar, chart-engine, and
// market-store together — nothing else needs to be called manually.
//
// The Footprint / Order Flow / Liquidity buttons already look for
// window.footprint.toggle() / window.orderflow.toggle() / window.liquidity.toggle().
// Once those three files are built and their <script> tags uncommented, the
// buttons will work with ZERO changes needed here.
// ══════════════════════════════════════════════════════════════════════════
