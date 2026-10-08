'use strict';
// CHAT-FLOW-4 part B — the pure rules of public/js/tab-windows.js: which entries of cc_tabs belong to which panel
// window, what a booting window restores, what a write keeps, and the Web Locks calls that say who is alive.
// The wiring (chat.js tabsBoot/tabsStore, two windows sharing one localStorage) is test/two-windows.test.js; this
// file is the module alone, plus the two pins that make it reachable at all (the script tag and its order).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const TW = require('../public/js/tab-windows');
const { makeLocks } = require('./fake-locks');

const ROOT = path.join(__dirname, '..');
const DAY = 24 * 3600 * 1000;
const NOW = 1_800_000_000_000;
const e = (sid, extra) => Object.assign({ sessionId: sid, title: 'T ' + sid }, extra || {});
const sids = (list) => list.map((x) => x.sessionId);

describe('tab-windows — groups', () => {
  it('a group per window id, in the order it first appears; no id (or a broken one) = the one legacy group', () => {
    const list = [e('a', { win: 'w1', at: 5 }), e('L1'), e('b', { win: 'w2', at: 9 }), e('a2', { win: 'w1', at: 7 }), e('L2', { win: 'bad id!' }), 'junk', null, [1]];
    const gs = TW.twGroups(list);
    assert.deepEqual(gs.map((g) => [g.win, g.at, sids(g.entries)]), [['w1', 7, ['a', 'a2']], ['', 0, ['L1', 'L2']], ['w2', 9, ['b']]]);
  });
});

describe('tab-windows — twMerge (what a write keeps)', () => {
  const alive = ['A', 'B'];
  it('replaces the OWN group with what the window has now, stamps it, passes every other entry through untouched', () => {
    const stored = [e('a1', { win: 'A', at: 1 }), e('a2', { win: 'A', at: 1 }), e('b1', { win: 'B', at: 2, projectId: 'p-7', zukunft: { x: [1, 2] } })];
    const { list, dropped } = TW.twMerge(stored, [e('a1'), e('a3')], { win: 'A', now: NOW, alive, active: 'a3' });
    assert.equal(dropped, 0);
    assert.deepEqual(sids(list), ['a1', 'a3', 'b1'], 'own entries first, then the others in their stored order');
    assert.deepEqual(list.slice(0, 2).map((x) => [x.win, x.at, x.active]), [['A', NOW, undefined], ['A', NOW, true]]);
    // a field this version does not know (projectId, feat/projekte) survives the write of a window that never read it
    assert.deepEqual(list[2], stored[2]);
    assert.notEqual(list[2], undefined);
  });

  it('a tab the window closed is gone — the merge never unions the stored own group with the new one', () => {
    const stored = [e('a1', { win: 'A', at: 1 }), e('a2', { win: 'A', at: 1 })];
    assert.deepEqual(sids(TW.twMerge(stored, [e('a1')], { win: 'A', now: NOW, alive }).list), ['a1']);
  });

  it('marks ONE active entry, and drops an `active` an entry carried in from elsewhere', () => {
    const { list } = TW.twMerge([], [e('x', { active: true }), e('y'), e('y')], { win: 'A', now: NOW, alive, active: 'y' });
    assert.deepEqual(list.map((x) => x.active), [undefined, true, undefined]);
  });

  it('age: an orphaned group older than 30 days goes; a LIVE group that old stays; a legacy group (no stamp) is not aged', () => {
    const stored = [e('old', { win: 'gone', at: NOW - 31 * DAY }), e('fresh', { win: 'gone2', at: NOW - 29 * DAY }), e('liveOld', { win: 'B', at: NOW - 90 * DAY }), e('legacy')];
    const { list, dropped } = TW.twMerge(stored, [], { win: 'A', now: NOW, alive });
    assert.deepEqual(sids(list), ['fresh', 'liveOld', 'legacy']);
    assert.equal(dropped, 1);
  });

  it('count: only the youngest four orphaned groups are kept (the legacy group is the oldest); live groups do not count', () => {
    const stored = [e('legacy')];
    for (let i = 1; i <= 6; i++) stored.push(e('o' + i, { win: 'o' + i, at: NOW - i * 1000 }));
    stored.push(e('b', { win: 'B', at: NOW - 99999 }));
    const { list, dropped } = TW.twMerge(stored, [e('mine')], { win: 'A', now: NOW, alive });
    assert.deepEqual(sids(list), ['mine', 'o1', 'o2', 'o3', 'o4', 'b']);
    assert.equal(dropped, 3);
    assert.equal(TW.TW_MAX_ORPHAN_GROUPS, 4);
  });

  it('size: over maxChars the OLDEST orphaned groups go first — never the own group, never a live one, even when they alone are over', () => {
    const big = 'x'.repeat(400);
    const stored = [e('o-young', { win: 'o1', at: NOW - 1, draft: big }), e('o-old', { win: 'o2', at: NOW - 2, draft: big }), e('b', { win: 'B', at: 1, draft: big })];
    const mine = [e('a', { draft: big })];
    const fits = TW.twMerge(stored, mine, { win: 'A', now: NOW, alive, maxChars: 100000 });
    assert.deepEqual(sids(fits.list), ['a', 'o-young', 'o-old', 'b'], 'under the cap nothing goes');
    const one = TW.twChars(fits.list);
    const tight = TW.twMerge(stored, mine, { win: 'A', now: NOW, alive, maxChars: one - 300 });
    assert.deepEqual(sids(tight.list), ['a', 'o-young', 'b'], 'the oldest orphan went first');
    const none = TW.twMerge(stored, mine, { win: 'A', now: NOW, alive, maxChars: 10 });
    assert.deepEqual(sids(none.list), ['a', 'b'], 'own and live are never dropped for size');
    assert.equal(none.dropped, 2);
    // the retry chat.js tabsWrite makes after a refused setItem: no orphaned group at all
    assert.deepEqual(sids(TW.twMerge(stored, mine, { win: 'A', now: NOW, alive, maxOrphanGroups: 0 }).list), ['a', 'b']);
  });

  it('nobody could say who is alive (alive null): nothing foreign is judged or dropped', () => {
    const stored = [e('old', { win: 'gone', at: 1 })];
    for (let i = 1; i <= 6; i++) stored.push(e('o' + i, { win: 'o' + i, at: NOW - i }));
    const { list, dropped } = TW.twMerge(stored, [], { win: 'A', now: NOW, alive: null, maxChars: 1 });
    assert.equal(list.length, 7);
    assert.equal(dropped, 0);
  });
});

describe('tab-windows — twPick (what a booting window restores)', () => {
  const stored = [e('b1', { win: 'B', at: 50 }), e('a1', { win: 'A', at: 10 }), e('a2', { win: 'A', at: 10 }), e('c1', { win: 'C', at: 30 }), e('L')];
  it('its own group, whoever else is alive (a reload, a session restore of this window)', () => {
    const p = TW.twPick(stored, { win: 'A', others: ['B'] });
    assert.deepEqual([sids(p.entries), p.group, p.own], [['a1', 'a2'], 'A', true]);
    assert.deepEqual(sids(TW.twPick(stored, { win: 'A', others: null }).entries), ['a1', 'a2']);
  });
  it('a second window starts EMPTY: another window lives → no group, not even an orphaned one', () => {
    assert.deepEqual(TW.twPick(stored, { win: 'N', others: ['B'] }), { entries: [], group: null, own: false });
    assert.deepEqual(TW.twPick(stored, { win: 'N', others: null }).entries, [], 'could not ask who lives → takes nothing');
  });
  it('the first window after a crash or a restart (nobody else alive): the YOUNGEST group, adopted whole', () => {
    const p = TW.twPick(stored, { win: 'N', others: [] });
    assert.deepEqual([sids(p.entries), p.group, p.own], [['b1'], 'B', false]);
    // a tie keeps the stored order: the later writer stands first
    assert.equal(TW.twPick([e('x', { win: 'X', at: 5 }), e('y', { win: 'Y', at: 5 })], { win: 'N', others: [] }).group, 'X');
  });
  it('a RELOAD without a group of its own gets nothing, even all alone: it is this window coming back, not a first one', () => {
    assert.deepEqual(TW.twPick(stored, { win: 'N', others: [], kind: 'reload' }), { entries: [], group: null, own: false });
    assert.deepEqual(sids(TW.twPick(stored, { win: 'A', others: [], kind: 'reload' }).entries), ['a1', 'a2'], 'its own group, as before');
    assert.equal(TW.twPick(stored, { win: 'N', others: [], kind: 'fresh' }).group, 'B', 'a fresh window still adopts');
    assert.equal(TW.twPick(stored, { win: 'N', others: [], kind: 'duplicate' }).group, 'B', 'a duplicate whose original is gone is a first window');
  });
  it('legacy entries (no window id) are ONE group — the oldest, adopted whole when nothing else is there', () => {
    const p = TW.twPick([e('L1'), e('L2', { cwd: 'C:\\x' })], { win: 'N', others: [] });
    assert.deepEqual([sids(p.entries), p.group], [['L1', 'L2'], '']);
    assert.equal(TW.twPick([e('L1'), e('w', { win: 'W', at: 1 })], { win: 'N', others: [] }).group, 'W');
  });
});

describe('tab-windows — twRetag and twActiveSession', () => {
  it('adopting moves exactly one group; leaving the own group behind moves it to an id nobody holds', () => {
    const stored = [e('L'), e('a', { win: 'A', at: 1 }), e('b', { win: 'B', at: 2 })];
    assert.deepEqual(TW.twRetag(stored, '', 'N').map((x) => x.win), ['N', 'A', 'B']);
    assert.deepEqual(TW.twRetag(stored, 'A', 'free').map((x) => x.win), [undefined, 'free', 'B']);
    assert.equal(stored[0].win, undefined, 'the stored list itself is not mutated');
  });
  it('the active session: a stamped group says it itself; the global cc_tabs_active only for a legacy list', () => {
    assert.equal(TW.twActiveSession([e('a', { win: 'A' }), e('b', { win: 'A', active: true })], 'zzz'), 'b');
    assert.equal(TW.twActiveSession([e('a', { win: 'A' })], 'a'), null, 'another window\'s cc_tabs_active must not pick a tab of this one');
    assert.equal(TW.twActiveSession([e('a'), e('b')], 'b'), 'b');
    assert.equal(TW.twActiveSession([], null), null);
  });
});

describe('tab-windows — twBootDraft (the composer of a window that restored no tab)', () => {
  const ss = (v) => ({ getItem: (k) => (k === TW.TW_DRAFT_KEY ? v : null) });
  const ls = (v) => ({ getItem: (k) => (k === 'cc_draft' ? v : null) });
  it('a reload: its OWN draft (sessionStorage) — never the global one, which another window may have typed', () => {
    assert.equal(TW.twBootDraft({ kind: 'reload', others: ['B'], session: ss('meins'), local: ls('von B') }), 'meins');
    assert.equal(TW.twBootDraft({ kind: 'reload', others: [], session: ss(null), local: ls('von B') }), '', 'nothing typed here → nothing, not the global draft');
  });
  it('the first window after a restart (nobody else alive): the global draft, as before part B', () => {
    assert.equal(TW.twBootDraft({ kind: 'fresh', others: [], session: ss(null), local: ls('zuletzt') }), 'zuletzt');
  });
  it('a second window, a duplicate, or nobody could say who lives: nothing — not even the copied own draft', () => {
    assert.equal(TW.twBootDraft({ kind: 'fresh', others: ['A'], session: ss(null), local: ls('von A') }), '');
    assert.equal(TW.twBootDraft({ kind: 'duplicate', others: ['B'], session: ss('kopiert von B'), local: ls('von B') }), '');
    assert.equal(TW.twBootDraft({ kind: 'duplicate', others: [], session: ss('kopiert'), local: ls('global') }), 'global', 'a duplicate whose original is gone is a first window');
    assert.equal(TW.twBootDraft({ kind: 'fresh', others: null, session: ss(null), local: ls('x') }), '');
  });
  it('a store that throws is no draft', () => {
    const bad = { getItem: () => { throw new Error('SecurityError'); } };
    assert.equal(TW.twBootDraft({ kind: 'reload', others: [], session: bad, local: bad }), '');
    assert.equal(TW.twBootDraft({ kind: 'fresh', others: [], session: bad, local: bad }), '');
  });
});

describe('tab-windows — the fake lock manager can freeze a window (test/fake-locks.js)', () => {
  it('a frozen client keeps every lock it holds, and gets grants and query answers only when it thaws', async () => {
    const L = makeLocks(); const a = L.client('a'), b = L.client('b');
    const rel = await TW.twHold(a, 'wa');
    L.freeze('a');
    assert.deepEqual(await TW.twAlive(b), ['wa'], 'a frozen window counts as gone');
    let answered = false; TW.twAlive(a).then(() => { answered = true; });
    let granted = false; a.request('x', () => { granted = true; });
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual([answered, granted], [false, false], 'a frozen window ran something');
    L.thaw('a');
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual([answered, granted], [true, true]);
    rel();
  });
});

// The lock calls, against the fake the two-window harness uses AND against Node's real Web Locks implementation —
// the second run is what keeps the fake honest.
const REAL = (typeof navigator !== 'undefined' && navigator.locks) ? navigator.locks : null;
const managers = [['fake', () => makeLocks().client('t')]].concat(REAL ? [['node navigator.locks', () => REAL]] : []);
const session = (m) => { const s = new Map(Object.entries(m || {})); return { getItem: (k) => (s.has(k) ? s.get(k) : null), setItem: (k, v) => s.set(k, String(v)), map: s }; };
let uniq = 0;
const nid = () => 'u' + process.pid + 'x' + (++uniq) + 'y' + Date.now().toString(36);

for (const [label, mk] of managers) {
  describe('tab-windows — the Web Locks calls (' + label + ')', () => {
    it('twHold: a free id is held until released, a held one answers null', async () => {
      const L = mk(); const id = nid();
      const rel = await TW.twHold(L, id);
      assert.equal(typeof rel, 'function');
      assert.equal(await TW.twHold(L, id), null, 'a held window lock was granted twice');
      rel();
      await new Promise((r) => setTimeout(r, 5));
      const again = await TW.twHold(L, id);
      assert.equal(typeof again, 'function', 'the released lock stayed taken');
      again();
    });
    it('twAlive: the ids of the held WINDOW locks — not the cc_tabs lock, not other names', async () => {
      const L = mk(); const a = nid(), b = nid();
      const ra = await TW.twHold(L, a), rb = await TW.twHold(L, b);
      let alive;
      await L.request(TW.TW_STORE_LOCK, async () => { await L.request('something-else-' + a, async () => { alive = await TW.twAlive(L); }); });
      assert.ok(alive.includes(a) && alive.includes(b));
      assert.ok(!alive.some((x) => x === TW.TW_STORE_LOCK || /^something-else/.test(x)));
      ra(); rb();
    });
    it('twReclaim: no id → fresh; a free id → reload; an id held the whole grace → duplicate; one that falls within it → reload', async () => {
      const L = mk();
      assert.equal((await TW.twReclaim({ locks: L, session: session(), setTimeout })).kind, 'fresh');
      assert.equal((await TW.twReclaim({ locks: L, session: session({ 'ccui-win': 'not a valid id!' }), setTimeout })).kind, 'fresh');
      const free = nid();
      const r1 = await TW.twReclaim({ locks: L, session: session({ 'ccui-win': free }), setTimeout });
      assert.deepEqual([r1.win, r1.kind], [free, 'reload']);
      // the original window still holds it (that is what „Duplicate tab" leaves behind)
      const dup = await TW.twReclaim({ locks: L, session: session({ 'ccui-win': free }), setTimeout, graceMs: 40, pollMs: 10 });
      assert.deepEqual([dup.win, dup.kind], [null, 'duplicate']);
      // a reload whose old document lets go a moment late
      setTimeout(() => r1.release(), 15);
      const late = await TW.twReclaim({ locks: L, session: session({ 'ccui-win': free }), setTimeout, graceMs: 200, pollMs: 10 });
      assert.deepEqual([late.win, late.kind], [free, 'reload']);
      late.release();
    });
    it('twReclaim with the SHIPPED grace (no graceMs): an old document that lets go 300 ms late is still a reload', async () => {
      const L = mk(); const id = nid();
      const old = await TW.twHold(L, id);
      setTimeout(() => old(), 300);
      const t0 = Date.now();
      const r = await TW.twReclaim({ locks: L, session: session({ 'ccui-win': id }), setTimeout });
      assert.deepEqual([r.win, r.kind], [id, 'reload'], 'the shipped grace took a reload 300 ms late for a duplicate');
      assert.ok(Date.now() - t0 >= 250, 'premise: it waited for the old lock');
      r.release();
    });
  });
}

describe('tab-windows — the shipped bounds (reasoned, not measured — CHANGELOG; changing one is a decision, not a refactor)', () => {
  it('the reload grace is 1 s, the size cap 800 000 characters, four orphaned groups, 30 days', () => {
    assert.equal(TW.TW_GRACE_MS, 1000);
    assert.equal(TW.TW_MAX_CHARS, 800000);
    assert.equal(TW.TW_MAX_ORPHAN_GROUPS, 4);
    assert.equal(TW.TW_ORPHAN_MAX_AGE_MS, 30 * DAY);
  });
});

describe('tab-windows — reachable and pure', () => {
  it('index.html loads tab-windows.js BEFORE chat.js (tabsBoot, persistTabs, restoreTabs call it) and before boot.js', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const at = (f) => html.indexOf('/js/' + f + '"');
    assert.ok(at('tab-windows.js') > 0, 'index.html does not load tab-windows.js');
    for (const later of ['chat.js', 'commands.js', 'boot.js']) assert.ok(at('tab-windows.js') < at(later), 'tab-windows.js must load before ' + later);
  });
  it('the module touches no DOM and no storage of its own — the caller hands both in', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'tab-windows.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /\b(document|window|localStorage|sessionStorage|navigator)\b/);
  });
  it('boot.js hands the restore to tabsBoot — the one place that decides what a window restores', () => {
    const boot = fs.readFileSync(path.join(ROOT, 'public', 'js', 'boot.js'), 'utf8');
    assert.match(boot, /step\(\(\) => tabsBoot\(\)\);/);
    assert.doesNotMatch(boot, /restoreTabs\(\)/, 'a second restore path next to tabsBoot');
    assert.doesNotMatch(boot, /getItem\('cc_draft'\)/, 'the global draft is tabsBoot\'s (a second window must not show the first one\'s)');
    // the window id is taken back BEFORE boot.js waits for /api/state — a window starting in that wait would
    // otherwise adopt the tabs of this one, which counts as closed until it holds its lock again
    const reclaim = boot.indexOf('tabsReclaim()'), state = boot.indexOf("await api('/api/state')"), decide = boot.indexOf('step(() => tabsBoot());');
    assert.ok(reclaim > 0 && reclaim < state && state < decide, 'boot.js: tabsReclaim() first, then /api/state, then tabsBoot');
  });
  it('the composer keeps no form state of the browser\'s own (a duplicate or a session restore would carry the original\'s text in)', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const m = /<textarea id="composerInput"[^>]*>/.exec(html);
    assert.ok(m, 'premise: the composer');
    assert.match(m[0], / autocomplete="off"/);
  });
});
