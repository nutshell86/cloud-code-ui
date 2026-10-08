'use strict';
// H5 — the Strg+K palette: German wording, German search, and data names left alone.
//
// Three things are measured against the REAL sources, not against copies:
//   · public/js/palette.js  — folding + ranking (require'd, it is a pure module)
//   · public/js/i18n.js     — the dictionary, loaded as the data literal it is
//   · public/js/commands.js — cmdkCommands() is lifted out by name and run against stub globals, the
//     same trick test/agent-lanes.test.js uses for chat-render.js. Stubbing `t()` with a MARKER is what
//     makes "did this label go through i18n?" decidable: anything the dictionary did not produce shows up
//     as bare letters between the markers.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PALETTE_VIEWS, paletteFold, paletteFoldDigraph, paletteScore, paletteRank } = require('../public/js/palette');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/^\uFEFF/, '');
const I18N = new Function(read('public/js/i18n.js') + '; return I18N;')();
const INDEX = read('public/index.html');
const COMMANDS_SRC = read('public/js/commands.js');

// ---------------------------------------------------------------- the view list
// The VISIBLE nav label, not data-i18n-title: a tooltip may say more than its button, and the palette has
// to echo what is on SCREEN. (The example this comment used to give — view-agents, labelled „Läufe" and
// titled „Sitzungen der Maschine" — is gone: PR #66 removed that view, which this suite then caught on the
// merge. Left here as the reason the rule exists, not as a live case.)
const NAV = [...INDEX.split('<button class="nav-item').slice(1)].map((chunk) => {
  const body = chunk.slice(0, chunk.indexOf('</button>'));
  const view = (body.match(/data-view="(\w+)"/) || [])[1];
  const keys = [...body.matchAll(/data-i18n="([\w.-]+)"/g)].map((m) => m[1]);
  return { view, key: keys[keys.length - 1] }; // the label span is the last data-i18n in the button
}).filter((n) => n.view);

test('every palette view exists in the shell and is named by its own nav label key', () => {
  // No fixed floor here. It used to be `>= 10`, which was the count on the day this was written and became
  // wrong the moment PR #66 removed a view — a sanity check that fails for the one change it should wave
  // through. What has to hold is that the parser found SOMETHING and that the two sets are the same size;
  // the two loops below then prove the membership in both directions, which is the actual rule.
  assert.ok(NAV.length > 0, 'the nav parser found no items at all — the markup changed shape');
  assert.equal(NAV.length, PALETTE_VIEWS.length,
    'nav has ' + NAV.length + ' views, the palette lists ' + PALETTE_VIEWS.length
    + ' — nav: ' + NAV.map((n) => n.view).join(', ') + ' | palette: ' + PALETTE_VIEWS.map(([v]) => v).join(', '));
  for (const [view, key] of PALETTE_VIEWS) {
    assert.ok(INDEX.includes('id="view-' + view + '"'), 'PALETTE_VIEWS names a view the shell has not got: ' + view);
    const nav = NAV.find((n) => n.view === view);
    assert.ok(nav, view + ' is in the palette but not in the navigation');
    // one wording for nav and palette → a rename cannot land in one place only
    assert.equal(key, nav.key, 'palette uses "' + key + '" for ' + view + ', the nav label uses "' + nav.key + '"');
  }
  // the shape of the defect that started this: a view sat in the nav and NOT in the palette
  const covered = PALETTE_VIEWS.map(([v]) => v);
  for (const n of NAV) assert.ok(covered.includes(n.view), 'view "' + n.view + '" is unreachable from the palette');
});

test('no English literal is left in the view entries — they are keys, and both languages have them', () => {
  for (const [view, key] of PALETTE_VIEWS) {
    assert.ok(I18N.de[key], 'key ' + key + ' (view ' + view + ') is missing from the de block');
    assert.ok(I18N.en[key], 'key ' + key + ' (view ' + view + ') is missing from the en block');
  }
  // the old hardcoded labels must be gone from the source, not merely unused
  for (const stale of ['Token Usage', "'Settings'", "'Memory'", "'UI Skills'"]) {
    assert.ok(!COMMANDS_SRC.includes(stale), 'commands.js still carries the hardcoded label ' + stale);
  }
  // SNIPPETS() builds its labels one level above cmdkCommands(), so the stubbed builder below cannot see
  // them — checked at the source instead: every snippet label is a dictionary hit, not a literal.
  const snip = COMMANDS_SRC.match(/const SNIPPETS = \(\) => \[[\s\S]*?\n\];/);
  assert.ok(snip, 'SNIPPETS() not found in commands.js');
  for (const m of snip[0].matchAll(/label:\s*([^,]+),/g)) {
    assert.match(m[1].trim(), /^t\('[\w.-]+'\)$/, 'snippet label ' + m[1].trim() + ' does not go through t()');
  }
});

// Stand-in for the i18n guard the plan puts in PR-5 (QUAL-6); that file does not exist on this base, so
// the keys this change adds would otherwise be checked by nobody.
test('the dictionary is in de/en parity', () => {
  const de = Object.keys(I18N.de), en = Object.keys(I18N.en);
  assert.deepEqual(de.filter((k) => !(k in I18N.en)), [], 'keys missing from the en block');
  assert.deepEqual(en.filter((k) => !(k in I18N.de)), [], 'keys missing from the de block');
  assert.equal(de.length, en.length);
  // the keys this change introduces, named so a silent half-add is caught
  for (const k of ['chat-side.regelEntfernen', 'chat-side.dauerhaftEntferntToast', 'chat-status.freigabeEntfernen', 'views-mcp.vollerFehler']) {
    assert.ok(k in I18N.de && k in I18N.en, k + ' is not in both blocks');
  }
});

// ---------------------------------------------------------------- German search
test('a query typed without umlauts finds the umlaut, and the digraph does too', () => {
  // A PURE function over a string — „Läufe" is the example word, not a claim that such a view exists (it
  // no longer does, see the nav test above). Kept because it carries all three cases at once: the bare
  // vowel, the umlaut, and the digraph.
  for (const q of ['laufe', 'läufe', 'Laufe', 'LÄUFE', 'laeufe']) {
    assert.ok(paletteScore('Gehe zu Läufe', q) > 0, '"' + q + '" found nothing in „Gehe zu Läufe"');
  }
  assert.ok(paletteScore('Zurück zum Verlauf', 'zuruck') > 0);
  assert.ok(paletteScore('Zurück zum Verlauf', 'zurueck') > 0);
  assert.ok(paletteScore('Große Datei öffnen', 'grosse') > 0);
  assert.ok(paletteScore('Große Datei öffnen', 'große') > 0);
  assert.ok(paletteScore('Datei öffnen', 'offnen') > 0);
  assert.ok(paletteScore('Café-Modus', 'cafe') > 0);
  // and the plain substring case still ranks above the fuzzy ones (A19's three tiers)
  assert.ok(paletteScore('Gehe zu Einstellungen', 'einstellungen') > paletteScore('Gehe zu Einstellungen', 'gze'));
  assert.equal(paletteScore('Gehe zu Speicher', 'gzs'), 60, 'word initials are the middle tier');
  assert.equal(paletteScore('Gehe zu Speicher', 'qqq'), 0);
  assert.equal(paletteScore('anything', ''), 1, 'an empty query keeps every entry');
});

test('folding is a search aid, not a renaming — it never collapses a real word', () => {
  assert.equal(paletteFold('Läufe'), 'laufe');
  assert.equal(paletteFoldDigraph('Läufe'), 'laeufe');
  assert.equal(paletteFold('ß'), 'ss');
  // the trap that rules out one single canonical form: expanding ü→ue and then collapsing „ue"→„u"
  // would make „neue" match „nu". Both forms are offered side by side instead.
  assert.equal(paletteFold('neue Nachricht'), 'neue nachricht');
  assert.equal(paletteFoldDigraph('neue Nachricht'), 'neue nachricht');
  assert.equal(paletteFold(null), '');
  assert.equal(paletteFold(undefined), '');
});

test('a label hit outranks a group/hint hit', () => {
  const byLabel = { group: 'Vorlage', label: 'ABAP Objekt erklären', hint: '' };
  const byGroup = { group: 'ABAP', label: 'Etwas ganz anderes', hint: '' };
  assert.ok(paletteRank(byLabel, 'abap') > paletteRank(byGroup, 'abap'));
  assert.ok(paletteRank(byGroup, 'abap') > 0, 'a group hit still has to be findable');
  assert.equal(paletteRank(null, 'x'), 0);
});

// ---------------------------------------------------------------- i18n vs. data
// cmdkCommands() lives in a browser script that needs the whole app's globals, so it is lifted out by
// name and fed stubs — the real builder under test, not a transcription of it.
function loadCmdkCommands(env) {
  const m = COMMANDS_SRC.match(/^function cmdkCommands\(\)[\s\S]*?^\}/m);
  assert.ok(m, 'cmdkCommands() not found in public/js/commands.js — renamed or reindented?');
  const names = Object.keys(env);
  return new Function(...names, m[0] + '\nreturn cmdkCommands;')(...names.map((k) => env[k]));
}
// Deliberately words that a dictionary COULD be tempted to touch: a session titled „Settings", a prompt
// titled „Speicher", a UI skill titled „Memory".
const DATA = {
  skillTitle: 'Memory',
  promptTitle: 'Speicher',
  sessionTitle: 'Settings',
  slash: '/clear',
  projectName: 'Einstellungen', // P-1 — a project named like a view is still the user's word
};
function buildEntries(tFn) {
  const build = loadCmdkCommands({
    t: tFn,
    $: () => ({ value: '', onclick: () => {} }),
    showView: () => {}, openGlobalSearch: () => {}, openModelCompare: () => {},
    openUiSkill: () => {}, insertSnippet: () => {}, savePromptFromComposer: () => {},
    openPromptManager: () => {}, openPromptHistory: () => {}, composerSet: () => {}, resumeSession: () => {},
    isFav: () => false,
    PALETTE_VIEWS,
    UISKILLS_DATA: [{ name: 'memo', manifest: { title: DATA.skillTitle, writes: false } }],
    sortedPrompts: () => [{ title: DATA.promptTitle, text: 'x', tags: [] }],
    // SNIPPETS() resolves its own labels through t() at call time (A19), so the stub does the same —
    // a raw string here would make the snippet entry look like a hardcoded label it is not
    SNIPPETS: () => [{ cat: 'ABAP', label: tFn('commands.abapObjektErklaeren'), text: 'y' }],
    allChatCommands: () => [DATA.slash],
    SESSIONS: [{ id: 'abcdef1234', title: DATA.sessionTitle, projectPath: 'C:/x' }],
    PROJECTS_DATA: [{ id: 'p-00000001', name: DATA.projectName, archived: false }],
    newChatInProject: () => {},
  });
  return build();
}

test('every palette entry declares where its label comes from', () => {
  const entries = buildEntries((k) => '«' + k + '»');
  assert.ok(entries.length >= 20, 'only ' + entries.length + ' entries built');
  for (const e of entries) {
    assert.ok(e.src === 'i18n' || e.src === 'data',
      'entry "' + e.label + '" has src=' + JSON.stringify(e.src) + ' — an untagged label is one nobody checks');
  }
  assert.ok(entries.some((e) => e.src === 'data'), 'no data-labelled entry — the stubs did not reach the builder');
});

test('an i18n label is dictionary text end to end — no hardcoded fragment slips through', () => {
  const entries = buildEntries((k) => '«' + k + '»');
  for (const e of entries.filter((x) => x.src === 'i18n')) {
    const leftover = e.label.replace(/«[\w.-]+»/g, '').trim();
    assert.ok(!/\p{L}/u.test(leftover),
      'label "' + e.label + '" contains the hardcoded text "' + leftover + '" — it will stay English in the German UI');
  }
});

test('a data label is passed through untouched', () => {
  const entries = buildEntries((k) => '«' + k + '»');
  const labels = entries.filter((e) => e.src === 'data').map((e) => e.label);
  for (const raw of [DATA.skillTitle, DATA.promptTitle, DATA.sessionTitle, DATA.slash, DATA.projectName]) {
    assert.ok(labels.some((l) => l.includes(raw)),
      'the data name "' + raw + '" is not in any data-labelled entry verbatim — something translated it');
  }
  // „/clear" is a whole label, not a prefix plus a name
  assert.ok(labels.includes(DATA.slash), 'the slash command was decorated: ' + JSON.stringify(labels));
});

test('the palette speaks the UI language — DE and EN differ exactly where the dictionary does', () => {
  const de = buildEntries((k) => I18N.de[k] == null ? '??' + k : I18N.de[k]);
  const en = buildEntries((k) => I18N.en[k] == null ? '??' + k : I18N.en[k]);
  assert.ok(!de.concat(en).some((e) => /\?\?/.test(e.label) || /\?\?/.test(e.group || '')),
    'the palette asks for keys the dictionary does not have: '
    + de.concat(en).filter((e) => /\?\?/.test(e.label + e.group)).map((e) => e.label + ' / ' + e.group).join(', '));
  const label = (list, needle) => list.find((e) => e.label.includes(needle));
  // the reported defect, both halves of it
  assert.ok(label(de, 'Einstellungen'), 'the German palette has no „… Einstellungen" entry: '
    + de.filter((e) => e.group === I18N.de['html.ansicht']).map((e) => e.label).join(' | '));
  assert.ok(label(de, 'Speicher'), 'the German palette still says „Memory"');
  assert.ok(label(de, 'Sitzungen'), 'the German palette still says „Sessions"');
  assert.ok(label(en, 'Settings') && label(en, 'Memory'), 'the English palette lost its own wording');
  // Stronger than naming single words, and it cannot go stale with a renamed view: EVERY nav entry whose
  // two dictionary values differ must differ in the palette too. („Läufe"/„Runs" used to be the named pair
  // here; PR #66 removed that view, and a test that names words dies with them.)
  const paar = PALETTE_VIEWS.filter(([, k]) => I18N.de[k] !== I18N.en[k]);
  assert.ok(paar.length >= 4, 'only ' + paar.length + ' nav labels differ between de and en — the dictionary changed');
  for (const [, k] of paar) {
    assert.ok(label(de, I18N.de[k]), 'the German palette is missing „' + I18N.de[k] + '"');
    assert.ok(label(en, I18N.en[k]), 'the English palette is missing „' + I18N.en[k] + '"');
  }
  // …and the search finds each entry with the word that is on the screen, lower-cased.
  const navDe = de.filter((e) => e.group === I18N.de['html.ansicht']);
  for (const [v, k] of PALETTE_VIEWS) {
    const wort = String(I18N.de[k]).split(/[\s&]+/)[0].toLowerCase();
    assert.ok(navDe.some((e) => paletteRank(e, wort) > 0), 'typing „' + wort + '" finds no nav entry (view ' + v + ')');
  }
  // The UMLAUT path end to end is NOT asserted here, and that is a gap worth naming rather than faking:
  // after PR #66 removed „Läufe", not one of the nine nav labels carries an umlaut any more (checked:
  // Chat · Sitzungen · Nutzung & Kosten · Einstellungen · MCP & Plugins · Skills · UI-Skills · Speicher ·
  // System). The folding itself is proven on the pure functions above; a fabricated label just to have a
  // case here would test the fixture, not the panel.
  assert.ok(!PALETTE_VIEWS.some(([, k]) => /[äöüÄÖÜß]/.test(String(I18N.de[k]))),
    'a nav label has an umlaut again — then the end-to-end case above should assert it instead of this note');
});
