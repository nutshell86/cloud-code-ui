'use strict';
// KORR-4 — subagent and workflow transcripts, attributed to the PARENT session.
//
// Measured on the live corpus: 69 <session>/subagents/agent-<hex>.jsonl + 85
// <session>/subagents/workflows/wf_<id>/agent-<hex>.jsonl carry usage in a shape byte-for-byte identical
// to a main transcript's, and the panel never opened a single one of them. Nothing is double-counted by
// adding them: all 10,045 isSidechain usage lines live in the agent files, 0 in the session files, and no
// message.id appears in both. The parent is the <sessionUuid> DIRECTORY name (verified 154/154) — not a
// field inside the file.
//
// The traps this suite pins are the ones that would silently ruin the numbers:
//   journal.jsonl              (0 usage; a **/*.jsonl glob would make it a ghost session)
//   <session>/workflows/*.json (totalTokens LOOKS like billing: 1,053,610 claimed vs 47,731,944 billed)
//   agent files becoming sessions of their own (297 live entries, 0 starting with `agent-`)
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('./corpus-fixture');

const C = F.mkCorpus('corpus-sub-test');
process.env.CLAUDE_UI_CLAUDE_DIR = C.claudeDir;
process.env.CLAUDE_UI_DATA_DIR = C.root;
process.on('exit', C.cleanup);

const PROJ = 'C--Users-dev-corp';
const PARENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';  // main + 1 subagent + 1 wf agent + journal + state
const WFONLY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';  // subagents/ holds ONLY workflows/ (session 93ebf8fa's shape)
const MISMATCH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; // the agent line's own sessionId disagrees
const EDGE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';     // zero-byte agent file + an empty subagents/
const WF = 'wf_12345678-abc';
const WF2 = 'wf_87654321-def';

// --- PARENT: 1,000 parent tokens, 300 subagent tokens, 700 workflow-agent tokens
F.writeLines(F.mainPath(C, PROJ, PARENT), [
  F.summary('Fixture: Elternsitzung'),
  F.user({ ts: '2026-03-01T09:00:00.000Z' }),
  F.asst({ id: 'msg_p1', ts: '2026-03-01T09:00:01.000Z', model: 'claude-opus-5', in: 1000, out: 0 }),
  // the parent's own PARTIAL claim about its subagent — 31 such lines live, 3-5x smaller than the agent
  // file's deduped total. Summing it alongside the agent files double-counts; it must be ignored.
  JSON.stringify({ type: 'user', timestamp: '2026-03-01T09:00:30.000Z', toolUseResult: { agentId: 'agent-f00d01', agentType: 'Explore', totalTokens: 90, usage: { input_tokens: 90, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
  // a `type:"result"` frame: keys are EXACTLY {type,key,agentId,result} — no usage, no cost
  JSON.stringify({ type: 'result', key: 'k1', agentId: 'agent-f00d01', result: { verdict: 'ok' } }),
]);
F.writeLines(F.agentPath(C, PROJ, PARENT, 'agent-f00d01'), [
  F.asst({ id: 'msg_a1', ts: '2026-03-01T09:00:10.000Z', model: 'claude-opus-5-5', in: 1, out: 1, sidechain: true, sessionId: PARENT, agentId: 'agent-f00d01' }),
  F.asst({ id: 'msg_a1', ts: '2026-03-01T09:00:11.000Z', model: 'claude-opus-5-5', in: 100, out: 200, sidechain: true, sessionId: PARENT, agentId: 'agent-f00d01' }),
]);
fs.writeFileSync(path.join(path.dirname(F.agentPath(C, PROJ, PARENT, 'agent-f00d01')), 'agent-f00d01.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'struktur', spawnDepth: 1 }));
F.writeLines(F.wfAgentPath(C, PROJ, PARENT, WF, 'agent-f00d02'), [
  F.asst({ id: 'msg_w1', ts: '2026-03-01T09:01:00.000Z', model: 'claude-opus-5-5', in: 300, out: 400, sidechain: true, sessionId: PARENT, agentId: 'agent-f00d02' }),
]);
// journal.jsonl: launched / started / result — ZERO usage, and `result` is the agent's returned CONTENT
F.writeLines(F.journalPath(C, PROJ, PARENT, WF), [
  JSON.stringify({ type: 'launched' }),
  JSON.stringify({ type: 'started', agentId: 'agent-f00d02', key: 'messen', label: 'Messen', phase: 'Messen' }),
  JSON.stringify({ type: 'result', agentId: 'agent-f00d02', key: 'messen', result: { findings: [] } }),
]);
// <session>/workflows/wf_<id>.json — a CONTEXT gauge, off by ~45x from what was actually billed
fs.mkdirSync(path.dirname(F.wfStatePath(C, PROJ, PARENT, WF)), { recursive: true });
fs.writeFileSync(F.wfStatePath(C, PROJ, PARENT, WF), JSON.stringify({ runId: WF, agentCount: 1, totalTokens: 999999999, workflowProgress: [{ tokens: 999999999 }] }));

// --- WFONLY: subagents/ with no direct agent file, and a wf dir WITHOUT a state file (3 of 13 live)
F.writeLines(F.mainPath(C, PROJ, WFONLY), [F.asst({ id: 'msg_q1', ts: '2026-03-01T10:00:00.000Z', in: 50, out: 0 })]);
F.writeLines(F.wfAgentPath(C, PROJ, WFONLY, WF2, 'agent-beef01'), [F.asst({ id: 'msg_w2', ts: '2026-03-01T10:00:10.000Z', in: 25, out: 0, sidechain: true })]);

// --- MISMATCH: folded anyway, because a mismatch means a CLI change you want to SEE, not a file to drop
F.writeLines(F.mainPath(C, PROJ, MISMATCH), [F.asst({ id: 'msg_m1', ts: '2026-03-01T11:00:00.000Z', in: 10, out: 0 })]);
F.writeLines(F.agentPath(C, PROJ, MISMATCH, 'agent-c0ffee'), [F.asst({ id: 'msg_m2', ts: '2026-03-01T11:00:10.000Z', in: 5, out: 0, sidechain: true, sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })]);

// --- EDGE: a zero-byte agent file and a literally empty subagents/ dir (neither occurs live)
F.writeLines(F.mainPath(C, PROJ, EDGE), [F.asst({ id: 'msg_e1', ts: '2026-03-01T12:00:00.000Z', in: 1, out: 0 })]);
fs.mkdirSync(path.dirname(F.agentPath(C, PROJ, EDGE, 'x')), { recursive: true });
fs.writeFileSync(F.agentPath(C, PROJ, EDGE, 'agent-000000'), '');

const { scanCorpus, listCorpus } = require('../lib/corpus');
const { scanUsage } = require('../lib/usage');
const { scanSessions, readTranscript } = require('../lib/sessions');

describe('lib/corpus — subagent & workflow attribution (KORR-4)', () => {
  let usage, sessions, corpus;
  before(async () => { corpus = await scanCorpus(); usage = await scanUsage(null, null, 0, {}); sessions = await scanSessions(); });

  it('T9/T10 subagent AND workflow-agent tokens land on the PARENT session, from the directory name', () => {
    const s = usage.bySession.find((x) => x.id === PARENT);
    assert.equal(s.input, 1400, 'parent 1000 + subagent 100 + workflow agent 300');
    assert.equal(s.output, 600, 'subagent 200 + workflow agent 400');
    assert.equal(s.messages, 3);
    assert.equal(s.agentFiles, 2);
    assert.equal(s.subTokens, 1000, '100+200 subagent + 300+400 workflow');
    assert.equal(s.subMessages, 2);
    assert.ok(s.subCost > 0, 'opus-5-5 must be priced — it is 60 % of all live agent tokens');
  });

  it('the parent\'s own toolUseResult.usage claim is NOT summed on top (it is a partial snapshot)', () => {
    const s = usage.bySession.find((x) => x.id === PARENT);
    assert.equal(s.input, 1400, 'the 90-token toolUseResult claim leaked into the total');
  });

  it('T11 journal.jsonl is ignored — no ghost session, no tokens', async () => {
    const { files } = await listCorpus();
    assert.ok(!files.some((f) => /journal\.jsonl$/.test(f.full)), 'journal.jsonl reached the fold');
    assert.ok(!usage.bySession.some((s) => /journal/.test(s.id)));
  });

  it('T12 <session>/workflows/wf_<id>.json totalTokens is never summed', () => {
    const s = usage.bySession.find((x) => x.id === PARENT);
    assert.ok(s.tokens < 999999, 'the workflow state file\'s context gauge was read as a billing number');
  });

  it('T13 scanSessions still lists exactly the main transcripts — no `agent-` entries', () => {
    assert.equal(sessions.length, 4, 'one entry per main transcript, never one per agent file');
    assert.equal(sessions.filter((s) => s.id.startsWith('agent-')).length, 0);
    assert.deepEqual(sessions.map((s) => s.id).sort(), [PARENT, WFONLY, MISMATCH, EDGE].sort());
    // and the list's own message count stays the TRANSCRIPT's (the tile reports the agents separately)
    assert.equal(sessions.find((s) => s.id === PARENT).messages, 3, 'user + assistant + the toolUseResult user line');
  });

  it('T14 an agent file whose own sessionId disagrees with its directory is folded anyway', () => {
    const s = usage.bySession.find((x) => x.id === MISMATCH);
    assert.equal(s.input, 15, 'the path is the primary attribution source; a mismatch is a signal, not a drop');
    assert.ok(!usage.bySession.some((x) => x.id === 'ffffffff-ffff-4fff-8fff-ffffffffffff'), 'the claimed foreign session must not appear');
  });

  it('T15/T16 a wf dir without a state file, and a subagents/ holding only workflows/', () => {
    const s = usage.bySession.find((x) => x.id === WFONLY);
    assert.equal(s.input, 75, '50 parent + 25 workflow agent');
    assert.equal(s.agentFiles, 1);
  });

  it('T17 a zero-byte agent file and an empty subagents/ are harmless', () => {
    const s = usage.bySession.find((x) => x.id === EDGE);
    assert.equal(s.input, 1);
    assert.equal(s.agentFiles, 1, 'the empty file is still a known agent file, it just contributes nothing');
    assert.equal(s.subTokens, 0);
  });

  it('the transcript tile reads the SAME fold as the usage page, and names the split', async () => {
    const r = await readTranscript(PROJ, PARENT, { tail: 0 });
    const s = usage.bySession.find((x) => x.id === PARENT);
    assert.equal(r.meta.tokens, s.tokens, 'the detail tile and the Usage page must be one fold, not two');
    assert.equal(r.meta.cost, s.cost);
    assert.equal(r.meta.subTokens, 1000);
    assert.equal(r.meta.agentFiles, 2);
    assert.equal(r.meta.agents.length, 2);
    assert.equal(r.meta.agents[0].agentId, 'agent-f00d02', 'agents are listed biggest first');
    assert.equal(r.meta.agents[0].wf, WF);
    assert.equal(r.meta.userTurns, 1, 'the toolUseResult user line is not a turn you typed');
  });

  it('agent recs exist as records but never as sessions of their own', () => {
    assert.equal(corpus.recs.filter((r) => r.kind === 'subagent').length, 3);
    assert.equal(corpus.recs.filter((r) => r.kind === 'workflow').length, 2);
    assert.equal(corpus.bySession.size, 4, 'an agent file must join its parent group, not open a new one');
  });
});
