'use strict';
// Tests for lib/usage.js against the synthetic corpus in test/fixtures/ (no real ~/.claude).
// Covers the aggregation contract plus what WP-1 changed:
//   • unpriced accounting (F9): tokens on a model PRICING doesn't know are counted and named instead
//     of quietly vanishing from a cost total that looks complete
//   • authoritative projectPath (F2)
//   • resumable per-file parse (F6): an append must fold in, not double-count
// Seams must be set before lib/paths is required — node --test isolates each test file in its own process.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures', 'projects');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-usage-test-'));
fs.cpSync(FIXTURES, path.join(TMP, 'projects'), { recursive: true });
process.env.CLAUDE_UI_CLAUDE_DIR = TMP;
process.env.CLAUDE_UI_DATA_DIR = TMP;
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const { scanUsage, csvCell } = require('../lib/usage');
const SESS1 = path.join(TMP, 'projects', 'C--Users-dev-plain', '11111111-1111-4111-8111-111111111111.jsonl');

describe('lib/usage — scanUsage over the fixture corpus', () => {
  let u;
  before(async () => { u = await scanUsage(null, null, 100, {}); });

  it('totals every token bucket across all sessions', () => {
    assert.equal(u.total.input, 2110);   // 100 + 1000 + 1000 + 10
    assert.equal(u.total.output, 1055);  // 50 + 500 + 500 + 5
    assert.equal(u.total.cacheRead, 10);
    assert.equal(u.total.cacheWrite, 20);
    assert.equal(u.total.messages, 4);   // assistant messages carrying usage
    assert.equal(u.total.sessions, 3);
    assert.deepEqual(u.range, { min: '2026-01-05', max: '2026-01-07' });
    assert.equal(u.activeDays, 3);
  });

  it('counts UNPRICED tokens and names the models behind them (F9)', () => {
    // mystery-model-1 is not in PRICING: 2 messages × (1000 in + 500 out)
    assert.equal(u.unpricedTokens, 3000);
    assert.deepEqual(u.unpricedModels, ['mystery-model-1']);
    // and its cost contribution really is 0 — that's exactly why the token count must be reported
    const mystery = u.byModel.find((m) => m.model === 'mystery-model-1');
    assert.ok(mystery, 'the unknown model is missing from byModel');
    assert.equal(mystery.cost, 0);
    assert.ok(u.total.cost > 0, 'the priced sessions should still produce a cost estimate');
  });

  it('per-session and per-project rows carry the authoritative projectPath (F2)', () => {
    const hyph = u.bySession.find((s) => s.id.startsWith('22222222'));
    assert.equal(hyph.projectPath, 'C:\\Users\\dev\\my-project');
    const proj = u.byProject.find((p) => p.project === 'C--Users-dev-my-project');
    assert.equal(proj.projectPath, 'C:\\Users\\dev\\my-project');
    assert.equal(proj.sessions, 1);
  });

  it('the date filter narrows the totals to the requested window', async () => {
    const one = await scanUsage('2026-01-05', '2026-01-05', 100, {});
    assert.equal(one.total.input, 100);
    assert.equal(one.total.messages, 1);
    assert.equal(one.unpricedTokens, 0, 'the unpriced day is outside the window');
    assert.equal(one.range.max, '2026-01-07', 'range must ignore the filter (it feeds the date picker)');
  });

  it('the project filter keeps only that project', async () => {
    const only = await scanUsage(null, null, 100, { project: 'C--Users-dev-my-project' });
    assert.equal(only.total.sessions, 1);
    assert.equal(only.total.input, 10);
    assert.equal(only.bySession.length, 1);
  });

  it('resumable parse: an appended assistant message folds in exactly once (F6)', async () => {
    const before = await scanUsage(null, null, 100, {});
    fs.appendFileSync(SESS1, JSON.stringify({
      type: 'assistant', cwd: 'C:\\Users\\dev\\plain', timestamp: '2026-01-09T11:00:00.000Z',
      message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Nachtrag — Grüße äöü 😀' }], usage: { input_tokens: 7, output_tokens: 3 } },
    }) + '\n');
    const after = await scanUsage(null, null, 100, {});
    assert.equal(after.total.input, before.total.input + 7);
    assert.equal(after.total.output, before.total.output + 3);
    assert.equal(after.total.messages, before.total.messages + 1);
    assert.equal(after.range.max, '2026-01-09');
    const again = await scanUsage(null, null, 100, {}); // a second scan must be idempotent (cache hit)
    assert.equal(again.total.input, after.total.input, 'a cached re-scan changed the totals');
  });

  // KORR-1 on the shared fixture corpus. These three transcripts carry NO repeated message.id and no `id`
  // field at all, which is exactly why the assertions above are the regression guard for the dedup: it
  // must be a NO-OP on data that is not duplicated. Here the duplicate case is added on top — one answer
  // written as two lines, each carrying the FULL usage, which is what the live corpus does 52,571 times
  // for 25,015 answers and what made the panel show 2.15x the tokens.
  it('a duplicated message.id is counted ONCE, an id-less line every time (KORR-1)', async () => {
    const before = await scanUsage(null, null, 100, {});
    const dup = (out) => JSON.stringify({
      type: 'assistant', cwd: 'C:\\Users\\dev\\plain', timestamp: '2026-01-10T11:00:00.000Z',
      message: { id: 'msg_fixture_dup', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Teil' }], usage: { input_tokens: 40, output_tokens: out } },
    });
    fs.appendFileSync(SESS1, dup(1) + '\n' + dup(60) + '\n');
    const after = await scanUsage(null, null, 100, {});
    assert.equal(after.total.input, before.total.input + 40, 'the duplicate id was counted twice');
    assert.equal(after.total.output, before.total.output + 60, 'max-wins must keep the LARGER output');
    assert.equal(after.total.messages, before.total.messages + 1, 'two lines of one answer are one model call');
  });
});

describe('lib/usage — csvCell quoting', () => {
  it('quotes only when needed and doubles embedded quotes', () => {
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell(null), '');
  });
});
