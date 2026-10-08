'use strict';
// Contracts for the Claude Code CLI update chain (/api/cli/version + /api/cli/update) — the CLI-side
// twin of version.test.js. What must hold:
//   • "update available" is a VERSION COMPARISON, not string inequality. `latest !== current` also
//     fires for a DOWNGRADE (a locally installed build the registry doesn't carry yet), which is a "↑"
//     no update can ever clear — that was the old behaviour in /api/sysinfo.
//   • /api/cli/update must REFUSE while claude.exe is running instead of half-replacing a locked
//     binary, and must say how many processes it found so the user can decide.
//   • success is judged by --version before/after, not by the updater's exit code.
// Runs against a throwaway server with the fake bin + fake registry/process seams: no download, no
// registry round trip, no real install. Never touches :8787.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(ROOT, 'fake-claude.js');
const cli = require('../lib/cli');

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
async function waitUp(port, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await req(port, 'GET', '/api/ping'); if (r.status === 200) return; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('server did not come up on :' + port);
}
async function boot(extraEnv) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-cliupd-'));
  const dataDir = path.join(dir, 'data'); await fsp.mkdir(dataDir, { recursive: true });
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      CLAUDE_UI_PORT: String(port),
      CLAUDE_UI_FAKE_BIN: FAKE,              // `--version` → 9.9.9, `update` → deterministic
      CLAUDE_UI_FAKE_NPM_LATEST: '9.9.10',   // …and the registry says a newer one exists
      CLAUDE_UI_FAKE_PROCS: '0',             // …and nothing is holding the binary
      CLAUDE_UI_DATA_DIR: dataDir,
      ...(extraEnv || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  await waitUp(port);
  return { port, log: () => log, stop: async () => { await new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }); await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); } };
}

describe('lib/cli: version comparison + install-method detection (pure)', () => {
  it('isNewer only fires for a genuinely newer version', () => {
    assert.equal(cli.isNewer('2.1.267', '2.1.263'), true);
    assert.equal(cli.isNewer('2.2.0', '2.1.999'), true);
    assert.equal(cli.isNewer('3.0.0', '2.9.9'), true);
    assert.equal(cli.isNewer('2.1.263', '2.1.263'), false);
    // the regression: a DOWNGRADE is not an update (old `latest !== current` said it was)
    assert.equal(cli.isNewer('2.1.263', '2.1.267'), false);
    assert.equal(cli.isNewer('2.1.9', '2.1.10'), false, 'compared as strings, not numbers');
    // never claim anything from missing/unparsable input
    assert.equal(cli.isNewer(null, '2.1.263'), false);
    assert.equal(cli.isNewer('2.1.267', ''), false);
    assert.equal(cli.isNewer('latest', '2.1.263'), false);
  });
  it('parseVersion picks the version out of the CLI banner', () => {
    assert.equal(cli.parseVersion('2.1.263 (Claude Code)'), '2.1.263');
    assert.equal(cli.parseVersion(''), '');
  });
  it('detectInstallMethod names what a click is about to rewrite', () => {
    assert.equal(cli.detectInstallMethod('C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'), 'npm-global');
    assert.equal(cli.detectInstallMethod('/home/x/.local/bin/claude'), 'native');
    assert.equal(cli.detectInstallMethod('C:\\Users\\x\\.claude\\local\\claude.exe'), 'npm-local');
    assert.equal(cli.detectInstallMethod('/opt/somewhere/claude'), 'unknown');
    assert.equal(cli.detectInstallMethod(''), 'unknown');
  });
});

describe('CLI update routes', () => {
  let S;
  before(async () => { S = await boot(); });
  after(async () => { if (S) await S.stop(); });

  it('/api/cli/version reports current, latest and a NEWER-than verdict', async () => {
    const r = await req(S.port, 'GET', '/api/cli/version');
    assert.equal(r.status, 200);
    assert.equal(r.json.current, '9.9.9');
    assert.equal(r.json.latest, '9.9.10');
    assert.equal(r.json.updateAvailable, true);
    assert.equal(r.json.canUpdate, true);
    assert.ok(r.json.method, 'install method missing');
  });

  it('/api/cli/update runs the updater and reports what actually changed', async () => {
    const r = await req(S.port, 'POST', '/api/cli/update', {});
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    // the fake updater exits 0 but the version does not move — "success" must not be reported as an update
    assert.equal(r.json.changed, false);
    assert.equal(r.json.before, '9.9.9');
    assert.match(r.json.output, /Already up to date/);
  });
});

describe('CLI update: refuses while claude.exe is running', () => {
  let S;
  before(async () => { S = await boot({ CLAUDE_UI_FAKE_PROCS: '3' }); });
  after(async () => { if (S) await S.stop(); });

  it('409 with the process count instead of a half-replaced binary', async () => {
    const r = await req(S.port, 'POST', '/api/cli/update', {});
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'claude-running');
    assert.equal(r.json.procs, 3);
    assert.equal(r.json.chats, 0); // the panel's own chats, counted separately for the wording
  });
  it('force:true is the user overriding it, and gets through', async () => {
    const r = await req(S.port, 'POST', '/api/cli/update', { force: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
  });
});

describe('CLI update: a failing updater is an error, not a silent success', () => {
  let S;
  before(async () => { S = await boot({ FAKE_CLAUDE_SCENARIO: 'updatefail' }); });
  after(async () => { if (S) await S.stop(); });

  it('500 + the real output + the "binary was locked" hint', async () => {
    const r = await req(S.port, 'POST', '/api/cli/update', {});
    assert.equal(r.status, 500);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /EBUSY/);
    assert.equal(r.json.locked, true, 'the lock case must be recognisable — it needs different advice');
  });
});
