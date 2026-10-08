'use strict';
// Status strip: the selectors drop to a second line when the WHOLE strip would not fit, and a phase change
// („denke nach…" → „läuft …" → „schreibe…") can never flip that. The browser decides by the left side's
// max-content width; these tests pin the two things that make that width stable — the live slot is always
// there (also at rest), and its width is a per-language reserve, not the text of this tick.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { liftFn } = require('./event-pump');

const PUB = path.join(__dirname, '..', 'public', 'js');
const SRC = fs.readFileSync(path.join(PUB, 'chat-status.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

function fakeEl(tag, cls, text) {
  return {
    tag, className: cls || '', textContent: text == null ? '' : String(text), title: '', children: [], style: {}, dataset: {}, attrs: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(c) { this.children.push(c); return c; }, querySelector: () => null,
  };
}

function runStrip(tab) {
  const left = fakeEl('div', 'cs-left');
  Object.defineProperty(left, 'innerHTML', { set() { left.children.length = 0; }, get() { return ''; } });
  const box = fakeEl('div', 'chat-status');
  box.querySelector = (sel) => (sel === '.cs-left' ? left : null);
  const loud = /^const LOUD_MODES = .*;$/m.exec(SRC);
  assert.ok(loud, 'const LOUD_MODES not found in public/js/chat-status.js');
  const known = Object.assign(Object.create(null), {
    ACTIVE: tab, el: fakeEl, tt: (k) => k, fmtNum: (n) => String(n), $: (sel) => (sel === '#chatStatus' ? box : null),
    document: { querySelector: () => null }, STATE: { prefs: {} }, LIMIT_TIMER: null,
    modeInfo: () => ({ cls: 'm-plan', label: 'Plan' }), laneStatusBadges: () => [],
    displayPhase: () => 'denke nach…',
  });
  const stub = () => undefined;
  const env = new Proxy(known, {
    has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
    get: (t, k) => (typeof k !== 'string' ? undefined : k in t ? t[k] : stub),
  });
  const src = [loud[0], liftFn(SRC, 'renderStatusBar', 'chat-status.js')].join('\n');
  new Function('__env', 'with (__env) {\n' + src + '\nreturn { renderStatusBar };\n}')(env).renderStatusBar();
  return left;
}

describe('renderStatusBar — the live slot', () => {
  it('is there at rest too, empty and hidden from assistive tech, as the LAST chip', () => {
    const left = runStrip({ id: 'c1', streaming: false });
    const last = left.children[left.children.length - 1];
    assert.equal(last.className, 'cs-live');
    assert.equal(last.children.length, 0);
    assert.equal(last.attrs['aria-hidden'], 'true');
  });
  it('holds dot · phase · timing while streaming — and the dot no longer leads the row', () => {
    const left = runStrip({ id: 'c1', streaming: true });
    const last = left.children[left.children.length - 1];
    assert.equal(last.className, 'cs-live');
    assert.deepEqual(last.children.map((c) => c.className), ['cs-dot', 'cs-phase', 'cs-meta']);
    assert.equal(last.children[1].textContent, 'denke nach…');
    assert.ok(!left.children.some((c) => c.className === 'cs-dot' || c.className === 'cs-phase'),
      'dot and phase live only inside the slot: ' + left.children.map((c) => c.className).join(' '));
  });
});

function loadStatus(extra) {
  const ctx = Object.assign({
    tt: (k) => String(k), el: fakeEl, console, Date, Math, JSON, String, Number, Array, Object, parseFloat,
    PHASE_WORKING: 'phase:working', PHASE_WRITING: 'phase:writing', PHASE_THINKING: 'phase:thinking',
    PHASE_TOOLWORK: 'phase:toolwork', ASK_WAIT_PHASE: 'phase:ask-wait', RECONNECT_PHASE: 'phase:reconnect',
  }, extra || {});
  ctx.globalThis = ctx;
  const sb = vm.createContext(ctx);
  vm.runInContext(SRC, sb, { filename: 'chat-status.js' });
  return sb;
}

describe('statusLiveWidth / statusLiveReserve — the reserve', () => {
  const S = loadStatus();
  const measure = (s) => [...s].length * 10;
  it('covers the longest fixed phase plus the timing template, dot and gaps', () => {
    const w = S.statusLiveWidth(measure, ['arbeite…', 'warte auf Freigabe…'], '(12s)', 32, 9, 9);
    assert.equal(w, 9 + 9 + 19 * 10 + 9 + 5 * 10);
  });
  it('caps the phase share — a tool or plan phase has no upper bound and ellipsises instead', () => {
    const w = S.statusLiveWidth(measure, ['x'.repeat(80)], '', 32, 0, 0);
    assert.equal(w, 32 * 10);
  });
  it('measures every phase sentinel, so a new longest label is picked up without touching this code', () => {
    const ph = S.statusLivePhases();
    for (const k of ['common.arbeite', 'chat-events.schreibe', 'chat-events.denkeNach', 'chat-events.arbeite',
      'chat-status.warteAufFreigabe', 'chat-events.verbindungGetrenntReconnect']) {
      assert.ok(ph.some((p) => p.includes(k)), k + ' missing from ' + ph.join(' | '));
    }
  });
  it('writes --cs-live-w once per language and font — not on every repaint', () => {
    let measured = 0;
    const props = {};
    const canvas = { getContext: () => ({ font: '', measureText: (s) => { measured++; return { width: [...s].length * 7 }; } }) };
    const S2 = loadStatus({
      LANG: 'de', getComputedStyle: () => ({ font: '12.5px monospace', columnGap: '9px' }),
      document: { createElement: () => canvas },
    });
    const box = { style: { setProperty: (k, v) => { props[k] = v; } } };
    S2.statusLiveReserve(box);
    assert.match(props['--cs-live-w'], /^\d+px$/);
    const first = measured;
    S2.statusLiveReserve(box);
    assert.equal(measured, first, 'same language, same font → no second measurement');
    vm.runInContext('LANG = "en"', S2);
    S2.statusLiveReserve(box);
    assert.ok(measured > first, 'a language switch measures again');
  });
  it('without layout (fake DOM, no setProperty) it is a silent no-op — the stylesheet fallback stands', () => {
    assert.doesNotThrow(() => S.statusLiveReserve({ style: {} }));
    assert.doesNotThrow(() => S.statusLiveReserve(null));
  });
});

describe('styles.css — the strip wraps, its left side does not', () => {
  const rule = (sel) => {
    const i = CSS.indexOf(sel + ' {'); assert.ok(i >= 0, sel + ' rule missing');
    return CSS.slice(i, CSS.indexOf('}', i));
  };
  it('.chat-status wraps and carries a ch fallback for the reserve', () => {
    const r = rule('.chat-status');
    assert.match(r, /flex-wrap:\s*wrap/);
    assert.match(r, /--cs-live-w:\s*\d+ch/);
  });
  it('the selectors: at the right end on one line (the growing left side pushes them), LEFT-aligned on a line of their own', () => {
    assert.doesNotMatch(rule('.chat-status .cs-right'), /margin-left:\s*auto/);
    assert.match(rule('.chat-status .cs-left'), /flex:\s*1 1 auto/);
  });
  it('the live slot has the reserved width', () => {
    assert.match(rule('.chat-status .cs-left > .cs-live'), /width:\s*var\(--cs-live-w\)/);
  });
  it('the ≤720px block no longer lets .cs-left wrap (that was the jumping)', () => {
    const i = CSS.indexOf('@media (max-width: 720px) {\n  /* H2');
    assert.ok(i >= 0, 'the status-strip ≤720px block moved — update this test');
    const block = CSS.slice(i, CSS.indexOf('\n}\n', i));
    assert.doesNotMatch(block, /\.cs-left\s*\{[^}]*flex-wrap:\s*wrap/);
  });
  it('the topbar wraps by content at every width, its actions right-aligned (not only below 820px)', () => {
    const top = CSS.slice(CSS.indexOf('\n.topbar {') + 1);
    assert.match(top.slice(0, top.indexOf('}')), /flex-wrap:\s*wrap/);
    const act = rule('.topbar-actions');
    assert.match(act, /flex-wrap:\s*wrap/);
    assert.match(act, /margin-left:\s*auto/);
  });
});
