'use strict';
// P4 „Repos & PRs" — the git state of a project's LOCAL folders (cwd + addDirs) and the open PRs of their GHE
// remotes, for the cockpit's section of the same name (GET /api/projects/repos?id=).
//
// WHAT IS LOOKED AT, AND WHAT NEVER IS:
//   · only local folders: a UNC/device path is skipped without a look (a dead share holds a libuv thread for ~54 s,
//     lib/core.js pathExists), and so is every path the last SAVE measured as missing or could not check
//     (`cwd-missing` / `adddir-missing` / `path-unchecked`, lib/projects.js) — that verdict is the one measurement
//     this route trusts instead of repeating it.
//   · git runs read-only: `status --porcelain --branch` (with --no-optional-locks: status must not refresh the
//     index of a repo another process is working in), `worktree list --porcelain`, `remote get-url`. Each with
//     a 5-s timeout, gitNoPromptEnv (no credential helper, no prompt — none of these calls needs one) and at most
//     GIT_SLOTS at a time. NO fetch: ahead/behind are counted against the local tracking ref, i.e. the state of the
//     last fetch — the page says so. A fetch here would be a network call per folder on every visit.
//   · PRs only for a remote on the GHE host AND with a token present — the gheGet path never sees anything else.
//     All PR calls of one answer share ONE deadline (PR_DEADLINE_MS): off the VPN the TLS handshake fails, and the
//     section must say „not reachable" in seconds, with the git half intact.
//   · the client gets the remote as { host, owner, repo } and nothing more. The raw URL can carry `user:token@`
//     (a clone made with a PAT in the URL) and is never part of the answer; a PR link only when it is https on the
//     GHE origin.
// `run` and `gheGet` are injected (the resolveGitRemote pattern, lib/github.js) — the tests drive every branch of
// this file with fakes, no repo on disk and no network.
const path = require('path');
const { mapLimit, withDeadline } = require('./core');
const github = require('./github');
const { parseBranchHeader, parseWorktreePorcelain, parseGheRepo } = require('./pure');
const PC = require('../public/js/projects-core');

const GIT_TIMEOUT_MS = 5000;
const GIT_SLOTS = 2;
const PR_DEADLINE_MS = 8000;
const PR_SLOTS = 4;            // review look-ups in flight, as GET /api/prs
const PR_MAX = 10;             // PRs per repo in the answer (mine first)
const WORKTREE_MAX = 10;
const MEMO_MS = 30000;
const SKIP_WARNINGS = ['cwd-missing', 'adddir-missing', 'path-unchecked'];
const PR_STATUS = ['ok', 'partial', 'offline', 'no-token', 'not-ghe'];

const keyOf = (p) => { const s = path.resolve(String(p)).replace(/[\\/]+$/, ''); return process.platform === 'win32' ? s.toLowerCase().replace(/\//g, '\\') : s; };

// The folders of a project, in its order (cwd first), each once. -> { dirs: [abs], skipped: [{ dir, reason }] }
function projectFolders(p) {
  const warned = new Set((Array.isArray(p.warnings) ? p.warnings : [])
    .filter((w) => w && SKIP_WARNINGS.includes(w.code) && typeof w.value === 'string').map((w) => keyOf(w.value)));
  const dirs = [], skipped = [], seen = new Set();
  for (const d of [p.cwd, ...(Array.isArray(p.addDirs) ? p.addDirs : [])]) {
    if (typeof d !== 'string' || !d.trim()) continue;
    if (PC.projectIsUncOrDevice(d)) { skipped.push({ dir: d, reason: 'unc' }); continue; }
    const k = keyOf(d);
    if (seen.has(k)) continue;
    seen.add(k);
    if (warned.has(k)) { skipped.push({ dir: d, reason: 'warned' }); continue; }
    dirs.push(d);
  }
  return { dirs, skipped };
}

// The review state of one PR, as GET /api/prs reads it: the LATEST review per reviewer, „changes" beats „approved".
function reviewState(reviews) {
  if (!Array.isArray(reviews) || !reviews.length) return 'pending';
  const latest = {};
  reviews.forEach((x) => { if (x && x.user && x.state) latest[x.user.login] = x.state; });
  const states = Object.values(latest);
  if (states.includes('CHANGES_REQUESTED')) return 'changes';
  if (states.includes('APPROVED')) return 'approved';
  return 'pending';
}
// html_url only when it is https on the GHE origin — anything else is no link (the client checks again)
function prLink(u) {
  try { const x = new URL(String(u)); return x.origin.toLowerCase() === github.GHE_ORIGIN ? x.href : ''; } catch { return ''; }
}

// -> { repos: [...], skipped: [...], checkedAt }. deps: { run, gheGet, tokenPresent, now?, gitTimeoutMs?, prDeadlineMs? }
async function repoStatus(project, deps) {
  const d = deps || {};
  const gitOpts = { timeout: d.gitTimeoutMs || GIT_TIMEOUT_MS, env: github.gitNoPromptEnv() };
  const run = (cmd, args) => d.run(cmd, args, gitOpts);
  const git = async (dir, ...args) => {
    const r = await run('git', ['--no-optional-locks', '-C', dir, ...args]);
    return { ok: !!r && !r.err, out: r && !r.err ? String(r.stdout || '') : '' };
  };
  const { dirs, skipped } = projectFolders(project || {});

  // 1 · which folders are repos, and which repo — two addDirs inside one checkout are one row
  const tops = await mapLimit(dirs, GIT_SLOTS, async (dir) => {
    const r = await git(dir, 'rev-parse', '--show-toplevel');
    return { dir, top: r.ok ? r.out.trim() : '' };
  });
  const repos = [], byTop = new Map();
  for (const { dir, top } of tops) {
    if (!top) { repos.push({ dir, repo: false }); continue; }
    const k = keyOf(top);
    if (byTop.has(k)) { byTop.get(k).dirs.push(dir); continue; }
    const rec = { dir, dirs: [dir], top: path.resolve(top), name: path.basename(path.resolve(top)), repo: true };
    byTop.set(k, rec); repos.push(rec);
  }

  // 2 · the local state of each repo
  const gheWork = [];
  await mapLimit(repos.filter((r) => r.repo), GIT_SLOTS, async (rec) => {
    const st = await git(rec.top, 'status', '--porcelain', '--branch');
    if (!st.ok) rec.gitError = true;
    Object.assign(rec, parseBranchHeader(st.out));
    rec.changed = st.out.split('\n').filter((l) => l.trim() && !l.startsWith('## ')).length;
    const wt = await git(rec.top, 'worktree', 'list', '--porcelain');
    const all = parseWorktreePorcelain(wt.out);
    // the first block is the checkout itself; the count is of the OTHER worktrees
    const others = all.filter((w) => keyOf(w.path) !== keyOf(rec.top));
    rec.worktrees = { count: others.length, list: others.slice(0, WORKTREE_MAX).map((w) => ({ path: path.resolve(w.path), branch: w.branch, detached: w.detached })) };
    const branches = new Set([rec.branch, ...all.map((w) => w.branch)].filter((b) => b && b !== 'HEAD'));
    // the remote a bare fetch of THIS branch would contact (branch.<b>.remote, else origin) — github.js decides
    const { url } = await github.resolveGitRemote(rec.top, (cmd, args) => run(cmd, args));
    const parsed = parseGheRepo(url);
    rec.remote = parsed;
    if (!parsed || !github.isGheRemote(url)) rec.prs = { status: 'not-ghe', items: [], total: 0 };
    else if (!d.tokenPresent()) rec.prs = { status: 'no-token', items: [], total: 0 };
    else { rec.prs = { status: 'offline', items: [], total: 0 }; gheWork.push({ rec, branches }); }
  });

  // 3 · the open PRs of the GHE repos, under ONE deadline for all of them. withDeadline cannot cancel — the work
  // writes into `live` and the answer is a COPY taken when the deadline (or the work) ends.
  if (gheWork.length) {
    const live = gheWork.map(() => ({ status: 'offline', items: [], total: 0 }));
    const reviewJobs = [];
    await withDeadline((async () => {
      await Promise.all(gheWork.map(async ({ rec, branches }, i) => {
        const r = await d.gheGet('/repos/' + rec.remote.owner + '/' + rec.remote.repo + '/pulls?state=open&per_page=20', { ttlMs: 60000 });
        if (!r || r.error || r.status !== 200 || !Array.isArray(r.json)) {
          if (r && r.status && r.status !== 200) live[i].http = r.status;
          return;
        }
        const list = r.json.map((pr) => ({
          number: Number(pr.number) || 0,
          title: String(pr.title || ''),
          url: prLink(pr.html_url),
          author: (pr.user && typeof pr.user.login === 'string') ? pr.user.login : '',
          branch: (pr.head && typeof pr.head.ref === 'string') ? pr.head.ref : '',
          draft: !!pr.draft,
          state: pr.draft ? 'draft' : 'pending',
        })).map((x) => Object.assign(x, { mine: branches.has(x.branch) }));
        list.sort((a, b) => Number(b.mine) - Number(a.mine)); // stable: GHE's order (newest first) within each half
        live[i].total = list.length;
        live[i].items = list.slice(0, PR_MAX);
        live[i].status = 'partial'; // until every review is in
        live[i].items.forEach((pr) => { if (!pr.draft) reviewJobs.push({ i, pr, rec }); });
      }));
      await mapLimit(reviewJobs, PR_SLOTS, async ({ pr, rec }) => {
        const rv = await d.gheGet('/repos/' + rec.remote.owner + '/' + rec.remote.repo + '/pulls/' + pr.number + '/reviews');
        if (rv && rv.status === 200) { pr.state = reviewState(rv.json); pr._rv = true; }
      });
    })(), d.prDeadlineMs || PR_DEADLINE_MS, null);
    gheWork.forEach(({ rec }, i) => {
      const snap = JSON.parse(JSON.stringify(live[i]));
      if (snap.status === 'partial' && snap.items.every((pr) => pr.draft || pr._rv)) snap.status = 'ok';
      snap.items.forEach((pr) => { delete pr._rv; });
      rec.prs = snap;
    });
  }
  return { repos, skipped, checkedAt: d.now ? d.now() : Date.now() };
}

// The route's half: id check, the project, a 30-s memo per id + updatedAt (an edit of the folders is seen at once),
// shared while in flight. `fresh` (the section's [↻]) skips a memo hit — the GHE list keeps its own 60-s cache.
// deps: repoStatus's + { readProjects?, memoMs?, fresh? } -> { status, ...body }
const memo = new Map(); // key -> { at, p }
async function projectRepos(id, deps) {
  const d = deps || {};
  if (typeof id !== 'string' || !PC.PROJECT_ID_RE.test(id)) return { ok: false, status: 400, error: 'invalid project id', errors: [{ field: 'id', code: 'invalid' }] };
  const readProjects = d.readProjects || require('./projects').readProjects; // lazy: projects.js is the heavier module
  const p = (await readProjects()).find((x) => x.id === id); // a broken store throws → 500 store-corrupt, as everywhere
  if (!p) return { ok: false, status: 404, error: 'unknown project', errors: [{ field: 'id', code: 'unknown' }] };
  const memoMs = d.memoMs === undefined ? MEMO_MS : d.memoMs;
  const key = id + '|' + p.updatedAt;
  const now = Date.now();
  const hit = memo.get(key);
  if (memoMs > 0 && hit && !d.fresh && now - hit.at < memoMs) return hit.p;
  const work = repoStatus(p, d).then((r) => ({ ok: true, status: 200, ...r }));
  if (memoMs > 0) {
    if (memo.size >= 20) memo.clear();
    memo.set(key, { at: now, p: work });
    work.catch(() => memo.delete(key));
  }
  return work;
}
function _resetMemo() { memo.clear(); }

module.exports = { repoStatus, projectRepos, projectFolders, reviewState, prLink, PR_STATUS, GIT_TIMEOUT_MS, PR_DEADLINE_MS, PR_MAX, WORKTREE_MAX, _resetMemo };
