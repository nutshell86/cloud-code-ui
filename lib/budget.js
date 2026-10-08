'use strict';
// PR-13 / U3 — the cost brake: a tab's budget that ALSO covers the agents `--max-budget-usd` never sees.
//
// WHY it exists (measured 2026-10-01, docs/ideas.md U3): a run launched with `--max-budget-usd 2` cost
// $3.80. The main session stopped at $2.13; its three workflow agents wrote SEPARATE transcripts
// (<session>/subagents/workflows/wf_<id>/agent-*.jsonl) worth another $1.67 and kept running after the
// parent's `result` — the CLI's budget and its subagent bookkeeping (`subagent_stats.spawned` stayed 0)
// simply do not include them. So the ceiling the user set in the tab menu was a ceiling on half the spend.
//
// HOW it counts: from the transcripts on disk, through the SAME fold and the SAME bucket pricing as the
// Usage view (lib/corpus sessionRecs → lib/usage priceBucket): the session's own file plus every
// subagent and workflow-agent file under it, deduped per message.id. One arithmetic for the page and the
// brake, so they cannot disagree about one session. And on the SERVER, not in the browser: a scheduled
// run nobody is watching is exactly where an unbounded workflow hurts, and it has no tab.
//
// WHAT it counts: spend since THIS PROCESS was launched — the cost of the session's files at launch is
// the baseline. That is what `--max-budget-usd` means too (the CLI's tracker is per process), and without
// it a resumed session would arrive „over budget" with yesterday's spend.
//
// WHAT IT CANNOT DO (said here so no surface claims more): a transcript line is written when an API answer
// is COMPLETE, so the brake sees an agent's spend one finished answer late, plus up to one poll interval.
// It is a brake, not a hard ceiling; how far a real run overshoots is what the PR's one paid measurement
// is for. Tokens of a model with no rate count as $0 and are reported as `unpricedTokens`, never hidden.
const fsp = require('fs/promises');
const path = require('path');
const { PROJECTS_DIR } = require('./paths');
const { sessionRecs } = require('./corpus');
const { priceBucket } = require('./usage');
const { errorText } = require('./core');

// CLAUDE_UI_BUDGET_POLL_MS is a test seam (same family as CLAUDE_UI_NO_SCHEDULER): an integration test
// should not wait 3 s per poll. Nothing in production sets it.
const BUDGET_POLL_MS = Number(process.env.CLAUDE_UI_BUDGET_POLL_MS) || 3000;
// A chat that has been quiet this long with no background task left is not polled any more (the
// watcher wakes up again with its next frame) — an idle tab must not stat its files every 3 s for hours.
const BUDGET_IDLE_MS = 120000;

// What one session's records cost, split by where it was spent. Pure: records in, dollars out.
function costOfRecs(recs) {
  const out = { total: 0, main: 0, subagents: 0, workflows: 0, unpricedTokens: 0, files: 0 };
  for (const rec of recs || []) {
    if (!rec || !rec.d) continue;
    out.files++;
    let c = 0;
    for (const day in rec.d) {
      const m = rec.d[day] && rec.d[day].m;
      for (const model in m || {}) {
        const p = priceBucket(model, m[model]);
        c += p.cost;
        if (!p.priced) out.unpricedTokens += p.tokens;
      }
    }
    out.total += c;
    if (rec.kind === 'workflow') out.workflows += c;
    else if (rec.kind === 'subagent') out.subagents += c;
    else out.main += c;
  }
  return out;
}

// Which BACKGROUND tasks are running, from the frames — the ids `stop_task` takes. Foreground agents are
// not tracked: the interrupt ends them with the turn, and they never get a `task_notification` (a stale id
// would only earn a „No task found" per trip). Two sources, because either can arrive first: the
// `task_started` of a backgrounded task or a workflow, and `background_tasks_changed`, the CLI's own live
// list. A task leaves on its terminal `task_updated` or its `task_notification`. Mutates `state`; returns
// whether a task STARTED (the one event a tripped brake has to answer at once).
const RUNNING_STATUS = new Set(['running', 'in_progress', 'pending', 'queued']);
function blankTasks() { return { started: new Map(), listed: new Set() }; }
function tasksAfterFrame(state, ev) {
  if (!state || !ev || ev.type !== 'system' || !ev.subtype) return false;
  const id = ev.task_id != null ? String(ev.task_id) : '';
  if (ev.subtype === 'task_started') {
    if (!id || !(ev.is_backgrounded === true || ev.task_type === 'local_workflow')) return false;
    state.started.set(id, { type: String(ev.task_type || ''), desc: String(ev.description || '') });
    return true;
  }
  if (ev.subtype === 'task_updated') {
    const st = ev.patch && ev.patch.status ? String(ev.patch.status) : '';
    if (id && st && !RUNNING_STATUS.has(st)) { state.started.delete(id); state.listed.delete(id); }
    return false;
  }
  if (ev.subtype === 'task_notification') {
    if (id) { state.started.delete(id); state.listed.delete(id); }
    return false;
  }
  if (ev.subtype === 'background_tasks_changed') {
    const list = Array.isArray(ev.tasks) ? ev.tasks : [];
    state.listed = new Set(list.filter((t) => t && t.task_id != null).map((t) => String(t.task_id)));
    return false;
  }
  return false;
}
function runningTaskIds(state) {
  if (!state) return [];
  return [...new Set([...state.started.keys(), ...state.listed])];
}

// The project directory a session's transcript lives in, found by the session id rather than rebuilt from
// the cwd: the CLI names it „cwd with every non-alphanumeric → '-'" (fake-claude.js mirrors that), while
// lib/core encodeProject only replaces : \ / — the two differ on any path with a dot or a space.
async function findSessionProject(session) {
  if (!session) return null;
  let dirs;
  try { dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }); } catch { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    try { await fsp.stat(path.join(PROJECTS_DIR, d.name, session + '.jsonl')); return d.name; } catch { /* not here */ }
  }
  return null;
}
async function sessionCost(session, project) {
  const proj = project || await findSessionProject(session);
  if (!proj) return { project: null, cost: costOfRecs([]) };
  return { project: proj, cost: costOfRecs(await sessionRecs(proj, session)) };
}

// One watcher per chat that HAS a budget (chat.meta.maxBudgetUsd). `deps` are the chat module's own
// actions, handed in so this file needs nothing from lib/chat (which requires it):
//   stopTask(chat, id) → Promise<{ok, error?}> · interrupt(chat) · broadcast(chat, ev)
// `deps.readCost(session, project)` and `deps.pollMs` exist for tests.
function createBudgetWatch(chat, deps) {
  const limitUsd = Number(chat && chat.meta && chat.meta.maxBudgetUsd);
  if (!(limitUsd > 0)) return null;
  const readCost = deps.readCost || sessionCost;
  const pollMs = deps.pollMs || BUDGET_POLL_MS;
  const sessionOf = () => chat.sessionId || chat.claudeSessionId || null;
  const w = {
    limitUsd, spentUsd: 0, parts: { main: 0, subagents: 0, workflows: 0 }, unpricedTokens: 0,
    tripped: false, trippedAtUsd: null, stopped: [], tasks: blankTasks(),
    lastActivity: Date.now(), timer: null, busy: false, ended: false,
    baseline: null, baselineSession: null, project: null, lastSent: '',
  };
  // The baseline belongs to ONE session id, and it is read ONCE per id (the pending promise is kept, so a
  // poll racing the launch read waits for it instead of reading a later state). Only a RESUME has spend
  // from before this process; a new session starts at zero. A fork learns its own id only with its first
  // frame and is counted from zero — if the CLI copies the source's history into the fork's file, that
  // over-counts, which makes the brake trip early, never late.
  const baselineFor = (session) => {
    if (w.baselineSession === session && w.baseline) return w.baseline;
    w.baselineSession = session;
    w.baseline = (async () => {
      if (!(session === chat.claudeSessionId && chat.meta && chat.meta.resume)) return costOfRecs([]);
      const r = await readCost(session, null);
      if (r.project) w.project = r.project;
      return r.cost;
    })();
    return w.baseline;
  };
  const publish = () => {
    const ev = {
      type: '_budget', limitUsd: w.limitUsd, spentUsd: round4(w.spentUsd), parts: roundParts(w.parts),
      unpricedTokens: w.unpricedTokens, tripped: w.tripped, trippedAtUsd: w.trippedAtUsd == null ? null : round4(w.trippedAtUsd),
      stopped: w.stopped, running: runningTaskIds(w.tasks).length,
    };
    const sig = JSON.stringify(ev);
    if (sig === w.lastSent) return;
    w.lastSent = sig;
    deps.broadcast(chat, ev);
  };
  const stopOne = async (id) => {
    let r;
    try { r = await deps.stopTask(chat, id); } catch (e) { r = { ok: false, error: errorText(e) }; }
    w.stopped.push({ id, ok: !!(r && r.ok), error: (r && r.error) || '' });
  };
  const trip = async () => {
    w.tripped = true;
    w.trippedAtUsd = w.spentUsd;
    // Interrupt FIRST: it ends the main turn, so nothing new is launched while the background tasks are
    // being stopped. It does not end them — measured: the workflow agents kept running after the parent's
    // `result` — which is why every one of them gets its own stop_task.
    try { deps.interrupt(chat); } catch { /* process gone */ }
    await Promise.all(runningTaskIds(w.tasks).map(stopOne));
    publish();
  };
  w.poll = async () => {
    if (w.busy || w.ended) return;
    const session = sessionOf();
    if (!session) return;
    w.busy = true;
    try {
      const base = await baselineFor(session);
      const r = await readCost(session, w.project);
      if (r.project) w.project = r.project;
      const c = r.cost;
      w.spentUsd = Math.max(0, c.total - base.total);
      w.parts = { main: Math.max(0, c.main - base.main), subagents: Math.max(0, c.subagents - base.subagents), workflows: Math.max(0, c.workflows - base.workflows) };
      w.unpricedTokens = Math.max(0, c.unpricedTokens - base.unpricedTokens);
      if (!w.tripped && w.spentUsd >= w.limitUsd) await trip();
      else publish();
    } catch { /* a transient read error — the next poll tries again */ } finally { w.busy = false; }
  };
  const tick = () => {
    const quiet = Date.now() - w.lastActivity > BUDGET_IDLE_MS;
    if (quiet && !runningTaskIds(w.tasks).length) return;
    w.poll();
  };
  w.onFrame = (ev) => {
    w.lastActivity = Date.now();
    const started = tasksAfterFrame(w.tasks, ev);
    // Once tripped, the brake stays on for the life of this process: a task launched afterwards (the turn
    // was already past the point the interrupt could stop) is stopped the moment it is announced.
    if (started && w.tripped) stopOne(String(ev.task_id)).then(publish);
  };
  w.stop = () => { w.ended = true; if (w.timer) { clearInterval(w.timer); w.timer = null; } };
  // A resume's baseline is read NOW, at launch — before the first answer of this process can be written
  // into the same file. Read on the first poll instead, a fast first answer would vanish into it.
  if (sessionOf()) baselineFor(sessionOf()).catch(() => { w.baseline = null; w.baselineSession = null; });
  w.timer = setInterval(tick, pollMs);
  if (w.timer.unref) w.timer.unref();
  return w;
}

function round4(n) { return Math.round(n * 1e4) / 1e4; }
function roundParts(p) { return { main: round4(p.main), subagents: round4(p.subagents), workflows: round4(p.workflows) }; }

module.exports = {
  BUDGET_POLL_MS, BUDGET_IDLE_MS, costOfRecs, blankTasks, tasksAfterFrame, runningTaskIds,
  findSessionProject, sessionCost, createBudgetWatch,
};
