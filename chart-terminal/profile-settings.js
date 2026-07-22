// ══════════════════════════════════════════════════════════════════════════
// chart-terminal/profile-settings.js
//
// Compact top-bar widget for the chart terminal: a Settings gear icon and a
// Profile avatar with a quick-access dropdown (name, email, links, logout).
//
// NOTE — SCOPE: this is NOT the full Profile/Settings pages. Those already
// exist in the root index.html/index.js (#section-profile, #section-settings)
// as part of the "rest of the app" pages, and are left completely untouched.
// This file just gives the terminal's own top bar a quick-glance widget that
// reuses those existing pages via the global showSection() function, and the
// existing global handleLogout() — both defined in index.js.
//
// DEPENDS ON GLOBALS FROM index.js: `state.user`, `state.profile`,
// `showSection()`, `handleLogout()`. All already exist there and are
// untouched by the migration, so this works as-is.
// ══════════════════════════════════════════════════════════════════════════

(function () {

  // ── Style ────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .pfs-bar{display:flex;align-items:center;gap:10px;}
    .pfs-gear{width:36px;height:36px;border-radius:8px;background:var(--bg3);border:1px solid var(--border,rgba(255,255,255,0.08));display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--muted,#8a8f98);}
    .pfs-gear:hover{color:var(--gold);border-color:var(--gold);}
    .pfs-gear svg{width:18px;height:18px;}

    .pfs-avatar-wrap{position:relative;}
    .pfs-avatar{width:36px;height:36px;border-radius:50%;background:var(--gold);color:var(--gold-text);display:flex;align-items:center;justify-content:center;font-family:'Outfit',sans-serif;font-weight:700;font-size:14px;cursor:pointer;overflow:hidden;border:1px solid transparent;}
    .pfs-avatar img{width:100%;height:100%;object-fit:cover;}

    .pfs-dd{display:none;position:absolute;top:calc(100% + 8px);right:0;width:220px;background:var(--bg3);border:1px solid var(--border,rgba(255,255,255,0.1));border-radius:10px;padding:6px;z-index:50;box-shadow:0 12px 30px rgba(0,0,0,0.35);}
    .pfs-dd.open{display:block;}
    .pfs-dd-head{padding:10px 10px 8px;border-bottom:1px solid var(--border,rgba(255,255,255,0.08));margin-bottom:4px;}
    .pfs-dd-name{font-family:'Outfit',sans-serif;font-weight:600;font-size:13.5px;color:var(--text,#EAECEF);}
    .pfs-dd-email{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted,#8a8f98);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .pfs-dd-item{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:6px;font-family:'Outfit',sans-serif;font-size:13px;color:var(--text,#EAECEF);cursor:pointer;}
    .pfs-dd-item:hover{background:var(--bg4);}
    .pfs-dd-item.danger{color:var(--red,#E05252);}
    .pfs-dd-icon{width:15px;text-align:center;opacity:0.8;}
  `;
  document.head.appendChild(style);

  let mountEl = null;

  // ── Public init ─────────────────────────────────────────────────────
  function init(opts = {}) {
    mountEl = document.getElementById(opts.mountId || 'profile-settings-root');
    if (!mountEl) { console.error('[profile-settings] mount element not found'); return; }

    render();
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.pfs-avatar-wrap')) closeDropdown();
    });
  }

  function render() {
    const initial = getInitial();
    const avatarUrl = (typeof state !== 'undefined' && state.profile && state.profile.avatar_url) || null;

    mountEl.innerHTML = `
      <div class="pfs-bar">
        <button class="pfs-gear" id="pfs-gear-btn" title="Settings">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>

        <div class="pfs-avatar-wrap">
          <div class="pfs-avatar" id="pfs-avatar-btn">${avatarUrl ? `<img src="${avatarUrl}">` : initial}</div>
          <div class="pfs-dd" id="pfs-dd">
            <div class="pfs-dd-head">
              <div class="pfs-dd-name" id="pfs-dd-name">${getDisplayName()}</div>
              <div class="pfs-dd-email" id="pfs-dd-email">${getEmail()}</div>
            </div>
            <div class="pfs-dd-item" id="pfs-item-profile"><span class="pfs-dd-icon">👤</span> View Profile</div>
            <div class="pfs-dd-item" id="pfs-item-settings"><span class="pfs-dd-icon">⚙️</span> Settings</div>
            <div class="pfs-dd-item danger" id="pfs-item-logout"><span class="pfs-dd-icon">↪</span> Log out</div>
          </div>
        </div>
      </div>
    `;

    bindEvents();
  }

  function bindEvents() {
    document.getElementById('pfs-gear-btn').onclick = () => goTo('settings');
    document.getElementById('pfs-avatar-btn').onclick = (e) => { e.stopPropagation(); toggleDropdown(); };
    document.getElementById('pfs-item-profile').onclick = () => goTo('profile');
    document.getElementById('pfs-item-settings').onclick = () => goTo('settings');
    document.getElementById('pfs-item-logout').onclick = () => {
      closeDropdown();
      if (typeof handleLogout === 'function') handleLogout();
      else console.warn('[profile-settings] handleLogout() not found — is index.js loaded?');
    };
  }

  function goTo(section) {
    closeDropdown();
    if (typeof showSection === 'function') showSection(section);
    else console.warn('[profile-settings] showSection() not found — is index.js loaded?');
  }

  function toggleDropdown() {
    document.getElementById('pfs-dd').classList.toggle('open');
  }
  function closeDropdown() {
    const dd = document.getElementById('pfs-dd');
    if (dd) dd.classList.remove('open');
  }

  // ── Helpers ─────────────────────────────────────────────────────────
  function getDisplayName() {
    if (typeof state !== 'undefined' && state.profile && state.profile.full_name) return state.profile.full_name;
    if (typeof state !== 'undefined' && state.user && state.user.email) return state.user.email.split('@')[0];
    return 'Trader';
  }
  function getEmail() {
    return (typeof state !== 'undefined' && state.user && state.user.email) || '';
  }
  function getInitial() {
    return getDisplayName().charAt(0).toUpperCase();
  }

  // Call this if the profile loads asynchronously after init() already ran
  // (e.g. after ensureDemoAccount()-style Supabase fetch completes elsewhere).
  function refresh() {
    if (mountEl) render();
  }

  // ── Expose ───────────────────────────────────────────────────────────
  window.profileSettings = { init, refresh };

})();

// ══════════════════════════════════════════════════════════════════════════
// USAGE:
//
//   profileSettings.init({ mountId: 'profile-settings-root' });
//
// Needs a <div id="profile-settings-root"></div> in the terminal's top bar.
// If profile data (name/avatar) loads a moment after this runs, call
// profileSettings.refresh() once it's ready to update the widget.
// ══════════════════════════════════════════════════════════════════════════
