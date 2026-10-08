'use strict';
// The HOOK EVENT CATALOG — pure logic, shared by the browser (classic script) and Node (lib/chat.js
// requires the trim, test/hooks-catalog.test.js requires all of it). No t()/tt(), no DOM.
//
// WHY THIS FILE EXISTS. The hook editor offered NINE events as nine hard-coded `<option>` elements in
// public/index.html, and its hint said „Matcher gilt für PreToolUse/PostToolUse (Tool-Name); für andere
// Events leer lassen". Both halves were a claim nobody had checked:
//
//  · MEASURED 2026-10-03 (free, CLI 2.1.288, 20 ms — the fastest control of the whole run; raw answer in
//    C:/Users/you/ccui-ctxprobe/ctx-probe-result.json, key `hooks_listing`): the answer DELIVERED four
//    top-level fields, not the two the panel knew — `events`, `hooks`, `eventCatalog`, `policy`.
//    The SCHEMA has SEVEN, and that distinction is the one this repo keeps paying for: `safeMode`, `bareMode`
//    and `errors` are spread in CONDITIONALLY (`...br()&&{safeMode:…}`, `...Dr()&&Gr("hooks")&&{bareMode:…}`,
//    `...f.length>0&&{errors:f}` — claude.exe 2.1.288 @230465227), so they were absent because this session
//    was neither in safe nor in bare mode and had no settings errors, NOT because they do not exist. All
//    three say that the listed hooks DO NOT RUN, so a trim that drops them leaves a list headed „Wirksam"
//    that can be wrong about every row in it. Same for `policy.policyUnreadable` and for the per-row
//    `disabled`. They are all carried now, and absent-is-not-false is kept visible (null / []).
//    `eventCatalog` carries exactly 33 entries of { name, summary, supportsMatcher }, in lifecycle order,
//    and the binary describes the field itself as „Every hook event in lifecycle order (name, the /hooks
//    summary, whether its hooks take a matcher), for an add-hook form." — literally the form built on it
//    here. Counter-check in the binary: the identical 33-name list stands twice as an array literal
//    (`kg` @204512305, `P0` @205427002), same order, same names. Vocabulary and delivery agree.
//    All nine events the editor offered are among the 33, so it never named a wrong one — it left 24 out.
//
//  · the MATCHER rule was simply false, and in both directions. The CLI says per event whether it takes a
//    matcher, and 23 of the 33 do (ten do not). SEVEN of the nine events the editor offered take one, and
//    five of those seven are ones the old hint denied: SubagentStop, SessionStart, SessionEnd, Notification
//    and PreCompact. While `Stop`, which the hint filed under „andere Events" and for which it suggested `*`,
//    takes NO matcher. So the field is driven by the delivered `supportsMatcher` flag now and the sentence is
//    gone. The counts are not prose here: test/hooks-catalog.test.js counts them off the stored fixture
//    test/fixtures/cli-hooks-eventcatalog-2.1.288.json (the measured 33 rows, verbatim), the same treatment
//    the „22 Schalter" claim gets — the first draft of this comment said 22 and five, and nothing could see it.
//
// THE DESIGN POINT THE MEASUREMENT DOES NOT DECIDE, stated here because it is the actual work: this is a
// CONTROL request, so it needs a RUNNING session, and the settings editor is session-free. The panel
// therefore reads the catalog when a chat is running and falls back to the nine names it has always known
// when none is — but the fallback is LABELLED (`gelesen: false`) and its matcher column says „unbekannt"
// rather than yes or no. A silent fallback that looks like a measurement is the one variant that is not
// allowed here: it would be the same mistake as the old hint, only harder to see.

// The nine events the hook editor has always offered, which are now ONLY the fallback for a panel with no
// running session. All nine are in the measured 33 (asserted in test/hooks-catalog.test.js, so a typo here
// cannot survive). Curio worth one line: the same nine stand in the binary as `zd` @216575179 — but as an
// allowlist for `launcher_hooks` validation, not as a catalog, so the overlap is common ancestry or
// coincidence and not a justification.
const HOOK_EVENTS_FALLBACK = [
  'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop',
  'SessionStart', 'SessionEnd', 'Notification', 'PreCompact',
];

// What the ROUTE hands to the browser. The full answer is ~6 KB and most of it is the user's own hook
// command text, twice: `displayText` and `commandText` were byte-identical in the measurement, so only the
// one that is meant for display survives. Everything here is either the CLI's own catalog or a hook that
// is ALREADY in this user's settings — nothing is exposed that the settings editor does not show anyway;
// what is NEW is the hooks the panel cannot see on its own (plugin and managed ones) and their origin.
// → { events, hooks, eventCatalog, policy, safeMode, bareMode, errors }
function hookListingTrim(data) {
  const d = (data && typeof data === 'object') ? data : {};
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
  const str = (v) => String(v == null ? '' : v);
  const obj = (v) => ((v && typeof v === 'object' && !Array.isArray(v)) ? v : null);
  return {
    // which events actually HAVE hooks, and how many — the CLI's own count, so the editor does not have to
    // derive „is this event in use" from a settings file it only partly sees
    events: arr(d.events).map((e) => ({ name: str(e.name), hookCount: Number(e.hookCount) || 0 })),
    // the hooks the CLI LISTS, with where each one comes from (`source`/`sourceLabel`: the raw palette is
    // userSettings · projectSettings · localSettings · pluginHook · sessionHook · builtinHook · policySettings).
    // This is the half the panel cannot read from settings.json at all.
    // `disabled` is why „listed" is not „in force": its describe reads „True when the session's mode or policy
    // keeps this hook from running (the policy block and safeMode/bareMode say why); absent on rows that run."
    // It was dropped by the first version of this trim while the heading above the list said „Wirksam" — the
    // panel would have presented a row the CLI had just told it does not fire.
    hooks: arr(d.hooks).map((h) => ({
      event: str(h.event),
      matcher: str(h.matcher),
      source: str(h.source),
      sourceLabel: str(h.sourceLabel),
      type: str(h.type),
      text: str(h.displayText),
      background: h.runsInBackground === true,
      disabled: h.disabled === true,
      // THE TWO FIELDS THAT QUALIFY „wirksam" WITHOUT BEING `disabled` (schema @205783101, read 2026-10-03):
      //  · condition — „If-condition, revealed, when set." The hook fires only while that condition holds.
      //  · runsOnce  — at most once per session, so a listed row may already have had its one turn.
      // A row that is not `disabled` goes under a heading that promises it runs, and for these two that
      // promise is too strong. Dropping them repeats `disabled`'s own mistake one field further on: the list
      // keeps its heading and the CLI's qualifier never reaches the reader. Both are optional in the schema,
      // so '' / false mean „nobody said" just as much as „no condition" — the list only ever adds a remark
      // when there IS one, so the two cannot be told apart by it, and must not be.
      condition: str(h.condition),
      once: h.runsOnce === true,
      // Deliberately NOT carried, with the reason, so the next reader need not re-measure: `timeout` (seconds
      // — says how long, not whether), `commandText`/`contentLabel` (identity text + its label; `displayText`
      // above already IS „statusMessage when set, else the identity text", and both were byte-identical in the
      // measurement), `pluginName` and `statusMessage` (folded into `sourceLabel`/`displayText` by the CLI
      // itself). None of them changes whether a row under „Wirksam" fires, which is the only claim this list
      // makes. They come when a consumer does.
      // `editable` is deliberately NOT here. The schema has it, but as an OBJECT —
      // `u({ matcher, config, headersRedacted }).optional()`, present „only on rows from a settings file this
      // session reads and may write". The first version read it as `h.editable === true`, which is false for
      // every real answer (all measured rows carried an object), and the emulator plus the fixture froze the
      // invented boolean so the test agreed. That is the gridRows mistake this very PR uncovered, re-made in
      // the file the PR adds. Nothing in the panel reads the field (grepped), so it is left out until a
      // consumer exists — vocabulary without a consumer is the other thing this repo prunes. When that
      // consumer comes, the test is `h.editable != null && typeof h.editable === 'object'`, never `=== true`.
    })),
    // the 33 — name, the /hooks summary, and whether this event's hooks take a matcher
    eventCatalog: arr(d.eventCatalog).map((e) => ({
      name: str(e.name),
      summary: str(e.summary),
      supportsMatcher: e.supportsMatcher === true,
    })),
    // whether an administrator has switched hooks off or restricted them — a hook editor whose entries
    // cannot fire must say so rather than let the user write into the void.
    // `policyUnreadable` is the fifth flag and the only one that is spread in conditionally: „Present when a
    // managed settings source exists but could not be read: what the organization configured is unknown".
    policy: obj(d.policy) ? {
      disabledByPolicy: d.policy.disabledByPolicy === true,
      managedOnly: d.policy.managedOnly === true,
      pluginOnly: d.policy.pluginOnly === true,
      allDisabled: d.policy.allDisabled === true,
      policyUnreadable: d.policy.policyUnreadable === true,
      policyHookCount: Number(d.policy.policyHookCount) || 0,
    } : null,
    // THE THREE FIELDS THAT SAY „NOTHING IN THE LIST ABOVE RUNS", carried as null/[] so that „the CLI did not
    // report this" and „false" stay the same answer rather than two. `exitHint` is the CLI's OWN sentence for
    // how to leave the mode and travels verbatim, like `summary` and `autocompactSource` elsewhere.
    //  · safeMode — „Present only when the session runs under --safe-mode."
    //  · bareMode — „Present only under --bare / CLAUDE_CODE_SIMPLE with the hooks surface gated off:
    //    settings-file, flag, policy, and plugin hooks never fire there; session hooks still run."
    safeMode: obj(d.safeMode) ? {
      managedHooksStillApply: d.safeMode.managedHooksStillApply === true,
      exitHint: str(d.safeMode.exitHint),
    } : null,
    bareMode: obj(d.bareMode) ? { exitHint: str(d.bareMode.exitHint) } : null,
    //  · errors — „Settings files skipped by the merge — their hooks are neither listed nor running." A file
    //    the panel may well own: its hooks are invisible here AND dead, and only this field says so.
    errors: arr(d.errors).map((e) => ({ file: str(e.file), path: str(e.path), message: str(e.message) })),
  };
}

// The rows the event dropdown is built from. `listing` is what the route answered (or null/an error — the
// settings editor has no session to ask in that case).
// `supportsMatcher` is deliberately THREE-valued: true / false / null = „nobody said". The old hint got
// this exact question wrong in both directions, so „unknown" has to be a state of its own and may not
// collapse into „no matcher" — that is what would quietly re-create the wrong rule.
// → [{ name, summary, supportsMatcher: true|false|null, hookCount, gelesen }]
function hookEventRows(listing) {
  const l = (listing && typeof listing === 'object') ? listing : null;
  const cat = l && Array.isArray(l.eventCatalog) ? l.eventCatalog.filter((e) => e && e.name) : [];
  const counts = new Map();
  if (l && Array.isArray(l.events)) l.events.forEach((e) => { if (e && e.name) counts.set(String(e.name), Number(e.hookCount) || 0); });
  if (cat.length) {
    // the CLI's own list, in the CLI's own (lifecycle) order — not sorted here, because that order IS
    // information: it is when in a turn the event fires.
    return cat.map((e) => ({
      name: String(e.name),
      summary: String(e.summary == null ? '' : e.summary),
      supportsMatcher: e.supportsMatcher === true,
      hookCount: counts.get(String(e.name)) || 0,
      gelesen: true,
    }));
  }
  return HOOK_EVENTS_FALLBACK.map((name) => ({
    name,
    summary: '',
    supportsMatcher: null,     // UNKNOWN, see above — never false
    hookCount: counts.get(name) || 0,
    gelesen: false,
  }));
}

// The one row for one event name, for the editor's matcher field. An event the catalog does not know at all
// (a name typed into the raw JSON editor, or a future event on an older panel) answers `null` for the
// matcher question too — the field stays usable and says nothing it cannot back up.
function hookEventRow(rows, name) {
  const list = Array.isArray(rows) ? rows : [];
  const want = String(name == null ? '' : name);
  return list.find((r) => r && r.name === want) || null;
}

// What the matcher input may say about itself: 'ja' · 'nein' · 'unbekannt'. One function, so the field's
// enabled state and its hint can never disagree (they were one sentence before, and it was wrong).
function hookMatcherState(row) {
  if (!row || row.supportsMatcher == null) return 'unbekannt';
  return row.supportsMatcher ? 'ja' : 'nein';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { hookListingTrim, hookEventRows, hookEventRow, hookMatcherState, HOOK_EVENTS_FALLBACK };
}
