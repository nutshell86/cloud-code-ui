'use strict';
// verify.js tapFailures: a red run must say WHICH case failed, WHERE, and WHY — not only the describe it
// sits in. Fed with REAL tap from this node's own reporter (a throwaway test file in the temp dir, run
// with --test-reporter=tap), so a reporter that changes its format turns this red instead of the
// function quietly matching nothing.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'verify.js'), 'utf8');
// a top-level function by name — a block that ends with `}` at column 0
function liftFn(src, name) {
  const m = new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}', 'm').exec(src);
  assert.ok(m, name + '() not found in verify.js — renamed or reindented? Then these tests prove nothing.');
  return m[0];
}
const tapFailures = new Function(liftFn(SRC, 'tapFailures') + '\nreturn tapFailures;')();

describe('verify.js tapFailures — the red case, its place and its message', () => {
  let dir, tap;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-tapfail-'));
    const f = path.join(dir, 'sample.test.js');
    fs.writeFileSync(f, [
      "const { describe, it } = require('node:test');",
      "const assert = require('node:assert/strict');",
      "describe('Gruppe A', () => {",
      "  it('dieser Fall ist grün', () => {});",
      "  it('dieser Fall ist rot', () => { assert.equal(1, 2, 'die eigentliche Meldung'); });",
      '});',
      '',
    ].join('\n'));
    // Without NODE_TEST_CONTEXT: this file runs under node --test, and a nested `node --test` that inherits
    // it reports to its parent in node's internal format — 0 bytes of tap (measured), and every assertion
    // below would be checking an empty string.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', f], { encoding: 'utf8', env });
    tap = (r.stdout || '') + (r.stderr || '');
  });
  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('names the failing CASE, not only its describe', () => {
    assert.match(tap, /^not ok \d+ - Gruppe A/m, 'premise: the sample run produced real tap');
    const out = tapFailures(tap).join('\n');
    assert.match(out, /not ok - Gruppe A/, 'the group is still there:\n' + out);
    assert.match(out, /not ok - dieser Fall ist rot/, 'and so is the case inside it:\n' + out);
    assert.doesNotMatch(out, /dieser Fall ist grün/, 'a passing case is not reported');
  });

  it('carries the assertion message and the file:line of the failing case', () => {
    const out = tapFailures(tap).join('\n');
    assert.match(out, /die eigentliche Meldung/, 'the message that says WHY:\n' + out);
    assert.match(out, /sample\.test\.js:\d+/, 'and WHERE:\n' + out);
  });

  it('a green run reports nothing', () => {
    assert.deepEqual(tapFailures('TAP version 13\nok 1 - a\n# tests 1\n# pass 1\n# fail 0\n'), []);
  });
});
