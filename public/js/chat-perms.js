// Part of the Claude Code Control Panel front-end (split from app.js).
// Classic scripts share one global scope; load order in index.html is authoritative: render → chat → sessions → views → commands → boot.
// This file: chat-perms.js

// Fallback banner — with `--permission-prompt-tool stdio` the CLI now normally asks (the modal
// above fires). This only shows in the rare case a tool is denied WITHOUT a prompt — e.g. a
// standing deny-rule, plan mode, or an edge tool that the CLI still auto-denies. Offers the remedies.
function chatPermDenied(tool) {
  const t = chat; // owning tab (chat is swapped to it during event handling)
  t._permDenied = t._permDenied || new Set();
  const key = tool || '_'; if (t._permDenied.has(key)) return; t._permDenied.add(key);
  const mode = t.permissionMode || ($('#permMode') ? $('#permMode').value : '') || 'plan';
  const box = el('div', 'ui-perm-denied');
  box.appendChild(el('div', 'upd-title', '⚠ ' + tt('chat-perms.toolNichtFreigegeben') + (tool ? ': ' + tool : '')));
  box.appendChild(el('div', 'upd-body', tt('chat-perms.dasToolWurdeOhne') + mode + tt('chat-perms.bzwEineDenyRegel')));
  const row = el('div', 'upd-row');
  if (tool && typeof localPermAdd === 'function') {
    const allow = el('button', 'ghost-btn', '＋ ' + tt('chat-perms.toolErlauben'));
    // the server adds the rule to the file as it is now (and skips it if already there) — ✓ only once it is in
    allow.onclick = async () => { allow.disabled = true; if (await localPermAdd('allow', tool)) allow.textContent = '✓ ' + tt('chat-perms.erlaubtErneutSenden'); else allow.disabled = false; };
    row.appendChild(allow);
  }
  const bp = el('button', 'ghost-btn', tt('chat-perms.modusBypasspermissions'));
  bp.onclick = () => { if ($('#permMode')) { $('#permMode').value = 'bypassPermissions'; $('#permMode').dispatchEvent(new Event('change', { bubbles: true })); } toast(tt('chat-perms.modusBypasspermissionsAnfrageErneut'), 'ok'); };
  row.appendChild(bp);
  box.appendChild(row);
  box.appendChild(el('div', 'upd-hint', tt('chat-perms.bypasspermissionsLaeuftOhneRueckfragen')));
  t.msgEl.appendChild(box);
  if (t === ACTIVE) scrollBottom();
}
let pendingPerm = null; let _permKey = null; let _permPrevFocus = null; const permQueue = [];
function showPermission(ev) {
  const t = chat; // owning tab (chat is swapped to it during event handling)
  const req = ev.request || {};
  const tool = req.tool_name || req.toolName || '';
  // "Immer erlauben" (this session): auto-approve tools the user already blessed for this tab,
  // without popping the modal. Tracked client-side — the CLI's native session addRules proved
  // unreliable at suppressing re-prompts in v2.1.207, so we own this.
  // ExitPlanMode is an explicit plan gate (+ leaves read-only mode) — never auto-allow it, always show the plan dialog.
  if (tool && tool !== 'ExitPlanMode' && t.alwaysAllow && t.alwaysAllow.has(tool)) {
    const requestId = ev.request_id || ev.requestId;
    api('/api/chat/' + t.id + '/permission', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, behavior: 'allow' }) }).catch(() => {});
    // Transparency: make the silent auto-approve visible (once per tool/session) so it never looks
    // like the panel "answered by itself" — there is no timeout; this only fires for tools you blessed.
    t._autoAllowSeen = t._autoAllowSeen || new Set();
    if (!t._autoAllowSeen.has(tool)) { t._autoAllowSeen.add(tool); if (t === ACTIVE) toast('✓ „' + tool + tt('chat-perms.automatischErlaubtImmerErlauben'), 'ok'); }
    // auto-approved silently → don't leave the tab stuck on "waiting for approval…"
    t.phase = hasOutstandingPerm(t) ? WAIT_APPROVAL : PHASE_WORKING; if (t === ACTIVE && typeof renderStatus === 'function') renderStatus();
    return;
  }
  const item = { ev, tab: t }; // bind the requesting tab
  // A12: a gate blocks the whole turn until it is answered — the one event most worth interrupting
  // another window for (a run left waiting at an approval is a run that isn't running).
  if (typeof chatNotify === 'function') chatNotify('🔐 ' + tt('html.freigabeAngefragt'), (tool || '') + ' · ' + t.title);
  if (pendingPerm) { permQueue.push(item); updatePermQueue(); return; }
  presentPerm(item);
}
// Show the gate and (re-)register it with the overlay stack. Esc belongs to the stack (overlays.js), not
// to this file and not to the global chain in commands.js — and THIS dialog is why: `resolvePerm` hides
// the overlay SYNCHRONOUSLY, so the keystroke that denied a tool then found the chain's „is the gate
// open?" test already false and ran on into „Esc twice stops the turn". Denying a permission armed the
// abort for the very turn that had asked for it, and the next Esc killed it.
// trap:false on purpose — the Tab cycle in presentPerm is DECISION order (Deny → Always → Persist →
// Allow), not DOM order, where the ⛶ width toggle in the head would come first. restoreFocus:false
// because _permPrevFocus has a fallback the stack does not (the composer).
function permOverlayShow() {
  const ov = $('#permOverlay');
  ov.classList.remove('hidden');
  overlayPush(ov, {
    trap: false, restoreFocus: false,
    alive: () => !ov.classList.contains('hidden'),
    onEsc: () => resolvePerm('deny'),
  });
  const a = $('#permAllow'); if (a) a.focus();
}
function presentPerm(item) {
  pendingPerm = item;
  const req = item.ev.request || {};
  const tool = req.tool_name || req.toolName || 'tool';
  const input = req.input || req.tool_input || {};
  // ExitPlanMode = "approve the plan & leave read-only plan mode" → show the actual plan (rendered),
  // not raw JSON, with plan-specific wording/buttons so it's clear this authorises leaving read-only.
  const isPlan = tool === 'ExitPlanMode' && !!(input && input.plan); // else fall back to the generic view
  // An Edit/Write gate is exactly the decision "may this change be applied" — and the transcript already
  // renders that same tool call as a word-level diff. Showing JSON.stringify(input) here meant reading a
  // \n-escaped old_string/new_string pair to approve a file change. Reuse the transcript's renderer (C4);
  // the plan branch already proves the body of this dialog can be swapped.
  const isDiff = !isPlan && (isEditInput(tool, input) || isWriteInput(tool, input));
  const titleEl = $('#permTitle'), toolLine = $('#permToolLine'), pre = $('#permInput'), planEl = $('#permPlan');
  const allowBtn = $('#permAllow'), denyBtn = $('#permDeny'), alwaysBtn = $('#permAllowAlways'), persistLbl = document.querySelector('.perm-persist');
  // A diff or a plan has to be read, not glanced at — widen the dialog for those bodies only, so a
  // plain "may I run this Bash command" gate stays a compact box. Full-bleed is a deliberate choice
  // via ⛶, not the default: 1180px for a two-button decision was overwhelming.
  const modalEl = $('#permModal'), maxBtn = $('#permMax');
  const bodyIsCode = isPlan || isDiff;
  if (modalEl) {
    modalEl.classList.toggle('is-wide', bodyIsCode);
    modalEl.classList.toggle('is-max', bodyIsCode && !!(typeof chatLayoutGet === 'function' && chatLayoutGet().permMax));
  }
  if (maxBtn) {
    maxBtn.classList.toggle('hidden', !bodyIsCode);
    const paint = () => {
      const on = modalEl && modalEl.classList.contains('is-max');
      maxBtn.textContent = on ? '⤡' : '⛶';
      maxBtn.title = on ? tt('chat-perms.kleinerAnzeigen') : tt('chat-perms.breiterAnzeigen');
      maxBtn.setAttribute('aria-pressed', String(!!on));
    };
    paint();
    maxBtn.onclick = (e) => {
      e.stopPropagation();
      const on = modalEl.classList.toggle('is-max');
      if (typeof chatLayoutSet === 'function') chatLayoutSet({ permMax: on });
      paint();
    };
  }
  if (planEl) planEl.classList.remove('perm-diff-body');
  if (isPlan) {
    if (titleEl) titleEl.textContent = tt('chat-perms.planZurFreigabe');
    if (toolLine) toolLine.classList.add('hidden');
    if (pre) pre.classList.add('hidden');
    if (planEl) { planEl.innerHTML = (typeof renderMarkdown === 'function') ? renderMarkdown(String(input.plan || '')) : mdEscape(String(input.plan || '')); planEl.classList.remove('hidden'); }
    if (allowBtn) allowBtn.textContent = tt('chat-perms.planAnnehmen');
    if (denyBtn) denyBtn.textContent = tt('chat-perms.weiterPlanen');
    if (alwaysBtn) alwaysBtn.classList.add('hidden');       // "always allow" makes no sense for a plan
    if (persistLbl) persistLbl.classList.add('hidden');
  } else {
    if (titleEl) titleEl.textContent = isDiff ? tt('chat-perms.aenderungZurFreigabe') : tt('html.freigabeAngefragt');
    if (toolLine) toolLine.classList.remove('hidden');
    $('#permTool').textContent = tool;
    if (isDiff && planEl) {
      const isWrite = isWriteInput(tool, input);
      const lang = (typeof extLang === 'function') ? extLang(input.file_path) : '';
      planEl.innerHTML = '';
      planEl.classList.add('perm-diff-body');
      if (input.file_path && typeof fileHeader === 'function') planEl.appendChild(fileHeader(input.file_path));
      planEl.appendChild(el('div', 'perm-diff-cap', isWrite ? tt('chat-perms.neueDatei') : tt('chat-perms.geplanteAenderung')));
      planEl.appendChild(renderDiff(isWrite ? '' : input.old_string, isWrite ? input.content : input.new_string, lang));
      planEl.classList.remove('hidden');
      if (pre) pre.classList.add('hidden');
    } else {
      if (pre) { pre.textContent = JSON.stringify(input, null, 2); pre.classList.remove('hidden'); }
      if (planEl) planEl.classList.add('hidden');
    }
    if (allowBtn) allowBtn.textContent = tt('common.erlauben');
    if (denyBtn) denyBtn.textContent = tt('common.ablehnen');
    if (alwaysBtn) alwaysBtn.classList.remove('hidden');
    if (persistLbl) persistLbl.classList.remove('hidden');
  }
  // optional context the CLI may attach: a human description and a blocked path
  const descEl = $('#permDesc');
  if (descEl) { const d = req.description || ''; descEl.textContent = d; descEl.classList.toggle('hidden', !d); }
  const blkEl = $('#permBlocked');
  if (blkEl) { const b = req.blocked_path || req.blockedPath || ''; blkEl.textContent = b ? ('⛔ ' + tt('chat-perms.blockierterPfad') + b) : ''; blkEl.classList.toggle('hidden', !b); }
  const persist = $('#permPersist'); if (persist) persist.checked = false;
  const tab = $('#permTab');
  if (item.tab !== ACTIVE) { tab.textContent = '↪ Tab: ' + item.tab.title; tab.classList.remove('hidden'); }
  else tab.classList.add('hidden');
  updatePermQueue();
  if ($('#permOverlay').classList.contains('hidden')) _permPrevFocus = document.activeElement; // restore target on close
  permOverlayShow();
  // The floating „Freigabe ausstehend" button re-opens this dialog through the waiter — through
  // permOverlayShow, not through a second `classList.remove('hidden')`: being shown again without being
  // pushed again is exactly an overlay whose Esc falls back into the global chain.
  registerPermWaiter('chat', permOverlayShow);
  setTimeout(() => { const a = $('#permAllow'); if (a) a.focus(); }, 0);
  if (_permKey) document.removeEventListener('keydown', _permKey, true);
  _permKey = (e) => {
    if (e.key === 'Enter') {
      // Enter acts on the FOCUSED control only — the old blanket Enter→allow let a stray
      // keystroke (e.g. the tail of a send) approve a tool. Swallowed otherwise: while the
      // gate is open, Enter must never fall through to the page.
      e.preventDefault();
      const a = document.activeElement;
      if (a === $('#permPersist')) a.checked = !a.checked;
      else if ([$('#permDeny'), $('#permAllowAlways'), $('#permAllow')].includes(a)) a.click();
    }
    else if (e.key === 'Tab') {
      // cycle all VISIBLE controls incl. the persist checkbox (it was unreachable by keyboard).
      // isTabbable, not offsetParent: a `visibility:hidden` button keeps its layout box, so the old test
      // would have put the caret on a control the user cannot see (overlays.js).
      const f = [$('#permDeny'), $('#permAllowAlways'), $('#permPersist'), $('#permAllow')].filter((x) => x && isTabbable(x));
      const i = f.indexOf(document.activeElement); e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    }
  };
  document.addEventListener('keydown', _permKey, true);
}
function updatePermQueue() {
  const q = $('#permQueue'); if (!q) return;
  if (permQueue.length) { q.textContent = '+' + permQueue.length + tt('chat-perms.wartend'); q.classList.remove('hidden'); }
  else q.classList.add('hidden');
}
async function resolvePerm(behavior, opts) {
  opts = opts || {};
  if (_permKey) { document.removeEventListener('keydown', _permKey, true); _permKey = null; }
  if (!pendingPerm) return;
  const { ev, tab } = pendingPerm;
  const req = ev.request || {};
  const requestId = ev.request_id || ev.requestId;
  const tool = req.tool_name || req.toolName || '';
  pendingPerm = null;
  const next = permQueue.shift();
  if (next) presentPerm(next);               // keep overlay up for the next request (re-registers 'chat')
  else {
    $('#permOverlay').classList.add('hidden'); overlayPop($('#permOverlay')); clearPermWaiter('chat');
    // give focus back to where it was before the gate opened (composer as the natural fallback)
    const prev = _permPrevFocus; _permPrevFocus = null;
    if (prev && document.contains(prev) && prev.offsetParent !== null) { try { prev.focus(); } catch { /* */ } }
    else { const c = $('#composerInput'); if (c && c.offsetParent !== null) c.focus(); }
  }
  if (behavior === 'allow' && opts.always && tool) {
    tab.alwaysAllow = tab.alwaysAllow || new Set();
    tab.alwaysAllow.add(tool);                                   // this session: auto-approve from now on
    if (tab === ACTIVE && typeof renderStatusBar === 'function') renderStatusBar(); // show it as a revocable chip (C14)
    if (opts.persist && typeof localPermAdd === 'function') {  // dauerhaft: also persist for future sessions + Settings
      try { await localPermAdd('allow', tool); } catch { /* localPermAdd reports its own failure */ }
    }
  }
  // the turn continues after answering → clear the "waiting for approval…" phase (unless more are queued for this tab)
  if (tab) { tab.phase = hasOutstandingPerm(tab) ? WAIT_APPROVAL : PHASE_WORKING; if (tab === ACTIVE && typeof renderStatus === 'function') renderStatus(); }
  // ExitPlanMode "allow" via the residual modal = accept the plan → use the shared continuation lever
  // (deny+directive + leave plan mode); a bare allow would wedge the turn exactly like the inline card.
  // The tool_use id goes along: without it postGateReply dropped ASK_GATES.get(undefined) — i.e. nothing —
  // so the plan's gate entry stayed behind, and the plan rail could not tell WHICH proposal was approved.
  if (behavior === 'allow' && tool === 'ExitPlanMode' && tab && tab.id) { resolvePlanGate(tab, requestId, true, null, null, req.tool_use_id || req.toolUseId); return; }
  try {
    await api('/api/chat/' + tab.id + '/permission', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, behavior }) });
  } catch (e) { if (!(typeof healDeadChat === 'function' && healDeadChat(tab, e))) toast(e.message, 'err'); } // reaped chat → recover the session (#25)
}
// A closed tab must not leave its permission gate behind: Erlauben/Ablehnen would POST to a stopped chat,
// and the 'chat' waiter kept re-opening the overlay for a tab that is no longer in TABS (same family as C1).
function dropPermsForTab(tab) {
  for (let i = permQueue.length - 1; i >= 0; i--) if (permQueue[i].tab === tab) permQueue.splice(i, 1);
  if (pendingPerm && pendingPerm.tab === tab) {
    pendingPerm = null;
    if (_permKey) { document.removeEventListener('keydown', _permKey, true); _permKey = null; }
    const next = permQueue.shift();
    if (next) presentPerm(next);                 // keep the overlay up for another tab's request
    else { $('#permOverlay').classList.add('hidden'); overlayPop($('#permOverlay')); clearPermWaiter('chat'); }
  }
  updatePermQueue();
}
$('#permAllow').onclick = () => resolvePerm('allow');
$('#permDeny').onclick = () => resolvePerm('deny');
if ($('#permAllowAlways')) $('#permAllowAlways').onclick = () => resolvePerm('allow', { always: true, persist: $('#permPersist') && $('#permPersist').checked });

// Bootstrap the first chat tab. MUST run here — the last chat-* module — because activateTab() references
// functions spread across chat-render/status/composer (startTurnStatus, scrollBottom, renderAgentStrip, …);
// running it in the chat.js core (as before the split) would hit them before those files load. boot.js's
// restoreTabs() runs after this and reuses TABS[0].
activateTab(makeTab()); // first tab

