// ══════════════════════════════════════════════════════════════════════════
// chart-terminal/trade-terminal.js
//
// Demo trading panel: Long/Short, leverage, margin input, TP/SL, order
// submission, open positions list with live PnL, auto TP/SL/liquidation
// close, and trade history.
//
// Reads the live price ONLY from market-store.js (onKline). Never opens its
// own WebSocket.
//
// DEPENDS ON A GLOBAL SUPABASE CLIENT: this file expects `db` (the Supabase
// client) and `state.user` (the logged-in user) to already exist as globals
// — they're created in the root index.js, which stays loaded alongside the
// chart-terminal modules. If index.js's Supabase init block is ever removed
// or renamed, this file needs its `db`/`state.user` references updated.
//
// SCOPE NOTE: draggable TP/SL lines directly on the chart, and the entry
// price badge overlay drawn on the candles, are NOT included in this file —
// those need coordinate-mapping hooks from chart-engine.js that don't exist
// yet. Left out on purpose to keep this file focused; add as a small
// extension to chart-engine.js + this file later when needed.
//
// Depends on: market-store.js (must load first).
// ══════════════════════════════════════════════════════════════════════════

(function () {

  if (typeof marketStore === 'undefined') {
    console.error('[trade-terminal] market-store.js must load before trade-terminal.js');
    return;
  }

  // ── Style ────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .tt-panel{background:var(--bg2);border:1px solid var(--border,rgba(255,255,255,0.08));border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:12px;box-sizing:border-box;}
    .tt-balance{display:flex;justify-content:space-between;align-items:baseline;font-family:'Outfit',sans-serif;}
    .tt-balance-label{font-size:12px;color:var(--muted,#8a8f98);}
    .tt-balance-value{font-size:16px;font-weight:600;color:var(--text,#EAECEF);font-family:'JetBrains Mono',monospace;}

    .tt-side-toggle{display:flex;gap:8px;}
    .tt-side-btn{flex:1;padding:11px;border-radius:8px;background:var(--bg3);border:1px solid var(--border,rgba(255,255,255,0.08));color:var(--muted,#8a8f98);font-family:'Outfit',sans-serif;font-weight:600;font-size:14px;cursor:pointer;}
    .tt-side-btn.long-active{background:var(--green,#4CAF7D);color:#0D0F13;border-color:var(--green,#4CAF7D);}
    .tt-side-btn.short-active{background:var(--red,#E05252);color:#fff;border-color:var(--red,#E05252);}

    .tt-field-label{font-size:11.5px;color:var(--muted,#8a8f98);margin-bottom:5px;display:block;}
    .tt-select,.tt-input{width:100%;padding:10px 12px;border-radius:8px;background:var(--bg3);border:1px solid var(--border,rgba(255,255,255,0.08));color:var(--text,#EAECEF);font-family:'Outfit',sans-serif;font-size:13.5px;box-sizing:border-box;}
    .tt-input::placeholder{color:var(--muted,#8a8f98);}

    .tt-pct-row{display:flex;gap:6px;margin-top:6px;}
    .tt-pct-btn{flex:1;padding:6px;border-radius:6px;background:var(--bg3);border:1px solid var(--border,rgba(255,255,255,0.08));color:var(--muted,#8a8f98);font-size:11.5px;cursor:pointer;}
    .tt-pct-btn.active{background:var(--gold-dim);color:var(--gold);border-color:var(--gold);}

    .tt-estimates{background:var(--bg3);border-radius:8px;padding:10px 12px;font-family:'JetBrains Mono',monospace;font-size:12px;}
    .tt-est-row{display:flex;justify-content:space-between;padding:3px 0;color:var(--muted,#8a8f98);}
    .tt-est-row span:last-child{color:var(--text,#EAECEF);}

    .tt-submit{width:100%;padding:13px;border-radius:8px;font-family:'Outfit',sans-serif;font-weight:600;font-size:14px;border:none;cursor:pointer;}
    .tt-submit.long{background:var(--green,#4CAF7D);color:#0D0F13;}
    .tt-submit.short{background:var(--red,#E05252);color:#fff;}
    .tt-submit-note{text-align:center;font-size:11px;color:var(--muted,#8a8f98);}

    .tt-positions{margin-top:4px;}
    .tt-pos-row{display:flex;align-items:center;gap:8px;padding:8px 6px;border-bottom:1px solid var(--border,rgba(255,255,255,0.06));font-size:12px;font-family:'Outfit',sans-serif;}
    .tt-pos-side{font-weight:600;font-family:'JetBrains Mono',monospace;font-size:11.5px;padding:2px 6px;border-radius:4px;}
    .tt-pos-side.long{color:var(--green,#4CAF7D);background:rgba(76,175,125,0.12);}
    .tt-pos-side.short{color:var(--red,#E05252);background:rgba(224,82,82,0.12);}
    .tt-pos-meta{flex:1;color:var(--muted,#8a8f98);font-size:11.5px;}
    .tt-pos-pnl{font-family:'JetBrains Mono',monospace;font-weight:600;}
    .tt-pos-pnl.pos{color:var(--green,#4CAF7D);}
    .tt-pos-pnl.neg{color:var(--red,#E05252);}
    .tt-pos-close{background:transparent;border:1px solid var(--border,rgba(255,255,255,0.15));color:var(--muted,#8a8f98);border-radius:5px;padding:3px 8px;font-size:11px;cursor:pointer;}
    .tt-pos-close:hover{border-color:var(--red,#E05252);color:var(--red,#E05252);}
    .tt-empty{color:var(--muted,#8a8f98);font-size:12px;text-align:center;padding:16px 0;}
  `;
  document.head.appendChild(style);

  // ── State ────────────────────────────────────────────────────────────
  let mountEl = null;
  let selectedSide = 'long';
  let demoBalance = 0;
  let openPositions = [];
  let latestPrice = null;
  let closingInProgress = {};

  // ── Public init ─────────────────────────────────────────────────────
  function init(opts = {}) {
    mountEl = document.getElementById(opts.mountId || 'trade-terminal-root');
    if (!mountEl) { console.error('[trade-terminal] mount element not found'); return; }
    if (typeof db === 'undefined') { console.error('[trade-terminal] global Supabase client `db` not found — is index.js loaded?'); return; }

    render();
    ensureDemoAccount().then(loadDemoPositions);

    marketStore.onKline((candle) => {
      latestPrice = candle.close;
      updateLiqPreview();
      updateOpenPositionsPnL(latestPrice);
      checkTpSlLiquidation(latestPrice);
    });
  }

  // ── Render ──────────────────────────────────────────────────────────
  function render() {
    mountEl.innerHTML = `
      <div class="tt-panel">
        <div class="tt-balance"><span class="tt-balance-label">Demo Balance</span><span class="tt-balance-value" id="tt-balance">$0.00</span></div>

        <div class="tt-side-toggle">
          <button class="tt-side-btn long-active" id="tt-btn-long">Long</button>
          <button class="tt-side-btn" id="tt-btn-short">Short</button>
        </div>

        <div>
          <label class="tt-field-label">Leverage</label>
          <select class="tt-select" id="tt-leverage">
            ${[2,5,10,20,25,50,75,100].map(x => `<option value="${x}"${x===20?' selected':''}>${x}x</option>`).join('')}
          </select>
        </div>

        <div>
          <label class="tt-field-label">Margin (USD)</label>
          <input type="number" class="tt-input" id="tt-qty" placeholder="0.00">
          <div class="tt-pct-row">
            ${[25,50,75,100].map(p => `<button class="tt-pct-btn" data-pct="${p}">${p}%</button>`).join('')}
          </div>
        </div>

        <div>
          <label class="tt-field-label">Take Profit (optional)</label>
          <input type="number" class="tt-input" id="tt-tp" placeholder="Price">
        </div>
        <div>
          <label class="tt-field-label">Stop Loss (optional)</label>
          <input type="number" class="tt-input" id="tt-sl" placeholder="Price">
        </div>

        <div class="tt-estimates">
          <div class="tt-est-row"><span>Est. Margin</span><span id="tt-est-margin">—</span></div>
          <div class="tt-est-row"><span>Est. Position Size</span><span id="tt-est-size">—</span></div>
          <div class="tt-est-row"><span>Est. Liquidation</span><span id="tt-est-liq">—</span></div>
          <div class="tt-est-row"><span>Potential PnL</span><span id="tt-est-pnl">—</span></div>
        </div>

        <button class="tt-submit long" id="tt-submit">Buy / Long</button>
        <div class="tt-submit-note">Demo mode — no real funds</div>

        <div class="tt-positions" id="tt-positions"><div class="tt-empty">No open positions — place a demo trade to see it here.</div></div>
      </div>
    `;
    bindEvents();
  }

  function bindEvents() {
    document.getElementById('tt-btn-long').onclick = () => setSide('long');
    document.getElementById('tt-btn-short').onclick = () => setSide('short');
    document.getElementById('tt-submit').onclick = submitDemoOrder;

    document.querySelectorAll('.tt-pct-btn').forEach(btn => {
      btn.onclick = () => setQtyPct(parseInt(btn.getAttribute('data-pct'), 10));
    });

    ['tt-qty', 'tt-leverage'].forEach(id => {
      document.getElementById(id).addEventListener('input', updateLiqPreview);
    });
  }

  // ── Side / quantity ─────────────────────────────────────────────────
  function setSide(side) {
    selectedSide = side;
    document.getElementById('tt-btn-long').classList.toggle('long-active', side === 'long');
    document.getElementById('tt-btn-short').classList.toggle('short-active', side === 'short');
    const submitBtn = document.getElementById('tt-submit');
    submitBtn.textContent = side === 'long' ? 'Buy / Long' : 'Sell / Short';
    submitBtn.className = 'tt-submit ' + side;
    updateLiqPreview();
  }

  function setQtyPct(pct) {
    const raw = demoBalance * pct / 100;
    const val = pct >= 100 ? Math.floor(demoBalance * 100) / 100 : Math.floor(raw * 100) / 100;
    document.getElementById('tt-qty').value = val.toFixed(2);
    document.querySelectorAll('.tt-pct-btn').forEach(b => b.classList.toggle('active', parseInt(b.getAttribute('data-pct'), 10) === pct));
    updateLiqPreview();
  }

  // ── Estimates ───────────────────────────────────────────────────────
  function updateLiqPreview() {
    const qty = parseFloat(document.getElementById('tt-qty').value) || 0;
    const lev = parseInt(document.getElementById('tt-leverage').value) || 1;
    const price = latestPrice;

    if (!qty || !price) {
      setText('tt-est-margin', '—'); setText('tt-est-size', '—');
      setText('tt-est-liq', '—'); setText('tt-est-pnl', '—');
      return;
    }

    const liq = selectedSide === 'long' ? price * (1 - 1 / lev) : price * (1 + 1 / lev);
    const positionSize = qty * lev;

    setText('tt-est-margin', '$' + qty.toFixed(2));
    setText('tt-est-size', '$' + positionSize.toFixed(2));
    setText('tt-est-liq', liq.toFixed(1));
    setText('tt-est-pnl', '—'); // realized only once a TP is set / trade is open — kept neutral pre-trade
  }

  function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

  // ── Balance (Supabase) ──────────────────────────────────────────────
  async function ensureDemoAccount() {
    if (!state.user) return;
    const { data } = await db.from('demo_accounts').select('*').eq('user_id', state.user.id).maybeSingle();
    if (data) {
      demoBalance = parseFloat(data.balance);
    } else {
      const { data: created } = await db.from('demo_accounts').insert([{ user_id: state.user.id }]).select().single();
      demoBalance = created ? parseFloat(created.balance) : 10000;
    }
    setText('tt-balance', '$' + demoBalance.toFixed(2));
  }

  async function updateDemoBalance(newBalance) {
    demoBalance = newBalance;
    setText('tt-balance', '$' + demoBalance.toFixed(2));
    if (state.user) await db.from('demo_accounts').update({ balance: newBalance, updated_at: new Date().toISOString() }).eq('user_id', state.user.id);
  }

  // ── PnL / liquidation math ──────────────────────────────────────────
  function calcPnl(pos, price) {
    const units = (pos.quantity_usd * pos.leverage) / pos.entry_price;
    return pos.side === 'long' ? units * (price - pos.entry_price) : units * (pos.entry_price - price);
  }
  function calcLiqPrice(pos) {
    return pos.side === 'long' ? pos.entry_price * (1 - 1 / pos.leverage) : pos.entry_price * (1 + 1 / pos.leverage);
  }

  // ── Submit order ────────────────────────────────────────────────────
  async function submitDemoOrder() {
    if (!state.user) { notify('Please sign in first', 'error'); return; }
    const symbol = marketStore.getState().symbol;
    const entryPrice = latestPrice;
    if (!symbol || !entryPrice) { notify('Waiting for live price, try again in a sec', 'error'); return; }

    let qty = parseFloat(document.getElementById('tt-qty').value);
    const lev = parseInt(document.getElementById('tt-leverage').value);
    const tp = parseFloat(document.getElementById('tt-tp').value) || null;
    const sl = parseFloat(document.getElementById('tt-sl').value) || null;

    if (!qty || qty <= 0) { notify('Enter a valid margin amount', 'error'); return; }
    if (qty > demoBalance + 0.01) { notify('Insufficient demo balance', 'error'); return; }
    if (qty > demoBalance) qty = demoBalance;

    const { data, error } = await db.from('demo_positions').insert([{
      user_id: state.user.id, symbol, side: selectedSide, leverage: lev,
      quantity_usd: qty, entry_price: entryPrice, status: 'open',
      take_profit: tp, stop_loss: sl,
    }]).select().single();

    if (error) { notify('Order failed: ' + error.message, 'error'); return; }

    await updateDemoBalance(demoBalance - qty);
    notify((selectedSide === 'long' ? 'Long' : 'Short') + ' opened @ ' + entryPrice.toFixed(1), 'success');

    document.getElementById('tt-qty').value = '';
    document.getElementById('tt-tp').value = '';
    document.getElementById('tt-sl').value = '';
    updateLiqPreview();
    await loadDemoPositions();
  }

  // ── Positions ───────────────────────────────────────────────────────
  async function loadDemoPositions() {
    if (!state.user) return;
    const { data: open } = await db.from('demo_positions').select('*').eq('user_id', state.user.id).eq('status', 'open').order('opened_at', { ascending: false });
    openPositions = open || [];
    renderPositions();
  }

  function renderPositions() {
    const c = document.getElementById('tt-positions');
    if (!c) return;
    if (!openPositions.length) {
      c.innerHTML = '<div class="tt-empty">No open positions — place a demo trade to see it here.</div>';
      return;
    }
    c.innerHTML = openPositions.map(pos => {
      const pnl = latestPrice ? calcPnl(pos, latestPrice) : 0;
      const pnlClass = pnl >= 0 ? 'pos' : 'neg';
      return `
        <div class="tt-pos-row" data-id="${pos.id}">
          <span class="tt-pos-side ${pos.side}">${pos.side.toUpperCase()} ${pos.leverage}x</span>
          <span class="tt-pos-meta">Entry ${pos.entry_price.toFixed(1)} · Margin $${pos.quantity_usd.toFixed(2)}</span>
          <span class="tt-pos-pnl ${pnlClass}" id="tt-pnl-${pos.id}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USD</span>
          <button class="tt-pos-close" data-close-id="${pos.id}">Close</button>
        </div>`;
    }).join('');

    c.querySelectorAll('[data-close-id]').forEach(btn => {
      btn.onclick = () => closePosition(btn.getAttribute('data-close-id'), 'manual');
    });
  }

  function updateOpenPositionsPnL(price) {
    openPositions.forEach(pos => {
      const el = document.getElementById('tt-pnl-' + pos.id);
      if (!el) return;
      const pnl = calcPnl(pos, price);
      el.textContent = (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + ' USD';
      el.className = 'tt-pos-pnl ' + (pnl >= 0 ? 'pos' : 'neg');
    });
  }

  // ── Auto TP/SL/liquidation ───────────────────────────────────────────
  function checkTpSlLiquidation(price) {
    if (!openPositions.length) return;
    openPositions.slice().forEach(pos => {
      const liq = calcLiqPrice(pos);
      if (pos.side === 'long') {
        if (price <= liq) { closePosition(pos.id, 'liquidated', liq); return; }
        if (pos.take_profit && price >= pos.take_profit) { closePosition(pos.id, 'tp_hit', pos.take_profit); return; }
        if (pos.stop_loss && price <= pos.stop_loss) { closePosition(pos.id, 'sl_hit', pos.stop_loss); return; }
      } else {
        if (price >= liq) { closePosition(pos.id, 'liquidated', liq); return; }
        if (pos.take_profit && price <= pos.take_profit) { closePosition(pos.id, 'tp_hit', pos.take_profit); return; }
        if (pos.stop_loss && price >= pos.stop_loss) { closePosition(pos.id, 'sl_hit', pos.stop_loss); return; }
      }
    });
  }

  async function closePosition(id, reason, forcedPrice) {
    if (closingInProgress[id]) return;
    closingInProgress[id] = true;
    const pos = openPositions.find(p => p.id === id);
    if (!pos) { closingInProgress[id] = false; return; }
    const exitPrice = forcedPrice || latestPrice || pos.entry_price;
    const pnl = calcPnl(pos, exitPrice);

    const { error } = await db.from('demo_positions').update({
      status: 'closed', exit_price: exitPrice, pnl, closed_at: new Date().toISOString(),
    }).eq('id', id);

    if (error) { notify('Close failed: ' + error.message, 'error'); closingInProgress[id] = false; return; }

    await updateDemoBalance(demoBalance + pos.quantity_usd + pnl);

    const labels = { manual: 'Position closed', liquidated: 'Position liquidated ⚠️', tp_hit: 'Take profit hit 🎯', sl_hit: 'Stop loss hit' };
    notify((labels[reason] || 'Closed') + ' @ ' + exitPrice.toFixed(1) + ' | PnL ' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2), pnl >= 0 ? 'success' : 'error');

    closingInProgress[id] = false;
    await loadDemoPositions();
  }

  // ── Toast (falls back to console if the site's global showToast isn't available) ──
  function notify(message, type) {
    if (typeof window.showToast === 'function') window.showToast(message, type);
    else console.log(`[trade-terminal] ${type}: ${message}`);
  }

  // ── Expose ───────────────────────────────────────────────────────────
  window.tradeTerminal = { init, getOpenPositions: () => [...openPositions] };

})();

// ══════════════════════════════════════════════════════════════════════════
// USAGE:
//
//   tradeTerminal.init({ mountId: 'trade-terminal-root' });
//
// Needs a <div id="trade-terminal-root"></div> in the layout. Uses the
// global `db` (Supabase) and `state.user` from index.js, and the global
// `showToast()` if present — falls back to console logging if not found so
// it never throws.
// ══════════════════════════════════════════════════════════════════════════
