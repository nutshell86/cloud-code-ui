'use strict';
// A4 — cost per UI-skill / per schedule is a JOIN of the run history against the per-session cost
// aggregation, not a second measurement. The thing worth testing is the honesty of that join: a run
// whose session is gone must NOT be counted as 0 $, and per-schedule attribution must prefer the
// recorded scheduleId over the "headless run of this skill" fallback used for older records.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { joinRunCosts, runCostWindow } = require('../lib/pure');

const S = (id, cost, tokens) => ({ id, cost, tokens: tokens == null ? cost * 1000 : tokens });

describe('lib/pure — joinRunCosts (A4)', () => {
  it('sums per skill and per run, and reports the per-run average', () => {
    const runs = [
      { id: 'r1', name: 'mein-tag', title: 'Mein Tag', sessionId: 's1', startedAt: 10 },
      { id: 'r2', name: 'mein-tag', title: 'Mein Tag', sessionId: 's2', startedAt: 20 },
      { id: 'r3', name: 'flow', title: 'Flow', sessionId: 's3', startedAt: 30 },
    ];
    const j = joinRunCosts(runs, [S('s1', 0.4), S('s2', 0.6), S('s3', 2)]);
    assert.equal(j.total.toFixed(2), '3.00');
    assert.equal(j.unpriced, 0);
    assert.equal(j.byRun.r2.cost, 0.6);
    assert.equal(j.byRun.r2.priced, true);
    const mt = j.bySkill.find((x) => x.name === 'mein-tag');
    assert.equal(mt.runs, 2);
    assert.equal(mt.cost.toFixed(2), '1.00');
    assert.equal(mt.avgCost.toFixed(2), '0.50');
    assert.equal(mt.lastRun, 20, 'lastRun must be the newest run of that skill');
    assert.equal(j.bySkill[0].name, 'flow', 'sorted by cost, most expensive first');
  });

  it('counts a run whose session is gone as UNPRICED instead of 0 $', () => {
    const runs = [
      { id: 'r1', name: 'demo', sessionId: 'known', startedAt: 1 },
      { id: 'r2', name: 'demo', sessionId: 'deleted-session', startedAt: 2 },
      { id: 'r3', name: 'demo', sessionId: null, startedAt: 3 }, // e.g. --no-session-persistence
    ];
    const j = joinRunCosts(runs, [S('known', 1.25)]);
    assert.equal(j.total, 1.25);
    assert.equal(j.unpriced, 2, 'both unpriceable runs must be reported');
    assert.equal(j.byRun.r2.priced, false);
    assert.equal(j.byRun.r2.cost, 0);
    const d = j.bySkill[0];
    assert.equal(d.runs, 3);
    assert.equal(d.priced, 1, 'the skill row must say how many of its runs could be priced');
  });

  it('attributes to the recorded scheduleId, and falls back per skill for older records', () => {
    const runs = [
      { id: 'a', name: 'sync', sessionId: 's1', startedAt: 1, headless: true, scheduleId: 'sched-A' },
      { id: 'b', name: 'sync', sessionId: 's2', startedAt: 2, headless: true, scheduleId: 'sched-B' },
      { id: 'c', name: 'sync', sessionId: 's3', startedAt: 3, headless: true }, // pre-scheduleId record
      { id: 'd', name: 'sync', sessionId: 's4', startedAt: 4 },                 // interactive → no bucket
    ];
    const j = joinRunCosts(runs, [S('s1', 1), S('s2', 2), S('s3', 4), S('s4', 8)]);
    const byKey = {}; j.bySchedule.forEach((x) => { byKey[x.key] = x; });
    assert.equal(byKey['sched-A'].cost, 1);
    assert.equal(byKey['sched-A'].exact, true);
    assert.equal(byKey['sched-B'].cost, 2);
    assert.equal(byKey['skill:sync'].cost, 4, 'the legacy record lands in the per-skill bucket');
    assert.equal(byKey['skill:sync'].exact, false, 'and it must be marked as inexact');
    assert.ok(!byKey['skill:sync'].runs || byKey['skill:sync'].runs === 1);
    assert.equal(Object.keys(byKey).length, 3, 'an interactive run must not create a schedule bucket');
    assert.equal(j.total, 15, 'the total still covers every run');
  });

  it('accepts a Map as the cost source (same shape as the usage cache)', () => {
    const m = new Map([['s1', { id: 's1', cost: 3, tokens: 10 }]]);
    const j = joinRunCosts([{ id: 'r', name: 'x', sessionId: 's1', startedAt: 1 }], m);
    assert.equal(j.total, 3);
    assert.equal(j.byRun.r.tokens, 10);
  });

  it('empty / malformed input does not throw', () => {
    assert.equal(joinRunCosts(null, null).total, 0);
    assert.equal(joinRunCosts([null, undefined, {}], []).total, 0);
    assert.deepEqual(joinRunCosts([], []).bySkill, []);
  });

  it('runCostWindow narrows to one skill and one time window', () => {
    const runs = [
      { id: 'r1', name: 'mein-tag', sessionId: 's1', startedAt: 1000 },
      { id: 'r2', name: 'mein-tag', sessionId: 's2', startedAt: 5000 },
      { id: 'r3', name: 'flow', sessionId: 's3', startedAt: 5000 },
    ];
    const src = [S('s1', 1), S('s2', 2), S('s3', 4)];
    assert.equal(runCostWindow(runs, src, 'mein-tag', 0).cost, 3);
    assert.equal(runCostWindow(runs, src, 'mein-tag', 2000).cost, 2, 'the older run must fall out of the window');
    assert.equal(runCostWindow(runs, src, 'mein-tag', 2000).runs, 1);
    assert.equal(runCostWindow(runs, src, 'nope', 0).cost, 0);
  });
});
