'use strict';
// The rail's sub-agent lanes (#32/#33). The fixtures are NOT invented: FRAMES below is the relevant
// slice of a real run — claude 2.1.274, 2026-09-17, one prompt that spawned TWO Explore agents into the
// background (199 recorded frames; the frame numbers in the comments are that recording's line numbers —
// it is not in the repo, the fixtures below ARE the evidence that survived it). That is the point of
// pinning them: both bugs behind #32 were assumptions about this
// stream, so a future CLI change has to break a test instead of a user's rail.
//
// Bug 1: the Agent tool_result of a backgrounded agent is a LAUNCH RECEIPT ("async_launched"), and it
//        arrives ~1 s after the start. It was read as „the agent is done" → the lane froze at „√ done"
//        with a stopped timer while the agent worked for another 169 s.
// Bug 2: the CLI writes SEVERAL result frames per run. The first one (frame 136, `result_index: 0`)
//        arrived with `subagent_stats {spawned: 2, completed: 0}` — the whole lane list was emptied there,
//        the group vanished and the rail folded itself away.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  laneStart, laneToolResult, laneFinish, laneSystemEvent, lanesAfterResult, lanesPruneStale,
  laneStatsSettled, lanesSig, laneMetrics, laneModelId, laneElapsedMs, LANE_STALE_MS,
  laneFaded, lanesPruneFaded, LANE_AFTERGLOW_MS, laneAppendText,
} = require('../public/js/agent-lanes');
// The last suite drives the REAL engine against the fake CLI (see the comment there). Both seams are read
// at spawn time, so setting them before requiring lib/chat is only for clarity — nothing else in this file
// spawns anything. Absolute path with forward slashes: the seam resolves against the CHAT cwd otherwise.
process.env.CLAUDE_UI_FAKE_BIN = path.join(__dirname, '..', 'fake-claude.js').replace(/\\/g, '/');
process.env.FAKE_CLAUDE_SCENARIO = 'bgagent';
const { startChat, sendToChat, killChat } = require('../lib/chat');

const A = 'toolu_bdrk_019jsWREyL2sfTtp1J7qkhAV', TA = 'adf219e685ce1bf7f';   // agent 1: "Dateien in C:\tmp auflisten"
const B = 'toolu_bdrk_016hgaxetQpfwk5eo2NHaXdp', TB = 'a6241d232b3fb14b2';   // agent 2: "a.txt in C:\tmp lesen"
const DA = 'Dateien in C:\\tmp auflisten', DB = 'a.txt in C:\\tmp lesen';
const bgTask = (id, description) => ({ task_id: id, task_type: 'local_agent', description });

const FRAMES = [
  // 60 — the assistant frame that spawns agent 1 (run_in_background is the CLI's DEFAULT for Agent)
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: A, name: 'Agent', input: { description: DA, subagent_type: 'Explore', prompt: 'Liste alle Dateinamen im Ordner C:\\tmp auf …', run_in_background: true } }] } },
  { type: 'system', subtype: 'background_tasks_changed', tasks: [bgTask(TA, DA)] },                                    // 61 — BEFORE task_started
  { type: 'system', subtype: 'task_started', task_id: TA, tool_use_id: A, description: DA, subagent_type: 'Explore', is_backgrounded: true, spawn_depth: 1, task_type: 'local_agent' }, // 62
  // 64 — the launch receipt: `tool_use_result` sits NEXT to the message, not in the tool_result block
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: A, content: 'Async agent launched successfully…' }] }, tool_use_result: { isAsync: true, status: 'async_launched', agentId: TA, description: DA, resolvedModel: 'eu.anthropic.claude-sonnet-5', prompt: 'Liste alle Dateinamen…', outputFile: 'C:\\…\\adf219e685ce1bf7f.output' } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: B, name: 'Agent', input: { description: DB, subagent_type: 'Explore', prompt: 'Prüfe, ob die Datei C:\\tmp\\a.txt existiert …', run_in_background: true } }] } }, // 99
  { type: 'system', subtype: 'background_tasks_changed', tasks: [bgTask(TA, DA), bgTask(TB, DB)] },                    // 100
  { type: 'system', subtype: 'task_started', task_id: TB, tool_use_id: B, description: DB, subagent_type: 'Explore', is_backgrounded: true, spawn_depth: 1, task_type: 'local_agent' }, // 101
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: B, content: 'Async agent launched successfully…' }] }, tool_use_result: { isAsync: true, status: 'async_launched', agentId: TB, description: DB, resolvedModel: 'eu.anthropic.claude-sonnet-5', prompt: 'Prüfe, ob die Datei…', outputFile: 'C:\\…\\a6241d232b3fb14b2.output' } }, // 103
  { type: 'system', subtype: 'task_progress', task_id: TA, tool_use_id: A, description: 'Finding *', subagent_type: 'Explore', usage: { total_tokens: 18724, tool_uses: 1, duration_ms: 2046 }, last_tool_name: 'Glob' }, // 108
  // 136 — „Beide Explore-Agenten laufen im Hintergrund … ich melde die Ergebnisse, sobald beide fertig sind."
  { type: 'result', subtype: 'success', is_error: false, result_index: 0, subagent_stats: { spawned: 2, requested: { background: 2, foreground: 0, unset: 0 }, started_in_background: 2, max_depth: 1, spawned_by_subagents: 0, completed: 0, failed: 0, killed: { parent: 0, user: 0, system: 0 }, refused: { depth_limit: 0, concurrency_limit: 0, budget: 0 }, by_type: { Explore: 2 } } },
];
// what came after the first result — agent 2 finishes, agent 1 keeps working
const FRAMES_TAIL = [
  { type: 'system', subtype: 'task_progress', task_id: TB, tool_use_id: B, description: 'Reading a.txt', subagent_type: 'Explore', usage: { total_tokens: 18941, tool_uses: 1, duration_ms: 5739 }, last_tool_name: 'Read' }, // 139
  { type: 'system', subtype: 'background_tasks_changed', tasks: [bgTask(TA, DA)] },                                    // 142 — agent 2 left the list
  { type: 'system', subtype: 'task_updated', task_id: TB, patch: { status: 'completed', end_time: 1789654118127 } },   // 143
  { type: 'system', subtype: 'task_notification', task_id: TB, tool_use_id: B, status: 'completed', summary: 'nicht vorhanden', output_file: 'C:\\…\\a6241d232b3fb14b2.output', usage: { total_tokens: 20031, tool_uses: 1, duration_ms: 7206 } }, // 144
  { type: 'result', subtype: 'success', is_error: false, result_index: 1, subagent_stats: { spawned: 2, started_in_background: 2, completed: 1, failed: 0, killed: { parent: 0, user: 0, system: 0 } } }, // 165
  { type: 'system', subtype: 'task_progress', task_id: TA, tool_use_id: A, description: 'Reading verify.js', subagent_type: 'Explore', usage: { total_tokens: 51102, tool_uses: 9, duration_ms: 169048 }, last_tool_name: 'Read' }, // 197
];

// Bug 3 (same bug as 2, in the ERROR path): „the turn failed, so its children died with it" is also just
// an assumption. Two more real captures of the same CLI, both with ONE backgrounded Explore agent:
//
//   the recorded MAX-TURNS run (40 frames) — the turn is killed by `--max-turns` after 13 s. The
//   `result` frame says `subtype: 'error_max_turns', is_error: true` and, in the SAME frame,
//   `subagent_stats {spawned:1, completed:0, killed:{0,0,0}}`: the agent is untouched. It works another
//   37 s (7 task_progress frames) and then reports `task_notification {status:'completed'}` with its
//   totals and a summary. Retiring the lane at the result frame made the row disappear 1 s after the
//   start and threw that completion away — #32, reached from every failed turn (API 429/529, budget).
const C = 'toolu_bdrk_01MgrdHnucnmPKgs1U5VBT3p', TC = 'ab617986d565f7f84';
const DC = 'List and inspect JS files in C:\\tmp';
const MAXTURNS = [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: C, name: 'Agent', input: { description: DC, subagent_type: 'Explore', run_in_background: true, prompt: 'Aufgabe (nur lesend, kein Bash …)' } }] } }, // 4
  { type: 'system', subtype: 'background_tasks_changed', tasks: [bgTask(TC, DC)] },                                    // 5
  { type: 'system', subtype: 'task_started', task_id: TC, tool_use_id: C, description: DC, subagent_type: 'Explore', is_backgrounded: true, spawn_depth: 1, task_type: 'local_agent' }, // 6
  // 8 — the turn is over and it FAILED, but its own stats show an untouched sub-agent
  { type: 'result', subtype: 'error_max_turns', is_error: true, subagent_stats: { spawned: 1, requested: { background: 1, foreground: 0, unset: 0 }, started_in_background: 1, max_depth: 1, spawned_by_subagents: 0, completed: 0, failed: 0, killed: { parent: 0, user: 0, system: 0 }, refused: { depth_limit: 0, concurrency_limit: 0, budget: 0 }, by_type: { Explore: 1 } } },
];
const MAXTURNS_TAIL = [
  { type: 'system', subtype: 'task_progress', task_id: TC, tool_use_id: C, description: 'Finding **/*', subagent_type: 'Explore', usage: { total_tokens: 19029, tool_uses: 1, duration_ms: 2490 }, last_tool_name: 'Glob' }, // 11
  { type: 'system', subtype: 'task_progress', task_id: TC, tool_use_id: C, description: 'Reading verify2.js', subagent_type: 'Explore', usage: { total_tokens: 25521, tool_uses: 7, duration_ms: 30420 }, last_tool_name: 'Read' }, // 31
  { type: 'system', subtype: 'background_tasks_changed', tasks: [] },                                                  // 34
  { type: 'system', subtype: 'task_updated', task_id: TC, patch: { status: 'completed', end_time: 1789659417124 } },   // 35
  { type: 'system', subtype: 'task_notification', task_id: TC, tool_use_id: C, status: 'completed', summary: '## Bericht: .js-Dateien in C:\\tmp …', output_file: 'C:\\…\\ab617986d565f7f84.output', usage: { total_tokens: 33907, tool_uses: 7, duration_ms: 37344 } }, // 36
  { type: 'result', subtype: 'success', is_error: false, subagent_stats: { spawned: 1, started_in_background: 1, completed: 1, failed: 0, killed: { parent: 0, user: 0, system: 0 } } }, // 39
];
//   the recorded INTERRUPT run (15 frames) — Stop pressed while the agent ran. THAT is what a
//   real kill looks like, and the CLI announces it three times over BEFORE the turn's result frame, so
//   nothing has to be guessed from is_error: an empty background list (frame 9),
//   `task_updated {patch.status:'killed'}` (10) and `task_notification {status:'stopped'}` (11). The
//   result at frame 14 counts the kill in `killed: {…, system: 1}` too — but that counter is a SESSION
//   running total and must not be read per frame (see the two-turn test below). Frame 15 is another
//   `user` frame: the process lives on, so no `_exit` follows either.
const K = 'toolu_bdrk_017aKi94g7FMBR5TSJewdukG', TK = 'a2ecf84f0ca522aef';
const DK = 'List and count lines of first five .js files in C:\\tmp';
const INTERRUPT = [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: K, name: 'Agent', input: { description: DK, subagent_type: 'Explore', prompt: 'Arbeite ausschließlich lesend …' } }] } }, // 5
  { type: 'system', subtype: 'background_tasks_changed', tasks: [bgTask(TK, DK)] },                                    // 6
  { type: 'system', subtype: 'task_started', task_id: TK, tool_use_id: K, description: DK, subagent_type: 'Explore', is_backgrounded: true, spawn_depth: 1, task_type: 'local_agent' }, // 7
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: K, content: 'Async agent launched successfully…' }] }, tool_use_result: { isAsync: true, status: 'async_launched', agentId: TK, description: DK, resolvedModel: 'eu.anthropic.claude-sonnet-5' } }, // 8
];
// the three frames of the real kill — every one of them arrives BEFORE the result frame
const INTERRUPT_KILL = [
  { type: 'system', subtype: 'background_tasks_changed', tasks: [] },                                               // 9
  { type: 'system', subtype: 'task_updated', task_id: TK, patch: { status: 'killed', end_time: 1789659231039 } },   // 10
  { type: 'system', subtype: 'task_notification', task_id: TK, tool_use_id: K, status: 'stopped', summary: DK, output_file: 'C:\\…\\a2ecf84f0ca522aef.output' }, // 11
];
const INTERRUPT_RESULT = { type: 'result', subtype: 'error_during_execution', is_error: true, subagent_stats: { spawned: 1, requested: { background: 0, foreground: 0, unset: 1 }, started_in_background: 1, max_depth: 1, spawned_by_subagents: 0, completed: 0, failed: 0, killed: { parent: 0, user: 0, system: 1 }, refused: { depth_limit: 0, concurrency_limit: 0, budget: 0 }, by_type: { Explore: 1 } } }; // 14
// The SAME max-turns result as MAXTURNS[3], but with the stats a session that already killed one agent
// really reports: `subagent_stats` are running totals (CLI doc: „Cumulative like modelUsage"), so the
// earlier `killed.system: 1` is still in there while the NEW background agent is untouched
// (spawned 2, completed 0). The two recordings chained into ONE session is what exposed this; the test
// „never re-reads the session-wide kill counters" below replays exactly that chain.
const MAXTURNS_RESULT_AFTER_KILL = { type: 'result', subtype: 'error_max_turns', is_error: true, subagent_stats: { spawned: 2, requested: { background: 1, foreground: 0, unset: 1 }, started_in_background: 2, max_depth: 1, spawned_by_subagents: 0, completed: 0, failed: 0, killed: { parent: 0, user: 0, system: 1 }, refused: { depth_limit: 0, concurrency_limit: 0, budget: 0 }, by_type: { Explore: 2 } } };

// Mirrors the wiring in public/js/chat-events.js — assistant → laneStart, user → laneToolResult with the
// frame's `tool_use_result`, system → laneSystemEvent, result → lanesAfterResult. Kept here so the test
// exercises the same dispatch the pump uses.
function feed(state, ev, now) {
  if (ev.type === 'assistant') {
    ((ev.message && ev.message.content) || []).filter((b) => b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task'))
      .forEach((b) => laneStart(state.lanes, { id: b.id, input: b.input }, now));
  } else if (ev.type === 'user') {
    const res = ((ev.message && ev.message.content) || []).filter((b) => b && b.type === 'tool_result');
    const sole = res.length === 1 ? (ev.tool_use_result || null) : null;
    res.forEach((b) => laneToolResult(state.lanes, { id: b.tool_use_id, isError: !!b.is_error, out: sole }, now));
  } else if (ev.type === 'system') {
    laneSystemEvent(state.lanes, ev, now);
  } else if (ev.type === 'result') {
    state.lanes = lanesAfterResult(state.lanes, ev, now);
  }
  return state;
}
function replay(frames, state) {
  const s = state || { lanes: [] };
  frames.forEach((ev, i) => feed(s, ev, 1000 + i * 1000));
  return s;
}
const byId = (s, id) => s.lanes.find((x) => x.id === id);
// Replay with timestamps around NOW, so the real lanesPruneStale() sees a fresh lane (the fixed 1970
// timestamps of replay() would look 30 min idle to it and close every lane).
function replayNow(frames) {
  const base = Date.now() - 5000;
  const s = { lanes: [] };
  frames.forEach((ev, i) => feed(s, ev, base + i * 10));
  return s;
}
// public/js/chat-render.js is a browser script (no exports, needs the whole app's globals), so the few
// functions that decide what a row SAYS are lifted out of the source by name and run against fake globals
// — that way the wiring itself is under test, not a copy of it: the row updater tickAgentMeta() (the one
// place that keeps a RUNNING row in sync without a rail repaint) and the two builders of the row's badges
// and tooltip.
const RENDER_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat-render.js'), 'utf8');
function loadRenderFn(name, env) {
  const m = RENDER_SRC.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
  assert.ok(m, name + '() not found in public/js/chat-render.js — renamed or reindented?');
  const names = Object.keys(env);
  return new Function(...names, m[0] + '\nreturn ' + name + ';')(...names.map((k) => env[k]));
}
function loadTicker(env) { return loadRenderFn('tickAgentMeta', env); }

describe('#32 — a lane may only end when its agent really ended', () => {
  it('keeps BOTH lanes running through the first result frame (the reported bug)', () => {
    const s = replay(FRAMES);
    assert.equal(s.lanes.length, 2, 'the result frame emptied the list — that is the bug');
    assert.deepEqual(s.lanes.map((a) => a.status), ['running', 'running']);
    assert.equal(byId(s, A).type, 'Explore');
    assert.equal(byId(s, B).desc, DB);
  });

  it('reads the launch receipt as a start, not as a result', () => {
    const s = replay(FRAMES.slice(0, 4));
    const a = byId(s, A);
    assert.equal(a.status, 'running');
    assert.equal(a.launched, 'async_launched');
    assert.equal(a.bg, true);
    assert.equal(a.model, 'eu.anthropic.claude-sonnet-5'); // the receipt DOES name the model (#33)
  });

  it('still ends a FOREGROUND agent on its tool_result (the counter-test)', () => {
    const lanes = [];
    laneStart(lanes, { id: 'fg1', input: { subagent_type: 'Plan', description: 'Plan schreiben', run_in_background: false } }, 1000);
    // a foreground Agent answers with the completed AgentOutput (schema: sdk-tools.d.ts AgentOutput)
    const out = {
      status: 'completed', agentId: 'x9', resolvedModel: 'claude-sonnet-5', totalTokens: 20031, totalToolUseCount: 4,
      totalDurationMs: 7206, usage: { input_tokens: 12, output_tokens: 800, cache_read_input_tokens: 19000, cache_creation_input_tokens: 200 },
      toolStats: { readCount: 3, searchCount: 1, bashCount: 0, editFileCount: 1, linesAdded: 12, linesRemoved: 3, otherToolCount: 0 },
    };
    laneToolResult(lanes, { id: 'fg1', isError: false, out }, 8206);
    const m = laneMetrics(lanes[0]);
    assert.equal(m.status, 'done');
    assert.equal(m.tokens, 20031);
    assert.equal(m.toolUses, 4);
    assert.equal(m.reads, 3);
    assert.equal(m.linesAdded, 12);
    assert.equal(m.elapsedMs, 7206, 'the agent\'s own duration wins over our wall clock once it is over');
    assert.ok(m.usage, 'the per-token-type usage is what makes a cost possible at all');
  });

  it('believes task_started over the request when the CLI declined to background an agent', () => {
    // `run_in_background: true` is only a REQUEST — with a depth/concurrency limit the CLI runs the agent
    // in the foreground, and then its tool_result is the real result. Trusting the request would hang it.
    const lanes = [];
    laneStart(lanes, { id: 'fg2', input: { subagent_type: 'Explore', description: 'doch vorne', run_in_background: true } }, 1000);
    laneSystemEvent(lanes, { type: 'system', subtype: 'task_started', task_id: 'tf', tool_use_id: 'fg2', description: 'doch vorne', is_backgrounded: false }, 1100);
    assert.equal(lanes[0].bg, false);
    laneToolResult(lanes, { id: 'fg2', isError: false, out: null }, 5000);
    assert.equal(lanes[0].status, 'done', 'a foreground lane ends on its tool_result, receipt or not');
  });

  it('ends a backgrounded agent on its task_notification and enriches the already-closed lane', () => {
    const s = replay(FRAMES.concat(FRAMES_TAIL.slice(0, 4)));
    const b = byId(s, B);
    assert.equal(b.status, 'done');
    assert.equal(b.summary, 'nicht vorhanden');
    assert.equal(b.tokens, 20031);          // the notification's usage refined the progress numbers
    assert.equal(b.toolUses, 1);
    assert.equal(byId(s, A).status, 'running', 'agent 1 was still working');
  });

  it('keeps a finished lane next to its still-working sibling (the CLI writes a result per agent)', () => {
    const s = replay(FRAMES.concat(FRAMES_TAIL));
    assert.equal(s.lanes.length, 2, 'agent 2 must not flash by for a second — agent 1 is still running');
    assert.deepEqual(s.lanes.map((a) => a.status), ['running', 'done']);
    assert.equal(byId(s, A).tokens, 51102, 'the last progress frame still lands on the surviving lane');
  });

  // #34 changed WHEN the group clears: not at the result frame any more (that was one or two seconds
  // after the agent reported back), but when the afterglow of the last finished lane runs out.
  it('keeps the finished group for its afterglow, then clears it', () => {
    const s = replay(FRAMES.concat(FRAMES_TAIL));
    feed(s, { type: 'system', subtype: 'task_notification', task_id: TA, tool_use_id: A, status: 'completed', summary: '7 Dateien', usage: { total_tokens: 51500, tool_uses: 9, duration_ms: 172000 } }, 300000);
    assert.equal(s.lanes.length, 2, 'the last agent just reported — its numbers are the point of the row');
    feed(s, { type: 'result', subtype: 'success', is_error: false, result_index: 2, subagent_stats: { spawned: 2, completed: 2, failed: 0, killed: { parent: 0, user: 0, system: 0 } } }, 301000);
    // Agent A reported a second ago → its row survives the result frame (that is #34). Agent B ended
    // ~5 minutes earlier in this replay, so ITS afterglow is long over and the same frame retires it —
    // the two halves of the rule in one assertion.
    assert.deepEqual(s.lanes.map((a) => a.id), [A], 'the fresh row must survive the result frame, the stale one must not');
    assert.equal(s.lanes[0].status, 'done');
    assert.equal(s.lanes[0].summary, '7 Dateien', '…as a record, with everything it reported');
    feed(s, { type: 'result', subtype: 'success', is_error: false, result_index: 3 }, 301000 + LANE_AFTERGLOW_MS + 1);
    assert.equal(s.lanes.length, 0);
  });

  it('is idempotent against duplicate frames (two sources describe the same lane)', () => {
    // the assistant frame, task_started and the launch receipt all describe the SAME lane — and a
    // reconnect can deliver any of them twice. Only the frames that OPEN a lane are repeated here; a
    // re-sent background list is not a duplicate but a contradiction (see the guard test above).
    const spawns = FRAMES.filter((f) => f.type === 'assistant' || f.type === 'user' || f.subtype === 'task_started');
    const s = replay(FRAMES);
    replay(spawns, s);
    replay(FRAMES_TAIL.slice(0, 4), s);
    assert.equal(s.lanes.length, 2, 'a replayed spawn must not open a second lane');
    // a progress frame arriving AFTER the end must not resurrect the lane
    laneSystemEvent(s.lanes, { type: 'system', subtype: 'task_progress', task_id: TB, tool_use_id: B, description: 'Reading a.txt', usage: { total_tokens: 99999, tool_uses: 7 } }, 99000);
    const b = byId(s, B);
    assert.equal(b.status, 'done');
    assert.equal(b.tokens, 20031, 'a late progress frame must not overwrite the final numbers');
  });

  it('only lets the background list close a lane it had listed before', () => {
    const lanes = [];
    laneStart(lanes, { id: 'l1', input: { subagent_type: 'Explore', description: 'eins', run_in_background: true } }, 1000);
    laneSystemEvent(lanes, { type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'l1', description: 'eins', is_backgrounded: true }, 1100);
    laneStart(lanes, { id: 'l2', input: { subagent_type: 'Explore', description: 'zwei', run_in_background: true } }, 1200);
    // a list that contains t1 only: l1 is alive, l2 has never been in any list → nothing is said about it
    laneSystemEvent(lanes, { type: 'system', subtype: 'background_tasks_changed', tasks: [bgTask('t1', 'eins')] }, 1300);
    assert.deepEqual(lanes.map((a) => a.status), ['running', 'running']);
    // the next list drops t1 → THAT lane ended (it was in the list a moment ago); l2 is still untouched
    laneSystemEvent(lanes, { type: 'system', subtype: 'background_tasks_changed', tasks: [] }, 1400);
    assert.deepEqual(lanes.map((a) => a.status), ['done', 'running']);
  });

  it('joins a lane to its task by description when the list arrives before task_started', () => {
    // capture frames 61/100: the list came first, so the lane had no task_id to match on yet
    const s = replay(FRAMES.slice(0, 2));
    assert.equal(byId(s, A).taskId, TA);
    assert.equal(byId(s, A).inBgList, true);
  });

  it('closes what is left when the run reports every sub-agent settled (a lost notification)', () => {
    const s = replay(FRAMES);
    const settled = { type: 'result', subtype: 'success', is_error: false, result_index: 2, subagent_stats: { spawned: 2, completed: 2, failed: 0, killed: { parent: 0, user: 0, system: 0 } } };
    feed(s, settled, 200000);
    // The point of this test is that nothing keeps SPINNING. Since #34 a closed lane still shows for
    // its afterglow, so „closed" is asserted on the status, and „does not hang" on the prune.
    assert.deepEqual(s.lanes.map((a) => a.status), ['done', 'done'], 'nothing may hang for ever — a settled run ends its lanes');
    assert.equal(lanesPruneFaded(s.lanes, 200000 + LANE_AFTERGLOW_MS + 1).length, 0, 'and they leave when their window is over');
  });

  it('counts killed sub-agents as settled, but never a refused one', () => {
    assert.equal(laneStatsSettled({ spawned: 2, completed: 1, failed: 0, killed: { parent: 1, user: 0, system: 0 } }), true);
    assert.equal(laneStatsSettled({ spawned: 2, completed: 1, failed: 0, killed: { parent: 0, user: 0, system: 0 } }), false);
    assert.equal(laneStatsSettled({ spawned: 2, completed: 0, failed: 2 }), true);
    assert.equal(laneStatsSettled({ spawned: 0, completed: 0 }), false, 'a run without sub-agents says nothing about lanes');
    assert.equal(laneStatsSettled(null), false);
  });

  // Measured on the recorded max-turns run: a FAILED turn is not a statement about its sub-agents.
  // This used to drop every running lane, which reproduced #32 in the error path — the row vanished 1 s
  // after the start (rail folds itself away), and the completion 37 s later had no lane left to land on.
  it('keeps a background lane that the failed turn did NOT kill (measured max-turns capture)', () => {
    const s = replay(MAXTURNS);
    assert.equal(s.lanes.length, 1, 'the error result emptied the list although its own stats say completed:0/killed:0');
    assert.equal(s.lanes[0].status, 'running');
    assert.equal(s.lanes[0].aborted, undefined, 'nothing aborted this agent — the TURN ran out of turns');
    // …and the agent's real end still arrives and still lands on that lane
    replay(MAXTURNS_TAIL.slice(0, 5), s);
    const a = s.lanes[0];
    assert.equal(a.status, 'done');
    assert.equal(a.tokens, 33907);
    assert.equal(a.toolUses, 7);
    assert.match(a.summary, /^## Bericht: \.js-Dateien/);
    // the next turn's result reports everything settled → now the group may go
    feed(s, MAXTURNS_TAIL[5], 400000);
    assert.equal(s.lanes.length, 0);
  });

  // Measured on the recorded interrupt run: a real kill needs no inference at all — it is on the
  // wire three times over, and all three frames arrive BEFORE the result that ends the interrupted turn.
  it('closes a killed lane from the kill frames themselves, before any result frame', () => {
    const s = replay(INTERRUPT.concat(INTERRUPT_KILL));
    assert.equal(s.lanes.length, 1);
    assert.equal(s.lanes[0].status, 'error', 'the kill frames — not the result — are what ends this lane');
    assert.equal(s.lanes[0].endStatus, 'stopped');
    feed(s, INTERRUPT_RESULT, 200000);
    assert.equal(s.lanes.length, 0, 'the result frame then retires the row');
    // each of the three says it on its own: task_updated alone closes the lane just as well
    const s2 = replay(INTERRUPT);
    laneSystemEvent(s2.lanes, INTERRUPT_KILL[1], 9000);
    assert.equal(s2.lanes[0].status, 'error');
    assert.equal(s2.lanes[0].endStatus, 'killed');
    // …and so does the background list going empty (frame 9) on its own
    const s3 = replay(INTERRUPT);
    laneSystemEvent(s3.lanes, INTERRUPT_KILL[0], 9000);
    assert.notEqual(s3.lanes[0].status, 'running');
  });

  // …which is why the result's OWN kill counters may not be read: `subagent_stats` are the session's
  // running totals, so after one Stop anywhere `killed > 0` holds for every later frame of that session.
  // Two real recordings chained into ONE session: the interrupt run first, then the max-turns
  // run whose stats still carry that `killed.system: 1`. Reading it per frame dropped the healthy
  // background lane at `error_max_turns` (1 → 0) and its notification 37 s later landed nowhere — #32 again.
  it('never re-reads the session-wide kill counters as a statement about this frame', () => {
    const s = replay(INTERRUPT.concat(INTERRUPT_KILL));                  // turn 1: the Stop, lane closed
    feed(s, INTERRUPT_RESULT, 20000);
    assert.deepEqual(s.lanes.map((a) => a.status), ['error'], 'the killed lane is closed (and readable for its afterglow, #34)');
    s.lanes = lanesPruneFaded(s.lanes, 20000 + LANE_AFTERGLOW_MS + 1);   // …the ticker retires it
    assert.equal(s.lanes.length, 0);
    replay(MAXTURNS.slice(0, 3), s);                                     // turn 2: a fresh background agent
    assert.equal(s.lanes.length, 1);
    feed(s, MAXTURNS_RESULT_AFTER_KILL, 40000);                          // the turn fails, stats carry turn 1's kill
    assert.equal(s.lanes.length, 1, 'a kill from an earlier turn is not this frame killing this agent');
    assert.equal(s.lanes[0].status, 'running');
    // and its real end still lands: the notification 37 s later finds its lane
    replay(MAXTURNS_TAIL.slice(0, 5), s);
    assert.equal(s.lanes[0].status, 'done');
    assert.equal(s.lanes[0].tokens, 33907);
    assert.match(s.lanes[0].summary, /^## Bericht: \.js-Dateien/);
  });

  it('still takes a FOREGROUND lane with the failed turn (nothing else could ever end it)', () => {
    const lanes = [];
    laneStart(lanes, { id: 'fg3', input: { subagent_type: 'Plan', description: 'vorne', run_in_background: false } }, 1000);
    const s = { lanes };
    feed(s, { type: 'result', subtype: 'error_during_execution', is_error: true, result_index: 1 }, 5000);
    assert.deepEqual(s.lanes.map((a) => a.status), ['error'], 'a foreground agent has no lifecycle frames of its own — this IS its end');
    assert.equal(s.lanes[0].aborted, true);
    assert.equal(lanesPruneFaded(s.lanes, 5000 + LANE_AFTERGLOW_MS + 1).length, 0, 'and it must not linger past its afterglow');
  });

  it('closes a lane that went silent — as "outcome unknown", not as done', () => {
    const s = replay(FRAMES);
    assert.equal(lanesPruneStale(s.lanes, 20000), false, 'a live agent must never be pruned');
    const t = 20000 + LANE_STALE_MS;
    assert.equal(lanesPruneStale(s.lanes, t), true);
    assert.deepEqual(s.lanes.map((a) => a.status), ['error', 'error']);
    assert.equal(s.lanes[0].stale, true);
    assert.equal(lanesPruneStale(s.lanes, t + LANE_STALE_MS), false, 'nothing left to prune');
  });

  it('marks an interrupted lane as aborted instead of successful (Stop emits no _exit)', () => {
    const s = replay(FRAMES);
    s.lanes.forEach((a) => laneFinish(a, { at: 50000, isError: true, aborted: true }));
    assert.deepEqual(s.lanes.map((a) => a.status), ['error', 'error']);
    assert.equal(laneMetrics(s.lanes[0]).aborted, true);
    // The result frame that ends the interrupted turn used to drop them on the spot. Since #34 they
    // stay readable for the afterglow — „why did this stop?" is exactly the question an interrupt
    // leaves behind — and the clock retires them.
    feed(s, { type: 'result', subtype: 'success', is_error: false, result_index: 1 }, 51000);
    assert.equal(s.lanes.length, 2, 'an aborted agent must not vanish before it can be read');
    feed(s, { type: 'result', subtype: 'success', is_error: false, result_index: 2 }, 51000 + LANE_AFTERGLOW_MS + 1);
    assert.equal(s.lanes.length, 0);
  });

  it('ends a background lane whose Agent tool itself failed (no notification will come)', () => {
    const s = replay(FRAMES.slice(0, 3));
    // e.g. the tool was denied: an error tool_result without a usable tool_use_result
    feed(s, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: A, is_error: true, content: 'Claude requested permissions to use Agent, but you have not granted it yet.' }] } }, 5000);
    assert.equal(byId(s, A).status, 'error');
  });

  it('opens a lane for a nested agent that has no assistant frame of its own', () => {
    const lanes = [];
    laneSystemEvent(lanes, { type: 'system', subtype: 'task_started', task_id: 'tn', tool_use_id: 'nested1', description: 'Unterauftrag', subagent_type: 'Explore', is_backgrounded: false, spawn_depth: 2 }, 1000);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].depth, 2);
    assert.equal(lanes[0].status, 'running');
  });

  it('never creates a lane from a progress frame alone', () => {
    const lanes = [];
    laneSystemEvent(lanes, { type: 'system', subtype: 'task_progress', task_id: 'zz', tool_use_id: 'zz', usage: { total_tokens: 5 } }, 1000);
    assert.equal(lanes.length, 0);
  });
});

describe('#33 — the lane says what the CLI reported, and nothing else', () => {
  it('reports the live activity of a running agent (phase · last tool · own tokens)', () => {
    const s = replay(FRAMES);
    const m = laneMetrics(byId(s, A), 30000);
    assert.equal(m.live, true);
    assert.equal(m.phase, 'Finding *');       // task_progress.description = the CURRENT activity
    assert.equal(m.desc, DA, 'the task identity must survive — it is what tells two Explore lanes apart');
    assert.equal(m.lastTool, 'Glob');
    assert.equal(m.tokens, 18724);
    assert.equal(m.toolUses, 1);
    assert.equal(m.bg, true);
  });

  it('leaves out what was never reported instead of showing a zero', () => {
    const lanes = [];
    laneStart(lanes, { id: 'x', input: { subagent_type: 'Explore', description: 'frisch' } }, 1000);
    const m = laneMetrics(lanes[0], 1500);
    assert.equal('tokens' in m, false);
    assert.equal('toolUses' in m, false);
    assert.equal('model' in m, false);
    assert.equal('usage' in m, false, 'no usage → the renderer cannot show a cost, which is the point');
    assert.equal(m.elapsedMs, 500);
  });

  it('drops the gateway prefix so the model can be named and priced', () => {
    assert.equal(laneModelId('eu.anthropic.claude-sonnet-5'), 'claude-sonnet-5');
    assert.equal(laneModelId('anthropic.claude-opus-5-v1:0'), 'claude-opus-5');
    assert.equal(laneModelId('claude-opus-5'), 'claude-opus-5');
    assert.equal(laneModelId(''), '');
    assert.equal(laneModelId(null), '');
  });

  // #33 asks for „alle Infos, die im normalen Chat Status auch angezeigt werden", and the status strip
  // names the model for the WHOLE turn (unconditionally, see chat-status.js). The lane only had it once the
  // agent was over (and in the tooltip) — although a backgrounded agent's launch receipt already reports
  // `resolvedModel` at the very start (capture frame 64), so the one line that was missing it is the one
  // that runs for minutes. The shortening has to be the SAME as on a finished row, not a second format.
  it('names the model on a RUNNING lane, shortened exactly like on a finished one', () => {
    const env = { agentNum: (n) => String(n), shortModel: (x) => String(x).replace(/^claude-/, '') };
    const liveText = loadRenderFn('agentLiveText', env);
    const statsText = loadRenderFn('agentStatsText', env);
    const s = replay(FRAMES.concat(FRAMES_TAIL));   // A at „Reading verify.js" (live), B reported back
    const live = laneMetrics(byId(s, A), 30000), done = laneMetrics(byId(s, B), 99999);
    assert.equal(live.live, true);
    assert.equal(live.model, 'claude-sonnet-5', 'the receipt named it — the lane must not lose it again');
    assert.equal(liveText(live), '▸ Reading verify.js · sonnet-5 · Σ 51102 tok · 🔧 9');
    assert.equal(statsText(done).split(' · ')[0], liveText(live).split(' · ')[1], 'one shortening, not two');
    // …and nothing invented while no frame has named a model yet: no „undefined", no empty separator
    const lanes = [];
    laneStart(lanes, { id: 'nm', input: { subagent_type: 'Explore', description: 'ohne Modell' } }, 1000);
    laneSystemEvent(lanes, { type: 'system', subtype: 'task_started', task_id: 'tnm', tool_use_id: 'nm', description: 'ohne Modell', is_backgrounded: true }, 1100);
    laneSystemEvent(lanes, { type: 'system', subtype: 'task_progress', task_id: 'tnm', tool_use_id: 'nm', description: 'Finding *', usage: { total_tokens: 5 } }, 1200);
    const unknown = laneMetrics(lanes[0], 1300);
    assert.equal('model' in unknown, false);
    assert.equal(liveText(unknown), '▸ Finding * · Σ 5 tok');
  });

  it('stops the clock at the end and prefers the agent\'s own duration', () => {
    const s = replay(FRAMES.concat(FRAMES_TAIL.slice(0, 4)));
    const b = byId(s, B);
    assert.equal(laneElapsedMs(b, 999999), 7206);
    const a = byId(s, A);
    assert.ok(laneElapsedMs(a, 999999) > laneElapsedMs(a, 20000), 'a running lane keeps ticking');
  });

  // …but only if the agent really REPORTED that duration at its end. `durMs` is also fed by every
  // task_progress, and such a snapshot is not a duration: measured (capture frame 108) agent 1's only
  // sign of life was one progress frame with `usage.duration_ms: 2046`. Goes it quiet after that,
  // lanesPruneStale closes the lane half an hour later — and taking the snapshot as the final duration
  // made the row say „2s" and the tooltip „Dauer: 2s" right next to „no signal any more from this agent".
  it('never sells a task_progress snapshot as the duration of a silent lane', () => {
    const s = replay(FRAMES.slice(0, 9));            // … up to agent 1's first task_progress (2046 ms)
    const a = byId(s, A);
    assert.equal(a.durMs, 2046, 'the progress frame did carry a duration');
    const t = 9000 + LANE_STALE_MS;
    assert.equal(lanesPruneStale(s.lanes, t), true);
    const m = laneMetrics(a, t);
    assert.equal(m.stale, true);
    assert.equal(m.elapsedMs, t - 1000, 'without a closing report the wall clock is the only honest number');
    assert.ok(m.elapsedMs >= LANE_STALE_MS);
  });

  // Same rule for the row's own status statements. Measured in the two-agent capture: after FRAMES_TAIL
  // lane B has reported back (√ done, 7 s, summary „nicht vorhanden") while lane A really is still
  // working. The ⏳ badge and the tooltip line „Läuft im Hintergrund weiter — die Zeile bleibt, bis der
  // Agent selbst fertig meldet." hung on m.bg alone, so BOTH rows carried that promise — a wrong fact at
  // exactly the spot the user reads as a status. They belong to m.live.
  it('drops the background promise as soon as the agent has reported back', () => {
    const s = replay(FRAMES.concat(FRAMES_TAIL.slice(0, 4)));
    const done = laneMetrics(byId(s, B), 99999), live = laneMetrics(byId(s, A), 99999);
    assert.equal(done.status, 'done');
    assert.equal(done.bg, true, 'it WAS a background agent — that is why the badge hung on it');
    assert.equal(done.live, false);
    assert.equal(live.live, true);
    const el = (tag, cls, txt) => ({ tag, cls, txt, title: '' });
    const badges = loadRenderFn('agentBadges', { el, tt: (k) => k });
    assert.deepEqual(badges(live).map((b) => b.txt), ['⏳'], 'the agent that IS running keeps its hourglass');
    assert.deepEqual(badges(done).map((b) => b.txt), [], 'a lane that reported back must not claim to still run');
    // fmtInt (render.js) since NUM-LOC: the token figure is formatted in the PANEL's language, not the
    // browser's. Supplied as the real thing would behave for de — the tooltip's wording is what is asserted
    // below, so a locale-exact stub would only make this fixture brittle.
    const title = loadRenderFn('agentLaneTitle', { tt: (k) => k, shortModel: (x) => x, laneModelId, fmtInt: (n) => String(n) });
    assert.match(title(live), /chat-render\.agentHintergrund/);
    assert.doesNotMatch(title(done), /chat-render\.agentHintergrund/, 'the tooltip promised a run that was over');
    assert.match(title(done), /chat-render\.agentDauer/, '…while its closing facts stay');
  });

  it('keeps the repaint signature free of the live numbers (they tick in place)', () => {
    const s = replay(FRAMES);
    const before = lanesSig(s.lanes);
    feed(s, { type: 'system', subtype: 'task_progress', task_id: TA, tool_use_id: A, description: 'Reading verify.js', usage: { total_tokens: 40000, tool_uses: 5, duration_ms: 90000 }, last_tool_name: 'Read' }, 90000);
    assert.equal(lanesSig(s.lanes), before, 'a progress frame must not force a rail repaint');
    feed(s, FRAMES_TAIL[3], 95000); // the notification for agent 2 → structural
    assert.notEqual(lanesSig(s.lanes), before);
  });

  // The tooltip is the LONG FORM of the very same live facts as the third line (current activity, last
  // tool, tokens, tool calls). The ticker used to write only `.agent-meta` and `.agent-live`, while the
  // tooltip was built once per STRUCTURAL repaint — and `task_progress` deliberately triggers none (see
  // the signature test above). A background agent's tooltip therefore stayed empty for its whole run, or
  // showed a sibling-repaint's stale activity next to the current one in the same row.
  it('the 1 s ticker rewrites the tooltip too, not just the live line', () => {
    const s = replayNow(FRAMES.concat(FRAMES_TAIL)); // lane A ends up at „Reading verify.js" / 51102 tok / 9 tools
    assert.equal(byId(s, A).status, 'running');
    const kids = { '.agent-meta': { textContent: '' }, '.agent-live': { textContent: '' } };
    const row = { dataset: { agentLane: A }, title: '', querySelector: (sel) => kids[sel] || null };
    const tick = loadTicker({
      ACTIVE: { agents: s.lanes },
      document: { querySelectorAll: () => [row] },
      lanesPruneStale,                                            // the real one: a fresh lane must survive it
      lanesPruneFaded,                                            // …and the real afterglow prune (#34)
      // G6 — the ticker also watches the stop signature, because „Stopp angefordert" → „unbestätigt"
      // happens on the CLOCK with no frame arriving. The REAL one, so this test proves the other half too:
      // with no stop anywhere it must stay '' and cause no repaint (renderAgentStrip asserts that below).
      stopSig: require('../public/js/task-stop').stopSig,
      renderAgentStrip: () => assert.fail('a live update must not repaint the rail'),
      laneMetrics,
      agentLiveText: (m) => '▸ ' + (m.phase || m.lastTool || '') + ' · Σ ' + (m.tokens || 0) + ' tok · 🔧 ' + (m.toolUses || 0),
      // same shape as the real long form, without dragging chat-render.js's i18n/pricing helpers in
      agentLaneTitle: (m) => ['Aktuell: ' + (m.phase || ''), 'Letztes Tool: ' + (m.lastTool || ''),
        'Tokens: ' + (m.tokens || 0), 'Tool-Aufrufe: ' + (m.toolUses || 0)].join('\n'),
      ensureAgentTimer: () => {},
    });
    tick();
    assert.match(kids['.agent-meta'].textContent, /^⏱ \d+s$/);
    assert.match(kids['.agent-live'].textContent, /▸ Reading verify\.js .*51102 tok · 🔧 9/);
    assert.match(row.title, /Aktuell: Reading verify\.js/, 'the tooltip never followed the live line');
    assert.match(row.title, /Letztes Tool: Read/);
    assert.match(row.title, /Tokens: 51102/);
    assert.match(row.title, /Tool-Aufrufe: 9/);
  });

  it('reports the honest reason a silent lane was closed', () => {
    const lanes = [];
    laneStart(lanes, { id: 's1', input: { subagent_type: 'Explore', description: 'still', run_in_background: true } }, 1000);
    lanesPruneStale(lanes, 1000 + LANE_STALE_MS + 1);
    const m = laneMetrics(lanes[0]);
    assert.equal(m.status, 'error');
    assert.equal(m.stale, true);
    assert.equal('summary' in m, false, 'a lane without a result must not claim one');
  });
});

// ---------------------------------------------------------------------------------------------------
// End to end. Everything above replays a transcript from a variable — which proves the state machine but
// not that these frames still arrive this way through a real process. The live smoke (smoke-test.js)
// cannot close that gap: it speaks HTTP against the server and has NO DOM, so „a lane appears" is not
// observable in it at all. What IS observable without a browser is the layer directly under the paint, so
// the scenario is covered here instead of with a fake assertion over there:
//   fake-claude.js (FAKE_CLAUDE_SCENARIO=bgagent) writes the captured background-agent sequence to a real
//   stdout → the REAL engine (lib/chat.js — the same startChat/readline/broadcast the SSE route uses,
//   through its `onEvent` headless seam) parses and relays it → feed() above, the mirror of the browser
//   pump, turns it into lanes. So a scenario that drifts from the protocol, or an engine that swallows the
//   `system` frames or the receipt's `tool_use_result`, fails here — not on a user's rail.
// #32 in one assertion: the lane count AT the first result frame must still be 1.
// ---------------------------------------------------------------------------------------------------
describe('#32 end to end — the frames come off a real process, through the real engine', () => {
  it('scenario bgagent: the lane survives the first result and is retired by the last', async () => {
    const state = { lanes: [] };
    const seen = [], atResult = [];
    let closed = null;
    const chat = startChat({ cwd: path.join(__dirname, '..'), permissionMode: 'plan' });
    try {
      await new Promise((resolve) => {
        const bail = setTimeout(resolve, 15000);      // no frames / a broken scenario → the asserts below say so
        chat.onEvent = (ev) => {
          seen.push(ev);
          feed(state, ev, Date.now());
          if (ev.type === 'system' && ev.subtype === 'task_notification') closed = Object.assign({}, state.lanes[0]);
          if (ev.type !== 'result') return;
          atResult.push({ lanes: state.lanes.length, status: state.lanes.map((a) => a.status) });
          if (atResult.length === 2) { clearTimeout(bail); resolve(); }
        };
        sendToChat(chat, 'Dateien auflisten, im Hintergrund');
      });
    } finally { try { killChat(chat); } catch { /* */ } }

    // the wire really carried the shapes the fixtures above pin (nothing here is asserted against a mock)
    assert.ok(seen.some((e) => e.type === 'user' && e.tool_use_result && e.tool_use_result.status === 'async_launched'),
      'no async_launched receipt on the wire — the scenario or the engine dropped tool_use_result');
    assert.ok(seen.some((e) => e.type === 'system' && e.subtype === 'task_started' && e.is_backgrounded === true), 'no task_started');
    assert.ok(seen.some((e) => e.type === 'system' && e.subtype === 'task_progress' && e.usage), 'no task_progress with usage');
    assert.equal(atResult.length, 2, 'the scenario writes one result WHILE the agent runs and one at the end');

    // …and #32 itself: at the first result the agent is still working, so its lane may not go
    assert.deepEqual(atResult[0], { lanes: 1, status: ['running'] }, 'the first result emptied the list — that IS the bug');
    // the agent's own end lands on that lane, with the numbers and the summary of its closing report
    assert.ok(closed, 'no task_notification reached a lane');
    assert.equal(closed.status, 'done');
    assert.equal(closed.tokens, 20031);
    assert.equal(closed.summary, '7 Dateien gefunden');
    // …and the finished lane STAYS for its afterglow (#34). Before that it was dropped by this very
    // frame, roughly a second after the agent reported back — which is why nobody ever got to read
    // what it had found. It leaves on the clock instead; the suite below pins that end.
    assert.deepEqual(atResult[1], { lanes: 1, status: ['done'] }, 'the last result must KEEP the just-finished lane (afterglow)');
    assert.equal(lanesPruneFaded(state.lanes, Date.now() + LANE_AFTERGLOW_MS + 1).length, 0, 'and it must be gone once the window is over');

    // The agent really wrote its own transcript where the receipt said it would — the file the detail
    // view tails. Asserted here because this is the only place a REAL process produced that path.
    const receipt = seen.find((e) => e.tool_use_result && e.tool_use_result.status === 'async_launched').tool_use_result;
    const { agentOutputPathOk, parseAgentOutput } = require('../lib/agent-output');
    assert.ok(agentOutputPathOk(receipt.outputFile), 'the CLI-reported path must be one the panel may read: ' + receipt.outputFile);
    const { events } = parseAgentOutput(fs.readFileSync(receipt.outputFile, 'utf8'));
    assert.ok(events.some((e) => e.kind === 'tool' && e.name === 'Glob'), 'the agent-s own tool calls must be in its transcript');
    assert.ok(events.some((e) => e.kind === 'text' && /7 Dateien/.test(e.text)), 'the closing report must be in its transcript');
    try { fs.rmSync(receipt.outputFile, { force: true }); } catch { /* temp */ }
  });
});

// ---------------------------------------------------------------------------------------------------
// #34 — the afterglow. A finished lane used to be dropped by the next result frame with nothing else
// running, i.e. one or two seconds after the agent reported back: its model, tokens, cost, tool
// breakdown and summary went with it. Now it survives LANE_AFTERGLOW_MS and is dropped by the clock.
// The two failure modes this pins are opposite: "disappears too early" (the bug) and "stays forever"
// (what a careless fix produces — a rail that slowly turns into a session log).
// ---------------------------------------------------------------------------------------------------
describe('#34 afterglow — a finished lane is readable for a while, then it goes', () => {
  const t0 = 1_700_000_000_000;
  const finished = (end) => ({ id: 'x', status: 'done', start: end - 5000, end, lastSignal: end });
  const okResult = { type: 'result', subtype: 'success', is_error: false };

  it('laneFaded: running never fades, finished fades only after the window', () => {
    assert.equal(laneFaded({ id: 'r', status: 'running', start: t0 }, t0 + LANE_AFTERGLOW_MS * 5), false);
    assert.equal(laneFaded(finished(t0), t0 + 1000), false);
    assert.equal(laneFaded(finished(t0), t0 + LANE_AFTERGLOW_MS - 1), false);
    assert.equal(laneFaded(finished(t0), t0 + LANE_AFTERGLOW_MS), true);
  });

  it('a result frame with nothing running KEEPS the fresh lane and drops the expired one', () => {
    const fresh = lanesAfterResult([finished(t0)], okResult, t0 + 1000);
    assert.equal(fresh.length, 1, 'the row must not vanish a second after the agent reported back');
    const old = lanesAfterResult([finished(t0)], okResult, t0 + LANE_AFTERGLOW_MS + 1);
    assert.equal(old.length, 0, 'an expired lane must not survive a result frame either');
  });

  it('a lane still RUNNING is never dropped by the afterglow rules (that is #32)', () => {
    const lanes = [{ id: 'a', status: 'running', bg: true, start: t0, lastSignal: t0 }, finished(t0)];
    const after = lanesAfterResult(lanes, okResult, t0 + LANE_AFTERGLOW_MS + 1);
    assert.equal(after.length, 2, 'while a sibling works, the finished row stays with it');
    assert.equal(lanesPruneFaded(after, t0 + LANE_AFTERGLOW_MS + 1).length, 1, 'the ticker drops only the expired one');
  });

  it('lanesPruneFaded returns the SAME array when nothing expired (the repaint hangs on identity)', () => {
    const lanes = [finished(t0)];
    assert.equal(lanesPruneFaded(lanes, t0 + 1000), lanes, 'a new array here would repaint the rail every second');
    assert.notEqual(lanesPruneFaded(lanes, t0 + LANE_AFTERGLOW_MS), lanes);
  });

  it('a lane closed without an end time does not become immortal', () => {
    const noEnd = { id: 'n', status: 'done', start: t0 };
    assert.equal(laneFaded(noEnd, t0 + LANE_AFTERGLOW_MS), true);
  });
});

// ---------------------------------------------------------------------------------------------------
// U1 — `subagent_stats` does not count WORKFLOW agents (`spawned` stays 0 for a pure workflow run). So when a
// session runs a subagent AND a workflow, „every subagent has settled" is true as soon as the subagent is
// done — and the result frame used to close the still-running workflow lane with it (found 2026-10-05 while
// checking #92's planTabBackground, which asks exactly „is anything still running in this tab?").
// ---------------------------------------------------------------------------------------------------
describe('U1 — a settled SUBAGENT count does not close a running workflow', () => {
  const sys = (subtype, extra) => Object.assign({ type: 'system', subtype }, extra);
  const settledResult = { type: 'result', subtype: 'success', is_error: false, subagent_stats: { spawned: 1, completed: 1, failed: 0, killed: { parent: 0, user: 0, system: 0 } } };

  it('subagent done + workflow running → after the result the workflow lane is STILL running', () => {
    const lanes = [];
    laneSystemEvent(lanes, sys('task_started', { task_id: 'bg1', tool_use_id: 'tu1', description: 'Explore', subagent_type: 'Explore', is_backgrounded: true, task_type: 'local_agent' }), 1);
    laneSystemEvent(lanes, sys('task_started', { task_id: 'wf1', tool_use_id: 'tu2', description: 'Workflow', is_backgrounded: true, task_type: 'local_workflow' }), 1);
    laneSystemEvent(lanes, sys('task_notification', { task_id: 'bg1', tool_use_id: 'tu1', status: 'completed' }), 2);
    const after = lanesAfterResult(lanes, settledResult, 3);
    const wf = after.find((a) => a.taskId === 'wf1');
    assert.ok(wf, 'the workflow lane is still in the list');
    assert.equal(wf.status, 'running', 'subagent_stats knows nothing about workflow agents — its „settled" must not end one');
    assert.equal(after.find((a) => a.taskId === 'bg1').status, 'done');
  });

  it('…and the workflow still ends through its OWN frame', () => {
    const lanes = [];
    laneSystemEvent(lanes, sys('task_started', { task_id: 'wf1', tool_use_id: 'tu2', description: 'Workflow', is_backgrounded: true, task_type: 'local_workflow' }), 1);
    const after = lanesAfterResult(lanes, settledResult, 2);
    laneSystemEvent(after, sys('task_notification', { task_id: 'wf1', tool_use_id: 'tu2', status: 'completed' }), 3);
    assert.notEqual(after.find((a) => a.taskId === 'wf1').status, 'running');
  });

  it('a settled count still closes a running SUBAGENT lane (the rule itself is unchanged)', () => {
    const lanes = [{ id: 'tu9', type: 'agent', desc: 'x', status: 'running', start: 1, bg: true, taskId: 'bg9' }];
    const after = lanesAfterResult(lanes, settledResult, 2);
    assert.equal(after[0].status, 'done');
  });
});

// ---------------------------------------------------------------------------------------------------
// --forward-subagent-text (CLI 2.1.275, fixed for stream-json there). Measured on 2.1.278 why this is
// needed at all: a FOREGROUND subagent's `.output` file is created and stays EMPTY, and the parent
// session transcript holds no sidechain line for it — so the forwarded frames are the only record of
// its work that exists anywhere. The frames carry `parent_tool_use_id`, i.e. the lane id.
// ---------------------------------------------------------------------------------------------------
describe('#34 forwarded subagent text', () => {
  const laneWith = () => {
    const lanes = [];
    laneStart(lanes, { id: 'fg1', input: { subagent_type: 'Explore', description: 'probe', run_in_background: false } }, 1000);
    return lanes;
  };

  it('keeps text and thinking on the lane, in order', () => {
    const lanes = laneWith();
    assert.equal(laneAppendText(lanes, 'fg1', 'erst denken', 'thinking', 1100), true);
    assert.equal(laneAppendText(lanes, 'fg1', 'dann schreiben', 'text', 1200), true);
    const m = laneMetrics(lanes[0]);
    assert.deepEqual(m.texts.map((x) => x.kind), ['thinking', 'text']);
    assert.equal(m.texts[1].text, 'dann schreiben');
  });

  it('ignores an unknown lane and empty blocks — a late frame must not create a row', () => {
    const lanes = laneWith();
    assert.equal(laneAppendText(lanes, 'nope', 'text', 'text'), false);
    assert.equal(laneAppendText(lanes, 'fg1', '   ', 'text'), false);
    assert.equal(laneAppendText(lanes, 'fg1', null, 'text'), false);
    assert.equal(lanes.length, 1);
    assert.equal('texts' in laneMetrics(lanes[0]), false, 'no text = no empty section in the detail view');
  });

  it('caps a chatty agent by blocks AND by characters, dropping the OLDEST', () => {
    const lanes = laneWith();
    for (let i = 0; i < 80; i++) laneAppendText(lanes, 'fg1', 'block ' + i, 'text', 1000 + i);
    const texts = laneMetrics(lanes[0]).texts;
    assert.ok(texts.length <= 50, 'block cap');
    assert.equal(texts[texts.length - 1].text, 'block 79', 'the closing report is the part worth keeping');

    const lanes2 = laneWith();
    laneAppendText(lanes2, 'fg1', 'x'.repeat(7000), 'text', 1000);
    laneAppendText(lanes2, 'fg1', 'y'.repeat(7000), 'text', 1001);
    const t2 = laneMetrics(lanes2[0]).texts;
    assert.ok(t2.reduce((n, x) => n + x.text.length, 0) <= 8000 + 7000, 'character cap trims from the front');
    assert.equal(t2[t2.length - 1].text[0], 'y');
  });

  it('forwarded text counts as a signal, so the stale guard does not close a working agent', () => {
    const lanes = laneWith();
    const t = 1000 + LANE_STALE_MS + 1;
    laneAppendText(lanes, 'fg1', 'ich arbeite noch', 'text', t - 10);
    assert.equal(lanesPruneStale(lanes, t), false, 'an agent that just spoke is not silent');
  });
});
