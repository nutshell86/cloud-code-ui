'use strict';
// verify: serial
// G6 — stopping ONE lane of the agent rail (`stop_task {task_id}`). What this suite is about: the button
// may report that a stop was REQUESTED, and it may only say „gestoppt" when the CLI itself said so.
//
// Why that distinction is load-bearing rather than pedantic — read out of claude 2.1.288 (`YLe`):
// `stop_task` answers `success` with an empty payload AFTER the kill really ran, but TWO refusals are
// deliberately smoothed into that same success: `not_found` (when a stop marker could be persisted) and
// `not_running` with a terminal task status. A task that finished by itself a moment before the click
// therefore answers exactly like one that was killed. The only honest confirmation is the CLI's own
// `task_updated {patch.status:'killed'}` / `task_notification {status:'stopped'}`.
//
// Three layers: the decisions (public/js/task-stop.js, pure), the VISIBLE half (chat-render.js, lifted out
// of the source — the half that was untested when a one-word rename once made a feature mute), and end to
// end over the real engine, where the kill frames really come off a process.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  stopTaskTarget, stopRetryable, stopTaskScope, stopTaskMark, stopTaskFailed, stopView, stopSig,
  STOP_CONFIRM_MS, STOP_KILL_STATUS,
} = require('../public/js/task-stop');
// The refusal sentences the CLI really puts on the wire — `o.message`, with NO `StopTask: <code>` prefix
// (that is the StopTaskError telemetry argument). Pinned here as constants because a fake that invents a
// prefix is how the previous round's end-to-end test came to confirm a parser that never fired in production.
const REFUSAL_NOT_FOUND = 'No task found with ID: ';
const REFUSAL_NOT_OWNER = 'Task task_1 is owned by sub-agent';
const { laneStart, laneSystemEvent, laneMetrics, lanesSig, laneFinish } = require('../public/js/agent-lanes');

const ROOT = path.join(__dirname, '..');
const RENDER_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat-render.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function liftFn(src, name, rel) {
  const m = new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm').exec(src);
  assert.ok(m, name + '() not found in ' + rel + ' — renamed or reindented? Then these tests prove nothing.');
  return m[0];
}
function bundle(pieces, names, env) {
  const keys = Object.keys(env);
  return new Function(...keys, pieces.join('\n') + '\nreturn { ' + names.join(', ') + ' };')(...keys.map((k) => env[k]));
}
const tt = (k) => k;
const fakeEl = (tag, cls, txt) => ({
  tag, className: cls || '', textContent: txt == null ? '' : txt, title: '', type: '', disabled: false,
  attrs: {}, children: [], onclick: null,
  appendChild(c) { this.children.push(c); return c; },
  setAttribute(k, v) { this.attrs[k] = v; },
});
function recorder() { const got = []; const f = (...a) => got.push(a); f.got = got; return f; }
function fakeApi(answer) {
  const calls = [];
  const api = (url, opts) => {
    calls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null });
    const r = answer(url, opts);
    return (r instanceof Error) ? Promise.reject(r) : Promise.resolve(r);
  };
  api.calls = calls;
  return api;
}
// A running BACKGROUND lane with a task_id, built the way the frames build it (not hand-assembled): the
// Agent tool_use opens it, task_started gives it the id.
function liveLane(now) {
  const lanes = [];
  laneStart(lanes, { id: 'toolu_1', input: { subagent_type: 'Explore', description: 'Langläufer', run_in_background: true } }, now);
  laneSystemEvent(lanes, { type: 'system', subtype: 'task_started', tool_use_id: 'toolu_1', task_id: 'task_1', description: 'Langläufer', is_backgrounded: true, task_type: 'local_agent' }, now);
  return lanes[0];
}

describe('task-stop — may this lane be stopped, and with which id', () => {
  it('a running lane with a task_id is stoppable', () => {
    assert.deepEqual(stopTaskTarget(liveLane(1000)), { ok: true, taskId: 'task_1' });
  });

  it('a lane that has no task_id YET is not — and that window is real, not theoretical', () => {
    // laneStart runs from the Agent tool_use in the assistant frame, BEFORE any task_* frame. stop_task
    // takes exactly one argument, so there is nothing to fall back on: the button must be disabled, never
    // fired with a guess (which would stop somebody else's task).
    const lanes = [];
    laneStart(lanes, { id: 'toolu_x', input: { subagent_type: 'Explore', description: 'frisch' } }, 1000);
    assert.deepEqual(stopTaskTarget(lanes[0]), { ok: false, reason: 'no-task-id' });
  });

  it('a finished lane is not stoppable', () => {
    const a = liveLane(1000);
    laneFinish(a, { at: 2000 });
    assert.equal(stopTaskTarget(a).reason, 'not-running');
  });

  it('a pending stop is not fired twice — but a REFUSED one may be retried', () => {
    const a = liveLane(1000);
    stopTaskMark(a, 1000);
    assert.equal(stopTaskTarget(a, 1500).reason, 'already', 'a second request could only earn the smoothed not_found success');
    stopTaskFailed(a, REFUSAL_NOT_OWNER, 1100);
    assert.equal(stopTaskTarget(a, 1500).ok, true, 'the refusal may have been about a state that has since changed');
  });

  it('an UNCONFIRMED stop may be retried — the one state the whole button exists for', () => {
    // The lock used to be `a.stopAt && !a.stopError`, and NOTHING anywhere resets `stopAt`. So a stop that
    // was answered (or whose answer timed out into `{ok:true, unconfirmed:true}`) and that no frame ever
    // confirmed locked the lane for good — while `status` is still 'running', i.e. precisely when the agent
    // may well still be working. All that was left then was the turn interrupt, which under the absence rule
    // takes every background agent down with it.
    const a = liveLane(1000);
    stopTaskMark(a, 2000);
    assert.equal(stopTaskTarget(a, 2000 + STOP_CONFIRM_MS - 1).reason, 'already', 'inside the window the first request still owns the lane');
    assert.equal(stopView(a, 2000 + STOP_CONFIRM_MS).state, 'unconfirmed');
    assert.equal(stopTaskTarget(a, 2000 + STOP_CONFIRM_MS).ok, true, 'the row says „unbestätigt" — then it must offer a way out');
    assert.equal(stopRetryable(a, 2000 + STOP_CONFIRM_MS), true);
    // …and a retry starts the window over, so the row goes back to „angefordert" instead of flickering
    stopTaskMark(a, 30000);
    assert.equal(stopView(a, 30100).state, 'pending');
    assert.equal(stopTaskTarget(a, 30100).reason, 'already');
  });

  it('a workflow lane says it stops the WHOLE workflow', () => {
    // Measured: a workflow carries ONE task_id for its whole fan-out, its agents exist only inside
    // task_progress.workflow_progress[] with an agentId and no task_id of their own.
    const lanes = [];
    laneStart(lanes, { id: 'tu', input: { description: 'Workflow' } }, 1000);
    laneSystemEvent(lanes, { type: 'system', subtype: 'task_started', tool_use_id: 'tu', task_id: 'wf1', description: 'Workflow', task_type: 'local_workflow' }, 1000);
    assert.equal(stopTaskScope(lanes[0]), 'workflow');
    assert.equal(stopTaskScope(liveLane(1000)), 'agent');
  });
});

describe('task-stop — what the row may SAY (the five answers)', () => {
  it('no stop requested → nothing is said', () => {
    assert.deepEqual(stopView(liveLane(1000), 1000), { state: 'none' });
  });

  it('a fresh request says „angefordert" — not „gestoppt"', () => {
    const a = liveLane(1000);
    stopTaskMark(a, 2000);
    assert.equal(stopView(a, 2500).state, 'pending');
    assert.equal(stopView(a, 2500).key, 'chat-render.agentStoppLaeuft');
  });

  it('a request that nothing ever confirmed becomes UNBESTÄTIGT on the clock', () => {
    // This is the heart of it: `success` is also the answer for a task nobody could find, so „nothing
    // changed" may not keep looking like „läuft gerade".
    const a = liveLane(1000);
    stopTaskMark(a, 2000);
    assert.equal(stopView(a, 2000 + STOP_CONFIRM_MS).state, 'unconfirmed');
    assert.notEqual(stopView(a, 2000 + STOP_CONFIRM_MS).state, 'stopped');
  });

  it('only a kill the CLI REPORTED may read „gestoppt"', () => {
    const a = liveLane(1000);
    stopTaskMark(a, 2000);
    laneSystemEvent([a], { type: 'system', subtype: 'task_updated', task_id: 'task_1', patch: { status: 'killed', end_time: 9 } }, 2100);
    assert.equal(a.endStatus, 'killed');
    assert.equal(stopView(a, 2200).state, 'stopped');
    assert.deepEqual(STOP_KILL_STATUS, ['killed', 'stopped'], "'failed' is NOT one of them: an agent that died of its own error was not stopped");
  });

  it('the notification wording of the recorded interrupt run („stopped") counts too', () => {
    const a = liveLane(1000);
    stopTaskMark(a, 2000);
    laneSystemEvent([a], { type: 'system', subtype: 'task_notification', tool_use_id: 'toolu_1', task_id: 'task_1', status: 'stopped', summary: 'Vom Benutzer gestoppt' }, 2100);
    assert.equal(stopView(a, 2200).state, 'stopped');
  });

  it('…but a „stopped" with a `reason` is NOT a confirmed kill — worker_restart is an orphan, not a stop', () => {
    // The schema's own words for task_notification.reason: „Machine-readable cause, set only when the task
    // did not end through an ordinary completion, failure, or stop. 'worker_restart': the worker process
    // restarted and the resumed process found the task orphaned (always with status 'stopped')". So the one
    // green chip of this feature was reachable by an end nobody asked for.
    const a = liveLane(1000);
    stopTaskMark(a, 2000);
    laneSystemEvent([a], { type: 'system', subtype: 'task_notification', tool_use_id: 'toolu_1', task_id: 'task_1', status: 'stopped', reason: 'worker_restart' }, 2100);
    assert.equal(a.endStatus, 'stopped', 'the status still arrived — it is just not evidence on its own');
    assert.equal(a.endReason, 'worker_restart', 'and the reason has to reach the lane, or nothing can tell the two apart');
    assert.equal(stopView(a, 2200).state, 'ended', 'the state that exists for exactly this uncertainty');
    assert.equal(stopView(a, 2200).key, 'chat-render.agentStoppEnde');
    assert.equal(laneMetrics(a, 2200).endReason, 'worker_restart');
  });

  it('a reason this build does not know disqualifies the green chip as well', () => {
    // 'worker_restart' is the only declared value today. Hard-coding it would make the next extraordinary
    // cause read as a confirmed kill by default — the same rule as an undeclared MCP status word, which is
    // treated as „nobody told us" rather than mapped onto a position (mcp-live.js mcpStatusRows).
    const a = liveLane(1000);
    stopTaskMark(a, 2000);
    laneSystemEvent([a], { type: 'system', subtype: 'task_notification', task_id: 'task_1', status: 'stopped', reason: 'host_evicted' }, 2100);
    assert.equal(stopView(a, 2200).state, 'ended');
  });

  it('a lane that merely ENDED after the click says so — and does not claim the stop did it', () => {
    // The background list only drops the id; agent-lanes closes such a lane as a plain „beendet". Reading
    // that as „gestoppt" would be a claim, reading it as „läuft" would be stale. Hence a state of its own.
    const a = liveLane(1000);
    stopTaskMark(a, 2000);
    // the lane has to have been IN the list before the list can close it (agent-lanes.js: a lane never seen
    // in it can never be closed by it) — so this is the real two-frame sequence
    laneSystemEvent([a], { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'task_1', task_type: 'local_agent', description: 'Langläufer' }] }, 2050);
    laneSystemEvent([a], { type: 'system', subtype: 'background_tasks_changed', tasks: [] }, 2100);
    assert.equal(a.status, 'done');
    assert.equal(a.endStatus, undefined, 'nothing told us HOW it ended');
    assert.equal(stopView(a, 2200).state, 'ended');
    assert.equal(stopView(a, 2200).key, 'chat-render.agentStoppEnde');
  });

  it('a refusal carries the CLI\'s own sentence, verbatim and unparsed', () => {
    // There is no machine-readable code on the wire: `new StopTaskError(<sentence>, <code>)` puts the code
    // into `telemetryMessage` (base class TelemetrySafeError), and the control answer carries `o.message`.
    // So what the row has to show is the sentence — unshortened, unclassified, exactly as it arrived.
    const a = liveLane(1000);
    stopTaskFailed(a, 'Task task_1 is not running (status: completed)', 2000);
    const v = stopView(a, 2100);
    assert.equal(v.state, 'refused');
    assert.equal(v.error, 'Task task_1 is not running (status: completed)');
    assert.equal(v.code, undefined, 'a code field would have to be guessed out of prose — and nothing reads it');
  });

  it('a refusal nobody has a name for is still shown as it came', () => {
    // The validation refusal and the bridge-lane refusal are neither of the five documented cases. Under the
    // old parser they produced code '' and the sentence; now there is only ever the sentence, so these are
    // not a special case any more — which is the point of dropping the classifier.
    for (const sentence of ['stop_task: task_id must be a string',
      'stop_task is not supported in this context (callback not registered)']) {
      const a = liveLane(1000);
      stopTaskFailed(a, sentence, 2000);
      assert.equal(stopView(a, 2100).error, sentence);
    }
    const empty = liveLane(1000);
    stopTaskFailed(empty, '', 2000);
    assert.equal(stopView(empty, 2100).error, 'refused', 'an error with no text still has to say that it WAS refused');
  });

  it('marking a stop NEVER ends the lane — laneFinish stays the only thing that does', () => {
    const a = liveLane(1000);
    stopTaskMark(a, 2000);
    assert.equal(a.status, 'running', 'a row reading „gestoppt" the moment the button is pressed is the bug');
    assert.equal(a.end, undefined);
    stopTaskFailed(a, REFUSAL_NOT_OWNER, 2100);
    assert.equal(a.status, 'running');
  });

  it('laneMetrics carries the stop so the rail and the detail view cannot disagree', () => {
    const a = liveLane(1000);
    stopTaskMark(a, 2000);
    let m = laneMetrics(a, 2100);
    assert.equal(m.stopAt, 2000);
    assert.equal(m.status, 'running', 'still not a status');
    assert.equal(m.taskType, 'local_agent');
    stopTaskFailed(a, REFUSAL_NOT_OWNER, 2100);
    m = laneMetrics(a, 2200);
    assert.equal(m.stopError, REFUSAL_NOT_OWNER, 'the CLI\'s sentence — there is no code on the wire to carry');
  });

  it('the rail signature changes when a stop is requested, refused, or an id arrives', () => {
    const a = liveLane(1000);
    const base = lanesSig([a]);
    stopTaskMark(a, 2000);
    const afterMark = lanesSig([a]);
    assert.notEqual(afterMark, base, 'the ⏹ button disappears — that is a structural change');
    stopTaskFailed(a, REFUSAL_NOT_OWNER, 2100);
    assert.notEqual(lanesSig([a]), afterMark);
    // …and the id itself: the button is dead without one, so the row MUST be rebuilt when it arrives
    const lanes = [];
    laneStart(lanes, { id: 'tu2', input: { description: 'frisch' } }, 1000);
    const noId = lanesSig(lanes);
    lanes[0].taskId = 'late';
    assert.notEqual(lanesSig(lanes), noId);
  });

  it('a lane getting its task_id from the BACKGROUND LIST reports a repaint', () => {
    // Measured ordering: background_tasks_changed arrives BEFORE task_started (frames _seq 40 / 41). The
    // join sets the id but closes nothing — and „nothing changed" is the word the repaint is skipped on, so
    // the ⏹ button stayed dead until some unrelated frame rebuilt the rail.
    const lanes = [];
    laneStart(lanes, { id: 'tu3', input: { description: 'Protokollsonde' } }, 1000);
    const changed = laneSystemEvent(lanes, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'wze3xxa0b', task_type: 'local_workflow', description: 'Protokollsonde' }] }, 1100);
    assert.equal(lanes[0].taskId, 'wze3xxa0b');
    assert.equal(changed, true, 'the id is the one argument stop_task takes — learning it IS structural');
  });

  it('stopSig only tracks lanes with a stop, and follows the pending → unconfirmed flip', () => {
    const a = liveLane(1000), b = liveLane(1000);
    b.id = 'toolu_2'; b.taskId = 'task_2';
    assert.equal(stopSig([a, b], 2000), '', 'no stop anywhere → nothing for the ticker to repaint');
    stopTaskMark(a, 2000);
    assert.equal(stopSig([a, b], 2500), 'toolu_1:pending');
    assert.equal(stopSig([a, b], 2000 + STOP_CONFIRM_MS), 'toolu_1:unconfirmed', 'this is the transition no frame announces');
  });
});

// =====================================================================================================
describe('the VISIBLE half — chat-render.js may not claim a stop it did not get', () => {
  const env = (over) => Object.assign({
    tt, el: fakeEl, api: null, toast: recorder(), agentRepaint: recorder(),
    stopTaskTarget, stopTaskScope, stopTaskMark, stopTaskFailed, stopView, stopSig,
  }, over || {});
  const loadParts = (e) => bundle([liftFn(RENDER_SRC, 'agentStopParts', 'public/js/chat-render.js')], ['agentStopParts'], e).agentStopParts;
  const loadClick = (e) => bundle([liftFn(RENDER_SRC, 'agentStopClick', 'public/js/chat-render.js')], ['agentStopClick'], e).agentStopClick;

  it('a running lane with an id gets an ENABLED ⏹', () => {
    const parts = loadParts(env())(liveLane(1000), { id: 'c1' });
    const btn = parts.find((p) => p.tag === 'button');
    assert.ok(btn, 'no stop button at all');
    assert.equal(btn.disabled, false);
    assert.equal(btn.textContent, '⏹');
    assert.equal(btn.title, 'chat-render.agentStoppTooltip');
  });

  it('…and a lane WITHOUT a task_id gets a disabled one that says why', () => {
    const lanes = [];
    laneStart(lanes, { id: 'tu', input: { description: 'frisch' } }, 1000);
    const btn = loadParts(env())(lanes[0], { id: 'c1' }).find((p) => p.tag === 'button');
    assert.equal(btn.disabled, true);
    assert.equal(btn.title, 'chat-render.agentStoppKeineId');
  });

  it('a workflow lane is labelled as stopping the whole workflow', () => {
    const lanes = [];
    laneStart(lanes, { id: 'tu', input: { description: 'Workflow' } }, 1000);
    laneSystemEvent(lanes, { type: 'system', subtype: 'task_started', tool_use_id: 'tu', task_id: 'wf', description: 'Workflow', task_type: 'local_workflow' }, 1000);
    const btn = loadParts(env())(lanes[0], { id: 'c1' }).find((p) => p.tag === 'button');
    assert.equal(btn.title, 'chat-render.agentStoppWorkflowTooltip');
  });

  it('after a request the button is gone and a chip says „angefordert"', () => {
    const a = liveLane(1000);
    stopTaskMark(a, Date.now());
    const parts = loadParts(env())(a, { id: 'c1' });
    assert.equal(parts.filter((p) => p.tag === 'button').length, 0, 'a second request could only earn a smoothed success');
    const chip = parts.find((p) => /agent-stopnote/.test(p.className));
    assert.equal(chip.textContent, 'chat-render.agentStoppLaeuft');
    assert.match(chip.className, /wait/);
  });

  it('a confirmed kill is the ONLY green chip; an unconfirmed one is red', () => {
    const a = liveLane(1000);
    stopTaskMark(a, Date.now());
    laneSystemEvent([a], { type: 'system', subtype: 'task_updated', task_id: 'task_1', patch: { status: 'killed' } }, Date.now());
    let chip = loadParts(env())(a, { id: 'c1' }).find((p) => /agent-stopnote/.test(p.className));
    assert.equal(chip.textContent, 'chat-render.agentStoppBestaetigt');
    assert.match(chip.className, /ok/);

    const b = liveLane(1000);
    stopTaskMark(b, Date.now() - STOP_CONFIRM_MS - 1);
    chip = loadParts(env())(b, { id: 'c1' }).find((p) => /agent-stopnote/.test(p.className));
    assert.equal(chip.textContent, 'chat-render.agentStoppUnbestaetigt');
    assert.match(chip.className, /bad/);
  });

  it('an UNCONFIRMED stop gets its ⏹ back — the chip stays, the way out returns', () => {
    // The row says „Stopp unbestätigt" over a lane that is still `running`, i.e. an agent that may well be
    // working. Without a button there the only remaining lever is the turn interrupt, which takes every
    // background agent with it — so the one case this whole feature was built for ended in the tool it was
    // built to replace.
    const a = liveLane(1000);
    stopTaskMark(a, Date.now() - STOP_CONFIRM_MS - 1);
    const parts = loadParts(env())(a, { id: 'c1' });
    const btn = parts.find((p) => p.tag === 'button');
    assert.ok(btn, 'no way to try again on a stop that was never confirmed');
    assert.equal(btn.disabled, false);
    const chip = parts.find((p) => /agent-stopnote/.test(p.className));
    assert.equal(chip.textContent, 'chat-render.agentStoppUnbestaetigt', 'and it still says so — the button is not a reset');
  });

  it('a REFUSED stop gets its ⏹ back too, with the refusal still on the row', () => {
    const a = liveLane(1000);
    stopTaskFailed(a, REFUSAL_NOT_OWNER, Date.now());
    const parts = loadParts(env())(a, { id: 'c1' });
    assert.equal(parts.filter((p) => p.tag === 'button').length, 1);
    const chip = parts.find((p) => /agent-stopnote/.test(p.className));
    assert.equal(chip.textContent, 'chat-render.agentStoppAbgelehnt');
    assert.equal(chip.title, REFUSAL_NOT_OWNER, 'the CLI\'s own sentence is the tooltip — it is all there is');
  });

  it('a PENDING stop keeps its button hidden — the chip next to it already says „angefordert"', () => {
    const a = liveLane(1000);
    stopTaskMark(a, Date.now());
    assert.equal(loadParts(env())(a, { id: 'c1' }).filter((p) => p.tag === 'button').length, 0);
  });

  it('a „stopped" caused by a worker restart is NOT the green chip', () => {
    const a = liveLane(1000);
    stopTaskMark(a, Date.now());
    laneSystemEvent([a], { type: 'system', subtype: 'task_notification', task_id: 'task_1', status: 'stopped', reason: 'worker_restart' }, Date.now());
    const chip = loadParts(env())(a, { id: 'c1' }).find((p) => /agent-stopnote/.test(p.className));
    assert.equal(chip.textContent, 'chat-render.agentStoppEnde');
    assert.doesNotMatch(chip.className, /\bok\b/, 'green means „the CLI confirmed this kill", and it did not');
  });

  it('the button stops the click from opening the detail sidecar, and then stops the lane', () => {
    const a = liveLane(1000);
    const e = env({ agentStopClick: recorder() });
    const btn = loadParts(e)(a, { id: 'c1' }).find((p) => p.tag === 'button');
    let stopped = false;
    // the row's own handler is `it.onclick = () => agentDetailShow(...)`; without stopPropagation this
    // button would fire that too, i.e. open a panel while stopping an agent
    btn.onclick({ stopPropagation: () => { stopped = true; }, preventDefault: () => {} });
    assert.equal(stopped, true);
    assert.equal(e.agentStopClick.got.length, 1, 'and it really reaches the handler');
  });

  it('a disabled button fires nothing even if a browser lets the click through', () => {
    const lanes = [];
    laneStart(lanes, { id: 'tu', input: { description: 'frisch' } }, 1000);
    const e = env({ agentStopClick: () => assert.fail('no stop may go out without a task_id') });
    const btn = loadParts(e)(lanes[0], { id: 'c1' }).find((p) => p.tag === 'button');
    btn.onclick({ stopPropagation: () => {}, preventDefault: () => {} });
  });

  it('agentStopClick: posts ONLY stop-task — and nothing of the interrupt path', async () => {
    const a = liveLane(1000);
    const e = env({ api: fakeApi(() => ({ ok: true, taskId: 'task_1' })) });
    await loadClick(e)(a, { id: 'c1', agents: [a] });
    assert.equal(e.api.calls.length, 1);
    assert.equal(e.api.calls[0].url, '/api/chat/c1/stop-task');
    assert.deepEqual(e.api.calls[0].body, { taskId: 'task_1' }, 'task_id is the only field the CLI takes');
    assert.ok(a.stopAt, 'the lane records that a stop was asked for');
    assert.equal(a.status, 'running', 'and nothing pretends it worked');
    assert.deepEqual(e.toast.got, [], 'no green „gestoppt": success is also what a vanished task answers');
  });

  it('…and the source does not reach for the interrupt machinery (CHAT-FLOW-9)', () => {
    // A shared path once deleted the queue along with the turn. This button must not inherit any of it.
    const src = liftFn(RENDER_SRC, 'agentStopClick', 'public/js/chat-render.js');
    for (const forbidden of ['interrupt', 'clearQueue', 'agentsAborted', 'retirePlanCards', 'clearAsksForTab']) {
      assert.doesNotMatch(src, new RegExp('\\b' + forbidden + '\\b'), 'the per-lane stop must not use ' + forbidden);
    }
  });

  it('agentStopClick: an unanswered stop_task is a sticky error, not silence', async () => {
    const a = liveLane(1000);
    const e = env({ api: fakeApi(() => ({ ok: true, taskId: 'task_1', unconfirmed: true })) });
    await loadClick(e)(a, { id: 'c1', agents: [a] });
    assert.equal(e.toast.got[0][1], 'err');
    assert.match(e.toast.got[0][0], /agentStoppOhneAntwort/);
  });

  it('agentStopClick: a refusal lands ON the lane, not only in a toast', async () => {
    const a = liveLane(1000);
    const e = env({ api: fakeApi(() => new Error(REFUSAL_NOT_OWNER)) });
    await loadClick(e)(a, { id: 'c1', agents: [a] });
    // the toast is gone in four seconds, „why is this still running" is not — so the SENTENCE has to survive
    // on the lane. It is the whole refusal: the wire carries no code next to it.
    assert.equal(a.stopError, REFUSAL_NOT_OWNER);
    assert.equal(stopView(a, Date.now()).state, 'refused');
    assert.equal(e.toast.got[0][1], 'err');
    assert.match(e.toast.got[0][0], new RegExp(REFUSAL_NOT_OWNER));
  });

  it('agentStopClick: a tab without a session asks nothing', async () => {
    const a = liveLane(1000);
    const e = env({ api: fakeApi(() => assert.fail('nothing to stop without a chat id')) });
    await loadClick(e)(a, {});
    assert.equal(e.toast.got[0][0], 'chat-render.agentStoppKeineSitzung');
    assert.equal(a.stopAt, undefined);
  });

  it('agentRows() really renders the parts — the wiring, not a copy of it', () => {
    // This is the guard against the failure that produced this rule: a tested builder nobody calls. A
    // one-word rename in agentRows would make the button vanish with every other test still green.
    assert.match(RENDER_SRC, /agentStopParts\(a, ACTIVE\)\.forEach\(/);
    // …and the ticker has to watch the clock-driven flip, because no frame announces it
    assert.match(RENDER_SRC, /stopSig\(lanes\)/);
  });
});

describe('the stop-task route', () => {
  it('exists, validates the id and does not share the interrupt branch', () => {
    assert.ok(SERVER_SRC.includes("action === 'stop-task'"));
    const branch = SERVER_SRC.slice(SERVER_SRC.indexOf("action === 'stop-task'"));
    assert.match(branch.slice(0, 900), /error: 'taskId required'/);
    assert.doesNotMatch(branch.slice(0, 900), /interruptChat/);
  });
});

// =====================================================================================================
// End to end: the frames of a real kill, off a real process, through the real engine.
// =====================================================================================================
process.env.CLAUDE_UI_FAKE_BIN = path.join(__dirname, '..', 'fake-claude.js').replace(/\\/g, '/');
process.env.FAKE_CLAUDE_SCENARIO = 'bgstop';
const { startChat, sendToChat, killChat, stopTask } = require('../lib/chat');

describe('G6 end to end — stop_task against fake-claude', () => {
  it('kills the running task, and the CLI\'s own frames are what turn the lane into „gestoppt"', async () => {
    const lanes = [];
    const chat = startChat({ cwd: ROOT, permissionMode: 'plan' });
    const seen = [];
    let answer = null;
    try {
      await new Promise((resolve) => {
        const bail = setTimeout(resolve, 15000);     // a broken scenario → the asserts below say so
        chat.onEvent = async (ev) => {
          seen.push(ev);
          if (ev.type === 'system') laneSystemEvent(lanes, ev, Date.now());
          if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
            for (const b of ev.message.content) if (b.type === 'tool_use') laneStart(lanes, { id: b.id, input: b.input }, Date.now());
          }
          // the first result arrives WHILE the agent runs — that is the moment the user presses ⏹
          if (ev.type === 'result' && ev.result_index === 0 && !answer) {
            const a = lanes[0];
            stopTaskMark(a, Date.now());
            answer = await stopTask(chat, stopTaskTarget(a).taskId || a.taskId);
          }
          if (ev.type === 'system' && ev.subtype === 'task_notification') { clearTimeout(bail); setTimeout(resolve, 60); }
        };
        sendToChat(chat, 'Starte einen Langläufer');
      });
    } finally { try { killChat(chat); } catch { /* */ } }

    // the request itself
    assert.ok(answer, 'stop_task was never sent');
    assert.equal(answer.ok, true, 'the CLI refused: ' + JSON.stringify(answer));
    assert.equal(answer.unconfirmed, false, 'the kill runs BEFORE the answer, so a real answer is expected here');
    // …and the frames that are the actual confirmation, in the measured order
    const subs = seen.filter((e) => e.type === 'system').map((e) => e.subtype);
    assert.ok(subs.includes('task_updated'), 'no task_updated after the kill: ' + subs.join(','));
    const killed = seen.find((e) => e.subtype === 'task_updated' && e.patch && e.patch.status === 'killed');
    assert.ok(killed, 'the kill was never reported as `killed`');
    const a = lanes[0];
    assert.equal(a.status, 'error', 'a killed agent did not finish successfully');
    assert.equal(stopView(a, Date.now()).state, 'stopped', 'only the frames may produce this state');
  });

  it('a stop on a task that is already over answers SUCCESS — so success is not a receipt', async () => {
    // The measured smoothing (`YLe`): not_found with a persisted marker, and not_running with a terminal
    // status, both become success. This is why the UI never turns an ok into „gestoppt".
    const chat = startChat({ cwd: ROOT, permissionMode: 'plan' });
    let taskId = '';
    try {
      await new Promise((resolve) => {
        const bail = setTimeout(resolve, 15000);
        chat.onEvent = (ev) => {
          if (ev.type === 'system' && ev.subtype === 'task_started') { taskId = ev.task_id; clearTimeout(bail); resolve(); }
        };
        sendToChat(chat, 'Starte einen Langläufer');
      });
      assert.ok(taskId, 'no task_started');
      const first = await stopTask(chat, taskId);
      assert.equal(first.ok, true);
      const again = await stopTask(chat, taskId);          // the task is terminal now
      assert.equal(again.ok, true, 'the CLI smooths this into a success — and the panel must not read it as a kill');
    } finally { try { killChat(chat); } catch { /* */ } }
  });

  it('an unknown task id is REFUSED with the BARE sentence — no `StopTask:` prefix on the wire', async () => {
    // The emulator is pinned to the real wording here, and that pin is the test. `StopTaskError` is built as
    // `new te(<sentence>, <code>)`, its base class stores argument two in `telemetryMessage`, and the control
    // answer carries `o.message` — so a `StopTask: not_found: …` would be an invention of the fake. It WAS
    // one, and the parser it fed was dead code in production while this very test reported it working.
    const chat = startChat({ cwd: ROOT, permissionMode: 'plan' });
    try {
      const r = await stopTask(chat, 'no-such-task');
      assert.equal(r.ok, false);
      assert.equal(r.error, REFUSAL_NOT_FOUND + 'no-such-task', 'got: ' + r.error);
      assert.doesNotMatch(r.error, /StopTask:/, 'the telemetry prefix never reaches a client');
      // …and that sentence is what the row shows, unaltered
      const a = liveLane(1000);
      stopTaskFailed(a, r.error, Date.now());
      assert.equal(stopView(a, Date.now()).error, r.error);
    } finally { try { killChat(chat); } catch { /* */ } }
  });
});
