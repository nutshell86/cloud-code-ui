'use strict';
// GitHub Enterprise client for the Control Panel — used by the Report-Bug view (create issue)
// and the PR-status footer. Zero-dependency: node `https` only. The repo lives at your-org/claude-code-ui
// The PAT is read from a local credentials file and is NEVER logged/returned.
// NOTE: github.example.com is only reachable on the corporate VPN — off-VPN calls fail at the TLS
// handshake (schannel/ENOTFOUND); every function degrades gracefully to {error} instead of throwing.
const fs = require('fs');
const https = require('https');
const { GHE_CREDS } = require('./paths');
const { errorText } = require('./core'); // the one rule for "what of an exception may a client read"

const GHE_HOST = process.env.CLAUDE_UI_GHE_HOST || 'github.example.com';
// Declared up here because gitAuthEnv (SEC-4) scopes its header to it; the REASON the comparison is the
// whole ORIGIN and not just the host is written out at isGheTokenRemote below.
const GHE_ORIGIN = 'https://' + GHE_HOST;
const REPO_OWNER = process.env.CLAUDE_UI_REPO_OWNER || 'your-org';
const REPO = 'claude-code-ui';

let _tokenCache; // undefined = not read yet; null = read but missing/invalid; string = the token
function readGheToken() {
  if (_tokenCache !== undefined) return _tokenCache;
  try {
    const tok = (JSON.parse(fs.readFileSync(GHE_CREDS, 'utf8')) || {}).token;
    _tokenCache = (typeof tok === 'string' && tok.trim()) ? tok.trim() : null;
  } catch { _tokenCache = null; }
  return _tokenCache;
}
function tokenPresent() { return !!readGheToken(); }

// Environment for an authenticated `git` call against the GHE remote (fetch/pull/ls-remote).
//
// Two things have to be right, and the previous version had BOTH wrong, which is why the update
// button could never work — measured against the real remote:
//   · `Authorization: token <PAT>` is the REST API's scheme. Git's HTTP transport does not accept it:
//     the request comes back 401 ("could not read Username"). Git-over-HTTPS wants BASIC auth with
//     the token as the password.
//   · Without resetting `credential.helper`, the 401 sends git to the configured helper — Git
//     Credential Manager — which cannot prompt from a detached background server. It does not fail;
//     it HANGS until the caller's timeout (measured: >25s, the route allowed 60s), so the button
//     looked like it did nothing at all for a minute and then reported a generic failure.
// GIT_TERMINAL_PROMPT=0 is the belt to that braces: any remaining credential path fails in ~1s with a
// readable message instead of blocking.
//
// The token goes in via env, never as a `-c` argv element: a process command line is readable by every
// local process on Windows (Win32_Process), the environment is not.
//
// SEC-4 — the header is bound to the URL it is for. `http.extraHeader` (no url section) applies to EVERY
// http(s) request the git process makes, and the decision about the remote (gitEnvForRemote →
// isGheTokenRemote) is made about ONE url while the header rides along on all of them. The gap that
// opens: a `git fetch` in a repo with submodules fetches those too, each from its own url, inside the
// same process and the same config — so an MCP-server clone with a `.gitmodules` pointing anywhere would
// have received our PAT. Latent today and MEASURED as such (2026-10-03): neither this repo nor any of the
// four git-managed MCP-server clones under ~/.claude (sap-adt-mcp, sap-notes-mcp, sap-flp-mcp, snow-mcp)
// has a `.gitmodules`. Latent is why it is cheap to close, not a reason to leave it.
//   `http.<url>.extraHeader` is git's own url-scoped form and the scope compared is the ORIGIN, exactly
// as isGheTokenRemote compares it. MEASURED with the installed git (2.54.0.windows.1) via
// `git config --get-urlmatch http <url>`:
//     https://github.example.com/your-org/claude-code-ui.git → header present
//     https://evil.example.com/x.git                                → absent
//     http://github.example.com/x.git  (scheme downgrade)  → absent
// What this covers: any request in the same git process to a DIFFERENT origin — submodules, an
// `insteadOf` rewrite, a redirect to another host (git re-matches the config per request).
// What it does not: a submodule whose url IS our origin still gets the header, and rightly so — that is
// the same host the token belongs to. And `credential.helper` stays GLOBAL on purpose: we never want a
// Git Credential Manager window, for any remote.
function gitAuthEnv(env) {
  const token = readGheToken();
  if (!token) return null;
  const basic = 'Basic ' + Buffer.from('git:' + token).toString('base64');
  return {
    ...(env || process.env),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', // reset the helper list → no GCM prompt
    GIT_CONFIG_KEY_1: 'http.' + GHE_ORIGIN + '.extraHeader', GIT_CONFIG_VALUE_1: 'Authorization: ' + basic,
  };
}
// The same guarantee WITHOUT sending our credentials: no credential helper, no terminal prompt.
// For any git call that touches a network the panel does not own.
function gitNoPromptEnv(env) {
  return {
    ...(env || process.env),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
  };
}
// Pick the right one for a repo we did not configure — an MCP server can be a clone of anything.
// Our PAT goes out ONLY when the remote really is our GHE host; every other remote gets the neutral
// env, so a background check can never hand a corporate token to a third-party server, and can never
// open a Git Credential Manager window either (which is what these calls used to do: the MCP update
// check fetches every git-managed server, and those repos carry `credential.helper = manager`).
//
// "Really our host" is decided on the PARSED host, never on a substring of the URL. A
// `remoteUrl.includes(GHE_HOST)` test passes for remotes that are not ours at all and would have sent
// the PAT to them: https://github.example.com.evil.tld/x.git (our host as a prefix of theirs),
// https://github.example.com@evil.tld/x.git (our host as the userinfo),
// https://evil.tld/github.example.com/x.git (our host inside the path or the query).
// Parsing also makes the check case-insensitive, which the substring test was not.
function remoteHost(remoteUrl) {
  const s = String(remoteUrl == null ? '' : remoteUrl).trim();
  if (!s) return '';
  // a real URL: https://host/…, http://host/…, ssh://git@host:22/… — also covers a Windows path
  // ("C:\repo" parses with protocol "c:" and an empty hostname, i.e. no host, which is correct)
  try { const u = new URL(s); if (u.hostname) return u.hostname.toLowerCase(); } catch { /* not a URL — try git's scp form */ }
  // git's scp-like shorthand: git@host:owner/repo.git (no scheme, single colon before the path)
  const m = /^[^/\\@]*@([^/\\:]+):(?!\/)/.exec(s);
  return m ? m[1].toLowerCase() : '';
}
// exact host match — a subdomain of the GHE host is NOT the GHE host and gets no token either
function isGheRemote(remoteUrl) { return remoteHost(remoteUrl) === GHE_HOST; }

// The right host is NECESSARY but not sufficient for attaching the PAT. A host-only check still says
// yes to http://github.example.com/x.git — the same host with the transport downgraded, i.e.
// our Basic-auth header (`git:<PAT>`, base64, not encryption) on the wire in CLEARTEXT for anything on
// the path to read; and to https://github.example.com:8443/x.git, some other service on our
// host. Both are attacker-choosable here: the remote of an MCP-server clone is not ours to pick.
// So the whole ORIGIN is compared — scheme + host + port — exactly as lib/spend.js does it for the CDP
// target it evaluates a credentialed fetch in. `new URL()` normalises the default port away, so an
// explicit :443 is the same origin and any other port is not. (GHE_ORIGIN itself is declared at the top
// of the file, because gitAuthEnv needs it too.)
function isGheTokenRemote(remoteUrl) {
  if (!isGheRemote(remoteUrl)) return false; // host first: also rejects the scp/ssh forms' lookalikes
  try { return new URL(String(remoteUrl).trim()).origin.toLowerCase() === GHE_ORIGIN; } catch { return false; }
}
// ssh/scp remotes (`git@host:o/r.git`, `ssh://git@host/…`) of our own host land here as "no token" and
// that is correct, not a regression: git speaks ssh there, `http.extraHeader` is never sent on that
// transport, and the key agent does the authenticating. They only ever got the header for nothing.
function gitEnvForRemote(remoteUrl, env) {
  if (isGheTokenRemote(remoteUrl)) return gitAuthEnv(env) || gitNoPromptEnv(env);
  return gitNoPromptEnv(env);
}

// Which remote does a bare `git fetch` / `git pull` in `dir` actually contact? NOT necessarily
// `origin`: git reads `branch.<current>.remote` first and only falls back to `origin`. The PAT
// decision used to be made about `origin` while the command that carried the token named no remote at
// all — so a clone whose origin is our GHE host but whose checked-out branch tracks a different remote
// (`git branch -u upstream/main`, a triangular workflow, a fork) sent the real PAT to that OTHER host.
// Same leak as #31, reached through the git config instead of through the URL.
//
// Hard-coding `origin` into the command would close it too, but it breaks legitimate clones: on a
// branch tracking `upstream` a `git pull --ff-only origin` pulls the wrong remote (or dies with "no
// tracking information"), and a detached HEAD has no branch to resolve at all. So resolve the remote
// git itself would choose, decide the token about THAT url, and hand the resolved name back so the
// caller can pin the command to the very remote that was checked.
//
// `run` is injected (lib/core.js's run: resolves {err, stdout, stderr}, never throws) — that keeps this
// module the dependency-free leaf lib/mcp.js relies on, and makes the resolution testable without a
// real repo on disk.
async function resolveGitRemote(dir, run) {
  const git = async (...args) => { const r = await run('git', ['-C', dir, ...args]); return (r && !r.err) ? String(r.stdout || '').trim() : ''; };
  const branch = await git('symbolic-ref', '--quiet', '--short', 'HEAD'); // '' when HEAD is detached
  const configured = branch ? await git('config', '--get', 'branch.' + branch + '.remote') : '';
  const name = configured || 'origin'; // git's own default when the branch configures nothing
  const url = await git('remote', 'get-url', name);
  if (url) return { name, url };
  // get-url failed: either there is no such remote, or `branch.<b>.remote` holds a URL instead of a
  // name (git allows that, and then a bare pull talks to that URL). Take the configured value as the
  // url and name no remote — junk has no host, and no host means no token.
  return { name: '', url: configured };
}
// The env AND the remote argument for a fetch/pull in a repo the panel does not own. `args` is spread
// into the git argv so the command targets the remote the token decision was made about instead of
// re-deciding it from the branch config. (git still reads that remote's url from the config when it
// runs, so a rewrite of .git/config between this resolution and the spawn is not covered — that needs
// local write access to the repo, and no reachable panel route offers it.)
async function gitFetchTarget(dir, run, env) {
  const { name, url } = await resolveGitRemote(dir, run);
  return { name, url, args: name ? [name] : [], env: gitEnvForRemote(url, env) };
}

// Low-level GHE REST call. Resolves {status, json, error} — never throws, never exposes the token.
function gheApi(method, apiPath, body) {
  return new Promise((resolve) => {
    const token = readGheToken();
    if (!token) return resolve({ status: 0, json: null, error: 'no-token' });
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const opts = {
      host: GHE_HOST, path: '/api/v3' + apiPath, method, timeout: 20000,
      headers: {
        Authorization: 'token ' + token,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'claude-code-ui',
      },
    };
    if (payload) { opts.headers['Content-Type'] = 'application/json'; opts.headers['Content-Length'] = payload.length; }
    try {
      const rq = https.request(opts, (r) => {
        let d = ''; r.on('data', (c) => { d += c; if (d.length > 8e6) r.destroy(); });
        r.on('end', () => { let j = null; try { j = d ? JSON.parse(d) : null; } catch { /* non-JSON */ } fin({ status: r.statusCode || 0, json: j, error: null }); });
      });
      rq.on('error', (e) => fin({ status: 0, json: null, error: errorText(e) }));
      rq.on('timeout', () => { rq.destroy(); fin({ status: 0, json: null, error: 'timeout' }); });
      if (payload) rq.write(payload);
      rq.end();
    } catch (e) { fin({ status: 0, json: null, error: errorText(e) }); }
  });
}

// GET with a retry-once on *transient* failure (network error / status 0 / 5xx) + in-flight dedup + a short
// success cache. Purpose: the very first GHE call after a cold server boot (and the two concurrent boot-time
// version checks racing on a cold TLS handshake) could transiently fail → the version badge stuck on "offline"
// (#27 cold-start). Deterministic 4xx are NOT retried. GET-only — never route POST through this (createIssue
// must not double-fire on a timeout-after-write).
const _getInflight = new Map(); // apiPath -> Promise (shared while a request is in flight)
const _getCache = new Map();    // apiPath -> { at, val } (short TTL, successes only)
function gheGet(apiPath, { tries = 2, backoffMs = 350, ttlMs = 0 } = {}) {
  if (ttlMs > 0) { const c = _getCache.get(apiPath); if (c && (Date.now() - c.at) < ttlMs) return Promise.resolve(c.val); }
  if (_getInflight.has(apiPath)) return _getInflight.get(apiPath); // coalesce concurrent identical GETs
  const run = (async () => {
    let res;
    for (let i = 0; i < tries; i++) {
      res = await gheApi('GET', apiPath);
      const transient = !!res.error || res.status === 0 || res.status >= 500;
      if (!transient) break; // success or a deterministic 4xx → stop
      if (i < tries - 1) await new Promise((r) => setTimeout(r, backoffMs * (i + 1)));
    }
    if (ttlMs > 0 && res && !res.error && res.status === 200) _getCache.set(apiPath, { at: Date.now(), val: res });
    return res;
  })();
  _getInflight.set(apiPath, run);
  return run.finally(() => _getInflight.delete(apiPath));
}

function createIssue({ title, body, labels }) {
  return gheApi('POST', `/repos/${REPO_OWNER}/${REPO}/issues`, { title, body, labels: labels || [] });
}
// GitHub's /issues endpoint also returns PRs — callers filter out entries with a `pull_request` field.
function listIssues(state) {
  return gheApi('GET', `/repos/${REPO_OWNER}/${REPO}/issues?state=${state || 'open'}&per_page=20&sort=created&direction=desc`);
}
function listPulls() {
  return gheApi('GET', `/repos/${REPO_OWNER}/${REPO}/pulls?state=open&per_page=20`);
}
function pullReviews(number) {
  return gheApi('GET', `/repos/${REPO_OWNER}/${REPO}/pulls/${number}/reviews`);
}

module.exports = { GHE_HOST, GHE_ORIGIN, REPO_OWNER, REPO, readGheToken, tokenPresent, gitAuthEnv, gitNoPromptEnv, remoteHost, isGheRemote, isGheTokenRemote, gitEnvForRemote, resolveGitRemote, gitFetchTarget, gheApi, gheGet, createIssue, listIssues, listPulls, pullReviews };
