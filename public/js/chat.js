// Part of the Claude Code Control Panel front-end (split from app.js).
// Classic scripts share one global scope; load order in index.html is authoritative: render → chat → sessions → views → commands → boot.
// This file: chat.js
//
// i18n: the app's translate helper is the global `t(key)` (render.js), looking the string up in the
// central I18N dictionary (i18n.js, #21). In THIS file `t` is also the per-tab object variable in almost
// every function, which shadows that helper — so we alias it here as `tt` and use tt('area.slug') for
// every user-visible string. LANG is read live inside the helper, so language switching still works.
// (Aliasing avoids a risky file-wide rename of the `t` tabs.)
const tt = t;

// ============================================================
//  CHAT
// ============================================================
// --- multi-tab chat state ---
// `chat` = the tab currently being operated on. For UI actions it equals ACTIVE;
// during an SSE event it is temporarily swapped to that event's tab so background
// tabs render into their own container without touching the visible UI.
let TABS = [], ACTIVE = null, chat = null, STATUS_TIMER = null, TAB_SEQ = 0;
// One-shot repaint at the moment a rate limit resets (A3) — without it the chip would keep claiming a
// limit that has already expired in a tab nobody touches.
let LIMIT_TIMER = null;
// Run `fn` with the module-global render target pointed at `tab` (addMsg/scrollBottom/setComposerBusy all read
// it) and always restore it — replaces the six hand-rolled `const saved = chat; chat = tab; try/finally` copies.
function withTab(tab, fn) { const saved = chat; chat = tab; try { return fn(); } finally { chat = saved; } }
const CLOSED_TABS = []; // stack for "reopen closed tab" (Alt+Shift+T)
const TAB_HUES = [265, 200, 150, 32, 330, 95, 175, 300]; // subtle per-tab accent hue
function modelGlyph(m) {
  m = (m || '').toLowerCase();
  if (/opus/.test(m)) return '🧠';
  if (/sonnet/.test(m)) return '🎯';
  if (/haiku/.test(m)) return '🍃';
  if (/fable|mythos/.test(m)) return '📖';
  return '';
}
function shortModel(m) { return (m || '').replace(/^claude-/, ''); } // "claude-opus-4-8[1m]" -> "opus-4-8[1m]"
// permission-mode display: colour class + human label (plan=safe/green … bypass=danger/red)
function modeInfo(mode) {
  if (mode === 'plan') return { cls: 'm-plan', label: tt('chat.plan') };
  if (mode === 'manual') return { cls: 'm-plan', label: tt('chat.manual') };
  if (mode === 'auto') return { cls: 'm-auto', label: tt('chat.auto') };
  if (mode === 'acceptEdits') return { cls: 'm-accept', label: tt('chat.acceptEdits') };
  if (mode === 'dontAsk') return { cls: 'm-dontask', label: tt('chat.dontAsk') };
  if (mode === 'bypassPermissions') return { cls: 'm-bypass', label: tt('chat.bypass') };
  return { cls: 'm-default', label: tt('chat.default') };
}
function makeTab(opts) {
  opts = opts || {};
  const msgEl = el('div', 'messages hidden');
  msgEl.setAttribute('role', 'log'); msgEl.setAttribute('aria-live', 'polite'); msgEl.setAttribute('aria-relevant', 'additions text');
  $('#chatScroll').appendChild(msgEl);
  // `attachments` + `draft` are PER TAB (C8): both were module globals, so a screenshot attached in tab A was
  // sent from tab B and every tab showed the last-typed draft after a reload.
  // `defaultTitle` is the sentinel that marks the title as still auto-replaceable — it replaces the four
  // hardcoded language literals isDefaultTitle used to compare against.
  // The four context fields ctx.js decides over (ctxDecide):
  //   ctxTokens   = the context the last API call of this tab carried, DERIVED from the `assistant` frames
  //   ctxReported = { win, key } — the window this session's own `result` reported, together with the model
  //                 VARIANT it belongs to (a bare number cannot say, and the two variants of one model have
  //                 different windows)
  //   ctxMeasured = what the CLI itself answered when last asked, plus the gen/stamp it was asked at
  //   ctxStamp    = a monotonic count of everything that moved the context (a frame, /clear, a compaction).
  //                 A measurement is the current number only while this is UNCHANGED — compared with `===`,
  //                 so a counter that gets reset can only discard the measurement, never promote it.
  // `_ctxGen` is the same idea for the model/context IDENTITY: a query still in flight when it moves has its
  // answer dropped instead of stored (it measured a context that no longer exists).
  const t = { uid: ++TAB_SEQ, id: null, es: null, streaming: false, current: null, toolCards: {}, steps: [], agents: [], stick: true, lastSeq: 0, model: null, modelSel: '', permissionMode: '', effort: '', sessionId: null, phase: '', tokenBase: 0, tokenLive: 0, ctxTokens: 0, ctxReported: null, ctxMeasured: null, ctxStamp: 0, turnStart: 0, lastAssistantText: '', queue: [], attachments: [], draft: '', msgEl, tabEl: null, cwd: null, title: opts.title || tt('chat.neuerChat'), defaultTitle: !opts.title, unread: null, manualTitle: false, hue: TAB_HUES[TAB_SEQ % TAB_HUES.length] };
  TABS.push(t);
  if (TABS.length === 7) toast(tt('chat.vieleParalleleTabs') + TABS.length + tt('chat.jederIstEinEigener'), 'err');
  return t;
}
const BASE_TITLE = 'Claude Code · Control Panel';
function updateTitleBadge() {
  const n = TABS.filter((t) => t.unread).length;
  document.title = (n ? '(' + n + ') ' : '') + BASE_TITLE;
}
// …and the counterpart for work that is still RUNNING. updateTitleBadge counts tabs that are FINISHED
// and unread, so the moment you switch to Nutzung or Einstellungen a six-minute turn leaves no trace at
// all — no indication that anything is happening, and no way back to the right tab except reading the
// tab strip. The count sits on the Chat nav item; the tooltip names the tabs and what each is doing.
// Called from renderTabs(), which already runs on every streaming transition (setComposerBusy) and once
// a second while the elapsed ticker is on — so the phase text stays current without its own timer.
function refreshNavBusy() {
  const b = $('#navChatBusy'); if (!b) return;
  const busy = (typeof TABS !== 'undefined' ? TABS : []).filter((t) => t.streaming);
  b.textContent = busy.length ? String(busy.length) : '';
  b.classList.toggle('hidden', !busy.length);
  b.title = busy.length
    ? tt('chat.navLaeuft') + '\n' + busy.map((t) => '· ' + t.title
      + (typeof displayPhase === 'function' ? ' — ' + displayPhase(t) : '')).join('\n')
    : '';
}
// A12 — a turn can run for minutes, and a toast in a window you are not looking at is no signal at
// all. Opt-in (⚙ Anzeige → Benachrichtigungen), and only while the window is unfocused: a
// notification for something you are watching happen is noise. The title also blinks, which survives
// a denied notification permission — that is the part that always works.
let _titleBlink = null;
function chatBlinkTitle(msg) {
  if (_titleBlink) clearInterval(_titleBlink);
  const orig = document.title; let on = true;
  _titleBlink = setInterval(() => { document.title = on ? msg : orig; on = !on; }, 900);
  const stop = () => { if (_titleBlink) { clearInterval(_titleBlink); _titleBlink = null; } updateTitleBadge(); window.removeEventListener('focus', stop); };
  window.addEventListener('focus', stop);
}
function chatNotifyEnabled() { return !!(typeof DISPLAY !== 'undefined' && DISPLAY.notify); }
// Ask for the permission at the moment the user opts in, not at boot — an unexplained browser prompt
// on first load is exactly the pattern people click away.
function chatNotifyAsk() {
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* */ }
}
function chatNotify(title, body) {
  if (!chatNotifyEnabled() || document.hasFocus()) return;
  chatBlinkTitle('🔔 ' + title);
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const n = new Notification(title, { body: body || '', tag: 'ccui-chat' });
    n.onclick = () => { window.focus(); try { n.close(); } catch { /* */ } };
  } catch { /* notifications blocked / unsupported — the title blink already fired */ }
}
// a background tab finished — flag it unread + notify (unless it's the active tab)
function markTabDone(t, status) {
  if (t === ACTIVE && document.hasFocus()) return;
  t.unread = status;
  toast((status === 'error' ? '✕ ' : '✓ ') + tt('chat.tab') + t.title + (status === 'error' ? tt('chat.mitFehler') : tt('chat.fertig')), status === 'error' ? 'err' : 'ok');
  chatNotify((status === 'error' ? '✕ ' : '✓ ') + t.title, status === 'error' ? tt('chat.notifyFehler') : tt('chat.notifyFertig'));
  updateTitleBadge(); renderTabs();
}
let DRAG_TAB = null;
function fmtElapsed(ms) { const s = Math.floor(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h' + (m % 60) + 'm'; }
// What a tab's queue is waiting for, in words — the ⏸ badge on the tab (renderTabs) and the queue strip
// (chat-composer.js renderQueueStateBtns) say the same, so a new reason cannot be named in one and not the other.
// 'elsewhere' (CHAT-FLOW-4, supersedeTab): another tab or window took the session; [Jetzt senden] asks first.
function queueWaitText(t) {
  if (!t || !t.queuePaused) return tt('chat-composer.warteschlange');
  if (t.queuePaused === 'resume') return tt('chat-composer.angehaltenFortgesetzt');
  if (t.queuePaused === 'elsewhere') return tt('chat-composer.angehaltenAnderswo');
  return tt('chat-composer.angehaltenGefragt');
}
function renderTabs() {
  const bar = $('#chatTabs'); if (!bar) return; bar.innerHTML = '';
  TABS.forEach((t) => {
    const item = el('div', 'chat-tab' + (t === ACTIVE ? ' active' : '') + (t.streaming ? ' busy' : '') + (t.unread ? ' unread ' + t.unread : ''));
    item.draggable = true;
    item.style.setProperty('--tab-hue', t.hue);
    if (t.streaming) item.appendChild(el('span', 'ct-spin'));
    // …and while it RESUMES (07.10.): a tab coming back after a reload or restart said nothing in the tab bar, so a
    // long resume read as a tab that hangs
    else if (t._resuming) { const sp = el('span', 'ct-spin resuming'); sp.title = tt('chat.wirdFortgesetzt'); item.appendChild(sp); }
    else if (t.unread) {
      // colour alone said "fertig" vs "mit Fehler" — identical with a red-green deficiency, and it
      // never said WHAT happened. Glyph + title carry the meaning now (B10).
      const d = el('span', 'ct-dot ' + t.unread, t.unread === 'error' ? '✕' : '✓');
      d.title = t.unread === 'error' ? tt('chat.tabFertigFehler') : tt('chat.tabFertigOk');
      item.appendChild(d);
    }
    else { const g = modelGlyph(t.model); if (g) { const gs = el('span', 'ct-glyph', g); gs.title = (t.model || '') + (t.permissionMode ? ' · ' + t.permissionMode : ''); item.appendChild(gs); } }
    const title = el('span', 'ct-title', t.title);
    // the cwd left the status line — hovering the tab is the cheapest place to keep it readable
    title.title = '📁 ' + (tabCwd(t) || '—') + '\n' + tt('chat.doppelklickZumUmbenennenRechtsklick');
    title.ondblclick = (e) => { e.stopPropagation(); startTabRename(t, title); };
    item.appendChild(title);
    if (t.streaming) { const em = el('span', 'ct-elapsed'); em.textContent = fmtElapsed(Date.now() - (t.turnStart || Date.now())); item.appendChild(em); }
    // queued messages are no longer in the transcript (C2) → surface the count on the tab, where a background
    // tab's pending type-ahead is otherwise invisible
    if (t.queue && t.queue.length) { const qb = el('span', 'ct-queue', (t.queuePaused ? '⏸' : '⏳') + t.queue.length); qb.title = queueWaitText(t); item.appendChild(qb); }
    if (TABS.length > 1) { item.appendChild(iconBtn('ct-close', 'close', { size: 12, title: tt('html.tabSchliessen'), onClick: (e) => { e.stopPropagation(); closeTab(t); } })); }
    item.tabIndex = 0; item.setAttribute('role', 'tab'); item.setAttribute('aria-selected', String(t === ACTIVE));
    item.onclick = () => activateTab(t);
    item.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateTab(t); } };
    item.onauxclick = (e) => { if (e.button === 1 && TABS.length > 1) { e.preventDefault(); closeTab(t); } }; // middle-click closes
    item.oncontextmenu = (e) => { e.preventDefault(); openTabMenu(t, e.clientX, e.clientY); };
    // drag to reorder
    item.addEventListener('dragstart', () => { DRAG_TAB = t; item.classList.add('dragging'); });
    item.addEventListener('dragend', () => { DRAG_TAB = null; item.classList.remove('dragging'); });
    item.addEventListener('dragover', (e) => { e.preventDefault(); });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!DRAG_TAB || DRAG_TAB === t) return;
      const from = TABS.indexOf(DRAG_TAB), to = TABS.indexOf(t);
      TABS.splice(from, 1); TABS.splice(to, 0, DRAG_TAB);
      renderTabs(); persistTabs();
    });
    t.tabEl = item; bar.appendChild(item);
  });
  layoutTabExtras();
  bar.classList.toggle('single', TABS.length <= 1);
  refreshNavBusy(); // the "something is running" signal for every view that is not the chat
  scrollActiveTabIntoView();
  ensureTabTicker(); // start/stop the 1 s elapsed ticker with the streaming state
  // The bar is rebuilt via innerHTML, so a focused tab item is destroyed mid-keyboard-navigation and focus
  // falls back to <body> — Alt+←/→ then stopped working until the user clicked something (C14).
  if (_tabFocusWanted && ACTIVE && ACTIVE.tabEl) { try { ACTIVE.tabEl.focus({ preventScroll: true }); } catch { /* */ } }
  _tabFocusWanted = false;
}
// "+" belongs directly behind the last tab — that is where the hand goes for it. It only leaves that
// spot when the strip actually runs out of room: then it would scroll out of reach exactly when many
// tabs make it necessary, so it hops into the pinned rail next to the overflow picker.
// The decision is measured, not guessed at a tab count, and it always starts from the same state
// (rail emptied, "+" removed) so it cannot oscillate between two renders.
function layoutTabExtras() {
  const bar = $('#chatTabs'), fix = $('#chatTabsFix');
  if (!bar || !fix) return;
  const stale = bar.querySelector('.chat-tab-add'); if (stale) stale.remove();
  fix.innerHTML = '';
  const add = el('button', 'chat-tab-add', '+');
  add.type = 'button';
  add.title = tt('chat.neuerTabAltT');
  add.setAttribute('aria-label', tt('chat.neuerTabAltT'));
  add.onclick = () => newTab();
  const overflows = () => bar.scrollWidth > bar.clientWidth + 1;
  if (overflows()) fix.appendChild(add);           // the tabs alone already don't fit
  else {
    bar.appendChild(add);
    if (overflows()) { add.remove(); fix.appendChild(add); } // it was "+" that broke the camel's back
  }
  const pinned = add.parentElement === fix;
  bar.classList.toggle('scrolls', pinned); // right-edge fade only while there really is more to see
  // the picker is the way out of a scrolled strip — show it as soon as scrolling starts, and keep the
  // old "more than five tabs" rule for wide screens where everything still fits
  if (pinned || TABS.length > 5) {
    const ov = iconBtn('chat-tab-add', 'chevronDown', { size: 16, title: tt('chat.alleTabs'), onClick: (e) => { e.stopPropagation(); openTabPicker(ov); } });
    fix.appendChild(ov);
  }
}
// The same measurement has to run when the strip changes width without the tabs changing — window
// resize, sidebar collapse. Width-guarded so the observer can't feed itself.
let _tabBarW = -1;
function initTabResize() {
  const wrap = document.querySelector('.chat-tabbar');
  if (!wrap || typeof ResizeObserver !== 'function') return;
  new ResizeObserver(() => {
    const w = wrap.clientWidth;
    if (w === _tabBarW) return;
    _tabBarW = w;
    layoutTabExtras();
  }).observe(wrap);
}
// set right before a rebuild that should keep keyboard focus on the active tab
let _tabFocusWanted = false;
// The active tab has to be VISIBLE, which is separate from focus: renderTabs uses
// focus({preventScroll:true}) on purpose (a focus-driven scroll would yank the transcript), so the
// horizontal scroll of the tab strip has to be done explicitly.
function scrollActiveTabIntoView() {
  const bar = $('#chatTabs'); if (!bar || !ACTIVE || !ACTIVE.tabEl) return;
  const t = ACTIVE.tabEl;
  const left = t.offsetLeft, right = left + t.offsetWidth;
  if (left < bar.scrollLeft) bar.scrollLeft = left - 8;
  else if (right > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = right - bar.clientWidth + 8;
}
// A vertical wheel over the strip scrolls it horizontally — without this the strip is unreachable on a
// mouse without a tilt wheel, since the only other handle is the 10px scrollbar.
function initTabWheel() {
  const bar = $('#chatTabs'); if (!bar) return;
  bar.addEventListener('wheel', (e) => {
    if (e.deltaY === 0 || e.shiftKey) return;              // let the OS handle explicit horizontal intent
    if (bar.scrollWidth <= bar.clientWidth) return;         // nothing to scroll → don't swallow the event
    e.preventDefault();
    bar.scrollLeft += e.deltaY;
  }, { passive: false });
}
function keepTabFocus() { const a = document.activeElement; _tabFocusWanted = !!(a && a.classList && a.classList.contains('chat-tab')); }
// tab elapsed ticker (1s) — only updates text on busy tabs, no full re-render. Self-stopping (like the agent
// ticker in chat-render.js): it used to run forever, waking the page every second in a completely idle panel (P6).
let TAB_TICKER = null;
function tickTabElapsed() {
  let any = false;
  TABS.forEach((t) => {
    if (!t.streaming) return;
    any = true;
    if (t.tabEl) { const em = t.tabEl.querySelector('.ct-elapsed'); if (em) em.textContent = fmtElapsed(Date.now() - (t.turnStart || Date.now())); }
  });
  if (!any) { clearInterval(TAB_TICKER); TAB_TICKER = null; }
}
function ensureTabTicker() {
  const any = TABS.some((t) => t.streaming);
  if (any && !TAB_TICKER) TAB_TICKER = setInterval(tickTabElapsed, 1000);
  else if (!any && TAB_TICKER) { clearInterval(TAB_TICKER); TAB_TICKER = null; }
}

// right-click context menu
function closeTabMenu() { const m = $('#tabMenu'); if (m) m.remove(); }
function openTabMenu(t, x, y) {
  closeTabMenu();
  const m = el('div', 'ctx-menu'); m.id = 'tabMenu';
  // label goes in as TEXT, not innerHTML — the cwd entry below carries a user-supplied path
  const add = (icon, label, fn, disabled, opts) => {
    opts = opts || {};
    const b = el('div', 'ctx-item' + (disabled ? ' disabled' : '') + (opts.cls ? ' ' + opts.cls : ''));
    b.innerHTML = ic(icon, 14);
    b.appendChild(el('span', null, label));
    if (opts.title) b.title = opts.title;
    if (!disabled) { b.onclick = () => { closeTabMenu(); fn(); }; mkClickable(b, label); }
    m.appendChild(b);
  };
  const sep = () => m.appendChild(el('div', 'ctx-sep'));
  // J4 — the project first: it decides the instructions and is the one label that outlives the tab (sessions.js)
  if (typeof openTabProjectPicker === 'function') {
    add('project', t.projectId ? tt('projects.tabMenuProjekt').replace('{name}', sessProjName(t.projectId)) : tt('projects.tabMenuOhne'),
      () => openTabProjectPicker(t), false, { title: tt('projects.tabMenuTooltip') });
  }
  // Working directory. It used to sit in the status line, where it cost up to 198px of a row that was
  // already cutting off the token count. It decides which CLAUDE.md applies, what /diff compares and
  // what @-completion sees — so it stays reachable and editable, just not permanently on screen. It is
  // also on the tab's own tooltip now, so you can read it without opening anything.
  const cwd = tabCwd(t);
  add('folder', shortCwd(cwd), () => { activateTab(t); openCwdEditor(); }, !!t.id,
    { cls: 'ctx-path', title: (cwd || '—') + '\n' + tt(t.id ? 'chat-status.cwdFestSeitStart' : 'chat-status.klickenZumAendern') });
  // A15 — a second readable root, e.g. the repo AND an ABAP export, instead of copying between them.
  // Launch flag like the cwd, so it is editable before the start only.
  const dirs = (t.addDirs || []);
  add('folders', dirs.length ? tt('chat.weitereVerzeichnisseN').replace('{n}', dirs.length) : tt('chat.weitereVerzeichnisse'),
    () => editTabAddDirs(t), !!t.id, { title: (dirs.join('\n') || tt('chat.keineWeiterenVerzeichnisse')) + '\n' + tt(t.id ? 'chat-status.cwdFestSeitStart' : 'chat-status.klickenZumAendern') });
  // A3 — a dollar ceiling for this tab's session. The CLI ends the session when it is reached, and the
  // error card (B2) makes that visible; useful for a long unattended-ish run in a tab, not just for schedules.
  add('coin', t.maxBudgetUsd ? tt('chat.budgetN').replace('{n}', String(t.maxBudgetUsd)) : tt('chat.budgetOhne'),
    () => editTabBudget(t), !!t.id, { title: tt('chat.budgetTooltip') });
  // D1 — the standing constraints for this chat. Unlike the cwd this stays editable while the session
  // runs: it is the thing you most often realise you should have said. Applying it needs a relaunch of
  // the same session, which restartResume does without losing the transcript.
  add('lock', t.guardrails ? tt('chat.leitplankenN').replace('{n}', guardrailCount(t.guardrails)) : tt('chat.leitplankenKeine'),
    () => editTabGuardrails(t), false, { title: (t.guardrails || tt('chat.leitplankenTooltip')) });
  // #34 — which model this chat's subagents use, how many may run, and whether they may spawn at all.
  // Editable while the session runs (like the guardrails): it applies on the next launch, and the
  // dialog offers that relaunch.
  add('bot', '🤖 ' + subagentLabel(t), () => editTabSubagents(t), false, { title: tt('chat.subagentsTooltip') });
  // Ultracode — the one agent-related switch that IS live (apply_flag_settings), so unlike the agent and
  // worktree entries below it never disables. NO icon argument: the 🌀 in the label is the icon, and the
  // `bolt` SVG next to it was a second one for the same entry — two glyphs claiming to stand for one thing,
  // and the bolt is what the strip uses for EFFORT (⚡), which is the switch this one must not be mistaken for.
  add(null, '🌀 ' + ultracodeLabel(t), () => editTabUltracode(t), false, { title: tt('chat.ultracodeTooltip') });
  // C2/C3 — both are LAUNCH flags (the CLI has no live switch), so they disable once the session runs,
  // exactly like the cwd two entries above.
  add('bot', '🧠 ' + (t.agent ? tt('chat.agentN').replace('{n}', t.agent) : tt('chat.agentKeiner')),
    () => editTabAgent(t), !!t.id, { title: tt('chat.agentTooltip') });
  add('folder', '🌿 ' + (t.worktree ? (t.worktree === true ? tt('chat.worktreeAnOhneName') : tt('chat.worktreeN').replace('{n}', t.worktree)) : tt('chat.worktreeAus')),
    () => editTabWorktree(t), !!t.id, { title: tt('chat.worktreeTooltip') });
  sep();
  add('stop', stopArmed(t) ? tt('chat.stoppenHart') : tt('chat.stoppen'), () => stopTab(t), !tabCanStop(t)); // a held gate is stoppable work too; 2nd = hard (stopTab)
  // The two context commands, one click instead of typing them. Same path as the composer
  // (sendMessage → markCtxOp → ctx-gauge drain), so the transcript and the gauge behave identically.
  // Disabled only without a session (nothing to act on). They used to be disabled while a turn ran too,
  // because sendMessage would *silently* queue them and a /clear firing minutes later is a footgun —
  // but the queueing is not silent any more: it shows as a marked, cancellable chip in the queue strip
  // and in the tab's ⏳ badge, and /clear still asks before it goes in.
  const ctxBusy = !(t.id || t.sessionId);
  add('wrap', tt('chat.kontextKompaktieren'), () => sendMessage({ text: '/compact', tab: t }), ctxBusy);
  // /clear discards the whole context irreversibly. Typing it is deliberate; a menu click is one slip,
  // so it asks first — same rule closeTab already follows for a running tab.
  add('trash', tt('chat.kontextLeeren'), async () => {
    if (await uiConfirm(tt('chat.clearFrage'), { title: tt('chat.kontextLeeren'), danger: true, okLabel: tt('chat.leeren') })) sendMessage({ text: '/clear', tab: t });
  }, ctxBusy);
  sep();
  add('edit', tt('chat.umbenennen'), () => { activateTab(t); const el2 = t.tabEl && t.tabEl.querySelector('.ct-title'); if (el2) startTabRename(t, el2); });
  add('palette', tt('chat.farbeAendern'), () => pickTabColor(t));
  add('plug', tt('chat.mcpServer'), () => pickTabMcp(t));
  add('fork', tt('chat.duplizierenFork'), () => forkTab(t), !t.sessionId);
  sep();
  // export was only reachable from the chat-options popover and always exported the ACTIVE tab (C12)
  add('download', tt('chat.exportMarkdown'), () => exportChat('md', t), !t.sessionId && !t.msgEl.childElementCount);
  add('download', tt('chat.exportJson'), () => exportChat('json', t), !t.sessionId && !t.msgEl.childElementCount);
  sep();
  add('close', tt('chat.andereSchliessen'), () => closeOtherTabs(t), TABS.length <= 1);
  add('close', tt('common.schliessen'), () => closeTab(t), TABS.length <= 1);
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  // clamp on BOTH ends — with the menu now ~455px tall, the upper clamp alone produced a negative top
  // on a short window and pushed the first entries off the screen
  m.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
}
// interrupt ends the turn → the held gates AND their pulsing jump markers are dead; the tool-card map too (C1/P6).
// CHAT-FLOW-9 — `keepQueue` is Strg+Enter „Jetzt senden": it queues its message and then interrupts, and the
// interrupt used to clear the very queue that message had just been put in. The interrupt's own `result`
// flushes it now; `_flushNoPause` keeps a question in the cut-off answer from holding it back (CHAT-FLOW-7).
// CHAT-FLOW-10 — an open plan card is retired BEFORE the gates go: afterwards nothing says which card it was,
// and it stayed clickable, reporting „angenommen" to a turn that no longer existed.
async function interruptTab(t, opts) {
  if (!t.id) return;
  const cliTurn = !!(t._cliTurn && t.streaming); // read before the await: its `result` may land during it
  t.queuePaused = false;
  // the interrupt ENDS the turn — startChat says the same of a restart. Without it a turn that frames opened
  // minutes ago still counts as live work (tabHasLiveWork reads _turnOpen for up to LANE_STALE_MS), so the
  // deferred restart at the bottom would keep waiting on a turn the user has just stopped. A `result` that
  // still arrives sets it false again anyway.
  t._turnOpen = false;
  if (typeof retirePlanCards === 'function') retirePlanCards(t);
  // …and only THEN empty the queue: dropping a gate can put entries back (a stashed plan decision whose POST
  // never happened hands them back to [Mit Antwort senden], chat-render.js), and restoring them after the
  // „verworfen" toast would leave the next turn silently sending something the interrupt said was gone.
  clearAsksForTab(t); clearAskWaitersForTab(t); pruneToolCards(t, true); trimTranscript(t);
  if (opts && opts.keepQueue) t._flushNoPause = true; else clearQueue(t, tt('chat.abgebrochen'));
  if (t === ACTIVE && typeof renderQueueStrip === 'function') renderQueueStrip();
  agentsAborted(t); // the turn's sub-agents die with it (#32) — and an interrupt emits no _exit
  try {
    await api('/api/chat/' + t.id + '/interrupt', { method: 'POST' }); toast(tt('chat.interruptAn') + t.title + '"' + (opts && opts.stopHint ? tt('chat.stoppHartHinweis') : ''));
    if (cliTurn) armCliTurnStop(t);
  } catch (e) { toast(e.message, 'err'); }
  // Stop is the way out of a held gate (tabCanStop/tabHasLiveWork), and THAT is what this line is for: with
  // the gate dropped above and `streaming` false (a turn the CLI started by itself, FLOW-3) no `result` is
  // coming that could apply a deferred restart. The queue path does not cover it either — clearQueue only
  // reaches queueChanged → maybeApplyPendingRunCfg when there WAS something queued. While the tab really is
  // streaming this is a no-op and the interrupt's own `result` does the work; with keepQueue (Strg+Enter) the
  // queue is deliberately non-empty, which pendingRunCfgReady rejects — the flush's `result` does it then.
  maybeApplyPendingRunCfg(t);
}
// CHAT-FLOW-3 — the way out of an ADOPTED turn (chat-events.js, turnOpenedByCli) that never ends. A turn the panel
// sent is closed by its `result` as good as always; one the CLI opened by itself is not known to be — and whether an
// interrupt sent into it yields a `result` is unmeasured. Without this, `streaming` would stay true for good: every
// message queued, [Jetzt senden] stopping nothing, Stop sending interrupts into the void. So: no `result` within
// CLI_TURN_STOP_MS after the interrupt → end the turn locally, say exactly that (not that the CLI stopped), and send
// what Strg+Enter / [Jetzt senden] queued for after the stop — that is what it was pressed for. Armed only after a
// POST that went through: a failed one has toasted, and the CLI may well be working on.
const CLI_TURN_STOP_MS = 10000;
function armCliTurnStop(t) {
  clearTimeout(t._cliStopTimer);
  t._cliStopTimer = setTimeout(() => {
    t._cliStopTimer = null;
    if (!t._cliTurn || !t.streaming) return; // its `result` came (setComposerBusy(false) cleared the mark)
    withTab(t, () => { setComposerBusy(false); addMsg('system', tt('chat.folgeturnStoppOhneEnde').replace('{s}', String(CLI_TURN_STOP_MS / 1000))); });
    if (t._flushNoPause && (t.queue || []).length) { t._flushNoPause = false; flushQueue(t); }
    else maybeApplyPendingRunCfg(t);
  }, CLI_TURN_STOP_MS);
}
// The fork carries the conversation over, so it carries the plan's progress over too (PF-1) — a COPY: the two
// tabs go on independently from here, and one ticking off a step must not tick it off in the other. startChat
// keeps it because a fork passes `resume`. Through planAdopt, the resume rule: the fork is a NEW process, so a
// proposal still waiting for its approval comes over ORPHANED (PF-1b) — the gate stayed with the tab that asked,
// and as „wartet auf Freigabe" it opened the fork's rail with no card that could approve it (the fork never paints
// the transcript, so no resume would correct it either). As an orphan it says „Plan liegt vor" and ▶ Plan starten
// begins it by an ordinary message — in the fork, independently of the tab that asked.
// P-0 — and it carries the tab's LAUNCH values over (forkCopyLaunch), because a fork is the same work
// continued. It used to open a plain newTab(): activateTab put the GLOBAL defaults into the selectors (an
// unstarted tab without cfgTouched gets applyChatDefaults) and startChat read them from there, so a fork of
// an Opus/acceptEdits tab with a repo as second root started on the default model, in plan mode, without
// the repo — and without its MCP scope, guardrails or agent. The values go onto the tab BEFORE activateTab,
// with cfgTouched, so the selectors show (and the start reads) the tab's own values.
async function forkTab(t) {
  if (!t.sessionId) return;
  const nt = makeTab(); nt.title = t.title + ' (Fork)';
  forkCopyLaunch(t, nt);
  if (t.plan && typeof planAdopt === 'function') { nt.plan = planAdopt(null, planSave(t.plan)); if (nt.plan && t.plan.text) nt.plan.text = t.plan.text; }
  // …and the two slots beside it (PF-1b): the orphan under a plan underway — its ▶ in the fork, a copy as well — and
  // the newest proposal's name. startChat keeps both on a resume; the fork paints no transcript that could bring them.
  if (t._planOrphan && typeof planAdoptOrphan === 'function') nt._planOrphan = planAdoptOrphan(null, planSave(t._planOrphan));
  if (t._planLast && typeof planLastRestore === 'function') nt._planLast = planLastRestore(t._planLast);
  activateTab(nt); $('#composerInput').focus();
  try { await startChat({ resume: t.sessionId, cwd: t.cwd, fork: true }, nt); toast(tt('chat.forkInNeuemTab'), 'ok'); } catch (e) { toast(e.message, 'err'); }
}
// What a fork takes over from its source: every value the start body reads off the tab (chat-events.js
// startChat), as COPIES — the two tabs are configured independently from here, so an array or object shared
// by reference would let an edit in one silently change the other's next start. The MCP scope comes along
// only when the tab chose one: without it the server inherits the source's STORED scope and keeps it under
// the fork's new id (server.js, P-0). Deliberately NOT carried: the worktree. The source's cwd already IS that
// worktree (chat-events.js adopts init's cwd), and `--worktree` again would ask the CLI for a second one in it.
// The mode comes along AS IT IS, bypassPermissions included — a decision, not an oversight: a fork is the user's
// own click on a tab that visibly runs in that mode, to continue that very work, and the fork's selector shows
// the mode the moment the tab opens. A reload is different (tabRestoreLaunch): nobody decided anything there.
function forkCopyLaunch(src, dst) {
  dst.cwd = src.cwd || null;
  dst.modelSel = src.modelSel || ''; dst.effort = src.effort || ''; dst.permissionMode = src.permissionMode || '';
  if (src.addDirs && src.addDirs.length) dst.addDirs = src.addDirs.slice();
  if (src.agent) dst.agent = src.agent;
  if (src.maxBudgetUsd) dst.maxBudgetUsd = src.maxBudgetUsd;
  if (src.guardrails) dst.guardrails = src.guardrails;
  if (src.subagents && typeof src.subagents === 'object') dst.subagents = Object.assign({}, src.subagents);
  if (src.ultracode === true || src.ultracode === false) dst.ultracode = src.ultracode;   // three-state: undefined stays „global"
  if (src.mcpServers !== undefined) dst.mcpServers = Array.isArray(src.mcpServers) ? src.mcpServers.slice() : null;
  // …and when it did not, the fork remembers WHOSE stored scope it inherited, for the MCP picker (pickTabMcp).
  // The picker reads the stored scope by the tab's session id, and the fork has none yet: the real CLI says
  // nothing at spawn (CTX-4, chat-events.js) — its id arrives with the first message. Until then the picker
  // found nothing to read and showed EVERY server ticked while the process ran the source's scope, and an
  // „Übernehmen" in that state turned the fork's scope into an explicit „all". Not a launch value: the start
  // body never reads it, and the server inherits the same stored scope by itself.
  else if (src.sessionId) dst._mcpFrom = src.sessionId;
  dst.hue = src.hue; dst.hueManual = !!src.hueManual;
  dst.cfgTouched = true;
  return dst;
}
async function closeOtherTabs(keep) { for (const t of TABS.slice()) { if (t !== keep) await closeTab(t); } }
// overflow: quick picker listing all tabs
function openTabPicker(anchor) {
  closeTabMenu();
  const m = el('div', 'ctx-menu'); m.id = 'tabMenu';
  TABS.forEach((t) => { const b = el('div', 'ctx-item' + (t === ACTIVE ? ' cur' : ''), (t.streaming ? '◐ ' : t.unread ? '● ' : '') + t.title); b.onclick = () => { closeTabMenu(); activateTab(t); }; mkClickable(b, t.title); m.appendChild(b); });
  document.body.appendChild(m);
  const a = anchor.getBoundingClientRect(), r = m.getBoundingClientRect();
  m.style.left = Math.min(a.left, window.innerWidth - r.width - 8) + 'px';
  m.style.top = (a.bottom + 4) + 'px';
}
document.addEventListener('click', closeTabMenu);
// place a floating menu under an anchor (or a fallback point), clamped to the viewport
function positionMenuAt(m, anchor) {
  const r = m.getBoundingClientRect();
  let x = 220, y = 120;
  if (anchor) { const a = anchor.getBoundingClientRect(); x = a.left; y = a.bottom + 4; }
  m.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}
// close a popover on the next outside mousedown (deferred so the opening click doesn't instantly close it)
function autoCloseOnOutside(m) {
  const h = (e) => { if (!m.isConnected) { document.removeEventListener('mousedown', h); return; } if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', h); } };
  setTimeout(() => document.addEventListener('mousedown', h), 0);
}
// per-tab accent colour picker (swatch row of TAB_HUES + reset-to-auto)
function pickTabColor(t) {
  closeTabMenu();
  const old = $('#tabColorMenu'); if (old) old.remove();
  const m = el('div', 'ctx-menu tab-pop'); m.id = 'tabColorMenu';
  m.appendChild(el('div', 'ctx-head', tt('chat.tabFarbe')));
  const sw = el('div', 'swatch-row');
  TAB_HUES.forEach((h) => {
    const b = el('button', 'swatch' + (t.hueManual && t.hue === h ? ' sel' : ''));
    b.style.background = 'hsl(' + h + ' 65% 55%)'; b.title = tt('chat.farbton') + h;
    b.onclick = (e) => { e.stopPropagation(); t.hue = h; t.hueManual = true; renderTabs(); persistTabs(); m.remove(); };
    sw.appendChild(b);
  });
  m.appendChild(sw);
  const reset = el('div', 'ctx-item'); reset.innerHTML = ic('reload', 13) + ' <span>' + tt('chat.automatisch') + '</span>';
  reset.onclick = (e) => { e.stopPropagation(); t.hue = TAB_HUES[t.uid % TAB_HUES.length]; t.hueManual = false; renderTabs(); persistTabs(); m.remove(); };
  mkClickable(reset, tt('chat.automatisch')); m.appendChild(reset);
  document.body.appendChild(m); positionMenuAt(m, t.tabEl); autoCloseOnOutside(m);
}
// ---- MCP live, per tab (G4) --------------------------------------------------------------------------
// What the RUNNING session says about its own MCP servers. Free on the CLI side (a synchronous handler, no
// model turn), so the picker may ask every time it opens instead of showing the state of the MACHINE
// (`claude mcp list` in a foreign process, lib/mcp.js) as if it were the state of this tab.
// → the normalised rows, or null for „there is nothing to read / nobody answered". null is NOT an empty
//   list: an empty list would render as „diese Sitzung hat keine MCP-Server", which is a claim.
async function mcpLiveRead(t) {
  if (!t || !t.id) return null;                       // no process → no live state, and the menu says so
  try {
    const r = await api('/api/chat/' + t.id + '/mcp-status');
    if (!r || r.unconfirmed) return null;
    return mcpStatusRows(r);
  } catch (e) {
    // 409 = the process is gone (a tab whose session ended); anything else is worth a line in the log, but
    // never a fabricated state — the menu falls back to „nur die Startauswahl", which is the truth.
    if (e && e.status && e.status !== 409 && e.status !== 404) logEvent(tt('chat.mcpLiveStatusUnlesbar') + (e.message || ''), 'warn');
    return null;
  }
}
// The verdict of a live switch, built from the READ-BACK the route sends along — never from „the request
// came back ok". Three measured reasons, and all three are the same reason the ultracode chip has five
// states: `mcp_toggle` answers `success` with an EMPTY payload, this CLI has no MCP push frame at all
// (`mcp_servers_changed` does not exist), and `controlRequest` resolves „ok" on its own timeout.
// → { verdict, rows } — `rows` is the fresh read-back so the caller can repaint every row, not just this one.
async function applyMcpLive(t, name, on) {
  const url = '/api/chat/' + t.id + (on === null ? '/mcp-reconnect' : '/mcp-toggle');
  const body = (on === null) ? { server: name } : { server: name, enabled: !!on };
  const r = await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const rows = Array.isArray(r.mcpServers) && r.mcpServers.length ? mcpStatusRows(r) : null;
  const sent = { ok: !!r.ok, unconfirmed: !!r.unconfirmed, error: r.error || '' };
  const row = rows ? mcpRow(rows, name) : null;
  const verdict = (on === null) ? mcpReconnectVerdict({ sent: sent, row: row }) : mcpToggleVerdict({ wish: !!on, sent: sent, row: row });
  mcpLiveToast(name, on, verdict);
  return { verdict: verdict, rows: rows };
}
// One toast per outcome, and only 'on'/'off' may be green. Everything else is 'err' — which in this panel
// also means STICKY (render.js toast): „der Schalter hat nicht gegriffen" is exactly the message you must
// not be able to miss by looking away for five seconds.
function mcpLiveToast(name, on, v) {
  if (v.state === 'refused') { toast(name + ': ' + v.error, 'err'); return; }
  if (v.state === 'unknown') { toast(name + ' — ' + tt('chat.mcpLiveUnbestaetigt'), 'err'); return; }
  if (v.state === 'ineffective') { toast(name + ' — ' + tt('chat.mcpLiveUnwirksam') + ' (' + tt(mcpStatusLook(v.status).key) + ')' + (v.error ? ': ' + v.error : ''), 'err'); return; }
  if (on === null) { toast(name + ' — ' + tt('chat.mcpReconnectBestaetigt'), 'ok'); return; }
  toast(name + ' — ' + tt(v.state === 'on' ? 'chat.mcpLiveBestaetigtAn' : 'chat.mcpLiveBestaetigtAus'), 'ok');
}
// The live half of one row: the status dot, the state word, the on/off switch, „neu verbinden" where it can
// actually work — and, when THIS menu just switched something, the verdict of that switch.
// That verdict (`state.marks[name]`) is rendered as a chip and not as a toast only, because the toast is
// gone in four seconds while the row stays on screen; a row that quietly shows a plain status word after an
// unanswered switch is the optimistic reading this whole feature is built to avoid.
//
// EVERYTHING this row shows comes out of `state`, never out of the button element — see pickTabMcp for the
// three fields. The reason is `draw()`: it empties the list and rebuilds every row, so a „schaltet…" that
// lived in `btn.textContent` was wiped the moment ANOTHER row's answer arrived, and the server whose switch
// was still in flight (up to 75 s for a reconnect) got a fresh, enabled button back. The mirror image was
// worse: the old catch reset `disabled` but not the label, leaving a CLICKABLE button reading „schaltet…"
// over a switch that had already failed.
function mcpLiveControls(rowEl, t, row, state, redraw) {
  const mark = state.marks[row.name];
  const busy = !!state.busy[row.name];
  const look = mcpStatusLook(row.status);
  const dot = el('span', 'mcp-dot ' + look.cls, look.dot);
  // Everything the read-back carried, in the tooltip rather than in the 320 px row: the raw status word of a
  // CLI that knows a sixth state, the server's own error, its version and how many tools it brought.
  dot.title = [(row.statusRaw ? row.statusRaw + ' — ' : '') + tt(look.key), row.error || '',
    row.version ? 'v' + row.version : '', (row.tools != null ? row.tools + ' Tools' : ''),
    row.scope ? 'scope: ' + row.scope : '', row.url || ''].filter(Boolean).join('\n');
  rowEl.appendChild(dot);
  rowEl.appendChild(el('span', 'mcp-state ' + look.cls, tt(look.key)));
  const run = async (wish) => {
    state.busy[row.name] = true;
    // The previous verdict stops describing this row the moment a new switch is in flight: a red
    // „abgelehnt" chip next to a button reading „schaltet…" reads as if the running attempt had already
    // been refused.
    state.marks[row.name] = null;
    redraw();
    try {
      const res = await applyMcpLive(t, row.name, wish);
      state.marks[row.name] = res.verdict;
      if (res.rows) state.rows = res.rows;              // one answer repaints every row, not only this one
    } catch (err) {
      // The toast is sticky, but the ROW has to stop claiming „schaltet…" too — and only a repaint out of
      // the model can do that. 'refused' is the honest word: somebody answered, and the answer was no.
      toast(err.message, 'err');
      state.marks[row.name] = { state: 'refused', error: err.message };
    }
    state.busy[row.name] = false;
    redraw();
  };
  // A status the panel does not understand yields `null` — then NO switch is offered at all, because the
  // only way to pick a direction would be to guess which state the server is in (mcp-live.js mcpToggleWish).
  const wish = mcpToggleWish(row);
  if (wish !== null) {
    const b = el('button', 'mini-btn mcp-mini', busy ? tt('chat.mcpLiveLaeuft') : tt(wish ? 'chat.mcpLiveAn' : 'chat.mcpLiveAus'));
    b.title = tt(wish ? 'chat.mcpLiveAnTooltip' : 'chat.mcpLiveAusTooltip');
    b.disabled = busy;
    // stopPropagation AND preventDefault: the menu closes on an outside mousedown, and the row's sibling
    // <label> would otherwise still see this as a label click (see pickTabMcp). The promise is RETURNED so
    // a caller can await the switch — a click handler that swallows it is only testable through timers.
    b.onclick = (e) => { e.stopPropagation(); e.preventDefault(); return busy ? null : run(wish); };
    rowEl.appendChild(b);
  }
  if (mcpCanReconnect(row)) {
    // Glyph only, with the words in the tooltip AND in the aria-label. Measured in the real popover: a
    // second TEXT button pushed every broken row onto a second line (name · dot · state · „ausschalten" ·
    // „neu verbinden" ≈ 400 px), and the rows that wrap are exactly the ones being scanned for.
    const b = el('button', 'mini-btn mcp-mini', '↻');
    b.title = tt('chat.mcpLiveNeuVerbinden') + ' — ' + tt('chat.mcpLiveNeuVerbindenTooltip');
    b.setAttribute('aria-label', tt('chat.mcpLiveNeuVerbinden'));
    b.disabled = busy;
    b.onclick = (e) => { e.stopPropagation(); e.preventDefault(); return busy ? null : run(null); };
    rowEl.appendChild(b);
  }
  if (!mark) return;
  if (mark.state === 'on' || mark.state === 'off') {
    // The state WAS read back and matches the wish — but the switch itself may still never have been
    // answered (a toggle that outran the ceiling). That is provenance, not a failure, so it is a quiet note
    // next to a green row rather than a warning.
    if (mark.unconfirmed) { const n = el('span', 'mcp-note', tt('chat.mcpLiveOhneAntwortKurz')); n.title = tt('chat.mcpLiveOhneAntwort'); rowEl.appendChild(n); }
    return;
  }
  const n = el('span', 'mcp-note bad', tt(mark.state === 'refused' ? 'chat.mcpLiveAbgelehntKurz'
    : mark.state === 'ineffective' ? 'chat.mcpLiveUnwirksamKurz' : 'chat.mcpLiveUnbestaetigtKurz'));
  n.title = mark.error || tt(mark.state === 'unknown' ? 'chat.mcpLiveUnbestaetigt' : 'chat.mcpLiveUnwirksam');
  rowEl.appendChild(n);
}
// per-chat MCP-server picker. TWO things in one list, deliberately: the CHECKBOX is the set this session is
// LAUNCHED with (--mcp-config, fixed at launch → still a restart), the dot and the buttons next to it are
// the state and the switches of the session as it runs NOW. They are not the same mechanism and the menu
// says so in its hint line, because mcp_toggle also persists per PROJECT — see mcp-live.js.
async function pickTabMcp(t) {
  closeTabMenu();
  const old = $('#tabMcpMenu'); if (old) old.remove();
  const m = el('div', 'ctx-menu tab-pop mcp-pop'); m.id = 'tabMcpMenu';
  m.appendChild(el('div', 'ctx-head', tt('chat.mcpServerFuerDiesen')));
  const listEl = el('div', 'mcp-check-list'); listEl.appendChild(el('div', 'ctx-loading', tt('common.lade')));
  m.appendChild(listEl);
  document.body.appendChild(m); positionMenuAt(m, t.tabEl); autoCloseOnOutside(m);
  let servers = [];
  try { const r = await api('/api/mcp/configured'); servers = (r.servers || []).map((s) => s.name); } // instant, no health check — we only need names (ToDo 05)
  catch (e) { listEl.innerHTML = ''; listEl.appendChild(el('div', 'ctx-item disabled', tt('common.fehler-2') + e.message)); return; }
  // current selection: tab's explicit choice → else the session's stored choice → else all. A fork that has not
  // reported its own id yet reads the scope it inherited, under its source's id (forkCopyLaunch, P-0); once the
  // id is there, the server has stored that very scope under it.
  let sel = t.mcpServers;
  const storedId = t.sessionId || t._mcpFrom;
  if (sel === undefined && storedId) { try { const r = await api('/api/session/mcp?id=' + encodeURIComponent(storedId)); sel = r.selection; } catch {} }
  const selected = new Set(Array.isArray(sel) ? sel : servers);
  // The menu's own model, because the DOM cannot hold it: draw() empties the list and rebuilds every row.
  //   `rows`  the last read-back (null = nothing could be read, which is NOT an empty list), replaced by
  //           every answer, so one switch repaints all rows instead of letting them drift apart.
  //   `marks` the verdict of a switch THIS menu performed, per server name. Without it a repaint from the
  //           fresh read-back would drop exactly the „unbestätigt" the user has to see — the row would fall
  //           back to a plain status word, which is the optimistic reading of a request nobody answered.
  //   `busy`  a switch for that server is in flight. In the button element this state did not survive the
  //           next row's repaint, and the row then offered a second click on a switch still running.
  const state = { rows: await mcpLiveRead(t), marks: {}, busy: {} };
  if (!m.isConnected) return;                         // the menu was closed while the status was in flight
  const draw = () => {
    listEl.innerHTML = '';
    const rows = state.rows;
    const split = mcpSplitConfigured(servers, rows || []);
    // The live line comes FIRST and always — before this it was skipped whenever there was nothing to list,
    // and the menu then said „Keine MCP-Server konfiguriert" over a session whose state could not be read
    // at all (observed in the real popover after a reload had left a stale chat id behind). That is a
    // statement about the machine's config standing in for one about this session.
    if (rows) {
      const s = mcpStatusSummary(rows);
      listEl.appendChild(el('div', 'mcp-sub', tt('chat.mcpLiveKopf').replace('{n}', String(s.connected)).replace('{m}', String(s.total))));
    } else if (t.id) listEl.appendChild(el('div', 'mcp-sub', tt('chat.mcpLiveUnlesbar')));
    else listEl.appendChild(el('div', 'mcp-sub', tt('chat.mcpLiveKeineSitzung')));
    const all = split.live.concat(split.unlisted, split.extra);
    if (!all.length) { listEl.appendChild(el('div', 'ctx-item disabled', tt('chat.keineMcpServerKonfiguriert'))); return; }
    all.forEach((name) => {
      const inCfg = servers.indexOf(name) >= 0;
      const row = el('div', 'mcp-row');
      // The checkbox lives in its own <label> and the live buttons sit OUTSIDE it. Not cosmetic: a button
      // inside a label toggles that label's checkbox on click, so „neu verbinden" would silently change the
      // start selection as well.
      const lab = el('label', 'mcp-check');
      if (inCfg) {
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = selected.has(name);
        cb.onchange = () => { if (cb.checked) selected.add(name); else selected.delete(name); };
        lab.appendChild(cb);
      } else {
        // A server the session HAS but the machine config does not list (scope 'dynamic'/'sdk', a plugin
        // server): there is nothing to pre-tick for the next start, so the slot stays empty rather than
        // showing a checkbox that would write a name the start route cannot resolve.
        lab.appendChild(el('span', 'mcp-nobox', '·'));
      }
      lab.appendChild(el('span', 'mcp-name', name));
      row.appendChild(lab);
      const r = rows ? mcpRow(rows, name) : null;
      if (r) mcpLiveControls(row, t, r, state, draw);
      else if (rows) row.appendChild(el('span', 'mcp-state off', tt('chat.mcpLiveNichtInSitzung')));
      listEl.appendChild(row);
    });
    if (rows) listEl.appendChild(el('div', 'mcp-sub mcp-warn', tt('chat.mcpLiveHinweis')));
  };
  draw();
  const foot = el('div', 'mcp-foot');
  const allBtn = el('button', 'mini-btn', tt('common.alle')); allBtn.onclick = (e) => { e.stopPropagation(); selected.clear(); servers.forEach((n) => selected.add(n)); listEl.querySelectorAll('input').forEach((c) => { c.checked = true; }); };
  const noneBtn = el('button', 'mini-btn', tt('chat.keine')); noneBtn.onclick = (e) => { e.stopPropagation(); selected.clear(); listEl.querySelectorAll('input').forEach((c) => { c.checked = false; }); };
  // „Übernehmen" is the CHECKBOX half and still means a restart — the only way to bring a server INTO a
  // session: with --strict-mcp-config the CLI only knows the names in the temp config it was launched with,
  // and mcp_toggle answers „Server not found" for everything else. The tooltip says that, because the live
  // switches one row above make „übernehmen" look like it might be the same thing.
  const apply = el('button', 'mini-btn mcp-apply', tt('chat.uebernehmen'));
  apply.title = tt('chat.mcpStartUebernehmenTooltip');
  apply.onclick = (e) => { e.stopPropagation(); m.remove(); applyTabMcp(t, servers, selected); };
  foot.appendChild(allBtn); foot.appendChild(noneBtn); foot.appendChild(apply); m.appendChild(foot);
  positionMenuAt(m, t.tabEl);
}
function applyTabMcp(t, allServers, selectedSet) {
  const sel = (selectedSet.size >= allServers.length) ? null : Array.from(selectedSet); // all selected → null (no scoping)
  t.mcpServers = sel;
  if (t.id && t.sessionId) {
    // MCP is fixed at launch — restart the session (resume same id, history preserved) so the new set applies
    // startChat sends t.mcpServers by itself, so a deferred restart picks up the LAST selection, not this one
    uiConfirm(tt('chat.sitzung') + t.title + tt('chat.mitNeuerMcpAuswahl'), { title: tt('chat.sitzungNeuStarten'), okLabel: tt('chat.neuStarten') }).then((ok) => {
      if (!ok) return;
      activateTab(t);
      restartWhenIdle(t, 'MCP', tt('chat.mcpAuswahlUebernommenSitzung'));
    });
  } else {
    toast(sel ? ('MCP: ' + sel.length + tt('chat.serverGreiftBeimStart')) : tt('chat.mcpAlleServerGreift'), 'ok');
  }
}
function startTabRename(t, titleEl) {
  const inp = el('input', 'ct-rename'); inp.value = t.title; inp.spellcheck = false;
  titleEl.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const commit = () => {
    if (done) return; done = true;
    const v = inp.value.trim();
    if (v) {
      t.title = v.length > 26 ? v.slice(0, 25) + '…' : v; t.manualTitle = true; t.defaultTitle = false;
      // tabs are local UI; sessions live server-side. Keep the backing session's name in sync so a
      // renamed tab shows the same name in the Sessions view (send full value — server caps at 120).
      if (t.sessionId) api('/api/session/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: t.sessionId, name: v }) })
        .then(() => { if (typeof loadSessions === 'function' && $('#view-sessions') && $('#view-sessions').classList.contains('active')) loadSessions(); })
        .catch(() => {});
    }
    renderTabs(); persistTabs();
  };
  // stop keys bubbling to the tab item's keydown (chat.js item.onkeydown) — otherwise Space/Enter would
  // trigger activateTab → renderTabs() and tear down this very input mid-edit.
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { e.preventDefault(); done = true; renderTabs(); } };
  inp.onblur = commit;
  inp.onclick = (e) => e.stopPropagation();
  inp.ondblclick = (e) => e.stopPropagation();
}
// --- top status chip: live/idle state + session id (replaces the stale-prone "starting…" string, ToDo 04) ---
function sessionChipText(t) {
  if (!t) return tt('html.keineSitzung');
  // CHAT-FLOW-4 — said, not hidden: a tab whose session another tab or window holds would otherwise read
  // „◦ beendet" (superseded) or „keine Sitzung" (refused), and neither is what happened
  if (t._superseded || t._elsewhere) return '⇄ ' + tt('chat.anderswoOffen') + ' · ' + String(t.sessionId || (t.pending && t.pending.sessionId) || '').slice(0, 8);
  if (t._exited) return '◦ ' + tt('chat.beendet');
  // A resume claims the session id at once (persistTabs needs it), so the chip used to say „◦ idle · <id>" for the
  // whole resume — rest, in the one state that is not rest at all.
  if (t._resuming) return '◌ ' + tt('chat.wirdFortgesetzt') + (t._resumeAt ? ' · ' + Math.max(0, Math.round((Date.now() - t._resumeAt) / 1000)) + ' s' : '');
  if (t._starting && !t.id) return '◌ ' + tt('common.startet');
  const id = (t.sessionId || t.id || '').slice(0, 8);
  if (!id) return tt('html.keineSitzung');
  return (t.streaming ? '● ' + tt('chat.live-2') + ' · ' : '◦ ' + tt('chat.idle') + ' · ') + id;
}
function refreshSessionChip(t) {
  if (t !== ACTIVE) return;
  const c = $('#sessionChip'); if (!c) return;
  c.textContent = sessionChipText(t);
  c.classList.toggle('chip-live', !!t.streaming);
  c.classList.toggle('chip-idle', !!(t.id && !t.streaming && !t._exited));
}
// --- resume loading indicator: an IN-WINDOW block (text + indeterminate bar) inside the tab's transcript
//     while a resume is in flight; the composer is LOCKED meanwhile so the chat isn't input-ready (ToDo 01/04) ---
// (safety-unlock timer lives per tab as tab._resumeSafety — a module-global timer let one tab's
// hide clear another's 20s never-lock-forever guard while two resumes overlapped)
// lock/unlock the composer (textarea + send) — used while a resume/restart is loading history
function setComposerEnabled(on) {
  const inp = $('#composerInput'); if (inp) inp.disabled = !on;
  const send = $('#sendBtn'); if (send) send.disabled = !on;
  const comp = document.querySelector('.composer'); if (comp) comp.classList.toggle('resuming', !on);
}
function resumeLoaderEl(tab) { return (tab && tab.msgEl) ? tab.msgEl.querySelector(':scope > .resume-inline') : null; }
function showResumeLoading(t) {
  const tab = t || ACTIVE;
  if (!tab || tab !== ACTIVE) return; // only the visible tab shows the loader + locks the composer
  if (!resumeLoaderEl(tab)) {
    const box = el('div', 'resume-inline');
    box.appendChild(el('div', 'ri-text', tt('chat.sitzungWirdFortgesetzt'))); // the stage line below says WHICH part
    const bar = el('div', 'ri-bar'); bar.appendChild(el('div', 'ri-bar-fill')); box.appendChild(bar);
    // what it is waiting for, and for how long (resumeStage) — and, past RESUME_SLOW_MS, that this is unusual
    box.appendChild(el('div', 'ri-stage'));
    box.appendChild(el('div', 'ri-warn'));
    tab.msgEl.appendChild(box);
  }
  setComposerEnabled(false);
  // Never lock forever — but no longer by REMOVING the loader: past 20 s it vanished while the resume was still
  // running, and an empty pane with a free composer is exactly what „it hangs" looks like (07.10.). Now the
  // composer is freed (a send waits for the resume anyway: sendMessage → whenResumeSettled) and the box stays,
  // saying what it waits for. A non-resume start (fork) keeps the old behaviour: resumeTooSlow hides it.
  clearTimeout(tab._resumeSafety); tab._resumeSafety = setTimeout(() => resumeTooSlow(tab), RESUME_SLOW_MS);
  resumePaint(tab);
}
// ---- resume stages (07.10.) — a long resume has to SAY that it is one, and what it is waiting for --------------
// Measured on the 5 MB / 1 976-line session that „hung" after a server restart: the transcript tail reads in 0,3 s,
// the cold session list in 0,4 s, `claude --help` in 0,4 s — so the slow stage could not be named afterwards.
// The stages below make the next one name itself: on the box while it runs, in the 🔔 log when it took long.
const RESUME_SLOW_MS = 20000;      // the box turns into „dauert länger als üblich" and the composer is freed
const RESUME_SLOW_LOG_MS = 8000;   // a resume that took this long is written to the 🔔 log with its slowest stage
const RESUME_STAGE_KEYS = { sessions: 'chat.resumeStufeSessions', spawn: 'chat.resumeStufeSpawn', history: 'chat.resumeStufeHistory', paint: 'chat.resumeStufePaint' };
let RESUME_TICKER = null;
function resumeStage(tab, key) {
  if (!tab) return;
  const now = Date.now();
  if (!tab._resumeAt) { tab._resumeAt = now; tab._resumeStages = []; }
  const st = tab._resumeStages || (tab._resumeStages = []);
  const prev = st[st.length - 1];
  if (prev && !prev.end) prev.end = now;
  st.push({ key, at: now });
  resumePaint(tab);
  if (!RESUME_TICKER) RESUME_TICKER = setInterval(resumeTick, 1000);
}
function resumeTick() {
  let any = false;
  TABS.forEach((t) => { if (t._resuming) { any = true; resumePaint(t); } });
  if (!any) { clearInterval(RESUME_TICKER); RESUME_TICKER = null; }
}
function resumeStageText(key) { return RESUME_STAGE_KEYS[key] ? tt(RESUME_STAGE_KEYS[key]) : ''; }
function resumePaint(tab) {
  if (!tab || tab !== ACTIVE) return;
  refreshSessionChip(tab);
  const box = resumeLoaderEl(tab); if (!box) return;
  const st = tab._resumeStages || [], cur = st.length ? st[st.length - 1].key : '';
  const secs = tab._resumeAt ? Math.max(0, Math.round((Date.now() - tab._resumeAt) / 1000)) : 0;
  const line = box.querySelector('.ri-stage');
  if (line) line.textContent = (cur ? resumeStageText(cur) + ' · ' : '') + secs + ' s';
  box.classList.toggle('ri-slow', !!tab._resumeSlow);
  const w = box.querySelector('.ri-warn');
  if (w) w.textContent = tab._resumeSlow ? tt('chat.resumeLangsam').replace('{s}', String(secs)).replace('{stage}', cur ? resumeStageText(cur) : '…') : '';
}
function resumeTooSlow(tab) {
  tab._resumeSafety = null;
  if (!tab._resuming) { hideResumeLoading(tab); return; } // not a resume (a fork's start): the old rule
  tab._resumeSlow = true;
  if (tab === ACTIVE) setComposerEnabled(true);
  resumePaint(tab);
}
// The slowest stage of a finished resume — pure, for the log line (test/resume-visible.test.js).
function resumeSlowest(stages, now) {
  let best = null;
  (stages || []).forEach((x) => { const d = (x.end || now) - x.at; if (!best || d > best.ms) best = { key: x.key, ms: d }; });
  return best;
}
function resumeFinish(tab) {
  if (!tab || !tab._resumeAt) return;
  const now = Date.now(), total = now - tab._resumeAt;
  if (total >= RESUME_SLOW_LOG_MS && typeof logEvent === 'function') {
    const slow = resumeSlowest(tab._resumeStages, now);
    logEvent(tt('chat.resumeDauerte').replace('{t}', tab.title || '').replace('{s}', String(Math.round(total / 1000)))
      + (slow ? ' — ' + resumeStageText(slow.key) + ' ' + Math.round(slow.ms / 1000) + ' s' : ''), 'warn');
  }
  tab._resumeAt = 0; tab._resumeStages = null; tab._resumeSlow = false;
}
function hideResumeLoading(t) {
  const tab = t || ACTIVE;
  if (tab) { clearTimeout(tab._resumeSafety); tab._resumeSafety = null; }
  const box = resumeLoaderEl(tab); if (box) box.remove();
  if (!tab || tab === ACTIVE) setComposerEnabled(true);
}
// cwd is only editable for a NEW/unstarted chat (ToDo 07a) — the row stays hidden until the status-strip cwd
// chip is clicked (C5). Before that the working directory was invisible AND unchangeable in the chat window,
// although it decides which CLAUDE.md applies, what /diff shows and what @-completion can see.
let CWD_EDIT = false;
function updateCwdRowVisibility() { const c = document.querySelector('.composer-config'); if (c) c.classList.toggle('hidden', !(CWD_EDIT && ACTIVE && !ACTIVE.id)); }
function closeCwdEditor() { CWD_EDIT = false; updateCwdRowVisibility(); if (typeof renderStatusBar === 'function') renderStatusBar(); }
function openCwdEditor() {
  const t = ACTIVE;
  if (!t || t.id) { toast(tt('chat.cwdNurVorStart'), 'err'); return; } // a running session's cwd is a launch flag
  CWD_EDIT = true; updateCwdRowVisibility();
  const inp = $('#cwdInput'); if (!inp) return;
  inp.value = t.cwd || (STATE && (STATE.defaultCwd || STATE.home)) || '';
  refreshCwdList(); // recent dirs + known project paths as the datalist (existing #cwdList)
  inp.focus(); try { inp.select(); } catch { /* */ }
  const commit = () => { const v = inp.value.trim(); if (v && v !== t.cwd) { t.cwd = v; pushRecentCwd(v); refreshCwdList(); toast(tt('chat.arbeitsverzeichnis') + v, 'ok'); } closeCwdEditor(); };
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { e.preventDefault(); closeCwdEditor(); } };
  inp.onblur = () => setTimeout(commit, 180); // let a click on „als Standard speichern" land before the row hides
}
// A15 — extra readable roots for this tab (`--add-dir`). One path per line; the server drops entries
// that don't exist rather than failing the start, so a stale line can't make a restored tab unusable.
async function editTabAddDirs(t) {
  if (t.id) { toast(tt('chat.cwdNurVorStart'), 'err'); return; }
  const cur = (t.addDirs || []).join('\n');
  const v = await uiPrompt(tt('chat.weitereVerzeichnisseFrage'), cur, { icon: '🗂', title: tt('chat.weitereVerzeichnisse'), multiline: true, rows: 4, placeholder: 'C:\\Users\\…\\repo' });
  if (v == null) return;
  t.addDirs = String(v).split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 8);
  if (typeof persistTabs === 'function') persistTabs();
  toast(t.addDirs.length ? tt('chat.weitereVerzeichnisseGesetzt').replace('{n}', t.addDirs.length) : tt('chat.keineWeiterenVerzeichnisse'), 'ok');
}
// C2 — the session agent (`--agent <name>`). The panel has managed these files for a while (list,
// editor, backups under „Subagenten" in System); this is the piece that was missing: using one for a
// chat. A launch flag, so it is chosen before the start — like the cwd.
async function editTabAgent(t) {
  if (t.id) { toast(tt('chat.cwdNurVorStart'), 'err'); return; }
  let files = [];
  try { files = (await api('/api/cfgfiles?kind=agents')).files || []; } catch (e) { toast(e.message, 'err'); return; }
  if (!files.length) { toast(tt('chat.agentKeineDateien'), 'warn'); return; }
  // Buttons rather than a text field: the set is small and typing a name the CLI then rejects at spawn
  // is the one failure mode worth designing out. Beyond eight, the list becomes a field again.
  if (files.length <= 8) {
    const actions = [{ label: tt('chat.agentKeiner'), value: '' }]
      .concat(files.map((f) => ({ label: (f.name === t.agent ? '● ' : '') + f.name, value: f.name, primary: f.name === t.agent })))
      .concat([{ label: tt('html.abbrechen'), value: null }]);
    const picked = await uiModal({
      icon: '🧠', title: tt('chat.agentTitel'),
      message: tt('chat.agentFrage') + '\n\n' + files.map((f) => '· ' + f.name + (f.description ? ' — ' + f.description : '')).join('\n'),
      escValue: null, actions,
    });
    if (picked == null) return;
    t.agent = picked || null;
  } else {
    const v = await uiPrompt(tt('chat.agentFrage') + '\n\n' + files.map((f) => '· ' + f.name).join('\n'),
      t.agent || '', { icon: '🧠', title: tt('chat.agentTitel'), multiline: false });
    if (v == null) return;
    const name = String(v).trim();
    if (name && !files.some((f) => f.name === name)) { toast(tt('chat.agentUnbekannt') + name, 'err'); return; }
    t.agent = name || null;
  }
  if (typeof persistTabs === 'function') persistTabs();
  if (t === ACTIVE && typeof renderStatusBar === 'function') renderStatusBar();
  toast(t.agent ? tt('chat.agentGesetzt') + t.agent : tt('chat.agentKeiner'), 'ok');
}
// C3 — a git worktree of its own for this chat (`-w, --worktree [name]`). The consequence the panel has
// to carry is that the session's cwd is then NOT the one that was requested — chat-events.js adopts the
// cwd the `init` frame reports, so the status line never claims the main tree.
async function editTabWorktree(t) {
  if (t.id) { toast(tt('chat.cwdNurVorStart'), 'err'); return; }
  const cur = t.worktree === true ? '' : (t.worktree || '');
  const picked = await uiModal({
    icon: '🌿', title: tt('chat.worktreeTitel'),
    message: tt('chat.worktreeFrage'),
    input: { label: tt('chat.worktreeName'), value: cur, placeholder: 'feature-x' },
    escValue: null,
    actions: [
      { label: tt('html.abbrechen'), value: null },
      { label: tt('chat.worktreeAus'), value: '__off__' },
      { label: tt('chat.worktreeAn'), returnsInput: true, primary: true },
    ],
  });
  if (picked == null) return;
  if (picked === '__off__') t.worktree = null;
  else t.worktree = String(picked).trim() || true; // true = let the CLI name it
  if (typeof persistTabs === 'function') persistTabs();
  toast(t.worktree ? (t.worktree === true ? tt('chat.worktreeAnOhneName') : tt('chat.worktreeGesetzt') + t.worktree) : tt('chat.worktreeAus'), 'ok');
}
// A3 — hard dollar cap for this tab's session (`--max-budget-usd`). Empty / 0 removes the cap.
async function editTabBudget(t) {
  if (t.id) { toast(tt('chat.cwdNurVorStart'), 'err'); return; }
  const v = await uiPrompt(tt('chat.budgetFrage'), t.maxBudgetUsd ? String(t.maxBudgetUsd) : '', { icon: '💰', title: tt('chat.budgetTitel'), placeholder: '2.50' });
  if (v == null) return;
  const n = Number(String(v).replace(',', '.'));
  if (!String(v).trim() || !Number.isFinite(n) || n <= 0) { t.maxBudgetUsd = null; toast(tt('chat.budgetEntfernt'), 'ok'); }
  else { t.maxBudgetUsd = Math.min(n, 100); toast(tt('chat.budgetGesetzt') + fmtMoney(t.maxBudgetUsd), 'ok'); }
  if (typeof persistTabs === 'function') persistTabs();
  if (t === ACTIVE && typeof renderStatusBar === 'function') renderStatusBar();
}
// D1 — Leitplanken: the standing constraints of this chat ("T01 ist Test", "nichts pushen ohne mein
// OK"). They go into the appended system prompt, so they hold for every turn of the session, survive a
// compaction, and don't have to be repeated. That prompt is a LAUNCH argument, so an edit mid-session
// can only take effect on a relaunch — which is offered right here instead of being left as a surprise.
// „Can only", not „does": this comment used to promise that the relaunch applies the edit, and with the
// CLI's prompt snapshot on it does not (measured 2026-10-03 against 2.1.288, see the top of lib/pure.js):
// a resume replays the prompt recorded at the session's first request until its next compaction. The
// relaunch below therefore depends on promptSnapshotFresh().
function guardrailCount(s) { return String(s || '').split('\n').map((x) => x.trim()).filter(Boolean).length; }
// PR-S — will the next launch of a session that ALREADY exists render the appended prompt anew?
//   true  — the panel passes `--system-prompt-snapshot off` (setting „aus") and this CLI lists the flag;
//   false — the setting is „an": a session that HAS a record (started while the snapshot was on) gets it
//           replayed until the next compaction. One started under „aus" has none („off: never record",
//           --help), and what „an" does on its next resume is NOT measured — so false means „probably
//           not", never „certainly not", and the relaunch stays on offer (with that sentence);
//   null  — not proven: the CLI does not list the flag (or its --help has not answered), so the server
//           leaves the flag out and whatever this CLI does by itself applies.
// Only `true` is a proven „yes"; every text for the other two says so.
// The boot read of /api/state can predate the server's own --help probe (a reload right after a server
// restart lands inside its ~1.7 s), so an unknown answer is asked for once more before it is shown.
async function promptSnapshotFresh() {
  const pr = (STATE && STATE.prefs) || {};
  if (pr.promptSnapshot === 'on') return false;
  if (STATE && STATE.promptSnapshotFlag == null) {
    try { const s = await api('/api/state'); STATE.promptSnapshotFlag = s.promptSnapshotFlag; } catch { /* stays unproven */ }
  }
  return (STATE && STATE.promptSnapshotFlag === true) ? true : null;
}
async function editTabGuardrails(t) {
  const v = await uiPrompt(tt('chat.leitplankenFrage'), t.guardrails || '', {
    icon: '🛡', title: tt('chat.leitplanken'), multiline: true, rows: 5,
    placeholder: tt('chat.leitplankenPlaceholder'),
  });
  if (v == null) return;
  const next = String(v).trim().slice(0, 2000);
  if (next === (t.guardrails || '')) return;
  t.guardrails = next;
  if (typeof persistTabs === 'function') persistTabs();
  if (t === ACTIVE && typeof renderStatusBar === 'function') renderStatusBar();
  // never run: its first start renders the prompt from scratch, snapshot or not
  if (!t.id && !t.sessionId) { toast(next ? tt('chat.leitplankenGesetzt') : tt('chat.leitplankenEntfernt'), 'ok'); return; }
  // An existing session — running, or dormant and resumed on its next start. Whether that start carries
  // the edit is promptSnapshotFresh()'s answer, and every sentence below follows it: a toast that says
  // „gelten ab dem Start" or „angewendet" is only true for `true`.
  const fresh = await promptSnapshotFresh();
  if (!t.id) {
    // dormant: there is nothing to relaunch, its next start IS the resume — only the sentence can be wrong
    if (fresh === true) toast(next ? tt('chat.leitplankenGesetzt') : tt('chat.leitplankenEntfernt'), 'ok');
    else if (fresh === false) await uiAlert(tt('chat.leitplankenSnapshotAn'), { title: tt('chat.leitplanken') });
    else toast(tt('chat.leitplankenAbNeustartUnbelegt'), 'ok');
    return;
  }
  // a running session already carries the OLD text — say so, and offer the relaunch. With the snapshot
  // on it is offered too: for a session without a record it may well work, which is not measured, so the
  // question says both cases instead of deciding for the user.
  const ask = fresh === true ? tt('chat.leitplankenNeustartFrage')
    : fresh === false ? tt('chat.leitplankenNeustartSnapshotAn') : tt('chat.leitplankenNeustartUnbelegt');
  const okLabel = fresh === false ? tt('chat.leitplankenTrotzdemNeustarten') : tt('chat.leitplankenJetztAnwenden');
  const apply = await uiConfirm(ask, { title: tt('chat.leitplanken'), okLabel });
  if (!apply) { toast(fresh === true ? tt('chat.leitplankenAbNeustart') : tt('chat.leitplankenAbNeustartUnbelegt'), 'ok'); return; }
  await restartWhenIdle(t, tt('chat.leitplanken'), fresh === true ? tt('chat.leitplankenAngewendet') : tt('chat.leitplankenNeugestartUnbelegt'));
}
// #34 — subagent policy for THIS chat. A turn can spawn agents that each run their own model and spend
// their own tokens; until now the panel had no say in it. Empty fields inherit the global default
// (Einstellungen → Subagenten), so this dialog is an override, not a second full configuration.
// Like the guardrails these are launch arguments (env + --disallowedTools), so a change on a running
// session needs a relaunch — offered here instead of silently doing nothing.
function subagentGlobal() { return (STATE && STATE.prefs && STATE.prefs.subagents) || {}; }
// The one-line state for the menu entry. Reads the EFFECTIVE policy (tab over global) — the menu has to
// say what will happen, not which half of it was typed where.
function subagentLabel(t) {
  const g = subagentGlobal(), c = Object.assign({}, g, (t && t.subagents) || {});
  if (c.allow === false) return tt('chat.subagentsAus');
  const bits = [];
  if (c.model && c.model !== 'inherit') bits.push(c.model + (c.force ? ' !' : ''));
  if (c.maxConcurrent) bits.push('∥' + c.maxConcurrent);
  if (c.maxPerSession) bits.push('Σ' + c.maxPerSession);
  if (c.maxDepth) bits.push('↳' + c.maxDepth);
  return bits.length ? tt('chat.subagentsN').replace('{s}', bits.join(' · ')) : tt('chat.subagentsStandard');
}
async function editTabSubagents(t) {
  const g = subagentGlobal();
  const cur = (t && t.subagents) || {};
  const body = el('div', 'sa-form');
  const row = (labelText, node, hint) => {
    const l = el('label', 'sa-row');
    l.appendChild(el('span', 'sa-lbl', labelText));
    l.appendChild(node);
    if (hint) l.appendChild(el('span', 'sa-hint', hint));
    body.appendChild(l);
    return node;
  };
  const allow = el('input'); allow.type = 'checkbox';
  allow.checked = !(cur.allow === false || (cur.allow === undefined && g.allow === false));
  row(tt('chat.subagentsErlauben'), allow, tt('chat.subagentsErlaubenHinweis'));
  const model = el('select', 'ui-input');
  // "" = inherit the global default; that is a THIRD state next to "inherit the parent model", and
  // conflating the two would make a tab unable to go back to following the global setting.
  [['', tt('chat.subagentsModellGlobal') + (g.model ? ' (' + g.model + ')' : '')],
    ['inherit', tt('chat.subagentsModellInherit')],
    ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable']]
    .forEach(([v, lab]) => { const o = el('option', null, lab); o.value = v; model.appendChild(o); });
  model.value = cur.model || '';
  row(tt('common.modell'), model);
  const force = el('input'); force.type = 'checkbox'; force.checked = !!cur.force;
  row(tt('chat.subagentsErzwingen'), force, tt('chat.subagentsErzwingenHinweis'));
  const num = (v, ph) => { const i = el('input', 'ui-input sa-num'); i.type = 'number'; i.min = '1'; i.value = v == null ? '' : String(v); i.placeholder = ph; return i; };
  const conc = row(tt('chat.subagentsParallel'), num(cur.maxConcurrent, g.maxConcurrent ? String(g.maxConcurrent) : tt('chat.subagentsOhne')));
  const per = row(tt('chat.subagentsProSitzung'), num(cur.maxPerSession, g.maxPerSession ? String(g.maxPerSession) : tt('chat.subagentsOhne')));
  const depth = row(tt('chat.subagentsTiefe'), num(cur.maxDepth, g.maxDepth ? String(g.maxDepth) : '3'));
  // „erzwingen" without a concrete model does nothing (lib/pure subagentSpawnConfig drops it) — so the
  // checkbox says so by being unavailable rather than by being ignored.
  const syncForce = () => { const on = model.value && model.value !== 'inherit'; force.disabled = !on; if (!on) force.checked = false; };
  model.onchange = syncForce; syncForce();

  const ok = await uiModal({
    icon: '🤖', title: tt('chat.subagents'), body,
    message: tt('chat.subagentsHinweis'),
    actions: [{ label: tt('html.abbrechen'), value: false }, { label: tt('common.speichern'), value: true, primary: true }],
  });
  if (!ok) return;
  const next = {};
  if (!allow.checked) next.allow = false;
  if (model.value) next.model = model.value;
  if (force.checked && model.value && model.value !== 'inherit') next.force = true;
  const int = (inp) => { const n = parseInt(inp.value, 10); return Number.isFinite(n) && n > 0 ? n : undefined; };
  if (int(conc)) next.maxConcurrent = int(conc);
  if (int(per)) next.maxPerSession = int(per);
  if (int(depth)) next.maxDepth = int(depth);
  const before = JSON.stringify(t.subagents || {});
  t.subagents = Object.keys(next).length ? next : undefined;
  if (JSON.stringify(t.subagents || {}) === before) return;
  if (typeof persistTabs === 'function') persistTabs();
  if (t === ACTIVE && typeof renderStatusBar === 'function') renderStatusBar();
  if (!t.id) { toast(tt('chat.subagentsGesetzt'), 'ok'); return; }
  const apply = await uiConfirm(tt('chat.subagentsNeustartFrage'), { title: tt('chat.subagents'), okLabel: tt('chat.leitplankenJetztAnwenden') });
  if (!apply) { toast(tt('chat.subagentsAbNeustart'), 'ok'); return; }
  await restartWhenIdle(t, tt('chat.subagents'), tt('chat.subagentsAngewendet'));
}
// ---- Ultracode: standing dynamic-workflow orchestration for this chat -------------------------------
//
// In the terminal this is `/effort ultracode` or simply typing „ultracode" in a prompt. NEITHER reaches
// the panel: the keyword is REPL-side prompt preprocessing that never runs on the headless stream-json
// input the panel feeds, which is why the panel has to offer the settings key itself.
//
// Unlike the subagent policy above this is LIVE switchable (apply_flag_settings), so the entry stays
// enabled while a session runs. And it is a switch of its OWN, not a reasoning level: since CLI 2.1.284
// ultracode „no longer forces xhigh effort and stays on at any effort level", so „max + Ultracode" is a
// legitimate combination and the two are never offered as one choice.
function ultracodeGlobal() { return !!(STATE && STATE.prefs && STATE.prefs.ultracode); }
function ultracodeOn(t) { const v = t && t.ultracode; return (v === true || v === false) ? v : ultracodeGlobal(); }
// The pre-start FORECAST of whether a model can do Ultracode at all (and which effort levels it offers),
// cached on the tab. Never awaited on a UI path: the route can spawn claude.exe on a cold cache (measured
// 3.6 s, server.js), and a control that does nothing for four seconds is worse than a hint that appears a
// moment late. A FAILED probe caches nothing, so „unknown" keeps meaning „possible" — a wrong „no" would
// hide the switch for good, a wrong „yes" is corrected a second after the session starts.
function fetchUltracodeSupport(t, model, after) {
  if (!t) return;
  const m = (model === undefined || model === null) ? String(t.modelSel || '') : String(model);
  if (t._ucSupport && t._ucSupport.model === m) { if (after) after(t._ucSupport); return; }
  // The same question twice while the first one is still open is one request too many — and it became
  // possible the moment applyEffortLevelsForModel started asking for the forecast itself (M2 below).
  if (t._ucSupportPending && t._ucSupportWant === m) return;
  t._ucSupportWant = m;                                    // the question currently outstanding
  t._ucSupportPending = true;
  api('/api/ultracode/support?model=' + encodeURIComponent(m))
    .then((r) => {
      if (t._ucSupportWant !== m) return;                  // a later model change asked a newer one — it wins
      t._ucSupportPending = false;
      // `effortLevelsKnown`: an empty list means two different things and the server is the only side that
      // can tell them apart (see the route). Carried along so the warning line can say „this model has no
      // levels" without the filter having to act on an unchecked model. An older server omits the field →
      // undefined → „not stated", which is the safe reading.
      t._ucSupport = { model: m, supported: r.supported !== false, effortLevels: Array.isArray(r.effortLevels) ? r.effortLevels : [], levelsKnown: r.effortLevelsKnown === true, source: r.source || '' };
      if (after) after(t._ucSupport);
    })
    .catch(() => { t._ucSupportPending = false; /* a failed probe is „not checked", and „not checked" must not read as „impossible" */ });
}
// ONE truth function for the chip, the tab-menu line and the dialog. Each of the three used to decide for
// itself, and all three preferred the session read-out over the wish UNCONDITIONALLY (`if (st) return
// st.state === 'on' ? an : aus`) — so a stale or reset `ucState` erased what the user had asked for, and
// the menu line could read „aus" next to a chip reading „angefordert". Wish and applied state are two
// different facts and this keeps them apart:
//   wish    — what the user asked for. `t.ultracode` is three-valued (true / false / inherit the global).
//   applied — what the SESSION reports, the only authoritative statement there is; null before a session.
//   canDo   — whether Ultracode is possible on the model in force. Inside a running session that is the
//             session's own `available`. Before a start there is nothing to ask, so it is the forecast
//             above — and a forecast must not be presented as a fact, hence „unknown ⇒ possible".
//   chip    — 'on' · 'off' (possible but off → muted, clickable) · 'ineffective' (wished for and cannot
//             work → marked, with the reason) · 'none' (not possible and not wished for → no chip at all,
//             exactly as the CLI shows it) · 'unknown' (a session that did not answer — see below).
// THE TRAP: ultracodeState (lib/pure.js) returns state 'off' together with a NON-EMPTY reason when
// available === false && requested === false. So „can the model do it" must key on `available`, never on
// „the reason is empty" — that combination is an ordinary off, not a warning.
//
// TWO things this got wrong while claiming to be the one truth function:
//  · `ucState.state === 'unknown'` is NOT a session statement. It is what the tab stores when a control
//    request timed out, and treating it like one made a silence read as `available: true, state: 'off'` —
//    a muted „Ultracode aus · dieses Modell könnte es" chip composed entirely out of nothing. Hence
//    `known`: only a read-out that actually says something counts as „the session spoke", and `running`
//    (which every consumer uses as „believe the session") is derived from it rather than from `t.id`.
//  · the WISH of a RUNNING session is `applied.ultracodeRequested`, not the browser's `t.ultracode` with a
//    global-preference fallback. The session is where the wish lives (lib/chat keeps `ultracodeWish` for
//    exactly that reason), so a tab that never chose anything could otherwise turn a global preference into
//    a „requested, does not work" warning on a session that requested nothing — or hide a real one.
function ultracodeView(t) {
  const st = (t && t.ucState) || null;
  const known = !!(st && st.state !== 'unknown');
  const running = !!(t && t.id && known);
  const wish = running ? st.requested === true : ultracodeOn(t);
  const sup = (t && t._ucSupport) || null;
  const canDo = running ? st.available !== false : !(sup && sup.supported === false);
  let chip;
  if (t && t.id && st && !known) chip = 'unknown';                   // asked, nobody answered
  else if (running && st.state === 'ineffective') chip = 'ineffective';   // the session itself says so
  else if (!canDo) chip = wish ? 'ineffective' : 'none';
  else chip = (running ? st.state === 'on' : wish) ? 'on' : 'off';
  return {
    wish, canDo, chip, running,
    applied: running ? st.state === 'on' : null,
    // Whether `canDo` rests on anything at all. A running session always does (`available` is the CLI's own
    // word); before the start it needs the forecast to have landed. Without this the muted „off" chip
    // promised „dieses Modell könnte es" on a model nobody had checked — a guess worn as a state.
    canDoKnown: running || !!sup,
    // the forecast carries no reason of its own — the only half it can speak for is the model. And it names
    // the model it was ASKED about, not whatever the dropdown says now, so a reason can never point at the
    // wrong model; '' (the CLI's „default" alias) gets a readable name instead of a bare „?".
    reason: known ? st.reason : (canDo ? '' : 'model'),
    model: (st && st.model) || (sup && sup.model) || (t && t.modelSel) || tt('chat.ultracodeModellDefault'),
  };
}
// The menu line says what IS, not what was typed — but no longer at the cost of the wish: an Ultracode
// that cannot work reads „angefordert, wirkt nicht" instead of a flat „aus", and a session that has said
// nothing yet leaves the wish as the answer (it is what the next start will do). The „(global)" suffix
// only explains where an INHERITED wish comes from, so it is dropped once the session is the source.
function ultracodeLabel(t) {
  const v = ultracodeView(t);
  // „unbekannt" before anything else: with no answer from the session there is no „an"/„aus" to report, and
  // the menu line is the one place where a wrong word is read as a setting.
  if (v.chip === 'unknown') return tt('chat.ultracodeUnbekannt');
  // „wirkt nicht" is a statement about a RUNNING session. Before a start the same situation is only the
  // model-list forecast, and saying it in the same words would present a guess as a measurement.
  if (v.chip === 'ineffective') return v.running ? tt('chat.ultracodeUnwirksam') : tt('chat.ultracodeVoraussichtlichUnwirksam');
  if (v.running) return v.applied ? tt('chat.ultracodeAn') : tt('chat.ultracodeAus');
  const own = t && (t.ultracode === true || t.ultracode === false);
  return (v.wish ? tt('chat.ultracodeAn') : tt('chat.ultracodeAus')) + (own ? '' : tt('chat.ultracodeGlobalSuffix'));
}
// Why a requested ultracode is not in effect, in plain words. The two reasons come from the CLI's own
// wording ("<model> does not support it" / "dynamic workflows are off"). Takes anything carrying
// {reason, model} — the session's `ucState` or the view above, which fills the reason in for a forecast.
function ultracodeReasonText(st) {
  if (!st) return '';
  if (st.reason === 'model') return tt('chat.ultracodeGrundModell').replace('{m}', st.model || '?');
  if (st.reason === 'workflows_off') return tt('chat.ultracodeGrundWorkflows');
  if (st.reason === 'unavailable') return tt('chat.ultracodeGrundUnbekannt');
  return '';
}
async function editTabUltracode(t) {
  const v = ultracodeView(t);
  const body = el('div', 'sa-form');
  body.appendChild(el('p', 'sa-hint-block', tt('chat.ultracodeErklaerung')));
  // What the RUNNING session reports about itself — the only authoritative statement there is, and the
  // reason this dialog can be honest instead of hopeful (the CLI accepts a request it cannot honour).
  if (v.chip === 'ineffective' && v.running) body.appendChild(el('p', 'sa-hint-block sa-warn', '⚠ ' + ultracodeReasonText(v)));
  // …and when the session was asked but never answered, the dialog says THAT instead of showing a switch
  // position as if it had been read back.
  if (v.chip === 'unknown') body.appendChild(el('p', 'sa-hint-block sa-warn', '⚠ ' + tt('chat.ultracodeUnbekanntHinweis')));
  // Before a start there is no session to ask, so ask the CLI's model list instead — un-awaited, so the
  // line is appended when the answer arrives and only if the dialog is still open. It is a FORECAST and
  // says so: nothing here claims the next session will refuse.
  const preWarn = el('p', 'sa-hint-block sa-warn hidden');
  if (!t.id) {
    body.appendChild(preWarn);
    fetchUltracodeSupport(t, undefined, (sup) => {
      // The probe answered BOTH questions this tab had open — „can the model do Ultracode" and „which
      // effort levels does it offer" — so everything that reads them is repainted. Without this the answer
      // landed in this dialog alone: the effort dropdown kept its unfiltered options and the status strip
      // kept the chip it had drawn while nothing was known, until some unrelated event happened to repaint.
      if (t === ACTIVE) {
        if (typeof applyEffortLevelsForModel === 'function') applyEffortLevelsForModel();
        if (typeof renderStatusBar === 'function') renderStatusBar();
      }
      if (sup.supported !== false || !document.contains(preWarn)) return;
      preWarn.textContent = '⚠ ' + tt('chat.ultracodeVoraussichtlich') + ' '
        + tt('chat.ultracodeGrundModell').replace('{m}', t.modelSel || tt('chat.ultracodeModellDefault'));
      preWarn.classList.remove('hidden');
    });
  }
  // THREE values in ONE control. It used to be two checkboxes — on/off and „follow the global default" —
  // wired to each other through two onchange handlers, so the state that is hardest to describe („which
  // box do I tick to go back to inheriting?") was also the easiest to get into the wrong combination.
  // `undefined` stays the third value, so a tab that was ever touched can still go back to inheriting.
  let pick = (t.ultracode === true) ? 'on' : (t.ultracode === false) ? 'off' : 'global';
  const seg = el('div', 'ui-seg');
  const segBtns = [];
  [['global', tt('chat.ultracodeSegGlobal')], ['on', tt('chat.ultracodeSegAn')], ['off', tt('chat.ultracodeSegAus')]].forEach(([val, label]) => {
    const b = el('button', 'ui-seg-btn' + (pick === val ? ' active' : '')); b.type = 'button'; b.textContent = label;
    b.onclick = () => { pick = val; segBtns.forEach((x) => x.classList.toggle('active', x === b)); };
    seg.appendChild(b); segBtns.push(b);
  });
  const row = el('div', 'sa-row');
  row.appendChild(el('span', 'sa-lbl', tt('chat.ultracodeSchalter')));
  row.appendChild(seg);
  row.appendChild(el('span', 'sa-hint', tt('chat.ultracodeGlobalHinweis').replace('{s}', ultracodeGlobal() ? tt('chat-render.ja') : tt('chat-render.nein'))));
  body.appendChild(row);

  const ok = await uiModal({
    icon: '🌀', title: tt('chat.ultracode'), body,
    message: tt('chat.ultracodeKostenHinweis'),
    actions: [{ label: tt('html.abbrechen'), value: false }, { label: tt('common.speichern'), value: true, primary: true }],
  });
  if (!ok) return;
  const next = pick === 'global' ? undefined : pick === 'on';
  const before = t.ultracode;
  t.ultracode = next;
  if (before === next) return;
  if (typeof persistTabs === 'function') persistTabs();
  if (t === ACTIVE && typeof renderStatusBar === 'function') renderStatusBar();
  if (!t.id) { toast(tt('chat.ultracodeGemerkt'), 'ok'); return; }
  await applyLiveUltracode(t, ultracodeOn(t));
}
// ---- adopting a server read-out: ONE rule, because three call sites got it wrong the same way ----------
// Every ultracode-bearing response can arrive in one of two shapes, and only one of them may be believed:
//   · a READ-BACK — the session answered get_settings and the `ultracode` block is its own statement;
//   · a NON-ANSWER — the control request timed out (`unconfirmed`), or a future CLI refused it (`refused`),
//     or the server could not read the state and said so (`ultracode.state === 'unknown'`).
// applyLiveUltracode, refreshUltracodeState and applyLiveEffort each adopted `r.ultracode` unconditionally,
// so a 5-second silence from the session arrived in the UI as a fully-formed state — in the worst case as
// „Ultracode aus", which is the one thing a timeout definitely does not mean. The shared marker below is
// what the tab stores instead; ultracodeView turns it into the chip that says „unbestätigt".
//
// `unconfirmed` is checked as well as the state, and that is deliberately CONSERVATIVE rather than minimal.
// On /effort it means „the apply_flag_settings request itself was never answered", and the get_settings that
// follows it may still have answered — so this discards a read-out that was real. The alternative is worse:
// if the apply had not been processed when the read happened, the read describes the state the session is
// about to LEAVE, and adopting it would show a stale value as a measurement. Under-claiming („unbestätigt"
// when we did in fact know) costs one click on the chip, which re-asks; over-claiming cannot be clicked away.
const UC_UNKNOWN = Object.freeze({ state: 'unknown', active: null, requested: null, available: null, reason: '', model: '' });
function ultracodeReadBack(r) {
  return !!(r && !r.unconfirmed && !r.refused && r.ultracode && r.ultracode.state !== 'unknown');
}
function adoptUltracodeState(t, r) {
  if (!t) return false;
  const read = ultracodeReadBack(r);
  t.ucState = read ? r.ultracode : UC_UNKNOWN;
  return read;
}
// Live switch on the running session. The answer is the state that is REALLY in effect: the CLI accepts
// `ultracode:true` on a model that cannot do it and reports success (measured on Haiku 4.5), so the
// server re-reads get_settings and this reports THAT — never the wish.
// `was` is the wish as it stood BEFORE the caller changed it: the server rolls its own
// `chat.meta.ultracodeWish` back when the request never got through (lib/chat.js setChatUltracode), and
// without this the browser would keep a wish the session does not have — the same half-correction, one
// layer up. A failed switch must leave both sides where they were.
async function applyLiveUltracode(t, on, was) {
  try {
    const r = await api('/api/chat/' + t.id + '/ultracode', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: !!on }),
    });
    const read = adoptUltracodeState(t, r);
    // the same read-out carries the level the session is on (null = auto) — adopted here too, so the two
    // live switches cannot leave the strip reporting different truths about the same session. Only when
    // there WAS a read-back: without one, null means „unknown", not „auto".
    if (read) t.effort = (typeof r.effort === 'string') ? r.effort : '';
    if (t === ACTIVE) renderStatusBar();
    if (!read) toast(tt('chat.ultracodeUnbestaetigt'), 'err');
    else if (t.ucState.state === 'on') toast(tt('chat.ultracodeAnGemeldet'), 'ok');
    else if (t.ucState.state === 'ineffective') toast(tt('chat.ultracodeUnwirksam') + ' — ' + ultracodeReasonText(t.ucState), 'err');
    else toast(tt('chat.ultracodeAusGemeldet'), 'ok');
  } catch (e) {
    // nothing was applied, so nothing may be remembered — mirror of the server's own rollback
    if (arguments.length > 2) { t.ultracode = was; if (typeof persistTabs === 'function') persistTabs(); }
    if (t === ACTIVE) renderStatusBar();
    toast(e.message, 'err');
  }
}
// Ask the session what it applied. Called once when `init` arrives — that is the first moment the truth
// exists — and after every live switch.
async function refreshUltracodeState(t) {
  if (!t || !t.id) return;
  try {
    const r = await api('/api/chat/' + t.id + '/settings');
    const read = adoptUltracodeState(t, r.ok ? r : null);
    // The same read-out also carries the level the session is really on, so a tab that was resumed or
    // live-switched stops reporting whatever it was LAUNCHED with. Only a level that is actually THERE and
    // is one the CLI knows, though — and that restriction is not pedantry:
    // UNMEASURED FACT — nobody has ever checked what `applied.effort` reports in the moments right after a
    // spawn, and this runs on every `init`. If it answers null before the launch flag has settled, the old
    // unconditional `t.effort = … : ''` turned a `--effort high` session into „auto" in the UI on the
    // strength of a value nobody has verified. A null is therefore left alone: an ambiguous answer may not
    // overwrite a value we know (the launch flag). The two live switches below/above are different — there
    // the user just asked for a level, so a null read-back genuinely means „back to auto".
    if (read && r.effort && LIVE_EFFORT_LEVELS.includes(r.effort)) t.effort = r.effort;
    if (t === ACTIVE && typeof renderStatusBar === 'function') renderStatusBar();
  } catch (e) {
    // The hardest failure must not be the quietest one. api() throws on every non-2xx, and this route
    // answers 409 both for a chat that is no longer alive AND for a get_settings that failed — so a silent
    // catch left the chip showing whatever it last knew, with no hint that the session had stopped
    // answering. An unread state is UNKNOWN; say so, and keep the toast for the case where the route is
    // simply absent (an older server), which is the one failure that genuinely needs no attention.
    adoptUltracodeState(t, null);
    if (t === ACTIVE && typeof renderStatusBar === 'function') renderStatusBar();
    if (e && e.status && e.status !== 404) logEvent(tt('chat.ultracodeZustandUnlesbar') + (e.message || ''), 'warn');
  }
}

// Resolve once a dormant tab's in-flight resume settles (so a mid-resume send doesn't fork a 2nd process).
// Awaits the ACTUAL promise (`_resumeChain`, fed by both restartResume and resumeDormant) instead of polling a
// flag every 40 ms — which cost up to a 40 ms delay on a resume that had already finished. The timeout keeps
// the old never-hang guarantee for the pathological case where a chain never settles.
function whenResumeSettled(t) {
  if (!t || !t._resuming) return Promise.resolve();
  const guard = new Promise((res) => setTimeout(res, 8000));
  return Promise.race([Promise.resolve(t._resumeChain).catch(() => {}), guard]);
}

function activateTab(t) {
  const prevActive = ACTIVE, sc = $('#chatScroll');
  const wasActive = prevActive === t; // re-activating the same tab must NOT rebuild the tab bar (breaks dblclick-rename)
  if (prevActive && prevActive !== t && sc) prevActive._scrollTop = sc.scrollTop;
  if (prevActive && prevActive !== t && typeof stopVoiceInput === 'function') stopVoiceInput(); // a dictation belongs to its tab
  if (prevActive && prevActive !== t) prevActive.draft = $('#composerInput').value; // per-tab composer draft (was global → bled across tabs)
  ACTIVE = t; chat = t;
  t._newSinceActive = false; // the tab is being watched again → a later unwatched period gets a fresh divider (M1)
  if (t.unread) { t.unread = null; updateTitleBadge(); }
  TABS.forEach((x) => x.msgEl.classList.toggle('hidden', x !== t));
  // background tabs skip live stream rendering — catch this one up on its raw buffer
  if (t.streaming && t.current && t.current.textEl && t.current.textEl._raw != null) renderStreamEl(t.current.textEl);
  $('#chatEmpty').classList.toggle('hidden', t.msgEl.childElementCount > 0 || !!t.id);
  // reconcile the SINGLE global composer lock to THIS tab — locked only while THIS tab is mid-resume, so switching
  // away from a resuming background tab no longer leaves the active tab's composer disabled (#26, regression fix)
  if (typeof setComposerEnabled === 'function') setComposerEnabled(!t._resuming);
  $('#sendBtn').disabled = t.streaming || !!t._resuming;
  $('#interruptBtn').classList.toggle('hidden', !tabCanStop(t)); // a held gate is stoppable work too (FLOW-3)
  refreshSessionChip(t);
  CWD_EDIT = false; updateCwdRowVisibility(); // a tab switch always leaves the cwd editor
  $('#cwdInput').value = t.cwd || (STATE && (STATE.defaultCwd || STATE.home)) || ''; // always set (was leaking the previous tab's cwd)
  if (!wasActive) { $('#composerInput').value = t.draft || ''; try { autoGrow(); } catch { /* `composer` const not yet initialized on the very first activateTab (load) */ } } // restore this tab's draft
  if (typeof renderAttachChips === 'function') renderAttachChips(); // attachments are per tab now (C8)
  if (typeof renderQueueStrip === 'function') renderQueueStrip();   // …and so is the queue strip (C2)
  if (typeof chatSideRefresh === 'function') chatSideRefresh();     // …and the approvals rail shows only THIS tab's cards
  syncRunSelectors(t);
  if (typeof refreshDefaultsPin === 'function') refreshDefaultsPin();
  // A5 — the per-model effort verdict belongs to the TAB, not to the dropdown: the <option> list is one
  // shared element, so after a switch it would still carry the previous tab's model's disabled options.
  if (typeof applyEffortLevelsForModel === 'function') applyEffortLevelsForModel();
  if (t.streaming) startTurnStatus(); else stopTurnStatus();
  if (!wasActive) { keepTabFocus(); renderTabs(); } // skip the innerHTML teardown when clicking the already-active tab
  if (typeof retargetFollowObserver === 'function') retargetFollowObserver(); // auto-follow watches only THIS tab (P2)
  renderSteps();
  renderAgentStrip();
  renderTodoStrip(); // reflect this tab's task list on switch (ToDo 05)
  // context gauge is a single shared element → re-apply THIS tab's context on switch. Unconditionally
  // (CTX-3): a tab without a number yet still shows the line, saying „wird gemessen…" — the old
  // „0 Tokens → hide" branch is how a freshly switched-to tab silently lost its context read-out.
  if (typeof updateCtxGauge === 'function') updateCtxGauge(t);
  if (sc) { if (t._scrollTop != null) sc.scrollTop = t._scrollTop; else sc.scrollTop = sc.scrollHeight; }
  updateScrollBtn();
  // lazily resume a restored tab — but not one another tab or window holds (CHAT-FLOW-4): its card offers the
  // takeover, and re-asking on every click of the tab would tear its transcript down for the same 409 again.
  // Both states, refused AND taken over: a taken-over tab can carry `pending` too (healDeadChat, a send that
  // found its chat gone), and resuming it here would trade its transcript for the „woanders offen" card.
  if (t.pending && !t.id && !t._resuming && !tabHeldElsewhere(t)) resumeDormant(t);
}
// Reflect a started (or explicitly configured) tab's model/mode/effort in the top selectors; an untouched
// unstarted tab shows the global defaults (C10 — a pre-start pick used to be lost on the next tab switch). The
// model value may be one the menu does not list (adopted from a typed /model, an old pinned id) — the <select>
// would show nothing for it, so it gets an option first (ensureModelOption, labelled without a provenance: this
// path does not know where the value came from). Its own function so a test can run it with a fake DOM.
function syncRunSelectors(t) {
  if (t.id || t.cfgTouched) { $('#permMode').value = t.permissionMode || 'plan'; ensureModelOption(t.modelSel); $('#modelSel').value = t.modelSel || ''; $('#effortSel').value = t.effort || ''; }
  else if (typeof applyChatDefaults === 'function') applyChatDefaults();
}
function newTab() { const t = makeTab(); activateTab(t); $('#composerInput').focus(); return t; }
// P-0 — a tab that is still EMPTY in every sense a start reads: no session (live, dormant or on its way), no
// transcript, and no launch value anybody set. resumeSession (sessions.js) reuses only such a tab. It reused
// every tab without an id and without rows, and the start body takes the roots, agent, MCP scope, guardrails
// and the rest off the tab (chat-events.js startChat) — so resuming a foreign session there quietly ran it
// with what had been set up for something else. `projectId` counts too: it is sent with the start (J1).
// J10 — so does a folder of its OWN (openCwdEditor sets it on an unstarted tab): reused, it carried that folder's
// CLAUDE.md, memory and session folder into a session meant for another. The main folder in any spelling is none.
// Strict on purpose where it costs one extra tab: a mere pick in the model/mode/effort selector (cfgTouched)
// already counts, so the session opens next to that tab instead of inheriting the pick. And a pasted
// attachment counts too, although it is no launch value: it rides along with the NEXT message — into the
// foreign session, if the tab were reused (found in the P-0 cross-check). The draft does not: it stands in
// the very input the user types into next, and it stays with its tab either way.
function tabCwdIsMain(cwd) {
  const main = (typeof STATE !== 'undefined' && STATE && (STATE.defaultCwd || STATE.home)) || '';
  const key = (p) => (typeof projectPathKey === 'function' ? projectPathKey(p) : String(p || '').trim().toLowerCase());
  return !!main && key(cwd) === key(main);
}
function tabUntouched(t) {
  if (!t) return false;
  if (t.id || t.sessionId || t.pending || t._starting || t._resuming) return false;
  if (t.msgEl && t.msgEl.childElementCount) return false;
  if (t.attachments && t.attachments.length) return false;
  if (t.cfgTouched || t.mcpServers !== undefined || t.projectId !== undefined) return false;
  if ((t.addDirs && t.addDirs.length) || t.agent || t.worktree || t.maxBudgetUsd || t.guardrails) return false;
  if (t.cwd && !tabCwdIsMain(t.cwd)) return false;
  if ((t.subagents && Object.keys(t.subagents).length) || t.ultracode === true || t.ultracode === false) return false;
  return true;
}
function reopenClosedTab() {
  const info = CLOSED_TABS.pop();
  if (!info) { toast(tt('chat.keinZuletztGeschlossenerTab'), 'err'); return; }
  const t = makeTab({ title: info.title });
  t.title = info.title; t.cwd = info.cwd || null; t.manualTitle = !!info.manualTitle;
  t.defaultTitle = info.def !== false ? true : false;
  t.pending = { sessionId: info.sessionId, cwd: info.cwd };
  activateTab(t); // triggers resumeDormant
}
// A session reference for the transcript APIs. Prefer the record the SERVER sent (it carries the encoded
// `project` folder and the real projectPath); only synthesise one from the cwd when the sessions list doesn't
// know this id yet. Was copy-pasted in resumeDormant, _restartResumeNow and openResumeInChat.
function sessionRefFor(id, cwd) {
  const known = (SESSIONS || []).find((x) => x.id === id);
  if (known) return known;
  return { id, project: String(cwd || '').replace(/[:\\/]/g, '-'), projectPath: cwd };
}
// persist open sessions so tabs survive a reload. `held` = { list, alive }: only from tabsBoot, which holds the
// cc_tabs lock already and must write its adoption before letting go of it.
function persistTabs(held) {
  // include DORMANT tabs (restored-but-not-yet-resumed): their id lives in t.pending, not t.sessionId yet.
  // Filtering on t.sessionId alone dropped un-clicked tabs on the next persist → they vanished on restart.
  try {
    const out = TABS.map((t) => {
      const sessionId = t.sessionId || (t.pending && t.pending.sessionId);
      if (!sessionId) return null;
      // draft rides along with its OWN tab (C8) — one global cc_draft key meant every tab showed the
      // last-typed text after a reload. Capped so a pasted wall of text can't blow the 5 MB quota.
      const draft = String((t === ACTIVE ? ($('#composerInput') ? $('#composerInput').value : t.draft) : t.draft) || '').slice(0, 8000);
      // addDirs/maxBudgetUsd (A15/A3) are launch flags — they only apply to a NEW start, but they must
      // survive a reload, otherwise a restored tab silently starts without the roots or the cap you set.
      return { sessionId, title: t.title, cwd: t.cwd || (t.pending && t.pending.cwd) || null, manualTitle: t.manualTitle, def: t.defaultTitle !== false, draft, hue: t.hue, hueManual: !!t.hueManual, addDirs: (t.addDirs && t.addDirs.length) ? t.addDirs : undefined, maxBudgetUsd: t.maxBudgetUsd || undefined, guardrails: t.guardrails || undefined, subagents: (t.subagents && Object.keys(t.subagents).length) ? t.subagents : undefined,
        // Ultracode is a THREE-state field (true / false / inherit the global default), so it is stored
        // as-is rather than „only when truthy" — a tab that deliberately turned it OFF against a global
        // ON must not come back inheriting.
        ultracode: (t.ultracode === true || t.ultracode === false) ? t.ultracode : undefined,
        // the window THIS session reported. Not saved before, so a reload dropped back to the name table —
        // which has no entry at all for a model it has never seen, and read 200 000 for a running 1M
        // session before that. Saved as {variante, fenster}: the number TOGETHER with the variant key it
        // was measured for, because a bare number cannot say which variant it belongs to and the two
        // variants of one model have different windows — a restore onto another variant discards it
        // instead of showing it (CTX-3).
        // `_ctxWindowSaved` is a restore that has not been adopted YET, because the model menu was not
        // loaded when the tab came back (ctxAdoptSavedWindow). It is persisted unchanged, otherwise any
        // persist in that window — one keystroke in a draft — would be what finally deletes it.
        ctxWindow: ctxWindowSave(t.ctxReported) || t._ctxWindowSaved || undefined,
        modelSel: t.modelSel || undefined,
        // P-0 — the other two launch values of the selectors, so a reload resumes in the mode and at the
        // effort the tab was in (restoreTabs → tabRestoreLaunch). Written only for a tab that KNOWS its mode
        // (every started tab does): the key's presence is how restoreTabs tells this format from an older
        // entry, and a dormant tab restored from such an entry must not turn into an empty „new" one.
        ...(t.permissionMode ? { permissionMode: t.permissionMode, effort: t.effort || '' } : {}),
        // C2/C3 — launch flags, same reasoning as addDirs: a restored tab that silently starts without
        // its agent (or outside its worktree) is worse than one that asks.
        agent: t.agent || undefined, worktree: t.worktree || undefined,
        // J7 — the tab's project and the project state its process started with („geändert seit Start"). Not the
        // NAME: after a reload it comes from the project list, so a deleted project says so instead of its old name.
        projectId: typeof t.projectId === 'string' ? t.projectId : undefined,
        projectAt: typeof t._projectAt === 'number' ? t._projectAt : undefined,
        // PF-1 — the plan's progress, compact (planSave: steps, state, current step — never the plan text,
        // which can be 600 KB; after a reload [Plan öffnen] reads the plan file instead). Without it a reload
        // in the middle of a plan dropped the rail back to nothing until the model happened to report again.
        plan: (t.plan && typeof planSave === 'function') ? (planSave(t.plan) || undefined) : undefined,
        // PF-1b — the orphan under a plan underway (its card's ▶) and the newest proposal's name: a reload whose resume
        // fails still has them, and the resume's fold says the same (planAdoptResumed)
        planOrphan: (t._planOrphan && typeof planSave === 'function') ? (planSave(t._planOrphan) || undefined) : undefined,
        planLast: t._planLast || undefined,
        // the plan whose list was already asked for by itself (chat-side.js planAutoAskSteps) — once per plan, also across a reload
        planAutoAsked: t._planAutoAsked || undefined };
    }).filter(Boolean);
    // remember which tab was active so restore lands on it (not always the first)
    const act = ACTIVE && (ACTIVE.sessionId || (ACTIVE.pending && ACTIVE.pending.sessionId));
    tabsStore(out, act, held);
  } catch {}
}
// CHAT-FLOW-4 part B — this window's place in cc_tabs (the rules: tab-windows.js). `win` = its id once it holds
// its window lock; null = the fallback without Web Locks, which writes the whole list as before. `booting` = the
// boot has not decided yet what it restores: a write then would replace the own group with the one empty boot tab
// — on a reload exactly the tabs about to come back — so it waits, and the boot writes once it decided. It starts
// TRUE wherever Web Locks exist, not only once tabsBoot runs: boot.js waits for /api/state first, and a write in
// that wait (a keystroke in the draft, 300 + 500 ms later) found no id yet and took the fallback — the whole list
// replaced by the boot tab's nothing, every other window's group gone with it. tabsBoot's fallback clears it.
// `reclaim` = twReclaim's promise (tabsReclaim, one per document); `queued`/`next` coalesce the writes of one
// window into one lock request; `warned` = the „not saved" toast is out.
const TABWIN = { win: null, kind: '', reclaim: null, booting: typeof navigator !== 'undefined' && !!navigator && !!navigator.locks, queued: false, next: null, warned: false };
function tabsStore(out, act, held) {
  if (held && Array.isArray(held.list)) { tabsWrite(held.list, out, act, held.alive); return; }
  if (TABWIN.booting) return;
  // the fallback (no navigator.locks): one list for every window, as before part B — part A keeps two windows on
  // one session from ending each other, and that is all there is without a way to tell who is alive
  if (!TABWIN.win) { if (!tabsSetItems(out, act)) tabsWarnUnsaved(); return; }
  TABWIN.next = { out, act };
  if (TABWIN.queued) return; // the request in the queue writes the newest snapshot when it gets the lock
  TABWIN.queued = true;
  // Who is alive is asked BEFORE the lock, so the locked section is synchronous and holds cc_tabs for one task.
  // Asked inside, the section spanned two tasks — and a background window the browser freezes in between (Edge
  // sleeping tabs) sat on cc_tabs: every other window's boot and write waited for it to thaw. A list a moment
  // old is enough here: it only decides which ORPHANED groups the bounds may drop, a window that started since
  // has the youngest group of all (dropped last by the bounds — but not spared by tabsWrite's retry without any
  // orphaned group, after a refused setItem: it is then missing until its own next write), and one that died
  // since is merely kept one write longer.
  // The boot asks inside (tabsBoot): there the answer decides what it adopts, and it runs in a window in front.
  twAlive(navigator.locks).then((alive) => navigator.locks.request(TW_STORE_LOCK, () => {
    const n = TABWIN.next; TABWIN.next = null; TABWIN.queued = false;
    if (n) tabsWrite(tabsRead(), n.out, n.act, alive); // READ under the lock: what the other windows wrote last
  })).catch((e) => { TABWIN.queued = false; console.warn('persist tabs failed', e); });
}
function tabsRead() {
  let list; try { list = JSON.parse(localStorage.getItem('cc_tabs') || '[]'); } catch { list = []; }
  return Array.isArray(list) ? list : [];
}
// merge + write. A full localStorage throws on setItem — the catch in persistTabs used to swallow that, and every
// later write failed the same way: tab persistence off, without a word. So: once more without any orphaned group
// (the oldest windows' leftovers are the cheapest to lose), and if that fails too, say so once.
function tabsWrite(list, out, act, alive) {
  const now = Date.now();
  const m = twMerge(list, out, { win: TABWIN.win, now, alive, active: act });
  if (tabsSetItems(m.list, act)) return;
  const lean = twMerge(list, out, { win: TABWIN.win, now, alive, active: act, maxOrphanGroups: 0 });
  if (!tabsSetItems(lean.list, act)) tabsWarnUnsaved();
}
// cc_tabs as an ARRAY and cc_tabs_active as before: an older panel reads both (part B, decision 10)
function tabsSetItems(list, act) {
  try {
    localStorage.setItem('cc_tabs', JSON.stringify(list));
    if (act) localStorage.setItem('cc_tabs_active', act); else localStorage.removeItem('cc_tabs_active');
    return true;
  } catch { return false; }
}
function tabsWarnUnsaved() {
  if (TABWIN.warned) return;
  TABWIN.warned = true;
  toast(tt('chat.tabsNichtGespeichert'), 'warn');
}
// The composer draft of a window that restores no tab — which one, tab-windows.js twBootDraft decides (its own on
// a reload, the global cc_draft only for a first window). Only into an EMPTY composer: on the async boot the user
// may have typed already.
function tabsBootDraft(o) {
  try {
    const d = twBootDraft(Object.assign({ local: localStorage }, o));
    const c = $('#composerInput');
    if (d && c && !c.value) { c.value = d; autoGrow(); }
  } catch { /* storage or composer not ready */ }
}
// navigator.locks when it can do what part B asks of it (request + query), else null: tabsBoot's fallback
function tabsLocks() {
  return (typeof navigator !== 'undefined' && navigator && navigator.locks && typeof navigator.locks.request === 'function' && typeof navigator.locks.query === 'function') ? navigator.locks : null;
}
// Take back the id this window had before (twReclaim) — called by boot.js BEFORE it waits for /api/state, and
// awaited by tabsBoot after it. Until a reloading window holds its window lock again it counts as closed, and a
// window that started in that gap (start.cmd opening a tab while this one reloads) adopted its tabs as orphaned:
// the reload came back empty. Asked here, the gap is the page load alone, not the page load plus /api/state; a
// duplicate's grace runs while /api/state is under way. → the one promise of this document, or null where the
// fallback applies (no Web Locks, no sessionStorage).
function tabsReclaim() {
  if (TABWIN.reclaim) return TABWIN.reclaim;
  const locks = tabsLocks();
  let session = null; try { session = sessionStorage; } catch { session = null; }
  if (!locks || !session) return null;
  TABWIN.reclaim = twReclaim({ locks, session, setTimeout });
  TABWIN.reclaim.catch(() => { /* tabsBoot awaits the same promise and falls back */ });
  return TABWIN.reclaim;
}
// Boot: which tabs this window restores (CHAT-FLOW-4 part B). Without navigator.locks (or sessionStorage) the
// deliberate fallback: everything stored, synchronously, as before. With them:
//  1. take back the id of this window (tabsReclaim: a reload keeps it, a duplicate gets a new one);
//  2. under the cc_tabs lock: who is alive, what is stored, what to restore (twPick) — a fresh window takes its
//     id only now, AFTER it looked, so two windows booting together do not each see the other and adopt nothing;
//  3. restore into the boot tab only while it is untouched — a click in the empty tab meanwhile (a message sent,
//     a session opened from the list or the palette, a second tab) wins: then an orphaned group stays for a later
//     window and the own group is left behind as one, instead of being overwritten into the tab the user is
//     working in, or erased by the next write. Text merely TYPED meanwhile is no such click: restoreTabs keeps it;
//  4. write the result — an adopted group re-stamped as this window's (twRetag) — BEFORE the lock is let go: a
//     later write reads the store afresh, and without the re-stamp the group stood twice, adopted here and still
//     orphaned under its old id, for the next first window to restore a second time (S8).
// → true when tabs were restored; „Letzte Sitzung" is offered otherwise (only now — it is not there to click
// while the boot waits).
async function tabsBoot() {
  const locks = tabsLocks();
  let session = null; try { session = sessionStorage; } catch { session = null; }
  // without window ids no window can be told from another: each is a first one, the global draft as before —
  // into the composer only when nothing was restored (restoreTabs reads what the composer holds as typed)
  if (!locks || !session) {
    TABWIN.booting = false;
    const ok = restoreTabs();
    if (!ok) { tabsBootDraft({ kind: 'fresh', others: [] }); offerLastSession(); }
    return ok;
  }
  TABWIN.booting = true;
  let restored = false, decided = false;
  try {
    const re = await tabsReclaim();
    TABWIN.kind = re.kind;
    // A duplicate's sessionStorage is a COPY of the original's, the original's window draft included, and its first
    // reload read that copy as its own (twBootDraft) — the text typed in the other window, one reload late. From
    // here on it is what this window's composer holds: empty, unless typed during the grace.
    if (re.kind === 'duplicate') {
      try { const v = $('#composerInput').value; if (v) session.setItem(TW_DRAFT_KEY, v); else session.removeItem(TW_DRAFT_KEY); } catch { /* the copy stays */ }
    }
    await locks.request(TW_STORE_LOCK, async () => {
      const alive = await twAlive(locks);
      if (re.win) TABWIN.win = re.win;
      else {
        const id = twNewId();
        if (!(await twHold(locks, id))) throw new Error('window lock ' + id + ' not granted');
        twRemember(session, id);
        TABWIN.win = id;
      }
      const others = alive ? alive.filter((w) => w !== TABWIN.win) : null;
      let list = tabsRead();
      const pick = twPick(list, { win: TABWIN.win, others, kind: re.kind });
      TABWIN.booting = false; decided = true;
      if (pick.entries.length) {
        if (TABS.length === 1 && tabUntouched(TABS[0])) {
          if (!pick.own) list = twRetag(list, pick.group, TABWIN.win);
          restored = restoreTabs(pick.entries);
        } else if (pick.own) list = twRetag(list, TABWIN.win, twNewId());
      }
      persistTabs({ list, alive });
      if (!restored) {
        // the global draft is the LAST typing of any window: a reload gets its own, a second window none
        tabsBootDraft({ kind: re.kind, others, session });
        offerLastSession();
      }
    });
  } catch (e) {
    console.warn('tab windows: boot fell back', e);
    TABWIN.booting = false;
    // without an id of its own the window cannot tell its tabs from the others': the fallback, as without locks —
    // and it stays in it, every write replacing the whole list unstamped, live windows' groups included (a lock
    // manager that refuses at boot; rare, and said so in the README)
    if (!decided) {
      if (!TABWIN.win) { restored = restoreTabs(); if (!restored) tabsBootDraft({ kind: 'fresh', others: [] }); }
      if (!restored) offerLastSession();
    }
  }
  return restored;
}
// localStorage.setItem is synchronous and JSON.stringify of the tab list isn't free; the draft path used to
// call persistTabs on a 300 ms keystroke debounce and every tab action calls it too. Coalesce (P6).
const persistTabsSoon = debounce(persistTabs, 500);
// P-0 — the launch values a reload brings back: the permission mode and the effort. null = an entry written
// before P-0 (no mode stored), which restores exactly as it always did — global defaults. localStorage is not
// this file's to trust, so an unknown value falls back like a missing one. bypassPermissions is NEVER brought
// back, and it is not in the list for that reason: a reload is not a decision to run without asking. Before P-0
// it could not come back either (nothing was saved), so the tab starts in the default mode instead and
// `bypassDropped` lets restoreTabs say so.
// R3 — not even when the remembered DEFAULT is bypassPermissions (Julian, 05.10.: „nie automatisch Bypass"). The
// first cut let the default through as „the user's own standing choice", but the default is what every NEW tab
// starts in; a reload brings back tabs that were already running, and none of them was just chosen. So the
// fallback itself is filtered: a default outside the list — bypass, or anything localStorage made up — restores
// as the „default" mode (◑ Standard · fragt nach), and bypass is only ever entered by hand, in the tab.
const TAB_RESTORE_MODES = ['plan', 'manual', 'default', 'auto', 'acceptEdits', 'dontAsk'];
const TAB_RESTORE_SAFE_MODE = 'default';
function tabRestoreFallback(defaults) {
  const d = (defaults && defaults.permMode) || 'plan';
  return TAB_RESTORE_MODES.includes(d) ? d : TAB_RESTORE_SAFE_MODE;
}
function tabRestoreLaunch(info, defaults) {
  if (!info || typeof info.permissionMode !== 'string' || !info.permissionMode) return null;
  const fallback = tabRestoreFallback(defaults);
  const permissionMode = TAB_RESTORE_MODES.includes(info.permissionMode) ? info.permissionMode : fallback;
  const effort = (typeof info.effort === 'string' && LIVE_EFFORT_LEVELS.includes(info.effort)) ? info.effort : '';
  return { permissionMode, effort, bypassDropped: info.permissionMode === 'bypassPermissions' && permissionMode !== 'bypassPermissions' };
}
// `entries` = what tabsBoot picked for THIS window (tab-windows.js twPick); without it — the fallback without Web
// Locks — everything stored, as before part B.
function restoreTabs(entries) {
  let list = entries;
  if (!Array.isArray(list)) { try { list = JSON.parse(localStorage.getItem('cc_tabs') || '[]'); } catch { list = []; } }
  if (!Array.isArray(list) || !list.length) return false;
  // What the composer holds when the restore lands was TYPED while the boot waited — for /api/state, and since
  // part B for the locks too (up to TW_GRACE_MS when a reload's old document lets go late): nothing else puts
  // text there first (tabsBoot fills a draft only when nothing was restored). The restore swapped it for the
  // restored tab's draft, and it was gone without a trace; it is kept below.
  const typed = ($('#composerInput') || {}).value || '';
  let made = 0;
  const bypassDropped = [];
  list.forEach((info) => {
    // per-item guard: one malformed/throwing entry must not abort the rest of the restore (→ dropped tabs)
    try {
      const t = made === 0 ? TABS[0] : makeTab({ title: info.title });
      t.title = info.title || tt('html.sitzung'); t.cwd = info.cwd || null; t.manualTitle = !!info.manualTitle;
      t.defaultTitle = info.def !== false ? true : false; // whether an auto title may still replace this one
      t.draft = info.draft || ''; // per-tab draft (C8)
      if (info.hue != null) { t.hue = info.hue; t.hueManual = !!info.hueManual; }
      if (Array.isArray(info.addDirs)) t.addDirs = info.addDirs;
      if (info.maxBudgetUsd) t.maxBudgetUsd = info.maxBudgetUsd;
      if (info.guardrails) t.guardrails = info.guardrails; // D1 — a restored tab keeps its constraints
      if (info.subagents && typeof info.subagents === 'object') t.subagents = info.subagents; // #34 — …and its subagent policy
      if (info.ultracode === true || info.ultracode === false) t.ultracode = info.ultracode;  // …and its ultracode choice (3-state)
      // …the model variant it ran on (the only string that still says „[1m]", so the window guess and the
      // menu label have something to go on before the first start) …
      if (info.modelSel) t.modelSel = String(info.modelSel);
      // P-0 — …the mode and the effort it ran in, and the mark that this tab HAS its own launch values: without
      // cfgTouched activateTab paints the global defaults into the selectors, and the dormant resume reads them
      // from there — so a reload always fell back to the defaults (and overwrote the restored model with them).
      // Only for entries in the new format (tabRestoreLaunch): an older one behaves as it did.
      const launch = tabRestoreLaunch(info, CHAT_DEFAULTS);
      if (launch) {
        t.permissionMode = launch.permissionMode; t.effort = launch.effort; t.cfgTouched = true;
        if (launch.bypassDropped) bypassDropped.push(t.title);
      } else if (tabRestoreFallback(CHAT_DEFAULTS) !== ((CHAT_DEFAULTS && CHAT_DEFAULTS.permMode) || 'plan')) {
        // R3 — an entry from before P-0 has no mode of its own and used to take the defaults wholesale
        // (activateTab → applyChatDefaults) — bypass included, when that is the default. It keeps everything
        // else of the defaults, so it still behaves as it did, and only the mode is the safe one: pinned here,
        // because activateTab paints the defaults into the selector for every tab WITHOUT cfgTouched.
        t.permissionMode = tabRestoreFallback(CHAT_DEFAULTS);
        t.effort = (CHAT_DEFAULTS && CHAT_DEFAULTS.effort) || '';
        if (!t.modelSel) t.modelSel = (CHAT_DEFAULTS && CHAT_DEFAULTS.model) || '';
        t.cfgTouched = true;
        bypassDropped.push(t.title);
      }
      // …and the window its own turns measured — but only when it was measured for THIS variant, which is
      // resolved the same way the gauge resolves it (ctxResolveModel). Deliberately NOT decided here: this
      // function runs at boot BEFORE loadModels() has answered, so `modelResolves` returned '' for every
      // entry and the key came out wrong for exactly the two selections that matter — a „Default" tab got
      // the empty key (nothing restores) and an alias tab („opus[1m]") got the key „opus[1m]" instead of the
      // „claude-opus-5[1m]" the number was FILED under. Both were then silently dropped on every reload, and
      // the gauge fell back to the name table — the one source that paints 200 000 over a 1M session. So the
      // raw value is kept and adopted once the menu can resolve it (ctxAdoptSavedWindow, called again from
      // loadModels); a legacy entry (a bare number, or the raw selector value) still dies there.
      t._ctxWindowSaved = info.ctxWindow || null;
      ctxAdoptSavedWindow(t);
      if (info.agent) t.agent = String(info.agent);     // C2/C3 — …and its session agent + worktree wish
      if (info.worktree) t.worktree = info.worktree === true ? true : String(info.worktree);
      // J7 — …and its project. Shown from the project list; the resume's answer (projectAdoptStart) then says what
      // the session really runs with, and a project deleted meanwhile falls away there.
      if (typeof info.projectId === 'string') { t.projectId = info.projectId; t._projectRun = info.projectId; if (typeof info.projectAt === 'number') t._projectAt = info.projectAt; }
      // …and its plan. planRestore (inside planAdopt) re-forces every field: localStorage is not this file's to
      // trust, and a shape it cannot read comes back as null (no plan) rather than as a half-plan in the rail. A
      // proposal comes back ORPHANED, as from a resume (PF-1b; it used to come back superseded): the restored tab is
      // dormant, its gate went with the process of the page that was reloaded — so it says „Plan liegt vor", and ▶
      // Plan starten begins it by message even if the resume fails and nothing else would ever correct it.
      if (info.plan && typeof planAdopt === 'function') t.plan = planAdopt(null, info.plan);
      // …and the orphan under it and the newest proposal's name (PF-1b), by the same rules (forced, orphaned)
      if (info.planOrphan && typeof planAdoptOrphan === 'function' && typeof planOrphanSet === 'function') planOrphanSet(t, planAdoptOrphan(null, info.planOrphan));
      if (info.planLast && typeof planLastRestore === 'function') t._planLast = planLastRestore(info.planLast);
      if (typeof info.planAutoAsked === 'string' && info.planAutoAsked.length <= 200) t._planAutoAsked = info.planAutoAsked;

      t.pending = { sessionId: info.sessionId, cwd: info.cwd };
      // dormant hint on every restored tab; the one we auto-activate has it replaced by real history
      t.msgEl.appendChild(el('div', 'history-note', '▶ „' + t.title + tt('chat.tabAnklickenZumFortsetzen')));
      made++;
    } catch (e) { console.warn('restore tab failed', e); }
  });
  if (!made) return false;
  // the ◆ chip names its project only once the list is loaded (until then „…", never a guess)
  if (typeof ensureProjects === 'function' && TABS.some((x) => x.projectId)) ensureProjects().then(() => { if (typeof renderStatusBar === 'function') renderStatusBar(); });
  // one toast for all of them, naming the mode they start in instead — a silent downgrade would leave the user
  // waiting on a tab that now asks before every tool. 'warn', not 'err': a heads-up times out like every
  // non-error (render.js toast, B15) and stays in the 🔔 log; the mode selector says the rest.
  // Both placeholders in ONE pass with a function: tab titles are the user's text, and a string replacement
  // expands `$&`/`$'` in it — and a title containing „{m}" would otherwise catch the second replace.
  if (bypassDropped.length) {
    const fill = { t: bypassDropped.join(', '), m: modeInfo(tabRestoreFallback(CHAT_DEFAULTS)).label }; // the mode it REALLY starts in (R3)
    toast(tt('chat.bypassNichtWiederhergestellt').replace(/\{([tm])\}/g, (_, k) => fill[k]), 'warn');
  }
  // re-activate the previously-active tab (fall back to the first restored one) — the group's own `active` mark;
  // the global cc_tabs_active is the LAST writing window's and is read for an unstamped (legacy) list only
  let act = null; try { act = localStorage.getItem('cc_tabs_active'); } catch {}
  act = twActiveSession(list, act);
  const target = (act && TABS.find((t) => (t.sessionId || (t.pending && t.pending.sessionId)) === act)) || TABS[0];
  // activateTab saves the composer into the tab it LEAVES — here the reused boot tab, i.e. the first restored one.
  // With another tab active, its restored draft was overwritten by what the composer held at boot (the global
  // cc_draft, or nothing): a reload lost the first tab's draft whenever it was not the active one (part B, S7).
  // So the composer holds that tab's own draft when it is left.
  const comp = $('#composerInput');
  if (comp && target !== ACTIVE && ACTIVE === TABS[0] && ACTIVE.draft != null) comp.value = ACTIVE.draft;
  activateTab(target); // only this tab auto-resumes; the rest stay dormant (click to resume)
  // activateTab skips the draft restore when the target is ALREADY the active tab (TABS[0] on boot), so apply
  // it here — otherwise the reload showed the global cc_draft (then boot.js's) on whatever tab happened to be first (C8).
  if (target.draft != null) { $('#composerInput').value = target.draft; try { autoGrow(); } catch { /* composer const not ready */ } }
  // …and what was typed meanwhile goes into that tab, behind its restored draft: neither is lost, and the text the
  // user is typing stays in view, with the caret behind it (setting the value puts it at the end)
  if (typed && target.draft !== typed) {
    target.draft = target.draft ? target.draft + '\n\n' + typed : typed;
    $('#composerInput').value = target.draft; try { autoGrow(); } catch { /* composer const not ready */ }
  }
  // …and for the same reason paint the bar explicitly: makeTab() doesn't touch it, and activateTab skips
  // renderTabs when the target is already active (the boot tab we reused above). It usually self-healed on
  // the resumed session's `init` event — but after a long idle the server has reaped that session, the
  // resume 404s, no init arrives, and the bar kept showing the single boot tab while TABS held all of them.
  // Clicking "+" then made them "reappear". (Bug report 2026-08-28)
  renderTabs();
  return true;
}
// wrapper so the in-flight resume is always awaitable via tab._resumeChain (whenResumeSettled)
function resumeDormant(t) { t._resumeChain = _resumeDormantNow(t); return t._resumeChain; }
async function _resumeDormantNow(t) {
  t._resuming = true;
  const info = t.pending; t.pending = null;
  // optimistic: we are resuming exactly this session, so claim its id NOW. Otherwise any persistTabs() firing
  // before the async `init` event (which sets sessionId) would write this tab as null and drop it (the bug).
  t.sessionId = info.sessionId;
  t.msgEl.innerHTML = '';
  if (typeof resumeStage === 'function') resumeStage(t, (!SESSIONS || !SESSIONS.length) ? 'sessions' : 'spawn');
  showResumeLoading(t); // spinner over the emptied transcript for the whole in-flight resume (ToDo 01/02)
  if (typeof renderTabs === 'function') renderTabs(); // the tab's spinner
  try {
    if (!SESSIONS || !SESSIONS.length) { try { await loadSessions(); } catch {} }
    if (typeof resumeStage === 'function') resumeStage(t, 'spawn');
    // real session (has the encoded `project`) if known, else SYNTHESISE it from cwd so the transcript
    // ALWAYS repaints. The old else-branch called startChat WITHOUT renderResumeHistory → a session missing
    // from the (not-yet-loaded) SESSIONS cache left the pane permanently blank (the "first of two never loads").
    const s = sessionRefFor(info.sessionId, info.cwd);
    // `model` from the TAB, not from the dropdown. startChat reads the selectors for the active tab, and a dormant
    // tab is not `id || cfgTouched`, so activateTab had put the GLOBAL defaults there — the reload then resumed
    // the visible tab on the default model and overwrote its saved selection with it (a pick made in the dropdown,
    // or one adopted from a typed /model). `extra` wins over the DOM, the same way _restartResumeNow passes it.
    // (The dropdown itself still shows the default until the tab is reactivated: docs/ideas.md P12.)
    await startChat({ resume: s.id, cwd: info.cwd || s.projectPath, model: t.modelSel || undefined }, t); // bind to THIS tab, not whatever is ACTIVE after the awaits
    if (typeof resumeStage === 'function') resumeStage(t, 'history');
    await renderResumeHistory(s, t);
    holdQueueAfterResume(t); // e.g. reconnectIdleTabs after a sleep: a queue that outlived the reap has no `result` coming
  } catch (e) {
    // resume failed (e.g. session gone after a server restart) — keep the tab dormant + persistable, don't prune it
    t.sessionId = null; t.pending = info;
    if (t.msgEl && !t.msgEl.childElementCount) t.msgEl.appendChild(el('div', 'history-note', '▶ „' + t.title + tt('chat.tabAnklickenZumFortsetzen')));
    // CHAT-FLOW-4 — held by another tab or window: not a failure, and startChat has put the card up
    if (!(e && e.code === 'session-open-elsewhere')) toast(tt('chat.tabKonnteNichtFortgesetzt') + e.message, 'err');
  } finally { t._resuming = false; if (typeof resumeFinish === 'function') resumeFinish(t); hideResumeLoading(t); if (t === ACTIVE) setComposerEnabled(true); if (typeof refreshSessionChip === 'function') refreshSessionChip(t); if (typeof renderTabs === 'function') renderTabs(); }
}
// After the laptop wakes / the network returns, a tab whose server-side chat was reaped during sleep points at a
// dead id with a permanently-closed SSE. Proactively resume it instead of leaving it idle+unresumable (ToDo 02/06).
let _reconnecting = false;
function reconnectIdleTabs() {
  if (_reconnecting || !Array.isArray(TABS)) return;
  _reconnecting = true;
  try {
    TABS.forEach((tab) => {
      if (tab._resuming || tab._starting) return; // an in-flight resume/start is left alone
      const sid = tab.sessionId || (tab.pending && tab.pending.sessionId);
      if (!sid) return;
      // dead = we hold a chat id but its SSE has permanently closed (a fatal 404 on reconnect after a reap),
      // or we already flagged it dead in onerror. A transient drop keeps the ES CONNECTING and is left alone.
      // NOTE: a `streaming` tag alone does NOT protect a tab here — a chat wedged at a permission/ask gate is
      // streaming=true but its process may have been reaped during sleep; if its SSE is dead we recover it (#25).
      const closed = !tab.es || tab.es.readyState === 2; // 2 = EventSource.CLOSED
      if (!tab.id || (!closed && !tab._sseDead)) return; // a live SSE (incl. a genuinely-busy streaming tab) → leave it
      if (tab.es) { try { tab.es.close(); } catch {} tab.es = null; }
      tab.id = null; tab._sseDead = false;
      // the reaped turn (possibly wedged at a gate) is over → unwedge: free the composer, drop the stale gate for
      // this tab, and stop the status ticker. The resume brings the TRANSCRIPT back, not the turn: a reaped
      // process has nothing in flight, so no gate is re-emitted and an unanswered one stays unanswered (#25)
      tab.streaming = false;
      if (typeof clearAsksForTab === 'function') clearAsksForTab(tab);
      if (tab === ACTIVE && typeof stopTurnStatus === 'function') stopTurnStatus();
      if (typeof refreshPermJump === 'function') refreshPermJump();
      tab.pending = { sessionId: sid, cwd: tab.cwd };
      if (tab === ACTIVE) { resumeDormant(tab); } // resume the visible tab in place (shows the loader)
      else { // background tab → make it dormant so activating it resumes
        tab.msgEl.innerHTML = '';
        tab.msgEl.appendChild(el('div', 'history-note', '▶ „' + (tab.title || tt('html.sitzung')) + tt('chat.tabAnklickenZumFortsetzen')));
      }
    });
  } finally { _reconnecting = false; }
}
// A permission/ask answer that hit a reaped chat (404/409) → recover the session in place. The stale requestId
// cannot be replayed, and the reaped process had no turn in flight, so NO gate comes back: the answer itself
// is lost, which is why the toast asks you to confirm it again. Returns true if it recognised + handled a
// dead-chat error (so the caller skips the raw error toast). (#25)
function healDeadChat(tab, err) {
  if (!tab || !/chat not found|process not running/i.test(String((err && err.message) || err))) return false;
  const sid = tab.sessionId || (tab.pending && tab.pending.sessionId);
  if (!sid) return false;
  tab.streaming = false; tab.id = null;
  if (typeof clearAsksForTab === 'function') clearAsksForTab(tab);
  if (typeof refreshPermJump === 'function') refreshPermJump();
  if (tab === ACTIVE && typeof stopTurnStatus === 'function') stopTurnStatus();
  // CHAT-FLOW-4 — a chat that is gone because another tab or window TOOK it (the `_superseded` frame got here
  // first) is not dead: a resume here would clear this transcript only to be refused. The card offers the way.
  // Asked BEFORE `pending` is set: a pending taken-over tab is one the next activateTab would resume.
  if (tabHeldElsewhere(tab)) { sessionElsewhereCard(tab); return true; }
  tab.pending = { sessionId: sid, cwd: tab.cwd };
  restartResume(tab, {}).then(() => { holdQueueAfterResume(tab); toast(tt('chat.sitzungWiederhergestelltBitteErneut'), 'ok'); })
    .catch((e2) => { if (!(e2 && e2.code === 'session-open-elsewhere')) toast(String((e2 && e2.message) || e2), 'err'); }); // a 409 has its card (startChat)
  return true;
}
// CHAT-FLOW-4 — a tab whose session another tab or window holds: taken from it (`_superseded`) or refused to
// it (`_elsewhere`). Such a tab has no process of its own and must not get one behind the user's back — every
// automatic resume path asks this first and offers the takeover instead.
function tabHeldElsewhere(t) { return !!(t && (t._superseded || t._elsewhere)); }
// The tab of THIS window that already shows session `id` (live or dormant) — the resume entry points look
// here before they open a second tab on the same session. A fork is not asked: it is a new session.
function findSessionTab(id) { return id ? (TABS.find((t) => (t.sessionId || (t.pending && t.pending.sessionId)) === id) || null) : null; }
// The confirm's sentence for a takeover, from what GET /api/session/open answered (null = could not ask).
// It names a running turn only when the server reported one, and never says „nothing runs there": `busy`
// false does not cover an agent working in the background (lib/chat.js sessionHold). Shared with the UI-skill
// notice (views-uiskills.js uiRunHeldElsewhere), so the two warnings cannot drift apart.
function takeoverQuestion(st) {
  return !st ? 'chat.uebernehmenUngeprueft' : st.busy ? 'chat.uebernehmenTurnLaeuft' : st.starting ? 'chat.uebernehmenStartet' : 'chat.uebernehmenText';
}
// What a send into a held tab ends with when the takeover is declined — the composer keeps the text.
function heldElsewhereError() { const e = new Error(tt('chat.nichtGesendetAnderswo')); e.code = 'session-open-elsewhere'; return e; }
// CHAT-FLOW-4 — take a held tab's session into THIS tab: [Hier übernehmen] / [Zurückholen] on the card, a
// message typed into such a tab, a Sitzungsliste resume that met the 409. It asks the server first
// (GET /api/session/open — the same rule as the 409), so the confirm warns about a turn that is running there
// NOW, not the one the card's 409 saw — and so [Erneut prüfen] (`opts.check`) learns the answer without tearing
// the transcript down. Only a confirmed takeover sends `takeover: true`; a session nobody holds any more is
// resumed the plain way, and if the probe fails (an older server, the server restarting) the confirm says it
// could not check — and [Erneut prüfen], which exists to learn the answer, says so and stops there instead of
// resuming blind (that would tear the transcript down to ask the start route the same question).
// → true once this tab runs the session; false when it does not (declined, still held, refused again — the
//   card says which). The queue is the caller's: a takeover that sends nothing holds it (holdQueueAfterResume),
//   one that is about to send lets it drain behind that message.
async function takeBackTab(tab, opts) {
  const sid = tab && (tab.sessionId || (tab.pending && tab.pending.sessionId));
  if (!sid) return false;
  const check = !!(opts && opts.check);
  let st = null, probeErr = null;
  try { st = await api('/api/session/open?id=' + encodeURIComponent(sid)); } catch (e) { st = null; probeErr = e; }
  let takeover = false;
  if (!st || st.open) {
    if (check && st) { tab._elsewhere = { busy: !!st.busy, starting: !!st.starting }; sessionElsewhereCard(tab); return false; }
    if (check) { toast(tt('chat.pruefenFehlgeschlagen') + String((probeErr && probeErr.message) || probeErr || ''), 'err'); return false; }
    if (!(await uiConfirm(tt(takeoverQuestion(st)), { title: tt('chat.uebernehmenTitel'), danger: true, okLabel: tt('chat.uebernehmenOk') }))) return false;
    takeover = true;
  }
  if (tab.pending) { tab.sessionId = tab.sessionId || tab.pending.sessionId; tab.cwd = tab.cwd || tab.pending.cwd; tab.pending = null; }
  try { await restartResume(tab, takeover ? { takeover: true } : {}); return true; }
  catch (e) { if (e && e.code === 'session-open-elsewhere') return false; throw e; }
}
// CHAT-FLOW-7 follow-up — a resume that SENDS nothing (reconnect after sleep, a dormant tab woken up, the
// dead-chat heal, a tab-menu restart) ends no turn, and the queue only drains on `result`: what survived the
// resume (startChat keeps it) sat there for good with no button, and a deferred restart waited behind it.
// Hold it visibly instead — [Jetzt senden] releases it, a typed message goes out first, × drops entries;
// nothing goes out by itself after a resume. Deliberately NOT in startChat/restartResume: the dead-chat
// recovery inside a flush (deliverText) resumes too, and that queue drains on the next `result` as usual.
// 'resume' is truthy wherever queuePaused is read as a flag; only the strip's wording looks at the reason.
function holdQueueAfterResume(tab) {
  if (!tab || !tab.queue || !tab.queue.length || tab.queuePaused) return;
  tab.queuePaused = 'resume';
  if (tab === ACTIVE && typeof renderQueueStrip === 'function') renderQueueStrip();
  renderTabs();
}
async function closeTab(t) {
  if (t.streaming && !(await uiConfirm(tt('chat.tab') + t.title + tt('chat.laeuftNochWirklichSchliessen'), { title: tt('html.tabSchliessen'), danger: true, okLabel: tt('chat.schliessenStoppen') }))) return;
  if (t.es) { try { t.es.close(); } catch {} }
  if (t.id) { try { await api('/api/chat/' + t.id + '/stop', { method: 'POST' }); } catch {} }
  // Tear down everything that OUTLIVES the DOM: a held ask/plan gate, its floating "Rückfrage offen" marker,
  // an open permission modal and the tool-card map. Without this the jump button activated this very tab after
  // it was removed from TABS — ACTIVE then pointed at detached DOM, every transcript hid, and only a reload
  // recovered; the retained closures also kept the whole detached transcript on the heap. (C1)
  clearAsksForTab(t); clearAskWaitersForTab(t);
  if (typeof dropPermsForTab === 'function') dropPermsForTab(t);
  // the deferred restart goes first: emptying the queue below is exactly what would otherwise fire it
  clearTimeout(t._pendingTimer); t._pendingTimer = null; t.pendingRunCfg = null; // no deferred restart of a closed tab
  clearQueue(t); pruneToolCards(t, true);
  t.steps = []; t.agents = []; t.todos = null; t.taskList = []; t.taskToolIds = null; t.current = null; // U1: taskList is the live task feed
  // the plan's live text (up to 600 KB) and the jump targets into the detached transcript go with the tab
  t.plan = null; t.planCandidates = null; t._planRows = null; t._planPrev = null; t._planOrphan = null; t._planLast = null;
  if (t.sessionId) {
    CLOSED_TABS.push({ sessionId: t.sessionId, title: t.title, cwd: t.cwd, manualTitle: t.manualTitle, def: t.defaultTitle !== false }); // for reopen
    while (CLOSED_TABS.length > 12) CLOSED_TABS.shift(); // bounded reopen stack (P6)
  }
  t.msgEl.remove();
  const i = TABS.indexOf(t); if (i >= 0) TABS.splice(i, 1);
  if (!TABS.length) activateTab(makeTab());
  else if (ACTIVE === t) activateTab(TABS[Math.max(0, i - 1)]);
  else renderTabs();
  updateTitleBadge(); persistTabs();
}
// a tab title still at its placeholder (so an auto/derived title may replace it) — ToDo 04. Shared by
// sendMessage + renderResumeHistory. The old version compared the title TEXT against four language literals,
// which silently stopped matching in a third language (and after any placeholder reword) — the tab object now
// carries the fact itself (`defaultTitle`, persisted with the tab).
function isDefaultTitle(t) { return !t || !t.title || t.defaultTitle !== false; }
function setTabTitle(t, title) { if (t.manualTitle) return; title = (title || '').trim(); if (title && t.title !== title) { t.title = title.length > 26 ? title.slice(0, 25) + '…' : title; t.defaultTitle = false; renderTabs(); persistTabs(); } }
// extract text from a tool_result content block (string | array of parts)
function liveToolResultText(block) {
  const c = block && block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && p.type === 'text') ? (p.text || '') : (p && p.type === 'image') ? '[image]' : '').join('\n');
  return '';
}
let CHAT_COMMANDS = ['/clear', '/compact', '/context', '/config', '/model', '/review', '/security-review', '/usage', '/help'];
// Commands the PANEL implements itself (never sent to the CLI). `system/init` replaces CHAT_COMMANDS with the
// CLI's list, which of course doesn't contain ours — so /diff used to vanish from the slash menu the moment a
// session started. Kept separate and concatenated on read. (C6)
const LOCAL_COMMANDS = ['/diff'];
function allChatCommands() { const s = new Set(CHAT_COMMANDS); LOCAL_COMMANDS.forEach((c) => s.add(c)); return [...s]; }
// The composer's attachments belong to the tab it types into (C8) — `ATTACHMENTS` was a module global, so a
// screenshot pasted into tab A was sent from tab B. The visible composer always edits ACTIVE's list.
function attachmentsOf(t) { const tab = t || ACTIVE; if (!tab) return []; if (!Array.isArray(tab.attachments)) tab.attachments = []; return tab.attachments; }
let PASTE_SEQ = 0; // numbers collapsed large-text pastes (📋 Eingefügter Text #N), like the terminal

// persist the chat model/effort/permission selectors (global default across reloads)
const CHAT_DEFAULTS = Object.assign({ model: '', effort: '', permMode: 'plan' }, (() => { try { return JSON.parse(localStorage.getItem('cc_chat_defaults') || '{}'); } catch { return {}; } })());
function applyChatDefaults() { $('#modelSel').value = CHAT_DEFAULTS.model || ''; $('#effortSel').value = CHAT_DEFAULTS.effort || ''; $('#permMode').value = CHAT_DEFAULTS.permMode || 'plan'; }
function saveChatDefaults() { CHAT_DEFAULTS.model = $('#modelSel').value; CHAT_DEFAULTS.effort = $('#effortSel').value; CHAT_DEFAULTS.permMode = $('#permMode').value; try { localStorage.setItem('cc_chat_defaults', JSON.stringify(CHAT_DEFAULTS)); } catch {} }
// live model list: fetched once from /api/models on boot (single source of truth = lib/models.js),
// re-rendered on language switch. Was a hardcoded <select> in index.html — went stale on every release.
let MODELS_CACHE = null;
// The concrete model a dropdown entry stands for (`resolves`, derived in lib/models.js from the
// entitlement cache): "opus[1m]" → "claude-opus-5", Fable's entry → "claude-fable-5-1". '' for an entry
// we cannot resolve (e.g. "Default" — there the CLI picks, and only it can say what it picked).
function modelResolves(value) {
  const list = (MODELS_CACHE && MODELS_CACHE.models) || [];
  const hit = list.find((m) => m.value === value);
  return hit ? (hit.resolves || '') : '';
}
// The VARIANT one menu entry stands for. Both of its strings are needed, and only together: `resolves` names
// the concrete MODEL (an alias entry has no other way to say which), while `value` is the only string that can
// ask for the 1M beta. Matching on `resolves` alone is wrong in exactly one direction, and that direction is
// the damaging one: a wide row's `resolves` is the BARE id (lib/models.js — the Bedrock „(1M)" row resolves to
// `m.id` without the suffix, and the first-party „Opus 5 (1M)" row to the plain concrete model), so a search
// for the bare model matched the „(1M)" row — which on Bedrock is also the FIRST of the two (rows are sorted
// with the wide variant before the plain one). A refusal that substitutes the bare model would then move the
// dropdown to „Opus 5 (1M)", the label promises 1M over a 200 K session, and the window decision takes the
// selector's „[1m]" as the variant: the reported line again, arriving through the path H3 added.
function modelMenuKey(m) {
  if (!m || !m.value) return '';
  const id = ctxNormModel(m.resolves || m.value);
  if (!id) return '';
  return id + ((ctxIsWide(m.value) || ctxIsWide(m.resolves)) ? '[1m]' : '');
}
// The menu entry that stands for a CONCRETE model id — the reverse of modelResolves, matched on the VARIANT
// key so „claude-opus-5[1m]" never lands on the plain „claude-opus-5" entry AND a bare „claude-opus-5" never
// lands on the „(1M)" one. '' when the menu has no entry for it (then the dropdown keeps its value and the
// status strip shows the running model instead — which is the honest outcome, not a fallback).
// The entry's own `value` is still tried, for the menu state where `resolves` is empty (no entitlement cache:
// then the alias is all the entry has to say about itself).
function modelMenuValueFor(id) {
  const want = ctxVariantKey(id);
  if (!want) return '';
  const list = (MODELS_CACHE && MODELS_CACHE.models) || [];
  const usable = list.filter((m) => m.value && !m.blocked);
  // The entry whose own VALUE is that id wins over one that merely resolves to it: both can stand for the same
  // variant (an alias row „opus[1m]" and the concrete „…claude-opus-5[1m]" row), and then the id the CLI itself
  // named is the better thing to put in the dropdown — an alias is re-resolved by the CLI at spawn time, which
  // is how a run once ended up on a model nobody had chosen.
  const hit = usable.find((m) => ctxVariantKey(m.value) === want)
    || usable.find((m) => modelMenuKey(m) === want);
  return hit ? hit.value : '';
}
// The selector value for a „/model <arg>" the CLI has CONFIRMED (chat-events.js settleTypedModel), in the order
// the menu can vouch for it: the entry whose value IS the argument; else the entry for the variant that is
// running — the served model (the frames' id, never with „[1m]") plus the argument's variant, through the same
// matcher a refused switch uses (modelMenuValueFor: value first, then the entry that resolves to it, blocked rows
// never); else the raw argument, which the dropdown then shows as a temporary option (ensureModelOption).
// „[1m]" survives every branch: it is the one part of the argument that changes the window, and the frames that
// confirmed the switch cannot carry it. `default` is the CLI's way back to settings.json's model — the menu's
// „Default" entry, whose value is the empty string.
function modelSelForTyped(arg, served) {
  const a = String(arg || '');
  if (/^default$/i.test(a)) return '';
  const list = (MODELS_CACHE && MODELS_CACHE.models) || [];
  if (list.some((m) => m.value === a && !m.blocked)) return a;
  const wide = ctxIsWide(a) || ctxIsWide(served);
  const id = ctxNormModel(served);
  const hit = id ? modelMenuValueFor(id + (wide ? '[1m]' : '')) : '';
  return hit || a;
}
// A selector value the menu does not list (a raw id adopted from a typed „/model") still has to be SHOWN: a
// <select> set to a value it has no option for shows nothing at all, i.e. the dropdown would claim „no model"
// over a running session. Added once, labelled as what it is, and rebuilt like any unknown saved value when
// populateModelSelect runs again. A TYPED one waits for the menu (at boot every restored value would read „per
// /model"); a plain one does not: without its option the <select> fell back to '' and the start went out without
// --model (a project chat opened ~1 s after boot), and populateModelSelect then kept that '' (it rebuilds from sel.value).
// `typed` — only the caller that KNOWS the value came from a typed /model (settleTypedModel) adds „(per /model)".
// A tab switch reaches here with any unknown value too (an old pinned id, a gated one), and naming a provenance it
// does not have gave one selection two labels depending on the path; without the flag it is labelled the way
// populateModelSelect labels an unknown saved value (glyph + short name).
function ensureModelOption(v, typed) {
  const sel = $('#modelSel');
  if (!sel || !v || (typed && !MODELS_CACHE) || [...sel.options].some((o) => o.value === v)) return;
  const o = el('option'); o.value = v; const g = modelGlyph(v);
  o.textContent = (g ? g + ' ' : '') + shortModel(v) + (typed ? tt('chat.modellPerTippenOption') : '');
  sel.appendChild(o);
}
// Adopt a restored tab's saved context window — once the model menu can say which VARIANT its selector
// stands for. restoreTabs runs before loadModels() answers (boot.js), and the variant key is not computable
// until it does: deciding early threw the window away on every reload (see restoreTabs). Idempotent and
// self-clearing, so loadModels can simply offer it to every tab. A menu that never arrives (offline server)
// leaves the value untouched and the CLI is asked within seconds of the resume anyway (CTX-4).
function ctxAdoptSavedWindow(t) {
  if (!t || !t._ctxWindowSaved || !MODELS_CACHE) return;
  // `|| ''` is load-bearing: a tab that never touched the dropdown has NO modelSel, and „Default" is the
  // entry whose value IS the empty string — looking up `undefined` finds nothing, which is how the one
  // selection that most needs its menu entry („Default" is the only one that cannot say its own variant)
  // would have been judged with an empty `resolves` even after the menu had answered.
  const sel = t.modelSel || '';
  const key = ctxResolveModel({ sel, resolves: modelResolves(sel) }).key;
  if (!key) return;                       // nothing at all to judge it against — keep it for a later attempt
  t.ctxReported = ctxWindowLoad(t._ctxWindowSaved, key);
  t._ctxWindowSaved = null;
}
// `maxEffortLevel` in settings.json caps how high a session may reason (CLI 2.1.267). The picker
// offered every level regardless, so on a capped machine the start failed with "invalid effort"
// instead of the level simply not being offered. The server sends the allowed list (it owns the
// CLI's ordering); a level above the cap is REMOVED, and a selection that just lost its option
// falls back to the highest one still allowed rather than silently becoming "default".
function applyEffortCap() {
  const sel = $('#effortSel'); if (!sel) return;
  const allowed = (STATE && Array.isArray(STATE.effortLevels)) ? STATE.effortLevels : null;
  if (!allowed || !allowed.length) return;
  const want = sel.value;
  [...sel.options].forEach((o) => { if (o.value && !allowed.includes(o.value)) o.remove(); });
  if (want && !allowed.includes(want)) {
    sel.value = allowed[allowed.length - 1];
    if (typeof CHAT_DEFAULTS === 'object' && CHAT_DEFAULTS.effort && !allowed.includes(CHAT_DEFAULTS.effort)) CHAT_DEFAULTS.effort = sel.value;
  } else sel.value = want;
  applyEffortLevelsForModel();   // the per-model filter runs on the list this just rebuilt
}
// A5 — which levels the CURRENT model can actually do. The CLI states it per model
// (`supportedEffortLevels` in its own `initialize` answer, reachable through /api/ultracode/support), and
// the panel offered the full ladder regardless: on Haiku 4.5, which has no effort levels at all, picking
// xhigh looked like it worked and simply did nothing.
//
// Two deliberate choices. (1) It DISABLES rather than removes: an option that silently vanishes is not a
// reason, and „why is xhigh gone?" is the question the tooltip here answers. (2) It INTERSECTS with
// applyEffortCap's `maxEffortLevel` filter instead of replacing it — both act on the same <option> list,
// and whichever ran last would otherwise undo the other. An empty or absent list means „the probe said
// nothing" and nothing is filtered at all — see the route for why that conflation is kept deliberately
// even now that `levelsKnown` could tell the two apart.
//
// M2 — and this is where the forecast is FETCHED. It used to be asked only when the model dropdown changed
// or when the Ultracode dialog opened on an unstarted tab, so a fresh tab on the DEFAULT model — the normal
// case — never asked at all: nothing was filtered, and the chip presented „possible" as if it had been
// checked. This function is the one that needs the answer, so it is the one that asks for it, lazily and
// once per tab (`_ucSupportWant` undefined = never asked). Un-awaited: until it lands nothing is filtered,
// which is the same fail-open state as before.
function applyEffortLevelsForModel() {
  const sel = $('#effortSel'); if (!sel) return;
  if (ACTIVE && !ACTIVE._ucSupport && ACTIVE._ucSupportWant === undefined && typeof fetchUltracodeSupport === 'function') {
    fetchUltracodeSupport(ACTIVE, undefined, () => {
      applyEffortLevelsForModel();                       // now with an answer; `_ucSupport` is set, so no loop
      if (typeof renderStatusBar === 'function') renderStatusBar();
    });
  }
  const sup = (ACTIVE && ACTIVE._ucSupport) || null;
  const can = (sup && sup.effortLevels && sup.effortLevels.length) ? sup.effortLevels : null;
  const name = (sup && sup.model) || tt('chat.ultracodeModellDefault');
  [...sel.options].forEach((o) => {
    // „✧ Standard (auto)" is not a level — it is the ABSENCE of one, which every model can do
    const bad = !!o.value && !!can && !can.includes(o.value);
    o.disabled = bad;
    o.title = bad ? tt('chat.effortNichtImModell').replace('{l}', o.value).replace('{m}', name) : '';
  });
}
// → the level currently picked that this model cannot do, or ''. The disabled <option> carries the reason,
// but only while the dropdown is open — so the status strip states it too (chat-status.js).
//
// M3 — the two meanings of an EMPTY level list are kept apart here, which is the one place it changes what
// the user is told. „The CLI listed this model and it has no effort levels at all" (`levelsKnown`, true for
// Haiku 4.5) means any picked level is a silent no-op and the strip must say so; „nobody checked" stays
// silent, because a warning nobody verified is worse than no warning. The DROPDOWN keeps treating both as
// „do not filter", so neither case can produce an unusable picker.
function effortLevelNotInModel(t) {
  const sup = (t && t._ucSupport) || null;
  if (!sup) return '';
  const want = t.id ? (t.effort || '') : (($('#effortSel') && $('#effortSel').value) || '');
  if (!want) return '';                                  // „auto" is the absence of a level — every model has it
  if (!sup.effortLevels || !sup.effortLevels.length) return sup.levelsKnown ? want : '';
  return sup.effortLevels.includes(want) ? '' : want;
}
// A Bedrock menu lists concrete inference-profile ids, so a saved alias ("opus[1m]") is no longer one of
// its entries. Keeping it selected would work by accident — the CLI resolves the alias itself, which is
// exactly how a run ended up on `global.anthropic.claude-fable-5-1` and died with a 403 — so the saved
// value is carried over to the entry that stands for the same family and context size.
function bedrockEntryForAlias(want, list) {
  const m = /^([a-z]+)(\[1m\])?$/i.exec(String(want || ''));
  if (!m) return '';
  const fam = m[1].toLowerCase(), wide = !!m[2];
  const hit = list.find((e) => e.value && !e.blocked
    && /\[1m\]$/i.test(e.value) === wide && e.value.toLowerCase().includes(fam));
  return hit ? hit.value : '';
}
// …and the dropdown is not the only holder of that stale value. Every TAB carries its own `modelSel`, and
// that string is what the whole context decision judges the tab by (ctxEnv → ctxResolveModel): on a Bedrock
// menu an alias resolves to NOTHING, so the tab's model id and its selector no longer name the same model and
// the variant becomes „unknown" — the gauge drops to „–" and the window the tab measured for itself is thrown
// away on the next reload (ctxWindowLoad compares the variant key). Migrating only `sel.value` and
// CHAT_DEFAULTS left exactly that: a restored tab judged by a value the menu it is judged against does not
// contain. The alternative — teaching the decision to TOLERATE the alias — would mean inheriting a variant
// across a family name („opus" is a family, not a model), which is the loose matching this whole mechanism
// refuses; so the stale value is migrated instead, with the same mapping and only where the menu really has
// no such entry. A tab whose alias maps to nothing keeps it: the CLI is still the one that resolves it.
// The mapping picks the NEWEST entry of that family and context size — the same thing the CLI's own alias
// resolution does — but it is a derivation, so a session that was started on an older member of the family
// stays „variant unknown" afterwards (its selector then names a different model than its frames do). That is
// never worse than the alias, which named no model at all, and the probe settles it either way.
function migrateTabAliasSelections(list) {
  const tabs = (typeof TABS !== 'undefined' && Array.isArray(TABS)) ? TABS : [];
  let moved = 0;
  tabs.forEach((t) => {
    const v = t && t.modelSel;
    if (!v || list.some((e) => e.value === v)) return;
    const mig = bedrockEntryForAlias(v, list);
    if (!mig || mig === v) return;
    t.modelSel = mig; moved++;
  });
  if (moved && typeof persistTabsSoon === 'function') persistTabsSoon();
  return moved;
}
let MODEL_BLOCK_WARNED = false; // one warning per page load, not one per dropdown rebuild
function populateModelSelect() {
  const sel = $('#modelSel'); if (!sel) return;
  const list = (MODELS_CACHE && MODELS_CACHE.models) || [];
  if (!list.length) return; // no data yet → keep the static "◇ Standardmodell" fallback
  const bed = (MODELS_CACHE && MODELS_CACHE.bedrock) || null;
  const entry = (v) => list.find((m) => m.value === v) || null;
  let want = sel.value || CHAT_DEFAULTS.model || ''; // preserve the current/saved selection across a rebuild
  sel.innerHTML = '';
  list.forEach((m) => {
    const o = el('option'); o.value = m.value;
    // value '' = the CLI default → keep our bilingual "◇ Standardmodell"; others = glyph + console label
    if (m.value === '') o.textContent = tt('html.standardmodell');
    else { const g = modelGlyph(m.value); o.textContent = (g ? g + ' ' : '') + m.label; }
    // A model the IAM policy forbids stays VISIBLE but unselectable: silently dropping it would turn a
    // named restriction ("Opus 5.5 ist für deine Rolle gesperrt") back into the mystery this fixed.
    if (m.blocked) { o.disabled = true; o.textContent = '⛔ ' + o.textContent; }
    // Tooltip: the console description when the CLI shipped one (extras only), plus — for the ALIAS
    // entries, whose label carries a derived version — the concrete model they currently start as.
    // An extra like "claude-fable-5-1[1m]" is already concrete, so that line would be noise there.
    // Composed here, not on the server, so it follows the language switch.
    const tip = [];
    // "Default" is the one entry whose meaning lives in a FILE (settings.json `model`), so it names what
    // it currently starts — the thing that was invisible while it silently started a forbidden model.
    if (m.value === '') {
      tip.push(tt('chat.standardmodellTooltip'));
      if (m.resolves) tip.push(tt('chat.standardmodellStartetAls') + m.resolves);
    }
    if (m.desc) tip.push(m.desc);
    // Only a genuine ALIAS needs the "starts as" line. On Bedrock the value already IS the concrete id,
    // and `resolves` differs from it only by the `[1m]` suffix — repeating it there reads like a second,
    // different model.
    if (m.value !== '' && m.resolves && !/^claude-/.test(m.value) && normModelId(m.value) !== normModelId(m.resolves)) tip.push(tt('chat.aliasLoestAufZu') + m.resolves);
    if (m.blocked) tip.push(tt(m.reason === 'absent' ? 'chat.modellNichtVorhanden' : 'chat.modellGesperrt') + (m.resolves || m.value));
    if (tip.length) o.title = tip.join('\n');
    sel.appendChild(o);
  });
  // A saved alias from the first-party era has a concrete counterpart in a Bedrock menu — move it over
  // (and remember the move, otherwise every reload re-does it) instead of pinning an extra option. All THREE
  // holders of that value are migrated: the dropdown, the saved default, and every restored tab's own
  // `modelSel` — the last one is what the context decision judges a tab by, and it was being left behind.
  if (bed && bed.enabled) {
    migrateTabAliasSelections(list);
    if (want && !entry(want)) {
      const mig = bedrockEntryForAlias(want, list);
      if (mig) {
        if (CHAT_DEFAULTS.model === want) {
          CHAT_DEFAULTS.model = mig;
          try { localStorage.setItem('cc_chat_defaults', JSON.stringify(CHAT_DEFAULTS)); } catch { /* private mode */ }
        }
        want = mig;
      }
    }
  }
  // Selecting a blocked entry is a guaranteed 403 on the first turn, so it is never left selected —
  // including the "Default" entry, whose block comes from settings.json `model` and therefore hits
  // every new chat on this machine until that file is corrected.
  const wantEntry = entry(want);
  if (wantEntry && wantEntry.blocked) {
    const alt = list.find((m) => m.value && !m.blocked);
    if (alt) {
      if (!MODEL_BLOCK_WARNED) {
        MODEL_BLOCK_WARNED = true;
        toast(tt(want === '' ? 'chat.standardmodellGesperrt' : 'chat.gewaehltesModellGesperrt')
          + (wantEntry.resolves || want) + tt('chat.stattdessen') + alt.label, 'err');
      }
      want = alt.value;
    }
  }
  // a saved default that's no longer in the list (e.g. an old pinned id) stays selectable so it persists
  if (want && !entry(want)) {
    const o = el('option'); o.value = want; const g = modelGlyph(want);
    o.textContent = (g ? g + ' ' : '') + shortModel(want); sel.appendChild(o);
  }
  sel.value = want;
  // The measurement itself can fail (no VPN, expired session, no credentials file). Then nothing was
  // judged and the list is the unfiltered console menu — say so once, rather than let the user believe
  // the entries were checked.
  if (bed && bed.enabled && bed.error && !MODEL_BLOCK_WARNED) {
    MODEL_BLOCK_WARNED = true;
    toast(tt('chat.modellrechteUngeprueft') + bed.error, 'warn');
  }
}
async function loadModels() {
  try {
    MODELS_CACHE = await api('/api/models');
    populateModelSelect();
    // …and NOW the saved context windows can be judged: restoreTabs ran before this answer arrived, so the
    // variant key it would have computed was wrong for „Default" and for every alias selection. Repaint
    // afterwards, because the line may change from the name-table guess to the number this tab measured.
    (typeof TABS !== 'undefined' ? TABS : []).forEach(ctxAdoptSavedWindow);
    if (typeof updateCtxGauge === 'function') updateCtxGauge();
    if (typeof rebuildCompareModels === 'function') rebuildCompareModels();
    if (MODELS_CACHE && MODELS_CACHE.pricing && typeof updateChatPricing === 'function') updateChatPricing(MODELS_CACHE.pricing);
  } catch { /* keep the static fallback option */ }
}
// C10: every change here used to call saveChatDefaults() — so switching the model "for this one tab" silently
// rewrote what EVERY future chat starts with, with no way to tell the two intentions apart. A change now
// applies to the ACTIVE tab only; the pin next to the selectors (ensureDefaultsPin, chat-status.js) is the
// explicit "als Standard merken".
let EFFORT_RESTART_WARNED = false;
['#modelSel', '#effortSel', '#permMode'].forEach((s) => $(s).addEventListener('change', () => {
  if (typeof refreshDefaultsPin === 'function') refreshDefaultsPin(); // pin reflects "differs from the saved default"
  // A2/A5 — BOTH per-model verdicts (can this model do Ultracode at all, and which effort levels does it
  // offer) are properties of the model, so a model change invalidates both. Asked here, before the
  // branches below return, and un-awaited: until the answer lands nothing is filtered and nothing claims
  // „impossible". The new model is passed explicitly because `ACTIVE.modelSel` is still the OLD one at this
  // point — applyLiveModel only adopts it once the CLI has accepted the switch.
  if (s === '#modelSel' && ACTIVE) {
    ACTIVE._ucSupport = null;
    // Asked BEFORE the repaint below, and that order matters since applyEffortLevelsForModel acquired a lazy
    // probe of its own (M2): it would ask for `ACTIVE.modelSel`, which is still the OLD model here
    // (applyLiveModel only adopts the new one once the CLI has accepted the switch). Asking first puts the
    // NEW model on `_ucSupportWant`, and the lazy one then stands down.
    fetchUltracodeSupport(ACTIVE, $(s).value, () => { applyEffortLevelsForModel(); if (typeof renderStatusBar === 'function') renderStatusBar(); });
    applyEffortLevelsForModel();   // drop the previous model's verdict immediately rather than show it on
  }
  // mode/effort/model → live switch (each repaints the strip itself, so `return` to avoid a one-frame
  // stale hint from a synchronous render before the async switch resolves)
  if (s === '#permMode' && ACTIVE && ACTIVE.id && ACTIVE.permissionMode !== $(s).value) { applyLiveMode($(s).value); return; }
  if (s === '#effortSel' && ACTIVE && ACTIVE.id && (ACTIVE.effort || '') !== ($(s).value || '')) {
    const v = $(s).value;
    if (LIVE_EFFORT_LEVELS.includes(v)) { applyLiveEffort(v); return; } // live switch like the console — no restart
    // Only a level the server does not know can still get here (a newer CLI's name, a mutated dropdown).
    // '' and 'max' used to land in this branch too, on the claim that they were „session-scoped for a
    // remote process" — they are not, and the needless restart is gone. Restarting is still the honest
    // fallback for a level nobody can switch live, and it says so once. (C10)
    if (!EFFORT_RESTART_WARNED) {
      EFFORT_RESTART_WARNED = true;
      const back = ACTIVE.effort || '';
      uiConfirm(tt('chat.effortNeustartFrage'), { title: tt('chat.sitzungNeuStarten'), okLabel: tt('chat.neuStarten') })
        .then((ok) => { if (ok) scheduleRunCfg('effort', v); else { $('#effortSel').value = back; renderStatusBar(); } });
    } else scheduleRunCfg('effort', v);
    return;
  }
  if (s === '#modelSel' && ACTIVE && ACTIVE.id && (ACTIVE.modelSel || '') !== ($(s).value || '')) { applyLiveModel($(s).value); return; }
  // not started yet → the pick belongs to THIS tab (startChat reads the selectors for the active tab, and
  // activateTab now restores a touched tab's own config instead of the global default)
  if (ACTIVE) {
    ACTIVE.cfgTouched = true;
    if ((ACTIVE.modelSel || '') !== ($('#modelSel').value || '')) ACTIVE._modelPending = null; // an explicit pick wins over a typed one
    ACTIVE.modelSel = $('#modelSel').value; ACTIVE.effort = $('#effortSel').value; ACTIVE.permissionMode = $('#permMode').value;
    toast(tt('chat.giltFuerDiesenTab'), 'ok');
  }
  if (typeof renderStatusBar === 'function') renderStatusBar();
  // …and the context line follows: before the first start the selector IS the model this tab would run,
  // so the window it names has to change with the pick instead of a tick later (CTX-3).
  if (ACTIVE && typeof updateCtxGauge === 'function') updateCtxGauge(ACTIVE);
}));
applyChatDefaults();
// live permission-mode switch for the running session (like Shift+Tab in the console). It changes THIS tab only:
// since C10 the defaults move solely through the pin next to the selectors (chat-status.js). The three live
// switches (mode, effort, model) kept toasting „· auch als Standard gemerkt" from the time before C10 — no
// default was saved, and after P-0 a reload showed it: a tab switched live to bypass came back in the default
// mode, under a toast that had just called bypass the default. The suffix is gone from all three.
// FLOW-3 — and the answer is believed only where it is a READ-BACK, exactly as applyLiveEffort below.
// `set_permission_mode` echoes the mode now IN EFFECT (measured in the binary, see lib/chat setChatMode),
// so the chip takes `r.mode` and not the value that was picked: the two differ whenever the CLI landed
// somewhere else, and a permission chip that shows the wish instead of the fact is the worst place in this
// panel to be optimistic. `unconfirmed` (nobody answered inside 5 s) keeps the picked value — there is
// nothing better — but says so in the toast instead of reporting a success nobody confirmed.
async function applyLiveMode(mode) {
  const t = ACTIVE;
  if (!t || !t.id) return;
  try {
    const r = await api('/api/chat/' + t.id + '/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
    const effective = (r && typeof r.mode === 'string' && r.mode) ? r.mode : mode;
    t.permissionMode = effective;
    // P-0 — saved at once: cc_tabs carries the mode now, and nothing else on this path persists, so a reload
    // right after the switch brought the previous mode back
    if (typeof persistTabs === 'function') persistTabs();
    if (t === ACTIVE) { renderStatusBar(); if ($('#permMode')) $('#permMode').value = effective; }
    const un = !!(r && r.unconfirmed);
    toast(tt('chat.modusLiveGewechselt') + modeInfo(effective).label
      + (un ? tt('chat.modusUnbestaetigt') : ''), un ? 'err' : 'ok');
  } catch (e) {
    toast(tt('chat.liveModuswechselFehlgeschlagen') + e.message + tt('chat.giltAbNeustart'), 'err');
  }
}
// Effort levels the panel switches LIVE on a running session: the CLI's whole ladder, plus '' for „auto"
// (no explicit level, sent as `effortLevel: null`). `max` and '' were listed here as „session-scoped for a
// remote process, take the restart path" — they are not: the CLI validates `effortLevel` against exactly
// low…max and accepts null, so the two levels people reach for most (the hardest one, and „back to normal")
// were the two that needlessly restarted the session. Still a LIST and not „everything", so a level nobody
// can switch live — a newer CLI's name — keeps the honest restart fallback.
const LIVE_EFFORT_LEVELS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
// Live reasoning-effort switch for the running session (the console's /effort, no restart). Sends the LEVEL
// to the server, which turns it into one apply_flag_settings{effortLevel, ultracode} — the ultracode half
// comes from the session, see below. The org effort cap still applies.
//
// WHY the ultracode wish goes along at all: the CLI's stdio handler turns Ultracode OFF for an effort-only
// request whose level differs (decoded rule in lib/chat setChatEffort). So before this, EVERY effort change
// in the panel silently switched Ultracode off, and the chip then kept claiming it was on until something
// else happened to re-read the state.
//
// And WHOSE wish: the SESSION's, which is why this request carries no `ultracode` field at all. The server
// re-asserts `chat.meta.ultracodeWish` whenever the field is absent — it keeps that value precisely so a
// stale tab cannot change it. Sending `ultracodeOn(t)` instead handed the decision to the browser's GLOBAL
// preference whenever this tab had made no explicit choice: turn the global switch off in Settings, then
// change the effort of a running Ultracode session, and the effort change switched Ultracode off with it.
// Every other ultracode wire in the panel already goes through the session's own wish; this one now does too.
//
// And the answer is believed only where it is a READ-BACK. Over stdio an unrecognised level — and '' — is
// a silent success, so the request can never report its own failure; `effort` and `ultracode` in the
// response come from the session's own get_settings. When nobody answered (`unconfirmed`), a future CLI
// refused (`refused`) or the state could not be read ('unknown'), there is nothing to believe: the picked
// value stands, the chip says „unbestätigt", and the toast says so rather than reporting success.
async function applyLiveEffort(value) {
  const t = ACTIVE;
  if (!t || !t.id) return;
  try {
    const r = await api('/api/chat/' + t.id + '/effort', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ effort: value }),
    });
    const read = adoptUltracodeState(t, r);                                   // and the chip is corrected by it
    if (read) { t.effort = (typeof r.effort === 'string') ? r.effort : ''; t._effortUnread = false; } // null = auto
    else { t.effort = value; t._effortUnread = true; }
    if (typeof persistTabs === 'function') persistTabs();   // P-0 — the level rides in cc_tabs now (as the mode above)
    // The optimistic value is labelled in the TOAST, but the strip prints „⚡ <level>" only when t.effort
    // differs from the dropdown — and after an unconfirmed switch it never does, so the label was the only
    // place the doubt existed and it disappeared with the toast. The flag lets the strip say so too: an
    // unconfirmed level is exactly the Ultracode „unknown" case one field over (the CLI reports success for
    // a level it silently ignored), and it must not look like a level somebody read back.
    if (t === ACTIVE) renderStatusBar();
    toast(tt('chat.effortLiveGewechselt') + (t.effort || tt('chat.effortAuto'))
      + (read ? '' : tt('chat.effortUnbestaetigt')), read ? 'ok' : 'err');
  } catch (e) {
    // live switch rejected → fall back to the resume-restart path (now free of the wrong-tab race)
    toast(tt('chat.liveEffortFehlgeschlagenSetze') + e.message, 'err');
    scheduleRunCfg('effort', value);
  }
}
// live MODEL switch for the running session (the console's /model, no restart). Sends set_model via the
// server (the CLI validates the id). On failure → fall back to the (race-fixed) resume-restart path.
async function applyLiveModel(value) {
  const t = ACTIVE;
  if (!t || !t.id) return;
  try {
    await api('/api/chat/' + t.id + '/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: value }) });
    t.modelSel = value;
    // An explicit, LATER pick replaces a typed /model that is still waiting for its confirmation. Left standing,
    // the next frame confirmed the older wish and settleTypedModel overwrote this selection with it — the dropdown
    // jumped back to „…[1m]" over a session the CLI had just switched to the bare model, and persisted that.
    t._modelPending = null;
    // The session RUNS this model now — record that, the way applyLiveMode/applyLiveEffort record theirs.
    // Without it `t.model` kept whatever `init` reported at launch, and since the status strip shows its
    // model read-out exactly when the running model differs from the selection, a SUCCESSFUL switch made
    // the strip claim the old one: dropdown „Fable", strip „🧠 opus-5[1m]". It also mispriced the turn
    // footer, which reads chat.model (turnCostUSD) — Opus rates for a Fable turn.
    t.model = modelResolves(value) || value || null;
    // CTX-1 — and the context line must not keep the OLD model's window. `set_model` is live (measured:
    // 128–1457 ms) and the very next `get_context_usage` already reports the new window — 1 000 000 →
    // 200 000 in the measurement — so everything derived from the previous model is dropped and the CLI is
    // asked instead. Without this the line went on dividing by the old window, which is the reported
    // „Kontext 250 % · 500,8K / 200,0K": a 1M tab switched onto a 200 K model.
    if (typeof ctxForgetModel === 'function') ctxForgetModel(t);
    if (typeof ctxProbe === 'function') ctxProbe(t, 'model');
    if (t === ACTIVE && typeof updateCtxGauge === 'function') updateCtxGauge(t); // „wird gemessen…" until it answers
    // A2 — `applied.ultracodeAvailable` is a function of the CURRENT model (the CLI computes it as
    // „workflows on AND this model does xhigh"), so a model change invalidates the cached verdict. Without
    // this the chip kept claiming the old one: switch a running Ultracode session to Haiku and it still
    // read „an" — the exact lie the three-state chip exists to prevent. Un-awaited, like the `init` path.
    if (typeof refreshUltracodeState === 'function') refreshUltracodeState(t);
    renderTabs(); // the tab's model glyph follows too (🧠 → 📖)
    if (t === ACTIVE) renderStatusBar();
    toast(tt('chat.modellLiveGewechselt') + (shortModel(value) || 'default'), 'ok');
  } catch (e) {
    // The CLI refused the id — and a refusal is not always a no-op. Measured wording (2026-09-02):
    //   „Model "claude-fable-5-1[1m]" is restricted by your organization's settings.
    //    Using claude-opus-5[1m] instead."
    // The CLI says no AND puts the session on a DIFFERENT model. Treating that as „nothing happened" left
    // the panel on the model that was refused: the dropdown, the tab glyph, the per-turn price and every
    // context-window decision were then about a model that is not running — the same „window of a model it
    // is not running" the gauge was fixed for, arriving through the error path. So the substitution is
    // adopted: parsed out of the CLI's own sentence when it is there, ASKED of the session when it is not
    // (get_settings `applied.model`), and never guessed. Which of the two happened is in the toast, because
    // „the session now runs X" is a claim and the user has to be able to tell where it came from.
    let sub = (typeof ctxModelFromRefusal === 'function') ? ctxModelFromRefusal(e.message) : '';
    let asked = false;
    if (!sub) {
      try { const s = await api('/api/chat/' + t.id + '/settings'); sub = String((s && s.model) || ''); asked = !!sub; }
      catch { /* an older server has no `model` in that answer, or the session is gone — then we know nothing */ }
      // A bare family alias („opus") is not a concrete model and must not overwrite the concrete id the
      // frames reported — same rule as the parser: an id carries a separator, a word is prose.
      if (sub && !/[-.]/.test(sub)) { sub = ''; asked = false; }
      // …and what the session reports may be the model it was ALREADY on, i.e. no substitution at all
      if (sub && ctxVariantKey(sub) === ctxVariantKey(t.model || t.modelSel)) { sub = ''; asked = false; }
    }
    if (sub) {
      const v = modelMenuValueFor(sub);
      // `t.model` stays the CONCRETE id the price table and the window table are keyed by — the same
      // resolution the success path above does for the selected value
      t.model = (v && modelResolves(v)) || sub;
      if (v) t.modelSel = v;                           // …and the dropdown stops claiming the refused one
      t._modelPending = null;                          // …and a typed /model from before is superseded (see above)
      if (typeof persistTabsSoon === 'function') persistTabsSoon();
      // the window belongs to the model, and the model just changed under us — drop everything derived from
      // the old one and ask the CLI about the one that is really running (CTX-1, same as the success path)
      if (typeof ctxForgetModel === 'function') ctxForgetModel(t);
      if (typeof ctxProbe === 'function') ctxProbe(t, 'model');
      if (t === ACTIVE && typeof updateCtxGauge === 'function') updateCtxGauge(t);
      renderTabs();
      toast(tt(asked ? 'chat.modellwechselErsetztNachgefragt' : 'chat.modellwechselErsetzt')
        .replace('{m}', shortModel(sub) || sub) + e.message, 'err');
    } else {
      // Nothing was substituted (an unknown id: „…is not a recognized model id.") — the session really does
      // keep running what it ran before. Say what the CLI said and put the selector back on it.
      toast(tt('chat.modellwechselAbgelehnt') + e.message, 'err');
    }
    const sel = $('#modelSel');
    if (sel) { sel.value = t.modelSel || ''; if (typeof refreshDefaultsPin === 'function') refreshDefaultsPin(); }
    if (t === ACTIVE) renderStatusBar();
  }
}
// Relaunch a chat RESUMING the same session (model context preserved) with new run-config
// (effort / model / mcpServers). startChat clears the transcript, so we repaint recent history after.
// Effort/model are launch flags gated by org policy (we don't use raw thinking-token controls that could
// bypass org effort limits). Fully tab-explicit: startChat + renderResumeHistory receive `tab`, so it works
// for a background tab without ever binding the module-global `chat` across an `await`. Concurrent restarts
// on the SAME tab are serialized on a per-tab promise chain so their DOM writes can't interleave.
function restartResume(tab, extra) {
  const run = () => _restartResumeNow(tab, extra);
  tab._resumeChain = Promise.resolve(tab._resumeChain).catch(() => {}).then(run);
  return tab._resumeChain;
}
async function _restartResumeNow(tab, extra) {
  tab._resuming = true;
  if (typeof resumeStage === 'function') resumeStage(tab, 'spawn');
  showResumeLoading(tab); // spinner while the session relaunches + history repaints (ToDo 02)
  if (typeof renderTabs === 'function') renderTabs(); // the tab's spinner
  try {
    const sid = tab.sessionId, cwd = tab.cwd;
    // real session (has the encoded `project`) if known, else computed from cwd so the transcript always
    // repaints — was fragile before when SESSIONS didn't hold the session.
    const s = sessionRefFor(sid, cwd);
    // pass the tab's OWN run-config so a background restart carries the right Model/Effort/Mode (extra wins).
    // A still-deferred effort/model change rides along — startChat drops pendingRunCfg, so a restart from
    // any path (dead-chat recovery, heal, tab menu) would otherwise lose it. Taken HERE, at run time: callers
    // take theirs before queueing, so whatever is pending now is the newer wish.
    const cfg = Object.assign({
      resume: sid, cwd: cwd || s.projectPath,
      permissionMode: tab.permissionMode || 'plan',
      model: tab.modelSel || undefined,
      effort: tab.effort || undefined,
    }, extra || {}, takePendingRunCfg(tab));
    await startChat(cfg, tab);
    if (typeof resumeStage === 'function') resumeStage(tab, 'history');
    await renderResumeHistory(s, tab);
  } finally { tab._resuming = false; if (typeof resumeFinish === 'function') resumeFinish(tab); hideResumeLoading(tab); if (tab === ACTIVE) setComposerEnabled(true); if (typeof refreshSessionChip === 'function') refreshSessionChip(tab); if (typeof renderTabs === 'function') renderTabs(); }
  if (tab === ACTIVE && typeof renderStatusBar === 'function') renderStatusBar();
}
// ---- deferred restarts (CHAT-FLOW-1/5) -----------------------------------------------------------------
// A resume-restart kills the CLI process — and with it the running turn, every background agent and the
// follow-up turn the CLI starts by itself when such an agent reports back (adopted as `streaming` when it
// streams, CHAT-FLOW-3; frame-only main-thread work still reads idle). So a restart waits for all of it: tab.pendingRunCfg holds the wish ({effort?, model?,
// _why?: [reasons from the tab menu]}) and maybeApplyPendingRunCfg fires it once nothing is live any more.
const PENDING_QUIET_MS = 8000; // after an agent lane ends: no frame for this long → the CLI isn't following up
function tabHasLiveWork(t) { // a turn open without any frame for LANE_STALE_MS is as dead as a stale lane
  const turnOpen = !!t && !!t._turnOpen && Date.now() - (t._lastFrameAt || 0) < LANE_STALE_MS;
  // A HELD ask/plan gate is live work too — and the one kind that looks idle from every other angle: the CLI
  // blocks inside can_use_tool, so `streaming` is false, nothing streams and `turnOpen` goes stale after
  // LANE_STALE_MS. The restart would then kill the process with an answerable card still on screen and throw
  // the card away. The wait ends when the card is answered (the turn runs on and its `result` applies the
  // restart), when Stop drops the gate (interruptTab re-checks below) or with the process itself (_exit → no
  // restart behind your back; the next send carries the config along, see pendingRunCfgReady).
  return !!t && (!!t.streaming || turnOpen || hasHeldGate(t) || (t.agents || []).some((a) => a && a.status === 'running'));
}
// …and has Stop anything to stop? A held gate counts here too, for the same reason: the CLI blocks inside
// can_use_tool with `streaming` false, so the three Stop affordances (⏹ in the composer, the tab menu's
// „Stoppen", Esc-Esc) each said „nothing is running" — in exactly the state where tabHasLiveWork makes a
// deferred restart wait. Answering the card was then the only way out, and if the card was gone with it
// (reaped chat, a closed transcript) there was none at all. One predicate for all three.
// Since the Nachtrag (Sergej, 07.10.) it counts what tabHasLiveWork counts as well: a turn the CLI runs on without
// streaming (frames only) and running sub-agents — the two states in which ⏹ used to vanish while something visibly
// went on, so there was nothing to press. `t.id`: a tab that never started has no process to stop.
function tabCanStop(t) { return !!t && (!!t.streaming || hasHeldGate(t) || (!!t.id && tabHasLiveWork(t))); }
// ---- two-stage Stop (Sergej, Nachtrag) -----------------------------------------------------------------------
// Press 1 is the gentle stop it always was (interruptTab). Press 2 within STOP_ARM_MS is the hard stop: the
// process ends and the session resumes from its transcript (hardStopTab). Press 1 escalates by itself only when
// the process gives NO sign of life for STOP_ESCALATE_MS while the turn is still open — a hung process; one that
// answers (a frame, its `result`) is slow at worst, and then the second press is the user's call, not a timer's.
// One function for the three Stop affordances (⏹ in the composer, the tab menu's „Stoppen", Esc-Esc).
const STOP_ESCALATE_MS = 6000;
const STOP_ARM_MS = 5 * 60 * 1000;
function stopArmed(t) { return !!(t && t._stopAt && Date.now() - t._stopAt < STOP_ARM_MS); }
function stopRunningLanes(t) { return ((t && t.agents) || []).filter((a) => a && a.status === 'running'); }
async function stopTab(t) {
  if (!t || !t.id || t._hardStopping) return;
  if (stopArmed(t)) { await hardStopTab(t, 'manual'); return; }
  const at = Date.now();
  t._stopAt = at;
  if (t === ACTIVE && typeof refreshInterruptBtn === 'function') refreshInterruptBtn();
  // Nothing but sub-agents left (the turn is over): an interrupt has no turn to hit, and interruptTab would mark
  // every lane „aborted" whether or not the CLI stopped it. Each lane gets its own stop_task instead (G6,
  // agentStopClick) — its row says „angefordert" until a frame of the CLI confirms the stop.
  const lanes = stopRunningLanes(t);
  if (!t.streaming && !hasHeldGate(t) && !t._turnOpen && lanes.length && typeof agentStopClick === 'function') {
    lanes.forEach((a) => agentStopClick(a, t));
    toast(tt('chat.stoppAgentenAngefordert') + tt('chat.stoppHartHinweis'), 'ok');
    return;
  }
  const cliTurn = !!(t._cliTurn && t.streaming); // read before the await, like interruptTab does
  await interruptTab(t, { stopHint: true });
  clearTimeout(t._stopTimer);
  t._stopTimer = setTimeout(() => {
    t._stopTimer = null;
    if (t._stopAt !== at || !TABS.includes(t) || t._hardStopping) return;
    if (cliTurn) return;                         // an adopted turn ends its own way (armCliTurnStop, CHAT-FLOW-3)
    if ((t._lastWorkAt || 0) > at) return;      // the process worked after the press — slow, not hung (an ack does not count)
    if (!t.streaming && !hasHeldGate(t)) return; // the turn is over
    hardStopTab(t, 'auto');
  }, STOP_ESCALATE_MS);
}
// The hard stop: end the process and resume the session from its transcript — restartResume → startChat ends the
// old process via /stop and repaints the history. The conversation stays; the turn that hung, the queue and every
// agent of that process are gone (agentsAborted is TRUE here, unlike after an interrupt).
async function hardStopTab(t, why) {
  if (!t || !t.id || t._hardStopping || t._resuming) return;
  t._hardStopping = true; t._stopAt = 0; clearTimeout(t._stopTimer); t._stopTimer = null;
  const msg = tt(why === 'auto' ? 'chat.hartGestopptAuto' : 'chat.hartGestoppt').replace('{s}', String(STOP_ESCALATE_MS / 1000));
  try {
    if (typeof retirePlanCards === 'function') retirePlanCards(t);
    clearAsksForTab(t); clearAskWaitersForTab(t);
    clearQueue(t, tt('chat.abgebrochen'));
    agentsAborted(t);
    if (t.sessionId) await restartResume(t, {});
    else {
      await api('/api/chat/' + t.id + '/stop', { method: 'POST' }).catch(() => {});
      if (t.streaming) withTab(t, () => setComposerBusy(false));
    }
    withTab(t, () => addMsg('system', msg));
  } catch (e) { toast(e.message, 'err'); }
  finally { t._hardStopping = false; if (t === ACTIVE && typeof refreshInterruptBtn === 'function') refreshInterruptBtn(); }
}
function takePendingRunCfg(t) { // → the launch flags only (effort/model); clears the wish
  const p = t && t.pendingRunCfg; if (!p) return {};
  t.pendingRunCfg = null; clearTimeout(t._pendingTimer); t._pendingTimer = null;
  const c = Object.assign({}, p); delete c._why; return c;
}
function pendingRunCfgReady(t) {
  // !_exited: a process that is gone is not restarted behind your back — the next send resumes it and
  // takes the pending config along (_restartResumeNow)
  return !!(t && t.pendingRunCfg && t.id && t.sessionId && !t._resuming && !t._exited && !tabHasLiveWork(t)
    && !(t.queue && t.queue.length) && !t.queuePaused && TABS.includes(t)); // a closed tab never restarts
}
// opts.quiet: called because a lane just ended (not at a turn end) → wait out the quiet window first
function maybeApplyPendingRunCfg(t, opts) {
  if (!pendingRunCfgReady(t)) return false;
  const quietFor = Date.now() - (t._lastFrameAt || 0);
  if (opts && opts.quiet && quietFor < PENDING_QUIET_MS) {
    clearTimeout(t._pendingTimer);
    t._pendingTimer = setTimeout(() => { t._pendingTimer = null; maybeApplyPendingRunCfg(t, opts); }, PENDING_QUIET_MS - quietFor + 50);
    return false;
  }
  restartResume(t, takePendingRunCfg(t))
    .then(() => toast(tt('chat-events.aenderungenUebernommenSitzungFortgesetzt'), 'ok'))
    .catch((e) => toast(e.message, 'err'));
  return true;
}
// Tab-menu restarts (MCP, guardrails, sub-agents): their new value is already on the tab (startChat sends
// it), so all that is deferred is the restart itself — noted as a reason for the status-line hint.
async function restartWhenIdle(t, why, doneMsg) {
  if (tabHasLiveWork(t) || (t.queue && t.queue.length) || t.queuePaused) {
    const cur = t.pendingRunCfg || {};
    cur._why = (cur._why || []).filter((x) => x !== why).concat([why]);
    t.pendingRunCfg = cur;
    toast(why + tt('chat.gemerktGreiftNachDem'), 'ok');
    if (t === ACTIVE && typeof renderStatusBar === 'function') renderStatusBar();
    return;
  }
  try { await restartResume(t, {}); holdQueueAfterResume(t); toast(doneMsg, 'ok'); } catch (e) { toast(e.message, 'err'); }
}

// Apply an effort/model change to the running session. Unstarted → remember for the next start.
// Busy (turn, agents, queue) → stash in tab.pendingRunCfg (applied once all of that is done; the chip stays
// truthful meanwhile, with a "↻ … nach Turn" hint). Idle → apply now via a resume-restart.
function scheduleRunCfg(kind, value) {
  const t = ACTIVE; if (!t) return;
  // a model change through here is an explicit pick as well, and replaces a typed /model still pending (see
  // applyLiveModel) — otherwise the deferred restart would also report that typed switch as lost (retireTypedModel)
  if (kind === 'model') t._modelPending = null;
  const label = kind === 'effort' ? tt('chat.effort') : tt('common.modell');
  if (!t.id || !t.sessionId) { if (kind === 'effort') t.effort = value; else t.modelSel = value; toast(label + tt('chat.gemerktGreiftBeimStart'), 'ok'); renderStatusBar(); return; }
  if (tabHasLiveWork(t) || (t.queue && t.queue.length) || t.queuePaused) { t.pendingRunCfg = Object.assign(t.pendingRunCfg || {}, { [kind]: value }); toast(label + tt('chat.gemerktGreiftNachDem'), 'ok'); renderStatusBar(); return; }
  restartResume(t, Object.assign(takePendingRunCfg(t), { [kind]: value }))
    .then(() => toast(label + tt('chat.live') + (value || 'default') + tt('chat.sitzungFortgesetzt'), 'ok'))
    .catch((e) => toast(label + tt('chat.wechselFehlgeschlagen') + e.message + tt('chat.giltAbNeustart'), 'err'));
}

// NOTE: the first tab is created at the END of chat-perms.js (the last chat-* module) — activateTab()
// references startTurnStatus/scrollBottom/renderAgentStrip/etc. that now live in later chat-* files, so it
// must run only after they've all loaded (see the bootstrap line there).

