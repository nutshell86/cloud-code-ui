'use strict';
// The SUCCESS branch of every route that starts the claude binary. Until the seam closed (lib/cli.js
// claudeSpawn) these eleven call sites spawned CLAUDE_EXE themselves, which meant:
//   · under the sandbox the spawn fails (CLAUDE_UI_CLAUDE_BIN points at a .js that execFile cannot
//     start), so every one of them was only ever exercised on its ERROR branch — test/cli-gate.test.js
//     covers /api/doctor, /api/auth and /api/enhance exclusively on the 503 'cli-updating' path;
//   · run WITHOUT the sandbox they resolve the machine's real binary — and POST /api/enhance runs
//     `claude -p`, i.e. a genuine, PAID model turn started by `node --test`.
// So this suite is the first time these routes answer with a real payload, and it is the reason the
// fake had to learn `doctor`, `auth status`, `mcp get/add/remove/login/logout` and the `-p` one-shot.
// Boots ONE throwaway server in the shared sandbox; CLAUDE_UI_FAKE_BIN points every spawn at the fake.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { makeSandbox } = require('./sandbox');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const h = data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {};
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch {} resolve({ status: res.statusCode, body: d, json }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function waitUp(port, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if ((await req(port, 'GET', '/api/state')).status === 200) return; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('server did not come up on :' + port);
}

describe('routes that start the claude binary — their success branch (fake bin, no cost)', () => {
  let S, sbx;
  before(async () => {
    sbx = makeSandbox('cli-routes', { fakeCli: true });
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env, ...sbx.env, CLAUDE_UI_PORT: String(port),
        // `mcp list` answers nothing by default (test/mcp-update.test.js depends on that). This suite
        // wants the PARSING path, so it opts in — one http server, one stdio server, one failing one…
        // …and since SEC-3 a fourth whose printed argv carries a credential: this is the only place a
        // real route renders a real `claude mcp list` output, so it is the only place the masking on the
        // way OUT is observable end to end.
        FAKE_CLAUDE_MCP_LIST: [
          'jira: https://jmp.example.invalid/mcp - ✔ Connected',
          'local: node C:/tmp/srv.js --flag - ✗ Failed to connect',
          'withtoken: node C:/tmp/s.js --token=supersecretvalue12345 - ✔ Connected',
          '',
        ].join('\n'),
        // …and one name `mcp get` stays silent for, so the inventory test below can reach the branch that
        // falls back to the CONFIGURED transport string (see that test).
        FAKE_CLAUDE_MCP_GET_SILENT: 'quiet',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitUp(port);
    S = { port, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }) };
  });
  after(async () => { if (S) await S.stop(); if (sbx) sbx.cleanup(); });

  // /api/enhance FIRST: it is the only route here that would otherwise cost real money.
  it('POST /api/enhance returns the improved prompt — and never reaches a real model', async () => {
    const r = await req(S.port, 'POST', '/api/enhance', { text: 'mach das besser' });
    assert.equal(r.status, 200, r.body);
    // The route wraps the user's text behind a `---` separator in a meta-prompt; the fake echoes the
    // TAIL back, so this also proves the user's text survived the wrapping intact.
    assert.equal(r.json.text, 'VERBESSERT: mach das besser');
    assert.equal(r.json.error, undefined, 'no error body on the success branch');
  });

  it('POST /api/enhance still refuses an empty body before spawning anything', async () => {
    // The route-parity sweep in integration.test.js only ever sends {} — which is why this route could
    // stay a paid one-shot unnoticed. Keep the 400 pinned next to the 200.
    for (const body of [{}, { text: '' }, { text: '   ' }]) {
      const r = await req(S.port, 'POST', '/api/enhance', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.json.error, /text required/);
    }
  });

  // S3 — the route asks about its cwd with `await pathExists` now instead of `fs.existsSync`, because the
  // sync form holds the WHOLE server for ~44 s when the path is on a share that does not answer
  // (measured; see lib/core.js pathExists). Its JUDGEMENT has to be the one it always made, and that
  // judgement is observable from outside: a cwd that is not there falls back to HOME, so the one-shot
  // still runs and answers 200. Handed through instead, the spawn would die of ENOENT and the route would
  // answer 500 — which is what makes this assertion bite rather than merely pass.
  it('POST /api/enhance still falls back to HOME for a cwd that is not there', async () => {
    const gone = path.join(sbx.root, 'no-such-cwd');
    // ...including the UNC/device SPELLING, which this route deliberately does NOT treat specially: here
    // the cwd only decides whose project settings the one-shot inherits, so there is nothing worth
    // telling the user about (unlike a whole chat session — see lib/chat.js startChat).
    // `\\?\…` is the extended form: same shape, resolved locally, so no test ever waits on a network.
    for (const cwd of [gone, '\\\\?\\' + gone]) {
      const r = await req(S.port, 'POST', '/api/enhance', { text: 'mach das besser', cwd });
      assert.equal(r.status, 200, cwd + ' → ' + r.body);
      assert.equal(r.json.text, 'VERBESSERT: mach das besser', 'the one-shot has to have actually run');
    }
    // and a cwd that IS there is still used rather than quietly swapped for HOME
    const ok = await req(S.port, 'POST', '/api/enhance', { text: 'mach das besser', cwd: sbx.root });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(ok.json.text, 'VERBESSERT: mach das besser');
  });

  it('GET /api/doctor forwards the report with status 200 and no error', async () => {
    const r = await req(S.port, 'GET', '/api/doctor');
    assert.equal(r.status, 200, r.body);
    assert.match(r.json.output, /Claude Code Doctor \(fake-claude\)/);
    assert.match(r.json.output, /Installation: ok/);
    assert.equal(r.json.error, null, 'a successful doctor run reports no error');
  });

  it('GET /api/auth parses the CLI JSON into `status` and keeps the raw text', async () => {
    const r = await req(S.port, 'GET', '/api/auth');
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.error, null);
    assert.ok(r.json.status, 'stdout that is valid JSON must arrive parsed, not only as raw');
    assert.equal(r.json.status.authenticated, true);
    assert.equal(r.json.status.account.email, 'fake@example.invalid');
    assert.match(r.json.raw, /"authenticated":true/, 'raw travels along for the "could not parse" case');
  });

  it('GET /api/mcp parses the health list into servers with transport + ok flag — and MASKS the argv', async () => {
    const r = await req(S.port, 'GET', '/api/mcp');
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.error, null);
    assert.deepEqual(r.json.servers.map((s) => [s.name, s.transport, s.ok]), [
      ['jira', 'https://jmp.example.invalid/mcp', true],
      ['local', 'node C:/tmp/srv.js --flag', false],
      // SEC-3: the row is still rendered, it just no longer carries the credential. A harmless transport
      // above it must come through BYTE-IDENTICAL — a masker that rewrites everything is a new defect.
      ['withtoken', 'node C:/tmp/s.js --token=su••••45', true],
    ]);
    assert.ok(!r.body.includes('supersecretvalue12345'), 'the plaintext argv reached the browser');
    assert.equal(r.json.servers[0].status, 'Connected', 'the tick is stripped out of the status text');
  });

  // The CONFIGURED list is the other way into the same string, and the one the MCP view paints its tiles
  // from. Two routes, one rule — and both have to be checked, because the mask sits in the route (it
  // must: the same string classifies the server for the update check, see lib/mcp mcpRowSafe).
  it('GET /api/mcp/configured masks the transport it reads out of ~/.claude.json', async () => {
    const fs = require('fs');
    const claudeJson = sbx.env.CLAUDE_UI_CLAUDE_JSON;
    const before = fs.readFileSync(claudeJson, 'utf8');
    try {
      fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: {
        plain: { command: 'npx', args: ['-y', 'some-pkg@latest'] },
        creds: { command: 'node', args: ['s.js', '--token=supersecretvalue12345'] },
        remote: { type: 'http', url: 'https://u:hunter2hunter2@mcp.example.invalid/mcp' },
      } }));
      const r = await req(S.port, 'GET', '/api/mcp/configured');
      assert.equal(r.status, 200, r.body);
      const by = {}; r.json.servers.forEach((s) => { by[s.name] = s.transport; });
      assert.equal(by.plain, 'npx -y some-pkg@latest', 'a harmless transport must not be rewritten');
      assert.equal(by.creds, 'node s.js --token=su••••45');
      assert.equal(by.remote, 'https://u:hu••••r2@mcp.example.invalid/mcp');
      assert.ok(!r.body.includes('supersecretvalue12345'));
      assert.ok(!r.body.includes('hunter2hunter2'));
    } finally { fs.writeFileSync(claudeJson, before); }
  });

  // The THIRD reader of that string, and the one the SEC-3 note claimed without a test: the Markdown
  // inventory. Its `Command:`/`URL:` lines come from `mcp get` and are masked by parseMcpGet — but its
  // `Typ:` line falls back to the CONFIGURED transport exactly when `mcp get` did NOT answer (its 12 s
  // deadline, a CLI error). That is the branch nobody looks at while things work, so it is the branch the
  // raw credential survived in. `FAKE_CLAUDE_MCP_GET_SILENT=quiet` produces that silence on purpose.
  it('GET /api/mcp/inventory masks the transport it falls back to when `mcp get` says nothing', async () => {
    const fs = require('fs');
    const claudeJson = sbx.env.CLAUDE_UI_CLAUDE_JSON;
    const before = fs.readFileSync(claudeJson, 'utf8');
    try {
      fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: {
        quiet: { command: 'node', args: ['s.js', '--token=supersecretvalue12345'] },
      } }));
      const r = await req(S.port, 'GET', '/api/mcp/inventory');
      assert.equal(r.status, 200, r.body);
      assert.match(r.body, /## quiet/, 'premise: the server must appear in the inventory at all');
      assert.match(r.body, /\*\*Typ:\*\* node s\.js --token=su••••45/, 'the fallback is the raw config string');
      assert.ok(!r.body.includes('supersecretvalue12345'), 'the plaintext argv is in the downloaded file');
    } finally { fs.writeFileSync(claudeJson, before); }
  });

  it('GET /api/mcp/get parses the config block and MASKS the secret env value', async () => {
    const r = await req(S.port, 'GET', '/api/mcp/get?name=myserver');
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.error, null);
    const d = r.json.detail;
    assert.equal(d.type, 'stdio');
    assert.equal(d.command, 'node');
    assert.equal(d.args, 'fake-mcp-server.js --flag');
    assert.equal(d.ok, true);
    assert.equal(d.status, 'connected');
    // the whole point of mcpGetPayload: `raw` is the MASKED re-serialisation, the plaintext token from
    // the CLI's stdout must not leave the server
    assert.notEqual(d.env.FAKE_MCP_TOKEN, 's3cr3t-value-not-to-be-echoed', 'a token-looking env value must be masked');
    assert.ok(d.envMeta.FAKE_MCP_TOKEN && d.envMeta.FAKE_MCP_TOKEN.masked, 'and the masking is reported');
    assert.equal(d.env.FAKE_MCP_MODE, 'readonly', 'a harmless value stays readable');
    assert.ok(!r.json.raw.includes('s3cr3t'), 'the copy-to-clipboard payload carries no plaintext secret');
    assert.ok(!r.json.config.includes('s3cr3t'));
  });

  it('POST /api/mcp/add · remove · login · logout each report the CLI output on 200', async () => {
    const cases = [
      ['/api/mcp/add', { name: 'newsrv', command: 'node', args: ['x.js'] }, /Added MCP server newsrv/],
      ['/api/mcp/remove', { name: 'newsrv' }, /Removed MCP server newsrv/],
      ['/api/mcp/logout', { name: 'newsrv' }, /Logged out of newsrv/],
    ];
    for (const [p, body, re] of cases) {
      const r = await req(S.port, 'POST', p, body);
      assert.equal(r.status, 200, p + ': ' + r.body);
      assert.equal(r.json.ok, true, p);
      assert.match(r.json.output, re, p);
    }
    // login is the odd one out: it answers 200 with ok:!err even when the OAuth flow is unfinished,
    // because the URL it prints is the only useful thing the user gets.
    const li = await req(S.port, 'POST', '/api/mcp/login', { name: 'newsrv' });
    assert.equal(li.status, 200, li.body);
    assert.equal(li.json.ok, true);
    assert.match(li.json.output, /example\.invalid\/oauth/);
    assert.equal(li.json.timedOut, false);
  });

  it('the name validation still runs BEFORE the spawn on all four mcp writes', async () => {
    for (const p of ['/api/mcp/add', '/api/mcp/remove', '/api/mcp/login', '/api/mcp/logout']) {
      const r = await req(S.port, 'POST', p, { name: 'bad name!', command: 'node' });
      assert.equal(r.status, 400, p + ' → ' + r.status);
    }
  });

  it('GET /api/skills gets the command registry out of the CLI probe', async () => {
    // lib/skills getSessionInfo spawns a stream-json session and reads the `initialize` answer — a
    // TWELFTH call site outside the seam (it is not a one-shot, so it uses lib/chat.js's seam, not
    // claudeSpawn). Until it was seamed this route answered with `error` in every test run.
    const r = await req(S.port, 'GET', '/api/skills');
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.error, null, 'the probe answered — this was an error string before the seam');
    assert.ok(Array.isArray(r.json.slashCommands) && r.json.slashCommands.includes('help'),
      'the command the fake reports from `initialize`: ' + JSON.stringify(r.json.slashCommands));
  });

  it('POST /api/bug (dry run, with diagnostics) puts the CLI version into the report', async () => {
    // server.js's bug report runs `claude --version` for its diagnostics table. dryRun returns the
    // composed body instead of opening a GHE issue, so nothing leaves the machine.
    const r = await req(S.port, 'POST', '/api/bug?dryRun=1', {
      title: 'Testbericht', description: 'nur ein Test', includeDiagnostics: true, ua: 'node-test', view: 'system',
    });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.dryRun, true);
    assert.match(r.json.bodyPreview, /\| CLI \| 9\.9\.9 \|/, 'the version the fake reports, not a "?"');
  });
});
