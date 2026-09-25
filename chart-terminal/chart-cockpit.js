// ══════════════════════════════════════════════════════════════════════════
// PASTE INSTRUCTION
// FILE: chart-terminal/chart-cockpit.js
// ACTION: REPLACE ENTIRE FILE (single part — ~430 lines, 460-limit ke andar)
// NOTE: Clean template, cockpit-owned Pulse pill, source-unchanged skip,
//       localStorage market-list cache (1h TTL), Edge stream-health dot.
//       Companion pulse.js blocks Box 2 mein (auto-inject removal + return).
// ══════════════════════════════════════════════════════════════════════════
(function () {
if (typeof marketStore === 'undefined' || typeof chartEngine === 'undefined') {
console.error('[chart-cockpit] market-store.js and chart-engine.js must load before chart-cockpit.js');
return;
}
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
.ctc-dd{display:none;position:fixed;background:var(--bg3);border:1px solid var(--border,rgba(255,255,255,0.1));border-radius:10px;padding:6px;z-index:400;box-shadow:0 12px 30px rgba(0,0,0,0.35);min-width:150px;}
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
.ctc-health{width:7px;height:7px;border-radius:50%;background:var(--green,#4CAF7D);display:inline-block;flex-shrink:0;}
.ctc-health.warn{background:var(--red,#E05252);}
`;
document.head.appendChild(style);
let tabs = [{ id: 1, symbol: 'BTCUSDT', interval: '1m', chartType: 'candle_solid', source: 'edge' }];
let activeTabId = 1;
let nextTabId = 2;
let binanceMarkets = null;
let dropdownMarketTab = 'edge';
let marketSearchQuery = '';
let mountEl = null;
let healthTimer = null;
const CHART_TYPE_LABELS = { candle_solid: 'Candle', candle_stroke: 'Hollow', ohlc: 'OHLC', area: 'Area' };
const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];
const DD_BTN_MAP = { 'ctc-market-dd': 'ctc-market-btn', 'ctc-tf-dd': 'ctc-tf-btn', 'ctc-ct-dd': 'ctc-ct-btn' };
const MARKETS_CACHE_KEY = 'ctc_binance_markets_v1';
const MARKETS_CACHE_TTL_MS = 3600000;
function init(opts = {}) {
mountEl = document.getElementById(opts.mountId || 'chart-terminal-root');
if (!mountEl) { console.error('[chart-cockpit] mount element not found'); return; }
render();
chartEngine.init({ containerId: opts.chartContainerId || 'klineMainChart' });
marketStore.init({ symbol: tabs[0].symbol, interval: tabs[0].interval });
loadBinanceMarkets();
marketStore.onSymbolListsReady(() => renderCurrentMarketList());
document.addEventListener('click', (e) => { if (!e.target.closest('.ctc-wrap')) closeAllDropdowns(); });
window.addEventListener('scroll', repositionOpenDropdowns, { passive: true, capture: true });
window.addEventListener('resize', repositionOpenDropdowns);
const fiScript = document.createElement('script');
fiScript.src = 'chart-terminal/flow-intel.js';
fiScript.onload = () => {
  document.querySelectorAll('[data-pending-layer]').forEach(b => { const l = b.getAttribute('data-pending-layer'); b.removeAttribute('data-pending-layer'); b.classList.toggle('on', window.flowIntel.toggleLayer(l)); });
  const pb = document.getElementById('ctc-fi-panel-btn'); if (pb && pb.hasAttribute('data-pending-panel')) { pb.removeAttribute('data-pending-panel'); pb.classList.toggle('on', window.flowIntel.togglePanel()); }
  const ob = document.getElementById('ctc-fi-outlook-btn'); if (ob && ob.hasAttribute('data-pending-outlook')) { ob.removeAttribute('data-pending-outlook'); ob.classList.toggle('on', window.flowIntel.toggleOutlook()); }
};
document.head.appendChild(fiScript);
clearInterval(healthTimer);
healthTimer = setInterval(updateHealthDot, 10000);
updateHealthDot();
}
// Edge mode mein ek bhi broker stream gire to red dot — market-store ka
// getStreamHealth() single source of truth hai (batch-1 contract).
function updateHealthDot() {
const dot = document.getElementById('ctc-health-dot');
if (!dot || typeof marketStore.getStreamHealth !== 'function') return;
const h = marketStore.getStreamHealth();
const warn = h.source === 'edge' && h.edgeComplete === false;
dot.className = 'ctc-health' + (warn ? ' warn' : '');
dot.title = warn ? 'Edge degraded — one or more broker streams down' : 'All broker streams live';
}
function render() {
mountEl.innerHTML = `
<div class="ctc-tabs-bar">
  <div class="ctc-tabs-list" id="ctc-tabs-list"></div>
  <button class="ctc-tab-add" id="ctc-tab-add" title="New chart tab">+</button>
</div>
<div class="ctc-cockpit" id="ctc-cockpit">
  <div class="ctc-wrap" id="ctc-market-wrap">
    <button class="ctc-pill" id="ctc-market-btn" style="font-family:'JetBrains Mono',monospace;">
      <span class="ctc-health" id="ctc-health-dot"></span>
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
  <button class="ctc-pill" id="ctc-whales-btn" title="Whale Absorption">Whales</button>
  <button class="ctc-pill" id="ctc-context-btn" title="Macro Context (sentiment + news + global)">🌐 Context</button>
  <button class="ctc-pill" id="ctc-pulse-btn" title="Market Pulse AI" style="color:var(--gold);border-color:var(--gold);">⚡ Pulse</button>
  <div class="ctc-divider"></div>
  <button class="ctc-pill" id="ctc-fi-whale-btn" title="Whale flow: split execution + whale prints">🐋 Whale</button>
  <button class="ctc-pill" id="ctc-fi-sweep-btn" title="Liquidity sweeps / grabs">⚡ Sweeps</button>
  <button class="ctc-pill" id="ctc-fi-abs-btn" title="Absorption zones">🧊 Absorb</button>
  <button class="ctc-pill" id="ctc-fi-herd-btn" title="Retail herd zones">👥 Retail</button>
  <button class="ctc-pill" id="ctc-fi-panel-btn" title="Flow Intel panel + trap alerts">🧠 Flow Intel</button>
  <button class="ctc-pill" id="ctc-fi-outlook-btn" title="Market Outlook + accuracy record">📈 Outlook</button>
  <button class="ctc-pill" id="ctc-burst-btn" title="Burst-Catcher signal strip">🎯 Burst</button>
  <div class="ctc-divider"></div>
  <button class="ctc-pill ctc-ai-btn" id="ctc-ai-btn" title="AI Assistant">✨ AI</button>
</div>`;
renderTabs();
bindEvents();
}
function renderTabs() {
const list = document.getElementById('ctc-tabs-list');
list.innerHTML = tabs.map(t => `<div class="ctc-tab${t.id === activeTabId ? ' active' : ''}" data-tab-id="${t.id}"><span>${formatSymbol(t.symbol)}</span>${tabs.length > 1 ? `<span class="ctc-tab-close" data-close-tab="${t.id}">×</span>` : ''}</div>`).join('');
}
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
document.getElementById('ctc-footprint-btn').onclick = () => toggleFeatureModule('footprint', 'ctc-footprint-btn');
document.getElementById('ctc-orderflow-btn').onclick = () => toggleFeatureModule('orderflow', 'ctc-orderflow-btn');
document.getElementById('ctc-liquidity-btn').onclick = () => toggleFeatureModule('liquidity', 'ctc-liquidity-btn');
document.getElementById('ctc-whales-btn').onclick = () => toggleFeatureModule('whaleTracker', 'ctc-whales-btn');
document.getElementById('ctc-context-btn').onclick = () => toggleFeatureModule('marketContext', 'ctc-context-btn');
document.getElementById('ctc-pulse-btn').onclick = () => toggleFeatureModule('pulse', 'ctc-pulse-btn');
const fiLayer = (layer, btnId) => { const fi = window.flowIntel; const btn = document.getElementById(btnId); if (fi && fi.toggleLayer) { btn.classList.toggle('on', fi.toggleLayer(layer)); } else { btn.setAttribute('data-pending-layer', layer); btn.classList.add('on'); } };
document.getElementById('ctc-fi-whale-btn').onclick = () => fiLayer('whale', 'ctc-fi-whale-btn');
document.getElementById('ctc-fi-sweep-btn').onclick = () => fiLayer('sweep', 'ctc-fi-sweep-btn');
document.getElementById('ctc-fi-abs-btn').onclick = () => fiLayer('absorb', 'ctc-fi-abs-btn');
document.getElementById('ctc-fi-herd-btn').onclick = () => fiLayer('herd', 'ctc-fi-herd-btn');
document.getElementById('ctc-fi-panel-btn').onclick = () => { const fi = window.flowIntel; const btn = document.getElementById('ctc-fi-panel-btn'); if (fi && fi.togglePanel) { btn.classList.toggle('on', fi.togglePanel()); } else { btn.setAttribute('data-pending-panel', '1'); btn.classList.add('on'); } };
document.getElementById('ctc-fi-outlook-btn').onclick = () => { const fi = window.flowIntel; const btn = document.getElementById('ctc-fi-outlook-btn'); if (fi && fi.toggleOutlook) { btn.classList.toggle('on', fi.toggleOutlook()); } else { btn.setAttribute('data-pending-outlook', '1'); btn.classList.add('on'); } };
const bcScript = document.createElement('script');
bcScript.src = 'chart-terminal/burst-catcher.js';
bcScript.onload = () => {
  const b = document.getElementById('ctc-burst-btn');
  if (b) { if (window.burstCatcher && window.burstCatcher.isActive()) b.classList.add('on'); if (b.hasAttribute('data-pending-burst')) { b.removeAttribute('data-pending-burst'); b.classList.toggle('on', window.burstCatcher.toggle()); } }
};
document.head.appendChild(bcScript);
document.getElementById('ctc-burst-btn').onclick = () => { const bc = window.burstCatcher; const btn = document.getElementById('ctc-burst-btn'); if (bc && bc.toggle) { btn.classList.toggle('on', bc.toggle()); } else { btn.setAttribute('data-pending-burst', '1'); btn.classList.add('on'); } };
document.getElementById('ctc-ai-btn').onclick = () => {
  if (window.aiAssistant && typeof window.aiAssistant.open === 'function') window.aiAssistant.open();
  else console.warn('[chart-cockpit] ai-assistant.js not loaded yet');
};
}
function toggleFeatureModule(moduleName, btnId) {
const mod = window[moduleName];
const btn = document.getElementById(btnId);
if (mod && typeof mod.toggle === 'function') {
  const isOn = mod.toggle();
  btn.classList.toggle('on', !!isOn);
} else {
  console.warn(`[chart-cockpit] ${moduleName}.js not loaded yet`);
}
}
function toggleDropdown(id) {
const dd = document.getElementById(id);
const wasOpen = dd.classList.contains('open');
closeAllDropdowns();
if (!wasOpen) { dd.classList.add('open'); positionDropdown(id); }
}
function closeAllDropdowns() {
document.querySelectorAll('.ctc-dd.open').forEach(dd => dd.classList.remove('open'));
}
function positionDropdown(ddId) {
const btnId = DD_BTN_MAP[ddId];
const dd = document.getElementById(ddId);
const btn = document.getElementById(btnId);
if (!dd || !btn) return;
const r = btn.getBoundingClientRect();
dd.style.minWidth = Math.max(150, r.width) + 'px';
let left = r.left;
const maxLeft = window.innerWidth - dd.offsetWidth - 10;
if (dd.offsetWidth && left > maxLeft) left = Math.max(10, maxLeft);
dd.style.left = left + 'px';
const spaceBelow = window.innerHeight - r.bottom;
if (spaceBelow < 220 && r.top > 220) { dd.style.bottom = (window.innerHeight - r.top + 6) + 'px'; dd.style.top = 'auto'; }
else { dd.style.top = (r.bottom + 6) + 'px'; dd.style.bottom = 'auto'; }
}
function repositionOpenDropdowns() {
document.querySelectorAll('.ctc-dd.open').forEach(dd => positionDropdown(dd.id));
}
function activeTab() { return tabs.find(t => t.id === activeTabId); }
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
const sourceChanged = source !== tab.source;
tab.symbol = symbol;
tab.source = source;
document.getElementById('ctc-market-label').textContent = formatSymbol(symbol);
document.getElementById('ctc-market-source').textContent = brokerDisplayName(source);
renderTabs();
if (sourceChanged) await marketStore.setSource(source); // unchanged source pe double reconnect nahi
await marketStore.setSymbol(symbol, tab.interval);
}
async function addTab() {
const fromSymbol = activeTab().symbol;
const tab = { id: nextTabId++, symbol: fromSymbol, interval: '1m', chartType: 'candle_solid', source: 'edge' };
tabs.push(tab);
await switchTab(tab.id);
if (window.chartSplit && typeof window.chartSplit.setLayout === 'function') window.chartSplit.setLayout('1');
}
async function switchTab(id) {
if (id === activeTabId) return;
activeTabId = id;
const tab = activeTab();
document.getElementById('ctc-market-label').textContent = formatSymbol(tab.symbol);
document.getElementById('ctc-market-source').textContent = brokerDisplayName(tab.source);
document.getElementById('ctc-tf-label').textContent = tab.interval;
document.getElementById('ctc-ct-label').textContent = CHART_TYPE_LABELS[tab.chartType];
chartEngine.setChartType(tab.chartType);
renderTabs();
if (window.chartSplit && typeof window.chartSplit.handleTabChangeIfNeeded === 'function') window.chartSplit.handleTabChangeIfNeeded();
await marketStore.setSource(tab.source);
await marketStore.setSymbol(tab.symbol, tab.interval);
}
function closeTab(id) {
if (tabs.length <= 1) return;
const idx = tabs.findIndex(t => t.id === id);
if (idx === -1) return;
tabs.splice(idx, 1);
if (activeTabId === id) { switchTab(tabs[Math.max(0, idx - 1)].id); } else { renderTabs(); }
}
async function loadBinanceMarkets() {
try {
  const cached = localStorage.getItem(MARKETS_CACHE_KEY);
  if (cached) {
    const obj = JSON.parse(cached);
    if (obj && obj.at && Array.isArray(obj.list) && Date.now() - obj.at < MARKETS_CACHE_TTL_MS) {
      binanceMarkets = obj.list;
      renderCurrentMarketList();
      return;
    }
  }
} catch (e) {}
try {
  const res = await fetch('https://api.binance.com/api/v3/ticker/24hr');
  const data = await res.json();
  binanceMarkets = data
    .filter(t => t.symbol.endsWith('USDT') && !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 150)
    .map(t => t.symbol);
  try { localStorage.setItem(MARKETS_CACHE_KEY, JSON.stringify({ at: Date.now(), list: binanceMarkets })); } catch (e) {}
} catch (err) {
  console.error('[chart-cockpit] failed to load market list:', err);
  binanceMarkets = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
}
renderCurrentMarketList();
}
function selectDropdownTab(tabName) {
if (tabName === dropdownMarketTab) return;
dropdownMarketTab = tabName;
document.querySelectorAll('#ctc-dd-tabs .ctc-dd-tab').forEach(el => el.classList.toggle('active', el.getAttribute('data-dd-tab') === tabName));
renderCurrentMarketList();
}
function renderCurrentMarketList() {
if (!binanceMarkets) return;
const q = marketSearchQuery.toUpperCase();
const matches = q ? binanceMarkets.filter(s => s.includes(q)) : binanceMarkets;
if (dropdownMarketTab === 'edge') renderEdgeRows(matches);
else renderBrokerRows(matches, dropdownMarketTab);
}
function renderEdgeRows(symbols) {
const el = document.getElementById('ctc-market-list');
if (!el) return;
const tab = activeTab();
el.innerHTML = symbols.map(s => `<div class="ctc-dd-item${s === tab.symbol && tab.source === 'edge' ? ' active' : ''}" data-symbol="${s}" data-source="edge"><span>${formatSymbol(s)}</span><span class="ctc-dd-broker-tag">EdgeTrade</span></div>`).join('');
el.querySelectorAll('[data-symbol]').forEach(item => {
  item.onclick = () => selectMarket(item.getAttribute('data-symbol'), item.getAttribute('data-source'));
});
}
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
function brokerDisplayName(source) {
if (source === 'edge') return 'EdgeTrade';
const marketType = source.endsWith('-perp') ? 'perp' : 'spot';
const found = marketStore.getBrokersForMarketType(marketType).find(b => b.id === source);
return found ? found.displayName : source;
}
function formatSymbol(sym) { return sym.replace(/USDT$/, '') + '/USDT'; }
window.chartCockpit = { init, getActiveTab: activeTab, getTabs: () => [...tabs] };
})();
// ══════════════════════════════════════════════════════════════════════════
// USAGE: chartCockpit.init({ mountId: 'chart-terminal-root', chartContainerId: 'klineMainChart' });
// ══════════════════════════════════════════════════════════════════════════
