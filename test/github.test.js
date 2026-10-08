'use strict';
// Regression suite for "the update button does nothing".
//
// The update pull authenticated with `Authorization: token <PAT>` and left the credential helper in
// place. Measured against the real GHE remote, that combination cannot work and cannot fail fast:
//   · `token …` is the REST API scheme — git's HTTP transport answers 401
//     ("could not read Username for https://…");
//   · the 401 then goes to the configured helper, Git Credential Manager, which cannot prompt from a
//     detached background server, so `git pull` HANGS until the route's 60s timeout.
// From the UI that is indistinguishable from a dead button. These assertions pin the three properties
// that make it work: Basic auth, no credential helper, no terminal prompt.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const github = require('../lib/github');

// the GIT_CONFIG_COUNT/KEY_n/VALUE_n triplet git reads config from, as a plain object
function gitConfigOf(env) {
  const out = {};
  const n = Number(env.GIT_CONFIG_COUNT || 0);
  for (let i = 0; i < n; i++) out[env['GIT_CONFIG_KEY_' + i]] = env['GIT_CONFIG_VALUE_' + i];
  return out;
}
// SEC-4 — these assertions used to read `authHeaderOf(cfg)` by name, and that name is now the
// defect: a header set under the bare key travels to EVERY url the git process touches (submodules, an
// insteadOf rewrite, a redirect). The key is url-scoped (`http.<origin>.extraHeader`), so the tests ask
// the question they always meant — "is an Authorization header attached at all?" — and a separate test
// below pins the SCOPE. Rewritten, not deleted: every property they guarded still holds.
const AUTH_HEADER_KEY = /^http\.(.+\.)?extraheader$/i;
function authHeaderOf(cfg) {
  for (const k of Object.keys(cfg)) if (AUTH_HEADER_KEY.test(k)) return cfg[k];
  return undefined;
}
// …and the key it was set under, so the scope itself is assertable.
function authHeaderKeyOf(cfg) {
  return Object.keys(cfg).find((k) => AUTH_HEADER_KEY.test(k));
}

describe('gitAuthEnv', () => {
  it('returns null without a token, so callers can say "no-token" instead of hanging', () => {
    // no token file on this machine → the only observable is null; with one, the tests below apply
    const env = github.gitAuthEnv();
    if (!github.tokenPresent()) assert.equal(env, null);
    else assert.ok(env && typeof env === 'object');
  });

  it('authenticates with BASIC, never the REST "token" scheme git rejects', (t) => {
    const env = github.gitAuthEnv();
    if (!env) return t.skip('no GHE token on this machine');
    const cfg = gitConfigOf(env);
    const hdr = authHeaderOf(cfg) || '';
    assert.match(hdr, /^Authorization: Basic [A-Za-z0-9+/=]+$/, 'git-over-HTTPS needs Basic auth');
    assert.doesNotMatch(hdr, /Authorization: token /, 'the REST scheme makes git fall through to the credential helper');
    // the token is the password half of "git:<token>" — assert the shape, never print the value
    const decoded = Buffer.from(hdr.split(' ').pop(), 'base64').toString('utf8');
    assert.ok(decoded.startsWith('git:') && decoded.length > 'git:'.length, 'expected git:<token>');
  });

  it('disables the credential helper and the terminal prompt (the two ways it hung)', (t) => {
    const env = github.gitAuthEnv();
    if (!env) return t.skip('no GHE token on this machine');
    const cfg = gitConfigOf(env);
    assert.equal(cfg['credential.helper'], '', 'an empty value RESETS the helper list — without it GCM is asked and blocks');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0', 'any remaining credential path must fail fast, not wait for a tty');
  });

  it('keeps the token out of the process command line (env only)', (t) => {
    const env = github.gitAuthEnv();
    if (!env) return t.skip('no GHE token on this machine');
    // a command line is world-readable on Windows (Win32_Process); the environment is not. The contract
    // is simply that the secret travels in the returned env — callers pass it as `env`, not as `-c`.
    assert.ok(Number(env.GIT_CONFIG_COUNT) >= 2, 'both settings must be present in the env-based config');
  });

  // ---- SEC-4: the header is BOUND to the origin it is for -----------------------------------------
  // A bare `http.extraHeader` applies to every http(s) request the git process makes, while the
  // decision about the remote was taken for ONE url. A `git fetch` in a repo with submodules fetches
  // those too, from their own urls, in the same process and config — so the PAT travelled with them.
  it('scopes the Authorization header to the GHE ORIGIN, never to all of http.*', (t) => {
    const env = github.gitAuthEnv();
    if (!env) return t.skip('no GHE token on this machine');
    const key = authHeaderKeyOf(gitConfigOf(env));
    assert.notEqual(key, 'http.extraHeader', 'an unscoped extraHeader rides along to every url the process touches');
    assert.equal(key, 'http.' + github.GHE_ORIGIN + '.extraHeader');
    // scheme + host + port, exactly what isGheTokenRemote compares — not the host alone
    assert.match(key, /^http\.https:\/\/[^/]+\.extraheader$/i);
  });

  // …and the key only MEANS that if git agrees. `--get-urlmatch` is git's own answer to "which config
  // applies to this url", so the scope is measured against the installed git instead of assumed from
  // its documentation. Skipped where no git is on PATH; it is the same binary lib/mcp.js fetches with.
  it('and git itself resolves that key for our origin only (measured via --get-urlmatch)', (t) => {
    const env = github.gitAuthEnv();
    if (!env) return t.skip('no GHE token on this machine');
    const { spawnSync } = require('child_process');
    if (spawnSync('git', ['--version'], { encoding: 'utf8' }).status !== 0) return t.skip('no git on PATH');
    const key = authHeaderKeyOf(gitConfigOf(env));
    const urlmatch = (u) => {
      const r = spawnSync('git', ['config', '--get-urlmatch', 'http', u], {
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: 'Authorization: Basic MEASURED' },
      });
      return /Authorization: Basic MEASURED/.test(r.stdout || '');
    };
    assert.equal(urlmatch(github.GHE_ORIGIN + '/your-org/claude-code-ui.git'), true, 'our own origin must still be authenticated');
    assert.equal(urlmatch('https://evil.example.com/x.git'), false, 'a foreign submodule url must not get the header');
    assert.equal(urlmatch('http://' + github.GHE_HOST + '/x.git'), false, 'our host with the scheme downgraded is a different origin');
  });
});

describe('gitEnvForRemote — the credential window', () => {
  it('never leaves the credential helper enabled, whatever the remote is', () => {
    for (const url of [
      'https://github.example.com/your-org/snow-mcp.git',
      'https://github.com/someone/else.git',
      'git@example.org:x/y.git',
      '',
    ]) {
      const cfg = gitConfigOf(github.gitEnvForRemote(url));
      assert.equal(cfg['credential.helper'], '', 'a background fetch must never reach GCM: ' + url);
      assert.equal(github.gitEnvForRemote(url).GIT_TERMINAL_PROMPT, '0', url);
    }
  });

  it('sends our PAT to our own host only — never to a foreign remote', (t) => {
    if (!github.tokenPresent()) return t.skip('no GHE token on this machine');
    const ours = gitConfigOf(github.gitEnvForRemote('https://github.example.com/your-org/snow-mcp.git'));
    assert.match(authHeaderOf(ours) || '', /^Authorization: Basic /, 'our own host must be authenticated');
    for (const foreign of ['https://github.com/someone/else.git', 'https://gitlab.example.com/a/b.git', '']) {
      const cfg = gitConfigOf(github.gitEnvForRemote(foreign));
      assert.equal(authHeaderOf(cfg), undefined, 'a corporate PAT must not be sent to ' + (foreign || '(unknown remote)'));
    }
  });
});

// ---- alert #31 (js/incomplete-url-substring-sanitization) ----------------------------------------
// "is this our host" used to be `remoteUrl.includes(GHE_HOST)`. A substring of a URL says nothing
// about its host: every LOOKALIKE below contains our host name and is served by somebody else, and
// the token would have gone there — an MCP server can be a clone of anything, so these remotes are
// attacker-chooseable. The check parses the remote and compares the host exactly.
const GHE = 'github.example.com';
const OURS = [
  'https://' + GHE + '/your-org/claude-code-ui.git',
  'https://' + GHE + ':443/your-org/claude-code-ui.git',
  'https://user@' + GHE + '/your-org/x.git',
  'HTTPS://GITHUB.EXAMPLE.COM/your-org/x.git', // the substring test even missed this one
  'git@' + GHE + ':your-org/x.git',                     // git's scp-like shorthand
  'ssh://git@' + GHE + ':22/your-org/x.git',
];
// The subset the PAT may actually travel to: our host over https on the default port. The ssh/scp forms
// are our host as well, but git sends no HTTP header on that transport — see isGheTokenRemote.
const OURS_TOKEN = OURS.filter((u) => /^https:/i.test(u));
const OURS_SSH = OURS.filter((u) => !/^https:/i.test(u));
const LOOKALIKES = [
  'https://' + GHE + '.evil.tld/your-org/x.git', // our host as a PREFIX of theirs
  'https://' + GHE + '@evil.tld/x.git',        // our host as the userinfo
  'https://evil.tld/' + GHE + '/x.git',        // our host in the path
  'https://evil.tld/?upstream=' + GHE,         // our host in the query
  'https://evil.tld/#' + GHE,                  // our host in the fragment
  'git@' + GHE + '.evil.tld:o/r.git',
  'https://sub.' + GHE + '/x.git',             // a subdomain is not the host
];

describe('gitEnvForRemote — host match, not substring (#31)', () => {
  it('recognises every real form of the GHE remote', () => {
    for (const u of OURS) assert.equal(github.isGheRemote(u), true, 'must be recognised as ours: ' + u);
  });

  it('rejects lookalike remotes that merely CONTAIN the host name', () => {
    for (const u of LOOKALIKES) {
      assert.ok(u.includes(GHE), 'test data: a lookalike must contain the host name — ' + u);
      assert.equal(github.isGheRemote(u), false, 'not our host: ' + u);
    }
  });

  it('a remote with no host at all (local path, junk, nothing) is not ours', () => {
    for (const u of ['C:\\Users\\me\\Workspace\\repo', '/home/me/repo', '../sibling', '', null, undefined, 42]) {
      assert.equal(github.remoteHost(u), '', 'no host expected in ' + String(u));
      assert.equal(github.isGheRemote(u), false);
    }
  });

  it('no lookalike remote ever gets the PAT header', (t) => {
    if (!github.tokenPresent()) return t.skip('no GHE token on this machine');
    for (const u of LOOKALIKES) {
      const cfg = gitConfigOf(github.gitEnvForRemote(u));
      assert.equal(authHeaderOf(cfg), undefined, 'a corporate PAT must not be sent to ' + u);
    }
    for (const u of OURS_TOKEN) {
      const cfg = gitConfigOf(github.gitEnvForRemote(u));
      assert.match(authHeaderOf(cfg) || '', /^Authorization: Basic /, 'our own remote must stay authenticated: ' + u);
    }
    for (const u of OURS_SSH) {
      const cfg = gitConfigOf(github.gitEnvForRemote(u));
      assert.equal(authHeaderOf(cfg), undefined, 'git sends no HTTP header over ssh — nothing to attach: ' + u);
    }
  });
});

// ---- residual to #31: the host is not the whole url (scheme + port) -----------------------------
// `remoteHost(u) === GHE_HOST` still says yes to http://github.example.com/x.git. The header
// gitAuthEnv builds is `Authorization: Basic base64("git:<PAT>")` — base64 is not encryption, so over
// plain http the corporate PAT is readable by anything on the path. An MCP server's remote is not ours to
// choose, and `git remote set-url` is one command away, so this is reachable, not theoretical.
describe('gitEnvForRemote — https on the expected port, not just the right host', () => {
  const DOWNGRADED = [
    'http://' + GHE + '/your-org/x.git',              // cleartext PAT on the wire
    'HTTP://GITHUB.EXAMPLE.COM/your-org/x.git',
    'http://user@' + GHE + '/your-org/x.git',
    'https://' + GHE + ':8443/your-org/x.git',        // our host, but some other service on it
    'https://' + GHE + ':80/your-org/x.git',
    'git://' + GHE + '/your-org/x.git',               // git protocol: unauthenticated and unencrypted
  ];

  it('test data: every one of these IS our host — the difference is only the transport', () => {
    for (const u of DOWNGRADED) assert.equal(github.isGheRemote(u), true, 'host must be ours: ' + u);
  });

  it('none of them is token-eligible', () => {
    for (const u of DOWNGRADED) assert.equal(github.isGheTokenRemote(u), false, 'no PAT over ' + u);
  });

  it('and none of them receives the PAT header — no cleartext token, still no credential window', (t) => {
    if (!github.tokenPresent()) return t.skip('no GHE token on this machine');
    for (const u of DOWNGRADED) {
      const cfg = gitConfigOf(github.gitEnvForRemote(u));
      assert.equal(authHeaderOf(cfg), undefined, 'a corporate PAT must not be sent to ' + u);
      assert.equal(cfg['credential.helper'], '', 'and it must still not be able to prompt: ' + u);
    }
  });

  it('https on our host stays eligible (default port, explicit :443, userinfo, any case)', () => {
    for (const u of OURS_TOKEN) assert.equal(github.isGheTokenRemote(u), true, 'must stay ours: ' + u);
    for (const u of [...LOOKALIKES, ...OURS_SSH, '', null, undefined, 'C:\\Users\\me\\repo']) {
      assert.equal(github.isGheTokenRemote(u), false, 'not token-eligible: ' + String(u));
    }
  });
});

// ---- residual to #31: the token decision followed `origin`, the git command followed the branch ---
// `git pull` / `git fetch` without a remote argument contact branch.<current>.remote and only fall back
// to `origin`. The panel resolved origin's url, decided the PAT about it, and then ran a bare pull — so
// a clone whose origin is our GHE host while its branch tracks somebody else's fork sent the real PAT to
// that fork's host. resolveGitRemote answers the question git itself answers, and gitFetchTarget names
// the resolved remote in the argv so the checked url and the contacted host cannot diverge.
//
// `run` is injected, so this needs no repo on disk: the fake answers exactly the three queries git is
// asked, including their real failure modes (detached HEAD → symbolic-ref exits non-zero; an unset
// branch.<b>.remote → `git config --get` exits 1; an unknown remote → get-url errors).
function fakeGit({ branch, trackingRemote, remotes }) {
  const calls = [];
  const okR = (s) => ({ err: null, stdout: s, stderr: '' });
  const errR = (msg) => ({ err: new Error(msg), stdout: '', stderr: msg });
  const run = async (cmd, args) => {
    assert.equal(cmd, 'git');
    assert.equal(args[0], '-C', 'every git call must name the repo dir');
    const a = args.slice(2);
    calls.push(a.join(' '));
    if (a[0] === 'symbolic-ref') return branch ? okR(branch) : errR('fatal: ref HEAD is not a symbolic ref');
    if (a[0] === 'config') {
      assert.equal(a[2], 'branch.' + branch + '.remote');
      return trackingRemote ? okR(trackingRemote) : errR('exit 1: not set');
    }
    if (a[0] === 'remote' && a[1] === 'get-url') {
      return (remotes || {})[a[2]] ? okR(remotes[a[2]]) : errR("error: No such remote '" + a[2] + "'");
    }
    throw new Error('unexpected git call: ' + a.join(' '));
  };
  return { run, calls };
}
const GHE_URL = 'https://' + GHE + '/your-org/snow-mcp.git';

describe('gitFetchTarget — the remote the command will really contact (#31, via the git config)', () => {
  it('the ordinary clone: origin is resolved, named in the argv, and authenticated', async (t) => {
    const { run, calls } = fakeGit({ branch: 'main', trackingRemote: 'origin', remotes: { origin: GHE_URL } });
    const tgt = await github.gitFetchTarget('C:\\repo', run);
    assert.equal(tgt.name, 'origin');
    assert.equal(tgt.url, GHE_URL);
    assert.deepEqual(tgt.args, ['origin'], 'the remote must be named, not left to the config');
    assert.ok(calls.some((c) => c.startsWith('symbolic-ref')), 'it has to ASK which branch is checked out');
    if (!github.tokenPresent()) return t.skip('no GHE token on this machine — env asserted below instead');
    assert.match(authHeaderOf(gitConfigOf(tgt.env)) || '', /^Authorization: Basic /);
  });

  it('a branch tracking a FOREIGN remote gets no PAT, even though origin is our GHE host', async () => {
    const remotes = { origin: GHE_URL, upstream: 'https://github.com/someone/snow-mcp.git' };
    const { run } = fakeGit({ branch: 'main', trackingRemote: 'upstream', remotes });
    // the trap: the url the old code looked at WAS ours, so it attached the token…
    assert.equal(github.isGheTokenRemote(remotes.origin), true);
    // …while the bare `git pull` it ran went to `upstream`, i.e. to github.com
    const tgt = await github.gitFetchTarget('C:\\repo', run);
    assert.equal(tgt.name, 'upstream');
    assert.equal(tgt.url, remotes.upstream);
    assert.deepEqual(tgt.args, ['upstream']);
    assert.equal(authHeaderOf(gitConfigOf(tgt.env)), undefined, 'a corporate PAT must not reach github.com');
    assert.equal(gitConfigOf(tgt.env)['credential.helper'], '');
    assert.equal(tgt.env.GIT_TERMINAL_PROMPT, '0');
  });

  it('falls back to origin exactly where git does: no branch.<b>.remote, and a detached HEAD', async () => {
    const untracked = await github.gitFetchTarget('C:\\repo', fakeGit({ branch: 'wip', trackingRemote: '', remotes: { origin: GHE_URL } }).run);
    assert.deepEqual([untracked.name, untracked.url], ['origin', GHE_URL]);
    const detached = await github.gitFetchTarget('C:\\repo', fakeGit({ branch: '', trackingRemote: '', remotes: { origin: GHE_URL } }).run);
    assert.deepEqual([detached.name, detached.url], ['origin', GHE_URL], 'a detached HEAD has no branch config to read');
  });

  it('branch.<b>.remote may hold a URL instead of a name — that url is what gets checked', async () => {
    const { run } = fakeGit({ branch: 'main', trackingRemote: 'https://evil.tld/x.git', remotes: { origin: GHE_URL } });
    const tgt = await github.gitFetchTarget('C:\\repo', run);
    assert.equal(tgt.url, 'https://evil.tld/x.git', 'not origin — git would talk to the configured url');
    assert.deepEqual(tgt.args, [], 'a url is not a remote name, so the command stays bare (git resolves it the same way)');
    assert.equal(authHeaderOf(gitConfigOf(tgt.env)), undefined);
  });

  it('a repo with no usable remote at all fails closed: no name, no url, no token', async () => {
    const { run } = fakeGit({ branch: 'main', trackingRemote: '', remotes: {} });
    const tgt = await github.gitFetchTarget('C:\\repo', run);
    assert.deepEqual([tgt.name, tgt.url, tgt.args], ['', '', []]);
    assert.equal(authHeaderOf(gitConfigOf(tgt.env)), undefined);
    assert.equal(gitConfigOf(tgt.env)['credential.helper'], '', 'and it must not be able to open a credential window');
  });

  it('a plain-http origin of our own host is resolved but not authenticated', async () => {
    const { run } = fakeGit({ branch: 'main', trackingRemote: 'origin', remotes: { origin: 'http://' + GHE + '/your-org/x.git' } });
    const tgt = await github.gitFetchTarget('C:\\repo', run);
    assert.deepEqual(tgt.args, ['origin']);
    assert.equal(authHeaderOf(gitConfigOf(tgt.env)), undefined, 'no cleartext PAT, not even to our own host');
  });
});
