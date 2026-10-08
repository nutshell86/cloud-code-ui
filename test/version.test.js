'use strict';
// Route contracts for the version/update/restart trio — the regression suite for "the app's update
// button does nothing":
//   • /api/version must report EXACT behind/ahead or say compareOk:false — never a guessed "1"
//     (the old fallback `behind = 1` produced a permanent phantom "Update · 1" on unpushed branches,
//     and the update button then pulled nothing, forever).
//   • /api/version/pull must refuse on a non-main branch, must never pull into a dirty tree (and say
//     which files stopped it), must report `changed` so the client can say "already up to date" —
//     and must actually fast-forward when nothing is in the way.
//   • /api/restart must actually hand the port over to a fresh process (this is the check that would
//     have caught a missing `spawn` import — `node --check` cannot).
// Runs against a throwaway server on a free port with a hermetic data dir; never touches :8787.
// Two suites: the first reads the panel's real checkout (read-only), the second gives the server a
// purpose-built repo through CLAUDE_UI_REPO_DIR and exercises everything that writes.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const os = require('os');
const fsp = require('fs/promises');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(ROOT, 'fake-claude.js');

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
// `agent: false` (no keep-alive pooling) matters for the restart call: the server exits right after
// responding, and a pooled socket then surfaces the teardown as an ECONNRESET on the request object
// even though the response arrived. An unpooled socket closes cleanly with the response.
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    let settled = false;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: Object.assign({ Connection: 'close' }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { settled = true; let json = null; try { json = JSON.parse(d); } catch {} resolve({ status: res.statusCode, body: d, json }); }); });
    r.on('error', (e) => { if (!settled) reject(e); }); // a reset after a complete response is noise
    if (data) r.write(data); r.end();
  });
}
// Kill whatever process currently listens on `port` (the restart successor is detached, so it is not
// a child we can reap). Best-effort and platform-guarded; a failure must not fail the suite.
function killPortHolder(port) {
  return new Promise((resolve) => {
    const [cmd, args] = process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-Command', `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -Confirm:$false }`]]
      : ['sh', ['-c', `lsof -ti tcp:${port} | xargs -r kill -9`]];
    try {
      const p = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
      p.on('close', () => resolve()); p.on('error', () => resolve());
      setTimeout(resolve, 8000);
    } catch { resolve(); }
  });
}
async function waitUp(port, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await req(port, 'GET', '/api/ping'); if (r.status === 200) return true; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  return false;
}

describe('/api/version · /api/version/pull · /api/restart', () => {
  let S, dataDir, port;
  before(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-version-test-'));
    port = await freePort();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, CLAUDE_UI_PORT: String(port), CLAUDE_UI_FAKE_BIN: FAKE, CLAUDE_UI_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
    assert.ok(await waitUp(port), 'server did not come up: ' + log);
    S = { child, log: () => log };
  });
  after(async () => {
    try { S && S.child && S.child.kill(); } catch {}
    // The restart test hands the port to a DETACHED successor that is not our child — without this
    // every run would leak a stray server on the test port. Kill whoever holds the port now.
    await killPortHolder(port);
    if (dataDir) await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('/api/version never invents a behind count', async () => {
    const r = await req(port, 'GET', '/api/version');
    assert.equal(r.status, 200);
    const v = r.json;
    assert.equal(typeof v.behind, 'number');
    assert.equal(typeof v.ahead, 'number');
    assert.equal(typeof v.compareOk, 'boolean', 'compareOk missing — the honest-compare contract is gone');
    assert.equal(typeof v.localOnly, 'boolean');
    // the old bug: a failed/impossible comparison reported behind=1 while claiming it was real
    if (!v.compareOk) assert.equal(v.behind, 0, 'compare failed but a behind count was reported anyway');
    if (!v.compareOk || !v.fetchOk) assert.equal(v.upToDate, false, 'upToDate must not be claimed without a real comparison');
    assert.equal(typeof v.branch, 'string');
  });

  // NOTHING here posts to /api/version/pull any more. That route acts on the checkout the server was
  // started from, so probing it here meant probing the developer's own working tree: on a feature
  // branch it asserted the refusal, on a dirty tree the dirty refusal — and on a clean main it
  // performed a REAL fast-forward in the repo the suite was running from, mid-test-run. Its whole
  // contract now lives in the hermetic suite at the bottom of this file (CLAUDE_UI_REPO_DIR), which
  // builds an upstream and a clone one commit behind it. What stays here is read-only.

  it('/api/restart hands the port to a fresh process (catches a missing spawn import)', async () => {
    const before = (await req(port, 'GET', '/api/ping')).status;
    assert.equal(before, 200);
    const r = await req(port, 'POST', '/api/restart');
    assert.equal(r.status, 200, 'restart rejected: ' + r.body);
    assert.ok(r.json.ok && r.json.launcher, 'no launcher pid returned: ' + r.body);
    // the successor waits for the old listener to disappear, so allow a generous window
    assert.ok(await waitUp(port, 40000), 'the server never came back after /api/restart — successor failed to start');
    const v = await req(port, 'GET', '/api/version');
    assert.equal(v.status, 200, 'restarted server does not serve /api/version');
  });
});

// ---------------------------------------------------------------------------------------------
//  The same route against a THROWAWAY checkout — CLAUDE_UI_REPO_DIR (lib/paths.js)
// ---------------------------------------------------------------------------------------------
// Everything above can only look at whatever state the developer's tree happens to be in: on a
// feature branch it asserts the refusal, on a dirty tree the dirty refusal — and on a clean main it
// would perform a REAL pull in the checkout the suite runs from. With the repo seam the route gets a
// purpose-built repo instead (an upstream, a clone reset one commit back), so the whole contract is
// assertable, including the successful fast-forward that had no test at all.
describe('/api/version/pull against a throwaway checkout', () => {
  let S, dataDir, tmp, work, port, noToken = false;
  const git = (cwd, args) => new Promise((resolve, reject) => {
    // -c user.*: `git commit` refuses without an identity, and the machine's global one is none of
    // this test's business. GIT_CONFIG_NOSYSTEM keeps a system-wide hook/template out of it.
    const g = spawn('git', ['-C', cwd, '-c', 'user.name=ccui test', '-c', 'user.email=ccui@test.invalid', ...args],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });
    let o = '', e = '';
    g.stdout.on('data', (d) => (o += d)); g.stderr.on('data', (d) => (e += d));
    g.on('error', reject);
    g.on('close', (c) => (c === 0 ? resolve(o.trim()) : reject(new Error('git ' + args.join(' ') + ' → ' + c + ': ' + e))));
  });
  const head = (cwd) => git(cwd, ['rev-parse', 'HEAD']);

  before(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-repo-seam-'));
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-repo-seam-data-'));
    const up = path.join(tmp, 'upstream');
    await fsp.mkdir(up);
    // `-b main` matters: without it the default branch follows the machine's git config, and every
    // assertion here is about the branch literally named main.
    await git(up, ['init', '-q', '-b', 'main']);
    await fsp.writeFile(path.join(up, 'a.txt'), 'one\n');
    await git(up, ['add', '-A']); await git(up, ['commit', '-q', '-m', 'one']);
    const first = await head(up);
    await fsp.writeFile(path.join(up, 'a.txt'), 'two\n');
    await git(up, ['add', '-A']); await git(up, ['commit', '-q', '-m', 'two']);
    work = path.join(tmp, 'work');
    await git(tmp, ['clone', '-q', up, work]);
    await git(work, ['reset', '--hard', '-q', first]); // → exactly 1 behind origin/main, clean tree
    port = await freePort();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, CLAUDE_UI_PORT: String(port), CLAUDE_UI_FAKE_BIN: FAKE, CLAUDE_UI_DATA_DIR: dataDir, CLAUDE_UI_REPO_DIR: work },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
    assert.ok(await waitUp(port), 'server did not come up: ' + log);
    S = { child };
    // NO token probe here. A `POST /api/version/pull` on a clean main IS the update: the first
    // version of this hook probed with an empty body, performed the fast-forward itself, and the
    // fast-forward case below then legitimately found `changed:false`. The token state is read off
    // the first dirty-tree case instead, where the route cannot pull anything either way.
  });
  after(async () => {
    try { S && S.child && S.child.kill(); } catch {}
    await killPortHolder(port);
    for (const d of [tmp, dataDir]) if (d) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
  });

  it('reads the seam repo, not the panel checkout', async () => {
    const r = await req(port, 'GET', '/api/version');
    assert.equal(r.status, 200);
    assert.equal(r.json.branch, 'main');
    assert.equal(r.json.current, (await head(work)).slice(0, r.json.current.length), 'HEAD is not the throwaway repo — the seam is not being read');
  });

  // The row used to offer an update that could not run: `behind: 1` and nothing about the local changes
  // that make `git pull --ff-only` refuse. Both facts now come out of the same single git call.
  it('/api/version reports the dirty tree — and stays clean-handed about a clean one', async () => {
    const clean = await req(port, 'GET', '/api/version');
    assert.deepEqual(clean.json.dirty, [], 'a clean tree must report no files');
    assert.equal(clean.json.dirtyCount, 0);
    await fsp.writeFile(path.join(work, 'a.txt'), 'edited\n');
    await fsp.writeFile(path.join(work, 'untracked.txt'), 'new\n');
    const dirty = await req(port, 'GET', '/api/version');
    assert.equal(dirty.json.dirtyCount, 2);
    assert.deepEqual(dirty.json.dirty.slice().sort(), ['a.txt', 'untracked.txt']);
    assert.equal(dirty.json.branch, 'main', 'the branch answer must survive the dirty header');
    await git(work, ['checkout', '--', 'a.txt']);
    await fsp.rm(path.join(work, 'untracked.txt'));
  });

  it('refuses on a dirty main with dirty-main + the file list, and pulls nothing', async () => {
    await fsp.writeFile(path.join(work, 'a.txt'), 'locally changed\n');
    const was = await head(work);
    const r = await req(port, 'POST', '/api/version/pull', { switchToMain: true });
    // Doubles as the token probe for the cases below: a dirty tree is refused before the route
    // reaches anything network-bound, so this call cannot pull and cannot cost anything.
    if (r.status === 400 && r.json && r.json.error === 'no-token') {
      noToken = true;
      await git(work, ['checkout', '--', 'a.txt']);
      return;
    }
    assert.equal(r.status, 409, 'dirty main was pulled into (body: ' + r.body + ')');
    assert.equal(r.json.error, 'dirty-main');
    assert.deepEqual(r.json.files, ['a.txt']);
    assert.equal(r.json.count, 1);
    assert.equal(await head(work), was, 'HEAD moved despite the refusal');
    await git(work, ['checkout', '--', 'a.txt']); // clean again for the cases below
  });

  it('refuses a feature branch — not-on-main without consent, dirty with it', async () => {
    if (noToken) return;
    await git(work, ['checkout', '-q', '-b', 'feature/x']);
    const bare = await req(port, 'POST', '/api/version/pull', {});
    assert.equal(bare.status, 409);
    assert.equal(bare.json.error, 'not-on-main');
    assert.equal(bare.json.branch, 'feature/x');
    // consent given, but an in-progress change must never be carried across the switch
    await fsp.writeFile(path.join(work, 'b.txt'), 'untracked work\n');
    const dirty = await req(port, 'POST', '/api/version/pull', { switchToMain: true });
    assert.equal(dirty.status, 409);
    assert.equal(dirty.json.error, 'dirty', 'a feature branch must report `dirty`, not `dirty-main`');
    assert.deepEqual(dirty.json.files, ['b.txt']);
    assert.equal(await git(work, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/x', 'branch was switched anyway');
    await fsp.rm(path.join(work, 'b.txt'));
  });

  it('switches to main and fast-forwards — then reports changed:false the second time', async () => {
    if (noToken) return;
    const target = await git(work, ['rev-parse', 'origin/main']);
    const r = await req(port, 'POST', '/api/version/pull', { switchToMain: true });
    assert.equal(r.status, 200, 'the fast-forward failed: ' + r.body);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.changed, true, 'a pull that moved HEAD must not report changed:false');
    assert.equal(r.json.switched, 'feature/x', 'the branch it left is not reported');
    assert.equal(await git(work, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
    assert.equal(await head(work), target, 'HEAD is not at origin/main after the fast-forward');
    // the honest "already up to date" — the state that used to produce a green "updated" toast
    const again = await req(port, 'POST', '/api/version/pull', { switchToMain: true });
    assert.equal(again.status, 200, again.body);
    assert.equal(again.json.changed, false);
  });
});
