'use strict';
// Regression tests for the MCP update chain.
//
// The bug these pin down: `claude mcp list` is a HEALTH check that connects to every configured
// server before printing anything, so its runtime grows with the server count (measured: 37 s for 9
// servers) and it eventually blew past its own timeout. Four features that only needed the server
// NAMES were built on it and all died together — the per-tile update check answered "check timeout",
// the Update button 404'd for servers that plainly existed, the bulk tool probe saw zero servers and
// the inventory exported nothing. They now read ~/.claude.json instead.
//
// The tests therefore run against a server whose CLI is a bin that answers `mcp list` with NOTHING
// (CLAUDE_UI_CLAUDE_BIN → fake-claude.js prints "No MCP servers configured."), while a fixture
// ~/.claude.json (CLAUDE_UI_CLAUDE_JSON) holds real-shaped servers. Everything that must not depend
// on the health call has to keep working in exactly that situation.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(ROOT, 'fake-claude.js');

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 60000, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* text */ } resolve({ status: res.statusCode, body: d, json }); }); });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout ' + p)); });
    if (data) r.write(data); r.end();
  });
}
async function waitUp(port, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await req(port, 'GET', '/api/state'); if (r.status === 200) return; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('server did not come up on :' + port);
}

// One http server + one stdio server: enough to cover both classification branches without a spawn.
const FIXTURE = {
  mcpServers: {
    'fixture-http': { type: 'http', url: 'https://mcp.example.net/mcp', headers: { 'x-token': 'shhh-not-a-real-secret-value' } },
    'fixture-stdio': { type: 'stdio', command: 'node', args: ['-e', 'process.exit(0)'], env: { FIXTURE_ENV: '1' } },
    'fixture-npm': { type: 'stdio', command: 'cmd', args: ['/c', 'npx', 'some-pkg@latest'], env: {} },
  },
};

describe('MCP: everything that only needs the server NAMES survives a dead `claude mcp list`', () => {
  let S, dir;
  before(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-mcpupd-'));
    const cjPath = path.join(dir, 'claude.json');
    await fsp.writeFile(cjPath, JSON.stringify(FIXTURE, null, 2));
    const dataDir = path.join(dir, 'data'); await fsp.mkdir(dataDir, { recursive: true });
    const claudeDir = path.join(dir, 'claude'); await fsp.mkdir(path.join(claudeDir, 'projects'), { recursive: true });
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        CLAUDE_UI_PORT: String(port),
        CLAUDE_UI_FAKE_BIN: FAKE,
        CLAUDE_UI_CLAUDE_BIN: FAKE,       // `mcp list` / `mcp get` return nothing useful
        CLAUDE_UI_CLAUDE_JSON: cjPath,    // …but the config knows all three servers
        CLAUDE_UI_DATA_DIR: dataDir,
        CLAUDE_UI_CLAUDE_DIR: claudeDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
    await waitUp(port);
    S = { port, log: () => log, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }) };
  });
  after(async () => {
    if (S) await S.stop();
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('the health list really is empty here (the premise of every test below)', async () => {
    const r = await req(S.port, 'GET', '/api/mcp');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.servers, [], 'fake CLI reported servers — premise broken');
  });

  it('/api/mcp/configured lists the configured servers, without env or headers', async () => {
    const r = await req(S.port, 'GET', '/api/mcp/configured');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.servers.map((s) => s.name).sort(), ['fixture-http', 'fixture-npm', 'fixture-stdio']);
    assert.ok(!/shhh-not-a-real-secret-value|FIXTURE_ENV/.test(r.body), 'config leaked env/headers to the client');
  });

  it('per-server update check classifies the transport instead of answering "check timeout"', async () => {
    const http1 = await req(S.port, 'GET', '/api/mcp/check?name=fixture-http');
    assert.equal(http1.status, 200);
    assert.equal(http1.json.update.kind, 'http');
    assert.ok(!/timeout/i.test(http1.json.update.status), 'http check timed out: ' + http1.json.update.status);
    assert.ok(!http1.json.timedOut);
    const stdio = await req(S.port, 'GET', '/api/mcp/check?name=fixture-stdio');
    assert.equal(stdio.json.update.kind, 'local'); // a bare command, no registry and no git checkout
    assert.ok(!/timeout/i.test(stdio.json.update.status), 'stdio check timed out: ' + stdio.json.update.status);
  });

  it('a bad server name is still rejected', async () => {
    assert.equal((await req(S.port, 'GET', '/api/mcp/check?name=bad!name')).status, 400);
    assert.equal((await req(S.port, 'GET', '/api/mcp/get?name=bad!name')).status, 400);
    assert.equal((await req(S.port, 'POST', '/api/mcp/update', { name: 'bad!name' })).status, 400);
  });

  it('the Update button resolves a CONFIGURED server (404 only for one that does not exist)', async () => {
    const unknown = await req(S.port, 'POST', '/api/mcp/update', { name: 'not-configured' });
    assert.equal(unknown.status, 404);
    // a configured, non-git server must be refused for the RIGHT reason — not "server not found"
    const known = await req(S.port, 'POST', '/api/mcp/update', { name: 'fixture-npm' });
    assert.equal(known.status, 400);
    assert.match(known.json.error, /not git-managed/);
  });

  it('?updates=1 falls back to the configured set and flags the missing health', async () => {
    const r = await req(S.port, 'GET', '/api/mcp?updates=1');
    assert.equal(r.status, 200);
    assert.equal(r.json.servers.length, 3, 'update check reported ' + r.json.servers.length + ' servers');
    assert.equal(r.json.healthUnavailable, true);
    for (const s of r.json.servers) {
      assert.ok(s.update && s.update.kind, s.name + ' has no update verdict');
      assert.equal(s.healthUnknown, true, s.name + ' claims a health status it never got');
    }
  });

  it('the inventory export covers every configured server', async () => {
    const r = await req(S.port, 'GET', '/api/mcp/inventory');
    assert.equal(r.status, 200);
    for (const n of ['fixture-http', 'fixture-npm', 'fixture-stdio']) assert.match(r.body, new RegExp('^## ' + n + '$', 'm'));
    assert.ok(!/undefined/.test(r.body), 'inventory contains an undefined field');
  });

  it('the bulk tool probe asks every configured server (no name = all of them)', async () => {
    const r = await req(S.port, 'GET', '/api/mcp/tools');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json.tools).sort(), ['fixture-http', 'fixture-npm', 'fixture-stdio']);
    // http/sse can't be probed over stdio, and that is what it must SAY
    assert.match(r.json.tools['fixture-http'].error, /HTTP|SSE/i);
  });
});

// The config reader itself: argv must survive as an array (a space in an argument used to split it in
// two on the way through a printed string), and dot-only name parts must never resolve to a path.
describe('MCP config reader + plugin skill resolution', () => {
  it('rawConfigFromFile keeps argv intact', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-cfgread-'));
    const cj = path.join(dir, 'claude.json');
    await fsp.writeFile(cj, JSON.stringify({ mcpServers: { s: { type: 'stdio', command: 'node', args: ['C:/Program Files/x/server.js', '--flag'], env: { A: '1' } } } }));
    const prev = process.env.CLAUDE_UI_CLAUDE_JSON;
    process.env.CLAUDE_UI_CLAUDE_JSON = cj;
    delete require.cache[require.resolve('../lib/paths')];
    delete require.cache[require.resolve('../lib/mcp')];
    const mcp = require('../lib/mcp');
    const cfg = await mcp.rawConfigFromFile('s');
    assert.deepEqual(cfg.argv, ['C:/Program Files/x/server.js', '--flag']);
    assert.deepEqual(mcp.cfgArgv(cfg), ['C:/Program Files/x/server.js', '--flag']);
    assert.equal(cfg.env.A, '1');
    assert.equal(await mcp.rawConfigFromFile('nope'), null);
    if (prev === undefined) delete process.env.CLAUDE_UI_CLAUDE_JSON; else process.env.CLAUDE_UI_CLAUDE_JSON = prev;
    delete require.cache[require.resolve('../lib/paths')];
    delete require.cache[require.resolve('../lib/mcp')];
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('pluginSkillPath refuses dot-only name parts', async () => {
    const { pluginSkillPath } = require('../lib/skills');
    for (const bad of ['..:evil', '.:.', '..:..', 'a/b:c', 'plugin:..', ':', 'noskill']) {
      assert.equal(await pluginSkillPath(bad), null, 'accepted ' + bad);
    }
  });
});
