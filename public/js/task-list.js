'use strict';
// U1 / PR-12 — the chat's task strip, fed by `TaskCreate`/`TaskUpdate` as well as `TodoWrite`. Browser
// (classic script) AND Node (require'd by test/task-list.test.js). Dependency-free, no DOM, no t().
//
// WHY: the strip read `TodoWrite` and nothing else. Counted over every transcript under ~/.claude/projects
// (606 *.jsonl files, 2026-10-03): **TodoWrite is called 0 times — in the whole corpus, not merely „since
// 2026-09-01"**. So the strip had no source at all and was dead surface.
//
// AND THE HALF OF THAT MEASUREMENT THAT ARGUES AGAINST A SWAP: TaskCreate (12) and TaskUpdate (18) are
// dormant too — the newest TaskCreate call is from 2026-07, every TaskUpdate is from 2026-06. Replacing
// one reader with another would have traded a source with zero calls for a source with zero RECENT calls
// and lost the old one on the way. So this module reads BOTH and keeps them apart by `src`; a TodoWrite
// call rewrites only the rows TodoWrite owns. Which of the two a future CLI uses is then not this
// module's problem.
//
// THE MEASURED SHAPES (and the one that is a trap):
//   TaskCreate  input  {subject, description, activeForm} ×11     ← the 12th call is a REFUSED {tasks:"[…]"}
//               result {task: {id, subject}}                      ← the id exists ONLY here, never in the input
//   TaskUpdate  input  {taskId, status} ×18       status: in_progress ×7 · completed ×11
//               result {success, taskId, updatedFields:["status"] ×18, statusChange:{from, to}}
//               from: pending ×11 · in_progress ×7 — so a fresh task is `pending`, which no TaskCreate
//               field says and which is therefore read off the first update of all eleven of them.
//   TodoWrite   input  {todos: [{content, status, activeForm}]}   (0 calls — the shape is the panel's
//               existing reader, kept verbatim so the swap cannot be the thing that breaks it)
// Status words OBSERVED: pending · in_progress · completed. A fourth word is passed through and shown
// verbatim rather than mapped onto one of these three — the same rule as workflow-lanes.js wfAgentState.
//
// HOW THE PANEL REALLY SEES A TaskUpdate — and why there are two functions for it, not one. The event pump
// gets the call and its answer in TWO frames: the `tool_use` in an assistant frame, the `tool_result` (plus
// the Output object `tool_use_result`) in a LATER user frame. Measured over the transcripts under
// ~/.claude/projects (622 *.jsonl, recursively, 2026-10-05): 30 Task* calls, 30 answers, every answer the only
// tool_result of its user message; all 18 TaskUpdate answers are `success: true`, and the one refusal (a
// TaskCreate) arrives with `is_error: true` and a plain-string Output. (Counted in transcript messages, not
// stream frames: the stream recordings on this machine — ccui-probe/runs, claude-scratch — hold no Task* call.)
// An earlier version had ONE function taking (request, answer) together — but the pump called it with the
// request alone, applied the wish at once, and called it again with the answer alone, by which time the row
// had already moved: „a refused update does not move the row" was a sentence the wired chain could not keep,
// and its id-mismatch guard was unreachable from every caller. So now:
//   taskUpdateAsked     the tool_use half — the wish is NOTED on the row, keyed by the tool_use id. Nothing moves.
//   taskUpdateAnswered  the tool_result half, paired with its own wish by that same id. Only here can a row
//                       move, and only on an answer that is not a refusal.

var TL_STATES = ['pending', 'in_progress', 'completed'];
function tlStr(v) { return (v == null) ? '' : String(v); }
// „Is this a word we have seen?" — a status we cannot place must not be silently drawn as `pending`,
// because `pending` is a claim („not started yet") and the honest answer is „this word is new".
function tlKnownState(s) { return TL_STATES.indexOf(tlStr(s)) >= 0; }

function tlFindById(list, id) {
  var want = tlStr(id);
  if (!want) return null;
  for (var i = 0; i < list.length; i++) if (list[i] && list[i].src === 'task' && tlStr(list[i].id) === want) return list[i];
  return null;
}
function tlFindByTool(list, toolId) {
  var want = tlStr(toolId);
  if (!want) return null;
  for (var i = 0; i < list.length; i++) if (list[i] && tlStr(list[i].toolId) === want) return list[i];
  return null;
}

// `TaskCreate` was CALLED. The row exists from here on, with no id yet — the id arrives with the result,
// and a strip that waited for it would show nothing while the task is being created.
// -> the row | null (nothing usable in the input)
function taskCreateSeen(list, toolId, input, now) {
  if (!Array.isArray(list)) return null;
  var o = (input && typeof input === 'object') ? input : null;
  if (!o) return null;
  var subject = tlStr(o.subject).trim();
  var desc = tlStr(o.description).trim();
  // The one refused call in the corpus passed `{tasks: "[…]"}` and no subject/description: an
  // InputValidationError, i.e. no task was created. Nothing to show, and inventing a row out of the
  // rejected payload would put a task in the strip that does not exist.
  if (!subject && !desc) return null;
  var row = tlFindByTool(list, toolId);
  if (!row) { row = { src: 'task', toolId: tlStr(toolId), id: '', status: 'pending', created: now || Date.now() }; list.push(row); }
  row.text = subject || desc;
  if (desc && desc !== row.text) row.detail = desc;
  if (o.activeForm) row.activeForm = tlStr(o.activeForm);
  return row;
}
// …and its RESULT, which is the only place the id is. Measured `{task:{id, subject}}`. Two other answers:
//  · `isError` — the CLI REFUSED the call (measured once: `is_error: true` with a plain-string Output). No task
//    was created, so the row the request put up is taken down again — but only while it has no id: a row
//    with an id was confirmed by an earlier answer and is not this refusal's to remove.
//  · anything else without a `task` (a string, nothing attributable) leaves the row id-less. It can then never
//    be updated, which is the truth — TaskUpdate takes the id and nothing else.
function taskCreateResult(list, toolId, out, isError) {
  if (!Array.isArray(list)) return false;
  var row = tlFindByTool(list, toolId);
  if (!row) return false;
  if (isError) {
    if (row.id) return false;
    list.splice(list.indexOf(row), 1);
    return true;
  }
  var t = (out && typeof out === 'object' && out.task && typeof out.task === 'object') ? out.task : null;
  if (!t || t.id == null) return false;
  var id = tlStr(t.id);
  if (!id || row.id === id) return false;
  row.id = id;
  if (t.subject && !row.text) row.text = tlStr(t.subject);
  return true;
}
// `TaskUpdate` was CALLED — `{taskId, status}`. The wish is noted on the row under the call's tool_use id and
// the row does NOT move: what was asked for is not what happened, and the answer that says which is one frame
// away — measured 93–370 ms after the call over all 18 TaskUpdate calls (transcript timestamps), so the strip
// waits a fraction of a second for it. Returns false — nothing the strip shows has changed.
// A wish for an id the strip does not know (a task from before a resume, or a typo) is dropped: there is no
// row to move, and none is invented.
function taskUpdateAsked(list, toolId, input) {
  if (!Array.isArray(list)) return false;
  var o = (input && typeof input === 'object') ? input : null;
  var tid = tlStr(toolId);
  if (!o || !tid) return false;
  var row = tlFindById(list, o.taskId);
  if (!row) return false;
  if (!row.asks) row.asks = [];
  row.asks.push({ toolId: tid, status: tlStr(o.status) });
  return false;
}
// …and its ANSWER, paired with the wish by the tool_use id (the pump attributes every tool_result BLOCK by
// that id — only the Output object next to it is ambiguous, see chat-events.js `soleOut`).
//  · `isError`                     refused → the wish is dropped, the row stays where it was.
//  · Output `{success: true, …}`   the answer wins: `statusChange.to`, else the wish.
//  · Output with `success` ≠ true  answered, and the answer was no → the row stays.
//  · Output names ANOTHER taskId   the pair cannot be attributed → the row stays (a move on a guess is worse).
//  · Output is a string            not the measured success shape → no confirmation, the row stays.
//  · no Output at all              a frame with several tool_results, so the Output could not be attributed.
//                                  The block itself carries no error, so the wish is applied — the one place
//                                  the strip takes the request as the answer, and it is not the measured case
//                                  (30 of 30 Task* answers stood alone in their message).
function taskUpdateAnswered(list, toolId, isError, out) {
  if (!Array.isArray(list)) return false;
  var tid = tlStr(toolId);
  if (!tid) return false;
  var row = null, ask = null;
  for (var i = 0; i < list.length && !row; i++) {
    var r = list[i];
    if (!r || r.src !== 'task' || !r.asks) continue;
    for (var k = 0; k < r.asks.length; k++) {
      if (r.asks[k].toolId === tid) { row = r; ask = r.asks[k]; r.asks.splice(k, 1); break; }
    }
  }
  if (!row) return false;
  if (!row.asks.length) delete row.asks;
  if (isError) return false;
  var to = '';
  if (out != null) {
    if (typeof out !== 'object') return false;
    if (out.success !== true) return false;
    var gotId = tlStr(out.taskId);
    if (gotId && gotId !== row.id) return false;
    to = (out.statusChange && tlStr(out.statusChange.to)) || ask.status;
  } else {
    to = ask.status;
  }
  if (!to || row.status === to) return false;
  row.status = to;
  return true;
}
// `TodoWrite` — the whole list at once, and only the rows it owns. Returns a NEW array (the caller assigns
// it), so a Task-sourced row that TodoWrite knows nothing about survives the rewrite.
// `created` is when a row's TEXT first appeared, not when the list was last written: TodoWrite has no partial update,
// so a model re-sends every row it keeps, and a fresh stamp on each made the ticked rows of a finished plan A new again
// with the first list written under plan B — and the step split (plan-progress.js planTaskMap, which holds `created`
// against the plan's line) put them, ticked, under B's steps. So a row whose text was in the previous TodoWrite list
// keeps that row's stamp (each old row lends its stamp once — two equal texts are two rows); only a text that is new
// gets the moment of this call.
function todoWriteApply(list, todos, now) {
  var prev = Array.isArray(list) ? list : [];
  var keep = prev.filter(function (r) { return r && r.src === 'task'; });
  var was = new Map(); // text → stamps of the previous TodoWrite rows, in their order (a Map: any text is a key, „__proto__" too)
  prev.forEach(function (r) {
    if (!r || r.src !== 'todo' || !r.text || typeof r.created !== 'number') return;
    if (!was.has(r.text)) was.set(r.text, []);
    was.get(r.text).push(r.created);
  });
  var rows = (Array.isArray(todos) ? todos : []).map(function (t, i) {
    var text = tlStr(t && (t.content || t.activeForm));
    var stamps = text ? was.get(text) : null;
    var old = (stamps && stamps.length) ? stamps.shift() : null;
    return {
      src: 'todo', id: 'todo-' + i, toolId: '', created: old !== null ? old : (now || Date.now()),
      text: text, activeForm: tlStr(t && t.activeForm),
      status: tlStr(t && t.status) || 'pending',
    };
  }).filter(function (r) { return !!r.text; });
  return keep.concat(rows);
}

// What the strip shows. „done" is `completed` and nothing else; an unknown status word is neither done nor
// silently pending — it is `unknown`, and the row prints the word.
// -> { rows: [{text, status, state, activeForm?, detail?, id}], done, total }
function taskListView(list) {
  var rows = (Array.isArray(list) ? list : []).filter(function (r) { return r && r.text; }).map(function (r) {
    var known = tlKnownState(r.status);
    return {
      id: tlStr(r.id) || tlStr(r.toolId), src: r.src, text: r.text, detail: r.detail || '',
      activeForm: r.activeForm || '', status: tlStr(r.status),
      state: known ? tlStr(r.status) : 'unknown',
    };
  });
  var done = 0;
  for (var i = 0; i < rows.length; i++) if (rows[i].state === 'completed') done++;
  return { rows: rows, done: done, total: rows.length };
}
// Repaint signature — the strip is rebuilt from scratch, so this only has to change when something the
// strip SHOWS changed.
function taskListSig(list) {
  return (Array.isArray(list) ? list : []).map(function (r) {
    return (r ? [r.src, r.id, r.toolId, r.status, r.text, r.activeForm].join(':') : '');
  }).join('|');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TL_STATES, tlKnownState, taskCreateSeen, taskCreateResult, taskUpdateAsked, taskUpdateAnswered, todoWriteApply,
    taskListView, taskListSig,
  };
}
