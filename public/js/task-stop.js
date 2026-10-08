'use strict';
// Stopping ONE task (G6) — the decisions behind the ⏹ button on a single lane of the agent rail. Browser
// (classic script) AND Node (require'd by test/task-stop.test.js). Dependency-free, no DOM, no t().
//
// Until now the only stop in the panel was POST /api/chat/<id>/interrupt → `{subtype:'interrupt'}`, i.e. the
// WHOLE turn — and interruptTab() around it also empties the queue, retires the plan cards and marks EVERY
// lane aborted. So „stop that one runaway agent" did not exist, and taking the interrupt path for it would
// be the CHAT-FLOW-9 mistake again (a shared path that threw away the message it had just queued).
//
// `stop_task {task_id}` was read out of claude 2.1.288 (schema at dec 205776364, handler `Tt`,
// YLe → rhe for the kill):
//  · the ONLY field is `task_id` — no tool_use_id, no agentId, no force and no reason field;
//  · the answer is `success` with an EMPTY payload, and it is more than a send receipt: `rhe` awaits
//    `K.kill(…)` before it resolves, and the control loop awaits that promise before answering;
//  · …and yet it is NOT proof that THIS click stopped anything. `YLe` deliberately smooths TWO refusals
//    into success: `not_found` (when a stop marker could be persisted) and `not_running` with a terminal
//    task status. A task that finished by itself a moment earlier therefore answers success — so
//    „ich habe ihn gestoppt" would be exactly the kind of claim this project keeps getting wrong;
//  · a real refusal arrives as a PLAIN SENTENCE — „No task found with ID: x", „Task x is not running
//    (status: completed)", „Task x is owned by …", „Unsupported task type: …", the validation refusal
//    „stop_task: task_id must be a string" and, on a bridge lane, „stop_task is not supported in this
//    context (callback not registered)". There is NO machine code in it, and that correction cost this
//    module a feature: `StopTaskError` is constructed as `new te(<sentence>, <code>)`, but its base class
//    `TelemetrySafeError` puts the second argument into `telemetryMessage` — and the wire carries
//    `o.message`. So the `StopTask: <code>` prefix exists only in telemetry; a parser for it returned ''
//    against the real CLI for every refusal there is, while a fake that invented the prefix kept the
//    end-to-end test green. The row shows the CLI's own sentence instead of a code nobody sent.
//
// → The only honest confirmation is the CLI saying so AFTERWARDS: `task_updated {patch.status:'killed'}`
//   (the status is in the schema, next to failed/paused) or `task_notification {status:'stopped'}` — the
//   wording of the recorded interrupt run. agent-lanes.js lands both on the lane as `endStatus` (and the
//   notification's `reason` as `endReason`, which is what disqualifies a 'stopped' nobody caused — see
//   stopView), so this module only has to read it. `background_tasks_changed` is NOT such a source although
//   its describe names 'kill' as a trigger: it merely drops the id, which closes the lane as a plain „beendet" — it
//   cannot tell a kill from a normal end, and a lane that quietly reads „√ fertig" after a stop click is
//   the lie we are avoiding (see stopView's 'ended' arm).
//
// NOT MEASURED, and the UI must not pretend otherwise: the recorded run (paid-2026-10-02T19-55-29-267Z)
// contains only a workflow that finished CLEANLY (status 'completed'), never a killed one. That the kill
// really pushes `killed`/`stopped` is read from the schema and the kill path, not from a capture — which is
// precisely why 'pending' turns into 'unconfirmed' after a bounded wait instead of waiting for ever.

// How long a requested stop may stay „läuft" before the row says „unbestätigt". The confirmation is
// expected within a moment of the success (the kill has already run when the answer arrives, and the
// background list is emitted on kill), so ten seconds is generous rather than tight — and it is a ceiling,
// not a poll: nothing is re-sent, the row just stops claiming that something is happening.
var STOP_CONFIRM_MS = 10000;
// The two `endStatus` words that mean „this task was ENDED BY SOMEBODY", i.e. the only ones that let the
// row say „gestoppt". 'failed' is deliberately not among them: a task that died of its own error was not
// stopped by this button.
var STOP_KILL_STATUS = ['killed', 'stopped'];

function stopStr(v) { return (v == null) ? '' : String(v); }

// Is this lane stoppable, and with WHICH id? `stop_task` has exactly one argument, so there is nothing to
// fall back on — and the „no id yet" window is real, not theoretical: laneStart() runs from the Agent
// tool_use in the assistant frame (chat-render.js trackAgentStart), i.e. BEFORE any task_* frame, and
// `a.taskId` only arrives with task_started (or, as a fallback, from the launch receipt / the background
// list). In that window the button has to be DISABLED with a reason, never fired with a guess.
// → { ok:true, taskId } | { ok:false, reason }
function stopTaskTarget(a, now) {
  if (!a) return { ok: false, reason: 'no-lane' };
  if (a.status !== 'running') return { ok: false, reason: 'not-running' };
  if (!a.taskId) return { ok: false, reason: 'no-task-id' };
  if (!stopRetryable(a, now)) return { ok: false, reason: 'already' };
  return { ok: true, taskId: stopStr(a.taskId) };
}
// May this lane be asked AGAIN? The lock is tied to what the row currently SAYS, not to „a stop was once
// requested", and that distinction is the whole feature: a stop whose success nobody ever confirmed leaves
// the lane RUNNING, and the old lock (`a.stopAt && !a.stopError`) was permanent — nothing anywhere resets
// `stopAt`, so the ⏹ was gone for good in exactly the state the button exists for. All that was left then
// was the turn interrupt, which (without `perTaskStopAffordance`) takes every background agent with it.
//   'pending'  no — a second request inside the window could only earn the smoothed `not_found` success of
//              a task that is already gone, and the first one may still be landing.
//   'unconfirmed' yes — the window ran out and nothing changed; the task may well still be running, and a
//              second kill is idempotent and no more expensive than the first.
//   'refused'  yes — the refusal may have been about a state that has since changed.
//   'none'     yes, obviously.
// 'stopped'/'ended' never reach here: both mean the lane is no longer `running`.
function stopRetryable(a, now) {
  var st = stopView(a, now).state;
  return st === 'none' || st === 'unconfirmed' || st === 'refused';
}
// Is this lane a whole WORKFLOW rather than one agent? It decides the WORDING, and that is not cosmetic:
// measured on the real run, a workflow carries exactly ONE task_id for the whole fan-out
// (task_type 'local_workflow'), while its agents exist only inside `task_progress.workflow_progress[]`
// with an `agentId` and no task_id of their own — there was no task_started, no task_updated and no
// background_tasks_changed entry for any of them. So `stop_task` on this lane stops the ENTIRE workflow,
// and a button labelled „diesen Agenten stoppen" would be wrong about what it does.
function stopTaskScope(a) { return (a && a.taskType === 'local_workflow') ? 'workflow' : 'agent'; }

// Record that a stop was REQUESTED. Deliberately does not touch `status`, `end` or `endStatus`: laneFinish()
// in agent-lanes.js stays the one place a lane ends, and a lane that ends here would be the „the UI claims
// something nobody confirmed" bug in its purest form — the row would read „gestoppt" the moment the button
// was pressed.
function stopTaskMark(a, now) {
  if (!a) return false;
  a.stopAt = now || Date.now();
  a.stopError = '';
  return true;
}
// …and the counterpart: the CLI refused. Kept ON the lane (not just in a toast) because the toast is gone
// in four seconds while the row stays, and „why is this thing still running" is then unanswerable.
// The CLI's SENTENCE is all that is kept. There used to be a parsed `stopCode` next to it, lifted out of a
// `StopTask: <code>` prefix — that prefix is the telemetry message and never reaches the wire (see the head
// of this file), so against the real CLI the code was always '' and reached no surface anyway. A classifier
// built from the five sentences would be a second guess on top of the first: the wordings of four of them
// are known from the binary, `ambiguous` is not, and all five can be rephrased by any CLI update without
// anyone noticing. The sentence cannot go stale that way, so the sentence is what the row shows.
function stopTaskFailed(a, error, now) {
  if (!a) return false;
  a.stopAt = now || a.stopAt || Date.now();
  a.stopError = stopStr(error) || 'refused';
  return true;
}

// What the row may SAY about the stop, as an i18n key plus the state behind it. Five answers, and each one
// exists because the other four would be a claim nobody made:
//   'none'        no stop was requested on this lane.
//   'pending'     requested, still running, inside the confirmation window → „Stopp angefordert…".
//   'unconfirmed' requested, still running, the window ran out → the request went out and nothing changed.
//                 NOT „gestoppt": `success` can be the smoothed answer for a task nobody could find.
//   'stopped'     the CLI itself reported `killed`/`stopped` for this lane → the one state that may say
//                 „gestoppt".
//   'ended'       the lane ended, but with another outcome (completed via the background list, failed), or
//                 it ended as 'stopped' for a reason that was not a stop — see `endReason` below.
//                 It is over — but whether this click did it is unknown, and the row says exactly that.
//   'refused'     somebody answered and said no; `error` carries the CLI's own sentence.
function stopView(a, now) {
  if (!a || !a.stopAt) return { state: 'none' };
  if (a.stopError) return { state: 'refused', key: 'chat-render.agentStoppAbgelehnt', error: stopStr(a.stopError) };
  // `endReason` disqualifies the one green chip in this feature. task_notification carries a `reason` whose
  // schema text is explicit: „set only when the task did not end through an ordinary completion, failure, or
  // stop. 'worker_restart': the worker process restarted and the resumed process found the task orphaned
  // (always with status 'stopped')". So a `stopped` WITH a reason is an end this click did not cause, and
  // showing it as „gestoppt" would be the lie this module exists to prevent — in the one place it defined as
  // its only source of truth. Any reason disqualifies, not just the single declared one: a future CLI adding
  // a second extraordinary cause must not be read as a confirmed kill by default (same rule as the unknown
  // status word in mcp-live.js). 'ended' already exists for exactly this uncertainty.
  if (!a.endReason && STOP_KILL_STATUS.indexOf(stopStr(a.endStatus)) >= 0) return { state: 'stopped', key: 'chat-render.agentStoppBestaetigt' };
  if (a.status !== 'running') return { state: 'ended', key: 'chat-render.agentStoppEnde' };
  var t = now || Date.now();
  if (t - a.stopAt >= STOP_CONFIRM_MS) return { state: 'unconfirmed', key: 'chat-render.agentStoppUnbestaetigt' };
  return { state: 'pending', key: 'chat-render.agentStoppLaeuft' };
}
// Does the rail have to be repainted because a stop state changed? The 1 s ticker calls this: a lane whose
// confirmation window has just run out changes what the row SAYS without any frame arriving, and the
// ticker only rewrites the running rows' live line — the stop chip sits next to the button, so it needs the
// structural repaint. Pure and cheap: it compares two strings, it does not mutate.
function stopSig(lanes, now) {
  var list = Array.isArray(lanes) ? lanes : [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    if (!a || !a.stopAt) continue;
    out.push(a.id + ':' + stopView(a, now).state);
  }
  return out.join('|');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STOP_CONFIRM_MS, STOP_KILL_STATUS,
    stopTaskTarget, stopRetryable, stopTaskScope, stopTaskMark, stopTaskFailed, stopView, stopSig,
  };
}
