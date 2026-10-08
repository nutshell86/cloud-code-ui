#!/usr/bin/env node
// Zero-dependency smoke test for the Claude Code Control Panel.
// Default (also under `node --test`): SPAWNS ITS OWN server on a random free port — never attaches
// to a long-running instance on 8787, which would silently test stale code instead of the working tree.
// Attach mode (old behavior): node smoke-test.js <port>  — or set CLAUDE_UI_PORT.
// The argv port wins over the env var: verify.js passes the port of the server IT booted, and an
// inherited CLAUDE_UI_PORT (e.g. 8787 from the shell) used to send the smoke to the live panel instead.
// The own spawn runs in the hermetic sandbox (test/sandbox.js) — fixture corpus, no real stores, no
// real CLI, GHE, CDP or npm.
// Checks that endpoints respond and served front-end modules exist. Exit 1 on failure.
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { makeSandbox } = require('./test/sandbox');

const ATTACH_PORT = process.argv[2] || process.env.CLAUDE_UI_PORT || null;
let PORT = ATTACH_PORT ? Number(ATTACH_PORT) : 0;
let child = null;
let sbx = null;
// The sandbox can only go once the server has let go of its files (Windows refuses to delete an open
// one), so wait for the exit — at most 1.5 s, the sandbox is in %TEMP% either way.
async function teardown() {
  if (child && child.exitCode == null) {
    await new Promise((r) => { child.once('exit', r); try { child.kill(); } catch { r(); } setTimeout(r, 1500); });
  }
  if (sbx) sbx.cleanup();
}

// N9 — the API token this smoke has to carry, resolved from the two places it can legitimately come from:
//  · CLAUDE_UI_API_TOKEN: what verify.js hands to the server it boots AND to this process, so the live
//    smoke runs its whole sweep against a server with the gate ON rather than around it;
//  · the token FILE, but only in attach mode — attaching means „the panel the user is running", and the
//    file is the panel's own token, readable because this runs as the same Windows account.
// Own-spawn mode needs neither: that server comes up inside the hermetic sandbox, whose env switches the
// gate off (test/sandbox.js), and reading the live user's token file there would be a real read in a test
// that promises not to make any.
function liveToken() {
  try {
    const { API_TOKEN_FILE } = require('./lib/paths');   // lazy: requiring it also resolves the claude binary
    const { readApiToken } = require('./lib/core');
    return readApiToken(API_TOKEN_FILE);
  } catch { return ''; }
}
let TOKEN = String(process.env.CLAUDE_UI_API_TOKEN || '').trim();

function get(p, timeout) {
  return new Promise((resolve, reject) => {
    const headers = TOKEN ? { 'X-CCUI-Token': TOKEN } : {};
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: timeout || 15000, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ code: res.statusCode, ct: res.headers['content-type'] || '', body: b }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + p)); });
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(true));
  });
}
async function pickFreePort() {
  for (let i = 0; i < 30; i++) { const p = 18700 + Math.floor(Math.random() * 300); if (await portFree(p)) return p; }
  throw new Error('no free port in 18700-18999');
}
async function waitForPing(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child && child.exitCode != null) throw new Error('server exited early (code ' + child.exitCode + ')');
    try { const r = await get('/api/ping', 2000); if (r.code === 200) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not come up within ' + timeoutMs + 'ms');
}

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); } }

(async () => {
  if (!ATTACH_PORT) {
    PORT = await pickFreePort();
    sbx = makeSandbox('smoke', { fakeCli: true });
    child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      cwd: __dirname,
      env: Object.assign({}, process.env, sbx.env, { CLAUDE_UI_PORT: String(PORT) }),
      stdio: 'ignore',
    });
    await waitForPing(12000);
    console.log('Smoke test → 127.0.0.1:' + PORT + ' (own spawn)\n');
  } else {
    if (!TOKEN) TOKEN = liveToken();
    console.log('Smoke test → 127.0.0.1:' + PORT + ' (attached' + (TOKEN ? ', with API token' : ', NO API token found') + ')\n');
  }

  // static shell + split modules
  const shell = await get('/');
  ok('GET / (index.html)', shell.code === 200 && /Control Panel/.test(shell.body), 'code ' + shell.code);
  // Every module the shell actually links, read out of the shell itself — the old hard-coded list of
  // six was written when there were six and silently stopped covering the other seventeen.
  const modules = [...new Set([...shell.body.matchAll(/src="\/js\/([\w-]+)\.js/g)].map((m) => m[1]))];
  ok('index links a plausible module set', modules.length >= 20, modules.length + ' modules');
  for (const m of ['render', 'chat', 'sessions', 'views', 'commands', 'boot']) ok('index links /js/' + m + '.js', modules.includes(m));
  const css = await get('/styles.css');
  ok('GET /styles.css', css.code === 200 && css.ct.includes('css'));
  for (const m of modules) {
    const r = await get('/js/' + m + '.js');
    ok('GET /js/' + m + '.js', r.code === 200 && r.ct.includes('javascript') && r.body.length > 100, 'code ' + r.code);
  }

  // API endpoints
  const state = JSON.parse((await get('/api/state')).body || '{}');
  ok('/api/state has home + defaultCwd + claudeExe', !!state.home && 'defaultCwd' in state && 'claudeExe' in state);

  const sessions = JSON.parse((await get('/api/sessions')).body || '{}');
  ok('/api/sessions returns an array', Array.isArray(sessions.sessions), 'got ' + typeof sessions.sessions);

  const usage = JSON.parse((await get('/api/usage')).body || '{}');
  const hasTokens = usage.total && ['input', 'output', 'cacheRead', 'cacheWrite'].every((k) => k in usage.total);
  ok('/api/usage returns token totals', hasTokens);
  // cost is back as a labelled ESTIMATE — total + per-day carry cost + the four cost-split components
  const splitKeys = ['cost', 'costInput', 'costOutput', 'costCacheRead', 'costCacheWrite'];
  ok('/api/usage exposes estimated cost + split', usage.total && splitKeys.every((k) => k in usage.total));

  const spend = JSON.parse((await get('/api/spend')).body || '{}');
  ok('/api/spend returns the cached snapshot shape', spend && typeof spend === 'object' && 'fetchedAt' in spend);

  // Health-checks every server via the CLI: ~4s EACH, so this grows with the user's server count
  // (measured: 37s for 9). 45s was cutting it fine in attach mode against a real config.
  const mcp = JSON.parse((await get('/api/mcp', 130000)).body || '{}');
  ok('/api/mcp returns servers', Array.isArray(mcp.servers));

  console.log('\n' + pass + ' passed, ' + fail + ' failed.');
  await teardown();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  await teardown();
  console.error('\nSmoke test error' + (ATTACH_PORT ? ' (is the server running?)' : '') + ':', e.message);
  process.exit(1);
});
