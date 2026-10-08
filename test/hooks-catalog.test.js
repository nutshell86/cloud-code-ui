'use strict';
// PR-11 — the hook event catalog. The thing under test is not „are there 33 rows" but the two claims the
// old editor made that nobody had checked: the event LIST (nine hard-coded options) and the MATCHER rule
// („gilt für PreToolUse/PostToolUse; für andere Events leer lassen").
//
// The fixture is the real `get_hooks_listing` answer of the 2026-10-03 run (free, CLI 2.1.288 —
// C:/Users/you/ccui-ctxprobe/ctx-probe-result.json, key `hooks_listing`), trimmed to the rows that
// carry the argument: the measured `supportsMatcher` of the nine events the editor used to offer.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  hookListingTrim, hookEventRows, hookEventRow, hookMatcherState, HOOK_EVENTS_FALLBACK,
} = require('../public/js/hooks-catalog');

// MEASURED `supportsMatcher` for exactly the nine events the editor offered — copied from the answer.
// SEVEN of the nine take one; five of those seven are events the old hint said take none, and `Stop` takes
// none although the hint filed it under „andere Events" and suggested `*` for it.
const MEASURED_NINE = {
  PreToolUse: true, PostToolUse: true, UserPromptSubmit: false, Stop: false, SubagentStop: true,
  SessionStart: true, SessionEnd: true, Notification: true, PreCompact: true,
};
// the full answer, as it arrived (four top-level fields DELIVERED — the panel knew only the first two, and
// the schema has three more that this session did not trigger; see the suite at the bottom)
const LISTING = {
  events: [
    { name: 'PostToolUse', summary: 'After tool execution', supportsMatcher: true, hookCount: 1 },
    { name: 'Stop', summary: 'Right before Claude concludes its response', supportsMatcher: false, hookCount: 1 },
  ],
  // `editable` is an OBJECT in both rows, exactly as delivered — the first version of this fixture wrote
  // `editable: true`, a shape the CLI does not produce, and the trim that read `=== true` agreed with it.
  hooks: [{
    event: 'PostToolUse', matcher: 'mcp__sap-adt__(write_object|activate)', source: 'userSettings',
    sourceLabel: 'User settings (~/.claude/settings.json)', type: 'command',
    displayText: 'Write-Output …', commandText: 'Write-Output …', contentLabel: 'command',
    editable: { matcher: 'mcp__sap-adt__(write_object|activate)', config: { type: 'command', command: 'Write-Output …', shell: 'powershell' } },
  }, {
    event: 'Stop', matcher: '', source: 'userSettings',
    sourceLabel: 'User settings (~/.claude/settings.json)', type: 'command',
    displayText: 'node hook.js', commandText: 'node hook.js', contentLabel: 'command',
    runsInBackground: true,
    // the two qualifiers of a row that is NOT `disabled`, in the shape the schema gives them
    // (`condition: o().optional()`, `runsOnce: M().optional()` — claude.exe 2.1.288 @205783101). The FIRST
    // row carries neither, on purpose: absent has to come out as '' / false, not undefined.
    condition: '$CLAUDE_PROJECT_DIR == "C:/work"', runsOnce: true,
    editable: { matcher: '', config: { type: 'command', command: 'node hook.js', async: true } },
  }],
  eventCatalog: Object.keys(MEASURED_NINE).map((name) => ({ name, summary: 'measured summary of ' + name, supportsMatcher: MEASURED_NINE[name] }))
    .concat([{ name: 'MessageDisplay', summary: 'While assistant message text is displayed', supportsMatcher: false }]),
  policy: { disabledByPolicy: false, managedOnly: false, pluginOnly: false, allDisabled: false, policyHookCount: 0 },
};
// …and the whole delivered catalog, kept in the repo, because two counts in this PR's prose were simply wrong.
const CATALOG_FIXTURE = JSON.parse(require('fs').readFileSync(
  require('path').join(__dirname, 'fixtures/cli-hooks-eventcatalog-2.1.288.json'), 'utf8'));

// ---------------------------------------------------------------------------------------------------
// THE COUNTS, COUNTED — not quoted
// ---------------------------------------------------------------------------------------------------
// PR-11 carried „22 der 33 Events nehmen einen Matcher, darunter fünf der neun angebotenen" in four places
// (CHANGELOG, docs/messung, hooks-catalog.js, views.js). Both numbers were wrong: 23 take one, and seven of
// the nine on offer do. The sentence CARRIES the feature's argument — it is the reason the old hint was
// deleted — so it gets the same treatment as the „22 Schalter" claim: an assertion against a stored fixture
// of the delivered rows, not a number in prose that nobody re-counts.
describe('hooks-catalog — the matcher counts come off the delivered catalog', () => {
  it('the fixture is the delivered 33, and its own counters agree with its rows', () => {
    const ec = CATALOG_FIXTURE.eventCatalog;
    assert.equal(CATALOG_FIXTURE.cliVersion, '2.1.288');
    assert.equal(ec.length, 33);
    assert.equal(CATALOG_FIXTURE.eventCount, ec.length);
    assert.equal(new Set(ec.map((e) => e.name)).size, 33, 'a duplicated event name in the fixture');
    assert.equal(ec.every((e) => typeof e.supportsMatcher === 'boolean'), true);
    assert.equal(CATALOG_FIXTURE.matcherCount, ec.filter((e) => e.supportsMatcher === true).length);
  });

  it('23 of the 33 take a matcher — the prose said 22', () => {
    const ec = CATALOG_FIXTURE.eventCatalog;
    const ja = ec.filter((e) => e.supportsMatcher === true);
    const nein = ec.filter((e) => e.supportsMatcher !== true);
    assert.equal(ja.length, 23, 'the number the documents quote');
    assert.equal(nein.length, 10);
    assert.equal(ja.length + nein.length, 33);
    // the ten by name, so a shift in the flag is readable rather than just a changed count
    assert.deepEqual(nein.map((e) => e.name), [
      'PostToolBatch', 'UserPromptSubmit', 'Stop', 'TeammateIdle', 'TaskCreated',
      'TaskCompleted', 'WorktreeCreate', 'WorktreeRemove', 'CwdChanged', 'MessageDisplay',
    ]);
  });

  it('SEVEN of the nine the editor offered take one, five of them against the old hint', () => {
    const by = new Map(CATALOG_FIXTURE.eventCatalog.map((e) => [e.name, e.supportsMatcher]));
    // every one of the nine is in the delivered 33 — the editor never named an event that does not exist
    assert.deepEqual(HOOK_EVENTS_FALLBACK.filter((n) => !by.has(n)), []);
    const ja = HOOK_EVENTS_FALLBACK.filter((n) => by.get(n) === true);
    assert.equal(ja.length, 7, 'the documents said „fünf der neun angebotenen"');
    // the five the hint actively DENIED (it allowed only PreToolUse/PostToolUse) — that is the sub-count the
    // sentence meant, and it has to be stated as a subset rather than as the total
    assert.deepEqual(ja.filter((n) => n !== 'PreToolUse' && n !== 'PostToolUse'),
      ['SubagentStop', 'SessionStart', 'SessionEnd', 'Notification', 'PreCompact']);
    // …and the other direction, which the hint got wrong too: it suggested `*` for Stop
    assert.equal(by.get('Stop'), false);
    assert.equal(by.get('UserPromptSubmit'), false);
    // the fixture's own MEASURED_NINE above must not drift from the stored catalog
    for (const n of HOOK_EVENTS_FALLBACK) assert.equal(by.get(n), MEASURED_NINE[n], n);
  });

  it('no document quotes „22 of the 33" or „five of the nine" any more', () => {
    // The four places the wrong pair stood. Checked as TEXT, because that is what was wrong — a comment and
    // three prose paragraphs, none of them reachable by any other assertion.
    const fs2 = require('fs');
    const p2 = require('path');
    const R = p2.join(__dirname, '..');
    for (const rel of ['CHANGELOG.md', 'public/js/hooks-catalog.js', 'public/js/views.js', 'README.md']) {
      const txt = fs2.readFileSync(p2.join(R, rel), 'utf8');
      assert.equal(/22\s+(der|of the)\s+33/.test(txt), false, rel + ' still says 22 of the 33');
      assert.equal(/(fünf|five) der neun angebotenen|five of the nine on offer/.test(txt), false,
        rel + ' still says „five of the nine on offer" as the total');
    }
  });
});

describe('hooks-catalog — the matcher rule the editor used to state wrongly', () => {
  it('five of the nine offered events DO take a matcher, and Stop does not', () => {
    const rows = hookEventRows(LISTING);
    const st = (n) => hookMatcherState(hookEventRow(rows, n));
    // the old hint: „Matcher gilt für PreToolUse/PostToolUse (Tool-Name); für andere Events leer lassen / *"
    assert.equal(st('PreToolUse'), 'ja');
    assert.equal(st('PostToolUse'), 'ja');
    for (const n of ['SubagentStop', 'SessionStart', 'SessionEnd', 'Notification', 'PreCompact']) {
      assert.equal(st(n), 'ja', n + ' was filed under „leave blank" and does take a matcher');
    }
    // …and the other direction: the hint suggested `*` for these
    assert.equal(st('Stop'), 'nein');
    assert.equal(st('UserPromptSubmit'), 'nein');
  });

  it('„nobody said" is a THIRD state and never collapses into „no matcher"', () => {
    // Without a running session the panel cannot ask. Answering „nein" there would quietly re-create the
    // wrong rule — this time with no sentence to find it in.
    const rows = hookEventRows(null);
    assert.equal(rows.every((r) => r.supportsMatcher === null), true);
    assert.equal(hookMatcherState(hookEventRow(rows, 'Stop')), 'unbekannt');
    assert.equal(hookMatcherState(hookEventRow(rows, 'PreToolUse')), 'unbekannt');
    // an event nobody has heard of answers the same way, rather than guessing either way
    assert.equal(hookEventRow(hookEventRows(LISTING), 'NoSuchEvent'), null);
    assert.equal(hookMatcherState(null), 'unbekannt');
    assert.equal(hookMatcherState({ supportsMatcher: undefined }), 'unbekannt');
  });
});

describe('hooks-catalog — read vs. fallback, and that the difference is VISIBLE', () => {
  it('a read catalog is marked read, keeps the CLI order, and carries the summaries', () => {
    const rows = hookEventRows(LISTING);
    assert.equal(rows.length, 10);
    assert.equal(rows.every((r) => r.gelesen === true), true);
    // lifecycle order is information (when in a turn the event fires) and must not be sorted away
    assert.deepEqual(rows.map((r) => r.name), LISTING.eventCatalog.map((e) => e.name));
    assert.equal(rows[0].summary, 'measured summary of PreToolUse');
    // the hook COUNT comes from `events`, which only lists the events that have hooks
    assert.equal(hookEventRow(rows, 'PostToolUse').hookCount, 1);
    assert.equal(hookEventRow(rows, 'PreToolUse').hookCount, 0);
  });

  it('the fallback is marked NOT read — a silent one is the forbidden variant', () => {
    for (const nothing of [null, undefined, {}, { eventCatalog: [] }, { eventCatalog: null }]) {
      const rows = hookEventRows(nothing);
      assert.equal(rows.every((r) => r.gelesen === false), true, 'fallback claimed to be read: ' + JSON.stringify(nothing));
      assert.deepEqual(rows.map((r) => r.name), HOOK_EVENTS_FALLBACK);
      assert.equal(rows.every((r) => r.summary === ''), true, 'the fallback invented a summary');
    }
  });

  it('every fallback name is one the CLI really knows', () => {
    // The nine are the panel\'s own list, so a typo in it would offer an event that does not exist — the
    // „catalog entry the CLI does not know" case. All nine are in the measured 33.
    const known = new Set(LISTING.eventCatalog.map((e) => e.name));
    assert.deepEqual(HOOK_EVENTS_FALLBACK.filter((n) => !known.has(n)), []);
    assert.equal(HOOK_EVENTS_FALLBACK.length, 9);
  });
});

// ---------------------------------------------------------------------------------------------------
// THE VISIBLE HALF — the part that was WRONG before, so it is the part that needs pinning
// ---------------------------------------------------------------------------------------------------
// The bug here was not in any function: it was nine `<option>` elements in index.html and one sentence
// under them. Both are markup, so they are checked by reading the markup — and the composed i18n keys are
// checked against the dictionary, because the i18n suite's narrow scan cannot see `t('views.hookMatcher' +
// state)` and a typo there would print the raw key on screen.
describe('hooks-catalog — the editor markup no longer carries a hard-coded claim', () => {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const VIEWS = fs.readFileSync(path.join(ROOT, 'public/js/views.js'), 'utf8');
  const DICT = fs.readFileSync(path.join(ROOT, 'public/js/i18n.js'), 'utf8');

  it('the event select is EMPTY in the markup — the list comes from the CLI', () => {
    const at = HTML.indexOf('<select id="hookEvent"');
    assert.ok(at > 0, 'the event select is gone entirely');
    const close = HTML.indexOf('</select>', at);
    const inner = close > at ? HTML.slice(at, close) : HTML.slice(at, at + 200);
    assert.equal(/<option/.test(inner), false, 'hard-coded <option> elements are back — the list can go stale again');
    // …and every one of the nine names it used to carry is gone from the markup
    for (const n of HOOK_EVENTS_FALLBACK) {
      assert.equal(HTML.includes('>' + n + '</option>'), false, n + ' is still an <option>');
    }
  });

  it('the wrong matcher sentence is gone from the markup AND from the dictionary', () => {
    // „Matcher gilt für PreToolUse/PostToolUse (Tool-Name); für andere Events leer lassen / *" — wrong for
    // six of the nine events it governed. Deleting the sentence but leaving its i18n key would let the next
    // edit put it back without anyone noticing, so the key goes too.
    assert.equal(HTML.includes('html.ausMatcherGiltFuer'), false);
    assert.equal(HTML.includes('html.fuerAndereEvents'), false);
    assert.equal(DICT.includes("'html.ausMatcherGiltFuer'"), false, 'the wrong sentence is still in the dictionary');
    assert.equal(DICT.includes("'html.fuerAndereEvents'"), false);
    assert.equal(/Matcher gilt für PreToolUse/.test(DICT), false, 'the claim survived somewhere else');
    // what replaced it: a per-event statement driven by the delivered flag
    assert.ok(HTML.includes('id="hookEventNote"'), 'nothing says where the list comes from');
  });

  it('the painter uses the pure seams and the three composed keys exist', () => {
    assert.match(VIEWS, /function paintHookEventNote\(/);
    assert.match(VIEWS, /hookEventRows\(/);
    assert.match(VIEWS, /hookMatcherState\(/);
    assert.match(VIEWS, /\$\('#hookEvent'\)\.onchange = paintHookEventNote/, 'the note no longer follows the selected event');
    // the matcher field is DISABLED for an event that takes none, and left usable when nobody said
    assert.match(VIEWS, /mi\.disabled = \(st === 'nein'\)/);
    // …and the read-only list of effective hooks prints a matcher only when the CLI reported one. Filling an
    // empty one with „*" (which the panel's OWN settings list does, reasonably, for a rule the user wrote)
    // would claim a wildcard on the eleven events that take no matcher at all. Seen in the sight check as
    // „SessionStart [*]", and pinned here because nothing else could see it.
    assert.match(VIEWS, /h\.event \+ \(h\.matcher \? ' {2}\[' \+ h\.matcher \+ '\]' : ''\)/, 'the effective-hook row invents a wildcard matcher again');
    // every key the three states compose
    for (const suffix of ['Ja', 'Nein', 'Unbekannt']) {
      assert.ok(DICT.includes("'views.hookMatcher" + suffix + "':"), 'missing dictionary key views.hookMatcher' + suffix);
    }
    for (const k of ['views.hookEventsGelesen', 'views.hookEventsNichtGelesen', 'views.hookWirksamFremd']) {
      assert.ok(DICT.includes("'" + k + "':"), 'missing dictionary key ' + k);
    }
    // …and the policy keys, which are composed from the flag name
    for (const f of ['allDisabled', 'disabledByPolicy', 'managedOnly', 'pluginOnly']) {
      const key = 'views.hookPolicy' + f.charAt(0).toUpperCase() + f.slice(1);
      assert.ok(DICT.includes("'" + key + "':"), 'missing dictionary key ' + key);
    }
  });

  it('the catalog is read once per session, from the render path, and cannot loop', () => {
    // The answer is a property of the binary and of the settings files — a per-render read would be traffic
    // for an answer that cannot have moved, and PR-3b's whole point was not to chat with the CLI per paint.
    // It IS called from the render path, though, and that is a fix the sight check forced: `loadSettings`
    // early-returns on its viewOnce guard and runs once at boot, i.e. BEFORE any chat exists — so the one
    // read found no session and the editor kept its labelled fallback for the whole browser session.
    assert.match(VIEWS, /HOOK_LISTING_FOR === id \|\| HOOK_LISTING_BUSY\) return;/, 'the cache/in-flight guard is gone — this would loop');
    assert.match(VIEWS, /renderHookEvents\(\);\s*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*loadHookCatalog\(\);/, 'renderHooks no longer asks');
    // …and entering the view asks too, BEFORE the viewOnce guard — that guard is what kept the fallback on
    // screen for a whole browser session, because the view is loaded once at boot with no chat running and
    // every later entry returned early without reaching renderFriendly at all.
    const head = VIEWS.slice(VIEWS.indexOf('async function loadSettings('), VIEWS.indexOf("if (!viewOnce('settings'"));
    assert.match(head, /loadHookCatalog\(\);/, 'entering the settings view no longer asks the CLI');
    // A FAILED read marks the id too, or every repaint asks again. Anchored at the START of the line, and
    // that is not pedantry: the first version of this assertion matched the body only, so wrapping it in
    // `if (HOOK_LISTING)` — which reintroduces the per-repaint retry — left the test green. Caught by the
    // mutation probe, which is the only reason this line reads the way it does.
    assert.match(VIEWS, /\n {2}HOOK_LISTING_FOR = id;\s+\/\/ asked/, 'the mark is conditional again — a silent session is re-asked on every repaint');
    // …and ↻ / a save is the way back: it clears the mark BEFORE the viewOnce guard
    assert.match(VIEWS, /if \(force\) HOOK_LISTING_FOR = '';/);
    // `unconfirmed` must NOT become an empty catalog: it goes to the labelled fallback
    assert.match(VIEWS, /r\.ok && !r\.unconfirmed\) \? r : null/);
  });
});

describe('hooks-catalog — what the route hands out', () => {
  it('keeps every field the SCHEMA has and drops the duplicated command text', () => {
    const t = hookListingTrim(LISTING);
    // SEVEN, not the four this session happened to deliver. `safeMode`, `bareMode` and `errors` are spread in
    // conditionally by the CLI (`...br()&&{safeMode:…}` etc.), so their absence in one recording says nothing
    // about the vocabulary — and all three say that the hooks listed here do NOT run.
    assert.deepEqual(Object.keys(t), ['events', 'hooks', 'eventCatalog', 'policy', 'safeMode', 'bareMode', 'errors']);
    // `displayText` and `commandText` were byte-identical in the measurement; only the one meant for
    // display survives, so the user\'s hook command does not travel twice
    assert.deepEqual(Object.keys(t.hooks[0]), ['event', 'matcher', 'source', 'sourceLabel', 'type', 'text', 'background', 'disabled', 'condition', 'once']);
    assert.equal(t.hooks[0].text, 'Write-Output …');
    assert.equal('commandText' in t.hooks[0], false);
    assert.equal(t.hooks[0].background, false, 'absent runsInBackground is false, not undefined');
    assert.equal(t.hooks[1].background, true);
    assert.deepEqual(Object.keys(t.eventCatalog[0]), ['name', 'summary', 'supportsMatcher']);
    assert.deepEqual(Object.keys(t.events[0]), ['name', 'hookCount']);
    assert.equal(t.policy.policyHookCount, 0);
    // a session in neither mode and with no settings errors: null and [], not absent — „the CLI did not
    // report it" and „false" have to be the same answer here or every reader invents its own distinction
    assert.equal(t.safeMode, null);
    assert.equal(t.bareMode, null);
    assert.deepEqual(t.errors, []);
  });

  it('`condition` and `runsOnce` survive per row — a row that is not `disabled` still may not fire', () => {
    const t = hookListingTrim(LISTING);
    // The row that HAS them: the condition travels verbatim (it is the user's own expression, and a
    // paraphrase would be a claim about when the hook runs), runsOnce as a flag.
    assert.equal(t.hooks[1].condition, '$CLAUDE_PROJECT_DIR == "C:/work"');
    assert.equal(t.hooks[1].once, true);
    // …and the row that has NEITHER: '' and false, like `background` — absent and „no condition" are the
    // same answer to a reader that only ever prints a remark when there is one, and no reader may get
    // `undefined` and invent a third state out of it.
    assert.equal(t.hooks[0].condition, '');
    assert.equal(t.hooks[0].once, false);
    // and neither row is `disabled`, which is the whole point: both go under the heading that promises
    // „Wirksam", and for one of them that promise needs the qualifier.
    assert.equal(t.hooks[0].disabled, false);
    assert.equal(t.hooks[1].disabled, false);
  });

  it('`disabled` survives per row — „listed" is not „in force"', () => {
    // The CLI's own describe: „True when the session's mode or policy keeps this hook from running (the policy
    // block and safeMode/bareMode say why); absent on rows that run." The first version of this trim dropped
    // it while the panel's heading above the list read „Wirksam", so a row the CLI had just declared dead
    // would have been presented as live.
    const t = hookListingTrim({
      hooks: [
        { event: 'PreToolUse', source: 'pluginHook', displayText: 'a', disabled: true },
        { event: 'Stop', source: 'pluginHook', displayText: 'b' },
      ],
    });
    assert.equal(t.hooks[0].disabled, true);
    assert.equal(t.hooks[1].disabled, false, 'absent means „this row runs", so false — not undefined');
  });

  it('`editable` is NOT handed out as a boolean — it is an object in the schema', () => {
    // The bug this replaces: `editable: h.editable === true` against
    // `u({matcher, config, headersRedacted?}).optional()`. Every real row carries an object, so the field was
    // permanently false — and fake-claude.js plus this fixture froze the invented boolean, which is exactly
    // the gridRows mistake PR-11 itself uncovered („a strip proven against the wrong shape proves nothing").
    // Nothing in the panel reads the field, so it is left out until a consumer exists.
    assert.equal(typeof LISTING.hooks[0].editable, 'object', 'the fixture went back to the invented shape');
    const t = hookListingTrim(LISTING);
    assert.equal('editable' in t.hooks[0], false, 'editable is back — then it must be a presence test, never === true');
    assert.equal('editable' in t.hooks[1], false);
    // …and the emulator has to deliver the measured shape too, or a test against it proves nothing
    const fake = require('fs').readFileSync(require('path').join(__dirname, '..', 'fake-claude.js'), 'utf8');
    assert.equal(/editable:\s*(true|false)/.test(fake), false, 'fake-claude.js hands out a boolean `editable` again');
    assert.match(fake, /editable: \{ matcher: /, 'fake-claude.js no longer delivers the object form');
    // the raw source NAMES the CLI really emits (userSettings · projectSettings · localSettings · pluginHook ·
    // sessionHook · builtinHook · policySettings) — „plugin" was not one of them
    // anchored on the closing quote, or „pluginHook" matches „plugin" and this guard never fires
    assert.equal(/source: 'plugin',/.test(fake), false, 'the invented source name is back');
    assert.match(fake, /source: 'pluginHook'/);
  });

  it('a policy restriction survives the trim — an editor whose entries cannot fire must say so', () => {
    const t = hookListingTrim({ policy: { allDisabled: true, managedOnly: true, policyHookCount: 3 } });
    assert.equal(t.policy.allDisabled, true);
    assert.equal(t.policy.managedOnly, true);
    assert.equal(t.policy.pluginOnly, false);
    assert.equal(t.policy.policyHookCount, 3);
    // the FIFTH flag, which the CLI spreads in conditionally: „…what the organization configured is unknown"
    assert.equal(t.policy.policyUnreadable, false);
    assert.equal(hookListingTrim({ policy: { policyUnreadable: true } }).policy.policyUnreadable, true);
  });

  it('the three „nothing here runs" fields survive, with the CLI\'s own way out', () => {
    const t = hookListingTrim({
      hooks: [{ event: 'Stop', source: 'userSettings', displayText: 'x' }],
      policy: { allDisabled: false },
      safeMode: { managedHooksStillApply: true, exitHint: 'restart without --safe-mode' },
      bareMode: { exitHint: 'unset CLAUDE_CODE_SIMPLE' },
      errors: [{ file: '~/.claude/settings.json', path: 'hooks', message: 'Unexpected token }' }],
    });
    assert.deepEqual(t.safeMode, { managedHooksStillApply: true, exitHint: 'restart without --safe-mode' });
    assert.deepEqual(t.bareMode, { exitHint: 'unset CLAUDE_CODE_SIMPLE' });
    assert.deepEqual(t.errors, [{ file: '~/.claude/settings.json', path: 'hooks', message: 'Unexpected token }' }]);
    // junk in those three does not become a mode: a non-object is „not reported", not „in safe mode"
    const j = hookListingTrim({ safeMode: true, bareMode: 'yes', errors: 'broken' });
    assert.equal(j.safeMode, null); assert.equal(j.bareMode, null); assert.deepEqual(j.errors, []);
  });

  it('never throws, and an empty answer stays empty rather than becoming a catalog', () => {
    const t = hookListingTrim(null);
    assert.deepEqual(t.events, []); assert.deepEqual(t.hooks, []); assert.deepEqual(t.eventCatalog, []);
    assert.equal(t.policy, null);
    assert.doesNotThrow(() => hookListingTrim({ events: 'x', hooks: [null, 3], eventCatalog: [{}], policy: 7 }));
    const junk = hookListingTrim({ hooks: [null, 3, { event: 'X' }], eventCatalog: [{}] });
    assert.equal(junk.hooks.length, 1);
    assert.equal(junk.eventCatalog[0].supportsMatcher, false, 'a missing flag is false here, not true');
    // …and hookEventRows then drops the nameless entry rather than offering an empty option
    assert.deepEqual(hookEventRows(junk).map((r) => r.name), HOOK_EVENTS_FALLBACK);
  });
});

// ---------------------------------------------------------------------------------------------------
// …AND THE VISIBLE HALF OF THAT: the heading said „Wirksam" about rows the CLI declared dead
// ---------------------------------------------------------------------------------------------------
describe('hooks-catalog — the effective list cannot call a dead hook „wirksam"', () => {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const VIEWS = fs.readFileSync(path.join(ROOT, 'public/js/views.js'), 'utf8');
  const DICT = fs.readFileSync(path.join(ROOT, 'public/js/i18n.js'), 'utf8');
  const painter = VIEWS.slice(VIEWS.indexOf('function renderHookPolicy'), VIEWS.indexOf('// A hook is named by its VALUE'));

  it('the list is SPLIT on `disabled`, and only the running half gets the „Wirksam" heading', () => {
    assert.ok(painter.length > 200, 'renderHookPolicy not found — did views.js move?');
    assert.match(painter, /fremd\.filter\(\(h\) => !h\.disabled\)/, 'disabled rows are back under „Wirksam"');
    assert.match(painter, /fremd\.filter\(\(h\) => h\.disabled\)/);
    assert.match(painter, /t\('views\.hookGesperrt'\)/, 'the dead rows have no heading of their own');
    // the running heading must be reached only for the running half
    assert.match(painter, /if \(laufen\.length\) \{\s*\n\s*box\.appendChild\(el\('div', 'hk-h', t\('views\.hookWirksamFremd'\)\)\);/);
  });

  it('the three session-mode fields and the fifth policy flag are rendered', () => {
    assert.match(painter, /'policyUnreadable'\]/, 'the fifth policy flag is not warned about');
    assert.match(painter, /HOOK_LISTING\.bareMode/);
    assert.match(painter, /HOOK_LISTING\.safeMode/);
    assert.match(painter, /HOOK_LISTING\.errors/);
    // the CLI's own exitHint is appended VERBATIM, like `summary` and `autocompactSource` elsewhere
    assert.match(painter, /m\.exitHint/);
    for (const k of ['views.hookBareMode', 'views.hookSafeMode', 'views.hookDateiFehler', 'views.hookGesperrt', 'views.hookPolicyPolicyUnreadable']) {
      assert.ok(DICT.includes("'" + k + "':"), 'missing dictionary key ' + k);
    }
  });

  it('the editing form is NOT locked — the panel writes files, it does not call edit_hook', () => {
    // The reviewer asked for locked controls under bareMode/safeMode/policyUnreadable, because the CLI's own
    // describe says „edit_hook refuses every edit (fail-closed) and a host locks its editing controls". That
    // sentence is about the `edit_hook` CONTROL REQUEST. This panel never sends it: it writes
    // ~/.claude/settings.json as a file (patchSettingsFile), which keeps working in all three states — the
    // hooks simply do not FIRE in this session. Disabling the form would therefore claim an inability the
    // panel does not have, which is this project's failure class pointed the other way. So: warn loudly, keep
    // the controls. Pinned here so the decision is visible rather than looking like an oversight.
    assert.equal(/hookAdd'\)\.disabled/.test(VIEWS), false, 'the add button is being disabled — see this test');
    assert.equal(/#hookCmd'\)\.disabled/.test(VIEWS), false);
    assert.match(VIEWS, /\$\('#hookAdd'\)\.onclick = async \(\) => \{/, 'the add handler is gone');
  });

  it('the „Wirksam" heading names the file it means', () => {
    // The filter is `source !== 'userSettings'`, i.e. „everything the list above cannot show" — and that list
    // reads ~/.claude/settings.json only. „nicht aus deinen Settings-Dateien" was wider than the filter: the
    // panel manages settings.local.json too, and a `localSettings` or `projectSettings` row landed in a bucket
    // whose label denied the panel owns any of it. The filter is unchanged (changing it on an unverified
    // source mapping would be the invention this repo pays for); the LABEL now says what is true.
    assert.match(painter, /h\.source !== 'userSettings'/);
    assert.match(DICT, /'views\.hookWirksamFremd': '[^']*settings\.json/);
    assert.equal(/'views\.hookWirksamFremd': '[^']*(deinen Settings-Dateien|your settings files)/.test(DICT), false);
  });
});
