'use strict';
// lib/corpus.js — the dedup rule and the fold's error accounting.
//
// Every assertion here corresponds to something MEASURED on the live 586 MB corpus (2026-10-02). The rule
// is: per FILE, per message.id, the line with the largest input+output+cache_read+cache_creation wins, and
// only the INCREMENT is folded, so the fold stays additive and resumable. The CLI's own `cost-state`
// frames settle that this is right: on 146 of 150 transcripts that carry one, the CLI's summed
// outputTokens equals the deduped total EXACTLY, while counting every line matches 1 of 150 and is 2.11x
// high.
//
// Seams must be set before lib/paths is required — node --test isolates every test file in its own process.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('./corpus-fixture');

const C = F.mkCorpus('corpus-test');
process.env.CLAUDE_UI_CLAUDE_DIR = C.claudeDir;
process.env.CLAUDE_UI_DATA_DIR = C.root;
process.on('exit', C.cleanup);

const PROJ = 'C--Users-dev-corp';
const S_GROW = '11111111-1111-4111-8111-111111111111';
const S_ORDER = '22222222-2222-4222-8222-222222222222';
const S_ZERO = '33333333-3333-4333-8333-333333333333';
const S_NOID = '44444444-4444-4444-8444-444444444444';
const S_EPH = '55555555-5555-4555-8555-555555555555';
const S_DUP2 = '66666666-6666-4666-8666-666666666666';
const S_SYNTH = '77777777-7777-4777-8777-777777777777';
const S_BAD = '88888888-8888-4888-8888-888888888888';

// T1 — one answer written as three lines, each carrying the FULL usage, output growing (the shape of a
// streaming subagent answer: >100x growth between the first and the last line in 1,695 live groups).
F.writeLines(F.mainPath(C, PROJ, S_GROW), [
  F.user({ ts: '2026-02-02T09:00:00.000Z' }),
  F.asst({ id: 'msg_grow', ts: '2026-02-02T09:00:01.000Z', in: 100, out: 1, cr: 1000, cw: 0 }),
  F.asst({ id: 'msg_grow', ts: '2026-02-02T09:00:02.000Z', in: 100, out: 40, cr: 1000, cw: 0 }),
  F.asst({ id: 'msg_grow', ts: '2026-02-02T09:00:03.000Z', in: 100, out: 900, cr: 1000, cw: 0 }),
]);
// T2 — the SAME group with the lines in non-monotonic timestamp order. 390 live groups look like this,
// which is why neither file order nor timestamp order may decide the winner.
F.writeLines(F.mainPath(C, PROJ, S_ORDER), [
  F.asst({ id: 'msg_ord', ts: '2026-02-02T09:00:03.000Z', in: 100, out: 900, cr: 1000, cw: 0 }),
  F.asst({ id: 'msg_ord', ts: '2026-02-02T09:00:01.000Z', in: 100, out: 1, cr: 1000, cw: 0 }),
  F.asst({ id: 'msg_ord', ts: '2026-02-02T09:00:02.000Z', in: 100, out: 40, cr: 1000, cw: 0 }),
]);
// T3 — the 2 live groups that SHRINK: real lines, then trailing lines with every token field 0.
// "last wins" would zero out a real answer here.
F.writeLines(F.mainPath(C, PROJ, S_ZERO), [
  F.asst({ id: 'msg_zero', ts: '2026-02-02T09:00:01.000Z', in: 10, out: 1786, cr: 864404, cw: 0 }),
  F.asst({ id: 'msg_zero', ts: '2026-02-02T09:00:02.000Z', in: 0, out: 0, cr: 0, cw: 0 }),
  F.asst({ id: 'msg_zero', ts: '2026-02-02T09:00:03.000Z', in: 0, out: 0, cr: 0, cw: 0 }),
]);
// T4 — usage lines with NO message.id. Zero of those exist in the live corpus, but the branch is
// load-bearing: the assistant lines in test/fixtures/projects carry no `id` at all, so without it the
// existing suite's own totals break before a single new test runs.
F.writeLines(F.mainPath(C, PROJ, S_NOID), [
  F.asst({ ts: '2026-02-02T09:00:01.000Z', in: 7, out: 3 }),
  F.asst({ ts: '2026-02-02T09:00:02.000Z', in: 7, out: 3 }),
]);
// T5 — a 1h ephemeral cache write. 307.7 M of 588.5 M live cache-write tokens are 1h, billed at 2x the
// input rate; a dedup record that drops the split silently reprices them at the flat 1.25x (-7.0 %).
F.writeLines(F.mainPath(C, PROJ, S_EPH), [
  F.asst({ id: 'msg_eph', ts: '2026-02-02T09:00:01.000Z', model: 'claude-opus-5', in: 0, out: 0, cr: 0, e5: 0, e1: 1000000 }),
]);
// T6 — the same message.id in TWO files. Per-file scope is the documented rule (0 of 25,015 live ids
// appear in two files, and per file is the only scope a per-file cache can express).
F.writeLines(F.mainPath(C, PROJ, S_DUP2), [F.asst({ id: 'msg_shared', ts: '2026-02-02T09:00:01.000Z', in: 500, out: 5 })]);
F.writeLines(F.agentPath(C, PROJ, S_DUP2, 'agent-aaa111'), [F.asst({ id: 'msg_shared', ts: '2026-02-02T09:00:02.000Z', in: 500, out: 5, sidechain: true })]);
// T7 — the pseudo-model '<synthetic>': 63 live lines, every token field 0.
F.writeLines(F.mainPath(C, PROJ, S_SYNTH), [
  F.asst({ id: 'msg_s1', ts: '2026-02-02T09:00:01.000Z', model: 'claude-opus-5', in: 1000, out: 100 }),
  F.asst({ id: 'msg_s2', ts: '2026-02-02T09:00:02.000Z', model: '<synthetic>', in: 0, out: 0 }),
]);
// T8 — a line that is not JSON at all.
F.writeLines(F.mainPath(C, PROJ, S_BAD), [
  F.asst({ id: 'msg_ok', ts: '2026-02-02T09:00:01.000Z', in: 5, out: 5 }),
  '{ this is not json',
]);

const { scanCorpus, foldFile, blankRec, listCorpus } = require('../lib/corpus');
const { scanUsage } = require('../lib/usage');

const recOf = (corpus, session, kind) => corpus.recs.find((r) => r.session === session && r.kind === (kind || 'main'));
const tokensOf = (rec) => { let t = [0, 0, 0, 0, 0]; for (const d in rec.d) for (const m in rec.d[d].m) { const b = rec.d[d].m[m]; t = [t[0] + b[0], t[1] + b[1], t[2] + b[2], t[3] + b[3], t[4] + b[6]]; } return { input: t[0], output: t[1], cacheRead: t[2], cacheWrite: t[3], messages: t[4] }; };

describe('lib/corpus — dedup (KORR-1), max-wins per message.id per file', () => {
  let corpus, usage;
  before(async () => { corpus = await scanCorpus(); usage = await scanUsage(null, null, 0, {}); });

  it('T8 FIRST: the fold reports its own errors instead of letting core.foldLines swallow them', async () => {
    // lib/core.js foldLines wraps the callback in `try {} catch {}` ("a bad line must not kill the
    // scan"), so a defect in the fold is INVISIBLE and reports a plausible 0 — one measurement run did
    // exactly that. A malformed LINE is counted as a parse error…
    const bad = recOf(corpus, S_BAD);
    assert.equal(bad.parseErrors, 1, 'the malformed line was not counted');
    assert.equal(bad.foldErrors, 0);
    assert.equal(tokensOf(bad).messages, 1, 'one bad line must not cost the good one');
    // …and a THROWING callback is noticed rather than vanishing.
    const rec = blankRec({ full: F.mainPath(C, PROJ, S_GROW), kind: 'main', project: PROJ, session: S_GROW });
    await foldFile(rec.full, 0, rec, { onLine: () => { throw new TypeError('deliberate'); } });
    assert.equal(rec.foldErrors, 4, 'a throwing fold callback was swallowed — the exact bug this counter exists for');
    assert.match(rec.foldError, /deliberate/);
    assert.equal(tokensOf(rec).messages, 0, 'a throwing callback must not produce half-folded numbers');
    // and the corpus-wide counters stay clean for everything else
    assert.equal(corpus.stats.foldErrors, 0, 'unexpected fold error: ' + corpus.stats.foldError);
  });

  it('T1 a growing duplicate group counts the FINAL maxima exactly once', () => {
    const t = tokensOf(recOf(corpus, S_GROW));
    assert.deepEqual(t, { input: 100, output: 900, cacheRead: 1000, cacheWrite: 0, messages: 1 });
    // what the old per-line counting produced, for the record: 300 / 941 / 3000 / 3 messages
  });

  it('T2 non-monotonic timestamps give the SAME answer (order independence)', () => {
    assert.deepEqual(tokensOf(recOf(corpus, S_ORDER)), tokensOf(recOf(corpus, S_GROW)));
  });

  it('T3 a group whose trailing lines are all-zero keeps the real answer', () => {
    const t = tokensOf(recOf(corpus, S_ZERO));
    assert.deepEqual(t, { input: 10, output: 1786, cacheRead: 864404, cacheWrite: 0, messages: 1 });
  });

  it('T4 a usage line without message.id counts exactly once — every time', () => {
    const t = tokensOf(recOf(corpus, S_NOID));
    assert.deepEqual(t, { input: 14, output: 6, cacheRead: 0, cacheWrite: 0, messages: 2 }, 'id-less lines must not collapse into each other');
  });

  it('T5 the winning line\'s whole usage reaches costParts: a 1h write bills at 2x, not at the flat 1.25x', () => {
    const s = usage.bySession.find((x) => x.id === S_EPH);
    // 1,000,000 cache-write tokens at Opus rates ($5/1M in): 1h = $10.00, 5m = $6.25, flat = $6.25.
    assert.equal(Number(s.cost.toFixed(4)), 10, 'the ephemeral split was lost — this is the -7.0 % trap');
    assert.equal(s.cacheWrite, 1000000);
  });

  it('T6 per-FILE scope: the same message.id in two files counts twice', () => {
    const s = usage.bySession.find((x) => x.id === S_DUP2);
    assert.equal(s.input, 1000, 'per-file dedup is the documented scope (0 live ids span two files)');
    assert.equal(s.messages, 2);
  });

  it('T7 <synthetic> is skipped as a label and is NOT reported as an unpriced model', () => {
    const s = usage.bySession.find((x) => x.id === S_SYNTH);
    assert.equal(s.model, 'claude-opus-5', 'a synthetic frame must never become the session label');
    assert.ok(!usage.unpricedModels.includes('<synthetic>'), 'noise in the unpriced footnote hides the real gap');
  });

  it('the walk emits exactly the three transcript kinds, by name and not by glob', async () => {
    const { files } = await listCorpus();
    assert.equal(files.filter((f) => f.kind === 'main').length, 8);
    assert.equal(files.filter((f) => f.kind === 'subagent').length, 1);
    assert.equal(files.filter((f) => f.kind === 'workflow').length, 0);
  });
});

describe('lib/corpus — the ground truth the CLI writes itself (cost-state)', () => {
  // The CLI appends `{"type":"cost-state", totalCostUSD, modelUsage{…}}` to 150 of the 464 live
  // transcripts. This is the regression oracle the whole PR rests on: it is the CLI's own number, so it
  // settles the dedup rule without a judgement call. Here the same frame is reproduced in a fixture
  // (structure only) so the assertion also runs in the fast suite; test/usage-oracle.test.js runs it
  // against the live corpus behind CCUI_ORACLE=1.
  const SESS = '99999999-9999-4999-8999-999999999999';
  before(() => {
    // 3 lines, one answer, output streaming up — plus the CLI's own verdict on it.
    F.writeLines(F.mainPath(C, PROJ, SESS), [
      F.asst({ id: 'msg_a', ts: '2026-02-03T09:00:01.000Z', model: 'claude-sonnet-5', in: 10, out: 5, cr: 2000, e5: 400, e1: 0 }),
      F.asst({ id: 'msg_a', ts: '2026-02-03T09:00:02.000Z', model: 'claude-sonnet-5', in: 10, out: 1200, cr: 2000, e5: 400, e1: 0 }),
      F.asst({ id: 'msg_b', ts: '2026-02-03T09:00:05.000Z', model: 'claude-sonnet-5', in: 20, out: 300, cr: 5000, e5: 0, e1: 1000 }),
      F.costState({
        sessionId: SESS, ts: '2026-02-03T09:00:00.000Z',
        // deduped: in 30 · out 1500 · cacheRead 7000 · 5m 400 · 1h 1000, at Sonnet 5 = $2/$10 per 1M
        totalCostUSD: (30 * 2 + 1500 * 10 + 7000 * 2 * 0.1 + 400 * 2 * 1.25 + 1000 * 2 * 2) / 1e6,
        modelUsage: { 'eu.anthropic.claude-sonnet-5': { inputTokens: 30, outputTokens: 1500, thinkingTokens: 700, cacheReadInputTokens: 7000, cacheCreationInputTokens: 1400, webSearchRequests: 0, costUSD: 0 } },
      }),
    ]);
  });

  it('the folded tokens and cost match the CLI\'s own cost-state line', async () => {
    const u = await scanUsage(null, null, 0, {});
    const s = u.bySession.find((x) => x.id === SESS);
    const cs = JSON.parse(fs.readFileSync(F.mainPath(C, PROJ, SESS), 'utf8').trim().split('\n').filter((l) => /"cost-state"/.test(l)).pop());
    const cliOut = Object.values(cs.modelUsage).reduce((a, m) => a + m.outputTokens, 0);
    assert.equal(s.output, cliOut, 'deduped output must equal the CLI\'s own outputTokens (146/150 live files agree EXACTLY)');
    assert.ok(Math.abs(s.cost - cs.totalCostUSD) < 1e-9, 'cost ' + s.cost + ' vs CLI ' + cs.totalCostUSD);
    // thinkingTokens is a SUBSET of outputTokens — adding it would double-count
    assert.ok(cliOut < Object.values(cs.modelUsage).reduce((a, m) => a + m.outputTokens + m.thinkingTokens, 0));
  });

  after(() => { try { fs.rmSync(F.mainPath(C, PROJ, SESS)); } catch { /* */ } });
});

// M2 — the punchcard and the model filter. The hour/weekday block used to run OUTSIDE the per-model loop
// over a DAY-level histogram, gated only by „did this day use the filtered model at all": with a filter
// active the punchcard then showed the other models' hours as if they were the filtered model's. The hour
// histogram is now per (day × model), and this is the test that says so.
//
// Both timestamps are built through the Date API, so they are two different LOCAL hours of ONE local day
// in whatever timezone this machine runs in — and the scan is asked for exactly that day, so the other
// fixture sessions cannot contribute an hour.
describe('lib/usage — the punchcard obeys the model filter (M2)', () => {
  const SESS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const OPUS = 'claude-opus-5', SONNET = 'claude-sonnet-5';
  const T_OPUS = new Date(2026, 1, 4, 9, 0, 0);    // local 2026-02-04 09:00
  const T_SONNET = new Date(2026, 1, 4, 14, 0, 0); // local 2026-02-04 14:00 — same day, other hour
  const { dayKey, weekdayOf } = require('../lib/corpus');
  const DAY = dayKey(T_OPUS), WD = weekdayOf(DAY);
  const H_OPUS = T_OPUS.getHours(), H_SONNET = T_SONNET.getHours();

  before(() => {
    F.writeLines(F.mainPath(C, PROJ, SESS), [
      F.asst({ id: 'msg_hour_o', ts: T_OPUS.toISOString(), model: OPUS, in: 1000, out: 100 }),
      F.asst({ id: 'msg_hour_s', ts: T_SONNET.toISOString(), model: SONNET, in: 7000, out: 700 }),
    ]);
  });
  after(() => { try { fs.rmSync(F.mainPath(C, PROJ, SESS)); } catch { /* */ } });

  it('with no filter both models\' hours are in the picture', async () => {
    const u = await scanUsage(DAY, DAY, 0, {});
    assert.equal(u.byHour[H_OPUS], 1100);
    assert.equal(u.byHour[H_SONNET], 7700);
    assert.equal(u.byWeekday[WD], 8800);
    assert.equal(u.punch[WD][H_SONNET], 7700);
  });

  it('with a model filter the OTHER model\'s hours disappear from byHour, byWeekday and the punchcard', async () => {
    const u = await scanUsage(DAY, DAY, 0, { model: OPUS });
    assert.equal(u.total.input, 1000, 'the filter must keep only the filtered model\'s tokens');
    assert.equal(u.byHour[H_OPUS], 1100);
    assert.equal(u.byHour[H_SONNET], 0, 'the punchcard showed the OTHER model\'s hour — the day-level histogram leaked');
    assert.equal(u.punch[WD][H_SONNET], 0, 'same leak in the weekday × hour grid');
    assert.equal(u.byWeekday[WD], 1100, 'the weekday axis counted the whole day instead of the filtered model');
    // the counter-test: filtering on the OTHER model must move the hour, not just shrink it
    const v = await scanUsage(DAY, DAY, 0, { model: SONNET });
    assert.equal(v.byHour[H_OPUS], 0);
    assert.equal(v.byHour[H_SONNET], 7700);
  });
});
