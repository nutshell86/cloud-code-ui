'use strict';
// applySettingsOps (DATA-2, PATCH /api/config/settings) and the file helpers under it (DATA-1, KORR-3).
// The comfort actions send WHAT they change; the server applies it to the file as it is on disk. These
// pin the semantics every client caller relies on — above all: an element is named by its value, and a
// change that no longer fits the file is a 409, never a guess.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applySettingsOps, validateSettingsOps, jsonEqual } = require('../lib/pure');
const { readJsonFile, readSettingsSnapshot, textHash, withFileLock } = require('../lib/core');

// ------------------------------------------------------- applySettingsOps
test('applySettingsOps set: creates the path, replaces a value, reports no change for the same value', () => {
  const r = applySettingsOps({ theme: 'dark' }, [{ op: 'set', path: ['env', 'AWS_REGION'], value: 'eu-central-1' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { theme: 'dark', env: { AWS_REGION: 'eu-central-1' } });
  assert.equal(r.changed, true);
  const same = applySettingsOps(r.value, [{ op: 'set', path: ['env', 'AWS_REGION'], value: 'eu-central-1' }]);
  assert.equal(same.changed, false, 'setting the value that is already there writes nothing');
  // keys with dots (plugin names, env vars) are ONE segment — path is an array, never a dotted string
  const p = applySettingsOps({}, [{ op: 'set', path: ['enabledPlugins', 'frontend-design@claude-plugins'], value: true }]);
  assert.deepEqual(p.value, { enabledPlugins: { 'frontend-design@claude-plugins': true } });
});

test('applySettingsOps delete: no-op when absent, and drops the containers it leaves empty', () => {
  const absent = applySettingsOps({ a: 1 }, [{ op: 'delete', path: ['env', 'X'] }]);
  assert.equal(absent.ok, true);
  assert.equal(absent.changed, false);
  assert.deepEqual(absent.value, { a: 1 }, 'delete never builds the path it walks');
  const r = applySettingsOps({ env: { X: '1' }, a: 1 }, [{ op: 'delete', path: ['env', 'X'] }]);
  assert.deepEqual(r.value, { a: 1 }, 'the emptied env block goes too (what every client did by hand)');
  const keep = applySettingsOps({ env: { X: '1', Y: '2' } }, [{ op: 'delete', path: ['env', 'X'] }]);
  assert.deepEqual(keep.value, { env: { Y: '2' } });
  // an explicit {} written with set is kept — only delete/pull prune
  assert.deepEqual(applySettingsOps({}, [{ op: 'set', path: ['env'], value: {} }]).value, { env: {} });
});

test('applySettingsOps push: appends, creates the list, keeps ONE copy of an equal element', () => {
  const r = applySettingsOps({}, [{ op: 'push', path: ['permissions', 'allow'], value: 'Bash(git status)' }]);
  assert.deepEqual(r.value, { permissions: { allow: ['Bash(git status)'] } });
  const again = applySettingsOps(r.value, [{ op: 'push', path: ['permissions', 'allow'], value: 'Bash(git status)' }]);
  assert.equal(again.changed, false, 'two tabs allowing the same tool keep one rule');
  assert.deepEqual(again.value.permissions.allow, ['Bash(git status)']);
  // objects compare by content, key order irrelevant (hook entries)
  const h = { hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }] } };
  const dup = applySettingsOps(h, [{ op: 'push', path: ['hooks', 'Stop'], value: { hooks: [{ command: 'x', type: 'command' }], matcher: '*' } }]);
  assert.equal(dup.changed, false);
});

test('applySettingsOps pull: removes by value, prunes, strict turns "nothing matched" into 409', () => {
  const s = { permissions: { allow: ['A', 'B'], deny: ['C'] } };
  const r = applySettingsOps(s, [{ op: 'pull', path: ['permissions', 'allow'], value: 'A' }]);
  assert.deepEqual(r.value, { permissions: { allow: ['B'], deny: ['C'] } });
  const last = applySettingsOps({ permissions: { allow: ['A'] } }, [{ op: 'pull', path: ['permissions', 'allow'], value: 'A' }]);
  assert.deepEqual(last.value, {}, 'allow emptied → allow and permissions both go');
  const miss = applySettingsOps(s, [{ op: 'pull', path: ['permissions', 'allow'], value: 'Z' }]);
  assert.equal(miss.ok, true);
  assert.equal(miss.changed, false, 'non-strict: already gone is fine (a revoke that raced another revoke)');
  // strict: the hook the browser saw is no longer there exactly — a conflict, not a wrong deletion
  for (const file of [s, {}, { hooks: { Stop: [] } }]) {
    const st = applySettingsOps(file, [{ op: 'pull', path: ['hooks', 'Stop'], value: { hooks: [] }, strict: true }]);
    assert.equal(st.ok, false, JSON.stringify(file));
    assert.equal(st.status, 409);
    assert.equal(st.code, 'conflict');
  }
});

test('applySettingsOps: a later op sees the earlier one; one failing op applies nothing', () => {
  // the hook-remove shape (views.js removeHook): pull the entry, push it back without the one command
  const entry = { matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] };
  const r = applySettingsOps({ hooks: { PreToolUse: [entry] } }, [
    { op: 'pull', path: ['hooks', 'PreToolUse'], value: entry, strict: true },
    { op: 'push', path: ['hooks', 'PreToolUse'], value: { matcher: 'Bash', hooks: [{ type: 'command', command: 'b' }] } },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'b' }] }] } }, 'pruned by the pull, rebuilt by the push');
  const input = { a: 1 };
  const bad = applySettingsOps(input, [{ op: 'set', path: ['b'], value: 2 }, { op: 'push', path: ['a'], value: 3 }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 409);
  assert.equal(bad.index, 1, 'names the op that did not fit');
  assert.deepEqual(input, { a: 1 }, 'the input is never mutated — not even by the op that succeeded first');
});

test('applySettingsOps: a key that holds another type is 409 `shape` (not `conflict`), the file itself must be an object', () => {
  // `shape`, because the client's answer differs: a conflict says "changed meanwhile, try again" — here
  // a retry fails exactly the same way, so the toast has to name the key instead
  const r = applySettingsOps({ env: 'oops' }, [{ op: 'set', path: ['env', 'X'], value: '1' }]);
  assert.equal(r.status, 409);
  assert.equal(r.code, 'shape');
  assert.match(r.error, /env is not an object/);
  const push = applySettingsOps({ permissions: { allow: 'A' } }, [{ op: 'push', path: ['permissions', 'allow'], value: 'B' }]);
  assert.equal(push.status, 409);
  assert.equal(push.code, 'shape');
  assert.equal(applySettingsOps({ permissions: { allow: 'A' } }, [{ op: 'pull', path: ['permissions', 'allow'], value: 'A' }]).code, 'shape');
  for (const notObj of [null, [], 'x', 1]) assert.equal(applySettingsOps(notObj, [{ op: 'delete', path: ['a'] }]).code, 'not-object', JSON.stringify(notObj));
});

test('applySettingsOps: values are copied in, not aliased', () => {
  const value = { list: [1] };
  const r = applySettingsOps({}, [{ op: 'set', path: ['x'], value }]);
  value.list.push(2);
  assert.deepEqual(r.value.x, { list: [1] });
});

test('validateSettingsOps: malformed requests are 400 bad-op before anything is touched', () => {
  const bad = (ops) => { const v = validateSettingsOps(ops); assert.equal(v.ok, false, JSON.stringify(ops)); assert.equal(v.status, 400); assert.equal(v.code, 'bad-op'); return v; };
  bad(undefined); bad([]); bad({}); bad('set');
  bad([{ op: 'merge', path: ['a'], value: 1 }]);
  bad([{ op: 'set', path: 'env.X', value: 1 }]);           // dotted string, not an array
  bad([{ op: 'set', path: [], value: 1 }]);
  bad([{ op: 'set', path: ['a', ''], value: 1 }]);
  bad([{ op: 'set', path: ['a', 0], value: 1 }]);          // no array indices
  bad([{ op: 'set', path: ['a'] }]);                       // set needs a value
  bad([{ op: 'push', path: ['a'] }]);
  bad([{ op: 'set', path: new Array(11).fill('k'), value: 1 }]);
  bad(new Array(101).fill({ op: 'delete', path: ['a'] }));
  for (const k of ['__proto__', 'constructor', 'prototype']) {
    const v = bad([{ op: 'set', path: ['env', k], value: 'x' }]);
    assert.match(v.error, /not allowed/);
  }
  assert.equal(bad([{ op: 'delete', path: ['a'] }, { op: 'nope', path: ['b'] }]).index, 1);
  assert.equal(validateSettingsOps([{ op: 'delete', path: ['a'] }]).ok, true, 'delete needs no value');
  assert.equal(validateSettingsOps([{ op: 'set', path: ['a'], value: null }]).ok, true, 'null is a value');
  // applySettingsOps validates too — it is never called with unchecked ops by accident
  assert.equal(applySettingsOps({}, [{ op: 'set', path: ['__proto__', 'x'], value: 1 }]).status, 400);
  assert.equal(({}).x, undefined, 'and nothing reached the prototype');
});

test('jsonEqual: deep, order-insensitive for keys, order-sensitive for arrays', () => {
  assert.equal(jsonEqual({ a: [1, { b: 2 }], c: null }, { c: null, a: [1, { b: 2 }] }), true);
  assert.equal(jsonEqual([1, 2], [2, 1]), false);
  assert.equal(jsonEqual({ a: 1 }, { a: 1, b: undefined }), false);
  assert.equal(jsonEqual({}, []), false);
  assert.equal(jsonEqual(null, {}), false);
});

// ------------------------------------------------------- readJsonFile / readSettingsSnapshot (DATA-1)
test('readJsonFile: a file that does not parse keeps its text; missing and empty are {}', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-rjf-'));
  try {
    const broken = path.join(dir, 'settings.json');
    const text = '{\n  "env": { "CLAUDE_CODE_USE_BEDROCK": "1" },\n}\n'; // trailing comma — a typical hand edit
    fs.writeFileSync(broken, text);
    const r = await readJsonFile(broken);
    assert.equal(r.exists, true);
    assert.equal(r.parsed, null, 'not {} — that is what made the next save wipe the env block');
    assert.equal(r.raw, text, 'the bytes survive for the editor');
    assert.ok(r.error, 'and the parser says why');
    assert.deepEqual(await readJsonFile(path.join(dir, 'nope.json')), { exists: false, raw: '', parsed: {} });
    fs.writeFileSync(path.join(dir, 'empty.json'), '  \n');
    assert.deepEqual((await readJsonFile(path.join(dir, 'empty.json'))).parsed, {});
    // the snapshot's hash is of the TEXT, so a broken file has a version too (If-Match can name it)
    const snap = await readSettingsSnapshot(broken);
    assert.equal(snap.hash, textHash(text));
    assert.equal((await readSettingsSnapshot(path.join(dir, 'nope.json'))).hash, textHash(''), 'missing hashes like empty');
    assert.notEqual(textHash('{}'), textHash('{ }'), 'any byte change is a new version');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readJsonFile: a UTF-8 BOM parses (the CLI strips it too); the text and its hash keep it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-bom-'));
  try {
    const f = path.join(dir, 'settings.json');
    const text = '\uFEFF{\n  "env": { "AWS_REGION": "eu-central-1" }\n}\n'; // PowerShell 5.1 `-Encoding UTF8`
    fs.writeFileSync(f, text, 'utf8');
    const r = await readJsonFile(f);
    assert.deepEqual(r.parsed, { env: { AWS_REGION: 'eu-central-1' } }, 'not locked as "broken" over an invisible character');
    assert.equal(r.raw, text, 'raw is the file as it is');
    assert.equal((await readSettingsSnapshot(f)).hash, textHash(text), 'If-Match names the bytes on disk, BOM included');
    fs.writeFileSync(f, '\uFEFF', 'utf8');
    assert.deepEqual((await readJsonFile(f)).parsed, {}, 'a BOM alone is an empty file');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readSettingsSnapshot: a file that cannot be read is `unreadable`, with a hash no text can have', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-unread-'));
  try {
    const f = path.join(dir, 'settings.json');
    fs.mkdirSync(f); // EISDIR — stands in for EPERM/EBUSY, which a test cannot provoke portably
    const s = await readSettingsSnapshot(f);
    assert.equal(s.exists, true);
    assert.equal(s.parsed, null);
    assert.equal(s.unreadable, true);
    assert.ok(s.error);
    assert.equal(s.raw, '');
    assert.notEqual(s.hash, textHash(''), 'the "missing/empty" hash would let a client that saw nothing replace it');
    assert.equal(s.hash, 'unreadable');
    assert.equal((await readJsonFile(path.join(dir, 'nope.json'))).unreadable, undefined, 'missing is not unreadable');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------- withFileLock (KORR-3)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test('withFileLock: the timeout counts from when a section STARTS, so a queued one never overlaps', async () => {
  // Three 300 ms sections, 500 ms lock timeout. With the old clock (started at the CALL), the second
  // section's gate opened at t=500 while it ran from 300 to 600 — the third then ran concurrently.
  // (Was 70/100: under verify's parallel pass a 70 ms sleep overran the 30 ms margin and hit its own timeout.)
  const key = path.join(os.tmpdir(), 'ccui-lock-korr3-' + process.pid);
  let active = 0, maxActive = 0;
  const order = [];
  const section = (name) => async () => {
    active++; maxActive = Math.max(maxActive, active); order.push(name + '>');
    await sleep(300);
    order.push('<' + name); active--;
    return name;
  };
  const errs = [];
  const origErr = console.error; console.error = (m) => errs.push(String(m));
  try {
    const out = await Promise.all(['a', 'b', 'c'].map((n) => withFileLock(key, section(n), { timeoutMs: 500 })));
    assert.deepEqual(out, ['a', 'b', 'c']);
  } finally { console.error = origErr; }
  assert.equal(maxActive, 1, 'sections overlapped: ' + order.join(' '));
  assert.deepEqual(order, ['a>', '<a', 'b>', '<b', 'c>', '<c']);
  assert.deepEqual(errs, [], 'no section hit its own timeout');
});

test('withFileLock: a stalled section releases the lock after its timeout; a throw does not wedge it', async () => {
  const key = path.join(os.tmpdir(), 'ccui-lock-stall-' + process.pid);
  const origErr = console.error; console.error = () => {};
  try {
    let releaseStall;
    const stalled = withFileLock(key, () => new Promise((r) => { releaseStall = r; }), { timeoutMs: 60 });
    const t0 = Date.now();
    const next = await withFileLock(key, async () => 'next', { timeoutMs: 1000 });
    assert.equal(next, 'next');
    assert.ok(Date.now() - t0 >= 50, 'it waited for the stalled section\'s timeout');
    releaseStall('late');
    assert.equal(await stalled, 'late', 'the stalled caller still gets its own result');
    await assert.rejects(withFileLock(key, () => { throw new Error('sync boom'); }), /sync boom/);
    assert.equal(await withFileLock(key, async () => 'after'), 'after', 'the lock is usable after a throw');
  } finally { console.error = origErr; }
});
