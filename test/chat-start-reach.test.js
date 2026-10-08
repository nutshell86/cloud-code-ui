'use strict';
// N12 — a path that does not answer must not reach the spawn, and must not be read synchronously.
//
// Windows resolves a process's cwd inside CreateProcessW, on the event-loop thread: `spawn()` with the cwd
// \\192.0.2.14\share held the whole server for 30 939 ms (measured, docs/ideas.md N12). POST /api/chat/start
// therefore asks the cwd and every --add-dir asynchronously, with a deadline, BEFORE anything is written,
// and answers 504 path-unreachable; a second ask of the same dead host is answered from a negative memory
// without another stat. The configured claude binary is the same question on the read side: GET /api/state
// serves a cache filled asynchronously, and no synchronous fs call may ever touch that path.
//
// No network anywhere: test/fixtures/hang-paths-preload.js makes every path containing `ccui-n12-hang` behave
// like a dead share (async stat never settles) and LOGS every synchronous fs call on such a path — on a real
// dead share each of those would be a ~44 s freeze. The paths use the local Win32 long form `\\?\Q:\…`, so
// even an unpatched lookup costs no network trip.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const { makeSandbox } = require('./sandbox');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'fixtures', 'hang-paths-preload.js');
const PROBE_MS = 400;

function freePort() { return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const t0 = Date.now();
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch {} resolve({ status: res.statusCode, json, ms: Date.now() - t0 }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function boot(label, extraEnv) {
  const sbx = makeSandbox(label, { fakeCli: true });
  const hangLog = path.join(sbx.root, 'sync-hang.log');
  const port = await freePort();
  const child = spawn(process.execPath, ['-r', PRELOAD, 'server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...sbx.env, CLAUDE_UI_PORT: String(port), CLAUDE_UI_PATH_PROBE_MS: String(PROBE_MS), CCUI_TEST_HANG_LOG: hangLog, ...(extraEnv || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume(); child.stderr.resume();
  const t0 = Date.now();
  for (;;) {
    try { const r = await req(port, 'GET', '/api/ping'); if (r.status === 200) break; } catch { /* not up yet */ }
    if (Date.now() - t0 > 15000) throw new Error('server did not come up');
    await new Promise((r) => setTimeout(r, 100));
  }
  const syncHits = () => { try { return fs.readFileSync(hangLog, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const stop = () => new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); });
  return { port, sbx, syncHits, stop };
}

describe('POST /api/chat/start — an unreachable cwd/--add-dir is refused before the spawn (N12)', () => {
  let S;
  before(async () => { S = await boot('reach-start'); });
  after(async () => { if (S) { await S.stop(); S.sbx.cleanup(); } });

  it('a cwd that does not answer → 504 path-unreachable with the reason, after the deadline, no chat', async () => {
    const dead = '\\\\?\\Q:\\ccui-n12-hang\\repo';
    const r = await req(S.port, 'POST', '/api/chat/start', { cwd: dead, mcpServers: [] });
    assert.equal(r.status, 504, 'the old route spawned here (200 + a chat whose process could not start): ' + JSON.stringify(r.json));
    assert.equal(r.json.code, 'path-unreachable');
    assert.equal(r.json.path, dead);
    assert.match(r.json.error, /no answer in \d+ s/);
    assert.ok(!r.json.chatId, 'nothing was started');
    assert.ok(r.ms >= PROBE_MS - 50, 'it waited for the deadline, not for the OS (' + r.ms + ' ms)');
    // refused BEFORE anything is written: the explicit MCP selection of this start was not persisted
    assert.ok(!fs.existsSync(path.join(S.sbx.dataDir, 'session-mcp.json')), 'the refused start wrote its MCP selection');
  });

  it('the next ask on the same dead drive is answered from memory, without waiting again', async () => {
    const r = await req(S.port, 'POST', '/api/chat/start', { cwd: '\\\\?\\Q:\\ccui-n12-hang\\other' });
    assert.equal(r.status, 504);
    assert.equal(r.json.remembered, true, 'a repeated click must not take another threadpool thread');
    assert.ok(r.ms < PROBE_MS, 'answered from the negative memory (' + r.ms + ' ms)');
  });

  it('a dead --add-dir is refused just the same', async () => {
    const r = await req(S.port, 'POST', '/api/chat/start', { addDirs: ['\\\\?\\R:\\ccui-n12-hang\\abap'] });
    assert.equal(r.status, 504);
    assert.equal(r.json.path, '\\\\?\\R:\\ccui-n12-hang\\abap');
  });

  it('a reachable start is not affected', async () => {
    const r = await req(S.port, 'POST', '/api/chat/start', { cwd: S.sbx.root });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.chatId);
    await req(S.port, 'POST', '/api/chat/' + r.json.chatId + '/stop', {}).catch(() => {});
  });

  it('no synchronous fs call ever touched a dead path', () => {
    assert.deepEqual(S.syncHits(), []);
  });
});

describe('the configured claude binary on a dead share (N12, read side)', () => {
  let S;
  const deadBin = '\\\\?\\Q:\\ccui-n12-hang\\claude.exe';
  before(async () => { S = await boot('reach-bin', { CLAUDE_UI_CLAUDE_BIN: deadBin }); });
  after(async () => { if (S) { await S.stop(); S.sbx.cleanup(); } });

  it('GET /api/state answers from the async cache: the binary is reported missing, nothing read it synchronously', async () => {
    const r = await req(S.port, 'GET', '/api/state');
    assert.equal(r.status, 200);
    assert.equal(r.json.claudeExe, deadBin);
    assert.equal(r.json.claudeExeExists, false);
    assert.equal(r.json.claudeBinResolvedExists, false);
    const again = await req(S.port, 'GET', '/api/state');
    assert.equal(again.status, 200);
    // boot (require time + banner) and two /api/state: on a real dead share every line here is a ~44 s freeze
    assert.deepEqual(S.syncHits(), [], 'a synchronous lookup of the configured binary');
  });

  it('a chat start says the binary does not ANSWER, rather than that it is not there', async () => {
    const r = await req(S.port, 'POST', '/api/chat/start', {});
    assert.equal(r.status, 500);
    assert.equal(r.json.code, 'cli-missing');
    assert.equal(r.json.unreachable, true, JSON.stringify(r.json));
    assert.match(r.json.error, /not reachable/);
    assert.deepEqual(S.syncHits(), []);
  });
});
