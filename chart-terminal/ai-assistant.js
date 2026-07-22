// ══════════════════════════════════════════════════════════════════════════
// chart-terminal/ai-assistant.js
//
// AI popup, opened by the ✨ AI button already wired up in chart-cockpit.js
// (it calls window.aiAssistant.open() — no changes needed there).
//
// Sends chat messages to a Supabase Edge Function, following the same
// pattern already used elsewhere in this codebase (db.functions.invoke),
// e.g. the existing 'ai-calculator' and 'ai-statistics' functions.
//
// ⚠️ EDGE FUNCTION NOT CREATED YET: this file calls 'ai-chart-assistant',
// which needs to be built in Supabase (same shape as 'ai-calculator') before
// this will return real answers. Until then, the popup UI fully works, but
// shows a friendly error when it can't reach the function — nothing breaks.
//
// DEPENDS ON A GLOBAL SUPABASE CLIENT: expects `db` (from index.js) to
// exist as a global.
//
// Depends on: market-store.js (must load first, for chart context).
// ══════════════════════════════════════════════════════════════════════════

(function () {

  const EDGE_FUNCTION_NAME = 'ai-chart-assistant'; // rename here if you create it under a different name

  // ── Style ────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .aia-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:200;align-items:flex-end;justify-content:center;}
    .aia-overlay.open{display:flex;}
    @media (min-width:720px){ .aia-overlay{align-items:center;} }

    .aia-panel{width:100%;max-width:480px;max-height:78vh;background:var(--bg2);border:1px solid var(--border,rgba(255,255,255,0.1));border-radius:16px 16px 0 0;display:flex;flex-direction:column;box-shadow:0 -10px 40px rgba(0,0,0,0.4);}
    @media (min-width:720px){ .aia-panel{border-radius:16px;height:600px;} }

    .aia-header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border,rgba(255,255,255,0.08));}
    .aia-title{font-family:'Cormorant Garamond',serif;font-size:18px;font-weight:600;color:var(--text,#EAECEF);display:flex;align-items:center;gap:8px;}
    .aia-title .spark{color:var(--gold);}
    .aia-close{background:transparent;border:none;color:var(--muted,#8a8f98);font-size:20px;cursor:pointer;line-height:1;padding:4px;}
    .aia-close:hover{color:var(--text,#EAECEF);}

    .aia-messages{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px;}
    .aia-msg{max-width:85%;padding:10px 13px;border-radius:12px;font-family:'Outfit',sans-serif;font-size:13.5px;line-height:1.5;white-space:pre-wrap;}
    .aia-msg.user{align-self:flex-end;background:var(--gold);color:var(--gold-text);border-bottom-right-radius:3px;}
    .aia-msg.assistant{align-self:flex-start;background:var(--bg3);color:var(--text,#EAECEF);border-bottom-left-radius:3px;}
    .aia-msg.error{align-self:flex-start;background:rgba(224,82,82,0.12);color:var(--red,#E05252);border-bottom-left-radius:3px;}
    .aia-msg.thinking{align-self:flex-start;background:var(--bg3);color:var(--muted,#8a8f98);font-style:italic;}

    .aia-context-chip{align-self:center;font-size:11px;color:var(--muted,#8a8f98);background:var(--bg3);padding:4px 10px;border-radius:20px;font-family:'JetBrains Mono',monospace;}

    .aia-input-row{display:flex;gap:8px;padding:12px 14px;border-top:1px solid var(--border,rgba(255,255,255,0.08));}
    .aia-input{flex:1;padding:11px 14px;border-radius:24px;background:var(--bg3);border:1px solid var(--border,rgba(255,255,255,0.08));color:var(--text,#EAECEF);font-family:'Outfit',sans-serif;font-size:13.5px;}
    .aia-send{width:42px;height:42px;border-radius:50%;background:var(--gold);color:var(--gold-text);border:none;cursor:pointer;font-size:16px;flex-shrink:0;}
    .aia-send:disabled{opacity:0.5;cursor:default;}
  `;
  document.head.appendChild(style);

  // ── State ────────────────────────────────────────────────────────────
  let overlayEl = null;
  let history = []; // [{role:'user'|'assistant', content:'...'}]
  let sending = false;

  // ── Build once, lazily, on first open() ─────────────────────────────
  function ensureBuilt() {
    if (overlayEl) return;

    overlayEl = document.createElement('div');
    overlayEl.className = 'aia-overlay';
    overlayEl.innerHTML = `
      <div class="aia-panel">
        <div class="aia-header">
          <div class="aia-title"><span class="spark">✨</span> EdgeTrade AI</div>
          <button class="aia-close" id="aia-close-btn">×</button>
        </div>
        <div class="aia-messages" id="aia-messages">
          <div class="aia-context-chip" id="aia-context-chip"></div>
          <div class="aia-msg assistant">Hey! Ask me about the current chart, market, or your trading setup.</div>
        </div>
        <div class="aia-input-row">
          <input type="text" class="aia-input" id="aia-input" placeholder="Ask about this chart...">
          <button class="aia-send" id="aia-send-btn">↑</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlayEl);

    overlayEl.addEventListener('click', (e) => { if (e.target === overlayEl) close(); });
    document.getElementById('aia-close-btn').onclick = close;
    document.getElementById('aia-send-btn').onclick = sendMessage;
    document.getElementById('aia-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !sending) sendMessage();
    });
  }

  function updateContextChip() {
    const chip = document.getElementById('aia-context-chip');
    if (!chip) return;
    if (typeof marketStore !== 'undefined') {
      const st = marketStore.getState();
      chip.textContent = `Viewing ${st.symbol.replace(/USDT$/, '')}/USDT · ${st.interval}`;
    } else {
      chip.textContent = '';
    }
  }

  // ── Open / close ────────────────────────────────────────────────────
  function open() {
    ensureBuilt();
    updateContextChip();
    overlayEl.classList.add('open');
    document.getElementById('aia-input').focus();
  }
  function close() {
    if (overlayEl) overlayEl.classList.remove('open');
  }
  function toggle() {
    if (overlayEl && overlayEl.classList.contains('open')) close(); else open();
  }

  // ── Messaging ───────────────────────────────────────────────────────
  function appendMessage(role, text) {
    const list = document.getElementById('aia-messages');
    const el = document.createElement('div');
    el.className = 'aia-msg ' + role;
    el.textContent = text;
    list.appendChild(el);
    list.scrollTop = list.scrollHeight;
    return el;
  }

  async function sendMessage() {
    if (sending) return;
    const input = document.getElementById('aia-input');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    appendMessage('user', text);
    history.push({ role: 'user', content: text });

    const thinkingEl = appendMessage('thinking', 'Thinking...');
    sending = true;
    document.getElementById('aia-send-btn').disabled = true;

    try {
      if (typeof db === 'undefined') throw new Error('Supabase client not available');

      const context = typeof marketStore !== 'undefined' ? marketStore.getState() : {};
      const { data, error } = await db.functions.invoke(EDGE_FUNCTION_NAME, {
        body: {
          message: text,
          history: history.slice(-10), // last 10 turns, keep the payload small
          context: { symbol: context.symbol, interval: context.interval, latestPrice: context.latestPrice },
        },
      });

      thinkingEl.remove();
      if (error) throw error;

      const reply = (data && data.reply) || "Sorry, I didn't get a response — try again.";
      appendMessage('assistant', reply);
      history.push({ role: 'assistant', content: reply });
    } catch (err) {
      thinkingEl.remove();
      appendMessage('error', `Couldn't reach the AI right now (${err.message || 'unknown error'}). The '${EDGE_FUNCTION_NAME}' edge function may not be set up yet.`);
      console.error('[ai-assistant]', err);
    } finally {
      sending = false;
      document.getElementById('aia-send-btn').disabled = false;
    }
  }

  // ── Expose ───────────────────────────────────────────────────────────
  window.aiAssistant = { open, close, toggle };

})();

// ══════════════════════════════════════════════════════════════════════════
// USAGE: nothing to call manually — chart-cockpit.js's ✨ AI button already
// calls window.aiAssistant.open() automatically once this file's script tag
// is uncommented in index.html.
//
// TO MAKE IT ACTUALLY ANSWER: create a Supabase Edge Function named
// 'ai-chart-assistant' (same folder pattern as your existing 'ai-calculator'
// function) that accepts { message, history, context } and returns
// { reply: "..." }.
// ══════════════════════════════════════════════════════════════════════════
