'use strict';
// P5 „Neue Projekte vorschlagen" — the DATA half: fold v5 (fd / ms out of the tool calls) and projects-core
// projectClusters. What has to hold, and the defect each block guards against:
//   · fold v5: a tool_use line fills fd (absolute folders only, file name cut, .claude / AppData / \WINDOWS\ skipped)
//     and ms (mcp__<server>__…), main AND agent transcripts, and both survive the cache round trip. A v4 cache, a
//     `__proto__` key or a relative folder in the cache is a MISS (refold) — never adopted.
//   · scanSessions({signals:true}) carries dirs/mcps (agents summed in); the plain list does not grow.
//   · projectClusters: two sessions with one key → one draft; an explicit / rule-labelled / '' session never lands in
//     a draft; what a project already has seeds nothing; system32 / HOME are never addDirs; a server in nearly every
//     session is no seed; every session in at most ONE draft; at most 8 drafts.
// Hermetic: one sandbox (test/sandbox.js), its env set BEFORE lib/paths is loaded. Nothing here reads ~/.claude.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeSandbox } = require('./sandbox');

const SBX = makeSandbox('drafts');
Object.assign(process.env, SBX.env);
const { scanCorpus, flushCache, _resetCorpusCache, CACHE_V, DRAFT_CAPS } = require('../lib/corpus');
const { scanSessions } = require('../lib/sessions');
const { TRANSCRIPT_CACHE_FILE } = require('../lib/paths');
const PC = require('../public/js/projects-core');
after(() => SBX.cleanup());

const B = '\\';
const W = (...s) => s.join(B);
const PROJECTS = path.join(SBX.claudeDir, 'projects');
const HOME = W('C:', 'Users', 'dev');
const SYS32 = W('C:', 'WINDOWS', 'system32');
const sid = (n) => n.repeat(8) + '-' + n.repeat(4) + '-4' + n.repeat(3) + '-8' + n.repeat(3) + '-' + n.repeat(12);
const enc = (cwd) => cwd.replace(/[:\\/]/g, '-');
const fileOf = (cwd, id) => path.join(PROJECTS, enc(cwd), id + '.jsonl');
const write = (f, lines) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, lines.join('\n') + '\n'); return f; };
const tool = (cwd, blocks) => JSON.stringify({ type: 'assistant', cwd, timestamp: '2026-03-01T09:00:00.000Z', uuid: 'u' + Math.random(),
  message: { role: 'assistant', model: 'claude-opus-4-8', content: blocks } });
const use = (name, input) => ({ type: 'tool_use', id: 'toolu_' + name, name, input });
const fresh = () => { _resetCorpusCache(); try { fs.unlinkSync(TRANSCRIPT_CACHE_FILE); } catch { /* none */ } };
const recOf = (corpus, id, kind) => corpus.recs.find((r) => r.session === id && r.kind === (kind || 'main'));

describe('fold v5 — folders and MCP servers out of the tool calls (lib/corpus.js)', () => {
  const REPO = W('C:', 'Users', 'dev', 'repo-a');
  const S = sid('a');
  const main = () => write(fileOf(SYS32, S), [
    tool(SYS32, [
      use('Read', { file_path: W(REPO, 'lib', 'x.js') }),
      use('Edit', { file_path: W(REPO, 'lib', 'x.js') }),
      use('Grep', { path: W(REPO, 'test') }),
      use('Write', { file_path: 'relative' + B + 'y.js' }),                          // relative: skipped
      use('Read', { file_path: W(HOME, '.claude', 'memory', 'm.md') }),              // .claude: skipped
      use('Read', { file_path: W(HOME, 'AppData', 'Local', 'Temp', 'z.txt') }),      // AppData: skipped
      use('Read', { file_path: W(SYS32, 'drivers', 'etc', 'hosts') }),              // \WINDOWS\: skipped
      use('Read', { file_path: W('C:', 'a', 'b', 'c', 'd', 'e', 'f', 'g.txt') }),    // cut to 5 segments
      use('mcp__sap-adt__read_source', { name: 'X' }),
      use('mcp__sap-adt__activate', {}),
      use('mcp__jira__jira_get_issue', {}),
      { type: 'text', text: 'ok' },
    ]),
  ]);
  const agent = () => write(path.join(PROJECTS, enc(SYS32), S, 'subagents', 'agent-0a1b.jsonl'), [
    tool(SYS32, [use('Glob', { path: W('C:', 'Atlas', 'src') }), use('mcp__github__getPullRequest', {})]),
  ]);

  it('CACHE_V is 5', () => { assert.equal(CACHE_V, 5); });
  it('a tool_use line fills fd / ms — absolute folders only, cut, the harness and the system skipped; agents too', async () => {
    fresh(); main(); agent();
    const c = await scanCorpus();
    const r = recOf(c, S);
    assert.deepEqual(r.fd, { [W(REPO, 'lib')]: 2, [W(REPO, 'test')]: 1, [W('C:', 'a', 'b', 'c', 'd')]: 1 });
    assert.deepEqual(r.ms, { 'sap-adt': 2, jira: 1 });
    const a = recOf(c, S, 'subagent');
    assert.deepEqual([a.fd, a.ms], [{ [W('C:', 'Atlas', 'src')]: 1 }, { github: 1 }]);
    const items = await scanSessions({ signals: true });
    const it0 = items.find((x) => x.id === S);
    assert.deepEqual(it0.dirs, Object.assign({}, r.fd, a.fd), 'the agent folders are not summed in');
    assert.deepEqual(it0.mcps, { 'sap-adt': 2, jira: 1, github: 1 });
    const plain = (await scanSessions()).find((x) => x.id === S);
    assert.ok(!('dirs' in plain) && !('mcps' in plain), '/api/sessions grew');
  });
  it('the keys are capped at FD_MAX / MS_MAX — the first ones win', async () => {
    fresh();
    const S2 = sid('b');
    write(fileOf(SYS32, S2), [tool(SYS32, Array.from({ length: DRAFT_CAPS.FD_MAX + 4 }, (_, i) => use('Read', { file_path: W('C:', 'r' + i, 'f.txt') }))
      .concat(Array.from({ length: DRAFT_CAPS.MS_MAX + 4 }, (_, i) => use('mcp__s' + i + '__t', {}))))]);
    const r = recOf(await scanCorpus(), S2);
    assert.equal(Object.keys(r.fd).length, DRAFT_CAPS.FD_MAX);
    assert.ok(r.fd[W('C:', 'r0')] && !r.fd[W('C:', 'r' + DRAFT_CAPS.FD_MAX)]);
    assert.equal(Object.keys(r.ms).length, DRAFT_CAPS.MS_MAX);
    fs.rmSync(path.dirname(fileOf(SYS32, S2)) + path.sep + S2 + '.jsonl');
  });
  it('main + agents summed are cut back to FD_MAX / MS_MAX keys — the largest counts first', async () => {
    fresh();
    const S3 = sid('c');
    const reads = (pre, n, times) => Array.from({ length: n }, (_, i) => Array.from({ length: times(i) }, () => use('Read', { file_path: W('C:', pre + i, 'f.txt') }))).flat();
    write(fileOf(SYS32, S3), [tool(SYS32, reads('m', DRAFT_CAPS.FD_MAX, () => 1))]);
    write(path.join(PROJECTS, enc(SYS32), S3, 'subagents', 'agent-0c0c.jsonl'), [tool(SYS32, reads('a', DRAFT_CAPS.FD_MAX, (i) => (i < 4 ? 5 : 1)))]);
    const it0 = (await scanSessions({ signals: true })).find((x) => x.id === S3);
    assert.equal(Object.keys(it0.dirs).length, DRAFT_CAPS.FD_MAX);
    for (let i = 0; i < 4; i++) assert.equal(it0.dirs[W('C:', 'a' + i)], 5, 'a heavy agent folder was cut');
    fs.rmSync(fileOf(SYS32, S3)); fs.rmSync(path.join(PROJECTS, enc(SYS32), S3), { recursive: true });
  });
  it('fd / ms survive the cache round trip (warm restart: no refold)', async () => {
    fresh(); main(); agent();
    const before = recOf(await scanCorpus(), S);
    assert.equal(await flushCache(), true);
    _resetCorpusCache();
    const again = await scanCorpus();
    assert.equal(again.stats.folded, 0, 'the v5 record was not adopted from disk');
    assert.deepEqual([recOf(again, S).fd, recOf(again, S).ms], [before.fd, before.ms]);
  });
  it('a v4 cache, a `__proto__` key and a relative folder are a MISS — refolded, never adopted', async () => {
    fresh(); main(); agent();
    const expect = recOf(await scanCorpus(), S);
    await flushCache();
    const good = fs.readFileSync(TRANSCRIPT_CACHE_FILE, 'utf8');
    const full = fileOf(SYS32, S);
    const dmg = (fn) => { const o = JSON.parse(good); fn(o.files[full], o); return JSON.stringify(o); };
    const trusted = [];
    for (const [label, body] of [
      ['a v4 cache', dmg((r, o) => { o.v = 4; })],
      ['fd carries __proto__', dmg((r) => { r.fd = JSON.parse('{"__proto__": 1}'); })],
      ['ms carries __proto__', dmg((r) => { r.ms = JSON.parse('{"__proto__": 1}'); })],
      ['an fd key is relative', dmg((r) => { r.fd = { ['repo' + B + 'lib']: 1 }; })],
      ['an fd key is a share', dmg((r) => { r.fd = { [B + B + 'srv' + B + 'share']: 1 }; })],
      ['an fd key below .claude', dmg((r) => { r.fd = { [W(HOME, '.claude', 'x')]: 1 }; })],
      ['an fd count is 0', dmg((r) => { r.fd = { [W(REPO, 'lib')]: 0 }; })],
      ['an ms name is not a server name', dmg((r) => { r.ms = { 'a b': 1 }; })],
      ['fd is an array', dmg((r) => { r.fd = [W(REPO, 'lib')]; })],
      ['more fd keys than the fold keeps', dmg((r) => { r.fd = Object.fromEntries(Array.from({ length: DRAFT_CAPS.FD_MAX + 1 }, (_, i) => [W('C:', 'r' + i), 1])); })],
    ]) {
      fs.writeFileSync(TRANSCRIPT_CACHE_FILE, body);
      _resetCorpusCache();
      const got = await scanCorpus();
      try {
        assert.ok(got.stats.folded > 0, 'not refolded');
        assert.deepEqual([recOf(got, S).fd, recOf(got, S).ms], [expect.fd, expect.ms]);
      } catch (e) { trusted.push(label + ' → ' + e.message.split('\n')[0]); }
    }
    assert.deepEqual(trusted, [], 'trusted instead of refolded:\n  - ' + trusted.join('\n  - '));
  });
});

describe('projectRepoRoot — the repo a folder belongs to, by its spelling', () => {
  it('HOME + 1, else drive + 1; HOME itself, catch-alls and another profile are none', () => {
    for (const [dir, want] of [
      [W(HOME, 'repo-a', 'lib', 'x'), W(HOME, 'repo-a')],
      [W('C:', 'Atlas', 'src'), W('C:', 'Atlas')],
      ['c:/Atlas/src', W('C:', 'Atlas')],
      [HOME, null],
      [W(HOME, 'Downloads', 'x'), null],
      [W(HOME, 'OneDrive - Company', 'x'), null],
      [W(HOME, '.vscode', 'x'), null],
      [W('C:', 'Users', 'someone', 'repo'), null],
      [SYS32, null],
      ['relative' + B + 'x', null],
      [B + B + 'srv' + B + 'share', null],
    ]) assert.equal(PC.projectRepoRoot(dir, HOME), want, dir);
  });
});

describe('projectClusters — drafts out of the free sessions (projects-core)', () => {
  let n = 0;
  const S = (o) => Object.assign({ id: sid(String((++n % 9) + 1)).slice(0, 30) + String(n).padStart(6, '0'), title: '', mtime: n, projectPath: SYS32,
    projectId: null, projectDerived: null, typedKeys: {}, dirs: {}, mcps: {} }, o);
  const ctx = { home: HOME, blocked: [HOME, SYS32] };
  const kinds = (ds) => ds.map((d) => d.key + '=' + d.sessions);

  it('two sessions with one key → one draft, named after the shared title word, its values filled', () => {
    const a = S({ title: 'Demoprojekt Antrag prüfen', typedKeys: { 'ACME-3269': 2 }, mcps: { 'sap-adt': 3 } });
    const b = S({ title: 'Demoprojekt weiter', typedKeys: { 'ACME-3269': 1, 'PROJ-1': 1 }, mcps: { 'sap-adt': 1 } });
    const ds = PC.projectClusters([a, b, S({ title: 'anderes' })], [], ctx);
    assert.equal(ds.length, 1);
    const d = ds[0];
    assert.deepEqual([d.key, d.kind, d.name, d.sessions], ['k:ACME-3269', 'key', 'Demoprojekt · ACME-3269', 2]);
    assert.deepEqual(d.sessionIds, [b.id, a.id], 'newest first');
    assert.deepEqual(d.titles, [b.title, a.title]);
    assert.deepEqual(d.values, { jiraKeys: ['ACME-3269'], addDirs: [], mcpServers: ['sap-adt'] });
    assert.deepEqual(d.why, { signal: 'key', value: 'ACME-3269', sessions: 2 });
  });
  it('explicit, rule-labelled and „deliberately without" sessions never land in a draft', () => {
    const k = { 'ACME-77': 1 };
    const ds = PC.projectClusters([
      S({ typedKeys: k, projectId: 'p-00000001' }), S({ typedKeys: k, projectId: '' }), S({ typedKeys: k, projectDerived: 'p-00000001' }), S({ typedKeys: k }),
    ], [], ctx);
    assert.deepEqual(ds, []);
  });
  it('a key, a folder or a rule a project already has seeds nothing; a placeholder key neither', () => {
    const repo = W(HOME, 'repo-a');
    const free = [S({ typedKeys: { 'ACME-5': 1, 'ACME-1234': 1 }, dirs: { [W(repo, 'lib')]: 1 } }), S({ typedKeys: { 'ACME-5': 1, 'ACME-1234': 1 }, dirs: { [W(repo, 'test')]: 2 } })];
    assert.deepEqual(kinds(PC.projectClusters(free, [], ctx)), ['k:ACME-5=2']);
    assert.deepEqual(kinds(PC.projectClusters(free, [{ id: 'p-00000001', jiraKeys: ['ACME-5'] }], ctx)), ['d:' + repo.toLowerCase() + '=2']);
    assert.deepEqual(PC.projectClusters(free, [{ id: 'p-00000001', jiraKeys: ['ACME-5'], addDirs: [repo] }], ctx), []);
    assert.deepEqual(PC.projectClusters(free, [{ id: 'p-00000001', jiraKeys: ['ACME-5'], paths: [W(HOME, 'repo-*')] }], ctx), []);
  });
  it('system32 and HOME are never addDirs — not as a seed, not as a value, also via the cwd', () => {
    const k = { 'PROJ-9': 1 };
    const ds = PC.projectClusters([
      S({ typedKeys: k, projectPath: HOME, dirs: { [SYS32]: 3, [HOME]: 2 } }),
      S({ typedKeys: k, projectPath: SYS32, dirs: { [W(HOME, 'repo-b', 'x')]: 1 } }),
      S({ projectPath: HOME, dirs: { [HOME]: 9 } }), S({ projectPath: HOME, dirs: { [HOME]: 9 } }),
    ], [], ctx);
    assert.deepEqual(kinds(ds), ['k:PROJ-9=2']);
    assert.deepEqual(ds[0].values.addDirs, [W(HOME, 'repo-b')], 'only the real repo (≥ 30 % of the draft)');
    for (const d of ds) for (const x of d.values.addDirs) assert.ok(![HOME, SYS32].map((y) => y.toLowerCase()).includes(x.toLowerCase()));
  });
  it('a server in nearly every session is no seed; one in ≥ 3 but ≤ 40 % is', () => {
    const many = Array.from({ length: 10 }, (_, i) => S({ mcps: Object.assign({ jira: 1 }, i < 3 ? { 'sap-adt': 2 } : {}) }));
    assert.deepEqual(kinds(PC.projectClusters(many, [], ctx)), ['m:sap-adt=3']);
    const d = PC.projectClusters(many, [], ctx)[0];
    assert.deepEqual(d.values.mcpServers, ['sap-adt', 'jira']);
  });
  it('seeds in order key → folder → server, every session in ONE draft, at most 8 drafts', () => {
    const repo = W('C:', 'Atlas');
    const a = S({ typedKeys: { 'ACME-1': 1 }, dirs: { [W(repo, 'x')]: 1 } });
    const b = S({ typedKeys: { 'ACME-1': 1 }, dirs: { [W(repo, 'x')]: 1 } });
    const c = S({ dirs: { [W(repo, 'y')]: 1 } });
    const d = S({ projectPath: W(repo, 'z') });
    const ds = PC.projectClusters([a, b, c, d], [], ctx);
    assert.deepEqual(kinds(ds), ['k:ACME-1=2', 'd:c:\\atlas=2']);
    const seen = ds.flatMap((x) => x.sessionIds);
    assert.equal(new Set(seen).size, seen.length, 'a session sits in two drafts');
    const lots = [];
    for (let i = 0; i < 12; i++) lots.push(S({ typedKeys: { ['PROJ-' + (100 + i)]: 1 } }), S({ typedKeys: { ['PROJ-' + (100 + i)]: 1 } }));
    assert.equal(PC.projectClusters(lots, [], ctx).length, PC.PROJECT_DRAFT_CAPS.drafts);
    assert.ok(PC.projectClusters(lots, [], ctx).every((x) => x.sessions >= 2));
  });
  it('defensive: junk in, nothing out — and an Object-member name is data', () => {
    assert.deepEqual(PC.projectClusters(null, null, null), []);
    assert.deepEqual(PC.projectClusters([null, 5, { id: 7 }], [null], {}), []);
    const p = JSON.parse('{"__proto__": 3}');
    assert.deepEqual(PC.projectClusters([S({ typedKeys: p, mcps: p, dirs: p }), S({ typedKeys: p, mcps: p, dirs: p })], [], ctx), []);
  });
});

// ---------------------------------------------------------------------------------- P5 Nachbesserung (A) + (B)
describe('projectClusters — an EXISTING project instead of a duplicate (target), worktrees count as their main repo', () => {
  let n = 0;
  const S = (o) => Object.assign({ id: 'ffffffff-ffff-4fff-8fff-' + String(++n).padStart(12, '0'), title: '', mtime: n, projectPath: SYS32,
    projectId: null, projectDerived: null, typedKeys: {}, dirs: {}, mcps: {} }, o);
  const ctx = { home: HOME, blocked: [HOME, SYS32] };
  const CCUI = W(HOME, 'claude-code-ui');
  const PID = 'p-0000c0de';
  const PROJ = [{ id: PID, name: 'Claude Code Control Panel', addDirs: [], paths: [], jiraKeys: [] }];
  const inRepo = (o) => S(Object.assign({ dirs: { [W(CCUI, 'lib')]: 3 } }, o));

  it('3 assigned sessions in claude-code-ui + 5 free ones → ONE draft with target (no second project)', () => {
    const free = [inRepo(), inRepo(), inRepo(), inRepo(), inRepo()];
    const assigned = [inRepo({ projectId: PID }), inRepo({ projectId: PID }), inRepo({ projectId: PID })];
    const ds = PC.projectClusters(free, PROJ, Object.assign({ assigned }, ctx));
    assert.equal(ds.length, 1);
    assert.deepEqual([ds[0].kind, ds[0].sessions, ds[0].target, ds[0].targetSessions], ['dir', 5, PID, 3]);
  });
  it('without assigned hits it stays a normal draft; ONE hit, an ARCHIVED project or a minority is no target', () => {
    const free = [inRepo(), inRepo()];
    assert.equal(PC.projectClusters(free, PROJ, ctx)[0].target, undefined);
    const one = [inRepo({ projectId: PID }), S({ projectId: PID, dirs: { [W(HOME, 'elsewhere', 'x')]: 1 } })];
    assert.equal(PC.projectClusters(free, PROJ, Object.assign({ assigned: one }, ctx))[0].target, undefined, 'one wrongly assigned session pulled the cluster over');
    const two = [inRepo({ projectId: PID }), inRepo({ projectId: PID })];
    assert.equal(PC.projectClusters(free, PROJ, Object.assign({ assigned: two }, ctx))[0].target, PID);
    assert.equal(PC.projectClusters(free, [Object.assign({}, PROJ[0], { archived: true })], Object.assign({ assigned: two }, ctx))[0].target, undefined);
    const P2 = 'p-0000beef';
    const split = two.concat([inRepo({ projectId: P2 }), inRepo({ projectId: P2 })]);
    assert.equal(PC.projectClusters(free, PROJ.concat([{ id: P2, name: 'B' }]), Object.assign({ assigned: split }, ctx))[0].target, undefined, '2:2 is no majority');
  });
  it('a key draft gets its target the same way (the same typed ticket, ≥ 2 assigned hits)', () => {
    const k = { 'ACME-3269': 1 };
    const asg = [S({ typedKeys: k, projectId: PID }), S({ typedKeys: k, projectId: PID })];
    const ds = PC.projectClusters([S({ typedKeys: k }), S({ typedKeys: k })], PROJ, Object.assign({ assigned: asg }, ctx));
    assert.deepEqual([ds[0].key, ds[0].target, ds[0].targetSessions], ['k:ACME-3269', PID, 2]);
  });
  it('rootOf: two sessions in a worktree + one in the main repo → ONE draft to the main repo', () => {
    const WT = W(HOME, 'ccui-wt-x');
    const rootOf = (r) => (PC.projectPathKey(r) === PC.projectPathKey(WT) ? CCUI : null);
    const free = [S({ dirs: { [W(WT, 'lib')]: 1 } }), S({ projectPath: W(WT, 'test') }), inRepo()];
    const ds = PC.projectClusters(free, [], Object.assign({ rootOf }, ctx));
    assert.equal(ds.length, 1);
    assert.deepEqual([ds[0].key, ds[0].sessions, ds[0].values.addDirs], ['d:' + CCUI.toLowerCase(), 3, [CCUI]]);
    assert.equal(PC.projectClusters(free, [], ctx).length, 1, 'premise: without the map the worktree is a draft of its own (2) and the repo alone has 1');
    assert.equal(PC.projectClusters(free, [], ctx)[0].label, 'ccui-wt-x');
  });
});

describe('lib/projects worktreeMainOf — the .git FILE of a worktree names its main repo, and git\'s way back must match', () => {
  const P = require('../lib/projects');
  const base = fs.mkdtempSync(path.join(SBX.root, 'wt-'));
  const main = path.join(base, 'mainrepo'), wt = path.join(base, 'mainrepo-wt'), sub = path.join(base, 'subrepo'), fake = path.join(base, 'forged');
  const gd = path.join(main, '.git', 'worktrees', 'mainrepo-wt');
  fs.mkdirSync(gd, { recursive: true });
  fs.writeFileSync(path.join(gd, 'gitdir'), path.join(wt, '.git').split(B).join('/') + '\n'); // what git writes
  for (const d of [wt, sub, fake]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ' + gd.split(B).join('/') + '\n');
  fs.writeFileSync(path.join(fake, '.git'), 'gitdir: ' + gd.split(B).join('/') + '\n'); // points at a gitdir that is not its own
  fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../mainrepo/.git/modules/subrepo\n');
  it('worktree → main root; a normal repo, a submodule, a forged .git file and a vanished folder → "" (stays as it is)', async () => {
    assert.equal(await P.worktreeMainOf(wt, base), main);
    assert.equal(await P.worktreeMainOf(main, base), '');
    assert.equal(await P.worktreeMainOf(sub, base), '');
    assert.equal(await P.worktreeMainOf(fake, base), '', 'the way back <gitdir>/gitdir was not checked');
    assert.equal(await P.worktreeMainOf(path.join(base, 'gone'), base), '');
  });
  const H = require('os').homedir();
  const sess = [{ dirs: { [path.join(H, 'ccui-wt-x', 'lib')]: 1 } }, { projectPath: path.join(H, 'ccui-wt-x') }, { dirs: { [path.join(H, 'other', 'a')]: 1 } }];
  it('worktreeRootMap: only worktree roots are mapped, each root looked up ONCE (memo)', async () => {
    P._resetWorktreeMemo();
    const asked = [];
    const deps = { probe: async () => ({ state: 'ok' }), worktreeMainOf: async (r) => { asked.push(r); return /ccui-wt-x$/.test(r) ? path.join(H, 'claude-code-ui') : ''; } };
    const m = await P.worktreeRootMap(sess, deps);
    assert.deepEqual([...m.keys()], [PC.projectPathKey(path.join(H, 'ccui-wt-x'))]);
    await P.worktreeRootMap(sess, deps);
    assert.equal(asked.length, 2, 'looked up again: ' + asked.length);
    P._resetWorktreeMemo();
  });
  it('a HANGING root: two overview calls start at most ONE access each, read nothing, and the draft still comes (unmapped)', async () => {
    P._resetWorktreeMemo();
    const probes = [], reads = [];
    const deps = { waitMs: 30, probe: (r) => { probes.push(r); return new Promise(() => {}); }, worktreeMainOf: async (r) => { reads.push(r); return ''; } };
    const one = [sess[0]];
    const t0 = Date.now();
    const m1 = await P.worktreeRootMap(one, deps);
    const m2 = await P.worktreeRootMap(one, deps);
    assert.ok(Date.now() - t0 < 1000, 'the overview waited for the hang');
    assert.deepEqual([m1.size, m2.size, probes.length, reads.length], [0, 0, 1, 0]);
    const free = [{ id: 'a', projectId: null, dirs: one[0].dirs }, { id: 'b', projectId: null, dirs: one[0].dirs }];
    const ds = PC.projectClusters(free, [], { home: H, blocked: [H], rootOf: (r) => m2.get(PC.projectPathKey(r)) || null });
    assert.deepEqual(ds.map((d) => d.label), ['ccui-wt-x']);
    P._resetWorktreeMemo();
  });
  it('an UNREACHABLE root is backed off: not probed again for 10 min, never read', async () => {
    P._resetWorktreeMemo();
    let t = 1000;
    const probes = [], reads = [];
    const deps = { now: () => t, probe: async (r) => { probes.push(r); return { state: 'unreachable', timeoutMs: 5 }; }, worktreeMainOf: async (r) => { reads.push(r); return ''; } };
    const one = [sess[0]];
    await P.worktreeRootMap(one, deps);
    t += 9 * 60 * 1000;
    await P.worktreeRootMap(one, deps);
    assert.deepEqual([probes.length, reads.length], [1, 0]);
    t += 2 * 60 * 1000;
    await P.worktreeRootMap(one, deps);
    assert.equal(probes.length, 2, 'never asked again after the backoff');
    P._resetWorktreeMemo();
  });
});
