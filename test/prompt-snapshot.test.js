'use strict';
// PR-S — `--system-prompt-snapshot off`, end to end.
//
// The finding (measured 2026-10-03 against CLI 2.1.288, lib/pure.js top note): with the CLI's prompt
// snapshot on — its default — a resumed session sends the system prompt it recorded at its first request,
// byte for byte, until the next compaction. An edited guardrail, a new correction, a changed style and
// „Leitplanken jetzt anwenden" therefore never reached a CONTINUED session. The panel now passes the flag,
// as a setting whose default is „off" — but only for a CLI that is PROVEN to know it: an older one answers
// the unknown option with an error, and the chat would not start at all.
//
// So four things are tested here, without a model and without the real binary:
//   1. lib/cli reads the proof from the binary's own --help — parsed by option LINE, cached per binary
//      (path + size + mtime), shared by concurrent callers, a failure not mistaken for an answer;
//   2. the prefs route stores the setting through an allow-list (400 for anything else), default absent;
//   3. a chat started through the real start route carries the flag in its argv exactly when setting AND
//      proof say so — via fake-claude's FAKE_CLAUDE_ARGV_OUT, i.e. what the process actually received —
//      a new session, a RESUME and a fork alike, and a start that lands before the boot probe answered;
//   4. the browser half: which sentence a guardrail edit gets (public/js/chat.js) and what the Settings
//      card says (public/js/views.js), lifted out of the source and run against stand-ins.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { makeSandbox } = require('./sandbox');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(ROOT, 'fake-claude.js').replace(/\\/g, '/');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-snapshot-'));
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });
const freshCli = () => { delete require.cache[require.resolve('../lib/cli')]; return require('../lib/cli'); };

// ---- 1. the proof: the binary's own --help ---------------------------------------------------------
// An excerpt shaped like the real 2.1.288 output, including the three traps: an alias line, a flag that
// is only MENTIONED deep inside another option's description, and a description line that starts at
// column 6 instead of 40 (commander does that after a long signature).
const HELP_EXCERPT = [
  'Usage: claude [options] [command] [prompt]', '', 'Options:',
  '  --add-dir <directories...>            Additional directories to allow tool',
  '  --allowedTools, --allowed-tools <tools...>',
  '      Comma or space-separated list of tool names to allow (e.g. "Bash(git *)',
  '  -p, --print                           Print response and exit',
  '                                        --only-mentioned-here, --another-mention',
  '  --system-prompt <prompt>              System prompt to use for the session',
  '  --system-prompt-snapshot <on|off>     Record the system prompt once per',
  '                                        conversation — a --system-prompt or',
  '                                        --append-system-prompt included — sent,',
  '', 'Commands:', '  agents [options]                      Manage agents',
].join('\n');

describe('lib/cli parseHelpFlags (pure)', () => {
  const { parseHelpFlags } = require('../lib/cli');
  it('takes the long names of OPTION lines, aliases included', () => {
    const f = parseHelpFlags(HELP_EXCERPT);
    for (const x of ['--add-dir', '--allowedTools', '--allowed-tools', '--print', '--system-prompt', '--system-prompt-snapshot']) assert.ok(f.has(x), x);
  });
  it('a flag that is only mentioned in a description is not one the CLI accepts', () => {
    const f = parseHelpFlags(HELP_EXCERPT);
    for (const x of ['--only-mentioned-here', '--another-mention', '--append-system-prompt']) assert.ok(!f.has(x), x);
    assert.ok(!f.has('agents'), 'subcommands are not flags');
  });
  it('the real distinction: --system-prompt is not --system-prompt-snapshot', () => {
    const f = parseHelpFlags('  --system-prompt <prompt>   System prompt\n');
    assert.ok(f.has('--system-prompt'));
    assert.ok(!f.has('--system-prompt-snapshot'), 'a prefix match would claim support for an older CLI');
  });
  it('an error line, an empty or a missing answer prove nothing', () => {
    for (const t of ["error: unknown option '--help'", '', null, undefined, 'Usage: claude']) assert.equal(parseHelpFlags(t).size, 0, String(t));
  });
});

describe('lib/cli cliFlagSupported — against fake-claude', () => {
  const keep = { bin: process.env.CLAUDE_UI_FAKE_BIN, help: process.env.FAKE_CLAUDE_HELP };
  after(() => {
    for (const [k, v] of [['CLAUDE_UI_FAKE_BIN', keep.bin], ['FAKE_CLAUDE_HELP', keep.help]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  before(() => { process.env.CLAUDE_UI_FAKE_BIN = FAKE; });
  const ask = async (mode) => {
    if (mode) process.env.FAKE_CLAUDE_HELP = mode; else delete process.env.FAKE_CLAUDE_HELP;
    const cli = freshCli();
    return { supported: await cli.cliFlagSupported(cli.PROMPT_SNAPSHOT_FLAG), known: await cli.cliFlagKnown(cli.PROMPT_SNAPSHOT_FLAG) };
  };
  it('a CLI that lists the flag → supported, and the display read agrees', async () => {
    assert.deepEqual(await ask(''), { supported: true, known: true });
  });
  it('a CLI that predates it (FAKE_CLAUDE_HELP=old) → not supported — a FACT, not „unknown"', async () => {
    assert.deepEqual(await ask('old'), { supported: false, known: false });
  });
  it('a probe that proves nothing (FAKE_CLAUDE_HELP=fail) → not supported, and the display says UNKNOWN', async () => {
    assert.deepEqual(await ask('fail'), { supported: false, known: null });
  });
  it('before anything was asked, the display read spawns nothing and claims nothing', async () => {
    const cli = freshCli();
    assert.equal(await cli.cliFlagKnown(cli.PROMPT_SNAPSHOT_FLAG), null);
  });
});

// A counting stand-in, so the cache can be asserted in spawns rather than in timings.
describe('lib/cli cliHelpFlags — one spawn per binary', () => {
  const counter = path.join(dir, 'help-calls.txt');
  const bin = path.join(dir, 'counting-claude.js');
  const writeBin = (mode, pad) => fs.writeFileSync(bin, [
    'require("fs").appendFileSync(' + JSON.stringify(counter) + ', "x\\n");',
    mode === 'fail' ? 'process.exit(1);'
      : 'setTimeout(() => { process.stdout.write("Options:\\n  --system-prompt-snapshot <on|off>     Record\\n"); }, 150);',
    '// ' + (pad || ''),
  ].join('\n'));
  const calls = () => { try { return fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
  const keep = process.env.CLAUDE_UI_FAKE_BIN;
  before(() => { process.env.CLAUDE_UI_FAKE_BIN = bin.replace(/\\/g, '/'); });
  after(() => { if (keep === undefined) delete process.env.CLAUDE_UI_FAKE_BIN; else process.env.CLAUDE_UI_FAKE_BIN = keep; });

  it('a burst shares ONE --help process, and a repeat is served from the cache', async () => {
    fs.rmSync(counter, { force: true }); writeBin('ok');
    const cli = freshCli();
    const burst = await Promise.all([1, 2, 3].map(() => cli.cliFlagSupported(cli.PROMPT_SNAPSHOT_FLAG)));
    assert.deepEqual(burst, [true, true, true]);
    assert.equal(calls(), 1, 'three parallel chat starts, one probe');
    assert.equal(await cli.cliFlagSupported(cli.PROMPT_SNAPSHOT_FLAG), true);
    assert.equal(calls(), 1, 'cached per binary');
  });
  it('a CHANGED binary (size/mtime — an update from a terminal) is asked again', async () => {
    fs.rmSync(counter, { force: true }); writeBin('ok');
    const cli = freshCli();
    await cli.cliFlagSupported(cli.PROMPT_SNAPSHOT_FLAG);
    writeBin('ok', 'a different build, a different size');
    assert.equal(await cli.cliFlagKnown(cli.PROMPT_SNAPSHOT_FLAG), null, 'the old answer belongs to the old file');
    await cli.cliFlagSupported(cli.PROMPT_SNAPSHOT_FLAG);
    assert.equal(calls(), 2);
  });
  it('a failed probe is remembered briefly (no timeout on every start) — and invalidate() asks again', async () => {
    fs.rmSync(counter, { force: true }); writeBin('fail');
    const cli = freshCli();
    assert.equal(await cli.cliFlagSupported(cli.PROMPT_SNAPSHOT_FLAG), false);
    assert.equal(await cli.cliFlagSupported(cli.PROMPT_SNAPSHOT_FLAG), false);
    assert.equal(calls(), 1, 'the failure is held for HELP_FAIL_TTL_MS, not re-spawned per start');
    writeBin('ok'); cli.invalidate();
    assert.equal(await cli.cliFlagSupported(cli.PROMPT_SNAPSHOT_FLAG), true, 'and it recovers');
    assert.equal(calls(), 2);
  });
  it('nothing is spawned while `claude update` replaces the binary (B1/FLOW-6)', async () => {
    fs.rmSync(counter, { force: true }); writeBin('ok');
    const cli = freshCli();
    await cli.withCliUpdate(async () => {
      assert.equal(await cli.cliHelpFlags(), null);
      assert.equal(await cli.cliFlagSupported(cli.PROMPT_SNAPSHOT_FLAG), false);
    });
    assert.equal(calls(), 0);
  });
});

// ---- 2 + 3. the setting and the argv, through a real server ------------------------------------------
function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* */ } resolve({ status: res.statusCode, body: d, json }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// `opts.noWait`: return as soon as the server answers, WITHOUT waiting for the boot pre-warm — the
// cold-start window below is only reachable that way (the default waits until /api/state has an answer).
async function bootServer(label, extraEnv, opts) {
  const sbx = makeSandbox(label, { fakeCli: true });
  const argvOut = path.join(sbx.root, 'argv.jsonl');
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...sbx.env, CLAUDE_UI_PORT: String(port), CLAUDE_UI_FAKE_BIN: FAKE, FAKE_CLAUDE_ARGV_OUT: argvOut, ...(extraEnv || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  const t0 = Date.now();
  let flag = null;
  for (;;) {
    try { const st = await req(port, 'GET', '/api/state'); if (st.status === 200) { flag = st.json.promptSnapshotFlag; break; } } catch { /* not up yet */ }
    if (Date.now() - t0 > 10000) throw new Error('server did not come up: ' + log);
    await sleep(150);
  }
  // the boot pre-warm answers within a moment; /api/state only ever PEEKS at it
  if (!(opts && opts.noWait)) {
    while (Date.now() - t0 < 15000) { flag = (await req(port, 'GET', '/api/state')).json.promptSnapshotFlag; if (flag !== null) break; await sleep(150); }
  }
  // fake-claude writes one line per CHAT process and one `["--help"]` per probe into the same file
  const lines = () => { try { return fs.readFileSync(argvOut, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const argvLines = () => lines().filter((a) => a[0] !== '--help');
  const helpProbes = () => lines().filter((a) => a[0] === '--help').length;
  // start one chat, wait for its process to have written its argv, stop it again
  const startChat = async (body) => {
    const before = argvLines().length;
    const r = await req(port, 'POST', '/api/chat/start', Object.assign({ cwd: ROOT, permissionMode: 'plan' }, body || {}));
    assert.equal(r.status, 200, r.body);
    const t1 = Date.now();
    while (argvLines().length === before && Date.now() - t1 < 10000) await sleep(50);
    await req(port, 'POST', '/api/chat/' + r.json.chatId + '/stop');
    return { meta: r.json.meta, argv: argvLines()[before] || [] };
  };
  return {
    port, flag, sbx, startChat, helpProbes,
    prefsOnDisk: () => { try { return JSON.parse(fs.readFileSync(path.join(sbx.dataDir, 'ui-prefs.json'), 'utf8')); } catch { return {}; } },
    stop: async () => { await new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }); sbx.cleanup(); },
  };
}
const valOf = (argv, flag) => { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1]; };

describe('server — a CLI that lists the flag', () => {
  let S;
  before(async () => { S = await bootServer('snap-ok'); });
  after(async () => { if (S) await S.stop(); });

  it('the boot pre-warm proved the flag, and the setting reads „off" without anything stored', async () => {
    assert.equal(S.flag, true, '/api/state.promptSnapshotFlag');
    const st = (await req(S.port, 'GET', '/api/state')).json;
    assert.equal(st.prefs.promptSnapshot, 'off');
    assert.ok(!('promptSnapshot' in S.prefsOnDisk()), 'the default is absent from the file');
  });

  it('a chat started through the route carries `--system-prompt-snapshot off` — in the process argv', async () => {
    const { meta, argv } = await S.startChat();
    assert.equal(valOf(argv, '--system-prompt-snapshot'), 'off', JSON.stringify(argv));
    assert.equal(meta.promptSnapshot, 'off', 'and the receipt the browser gets says the same');
  });

  // The case the whole PR is about: a RESUME. Every other start here is a new session, whose first request
  // renders the prompt anyway — the flag only matters on a continued one, and on a fork of one.
  it('a RESUME through the route carries the flag next to --resume — and so does a fork', async () => {
    const id = crypto.randomUUID();
    const r = await S.startChat({ resume: id });
    assert.equal(valOf(r.argv, '--resume'), id, JSON.stringify(r.argv));
    assert.equal(valOf(r.argv, '--system-prompt-snapshot'), 'off', JSON.stringify(r.argv));
    assert.equal(r.meta.promptSnapshot, 'off');
    const f = await S.startChat({ resume: crypto.randomUUID(), fork: true });
    assert.ok(f.argv.includes('--fork-session'), JSON.stringify(f.argv));
    assert.equal(valOf(f.argv, '--system-prompt-snapshot'), 'off', JSON.stringify(f.argv));
  });

  it('the boot pre-warm was ONE --help probe, and no chat start added another', () => {
    assert.equal(S.helpProbes(), 1);
  });

  it("'on' round-trips, is stored as 'on', and the next chat gets NO flag", async () => {
    const r = await req(S.port, 'POST', '/api/prefs', { promptSnapshot: 'on' });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.promptSnapshot, 'on');
    assert.equal(S.prefsOnDisk().promptSnapshot, 'on');
    assert.equal((await req(S.port, 'GET', '/api/state')).json.prefs.promptSnapshot, 'on');
    const { meta, argv } = await S.startChat();
    assert.ok(!argv.includes('--system-prompt-snapshot'), JSON.stringify(argv));
    assert.equal(meta.promptSnapshot, null);
  });

  it("'off' removes the key again instead of storing the default", async () => {
    const r = await req(S.port, 'POST', '/api/prefs', { promptSnapshot: 'off' });
    assert.equal(r.json.promptSnapshot, 'off');
    assert.ok(!('promptSnapshot' in S.prefsOnDisk()));
  });

  it('anything outside the allow-list is a 400 that changes nothing — and other prefs survive', async () => {
    await req(S.port, 'POST', '/api/prefs', { guardrails: 'nichts ohne Freigabe', promptSnapshot: 'on' });
    for (const bad of ['maybe', 'ON', true, 1, '', null]) {
      const r = await req(S.port, 'POST', '/api/prefs', { promptSnapshot: bad, guardrails: 'überschrieben?' });
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.match(r.json.error, /promptSnapshot/);
    }
    const disk = S.prefsOnDisk();
    assert.equal(disk.promptSnapshot, 'on', 'a refused value does not touch the stored one');
    assert.equal(disk.guardrails, 'nichts ohne Freigabe', 'nor anything else in the same request');
    await req(S.port, 'POST', '/api/prefs', { promptSnapshot: 'off' });
  });
});

describe('server — a CLI that does NOT list the flag (older build)', () => {
  let S;
  before(async () => { S = await bootServer('snap-old', { FAKE_CLAUDE_HELP: 'old' }); });
  after(async () => { if (S) await S.stop(); });

  it('the state says so, and the default „off" does not put an unknown option on its command line', async () => {
    assert.equal(S.flag, false, 'a fact about this CLI, shown as such in Settings');
    const { meta, argv } = await S.startChat();
    assert.ok(argv.length > 0, 'the chat did start');
    assert.ok(!argv.includes('--system-prompt-snapshot'), 'no proof, no flag: ' + JSON.stringify(argv));
    assert.equal(meta.promptSnapshot, null);
  });
});

// The window the boot pre-warm cannot close: a reload right after a server restart sends its start before
// the --help probe has answered. The route must WAIT for that probe — neither start without the flag nor
// spawn a second probe next to it (lib/cli shares the pending one). FAKE_CLAUDE_HELP_MS holds the answer
// long enough that the first /api/state is guaranteed to land inside the window.
describe('server — a chat start while the boot probe is still running', () => {
  let S;
  before(async () => { S = await bootServer('snap-cold', { FAKE_CLAUDE_HELP_MS: '3000' }, { noWait: true }); });
  after(async () => { if (S) await S.stop(); });

  it('the start waits for the probe and carries the flag — and shares ONE --help process with the pre-warm', async () => {
    assert.equal(S.flag, null, 'the first /api/state answered inside the window — otherwise this proves nothing');
    const { meta, argv } = await S.startChat();
    assert.equal(valOf(argv, '--system-prompt-snapshot'), 'off', JSON.stringify(argv));
    assert.equal(meta.promptSnapshot, 'off');
    assert.equal(S.helpProbes(), 1, 'pre-warm and chat start, one probe');
    assert.equal((await req(S.port, 'GET', '/api/state')).json.promptSnapshotFlag, true, 'and the display read now has the answer');
  });
});

// ---- 4. the browser half ---------------------------------------------------------------------------
// The decisions about WHICH SENTENCE a user gets live in two browser functions with no module of their
// own, and that is where the first round of this PR was wrong while every test above was green: a dormant
// tab and a declined relaunch said „gilt ab dem Start" without proof, „an" claimed a replay for sessions
// that never recorded one. Lifted by name and run against stand-ins — the seam of test/mcp-live.test.js
// and test/ultracode-honesty.test.js. `tt`/`t` return the KEY, so an assertion names the string without
// pinning its wording.
const CHAT_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat.js'), 'utf8');
const VIEWS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views.js'), 'utf8');
function liftFn(src, name, rel) {
  const one = new RegExp('^(?:async )?function ' + name + '\\(.*\\}[ \\t]*$', 'm');
  const multi = new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm');
  const m = one.exec(src) || multi.exec(src);
  assert.ok(m, name + '() not found in ' + rel + ' — renamed or reindented? Then these tests prove nothing.');
  return m[0];
}
function lift(src, rel, names, env) {
  const keys = Object.keys(env);
  return new Function(...keys, names.map((n) => liftFn(src, n, rel)).join('\n') + '\nreturn { ' + names.join(', ') + ' };')(...keys.map((k) => env[k]));
}
const TABS = { never: {}, dormant: { sessionId: 's-1' }, running: { id: 'c-1', sessionId: 's-1' } };
// One guardrail edit. `pref`/`flag`: what STATE says; `recheck`: what a second /api/state answers;
// `confirm`: the user's answer to a relaunch question. → every dialog/toast in order, and the requests made.
async function editGuardrails({ pref, flag, recheck, tab, confirm }) {
  const seen = [], calls = [];
  const STATE = { prefs: { promptSnapshot: pref }, promptSnapshotFlag: flag };
  const { editTabGuardrails } = lift(CHAT_SRC, 'public/js/chat.js', ['promptSnapshotFresh', 'editTabGuardrails'], {
    STATE, ACTIVE: null, tt: (k) => k,
    api: async (url) => { calls.push(url); return { promptSnapshotFlag: recheck === undefined ? flag : recheck }; },
    uiPrompt: async () => 'nichts pushen ohne OK',
    persistTabs: () => {}, renderStatusBar: () => {},
    toast: (msg) => { seen.push(['toast', msg]); },
    uiAlert: async (msg) => { seen.push(['alert', msg]); },
    uiConfirm: async (msg, o) => { seen.push(['confirm', msg, o && o.okLabel]); return !!confirm; },
    restartWhenIdle: async (t, why, done) => { seen.push(['restart', done]); },
  });
  await editTabGuardrails(Object.assign({ guardrails: '' }, TABS[tab]));
  return { seen, calls, STATE };
}

describe('public/js/chat.js — „Leitplanken jetzt anwenden" says only what is proven', () => {
  it('a tab that never ran: the plain toast, and the server is not even asked', async () => {
    const r = await editGuardrails({ pref: 'off', flag: null, tab: 'never' });
    assert.deepEqual(r.seen, [['toast', 'chat.leitplankenGesetzt']]);
    assert.deepEqual(r.calls, []);
  });

  it('proven fresh („aus" + the CLI lists the flag): the relaunch as before', async () => {
    const yes = await editGuardrails({ pref: 'off', flag: true, tab: 'running', confirm: true });
    assert.deepEqual(yes.seen, [['confirm', 'chat.leitplankenNeustartFrage', 'chat.leitplankenJetztAnwenden'], ['restart', 'chat.leitplankenAngewendet']]);
    const no = await editGuardrails({ pref: 'off', flag: true, tab: 'running', confirm: false });
    assert.deepEqual(no.seen[1], ['toast', 'chat.leitplankenAbNeustart']);
    const dormant = await editGuardrails({ pref: 'off', flag: true, tab: 'dormant' });
    assert.deepEqual(dormant.seen, [['toast', 'chat.leitplankenGesetzt']]);
    assert.deepEqual(yes.calls, [], 'a known answer is not asked again');
  });

  it('not proven: the relaunch with the caveat, and EVERY sentence after it keeps the caveat', async () => {
    for (const flag of [null, false]) {
      const yes = await editGuardrails({ pref: 'off', flag, tab: 'running', confirm: true });
      assert.deepEqual(yes.seen, [['confirm', 'chat.leitplankenNeustartUnbelegt', 'chat.leitplankenJetztAnwenden'], ['restart', 'chat.leitplankenNeugestartUnbelegt']], 'flag ' + flag);
      const no = await editGuardrails({ pref: 'off', flag, tab: 'running', confirm: false });
      assert.deepEqual(no.seen[1], ['toast', 'chat.leitplankenAbNeustartUnbelegt'], 'declined, flag ' + flag);
      const dormant = await editGuardrails({ pref: 'off', flag, tab: 'dormant' });
      assert.deepEqual(dormant.seen, [['toast', 'chat.leitplankenAbNeustartUnbelegt']], 'dormant tab, flag ' + flag);
      // null = no answer yet → asked once more; false = a fact about this CLI → not asked again
      assert.deepEqual(yes.calls, flag === null ? ['/api/state'] : [], 'flag ' + flag);
    }
  });

  it('a boot-time null that the re-ask turns into a proven yes behaves as proven — and is kept', async () => {
    const r = await editGuardrails({ pref: 'off', flag: null, recheck: true, tab: 'running', confirm: true });
    assert.deepEqual(r.seen[0], ['confirm', 'chat.leitplankenNeustartFrage', 'chat.leitplankenJetztAnwenden']);
    assert.equal(r.STATE.promptSnapshotFlag, true);
  });

  it('snapshot „an": the relaunch is still OFFERED (a session without a record may take it), with both cases spelled out', async () => {
    const yes = await editGuardrails({ pref: 'on', flag: true, tab: 'running', confirm: true });
    assert.deepEqual(yes.seen, [['confirm', 'chat.leitplankenNeustartSnapshotAn', 'chat.leitplankenTrotzdemNeustarten'], ['restart', 'chat.leitplankenNeugestartUnbelegt']]);
    const no = await editGuardrails({ pref: 'on', flag: true, tab: 'running', confirm: false });
    assert.deepEqual(no.seen[1], ['toast', 'chat.leitplankenAbNeustartUnbelegt']);
    const dormant = await editGuardrails({ pref: 'on', flag: true, tab: 'dormant' });
    assert.deepEqual(dormant.seen, [['alert', 'chat.leitplankenSnapshotAn']]);
    assert.deepEqual(yes.calls, [], '„an" needs no answer from the CLI');
  });

  it('the invariant across every combination: „gesetzt", „angewendet", „wirkt beim nächsten Start" only when proven', async () => {
    const PLAIN = ['chat.leitplankenGesetzt', 'chat.leitplankenEntfernt', 'chat.leitplankenAngewendet', 'chat.leitplankenAbNeustart'];
    for (const pref of ['off', 'on']) for (const flag of [true, false, null]) for (const tab of ['dormant', 'running']) for (const confirm of [true, false]) {
      const r = await editGuardrails({ pref, flag, tab, confirm });
      const proven = pref === 'off' && flag === true;
      const plain = r.seen.filter((s) => PLAIN.includes(s[1]));
      assert.equal(plain.length > 0, proven, JSON.stringify({ pref, flag, tab, confirm, seen: r.seen }));
    }
  });
});

describe('public/js/views.js — the Settings card says what the setting does on THIS machine', () => {
  const paint = (pref, flag) => {
    const sel = { value: '' }, note = { textContent: '' };
    const { paintPromptSnapshot } = lift(VIEWS_SRC, 'public/js/views.js', ['paintPromptSnapshot'], {
      STATE: { prefs: { promptSnapshot: pref }, promptSnapshotFlag: flag }, t: (k) => k,
      $: (q) => ({ '#qsPromptSnapshot': sel, '#snapNote': note })[q] || null,
    });
    paintPromptSnapshot();
    return { value: sel.value, note: note.textContent };
  };
  it('„an" → the softened effect line, whatever the CLI says', () => {
    for (const flag of [true, false, null]) assert.deepEqual(paint('on', flag), { value: 'on', note: 'views.promptSnapshotAnWirkung' });
  });
  it('„aus" → three different sentences for listed · not listed · not proven', () => {
    assert.deepEqual(paint('off', true), { value: 'off', note: '✓ views.promptSnapshotFlagOk' });
    assert.deepEqual(paint('off', false), { value: 'off', note: '⚠ views.promptSnapshotFlagFehlt' });
    assert.deepEqual(paint('off', null), { value: 'off', note: 'views.promptSnapshotFlagUngeprueft' });
  });
  it('anything that is not literally „on" shows the default', () => {
    for (const pref of [undefined, 'ON', 'an', true]) assert.equal(paint(pref, true).value, 'off', String(pref));
  });
});
