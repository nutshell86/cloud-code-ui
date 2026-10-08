// Part of the Claude Code Control Panel front-end (split from app.js).
// Classic scripts share one global scope; load order in index.html is authoritative: render → chat → sessions → views → commands → boot.
// This file: dialogs.js

// ============================================================
//  DIALOGS — every modal dialog of the panel in one place
// ============================================================
// C3: these three blocks were MOVED here unchanged. They were scattered across view files although
// every view uses them: the generic uiModal/uiConfirm/uiAlert/uiPrompt sat in views-uiskills.js (a
// single view), the #mcpOverlay lifecycle in views-mcp.js and the #cfgOverlay lifecycle in
// views-system.js. The overlay STACK (overlays.js) has to touch all of them, and a shared mechanism
// whose users live in four files is how the next dialog gets opened without one.
// The view-specific WIRING ($('#mcpAdd').onclick, $('#cfgSave').onclick, …) deliberately stayed behind
// in the views: it is not a dialog, it is what a view does with one.
//
// Everything BELOW the three moved blocks' own comments that mentions overlayPush/overlayPop is the
// SECOND half of PR-9a and not part of the move: each dialog used to carry its own Esc/Tab handler on
// `document`, and three handlers on one key with no notion of „topmost" is what VIEWS-ESC was.

// --- generic app modal (styled replacement for native confirm()/prompt()) ---
// The i18n keys below still carry the `views-uiskills.` prefix from where this code used to live. Renaming
// them means touching both locale blocks for a label that is already correct in both languages, so the
// prefix stays and this sentence explains it — it is a file name in a key, not a wrong string.
// opts: { icon, title, message, body(node), input:{label,value,placeholder,multiline,rows},
//         actions:[{label,value,kind,primary,returnsInput}], escValue }
// resolves with the chosen action's value (or the input text for returnsInput actions).
function uiModal(opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    let settled = false, release = null;
    const finish = (v) => {
      // overlayPop (via release) untraps and hands focus back to the opener — for a dialog raised from
      // INSIDE another overlay that is a control in the overlay underneath, not a node in the page behind.
      if (settled) return; settled = true;
      if (release) release();
      ov.remove();
      resolve(v);
    };
    const ov = el('div', 'modal-overlay'); ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
    const box = el('div', 'modal');
    if (opts.wide) box.classList.add('modal-wide');
    const head = el('div', 'modal-head');
    head.appendChild(el('span', 'perm-icon', opts.icon || '❓'));
    head.appendChild(el('h3', null, opts.title || t('views-uiskills.bestaetigen')));
    box.appendChild(head);
    if (opts.message) { const msg = el('div', 'modal-msg'); msg.textContent = opts.message; box.appendChild(msg); }
    if (opts.body) box.appendChild(opts.body);
    let inp = null;
    if (opts.input) {
      if (opts.input.label) box.appendChild(el('label', 'ui-flabel', opts.input.label));
      inp = opts.input.multiline ? el('textarea', 'ui-input ui-textarea') : el('input', 'ui-input');
      if (opts.input.multiline) inp.rows = opts.input.rows || 4;
      inp.value = opts.input.value != null ? opts.input.value : '';
      if (opts.input.placeholder) inp.placeholder = opts.input.placeholder;
      inp.style.width = '100%';
      box.appendChild(inp);
    }
    const acts = el('div', 'modal-actions');
    const actions = opts.actions || [{ label: t('html.abbrechen'), value: false }, { label: t('views-uiskills.ok'), value: true, primary: true }];
    actions.forEach((a) => {
      const b = el('button', a.primary ? 'primary-btn' : (a.kind || 'ghost-btn'), a.label);
      b.onclick = () => finish(a.returnsInput ? (inp ? inp.value : '') : a.value);
      acts.appendChild(b);
    });
    box.appendChild(acts);
    const defDismiss = () => (opts.escValue !== undefined ? opts.escValue : (opts.input ? null : false));
    ov.onclick = (e) => { if (e.target === ov) finish(defDismiss()); };
    ov.appendChild(box); document.body.appendChild(ov);
    // Esc + Tab + z-index are the stack's now (overlays.js). Enter, too — and with a FOCUS CHECK it did
    // not have: `Enter && opts.input && !multiline` fired wherever the caret was, so Tab-to-„Abbrechen"
    // plus Enter resolved with the input's text, i.e. Cancel saved (UX-MODAL-ENTER). The stack hands
    // Enter to a button/textarea/select/link that is focused and only falls back to onEnter otherwise.
    // autofocus:false — this dialog has its own target below (the input, else the primary button).
    release = overlayPush(ov, {
      box,
      autofocus: false,
      onEsc: () => finish(defDismiss()),
      // `inp.value` unguarded on purpose: this branch only exists when opts.input is set, and that is the
      // same condition that created `inp` above. The old code read `inp ? inp.value : true` here — a dead
      // else-branch whose value silently differed from the one two lines up, which is how „why does this
      // dialog resolve with `true`?" becomes a half-hour. One reachable answer or none.
      onEnter: (opts.input && !opts.input.multiline) ? () => finish(inp.value) : null,
    });
    setTimeout(() => { const f = inp || box.querySelector('.primary-btn') || box.querySelector('button'); if (f) f.focus(); }, 0);
  });
}
// confirm() replacement → resolves boolean
function uiConfirm(message, opts) {
  opts = opts || {};
  return uiModal({
    icon: opts.icon || (opts.danger ? '⚠' : '❓'),
    title: opts.title || t('views-uiskills.bestaetigen'),
    message, escValue: false,
    actions: [
      { label: opts.cancelLabel || t('html.abbrechen'), value: false },
      { label: opts.okLabel || t('views-uiskills.ok'), value: true, primary: !opts.danger, kind: opts.danger ? 'danger-btn' : null }
    ]
  }).then((v) => v === true);
}
// alert() replacement — one button, no choice. For a message that must SURVIVE being read: a toast is
// gone after four seconds, which is not enough for "the update failed because …".
function uiAlert(message, opts) {
  opts = opts || {};
  return uiModal({
    icon: opts.icon || (opts.danger ? '⚠' : 'ℹ'),
    title: opts.title || t('views-uiskills.hinweis'),
    message, escValue: true,
    actions: [{ label: opts.okLabel || t('views-uiskills.ok'), value: true, primary: true }],
  }).then(() => undefined);
}
// prompt() replacement → resolves string, or null on cancel
function uiPrompt(message, def, opts) {
  opts = opts || {};
  return uiModal({
    icon: opts.icon || '✎',
    title: opts.title || message,
    message: opts.title ? message : '',
    input: { label: opts.label || '', value: def || '', placeholder: opts.placeholder || '', multiline: !!opts.multiline, rows: opts.rows },
    escValue: null,
    actions: [
      { label: t('html.abbrechen'), value: null },
      { label: opts.okLabel || t('views-uiskills.ok'), returnsInput: true, primary: true }
    ]
  });
}

// Add-server modal
// a11y: an overlay that only toggles .hidden leaves focus stranded inside an invisible dialog —
// remember the opener and hand focus back on close (same contract as uiModal).
// The opener/untrap bookkeeping these two used to keep by hand is the stack's job now; `alive` is the
// one thing they have to say for themselves, because a `.hidden` overlay is still in the document and
// the stack's default liveness test (isConnected) would never retire them.
function openMcpOverlay() {
  const ov = $('#mcpOverlay');
  ov.classList.remove('hidden');
  // Keep Tab inside the dialog (B16): without a trap it walked into the page behind the overlay, where
  // clicks are blocked but focus is not. Own autofocus target (#ma-name), so the trap must not focus.
  // Esc reaches here through the stack — it used to be a line in commands.js's global chain.
  overlayPush(ov, {
    box: ov.querySelector('.modal'), autofocus: false,
    alive: () => !ov.classList.contains('hidden'),
    onEsc: closeMcpOverlay,
    onEnter: () => { const b = $('#ma-submit'); if (b) b.click(); },   // UX-MODAL-ENTER: Enter in any of
    // the seven single-line fields did NOTHING — the only way to add a server was to Tab to the button.
  });
  setTimeout(() => { const f = $('#ma-name'); if (f) f.focus(); }, 0);
}
function closeMcpOverlay() {
  $('#mcpOverlay').classList.add('hidden');
  overlayPop($('#mcpOverlay'));
}
// a11y: the cfg overlay only toggles .hidden, so focus used to stay inside an invisible dialog after
// Save/Cancel/Esc — remember the opener and hand focus back (same contract as uiModal).
function openCfgOverlay() {
  const ov = $('#cfgOverlay');
  ov.classList.remove('hidden');
  // This dialog focused NOTHING on open and let Tab escape into the page behind it (B16) — the trap does
  // both: cycle inside, and put the caret on the first control. No onEnter: the body is a <textarea>,
  // where Enter is a newline and taking it away would be the opposite of expected.
  overlayPush(ov, {
    box: ov.querySelector('.modal') || ov,
    alive: () => !ov.classList.contains('hidden'),
    onEsc: closeCfgOverlay,
  });
}
function closeCfgOverlay() {
  $('#cfgOverlay').classList.add('hidden');
  overlayPop($('#cfgOverlay'));
}
