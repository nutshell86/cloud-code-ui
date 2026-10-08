'use strict';
// Tests for the ui-skill-runs store in lib/core.js (F4): transcript rotation, the 200-entry cap and
// the mtime+size read cache that stopped six GET routes from re-parsing megabytes per request.
// CLAUDE_UI_DATA_DIR must be set before lib/paths is required (own process per test file).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-uiruns-test-'));
process.env.CLAUDE_UI_DATA_DIR = TMP;
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const core = require('../lib/core');
const RUNS_FILE = path.join(TMP, 'ui-skill-runs.json');
const mkRun = (i) => ({ id: 'run-' + i, name: 'demo', title: 'Demo ' + i, startedAt: 1700000000000 + i, status: 'done', transcript: 'T'.repeat(4000) + i });

describe('lib/core — ui-skill run store (F4)', () => {
  it('keeps the full transcript only on the newest 20 entries and flags the rest', async () => {
    await core.writeUiRuns(Array.from({ length: 30 }, (_, i) => mkRun(i)));
    const runs = await core.readUiRuns();
    assert.equal(runs.length, 30);
    const withText = runs.filter((r) => r.transcript);
    assert.equal(withText.length, 20, 'expected exactly the newest 20 transcripts');
    assert.ok(withText.every((r) => Number(r.id.slice(4)) >= 10), 'the kept transcripts are not the newest ones');
    const rotated = runs.filter((r) => r.transcriptRotated);
    assert.equal(rotated.length, 10);
    assert.ok(rotated.every((r) => r.transcript === ''), 'a rotated entry still carries text');
    assert.ok(rotated.every((r) => r.title && r.status && r.startedAt), 'rotation must keep the metadata');
  });

  it('the file shrinks measurably and is no longer pretty-printed', async () => {
    const arr = Array.from({ length: 60 }, (_, i) => mkRun(i));
    const pretty = JSON.stringify(arr, null, 2).length; // what the old writer produced
    await core.writeUiRuns(arr);
    const now = fs.statSync(RUNS_FILE).size;
    assert.ok(now < pretty / 2, 'rotation + compact JSON should at least halve the file (' + now + ' vs ' + pretty + ')');
    assert.ok(!fs.readFileSync(RUNS_FILE, 'utf8').includes('\n  "'), 'file is still pretty-printed');
  });

  it('still caps the history at 200 entries (newest kept)', async () => {
    await core.writeUiRuns(Array.from({ length: 260 }, (_, i) => mkRun(i)));
    const runs = await core.readUiRuns();
    assert.equal(runs.length, 200);
    assert.equal(runs[0].id, 'run-60', 'the cap dropped the wrong end');
    assert.equal(runs[199].id, 'run-259');
  });

  it('readUiRuns is cached until the file changes, and hands out a safe copy', async () => {
    await core.writeUiRuns([mkRun(1), mkRun(2)]);
    const a = await core.readUiRuns();
    const b = await core.readUiRuns();
    assert.notEqual(a, b, 'callers must not share the cached array (a push would corrupt it)');
    assert.deepEqual(a, b);
    a.push(mkRun(99)); // simulate a route mutating its copy
    assert.equal((await core.readUiRuns()).length, 2, 'a caller mutation leaked into the cache');
    await core.writeUiRuns([mkRun(1)]); // write must invalidate
    assert.equal((await core.readUiRuns()).length, 1);
  });

  it('a missing store reads as an empty list', async () => {
    fs.rmSync(RUNS_FILE, { force: true });
    assert.deepEqual(await core.readUiRuns(), []);
  });
});
