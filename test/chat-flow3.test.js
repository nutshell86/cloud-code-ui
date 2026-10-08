'use strict';
// CHAT-FLOW-3 — the turn the CLI starts by itself (after a background agent reports back) is adopted as a
// running turn: ⏹, the queue and the status strip work in it.
//
// Run, not re-enacted: the frames go through the SHIPPED handleEventBody (test/event-pump.js), and what reads its
// state is shipped code too, compiled into the same env — setComposerBusy / refreshInterruptBtn / hasHeldGate
// (chat-render.js), tabCanStop / withTab / interruptTab / armCliTurnStop (chat.js), sendMessage / enqueueMessage /
// renderQueueStateBtns (chat-composer.js). The predicate is the real one (turn-end.js), the queue's verdict too
// (queue-merge.js queueAfterTurn), the synthetic check is ctx.js's. Only the edges are spies: the POST paths
// (deliverText, the interrupt route), flushQueue and the DOM.
//
// The frames follow run 1 (docs/messung-2026-10-02.md) in ORDER, with subagent_stats from fake-claude's bgagent
// scenario (run 1 itself was a Workflow with spawned 0) — not a capture. The last suite takes the frames off a real
// process: fake-claude bgagent through lib/chat.js.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// before lib/chat is required: run alone, this file must not reach the paid CLI (test/real-cli-guard.test.js)
process.env.CLAUDE_UI_FAKE_BIN = path.join(__dirname, '..', 'fake-claude.js').replace(/\\/g, '/');
const { eventPump } = require('./event-pump');
const { turnOpenedByCli } = require('../public/js/turn-end');
const { queueAfterTurn } = require('../public/js/queue-merge');
const { ctxSyntheticModel } = require('../public/js/ctx');

const CHAT_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');
const STOP_MS = Number(/^const CLI_TURN_STOP_MS = (\d+);$/m.exec(CHAT_SRC)[1]); // the shipped value, not a copy

function fakeEl() {
  const cls = new Set();
  const e = { cls, disabled: false, title: '', children: [], onclick: null, type: '', textContent: '' };
  e.classList = { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle: (c, on) => { const w = on === undefined ? !cls.has(c) : !!on; if (w) cls.add(c); else cls.delete(c); return w; } };
  e.appendChild = (k) => { e.children.push(k); return k; };
  e.querySelector = () => null; e.querySelectorAll = () => [];
  return e;
}
function makeTab(id) { return { id, title: id, streaming: false, queue: [], toolCards: {}, agents: [], msgEl: fakeEl() }; }

// tab = the one the frames belong to; opts.active = the visible tab (default: the same one)
function harness(tab, opts) {
  opts = opts || {};
  const els = {}, asked = [];
  const calls = { deliver: [], interrupt: [], flush: [], notes: [], api: [], timers: [] };
  const env = {
    ACTIVE: opts.active || tab, ASK_GATES: new Map(), PHASE_WORKING: 'working', DISPLAY: { guard: false },
    turnOpenedByCli, queueAfterTurn, ctxSyntheticModel,
    $: (sel) => { asked.push(sel); return els[sel] || (els[sel] = fakeEl()); },
    tt: (k) => k,
    deliverText: async (...a) => { calls.deliver.push(a); return true; },
    flushQueue: (t) => { calls.flush.push(t); },
    addMsg: (role, text) => { calls.notes.push([role, text]); return { m: fakeEl() }; },
    typedReplyCard: () => null,
    api: async (url) => { calls.api.push(url); return {}; },
    setTimeout: (fn, ms) => { const h = { fn, ms, cleared: false }; calls.timers.push(h); return h; },
    clearTimeout: (h) => { if (h) h.cleared = true; },
    el: (tag, cls, txt) => { const e = fakeEl(); e.tagName = tag; e.className = cls; e.textContent = txt || ''; return e; },
    CLI_TURN_STOP_MS: STOP_MS,
  };
  if (opts.spyInterrupt) env.interruptTab = (t, o) => { calls.interrupt.push([t, o]); };
  const pump = eventPump(tab, {
    lift: ['setComposerBusy', 'refreshInterruptBtn', 'hasHeldGate'],
    liftFrom: {
      'chat.js': ['tabCanStop', 'withTab'].concat(opts.spyInterrupt ? [] : ['interruptTab', 'armCliTurnStop']),
      'chat-composer.js': ['sendMessage', 'enqueueMessage', 'renderQueueStateBtns'],
    },
    env,
  });
  return { pump, calls, els, asked, stopHidden: () => els['#interruptBtn'] && els['#interruptBtn'].cls.has('hidden') };
}

const STATS = (completed) => ({ spawned: 1, started_in_background: 1, completed, failed: 0, killed: { parent: 0, user: 0, system: 0 }, by_type: { Explore: 1 } });
const F = {
  result: (idx, completed) => ({ type: 'result', subtype: 'success', is_error: false, result_index: idx, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, subagent_stats: STATS(completed) }),
  notification: { type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'fertig' },
  init: { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5', tools: [] },
  start: { type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-sonnet-5', usage: { input_tokens: 3 } } } },
  blockStart: { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  delta: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Der Agent ist fertig.' } } },
  stop: { type: 'stream_event', event: { type: 'message_stop' } },
  msgDelta: { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } } },
  assistant: (model, extra) => Object.assign({ type: 'assistant', message: { model: model || 'claude-sonnet-5', content: [{ type: 'text', text: 'Der Agent ist fertig.' }] } }, extra),
  idle: { type: 'system', subtype: 'session_state_changed', state: 'idle' },
};
// a user's turn is open (the panel sent it), then its first result lands while the agent still works
function afterFirstResult(h, tab) {
  h.pump.fn.withTab(tab, () => h.pump.fn.setComposerBusy(true));
  h.pump.feed(F.result(0, 0));
  h.pump.feed(F.notification);
  h.pump.feed(F.init);
}

describe('CHAT-FLOW-3 — the follow-up turn the CLI starts by itself is a running turn', () => {
  it('T1: adopted at message_start — ⏹ shows, the strip runs; its own result ends it and the mark', () => {
    const tab = makeTab('c1'); const h = harness(tab, { spyInterrupt: true });
    afterFirstResult(h, tab);
    assert.equal(tab.streaming, false, 'the first result ends the turn the panel sent (as before)');
    assert.equal(h.stopHidden(), true);
    h.pump.feed(F.start);
    assert.equal(tab.streaming, true, 'the follow-up turn was not adopted — the panel reads idle while the CLI works');
    assert.equal(h.pump.fn.tabCanStop(tab), true, 'Stop (⏹, tab menu, Esc-Esc) has nothing to stop');
    assert.equal(h.stopHidden(), false, '⏹ stays hidden in the follow-up turn');
    assert.equal(tab._cliTurn, true);
    assert.ok(tab.turnStart > 0 && tab.phase, 'the status strip gets a start time and a phase');
    const t0 = tab.turnStart;
    h.pump.feed(F.blockStart); h.pump.feed(F.delta); h.pump.feed(F.stop); h.pump.feed(F.assistant());
    assert.equal(tab.turnStart, t0, 'a later frame of the same turn must not restart it');
    h.pump.feed(F.result(1, 1));
    assert.equal(tab.streaming, false, 'its own result must end the adopted turn');
    assert.equal(h.stopHidden(), true);
    assert.equal(tab._cliTurn, false, 'the end of a turn must clear the adoption mark');
    h.pump.feed(F.idle);
    assert.equal(tab.streaming, false, '`idle` opens nothing');
  });

  it('T2: a message typed in the follow-up turn is queued, not sent — and goes out at its result', async () => {
    const tab = makeTab('c1'); const h = harness(tab, { spyInterrupt: true });
    afterFirstResult(h, tab); h.pump.feed(F.start);
    await h.pump.fn.sendMessage({ text: 'noch was', tab });
    assert.equal(h.calls.deliver.length, 0, 'the message went straight to stdin, past the queue');
    assert.equal(tab.queue.length, 1, 'the real enqueueMessage put it in the queue');
    assert.equal(h.calls.interrupt.length, 0, 'a plain send must not stop anything');
    h.pump.feed(F.assistant()); h.pump.feed(F.result(1, 1));
    assert.deepEqual(h.calls.flush, [tab], 'the result of the follow-up turn flushes the queue (queueAfterTurn)');
  });

  it('T3: Strg+Enter in the follow-up turn queues and stops (keepQueue)', async () => {
    const tab = makeTab('c1'); const h = harness(tab, { spyInterrupt: true });
    afterFirstResult(h, tab); h.pump.feed(F.start);
    await h.pump.fn.sendMessage({ text: 'stattdessen das', tab, interrupt: true });
    assert.equal(h.calls.deliver.length, 0);
    assert.equal(tab.queue.length, 1);
    assert.deepEqual(h.calls.interrupt.map(([t, o]) => [t === tab, o]), [[true, { keepQueue: true }]]);
  });

  it('T7: [Jetzt senden] of a paused queue stops the adopted turn instead of doing nothing', () => {
    const tab = makeTab('c1'); const h = harness(tab, { spyInterrupt: true });
    afterFirstResult(h, tab);
    tab.queue.push({ text: 'wartet', attachments: [] }); tab.queuePaused = true; // result#0 paused it: Claude asked (CHAT-FLOW-7)
    h.pump.feed(F.start);
    const box = fakeEl(); h.pump.fn.renderQueueStateBtns(box, tab);
    const btn = box.children.find((k) => k.tagName === 'button');
    assert.ok(btn, 'the paused queue shows [Jetzt senden]');
    assert.equal(btn.title, 'chat-composer.jetztSendenTitelLaufend', 'the title must say that it stops the running turn');
    btn.onclick();
    assert.deepEqual(h.calls.interrupt.map(([t, o]) => [t === tab, o]), [[true, { keepQueue: true }]], 'the button returned silently in a running turn');
    assert.equal(h.calls.flush.length, 0, 'not sent INTO the running turn');
  });

  it('T8: a background tab adopts its own turn without touching the visible tab', () => {
    const bg = makeTab('bg'), fg = makeTab('fg'); const h = harness(bg, { active: fg, spyInterrupt: true });
    h.pump.fn.withTab(bg, () => h.pump.fn.setComposerBusy(true));
    h.pump.feed(F.result(0, 0)); h.pump.feed(F.init);
    h.asked.length = 0;
    h.pump.feed(F.start);
    assert.equal(bg.streaming, true, 'the background tab must spin too');
    assert.equal(fg.streaming, false, 'the visible tab is not the one that streams');
    assert.deepEqual(h.asked.filter((s) => s === '#interruptBtn' || s === '#sendBtn'), [], 'the visible tab\'s ⏹/send must not be repainted for a background frame');
  });
});

describe('CHAT-FLOW-3 — what must NOT open a turn', () => {
  const idleAfter = (frames) => {
    const tab = makeTab('c1'); const h = harness(tab, { spyInterrupt: true });
    afterFirstResult(h, tab);
    for (const f of frames) h.pump.feed(f);
    return { tab, h };
  };
  it('T4a: a sub-agent frame (parent_tool_use_id / parentToolUseId)', () => {
    const { tab } = idleAfter([F.assistant('claude-sonnet-5', { parent_tool_use_id: 'toolu_a' }), Object.assign({}, F.start, { parentToolUseId: 'toolu_a' })]);
    assert.equal(tab.streaming, false);
  });
  it('T4b: an assistant frame the CLI composed itself (<synthetic>)', () => {
    const { tab } = idleAfter([F.assistant('<synthetic>')]);
    assert.equal(tab.streaming, false);
  });
  it('T4c: a frame that arrives after the process exited', () => {
    const tab = makeTab('c1'); const h = harness(tab, { spyInterrupt: true });
    afterFirstResult(h, tab);
    tab._exited = true; // what endTabProcess leaves behind (chat-render.js setComposerBusy reads it)
    h.pump.feed(F.assistant());
    assert.equal(tab.streaming, false, 'a dead tab came back to life');
    assert.equal(tab._exited, true);
  });
  it('T4d: a frame inside a turn the panel sent does not restart it', () => {
    const tab = makeTab('c1'); const h = harness(tab, { spyInterrupt: true });
    h.pump.fn.withTab(tab, () => h.pump.fn.setComposerBusy(true));
    tab.turnStart = 1; tab.tokenBase = 5;
    h.pump.feed(F.start); h.pump.feed(F.assistant());
    assert.equal(tab.turnStart, 1); assert.equal(tab.tokenBase, 5);
    assert.equal(tab._cliTurn, undefined, 'a turn the panel sent is not an adopted one');
  });
  it('T4e: a straggling message_delta / message_stop after a result', () => {
    const { tab } = idleAfter([F.msgDelta, F.stop, F.delta]);
    assert.equal(tab.streaming, false, 'a straggler opened a turn no result will close');
  });
});

describe('CHAT-FLOW-3 — Stop in an adopted turn that never ends', () => {
  const adopted = () => {
    const tab = makeTab('c1'); const h = harness(tab);
    afterFirstResult(h, tab); h.pump.feed(F.start);
    return { tab, h, stopTimers: () => h.calls.timers.filter((x) => x.ms === STOP_MS) };
  };
  it('T9a: no result within CLI_TURN_STOP_MS → the turn ends locally, said honestly, the Strg+Enter queue goes out', async () => {
    const { tab, h, stopTimers } = adopted();
    tab.queue.push({ text: 'danach', attachments: [] });
    await h.pump.fn.interruptTab(tab, { keepQueue: true });
    assert.ok(h.calls.api.some((u) => /\/interrupt$/.test(u)));
    assert.equal(stopTimers().length, 1, 'no watchdog armed for an adopted turn');
    assert.equal(tab.streaming, true, 'nothing ends before the watchdog');
    stopTimers()[0].fn();
    assert.equal(tab.streaming, false, 'streaming stayed true for good — every later message would be queued');
    assert.equal(h.stopHidden(), true);
    assert.deepEqual(h.calls.notes.map(([r, t]) => [r, t]), [['system', 'chat.folgeturnStoppOhneEnde']]);
    assert.deepEqual(h.calls.flush, [tab], 'what Strg+Enter queued for after the stop must go out');
  });
  it('T9b: its result arrives in time → the watchdog is cleared and does nothing', async () => {
    const { tab, h, stopTimers } = adopted();
    await h.pump.fn.interruptTab(tab);
    h.pump.feed(Object.assign(F.result(1, 0), { subtype: 'error_during_execution', is_error: true }));
    assert.equal(tab.streaming, false);
    assert.equal(stopTimers()[0].cleared, true, 'the end of the turn must clear the watchdog');
    h.pump.feed(F.start); // a NEW follow-up turn within the window must not be ended by the old watchdog
    for (const x of stopTimers()) if (!x.cleared) x.fn(); // the clock runs on: a cleared timer does not fire
    assert.equal(tab.streaming, true);
    assert.equal(h.calls.notes.length, 0);
  });
  it('T9c: a turn the panel sent gets no watchdog (its result is as good as guaranteed)', async () => {
    const tab = makeTab('c1'); const h = harness(tab);
    h.pump.fn.withTab(tab, () => h.pump.fn.setComposerBusy(true));
    await h.pump.fn.interruptTab(tab);
    assert.equal(h.calls.timers.filter((x) => x.ms === STOP_MS).length, 0);
  });
});

// The frames off a real process: fake-claude's bgagent writes the captured background-agent sequence to stdout
// — its late `assistant` (after task_notification) IS a follow-up turn without a user message — and the real
// engine relays it. CLAUDE_UI_FAKE_BIN is set at module level above.
describe('CHAT-FLOW-3 end to end — fake-claude bgagent through lib/chat.js', () => {
  it('T6: the late assistant frame opens the turn, result(1) closes it', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'bgagent';
    const { startChat, sendToChat, killChat } = require('../lib/chat');
    const tab = makeTab('c1'); const h = harness(tab, { spyInterrupt: true });
    h.pump.fn.withTab(tab, () => h.pump.fn.setComposerBusy(true)); // the user's send
    const at = [];
    const proc = startChat({ cwd: path.join(__dirname, '..'), permissionMode: 'plan' });
    try {
      await new Promise((resolve) => {
        const bail = setTimeout(resolve, 15000);
        let results = 0, notified = false;
        proc.onEvent = (ev) => {
          h.pump.feed(ev);
          if (ev.type === 'system' && ev.subtype === 'task_notification') notified = true;
          if (ev.type === 'assistant' && notified) at.push(['late assistant', tab.streaming, h.pump.fn.tabCanStop(tab)]);
          if (ev.type === 'result') { at.push(['result ' + ev.result_index, tab.streaming]); if (++results === 2) { clearTimeout(bail); resolve(); } }
        };
        sendToChat(proc, 'Dateien auflisten, im Hintergrund');
      });
    } finally { try { killChat(proc); } catch { /* */ } }
    assert.deepEqual(at, [['result 0', false], ['late assistant', true, true], ['result 1', false]]);
  });
});
