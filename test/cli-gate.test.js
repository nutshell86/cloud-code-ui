'use strict';
// B1 / B4 / B5 / FLOW-6 against throwaway servers (test/sandbox.js env + fake-claude, never :8787):
//   • ONE `claude update` and ONE self-pull at a time — a second request gets 409 code 'already-running';
//   • while the CLI updates nothing spawns claude.exe: chat start → 503 'cli-updating' (+ hint) BEFORE
//     any side effect (no MCP selection, no temp MCP config), the manual schedule run, doctor, auth,
//     enhance and the MCP routes → 503 'cli-updating'; the version endpoint answers the flagged snapshot,
//     and afterwards the NEW version (fake `update` moves FAKE_CLAUDE_VERSION_FILE) — not a cached one;
//   • no restart while an update or a self-pull runs: 409 'busy-updating' + what ('cli' | 'pull') + since;
//   • tasklist "could not tell" (null) is not "nothing running": the update asks first
//     (409 'process-state-unknown') and goes through only with force; sysinfo says so too;
//   • an update that leaves the binary GONE says so (500 'cli-missing' + the claude.exe.old.* files),
//     and so does the next chat start;
//   • /api/sysinfo + /api/cli/version share ONE `npm view` (one process, in-flight shared, cached);
//   • a port that is taken is fatal (exit 1 + a line naming EADDRINUSE), not a zombie server (B4).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { makeSandbox } = require('./sandbox');

const ROOT = path.join(__dirname, '..');
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) { try { await c(); } catch { /* */ } } });

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 60000, agent: false, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* text */ } resolve({ status: res.statusCode, body: d, json }); }); });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout ' + p)); });
    if (data) r.write(data); r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(port, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await req(port, 'GET', '/api/ping'); if (r.status === 200) return; } catch { /* not up yet */ } await sleep(150); }
  throw new Error('server did not come up on :' + port);
}
// sandbox + fake CLI; `prep(sb)` may seed files and return extra env (it runs before the spawn)
async function boot(label, prep) {
  const sb = makeSandbox(label, { fakeCli: true });
  const extra = (prep && prep(sb)) || {};
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...sb.env, CLAUDE_UI_PORT: String(port), CLAUDE_UI_FAKE_PROCS: '0', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  const stop = async () => { await new Promise((r) => { if (child.exitCode !== null) return r(); child.once('exit', () => r()); child.kill(); setTimeout(r, 2000); }); sb.cleanup(); };
  cleanups.push(stop);
  await waitUp(port);
  return { port, sb, log: () => log, stop };
}
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return !!(await fn()); }

describe('B1/FLOW-6: one CLI update at a time, and nothing spawns while it runs', () => {
  it('second update → 409 already-running; chat start + schedule run → 503 cli-updating', async () => {
    const srv = await boot('gate', (sb) => {
      // a schedule the manual-run route can find (the skill does not exist — it must never get that far)
      fs.writeFileSync(path.join(sb.dataDir, 'ui-skill-schedules.json'), JSON.stringify([{ id: 'sc-gate', name: 'no-such-skill', enabled: false, timing: { type: 'interval', minutes: 60 } }]));
      const versionFile = path.join(sb.root, 'claude-version.txt');
      fs.writeFileSync(versionFile, '9.9.9');
      return {
        FAKE_CLAUDE_UPDATE_MS: '6000',          // fake `claude update` holds for 6 s (room for every probe below)
        FAKE_CLAUDE_VERSION_FILE: versionFile, // …and then writes 9.9.10 into it
        TEMP: sb.root, TMP: sb.root,            // the temp MCP config dir (os.tmpdir()) inside the sandbox, to look into
      };
    });
    // the pre-update number in the server's version cache — what a missing invalidation would serve later
    const v0 = await req(srv.port, 'GET', '/api/cli/version');
    assert.equal(v0.json.current, '9.9.9');
    const first = req(srv.port, 'POST', '/api/cli/update', {});
    // the flag is up once /api/cli/version answers the flagged snapshot (it spawns nothing then)
    assert.ok(await waitFor(async () => { const v = await req(srv.port, 'GET', '/api/cli/version'); return v.json && v.json.updating === true; }, 5000), 'update in flight');

    const v = await req(srv.port, 'GET', '/api/cli/version');
    assert.equal(v.status, 200);
    assert.equal(v.json.updating, true);
    assert.equal(v.json.canUpdate, false, 'no second update offered while one runs');
    assert.ok(v.json.updatingSince > 0);

    const second = await req(srv.port, 'POST', '/api/cli/update', { force: true });
    assert.equal(second.status, 409);
    assert.equal(second.json.code, 'already-running');
    assert.ok(second.json.since > 0);

    // an explicit MCP choice is the start route's first side effect (session-mcp.json + a temp config);
    // the route's own guard must refuse before it, not leave startChat() to refuse after it
    const chat = await req(srv.port, 'POST', '/api/chat/start', { mcpServers: ['x'] });
    assert.equal(chat.status, 503);
    assert.equal(chat.json.code, 'cli-updating');
    assert.equal(typeof chat.json.hint, 'string');
    assert.equal(fs.existsSync(path.join(srv.sb.dataDir, 'session-mcp.json')), false, 'no MCP selection written');
    assert.equal(fs.existsSync(path.join(srv.sb.root, 'claude-code-ui-mcp')), false, 'no temp MCP config written');

    const sched = await req(srv.port, 'POST', '/api/uiskill/schedules/run', { id: 'sc-gate' });
    assert.equal(sched.status, 503, 'manual schedule run refused while updating');
    assert.equal(sched.json.code, 'cli-updating');

    // every other route that runs CLAUDE_EXE asks the same flag
    for (const [method, route, body] of [['GET', '/api/doctor'], ['GET', '/api/auth'], ['POST', '/api/enhance', { text: 'x' }], ['POST', '/api/mcp/remove', { name: 'x' }]]) {
      const r = await req(srv.port, method, route, body);
      assert.equal(r.status, 503, method + ' ' + route + ' refused while updating: ' + r.body);
      assert.equal(r.json.code, 'cli-updating', method + ' ' + route);
    }

    // #2: a restart would cut the update off half-way — refused with what is busy and since when
    const rs = await req(srv.port, 'POST', '/api/restart', {});
    assert.equal(rs.status, 409, 'no restart during the update: ' + rs.body);
    assert.equal(rs.json.code, 'busy-updating');
    assert.equal(rs.json.error, 'busy-updating');
    assert.equal(rs.json.what, 'cli');
    assert.equal(rs.json.since, v.json.updatingSince, 'since = when the update began');

    const si = await req(srv.port, 'GET', '/api/sysinfo');
    assert.equal(si.status, 200);
    assert.equal(si.json.cliUpdating, true);
    assert.equal((await req(srv.port, 'GET', '/api/cli/version')).json.updating, true, 'every probe above ran inside the update');

    const r1 = await first;
    assert.equal(r1.status, 200, 'the first update completes normally: ' + r1.body);
    assert.equal(r1.json.ok, true);
    assert.equal(r1.json.before, '9.9.9');
    assert.equal(r1.json.after, '9.9.10');
    assert.equal(r1.json.changed, true);

    // …and the gate is down again
    const after1 = await req(srv.port, 'GET', '/api/cli/version');
    assert.equal(after1.json.updating, false);
    assert.equal(after1.json.current, '9.9.10', 'the cache was invalidated — a fresh --version, not the cached 9.9.9');
    const chat2 = await req(srv.port, 'POST', '/api/chat/start', {});
    assert.equal(chat2.status, 200, 'chat start works after the update: ' + chat2.body);
    if (chat2.json && chat2.json.chatId) await req(srv.port, 'POST', '/api/chat/' + chat2.json.chatId + '/stop', {}).catch(() => {});
  });

  it('process count unknown → 409 process-state-unknown; force → runs; sysinfo reports it', async () => {
    const srv = await boot('pstate', () => ({ CLAUDE_UI_FAKE_PROCS: 'unknown' }));
    const r = await req(srv.port, 'POST', '/api/cli/update', {});
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'process-state-unknown');
    assert.equal(r.json.procs, null);
    const si = await req(srv.port, 'GET', '/api/sysinfo');
    assert.equal(si.json.claudeRunning, null);
    assert.equal(si.json.claudeRunningWarning, 'process-state-unknown');
    const f = await req(srv.port, 'POST', '/api/cli/update', { force: true });
    assert.equal(f.status, 200, f.body);
    assert.equal(f.json.ok, true);
  });

  it('a known count is reported as a number, without a warning', async () => {
    const srv = await boot('pcount', () => ({ CLAUDE_UI_FAKE_PROCS: '2' }));
    const si = await req(srv.port, 'GET', '/api/sysinfo');
    assert.equal(si.json.claudeRunning, 2);
    assert.equal(si.json.claudeRunningWarning, null);
    const r = await req(srv.port, 'POST', '/api/cli/update', {});
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'claude-running');
    assert.equal(r.json.procs, 2);
  });

  it('update that leaves the binary gone → 500 cli-missing + oldFiles; next chat start says so too', async () => {
    let exe = '';
    const srv = await boot('missing', (sb) => {
      // a stand-in "claude.exe" under the temp dir — the only kind of file the updatemissing scenario moves
      exe = path.join(sb.root, 'claude.exe');
      fs.writeFileSync(exe, 'not a real binary');
      return { CLAUDE_UI_CLAUDE_BIN: exe, FAKE_CLAUDE_SCENARIO: 'updatemissing' };
    });
    const r = await req(srv.port, 'POST', '/api/cli/update', {});
    assert.equal(r.status, 500, r.body);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.code, 'cli-missing');
    assert.equal(r.json.missing, true);
    assert.equal(r.json.exe, exe);
    assert.equal(r.json.oldFiles.length, 1);
    assert.match(path.basename(r.json.oldFiles[0]), /^claude\.exe\.old\.\d+$/);
    assert.equal(fs.existsSync(exe), false);
    const c = await req(srv.port, 'POST', '/api/chat/start', {});
    assert.equal(c.status, 500);
    assert.equal(c.json.code, 'cli-missing');
    assert.deepEqual(c.json.oldFiles, r.json.oldFiles);
  });
});

describe('B1: one self-pull at a time', () => {
  it('second /api/version/pull while the first runs → 409 already-running', async () => {
    const srv = await boot('pull', (sb) => {
      const repo = path.join(sb.root, 'repo'); fs.mkdirSync(repo);
      return {
        CLAUDE_UI_FAKE_PULL_DELAY_MS: '1500',                          // hold the guarded section open
        CLAUDE_UI_GHE_CREDS: path.join(sb.root, 'no-such-creds.json'), // → selfPull answers 400 no-token: no git, no network
        CLAUDE_UI_REPO_DIR: repo,
      };
    });
    const first = req(srv.port, 'POST', '/api/version/pull', {});
    await sleep(400);
    const second = await req(srv.port, 'POST', '/api/version/pull', {});
    assert.equal(second.status, 409);
    assert.equal(second.json.code, 'already-running');
    // #2: no restart while git may be half-way through a checkout
    const rs = await req(srv.port, 'POST', '/api/restart', {});
    assert.equal(rs.status, 409, 'no restart during the pull: ' + rs.body);
    assert.equal(rs.json.code, 'busy-updating');
    assert.equal(rs.json.what, 'pull');
    assert.equal(rs.json.since, second.json.since, 'since = when the pull began');
    const r1 = await first;
    assert.equal(r1.status, 400);
    assert.equal(r1.json.error, 'no-token');
    // released in `finally` — the next pull gets in again. The same flag is the restart's only pull
    // gate, so this is also what lets the client's pull → restart chain through (the successful
    // restart itself is version.test.js's: it hands the port to a detached successor)
    const third = await req(srv.port, 'POST', '/api/version/pull', {});
    assert.equal(third.status, 400, 'singleton released after the first pull: ' + third.body);
  });
});

describe('B5: /api/sysinfo + /api/cli/version share ONE npm view', () => {
  it('a burst and a repeat spawn npm exactly once', async () => {
    let counter = '';
    const srv = await boot('npm', (sb) => {
      counter = path.join(sb.root, 'npm-calls.txt');
      const fakeNpm = path.join(sb.root, 'fake-npm.js');
      // stands in for `npm view …`: logs the call, waits a little (so the burst overlaps), answers
      fs.writeFileSync(fakeNpm, `require('fs').appendFileSync(${JSON.stringify(counter)}, process.argv.slice(2).join(' ') + '\\n');
        setTimeout(() => { process.stdout.write(JSON.stringify({ version: '9.9.10', 'dist-tags': { latest: '9.9.10' }, 'time.modified': '2026-01-01T00:00:00Z' })); }, 400);`);
      return { CLAUDE_UI_FAKE_NPM: fakeNpm, CLAUDE_UI_FAKE_NPM_LATEST: '' };
    });
    const burst = await Promise.all([
      req(srv.port, 'GET', '/api/sysinfo'), req(srv.port, 'GET', '/api/cli/version'), req(srv.port, 'GET', '/api/sysinfo'),
    ]);
    for (const b of burst) assert.equal(b.status, 200);
    assert.equal(burst[0].json.cliVersion, '9.9.9');
    assert.equal(burst[0].json.cliLatest, '9.9.10');
    assert.equal(burst[0].json.updateAvailable, true);
    assert.equal(burst[1].json.latest, '9.9.10');
    assert.equal(burst[1].json.lastPublished, '2026-01-01T00:00:00Z', 'time.modified rides in the same call');
    assert.ok('claudeRunning' in burst[0].json, 'sysinfo carries the process count');
    const again = await req(srv.port, 'GET', '/api/sysinfo');
    assert.equal(again.json.cliLatest, '9.9.10');
    const calls = fs.readFileSync(counter, 'utf8').trim().split('\n');
    assert.equal(calls.length, 1, 'one npm process for the whole burst + repeat, got: ' + JSON.stringify(calls));
    assert.match(calls[0], /^view @anthropic-ai\/claude-code version dist-tags time\.modified --json$/);
  });
});

describe('B4: a taken port is fatal', () => {
  it('exits 1 with an EADDRINUSE line instead of idling as a zombie', async () => {
    const blocker = net.createServer();
    const port = await new Promise((resolve) => blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port)));
    cleanups.push(() => new Promise((r) => blocker.close(() => r())));
    const sb = makeSandbox('eaddr', { fakeCli: true });
    cleanups.push(() => sb.cleanup());
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, ...sb.env, CLAUDE_UI_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => { try { child.kill(); } catch { /* */ } resolve('still running'); }, 20000);
      child.once('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    assert.equal(code, 1, 'process exited with 1 (log: ' + log.slice(-400) + ')');
    assert.match(log, /EADDRINUSE/);
    assert.match(log, new RegExp('Port ' + port));
  });
});
