// ══════════════════════════════════════════════════════════════════════════
// chart-terminal/order-book.js
//
// Renders the Order Book panel: bid/ask rows, spread, buy/sell pressure bar.
// Reads live depth data ONLY from market-store.js's onDepth() stream —
// never opens its own WebSocket, never touches Binance directly.
//
// Depends on: market-store.js (must load first).
// ══════════════════════════════════════════════════════════════════════════

(function () {

  if (typeof marketStore === 'undefined') {
    console.error('[order-book] market-store.js must load before order-book.js');
    return;
  }

  const VISIBLE_DEPTH = 8; // rows shown on each side, matches existing site behavior

  // ── Style ────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .ob-panel{background:var(--bg2);border:1px solid var(--border,rgba(255,255,255,0.08));border-radius:12px;padding:14px;display:flex;flex-direction:column;height:100%;box-sizing:border-box;}
    .ob-header{display:flex;align-items:baseline;gap:6px;margin-bottom:10px;font-family:'Cormorant Garamond',serif;}
    .ob-header-title{font-size:17px;font-weight:600;color:var(--text,#EAECEF);}
    .ob-header-symbol{font-size:13px;color:var(--gold);font-family:'JetBrains Mono',monospace;}
    .ob-col-labels{display:flex;justify-content:space-between;font-size:10.5px;color:var(--muted,#8a8f98);text-transform:uppercase;letter-spacing:0.5px;padding:0 2px 4px;}
    .ob-body{flex:1;overflow-y:auto;}
    .ob-row{position:relative;display:flex;justify-content:space-between;padding:3px 4px;font-family:'JetBrains Mono',monospace;font-size:12px;overflow:hidden;border-radius:3px;}
    .ob-bar{position:absolute;top:0;right:0;bottom:0;z-index:0;opacity:0.16;}
    .ob-row.ask .ob-bar{background:var(--red,#E05252);}
    .ob-row.bid .ob-bar{background:var(--green,#4CAF7D);}
    .ob-price{position:relative;z-index:1;}
    .ob-price.ask{color:var(--red,#E05252);}
    .ob-price.bid{color:var(--green,#4CAF7D);}
    .ob-row > span:last-child{position:relative;z-index:1;color:var(--muted,#8a8f98);}
    .ob-spread{text-align:center;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--muted,#8a8f98);padding:6px 0;border-top:1px dashed var(--border,rgba(255,255,255,0.1));border-bottom:1px dashed var(--border,rgba(255,255,255,0.1));margin:2px 0;}

    .ob-pressure{margin-top:10px;}
    .ob-pressure-labels{display:flex;justify-content:space-between;font-size:11px;font-family:'Outfit',sans-serif;margin-bottom:4px;}
    .ob-pressure-buy-lbl{color:var(--green,#4CAF7D);}
    .ob-pressure-sell-lbl{color:var(--red,#E05252);}
    .ob-pressure-bar{display:flex;height:6px;border-radius:4px;overflow:hidden;background:var(--bg4);}
    .ob-pressure-buy{background:var(--green,#4CAF7D);height:100%;}
    .ob-pressure-sell{background:var(--red,#E05252);height:100%;}
  `;
  document.head.appendChild(style);

  let mountEl = null;

  // ── Public init ─────────────────────────────────────────────────────
  function init(opts = {}) {
    mountEl = document.getElementById(opts.mountId || 'order-book-root');
    if (!mountEl) { console.error('[order-book] mount element not found'); return; }

    render(marketStore.getState().symbol);

    marketStore.onDepth(({ bids, asks }) => renderRows(bids, asks));
    marketStore.onSymbolChange(({ symbol }) => updateSymbolLabel(symbol));
  }

  function render(symbol) {
    mountEl.innerHTML = `
      <div class="ob-panel">
        <div class="ob-header">
          <span class="ob-header-title">Order Book</span>
          <span class="ob-header-symbol" id="ob-symbol-label">${formatSymbol(symbol)}</span>
        </div>
        <div class="ob-col-labels"><span>Price</span><span>Size ($)</span></div>
        <div class="ob-body" id="ob-body"><div style="color:var(--muted,#8a8f98);font-size:12px;padding:10px;">Loading order book...</div></div>
        <div class="ob-pressure" id="ob-pressure">
          <div class="ob-pressure-labels">
            <span class="ob-pressure-buy-lbl">Buy <span id="ob-pressure-buy-pct">50%</span></span>
            <span class="ob-pressure-sell-lbl"><span id="ob-pressure-sell-pct">50%</span> Sell</span>
          </div>
          <div class="ob-pressure-bar">
            <div class="ob-pressure-buy" id="ob-pressure-buy" style="width:50%;"></div>
            <div class="ob-pressure-sell" id="ob-pressure-sell" style="width:50%;"></div>
          </div>
        </div>
      </div>
    `;
  }

  function updateSymbolLabel(symbol) {
    const el = document.getElementById('ob-symbol-label');
    if (el) el.textContent = formatSymbol(symbol);
    // Loading state again while the new symbol's first depth frame arrives.
    const body = document.getElementById('ob-body');
    if (body) body.innerHTML = '<div style="color:var(--muted,#8a8f98);font-size:12px;padding:10px;">Loading order book...</div>';
  }

  // ── Render bid/ask rows + spread + pressure bar ────────────────────
  // NOTE: market-store now emits each level as {price, qty, total} — total
  // is the DOLLAR value (price * qty), summed across all active brokers.
  // "Size" column shows `total` (dollars), not raw asset qty.
  function renderRows(bids, asks) {
    const body = document.getElementById('ob-body');
    if (!body) return;

    const topAsks = asks.slice(0, VISIBLE_DEPTH).reverse();
    const topBids = bids.slice(0, VISIBLE_DEPTH);
    const allTotals = [...topAsks, ...topBids].map(level => level.total);
    const maxTotal = Math.max(...allTotals, 0.001);

    let html = '';
    topAsks.forEach(level => {
      const pct = (level.total / maxTotal * 100).toFixed(0);
      html += `<div class="ob-row ask"><div class="ob-bar" style="width:${pct}%"></div><span class="ob-price ask">${level.price.toFixed(1)}</span><span>${formatDollar(level.total)}</span></div>`;
    });

    const bestBid = topBids[0] ? topBids[0].price : 0;
    const bestAsk = topAsks[topAsks.length - 1] ? topAsks[topAsks.length - 1].price : 0;
    html += `<div class="ob-spread">${bestAsk && bestBid ? (bestAsk - bestBid).toFixed(1) : '--'} spread</div>`;

    topBids.forEach(level => {
      const pct = (level.total / maxTotal * 100).toFixed(0);
      html += `<div class="ob-row bid"><div class="ob-bar" style="width:${pct}%"></div><span class="ob-price bid">${level.price.toFixed(1)}</span><span>${formatDollar(level.total)}</span></div>`;
    });

    body.innerHTML = html;

    // Buy/Sell pressure — cumulative bid vs ask DOLLAR value across the same visible depth.
    const totalBidValue = topBids.reduce((sum, level) => sum + level.total, 0);
    const totalAskValue = topAsks.reduce((sum, level) => sum + level.total, 0);
    const totalValue = totalBidValue + totalAskValue;
    const buyPct = totalValue > 0 ? (totalBidValue / totalValue * 100) : 50;
    const sellPct = 100 - buyPct;

    setText('ob-pressure-buy-pct', buyPct.toFixed(0) + '%');
    setText('ob-pressure-sell-pct', sellPct.toFixed(0) + '%');
    setWidth('ob-pressure-buy', buyPct.toFixed(0) + '%');
    setWidth('ob-pressure-sell', sellPct.toFixed(0) + '%');
  }

  // Formats a dollar amount like the chart's volume tooltip (e.g. $52.4K, $1.2M).
  function formatDollar(v) {
    if (v >= 1000000) return '$' + (v / 1000000).toFixed(2) + 'M';
    if (v >= 1000) return '$' + (v / 1000).toFixed(1) + 'K';
    return '$' + v.toFixed(0);
  }

  function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
  function setWidth(id, width) { const el = document.getElementById(id); if (el) el.style.width = width; }
  function formatSymbol(sym) { return sym.replace(/USDT$/, '') + '/USDT'; }

  // ── Expose ───────────────────────────────────────────────────────────
  window.orderBook = { init };

})();

// ══════════════════════════════════════════════════════════════════════════
// USAGE:
//
//   orderBook.init({ mountId: 'order-book-root' });
//
// Needs a <div id="order-book-root"></div> somewhere in the layout (next to
// the chart, in the trading terminal's middle column). No other setup —
// as soon as market-store.js starts receiving depth updates, this renders
// itself automatically.
// ══════════════════════════════════════════════════════════════════════════
