'use strict';
// A „/model X" TYPED into the composer (05.10.). Julian switched his session that way — „/model
// eu.anthropic.claude-opus-5-5[1m]" — and the CLI did switch it, but nothing in the panel saw it: `tab.modelSel`
// stayed on the previous model, the frames named „claude-opus-5-5" (they never carry „[1m]"), and ctx.js
// ctxResolveModel then read the selector as being about ANOTHER model — variant unknown, the line „… / –".
// Recomputed with the menu entries /api/models really sends: the same numbers under „Opus 5.5 (1M)" give
// „/ 1,0M". (It was not the cause of THAT day's „580K / –" — the floor was, test/ctx.test.js j1 — but it is a
// path of its own to the same line.)
//
// What is pinned here:
//  · the composer remembers ONLY a message that is nothing but „/model <arg>" (ctxTypedModelArg, markTypedModel);
//  · the switch is taken over only once the CLI CONFIRMS it — the next `assistant`/`init` frame names a model
//    that is the argument's (ctxTypedModelVerdict, settleTypedModel) — and then exactly like a dropdown switch:
//    menu value (exact, else the entry for the running variant, else the raw argument as a visible option, „[1m]"
//    kept), persisted, the old model's context forgotten and asked anew, the strip repainted;
//  · a rejection (frames go on naming the old model, or the CLI's turn end is an error) changes nothing and says
//    so in the 🔔 log; „/model" without an argument does nothing at all;
//  · while the switch is pending nothing is filed under the old selector's key (ctxDecide varUnknown, row j4);
//  · fake-claude.js reports the new model after a typed /model, so the browser check can walk it.
// Added by the counter-check of the same day (each was a defect reproduced in the browser or with the lifted code):
//  · WHEN a verdict counts (ctxTypedModelSettle): an init confirms only in the argument's variant, and a switch of
//    the variant alone is confirmed by a frame of the NEXT turn only;
//  · the dead-chat recovery re-marks the /model before it re-sends it; a restart that drops an already processed
//    one says so (retireTypedModel); a later dropdown pick replaces it; a reload resumes on the tab's selection;
//  · a background tab leaves the dropdown alone; the Ultracode/effort forecast is asked anew; only the typed path
//    labels an option „(per /model)".
// The browser functions are lifted out of their files by name, against fake globals — the pattern of
// test/ctx.test.js (loadCmdFn / loadEventsFn / loadChatFn) — so what runs is the panel's own code. Two of the
// checks are still SOURCE matches, said where they stand: call sites inside functions too large to run here
// (sendMessage, flushQueue, startChat, activateTab); the behaviour they wire is run on its own.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ctx = require('../public/js/ctx');
const { ctxTypedModelArg, ctxTypedModelVerdict, ctxTypedModelSettle, ctxNormModel, ctxIsWide, ctxVariantKey, ctxDecide, ctxGaugeLine, ctxForgetModel } = ctx;

const JS = path.join(__dirname, '..', 'public', 'js');
const SRC = {
  chat: fs.readFileSync(path.join(JS, 'chat.js'), 'utf8'),
  events: fs.readFileSync(path.join(JS, 'chat-events.js'), 'utf8'),
  composer: fs.readFileSync(path.join(JS, 'chat-composer.js'), 'utf8'),
};
function lift(file, name, env) {
  const m = SRC[file].match(new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
  assert.ok(m, name + '() not found in public/js/' + file + ' — renamed or reindented?');
  const names = Object.keys(env);
  return new Function(...names, m[0] + '\nreturn ' + name + ';')(...names.map((k) => env[k]));
}

// The two menus the panel really gets from /api/models — Bedrock (concrete ids, the „(1M)" row first, the way
// lib/models.js sorts it, `resolves` the bare id) and first-party (aliases).
const BEDROCK = [
  { value: '', label: 'Default', resolves: 'eu.anthropic.claude-opus-5[1m]' },
  { value: 'eu.anthropic.claude-opus-5-5[1m]', label: 'Opus 5.5 (1M)', resolves: 'eu.anthropic.claude-opus-5-5' },
  { value: 'eu.anthropic.claude-opus-5-5', label: 'Opus 5.5', resolves: 'eu.anthropic.claude-opus-5-5' },
  { value: 'eu.anthropic.claude-opus-5[1m]', label: 'Opus 5 (1M)', resolves: 'eu.anthropic.claude-opus-5' },
  { value: 'eu.anthropic.claude-opus-5', label: 'Opus 5', resolves: 'eu.anthropic.claude-opus-5' },
];
const FIRST_PARTY = [
  { value: '', label: 'Default', resolves: '' },
  { value: 'opus[1m]', label: 'Opus 5 (1M)', resolves: 'claude-opus-5' },
  { value: 'sonnet', label: 'Sonnet 5', resolves: 'claude-sonnet-5' },
];

// A panel around ONE tab: the real settle/menu functions, everything they touch recorded. `active` is the tab the
// panel shows (default: this one) — a BACKGROUND tab must not write the one shared dropdown.
const TT = (k) => ({ 'chat.modellPerTippenUebernommen': 'UEBERNOMMEN {v} / {m}', 'chat.modellPerTippenAbgelehnt': 'ABGELEHNT {a} / {m}',
  'chat.modellPerTippenVerworfen': 'VERWORFEN {a}', 'html.standardmodell': 'Standardmodell' }[k] || k);
const SHORT = (m) => String(m || '').replace(/^claude-/, '');
function panel(menu, tab, active) {
  const MODELS_CACHE = { models: menu };
  const modelMenuKey = lift('chat', 'modelMenuKey', { ctxNormModel, ctxIsWide });
  const modelMenuValueFor = lift('chat', 'modelMenuValueFor', { MODELS_CACHE, ctxVariantKey, modelMenuKey });
  const modelSelForTyped = lift('chat', 'modelSelForTyped', { MODELS_CACHE, ctxIsWide, ctxNormModel, modelMenuValueFor });
  const rec = { persisted: 0, probes: [], forgot: [], log: [], options: [], repainted: 0, gauge: 0, ultracode: 0, forecasts: [], effort: 0 };
  const sel = { value: (active || tab).modelSel || '' };
  const ACTIVE = active || tab;
  const settle = lift('events', 'settleTypedModel', {
    MODELS_CACHE, ctxTypedModelSettle, modelSelForTyped,
    ensureModelOption: (v, typed) => rec.options.push([v, !!typed]),
    persistTabs: () => { rec.persisted++; },
    ctxForgetModel: (t, keep) => { rec.forgot.push(!!keep); ctxForgetModel(t, keep); },
    ctxProbe: (t, trg) => rec.probes.push(trg),
    refreshUltracodeState: () => { rec.ultracode++; },
    // the forecast is asked for the NEW selection; its answer is async in the panel, so the callback is kept and a
    // test calls it when it wants the answer to land
    fetchUltracodeSupport: (t, m, after) => { rec.forecasts.push([t === tab, m, t._ucSupport]); rec.forecastDone = after; },
    applyEffortLevelsForModel: () => { rec.effort++; },
    ACTIVE, $: (q) => (q === '#modelSel' ? sel : null), refreshDefaultsPin: () => {},
    renderTabs: () => {}, renderStatusBar: () => { rec.repainted++; }, updateCtxGauge: () => { rec.gauge++; },
    logEvent: (m, k) => rec.log.push([m, k]), tt: TT, shortModel: SHORT,
  });
  return { settle, rec, sel, modelSelForTyped };
}
const pending = (arg, sawResult) => ({ arg, from: '', at: 1, sawResult: !!sawResult });
const fmtDe = (n) => new Intl.NumberFormat('de-DE').format(Math.round(n));
const line = (tab, menu) => {
  const entry = (menu || BEDROCK).find((m) => m.value === (tab.modelSel || '')) || {};
  return ctxGaugeLine(ctxDecide(tab, { known: {}, sel: tab.modelSel, resolves: entry.resolves || '', label: entry.label || '' }),
    { kontext: 'Kontext ', pending: 'MESSE' }, fmtDe);
};

describe('a typed /model — what the composer remembers (ctxTypedModelArg · markTypedModel)', () => {
  const CASES = [
    ['/model eu.anthropic.claude-opus-5-5[1m]', 'eu.anthropic.claude-opus-5-5[1m]', 'Julian\'s own message, suffix and all'],
    ['/model opus[1m]', 'opus[1m]', 'an alias'],
    ['  /model sonnet  ', 'sonnet', 'surrounding blanks are the composer\'s, not the command\'s'],
    ['/model', '', 'without an argument the CLI opens its picker — nothing to adopt'],
    ['/model   ', '', '…also with trailing blanks'],
    ['/model opus extra', '', 'two words are not a model id'],
    ['bitte /model opus[1m] nehmen', '', 'a sentence that mentions the command is a sentence'],
    ['/models opus', '', 'another command'],
    ['/modelopus[1m]', '', 'no separator — a different word, not the command'],
    ['/model\nopus', '', 'a second line is a message, not an argument'],
    [null, '', 'nothing at all'],
  ];
  CASES.forEach(([text, want, why]) => it(why, () => assert.equal(ctxTypedModelArg(text), want)));

  it('markTypedModel records a pending switch only for an argument — and the gauge is told', () => {
    const tab = { model: 'claude-opus-5' };
    let painted = 0;
    const mark = lift('composer', 'markTypedModel', { ctxTypedModelArg, ACTIVE: tab, updateCtxGauge: () => { painted++; } });
    mark(tab, '/model');
    assert.equal(tab._modelPending, undefined, '„/model" alone → nothing');
    mark(tab, 'hallo');
    assert.equal(tab._modelPending, undefined);
    mark(tab, '/model eu.anthropic.claude-opus-5-5[1m]');
    assert.equal(tab._modelPending.arg, 'eu.anthropic.claude-opus-5-5[1m]');
    assert.equal(tab._modelPending.from, 'claude-opus-5');
    assert.equal(tab._modelPending.sawResult, false);
    assert.equal(painted, 1);
  });

  it('…at BOTH places a message really goes out (a wiring check — the behaviour is in the tests below)', () => {
    // the immediate send and the queue flush — the same two places as the ctx ops (markCtxOp), so a queued
    // /model behaves like a typed one, and a queued one that is removed again never becomes pending. These two are
    // CALL SITES inside functions a test cannot run without the whole composer, so they are matched as source.
    // Since #92 the immediate send goes out as `out` (the text plus a plan-start attachment from the composer
    // chip) and a plan-start note sits between the marks and the delivery — so the check is: the /model mark
    // reads the SAME variable the ctx mark and the delivery read, right after the ctx mark, before the delivery.
    const send = SRC.composer.match(/^async function sendMessage\([\s\S]*?^\}/m)[0];
    const m = send.match(/markCtxOp\(tab, (\w+)\);[^\n]*\n\s*markTypedModel\(tab, (\w+)\);[\s\S]*?await deliverText\(tab, (\w+),/);
    assert.ok(m, 'sendMessage: markCtxOp → markTypedModel → deliverText, in that order');
    assert.equal(m[2], m[1], 'markTypedModel reads what markCtxOp reads');
    assert.equal(m[3], m[1], '…and what really goes out');
    const flush = SRC.composer.match(/^function flushQueue\([\s\S]*?^\}/m)[0];
    assert.match(flush, /markTypedModel\(tab, item\.text\);[\s\S]*?\n\s*deliverText\(tab, item\.text,/);
    // …and the (re)start goes through retireTypedModel (its behaviour: the test of that function, below)
    const start = SRC.events.match(/^async function startChat\([\s\S]*?^\}/m)[0];
    assert.match(start, /\n\s*retireTypedModel\(tab\);/);
    assert.doesNotMatch(start, /_modelPending = null/, 'and only through it — no second, silent reset beside it');
  });

  // The behaviour of the send-failure path, RUN (counter-check: a regex for „_modelPending = null" stayed green
  // with the condition inverted, and with the assignment turned into a string).
  function failer(tab) {
    const rec = { toasts: 0 };
    const fn = lift('composer', 'markSendFailed', {
      toast: () => { rec.toasts++; }, tt: (k) => k, withTab: (t, f) => f(), setComposerBusy: () => {}, ctxTypedModelArg,
      el: () => { throw new Error('no bubble expected'); }, ACTIVE: tab, scrollBottom: () => {}, composerSet: () => {}, sendMessage: () => {},
    });
    return { fn, rec };
  }
  it('a send that FAILED takes back exactly its own /model — another pending one stays', () => {
    const tab = { _modelPending: { arg: 'opus[1m]', from: 'claude-opus-5', at: 1, sawResult: false } };
    const { fn } = failer(tab);
    fn(tab, null, '/model sonnet', [], new Error('x'));
    assert.equal(tab._modelPending.arg, 'opus[1m]', 'a different /model failing is not this one');
    fn(tab, null, 'hallo', [], new Error('x'));
    assert.ok(tab._modelPending, 'an ordinary message failing leaves it alone');
    fn(tab, null, '/model opus[1m]', [], new Error('x'));
    assert.equal(tab._modelPending, null, 'its own send failed → it never reached the CLI → not pending');
    fn(null, null, '/model x', [], new Error('x'));            // no tab → nothing to do, nothing thrown
  });

  it('the DEAD-CHAT recovery re-marks the /model before it re-sends it (deliverText → restartResume → post)', async () => {
    // Counter-check (browser, :8815): sendMessage marked the switch, the POST hit a reaped chat, deliverText
    // restarted — and startChat's reset dropped the pending switch. The re-sent /model then switched the NEW
    // process, and nothing in the panel noticed: selection on the old model, CLI on the new one.
    const tab = { id: 'old', sessionId: 's1', model: 'claude-opus-5', modelSel: 'eu.anthropic.claude-opus-5' };
    const seen = [];
    let calls = 0;
    const markTypedModel = lift('composer', 'markTypedModel', { ctxTypedModelArg, ACTIVE: null, updateCtxGauge: () => {} });
    const deliver = lift('composer', 'deliverText', {
      api: async () => { calls++; seen.push(tab._modelPending && tab._modelPending.arg); if (calls === 1) throw new Error('chat not found'); return {}; },
      // what startChat does to it (retireTypedModel) — the restart replaces the process
      restartResume: async (t) => { t._modelPending = null; t.id = 'new'; },
      withTab: (t, f) => f(), addMsg: () => ({ m: {} }), setComposerBusy: () => {},
      markTypedModel, markSendFailed: (t, n, x, a, e) => { throw e; },
    });
    markTypedModel(tab, '/model eu.anthropic.claude-opus-5-5[1m]');           // what sendMessage did before
    await deliver(tab, '/model eu.anthropic.claude-opus-5-5[1m]', [], null);
    assert.equal(calls, 2, 'posted twice: the dead chat, then the resumed one');
    assert.deepEqual(seen, ['eu.anthropic.claude-opus-5-5[1m]', 'eu.anthropic.claude-opus-5-5[1m]'],
      'pending at BOTH posts — the restart dropped it, the recovery marked it again before the second');
    assert.equal(tab._modelPending.sawResult, false, 'a fresh pending switch for the new process');
  });

  it('a (re)start retires a pending /model — and SAYS so when the CLI had already processed it', () => {
    const log = [];
    const retire = lift('events', 'retireTypedModel', { logEvent: (m, k) => log.push([m, k]), tt: TT });
    const notYet = { _modelPending: { arg: 'opus', sawResult: false } };
    retire(notYet);
    assert.equal(notYet._modelPending, null);
    assert.equal(log.length, 0, 'not delivered yet (the dead-chat recovery re-marks it) → nothing lost, nothing said');
    const done = { _modelPending: { arg: 'eu.anthropic.claude-opus-5[1m]', sawResult: true } };
    retire(done);
    assert.equal(done._modelPending, null);
    assert.deepEqual(log, [['VERWORFEN eu.anthropic.claude-opus-5[1m]', 'warn']],
      'the CLI had switched, the new process starts on the tab\'s selection — said once in the 🔔 log');
    retire({}); retire(null);
    assert.equal(log.length, 1);
  });
});

describe('a typed /model — the CLI confirms or refuses it (ctxTypedModelVerdict)', () => {
  const V = [
    ['eu.anthropic.claude-opus-5-5[1m]', 'claude-opus-5-5', '', 'confirm', 'the frame names the model without prefix and suffix'],
    ['eu.anthropic.claude-opus-5-5[1m]', 'eu.anthropic.claude-opus-5-5[1m]', '', 'confirm', '…or with both (an `init`)'],
    ['claude-opus-5-5', 'eu.anthropic.claude-opus-5-5-v1:0', '', 'confirm', 'a Bedrock -vN is the same model'],
    ['eu.anthropic.claude-opus-5-5[1m]', 'claude-opus-5', '', 'reject', 'the frames still name the previous model'],
    ['opus[1m]', 'claude-opus-5', 'claude-opus-5', 'confirm', 'an alias, through the menu entry it resolves to'],
    ['opus[1m]', 'claude-opus-5', '', 'confirm', 'an alias the menu does not know: the family word matches'],
    ['opus[1m]', 'claude-sonnet-5', '', 'reject', '…but not another family'],
    ['opus', 'claude-opus-5-5', '', 'confirm', '„opus" is whichever opus the CLI resolved it to'],
    ['default', 'claude-opus-5', '', 'confirm', '„default" with no Default entry to compare: the CLI said what it runs'],
    ['default', 'claude-sonnet-5', 'eu.anthropic.claude-opus-5[1m]', 'reject', '„default" against the Default entry\'s resolves'],
    ['eu.anthropic.claude-opus-5-5[1m]', '<synthetic>', '', '', 'the CLI\'s own sender is no verdict'],
    ['eu.anthropic.claude-opus-5-5[1m]', '', '', '', 'no model named, no verdict'],
  ];
  V.forEach(([arg, served, res, want, why]) => it(why, () => assert.equal(ctxTypedModelVerdict(arg, served, res), want)));
});

describe('a typed /model — WHEN a verdict counts (ctxTypedModelSettle)', () => {
  // [arg, from, sawResult, served, via, argResolves, want, why]
  const S = [
    ['eu.anthropic.claude-opus-5-5[1m]', 'claude-opus-5', false, 'claude-opus-5-5', 'frame', '', 'confirm', 'another model named by a frame: confirmed at once'],
    ['eu.anthropic.claude-opus-5-5[1m]', 'claude-opus-5', false, 'claude-opus-5', 'frame', '', '', 'the OLD model before the command\'s turn end: no verdict yet'],
    ['eu.anthropic.claude-opus-5-5[1m]', 'claude-opus-5', true, 'claude-opus-5', 'frame', '', 'reject', '…after it: rejected'],
    ['eu.anthropic.claude-opus-5-5[1m]', 'claude-opus-5', true, 'eu.anthropic.claude-opus-5', 'init', '', '', 'an init never rejects'],
    ['eu.anthropic.claude-opus-5-5[1m]', 'claude-opus-5', false, 'eu.anthropic.claude-opus-5-5[1m]', 'init', '', 'confirm', 'an init in the argument\'s variant confirms'],
    // the counter-check's cases: the init carries the suffix, so the variant has to agree
    ['eu.anthropic.claude-opus-5-5[1m]', 'claude-opus-5', false, 'eu.anthropic.claude-opus-5-5', 'init', '', '', 'an init of the right model in the OTHER variant confirms nothing'],
    ['eu.anthropic.claude-opus-5[1m]', 'eu.anthropic.claude-opus-5', false, 'eu.anthropic.claude-opus-5', 'init', '', '', 'Julian\'s case: „[1m]" on the same model — the old bare init is no confirmation'],
    // a switch of the VARIANT only: every frame of the old session names the same model
    ['opus', 'claude-opus-5', false, 'claude-opus-5', 'frame', '', '', '„/model opus" out of opus[1m]: a frame before the turn end proves nothing'],
    ['opus', 'claude-opus-5', false, 'claude-opus-5[1m]', 'init', '', '', '…an init never confirms a variant-only switch (it may precede the command)'],
    ['opus', 'claude-opus-5', true, 'claude-opus-5', 'init', '', '', '…not even after the turn end and in the right spelling: whether init carries „[1m]" is unmeasured (P10)'],
    ['opus', 'claude-opus-5', true, 'claude-opus-5', 'frame', '', 'confirm', '…a frame of the NEXT turn does'],
    ['eu.anthropic.claude-opus-5[1m]', 'claude-opus-5', true, 'claude-opus-5', 'frame', '', 'confirm', '…the same the other way round'],
    ['default', 'claude-opus-5-5', false, 'claude-opus-5', 'init', 'eu.anthropic.claude-opus-5[1m]', 'confirm', '„default" has no variant of its own to agree on'],
    ['default', 'claude-opus-5', false, 'claude-opus-5', 'frame', 'eu.anthropic.claude-opus-5[1m]', '', '„default" onto the model already running is variant-only too'],
    ['opus[1m]', '', false, 'claude-opus-5', 'frame', 'claude-opus-5', 'confirm', 'no previous model known: nothing to confuse it with'],
  ];
  S.forEach(([arg, from, sawResult, served, via, res, want, why]) => it(why, () =>
    assert.equal(ctxTypedModelSettle({ arg, from, at: 1, sawResult }, served, via, res), want)));
  it('nothing pending, or nothing named → no verdict', () => {
    assert.equal(ctxTypedModelSettle(null, 'claude-opus-5', 'frame', ''), '');
    assert.equal(ctxTypedModelSettle({ arg: 'opus', from: '', sawResult: true }, '<synthetic>', 'frame', ''), '');
  });
});

describe('a typed /model — the takeover (chat-events.js settleTypedModel)', () => {
  it('Julian\'s switch on a Bedrock menu: confirmed by the frame → „Opus 5.5 (1M)", and the line reads 1M instead of „–"', () => {
    const tab = { id: 'c1', model: 'claude-opus-5', modelSel: 'eu.anthropic.claude-opus-5', ctxTokens: 580000, ctxStamp: 3,
      _modelPending: pending('eu.anthropic.claude-opus-5-5[1m]', true) };
    // BEFORE: the frame has already named the new model, the selector has not moved — this is the reported line
    tab.model = 'claude-opus-5-5';
    assert.equal(line(Object.assign({}, tab, { _modelPending: null })), 'Kontext · 580.000 / –',
      'the typed path to „– ": the selector is about another model, the variant is unknown');
    const { settle, rec, sel } = panel(BEDROCK, tab);
    assert.equal(settle(tab, 'claude-opus-5-5', 'frame'), 'confirm');
    assert.equal(tab.modelSel, 'eu.anthropic.claude-opus-5-5[1m]', 'the exact menu value — „[1m]" kept');
    assert.equal(sel.value, 'eu.anthropic.claude-opus-5-5[1m]', 'the dropdown follows');
    assert.equal(tab._modelPending, null);
    assert.equal(rec.persisted, 1, 'persisted — and since the counter-check a reload also RESUMES on it (_resumeDormantNow, below)');
    assert.deepEqual(rec.forgot, [true], 'the old model\'s context is forgotten — the frame\'s own count is kept');
    assert.deepEqual(rec.probes, ['model'], 'and the CLI is asked about the new one');
    assert.equal(rec.repainted, 1);
    assert.equal(rec.ultracode, 1, 'the per-model ultracode verdict is re-read, like a dropdown switch');
    assert.deepEqual(rec.log, [['UEBERNOMMEN eu.anthropic.claude-opus-5-5[1m] / opus-5-5', 'info']], 'one 🔔 line: the selection and who answers');
    // AFTER: the same numbers, now judged by the selection the CLI confirmed
    tab.ctxTokens = 580000;
    assert.equal(line(tab), 'Kontext ≈ 58% · 580.000 / 1.000.000');
  });

  it('a REJECTED switch: the frames go on naming the old model → nothing taken over, a 🔔 warning', () => {
    const tab = { id: 'c1', model: 'claude-opus-5', modelSel: 'eu.anthropic.claude-opus-5', _modelPending: pending('eu.anthropic.claude-restricted-9', true) };
    const { settle, rec, sel } = panel(BEDROCK, tab);
    assert.equal(settle(tab, 'claude-opus-5', 'frame'), 'reject');
    assert.equal(tab.modelSel, 'eu.anthropic.claude-opus-5', 'the selection is unchanged');
    assert.equal(sel.value, 'eu.anthropic.claude-opus-5');
    assert.equal(tab._modelPending, null, 'and the switch is no longer pending');
    assert.deepEqual([rec.persisted, rec.probes, rec.forgot], [0, [], []], 'nothing persisted, nothing forgotten, nobody asked');
    assert.deepEqual(rec.log, [['ABGELEHNT eu.anthropic.claude-restricted-9 / opus-5', 'warn']]);
  });

  it('…but only a frame AFTER the command\'s own turn end can reject: an earlier one may belong to a turn begun before it', () => {
    const tab = { id: 'c1', model: 'claude-opus-5', modelSel: 'eu.anthropic.claude-opus-5', _modelPending: pending('eu.anthropic.claude-opus-5-5[1m]', false) };
    const { settle, rec } = panel(BEDROCK, tab);
    assert.equal(settle(tab, 'claude-opus-5', 'frame'), '', 'no verdict yet');
    assert.ok(tab._modelPending, 'still pending');
    assert.equal(rec.log.length, 0);
    // a confirmation needs no such wait — the CLI naming the new model is the answer, whenever it comes
    assert.equal(settle(tab, 'claude-opus-5-5', 'frame'), 'confirm');
  });

  it('an `init` can confirm (its model carries the suffix) but never reject — it may precede the command', () => {
    const tab = { id: 'c1', model: 'claude-opus-5', modelSel: 'eu.anthropic.claude-opus-5', ctxTokens: 9000, _modelPending: pending('eu.anthropic.claude-opus-5-5[1m]', true) };
    const { settle, rec } = panel(BEDROCK, tab);
    assert.equal(settle(tab, 'eu.anthropic.claude-opus-5', 'init'), '', 'the old model in an init is no refusal');
    assert.ok(tab._modelPending);
    assert.equal(settle(tab, 'eu.anthropic.claude-opus-5-5[1m]', 'init'), 'confirm');
    assert.equal(tab.modelSel, 'eu.anthropic.claude-opus-5-5[1m]');
    assert.deepEqual(rec.forgot, [false], 'an init carries no context of the new model — the count goes too');
  });

  it('an ALIAS: the exact menu value on a first-party menu, the concrete wide entry on a Bedrock one', () => {
    const fp = { id: 'c1', model: 'claude-sonnet-5', modelSel: 'sonnet', _modelPending: pending('opus[1m]', true) };
    assert.equal(panel(FIRST_PARTY, fp).settle(fp, 'claude-opus-5', 'frame'), 'confirm');
    assert.equal(fp.modelSel, 'opus[1m]');
    assert.equal(line(Object.assign(fp, { ctxTokens: 300000 }), FIRST_PARTY), 'Kontext ≈ 30% · 300.000 / 1.000.000');
    const bd = { id: 'c1', model: 'claude-opus-5-5', modelSel: 'eu.anthropic.claude-opus-5-5[1m]', _modelPending: pending('opus[1m]', true) };
    assert.equal(panel(BEDROCK, bd).settle(bd, 'claude-opus-5', 'frame'), 'confirm');
    assert.equal(bd.modelSel, 'eu.anthropic.claude-opus-5[1m]', 'the alias lands on the entry for the running variant — never the bare row');
  });

  it('a value the menu does not have: the RAW argument, shown as a temporary option, „[1m]" kept', () => {
    const tab = { id: 'c1', model: 'claude-opus-5', modelSel: 'eu.anthropic.claude-opus-5', _modelPending: pending('eu.anthropic.claude-fable-5-1[1m]', true) };
    const { settle, rec, sel } = panel(BEDROCK, tab);
    assert.equal(settle(tab, 'claude-fable-5-1', 'frame'), 'confirm');
    assert.equal(tab.modelSel, 'eu.anthropic.claude-fable-5-1[1m]');
    assert.deepEqual(rec.options, [['eu.anthropic.claude-fable-5-1[1m]', true]],
      'the dropdown gets an option for it (ensureModelOption), labelled as typed — this path KNOWS it was');
    assert.equal(sel.value, 'eu.anthropic.claude-fable-5-1[1m]');
  });

  it('a BACKGROUND tab takes the switch over without touching the dropdown, which belongs to the visible tab', () => {
    const visible = { id: 'c0', model: 'claude-sonnet-5', modelSel: 'eu.anthropic.claude-sonnet-5' };
    const bg = { id: 'c1', model: 'claude-opus-5', modelSel: 'eu.anthropic.claude-opus-5', _modelPending: pending('eu.anthropic.claude-opus-5-5[1m]', true) };
    const { settle, rec, sel } = panel(BEDROCK, bg, visible);
    assert.equal(settle(bg, 'claude-opus-5-5', 'frame'), 'confirm');
    assert.equal(bg.modelSel, 'eu.anthropic.claude-opus-5-5[1m]', 'the TAB takes it over');
    assert.equal(sel.value, 'eu.anthropic.claude-sonnet-5', 'the shared dropdown still shows the visible tab');
    assert.deepEqual(rec.options, [], 'and gets no option for somebody else\'s value');
    assert.equal(rec.repainted, 0, 'the strip is the visible tab\'s too');
    assert.equal(rec.persisted, 1);
  });

  it('„/model default" against a Default entry that resolves ELSEWHERE is a rejection — the menu entry is consulted', () => {
    // counter-check mutation R4 (the argument's menu entry never found) stayed green: every default row confirmed
    // with or without it. Here the menu says Default = opus-5[1m], the CLI goes on answering with sonnet-5.
    const tab = { id: 'c1', model: 'claude-sonnet-5', modelSel: 'eu.anthropic.claude-sonnet-5', _modelPending: pending('default', true) };
    const { settle, rec } = panel(BEDROCK, tab);
    assert.equal(settle(tab, 'claude-sonnet-5', 'frame'), 'reject');
    assert.equal(tab.modelSel, 'eu.anthropic.claude-sonnet-5');
    assert.equal(rec.log[0][1], 'warn');
  });

  it('a switch of the VARIANT only waits for the next turn — the old session\'s frames name the same model', () => {
    // „/model eu.anthropic.claude-opus-5[1m]" on a tab that runs the bare opus-5: an init of the old bare session
    // and a frame of a turn the CLI began before the command both name claude-opus-5 and confirm NOTHING; the frame
    // after the command's own turn end does (the CLI answers the next turn on the switched session).
    const tab = { id: 'c1', model: 'claude-opus-5', modelSel: 'eu.anthropic.claude-opus-5',
      _modelPending: { arg: 'eu.anthropic.claude-opus-5[1m]', from: 'claude-opus-5', at: 1, sawResult: false } };
    const { settle } = panel(BEDROCK, tab);
    assert.equal(settle(tab, 'eu.anthropic.claude-opus-5', 'init'), '', 'the old bare init');
    assert.equal(settle(tab, 'claude-opus-5', 'frame'), '', 'a frame before the turn end');
    assert.equal(tab.modelSel, 'eu.anthropic.claude-opus-5', 'nothing taken over yet');
    tab._modelPending.sawResult = true;
    assert.equal(settle(tab, 'claude-opus-5', 'frame'), 'confirm');
    assert.equal(tab.modelSel, 'eu.anthropic.claude-opus-5[1m]');
  });

  it('a confirmed switch asks the per-model FORECAST anew (Ultracode, effort levels) — like a dropdown switch', () => {
    // counter-check: after a confirmed /model, `_ucSupport.model` still named the previous model, so the effort
    // menu filtered and warned by that model's levels
    const tab = { id: 'c1', model: 'claude-opus-5', modelSel: 'eu.anthropic.claude-opus-5', _ucSupport: { model: 'eu.anthropic.claude-opus-5' },
      _modelPending: pending('eu.anthropic.claude-opus-5-5[1m]', true) };
    const { settle, rec } = panel(BEDROCK, tab);
    settle(tab, 'claude-opus-5-5', 'frame');
    assert.deepEqual(rec.forecasts, [[true, 'eu.anthropic.claude-opus-5-5[1m]', null]],
      'asked for the NEW selection, with the old verdict already dropped');
    assert.equal(rec.effort, 1, 'the effort menu drops the old model\'s verdict at once…');
    const painted = rec.repainted;
    rec.forecastDone({ model: 'eu.anthropic.claude-opus-5-5[1m]' });
    assert.equal(rec.effort, 2, '…and is filtered by the new one when the answer lands');
    assert.equal(rec.repainted, painted + 1);
  });

  it('„/model default" is the „Default" entry, and a bare argument stays bare', () => {
    const d = { id: 'c1', model: 'claude-opus-5-5', modelSel: 'eu.anthropic.claude-opus-5-5[1m]', _modelPending: pending('default', true) };
    assert.equal(panel(BEDROCK, d).settle(d, 'claude-opus-5', 'frame'), 'confirm');
    assert.equal(d.modelSel, '', 'the menu\'s „Default" has the empty value');
    const b = { id: 'c1', model: 'claude-opus-5', modelSel: 'eu.anthropic.claude-opus-5', _modelPending: pending('eu.anthropic.claude-opus-5-5', true) };
    assert.equal(panel(BEDROCK, b).settle(b, 'claude-opus-5-5', 'frame'), 'confirm');
    assert.equal(b.modelSel, 'eu.anthropic.claude-opus-5-5', 'not the „(1M)" row that resolves to the same id');
  });

  it('no pending switch → the frame handlers do nothing at all', () => {
    const tab = { id: 'c1', model: 'claude-opus-5', modelSel: 'x' };
    const { settle, rec } = panel(BEDROCK, tab);
    assert.equal(settle(tab, 'claude-opus-5-5', 'frame'), '');
    assert.equal(tab.modelSel, 'x');
    assert.deepEqual([rec.persisted, rec.log.length], [0, 0]);
  });

  it('the three call sites: init (confirm only), the assistant frame BEFORE the model-change block, the result', () => {
    assert.match(SRC.events, /chat\.model = ev\.model \|\| chat\.model;\n[^\n]*\n\s*if \(chat\._modelPending && ev\.model\) settleTypedModel\(chat, ev\.model, 'init'\);/);
    // before `if (realModel && chat.model !== realModel)`, so a confirmation's forget+probe is not done twice
    assert.match(SRC.events, /if \(chat\._modelPending && realModel\) settleTypedModel\(chat, realModel, 'frame'\);\n\s*if \(realModel && chat\.model !== realModel\) \{/);
    // the command's own turn end goes through noteTypedModelResult (its behaviour: the next test)
    assert.match(SRC.events, /if \(chat\._modelPending\) noteTypedModelResult\(chat, ev\);/);
  });

  it('the command\'s own turn end (noteTypedModelResult): an ERROR is the refusal, said with the CLI\'s words; anything else arms it', () => {
    // RUN, not matched (counter-check: deleting the log line of the error branch stayed green)
    const log = [];
    const note = lift('events', 'noteTypedModelResult', { logEvent: (m, k) => log.push([m, k]), tt: TT, shortModel: SHORT });
    const tab = { model: 'claude-opus-5', _modelPending: pending('eu.anthropic.claude-restricted-9', false) };
    assert.equal(note(tab, { type: 'result', is_error: true, errors: ['Model is restricted by your organization'] }), 'rejected');
    assert.equal(tab._modelPending, null);
    assert.deepEqual(log, [['ABGELEHNT eu.anthropic.claude-restricted-9 / opus-5 — Model is restricted by your organization', 'warn']]);
    const ok = { model: 'claude-opus-5', _modelPending: pending('opus', false) };
    assert.equal(note(ok, { type: 'result', is_error: false, result: 'Set model to `opus`' }), 'noted');
    assert.equal(ok._modelPending.sawResult, true, 'from now on a frame naming another model is a rejection');
    // an error AFTER the command's own turn end is some later turn's, not the refusal of this one
    assert.equal(note(ok, { type: 'result', is_error: true, result: 'boom' }), 'noted');
    assert.ok(ok._modelPending);
    assert.equal(note({}, { is_error: true }), '');
    assert.equal(log.length, 1);
  });
});

describe('a typed /model meets the rest of the panel (dropdown, restart, reload)', () => {
  // A <select> and its options, enough for ensureModelOption / syncRunSelectors.
  function fakeSelect(values) {
    const sel = { value: '', options: (values || []).map((v) => ({ value: v, textContent: v })) };
    sel.appendChild = (o) => sel.options.push(o);
    return sel;
  }
  function optionMaker(sel, cache) {
    return lift('chat', 'ensureModelOption', {
      $: (q) => (q === '#modelSel' ? sel : null), MODELS_CACHE: cache === undefined ? { models: BEDROCK } : cache,
      el: () => ({}), modelGlyph: () => '🧠', shortModel: SHORT, tt: (k) => (k === 'chat.modellPerTippenOption' ? ' (per /model)' : k),
    });
  }
  it('ensureModelOption names the provenance only when the caller knows it — and waits for the menu', () => {
    const sel = fakeSelect(['', 'eu.anthropic.claude-opus-5']);
    const ensure = optionMaker(sel);
    ensure('eu.anthropic.claude-fable-5-1[1m]', true);
    ensure('claude-pinned-old');
    ensure('eu.anthropic.claude-opus-5');                         // already listed → nothing
    assert.deepEqual(sel.options.slice(2).map((o) => [o.value, o.textContent]), [
      ['eu.anthropic.claude-fable-5-1[1m]', '🧠 eu.anthropic.claude-fable-5-1[1m] (per /model)'],   // (the stub shortens only „claude-")
      ['claude-pinned-old', '🧠 pinned-old'],                      // the way populateModelSelect labels an unknown value
    ]);
    const boot = fakeSelect(['']);
    optionMaker(boot, null)('eu.anthropic.claude-fable-5-1[1m]', true);
    assert.equal(boot.options.length, 1, 'before the menu answered: nothing (every restored value would read „per /model")');
  });
  it('a project chat opened BEFORE the model list: its model is in the dropdown, survives the rebuild, goes with the start', () => {
    // a <select> the way the browser has it: a value without an option falls back to the first option
    const strict = () => {
      const s = { options: [{ value: '', textContent: 'Standard' }], _v: '' };
      Object.defineProperty(s, 'value', { get() { return s._v; }, set(v) { s._v = s.options.some((o) => o.value === v) ? v : (s.options[0] ? s.options[0].value : ''); } });
      s.appendChild = (o) => s.options.push(o);
      Object.defineProperty(s, 'innerHTML', { set() { s.options = []; s._v = ''; } });
      return s;
    };
    const sels = { '#modelSel': strict(), '#permMode': { value: '' }, '#effortSel': { value: '' } };
    const $ = (q) => sels[q];
    const sync = lift('chat', 'syncRunSelectors', { $, ensureModelOption: optionMaker(sels['#modelSel'], null), applyChatDefaults: () => {} });
    sync({ cfgTouched: true, modelSel: 'claude-opus-5', permissionMode: 'plan' }); // projectApplyToTab → activateTab, ~1 s after boot
    assert.equal(sels['#modelSel'].value, 'claude-opus-5', 'the project model fell out of the dropdown (the start read \'\' → no --model)');
    const populate = lift('chat', 'populateModelSelect', {
      $, MODELS_CACHE: { models: [{ value: '', label: 'Default' }, { value: 'opus', label: 'Opus' }] }, CHAT_DEFAULTS: { model: '' },
      el: () => ({}), tt: (k) => k, modelGlyph: () => '', shortModel: SHORT, normModelId: (x) => x, toast: () => {}, MODEL_BLOCK_WARNED: true,
    });
    populate(); // the list arrives later
    assert.equal(sels['#modelSel'].value, 'claude-opus-5', 'the rebuild dropped the project model');
  });
  it('a tab switch puts a started tab\'s unknown selection into the dropdown — with an option, without „(per /model)"', () => {
    const sels = { '#modelSel': fakeSelect(['', 'eu.anthropic.claude-opus-5']), '#permMode': { value: '' }, '#effortSel': { value: '' } };
    let defaults = 0;
    const $ = (q) => sels[q];
    const sync = lift('chat', 'syncRunSelectors', {
      $, ensureModelOption: optionMaker(sels['#modelSel']), applyChatDefaults: () => { defaults++; },
    });
    sync({ id: 'c1', modelSel: 'claude-pinned-old', permissionMode: 'default', effort: 'high' });
    assert.equal(sels['#modelSel'].value, 'claude-pinned-old');
    assert.deepEqual(sels['#modelSel'].options.map((o) => o.value), ['', 'eu.anthropic.claude-opus-5', 'claude-pinned-old']);
    assert.equal(sels['#modelSel'].options[2].textContent, '🧠 pinned-old');
    assert.deepEqual([sels['#permMode'].value, sels['#effortSel'].value], ['default', 'high']);
    sync({ modelSel: 'x' });                                      // unstarted, untouched → the global defaults
    assert.equal(defaults, 1);
    assert.match(SRC.chat, /\n\s*syncRunSelectors\(t\);\n\s*if \(typeof refreshDefaultsPin/, 'activateTab goes through it');
  });

  it('an explicit DROPDOWN pick after a typed /model wins — the next frame does not bring the typed one back', async () => {
    // Counter-check (browser, :8815): /model …opus-5[1m] typed, then the bare …opus-5 picked in the dropdown, then a
    // turn: the frame confirmed the OLDER typed wish and settleTypedModel put „…[1m]" back, persisted and all.
    const tab = { id: 'c1', model: 'claude-opus-5', modelSel: 'eu.anthropic.claude-opus-5-5',
      _modelPending: pending('eu.anthropic.claude-opus-5[1m]', true) };
    const MODELS_CACHE = { models: BEDROCK };
    const modelMenuKey = lift('chat', 'modelMenuKey', { ctxNormModel, ctxIsWide });
    const modelMenuValueFor = lift('chat', 'modelMenuValueFor', { MODELS_CACHE, ctxVariantKey, modelMenuKey });
    const live = lift('chat', 'applyLiveModel', {
      ACTIVE: tab, api: async () => ({}), modelResolves: (v) => (BEDROCK.find((m) => m.value === v) || {}).resolves || '',
      ctxForgetModel, ctxProbe: () => {}, updateCtxGauge: () => {}, refreshUltracodeState: () => {}, renderTabs: () => {},
      renderStatusBar: () => {}, toast: () => {}, tt: (k) => k, shortModel: SHORT,
      ctxModelFromRefusal: ctx.ctxModelFromRefusal, ctxVariantKey, modelMenuValueFor, persistTabsSoon: () => {},
      $: () => null, refreshDefaultsPin: () => {},
    });
    await live('eu.anthropic.claude-opus-5');
    assert.equal(tab.modelSel, 'eu.anthropic.claude-opus-5');
    assert.equal(tab._modelPending, null, 'the later, explicit pick replaced the unconfirmed typed wish');
    const { settle } = panel(BEDROCK, tab);
    assert.equal(settle(tab, 'claude-opus-5', 'frame'), '', 'so the next frame has nothing to confirm');
    assert.equal(tab.modelSel, 'eu.anthropic.claude-opus-5', 'and the dropdown pick stands');
    // …and the substitution path of a refused pick clears it the same way
    const sub = { id: 'c2', model: 'claude-opus-5', modelSel: 'eu.anthropic.claude-opus-5', _modelPending: pending('opus[1m]', true) };
    const refused = lift('chat', 'applyLiveModel', {
      ACTIVE: sub, api: async () => { throw new Error('Model "x" is restricted by your organization\'s settings. Using eu.anthropic.claude-opus-5-5 instead.'); },
      modelResolves: (v) => (BEDROCK.find((m) => m.value === v) || {}).resolves || '',
      ctxForgetModel, ctxProbe: () => {}, updateCtxGauge: () => {}, refreshUltracodeState: () => {}, renderTabs: () => {},
      renderStatusBar: () => {}, toast: () => {}, tt: (k) => k, shortModel: SHORT,
      ctxModelFromRefusal: ctx.ctxModelFromRefusal, ctxVariantKey, modelMenuValueFor, persistTabsSoon: () => {},
      $: () => null, refreshDefaultsPin: () => {},
    });
    await refused('eu.anthropic.claude-fable-9');
    assert.equal(sub.modelSel, 'eu.anthropic.claude-opus-5-5');
    assert.equal(sub._modelPending, null);
    // the two other places an explicit model pick lands (unstarted tab · scheduled restart) — call sites
    assert.match(SRC.chat, /ACTIVE\._modelPending = null; \/\/ an explicit pick wins over a typed one/);
    assert.match(SRC.chat, /if \(kind === 'model'\) t\._modelPending = null;/);
  });

  it('a RELOAD resumes the visible tab on ITS selection, not on the dropdown\'s defaults (_resumeDormantNow)', async () => {
    // Counter-check (browser-reload.js): the dormant tab is not `id || cfgTouched`, so activateTab painted the
    // global defaults into the selectors and startChat read the model from there — the session resumed on the
    // default model and the saved selection was overwritten with it. A selection taken over from a typed /model
    // did not survive a reload of the active tab either.
    const calls = [];
    const t = { pending: { sessionId: 's1', cwd: 'C:/x' }, modelSel: 'eu.anthropic.claude-opus-5', msgEl: { innerHTML: 'x', childElementCount: 0 } };
    const resume = lift('chat', '_resumeDormantNow', {
      SESSIONS: [{ id: 's1' }], loadSessions: async () => {}, sessionRefFor: (id, cwd) => ({ id, projectPath: cwd }),
      startChat: async (extra, tab) => { calls.push([extra, tab === t]); },
      renderResumeHistory: async () => {}, holdQueueAfterResume: () => {}, showResumeLoading: () => {}, hideResumeLoading: () => {},
      ACTIVE: t, setComposerEnabled: () => {}, el: () => ({}), toast: () => {}, tt: (k) => k,
    });
    await resume(t);
    assert.deepEqual(calls, [[{ resume: 's1', cwd: 'C:/x', model: 'eu.anthropic.claude-opus-5' }, true]],
      'the tab\'s own selection goes along as `extra`, which wins over the DOM');
    const d = { pending: { sessionId: 's2', cwd: 'C:/y' }, modelSel: '', msgEl: { innerHTML: '', childElementCount: 0 } };
    calls.length = 0;
    await resume(d);
    assert.equal(calls[0][0].model, undefined, '„Default" (the empty value) is sent as no model at all, like a start');
  });
});

describe('fake-claude.js — a typed /model switches the model the next turn names (and a restricted one does not)', () => {
  const FAKE = path.join(__dirname, '..', 'fake-claude.js');
  function session(model) {
    const p = spawn(process.execPath, [FAKE, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model],
      { stdio: ['pipe', 'pipe', 'pipe'], env: Object.assign({}, process.env, { FAKE_CLAUDE_SCENARIO: 'echo' }) });
    const frames = []; let buf = ''; const waiters = [];
    p.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        try { frames.push(JSON.parse(l)); } catch { /* */ }
        waiters.splice(0).forEach((w) => w());
      }
    });
    const until = (pred) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout; frames: ' + JSON.stringify(frames.map((f) => f.type)))), 5000);
      const check = () => { const f = frames.find(pred); if (f) { clearTimeout(t); res(f); } else waiters.push(check); };
      check();
    });
    const say = (text) => p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
    const ask = (id, request) => p.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n');
    return { p, frames, until, say, ask };
  }

  it('after „/model …opus-5-5[1m]" the next assistant frame names it, and the window follows; the /model itself has no model answer', async () => {
    const s = session('eu.anthropic.claude-opus-5');
    try {
      await s.until((f) => f.type === 'system' && f.subtype === 'init');
      s.say('/model eu.anthropic.claude-opus-5-5[1m]');
      const r1 = await s.until((f) => f.type === 'result');
      assert.match(r1.result, /Set model to `eu\.anthropic\.claude-opus-5-5\[1m\]`/);
      assert.equal(s.frames.filter((f) => f.type === 'assistant').length, 0, 'a local command: no model answers it');
      s.say('hallo');
      const a = await s.until((f) => f.type === 'assistant');
      assert.equal(ctxNormModel(a.message.model), 'claude-opus-5-5');
      s.ask('c1', { subtype: 'get_context_usage' });
      const cu = await s.until((f) => f.type === 'control_response' && f.response && f.response.request_id === 'c1');
      assert.equal(cu.response.response.maxTokens, 1000000);
    } finally { s.p.kill(); }
  });

  it('an alias resolves to a concrete id with its suffix; a restricted id is kept out', async () => {
    const s = session('eu.anthropic.claude-opus-5-5');
    try {
      await s.until((f) => f.type === 'system' && f.subtype === 'init');
      s.say('/model opus[1m]');
      await s.until((f) => f.type === 'result');
      s.say('eins');
      const a1 = await s.until((f) => f.type === 'assistant');
      assert.equal(a1.message.model, 'claude-opus-5[1m]');
      s.say('/model eu.anthropic.claude-restricted-9');
      await s.until((f) => f.type === 'result' && /Kept model as/.test(String(f.result)));
      s.say('zwei');
      await s.until((f) => f.type === 'assistant' && f !== a1);
      const last = s.frames.filter((f) => f.type === 'assistant').pop();
      assert.equal(last.message.model, 'claude-opus-5[1m]', 'the next turn still answers with the model before the refusal');
    } finally { s.p.kill(); }
  });
});
