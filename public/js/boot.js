// Part of the Claude Code Control Panel front-end (split from app.js).
// Classic scripts share one global scope; load order in index.html is authoritative: render → chat → sessions → views → commands → boot.
// This file: boot.js

// ============================================================
//  F-Drawer — off-canvas navigation below 560px
//  The only sidebar breakpoint used to be ≤820px (a 64px icon rail), and the rail was never dismissible:
//  on a 500px window it ate 11% of the width for unlabeled icons. Below 560px the sidebar becomes a real
//  drawer (CSS does the sliding; see the WP-3 block in styles.css). ONE hamburger is injected into every
//  .topbar-title here instead of editing nine topbars.
// ============================================================
const NAV_MQ = window.matchMedia ? window.matchMedia('(max-width: 560px)') : { matches: false, addEventListener: () => {} };
let NAV_OPENER = null;
function navIsDrawer() { return !!NAV_MQ.matches; }
function navToggles() { return $$('.nav-toggle'); }
function mountNavDrawer() {
  const side = document.querySelector('.sidebar'); if (!side) return;
  if (!side.id) side.id = 'sidebar'; // aria-controls needs a target id (the markup has none)
  // scrim: one element, tap-to-close; CSS keeps it display:none above the breakpoint
  if (!$('#navScrim')) {
    const scrim = el('div', 'nav-scrim'); scrim.id = 'navScrim';
    scrim.addEventListener('click', () => closeNav());
    document.body.appendChild(scrim);
  }
  document.querySelectorAll('.topbar-title').forEach((tt) => {
    if (tt.querySelector('.nav-toggle')) return;
    const b = el('button', 'nav-toggle'); b.type = 'button';
    b.innerHTML = '<svg class="ic" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
    b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-controls', side.id);
    b.onclick = () => (document.documentElement.classList.contains('nav-open') ? closeNav() : openNav(b));
    tt.insertBefore(b, tt.firstChild);
  });
  navSyncA11y();
  const onMq = () => { if (!navIsDrawer()) closeNav(true); navSyncA11y(); };
  if (NAV_MQ.addEventListener) NAV_MQ.addEventListener('change', onMq);
  else if (NAV_MQ.addListener) NAV_MQ.addListener(onMq); // older engines
}
// the closed drawer must be unreachable by Tab/AT — but only WHILE it is a drawer
function navSyncA11y() {
  const side = document.querySelector('.sidebar'); if (!side) return;
  const open = document.documentElement.classList.contains('nav-open');
  const hide = navIsDrawer() && !open;
  if (hide) { side.setAttribute('aria-hidden', 'true'); side.inert = true; }
  else { side.removeAttribute('aria-hidden'); side.inert = false; }
  navToggles().forEach((b) => {
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    // route the label through data-i18n-title/-aria, so applyStaticI18n relabels it on a language switch
    const key = open ? 'boot.navSchliessen' : 'boot.navOeffnen';
    b.dataset.i18nTitle = key; b.dataset.i18nAria = key;
    b.title = t(key); b.setAttribute('aria-label', t(key));
  });
}
function openNav(opener) {
  if (!navIsDrawer()) return;
  NAV_OPENER = opener || document.activeElement;
  document.documentElement.classList.add('nav-open');
  navSyncA11y();
  const first = document.querySelector('.sidebar .nav-item'); if (first) { try { first.focus(); } catch { /* */ } }
}
function closeNav(silent) {
  const was = document.documentElement.classList.contains('nav-open');
  document.documentElement.classList.remove('nav-open');
  navSyncA11y();
  if (was && !silent && NAV_OPENER && document.contains(NAV_OPENER) && NAV_OPENER.offsetParent !== null) { try { NAV_OPENER.focus(); } catch { /* */ } }
  NAV_OPENER = null;
  return was;
}

// ============================================================
//  BOOT
// ============================================================
(async function boot() {
  // FIRST, before anything waits: this window takes its id back (CHAT-FLOW-4 part B, chat.js tabsReclaim) — until
  // it holds its window lock again a reloading window counts as closed, and a window starting meanwhile adopted
  // its tabs. tabsBoot below awaits the same promise.
  try { if (typeof tabsReclaim === 'function') tabsReclaim(); } catch { /* tabsBoot asks again and falls back */ }
  applyAccent(localStorage.getItem('ccui-accent'));
  if (typeof hydrateIcons === 'function') hydrateIcons();
  if (typeof applyStaticI18n === 'function') applyStaticI18n(); // relabel static chrome for the saved language (default de)
  if (typeof mountNavDrawer === 'function') mountNavDrawer(); // off-canvas nav for narrow windows (F-Drawer)
  // language flag buttons (Settings) — switch language + currency
  $$('#langFlags .lang-flag').forEach((b) => { b.onclick = () => applyLang(b.dataset.lang); b.classList.toggle('active', b.dataset.lang === LANG); });
  // A18: ONE try/catch used to wrap /api/state AND six optional loaders, so a failing prompt library or
  // PR-status call was reported as "Backend-Fehler" and silently skipped everything after it. Only the
  // /api/state fetch is actually fatal for the shell; the rest each get their own guard.
  try {
    STATE = await api('/api/state');
    $('#hostText').textContent = '127.0.0.1:' + location.port;
    $('#cwdInput').value = STATE.defaultCwd || STATE.home || '';
    refreshCwdList(); // recent/default/home only — the project paths arrive with the session load below
    // Name the path we resolved AND how we got there — on a fresh machine „nicht gefunden" alone
    // leaves the user nowhere (details incl. every checked path: System view).
    // Detection deliberately runs once per server start (a restart is the remedy, and it has a button).
    // So distinguish the two misses: if a LIVE re-resolve finds a binary now — Claude installed after
    // the panel, PATH fixed, path just entered — then „nicht gefunden" is stale and the only missing
    // step is that restart. Saying so beats repeating a complaint the user already acted on.
    if (!STATE.claudeExeExists) {
      if (STATE.claudeBinResolvedExists && STATE.claudeBinRestartNeeded) {
        toast(t('boot.claudeInzwischenGefunden') + '\n' + (STATE.claudeBinResolved || '') + ' [' + (STATE.claudeBinResolvedSource || '?') + ']', 'err');
      } else {
        toast(t('boot.claudeExeNichtGefunden') + '\n' + (STATE.claudeExe || '') + ' [' + (STATE.claudeBinSource || '?') + ']', 'err');
      }
    }
  } catch (e) {
    // N9: a page without a valid API token must not end in a toast that says „Backend-Fehler: api token
    // required" and then keep polling /api/ping every 5 seconds into a red dot. This is the ONE failure
    // here that is not an error but a missing key, so it gets the screen that says what to do — and boot
    // stops, which also means no ping loop, no tab restore and no model list hammering a closed door.
    if (e && e.status === 401 && e.code === 'token-required' && typeof ccuiTokenGate === 'function') {
      ccuiTokenGate(e.data);
      return;
    }
    toast(t('boot.backendFehler') + e.message, 'err');
  }
  // optional boot work — each isolated, so one failure can't cancel the others
  const step = (fn) => { try { const r = fn(); if (r && r.catch) r.catch(() => { /* reported by the loader itself */ }); } catch { /* */ } };
  // restore THIS window's tabs across a reload, else offer the last session (CHAT-FLOW-4 part B, chat.js tabsBoot;
  // the global cc_draft fallback moved in there: a second window must not show the first one's draft). With Web
  // Locks it is ASYNCHRONOUS — the restore lands a few ms later, after restoreView below may have switched to
  // another view. Not waited for on purpose: restoreView leaves the chat view alone, the restore switches no view,
  // and a tab bar measured while hidden is re-laid out by initTabResize once it is shown; waiting would show the
  // chat view for up to TW_GRACE_MS (a duplicated tab) before landing in the view you were in.
  step(() => tabsBoot());
  step(() => { if (typeof initChatLayout === 'function') initChatLayout(); }); // approvals rail right of the chat
  step(() => { if (typeof initTabWheel === 'function') initTabWheel(); });     // wheel scrolls the tab strip horizontally
  step(() => { if (typeof initTabResize === 'function') initTabResize(); });   // re-place "+" when the strip changes width
  step(() => { if (typeof mountEventBell === 'function') mountEventBell(); }); // 🔔 sits in the header of the active view
  step(() => { if (typeof loadModels === 'function') loadModels(); }); // populate the model dropdown live from /api/models
  step(() => { if (typeof applyEffortCap === 'function') applyEffortCap(); }); // drop effort levels above `maxEffortLevel`
  step(() => { if (typeof loadPrompts === 'function') loadPrompts(); }); // personal prompt library (for the palette)
  step(() => { if (typeof ensureUiSkillsData === 'function') ensureUiSkillsData(); }); // UI skills for the composer slash menu (▶ + form)
  step(() => { if (typeof refreshAppVersion === 'function') refreshAppVersion(); }); // sidebar "Update" pill: HEAD vs origin/main (ToDo 05)
  step(() => { if (typeof refreshCliVersion === 'function') refreshCliVersion(); }); // sidebar "Claude · x.y.z" pill: claude.exe vs npm registry
  step(() => { if (typeof loadPrFooter === 'function') loadPrFooter(); }); // sidebar PR-status pill (ToDo 03)
  // section jump bars mark the section you are reading (B9). Safe at boot: the cards are static markup,
  // and an IntersectionObserver on a display:none view simply reports nothing until it is shown.
  step(() => { if (typeof initSectionNavHighlight === 'function') initSectionNavHighlight(); });
  // A18: the cwd autocomplete is built from SESSIONS, which used to stay empty until the Sitzungen view
  // was visited. Pull the list once, deferred, so it costs nothing at first paint — ensureSessions()
  // then refreshes the datalist itself and the command palette finds its "Fortsetzen" entries.
  setTimeout(() => { if (typeof ensureSessions === 'function') ensureSessions(); }, 1200);
  // …and land back in the view you were in (B5). LAST, so the chat bootstrap above (tabs, layout, rail)
  // has already run against the chat view before we switch away from it.
  step(() => { if (typeof restoreView === 'function') restoreView(); });
  startPingLoop(); // UI↔server liveness indicator (bottom-left dot + Settings)
})();

// --- connection status (UI ↔ server) ---
let CONN = { ok: null, latency: null, lastOk: 0, uptime: null, chats: null };
let PING_TIMER = null;
async function pingServer() {
  const t0 = (performance && performance.now) ? performance.now() : Date.now();
  try {
    const r = await fetch('/api/ping', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const lat = Math.round(((performance && performance.now) ? performance.now() : Date.now()) - t0);
    CONN = { ok: true, latency: lat, lastOk: Date.now(), uptime: d.uptime, chats: d.chats };
  } catch { CONN = Object.assign({}, CONN, { ok: false }); }
  renderConn();
}
// A18: a hidden tab kept polling every 5 s forever (17k requests per day in a background window). Stop
// the timer while hidden and ping ONCE immediately when the tab comes back, so the dot is never stale.
function startPingLoop() { if (PING_TIMER) return; pingServer(); PING_TIMER = setInterval(pingServer, 5000); }
function stopPingLoop() { if (PING_TIMER) { clearInterval(PING_TIMER); PING_TIMER = null; } }
function renderConn() {
  const dot = $('#connDot');
  if (dot) {
    dot.classList.toggle('ok', CONN.ok === true);
    dot.classList.toggle('bad', CONN.ok === false);
    dot.title = CONN.ok === true ? (t('boot.verbundenMitDemServer') + (CONN.latency != null ? ' · ' + CONN.latency + t('boot.ms') : ''))
      : CONN.ok === false ? t('boot.getrenntServerNichtErreichbar') : t('html.verbindungWirdGeprueft');
  }
  if (typeof renderConnDetail === 'function') renderConnDetail(); // Settings "Verbindung" card, if mounted
}

// pause the animated brand-mark (and other looping decor) while the tab is hidden; when it becomes visible
// again (e.g. laptop woke), proactively reconnect any tab whose server chat was reaped during sleep (ToDo 02/06)
document.addEventListener('visibilitychange', () => {
  document.documentElement.classList.toggle('tab-hidden', document.hidden);
  if (document.hidden) { stopPingLoop(); return; } // A18: no 5s poll in a background tab
  startPingLoop();                                  // …and an immediate ping on return, so the dot is current
  if (typeof reconnectIdleTabs === 'function') reconnectIdleTabs();
});
// clear the active tab's unread marker when the window regains focus + reconnect reaped idle tabs (ToDo 02/06)
window.addEventListener('focus', () => { if (ACTIVE && ACTIVE.unread) { ACTIVE.unread = null; updateTitleBadge(); renderTabs(); } if (typeof reconnectIdleTabs === 'function') reconnectIdleTabs(); });
window.addEventListener('online', () => { if (typeof reconnectIdleTabs === 'function') reconnectIdleTabs(); });
// warn before reload/close if a tab is still streaming (don't lose a running task) — except for the
// panel's own reload after a server restart (B4): the restart has ended those turns already, and the
// dialog kept the page on a server that was gone (views-system.js reloadAfterRestart)
// …and since DATA-2 the same warning covers an unsaved memory draft: a reload threw it away just as
// silently as a file switch did, and the draft exists only in that textarea (nothing was ever POSTed).
// `typeof` guard because this file is the last script and must not depend on views-memory.js being there.
// BUILDER-1: …and the UI-skill builder's draft, which since then survives every tab and view switch — and so lives
// long enough to be lost to a reload. The panel's own restart reload is the exception above; its confirmation
// names the open drafts instead (views-system.js restartDraftNote).
window.addEventListener('beforeunload', (e) => {
  if (typeof RELOAD_FOR_RESTART !== 'undefined' && RELOAD_FOR_RESTART) return;
  const draft = (typeof memDirty === 'function' && memDirty()) || (typeof builderDirty === 'function' && builderDirty());
  if (TABS.some((t) => t.streaming) || draft) { e.preventDefault(); e.returnValue = ''; }
});
