'use strict';
// H2 — the chat below 560px. Reported: the approvals rail kept 160px and the composer's text field was
// 39px wide, i.e. about four characters.
//
// Layout cannot be proven in node, and this file does not pretend otherwise. What IS decidable is the
// mechanism, and the mechanism is where the honest-surface risk sits: the rail is folded through the same
// chatSideSetCollapsed() a click goes through, so aria-expanded, the tooltip and the chevron keep telling
// the truth — a CSS-only `width: 40px` would have left a toggle claiming „einklappen" over an empty strip.
// The two properties below are the ones a later change can silently break:
//   1. an AUTOMATIC open is refused while narrow (chatSideRefresh reopens on every new grant)
//   2. leaving the breakpoint restores YOUR stored choice, not the forced one
// The composer rules are checked as what they are: an assertion about the stylesheet's text. A human
// still has to look at a 400px window — see the PR notes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SIDE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat-side.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');

function lift(name, env) {
  const m = SIDE_SRC.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
  assert.ok(m, name + '() not found in public/js/chat-side.js — renamed or reindented?');
  const names = Object.keys(env);
  return new Function(...names, m[0] + '\nreturn ' + name + ';')(...names.map((k) => env[k]));
}
function fakeRail() {
  const cls = new Set();
  return {
    classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) },
    get collapsed() { return cls.has('collapsed'); },
  };
}
function fakeBtn() { return { attrs: {}, title: '', innerHTML: '', setAttribute(k, v) { this.attrs[k] = v; } }; }

function setup(narrow, stored) {
  const rail = fakeRail(), btn = fakeBtn(), saved = [];
  const env = {
    $: (sel) => (sel === '#chatSide' ? rail : sel === '#chatSideToggle' ? btn : null),
    railIsNarrow: () => narrow,
    tt: (k) => k,
    ic: () => '<svg/>',
    chatLayoutSet: (p) => { saved.push(p); return p; },
    chatLayoutGet: () => ({ sideCollapsed: stored }),
    _sideUserCollapsed: false,
  };
  return { rail, btn, saved, set: lift('chatSideSetCollapsed', env) };
}

test('H2: a narrow window refuses the AUTOMATIC reopen the rail does on every new grant', () => {
  const s = setup(true, false);
  s.set(true, { auto: true });
  assert.equal(s.rail.collapsed, true);
  // this is the call chatSideRefresh() makes when a grant or a running agent appears
  s.set(false, { auto: true });
  assert.equal(s.rail.collapsed, true, 'the rail reopened by itself — the 160px are back');
  assert.equal(s.btn.attrs['aria-expanded'], 'false', 'the toggle must not claim to be open');
  assert.equal(s.btn.title, 'chat-side.ausklappen');
  assert.deepEqual(s.saved, [], 'an automatic fold must not overwrite the stored preference');
});

test('H2: an explicit click still opens it — you asked for the rail, you may have it', () => {
  const s = setup(true, false);
  s.set(true, { auto: true });
  s.set(false); // the toggle button, no `auto`
  assert.equal(s.rail.collapsed, false);
  assert.equal(s.btn.attrs['aria-expanded'], 'true');
  assert.deepEqual(s.saved, [{ sideCollapsed: false }], 'a real click is the only thing that is remembered');
});

test('H2: on a wide window nothing changed — the automatic reopen still works', () => {
  const s = setup(false, false);
  s.set(true, { auto: true });
  s.set(false, { auto: true });
  assert.equal(s.rail.collapsed, false);
  assert.equal(s.btn.attrs['aria-expanded'], 'true');
  assert.deepEqual(s.saved, []);
});

test('H2: crossing the breakpoint folds, crossing back restores YOUR choice', () => {
  const calls = [];
  const apply = (narrow, stored) => {
    calls.length = 0;
    const fn = lift('chatSideApplyNarrow', {
      railIsNarrow: () => narrow,
      chatLayoutGet: () => ({ sideCollapsed: stored }),
      chatSideSetCollapsed: (on, opts) => calls.push([on, opts]),
    });
    fn();
    return calls.slice();
  };
  assert.deepEqual(apply(true, false), [[true, { auto: true }]], 'narrow must fold the rail');
  assert.deepEqual(apply(true, true), [[true, { auto: true }]]);
  // back above 560px: the rail comes back only if you had it open
  assert.deepEqual(apply(false, false), [[false, { auto: true }]], 'an open rail was not restored');
  assert.deepEqual(apply(false, true), [[true, { auto: true }]], 'a rail you had folded was torn open');
  // never persisted — otherwise resizing the window would quietly rewrite the preference
  for (const [, opts] of calls) assert.equal(opts.auto, true);
});

test('H2: the breakpoint is the one the nav drawer already uses', () => {
  const mq = SIDE_SRC.match(/matchMedia\('\(max-width: (\d+)px\)'\)/);
  assert.ok(mq, 'the rail no longer watches a breakpoint at all');
  assert.equal(mq[1], '560', 'the rail folds at ' + mq[1] + 'px while the nav drawer opens at 560px');
  const boot = fs.readFileSync(path.join(ROOT, 'public', 'js', 'boot.js'), 'utf8');
  assert.match(boot, /matchMedia\('\(max-width: 560px\)'\)/);
});

// --- the composer: a source assertion, and it says so -------------------------------------------
test('H2: below 560px the input gets a line of its own instead of the leftover 39px', () => {
  const block = CSS.match(/@media \(max-width: 560px\) \{[\s\S]*?\n\}/g) || [];
  const composer = block.find((b) => b.includes('#composerInput'));
  assert.ok(composer, 'no ≤560px rule touches #composerInput — the field is back to the leftover width');
  // wrapping is what creates the second line; without it `flex: 1 1 100%` just overflows the row
  assert.match(composer, /\.composer-inner \{[^}]*flex-wrap: wrap/);
  assert.match(composer, /#composerInput \{[^}]*flex: 1 1 100%/);
  assert.match(composer, /#composerInput \{[^}]*min-width: 0/);
  // the five 32px icon buttons + the send group need the row's full width, so the padding has to give
  assert.match(composer, /\.composer \{ padding: 8px 10px; \}/);
});
