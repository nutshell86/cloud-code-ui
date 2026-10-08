'use strict';
// U1 / PR-12 — what the rail may say about a WORKFLOW run. Browser (classic script) AND Node
// (require'd by test/workflow-lanes.test.js). Dependency-free, side-effect-free, no DOM, no t():
// the painting stays in chat-render.js / chat-side.js, the decisions live here so they are testable.
// Sibling of agent-lanes.js and deliberately NOT inside it: a workflow lane carries a whole fan-out,
// and the one rule that matters here ("läuft noch ODER abgebrochen") has no counterpart there.
//
// ---------------------------------------------------------------------------------------------------
//  WHERE THE PROGRESS COMES FROM — and why it is NOT journal.jsonl
// ---------------------------------------------------------------------------------------------------
// The brief for this change, and docs/messung-2026-10-02.md line 130, both say the progress is "aus dem
// Strom allein nicht lesbar" and the rail must read `<transcriptDir>/journal.jsonl`. MEASURED AGAINST THE
// TWO PAID RECORDINGS, THAT IS WRONG (the record now carries a correction note next to that line).
// `system/task_progress` carries `workflow_progress[]`, and it carries everything this rail shows:
//   paid-2026-10-02T19-55-29-267Z  7 task_progress frames, 7 WITH workflow_progress
//   paid-2026-10-02T20-40-26-939Z  8 task_progress frames, 7 with it, ONE WITHOUT (_seq 48)
// Two entry kinds, both with a `type` discriminator:
//   {type:'workflow_phase', index, title}                                        — 86 of 86 have exactly these 3 keys
//   {type:'workflow_agent', index, label, phaseIndex, phaseTitle, agentId, model, state, startedAt,
//    lastProgressAt, promptPreview, resultPreview, …}                            — always present, 175 of 175
// Counted over the 38 `<session>/workflows/wf_*.json` state files on this machine (2026-10-03), which
// persist the SAME array under `workflowProgress`: 175 agent entries, 86 phase entries.
// Sometimes present: queuedAt/attempt/promptFramed/tokens/toolCalls/durationMs (166), lastToolName (158),
// lastToolSummary (122), cached (9), agentType (8), lastAttemptReason (1).
// public/js/task-stop.js stopTaskScope() already knew this ("its agents exist only inside
// task_progress.workflow_progress[]") — the field was described in a comment and read by nobody.
//
// So: no new route, no path gate, no second file-reading case, and nothing that can be stale. The ONE
// thing the stream has that no file has is the one thing this feature is about — see wfAgentState.
//
// ---------------------------------------------------------------------------------------------------
//  THE RULE THIS MODULE EXISTS FOR
// ---------------------------------------------------------------------------------------------------
// `state` has exactly THREE measured values, and the third one was nearly missed — the correction is
// written down here because of how cheap it was to get wrong:
//   'start'    both paid recordings; 6× in the 226-frame recording of 2026-10-01
//   'progress' 19× in that recording — and ZERO times in the two paid runs (their agents went
//              start→done inside a second) and zero times in the 38 state files (those persist the FINAL
//              snapshot, so everything in them is 'done'). Measuring only those two sources would have
//              made this module call a perfectly healthy, working agent „unbekannter Zustand: progress".
//              docs/ideas.md U1 had it right; the second source is what proved it.
//   'done'     175 of 175 state-file entries, 5× in that recording, plus both paid runs.
// There is no word for "failed" and none for "aborted", and the files cannot tell a dead agent from a
// working one (messung-journal-2026-10-03.md: same last record type either way). Therefore an agent that
// is still 'start'/'progress' when the workflow TASK has ended is reported as "läuft noch oder
// abgebrochen" — both, in one sentence, because the data says exactly that much.
// A FOURTH state word is NOT interpreted: it is shown verbatim as "unbekannter Zustand: <wort>", the same
// rule mcp-live.js uses for an unknown status.
// What makes any of this possible is that the liveness comes from the RUNNING PROCESS (the lane's own
// status, written by task_updated/task_notification/background_tasks_changed in agent-lanes.js) and not
// from the presence of a file.

// The two `type` discriminators of a workflow_progress entry, and the three measured `state` words.
var WF_PHASE = 'workflow_phase';
var WF_AGENT = 'workflow_agent';
// Both words mean „this agent has not reported an end". The rail does not spend a word on the difference
// (a 220px row has none to spare) but the raw word travels to the tooltip, so it is not lost either.
var WF_STATES_RUNNING = ['start', 'progress'];
var WF_STATE_DONE = 'done';         // measured 175/175 in the state files, and on both streams

function wfNum(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
function wfStr(v) { return (v == null) ? '' : String(v); }
// Is this lane a workflow run rather than one subagent? Same question, same answer as
// task-stop.js stopTaskScope() — `task_type: 'local_workflow'`, which task_started reports.
function wfIsWorkflow(a) { return !!(a && a.taskType === 'local_workflow'); }

// ---- the launch receipt --------------------------------------------------------------------------
// The Workflow tool answers its own call with a START RECEIPT, exactly like a backgrounded Agent does.
// Measured over all 51 Workflow calls in the local corpus: 49 receipts with these EIGHT keys and nothing
// else — status · taskId · taskType · workflowName · runId · summary · transcriptDir · scriptPath —
// and one answer that is a plain STRING ("Error: Invalid workflow script: …"), i.e. a refused launch.
// Before this, agent-lanes.js laneToolResult() read `out.taskId` into `a.remoteTaskId` — a field whose
// own comment says "remote_launched: a CLOUD id, not task_id", which is the wrong meaning for a local
// workflow, and which nothing in the panel ever read. runId/transcriptDir/workflowName/scriptPath were
// dropped on the floor.
// `transcriptDir` is carried but NOT displayed by this change: it is the handle PR-13 (the cost brake)
// needs, and cost is explicitly not this change's business.
function wfApplyLaunch(a, out) {
  if (!a || !out || typeof out !== 'object') return false;
  var changed = false;
  var set = function (k, v) { if (v && a[k] !== v) { a[k] = v; changed = true; } };
  set('wfRunId', wfStr(out.runId));
  set('wfName', wfStr(out.workflowName));
  set('wfTranscriptDir', wfStr(out.transcriptDir));   // → PR-13 reads the agent transcripts under here
  set('wfScriptPath', wfStr(out.scriptPath));
  return changed;
}

// ---- the progress array -------------------------------------------------------------------------
// Merge ONE `workflow_progress` array onto the lane. Three properties, each of them a bug that was
// available here:
//  1. A frame WITHOUT the array must not wipe what we know, and this is not a rare case: 1 of the 8
//     task_progress frames of the second paid run carries no `workflow_progress` — and in the 226-frame
//     recording of 2026-10-01 it is **21 of 32**. Replacing on every frame would have blanked the whole
//     rail two frames out of three.
//  2. Entries are identified by `index`, never by their position in the array. Measured: `index` is
//     present on 175/175 agent entries, unique within a run in 38/38 runs, and unique within every one of
//     the 11 snapshots of the 2026-10-01 recording. The array is rewritten whole on every frame, so
//     position carries no identity. (`agentId` and `startedAt` would NOT do: both are missing on 2 of the
//     30 entries of that recording — an agent that is still queued has neither.)
//  3. An agent whose `phaseIndex` names no phase we have seen is KEPT, in a bucket of its own. Measured
//     0 such entries in 38 runs — so this branch is defensive, and it is here because dropping a
//     measured agent is the mirror of inventing one.
function wfApplyProgress(a, list, now) {
  if (!a || !Array.isArray(list) || !list.length) return false;
  if (!a.wfPhases) a.wfPhases = [];
  if (!a.wfAgents) a.wfAgents = [];
  var t = (now || Date.now());
  var changed = false;
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (!e || typeof e !== 'object') continue;
    if (e.type === WF_PHASE) {
      var pi = wfNum(e.index);
      if (pi == null) continue;
      var p = null;
      for (var j = 0; j < a.wfPhases.length; j++) if (a.wfPhases[j].index === pi) p = a.wfPhases[j];
      if (!p) { a.wfPhases.push({ index: pi, title: wfStr(e.title) }); changed = true; continue; }
      if (wfStr(e.title) && p.title !== wfStr(e.title)) { p.title = wfStr(e.title); changed = true; }
      continue;
    }
    if (e.type !== WF_AGENT) continue;
    var ai = wfNum(e.index);
    if (ai == null) continue;
    var row = null;
    for (var k = 0; k < a.wfAgents.length; k++) if (a.wfAgents[k].index === ai) row = a.wfAgents[k];
    if (!row) { row = { index: ai, seen: t }; a.wfAgents.push(row); changed = true; }
    // Every field the entry carries, under its measured name. A field the frame does not carry is left
    // ALONE rather than cleared: the array is a snapshot and a later frame may simply not repeat a value.
    var copy = ['label', 'phaseIndex', 'phaseTitle', 'agentId', 'model', 'state', 'startedAt', 'queuedAt',
      'attempt', 'lastProgressAt', 'tokens', 'toolCalls', 'durationMs', 'resultPreview', 'promptPreview',
      'lastToolName', 'lastToolSummary', 'cached', 'agentType', 'lastAttemptReason'];
    for (var c = 0; c < copy.length; c++) {
      var f = copy[c];
      if (e[f] == null) continue;
      if (row[f] !== e[f]) { row[f] = e[f]; changed = true; }
    }
    row.seen = t;
  }
  return changed;
}

// The `system` frame hook. Called next to laneSystemEvent() (chat-render.js agentSystemEvent), not from
// inside it: agent-lanes.js has no dependencies and keeps none, and both halves stay separately testable.
// Returns true when the rail has to be rebuilt. A task_progress whose numbers merely moved reports
// `false` for the same reason agent-lanes.js does — the 1 s ticker writes those in place.
function wfSystemEvent(lanes, ev, now) {
  if (!Array.isArray(lanes) || !ev || ev.type !== 'system') return false;
  if (wfStr(ev.subtype) !== 'task_progress') return false;
  if (!Array.isArray(ev.workflow_progress) || !ev.workflow_progress.length) return false;
  var a = null;
  for (var i = 0; i < lanes.length; i++) {
    var L = lanes[i];
    if (!L) continue;
    if (ev.tool_use_id && L.id === ev.tool_use_id) { a = L; break; }
    if (ev.task_id && L.taskId === String(ev.task_id)) { a = L; break; }
  }
  if (!a) return false;
  // The frame is the proof that this lane is a workflow even if task_started's `task_type` never arrived:
  // nothing but a workflow run emits workflow_progress.
  if (!a.taskType) a.taskType = 'local_workflow';
  var before = wfSig(a);
  wfApplyProgress(a, ev.workflow_progress, now);
  return wfSig(a) !== before;
}

// ---- what one agent row may SAY ------------------------------------------------------------------
// -> { state, raw, cached }
//   'done'     the runtime said so.
//   'running'  the runtime said 'start' and the workflow task is still alive.
//   'open'     the runtime said 'start' and the workflow task is OVER → "läuft noch oder abgebrochen".
//              This is the whole point of the module: the two cannot be told apart, so the row says both.
//   'unknown'  a state word nobody has measured. Shown verbatim, never mapped onto one of the above.
// `taskOver` is a RUNTIME fact (the lane is no longer running), not the absence of a file.
function wfAgentState(row, taskOver) {
  var raw = wfStr(row && row.state);
  var cached = !!(row && row.cached);
  if (raw === WF_STATE_DONE) return { state: 'done', raw: raw, cached: cached };
  if (WF_STATES_RUNNING.indexOf(raw) >= 0) return { state: taskOver ? 'open' : 'running', raw: raw, cached: cached };
  return { state: 'unknown', raw: raw, cached: cached };
}

// How long this agent worked. BOTH timestamps come from the CLI's clock, so their DIFFERENCE is free of
// the clock skew that `Date.now() - startedAt` would carry (agent-lanes.js laneElapsedMs documents the
// same hazard for the lane's own ticker, which is browser-side and must stay that way).
//  · `durationMs` is the runtime's own figure and wins when it is there. Measured: present on 166 of 175
//    entries, and the 9 without it are EXACTLY the 9 with `cached: true` — a cached result never ran.
//  · otherwise `lastProgressAt - startedAt`, i.e. the age at the agent's last report. Up to one progress
//    interval (~2 s, measured) behind, and that is the honest price for not mixing two clocks.
//  · a cached entry gets no duration at all: null, so the renderer can say „aus dem Zwischenspeicher"
//    instead of printing a 0 that looks like a measurement.
// -> ms | null (nothing to say)
function wfAgentElapsedMs(row) {
  if (!row || row.cached) return null;
  var d = wfNum(row.durationMs);
  if (d != null) return Math.max(0, d);
  var s = wfNum(row.startedAt), l = wfNum(row.lastProgressAt);
  if (s == null || l == null) return null;
  return Math.max(0, l - s);
}

// Everything the rail may honestly say about one agent of the run. Absent stays absent — a number no
// frame carried is left undefined rather than zero-filled, exactly as laneMetrics does.
function wfAgentView(row, taskOver) {
  var st = wfAgentState(row, taskOver);
  var m = { index: row.index, state: st.state, raw: st.raw, label: wfStr(row.label) };
  if (st.cached) m.cached = true;
  if (row.phaseIndex != null) m.phaseIndex = wfNum(row.phaseIndex);
  if (row.phaseTitle) m.phase = wfStr(row.phaseTitle);
  if (row.agentId) m.agentId = wfStr(row.agentId);
  if (row.model) m.model = wfStr(row.model);
  if (row.agentType) m.agentType = wfStr(row.agentType);
  var el = wfAgentElapsedMs(row);
  if (el != null) m.elapsedMs = el;
  // „the runtime's own total" vs. „the age at its last report" — the renderer must not present the second
  // one as a duration, so which one it is travels with the number.
  if (el != null) m.elapsedFinal = wfNum(row.durationMs) != null;
  if (wfNum(row.tokens)) m.tokens = wfNum(row.tokens);
  if (wfNum(row.toolCalls)) m.toolCalls = wfNum(row.toolCalls);
  if (row.lastToolName) m.lastTool = wfStr(row.lastToolName);
  if (row.lastToolSummary) m.lastToolSummary = wfStr(row.lastToolSummary);
  if (row.resultPreview) m.result = wfStr(row.resultPreview);
  if (row.promptPreview) m.prompt = wfStr(row.promptPreview);
  // A RETRY is the one place the stream is thinner than the journal, and the row says so rather than
  // hiding it. Measured: `workflow_progress` collapses the attempts of one label into the LAST one
  // (38/38 runs: its length equals `agentCount`, and in 8 of 38 runs that is FEWER than the journal's
  // `started` records — wf_370eadee-715 keeps 6 of 9, dropping the first attempt of three labels).
  // `attempt` (observed 1 and 2) and `lastAttemptReason` (observed 'stalled') are what is left of the
  // replaced attempt, so they are shown; the replaced attempt's own numbers are NOT on the stream and
  // this view does not pretend to have them.
  if (wfNum(row.attempt) > 1) m.attempt = wfNum(row.attempt);
  if (row.lastAttemptReason) m.attemptReason = wfStr(row.lastAttemptReason);
  return m;
}

// The whole run, grouped by phase, in the order the phases appeared. `index` is the identity (unique in
// 38/38 runs); the ORDER comes from the order the frames introduced them, which is also ascending index
// in 38/38 runs — but reading the order off the array rather than off the number means a workflow that
// revisits a phase still draws in the order it really happened.
// -> { name, runId, transcriptDir, scriptPath, taskOver, phases: [{index,title,agents:[view]}],
//      counts: {total, done, running, open, unknown} }
function wfView(a) {
  var taskOver = !!(a && a.status && a.status !== 'running');
  var out = {
    name: wfStr(a && (a.wfName || a.desc)),
    runId: wfStr(a && a.wfRunId),
    transcriptDir: wfStr(a && a.wfTranscriptDir),
    scriptPath: wfStr(a && a.wfScriptPath),
    taskOver: taskOver,
    phases: [],
    counts: { total: 0, done: 0, running: 0, open: 0, unknown: 0 },
  };
  var phases = (a && a.wfPhases) || [];
  var rows = (a && a.wfAgents) || [];
  var byIdx = {}, order = [];
  for (var i = 0; i < phases.length; i++) {
    var p = phases[i];
    if (!p || byIdx[p.index]) continue;
    byIdx[p.index] = { index: p.index, title: p.title, agents: [] };
    order.push(byIdx[p.index]);
  }
  // Agents in the order the frames list them (= start order within a phase: `index` ascends with the
  // start, measured). A phase nobody announced gets created from the agent's own `phaseTitle` rather
  // than swallowing the agent — 0 such cases measured, and this is the branch that keeps it that way.
  for (var k = 0; k < rows.length; k++) {
    var v = wfAgentView(rows[k], taskOver);
    var pi = (v.phaseIndex == null) ? 0 : v.phaseIndex;
    if (!byIdx[pi]) { byIdx[pi] = { index: pi, title: v.phase || '', agents: [], unannounced: true }; order.push(byIdx[pi]); }
    byIdx[pi].agents.push(v);
    out.counts.total++;
    out.counts[v.state] = (out.counts[v.state] || 0) + 1;
  }
  out.phases = order;
  return out;
}

// Repaint signature. STRUCTURAL only — the live numbers (tokens, tool calls, the age at the last report)
// are written in place by the ticker, exactly as lanesSig() leaves them out: the runtime emits a
// task_progress roughly every two seconds per agent and a rebuild per frame would flicker the rail.
// `taskOver` IS structural: it is what flips every unfinished row from „läuft" to „läuft noch oder
// abgebrochen", and that is a change of sentence, not of a number.
function wfSig(a) {
  if (!a) return '';
  var rows = a.wfAgents || [];
  var parts = [wfStr(a.wfRunId), (a.status === 'running' ? 'live' : 'over'), String((a.wfPhases || []).length)];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    parts.push([r.index, wfStr(r.state), wfStr(r.label), wfStr(r.phaseIndex), r.cached ? 'c' : '',
      wfNum(r.attempt) > 1 ? 'a' + r.attempt : '', r.resultPreview ? 'r' : ''].join(':'));
  }
  return parts.join('|');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    WF_PHASE, WF_AGENT, WF_STATES_RUNNING, WF_STATE_DONE,
    wfIsWorkflow, wfApplyLaunch, wfApplyProgress, wfSystemEvent,
    wfAgentState, wfAgentElapsedMs, wfAgentView, wfView, wfSig,
  };
}
