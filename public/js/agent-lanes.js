'use strict';
// Lifecycle + metrics of the rows in the „🤖 Agent(en)" group of the chat rail — browser (classic
// script) AND Node (require'd by test/agent-lanes.test.js). Dependency-free, side-effect-free, no DOM,
// no t(): the painting stays in chat-render.js, the decisions live here so they can be tested.
//
// WHY this is its own module (#32): the rail was driven by two assumptions that the CLI (2.1.x) breaks,
// and both were one-liners buried in the event pump, i.e. untestable. Measured against a real run
// (claude 2.1.274, two parallel Explore agents, capture 2026-09-17):
//
//  1. „a tool_result for the Agent tool means the agent is done" — WRONG for a BACKGROUNDED agent
//     (`run_in_background` is the CLI's default). It answers its own tool call within a second with
//     `tool_use_result.status: "async_launched"` and the text „Async agent launched successfully … The
//     agent is working in the background." The row therefore flipped to „√ done" ~1 s after the start
//     and the 1 s elapsed ticker stopped — the strip lied before it even disappeared.
//  2. „a `result` frame means the turn is over, so nothing is running" — WRONG: the CLI writes SEVERAL
//     result frames per run (`result_index` 0,1,…) and the FIRST one arrives WHILE the background agents
//     are still working. The capture's `result_index: 0` carried
//     `subagent_stats {spawned:2, started_in_background:2, completed:0}` next to the answer „Beide
//     Explore-Agenten laufen im Hintergrund … ich melde die Ergebnisse, sobald beide fertig sind."
//     `clearAgents()` emptied the whole list right there, the group vanished, and because the rail's
//     item count fell to 0 the rail folded itself away — exactly the reported bug.
//
// The lifecycle the CLI DOES emit (all of it top-level `system` frames the pump used to ignore):
//   task_started  {tool_use_id, task_id, description, subagent_type, is_backgrounded, spawn_depth, prompt}
//   task_progress {tool_use_id, task_id, description, usage{total_tokens,tool_uses,duration_ms}, last_tool_name}
//   task_updated  {task_id, patch{status, end_time}}
//   task_notification {tool_use_id, task_id, status, summary, output_file, usage{…}}
//   background_tasks_changed {tasks:[{task_id,…}]}   ← the live list of what is still running
//   result.subagent_stats {spawned, completed, failed, killed{parent,user,system}}  ← cross-check
// `task_*.tool_use_id` IS the `tool_use.id` the row was created under, so no extra id mapping is needed.
//
// Two things this module is deliberately paranoid about, because „stays visible for ever" is a bug too:
//   · every finish path goes through laneFinish(), which only ever ADDS information — a lane may be
//     closed by the background list and refined by the notification that follows a frame later.
//   · a lane can be closed without its own event: by the run's own `subagent_stats` (everything settled)
//     and — last resort — by lanesPruneStale(). What must NOT close a background lane is the mere fact
//     that the turn failed: measured on the recorded max-turns run (40 frames), a turn that ends
//     `error_max_turns` / `is_error: true` carries `subagent_stats {spawned:1, completed:0, killed:{0,0,0}}`
//     in the SAME frame and its Explore agent keeps working for another 37 s before reporting
//     `task_notification {status:'completed'}` — see lanesAfterResult.
//   · `subagent_stats` are the SESSION's running totals (the CLI documents them as cumulative, like
//     modelUsage), so a single counter out of them says nothing about the frame that carries it. Only the
//     COMPARISON `settled >= spawned` survives that — both sides grow together — which is why
//     laneStatsSettled is the one thing read out of them (see lanesAfterResult).

var LANE_STALE_MS = 30 * 60 * 1000; // no signal at all for this long → close the lane as "outcome unknown"
// How long a FINISHED lane keeps its row after it ended (#34). The old rule was „the next result frame
// with nothing running clears the list", i.e. the row vanished a second or two after the agent reported
// back — measured on a real run, a finished Explore agent was on screen for ~1.5 s. Everything the agent
// had done (model, tokens, cost, tool breakdown, its summary) went with it, so anyone not watching that
// exact second never learned an agent had run at all. Two minutes is long enough to look up from the
// answer and check, short enough that the rail does not become a session log.
var LANE_AFTERGLOW_MS = 2 * 60 * 1000;

function laneNow(now) { return now || Date.now(); }
function laneFind(lanes, id) {
  if (!lanes || !id) return null;
  for (var i = 0; i < lanes.length; i++) if (lanes[i] && lanes[i].id === id) return lanes[i];
  return null;
}
function laneFindByTask(lanes, taskId) {
  if (!lanes || !taskId) return null;
  for (var i = 0; i < lanes.length; i++) if (lanes[i] && lanes[i].taskId === taskId) return lanes[i];
  return null;
}
// Display/pricing id of a model the CLI reported for a subagent. `resolvedModel` can be a gateway id
// ("eu.anthropic.claude-sonnet-5", "…-v1:0") while the SAME session's assistant frames report the bare
// "claude-sonnet-5" — so stripping the provider prefix is what keeps the agent's cost comparable with
// the turn footer's, instead of silently dropping to "unpriced" for every Bedrock session.
function laneModelId(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  s = s.replace(/^[a-z]{2,3}\.(anthropic|bedrock)\./i, '').replace(/^(anthropic|bedrock)\./i, '');
  s = s.replace(/^(publishers\/anthropic\/models\/)/i, '');            // Vertex-style path
  return s.replace(/-v\d+:\d+$/i, '');                                  // Bedrock version suffix
}

// Create or update the lane for one Agent/Task tool_use. Idempotent on the tool_use id: a replayed
// frame (SSE reconnect) or a `task_started` that arrives before/after its assistant frame must not
// produce a second row, and must never resurrect a lane that has already finished.
function laneStart(lanes, spawn, now) {
  if (!lanes || !spawn || !spawn.id) return null;
  var t = laneNow(now);
  var input = (spawn.input && typeof spawn.input === 'object') ? spawn.input : {};
  var a = laneFind(lanes, spawn.id);
  if (!a) { a = { id: spawn.id, type: 'agent', desc: '', status: 'running', start: t }; lanes.push(a); }
  var type = spawn.type || input.subagent_type;
  if (type) a.type = String(type);
  var desc = (spawn.desc != null) ? spawn.desc : input.description;
  if (desc) a.desc = String(desc).trim();
  if (input.name) a.name = String(input.name);
  if (input.isolation) a.isolation = String(input.isolation);
  if (input.model) a.modelReq = String(input.model);                     // the REQUESTED override ("sonnet")
  if (input.prompt && !a.prompt) a.prompt = String(input.prompt);
  // The input's own hint that this one goes to the background. Not authoritative (the CLI decides, and
  // says so in task_started.is_backgrounded / the launch receipt) but it is the earliest signal there is.
  if (input.run_in_background === true) a.bg = true;
  a.lastSignal = t;
  return a;
}

// The tool_result of a backgrounded agent is a START RECEIPT, not a result — this is cause (1) above.
function laneLaunchStatus(out) {
  var s = (out && typeof out === 'object') ? String(out.status || '') : '';
  return (s === 'async_launched' || s === 'remote_launched') ? s : '';
}
// One tool_result block that names a lane. `out` is the frame's `tool_use_result` (the CLI's full Output
// object — for the Agent tool that is AgentOutput, which is the only place the per-agent totals exist).
// NOTE there is deliberately no "ignore sidechain frames" guard here: when a NESTED agent finishes, its
// completion arrives on a frame that HAS a parent_tool_use_id, and dropping those would leave that lane
// spinning. The tool_use ids of a subagent's own tools can never collide with an Agent tool_use id.
function laneToolResult(lanes, r, now) {
  if (!r) return false;
  var a = laneFind(lanes, r.id);
  if (!a) return false;
  var t = laneNow(now);
  var out = (r.out && typeof r.out === 'object') ? r.out : null;
  a.lastSignal = t;
  var launched = laneLaunchStatus(out);
  if (launched) {
    a.bg = true; a.launched = launched;
    if (out.agentId) a.agentId = String(out.agentId);
    // In the capture the local agent's `agentId` IS its `task_id` ("adf219e685ce1bf7f" in both frames).
    // Used only as a FALLBACK join key (never overwriting the one task_started reported): if a future CLI
    // stops making them equal, this id simply matches nothing — it can't close the wrong lane.
    if (out.agentId && !a.taskId) a.taskId = String(out.agentId);
    if (out.resolvedModel) a.model = String(out.resolvedModel);          // model at the backgrounding transition
    if (out.description && !a.desc) a.desc = String(out.description).trim();
    if (out.outputFile) a.outputFile = String(out.outputFile);
    if (out.prompt && !a.prompt) a.prompt = String(out.prompt);
    // `out.taskId` means two different things depending on WHICH launch this was, and reading it as one
    // thing was wrong for the commoner of the two (U1). Measured over all 51 Workflow calls in the local
    // corpus: 49 receipts carry `{status:'async_launched', taskId, taskType:'local_workflow', workflowName,
    // runId, summary, transcriptDir, scriptPath}` — there `taskId` IS the local task id, the very argument
    // `stop_task` takes. It used to land in `remoteTaskId`, whose own comment says „a CLOUD id, not
    // task_id" and which nothing in the panel reads (a field with no reader; see docs/ideas.md). So:
    //  · remote_launched keeps remoteTaskId, with its documented meaning intact;
    //  · async_launched adopts it as the lane's `taskId` when nothing has supplied one yet. A FALLBACK, and
    //    a narrow one: a Workflow's lane is created by task_started and by nothing else (the Workflow tool is
    //    no isAgentTool, so its tool_use opens no lane), and that frame carried `task_id` in both paid runs.
    //    So this does NOT keep the ⏹ alive when task_started is lost — then there is no lane to adopt onto
    //    (docs/ideas.md U1). An earlier version of this comment said it did.
    if (out.taskId) {
      if (launched === 'remote_launched') a.remoteTaskId = String(out.taskId);
      else if (!a.taskId) a.taskId = String(out.taskId);
    }
    if (out.taskType) a.taskType = String(out.taskType);                 // 'local_workflow' → it is a whole run
    if (out.sessionUrl) a.sessionUrl = String(out.sessionUrl);
    return true;
  }
  // No usable `tool_use_result` (an older CLI, or a plain-text result): a lane we already KNOW is
  // backgrounded must not be closed by it either — is_backgrounded/run_in_background said so, and the
  // authoritative end is task_notification. Everything else (a foreground agent) closes exactly as before.
  // An ERROR result is the exception: „the Agent tool failed" ends the agent whatever the mode was, and
  // waiting for a notification that a failed launch will never send is how a lane hangs.
  if (!out && a.bg && !r.isError) return false;
  return laneFinish(a, { at: t, isError: !!r.isError, out: out });
}

// The ONE place a lane ends. Only ever adds information: called again with more (a notification after
// the background list dropped the task) it fills in the metrics and can still upgrade done → error.
function laneFinish(a, o) {
  if (!a) return false;
  o = o || {};
  var t = o.at || Date.now();
  var out = (o.out && typeof o.out === 'object') ? o.out : null;
  var changed = false;
  if (a.status === 'running') { a.status = o.isError ? 'error' : 'done'; a.end = t; changed = true; }
  else if (o.isError && a.status !== 'error') { a.status = 'error'; changed = true; }
  a.lastSignal = t;
  a.phase = ''; a.lastTool = '';                                        // nothing is "currently" happening any more
  if (o.status) a.endStatus = String(o.status);
  // Only task_notification carries one, and only for an end that was NOT an ordinary completion/failure/stop
  // (today: 'worker_restart'). It is the difference between „somebody killed this" and „the worker restarted
  // and found it orphaned", and both arrive as status 'stopped'.
  if (o.reason) a.endReason = String(o.reason);
  if (o.stale) { a.stale = true; changed = true; }
  if (o.aborted) { a.aborted = true; changed = true; }
  if (o.summary) { a.summary = String(o.summary); changed = true; }
  // `o.usage` only ever comes from task_notification, i.e. from the agent's CLOSING report — so that
  // duration is final and may replace the wall clock (see laneElapsedMs).
  if (laneApplyTaskUsage(a, o.usage, true)) changed = true;
  if (out) {
    if (out.totalTokens != null) a.tokens = Number(out.totalTokens) || 0;
    if (out.totalToolUseCount != null) a.toolUses = Number(out.totalToolUseCount) || 0;
    if (out.totalDurationMs != null) { a.durMs = Number(out.totalDurationMs) || 0; a.durFinal = true; } // AgentOutput = the finished agent's own total
    if (out.resolvedModel) a.model = String(out.resolvedModel);
    if (out.modelsUsed && out.modelsUsed.length) a.modelsUsed = out.modelsUsed.slice(0, 6).map(String);
    if (out.usage && typeof out.usage === 'object') a.usage = out.usage; // the per-token-type split → cost
    if (out.toolStats && typeof out.toolStats === 'object') a.toolStats = out.toolStats;
    if (out.agentId) a.agentId = String(out.agentId);
    if (out.agentType && (!a.type || a.type === 'agent')) a.type = String(out.agentType);
    if (out.prompt && !a.prompt) a.prompt = String(out.prompt);
    if (out.worktreeBranch) a.worktreeBranch = String(out.worktreeBranch);   // isolation actually used, not just requested
    changed = true;
  }
  return changed;
}
// task_progress / task_notification report a SHORT usage shape ({total_tokens, tool_uses, duration_ms}),
// not the per-token-type split of AgentOutput.usage. Same three numbers, live.
// `final` says whether this usage is the agent's CLOSING report (task_notification) or just a snapshot
// from a task_progress in the middle of its run — only the former is a duration, the latter is an
// intermediate reading that must never be shown as one (see laneElapsedMs).
function laneApplyTaskUsage(a, u, final) {
  if (!a || !u || typeof u !== 'object') return false;
  var changed = false;
  if (u.total_tokens != null && Number(u.total_tokens) !== a.tokens) { a.tokens = Number(u.total_tokens) || 0; changed = true; }
  if (u.tool_uses != null && Number(u.tool_uses) !== a.toolUses) { a.toolUses = Number(u.tool_uses) || 0; changed = true; }
  if (u.duration_ms != null) {
    if (Number(u.duration_ms) !== a.durMs) { a.durMs = Number(u.duration_ms) || 0; changed = true; }
    if (final) a.durFinal = true;                                       // not a `changed`: nothing visible flips
  }
  return changed;
}

// The `system` frames that carry the real lifecycle. Returns true when the rail has to be repainted;
// pure live-number updates (task_progress) return false on purpose — the 1 s ticker writes those in
// place, because a repaint here rebuilds the whole rail (~100 persisted grant chips) every 2 seconds.
function laneSystemEvent(lanes, ev, now) {
  if (!lanes || !ev || ev.type !== 'system') return false;
  var t = laneNow(now);
  var sub = String(ev.subtype || '');
  var a;
  if (sub === 'task_started') {
    a = laneStart(lanes, { id: ev.tool_use_id, type: ev.subagent_type, desc: ev.description }, t);
    if (!a) return false;
    if (ev.task_id) a.taskId = String(ev.task_id);                      // the join key for task_updated + the bg list
    // the CLI's own statement beats the request in `input.run_in_background`: it may decline to background
    // one (depth/concurrency limits), and a foreground agent must still be closed by its tool_result
    if (ev.is_backgrounded) a.bg = true; else if (ev.is_backgrounded === false) a.bg = false;
    if (ev.task_type) a.taskType = String(ev.task_type);
    if (ev.spawn_depth != null) a.depth = Number(ev.spawn_depth) || 0;
    if (ev.prompt && !a.prompt) a.prompt = String(ev.prompt);
    return true;
  }
  if (sub === 'task_progress') {
    a = laneFind(lanes, ev.tool_use_id) || laneFindByTask(lanes, ev.task_id);
    if (!a) return false;                                               // never CREATE from progress: a late frame
    if (ev.task_id && !a.taskId) a.taskId = String(ev.task_id);         // would otherwise resurrect a closed lane
    a.lastSignal = t;
    if (a.status !== 'running') return false;
    // `description` here is the agent's CURRENT activity ("Finding *", "Running <bash desc>") — the
    // per-agent equivalent of the status strip's phase. It must NOT overwrite a.desc, which is the
    // task's identity and the only thing that tells two parallel Explore agents apart.
    if (ev.description) a.phase = String(ev.description);
    if (ev.last_tool_name) a.lastTool = String(ev.last_tool_name);
    if (ev.subagent_type && !a.type) a.type = String(ev.subagent_type);
    laneApplyTaskUsage(a, ev.usage);
    return false;
  }
  if (sub === 'task_updated') {
    a = laneFindByTask(lanes, ev.task_id);
    if (!a) return false;
    a.lastSignal = t;
    var st = (ev.patch && ev.patch.status) ? String(ev.patch.status) : '';
    if (!st || st === 'running' || st === 'in_progress' || st === 'pending' || st === 'queued') return false;
    // `patch.end_time` is the CLI's epoch — the elapsed readout is browser-side, so the browser's own
    // clock is the only one that can't produce a negative age here.
    return laneFinish(a, { at: t, isError: st !== 'completed', status: st });
  }
  if (sub === 'task_notification') {
    a = laneFind(lanes, ev.tool_use_id) || laneFindByTask(lanes, ev.task_id);
    if (!a) return false;
    if (ev.output_file) a.outputFile = String(ev.output_file);
    return laneFinish(a, {
      at: t, isError: String(ev.status || 'completed') !== 'completed', status: ev.status || 'completed',
      // `reason` is the schema's own escape hatch: „set only when the task did not end through an ordinary
      // completion, failure, or stop" — declared value 'worker_restart', „the worker process restarted and
      // the resumed process found the task orphaned (always with status 'stopped')". Without it on the lane
      // a restart was indistinguishable from a kill, and G6 showed its only green chip („gestoppt") for an
      // end that nobody had asked for (task-stop.js stopView).
      reason: ev.reason, summary: ev.summary, usage: ev.usage,
    });
  }
  if (sub === 'background_tasks_changed') {
    var list = Array.isArray(ev.tasks) ? ev.tasks : [];
    var live = {};
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].task_id) live[String(list[i].task_id)] = true;
    // Join a lane that doesn't know its task_id yet by DESCRIPTION. The list can arrive BEFORE the
    // task_started that carries the id (capture frames 61 and 100 do exactly that), and a lane that was
    // never seen IN the list can never be closed BY the list either. Only when exactly one lane matches,
    // so two agents with the same description can never be mixed up.
    var changed = false;
    for (i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || !e.task_id || !e.description || laneFindByTask(lanes, e.task_id)) continue;
      var d = String(e.description).trim(), hit = null, hits = 0;
      for (var m = 0; m < lanes.length; m++) {
        if (lanes[m] && !lanes[m].taskId && lanes[m].status === 'running' && lanes[m].desc === d) { hit = lanes[m]; hits++; }
      }
      // `changed` since G6: learning the task_id IS a structural change now — it is the one argument
      // `stop_task` takes, so the ⏹ button goes from disabled to usable. This join used to report „nothing
      // changed" (it closes no lane), and the repaint is skipped on that word — so a lane that got its id
      // from the LIST rather than from task_started would have kept a dead button until the next frame that
      // happened to change something else.
      if (hits === 1) { hit.taskId = String(e.task_id); changed = true; }
    }
    for (var j = 0; j < lanes.length; j++) {
      a = lanes[j];
      if (!a || !a.taskId) continue;                                     // not joined to a task id yet → says nothing
      if (live[a.taskId]) { a.inBgList = true; a.lastSignal = t; continue; }
      // It WAS in this list and is gone → the background task ended. The notification with the outcome
      // usually follows a frame later and refines the lane; this is what keeps a lane from hanging when
      // it doesn't (the CLI's own docs allow for gaps in the notification stream).
      if (a.inBgList && a.status === 'running') { a.inBgList = false; if (laneFinish(a, { at: t })) changed = true; }
    }
    return changed;
  }
  return false;
}

// „every subagent this SESSION spawned has settled" — the cross-check that makes a lost task_notification
// survivable. Counts only the states that are genuinely over; `refused` agents were never spawned.
// Safe against the cumulative nature of subagent_stats because it compares two counters that grow
// together: a new agent raises `spawned` in the same frame, so a session with an old kill in `killed`
// still reads „not settled" while the new one works.
function laneStatsSettled(stats) {
  if (!stats || typeof stats !== 'object') return false;
  var spawned = Number(stats.spawned) || 0;
  if (spawned <= 0) return false;
  var k = (stats.killed && typeof stats.killed === 'object') ? stats.killed : {};
  var settled = (Number(stats.completed) || 0) + (Number(stats.failed) || 0)
    + (Number(k.parent) || 0) + (Number(k.user) || 0) + (Number(k.system) || 0);
  return settled >= spawned;
}
// What survives a `result` frame. NOT "nothing" (that was cause 2): a result can be written while
// background agents keep working, and the run says so in `subagent_stats`.
// Returns a NEW array (the caller assigns it to tab.agents).
function lanesAfterResult(lanes, ev, now) {
  var list = Array.isArray(lanes) ? lanes : [];
  var t = laneNow(now);
  var stats = ev && (ev.subagent_stats || ev.subagentStats);
  var settled = laneStatsSettled(stats);
  // A FAILED turn used to take every running lane with it („the children died with it, `killed.parent`").
  // Measured against the real CLI that is wrong for a BACKGROUNDED agent, and it reproduced #32 in the
  // error path: the turn ends after 13 s with `result {subtype:'error_max_turns', is_error:true}` while
  // the same frame's `subagent_stats {spawned:1, completed:0, killed:{0,0,0}}` says the agent is ALIVE —
  // it then works another 37 s and reports `task_notification {status:'completed', usage:{…}, summary:…}`.
  // Closing the lane at the result frame made the row vanish 1 s after the start (running → 0 → filtered
  // out → the rail folds itself away, chat-side.js), and the completion had no lane left to land on.
  // Since every error result reaches this branch (API 429/529, error_during_execution, --max-budget-usd),
  // that was exactly the reported „the chat says it is still waiting" case.
  // So a hard end closes ONLY the FOREGROUND lanes — their only possible end is this turn, so leaving them
  // would hang them. A background lane stays with the sources that really know, and a real kill is
  // announced by every single one of them BEFORE the result: in the recorded interrupt run
  // (15 frames, Stop pressed while one Explore agent ran) frames 9/10/11 are
  // `background_tasks_changed {tasks: []}`, `task_updated {patch.status:'killed'}` and
  // `task_notification {status:'stopped'}` — the lane is long closed when the `result` arrives at frame 14.
  // The result's own `subagent_stats.killed` must NOT be added to that: those counters are the SESSION's
  // running totals, so ONE kill anywhere makes `killed > 0` true for every later frame of the session, and
  // reading it per frame brings the bug straight back one turn later. Measured with the two real recordings
  // replayed as ONE session (interrupt run, then the max-turns run whose stats still carry the earlier
  // `killed.system:1`): the healthy background agent's lane was dropped at `error_max_turns`
  // (1 → 0 lanes) and its `task_notification` 37 s later landed nowhere (changed=false, summary lost).
  // Backstops for a kill nobody announced: Stop marks the lanes itself (agentsAborted, chat-render.js),
  // `_exit`/`_error` clear the list, and lanesPruneStale() is the last resort — nothing spins for ever.
  var hardEnd = !!(ev && (ev.is_error === true || (ev.subtype && ev.subtype !== 'success')));
  var running = 0;
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    if (!a || a.status !== 'running') continue;
    // `settled` is a statement about SUBAGENTS only: workflow agents are not in `subagent_stats` at all
    // (`spawned` stays 0 for a pure workflow run, docs/ideas.md U1). So „every subagent has settled" says
    // nothing about a running workflow — closing its lane on it marked a live workflow `done` the moment a
    // sibling subagent finished, took its ⏹ away, and let anything that asks „is something still running in
    // this tab?" answer no. A workflow lane ends through its own frames (task_notification, the bg list).
    if (settled && a.taskType !== 'local_workflow') laneFinish(a, { at: t });
    else if (hardEnd && !(a.bg || a.inBgList)) laneFinish(a, { at: t, isError: true, aborted: true });
    else running++;
  }
  // While a sibling is still working, the lanes that already finished STAY — with two or five parallel
  // agents the CLI writes a result frame after every single one of them, and retiring each row on the
  // next frame would let a finished agent's numbers flash by for a second or two.
  if (running) return list;
  // Nothing is running any more. The list used to be emptied right here, which is what made a finished
  // agent unreadable (#34). Now a finished lane survives its afterglow window and is dropped by the
  // clock — either by the next result frame that arrives after it expired, or by lanesPruneFaded() from
  // the ticker, whichever comes first. Bounded either way: `_exit`/`_error`/a new session clear the
  // list outright, and a lane that never expires cannot exist (laneFinish always sets `end`).
  return list.filter(function (x) { return x && !laneFaded(x, t); });
}
// „this lane is over AND its afterglow has run out". A lane closed without an `end` (defensive: every
// path through laneFinish sets one) counts as expired rather than immortal.
function laneFaded(a, now, ttl) {
  if (!a || a.status === 'running') return false;
  return laneNow(now) - (a.end || 0) >= (ttl || LANE_AFTERGLOW_MS);
}
// Drop the lanes whose afterglow ran out, without waiting for a frame — a turn can end minutes before
// anything else happens in the chat, and the row must not outlive its window just because the CLI went
// quiet. Returns a NEW array (the caller assigns it to tab.agents) or the SAME one when nothing expired,
// so the caller can repaint on identity change alone.
function lanesPruneFaded(lanes, now, ttl) {
  var list = Array.isArray(lanes) ? lanes : [];
  var t = laneNow(now);
  var keep = list.filter(function (a) { return !laneFaded(a, t, ttl); });
  return keep.length === list.length ? list : keep;
}
// Last resort against the opposite bug: a backgrounded agent whose notification never arrives (a lost
// frame, a killed helper process) would otherwise spin for the rest of the session. Called from the 1 s
// ticker, which only runs while something claims to be running. Closed as ERROR + `stale`, because the
// honest statement is „no signal any more, outcome unknown" — not „√ done".
function lanesPruneStale(lanes, now, maxIdleMs) {
  var t = laneNow(now);
  var cap = maxIdleMs || LANE_STALE_MS;
  var changed = false;
  var list = Array.isArray(lanes) ? lanes : [];
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    if (!a || a.status !== 'running') continue;
    if (t - (a.lastSignal || a.start || t) < cap) continue;
    if (laneFinish(a, { at: t, isError: true, stale: true })) changed = true;
  }
  return changed;
}

// --forward-subagent-text: the CLI forwards a subagent's own text and thinking as frames carrying
// `parent_tool_use_id` (plus `subagent_type` and `task_description`, so they identify themselves).
// This is the ONLY live source for a FOREGROUND agent — measured on 2.1.278: its `.output` file is
// created but stays empty, and the parent session transcript holds no sidechain line for it. So the
// text is kept on the lane, where the detail view reads it.
//
// Capped on purpose: a chatty agent would otherwise grow this array for the whole session. The cap
// drops the OLDEST blocks — the closing report is the part worth keeping, and it comes last.
var LANE_TEXT_MAX = 50, LANE_TEXT_CHARS = 8000;
function laneAppendText(lanes, id, text, kind, now) {
  var a = laneFind(lanes, id);
  var s = String(text == null ? '' : text).trim();
  if (!a || !s) return false;
  if (!a.texts) a.texts = [];
  a.texts.push({ kind: kind === 'thinking' ? 'thinking' : 'text', text: s, at: laneNow(now) });
  while (a.texts.length > LANE_TEXT_MAX) a.texts.shift();
  var total = 0;
  for (var i = a.texts.length - 1; i >= 0; i--) {
    total += a.texts[i].text.length;
    if (total > LANE_TEXT_CHARS) { a.texts = a.texts.slice(i + 1); break; }
  }
  a.lastSignal = laneNow(now);
  return true;
}
// Repaint signature for the rail. STRUCTURAL fields only: everything the 1 s ticker can write in place
// (elapsed, phase, live tokens, tool count) is left out on purpose, so nine progress frames per agent
// don't rebuild ~100 grant chips nine times (chat-side.js's guard exists for exactly that reason).
function lanesSig(lanes) {
  var list = Array.isArray(lanes) ? lanes : [];
  return list.map(function (a) {
    return [a.id, a.status, a.type, a.desc, a.model || a.modelReq || '',
      a.bg ? 'b' : '', a.isolation || '', a.stale ? 's' : '', a.aborted ? 'x' : '',
      a.summary ? 'y' : '', a.usage ? 'u' : '', a.toolStats ? 't' : '',
      // G6 — a requested or refused stop changes the row (the ⏹ button disappears, a chip appears), so it
      // belongs in the structural signature. Only the FACT, not the age: the pending → „unbestätigt"
      // transition happens on the clock with no frame arriving, and the 1 s ticker watches that one
      // separately (chat-render.js, task-stop.js stopSig) — putting a timestamp in here would rebuild the
      // whole rail on every tick.
      a.stopAt ? 'p' : '', a.stopError ? 'r' : '',
      // The id a stop needs. A lane exists BEFORE task_started gives it one, and the button is disabled
      // until then — so the moment the id arrives the row has to be rebuilt, or the button stays dead.
      a.taskId ? 'i' : '',
      a.status === 'running' ? '' : String(a.tokens || 0) + '/' + String(a.toolUses || 0)].join(':');
  }).join('|');
}

// How long this lane has been working: the wall clock while it runs, and once it is over the duration
// the agent reported about ITSELF (totalDurationMs / task_notification's usage.duration_ms) — that one is
// measured inside the agent and is the better number, the wall clock also contains our own frame latency.
// `durFinal` is what makes that safe: `a.durMs` is ALSO fed by every task_progress, and such a snapshot is
// not a duration. A lane closed WITHOUT a closing report (lanesPruneStale after 30 min of silence, or the
// background list dropping the task) would otherwise show the age of its last progress frame — measured:
// one progress frame with `duration_ms: 2046`, then silence, pruned half an hour later → the row said „2s"
// and the tooltip „Dauer: 2s" right next to „no signal any more from this agent". Without a final report
// the wall clock is the only honest number we have.
function laneElapsedMs(a, now) {
  if (!a) return 0;
  var t = laneNow(now);
  if (a.status !== 'running' && a.durMs && a.durFinal) return Math.max(0, a.durMs);
  return Math.max(0, (a.end || t) - (a.start || t));
}
// Everything the rail may honestly say about one lane, normalised over the sources that reported it.
// Absent stays absent — a number no frame carried is left undefined instead of zero-filled, so the
// renderer can simply skip it (#33: the status strip's numbers per agent, and only the real ones).
function laneMetrics(a, now) {
  var m = { status: (a && a.status) || 'running', type: (a && a.type) || 'agent' };
  if (!a) return m;
  if (a.desc) m.desc = a.desc;
  if (a.status === 'running') {
    if (a.phase) m.phase = a.phase;
    if (a.lastTool) m.lastTool = a.lastTool;
  }
  m.elapsedMs = laneElapsedMs(a, now);
  m.live = a.status === 'running';
  if (a.tokens) m.tokens = a.tokens;
  if (a.toolUses) m.toolUses = a.toolUses;
  var model = a.model || a.modelReq || '';
  if (model) { m.model = laneModelId(model); m.modelRaw = String(model); }
  if (a.modelsUsed && a.modelsUsed.length > 1) m.modelsUsed = a.modelsUsed;
  if (a.usage) m.usage = a.usage;                                        // only a COMPLETED agent reports it → cost
  var ts = a.toolStats;
  if (ts && typeof ts === 'object') {
    if (ts.readCount) m.reads = Number(ts.readCount) || 0;
    if (ts.editFileCount) m.edits = Number(ts.editFileCount) || 0;
    if (ts.bashCount) m.bash = Number(ts.bashCount) || 0;
    if (ts.searchCount) m.searches = Number(ts.searchCount) || 0;
    if (ts.linesAdded) m.linesAdded = Number(ts.linesAdded) || 0;
    if (ts.linesRemoved) m.linesRemoved = Number(ts.linesRemoved) || 0;
  }
  if (a.summary) m.summary = a.summary;
  if (a.bg) m.bg = true;
  if (a.isolation) m.isolation = a.isolation;
  if (a.name) m.name = a.name;
  if (a.stale) m.stale = true;
  if (a.aborted) m.aborted = true;
  if (a.agentId) m.agentId = a.agentId;
  if (a.prompt) m.prompt = a.prompt;
  if (a.worktreeBranch) m.worktreeBranch = a.worktreeBranch;
  if (a.sessionUrl) m.sessionUrl = a.sessionUrl;
  // …and what only the DETAIL view needs (#34). The rail shows none of these, but they are the join
  // keys and the source of the live transcript, so they belong in the one normalised read of a lane
  // rather than in a second accessor that could disagree with this one.
  if (a.outputFile) m.outputFile = a.outputFile;   // the agent's own JSONL transcript, live on disk
  if (a.texts && a.texts.length) m.texts = a.texts; // forwarded text (--forward-subagent-text)
  if (a.taskId) m.taskId = a.taskId;
  if (a.endStatus) m.endStatus = a.endStatus;      // completed | failed | killed | stopped | …
  if (a.depth) m.depth = a.depth;                  // >1 = spawned BY a subagent
  if (a.taskType) m.taskType = a.taskType;         // local_agent | local_workflow | local_bash | …
  // A stop the USER asked for (G6). Read here with the other join keys so the rail and the detail view
  // cannot disagree about it — and deliberately NOT folded into `status`: `stopAt` says „somebody pressed
  // ⏹", nothing more. Whether the task really ended is `status`/`endStatus`, and only laneFinish writes
  // those. public/js/task-stop.js stopView() is the one place the two are combined into a sentence.
  if (a.stopAt) m.stopAt = a.stopAt;
  if (a.stopError) m.stopError = a.stopError;        // the CLI's own sentence; there is no code on the wire
  if (a.endReason) m.endReason = a.endReason;        // 'worker_restart' → a 'stopped' that no click caused
  return m;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    laneFind, laneFindByTask, laneModelId, laneStart, laneLaunchStatus, laneToolResult, laneFinish,
    laneApplyTaskUsage, laneSystemEvent, laneStatsSettled, lanesAfterResult,
    lanesPruneStale, lanesSig, laneFaded, lanesPruneFaded, laneAppendText,
    laneElapsedMs, laneMetrics, LANE_STALE_MS, LANE_AFTERGLOW_MS,
  };
}
