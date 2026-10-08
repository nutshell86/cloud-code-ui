'use strict';
// U1 / PR-12 — the workflow rail. THREE layers are under test here, on purpose:
//   1. the pure decisions (public/js/workflow-lanes.js),
//   2. the row builder that paints them (chat-render.js workflowRows, lifted out of the source),
//   3. the RAIL that is supposed to show them (chat-side.js chatSideRefresh, also lifted).
// Layer 3 exists because of this project's recurring failure: four times the logic was right and green and
// the drawer above it swallowed the result. The signature guard in chatSideRefresh is exactly such a
// drawer — a workflow's fan-out changes while the LANE's own fields stand still, so without wfSig in that
// signature the group would be painted once and never again.
//
// THE FIXTURES ARE NOT INVENTED. They are the recorded `workflow_progress` arrays of real runs:
//  · PROBE_* — the two paid recordings of 2026-10-02 (C:\Users\you\ccui-probe\runs\paid-…), the ones
//    docs/messung-2026-10-02.md is about. Four `probe:aN` agents in one phase „Probe".
//  · RETRY  — wf_9343cde5-158: an agent whose label is literally „schliessen:ctx7 (retry 1)" with
//    `attempt: 2` and `lastAttemptReason: 'stalled'`. The only retry in 38 runs.
//  · MULTI  — wf_56728092-72a: three phases, eight agents, `agentType` Explore/Plan.
//  · PROGRESS_REAL — claude-scratch/uc-workflow.jsonl (2026-10-01, 226 frames). THE THIRD SOURCE, and it
//    is in here because it is the only one that contains the state word `progress`.
// Counted over the 38 `<session>/workflows/wf_*.json` state files on this machine (2026-10-03): 175
// workflow_agent entries, 86 workflow_phase entries, `state` is 'done' in 175 of 175, `index` unique
// within a run in 38 of 38, and `cached: true` holds for exactly the 9 entries that have no `durationMs`.
// In the 2026-10-01 recording: `start` 6× · `progress` 19× · `done` 5×, and 21 of its 32 task_progress
// frames carry NO `workflow_progress` at all.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  wfIsWorkflow, wfApplyLaunch, wfApplyProgress, wfSystemEvent, wfAgentState, wfAgentElapsedMs,
  wfAgentView, wfView, wfSig, WF_STATES_RUNNING, WF_STATE_DONE,
} = require('../public/js/workflow-lanes');
const { laneToolResult, laneStart, laneFinish, laneFind } = require('../public/js/agent-lanes');
const { eventPump, frames } = require('./event-pump');

const TUID = 'toolu_bdrk_01TiQB5YKmBgnhxbXLydWw8p';   // the Workflow tool_use of the first paid run
const TASK = 'wze3xxa0b';                              // its task_id — ONE for the whole fan-out
// the launch receipt, verbatim (8 keys; 49 of the 51 Workflow calls in the corpus answer exactly this shape)
const RECEIPT = {
  status: 'async_launched', taskId: TASK, taskType: 'local_workflow', workflowName: 'ccui-probe',
  runId: 'wf_ed88bba6-7e5', summary: 'Protokollsonde: vier triviale Agenten, keine Werkzeuge',
  transcriptDir: 'C:\\Users\\you\\.claude\\projects\\C--Users-you-ccui-probe-runs-paid-2026-10-02T19-55-29-267Z-sandbox\\7d5b9cb0-77a4-462a-a11d-c405713cc9f3\\subagents\\workflows\\wf_ed88bba6-7e5',
  scriptPath: 'C:\\Users\\you\\ccui-probe\\runs\\paid-2026-10-02T19-55-29-267Z\\sandbox\\probe-wf.js',
};
const PHASE1 = { type: 'workflow_phase', index: 1, title: 'Probe' };
// _seq 44: the very first progress frame of the paid run — the phase only, no agent yet
const PROBE_FIRST = [PHASE1];
// _seq 45: a1 has an agentId and a resolved model, a2/a3/a4 are queued with the REQUESTED model ("haiku")
const PROBE_START = [PHASE1,
  { type: 'workflow_agent', index: 1, label: 'probe:a1', phaseIndex: 1, phaseTitle: 'Probe', agentId: 'a7541d8eeb48f116d', model: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0', state: 'start', startedAt: 1790970949201, queuedAt: 1790970949194, attempt: 1, promptPreview: 'Antworte mit genau diesem Text …', promptFramed: true, lastProgressAt: 1790970949207 },
  { type: 'workflow_agent', index: 2, label: 'probe:a2', phaseIndex: 1, phaseTitle: 'Probe', model: 'haiku', state: 'start', queuedAt: 1790970949195, promptPreview: 'Antworte mit genau diesem Text …', lastProgressAt: 1790970949195 },
];
// _seq 46: a1 is through, and the runtime's own `durationMs`/`tokens`/`resultPreview` arrive with it
const PROBE_A1_DONE = [PHASE1,
  { type: 'workflow_agent', index: 1, label: 'probe:a1', phaseIndex: 1, phaseTitle: 'Probe', agentId: 'a7541d8eeb48f116d', model: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0', state: 'done', startedAt: 1790970949201, queuedAt: 1790970949194, attempt: 1, lastProgressAt: 1790970950487, tokens: 8539, toolCalls: 0, durationMs: 1280, resultPreview: 'PROBE-a1-OK' },
  { type: 'workflow_agent', index: 2, label: 'probe:a2', phaseIndex: 1, phaseTitle: 'Probe', agentId: 'ac971068dba61ea34', model: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0', state: 'start', startedAt: 1790970949205, queuedAt: 1790970949195, attempt: 1, lastProgressAt: 1790970949967 },
];
const RETRY = [
  { type: 'workflow_phase', index: 1, title: 'Schliessen' },
  { type: 'workflow_phase', index: 2, title: 'Pruefen' },
  { type: 'workflow_agent', index: 1, label: 'schliessen:ctx7 (retry 1)', phaseIndex: 1, phaseTitle: 'Schliessen', agentId: 'a807328c1426b2002', model: 'eu.anthropic.claude-opus-5[1m]', state: 'done', startedAt: 1790959859476, queuedAt: 1790959859392, attempt: 2, lastAttemptReason: 'stalled', lastToolName: 'StructuredOutput', lastProgressAt: 1790959999999, durationMs: 140523, tokens: 100, toolCalls: 3, resultPreview: 'SHARED STORE …' },
  { type: 'workflow_agent', index: 2, label: 'pruefen:ctx7', phaseIndex: 2, phaseTitle: 'Pruefen', agentId: 'a5859613c341ff4dd', model: 'eu.anthropic.claude-opus-5[1m]', state: 'done', startedAt: 1790963114693, queuedAt: 1790963114600, attempt: 1, lastProgressAt: 1790963200000, durationMs: 85307, resultPreview: 'NO for the reported sentence …' },
];
const MULTI = [
  { type: 'workflow_phase', index: 1, title: 'Verstehen' },
  { type: 'workflow_phase', index: 2, title: 'Entwerfen' },
  { type: 'workflow_phase', index: 3, title: 'Synthese' },
  { type: 'workflow_agent', index: 1, label: 'explore:sitzungen-start', phaseIndex: 1, phaseTitle: 'Verstehen', agentId: 'ae1930c389c439e81', agentType: 'Explore', model: 'eu.anthropic.claude-opus-5-5[1m]', state: 'done', startedAt: 1791038091976, attempt: 1, lastProgressAt: 1791038200000, durationMs: 108024 },
  { type: 'workflow_agent', index: 4, label: 'design:projekte-kontextbuendel', phaseIndex: 2, phaseTitle: 'Entwerfen', agentId: 'a14e9be208fc630da', agentType: 'Plan', model: 'eu.anthropic.claude-opus-5-5[1m]', state: 'done', startedAt: 1791039167375, attempt: 1, lastProgressAt: 1791039267375, durationMs: 100000 },
  { type: 'workflow_agent', index: 8, label: 'synthese', phaseIndex: 3, phaseTitle: 'Synthese', agentId: 'a17d1d36cdeb459d1', agentType: 'Plan', model: 'eu.anthropic.claude-opus-5-5[1m]', state: 'start', startedAt: 1791040074610, attempt: 1, lastProgressAt: 1791040074660 },
];
// Verbatim from claude-scratch/uc-workflow.jsonl (2026-10-01, 226 frames, task_id w5x8u4tgb): the only
// source on this machine that contains the THIRD state word `progress` — see the test that uses it.
const PROGRESS_REAL = [
  { type: 'workflow_phase', index: 1, title: 'Review' },
  { type: 'workflow_phase', index: 2, title: 'Verify' },
  { type: 'workflow_agent', index: 1, label: 'review:history', phaseIndex: 1, phaseTitle: 'Review', agentId: 'a393581ac1c0eba94', model: 'eu.anthropic.claude-sonnet-5', state: 'progress', startedAt: 1790841121858, queuedAt: 1790841121750, attempt: 1, lastToolName: 'Read', lastToolSummary: 'C:\\Users\\you\\claude-code-ui\\lib\\history.js', promptFramed: true, lastProgressAt: 1790841125833, tokens: 17605, toolCalls: 1 },
  { type: 'workflow_agent', index: 2, label: 'review:pure-ultracode', phaseIndex: 1, phaseTitle: 'Review', agentId: 'a864bf577e19a4d58', model: 'eu.anthropic.claude-sonnet-5', state: 'progress', startedAt: 1790841121862, queuedAt: 1790841121751, attempt: 1, lastToolName: 'Read', lastProgressAt: 1790841125900, tokens: 12000, toolCalls: 1 },
  { type: 'workflow_agent', index: 3, label: 'review:models-ultracode', phaseIndex: 1, phaseTitle: 'Review', agentId: 'a2c6602d51e8cce2c', model: 'eu.anthropic.claude-sonnet-5', state: 'progress', startedAt: 1790841121866, queuedAt: 1790841121751, attempt: 1, lastToolName: 'Read', lastToolSummary: 'C:\\Users\\you\\claude-code-ui\\lib\\models.js', promptFramed: true, lastProgressAt: 1790841185541, tokens: 28123, toolCalls: 1 },
];
const progressFrame = (list) => ({ type: 'system', subtype: 'task_progress', task_id: TASK, tool_use_id: TUID, description: 'Probe', usage: { total_tokens: 0, tool_uses: 0, duration_ms: 109 }, workflow_progress: list });
// task_started arrives BEFORE the tool_result — measured on the paid run (_seq 41 vs _seq 42)
const STARTED = { type: 'system', subtype: 'task_started', task_id: TASK, tool_use_id: TUID, description: 'Protokollsonde: vier triviale Agenten, keine Werkzeuge', task_type: 'local_workflow', workflow_name: 'ccui-probe' };

// One lane, fed the real frame order of the paid run — THROUGH THE SHIPPED PUMP (test/event-pump.js): the
// assistant frame with the Workflow call, task_started (_seq 41), the launch receipt as tool_result +
// tool_use_result (_seq 42), then the task_progress frames. It used to call laneSystemEvent, laneToolResult,
// wfApplyLaunch and wfSystemEvent itself, i.e. it rebuilt the wiring chat-events.js + chat-render.js are
// supposed to supply — and with the wfSystemEvent call and the wfApplyLaunch block cut out of chat-render.js
// every test in this file stayed green (the adversarial review's mutation M-D). Now every test below that
// builds its lane with this helper also proves the frame got there the way the browser's does.
function runWith(progressLists) {
  const tab = { agents: [] };
  const pump = eventPump(tab);
  pump.feed(frames.toolUse({ id: TUID, name: 'Workflow', input: { script: 'export const meta = { name: "ccui-probe" };' } }));
  pump.feed(STARTED);
  pump.feed(frames.toolResult([{ id: TUID, text: 'Workflow launched in background.' }], RECEIPT));
  (progressLists || []).forEach((l) => pump.feed(progressFrame(l)));
  return { tab, lanes: tab.agents, pump };
}
function laneWithRun(progressLists) { return runWith(progressLists).lanes; }

describe('U1 — the workflow lane is fed by the STREAM, not by journal.jsonl', () => {
  it('task_progress.workflow_progress reaches the lane (the brief said the stream does not carry it)', () => {
    // docs/messung-2026-10-02.md:130 and the brief for this change both say the progress is „aus dem Strom
    // allein nicht lesbar". Both paid recordings contradict that, and this is the pin: if a future CLI
    // really stops sending the array, THIS test goes red instead of the rail going quietly blank.
    const lanes = laneWithRun([PROBE_FIRST, PROBE_START, PROBE_A1_DONE]);
    const v = wfView(lanes[0]);
    assert.equal(v.phases.length, 1);
    assert.equal(v.phases[0].title, 'Probe');
    assert.equal(v.phases[0].agents.length, 2);
    assert.deepEqual(v.phases[0].agents.map((a) => a.label), ['probe:a1', 'probe:a2']);
    assert.equal(v.counts.done, 1);
    assert.equal(v.counts.running, 1);
  });

  it('the launch receipt is read instead of dropped — runId · transcriptDir · workflowName · scriptPath', () => {
    // Through the pump (runWith): the receipt arrives as a tool_result frame, chat-events.js hands it to
    // chat-render.js agentToolResult, and THAT is where wfApplyLaunch has to be called. Cut the call out and
    // this goes red — before the blocker round it stayed green, because the helper called wfApplyLaunch itself.
    const lanes = laneWithRun([]);
    const a = lanes[0];
    assert.equal(a.wfRunId, 'wf_ed88bba6-7e5');
    assert.equal(a.wfName, 'ccui-probe');
    assert.ok(a.wfTranscriptDir.endsWith('wf_ed88bba6-7e5'), 'PR-13 reads the agent transcripts under this path');
    assert.match(a.wfScriptPath, /probe-wf\.js$/);
    // …and the half of the old reading that was simply wrong: a LOCAL workflow's taskId became
    // `remoteTaskId` („a CLOUD id, not task_id"), which nothing reads.
    assert.equal(a.taskId, TASK);
    assert.equal(a.remoteTaskId, undefined, 'a local workflow has no cloud task id');
    assert.equal(wfIsWorkflow(a), true);
  });

  it('laneToolResult adopts the receipt taskId for a lane that has none (the module rule — and what it does NOT cover)', () => {
    // What this pins is agent-lanes.js on its own: an `async_launched` receipt's taskId becomes the lane's
    // taskId when nothing supplied one. It is NOT „the ⏹ survives a lost task_started" for a Workflow, as an
    // earlier version of this title said: the panel creates a Workflow's lane from task_started and from
    // nothing else (the Workflow tool is no isAgentTool, so its tool_use opens no lane), so without that frame
    // there is no lane, no ⚙ group and no ⏹ at all. Both paid runs delivered it before the receipt
    // (_seq 41 vs 42); the gap is named in docs/ideas.md (U1, „ohne task_started").
    const lanes = [];
    laneStart(lanes, { id: TUID, input: { description: 'd' } }, 1000);
    laneToolResult(lanes, { id: TUID, isError: false, out: RECEIPT }, 1100);
    assert.equal(lanes[0].taskId, TASK);
    assert.equal(lanes[0].taskType, 'local_workflow');
  });

  it('a remote_launched receipt keeps remoteTaskId — the counter-test for the fix above', () => {
    const lanes = [];
    laneStart(lanes, { id: 'r1', input: {} }, 1000);
    laneToolResult(lanes, { id: 'r1', isError: false, out: { status: 'remote_launched', taskId: 'cloud-xyz', sessionUrl: 'https://x' } }, 1100);
    assert.equal(lanes[0].remoteTaskId, 'cloud-xyz');
    assert.equal(lanes[0].taskId, undefined, 'a cloud id must not be handed to stop_task');
  });

  it('a progress frame WITHOUT workflow_progress does not wipe what we know (measured: 1 of 8 frames)', () => {
    const lanes = laneWithRun([PROBE_START]);
    const before = wfSig(lanes[0]);
    const changed = wfSystemEvent(lanes, { type: 'system', subtype: 'task_progress', task_id: TASK, tool_use_id: TUID, usage: { duration_ms: 3244 } }, 3000);
    assert.equal(changed, false, 'nothing structural happened');
    assert.equal(wfSig(lanes[0]), before, 'the fan-out survived a frame that said nothing about it');
    assert.equal(wfView(lanes[0]).phases[0].agents.length, 2);
  });

  it('entries are merged by `index`, not by array position', () => {
    const lanes = laneWithRun([PROBE_START]);
    // the same two agents, in the OTHER order, a2 now finished
    wfSystemEvent(lanes, progressFrame([PHASE1,
      Object.assign({}, PROBE_START[2], { state: 'done', durationMs: 1161, resultPreview: 'PROBE-a2-OK', agentId: 'ac971068dba61ea34' }),
      PROBE_START[1],
    ]), 3000);
    const v = wfView(lanes[0]);
    assert.equal(v.phases[0].agents.length, 2, 'position-keyed merging would have made four');
    const a2 = v.phases[0].agents.find((x) => x.label === 'probe:a2');
    assert.equal(a2.state, 'done');
    assert.equal(a2.result, 'PROBE-a2-OK');
  });

  it('a field the newer frame does not repeat is kept, not cleared', () => {
    const lanes = laneWithRun([PROBE_A1_DONE]);
    wfSystemEvent(lanes, progressFrame([PHASE1, { type: 'workflow_agent', index: 1, state: 'done', lastProgressAt: 1790970950999 }]), 3000);
    const a1 = wfView(lanes[0]).phases[0].agents[0];
    assert.equal(a1.label, 'probe:a1');
    assert.equal(a1.result, 'PROBE-a1-OK');
    assert.equal(a1.tokens, 8539);
  });
});

describe('U1 — Blocker 1: the frames reach the lane through the SHIPPED pump, and the rail is told', () => {
  // chat-events.js handleEventBody → chat-render.js agentSystemEvent → laneSystemEvent + wfSystemEvent →
  // agentRepaint(tab, a || b). Every link of that chain is shipped source here (test/event-pump.js); these
  // tests pin the two that no earlier test could see: that the progress array arrives at all, and that a
  // change of the fan-out — which laneSystemEvent alone reports as „nothing structural" — reaches the repaint.
  it('a task_progress that moves the fan-out lands on the lane AND asks the rail for a repaint', () => {
    const { tab, pump } = runWith([PROBE_START]);
    const n = pump.repaints.length;
    pump.feed(progressFrame(PROBE_A1_DONE));
    assert.equal(pump.repaints.length, n + 1, 'agentSystemEvent never ran for the frame');
    assert.equal(pump.repaints[n], true, 'laneSystemEvent says „nothing structural" for every task_progress — only wfSystemEvent can say otherwise');
    assert.equal(wfView(tab.agents[0]).counts.done, 1);
  });

  it('a frame whose numbers merely moved lands too, and does NOT rebuild the rail (the anti-flicker rule)', () => {
    const { tab, pump } = runWith([PROBE_START]);
    pump.feed(progressFrame([PHASE1, Object.assign({}, PROBE_START[1], { tokens: 4242, lastProgressAt: 1790970949900 })]));
    assert.equal(pump.repaints[pump.repaints.length - 1], false, 'a repaint per task_progress would flicker the whole rail');
    assert.equal(tab.agents[0].wfAgents.find((r) => r.index === 1).tokens, 4242, 'the number still arrived — the ticker writes it in place');
  });

  it('the receipt arrives through the pump as well — and asks for the repaint the ⚙ head needs (name, runId)', () => {
    const tab = { agents: [] };
    const pump = eventPump(tab);
    pump.feed(frames.toolUse({ id: TUID, name: 'Workflow', input: {} }));
    pump.feed(STARTED);
    assert.equal(tab.agents.length, 1, 'task_started opens the workflow\'s lane — the Workflow tool_use itself opens none');
    assert.equal(tab.agents[0].wfRunId, undefined);
    pump.feed(frames.toolResult([{ id: TUID, text: '…' }], RECEIPT));
    assert.equal(tab.agents[0].wfRunId, 'wf_ed88bba6-7e5');
    assert.equal(pump.repaints[pump.repaints.length - 1], true);
  });
});

describe('U1 — „abgebrochen" is never claimed, and „läuft" is never claimed either', () => {
  it('an unfinished agent on a run that is OVER reads „läuft noch oder abgebrochen"', () => {
    // This is the single sentence this whole change exists for. messung-journal-2026-10-03.md: the files
    // cannot tell a dead agent from a working one (same last record type), and the runtime has exactly two
    // state words. So the honest answer is both at once.
    const lanes = laneWithRun([PROBE_A1_DONE]);
    assert.equal(wfView(lanes[0]).phases[0].agents[1].state, 'running', 'while the run is alive');
    laneFinish(lanes[0], { at: 9000 });                 // task_updated/notification closed the workflow task
    const v = wfView(lanes[0]);
    assert.equal(v.taskOver, true);
    assert.equal(v.phases[0].agents[1].state, 'open');
    assert.equal(v.counts.open, 1);
    assert.equal(v.counts.done, 1);
  });

  it('wfAgentState maps the THREE measured words and NOTHING else', () => {
    assert.deepEqual(WF_STATES_RUNNING, ['start', 'progress']);
    assert.equal(wfAgentState({ state: WF_STATE_DONE }, false).state, 'done');
    assert.equal(wfAgentState({ state: WF_STATE_DONE }, true).state, 'done', 'done stays done when the run ends');
    for (const w of WF_STATES_RUNNING) {
      assert.equal(wfAgentState({ state: w }, false).state, 'running', w);
      assert.equal(wfAgentState({ state: w }, true).state, 'open', w);
      assert.equal(wfAgentState({ state: w }, false).raw, w, 'the raw word travels to the tooltip');
    }
    // a FOURTH word has never been observed, so it must not be folded into one of the three — the same rule
    // mcp-live.js uses for an unknown status
    for (const w of ['failed', 'aborted', 'killed', 'queued', '', undefined]) {
      const r = wfAgentState({ state: w }, false);
      assert.equal(r.state, 'unknown', JSON.stringify(w) + ' was interpreted');
      assert.equal(r.raw, w == null ? '' : w, 'the word itself has to survive so the row can print it');
    }
  });

  it('„progress" is a HEALTHY running agent, not an unknown state (the correction I nearly shipped)', () => {
    // PROGRESS_REAL is the verbatim snapshot of a real run (claude-scratch/uc-workflow.jsonl, 2026-10-01,
    // task_id w5x8u4tgb). `progress` appears 19 times there and ZERO times in the two paid runs or the 38
    // state files — so measuring only those would have made the rail read „unbekannter Zustand: progress"
    // for every normally working agent of every real workflow. docs/ideas.md U1 had it right.
    const lanes = laneWithRun([PROGRESS_REAL]);
    const v = wfView(lanes[0]);
    assert.equal(v.counts.running, 3);
    assert.equal(v.counts.unknown, 0, 'three healthy agents were reported as „unknown"');
    assert.deepEqual(v.phases.map((p) => p.title), ['Review', 'Verify']);
    assert.equal(v.phases[0].agents[0].tokens, 17605);
    assert.equal(v.phases[0].agents[0].lastTool, 'Read');
    // …and once the run is over they become the honest „läuft noch oder abgebrochen", all three of them
    laneFinish(lanes[0], { at: 9e12 });
    assert.equal(wfView(lanes[0]).counts.open, 3);
  });

  it('the count never adds up to „fertig" — done/total only', () => {
    const lanes = laneWithRun([PROBE_A1_DONE]);
    const v = wfView(lanes[0]);
    // 1 of 2 through while the run lives; nothing in the view says „the workflow is finished", because
    // `laufend === 0` is also the gap between two phases (the measurement's first trap).
    assert.equal(v.counts.total, 2);
    assert.equal(v.counts.done + v.counts.running + v.counts.open + v.counts.unknown, v.counts.total);
    assert.ok(!('finished' in v) && !('complete' in v));
  });
});

describe('U1 — the numbers a row shows are the ones that were measured', () => {
  it('a cached agent gets NO duration (measured: cached ⟺ no durationMs, 9 of 9)', () => {
    assert.equal(wfAgentElapsedMs({ cached: true, startedAt: 1, lastProgressAt: 5000 }), null);
    const v = wfAgentView({ index: 1, label: 'x', state: 'done', cached: true, startedAt: 1, lastProgressAt: 5000 }, false);
    assert.equal(v.cached, true);
    assert.equal(v.elapsedMs, undefined, 'a 0 next to „done" would read as a measurement');
  });

  it('the runtime\'s own durationMs wins, and the fallback is flagged as not-final', () => {
    assert.equal(wfAgentElapsedMs({ durationMs: 1280, startedAt: 100, lastProgressAt: 9999 }), 1280);
    assert.equal(wfAgentElapsedMs({ startedAt: 1790970949205, lastProgressAt: 1790970949967 }), 762);
    const fin = wfAgentView({ index: 1, state: 'done', durationMs: 1280, startedAt: 1, lastProgressAt: 2 }, false);
    const live = wfAgentView({ index: 2, state: 'start', startedAt: 1790970949205, lastProgressAt: 1790970949967 }, false);
    assert.equal(fin.elapsedFinal, true);
    assert.equal(live.elapsedFinal, false, 'the age at the last report is not a duration');
    // both timestamps come from the CLI's clock, so the DIFFERENCE carries no skew — a Date.now()-based
    // reading would (agent-lanes.js laneElapsedMs documents the same hazard for the lane's own ticker)
    assert.equal(live.elapsedMs, 762);
  });

  it('a retry is SHOWN rather than hidden — the one place the stream is thinner than the journal', () => {
    // Measured: workflow_progress collapses the attempts of one label into the last one, so its length
    // equals `agentCount`, which is FEWER than the journal's `started` records in 8 of 38 runs. The
    // replaced attempt's own numbers are not on the stream — the row says „attempt 2" and claims no more.
    const lanes = laneWithRun([RETRY]);
    const v = wfView(lanes[0]);
    assert.equal(v.phases.length, 2);
    const r = v.phases[0].agents[0];
    assert.equal(r.attempt, 2);
    assert.equal(r.attemptReason, 'stalled');
    assert.equal(v.phases[1].agents[0].attempt, undefined, 'attempt 1 is not a retry and gets no badge');
  });

  it('phases keep the order they appeared in, and agents hang under the phase they name', () => {
    const lanes = laneWithRun([MULTI]);
    const v = wfView(lanes[0]);
    assert.deepEqual(v.phases.map((p) => p.title), ['Verstehen', 'Entwerfen', 'Synthese']);
    assert.deepEqual(v.phases.map((p) => p.agents.length), [1, 1, 1]);
    assert.equal(v.phases[0].agents[0].agentType, 'Explore');
    assert.equal(v.phases[2].agents[0].agentType, 'Plan');
  });

  it('an agent whose phaseIndex nobody announced is KEPT in a bucket of its own', () => {
    // 0 such entries in 38 runs, so this is the defensive branch — and it is here because dropping a
    // measured agent is the mirror of inventing one.
    const lanes = laneWithRun([[PHASE1, { type: 'workflow_agent', index: 7, label: 'waise', phaseIndex: 9, phaseTitle: 'Unangekündigt', state: 'start', startedAt: 1, lastProgressAt: 2 }]]);
    const v = wfView(lanes[0]);
    assert.equal(v.counts.total, 1, 'the agent must not vanish');
    const bucket = v.phases.find((p) => p.unannounced);
    assert.ok(bucket, 'phases: ' + JSON.stringify(v.phases.map((p) => p.title)));
    assert.equal(bucket.title, 'Unangekündigt');
    assert.equal(bucket.agents[0].label, 'waise');
  });

  it('wfSig moves on a STRUCTURAL change and stands still for a live number', () => {
    const lanes = laneWithRun([PROBE_START]);
    const s0 = wfSig(lanes[0]);
    // a token count ticking up is written in place by the 1s ticker — no rail rebuild
    wfSystemEvent(lanes, progressFrame([PHASE1, Object.assign({}, PROBE_START[1], { tokens: 4242, lastProgressAt: 1790970949900 })]), 3000);
    assert.equal(wfSig(lanes[0]), s0, 'a repaint per progress frame would flicker the whole rail');
    // a state flip, a new agent and the run ending all have to move it
    wfSystemEvent(lanes, progressFrame([PHASE1, Object.assign({}, PROBE_START[1], { state: 'done' })]), 3010);
    const s1 = wfSig(lanes[0]);
    assert.notEqual(s1, s0);
    laneFinish(lanes[0], { at: 9000 });
    assert.notEqual(wfSig(lanes[0]), s1, 'the run ending rewrites every unfinished row\'s sentence');
  });

  it('a frame for another lane changes nothing (and never creates one)', () => {
    const lanes = laneWithRun([PROBE_START]);
    const before = wfSig(lanes[0]);
    assert.equal(wfSystemEvent(lanes, { type: 'system', subtype: 'task_progress', task_id: 'somebody-else', tool_use_id: 'toolu_other', workflow_progress: MULTI }, 4000), false);
    assert.equal(lanes.length, 1);
    assert.equal(wfSig(lanes[0]), before);
  });
});

// ---- layer 2+3: the readers -------------------------------------------------------------------------
// Lifted out of the shipped sources by name, the way test/agent-lanes.test.js and
// test/ultracode-honesty.test.js do it: so the WIRING is under test, not a copy of it.
const ROOT = path.join(__dirname, '..');
const RENDER_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat-render.js'), 'utf8');
const SIDE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat-side.js'), 'utf8');
function liftFn(src, name, rel) {
  const one = new RegExp('^(?:async )?function ' + name + '\\(.*\\}[ \\t]*$', 'm');
  const multi = new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm');
  const m = one.exec(src) || multi.exec(src);
  assert.ok(m, name + '() not found in ' + rel + ' — renamed or reindented? Then these tests prove nothing.');
  return m[0];
}
function liftDecl(src, kw, name, rel) {
  const m = new RegExp('^' + kw + ' ' + name + ' = [\\s\\S]*?^\\};?$|^' + kw + ' ' + name + ' = .*$', 'm').exec(src);
  assert.ok(m, kw + ' ' + name + ' not found in ' + rel);
  return m[0];
}
function bundle(pieces, names, env) {
  const keys = Object.keys(env);
  const body = pieces.join('\n') + '\nreturn { ' + names.join(', ') + ' };';
  return new Function(...keys, body)(...keys.map((k) => env[k]));
}
// The smallest DOM that can answer „what does this row say": appendChild, className, textContent, title.
function fakeEl(tag, cls, text) {
  const n = {
    tag, className: cls || '', textContent: text == null ? '' : String(text), title: '', children: [],
    dataset: {}, open: false, type: '', href: '', onclick: null, ontoggle: null, disabled: false, attrs: {},
    setAttribute(k, v) { n.attrs[k] = String(v); },
    appendChild(c) { this.children.push(c); return c; },
    // `toggle` really toggles: the collapsed-strip count is shown/hidden through it, and a no-op here would
    // let a test read the text of a badge the rail has hidden
    classList: {
      add(c) { n.className += ' ' + c; },
      remove(c) { n.className = String(n.className).split(/\s+/).filter((x) => x && x !== c).join(' '); },
      contains(c) { return String(n.className).split(/\s+/).includes(c); },
      toggle(c, on) { const has = n.classList.contains(c); const want = on === undefined ? !has : !!on; if (want && !has) n.classList.add(c); else if (!want && has) n.classList.remove(c); return want; },
    },
    querySelector(sel) {
      const want = String(sel).replace(/^\./, '');
      const walk = (x) => {
        for (const c of x.children) {
          if (String(c.className).split(/\s+/).includes(want)) return c;
          const d = walk(c); if (d) return d;
        }
        return null;
      };
      return walk(n);
    },
    remove() {},
  };
  return n;
}
// Everything the row builder reaches for. `tt` returns the KEY, so an assertion names the key and cannot
// drift with a wording change.
const LANES = require('../public/js/agent-lanes');
const STOP = require('../public/js/task-stop');
function renderEnv(active) {
  return {
    ACTIVE: active, el: fakeEl, tt: (k) => k, fmtInt: (n) => String(n),
    wfIsWorkflow, wfView, laneModelId: (m) => m,
    // the shipped G6 paint, so the ⏹ on the head is the REAL button and not a stand-in
    agentStopParts: null, stopTaskTarget: STOP.stopTaskTarget, stopTaskScope: STOP.stopTaskScope,
    stopView: STOP.stopView, agentStopClick: () => {}, laneElapsedMs: LANES.laneElapsedMs,
  };
}
function loadRows(active) {
  const pieces = [
    liftDecl(RENDER_SRC, 'const', 'WF_MARKS', 'public/js/chat-render.js'),
    liftFn(RENDER_SRC, 'wfMark', 'public/js/chat-render.js'),
    liftFn(RENDER_SRC, 'wfSecs', 'public/js/chat-render.js'),
    liftFn(RENDER_SRC, 'wfRowTitle', 'public/js/chat-render.js'),
    liftFn(RENDER_SRC, 'agentLaneSplit', 'public/js/chat-render.js'),
    liftFn(RENDER_SRC, 'agentLaneCounts', 'public/js/chat-render.js'),
    liftFn(RENDER_SRC, 'agentElapsed', 'public/js/chat-render.js'),
    liftFn(RENDER_SRC, 'agentStopParts', 'public/js/chat-render.js'),
    liftFn(RENDER_SRC, 'workflowRows', 'public/js/chat-render.js'),
    liftFn(RENDER_SRC, 'workflowCounts', 'public/js/chat-render.js'),
    liftFn(RENDER_SRC, 'workflowCountLabel', 'public/js/chat-render.js'),
  ];
  const env = renderEnv(active);
  delete env.agentStopParts;                       // lifted from the source instead of faked
  return bundle(pieces, ['workflowRows', 'workflowCounts', 'workflowCountLabel', 'agentLaneSplit', 'agentLaneCounts', 'wfSecs'], env);
}
// The 1 s ticker, with just enough DOM to find the heads it is supposed to rewrite in place.
function loadTicker(lanes, heads) {
  const env = {
    ACTIVE: { agents: lanes }, laneMetrics: LANES.laneMetrics, laneElapsedMs: LANES.laneElapsedMs,
    lanesPruneStale: () => false, lanesPruneFaded: (l) => l, stopSig: STOP.stopSig,
    renderAgentStrip: () => {}, ensureAgentTimer: () => {}, agentLiveText: () => '', agentLaneTitle: () => '',
    document: {
      querySelectorAll: (sel) => (sel === '.wf-head.running'
        ? heads.filter((h) => /\brunning\b/.test(String(h.className)))
        : []),
    },
  };
  const keys = Object.keys(env);
  return new Function(...keys, liftFn(RENDER_SRC, 'tickAgentMeta', 'public/js/chat-render.js') + '\nreturn tickAgentMeta;')(...keys.map((k) => env[k]));
}
// the row's own text AND its children's — a one-line row (wf-empty) carries it directly
const flat = (rows) => rows.map((r) => ({
  cls: String(r.className).trim(),
  text: [r.textContent].concat(r.children.map((c) => c.textContent)).filter(Boolean).join(' '),
  title: r.title,
}));

describe('U1 — the row builder in chat-render.js really paints what the module decided', () => {
  it('a head row, a phase row and one row per agent, in run order', () => {
    const lanes = laneWithRun([MULTI]);
    const { workflowRows } = loadRows({ agents: lanes });
    const rows = flat(workflowRows());
    assert.deepEqual(rows.map((r) => r.cls), ['wf-head running', 'wf-phase', 'wf-item done', 'wf-phase', 'wf-item done', 'wf-phase', 'wf-item running']);
    assert.match(rows[0].text, /ccui-probe/);
    assert.match(rows[0].text, /wf_ed88bba6-7e5/);
    assert.match(rows[1].text, /Verstehen 1\/1/);
    assert.match(rows[2].text, /explore:sitzungen-start/);
  });

  it('the „läuft noch oder abgebrochen" row carries that sentence as its OWN line, not just a colour', () => {
    const lanes = laneWithRun([MULTI]);
    laneFinish(lanes[0], { at: 9e12 });
    const { workflowRows } = loadRows({ agents: lanes });
    const rows = flat(workflowRows());
    const open = rows.find((r) => r.cls === 'wf-item open');
    assert.ok(open, 'rows: ' + JSON.stringify(rows.map((r) => r.cls)));
    assert.match(open.text, /chat-render\.wfOffen/, 'a reader must be able to READ it, not infer it from amber');
    assert.match(open.title, /chat-render\.wfOffen/);
    // …and the finished rows must NOT acquire it
    assert.equal(rows.filter((r) => /chat-render\.wfOffen/.test(r.text)).length, 1);
  });

  it('an unknown state word is printed verbatim next to „unknown state"', () => {
    const lanes = laneWithRun([[PHASE1, { type: 'workflow_agent', index: 1, label: 'x', phaseIndex: 1, phaseTitle: 'Probe', state: 'quantum', startedAt: 1, lastProgressAt: 2 }]]);
    const { workflowRows } = loadRows({ agents: lanes });
    const row = flat(workflowRows()).find((r) => r.cls === 'wf-item unknown');
    assert.ok(row);
    assert.match(row.text, /chat-render\.wfUnbekannt: quantum/);
  });

  it('the tooltip names the runtime\'s own word, so start and progress stay distinguishable', () => {
    // Both read „läuft" on a 220px row — there is no width for the difference. The bracket in the tooltip is
    // where „queued, nothing reported yet" and „working, has reported" stop being the same statement.
    const lanes = laneWithRun([PROGRESS_REAL]);
    const prog = flat(loadRows({ agents: lanes }).workflowRows()).find((r) => r.cls === 'wf-item running');
    assert.match(prog.title, /chat-render\.wfLaeuft \(progress\)/);
    const lanes2 = laneWithRun([PROBE_START]);
    const start = flat(loadRows({ agents: lanes2 }).workflowRows()).find((r) => r.cls === 'wf-item running');
    assert.match(start.title, /chat-render\.wfLaeuft \(start\)/);
  });

  it('the age at the last report is marked „~", the runtime\'s own total is not', () => {
    const { wfSecs } = loadRows({ agents: [] });
    assert.equal(wfSecs({ elapsedMs: 1280, elapsedFinal: true }), '1s');
    assert.equal(wfSecs({ elapsedMs: 762, elapsedFinal: false }), '~1s');
    assert.equal(wfSecs({ elapsedMs: null }), '', 'a cached agent gets no number at all');
  });

  it('a lane with no progress yet says so instead of claiming „0 Agenten"', () => {
    const lanes = laneWithRun([]);
    const { workflowRows, workflowCounts } = loadRows({ agents: lanes });
    const rows = flat(workflowRows());
    assert.deepEqual(rows.map((r) => r.cls), ['wf-head running', 'wf-empty']);
    assert.match(rows[1].text, /chat-render\.wfNochKeineMeldung/);
    assert.equal(workflowCounts().total, 0);
  });

  it('the workflow lane is OUT of the 🤖 group and the agent lanes are out of the ⚙ one', () => {
    const lanes = laneWithRun([PROBE_START]);
    laneStart(lanes, { id: 'plain1', input: { subagent_type: 'Explore', description: 'etwas suchen' } }, 1200);
    const { agentLaneSplit } = loadRows({ agents: lanes });
    const s = agentLaneSplit({ agents: lanes });
    assert.deepEqual(s.plain.map((a) => a.id), ['plain1']);
    assert.deepEqual(s.workflows.map((a) => a.id), [TUID]);
    assert.equal(s.plain.length + s.workflows.length, lanes.length, 'no lane may be in both groups — or in neither');
  });

  it('the RUN keeps its own ⏱ and its ⏹ — both followed the lane out of the 🤖 group', () => {
    // The workflow lane used to sit in the 🤖 group, where agentRows() gave it a ticking elapsed readout and
    // — since G6 — the ⏹ that stops the whole run (`stop_task` takes one id, and a workflow carries one for
    // its entire fan-out). Moving the lane to its own group would have silently dropped both: the group is
    // the only place they were ever built.
    const lanes = laneWithRun([PROBE_START]);
    const { workflowRows } = loadRows({ agents: lanes });
    const rows = workflowRows();
    const head = rows[0];
    assert.match(String(head.className), /running/, 'the ticker only rewrites a RUNNING head');
    assert.equal(head.dataset.wfLane, TUID, 'without this the ticker cannot find the head');
    const time = head.children.find((c) => String(c.className) === 'wf-head-time');
    assert.ok(time, 'children: ' + JSON.stringify(head.children.map((c) => c.className)));
    assert.match(time.textContent, /^⏱ \d+s$/);
    const stop = head.children.find((c) => c.tag === 'button' && String(c.className) === 'agent-stop');
    assert.ok(stop, 'the ⏹ for the whole run is gone');
    assert.equal(stop.disabled, false, 'the receipt supplied a taskId, so it is usable');
    assert.match(stop.title, /agentStoppWorkflowTooltip/, 'it must say „stop the WORKFLOW", not „this agent"');
    // …and the ticker really writes into it
    const tick = loadTicker(lanes, [head]);
    time.textContent = 'stale';
    tick();
    assert.match(time.textContent, /^⏱ \d+s$/, 'the head\'s clock stood still');
  });

  it('a FINISHED run shows no ⏱ prefix and no ⏹', () => {
    const lanes = laneWithRun([PROBE_START]);
    laneFinish(lanes[0], { at: 9e12 });
    const head = loadRows({ agents: lanes }).workflowRows()[0];
    assert.doesNotMatch(String(head.className), /running/);
    assert.equal(head.children.find((c) => c.tag === 'button'), undefined, 'nothing left to stop');
    assert.doesNotMatch(head.children.find((c) => String(c.className) === 'wf-head-time').textContent, /⏱/);
  });

  it('the badges say retry and cache, and the tooltip says why', () => {
    const lanes = laneWithRun([[PHASE1,
      Object.assign({}, RETRY[2], { phaseIndex: 1, phaseTitle: 'Probe' }),
      { type: 'workflow_agent', index: 2, label: 'aus-cache', phaseIndex: 1, phaseTitle: 'Probe', state: 'done', startedAt: 1, lastProgressAt: 2, cached: true, resultPreview: 'x' },
    ]]);
    const { workflowRows } = loadRows({ agents: lanes });
    const rows = flat(workflowRows()).filter((r) => /wf-item/.test(r.cls));
    assert.match(rows[0].text, /↻2/);
    assert.match(rows[0].title, /chat-render\.wfVersuch/);
    assert.match(rows[1].text, /⚡/);
    assert.match(rows[1].title, /chat-render\.wfZwischenspeicher/);
    assert.match(rows[1].text, /—/, 'a cached agent shows a dash, never a 0s that looks measured');
  });
});

describe('U1 — the RAIL shows the group (the drawer that swallowed four correct results)', () => {
  // chat-side.js chatSideRefresh() skips its repaint on „nothing changed". A workflow's fan-out changes
  // while the LANE's own fields stand still, so this is the one place where correct logic would have been
  // invisible. Lifted and run against a fake DOM.
  function loadRail(active) {
    // the SHIPPED split and its counts (chat-render.js), not a re-implementation: the 🤖/⚙ question is
    // exactly what Blocker 3 was about, and a fake split here could agree with the test instead of the code
    const real = loadRows(active);
    const folds = [];
    const env = {
      ACTIVE: active, el: fakeEl, tt: (k) => k, document: { createTextNode: (t) => fakeEl('#text', '', t) },
      chatLayoutGet: () => ({}), chatLayoutSet: () => {},
      persistedAllows: () => [], persistedChip: (c) => fakeEl('div', 'chip', c), grantChips: () => [],
      openPointsSig: () => '', openPointRow: () => fakeEl('div', 'op'), openPointsStaged: () => [],
      openPointsSendStaged: () => {}, openPointResolve: () => {},
      lanesSig: require('../public/js/agent-lanes').lanesSig, wfSig,
      // the rail's auto-fold memory + the setter it drives. The setter RECORDS: whether a running workflow
      // still opens the rail is part of Blocker 3 (the 🤖 count may change its word, never the fold decision)
      _sideUserCollapsed: false, _sideUserExpanded: false, chatSideSetCollapsed: (on, opts) => { folds.push([on, opts]); },
      // one row per PLAIN lane, the way the shipped agentRows() does it — a fake that always returns one
      // row made the „🤖 stops counting the workflow" test pass under its own mutation (green for the
      // wrong reason), because the group's default count is `chips.length`
      agentRows: () => real.agentLaneSplit(active).plain.map(() => fakeEl('div', 'agent-item')),
      agentLaneSplit: real.agentLaneSplit,
      agentLaneCounts: real.agentLaneCounts,
      workflowRows: () => (loadRows(active).workflowRows()),
      workflowCounts: () => (loadRows(active).workflowCounts()),
      workflowCountLabel: real.workflowCountLabel,
      SLOT: null,
    };
    const slot = fakeEl('div', 'slot'), rail = fakeEl('div', 'rail');
    const empty = fakeEl('div', 'empty'), cnt = fakeEl('span', 'cnt');
    env.$ = (sel) => ({ '#chatSide': rail, '#chatSideSlot': slot, '#chatSideEmpty': empty, '#chatSideCount': cnt }[sel] || null);
    // the slot is emptied with `slot.innerHTML = ''` — give the fake a setter that clears the children
    Object.defineProperty(slot, 'innerHTML', { set() { slot.children.length = 0; }, get() { return ''; } });
    // Since #85 (plan progress, PF-1) chatSideRefresh also asks for the tab's PLAN. Those helpers are LIFTED,
    // not stubbed — the same rule as everything above: a stub returning „no plan" would be a second, invented
    // answer to a question the shipped code already answers. It is safe to lift them without their own
    // dependencies because the tabs in this suite carry no `plan`: planRailPlan() short-circuits on
    // `tab.plan` and returns null before it ever reaches planProgressOn()/planVisible(), planRailSig() then
    // returns '', and planBadgePaint(null) finds no #chatSidePlan in this fake DOM and returns. If a test here
    // ever gives a tab a plan, those three missing names throw at once — loud, not silently „no plan".
    // A tab that has a plan AND a workflow at the same time — the combination the merge of #85 created — is
    // not run through this harness but through the WHOLE chat-side.js, further down („U1 × PF-1").
    const api = bundle([
      liftDecl(SIDE_SRC, 'let', '_sideSig', 'public/js/chat-side.js'),
      liftFn(SIDE_SRC, 'chatSideGroup', 'public/js/chat-side.js'),
      liftFn(SIDE_SRC, 'railAutoAction', 'public/js/chat-side.js'),
      liftFn(SIDE_SRC, 'planRailPlan', 'public/js/chat-side.js'),
      liftFn(SIDE_SRC, 'planTabRests', 'public/js/chat-side.js'),
      liftFn(SIDE_SRC, 'planRailSig', 'public/js/chat-side.js'),
      liftFn(SIDE_SRC, 'planBadgePaint', 'public/js/chat-side.js'),
      liftFn(SIDE_SRC, 'chatSideRefresh', 'public/js/chat-side.js'),
    ], ['chatSideRefresh'], env);
    return { refresh: api.chatSideRefresh, slot, cnt, folds };
  }
  const groups = (slot) => slot.children.map((g) => String(g.className).trim());

  it('a running workflow gets its own ⚙ group next to the 🤖 one', () => {
    const lanes = laneWithRun([MULTI]);
    const { refresh, slot } = loadRail({ agents: lanes, alwaysAllow: [], openPoints: [], hooks: [] });
    refresh(true);
    assert.ok(groups(slot).some((c) => /cside-workflow/.test(c)), 'groups: ' + JSON.stringify(groups(slot)));
    const g = slot.children.find((x) => /cside-workflow/.test(String(x.className)));
    const head = g.querySelector('.cside-grouphead');
    assert.match(head.children.map((c) => c.textContent).join(' '), /chat-side\.workflow/);
    // S2 — the emoji is its own span in front of the label (the jump bar reads it from there)
    assert.equal(head.querySelector('.cside-gico').textContent, '⚙');
    assert.equal(g.querySelector('.cside-groupcount').textContent, '2/3', 'done/total — never „fertig"');
  });

  it('…and the group is REPAINTED when only the fan-out moved (the signature guard)', () => {
    const { lanes, pump } = runWith([PROBE_START]);
    const tab = { agents: lanes, alwaysAllow: [], openPoints: [], hooks: [] };
    const { refresh, slot } = loadRail(tab);
    refresh(true);
    const before = slot.children.find((x) => /cside-workflow/.test(String(x.className))).querySelector('.cside-groupcount').textContent;
    assert.equal(before, '0/2');
    // probe:a1 finishes. The LANE itself is untouched — same status, same desc, same totals — so lanesSig
    // reports „nothing changed" and the unforced refresh below is the real test. The frame goes in through
    // the shipped pump, the way the browser's does.
    const laneSigBefore = require('../public/js/agent-lanes').lanesSig(lanes);
    pump.feed(progressFrame(PROBE_A1_DONE));
    assert.equal(require('../public/js/agent-lanes').lanesSig(lanes), laneSigBefore, 'if this ever differs the test no longer proves anything');
    refresh(false);                                   // NOT forced — exactly how the 🤖 repaint path arrives
    const after = slot.children.find((x) => /cside-workflow/.test(String(x.className))).querySelector('.cside-groupcount').textContent;
    assert.equal(after, '1/2', 'the rail showed the run\'s first state for the whole run');
  });

  it('the 🤖 count stops counting the workflow as „one agent"', () => {
    // Deliberately a scenario whose two readings differ in the TEXT, not only in the arithmetic: one running
    // plain agent, one finished plain agent, one running workflow. Correct → „1/2" (one of two agents is
    // working). Counting the workflow in → „2/3". An earlier version of this test used one plain lane and one
    // workflow; both readings produced the same string, so it stayed green under its own mutation.
    const lanes = laneWithRun([MULTI]);
    laneStart(lanes, { id: 'plain1', input: { subagent_type: 'Explore', description: 'läuft' } }, 1200);
    laneStart(lanes, { id: 'plain2', input: { subagent_type: 'Plan', description: 'fertig' } }, 1300);
    laneFinish(laneFind(lanes, 'plain2'), { at: 1400 });
    const { refresh, slot } = loadRail({ agents: lanes, alwaysAllow: [], openPoints: [], hooks: [] });
    refresh(true);
    const ag = slot.children.find((x) => /cside-agents/.test(String(x.className)));
    assert.equal(ag.querySelector('.cside-groupcount').textContent, '1/2', 'three lanes, but only two of them are agent rows');
  });

  it('a tab without a workflow has no ⚙ group at all', () => {
    const lanes = [];
    laneStart(lanes, { id: 'plain1', input: { subagent_type: 'Explore', description: 'x' } }, 1200);
    const { refresh, slot } = loadRail({ agents: lanes, alwaysAllow: [], openPoints: [], hooks: [] });
    refresh(true);
    assert.equal(groups(slot).filter((c) => /cside-workflow/.test(c)).length, 0);
  });

  it('the head count warns, with a sentence, as soon as an agent cannot be placed', () => {
    const lanes = laneWithRun([MULTI]);
    laneFinish(lanes[0], { at: 9e12 });
    const { refresh, slot } = loadRail({ agents: lanes, alwaysAllow: [], openPoints: [], hooks: [] });
    refresh(true);
    const c = slot.children.find((x) => /cside-workflow/.test(String(x.className))).querySelector('.cside-groupcount');
    assert.match(String(c.className), /cside-count-open/);
    assert.match(c.title, /chat-side\.workflowOffenN/);
    // …and the NUMBER is in the text, not only in the tooltip and the colour: a folded group shows its head and
    // nothing else, so „1 agent cannot be placed" has to be readable there without hovering (Abnahme, Nebenpunkt 4)
    assert.equal(c.textContent, '2/3 · 1?');
  });

  // ---- Blocker 3: 🤖 means AGENT lanes everywhere, and the fold decision still sees the workflow ----------
  it('a running workflow and nothing else: the rail OPENS, and the collapsed strip says „1⚙", not „1🤖"', () => {
    // The exact scenario of the review: one running workflow, no other lane. Before, the collapsed strip
    // counted ACTIVE.agents whole and said „1🤖" over a rail whose only group was ⚙.
    const lanes = laneWithRun([PROBE_START]);
    const { refresh, slot, cnt, folds } = loadRail({ agents: lanes, alwaysAllow: [], openPoints: [], hooks: [] });
    refresh(true);
    assert.equal(groups(slot).filter((c) => /cside-agents/.test(c)).length, 0, 'there is no 🤖 group');
    assert.equal(cnt.textContent, '1⚙');
    assert.ok(!cnt.classList.contains('hidden'), 'a running workflow is live work — the badge must show');
    // The fold decision is handed the UNSPLIT lanes (railAutoAction `agents`/`running`) on purpose: switching
    // the badge's WORD to the split must not take a pure workflow's power to open the rail with it.
    assert.deepEqual(folds, [[false, { auto: true }]], 'the rail did not open for a running workflow');
  });

  it('an agent AND a workflow running: „1🤖" counts the agent alone (precedence ❓ > 🤖 > ⚙ > grants)', () => {
    const lanes = laneWithRun([PROBE_START]);
    laneStart(lanes, { id: 'plain1', input: { subagent_type: 'Explore', description: 'suchen' } }, Date.now());
    const { refresh, cnt } = loadRail({ agents: lanes, alwaysAllow: [], openPoints: [], hooks: [] });
    refresh(true);
    assert.equal(cnt.textContent, '1🤖', 'two lanes run, but only one of them is an agent');
  });

  it('a FINISHED workflow alone: no badge on the collapsed strip, and the rail does not fold it away', () => {
    const lanes = laneWithRun([MULTI]);
    laneFinish(lanes[0], { at: 9e12 });
    const { refresh, cnt, folds } = loadRail({ agents: lanes, alwaysAllow: [], openPoints: [], hooks: [] });
    refresh(true);
    assert.ok(cnt.classList.contains('hidden'), 'nothing is live — the strip count hides, as it does for „√3" agents');
    assert.deepEqual(folds, [], 'a finished run is a result (news), so the rail neither folds nor force-opens');
  });
});

// ---- Blocker 3, the status strip: chat-status.js renderStatusBar RUN, not grepped ---------------------
// The strip's 🤖 badge read ACTIVE.agents whole: one running workflow made it say „🤖 1", and its one-lane
// shortcut then opened agentDetailShow on the workflow lane — a view with nothing in it (no outputFile, U5).
// renderStatusBar is lifted out of the shipped file and compiled inside `with (Proxy)` (test/event-pump.js
// explains the technique): the badges it appends are read off the fake strip, so the call from
// renderStatusBar to laneStatusBadges is under test too, not only the helper.
const STATUS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat-status.js'), 'utf8');
function loadStatus(tab) {
  const calls = { collapsed: [], detail: [] };
  const left = fakeEl('div', 'cs-left');
  Object.defineProperty(left, 'innerHTML', { set() { left.children.length = 0; }, get() { return ''; } });
  const box = fakeEl('div', 'chat-status');
  box.querySelector = (sel) => (sel === '.cs-left' ? left : null);
  const loud = /^const LOUD_MODES = .*;$/m.exec(STATUS_SRC);
  assert.ok(loud, 'const LOUD_MODES not found in public/js/chat-status.js');
  const known = Object.assign(Object.create(null), {
    ACTIVE: tab, el: fakeEl, tt: (k) => k, $: (sel) => (sel === '#chatStatus' ? box : null),
    document: { querySelector: () => null }, STATE: { prefs: {} }, LIMIT_TIMER: null,
    modeInfo: () => ({ cls: 'm-plan', label: 'Plan' }),
    laneMetrics: LANES.laneMetrics, wfIsWorkflow, wfView,
    chatSideSetCollapsed: (...a) => { calls.collapsed.push(a); },
    agentDetailShow: (...a) => { calls.detail.push(a); },
  });
  const stub = () => undefined;
  const env = new Proxy(known, {
    has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
    get: (t, k) => (typeof k !== 'string' ? undefined : k in t ? t[k] : stub),
  });
  const src = [
    loud[0],
    liftFn(STATUS_SRC, 'laneStatusBadges', 'public/js/chat-status.js'),
    liftFn(STATUS_SRC, 'renderStatusBar', 'public/js/chat-status.js'),
    liftFn(RENDER_SRC, 'agentLaneSplit', 'public/js/chat-render.js'),
    liftFn(RENDER_SRC, 'agentLaneCounts', 'public/js/chat-render.js'),
    liftFn(RENDER_SRC, 'workflowCounts', 'public/js/chat-render.js'),
    liftFn(RENDER_SRC, 'workflowCountLabel', 'public/js/chat-render.js'),
  ].join('\n');
  const api = new Function('__env', 'with (__env) {\n' + src + '\nreturn { renderStatusBar };\n}')(env);
  return {
    calls, left,
    render: () => { api.renderStatusBar(); return left.children.filter((c) => /\bcs-agents\b/.test(String(c.className))); },
  };
}
const click = (b) => b.onclick({ stopPropagation() {} });

describe('U1 — Blocker 3: the status strip says 🤖 for agents and ⚙ for a workflow', () => {
  it('a running workflow and nothing else: no „🤖", a ⚙ badge with the group head\'s own count — and its click opens only the rail', () => {
    const tab = runWith([PROBE_START]).tab;
    const st = loadStatus(tab);
    const badges = st.render();
    assert.doesNotMatch(badges.map((b) => b.textContent).join(' | '), /🤖/, 'the strip said „🤖 1" for a tab with no agent lane');
    assert.equal(badges.length, 1);
    assert.equal(badges[0].textContent, '⚙ 0/2', 'the same text as the ⚙ group head (workflowCountLabel)');
    assert.match(String(badges[0].className), /\bcs-workflows\b/);
    assert.match(String(badges[0].className), /\blive\b/);
    assert.match(badges[0].title, /chat-status\.workflowsLaufen/);
    assert.match(badges[0].title, /ccui-probe · 0\/2/, 'the run\'s own line: name and done/total');
    click(badges[0]);
    assert.deepEqual(st.calls.collapsed, [[false]], 'the click opens the rail');
    assert.equal(st.calls.detail.length, 0, 'agentDetailShow on a workflow lane opens a detail view with nothing in it');
  });

  it('an agent next to the workflow: „🤖 1" is that AGENT, and the one-lane shortcut opens exactly it', () => {
    // Before: „🤖 2" (two running lanes), and lanes.length === 2 skipped the shortcut. One agent row exists, so
    // „exactly one agent" is true — the shortcut now looks at the agent lanes only.
    const { tab, lanes } = runWith([PROBE_START]);
    laneStart(lanes, { id: 'plain1', input: { subagent_type: 'Explore', description: 'suchen' } }, Date.now());
    const st = loadStatus(tab);
    const badges = st.render();
    assert.deepEqual(badges.map((b) => b.textContent), ['🤖 1', '⚙ 0/2']);
    assert.doesNotMatch(badges[0].title, /ccui-probe|Protokollsonde/, 'the workflow is not listed as an agent');
    click(badges[0]);
    assert.equal(st.calls.detail.length, 1);
    assert.equal(st.calls.detail[0][0].id, 'plain1', 'the shortcut must open the AGENT, never the workflow lane');
  });

  it('a finished run with an agent that never reported: the ⚙ badge shows the open count, as the head does', () => {
    const { tab, lanes } = runWith([MULTI]);
    laneFinish(lanes[0], { at: 9e12 });
    const badges = loadStatus(tab).render();
    assert.equal(badges.length, 1);
    assert.equal(badges[0].textContent, '⚙ 2/3 · 1?');
    assert.doesNotMatch(String(badges[0].className), /\blive\b/);
    assert.match(badges[0].title, /chat-status\.workflowsBeendet/);
    assert.match(badges[0].title, /chat-side\.workflowOffenN/);
  });

  it('the deferred-restart hint waits for a workflow AS a workflow, not as „1 Agent"', () => {
    const { tab } = runWith([PROBE_START]);
    tab.pendingRunCfg = { _why: [] };
    const st = loadStatus(tab);
    st.render();
    const hint = st.left.children.find((c) => /\bcs-hint\b/.test(String(c.className)));
    assert.ok(hint, 'children: ' + JSON.stringify(st.left.children.map((c) => c.className)));
    assert.match(hint.title, /chat-status\.wartetAufWorkflows/);
    assert.doesNotMatch(hint.title, /chat-status\.wartetAufAgenten/, 'a running workflow is not a running agent');
  });

  it('agents only: the 🤖 badge is what it was (count, √ when done, detail shortcut for one)', () => {
    const lanes = [];
    laneStart(lanes, { id: 'plain1', input: { subagent_type: 'Explore', description: 'x' } }, Date.now());
    const tab = { agents: lanes };
    const st = loadStatus(tab);
    assert.deepEqual(st.render().map((b) => b.textContent), ['🤖 1']);
    laneFinish(lanes[0], { at: Date.now() });
    assert.deepEqual(st.render().map((b) => b.textContent), ['🤖 √1']);
  });
});

// ---- U1 × PF-1: a tab with a PLAN and a WORKFLOW at the same time --------------------------------------
// This combination did not exist before main (#85, plan progress) was merged into this branch, and the merge
// commit named it as untested. The rail harness above lifts chatSideRefresh alone and gives its tabs no plan;
// here chat-side.js is loaded WHOLE into a vm context next to the real plan-progress.js, agent-lanes.js,
// task-stop.js and workflow-lanes.js — the way test/plan-wiring.test.js runs the plan rail — and the ⚙
// painters are lifted out of chat-render.js. Both features then share ONE chatSideRefresh, ONE signature, ONE
// collapsed-strip badge and ONE fold decision, which is exactly where they could step on each other.
const vm = require('node:vm');
class VmEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.parentElement = null; this.cls = new Set();
    this.dataset = {}; this.style = {}; this.attrs = {}; this.text = ''; this.html = ''; this.title = ''; this.open = false;
    this.type = ''; this.disabled = false; this.onclick = null; this.ontoggle = null;
  }
  get className() { return [...this.cls].join(' '); }
  set className(v) { this.cls = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
  get classList() {
    const c = this.cls;
    return { add: (...a) => a.forEach((x) => c.add(x)), remove: (...a) => a.forEach((x) => c.delete(x)), contains: (x) => c.has(x),
      toggle: (x, on) => { const w = on === undefined ? !c.has(x) : !!on; if (w) c.add(x); else c.delete(x); return w; } };
  }
  get textContent() { return this.text + this.children.map((k) => k.textContent).join(''); }
  set textContent(v) { this.text = String(v == null ? '' : v); this.children = []; }
  get innerHTML() { return this.html; }
  set innerHTML(v) { this.html = String(v); this.text = ''; this.children = []; }
  appendChild(k) { if (k.parentElement) k.remove(); k.parentElement = this; this.children.push(k); return k; }
  remove() { const p = this.parentElement; if (p) { p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; } }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  hasAttribute(k) { return k in this.attrs; }
  matches(sel) {
    const m = /^([a-z]*)((?:\.[\w-]+)*)((?:\[[\w-]+\])*)$/i.exec(sel.trim());
    if (!m) throw new Error('fake DOM cannot read the selector ' + sel);
    if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
    for (const c of (m[2].match(/\.[\w-]+/g) || [])) if (!this.cls.has(c.slice(1))) return false;
    for (const a of (m[3].match(/\[[\w-]+\]/g) || [])) {
      const n = a.slice(1, -1);
      if (n.startsWith('data-') ? !(n.slice(5).replace(/-([a-z])/g, (_, x) => x.toUpperCase()) in this.dataset) : !(n in this.attrs)) return false;
    }
    return true;
  }
  querySelectorAll(sel) { const out = []; const walk = (n) => n.children.forEach((k) => { if (k.matches(sel)) out.push(k); walk(k); }); walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  scrollIntoView() {}
}
const PLAN_MD = '# Plan: Testvorhaben\n\n## Umsetzung\n### 1. Modul\nText\n### 2. Route\nText\n### 3. Tests\nText\n';
function planWorld(tab) {
  const ids = {};
  for (const id of ['chatSide', 'chatSideSlot', 'chatSideEmpty', 'chatSideCount', 'chatSidePlan', 'chatSideToggle', 'sidecarBody']) {
    const e = new VmEl('div'); e.isRoot = true; ids['#' + id] = e;
  }
  const store = {};
  const noop = () => {};
  const ctx = {
    console, Date, Math, JSON, String, Number, Array, Object, Boolean, RegExp, Map, Set, isFinite, encodeURIComponent,
    el: (tag, cls, txt) => { const e = new VmEl(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; },
    $: (s) => ids[s] || null,
    document: { createTextNode: (s) => { const e = new VmEl('#text'); e.text = String(s); return e; } },
    tt: (k) => String(k), t: (k) => String(k), fmtInt: (n) => String(n),
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    STATE: { prefs: {} }, ACTIVE: tab,
    mkClickable: (e, label) => { e.setAttribute('role', 'button'); if (label) e.setAttribute('aria-label', label); return e; },
    toast: noop, logEvent: noop, persistTabsSoon: noop, renderTabs: noop, refreshNavBusy: noop, sendMessage: noop,
    sidecarShow: noop, renderMarkdown: (s) => s, copyBtn: () => new VmEl('button'),
    api: () => Promise.resolve({}), SIDECAR: { node: null, raw: '' },
    activateTab: noop, showView: noop, hasHeldGate: () => false, agentStopClick: noop,
    setTimeout: (fn) => { fn(); return 0; },
  };
  ctx.globalThis = ctx; ctx.window = ctx;
  const sb = vm.createContext(ctx);
  const pub = (f) => fs.readFileSync(path.join(ROOT, 'public', 'js', f), 'utf8');
  for (const f of ['plan-progress.js', 'open-points.js', 'agent-lanes.js', 'task-stop.js', 'workflow-lanes.js']) vm.runInContext(pub(f), sb, { filename: f });
  // the ⚙ painters and the split/count helpers, lifted by name — the same pieces the browser has from chat-render.js
  vm.runInContext([
    liftFn(RENDER_SRC, 'todoMark', 'public/js/chat-render.js'),
    liftDecl(RENDER_SRC, 'const', 'WF_MARKS', 'public/js/chat-render.js'),
    ...['wfMark', 'wfSecs', 'wfRowTitle', 'agentLaneSplit', 'agentLaneCounts', 'agentElapsed', 'agentStopParts',
      'workflowRows', 'workflowCounts', 'workflowCountLabel'].map((n) => liftFn(RENDER_SRC, n, 'public/js/chat-render.js')),
  ].join('\n'), sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat-side.js'), 'utf8'), sb, { filename: 'chat-side.js' });
  const fn = (n) => vm.runInContext(n, sb);
  const slot = ids['#chatSideSlot'];
  const groupOf = (cls) => slot.children.find((g) => g.classList.contains(cls)) || null;
  return { fn, ids, slot, groupOf, order: () => slot.children.map((g) => ['cside-plan', 'cside-workflow', 'cside-agents'].find((c) => g.classList.contains(c)) || '').filter(Boolean) };
}

// The plan's number is the POSITION of its current step since PF-1b (#92: `planCountText` → „Schritt n/N",
// c.index || c.done), no longer the count of done steps. With S1 done and S2 current it reads „2/3", after the
// next report (S2 done, S3 current) „3/3". What these tests guard is unchanged: each group keeps ITS number,
// the plan's never takes the run's and vice versa, through both repaints.
describe('U1 × PF-1 — a plan and a workflow on ONE tab (the combination the merge of #85 created)', () => {
  function both() {
    const { tab, pump } = runWith([PROBE_START]);
    Object.assign(tab, { id: 'c1', sessionId: 's1', streaming: true, _turnOpen: true, msgEl: new VmEl('div'), openPoints: [], hooks: [] });
    const w = planWorld(tab);
    w.fn('planSeen')(tab, 'toolu_PLAN', PLAN_MD, 'C:\\Users\\x\\.claude\\plans\\p.md');
    w.fn('planActivate')(tab, 'toolu_PLAN');
    w.fn('takePlanStatus')(tab, '```plan-status\n{"erledigt":["S1"],"aktuell":"S2"}\n```', null);
    return { tab, pump, w };
  }

  it('both groups, in the rail\'s order — plan first, the ⚙ run after it — each with its OWN count', () => {
    const { tab, w } = both();
    assert.equal(tab.plan && tab.plan.state, 'active', 'the plan did not get underway — the test proves nothing');
    w.fn('chatSideRefresh')(true);
    assert.deepEqual(w.order(), ['cside-plan', 'cside-workflow']);
    assert.equal(w.groupOf('cside-plan').querySelector('.cside-groupcount').textContent, '2/3');
    assert.equal(w.groupOf('cside-workflow').querySelector('.cside-groupcount').textContent, '0/2');
  });

  it('the collapsed strip keeps them apart: „1⚙" for the run, the plan on its own badge — and the rail opens', () => {
    const { w } = both();
    w.ids['#chatSide'].classList.add('collapsed');
    w.fn('chatSideRefresh')(true);
    assert.equal(w.ids['#chatSideCount'].textContent, '1⚙', 'the run, not a „🤖" and not the plan');
    assert.equal(w.ids['#chatSidePlan'].textContent, '2/3', 'the plan keeps its own badge (#85)');
    assert.ok(!w.ids['#chatSide'].classList.contains('collapsed'), 'a running workflow next to a live plan must open the rail');
  });

  it('the fan-out moves → the ⚙ group repaints on an UNFORCED refresh, and the plan group survives it', () => {
    const { pump, w } = both();
    w.fn('chatSideRefresh')(true);
    pump.feed(progressFrame(PROBE_A1_DONE));
    w.fn('chatSideRefresh')(false);
    assert.equal(w.groupOf('cside-workflow').querySelector('.cside-groupcount').textContent, '1/2', 'the run\'s change was swallowed by the plan\'s half of the signature');
    assert.equal(w.groupOf('cside-plan').querySelector('.cside-groupcount').textContent, '2/3', 'the repaint for the run lost the plan');
  });

  it('the plan moves → its group repaints, and the ⚙ group survives it', () => {
    const { tab, w } = both();
    w.fn('chatSideRefresh')(true);
    w.fn('takePlanStatus')(tab, '```plan-status\n{"erledigt":["S2"],"aktuell":"S3"}\n```', null);
    w.fn('chatSideRefresh')(false);
    assert.equal(w.groupOf('cside-plan').querySelector('.cside-groupcount').textContent, '3/3');
    assert.equal(w.groupOf('cside-workflow').querySelector('.cside-groupcount').textContent, '0/2', 'the repaint for the plan lost the run');
  });
});
