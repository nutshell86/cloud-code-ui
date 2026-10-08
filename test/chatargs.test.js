'use strict';
// The new launch flags (A3 budget cap, A15 extra roots, N1 suggestions, N2 session name) are argv, and
// argv is invisible until it is wrong: a typo produces a session that silently runs WITHOUT the cap you
// set. So assert what actually reaches the process. CLAUDE_UI_FAKE_BIN makes startChat spawn a node
// script instead of claude.exe — here that script just prints its own argv and exits.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-chatargs-'));
const FAKE = path.join(TMP, 'echo-argv.js');
// argv AND the CLAUDE_CODE_* env, because the subagent policy (#34) travels in both: the off-switch is
// a flag, the model and the ceilings are environment variables. An env var that never reaches the
// process is exactly as invisible as a mistyped flag.
// ONE FILE PER PROCESS (keyed by its pid), not one shared argv.json: several tests below start a chat
// only for its meta and end it with killChat, which on Windows is an asynchronous taskkill — such a fake
// can still be booting, and write, AFTER the next test's spawn wrote its own file. With a shared file the
// late writer overwrote the argv the next test was about to read (seen once as „not ok — ultracode
// reaches the process": the argv of a `startChat({})` from the test before, without --settings).
// startChat spawns node directly (no shell), so chat.proc.pid IS the fake's process.pid.
const outFor = (kind, pid) => path.join(TMP, kind + '-' + pid + '.json');
fs.writeFileSync(FAKE, [
  'const fs = require("fs"), path = require("path");',
  'const out = (k) => path.join(' + JSON.stringify(TMP) + ', k + "-" + process.pid + ".json");',
  'fs.writeFileSync(out("argv"), JSON.stringify(process.argv.slice(2)));',
  'const e = {}; for (const k of Object.keys(process.env)) if (/^CLAUDE_CODE_(SUBAGENT|MAX_|MCP_|EMIT_)/.test(k)) e[k] = process.env[k];',
  'fs.writeFileSync(out("env"), JSON.stringify(e));',
].join('\n') + '\n');
// absolute path with forward slashes — a relative one resolves against the CHAT cwd, not ours, and
// `/c/...` is not a path node understands (documented gotcha of this seam)
process.env.CLAUDE_UI_FAKE_BIN = FAKE.replace(/\\/g, '/');

const { startChat, killChat, PERM_MODES } = require('../lib/chat');
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

// spawn, wait for the fake binary to have written its argv, tear the chat down again. `meta` rides along,
// so a test that needs argv AND the receipt gets both from ONE awaited spawn.
function spawnFor(opts) {
  return new Promise((resolve) => {
    const chat = startChat(opts);
    const pid = chat.proc.pid;
    chat.proc.on('exit', () => {
      let a = [], e = {};
      try { a = JSON.parse(fs.readFileSync(outFor('argv', pid), 'utf8')); } catch { /* */ }
      try { e = JSON.parse(fs.readFileSync(outFor('env', pid), 'utf8')); } catch { /* */ }
      // gone after reading: a later process that happens to get the same pid must not find this one's
      for (const k of ['argv', 'env']) { try { fs.rmSync(outFor(k, pid), { force: true }); } catch { /* */ } }
      try { killChat(chat); } catch { /* */ }
      resolve({ argv: a, env: e, meta: chat.meta });
    });
  });
}
async function argvFor(opts) { return (await spawnFor(opts)).argv; }
const valOf = (argv, flag) => { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1]; };
// #17: the two FREE-TEXT flags are passed as ONE token (`--name=…`), so their value is not the NEXT
// argv element — there is no next element that a dash-leading text could turn into something else.
const eqOf = (argv, flag) => { const a = argv.find((x) => x.startsWith(flag + '=')); return a === undefined ? null : a.slice(flag.length + 1); };
const allOf = (argv, flag) => argv.reduce((acc, x, i) => (x === flag ? acc.concat(argv[i + 1]) : acc), []);

describe('lib/chat — launch flags reach the process', () => {
  it('the baseline spawn carries none of the new flags', async () => {
    const a = await argvFor({});
    ['--max-budget-usd', '--add-dir', '--name', '--prompt-suggestions', '--fallback-model'].forEach((f) => {
      assert.ok(!a.includes(f), f + ' must not appear unless it was asked for');
    });
    assert.ok(a.includes('--permission-prompt-tool'), 'the permission channel must stay wired');
  });

  it('A3: a positive budget becomes --max-budget-usd, anything else is dropped', async () => {
    assert.equal(valOf(await argvFor({ maxBudgetUsd: 2.5 }), '--max-budget-usd'), '2.5');
    assert.equal(valOf(await argvFor({ maxBudgetUsd: '3' }), '--max-budget-usd'), '3');
    for (const bad of [0, -1, 'abc', null, NaN]) {
      const a = await argvFor({ maxBudgetUsd: bad });
      assert.ok(!a.includes('--max-budget-usd'), 'budget ' + JSON.stringify(bad) + ' must not produce a flag');
    }
  });

  it('A3: the cap is reflected in chat.meta so the UI can show it', async () => {
    const chat = startChat({ maxBudgetUsd: 4 });
    assert.equal(chat.meta.maxBudgetUsd, 4);
    killChat(chat);
    const c2 = startChat({});
    assert.equal(c2.meta.maxBudgetUsd, null);
    killChat(c2);
  });

  it('A15: only EXISTING extra directories are passed, and never the cwd itself', async () => {
    const real = fs.mkdtempSync(path.join(TMP, 'root-'));
    const gone = path.join(TMP, 'does-not-exist');
    const a = await argvFor({ cwd: TMP, addDirs: [real, gone, '', '   ', TMP] });
    const dirs = allOf(a, '--add-dir');
    assert.deepEqual(dirs, [real], 'a stale entry must be dropped, not passed on and not fatal');
  });

  it('N2: the panel title becomes --name, trimmed and length-capped', async () => {
    assert.equal(eqOf(await argvFor({ name: '  PROJ-718 bAV  ' }), '--name'), 'PROJ-718 bAV');
    assert.equal(eqOf(await argvFor({ name: 'x'.repeat(200) }), '--name').length, 80);
    const blank = await argvFor({ name: '   ' });
    // Both assertions on purpose: eqOf only looks for a "--name=" token, so it also returns null for
    // a BARE '--name' — which is the regression this case exists for (the CLI would then read the
    // following flag as the session name).
    assert.equal(eqOf(blank, '--name'), null, 'a blank name must not be sent');
    assert.ok(!blank.includes('--name'), 'a blank name must not leave a valueless --name token behind');
  });

  // #17: free text stays free (a guardrail line may begin with "- "), so it must not be able to look
  // like a flag POSITION either — flag and value are one token, and nothing follows that the CLI's
  // option parser could read as the value instead.
  it('the two free-text flags are one argv token each', async () => {
    const a = await argvFor({ name: '-x', appendSystem: '- Immer auf Deutsch antworten' });
    assert.equal(eqOf(a, '--name'), '-x');
    assert.equal(eqOf(a, '--append-system-prompt'), '- Immer auf Deutsch antworten');
    assert.ok(!a.includes('--name') && !a.includes('--append-system-prompt'), 'a bare flag token would take the next element as its value');
    assert.ok(!a.includes('-x'), 'the text must not stand in argv on its own');
  });

  // G3 — the stand-in model. `--fallback-model` did not appear anywhere in this repo before, so the one
  // lever that turns a 529 into a finished turn was unreachable from the panel. The EMPTY case is the
  // important half of this test: the field is optional in three different forms (chat start body, skill
  // manifest run block, schedule), and a blank one must not hand the CLI `--fallback-model ""` — which
  // would be an empty model id on every single run nobody filled the field in for.
  it('G3: a fallback model becomes --fallback-model, and an EMPTY field produces no flag at all', async () => {
    assert.equal(valOf(await argvFor({ fallbackModel: 'sonnet' }), '--fallback-model'), 'sonnet');
    assert.equal(valOf(await argvFor({ fallbackModel: '  sonnet  ' }), '--fallback-model'), 'sonnet');
    for (const bad of ['', '   ', null, undefined, false, 0]) {
      const a = await argvFor(bad === undefined ? {} : { fallbackModel: bad });
      assert.ok(!a.includes('--fallback-model'), JSON.stringify(bad) + ' must not produce the flag');
      assert.ok(!a.includes(''), JSON.stringify(bad) + ' must not leave an empty argv token behind');
    }
  });
  it('G3: the comma-separated list the CLI documents stays ONE token', async () => {
    // --help: „Accepts a comma-separated list to try each in order."
    const a = await argvFor({ fallbackModel: 'sonnet,haiku' });
    assert.equal(valOf(a, '--fallback-model'), 'sonnet,haiku');
    assert.equal(a.filter((x) => x === '--fallback-model').length, 1);
  });
  it('G3: a flag-shaped fallback model is refused instead of reaching argv', async () => {
    for (const bad of ['--dangerously-skip-permissions', '-x']) {
      assert.throws(() => startChat({ fallbackModel: bad }), (e) => e.statusCode === 400 && /invalid fallback model/.test(e.message), bad);
    }
  });
  // The CLI refuses this itself, at STARTUP („Fallback model cannot be the same as the main model.") —
  // so without this guard the tab just dies with that sentence in stderr and no hint where it came from.
  // This case used to assert a 400 out of startChat, on the stated grounds that „the CLI refuses it itself
  // at startup". That was wrong twice over. The sentence „Fallback model cannot be the same as the main
  // model" sits in ONE code position in the binary — the Agent SDK's own argv builder, i.e. a caller-side
  // pre-check — while the CLI's own consumer splits and trims `--fallback-model` and never compares it to
  // the model. And a throw here is not a 400 in a form: startChat is also the spawn path of every scheduled
  // run, so the „helpful" validation turned a harmless config into a nightly run that died unexplained.
  // What must hold now: the flag is DROPPED (it could not have done anything), the drop is RECORDED, and
  // the spawn survives. The 400 belongs to the routes, where somebody is looking at a form.
  it('G3: a fallback equal to the model is dropped and recorded — never thrown at', async () => {
    const argv = await argvFor({ model: 'sonnet', fallbackModel: ' sonnet ' });
    assert.equal(argv.includes('--fallback-model'), false, 'a flag that cannot do anything is not passed');
    const c = startChat({ model: 'sonnet', fallbackModel: 'sonnet' });
    assert.equal(c.meta.fallbackDropped, 'sonnet', 'a silent drop would be the same lie in the other direction');
    assert.equal(c.meta.fallbackModel, 'sonnet', 'what was asked for is kept — only the flag is withheld');
    killChat(c);
    // a DIFFERENT model is of course fine, and so is a fallback without a model of its own
    assert.equal(valOf(await argvFor({ model: 'opus', fallbackModel: 'sonnet' }), '--fallback-model'), 'sonnet');
    assert.equal(valOf(await argvFor({ fallbackModel: 'sonnet' }), '--fallback-model'), 'sonnet');
    const ok = startChat({ model: 'opus', fallbackModel: 'sonnet' });
    assert.equal(ok.meta.fallbackDropped, null, 'nothing was dropped, so nothing may claim it was');
    killChat(ok);
  });
  it('G3: it lands on chat.meta, so a run record can say which model may stand in', async () => {
    const c = startChat({ fallbackModel: ' sonnet ' });
    assert.equal(c.meta.fallbackModel, 'sonnet');
    killChat(c);
    const c2 = startChat({});
    assert.equal(c2.meta.fallbackModel, null);
    killChat(c2);
  });

  it('N1: suggestions are opt-in', async () => {
    assert.equal(valOf(await argvFor({ promptSuggestions: true }), '--prompt-suggestions'), 'true');
    assert.ok(!(await argvFor({ promptSuggestions: false })).includes('--prompt-suggestions'));
  });

  it('A6: PERM_MODES is the single list, and covers the three modes the panel gained', () => {
    ['default', 'plan', 'acceptEdits', 'bypassPermissions'].forEach((m) => assert.ok(PERM_MODES.includes(m), m + ' regressed out of the allowlist'));
    ['auto', 'manual', 'dontAsk'].forEach((m) => assert.ok(PERM_MODES.includes(m), m + ' missing'));
    assert.ok(!PERM_MODES.includes('yolo'), 'the allowlist must stay closed');
  });

  it('the permission mode is passed through verbatim', async () => {
    for (const m of PERM_MODES) {
      assert.equal(valOf(await argvFor({ permissionMode: m }), '--permission-mode'), m);
    }
  });

  // #17: argv is built from request/manifest values. A value can never split into extra arguments
  // (spawn, no shell) — but it must not be able to look like a flag either, because then the CLI's own
  // parser reads the token after it as something other than the value it was meant to be.
  it('a flag-shaped model / an unknown effort is refused instead of reaching argv', async () => {
    for (const bad of ['--dangerously-skip-permissions', '-x']) {
      assert.throws(() => startChat({ model: bad }), (e) => e.statusCode === 400 && /invalid model/.test(e.message), bad + ' must not reach argv');
    }
    for (const bad of ['bypassPermissions', '--verbose', 'ludicrous']) {
      assert.throws(() => startChat({ effort: bad }), (e) => e.statusCode === 400 && /invalid effort/.test(e.message), bad + ' is not an effort level');
    }
    // the real values still go through untouched — including the [1m] context ids
    for (const m of ['opus[1m]', 'sonnet', 'claude-fable-5-1[1m]', 'eu.anthropic.claude-opus-5']) {
      assert.equal(valOf(await argvFor({ model: m }), '--model'), m);
    }
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) {
      assert.equal(valOf(await argvFor({ effort: e }), '--effort'), e);
    }
  });

  // #20: the second enforcement point. The headless engine denies shell tools in its permission
  // responder AND here, so the responder is not the only thing between an unattended run and a shell.
  it('disallowedTools becomes ONE --disallowed-tools token, and only when asked for', async () => {
    const a = await argvFor({ disallowedTools: ['Bash', 'BashOutput', 'KillShell', 'KillBash'] });
    assert.equal(valOf(a, '--disallowed-tools'), 'Bash,BashOutput,KillShell,KillBash');
    // one token, so the variadic <tools...> cannot swallow the flag that follows it
    assert.ok(String(a[a.indexOf('--disallowed-tools') + 2]).startsWith('-'), 'the next argv element must still be a flag');
    assert.ok(!(await argvFor({})).includes('--disallowed-tools'), 'an interactive chat keeps every tool');
    assert.ok(!(await argvFor({ disallowedTools: [] })).includes('--disallowed-tools'));
  });

  // ---- S3: a path the panel cannot cheaply CHECK is passed through, never overruled ---------------
  // startChat used to ask `fs.existsSync` about its cwd. MEASURED 2026-10-03 (node v26.7.0) against a
  // fresh unrouted TEST-NET-1 host: that question cost 43 918 ms and held the EVENT LOOP for 43 919 ms
  // of it, i.e. one chat start froze the whole panel — and the answer it then acted on was `false`, so
  // the session was started in HOME. Silently somewhere other than where the user said. Both halves are
  // fixed by the same fork: a network/device path is handed on and whoever cannot reach it says so.
  //
  // These tests must never touch a network, so they use the OTHER spelling the shape test catches: the
  // Win32 extended form `\\?\C:\…`, which is UNC/device by shape and resolves locally. Measured on this
  // machine: existsSync on `\\?\<tmp>\nope` 0 ms and a spawn into it 3 ms, where the same questions
  // about `\\?\UNC\192.0.2.21\share` cost 36 163 ms and 7 418 ms. Same code path, no wait.
  const dev = (p) => '\\\\?\\' + p;

  // A spawn that FAILS emits 'error' and 'close' and never 'exit' (measured), so spawnFor() above —
  // which waits for 'exit' — would hang on a cwd the OS rejects. This one waits for whichever end came.
  function startAndSettle(opts) {
    return new Promise((resolve) => {
      const chat = startChat(opts);
      chat.proc.on('close', () => setTimeout(() => resolve(chat), 40));
    });
  }
  const framesOf = (chat) => chat.buffer.map((b) => JSON.parse(b.frame.slice(b.frame.indexOf('data: ') + 6)));

  it('S3: a UNC/device-shaped cwd is passed THROUGH — the panel does not substitute HOME for it', async () => {
    const shaped = dev(path.join(TMP, 'not-there'));
    const chat = await startAndSettle({ cwd: shaped });
    assert.equal(chat.meta.cwd, shaped, 'the receipt the UI shows must be the directory that was asked for');
    assert.notEqual(chat.meta.cwd, os.homedir(), 'the old behaviour — a silent fall-back to HOME — is the defect');
    try { killChat(chat); } catch { /* never started */ }
  });

  it('S3: and the OS\'s real refusal reaches the tab instead of a chat that quietly ran elsewhere', async () => {
    const chat = await startAndSettle({ cwd: dev(path.join(TMP, 'also-not-there')) });
    const frames = framesOf(chat);
    const err = frames.find((f) => f.type === '_error');
    assert.ok(err, 'the tab has to be told: ' + JSON.stringify(frames.map((f) => f.type)));
    assert.match(err.message, /ENOENT/, 'and told the actual reason, not a guess: ' + err.message);
    // A spawn failure produces no 'exit', so nothing else would ever end this chat: `alive` stayed true
    // for good, the claudeSessionId reservation was never released (resumeCollisions only looks at live
    // chats) and the reaper is told to leave a live chat alone.
    assert.equal(chat.alive, false, 'a chat whose process never started must not go on claiming to be alive');
    assert.ok(frames.some((f) => f.type === '_exit' && f.code === null), 'and every reader of `alive` has to be told too');
    try { killChat(chat); } catch { /* never started */ }
  });

  it('S3: a passed-through cwd is really USED, not just reported', async () => {
    // the same shape, this time over a directory that IS there — proof that the fork hands the spawn a
    // working directory rather than merely recording one
    const chat = await startAndSettle({ cwd: dev(TMP) });
    assert.equal(chat.meta.cwd, dev(TMP));
    assert.ok(!framesOf(chat).some((f) => f.type === '_error'), 'this one must start normally');
    try { killChat(chat); } catch { /* */ }
  });

  it('S3: a missing LOCAL cwd still falls back to HOME, exactly as before', async () => {
    const chat = await startAndSettle({ cwd: path.join(TMP, 'plain-local-miss') });
    assert.equal(chat.meta.cwd, os.homedir(), 'unchanged: a local path the panel CAN check cheaply is still checked');
    try { killChat(chat); } catch { /* */ }
  });

  it('S3: a UNC/device-shaped --add-dir is handed on, a missing LOCAL one is still dropped', async () => {
    const real = fs.mkdtempSync(path.join(TMP, 'root3-'));
    const shaped = dev(path.join(TMP, 'no-such-root'));
    const localGone = path.join(TMP, 'stale-root');
    const a = await argvFor({ cwd: TMP, addDirs: [real, localGone, shaped] });
    // order matters: it is the order the caller gave, so a reader can match argv against the tab's list
    assert.deepEqual(allOf(a, '--add-dir'), [real, shaped],
      'the stale LOCAL root is still dropped (A15, unchanged); the shaped one goes to the CLI, which can answer for it');
  });
});

// #34 — the subagent policy. lib/pure decides WHAT it is (tested in pure.test.js); this is the proof
// that it reaches the process, because an env var that is composed correctly and then dropped at spawn
// looks exactly like one that works — until a subagent quietly runs on the wrong model for an hour.
describe('#34 lib/chat — the subagent policy reaches the process', () => {
  const { subagentSpawnConfig } = require('../lib/pure');

  // G5's variable is always on (see the describe at the bottom of this file), so „nothing is set" is
  // stated as „nothing BUT that one" — spelled out rather than filtered away, because a policy variable
  // that leaked into a plain spawn would otherwise hide behind a filter.
  const PLAIN_ENV = { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' };

  it('a plain spawn sets none of the subagent variables', async () => {
    const { argv, env } = await spawnFor({});
    assert.deepEqual(env, PLAIN_ENV, 'nothing may be set when no policy was given');
    assert.ok(!argv.includes('--disallowedTools'));
  });

  it('model + ceilings arrive as environment variables', async () => {
    const { env } = await spawnFor({ subagents: subagentSpawnConfig({ model: 'sonnet', force: true, maxConcurrent: 3, maxPerSession: 12, maxDepth: 2 }, null) });
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'sonnet');
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, '1');
    assert.equal(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, '3');
    assert.equal(env.CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION, '12');
    assert.equal(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, '2');
  });

  it('"off" takes the tool away and sets nothing else', async () => {
    const { argv, env } = await spawnFor({ subagents: subagentSpawnConfig({ allow: false, model: 'opus' }, null) });
    assert.equal(valOf(argv, '--disallowed-tools'), 'Agent,Task', 'both spellings — the session calls it Task, older builds Agent');
    assert.deepEqual(env, PLAIN_ENV, 'a model for agents that cannot spawn would be a lie in the process env');
  });

  // THE case this whole shape exists for. The headless engine always denies the shell tools
  // (lib/engine.js HEADLESS_DENIED_TOOLS) — it is the only guard between an unattended run and a
  // shell. The subagent off-switch used to push its OWN `--disallowedTools Agent Task`, so this
  // combination emitted the flag twice; if the CLI lets the last occurrence win, the shell denial is
  // gone in exactly that run. One flag, both lists, or this test fails.
  it('a headless denial and "subagents off" share ONE flag — neither may drop the other', async () => {
    const { argv } = await spawnFor({
      disallowedTools: ['Bash', 'BashOutput', 'KillShell', 'KillBash'],
      subagents: subagentSpawnConfig({ allow: false }, null),
    });
    const occurrences = argv.filter((a) => a === '--disallowed-tools' || a === '--disallowedTools').length;
    assert.equal(occurrences, 1, 'two occurrences of a variadic flag is a coin toss the shell denial can lose');
    assert.equal(valOf(argv, '--disallowed-tools'), 'Bash,BashOutput,KillShell,KillBash,Agent,Task');
    assert.ok(String(argv[argv.indexOf('--disallowed-tools') + 2]).startsWith('-'), 'still one token, so nothing is swallowed');
  });

  it('a tool named twice is listed once', async () => {
    const { argv } = await spawnFor({ disallowedTools: ['Agent'], subagents: subagentSpawnConfig({ allow: false }, null) });
    assert.equal(valOf(argv, '--disallowed-tools'), 'Agent,Task');
  });

  it('the panel policy beats the same variable inherited from the server environment', async () => {
    const prev = process.env.CLAUDE_CODE_SUBAGENT_MODEL;
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'haiku';   // e.g. exported in the shell that started the panel
    try {
      const { env } = await spawnFor({ subagents: subagentSpawnConfig({ model: 'opus' }, null) });
      assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'opus', 'the UI would otherwise claim a model the CLI ignores');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_SUBAGENT_MODEL; else process.env.CLAUDE_CODE_SUBAGENT_MODEL = prev;
    }
  });

  it('the MCP startup ceiling reaches the process as an env var, and only when set', async () => {
    const { env } = await spawnFor({ mcpStartupWaitMs: 15000 });
    assert.equal(env.CLAUDE_CODE_MCP_STARTUP_WAIT_MS, '15000');
    for (const bad of [0, -5, 'abc', null, undefined, NaN]) {
      const r = await spawnFor({ mcpStartupWaitMs: bad });
      assert.equal(r.env.CLAUDE_CODE_MCP_STARTUP_WAIT_MS, undefined, String(bad) + ' must not become a ceiling');
    }
  });

  // G5 — the one env field the whole session-state feature hangs on. MEASURED 2026-10-02 against 2.1.286
  // (docs/messung-2026-10-02.md): the binary has exactly ONE emission site for `session_state_changed`
  // and it is gated on this variable; the SDK's alternative (`CLAUDE_CODE_SDK_READS_SESSION_STATE`) only
  // yields a `sdk_host_only` variant the panel must not rely on, and none of the ten measured frames
  // carried it. So the frames arrive BECAUSE of this line — there is no second source and no fallback
  // path that could produce one, which makes the var exactly as invisible as a mistyped flag and exactly
  // as fatal: without it every branch in public/js/session-state.js is dead code that never runs.
  it('G5: the session-state emitter is asked for on EVERY spawn', async () => {
    const { env } = await spawnFor({});
    assert.equal(env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1', 'no variable → no frame → G5 is dead code');
    // …including the headless/schedule path, which spawns through this same startChat. It deliberately
    // does NOT change where an unattended run decides it is finished (`result`, see lib/chat.js) — the
    // frames are simply there, and that decision is documented at the line that sets the variable.
    const head = await spawnFor({ permissionMode: 'plan', disallowedTools: ['Bash'] });
    assert.equal(head.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1');
  });
  it('G5: a value inherited from the panel server\'s own shell cannot turn it off', async () => {
    const prev = process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS;
    process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '0'; // the CLI reads this truthily → '0' would EMIT
    try {
      const { env } = await spawnFor({});
      assert.equal(env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1', 'the panel\'s own env must win, like every other value here');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS; else process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = prev;
    }
  });

  // C2/C3 — the two launch flags, verified against CLI 2.1.280's own --help:
  //   --agent <agent>        „Agent for the current session. Overrides the 'agent' setting."
  //   -w, --worktree [name]  „Create a new git worktree for this session (optionally specify a name)"
  // The worktree name is OPTIONAL, which is why this needs tests: `true` must produce the BARE flag
  // (the CLI names the tree), a string must produce flag + name, and neither may leak a stray "true"
  // onto the command line — where it would become the name of the worktree.
  it('C2: --agent carries the name, and stays absent without one', async () => {
    assert.equal(valOf(await argvFor({ agent: 'reviewer' }), '--agent'), 'reviewer');
    for (const bad of ['', '   ', null, undefined]) {
      assert.ok(!(await argvFor({ agent: bad })).includes('--agent'), JSON.stringify(bad) + ' must not set --agent');
    }
  });
  it('C2: an agent name that could pass for a flag is refused', () => {
    assert.throws(() => { const c = startChat({ agent: '--dangerously-skip-permissions' }); killChat(c); });
  });
  it('C3: worktree true is the BARE flag — no name invented for the CLI', async () => {
    const a = await argvFor({ worktree: true });
    const i = a.indexOf('--worktree');
    assert.ok(i >= 0, '--worktree missing');
    assert.ok(a[i + 1] === undefined || a[i + 1].startsWith('-'), 'a name was invented: ' + a[i + 1]);
    assert.ok(!a.includes('true'), '"true" must never reach the command line');
  });
  it('C3: a worktree name becomes --worktree <name>, and nothing sets it by accident', async () => {
    assert.equal(valOf(await argvFor({ worktree: 'feature-x' }), '--worktree'), 'feature-x');
    for (const bad of [false, null, undefined, '', 0]) {
      assert.ok(!(await argvFor({ worktree: bad })).includes('--worktree'), JSON.stringify(bad) + ' must not set --worktree');
    }
  });
  it('C2/C3: both land on chat.meta, so the UI can report what was launched', () => {
    const c = startChat({ agent: 'reviewer', worktree: 'feature-x' });
    assert.equal(c.meta.agent, 'reviewer');
    assert.equal(c.meta.worktree, 'feature-x');
    killChat(c);
    const c2 = startChat({});
    assert.equal(c2.meta.agent, null);
    assert.equal(c2.meta.worktree, null);
    killChat(c2);
  });

  it('the applied policy is on chat.meta, so the UI can report it', () => {
    const chat = startChat({ subagents: subagentSpawnConfig({ model: 'sonnet' }, null) });
    assert.deepEqual(chat.meta.subagents, { model: 'sonnet' });
    killChat(chat);
    const c2 = startChat({});
    assert.deepEqual(c2.meta.subagents, {});
    killChat(c2);
  });
});

// Ultracode reaches the process as an extra `--settings` LAYER, not as a flag of its own — there is no
// `--ultracode`, and `--effort ultracode` is not documented either (--help lists only low…max). What is
// documented (and measured): the session-scoped `ultracode` settings key, via --settings or
// apply_flag_settings.
describe('lib/chat — ultracode reaches the process', () => {
  it('on → exactly one --settings with the session-scoped key', async () => {
    const a = await argvFor({ ultracode: true });
    const i = a.indexOf('--settings');
    assert.ok(i >= 0, '--settings missing');
    assert.equal(a[i + 1], '{"ultracode":true}');
    assert.equal(a.filter((x) => x === '--settings').length, 1, 'a second layer would be a coin toss');
    // the value can never be read as a flag (it starts with `{`), which is why two tokens are fine here
    assert.ok(!a[i + 1].startsWith('-'));
  });
  it('off / unset → no --settings at all (an ordinary chat\'s argv is unchanged)', async () => {
    for (const v of [false, undefined, null, 0, 'true']) {
      const a = await argvFor(v === undefined ? {} : { ultracode: v });
      assert.ok(!a.includes('--settings'), JSON.stringify(v) + ' must not add a settings layer');
    }
  });
  it('and it lands on chat.meta, so the UI can report what was launched', () => {
    const c = startChat({ ultracode: true });
    assert.equal(c.meta.ultracode, true);
    // …and as the WISH as well, which is a different fact: `meta.ultracode` is overwritten with the APPLIED
    // value by the live switches, so without a second field the launch wish is lost the first time a model
    // cannot honour it — and the next effort change would then re-assert `false`.
    assert.equal(c.meta.ultracodeWish, true);
    killChat(c);
    const c2 = startChat({});
    assert.equal(c2.meta.ultracode, false);
    assert.equal(c2.meta.ultracodeWish, false);
    killChat(c2);
  });
});

// PR-S — `--system-prompt-snapshot off`. Measured 2026-10-03 against 2.1.288: without it, a changed
// --append-system-prompt does not reach a RESUMED session (the CLI replays the prompt it recorded at the
// first request until the next compaction — lib/pure.js top note). Two things matter at the argv level:
// the flag is there exactly when the policy says 'off', and EVERY OTHER launch is byte-identical to what it
// was before this setting existed — an older CLI rejects the unknown option and the chat would not start.
// A fixed session id, because the argv of two fresh spawns differs in --session-id otherwise.
const { buildSpawnPolicy } = require('../lib/pure');
const SID = '0b5e9a1e-7c3d-4f2a-9b8c-1d2e3f4a5b6c';
const without = (argv, flag) => { const i = argv.indexOf(flag); return i < 0 ? argv : argv.slice(0, i).concat(argv.slice(i + 2)); };
// argv AND the receipt from ONE awaited spawn (spawnFor) — and each spawn reads its own per-pid file, so
// an un-awaited fake of an earlier test cannot overwrite the argv an exact comparison below reads.
describe('lib/chat — the prompt snapshot (PR-S)', () => {
  it("'off' → exactly one `--system-prompt-snapshot off`, as two tokens, and the receipt says so", async () => {
    const { argv: a, meta } = await spawnFor({ sessionId: SID, appendSystem: 'Leitplanke', systemPromptSnapshot: 'off' });
    assert.equal(a.filter((x) => x === '--system-prompt-snapshot').length, 1);
    assert.equal(valOf(a, '--system-prompt-snapshot'), 'off');
    assert.ok(!a.some((x) => x.startsWith('--system-prompt-snapshot=')), 'two tokens — the value is generated, never free text');
    assert.equal(meta.promptSnapshot, 'off');
  });

  it('anything but the literal \'off\' passes NO flag — and the argv is otherwise byte-identical', async () => {
    const base = { sessionId: SID, appendSystem: 'Leitplanke', model: 'sonnet', effort: 'high' };
    const { argv: plain, meta } = await spawnFor(base);
    assert.ok(!plain.includes('--system-prompt-snapshot'));
    assert.equal(meta.promptSnapshot, null, 'no flag = no claim about what this CLI does by itself');
    // 'on' is the CLI default and travels as NO flag; the rest is garbage that must not invent a value
    for (const v of ['on', 'OFF', 'aus', true, false, 1, '', null]) {
      const a = await argvFor(Object.assign({}, base, { systemPromptSnapshot: v }));
      assert.deepEqual(a, plain, JSON.stringify(v) + ' must leave the argv exactly as it was');
    }
    const off = await argvFor(Object.assign({}, base, { systemPromptSnapshot: 'off' }));
    assert.deepEqual(without(off, '--system-prompt-snapshot'), plain, 'the flag is the ONLY difference');
  });

  it('not tied to the appended prompt: the record covers the whole system prompt', async () => {
    assert.equal(valOf(await argvFor({ systemPromptSnapshot: 'off' }), '--system-prompt-snapshot'), 'off');
  });

  // The chain the start route and lib/engine run: setting + proof that this CLI lists the flag → argv.
  it('through buildSpawnPolicy: default + supported CLI sets it; \'on\' or an unproven CLI does not', async () => {
    const launch = async (prefs, snapshotFlag) => argvFor(Object.assign(
      buildSpawnPolicy(prefs, [], { mode: 'chat', body: { guardrails: 'nur lesen' }, snapshotFlag }), { sessionId: SID }));
    const plain = await launch({}, false);
    assert.ok(!plain.includes('--system-prompt-snapshot'), 'no --help proof → no flag, even at the default');
    const def = await launch({}, true);
    assert.equal(valOf(def, '--system-prompt-snapshot'), 'off', 'the default is OFF (Julian, 2026-10-03)');
    assert.deepEqual(without(def, '--system-prompt-snapshot'), plain);
    assert.deepEqual(await launch({ promptSnapshot: 'on' }, true), plain, "'on' = the CLI default = no flag");
    assert.deepEqual(await launch({ promptSnapshot: 'off' }, 'yes'), plain, 'only a literal true counts as proof');
  });
});

// ---- the two LIVE flag-settings switches ------------------------------------------------------------
// A stub chat rather than a spawn: setChatEffort/setChatUltracode only touch chat.proc.stdin,
// chat.pendingControls and chat.meta, and what has to be asserted here is the exact PAYLOAD that goes down
// the pipe — which a real process would only let us observe indirectly, and would answer whenever it felt
// like it. `applied` is what this stub's get_settings reports back.
const { setChatEffort, setChatUltracode } = require('../lib/chat');

function stubChat(applied, meta) {
  const sent = [];
  const chat = {
    meta: Object.assign({ effort: null, model: 'sonnet-5', ultracode: false, ultracodeWish: false }, meta || {}),
    pendingControls: new Map(),
    proc: { stdin: { writable: true, write(line) {
      const obj = JSON.parse(line);
      sent.push(obj);
      const waiter = chat.pendingControls.get(obj.request_id);
      if (!waiter) return true;
      // Answer the way the CLI does: apply_flag_settings is ALWAYS success (that is the whole problem),
      // get_settings carries the `applied` block. Async, so the promise in controlRequest really is awaited.
      setImmediate(() => waiter(obj.request.subtype === 'get_settings'
        ? { subtype: 'success', request_id: obj.request_id, response: { effective: {}, sources: {}, applied: (typeof applied === 'function' ? applied() : applied) } }
        : { subtype: 'success', request_id: obj.request_id }));
      return true;
    } } },
  };
  const applies = () => sent.filter((o) => o.request.subtype === 'apply_flag_settings');
  return { chat, sent, applies };
}
const APPLIED_ON = { model: 'sonnet-5', effort: 'high', advisor: null, ultracode: true, ultracodeRequested: true, ultracodeAvailable: true };

describe('lib/chat — a live effort change may not switch Ultracode off (A0)', () => {
  it('sends ONE apply_flag_settings carrying BOTH effortLevel and ultracode', async () => {
    // THE invariant, pinned at the sink. claude.exe 2.1.286's stdio handler clears ultracode for an
    // effort-only request whose level differs, so an effort change that sends `{effortLevel}` alone turns
    // Ultracode off every time — silently, because the control response is success either way.
    const { chat, sent, applies } = stubChat(APPLIED_ON, { ultracodeWish: true });
    const r = await setChatEffort(chat, 'high');
    assert.equal(r.ok, true);
    assert.equal(applies().length, 1, 'two requests would be two chances to trip the coupling');
    assert.deepEqual(applies()[0].request.settings, { effortLevel: 'high', ultracode: true });
    // …and the verdict is a READ-BACK, not the request's own answer (which cannot fail)
    assert.ok(sent.some((o) => o.request.subtype === 'get_settings'), 'nothing is confirmed without get_settings');
    assert.equal(chat.meta.effort, 'high');
    assert.equal(chat.meta.ultracode, true);
  });

  it("auto travels as effortLevel: null — never as '', which is a silent no-op", async () => {
    // `fH('')` returns undefined, so the CLI skips the whole state update while still answering success.
    // An '' on the wire is therefore indistinguishable from a working switch, from the response alone.
    for (const level of ['', null, undefined]) {
      const { chat, applies } = stubChat({ model: 'sonnet-5', effort: null, ultracode: false, ultracodeRequested: false, ultracodeAvailable: true });
      await setChatEffort(chat, level);
      const s = applies()[0].request.settings;
      assert.ok('effortLevel' in s, JSON.stringify(level) + ': the key must be present');
      assert.equal(s.effortLevel, null, JSON.stringify(level) + ' must travel as null');
      assert.equal(chat.meta.effort, null, 'and auto reads back as null — the CLI\'s own encoding of „no explicit level"');
    }
  });

  it('the wish comes from chat.meta.ultracodeWish when the caller sends none', async () => {
    // A browser tab loaded before this fix sends no `ultracode` field at all. If the server then sent
    // none either, the bug would be right back — so the session's own recorded wish is the default.
    const a = stubChat(APPLIED_ON, { ultracodeWish: true, ultracode: false });
    await setChatEffort(a.chat, 'low');
    assert.equal(a.applies()[0].request.settings.ultracode, true, 'a stale tab must not be able to drop the wish');
    // …and an explicit wish wins, so turning it off still works through the same request
    const b = stubChat({ model: 'sonnet-5', effort: 'low', ultracode: false, ultracodeRequested: false, ultracodeAvailable: true }, { ultracodeWish: true });
    await setChatEffort(b.chat, 'low', false);
    assert.equal(b.applies()[0].request.settings.ultracode, false);
    assert.equal(b.chat.meta.ultracodeWish, false, 'an explicit wish is also the new standing wish');
  });

  it('setChatUltracode keeps the WISH and the APPLIED value apart', async () => {
    // the Haiku case: accepted, not in effect. `meta.ultracode` has to follow the read-out (that is what
    // the chip reports), and the wish has to survive it (that is what the next effort change re-asserts).
    const { chat } = stubChat({ model: 'claude-haiku-4-5', effort: null, ultracode: false, ultracodeRequested: true, ultracodeAvailable: false });
    const r = await setChatUltracode(chat, true);
    assert.equal(r.ok, true);
    assert.equal(chat.meta.ultracode, false, 'applied follows the read-back');
    assert.equal(chat.meta.ultracodeWish, true, '…and the wish survives it');
    // a following effort change re-asserts exactly that wish, on a model that cannot honour it
    const before = chat.pendingControls.size;
    await setChatEffort(chat, 'max');
    assert.equal(before, 0);
    assert.equal(chat.meta.ultracodeWish, true);
  });

  it('a read-back with nothing in it is reported as unconfirmed, not as done', async () => {
    // Two ways to end up here and they must look the same to the caller: the session answered without an
    // `applied` block (below), or it did not answer at all — controlRequest then resolves
    // `{ok:true, unconfirmed:true}` on its 5 s timeout, so `.ok` alone can mean „we never heard back".
    // Reporting either as success is the bug PR #44 fixed for set_model.
    const { chat } = stubChat(null);                    // get_settings answers success with applied: null
    const r = await setChatEffort(chat, 'high', false);
    assert.equal(r.ok, true);
    assert.equal(r.unconfirmed, true, 'the caller has to be able to tell „applied" from „nobody said no"');
    assert.equal(r.applied, null);
    assert.equal(chat.meta.effort, 'high', 'the optimistic value stands — it is just not presented as fact');
    assert.equal(chat.meta.ultracode, false);
  });
});
