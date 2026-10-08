'use strict';
// Zero-dependency unit tests: `node --test` (or `node --test test/`).
// Covers the pure server helpers extracted into ../lib/pure.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeNextRun,
  parseRevListLeftRight, parsePorcelain, parsePorcelainBranch,
} = require('../lib/pure');
// (the UI-skill prompt composer moved to public/js/ui-skill-prompt.js, because the panel kept a second
// copy of it and the two drifted — its tests moved along, to test/ui-skill-prompt.test.js)

// ------------------------------------------------------- parsePorcelain (/api/diff changed files)
// Guards the off-by-one that ate the first path character: run() trims stdout, so the leading space of
// a ` M path` status is gone on the FIRST line and a fixed slice(3) shifted into the path.
test('parsePorcelain: a trimmed leading space must not eat the first path character', () => {
  const out = parsePorcelain('M public/index.html\n M public/js/boot.js\n?? new.txt\n');
  assert.deepEqual(out, [
    { status: 'M', path: 'public/index.html' },  // first line, leading space trimmed away
    { status: 'M', path: 'public/js/boot.js' },  // untouched lines keep the 2-column status
    { status: '??', path: 'new.txt' },
  ]);
});
test('parsePorcelain: staged+unstaged, renames and empty input', () => {
  assert.deepEqual(parsePorcelain('MM a.js\n'), [{ status: 'MM', path: 'a.js' }]);
  assert.deepEqual(parsePorcelain('R  old.js -> new.js\n'), [{ status: 'R', path: 'old.js -> new.js' }]);
  assert.deepEqual(parsePorcelain(''), []);
  assert.deepEqual(parsePorcelain(null), []);
});

// ------------------------------------------------------- parsePorcelainBranch (/api/version)
// This one replaced a `rev-parse --abbrev-ref HEAD` in a polled route, so it has to give the SAME
// branch answer in every shape git prints the header — a wrong answer here is a wrong branch name in
// the System row and, worse, a wrong `not-on-main` decision on the update route.
test('parsePorcelainBranch: every header shape gives the branch rev-parse would have', () => {
  assert.deepEqual(parsePorcelainBranch('## main...origin/main [behind 1]\n M CHANGELOG.md\n?? new.txt'),
    { branch: 'main', files: ['CHANGELOG.md', 'new.txt'] });
  assert.equal(parsePorcelainBranch('## main').branch, 'main');                        // no upstream
  assert.equal(parsePorcelainBranch('## feat/x...origin/feat/x').branch, 'feat/x');    // slash in the name
  assert.equal(parsePorcelainBranch('## HEAD (no branch)').branch, 'HEAD');            // detached
  assert.equal(parsePorcelainBranch('## No commits yet on main').branch, 'main');      // fresh repo
  assert.deepEqual(parsePorcelainBranch('## main...origin/main [ahead 2, behind 1]').files, []); // clean tree
});
test('parsePorcelainBranch: no header, empty and unparseable input', () => {
  assert.deepEqual(parsePorcelainBranch(''), { branch: '', files: [] });
  assert.deepEqual(parsePorcelainBranch(null), { branch: '', files: [] });
  // a git failure prints nothing: branch must be '' (what the route used to show on an errored
  // rev-parse) and NOT be invented from a file line
  assert.deepEqual(parsePorcelainBranch(' M only/a/file.js'), { branch: '', files: ['only/a/file.js'] });
});

// ------------------------------------------------------- parseRevListLeftRight (version compare)
// Guards the fix for the phantom "Update · 1": the version check must report EXACT counts or
// explicitly unknown (null) — never a guessed number.
test('parseRevListLeftRight: left=behind, right=ahead', () => {
  assert.deepEqual(parseRevListLeftRight('0\t10'), { behind: 0, ahead: 10 }); // unpushed local work
  assert.deepEqual(parseRevListLeftRight('3\t0'), { behind: 3, ahead: 0 });   // plain "3 behind"
  assert.deepEqual(parseRevListLeftRight('2\t5'), { behind: 2, ahead: 5 });   // diverged
  assert.deepEqual(parseRevListLeftRight(' 0\t0 \n'), { behind: 0, ahead: 0 }); // padded/newline
  assert.deepEqual(parseRevListLeftRight('4 7'), { behind: 4, ahead: 7 });    // space-separated
});
test('parseRevListLeftRight: unparseable output → null (caller must fall back, not guess)', () => {
  for (const bad of ['', null, undefined, 'fatal: bad revision', '5', 'a\tb', '1\t2\t3']) {
    assert.equal(parseRevListLeftRight(bad), null, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------- computeNextRun
test('computeNextRun: interval adds N minutes', () => {
  const from = 1_000_000;
  assert.equal(computeNextRun({ type: 'interval', minutes: 15 }, from), from + 15 * 60000);
});

test('computeNextRun: interval — falsy/invalid minutes default to 60, negatives clamp to 1', () => {
  const from = 1_000_000; // must be truthy: `from || Date.now()` treats 0 as "unset"
  assert.equal(computeNextRun({ type: 'interval', minutes: 0 }, from), from + 60 * 60000);   // 0 is falsy → 60 min
  assert.equal(computeNextRun({ type: 'interval', minutes: -5 }, from), from + 60000);        // -5 truthy → clamp to 1 min
  assert.equal(computeNextRun({ type: 'interval', minutes: 'nope' }, from), from + 60 * 60000); // NaN → 60 min
});

test('computeNextRun: missing/unknown timing falls back to +1h', () => {
  const from = 5000;
  assert.equal(computeNextRun(null, from), from + 3600000);
  assert.equal(computeNextRun({ type: 'bogus' }, from), from + 3600000);
});

test('computeNextRun: daily returns a future timestamp at the requested time on an allowed weekday', () => {
  const from = new Date(2026, 0, 5, 8, 0, 0).getTime(); // Mon 2026-01-05 08:00 local
  const next = computeNextRun({ type: 'daily', time: '09:30', days: [1, 2, 3, 4, 5] }, from);
  const d = new Date(next);
  assert.ok(next > from, 'must be in the future');
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 30);
  assert.ok([1, 2, 3, 4, 5].includes(d.getDay()), 'must land on an allowed weekday');
});

test('computeNextRun: daily skips to the next allowed weekday when today is excluded', () => {
  const from = new Date(2026, 0, 3, 12, 0, 0).getTime(); // Sat 2026-01-03
  const next = computeNextRun({ type: 'daily', time: '09:00', days: [1] }, from); // Mondays only
  const d = new Date(next);
  assert.equal(d.getDay(), 1); // Monday
  assert.equal(d.getDate(), 5); // 2026-01-05
});

test('computeNextRun: same-day time already passed rolls to the next allowed day', () => {
  const from = new Date(2026, 0, 5, 10, 0, 0).getTime(); // Mon 10:00, target 09:00 already gone
  const next = computeNextRun({ type: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] }, from);
  const d = new Date(next);
  assert.ok(next > from);
  assert.equal(d.getDate(), 6); // Tue
});

// ------------------------------------------------------- SCHED-1 normalizeScheduleTiming
// The division of labour with computeNextRun above: that one has to answer for whatever is already on
// disk and is therefore forgiving; this one decides what may GET on disk. The pair of cases that matters
// most sits right next to each other here — `days: []` must be refused, an ABSENT `days` must not,
// because computeNextRun reads both as „all seven days" and only one of them meant it.
const { normalizeScheduleTiming, missingRequiredInputs } = require('../lib/pure');

test('normalizeScheduleTiming: days:[] is refused, an absent days field stays „every day"', () => {
  assert.ok(normalizeScheduleTiming({ type: 'daily', time: '03:00', days: [] }).error, 'the seven-day surprise');
  const absent = normalizeScheduleTiming({ type: 'daily', time: '03:00' });
  assert.equal(absent.error, undefined);
  assert.deepEqual(absent.timing, { type: 'daily', time: '03:00' }, 'no days field must not be invented into one');
  // and the fallback inside computeNextRun is what makes that reading real
  const from = new Date(2026, 0, 3, 12, 0, 0).getTime(); // Sat
  assert.ok(computeNextRun(absent.timing, from) < from + 86400000, 'an absent days list must still run tomorrow');
});

test('normalizeScheduleTiming: weekdays are de-duplicated and sorted; unmatchable ones are an error', () => {
  assert.deepEqual(normalizeScheduleTiming({ type: 'daily', time: '09:00', days: [5, 1, 1, 3] }).timing.days, [1, 3, 5]);
  // computeNextRun walks nine days and matches getDay() — a 9, a '1' or a 1.5 can never match, so it
  // would silently return from+24h for ever instead of running at the chosen time
  for (const days of [[9], ['1'], [1.5], [-1]]) {
    assert.ok(normalizeScheduleTiming({ type: 'daily', time: '09:00', days }).error, JSON.stringify(days) + ' accepted');
  }
});

test('normalizeScheduleTiming: time must be HH:MM, type one of the two the engine knows', () => {
  assert.equal(normalizeScheduleTiming({ type: 'daily', days: [1] }).timing.time, '09:00', 'absent time keeps the documented default');
  for (const time of ['25:00', '9:00', '09:60', 'morgens', '']) {
    assert.ok(normalizeScheduleTiming({ type: 'daily', time, days: [1] }).error, JSON.stringify(time) + ' accepted');
  }
  assert.ok(normalizeScheduleTiming({ type: 'bogus' }).error);
  assert.ok(normalizeScheduleTiming(null).error);
  assert.ok(normalizeScheduleTiming({ type: 'interval', minutes: 0 }).error, '0 minutes is not a rhythm');
  assert.ok(normalizeScheduleTiming({ type: 'interval', minutes: 'nope' }).error);
  assert.equal(normalizeScheduleTiming({ type: 'interval', minutes: 15 }).timing.minutes, 15);
  assert.equal(normalizeScheduleTiming({ type: 'interval', minutes: 99e9 }).timing.minutes, 525600, 'a typo must not become „never again"');
});

test('missingRequiredInputs: required + empty + VISIBLE — in that order', () => {
  const m = {
    inputs: [
      { id: 'a', required: true },
      { id: 'b' },
      { id: 'c', required: true, visibleIf: 'a' },
      { id: 'd', required: true, visibleIf: { field: 'b', equals: 'ja' } },
      { id: 'tags', type: 'tags', required: true },
    ],
  };
  assert.deepEqual(missingRequiredInputs(m, {}), ['a', 'tags'], 'a hidden required field is not missing');
  assert.deepEqual(missingRequiredInputs(m, { a: 'x', tags: ['t'] }), ['c'], 'filling a has to UNHIDE c');
  assert.deepEqual(missingRequiredInputs(m, { a: 'x', b: 'ja', c: 'y', tags: ['t'] }), ['d']);
  assert.deepEqual(missingRequiredInputs(m, { a: 'x', b: 'ja', c: 'y', d: 'z', tags: ['t'] }), []);
  // `false` counts as ANSWERED (an unchecked required checkbox is a decision), `[]` does not — measured
  // against the run form's own rule, which this mirrors; see the drift pin in test/views-data-guards.test.js
  assert.deepEqual(missingRequiredInputs(m, { a: false, tags: [] }), ['tags']);
  assert.deepEqual(missingRequiredInputs(m, { a: '', tags: ['t'] }), ['a'], 'an empty string is not an answer');
  assert.deepEqual(missingRequiredInputs(null, null), [], 'no manifest → nothing to demand');
});

// ------------------------------------------------------- #34 subagent policy (global ⊕ tab → process)
// Everything here is validation of values that would otherwise fail SILENTLY: a misspelled model, a
// ceiling of 0, a "force" with nothing to force. The CLI does not complain about any of them — the
// session just behaves differently than the UI claims, which is the expensive kind of bug.
const { subagentSpawnConfig, normalizeSubagentCfg, mergeSubagentCfg, SUBAGENT_MODELS } = require('../lib/pure');

test('normalizeSubagentCfg: unknown model, absurd ceilings and junk are dropped or clamped', () => {
  assert.deepEqual(normalizeSubagentCfg({ model: 'gpt-5' }), {}, 'a model the Agent tool has no enum for must not be sent');
  assert.deepEqual(normalizeSubagentCfg({ model: 'SONNET' }), { model: 'sonnet' }, 'case is the user-s business, not the CLI-s');
  assert.deepEqual(normalizeSubagentCfg({ maxConcurrent: 0 }), {}, '0 would read as "none" and mean "unset"');
  assert.deepEqual(normalizeSubagentCfg({ maxConcurrent: 999 }), { maxConcurrent: 20 });
  assert.deepEqual(normalizeSubagentCfg({ maxDepth: '4' }), { maxDepth: 4 });
  assert.deepEqual(normalizeSubagentCfg({ maxDepth: 'abc' }), {});
  assert.deepEqual(normalizeSubagentCfg(null), {});
  assert.deepEqual(normalizeSubagentCfg({ allow: true }), { allow: true });
  assert.ok(SUBAGENT_MODELS.includes('inherit'), '"inherit" is a real value of this setting, not an absence');
});

test('mergeSubagentCfg: a tab overrides the global default FIELD BY FIELD', () => {
  const global = { model: 'sonnet', maxConcurrent: 3, maxDepth: 2 };
  assert.deepEqual(mergeSubagentCfg(global, { allow: false }),
    { model: 'sonnet', maxConcurrent: 3, maxDepth: 2, allow: false },
    'setting one field in a tab must not drop the rest of the global policy');
  assert.deepEqual(mergeSubagentCfg(global, { model: 'haiku' }).model, 'haiku');
  assert.deepEqual(mergeSubagentCfg(global, null), global);
  assert.deepEqual(mergeSubagentCfg(null, null), {});
});

test('subagentSpawnConfig: model and ceilings become env, nothing else', () => {
  const r = subagentSpawnConfig({ model: 'sonnet', maxConcurrent: 2 }, null);
  assert.deepEqual(r.env, { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet', CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '2' });
  assert.deepEqual(r.tools, []);
  assert.deepEqual(subagentSpawnConfig(null, null), { env: {}, tools: [], cfg: {} });
});

test('subagentSpawnConfig: "inherit" is passed explicitly — it has to beat an inherited env var', () => {
  assert.equal(subagentSpawnConfig({ model: 'inherit' }, null).env.CLAUDE_CODE_SUBAGENT_MODEL, 'inherit');
});

test('subagentSpawnConfig: force needs a concrete model, otherwise it is dropped', () => {
  assert.equal(subagentSpawnConfig({ force: true }, null).env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, undefined);
  assert.equal(subagentSpawnConfig({ model: 'inherit', force: true }, null).env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, undefined);
  assert.equal(subagentSpawnConfig({ model: 'opus', force: true }, null).env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, '1');
});

test('subagentSpawnConfig: off wins over everything and leaves no half-applied policy behind', () => {
  const r = subagentSpawnConfig({ model: 'opus', maxConcurrent: 5 }, { allow: false });
  // a LIST of tool names, not a ready-made flag: lib/chat.js owns the one --disallowed-tools there is
  assert.deepEqual(r.tools, ['Agent', 'Task']);
  assert.deepEqual(r.env, {});
  assert.deepEqual(r.cfg, { allow: false });
  // …and a tab can switch them back ON against a global "off"
  assert.deepEqual(subagentSpawnConfig({ allow: false }, { allow: true }).tools, []);
});

// ------------------------------------------------------- maxEffortLevel (CLI 2.1.267)
// The cap only helps if "higher" means what the CLI means by it — so the order comes from the one
// list, never from a second copy, and an unknown value must widen nothing.
const { effortLevelsUpTo, EFFORT_LEVELS } = require('../lib/chat');

test('effortLevelsUpTo: caps at the named level, keeps the CLI order', () => {
  assert.deepEqual(effortLevelsUpTo('medium'), ['low', 'medium']);
  assert.deepEqual(effortLevelsUpTo('max'), EFFORT_LEVELS);
  assert.deepEqual(effortLevelsUpTo('HIGH'), ['low', 'medium', 'high'], 'the setting is a user value, not a token');
});

test('effortLevelsUpTo: no cap and an unknown cap both mean "everything"', () => {
  assert.deepEqual(effortLevelsUpTo(undefined), EFFORT_LEVELS);
  assert.deepEqual(effortLevelsUpTo(''), EFFORT_LEVELS);
  assert.deepEqual(effortLevelsUpTo('ludicrous'), EFFORT_LEVELS, 'a typo must not silently forbid every level');
  assert.notEqual(effortLevelsUpTo('low'), EFFORT_LEVELS, 'and it must be a copy — the caller may sort it');
});

// ------------------------------------------------------- ultracode (dynamic-workflow orchestration)
// Everything asserted here was MEASURED against claude.exe 2.1.285 with a token-free control-request
// probe; the surprising half is in `ultracodeState`.
const { resolveUltracode, ultracodeSpawnSettings, ultracodeState } = require('../lib/pure');

test('resolveUltracode: a tab decides for itself, otherwise the global default applies', () => {
  assert.equal(resolveUltracode(true, undefined), true, 'untouched tab inherits ON');
  assert.equal(resolveUltracode(false, undefined), false);
  assert.equal(resolveUltracode(undefined, undefined), false, 'nothing set anywhere = off');
  assert.equal(resolveUltracode(true, false), false, 'a tab may switch it OFF against a global ON');
  assert.equal(resolveUltracode(false, true), true, '…and ON against a global OFF');
  // the three-state distinction is the whole point: `false` is a decision, `undefined` is inheritance
  assert.equal(resolveUltracode(true, null), true, 'null is not a decision');
});

test('ultracodeSpawnSettings: only ON produces a flag value', () => {
  assert.equal(ultracodeSpawnSettings(true), '{"ultracode":true}');
  // off must not add a --settings layer at all — an ordinary chat's argv stays exactly as it was
  for (const v of [false, undefined, null, 'true', 1]) assert.equal(ultracodeSpawnSettings(v), null, String(v));
});

test('ultracodeState: „requested" and „in effect" are NOT the same thing', () => {
  // measured with --model haiku: apply_flag_settings{ultracode:true} answered `success`, and afterwards
  // the session reported requested=true / ultracode=false. A UI believing the control response lies.
  const haiku = ultracodeState({ model: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0', ultracode: false, ultracodeRequested: true, ultracodeAvailable: false }, false);
  assert.equal(haiku.state, 'ineffective');
  assert.equal(haiku.reason, 'model');
  assert.equal(haiku.model, 'eu.anthropic.claude-haiku-4-5-20251001-v1:0', 'the reason names the model, so it has to travel');

  const on = ultracodeState({ model: 'eu.anthropic.claude-sonnet-5', ultracode: true, ultracodeRequested: true, ultracodeAvailable: true }, true);
  assert.equal(on.state, 'on');
  assert.equal(on.reason, '', 'nothing to explain when it works');

  const off = ultracodeState({ model: 'eu.anthropic.claude-sonnet-5', ultracode: false, ultracodeRequested: false, ultracodeAvailable: true }, true);
  assert.equal(off.state, 'off');
  assert.equal(off.reason, '');
});

test('ultracodeState: „off" can carry a reason — so the chip must key on `available`, not on the reason', () => {
  // THE trap behind the muted „Ultracode aus" chip. The reason branch runs on `!active && (requested ||
  // !available)`, so available=false + requested=false produces state 'off' WITH a non-empty reason. A chip
  // that decided „is this possible here?" by looking at `reason === ''` would therefore show the muted
  // „you could switch this on" state on a model that can never do it — an invitation to a dead end. And the
  // combination had no test at all, which is why the fix had to start by writing one.
  const r = ultracodeState({ model: 'claude-haiku-4-5', ultracode: false, ultracodeRequested: false, ultracodeAvailable: false }, false);
  assert.equal(r.state, 'off', 'nobody asked for it, so it is not „ineffective"');
  assert.equal(r.available, false, '…and THIS is the field that says whether it is possible');
  assert.ok(r.reason, 'the reason is non-empty even for an off that nobody asked about: ' + JSON.stringify(r.reason));
  // the one that really is a plain off: possible, just not switched on
  const plain = ultracodeState({ model: 'claude-sonnet-5', ultracode: false, ultracodeRequested: false, ultracodeAvailable: true }, true);
  assert.equal(plain.state, 'off');
  assert.equal(plain.available, true);
  assert.equal(plain.reason, '');
});

test('ultracodeState: with a capable model, unavailable can only mean workflows are off', () => {
  // ultracodeAvailable = „workflows on" AND „model does xhigh" — so the model half decides the wording
  const r = ultracodeState({ model: 'eu.anthropic.claude-sonnet-5', ultracode: false, ultracodeRequested: true, ultracodeAvailable: false }, true);
  assert.equal(r.reason, 'workflows_off');
  // …and without an opinion on the model we must not claim to know which half it was
  const unknown = ultracodeState({ model: 'x', ultracode: false, ultracodeRequested: true, ultracodeAvailable: false }, undefined);
  assert.equal(unknown.reason, 'unavailable');
});

test('ultracodeState: a missing answer is UNKNOWN — never a false „on", and never a fabricated „off"', () => {
  // H1. „No answer" is a shape this function sees for real: controlRequest resolves {ok:true,
  // unconfirmed:true} on its 5 s timeout, getChatSettings turns that into `applied: null`, and the route
  // hands that null straight to here. The old code coerced it to `{}` — and `{}` reads as „nobody requested
  // it, it is available", so a session that said NOTHING was published to the browser as a complete
  // `{state:'off', available:true}`: „Ultracode aus · dieses Modell könnte es", composed out of a silence.
  // Degrading to „off" is not the conservative choice here, because „off" is itself a claim.
  for (const bad of [null, undefined, 'nope', 42]) {
    const r = ultracodeState(bad, true);
    assert.equal(r.state, 'unknown', String(bad));
    assert.equal(r.active, null, 'null, not false — false is an assertion about the session');
    assert.equal(r.requested, null);
    assert.equal(r.available, null, 'the field the chip keys on for „is this possible" must not say true either');
    assert.equal(r.reason, '', 'nothing was read, so there is nothing to explain');
  }
  // …and a real answer still produces a real verdict, so the branch above cannot swallow the normal case
  assert.equal(ultracodeState({ ultracode: false, ultracodeRequested: false, ultracodeAvailable: true }, true).state, 'off');
});

test('ultracodeState: „unwirksam" trägt IMMER einen Grund', () => {
  // Befund eines echten Ultracode-Workflows über diese Datei (2026-10-01): bei requested=true,
  // available=true und ultracode=false fiel `reason` leer aus — der Chip war markiert und schwieg
  // darüber, warum. Die Form sollte die CLI nicht produzieren; wenn sie es doch tut, muss die Anzeige
  // trotzdem etwas sagen können.
  const r = ultracodeState({ model: 'sonnet', ultracode: false, ultracodeRequested: true, ultracodeAvailable: true }, true);
  assert.equal(r.state, 'ineffective');
  assert.equal(r.reason, 'unavailable', 'markiert, aber ohne Grund = genau der Zustand, den die drei Zustände verhindern sollen');
  // …und das gilt für jede Variante von `modelSupported`
  for (const sup of [true, false, undefined, null]) {
    const x = ultracodeState({ model: 'm', ultracode: false, ultracodeRequested: true, ultracodeAvailable: true }, sup);
    assert.equal(x.state, 'ineffective', String(sup));
    assert.ok(x.reason, 'ohne Grund bei modelSupported=' + String(sup));
  }
});

// ------------------------------------------------------- buildSpawnPolicy (BACKEND-M1)
// The chat start route and the headless engine used to build their launch options separately — and the
// engine built almost nothing: no guardrails, no corrections, no subagent policy, while comments and
// README claimed the opposite. One function for both callers, so the two can no longer drift apart.
const { buildSpawnPolicy, headlessPermissionMode, HEADLESS_PERM_MODES } = require('../lib/pure');
const PREFS_ALL_ON = {
  guardrails: 'T01 ist das Testsystem', ultracode: true, includeHookEvents: true,
  subagents: { allow: false }, mcpStartupWaitMs: 4000,
};
const CORR = [{ text: 'Belege immer mit Dateipfad' }];

test('buildSpawnPolicy: a chat gets the full global layer plus its own tab settings', () => {
  const p = buildSpawnPolicy(PREFS_ALL_ON, CORR, { mode: 'chat', body: { appendSystem: 'Kurz antworten', guardrails: 'nur lesen' } });
  assert.match(p.appendSystem, /T01 ist das Testsystem/);
  assert.match(p.appendSystem, /nur lesen/);
  assert.match(p.appendSystem, /Kurz antworten/);
  assert.match(p.appendSystem, /Belege immer mit Dateipfad/);
  assert.match(p.appendSystem, /# Offene Punkte/, 'a chat has the UI that reads the protocol');
  assert.equal(p.ultracode, true, 'an untouched tab inherits the global ultracode');
  assert.equal(p.includeHookEvents, true);
  assert.equal(p.forwardSubagentText, true, 'default on for a chat');
  assert.deepEqual(p.subagents.tools, ['Agent', 'Task']);
  assert.equal(p.mcpStartupWaitMs, 4000);
});

test('buildSpawnPolicy: headless inherits the protective layer, not the UI-only one', () => {
  const p = buildSpawnPolicy(PREFS_ALL_ON, CORR, { mode: 'headless' });
  assert.match(p.appendSystem, /T01 ist das Testsystem/, 'guardrails reach the unattended run');
  assert.match(p.appendSystem, /Belege immer mit Dateipfad/, 'so do the corrections');
  assert.doesNotMatch(p.appendSystem, /Offene Punkte/, 'nobody reads open points in a headless run');
  assert.deepEqual(p.subagents.tools, ['Agent', 'Task'], 'subagent off-switch holds headless too');
  assert.equal(p.mcpStartupWaitMs, 4000);
  assert.equal(p.forwardSubagentText, false, 'forwarded subagent text would leak into the run result');
  assert.equal(p.includeHookEvents, false);
  assert.equal(p.ultracode, false, 'the global ultracode switch is never inherited headless');
});

test('buildSpawnPolicy: headless ultracode only through the schedule opt-in, and a body is ignored', () => {
  assert.equal(buildSpawnPolicy({}, [], { mode: 'headless', schedule: { ultracode: true } }).ultracode, true);
  assert.equal(buildSpawnPolicy(PREFS_ALL_ON, [], { mode: 'headless', schedule: { ultracode: 'yes' } }).ultracode, false, 'only a literal true');
  // a headless caller has no tab — a body that slipped in must not widen anything
  const p = buildSpawnPolicy({}, [], { mode: 'headless', body: { ultracode: true, guardrails: 'aus dem Body', subagents: { allow: false } } });
  assert.equal(p.ultracode, false);
  assert.doesNotMatch(p.appendSystem || '', /aus dem Body/);
  assert.deepEqual(p.subagents.tools, []);
});

test('buildSpawnPolicy: switches off in the prefs are honoured, garbage degrades to defaults', () => {
  const p = buildSpawnPolicy({ useCorrections: false, openPoints: false, forwardSubagentText: false }, CORR, { mode: 'chat', body: {} });
  assert.doesNotMatch(p.appendSystem || '', /Belege immer/, 'useCorrections:false drops them');
  assert.doesNotMatch(p.appendSystem || '', /Offene Punkte/, 'openPoints:false drops the protocol');
  assert.equal(p.forwardSubagentText, false);
  for (const bad of [null, undefined, 'x', 42]) {
    const q = buildSpawnPolicy(bad, bad, { mode: 'headless' });
    assert.equal(q.ultracode, false, String(bad));
    assert.equal(q.forwardSubagentText, false, String(bad));
    assert.deepEqual(q.subagents.tools, [], String(bad));
  }
});

// ------------------------------------------------------- prompt snapshot (PR-S)
// Measured 2026-10-03 against 2.1.288: without `--system-prompt-snapshot off` a resumed session keeps the
// system prompt recorded at its first request (until compaction), so an edited guardrail never arrives.
// The decision has two inputs — the setting and the --help proof — and exactly one of four combinations
// produces the flag.
const { promptSnapshotArg, normalizePromptSnapshot, PROMPT_SNAPSHOT_MODES } = require('../lib/pure');
test('promptSnapshotArg: only the default/off setting AND a proven CLI produce the flag', () => {
  assert.deepEqual(PROMPT_SNAPSHOT_MODES, ['off', 'on']);
  assert.equal(promptSnapshotArg(undefined, true), 'off', 'the default is off (Julian, 2026-10-03)');
  assert.equal(promptSnapshotArg('off', true), 'off');
  assert.equal(promptSnapshotArg('on', true), null, "'on' is the CLI's own default → no flag, argv unchanged");
  for (const flag of [false, null, undefined, 'true', 1]) {
    assert.equal(promptSnapshotArg('off', flag), null, 'no proof (' + String(flag) + ') → no flag: an old CLI would refuse to start');
  }
  // a hand-edited typo lands on the documented default, never on a third state
  for (const v of ['ON', 'an', true, 1, {}, '']) assert.equal(normalizePromptSnapshot(v), 'off', JSON.stringify(v));
  assert.equal(normalizePromptSnapshot('on'), 'on');
});

test('buildSpawnPolicy: the prompt snapshot follows the GLOBAL setting in both modes; a body cannot touch it', () => {
  for (const mode of ['chat', 'headless']) {
    assert.equal(buildSpawnPolicy({}, [], { mode, snapshotFlag: true }).systemPromptSnapshot, 'off', mode);
    assert.equal(buildSpawnPolicy({ promptSnapshot: 'on' }, [], { mode, snapshotFlag: true }).systemPromptSnapshot, null, mode);
    assert.equal(buildSpawnPolicy({}, [], { mode }).systemPromptSnapshot, null, mode + ': no proof passed → no flag');
  }
  // one setting, no per-tab override: a body field of the same name is not read
  assert.equal(buildSpawnPolicy({ promptSnapshot: 'on' }, [], { mode: 'chat', body: { promptSnapshot: 'off', systemPromptSnapshot: 'off' }, snapshotFlag: true }).systemPromptSnapshot, null);
  assert.equal(buildSpawnPolicy({}, [], { mode: 'chat', body: { promptSnapshot: 'on' }, snapshotFlag: true }).systemPromptSnapshot, 'off');
  for (const bad of [null, undefined, 'x', 42]) assert.equal(buildSpawnPolicy(bad, bad, { mode: 'headless', snapshotFlag: true }).systemPromptSnapshot, 'off', String(bad));
});

// ------------------------------------------------------- headlessPermissionMode (SEC-H)
// `auto`/`bypassPermissions`/`dontAsk` decide without asking, i.e. without ever reaching the engine's
// can_use_tool responder — and that responder is where HEADLESS_ALLOWED_TOOLS is enforced.
test('headlessPermissionMode: modes that skip the responder are capped to acceptEdits', () => {
  for (const m of ['bypassPermissions', 'auto', 'dontAsk', 'irgendwas']) {
    assert.deepEqual(headlessPermissionMode(m, { allowWrites: true }), { mode: 'acceptEdits', capped: m }, m);
  }
});
test('headlessPermissionMode: asking modes pass, read-only and dry runs are plan', () => {
  for (const m of HEADLESS_PERM_MODES) assert.deepEqual(headlessPermissionMode(m, { allowWrites: true }), { mode: m, capped: null }, m);
  assert.deepEqual(headlessPermissionMode(undefined, { allowWrites: true }), { mode: 'acceptEdits', capped: null }, 'manifest without a mode');
  assert.deepEqual(headlessPermissionMode('bypassPermissions', { allowWrites: false }), { mode: 'plan', capped: null }, 'read-only never escalates');
  assert.deepEqual(headlessPermissionMode('acceptEdits', { allowWrites: true, dryRun: true }), { mode: 'plan', capped: null });
  assert.deepEqual(headlessPermissionMode('acceptEdits'), { mode: 'plan', capped: null }, 'no opts = read-only');
});

// ------------------------------------------------------- fake-claude.js: the apply_flag_settings contract
// Not a test of lib/pure, but of the one file every other test TRUSTS. fake-claude.js is where the CLI's
// apply_flag_settings behaviour is reproduced, so a fake that models it wrongly makes the A0 route test pass
// for the wrong reason — the fake would simply never drop ultracode and the regression test would be green
// with the bug still in place. Three properties, each read out of claude.exe 2.1.286's stdio handler (`tv`):
//   · an effort-only request clears ultracode — but ONLY when the level actually changes (`Efn`);
//   · carrying the ultracode key skips that coupling entirely (which is the fix);
//   · `effortLevel: null` means „auto" and is acted on, while '' and an unknown name are SILENT no-ops.
// Driven as a direct control conversation (no server, no model): every assertion waits for the answer to the
// request it sent, so there is nothing timing-dependent here beyond „the child answers at all".
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
function fakeSession(extraArgs) {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'fake-claude.js'),
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', ...extraArgs],
  { stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map();
  readline.createInterface({ input: p.stdout }).on('line', (l) => {
    let o; try { o = JSON.parse(l); } catch { return; }
    const id = o.type === 'control_response' && o.response && o.response.request_id;
    if (id && waiting.has(id)) { const f = waiting.get(id); waiting.delete(id); f(o.response); }
  });
  let n = 0;
  const ask = (request) => new Promise((resolve, reject) => {
    const id = 'req-' + (++n);
    const to = setTimeout(() => reject(new Error('fake-claude never answered ' + request.subtype)), 10000);
    waiting.set(id, (r) => { clearTimeout(to); resolve(r); });
    p.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n');
  });
  return {
    ask,
    applied: async () => (await ask({ subtype: 'get_settings' })).response.applied,
    end: () => { try { p.stdin.end(); } catch { /* already gone */ } },
  };
}

test('fake-claude: an effort-only apply_flag_settings drops ultracode — but ONLY when the level changes', async () => {
  const s = fakeSession(['--model', 'claude-sonnet-5', '--effort', 'high', '--settings', '{"ultracode":true}']);
  try {
    assert.equal((await s.applied()).ultracode, true, 'launched with it on');
    // the no-op exception: re-sending the level the session already runs at leaves ultracode alone. This is
    // why a test that re-sends the SAME level proves nothing about A0 — and why the fake must not clear
    // unconditionally, or that distinction disappears.
    await s.ask({ subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } });
    assert.equal((await s.applied()).ultracode, true, 'a no-op effort set must change nothing');
    // a DIFFERENT level with no ultracode key → the coupling fires. THIS is A0.
    await s.ask({ subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } });
    const a = await s.applied();
    assert.equal(a.effort, 'low');
    assert.equal(a.ultracode, false, 'the CLI drops ultracode for an effort-only change');
    // …and carrying the key skips the coupling: both settings in one request, which is the fix
    await s.ask({ subtype: 'apply_flag_settings', settings: { effortLevel: 'xhigh', ultracode: true } });
    const b = await s.applied();
    assert.equal(b.effort, 'xhigh');
    assert.equal(b.ultracode, true, 'and the order of the two keys does not matter either');
    await s.ask({ subtype: 'apply_flag_settings', settings: { ultracode: true, effortLevel: 'max' } });
    const c = await s.applied();
    assert.equal(c.effort, 'max');
    assert.equal(c.ultracode, true);
  } finally { s.end(); }
});

test("fake-claude: effortLevel null is „auto\", '' and an unknown name are SILENT no-ops", async () => {
  const s = fakeSession(['--model', 'claude-sonnet-5', '--effort', 'high', '--settings', '{"ultracode":true}']);
  try {
    // '' → nothing happens at all, and the response is STILL success. That is the whole reason the panel
    // cannot learn from the response whether its switch worked.
    const r = await s.ask({ subtype: 'apply_flag_settings', settings: { effortLevel: '' } });
    assert.equal(r.subtype, 'success', 'the response cannot report the failure');
    let a = await s.applied();
    assert.equal(a.effort, 'high', "'' leaves the level alone");
    assert.equal(a.ultracode, true, '…and therefore leaves ultracode alone too');
    await s.ask({ subtype: 'apply_flag_settings', settings: { effortLevel: 'quatsch' } });
    a = await s.applied();
    assert.equal(a.effort, 'high', 'an unrecognised level is ignored, not refused');
    assert.equal(a.ultracode, true);
    // null IS acted on — it is the CLI's encoding of „no explicit level", reported back as effort: null
    await s.ask({ subtype: 'apply_flag_settings', settings: { effortLevel: null, ultracode: true } });
    a = await s.applied();
    assert.equal(a.effort, null, 'auto reads back as null');
    assert.equal(a.ultracode, true);
  } finally { s.end(); }
});

test('fake-claude: ultracode is ACCEPTED on a model that cannot honour it (the stdio handler never refuses)', async () => {
  // Connection-specific and deliberately so: 2.1.286's Remote-Control handler DOES refuse this and names
  // the reason, the stdio one the panel uses has no availability check at all. Pinned here so nobody
  // „corrects" the fake into refusing — the whole three-state chip exists because it does not.
  const s = fakeSession(['--model', 'claude-haiku-4-5']);
  try {
    const r = await s.ask({ subtype: 'apply_flag_settings', settings: { ultracode: true } });
    assert.equal(r.subtype, 'success', 'no refusal');
    const a = await s.applied();
    assert.equal(a.ultracodeRequested, true, 'the wish is recorded…');
    assert.equal(a.ultracode, false, '…and separately from the effect');
    assert.equal(a.ultracodeAvailable, false);
  } finally { s.end(); }
});
