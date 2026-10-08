'use strict';
// Route contracts for /api/uiskill/schedules — the regression suite for the missing
// `computeNextRun` import (creating an ENABLED schedule used to 500 because server.js called it
// without requiring lib/pure). Boots a throwaway server with CLAUDE_UI_DATA_DIR pointing at a temp
// dir so the live ui-skill-schedules.json is never touched. Plus the router's 400-contracts
// (invalid JSON body, invalid permissionMode) added in the same fix batch.
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
// raw=true sends the body string as-is (for the invalid-JSON contract)
function req(port, method, p, body, raw) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(raw ? String(body) : JSON.stringify(body));
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

describe('/api/uiskill/schedules + router 400-contracts (hermetic data dir)', () => {
  let S, dataDir, argvLog;
  before(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-sched-test-'));
    // FLOW-5 asserts the ARGV a route hands the CLI, so the fake records every invocation it receives.
    argvLog = path.join(dataDir, 'fake-argv.log');
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, CLAUDE_UI_PORT: String(port), CLAUDE_UI_FAKE_BIN: FAKE, CLAUDE_UI_DATA_DIR: dataDir, CLAUDE_UI_FAKE_ARGV_LOG: argvLog },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
    await waitUp(port);
    S = { port, log: () => log, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }) };
  });
  after(async () => {
    if (S) await S.stop();
    if (dataDir) await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('creating an ENABLED schedule computes nextRun (the missing-import regression)', async () => {
    const r = await req(S.port, 'POST', '/api/uiskill/schedules', {
      name: 'zz-test-skill', title: 'Test', enabled: true, timing: { type: 'interval', minutes: 60 },
    });
    assert.equal(r.status, 200, 'create 500s — computeNextRun import broken again? body: ' + r.body);
    assert.ok(r.json.schedule && r.json.schedule.id, 'no schedule returned');
    assert.equal(typeof r.json.schedule.nextRun, 'number', 'enabled schedule has no computed nextRun');
    assert.ok(r.json.schedule.nextRun > Date.now(), 'nextRun not in the future');
  });

  it('disabling clears nextRun; delete removes it from the list', async () => {
    const created = (await req(S.port, 'POST', '/api/uiskill/schedules', { name: 'zz-test-skill', enabled: true, timing: { type: 'interval', minutes: 30 } })).json.schedule;
    const upd = await req(S.port, 'POST', '/api/uiskill/schedules', { id: created.id, name: 'zz-test-skill', enabled: false, timing: { type: 'interval', minutes: 30 } });
    assert.equal(upd.status, 200);
    assert.equal(upd.json.schedule.nextRun, null, 'disabled schedule kept a nextRun');
    await req(S.port, 'POST', '/api/uiskill/schedules/delete', { id: created.id });
    const list = (await req(S.port, 'GET', '/api/uiskill/schedules')).json.schedules;
    assert.ok(!list.some((s) => s.id === created.id), 'deleted schedule still listed');
  });

  // G3 — the schedule's stand-in model. Stored as null for an empty field, because a '' that survives to
  // the spawn becomes `--fallback-model ""`; and it must still be there after an update (the
  // pause/activate button re-POSTs the whole schedule, so a field dropped here would be lost on a click).
  it('a schedule keeps its fallbackModel, and an empty one is stored as null', async () => {
    const created = (await req(S.port, 'POST', '/api/uiskill/schedules', {
      name: 'zz-test-skill', enabled: true, timing: { type: 'interval', minutes: 60 }, fallbackModel: '  sonnet  ',
    })).json.schedule;
    assert.equal(created.fallbackModel, 'sonnet');
    const paused = await req(S.port, 'POST', '/api/uiskill/schedules', Object.assign({}, created, { enabled: false }));
    assert.equal(paused.json.schedule.fallbackModel, 'sonnet', 'pausing a schedule dropped its fallback model');
    for (const v of ['', '   ', null, undefined, false, 0]) {
      const r = await req(S.port, 'POST', '/api/uiskill/schedules', { name: 'zz-test-skill', timing: { type: 'interval', minutes: 60 }, fallbackModel: v });
      assert.equal(r.json.schedule.fallbackModel, null, JSON.stringify(v) + ' must not be stored as a model id');
    }
  });

  // P3 — „Projekt (nur Etikett)": an existing project is stored (and survives a pause), an unknown or malformed one is
  // a 400 at the moment of typing — except when switching OFF, which the route always allows (SCHED-1).
  it('projectId: an existing project is stored and kept on pause; an unknown one is a 400 project-unknown', async () => {
    const proj = (await req(S.port, 'POST', '/api/projects', { project: { name: 'Etikett' } })).json.project;
    assert.ok(proj && proj.id, 'premise: a project');
    const created = (await req(S.port, 'POST', '/api/uiskill/schedules', { name: 'zz-test-skill', enabled: true, timing: { type: 'interval', minutes: 60 }, projectId: proj.id })).json.schedule;
    assert.equal(created.projectId, proj.id, 'the route dropped the label');
    const paused = await req(S.port, 'POST', '/api/uiskill/schedules', Object.assign({}, created, { enabled: false }));
    assert.equal(paused.json.schedule.projectId, proj.id, 'pausing dropped the label');
    for (const bad of ['p-deadbeef', 'X', 5]) {
      const r = await req(S.port, 'POST', '/api/uiskill/schedules', { name: 'zz-test-skill', enabled: true, timing: { type: 'interval', minutes: 60 }, projectId: bad });
      assert.equal(r.status, 400, JSON.stringify(bad) + ': ' + r.body);
      assert.equal(r.json.code, 'project-unknown');
    }
    const off = await req(S.port, 'POST', '/api/uiskill/schedules', Object.assign({}, created, { enabled: false, projectId: 'p-deadbeef' }));
    assert.equal(off.status, 200, 'switching off must stay possible: ' + off.body);
    assert.equal(off.json.schedule.projectId, null);
    const none = (await req(S.port, 'POST', '/api/uiskill/schedules', { name: 'zz-test-skill', timing: { type: 'interval', minutes: 60 } })).json.schedule;
    assert.equal(none.projectId, null);
  });

  // …and a flag-shaped value is refused HERE rather than at the spawn. argIdent does catch it, but that
  // throw happens inside the headless run long after this route answered 200 — leaving a stored schedule
  // that fails every night with nothing in the history to say why. The 400 is the same deal permissionMode
  // already gets, at the moment somebody is looking at the form.
  it('a flag-shaped fallbackModel is a 400 at the route, not a nightly failure', async () => {
    for (const v of ['--dangerously-skip-permissions', '-p', '--fallback-model']) {
      const r = await req(S.port, 'POST', '/api/uiskill/schedules', { name: 'zz-test-skill', timing: { type: 'interval', minutes: 60 }, fallbackModel: v });
      assert.equal(r.status, 400, JSON.stringify(v) + ' was stored instead of refused');
      assert.match(String(r.json && r.json.error), /fallbackModel/);
    }
    // …and a plain model name is of course still accepted
    const ok = await req(S.port, 'POST', '/api/uiskill/schedules', { name: 'zz-test-skill', timing: { type: 'interval', minutes: 60 }, fallbackModel: 'sonnet' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.schedule.fallbackModel, 'sonnet');
  });

  it('manual run of an unknown schedule → 404', async () => {
    const r = await req(S.port, 'POST', '/api/uiskill/schedules/run', { id: 'no-such-id' });
    assert.equal(r.status, 404);
  });

  it('malformed JSON body → 400 (not 500)', async () => {
    const r = await req(S.port, 'POST', '/api/uiskill/schedules', '{ not json', true);
    assert.equal(r.status, 400);
    assert.match(String(r.json && r.json.error), /invalid JSON/i);
  });

  it('invalid permissionMode on /api/chat/start → 400', async () => {
    const r = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, permissionMode: 'yolo' });
    assert.equal(r.status, 400);
    assert.match(String(r.json && r.json.error), /permissionMode/);
  });

  // ---- SEC-5: the MCP selection is BOUNDED -------------------------------------------------------
  // Robustness, not a hole: nothing here escalates anything, every name is looked up in the user's own
  // config, and the file it builds NARROWS the session. What was missing is a bound — for a name
  // ~/.claude.json does not know, buildMcpConfigFile falls back to `claude mcp get <name>`, a spawn with
  // a 25 s timeout, serially. 200 names were ~83 minutes of spawns on one request, and the array was
  // persisted on top.
  it('a name outside the MCP name shape is a 400, not a `claude mcp get` per element', async () => {
    for (const bad of [['a b'], ['../../etc/passwd'], ['ok', 42], ['ok', null], ['x;y'], ['a/b']]) {
      const r = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, mcpServers: bad });
      assert.equal(r.status, 400, JSON.stringify(bad) + ' was accepted');
      assert.match(String(r.json && r.json.error), /mcpServers/);
    }
  });

  // MEASURED while writing this: `__proto__` PASSES `/^[\w.-]+$/` (`\w` covers `_`), and
  // buildMcpConfigFile indexes a plain `{}` with the name — so that assignment sets the prototype and the
  // server disappears from the generated config without a word. The shape test is therefore not the guard
  // it looks like, and the three names are rejected explicitly.
  it('a prototype name is refused even though the shape regex accepts it', async () => {
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
      assert.match(bad, /^[\w.-]+$/, 'premise: the shape alone really does let ' + bad + ' through');
      const r = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, mcpServers: [bad] });
      assert.equal(r.status, 400, bad + ' was accepted');
      assert.match(String(r.json && r.json.error), /mcpServers/);
    }
  });

  it('too many names is a 400 — the ceiling, not an 83-minute request', async () => {
    const many = Array.from({ length: 65 }, (_, i) => 'srv' + i);
    const r = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, mcpServers: many });
    assert.equal(r.status, 400);
    assert.match(String(r.json && r.json.error), /too many mcpServers \(max 64\)/);
    // …and 64 is INSIDE the ceiling. Shown without starting a session: 64 names of which the last is
    // ill-shaped must fail on the SHAPE, which only happens if the length check let it through. Starting
    // 64 unknown servers for real would be 64 `claude mcp get` spawns — the very cost this bound exists
    // for, and it belongs in neither production nor a test suite.
    const edge = Array.from({ length: 63 }, (_, i) => 'srv' + i).concat(['not a name']);
    const r2 = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, mcpServers: edge });
    assert.equal(r2.status, 400);
    assert.match(String(r2.json && r2.json.error), /invalid mcpServers name/, 'the ceiling must be inclusive at 64');
  });

  it('a duplicated name is stored once — the same lookup twice is the cost it was', async () => {
    const r = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, mcpServers: ['dup', 'dup', 'other', 'dup'] });
    assert.equal(r.status, 200, 'start failed: ' + r.body);
    const sel = JSON.parse(await fsp.readFile(path.join(dataDir, 'session-mcp.json'), 'utf8'));
    // keyed by the session id, and earlier tests in this suite leave their own entries behind — so the
    // row is found by content rather than by position
    const stored = Object.values(sel).find((v) => Array.isArray(v) && v.includes('dup'));
    assert.deepEqual(stored, ['dup', 'other'], 'the persisted selection still carries the duplicate');
    await req(S.port, 'POST', '/api/chat/' + r.json.id + '/stop');
  });

  // ---- FLOW-5: the prompt enhancer connects NO MCP server ---------------------------------------
  // `--permission-mode plan` kept the servers from being USED, never from being STARTED. Asserted on the
  // real argv the fake received, because "no tools" was the intent and the argv was the fact.
  it('/api/enhance passes --strict-mcp-config, so a prompt rewrite starts no MCP server', async () => {
    await fsp.writeFile(argvLog, '');
    const r = await req(S.port, 'POST', '/api/enhance', { text: 'mach das besser', cwd: ROOT });
    assert.equal(r.status, 200, 'enhance failed: ' + r.body);
    assert.match(String(r.json && r.json.text), /mach das besser/, 'premise: the fake really served this call');
    const calls = (await fsp.readFile(argvLog, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const oneShot = calls.find((a) => a[0] === '-p' && a.includes('--output-format') && a[a.indexOf('--output-format') + 1] === 'json');
    assert.ok(oneShot, 'the enhance one-shot was not recorded: ' + JSON.stringify(calls));
    assert.ok(oneShot.includes('--strict-mcp-config'), 'the whole MCP set is still started: ' + JSON.stringify(oneShot));
    assert.ok(!oneShot.includes('--mcp-config'), 'strict WITHOUT a config file is what means „zero servers"');
    assert.ok(oneShot.includes('--permission-mode') && oneShot.includes('plan'), 'the old guard must stay too');
  });
});
