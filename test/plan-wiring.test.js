'use strict';
// Plan progress, the LIVE half (PF-1 step 2): what the browser does with tab.plan. plan-progress.test.js pins
// the pure module; this file pins the wiring around it — the places where a working module still shows the
// reader nothing, or the wrong thing:
//   1. the approval message (chat-render.js resolvePlanGate) carries the step block + protocol, only with the
//      switch on, and a failed POST takes the approval back (postGateReply → planGateFailed);
//   2. reports are lifted out of the message before it is painted (chat-side.js takePlanStatus), and only
//      out of MAIN-thread messages (chat-events.js: the subagent branch leaves first);
//   3. the rail group says what the state is — proposed dimmed, the running step with its sentence, paused
//      when the tab rests, the quiet hint without guessing, the fold, the badge — and repaints when it must;
//   4. the stream never paints a half-written ```plan-status block (render.js renderMarkdown).
// The browser scripts are classic scripts sharing one global scope. chat-side.js has no top-level side
// effects (beyond reading window.matchMedia — the world hands it a window), so it is loaded WHOLE into a vm context next to the real plan-progress.js, with a DOM just big
// enough for the rail; the few functions of chat-render.js / render.js that matter are lifted out of the
// source by name (as test/agent-lanes.test.js does), so the wiring itself is under test, not a copy of it.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const PUB = path.join(__dirname, '..', 'public', 'js');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const RENDER = read('render.js');
const CHAT_RENDER = read('chat-render.js');
const CHAT_EVENTS = read('chat-events.js');
const CHAT = read('chat.js');
const CHAT_COMPOSER = read('chat-composer.js');

// a top-level function by name — a one-liner, or a block that ends with `}` at column 0
function liftFn(src, name, rel) {
  const one = new RegExp('^(?:async )?function ' + name + '\\(.*\\}$', 'm').exec(src);
  const m = (one && !/\{\s*$/.test(one[0])) ? one : new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm').exec(src);
  assert.ok(m, name + '() not found in ' + rel + ' — renamed or reindented? Then these tests prove nothing.');
  return m[0];
}
function liftConst(src, name, rel) {
  const m = new RegExp('^const ' + name + ' = .*;$', 'm').exec(src);
  assert.ok(m, 'const ' + name + ' not found in ' + rel);
  return m[0];
}
function bundle(pieces, names, env) {
  const keys = Object.keys(env);
  return new Function(...keys, pieces.join('\n') + '\nreturn { ' + names.join(', ') + ' };')(...keys.map((k) => env[k]));
}
// values made inside the vm context are of ITS Array/Object — deepStrictEqual compares prototypes too
const plain = (x) => JSON.parse(JSON.stringify(x));
const recorder = () => { const got = []; const f = (...a) => { got.push(a); }; f.got = got; return f; };

// ---- a DOM just big enough for the rail ------------------------------------------------------------------
// Elements with classes, dataset, children, and the selector shapes the plan code uses: `tag.a.b[data-x]`.
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.parentElement = null; this.cls = new Set();
    this.dataset = {}; this.style = {}; this.attrs = {}; this.text = ''; this.html = ''; this.title = ''; this.open = false;
    this.type = ''; this.visible = true;
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
  get isConnected() { let n = this; while (n.parentElement) n = n.parentElement; return !!n.isRoot; }
  get offsetParent() { return this.isConnected && this.visible ? {} : null; }
  get nextElementSibling() { const p = this.parentElement; return p ? (p.children[p.children.indexOf(this) + 1] || null) : null; }
  appendChild(k) { if (k.parentElement) k.remove(); k.parentElement = this; this.children.push(k); return k; }
  insertBefore(k, ref) { if (k.parentElement) k.remove(); k.parentElement = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(k); else this.children.splice(i, 0, k); return k; }
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
      if (n.startsWith('data-') ? !(camel(n.slice(5)) in this.dataset) : !(n in this.attrs)) return false;
    }
    return true;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => n.children.forEach((k) => { if (k.matches(sel)) out.push(k); walk(k); });
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  scrollIntoView() { this.scrolled = (this.scrolled || 0) + 1; }
  focus() { this.focused = (this.focused || 0) + 1; }
}
const byClass = (root, cls) => root.querySelectorAll('.' + cls);
const rootEl = (tag) => { const e = new FakeEl(tag || 'div'); e.isRoot = true; return e; };

// ---- the browser world: plan-progress.js + chat-side.js in ONE context ------------------------------------
const SAMPLE = '# Plan: Testvorhaben\n\n## Umsetzung\n### 1. Modul\nText\n### 2. Route\nText\n### 3. Tests\nText\n';
const FILE = 'C:\\Users\\x\\.claude\\plans\\test-plan.md';
function world(opts) {
  opts = opts || {};
  const ids = {};
  for (const id of ['chatSide', 'chatSideSlot', 'chatSideEmpty', 'chatSideCount', 'chatSidePlan', 'chatSideToggle', 'chatSideJump', 'sidecarBody', 'attachChips', 'composerInput', 'chatTodos']) ids['#' + id] = rootEl();
  const store = {};
  const ctx = {
    console, Date, Math, JSON, String, Number, Array, Object, Boolean, RegExp, Map, Set, isFinite, encodeURIComponent,
    el: (tag, cls, txt) => { const e = new FakeEl(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; },
    $: (s) => ids[s] || null,
    document: { createTextNode: (s) => { const e = new FakeEl('#text'); e.text = String(s); return e; } }, // chatSideGroup's label
    tt: (k) => String(k), t: (k) => String(k),
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    STATE: { prefs: opts.prefs || {} },
    ACTIVE: null,
    mkClickable: (e, label) => { e.setAttribute('role', 'button'); if (label) e.setAttribute('aria-label', label); return e; },
    toast: recorder(), logEvent: recorder(), persistTabsSoon: recorder(), renderTabs: recorder(), refreshNavBusy: recorder(), sendMessage: recorder(),
    sidecarShow: recorder(), renderMarkdown: (s) => '<md>' + s + '</md>', copyBtn: () => new FakeEl('button'),
    api: () => Promise.resolve({ content: '# Datei' }), SIDECAR: { node: null, raw: '' },
    activateTab: recorder(), showView: recorder(), hasHeldGate: () => false,
    setTimeout: (fn) => { fn(); return 0; }, // planJump's 30 ms defer — run it now
    requestAnimationFrame: (fn) => { fn(); return 0; }, // S3 — the jump bar's scroll after the rail opened
    // PF-1b — the card half (chat-render.js) and the chip half (chat-composer.js) live in this world too, against
    // ONE gate map: planOpenGate, the orphan card and the chip all read it
    ASK_GATES: new Map(), clearAskWaiter: recorder(), registerAskWaiter: recorder(), askCardFocus: () => () => {},
    settleGate: () => {}, renderQueueStrip: recorder(), composerSet: recorder(), mdEscape: (s) => s, chat: null,
  };
  // PF-2 counter-check — a clock that moves on every read: „made before this plan came up" (planTaskMap) is then a
  // matter of order, never of two calls landing in the same millisecond
  if (opts.tick) { let t = Date.now(); ctx.Date = class extends Date { static now() { t += 1; return t; } }; }
  ctx.globalThis = ctx;
  // chat-side.js reads window.matchMedia at load (H2, RAIL_NARROW_MQ) — a window WITHOUT matchMedia is the
  // wide one, its own fallback: the rail may open itself, which is what these tests are about
  ctx.window = ctx;
  const sb = vm.createContext(ctx);
  vm.runInContext(read('plan-progress.js'), sb, { filename: 'plan-progress.js' });
  vm.runInContext(read('open-points.js'), sb, { filename: 'open-points.js' }); // openPointsAnswerFrom's matcher
  vm.runInContext(liftFn(CHAT_RENDER, 'todoMark', 'chat-render.js'), sb);
  // PF-2 — the task list and BOTH of its readers in this one world: task-list.js whole, and the strip half of
  // chat-render.js (#chatTodos, the track* doors the pump calls) lifted by name next to the whole chat-side.js — so the
  // split the two readers share is the shipped one on both sides, not a copy of it on one
  vm.runInContext(read('task-list.js'), sb, { filename: 'task-list.js' });
  for (const n of ['todoRow', 'renderTodoStrip', 'taskListOf', 'taskRepaint', 'updateTodos', 'trackTaskCreate', 'trackTaskCreateResult', 'trackTaskUpdate', 'trackTaskUpdateResult']) {
    vm.runInContext(liftFn(CHAT_RENDER, n, 'chat-render.js'), sb);
  }
  vm.runInContext(read('queue-merge.js'), sb, { filename: 'queue-merge.js' }); // queueTextIsCommand — the chip asks it
  vm.runInContext(read('chat-side.js'), sb, { filename: 'chat-side.js' });
  for (const n of ['planOpenGate', 'planCardOrphan', 'planCardState', 'planCardPaint', 'planCardsPaint', 'planAttachmentEl', 'addPlanCard', 'retirePlanCards', 'clearAsksForTab']) {
    vm.runInContext(liftFn(CHAT_RENDER, n, 'chat-render.js'), sb);
  }
  for (const n of ['openCardOf', 'inertBtn', 'planChipShown', 'planChipAttachment', 'planChipReset', 'renderPlanChip']) vm.runInContext(liftFn(CHAT_COMPOSER, n, 'chat-composer.js'), sb);
  const fn = (n) => vm.runInContext(n, sb);
  const tab = { id: 'c1', sessionId: 's1', streaming: false, _turnOpen: false, msgEl: rootEl(), agents: [], openPoints: [], hooks: [], queue: [] };
  ctx.ACTIVE = tab; ctx.chat = tab;
  // resolvePlanGate / postGateReply out of chat-render.js, wired to THIS world's plan functions
  const posted = [];
  const gate = bundle([liftFn(CHAT_RENDER, 'resolvePlanGate', 'chat-render.js'), liftFn(CHAT_RENDER, 'postGateReply', 'chat-render.js')],
    ['resolvePlanGate', 'postGateReply'], {
      tt: ctx.tt, ACTIVE: tab, ASK_WAIT_PHASE: 'phase:ask-wait', PHASE_WORKING: 'phase:working', renderStatus: () => {},
      settleGate: () => {}, approvePlanMode: recorder(), refreshInterruptBtn: () => {}, rearmGateCard: recorder(), toast: ctx.toast,
      healDeadChat: () => false, ASK_GATES: new Map(),
      api: (url, o) => { posted.push(JSON.parse(o.body)); return opts.postFails ? Promise.reject(new Error('500')) : Promise.resolve({}); },
      planGateCandidate: fn('planGateCandidate'), planAcceptMessage: fn('planAcceptMessage'), planActivate: fn('planActivate'),
      planSuperseded: fn('planSuperseded'), planGateFailed: fn('planGateFailed'), planUntracked: fn('planUntracked'), planGateSent: fn('planGateSent'),
    });
  const refresh = () => { fn('chatSideRefresh')(true); return ids['#chatSideSlot'].querySelector('.cside-plan'); };
  return { ctx, sb, fn, tab, ids, posted, gate, refresh, call: (n, ...a) => fn(n)(...a) };
}
const flush = () => new Promise((r) => setImmediate(r));
// handleEventBody RUN, not grepped: lifted out of chat-events.js (with routeSubagentFrame) and compiled inside
// `with (env)`, where env is a Proxy answering every free name — this world's real plan functions and tab for the
// plan path, a no-op for the rest (renderTabs, ctxNoteFrame, setPhase, setAssistantText …). Names of the real global
// (JSON, String, Object …) fall through to it. Sloppy mode on purpose: `with` is what lets a 600-line switch run
// without listing its ~80 free names by hand — and a new one it gains later cannot break this test.
function eventHarness(w, extra) {
  const stub = () => undefined;
  const known = Object.assign(Object.create(null), {
    chat: w.tab, ACTIVE: w.tab,
    takePlanStatus: w.fn('takePlanStatus'), planNoteTools: w.fn('planNoteTools'),
    ensureBubble: () => { const row = w.tab.msgEl.appendChild(new FakeEl('div')); row.className = 'msg'; return { textEl: row.appendChild(new FakeEl('div')) }; },
    addToolCard: () => null, isAgentTool: () => false,
  }, extra || {});
  if (!w.tab.toolCards) w.tab.toolCards = {};
  const env = new Proxy(known, {
    has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
    get: (t, k) => (typeof k !== 'string' ? undefined : k in t ? t[k] : stub),
  });
  const src = liftFn(CHAT_EVENTS, 'handleEventBody', 'chat-events.js') + '\n' + liftFn(CHAT_EVENTS, 'routeSubagentFrame', 'chat-events.js');
  return new Function('__env', 'with (__env) {\n' + src + '\nreturn { handleEventBody, routeSubagentFrame };\n}')(env);
}
const status = (body) => '```plan-status\n' + body + '\n```';
// a proposal the way the browser registers it: its CARD (chat-render.js addPlanCard), whose gate entry stays open
// until the can_use_tool is answered — so planOpenGate says „the card decides" and ▶ / the chip stay away
function proposeWithCard(w, id, md) {
  const row = w.tab.msgEl.appendChild(new FakeEl('div')); row.className = 'msg';
  const bubble = row.appendChild(new FakeEl('div'));
  w.ctx.chat = w.tab;
  w.call('addPlanCard', bubble, id, md || SAMPLE, FILE);
  return w.ctx.ASK_GATES.get(id).group;
}
// a world with SAMPLE proposed (as the card registers it) and approved through the real gate
function approved(opts) {
  const w = world(opts);
  w.call('planSeen', w.tab, 'toolu_A', SAMPLE, FILE);
  w.gate.resolvePlanGate(w.tab, 'req-1', true, null, null, 'toolu_A');
  return w;
}

describe('PF-1 wiring — the approval message (chat-render.js resolvePlanGate)', () => {
  it('switch on: „Plan genehmigt", then the suggested steps as a plan-schritte block, then the protocol — and the plan is underway', () => {
    const w = approved();
    const msg = w.posted[0].message;
    assert.equal(w.posted[0].behavior, 'deny', 'both branches stay deny+message — a bare allow wedges headless stream-json');
    assert.ok(msg.startsWith('chat-render.planGenehmigtDerPlan\n\n```plan-schritte\n'), msg.slice(0, 80));
    assert.deepEqual(plain(w.fn('planStepsBlockParse')(msg).map((s) => s.title)), ['Modul', 'Route', 'Tests']);
    assert.ok(msg.endsWith(w.fn('PLAN_PROGRESS_PROTOCOL')), 'the protocol must ride in the approval — the system prompt does not reach a resumed session');
    assert.equal(w.tab.plan.state, 'active');
    assert.equal(w.tab.plan.id, 'toolu_A');
    assert.ok(!w.tab.planCandidates.toolu_A, 'the candidate moved into tab.plan (and with it its 600 KB text)');
    assert.ok(w.ctx.persistTabsSoon.got.length >= 2, 'the proposal and the approval are both saved');
  });

  it('switch off: the plain sentence as before, and no plan at all — not even a proposal', () => {
    const w = world({ prefs: { planProgress: false } });
    w.call('planSeen', w.tab, 'toolu_A', SAMPLE, FILE);
    assert.equal(w.tab.plan, undefined, 'off = not registered in the first place');
    w.gate.resolvePlanGate(w.tab, 'req-1', true, null, null, 'toolu_A');
    assert.equal(w.posted[0].message, 'chat-render.planGenehmigtDerPlan');
    assert.equal(w.refresh(), null, 'no group');
  });

  it('a card painted before the switch went on (no candidate) still approves — with the plain sentence', () => {
    const w = world();
    w.gate.resolvePlanGate(w.tab, 'req-1', true, null, null, 'toolu_unknown');
    assert.equal(w.posted[0].message, 'chat-render.planGenehmigtDerPlan');
    assert.equal(w.tab.plan, undefined);
  });

  it('the residual permission modal passes the tool_use id along (chat-perms.js) — without it no candidate is found', () => {
    const src = read('chat-perms.js');
    assert.match(src, /resolvePlanGate\(tab, requestId, true, null, null, req\.tool_use_id \|\| req\.toolUseId\)/);
  });

  it('„Weiter planen" puts the proposal away; the rail drops the group', () => {
    const w = world();
    w.call('planSeen', w.tab, 'toolu_A', SAMPLE, FILE);
    assert.ok(w.refresh(), 'the proposal shows first');
    w.gate.resolvePlanGate(w.tab, 'req-1', false, 'Bitte weiter planen', null, 'toolu_A');
    assert.equal(w.posted[0].message, 'Bitte weiter planen', 'the deny message is untouched');
    assert.equal(w.tab.plan.state, 'superseded');
    assert.equal(w.refresh(), null);
    assert.ok(w.ids['#chatSidePlan'].classList.contains('hidden'), 'the badge goes with it');
  });

  it('a POST that fails takes the approval back — the CLI never heard it (postGateReply → planGateFailed)', async () => {
    const w = approved({ postFails: true });
    assert.equal(w.tab.plan.state, 'active', 'optimistic while the POST is in flight');
    await flush();
    assert.equal(w.tab.plan.state, 'proposed', 'back to „wartet auf Freigabe"');
    assert.equal(w.tab.plan.acceptedAt, 0);
    // …and a failed „Weiter planen" brings the proposal back with its re-armed card
    const w2 = world({ postFails: true });
    w2.call('planSeen', w2.tab, 'toolu_B', SAMPLE, FILE);
    w2.gate.resolvePlanGate(w2.tab, 'req-2', false, 'weiter', null, 'toolu_B');
    assert.equal(w2.tab.plan.state, 'superseded');
    await flush();
    assert.equal(w2.tab.plan.state, 'proposed');
  });

  it('…but not once the model has reported against it: then the approval evidently arrived', () => {
    const w = approved();
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S1"}'), null);
    w.call('planGateFailed', w.tab, 'toolu_A');
    assert.equal(w.tab.plan.state, 'active');
  });

  it('a new proposal while a plan is underway stays a candidate; approving it moves the old plan into the history', () => {
    const w = approved();
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S2","erledigt":["S1"]}'), null);
    w.call('planSeen', w.tab, 'toolu_B', '# Plan: Zweiter\n## Schritte\n### Eins\n### Zwei\n', FILE);
    assert.equal(w.tab.plan.id, 'toolu_A', 'the plan being worked on stays on top');
    assert.ok(w.tab.planCandidates.toolu_B, '…and the proposal waits in its card');
    w.gate.resolvePlanGate(w.tab, 'req-2', true, null, null, 'toolu_B');
    assert.equal(w.tab.plan.id, 'toolu_B');
    assert.deepEqual(plain(w.tab.plan.history.map((h) => [h.id, h.done, h.total])), [['toolu_A', 1, 3]]);
    assert.match(w.posted[1].message, /"titel":"Eins"/, 'the SECOND approval carries the second plan\'s steps');
  });

  it('a failed approval of a SECOND plan brings the first back on top — its steps, ticks and jump targets (planGateFailed)', async () => {
    const o = {};
    const w = approved(o);
    await flush();
    const row = new FakeEl('div'); const bubble = row.appendChild(new FakeEl('div'));
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S2","erledigt":["S1"]}'), bubble);
    w.call('planSeen', w.tab, 'toolu_B', '# Plan: Zweiter\n## Schritte\n### Eins\n### Zwei\n', FILE);
    o.postFails = true;
    w.gate.resolvePlanGate(w.tab, 'req-2', true, null, null, 'toolu_B');
    assert.equal(w.tab.plan.id, 'toolu_B', 'optimistic while the POST is in flight');
    await flush();
    assert.equal(w.tab.plan.id, 'toolu_A', 'the CLI never heard it — the plan underway is back');
    assert.deepEqual(plain(w.tab.plan.steps.map((st) => st.status)), ['completed', 'in_progress', 'pending']);
    assert.equal(w.tab._planRows.S2, row, '…with its jump targets');
    assert.equal(w.tab.planCandidates.toolu_B.state, 'proposed', 'the proposal waits in its re-armed card again');
    assert.equal(w.refresh().dataset.planId, 'toolu_A');
    // the re-armed card's „Weiter planen" now only puts the proposal away — the progress is not lost
    o.postFails = false;
    w.gate.resolvePlanGate(w.tab, 'req-3', false, 'weiter', null, 'toolu_B');
    await flush();
    assert.equal(w.tab.plan.id, 'toolu_A');
    assert.equal(w.tab.plan.state, 'active');
    // a delivered approval lets the old plan go — the tab keeps no second 600 KB text around
    w.call('planSeen', w.tab, 'toolu_C', SAMPLE, FILE);
    w.gate.resolvePlanGate(w.tab, 'req-4', true, null, null, 'toolu_C');
    assert.equal(w.tab._planPrev.plan.id, 'toolu_A');
    await flush();
    assert.equal(w.tab._planPrev, null);
    assert.equal(w.tab.plan.history[0].state, 'replaced');
  });

  it('switch off: an approval takes the plan underway down — as the fold reads it — and a failed one brings it back', async () => {
    const o = {};
    const w = approved(o);
    await flush();
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S2","erledigt":["S1"]}'), null);
    w.ctx.STATE.prefs.planProgress = false;
    w.call('planSeen', w.tab, 'toolu_B', SAMPLE, FILE); // off: not registered
    o.postFails = true;
    w.gate.resolvePlanGate(w.tab, 'req-2', true, null, null, 'toolu_B');
    assert.equal(w.posted[1].message, 'chat-render.planGenehmigtDerPlan', 'the plain sentence');
    assert.equal(w.tab.plan, null, 'the old plan is over, and nobody will report against the new one');
    await flush();
    assert.equal(w.tab.plan.id, 'toolu_A', 'the CLI never heard it');
    o.postFails = false;
    w.gate.resolvePlanGate(w.tab, 'req-3', true, null, null, 'toolu_B');
    await flush();
    assert.equal(w.tab.plan, null);
    assert.equal(w.tab._planPrev, null);
    // switched on again: nothing comes back — and a resume folds the same transcript to the same nothing
    w.ctx.STATE.prefs.planProgress = true;
    assert.equal(w.refresh(), null);
    const P = require('../public/js/plan-progress');
    const f = P.planFoldNew();
    const line = (o2) => P.planFoldLine(f, o2);
    line({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'tool_use', id: 'toolu_A', name: 'ExitPlanMode', input: { plan: SAMPLE } }] } });
    line({ type: 'user', uuid: 'r1', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: w.posted[0].message }] } });
    line({ type: 'assistant', uuid: 'a2', message: { content: [{ type: 'tool_use', id: 'toolu_B', name: 'ExitPlanMode', input: { plan: SAMPLE } }] } });
    // (this world's tt() answers with the key — the fold reads the sentence the real dictionary sends)
    const sentence = w.posted[2].message.replace('chat-render.planGenehmigtDerPlan', 'Plan genehmigt — der Plan-Modus ist beendet. Bitte setze den Plan jetzt um.');
    line({ type: 'user', uuid: 'r2', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_B', content: sentence }] } });
    assert.equal(P.planFoldResult(f), null);
  });

  it('the candidates are capped (PLAN_CAPS.cands) — a long planning loop does not pin every plan text', () => {
    const w = approved();
    for (let i = 0; i < 6; i++) w.call('planSeen', w.tab, 'toolu_C' + i, SAMPLE, FILE);
    assert.equal(Object.keys(w.tab.planCandidates).length, w.fn('PLAN_CAPS').cands);
    assert.ok(w.tab.planCandidates.toolu_C5 && !w.tab.planCandidates.toolu_C0, 'the oldest go first');
  });
});

describe('PF-1 wiring — reports (chat-side.js takePlanStatus, chat-events.js)', () => {
  it('lifts the block out of the text, applies it, and remembers the message as the step\'s jump target', () => {
    const w = approved();
    const row = new FakeEl('div'); const bubble = row.appendChild(new FakeEl('div'));
    const r = w.call('takePlanStatus', w.tab, 'Ich fange an.\n\n' + status('{"schritte":[{"id":"S1","titel":"Modul"},{"id":"S2","titel":"Route"}],"aktuell":"S1","aktiv":"Schreibe das Modul"}'), bubble);
    assert.equal(r.text.trim(), 'Ich fange an.', 'the raw JSON must never reach the bubble');
    assert.equal(r.applied, 1);
    assert.equal(w.tab.plan.src, 'model', 'the model replaced the suggested list');
    assert.equal(w.tab.plan.steps.length, 2);
    assert.equal(w.tab.plan.current, 'S1');
    assert.equal(w.tab.plan.activeForm, 'Schreibe das Modul');
    assert.equal(w.tab._planRows.S1, row);
  });

  it('several blocks in one message are applied in order; a block that is not JSON stays readable', () => {
    const w = approved();
    const r = w.call('takePlanStatus', w.tab, status('{"aktuell":"S1"}') + '\nZwischentext\n' + status('{"erledigt":["S1"],"aktuell":"S2"}') + '\n' + status('{kaputt'), null);
    assert.equal(w.tab.plan.current, 'S2');
    assert.equal(w.tab.plan.steps[0].status, 'completed');
    assert.match(r.text, /Zwischentext/);
    assert.match(r.text, /\{kaputt/, 'invalid JSON is left in place, where it renders as a code block');
  });

  it('without a plan a bare step change is only stripped — a report WITH "schritte" starts the model\'s own plan (PF-1b)', () => {
    const w = world();
    const r0 = w.call('takePlanStatus', w.tab, 'Text ' + status('{"aktuell":"S1","erledigt":["S0"]}'), null);
    assert.equal(r0.text.trim(), 'Text');
    assert.equal(r0.applied, 0);
    assert.equal(w.tab.plan, undefined, 'nothing to show: no list');
    // the 05.10. course: no approval the rail could hang it on — the model's list IS the plan now (planFromStatus),
    // named after the newest proposal seen (planSeen records it even before the switch is asked)
    w.call('planSeen', w.tab, 'toolu_X', '# Plan: Der letzte Vorschlag\n', FILE);
    w.tab.plan = null;
    const row = new FakeEl('div'); const bubble = row.appendChild(new FakeEl('div'));
    const r = w.call('takePlanStatus', w.tab, 'Ich starte.\n' + status('{"schritte":["Inventar","Workflow"],"aktuell":"S1"}'), bubble);
    assert.equal(r.text.trim(), 'Ich starte.');
    assert.equal(r.applied, 1);
    assert.deepEqual([w.tab.plan.state, w.tab.plan.src, w.tab.plan.title, w.tab.plan.file], ['active', 'model', 'Der letzte Vorschlag', FILE]);
    assert.match(w.tab.plan.id, /^status:/);
    assert.equal(w.tab._planRows.S1, row, 'the step\'s jump target, as for any report');
    assert.ok(w.refresh(), 'and the rail shows it');
  });

  it('unknown step IDs are said once per plan in the 🔔 log — and change nothing', () => {
    const w = approved();
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S9"}'), null);
    w.call('takePlanStatus', w.tab, status('{"erledigt":["S7","S8"]}'), null);
    assert.equal(w.ctx.logEvent.got.length, 1);
    assert.equal(w.ctx.logEvent.got[0][0], 'chat-side.planUnbekannteIds1');
    assert.equal(w.tab.plan.current, '');
  });

  it('the quiet hint: „noch kein Stand" until the first report — and NO „kein Stand seit N" after it (Julian, 07.10.)', () => {
    const w = approved();
    const quiet = () => w.call('planQuietText', w.tab, w.tab.plan);
    assert.equal(quiet(), 'chat-side.planKeinStand');
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S1"}'), null);
    assert.equal(quiet(), '', 'a fresh report is not news');
    const n = w.fn('PLAN_QUIET_TOOLS');
    w.call('planNoteTools', w.tab, n * 4);
    assert.equal(quiet(), '', 'silent tool calls after a report make no hint any more');
    assert.equal(w.tab._planTools, n * 4, 'the count still runs (planWantsSteps reads it)');
    w.call('takePlanStatus', w.tab, status('{"aktiv":"weiter"}'), null);
    assert.equal(w.tab._planTools, 0, 'a report that hit something resets the count');
    // the count only runs for a plan underway
    w.call('takePlanStatus', w.tab, status('{"fertig":true}'), null);
    w.call('planNoteTools', w.tab, 50);
    assert.equal(quiet(), '');
  });

  it('chat-events.js: the lift sits in the MAIN-thread path — after the subagent branch has left, before the text is painted', () => {
    const start = CHAT_EVENTS.indexOf("case 'assistant': {");
    const end = CHAT_EVENTS.indexOf("case 'user': {", start);
    const body = CHAT_EVENTS.slice(start, end);
    const sub = body.indexOf('routeSubagentFrame(chat, ev); break;');
    const take = body.indexOf('takePlanStatus(chat,');
    const paint = body.indexOf('setAssistantText(target.textEl, shown)');
    assert.ok(sub > 0 && take > sub && paint > take, 'subagent break → takePlanStatus → setAssistantText, in this order');
    assert.match(body, /const shown = ps \? ps\.text : op \? op\.text : text;/, 'what is painted is the text WITHOUT the blocks');
    assert.match(body, /status: !!ps/, 'a status-only message is hidden as a row (markHideableRow)');
    assert.match(body, /planNoteTools\(chat, tools\.length\)/);
    assert.match(body, /addPlanCard\(target\.textEl, t\.id, [^\n]*planFilePath\)/, 'the plan file travels with the card');
  });

  it('chat-events.js: a compaction marks a plan underway stale; startChat keeps the plan on a resume only', () => {
    // inside the compact_boundary branch itself — not in a neighbour it could have wandered into, and only for a
    // plan underway (a proposal or a finished plan has no step IDs the model could have lost)
    const at = CHAT_EVENTS.indexOf("ev.subtype === 'compact_boundary'");
    const branch = CHAT_EVENTS.slice(at, CHAT_EVENTS.indexOf('} else if (', at));
    assert.ok(at > 0 && branch.length > 100, 'the compact_boundary branch');
    assert.match(branch, /if \(chat\.plan && chat\.plan\.state === 'active' && !chat\.plan\.stale\) \{\s*chat\.plan\.stale = true;\s*if \(typeof planChanged === 'function'\) planChanged\(chat, true\);/);
    const sc = liftFn(CHAT_EVENTS, 'startChat', 'chat-events.js');
    assert.match(sc, /if \(!extra\.resume\) tab\.plan = null;[\s\S]{0,400}?\n\s*tab\.planCandidates = \{\}; tab\._planRows = \{\}; tab\._planTools = 0;/);
    // PF-1b — the orphan under a plan underway goes the same way: kept on a resume (a fork paints no transcript that
    // could bring it back), re-registered as a candidate; a fresh start drops it
    assert.match(sc, /const orphan = extra\.resume \? tab\._planOrphan : null;[\s\S]{0,200}?tab\._planOrphan = null;\s*\n\s*if \(orphan && typeof planOrphanSet === 'function'\) planOrphanSet\(tab, orphan\);/);
  });

  it('a SUBAGENT\'s report never moves the plan — run through handleEventBody, not read off its source', () => {
    const w = approved();
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S1"}'), null);
    const sig0 = w.call('planSig', w.tab.plan);
    const lanes = recorder();
    const { handleEventBody } = eventHarness(w, { laneAppendText: (...a) => { lanes(...a); return true; } });
    const frame = (text, sub) => Object.assign({ type: 'assistant', message: { content: [{ type: 'text', text }, { type: 'tool_use', id: 'toolu_t' + text.length, name: 'Read', input: {} }] } }, sub || {});
    handleEventBody(frame(status('{"erledigt":["S1","S2","S3"],"fertig":true}'), { parent_tool_use_id: 'toolu_agent1' }));
    handleEventBody(frame(status('{"aktuell":"S3"}'), { parentToolUseId: 'toolu_agent1' }));
    assert.equal(w.call('planSig', w.tab.plan), sig0, 'the plan did not move');
    assert.equal(w.tab._planTools, 0, 'and the subagent\'s tool calls do not count for the quiet hint');
    assert.equal(lanes.got.length, 2, 'the text went to the agent\'s lane instead');
    // the control: the SAME frame from the main thread is a report — so the harness really reaches takePlanStatus
    handleEventBody(frame(status('{"erledigt":["S1"],"aktuell":"S2"}')));
    assert.equal(w.tab.plan.current, 'S2');
    assert.equal(w.tab._planTools, 1);
  });

  it('[Stand abfragen] → the model echoes the list with its ticks → the rail shows them; and it answers no open question', () => {
    const w = approved();
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S1"}'), null);
    w.tab.plan.stale = true;
    w.tab.openPoints = [{ id: 'op1', frage: 'Welches Werk ist gemeint?', done: false }];
    w.refresh().querySelector('.csp-foot').querySelectorAll('.csp-btn')[1].onclick({ stopPropagation() {} });
    const sent = w.ctx.sendMessage.got[0][0].text;
    // sendMessage hands every outgoing text to openPointsAnswerFrom — with ONE open question any text is read as
    // its answer („guessed"), which settled the question with the protocol as its answer
    w.call('openPointsAnswerFrom', w.tab, sent);
    assert.equal(w.tab.openPoints[0].done, false, 'the panel asking is not the reader answering');
    // the model answers in the shape it was shown: the list, each step with its state
    const rows = JSON.parse(/```plan-schritte\n([\s\S]*?)\n```/.exec(sent)[1]);
    rows[0].status = 'erledigt'; rows[1].status = 'läuft';
    w.call('takePlanStatus', w.tab, status(JSON.stringify({ schritte: rows })), null);
    assert.deepEqual(plain(w.tab.plan.steps.map((st) => st.status)), ['completed', 'in_progress', 'pending']);
    assert.equal(w.tab.plan.current, 'S2');
    assert.equal(w.tab.plan.stale, false);
    assert.equal(byClass(w.refresh(), 'csp-hint').filter((h) => h.textContent === 'chat-side.planVeraltet').length, 0);
    // the control: an ordinary reply still closes the one open question, as before
    w.call('openPointsAnswerFrom', w.tab, 'Werk 2 natürlich');
    assert.equal(w.tab.openPoints[0].done, true);
    assert.equal(w.tab.openPoints[0].guessed, true);
  });

  it('markHideableRow hides a row that was nothing but a status block — and only that', () => {
    const { markHideableRow, unmarkHideableRow } = bundle([liftFn(CHAT_EVENTS, 'markHideableRow', 'chat-events.js'), liftFn(CHAT_EVENTS, 'unmarkHideableRow', 'chat-events.js')], ['markHideableRow', 'unmarkHideableRow'], {});
    const mk = () => { const row = new FakeEl('div'); return row.appendChild(new FakeEl('div')); };
    let b = mk(); markHideableRow(b, { text: '', status: true });
    assert.ok(b.parentElement.classList.contains('only-status'));
    b = mk(); markHideableRow(b, { text: 'Prosa bleibt', status: true });
    assert.ok(!b.parentElement.classList.contains('only-status'), 'text left → the row stays');
    b = mk(); markHideableRow(b, { text: '', status: true, tools: 1 });
    assert.ok(!b.parentElement.classList.contains('only-status') && b.parentElement.classList.contains('only-tools'), 'with tools it is a tools row (the display switch decides)');
    b = mk(); markHideableRow(b, { text: '', status: true }); unmarkHideableRow(b);
    assert.ok(!b.parentElement.classList.contains('only-status'), 'a card appended later brings the row back');
  });
});

describe('PF-1 wiring — the rail group (chat-side.js chatSideRefresh)', () => {
  it('a proposal: dimmed, „wartet auf Freigabe", the suggested steps, the count = the number of steps', () => {
    const w = world();
    w.call('planSeen', w.tab, 'toolu_A', SAMPLE, FILE);
    const g = w.refresh();
    assert.ok(g && g.classList.contains('is-proposed'));
    assert.equal(g.querySelector('.csp-state').textContent, 'chat-side.planWartetAufFreigabe');
    assert.equal(g.querySelector('.cside-groupcount').textContent, '3');
    assert.deepEqual(byClass(g, 'csp-step').map((r) => r.querySelector('.todo-text').textContent), ['Modul', 'Route', 'Tests']);
    assert.equal(g.querySelector('.csp-bar'), null, 'no progress bar for work that has not started');
    assert.ok(!w.ids['#chatSide'].classList.contains('has-pending'), 'a proposal is not running work');
    assert.ok(w.ids['#chatSideEmpty'].classList.contains('hidden'), 'the plan counts as content — an „empty" rail would fold itself away');
  });

  // the merge with RAIL-1 (main: railAutoAction) — the fold/open decision moved into a pure function that knew
  // points, grants and agent lanes only; without the plan in it a rail holding nothing but a plan folded itself
  // away again on every repaint, and a proposal no longer opened it
  it('the plan is news for the rail (RAIL-1): a live one opens it, a finished one keeps it — your collapse still wins', () => {
    const railAutoAction = world().fn('railAutoAction');
    assert.equal(railAutoAction({ plan: 1, planLive: 1 }, {}), 'open', 'a proposal waiting for its approval opens the rail like a grant');
    assert.equal(railAutoAction({ plan: 1, planLive: 1, persisted: 90 }, {}), 'open', '…with ninety standing rules beside it too');
    assert.equal(railAutoAction({ plan: 1, persisted: 90 }, {}), '', 'a finished plan is a result like „√3": not folded, not forced open');
    assert.equal(railAutoAction({ plan: 1, planLive: 1 }, { userCollapsed: true }), '', 'your own collapse is not undone by a plan');
    assert.equal(railAutoAction({ persisted: 90 }, {}), 'fold', 'RAIL-1 unchanged: rules only still fold');
  });

  it('…and chatSideRefresh hands it the plan: a proposal opens a folded rail, a finished plan alone does not fold it', () => {
    const w = world();
    w.ids['#chatSide'].classList.add('collapsed');
    w.call('planSeen', w.tab, 'toolu_A', SAMPLE, FILE);
    w.refresh();
    assert.ok(!w.ids['#chatSide'].classList.contains('collapsed'), 'proposed → the rail opens');
    const d = approved();
    d.call('takePlanStatus', d.tab, status('{"erledigt":["S1","S2","S3"],"fertig":true}'), null);
    d.refresh();
    assert.ok(!d.ids['#chatSide'].classList.contains('collapsed'), 'done, and nothing else in the rail → it stays open');
  });

  it('underway: the running step ⏳ with its sentence above the title, paused only while the tab rests', () => {
    const w = approved();
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S2","erledigt":["S1"],"aktiv":"Verdrahte die Route"}'), null);
    w.tab.streaming = true;
    let g = w.refresh();
    const run = g.querySelector('[data-plan-step]') && byClass(g, 'csp-step').find((r) => r.dataset.planStep === 'S2');
    assert.equal(run.querySelector('.todo-mark').textContent, '⏳');
    assert.equal(run.querySelector('.csp-af').textContent, 'Verdrahte die Route');
    assert.ok(run.classList.contains('has-af') && !run.classList.contains('paused'));
    assert.ok(run.classList.contains('is-current'), 'the running step carries the accent edge (styles.css)');
    assert.equal(byClass(g, 'csp-step')[0].querySelector('.todo-mark').textContent, '✓');
    assert.equal(byClass(g, 'csp-step')[2].querySelector('.todo-mark').textContent, '☐');
    // PF-1b — the count says the step it is ON, like the head („Schritt 2 von 3"), not how many are done
    assert.equal(g.querySelector('.cside-groupcount').textContent, '2/3');
    assert.equal(g.querySelector('.csp-state').textContent, 'chat-side.planSchrittVon'.replace('{i}', 2).replace('{n}', 3));
    assert.equal(g.querySelector('.csp-bar').children[0].style.width, '33%');
    assert.ok(w.ids['#chatSide'].classList.contains('has-pending'), 'a step running counts as pending work');
    assert.equal(w.ids['#chatSidePlan'].textContent, '2/3', 'the badge for the collapsed strip');
    assert.equal(g.querySelector('.csp-foot').querySelectorAll('.csp-btn').length, 1, 'no [Stand abfragen] while a turn runs');
    w.tab.streaming = false;
    g = w.refresh();
    const run2 = byClass(g, 'csp-step').find((r) => r.dataset.planStep === 'S2');
    assert.ok(run2.classList.contains('paused'), 'the tab rests — the running step is paused, derived, never stored');
    assert.equal(g.querySelector('.csp-foot').querySelectorAll('.csp-btn').length, 2, '…and now [Stand abfragen] is offered');
  });

  // A6b — Julian, 05.10.: the step went grey the moment the reply was sent, although two background workflows of
  // this very tab were still building it, and turned orange again only with his next message. A resting TURN is
  // not a resting tab: while one of the tab's lanes runs, the step is not paused — but [Stand abfragen] (it starts
  // a turn, and a turn can start beside running lanes) is offered all the same.
  it('A6b: a background lane still running keeps the step un-paused after the turn ends', () => {
    const w = approved();
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S2","erledigt":["S1"],"aktiv":"Teil A wird nachgebessert"}'), null);
    w.tab.streaming = false;
    w.tab.agents = [{ id: 'wf1', status: 'running', desc: 'Workflow', start: 1 }];
    let g = w.refresh();
    const run = byClass(g, 'csp-step').find((r) => r.dataset.planStep === 'S2');
    assert.ok(run.classList.contains('is-current') && !run.classList.contains('paused'),
      'the turn rests but a workflow of the tab still runs — the step is being worked on, not paused');
    assert.ok(!/⏸/.test(run.title), 'and its tooltip does not claim a pause either');
    assert.equal(g.querySelector('.csp-foot').querySelectorAll('.csp-btn').length, 2,
      '[Stand abfragen] stays offered: it starts a turn, and a turn can start while lanes run');
    assert.ok(w.ids['#chatSide'].classList.contains('has-pending'), 'a step being worked on in the background is pending work');
    // the lane finishes → now nothing works on it any more, and the very next repaint says so
    w.tab.agents[0].status = 'done';
    g = w.refresh();
    const run2 = byClass(g, 'csp-step').find((r) => r.dataset.planStep === 'S2');
    assert.ok(run2.classList.contains('paused'), 'the last lane is done — the step is paused');
    assert.ok(!w.ids['#chatSide'].classList.contains('has-pending'), '…and no longer pending work');
  });

  it('A6b: whether a lane runs is part of the rail signature — finishing it repaints without any other change', () => {
    const w = approved();
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S2","erledigt":["S1"]}'), null);
    w.tab.streaming = false;
    w.tab.agents = [{ id: 'wf1', status: 'running', desc: 'Workflow', start: 1 }];
    const sig = () => w.call('planRailSig', w.tab);
    const s1 = sig();
    w.tab.agents[0].status = 'done';
    assert.notEqual(sig(), s1, 'the lane ending changes what the step looks like, so the guard must let it through');
  });

  it('[Stand abfragen] sends the question with the step list AS THE PANEL SEES IT and the protocol', () => {
    const w = approved();
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S2","erledigt":["S1"]}'), null);
    const g = w.refresh();
    const ask = g.querySelector('.csp-foot').querySelectorAll('.csp-btn')[1];
    ask.onclick({ stopPropagation() {} });
    const sent = w.ctx.sendMessage.got[0][0];
    assert.equal(sent.tab, w.tab);
    assert.ok(sent.text.startsWith('chat-side.planStandFrage\n\n```plan-schritte'));
    assert.match(sent.text, /"id":"S1","titel":"Modul","status":"erledigt"/);
    assert.match(sent.text, /"id":"S2","titel":"Route","status":"läuft"/);
    assert.ok(sent.text.endsWith(w.fn('PLAN_PROGRESS_PROTOCOL')), 'after a compaction the rules are gone too — they travel along');
  });

  it('every step stays visible — completed ones fold away only in a long plan (> 12 steps); a finished plan says which were never reported', () => {
    const w = approved();
    // PF-1b — six steps, four done: the checklist shows all six, because the count is what it is read for
    w.call('takePlanStatus', w.tab, status('{"schritte":["A","B","C","D","E","F"],"aktuell":"S5","erledigt":["S1","S2","S3","S4"]}'), null);
    let g = w.refresh();
    assert.equal(g.querySelector('.todo-done-toggle'), null, 'no fold in a short plan');
    assert.deepEqual(byClass(g, 'csp-step').map((r) => r.querySelector('.todo-mark').textContent), ['✓', '✓', '✓', '✓', '⏳', '☐']);
    w.call('takePlanStatus', w.tab, status('{"erledigt":["S5"],"fertig":true}'), null);
    g = w.refresh();
    assert.ok(g.classList.contains('is-done'));
    assert.equal(g.querySelector('.cside-groupcount').textContent, '✓6');
    assert.equal(w.ids['#chatSidePlan'].textContent, '✓6');
    assert.equal(g.querySelector('.csp-state').textContent, '✓ chat-side.planZustanddone');
    const f = byClass(g, 'csp-step').find((r) => r.dataset.planStep === 'S6');
    assert.equal(f.querySelector('.todo-mark').textContent, '☐', 'never ticked off silently');
    assert.equal(f.querySelector('.csp-unrep').textContent, 'chat-side.planOhneMeldung');
    // a long plan: fourteen steps, four done → those four fold away, the running step stays in reach of a 220px rail
    const L = approved();
    const names = Array.from({ length: 14 }, (_, i) => 'Schritt ' + String.fromCharCode(65 + i));
    L.call('takePlanStatus', L.tab, status(JSON.stringify({ schritte: names, aktuell: 'S5', erledigt: ['S1', 'S2', 'S3', 'S4'] })), null);
    const lg = L.refresh(), fold = lg.querySelector('.todo-done-toggle');
    assert.ok(fold, 'the fold');
    assert.equal(fold.querySelector('.todo-done-sum').textContent, '✓ 4chat-render.abgeschlossen');
    assert.equal(byClass(fold, 'csp-step').length, 4);
    assert.equal(byClass(lg, 'csp-step').length, 14, 'folded, not dropped');
    assert.equal(lg.querySelector('.cside-groupcount').textContent, '5/14');
  });

  it('steps the model went past: „nicht gemeldet" while the plan runs, „ohne Abschluss-Meldung" once done — rail and sidecar', () => {
    const w = approved();
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S3"}'), null);
    const unrep = (root) => byClass(root, 'csp-step').filter((r) => r.querySelector('.csp-unrep')).map((r) => r.dataset.planStep + '=' + r.querySelector('.csp-unrep').textContent);
    assert.deepEqual(unrep(w.refresh()), ['S1=chat-side.planNichtGemeldet', 'S2=chat-side.planNichtGemeldet'], 'jumped to S3 without erledigt — not „work still to come"');
    w.call('planShowSidecar', w.tab, w.tab.plan);
    assert.deepEqual(byClass(w.ctx.sidecarShow.got[0][0].node, 'csp-unrep').map((e) => e.textContent), ['chat-side.planNichtGemeldet', 'chat-side.planNichtGemeldet']);
    w.call('takePlanStatus', w.tab, status('{"erledigt":["S1","S3"],"fertig":true}'), null);
    assert.deepEqual(unrep(w.refresh()), ['S2=chat-side.planOhneMeldung']);
  });

  it('the repaint guard ignores rest/busy where it shows nothing; a running step in a resting tab is no pending work', () => {
    const w = world();
    proposeWithCard(w, 'toolu_A'); // its card still waits for the gate: nothing on the group depends on rest/busy
    const sig = (ww) => ww.call('planRailSig', ww.tab);
    w.tab.streaming = true; const a = sig(w); w.tab.streaming = false;
    assert.equal(sig(w), a, 'a proposal: turn start/end must not rebuild the rail (≈100 grant chips)');
    const d = approved();
    d.call('takePlanStatus', d.tab, status('{"erledigt":["S1","S2","S3"],"fertig":true}'), null);
    d.tab.streaming = true; const b = sig(d); d.tab.streaming = false;
    assert.equal(sig(d), b, 'a finished plan: the same');
    const r = approved();
    r.call('takePlanStatus', r.tab, status('{"aktuell":"S1"}'), null);
    r.tab.streaming = true; r.refresh();
    assert.ok(r.ids['#chatSide'].classList.contains('has-pending'), 'a step that runs is pending work');
    r.tab.streaming = false; r.refresh();
    assert.ok(!r.ids['#chatSide'].classList.contains('has-pending'), '…a paused one is not: nothing runs, nothing waits');
  });

  it('after a compaction the group says its state may be stale, and [Stand abfragen] lights up', () => {
    const w = approved();
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S1"}'), null);
    w.tab.plan.stale = true;
    const g = w.refresh();
    assert.ok(byClass(g, 'csp-hint').some((h) => h.textContent === 'chat-side.planVeraltet'));
    assert.ok(g.querySelector('.csp-foot').querySelectorAll('.csp-btn')[1].classList.contains('is-hot'));
  });

  it('a proposal without recognisable steps, and a plan whose list the model has not sent yet, say so', () => {
    const w = world();
    w.call('planSeen', w.tab, 'toolu_A', '# Plan: Nur Prosa\n\nKein Schritt weit und breit.\n', FILE);
    assert.equal(w.refresh().querySelector('.csp-empty').textContent, 'chat-side.planKeineSchritteErkannt');
    w.gate.resolvePlanGate(w.tab, 'req-1', true, null, null, 'toolu_A');
    assert.match(w.posted[0].message, /```plan-schritte\n\[\]\n```/, 'the approval asks for the list with an empty block');
    assert.equal(w.refresh().querySelector('.csp-empty').textContent, 'chat-side.planSchritteFolgen');
  });

  it('× puts the plan away for good (state dismissed, saved), the switch off hides it without touching it', () => {
    const w = approved();
    let g = w.refresh();
    g.querySelector('.csp-x').onclick({ stopPropagation() {} });
    assert.equal(w.tab.plan.state, 'dismissed');
    assert.equal(w.refresh(), null);
    const w2 = approved();
    w2.ctx.STATE.prefs.planProgress = false;
    assert.equal(w2.refresh(), null);
    assert.equal(w2.tab.plan.state, 'active', 'switching off is a view decision, not a state change');
    assert.ok(w2.ids['#chatSidePlan'].classList.contains('hidden'));
  });

  it('the repaint guard: a new sentence is patched in place, a status change or the tab coming to rest rebuilds', () => {
    const w = approved();
    w.tab.streaming = true;
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S1","aktiv":"eins"}'), null);
    const sig = () => w.call('planRailSig', w.tab);
    const s0 = sig();
    const g = w.refresh();
    w.call('takePlanStatus', w.tab, status('{"aktiv":"zwei"}'), null);
    assert.equal(sig(), s0, 'the sentence is not part of the signature');
    assert.equal(w.ids['#chatSideSlot'].querySelector('.cside-plan'), g, 'no rebuild for a sentence');
    assert.equal(byClass(g, 'csp-step')[0].querySelector('.csp-af').textContent, 'zwei', '…but written in place');
    w.call('planNoteTools', w.tab, w.fn('PLAN_QUIET_TOOLS'));
    // the patch path stays — and after a report it writes nothing (no „kein Stand seit N" any more)
    assert.equal(g.querySelector('.csp-quiet').textContent, '');
    assert.ok(g.querySelector('.csp-quiet').classList.contains('hidden'));
    w.call('takePlanStatus', w.tab, status('{"erledigt":["S1"],"aktuell":"S2"}'), null);
    assert.notEqual(sig(), s0, 'a status change moves the signature');
    const s1 = sig();
    w.tab.streaming = false;
    assert.notEqual(sig(), s1, 'coming to rest moves it as well — the paused step and [Stand abfragen] depend on it');
  });

  it('a click on a step: the message that reported it → the plan card → the sidecar with a toast', () => {
    const w = approved();
    const msgs = w.tab.msgEl;
    const card = msgs.appendChild(new FakeEl('div')); card.className = 'opt-group plan-group'; card.dataset.toolId = 'toolu_A';
    const statusRow = msgs.appendChild(new FakeEl('div')); statusRow.className = 'msg only-status'; statusRow.visible = false;
    const work = msgs.appendChild(new FakeEl('div')); work.className = 'msg';
    const bubble = statusRow.appendChild(new FakeEl('div'));
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S1"}'), bubble);
    w.call('planJump', w.tab, w.tab.plan, 'S1');
    assert.equal(work.scrolled, 1, 'the hidden status-only row hands over to the row after it, where the step\'s work is');
    w.call('planJump', w.tab, w.tab.plan, 'S3');
    assert.equal(card.scrolled, 1, 'no report for S3 yet → the plan card');
    card.remove();
    w.call('planJump', w.tab, w.tab.plan, 'S3');
    assert.equal(w.ctx.sidecarShow.got.length, 1, 'nothing left in the transcript → the plan in the sidecar');
    assert.equal(w.ctx.toast.got[0][0], 'chat-side.planSprungKeinZiel', '…and it says why');
  });

  it('[Plan öffnen] shows the live text; after a reload (no text) the plan FILE, marked as „Datei-Stand"', async () => {
    const w = approved();
    w.call('planShowSidecar', w.tab, w.tab.plan);
    const node = w.ctx.sidecarShow.got[0][0].node;
    assert.equal(w.ctx.sidecarShow.got[0][0].kind, 'node');
    assert.equal(node.querySelector('.pd-body').innerHTML, '<md>' + SAMPLE + '</md>');
    const restored = w.call('planRestore', JSON.parse(JSON.stringify(w.call('planSave', w.tab.plan))));
    assert.equal(restored.text, undefined, 'the text is never persisted');
    w.ctx.SIDECAR.node = null;
    w.call('planShowSidecar', w.tab, restored);
    const node2 = w.ctx.sidecarShow.got[1][0].node;
    w.ctx.SIDECAR.node = node2; // what sidecarShow would have set
    await flush();
    assert.equal(node2.querySelector('.pd-body').innerHTML, '<md># Datei</md>');
    assert.equal(node2.querySelector('.pd-hint').textContent, 'chat-side.planDateiStand');
  });

  it('a background tab: state only, the nav tooltip follows — no tab-bar rebuild, and the visible tab\'s rail untouched', () => {
    const w = approved();
    const other = { id: 'c2', streaming: true, msgEl: rootEl(), agents: [], openPoints: [], hooks: [] };
    w.ctx.ACTIVE = other;
    w.refresh(); // the rail now shows the OTHER tab (no plan)
    const slot = w.ids['#chatSideSlot'], shown = slot.children.slice();
    slot.children.push(new FakeEl('i')); shown.push(slot.children[slot.children.length - 1]); // a marker a rebuild would drop
    w.tab.streaming = true;
    const tabs = w.ctx.renderTabs.got.length, nav = w.ctx.refreshNavBusy.got.length;
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S1"}'), null);
    w.call('takePlanStatus', w.tab, status('{"aktiv":"nur ein Satz"}'), null);
    assert.equal(w.tab.plan.current, 'S1');
    assert.equal(w.ctx.renderTabs.got.length, tabs, 'renderTabs empties the bar — an open rename field went with it');
    assert.equal(w.ctx.refreshNavBusy.got.length, nav + 2, 'the one place another tab\'s phase shows');
    assert.deepEqual(slot.children, shown, 'the visible rail was not rebuilt');
  });
});

describe('PF-1 wiring — a turn that ends, a transcript that is trimmed (chat-render.js)', () => {
  it('a plan decision stashed before its gate, then the turn ends: the rail stops saying „wartet auf Freigabe" (clearAsksForTab)', () => {
    const w = world();
    w.call('planSeen', w.tab, 'toolu_A', SAMPLE, FILE);
    w.call('planSeen', w.tab, 'toolu_Q', SAMPLE, FILE); // a second proposal whose card nobody touched
    const ASK_GATES = new Map([
      ['toolu_A', { tab: w.tab, isPlan: true, answeredFallback: true, pendingBehavior: 'allow', pendingSettle: null }],
      ['toolu_Q', { tab: w.tab, isPlan: true, group: new FakeEl('div') }],
    ]);
    const { clearAsksForTab } = bundle([liftFn(CHAT_RENDER, 'clearAsksForTab', 'chat-render.js')], ['clearAsksForTab'],
      { ASK_GATES, settleGate: () => {}, ACTIVE: w.tab, renderQueueStrip: () => {}, planSuperseded: w.fn('planSuperseded'), planCardOrphan: w.fn('planCardOrphan') });
    clearAsksForTab(w.tab);
    assert.equal(ASK_GATES.size, 0);
    // PF-1b — the stashed approval never reached the CLI: the proposal is ORPHANED (▶ Plan starten does what the
    // click wanted), not put away — only a stashed „Weiter planen" is that decision (below)
    assert.equal(w.tab.planCandidates.toolu_A.state, 'proposed');
    assert.equal(w.tab.planCandidates.toolu_A.gate, 'none');
    assert.equal(w.tab.planCandidates.toolu_Q.state, 'proposed', 'an untouched card is retirePlanCards\' business, not this');
    assert.equal(w.tab.planCandidates.toolu_Q.gate, '');
    // a stashed „Weiter planen" never reached the CLI either: the transcript holds no answer for it (no result, an
    // AbortError, a Stop's „doesn't want to proceed"), so the fold orphans it — and the live tab now does the same,
    // with the decision's feedback still in the card's field (counter-check: it used to supersede it)
    const k = world();
    const kc = proposeWithCard(k, 'toolu_K');
    kc.querySelector('.opt-ff-input').value = 'Erst die Route.';
    kc._done = true;
    k.ctx.ASK_GATES.set('toolu_K', Object.assign(k.ctx.ASK_GATES.get('toolu_K'), { answeredFallback: true, pendingBehavior: 'deny', pendingMessage: 'Bitte den Plan noch nicht ausführen — weiter planen.\n\nErst die Route.', pendingSettle: null }));
    k.call('clearAsksForTab', k.tab);
    assert.deepEqual([k.tab.plan.state, k.tab.plan.gate], ['proposed', 'none']);
    assert.equal(kc.dataset.orphan, 'lost');
    assert.equal(kc.querySelector('.plan-why').textContent, 'chat-render.planOhneGateEntscheidungVerloren');
    assert.equal(kc.querySelector('.opt-ff-input').value, 'Erst die Route.', 'the feedback is still there for ✎ Weiter planen');
    assert.equal(kc.querySelector('.opt-ff-input').disabled, false);
    assert.deepEqual(kc.querySelector('.opt-actions').children.map((b) => b.textContent), ['▶ chat-side.planStarten', '✎ chat-perms.weiterPlanen']);
    const P = require('../public/js/plan-progress');
    const lines = [{ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'tool_use', id: 'toolu_K', name: 'ExitPlanMode', input: { plan: SAMPLE } }] } },
      { type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: 'und jetzt?' }] } }];
    const f = P.planFoldNew(); lines.forEach((l) => P.planFoldLine(f, l));
    assert.deepEqual([P.planFoldResult(f).state, P.planFoldResult(f).gate], ['proposed', 'none'], 'the fold of the same course');
    // an approval that DID go out is a plan underway — planSuperseded touches proposals only
    const a = approved();
    const G2 = new Map([['toolu_A', { tab: a.tab, isPlan: true, answeredFallback: true }]]);
    bundle([liftFn(CHAT_RENDER, 'clearAsksForTab', 'chat-render.js')], ['clearAsksForTab'],
      { ASK_GATES: G2, settleGate: () => {}, ACTIVE: a.tab, renderQueueStrip: () => {}, planSuperseded: a.fn('planSuperseded'), planCardOrphan: a.fn('planCardOrphan') }).clearAsksForTab(a.tab);
    assert.equal(a.tab.plan.state, 'active');
  });

  it('trimTranscript\'s prune drops the jump targets of the rows it took out (pruneToolCards) — a stop keeps those on screen', () => {
    const { pruneToolCards } = bundle([liftFn(CHAT_RENDER, 'pruneToolCards', 'chat-render.js')], ['pruneToolCards'], {});
    const w = approved();
    const kept = bubbleIn(w).parentElement, gone = bubbleIn(w).parentElement;
    w.tab._planRows = { S1: gone, S2: kept };
    gone.remove();
    pruneToolCards(w.tab);
    assert.deepEqual(Object.keys(w.tab._planRows), ['S2']);
    pruneToolCards(w.tab, true);
    assert.deepEqual(Object.keys(w.tab._planRows), ['S2']);
    assert.match(liftFn(CHAT_RENDER, 'trimTranscript', 'chat-render.js'), /groups\[i\]\.remove\(\); \}\s*pruneToolCards\(tab\);/, 'trimTranscript prunes right after it removes');
  });
});

describe('PF-1 wiring — the stream never paints a half-written plan-status block (render.js)', () => {
  const env = { t: (k) => k, renderMdBlocks: (s) => s, highlightCode: (c) => c, mdEscape: (s) => s };
  const { renderMarkdown, MD_LIFTED_FENCES, MD_LIFTED_FENCE_RE } = bundle(
    [liftConst(RENDER, 'MD_LIFTED_FENCES', 'render.js'), liftConst(RENDER, 'MD_LIFTED_FENCE_RE', 'render.js'), liftFn(RENDER, 'renderMarkdown', 'render.js')],
    ['renderMarkdown', 'MD_LIFTED_FENCES', 'MD_LIFTED_FENCE_RE'], env);

  it('while streaming the open tail goes — with the JSON on the next line or on the fence line itself', () => {
    const live = { stream: true };
    assert.equal(renderMarkdown('Text\n\n```plan-status\n{"aktuell":"S1","ak', live).trim(), 'Text');
    assert.equal(renderMarkdown('Text\n```plan-status {"aktuell":"S1"', live).trim(), 'Text');
    assert.equal(renderMarkdown('Text\n```plan-status\n{"aktuell":"S1"}\n``', live).trim(), 'Text', 'a closing fence still arriving');
    // …but only up to a blank line: what follows a block the model forgot to close is prose again
    assert.equal(renderMarkdown('Text\n\n```plan-status\n{"aktuell":"S1"}\n\nWeiter im Text', live).replace(/\s+/g, ' ').trim(), 'Text Weiter im Text');
  });

  it('a FINISHED message never loses text to an unclosed block — the bubble shows what planStatusStrip left', () => {
    const P = require('../public/js/plan-progress');
    const msg = 'Ich mache weiter.\n\n```plan-status\n{"aktuell":"S2"}\n\nWICHTIG: danach geht es weiter.';
    const out = renderMarkdown(P.planStatusStrip(msg));
    assert.match(out, /Ich mache weiter\.[\s\S]*WICHTIG: danach geht es weiter\./);
    assert.ok(!/aktuell/.test(out), 'the report itself is gone — applied by takePlanStatus');
    // not JSON: everything stays readable (it used to vanish with all the text after it)
    const bad = 'Vorher\n```plan-status\nkein json\nNachher';
    assert.match(renderMarkdown(P.planStatusStrip(bad)), /Vorher[\s\S]*kein json[\s\S]*Nachher/);
    // the stream renderer is the one caller that says „still arriving"
    assert.match(liftFn(CHAT_RENDER, 'renderStreamEl', 'chat-render.js'), /elx\._live\.innerHTML = renderMarkdown\(raw\.slice\(elx\._committedLen\), \{ stream: true \}\)/);
  });

  it('…and so does the fence line arriving in pieces („```plan-st")', () => {
    for (const piece of ['```p', '```plan', '```plan-st', '```plan-status']) assert.equal(renderMarkdown('Text\n' + piece).trim(), 'Text', piece);
  });

  it('a complete block renders as nothing; invalid JSON stays a readable code block (planStatusStrip\'s rule)', () => {
    const out = renderMarkdown('Vorher\n```plan-status\n{"aktuell":"S1"}\n```\nNachher');
    assert.ok(!/aktuell/.test(out), out);
    assert.match(out, /Vorher[\s\S]*Nachher/);
    assert.match(renderMarkdown('```plan-status\n{kaputt\n```'), /<pre class="md-pre"><code class="lang-plan-status">\{kaputt<\/code><\/pre>/);
  });

  it('other blocks are untouched — a ```plan-schritte block (the approval\'s list) is NOT a status block', () => {
    assert.match(renderMarkdown('```plan-schritte\n[]\n```'), /lang-plan-schritte/);
    assert.match(renderMarkdown('```offene-punkte\n[{"frage":"x"'), /render\.offenePunkteWerdenGesammelt/, 'the open-points marker as before');
  });

  it('one list for both places: the stream renderer stays out of fence mode for every lifted block', () => {
    assert.deepEqual(MD_LIFTED_FENCES, ['ui-result', 'offene-punkte', 'plan-status']);
    for (const f of MD_LIFTED_FENCES) assert.ok(MD_LIFTED_FENCE_RE.test('```' + f + '\n'), f);
    assert.ok(!MD_LIFTED_FENCE_RE.test('```js\n'));
    assert.match(liftFn(CHAT_RENDER, 'renderStreamEl', 'chat-render.js'), /!MD_LIFTED_FENCE_RE\.test\(raw\.slice\(f, f \+ 16\)\)/);
  });
});

describe('PF-1 wiring — a reload keeps the plan (chat.js persistTabs / restoreTabs / closeTab / forkTab)', () => {
  it('persistTabs writes planSave(t.plan); restoreTabs reads it back through planRestore', () => {
    assert.match(liftFn(CHAT, 'persistTabs', 'chat.js'), /plan: \(t\.plan && typeof planSave === 'function'\) \? \(planSave\(t\.plan\) \|\| undefined\) : undefined/);
    // through planAdopt, the resume rule: a restored tab and a fork are new processes, so a proposal comes back
    // orphaned — no gate in them can decide it, only a start by message (PF-1b; it used to come back superseded)
    assert.match(liftFn(CHAT, 'restoreTabs', 'chat.js'), /if \(info\.plan && typeof planAdopt === 'function'\) t\.plan = planAdopt\(null, info\.plan\);/);
    assert.match(liftFn(CHAT, 'closeTab', 'chat.js'), /t\.plan = null; t\.planCandidates = null; t\._planRows = null; t\._planPrev = null;/);
    assert.match(liftFn(CHAT, 'forkTab', 'chat.js'), /nt\.plan = planAdopt\(null, planSave\(t\.plan\)\)/, 'a fork works on a COPY of the plan');
  });

  it('…and what that rule does to a waiting proposal, a plan underway and a dismissed one', () => {
    const w = world();
    w.call('planSeen', w.tab, 'toolu_A', SAMPLE, FILE);
    const copy = (p) => w.call('planAdopt', null, w.call('planSave', p));
    assert.equal(copy(w.tab.plan).state, 'proposed');
    assert.equal(copy(w.tab.plan).gate, 'none', 'orphaned: the gate stayed with the process that asked');
    assert.equal(copy(w.tab.plan).steps.length, 3, 'the steps come along all the same');
    assert.equal(w.tab.plan.state, 'proposed', 'the copy is a copy — the asking tab still waits');
    assert.equal(w.tab.plan.gate, '', '…on its own gate');
    const a = approved();
    assert.equal(copy(a.tab.plan).state, 'active');
    w.call('planDismiss', a.tab.plan);
    assert.equal(copy(a.tab.plan).state, 'dismissed');
  });

  it('what is saved is compact and comes back as the same plan — without the text', () => {
    const w = approved();
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S2","erledigt":["S1"],"aktiv":"Route"}'), null);
    const saved = JSON.stringify(w.call('planSave', w.tab.plan));
    assert.ok(!saved.includes('Text'), 'no plan text in localStorage');
    assert.ok(saved.length < 1500, saved.length + ' bytes');
    const back = w.call('planRestore', JSON.parse(saved));
    assert.equal(w.call('planSig', back), w.call('planSig', w.tab.plan), 'the rail paints the same thing after a reload');
    assert.equal(back.activeForm, 'Route');
  });
});

// ---- step 3: the resumed tab ------------------------------------------------------------------------------
// A resume repaints the transcript into an emptied tab. The plan comes from the server's fold (result.plan), the
// ExitPlanMode becomes a record card instead of a JSON fragment, and a step's first report in the painted tail
// becomes its jump target again. These pin the chat-side.js half; plan-flow.test.js pins the server half.
const SESSIONS = read('sessions.js');
// the transcript tail as lib/sessions.js sends it (tailTool: {title, file, chars} for an ExitPlanMode)
const epmEvent = (id) => ({ kind: 'assistant', text: 'Der Plan steht.', tools: [{ name: 'ExitPlanMode', id, plan: { title: 'Testvorhaben', file: FILE, chars: SAMPLE.length } }] });
const sayEvent = (text) => ({ kind: 'assistant', text, tools: [] });
// a bubble inside a message row inside the tab's transcript, as addMsg makes it
function bubbleIn(w) { const row = w.tab.msgEl.appendChild(new FakeEl('div')); row.className = 'msg'; return row.appendChild(new FakeEl('div')); }
const click = (btn) => btn.onclick({ stopPropagation() {} });

describe('PF-1 wiring — the resumed tab (chat-side.js planAdoptResumed / addPlanHistoryCard / planResumeMarks)', () => {
  it('the transcript\'s plan replaces the tab\'s and the rail repaints at once — switched off, nothing is adopted', () => {
    const w = approved();
    const fromT = plain(w.call('planSave', w.tab.plan));
    fromT.steps[0].status = 'completed';
    w.call('planAdoptResumed', w.tab, fromT);
    assert.equal(w.tab.plan.steps[0].status, 'completed', 'the transcript is the truth');
    assert.equal(w.tab.plan.text, SAMPLE, '…the live text of the same plan stays');
    assert.ok(w.ids['#chatSideSlot'].querySelector('.cside-plan'), 'the group is painted without waiting for a report');
    // switched off: adopted all the same (off is a view decision), painted nowhere — switched on again, the rail
    // shows the transcript's plan, not a stale one the tab kept while the transcript went on
    const off = world({ prefs: { planProgress: false } });
    off.call('planAdoptResumed', off.tab, fromT);
    assert.equal(off.tab.plan.steps[0].status, 'completed');
    assert.equal(off.refresh(), null, 'no group while off');
    assert.ok(off.ids['#chatSidePlan'].classList.contains('hidden'));
    const card = off.call('addPlanHistoryCard', bubbleIn(off), off.tab, epmEvent('toolu_A').tools[0]);
    assert.equal(card.querySelector('.ph-state').textContent, 'chat-side.planVerlaufOhneAntwort', 'the card is the record of the ExitPlanMode — without the progress');
    off.ctx.STATE.prefs.planProgress = true;
    assert.ok(off.refresh(), 'on again: there it is');
    // a background tab's resume refreshes the nav tooltip, not the tab bar (planChanged's reason)
    const bg = approved();
    bg.ctx.ACTIVE = { id: 'c9', agents: [], openPoints: [], hooks: [] };
    const tabs = bg.ctx.renderTabs.got.length;
    bg.call('planAdoptResumed', bg.tab, fromT);
    assert.equal(bg.ctx.renderTabs.got.length, tabs);
    assert.ok(bg.ctx.refreshNavBusy.got.length > 0);
  });

  it('the history card of the plan underway: title, its live state, [Plan öffnen] → the rail\'s sidecar', () => {
    const w = approved();
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S2","erledigt":["S1"]}'), null);
    const card = w.call('addPlanHistoryCard', bubbleIn(w), w.tab, epmEvent('toolu_A').tools[0]);
    assert.ok(card.classList.contains('plan-group') && card.dataset.toolId === 'toolu_A', 'planJumpTarget\'s second stage finds it like a live card');
    assert.equal(card.querySelector('.ph-title').textContent, 'Testvorhaben');
    // „Schritt 2 von 3" says the count — no „· 1/3" beside it that reads as one step fewer (the rail's planCountText)
    assert.equal(card.querySelector('.ph-state').textContent, 'chat-side.planSchrittVon');
    click(card.querySelector('.csp-btn'));
    assert.equal(w.ctx.sidecarShow.got[0][0].node.querySelector('.pd-count').textContent, '2/3', 'the sidecar counts like the rail: the step it is on');
    assert.equal(w.refresh().querySelector('.cside-groupcount').textContent, '2/3');
    // between two steps the rail's count is what is done — the card says the same
    w.call('takePlanStatus', w.tab, status('{"aktuell":"","erledigt":["S2"]}'), null);
    assert.equal(card.querySelector('.ph-state').textContent, 'chat-side.planZustandactive · 2/3');
    // the model reports on → the card follows (planChanged repaints the history cards on a structural change)
    w.call('takePlanStatus', w.tab, status('{"erledigt":["S1","S2","S3"],"fertig":true}'), null);
    assert.equal(card.querySelector('.ph-state').textContent, '✓ chat-side.planZustanddone · ✓3');
    click(card.querySelector('.csp-btn'));
    assert.equal(w.ctx.sidecarShow.got[1][0].node.querySelector('.pd-count').textContent, '✓3', 'the plan as the rail shows it');
    assert.equal(w.refresh().querySelector('.cside-groupcount').textContent, '✓3');
  });

  it('an earlier proposal: how it was answered, the user\'s feedback, and only its plan FILE to open', async () => {
    const w = approved();
    const card = w.call('addPlanHistoryCard', bubbleIn(w), w.tab, epmEvent('toolu_OLD').tools[0]);
    assert.equal(card.querySelector('.ph-state').textContent, 'chat-side.planVerlaufOhneAntwort', 'no answer painted yet');
    w.call('planHistoryCardResult', w.tab, card, 'Bitte den Plan noch überarbeiten: die Route zuerst');
    assert.equal(card.querySelector('.ph-state').textContent, 'chat-side.planVerlaufWeitergeplant');
    const reply = card.querySelector('.ph-reply');
    assert.equal(reply.textContent, 'Bitte den Plan noch überarbeiten: die Route zuerst');
    assert.ok(!reply.classList.contains('hidden'));
    // an approval says nothing worth reading again — the panel's own block and protocol stay out of the card
    const ok = w.call('addPlanHistoryCard', bubbleIn(w), w.tab, epmEvent('toolu_OK').tools[0]);
    w.call('planHistoryCardResult', w.tab, ok, w.call('planAcceptMessage', 'Plan genehmigt', w.tab.plan));
    assert.equal(ok.querySelector('.ph-state').textContent, 'chat-side.planVerlaufFreigegeben');
    assert.ok(ok.querySelector('.ph-reply').classList.contains('hidden'));
    // [Plan öffnen] on an earlier plan: no steps to show — it says so; its head says what the CARD says (not the
    // „verworfen (weiter geplant)" of the shape it is built from); no preview from this server → the file, as
    // „Datei-Stand" of an EARLIER plan (the CLI writes every plan of a session into the same file)
    w.ctx.SIDECAR.node = null;
    click(card.querySelector('.csp-btn'));
    const node = w.ctx.sidecarShow.got[0][0].node;
    assert.ok(node.querySelectorAll('.csp-empty').some((e) => e.textContent === 'chat-side.planFruehererPlan'));
    assert.equal(node.querySelector('.pd-state').textContent, 'chat-side.planVerlaufWeitergeplant');
    w.ctx.SIDECAR.node = node;
    await flush();
    assert.equal(node.querySelector('.pd-hint').textContent, 'chat-side.planDateiStandFrueher');
    click(ok.querySelector('.csp-btn'));
    assert.equal(w.ctx.sidecarShow.got[1][0].node.querySelector('.pd-state').textContent, 'chat-side.planVerlaufFreigegeben', 'an approval says „freigegeben"');
    // outside a plans folder there is nothing to open — no button rather than one that shows „Text fehlt"
    const nofile = w.call('addPlanHistoryCard', bubbleIn(w), w.tab, { name: 'ExitPlanMode', id: 'toolu_X', plan: { title: 'X', file: 'C:\\tmp\\x.md', chars: 9 } });
    assert.equal(nofile.querySelector('.csp-btn'), null);
  });

  it('an earlier plan opens as it was PROPOSED — the tail\'s preview, said to be cut when it is — not the newer file', () => {
    const w = approved();
    const long = '# Plan: Früher\n\n' + 'Zeile des früheren Plans.\n'.repeat(20);
    const tl = { name: 'ExitPlanMode', id: 'toolu_OLD', plan: { title: 'Früher', file: FILE, chars: long.length + 5000, preview: long } };
    const card = w.call('addPlanHistoryCard', bubbleIn(w), w.tab, tl);
    w.call('planHistoryCardResult', w.tab, card, 'Plan genehmigt — der Plan-Modus ist beendet.');
    w.ctx.api = () => { throw new Error('the file must not be read when the preview is there'); };
    click(card.querySelector('.csp-btn'));
    const shown = w.ctx.sidecarShow.got[0][0];
    assert.equal(shown.node.querySelector('.pd-body').innerHTML, '<md>' + long + '</md>');
    assert.equal(shown.raw, long, 'the copy button copies what is shown');
    assert.equal(shown.node.querySelector('.pd-hint').textContent, 'chat-side.planVorschauGekuerzt'.replace('{m}', long.length).replace('{n}', long.length + 5000));
    // the whole plan: no hint
    const all = w.call('addPlanHistoryCard', bubbleIn(w), w.tab, { name: 'ExitPlanMode', id: 'toolu_ALL', plan: { title: 'X', file: '', chars: 9, preview: '# Plan: X' } });
    assert.ok(all.querySelector('.csp-btn'), 'a preview is something to open even without a plan file');
    click(all.querySelector('.csp-btn'));
    assert.ok(w.ctx.sidecarShow.got[1][0].node.querySelector('.pd-hint').classList.contains('hidden'));
    // (the server half — tailTool sends `preview` — is pinned in plan-flow.test.js)
  });

  it('a language switch relabels every tab\'s history cards (render.js applyLang → planHistoryCardsRelabel)', () => {
    const w = approved();
    const card = w.call('addPlanHistoryCard', bubbleIn(w), w.tab, epmEvent('toolu_A').tools[0]);
    w.ctx.tt = (k) => 'EN:' + k; // what applyLang changes underneath: the dictionary tt() reads
    w.ctx.TABS = [w.tab];
    w.call('planHistoryCardsRelabel');
    assert.equal(card.querySelector('.opt-group-head').textContent, '📋 EN:chat-side.planVerlauf');
    assert.equal(card.querySelector('.csp-btn').textContent, 'EN:chat-side.planOeffnen');
    assert.match(card.querySelector('.ph-state').textContent, /^EN:chat-side\.planSchrittVon|^EN:chat-side\.planZustand/);
    assert.match(RENDER, /'planHistoryCardsRelabel'\]\.forEach\(\(fn\) => call\(fn\)\)/, 'applyLang must call it — the static-i18n pass walks past JS-drawn cards');
  });

  it('a step\'s first report in the tail becomes its jump target — reports before the plan\'s own ExitPlanMode do not count', () => {
    const w = approved();
    const events = [
      sayEvent(status('{"aktuell":"S1"}')), // about an EARLIER plan: its S1 is not this S1
      epmEvent('toolu_A'),
      sayEvent('Los.\n' + status('{"aktuell":"S1"}')),
      sayEvent(status('{"aktuell":"S2","erledigt":["S1"]}')),
      sayEvent(status('{"aktuell":"S9"}')), // unknown — never a target
    ];
    const marks = w.call('planResumeMarks', w.tab, events);
    assert.deepEqual(plain([...marks.values()]), [['S1'], ['S2']]);
    assert.ok(marks.get(events[2]) && marks.get(events[3]) && !marks.has(events[0]) && !marks.has(events[4]));
    assert.equal(w.call('planResumeMarks', { plan: null }, events).size, 0);
  });

  it('sessions.js renderResumeHistory: adopt before the paint, strip the reports, a plan card instead of the JSON card', () => {
    const fnSrc = liftFn(SESSIONS, 'renderResumeHistory', 'sessions.js');
    const iAdopt = fnSrc.indexOf('planAdoptResumed(tab, r.plan, { orphan: r.planOrphan, last: r.planLast })'), iPaint = fnSrc.indexOf('head.forEach(paintEvent)');
    assert.ok(iAdopt > 0 && iAdopt < iPaint, 'the plan must be adopted BEFORE the paint — the cards and marks read it');
    assert.match(fnSrc, /planStatusStrip\(e\.text\)/);
    assert.match(fnSrc, /tl\.name === 'ExitPlanMode' && tl\.plan && typeof addPlanHistoryCard === 'function'/, 'an older server (capped input) keeps the generic card');
    assert.match(fnSrc, /classList\.contains\('plan-hist'\)[\s\S]{0,120}planHistoryCardResult\(tab, card, rr\.text\)/);
    assert.match(fnSrc, /markHideableRow\(b, \{ text: '', thinking: '', tools: toolCards, status: lifted, other: planCards \}\)/);
  });
});

// ---- PF-1b: the checklist also when the plan could never be approved ------------------------------------------
// The 05.10. course, synthetically (no real plan text): the model called ExitPlanMode in a session running in
// „Auto", the CLI answered „You are not in plan mode" and no can_use_tool ever came — the card's „Plan annehmen"
// answered nobody, the rail said „wartet auf Freigabe" for good, a typed „plan starten" carried no protocol, and the
// model worked through its steps with nothing in the rail. These pin the wiring of the fix: the orphan (chat-events →
// planCardOrphan), ▶ Plan starten (card and rail, through the REAL sendMessage), the composer chip, 📋 Schritte
// anfordern, the folded attachment of the user row, and that the live tab ends where the resume fold ends.
const NO_PLAN_MODE = '<tool_use_error>You are not in plan mode. To enter plan mode, call the EnterPlanMode tool first (synthetisch).</tool_use_error>';
// sendMessage / deliverText / enqueueMessage / flushQueue / queueChanged / resetComposer RUN, lifted out of
// chat-composer.js and compiled inside `with (env)` like handleEventBody above: this world's plan functions, the
// chip and the queue are real, the network and the DOM around the composer are stubs. Installed as the world's
// sendMessage, so a click on ▶ or 📋 goes the whole way a click in the browser goes.
function composerHarness(w, extra) {
  const posted = [], failed = [], msgs = [];
  const stub = () => undefined;
  const o = extra || {};
  const known = Object.assign(Object.create(null), {
    chat: w.tab, ACTIVE: w.tab, $: (sel) => w.ids[sel] || null,
    attachmentsOf: () => [], DISPLAY: { guard: false }, typedReplyCard: () => null, EDIT_TARGET: null,
    withTab: (t, f) => f(), ensureChatStarted: async () => {}, isDefaultTitle: () => false,
    addMsg: (role, text) => { const m = w.tab.msgEl.appendChild(new FakeEl('div')); m.className = 'msg ' + role; m.text = text; msgs.push(text); return { m, b: m }; },
    setComposerBusy: (b) => { w.tab.streaming = !!b; }, hasHeldGate: (t) => w.ctx.hasHeldGate(t),
    api: (url, req) => { posted.push(JSON.parse(req.body).text); return o.fail ? Promise.reject(new Error('500 (synthetisch)')) : Promise.resolve({}); },
    markSendFailed: (...a) => { failed.push(a); w.tab.streaming = false; }, // the real one frees the composer too
  }, o.env || {});
  const env = new Proxy(known, {
    has: (t, k) => typeof k === 'string' && (k in t || k in w.ctx || !(k in globalThis)),
    get: (t, k) => (typeof k !== 'string' ? undefined : k in t ? t[k] : k in w.ctx ? w.ctx[k] : stub),
  });
  const names = ['sendMessage', 'deliverText', 'enqueueMessage', 'flushQueue', 'queueChanged', 'resetComposer'];
  const src = names.map((n) => liftFn(CHAT_COMPOSER, n, 'chat-composer.js')).join('\n');
  const h = new Function('__env', 'with (__env) {\n' + src + '\nreturn { ' + names.join(', ') + ' };\n}')(env);
  w.ctx.sendMessage = h.sendMessage;
  // typed into an idle tab, the turn it starts is over by the next line of the test (its `result` is not this
  // file's business); typed into a busy one, the tab stays busy and the message queues
  const type = async (text, more) => {
    const busy = w.tab.streaming;
    w.ids['#composerInput'].value = text; await h.sendMessage(more); await flush();
    if (!busy) w.tab.streaming = false;
  };
  return Object.assign(h, { posted, failed, msgs, type });
}
// the real handleEventBody, with the card half wired in
function events(w) {
  return eventHarness(w, {
    addPlanCard: w.fn('addPlanCard'), planCardOrphan: w.fn('planCardOrphan'), planCandidateOf: w.fn('planCandidateOf'),
    planGateLost: w.fn('planGateLost'), planIsNoPlanModeError: w.fn('planIsNoPlanModeError'), ASK_GATES: w.ctx.ASK_GATES,
    liveToolResultText: (b) => (typeof b.content === 'string' ? b.content : ''),
  }).handleEventBody;
}
const epmFrame = (id, md) => ({ type: 'assistant', message: { content: [{ type: 'text', text: 'Der Plan steht.' }, { type: 'tool_use', id, name: 'ExitPlanMode', input: { plan: md || SAMPLE, planFilePath: FILE } }] } });
const resultFrame = (id, text, isError) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError !== false }] } });
const sayFrame = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const cardOf = (w, id) => w.tab.msgEl.querySelectorAll('.plan-group').find((g) => g.dataset.toolId === id);
const footBtns = (g) => g.querySelector('.csp-foot').querySelectorAll('.csp-btn').map((b) => b.textContent);
const chipOf = (w) => w.ids['#attachChips'].querySelector('.plan-chip');
const refusedWorld = () => { const w = world(); const ev = events(w); ev(epmFrame('toolu_R')); ev(resultFrame('toolu_R', NO_PLAN_MODE)); return { w, ev }; };

describe('PF-1b wiring — a plan no gate will ever decide (chat-events.js → planCardOrphan)', () => {
  it('the CLI refuses ExitPlanMode outside plan mode → orphaned: the card offers ▶, the rail says „Plan liegt vor", the chip is there', () => {
    const w = world();
    const ev = events(w);
    ev(epmFrame('toolu_R'));
    // before the refusal: a proposal whose card waits for its gate — the card decides, nothing else offers a start
    assert.equal(w.refresh().querySelector('.csp-state').textContent, 'chat-side.planWartetAufFreigabe');
    assert.deepEqual(footBtns(w.refresh()), ['chat-side.planOeffnen'], 'no ▶ and no 📋 beside a gate that can still decide');
    assert.equal(chipOf(w), null, 'no chip while the card waits');
    ev(resultFrame('toolu_R', NO_PLAN_MODE));
    assert.deepEqual([w.tab.plan.id, w.tab.plan.state, w.tab.plan.gate], ['toolu_R', 'proposed', 'none']);
    assert.equal(w.ctx.ASK_GATES.has('toolu_R'), false, 'no gate entry left — it would hold the queue strip\'s „wartet auf deine Antwort"');
    const card = cardOf(w, 'toolu_R');
    assert.ok(card.classList.contains('is-orphan') && card._done);
    assert.equal(card.dataset.orphan, 'noplanmode');
    assert.equal(card.querySelector('.opt-group-head').textContent, '📋 chat-side.planLiegtVor');
    assert.equal(card.querySelector('.plan-why').textContent, 'chat-render.planOhneGateNichtPlanmodus');
    assert.deepEqual(card.querySelector('.opt-actions').children.map((b) => b.textContent), ['▶ chat-side.planStarten', '✎ chat-perms.weiterPlanen']);
    const g = w.refresh();
    assert.ok(g.classList.contains('is-orphan'));
    assert.equal(g.querySelector('.csp-state').textContent, 'chat-side.planLiegtVor');
    assert.deepEqual(footBtns(g), ['▶ chat-side.planStarten', 'chat-side.planOeffnen', '📋 chat-side.planSchritteAnfordern']);
    assert.ok(g.querySelector('.csp-btn.is-primary'), '▶ is the filled button of the foot');
    assert.ok(chipOf(w) && chipOf(w).classList.contains('is-on'), 'the chip „📋 Plan-Fortschritt mitsenden", on by default');
  });

  it('only for THIS tab\'s plan: another tool\'s error, a result that is no error, a feedback quoting the sentence change nothing', () => {
    const w = world();
    const ev = events(w);
    ev(epmFrame('toolu_R'));
    ev(resultFrame('toolu_other', NO_PLAN_MODE));
    ev(resultFrame('toolu_R', NO_PLAN_MODE, false));
    ev(resultFrame('toolu_R', 'Bitte den Plan noch nicht ausführen — weiter planen.\n\nYou are not in plan mode, sagt die CLI'));
    assert.equal(w.tab.plan.gate, '');
    assert.ok(w.ctx.ASK_GATES.has('toolu_R'), 'the card still waits for its gate');
    // an aborted permission request is a lost gate as well — the turn ended while the card waited
    ev(resultFrame('toolu_R', 'Tool permission request failed: AbortError: aborted (synthetisch)'));
    assert.equal(w.tab.plan.gate, 'none');
    assert.equal(cardOf(w, 'toolu_R').dataset.orphan, 'turnend');
  });

  it('a turn that ends while the card waits (interrupt, exit) orphans it — retirePlanCards no longer lets it lapse unseen', () => {
    const w = world();
    const card = proposeWithCard(w, 'toolu_T');
    w.call('retirePlanCards', w.tab);
    assert.deepEqual([w.tab.plan.state, w.tab.plan.gate], ['proposed', 'none'], 'it used to be superseded — gone from the rail, kept by the fold');
    assert.ok(card.classList.contains('is-orphan'));
    assert.equal(card.querySelector('.plan-why').textContent, 'chat-render.planOhneGateTurnEnde');
    assert.equal(w.ctx.ASK_GATES.size, 0);
    assert.equal(w.refresh().querySelector('.csp-state').textContent, 'chat-side.planLiegtVor');
  });
});

describe('PF-1b wiring — ▶ Plan starten: the approval as an ordinary message (card, rail, the real sendMessage)', () => {
  it('▶ on the card sends planStartMessage; the plan is underway at once, the card says so, the reports tick the checklist', async () => {
    const { w, ev } = refusedWorld();
    const H = composerHarness(w);
    const cand = w.tab.plan;
    cardOf(w, 'toolu_R').querySelector('.opt-send').onclick();
    await flush();
    assert.equal(H.posted.length, 1);
    assert.equal(H.posted[0], w.call('planStartMessage', 'chat-side.planStartKopf', cand), 'head, the list WITHOUT states, the protocol');
    assert.deepEqual([w.tab.plan.id, w.tab.plan.state, w.tab.plan.gate], ['toolu_R', 'active', 'none']);
    assert.ok(w.tab.plan.acceptedAt > 0);
    assert.equal(cardOf(w, 'toolu_R').querySelector('.opt-done').textContent, '→ ▶ chat-render.planGestartet');
    let g = w.refresh();
    assert.equal(g.querySelector('.csp-state').textContent, 'chat-side.planZustandactive');
    assert.equal(chipOf(w), null, 'started — the chip is gone and can never attach a second time');
    // the model keeps the protocol: list confirmed, then step by step → ✓ ⏳ ☐ with „Schritt n von m"
    ev(sayFrame('Los.\n' + status('{"schritte":[{"id":"S1","titel":"Modul"},{"id":"S2","titel":"Route"},{"id":"S3","titel":"Tests"}],"aktuell":"S1"}')));
    ev(sayFrame(status('{"aktuell":"S2","erledigt":["S1"],"aktiv":"Verdrahte die Route"}')));
    g = w.refresh();
    assert.deepEqual(byClass(g, 'csp-step').map((r) => r.querySelector('.todo-mark').textContent), ['✓', '⏳', '☐']);
    assert.equal(g.querySelector('.csp-state').textContent, 'chat-side.planSchrittVon'.replace('{i}', 2).replace('{n}', 3));
    assert.equal(g.querySelector('.cside-groupcount').textContent, '2/3');
    ev(sayFrame('Fertig.\n' + status('{"erledigt":["S1","S2","S3"],"fertig":true}')));
    assert.equal(w.refresh().querySelector('.cside-groupcount').textContent, '✓3');
  });

  it('while a turn runs: „(nach diesem Turn)" — clicked, the start waits in the queue as a standalone entry; flushed, it starts', async () => {
    const { w } = refusedWorld();
    const H = composerHarness(w);
    w.tab.streaming = true;
    let g = w.refresh();
    assert.equal(footBtns(g)[0], '▶ chat-side.planStarten chat-side.planNachDiesemTurn');
    w.call('planCardsPaint', w.tab);
    assert.equal(cardOf(w, 'toolu_R').querySelector('.opt-send').textContent, '▶ chat-side.planStarten chat-side.planNachDiesemTurn');
    g.querySelector('.csp-btn.is-primary').onclick({ stopPropagation() {} });
    await flush();
    assert.equal(H.posted.length, 0, 'not sent into a running turn');
    assert.equal(w.tab.queue.length, 1);
    assert.equal(w.tab.queue[0].plan, true, 'standalone in the queue: never merged, never ridden into a card answer');
    assert.equal(w.tab.plan.state, 'proposed', 'the start counts when it goes out — where the fold will read it');
    g = w.refresh();
    const q = g.querySelector('.csp-btn.is-primary');
    assert.equal(q.textContent, '⏳ chat-side.planStartetNachTurn');
    assert.equal(q.attrs['aria-disabled'], 'true');
    assert.equal(cardOf(w, 'toolu_R').querySelector('.opt-done').textContent, '⏳ chat-side.planStartetNachTurn');
    assert.equal(chipOf(w), null, 'one start on its way — the chip would attach a second one');
    // × in the queue strip takes it back → ▶ is offered again (derived from the queue, nothing stale)
    w.tab.queue.splice(0, 1); H.queueChanged(w.tab);
    assert.equal(footBtns(w.refresh())[0], '▶ chat-side.planStarten chat-side.planNachDiesemTurn');
    // clicked again, and this time the turn ends: the flush sends it and starts the plan
    w.refresh().querySelector('.csp-btn.is-primary').onclick({ stopPropagation() {} });
    await flush();
    w.tab.streaming = false;
    H.flushQueue(w.tab);
    await flush();
    assert.equal(H.posted.length, 1);
    assert.equal(w.call('planOutgoingKind', H.posted[0]), 'start');
    assert.equal(w.tab.plan.state, 'active');
  });

  it('a start that never reached the CLI is taken back — the orphan again, ▶ again (planOutgoingSettled)', async () => {
    const { w } = refusedWorld();
    const H = composerHarness(w, { fail: true });
    w.refresh().querySelector('.csp-btn.is-primary').onclick({ stopPropagation() {} });
    await flush(); await flush();
    assert.equal(H.failed.length, 1, 'the bubble says it did not go out (markSendFailed)');
    assert.deepEqual([w.tab.plan.state, w.tab.plan.gate, w.tab.plan.acceptedAt], ['proposed', 'none', 0]);
    assert.equal(footBtns(w.refresh())[0], '▶ chat-side.planStarten');
  });

  it('„Weiter planen" on the orphan card: the feedback goes into the composer under the keep sentence; sent, the proposal is put away', async () => {
    const { w } = refusedWorld();
    const H = composerHarness(w);
    const card = cardOf(w, 'toolu_R');
    card.querySelector('.opt-ff-input').value = 'Erst die Route.';
    card.querySelector('.plan-keep').onclick();
    const [text] = w.ctx.composerSet.got[0];
    assert.equal(text, 'chat-render.bitteDenPlanNoch\n\nErst die Route.');
    assert.equal(w.tab._planChipOff, true, 'a keep carries no start — the chip says „aus" for it');
    assert.equal(w.tab.plan.state, 'proposed', 'the click decides nothing yet — ▶ stays until the message goes out');
    // what the real dictionary sends (the world's tt answers with the key)
    await H.type('Bitte den Plan noch nicht ausführen — weiter planen.\n\nErst die Route.');
    assert.equal(H.posted[0], 'Bitte den Plan noch nicht ausführen — weiter planen.\n\nErst die Route.', 'nothing attached to a keep');
    assert.equal(w.tab.plan.state, 'superseded');
    assert.equal(card.querySelector('.opt-done').textContent, '→ chat-perms.weiterPlanen');
    assert.equal(w.refresh(), null, 'the rail drops it, as after „Weiter planen" through a gate');
  });

  it('under a plan underway: the refused proposal waits in its card — ▶ there starts it, the old plan goes into the history', async () => {
    const w = approved();
    await flush();
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S2","erledigt":["S1"]}'), null);
    const ev = events(w);
    const H = composerHarness(w);
    ev(epmFrame('toolu_B', '# Plan: Zweiter\n## Schritte\n### Eins\n### Zwei\n'));
    ev(resultFrame('toolu_B', NO_PLAN_MODE));
    assert.equal(w.tab.plan.id, 'toolu_A', 'the plan underway stays on top');
    assert.equal(w.tab._planOrphan && w.tab._planOrphan.id, 'toolu_B');
    assert.equal(chipOf(w), null, 'the chip is for the plan on top only — that one is underway');
    // a newer refused proposal makes the older card no longer startable (the fold knows the newest orphan only)
    ev(epmFrame('toolu_C', '# Plan: Dritter\n## Schritte\n### X\n### Y\n'));
    ev(resultFrame('toolu_C', NO_PLAN_MODE));
    assert.equal(cardOf(w, 'toolu_B').querySelector('.opt-done').textContent, '⏹ chat-render.planNichtMehrStartbar');
    cardOf(w, 'toolu_C').querySelector('.opt-send').onclick();
    await flush();
    assert.equal(w.tab.plan.id, 'toolu_C');
    assert.equal(w.tab.plan.state, 'active');
    assert.deepEqual(plain(w.tab.plan.history.map((h) => [h.id, h.state, h.done])), [['toolu_A', 'replaced', 1]]);
    assert.equal(w.call('planOutgoingKind', H.posted[0]), 'start');
  });
});

describe('PF-1b wiring — the composer chip „📋 Plan-Fortschritt mitsenden" (chat-composer.js)', () => {
  it('a typed „plan starten" carries the step list and the protocol — once: the plan is underway, the chip gone', async () => {
    const { w } = refusedWorld();
    const H = composerHarness(w);
    const plan = w.tab.plan;
    await H.type('plan starten');
    assert.equal(H.posted[0], 'plan starten\n\n' + w.call('planStartMessage', '', plan));
    assert.equal(H.msgs[0], H.posted[0], 'the row gets what went out — addMsg folds the attachment (below)');
    assert.equal(w.tab.plan.state, 'active');
    assert.equal(chipOf(w), null);
    await H.type('weiter so');
    assert.equal(H.posted[1], 'weiter so', 'never attached twice');
  });

  it('switched off it attaches nothing and the plan stays on the table; the emptied composer turns it back on', async () => {
    const { w } = refusedWorld();
    const H = composerHarness(w);
    chipOf(w).onclick();
    assert.equal(w.tab._planChipOff, true);
    assert.ok(chipOf(w).classList.contains('is-off'));
    assert.equal(chipOf(w).attrs['aria-pressed'], 'false');
    await H.type('plan starten');
    assert.equal(H.posted[0], 'plan starten');
    assert.deepEqual([w.tab.plan.state, w.tab.plan.gate], ['proposed', 'none'], 'the model works — the rail still has no list');
    assert.ok(chipOf(w).classList.contains('is-on'), 'the composer emptied (resetComposer) — the chip is back on');
    // …and the typed path's own reset: the input listener calls planChipReset once the composer is empty
    assert.match(CHAT_COMPOSER, /if \(!v\.trim\(\)\) planChipReset\(ACTIVE\);/);
  });

  it('a command, a quick reply, the queue: a command never; a quick reply never; a queued one exactly once', async () => {
    const { w } = refusedWorld();
    const H = composerHarness(w);
    await H.type('/compact');
    assert.equal(H.posted[0], '/compact', 'a command stays the whole message');
    assert.equal(w.tab.plan.state, 'proposed');
    // a quick reply („Nein" under the model's question) is clicked in the transcript, not under the chip — it used to
    // carry „Beginne die Umsetzung" with it and start the orphan, live and in the fold
    const { sendQuick } = bundle([liftFn(CHAT_RENDER, 'sendQuick', 'chat-render.js')], ['sendQuick'], { sendMessage: H.sendMessage, chat: w.tab });
    sendQuick('Nein');
    await flush(); await flush();
    assert.equal(H.posted[1], 'Nein');
    assert.deepEqual([w.tab.plan.state, w.tab.plan.gate], ['proposed', 'none'], 'the plan stays on the table');
    assert.ok(chipOf(w), 'and the chip is still offered for what is typed');
    // the queue: typed while a turn runs → queued WITH the attachment, as a standalone entry; nothing more after it
    const q = refusedWorld().w;
    const HQ = composerHarness(q);
    q.tab.streaming = true;
    await HQ.type('plan starten');
    assert.equal(q.tab.queue.length, 1);
    assert.ok(q.tab.queue[0].text.startsWith('plan starten\n\n```plan-schritte'));
    assert.equal(q.tab.queue[0].plan, true);
    assert.equal(chipOf(q), null, 'one start waits already');
    await HQ.type('und noch das');
    assert.equal(q.tab.queue[1].text, 'und noch das');
    assert.equal(q.tab.queue[1].plan, undefined);
    q.tab.streaming = false;
    HQ.flushQueue(q.tab); await flush();
    assert.equal(q.tab.plan.state, 'active');
  });

  it('shown only for a proposal a start could begin, with no card waiting — not beside a gate, a question, a plan underway, the switch off', () => {
    const g = world();
    proposeWithCard(g, 'toolu_G');
    g.call('renderPlanChip');
    assert.equal(chipOf(g), null, 'a proposal whose card still waits for its gate');
    const { w } = refusedWorld();
    assert.ok(chipOf(w));
    w.ctx.ASK_GATES.set('toolu_Q', { tab: w.tab, group: new FakeEl('div'), requestId: 'r1' }); // an AskUserQuestion holds the turn
    w.call('renderPlanChip');
    assert.equal(chipOf(w), null, 'a question waits — the chip would talk over it');
    w.ctx.ASK_GATES.delete('toolu_Q');
    w.ctx.STATE.prefs.planProgress = false;
    w.call('renderPlanChip');
    assert.equal(chipOf(w), null, 'switched off');
    w.ctx.STATE.prefs.planProgress = true;
    w.call('renderPlanChip');
    assert.ok(chipOf(w), 'on again');
    assert.equal(w.call('planChipAttachment', w.tab, '/clear'), '');
    assert.equal(w.call('planChipAttachment', w.tab, w.call('planStartMessage', 'schon drin', w.tab.plan)), '', 'a text that already carries a start');
    assert.equal(w.call('planChipAttachment', w.tab, 'Bitte den Plan noch nicht ausführen — weiter planen.'), '', 'a keep');
  });
});

describe('PF-1b wiring — 📋 Schritte anfordern and the foot buttons', () => {
  it('the orphan the model works on without a word: one click asks for the list; the answer makes it the plan underway', async () => {
    const w = world();
    const ev = events(w);
    const H = composerHarness(w);
    ev(epmFrame('toolu_L', '# Plan: Lebender Plan\n\nNur Prosa, keine Schritte.\n'));
    ev(resultFrame('toolu_L', NO_PLAN_MODE));
    assert.equal(w.refresh().querySelector('.csp-empty').textContent, 'chat-side.planKeineSchritteVerwaist');
    chipOf(w).onclick(); // „plan starten" WITHOUT the chip — the 05.10. course
    await H.type('plan starten');
    ev(sayFrame('Ich starte mit Schritt 0 — Inventar.'));
    w.tab.streaming = true;
    const g = w.refresh();
    const ask = g.querySelector('.csp-foot').querySelectorAll('.csp-btn').find((b) => b.textContent.startsWith('📋'));
    assert.ok(ask, 'offered while the model works — that is when it is needed');
    assert.equal(ask.textContent, '📋 chat-side.planSchritteAnfordern chat-side.planNachDiesemTurn');
    w.tab.streaming = false;
    w.refresh().querySelector('.csp-foot').querySelectorAll('.csp-btn').find((b) => b.textContent.startsWith('📋')).onclick({ stopPropagation() {} });
    await flush();
    assert.equal(H.posted[1], w.call('planStepsRequestMessage', 'chat-side.planSchritteFrage', w.tab.plan));
    assert.equal(w.call('planOutgoingKind', H.posted[1]), '', 'a question — it starts nothing, live or in the fold');
    assert.equal(w.tab.plan.state, 'proposed');
    ev(sayFrame(status('{"schritte":[{"id":"S1","titel":"Inventar"},{"id":"S2","titel":"Workflow"},{"id":"S3","titel":"Abnahme"}],"aktuell":"S2","erledigt":["S1"]}')));
    assert.deepEqual([w.tab.plan.id, w.tab.plan.state, w.tab.plan.src], ['toolu_L', 'active', 'model']);
    w.tab.streaming = false; // the answering turn is over
    const done = w.refresh();
    assert.deepEqual(byClass(done, 'csp-step').map((r) => r.querySelector('.todo-mark').textContent), ['✓', '⏳', '☐']);
    assert.ok(!footBtns(done).some((t) => t.startsWith('📋')), 'the list is confirmed — [Stand abfragen] takes over');
    assert.ok(footBtns(done).includes('chat-side.planStandAbfragen'));
  });

  it('a plan underway that never reported: 📋 at rest, busy only after PLAN_QUIET_TOOLS silent tool calls; never both buttons', () => {
    const w = approved();
    const btns = () => footBtns(w.refresh());
    assert.deepEqual(btns(), ['chat-side.planOeffnen', '📋 chat-side.planSchritteAnfordern'], 'at rest, no report yet');
    w.tab.streaming = true;
    assert.deepEqual(btns(), ['chat-side.planOeffnen'], 'right after an approval the model is about to report — no noise');
    w.call('planNoteTools', w.tab, w.fn('PLAN_QUIET_TOOLS'));
    assert.deepEqual(btns(), ['chat-side.planOeffnen', '📋 chat-side.planSchritteAnfordern chat-side.planNachDiesemTurn'], 'eight silent tool calls');
    w.tab.streaming = false;
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S1"}'), null);
    assert.deepEqual(btns(), ['chat-side.planOeffnen', 'chat-side.planStandAbfragen']);
  });

  it('the quiet count crossing the threshold rebuilds the group in a running turn (planRailPatch → chatSideRefresh)', () => {
    const w = approved();
    w.tab.streaming = true;
    const g0 = w.refresh();
    w.call('planNoteTools', w.tab, w.fn('PLAN_QUIET_TOOLS'));
    const g1 = w.ids['#chatSideSlot'].querySelector('.cside-plan');
    assert.notEqual(g1, g0, 'rebuilt, not patched');
    assert.equal(g1.dataset.wants, '1');
  });
});

describe('PF-1b wiring — the user row folds the attachment (chat-render.js addMsg, live and resumed)', () => {
  function addMsgOf(w) {
    const stub = () => undefined;
    const known = Object.assign(Object.create(null), {
      chat: w.tab, ACTIVE: w.tab, $: () => new FakeEl('div'), tabUnwatched: () => false,
      el: w.ctx.el, tt: w.ctx.tt, copyBtn: () => new FakeEl('button'), iconBtn: () => new FakeEl('button'),
      planMessageSplit: w.fn('planMessageSplit'), planAttachmentEl: w.fn('planAttachmentEl'),
    });
    const env = new Proxy(known, {
      has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
      get: (t, k) => (typeof k !== 'string' ? undefined : k in t ? t[k] : stub),
    });
    return new Function('__env', 'with (__env) {\n' + liftFn(CHAT_RENDER, 'addMsg', 'chat-render.js') + '\nreturn addMsg;\n}')(env);
  }
  it('what was typed in the bubble, „📋 Plan-Fortschritt · Start mit 3 Schritten" folded below — no JSON, no protocol in the bubble', () => {
    const w = world();
    w.call('planSeen', w.tab, 'toolu_A', SAMPLE, FILE);
    const addMsg = addMsgOf(w);
    const { m, b } = addMsg('user', 'plan starten\n\n' + w.call('planStartMessage', '', w.tab.plan));
    assert.equal(b.textContent, 'plan starten');
    const d = m.querySelector('details.plan-att');
    assert.ok(d && !d.open, 'folded');
    assert.equal(d.querySelector('.plan-att-sum').textContent, '📋 chat-render.planAnhang · chat-render.planAnhangStart');
    assert.deepEqual(d.querySelectorAll('li').map((li) => li.textContent), ['S1 · Modul', 'S2 · Route', 'S3 · Tests']);
    assert.equal(d.querySelector('.plan-att-proto').textContent, 'chat-render.planAnhangProtokoll');
    // a question ([Stand abfragen] / 📋 Schritte anfordern) the same way; an ordinary message is untouched
    const q = addMsg('user', w.call('planStepsRequestMessage', 'Wo stehen wir?', w.tab.plan));
    assert.equal(q.b.textContent, 'Wo stehen wir?');
    assert.match(q.m.querySelector('.plan-att-sum').textContent, /planAnhangFrage$/);
    const plainRow = addMsg('user', 'Nur eine Frage mit ```plan-schritte im Text');
    assert.equal(plainRow.m.querySelector('details.plan-att'), null);
    assert.equal(plainRow.b.textContent, 'Nur eine Frage mit ```plan-schritte im Text');
    // the chip with nothing typed (files only): no empty bubble, the attachment alone
    const only = addMsg('user', w.call('planStartMessage', '', w.tab.plan));
    assert.ok(only.b.classList.contains('hidden'));
    // the resumed transcript paints its user rows through the same addMsg — so the fold-back looks the same
    assert.match(liftFn(SESSIONS, 'renderResumeHistory', 'sessions.js'), /if \(e\.kind === 'user' && e\.text && e\.text\.trim\(\)\) addMsg\('user', e\.text, \{ ts: e\.ts, hist: true, injected: !!e\.injected \}\);/); // 07.10.: + the „↪ eingespeist" mark
  });
});

describe('PF-1b wiring — live and resume end in the same place (the 05.10. course, synthetically)', () => {
  it('refused → „plan starten" with the chip → reports: the tab\'s plan is the plan the fold reads out of the same lines', async () => {
    const w = world();
    const ev = events(w);
    const H = composerHarness(w);
    const P = require('../public/js/plan-progress');
    const L = '# Plan: Demoprojekt — Demo\n\n## 🔬 QA-LAUF (05.10.) — AKTUELLER AUFTRAG\n### Context\nx\n### Schritt 0 — Inventar\nx\n### ➕ ERWEITERUNG\nx\n### Schritt 1–5 — Workflow\nx\n### Verifikation\nx\n## 📋 Älterer Auftrag\n### Schritt 1 — Alt\n### Schritt 2 — Alt\n';
    ev(epmFrame('toolu_M', L));
    ev(resultFrame('toolu_M', NO_PLAN_MODE));
    assert.deepEqual(plain(w.tab.plan.steps.map((s) => s.title)), ['Schritt 0 — Inventar', 'Schritt 1–5 — Workflow'], 'parser rule 0: the current order');
    await H.type('plan starten');
    const reps = [
      'Ich starte mit Schritt 0.\n' + status('{"schritte":[{"id":"S1","titel":"Inventar"},{"id":"S2","titel":"Workflow"},{"id":"S3","titel":"Abnahme"}],"aktuell":"S1"}'),
      status('{"aktuell":"S2","erledigt":["S1"],"aktiv":"Baue den Workflow"}'),
      status('{"aktuell":"S3","erledigt":["S2"]}'),
    ];
    reps.forEach((t) => ev(sayFrame(t)));
    // the same course as the CLI writes it into the transcript
    const f = P.planFoldNew();
    let n = 0;
    const line = (o) => P.planFoldLine(f, Object.assign({ uuid: 'u' + (++n), timestamp: new Date(1e12 + n * 1000).toISOString() }, o));
    line({ type: 'assistant', message: epmFrame('toolu_M', L).message });
    line({ type: 'user', message: resultFrame('toolu_M', NO_PLAN_MODE).message });
    line({ type: 'user', message: { role: 'user', content: H.posted[0] } });
    reps.forEach((t) => line({ type: 'assistant', message: sayFrame(t).message }));
    const folded = P.planFoldResult(f), live = w.call('planSave', w.tab.plan);
    for (const k of ['id', 'title', 'file', 'state', 'gate', 'src', 'steps', 'current']) assert.deepEqual(plain(live[k]), folded[k], k);
    // …and what a reloaded tab does with it: planAdopt keeps the gate, the steps, the ticks
    assert.equal(P.planSig(P.planAdopt(null, folded)), P.planSig(P.planRestore(plain(live))), 'reload and resume paint the same rail');
  });

  it('a SUBAGENT\'s list starts nothing — its frames leave handleEventBody before takePlanStatus', () => {
    const w = world();
    const ev = eventHarness(w, { laneAppendText: () => true }).handleEventBody;
    ev(Object.assign(sayFrame(status('{"schritte":["A","B"],"aktuell":"S1"}')), { parent_tool_use_id: 'toolu_agent1' }));
    assert.equal(w.tab.plan, undefined);
    ev(sayFrame(status('{"schritte":["A","B"],"aktuell":"S1"}')));
    assert.equal(w.tab.plan.state, 'active', 'the control: the same frame from the main thread is a plan');
  });
});

describe('PF-1b wiring — the resumed card and the language switch', () => {
  it('a resumed refusal is no „weiter geplant": the history card says no gate could decide it, and shows no <tool_use_error> as feedback', () => {
    const w = world();
    const card = w.call('addPlanHistoryCard', bubbleIn(w), w.tab, epmEvent('toolu_OLD').tools[0]);
    w.call('planHistoryCardResult', w.tab, card, NO_PLAN_MODE);
    assert.equal(card.dataset.outcome, 'lost');
    assert.equal(card.querySelector('.ph-state').textContent, 'chat-side.planVerlaufOhneGate');
    assert.ok(card.querySelector('.ph-reply').classList.contains('hidden'), 'the CLI\'s refusal is not the user\'s feedback');
    // an aborted gate the same way; a real „Weiter planen" keeps its feedback
    const ab = w.call('addPlanHistoryCard', bubbleIn(w), w.tab, epmEvent('toolu_AB').tools[0]);
    w.call('planHistoryCardResult', w.tab, ab, 'Tool permission request failed: AbortError: aborted (synthetisch)');
    assert.equal(ab.dataset.outcome, 'lost');
    const keep = w.call('addPlanHistoryCard', bubbleIn(w), w.tab, epmEvent('toolu_KP').tools[0]);
    w.call('planHistoryCardResult', w.tab, keep, 'Bitte den Plan noch nicht ausführen — weiter planen.\n\nErst die Route.');
    assert.equal(keep.dataset.outcome, 'no');
    assert.ok(!keep.querySelector('.ph-reply').classList.contains('hidden'));
    // the plan the rail shows: the card follows its live state — „Plan liegt vor"
    w.call('planAdoptResumed', w.tab, { v: 1, id: 'toolu_OR', title: 'T', file: '', state: 'proposed', gate: 'none', steps: [{ id: 'S1', title: 'A', status: 'pending' }] });
    const live = w.call('addPlanHistoryCard', bubbleIn(w), w.tab, epmEvent('toolu_OR').tools[0]);
    w.call('planHistoryCardResult', w.tab, live, NO_PLAN_MODE);
    assert.match(live.querySelector('.ph-state').textContent, /^chat-side\.planLiegtVor/);
  });

  it('a language switch repaints the orphaned live cards in every tab (render.js applyLang → planCardsRelabel)', () => {
    const { w } = refusedWorld();
    const card = cardOf(w, 'toolu_R');
    w.ctx.tt = (k) => 'EN:' + k;
    w.ctx.TABS = [w.tab];
    vm.runInContext(liftFn(CHAT_RENDER, 'planCardsRelabel', 'chat-render.js'), w.sb);
    w.call('planCardsRelabel');
    assert.equal(card.querySelector('.opt-group-head').textContent, '📋 EN:chat-side.planLiegtVor');
    assert.equal(card.querySelector('.opt-send').textContent, '▶ EN:chat-side.planStarten');
    assert.match(RENDER, /'planCardsRelabel', 'planHistoryCardsRelabel'\]\.forEach\(\(fn\) => call\(fn\)\)/, 'applyLang must call it — its paint guard knows no language');
  });
});

// ---- PF-1b counter-check (Gegencheck): every case below ended in two different places live and after a resume, or
// sent the model something the reader had not asked for. Each runs the real wiring and, where a transcript is
// involved, the fold over the same lines.
const PG = require('../public/js/plan-progress');
let WLN = 0;
const LN = {
  epm: (id, md) => ({ type: 'assistant', uuid: 'w' + (++WLN), message: { content: [{ type: 'tool_use', id, name: 'ExitPlanMode', input: { plan: md || SAMPLE, planFilePath: FILE } }] } }),
  res: (id, text) => ({ type: 'user', uuid: 'w' + (++WLN), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: text }] } }),
  user: (text) => ({ type: 'user', uuid: 'w' + (++WLN), message: { content: [{ type: 'text', text }] } }),
  say: (text) => ({ type: 'assistant', uuid: 'w' + (++WLN), message: { content: [{ type: 'text', text }] } }),
};
const foldAll = (lines) => { const f = PG.planFoldNew(); lines.forEach((l) => PG.planFoldLine(f, l)); return f; };
const MD_B = '# Plan B\n\n## Umsetzung\n### 1. Alpha\nx\n### 2. Beta\nx\n';
const MD_C = '# Plan C\n\n## Umsetzung\n### 1. Eins\nx\n### 2. Zwei\nx\n### 3. Drei\nx\n';
const HEAD_DE = 'Plan freigegeben — bitte jetzt umsetzen.';
const KEEP_DE = 'Bitte den Plan noch nicht ausführen — weiter planen.';

describe('PF-1b counter-check — a queued start remembers its proposal (chat-composer.js enqueueMessage / flushQueue)', () => {
  it('▶ on B while a turn runs, then the model proposes C in that turn (refused again): B\'s start never goes out, C keeps its ▶', async () => {
    const w = world();
    const ev = events(w);
    const H = composerHarness(w);
    w.tab.streaming = true;
    ev(epmFrame('toolu_B', MD_B)); ev(resultFrame('toolu_B', NO_PLAN_MODE));
    w.refresh().querySelector('.csp-btn.is-primary').onclick({ stopPropagation() {} });
    await flush();
    assert.deepEqual([w.tab.queue.length, w.tab.queue[0].planFor], [1, 'toolu_B'], 'the start remembers whom it was built for');
    await H.type('und dann die Doku'); // an ordinary entry behind it
    ev(epmFrame('toolu_C', MD_C)); ev(resultFrame('toolu_C', NO_PLAN_MODE));
    assert.equal(w.tab.plan.id, 'toolu_C');
    // C's card and the rail offer ▶ for C — the queued start is B's, „startet nach diesem Turn" would be a lie
    w.call('planCardsPaint', w.tab);
    assert.equal(cardOf(w, 'toolu_C').querySelector('.opt-send').textContent, '▶ chat-side.planStarten chat-side.planNachDiesemTurn');
    assert.equal(footBtns(w.refresh())[0], '▶ chat-side.planStarten chat-side.planNachDiesemTurn');
    assert.ok(chipOf(w), 'the chip is there for C');
    w.tab.streaming = false;
    H.flushQueue(w.tab);
    await flush();
    assert.deepEqual(H.posted, ['und dann die Doku'], 'B\'s start (with B\'s list, under C) did not go out — the next entry took its place');
    assert.deepEqual([w.tab.plan.id, w.tab.plan.state, w.tab.plan.gate], ['toolu_C', 'proposed', 'none']);
    assert.ok(w.ctx.toast.got.some((a) => a[0] === 'chat-composer.planStartVeraltet'), 'and it says so');
    // the transcript holds no start, so the fold ends where the tab does
    const f = foldAll([LN.epm('toolu_B', MD_B), LN.res('toolu_B', NO_PLAN_MODE), LN.epm('toolu_C', MD_C), LN.res('toolu_C', NO_PLAN_MODE), LN.user(H.posted[0])]);
    const r = PG.planFoldResult(f);
    assert.deepEqual([r.id, r.state, r.gate, r.steps.map((s) => s.title)], ['toolu_C', 'proposed', 'none', plain(w.tab.plan.steps.map((s) => s.title))]);
  });

  it('…C with a real gate, answered „Weiter planen": no „Plan freigegeben" reaches the model right after that keep', async () => {
    const w = world();
    const ev = events(w);
    const H = composerHarness(w);
    w.tab.streaming = true;
    ev(epmFrame('toolu_B', MD_B)); ev(resultFrame('toolu_B', NO_PLAN_MODE));
    w.refresh().querySelector('.csp-btn.is-primary').onclick({ stopPropagation() {} });
    await flush();
    ev(epmFrame('toolu_C', MD_C));
    w.ctx.ASK_GATES.get('toolu_C').requestId = 'req-C';
    w.gate.resolvePlanGate(w.tab, 'req-C', false, KEEP_DE, null, 'toolu_C');
    w.ctx.ASK_GATES.delete('toolu_C');
    assert.equal(w.tab.plan.state, 'superseded');
    w.tab.streaming = false;
    H.flushQueue(w.tab);
    await flush();
    assert.deepEqual(H.posted, [], 'nothing to start any more — the queued start stays home');
    assert.equal(w.tab.queue.length, 0);
  });

  it('the chip\'s attachment on a queued message comes off when its proposal is gone — what was typed still goes out', async () => {
    const w = world();
    const ev = events(w);
    const H = composerHarness(w);
    w.tab.streaming = true;
    ev(epmFrame('toolu_B', MD_B)); ev(resultFrame('toolu_B', NO_PLAN_MODE));
    await H.type('plan starten');
    assert.deepEqual([w.tab.queue[0].planFor, w.tab.queue[0].planTyped], ['toolu_B', 'plan starten']);
    ev(epmFrame('toolu_C', MD_C)); ev(resultFrame('toolu_C', NO_PLAN_MODE));
    w.tab.streaming = false;
    H.flushQueue(w.tab);
    await flush();
    assert.deepEqual(H.posted, ['plan starten']);
    assert.equal(w.tab.plan.state, 'proposed', 'C stays on the table — its ▶, its chip');
    assert.ok(w.ctx.toast.got.some((a) => a[0] === 'chat-composer.planAnhangVeraltet'));
    // the control: nothing new proposed → the queued start goes out and starts B
    const v = world(); const evv = events(v); const HV = composerHarness(v);
    v.tab.streaming = true;
    evv(epmFrame('toolu_B', MD_B)); evv(resultFrame('toolu_B', NO_PLAN_MODE));
    await HV.type('plan starten');
    v.tab.streaming = false;
    HV.flushQueue(v.tab);
    await flush();
    assert.equal(PG.planOutgoingKind(HV.posted[0]), 'start');
    assert.deepEqual([v.tab.plan.id, v.tab.plan.state], ['toolu_B', 'active']);
  });

  it('a start or a keep that is typed, pasted back or re-sent is a plan message too: standalone in the queue, never merged', async () => {
    const { w } = refusedWorld();
    const H = composerHarness(w);
    w.tab.streaming = true;
    const typeOff = async (t) => { w.tab._planChipOff = true; await H.type(t); }; // the chip is back on after every send
    await typeOff('erste Bitte');
    await typeOff(KEEP_DE + '\n\nErst die Route.');
    await typeOff('zweite Bitte');
    assert.deepEqual(w.tab.queue.map((it) => !!it.plan), [false, true, false]);
    const merged = w.call('queueMerge', w.tab.queue, { head: 'H' });
    assert.equal(merged.length, 3, 'the keep stays where it is — merged into „1. … 2. Bitte den Plan …" it kept nothing');
    assert.equal(merged[1].text, KEEP_DE + '\n\nErst die Route.');
    assert.equal(w.call('queueTakeLeadingText', [w.tab.queue[1]]).take.length, 0, 'and it never rides along with a card answer');
    // „erneut senden" of a start (sendMessage with an explicit text, no planMsg) is one as well
    await H.sendMessage({ text: w.call('planStartMessage', HEAD_DE, w.tab.plan), tab: w.tab });
    assert.equal(w.tab.queue[3].plan, true);
    assert.equal(w.tab.queue[3].planFor, 'toolu_R');
  });
});

describe('PF-1b counter-check — the orphan under a plan underway after a reload, a resume, a fork', () => {
  it('the fold sends it along (planOrphan), the tab adopts it, its history card offers ▶ — and the start ends where the fold ends', async () => {
    // live: A approved, B refused outside plan mode under it → B's card offers ▶
    const w = approved();
    await flush();
    const ev = events(w);
    ev(epmFrame('toolu_B', MD_B)); ev(resultFrame('toolu_B', NO_PLAN_MODE));
    assert.equal(w.tab._planOrphan.id, 'toolu_B');
    const lines = [LN.epm('toolu_A'), LN.res('toolu_A', w.posted[0].message), LN.epm('toolu_B', MD_B), LN.res('toolu_B', NO_PLAN_MODE)];
    const f = foldAll(lines);
    // what /api/transcript sends (JSON on the wire)
    const r = JSON.parse(JSON.stringify({ plan: PG.planFoldResult(f), planOrphan: PG.planFoldOrphan(f), planLast: PG.planFoldLast(f) }));
    // a reloaded page: a new tab, the resume adopts what the server folded
    const t = world();
    const H = composerHarness(t);
    t.call('planAdoptResumed', t.tab, r.plan, { orphan: r.planOrphan, last: r.planLast });
    assert.deepEqual([t.tab.plan.id, t.tab.plan.state, t.tab._planOrphan.id, t.tab._planOrphan.gate], ['toolu_A', 'active', 'toolu_B', 'none']);
    assert.equal(t.call('planStartTarget', t.tab).id, 'toolu_B', 'a start begins B — as live');
    const card = t.call('addPlanHistoryCard', bubbleIn(t), t.tab, { name: 'ExitPlanMode', id: 'toolu_B', plan: { title: 'Plan B', file: FILE, chars: MD_B.length, preview: MD_B } });
    t.call('planHistoryCardResult', t.tab, card, NO_PLAN_MODE);
    assert.ok(card.classList.contains('is-orphan'));
    assert.equal(card.querySelector('.opt-group-head').textContent, '📋 chat-side.planLiegtVor');
    assert.equal(card.querySelector('.plan-why').textContent, 'chat-render.planOhneGateNichtPlanmodus');
    assert.deepEqual(card.querySelector('.opt-actions').children.map((b) => b.textContent), ['▶ chat-side.planStarten', '✎ chat-perms.weiterPlanen']);
    assert.ok(card.querySelector('.ph-reply').classList.contains('hidden'));
    // the card of the plan underway stays a plain record
    const cardA = t.call('addPlanHistoryCard', bubbleIn(t), t.tab, epmEvent('toolu_A').tools[0]);
    assert.ok(!cardA.classList.contains('is-orphan'));
    // a report on A repaints every card (planChanged) — the orphan's head stays „Plan liegt vor", its ▶ stays
    t.call('takePlanStatus', t.tab, status('{"aktuell":"S2","erledigt":["S1"]}'), null);
    assert.equal(card.querySelector('.opt-group-head').textContent, '📋 chat-side.planLiegtVor');
    assert.equal(card.querySelector('.opt-send').textContent, '▶ chat-side.planStarten');
    // ▶ on the resumed card: B is underway with B's steps, A goes into the history — as the fold reads the same start
    card.querySelector('.opt-send').onclick();
    await flush();
    assert.equal(PG.planOutgoingKind(H.posted[0]), 'start');
    const folded = PG.planFoldResult(foldAll(lines.concat([LN.user(H.posted[0])])));
    for (const k of ['id', 'state', 'steps']) assert.deepEqual(plain(t.call('planSave', t.tab.plan)[k]), folded[k], k);
    assert.deepEqual(plain(t.tab.plan.history.map((h) => [h.id, h.state])), [['toolu_A', 'replaced']]);
    assert.equal(card.querySelector('.opt-done').textContent, '→ ▶ chat-render.planGestartet');
    // an older server (no planOrphan at all) keeps what the tab has; a fold without one clears it
    const u = world();
    u.call('planOrphanSet', u.tab, PG.planAdoptOrphan(null, r.planOrphan));
    u.call('planAdoptResumed', u.tab, r.plan, { orphan: undefined, last: undefined });
    assert.equal(u.tab._planOrphan.id, 'toolu_B');
    u.call('planAdoptResumed', u.tab, r.plan, { orphan: null });
    assert.equal(u.tab._planOrphan, null);
  });

  it('the dead-chat heal inside a start: the resume brings the orphan back, and the start applied again begins B — as the fold will', async () => {
    const w = approved();
    await flush();
    const ev = events(w);
    ev(epmFrame('toolu_B', MD_B)); ev(resultFrame('toolu_B', NO_PLAN_MODE));
    const lines = [LN.epm('toolu_A'), LN.res('toolu_A', w.posted[0].message), LN.epm('toolu_B', MD_B), LN.res('toolu_B', NO_PLAN_MODE)];
    let calls = 0;
    const H = composerHarness(w, { env: {
      // the first POST finds the chat reaped; the heal resumes and posts again
      api: (url, req) => { calls++; if (calls === 1) return Promise.reject(new Error('chat not found')); H.posted.push(JSON.parse(req.body).text); return Promise.resolve({}); },
      // what restartResume does to the plan slots: startChat's resume branch, then renderResumeHistory's adoption of the
      // fold — of a transcript that does not hold this message yet
      restartResume: async (tab) => {
        const f = foldAll(lines);
        const r = JSON.parse(JSON.stringify({ plan: PG.planFoldResult(f), planOrphan: PG.planFoldOrphan(f), planLast: PG.planFoldLast(f) }));
        const keep = tab._planOrphan; tab.planCandidates = {}; tab._planOrphan = null; if (keep) w.call('planOrphanSet', tab, keep);
        w.call('planAdoptResumed', tab, r.plan, { orphan: r.planOrphan, last: r.planLast });
      },
    } });
    cardOf(w, 'toolu_B').querySelector('.opt-send').onclick();
    await flush(); await flush(); await flush();
    assert.equal(H.posted.length, 1, 'delivered once, after the heal');
    const folded = PG.planFoldResult(foldAll(lines.concat([LN.user(H.posted[0])])));
    for (const k of ['id', 'state', 'steps']) assert.deepEqual(plain(w.call('planSave', w.tab.plan)[k]), folded[k], k);
    assert.equal(w.tab.plan.id, 'toolu_B', 'it used to stay A live (no orphan after the resume) and become B in the fold');
    assert.deepEqual(plain(w.tab.plan.history.map((h) => [h.id, h.state])), [['toolu_A', 'replaced']]);
  });

  it('cc_tabs, the fork and startChat carry it: saved and restored by the same rules, a fork gets a copy, a resume keeps it', () => {
    const persist = liftFn(CHAT, 'persistTabs', 'chat.js'), restore = liftFn(CHAT, 'restoreTabs', 'chat.js'), fork = liftFn(CHAT, 'forkTab', 'chat.js');
    assert.match(persist, /planOrphan: \(t\._planOrphan && typeof planSave === 'function'\) \? \(planSave\(t\._planOrphan\) \|\| undefined\) : undefined,/);
    assert.match(persist, /planLast: t\._planLast \|\| undefined/);
    assert.match(restore, /planOrphanSet\(t, planAdoptOrphan\(null, info\.planOrphan\)\)/);
    assert.match(restore, /t\._planLast = planLastRestore\(info\.planLast\)/);
    assert.match(fork, /nt\._planOrphan = planAdoptOrphan\(null, planSave\(t\._planOrphan\)\)/, 'a COPY, like the plan');
    assert.match(fork, /nt\._planLast = planLastRestore\(t\._planLast\)/);
    // the fork's copy goes through startChat's resume branch (fork passes `resume`), which keeps it registered
    const w = approved();
    const ev = events(w);
    ev(epmFrame('toolu_B', MD_B)); ev(resultFrame('toolu_B', NO_PLAN_MODE));
    const copy = w.call('planAdoptOrphan', null, w.call('planSave', w.tab._planOrphan));
    assert.notEqual(copy, w.tab._planOrphan);
    assert.deepEqual([copy.id, copy.state, copy.gate], ['toolu_B', 'proposed', 'none']);
  });
});

describe('PF-1b counter-check — Stop, a parked decision, the switch off, a dismissal, a name: live and resume in the same place', () => {
  const STOP = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
  it('⏹ on a waiting plan card: live the card is orphaned (interruptTab → retirePlanCards), and so is the fold of what the CLI writes', () => {
    const w = world();
    const card = proposeWithCard(w, 'toolu_S');
    w.ctx.ASK_GATES.get('toolu_S').requestId = 'req-S';
    w.call('retirePlanCards', w.tab);
    assert.ok(card.classList.contains('is-orphan'));
    const f = foldAll([LN.epm('toolu_S'), LN.res('toolu_S', STOP), LN.user('[Request interrupted by user for tool use]')]);
    const r = PG.planFoldResult(f);
    for (const k of ['id', 'state', 'gate', 'steps']) assert.deepEqual(plain(w.call('planSave', w.tab.plan)[k]), r[k], k);
    assert.match(liftFn(CHAT, 'interruptTab', 'chat.js'), /retirePlanCards\(t\);[\s\S]*clearAsksForTab\(t\)/, 'the Stop retires the cards first');
  });

  it('a decision parked on the card (no gate yet): no ▶, no chip, nothing attached — the parked click decides when the gate comes', async () => {
    for (const beh of ['allow', 'deny']) {
      const w = world();
      const H = composerHarness(w);
      const card = proposeWithCard(w, 'toolu_S');
      // finalizePlan's no-gate branch, field by field (chat-render.js): the card is done, the decision stashed
      card._done = true;
      w.ctx.ASK_GATES.set('toolu_S', Object.assign(w.ctx.ASK_GATES.get('toolu_S'), { answeredFallback: true, pendingBehavior: beh, pendingMessage: beh === 'deny' ? KEEP_DE : null, pendingSettle: null, isPlan: true }));
      assert.equal(w.call('planOpenGate', w.tab, 'toolu_S'), true, beh);
      assert.equal(w.call('planStartable', w.tab, w.tab.plan), false);
      w.call('renderPlanChip');
      assert.equal(chipOf(w), null, 'no chip while a parked decision waits for its gate');
      assert.equal(w.call('planChipAttachment', w.tab, 'irgendwas'), '');
      assert.ok(!footBtns(w.refresh()).some((b) => b.startsWith('▶')), 'no ▶ in the rail');
      await H.type('irgendwas');
      assert.equal(H.posted[0], 'irgendwas', 'a message typed in that window carries no start');
      // the turn ends before the gate came: orphaned either way, the card says the decision got lost
      w.call('clearAsksForTab', w.tab);
      assert.deepEqual([w.tab.plan.state, w.tab.plan.gate, card.dataset.orphan], ['proposed', 'none', 'lost'], beh);
      assert.equal(w.call('planStartable', w.tab, w.tab.plan), true, 'and now ▶ is offered');
    }
    // …and when the CLI says so itself (an aborted permission request while a decision was parked): the same — the
    // card says the DECISION got lost, not that the turn ended without one
    const w = world();
    const ev = events(w);
    ev(epmFrame('toolu_P'));
    const card = cardOf(w, 'toolu_P');
    card._done = true;
    w.ctx.ASK_GATES.set('toolu_P', Object.assign(w.ctx.ASK_GATES.get('toolu_P'), { answeredFallback: true, pendingBehavior: 'allow', pendingSettle: null }));
    ev(resultFrame('toolu_P', 'Tool permission request failed: AbortError: aborted (synthetisch)'));
    assert.deepEqual([w.tab.plan.gate, card.dataset.orphan, card.querySelector('.plan-why').textContent], ['none', 'lost', 'chat-render.planOhneGateEntscheidungVerloren']);
  });

  it('▶ with the switch off sends the head alone — an untracked start: no plan, live and in the fold; switched on again, no ▶', async () => {
    const w = world();
    const ev = events(w);
    const H = composerHarness(w);
    ev(epmFrame('toolu_O')); ev(resultFrame('toolu_O', NO_PLAN_MODE));
    w.ctx.STATE.prefs.planProgress = false;
    w.ctx.tt = (k) => (k === 'chat-side.planStartKopf' ? HEAD_DE : String(k)); // the real head — the rule reads it
    const card = cardOf(w, 'toolu_O');
    card.dataset.paint = ''; w.call('planCardPaint', w.tab, card); // the switch changed what the card offers: the plain start
    assert.equal(card.dataset.state, 'plain');
    card.querySelector('.opt-send').onclick();
    await flush();
    assert.equal(H.posted[0], HEAD_DE);
    assert.equal(w.tab.plan, null, 'the model works on it untracked — no plan, as through a gate without the block');
    assert.equal(card.querySelector('.opt-done').textContent, '→ ▶ chat-render.planGestartet');
    const r = PG.planFoldResult(foldAll([LN.epm('toolu_O'), LN.res('toolu_O', NO_PLAN_MODE), LN.user(HEAD_DE)]));
    assert.equal(r, null, 'the fold reads the same: it used to keep the orphan, and a reload offered ▶ for a running plan');
    w.ctx.STATE.prefs.planProgress = true;
    w.call('planAdoptResumed', w.tab, r, {});
    assert.equal(w.refresh(), null);
  });

  it('× on a plan underway, then the model reports another plan on its own: the report stays with it, hidden — and so after the resume', () => {
    const w = approved();
    w.refresh().querySelector('.csp-x').onclick({ stopPropagation() {} });
    assert.equal(w.tab.plan.state, 'dismissed');
    const rep = status('{"titel":"Neues Vorhaben","schritte":[{"id":"S1","titel":"Alpha"},{"id":"S2","titel":"Beta"},{"id":"S3","titel":"Gamma"}],"aktuell":"S1"}');
    w.call('takePlanStatus', w.tab, rep, null);
    assert.deepEqual([w.tab.plan.id, w.tab.plan.state], ['toolu_A', 'dismissed'], 'it used to start a new plan live');
    assert.equal(w.refresh(), null, 'still put away');
    const r = PG.planFoldResult(foldAll([LN.epm('toolu_A'), LN.res('toolu_A', w.posted[0].message), LN.say(rep)]));
    const resumed = w.call('planAdopt', w.tab.plan, r);
    assert.deepEqual([resumed.id, resumed.state], ['toolu_A', 'dismissed'], 'the resume keeps it put away — before, it came back with the new list');
    assert.deepEqual(plain(resumed.steps.map((s) => s.title)), plain(w.tab.plan.steps.map((s) => s.title)));
  });

  it('after a reload a plan the model reports without "titel" gets the name the fold gives it — the newest proposal\'s, with its file', () => {
    const lines = [LN.epm('toolu_X', '# Demoprojekt QA\n'), LN.res('toolu_X', KEEP_DE)];
    const f = foldAll(lines);
    const r = JSON.parse(JSON.stringify({ plan: PG.planFoldResult(f), planOrphan: PG.planFoldOrphan(f), planLast: PG.planFoldLast(f) }));
    const w = world();
    w.call('planAdoptResumed', w.tab, r.plan, { orphan: r.planOrphan, last: r.planLast });
    const rep = 'Los.\n' + status('{"schritte":[{"id":"S1","titel":"Eins"},{"id":"S2","titel":"Zwei"}],"aktuell":"S1"}');
    w.call('takePlanStatus', w.tab, rep, null);
    const folded = PG.planFoldResult(foldAll(lines.concat([LN.say(rep)])));
    for (const k of ['id', 'title', 'file', 'state']) assert.equal(w.tab.plan[k], folded[k], k);
    assert.deepEqual([w.tab.plan.title, w.tab.plan.file], ['Demoprojekt QA', FILE], 'it used to be "" and "" until the next resume');
  });

  it('a block quoted in a typed message starts nothing — the chip attaches the plan\'s OWN list after it, and that is the one started', async () => {
    const { w } = refusedWorld();
    const H = composerHarness(w);
    const quoted = 'So sah das im anderen Tab aus:\n\n```plan-schritte\n[{"id":"S1","titel":"Fremd A"},{"id":"S2","titel":"Fremd B"}]\n```\n\nWas meinst du?';
    await H.type(quoted);
    assert.ok(H.posted[0].startsWith(quoted + '\n\n```plan-schritte'), 'the chip still attached its block');
    assert.deepEqual(plain(w.tab.plan.steps.map((s) => s.title)), ['Modul', 'Route', 'Tests'], 'not the quoted list');
    // under a plan underway with an orphan beneath it, the same quote (no chip there) changes nothing
    const a = approved();
    const ev = events(a);
    const HA = composerHarness(a);
    ev(epmFrame('toolu_B', MD_B)); ev(resultFrame('toolu_B', NO_PLAN_MODE));
    await HA.type(quoted);
    assert.deepEqual([a.tab.plan.id, a.tab.plan.state, a.tab._planOrphan.id], ['toolu_A', 'active', 'toolu_B']);
  });
});

// ---- PF-2: the model's own tasks at the step they name, the rest in the strip --------------------------------
// Julian, 05.10. (Rail-Sitzung): „Aufgaben mit S<n> am Schritt, übrige in der Leiste." Both readers live in this world
// as shipped — the plan group (chat-side.js, whole) and #chatTodos (chat-render.js renderTodoStrip, lifted) — and the
// tasks arrive through the shipped pump (chat-events.js handleEventBody → trackTask* → taskRepaint). Nothing below
// calls renderTodoStrip or chatSideRefresh by hand where the browser would not: what the reader sees after a frame or
// a report is what the wiring painted on its own.
function taskEvents(w) {
  return eventHarness(w, {
    updateTodos: w.fn('updateTodos'), trackTaskCreate: w.fn('trackTaskCreate'), trackTaskCreateResult: w.fn('trackTaskCreateResult'),
    trackTaskUpdate: w.fn('trackTaskUpdate'), trackTaskUpdateResult: w.fn('trackTaskUpdateResult'),
  }).handleEventBody;
}
// a TaskCreate the way the CLI sends it: the call in an assistant frame, its answer (with the id) in a later user frame
let TASK_N = 0;
function taskCreate(ev, subject, activeForm) {
  const tu = 'toolu_tc' + (++TASK_N), id = String(TASK_N);
  ev({ type: 'assistant', message: { content: [{ type: 'tool_use', id: tu, name: 'TaskCreate', input: { subject, description: subject, activeForm: activeForm || ('Arbeite an ' + subject) } }] } });
  ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: tu, content: 'Task #' + id + ' created', is_error: false }] }, tool_use_result: { task: { id, subject } } });
  return id;
}
function taskUpdate(ev, id, status, from) {
  const tu = 'toolu_tu' + (++TASK_N);
  ev({ type: 'assistant', message: { content: [{ type: 'tool_use', id: tu, name: 'TaskUpdate', input: { taskId: id, status } }] } });
  ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: tu, content: 'Updated task #' + id, is_error: false }] },
    tool_use_result: { success: true, taskId: id, updatedFields: ['status'], statusChange: { from: from || 'pending', to: status } } });
}
const todoWrite = (ev, todos) => ev({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_tw' + (++TASK_N), name: 'TodoWrite', input: { todos } }] } });
// what each reader shows, read off the DOM it painted
const stripTexts = (w) => byClass(w.ids['#chatTodos'], 'todo-text').map((e) => e.textContent);
const stripCount = (w) => { const c = w.ids['#chatTodos'].querySelector('.ct-count'); return c ? c.textContent : ''; };
const planGroup = (w) => w.ids['#chatSideSlot'].querySelector('.cside-plan');
const railTasks = (w) => { const g = planGroup(w); return g ? byClass(g, 'csp-task').map((r) => r.querySelector('.todo-text').textContent) : []; };
const tasksAt = (w, step) => { const g = planGroup(w); const box = g && g.querySelectorAll('.csp-tasks').find((b) => b.dataset.planTasks === step); return box ? byClass(box, 'csp-task') : []; };
const stepRow = (w, step) => byClass(planGroup(w), 'csp-step').find((r) => r.dataset.planStep === step);
// the plan of the Rail-Sitzung: three steps, S1 done, S2 underway
function underway() {
  const w = approved();
  w.call('takePlanStatus', w.tab, status('{"erledigt":["S1"],"aktuell":"S2","aktiv":"Verdrahte die Route"}'), null);
  return { w, ev: taskEvents(w) };
}

describe('PF-2 wiring — „Aufgaben mit S<n> am Schritt, übrige in der Leiste" (one split, two readers)', () => {
  it('(a) Rail-Sitzung: „S2 · …" exactly once — at step 2, without its prefix —, „ohne Präfix" exactly once — in the strip', () => {
    const { w, ev } = underway();
    taskCreate(ev, 'S2 · Route verdrahten');
    taskCreate(ev, 'Ohne Präfix');
    assert.deepEqual(tasksAt(w, 'S2').map((r) => r.querySelector('.todo-text').textContent), ['Route verdrahten'],
      'the group was not repainted by the task frames, or the task is not at its step');
    assert.deepEqual(stripTexts(w), ['Ohne Präfix'], 'the strip shows only what the group does not');
    // exactly once, across both readers
    const everywhere = stripTexts(w).concat(railTasks(w));
    assert.equal(everywhere.filter((t) => t === 'Route verdrahten' || t === 'S2 · Route verdrahten').length, 1);
    assert.equal(everywhere.filter((t) => t === 'Ohne Präfix').length, 1);
    // under the step it names: the step's row, then its tasks — not inside the clickable row
    const list = stepRow(w, 'S2').parentElement;
    const at = list.children.indexOf(stepRow(w, 'S2'));
    assert.ok(list.children[at + 1].classList.contains('csp-tasks'), 'the tasks follow their step');
    assert.equal(byClass(stepRow(w, 'S2'), 'csp-task').length, 0, 'not inside the step row (role=button, a click jumps)');
  });

  it('(b) Rail-Sitzung: „S9 · …" in a plan of three steps stays in the strip — TodoWrite, the other source, by the same split', () => {
    const { w, ev } = underway();
    todoWrite(ev, [{ content: 'S9 · Gibt es nicht', status: 'pending' }, { content: 'S3 · Tests', status: 'pending' }]);
    assert.deepEqual(stripTexts(w), ['S9 · Gibt es nicht'], 'unchanged, prefix and all — it names no step');
    assert.deepEqual(railTasks(w), ['Tests']);
  });

  it('the strip counts what it shows; the group head goes on counting steps, not tasks', () => {
    const { w, ev } = underway();
    const a = taskCreate(ev, 'S2 · Eins');
    taskCreate(ev, 'S3 · Zwei');
    const c = taskCreate(ev, 'frei');
    taskUpdate(ev, a, 'completed');
    taskUpdate(ev, c, 'completed');
    assert.equal(stripCount(w), '1/1', 'one task in the strip, and it is done — not „2/3"');
    assert.equal(planGroup(w).querySelector('.cside-groupcount').textContent, '2/3', 'the step it is on, of three steps');
    assert.equal(w.ids['#chatSidePlan'].textContent, '2/3', 'the collapsed strip\'s badge as well');
  });

  it('a completed task does not tick its step off — the status stays with the plan-status protocol', () => {
    const { w, ev } = underway();
    const a = taskCreate(ev, 'S2 · Route verdrahten', 'S2 · Verdrahte die Route');
    let row = tasksAt(w, 'S2')[0];
    assert.equal(row.querySelector('.todo-mark').textContent, '☐');
    assert.equal(row.querySelector('.todo-text').textContent, 'Route verdrahten');
    taskUpdate(ev, a, 'in_progress');
    row = tasksAt(w, 'S2')[0];
    assert.equal(row.querySelector('.todo-mark').textContent, '⏳');
    assert.equal(row.querySelector('.todo-text').textContent, 'Verdrahte die Route', 'while it runs: its working form, the prefix removed there too');
    taskUpdate(ev, a, 'completed', 'in_progress');
    row = tasksAt(w, 'S2')[0];
    assert.equal(row.querySelector('.todo-mark').textContent, '✓');
    assert.ok(row.classList.contains('completed'));
    assert.equal(w.tab.plan.steps[1].status, 'in_progress', 'step 2 is still running — only a plan-status block moves it');
    assert.equal(stepRow(w, 'S2').querySelector('.todo-mark').textContent, '⏳');
    // the tooltip keeps the whole text and says that the task only shows
    assert.match(row.title, /^S2 · Route verdrahten/);
    assert.match(row.title, /chat-side\.planAufgabeNurAnzeige/);
  });

  it('the plan finishes → the strip shows every task again, the group none — without anyone repainting the strip by hand', () => {
    const { w, ev } = underway();
    taskCreate(ev, 'S2 · Route verdrahten');
    taskCreate(ev, 'Ohne Präfix');
    assert.deepEqual(stripTexts(w), ['Ohne Präfix']);
    w.call('takePlanStatus', w.tab, status('{"erledigt":["S2","S3"],"fertig":true}'), null);
    assert.deepEqual(stripTexts(w), ['S2 · Route verdrahten', 'Ohne Präfix'], 'a finished plan is no plan underway — the strip shows all');
    assert.deepEqual(railTasks(w), [], 'and the group shows none (each task once)');
    // …and a report that makes it run again takes the task back to its step
    w.call('takePlanStatus', w.tab, status('{"offen":["S3"],"aktuell":"S3"}'), null);
    assert.equal(w.tab.plan.state, 'active');
    assert.deepEqual(stripTexts(w), ['Ohne Präfix']);
    assert.deepEqual(railTasks(w), ['Route verdrahten']);
  });

  it('put away (×), or the switch off → every task in the strip — with the rail OPEN, so it is the split that moved', () => {
    // a finished agent lane keeps the rail open after the plan group is gone (railAutoAction: it is news). Without it
    // the rail emptied, folded itself, and a folded rail hands the strip every task anyway — the test then proved the
    // fold, not that the split follows the plan the rail shows (counter-check)
    const lane = () => [{ id: 'ag1', status: 'done' }];
    const { w, ev } = underway();
    w.tab.agents = lane();
    taskCreate(ev, 'S2 · Route verdrahten');
    taskCreate(ev, 'Ohne Präfix');
    planGroup(w).querySelector('.csp-x').onclick({ stopPropagation() {} });
    assert.equal(w.tab.plan.state, 'dismissed');
    assert.ok(!w.ids['#chatSide'].classList.contains('collapsed'), 'the rail is still open');
    assert.equal(planGroup(w), null, 'and shows no plan group');
    assert.deepEqual(stripTexts(w), ['S2 · Route verdrahten', 'Ohne Präfix']);
    const o = underway();
    o.w.tab.agents = lane();
    taskCreate(o.ev, 'S2 · Route verdrahten');
    assert.deepEqual(stripTexts(o.w), []);
    o.w.ctx.STATE.prefs.planProgress = false;
    o.w.call('chatSideRefresh'); // what saveGuardPrefs → renderStatusBar ends in
    assert.ok(!o.w.ids['#chatSide'].classList.contains('collapsed'), 'the rail is still open');
    assert.equal(planGroup(o.w), null, 'and shows no plan group');
    assert.equal(o.w.tab.plan.state, 'active', 'the plan itself is still underway — only the rail does not show it');
    assert.deepEqual(stripTexts(o.w), ['S2 · Route verdrahten'], 'no group to show it — the strip does');
  });

  it('a proposal (and an orphan) places nothing; approving it moves the S-tasks to their steps', () => {
    const w = world();
    const ev = taskEvents(w);
    w.call('planSeen', w.tab, 'toolu_A', SAMPLE, FILE);
    todoWrite(ev, [{ content: 'S1 · Modul anlegen', status: 'pending' }, { content: 'frei', status: 'pending' }]);
    assert.deepEqual(stripTexts(w), ['S1 · Modul anlegen', 'frei'], 'proposed — not underway');
    assert.deepEqual(railTasks(w), []);
    w.call('planOrphaned', w.tab, 'toolu_A');
    assert.ok(w.call('planIsOrphan', w.tab.plan));
    assert.deepEqual(stripTexts(w), ['S1 · Modul anlegen', 'frei'], 'orphaned — not underway either');
    w.gate.resolvePlanGate(w.tab, 'req-1', true, null, null, 'toolu_A');
    assert.equal(w.tab.plan.state, 'active');
    assert.deepEqual(stripTexts(w), ['frei'], 'approved: the strip followed the plan by itself');
    assert.deepEqual(railTasks(w), ['Modul anlegen']);
  });

  it('the rail folded (a click, or a narrow window) hides the group — then the strip shows all; opened, only the rest', () => {
    const { w, ev } = underway();
    taskCreate(ev, 'S2 · Route verdrahten');
    taskCreate(ev, 'Ohne Präfix');
    w.call('chatSideSetCollapsed', true);
    assert.deepEqual(stripTexts(w), ['S2 · Route verdrahten', 'Ohne Präfix'], 'folded rail: a task at its step would be visible nowhere');
    taskCreate(ev, 'S3 · Tests');
    assert.deepEqual(stripTexts(w), ['S2 · Route verdrahten', 'Ohne Präfix', 'S3 · Tests'], 'and a new one arrives in the strip while it is folded');
    w.call('chatSideSetCollapsed', false);
    assert.deepEqual(stripTexts(w), ['Ohne Präfix'], 'opened: back at their steps');
    assert.deepEqual(railTasks(w), ['Route verdrahten', 'Tests']);
    w.call('chatSideSetCollapsed', true, { auto: true }); // the narrow window's collapse goes the same way
    assert.equal(stripTexts(w).length, 3);
  });

  it('the group\'s signature moves with a placed task (new, status, text) and not with one in the strip — and the rail repaints itself', () => {
    const { w, ev } = underway();
    w.refresh();
    const sig = () => w.call('planRailSig', w.tab);
    const s0 = sig();
    const g0 = planGroup(w);
    taskCreate(ev, 'frei');
    assert.equal(sig(), s0, 'a task in the strip does not change the rail\'s signature…');
    assert.equal(planGroup(w), g0, '…and does not rebuild the rail (≈100 grant chips) — taskRepaint asks, it does not force');
    assert.deepEqual(stripTexts(w), ['frei']);
    const a = taskCreate(ev, 'S3 · Tests');
    assert.notEqual(sig(), s0, 'a new placed task');
    assert.notEqual(planGroup(w), g0, 'the rail was rebuilt by the task frame itself (taskRepaint → chatSideRefresh)');
    assert.deepEqual(railTasks(w), ['Tests']);
    const s1 = sig();
    taskUpdate(ev, a, 'in_progress');
    assert.notEqual(sig(), s1, 'its status');
    assert.equal(tasksAt(w, 'S3')[0].querySelector('.todo-mark').textContent, '⏳', '…and the repainted group shows it');
  });

  it('a rail repaint does not rebuild the strip while the split stands — an opened „√ N abgeschlossen" stays open', () => {
    const { w, ev } = underway();
    const a = taskCreate(ev, 'frei, erledigt');
    taskUpdate(ev, a, 'completed');
    taskCreate(ev, 'S2 · Route verdrahten');
    const strip = w.ids['#chatTodos'].children[0];
    assert.ok(strip, 'the strip is painted');
    w.call('chatSideRefresh', true);
    w.call('takePlanStatus', w.tab, status('{"aktiv":"ein neuer Satz"}'), null);
    w.call('chatSideRefresh');
    assert.equal(w.ids['#chatTodos'].children[0], strip, 'the strip was rebuilt by a repaint of the rail');
    assert.equal(w.ids['#chatTodos'].dataset.split, w.call('planStripTasks', w.tab).key, 'the box says which split it shows');
  });

  it('a background tab: its tasks wait for the switch — the active tab\'s strip and rail are not touched', () => {
    const { w } = underway();
    const other = { id: 'c2', taskList: [], agents: [], openPoints: [], hooks: [], queue: [], msgEl: rootEl() };
    w.call('trackTaskCreate', other, 'toolu_bg', { subject: 'S2 · Fremder Tab', description: 'x' });
    assert.deepEqual(stripTexts(w), []);
    assert.deepEqual(railTasks(w), []);
    assert.equal(other.taskList.length, 1);
  });

  it('texts go in as text: a task subject full of markup is shown as written, never parsed', () => {
    const { w, ev } = underway();
    taskCreate(ev, 'S2 · <img src=x onerror=alert(1)> **fett**');
    const row = tasksAt(w, 'S2')[0];
    assert.equal(row.querySelector('.todo-text').textContent, '<img src=x onerror=alert(1)> **fett**');
    assert.equal(row.querySelector('.todo-text').innerHTML, '', 'textContent, never innerHTML');
  });
});

// ---- PF-2 counter-check -----------------------------------------------------------------------------------------
// What the counter-check of PF-2 found, each in the shipped wiring (the pump, the real gate, the rail's own folds):
// a task of an EARLIER plan under a step of the next one; an open task in the shut „✓ N abgeschlossen"; the plan group
// folded shut, with its tasks out of the strip.
const PLAN_B = '# Plan: Zweiter\n\n## Schritte\n### Datenbank\nText\n### Migration\nText\n### Rollout\nText\n';
const stepTitles = (w) => plain(w.tab.plan.steps.map((s) => s.title));
describe('PF-2 counter-check — a plan change, the long plan\'s fold, the plan group folded shut', () => {
  it('plan A finishes, B is approved through the gate: A\'s ticked „S2 · …" goes to the strip — not under B/S2, which nobody touched', () => {
    const w = approved({ tick: true });
    const ev = taskEvents(w);
    w.call('takePlanStatus', w.tab, status('{"erledigt":["S1"],"aktuell":"S2"}'), null);
    const a = taskCreate(ev, 'S2 · Route verdrahten');
    taskUpdate(ev, a, 'completed');
    assert.deepEqual(railTasks(w), ['Route verdrahten'], 'under A: at its step');
    w.call('takePlanStatus', w.tab, status('{"erledigt":["S2","S3"],"fertig":true}'), null);
    w.call('planSeen', w.tab, 'toolu_B', PLAN_B, FILE);
    w.gate.resolvePlanGate(w.tab, 'req-2', true, null, null, 'toolu_B');
    assert.deepEqual([w.tab.plan.id, w.tab.plan.state], ['toolu_B', 'active']);
    assert.deepEqual(stepTitles(w), ['Datenbank', 'Migration', 'Rollout']);
    assert.deepEqual(tasksAt(w, 'S2'), [], 'B/S2 „Migration" shows no ticked task of A');
    assert.deepEqual(stripTexts(w), ['S2 · Route verdrahten'], 'A\'s task is in the strip, whole');
    // …and a task the model makes for B stands at B's step
    taskCreate(ev, 'S2 · Migration schreiben');
    assert.deepEqual(railTasks(w), ['Migration schreiben']);
    assert.deepEqual(stripTexts(w), ['S2 · Route verdrahten']);
  });

  it('…the same when B is approved OVER a plan still underway (planPromote), and when ▶ starts an orphaned B', () => {
    // over a plan underway: B waits in its card, A stays on top, then the approval replaces A
    const w = approved({ tick: true });
    const ev = taskEvents(w);
    w.call('takePlanStatus', w.tab, status('{"erledigt":["S1"],"aktuell":"S2"}'), null);
    taskCreate(ev, 'S2 · Route verdrahten');
    w.call('planSeen', w.tab, 'toolu_B', PLAN_B, FILE);
    assert.equal(w.tab.plan.id, 'toolu_A', 'A stays on top while B waits');
    assert.deepEqual(railTasks(w), ['Route verdrahten']);
    w.gate.resolvePlanGate(w.tab, 'req-2', true, null, null, 'toolu_B');
    assert.equal(w.tab.plan.id, 'toolu_B');
    assert.deepEqual(railTasks(w), []);
    assert.deepEqual(stripTexts(w), ['S2 · Route verdrahten']);
    // ▶ Plan starten on an orphan: the start goes out as a message (planStartNow → sendMessage → planNoteOutgoing)
    const o = approved({ tick: true });
    const oev = taskEvents(o);
    o.call('takePlanStatus', o.tab, status('{"erledigt":["S1"],"aktuell":"S2"}'), null);
    taskCreate(oev, 'S2 · Route verdrahten');
    o.call('takePlanStatus', o.tab, status('{"erledigt":["S2","S3"],"fertig":true}'), null);
    o.call('planSeen', o.tab, 'toolu_B', PLAN_B, FILE);
    o.call('planOrphaned', o.tab, 'toolu_B');
    assert.ok(o.call('planIsOrphan', o.tab.plan));
    assert.ok(o.call('planStartNow', o.tab, 'toolu_B'), '▶ is offered');
    const sent = o.ctx.sendMessage.got[0][0];
    o.call('planNoteOutgoing', o.tab, sent.text); // what chat-composer.js sendMessage does with it
    assert.deepEqual([o.tab.plan.id, o.tab.plan.state], ['toolu_B', 'active']);
    assert.deepEqual(railTasks(o), []);
    assert.deepEqual(stripTexts(o), ['S2 · Route verdrahten']);
  });

  it('Gegenprobe P2: B orphaned UNDER a running A, A goes on and makes a task, then ▶ B — the task stays A\'s (in the strip), not under B/S2', () => {
    // the Auto-mode course: A runs, the model proposes B, the CLI refuses it (no plan mode) → B waits as an orphan under A;
    // the user says „erst A fertig", the model makes and closes a task of A's step 2 — AFTER B came up — and only then ▶ B
    for (const finishFirst of [false, true]) {
      const w = approved({ tick: true });
      const ev = taskEvents(w), evs = events(w);
      w.call('takePlanStatus', w.tab, status('{"erledigt":["S1"],"aktuell":"S2"}'), null);
      evs(epmFrame('toolu_B', PLAN_B)); evs(resultFrame('toolu_B', NO_PLAN_MODE));
      assert.deepEqual([w.tab.plan.id, w.tab.plan.state, w.tab._planOrphan && w.tab._planOrphan.id], ['toolu_A', 'active', 'toolu_B'], 'B waits under A');
      const a = taskCreate(ev, 'S2 · Route verdrahten');
      taskUpdate(ev, a, 'completed');
      assert.deepEqual(railTasks(w), ['Route verdrahten'], 'under A: at A\'s step 2');
      // …A may also finish before ▶ (fertig after the task) — B still waited under it
      if (finishFirst) w.call('takePlanStatus', w.tab, status('{"erledigt":["S2","S3"],"fertig":true}'), null);
      assert.ok(w.call('planStartNow', w.tab), '▶ offered (' + finishFirst + ')');
      w.call('planNoteOutgoing', w.tab, w.ctx.sendMessage.got[0][0].text); // what chat-composer.js sendMessage does with it
      assert.deepEqual([w.tab.plan.id, w.tab.plan.state], ['toolu_B', 'active']);
      assert.deepEqual(stepTitles(w), ['Datenbank', 'Migration', 'Rollout']);
      assert.deepEqual(tasksAt(w, 'S2'), [], 'B/S2 „Migration" (pending) shows no ticked task of A (' + finishFirst + ')');
      assert.deepEqual(stripTexts(w), ['S2 · Route verdrahten'], 'A\'s task is in the strip, whole (' + finishFirst + ')');
      // a task the model makes for B after the start stands at B's step
      taskCreate(ev, 'S2 · Migration schreiben');
      assert.deepEqual(railTasks(w), ['Migration schreiben']);
      assert.deepEqual(stripTexts(w), ['S2 · Route verdrahten']);
    }
  });

  it('Gegenprobe P1: B\'s first TodoWrite carries A\'s ticked rows along — they stay in the strip; only its new row stands at B\'s step', () => {
    const w = approved({ tick: true });
    const ev = taskEvents(w);
    w.call('takePlanStatus', w.tab, status('{"erledigt":["S1"],"aktuell":"S2"}'), null);
    todoWrite(ev, [{ content: 'S2 · Route verdrahten', status: 'completed' }, { content: 'S3 · Tests', status: 'pending' }]);
    assert.deepEqual(railTasks(w), ['Route verdrahten', 'Tests'], 'under A: at A\'s steps');
    w.call('takePlanStatus', w.tab, status('{"erledigt":["S2","S3"],"fertig":true}'), null);
    w.call('planSeen', w.tab, 'toolu_B', PLAN_B, FILE);
    w.gate.resolvePlanGate(w.tab, 'req-2', true, null, null, 'toolu_B');
    assert.deepEqual([w.tab.plan.id, w.tab.plan.state], ['toolu_B', 'active']);
    assert.deepEqual(railTasks(w), []);
    // TodoWrite has no partial update: the model's next list re-sends A's rows (the open one now ticked) and adds B's
    todoWrite(ev, [{ content: 'S2 · Route verdrahten', status: 'completed' }, { content: 'S3 · Tests', status: 'completed' }, { content: 'S1 · Datenbank anlegen', status: 'in_progress' }]);
    assert.deepEqual(tasksAt(w, 'S2'), [], 'B/S2 „Migration" shows no ✓ Route verdrahten');
    assert.deepEqual(tasksAt(w, 'S3'), [], 'B/S3 „Rollout" shows no ✓ Tests');
    assert.deepEqual(railTasks(w), ['Datenbank anlegen'], 'the row written new for B stands at B/S1');
    assert.deepEqual(stripTexts(w).slice().sort(), ['S2 · Route verdrahten', 'S3 · Tests'], 'A\'s rows are in the strip, whole');
    assert.deepEqual(plain(w.tab.plan.steps.map((s) => s.status)), ['pending', 'pending', 'pending'], 'and no step of B is ticked by them');
  });

  it('a long plan: a finished step with a task still OPEN stays out of the shut „✓ N abgeschlossen" — a done task goes in with its step', () => {
    const md = '# Plan: Lang\n\n## Umsetzung\n' + Array.from({ length: 13 }, (_, i) => '### ' + (i + 1) + '. Schritt ' + (i + 1) + '\nText\n').join('');
    const w = world();
    const ev = taskEvents(w);
    w.call('planSeen', w.tab, 'toolu_L', md, FILE);
    w.gate.resolvePlanGate(w.tab, 'req-1', true, null, null, 'toolu_L');
    assert.equal(w.tab.plan.steps.length, 13);
    w.call('takePlanStatus', w.tab, status('{"erledigt":["S1","S2","S3","S4","S5"],"aktuell":"S6"}'), null);
    todoWrite(ev, [{ content: 'S2 · Nacharbeit offen', status: 'pending' }, { content: 'S3 · Erledigt', status: 'completed' }, { content: 'frei', status: 'pending' }]);
    assert.deepEqual(stripTexts(w), ['frei']);
    const fold = planGroup(w).querySelector('details.todo-done-toggle');
    assert.ok(fold, 'the long plan folds its finished steps');
    assert.equal(fold.open, false, 'shut by default');
    assert.equal(fold.querySelector('.todo-done-sum').textContent, '✓ 4chat-render.abgeschlossen', 'S1, S3, S4, S5 — not S2, whose task is open');
    const inFold = (step) => byClass(fold, 'csp-step').some((r) => r.dataset.planStep === step);
    assert.ok(!inFold('S2'), 'S2 stands outside the fold…');
    assert.equal(tasksAt(w, 'S2')[0].querySelector('.todo-text').textContent, 'Nacharbeit offen');
    assert.ok(!byClass(fold, 'csp-task').some((r) => r.querySelector('.todo-text').textContent === 'Nacharbeit offen'), '…with its open task, visible');
    assert.ok(inFold('S3'), 'S3 (its task done) folds away as before…');
    assert.ok(byClass(fold, 'csp-task').some((r) => r.querySelector('.todo-text').textContent === 'Erledigt'), '…and takes its task along');
    // the step is not ticked by its task, nor the task by its step
    assert.equal(stepRow(w, 'S2').querySelector('.todo-mark').textContent, '✓');
    assert.equal(tasksAt(w, 'S2')[0].querySelector('.todo-mark').textContent, '☐');
    // the task done → S2 folds away too
    todoWrite(ev, [{ content: 'S2 · Nacharbeit offen', status: 'completed' }, { content: 'S3 · Erledigt', status: 'completed' }, { content: 'frei', status: 'pending' }]);
    assert.equal(planGroup(w).querySelector('details.todo-done-toggle').querySelector('.todo-done-sum').textContent, '✓ 5chat-render.abgeschlossen');
  });

  it('the plan group folded shut (remembered for every tab and plan) → the strip shows every task; opened → only the rest', () => {
    const { w, ev } = underway();
    taskCreate(ev, 'S2 · Route verdrahten');
    taskCreate(ev, 'Ohne Präfix');
    assert.deepEqual(stripTexts(w), ['Ohne Präfix']);
    // the reader shuts the group — the browser sets `open` and fires `toggle`
    const g = planGroup(w);
    g.open = false; g.ontoggle();
    assert.equal(JSON.parse(w.ctx.localStorage.getItem('cc_chat_layout')).fold_plan, true, 'remembered (chatSideGroup)');
    assert.ok(!w.ids['#chatSide'].classList.contains('collapsed'), 'the rail itself is open');
    assert.deepEqual(stripTexts(w), ['S2 · Route verdrahten', 'Ohne Präfix'], 'the group\'s steps are out of sight — the strip shows its task');
    // a rebuilt rail keeps the group shut, and the strip keeps every task — also one that arrives now
    taskCreate(ev, 'S3 · Tests');
    assert.equal(planGroup(w).open, false);
    assert.deepEqual(stripTexts(w), ['S2 · Route verdrahten', 'Ohne Präfix', 'S3 · Tests']);
    // opened again: back at their steps
    const g2 = planGroup(w);
    g2.open = true; g2.ontoggle();
    assert.deepEqual(stripTexts(w), ['Ohne Präfix']);
    assert.deepEqual(railTasks(w), ['Route verdrahten', 'Tests']);
    // the remembered fold holds for the next plan (a reload, another tab): the strip shows all from the start
    const o = underway();
    o.w.call('chatLayoutSet', { fold_plan: true });
    taskCreate(o.ev, 'S2 · Route verdrahten');
    assert.deepEqual(stripTexts(o.w), ['S2 · Route verdrahten']);
  });
});

// ---- S — the rail: ONE scrollbar, an emoji at every group, the collapsed strip as a jump bar ------------------
// Julian (07.10.): a long plan had its own scrollbar next to the body's, ⏱ „Diese Sitzung" and 🔒 „Dauerhaft" had no
// emoji, and the 40px strip said nothing about what is in the rail. Each of these three is red on the old code.
describe('S — Seitenleiste: eine Scrollleiste, Emoji an jeder Gruppe, Sprungleiste', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  // a rail with every group this world can paint: plan, hooks, this session's grants, the standing rules
  function fullRail() {
    const w = approved();
    w.tab.hooks = [{ id: 'h1', name: 'PreToolUse', event: 'PreToolUse', at: Date.now(), done: true }];
    w.ctx.grantChips = () => [new FakeEl('span')];
    w.ctx.STATE.settingsLocal = { parsed: { permissions: { allow: ['Bash(git status)', 'Read(//c/x/**)'] } } };
    w.refresh();
    return w;
  }
  const folds = (w) => w.ids['#chatSideSlot'].children.filter((g) => g.classList.contains('cside-fold'));

  it('S1 — inside the rail only .cside-body scrolls: no other .cside-* rule has overflow auto/scroll or a max-height', () => {
    const boxes = rules.filter((r) => /\.cside-/.test(r.sel) && r.sel !== '.cside-body'
      && (/overflow(-y)?\s*:\s*(auto|scroll)/.test(r.body) || /max-height\s*:/.test(r.body)));
    assert.deepEqual(boxes.map((r) => r.sel), [], 'a second scrollbar inside the rail');
    assert.ok(rules.some((r) => r.sel === '.cside-body' && /overflow\s*:\s*auto/.test(r.body)), 'the one scrollbar is still there');
  });
  it('S1 — the group heads stick at the top of the body', () => {
    const head = rules.filter((r) => r.sel === '.cside-fold > summary').map((r) => r.body).join(';');
    assert.match(head, /position\s*:\s*sticky/);
    // flush with the scrollport's edge: sticky measures from the PADDED edge, so top = minus the body's padding-top
    const bodyPad = /padding\s*:\s*(\d+)px/.exec(rules.find((r) => r.sel === '.cside-body').body)[1];
    assert.match(head, new RegExp('top\\s*:\\s*-' + bodyPad + 'px'));
    assert.match(head, /background\s*:/, 'without a background the rows show through the stuck head');
  });
  it('S1 — folding a group by its head pulls the head back into view', () => {
    const w = fullRail();
    const g = planGroup(w);
    g.open = false; g.ontoggle();
    assert.equal(g.scrolled, 1);
  });
  it('S2 — every group head has its emoji as span.cside-gico, the label no longer carries it', () => {
    const w = fullRail();
    const gs = folds(w);
    assert.deepEqual(gs.map((g) => g.dataset.key), ['plan', 'hooks', 'session', 'perm']);
    assert.deepEqual(gs.map((g) => { const i = g.querySelector('.cside-grouphead').querySelector('.cside-gico'); return i && i.textContent; }), ['📋', '🪝', '⏱', '🔒']);
    for (const g of gs) assert.doesNotMatch(g.querySelector('.cside-grouphead').children[1].textContent, /^[📋🪝⏱🔒]/u);
    assert.equal(gs[3].querySelector('.cside-groupcount').textContent, '2', 'the count stays where the tests read it');
  });
  it('S3 — the jump bar has one entry per group: emoji + count, the plan only its 📋', () => {
    const w = fullRail();
    const btns = w.ids['#chatSideJump'].children;
    assert.deepEqual(btns.map((b) => b.dataset.key), folds(w).map((g) => g.dataset.key));
    assert.deepEqual(btns.map((b) => b.textContent), ['📋', '🪝1', '⏱1', '🔒2']);
    assert.equal(btns[3].title, 'chat-side.zuGruppeSpringen');
  });
  it('S3 — a click opens the rail, opens the group, remembers it open and scrolls it to the top', () => {
    const w = fullRail();
    w.call('chatSideSetCollapsed', true);
    const perm = folds(w).find((g) => g.dataset.key === 'perm');
    assert.equal(perm.open, false, 'the standing rules start folded');
    let stopped = 0;
    w.ids['#chatSideJump'].children.find((b) => b.dataset.key === 'perm').onclick({ stopPropagation: () => { stopped++; } });
    assert.equal(stopped, 1, 'the strip’s own click (open the rail) must not run as well');
    assert.ok(!w.ids['#chatSide'].classList.contains('collapsed'), 'the rail is open');
    assert.equal(perm.open, true);
    assert.equal(JSON.parse(w.ctx.localStorage.getItem('cc_chat_layout')).fold_perm, false);
    assert.equal(perm.scrolled, 1);
  });
  it('S3 — the signature guard repaints the bar on a language switch (its titles are tt() text)', () => {
    const w = fullRail();
    w.fn('chatSideRefresh')();
    const before = w.ids['#chatSideJump'].children[0];
    w.ctx.LANG = 'en';
    w.fn('chatSideRefresh')();
    assert.notEqual(w.ids['#chatSideJump'].children[0], before);
  });
});

// 07.10. — a plan the parser found no steps in, and the model's report with `schritte` never arrived: its next report
// ({"aktuell":"S2"}) names IDs the panel does not have. „Schritte folgen" was then wrong for the rest of the plan.
describe('a plan without steps that gets reports with unknown IDs — the rail asks for the list', () => {
  const NOSTEPS = '# Plan: Ohne Liste\n\n## Kontext\nNur Prosa.\n';
  function noSteps() {
    const w = world();
    w.call('planSeen', w.tab, 'toolu_N', NOSTEPS, FILE);
    w.gate.resolvePlanGate(w.tab, 'req-1', true, null, null, 'toolu_N');
    assert.equal(w.tab.plan.steps.length, 0);
    return w;
  }
  it('before any report: „Schritte folgen", no hint', () => {
    const g = noSteps().refresh();
    assert.equal(byClass(g, 'csp-unknown').length, 0);
    assert.equal(byClass(g, 'csp-empty')[0].textContent, 'chat-side.planSchritteFolgen');
  });
  it('{"aktuell":"S2"} → the hint instead of „Schritte folgen", above a hot 📋 Schritte anfordern — repainted without a force', () => {
    const w = noSteps();
    w.refresh();
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S2","erledigt":["S1"]}'), null);
    const g = w.ids['#chatSideSlot'].querySelector('.cside-plan'); // NOT w.refresh(): takePlanStatus must repaint by itself
    assert.equal(byClass(g, 'csp-unknown')[0].textContent, 'chat-side.planSchrittePanelUnbekannt');
    assert.equal(byClass(g, 'csp-empty').length, 0);
    const ask = byClass(g, 'csp-btn').find((b) => /planSchritteAnfordern$/.test(b.textContent));
    assert.ok(ask && ask.classList.contains('is-hot'), '📋 Schritte anfordern is there, lit');
    assert.equal(w.ctx.logEvent.got.length, 1, 'the 🔔 log still says it once');
  });
});

// 07.10. (Julian) — …and the panel asks for that list ITSELF at the turn end, once per plan (chat-events.js `result` →
// chat-side.js planAutoAskSteps → the 📋 button's own planRequestSteps). Run through the real handleEventBody.
describe('a plan without steps with unknown IDs — the list is requested automatically at a clean turn end', () => {
  const OK = { type: 'result', subtype: 'success', is_error: false, result: '' };
  function unknownWorld(md) {
    const w = world();
    w.call('planSeen', w.tab, 'toolu_U', md || '# Plan: Ohne Liste\n\n## Kontext\nNur Prosa.\n', FILE);
    w.gate.resolvePlanGate(w.tab, 'req-1', true, null, null, 'toolu_U');
    w.call('takePlanStatus', w.tab, status('{"aktuell":"S2","erledigt":["S1"]}'), null);
    const ev = eventHarness(w, { el: w.ctx.el, queueAfterTurn: w.fn('queueAfterTurn'), planAutoAskSteps: w.fn('planAutoAskSteps') }).handleEventBody;
    const asks = () => w.ctx.sendMessage.got.filter((a) => a[0] && a[0].planMsg).length;
    return { w, ev, asks };
  }
  it('a successful turn end → exactly one request, logged; a second result frame → no second one', () => {
    const { w, ev, asks } = unknownWorld();
    assert.equal(asks(), 0);
    ev(OK);
    assert.equal(asks(), 1);
    assert.equal(w.tab._planAutoAsked, w.tab.plan.id, 'remembered on the tab (persistTabs saves it)');
    assert.ok(w.ctx.logEvent.got.some((a) => a[0] === 'chat-side.planSchritteAutoAngefordert'));
    ev(OK);
    assert.equal(asks(), 1, 'once per plan');
    assert.ok(byClass(w.refresh(), 'csp-unknown').length, 'the hint stays for the case the automatic request did not help');
  });
  it('no request after a cancelled or failed turn, over a held gate, or ahead of a queue', () => {
    const cut = unknownWorld();
    cut.ev({ type: 'result', subtype: 'error_during_execution', is_error: true });
    cut.ev({ type: 'result', subtype: 'success', is_error: true }); // a user Stop arrives with is_error
    assert.equal(cut.asks(), 0);
    const gated = unknownWorld();
    gated.w.ctx.hasHeldGate = () => true;
    gated.ev(OK);
    assert.equal(gated.asks(), 0);
    const queued = unknownWorld();
    queued.w.tab.queue = [{ id: 'q1', text: 'weiter' }];
    queued.ev(OK);
    assert.equal(queued.asks(), 0, 'the queue goes first');
    assert.equal(queued.w.tab._planAutoAsked, undefined, 'not used up — the next clean turn end may still ask');
  });
  it('a plan WITH steps, or one without a report of unknown IDs, is never asked for', () => {
    const steps = unknownWorld(SAMPLE);
    steps.ev(OK);
    assert.equal(steps.asks(), 0);
    const w = world();
    w.call('planSeen', w.tab, 'toolu_Q', '# Plan: Still\n\nProsa.\n', FILE);
    w.gate.resolvePlanGate(w.tab, 'req-1', true, null, null, 'toolu_Q');
    eventHarness(w, { el: w.ctx.el, queueAfterTurn: w.fn('queueAfterTurn'), planAutoAskSteps: w.fn('planAutoAskSteps') }).handleEventBody(OK);
    assert.equal(w.ctx.sendMessage.got.length, 0);
  });
});
