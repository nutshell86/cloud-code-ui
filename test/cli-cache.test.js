'use strict';
// lib/cli caches and the update singleton, in-process (no server):
//   • B5: ONE `npm view` (version + dist-tags + time.modified) — parallel callers share the in-flight
//     process, a repeat is served from the 30-min cache, `force` (the ↻ button) re-asks, and a FAILED
//     call is never cached (off-VPN at boot must not mean "registry unreachable" for 30 min);
//   • B1/FLOW-6: withCliUpdate is a singleton (a second caller gets code 'already-running' and never
//     runs), cliVersion() answers the flagged pre-update snapshot while it runs without spawning, and
//     the version cache is invalidated around it — the version AFTER the update is the new one, also
//     when a `--version` that started before the update only answers after it (cacheGen).
// `npm` is a counting node script via the CLAUDE_UI_FAKE_NPM seam; `claude` is fake-claude.js, whose
// "installed" version is a file here (FAKE_CLAUDE_VERSION_FILE) that the test's updater moves on.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-clicache-'));
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });
const counter = path.join(dir, 'calls.txt');
const fakeNpm = path.join(dir, 'fake-npm.js');
// FAKE_NPM_MODE=fail → exit 1 with nothing on stdout (registry unreachable); otherwise a normal answer
fs.writeFileSync(fakeNpm, `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x\\n');
  if (process.env.FAKE_NPM_MODE === 'fail') { process.stderr.write('npm ERR! network'); process.exit(1); }
  setTimeout(() => process.stdout.write(JSON.stringify({ version: '9.9.10', 'dist-tags': { latest: '9.9.11' }, 'time.modified': '2026-01-01T00:00:00Z' })), 200);`);
const calls = () => { try { return fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };

process.env.CLAUDE_UI_FAKE_NPM = fakeNpm;
delete process.env.CLAUDE_UI_FAKE_NPM_LATEST; // the sandbox shortcut would bypass the npm path entirely
process.env.CLAUDE_UI_FAKE_BIN = path.join(__dirname, '..', 'fake-claude.js');
const versionFile = path.join(dir, 'claude-version.txt');
const setVersion = (v) => fs.writeFileSync(versionFile, v);
process.env.FAKE_CLAUDE_VERSION_FILE = versionFile;
setVersion('9.9.9');
const freshCli = () => { delete require.cache[require.resolve('../lib/cli')]; return require('../lib/cli'); };

describe('lib/cli parseNpmView (pure)', () => {
  const { parseNpmView } = require('../lib/cli');
  it('reads the multi-field object; dist-tags.latest wins over version', () => {
    assert.deepEqual(parseNpmView('{"version":"1.2.3","dist-tags":{"latest":"1.2.4"},"time.modified":"2026-01-01T00:00:00Z"}'), { latest: '1.2.4', lastUpdated: '2026-01-01T00:00:00Z' });
    assert.deepEqual(parseNpmView('{"version":"1.2.3"}'), { latest: '1.2.3', lastUpdated: '' });
  });
  it('accepts a bare string (older npm, single field) and survives garbage', () => {
    assert.deepEqual(parseNpmView('"2.0.1"'), { latest: '2.0.1', lastUpdated: '' });
    assert.deepEqual(parseNpmView('npm ERR! 404'), { latest: null, lastUpdated: '' });
    assert.deepEqual(parseNpmView(''), { latest: null, lastUpdated: '' });
  });
});

describe('lib/cli latestFromNpm: one process, shared, cached (B5)', () => {
  it('a burst shares ONE npm process; a repeat comes from the cache; force re-asks', async () => {
    fs.rmSync(counter, { force: true });
    const cli = freshCli();
    const burst = await Promise.all([cli.latestFromNpm('9.9.9'), cli.latestFromNpm('9.9.9'), cli.latestFromNpm('9.9.9')]);
    for (const b of burst) assert.deepEqual(b, { latest: '9.9.11', lastUpdated: '2026-01-01T00:00:00Z' });
    assert.equal(calls(), 1, 'three parallel callers, one process');
    await cli.latestFromNpm('9.9.9');
    assert.equal(calls(), 1, 'served from the 30-min cache');
    await cli.latestFromNpm('9.9.9', { force: true });
    assert.equal(calls(), 2, 'force bypasses the cache');
  });
  it('a failed call is not cached — the next caller asks again', async () => {
    fs.rmSync(counter, { force: true });
    const cli = freshCli();
    process.env.FAKE_NPM_MODE = 'fail';
    try {
      assert.equal((await cli.latestFromNpm('9.9.9')).latest, null);
      assert.equal((await cli.latestFromNpm('9.9.9')).latest, null);
      assert.equal(calls(), 2, 'the failure was not served from a cache');
    } finally { delete process.env.FAKE_NPM_MODE; }
    assert.equal((await cli.latestFromNpm('9.9.9')).latest, '9.9.11', 'recovers on the next call');
    assert.equal(calls(), 3);
  });
});

describe('lib/cli withCliUpdate singleton + cliVersion during the update (B1/FLOW-6)', () => {
  it('second caller → already-running (fn never runs); cliVersion flags the snapshot; invalidated around it', async () => {
    setVersion('9.9.9');
    const cli = freshCli();
    const v0 = await cli.cliVersion(); // cached now (5-min TTL) — what a missing invalidate would serve below
    assert.equal(v0.current, '9.9.9');
    assert.equal(v0.updating, false);
    assert.equal(cli.isCliUpdating(), false);

    let release; const gate = new Promise((r) => (release = r));
    // the "updater": once released, the installed binary is a newer one
    const first = cli.withCliUpdate(() => gate.then(() => { setVersion('9.9.10'); return 'first-done'; }));
    // synchronous: the flag is up before withCliUpdate's first await
    assert.equal(cli.isCliUpdating(), true);
    assert.ok(cli.cliUpdatingSince() > 0);

    let ran = false;
    const second = await cli.withCliUpdate(async () => { ran = true; });
    assert.equal(ran, false, 'the second updater never ran');
    assert.equal(second.ok, false);
    assert.equal(second.code, 'already-running');
    assert.ok(second.since > 0);

    const during = await cli.cliVersion({ force: true });
    assert.equal(during.updating, true);
    assert.equal(during.canUpdate, false);
    assert.equal(during.current, '9.9.9', 'the last known state (snapshot), not an empty row');
    assert.ok(during.updatingSince > 0);

    const e = cli.cliUpdatingError();
    assert.equal(e.code, 'cli-updating');
    assert.equal(e.statusCode, 503);
    assert.equal(typeof e.hint, 'string');

    release();
    assert.equal(await first, 'first-done');
    assert.equal(cli.isCliUpdating(), false);
    const v1 = await cli.cliVersion();
    assert.equal(v1.updating, false, 'fresh answer after the update — the snapshot was not cached');
    assert.equal(v1.current, '9.9.10', 'the NEW version — the pre-update cache entry was invalidated');
  });

  it('a --version still running when the update starts never lands in the cache (cacheGen)', async () => {
    setVersion('9.9.9');
    const cli = freshCli();
    // a slow `--version`, spawned before the update (synchronously inside cliVersion(), so the env only
    // has to hold for this one call). Which version it manages to read is a race with the updater below
    // and does not matter: the contract is that its late answer is never CACHED — checked by identity.
    process.env.FAKE_CLAUDE_VERSION_MS = '1500';
    let p0Done = false;
    const p0 = cli.cliVersion();
    delete process.env.FAKE_CLAUDE_VERSION_MS;
    p0.then(() => { p0Done = true; }, () => {});
    // the whole update runs (and its invalidations happen) while that query is still in flight
    await cli.withCliUpdate(async () => { setVersion('9.9.10'); });
    assert.equal(p0Done, false, 'premise: the old query answers AFTER the update is over');
    const old = await p0;
    // what the caller of the old query gets is its own business; what matters is the next caller
    const v1 = await cli.cliVersion();
    assert.notEqual(v1, old, 'not served the late pre-update answer from the cache');
    assert.equal(v1.current, '9.9.10', 'a fresh --version of the updated binary');
  });
});
