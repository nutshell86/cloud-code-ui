'use strict';
// P4 „Repos & PRs" — lib/project-repos.js, its parsers in lib/pure.js and GET /api/projects/repos.
//
// What has to hold, and the defect each block guards against:
//   · the parsers read every shape git writes: ahead/behind, `[gone]`, no upstream, detached, a fresh repo; worktree
//     blocks with branch / detached / bare; the remote in its https, userinfo, ssh and scp forms — and nothing else
//     counts as owner/repo (a third segment, `..`, an odd character).
//   · only local folders are asked: UNC and the paths the last save warned about are skipped without a git call.
//   · GHE offline (status 0) leaves the git half intact and says `offline`; no token → `no-token`; another host →
//     `not-ghe` with no GHE call at all; a slow review keeps the list and says `partial` after the deadline.
//   · the serialised answer never carries the remote URL's userinfo or the token, and a PR link only on the GHE origin.
//   · the route: 400 malformed id, 404 unknown, 200 for a project without folders.
// Hermetic: the lib tests use a fake `run` and a fake `gheGet` (no repo, no network); the route boots a sandbox server.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { makeSandbox } = require('./sandbox');

const ROOT = path.join(__dirname, '..');
const SBX = makeSandbox('repos', { fakeCli: true });
Object.assign(process.env, SBX.env); // before the first require of lib/paths
const { parseBranchHeader, parseWorktreePorcelain, parseGheRepo } = require('../lib/pure');
const R = require('../lib/project-repos');
const { GHE_HOST } = require('../lib/github');
const { PROJECTS_FILE } = require('../lib/paths');
after(() => SBX.cleanup());

describe('parseBranchHeader — the `##` line of git status --porcelain --branch', () => {
  const T = [
    ['## main...origin/main [ahead 2, behind 1]', { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, gone: false, detached: false }],
    ['## main...origin/main [behind 3]', { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 3, gone: false, detached: false }],
    ['## feat/x...origin/feat/x [gone]', { branch: 'feat/x', upstream: 'origin/feat/x', ahead: 0, behind: 0, gone: true, detached: false }],
    ['## main...origin/main', { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, gone: false, detached: false }],
    ['## main', { branch: 'main', upstream: '', ahead: 0, behind: 0, gone: false, detached: false }],
    ['## HEAD (no branch)', { branch: 'HEAD', upstream: '', ahead: 0, behind: 0, gone: false, detached: true }],
    ['## No commits yet on main', { branch: 'main', upstream: '', ahead: 0, behind: 0, gone: false, detached: false }],
    ['## main...origin/main [ahead 1]\n M a.txt\n?? b.txt', { branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0, gone: false, detached: false }],
    ['', { branch: '', upstream: '', ahead: 0, behind: 0, gone: false, detached: false }],
  ];
  for (const [inp, want] of T) it(JSON.stringify(inp), () => assert.deepEqual(parseBranchHeader(inp), want));
});

describe('parseWorktreePorcelain', () => {
  it('main + branch + detached + bare/locked/prunable; refs/heads/ dropped; CRLF tolerated', () => {
    const out = parseWorktreePorcelain([
      'worktree C:/r/main', 'HEAD 1111', 'branch refs/heads/main', '',
      'worktree C:/r/wt-a', 'HEAD 2222', 'branch refs/heads/feat/a', 'locked', '',
      'worktree C:/r/wt-b', 'HEAD 3333', 'detached', 'prunable gitdir file points to non-existent location', '',
      'worktree C:/r/bare.git\r', 'bare',
    ].join('\n'));
    assert.deepEqual(out.map((w) => [w.path, w.branch, w.detached, w.bare, w.locked, w.prunable]), [
      ['C:/r/main', 'main', false, false, false, false],
      ['C:/r/wt-a', 'feat/a', false, false, true, false],
      ['C:/r/wt-b', '', true, false, false, true],
      ['C:/r/bare.git', '', false, true, false, false],
    ]);
  });
  it('nothing / lines before the first block → []', () => {
    assert.deepEqual(parseWorktreePorcelain(''), []);
    assert.deepEqual(parseWorktreePorcelain('HEAD 1111\nbranch refs/heads/x'), []);
  });
});

describe('parseGheRepo — {host, owner, repo} or null', () => {
  const T = [
    ['https://github.example.com/your-org/claude-code-ui.git', { host: GHE_HOST, owner: 'your-org', repo: 'claude-code-ui' }],
    ['https://github.example.com/your-org/claude-code-ui', { host: GHE_HOST, owner: 'your-org', repo: 'claude-code-ui' }],
    ['https://user:ghp_SECRET@GitHub.Example.com/your-org/x.y/', { host: GHE_HOST, owner: 'your-org', repo: 'x.y' }],
    ['ssh://git@github.example.com:22/your-org/repo.git', { host: GHE_HOST, owner: 'your-org', repo: 'repo' }],
    ['git@github.example.com:your-org/repo.git', { host: GHE_HOST, owner: 'your-org', repo: 'repo' }],
    ['https://example.invalid/x/y.git', { host: 'example.invalid', owner: 'x', repo: 'y' }],
    ['https://github.example.com/your-org/repo/extra', null],
    ['https://github.example.com/your-org/..', null],
    ['https://github.example.com/HCM DE/repo', null],
    ['https://github.example.com/onlyowner', null],
    ['C:\\repos\\local', null],
    ['file:///C:/repos/x/y.git', null],
    ['', null],
    [null, null],
  ];
  for (const [inp, want] of T) it(String(inp), () => assert.deepEqual(parseGheRepo(inp), want));
});

// ---- repoStatus with fakes --------------------------------------------------------------------------------------
const B = '\\';
const DIR = 'C:' + B + 'work' + B + 'app';
const TOKEN_URL = 'https://jdoe:ghp_TOPSECRET42@' + GHE_HOST + '/your-org/app.git';
// a fake `run`: answers by argv; every call is recorded
function fakeRun(over) {
  const o = Object.assign({
    toplevel: { [DIR]: 'C:/work/app' },
    status: '## feat/a...origin/feat/a [ahead 2]\n M x.js\n?? y.js\nA  z.js',
    worktrees: 'worktree C:/work/app\nHEAD 1\nbranch refs/heads/feat/a\n\nworktree C:/work/app-wt\nHEAD 2\nbranch refs/heads/feat/b\n',
    remote: TOKEN_URL,
  }, over || {});
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const a = args.join(' ');
    const dir = args[args.indexOf('-C') + 1];
    if (a.includes('rev-parse --show-toplevel')) return o.toplevel[dir] ? { err: null, stdout: o.toplevel[dir] } : { err: new Error('not a git repository'), stdout: '' };
    if (a.includes('status --porcelain --branch')) return { err: null, stdout: o.status };
    if (a.includes('worktree list --porcelain')) return { err: null, stdout: o.worktrees };
    if (a.includes('symbolic-ref')) return { err: null, stdout: 'feat/a' };
    if (a.includes('config --get branch.')) return { err: new Error('exit 1'), stdout: '' };
    if (a.includes('remote get-url')) return { err: null, stdout: o.remote };
    return { err: new Error('unexpected ' + a), stdout: '' };
  };
  return { run, calls };
}
const PULLS = [
  { number: 7, title: 'Fremd', html_url: 'https://' + GHE_HOST + '/your-org/app/pull/7', user: { login: 'kim' }, head: { ref: 'other' }, draft: false },
  { number: 8, title: 'Meins', html_url: 'https://' + GHE_HOST + '/your-org/app/pull/8', user: { login: 'jdoe' }, head: { ref: 'feat/b' }, draft: false },
  { number: 9, title: 'Böser Link', html_url: 'https://evil.example/your-org/app/pull/9', user: { login: 'x' }, head: { ref: 'feat/a' }, draft: true },
];
function fakeGhe(handler) { const calls = []; return { calls, gheGet: async (p, o) => { calls.push(p); return handler(p, o); } }; }
const project = (o) => Object.assign({ id: 'p-00000001', cwd: '', addDirs: [DIR], warnings: [], updatedAt: 1 }, o || {});

describe('repoStatus (lib/project-repos.js) with a fake run + gheGet', () => {
  it('git half: branch, ahead, changed, worktrees (the OTHER ones), the remote as {host,owner,repo}; git read-only and without prompts', async () => {
    const { run, calls } = fakeRun();
    const g = fakeGhe(() => ({ status: 200, json: [] }));
    const r = await R.repoStatus(project(), { run, gheGet: g.gheGet, tokenPresent: () => true });
    const [x] = r.repos;
    assert.equal(x.repo, true);
    assert.equal(x.branch, 'feat/a'); assert.equal(x.ahead, 2); assert.equal(x.behind, 0);
    assert.equal(x.changed, 3);
    assert.equal(x.worktrees.count, 1);
    assert.equal(x.worktrees.list[0].branch, 'feat/b');
    assert.deepEqual(x.remote, { host: GHE_HOST, owner: 'your-org', repo: 'app' });
    assert.equal(x.prs.status, 'ok');
    for (const c of calls) {
      assert.equal(c.cmd, 'git');
      assert.ok(!c.args.includes('fetch') && !c.args.includes('pull'), 'never a fetch: ' + c.args.join(' '));
      assert.equal(c.opts.timeout, R.GIT_TIMEOUT_MS);
      assert.equal(c.opts.env.GIT_TERMINAL_PROMPT, '0');
    }
  });
  it('GHE offline (status 0): the git half stays, PRs `offline`, no http code', async () => {
    const { run } = fakeRun();
    const g = fakeGhe(() => ({ status: 0, json: null, error: 'getaddrinfo ENOTFOUND' }));
    const r = await R.repoStatus(project(), { run, gheGet: g.gheGet, tokenPresent: () => true });
    assert.equal(r.repos[0].branch, 'feat/a');
    assert.equal(r.repos[0].changed, 3);
    assert.deepEqual(r.repos[0].prs, { status: 'offline', items: [], total: 0 });
  });
  it('a 404 says its code; no token → `no-token`, another host → `not-ghe` — both without a GHE call', async () => {
    let g = fakeGhe(() => ({ status: 404, json: { message: 'Not Found' } }));
    let r = await R.repoStatus(project(), { run: fakeRun().run, gheGet: g.gheGet, tokenPresent: () => true });
    assert.equal(r.repos[0].prs.status, 'offline'); assert.equal(r.repos[0].prs.http, 404);
    g = fakeGhe(() => { throw new Error('must not be called'); });
    r = await R.repoStatus(project(), { run: fakeRun().run, gheGet: g.gheGet, tokenPresent: () => false });
    assert.equal(r.repos[0].prs.status, 'no-token');
    r = await R.repoStatus(project(), { run: fakeRun({ remote: 'https://example.invalid/x/y.git' }).run, gheGet: g.gheGet, tokenPresent: () => true });
    assert.equal(r.repos[0].prs.status, 'not-ghe');
    assert.deepEqual(r.repos[0].remote, { host: 'example.invalid', owner: 'x', repo: 'y' });
    // a lookalike host is not ours
    r = await R.repoStatus(project(), { run: fakeRun({ remote: 'https://' + GHE_HOST + '.evil.tld/your-org/app.git' }).run, gheGet: g.gheGet, tokenPresent: () => true });
    assert.equal(r.repos[0].prs.status, 'not-ghe');
    assert.equal(g.calls.length, 0);
  });
  it('PRs: mine first (current or worktree branch), review state as /api/prs, link only on the GHE origin', async () => {
    const g = fakeGhe((p) => {
      if (p.endsWith('/pulls?state=open&per_page=20')) return { status: 200, json: PULLS };
      if (p.endsWith('/pulls/7/reviews')) return { status: 200, json: [{ user: { login: 'a' }, state: 'APPROVED' }, { user: { login: 'b' }, state: 'CHANGES_REQUESTED' }] };
      if (p.endsWith('/pulls/8/reviews')) return { status: 200, json: [{ user: { login: 'a' }, state: 'CHANGES_REQUESTED' }, { user: { login: 'a' }, state: 'APPROVED' }] };
      return { status: 500 };
    });
    const r = await R.repoStatus(project(), { run: fakeRun().run, gheGet: g.gheGet, tokenPresent: () => true });
    const prs = r.repos[0].prs;
    assert.equal(prs.status, 'ok');
    assert.deepEqual(prs.items.map((x) => [x.number, x.mine, x.state]), [[8, true, 'approved'], [9, true, 'draft'], [7, false, 'changes']]);
    assert.equal(prs.items.find((x) => x.number === 9).url, '', 'a foreign html_url is no link');
    assert.ok(prs.items.find((x) => x.number === 8).url.startsWith('https://' + GHE_HOST + '/'));
    assert.ok(!g.calls.some((p) => p.includes('/pulls/9/')), 'no review look-up for a draft');
  });
  it('a review that does not come back in time: the list stays, status `partial`', async () => {
    const g = fakeGhe((p) => (p.includes('/reviews') ? new Promise(() => {}) : { status: 200, json: PULLS.slice(0, 1) }));
    const t0 = Date.now();
    const r = await R.repoStatus(project(), { run: fakeRun().run, gheGet: g.gheGet, tokenPresent: () => true, prDeadlineMs: 150 });
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(r.repos[0].prs.status, 'partial');
    assert.deepEqual(r.repos[0].prs.items.map((x) => [x.number, x.state]), [[7, 'pending']]);
  });
  it('UNC and warned paths are skipped without a git call; a folder twice / inside one checkout is one row; a non-repo says so', async () => {
    const SUB = DIR + B + 'sub';
    const MISSING = 'C:' + B + 'gone';
    const PLAIN = 'C:' + B + 'plain';
    const { run, calls } = fakeRun({ toplevel: { [DIR]: 'C:/work/app', [SUB]: 'C:/work/app' } });
    const r = await R.repoStatus(project({
      addDirs: [DIR, '\\\\srv\\share\\x', SUB, DIR.toUpperCase(), MISSING, PLAIN],
      warnings: [{ code: 'adddir-missing', field: 'addDirs', value: MISSING }, { code: 'adddir-unc', field: 'addDirs', value: '\\\\srv\\share\\x' }],
    }), { run, gheGet: async () => ({ status: 0 }), tokenPresent: () => false });
    assert.deepEqual(r.skipped.map((s) => s.reason).sort(), ['unc', 'warned']);
    assert.equal(r.repos.filter((x) => x.repo).length, 1);
    assert.deepEqual(r.repos.filter((x) => x.repo)[0].dirs, [DIR, SUB]);
    assert.deepEqual(r.repos.filter((x) => !x.repo).map((x) => x.dir), [PLAIN]);
    const asked = calls.map((c) => c.args[c.args.indexOf('-C') + 1]);
    assert.ok(!asked.some((d) => d.startsWith('\\\\') || d === MISSING), 'never asked: ' + asked.join(', '));
  });
  it('the serialised answer carries neither userinfo nor token nor the remote URL', async () => {
    const g = fakeGhe(() => ({ status: 200, json: PULLS }));
    const r = await R.repoStatus(project(), { run: fakeRun().run, gheGet: g.gheGet, tokenPresent: () => true });
    const s = JSON.stringify(r);
    for (const bad of ['ghp_TOPSECRET42', 'jdoe:', '@' + GHE_HOST, TOKEN_URL, '.git"']) assert.ok(!s.includes(bad), 'leaks ' + bad);
  });
});

// --------------------------------------------------------------------------------------------- HTTP (server)
function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function get(port, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* text */ } resolve({ status: res.statusCode, json }); });
    });
    r.setTimeout(30000, () => r.destroy(new Error('no answer: ' + p)));
    r.on('error', reject); r.end();
  });
}
describe('HTTP — GET /api/projects/repos (sandbox server)', () => {
  let child, port;
  before(async () => {
    fs.mkdirSync(path.dirname(PROJECTS_FILE), { recursive: true });
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify([{ id: 'p-0000abcd', name: 'Ohne Ordner', createdAt: 1, updatedAt: 1 }]));
    port = await freePort();
    child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, ...SBX.env, CLAUDE_UI_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
    const t0 = Date.now();
    for (;;) {
      try { if ((await get(port, '/api/state')).status === 200) break; } catch { /* not up */ }
      if (Date.now() - t0 > 15000) throw new Error('server did not come up\n' + log);
      await new Promise((r) => setTimeout(r, 150));
    }
  });
  after(() => new Promise((r) => { if (!child || child.exitCode != null) return r(); child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }));
  it('400 without / with a malformed id, 404 unknown, 200 with empty lists for a project without folders', async () => {
    assert.equal((await get(port, '/api/projects/repos')).status, 400);
    assert.equal((await get(port, '/api/projects/repos?id=bad')).status, 400);
    assert.equal((await get(port, '/api/projects/repos?id=p-deadbeef')).status, 404);
    const r = await get(port, '/api/projects/repos?id=p-0000abcd&fresh=1');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.status, undefined, 'the internal status does not leak into the body');
    assert.deepEqual(r.json.repos, []);
    assert.deepEqual(r.json.skipped, []);
  });
});
