// Part of the Claude Code Control Panel front-end (split from app.js).
// Classic scripts share one global scope; load order in index.html is authoritative: render → chat → sessions → views → commands → boot.
// This file: overlays.js

// ============================================================
//  OVERLAYS — the stack, the focus trap, and the ONE owner of Esc
// ============================================================
//
// WHY A STACK (PR-9a). FOURTEEN overlays existed (counted, see the roll-call in
// test/overlay-stack.test.js), Esc was handled in seven different places, and nothing knew which one was
// on top. Three measured consequences:
//
//   · VIEWS-ESC — the dangerous one. Five of the seven own handlers called `preventDefault()` and nothing
//     else, so the event kept travelling to the global chain in commands.js. That chain ends in
//     „Esc twice stops the running turn". Closing the tool-permission gate with Esc therefore ALSO armed
//     the abort: `resolvePerm` hides #permOverlay synchronously, so the chain's own „is the perm dialog
//     open?" test was already false by the time it ran, and the next Esc killed the turn. Same for the
//     command palette, whose closeCmdk() sat BELOW the interrupt branch in the very same handler.
//   · Esc closed MORE than one thing: a dialog over an open sidecar lost both at once.
//   · FOUR overlays had no Esc handler at all: the two UI-skill pickers, the file picker and the
//     edit-prompt dialog. Esc there fell straight into the global chain.
//
// The contract now: a registered overlay OWNS Esc while it is on top. The handler below runs in the
// capture phase on `document` and calls stopImmediatePropagation(), so neither another document listener
// (chat-perms' Enter/Tab handler) nor the bubble-phase chain in commands.js can see that keystroke.
// An overlay may DECLINE to close (openModelCompare refuses while a column still streams) — it still
// swallows the key, because the alternative is the abort arming behind a dialog the user can see.
//
// Z-INDEX (ZINDEX-1) is the same problem one layer down: `.modal-overlay` was 50 and
// `.ui-result-max-overlay` 60, so a uiConfirm() raised from inside a maximised result card opened BEHIND
// it. The stack is the only place that knows the order, so the stack assigns the z-index: every overlay
// class now shares one CSS floor (--z-overlay) and depth decides. One mechanism, not two repairs.
//
// Band, so the two things that must stay above a dialog keep working (see styles.css):
//   500 + depth*10  overlays        · 900  toasts (an error raised BY a dialog has to be readable)
//   950  context menus
const OVERLAY_Z_BASE = 500;
const OVERLAY_Z_STEP = 10;

// ---------------- focus trap ----------------
// THE TRAP'S OWN TRAP: a focus trap that also catches what cannot be focused is worse than no trap at
// all — it moves the caret onto a `disabled` button or a `display:none` input, the browser leaves focus
// where it was, and Tab stops doing anything. So tabbability is DECIDED here, element by element, rather
// than delegated to a CSS selector: `[tabindex]:not([tabindex="-1"])` (the old selector) says nothing
// about disabled, hidden, inert or visibility, and a selector cannot be unit-tested.
const FOCUS_SEL = 'a[href], area[href], button, input, select, textarea, summary, iframe,'
  + ' [contenteditable=""], [contenteditable="true"], [tabindex]';

function overlayCss(node) {
  try { return typeof getComputedStyle === 'function' ? getComputedStyle(node) : null; } catch { return null; }
}
// Is this element on screen and interactive at all? Also the test for „may I hand focus BACK to it"
// after an overlay closes — a node that has meanwhile been removed or hidden is not a focus target.
function overlayRendered(e) {
  if (!e || e.nodeType !== 1) return false;
  const cs = overlayCss(e);
  // display:none — on the element OR on any ancestor — collapses offsetParent, which is why the
  // ancestor walk below does not have to repeat it. position:fixed legitimately has no offsetParent,
  // so it must not be mistaken for „not rendered".
  if (e.offsetParent == null && !(cs && cs.position === 'fixed')) return false;
  // visibility is INHERITED, so the element's own computed value already answers for its ancestors
  if (cs && (cs.visibility === 'hidden' || cs.visibility === 'collapse')) return false;
  // inert / hidden / aria-hidden take an element out of the interaction tree WITHOUT touching layout,
  // so offsetParent says nothing about them → walk up.
  for (let n = e; n && n.nodeType === 1; n = n.parentNode) {
    if (n.inert === true || n.hidden === true) return false;
    if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return false;
  }
  return true;
}
// Can the user reach this element with Tab, right now?
function isTabbable(e) {
  if (!e || e.disabled) return false;
  const tag = String(e.tagName || '').toLowerCase();
  if (tag === 'input' && String(e.type || '').toLowerCase() === 'hidden') return false;
  // tabindex="-1" is „focusable by script", the explicit opposite of „reachable by Tab"
  const ti = e.getAttribute ? e.getAttribute('tabindex') : null;
  if (ti != null && ti !== '' && Number(ti) < 0) return false;
  return overlayRendered(e);
}
function focusableIn(box) {
  if (!box || typeof box.querySelectorAll !== 'function') return [];
  return [...box.querySelectorAll(FOCUS_SEL)].filter(isTabbable);
}
// Keep Tab inside a dialog. Returns a detach function.
// Moved here from render.js (it was shared by #mcpOverlay/#cfgOverlay already) and hardened: the old
// version filtered on `!disabled && offsetParent !== null`, which let a `visibility:hidden` control into
// the cycle (visibility keeps the layout box) and dropped a legitimately `position:fixed` one.
function trapFocus(box, opts) {
  opts = opts || {};
  if (!box) return () => {};
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const f = focusableIn(box);
    // NOTHING tabbable: do not preventDefault. A dialog with no reachable control is a bug, but holding
    // the caret there would make it a dead end the user cannot leave at all.
    if (!f.length) return;
    e.preventDefault();
    const i = f.indexOf(document.activeElement);
    // focus outside the box (the dialog opened without autofocus, or the page stole it back):
    // Tab enters at the front, Shift+Tab at the back. The old modulo answered f[len-2] for Shift.
    if (i < 0) { f[e.shiftKey ? f.length - 1 : 0].focus(); return; }
    f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
  };
  box.addEventListener('keydown', onKey);
  if (opts.autofocus !== false) {
    setTimeout(() => { const f = focusableIn(box); if (f.length) { try { f[0].focus(); } catch { /* */ } } }, 0);
  }
  return () => box.removeEventListener('keydown', onKey);
}

// ---------------- the stack ----------------
// Entry: { node, box, onEsc, onEnter, untrap, opener, alive, restoreFocus }
const OVERLAY_STACK = [];

// Default liveness: the node is still in the document. Static overlays that only toggle `.hidden` pass
// their own `alive` — for them „removed" means hidden.
function overlayAlive(en) {
  if (!en || !en.node) return false;
  if (typeof en.alive === 'function') { try { return !!en.alive(); } catch { return false; } }
  return en.node.isConnected !== false;
}
// SELF-DEREGISTRATION is not optional. FIVE of the fourteen overlays disappeared through a bare
// `ov.remove()` — thirteen such call sites, counted: three each in pickFileModal, uiEditPromptModal,
// uiskillFromSkillPick and openSkillLauncher (cancel, scrim, row click) plus one in openModelCompare.
// Every one of those would leave a corpse on the stack, the stack would only ever grow, and Esc
// would keep „closing" dead overlays — i.e. do nothing at all, forever. So the stack never trusts its
// own bookkeeping: it drops dead entries before every read.
function overlayPrune() {
  for (let i = OVERLAY_STACK.length - 1; i >= 0; i--) {
    if (overlayAlive(OVERLAY_STACK[i])) continue;
    const en = OVERLAY_STACK.splice(i, 1)[0];
    if (en.untrap) { try { en.untrap(); } catch { /* */ } }
  }
  return OVERLAY_STACK.length;
}
function overlayCount() { return overlayPrune(); }
function overlayTop() { overlayPrune(); return OVERLAY_STACK[OVERLAY_STACK.length - 1] || null; }
// (no overlayHas(node) here on purpose: nothing reads it. overlayPush is already idempotent per node,
// which is the one question a caller would have asked it.)

// opts: { box, onEsc, onEnter, trap (default true), autofocus, alive, restoreFocus (default true) }
// Returns a release function; calling it twice is harmless.
function overlayPush(node, opts) {
  opts = opts || {};
  overlayPrune();
  if (!node) return () => {};
  const existing = OVERLAY_STACK.find((en) => en.node === node);
  if (existing) {                                   // re-shown static overlay (the permission queue does this)
    if (opts.onEsc) existing.onEsc = opts.onEsc;
    if (opts.onEnter) existing.onEnter = opts.onEnter;
    return () => overlayPop(node);
  }
  const box = opts.box || node;
  const en = {
    node, box,
    onEsc: opts.onEsc || null,
    onEnter: opts.onEnter || null,
    alive: opts.alive || null,
    restoreFocus: opts.restoreFocus !== false,
    opener: (typeof document !== 'undefined' && document.activeElement) || null,
    untrap: null,
  };
  OVERLAY_STACK.push(en);
  // depth AFTER the push, so the first overlay sits on the floor and each further one above it
  if (node.style) node.style.zIndex = String(OVERLAY_Z_BASE + (OVERLAY_STACK.length - 1) * OVERLAY_Z_STEP);
  if (opts.trap !== false) en.untrap = trapFocus(box, { autofocus: opts.autofocus });
  return () => overlayPop(node);
}
function overlayPop(node) {
  const i = OVERLAY_STACK.findIndex((en) => en.node === node);
  if (i < 0) { overlayPrune(); return; }
  const en = OVERLAY_STACK.splice(i, 1)[0];
  if (en.untrap) { try { en.untrap(); } catch { /* */ } }
  overlayPrune();
  // hand focus back to whatever had it when this overlay opened — for a stacked dialog that is a control
  // INSIDE the overlay underneath, which is exactly where the user was
  // overlayRendered, NOT isTabbable: a `tabindex="-1"` row is a perfectly good place to put the caret
  // back, it just is not a Tab stop.
  if (en.restoreFocus && en.opener && typeof en.opener.focus === 'function'
      && document.contains(en.opener) && overlayRendered(en.opener)) {
    try { en.opener.focus(); } catch { /* */ }
  }
}

// ---------------- keys ----------------
// Enter inside a dialog should do the dialog's main thing (UX-MODAL-ENTER) — but only where nothing else
// already owns the key. A textarea owns Enter (newline), a button/link/summary owns it (activate), a
// <select> owns it (commit). uiModal used to ignore all of that: with a single-line input it resolved
// with the input's text on ANY Enter, so Tab-to-„Abbrechen" + Enter SAVED.
//
// ASKED THE OTHER WAY ROUND, and that is the whole point. The first cut of this file asked „does the
// focused element OWN Enter?" against a list of tag names — a blocklist, which can never be complete.
// A hit row in the full-text search and the prompt history is a DIV that `mkClickable()` (render.js)
// turns into `role="button"` + `tabindex`; a DIV is on no tag list, so the stack claimed Enter, called
// stopImmediatePropagation() in the CAPTURE phase, and render.js's global role=button activator — a
// BUBBLE listener on `document` — never saw the key again. Enter on a focused row did nothing at all and
// the caret jumped back to row 1, because onEnter is „focus the first row". That is this project's
// recurring failure shape one more time: the logic was right, the layer above swallowed the result.
// So the question is now an ALLOWLIST: onEnter fires only from a single-line text field, which is what
// all six callers mean by it („Enter in diesem Feld tut die Hauptsache"). Everything else keeps the key —
// buttons, links, rows, custom widgets, a textarea, or nothing focused at all. A new kind of control
// inside a dialog is then silently CORRECT instead of silently broken.
const ENTER_ACTIVATES = ['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'range'];
function overlayEnterFires(a) {
  if (!a || String(a.tagName || '').toLowerCase() !== 'input') return false;
  // type="checkbox"/"radio"/"button"/… : Enter there means „activate this control", not „submit the form"
  return ENTER_ACTIVATES.indexOf(String(a.type || 'text').toLowerCase()) < 0;
}
// „Enter in a search field should get me to the results." Four overlays (the full-text search, the
// prompt history, the skill launcher, the file picker) focused their input on open and then did NOTHING
// with Enter — the rows were mouse-only unless you knew to Tab past the input. This moves the caret to the FIRST row
// rather than opening it: these lists have no visible selection (the command palette has one and owns
// Enter itself), and silently activating an unmarked row is how one keystroke opens the wrong session.
// The SECOND Enter — the one on the now-focused row — is render.js's global role=button activator, and
// that only works because overlayEnterFires() above hands the key back outside a text field. The seam is
// tested with the real handler sliced out of render.js, not with a copy of it.
function overlayFocusFirst(listEl, sel) {
  if (!listEl || typeof listEl.querySelector !== 'function') return false;
  const first = listEl.querySelector(sel || '[role="button"]');
  if (!first || !isTabbable(first)) return false;
  try { first.focus(); } catch { return false; }
  return true;
}
// `true` = handled, the caller must not look further. Exported for the test harness; the listener below
// is the only production caller.
function overlayKeydown(e) {
  if (!e) return false;
  if (e.key === 'Escape') {
    const top = overlayTop();
    if (!top) return false;
    // Swallow FIRST, decide second: a dialog that declines to close must still not let Esc through to
    // the „stop the turn" branch.
    if (e.preventDefault) e.preventDefault();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    else if (e.stopPropagation) e.stopPropagation();
    if (top.onEsc) { try { top.onEsc(e); } catch { /* an overlay's own close must not wedge the key */ } }
    return true;
  }
  if (e.key === 'Tab') {
    // trapFocus listens on the BOX, so it only sees Tab while focus is inside the dialog. Focus can be
    // outside it (a click on a non-focusable area inside the overlay lands on <body> in every browser) —
    // and then Tab used to walk the page behind the overlay, which is the whole defect B16 is about.
    // This is the recovery, and it lives here because only the stack knows which overlay is on top.
    const top = overlayTop();
    if (!top || !top.untrap) return false;                     // the overlay opted out of a trap
    const a = document.activeElement;
    if (a && top.box && top.box.contains && top.box.contains(a)) return false; // the box's own trap owns it
    const f = focusableIn(top.box);
    if (!f.length) return false;                               // nothing to hold on to (see trapFocus)
    if (e.preventDefault) e.preventDefault();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    try { f[e.shiftKey ? f.length - 1 : 0].focus(); } catch { /* */ }
    return true;
  }
  if (e.key === 'Enter') {
    const top = overlayTop();
    if (!top || !top.onEnter) return false;
    if (!overlayEnterFires(typeof document !== 'undefined' ? document.activeElement : null)) return false;
    if (e.preventDefault) e.preventDefault();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    else if (e.stopPropagation) e.stopPropagation();
    try { top.onEnter(e); } catch { /* */ }
    return true;
  }
  return false;
}
// Capture phase, registered at load: this file is the FIRST keydown listener on `document`, so it wins
// over every per-overlay handler registered later (same node, same phase → registration order).
document.addEventListener('keydown', overlayKeydown, true);
