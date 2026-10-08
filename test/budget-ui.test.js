'use strict';
// PR-13 — the VISIBLE half of the cost brake, run through the shipped code: the `_budget` frame goes into
// chat-events.js handleEventBody (test/event-pump.js), and the chip comes out of the real chat-status.js
// budgetChip, loaded into a vm context. What must hold: the count reaches the tab, the trip is said ONCE in
// the transcript (a frame per poll must not stack system lines), and the chip shows spend AND budget, marked
// from 80 %, red once tripped — next to the CLI's own cost chip, never merged into it.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { eventPump } = require('./event-pump');

const PUB = path.join(__dirname, '..', 'public', 'js');
const money = (n) => '$' + Number(n).toFixed(2);

function pump(tab) {
  const msgs = [];
  let repaints = 0;
  const p = eventPump(tab, { env: {
    tt: (k) => String(k), fmtUSD: money,
    addMsg: (role, text, o) => { msgs.push({ role, text, error: !!(o && o.error) }); return {}; },
    renderStatusBar: () => { repaints++; },
  } });
  return { feed: p.feed, msgs, repaints: () => repaints };
}
const frame = (o) => Object.assign({ type: '_budget', limitUsd: 2, spentUsd: 0, parts: { main: 0, subagents: 0, workflows: 0 }, unpricedTokens: 0, tripped: false, trippedAtUsd: null, stopped: [], running: 0 }, o);

describe('chat-events.js — the `_budget` frame', () => {
  it('puts the count on the tab and repaints the strip, without a transcript line while under budget', () => {
    const tab = {};
    const p = pump(tab);
    p.feed(frame({ spentUsd: 0.42, parts: { main: 0.1, subagents: 0, workflows: 0.32 } }));
    assert.equal(tab.budgetLive.spentUsd, 0.42);
    assert.equal(tab.budgetLive.parts.workflows, 0.32);
    assert.equal(p.msgs.length, 0);
    assert.ok(p.repaints() >= 1, 'the strip is repainted for the active tab');
  });

  it('says the trip ONCE — with the spend at the trip, the budget, and how many agents were stopped', () => {
    const tab = {};
    const p = pump(tab);
    const stopped = [{ id: 'wf1', ok: true }, { id: 'bg2', ok: true }, { id: 'gone', ok: false, error: 'No task found' }];
    p.feed(frame({ spentUsd: 2.04, tripped: true, trippedAtUsd: 2.04, stopped }));
    p.feed(frame({ spentUsd: 2.11, tripped: true, trippedAtUsd: 2.04, stopped }));
    p.feed(frame({ spentUsd: 2.13, tripped: true, trippedAtUsd: 2.04, stopped }));
    assert.equal(p.msgs.length, 1, 'one line for one trip, not one per poll');
    const m = p.msgs[0];
    assert.equal(m.role, 'system');
    assert.equal(m.error, true);
    assert.match(m.text, /chat-events\.budgetErreicht/);
    assert.match(m.text, /chat-events\.budgetGestoppt/, 'the stopped agents are named');
    assert.match(m.text, /chat-events\.budgetNichtGestoppt/, 'and the one that could not be stopped is not hidden among them');
    assert.equal(tab.budgetLive.spentUsd, 2.13, 'the overshoot after the trip still reaches the tab');
  });
});

function loadStrip() {
  const el = (tag, cls, text) => ({ tag, className: cls || '', textContent: text == null ? '' : String(text), title: '', children: [], appendChild(c) { this.children.push(c); return c; } });
  const ctx = { tt: (k) => String(k), el, fmtUSD: money, fmtNum: (n) => String(n), console, Date, Math, JSON, String, Number, Array, Object };
  ctx.globalThis = ctx;
  const sb = vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(PUB, 'chat-status.js'), 'utf8'), sb, { filename: 'chat-status.js' });
  return sb;
}

describe('chat-status.js budgetChip — spend AND budget, marked as it nears and red once tripped', () => {
  const S = loadStrip();
  it('no budget reported → no chip (the CLI\'s cost chip stands alone)', () => {
    assert.equal(S.budgetChip({}), null);
    assert.equal(S.budgetChip({ budgetLive: { limitUsd: 0 } }), null);
  });
  it('under 80 %: quiet; from 80 %: warn; tripped: bad — each with both numbers on the chip', () => {
    const quiet = S.budgetChip({ budgetLive: { limitUsd: 2, spentUsd: 0.5, parts: {} } });
    assert.equal(quiet.className, 'cs-budget');
    assert.match(quiet.textContent, /\$0\.50 \/ \$2\.00/);
    assert.equal(S.budgetChip({ budgetLive: { limitUsd: 2, spentUsd: 1.7, parts: {} } }).className, 'cs-budget warn');
    const bad = S.budgetChip({ budgetLive: { limitUsd: 2, spentUsd: 2.04, tripped: true, parts: {} } });
    assert.equal(bad.className, 'cs-budget bad');
    assert.match(bad.textContent, /^⛔/);
  });
  it('renderStatusBar really puts it in the strip — next to the CLI\'s cost chip, not instead of it', () => {
    // renderStatusBar lifted out of the shipped file and run inside `with (Proxy)` (technique: test/event-pump.js),
    // so the CALL from the strip to budgetChip is under test, not only the helper.
    const { liftFn } = require('./event-pump');
    const SRC = fs.readFileSync(path.join(PUB, 'chat-status.js'), 'utf8');
    const fakeEl = (tag, cls, text) => ({
      tag, className: cls || '', textContent: text == null ? '' : String(text), title: '', children: [], style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      appendChild(c) { this.children.push(c); return c; }, querySelector: () => null,
    });
    const left = fakeEl('div', 'cs-left');
    Object.defineProperty(left, 'innerHTML', { set() { left.children.length = 0; }, get() { return ''; } });
    const box = fakeEl('div', 'chat-status');
    box.querySelector = (sel) => (sel === '.cs-left' ? left : null);
    const tab = { id: 'c1', sessionCost: 0.12, budgetLive: { limitUsd: 2, spentUsd: 1.1, parts: {} } };
    const loud = /^const LOUD_MODES = .*;$/m.exec(SRC);
    assert.ok(loud, 'const LOUD_MODES not found in public/js/chat-status.js');
    const known = Object.assign(Object.create(null), {
      ACTIVE: tab, el: fakeEl, tt: (k) => k, fmtUSD: money, fmtNum: (n) => String(n), $: (sel) => (sel === '#chatStatus' ? box : null),
      document: { querySelector: () => null }, STATE: { prefs: {} }, LIMIT_TIMER: null,
      modeInfo: () => ({ cls: 'm-plan', label: 'Plan' }), laneStatusBadges: () => [],
    });
    const stub = () => undefined;
    const env = new Proxy(known, {
      has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
      get: (t, k) => (typeof k !== 'string' ? undefined : k in t ? t[k] : stub),
    });
    const src = [loud[0], liftFn(SRC, 'costChip', 'chat-status.js'), liftFn(SRC, 'budgetChip', 'chat-status.js'), liftFn(SRC, 'renderStatusBar', 'chat-status.js')].join('\n');
    const api = new Function('__env', 'with (__env) {\n' + src + '\nreturn { renderStatusBar };\n}')(env);
    api.renderStatusBar();
    const cls = left.children.map((c) => String(c.className));
    assert.ok(cls.includes('cs-budget'), 'the budget chip is in the strip: ' + cls.join(' '));
    assert.ok(cls.includes('cs-cost'), 'and the CLI\'s cost chip still stands next to it');
  });
  it('the tooltip splits the spend and names unpriced tokens instead of hiding them', () => {
    const c = S.budgetChip({ budgetLive: { limitUsd: 2, spentUsd: 0.6, parts: { main: 0.1, subagents: 0.2, workflows: 0.3 }, unpricedTokens: 1234 } });
    assert.match(c.title, /budgetHaupt\$0\.10/);
    assert.match(c.title, /budgetSubagenten\$0\.20/);
    assert.match(c.title, /budgetWorkflows\$0\.30/);
    assert.match(c.title, /budgetOhnePreis/);
    assert.match(c.title, /budgetGrenze/, 'and what the brake cannot do');
  });
});
