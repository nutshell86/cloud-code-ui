'use strict';
// A test run must never reach the real, paid claude.exe. verify.js puts CLAUDE_UI_FAKE_BIN into every suite's
// env (test/sandbox.js), which is exactly what hid the hole: test/session-state.test.js set only its scenario,
// went green under verify — and run on its own (`node --test test/session-state.test.js`, the documented way to
// run one suite) it spawned the real CLI with „bitte den Workflow starten". Four transcripts with that user turn
// were found in ~/.claude/projects after the P-0 work. Two locks, because each covers what the other cannot:
//   · lib/chat.js startChat refuses to spawn under `node --test` without the seam (NODE_TEST_CONTEXT) — covers
//     every in-process start AND every server a suite boots (they inherit the runner's env);
//   · a source rule: a suite that starts chats in-process sets the seam itself — covers `node test/x.test.js`
//     without --test, where the runner's variable is absent.
// The behavioural case runs in a CHILD whose CLAUDE_UI_CLAUDE_BIN names a file that does not exist, so even with
// the guard removed (the mutation this case must catch) nothing real can start: the spawn just fails.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeSandbox } = require('./sandbox');

const ROOT = path.join(__dirname, '..');
const SBX = makeSandbox('realcli');
after(() => SBX.cleanup());
const NOWHERE = path.join(SBX.root, 'no-such-claude.exe');

// one startChat in a fresh process; prints what happened as one JSON line
const PROBE = [
  "const { startChat, killChat } = require(" + JSON.stringify(path.join(ROOT, 'lib', 'chat.js')) + ");",
  "let out;",
  "try { const c = startChat({ cwd: process.cwd(), permissionMode: 'plan' }); out = { threw: false }; try { killChat(c); } catch {} }",
  "catch (e) { out = { threw: true, code: e && e.code, message: String(e && e.message) }; }",
  "process.stdout.write(JSON.stringify(out) + '\\n'); setTimeout(() => process.exit(0), 50);",
].join('\n');
function probe(env) {
  const base = { ...process.env, ...SBX.env, CLAUDE_UI_CLAUDE_BIN: NOWHERE };
  delete base.CLAUDE_UI_FAKE_BIN; delete base.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['-e', PROBE], { cwd: SBX.root, env: Object.assign(base, env), encoding: 'utf8', timeout: 20000 });
  const line = String(r.stdout || '').trim().split('\n').pop();
  try { return JSON.parse(line); } catch { return { unparsed: (r.stdout || '') + (r.stderr || '') }; }
}

describe('a test run never spawns the real CLI', () => {
  it('startChat under node --test without CLAUDE_UI_FAKE_BIN throws real-cli-in-test — before any spawn', () => {
    const r = probe({ NODE_TEST_CONTEXT: 'child-v8' });
    assert.equal(r.threw, true, 'startChat spawned without the seam: ' + JSON.stringify(r));
    assert.equal(r.code, 'real-cli-in-test', JSON.stringify(r));
    assert.match(r.message, /CLAUDE_UI_FAKE_BIN/, 'the message must say which seam is missing');
  });

  it('…and is inert where it must be: with the seam under test, and outside the test runner', () => {
    const fake = path.join(ROOT, 'fake-claude.js').replace(/\\/g, '/');
    assert.deepEqual(probe({ NODE_TEST_CONTEXT: 'child-v8', CLAUDE_UI_FAKE_BIN: fake }), { threw: false });
    // production: no runner variable → startChat goes on to spawn CLAUDE_EXE (here a missing file, so the spawn
    // fails harmlessly — what matters is that the guard did not refuse it)
    const prod = probe({});
    assert.notEqual(prod.code, 'real-cli-in-test', 'the guard fired outside a test run: ' + JSON.stringify(prod));
  });

  it('premise: this very process runs under the test runner (otherwise the guard is never armed here)', () => {
    assert.ok(process.env.NODE_TEST_CONTEXT, 'NODE_TEST_CONTEXT unset — did node change how it marks test processes?');
  });

  it('every suite that starts chats IN-PROCESS sets the seam itself (covers a run without --test)', () => {
    const SPAWNS = /\b(startChat|runUiSkillHeadless)\(/;
    const LOADS = /require\('\.\.\/lib\/(chat|engine)'\)/;
    // `\b`, not `\)`: a suite may merge more seams into the same call — #91's budget.test.js writes
    // `Object.assign(process.env, sb.env, { CLAUDE_UI_BUDGET_POLL_MS: … })`, and sb.env carries the fake bin
    // (test/sandbox.js) like every sandbox env. The old `\)` read that as „no seam" — a false alarm.
    const SETS = /process\.env\.CLAUDE_UI_FAKE_BIN\s*=|Object\.assign\(process\.env,\s*\w+\.env\b/;
    const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js') && f !== path.basename(__filename));
    const spawning = files.filter((f) => { const s = fs.readFileSync(path.join(__dirname, f), 'utf8'); return LOADS.test(s) && SPAWNS.test(s); });
    assert.ok(spawning.length >= 5, 'premise: the in-process spawners were found (' + spawning.join(', ') + ')');
    assert.ok(spawning.includes('session-state.test.js'), 'premise: the suite this guard was written for is among them');
    const bare = spawning.filter((f) => !SETS.test(fs.readFileSync(path.join(__dirname, f), 'utf8')));
    assert.deepEqual(bare, [], 'starts chats without setting CLAUDE_UI_FAKE_BIN — run alone it reaches the paid CLI');
  });
});
