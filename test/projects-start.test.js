'use strict';
// Projekte Stufe 2 — POST /api/chat/start knows the session's project (J1/J2/J3/J11/J12), run against a booted
// server and the fake CLI. Asserted is what the panel STORED (session-projects.json, session-mcp.json) and what it
// ASKED the CLI for (argv via CLAUDE_UI_FAKE_ARGV_LOG) — never what the route believes it did.
// The dead drive is staged by lib/projects.js's test seam: lookups under STALL hang 1.5 s, the deadline is 1 s.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const { makeSandbox } = require('./sandbox');

const ROOT = path.join(__dirname, '..');
const SBX = makeSandbox('projstart', { fakeCli: true });
const ARGV_LOG = path.join(SBX.root, 'argv.log');
const MAP_FILE = path.join(SBX.dataDir, 'session-projects.json');
const SEL_FILE = path.join(SBX.dataDir, 'session-mcp.json');
const SLOW_MARK = path.join(SBX.dataDir, 'slow-mcp-get.mark'); // armed = the next `mcp get` of the fake CLI answers late
const STALL = path.join(SBX.root, 'stall');
const EXTRA = path.join(SBX.root, 'extra');
fs.mkdirSync(EXTRA);
fs.writeFileSync(path.join(SBX.root, 'claude.json'), JSON.stringify({ mcpServers: { alpha: { command: 'node', args: ['alpha.js'] } } }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(40); } return fn(); }
function freePort() { return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
function send(port, method, p, body) {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  let r;
  const done = new Promise((resolve, reject) => {
    r = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch {} resolve({ status: res.statusCode, body: d, json }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  return { done, abort: () => { r.on('error', () => {}); r.destroy(); } };
}
const req = (port, method, p, body) => send(port, method, p, body).done;
function sessionIdOf(port, chatId, timeout = 5000) {
  return new Promise((resolve) => {
    let done = false, buf = '';
    const fin = (v) => { if (done) return; done = true; try { r.destroy(); } catch {} resolve(v); };
    const r = http.get({ host: '127.0.0.1', port, path: '/api/chat/' + chatId + '/stream' }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c; let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const dl = buf.slice(0, i).split('\n').find((l) => l.startsWith('data:')); buf = buf.slice(i + 2);
          try { const ev = dl && JSON.parse(dl.slice(5).trim()); if (ev && ev.type === '_session') fin(ev.session_id); } catch {}
        }
      });
    });
    r.on('error', () => fin(null));
    setTimeout(() => fin(null), timeout);
  });
}
const raw = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const map = () => JSON.parse(raw(MAP_FILE) || '{}');
const chats = () => (raw(ARGV_LOG) || '').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => !a.includes('--help'));
const val = (a, flag) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : null; };
const sysPrompt = (a) => (a.find((x) => x.startsWith('--append-system-prompt=')) || '');
const count = (s, sub) => s.split(sub).length - 1;

let S, P1, P2;
before(async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...SBX.env, CLAUDE_UI_PORT: String(port), FAKE_CLAUDE_SCENARIO: 'echo', CLAUDE_UI_FAKE_ARGV_LOG: ARGV_LOG,
      CLAUDE_UI_TEST_STALL_PREFIX: STALL, CLAUDE_UI_TEST_STALL_MS: '1500', CLAUDE_UI_TEST_PATH_CHECK_MS: '1000',
      FAKE_CLAUDE_MCP_GET_SLOW_FILE: SLOW_MARK, FAKE_CLAUDE_MCP_GET_MS: '1500' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  const t0 = Date.now();
  for (;;) {
    try { if ((await req(port, 'GET', '/api/state')).status === 200) break; } catch { /* not up yet */ }
    if (Date.now() - t0 > 12000) throw new Error('server did not come up:\n' + log);
    await sleep(150);
  }
  S = { port, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }) };
  P1 = (await req(port, 'POST', '/api/projects', { project: { name: 'Demoprojekt', instructions: 'PROJEKT-REGEL-1' } })).json.project;
  P2 = (await req(port, 'POST', '/api/projects', { project: { name: 'Zweites', instructions: 'PROJEKT-REGEL-2' } })).json.project;
  assert.ok(P1 && P2, 'premise: two projects');
});
after(async () => { if (S) await S.stop(); SBX.cleanup(); });
const start = (body) => req(S.port, 'POST', '/api/chat/start', Object.assign({ cwd: ROOT }, body));
const stop = (r) => (r && r.json && r.json.chatId) ? req(S.port, 'POST', '/api/chat/' + r.json.chatId + '/stop', {}) : null;

describe('POST /api/chat/start — the session\'s project (Projekte Stufe 2)', () => {
  it('fresh start with a project: label written before the spawn, answer names it, argv carries the instructions once', async () => {
    const r = await start({ projectId: P1.id, addDirs: [EXTRA] });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(r.json.project, { id: P1.id, updatedAt: P1.updatedAt, name: 'Demoprojekt' });
    assert.ok(r.json.meta, 'meta stays next to it');
    const sid = await sessionIdOf(S.port, r.json.chatId);
    assert.equal(map()[sid], P1.id);
    const a = await waitFor(() => chats().find((x) => val(x, '--session-id') === sid));
    assert.ok(a, 'no argv for the fresh session');
    assert.equal(count(sysPrompt(a), 'PROJEKT-REGEL-1'), 1);
    assert.match(sysPrompt(a), /## Projekt „Demoprojekt“/);
    assert.equal(val(a, '--add-dir'), EXTRA, 'a measured, present --add-dir is passed on');
    await stop(r);
  });

  it('"" is recorded as a decision; no projectId records nothing', async () => {
    const before = Object.keys(map()).length;
    const a = await start({ projectId: '' });
    assert.equal(a.status, 200, a.body);
    assert.equal(a.json.project, null);
    const sa = await sessionIdOf(S.port, a.json.chatId);
    assert.equal(map()[sa], '');
    const b = await start({});
    assert.equal(b.status, 200, b.body);
    assert.equal(Object.keys(map()).length, before + 1, 'a start without projectId wrote a label: ' + JSON.stringify(map()));
    // fake-claude logs its argv asynchronously after the spawn — wait for both lines, or the next test's
    // „nothing spawned" count (chats().length) picks up b's late line (flaky 1 in 4 on main 261d10e).
    const sb = await sessionIdOf(S.port, b.json.chatId);
    assert.ok(await waitFor(() => [sa, sb].every((sid) => chats().some((x) => val(x, '--session-id') === sid))), 'argv lines of a and b missing');
    await stop(a); await stop(b);
  });

  it('400 for an unknown / malformed project and for too many addDirs — nothing written, nothing spawned', async () => {
    const m0 = raw(MAP_FILE), n0 = chats().length;
    for (const [body, code] of [[{ projectId: 'p-deadbeef' }, 'project-unknown'], [{ projectId: 'X' }, 'project-invalid'],
      [{ projectId: P1.id, addDirs: Array.from({ length: 9 }, (_, i) => EXTRA + i) }, 'too-many-adddirs']]) {
      const r = await start(body);
      assert.equal(r.status, 400, r.body);
      assert.equal(r.json.code, code);
    }
    await sleep(300);
    assert.equal(raw(MAP_FILE), m0);
    assert.equal(chats().length, n0);
  });

  it('a plain resume uses the stored label, ignores body.projectId and writes nothing; a fork inherits it next to its MCP scope', async () => {
    const src = crypto.randomUUID();
    assert.equal((await req(S.port, 'POST', '/api/projects/assign', { sessionIds: [src], projectId: P1.id })).status, 200);
    const m0 = raw(MAP_FILE);
    const r = await start({ resume: src, projectId: P2.id });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.project.id, P1.id, 'a resume answers with the session\'s own project');
    const a = await waitFor(() => chats().find((x) => val(x, '--resume') === src && !x.includes('--fork-session')));
    assert.equal(count(sysPrompt(a), 'PROJEKT-REGEL-1'), 1);
    assert.equal(count(sysPrompt(a), 'PROJEKT-REGEL-2'), 0);
    assert.equal(raw(MAP_FILE), m0, 'a resume wrote the map');
    await stop(r);
    // the fork: the NEW id gets the project (sessionIdHook) AND the MCP scope (P-0) — the hooks are composed
    const f = await start({ resume: src, fork: true, mcpServers: ['alpha'] });
    assert.equal(f.status, 200, f.body);
    const neu = await sessionIdOf(S.port, f.json.chatId);
    assert.ok(neu && neu !== src);
    assert.equal(await waitFor(() => map()[neu]), P1.id, 'the fork did not inherit the project');
    assert.deepEqual(await waitFor(() => JSON.parse(raw(SEL_FILE) || '{}')[neu]), ['alpha'], 'the fork lost its MCP scope');
    assert.equal(map()[src], P1.id, 'the source keeps its label');
    await stop(f);
  });

  // rails (b) — the path check is a new await; an owner that attaches, or a page that leaves, DURING it must stop the start
  it('a resume whose owner appears while the path check hangs: 409, no spawn, nothing written', async () => {
    const sid = crypto.randomUUID();
    const sel0 = raw(SEL_FILE), n0 = chats().filter((x) => val(x, '--resume') === sid).length;
    const slow = send(S.port, 'POST', '/api/chat/start', { cwd: ROOT, addDirs: [path.join(STALL, 'a')], resume: sid, mcpServers: ['alpha'] });
    await sleep(250);
    const t0 = Date.now();
    const other = await start({ resume: sid });
    assert.equal(other.status, 200, 'the other window starts at once, the panel is not held: ' + other.body);
    assert.ok(Date.now() - t0 < 900, 'the second start waited on the first one\'s dead drive');
    const r = await slow.done;
    assert.equal(r.status, 409, r.body);
    assert.equal(r.json.code, 'session-open-elsewhere');
    await sleep(300);
    assert.equal(chats().filter((x) => val(x, '--resume') === sid).length, n0 + 1, 'the refused start spawned');
    assert.equal(raw(SEL_FILE), sel0, 'the refused start wrote its MCP selection');
    await stop(other);
  });

  // the MCP selection is written before awaits that can still end in a refusal — a refused start must put it back
  it('a resume refused in the resume loop (owner took it during the MCP lookup): 409, its MCP selection is put back', async () => {
    const sid = crypto.randomUUID();
    const st0 = JSON.parse(raw(SEL_FILE) || '{}'); st0[sid] = ['old-choice']; fs.writeFileSync(SEL_FILE, JSON.stringify(st0));
    fs.writeFileSync(SLOW_MARK, '');
    const slow = send(S.port, 'POST', '/api/chat/start', { cwd: ROOT, resume: sid, mcpServers: ['slowsrv'] });
    await waitFor(() => !fs.existsSync(SLOW_MARK)); // written, and the lookup holds now
    const other = await start({ resume: sid });
    assert.equal(other.status, 200, other.body);
    const r = await slow.done;
    assert.equal(r.status, 409, r.body);
    assert.deepEqual(JSON.parse(raw(SEL_FILE) || '{}')[sid], ['old-choice'], 'the refused start left its MCP selection behind');
    // and without a previous entry, the entry goes again
    const sid2 = crypto.randomUUID();
    fs.writeFileSync(SLOW_MARK, '');
    const slow2 = send(S.port, 'POST', '/api/chat/start', { cwd: ROOT, resume: sid2, mcpServers: ['slowsrv'] });
    await waitFor(() => !fs.existsSync(SLOW_MARK));
    const other2 = await start({ resume: sid2 });
    assert.equal((await slow2.done).status, 409);
    assert.equal(sid2 in JSON.parse(raw(SEL_FILE) || '{}'), false, 'the refused start left a new MCP entry behind');
    await stop(other); await stop(other2);
  });
  // #104 review — the rollback knew its own write only by the VALUE; the other window's identical choice was undone
  it('a refused start does not undo another window\'s write of the SAME selection (write counter)', async () => {
    const sid = crypto.randomUUID();
    const st0 = JSON.parse(raw(SEL_FILE) || '{}'); st0[sid] = ['old-choice']; fs.writeFileSync(SEL_FILE, JSON.stringify(st0));
    fs.writeFileSync(SLOW_MARK, '');
    const slow = send(S.port, 'POST', '/api/chat/start', { cwd: ROOT, resume: sid, mcpServers: ['slowsrv'] });
    await waitFor(() => !fs.existsSync(SLOW_MARK));
    const other = await start({ resume: sid, mcpServers: ['slowsrv'] });
    assert.equal(other.status, 200, other.body);
    assert.equal((await slow.done).status, 409);
    assert.deepEqual(JSON.parse(raw(SEL_FILE) || '{}')[sid], ['slowsrv'], 'the other window\'s selection was rolled back');
    await stop(other);
  });

  it('a fresh start whose page leaves during the path check: no spawn, no label — the file is not even touched', async () => {
    await sleep(1200); // the slot of the stalled lookup above is free again
    const m0 = raw(MAP_FILE), n0 = chats().length;
    const gone = send(S.port, 'POST', '/api/chat/start', { cwd: ROOT, addDirs: [path.join(STALL, 'b')], projectId: P1.id });
    await sleep(150);
    gone.done.catch(() => {}); gone.abort();
    const t0 = Date.now();
    assert.equal((await req(S.port, 'GET', '/api/state')).status, 200);
    assert.ok(Date.now() - t0 < 900, 'the panel was held by the hanging stat');
    await sleep(1500);
    assert.equal(chats().length, n0, 'the start of a gone page spawned');
    assert.equal(raw(MAP_FILE), m0, 'the start of a gone page wrote the map');
  });

  it('a cwd that cannot be measured in time is refused (503 cwd-unchecked), nothing written', async () => {
    await sleep(600);
    const m0 = raw(MAP_FILE), n0 = chats().length;
    const r = await start({ cwd: path.join(STALL, 'c'), projectId: P1.id });
    assert.equal(r.status, 503, r.body);
    assert.equal(r.json.code, 'cwd-unchecked');
    assert.equal(raw(MAP_FILE), m0);
    assert.equal(chats().length, n0);
  });
  // P2 — „Projektwissen": the linked memory files reach the CLI as absolute paths under the project's heading; one
  // deleted after it was linked is not named (the save warned about it, the start does not fail over it)
  it('P2: argv names the linked memory files by absolute path — a file deleted after linking is left out', async () => {
    const memDir = path.join(SBX.claudeDir, 'projects', EXTRA.replace(/[:\\/]/g, '-'), 'memory'); // = lib/core encodeProject
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'wissen.md'), '---\ndescription: Datenmodell\n---\n');
    fs.writeFileSync(path.join(memDir, 'weg.md'), '---\ndescription: geht\n---\n');
    const c = await req(S.port, 'POST', '/api/projects', { project: { name: 'Mit Wissen', cwd: EXTRA, memory: ['wissen.md', 'weg.md'] } });
    assert.equal(c.status, 200, c.body);
    const bad = await req(S.port, 'POST', '/api/projects', { project: { name: 'Tippfehler', cwd: EXTRA, memory: ['gibtsnicht.md'] } });
    assert.equal(bad.status, 400, bad.body);
    assert.deepEqual(bad.json.errors, [{ field: 'memory', code: 'unknown', value: 'gibtsnicht.md' }]);
    fs.unlinkSync(path.join(memDir, 'weg.md'));
    const r = await start({ projectId: c.json.project.id });
    assert.equal(r.status, 200, r.body);
    const sid = await sessionIdOf(S.port, r.json.chatId);
    const a = await waitFor(() => chats().find((x) => val(x, '--session-id') === sid));
    assert.ok(a, 'no argv for the fresh session');
    const sp = sysPrompt(a);
    assert.match(sp, /## Projekt „Mit Wissen“\n### Projektwissen — vor der ersten Antwort lesen/);
    assert.ok(sp.includes('- ' + path.join(memDir, 'wissen.md') + ' — Datenmodell'), sp);
    assert.ok(!sp.includes('weg.md'), 'the deleted file is still named');
    await stop(r);
  });

  // P3 — a UI-skill run in the browser sends `labelProjectId`: the label is recorded like a projectId's (before the
  // spawn, recordFreshStart), and NOTHING else of the project reaches the CLI — no block, no instructions. Before P3
  // the field was ignored (no label at all).
  it('P3: labelProjectId labels the fresh session, the answer names no project, argv has no project block', async () => {
    const r = await start({ labelProjectId: P1.id });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.project, null, 'a label is not a project start');
    const sid = await sessionIdOf(S.port, r.json.chatId);
    assert.equal(map()[sid], P1.id, 'the label was not written');
    const a = await waitFor(() => chats().find((x) => val(x, '--session-id') === sid));
    assert.ok(a, 'no argv for the fresh session');
    assert.doesNotMatch(sysPrompt(a), /## Projekt/);
    assert.ok(!a.join('\n').includes('PROJEKT-REGEL-1'), 'the project instructions reached the CLI');
    await stop(r);
  });
  it('P3: the label follows a NEW id (after /clear) like a projectId — the id hook takes recordPid, not proj.pid', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const hook = src.indexOf('projectsLib.sessionIdHook({ pid: recordPid, resume, sessionId })');
    assert.ok(hook > 0, 'the id hook does not take recordPid — a label is lost at the id after /clear');
    assert.ok(src.indexOf('const recordPid') < hook, 'recordPid is defined after its use');
  });
  it('P3: labelProjectId only on a fresh start without projectId — otherwise 400, nothing written, nothing spawned', async () => {
    const m0 = raw(MAP_FILE), n0 = chats().length;
    for (const [body, code] of [[{ labelProjectId: 'p-deadbeef' }, 'project-unknown'], [{ labelProjectId: 'X' }, 'label-invalid'],
      [{ labelProjectId: P1.id, projectId: P2.id }, 'label-invalid'], [{ labelProjectId: P1.id, resume: crypto.randomUUID() }, 'label-invalid']]) {
      const r = await start(body);
      assert.equal(r.status, 400, JSON.stringify(body) + ': ' + r.body);
      assert.equal(r.json.code, code);
    }
    await sleep(300);
    assert.equal(raw(MAP_FILE), m0);
    assert.equal(chats().length, n0);
  });
});
