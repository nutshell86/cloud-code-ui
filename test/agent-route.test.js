'use strict';
// #34 — the two server contracts the subagent feature rests on, against a REAL booted server:
//   GET  /api/agent/output  — hands the browser a subagent's transcript incrementally. It takes a FILE
//                             PATH from the query string, so the refusal cases matter more than the
//                             happy one: this is the only thing between a URL and an arbitrary read.
//   POST /api/prefs         — the global policy is normalised BEFORE it is stored, so ui-prefs.json can
//                             never hold a value that would quietly do nothing at spawn time.
// Hermetic: CLAUDE_UI_DATA_DIR points at a temp dir, so the live ui-prefs.json is untouched.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
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
const getOut = (port, file, offset) => req(port, 'GET', '/api/agent/output?file=' + encodeURIComponent(file) + (offset != null ? '&offset=' + offset : ''));

// A transcript in the place and the format the CLI uses (see lib/agent-output.js).
const rec = (o) => JSON.stringify(Object.assign({ isSidechain: true, agentId: 'atest' }, o)) + '\n';
const TOOL = rec({ type: 'assistant', timestamp: '2026-09-18T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'needle' } }] } });
const TEXT = rec({ type: 'assistant', timestamp: '2026-09-18T10:00:09.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Found it' }] } });

describe('#34 GET /api/agent/output + the global subagent policy', () => {
  let S, dataDir, taskDir, outFile;
  before(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-agent-test-'));
    taskDir = path.join(os.tmpdir(), 'claude', 'ccui-test-' + process.pid, 'sess', 'tasks');
    await fsp.mkdir(taskDir, { recursive: true });
    outFile = path.join(taskDir, 'atest.output');
    await fsp.writeFile(outFile, TOOL);
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, CLAUDE_UI_PORT: String(port), CLAUDE_UI_FAKE_BIN: FAKE, CLAUDE_UI_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitUp(port);
    S = { port, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }) };
  });
  after(async () => {
    if (S) await S.stop();
    if (dataDir) await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    if (taskDir) await fsp.rm(path.join(os.tmpdir(), 'claude', 'ccui-test-' + process.pid), { recursive: true, force: true }).catch(() => {});
  });

  it('reads a transcript and reports where to resume', async () => {
    const r = await getOut(S.port, outFile);
    assert.equal(r.status, 200);
    assert.equal(r.json.events.length, 1);
    assert.equal(r.json.events[0].name, 'Grep');
    assert.equal(r.json.events[0].summary, 'needle');
    assert.equal(r.json.nextOffset, Buffer.byteLength(TOOL, 'utf8'));
    assert.equal(r.json.eof, true);
  });

  it('a second poll from nextOffset delivers only what was appended since', async () => {
    const first = await getOut(S.port, outFile);
    fs.appendFileSync(outFile, TEXT);
    const r = await getOut(S.port, outFile, first.json.nextOffset);
    assert.equal(r.json.events.length, 1, 'the already-seen record must not come a second time');
    assert.equal(r.json.events[0].kind, 'text');
    assert.equal(r.json.events[0].text, 'Found it');
  });

  it('a file that is not there yet is a state, not an error', async () => {
    const r = await getOut(S.port, path.join(taskDir, 'never-written.output'));
    assert.equal(r.status, 200);
    assert.equal(r.json.missing, true);
    assert.deepEqual(r.json.events, []);
  });

  it('an offset past the end restarts from the top instead of reading mid-record', async () => {
    const r = await getOut(S.port, outFile, 10_000_000);
    assert.equal(r.status, 200);
    assert.equal(r.json.restarted, true);
    assert.ok(r.json.events.length >= 1);
  });

  it('refuses any path outside %TEMP%/claude — including traversal out of it', async () => {
    const outside = path.join(os.homedir(), '.claude', 'settings.json');
    assert.equal((await getOut(S.port, outside)).status, 400);
    assert.equal((await getOut(S.port, path.join(taskDir, '..', '..', '..', '..', 'secrets.output'))).status, 400);
    assert.equal((await getOut(S.port, '')).status, 400);
    // right directory, wrong kind of file: the extension is part of the allowlist
    const notOutput = path.join(taskDir, 'notes.txt');
    fs.writeFileSync(notOutput, 'x');
    assert.equal((await getOut(S.port, notOutput)).status, 400);
  });

  it('POST /api/prefs normalises the policy before storing it', async () => {
    const r = await req(S.port, 'POST', '/api/prefs', { subagents: { model: 'gpt-5', maxConcurrent: 999, maxDepth: 0, force: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.subagents, { maxConcurrent: 20 },
      'an unknown model, a 0 ceiling and a force with nothing to force must not survive into the file');
    const state = await req(S.port, 'GET', '/api/state');
    assert.deepEqual(state.json.prefs.subagents, { maxConcurrent: 20 }, '/api/state must report the same policy');
  });

  it('POST /api/prefs keeps a valid policy and can clear it again', async () => {
    let r = await req(S.port, 'POST', '/api/prefs', { subagents: { model: 'sonnet', force: true, maxPerSession: 12 } });
    assert.deepEqual(r.json.subagents, { model: 'sonnet', force: true, maxPerSession: 12 });
    r = await req(S.port, 'POST', '/api/prefs', { subagents: {} });
    assert.deepEqual(r.json.subagents, {}, 'an empty policy must remove the key, not leave the old one standing');
  });

  it('the subagent policy shares its file with the guardrails without clobbering them', async () => {
    await req(S.port, 'POST', '/api/prefs', { guardrails: 'T01 ist Test' });
    await req(S.port, 'POST', '/api/prefs', { subagents: { model: 'haiku' } });
    const state = await req(S.port, 'GET', '/api/state');
    assert.equal(state.json.prefs.guardrails, 'T01 ist Test', 'the read-modify-write lock has to hold for both');
    assert.deepEqual(state.json.prefs.subagents, { model: 'haiku' });
  });

  // PF-1 — a neighbour in the same prefs file, so it rides on this booted server. Default ON, and stored
  // like forwardSubagentText: only an explicit `false` is written, `true` takes the key out again — the file
  // keeps saying nothing about a switch nobody touched, and /api/state answers the same as the POST did.
  it('the plan-progress switch: on by default, only `false` is stored, both routes agree', async () => {
    const stored = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'ui-prefs.json'), 'utf8'));
    let state = await req(S.port, 'GET', '/api/state');
    assert.equal(state.json.prefs.planProgress, true, 'untouched = on');
    let r = await req(S.port, 'POST', '/api/prefs', { planProgress: false });
    assert.equal(r.json.planProgress, false);
    state = await req(S.port, 'GET', '/api/state');
    assert.equal(state.json.prefs.planProgress, false, '/api/state must report what the POST stored');
    assert.equal(stored().planProgress, false);
    r = await req(S.port, 'POST', '/api/prefs', { planProgress: true });
    assert.equal(r.json.planProgress, true);
    assert.ok(!('planProgress' in stored()), 'on again = the key is gone');
    // a POST about something else leaves the switch alone (read-modify-write, like the other switches)
    await req(S.port, 'POST', '/api/prefs', { planProgress: false });
    await req(S.port, 'POST', '/api/prefs', { guardrails: 'x' });
    state = await req(S.port, 'GET', '/api/state');
    assert.equal(state.json.prefs.planProgress, false);
  });
});
