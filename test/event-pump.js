'use strict';
// U1 / PR-12, blocker round — the SHIPPED event pump, run instead of re-enacted. Not a test file of its own
// (no `.test.js`): test/workflow-lanes.test.js and test/task-list.test.js both drive their frames through it.
//
// WHY this exists. The first version of those suites fed the lanes by calling laneSystemEvent /
// wfSystemEvent / wfApplyLaunch THEMSELVES, and the task strip by calling the lifted trackTask* functions
// directly — i.e. the test helpers rebuilt the very wiring chat-events.js and chat-render.js are supposed
// to supply. The adversarial review then cut
// that wiring out of the shipped files (the wfSystemEvent call, the wfApplyLaunch block, the TaskCreate /
// TaskUpdate calls at the tool_use) and every suite stayed green: the ⚙ rail and the whole task strip could be
// disconnected from the pump without one red test. Same shape as the probe gate nobody called.
//
// So here a frame goes in where the browser's goes in — chat-events.js handleEventBody, lifted by name — and
// everything between it and the pure modules is the shipped source too: the chat-render.js halves it calls
// (agentSystemEvent, agentToolResult, trackTask*, …) are lifted by name as well, and the modules are the real
// ones (agent-lanes.js, workflow-lanes.js, task-list.js). Remove any one of those calls from the shipped files
// and the suites that use this go red.
//
// HOW: the lifted sources are compiled inside `with (env)`, env a Proxy answering every free name — the real
// pieces for the path under test, a no-op for the rest (renderTabs, setPhase, ctxNoteFrame, addToolCard …).
// Names of the real global (JSON, Date, Object …) fall through to it. Sloppy mode on purpose: `with` is what
// lets a 600-line switch run without listing its ~80 free names by hand, and a name it gains later cannot
// break this harness. The same technique test/plan-wiring.test.js uses for the plan path.
// `addToolCard` answers null, i.e. „Werkzeuge" switched OFF — the harder of the two cases: every data path
// must then work without a tool card to hang on (the Task result half sits above the `if (!card)` return).
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const PUB = path.join(__dirname, '..', 'public', 'js');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const EVENTS_SRC = read('chat-events.js');
const RENDER_SRC = read('chat-render.js');

// a top-level function by name — a one-liner, or a block that ends with `}` at column 0
function liftFn(src, name, rel) {
  const one = new RegExp('^(?:async )?function ' + name + '\\(.*\\}[ \\t]*$', 'm').exec(src);
  const m = (one && !/\{\s*$/.test(one[0])) ? one : new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm').exec(src);
  assert.ok(m, name + '() not found in ' + rel + ' — renamed or reindented? Then these tests prove nothing.');
  return m[0];
}

// The chat-render.js halves between the pump and the modules. Every name here is a call site of the pump.
const RENDER_PATH = [
  'isAgentTool', 'agentLanes', 'trackAgentStart', 'agentToolResult', 'agentSystemEvent',
  'taskListOf', 'taskRepaint', 'updateTodos', 'trackTaskCreate', 'trackTaskCreateResult', 'trackTaskUpdate',
  'trackTaskUpdateResult',
];

// A node that survives what the assistant branch does to its bubble (classList, style, appendChild).
function bubbleNode() {
  const n = { children: [], style: {}, dataset: {}, textContent: '', className: '' };
  n.classList = { add() {}, remove() {}, contains() { return false; }, toggle() {} };
  n.appendChild = (c) => { n.children.push(c); return c; };
  n.querySelector = () => null;
  n.querySelectorAll = () => [];
  return n;
}

// eventPump(tab, { lift: [extra chat-render.js names], liftFrom: { 'chat.js': [names] }, env: {extra free names} })
//   → { feed(frame), repaints: [changed…], fn: {each lifted function} }   `repaints` records every
//     agentRepaint(tab, changed) the shipped agentSystemEvent/agentToolResult/trackAgentStart asked for —
//     whether a structural change reached the rail's repaint is part of the wiring, not an implementation
//     detail. `liftFrom` compiles shipped functions of OTHER files into the same env (chat-flow3.test.js:
//     tabCanStop, sendMessage, interruptTab), so they and the pump share one `chat`, one `ACTIVE`.
function eventPump(tab, opts) {
  opts = opts || {};
  if (!tab.toolCards) tab.toolCards = {};
  const repaints = [];
  const stub = () => undefined;
  const known = Object.assign(Object.create(null),
    require('../public/js/agent-lanes'),
    require('../public/js/workflow-lanes'),
    require('../public/js/task-list'),
    {
      chat: tab, ACTIVE: tab,
      agentRepaint: (t, changed) => { repaints.push(!!changed); return !!changed; },
      ensureBubble: () => ({ textEl: bubbleNode() }),
      addToolCard: () => null,
    },
    opts.env || {});
  const env = new Proxy(known, {
    has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
    get: (t, k) => (typeof k !== 'string' ? undefined : k in t ? t[k] : stub),
  });
  const names = RENDER_PATH.concat(opts.lift || []);
  const other = Object.entries(opts.liftFrom || {}).flatMap(([f, ns]) => ns.map((n) => liftFn(read(f), n, 'public/js/' + f)));
  const all = ['handleEventBody'].concat(names, Object.values(opts.liftFrom || {}).flat());
  const src = [liftFn(EVENTS_SRC, 'handleEventBody', 'public/js/chat-events.js')]
    .concat(names.map((n) => liftFn(RENDER_SRC, n, 'public/js/chat-render.js')), other).join('\n');
  const api = new Function('__env', 'with (__env) {\n' + src + '\nreturn { ' + all.join(', ') + ' };\n}')(env);
  return { feed: (ev) => api.handleEventBody(ev), repaints, fn: api };
}

// The frame shapes the CLI sends (stream-json), as the pump reads them.
const frames = {
  // one assistant message with tool_use blocks
  toolUse: (...uses) => ({ type: 'assistant', message: { content: uses.map((u) => ({ type: 'tool_use', id: u.id, name: u.name, input: u.input || {} })) } }),
  // one user message with tool_result blocks; `out` is the Output object NEXT to the message (tool_use_result)
  toolResult: (results, out) => {
    const ev = { type: 'user', message: { content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.text || '', is_error: !!r.isError })) } };
    if (out !== undefined) ev.tool_use_result = out;
    return ev;
  },
};

module.exports = { eventPump, frames, liftFn, RENDER_PATH };
