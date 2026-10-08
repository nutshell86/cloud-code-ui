'use strict';
// Unit tests for the pure classification branches of lib/mcp.js parseMcpTarget (http / npm / pypi).
// The git/local branches touch the filesystem and are covered by integration/manual use, not here.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
// This suite BUILDS its own sandbox instead of inheriting verify.js's, and it must do so BEFORE requiring
// lib/mcp: lib/paths resolves CLAUDE_EXE once at require time (`CLAUDE_BIN_INFO`), so an env var set later
// changes nothing. The reason is the CLI-fallback test at the bottom — inherited, it asserted a
// precondition it could not see ("is CLAUDE_UI_FAKE_BIN set for this suite?"), and a bare
// `node --test test/mcp.test.js` would have run the REAL `claude mcp get` against the real ~/.claude.json.
// A test whose verdict depends on who started it proves nothing about the code.
const { makeSandbox } = require('./sandbox');
const SBX = makeSandbox('mcp', { fakeCli: true });
Object.assign(process.env, SBX.env);
after(() => SBX.cleanup());
const { parseMcpTarget, parseMcpGet, mcpGetPayload, mcpRawConfig } = require('../lib/mcp');

test('http/https transport → { kind: "http" }', () => {
  assert.equal(parseMcpTarget('https://example.com/mcp').kind, 'http');
  assert.equal(parseMcpTarget('http://127.0.0.1:9000/sse').kind, 'http');
});

test('npm @latest transport → { kind: "npm", pkg }', () => {
  assert.deepEqual(parseMcpTarget('npx -y @modelcontextprotocol/server-filesystem@latest /tmp'), { kind: 'npm', pkg: '@modelcontextprotocol/server-filesystem' });
  assert.deepEqual(parseMcpTarget('npx some-server@latest'), { kind: 'npm', pkg: 'some-server' });
});

test('uvx/pipx transport → { kind: "pypi", pkg } and wins over the npm @latest match', () => {
  assert.deepEqual(parseMcpTarget('uvx ha-mcp@latest'), { kind: 'pypi', pkg: 'ha-mcp' });
  assert.deepEqual(parseMcpTarget('pipx some-pkg'), { kind: 'pypi', pkg: 'some-pkg' });
  assert.deepEqual(parseMcpTarget('uv tool run my-tool@1.2.3'), { kind: 'pypi', pkg: 'my-tool' });
});

test('a bare command with no path/registry hint → { kind: "local" }', () => {
  assert.equal(parseMcpTarget('some-binary --flag').kind, 'local');
  assert.equal(parseMcpTarget('').kind, 'local');
});

// ---- F1: /api/mcp/get must not ship a single plaintext credential to the browser -------------------
// Synthetic `claude mcp get` stdout in the real layout: headers use "k: v", environment uses "K=V".
const HDR_SECRET = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghijklmnop';
const ENV_SECRET = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
const PLAIN_SECRET = 'Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0MTIzNDU2Nzg5'; // harmless key name, token-shaped value
const GET_STDOUT = [
  'jira:',
  '  Scope: User config (available in all your projects)',
  '  Status: ✔ connected',
  '  Type: http',
  '  URL: https://mcp.example.net/mcp',
  '  Headers:',
  '    x-jira-authorization: ' + HDR_SECRET,
  '    x-jira-url: https://jira.example.net',
  '    x-tenant: acme',
  '  Environment:',
  '    GH_PAT=' + ENV_SECRET,
  '    MY_HEADER=' + PLAIN_SECRET,
  '    NODE_ENV=production',
  '',
  'To remove this server, run: claude mcp remove "jira" -s user',
].join('\n');

test('parseMcpGet reads BOTH separators (headers "k: v", env "K=V")', () => {
  const d = parseMcpGet(GET_STDOUT);
  assert.equal(d.type, 'http');
  assert.equal(d.ok, true);
  assert.equal(d.status, 'connected');
  assert.deepEqual(Object.keys(d.headers), ['x-jira-authorization', 'x-jira-url', 'x-tenant']);
  assert.deepEqual(Object.keys(d.env), ['GH_PAT', 'MY_HEADER', 'NODE_ENV']);
  assert.equal(d.headers['x-tenant'], 'acme');        // short + harmless → untouched
  assert.equal(d.env.NODE_ENV, 'production');
  assert.equal(d.headers['x-jira-url'], 'https://jira.example.net'); // a URL without userinfo stays readable
});

test('mcpGetPayload: no unmasked secret survives anywhere in the response (F1)', () => {
  const payload = mcpGetPayload('jira', GET_STDOUT, null);
  const wire = JSON.stringify(payload); // exactly what the browser receives
  for (const secret of [HDR_SECRET, ENV_SECRET, PLAIN_SECRET]) {
    assert.ok(!wire.includes(secret), 'plaintext secret leaked to the client: ' + secret.slice(0, 12) + '…');
  }
  // the old leak vector: the raw `claude mcp get` stdout must not be echoed back verbatim
  assert.ok(!wire.includes('To remove this server'), 'raw CLI stdout still shipped to the client');
  // masked but still recognisable, and the copy payload keeps the CLI layout
  assert.match(payload.detail.headers['x-jira-authorization'], /••••/);
  assert.match(payload.detail.env.GH_PAT, /••••/);
  assert.equal(payload.detail.headersMeta['x-jira-authorization'].len, HDR_SECRET.length);
  assert.equal(payload.detail.envMeta.MY_HEADER.masked, true);
  assert.ok(!payload.detail.envMeta.NODE_ENV, 'a harmless value was marked masked');
  assert.match(payload.config, /^jira:\n {2}Scope: /);
  assert.match(payload.config, / {4}x-jira-authorization: /);
  assert.match(payload.config, / {4}GH_PAT=/);
  assert.equal(payload.raw, payload.config, 'legacy `raw` key must carry the masked config');
});

// ---------------------------------------------------------------- the CLI fallback of mcpRawConfig
// rawConfigFromFile wins whenever ~/.claude.json knows the server; this is the OTHER branch — a
// `.mcp.json` project server, which only `claude mcp get` can describe. It used to spawn CLAUDE_EXE
// directly, so under the sandbox it could only ever return null and its parsing had never run.
// The sandbox's ~/.claude.json carries `mcpServers: {}`, so the file lookup misses and the CLI answers.
test('mcpRawConfig falls back to the CLI and parses command/args/env out of its output', async () => {
  const cfg = await mcpRawConfig('myserver');
  assert.ok(cfg, 'the CLI fallback returned nothing — the suite\'s own sandbox (top of file) did not take');
  assert.equal(cfg.type, 'stdio');
  assert.equal(cfg.command, 'node');
  assert.equal(cfg.args, 'fake-mcp-server.js --flag');
  // UNMASKED on purpose: this config is used to SPAWN the server and never reaches the client
  // (that is what mcpGetPayload is for). A masked token here would launch a broken server.
  assert.equal(cfg.env.FAKE_MCP_TOKEN, 's3cr3t-value-not-to-be-echoed');
  assert.equal(cfg.env.FAKE_MCP_MODE, 'readonly');
});

// ---- H6: the status pill must not carry a whole CLI error, and must not lose it either -------------
// mcpShort/mcpWasCut live in public/js/views-mcp.js, a browser script — lifted out by name against the
// real turnEndClip, the same way test/agent-lanes.test.js lifts out of chat-render.js. Running the real
// functions is the point: a transcription here would pass while the view still blew up.
const fs = require('fs');
const path = require('path');
const { turnEndClip } = require('../public/js/turn-end');
const MCP_VIEW_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views-mcp.js'), 'utf8');
function loadMcpViewFn(name, env) {
  const m = MCP_VIEW_SRC.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
  assert.ok(m, name + '() not found in public/js/views-mcp.js — renamed or reindented?');
  const names = Object.keys(env || {});
  return new Function(...names, m[0] + '\nreturn ' + name + ';')(...names.map((k) => env[k]));
}
const mcpShort = loadMcpViewFn('mcpShort', { turnEndClip });
// mcpWasCut compares against mcpShort, so it gets the real one — not a second definition of "shortened"
const mcpWasCut = loadMcpViewFn('mcpWasCut', { mcpShort });
// The shape a failing stdio server actually produces: two lines, the reason on line 2. Measured length
// 161 characters — deliberately ABOVE MCP_ATTENTION_CHARS (150), because that is what makes it the fold
// case. The first version of this fixture was 147 characters, i.e. it never reached the fold at all, and
// every assertion about the fold would have passed against a plain one-line card.
const CLI_ERROR = '\u2718 failed: MCP error -32000: Connection closed\n'
  + 'spawn C:/Users/x/AppData/Roaming/npm/uvx.cmd ENOENT - check that the package is installed and on PATH (errno -4058)';

test('H6: a long CLI status is shortened for the pill (42 chars) and marked as shortened', () => {
  const short = mcpShort(CLI_ERROR, 42);
  assert.ok(short.length <= 42, 'pill text is still ' + short.length + ' chars: ' + short);
  assert.ok(short.endsWith('\u2026'), 'a shortened status must say so: ' + short);
  assert.ok(!/[\r\n]/.test(short), 'a newline in a nowrap pill is an invisible truncation');
  assert.equal(mcpWasCut(CLI_ERROR, 42), true);
  // the per-card budget keeps the first line AND the start of the reason
  assert.ok(mcpShort(CLI_ERROR, 150).includes('Connection closed'));
  // the fixture has to exceed the card budget, or the fold branch below is never entered
  assert.ok(mcpWasCut(CLI_ERROR, 150), 'the CLI_ERROR fixture fits in 150 chars — it no longer produces a fold');
});

test('H6: a status that fits is left exactly as it is — no cosmetic ellipsis', () => {
  assert.equal(mcpShort('\u25cf connected', 42), '\u25cf connected');
  assert.equal(mcpWasCut('\u25cf connected', 42), false);
  assert.equal(mcpWasCut('', 42), false);
  assert.equal(mcpShort(null, 42), '');
  assert.equal(mcpWasCut(undefined, 42), false);
  // exactly at the budget is not "too long"
  const exact = 'x'.repeat(42);
  assert.equal(mcpShort(exact, 42), exact);
  assert.equal(mcpWasCut(exact, 42), false);
});

// Found by a mutation probe: dropping mcpShort() from the pill expression left every other H6 assertion
// green, because the helper was still correct — it just was not called any more. There are TWO places
// that fill the pill (first render, and „Neu verbinden" reloading the detail), and the second one was
// exactly how this escaped in the first place.
test('H6: every assignment to the pill text goes through the shortener', () => {
  const writes = [...MCP_VIEW_SRC.matchAll(/st\.textContent = ([^;]+);/g)].map((m) => m[1]);
  assert.ok(writes.length >= 2, 'expected both pill writers, found ' + writes.length);
  for (const w of writes) {
    assert.match(w, /mcpShort\(/, 'a pill is filled with an unbounded status: st.textContent = ' + w);
    assert.match(w, /MCP_PILL_CHARS/, 'a pill uses its own budget instead of MCP_PILL_CHARS: ' + w);
  }
});

test('H6: the full error stays reachable — the view keeps it verbatim, not clipped', () => {
  // the two guarantees that make the shortening honest, read off the source: `title` gets the raw status,
  // and the fold body is written with textContent so the CLI wording survives as-is
  assert.match(MCP_VIEW_SRC, /st\.title = s\.status;/, 'the pill no longer carries the full status in its title');
  assert.match(MCP_VIEW_SRC, /body\.textContent = raw;/, 'the fold no longer shows the raw message');
  assert.ok(!/m-attention', *t\('views-mcp\.nichtErreichbar-2'\) \+ \(s\.status/.test(MCP_VIEW_SRC),
    'the old unbounded one-liner is back in the card');
});

// ---- H6, the other half: the INSTRUCTION must survive a closed fold -------------------------------
// The first version of mcpAttention() appended the „‚Neu verbinden' im Detail" hint with
// det.appendChild(…), i.e. INSIDE the <details>. A closed fold therefore showed the problem and hid the
// answer — in exactly the long-error case the fold was built for, while a short error kept the hint in the
// line and the version before this change showed it always. The tree is what decides that, so the real
// builder runs against a fake element factory (same technique as test/grant-chip.test.js).
function fakeEl(tag, cls, txt) {
  return {
    tag, className: cls || '', textContent: txt == null ? '' : String(txt), kids: [], title: '',
    appendChild(k) { this.kids.push(k); return k; },
  };
}
function walkEl(n, out) { out = out || []; out.push(n); (n.kids || []).forEach((k) => walkEl(k, out)); return out; }
const mcpAttention = loadMcpViewFn('mcpAttention', {
  el: fakeEl, t: (k) => k, mcpShort, mcpWasCut, MCP_ATTENTION_CHARS: 150,
});
const hintOf = (node) => walkEl(node).find((n) => /(^| )m-hint( |$)/.test(n.className));

test('H6: with a long error the hint is a SIBLING of the fold, not hidden inside it', () => {
  const node = mcpAttention(CLI_ERROR);
  const det = (node.kids || []).find((k) => k.tag === 'details');
  assert.ok(det, 'a long error is no longer a fold at all');
  const hint = hintOf(node);
  assert.ok(hint, 'the „Neu verbinden" hint disappeared from the card entirely');
  assert.ok(!walkEl(det).includes(hint),
    'the hint sits inside the <details> again — invisible while the fold is closed, which is the normal state');
  assert.deepEqual(node.kids.map((k) => k.tag), ['details', 'div'],
    'expected the fold and the hint side by side, got ' + node.kids.map((k) => k.tag).join(' + '));
  assert.match(hint.textContent, /neuVerbindenImDetail/, 'the hint is no longer the reconnect instruction');
  // …and at a closed fold the hover must still answer „why is it down", so the raw reason leads the tooltip
  const sum = det.kids.find((k) => k.tag === 'summary');
  assert.ok(sum.title.startsWith(CLI_ERROR), 'the summary tooltip no longer starts with the CLI reason: ' + sum.title);
  assert.match(sum.title, /vollerFehler/, 'the tooltip no longer says that there is more behind the fold');
  // the pre still holds the message character for character — that is the guarantee the fold exists for
  const pre = walkEl(det).find((n) => n.tag === 'pre');
  assert.equal(pre.textContent, CLI_ERROR);
});

test('H6: a short error keeps the hint in the line, exactly as before the change', () => {
  const node = mcpAttention('spawn uvx ENOENT');
  assert.equal(node.tag, 'div', 'a short error became a fold — there is nothing to expand');
  assert.equal(node.kids.length, 0);
  assert.match(node.textContent, /neuVerbindenImDetail$/, 'the short line lost the reconnect hint');
  assert.equal(node.title, 'spawn uvx ENOENT');
});
