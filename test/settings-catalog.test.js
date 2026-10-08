'use strict';
// PR-11 — the options catalog grew from 2 entries to 20, and the one rule that matters is „every catalog
// entry needs a PROVEN key". This suite is that proof, kept inside the repo:
// test/fixtures/cli-settings-schema-2.1.288.json carries the 182 top-level keys (and the enum value lists
// for the keys the panel offers as a select) extracted from the settings schema literal in claude.exe
// 2.1.288 — see the `method` field in that file for the offset and the scripts.
//
// WHY IT IS A SOURCE SCAN. views.js is browser code with `t()` calls in it, so the catalog cannot simply be
// require'd. The entries are read out of the source instead — which also catches the thing a unit test on an
// exported array would not: a key typed straight into the literal.
//
// WHAT THIS CANNOT PROVE, stated because the fixture states it too: 182 is a LOWER BOUND. Ten top-level
// spreads (nine `...!1`, i.e. feature-flagged groups compiled to `false`, one env-driven, one generated)
// hide further keys. So this suite can only ever catch an INVENTED key, never a missing one — which is the
// direction that matters: a catalog entry for a key the CLI does not know is worse than a gap, because the
// user writes it into settings.json and nothing ever reads it.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { settingsBoolState } = require('../public/js/settings-catalog');

const ROOT = path.join(__dirname, '..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/cli-settings-schema-2.1.288.json'), 'utf8'));
const VIEWS = fs.readFileSync(path.join(ROOT, 'public/js/views.js'), 'utf8');

// the body of one `const NAME = () => [ … ];`, comment lines dropped
function listBody(name) {
  const at = VIEWS.indexOf('const ' + name + ' = () => [');
  assert.ok(at > 0, name + ' not found — did views.js change shape?');
  const end = VIEWS.indexOf('\n];', at);
  assert.ok(end > at, name + ' has no end');
  return VIEWS.slice(at, end).split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
}
// one entry per `{ key: '…', … }` line
function entries(name) {
  return listBody(name).split(/\r?\n/).filter((l) => /\{\s*key:\s*'/.test(l)).map((line) => {
    const g = (re) => { const m = re.exec(line); return m ? m[1] : null; };
    return {
      line,
      key: g(/key:\s*'([^']+)'/),
      type: g(/type:\s*'([^']+)'/),
      def: g(/\bdef:\s*([^,}]+)/),
      werte: g(/werte:\s*\[([^\]]*)\]/),
      veraltet: g(/veraltet:\s*'([^']+)'/),
      nurTerminal: /nurTerminal:\s*true/.test(line),
      file: g(/file:\s*'([^']+)'/),
    };
  });
}
const CATALOG = entries('SETTINGS_CATALOG');
const REF = entries('SETTINGS_REF');

describe('settings catalog — every entry names a key the CLI really has', () => {
  it('the fixture is the one it claims to be', () => {
    assert.equal(SCHEMA.cliVersion, '2.1.288');
    assert.equal(SCHEMA.keyCount, SCHEMA.keys.length);
    assert.equal(SCHEMA.keys.length, 182);
    assert.equal(new Set(SCHEMA.keys).size, 182, 'duplicates in the extracted key list');
    // the three keys a naive regex invented (zod helper names from the nested autoMode object, and one key
    // outside the block) must NOT be in here — they are the reason the extraction walks with depth tracking
    for (const ghost of ['shape', 'permissionsShape', 'xaaIdp']) {
      assert.equal(SCHEMA.keys.includes(ghost), false, ghost + ' is a zod helper, not a settings key');
    }
    assert.match(SCHEMA.caveat, /LOWER BOUND/);
  });

  it('both lists were really parsed, and the number the docs quote is the number there is', () => {
    // EXACT, not a minimum: README and CHANGELOG both name „20 Schalter", and a count in prose that nobody
    // checks is how this panel ends up claiming something again. The first draft of those two sentences said
    // 23 — the sight check counted the rendered rows and found 22 — and the review then took `theme` and
    // `effortLevel` out again, because the quick settings on the same page already control them (see the note
    // at the end of SETTINGS_CATALOG). Change the catalog → change this line → change the two documents.
    assert.equal(CATALOG.length, 20, 'the catalog has ' + CATALOG.length + ' entries; README/CHANGELOG say 20');
    assert.ok(REF.length >= 17, 'only ' + REF.length + ' reference entries parsed');
    assert.equal(CATALOG.every((e) => e.key), true);
    assert.equal(REF.every((e) => e.key), true);
  });

  it('no catalog entry names a key that is not in the schema', () => {
    const known = new Set(SCHEMA.keys);
    const bad = [...CATALOG, ...REF].map((e) => e.key).filter((k) => !known.has(k));
    assert.deepEqual([...new Set(bad)], [], 'keys the CLI schema does not have — a user would write them for nothing');
  });

  it('no key is offered twice, and no key is both a switch and a reference entry', () => {
    const c = CATALOG.map((e) => e.key), r = REF.map((e) => e.key);
    assert.equal(new Set(c).size, c.length, 'duplicate in SETTINGS_CATALOG: ' + c.filter((k, i) => c.indexOf(k) !== i));
    assert.equal(new Set(r).size, r.length, 'duplicate in SETTINGS_REF: ' + r.filter((k, i) => r.indexOf(k) !== i));
    // ONE key is deliberately in BOTH lists, and only because its value space is bigger than its control can
    // express: `attribution` is a union of a boolean and a per-channel object — the switch writes the boolean
    // arm, the reference inserts the object one. Every OTHER overlap is an accident and gives the user two
    // controls for one setting, which is why this list is exact rather than a minimum. (`theme` was the second
    // entry here until the review moved it out of SETTINGS_CATALOG entirely — see the quick-settings test
    // below.)
    const both = c.filter((k) => r.includes(k)).sort();
    assert.deepEqual(both, ['attribution'],
      'unintended overlap between switch and reference: ' + both.join(', '));
  });

  it('and no catalog key has a SECOND live control in the quick settings', () => {
    // THE GAP THIS CLOSES. The test above compared the catalog against the reference list and nothing else, so
    // it could not see the two controls the same settings page has had all along: #qsTheme and #qsEffort, which
    // write `theme` and `effortLevel` through patchMain. PR-11 added both keys to SETTINGS_CATALOG as well,
    // with a DIFFERENT value range (theme: three options up there, seven down here) — so setting `theme` from
    // the catalog to one of the four extra values left `$('#qsTheme').value` with no matching option,
    // selectedIndex -1, and the dropdown above went blank. The quick settings only edit the textarea while the
    // catalog saves at once, so the two can disagree about the state of one key even when the ranges match.
    // Scanned off the WRITE, not off the markup: `patchMain('<key>', …)` is what actually reaches settings.json.
    const quick = [...VIEWS.matchAll(/patchMain\('([^']+)'/g)].map((m) => m[1]);
    assert.ok(quick.length >= 3, 'only ' + quick.length + ' quick-settings writes found — did views.js move?');
    assert.ok(quick.includes('theme') && quick.includes('effortLevel'), 'the two keys this test is about are gone');
    const doppelt = CATALOG.map((e) => e.key).filter((k) => quick.includes(k)).sort();
    assert.deepEqual(doppelt, [],
      'these keys have a control in the quick settings AND a row in the options catalogue: ' + doppelt.join(', '));
  });
});

describe('settings catalog — a select offers the CLI\'s own values, not a hand-written list', () => {
  it('every select value list matches the enum extracted from the schema', () => {
    const selects = CATALOG.filter((e) => e.type === 'select');
    assert.ok(selects.length >= 5, 'only ' + selects.length + ' select entries — the new field type is barely used');
    for (const e of selects) {
      assert.ok(e.werte, e.key + ' is a select with no value list');
      const got = e.werte.split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
      const want = SCHEMA.enumValues[e.key];
      assert.ok(want, 'no extracted enum for ' + e.key + ' — a select whose values nobody confirmed');
      assert.deepEqual(got, want, e.key + ': the offered values are not the schema\'s');
    }
  });

  it('a key whose value list could NOT be resolved is absent rather than guessed', () => {
    // `maxEffortLevel` is `j(lu)` — a two-letter variable that cannot be located unambiguously in the
    // bundle. It would be plausible to reuse effortLevel's four levels; that would be a guess, and this
    // pins that the guess was not made.
    assert.equal(SCHEMA.keys.includes('maxEffortLevel'), true, 'the key exists…');
    assert.equal(CATALOG.some((e) => e.key === 'maxEffortLevel'), false, '…but its values do not, so it is not offered');
    assert.equal('maxEffortLevel' in SCHEMA.enumValues, false);
  });

  it('a bool entry states its default as true, false or NULL — never silently', () => {
    for (const e of CATALOG.filter((x) => x.type === 'bool')) {
      assert.ok(e.def !== null, e.key + ' is a bool without a `def` — the row would claim a default by omission');
      assert.match(e.def.trim(), /^(true|false|null)$/, e.key + ' has def ' + e.def);
    }
    // the three the CLI's own text states, and three where it does not
    const def = (k) => (CATALOG.find((e) => e.key === k) || {}).def;
    assert.equal(def('includeCoAuthoredBy').trim(), 'true');
    assert.equal(def('respectGitignore').trim(), 'true');
    assert.equal(def('workflowKeywordTriggerEnabled').trim(), 'true');
    assert.equal(def('enableWorkflows').trim(), 'null', 'the CLI says „Unset = default by plan" — so nobody may claim one');
    assert.equal(def('attribution').trim(), 'null');
    assert.equal(def('autoCompactEnabled').trim(), 'null');
  });

  it('the painter really handles all three types and the three-valued default', () => {
    // The step from the entry to the control, guarded by source: the previous version showed `c.def` whether
    // or not a default was known, so a null would have rendered as „off" — a default nobody stated.
    const painter = VIEWS.slice(VIEWS.indexOf('function renderMoreSettings'), VIEWS.indexOf('function renderCatalog'));
    assert.match(painter, /c\.type === 'bool'/);
    assert.match(painter, /c\.type === 'select'/);
    assert.match(painter, /indeterminate = true/, 'an unknown default no longer renders as indeterminate');
    assert.match(painter, /c\.werte/);
    assert.match(painter, /c\.nurTerminal/);
    assert.match(painter, /c\.veraltet/);
    // the empty option DELETES the key — „unset" is its own state and must not become one of the values
    assert.match(painter, /selEl\.value === '' \? null : selEl\.value/);
  });
});

// ---------------------------------------------------------------------------------------------------
// THE FOURTH SWITCH STATE — a value that is not a boolean at all
// ---------------------------------------------------------------------------------------------------
// Found in review of PR-11, and it is this project's failure class in MIRROR form: not „the surface claims
// something nobody confirmed" but „something CONFIRMED is thrown away". `attribution` is `Fe([M(), i])` in
// the schema — a union of a boolean and { commit, pr, sessionUrl } — and the CLI's own describe says
// `{ "commit": "", "pr": "" }` is the same as `false`, i.e. attribution OFF, while recommending the object
// form for settings files shared across versions. The checkbox did `!!s[key]`, so it printed „AN" for
// exactly that value, and one click wrote a boolean over the per-channel configuration.
describe('settings catalog — a switch over a value that is not a boolean', () => {
  const ATTR = CATALOG.find((e) => e.key === 'attribution');

  it('the OFF object does not read as „AN", and the switch cannot write over it', () => {
    // the exact value the panel's own reference template inserts for this key (views.js insertSetting)
    const st = settingsBoolState({ key: 'attribution', def: null }, { attribution: { commit: '', pr: '' } });
    assert.equal(st.haken, false, 'an object is truthy — the box claimed attribution was ON while it is OFF');
    assert.equal(st.fremd, true);
    assert.equal(st.unbestimmt, false, 'this is not „nobody stated a default" — the file states a value');
    assert.equal(st.schreibbar, false, 'a click here would replace the per-channel object with a boolean');
  });

  it('…and that holds for every non-boolean, not just the empty one', () => {
    for (const v of [{ commit: 'x', pr: 'y' }, { sessionUrl: false }, {}, [], 'false', 0, 1, null]) {
      const st = settingsBoolState({ key: 'attribution', def: null }, { attribution: v });
      assert.equal(st.fremd, true, 'not recognised as a non-boolean: ' + JSON.stringify(v));
      assert.equal(st.schreibbar, false, 'writable over: ' + JSON.stringify(v));
      assert.equal(st.haken, false, 'shown as ON: ' + JSON.stringify(v));
    }
  });

  it('the three states that existed before are unchanged', () => {
    // set to a real boolean — including `false`, which must not be mistaken for „not set"
    assert.deepEqual(settingsBoolState({ key: 'attribution', def: null }, { attribution: false }),
      { haken: false, unbestimmt: false, fremd: false, schreibbar: true, standard: false, gesetzt: true });
    assert.deepEqual(settingsBoolState({ key: 'attribution', def: null }, { attribution: true }),
      { haken: true, unbestimmt: false, fremd: false, schreibbar: true, standard: false, gesetzt: true });
    // unset + the CLI states a default → show the default, labelled
    const d = settingsBoolState({ key: 'respectGitignore', def: true }, {});
    assert.equal(d.haken, true); assert.equal(d.standard, true); assert.equal(d.unbestimmt, false);
    // unset + nobody stated one → INDETERMINATE, never „off"
    const u = settingsBoolState({ key: 'attribution', def: null }, {});
    assert.equal(u.unbestimmt, true); assert.equal(u.standard, false); assert.equal(u.fremd, false);
    // junk in, no throw: the settings file is the user's, not ours
    assert.doesNotThrow(() => settingsBoolState(null, null));
    assert.equal(settingsBoolState(null, null).unbestimmt, true);
  });

  it('the painter uses the pure seam and refuses to wire a click on the fourth state', () => {
    // The pure function can only prove the DECISION. That a non-writable state really gets no `onchange` is
    // markup, so it is read from the painter — the same split ctx-breakdown.test.js uses, and for the same
    // reason: the half that went untested last time was the visible one.
    const painter = VIEWS.slice(VIEWS.indexOf('function renderMoreSettings'), VIEWS.indexOf('function renderCatalog'));
    assert.match(painter, /settingsBoolState\(c, s\)/, 'the painter decides for itself again');
    assert.match(painter, /if \(st\.fremd\) \{[\s\S]*?cb\.disabled = true;/, 'the non-boolean state no longer disables the box');
    assert.match(painter, /\} else \{\s*\n\s*cb\.onchange = \(\) => patchSetting\(c\.key, cb\.checked\);/,
      'the click handler is wired unconditionally again — it would overwrite the object form');
    assert.match(painter, /t\('views\.catFremdeForm'\)/, 'nothing tells the user what is really in the file');
    // and the entry that makes this reachable is still a bool row (if it ever becomes a select, this test
    // is about nothing and should be deleted rather than left passing)
    assert.ok(ATTR && ATTR.type === 'bool', 'attribution is no longer a switch — re-check this block');
  });

  it('the script is loaded in the browser too, or the painter is undefined at runtime', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    assert.match(html, /<script src="\/js\/settings-catalog\.js">/);
    // before views.js, which calls it
    assert.ok(html.indexOf('/js/settings-catalog.js') < html.indexOf('/js/views.js'));
  });
});

describe('settings catalog — the two things the task asked to be visible', () => {
  it('includeCoAuthoredBy is marked deprecated and points at attribution', () => {
    // The CLI's own text: „Deprecated: Use attribution instead." The switch STAYS (the key still works and
    // still defaults to true) — dropping a working control because a successor exists would be the other
    // half of this project's failure class.
    const e = CATALOG.find((x) => x.key === 'includeCoAuthoredBy');
    assert.ok(e, 'the deprecated key was removed instead of marked');
    assert.equal(e.veraltet, 'attribution');
    assert.ok(CATALOG.some((x) => x.key === 'attribution'), 'the successor is not offered');
  });

  it('the keyword trigger is marked „nur Terminal", and so is everything else that cannot act here', () => {
    const kw = CATALOG.find((x) => x.key === 'workflowKeywordTriggerEnabled');
    assert.ok(kw, 'the keyword trigger is not in the catalog');
    assert.equal(kw.nurTerminal, true);
    // …and the marking says in its tooltip that it is REASONED FROM CODE, not measured — the distinction
    // this project pays for whenever it is skipped
    const dict = fs.readFileSync(path.join(ROOT, 'public/js/i18n.js'), 'utf8');
    assert.match(dict, /'views\.catNurTerminalWarum': '[^']*nicht gemessen/);
    assert.match(dict, /'views\.catNurTerminalWarum': '[^']*not measured/);
    // the workflow pair the task named explicitly
    assert.ok(CATALOG.some((x) => x.key === 'enableWorkflows'));
    assert.ok(CATALOG.some((x) => x.key === 'workflowSizeGuideline' && x.type === 'select'));
  });

  it('every REF example is valid JSON-ish for its key, and `worktree` uses a real subfield', () => {
    // a first draft inserted `{ include: [] }` for worktree — a key the schema does not have. The object's
    // real fields are symlinkDirectories · sparsePaths · baseRef · bgIsolation · location.
    const wt = REF.find((e) => e.key === 'worktree');
    assert.ok(wt);
    assert.match(wt.line, /symlinkDirectories/);
    assert.equal(/include:\s*\[/.test(wt.line), false, 'the invented subfield is back');
    // every reference entry says which file it belongs in, or the insert goes to the wrong editor
    for (const e of REF) assert.match(String(e.file), /^(main|local)$/, e.key + ' has file ' + e.file);
  });
});

// ===================================================================================================
// Die zwei Auflagen der Abnahme — beide waren von dieser Runde SELBST erzeugt, und beide liegen in der
// Fehlerklasse des Projekts. Gehoben wird aus der echten views.js (sie ist kein Modul), nach dem
// liftFn-Muster, das test/ultracode-honesty.test.js für chat.js benutzt.
// ===================================================================================================
describe('die Auflagen der Abnahme', () => {
  const V_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views.js'), 'utf8');
  const lift = (name) => {
    const one = new RegExp('^(?:async )?function ' + name + '\\(.*\\}[ \\t]*$', 'm');
    const multi = new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm');
    const m = one.exec(V_SRC) || multi.exec(V_SRC);
    assert.ok(m, name + '() nicht in views.js gefunden — umbenannt? Dann beweist dieser Test nichts.');
    return m[0];
  };
  // Ein Select-Stub, der nur so viel kann, wie die Funktion anfasst.
  const mkSelect = (werte) => {
    const opts = werte.map((v) => ({ value: v, attrs: {} }));
    return {
      options: opts, value: '', _appended: [],
      querySelectorAll: (sel) => (sel.includes('data-foreign') ? opts.filter((o) => o.attrs['data-foreign']) : []),
      appendChild(o) { opts.push(o); this._appended.push(o); return o; },
    };
  };
  const run = (werte, wert) => {
    const sel = mkSelect(werte);
    const env = {
      $: () => sel,
      el: (tag, cls, text) => ({ tag, value: '', text, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }),
    };
    const fn = new Function('$', 'el', lift('quickSelect') + '\nreturn quickSelect;')(env.$, env.el);
    fn('#qsTheme', wert);
    return sel;
  };

  it('ein Wert ausserhalb der Optionen wird als eigene ⚠-Option BEWAHRT, nicht leer gelassen', () => {
    // Die drei Optionen von #qsTheme gegen einen Schema-Wert, den sie nicht trägt.
    const sel = run(['auto', 'dark', 'light'], 'dark-ansi');
    assert.equal(sel.value, 'dark-ansi', 'der gesetzte Wert ging verloren — genau der leere Kasten');
    assert.equal(sel._appended.length, 1, 'keine Option ergänzt');
    assert.match(sel._appended[0].text, /dark-ansi ⚠/, 'die Option nennt den Wert nicht und markiert ihn nicht');
  });

  it('…und ein custom:-Wert genauso, denn das ist der Fall, den das Schema ausdrücklich erlaubt', () => {
    const sel = run(['auto', 'dark', 'light'], 'custom:my-colors');
    assert.equal(sel.value, 'custom:my-colors');
    assert.equal(sel._appended.length, 1);
  });

  it('ein bekannter Wert ergänzt NICHTS — sonst stünde neben jeder Wahl eine Warnung', () => {
    const sel = run(['auto', 'dark', 'light'], 'dark');
    assert.equal(sel.value, 'dark');
    assert.equal(sel._appended.length, 0);
  });

  // Die zweite Auflage: der Qualifier der CLI muss gerendert werden. Das Feld ist ein PFLICHT-Boolean des
  // safeMode-Objekts und existiert genau deshalb — „hier läuft nichts" wäre ohne ihn falsch.
  it('safeMode nennt, dass VERWALTETE Hooks weiterlaufen — der Satz darf nicht absolut bleiben', () => {
    assert.match(V_SRC, /managedHooksStillApply/, 'der Qualifier wird nirgends gelesen');
    const m = /mode\('views\.hookSafeMode',\s*HOOK_LISTING\.safeMode,\s*'managedHooksStillApply'\)/.exec(V_SRC);
    assert.ok(m, 'der safeMode-Aufruf übergibt den Qualifier nicht');
    assert.match(V_SRC, /views\.hookVerwalteteLaufenWeiter/, 'es gibt keinen Text für den Qualifier');
    // …und bareMode bekommt ihn NICHT: dort gibt es das Feld nicht, also darf auch nichts behauptet werden.
    const bare = /mode\('views\.hookBareMode',\s*HOOK_LISTING\.bareMode\)/.exec(V_SRC);
    assert.ok(bare, 'bareMode hat einen Qualifier bekommen, den sein Schema nicht hat');
  });

  // Die Aufwandsstufe im Schnellzugriff schreibt in settings.json (patchMain). Die CLI deklariert diesen Key
  // als enum(["low","medium","high","xhigh"]).optional().catch(void 0) — `.catch(void 0)` heißt: ein Wert
  // außerhalb der Liste wird STILL verworfen. Das Panel bot „max" an; die Messung, die das widerlegt, lag
  // als Fixture längst im Repo und wurde von niemandem gelesen. Dieser Test ist der Leser, in BEIDE
  // Richtungen — er fällt auch, wenn eine künftige CLI eine Stufe dazunimmt und das Fixture neu gemessen ist.
  it('die Optionen von #qsEffort sind genau das gemessene Enum der CLI — kein „max" mehr', () => {
    const gemessen = (SCHEMA.enumValues || {}).effortLevel;
    assert.ok(Array.isArray(gemessen) && gemessen.length, 'das Fixture hält das effortLevel-Enum nicht (mehr)');
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const sel = /<select id="qsEffort">([\s\S]*?)<\/select>/.exec(html);
    assert.ok(sel, '#qsEffort steht nicht mehr als Select im Markup — der Vergleich greift ins Leere');
    const opts = [...sel[1].matchAll(/value="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(opts, gemessen,
      'Markup ' + JSON.stringify(opts) + ' ≠ gemessen ' + JSON.stringify(gemessen) +
      ' — entweder steht eine Stufe im Select, die die CLI still verwirft, oder die CLI kennt eine mehr und das Fixture ist neu zu messen');
    // Die LIVE-Stufe je Chat ist eine andere Sache und bleibt: dort ist `max` echt (apply_flag_settings).
    // Ohne diese Zusicherung wäre der Test oben eine Einladung, `max` überall zu entfernen.
    assert.match(html, /<option value="max" data-i18n="html\.max-2">/, 'die LIVE-Aufwandsstufe hat ihr „max" verloren — das war nie der Fehler');
  });

  // …und der dritte zurückgestellte Punkt: `condition` („If-condition, revealed, when set.") plus `runsOnce`
  // qualifizieren eine Zeile, die NICHT `disabled` ist und damit unter der Überschrift „Wirksam" steht.
  it('condition und runsOnce werden getragen UND gelesen — sonst ist „Wirksam" zu stark', () => {
    const hc = fs.readFileSync(path.join(ROOT, 'public/js/hooks-catalog.js'), 'utf8');
    assert.match(hc, /condition:\s*str\(h\.condition\)/, 'der Trim wirft die If-Bedingung weg');
    assert.match(hc, /once:\s*h\.runsOnce === true/, 'der Trim wirft runsOnce weg');
    // Vokabular ohne Leser ist in diesem Repo ausdrücklich nichts wert — also auch die Anzeige zusichern.
    assert.match(V_SRC, /h\.condition/, 'die Bedingung erreicht die Zeile nicht');
    assert.match(V_SRC, /h\.once/, 'runsOnce erreicht die Zeile nicht');
    assert.match(V_SRC, /views\.hookNurWenn/, 'es gibt keinen Text für die Bedingung');
    assert.match(V_SRC, /views\.hookNurEinmal/, 'es gibt keinen Text für runsOnce');
  });

  // Der vierte: der statische Tooltip des Messgeräts behauptete „gemessen", bevor irgendetwas gemessen war.
  // Der echte Tooltip unterscheidet gemessen/hergeleitet (ctxTitleLines) — der statische darf die Quelle
  // deshalb gar nicht nennen, sonst steht sie beim ersten Anzeigen und nach jedem Sprachwechsel falsch da.
  it('der statische Titel von #ctxGauge nennt keine Quelle — im Markup UND in beiden Sprachen', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    // `\stitle=` mit Bedacht, und nicht gierig: `[^>]*title="` läuft bis `data-i18n-title="…"` durch und
    // prüft dann den i18n-SCHLÜSSEL statt den Titel. Genau so stand dieser Test zuerst hier, und die
    // Mutation „gemessen zurück in den Tooltip" ließ ihn grün. Vor `-title` steht kein Leerzeichen, vor dem
    // echten Attribut schon — das ist der Unterschied, der ihn wirksam macht.
    const g = /<div id="ctxGauge"[^>]*?\stitle="([^"]*)"/.exec(html);
    assert.ok(g, '#ctxGauge hat keinen statischen Titel mehr — dann ist auch nichts zu prüfen');
    assert.doesNotMatch(g[1], /data-i18n/, 'die Extraktion hat das falsche Attribut erwischt: ' + g[1]);
    assert.doesNotMatch(g[1], /gemessen|measured/i, 'der statische Titel behauptet eine Messung: ' + g[1]);
    // …und derselbe Satz als i18n-Wert, denn applyStaticI18n schreibt ihn beim Sprachwechsel über das Markup.
    // Nur das Markup zu prüfen hieße, die Lüge genau dort stehen zu lassen, wo sie am längsten steht.
    const i18n = fs.readFileSync(path.join(ROOT, 'public/js/i18n.js'), 'utf8');
    const werte = [...i18n.matchAll(/'html\.geschaetzteKontextfensterAuslastungDes':\s*'([^']*)'/g)].map((m) => m[1]);
    assert.equal(werte.length, 2, 'der Tooltip-Text steht nicht in beiden Sprachblöcken');
    werte.forEach((w) => assert.doesNotMatch(w, /gemessen|measured/i, 'i18n-Wert behauptet eine Messung: ' + w));
    // …und die beiden ehrlichen Sätze gibt es weiterhin, sonst wäre die Quelle nirgends mehr zu lesen.
    assert.match(i18n, /'commands\.kontextQuelleGemessen':/);
    assert.match(i18n, /'commands\.kontextQuelleHergeleitet':/);
  });
});
