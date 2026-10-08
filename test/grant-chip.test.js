'use strict';
// H4 — the approval chips in the chat rail: one click ANYWHERE on a chip revoked a permission.
//
// The reported defect, in both builders:
//   · grantChips()    (public/js/chat-status.js) — the session grants. `el('button', 'cs-grant')` with
//     an × painted inside it as a plain <span>, so the ✓, the tool name and the padding all revoked.
//     Instantly and with no way back; in the 160px rail these chips are stacked and touching.
//   · persistedChip() (public/js/chat-side.js)   — the standing settings.local rules. Same shape; it at
//     least asked first, but the hit area was the same mistake.
//
// Both are browser scripts, so the builders are lifted out by name and run against a fake element
// factory — the real structure under test, not a description of it (same technique as
// test/agent-lanes.test.js against chat-render.js). No DOM, no dependency: the question this has to
// answer is "which node carries the handler", and that is a property of the tree, not of a renderer.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = (f) => fs.readFileSync(path.join(ROOT, 'public', 'js', f), 'utf8');
const STATUS_SRC = SRC('chat-status.js');
const SIDE_SRC = SRC('chat-side.js');

function fakeEl(tag, cls, txt) {
  return {
    tag, className: cls || '', textContent: txt == null ? '' : String(txt), kids: [], attrs: {},
    title: '', type: '', onclick: null,
    appendChild(k) { this.kids.push(k); return k; },
    setAttribute(k, v) { this.attrs[k] = v; },
  };
}
function walk(node, out) { out = out || []; out.push(node); (node.kids || []).forEach((k) => walk(k, out)); return out; }
function buttons(node) { return walk(node).filter((n) => n.tag === 'button'); }
function clickable(node) { return walk(node).filter((n) => typeof n.onclick === 'function'); }

function lift(src, file, name, env) {
  const m = src.match(new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
  assert.ok(m, name + '() not found in public/js/' + file + ' — renamed or reindented?');
  const names = Object.keys(env);
  return new Function(...names, m[0] + '\nreturn ' + name + ';')(...names.map((k) => env[k]));
}

// ---------------------------------------------------------------- session grants
function sessionChip(tab, spy) {
  const grantChips = lift(STATUS_SRC, 'chat-status.js', 'grantChips', {
    el: fakeEl,
    tt: (k) => k,
    toast: (msg, kind, opts) => { spy.toasts.push({ msg, kind, opts }); },
    renderStatusBar: () => { spy.repaints++; },
    chatSideRefresh: () => { spy.railRepaints++; },
  });
  const out = grantChips(tab);
  assert.equal(out.length, 1, 'expected one chip per granted tool');
  return out[0];
}
const newTab = () => ({ alwaysAllow: new Set(['Bash']), _autoAllowSeen: new Set(['Bash']) });

test('H4: only the × is clickable — the chip itself does nothing', () => {
  const chip = sessionChip(newTab(), { toasts: [], repaints: 0, railRepaints: 0 });
  assert.equal(chip.tag, 'span', 'the chip is a <button> again — the whole pill revokes');
  assert.equal(chip.onclick, null, 'the chip root still carries a click handler');
  const acts = clickable(chip);
  assert.equal(acts.length, 1, 'expected exactly one clickable node, found ' + acts.length);
  assert.equal(acts[0].tag, 'button');
  assert.ok(/cs-grant-x/.test(acts[0].className), 'the clickable node is not the ×: ' + acts[0].className);
  assert.equal(acts[0].textContent, '\u00d7');
  // a button inside a button is invalid markup and made the whole row one keyboard target
  assert.equal(buttons(chip).length, 1);
  // the × is the only control, so it must announce itself
  assert.ok(acts[0].attrs['aria-label'], 'the × has no aria-label');
  assert.ok(acts[0].title, 'the × has no tooltip');
});

test('H4: the × revokes AND offers the way back', () => {
  const tab = newTab();
  const spy = { toasts: [], repaints: 0, railRepaints: 0 };
  const chip = sessionChip(tab, spy);
  clickable(chip)[0].onclick({ stopPropagation() {} });

  assert.equal(tab.alwaysAllow.has('Bash'), false, 'the grant was not revoked');
  assert.equal(spy.repaints, 1, 'the chip was not repainted away');
  assert.equal(spy.toasts.length, 1);
  const undo = spy.toasts[0].opts && spy.toasts[0].opts.undo;
  assert.ok(undo && typeof undo.onClick === 'function', 'the toast carries no undo — the revoke is final again');

  undo.onClick();
  assert.equal(tab.alwaysAllow.has('Bash'), true, 'undo did not restore the grant');
  // the „already auto-answered" ledger has to come back too, or the restored grant asks again
  assert.equal(tab._autoAllowSeen.has('Bash'), true, 'undo restored the grant but not its _autoAllowSeen entry');
  assert.equal(spy.repaints, 2);
});

test('H4: undo does not invent a ledger entry the grant never had', () => {
  const tab = { alwaysAllow: new Set(['Read']), _autoAllowSeen: new Set() };
  const spy = { toasts: [], repaints: 0, railRepaints: 0 };
  const chip = sessionChip(tab, spy);
  clickable(chip)[0].onclick({ stopPropagation() {} });
  spy.toasts[0].opts.undo.onClick();
  assert.equal(tab.alwaysAllow.has('Read'), true);
  assert.equal(tab._autoAllowSeen.has('Read'), false, 'undo added a ledger entry that did not exist before');
});

// ---------------------------------------------------------------- standing rules
function permChip(entry, env) {
  const persistedChip = lift(SIDE_SRC, 'chat-side.js', 'persistedChip', Object.assign({
    el: fakeEl, tt: (k) => k, revokePersisted: () => {},
  }, env || {}));
  return persistedChip(entry);
}

test('H4: the standing-rule chip has the same single target', () => {
  const chip = permChip('Bash(git:*)');
  assert.equal(chip.tag, 'span');
  assert.equal(chip.onclick, null);
  const acts = clickable(chip);
  assert.equal(acts.length, 1);
  assert.ok(/cs-grant-x/.test(acts[0].className));
  assert.ok(acts[0].attrs['aria-label']);
  // the rule itself is still readable in full, which is why the 160px ellipsis is acceptable
  const nm = walk(chip).find((n) => /cs-grant-nm/.test(n.className));
  assert.equal(nm.title, 'Bash(git:*)');
});

test('H4: the × passes the rule it belongs to, and only that one', () => {
  const seen = [];
  const chip = permChip('Read(C:/x/**)', { revokePersisted: (e) => seen.push(e) });
  clickable(chip)[0].onclick({ stopPropagation() {} });
  assert.deepEqual(seen, ['Read(C:/x/**)']);
});

test('H4: a tooltip no longer invites the click it no longer accepts', () => {
  const I18N = new Function(SRC('i18n.js').replace(/^\uFEFF/, '') + '; return I18N;')();
  for (const k of ['chat-side.dauerhaftTooltip', 'chat-status.immerErlaubtKlickenZum']) {
    for (const lang of ['de', 'en']) {
      assert.doesNotMatch(I18N[lang][k], /klicken|click/i,
        k + ' (' + lang + ') still tells the user to click the chip: ' + I18N[lang][k]);
    }
  }
  // …and the instruction exists where it is true
  assert.match(I18N.de['chat-side.regelEntfernen'], /entfernen/i);
  assert.match(I18N.de['chat-status.freigabeEntfernen'], /zur(ü|ue)cknehmen/i);
});

// ---------------------------------------------------------------- the toast itself
// toast() is in render.js, which touches the DOM at load — the undo branch is checked at the source, so a
// refactor that drops the button or the longer life is still caught.
test('H4: the undo toast is reachable long enough to be used', () => {
  const RENDER = SRC('render.js');
  assert.match(RENDER, /TOAST_UNDO_MS = (\d+)/);
  const ms = Number(RENDER.match(/TOAST_UNDO_MS = (\d+)/)[1]);
  assert.ok(ms >= 8000, 'the undo window is ' + ms + ' ms — an undo you cannot reach in time is not an undo');
  assert.match(RENDER, /t\.classList\.add\('sticky', 'toast-act'\)/, 'the undo toast lost its dismiss affordance');
  assert.match(RENDER, /u\.disabled = true/, 'the undo button can be clicked twice');
  // the label is the one the rest of the panel already uses, not a second word for the same act
  assert.match(RENDER, /chat-composer\.rueckgaengig/);
});
