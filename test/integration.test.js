'use strict';
// Integration tests for the chat engine's resume / reconnect / self-heal SERVER contracts, driven against the
// fake stream-json binary (fake-claude.js at the repo ROOT via the CLAUDE_UI_FAKE_BIN seam) — no real model, no cost.
// Each suite boots a throwaway `node server.js` on a free port and tears it down after. Run: `node --test test/`.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

const { makeSandbox } = require('./sandbox');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(ROOT, 'fake-claude.js');
// Every server this file boots runs in the hermetic sandbox — also when the file is run on its own,
// outside verify.js. Suites that bring their own data/claude dirs still spread SBX.env first, so the
// remaining seams (no scheduler, dead CDP port, dummy GHE token, no npm, no real CLI) hold for them too.
const SBX = makeSandbox('itest', { fakeCli: true });
after(() => SBX.cleanup());

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
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
async function startServer(scenario, extraEnv) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, ...SBX.env, CLAUDE_UI_PORT: String(port), CLAUDE_UI_FAKE_BIN: FAKE, FAKE_CLAUDE_SCENARIO: scenario || 'echo', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  await waitUp(port);
  return { port, log: () => log, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }) };
}
// Open an SSE stream and collect {id, ev} frames until `until(frames)` is true or `timeout` ms elapse.
// `lastEventId` = the header a browser sends on its OWN reconnect; `from` = the query param a client uses
// when it closed the stream itself (EventSource cannot set headers).
function collectSSE(port, chatId, { until, timeout = 2500, lastEventId, from } = {}) {
  return new Promise((resolve) => {
    const frames = []; let done = false;
    const fin = () => { if (done) return; done = true; try { r.destroy(); } catch {} resolve(frames); };
    const url = `/api/chat/${chatId}/stream` + (from ? `?from=${from}` : '');   // not `path` — that's node:path here
    const r = http.get({ host: '127.0.0.1', port, path: url, headers: lastEventId ? { 'Last-Event-ID': String(lastEventId) } : {} }, (res) => {
      res.setEncoding('utf8'); let buf = '';
      res.on('data', (c) => {
        buf += c; let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const idL = block.split('\n').find((l) => l.startsWith('id:'));
          const dL = block.split('\n').find((l) => l.startsWith('data:'));
          if (!dL) continue;
          try { const ev = JSON.parse(dL.slice(5).trim()); frames.push({ id: idL ? parseInt(idL.slice(3).trim(), 10) : null, ev }); if (until && until(frames)) fin(); } catch {}
        }
      });
    });
    r.on('error', () => fin());
    setTimeout(fin, timeout);
  });
}

describe('chat engine — resume/reconnect/self-heal contracts (fake stream-json)', () => {
  let S;
  before(async () => { S = await startServer('echo'); });
  after(async () => { if (S) await S.stop(); });

  it('start → send → emits _session, assistant "OK", and a result', async () => {
    const start = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, permissionMode: 'plan' });
    assert.equal(start.status, 200);
    const chatId = start.json.chatId; assert.ok(chatId, 'no chatId');
    const framesP = collectSSE(S.port, chatId, { until: (f) => f.some((x) => x.ev.type === 'result'), timeout: 4000 });
    await new Promise((r) => setTimeout(r, 300));
    const send = await req(S.port, 'POST', `/api/chat/${chatId}/send`, { text: 'hi' });
    assert.equal(send.status, 200);
    const types = (await framesP).map((f) => f.ev.type);
    assert.ok(types.includes('_session'), 'no _session frame');
    assert.ok(types.includes('assistant'), 'no assistant frame');
    assert.ok(types.includes('result'), 'no result frame');
  });

  it('self-heal contract: bogus id and a stopped chat both → 404 "chat not found"', async () => {
    // the client self-heal resumes on either 404 "chat not found" (chat gone from the map) or 409
    // "process not running" (chat lingering but dead). Both are exercised: 404 here, 409 in the crash suite.
    const bogus = await req(S.port, 'POST', '/api/chat/00000000-0000-0000-0000-000000000000/send', { text: 'x' });
    assert.equal(bogus.status, 404);
    assert.equal(bogus.json.error, 'chat not found');
    const start = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT });
    const id = start.json.chatId;
    await req(S.port, 'POST', `/api/chat/${id}/stop`); // /stop removes the chat from the map
    await new Promise((r) => setTimeout(r, 300));
    const send = await req(S.port, 'POST', `/api/chat/${id}/send`, { text: 'x' });
    assert.equal(send.status, 404);
    assert.equal(send.json.error, 'chat not found');
  });

  // Regression (2026-09-02): POST /model wrote the control request to stdin and answered 200 without
  // waiting, so a model the CLI REFUSES (unknown, or restricted by the organisation) produced a green
  // "switched live" toast over a session that kept running the old model. The route waits for the
  // control_response now and hands the refusal — in the CLI's own words — back as a 409.
  it('a refused set_model answers 409 with the CLI reason; an accepted one answers 200', async () => {
    const s = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT });
    const id = s.json.chatId;
    await new Promise((r) => setTimeout(r, 300));
    const bad = await req(S.port, 'POST', `/api/chat/${id}/model`, { model: 'claude-restricted-9' });
    assert.equal(bad.status, 409, 'a refused model must not report success');
    assert.match(String(bad.json.error), /restricted by your organization/i, 'the CLI wording must survive');
    const ok = await req(S.port, 'POST', `/api/chat/${id}/model`, { model: 'fable[1m]' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
  });

  it('resuming a session kills the still-alive duplicate process', async () => {
    const s1 = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT });
    const id1 = s1.json.chatId;
    const f = await collectSSE(S.port, id1, { until: (x) => x.some((y) => y.ev.type === '_session'), timeout: 3000 });
    const sess = (f.find((x) => x.ev.type === '_session') || {}).ev.session_id;
    assert.ok(sess, 'no session id captured');
    const s2 = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, resume: sess });
    const id2 = s2.json.chatId;
    assert.notEqual(id1, id2, 'resume reused the chatId');
    await new Promise((r) => setTimeout(r, 300));
    const old = await req(S.port, 'POST', `/api/chat/${id1}/send`, { text: 'x' });
    assert.equal(old.status, 404, 'the old duplicate process was not killed/removed');
  });

  it('SSE Last-Event-ID replays only newer frames', async () => {
    const s = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT });
    const id = s.json.chatId;
    const first = await collectSSE(S.port, id, { until: (x) => x.some((y) => y.ev.type === 'system'), timeout: 2500 });
    const lastId = Math.max(0, ...first.map((x) => x.id || 0));
    assert.ok(lastId > 0, 'no id on the initial frames');
    await req(S.port, 'POST', `/api/chat/${id}/send`, { text: 'hi' });
    await new Promise((r) => setTimeout(r, 400));
    const replay = await collectSSE(S.port, id, { until: (x) => x.some((y) => y.ev.type === 'result'), timeout: 3000, lastEventId: lastId });
    assert.ok(replay.length > 0, 'nothing replayed');
    assert.ok(replay.every((x) => x.id > lastId), 'replayed a frame at or below Last-Event-ID');
    assert.ok(replay.some((x) => x.ev.type === 'result'), 'no new result after reconnect');
  });

  // The UI-skills runner closes its own stream when a run finishes and re-opens it for a follow-up turn.
  // EventSource cannot send Last-Event-ID in that case, so without `?from=` the finished turn was replayed
  // into the live handler — and its stale `result` frame closed the follow-up before the CLI had done
  // anything (the approval went out, the card said "fertig", the work then hung invisibly).
  it('SSE ?from=<seq> replays only newer frames (a client that closed the stream itself)', async () => {
    const s = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT });
    const id = s.json.chatId;
    const collecting = collectSSE(S.port, id, { until: (x) => x.some((y) => y.ev.type === 'result'), timeout: 4000 });
    await new Promise((r) => setTimeout(r, 200));
    await req(S.port, 'POST', `/api/chat/${id}/send`, { text: 'erste Runde' });
    const first = await collecting;                      // …and now the client closes its own stream (= the run finished)
    const seen = Math.max(0, ...first.map((x) => x.id || 0));
    assert.ok(seen > 0, 'no id on the first turn');
    assert.ok(first.some((x) => x.ev.type === 'result'), 'no result on the first turn to go stale');
    // the follow-up: re-attach with what we have seen, THEN send — the stream must carry the new turn only
    const reattached = collectSSE(S.port, id, { until: (x) => x.some((y) => y.ev.type === 'result'), timeout: 4000, from: seen });
    await new Promise((r) => setTimeout(r, 200));
    await req(S.port, 'POST', `/api/chat/${id}/send`, { text: 'Folgeschritt' });
    const next = await reattached;
    assert.ok(next.some((x) => x.ev.type === 'result'), 'no result for the follow-up turn');
    assert.ok(next.every((x) => x.id > seen), 'replayed a frame at or below ?from=');
    // frames carry the seq the client filters on (uiRunHandle drops anything <= run.lastSeq)
    assert.ok(next.every((x) => x.ev._seq === x.id), '_seq and the SSE id disagree');
  });
});

describe('chat engine — a crashing CLI surfaces an _exit frame', () => {
  it('crash scenario → _exit frame, then send → 409 "process not running"', async () => {
    const S = await startServer('crash');
    try {
      const s = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT });
      const id = s.json.chatId;
      const f = await collectSSE(S.port, id, { until: (x) => x.some((y) => y.ev.type === '_exit'), timeout: 4000 });
      assert.ok(f.some((x) => x.ev.type === '_exit'), 'no _exit frame after crash');
      // the crashed chat lingers in the map (dead-grace window) → a send hits the 409 self-heal branch
      const send = await req(S.port, 'POST', `/api/chat/${id}/send`, { text: 'x' });
      assert.equal(send.status, 409);
      assert.equal(send.json.error, 'process not running');
    } finally { await S.stop(); }
  });
});

// #1/#17: two processes appending to one transcript JSONL corrupt it. The client's "stop, then resume"
// (a model/mode switch that needs a respawn) sent the resume while the stopped process was still in its
// EOF grace: the route spawned the new writer next to the old one. Here fake-claude IGNORES stdin EOF
// (FAKE_CLAUDE_IGNORE_EOF — the CLI stuck on an MCP server), so only the kill ends it, and the init
// frame carries its pid to look at.
describe('chat engine — a resume waits until the old writer of the transcript is gone (#1/#17)', () => {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  it('stop (graceful, not awaited) → start {resume}: the old process is dead when the 200 arrives', async () => {
    const S = await startServer('echo', { FAKE_CLAUDE_IGNORE_EOF: '1' });
    const pids = [];
    try {
      const s1 = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT });
      const id1 = s1.json.chatId;
      const isInit = (y) => y.ev.type === 'system' && y.ev.subtype === 'init';
      const f = await collectSSE(S.port, id1, { until: (x) => x.some(isInit), timeout: 5000 });
      const init = (f.find(isInit) || {}).ev || {};
      assert.ok(init.session_id && init.pid, 'init frame with session id + pid');
      pids.push(init.pid);
      assert.equal((await req(S.port, 'POST', `/api/chat/${id1}/stop`)).status, 200);
      assert.ok(alive(init.pid), 'premise: the stop answered while the process still runs (EOF ignored, grace pending)');
      const t0 = Date.now();
      const s2 = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, resume: init.session_id });
      const took = Date.now() - t0;
      assert.equal(s2.status, 200, s2.body);
      assert.equal(alive(init.pid), false, 'the old writer was gone before the resume spawned (' + took + ' ms)');
      // bounded by the tree kill (killTree's 5 s cap + the 1 s exit wait), far from a hang
      assert.ok(took < 5000 + 1000 + 3000, 'took ' + took + ' ms');
    } finally {
      await S.stop();
      for (const pid of pids) { if (alive(pid)) { try { process.kill(pid); } catch { /* */ } } }
    }
  });

  // …but a FORK is not that case: `--fork-session` opens its own transcript, so there is no second
  // writer to wait for. Waiting would end the source process — i.e. "Duplizieren" would kill the tab it
  // was duplicating (forkTab keeps it open next to the fork) — and hold the UI for a taskkill.
  it('fork of a LIVE session: the source keeps running and the answer waits for no kill', async () => {
    const S = await startServer('echo', { FAKE_CLAUDE_IGNORE_EOF: '1' });
    const pids = [];
    try {
      const s1 = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT });
      const isInit = (y) => y.ev.type === 'system' && y.ev.subtype === 'init';
      const f1 = await collectSSE(S.port, s1.json.chatId, { until: (x) => x.some(isInit), timeout: 5000 });
      const init = (f1.find(isInit) || {}).ev || {};
      assert.ok(init.session_id && init.pid, 'init frame with session id + pid');
      pids.push(init.pid);
      const t0 = Date.now();
      const s2 = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, resume: init.session_id, fork: true });
      const took = Date.now() - t0;
      assert.equal(s2.status, 200, s2.body);
      assert.ok(alive(init.pid), 'the forked-from process is still running (' + took + ' ms)');
      assert.ok(took < 5000, 'and the fork did not wait out a taskkill (' + took + ' ms)');
      const f2 = await collectSSE(S.port, s2.json.chatId, { until: (x) => x.some(isInit), timeout: 5000 });
      pids.push(((f2.find(isInit) || {}).ev || {}).pid);
      assert.ok(alive(init.pid), 'and it survived the fork actually starting');
    } finally {
      await S.stop();
      for (const pid of pids) { if (pid && alive(pid)) { try { process.kill(pid); } catch { /* */ } } }
    }
  });
});

// CHAT-FLOW-4 — two panel windows (or two tabs, two origins, two browsers) on ONE session used to kill
// each other's process on every resume: the route ended whatever ran under that session, whether a browser
// was still reading its stream or not, and the loser got no word of it — it took the end of its stream for a
// reaped chat and resumed straight back. The server now decides who owns a session: the process a browser
// stream is attached to. A resume of it is refused (409 session-open-elsewhere) unless the caller asks for
// the takeover, and then the old owner is TOLD before its stream ends (`_superseded`).
describe('chat engine — a session a browser is attached to belongs to that browser (CHAT-FLOW-4)', () => {
  let S;
  before(async () => { S = await startServer('echo'); });
  after(async () => { if (S) await S.stop(); });
  const selFile = () => path.join(SBX.dataDir, 'session-mcp.json');
  const readSel = () => { try { return fs.readFileSync(selFile(), 'utf8'); } catch { return null; } };

  it('a resume while another stream is attached → 409 with code + busy, nothing written, the owner keeps running; takeover → the owner hears `_superseded`', async () => {
    const sid = crypto.randomUUID();
    const s1 = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, resume: sid });
    assert.equal(s1.status, 200, s1.body);
    const id1 = s1.json.chatId;
    // the owner's stream stays OPEN for the whole test — it is what makes chat 1 the owner
    const owner = collectSSE(S.port, id1, { until: (f) => f.some((x) => x.ev.type === '_superseded'), timeout: 9000 });
    await new Promise((r) => setTimeout(r, 300));
    const selBefore = readSel();
    // with explicit mcpServers: a refused resume must not rewrite the MCP scope of a session another window runs
    const r = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, resume: sid, mcpServers: ['some-server'] });
    assert.equal(r.status, 409, r.body);
    assert.equal(r.json.code, 'session-open-elsewhere');
    assert.equal(r.json.busy, false, 'no message went in, so no turn is open there');
    assert.equal(r.json.starting, false, 'a browser IS attached — this is not the claim window');
    assert.equal(readSel(), selBefore, 'session-mcp.json was written for a refused start');
    // the read-only probe answers from the same rule
    const probe = await req(S.port, 'GET', '/api/session/open?id=' + sid);
    assert.equal(probe.status, 200, probe.body);
    assert.deepEqual(probe.json, { open: true, busy: false, starting: false });
    assert.equal((await req(S.port, 'GET', '/api/session/open?id=nope')).status, 400, 'an id that is not a session UUID');
    assert.equal((await req(S.port, 'POST', `/api/chat/${id1}/send`, { text: 'noch da?' })).status, 200, 'the owner was not killed');
    // …and the takeover the user asked for
    const t = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, resume: sid, takeover: true });
    assert.equal(t.status, 200, t.body);
    const frames = await owner;
    assert.ok(frames.some((x) => x.ev.type === '_superseded'), 'the owner was ended without a word: ' + frames.map((x) => x.ev.type).join(','));
    await new Promise((r2) => setTimeout(r2, 200));
    assert.equal((await req(S.port, 'POST', `/api/chat/${id1}/send`, { text: 'x' })).status, 404, 'the old owner is gone after the takeover');
    assert.deepEqual((await req(S.port, 'GET', '/api/session/open?id=' + sid)).json.open, true, 'the new process owns it now (claim window, no stream yet)');
    await req(S.port, 'POST', `/api/chat/${t.json.chatId}/stop`);
  });

  // „Duplizieren" (forkTab) forks a tab whose stream is OPEN by definition — and the Sitzungsliste forks sessions
  // another window has open. A fork writes its own transcript and ends nobody, so the owner rule must not apply to
  // it: neither the pre-check (500 ms settle wait, then a 409 and a „woanders offen" card) nor the loop. The
  // existing fork test closes the source's stream first, and two-windows forks against the stand-in — this is the
  // one that holds the exemption against the real route with the source ATTACHED.
  it('a FORK of a session another stream is attached to is never refused: 200, the source keeps its stream, takes sends, and hears no `_superseded`', async () => {
    const sid = crypto.randomUUID();
    const s1 = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, resume: sid });
    assert.equal(s1.status, 200, s1.body);
    const id1 = s1.json.chatId;
    const source = collectSSE(S.port, id1, { until: (f) => f.some((x) => x.ev.type === '_superseded'), timeout: 2000 });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await req(S.port, 'GET', '/api/session/open?id=' + sid)).json.open, true, 'premise: the source is attached and holds the session');
    const fk = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, resume: sid, fork: true });
    assert.equal(fk.status, 200, 'the fork of an attached session was refused: ' + fk.body);
    assert.equal((await req(S.port, 'POST', `/api/chat/${id1}/send`, { text: 'noch da?' })).status, 200, 'the fork ended its source');
    const frames = await source;
    assert.ok(!frames.some((x) => x.ev.type === '_superseded'), 'the source was told it was taken over by its own fork');
    await req(S.port, 'POST', `/api/chat/${fk.json.chatId}/stop`);
    await req(S.port, 'POST', `/api/chat/${id1}/stop`);
  });

  it('claim window: a resume right after a fresh start whose stream is not attached yet is refused (starting:true), not killed', async () => {
    const sid = crypto.randomUUID();
    const s1 = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, resume: sid });
    assert.equal(s1.status, 200, s1.body);
    // no EventSource yet — the window between a POST /start and its stream, in which two windows that boot at the
    // same time (two start.cmd, both after a server restart) used to kill each other silently
    const s2 = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, resume: sid });
    assert.equal(s2.status, 409, 'the second resume killed a process nobody had attached to yet: ' + s2.body);
    assert.equal(s2.json.code, 'session-open-elsewhere');
    assert.equal(s2.json.starting, true);
    assert.equal((await req(S.port, 'POST', `/api/chat/${s1.json.chatId}/send`, { text: 'x' })).status, 200, 'the first one still runs');
    await req(S.port, 'POST', `/api/chat/${s1.json.chatId}/stop`);
  });
});

// …and the owner question is asked AGAIN in the resume loop, in the same tick as the kill. Two resumes of one
// session that both pass the first check while the route still waits (here: on the --help probe, held 3 s by
// FAKE_CLAUDE_HELP_MS — two windows booting right after a server restart meet exactly this) are released
// together: the first spawns, and the second must find that process and be refused — not end it.
describe('chat engine — two resumes released by the same await (CHAT-FLOW-4)', () => {
  it('the second one is refused with 409, the first one keeps running', async () => {
    const S = await startServer('echo', { FAKE_CLAUDE_HELP_MS: '3000' });
    try {
      const st = await req(S.port, 'GET', '/api/state');
      assert.equal(st.json.promptSnapshotFlag, null, 'premise: the --help probe is still running — the window this test needs');
      const sid = crypto.randomUUID();
      const [a, b] = await Promise.all([1, 2].map(() => req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, resume: sid })));
      assert.deepEqual([a.status, b.status].sort(), [200, 409], 'both went through — the second ended the first: ' + a.body + ' / ' + b.body);
      const won = a.status === 200 ? a : b, lost = a.status === 200 ? b : a;
      assert.equal(lost.json.code, 'session-open-elsewhere');
      assert.equal((await req(S.port, 'POST', `/api/chat/${won.json.chatId}/send`, { text: 'x' })).status, 200, 'the winner was killed after all');
      await req(S.port, 'POST', `/api/chat/${won.json.chatId}/stop`);
    } finally { await S.stop(); }
  });
});

// Review of PR-15a — a RELOAD while the tab's own restart (stop → start {resume}) is still inside the route. The old
// page's start waits in the resume loop for the taskkill (~3 s for an MCP-heavy CLI; FAKE_CLAUDE_IGNORE_EOF makes
// the kill the only way out here), the page is gone meanwhile, and the reloaded page resumes the same session at
// once. Before the fix the old start spawned its process anyway — for nobody: no browser would ever attach, and its
// claim window then refused the reloaded page (409 starting:true), while the orphan ran until the 30-min reaper.
// On main (no owner rule) the reload was seamless; this pins that it still is. Counted at the process level
// (FAKE_CLAUDE_ARGV_OUT: one line per spawned chat), so „no orphan" is measured, not inferred from the answer.
describe('chat engine — a start whose browser is gone spawns nothing (CHAT-FLOW-4, review)', () => {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const isInit = (y) => y.ev.type === 'system' && y.ev.subtype === 'init';
  it('reload during the own restart: the old page\'s resume spawns no orphan, the reloaded page\'s resume gets 200', async () => {
    const argvOut = path.join(SBX.root, 'argv-reload-' + crypto.randomUUID() + '.jsonl');
    const S = await startServer('echo', { FAKE_CLAUDE_IGNORE_EOF: '1', FAKE_CLAUDE_ARGV_OUT: argvOut });
    const pids = [];
    try {
      const s1 = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT });
      const f = await collectSSE(S.port, s1.json.chatId, { until: (x) => x.some(isInit), timeout: 5000 });
      const init = (f.find(isInit) || {}).ev || {};
      assert.ok(init.session_id && init.pid, 'init frame with session id + pid');
      pids.push(init.pid);
      const sid = init.session_id;
      // the tab's own restart: the stop answers at once, the process lives on (EOF ignored) …
      assert.equal((await req(S.port, 'POST', `/api/chat/${s1.json.chatId}/stop`)).status, 200);
      // … and its start {resume} is still waiting for the kill when the page reloads (the socket goes)
      const data = Buffer.from(JSON.stringify({ cwd: ROOT, resume: sid }));
      const r1 = http.request({ host: '127.0.0.1', port: S.port, path: '/api/chat/start', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } });
      r1.on('error', () => {}); r1.write(data); r1.end();
      await new Promise((r) => setTimeout(r, 30));
      r1.destroy();
      // the reloaded page resumes the same session right away (restoreTabs → activateTab → resumeDormant)
      const r2 = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, resume: sid });
      assert.equal(r2.status, 200, 'the reloaded page was refused by the start of the page it replaced: ' + r2.body);
      assert.equal((await req(S.port, 'POST', `/api/chat/${r2.json.chatId}/send`, { text: 'x' })).status, 200, 'the reloaded page\'s process runs');
      // its init proves the process is up — fake-claude writes its argv line first thing, before it answers anything.
      // Counted only then, plus a margin for an orphan spawned BEFORE it: under the parallel load of verify.js a node
      // child can take longer than a fixed 300 ms to start (measured 2026-10-05: 0 lines at 300 ms in one run).
      const f2 = await collectSSE(S.port, r2.json.chatId, { until: (x) => x.some(isInit), timeout: 8000 });
      pids.push(((f2.find(isInit) || {}).ev || {}).pid);
      assert.ok(f2.some(isInit), 'premise: the reloaded page\'s process came up');
      await new Promise((r) => setTimeout(r, 1500));
      const spawned = fs.readFileSync(argvOut, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        .filter((a) => a[a.indexOf('--resume') + 1] === sid);
      assert.equal(spawned.length, 1, 'the gone page\'s start spawned a process nobody will attach to (' + spawned.length + ' resumes of the session)');
      // the refusal's answer went to a closed socket — that must be silent, not a crash in the server log
      assert.doesNotMatch(S.log(), /uncaughtException|unhandledRejection|\[route\]/, S.log());
    } finally {
      await S.stop();
      for (const pid of pids) { if (pid && alive(pid)) { try { process.kill(pid); } catch { /* */ } } }
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// The two session stores (session-names.json, session-mcp.json) are keyed by an id that arrives in the
// REQUEST BODY — the id IS the property name the route writes (js/remote-property-injection, alerts
// #51/#52/#54/#55). These tests pin the barrier at the routes: only a session UUID may name a key, and
// a rejected request writes nothing at all.
// ---------------------------------------------------------------------------------------------------
const PROTO_KEYS = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty'];
// own keys of a JSON store file; [] when the file was never written
const storeKeys = (f) => { try { return Object.keys(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { return []; } };

describe('session stores — the request cannot choose the property name that gets written', () => {
  let S, dataDir, claudeDir;
  before(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-keys-data-'));
    claudeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-keys-claude-'));
    await fsp.mkdir(path.join(claudeDir, 'projects'), { recursive: true });
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, ...SBX.env, CLAUDE_UI_PORT: String(port), CLAUDE_UI_FAKE_BIN: FAKE, CLAUDE_UI_CLAUDE_BIN: FAKE, CLAUDE_UI_DATA_DIR: dataDir, CLAUDE_UI_CLAUDE_DIR: claudeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
    await waitUp(port);
    S = { port, log: () => log, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }) };
  });
  after(async () => {
    if (S) await S.stop();
    for (const d of [dataDir, claudeDir]) if (d) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
  });

  it('rename: a prototype-ish id is a 400 and leaves session-names.json untouched', async () => {
    const namesFile = path.join(dataDir, 'session-names.json');
    for (const bad of [...PROTO_KEYS, 'not-a-uuid', '../../session-names', '']) {
      const r = await req(S.port, 'POST', '/api/session/rename', { id: bad, name: 'pwned' });
      assert.equal(r.status, 400, JSON.stringify(bad) + ' was accepted as a session id');
      assert.match(String(r.json && r.json.error), /id/i);
      assert.deepEqual(storeKeys(namesFile), [], 'nothing may be written for ' + JSON.stringify(bad));
    }
    // the real thing still works — and the store holds exactly that one key
    const id = crypto.randomUUID();
    const ok = await req(S.port, 'POST', '/api/session/rename', { id, name: 'Mein Chat' });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(ok.json.name, 'Mein Chat');
    assert.deepEqual(storeKeys(namesFile), [id]);
    // and it can be cleared again (empty name = delete), which must not resurrect anything else
    const cleared = await req(S.port, 'POST', '/api/session/rename', { id, name: '' });
    assert.equal(cleared.status, 200);
    assert.deepEqual(storeKeys(namesFile), []);
  });

  it('chat/start: a prototype-ish resume id is a 400 and writes no MCP-scope entry', async () => {
    const selFile = path.join(dataDir, 'session-mcp.json');
    for (const bad of [...PROTO_KEYS, 'not-a-uuid', '00000000-0000-0000-0000-00000000000']) {
      const r = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, resume: bad, mcpServers: ['some-server'] });
      assert.equal(r.status, 400, JSON.stringify(bad) + ' was accepted as a resume id');
      assert.equal(r.json && r.json.error, 'invalid resume id');
      assert.deepEqual(storeKeys(selFile), [], 'nothing may be written for ' + JSON.stringify(bad));
    }
    // a well-formed resume id is still accepted and scopes that session (chatId proves the spawn)
    const id = crypto.randomUUID();
    const ok = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, resume: id, mcpServers: ['some-server'] });
    assert.equal(ok.status, 200, ok.body);
    assert.ok(ok.json.chatId, 'no chat started');
    assert.deepEqual(storeKeys(selFile), [id]);
    const stored = await req(S.port, 'GET', '/api/session/mcp?id=' + id);
    assert.deepEqual(stored.json.selection, ['some-server']);
    await req(S.port, 'POST', `/api/chat/${ok.json.chatId}/stop`, {});
  });
});

// ---------------------------------------------------------------------------------------------------
// #1 — the Origin check only fires when an Origin header IS there, and "absent" passed it. Sec-Fetch-Site
// is the signal a browser cannot omit. A cross-site page may still LINK to the panel (/), but never reach
// /api/ — not by POST, not by GET, not as a navigation (SEC-2). Only the panel's own origins pass (SEC-1:
// not every localhost port), and a browser's state-changing call must carry X-CCUI. Clients that send
// none of these headers (node, curl, the smoke test) are not judged by THESE guards — they are judged by
// the N9 API token, which this suite runs WITHOUT (the sandbox switches it off; test/api-token.test.js is
// where it is on). So „curl reaches the route" below means „this guard lets it through", not „the panel is
// open to another local account" — that was true when these cases were written and is not true any more.
// ---------------------------------------------------------------------------------------------------
describe('cross-site guard — a foreign page may not touch the API, but may still link to the panel', () => {
  let S, dataDir, claudeDir;
  // the shared req() sends no custom headers, so this suite needs its own one-off
  function reqH(port, method, p, headers, body) {
    return new Promise((resolve, reject) => {
      const data = body ? Buffer.from(JSON.stringify(body)) : null;
      const h = { ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) };
      const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h },
        (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
      r.on('error', reject); if (data) r.write(data); r.end();
    });
  }
  before(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-xsite-data-'));
    claudeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-xsite-claude-'));
    await fsp.mkdir(path.join(claudeDir, 'projects'), { recursive: true });
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, ...SBX.env, CLAUDE_UI_PORT: String(port), CLAUDE_UI_FAKE_BIN: FAKE, CLAUDE_UI_CLAUDE_BIN: FAKE, CLAUDE_UI_DATA_DIR: dataDir, CLAUDE_UI_CLAUDE_DIR: claudeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitUp(port);
    S = { port, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }) };
  });
  after(async () => {
    if (S) await S.stop();
    for (const d of [dataDir, claudeDir]) if (d) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
  });

  // rename with an empty body answers "id required" BEFORE it touches a store, so this asserts the
  // guard and nothing else: 403 = stopped in the router, 400 = the route was reached as before.
  it('a state-changing request from a foreign site is refused', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const r = await reqH(S.port, 'POST', '/api/session/rename', { 'Sec-Fetch-Site': site }, {});
      assert.equal(r.status, 403, site + ' must not be able to POST');
      assert.match(r.body, /cross-site/);
    }
  });

  it('the panel itself (with X-CCUI), a bookmark, and a header-less client reach the route', async () => {
    const own = 'http://127.0.0.1:' + S.port;
    for (const headers of [
      { 'Sec-Fetch-Site': 'same-origin', 'X-CCUI': '1' },
      { 'Sec-Fetch-Site': 'none', 'X-CCUI': '1' },
      { Origin: own, 'Sec-Fetch-Site': 'same-origin', 'X-CCUI': '1' },
      { Origin: 'http://localhost:' + S.port, 'X-CCUI': '1' },
      {}, // node / curl: no Origin, no Sec-Fetch-* → unaffected
    ]) {
      const r = await reqH(S.port, 'POST', '/api/session/rename', headers, {});
      assert.equal(r.status, 400, JSON.stringify(headers) + ' must reach the route');
      assert.match(r.body, /id required/);
    }
  });

  it('a browser POST without X-CCUI is refused, even from the own origin', async () => {
    for (const headers of [
      { 'Sec-Fetch-Site': 'same-origin' },
      { Origin: 'http://127.0.0.1:' + S.port },
      { Origin: 'http://127.0.0.1:' + S.port, 'X-CCUI': 'yes' }, // only the exact value counts
    ]) {
      const r = await reqH(S.port, 'POST', '/api/session/rename', headers, {});
      assert.equal(r.status, 403, JSON.stringify(headers) + ' must be refused');
      assert.match(r.body, /X-CCUI/);
    }
  });

  it('another localhost port is a foreign origin (SEC-1)', async () => {
    for (const o of ['http://127.0.0.1:' + (S.port === 1 ? 2 : 1), 'http://localhost:5173', 'https://127.0.0.1:' + S.port]) {
      const r = await reqH(S.port, 'POST', '/api/mcp/add', { Origin: o, 'X-CCUI': '1' }, {});
      assert.equal(r.status, 403, o + ' must not pass as the panel');
      assert.match(r.body, /origin/);
    }
  });

  it('a cross-site link still opens the panel, but never reaches /api/ (SEC-2, SEC-M1)', async () => {
    const shell = await reqH(S.port, 'GET', '/', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }, null);
    assert.equal(shell.status, 200);
    for (const [mode, dest] of [['navigate', 'document'], ['navigate', 'iframe'], ['no-cors', 'image'], ['cors', 'empty'], ['', '']]) {
      const h = { 'Sec-Fetch-Site': 'cross-site' };
      if (mode) { h['Sec-Fetch-Mode'] = mode; h['Sec-Fetch-Dest'] = dest; }
      const r = await reqH(S.port, 'GET', '/api/mcp/check', h, null);
      assert.equal(r.status, 403, mode + '/' + dest + ' must not reach a GET route with a side effect');
      assert.match(r.body, /cross-site/);
    }
  });

  it('nothing may frame the panel (SEC-6) — also not on a 403', async () => {
    for (const [p, h] of [['/', {}], ['/api/state', {}], ['/api/state', { 'Sec-Fetch-Site': 'cross-site' }]]) {
      const r = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: S.port, path: p, headers: h }, (res) => { res.resume(); resolve(res); }).on('error', reject);
      });
      assert.equal(r.headers['x-frame-options'], 'DENY', p + ' ' + JSON.stringify(h));
      assert.match(r.headers['content-security-policy'] || '', /frame-ancestors 'none'/);
    }
  });

  it('the pre-existing Origin guard is unchanged', async () => {
    const r = await reqH(S.port, 'POST', '/api/session/rename', { Origin: 'https://evil.tld' }, {});
    assert.equal(r.status, 403);
    assert.match(r.body, /origin/);
  });

  // ---- alert #5: the two GETs that ACT on a caller-named directory -------------------------------
  // /api/diff runs five git processes in the cwd it is handed and returns up to 200 000 characters of
  // patch, /api/files walks it. They are the only GETs held to the X-CCUI proof (GET_NEEDS_CCUI in
  // server.js): cross-site they are already 403, but only for a browser that SENDS Sec-Fetch-Site, and
  // a foreign page cannot add a custom header at all.
  // The `{}` (header-less) case below is the one whose MEANING changed with N9: it still reaches the route
  // here, because this server runs with the token gate off — with the gate on it is 401, pinned in
  // test/api-token.test.js („a GET on /api/diff and /api/files is 401 without a token").
  it('a browser GET on /api/diff and /api/files needs X-CCUI; the panel passes, a header-less client is left to the token gate', async () => {
    // dataDir, not ROOT: this test is about the header, and a non-repo cwd costs one `git rev-parse`
    // instead of five spawns per call (the real checkout is diffed once, in the test below).
    for (const p of ['/api/diff?cwd=' + encodeURIComponent(dataDir), '/api/files?cwd=' + encodeURIComponent(dataDir) + '&q=zzz']) {
      for (const headers of [{ 'Sec-Fetch-Site': 'same-origin' }, { Origin: 'http://127.0.0.1:' + S.port }, { Origin: 'http://127.0.0.1:' + S.port, 'X-CCUI': 'yes' }]) {
        const r = await reqH(S.port, 'GET', p, headers, null);
        assert.equal(r.status, 403, p + ' ' + JSON.stringify(headers) + ' must be refused');
        assert.match(r.body, /X-CCUI/);
      }
      for (const headers of [{ 'Sec-Fetch-Site': 'same-origin', 'X-CCUI': '1' }, { Origin: 'http://127.0.0.1:' + S.port, 'X-CCUI': '1' }, {}]) {
        const r = await reqH(S.port, 'GET', p, headers, null);
        assert.equal(r.status, 200, p + ' ' + JSON.stringify(headers) + ' must reach the route');
      }
    }
    // every other GET stays reachable from a bookmark without the header — the list is short on purpose
    assert.equal((await reqH(S.port, 'GET', '/api/state', { 'Sec-Fetch-Site': 'same-origin' }, null)).status, 200);
  });

  it('a cwd that is not a local absolute path is refused — and a refusal is NOT an empty answer', async () => {
    // The UNC spelling is the one that was measured: fs.statSync on an unreachable UNC host blocked for
    // 54 875 ms (2026-10-03, \\192.0.2.1\share) — synchronously, so one GET froze the whole panel. This
    // test must never touch the network itself, so it asserts that the SHAPE check answers, and answers
    // fast, i.e. before anything goes near the filesystem.
    const bad = ['\\\\192.0.2.1\\share', '\\\\?\\C:\\Windows', '//attacker.example/share', 'relative\\dir', 'C:notabsolute'];
    for (const cwd of bad) {
      for (const route of ['/api/diff', '/api/files']) {
        const t0 = Date.now();
        const r = await reqH(S.port, 'GET', route + '?cwd=' + encodeURIComponent(cwd), { 'X-CCUI': '1' }, null);
        assert.equal(r.status, 400, route + ' ' + cwd + ' must be refused, not served');
        const j = JSON.parse(r.body);
        assert.equal(j.code, 'cwd-refused', 'the client has to be able to tell this from "no matches"');
        assert.ok(j.error && j.error.length > 10, 'and it has to say WHY: ' + r.body);
        assert.ok(Date.now() - t0 < 2000, cwd + ' was only refused after ' + (Date.now() - t0) + ' ms — the shape check belongs before any fs call');
      }
    }
  });

  it('the cwd the panel actually uses still works, and a half-typed path is still an empty list', async () => {
    const ok = await reqH(S.port, 'GET', '/api/diff?cwd=' + encodeURIComponent(ROOT), { 'X-CCUI': '1' }, null);
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).repo, true, 'the panel checkout is a git repo and must still be diffable');
    const noCwd = await reqH(S.port, 'GET', '/api/diff', { 'X-CCUI': '1' }, null);
    assert.equal(noCwd.status, 200, 'no cwd given = the route default, which is configuration and not input');
    const typing = await reqH(S.port, 'GET', '/api/files?cwd=' + encodeURIComponent(path.join(ROOT, 'does-not-exist-yet')) + '&q=a', { 'X-CCUI': '1' }, null);
    assert.equal(typing.status, 200, 'a path that is merely not there is not a refusal');
    assert.deepEqual(JSON.parse(typing.body).files, []);
  });
});

// ---------------------------------------------------------------------------------------------------
// Route parity (F11 stage 1). The route list is EXTRACTED FROM server.js at test time, on purpose: a
// new endpoint can't quietly escape the check, and a removed one can't rot in a hand-kept list.
// Contract per route: never 500, and JSON content-type unless it's a documented download/stream.
// ---------------------------------------------------------------------------------------------------
function extractRoutes(src) {
  const out = [];
  // The exact routes live in the ROUTES table, keyed "<METHOD> <path>" (E1 — they used to be 86
  // `if (p === … && req.method === …)` branches, and this sweep is the reason the table has to stay
  // enumerable). test/routes.test.js checks the SET of keys; this one checks that each one answers.
  const tbl = /^ {2}'([A-Z]+) (\/[^']*)': async \(req, res, url, p\) => \{/gm;
  let t;
  while ((t = tbl.exec(src))) out.push({ method: t[1], path: t[2], prefix: false });
  // …and the one route a table cannot express: `p.startsWith('/x/')` with its req.method
  const re = /p\.startsWith\(\s*'([^']+)'\s*\)\s*&&\s*req\.method === '(\w+)'/g;
  let m;
  while ((m = re.exec(src))) out.push({ method: m[2], path: m[1], prefix: m[1].endsWith('/') });
  // the chat sub-routes live behind one regex: /api/chat/<uuid>/(stream|send|…)
  // The class accepts `-` since PR-11 added `reload-skills` and G4/G6 the four MCP/task actions: without it
  // this match fails ENTIRELY, `actions` comes back empty, and the sweep below then exercises nothing while
  // staying green — a silent hole of exactly the kind this file exists to prevent. The deepEqual on the
  // action list in the first `it` is the second guard: a new action has to be named there, and a vanished
  // list is visible at once.
  const cm = src.match(/\/\^\\\/api\\\/chat\\\/\(\[0-9a-f-\]\{36\}\)\\\/\(([a-z|-]+)\)\$\//);
  const actions = cm ? cm[1].split('|') : [];
  return { out, actions };
}
// /api/version/pull is deliberately NOT probed: it runs `git pull --ff-only` in the checkout the
// server was started from — a mutating action on the developer's own working tree.
// /api/restart is not probeable either: its contract is that this very server exits and a successor
// takes over the port, so probing it would tear down the suite mid-sweep (it did — every later route
// then failed with ECONNREFUSED). Covered end-to-end by test/version.test.js instead.
// /api/spend/refresh drives the user's debug Edge over CDP: it OPENS A TAB on the spend page.
// The sandbox points CDP at a dead port, so the route would only answer its 502 — skipped anyway, so a
// missing seam can never turn the sweep into a browser action again.
const PARITY_SKIP = new Set(['POST /api/version/pull', 'POST /api/restart', 'POST /api/spend/refresh']);
// documented non-JSON responders (downloads + SSE)
const NON_JSON = new Set(['GET /api/usage.csv', 'GET /api/mcp/inventory', 'GET /api/backups/download']);

describe('route parity — every route in server.js answers without a 500', () => {
  let S, dataDir, claudeDir, routes, actions;
  before(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-parity-data-'));
    claudeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-parity-claude-'));
    await fsp.mkdir(path.join(claudeDir, 'projects'), { recursive: true });
    const port = await freePort();
    // CLAUDE_UI_CLAUDE_BIN = the fake script: it EXISTS (so /api/chat/start passes its existsSync
    // gate) but is not executable, so every non-chat execFile of it fails instantly — the routes are
    // exercised without a single real CLI spawn, model call or cost.
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, ...SBX.env, CLAUDE_UI_PORT: String(port), CLAUDE_UI_FAKE_BIN: FAKE, CLAUDE_UI_CLAUDE_BIN: FAKE, CLAUDE_UI_DATA_DIR: dataDir, CLAUDE_UI_CLAUDE_DIR: claudeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
    await waitUp(port);
    S = { port, log: () => log, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }) };
    const ex = extractRoutes(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'));
    routes = ex.out; actions = ex.actions;
  });
  after(async () => {
    if (S) await S.stop();
    for (const d of [dataDir, claudeDir]) if (d) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
  });

  it('extraction found the expected order of magnitude of routes', () => {
    assert.ok(routes.length >= 65, 'only ' + routes.length + ' routes extracted — did the router shape change?');
    // In server.js's own ORDER, not sorted: `stop` standing before `stop-task` is only harmless because the
    // alternation is anchored with `$` and backtracks (pinned in test/routes.test.js).
    assert.deepEqual(actions, ['stream', 'send', 'permission', 'interrupt', 'mode', 'effort', 'model', 'ultracode', 'settings', 'context',
      'hooks', 'reload-skills', 'stop', 'mcp-status', 'mcp-toggle', 'mcp-reconnect', 'stop-task']);
  });

  it('every non-chat route: status < 500 and JSON where applicable', async () => {
    // Probes run four at a time with a hard 4 s budget each. Sweeping ~90 routes strictly serially took
    // 80 s, because a handful wait on real upstreams (GHE, npm registry, CDP) until their own deadline —
    // and that wall time starved the timing-sensitive resume/self-heal suite whenever the test files run
    // in parallel. A timeout here is NOT a failure: it means the route was still waiting on an upstream,
    // which is the opposite of the 500 this test looks for.
    const probe = async (r) => {
      const key = r.method + ' ' + r.path;
      if (PARITY_SKIP.has(key)) return null;
      // prefix routes need a concrete id; POST/PUT get an EMPTY body on purpose so validation answers
      // (400) instead of the route doing real work — /api/bug must never actually file an issue.
      const target = r.prefix ? r.path + 'zz-parity-probe' : r.path;
      let res;
      try {
        res = await Promise.race([
          req(S.port, r.method, target, r.method === 'GET' ? null : {}),
          new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 4000)),
        ]);
      } catch (e) { return key + ' → request failed: ' + e.message; }
      if (res.timedOut) return null; // still waiting on an upstream — not a server fault
      // 500 = the server itself broke. An honest upstream signal (502 from an unreachable CDP browser
      // / GHE) is a legitimate answer and must not fail the parity check.
      if (res.status === 500) return key + ' → ' + res.status + ' ' + String(res.body).slice(0, 120);
      if (!NON_JSON.has(key) && res.json === null && res.body) return key + ' → ' + res.status + ' but body is not JSON: ' + String(res.body).slice(0, 80);
      return null;
    };
    const failures = [];
    for (let i = 0; i < routes.length; i += 4) {
      (await Promise.all(routes.slice(i, i + 4).map(probe))).forEach((f) => { if (f) failures.push(f); });
    }
    assert.deepEqual(failures, [], 'route parity failures:\n' + failures.join('\n'));
  });

  it('every chat sub-route answers on a live chat (stream is SSE, the rest JSON)', async () => {
    const start = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT });
    assert.equal(start.status, 200, start.body);
    const id = start.json.chatId;
    const failures = [];
    for (const a of actions) {
      if (a === 'stop') continue; // kills the chat — checked last
      if (a === 'stream') { // SSE: assert the headers, then drop the socket (it never "ends")
        const head = await new Promise((resolve) => {
          const rq = http.get({ host: '127.0.0.1', port: S.port, path: `/api/chat/${id}/stream` }, (res) => { const h = { status: res.statusCode, ct: res.headers['content-type'] || '' }; rq.destroy(); resolve(h); });
          rq.on('error', () => resolve({ status: 0, ct: '' }));
        });
        if (head.status !== 200 || !/event-stream/.test(head.ct)) failures.push('GET stream → ' + head.status + ' ' + head.ct);
        continue;
      }
      const res = await req(S.port, 'POST', `/api/chat/${id}/${a}`, { text: 'x', mode: 'plan', effort: 'low', model: '', requestId: 'r1', behavior: 'deny' });
      if (res.status === 500) failures.push('POST ' + a + ' → ' + res.status + ' ' + String(res.body).slice(0, 120));
      else if (res.json === null) failures.push('POST ' + a + ' → non-JSON body');
    }
    const stop = await req(S.port, 'POST', `/api/chat/${id}/stop`, {});
    if (stop.status === 500) failures.push('POST stop → ' + stop.status);
    assert.deepEqual(failures, [], 'chat route parity failures:\n' + failures.join('\n'));
  });

  // The start route is the one place where a REQUEST BODY becomes a process: every field it forgets to
  // pass on is a setting that silently does nothing. Nothing tested that hand-off — the parity sweep
  // posts an EMPTY body on purpose, and test/chatargs.test.js calls startChat() directly, bypassing the
  // route. So a field dropped in the route (e.g. while resolving a merge conflict in it — this test was
  // written after exactly that near-miss) would have passed the whole suite. `meta` is the receipt.
  it('the start route forwards its launch fields to the process (meta is the receipt)', async () => {
    const r = await req(S.port, 'POST', '/api/chat/start', {
      cwd: ROOT, permissionMode: 'plan', effort: 'low', maxBudgetUsd: 1.5,
      agent: 'reviewer', worktree: 'feature-x',
    });
    assert.equal(r.status, 200, r.body);
    const m = r.json.meta || {};
    assert.equal(m.permissionMode, 'plan');
    assert.equal(m.effort, 'low');
    assert.equal(m.maxBudgetUsd, 1.5);
    assert.equal(m.agent, 'reviewer', 'the session agent never reached startChat');
    assert.equal(m.worktree, 'feature-x', 'the worktree wish never reached startChat');
    await req(S.port, 'POST', `/api/chat/${r.json.chatId}/stop`, {});
  });

  it('an unknown /api/* path is a JSON 404, never the static handler (F11)', async () => {
    const r = await req(S.port, 'GET', '/api/does-not-exist');
    assert.equal(r.status, 404);
    assert.equal(r.json && r.json.error, 'not found');
    const r2 = await req(S.port, 'POST', '/api/also-not-a-route', {});
    assert.equal(r2.status, 404);
    assert.ok(r2.json, 'POST to an unknown /api route must still answer JSON');
    // a real static asset must keep working (the guard sits above the file branch, not on top of it)
    const idx = await req(S.port, 'GET', '/index.html');
    assert.equal(idx.status, 200);
  });
});

describe('chat engine — permission gate + reaped-chat contract (#25)', () => {
  it('emits a can_use_tool gate; answering a stopped chat → 404 (what the client self-heal keys on)', async () => {
    const S = await startServer('permission');
    try {
      const s = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT });
      const id = s.json.chatId;
      const framesP = collectSSE(S.port, id, { until: (x) => x.some((y) => y.ev.type === 'control_request'), timeout: 4000 });
      await new Promise((r) => setTimeout(r, 300));
      await req(S.port, 'POST', `/api/chat/${id}/send`, { text: 'do it' });
      const frames = await framesP;
      assert.ok(frames.some((x) => x.ev.type === 'control_request' && x.ev.request && x.ev.request.subtype === 'can_use_tool'), 'no permission gate emitted');
      // reap the (gate-wedged) chat, then answering it must 404 — the signal the client turns into a resume (#25)
      await req(S.port, 'POST', `/api/chat/${id}/stop`);
      await new Promise((r) => setTimeout(r, 200));
      const ans = await req(S.port, 'POST', `/api/chat/${id}/permission`, { requestId: 'req-1', behavior: 'allow' });
      assert.equal(ans.status, 404);
      assert.equal(ans.json.error, 'chat not found');
    } finally { await S.stop(); }
  });
});

// PR-3b — the context line. A tab on „Opus 5 (1M)" showed „Kontext 250 % · 500,8K / 200,0K" for one turn
// that had been running for over an hour: the window was the model's from BEFORE a live switch, and the
// token count came from frame arithmetic that only a `result` refreshes. So the panel asks the CLI
// instead (`get_context_usage`), and these are the contracts of that route. What it answers is the
// MEASURED shape (2026-10-02) — see fake-claude.js contextUsage(), which reproduces it including the
// ~8 KB `gridRows` the route has to leave behind.
describe('chat engine — GET /api/chat/:id/context asks the CLI for the real numbers (PR-3b)', () => {
  let S;
  before(async () => { S = await startServer('echo'); });
  after(async () => { if (S) await S.stop(); });

  it('answers the scalars + trimmed categories, and never the CLI display grid', async () => {
    const s = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, model: 'eu.anthropic.claude-sonnet-5' });
    const id = s.json.chatId;
    const r = await req(S.port, 'GET', `/api/chat/${id}/context`);
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.unconfirmed, undefined, 'the CLI answered — nothing is unconfirmed');
    assert.equal(r.json.totalTokens, 34021);
    assert.equal(r.json.maxTokens, 1000000);
    assert.equal(r.json.rawMaxTokens, 1000000);
    assert.equal(r.json.percentage, 3, 'the percentage is the CLI\'s own, not one the panel recomputed');
    assert.equal(r.json.autocompactSource, 'model-default');
    // The narrowing is the point of the route. CORRECTED in PR-11: `gridRows` is NOT „the display grid plus
    // a per-MCP-tool list" — measured, it is a 10 × 20 square grid of cells whose tokens/percentage repeat
    // the category aggregate, and the per-tool list is a separate field, `mcpTools`. The assertion below is
    // unchanged and still right, but the two halves now test two different fields: `gridRows` must not come
    // through at all, and `mcp__` would be a TOOL NAME out of `mcpTools`, which the route aggregates to
    // server names. Passing the tool names through is what that second half catches.
    assert.equal('gridRows' in r.json, false, 'the display grid reached the client');
    assert.equal(/gridRows|mcp__/.test(r.body), false, 'a grid cell or an MCP tool name survived the trim: ' + r.body.slice(0, 200));
    assert.equal('mcpTools' in r.json, false, 'the raw per-tool list reached the client');
    const cats = r.json.categories;
    assert.ok(Array.isArray(cats) && cats.length >= 4, 'no categories to draw a breakdown from');
    for (const c of cats) {
      assert.deepEqual(Object.keys(c), ['name', 'tokens', 'kind'], 'exactly the three fields PR-11 draws from');
      assert.equal(typeof c.tokens, 'number');
    }
    // the four kinds the real answer carries — `kind` already says "deferred", so `isDeferred` is dropped
    assert.deepEqual([...new Set(cats.map((c) => c.kind))].sort(), ['buffer', 'deferred', 'free', 'used']);
    // PR-11 — the per-SERVER share, aggregated server-side. What makes it a reading and not a second number
    // is that its sum has to HIT a category value the CLI delivered in the same payload; the route hands out
    // nothing when it does not (ctxMcpAggregate), so the mere PRESENCE of this object is the counter-check
    // having held.
    const mcp = r.json.mcp;
    assert.ok(mcp, 'no per-server breakdown — the counter-check failed on the fixture');
    assert.deepEqual(mcp.servers.map((x) => x.name), ['sap-adt', 'jira', 'snow-mcp'], 'biggest first');
    for (const srv of mcp.servers) assert.deepEqual(Object.keys(srv), ['name', 'tokens', 'toolCount', 'loadedCount']);
    assert.equal(mcp.servers.reduce((a, x) => a + x.tokens, 0), mcp.tokens);
    assert.equal(mcp.tokens, mcp.category.tokens, 'the sum and the delivered category value must agree');
    assert.equal(mcp.category.name, 'MCP tools (deferred)');
    // …and the two arithmetic identities of the measured answer hold on the fixture too, because they are
    // what the breakdown is checked against (public/js/ctx-breakdown.js). A fixture that broke them would
    // make every „residue is zero" assertion vacuous.
    const sum = (k) => cats.filter((c) => c.kind === k).reduce((a, c) => a + c.tokens, 0);
    assert.equal(sum('used'), r.json.totalTokens, 'Σ(used) !== totalTokens in the fixture');
    assert.equal(sum('used') + sum('buffer') + sum('free'), r.json.maxTokens, 'the parts do not fill the window');
    await req(S.port, 'POST', `/api/chat/${id}/stop`);
  });

  it('a set_model in between moves BOTH halves — the stale-window bug itself', async () => {
    const s = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, model: 'eu.anthropic.claude-sonnet-5' });
    const id = s.json.chatId;
    await new Promise((r) => setTimeout(r, 300));
    const before = await req(S.port, 'GET', `/api/chat/${id}/context`);
    assert.equal(before.json.maxTokens, 1000000);
    const sw = await req(S.port, 'POST', `/api/chat/${id}/model`, { model: 'eu.anthropic.claude-opus-5' });
    assert.equal(sw.status, 200, sw.body);
    const after = await req(S.port, 'GET', `/api/chat/${id}/context`);
    assert.equal(after.json.maxTokens, 200000, 'the window still belonged to the previous model (1M → 200K)');
    // …and the base context moves too: system prompt and tool definitions differ per model, which is why
    // frame arithmetic is wrong in BOTH numbers after a switch and re-asking is the only honest answer.
    assert.notEqual(after.json.totalTokens, before.json.totalTokens, 'the base context did not follow the model');
    assert.equal(after.json.percentage, 9);
    await req(S.port, 'POST', `/api/chat/${id}/stop`);
  });

  it('two parallel callers share ONE control request, and its payload never reaches the SSE stream', async () => {
    // the hold makes the overlap deterministic: without it the first call can be finished before the
    // second arrives, and two separate requests would pass unnoticed
    const S2 = await startServer('echo', { FAKE_CLAUDE_CTX_MS: '600' });
    try {
      const s = await req(S2.port, 'POST', '/api/chat/start', { cwd: ROOT });
      const id = s.json.chatId;
      await new Promise((r) => setTimeout(r, 300));
      const framesP = collectSSE(S2.port, id, { timeout: 2500 });
      await new Promise((r) => setTimeout(r, 150));
      const [a, b] = await Promise.all([
        req(S2.port, 'GET', `/api/chat/${id}/context`),
        req(S2.port, 'GET', `/api/chat/${id}/context`),
      ]);
      assert.equal(a.status, 200); assert.equal(b.status, 200);
      assert.deepEqual(b.json, a.json, 'the second caller got its own answer instead of joining the first');
      const frames = await framesP;
      // fake-claude emits `_ctxprobe` the moment a get_context_usage ARRIVES, so this counts what really
      // reached the CLI — without the sharing it would be one control request per asking tab.
      const probes = frames.filter((f) => f.ev.type === '_ctxprobe');
      assert.equal(probes.length, 1, 'the CLI saw ' + probes.length + ' get_context_usage requests, not 1');
      // Never broadcast: every OTHER control answer is part of the transcript, but this one is a gauge's
      // read, so broadcasting it would push the full payload into every open stream and the replay buffer.
      const leaked = frames.filter((f) => f.ev.type === 'control_response' && f.ev.response
        && f.ev.response.response && 'totalTokens' in f.ev.response.response);
      assert.deepEqual(leaked, [], 'the context payload was broadcast to every tab');
    } finally { await S2.stop(); }
  });

  it('an answer that arrives AFTER the ceiling is still not broadcast, and not buffered either', async () => {
    // The „never broadcast" marker used to be retired together with the waiter when the ceiling fired. An
    // answer slower than the ceiling then found neither, and the generic control_response path shipped the
    // whole untrimmed payload to every SSE client AND appended it to the replay buffer — so the one tab
    // that asked got `{ unconfirmed }` while every tab got the 8 KB. Ceiling 400 ms, answer at 1400 ms is
    // that window; on the real thing it is a cold call that needs longer than the 25 s.
    const S2 = await startServer('echo', { FAKE_CLAUDE_CTX_MS: '1400', CLAUDE_UI_CONTEXT_TIMEOUT_MS: '400' });
    try {
      const s = await req(S2.port, 'POST', '/api/chat/start', { cwd: ROOT });
      const id = s.json.chatId;
      await new Promise((r) => setTimeout(r, 300));
      const framesP = collectSSE(S2.port, id, { timeout: 2600 }); // stays open well past the late answer
      await new Promise((r) => setTimeout(r, 150));
      const r = await req(S2.port, 'GET', `/api/chat/${id}/context`);
      assert.equal(r.json.unconfirmed, true, 'the ceiling did not fire first — the timing window is wrong');
      const frames = await framesP;
      // the request really did reach the CLI and really was answered — otherwise this test proves nothing
      assert.equal(frames.filter((f) => f.ev.type === '_ctxprobe').length, 1, 'the CLI never saw the read');
      const leaked = frames.filter((f) => JSON.stringify(f.ev).includes('totalTokens'));
      assert.deepEqual(leaked, [], 'the late answer was broadcast to every open tab');
      // …and the replay buffer is clean too: a fresh SSE connect (no Last-Event-ID) replays it in full, so a
      // tab that reconnects later would otherwise still receive the payload.
      const replay = await collectSSE(S2.port, id, { timeout: 700 });
      assert.deepEqual(replay.filter((f) => JSON.stringify(f.ev).includes('totalTokens')), [],
        'the late answer sits in the replay buffer');
    } finally { await S2.stop(); }
  });

  it('a read that OVERLAPS a set_model: the held one keeps the old numbers, the NEXT one is already fresh', async () => {
    // fake-claude snapshots the figure when the request ARRIVES (the plausible reading of the real 12.2 s
    // cold call: it is already computing while later stdin lines queue), so a set_model during a held read
    // cannot rewrite an answer in flight. That held answer therefore belongs to the OLD model — correct and
    // unavoidable — which is exactly why the shared in-flight read must be dropped on a switch: the next
    // asker (and the client asks on every model change) must not be joined to it.
    const S2 = await startServer('echo', { FAKE_CLAUDE_CTX_MS: '1200' });
    try {
      const s = await req(S2.port, 'POST', '/api/chat/start', { cwd: ROOT, model: 'eu.anthropic.claude-sonnet-5' });
      const id = s.json.chatId;
      await new Promise((r) => setTimeout(r, 300));
      const framesP = collectSSE(S2.port, id, { timeout: 3500 });
      await new Promise((r) => setTimeout(r, 150));
      const heldP = req(S2.port, 'GET', `/api/chat/${id}/context`); // answers ~1200 ms from now
      await new Promise((r) => setTimeout(r, 250));
      const sw = await req(S2.port, 'POST', `/api/chat/${id}/model`, { model: 'eu.anthropic.claude-opus-5' });
      assert.equal(sw.status, 200, sw.body);
      // Fired while the first read is STILL in flight. That is what makes this a test of the invalidation
      // and not of the pending slot simply clearing itself when the first read finishes.
      const fresh = await req(S2.port, 'GET', `/api/chat/${id}/context`);
      const held = await heldP;
      assert.equal(held.json.maxTokens, 1000000, 'the held read was rewritten by the switch it predates');
      assert.equal(held.json.totalTokens, 34021);
      assert.equal(fresh.json.maxTokens, 200000, 'the new read was answered by the request issued BEFORE the switch');
      assert.equal(fresh.json.totalTokens, 18529, 'the base context is still the old model\'s');
      // Two arrivals = the switch really issued a SECOND control request instead of sharing the first.
      const probes = (await framesP).filter((f) => f.ev.type === '_ctxprobe');
      assert.equal(probes.length, 2, 'the CLI saw ' + probes.length + ' get_context_usage requests, not 2');
      assert.match(String(probes[0].ev.model), /sonnet-5/);
      assert.match(String(probes[1].ev.model), /opus-5/);
    } finally { await S2.stop(); }
  });

  it('waits longer than the 5 s control timeout — the first call after a start was measured at 12.2 s', async () => {
    // 6 s > CONTROL_TIMEOUT_MS (5 s): a route on the shared timeout would have given up on this answer and
    // reported `unconfirmed`, i.e. every cold first query (MCP servers still starting) would be a fallback.
    const S2 = await startServer('echo', { FAKE_CLAUDE_CTX_MS: '6000' });
    try {
      const s = await req(S2.port, 'POST', '/api/chat/start', { cwd: ROOT });
      const id = s.json.chatId;
      await new Promise((r) => setTimeout(r, 300));
      const t0 = Date.now();
      const r = await req(S2.port, 'GET', `/api/chat/${id}/context`);
      const took = Date.now() - t0;
      assert.ok(took >= 5500, 'the answer came too early to have been waited for (' + took + ' ms)');
      assert.equal(r.json.unconfirmed, undefined, 'gave up before the CLI answered (' + took + ' ms)');
      assert.equal(typeof r.json.totalTokens, 'number');
    } finally { await S2.stop(); }
  });

  it('a Stop mid-flight ends the wait at once instead of sitting out the 25 s ceiling', async () => {
    // The long ceiling is what makes this worth guarding: once the process is gone no answer can arrive,
    // so waiting for one would leave the browser's poll hanging on every tab the user just stopped. The
    // fake would answer at 20 s — but it is killed first, so an unguarded route waits for the full
    // timeout instead.
    const S2 = await startServer('echo', { FAKE_CLAUDE_CTX_MS: '20000' });
    try {
      const s = await req(S2.port, 'POST', '/api/chat/start', { cwd: ROOT });
      const id = s.json.chatId;
      await new Promise((r) => setTimeout(r, 300));
      const t0 = Date.now();
      const ctxP = req(S2.port, 'GET', `/api/chat/${id}/context`);
      await new Promise((r) => setTimeout(r, 300));
      await req(S2.port, 'POST', `/api/chat/${id}/stop`, {});
      const r = await ctxP;
      const took = Date.now() - t0;
      assert.ok(took < 8000, 'waited for a process that was already gone (' + took + ' ms of a 25 s ceiling)');
      assert.equal(r.status, 200, r.body);
      assert.equal(r.json.unconfirmed, true, 'a dead process has no context to report');
    } finally { await S2.stop(); }
  });

  it('a CLI that does not answer this control → 200 { unconfirmed }, no hang and no invented numbers', async () => {
    // An older CLI simply does not know the subtype. The short panel timeout is the env seam — the real
    // 25 s ceiling is what a cold start needs, not what a test should sit through.
    const S2 = await startServer('echo', { FAKE_CLAUDE_CTX_SILENT: '1', CLAUDE_UI_CONTEXT_TIMEOUT_MS: '900' });
    try {
      const s = await req(S2.port, 'POST', '/api/chat/start', { cwd: ROOT });
      const id = s.json.chatId;
      await new Promise((r) => setTimeout(r, 300));
      const t0 = Date.now();
      const r = await req(S2.port, 'GET', `/api/chat/${id}/context`);
      const took = Date.now() - t0;
      // 200, not an error status: the context line is ambient, and the client has a frame-arithmetic
      // fallback. An error here would paint a failure where „no fresh number" is the truth.
      assert.equal(r.status, 200, r.body);
      assert.equal(r.json.unconfirmed, true);
      assert.equal(r.json.totalTokens, undefined, 'a missing answer must not become a number');
      assert.equal(r.json.maxTokens, undefined);
      assert.ok(took >= 900 && took < 5000, 'did not come back on its own timeout (' + took + ' ms)');
    } finally { await S2.stop(); }
  });

  it('an unknown chat id is the same 404 the sibling chat routes give', async () => {
    const r = await req(S.port, 'GET', '/api/chat/00000000-0000-0000-0000-000000000000/context');
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'chat not found');
  });

  it('a dead-but-lingering chat is 409 "process not running", like GET /settings', async () => {
    // Without the alive guard this would write to a dead stdin and report `unconfirmed` — "the CLI did
    // not answer" for a CLI that is not there at all.
    const S2 = await startServer('crash');
    try {
      const s = await req(S2.port, 'POST', '/api/chat/start', { cwd: ROOT });
      const id = s.json.chatId;
      await collectSSE(S2.port, id, { until: (x) => x.some((y) => y.ev.type === '_exit'), timeout: 4000 });
      const r = await req(S2.port, 'GET', `/api/chat/${id}/context`);
      assert.equal(r.status, 409);
      assert.equal(r.json.error, 'process not running');
    } finally { await S2.stop(); }
  });
});

// PR-11 — the hook catalog and the skill reload. Both are controls on a RUNNING session, which is the
// design point of the hook editor: it is session-free today, so the panel reads the catalog when a chat is
// up and falls back to its nine known names when none is — and it has to SAY which of the two it is doing
// (public/js/hooks-catalog.js). These are the route-side contracts of that.
describe('chat engine — GET /api/chat/:id/hooks + POST /reload-skills (PR-11)', () => {
  let S;
  before(async () => { S = await startServer('echo'); });
  after(async () => { if (S) await S.stop(); });

  it('hands out the event catalog, the hooks in force and the policy — without the duplicated command text', async () => {
    const s = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT });
    const id = s.json.chatId;
    const r = await req(S.port, 'GET', `/api/chat/${id}/hooks`);
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.unconfirmed, undefined);
    // `eventCatalog` is the field the panel did not know existed — and the one the add-hook form is built
    // from, in the CLI's own lifecycle order
    const cat = r.json.eventCatalog;
    assert.ok(Array.isArray(cat) && cat.length >= 5, 'no event catalog: ' + r.body.slice(0, 200));
    for (const e of cat) assert.deepEqual(Object.keys(e), ['name', 'summary', 'supportsMatcher']);
    // the measured three-valued matcher question, on the two rows that disprove the old hint
    assert.equal(cat.find((e) => e.name === 'Stop').supportsMatcher, false);
    assert.equal(cat.find((e) => e.name === 'SessionStart').supportsMatcher, true);
    // the hooks the CLI LISTS, with their origin — including the plugin hook the panel cannot see in any
    // settings file it owns
    const hooks = r.json.hooks;
    assert.ok(hooks.length >= 2);
    // `disabled` instead of `editable`: the former says whether the row RUNS („absent on rows that run"), and
    // it is what the heading above the list depends on. The latter is an OBJECT in the schema, was read here as
    // `=== true`, and is out of the route until a consumer exists — see test/hooks-catalog.test.js.
    // `condition`/`once` are the two fields that qualify „Wirksam" without being `disabled` (an if-condition,
    // and runsOnce) — they travel for the same reason `disabled` does, and the end-to-end list is pinned here
    // as well so a trim and a route cannot drift apart.
    for (const h of hooks) assert.deepEqual(Object.keys(h), ['event', 'matcher', 'source', 'sourceLabel', 'type', 'text', 'background', 'disabled', 'condition', 'once']);
    assert.equal(/commandText/.test(r.body), false, 'the command text travelled twice');
    assert.equal(/"editable"/.test(r.body), false, 'the object form would travel as a boolean again');
    // the RAW source name the CLI emits for a plugin hook is `pluginHook`; „plugin" was this repo's invention
    assert.ok(hooks.some((h) => h.source === 'pluginHook' && h.sourceLabel));
    assert.ok(r.json.policy && r.json.policy.allDisabled === false);
    assert.equal(r.json.policy.policyUnreadable, false, 'the fifth policy flag never reaches the browser');
    // this emulator session is in neither mode and has no settings errors — REPORTED as such rather than
    // omitted, so the browser never has to tell „absent" from „false"
    assert.equal(r.json.safeMode, null);
    assert.equal(r.json.bareMode, null);
    assert.deepEqual(r.json.errors, []);
    await req(S.port, 'POST', `/api/chat/${id}/stop`);
  });

  it('a CLI that does not answer → 200 { unconfirmed } — the editor labels its fallback, it does not hang', async () => {
    const S2 = await startServer('echo', { FAKE_CLAUDE_HOOKS_SILENT: '1' });
    try {
      const s = await req(S2.port, 'POST', '/api/chat/start', { cwd: ROOT });
      const id = s.json.chatId;
      const r = await req(S2.port, 'GET', `/api/chat/${id}/hooks`);
      assert.equal(r.status, 200, r.body);
      assert.equal(r.json.unconfirmed, true);
      // and NOT an empty catalog, which the panel would be unable to tell from „this CLI has no hooks"
      assert.equal('eventCatalog' in r.json, false);
    } finally { await S2.stop(); }
  });

  it('reload-skills really reaches the CLI and is reported, not assumed', async () => {
    const s = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT });
    const id = s.json.chatId;
    await new Promise((r) => setTimeout(r, 200));
    const framesP = collectSSE(S.port, id, { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 150));
    const r = await req(S.port, 'POST', `/api/chat/${id}/reload-skills`, {});
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(r.json, { ok: true, unconfirmed: false });
    // fake-claude emits `_reloadskills` on arrival, so this counts what really reached the child — a route
    // that answered `ok` without writing to stdin would pass every other assertion here
    const frames = await framesP;
    assert.equal(frames.filter((f) => f.ev.type === '_reloadskills').length, 1, 'the control never reached the CLI');
    // the ANSWER (the refreshed skill list) is nobody else's business: noBroadcast, like the context read
    const leaked = frames.filter((f) => f.ev.type === 'control_response' && f.ev.response && f.ev.response.response && 'skills' in f.ev.response.response);
    assert.deepEqual(leaked, [], 'the reload answer was broadcast to every tab');
    await req(S.port, 'POST', `/api/chat/${id}/stop`);
  });

  it('both routes are 409 on a dead process and 404 on an unknown id', async () => {
    const bad = '00000000-0000-0000-0000-000000000000';
    for (const [m, path] of [['GET', 'hooks'], ['POST', 'reload-skills']]) {
      const r = await req(S.port, m, `/api/chat/${bad}/${path}`, {});
      assert.equal(r.status, 404, path + ' → ' + r.status);
      assert.equal(r.json.error, 'chat not found');
    }
    const S2 = await startServer('crash');
    try {
      const s = await req(S2.port, 'POST', '/api/chat/start', { cwd: ROOT });
      const id = s.json.chatId;
      await collectSSE(S2.port, id, { until: (x) => x.some((y) => y.ev.type === '_exit'), timeout: 4000 });
      for (const [m, path] of [['GET', 'hooks'], ['POST', 'reload-skills']]) {
        const r = await req(S2.port, m, `/api/chat/${id}/${path}`, {});
        assert.equal(r.status, 409, path + ' → ' + r.status);
        assert.equal(r.json.error, 'process not running');
      }
    } finally { await S2.stop(); }
  });
});
