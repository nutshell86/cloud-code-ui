'use strict';
// PR-9a — the overlay stack, the focus trap, and the ONE owner of Esc.
//
// WHY THIS FILE EXISTS, in the words of the failure it guards: „Esc mit offener Palette während eines
// laufenden Turns schaltet den Abbruch scharf." FOURTEEN overlays existed and Esc was handled in seven
// different places; five of those handlers called preventDefault() and nothing else and four overlays had
// no handler at all, so the keystroke carried on to the global chain in commands.js whose last branch is
// „press Esc twice to stop the turn". Closing a dialog therefore armed the abort for the turn behind it.
// (Thirteen overlays now: the edit-prompt dialog turned out to be a uiModal and stopped being its own.)
// That is not a logic bug inside a function —
// it is a bug in the SEAM between two handlers, so testing either one alone proves nothing. This suite
// loads BOTH real files into one vm context with a mini event dispatcher and presses the key.
//
// „This project has no DOM test environment" is false: node:vm plus the stubs below load the real
// browser files. Two traps learned here, both of which produced a green test for the wrong reason while
// this file was being written:
//   · a top-level `const` in a vm script is NOT a property of the context object (a `function` is), so
//     OVERLAY_STACK is read back with runInContext — `sandbox.OVERLAY_STACK` is undefined. Asserted below.
//   · the fake element's `offsetParent` must be TRUTHY by default. With the natural-looking `null` every
//     element counts as not-rendered, focusableIn() returns [] everywhere, and the whole trap suite goes
//     green without ever cycling anything.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
// An array built INSIDE the vm carries the vm realm's Array.prototype, and deepStrictEqual compares
// prototypes — so every list that comes back out is re-homed here before it is compared. Without this the
// assertions failed with 'same structure but not reference-equal', which reads like a real defect.
const here = (x) => Array.from(x);
const PUB = path.join(ROOT, 'public', 'js');

// ---------------------------------------------------------------- fake DOM
// Selector support is deliberately real enough that FOCUS_SEL is EXERCISED rather than bypassed: if a
// clause is dropped from it in overlays.js, the matching element stops showing up here.
function matches(el, sel) {
  const s = sel.trim();
  const m = /^([a-z]+)?(?:\.([\w-]+))?(?:\[([\w-]+)(?:=["']([^"']*)["'])?\])?$/i.exec(s);
  if (!m) throw new Error('fake querySelector: unsupported selector ' + JSON.stringify(sel));
  const [, tag, cls, attr, val] = m;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  if (cls && !el.classList.contains(cls)) return false;
  if (attr) {
    const got = el.getAttribute(attr);
    if (got == null) return false;
    if (val != null && got !== val) return false;
  }
  return true;
}

function makeDoc() {
  const doc = {
    activeElement: null,
    _listeners: [],
    addEventListener(type, fn, capture) { doc._listeners.push({ type, fn, capture: !!capture }); },
    removeEventListener(type, fn, capture) {
      const i = doc._listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === !!capture);
      if (i >= 0) doc._listeners.splice(i, 1);
    },
    contains(n) { for (let p = n; p; p = p.parentNode) if (p === doc.body || p === doc.documentElement) return true; return false; },
    querySelector() { return null; },
  };
  doc.body = mkEl('body', doc); doc.body.parentNode = null; doc.body._isRoot = true;
  doc.documentElement = mkEl('html', doc); doc.documentElement._isRoot = true;
  doc.activeElement = doc.body;
  return doc;
}

function mkEl(tag, doc, opts) {
  opts = opts || {};
  const classes = new Set(String(opts.cls || '').split(/\s+/).filter(Boolean));
  const el = {
    tagName: String(tag).toUpperCase(), nodeType: 1, parentNode: null, children: [],
    style: {}, _attrs: {}, _listeners: [], _doc: doc,
    // „rendered" by default — see the header note about offsetParent
    offsetParent: {}, _css: { position: 'static', visibility: 'visible' },
    disabled: false, hidden: false, inert: false, isContentEditable: false,
    focusCount: 0,
    classList: {
      contains: (c) => classes.has(c),
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c, on) => { const want = on === undefined ? !classes.has(c) : !!on; if (want) classes.add(c); else classes.delete(c); return want; },
    },
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n); },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    contains(n) { for (let p = n; p; p = p.parentNode) if (p === this) return true; return false; },
    focus() { doc.activeElement = this; this.focusCount++; },
    addEventListener(type, fn, capture) { this._listeners.push({ type, fn, capture: !!capture }); },
    removeEventListener(type, fn, capture) {
      const i = this._listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === !!capture);
      if (i >= 0) this._listeners.splice(i, 1);
    },
    querySelectorAll(sel) {
      const parts = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
      const out = [];
      const walk = (n) => { for (const c of n.children) { if (parts.some((p) => matches(c, p))) out.push(c); walk(c); } };
      walk(this);
      return out;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    get isConnected() { let p = this; while (p.parentNode) p = p.parentNode; return !!p._isRoot; },
  };
  if (classes.size) el.className = [...classes].join(' ');
  return el;
}

// Capture at `document` first, then bubble from the target up to `document` — the part of the DOM
// dispatch model this change depends on. stopPropagation() during the document CAPTURE phase also
// suppresses the document BUBBLE listeners, which is exactly why overlays.js can shield commands.js.
function dispatchKey(doc, key, opts) {
  opts = opts || {};
  const ev = {
    key, shiftKey: !!opts.shiftKey, ctrlKey: !!opts.ctrlKey, metaKey: !!opts.metaKey, altKey: !!opts.altKey,
    target: opts.target || doc.activeElement || doc.body,
    defaultPrevented: false, _stopped: false, _stoppedImmediate: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this._stopped = true; },
    stopImmediatePropagation() { this._stopped = true; this._stoppedImmediate = true; },
  };
  for (const l of doc._listeners.filter((x) => x.type === key_type(key) && x.capture)) {
    if (ev._stoppedImmediate) break;
    l.fn(ev);
  }
  if (ev._stopped) return ev;
  const chain = []; for (let p = ev.target; p; p = p.parentNode) chain.push(p);
  for (const node of chain) {
    for (const l of node._listeners.filter((x) => x.type === key_type(key) && !x.capture)) { if (ev._stoppedImmediate) break; l.fn(ev); }
    if (ev._stopped) return ev;
  }
  for (const l of doc._listeners.filter((x) => x.type === key_type(key) && !x.capture)) {
    if (ev._stoppedImmediate) break;
    l.fn(ev);
  }
  return ev;
}
const key_type = () => 'keydown';

// ---------------------------------------------------------------- load the real file
function loadOverlays(extra) {
  const doc = makeDoc();
  const ctx = Object.assign({
    document: doc,
    getComputedStyle: (n) => (n && n._css) || null,
    setTimeout: (fn) => { ctx._timers.push(fn); return 0; },     // run by hand via flush()
    clearTimeout: () => {},
    console, Math, JSON, String, Number, Array, Object, Boolean, Set, Map, RegExp, Date,
    _timers: [],
  }, extra || {});
  ctx.globalThis = ctx;
  const sandbox = vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(PUB, 'overlays.js'), 'utf8'), sandbox, { filename: 'overlays.js' });
  return {
    ctx, doc, sandbox,
    mk: (tag, o) => mkEl(tag, doc, o),
    flush() { const t = ctx._timers.splice(0); t.forEach((fn) => fn()); },
    stack: () => vm.runInContext('OVERLAY_STACK.map(function (e) { return e.node; })', sandbox),
    depth: () => vm.runInContext('OVERLAY_STACK.length', sandbox),
    esc: (opts) => dispatchKey(doc, 'Escape', opts),
    tab: (opts) => dispatchKey(doc, 'Tab', opts),
    enter: (opts) => dispatchKey(doc, 'Enter', opts),
  };
}
// An overlay: a scrim in document.body with a box inside and `n` buttons.
function mkOverlay(h, n) {
  const ov = h.mk('div', { cls: 'modal-overlay' });
  const box = h.mk('div', { cls: 'modal' });
  ov.appendChild(box);
  for (let i = 0; i < (n || 0); i++) { const b = h.mk('button'); b._label = 'b' + i; box.appendChild(b); }
  h.doc.body.appendChild(ov);
  return { ov, box, buttons: box.children.slice() };
}

describe('overlays.js — the harness itself', () => {
  it('a top-level const is NOT a context property, a function is (the vm trap)', () => {
    const h = loadOverlays();
    assert.equal(h.sandbox.OVERLAY_STACK, undefined, 'if this ever becomes defined, the readers below are reading a copy');
    assert.equal(typeof h.sandbox.overlayPush, 'function');
    assert.equal(h.depth(), 0);
  });
});

describe('isTabbable / focusableIn — the trap must not catch what cannot be focused', () => {
  // The whole point: a trap that moves the caret onto a disabled or invisible control leaves focus where
  // it was and Tab stops working — worse than no trap.
  const cases = [
    ['a plain button', (el) => el, true],
    ['disabled', (el) => { el.disabled = true; return el; }, false],
    ['hidden attribute', (el) => { el.hidden = true; return el; }, false],
    ['display:none (no offsetParent)', (el) => { el.offsetParent = null; return el; }, false],
    ['visibility:hidden', (el) => { el._css = { position: 'static', visibility: 'hidden' }; return el; }, false],
    ['visibility:collapse', (el) => { el._css = { position: 'static', visibility: 'collapse' }; return el; }, false],
    ['tabindex="-1"', (el) => { el.setAttribute('tabindex', '-1'); return el; }, false],
    ['tabindex="0"', (el) => { el.setAttribute('tabindex', '0'); return el; }, true],
    ['position:fixed without offsetParent', (el) => { el.offsetParent = null; el._css = { position: 'fixed', visibility: 'visible' }; return el; }, true],
    ['inert ancestor', (el) => { el.parentNode.inert = true; return el; }, false],
    ['aria-hidden ancestor', (el) => { el.parentNode.setAttribute('aria-hidden', 'true'); return el; }, false],
  ];
  for (const [name, mutate, want] of cases) {
    it((want ? 'keeps' : 'skips') + ' ' + name, () => {
      const h = loadOverlays();
      const { box } = mkOverlay(h, 1);
      mutate(box.children[0]);
      assert.equal(h.sandbox.isTabbable(box.children[0]), want);
      assert.equal(h.sandbox.focusableIn(box).length, want ? 1 : 0);
    });
  }
  it('skips input[type=hidden] but keeps a text input', () => {
    const h = loadOverlays();
    const { box } = mkOverlay(h, 0);
    const hid = h.mk('input'); hid.type = 'hidden'; box.appendChild(hid);
    const txt = h.mk('input'); txt.type = 'text'; box.appendChild(txt);
    assert.deepEqual(here(h.sandbox.focusableIn(box)), [txt]);
  });
  it('a `visibility:hidden` control is the one the OLD rule let through', () => {
    // the pre-PR-9a filter was `!e.disabled && e.offsetParent !== null`, and visibility:hidden keeps the
    // layout box — so this element WAS in the cycle and the caret landed on something invisible
    const h = loadOverlays();
    const { box } = mkOverlay(h, 2);
    box.children[0]._css = { position: 'static', visibility: 'hidden' };
    assert.notEqual(box.children[0].offsetParent, null, 'the old rule would have accepted it');
    assert.deepEqual(here(h.sandbox.focusableIn(box)), [box.children[1]]);
  });
  it('returns elements in document order', () => {
    const h = loadOverlays();
    const { box } = mkOverlay(h, 3);
    assert.deepEqual(here(h.sandbox.focusableIn(box)).map((b) => b._label), ['b0', 'b1', 'b2']);
  });
});

describe('trapFocus — cycling', () => {
  it('Tab wraps forward, Shift+Tab wraps backward', () => {
    const h = loadOverlays();
    const { box, buttons } = mkOverlay(h, 3);
    h.sandbox.trapFocus(box, { autofocus: false });
    buttons[2].focus();
    dispatchKey(h.doc, 'Tab', { target: buttons[2] });
    assert.equal(h.doc.activeElement, buttons[0], 'last + Tab → first');
    dispatchKey(h.doc, 'Tab', { target: buttons[0], shiftKey: true });
    assert.equal(h.doc.activeElement, buttons[2], 'first + Shift+Tab → last');
  });
  it('Shift+Tab from OUTSIDE the cycle enters at the back (the old modulo answered the second-to-last)', () => {
    const h = loadOverlays();
    const { box, buttons } = mkOverlay(h, 3);
    h.sandbox.trapFocus(box, { autofocus: false });
    const stray = h.mk('div'); box.appendChild(stray);        // focusable by nothing, so indexOf === -1
    h.doc.activeElement = stray;
    dispatchKey(h.doc, 'Tab', { target: box, shiftKey: true });
    assert.equal(h.doc.activeElement, buttons[2]);
  });
  it('skips a disabled control mid-cycle instead of parking on it', () => {
    const h = loadOverlays();
    const { box, buttons } = mkOverlay(h, 3);
    buttons[1].disabled = true;
    h.sandbox.trapFocus(box, { autofocus: false });
    buttons[0].focus();
    dispatchKey(h.doc, 'Tab', { target: buttons[0] });
    assert.equal(h.doc.activeElement, buttons[2]);
  });
  it('with NOTHING tabbable it does not preventDefault — a trap with no exit is worse than none', () => {
    const h = loadOverlays();
    const { box, buttons } = mkOverlay(h, 2);
    buttons.forEach((b) => { b.disabled = true; });
    h.sandbox.trapFocus(box, { autofocus: false });
    const ev = dispatchKey(h.doc, 'Tab', { target: box });
    assert.equal(ev.defaultPrevented, false);
  });
  it('autofocus puts the caret on the first tabbable, never on a disabled one', () => {
    const h = loadOverlays();
    const { box, buttons } = mkOverlay(h, 2);
    buttons[0].disabled = true;
    h.sandbox.trapFocus(box);
    h.flush();
    assert.equal(h.doc.activeElement, buttons[1]);
  });
  it('the detach function really detaches', () => {
    const h = loadOverlays();
    const { box, buttons } = mkOverlay(h, 2);
    const off = h.sandbox.trapFocus(box, { autofocus: false });
    off();
    buttons[1].focus();
    const ev = dispatchKey(h.doc, 'Tab', { target: buttons[1] });
    assert.equal(ev.defaultPrevented, false);
  });
});

describe('the stack — Esc closes the TOPMOST, focus returns to the one below', () => {
  it('two overlays: the top one closes first, then the lower one', () => {
    const h = loadOverlays();
    const a = mkOverlay(h, 1), b = mkOverlay(h, 1);
    const closed = [];
    h.sandbox.overlayPush(a.ov, { box: a.box, autofocus: false, onEsc: () => { closed.push('a'); a.ov.remove(); h.sandbox.overlayPop(a.ov); } });
    h.sandbox.overlayPush(b.ov, { box: b.box, autofocus: false, onEsc: () => { closed.push('b'); b.ov.remove(); h.sandbox.overlayPop(b.ov); } });
    h.esc();
    assert.deepEqual(closed, ['b'], 'the one opened last is the one on top');
    assert.deepEqual(here(h.stack()), [a.ov]);
    h.esc();
    assert.deepEqual(closed, ['b', 'a']);
    assert.equal(h.depth(), 0);
  });
  it('focus goes back INTO the overlay underneath, not to the page behind', () => {
    const h = loadOverlays();
    const a = mkOverlay(h, 1), b = mkOverlay(h, 1);
    const pageBtn = h.mk('button'); h.doc.body.appendChild(pageBtn); pageBtn.focus();
    h.sandbox.overlayPush(a.ov, { box: a.box, autofocus: false });
    a.buttons[0].focus();                                    // the user is working in the lower dialog…
    h.sandbox.overlayPush(b.ov, { box: b.box, autofocus: false });
    b.buttons[0].focus();                                    // …and the upper one takes over
    h.sandbox.overlayPop(b.ov);
    assert.equal(h.doc.activeElement, a.buttons[0]);
    h.sandbox.overlayPop(a.ov);
    assert.equal(h.doc.activeElement, pageBtn);
  });
  it('it does not hand focus back to a node that has meanwhile been removed', () => {
    const h = loadOverlays();
    const opener = h.mk('button'); h.doc.body.appendChild(opener); opener.focus();
    const a = mkOverlay(h, 1);
    h.sandbox.overlayPush(a.ov, { box: a.box, autofocus: false });
    opener.remove();
    const before = h.doc.activeElement;
    h.sandbox.overlayPop(a.ov);
    assert.equal(h.doc.activeElement, before);
  });
  it('an overlay may DECLINE to close and still swallows the key', () => {
    const h = loadOverlays();
    const a = mkOverlay(h, 1);
    let asked = 0;
    h.sandbox.overlayPush(a.ov, { box: a.box, autofocus: false, onEsc: () => { asked++; /* busy — refuse */ } });
    const ev = h.esc();
    assert.equal(asked, 1);
    assert.equal(h.depth(), 1);
    assert.equal(ev.defaultPrevented, true);
    assert.equal(ev._stoppedImmediate, true, 'a declined Esc must not travel on to the interrupt branch');
  });
  it('pushing the same node twice does not stack it twice (the permission queue re-shows one overlay)', () => {
    const h = loadOverlays();
    const a = mkOverlay(h, 1);
    h.sandbox.overlayPush(a.ov, { box: a.box, autofocus: false, onEsc: () => {} });
    let second = 0;
    h.sandbox.overlayPush(a.ov, { box: a.box, autofocus: false, onEsc: () => { second++; } });
    assert.equal(h.depth(), 1);
    h.esc();
    assert.equal(second, 1, 'the re-push must replace the handler, not be ignored');
  });
});

describe('the stack — z-index (ZINDEX-1)', () => {
  it('depth decides, so a dialog raised from a maximised result card lands ON TOP of it', () => {
    const h = loadOverlays();
    const card = mkOverlay(h, 1);      // stands in for .ui-result-max-overlay (CSS z-index was 60)
    const dialog = mkOverlay(h, 1);    // stands in for .modal-overlay        (CSS z-index was 50)
    h.sandbox.overlayPush(card.ov, { box: card.box, autofocus: false });
    h.sandbox.overlayPush(dialog.ov, { box: dialog.box, autofocus: false });
    const lower = Number(card.ov.style.zIndex), upper = Number(dialog.ov.style.zIndex);
    assert.ok(Number.isFinite(lower) && Number.isFinite(upper), 'both must get a z-index at all');
    assert.ok(upper > lower, 'the dialog opened last must paint above the card: ' + upper + ' vs ' + lower);
  });
  it('the floor matches the CSS band (--z-overlay), so an unregistered overlay is not above a registered one', () => {
    const h = loadOverlays();
    const a = mkOverlay(h, 1);
    h.sandbox.overlayPush(a.ov, { box: a.box, autofocus: false });
    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
    const m = /--z-overlay:\s*(\d+)/.exec(css);
    assert.ok(m, '--z-overlay is gone from styles.css — the band has two sources of truth again');
    assert.equal(Number(a.ov.style.zIndex), Number(m[1]));
  });
});

describe('the stack — self-deregistration (a corpse must not block Esc forever)', () => {
  it('an overlay removed with removeChild and no overlayPop is pruned', () => {
    const h = loadOverlays();
    const a = mkOverlay(h, 1);
    h.sandbox.overlayPush(a.ov, { box: a.box, autofocus: false, onEsc: () => {} });
    assert.equal(h.depth(), 1);
    h.doc.body.removeChild(a.ov);                    // the bare `ov.remove()` six call sites used to do
    assert.equal(h.sandbox.overlayCount(), 0);
    assert.equal(h.sandbox.overlayTop(), null);
  });
  it('Esc reaches the overlay BELOW a corpse instead of doing nothing', () => {
    const h = loadOverlays();
    const live = mkOverlay(h, 1), ghost = mkOverlay(h, 1);
    let liveClosed = 0;
    h.sandbox.overlayPush(live.ov, { box: live.box, autofocus: false, onEsc: () => { liveClosed++; } });
    h.sandbox.overlayPush(ghost.ov, { box: ghost.box, autofocus: false, onEsc: () => { throw new Error('a removed overlay must never be asked to close'); } });
    ghost.ov.remove();
    h.esc();
    assert.equal(liveClosed, 1);
  });
  it('ten bare removals leave the stack empty, not ten deep', () => {
    const h = loadOverlays();
    for (let i = 0; i < 10; i++) { const o = mkOverlay(h, 1); h.sandbox.overlayPush(o.ov, { box: o.box, autofocus: false, onEsc: () => {} }); o.ov.remove(); }
    assert.equal(h.sandbox.overlayCount(), 0, 'this is the „Esc closes nothing any more" failure');
  });
  it('a static overlay says `alive` for itself — .hidden means gone, isConnected never would', () => {
    const h = loadOverlays();
    const a = mkOverlay(h, 1);                       // stays in the document, only toggles .hidden
    h.sandbox.overlayPush(a.ov, { box: a.box, autofocus: false, alive: () => !a.ov.classList.contains('hidden'), onEsc: () => {} });
    assert.equal(h.sandbox.overlayCount(), 1);
    a.ov.classList.add('hidden');
    assert.equal(a.ov.isConnected, true, 'still in the document — the default rule would keep it forever');
    assert.equal(h.sandbox.overlayCount(), 0);
  });
  it('a pruned entry gets its trap detached, so Tab stops being captured by a dead dialog', () => {
    const h = loadOverlays();
    const a = mkOverlay(h, 2);
    h.sandbox.overlayPush(a.ov, { box: a.box, autofocus: false });
    assert.equal(a.box._listeners.length, 1);
    a.ov.remove();
    h.sandbox.overlayCount();
    assert.equal(a.box._listeners.length, 0);
  });
});

describe('the stack — Tab recovery when focus escaped the dialog', () => {
  it('Tab with focus on <body> walks back INTO the top overlay', () => {
    const h = loadOverlays();
    const a = mkOverlay(h, 2);
    h.sandbox.overlayPush(a.ov, { box: a.box, autofocus: false });
    h.doc.activeElement = h.doc.body;
    const ev = dispatchKey(h.doc, 'Tab', { target: h.doc.body });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(h.doc.activeElement, a.buttons[0]);
  });
  it('…and Shift+Tab enters at the back', () => {
    const h = loadOverlays();
    const a = mkOverlay(h, 2);
    h.sandbox.overlayPush(a.ov, { box: a.box, autofocus: false });
    h.doc.activeElement = h.doc.body;
    dispatchKey(h.doc, 'Tab', { target: h.doc.body, shiftKey: true });
    assert.equal(h.doc.activeElement, a.buttons[1]);
  });
  it('an overlay that opted out of the trap (trap:false) keeps Tab for itself', () => {
    const h = loadOverlays();
    const a = mkOverlay(h, 2);
    h.sandbox.overlayPush(a.ov, { trap: false, box: a.box, onEsc: () => {} });
    h.doc.activeElement = h.doc.body;
    const ev = dispatchKey(h.doc, 'Tab', { target: h.doc.body });
    assert.equal(ev.defaultPrevented, false);
  });
});

// The property, stated as a property and not as a list of tag names: onEnter fires from the dialog's own
// single-line TEXT FIELD and nowhere else. The first cut asked the inverse question against a blocklist
// of tags ('button','textarea','select','a','summary'), and the blocklist was incomplete in the one way
// that mattered — a `role="button"` hit row is a DIV. The cases below are therefore no longer „the tags
// that own Enter" but „everything that is not a text field", which is why the list has grown.
describe('UX-MODAL-ENTER — Enter does the dialog’s main thing ONLY from a single-line text field', () => {
  const notAField = [
    ['button', {}], ['textarea', {}], ['select', {}], ['a', {}], ['summary', {}],
    ['div', {}],                                            // a plain container — focus can land here
    ['div', { role: 'button', tabindex: '0' }],             // mkClickable's hit row — the one that was missed
    ['input', { type: 'checkbox' }], ['input', { type: 'radio' }],
    ['input', { type: 'button' }], ['input', { type: 'submit' }],
  ];
  for (const [tag, attrs] of notAField) {
    const name = '<' + tag + Object.entries(attrs).map(([k, v]) => ' ' + k + '="' + v + '"').join('') + '>';
    it('leaves Enter alone on a focused ' + name, () => {
      const h = loadOverlays();
      const a = mkOverlay(h, 0);
      let fired = 0;
      h.sandbox.overlayPush(a.ov, { box: a.box, autofocus: false, onEnter: () => { fired++; } });
      const node = h.mk(tag);
      for (const [k, v] of Object.entries(attrs)) { if (k === 'type') node.type = v; else node.setAttribute(k, v); }
      a.box.appendChild(node); node.focus();
      const ev = h.enter({ target: node });
      assert.equal(fired, 0, 'this is the Cancel-button case: uiModal used to resolve with the input text here');
      assert.equal(ev.defaultPrevented, false);
      assert.equal(ev._stoppedImmediate, false, 'the capture shield must not swallow a key it does not use');
    });
  }
  it('fires onEnter from a single-line input', () => {
    const h = loadOverlays();
    const a = mkOverlay(h, 0);
    let fired = 0;
    h.sandbox.overlayPush(a.ov, { box: a.box, autofocus: false, onEnter: () => { fired++; } });
    const inp = h.mk('input'); inp.type = 'text'; a.box.appendChild(inp); inp.focus();
    const ev = h.enter({ target: inp });
    assert.equal(fired, 1);
    assert.equal(ev.defaultPrevented, true);
  });
  it('an overlay without onEnter never swallows Enter', () => {
    const h = loadOverlays();
    const a = mkOverlay(h, 0);
    h.sandbox.overlayPush(a.ov, { box: a.box, autofocus: false, onEsc: () => {} });
    const inp = h.mk('input'); a.box.appendChild(inp); inp.focus();
    assert.equal(h.enter({ target: inp }).defaultPrevented, false);
  });
  it('does not fire with nothing focused (a click on the scrim parks focus on <body>)', () => {
    const h = loadOverlays();
    const a = mkOverlay(h, 0);
    let fired = 0;
    h.sandbox.overlayPush(a.ov, { box: a.box, autofocus: false, onEnter: () => { fired++; } });
    h.doc.activeElement = h.doc.body;
    const ev = h.enter({ target: h.doc.body });
    assert.equal(fired, 0, 'blind activation from nowhere is how one keystroke opens the wrong thing');
    assert.equal(ev._stoppedImmediate, false);
  });
  it('overlayFocusFirst moves the caret to the first row and refuses an empty / invisible list', () => {
    const h = loadOverlays();
    const list = h.mk('div'); h.doc.body.appendChild(list);
    assert.equal(h.sandbox.overlayFocusFirst(list, '.hit'), false, 'no rows → nothing to focus, say so');
    const hit = h.mk('div', { cls: 'hit' }); hit.setAttribute('tabindex', '0'); list.appendChild(hit);
    assert.equal(h.sandbox.overlayFocusFirst(list, '.hit'), true);
    assert.equal(h.doc.activeElement, hit);
    hit.offsetParent = null;
    assert.equal(h.sandbox.overlayFocusFirst(list, '.hit'), false, 'an unrendered row is not a focus target');
  });
});

// =====================================================================================================
//  THE SEAM, one key further along: overlays.js's capture shield vs. render.js's role=button activator.
//  „Enter setzt den Fokus auf die erste Zeile" was the logic; the shield above it then ate the SECOND
//  Enter, the one that is supposed to open that row. Same shape as the three failures this project has
//  already paid for: the function was right, the drawer over it swallowed the result.
// =====================================================================================================
// The REAL reader, sliced out of render.js. The whole file cannot be loaded into this harness (it wires
// the sidecar, the theme and the event bell at load time), but this one handler is self-contained: `e` in,
// `t.click()` out. Slicing beats re-typing it — a copy would stay green after the original changed.
function loadRoleButtonActivator(h) {
  const src = fs.readFileSync(path.join(PUB, 'render.js'), 'utf8');
  const k = src.indexOf("if (e.key !== 'Enter' && e.key !== ' '");
  assert.ok(k >= 0, 'render.js’s global Enter/Space activator moved — re-point this slice');
  const a = src.lastIndexOf('document.addEventListener', k);
  const b = src.indexOf('\n});', k) + 4;
  const slice = src.slice(a, b);
  assert.match(slice, /t\.click\(\);/, 'the sliced handler must still be the one that clicks');
  vm.runInContext(slice, h.sandbox, { filename: 'render.js (role=button activator)' });
}
// A hit row exactly as commands.js builds one: a DIV that mkClickable() made operable.
function mkHitRow(h, listEl, cls) {
  const row = h.mk('div', { cls });
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');
  row.clicks = 0; row.click = () => { row.clicks++; };
  listEl.appendChild(row);
  return row;
}

describe('Enter on a focused hit row belongs to the row, not to the dialog', () => {
  // The production shape: a search field plus `.gsearch-hit` rows, onEnter = overlayFocusFirst.
  const openSearchLike = (h) => {
    const a = mkOverlay(h, 0);
    const inp = h.mk('input'); inp.type = 'text'; a.box.appendChild(inp);
    const list = h.mk('div'); a.box.appendChild(list);
    const rows = [0, 1, 2].map(() => mkHitRow(h, list, 'gsearch-hit'));
    let focusFirst = 0;
    h.sandbox.overlayPush(a.ov, {
      box: a.box, autofocus: false,
      onEnter: () => { focusFirst++; return h.sandbox.overlayFocusFirst(list, '.gsearch-hit'); },
    });
    return { a, inp, rows, calls: () => focusFirst };
  };
  it('Enter in the search field walks the caret to row 1 (the feature that must keep working)', () => {
    const h = loadOverlays(); loadRoleButtonActivator(h);
    const s = openSearchLike(h);
    s.inp.focus();
    const ev = h.enter({ target: s.inp });
    assert.equal(s.calls(), 1);
    assert.equal(h.doc.activeElement, s.rows[0]);
    assert.deepEqual(s.rows.map((r) => r.clicks), [0, 0, 0], 'focusing a row must not also open it');
    assert.equal(ev.defaultPrevented, true);
  });
  it('Enter on row 3 then opens ROW 3 — it used to do nothing and send the caret back to row 1', () => {
    const h = loadOverlays(); loadRoleButtonActivator(h);
    const s = openSearchLike(h);
    s.rows[2].focus();
    const ev = h.enter({ target: s.rows[2] });
    assert.equal(ev._stoppedImmediate, false, 'the capture shield stopped the key here — render.js never saw it');
    assert.equal(s.calls(), 0, 'onEnter must not fire from a row');
    assert.deepEqual(s.rows.map((r) => r.clicks), [0, 0, 1]);
    assert.equal(h.doc.activeElement, s.rows[2], 'the caret jumped back to row 1 before the fix');
  });
  it('Space on a focused row opens it too (the activator takes both keys)', () => {
    const h = loadOverlays(); loadRoleButtonActivator(h);
    const s = openSearchLike(h);
    s.rows[1].focus();
    dispatchKey(h.doc, ' ', { target: s.rows[1] });
    assert.deepEqual(s.rows.map((r) => r.clicks), [0, 1, 0]);
  });
  it('the rows really are role=button DIVs at the production sites, not <button>s', () => {
    // The unit tests above are only about the right thing if the panel builds its rows this way. It does,
    // in both dialogs that register overlayFocusFirst — and that is the difference to openSkillLauncher,
    // whose rows are real <button>s and were therefore never broken.
    const src = fs.readFileSync(path.join(PUB, 'commands.js'), 'utf8');
    for (const [fn, cls] of [['openGlobalSearch', 'gsearch-hit'], ['openPromptHistory', 'gsearch-hit ph-hit']]) {
      const i = src.indexOf('function ' + fn + '(');
      assert.ok(i >= 0, fn + ' is gone — did it get renamed?');
      const body = src.slice(i, src.indexOf('\n}', i));
      assert.ok(body.includes("el('div', '" + cls + "')"), fn + ' no longer builds its rows as DIVs');
      assert.match(body, /mkClickable\(it/, fn + ' no longer makes its rows keyboard-operable');
      assert.match(body, /overlayFocusFirst\(/, fn + ' no longer registers the Enter→first-row step');
    }
  });
});

// =====================================================================================================
//  VIEWS-ESC — the seam. overlays.js + commands.js in ONE context, and a real keystroke through both.
// =====================================================================================================
function loadEscChain() {
  const calls = { toasts: [], interrupts: 0 };
  const els = new Map();
  const h = loadOverlays();
  // $() must be STABLE per selector: the chain reads $('#view-chat') three times and a fresh object each
  // time would make every classList test answer whatever the last stub said.
  const $ = (sel) => {
    if (!els.has(sel)) {
      // everything the chain inspects is CLOSED unless a test opens it; #view-chat is the active view
      const cls = sel === '#view-chat' ? 'active' : 'hidden';
      els.set(sel, mkEl('div', h.doc, { cls }));
    }
    return els.get(sel);
  };
  Object.assign(h.ctx, {
    $, $$: () => [], t: (k) => String(k), tt: (k) => String(k),
    el: (tag, cls) => mkEl(tag || 'div', h.doc, { cls }),
    ic: () => '', iconBtn: () => mkEl('button', h.doc), mkClickable: (e) => e,
    toast: (msg) => calls.toasts.push(String(msg)),
    debounce: (fn) => fn,
    api: () => Promise.resolve({}),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    ACTIVE: null, TABS: [{ id: 'tab1' }], SESSIONS: [], 
    tabCanStop: () => true,                        // a turn IS running — the whole point of VIEWS-ESC
    interruptTab: () => { calls.interrupts++; },
    stopTab: () => { calls.interrupts++; },       // Esc-Esc goes through stopTab now (two-stage Stop, chat.js) — same count
    closeNav: () => {}, closeSidecar: () => {}, closeChatSearch: () => {},
    resolvePerm: () => {}, closeCfgOverlay: () => {}, closeMcpOverlay: () => {},
    allChatCommands: () => [], cmdkCommands: undefined, isFav: () => false,
    EventSource: function () { return {}; }, clearInterval: () => {}, setInterval: () => 0,
    navigator: {}, window: h.ctx, URL: class {}, fetch: () => Promise.resolve({}),
  });
  h.ctx.document.documentElement.classList.remove('nav-open');
  // palette.js VOR commands.js, weil commands.js daraus `PALETTE_VIEWS` liest (die Nav-Ansichten für die
  // Strg-K-Palette) — index.html lädt es im Browser ebenfalls davor. Ohne diese Zeile wirft `openCmdk()`
  // hier `PALETTE_VIEWS is not defined`, und das trat erst in der KOMBINATION von PR-8 und PR-9a auf:
  // einzeln war jede der beiden Suiten grün. Die ECHTE Datei, nicht ein Stub — ein nachgebautes
  // PALETTE_VIEWS würde die Fixtur prüfen und nicht das Panel.
  vm.runInContext(fs.readFileSync(path.join(PUB, 'palette.js'), 'utf8'), h.sandbox, { filename: 'palette.js' });
  vm.runInContext(fs.readFileSync(path.join(PUB, 'commands.js'), 'utf8'), h.sandbox, { filename: 'commands.js' });
  h.ctx.ACTIVE = { id: 'tab1', uid: 'u1', title: 'Tab 1' };   // after the load — see the ACTIVE: null note
  // The one bubble-phase keydown listener commands.js puts on `document` — the global chain. Grabbing it
  // lets a test call it DIRECTLY, i.e. ask „would the chain behave if the capture shield were bypassed?"
  const chain = h.doc._listeners.filter((l) => l.type === 'keydown' && !l.capture).map((l) => l.fn);
  assert.equal(chain.length, 1, 'commands.js is expected to own exactly one bubble keydown listener');
  return Object.assign(h, { calls, $, chainDirect: (ev) => chain[0](ev) });
}
const fakeEsc = () => ({
  key: 'Escape', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
  defaultPrevented: false, _stopped: false, _stoppedImmediate: false,
  preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this._stopped = true; },
  stopImmediatePropagation() { this._stopped = true; this._stoppedImmediate = true; },
});

describe('VIEWS-ESC — Esc with a dialog open must not arm the abort of a running turn', () => {
  it('without any overlay, Esc-Esc still stops the turn (the feature must survive the fix)', () => {
    const h = loadEscChain();
    h.esc();
    assert.deepEqual(h.calls.toasts, ['commands.escNochmalZumStoppen']);
    assert.equal(h.calls.interrupts, 0);
    h.esc();
    assert.equal(h.calls.interrupts, 1);
  });
  it('with ONE overlay open, Esc closes it and arms NOTHING', () => {
    const h = loadEscChain();
    const a = mkOverlay(h, 1);
    let closed = 0;
    h.sandbox.overlayPush(a.ov, { box: a.box, autofocus: false, onEsc: () => { closed++; a.ov.remove(); h.sandbox.overlayPop(a.ov); } });
    h.esc();
    assert.equal(closed, 1);
    assert.deepEqual(h.calls.toasts, [], 'this toast IS the armed abort becoming visible');
    assert.equal(h.calls.interrupts, 0);
  });
  it('and the NEXT Esc after closing a dialog only arms, it does not already interrupt', () => {
    // the measured user story: close a dialog with Esc, press Esc again because the turn is long —
    // before the fix the second press killed the turn, because the first had armed it invisibly
    const h = loadEscChain();
    const a = mkOverlay(h, 1);
    h.sandbox.overlayPush(a.ov, { box: a.box, autofocus: false, onEsc: () => { a.ov.remove(); h.sandbox.overlayPop(a.ov); } });
    h.esc();
    h.esc();
    assert.equal(h.calls.interrupts, 0, 'the dialog-closing Esc must not count as the first of the two');
    assert.deepEqual(h.calls.toasts, ['commands.escNochmalZumStoppen']);
  });
  it('a dialog that DECLINES to close (compare, columns still streaming) swallows Esc too', () => {
    const h = loadEscChain();
    const a = mkOverlay(h, 1);
    h.sandbox.overlayPush(a.ov, { box: a.box, autofocus: false, onEsc: () => { /* busy */ } });
    h.esc(); h.esc(); h.esc();
    assert.equal(h.calls.interrupts, 0);
    assert.deepEqual(h.calls.toasts, []);
  });
  it('two stacked dialogs: three Esc presses = close, close, arm — in that order', () => {
    const h = loadEscChain();
    const a = mkOverlay(h, 1), b = mkOverlay(h, 1);
    const order = [];
    const mk = (o, name) => h.sandbox.overlayPush(o.ov, { box: o.box, autofocus: false, onEsc: () => { order.push(name); o.ov.remove(); h.sandbox.overlayPop(o.ov); } });
    mk(a, 'a'); mk(b, 'b');
    h.esc(); h.esc(); h.esc();
    assert.deepEqual(order, ['b', 'a']);
    assert.deepEqual(h.calls.toasts, ['commands.escNochmalZumStoppen']);
    assert.equal(h.calls.interrupts, 0);
  });
  it('a dialog that vanished without deregistering does not keep Esc hostage either', () => {
    const h = loadEscChain();
    const ghost = mkOverlay(h, 1);
    h.sandbox.overlayPush(ghost.ov, { box: ghost.box, autofocus: false, onEsc: () => { throw new Error('dead overlay asked to close'); } });
    ghost.ov.remove();
    h.esc();
    assert.deepEqual(h.calls.toasts, ['commands.escNochmalZumStoppen'], 'Esc must fall through once the stack is really empty');
  });
  it('the global chain refuses to run while an overlay is open, even called directly', () => {
    // belt and braces: the capture shield in overlays.js is the mechanism, this guard in commands.js is
    // the net under it — a future overlay that registers but whose Esc somehow reaches the chain must at
    // worst do nothing, never stop the turn.
    const h = loadEscChain();
    const a = mkOverlay(h, 1);
    h.sandbox.overlayPush(a.ov, { box: a.box, autofocus: false, onEsc: () => {} });
    h.chainDirect(fakeEsc());
    assert.deepEqual(h.calls.toasts, []);
    assert.equal(h.calls.interrupts, 0);
    a.ov.remove();
    h.chainDirect(fakeEsc());
    assert.deepEqual(h.calls.toasts, ['commands.escNochmalZumStoppen'], 'with the stack empty the chain must work again');
  });
  it('the command palette closes on Esc instead of arming the abort (it used to sit BELOW that branch)', () => {
    const h = loadEscChain();
    const ov = h.$('#cmdkOverlay');
    h.$('#cmdkInput').value = '';
    h.sandbox.openCmdk('');
    assert.equal(ov.classList.contains('hidden'), false);
    assert.equal(h.sandbox.overlayCount(), 1, 'openCmdk must register the palette with the stack');
    h.esc();
    assert.equal(ov.classList.contains('hidden'), true, 'the palette is closed');
    assert.deepEqual(h.calls.toasts, [], 'and no abort was armed');
    assert.equal(h.calls.interrupts, 0);
  });
});

// =====================================================================================================
//  The READER check. Three times in this project the logic was right and the layer above dropped it;
//  a public/js file that no <script> tag loads is exactly that shape — green tests, dead panel.
// =====================================================================================================
describe('public/index.html loads every front-end file', () => {
  it('each public/js/*.js has a <script src> tag', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const files = fs.readdirSync(PUB).filter((f) => f.endsWith('.js')).sort();
    const missing = files.filter((f) => !html.includes('/js/' + f + '"'));
    assert.deepEqual(missing, [], 'not loaded by index.html: ' + missing.join(', '));
    assert.ok(files.includes('overlays.js') && files.includes('dialogs.js'));
  });
  it('the „?" shortcut asks the STACK, not a CSS selector', () => {
    // Structural on purpose, and said out loud: render.js cannot be loaded into this harness without
    // stubbing half the panel (it wires the sidecar, the theme and the event bell at load). What is
    // checkable is WHICH question the handler asks, and that is what was wrong — `.modal-overlay:not
    // (.hidden)` cannot see the command palette, the maximised result card or the compare overlay, so „?"
    // opened a second dialog on top of three of the thirteen.
    const src = fs.readFileSync(path.join(PUB, 'render.js'), 'utf8');
    const i = src.indexOf("if (e.key !== '?'");
    assert.ok(i >= 0, 'the „?" shortcut handler moved — re-point this check');
    const body = src.slice(i, i + 800);
    assert.match(body, /overlayCount\(\)/, '„?" must ask the overlay stack whether a dialog is open');
    assert.doesNotMatch(body, /modal-overlay:not\(\.hidden\)/, 'the selector that could not see three of the overlays is back');
  });
  it('overlays.js is loaded BEFORE the files that call overlayPush at load time', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const at = (f) => html.indexOf('/js/' + f + '"');
    for (const f of ['render.js', 'dialogs.js', 'chat-perms.js', 'views-uiskills.js', 'commands.js']) {
      assert.ok(at('overlays.js') < at(f), 'overlays.js must precede ' + f);
    }
  });
});

// A roll-call, so „ten overlays without a focus trap" can never again be a number from an audit that
// nobody re-counted. Every overlay in the panel must be registered with the stack at its creation site.
describe('every overlay registers with the stack', () => {
  const SITES = [
    ['public/js/dialogs.js', 'uiModal'],
    ['public/js/dialogs.js', 'openMcpOverlay'],
    ['public/js/dialogs.js', 'openCfgOverlay'],
    ['public/js/chat-perms.js', 'permOverlayShow'],
    ['public/js/commands.js', 'openPromptManager'],
    ['public/js/commands.js', 'openGlobalSearch'],
    ['public/js/commands.js', 'openPromptHistory'],
    ['public/js/commands.js', 'openModelCompare'],
    ['public/js/commands.js', 'openCmdk'],
    ['public/js/views-uiskills.js', 'toggleResultMax'],
    ['public/js/views-uiskills.js', 'uiskillFromSkillPick'],
    ['public/js/views-uiskills.js', 'openSkillLauncher'],
    ['public/js/views-uiskills.js', 'pickFileModal'],
    // P-1 — the project editor: its own overlay (no click-outside close, a draft guard on Esc), not uiModal
    ['public/js/projects.js', 'openProjectEditor'],
  ];
  const bodyOf = (src, name) => {
    const i = src.indexOf('function ' + name + '(');
    assert.ok(i >= 0, name + ' is gone — did it get renamed?');
    const j = src.indexOf('\n}', i);
    return src.slice(i, j < 0 ? src.length : j);
  };
  for (const [file, fn] of SITES) {
    it(fn + ' (' + path.basename(file) + ')', () => {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.match(bodyOf(src, fn), /overlayPush\(/, fn + ' creates an overlay but never registers it');
    });
  }
  it('the ⤓ jump button re-opens the permission gate through permOverlayShow, not a bare un-hide', () => {
    // Structural, and said out loud. A STATIC overlay retires from the stack the moment it is hidden (that
    // is its `alive` rule), so showing it again without pushing it again is an overlay whose Esc falls back
    // into the global chain — the exact defect, one layer further along. The floating „Freigabe ausstehend"
    // button is the only second way this dialog opens, and it used to do a bare classList.remove('hidden').
    const src = fs.readFileSync(path.join(PUB, 'chat-perms.js'), 'utf8');
    const m = /registerPermWaiter\('chat',\s*([^)]*)\)/.exec(src);
    assert.ok(m, "the 'chat' permission waiter moved — re-point this check");
    assert.equal(m[1].trim(), 'permOverlayShow');
  });
  it('no overlay is left out of the roll-call above', () => {
    // COUNTED, not remembered. „Eight overlays without a focus trap" came from an audit; a list in a test
    // rots the same way unless something recounts it. Two independent signals, one per kind of overlay:
    //   · dynamic — `el('div', '…-overlay…')`: the class token has to END in -overlay, so render.js's
    //     `kbd-overlay-body` (the BODY of a dialog, not a dialog) does not get counted as one.
    //   · static  — `aria-modal="true"` in index.html: the four overlays that live in the markup.
    // This scan is a NAMING convention and was therefore blind exactly once: `pickFileModal` and
    // `uiEditPromptModal` called their scrim `uiskill-picker-ov`, matched nothing, and the sum still came
    // out equal to SITES.length — a scan whose pattern found nothing and stayed quietly green. The
    // behavioural scan below is what closes that hole; this one is only complete BECAUSE of it.
    const dyn = [];
    for (const f of fs.readdirSync(PUB).filter((x) => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(PUB, f), 'utf8');
      for (const m of src.matchAll(/el\('div',\s*'([^']*)'/g)) {
        if (/(^|\s)[\w-]*-overlay(\s|$)/.test(m[1])) dyn.push(f + ' · ' + m[1]);
      }
    }
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const stat = [...html.matchAll(/id="(\w+)"[^>]*aria-modal="true"/g)].map((m) => 'index.html · #' + m[1]);
    assert.equal(stat.length, 4, 'static overlays in index.html: ' + stat.join(' · '));
    assert.equal(dyn.length + stat.length, SITES.length,
      'overlays found (' + (dyn.length + stat.length) + '): ' + [...dyn, ...stat].join(' · '));
  });
  it('every click-outside-closes scrim is registered AND carries an -overlay class token', () => {
    // THE SCAN THAT WOULD HAVE CAUGHT IT, and it asks about BEHAVIOUR instead of about a name: a div with
    // `onclick = (e) => { if (e.target === div) … }` is a modal scrim and nothing else in this code base
    // uses that idiom. Two assertions per site, which together make the counting scan above trustworthy:
    //   (a) the enclosing function registers with the stack — this is the one `pickFileModal` and
    //       `uiEditPromptModal` failed, both of them full modal dialogs with a blocking Promise;
    //   (b) the scrim is created with a class token ending in `-overlay`, i.e. the convention the counting
    //       scan depends on is ENFORCED rather than hoped for.
    // What this still cannot see is a modal without click-outside (openModelCompare, #permOverlay) — those
    // are covered by the two scans above. Three overlapping signals, no single point of blindness.
    const found = [];
    for (const f of fs.readdirSync(PUB).filter((x) => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(PUB, f), 'utf8');
      for (const m of src.matchAll(/(\w+)\.onclick = \(e\) => \{ if \(e\.target === (\w+)\)/g)) {
        assert.equal(m[1], m[2], f + ': scrim handler compares against a different element — ' + m[0]);
        const start = Math.max(src.lastIndexOf('\nfunction ', m.index), src.lastIndexOf('\nasync function ', m.index));
        assert.ok(start >= 0, f + ': modal scrim outside any function — ' + m[0]);
        const fn = f + ' · ' + /^\n(?:async )?function (\w+)/.exec(src.slice(start))[1];
        const end = src.indexOf('\n}', m.index);
        const body = src.slice(start, end < 0 ? src.length : end);
        found.push(fn);
        assert.match(body, /overlayPush\(/, fn + ' builds a modal scrim but never registers it with the stack');
        const made = new RegExp('\\b' + m[1] + " = el\\('div', '([^']*)'").exec(body);
        assert.ok(made, fn + ': cannot see where the scrim `' + m[1] + '` is created — re-point this scan');
        assert.match(made[1], /(^|\s)[\w-]*-overlay(\s|$)/,
          fn + ': scrim class "' + made[1] + '" needs a class token ending in -overlay, or the counting scan above cannot see it');
      }
    }
    assert.equal(found.length, 8, 'modal scrims found: ' + found.join(' · '));
  });
});
