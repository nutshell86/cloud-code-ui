'use strict';
// PR-13 end to end through a real `node server.js` (fake-claude `budget`): what a TAB sees of the cost
// brake. The start route hands the budget to the chat, the brake's `_budget` frames arrive on the SSE stream
// (counting the workflow agent's own transcript), and once it has tripped a new message is REFUSED with
// `budget-reached` — not started and interrupted again a poll later.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { makeSandbox, FAKE } = require('./sandbox');

const ROOT = path.join(__dirname, '..');
const SBX = makeSandbox('budgetroute', { fakeCli: true });
let S = null;
after(async () => { if (S) await S.stop(); SBX.cleanup(); });

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* */ } resolve({ status: res.statusCode, body: d, json }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...SBX.env, CLAUDE_UI_PORT: String(port), CLAUDE_UI_FAKE_BIN: FAKE, FAKE_CLAUDE_SCENARIO: 'budget', CLAUDE_UI_BUDGET_POLL_MS: '150' },
  });
  let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  const t0 = Date.now();
  for (;;) {
    try { if ((await req(port, 'GET', '/api/state')).status === 200) break; } catch { /* not up yet */ }
    if (Date.now() - t0 > 12000) throw new Error('server did not come up on :' + port + '\n' + log);
    await new Promise((r) => setTimeout(r, 150));
  }
  return { port, log: () => log, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }) };
}
// the chat's SSE stream from its start (a first connect replays the buffer), until `until(frames)` holds
function frames(port, chatId, until, timeout = 15000) {
  return new Promise((resolve) => {
    const got = []; let done = false;
    const fin = () => { if (done) return; done = true; try { r.destroy(); } catch { /* */ } resolve(got); };
    const r = http.get({ host: '127.0.0.1', port, path: '/api/chat/' + chatId + '/stream' }, (res) => {
      res.setEncoding('utf8'); let buf = '';
      res.on('data', (c) => {
        buf += c; let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const dl = block.split('\n').find((l) => l.startsWith('data:'));
          if (!dl) continue;
          try { got.push(JSON.parse(dl.slice(5).trim())); } catch { continue; }
          if (until(got)) fin();
        }
      });
    });
    r.on('error', fin);
    setTimeout(fin, timeout);
  });
}

describe('the cost brake through the server', () => {
  it('reports on the stream, trips on the workflow\'s spend, and refuses the next message with budget-reached', async () => {
    S = await startServer();
    const s = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, maxBudgetUsd: 0.2 });
    assert.equal(s.status, 200, s.body);
    const chatId = s.json.chatId;
    const tripped = frames(S.port, chatId, (f) => f.some((e) => e.type === '_budget' && e.tripped));
    await new Promise((r) => setTimeout(r, 250));
    assert.equal((await req(S.port, 'POST', '/api/chat/' + chatId + '/send', { text: 'los' })).status, 200);
    const f = await tripped;
    const reports = f.filter((e) => e.type === '_budget');
    assert.ok(reports.length >= 2, 'the count is reported while it grows, not only at the trip:\n' + S.log());
    const trip = reports.find((e) => e.tripped);
    assert.ok(trip, 'tripped on the stream');
    assert.equal(trip.limitUsd, 0.2);
    assert.ok(trip.parts.workflows > trip.parts.main, 'most of it was the workflow agent — the part --max-budget-usd never sees');
    assert.ok(trip.stopped.some((x) => x.id === 'wftask1' && x.ok), 'the workflow task was stopped');
    const again = await req(S.port, 'POST', '/api/chat/' + chatId + '/send', { text: 'weiter' });
    assert.equal(again.status, 409);
    assert.equal(again.json.error, 'budget-reached');
    assert.ok(again.json.spentUsd >= 0.2 && again.json.limitUsd === 0.2, JSON.stringify(again.json));
  });
});
