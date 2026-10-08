'use strict';
// PR-6, round 2 — the Ultracode switch may not CLAIM a state the CLI never confirmed.
//
// Every test here pins one way the panel used to answer a question nobody had answered. The worst of them
// (H1) was new in PR-6 itself: a control request that times out resolves `{ok:true, unconfirmed:true}`, the
// route then had nothing to read, and `ultracodeState({})` happily returned a complete
// `{state:'off', available:true}` — so a session that fell SILENT was published to the browser as
// „🌀 Ultracode aus · dieses Modell könnte es", with a green toast. Four facts were invented at once.
//
// HOW the browser half is tested. public/js/chat.js and chat-status.js are browser scripts with no exports
// and no module boundary (they need the whole app's globals), so the functions under test are LIFTED OUT OF
// THE SOURCE BY NAME and run against fake globals — the same seam test/agent-lanes.test.js uses for
// chat-render.js. That way the shipped wiring is under test rather than a copy of it: if `applyLiveEffort`
// is renamed or reindented these tests fail loudly instead of quietly testing nothing.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CHAT_SRC = read('public/js/chat.js');
const STATUS_SRC = read('public/js/chat-status.js');
const UISKILLS_SRC = read('public/js/views-uiskills.js');
const SERVER_SRC = read('server.js');
const I18N_SRC = read('public/js/i18n.js');

// ---- the lifting seam -------------------------------------------------------------------------------
// A one-liner is matched as a line of its own; everything else runs to the first `}` in column 0, which in
// this codebase is only ever the end of a top-level function (a brace inside a string is always indented).
function liftFn(src, name, rel) {
  const one = new RegExp('^(?:async )?function ' + name + '\\(.*\\}[ \\t]*$', 'm');
  const multi = new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm');
  const m = one.exec(src) || multi.exec(src);
  assert.ok(m, name + '() not found in ' + rel + ' — renamed or reindented? Then these tests prove nothing.');
  return m[0];
}
function liftConst(src, name, rel) {
  const m = new RegExp('^const ' + name + ' = .*$', 'm').exec(src);
  assert.ok(m, 'const ' + name + ' not found in ' + rel);
  return m[0];
}
// Build one scope out of several lifted pieces, so the lifted functions can call each other exactly as they
// do in the browser. `env` supplies the app globals they reach for; anything missing throws at call time,
// which is itself a useful signal.
function bundle(pieces, names, env) {
  const keys = Object.keys(env);
  const body = pieces.join('\n') + '\nreturn { ' + names.join(', ') + ' };';
  return new Function(...keys, body)(...keys.map((k) => env[k]));
}
const CHAT_PIECES = {
  UC_UNKNOWN: () => liftConst(CHAT_SRC, 'UC_UNKNOWN', 'public/js/chat.js'),
  LIVE_EFFORT_LEVELS: () => liftConst(CHAT_SRC, 'LIVE_EFFORT_LEVELS', 'public/js/chat.js'),
};
function loadChat(names, env) {
  const pieces = names.map((n) => (CHAT_PIECES[n] ? CHAT_PIECES[n]() : liftFn(CHAT_SRC, n, 'public/js/chat.js')));
  return bundle(pieces, names, env);
}

// ---- fake app globals -------------------------------------------------------------------------------
// `tt` returns the KEY, so an assertion can name the string the UI picked without pinning its wording
// (the wording itself is guarded in test/i18n.test.js and at the bottom of this file).
const tt = (k) => k;
const fakeEl = (tag, cls, txt) => ({
  tag, className: cls || '', textContent: txt == null ? '' : txt, title: '', type: '',
  attrs: {}, children: [], hidden: false, onclick: null,
  appendChild(c) { this.children.push(c); return c; },
  setAttribute(k, v) { this.attrs[k] = v; },
  classList: {
    add() {}, remove() {}, contains() { return false; },
    toggle(cls, on) { this.last = [cls, on]; },
  },
  querySelector() { return null; },
});
function fakeSelect(values) {
  return { value: '', options: values.map((v) => ({ value: v, disabled: false, title: '', remove() {} })) };
}
// a recording api(): resolves with whatever `answer` yields for the url, and keeps every call
function fakeApi(answer) {
  const calls = [];
  const api = (url, opts) => { calls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null }); return Promise.resolve(answer(url, opts)); };
  api.calls = calls;
  return api;
}
function recorder() { const got = []; const f = (...a) => got.push(a); f.got = got; return f; }
const tick = () => new Promise((r) => setImmediate(r));

// a read-out that says something, and the three shapes that say nothing
const APPLIED_OFF = { state: 'off', active: false, requested: false, available: true, reason: '', model: 'eu.anthropic.claude-sonnet-5' };
const APPLIED_ON = { state: 'on', active: true, requested: true, available: true, reason: '', model: 'eu.anthropic.claude-sonnet-5' };

// =====================================================================================================
describe('H1 — a session that did not answer may not be published as „Ultracode aus"', () => {
  // the server half: ultracodeStateFor is what every ultracode-bearing route spreads into its response
  const { ultracodeState } = require('../lib/pure');
  const { ultracodeModelSupport } = require('../lib/models');
  const ultracodeStateFor = bundle(
    [liftFn(SERVER_SRC, 'ultracodeStateFor', 'server.js')], ['ultracodeStateFor'],
    { ultracodeState, ultracodeModelSupport },
  ).ultracodeStateFor;
  const CHAT = { meta: { model: 'eu.anthropic.claude-sonnet-5' } };

  it('the route does not SYNTHESISE a state out of a missing read-out', () => {
    const r = ultracodeStateFor(null, CHAT);
    assert.equal(r.ultracode.state, 'unknown', 'a timeout was published as „off" — that is H1');
    assert.notEqual(r.ultracode.available, true, '„available: true" is what made the chip add „dieses Modell könnte es"');
    assert.equal(r.ultracode.requested, null, 'false is an assertion about the session; null is the absence of one');
    assert.equal(r.ultracode.active, null);
    assert.equal(r.ultracode.reason, '', 'nothing was read, so there is nothing to explain');
    assert.equal(r.effort, null);
    // …and the one fact that survives a silence is still reported: WHICH session this is about
    assert.equal(r.ultracode.model, 'eu.anthropic.claude-sonnet-5', 'the model comes from the launch, not from the answer');
  });

  it('…and a real read-out still produces a real verdict (the branch must not swallow the normal case)', () => {
    const r = ultracodeStateFor({ model: 'eu.anthropic.claude-sonnet-5', effort: 'high', ultracode: true, ultracodeRequested: true, ultracodeAvailable: true }, CHAT);
    assert.equal(r.ultracode.state, 'on');
    assert.equal(r.effort, 'high');
  });

  // the browser half: the three adopters. All three did `t.ucState = r.ultracode || null`.
  // NOTE `ultracodeOn` is deliberately NOT in these bundles. The three adopters have no business reading the
  // browser's global preference (that is H2), so re-introducing it makes these tests blow up with a
  // ReferenceError rather than quietly pass — a second tripwire on the same wire.
  const env = () => ({
    tt, api: null, toast: recorder(), renderStatusBar: recorder(), ACTIVE: null,
    STATE: { prefs: { ultracode: false } }, LIVE_EFFORT_LEVELS: null, scheduleRunCfg: recorder(),
  });

  it('applyLiveUltracode: an unconfirmed answer is stored as UNKNOWN, and the toast says so', async () => {
    const t = { id: 'c1', effort: 'high' };
    const e = env();
    e.api = fakeApi(() => ({ ok: true, requested: true, unconfirmed: true, ultracode: { ...APPLIED_OFF }, effort: null }));
    e.ACTIVE = t;
    const fn = loadChat(['UC_UNKNOWN', 'ultracodeReadBack', 'adoptUltracodeState', 'ultracodeReasonText', 'applyLiveUltracode'], e);
    await fn.applyLiveUltracode(t, true);
    assert.equal(t.ucState.state, 'unknown', 'the response carried a fully-formed „off" and it must NOT be believed');
    assert.equal(t.effort, 'high', 'and the level that came with it may not overwrite what we know either');
    assert.deepEqual(e.toast.got.map((a) => a[1]), ['err'], 'a silence reported as a green „Ultracode aus" was the defect');
    assert.equal(e.toast.got[0][0], 'chat.ultracodeUnbestaetigt');
  });

  it('refreshUltracodeState: the same rule on the init read (GET …/settings)', async () => {
    const t = { id: 'c1', effort: 'high' };
    const e = env();
    e.api = fakeApi(() => ({ ok: true, unconfirmed: true, ultracode: { ...APPLIED_OFF }, effort: null }));
    e.LIVE_EFFORT_LEVELS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
    const fn = loadChat(['UC_UNKNOWN', 'ultracodeReadBack', 'adoptUltracodeState', 'refreshUltracodeState'], e);
    await fn.refreshUltracodeState(t);
    assert.equal(t.ucState.state, 'unknown');
    assert.equal(t.effort, 'high');
  });

  it('applyLiveEffort: the picked level stands, the chip says unbestätigt, the toast is not „ok"', async () => {
    const t = { id: 'c1', effort: 'low' };
    const e = env();
    e.ACTIVE = t;
    e.api = fakeApi(() => ({ ok: true, unconfirmed: true, requested: 'max', ultracode: { ...APPLIED_OFF }, effort: null }));
    const fn = loadChat(['UC_UNKNOWN', 'ultracodeReadBack', 'adoptUltracodeState', 'applyLiveEffort'], e);
    await fn.applyLiveEffort('max');
    assert.equal(t.ucState.state, 'unknown', 'r.ultracode was adopted unconditionally — three call sites, one bug');
    assert.equal(t.effort, 'max', 'nobody contradicted the request, so the optimistic value is the right one');
    assert.equal(e.toast.got[0][1], 'err');
    assert.match(e.toast.got[0][0], /effortUnbestaetigt/);
  });

  it('a REFUSED request is not a read-back either (server.js answers `refused`, see L2)', async () => {
    const t = { id: 'c1', effort: 'low' };
    const e = env();
    e.ACTIVE = t;
    e.api = fakeApi(() => ({ ok: true, refused: true, requested: 'max', ultracodeError: 'nope', ultracode: { state: 'unknown', active: null, requested: null, available: null, reason: '', model: 'm' }, effort: null }));
    const fn = loadChat(['UC_UNKNOWN', 'ultracodeReadBack', 'adoptUltracodeState', 'applyLiveEffort'], e);
    await fn.applyLiveEffort('max');
    assert.equal(t.ucState.state, 'unknown');
    assert.equal(e.toast.got[0][1], 'err');
  });

  it('…and a genuine read-back IS adopted, or the whole chip would be permanently „unbestätigt"', async () => {
    const t = { id: 'c1', effort: 'low' };
    const e = env();
    e.ACTIVE = t;
    e.api = fakeApi(() => ({ ok: true, unconfirmed: false, requested: 'max', ultracode: { ...APPLIED_ON }, effort: 'max' }));
    const fn = loadChat(['UC_UNKNOWN', 'ultracodeReadBack', 'adoptUltracodeState', 'applyLiveEffort'], e);
    await fn.applyLiveEffort('max');
    assert.equal(t.ucState.state, 'on');
    assert.equal(t.effort, 'max');
    assert.equal(e.toast.got[0][1], 'ok');
  });

  it('the CHIP for an unknown state is not the muted „aus" chip', () => {
    const e = {
      tt, el: fakeEl, STATE: { prefs: { ultracode: false } },
      ultracodeChipClick: recorder(), refreshUltracodeState: recorder(), persistTabs: recorder(),
      toast: recorder(), renderStatusBar: recorder(), applyLiveUltracode: recorder(),
    };
    const chatFns = loadChat(['UC_UNKNOWN', 'ultracodeGlobal', 'ultracodeOn', 'ultracodeView', 'ultracodeReasonText', 'ultracodeLabel'], e);
    const fn = bundle(
      [liftFn(STATUS_SRC, 'ultracodeChip', 'public/js/chat-status.js')], ['ultracodeChip'],
      { ...e, ultracodeView: chatFns.ultracodeView, ultracodeReasonText: chatFns.ultracodeReasonText },
    );
    const t = { id: 'c1', ucState: chatFns.UC_UNKNOWN };
    const v = chatFns.ultracodeView(t);
    assert.equal(v.chip, 'unknown', 'available:null read as „possible" and state:unknown read as „off"');
    const c = fn.ultracodeChip(t);
    assert.ok(c, 'an unknown state must still be visible — hiding it is the same lie, quieter');
    assert.ok(!/cs-ultra-off/.test(c.className), 'the muted „aus" look is reserved for a state somebody actually read');
    assert.match(c.className, /cs-ultra-wish/, 'an unread state is drawn like a wish — dashed, never muted and never solid');
    assert.match(c.textContent, /ultracodeUnbekanntKurz/, 'the label has to say it is unconfirmed');
    assert.match(c.title, /ultracodeUnbekanntTooltip/);
    assert.match(c.title, /ultracodeKlickNachfragen/, 'and offer the only action that helps: ask again');
    // the menu line, which is where a wrong word reads as a setting
    assert.equal(chatFns.ultracodeLabel(t), 'chat.ultracodeUnbekannt');
  });

  it('clicking the unknown chip RE-ASKS — it does not switch the session', async () => {
    const e = {
      tt, el: fakeEl, persistTabs: recorder(), toast: recorder(), renderStatusBar: recorder(),
      applyLiveUltracode: recorder(), refreshUltracodeState: recorder(),
    };
    const fn = bundle([liftFn(STATUS_SRC, 'ultracodeChipClick', 'public/js/chat-status.js')], ['ultracodeChipClick'], e);
    const t = { id: 'c1', ultracode: undefined };
    await fn.ultracodeChipClick(t, { chip: 'unknown' });
    assert.equal(e.refreshUltracodeState.got.length, 1, 'the only useful action on „I do not know" is to ask again');
    assert.equal(e.applyLiveUltracode.got.length, 0, 'toggling from an unknown state is a real change made on a guess');
    assert.equal(t.ultracode, undefined, 'and the stored wish is not touched by it');
    // the counter-test: an ordinary off chip still toggles
    await fn.ultracodeChipClick(t, { chip: 'off' });
    assert.equal(t.ultracode, true);
    assert.equal(e.applyLiveUltracode.got.length, 1);
  });
});

// =====================================================================================================
describe('H2 — the effort switch carries the SESSION\'s wish, not the browser\'s global preference', () => {
  it('applyLiveEffort sends no `ultracode` field at all', async () => {
    const t = { id: 'c1', effort: 'low', ultracode: undefined };   // the tab never chose: it inherits
    const e = {
      tt, ACTIVE: t, toast: recorder(), renderStatusBar: recorder(), scheduleRunCfg: recorder(),
      STATE: { prefs: { ultracode: false } },                      // …and the global switch is OFF
      api: fakeApi(() => ({ ok: true, unconfirmed: false, requested: 'max', ultracode: { ...APPLIED_ON }, effort: 'max' })),
    };
    const fn = loadChat(['UC_UNKNOWN', 'ultracodeGlobal', 'ultracodeOn', 'ultracodeReadBack', 'adoptUltracodeState', 'applyLiveEffort'], e);
    await fn.applyLiveEffort('max');
    assert.equal(e.api.calls.length, 1);
    const body = e.api.calls[0].body;
    assert.equal(body.effort, 'max');
    assert.ok(!('ultracode' in body), 'sending ultracodeOn(t) let a stale tab\'s GLOBAL preference switch a running session off');
    // and the session's answer is still what lands on the tab
    assert.equal(t.ucState.state, 'on');
  });

  it('the server keeps re-asserting its own wish when the field is absent', () => {
    // the other half of the same contract, pinned where it lives (POST /api/chat/:id/effort). The
    // behaviour itself is covered in test/chatargs.test.js („the wish comes from chat.meta.ultracodeWish
    // when the caller sends none") — this guards the route that has to PASS undefined for that to happen.
    const line = SERVER_SRC.split(/\r?\n/).find((l) => /const wish =/.test(l) && /body\.ultracode/.test(l));
    assert.ok(line, 'the effort route no longer derives `wish` from the body — did the contract move?');
    assert.match(line, /:\s*undefined/, 'an absent field must travel as undefined, which is „keep the session\'s wish"');
  });
});

// =====================================================================================================
describe('M1 — for a RUNNING session the wish is the session\'s, not the tab\'s', () => {
  const view = (t, globalPref) => loadChat(['ultracodeGlobal', 'ultracodeOn', 'ultracodeView'], {
    tt, STATE: { prefs: { ultracode: globalPref } },
  }).ultracodeView(t);

  it('a global preference may not invent a request the session never made', () => {
    // Haiku: ultracode is not available. The session requested nothing. The tab inherits, and the global
    // switch is ON — so the browser's answer to „was it requested?" is yes, and the chip then warned about
    // a request that does not exist.
    const t = { id: 'c1', ultracode: undefined, ucState: { state: 'off', active: false, requested: false, available: false, reason: '', model: 'claude-haiku-4-5' } };
    const v = view(t, true);
    assert.equal(v.wish, false, 'the session is where the wish lives once there is a session');
    assert.equal(v.chip, 'none', '„angefordert, wirkt nicht" about a request nobody made is the lie this fixes');
  });

  it('…and it may not HIDE one the session did make', () => {
    const t = { id: 'c1', ultracode: false, ucState: { state: 'ineffective', active: false, requested: true, available: false, reason: 'model', model: 'claude-haiku-4-5' } };
    const v = view(t, false);
    assert.equal(v.wish, true, 'the tab says off, the session says it asked — the session wins');
    assert.equal(v.chip, 'ineffective');
  });

  it('before a start the tab (and its global fallback) is still the only answer there is', () => {
    const t = { modelSel: '' };
    assert.equal(view(t, true).wish, true, 'nothing is running, so the stored wish is what the next start will do');
    assert.equal(view(t, true).running, false);
  });
});

// =====================================================================================================
describe('M2 — the forecast is fetched on the DEFAULT path, and „unknown" says so', () => {
  function setup(answer) {
    const sel = fakeSelect(['', 'low', 'medium', 'high', 'xhigh', 'max']);
    const t = { modelSel: '' };
    const e = {
      tt, ACTIVE: t, renderStatusBar: recorder(), api: fakeApi(answer),
      $: (s) => (s === '#effortSel' ? sel : null),
    };
    const fn = loadChat(['fetchUltracodeSupport', 'applyEffortLevelsForModel'], e);
    return { fn, t, e, sel };
  }

  it('a fresh tab on the default model asks for the forecast', async () => {
    const { fn, t, e, sel } = setup(() => ({ model: '', supported: true, source: 'cli', effortLevels: ['low', 'medium', 'high'], effortLevelsKnown: true }));
    fn.applyEffortLevelsForModel();
    assert.equal(e.api.calls.length, 1, 'it was asked only on a model CHANGE, so the normal case never asked at all');
    assert.match(e.api.calls[0].url, /^\/api\/ultracode\/support\?model=/);
    await tick(); await tick();
    assert.equal(t._ucSupport.levelsKnown, true);
    assert.deepEqual(sel.options.filter((o) => o.disabled).map((o) => o.value), ['xhigh', 'max'],
      'the answer has to repaint the picker it just arrived for');
    assert.ok(e.renderStatusBar.got.length >= 1, '…and the strip, which drew its chip while nothing was known');
  });

  it('it asks ONCE — the lazy probe may not fire on every repaint', async () => {
    const { fn, e } = setup(() => ({ model: '', supported: true, source: 'cli', effortLevels: [], effortLevelsKnown: false }));
    fn.applyEffortLevelsForModel();
    fn.applyEffortLevelsForModel();
    await tick(); await tick();
    fn.applyEffortLevelsForModel();
    assert.equal(e.api.calls.length, 1, 'a probe that can spawn claude.exe must not run on every render');
  });

  it('while the forecast is missing the muted chip admits it has not been checked', () => {
    const e = { tt, STATE: { prefs: { ultracode: false } } };
    const fn = loadChat(['ultracodeGlobal', 'ultracodeOn', 'ultracodeView'], e);
    const unchecked = fn.ultracodeView({ modelSel: 'eu.anthropic.claude-sonnet-5' });
    assert.equal(unchecked.chip, 'off');
    assert.equal(unchecked.canDoKnown, false, '„dieses Modell könnte es" was promised about a model nobody had asked about');
    const checked = fn.ultracodeView({ modelSel: 'x', _ucSupport: { model: 'x', supported: true, effortLevels: [], levelsKnown: true } });
    assert.equal(checked.canDoKnown, true);
    // and the chip picks its tooltip off exactly that flag
    assert.match(STATUS_SRC, /canDoKnown \? tt\('chat-status\.ultracodeAusTooltip'\)/,
      'the „could do it" promise must be gated on the forecast having answered');
  });
});

// =====================================================================================================
describe('M3 — „no effort levels" and „nobody checked" are two different facts', () => {
  const load = () => loadChat(['effortLevelNotInModel', 'applyEffortLevelsForModel', 'fetchUltracodeSupport'], {
    tt, ACTIVE: null, renderStatusBar: recorder(), api: fakeApi(() => ({})), $: () => null,
  });

  it('a model the CLI listed WITHOUT levels makes the picked level a silent no-op, and the strip says so', () => {
    const { effortLevelNotInModel } = load();
    const haiku = { id: 'c1', effort: 'high', _ucSupport: { model: 'claude-haiku-4-5', supported: false, effortLevels: [], levelsKnown: true } };
    assert.equal(effortLevelNotInModel(haiku), 'high', '[] meant „do not filter" for both facts, so this warning never appeared');
  });

  it('…while an unchecked model stays silent (a warning nobody verified is worse than none)', () => {
    const { effortLevelNotInModel } = load();
    const unchecked = { id: 'c1', effort: 'high', _ucSupport: { model: 'x', supported: true, effortLevels: [], levelsKnown: false } };
    assert.equal(effortLevelNotInModel(unchecked), '');
    assert.equal(effortLevelNotInModel({ id: 'c1', effort: 'high' }), '', 'and no probe at all is also „unchecked"');
    // „auto" is the absence of a level, so it is never wrong
    assert.equal(effortLevelNotInModel({ id: 'c1', effort: '', _ucSupport: { model: 'h', effortLevels: [], levelsKnown: true } }), '');
  });

  it('the DROPDOWN keeps conflating them on purpose — an empty picker is a dead end', async () => {
    const sel = fakeSelect(['', 'low', 'high']);
    const t = { modelSel: 'h', _ucSupport: { model: 'claude-haiku-4-5', supported: false, effortLevels: [], levelsKnown: true }, _ucSupportWant: 'h' };
    const fn = loadChat(['fetchUltracodeSupport', 'applyEffortLevelsForModel'], {
      tt, ACTIVE: t, renderStatusBar: recorder(), api: fakeApi(() => ({})), $: (s) => (s === '#effortSel' ? sel : null),
    });
    fn.applyEffortLevelsForModel();
    assert.deepEqual(sel.options.filter((o) => o.disabled).map((o) => o.value), [],
      'honestly disabling every level would leave a picker the user cannot argue with');
  });

  it('the route states the fact the empty array cannot carry', () => {
    // `source === 'cli'` IS „the CLI\'s own list had an entry for this model", which is exactly the
    // question an empty effortLevels cannot answer. Pinned against the measured fixture shape.
    const { ultracodeModelSupport, modelEffortLevels } = require('../lib/models');
    const CLI = [
      { value: 'default', resolvedModel: 'eu.anthropic.claude-sonnet-5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'haiku', resolvedModel: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0', displayName: 'Haiku 4.5' },
    ];
    assert.equal(ultracodeModelSupport(CLI, 'haiku').source, 'cli', 'the CLI listed it…');
    assert.deepEqual(modelEffortLevels(CLI, 'haiku'), [], '…and said it has no levels: known AND empty');
    assert.equal(ultracodeModelSupport(null, 'eu.anthropic.claude-sonnet-5').source, 'unknown', 'no probe → nobody checked');
    assert.deepEqual(modelEffortLevels(null, 'eu.anthropic.claude-sonnet-5'), [], '…and the same [] comes back');
    assert.match(SERVER_SRC, /effortLevelsKnown: sup\.source === 'cli'/, 'the route has to SHIP the distinction');
  });
});

// =====================================================================================================
describe('M4 — the init read-back may not overwrite a level we know with one we do not', () => {
  const run = async (effort) => {
    const t = { id: 'c1', effort: 'high' };
    const e = {
      tt, ACTIVE: t, renderStatusBar: recorder(),
      LIVE_EFFORT_LEVELS: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
      api: fakeApi(() => ({ ok: true, unconfirmed: false, ultracode: { ...APPLIED_ON }, effort })),
    };
    const fn = loadChat(['UC_UNKNOWN', 'ultracodeReadBack', 'adoptUltracodeState', 'refreshUltracodeState'], e);
    await fn.refreshUltracodeState(t);
    return t;
  };

  it('a null level right after a spawn does not turn „--effort high" into „auto"', async () => {
    // UNMEASURED FACT: nobody has checked what applied.effort reports in the moments after a spawn, and
    // refreshUltracodeState runs on every `init`. An ambiguous answer may not overwrite the launch flag.
    const t = await run(null);
    assert.equal(t.effort, 'high', 'the unconditional overwrite rested on a CLI fact nobody has measured');
    assert.equal(t.ucState.state, 'on', '…while the ultracode half of the SAME read-out is still adopted');
  });

  it('a plausible level IS adopted — a resumed tab must stop reporting what it was launched with', async () => {
    assert.equal((await run('low')).effort, 'low');
  });

  it('a level the panel does not know is ignored rather than displayed', async () => {
    assert.equal((await run('ultrathink')).effort, 'high');
  });

  it('…and the comment says the underlying fact is unmeasured, so the next reader knows', () => {
    const fn = liftFn(CHAT_SRC, 'refreshUltracodeState', 'public/js/chat.js');
    const where = CHAT_SRC.indexOf(fn);
    const near = CHAT_SRC.slice(Math.max(0, where - 1200), where + fn.length);
    assert.match(near, /UNMEASURED/, 'a guard whose reason is not written down is removed by the next reader');
  });
});

// =====================================================================================================
describe('M5 — the schedule warning names the cap that will REALLY apply', () => {
  const { headlessPermissionMode, HEADLESS_PERM_MODES } = require('../lib/pure');
  const { schedEffectivePermMode } = bundle(
    [liftFn(UISKILLS_SRC, 'schedEffectivePermMode', 'public/js/views-uiskills.js')], ['schedEffectivePermMode'], {},
  );

  it('the browser mirror agrees with lib/pure headlessPermissionMode over the whole matrix', () => {
    const wants = [undefined, '', 'plan', 'acceptEdits', 'default', 'manual', 'bypassPermissions', 'auto', 'dontAsk', 'quatsch'];
    for (const want of wants) {
      for (const dryRun of [true, false]) {
        for (const allowWrites of [true, false]) {
          const real = headlessPermissionMode(want, { dryRun, allowWrites }).mode;
          const mirror = schedEffectivePermMode(want, HEADLESS_PERM_MODES, { dryRun, allowWrites });
          assert.equal(mirror, real, 'mirror drifted for ' + JSON.stringify({ want, dryRun, allowWrites }));
        }
      }
    }
  });

  it('the COMMON case is „plan", which is not the cap the old warning described', () => {
    // headlessPermissionMode\'s FIRST branch is `dryRun || !allowWrites → plan`, and both are the panel\'s
    // defaults — so the line that said „capped to acceptEdits" was wrong for every ordinary schedule.
    assert.equal(schedEffectivePermMode('bypassPermissions', HEADLESS_PERM_MODES, { dryRun: true, allowWrites: false }), 'plan');
    assert.equal(schedEffectivePermMode('bypassPermissions', HEADLESS_PERM_MODES, { dryRun: false, allowWrites: false }), 'plan');
    // …and only a WRITING run reaches the mode check, where the cap really is acceptEdits
    assert.equal(schedEffectivePermMode('bypassPermissions', HEADLESS_PERM_MODES, { dryRun: false, allowWrites: true }), 'acceptEdits');
    assert.equal(schedEffectivePermMode('manual', HEADLESS_PERM_MODES, { dryRun: false, allowWrites: true }), 'manual', 'an allowed mode is not capped');
    assert.equal(schedEffectivePermMode('plan', null, { dryRun: false, allowWrites: true }), '', 'no allowed list → claim nothing');
  });

  it('the panel hands the mirror the manifest value RAW (no `|| \'plan\'`)', () => {
    // headlessPermissionMode defaults an ABSENT request to acceptEdits. A `|| 'plan'` at the call site made
    // the mirror answer „plan" where the real writing run gets acceptEdits — the same lie one layer down.
    const m = /const wantMode = \(m\.run && m\.run\.permissionMode\)([^\n;]*);/.exec(UISKILLS_SRC);
    assert.ok(m, 'the schedule panel no longer computes wantMode where this test looks');
    assert.doesNotMatch(m[1], /\|\|\s*'plan'/, 'that default is a mirror of nothing');
  });

  it('the warning is recomputed when the switches that decide it change', () => {
    assert.match(UISKILLS_SRC, /dryRun = v;\s*syncPermWarn\(\)/, 'the test-run checkbox decides the cap, so it must repaint the line');
    const writes = UISKILLS_SRC.slice(UISKILLS_SRC.indexOf('allowWrites = v;'));
    assert.match(writes.slice(0, 200), /syncPermWarn\(\)/, 'so does „writes allowed"');
  });

  it('…and the string has a slot for the mode that will really run', () => {
    for (const loc of ['de', 'en']) {
      const re = new RegExp("'views-uiskills\\.permModusGedeckelt': '([^']*)'");
      const block = i18nBlock(loc);
      const m = re.exec(block);
      assert.ok(m, loc + '.views-uiskills.permModusGedeckelt is missing');
      assert.match(m[1], /\{m\}/, loc + ': the mode the skill asked for');
      assert.match(m[1], /\{e\}/, loc + ': …and the one it will really get — the old text named a fixed cap');
    }
  });
});

// =====================================================================================================
describe('L1 — a switch that FAILED does not leave the wish changed', () => {
  const { setChatUltracode, setChatEffort } = require('../lib/chat');
  // stdin gone: controlRequest resolves {ok:false,'process not running'} before anything is written
  const deadChat = (meta) => ({ meta: Object.assign({ effort: null, model: 'sonnet-5', ultracode: false, ultracodeWish: false }, meta), pendingControls: new Map(), proc: { stdin: { writable: false } } });
  // alive, but the session REFUSES the request
  const refusingChat = (meta) => {
    const chat = { meta: Object.assign({ effort: null, model: 'sonnet-5', ultracode: false, ultracodeWish: false }, meta), pendingControls: new Map() };
    chat.proc = { stdin: { writable: true, write(line) {
      const obj = JSON.parse(line);
      const w = chat.pendingControls.get(obj.request_id);
      if (w) setImmediate(() => w({ subtype: 'error', request_id: obj.request_id, error: 'ultracode is not available for this model' }));
      return true;
    } } };
    return chat;
  };

  it('setChatUltracode rolls the wish back when the request never reached the process', async () => {
    const c = deadChat({ ultracodeWish: false });
    const r = await setChatUltracode(c, true);
    assert.equal(r.ok, false);
    assert.equal(c.meta.ultracodeWish, false, 'a wish the user never got would be re-asserted by the next effort change');
  });

  it('…and when the session refuses it', async () => {
    const c = refusingChat({ ultracodeWish: false });
    const r = await setChatUltracode(c, true);
    assert.equal(r.ok, false);
    assert.equal(c.meta.ultracodeWish, false);
  });

  it('setChatEffort rolls back too — a failed effort change may not drop a standing wish', async () => {
    const c = deadChat({ ultracodeWish: true });
    const r = await setChatEffort(c, 'high', false);
    assert.equal(r.ok, false);
    assert.equal(c.meta.ultracodeWish, true, 'nothing was applied, so nothing may be remembered');
  });

  it('…while a SUCCESSFUL switch still records the wish (the counter-test)', async () => {
    const chat = { meta: { effort: null, model: 'sonnet-5', ultracode: false, ultracodeWish: false }, pendingControls: new Map() };
    chat.proc = { stdin: { writable: true, write(line) {
      const obj = JSON.parse(line);
      const w = chat.pendingControls.get(obj.request_id);
      if (!w) return true;
      setImmediate(() => w(obj.request.subtype === 'get_settings'
        ? { subtype: 'success', request_id: obj.request_id, response: { applied: { model: 'sonnet-5', effort: null, ultracode: true, ultracodeRequested: true, ultracodeAvailable: true } } }
        : { subtype: 'success', request_id: obj.request_id }));
      return true;
    } } };
    assert.equal((await setChatUltracode(chat, true)).ok, true);
    assert.equal(chat.meta.ultracodeWish, true);
  });
});

// =====================================================================================================
describe('L2 — a refusal is not an „unconfirmed"', () => {
  it('the ultracode-refusal branch of POST …/effort says `refused`', () => {
    const line = SERVER_SRC.split(/\r?\n/).find((l) => /ultracodeError:/.test(l) && /sendJson/.test(l));
    assert.ok(line, 'the speculative ultracode-refusal branch is gone or reshaped');
    assert.match(line, /refused: true/, 'somebody answered, and what they said was „no"');
    assert.doesNotMatch(line, /unconfirmed: true/, '„unconfirmed" told the client the opposite of what happened');
    assert.match(line, /ultracodeStateFor\(null, chat\)/, 'and the resulting state really is unread — H1 makes that „unknown"');
  });
});

// =====================================================================================================
describe('L3 — the un-awaited probe repaints what it just changed', () => {
  it('editTabUltracode\'s forecast callback re-runs the level filter and the status strip', async () => {
    const t = { modelSel: '' };                           // no id → the pre-start forecast path
    const e = {
      tt, el: fakeEl, ACTIVE: t,
      document: { contains: () => false },                // the dialog is gone by the time it lands
      api: fakeApi(() => ({ model: '', supported: true, source: 'cli', effortLevels: ['low'], effortLevelsKnown: true })),
      uiModal: () => Promise.resolve(false),               // cancelled → nothing is saved
      applyEffortLevelsForModel: recorder(), renderStatusBar: recorder(),
      persistTabs: recorder(), toast: recorder(), applyLiveUltracode: recorder(),
      STATE: { prefs: { ultracode: false } },
    };
    const fn = loadChat(['ultracodeGlobal', 'ultracodeOn', 'ultracodeView', 'ultracodeReasonText', 'fetchUltracodeSupport', 'editTabUltracode'], e);
    await fn.editTabUltracode(t);
    await tick(); await tick();
    assert.equal(e.applyEffortLevelsForModel.got.length, 1, 'the probe just decided which levels are offered');
    assert.ok(e.renderStatusBar.got.length >= 1, '…and which chip the strip should draw');
  });
});

// =====================================================================================================
// the wording, in both locales. The parity/duplicate/dead-key guards live in test/i18n.test.js; what is
// checked here is that the new state has words of its OWN and does not borrow the „aus" ones.
function i18nBlock(loc) {
  const lines = I18N_SRC.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp('^  ' + loc + ': \\{').test(l));
  assert.ok(start >= 0, 'locale block ' + loc + ' not found');
  const next = lines.findIndex((l, i) => i > start && /^  [a-z]{2}: \{/.test(l));
  return lines.slice(start, next < 0 ? lines.length : next).join('\n');
}
describe('the unknown state has words of its own (de + en)', () => {
  const KEYS = [
    'chat.ultracodeUnbekannt', 'chat.ultracodeUnbekanntHinweis', 'chat.ultracodeUnbestaetigt',
    'chat-status.ultracodeUnbekanntKurz', 'chat-status.ultracodeUnbekanntTooltip',
    'chat-status.ultracodeKlickNachfragen', 'chat-status.ultracodeAusUngeprueftTooltip',
  ];
  const val = (block, key) => {
    const m = new RegExp("'" + key.replace('.', '\\.') + "': '((?:[^'\\\\]|\\\\.)*)'").exec(block);
    return m ? m[1] : null;
  };

  it('every new string exists in both locales', () => {
    for (const loc of ['de', 'en']) {
      const block = i18nBlock(loc);
      for (const k of KEYS) assert.ok(val(block, k), loc + '.' + k + ' is missing');
    }
  });

  it('„unbestätigt" is not the same word as „aus" — that equivalence IS the defect', () => {
    for (const loc of ['de', 'en']) {
      const block = i18nBlock(loc);
      assert.notEqual(val(block, 'chat-status.ultracodeUnbekanntKurz'), val(block, 'chat-status.ultracodeAusKurz'), loc);
      assert.notEqual(val(block, 'chat-status.ultracodeUnbekanntTooltip'), val(block, 'chat-status.ultracodeAusTooltip'), loc);
      assert.notEqual(val(block, 'chat-status.ultracodeAusUngeprueftTooltip'), val(block, 'chat-status.ultracodeAusTooltip'), loc);
      // and it says so out loud, rather than leaving the reader to infer it
      assert.match(val(block, 'chat-status.ultracodeUnbekanntTooltip'), /(nicht dasselbe|not the same)/i, loc);
    }
  });
});
