'use strict';
// N9 — the API token: the rest of CodeQL alert #5 (CWE-200) that no path rule could reach.
//
// This suite exists because every OTHER suite runs with the gate switched OFF (test/sandbox.js sets
// CLAUDE_UI_NO_API_TOKEN=1, and says why). A guard that is off in every layer is the exact failure this
// project keeps paying for, so the servers booted HERE get an env with that variable REMOVED — which is
// also the proof that the seam is inert in production: nothing but the seam itself can switch the gate off.
//
// Pinned below, in both halves — what the token closes and what it demonstrably does not:
//   · on by default, created as a file, STABLE across restarts (a bookmark on the token URL must keep working)
//   · 401 with an ACTIONABLE body, never a bare „forbidden" — the reader, not just the refusal
//   · header for fetch/curl, `?t=` for EventSource (which cannot set headers at all)
//   · the PAGE, /js/* and /styles.css stay open WITHOUT a token — a deliberate, narrower scope, because the
//     page strips ?t= out of the address bar and a gated document would therefore break F5 — and what is
//     open that way is page code only: no data file under public/
//   · the browser side really carries it: public/js/api-token.js is EXECUTED here against a fake window,
//     so „the wrapper is installed" is measured rather than asserted about source text
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { spawn } = require('child_process');

const { makeSandbox } = require('./sandbox');
const ROOT = path.join(__dirname, '..');
const HEX64 = /^[0-9a-f]{64}$/;

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
// -> { status, body, json, ct }. `headers` go out verbatim, so a test can send a wrong token, no token, or
// the token in the query instead.
// The deadline is part of what this suite proves, not hygiene. A gate that THROWS does not answer at all:
// the throw happens before the request handler's try, server.js's process-level net logs it and keeps the
// server up, and the socket just stays open (measured with the length check in lib/core apiTokenEquals
// removed). Without a deadline that mutation does not turn a test red — it hangs the whole run, and a
// hang is not a verdict. With it (and startServer() below cleaning up after a failed boot), „no answer"
// is a failed test that says so, and the run ends.
const ANSWER_MS = 8000;   // an IDLE deadline (socket silent that long), generous for a loaded serial pass
function req(port, method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const h = Object.assign({}, headers || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = data.length; }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* text route */ } resolve({ status: res.statusCode, body: d, json, ct: res.headers['content-type'] || '' }); });
    });
    r.setTimeout(ANSWER_MS, () => r.destroy(new Error('no answer within ' + ANSWER_MS + ' ms: ' + method + ' ' + p)));
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
// An SSE stream never "ends", so the status is all we wait for — then the socket goes. Same deadline for
// the status line itself, for the same reason as req().
function sseStatus(port, p, headers) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: p, headers: headers || {} }, (res) => {
      const out = { status: res.statusCode, ct: res.headers['content-type'] || '' };
      res.resume();
      setTimeout(() => { try { r.destroy(); } catch { /* */ } resolve(out); }, 60);
    });
    const dead = setTimeout(() => r.destroy(new Error('no status line within ' + ANSWER_MS + ' ms: GET ' + p)), ANSWER_MS);
    r.on('response', () => clearTimeout(dead));
    r.on('error', (e) => { clearTimeout(dead); reject(e); });
  });
}
// Readiness for a GATED server: 200 OR 401 both mean „it is listening and the router ran". Waiting for 200
// only would hang for the full timeout and then lie („server did not come up") when the gate is doing
// exactly what it should.
// A probe that CONNECTED but got no answer is not „not up yet" — the server is listening and silent, which
// is what a gate that throws looks like (that token-less probe is exactly a wrong-length token). Saying
// so at once beats looping into a „did not come up" that names the wrong defect.
async function waitUp(port, ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await req(port, 'GET', '/api/state', {}); if (r.status === 200 || r.status === 401) return r.status; } catch (e) {
      if (/^no answer within/.test(String(e && e.message))) throw new Error('server on :' + port + ' is listening but did not ANSWER a token-less /api/state — ' + e.message);
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('server did not come up on :' + port);
}
// The point of this helper: it DELETES the sandbox's CLAUDE_UI_NO_API_TOKEN. Everything else about the
// hermetic env stays (fake CLI, temp data/~.claude dirs, no scheduler, dead CDP port, dummy GHE token).
// If the server does not come up, the child is killed BEFORE the error leaves: the caller never gets a
// handle to stop it, and a live child with piped stdio keeps this test process alive. Measured with the
// length check in lib/core apiTokenEquals removed: every startServer() test went red, and then the run
// never ENDED (killed at 90 s and at 240 s) — the servers of the failed boots were still holding it. With
// this cleanup the same mutation ends, red. A red that never finishes reads as a hang, not as a verdict.
async function startServer(sbx, extraEnv) {
  const port = await freePort();
  const env = { ...process.env, ...sbx.env, CLAUDE_UI_PORT: String(port), FAKE_CLAUDE_SCENARIO: 'echo', ...(extraEnv || {}) };
  delete env.CLAUDE_UI_NO_API_TOKEN;
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const stop = () => new Promise((r) => { if (child.exitCode != null) return r(); child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); });
  try { await waitUp(port); } catch (e) { await stop(); throw new Error(e.message + '\n--- server log ---\n' + log); }
  return { port, log: () => log, stop };
}

// ---------------------------------------------------------------------------------------------------
describe('N9 — the API token gate is ON by default', () => {
  let SBX, S, TOKEN;
  before(async () => {
    SBX = makeSandbox('apitok-on', { fakeCli: true });
    S = await startServer(SBX);
    TOKEN = fs.readFileSync(path.join(SBX.dataDir, 'api-token'), 'utf8').trim();
  });
  after(async () => { if (S) await S.stop(); if (SBX) SBX.cleanup(); });

  it('the server creates its own token file — 32 random bytes as hex, not something a caller supplied', () => {
    assert.match(TOKEN, HEX64, 'token must be 64 hex chars, got ' + TOKEN.length + ' chars');
  });

  it('the startup banner says how to get IN — and never prints the token, because it is the log', () => {
    // The bare `http://127.0.0.1:8787` answers 401 on every /api/ call now. A banner that printed only that
    // would be the „surface claims something nobody checked" failure in a single line. But this output is
    // server.log (start.ps1), and a log gets pasted and shared — so the way in, and the FILE, not the secret.
    const log = S.log();
    assert.ok(!log.includes(TOKEN), 'the token must not appear anywhere in the server output:\n' + log);
    assert.ok(log.includes('api-token'), 'banner must name the token FILE:\n' + log);
    assert.match(log, /start\.cmd/, 'banner must name the launcher that opens the token URL:\n' + log);
  });

  it('without a token /api/ is 401 — and the body says what to do, naming the file', async () => {
    for (const [method, p, body] of [['GET', '/api/state', null], ['GET', '/api/sessions', null], ['POST', '/api/chat/start', { cwd: ROOT }]]) {
      const r = await req(S.port, method, p, {}, body);
      assert.equal(r.status, 401, method + ' ' + p + ' must be 401 without a token');
      assert.equal(r.json && r.json.code, 'token-required', method + ' ' + p + ' must carry the machine code');
      // the whole point of the body: NOT a bare refusal
      assert.match(String(r.json.error), /start\.cmd|\?t=/, 'the refusal must name a way in');
      assert.ok(String(r.json.tokenFile || '').endsWith('api-token'), 'the refusal must name the token file, got ' + r.json.tokenFile);
      assert.ok(!String(r.body).includes(TOKEN), 'the refusal must NOT contain the token itself');
    }
  });

  it('a GET on /api/diff and /api/files is 401 without a token — alert #5 reached by curl, not by a page', async () => {
    // These two are the routes the alert is about: `git diff` with up to 200 000 characters of patch, and a
    // walk to depth 6, on a directory the caller names. `X-CCUI: 1` is one curl flag, so the header guard
    // never stopped another local account; this does.
    for (const route of ['/api/diff', '/api/files']) {
      const bare = await req(S.port, 'GET', route + '?cwd=' + encodeURIComponent(ROOT), { 'X-CCUI': '1' });
      assert.equal(bare.status, 401, route + ' must be 401 even WITH X-CCUI, when the token is missing');
      const withTok = await req(S.port, 'GET', route + '?cwd=' + encodeURIComponent(ROOT), { 'X-CCUI': '1', 'X-CCUI-Token': TOKEN });
      assert.equal(withTok.status, 200, route + ' must answer for the holder of the token');
    }
  });

  it('the right token in the header opens it; a wrong one of the SAME length does not', async () => {
    const good = await req(S.port, 'GET', '/api/state', { 'X-CCUI-Token': TOKEN });
    assert.equal(good.status, 200);
    assert.ok(good.json && good.json.home, 'a tokened /api/state must be the real answer');
    // same length, so the comparison cannot pass by a length shortcut — and must not throw either
    const wrong = TOKEN.slice(0, -1) + (TOKEN.endsWith('a') ? 'b' : 'a');
    assert.equal(wrong.length, TOKEN.length);
    const bad = await req(S.port, 'GET', '/api/state', { 'X-CCUI-Token': wrong });
    assert.equal(bad.status, 401, 'a wrong token must be 401, not 200 and not 500');
    const short = await req(S.port, 'GET', '/api/state', { 'X-CCUI-Token': 'x' });
    assert.equal(short.status, 401, 'a SHORT token must be 401, not a 500 out of timingSafeEqual');
  });

  it('?t= works too — the only way EventSource can carry a token', async () => {
    const q = await req(S.port, 'GET', '/api/state?t=' + TOKEN, {});
    assert.equal(q.status, 200);
    const wrongQ = await req(S.port, 'GET', '/api/state?t=' + TOKEN.slice(1), {});
    assert.equal(wrongQ.status, 401);
    // …and on the stream itself, which is what the query exists for
    const start = await req(S.port, 'POST', '/api/chat/start', { 'X-CCUI-Token': TOKEN }, { cwd: ROOT });
    assert.equal(start.status, 200, 'chat start failed: ' + start.body);
    const id = start.json.chatId;
    const open = await sseStatus(S.port, '/api/chat/' + id + '/stream?t=' + TOKEN);
    assert.equal(open.status, 200, 'the SSE stream must open with ?t=');
    assert.match(open.ct, /event-stream/);
    const closed = await sseStatus(S.port, '/api/chat/' + id + '/stream');
    assert.equal(closed.status, 401, 'the SSE stream without a token must be refused like any /api/ call');
    await req(S.port, 'POST', '/api/chat/' + id + '/stop', { 'X-CCUI-Token': TOKEN });
  });

  it('the page, its scripts and the stylesheet stay OPEN without a token — the deliberate scope', async () => {
    // Not an oversight: the page removes ?t= from the address bar, so a reload arrives without it. Gating
    // the document would break F5 unless the token also became a cookie — a second transport with its own
    // CSRF surface. A foreign local account can load the shell and gets 401 on everything it tries.
    for (const p of ['/', '/js/api-token.js', '/js/boot.js', '/styles.css']) {
      const r = await req(S.port, 'GET', p, {});
      assert.equal(r.status, 200, p + ' must stay reachable without a token');
      assert.ok(!r.body.includes(TOKEN), p + ' must not contain the token — the page may not be the thing that hands it out');
    }
  });

  // The test above pins THAT the shell is open; this pins what the security argument for it rests on —
  // server.js justifies the open scope with „markup, scripts, one stylesheet and no data". The static
  // handler serves ANY file under public/, so that sentence is only true as long as nobody drops a data
  // file in there (a fixture, an export, a cached JSON) — and the day someone does, an unauthenticated
  // local account can read it without a token. Hence a guard on the directory, not a count in a comment
  // (one stood there, „24 static files", and was wrong when it was written).
  it('what stays open is page code, not data — every file under public/ is markup, script, style or icon', () => {
    const CODE = new Set(['.html', '.js', '.css', '.svg', '.ico']);
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const files = walk(path.join(ROOT, 'public'));
    assert.ok(files.some((f) => f.endsWith('index.html')), 'the walk must actually see public/');
    const notCode = files.filter((f) => !CODE.has(path.extname(f).toLowerCase())).map((f) => path.relative(ROOT, f));
    assert.deepEqual(notCode, [], 'these are served WITHOUT a token and are not page code — move them out of public/ or gate them:\n  ' + notCode.join('\n  '));
  });

  it('an unknown /api/ path is 401 too, not 404 — the gate stands in front of the router', async () => {
    const r = await req(S.port, 'GET', '/api/does-not-exist', {});
    assert.equal(r.status, 401, 'a 404 here would confirm which routes exist to an unauthenticated caller');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('N9 — the token is stable, and the env override is honest', () => {
  it('a restart on the same data dir reuses the token — a bookmark on the token URL keeps working', async () => {
    const sbx = makeSandbox('apitok-stable', { fakeCli: true });
    const file = path.join(sbx.dataDir, 'api-token');
    let a, b;
    try {
      a = await startServer(sbx);
      const first = fs.readFileSync(file, 'utf8').trim();
      await a.stop(); a = null;
      b = await startServer(sbx);
      const second = fs.readFileSync(file, 'utf8').trim();
      assert.equal(second, first, 'a token regenerated per start would make every bookmark a one-time link');
      const r = await req(b.port, 'GET', '/api/state', { 'X-CCUI-Token': first });
      assert.equal(r.status, 200, 'the token of the FIRST run must still open the SECOND server');
    } finally { if (a) await a.stop(); if (b) await b.stop(); sbx.cleanup(); }
  });

  it('CLAUDE_UI_API_TOKEN wins and writes NO file — a scripted client must not change the user’s token', async () => {
    const sbx = makeSandbox('apitok-env', { fakeCli: true });
    const fixed = 'f'.repeat(48);
    let S;
    try {
      S = await startServer(sbx, { CLAUDE_UI_API_TOKEN: fixed });
      const ok = await req(S.port, 'GET', '/api/state', { 'X-CCUI-Token': fixed });
      assert.equal(ok.status, 200);
      const no = await req(S.port, 'GET', '/api/state', {});
      assert.equal(no.status, 401);
      assert.equal(fs.existsSync(path.join(sbx.dataDir, 'api-token')), false,
        'the override must not create or overwrite the token file');
    } finally { if (S) await S.stop(); sbx.cleanup(); }
  });
});

// ---------------------------------------------------------------------------------------------------
describe('N9 — the test seam, and that it is the ONLY way the gate goes away', () => {
  it('makeSandbox switches the gate off — that single variable, and nothing else, is the seam', () => {
    const sbx = makeSandbox('apitok-seam', {});
    try { assert.equal(sbx.env.CLAUDE_UI_NO_API_TOKEN, '1'); } finally { sbx.cleanup(); }
  });

  it('with the seam set the gate is gone; the suites above prove that WITHOUT it, it is not', async () => {
    const sbx = makeSandbox('apitok-off', { fakeCli: true });
    const port = await freePort();
    // Deliberately NOT startServer(): this is the one server in this file that keeps the seam.
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, ...sbx.env, CLAUDE_UI_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    try {
      await waitUp(port);
      const r = await req(port, 'GET', '/api/state', {});
      assert.equal(r.status, 200, 'with CLAUDE_UI_NO_API_TOKEN=1 a header-less call must pass — that is what every other server-booting suite relies on');
      assert.equal(fs.existsSync(path.join(sbx.dataDir, 'api-token')), false, 'a disabled gate must not create a token file either');
      assert.match(log, /token: DISABLED/, 'a server running WITHOUT the gate must say so on startup');
    } finally {
      await new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); });
      sbx.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// The browser half, EXECUTED rather than grepped. Same technique as test/sec-low.test.js: public/js is
// classic scripts, so a vm context with a fake window is the whole environment.
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'api-token.js'), 'utf8');
function fakeDocument() {
  const mk = (tag) => ({
    tag, style: {}, kids: [], attrs: {}, textContent: '',
    appendChild(c) { this.kids.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = v; },
    focus() { /* */ },
  });
  const body = mk('body');
  return { body, createElement: mk };
}
function flatten(node) {
  return String(node.textContent || '') + node.kids.map(flatten).join('\n');
}
// `window` IS the global in a browser, so the fake one is the context itself (ctx.window === ctx). That is
// not cosmetic: the panel's call sites write bare `fetch(…)` and `new EventSource(…)`, and they only see the
// wrappers because assigning `window.fetch` assigns the GLOBAL. A context with a separate `window` object
// would run the wrapper code happily and leave every real call site unwrapped — green for the wrong reason.
function loadClient(opts) {
  const o = opts || {};
  const store = new Map(Object.entries(o.stored || {}));
  const calls = { fetch: [], es: [], replaced: [], reloaded: 0 };
  const loc = {
    href: o.href || 'http://127.0.0.1:8787/',
    origin: 'http://127.0.0.1:8787',
    reload() { calls.reloaded++; },
  };
  const ctx = {
    console, location: loc,
    URL: globalThis.URL, Headers: globalThis.Headers, Request: globalThis.Request,
    fetch(input, init) { calls.fetch.push({ input, init }); return Promise.resolve({ ok: true }); },
    EventSource: function FakeES(url) { calls.es.push(url); this.url = url; this.readyState = 0; },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    history: { replaceState(a, b, u) { calls.replaced.push(u); loc.href = loc.origin + u; } },
    document: fakeDocument(),
    t: (k) => 'T:' + k,
    GATE_INFO: o.gateInfo || null,
  };
  ctx.window = ctx;
  ctx.EventSource.CONNECTING = 0; ctx.EventSource.OPEN = 1; ctx.EventSource.CLOSED = 2;
  vm.createContext(ctx);
  vm.runInContext(CLIENT_SRC, ctx, { filename: 'public/js/api-token.js' });
  return { ctx, calls, store, loc, run: (code) => vm.runInContext(code, ctx) };
}

describe('N9 — public/js/api-token.js, run against a fake window', () => {
  it('adopts ?t= into storage and REMOVES it from the address bar', () => {
    const c = loadClient({ href: 'http://127.0.0.1:8787/?t=abc123&view=usage' });
    assert.equal(c.store.get('ccui-api-token'), 'abc123');
    assert.deepEqual(c.calls.replaced, ['/?view=usage'], 'the token must go, the rest of the query must stay');
    assert.ok(!c.loc.href.includes('abc123'), 'the token must not be left in location.href');
  });

  it('a token in the URL WINS over a stored one — that is how a rotated token gets in', () => {
    const c = loadClient({ href: 'http://127.0.0.1:8787/?t=new', stored: { 'ccui-api-token': 'old' } });
    assert.equal(c.run('ccuiApiToken()'), 'new');
  });

  it('a stored token survives a plain reload with no ?t= at all (localStorage, not sessionStorage)', () => {
    const c = loadClient({ stored: { 'ccui-api-token': 'kept' } });
    assert.equal(c.run('ccuiApiToken()'), 'kept');
    assert.deepEqual(c.calls.replaced, [], 'nothing to strip, so no history rewrite');
  });

  it('every /api/ fetch carries BOTH headers — including the raw fetches outside api()', async () => {
    const c = loadClient({ stored: { 'ccui-api-token': 'tok1' } });
    // exactly the shapes that exist in this panel today: a bare GET, and a POST that already has headers
    await c.ctx.fetch('/api/ping', { cache: 'no-store' });
    await c.ctx.fetch('/api/spend/refresh', { method: 'POST', headers: { 'X-CCUI': '1' } });
    assert.equal(c.calls.fetch.length, 2);
    for (const call of c.calls.fetch) {
      const h = call.init.headers;
      assert.equal(h.get('X-CCUI-Token'), 'tok1');
      assert.equal(h.get('X-CCUI'), '1');
    }
    assert.equal(c.calls.fetch[1].init.method, 'POST', 'the rest of the init must survive the wrapper');
    assert.equal(c.calls.fetch[0].init.cache, 'no-store');
  });

  it('a non-/api/ request is left completely alone — the wrapper cannot leak the token', async () => {
    const c = loadClient({ stored: { 'ccui-api-token': 'tok1' } });
    await c.ctx.fetch('/js/boot.js');
    await c.ctx.fetch('https://example.invalid/x');
    for (const call of c.calls.fetch) {
      assert.ok(!call.init || !call.init.headers, 'no headers must be added: ' + JSON.stringify(call.input));
    }
  });

  // The test above cannot catch a token LEAK, and a counter-check proved it: with the same-origin comparison
  // removed from ccuiIsApiUrl the whole suite stayed 28/28 green. Its foreign URL has no /api/ in the path,
  // so it is turned away by the PATH check before the ORIGIN check is ever asked. The case that matters is a
  // foreign origin WITH an /api/ path — the shape of any third-party API a page might call — and that one
  // would have received X-CCUI-Token. Pinned here for both carriers: the header (fetch) and the query
  // (EventSource, which cannot set headers and therefore takes ?t=).
  it('a FOREIGN origin with an /api/ path gets no token either — neither as header nor as ?t=', async () => {
    const c = loadClient({ stored: { 'ccui-api-token': 'tok1' } });
    for (const foreign of ['https://example.invalid/api/state', '//example.invalid/api/state', 'http://127.0.0.1:1/api/state']) {
      await c.ctx.fetch(foreign);
      c.run('new EventSource(' + JSON.stringify(foreign) + ')');
    }
    for (const call of c.calls.fetch) {
      const h = call.init && call.init.headers;
      const hasToken = h && (typeof h.get === 'function' ? h.get('X-CCUI-Token') : (h['X-CCUI-Token'] || h['x-ccui-token']));
      assert.ok(!hasToken, 'the token was sent to a foreign origin: ' + JSON.stringify(call.input));
    }
    for (const url of c.calls.es) assert.ok(!/[?&]t=/.test(url), 'the token went into a foreign EventSource URL: ' + url);
    // …and the same-origin control, so this test cannot pass by the wrapper simply doing nothing at all
    await c.ctx.fetch('/api/state');
    const own = c.calls.fetch[c.calls.fetch.length - 1];
    const oh = own.init && own.init.headers;
    assert.ok(oh && (typeof oh.get === 'function' ? oh.get('X-CCUI-Token') : (oh['X-CCUI-Token'] || oh['x-ccui-token'])) === 'tok1',
      'control failed: the own /api/ request did not carry the token, so the assertions above prove nothing');
  });

  it('EventSource gets the token as ?t= — it cannot send a header — and keeps an existing query', () => {
    const c = loadClient({ stored: { 'ccui-api-token': 'tok1' } });
    c.run('new EventSource("/api/chat/11111111-1111-1111-1111-111111111111/stream")');
    c.run('new EventSource("/api/chat/11111111-1111-1111-1111-111111111111/stream?from=7")');
    assert.deepEqual(c.calls.es, [
      '/api/chat/11111111-1111-1111-1111-111111111111/stream?t=tok1',
      '/api/chat/11111111-1111-1111-1111-111111111111/stream?from=7&t=tok1',
    ]);
    assert.equal(c.run('EventSource.CLOSED'), 2, 'the readyState constants must survive the wrap (chat.js compares against 2)');
  });

  it('the gate SCREEN says what to do and shows the file — a reader, not a bare 403', () => {
    const file = path.join('C:\\Users\\someone\\AppData\\Local\\claude-code-ui', 'api-token');
    const c = loadClient({ gateInfo: { tokenFile: file, code: 'token-required' } });
    c.run('ccuiTokenGate(GATE_INFO)');
    const text = flatten(c.ctx.document.body);
    assert.ok(text.includes('T:api-token.titel'), 'the screen needs a heading: ' + text);
    assert.ok(text.includes('T:api-token.wegUeberStart'), 'the screen must name the way in (start.cmd)');
    assert.ok(text.includes(file), 'the screen must print the token file path it was handed');
    assert.ok(text.includes('T:api-token.text'), 'no stored token → the plain explanation');
    assert.ok(!text.includes('T:api-token.abgelehnt'), 'nothing was rejected — do not claim it was');
  });

  it('…and with a STORED token it says "rejected" and offers to drop it', () => {
    const c = loadClient({ stored: { 'ccui-api-token': 'stale' }, gateInfo: { tokenFile: 'X:\\t\\api-token' } });
    c.run('ccuiTokenGate(GATE_INFO)');
    const text = flatten(c.ctx.document.body);
    assert.ok(text.includes('T:api-token.abgelehnt'), 'a stale token is a different diagnosis: ' + text);
    assert.ok(text.includes('T:api-token.verwerfen'), 'and it needs the button that clears it');
  });

  // The label above is only half a reader: a „Gespeichertes Token verwerfen" button that reloads WITHOUT
  // dropping the token brings the same rejected token straight back, and the screen with it — a loop that
  // looks like a working button. So the click is executed, and what it leaves behind is measured.
  it('„Gespeichertes Token verwerfen" really drops the stored token, then reloads — and „Neu laden" keeps it', () => {
    const find = (node, label) => (node.textContent === label ? node : node.kids.map((k) => find(k, label)).find(Boolean) || null);
    const c = loadClient({ stored: { 'ccui-api-token': 'stale' }, gateInfo: { tokenFile: 'X:\\t\\api-token' } });
    c.run('ccuiTokenGate(GATE_INFO)');
    const reload = find(c.ctx.document.body, 'T:api-token.neuLaden');
    const drop = find(c.ctx.document.body, 'T:api-token.verwerfen');
    assert.ok(reload && typeof reload.onclick === 'function', 'the reload button must have a click handler');
    assert.ok(drop && typeof drop.onclick === 'function', 'the drop button must have a click handler');
    reload.onclick();
    assert.equal(c.calls.reloaded, 1, '„Neu laden" must reload');
    assert.equal(c.store.get('ccui-api-token'), 'stale', '„Neu laden" must NOT drop the token — that is the other button');
    drop.onclick();
    assert.equal(c.store.has('ccui-api-token'), false, 'the drop button must remove the token from localStorage');
    assert.equal(c.run('ccuiApiToken()'), '', '…and from the in-memory fallback, or the next call still sends it');
    assert.equal(c.calls.reloaded, 2, '…and then reload, so the page comes back without it');
  });
});

// Every way the BROWSER ITSELF is sent to an /api/ URL — a download button, an export link, a popup. The
// `window.fetch` wrapper is invisible to all of them, so each one has to pass through ccuiApiUrl(). Comment
// LINES are blanked (kept, not dropped, so the reported line numbers stay the real ones) because this repo
// explains itself at length and several of those explanations quote the very shape under test.
// The shapes, after the review named three that fell through: the `location.href|assign|replace` family,
// a bare `location = '/api/…'` (no `.href`), `window.open(`, a property write `.href =` / `.src =` /
// `.action =` / `.formAction =`, and `setAttribute('href'|'src'|'action'|'formaction', …)`. With
// `{ html: true }` (index.html) also the markup forms `href="/api/…"`, `src=`, `action=`, `formaction=`.
// Still single-line: a navigation whose `/api/` literal sits on a different line than the assignment is
// NOT seen. None exists today, and catching it would mean parsing JS, which this guard does not.
function unprotectedApiNavigations(src, opts) {
  const NAV = /(?:location\s*\.\s*(?:href|assign|replace)\s*(?:=|\()|\blocation\s*=(?!=)|window\s*\.\s*open\s*\(|\.\s*(?:href|src|action|formAction)\s*=(?!=)|setAttribute\s*\(\s*['"](?:href|src|action|formaction)['"])/;
  const ATTR = /\b(?:href|src|action|formaction)\s*=\s*["']\/api\//i;
  const html = !!(opts && opts.html);
  const out = [];
  src.split(/\r?\n/).map((l) => (/^\s*\/\//.test(l) ? '' : l)).forEach((l, i) => {
    if (!/['"`]\/api\//.test(l)) return;   // not about /api/ at all
    if (!NAV.test(l) && !(html && ATTR.test(l))) return; // a fetch / EventSource — covered by the wrappers
    if (/ccuiApiUrl\s*\(/.test(l)) return; // the token is put in the query by hand, which is the fix
    out.push((i + 1) + '  ' + l.trim());
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------
describe('N9 — the readers are wired up (load order + the 401 branch)', () => {
  it('index.html loads api-token.js FIRST — before i18n, render and boot', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const at = html.indexOf('/js/api-token.js');
    assert.ok(at > 0, 'index.html must load /js/api-token.js at all');
    // Identity, not position: the three files that must come after it are named, so adding a script
    // anywhere else cannot break this and reordering those three cannot pass it.
    for (const later of ['/js/i18n.js', '/js/render.js', '/js/boot.js']) {
      const i = html.indexOf(later);
      assert.ok(i > at, later + ' must load AFTER api-token.js (otherwise it can fetch before the token is adopted)');
    }
    // The gate screen calls t(), and t() lives in render.js — not in i18n.js, which is only its dictionary.
    // The screen is drawn from boot.js's first /api/ answer, so render.js has to have run by then.
    assert.ok(html.indexOf('/js/render.js') < html.indexOf('/js/boot.js'),
      'render.js (where t() is defined) must load before boot.js, which draws the gate screen');
  });

  it('boot.js turns the 401 into the gate screen instead of a toast, and stops booting', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'boot.js'), 'utf8');
    const m = /if \(e && e\.status === 401 && e\.code === 'token-required'[\s\S]{0,260}?\n\s*\}/.exec(src);
    assert.ok(m, 'the 401 branch must be in boot.js — without it the panel answers a missing token with „Backend-Fehler"');
    assert.match(m[0], /ccuiTokenGate\(/, 'it must call the gate screen');
    assert.match(m[0], /return;/, 'and it must stop boot — otherwise the ping loop polls 401 every 5 s');
  });

  it('start.ps1 opens the URL WITH the token and reads it from the same file lib/paths names', () => {
    const ps = fs.readFileSync(path.join(ROOT, 'start.ps1'), 'utf8');
    assert.match(ps, /\$tokenFile\s*=\s*Join-Path\s+\$dataDir\s+'api-token'/, 'the launcher must resolve the token file');
    assert.match(ps, /\/\?t=\$token/, 'the launcher must open the token-bearing URL');
    assert.match(ps, /Join-Path\s+\$env:LOCALAPPDATA\s+'claude-code-ui'/, 'and it must be the directory lib/paths USER_STATE_DIR uses');
    // the bare-URL fallback must still exist: a start that timed out has no file to read yet
    assert.match(ps, /Start-Process "http:\/\/127\.0\.0\.1:\$port"/, 'the no-token fallback must stay, with its hint');
  });

  // The ONE family the fetch/EventSource wrappers cannot cover: a real browser NAVIGATION. `window.fetch`
  // never sees `location.href = '/api/usage.csv…'`, so the token has to be put in the query by hand — and
  // this is a guard rather than a fixed list because the next download button is written by someone who
  // does not know that. Both existing ones were found this way (backup download, CSV export): with the gate
  // on they downloaded a 401 body instead of a file.
  it('a NAVIGATION to /api/ carries the token — the fetch wrapper cannot reach location.href', () => {
    const offenders = [];
    for (const f of fs.readdirSync(path.join(ROOT, 'public', 'js')).filter((x) => x.endsWith('.js'))) {
      for (const o of unprotectedApiNavigations(fs.readFileSync(path.join(ROOT, 'public', 'js', f), 'utf8'))) {
        offenders.push('public/js/' + f + ':' + o);
      }
    }
    // the page itself too: a link or a form in the markup navigates exactly like location.href does
    for (const o of unprotectedApiNavigations(fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'), { html: true })) {
      offenders.push('public/index.html:' + o);
    }
    assert.deepEqual(offenders, [], 'these navigate the browser to /api/ without a token — they answer 401:\n  ' + offenders.join('\n  '));
  });

  it('…and that guard can actually fail (otherwise it vouches for nothing)', () => {
    const caught = [
      "dl.onclick = () => { window.location.href = '/api/backups/download?name=' + x; };",
      "a.href = '/api/usage.csv?days=30';",
      "window.open('/api/plan?name=' + n);",
      // the three the review found falling through
      "location = '/api/backups/download?name=' + x;",
      "a.setAttribute('href', '/api/usage.csv?days=30');",
      "form.action = '/api/backups/restore';",
    ];
    for (const src of caught) assert.ok(unprotectedApiNavigations(src).length > 0, 'NOT caught: ' + src);
    const caughtHtml = [
      '<a href="/api/usage.csv?days=30">CSV</a>',
      '<form action="/api/backups/restore" method="post">',
      '<button onclick="location.href=\'/api/usage.csv\'">CSV</button>',
    ];
    for (const src of caughtHtml) assert.ok(unprotectedApiNavigations(src, { html: true }).length > 0, 'NOT caught in markup: ' + src);
    const fine = [
      "dl.onclick = () => { window.location.href = ccuiApiUrl('/api/backups/download?name=' + x); };",
      "const r = await fetch('/api/ping');",          // a fetch is the wrapper's job, not this guard's
      "// window.location.href = '/api/usage.csv' — prose about the old shape",
      "tab.es = new EventSource('/api/chat/' + id + '/stream');", // the EventSource wrapper handles this
      "if (form.action === '/api/backups/restore') return;",     // a comparison, not a navigation
    ];
    for (const src of fine) assert.deepEqual(unprotectedApiNavigations(src), [], 'false alarm on ' + src);
    // index.html mentions /api/ in prose and in a mono span — neither navigates anywhere
    assert.deepEqual(unprotectedApiNavigations('<p>Die UI pollt <span class="mono">/api/ping</span></p>', { html: true }), [], 'false alarm on a mono span');
  });

  it('lib/paths keeps the token OUT of the git checkout, and lib/core writes it 0600', () => {
    const paths = fs.readFileSync(path.join(ROOT, 'lib', 'paths.js'), 'utf8');
    const core = fs.readFileSync(path.join(ROOT, 'lib', 'core.js'), 'utf8');
    // DATA_DIR === ROOT === the panel's own checkout in production; a secret there is one `git add -A`
    // from a commit, and an untracked file there also makes POST /api/version/pull answer 409 dirty-main.
    assert.match(paths, /API_TOKEN_FILE = process\.env\.CLAUDE_UI_DATA_DIR/, 'the seam must be the ONLY thing that moves it into DATA_DIR');
    assert.match(paths, /USER_STATE_DIR = process\.env\.LOCALAPPDATA/);
    assert.match(core, /mode: 0o600/, 'the write must set 0600 — the only protection off Windows');
    assert.match(core, /mode: 0o700/, 'and 0700 on the directory it creates');
  });
});
