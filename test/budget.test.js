'use strict';
// PR-13 — the cost brake (lib/budget.js). Two halves:
//   • the pure parts and the watcher with an injected cost reader — what it counts, which tasks it stops,
//     in which order, once, and that a tripped brake stays on;
//   • the real chain in-process against fake-claude's `budget` scenario (a workflow that keeps spending in
//     its own transcript after the parent's `result`, the measured U3 shape): the transcripts are read
//     through the real fold, the CLI gets a real interrupt and a real stop_task, the workflow really ends.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeSandbox } = require('./sandbox');

const sb = makeSandbox('budget', { fakeCli: true });
Object.assign(process.env, sb.env, { CLAUDE_UI_BUDGET_POLL_MS: '150' }); // BEFORE the requires: the seams are read at load time
const budget = require('../lib/budget');
const { startChat, chats, terminateChat, sendToChat } = require('../lib/chat');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(25); } return fn(); }
after(async () => {
  await Promise.allSettled([...chats.values()].map((c) => terminateChat(c, { resume: true })));
  sb.cleanup();
});

// a fold record with one (day × model) bucket: [in, out, cacheRead, cacheWrite, eph5m, eph1h, messages]
const rec = (kind, model, out) => ({ kind, d: { '2026-10-05': { m: { [model]: [0, out, 0, 0, 0, 0, 1] } } } });

describe('costOfRecs — the Usage view\'s pricing, split by where the money went', () => {
  it('main, subagent and workflow files land in their own part; the total is their sum', () => {
    // Sonnet 5 output is $10/MTok (lib/models PRICING, measured against the CLI's cost-state frames)
    const c = budget.costOfRecs([rec('main', 'claude-sonnet-5', 1000), rec('subagent', 'claude-sonnet-5', 2000), rec('workflow', 'claude-sonnet-5', 5000)]);
    assert.equal(Math.round(c.main * 1e6), 10000);
    assert.equal(Math.round(c.subagents * 1e6), 20000);
    assert.equal(Math.round(c.workflows * 1e6), 50000);
    assert.equal(Math.round(c.total * 1e6), 80000);
    assert.equal(c.files, 3);
  });
  it('tokens of a model with no rate are $0 AND reported — never silently dropped', () => {
    const c = budget.costOfRecs([rec('main', 'some-unknown-model', 4000)]);
    assert.equal(c.total, 0);
    assert.equal(c.unpricedTokens, 4000);
  });
});

describe('tasksAfterFrame — which tasks stop_task has to reach', () => {
  const sys = (subtype, extra) => Object.assign({ type: 'system', subtype }, extra);
  it('a backgrounded task and a workflow are tracked; a foreground agent is not (the interrupt ends it)', () => {
    const s = budget.blankTasks();
    assert.equal(budget.tasksAfterFrame(s, sys('task_started', { task_id: 'bg1', is_backgrounded: true })), true);
    assert.equal(budget.tasksAfterFrame(s, sys('task_started', { task_id: 'wf1', task_type: 'local_workflow' })), true);
    assert.equal(budget.tasksAfterFrame(s, sys('task_started', { task_id: 'fg1', is_backgrounded: false })), false);
    assert.deepEqual(budget.runningTaskIds(s).sort(), ['bg1', 'wf1']);
  });
  it('the CLI\'s live list counts too — it can arrive before the task_started that carries the id', () => {
    const s = budget.blankTasks();
    budget.tasksAfterFrame(s, sys('background_tasks_changed', { tasks: [{ task_id: 'L1' }, { task_id: 'L2' }] }));
    assert.deepEqual(budget.runningTaskIds(s).sort(), ['L1', 'L2']);
    budget.tasksAfterFrame(s, sys('background_tasks_changed', { tasks: [{ task_id: 'L2' }] }));
    assert.deepEqual(budget.runningTaskIds(s), ['L2']);
  });
  it('a task leaves on its terminal task_updated or its task_notification — not on a running one', () => {
    const s = budget.blankTasks();
    budget.tasksAfterFrame(s, sys('task_started', { task_id: 'a', is_backgrounded: true }));
    budget.tasksAfterFrame(s, sys('task_started', { task_id: 'b', is_backgrounded: true }));
    budget.tasksAfterFrame(s, sys('task_updated', { task_id: 'a', patch: { status: 'running' } }));
    assert.deepEqual(budget.runningTaskIds(s).sort(), ['a', 'b']);
    budget.tasksAfterFrame(s, sys('task_updated', { task_id: 'a', patch: { status: 'killed' } }));
    budget.tasksAfterFrame(s, sys('task_notification', { task_id: 'b', status: 'completed' }));
    assert.deepEqual(budget.runningTaskIds(s), []);
  });
});

describe('createBudgetWatch — with an injected cost reader', () => {
  // A fake chat + recorded actions. `cost` is what the next read returns; the watcher's own timer is
  // irrelevant here — every poll is called by hand.
  function rig(meta, opts) {
    const log = [], frames = [];
    const chat = { meta: Object.assign({ maxBudgetUsd: 1 }, meta), sessionId: (opts && opts.sessionId) || 'S1', claudeSessionId: (opts && opts.claudeSessionId) || 'S1' };
    let cost = Object.assign({ total: 0, main: 0, subagents: 0, workflows: 0, unpricedTokens: 0, files: 1 }, opts && opts.initial);
    const reads = [];
    const w = budget.createBudgetWatch(chat, {
      pollMs: 3600000,
      readCost: async (session) => { reads.push({ session, total: cost.total }); return { project: 'P', cost: Object.assign({}, cost) }; },
      stopTask: async (c, id) => { log.push('stop:' + id); return { ok: id !== 'refuses', error: id === 'refuses' ? 'No task found with ID: refuses' : '' }; },
      interrupt: () => log.push('interrupt'),
      broadcast: (c, ev) => frames.push(ev),
    });
    return { chat, w, log, frames, reads, set: (c) => { cost = Object.assign({ main: 0, subagents: 0, workflows: 0, unpricedTokens: 0, files: 1 }, c); } };
  }
  after(() => {});

  it('no budget → no watcher at all', () => {
    assert.equal(budget.createBudgetWatch({ meta: { maxBudgetUsd: null } }, {}), null);
    assert.equal(budget.createBudgetWatch({ meta: { maxBudgetUsd: 0 } }, {}), null);
  });

  it('below the budget it only reports; at the budget it trips ONCE — interrupt first, then every running task', async () => {
    const r = rig();
    r.w.onFrame({ type: 'system', subtype: 'task_started', task_id: 'wf1', task_type: 'local_workflow' });
    r.w.onFrame({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'wf1' }, { task_id: 'bg2' }] });
    r.set({ total: 0.4, main: 0.1, workflows: 0.3 });
    await r.w.poll();
    assert.deepEqual(r.log, [], 'under budget nothing is stopped');
    assert.equal(r.frames.at(-1).spentUsd, 0.4);
    assert.equal(r.frames.at(-1).tripped, false);
    r.set({ total: 1.02, main: 0.1, workflows: 0.92 });
    await r.w.poll();
    assert.equal(r.log[0], 'interrupt', 'the main turn ends first, so nothing new is launched while the tasks are stopped');
    assert.deepEqual(r.log.slice(1).sort(), ['stop:bg2', 'stop:wf1']);
    const ev = r.frames.at(-1);
    assert.equal(ev.tripped, true);
    assert.equal(ev.trippedAtUsd, 1.02);
    assert.equal(ev.stopped.length, 2);
    r.set({ total: 1.2, main: 0.1, workflows: 1.1 });
    await r.w.poll();
    assert.equal(r.log.filter((x) => x === 'interrupt').length, 1, 'tripped once — a later poll only reports the overshoot');
    assert.equal(r.frames.at(-1).spentUsd, 1.2);
    r.w.stop();
  });

  it('once tripped it STAYS on: a task announced afterwards is stopped the moment it starts', async () => {
    const r = rig();
    r.set({ total: 1.5 });
    await r.w.poll();
    assert.deepEqual(r.log, ['interrupt']);
    r.w.onFrame({ type: 'system', subtype: 'task_started', task_id: 'late', is_backgrounded: true });
    await waitFor(() => r.log.includes('stop:late'), 1000);
    assert.ok(r.log.includes('stop:late'));
    r.w.stop();
  });

  it('a stop the CLI refuses is reported as not stopped — not counted as a success', async () => {
    const r = rig();
    r.w.onFrame({ type: 'system', subtype: 'task_started', task_id: 'refuses', is_backgrounded: true });
    r.set({ total: 2 });
    await r.w.poll();
    const s = r.frames.at(-1).stopped;
    assert.equal(s.length, 1);
    assert.equal(s[0].ok, false);
    assert.match(s[0].error, /No task found/);
    r.w.stop();
  });

  it('a RESUME counts from its launch: the session\'s spend before this process is the baseline', async () => {
    // the session had cost $5 before this process — read at LAUNCH (createBudgetWatch starts that read)
    const r = rig({ resume: 'S1' }, { claudeSessionId: 'S1', initial: { total: 5, main: 5 } });
    await sleep(10);
    r.set({ total: 5.3, main: 5.3 }); // this process's first answer lands after the launch read
    await r.w.poll();
    assert.equal(r.reads[0].total, 5, 'the baseline is the state at launch, not at the first poll');
    assert.equal(r.frames.at(-1).spentUsd, 0.3, 'yesterday\'s $5 does not arrive as „over budget"');
    assert.equal(r.frames.at(-1).tripped, false);
    r.w.stop();
  });

  it('…and a NEW session starts at zero, without reading anything for the baseline', async () => {
    const r = rig({ resume: null }, { claudeSessionId: 'S1' });
    r.set({ total: 0.3, main: 0.3 });
    await r.w.poll();
    assert.equal(r.frames.at(-1).spentUsd, 0.3);
    r.w.stop();
  });
});

// The real chain: startChat → fake-claude `budget` → transcripts on disk → corpus fold → trip → interrupt +
// stop_task over the real stdin → the fake's workflow ends.
describe('the brake against fake-claude: a workflow that spends after the parent\'s result', () => {
  it('trips at the budget, interrupts, stops the workflow task, and the workflow stops spending', async () => {
    const prev = process.env.FAKE_CLAUDE_SCENARIO;
    process.env.FAKE_CLAUDE_SCENARIO = 'budget';
    const work = fs.mkdtempSync(path.join(sb.root, 'cwd-'));
    let chat;
    try {
      chat = startChat({ cwd: work, maxBudgetUsd: 0.2 });
      assert.ok(chat.budget, 'a chat launched with a budget gets a watcher');
      const written = [];
      const realWrite = chat.proc.stdin.write.bind(chat.proc.stdin);
      chat.proc.stdin.write = (line, ...rest) => { written.push(String(line)); return realWrite(line, ...rest); };
      sendToChat(chat, 'los');
      const frames = () => chat.buffer.map((b) => JSON.parse(b.frame.split('\ndata: ')[1]));
      const trip = await waitFor(() => frames().find((f) => f.type === '_budget' && f.tripped), 20000);
      assert.ok(trip, 'the brake tripped');
      assert.ok(trip.trippedAtUsd >= 0.2, 'not before the budget (' + trip.trippedAtUsd + ')');
      assert.ok(trip.parts.workflows > 0, 'the workflow agent\'s own transcript was counted — the part --max-budget-usd never sees');
      const reqs = written.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((o) => o && o.type === 'control_request');
      const iInt = reqs.findIndex((o) => o.request.subtype === 'interrupt');
      const iStop = reqs.findIndex((o) => o.request.subtype === 'stop_task' && o.request.task_id === 'wftask1');
      assert.ok(iInt >= 0, 'an interrupt went to the CLI');
      assert.ok(iStop > iInt, 'and THEN a stop_task for the workflow task');
      assert.ok(await waitFor(() => frames().some((f) => f.type === 'system' && f.subtype === 'task_notification' && f.status === 'stopped'), 5000), 'the workflow reported itself stopped');
      // …and its transcript stops growing
      const agentFile = await waitFor(() => {
        const find = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { const r = find(p); if (r) return r; } else if (/^agent-.*\.jsonl$/.test(e.name)) return p; } return null; };
        return find(path.join(sb.claudeDir, 'projects'));
      }, 2000);
      const size1 = fs.statSync(agentFile).size;
      await sleep(500);
      assert.equal(fs.statSync(agentFile).size, size1, 'no new answer after the stop');
      // a message now is refused with the reason, not started and interrupted again
      assert.equal(chat.budget.tripped, true);
    } finally {
      if (prev == null) delete process.env.FAKE_CLAUDE_SCENARIO; else process.env.FAKE_CLAUDE_SCENARIO = prev;
      if (chat) await terminateChat(chat, { resume: true });
    }
  });
});
