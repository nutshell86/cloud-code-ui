'use strict';
// A minimal, real stdio MCP server for the probe tests in test/mcp-probe.test.js. It speaks the two
// methods lib/mcp.js queryMcpToolsStdio uses (`initialize`, `tools/list`) and nothing else.
//
// Three knobs, all via env, so one script covers every case the probe has to get right:
//   FAKE_MCP_LOG        append-only run log. One `S <ts>` line when the process starts and one
//                       `E <ts>` line once it has answered tools/list. That is how a test MEASURES how
//                       many of these ran at the same time (the PERF-1 gate) and how many ran at all
//                       (the PERF-1 dedup) — counted from the real processes, not from a mock.
//   FAKE_MCP_ONLY       a comma-separated list of protocol revisions this server accepts. Anything else
//                       is answered with a JSON-RPC error that NAMES the protocol, which is how a strict
//                       older server behaves and what the probe's one retry exists for. Empty/unset =
//                       accept everything.
//   FAKE_MCP_FAIL_INIT  refuse initialize with a message that does NOT mention the protocol (a missing
//                       token, a bad argument) — the case the retry must NOT swallow.
//   FAKE_MCP_HOLD_MS    delay before the tools/list answer, so a test can hold slots open.
// Every initialize is logged as `I <revision>`, so a test can count the ATTEMPTS and not just the
// outcome — "it was retried once" and "it was never retried" are otherwise indistinguishable.
// The negotiated revision is reported back as `serverInfo.version`, because lib/mcp returns that as
// `result.version` — so a test can read WHICH revision the probe actually offered.
const fs = require('fs');
const readline = require('readline');

const LOG = process.env.FAKE_MCP_LOG || '';
const ONLY = String(process.env.FAKE_MCP_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const HOLD = Number(process.env.FAKE_MCP_HOLD_MS || 0);
const log = (what) => { if (LOG) { try { fs.appendFileSync(LOG, what + ' ' + Date.now() + '\n'); } catch { /* */ } } };
log('S');

let negotiated = '';
const send = (o) => { try { process.stdout.write(JSON.stringify(o) + '\n'); } catch { /* */ } };
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let o; try { o = JSON.parse(line); } catch { return; }
  if (o.method === 'initialize') {
    const asked = String((o.params && o.params.protocolVersion) || '');
    log('I ' + asked);
    if (process.env.FAKE_MCP_FAIL_INIT) {
      return send({ jsonrpc: '2.0', id: o.id, error: { code: -32001, message: 'missing credential: set FAKE_TOKEN' } });
    }
    if (ONLY.length && !ONLY.includes(asked)) {
      return send({ jsonrpc: '2.0', id: o.id, error: { code: -32602, message: 'Unsupported protocol version: ' + asked } });
    }
    negotiated = asked;
    return send({ jsonrpc: '2.0', id: o.id, result: { protocolVersion: asked, capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp-stdio', version: asked } } });
  }
  if (o.method === 'tools/list') {
    const answer = () => { send({ jsonrpc: '2.0', id: o.id, result: { tools: [{ name: 'echo', description: 'negotiated ' + negotiated }] } }); log('E'); };
    if (HOLD > 0) setTimeout(answer, HOLD); else answer();
  }
});
