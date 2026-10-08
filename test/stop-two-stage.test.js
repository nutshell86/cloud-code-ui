'use strict';
// Stop while something runs + the two-stage Stop (Sergej, Nachtrag 07.10.). The shipped functions are lifted out
// of chat.js / chat-render.js (liftFn, test/event-pump.js) and run against a fake clock, so what is under test is
// the code the browser runs: when ⏹ stands, what press 1 does, when it escalates by itself, what press 2 does.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { liftFn } = require('./event-pump');

const PUB = path.join(__dirname, '..', 'public', 'js');
const CHAT = fs.readFileSync(path.join(PUB, 'chat.js'), 'utf8');
const RENDER = fs.readFileSync(path.join(PUB, 'chat-render.js'), 'utf8');
const constLine = (src, name) => { const m = new RegExp('^const ' + name + ' = .*;', 'm').exec(src); assert.ok(m, name + ' not found'); return m[0]; };

function harness(tab, over) {
  const calls = { interrupt: [], restart: [], stopTask: [], toasts: [], msgs: [], cleared: 0, aborted: 0, api: [] };
  let now = 1_000_000;
  const timers = [];
  const known = Object.assign(Object.create(null), {
    ACTIVE: tab, TABS: [tab], LANE_STALE_MS: 30 * 60 * 1000,
    Date: { now: () => now },
    setTimeout: (fn, ms) => { const h = { fn, at: now + ms }; timers.push(h); return h; },
    clearTimeout: (h) => { if (h) h.cancelled = true; },
    tt: (k) => k, toast: (m) => calls.toasts.push(String(m)),
    hasHeldGate: (t) => !!t._gate,
    interruptTab: async (t, o) => { calls.interrupt.push(o || {}); t._turnOpen = false; },
    restartResume: async (t, x) => { calls.restart.push(x); },
    agentStopClick: (a) => { calls.stopTask.push(a.id); },
    clearAsksForTab: () => {}, clearAskWaitersForTab: () => {}, retirePlanCards: () => {},
    clearQueue: () => { calls.cleared++; }, agentsAborted: () => { calls.aborted++; },
    withTab: (t, fn) => fn(), addMsg: (role, text) => { calls.msgs.push([role, text]); },
    setComposerBusy: (b) => { tab.streaming = b; },
    api: (url) => { calls.api.push(url); return Promise.resolve({}); },
    refreshInterruptBtn: () => {},
  }, over || {});
  const stub = () => undefined;
  const env = new Proxy(known, {
    has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
    get: (t, k) => (typeof k !== 'string' ? undefined : k in t ? t[k] : stub),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  const src = [constLine(CHAT, 'STOP_ESCALATE_MS'), constLine(CHAT, 'STOP_ARM_MS'),
    ...['tabHasLiveWork', 'tabCanStop', 'stopArmed', 'stopRunningLanes', 'stopTab', 'hardStopTab'].map((n) => liftFn(CHAT, n, 'chat.js'))].join('\n');
  const fn = new Function('__env', 'with (__env) {\n' + src + '\nreturn { tabHasLiveWork, tabCanStop, stopArmed, stopTab, hardStopTab, STOP_ESCALATE_MS };\n}')(env);
  const advance = async (ms) => {
    now += ms;
    for (const h of timers.filter((x) => !x.cancelled && !x.done && x.at <= now)) { h.done = true; await h.fn(); }
    await new Promise((r) => setImmediate(r));
  };
  return { fn, calls, advance, now: () => now, frame: () => { tab._lastFrameAt = now; tab._lastWorkAt = now; }, ack: () => { tab._lastFrameAt = now; } };
}

describe('tabCanStop — ⏹ stands while something runs', () => {
  const H = harness({}).fn;
  it('a streaming turn and a held gate, as before', () => {
    assert.equal(H.tabCanStop({ id: 'c', streaming: true }), true);
    assert.equal(H.tabCanStop({ id: 'c', _gate: true }), true);
  });
  it('NEW: a turn the CLI runs on without streaming (frames only), and running sub-agents', () => {
    assert.equal(H.tabCanStop({ id: 'c', _turnOpen: true, _lastFrameAt: 1_000_000 - 5000 }), true);
    assert.equal(H.tabCanStop({ id: 'c', agents: [{ status: 'running' }] }), true);
  });
  it('nothing running, finished agents, or a tab that never started → no ⏹', () => {
    assert.equal(H.tabCanStop({ id: 'c' }), false);
    assert.equal(H.tabCanStop({ id: 'c', agents: [{ status: 'done' }] }), false);
    assert.equal(H.tabCanStop({ agents: [{ status: 'running' }] }), false, 'no id → no process to stop');
    assert.equal(H.tabCanStop({ id: 'c', _turnOpen: true, _lastFrameAt: 1_000_000 - 31 * 60 * 1000 }), false, 'a turn silent past LANE_STALE_MS is dead');
  });
});

describe('stopTab — press 1 gentle, press 2 hard', () => {
  it('press 1 interrupts (with the hint), press 2 within the window restarts the process and keeps the session', async () => {
    const tab = { id: 'c1', sessionId: 's1', streaming: true, title: 'T' };
    const h = harness(tab);
    await h.fn.stopTab(tab);
    assert.equal(h.calls.interrupt.length, 1);
    assert.equal(h.calls.interrupt[0].stopHint, true);
    assert.equal(h.fn.stopArmed(tab), true);
    h.frame(); // the process answers — no automatic escalation
    await h.advance(1000);
    await h.fn.stopTab(tab);
    assert.equal(h.calls.interrupt.length, 1, 'press 2 does not interrupt again');
    assert.deepEqual(h.calls.restart, [{}], 'press 2 = restartResume(tab, {})');
    assert.equal(h.calls.cleared, 1);
    assert.equal(h.calls.aborted, 1, 'the agents end with the process — true here');
    assert.deepEqual(h.calls.msgs, [['system', 'chat.hartGestoppt']]);
    assert.equal(h.fn.stopArmed(tab), false, 'disarmed after the hard stop');
  });
  it('press 1 escalates by itself only when NO frame came for STOP_ESCALATE_MS and the turn is still open', async () => {
    const tab = { id: 'c1', sessionId: 's1', streaming: true, title: 'T' };
    const h = harness(tab);
    await h.fn.stopTab(tab);
    await h.advance(h.fn.STOP_ESCALATE_MS - 1);
    assert.equal(h.calls.restart.length, 0);
    await h.advance(2);
    assert.deepEqual(h.calls.restart, [{}]);
    assert.match(h.calls.msgs[0][1], /^chat\.hartGestopptAuto/);
  });
  it('the interrupt’s own control_response is no sign of life — measured: it was the only frame after ⏹', async () => {
    const tab = { id: 'c1', sessionId: 's1', streaming: true, title: 'T' };
    const h = harness(tab);
    await h.fn.stopTab(tab);
    await h.advance(10); h.ack();
    await h.advance(h.fn.STOP_ESCALATE_MS);
    assert.deepEqual(h.calls.restart, [{}]);
    const ev = fs.readFileSync(path.join(PUB, 'chat-events.js'), 'utf8');
    assert.match(ev, /if \(ev\.type !== 'control_response'\) tab\._lastWorkAt = tab\._lastFrameAt;/);
  });
  it('…not when the process answered, the turn ended, or the CLI opened the turn itself (CHAT-FLOW-3 owns that)', async () => {
    for (const setup of [
      (tab, h) => { h.frame(); },                // a frame after the press → slow, not hung
      (tab) => { tab.streaming = false; },        // its `result` came
    ]) {
      const tab = { id: 'c1', sessionId: 's1', streaming: true, title: 'T' };
      const h = harness(tab);
      await h.fn.stopTab(tab);
      await h.advance(10);
      setup(tab, h);
      await h.advance(h.fn.STOP_ESCALATE_MS + 10);
      assert.equal(h.calls.restart.length, 0);
    }
    const tab = { id: 'c1', sessionId: 's1', streaming: true, _cliTurn: true, title: 'T' };
    const h = harness(tab);
    await h.fn.stopTab(tab);
    await h.advance(h.fn.STOP_ESCALATE_MS + 10);
    assert.equal(h.calls.restart.length, 0, 'armCliTurnStop ends an adopted turn its own way');
  });
  it('the arm expires: a press long after the first is a gentle one again', async () => {
    const tab = { id: 'c1', sessionId: 's1', streaming: true, title: 'T' };
    const h = harness(tab);
    await h.fn.stopTab(tab);
    await h.advance(10); h.frame(); // the process answers after the press → no automatic escalation
    await h.advance(5 * 60 * 1000 + 1);
    await h.fn.stopTab(tab);
    assert.equal(h.calls.interrupt.length, 2);
    assert.equal(h.calls.restart.length, 0);
  });
  it('only sub-agents left: each running lane gets its own stop_task — no interrupt, no „aborted" claim', async () => {
    const tab = { id: 'c1', sessionId: 's1', streaming: false, title: 'T', agents: [{ id: 'a1', status: 'running' }, { id: 'a2', status: 'done' }, { id: 'a3', status: 'running' }] };
    const h = harness(tab);
    await h.fn.stopTab(tab);
    assert.equal(h.calls.interrupt.length, 0);
    assert.deepEqual(h.calls.stopTask, ['a1', 'a3']);
    assert.equal(h.calls.aborted, 0);
    assert.match(h.calls.toasts[0], /chat\.stoppAgentenAngefordert/);
    await h.fn.stopTab(tab); // press 2 = hard, here as well
    assert.deepEqual(h.calls.restart, [{}]);
  });
  it('a tab without a session: the hard stop ends the process and stops the spinner', async () => {
    const tab = { id: 'c1', streaming: true, title: 'T' };
    const h = harness(tab);
    await h.fn.stopTab(tab); h.frame();
    await h.fn.stopTab(tab);
    assert.deepEqual(h.calls.api, ['/api/chat/c1/stop']);
    assert.equal(tab.streaming, false);
    assert.equal(h.calls.restart.length, 0);
  });
});

describe('wiring — one Stop path for ⏹, the tab menu and Esc-Esc', () => {
  it('all three go through stopTab', () => {
    assert.match(fs.readFileSync(path.join(PUB, 'chat-composer.js'), 'utf8'), /\$\('#interruptBtn'\)\.onclick = \(\) => stopTab\(chat\);/);
    assert.match(CHAT, /add\('stop', stopArmed\(t\) \? tt\('chat\.stoppenHart'\) : tt\('chat\.stoppen'\), \(\) => stopTab\(t\), !tabCanStop\(t\)\)/);
    assert.match(fs.readFileSync(path.join(PUB, 'commands.js'), 'utf8'), /if \(_escArmed\) \{ _escArmed = false; stopTab\(ACTIVE\); \}/);
  });
  it('a new turn starts disarmed; a frame of a non-streaming tab repaints ⏹', () => {
    assert.match(RENDER, /chat\._stopAt = 0; clearTimeout\(chat\._stopTimer\)/);
    assert.match(fs.readFileSync(path.join(PUB, 'chat-events.js'), 'utf8'), /if \(tab === ACTIVE && !tab\.streaming && typeof refreshInterruptBtn === 'function'\) refreshInterruptBtn\(\);/);
  });
  it('refreshInterruptBtn marks the armed button and keeps looking while ⏹ stands for decaying work', () => {
    const cls = new Set(); let title = ''; const intervals = [];
    const btn = { classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) }, set title(v) { title = v; } };
    const tab = { id: 'c', streaming: false, agents: [{ status: 'running' }] };
    const env = { $: () => btn, ACTIVE: tab, tabCanStop: () => true, stopArmed: () => true, hasHeldGate: () => false, tt: (k) => k,
      setInterval: (f, ms) => { intervals.push(ms); return 1; }, clearInterval: () => {} };
    const src = 'let STOP_VIS_TIMER = null;\n' + liftFn(RENDER, 'refreshInterruptBtn', 'chat-render.js');
    new Function(...Object.keys(env), src + '\nrefreshInterruptBtn();')(...Object.values(env));
    assert.ok(!cls.has('hidden') && cls.has('is-armed'));
    assert.equal(title, 'chat.stoppenHart');
    assert.deepEqual(intervals, [1000]);
  });
});
