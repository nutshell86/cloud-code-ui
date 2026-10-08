'use strict';
// verify: serial
// The MCP tool probe against a REAL stdio server (test/fixtures/fake-mcp-stdio.js): the protocol
// revision it offers, the one retry it allows itself, and the two bounds PERF-1 is about. Serial,
// because the gate test counts how many processes overlap in time and a parallel test pass would
// compete with it for CPU — which would surface as a flake, not as a failure.
//
// Builds its own sandbox BEFORE requiring lib/mcp: lib/paths resolves CLAUDE_UI_CLAUDE_JSON once at
// require time, and every case here works by rewriting that file.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeSandbox } = require('./sandbox');

const SBX = makeSandbox('mcp-probe', { fakeCli: true });
Object.assign(process.env, SBX.env);
const CLAUDE_JSON = SBX.env.CLAUDE_UI_CLAUDE_JSON;
const SERVER = path.join(__dirname, 'fixtures', 'fake-mcp-stdio.js');
const { getMcpTools, mcpToolsCache, MCP_PROTOCOL_VERSIONS, MCP_PROBE_CONCURRENCY } = require('../lib/mcp');

let LOG;
// One server entry per name, all pointing at the same script; `env` carries the knobs.
function writeServers(map) {
  const mcpServers = {};
  for (const name of Object.keys(map)) {
    mcpServers[name] = { type: 'stdio', command: process.execPath, args: [SERVER], env: Object.assign({ FAKE_MCP_LOG: LOG }, map[name] || {}) };
  }
  fs.writeFileSync(CLAUDE_JSON, JSON.stringify({ mcpServers }));
}
const logLines = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : []);

before(() => { LOG = path.join(SBX.root, 'probe.log'); });
beforeEach(() => { mcpToolsCache.clear(); try { fs.rmSync(LOG, { force: true }); } catch { /* */ } });
// A grace before the sandbox goes: lib/mcp's probe does NOT await its own killTree (fire-and-forget by
// design), so `taskkill /T /F` for up to nine children can still be running when this file is done. This
// suite is in the SERIAL pass next to test/run-timeout.test.js, which asserts on taskkill timing — handing
// it a tail of our own kills would make somebody else's suite flaky, which is the worst kind of test debt.
after(async () => { await new Promise((r) => setTimeout(r, 1200)); SBX.cleanup(); });

describe('the protocol revision the probe offers', () => {
  it('offers the newest revision the installed CLI uses — not the four-years-old guess', async () => {
    // The fake reports the revision it was asked for as serverInfo.version, which lib/mcp returns as
    // `version`. So this asserts what went ON THE WIRE, not what a constant says.
    writeServers({ s1: {} });
    const r = await getMcpTools('s1');
    assert.equal(r.error, undefined, 'probe failed: ' + JSON.stringify(r));
    assert.equal(r.version, MCP_PROTOCOL_VERSIONS[0]);
    assert.equal(r.version, '2025-11-25', 'measured out of claude.exe 2.1.288: LATEST_PROTOCOL_VERSION / the value _legacyHandshake sends');
    assert.deepEqual(r.tools.map((t) => t.name), ['echo']);
  });

  it('a STRICT older server that refuses it still gets its tools read (the one retry)', async () => {
    // Moving four revisions forward is only safe because of this: a server that answers a JSON-RPC
    // error naming the protocol is offered the old revision once, on the same connection. Without the
    // retry this server's card would read „JSON-RPC-Fehler -32602" instead of its tool.
    writeServers({ old: { FAKE_MCP_ONLY: '2024-11-05' } });
    const r = await getMcpTools('old');
    assert.equal(r.error, undefined, 'the retry did not happen: ' + JSON.stringify(r));
    assert.equal(r.version, '2024-11-05', 'the SECOND offer is what was negotiated');
    assert.deepEqual(r.tools.map((t) => t.name), ['echo']);
    assert.equal(logLines().filter((l) => l.startsWith('S ')).length, 1, 'the retry must not cost a second spawn');
    assert.deepEqual(logLines().filter((l) => l.startsWith('I ')).map((l) => l.split(' ')[1]), MCP_PROTOCOL_VERSIONS,
      'the newest revision first, the fallback second — in that order and only once each');
  });

  it('a refusal that is NOT about the protocol is reported, never retried away', async () => {
    // The retry is keyed on the message naming the protocol. Any other refusal is a real answer from the
    // server (a missing token, a bad argument) and has to reach the card unchanged — that is #23 — and it
    // must not cost a second handshake.
    writeServers({ nope: { FAKE_MCP_FAIL_INIT: '1' } });
    const r = await getMcpTools('nope');
    assert.match(String(r.error), /JSON-RPC-Fehler -32001: missing credential/);
    assert.equal(r.tools, undefined);
    assert.equal(logLines().filter((l) => l.startsWith('I ')).length, 1, 'a non-protocol refusal must not be retried');
  });
});

describe('PERF-1 — the probe gate and the dedup', () => {
  it('two concurrent probes of the SAME server spawn it ONCE', async () => {
    // The cache is only written when a probe FINISHES, so without an in-flight map the second caller
    // started a second server. Measured on the real process count, from the fake's own run log.
    writeServers({ dup: { FAKE_MCP_HOLD_MS: '250' } });
    const [a, b] = await Promise.all([getMcpTools('dup'), getMcpTools('dup')]);
    assert.equal(a, b, 'both callers must get the SAME result object — they joined one probe');
    assert.equal(logLines().filter((l) => l.startsWith('S ')).length, 1, 'the server was spawned twice');
  });

  it('…and a later probe after the join still works (the in-flight entry is released)', async () => {
    writeServers({ again: {} });
    await getMcpTools('again');
    mcpToolsCache.clear();                       // force a real second probe
    const r = await getMcpTools('again');
    assert.equal(r.error, undefined, 'a stuck in-flight entry would hand back the old promise for ever');
    assert.equal(logLines().filter((l) => l.startsWith('S ')).length, 2);
  });

  it('never more than MCP_PROBE_CONCURRENCY servers alive at once, whoever asks', async () => {
    // The fan-out used to be bounded inside ONE route, so every other caller (GET /api/mcp/check) span up
    // as many servers as it had names. This asks lib/mcp directly — i.e. the way those callers do.
    //
    // NOT measured as "the peak overlap in the finished log": the first version of this test did that and
    // it was a FLAKE. Spawning six node processes on Windows staggers their start by ~400–600 ms each
    // while the whole hold was 220 ms, so with the gate REMOVED the measured peak came out as 5 in one run
    // and as 3 in the next — the test would have passed for a broken gate roughly half the time, which is
    // worse than no test. The hold is therefore long enough to dominate the spawn latency, and the
    // assertion is made WHILE the gate is saturated instead of afterwards.
    // FOUR servers, not six: four is the smallest set that can show „a further one did not start", and
    // this file sits in the SERIAL pass next to three kill-timing suites (run-timeout, terminate-chat,
    // session-state). MEASURED: five serial passes WITHOUT this file were green; four WITH it produced one
    // failure, in terminate-chat's tree-kill timing. One in four proves nothing on its own — but the cost of
    // being wrong is somebody else's flake, so the footprint is cut to the minimum the assertion needs.
    const names = ['g1', 'g2', 'g3', 'g4'];
    const HOLD = 3000, WATCH = 1200;
    const map = {}; names.forEach((n) => { map[n] = { FAKE_MCP_HOLD_MS: String(HOLD) }; });
    writeServers(map);
    const started = () => logLines().filter((l) => l.startsWith('S ')).length;
    const finished = () => logLines().filter((l) => l.startsWith('E ')).length;
    const all = Promise.all(names.map((n) => getMcpTools(n)));
    // wait for the gate to fill, then keep watching long enough for a further start to show up if it can
    const t0 = Date.now();
    while (started() < MCP_PROBE_CONCURRENCY && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 25));
    assert.equal(started(), MCP_PROBE_CONCURRENCY, 'the gate did not fill — did the fake fail to start?');
    await new Promise((r) => setTimeout(r, WATCH));
    assert.equal(finished(), 0, 'premise broken: a server already finished inside the watch window — raise HOLD');
    assert.equal(started(), MCP_PROBE_CONCURRENCY, 'a further server started while ' + MCP_PROBE_CONCURRENCY + ' were still running');
    // …and the queue really drains: every server is probed, not just the first MCP_PROBE_CONCURRENCY
    const rs = await all;
    rs.forEach((r, i) => assert.equal(r.error, undefined, names[i] + ' failed: ' + JSON.stringify(r)));
    assert.equal(started(), names.length, 'the gate turned into a dead end for the queued servers');
  });
});
