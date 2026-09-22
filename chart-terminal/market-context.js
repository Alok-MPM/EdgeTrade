// Dedicated panel for macro context. Does NOT touch outlook engine directly.
(function () {
if (typeof marketStore === 'undefined') { console.error('[market-context] market-store.js must load first'); return; }
const API_BASE = 'https://m-edgetrade-api-server.onrender.com';
const REFRESH_MS = 30000;
let active = false;
let refreshTimer = null;
let panelEl = null;
let savedHTML = null;
const style = document.createElement('style');
style.textContent = `
.mc-panel{background:var(--bg2);border:1px solid var(--border,rgba(255,255,255,0.08));border-radius:12px;padding:12px;display:flex;flex-direction:column;height:100%;box-sizing:border-box;font-family:'Outfit',sans-serif;overflow-y:auto;}
.mc-title{font-family:'Cormorant Garamond',serif;font-size:17px;font-weight:600;color:var(--text,#EAECEF);margin-bottom:10px;display:flex;align-items:center;gap:8px;}
.mc-section{margin-bottom:12px;padding-bottom:10px;border-bottom:1px dashed var(--border,rgba(255,255,255,0.08));}
.mc-section:last-child{border-bottom:none;}
.mc-label{font-size:10.5px;color:var(--muted,#8a8f98);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;}
.mc-fg{display:flex;align-items:baseline;gap:10px;margin-bottom:4px;}
.mc-fg-val{font-family:'JetBrains Mono',monospace;font-size:26px;font-weight:700;}
.mc-fg-lbl{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--muted,#8a8f98);}
.mc-fg-bar{height:6px;border-radius:4px;background:linear-gradient(90deg,#E05252 0%,#E05252 25%,#f5cb42 50%,#4CAF7D 75%,#4CAF7D 100%);position:relative;margin-top:4px;}
.mc-fg-ptr{position:absolute;top:-3px;width:3px;height:12px;background:#EAECEF;border-radius:1px;transition:left 0.5s ease;}
.mc-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
.mc-stat{background:var(--bg4);padding:6px 8px;border-radius:6px;}
.mc-stat-lbl{font-size:9.5px;color:var(--muted,#8a8f98);text-transform:uppercase;}
.mc-stat-val{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text,#EAECEF);}
.mc-coin-row{display:flex;justify-content:space-between;font-family:'JetBrains Mono',monospace;font-size:11px;padding:2px 0;}
.mc-coin-sym{color:var(--gold);}
.mc-coin-chg{font-size:10.5px;}
.mc-trend-row{display:flex;justify-content:space-between;font-size:11px;padding:2px 0;font-family:'JetBrains Mono',monospace;}
.mc-trend-rank{color:var(--muted,#8a8f98);width:18px;}
.mc-trend-sym{color:var(--text,#EAECEF);}
.mc-news-row{font-size:10.5px;padding:5px 0;border-bottom:1px dashed rgba(255,255,255,0.05);color:var(--text,#EAECEF);line-height:1.4;}
.mc-news-row.breaking{color:#f5cb42;}
.mc-news-src{color:var(--muted,#8a8f98);font-size:9.5px;margin-top:2px;}
.mc-regime{padding:8px;border-radius:6px;font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.5;}
.mc-regime.fear{background:rgba(224,82,82,0.12);color:#ff8a8a;}
.mc-regime.greed{background:rgba(76,175,125,0.12);color:#7fd9a4;}
.mc-regime.neutral{background:rgba(255,255,255,0.04);color:var(--text,#EAECEF);}
.mc-regime.news{background:rgba(245,203,66,0.12);color:#f5cb42;}
`;
document.head.appendChild(style);
function fmtUsd(n) {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}
function fmtPct(n) {
  if (n == null || !isFinite(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}
function chgColor(n) { return n >= 0 ? '#4CAF7D' : '#E05252'; }
function fgColor(v) {
  if (v <= 25) return '#E05252';
  if (v <= 45) return '#f5cb42';
  if (v <= 55) return '#B0B4BB';
  if (v <= 75) return '#7fd9a4';
  return '#4CAF7D';
}
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function renderShell() {
  panelEl.innerHTML = `<div class="mc-panel" id="mc-body"><div class="mc-title">🌐 Market Context <span style="font-size:10px;color:var(--muted,#8a8f98);font-family:'JetBrains Mono',monospace;">loading...</span></div><div style="color:var(--muted,#8a8f98);font-size:12px;padding:20px 0;text-align:center;">Fetching macro data...</div></div>`;
}
function render(d) {
  const body = document.getElementById('mc-body');
  if (!body || !d) return;
  const fg = d.fearGreed;
  const g = d.global;
  const m = d.majors;
  const r = d.regime;
  const regimeClass = r.newsVolFlag ? 'news' : (r.bias.includes('fear') ? 'fear' : r.bias.includes('greed') ? 'greed' : 'neutral');
  body.innerHTML = `
    <div class="mc-title">🌐 Market Context <span style="font-size:10px;color:var(--muted,#8a8f98);font-family:'JetBrains Mono',monospace;">${timeAgo(d.ts)}</span></div>
    <div class="mc-section">
      <div class="mc-label">Fear & Greed Index</div>
      <div class="mc-fg">
        <span class="mc-fg-val" style="color:${fg ? fgColor(fg.value) : '#8a8f98'}">${fg ? fg.value : '—'}</span>
        <span class="mc-fg-lbl">${fg ? fg.label : 'no data'}</span>
      </div>
      ${fg ? `<div class="mc-fg-bar"><div class="mc-fg-ptr" style="left:${fg.value}%"></div></div>` : ''}
    </div>
    <div class="mc-section">
      <div class="mc-label">Global Market</div>
      <div class="mc-grid">
        <div class="mc-stat"><div class="mc-stat-lbl">Market Cap</div><div class="mc-stat-val">${g ? fmtUsd(g.totalMarketCapUsd) : '—'}</div></div>
        <div class="mc-stat"><div class="mc-stat-lbl">24h Change</div><div class="mc-stat-val" style="color:${g ? chgColor(g.marketCapChange24hPct) : '#8a8f98'}">${g ? fmtPct(g.marketCapChange24hPct) : '—'}</div></div>
        <div class="mc-stat"><div class="mc-stat-lbl">BTC Dom</div><div class="mc-stat-val">${g ? g.btcDominance.toFixed(1) + '%' : '—'}</div></div>
        <div class="mc-stat"><div class="mc-stat-lbl">24h Vol</div><div class="mc-stat-val">${g ? fmtUsd(g.totalVolume24hUsd) : '—'}</div></div>
      </div>
    </div>
    <div class="mc-section">
      <div class="mc-label">Majors (24h)</div>
      ${m ? ['btc','eth','sol','bnb'].map(k => `
        <div class="mc-coin-row">
          <span class="mc-coin-sym">${k.toUpperCase()}</span>
          <span>$${m[k].price.toLocaleString(undefined,{maximumFractionDigits: m[k].price < 10 ? 3 : 0})}</span>
          <span class="mc-coin-chg" style="color:${chgColor(m[k].change24h)}">${fmtPct(m[k].change24h)}</span>
        </div>`).join('') : '<div style="color:var(--muted);">—</div>'}
    </div>
    <div class="mc-section">
      <div class="mc-label">Trending Coins</div>
      ${(d.trending || []).slice(0, 5).map((t, i) => `
        <div class="mc-trend-row">
          <span class="mc-trend-rank">${i + 1}</span>
          <span class="mc-trend-sym">${t.symbol.toUpperCase()}</span>
          <span style="color:var(--muted,#8a8f98);font-size:10px;">${t.name}</span>
          <span style="color:var(--muted,#8a8f98);">#${t.rank || '—'}</span>
        </div>
      `).join('') || '<div style="color:var(--muted);font-size:11px;">no data</div>'}
    </div>
    <div class="mc-section">
      <div class="mc-label">Regime Summary</div>
      <div class="mc-regime ${regimeClass}">
        <div style="font-weight:600;margin-bottom:3px;">${r.bias.replace(/_/g,' ').toUpperCase()} ${r.newsVolFlag ? '· NEWS SPIKE' : ''}</div>
        ${r.reasons.slice(0, 4).map(x => `<div style="font-size:10px;color:inherit;opacity:0.85;">· ${x}</div>`).join('')}
      </div>
    </div>
    <div class="mc-section">
      <div class="mc-label">Latest News (${d.news ? d.news.length : 0})</div>
      ${(d.news || []).slice(0, 6).map(n => `
        <div class="mc-news-row${n.isBreaking ? ' breaking' : ''}">
          ${n.isBreaking ? '⚠ ' : ''}${n.title}
          <div class="mc-news-src">${n.source} · ${timeAgo(n.ts)}</div>
        </div>`).join('') || '<div style="color:var(--muted);font-size:11px;">no news</div>'}
    </div>
  `;
}
async function refresh() {
  try {
    const r = await fetch(`${API_BASE}/api/macro-context`);
    if (!r.ok) return;
    const d = await r.json();
    render(d);
  } catch (e) {
    const body = document.getElementById('mc-body');
    if (body) body.innerHTML = `<div class="mc-title">🌐 Market Context</div><div style="color:#E05252;font-size:12px;padding:20px 0;">API unavailable: ${e.message}</div>`;
  }
}
function toggle() {
  active = !active;
  if (active) {
    panelEl = document.getElementById('order-book-root');
    if (!panelEl) { console.error('[market-context] #order-book-root not found'); active = false; return active; }
    savedHTML = panelEl.innerHTML;
    renderShell();
    refresh();
    refreshTimer = setInterval(refresh, REFRESH_MS);
  } else {
    clearInterval(refreshTimer);
    refreshTimer = null;
    if (panelEl && savedHTML !== null) panelEl.innerHTML = savedHTML;
    savedHTML = null;
  }
  return active;
}
window.marketContext = { toggle };
})();
