'use strict';
// Zero-dependency unit tests for the shared UI-skill prompt composer, ../public/js/ui-skill-prompt.js.
// Moved here from test/pure.test.js when the composer left lib/pure.js — every assertion from there is
// still below, unchanged in meaning, plus the three things the move exists for:
//   1) the Ja/Yes drift: no `labels` → 'Ja', in any host language. That is what a scheduled run sends.
//   2) the display path may localise, and only when it asks.
//   3) ONE implementation: this file must work in Node AND as a classic browser script, and neither
//      lib/pure.js nor views-uiskills.js may carry a second copy again.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  uiFlattenOptions, uiRenderInputValue, uiExcludedValue, uiInterpolate, uiComposePrompt,
} = require('../public/js/ui-skill-prompt');

const SRC_FILE = path.join(__dirname, '..', 'public', 'js', 'ui-skill-prompt.js');

// ---------------------------------------------------------------- uiFlattenOptions
test('uiFlattenOptions: flattens parents and children, defaulting label to value', () => {
  const input = { options: [{ value: 'a', label: 'A' }, { value: 'b', children: [{ value: 'b1' }] }] };
  assert.deepEqual(uiFlattenOptions(input), [
    { value: 'a', label: 'A' }, { value: 'b', label: 'b' }, { value: 'b1', label: 'b1' },
  ]);
});

// ---------------------------------------------------------------- uiRenderInputValue
test('uiRenderInputValue: booleans, selects, trees, tags', () => {
  assert.equal(uiRenderInputValue({ type: 'checkbox' }, true), 'Ja');
  assert.equal(uiRenderInputValue({ type: 'yesno' }, false), 'Nein');
  assert.equal(uiRenderInputValue({ type: 'select', options: [{ value: 'x', label: 'Xi' }] }, 'x'), 'Xi');
  assert.equal(uiRenderInputValue({ type: 'select', options: [] }, 'unknown'), 'unknown');
  assert.equal(uiRenderInputValue({ type: 'tree', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }, ['a', 'b']), 'A, B');
  assert.equal(uiRenderInputValue({ type: 'tags' }, ['t1', 't2']), 't1, t2');
  assert.equal(uiRenderInputValue({ type: 'text' }, null), '');
  assert.equal(uiRenderInputValue({ type: 'text' }, 42), '42');
});

// THE drift, pinned. Before the merge the panel ran this through t('chat-render.ja'), so the same skill
// composed „Nur wenn Yes" on an English panel and „Nur wenn Ja" from the scheduler — one promptTemplate,
// two different questions to the model. With no labels argument the answer is German, full stop.
test('uiRenderInputValue: with NO labels the boolean is always German — the prompt is not localised', () => {
  assert.equal(uiRenderInputValue({ type: 'yesno' }, true), 'Ja');
  assert.equal(uiRenderInputValue({ type: 'yesno' }, false), 'Nein');
  assert.equal(uiRenderInputValue({ type: 'checkbox' }, true, undefined), 'Ja');
  assert.equal(uiRenderInputValue({ type: 'checkbox' }, false, null), 'Nein');
  // a labels object that carries nothing usable falls back to German too, it does not render ''
  assert.equal(uiRenderInputValue({ type: 'yesno' }, true, {}), 'Ja');
  assert.equal(uiRenderInputValue({ type: 'yesno' }, false, { yes: 'Yes' }), 'Nein');
});

test('uiRenderInputValue: a DISPLAY caller gets the localised word, but only when it asks', () => {
  assert.equal(uiRenderInputValue({ type: 'checkbox' }, true, { yes: 'Yes', no: 'No' }), 'Yes');
  assert.equal(uiRenderInputValue({ type: 'yesno' }, false, { yes: 'Yes', no: 'No' }), 'No');
  // labels never touch the other types — those labels come from the manifest, authored per skill
  assert.equal(uiRenderInputValue({ type: 'tags' }, ['a'], { yes: 'Yes', no: 'No' }), 'a');
  assert.equal(uiRenderInputValue({ type: 'select', options: [{ value: 'x', label: 'Xi' }] }, 'x', { yes: 'Yes', no: 'No' }), 'Xi');
});

// ---------------------------------------------------------------- uiExcludedValue
test('uiExcludedValue: returns unselected option labels for tree/multiselect only', () => {
  const input = { type: 'multiselect', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }] };
  assert.equal(uiExcludedValue(input, ['a']), 'B, C');
  assert.equal(uiExcludedValue({ type: 'text' }, ['a']), '');
});

// ---------------------------------------------------------------- uiInterpolate
test('uiInterpolate: substitutes {{id}} from values via the manifest', () => {
  const manifest = { inputs: [{ id: 'name', type: 'text' }, { id: 'ok', type: 'yesno' }] };
  assert.equal(uiInterpolate('Hi {{name}} ({{ok}})', manifest, { name: 'Ada', ok: true }), 'Hi Ada (Ja)');
});

test('uiInterpolate: unknown placeholders render empty; .excluded modifier works', () => {
  const manifest = { inputs: [{ id: 'sel', type: 'multiselect', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }] };
  assert.equal(uiInterpolate('{{missing}}', manifest, {}), '');
  assert.equal(uiInterpolate('{{sel}} | {{sel.excluded}}', manifest, { sel: ['a'] }), 'A | B');
});

test('uiInterpolate: {{#autoRun}}...{{/autoRun}} block is kept only when opts.autoRun', () => {
  const manifest = { inputs: [] };
  assert.equal(uiInterpolate('x{{#autoRun}} GO{{/autoRun}}', manifest, {}, { autoRun: true }), 'x GO');
  assert.equal(uiInterpolate('x{{#autoRun}} GO{{/autoRun}}', manifest, {}, { autoRun: false }), 'x');
});

test('uiInterpolate: opts.labels reaches the boolean and nothing else does', () => {
  const manifest = { inputs: [{ id: 'ok', type: 'yesno' }] };
  assert.equal(uiInterpolate('{{ok}}', manifest, { ok: false }, { labels: { no: 'No' } }), 'No');
  assert.equal(uiInterpolate('{{ok}}', manifest, { ok: true }, { labels: { yes: 'Yes', no: 'No' } }), 'Yes');
  assert.equal(uiInterpolate('{{ok}}', manifest, { ok: true }, { autoRun: true }), 'Ja', 'other opts do not localise');
});

// ---------------------------------------------------------------- uiComposePrompt
test('uiComposePrompt: uses promptTemplate when present', () => {
  const skill = { name: 's', manifest: { promptTemplate: '/do {{thing}}', inputs: [{ id: 'thing', type: 'text' }] } };
  assert.equal(uiComposePrompt(skill, { thing: 'it' }), '/do it');
});

test('uiComposePrompt: falls back to /<name> <firstField> when no template', () => {
  const skill = { name: 'mytask', manifest: { inputs: [{ id: 'arg', type: 'text' }] } };
  assert.equal(uiComposePrompt(skill, { arg: 'value' }), '/mytask value');
  const noFields = { name: 'bare', manifest: { inputs: [] } };
  assert.equal(uiComposePrompt(noFields, {}), '/bare');
});

// ---------------------------------------------------------------- one implementation, two hosts
// Loaded as a CLASSIC SCRIPT, the way index.html loads it: no module/exports/require in scope, the five
// functions have to land on the global object. An IIFE wrapper, an ESM `export`, or a stray `require`
// would all keep the Node side green and silently break every panel that loads this file.
function loadAsClassicScript(extraGlobals) {
  const ctx = Object.assign({ console }, extraGlobals || {});
  vm.createContext(ctx);
  new vm.Script(fs.readFileSync(SRC_FILE, 'utf8'), { filename: 'ui-skill-prompt.js' }).runInContext(ctx);
  return ctx;
}

test('the module works as a classic browser script: the five globals are defined', () => {
  const g = loadAsClassicScript();
  for (const n of ['uiFlattenOptions', 'uiRenderInputValue', 'uiExcludedValue', 'uiInterpolate', 'uiComposePrompt']) {
    assert.equal(typeof g[n], 'function', n + ' must be a global for the classic-script host');
  }
  assert.equal(g.module, undefined, 'the file must not need a module object to load');
});

// The bug, stated as the invariant it violated: server and client must compose the SAME prompt from the
// same inputs. The "client" here is the real file in a browser-shaped context that ALSO has an English
// t() in scope — which is exactly the situation that produced 'Yes': if anything inside ever reaches for
// i18n again, the two sides diverge and this fails.
test('client and server compose byte-identical prompts — also with an English t() in scope and LANG=en', () => {
  const skill = {
    name: 'sync',
    manifest: {
      promptTemplate: 'Lauf {{titel}}: PDF anhängen = {{pdf}}, Werke = {{werke}} (ohne {{werke.excluded}}){{#autoRun}} AUTO{{/autoRun}}',
      inputs: [
        { id: 'titel', type: 'text' },
        { id: 'pdf', type: 'yesno' },
        { id: 'werke', type: 'multiselect', options: [{ value: 'w1', label: 'Werk 1' }, { value: 'w2', label: 'Werk 2' }] },
      ],
    },
  };
  const values = { titel: 'Q4', pdf: true, werke: ['w1'] };
  const langBefore = process.env.LANG;
  process.env.LANG = 'en';
  try {
    const english = { t: () => 'Yes', tt: () => 'Yes', I18N: { lang: 'en' }, navigator: { language: 'en-GB' } };
    const client = loadAsClassicScript(english);
    for (const opts of [{}, { autoRun: true }]) {
      const fromClient = client.uiComposePrompt(skill, values, opts);
      const fromServer = uiComposePrompt(skill, values, opts);
      assert.equal(fromClient, fromServer, 'client and server prompt differ for opts ' + JSON.stringify(opts));
      assert.match(fromServer, /PDF anhängen = Ja/, 'the prompt stays German next to the German template');
      assert.doesNotMatch(fromServer, /Yes/, 'an English panel must not leak into the prompt');
    }
  } finally { if (langBefore === undefined) delete process.env.LANG; else process.env.LANG = langBefore; }
});

// …and there must be no SECOND implementation to drift against. Read as text on purpose: both copies
// parsed fine for months, which is precisely why nobody noticed they had grown apart.
test('neither lib/pure.js nor views-uiskills.js carries a second copy of the composer', () => {
  const names = ['FlattenOptions', 'RenderInputValue', 'ExcludedValue', 'Interpolate', 'ComposePrompt'];
  for (const rel of ['lib/pure.js', 'public/js/views-uiskills.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    for (const n of names) {
      const re = new RegExp('^\\s*(?:function|const|let|var)\\s+(?:ui)?' + n + '\\b', 'm');
      assert.ok(!re.test(src), rel + ' defines ' + n + ' again — one implementation, or they drift');
    }
  }
  // lib/pure.js must not re-export them either: a re-export is one more name for the one implementation,
  // and the next reader takes it for a third copy.
  const pure = require('../lib/pure');
  for (const n of ['uiFlattenOptions', 'uiRenderInputValue', 'uiExcludedValue', 'uiInterpolate', 'uiComposePrompt']) {
    assert.equal(pure[n], undefined, 'lib/pure must not export ' + n + ' any more');
  }
});

// ---------------------------------------------------- the confirmation dialog may not under-state
// uiWriteEffect lives in views-uiskills.js (it needs t() and the DOM), so the SEAM is tested here and
// the wiring is pinned as text below. Both halves are needed: the seam proves the block can survive,
// the text proves the one caller that must pass it actually does.
test('an effectTemplate {{#autoRun}} block survives into the DISPLAY path (it used to be dropped)', () => {
  const m = { inputs: [{ id: 'ziel', type: 'text' }] };
  const tpl = 'schreibt nach {{ziel}}{{#autoRun}} — und startet OHNE Rückfrage{{/autoRun}}';
  const values = { ziel: 'PROJ' };
  // the prompt path has always passed it…
  assert.match(uiInterpolate(tpl, m, values, { autoRun: true }), /OHNE Rückfrage/);
  // …and the display path must too, WITH its localised labels, not instead of them
  const shown = uiInterpolate(tpl, m, values, { labels: { yes: 'Yes', no: 'No' }, autoRun: true });
  assert.match(shown, /schreibt nach PROJ/);
  assert.match(shown, /OHNE Rückfrage/, 'the dialog would have promised less than the model was told');
  // and a run that does NOT auto-start must not claim it does — the bound has to work both ways
  assert.doesNotMatch(uiInterpolate(tpl, m, values, { labels: { yes: 'Yes', no: 'No' }, autoRun: false }), /OHNE Rückfrage/);
});

test('uiWriteEffect is handed an autoRun at every call site — the schedule one unconditionally', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/views-uiskills.js'), 'utf8');
  // The definition takes a third parameter, and its body forwards it — pinned by NAME, not by the exact
  // argument text, so reformatting the call does not fail this while a dropped flag still does.
  const def = /function uiWriteEffect\(([^)]*)\)\s*\{([\s\S]*?)\n\}/.exec(src);
  assert.ok(def, 'uiWriteEffect not found — did it move or get renamed?');
  assert.equal(def[1].split(',').length, 3, 'uiWriteEffect takes ' + def[1] + ' — the autoRun parameter is gone');
  assert.match(def[2], /autoRun/, 'the parameter exists but the body never forwards it into uiInterpolate');
  // …and NO caller may omit it: a two-argument call is exactly the bug that was fixed.
  const calls = [...src.matchAll(/uiWriteEffect\(([^)]*)\)/g)].map((mm) => mm[1])
    .filter((a) => a !== def[1]);   // the definition's own parameter list is not a call
  assert.ok(calls.length >= 3, 'expected the three confirmation call sites, found ' + calls.length);
  for (const a of calls) {
    assert.equal(a.split(',').length, 3, 'uiWriteEffect(' + a + ') drops autoRun — the dialog would under-state');
  }
  // The unattended one cannot read the flag off a run that does not exist yet: it is true by definition.
  assert.ok(calls.some((a) => /,\s*true\s*$/.test(a)), 'the schedule dialog must pass true, not an opts flag');
});
