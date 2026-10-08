'use strict';
// Part of the Claude Code Control Panel front-end.
// N9 — the API token, browser side. Loaded FIRST (before i18n.js), because it has to consume `?t=` out of
// the URL before anything can fetch, and because every later module's requests go through the wrappers
// installed here.
//
// Why the token arrives in the URL at all: the gate has to stand in FRONT of the data, so the page cannot
// be the thing that hands it out — whoever may `GET /` would get the secret with it. So the ENTRY PATH
// carries it (`http://127.0.0.1:8787/?t=…`, the way Jupyter has done it for years), the launcher opens
// that URL, and this file takes it from there.
//
// Why localStorage and not sessionStorage: sessionStorage dies with the tab, so every new tab — and every
// browser restart — would need the token-bearing URL again, which in practice means „always start through
// start.cmd" and a bookmark on the bare origin that never works. localStorage survives both, so after the
// first tokened visit `http://127.0.0.1:8787` works again in THAT browser profile. The security question
// is whether that storage is readable by the attacker this whole change is about — another local account —
// and it is not: a browser profile lives under %LOCALAPPDATA% of its own user, the same ACL class as the
// token file itself (see lib/paths.js API_TOKEN_FILE for the icacls measurement).
//
// Why the token is REMOVED from the address bar: it would otherwise sit in every screenshot of the panel,
// in the tab's back/forward entry and in whatever a „share this page" button touches.
// What this does NOT do — measured 2026-10-05, real Edge, a throwaway profile, a gated sandbox server:
// after the replaceState below `location.href` has no `t=` any more, but the browser's own history
// database (`Default/History`, table `urls`) still holds the first visit WITH `?t=`. That file lives in
// the user's Edge profile, whose ACL (icacls, same day) has the same three entries as the token file's
// directory — SYSTEM, Administrators, the user — so for the attacker this change is about it opens
// nothing new. But „not in the history" would be a claim, and it is false. (Nor is the token in the
// window title: that shows document.title, measured „Claude Code · Control Panel", never the URL.)
const CCUI_TOKEN_KEY = 'ccui-api-token';
const CCUI_TOKEN_HEADER = 'X-CCUI-Token';
const CCUI_TOKEN_PARAM = 't';

// localStorage can throw (disabled by policy, a private window with storage blocked). A panel that dies on
// that is worse than one that asks for the URL again, so both accessors swallow and fall back to memory —
// the token still works for the current page load, which is the case the URL just supplied.
let CCUI_TOKEN_MEM = '';
function ccuiTokenRead() {
  try {
    // Written as a plain read into a variable, not `String(localStorage.getItem(…))`: the COR-1 guard in
    // test/views-data-guards.js treats `<ident>(localStorage.getItem(…))` as „a reader function gets a raw
    // stored value" and then looks that reader up in public/js — `String` is a built-in, so it is „defined
    // nowhere here" and the shape is reported. Nothing is lost by avoiding it (there is no parse here at
    // all), and the guard keeps its teeth for the shape it exists for.
    const stored = localStorage.getItem(CCUI_TOKEN_KEY);
    return (stored ? String(stored) : '') || CCUI_TOKEN_MEM;
  } catch { return CCUI_TOKEN_MEM; }
}
function ccuiTokenWrite(tok) {
  CCUI_TOKEN_MEM = tok || '';
  try { if (tok) localStorage.setItem(CCUI_TOKEN_KEY, tok); else localStorage.removeItem(CCUI_TOKEN_KEY); } catch { /* memory only */ }
}
function ccuiApiToken() { return ccuiTokenRead(); }

// `?t=<token>` → storage, then out of the address bar. A token in the URL always WINS over a stored one:
// that is how a rotated token (the file was deleted, the server made a new one) gets in without the user
// having to clear anything.
(function ccuiAdoptTokenFromUrl() {
  let u;
  try { u = new URL(location.href); } catch { return; }
  const tok = (u.searchParams.get(CCUI_TOKEN_PARAM) || '').trim();
  if (!tok) return;
  ccuiTokenWrite(tok);
  u.searchParams.delete(CCUI_TOKEN_PARAM);
  try { history.replaceState(null, '', u.pathname + (u.searchParams.toString() ? '?' + u.searchParams : '') + u.hash); } catch { /* no history API → the token stays visible, but works */ }
})();

// Is this request one of OURS, i.e. does the gate apply to it? Same origin AND under /api/. Everything
// else — a CDN, a doc link, the static files of this very page — is left untouched, so the wrapper cannot
// leak the token anywhere.
function ccuiIsApiUrl(raw) {
  try {
    const u = new URL(String(raw), location.href);
    return u.origin === location.origin && u.pathname.startsWith('/api/');
  } catch { return false; }
}
// For EventSource, which cannot set headers: the token goes in the query. Same-origin /api/ only.
function ccuiApiUrl(raw) {
  const tok = ccuiApiToken();
  if (!tok || !ccuiIsApiUrl(raw)) return String(raw);
  const u = new URL(String(raw), location.href);
  u.searchParams.set(CCUI_TOKEN_PARAM, tok);
  return u.pathname + '?' + u.searchParams + u.hash;
}

// ---- the two wrappers ----------------------------------------------------------------------------
// Wrapping the GLOBALS instead of editing the call sites is deliberate. Counted, not guessed: SEVEN raw
// `fetch(…)` calls live outside render.js's api() (boot.js ping · views-mcp inventory · views-system
// fetchWithTimeout/version/ping/cli-version · views-usage spend refresh), five of which carried no X-CCUI
// either, and FOUR `new EventSource('/api/chat/…')` (chat-events, commands, views-uiskills ×2). The eighth
// and the fifth will be written by someone who does not know this file exists. A per-call-site fix is a
// list that rots silently into a 401 nobody can explain; one wrapper cannot be forgotten. X-CCUI rides
// along for the same reason — it was already a per-call-site list (`withCcuiHeader`), and the raw GETs
// above never carried it.
// What the wrapper CANNOT reach: a browser NAVIGATION (`location.href = '/api/usage.csv…'`). Those have to
// call ccuiApiUrl() themselves; a guard in test/api-token.test.js keeps that class honest.
(function ccuiWrapFetch() {
  const native = window.fetch;
  if (typeof native !== 'function') return;
  window.fetch = function ccuiFetch(input, init) {
    const url = (input && typeof input === 'object' && 'url' in input) ? input.url : input;
    if (!ccuiIsApiUrl(url)) return native.call(window, input, init);
    const tok = ccuiApiToken();
    // A Request object carries its own headers; merge into a copy rather than dropping them. No call site
    // in this panel passes one today (measured), which is exactly why it is handled here and not assumed.
    if (input && typeof input === 'object' && 'url' in input) {
      const h = new Headers(input.headers || {});
      h.set('X-CCUI', '1');
      if (tok) h.set(CCUI_TOKEN_HEADER, tok);
      return native.call(window, new Request(input, { headers: h }), init);
    }
    const o = Object.assign({}, init);
    const h = new Headers(o.headers || {});
    h.set('X-CCUI', '1');
    if (tok) h.set(CCUI_TOKEN_HEADER, tok);
    o.headers = h;
    return native.call(window, input, o);
  };
})();
(function ccuiWrapEventSource() {
  const Native = window.EventSource;
  if (typeof Native !== 'function') return;
  function CcuiEventSource(url, cfg) { return new Native(ccuiApiUrl(url), cfg); }
  // the constructor returns the native instance, so the prototype is only here to keep `instanceof` and
  // the readyState constants (chat.js compares against 2 = CLOSED) true for callers
  CcuiEventSource.prototype = Native.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSED']) CcuiEventSource[k] = Native[k];
  window.EventSource = CcuiEventSource;
})();

// ---- the reader: what a page WITHOUT a valid token says -------------------------------------------
// „Eine Seite ohne Token darf nicht mit einem nackten 403 enden." The server's 401 carries the path of the
// token file and the hint; this turns it into the one screen that says what to do. Called from boot.js,
// which is where the first /api/ call happens — so this needs no probe of its own. t() exists by then,
// but NOT because of the load order next to this file: t() is defined in render.js (i18n.js, the next
// script, only holds the dictionary t() reads). What carries it is that index.html loads render.js BEFORE
// boot.js (pinned in test/api-token.test.js), and this screen is drawn only after boot.js has its first
// /api/ answer back — by then render.js has run.
function ccuiTokenGate(info) {
  const d = info || {};
  const had = !!ccuiApiToken();
  const wrap = document.createElement('div');
  wrap.id = 'ccuiTokenGate';
  wrap.setAttribute('role', 'alertdialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;'
    + 'background:var(--bg,#14161a);color:var(--fg,#e6e8ec);font:14px/1.6 system-ui,Segoe UI,sans-serif;padding:24px';
  const card = document.createElement('div');
  card.style.cssText = 'max-width:620px;border:1px solid var(--border,#2a2e36);border-radius:12px;padding:24px 28px;background:var(--panel,#1b1e24)';
  const h = document.createElement('h1');
  h.textContent = t('api-token.titel');
  h.style.cssText = 'margin:0 0 12px;font-size:19px';
  card.appendChild(h);
  const p1 = document.createElement('p');
  p1.textContent = had ? t('api-token.abgelehnt') : t('api-token.text');
  p1.style.margin = '0 0 12px';
  card.appendChild(p1);
  const p2 = document.createElement('p');
  p2.textContent = t('api-token.wegUeberStart');
  p2.style.margin = '0 0 12px';
  card.appendChild(p2);
  if (d.tokenFile) {
    const lbl = document.createElement('p');
    lbl.style.cssText = 'margin:0 0 6px;opacity:.75';
    lbl.textContent = t('api-token.tokenDatei');
    const code = document.createElement('code');
    code.textContent = String(d.tokenFile);
    code.style.cssText = 'display:block;user-select:all;word-break:break-all;padding:8px 10px;border-radius:8px;background:var(--bg,#14161a);border:1px solid var(--border,#2a2e36)';
    card.appendChild(lbl); card.appendChild(code);
  }
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:10px;margin-top:18px;flex-wrap:wrap';
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = t('api-token.neuLaden');
  reload.style.cssText = 'padding:8px 14px;border-radius:8px;border:1px solid var(--border,#2a2e36);background:var(--accent,#3b82f6);color:#fff;cursor:pointer';
  reload.onclick = () => location.reload();
  row.appendChild(reload);
  if (had) {
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.textContent = t('api-token.verwerfen');
    drop.style.cssText = 'padding:8px 14px;border-radius:8px;border:1px solid var(--border,#2a2e36);background:transparent;color:inherit;cursor:pointer';
    drop.onclick = () => { ccuiTokenWrite(''); location.reload(); };
    row.appendChild(drop);
  }
  card.appendChild(row);
  wrap.appendChild(card);
  document.body.appendChild(wrap);
  try { reload.focus(); } catch { /* */ }
  return wrap;
}
