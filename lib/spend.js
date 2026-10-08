'use strict';
// Enterprise spend dashboard (Spend-Limit-Manager — Claude Enterprise) fetch for the Usage view.
// The API (https://ai-tool-dashboard.example.com/ai-tools/spend/api/*) sits behind SSO session
// cookies (unauthenticated → 302 /auth/login), so the server cannot call it directly. Instead we
// go through the user's logged-in DEBUG browser via CDP on :9222 (same recipe as a browser-driven REST call:
// in-page fetch with credentials:'include' uses the
// browser's network stack (trusts the corporate CA) and carries the session.
// Zero-dependency: CDP HTTP endpoints via http, Runtime.evaluate via Node's built-in WebSocket (>=22).
const http = require('http');
const { CDP_URL } = require('./paths');
const { errorText } = require('./core'); // the one rule for "what of an exception may a client read"

const CDP = new URL(CDP_URL); // 127.0.0.1:9222 unless the CLAUDE_UI_CDP_URL test seam says otherwise
const CDP_HOST = CDP.hostname;
const CDP_PORT = Number(CDP.port) || 9222;
const SPEND_ORIGIN = process.env.CLAUDE_UI_SPEND_ORIGIN || 'https://ai-tool-dashboard.example.com';
const SPEND_URL = SPEND_ORIGIN + '/ai-tools/spend';
// the exact command the UI offers when :9222 is not reachable (recipe-canonical)
const DEBUG_BROWSER_CMD = '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\\edge-debug" ' + SPEND_URL;

function cdpHttp(method, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: CDP_HOST, port: CDP_PORT, path: pathname, method, timeout: 3000 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(b ? JSON.parse(b) : null); } catch { resolve(b); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('CDP timeout')); });
    req.end();
  });
}

function spendError(code, message) { const e = new Error(message); e.code = code; return e; }

// Is this CDP target really the dashboard? Parsed origin, never a prefix test: a
// `url.startsWith(SPEND_ORIGIN)` check also accepts https://ai-tool-dashboard.example.com.evil.tld/…,
// and the tab this picks is the tab we Runtime.evaluate a credentialed fetch in — so a lookalike page
// in the debug browser would get our request and feed its own JSON into the panel's cache.
// Origin (scheme + host + port), so a plain-http page on the same host is not a match either.
function isSpendOrigin(u) {
  try { return new URL(String(u == null ? '' : u)).origin === SPEND_ORIGIN; } catch { return false; }
}

// one Runtime.evaluate over the target's websocket (awaitPromise + returnByValue)
function cdpEvaluate(wsUrl, expression, timeoutMs) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { return reject(e); }
    const to = setTimeout(() => { try { ws.close(); } catch { /* */ } reject(new Error('CDP evaluate timeout')); }, timeoutMs || 15000);
    const done = (fn, v) => { clearTimeout(to); try { ws.close(); } catch { /* */ } fn(v); };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id !== 1) return;
      if (msg.error) return done(reject, new Error(msg.error.message || 'CDP error'));
      const r = msg.result || {};
      if (r.exceptionDetails) return done(reject, new Error('page exception: ' + String((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text || '').slice(0, 200)));
      done(resolve, r.result ? r.result.value : undefined);
    };
    ws.onerror = () => done(reject, new Error('CDP websocket error'));
  });
}

// in-page fetch of the three spend endpoints; { ok:false } signals a broken/expired session
const FETCH_EXPR = '(async () => {\n'
  + "  const out = { ok: true };\n"
  + "  for (const [k, ep] of [['me','/ai-tools/spend/api/me'],['overview','/ai-tools/spend/api/overview'],['requests','/ai-tools/spend/api/requests']]) {\n"
  + "    const r = await fetch(ep, { credentials: 'include' });\n"
  + "    const ct = r.headers.get('content-type') || '';\n"
  + "    if (!r.ok || !ct.includes('json')) return { ok: false, status: r.status };\n"
  + '    out[k] = await r.json();\n'
  + '  }\n'
  + '  return out;\n'
  + '})()';

// WHICH TAB gets the credentialed fetch is the security decision of this module, so the predicate alone
// being right is not enough — this selection is what isSpendOrigin exists for. `deps` is the seam the
// test drives it through (a fake `cdp` in place of the real 127.0.0.1:9222 transport, and shortened
// timings); production calls it with no arguments and behaves exactly as before.
async function findOrOpenSpendTab(deps) {
  const cdp = (deps && deps.cdp) || cdpHttp;
  const waitMs = (deps && deps.waitMs != null) ? deps.waitMs : 20000;
  const pollMs = (deps && deps.pollMs != null) ? deps.pollMs : 1000;
  let targets;
  try { targets = await cdp('GET', '/json/list'); } catch { throw spendError('cdp-unreachable', 'Debug-Browser (CDP ' + CDP_HOST + ':' + CDP_PORT + ') nicht erreichbar'); }
  if (!Array.isArray(targets)) throw spendError('cdp-unreachable', 'Unerwartete CDP-Antwort auf /json/list');
  const existing = targets.find((t) => t.type === 'page' && isSpendOrigin(t.url) && t.webSocketDebuggerUrl);
  if (existing) return { tab: existing, created: false };
  let tab = await cdp('PUT', '/json/new?' + encodeURIComponent(SPEND_URL)); // modern Chromium requires PUT
  if (!tab || !tab.id) throw spendError('cdp-unreachable', 'CDP /json/new lieferte kein Target');
  // wait for the SSO redirect chain to land back on the dashboard origin (seamless SSO usually
  // authenticates the debug profile by itself; an interactive MFA prompt will not finish here)
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, pollMs));
    let list = [];
    try { list = await cdp('GET', '/json/list'); } catch { /* transient */ }
    const cur = (Array.isArray(list) ? list : []).find((t) => t.id === tab.id);
    if (cur && isSpendOrigin(cur.url) && cur.webSocketDebuggerUrl) return { tab: cur, created: true };
  }
  // leave the tab OPEN so the user can complete the login there
  throw spendError('auth', 'SSO-Anmeldung im Debug-Browser nicht abgeschlossen — bitte dort einmal einloggen');
}

async function fetchSpendViaCdp() {
  const { tab, created } = await findOrOpenSpendTab();
  let result;
  try { result = await cdpEvaluate(tab.webSocketDebuggerUrl, FETCH_EXPR, 15000); }
  catch (e) { throw e.code ? e : spendError('fetch-failed', errorText(e)); }
  if (!result || result.ok !== true) {
    // session expired mid-flight — keep the tab open for a manual re-login
    throw spendError('auth', 'Dashboard-Session abgelaufen (HTTP ' + ((result || {}).status || '?') + ') — im Debug-Browser neu anmelden');
  }
  if (created) { try { await cdpHttp('PUT', '/json/close/' + tab.id); } catch { try { await cdpHttp('GET', '/json/close/' + tab.id); } catch { /* */ } } }
  return result;
}

// normalize/cap the model of the dashboard payload — external content is data, never trusted markup.
// (The UI renders exclusively via textContent, this keeps the cache file bounded and typed.)
function sanitizeSpend(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const s = (v, n) => (v == null ? '' : String(v).slice(0, n || 200));
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const me = (raw.me && typeof raw.me === 'object') ? {
    name: s(raw.me.name, 120), upn: s(raw.me.upn, 120), entitled: !!raw.me.entitled,
    approver: s(raw.me.approver, 120), isApprover: !!raw.me.isApprover,
  } : null;
  const ov = (raw.overview && typeof raw.overview === 'object') ? raw.overview : {};
  const orgs = (Array.isArray(ov.orgs) ? ov.orgs : []).slice(0, 10).map((o) => ({
    name: s(o && o.name, 80), limit: num(o && o.limit), spent: num(o && o.spent),
    baseline: num(o && o.baseline), expiresAt: s(o && o.expiresAt, 40), disabled: !!(o && o.disabled),
  })).filter((o) => o.name || o.limit != null || o.spent != null);
  const pending = (ov.pending && typeof ov.pending === 'object') ? {
    amount: num(ov.pending.amount), status: s(ov.pending.status, 40), createdAt: s(ov.pending.createdAt, 40),
  } : null;
  const requests = ((raw.requests && Array.isArray(raw.requests.rows)) ? raw.requests.rows : []).slice(0, 20).map((r) => ({
    amount: num(r && r.amount), status: s(r && r.status, 40), createdAt: s(r && r.createdAt, 40),
    expiresAt: s(r && r.expiresAt, 40), decidedBy: s(r && r.decidedBy, 120),
  }));
  if (!me && !orgs.length) return null;
  return { me, orgs, pending, requests };
}

module.exports = { fetchSpendViaCdp, findOrOpenSpendTab, sanitizeSpend, isSpendOrigin, SPEND_URL, SPEND_ORIGIN, DEBUG_BROWSER_CMD };
