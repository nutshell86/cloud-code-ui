'use strict';
// P-2 „Cockpit", Teil 1a — the DATA half: fold v4, folder rules, suggestions, costs over all sessions, plans.
//
// What has to hold, and the defect each block guards against:
//   · fold v4 (lib/corpus.js): Jira keys ONLY from text the user typed — never from an injected line (isMeta,
//     a compaction summary, a system-reminder, a tool result, an attachment), never a placeholder, counted per
//     MESSAGE uuid so the second copy a compaction writes does not count twice — also across a resumed tail; the
//     last assistant text without the compaction summary, capped without splitting a surrogate; last-prompt and
//     away_summary; slug last-wins; nothing of it from an agent file. And the cache carries it (CACHE_V 4) and
//     refuses a damaged copy of it.
//   · listPlans hides the subagent plans `<slug>-agent-<hex>.md`.
//   · projectOfSession: an explicit entry ALWAYS wins ('' included); a rule matches at a PATH BOUNDARY
//     (C:\Atlas is not C:\Atlas2), `*` is a plain prefix, the most specific rule wins, a rule covering the main
//     folder / HOME / system32 is refused on save and ignored when read.
//   · a rule NEVER steers a start — the decisive pair: decorate labels the session, resolveStart does not see it.
//   · projectSuggest: never for a decided session, plan/path strong, Jira weak and never above a strong one, a
//     placeholder or an injected key suggests nothing.
//   · the overview's sums equal the per-session numbers (epsilon), over ALL sessions, 30 days and all-time.
// Hermetic: one sandbox (test/sandbox.js) with its own transcripts and plans; its env is set BEFORE lib/paths
// is loaded. Nothing here reads ~/.claude.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { makeSandbox } = require('./sandbox');

const ROOT = path.join(__dirname, '..');
const SBX = makeSandbox('cockpit', { fakeCli: true });
Object.assign(process.env, SBX.env); // before the first require of lib/paths
const { scanCorpus, flushCache, _resetCorpusCache, COCKPIT_CAPS, CACHE_V } = require('../lib/corpus');
const { scanSessions } = require('../lib/sessions');
const { scanUsage } = require('../lib/usage');
const { listPlans } = require('../lib/skills');
const P = require('../lib/projects');
const PC = require('../public/js/projects-core');
const { PROJECTS_FILE, SESSION_PROJECTS_FILE, TRANSCRIPT_CACHE_FILE, HOME, PLANS_DIR } = require('../lib/paths');
after(() => SBX.cleanup());

const B = '\\';
const PROJECTS = path.join(SBX.claudeDir, 'projects');
const SYS32 = 'C:' + B + 'WINDOWS' + B + 'system32';
const sid = (n) => n.repeat(8) + '-' + n.repeat(4) + '-4' + n.repeat(3) + '-8' + n.repeat(3) + '-' + n.repeat(12);
const enc = (cwd) => cwd.replace(/[:\\/]/g, '-');
const fileOf = (cwd, id) => path.join(PROJECTS, enc(cwd), id + '.jsonl');
const write = (cwd, id, lines) => { const f = fileOf(cwd, id); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, lines.join('\n') + '\n'); return f; };
const append = (cwd, id, lines) => fs.appendFileSync(fileOf(cwd, id), lines.join('\n') + '\n');
// line builders — the shapes of the live corpus (measured: key sets only), never its content
const user = (cwd, o) => JSON.stringify(Object.assign({ type: 'user', cwd, timestamp: o.ts || '2026-02-01T09:00:00.000Z', uuid: o.uuid,
  message: { role: 'user', content: o.content !== undefined ? o.content : [{ type: 'text', text: o.text }] } }, o.extra || {}));
const asst = (cwd, o) => JSON.stringify(Object.assign({ type: 'assistant', cwd, timestamp: o.ts || '2026-02-01T09:00:05.000Z', uuid: o.uuid,
  message: Object.assign({ role: 'assistant', model: 'claude-opus-4-8', content: o.content || [{ type: 'text', text: o.text || 'ok' }] },
    o.usage ? { id: o.id, usage: o.usage } : {}) }, o.extra || {}));
const usage = (inTok, outTok) => ({ input_tokens: inTok, output_tokens: outTok, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
const lastPrompt = (text) => JSON.stringify(text == null ? { type: 'last-prompt', leafUuid: 'x', sessionId: 's' } : { type: 'last-prompt', lastPrompt: text, leafUuid: 'x', sessionId: 's' });
const away = (cwd, text, ts) => JSON.stringify({ type: 'system', subtype: 'away_summary', content: text, isMeta: true, cwd, timestamp: ts });
const near = (a, b, label) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)), (label || '') + ': ' + a + ' ≠ ' + b);
const fresh = async () => { _resetCorpusCache(); try { fs.unlinkSync(TRANSCRIPT_CACHE_FILE); } catch { /* none */ } };
const resetStores = () => { for (const f of [PROJECTS_FILE, SESSION_PROJECTS_FILE]) { try { fs.unlinkSync(f); } catch { /* none */ } } };
const recOf = (corpus, id) => corpus.recs.find((r) => r.kind === 'main' && r.session === id);

// ------------------------------------------------------------------------------------------------- fold v4
describe('fold v4 — the cockpit fields of a transcript (lib/corpus.js)', () => {
  const CWD = 'C:' + B + 'Users' + B + 'dev' + B + 'cockpit';
  const S = sid('a');
  const long = 'Letzte Antwort ' + 'x'.repeat(700);
  const lines = () => [
    JSON.stringify({ type: 'mode', sessionId: S, mode: 'default' }),
    user(CWD, { uuid: 'u1', text: 'Bitte ACME-5032 und proj-744 ansehen, nicht PR-12, nicht ACME-1234, nicht PROJ-456, auch nicht XACME-1', extra: { slug: 'alpha-plan' } }),
    user(CWD, { uuid: 'u1', text: 'Bitte ACME-5032 und proj-744 ansehen, nicht PR-12, nicht ACME-1234, nicht PROJ-456, auch nicht XACME-1', extra: { slug: 'alpha-plan' } }), // the copy a compaction writes
    user(CWD, { uuid: 'u2', text: 'ACME-5032 nochmal, zweimal ACME-5032 in einer Nachricht' }),
    user(CWD, { uuid: 'u3', text: 'eingespielt ACME-9001', extra: { isMeta: true } }),
    user(CWD, { uuid: 'u4', text: 'Zusammenfassung: ACME-9002 war Thema', extra: { isCompactSummary: true, isVisibleInTranscriptOnly: true } }),
    user(CWD, { uuid: 'u5', text: '<system-reminder>ACME-9003</system-reminder>' }),
    user(CWD, { uuid: 'u6', text: '<command-name>/copy-jira</command-name><command-message>copy-jira</command-message><command-args>ACME-4242</command-args>' }),
    user(CWD, { uuid: 'u7', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ACME-9004 im Werkzeug' }] }),
    JSON.stringify({ type: 'attachment', cwd: CWD, uuid: 'u8', attachment: { type: 'text', content: 'ACME-9005 aus dem Systemkontext' } }),
    user(CWD, { uuid: 'u9', text: 'Sidechain ACME-9006', extra: { isSidechain: true } }),
    asst(CWD, { uuid: 'a1', text: 'Antwort A', ts: '2026-02-01T09:01:00.000Z', id: 'msg_a1', usage: usage(100, 10) }),
    lastPrompt('Mein erster Prompt'),
    asst(CWD, { uuid: 'a2', ts: '2026-02-01T09:02:00.000Z', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] }),
    asst(CWD, { uuid: 'a3', text: long, ts: '2026-02-01T09:03:00.000Z', extra: { slug: 'beta-plan' } }),
    asst(CWD, { uuid: 'a4', text: 'Agent-Text im Hauptstrang', ts: '2026-02-01T09:04:00.000Z', extra: { isSidechain: true } }),
    asst(CWD, { uuid: 'a5', text: '   ', ts: '2026-02-01T09:05:00.000Z' }),
    user(CWD, { uuid: 'u10', text: 'weiter', ts: '2026-02-01T09:06:00.000Z', extra: { slug: '../evil' } }),
    lastPrompt('Mein letzter Prompt ' + 'y'.repeat(400)),
    lastPrompt(null), // 12 of 7503 live lines carry no lastPrompt — they must not erase the one before
    away(CWD, 'Rückblick: am Plan gearbeitet', '2026-02-01T09:07:00.000Z'),
  ];
  const agentFile = () => {
    const f = path.join(PROJECTS, enc(CWD), S, 'subagents', 'agent-abc123.jsonl');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, [user(CWD, { uuid: 'g1', text: 'Agent-Auftrag ACME-7777', extra: { slug: 'gamma' } }), asst(CWD, { uuid: 'g2', text: 'Agent fertig' }), lastPrompt('agent prompt')].join('\n') + '\n');
  };
  let rec, item;
  before(async () => {
    await fresh();
    write(CWD, S, lines());
    agentFile();
    rec = recOf(await scanCorpus(), S);
    item = (await scanSessions()).find((s) => s.id === S);
  });

  it('Jira keys: only typed text, allow-listed, upper-cased, per MESSAGE (the compaction copy and a double mention count once)', () => {
    assert.deepEqual(rec.jk, { 'ACME-5032': 2, 'PROJ-744': 1, 'ACME-4242': 1 },
      'injected (isMeta, compaction summary, system-reminder, tool_result, attachment, sidechain), placeholders and PR- must not count');
  });
  it('the slash command\'s typed arguments count — the rest of a `<`-frame does not', () => {
    assert.equal(rec.jk['ACME-4242'], 1);
    assert.ok(!('ACME-9003' in rec.jk));
  });
  it('last assistant text: the last NON-blank text block of the main thread, capped at 600 with „…"', () => {
    assert.equal(rec.last.length, COCKPIT_CAPS.LAST_MAX);
    assert.ok(rec.last.startsWith('Letzte Antwort '), rec.last.slice(0, 30));
    assert.ok(rec.last.endsWith('…'));
    assert.equal(rec.lastAt, '2026-02-01T09:03:00.000Z', 'the date of the text, not of the tool-only or blank line after it');
  });
  it('last-prompt (≤ 300, a line without one keeps the previous) and away_summary — each with a date', () => {
    assert.ok(rec.lp.startsWith('Mein letzter Prompt '));
    assert.equal(rec.lp.length, COCKPIT_CAPS.LP_MAX);
    assert.equal(rec.lpAt, '2026-02-01T09:06:00.000Z', 'the last timestamp seen before the record');
    assert.equal(rec.recap, 'Rückblick: am Plan gearbeitet');
    assert.equal(rec.recapAt, '2026-02-01T09:07:00.000Z');
  });
  it('slug: the last VALID one wins (a path-shaped value is ignored)', () => {
    assert.equal(rec.slug, 'beta-plan');
  });
  it('an agent transcript contributes nothing of it — and its record stays empty', async () => {
    const agent = (await scanCorpus()).recs.find((r) => r.kind !== 'main' && r.session === S);
    assert.ok(agent, 'the agent file must have been folded');
    assert.deepEqual([agent.slug, agent.jk, agent.last, agent.lp], ['', {}, '', '']);
    assert.ok(!('ACME-7777' in rec.jk));
  });
  it('scanSessions hands the fields on (additive)', () => {
    assert.equal(item.slug, 'beta-plan');
    assert.deepEqual(item.typedKeys, rec.jk);
    assert.notEqual(item.typedKeys, rec.jk, 'a copy, not the cached record');
    assert.deepEqual([item.lastText, item.lastTextAt, item.lastPrompt, item.lastPromptAt, item.recap, item.recapAt],
      [rec.last, rec.lastAt, rec.lp, rec.lpAt, rec.recap, rec.recapAt]);
  });
  it('the cut never splits a surrogate pair', async () => {
    const S2 = sid('b');
    write(CWD, S2, [asst(CWD, { uuid: 'z1', text: 'a'.repeat(COCKPIT_CAPS.LAST_MAX - 2) + '😀' + 'b'.repeat(20) })]);
    const r = recOf(await scanCorpus(), S2);
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(r.last), 'a lone high surrogate at the cut');
    assert.ok(r.last.length <= COCKPIT_CAPS.LAST_MAX && r.last.endsWith('…'));
  });
  it('at most JK_MAX distinct keys per session — the first ones, deterministically', async () => {
    const S3 = sid('c');
    const many = Array.from({ length: COCKPIT_CAPS.JK_MAX + 3 }, (_, i) => user(CWD, { uuid: 'm' + i, text: 'PROJ-' + (100 + i) }));
    write(CWD, S3, many);
    const r = recOf(await scanCorpus(), S3);
    assert.deepEqual(Object.keys(r.jk), Array.from({ length: COCKPIT_CAPS.JK_MAX }, (_, i) => 'PROJ-' + (100 + i)));
  });
  it('the uuid memory is bounded (FIFO) — a long session does not grow the cache without end', async () => {
    const S4 = sid('d');
    write(CWD, S4, Array.from({ length: COCKPIT_CAPS.JKU_MAX + 25 }, (_, i) => user(CWD, { uuid: 'q' + i, text: 'ACME-77' })));
    const r = recOf(await scanCorpus(), S4);
    assert.equal(r.jku.length, COCKPIT_CAPS.JKU_MAX);
    assert.equal(r.jk['ACME-77'], COCKPIT_CAPS.JKU_MAX + 25);
    assert.equal(r.jku[0], 'q25', 'the oldest uuids leave first');
  });
});

describe('fold v4 — the cache carries it (CACHE_V 4), across a resume, and refuses a damaged copy', () => {
  const CWD = 'C:' + B + 'Users' + B + 'dev' + B + 'resume';
  const S = sid('e');
  const head = [
    user(CWD, { uuid: 'r1', text: 'Ticket ACME-3269 bitte', extra: { slug: 'resume-plan' } }),
    asst(CWD, { uuid: 'r2', text: 'erste Antwort', ts: '2026-02-01T10:00:00.000Z', id: 'msg_r2', usage: usage(10, 1) }),
    lastPrompt('erster Prompt'),
  ];
  const tail = [
    user(CWD, { uuid: 'r1', text: 'Ticket ACME-3269 bitte', extra: { slug: 'resume-plan' } }), // the compaction copy, in the NEXT tail
    user(CWD, { uuid: 'r3', text: 'und PROJ-701' }),
    asst(CWD, { uuid: 'r4', text: 'zweite Antwort', ts: '2026-02-01T10:05:00.000Z' }),
    away(CWD, 'zurück', '2026-02-01T10:06:00.000Z'),
  ];
  const fields = (r) => ({ slug: r.slug, jk: r.jk, jku: r.jku, last: r.last, lastAt: r.lastAt, lp: r.lp, lpAt: r.lpAt, recap: r.recap, recapAt: r.recapAt });

  it('CACHE_V is at least 4 — a v3 cache is a MISS (its records would never get the fields; v5 = P5, test/projects-drafts)', () => {
    assert.ok(CACHE_V >= 4);
  });
  it('a duplicate uuid in a RESUMED tail is still recognised — resumed = one-pass', async () => {
    await fresh();
    write(CWD, S, head);
    await scanCorpus();
    assert.equal(await flushCache(), true);
    _resetCorpusCache(); // the uuid memory can now only come back from DISK
    append(CWD, S, tail);
    const resumed = fields(recOf(await scanCorpus(), S));
    assert.deepEqual(resumed.jk, { 'ACME-3269': 1, 'PROJ-701': 1 }, 'the copy in the resumed tail counted twice');
    await fresh();
    const once = fields(recOf(await scanCorpus(), S));
    assert.deepEqual(resumed, once, 'resumed and one-pass folds disagree');
  });
  it('the resume folds into a CLONE — a reader holding the previous record never sees it change', async () => {
    const held = recOf(await scanCorpus(), S);
    const snap = JSON.stringify(fields(held));
    append(CWD, S, [user(CWD, { uuid: 'r5', text: 'noch PROJ-702' }), asst(CWD, { uuid: 'r6', text: 'dritte Antwort' })]);
    const next = recOf(await scanCorpus(), S);
    assert.equal(next.jk['PROJ-702'], 1, 'premise: the tail was folded');
    assert.equal(JSON.stringify(fields(held)), snap, 'the held record was mutated by the resume');
  });
  it('a warm restart reads the fields from disk without refolding', async () => {
    const before = fields(recOf(await scanCorpus(), S));
    assert.equal(await flushCache(), true);
    _resetCorpusCache();
    const again = await scanCorpus();
    assert.equal(again.stats.folded, 0, 'the v4 record was not adopted from disk');
    assert.deepEqual(fields(recOf(again, S)), before);
  });
  it('a damaged cockpit field makes the WHOLE file a miss — and the refold restores it', async () => {
    await scanCorpus();
    await flushCache();
    const good = fs.readFileSync(TRANSCRIPT_CACHE_FILE, 'utf8');
    const full = fileOf(CWD, S);
    const expect = fields(recOf(await scanCorpus(), S));
    const dmg = (fn) => { const o = JSON.parse(good); fn(o.files[full]); return JSON.stringify(o); };
    const trusted = [];
    for (const [label, body] of [
      ['jk is an array', dmg((r) => { r.jk = ['ACME-1']; })],
      ['a jk key is not a ticket key', dmg((r) => { r.jk = { constructor: 1 }; })],
      ['a jk count is 0', dmg((r) => { r.jk = { 'ACME-3269': 0 }; })],
      ['a jk count is negative', dmg((r) => { r.jk = { 'ACME-3269': -2 }; })],
      ['more keys than the fold keeps', dmg((r) => { r.jk = Object.fromEntries(Array.from({ length: COCKPIT_CAPS.JK_MAX + 1 }, (_, i) => ['PROJ-' + (i + 1), 1])); })],
      ['jku is a string', dmg((r) => { r.jku = 'r1'; })],
      ['jku holds a number', dmg((r) => { r.jku = [1]; })],
      ['jku is longer than the fold keeps', dmg((r) => { r.jku = Array.from({ length: COCKPIT_CAPS.JKU_MAX + 1 }, (_, i) => 'x' + i); })],
      ['last is a number', dmg((r) => { r.last = 5; })],
      ['slug is an object', dmg((r) => { r.slug = {}; })],
      ['lastAt is an object', dmg((r) => { r.lastAt = {}; })],
    ]) {
      fs.writeFileSync(TRANSCRIPT_CACHE_FILE, body);
      _resetCorpusCache();
      const got = await scanCorpus();
      try { assert.deepEqual(fields(recOf(got, S)), expect); assert.ok(got.stats.folded > 0); } catch (e) { trusted.push(label + ' → ' + e.message.split('\n')[0]); }
    }
    assert.deepEqual(trusted, [], 'a damaged v4 field must be a MISS and refold. Trusted instead:\n  - ' + trusted.join('\n  - '));
  });
});

// ------------------------------------------------------------------------------------------------ listPlans
describe('listPlans — subagent plans are not listed (lib/skills.js)', () => {
  it('<slug>-agent-<hex>.md stays out; ordinary plans, including ones with „agent" in the name, stay in', async () => {
    fs.mkdirSync(PLANS_DIR, { recursive: true });
    for (const f of ['alpha-plan.md', 'mehr-plan.md', 'ich-habe-die-idee-tranquil-lake-agent-a50c743ccc9948a5c.md', 'agent-handbuch.md', 'notes.txt']) {
      fs.writeFileSync(path.join(PLANS_DIR, f), '# ' + f + '\n\nText\n');
    }
    const names = (await listPlans()).map((p) => p.name).sort();
    assert.deepEqual(names, ['agent-handbuch.md', 'alpha-plan.md', 'mehr-plan.md']);
  });
});

// --------------------------------------------------------------------------------------- folder rules (pure)
describe('projectOfSession — explicit always wins, rules at a path boundary, the most specific rule', () => {
  const pA = { id: 'p-0000000a', paths: ['C:' + B + 'Atlas'] };
  const pW = { id: 'p-0000000b', paths: ['C:' + B + 'Users' + B + 'dev' + B + 'ccui-wt-*'] };
  const pC = { id: 'p-0000000c', paths: ['c:/users/dev/ccui-wt-cockpit'] };
  const pS = { id: 'p-0000000d', paths: [SYS32, 'D:' + B] };
  const pT = { id: 'p-0000000e', paths: ['C:' + B + 'Atlas'] }; // the same rule as pA, later in the list
  const LIST = [pA, pW, pC, pS, pT];
  const CTX = { blocked: [SYS32] };
  const X = sid('1');
  const of = (cwd, map, item) => PC.projectOfSession(Object.assign({ id: X, projectPath: cwd }, item || {}), LIST, map === undefined ? {} : map, CTX);
  const table = [
    ['a folder below the rule', 'C:' + B + 'Atlas' + B + 'workspace', pA.id],
    ['the rule\'s folder itself', 'C:' + B + 'Atlas', pA.id],
    ['PATH BOUNDARY — C:\\Atlas is not C:\\Atlas2', 'C:' + B + 'Atlas2', null],
    ['nor C:\\Atlas-alt', 'C:' + B + 'Atlas-alt' + B + 'x', null],
    ['\\ = /, case folded, trailing separator', 'c:/ATLAS/Workspace/', pA.id],
    ['`*` is a plain prefix of the spelling', 'C:' + B + 'Users' + B + 'dev' + B + 'ccui-wt-pr7', pW.id],
    ['…which still needs its own characters', 'C:' + B + 'Users' + B + 'dev' + B + 'ccui-wt', null],
    ['the most specific rule beats a shorter `*`', 'C:' + B + 'Users' + B + 'dev' + B + 'ccui-wt-cockpit' + B + 'lib', pC.id],
    ['a blocked rule (system32) is ignored when read', SYS32, null],
    ['…and below it as well', SYS32 + B + 'drivers', null],
    ['a drive root rule keeps its one separator', 'D:' + B + 'daten', pS.id],
    ['a tie goes to the earlier project', 'C:' + B + 'Atlas' + B + 'x', pA.id],
    ['no cwd → nothing', '', null],
  ];
  for (const [label, cwd, want] of table) {
    it(label, () => {
      const r = of(cwd);
      assert.equal(r.projectId, want, JSON.stringify(cwd));
      assert.equal(r.derived, want !== null);
    });
  }
  it('an explicit entry ALWAYS wins over a rule — a project id, and "" (deliberately none) too', () => {
    const atlas = 'C:' + B + 'Atlas' + B + 'workspace';
    assert.deepEqual(of(atlas, { [X]: pW.id }), { projectId: pW.id, derived: false });
    assert.deepEqual(of(atlas, { [X]: '' }), { projectId: '', derived: false });
    assert.deepEqual(of(atlas, { [X.toLowerCase()]: '' }, { id: X.toUpperCase() }), { projectId: '', derived: false }, 'map keys are lower case');
    assert.deepEqual(of(atlas, { [X]: 'p-deadbeef' }), { projectId: 'p-deadbeef', derived: false }, 'a dangling id stays what it is');
  });
  it('without a map it reads the decorated item\'s stored value', () => {
    const atlas = 'C:' + B + 'Atlas';
    assert.deepEqual(of(atlas, null, { projectId: '' }), { projectId: '', derived: false });
    assert.equal(of(atlas, null, { projectId: null }).projectId, pA.id);
  });
  it('a hostile list entry is skipped, not dereferenced', () => {
    const r = PC.projectOfSession({ id: X, projectPath: 'C:' + B + 'Atlas' }, [null, { id: '__proto__', paths: ['C:' + B] }, { id: 'p-0000000f', paths: 'C:' + B }, pA], {}, CTX);
    assert.equal(r.projectId, pA.id);
  });
});

describe('projectRuleParse / projectRuleMatch / validation of the rules', () => {
  it('a `*` only at the end; `C:\\Atlas\\*` means BELOW C:\\Atlas', () => {
    assert.equal(PC.projectRuleParse('C:' + B + 'a*b'), null);
    assert.equal(PC.projectRuleParse('*'), null);
    assert.equal(PC.projectRuleParse('C:' + B + 'a**'), null);
    assert.equal(PC.projectRuleMatch('C:' + B + 'Atlas' + B + '*', 'C:' + B + 'Atlas'), false);
    assert.equal(PC.projectRuleMatch('C:' + B + 'Atlas' + B + '*', 'C:' + B + 'Atlas' + B + 'w'), true);
  });
  const HOMEDIR = 'C:' + B + 'Users' + B + 'dev';
  const roots = [HOMEDIR, SYS32];
  const v = (paths) => PC.projectValidate({ name: 'R', paths }, { posix: false, blockedRoots: roots });
  const codes = (r) => r.errors.map((e) => e.field + ':' + e.code + (e.value !== undefined ? ':' + e.value : '')).sort();
  it('a rule that covers the main folder, HOME or system32 is refused (`blocked`) — whatever its spelling', () => {
    for (const r of [SYS32, 'c:/windows/system32/', 'C:' + B + 'WINDOWS', 'C:' + B, 'C:' + B + 'WIN*', HOMEDIR, HOMEDIR + '*', 'C:' + B + 'Users']) {
      assert.deepEqual(codes(v([r])), ['paths:blocked:' + r], r);
    }
  });
  it('…while a folder BELOW them is a legitimate rule', () => {
    for (const r of [HOMEDIR + B + 'ccui-wt-*', HOMEDIR + B + '*', SYS32 + B + 'eigen', 'C:' + B + 'Atlas', B + B + 'srv' + B + 'share']) {
      assert.deepEqual(codes(v([r])), [], r);
    }
  });
  it('grammar: relative and a `*` in the middle are refused; NUL too', () => {
    assert.deepEqual(codes(v(['Atlas'])), ['paths:relative:Atlas']);
    assert.deepEqual(codes(v(['C:*'])), ['paths:relative:C:*']);
    assert.deepEqual(codes(v(['C:' + B + 'a*b'])), ['paths:invalid:C:' + B + 'a*b']);
    assert.deepEqual(codes(v(['C:' + B + 'a\0'])), ['paths:nul:C:' + B + 'a\0']);
  });
  it('normalise: trimmed, de-duplicated by the comparison key — `C:\\Atlas` and `C:\\Atlas*` stay two; cap 8', () => {
    const r = PC.projectNormalize({ name: 'R', paths: [' C:' + B + 'Atlas ', 'c:/atlas/', 'C:' + B + 'ATLAS', 'C:' + B + 'Atlas*', ''] });
    assert.deepEqual(r.project.paths, ['C:' + B + 'Atlas', 'C:' + B + 'Atlas*']);
    assert.deepEqual(r.errors, []);
    const over = PC.projectNormalize({ name: 'R', paths: Array.from({ length: 9 }, (_, i) => 'C:' + B + 'r' + i) });
    assert.deepEqual(over.errors.map((e) => e.field + ':' + e.code), ['paths:too-many']);
    assert.deepEqual(PC.projectNormalize({ name: 'R', paths: 'C:' + B + 'x' }).errors.map((e) => e.code), ['type']);
  });
  it('jiraKeys: upper-cased, allow-listed, de-duplicated, cap 20; a placeholder is allowed but SAID', () => {
    const r = PC.projectValidate({ name: 'J', jiraKeys: ['acme-3269', 'ACME-3269', ' PROJ-744 ', 'PR-12', 'PROJ-456'] });
    assert.deepEqual(r.project.jiraKeys, ['ACME-3269', 'PROJ-744', 'PROJ-456']);
    assert.deepEqual(r.errors.map((e) => e.field + ':' + e.code + ':' + e.value), ['jiraKeys:invalid:PR-12']);
    assert.deepEqual(r.warnings.map((w) => w.code + ':' + w.value), ['jira-placeholder:PROJ-456']);
    const over = PC.projectNormalize({ name: 'J', jiraKeys: Array.from({ length: 21 }, (_, i) => 'PROJ-' + (i + 1)) });
    assert.deepEqual(over.errors.map((e) => e.field + ':' + e.code), ['jiraKeys:too-many']);
  });
  it('hideInAll: a boolean, default false', () => {
    assert.equal(PC.projectNormalize({ name: 'H' }).project.hideInAll, false);
    assert.equal(PC.projectNormalize({ name: 'H', hideInAll: true }).project.hideInAll, true);
    assert.deepEqual(PC.projectNormalize({ name: 'H', hideInAll: 'ja' }).errors.map((e) => e.field + ':' + e.code), ['hideInAll:type']);
  });
  it('the save refuses a blocked rule (HOME, the main folder) and writes nothing', async () => {
    resetStores();
    const deps = { exists: async () => true, mainCwd: async () => SYS32, mcpNames: async () => [] };
    for (const rule of [HOME, SYS32, SYS32.toLowerCase() + B]) {
      const r = await P.upsertProject({ name: 'Blocked', paths: [rule] }, deps);
      assert.equal(r.status, 400, rule);
      assert.deepEqual(r.errors.map((e) => e.field + ':' + e.code), ['paths:blocked'], rule);
    }
    assert.equal(fs.existsSync(PROJECTS_FILE), false);
    const ok = await P.upsertProject({ name: 'Atlas', paths: ['C:' + B + 'Atlas'], hideInAll: true, jiraKeys: ['proj-1'] }, deps);
    assert.equal(ok.status, 200, JSON.stringify(ok));
    assert.deepEqual([ok.project.paths, ok.project.hideInAll, ok.project.jiraKeys], [['C:' + B + 'Atlas'], true, ['PROJ-1']]);
  });
});

// ------------------------------------------------------------------------------- a rule never steers a start
describe('a folder rule NEVER steers a start (Julian\'s decision 05.10.)', () => {
  const CWD = 'C:' + B + 'Atlas' + B + 'workspace';
  const S = sid('f');
  let A;
  before(async () => {
    resetStores();
    A = (await P.upsertProject({ name: 'Atlas-Start', paths: ['C:' + B + 'Atlas'], instructions: 'nur im Projekt', model: 'claude-opus-4-8' },
      { exists: async () => true, mainCwd: async () => SYS32, mcpNames: async () => [] })).project;
  });
  it('the discriminating pair: decorate labels the session by the rule — the start resolves NO project for it', async () => {
    const [it0] = await P.decorateSessions([{ id: S, projectPath: CWD }], { mainCwd: async () => SYS32 });
    assert.equal(it0.projectDerived, A.id, 'premise: the rule IS active for this session');
    assert.equal(it0.projectId, null);
    for (const [label, body] of [['resume', {}], ['fork', { fork: true }], ['resume with the cwd in the body', { cwd: CWD }], ['fork with the cwd', { fork: true, cwd: CWD }]]) {
      const r = await P.resolveStart(body, S);
      assert.deepEqual([r.pid, r.project], [null, null], label + ': a rule reached the start');
    }
    const fresh0 = await P.resolveStart({ cwd: CWD }, null);
    assert.deepEqual([fresh0.pid, fresh0.project], [null, null], 'a fresh start in the rule\'s folder');
  });
  it('the start values carry none of the cockpit fields', () => {
    const sv = PC.projectStartValues(A);
    assert.deepEqual(Object.keys(sv), PC.PROJECT_START_KEYS);
    for (const k of ['paths', 'hideInAll', 'jiraKeys', 'instructions']) assert.ok(!(k in sv), k);
  });
  it('…and once assigned EXPLICITLY, the start does resolve it (the rule was the only thing missing)', async () => {
    await P.assignSessions([S], A.id);
    assert.equal((await P.resolveStart({}, S)).pid, A.id);
    await P.assignSessions([S], null);
  });
});

// ------------------------------------------------------------------------------------------- projectSuggest
describe('projectSuggest — display only; plan/path strong, Jira weak; never for a decided session', () => {
  const P1 = { id: 'p-00000001', jiraKeys: ['ACME-5032'], paths: [] };
  const P2 = { id: 'p-00000002', jiraKeys: [], paths: ['C:' + B + 'Atlas'] };
  const P3 = { id: 'p-00000003', jiraKeys: ['PROJ-456'], paths: [] };            // a placeholder key
  const P4 = { id: 'p-00000004', jiraKeys: ['ACME-5032'], paths: [], archived: true };
  const LIST = [P1, P2, P3, P4];
  const PLANS = { 'alpha-plan': { name: 'alpha-plan.md', sessionIds: [sid('2')], projectIds: [P1.id] } };
  const sug = (s) => PC.projectSuggest(Object.assign({ projectId: null, projectDerived: null, slug: '', typedKeys: {} }, s), LIST, PLANS)
    .map((x) => x.projectId + ':' + x.strength + ':' + x.reasons.map((r) => r.reason + (r.mentions ? r.mentions : '')).join('+'));
  const table = [
    ['explicitly assigned → nothing', { projectId: P2.id, slug: 'alpha-plan', typedKeys: { 'ACME-5032': 3 } }, []],
    ['deliberately without ("") → nothing — a refused suggestion must not come back', { projectId: '', slug: 'alpha-plan', projectDerived: P2.id }, []],
    ['slug → a plan of the project: strong', { slug: 'alpha-plan' }, [P1.id + ':strong:plan']],
    ['a slug without a plan file / without an owner: nothing', { slug: 'beta-plan' }, []],
    ['labelled by a rule: strong „path" (make it explicit)', { projectDerived: P2.id }, [P2.id + ':strong:path']],
    ['a typed key of the project: weak — the archived project with the same key is not offered', { typedKeys: { 'ACME-5032': 2 } }, [P1.id + ':weak:jira2']],
    ['a placeholder key suggests nothing, even when a project lists it', { typedKeys: { 'PROJ-456': 3 } }, []],
    ['a weak hint never ranks above a strong one', { typedKeys: { 'ACME-5032': 9 }, projectDerived: P2.id }, [P2.id + ':strong:path', P1.id + ':weak:jira9']],
    ['reasons for one project are merged; plan before path', { slug: 'alpha-plan', typedKeys: { 'ACME-5032': 1 }, projectDerived: P2.id }, [P1.id + ':strong:plan+jira1', P2.id + ':strong:path']],
    ['nothing known → nothing', {}, []],
  ];
  for (const [label, s, want] of table) it(label, () => assert.deepEqual(sug(s), want));

  it('a key that was only INJECTED (never typed) suggests nothing — end to end through the fold', async () => {
    const CWD = 'C:' + B + 'Users' + B + 'dev' + B + 'inject';
    const S = sid('3');
    write(CWD, S, [
      JSON.stringify({ type: 'attachment', cwd: CWD, uuid: 'i0', attachment: { type: 'text', content: 'ACME-5032' } }),
      user(CWD, { uuid: 'i1', text: 'ACME-5032 (Systemkontext)', extra: { isMeta: true } }),
      user(CWD, { uuid: 'i2', text: 'Zusammenfassung ACME-5032', extra: { isCompactSummary: true } }),
      user(CWD, { uuid: 'i3', text: '<task-notification>ACME-5032 fertig</task-notification>' }),
      user(CWD, { uuid: 'i4', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'ACME-5032' }] }] }),
      user(CWD, { uuid: 'i5', text: 'Platzhalter ACME-1234 und PROJ-456' }),
      asst(CWD, { uuid: 'i6', text: 'Ich sehe ACME-5032' }),
    ]);
    const item = (await scanSessions()).find((s) => s.id === S);
    assert.deepEqual(item.typedKeys, {});
    assert.deepEqual(PC.projectSuggest(Object.assign({}, item, { projectId: null, projectDerived: null }), [P1, P3], {}), []);
  });
  it('projectPlanIndex: only existing files, owners only from EXPLICIT assignments, prototype-safe', () => {
    const idx = PC.projectPlanIndex([
      { id: sid('4'), slug: 'alpha-plan', projectId: P1.id },
      { id: sid('5'), slug: 'alpha-plan', projectId: null, projectDerived: P2.id },
      { id: sid('6'), slug: 'ghost-plan', projectId: P1.id },
      { id: sid('7'), slug: 'constructor', projectId: P1.id },
    ], ['alpha-plan.md', 'constructor.md']);
    assert.deepEqual(Object.keys(idx).sort(), ['alpha-plan', 'constructor']);
    assert.deepEqual(idx['alpha-plan'], { name: 'alpha-plan.md', sessionIds: [sid('4'), sid('5')], projectIds: [P1.id] });
    assert.equal(Object.getPrototypeOf(idx), null);
    assert.deepEqual(PC.projectSuggest({ projectId: null, slug: 'toString' }, LIST, idx), []);
  });
});

// ---------------------------------------------------------------------------------------------- the overview
describe('GET /api/projects/overview — costs over ALL sessions, as an estimate (lib/projects.js)', () => {
  const NOW = new Date(2026, 1, 10, 12, 0, 0).getTime(); // local 2026-02-10 → the window starts 2026-01-12
  const MAIN = SYS32;
  const ATLAS = 'C:' + B + 'Atlas' + B + 'workspace';
  const ATLAS2 = 'C:' + B + 'Atlas2';
  const WT = 'C:' + B + 'Users' + B + 'dev' + B + 'ccui-wt-cockpit';
  const M1 = sid('7'), M2 = sid('8'), M3 = sid('9'), AG1 = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a', AG2 = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b', W1 = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c';
  let PX, PA, PW, PZ;
  const deps = () => ({ scanSessions, scanUsage, listPlans, now: () => NOW, mainCwd: async () => MAIN });
  before(async () => {
    resetStores();
    const d = { exists: async () => true, mainCwd: async () => MAIN, mcpNames: async () => [] };
    PX = (await P.upsertProject({ name: 'Demoprojekt', jiraKeys: ['ACME-3269'] }, d)).project;
    PA = (await P.upsertProject({ name: 'Atlas', paths: ['C:' + B + 'Atlas'], hideInAll: true }, d)).project;
    PW = (await P.upsertProject({ name: 'Worktrees', paths: ['C:' + B + 'Users' + B + 'dev' + B + 'ccui-wt-*'] }, d)).project;
    PZ = (await P.upsertProject({ name: 'Alt', archived: true, jiraKeys: ['ACME-3269'] }, d)).project;
    // M1: explicit Demoprojekt, one OLD and one RECENT answer, its plan file exists
    write(MAIN, M1, [
      user(MAIN, { uuid: 'x1', text: 'los', ts: '2025-12-15T09:00:00.000Z', extra: { slug: 'mehr-plan' } }),
      asst(MAIN, { uuid: 'x2', ts: '2025-12-15T09:00:05.000Z', id: 'msg_x2', usage: usage(1000, 100) }),
      lastPrompt('Stand Demoprojekt'),
      asst(MAIN, { uuid: 'x3', text: 'Demoprojekt fertig', ts: '2026-02-01T09:00:05.000Z', id: 'msg_x3', usage: usage(3000, 300) }),
    ]);
    // M2: no entry, the SAME slug (a fork) → strong plan suggestion for Demoprojekt
    write(MAIN, M2, [user(MAIN, { uuid: 'y1', text: 'fork', ts: '2025-12-20T09:00:00.000Z', extra: { slug: 'mehr-plan' } }),
      asst(MAIN, { uuid: 'y2', ts: '2025-12-20T09:00:05.000Z', id: 'msg_y2', usage: usage(500, 50) })]);
    // M3: no entry, a typed key of Demoprojekt → weak suggestion
    write(MAIN, M3, [user(MAIN, { uuid: 'z1', text: 'zu ACME-3269', ts: '2026-02-02T09:00:00.000Z' }),
      asst(MAIN, { uuid: 'z2', ts: '2026-02-02T09:00:05.000Z', id: 'msg_z2', usage: usage(200, 20) })]);
    write(ATLAS, AG1, [user(ATLAS, { uuid: 'g1', text: 'auto', ts: '2026-02-03T09:00:00.000Z' }),
      asst(ATLAS, { uuid: 'g2', ts: '2026-02-03T09:00:05.000Z', id: 'msg_g2', usage: usage(700, 70) })]);
    write(ATLAS2, AG2, [user(ATLAS2, { uuid: 'h1', text: 'daneben', ts: '2026-02-03T09:00:00.000Z' }),
      asst(ATLAS2, { uuid: 'h2', ts: '2026-02-03T09:00:05.000Z', id: 'msg_h2', usage: usage(900, 90) })]);
    write(WT, W1, [user(WT, { uuid: 'w1', text: 'wt', ts: '2026-02-04T09:00:00.000Z' }),
      asst(WT, { uuid: 'w2', ts: '2026-02-04T09:00:05.000Z', id: 'msg_w2', usage: usage(400, 40) })]);
    await P.assignSessions([M1], PX.id);
    await P.assignSessions([W1], ''); // the rule would label it — the explicit '' wins
    fs.mkdirSync(PLANS_DIR, { recursive: true });
    fs.writeFileSync(path.join(PLANS_DIR, 'mehr-plan.md'), '# Demoprojekt-Plan\n\nSchritte\n');
    fs.writeFileSync(path.join(PLANS_DIR, 'mehr-plan-agent-0123abcd.md'), '# Agent\n');
  });

  it('per project = Σ of its sessions (explicit + per rule), all-time AND 30 days — epsilon against bySession', async () => {
    const o = await P.projectsOverview(null, deps());
    assert.equal(o.status, 200);
    assert.equal(o.estimate, true, 'costs must be flagged as an estimate');
    assert.deepEqual(o.window, { days: 30, from: '2026-01-12' });
    const all = await scanUsage(null, null, 0);
    const recent = await scanUsage('2026-01-12', null, 0);
    const costIn = (u, ids) => u.bySession.filter((s) => ids.includes(s.id)).reduce((n, s) => n + s.cost, 0);
    const want = { [PX.id]: [M1], [PA.id]: [AG1], [PW.id]: [] }; // hand table — independent of projectOfSession
    for (const [pid, ids] of Object.entries(want)) {
      const b = o.projects.find((p) => p.id === pid);
      near(b.cost, costIn(all, ids), pid + ' all-time');
      near(b.recentCost, costIn(recent, ids), pid + ' 30 days');
      assert.equal(b.sessions, ids.length, pid);
    }
    assert.ok(o.projects.find((p) => p.id === PX.id).recentCost > 0 && o.projects.find((p) => p.id === PX.id).recentCost < o.projects.find((p) => p.id === PX.id).cost, 'the old answer is outside the window');
    const atlas = o.projects.find((p) => p.id === PA.id);
    assert.deepEqual([atlas.explicitSessions, atlas.derivedSessions, atlas.hideInAll], [0, 1, true]);
    assert.equal(atlas.top[0].derived, true, 'a rule-labelled row says so');
    // every cent is somewhere: projects + none + free = the total, and the total = the Usage page's
    near(o.totals.cost, all.total.cost, 'total');
    const parts = o.projects.reduce((n, p) => n + p.cost, 0) + o.none.cost + o.unassigned.cost;
    near(parts, all.total.cost, 'projects + none + unassigned');
    near(o.none.cost, costIn(all, [W1]), 'the "" bucket');
    near(o.totals.recentCost, recent.total.cost, '30-day total');
  });
  it('„nicht zugeordnet": by cost, ≤ 20, without "" / explicit / rule-labelled sessions — each with its suggestions', async () => {
    const o = await P.projectsOverview(null, deps());
    const ids = o.unassigned.top.map((r) => r.id);
    for (const gone of [M1, W1, AG1]) assert.ok(!ids.includes(gone), gone);
    for (const there of [M2, M3, AG2]) assert.ok(ids.includes(there), there + ' (C:\\Atlas2 is not under the rule)');
    const costs = o.unassigned.top.map((r) => r.cost);
    assert.deepEqual(costs, costs.slice().sort((a, b) => b - a), 'sorted by cost');
    assert.ok(o.unassigned.top.length <= P.OVERVIEW.unassigned);
    const s = (id) => o.unassigned.top.find((r) => r.id === id).suggest.map((x) => x.projectId + ':' + x.strength + ':' + x.reasons.map((r) => r.reason).join('+'));
    assert.deepEqual(s(M2), [PX.id + ':strong:plan'], 'the fork shares the plan of an explicitly assigned session');
    assert.deepEqual(s(M3), [PX.id + ':weak:jira'], 'the archived project with the same key is not offered');
    assert.deepEqual(s(AG2), []);
    // the tile badge counts what the page lists (here below the page's cap of 20)
    const page = await P.projectsOverview(PX.id, deps());
    assert.equal(o.projects.find((p) => p.id === PX.id).suggestCount, page.suggestions.length);
    assert.ok(page.suggestions.length >= 2);
  });
  it('?id= — that project only, its plans (file must exist, no agent plan), last state, suggestions', async () => {
    const o = await P.projectsOverview(PX.id, deps());
    assert.equal(o.status, 200);
    assert.deepEqual(o.projects.map((p) => p.id), [PX.id]);
    assert.equal(o.unassigned, undefined);
    assert.deepEqual(o.plans.map((p) => [p.name, p.title, p.sessionIds, p.derived]), [['mehr-plan.md', 'Demoprojekt-Plan', [M1], false]]);
    assert.equal(o.recent[0].id, M1);
    assert.deepEqual([o.recent[0].lastPrompt, o.recent[0].lastText, o.recent[0].lastTextAt], ['Stand Demoprojekt', 'Demoprojekt fertig', '2026-02-01T09:00:05.000Z']);
    const sg = o.suggestions.map((r) => r.id + ':' + r.strength);
    assert.equal(sg[0], M2 + ':strong', 'the plan suggestion leads');
    assert.ok(sg.includes(M3 + ':weak'), sg.join(' '));
    const strengths = o.suggestions.map((r) => r.strength);
    assert.deepEqual(strengths, strengths.slice().sort((a, b) => (a === b ? 0 : a === 'strong' ? -1 : 1)), 'strong first');
    assert.ok(!sg.some((x) => x.startsWith(M1) || x.startsWith(W1)), 'never for a decided session');
  });
  it('P1 cockpit actions: every row carries project / projectPath / projectId / plan (▶ Fortsetzen, Transkript, Plan)', async () => {
    const folder = (await scanSessions()).find((s) => s.id === M1).project;
    assert.ok(folder, 'premise: the session list names the CLI folder');
    const page = await P.projectsOverview(PX.id, deps());
    const r = page.recent.find((x) => x.id === M1);
    assert.deepEqual([r.project, r.projectPath, r.projectId, r.plan], [folder, MAIN, PX.id, 'mehr-plan.md'], '„Letzter Stand"');
    const top = page.projects[0].top.find((x) => x.id === M1);
    assert.deepEqual([top.project, top.projectId, top.plan], [folder, PX.id, 'mehr-plan.md'], 'the cost top 5');
    const sug = page.suggestions.find((x) => x.id === M3);
    assert.deepEqual([sug.project, sug.projectId, sug.plan], [folder, null, null], 'a suggestion: no entry, no plan');
    const all = await P.projectsOverview(null, deps());
    const free = all.unassigned.top.find((x) => x.id === M2);
    assert.deepEqual([free.project, free.projectId, free.plan], [folder, null, 'mehr-plan.md'], '„nicht zugeordnet" (the fork shares the plan)');
  });
  it('a rule-labelled project lists its plans as `derived`', async () => {
    append(ATLAS, AG1, [user(ATLAS, { uuid: 'g3', text: 'weiter', ts: '2026-02-03T10:00:00.000Z', extra: { slug: 'alpha-plan' } })]); // appended: the fold resumes
    const o = await P.projectsOverview(PA.id, deps());
    assert.deepEqual(o.plans.map((p) => [p.name, p.derived]), [['alpha-plan.md', true]]);
    assert.equal(o.recent[0].derived, true);
  });
  it('400 for a malformed id, 404 for an unknown one — nothing scanned for either', async () => {
    let scanned = 0;
    const counting = Object.assign(deps(), { scanSessions: async () => { scanned++; return []; } });
    assert.equal((await P.projectsOverview('nope', counting)).status, 400);
    assert.equal((await P.projectsOverview('__proto__', counting)).status, 400);
    assert.equal((await P.projectsOverview('p-deadbeef', counting)).status, 404);
    assert.equal(scanned, 0);
  });
  it('memoMs: a repeat is served without a scan — an assignment (store write) is seen at once', async () => {
    let scanned = 0;
    const counting = Object.assign(deps(), { memoMs: 60000, scanSessions: async () => { scanned++; return scanSessions(); } });
    const a = await P.projectsOverview(null, counting);
    const b = await P.projectsOverview(null, counting);
    assert.equal(scanned, 1, 'the second call is the memo');
    assert.equal(a, b);
    await P.assignSessions([M3], PX.id);
    const c = await P.projectsOverview(null, counting);
    assert.equal(scanned, 2, 'the store changed — a new key');
    assert.ok(!c.unassigned.top.some((r) => r.id === M3));
    await P.assignSessions([M3], null);
  });
  it('scanUsage opts.groupOf books every session BEFORE the cap; without it the response keeps its old shape', async () => {
    const plain = await scanUsage(null, null, 1);
    assert.equal(plain.byGroup, undefined);
    assert.equal(plain.bySession.length, 1);
    assert.ok(!('group' in plain.bySession[0]) && !('recentCost' in plain.bySession[0]));
    const g = await scanUsage(null, null, 1, { groupOf: () => 'all', recentFrom: '2026-01-12' });
    assert.equal(g.bySession.length, 1, 'the cap still applies to the list');
    near(g.byGroup[0].cost, g.total.cost, 'the group holds every session, not just the one listed');
    assert.equal(g.byGroup[0].sessions, g.total.sessions);
    const thrower = await scanUsage(null, null, 0, { groupOf: (id) => { if (id === M1) throw new Error('x'); return 'k'; } });
    assert.equal(thrower.bySession.find((s) => s.id === M1).group, null, 'a throwing callback books the session nowhere');
  });
  it('GET /api/sessions carries projectDerived and the v4 fields; listProjects counts the rule-labelled ones apart', async () => {
    const items = await P.decorateSessions(await scanSessions(), { mainCwd: async () => MAIN });
    const by = Object.fromEntries(items.map((s) => [s.id, s]));
    assert.deepEqual([by[AG1].projectId, by[AG1].projectDerived], [null, PA.id]);
    assert.deepEqual([by[W1].projectId, by[W1].projectDerived], ['', null], 'explicit "" wins over the Worktrees rule');
    assert.deepEqual([by[M1].projectId, by[M1].projectDerived], [PX.id, null]);
    assert.equal(by[AG2].projectDerived, null);
    assert.equal(by[M1].slug, 'mehr-plan');
    const list = await P.listProjects(await scanSessions(), { mainCwd: async () => MAIN });
    const a = list.find((p) => p.id === PA.id);
    assert.deepEqual([a.sessionCount, a.derivedCount], [0, 1]);
    assert.ok(PZ.archived);
  });

  // ---- P3: the window switch, the activity bars, the Usage view's „Panel-Projekt" filter ----
  it('P3 days: 7 and 30 give different windows and figures, 90 and „Gesamt" (0) all-time ones; anything else is a 400', async () => {
    const at = async (days, id) => P.projectsOverview(id || null, Object.assign(deps(), { days }));
    const blk = (o, pid) => o.projects.find((p) => p.id === pid);
    const o7 = await at(7), o30 = await at(30), o90 = await at(90), o0 = await at(0);
    assert.deepEqual(o7.window, { days: 7, from: '2026-02-04' });
    assert.deepEqual(o30.window, { days: 30, from: '2026-01-12' });
    assert.deepEqual(o0.window, { days: 0, from: null });
    // M1 (Demoprojekt) answered on 2025-12-15 and 2026-02-01: outside 7 days, inside 30 — the old route ignored ?days
    assert.equal(blk(o7, PX.id).recentCost, 0);
    assert.equal(blk(o7, PX.id).recentSessions, 0);
    assert.ok(blk(o30, PX.id).recentCost > 0 && blk(o30, PX.id).recentCost < blk(o30, PX.id).cost);
    assert.equal(blk(o30, PX.id).recentSessions, 1);
    near(blk(o90, PX.id).recentCost, blk(o90, PX.id).cost, '90 days hold both answers');
    near(blk(o0, PX.id).recentCost, blk(o0, PX.id).cost, '„Gesamt" = all-time');
    near(o0.totals.recentCost, o0.totals.cost, '„Gesamt" totals');
    assert.deepEqual([blk(o30, PA.id).recentSessions, blk(o30, PA.id).recentDerivedSessions], [1, 1], 'the rule-labelled one counts, and says so');
    for (const bad of [5, 365, -1, NaN, '30']) assert.equal((await at(bad)).status, 400, String(bad));
    assert.equal(P.overviewDays('5'), null);
    assert.equal(P.overviewDays(null), 30);
    assert.equal(P.overviewDays('0'), 0);
  });
  it('P3 activity: messages per local day, oldest first, ending today — the window\'s length, „Gesamt" the last 90', async () => {
    const p30 = await P.projectsOverview(PX.id, Object.assign(deps(), { days: 30 }));
    assert.equal(p30.activity.length, 30);
    assert.equal(p30.activityFrom, '2026-01-12');
    assert.ok(p30.activity[20] > 0, '2026-02-01 is 9 days before 2026-02-10: ' + JSON.stringify(p30.activity));
    assert.equal(p30.activity.filter((n) => n > 0).length, 1);
    const p0 = await P.projectsOverview(PX.id, Object.assign(deps(), { days: 0 }));
    assert.equal(p0.activity.length, 90);
    assert.ok(p0.activity[32] > 0 && p0.activity[80] > 0, 'both answering days are in the last 90');
    const all = await P.projectsOverview(null, deps());
    assert.equal(all.activity, undefined, 'the tiles\' overview carries no bars');
  });
  it('P3 usage filter: sessionFilter drops the others and leaves `range` alone; sessionGroupFn = the cockpit\'s buckets', async () => {
    const plain = await scanUsage(null, null, 0);
    const one = await scanUsage(null, null, 0, { sessionFilter: (id) => id === M1 });
    assert.deepEqual(one.bySession.map((s) => s.id), [M1]);
    assert.deepEqual(one.range, plain.range, 'the date picker must not move with the filter');
    near(one.total.cost, plain.bySession.find((s) => s.id === M1).cost, 'total = the one session');
    const thrower = await scanUsage(null, null, 0, { sessionFilter: () => { throw new Error('x'); } });
    assert.equal(thrower.bySession.length, 0, 'a throwing filter keeps nothing');
    const groupOf = await P.sessionGroupFn({ mainCwd: async () => MAIN });
    const ids = async (key) => (await scanUsage(null, null, 0, { sessionFilter: (id, cwd) => groupOf(id, cwd) === key })).bySession.map((s) => s.id).sort();
    const o = await P.projectsOverview(null, deps());
    assert.deepEqual(await ids(PX.id), [M1]);
    assert.deepEqual(await ids(PA.id), [AG1], 'the folder rule counts — as in the cockpit');
    assert.deepEqual(await ids(P.GROUP_NONE), [W1]);
    near((await scanUsage(null, null, 0, { sessionFilter: (id, cwd) => groupOf(id, cwd) === PA.id })).total.cost, o.projects.find((p) => p.id === PA.id).cost, 'Usage filter = cockpit cost');
    assert.equal(P.usageGroupKey('~free'), '~free');
    assert.equal(P.usageGroupKey('nope'), null);
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
describe('HTTP — the overview route (sandbox server)', () => {
  let child, port;
  before(async () => {
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
  it('200 with the estimate flag and both buckets; 400 / 404 for a bad id', async () => {
    const r = await get(port, '/api/projects/overview');
    assert.equal(r.status, 200);
    assert.equal(r.json.estimate, true);
    assert.equal(r.json.status, undefined, 'the internal status does not leak into the body');
    assert.ok(Array.isArray(r.json.projects) && r.json.unassigned && Array.isArray(r.json.unassigned.top));
    assert.equal((await get(port, '/api/projects/overview?id=bad')).status, 400);
    assert.equal((await get(port, '/api/projects/overview?id=p-deadbeef')).status, 404);
  });
  it('P3: ?days=7|30|90|0 answer with that window; ?days=5 is a 400; ?pproject= on /api/usage[.csv] is checked', async () => {
    for (const d of [7, 30, 90, 0]) {
      const r = await get(port, '/api/projects/overview?days=' + d);
      assert.equal(r.status, 200, 'days=' + d);
      assert.equal(r.json.window.days, d);
    }
    for (const d of ['5', 'abc', '-7']) assert.equal((await get(port, '/api/projects/overview?days=' + d)).status, 400, 'days=' + d);
    assert.equal((await get(port, '/api/usage?pproject=nope')).status, 400);
    assert.equal((await get(port, '/api/usage.csv?pproject=nope')).status, 400);
    const free = await get(port, '/api/usage?pproject=~free');
    assert.equal(free.status, 200);
    assert.ok(Array.isArray(free.json.bySession));
  });
});
