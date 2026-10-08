'use strict';
// P-0 — the start path's WRITES, which were wrong for every tab before projects ever come near them:
//   · a fork with an explicit MCP selection stored it under the SOURCE id (the route keys session-mcp.json by
//     `sessionId`, and for `resume` that is the id being resumed — the fork's own id does not exist yet), so
//     duplicating a tab rewrote the scope of the tab it was duplicated from;
//   · a fork WITHOUT a selection stored nothing under its new id, so the fork's first restart (resume = the new
//     id, no stored entry) ran with ALL servers;
//   · a start refused for its permission mode had already written the selection;
//   · deleting a session left its entry in session-mcp.json for good.
// The new id only exists once the CLI reports it, so the route stores the fork's scope through chat.onSessionId
// (lib/chat.js) — set after startChat, without an await in between. What is asserted is what the PANEL asked
// the CLI for (argv via CLAUDE_UI_FAKE_ARGV_LOG, and the --mcp-config file it pointed at) and what it stored,
// never what it believes it did. fake-claude reports a NEW id for --fork-session, as the real CLI does — before
// this change it answered with the source id, which is why none of this was testable.
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
const SBX = makeSandbox('startfork', { fakeCli: true });
// BEFORE lib/chat is required below: lib/paths reads the seams at load time
Object.assign(process.env, SBX.env);
const ARGV_LOG = path.join(SBX.root, 'argv.log');
const SEL_FILE = path.join(SBX.dataDir, 'session-mcp.json');
// three servers the start route can resolve from the file (never through the `claude mcp get` fallback). They
// are never spawned: the fake CLI only receives the path of the generated config.
fs.writeFileSync(path.join(SBX.root, 'claude.json'), JSON.stringify({ mcpServers: {
  alpha: { command: 'node', args: ['alpha.js'] },
  beta: { command: 'node', args: ['beta.js'] },
  gamma: { command: 'node', args: ['gamma.js'] },
} }));

const { startChat, sendToChat, terminateChat } = require('../lib/chat');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(40); } return fn(); }
function freePort() { return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch {} resolve({ status: res.statusCode, body: d, json }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
// the first `_session` frame of a chat = the id the CLI reported for it (the buffer replays from the start)
function sessionIdOf(port, chatId, timeout = 5000) {
  return new Promise((resolve) => {
    let done = false, buf = '';
    const fin = (v) => { if (done) return; done = true; try { r.destroy(); } catch {} resolve(v); };
    const r = http.get({ host: '127.0.0.1', port, path: '/api/chat/' + chatId + '/stream' }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c; let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const dl = block.split('\n').find((l) => l.startsWith('data:'));
          try { const ev = dl && JSON.parse(dl.slice(5).trim()); if (ev && ev.type === '_session') fin(ev.session_id); } catch {}
        }
      });
    });
    r.on('error', () => fin(null));
    setTimeout(() => fin(null), timeout);
  });
}
const store = () => { try { return JSON.parse(fs.readFileSync(SEL_FILE, 'utf8')); } catch { return {}; } };
const argvLines = () => { try { return fs.readFileSync(ARGV_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const val = (a, flag) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : null; };
// the chat invocation that resumed `id` — as a fork or as a plain resume
const argvOf = (id, fork) => waitFor(() => argvLines().filter((a) => val(a, '--resume') === id && a.includes('--fork-session') === !!fork).pop());
// the server names in the --mcp-config the CLI was pointed at; null = no scoping at all = ALL servers.
// Read while the process runs — the file is deleted on its exit.
const mcpNames = (a) => { const f = val(a, '--mcp-config'); return f ? Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers).sort() : null; };

// the one source whose fork speaks with the SOURCE id first (fake-claude FAKE_CLAUDE_FORK_SOURCE_FRAME) — keyed by
// id, so every other fork on this server keeps the plain shape
const SRC_FIRST = crypto.randomUUID();
// every `_session` id a chat reported, in order (the buffer replays from the start), until `until` holds
function sessionIdsOf(port, chatId, until, timeout = 5000) {
  return new Promise((resolve) => {
    let done = false, buf = ''; const ids = [];
    const fin = () => { if (done) return; done = true; try { r.destroy(); } catch {} resolve(ids); };
    const r = http.get({ host: '127.0.0.1', port, path: '/api/chat/' + chatId + '/stream' }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c; let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const dl = block.split('\n').find((l) => l.startsWith('data:'));
          try { const ev = dl && JSON.parse(dl.slice(5).trim()); if (ev && ev.type === '_session') { ids.push(ev.session_id); if (until(ids)) fin(); } } catch {}
        }
      });
    });
    r.on('error', fin);
    setTimeout(fin, timeout);
  });
}

let S;
before(async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...SBX.env, CLAUDE_UI_PORT: String(port), FAKE_CLAUDE_SCENARIO: 'echo', CLAUDE_UI_FAKE_ARGV_LOG: ARGV_LOG, FAKE_CLAUDE_FORK_SOURCE_FRAME: SRC_FIRST },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  const t0 = Date.now();
  for (;;) {
    try { if ((await req(port, 'GET', '/api/state')).status === 200) break; } catch { /* not up yet */ }
    if (Date.now() - t0 > 12000) throw new Error('server did not come up:\n' + log);
    await sleep(150);
  }
  S = { port, log: () => log, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }) };
});
after(async () => { if (S) await S.stop(); SBX.cleanup(); });
const start = (body) => req(S.port, 'POST', '/api/chat/start', Object.assign({ cwd: ROOT }, body));
const stop = (r) => (r && r.json && r.json.chatId) ? req(S.port, 'POST', '/api/chat/' + r.json.chatId + '/stop', {}) : null;

describe('POST /api/chat/start — a fork keeps ITS scope and leaves the source alone (P-0)', () => {
  it('explicit selection on a fork: stored under the NEW id, the source keeps its own', async () => {
    const src = crypto.randomUUID();
    const a = await start({ resume: src, mcpServers: ['alpha', 'beta'] });
    assert.equal(a.status, 200, a.body);
    assert.deepEqual(store()[src], ['alpha', 'beta'], 'premise: a plain resume stores its explicit choice under its id');
    const f = await start({ resume: src, fork: true, mcpServers: ['gamma'] });
    assert.equal(f.status, 200, f.body);
    // the source is checked FIRST: the wrong write happened synchronously, before the 200
    assert.deepEqual(store()[src], ['alpha', 'beta'], 'the fork overwrote the selection of the session it was forked from');
    const neu = await sessionIdOf(S.port, f.json.chatId);
    assert.ok(neu && neu !== src, 'the fork must report a NEW session id (fake-claude --fork-session), got ' + neu);
    assert.deepEqual(mcpNames(await argvOf(src, true)), ['gamma'], 'the fork process runs the chosen set');
    assert.deepEqual(await waitFor(() => store()[neu]), ['gamma'], 'the fork\'s choice is stored under its own id');
    // …which is what its first restart reads: a plain resume of the new id, no body selection
    const re = await start({ resume: neu });
    assert.equal(re.status, 200, re.body);
    assert.deepEqual(mcpNames(await argvOf(neu, false)), ['gamma'], 'the restarted fork runs the set it was forked with');
    for (const r of [a, f, re]) await stop(r);
  });

  it('a fork whose FIRST frame carries the source id: nothing is written under the source, the fork still gets its own', async () => {
    // The lock in storeForkScope (server.js) — `id === resume` → no write — had never run: every fork of the fake
    // started on its new id, and with the lock deleted all of the above stayed green. An explicit choice that
    // differs from the source's is what makes a wrong write VISIBLE: an inherited one would overwrite the source
    // with its own value.
    const a = await start({ resume: SRC_FIRST, mcpServers: ['alpha', 'beta'] });
    assert.equal(a.status, 200, a.body);
    const f = await start({ resume: SRC_FIRST, fork: true, mcpServers: ['gamma'] });
    assert.equal(f.status, 200, f.body);
    const ids = await sessionIdsOf(S.port, f.json.chatId, (l) => l.some((x) => x !== SRC_FIRST));
    assert.equal(ids[0], SRC_FIRST, 'premise: the fork spoke with the source id first (FAKE_CLAUDE_FORK_SOURCE_FRAME), got ' + ids.join(', '));
    const neu = ids.find((x) => x !== SRC_FIRST);
    assert.ok(neu, 'the fork never reported an id of its own: ' + ids.join(', '));
    assert.deepEqual(await waitFor(() => store()[neu]), ['gamma'], 'the fork\'s scope did not reach its own id');
    // both writes go through the same lock in arrival order, so a write under the source has landed by now; the
    // pause only covers a reordering nobody expects
    await sleep(300);
    assert.deepEqual(store()[SRC_FIRST], ['alpha', 'beta'], 'the source-id frame stored the fork\'s scope over the source\'s');
    for (const r of [a, f]) await stop(r);
  });

  it('no selection on a fork: the source\'s stored one carries over to the new id — the restart is not „all servers"', async () => {
    const src = crypto.randomUUID();
    const a = await start({ resume: src, mcpServers: ['beta'] });
    assert.equal(a.status, 200, a.body);
    const f = await start({ resume: src, fork: true });
    assert.equal(f.status, 200, f.body);
    const neu = await sessionIdOf(S.port, f.json.chatId);
    assert.ok(neu && neu !== src, 'new id for the fork, got ' + neu);
    assert.deepEqual(mcpNames(await argvOf(src, true)), ['beta'], 'premise: the fork inherits the stored scope at its start');
    assert.deepEqual(await waitFor(() => store()[neu]), ['beta'], 'nothing was stored under the fork\'s id');
    assert.deepEqual(store()[src], ['beta'], 'the source keeps its entry');
    const re = await start({ resume: neu });
    assert.equal(re.status, 200, re.body);
    assert.deepEqual(mcpNames(await argvOf(neu, false)), ['beta'], 'the fork\'s first restart ran with ALL servers');
    for (const r of [a, f, re]) await stop(r);
  });

  it('a fork that runs every server stores nothing, and an explicit „all" (null) does not delete the source\'s entry', async () => {
    // nothing stored for the source → the fork runs unscoped, and the store gets no entry it would have to carry
    const src = crypto.randomUUID();
    const f = await start({ resume: src, fork: true });
    assert.equal(f.status, 200, f.body);
    const neu = await sessionIdOf(S.port, f.json.chatId);
    assert.ok(neu && neu !== src);
    assert.equal(mcpNames(await argvOf(src, true)), null, 'premise: no --mcp-config = all servers');
    await sleep(500);   // the hook writes without being awaited — give a wrong write the time to land
    assert.equal(Object.prototype.hasOwnProperty.call(store(), neu), false, 'an unscoped fork wrote an entry');
    // the source is scoped, the fork asks for all: `null` is the fork's own choice and must not reach the source
    const src2 = crypto.randomUUID();
    const a = await start({ resume: src2, mcpServers: ['alpha'] });
    const f2 = await start({ resume: src2, fork: true, mcpServers: null });
    assert.equal(f2.status, 200, f2.body);
    assert.deepEqual(store()[src2], ['alpha'], 'the fork\'s explicit „all" deleted the source\'s selection');
    const neu2 = await sessionIdOf(S.port, f2.json.chatId);
    // without it the check below asks hasOwnProperty(store, null) — the key 'null' — and passes on a fork that
    // never reported an id at all
    assert.ok(neu2 && neu2 !== src2, 'the second fork must report a NEW session id, got ' + neu2);
    assert.equal(mcpNames(await argvOf(src2, true)), null, 'the fork runs all servers as asked');
    await sleep(500);
    assert.equal(Object.prototype.hasOwnProperty.call(store(), neu2), false);
    for (const r of [f, a, f2]) await stop(r);
  });
});

describe('POST /api/chat/start — a refused start writes nothing (P-0)', () => {
  it('an invalid permissionMode is a 400 BEFORE the MCP selection is stored', async () => {
    const id = crypto.randomUUID();
    const before = Object.keys(store()).length;
    const r = await start({ resume: id, mcpServers: ['alpha'], permissionMode: 'yolo' });
    assert.equal(r.status, 400, r.body);
    assert.equal(r.json && r.json.error, 'invalid permissionMode');
    assert.equal(Object.prototype.hasOwnProperty.call(store(), id), false, 'a refused start stored its MCP selection');
    // a FRESH start mints its id inside the route — so the only visible trace would be one more key
    const fresh = await start({ mcpServers: ['beta'], permissionMode: 'yolo' });
    assert.equal(fresh.status, 400);
    assert.equal(Object.keys(store()).length, before, 'a refused fresh start stored a selection under a minted id');
  });
});

describe('POST /api/session/delete — the session\'s MCP scope goes with it (P-0)', () => {
  it('removes exactly that entry from session-mcp.json, under the lock, and leaves the others', async () => {
    const id = crypto.randomUUID(), other = crypto.randomUUID();
    const proj = 'C--p0-delete-test';
    fs.mkdirSync(path.join(SBX.claudeDir, 'projects', proj), { recursive: true });
    fs.writeFileSync(path.join(SBX.claudeDir, 'projects', proj, id + '.jsonl'), '{}\n');
    const st = store(); st[id] = ['alpha']; st[other] = ['beta'];
    fs.writeFileSync(SEL_FILE, JSON.stringify(st));
    const r = await req(S.port, 'POST', '/api/session/delete', { project: proj, id });
    assert.equal(r.status, 200, r.body);
    assert.equal(Object.prototype.hasOwnProperty.call(store(), id), false, 'the deleted session\'s MCP scope stayed behind');
    assert.deepEqual(store()[other], ['beta'], 'another session lost its entry');
    // a refused delete (bad params) touches nothing
    const bad = await req(S.port, 'POST', '/api/session/delete', { project: proj, id: other + '/..' });
    assert.equal(bad.status, 400);
    assert.deepEqual(store()[other], ['beta']);
  });

  // CodeQL js/remote-property-injection (high) on #93: the id became a property name of session-mcp.json.
  // It is held to the session-id shape BEFORE any store is touched — the rename route's rule.
  it('refuses an id that is not a session id before touching any store — `__proto__`, `constructor`, a path', async () => {
    const keep = crypto.randomUUID();
    const st = store(); st[keep] = ['alpha'];
    fs.writeFileSync(SEL_FILE, JSON.stringify(st));
    const before = fs.readFileSync(SEL_FILE, 'utf8');
    for (const id of ['__proto__', 'constructor', 'prototype', '../x', '', 42, null]) {
      const r = await req(S.port, 'POST', '/api/session/delete', { project: 'C--p0-delete-test', id });
      assert.equal(r.status, 400, 'id ' + JSON.stringify(id) + ' → ' + r.status + ' ' + r.body);
      assert.match(r.body, /invalid session id/);
    }
    assert.equal(fs.readFileSync(SEL_FILE, 'utf8'), before, 'a refused delete must not rewrite session-mcp.json');
  });
});

describe('lib/chat — chat.onSessionId reports the id the stream carries (P-0)', () => {
  it('fires once per new id with { fork, resume }, and a throwing hook breaks neither the capture nor the _session frame', async () => {
    const src = crypto.randomUUID();
    const c = startChat({ resume: src, fork: true, cwd: ROOT });
    const got = [];
    // set AFTER startChat, as the route does — no frame can have been read yet (readline delivers on a later tick)
    c.onSessionId = (id, info) => { got.push([id, info]); throw new Error('hook failure'); };
    try {
      assert.ok(await waitFor(() => c.sessionId), 'no session id captured');
      await sleep(200);   // init and every later frame carry the same id — exactly one call
      assert.equal(got.length, 1, 'called ' + got.length + ' times');
      assert.equal(got[0][0], c.sessionId);
      assert.notEqual(got[0][0], src, 'a fork reports its OWN id');
      assert.deepEqual(got[0][1], { fork: true, resume: src });
      assert.ok(c.buffer.some((b) => b.frame.includes('"type":"_session"') && b.frame.includes(c.sessionId)), 'the _session frame did not go out');
    } finally { await terminateChat(c, { resume: true }); }
  });

  it('with the REAL timing (FAKE_CLAUDE_LATE_INIT): no id until the first message — then the hook fires once', async () => {
    // The real CLI emits nothing at spawn in -p stream-json (CTX-4), so the window between a fork's start and its
    // first message is where the panel has no id for it (the MCP picker reads the source's via _mcpFrom). The
    // fake sent init at once, and every check of that window ran against a CLI that does not exist.
    const src = crypto.randomUUID();
    process.env.FAKE_CLAUDE_LATE_INIT = '1';
    let c;
    try { c = startChat({ resume: src, fork: true, cwd: ROOT }); } finally { delete process.env.FAKE_CLAUDE_LATE_INIT; }
    const got = [];
    c.onSessionId = (id) => got.push(id);
    try {
      await sleep(700);
      assert.equal(c.sessionId, null, 'a frame arrived before any message — the late-init switch did not hold init back');
      assert.deepEqual(got, []);
      sendToChat(c, 'hallo');
      assert.ok(await waitFor(() => c.sessionId), 'no id after the first message');
      assert.deepEqual(got, [c.sessionId]);
      assert.notEqual(c.sessionId, src);
    } finally { await terminateChat(c, { resume: true }); }
  });
});
