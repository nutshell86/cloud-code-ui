'use strict';
// U1 / PR-12 — the chat's task strip. Module + BOTH readers: the strip (chat-render.js renderTodoStrip) and
// the status line's working verb (chat-status.js activeTodoPhase). The second reader is in here because it is
// exactly the one that would have gone quietly blind: it read `tab.todos`, the feed moved to `tab.taskList`,
// and nothing in the UI would have said so — the strip above it would simply have filled up while the status
// line stayed empty for ever.
//
// THE MEASUREMENT behind the change, counted over every transcript under ~/.claude/projects (606 *.jsonl,
// 2026-10-03):
//   TodoWrite   0 calls — in the WHOLE corpus, not just „since 2026-09-01". The strip had no feed at all.
//   TaskCreate  12 calls. Shape {subject, description, activeForm} ×11, result {task:{id, subject}}.
//               The 12th is a REFUSED {tasks:"[…]"} call (InputValidationError) — no task was created.
//   TaskUpdate  18 calls. Shape {taskId, status}: in_progress ×7, completed ×11.
//               Result {success, taskId, updatedFields:["status"] ×18, statusChange:{from,to}};
//               `from` is pending ×11 / in_progress ×7, which is the only evidence that a fresh task is
//               `pending` — no TaskCreate field says so.
// …and the half that argues against a SWAP: the newest TaskCreate call is from 2026-07, every TaskUpdate is
// from 2026-06. Both feeds are dormant. So both are read, and neither replaces the other.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  TL_STATES, tlKnownState, taskCreateSeen, taskCreateResult, taskUpdateAsked, taskUpdateAnswered, todoWriteApply,
  taskListView, taskListSig,
} = require('../public/js/task-list');
const { eventPump, frames } = require('./event-pump');

// verbatim from the corpus (the ZWD_XSS_MEHRARBEIT research run)
const CREATE_IN = {
  subject: 'WD-Komponente ZWD_XSS_MEHRARBEIT strukturieren',
  description: 'Views, Windows, Component Controller, Assistance Class und Kontextknoten der Web-Dynpro-Komponente ermitteln',
  activeForm: 'Erkunde WD-Komponentenstruktur',
};
const CREATE_OUT = { task: { id: '1', subject: 'WD-Komponente ZWD_XSS_MEHRARBEIT strukturieren' } };
const UPD_OUT = (to, from) => ({ success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: from || 'pending', to } });
// One TaskUpdate the way the pump really delivers it: the call (tool_use) FIRST, its answer in a LATER frame.
// The first version of this file called one function with both halves at once — an order the panel never
// produces (Blocker 2 of the adversarial review). `tu` is the tool_use id that pairs the two.
function update(list, tu, input, answer) {
  taskUpdateAsked(list, tu, input);
  return taskUpdateAnswered(list, tu, !!(answer && answer.isError), answer ? answer.out : undefined);
}

describe('U1 — TaskCreate/TaskUpdate feed the strip', () => {
  it('a created task appears BEFORE its id arrives, and adopts the id from the result', () => {
    const list = [];
    assert.ok(taskCreateSeen(list, 'tu1', CREATE_IN));
    assert.equal(list.length, 1);
    assert.equal(list[0].id, '', 'the input carries no id — the row must not wait for one');
    assert.equal(list[0].status, 'pending', 'measured: every first update reports from:"pending"');
    assert.equal(taskCreateResult(list, 'tu1', CREATE_OUT), true);
    assert.equal(list[0].id, '1');
    const v = taskListView(list);
    assert.equal(v.rows[0].text, CREATE_IN.subject, 'the SUBJECT is the one-line text');
    assert.equal(v.rows[0].detail, CREATE_IN.description, '…and the long description is the tooltip');
    assert.equal(v.rows[0].activeForm, 'Erkunde WD-Komponentenstruktur');
    assert.equal(v.total, 1);
    assert.equal(v.done, 0);
  });

  it('the REFUSED {tasks:"[…]"} call creates no row (it created no task either)', () => {
    const list = [];
    assert.equal(taskCreateSeen(list, 'tu9', { tasks: '[{"description":"x","status":"pending"}]' }), null);
    assert.equal(list.length, 0, 'a row out of a rejected payload is a task that does not exist');
    // …and a result with no `task` leaves the row id-less rather than inventing one
    taskCreateSeen(list, 'tu10', CREATE_IN);
    assert.equal(taskCreateResult(list, 'tu10', 'InputValidationError: […]'), false);
    assert.equal(list[0].id, '');
  });

  it('the update moves the row through the measured status words', () => {
    const list = [];
    taskCreateSeen(list, 'tu1', CREATE_IN);
    taskCreateResult(list, 'tu1', CREATE_OUT);
    assert.equal(update(list, 'tu2', { taskId: '1', status: 'in_progress' }, { out: UPD_OUT('in_progress') }), true);
    assert.equal(taskListView(list).rows[0].state, 'in_progress');
    assert.equal(update(list, 'tu3', { taskId: '1', status: 'completed' }, { out: UPD_OUT('completed', 'in_progress') }), true);
    const v = taskListView(list);
    assert.equal(v.rows[0].state, 'completed');
    assert.equal(v.done, 1);
  });

  it('the CALL alone moves nothing — the row waits for the answer (the order the pump really delivers)', () => {
    // This is the half Blocker 2 was about: the call arrives a frame BEFORE its answer, and applying the wish
    // right there is what let a refusal arrive too late to keep the row where it was.
    const list = [];
    taskCreateSeen(list, 'tu1', CREATE_IN);
    taskCreateResult(list, 'tu1', CREATE_OUT);
    assert.equal(taskUpdateAsked(list, 'tu2', { taskId: '1', status: 'completed' }), false, 'nothing the strip shows has changed');
    assert.equal(taskListView(list).rows[0].state, 'pending');
    assert.equal(taskUpdateAnswered(list, 'tu2', false, UPD_OUT('completed')), true);
    assert.equal(taskListView(list).rows[0].state, 'completed');
    assert.equal(list[0].asks, undefined, 'the answered wish is gone — it cannot be answered twice');
  });

  it('the RESULT beats the request — a refused update must not move the row', () => {
    const list = [];
    taskCreateSeen(list, 'tu1', CREATE_IN);
    taskCreateResult(list, 'tu1', CREATE_OUT);
    assert.equal(update(list, 'tu2', { taskId: '1', status: 'completed' }, { out: { success: false } }), false);
    assert.equal(taskListView(list).rows[0].state, 'pending');
    // …and the answer wins even when it differs from what was asked
    update(list, 'tu3', { taskId: '1', status: 'completed' }, { out: UPD_OUT('in_progress') });
    assert.equal(taskListView(list).rows[0].state, 'in_progress');
  });

  it('a call the CLI refused (`is_error`) does not move the row — the measured form of a refusal', () => {
    // Measured: the one refused Task* call of the corpus came back with `is_error: true` and a plain-string
    // Output. The result half used to skip `is_error` entirely, AFTER the call half had already moved the row.
    const list = [];
    taskCreateSeen(list, 'tu1', CREATE_IN);
    taskCreateResult(list, 'tu1', CREATE_OUT);
    assert.equal(update(list, 'tu2', { taskId: '1', status: 'completed' }, { isError: true, out: 'InputValidationError: …' }), false);
    assert.equal(taskListView(list).rows[0].state, 'pending');
    // a string Output WITHOUT the error flag is not the measured success shape either — no confirmation, no move
    assert.equal(update(list, 'tu3', { taskId: '1', status: 'completed' }, { out: 'Updated task #1 status' }), false);
    assert.equal(taskListView(list).rows[0].state, 'pending');
  });

  it('with NO Output object the requested status is applied (the several-tool_results frame)', () => {
    // chat-events.js can only attribute `tool_use_result` when the frame carries ONE tool_result. With two,
    // the BLOCK is still attributed by its tool_use_id and carries no error — so the wish stands, and this is
    // the one place the strip takes the request for the answer. Not the measured case: 30 of 30 Task*
    // answers in the corpus transcripts stood alone in their user message.
    const list = [];
    taskCreateSeen(list, 'tu1', CREATE_IN);
    taskCreateResult(list, 'tu1', CREATE_OUT);
    assert.equal(update(list, 'tu2', { taskId: '1', status: 'in_progress' }, { out: null }), true);
    assert.equal(taskListView(list).rows[0].state, 'in_progress');
  });

  it('an update for an unknown id changes nothing', () => {
    const list = [];
    taskCreateSeen(list, 'tu1', CREATE_IN);
    taskCreateResult(list, 'tu1', CREATE_OUT);
    const other = Object.assign(UPD_OUT('completed'), { taskId: '42' });
    assert.equal(update(list, 'tu2', { taskId: '42', status: 'completed' }, { out: other }), false);
    assert.equal(taskListView(list).rows[0].state, 'pending');
  });

  it('a pair whose request and answer name DIFFERENT ids moves nothing', () => {
    // Reachable now, which the old guard was not: the pair is formed by the tool_use id, so the wish for row 1
    // and an Output naming task 7 really are one call and its answer. Attribution of `tool_use_result` is only
    // safe for a single-result frame (chat-events.js soleOut); if the two sides still disagree, picking either
    // one would move a row on a guess.
    const list = [];
    taskCreateSeen(list, 'tu1', CREATE_IN);
    taskCreateResult(list, 'tu1', CREATE_OUT);
    assert.equal(update(list, 'tu2', { taskId: '1', status: 'completed' }, { out: Object.assign(UPD_OUT('completed'), { taskId: '7' }) }), false);
    assert.equal(taskListView(list).rows[0].state, 'pending');
  });

  it('an answer nobody asked for (unknown tool_use id) moves nothing', () => {
    const list = [];
    taskCreateSeen(list, 'tu1', CREATE_IN);
    taskCreateResult(list, 'tu1', CREATE_OUT);
    assert.equal(taskUpdateAnswered(list, 'tu-nobody', false, UPD_OUT('completed')), false);
    assert.equal(taskListView(list).rows[0].state, 'pending');
  });

  it('a REFUSED TaskCreate takes its row down again — no task exists', () => {
    // The row goes up at the call (so the strip is not empty while the task is created) — and the refusal has
    // to take it down, or the strip shows a task the CLI never made. A row that already has its id was
    // confirmed by an earlier answer and stays.
    const list = [];
    taskCreateSeen(list, 'tu1', CREATE_IN);
    assert.equal(list.length, 1);
    assert.equal(taskCreateResult(list, 'tu1', 'Error: …', true), true);
    assert.equal(list.length, 0);
    taskCreateSeen(list, 'tu2', CREATE_IN);
    taskCreateResult(list, 'tu2', CREATE_OUT);
    assert.equal(taskCreateResult(list, 'tu2', 'Error: …', true), false, 'a confirmed row is not this refusal\'s to remove');
    assert.equal(list.length, 1);
  });
});

describe('U1 — a status word nobody measured is not silently drawn as „pending"', () => {
  it('the three measured words are known, everything else is `unknown`', () => {
    assert.deepEqual(TL_STATES, ['pending', 'in_progress', 'completed']);
    for (const s of TL_STATES) assert.equal(tlKnownState(s), true, s);
    for (const s of ['blocked', 'cancelled', 'paused', '', null, undefined]) assert.equal(tlKnownState(s), false, String(s));
  });

  it('…and the row keeps the raw word so it can be shown', () => {
    const list = [];
    taskCreateSeen(list, 'tu1', CREATE_IN);
    taskCreateResult(list, 'tu1', CREATE_OUT);
    update(list, 'tu2', { taskId: '1', status: 'blocked' }, { out: UPD_OUT('blocked') });
    const r = taskListView(list).rows[0];
    assert.equal(r.state, 'unknown', '„pending" would claim „not started yet" about a word we have not seen');
    assert.equal(r.status, 'blocked');
    assert.equal(taskListView(list).done, 0, 'and it is certainly not done');
  });
});

describe('U1 — TodoWrite is KEPT rather than replaced', () => {
  it('a TodoWrite call rewrites only the rows it owns', () => {
    let list = [];
    taskCreateSeen(list, 'tu1', CREATE_IN);
    taskCreateResult(list, 'tu1', CREATE_OUT);
    list = todoWriteApply(list, [
      { content: 'Erstens', status: 'completed', activeForm: 'Erstens tun' },
      { content: 'Zweitens', status: 'in_progress', activeForm: 'Zweitens tun' },
    ]);
    const v = taskListView(list);
    assert.equal(v.total, 3, 'the TaskCreate row must survive a TodoWrite');
    assert.deepEqual(v.rows.map((r) => r.src), ['task', 'todo', 'todo']);
    // a second TodoWrite replaces the todo rows and leaves the task row alone
    list = todoWriteApply(list, [{ content: 'Nur noch eins', status: 'pending' }]);
    const v2 = taskListView(list);
    assert.equal(v2.total, 2);
    assert.deepEqual(v2.rows.map((r) => r.text), [CREATE_IN.subject, 'Nur noch eins']);
  });

  it('an empty TodoWrite clears the todo rows without touching the task rows', () => {
    let list = [];
    taskCreateSeen(list, 'tu1', CREATE_IN);
    list = todoWriteApply(list, [{ content: 'x', status: 'pending' }]);
    list = todoWriteApply(list, []);
    assert.equal(taskListView(list).total, 1);
  });

  it('PF-2 Gegenprobe: a row the next TodoWrite carries over keeps the moment its text first appeared — only a new text is new', () => {
    // TodoWrite re-sends the whole list; a fresh stamp on every row made a finished plan's ticked rows new again under
    // the next plan (plan-progress.js planTaskMap holds `created` against the plan's line)
    let list = [];
    taskCreateSeen(list, 'tu1', CREATE_IN, 500);
    list = todoWriteApply(list, [{ content: 'Alt', status: 'pending' }, { content: 'Doppelt', status: 'pending' }, { content: '__proto__', status: 'pending' }], 1000);
    list = todoWriteApply(list, [
      { content: 'Doppelt', status: 'completed' }, { content: 'Neu', status: 'pending' }, { content: 'Alt', status: 'completed' },
      { content: 'Doppelt', status: 'pending' }, { content: '__proto__', status: 'completed' },
    ], 2000);
    assert.deepEqual(list.map((r) => [r.src, r.text, r.created]), [
      ['task', CREATE_IN.subject, 500], // a TaskCreate row is TodoWrite's to keep, not to stamp
      ['todo', 'Doppelt', 1000], ['todo', 'Neu', 2000], ['todo', 'Alt', 1000],
      ['todo', 'Doppelt', 2000], // one old row lends its stamp once — the second „Doppelt" is a new row
      ['todo', '__proto__', 1000], // any text is a key (a Map, no prototype in the way)
    ]);
    assert.deepEqual(list.slice(1).map((r) => r.status), ['completed', 'pending', 'completed', 'pending', 'completed'], 'the status is the new list\'s');
    // a text that left the list and comes back later is new again: only the PREVIOUS list lends stamps
    list = todoWriteApply(list, [{ content: 'Neu', status: 'pending' }], 3000);
    list = todoWriteApply(list, [{ content: 'Neu', status: 'pending' }, { content: 'Alt', status: 'pending' }], 4000);
    assert.deepEqual(list.slice(1).map((r) => [r.text, r.created]), [['Neu', 2000], ['Alt', 4000]]);
  });

  it('taskListSig moves when something the strip SHOWS changed', () => {
    const list = [];
    taskCreateSeen(list, 'tu1', CREATE_IN);
    const s0 = taskListSig(list);
    taskCreateResult(list, 'tu1', CREATE_OUT);
    assert.notEqual(taskListSig(list), s0);
    const s1 = taskListSig(list);
    update(list, 'tu2', { taskId: '1', status: 'completed' }, { out: UPD_OUT('completed') });
    assert.notEqual(taskListSig(list), s1);
  });
});

// ---- the two readers --------------------------------------------------------------------------------
const ROOT = path.join(__dirname, '..');
const RENDER_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat-render.js'), 'utf8');
const STATUS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat-status.js'), 'utf8');
const EVENTS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat-events.js'), 'utf8');
const SIDE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat-side.js'), 'utf8');
function liftFn(src, name, rel) {
  const one = new RegExp('^(?:async )?function ' + name + '\\(.*\\}[ \\t]*$', 'm');
  const multi = new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm');
  const m = one.exec(src) || multi.exec(src);
  assert.ok(m, name + '() not found in ' + rel + ' — renamed or reindented? Then these tests prove nothing.');
  return m[0];
}
// PF-2 — what the strip shows is decided by chat-side.js planStripTasks (the split it shares with the plan group). The
// tabs in this file carry no plan, so planRailPlan answers null and every task stays in the strip — but through the
// SHIPPED split, lifted with its real helpers (plan-progress.js), not a stub that would answer „all of them" on its own.
// The plan-shaped cases run in test/plan-wiring.test.js, where both readers live in one world.
function shippedSplit() {
  const PP = require('../public/js/plan-progress');
  // chatLayoutGet too: planStripTasks asks it whether the plan group is folded shut (cc_chat_layout.fold_plan)
  const env = { planTaskMap: PP.planTaskMap, planTaskSig: PP.planTaskSig, planVisible: PP.planVisible, STATE: { prefs: {} }, $: () => null,
    CHAT_LAYOUT_KEY: 'cc_chat_layout', localStorage: { getItem: () => null } };
  const names = ['chatLayoutGet', 'planProgressOn', 'planRailPlan', 'planTaskSplit', 'planStripTasks'];
  const keys = Object.keys(env);
  const body = names.map((n) => liftFn(SIDE_SRC, n, 'public/js/chat-side.js')).join('\n') + '\nreturn { planStripTasks };';
  return new Function(...keys, body)(...keys.map((k) => env[k]));
}
function fakeEl(tag, cls, text) {
  const n = {
    tag, className: cls || '', textContent: text == null ? '' : String(text), title: '', children: [], open: false, dataset: {},
    appendChild(c) { this.children.push(c); return c; },
    classList: { add(c) { n.className += ' ' + c; }, remove(c) { n.className = String(n.className).split(/\s+/).filter((x) => x !== c).join(' '); }, contains(c) { return String(n.className).split(/\s+/).includes(c); } },
    querySelector() { return null; },
  };
  Object.defineProperty(n, 'innerHTML', { set() { n.children.length = 0; }, get() { return ''; } });
  return n;
}
function loadStrip(tab, box) {
  const names = ['taskListOf', 'taskRepaint', 'updateTodos', 'trackTaskCreate', 'trackTaskCreateResult',
    'trackTaskUpdate', 'trackTaskUpdateResult', 'todoMark', 'todoRow', 'renderTodoStrip'];
  const env = {
    ACTIVE: tab, el: fakeEl, tt: (k) => k, $: (sel) => (sel === '#chatTodos' ? box : null),
    taskListView, todoWriteApply, taskCreateSeen, taskCreateResult, taskUpdateAsked, taskUpdateAnswered,
    planStripTasks: shippedSplit().planStripTasks, chatSideRefresh: () => {},
  };
  const keys = Object.keys(env);
  const body = names.map((n) => liftFn(RENDER_SRC, n, 'public/js/chat-render.js')).join('\n')
    + '\nreturn { ' + names.join(', ') + ' };';
  return new Function(...keys, body)(...keys.map((k) => env[k]));
}
function loadPhase() {
  const env = { taskListView };
  const keys = Object.keys(env);
  return new Function(...keys, liftFn(STATUS_SRC, 'activeTodoPhase', 'public/js/chat-status.js') + '\nreturn activeTodoPhase;')(...keys.map((k) => env[k]));
}
const allText = (n) => [n.textContent].concat(n.children.map(allText)).flat(9).filter(Boolean);

describe('U1 — the strip and the status line really read the new feed', () => {
  it('a TaskCreate + TaskUpdate pair reaches the strip', () => {
    const box = fakeEl('div', 'hidden');
    const tab = {};
    const api = loadStrip(tab, box);
    api.trackTaskCreate(tab, 'tu1', CREATE_IN);
    api.trackTaskCreateResult(tab, 'tu1', CREATE_OUT);
    assert.ok(!box.classList.contains('hidden'), 'the strip stayed hidden — the whole feature would be invisible');
    const t = allText(box);
    assert.ok(t.includes(CREATE_IN.subject), JSON.stringify(t));
    assert.ok(t.includes('0/1'));
    assert.ok(t.includes('□'), 'pending marker');
    api.trackTaskUpdate(tab, 'tu2', { taskId: '1', status: 'in_progress' });
    assert.ok(allText(box).includes('□'), 'the call alone moves nothing — the answer does');
    api.trackTaskUpdateResult(tab, 'tu2', false, UPD_OUT('in_progress'));
    const t2 = allText(box);
    assert.ok(t2.includes('■'), 'in_progress marker: ' + JSON.stringify(t2));
    assert.ok(t2.includes(CREATE_IN.activeForm), 'the working form replaces the subject while it runs');
  });

  it('…and the status line\'s working verb comes from the same list', () => {
    const tab = {};
    const api = loadStrip(tab, fakeEl('div', 'hidden'));
    const activeTodoPhase = loadPhase();
    assert.equal(activeTodoPhase(tab), '');
    api.trackTaskCreate(tab, 'tu1', CREATE_IN);
    api.trackTaskCreateResult(tab, 'tu1', CREATE_OUT);
    assert.equal(activeTodoPhase(tab), '', 'pending is not „working on"');
    api.trackTaskUpdate(tab, 'tu2', { taskId: '1', status: 'in_progress' });
    api.trackTaskUpdateResult(tab, 'tu2', false, UPD_OUT('in_progress'));
    assert.equal(activeTodoPhase(tab), CREATE_IN.activeForm, 'this is the reader that used to read tab.todos');
    api.trackTaskUpdate(tab, 'tu3', { taskId: '1', status: 'completed' });
    api.trackTaskUpdateResult(tab, 'tu3', false, UPD_OUT('completed', 'in_progress'));
    assert.equal(activeTodoPhase(tab), '');
  });

  it('TodoWrite still reaches the strip through the same door', () => {
    const box = fakeEl('div', 'hidden');
    const tab = {};
    const api = loadStrip(tab, box);
    api.updateTodos(tab, [{ content: 'Alt, aber lebendig', status: 'completed' }, { content: 'Noch offen', status: 'pending' }]);
    const t = allText(box);
    assert.ok(t.includes('Noch offen'), JSON.stringify(t));
    assert.ok(t.includes('1/2'));
    assert.ok(t.includes('√'), 'the completed one is folded under a √ toggle');
  });

  it('an unmapped status word shows „?" and names the word in the tooltip', () => {
    const box = fakeEl('div', 'hidden');
    const tab = {};
    const api = loadStrip(tab, box);
    assert.equal(api.todoMark('blocked'), '?', 'it used to fall through to □, i.e. „not started yet"');
    assert.equal(api.todoMark('pending'), '□');
    assert.equal(api.todoMark('in_progress'), '■');
    assert.equal(api.todoMark('completed'), '√');
    api.trackTaskCreate(tab, 'tu1', CREATE_IN);
    api.trackTaskCreateResult(tab, 'tu1', CREATE_OUT);
    api.trackTaskUpdate(tab, 'tu2', { taskId: '1', status: 'blocked' });
    api.trackTaskUpdateResult(tab, 'tu2', false, UPD_OUT('blocked'));
    assert.ok(allText(box).includes('?'), JSON.stringify(allText(box)));
    const row = api.todoRow({ text: 'x', state: 'unknown', status: 'blocked' });
    assert.match(row.title, /chat-render\.aufgabeStatusUnbekannt: blocked/);
  });

  it('an empty list hides the strip again', () => {
    const box = fakeEl('div', '');
    const tab = {};
    const api = loadStrip(tab, box);
    api.updateTodos(tab, []);
    assert.ok(box.classList.contains('hidden'));
  });
});

describe('U1 — the result half is wired ABOVE the tool-card gate', () => {
  it('chat-events.js reads the Task result without needing a card', () => {
    // Why this is asserted on the SOURCE: the result handler's `if (!card) … return` sits between the top of
    // the loop and the Monitor receipt, so a Task hook placed below it would stop working the moment the user
    // switches „Werkzeuge" off — a display setting silently killing a data path. The order is the property.
    const loop = /results\.forEach\(\(b\) => \{[\s\S]*?^        \}\);/m.exec(EVENTS_SRC);
    assert.ok(loop, 'the tool_result loop was not found in public/js/chat-events.js');
    // `//` lines are stripped FIRST, the way test/i18n.test.js does it: the comment above the hook names
    // „`if (!card)` return" in prose, and a raw indexOf found the comment instead of the gate — i.e. the
    // check would have failed for the very change it is meant to wave through. Identity, not position.
    const body = loop[0].split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const iTask = body.indexOf('trackTaskCreateResult');
    const iGate = body.indexOf('if (!card)');
    assert.ok(iTask > 0, 'the Task result is not read at all');
    assert.ok(iGate > 0, 'the no-card gate was not found — has the loop changed shape?');
    assert.ok(iTask < iGate, 'the Task result is read BELOW the no-card return: with tool display off the strip would freeze');
    // …and it must not be keyed off the card's dataset either (that is what the Monitor receipt does)
    assert.match(body, /chat\.taskToolIds\s*&&\s*chat\.taskToolIds\[b\.tool_use_id\]/);
  });
});

// ---- Blockers 1 + 2: the strip fed by the SHIPPED pump ------------------------------------------------
// Every frame below goes in where the browser's goes in — chat-events.js handleEventBody — and reaches the
// strip through the shipped chat-render.js halves and the real task-list.js (test/event-pump.js). The suites
// above call the track* functions themselves, and the adversarial review proved what that is worth: with
// trackTaskCreate/trackTaskUpdate cut out of chat-events.js they all stayed green, while in the panel the strip
// would have stayed empty for ever (mutation M-C). `addToolCard` answers null here, i.e. „Werkzeuge" OFF.
// The frame ORDER is the measured one: the call in an assistant frame, its answer in a later user frame
// (30 of 30 Task* answers in the corpus transcripts, each the only tool_result of its user message).
function pumpWithStrip() {
  const box = fakeEl('div', 'hidden');
  const tab = {};
  const pump = eventPump(tab, {
    lift: ['todoMark', 'todoRow', 'renderTodoStrip'],
    env: { el: fakeEl, tt: (k) => k, $: (sel) => (sel === '#chatTodos' ? box : null), planStripTasks: shippedSplit().planStripTasks },
  });
  const created = () => {
    pump.feed(frames.toolUse({ id: 'tu1', name: 'TaskCreate', input: CREATE_IN }));
    pump.feed(frames.toolResult([{ id: 'tu1', text: 'Task #1 created successfully: ' + CREATE_IN.subject }], CREATE_OUT));
  };
  const asked = (tu, status) => pump.feed(frames.toolUse({ id: tu, name: 'TaskUpdate', input: { taskId: '1', status } }));
  const answered = (tu, out, isError) => pump.feed(frames.toolResult([{ id: tu, text: isError ? 'Error' : 'Updated task #1 status', isError }], out));
  const state = () => taskListView(tab.taskList || []).rows.map((r) => r.state);
  return { box, tab, pump, created, asked, answered, state };
}

describe('U1 — Blockers 1 + 2: the task strip through the shipped event pump', () => {
  it('a TaskCreate call puts the row up, its answer gives it the id — and the strip DOM shows it', () => {
    const w = pumpWithStrip();
    w.pump.feed(frames.toolUse({ id: 'tu1', name: 'TaskCreate', input: CREATE_IN }));
    assert.deepEqual(w.state(), ['pending'], 'the tool_use half (trackTaskCreate in chat-events.js) did not run');
    assert.equal(w.tab.taskList[0].id, '', 'no id before the answer — the input carries none');
    w.pump.feed(frames.toolResult([{ id: 'tu1', text: '…' }], CREATE_OUT));
    assert.equal(w.tab.taskList[0].id, '1', 'the result half (trackTaskCreateResult) did not run');
    assert.ok(!w.box.classList.contains('hidden'), 'the strip stayed hidden');
    assert.ok(allText(w.box).includes(CREATE_IN.subject), JSON.stringify(allText(w.box)));
  });

  it('a TaskUpdate moves the row when its ANSWER arrives — not at the call', () => {
    const w = pumpWithStrip();
    w.created();
    w.asked('tu2', 'in_progress');
    assert.deepEqual(w.state(), ['pending'], 'the wish alone moved the row — the order Blocker 2 was about');
    w.answered('tu2', UPD_OUT('in_progress'));
    assert.deepEqual(w.state(), ['in_progress']);
    assert.ok(allText(w.box).includes('■'), JSON.stringify(allText(w.box)));
    w.asked('tu3', 'completed');
    w.answered('tu3', UPD_OUT('completed', 'in_progress'));
    assert.deepEqual(w.state(), ['completed']);
  });

  it('a REFUSED update — `is_error`, or `success` not true — leaves the row where it was, in the wired chain', () => {
    // The review replayed exactly this against the old wiring: call → the row was `completed` at once, the
    // refusal came a frame later and could not take it back. And `is_error` never reached the module at all.
    const w = pumpWithStrip();
    w.created();
    w.asked('tu2', 'completed');
    w.answered('tu2', { success: false, taskId: '1' });
    assert.deepEqual(w.state(), ['pending'], 'success:false moved the row');
    w.asked('tu3', 'completed');
    w.answered('tu3', 'InputValidationError: …', true);
    assert.deepEqual(w.state(), ['pending'], 'is_error moved the row');
  });

  it('a frame with SEVERAL tool_results: the Output cannot be attributed, the error flag can', () => {
    // Two answers in one frame → chat-events.js `soleOut` is null for both. The update without an error flag
    // takes its wish (task-list.js says why), the one WITH the flag stays put. Not the measured case.
    const w = pumpWithStrip();
    w.created();
    w.pump.feed(frames.toolUse({ id: 'tu1b', name: 'TaskCreate', input: { subject: 'Zweite', description: 'x' } }));
    w.pump.feed(frames.toolResult([{ id: 'tu1b', text: '…' }], { task: { id: '2', subject: 'Zweite' } }));
    w.pump.feed(frames.toolUse(
      { id: 'tu2', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } },
      { id: 'tu3', name: 'TaskUpdate', input: { taskId: '2', status: 'completed' } },
    ));
    w.pump.feed(frames.toolResult([{ id: 'tu2', text: 'Updated task #1 status' }, { id: 'tu3', text: 'Error', isError: true }], { success: true }));
    assert.deepEqual(w.state(), ['in_progress', 'pending']);
  });

  it('a REFUSED TaskCreate takes its row down again (it created no task)', () => {
    const w = pumpWithStrip();
    w.pump.feed(frames.toolUse({ id: 'tu9', name: 'TaskCreate', input: CREATE_IN }));
    assert.equal(w.tab.taskList.length, 1);
    w.pump.feed(frames.toolResult([{ id: 'tu9', text: 'Error: …', isError: true }], 'Error: …'));
    assert.equal(w.tab.taskList.length, 0, 'the strip shows a task the CLI never made');
    assert.ok(w.box.classList.contains('hidden'), '…and the emptied strip hides again');
  });
});
