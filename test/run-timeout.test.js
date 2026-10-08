'use strict';
// B2/FLOW-1: lib/core run() must END on timeout — not merely signal the process it spawned. The old
// execFile `timeout` only TerminateProcess'd that one process: with shell:true (npm) or a launcher
// (claude.exe, uvx, npx) the real worker is a GRANDCHILD that survives, keeps the stdout/stderr pipes
// open, and execFile's callback (which waits for 'close') never fires — the route awaiting run() hung.
// Contracts:
//   • a cmd.exe → node chain is killed AS A TREE (both pids gone) and run() resolves with err.killed;
//   • when the tree kill cannot reach the pipe holder (its parent already exited, so it is no longer in
//     the tree), run() still resolves — RUN_KILL_GRACE_MS (3 s) after the kill, with err.killed.
// Windows-only: the hang and the taskkill /T fix are both Windows behaviour (POSIX keeps child.kill()).
// verify: serial — asserts on process-tree kill TIMING, must not compete for CPU. It boots no server,
// so verify.js cannot recognise it from its spawns; this directive is the signal (see verify.js).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, KILL_TREE_WAIT_MS, RUN_KILL_GRACE_MS } = require('../lib/core');

const WIN = process.platform === 'win32';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-runto-'));
// pids to kill in after(), whatever an assertion did. A pid leaves the set once it is confirmed gone:
// Windows reuses pids quickly, and a blind kill in after() could hit an unrelated process by then.
const leftovers = new Set();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
after(() => {
  for (const pid of leftovers) { if (alive(pid)) { try { process.kill(pid); } catch { /* already gone */ } } }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(50); } return fn(); }
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

describe('lib/core run(): timeout ends the whole tree (B2/FLOW-1)', { skip: !WIN && 'Windows-only (taskkill /T)' }, () => {
  it('cmd → node grandchild: both killed, resolves with err.killed', async () => {
    // the worker reports its own pid AND its parent's (= cmd.exe), then idles forever (self-ends after
    // 60 s as a last resort, so a broken kill cannot leave it behind for good)
    const script = path.join(dir, 'idle.js');
    const out = path.join(dir, 'idle.json');
    fs.writeFileSync(script, `require('fs').writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, ppid: process.ppid })); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000);`);
    const t0 = Date.now();
    const p = run('"' + process.execPath + '"', ['"' + script + '"', '"' + out + '"'], { shell: true, timeout: 2500 });
    const ids = await waitFor(() => readJson(out), 5000);
    assert.ok(ids && ids.pid, 'worker started and reported its pid');
    leftovers.add(ids.pid); leftovers.add(ids.ppid);
    assert.notEqual(ids.ppid, process.pid, 'the worker is a GRANDCHILD (its parent is the shell, not us)');
    const r = await p;
    const took = Date.now() - t0;
    assert.ok(r.err, 'a timed-out run reports an error');
    assert.equal(r.err.killed, true, 'err.killed is the "timed out" contract the callers read');
    assert.match(String(r.err.message), /timed out/i, 'the message names the timeout (the exit code stays in err.code)');
    // Usually the tree kill closes the pipes and execFile's own callback answers ("Command failed").
    // On a loaded machine taskkill alone can outlast the 3 s grace, and the hard-resolve answers first;
    // both are the contract. What proves the TREE kill is that both pids are gone (below), which the
    // hard-resolve alone would never achieve. Timing is only bounded loosely — by the code's own bounds,
    // taken from lib/core (a literal 5000 here was a copy of a taskkill cap that no longer exists).
    assert.ok(took < 2500 + KILL_TREE_WAIT_MS + RUN_KILL_GRACE_MS + 2000, 'bounded (' + took + ' ms)');
    assert.equal(await waitFor(() => !alive(ids.pid), 3000), true, 'the node grandchild is gone');
    leftovers.delete(ids.pid);
    assert.equal(await waitFor(() => !alive(ids.ppid), 3000), true, 'the cmd.exe in between is gone');
    leftovers.delete(ids.ppid);
  });

  it('pipe holder outside the tree: still resolves ~3 s after the kill, with err.killed', async () => {
    // The direct child spawns a DETACHED grandchild that inherits the stdio pipes, writes its pid and
    // exits at once. 'exit' fires, 'close' never does (the grandchild holds the write ends), and
    // taskkill /T on the dead parent cannot reach it — the exact shape that hung run() forever.
    const holder = path.join(dir, 'holder.js');
    const launcher = path.join(dir, 'launcher.js');
    const out = path.join(dir, 'holder.pid');
    fs.writeFileSync(holder, `setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000);`);
    fs.writeFileSync(launcher, `
      const { spawn } = require('child_process');
      const g = spawn(process.execPath, [${JSON.stringify(holder)}], { stdio: 'inherit', detached: true, windowsHide: true });
      require('fs').writeFileSync(process.argv[2], String(g.pid));
      g.unref(); process.exit(0);`);
    const TIMEOUT = 1000;
    const t0 = Date.now();
    const p = run(process.execPath, [launcher, out], { timeout: TIMEOUT });
    const pid = Number(await waitFor(() => { try { return fs.readFileSync(out, 'utf8'); } catch { return ''; } }, 5000));
    assert.ok(pid > 0, 'the pipe holder started');
    leftovers.add(pid);
    const r = await p;
    const took = Date.now() - t0;
    assert.ok(r.err && r.err.killed === true, 'resolved as timed out (err.killed), not as a clean exit');
    assert.doesNotMatch(String(r.err.message), /Command failed/, 'the hard-resolve path answered (execFile never called back)');
    assert.equal(r.err.code, 'ETIMEDOUT', 'no exit code to report there — ETIMEDOUT stands in');
    assert.ok(took >= TIMEOUT + RUN_KILL_GRACE_MS, 'waited for its timer, then the full grace after the kill (' + took + ' ms)');
    // timeout + killTree's wait bound + grace + slack
    assert.ok(took < TIMEOUT + KILL_TREE_WAIT_MS + RUN_KILL_GRACE_MS + 3000, 'and did not hang past it (' + took + ' ms)');
    // the holder is outside the tree by design, so it is still alive here — end it, then forget it
    try { process.kill(pid); } catch { /* */ }
    if (await waitFor(() => !alive(pid), 3000)) leftovers.delete(pid);
  });

  it('a fast command is unaffected (no kill, no killed flag)', async () => {
    const r = await run(process.execPath, ['-e', 'process.stdout.write("ok")'], { timeout: 10000 });
    assert.equal(r.err, null);
    assert.equal(r.stdout, 'ok');
  });
});
