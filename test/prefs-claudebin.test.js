'use strict';
// Route contract for the Settings field „Claude-Binary" — POST /api/prefs { claudeBin }.
// The field's job is to END a „claude nicht gefunden" situation, so the route has to reject what
// cannot work (relative path, missing file), persist what can, re-resolve LIVE (so the answer states
// what the next start will use) and prove the binary by asking it for its version. Boots a throwaway
// server with CLAUDE_UI_DATA_DIR pointing at a temp dir, so the live ui-prefs.json is never touched.
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
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch {} resolve({ status: res.statusCode, body: d, json }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function waitUp(port, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await req(port, 'GET', '/api/state'); if (r.status === 200) return; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('server did not come up on :' + port);
}

describe('POST /api/prefs { claudeBin } (hermetic data dir)', () => {
  let S, dataDir;
  before(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-bin-test-'));
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      // CLAUDE_UI_CLAUDE_BIN cleared: verify's sandbox sets it, and the env var outranks the ui-prefs
      // value this suite is about (resolveClaudeBin trims, so '' counts as unset)
      env: { ...process.env, CLAUDE_UI_PORT: String(port), CLAUDE_UI_FAKE_BIN: FAKE, CLAUDE_UI_DATA_DIR: dataDir, CLAUDE_UI_CLAUDE_BIN: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitUp(port);
    S = { port, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }) };
  });
  after(async () => {
    if (S) await S.stop();
    if (dataDir) await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('a relative path is refused (it would resolve against the server cwd, not the user\'s)', async () => {
    const r = await req(S.port, 'POST', '/api/prefs', { claudeBin: 'claude.exe' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /absolute/i);
  });

  it('a path that does not exist is refused, naming it', async () => {
    const miss = path.join(os.tmpdir(), 'ccui-does-not-exist', 'claude.exe');
    const r = await req(S.port, 'POST', '/api/prefs', { claudeBin: miss });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /not found/i);
    assert.ok(r.json.error.includes('ccui-does-not-exist'), 'the rejected path must appear in the message');
  });

  it('a directory is refused (statSync().isFile(), not just existsSync)', async () => {
    const r = await req(S.port, 'POST', '/api/prefs', { claudeBin: os.tmpdir() });
    assert.equal(r.status, 400);
  });

  it('an existing binary is stored, re-resolved live and PROVEN by its --version answer', async () => {
    // node.exe stands in for the claude binary: it exists, it is a real executable, and `--version`
    // answers in the same shape — so the probe is asserted on an actual version string.
    const r = await req(S.port, 'POST', '/api/prefs', { claudeBin: '"' + process.execPath + '"' });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.claudeBin, process.execPath, 'surrounding quotes (Explorer paste) must be stripped');
    assert.equal(r.json.claudeBinResolved, process.execPath);
    assert.equal(r.json.claudeBinSource, 'ui-prefs.json (claudeBin)');
    assert.equal(r.json.claudeBinExists, true);
    assert.equal(r.json.restartNeeded, true, 'the running server still holds its require-time path');
    assert.match(String(r.json.claudeBinVersion), /^\d+\.\d+\.\d+$/, 'no version parsed from the probe');

    const st = await req(S.port, 'GET', '/api/state');
    assert.equal(st.json.prefs.claudeBin, process.execPath, 'the field must come back filled after a reload');
  });

  it('other prefs keys survive the write (shared file, one read-modify-write lock)', async () => {
    await req(S.port, 'POST', '/api/prefs', { guardrails: 'never push without an OK' });
    await req(S.port, 'POST', '/api/prefs', { claudeBin: process.execPath });
    const st = await req(S.port, 'GET', '/api/state');
    assert.equal(st.json.prefs.guardrails, 'never push without an OK');
    assert.equal(st.json.prefs.claudeBin, process.execPath);
  });

  it('clearing the field returns to auto-detection instead of leaving a stale override', async () => {
    await req(S.port, 'POST', '/api/prefs', { claudeBin: process.execPath });
    const r = await req(S.port, 'POST', '/api/prefs', { claudeBin: '   ' });
    assert.equal(r.status, 200);
    assert.equal(r.json.claudeBin, '');
    assert.notEqual(r.json.claudeBinSource, 'ui-prefs.json (claudeBin)', 'still reporting the deleted override');
    const st = await req(S.port, 'GET', '/api/state');
    assert.equal(st.json.prefs.claudeBin, '');
  });

  it('a request without claudeBin does not answer with binary fields (no pointless --version spawn)', async () => {
    const r = await req(S.port, 'POST', '/api/prefs', { openPoints: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.claudeBinResolved, undefined);
    assert.equal(r.json.claudeBinVersion, undefined);
  });

  // ---- S3: the other path field on this route, and the one GET that reads it back -----------------
  // Both asked `fs.existsSync` until now. On a path whose SMB host does not answer that call held the
  // single thread serving every request for 43 918 ms (measured 2026-10-03, lib/core.js pathExists), and
  // `defaultCwd` is the worse of the two: it is read on GET /api/state, i.e. on every load of the panel,
  // so a default cwd on a share that is up when it is saved and gone when the laptop is off the VPN froze
  // the panel at boot. The verdicts below are the ones the route always gave — this pins them, because
  // „asynchronous now" must not quietly become „accepts anything now".
  it('defaultCwd: a directory that is not there is refused, naming it; one that is, is stored', async () => {
    const gone = path.join(os.tmpdir(), 'ccui-no-such-default-cwd-' + Date.now());
    const bad = await req(S.port, 'POST', '/api/prefs', { defaultCwd: gone });
    assert.equal(bad.status, 400, bad.body);
    assert.match(bad.json.error, /directory not found/);
    assert.ok(bad.json.error.includes('ccui-no-such-default-cwd'), 'the rejected path has to appear in the message');

    const ok = await req(S.port, 'POST', '/api/prefs', { defaultCwd: dataDir });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(ok.json.defaultCwd, dataDir);
    const st = await req(S.port, 'GET', '/api/state');
    assert.equal(st.json.defaultCwd, dataDir, 'GET /api/state re-checks the stored path and must still hand it back');
  });

  it('defaultCwd: a stored directory that LATER disappears falls back to HOME, it does not break /api/state', async () => {
    // The real-world shape of this: a path on a share, saved while the VPN was up. The fall-back itself is
    // unchanged behaviour — what changed is that the check behind it no longer stops the whole server.
    const tmpCwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-vanishing-cwd-'));
    assert.equal((await req(S.port, 'POST', '/api/prefs', { defaultCwd: tmpCwd })).status, 200);
    await fsp.rm(tmpCwd, { recursive: true, force: true });
    const st = await req(S.port, 'GET', '/api/state');
    assert.equal(st.status, 200, 'the state route must still answer');
    assert.equal(st.json.defaultCwd, os.homedir(), 'a stored cwd that is gone reads back as HOME');
    assert.equal(st.json.prefs.claudeBin !== undefined, true, 'and the rest of the payload is intact');
  });

  it('defaultCwd: a UNC/device-shaped path is judged, not banned — that ban belongs to the two read routes', async () => {
    // Deliberately asymmetric and worth pinning: GET /api/diff and GET /api/files REFUSE a UNC path
    // (resolveCwdParam — they would run git in it / walk it), while this field and startChat must keep
    // working for somebody whose repo really is on a share. So the only question here is "is it there".
    // `\\?\<dir>` is the extended form — same shape, resolved locally, so no test waits on a network.
    const ok = await req(S.port, 'POST', '/api/prefs', { defaultCwd: '\\\\?\\' + dataDir });
    assert.equal(ok.status, 200, 'a shaped path that EXISTS must be accepted, not refused for its shape: ' + ok.body);
    assert.equal(ok.json.defaultCwd, '\\\\?\\' + dataDir);
    const bad = await req(S.port, 'POST', '/api/prefs', { defaultCwd: '\\\\?\\' + path.join(dataDir, 'nope') });
    assert.equal(bad.status, 400, 'and a shaped path that is NOT there is refused for being absent');
    assert.match(bad.json.error, /directory not found/, 'not for its shape');
  });
});
