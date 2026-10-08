'use strict';
// B2/FLOW-1 + B1/FLOW-6 + FLOW-2, in-process against fake-claude (sandbox env, no server, no model):
//   • ONE termination path (terminateChat): EOF first and a clean exit when the process takes it, a tree
//     kill after the grace when it does not — the WHOLE tree, a detached grandchild included —,
//     immediate tree kill on resume; idempotent;
//   • a resume waits until the old writer of that transcript is GONE (#1/#17): found in the map AND
//     after a graceful stop already took it out (the client's stop → start {resume}), whose grace the
//     resume cuts short; nothing to wait for = no wait;
//   • removeChat / terminateChat on a STALE handle never deletes whatever lives under that id now —
//     a resume keeps the NEW chat;
//   • while `claude update` runs: startChat refuses (503 'cli-updating'), the scheduler tick defers
//     (schedules file untouched), and a scheduled run that raced the flag is put back to due as
//     'deferred' — its last real status and lastRun survive; so is a run the TICK stamped just before
//     the flag went up (#3);
//   • shutdown's abortHeadlessRuns ends in-flight headless runs as 'aborted' (history + schedule
//     lastStatus written) and nothing new starts afterwards. Runs LAST: that switch is one-way.
// verify: serial — asserts on kill-grace TIMING, must not compete for CPU. It boots no server, so
// verify.js cannot recognise it from its spawns; this directive is the signal (see verify.js).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { makeSandbox } = require('./sandbox');

const sb = makeSandbox('term', { fakeCli: true });
Object.assign(process.env, sb.env); // BEFORE the requires: lib/paths reads the seams at load time
// a minimal UI skill the engine can run headless
fs.mkdirSync(path.join(sb.claudeDir, 'commands'), { recursive: true });
fs.writeFileSync(path.join(sb.claudeDir, 'commands', 'hold.md'), '---\ndescription: test skill\n---\nhold\n\n```ui-skill\n{"title":"Hold","inputs":[]}\n```\n');
const SCHED_FILE = path.join(sb.dataDir, 'ui-skill-schedules.json');
const RUNS_FILE = path.join(sb.dataDir, 'ui-skill-runs.json');

const { startChat, chats, terminateChat, removeChat, endResumeCollisions } = require('../lib/chat');
const cli = require('../lib/cli');
const engine = require('../lib/engine');
const { withFileLock, killTree, KILL_TREE_WAIT_MS } = require('../lib/core');

const WIN = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); } return !!fn(); }
const running = (p) => p.exitCode === null && p.signalCode === null;
const exited = (p) => new Promise((r) => { if (!running(p)) return r(); p.once('exit', () => r()); });
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const strays = [];
const strayPids = new Set(); // processes that are not our children (detached grandchildren)
after(async () => {
  await Promise.allSettled([...chats.values()].map((c) => terminateChat(c, { resume: true })));
  for (const p of strays) { try { p.kill(); } catch { /* */ } }
  for (const pid of strayPids) { if (alive(pid)) { try { process.kill(pid); } catch { /* */ } } }
  await sleep(300);
  sb.cleanup();
});

// Stands in for a CLI stuck on an MCP server: stdin closed, still alive — only a kill ends it
// (fake-claude exits on EOF, so it cannot prove one). `script` replaces the idle body.
function eofIgnoring(script) {
  const proc = spawn(process.execPath, ['-e', script || 'process.stdin.on("end",()=>{}); process.stdin.resume(); setInterval(()=>{},1000)'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  strays.push(proc);
  return proc;
}
// …registered the way startChat registers a chat of session S (claudeSessionId = the launch id)
function standInChat(S) {
  const proc = eofIgnoring();
  const chat = { id: 'manual-' + crypto.randomUUID(), proc, clients: new Set(), claudeSessionId: S, sessionId: null, alive: true };
  proc.on('exit', () => { chat.alive = false; });
  chats.set(chat.id, chat);
  return chat;
}
// what a resume may wait at most: killTree's wait bound + TERMINATE_EXIT_WAIT_MS + slack. Taken from
// lib/core, not restated: the old literal 5000 here was a second copy of a cap that turned out to be wrong.
const RESUME_WAIT_BOUND_MS = KILL_TREE_WAIT_MS + 1000 + 3000;

describe('terminateChat: one way to end a chat (B2/FLOW-1)', () => {
  it('EOF first: a process that exits on EOF exits cleanly (exit 0, no kill)', async () => {
    const c = startChat({});
    assert.equal(chats.get(c.id), c);
    const t = terminateChat(c);
    assert.equal(chats.has(c.id), false, 'the map entry goes immediately');
    assert.equal(terminateChat(c), t, 'idempotent: a second call joins the first');
    await t;
    assert.equal(running(c.proc), false);
    assert.equal(c.proc.exitCode, 0, 'it took the EOF — not killed');
  });

  it('a process that ignores EOF is tree-killed after the grace', async () => {
    const proc = eofIgnoring();
    const fake = { id: 'manual-' + crypto.randomUUID(), proc, clients: new Set() };
    const t0 = Date.now();
    await terminateChat(fake, { graceMs: 300 });
    await exited(proc);
    assert.ok(Date.now() - t0 >= 300, 'waited for the grace first');
    assert.notEqual(proc.exitCode, 0, 'ended by the kill, not on its own');
  });

  it('the kill takes the whole TREE: a detached grandchild goes too (#19)', { skip: !WIN && 'Windows-only (taskkill /T)' }, async () => {
    // The grandchild stands in for an MCP server the CLI started. DETACHED on purpose: libuv ties a
    // non-detached child to its parent through a kill-on-close job, so that one would die with the
    // parent even under a plain proc.kill() and prove nothing. Detached, only the parent link is
    // left — which is exactly what taskkill /T walks while the parent is still alive.
    const pidFile = path.join(sb.root, 'grandchild-' + crypto.randomUUID() + '.pid');
    const proc = eofIgnoring(`
      const g = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000); setTimeout(()=>process.exit(0),60000)'], { detached: true, stdio: 'ignore', windowsHide: true });
      require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); g.unref();
      process.stdin.on('end', () => {}); process.stdin.resume(); setInterval(() => {}, 1000);`);
    assert.ok(await waitFor(() => { try { return fs.readFileSync(pidFile, 'utf8').length > 0; } catch { return false; } }, 10000), 'grandchild started');
    const gpid = Number(fs.readFileSync(pidFile, 'utf8'));
    strayPids.add(gpid);
    assert.ok(alive(gpid), 'the grandchild runs');
    await terminateChat({ id: 'manual-' + crypto.randomUUID(), proc, clients: new Set() }, { graceMs: 300 });
    await exited(proc);
    // taskkill takes the grandchild BEFORE the parent (measured: idle 3–56 ms earlier, loaded up to 6 s), so it
    // is normally gone already; the wait is killTree's own bound, not a guess at how loaded the machine is
    // (the old 3 s was red under load). A parent-only kill leaves it alive for its full 60 s either way.
    assert.equal(await waitFor(() => !alive(gpid), KILL_TREE_WAIT_MS), true, 'the detached grandchild is gone too — a parent-only kill leaves it running');
    strayPids.delete(gpid);
  });

  it('a SLOW taskkill is waited for only up to the bound — and never cut short: the tree still goes (#19)', { skip: !WIN && 'Windows-only (taskkill /T)' }, async () => {
    // The production failure, without needing a loaded machine: under load taskkill /T ran up to 16.5 s,
    // the old 5 s execFile timeout KILLED taskkill mid-walk, and the fallback child.kill() ended the parent
    // only — which makes the tree unreachable (taskkill /T walks from a live parent). Measured: cut short
    // in 2 of 10 runs under a foreign load, the grandchild orphaned in 2 of 20 under an in-process one
    // (numbers in lib/core killTree). Here the caller's bound is 1 ms, so it is guaranteed to expire
    // before taskkill answers (that takes ~3 s here even idle): the promise must settle at once, and the
    // whole tree must still die, because taskkill keeps working.
    const pidFile = path.join(sb.root, 'grandchild-' + crypto.randomUUID() + '.pid');
    const proc = eofIgnoring(`
      const g = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000); setTimeout(()=>process.exit(0),60000)'], { detached: true, stdio: 'ignore', windowsHide: true });
      require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); g.unref();
      process.stdin.on('end', () => {}); process.stdin.resume(); setInterval(() => {}, 1000);`);
    assert.ok(await waitFor(() => { try { return fs.readFileSync(pidFile, 'utf8').length > 0; } catch { return false; } }, 10000), 'grandchild started');
    const gpid = Number(fs.readFileSync(pidFile, 'utf8'));
    strayPids.add(gpid);
    await killTree(proc, { waitMs: 1 });
    assert.equal(running(proc), true, 'premise: the caller stopped waiting before taskkill had answered');
    assert.equal(await waitFor(() => !running(proc) && !alive(gpid), KILL_TREE_WAIT_MS), true,
      'the parent AND the detached grandchild end anyway — taskkill was not killed, and the parent was not killed alone');
    strayPids.delete(gpid);
  });

  it('a server that EXITS while taskkill is still walking does not take taskkill with it', { skip: !WIN && 'Windows-only (taskkill /T)' }, async () => {
    // libuv puts every NON-detached child into a kill-on-close job: when the panel exits (shutdown,
    // restart) such a taskkill dies with it, mid-walk. The helper is that server in miniature: it starts a
    // tree, asks killTree to end it, stops waiting at once (waitMs 1) and exits. The tree's root is
    // detached from the helper, so the helper's own job cannot end it — only taskkill can.
    const tag = crypto.randomUUID();
    const out = path.join(sb.root, 'exit-mid-walk-' + tag + '.json');
    const gFile = path.join(sb.root, 'exit-mid-walk-' + tag + '.gpid');
    const rootScript = `
      const g = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000); setTimeout(()=>process.exit(0),60000)'], { detached: true, stdio: 'ignore', windowsHide: true });
      require('fs').writeFileSync(${JSON.stringify(gFile)}, String(g.pid)); g.unref();
      setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000);`;
    const helper = path.join(sb.root, 'exit-mid-walk-' + tag + '.js');
    fs.writeFileSync(helper, `
      const cp = require('child_process'), fs = require('fs');
      const { killTree } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'core'))});
      const root = cp.spawn(process.execPath, ['-e', ${JSON.stringify(rootScript)}], { detached: true, stdio: 'ignore', windowsHide: true });
      const iv = setInterval(() => {
        let g = ''; try { g = fs.readFileSync(${JSON.stringify(gFile)}, 'utf8'); } catch { return; }
        if (!g) return;
        clearInterval(iv);
        fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ root: root.pid, g: Number(g) }));
        killTree(root, { waitMs: 1 }).then(() => process.exit(0));
      }, 50);`);
    const h = spawn(process.execPath, [helper], { stdio: 'ignore', windowsHide: true });
    await exited(h);
    const ids = readJson(out);
    assert.ok(ids && ids.root && ids.g, 'the helper started its tree and asked for the kill');
    strayPids.add(ids.root); strayPids.add(ids.g);
    assert.equal(alive(ids.root), true, 'premise: the helper was gone before taskkill had ended the tree');
    assert.equal(await waitFor(() => !alive(ids.root) && !alive(ids.g), KILL_TREE_WAIT_MS), true,
      'root and grandchild end anyway — the detached taskkill outlived the server that started it');
    strayPids.delete(ids.root); strayPids.delete(ids.g);
  });

  it('resume while the old process is still in the map: it is GONE before the new one spawns (#1/#17)', async () => {
    const S = crypto.randomUUID();
    const old = standInChat(S);
    assert.equal(endResumeCollisions(crypto.randomUUID()), null, 'no collision → nothing to await, the start stays synchronous');
    const t0 = Date.now();
    const gone = endResumeCollisions(S); // what the start route awaits before startChat({ resume })
    assert.ok(gone, 'the live process of S was found');
    await Promise.race([gone, sleep(RESUME_WAIT_BOUND_MS)]);
    const took = Date.now() - t0;
    assert.equal(running(old.proc), false, 'dead when the new process would spawn (' + took + ' ms)');
    assert.equal(alive(old.proc.pid), false);
    assert.ok(took < RESUME_WAIT_BOUND_MS, 'bounded by the tree kill (' + took + ' ms)');
    assert.equal(endResumeCollisions(S), null, 'nothing of S left');
    const b = startChat({ resume: S });
    assert.equal(chats.get(b.id), b);
    await terminateChat(b);
  });

  it('stop (graceful, not awaited) → resume: the resume cuts the grace short and waits for the end (#1/#17)', async () => {
    const S = crypto.randomUUID();
    const old = standInChat(S);
    // the stop route. A long grace, so "joined the graceful end instead of escalating it" cannot pass
    // by luck — it would wait the whole 30 s
    const graceful = terminateChat(old, { graceMs: 30000 });
    assert.equal(chats.has(old.id), false, 'out of the map already — a scan of `chats` alone finds nothing');
    const t0 = Date.now();
    const gone = endResumeCollisions(S);
    assert.ok(gone, 'still found while it is being ended');
    await Promise.race([gone, sleep(RESUME_WAIT_BOUND_MS)]);
    const took = Date.now() - t0;
    assert.equal(running(old.proc), false, 'dead when the new process would spawn (' + took + ' ms)');
    assert.equal(alive(old.proc.pid), false);
    assert.ok(took < RESUME_WAIT_BOUND_MS, 'escalated to the tree kill, not left to its 30 s grace (' + took + ' ms)');
    await graceful; // the stop's own promise is the same termination — it settled with it
    const b = startChat({ resume: S });
    assert.equal(chats.get(b.id), b);
    await terminateChat(b);
  });

  it('a FORK of a live session leaves the source process alone', async () => {
    // `--fork-session` writes its OWN transcript, so it is in contention with nothing: the guard must
    // skip it. Otherwise "Duplizieren (Fork)" ends the process of the tab it forked from (forkTab opens
    // the fork in a NEW tab and keeps that one), and the start waits out a taskkill for nothing.
    const S = crypto.randomUUID();
    const src = standInChat(S);
    const f = startChat({ resume: S, fork: true });
    assert.equal(src.terminating, undefined, 'no termination was started for the source');
    assert.equal(chats.get(src.id), src, 'the source is still registered');
    assert.equal(running(src.proc), true, 'and still running');
    assert.equal(f.claudeSessionId, null, 'a fork reserves no id — its own arrives with the first frame');
    await terminateChat(f);
    await terminateChat(src, { resume: true });
  });

  it('resume: the old process is killed at once and the NEW chat stays in the map', async () => {
    const S = crypto.randomUUID();
    const a = startChat({ sessionId: S });
    const b = startChat({ resume: S });
    assert.equal(chats.has(a.id), false, 'the old process left the map');
    assert.equal(chats.get(b.id), b, 'the new one is registered');
    await exited(a.proc);
    await sleep(100); // let a's exit handler (broadcast _exit) run
    assert.equal(chats.get(b.id), b, "the old chat's exit did not take the new chat with it");
    // a stale handle carrying b's id (late finish(), a reaper snapshot) must not remove b either
    const stale = { id: b.id, clients: new Set(), proc: a.proc };
    removeChat(stale);
    await terminateChat(stale);
    assert.equal(chats.get(b.id), b, 'removeChat/terminateChat on a stale handle left the live chat alone');
    await terminateChat(b);
  });
});

// CHAT-FLOW-4 — the server decides who owns a session. A fake SSE response stands in for the browser: it
// records what was written and whether the stream was ended, exactly the two things a browser can observe.
// `_everAttached` is set by hand only where the test is about a stream that HAS been attached (server.js sets
// it at clients.add — test/integration.test.js drives that through the real route).
function fakeClient() {
  const c = { frames: [], ended: false, endedAfter: -1 };
  c.res = { write: (s) => { c.frames.push(String(s)); return true; }, end: () => { c.ended = true; c.endedAfter = c.frames.length; } };
  return c;
}
function attach(chat, client) { chat.clients.add(client.res); chat._everAttached = true; }

describe('session ownership (CHAT-FLOW-4)', () => {
  const lib = require('../lib/chat');

  it('a session with an attached stream is refused: 409 session-open-elsewhere, the process and its stream live on', async () => {
    const S = crypto.randomUUID();
    const c = startChat({ resume: S });
    const cl = fakeClient(); attach(c, cl);
    await assert.rejects(lib.refuseIfOpenElsewhere(S), (e) => e.statusCode === 409 && e.code === 'session-open-elsewhere'
      && e.extra && e.extra.busy === false && e.extra.starting === false);
    assert.equal(running(c.proc), true, 'the owner was killed');
    assert.equal(cl.ended, false, 'its stream was ended');
    assert.deepEqual(lib.sessionHold(S), { open: true, busy: false, starting: false });
    // the loop's check THROWS, in the same tick — a promise here would reopen the gap before the kill
    assert.throws(() => lib.refuseIfHeld(S), (e) => e.statusCode === 409 && e.code === 'session-open-elsewhere');
    c.clients.clear();
    await terminateChat(c, { resume: true });
  });

  it('a reload: the old stream detaches within the settle window → the resume may go ahead', async () => {
    const S = crypto.randomUUID();
    const c = startChat({ resume: S });
    const cl = fakeClient(); attach(c, cl);
    // the browser that reloads closes its stream a moment AFTER its new page already asked to resume
    setTimeout(() => c.clients.delete(cl.res), 50);
    await lib.refuseIfOpenElsewhere(S); // must not throw
    assert.equal(lib.sessionHold(S).open, false);
    await terminateChat(c, { resume: true });
  });

  it('the takeover tells the attached browser BEFORE its stream ends, and the process is gone', async () => {
    const S = crypto.randomUUID();
    const c = startChat({ resume: S });
    const cl = fakeClient(); attach(c, cl);
    await Promise.race([endResumeCollisions(S), sleep(RESUME_WAIT_BOUND_MS)]);
    assert.equal(running(c.proc), false, 'the old process still runs');
    const at = cl.frames.findIndex((f) => /"type":"_superseded"/.test(f));
    assert.ok(at >= 0, 'no _superseded frame reached the browser: ' + JSON.stringify(cl.frames));
    assert.ok(cl.ended && at < cl.endedAfter, 'the frame came after the stream had ended');
  });

  it('claim window: a fresh process nobody attached to yet holds its session; once a stream attached and left, it does not', async () => {
    const S = crypto.randomUUID();
    const c = startChat({ resume: S });
    await assert.rejects(lib.refuseIfOpenElsewhere(S), (e) => e.code === 'session-open-elsewhere' && e.extra.starting === true);
    // past the window → an unattached orphan is fair game again (the reload whose page never re-attached)
    c.createdAt -= lib.CLAIM_MS + 1;
    await lib.refuseIfOpenElsewhere(S);
    c.createdAt += lib.CLAIM_MS + 1;
    // …and a stream that attached once and is gone: no claim either, however young the process
    const cl = fakeClient(); attach(c, cl); c.clients.delete(cl.res);
    await lib.refuseIfOpenElsewhere(S);
    await terminateChat(c, { resume: true });
  });

  it('a process that is already being ended owns nothing — the tab\'s own stop → resume right after a start is not refused', async () => {
    const S = crypto.randomUUID();
    const c = startChat({ resume: S }); // young, never attached: inside its claim window
    const graceful = terminateChat(c, { graceMs: 30000 }); // the stop route, not awaited
    await lib.refuseIfOpenElsewhere(S); // must not throw: what is being ended is nobody's any more
    await Promise.race([endResumeCollisions(S), sleep(RESUME_WAIT_BOUND_MS)]);
    await graceful;
  });

  it('busy = a message went in and no `result` came back yet', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'silent'; // the fake never answers → the turn stays open
    try {
      const S = crypto.randomUUID();
      const c = startChat({ resume: S });
      const cl = fakeClient(); attach(c, cl);
      assert.equal(lib.sessionHold(S).busy, false);
      lib.sendToChat(c, 'arbeite');
      assert.equal(lib.sessionHold(S).busy, true, 'a sent message did not open the turn');
      c.clients.clear();
      await terminateChat(c, { resume: true });
    } finally { delete process.env.FAKE_CLAUDE_SCENARIO; }
  });

  it('busy follows the frames: `result` closes the turn, and a turn the CLI starts BY ITSELF (after a background agent) opens it again', async () => {
    // bgagent: a first `result` while the agent still works, then — with no message sent — the main thread
    // answers again ('7 Dateien.') and a second `result` follows. Sampled from onEvent, which broadcast() calls
    // after the line handler has updated the state, so each sample is the verdict AT that frame.
    process.env.FAKE_CLAUDE_SCENARIO = 'bgagent';
    const S = crypto.randomUUID();
    let c;
    try {
      c = startChat({ resume: S, cwd: sb.root });
      const cl = fakeClient(); attach(c, cl);
      const seen = [];
      c.onEvent = (ev) => { if (ev.type === 'assistant' || ev.type === 'result') seen.push(ev.type + ':' + lib.sessionHold(S).busy); };
      lib.sendToChat(c, 'starte einen Hintergrund-Agenten');
      assert.ok(await waitFor(() => seen.filter((x) => x.startsWith('result')).length >= 2, 10000), 'bgagent did not finish: ' + seen.join(' '));
      assert.deepEqual(seen, ['assistant:true', 'assistant:true', 'result:false', 'assistant:true', 'result:false'],
        'busy did not follow the turns — a takeover warning would be wrong exactly when the CLI works on its own');
    } finally {
      delete process.env.FAKE_CLAUDE_SCENARIO;
      if (c) { c.clients.clear(); await terminateChat(c, { resume: true }); }
      fs.rmSync(path.join(require('os').tmpdir(), 'claude', 'fake-' + path.basename(sb.root), S), { recursive: true, force: true });
    }
  });
});

describe('while `claude update` runs (B1/FLOW-6)', () => {
  it('startChat refuses with 503 cli-updating; the tick defers; a raced run comes back as due', async () => {
    const now = Date.now();
    const due = { id: 'sc-due', name: 'no-such-skill', enabled: true, timing: { type: 'interval', minutes: 60 }, nextRun: now - 1000, lastRun: 0 };
    const raced = { id: 'sc-raced', name: 'hold', enabled: true, timing: { type: 'interval', minutes: 60 }, nextRun: now + 3600000, lastRun: now, lastStatus: 'done' };
    fs.writeFileSync(SCHED_FILE, JSON.stringify([due, raced]));
    const before = fs.readFileSync(SCHED_FILE, 'utf8');

    // the race: the run passes runScheduled's flag check (synchronous part), THEN the update starts —
    // startChat is the gate that catches it. _prevLastRun is what the tick hands over when it stamps.
    const racedRun = engine.runScheduled(Object.assign({}, raced, { _prevLastRun: 123 }));
    let release; const gate = new Promise((r) => (release = r));
    const upd = cli.withCliUpdate(() => gate);
    try {
      assert.throws(() => startChat({}), (e) => e.code === 'cli-updating' && e.statusCode === 503 && typeof e.hint === 'string');
      await racedRun;
      const afterRace = readJson(SCHED_FILE).find((x) => x.id === 'sc-raced');
      assert.ok(afterRace.nextRun <= Date.now(), 'put back to due for the first tick after the update');
      assert.equal(afterRace.lastRun, 123, 'the stamp of a run that never ran is taken back');
      assert.equal(afterRace.lastStatus, 'done', 'no error recorded for a deferred run');

      const snap = fs.readFileSync(SCHED_FILE, 'utf8');
      await engine.scheduleTick();
      assert.equal(fs.readFileSync(SCHED_FILE, 'utf8'), snap, 'the tick touched nothing while updating');
      assert.equal(await engine.runScheduled(due), null, 'the manual path refuses too');
      assert.notEqual(snap, before);
    } finally { release(); await upd; }

    // after the update the tick picks the due schedule up (stamps it; the skill does not exist, so
    // nothing spawns) — proof the deferral above was the update and not a broken tick
    fs.writeFileSync(SCHED_FILE, JSON.stringify([due]));
    await engine.scheduleTick();
    const picked = readJson(SCHED_FILE)[0];
    assert.ok(picked.lastRun > 0, 'stamped once the update was over');
    assert.ok(picked.nextRun > Date.now(), 'and rescheduled');
  });

  it('the update starts while the TICK reads the file: its stamp is taken back, the schedule is due again (#3)', async () => {
    const now = Date.now();
    fs.writeFileSync(SCHED_FILE, JSON.stringify([{ id: 'sc-tick', name: 'no-such-skill', enabled: true, timing: { type: 'interval', minutes: 60 }, nextRun: now - 1000, lastRun: 4242, lastStatus: 'done' }]));
    // The window: the tick's re-check under the lock has passed and it reads the schedules — the update
    // starts right there. Hooked into that read instead of slept into it, so the interleaving is fixed.
    // A missing put-back fails loudly: the skill does not exist, so the stamp (lastRun = now, nextRun an
    // hour ahead) would simply stay.
    const fsp = require('fs/promises');
    const realRead = fsp.readFile;
    let release; const gate = new Promise((r) => (release = r));
    let upd = null;
    fsp.readFile = function (f, ...rest) {
      if (!upd && String(f) === SCHED_FILE) upd = cli.withCliUpdate(() => gate);
      return realRead.call(this, f, ...rest);
    };
    try {
      await engine.scheduleTick();
      assert.ok(upd && cli.isCliUpdating(), 'premise: the update began inside the tick, after its re-check');
      await withFileLock(SCHED_FILE, () => {}); // the put-back queued on the same lock behind the tick
      const s = readJson(SCHED_FILE)[0];
      assert.equal(s.lastRun, 4242, 'the stamp of a run that never ran is taken back');
      assert.ok(s.nextRun <= Date.now(), 'due again for the first tick after the update — not an interval later');
      assert.equal(s.lastStatus, 'done', 'no status recorded for it');
    } finally { fsp.readFile = realRead; release(); if (upd) await upd; }
  });
});

describe('abortHeadlessRuns: shutdown ends headless runs as aborted (FLOW-2) — runs last', () => {
  it('in-flight scheduled run → aborted in history + schedule; nothing new starts afterwards', async () => {
    const sc = { id: 'sc-abort', name: 'hold', enabled: true, timing: { type: 'interval', minutes: 60 }, nextRun: Date.now() + 3600000, lastStatus: 'done' };
    fs.writeFileSync(SCHED_FILE, JSON.stringify([sc]));
    fs.rmSync(RUNS_FILE, { force: true });
    process.env.FAKE_CLAUDE_SCENARIO = 'silent'; // the fake never answers → the run stays in flight
    try {
      const p = engine.runScheduled(sc);
      assert.ok(await waitFor(() => [...chats.values()].some((c) => c.onEvent && c.alive), 10000), 'headless chat spawned');
      const headless = [...chats.values()].find((c) => c.onEvent);
      await engine.abortHeadlessRuns();
      await p;
      const runs = readJson(RUNS_FILE) || [];
      assert.equal(runs.length, 1);
      assert.equal(runs[0].status, 'aborted', 'history says aborted, not a forever-running record');
      assert.equal(runs[0].scheduleId, 'sc-abort');
      assert.equal(readJson(SCHED_FILE)[0].lastStatus, 'aborted');
      assert.equal(chats.has(headless.id), false);
      await exited(headless.proc);

      // one-way: a run that reaches the spawn after the sweep is recorded as aborted, never started
      const n = chats.size;
      const skill = { name: 'hold', manifest: { title: 'Hold', inputs: [] } };
      const late = await engine.runUiSkillHeadless(skill, {}, {});
      assert.equal(late.status, 'aborted');
      assert.equal(chats.size, n, 'no process was spawned');
    } finally { delete process.env.FAKE_CLAUDE_SCENARIO; }
  });
});
