'use strict';
// Zero-dependency unit tests: `node --test` (or `node --test test/`).
// Covers the shared UI-skill result channel in ../public/js/ui-result.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  uiResultNormalize, uiResultExtract, uiResultFromPattern, uiResultSanitize, uiResultContractSnippet, uiResultSafeUrl,
  uiResultBuckets, uiResultRowCmp, uiResultMatch, uiResultFingerprint, uiResultDigest,
  uiResultKeyIdx, uiResultRowKeys, uiResultNewSet, uiResultCompare, uiResultToneFor, uiResultExpand,
  uiFollowGate, uiFollowPrompt, uiFollowTarget, uiResultRowsMarkdown,
} = require('../public/js/ui-result');

const block = (obj) => '```ui-result\n' + JSON.stringify(obj) + '\n```';

// ---------------------------------------------------------------- uiResultExtract
test('uiResultExtract: parses a valid block into the normalized shape', () => {
  const r = uiResultExtract('bla\n' + block({ summary: 'ok', columns: ['Ticket'], rows: [['ACME-1']] }) + '\nrest');
  assert.equal(r.source, 'block');
  assert.equal(r.summary, 'ok');
  assert.deepEqual(r.columns, [{ id: 'Ticket', label: 'Ticket', type: 'text' }]);
  assert.deepEqual(r.rows, [['ACME-1']]);
});

test('uiResultExtract: the LAST valid block wins', () => {
  const txt = block({ columns: ['A'], rows: [['alt']] }) + '\nzwischen\n' + block({ columns: ['A'], rows: [['neu']] });
  assert.deepEqual(uiResultExtract(txt).rows, [['neu']]);
});

test('uiResultExtract: invalid JSON blocks are skipped, earlier valid one survives', () => {
  const txt = block({ columns: ['A'], rows: [['gut']] }) + '\n```ui-result\n{kaputt\n```';
  assert.deepEqual(uiResultExtract(txt).rows, [['gut']]);
});

test('uiResultExtract: no block → null', () => {
  assert.equal(uiResultExtract('nur text ```js\ncode\n```'), null);
});

// ---------------------------------------------------------------- uiResultNormalize
test('uiResultNormalize: caps rows/columns/cell/summary and pads short rows', () => {
  const r = uiResultNormalize({
    summary: 'x'.repeat(999),
    columns: Array.from({ length: 20 }, (_, i) => 'c' + i),
    rows: Array.from({ length: 600 }, () => ['nur-eine-zelle', 'y'.repeat(999)]),
  });
  assert.equal(r.columns.length, 12);
  assert.equal(r.rows.length, 500);
  assert.equal(r.summary.length, 300);
  assert.equal(r.rows[0].length, 12);            // padded to column count
  assert.equal(r.rows[0][1].length, 500);        // cell cap
  assert.equal(r.rows[0][2], '');                // missing cells → ''
  assert.ok(r.summary.endsWith('…'));            // truncation is visible, not silent
  assert.ok(r.rows[0][1].endsWith('…'));
  assert.equal(r.rows[0][0], 'nur-eine-zelle');  // short values stay untouched (no stray …)
});

test('uiResultNormalize: typed columns kept, unknown types fall back to text', () => {
  const r = uiResultNormalize({ columns: [{ id: 'k', label: 'Ticket', type: 'link', linkBase: 'https://jira.example.com/browse/' }, { id: 'x', type: 'evil' }], rows: [] });
  assert.equal(r.columns[0].type, 'link');
  assert.equal(r.columns[0].linkBase, 'https://jira.example.com/browse/');
  assert.equal(r.columns[1].type, 'text');
});

test('uiResultNormalize: non-https linkBase is dropped (model-authored → untrusted)', () => {
  const r = uiResultNormalize({ columns: [{ id: 'k', type: 'link', linkBase: 'javascript:alert(1)' }], rows: [['x']] });
  assert.equal(r.columns[0].linkBase, undefined);
  assert.equal(uiResultSafeUrl('JAVASCRIPT:x'), '');
  assert.equal(uiResultSafeUrl('https://ok.example/'), 'https://ok.example/');
});

test('uiResultNormalize: missing/empty columns → null', () => {
  assert.equal(uiResultNormalize({ rows: [['x']] }), null);
  assert.equal(uiResultNormalize({ columns: [], rows: [] }), null);
  assert.equal(uiResultNormalize('nope'), null);
  assert.equal(uiResultNormalize(null), null);
});

// ---------------------------------------------------------------- v2: group/detail/tones/stats/groups
test('uiResultNormalize: group + detail column types survive (layout roles)', () => {
  const r = uiResultNormalize({ columns: [{ id: 'g', type: 'group' }, { id: 'k', type: 'link' }, { id: 'd', type: 'detail' }], rows: [['G1', 'PROJ-1', 'lange Begründung']] });
  assert.deepEqual(r.columns.map((c) => c.type), ['group', 'link', 'detail']);
  assert.deepEqual(r.rows, [['G1', 'PROJ-1', 'lange Begründung']]);
});

test('uiResultNormalize: badge tones keep whitelisted values, drop the rest', () => {
  const r = uiResultNormalize({ columns: [{ id: 's', type: 'badge', tones: { Konflikt: 'err', Alt: 'warn', Böse: 'javascript', Leer: '' } }], rows: [] });
  assert.deepEqual(r.columns[0].tones, { Konflikt: 'err', Alt: 'warn' });
  assert.equal(uiResultNormalize({ columns: [{ id: 's', type: 'badge', tones: ['err'] }], rows: [] }).columns[0].tones, undefined);
});

// ---------------------------------------------------------------- uiResultToneFor
test('uiResultToneFor: exact key wins, then `*` patterns in declaration order', () => {
  // the real case: a count-and-direction badge can never be matched exactly, but must go red for ACME
  const col = { type: 'badge', tones: { '✓': 'ok', '*ACME*': 'err', '*PROJ*': 'warn', '*': 'info' } };
  assert.equal(uiResultToneFor(col, '✓'), 'ok');
  assert.equal(uiResultToneFor(col, '7 Kmt. → PROJ'), 'warn');
  assert.equal(uiResultToneFor(col, '7 Kmt. → PROJ · 2 Kmt. → ACME'), 'err');
  assert.equal(uiResultToneFor(col, 'irgendwas'), 'info');
  assert.equal(uiResultToneFor({ type: 'badge', tones: { 'a*': 'ok' } }, 'zzz'), '', 'no match → no tone');
});

test('uiResultToneFor: a tone key cannot inject a regex, and missing tones never throw', () => {
  assert.equal(uiResultToneFor({ tones: { 'a.c': 'ok' } }, 'abc'), '', 'the dot stays a dot');
  assert.equal(uiResultToneFor({ tones: { '(x': 'ok' } }, '(x'), 'ok', 'exact match needs no regex');
  assert.equal(uiResultToneFor({ tones: { '→ PROJ*': 'warn' } }, '→ PROJ 2026-09-28'), 'warn');
  assert.equal(uiResultToneFor(null, 'x'), '');
  assert.equal(uiResultToneFor({ type: 'badge' }, 'x'), '');
});

test('uiResultToneFor: a catch-all does NOT colour an empty cell (an empty cell has no value)', () => {
  // otherwise every not-compared dimension rendered as a coloured empty pill — and with a risky
  // catch-all it would have armed the confirm button for rows that say nothing at all
  assert.equal(uiResultToneFor({ tones: { '*': 'info' } }, ''), '');
  assert.equal(uiResultToneFor({ tones: { '*': 'info' } }, null), '');
  assert.equal(uiResultToneFor({ tones: { '*': 'info' } }, '   '), '');
  assert.equal(uiResultToneFor({ tones: { '': 'muted', '*': 'info' } }, ''), 'muted', 'an explicit "" key still wins');
});

test('uiResultToneFor: normalize keeps pattern keys (only the VALUE is whitelisted)', () => {
  const r = uiResultNormalize({ columns: [{ id: 's', type: 'badge', tones: { '*ACME*': 'err', '*Bad*': 'neon' } }], rows: [] });
  assert.deepEqual(r.columns[0].tones, { '*ACME*': 'err' });
  assert.equal(uiResultToneFor(r.columns[0], '2 → ACME'), 'err');
});

test('uiResultNormalize: stats are capped at 10, tones whitelisted, empty entries dropped', () => {
  const r = uiResultNormalize({
    columns: ['A'], rows: [],
    stats: [{ label: 'Paare', value: 33 }, { label: 'Aktionen', value: 100, tone: 'warn' }, { label: 'X', value: 1, tone: 'nope' }, {}, null,
      ...Array.from({ length: 12 }, (_, i) => ({ label: 'f' + i, value: i }))],
  });
  assert.equal(r.stats.length, 10);
  assert.deepEqual(r.stats[0], { label: 'Paare', value: '33' });      // values are stringified for the DOM
  assert.equal(r.stats[1].tone, 'warn');
  assert.equal(r.stats[2].tone, undefined);                           // unknown tone dropped, stat kept
});

test('uiResultNormalize: groups keep order, dedupe by id, carry note/tone/open', () => {
  const r = uiResultNormalize({
    columns: ['A'], rows: [],
    groups: ['G1', { id: 'G4', label: 'Kommentare → ACME', note: 'KUNDENSICHTBAR', tone: 'err', open: true }, { id: 'G1', label: 'dup' }, { label: 'MELD' }, { note: 'ohne id' }],
  });
  assert.deepEqual(r.groups.map((g) => g.id), ['G1', 'G4', 'MELD']);  // dup dropped, id-less entry dropped
  assert.deepEqual(r.groups[0], { id: 'G1', label: 'G1' });           // string shorthand
  assert.equal(r.groups[1].note, 'KUNDENSICHTBAR');
  assert.equal(r.groups[1].tone, 'err');
  assert.equal(r.groups[1].open, true);
});

test('uiResultNormalize: v1 blocks stay byte-identical (no empty stats/groups keys)', () => {
  const r = uiResultNormalize({ columns: ['A'], rows: [['x']] });
  assert.deepEqual(Object.keys(r), ['source', 'summary', 'columns', 'rows']);
});

test('uiResultSanitize: stats/groups survive the history round-trip', () => {
  const once = uiResultNormalize({ columns: [{ id: 'g', type: 'group' }], rows: [['G1']], stats: [{ label: 'Paare', value: 3 }], groups: [{ id: 'G1', tone: 'warn' }] });
  const twice = uiResultSanitize(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice.stats, [{ label: 'Paare', value: '3' }]);
  assert.deepEqual(twice.groups, [{ id: 'G1', label: 'G1', tone: 'warn' }]);
});

// ---------------------------------------------------------------- v3: expandable rows (`expand[]`)
const xblock = {
  columns: [{ id: 'g', type: 'group' }, { id: 'proj', type: 'link', linkBase: 'https://jira.example.com/browse/' },
    { id: 'sync', label: 'Sync', type: 'expand', sides: ['PROJ', 'ACME'], legend: '◀ nach PROJ · ▶ nach ACME' }, { id: 'n', type: 'number' }],
  rows: [['KUNDE', 'PROJ-715', 'Status ✓ · Kmt ◀ 18 · 2 ▶', '23'], ['INTERN', 'PROJ-726', 'Kmt ◀ 1', '1'], ['SYNC', 'PROJ-1', '', '']],
  expand: [
    { row: 0, open: true, sides: ['PROJ-715', 'ACME-4732'],
      rows: [
        { label: 'Status', short: 'Status', left: 'Done', right: 'In UAT', mark: '✓', tone: 'ok' },
        { label: 'Kommentare', short: 'Kmt', left: '4 Kmt.', right: '35 Kmt.', mark: '◀ 18 · 2 ▶', tone: 'err', note: 'G4 kundensichtbar',
          items: [{ side: 'right', text: 'M. Muster · 01.09.2026 · Test', mark: '◀ G3', tone: 'warn' }, { side: 'left', text: 'J. Haupt · 02.09.2026 · Bitte prüfen', mark: 'G4 ▶', tone: 'err' }, 'nackter String', { side: 'oben', text: 'seite unbekannt', tone: 'neon' }] },
      ],
      notes: ['Beschreibung weicht ab — nur Meldung'] },
    { row: 1, rows: [{ label: 'Kommentare', left: '0', right: '1', mark: '◀ 1', tone: 'warn' }] },
    { row: 7, rows: [{ label: 'außerhalb' }] },          // points past rows → dropped
    { row: 1, rows: [{ label: 'dup' }] },                // duplicate index → dropped
    { row: 2, rows: [], notes: [] },                     // no content → dropped
    { row: 2, rows: [{ label: '' }] },                   // label-less dimension → row empty → dropped
  ],
};

test('uiResultNormalize: expand entries are whitelisted, indexed, deduped and bounded', () => {
  const r = uiResultNormalize(xblock);
  assert.equal(r.columns[2].type, 'expand');
  assert.deepEqual(r.columns[2].sides, ['PROJ', 'ACME']);
  assert.equal(r.columns[2].legend, '◀ nach PROJ · ▶ nach ACME');
  assert.equal(r.columns[1].sides, undefined, 'sides/legend only survive on an expand column');
  assert.deepEqual(r.rows[0], ['KUNDE', 'PROJ-715', 'Status ✓ · Kmt ◀ 18 · 2 ▶', '23'], 'rows stay plain strings');
  assert.deepEqual(r.expand.map((e) => e.row), [0, 1]);
  const e0 = r.expand[0];
  assert.equal(e0.open, true);
  assert.deepEqual(e0.sides, ['PROJ-715', 'ACME-4732']);
  assert.deepEqual(e0.notes, ['Beschreibung weicht ab — nur Meldung']);
  assert.deepEqual(e0.rows[0], { label: 'Status', short: 'Status', left: 'Done', right: 'In UAT', mark: '✓', tone: 'ok' });
  const k = e0.rows[1];
  assert.equal(k.note, 'G4 kundensichtbar');
  assert.deepEqual(k.items[0], { side: 'right', text: 'M. Muster · 01.09.2026 · Test', mark: '◀ G3', tone: 'warn' });
  assert.deepEqual(k.items[2], { side: 'both', text: 'nackter String' }, 'string shorthand → both sides, no tone');
  assert.deepEqual(k.items[3], { side: 'both', text: 'seite unbekannt' }, 'unknown side → both, unknown tone dropped');
  assert.equal(r.expand[1].open, undefined, 'open only when explicitly true');
  assert.equal(r.expand[1].sides, undefined);
});

test('uiResultNormalize: expand caps — 12 dimension rows, 30 items, 240-char item text, 6 notes, visible …', () => {
  const r = uiResultNormalize({
    columns: ['A'], rows: [['x']],
    expand: [{ row: 0,
      rows: Array.from({ length: 20 }, (_, i) => ({ label: 'd' + i, items: Array.from({ length: 50 }, () => ({ text: 'y'.repeat(999) })) })),
      notes: Array.from({ length: 10 }, (_, i) => 'n' + i) }],
  });
  const e = r.expand[0];
  assert.equal(e.rows.length, 12);
  assert.equal(e.rows[0].items.length, 30);
  assert.equal(e.rows[0].items[0].text.length, 240);
  assert.ok(e.rows[0].items[0].text.endsWith('…'));
  assert.equal(e.notes.length, 6);
});

test('uiResultNormalize: v1/v2 blocks carry NO expand key; an expand column without entries is just a text cell', () => {
  assert.deepEqual(Object.keys(uiResultNormalize({ columns: ['A'], rows: [['x']] })), ['source', 'summary', 'columns', 'rows']);
  const r = uiResultNormalize({ columns: [{ id: 's', type: 'expand' }], rows: [['nur Text']], expand: [] });
  assert.equal(r.expand, undefined);
  assert.deepEqual(r.rows, [['nur Text']]);
  assert.deepEqual(uiResultExpand(null, 3), []);
  assert.deepEqual(uiResultExpand([{ row: '0', rows: [{ label: 'x' }] }], 1).map((e) => e.row), [0], 'numeric strings are accepted as index');
  assert.deepEqual(uiResultExpand([{ row: 0.5, rows: [{ label: 'x' }] }], 1), [], 'a fractional index is not a row');
});

test('uiResultNormalize: expandSrc (panel data from a file) is a capped string; inline expand wins; empty → absent', () => {
  const r = uiResultNormalize({ columns: ['A'], rows: [['x']], expandSrc: 'C:\\Users\\x\\sync\\sync-expand.json' });
  assert.equal(r.expandSrc, 'C:\\Users\\x\\sync\\sync-expand.json');
  assert.equal(r.expand, undefined);
  const both = uiResultNormalize({ columns: ['A'], rows: [['x']], expandSrc: 'C:\\x\\a.json', expand: [{ row: 0, rows: [{ label: 'd' }] }] });
  assert.equal(both.expandSrc, undefined, 'inline data present → the reference is dropped');
  assert.equal(both.expand.length, 1);
  assert.equal(uiResultNormalize({ columns: ['A'], rows: [['x']], expandSrc: 'z'.repeat(999) }).expandSrc.length, 400);
  assert.deepEqual(Object.keys(uiResultNormalize({ columns: ['A'], rows: [['x']], expandSrc: '   ' })), ['source', 'summary', 'columns', 'rows']);
  assert.equal(uiResultSanitize({ columns: ['A'], rows: [['x']], expandSrc: 'C:\\x\\a.json' }).expandSrc, 'C:\\x\\a.json', 'the server keeps the reference when it cannot resolve it');
  assert.ok(uiResultContractSnippet().includes('expandSrc'));
});

test('uiResultSanitize: expand survives the history round-trip unchanged', () => {
  const once = uiResultNormalize(xblock);
  const twice = uiResultSanitize(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice.expand, once.expand);
  assert.deepEqual(twice.columns[2], once.columns[2]);
});

test('uiResultMatch: with an expand entry the panel is searchable (items, marks, notes, sides values)', () => {
  const r = uiResultNormalize(xblock);
  const e0 = r.expand[0];
  assert.equal(uiResultMatch(r.rows[0], 'muster', e0), true, 'comment author lives only in the panel');
  assert.equal(uiResultMatch(r.rows[0], 'weicht ab', e0), true, 'entry note');
  assert.equal(uiResultMatch(r.rows[0], 'g4 ▶', e0), true, 'item mark');
  assert.equal(uiResultMatch(r.rows[0], 'in uat', e0), true, 'right-side value');
  assert.equal(uiResultMatch(r.rows[0], 'muster'), false, 'without the entry the row alone does not match');
  assert.equal(uiResultMatch(r.rows[0], 'nichts', e0), false);
});

test('uiResultFingerprint: a changed panel is new data, v1 fingerprints stay as they were', () => {
  const a = uiResultNormalize(xblock);
  const b = JSON.parse(JSON.stringify(xblock)); b.expand[0].rows[1].mark = '◀ 19 · 2 ▶';
  assert.notEqual(uiResultFingerprint(a), uiResultFingerprint(uiResultNormalize(b)));
  const v1 = uiResultNormalize({ columns: ['A'], rows: [['x']] });
  assert.equal(uiResultFingerprint(v1), JSON.stringify([['A'], [['x']]]));
});

test('uiResultCompare/Digest/KeyIdx: an expand column is an ordinary body column for them', () => {
  const cur = uiResultNormalize(xblock);
  const prev = uiResultNormalize(Object.assign({}, xblock, { expand: undefined, rows: [['KUNDE', 'PROJ-715', 'Status ✓ · Kmt ◀ 17 · 2 ▶', '22'], ['SYNC', 'PROJ-1', '', '']] }));
  const c = uiResultCompare(cur, prev);
  assert.deepEqual(c.added, [1]);                        // PROJ-726
  assert.deepEqual(c.changed, [0]);                      // the text fallback changed → row changed
  assert.equal(uiResultKeyIdx(cur), 1);
  assert.deepEqual(uiResultDigest(cur).lines, ['KUNDE · 1', 'INTERN · 1', 'SYNC · 1']);
});

// ---------------------------------------------------------------- pure view logic (card + engine)
const grouped = uiResultNormalize({
  columns: [{ id: 'g', type: 'group' }, { id: 'key', type: 'link' }, { id: 'n', type: 'number' }, { id: 'd', type: 'detail' }],
  groups: [{ id: 'G1', label: 'Status → PROJ', tone: 'warn' }, { id: 'MELD', label: 'Nur melden' }, { id: 'LEER', label: 'Nie benutzt' }],
  rows: [
    ['MELD', 'PROJ-9', '2', 'zwei'],
    ['G1', 'PROJ-11', '11', 'elf'],
    ['Status → PROJ', 'PROJ-2', '3', 'drei'],   // row carries the LABEL, not the id
    ['', 'PROJ-4', '1', 'eins'],                 // no group value at all
  ],
});

test('uiResultBuckets: groups[] order first, label resolves to id, unused groups drop out', () => {
  const b = uiResultBuckets(grouped, 0, 'Ohne Gruppe');
  assert.deepEqual(b.order, ['G1', 'MELD', 'Ohne Gruppe']);   // LEER has no rows → gone
  assert.deepEqual(b.map.G1, [1, 2]);                          // id + label land in the same bucket
  assert.deepEqual(b.map.MELD, [0]);
  assert.deepEqual(b.map['Ohne Gruppe'], [3]);
  assert.equal(b.meta['Status → PROJ'].id, 'G1');               // label lookup works
});

test('uiResultRowCmp: numeric columns compare as numbers, text naturally', () => {
  const rows = grouped.rows.slice();
  const asc = rows.slice().sort(uiResultRowCmp(2, 1, true)).map((r) => r[2]);
  assert.deepEqual(asc, ['1', '2', '3', '11']);                // not '1','11','2','3'
  const desc = rows.slice().sort(uiResultRowCmp(2, -1, true)).map((r) => r[2]);
  assert.deepEqual(desc, ['11', '3', '2', '1']);
  const keys = rows.slice().sort(uiResultRowCmp(1, 1, false)).map((r) => r[1]);
  assert.deepEqual(keys, ['PROJ-2', 'PROJ-4', 'PROJ-9', 'PROJ-11']); // natural, not lexical
});

test('uiResultMatch: case-insensitive across all cells incl. group + detail, empty query matches', () => {
  assert.equal(uiResultMatch(grouped.rows[1], 'elf'), true);      // detail cell
  assert.equal(uiResultMatch(grouped.rows[0], 'meld'), true);     // group cell, different case
  assert.equal(uiResultMatch(grouped.rows[0], 'proj-9'), true);
  assert.equal(uiResultMatch(grouped.rows[0], 'nichts'), false);
  assert.equal(uiResultMatch(grouped.rows[0], ''), true);
});

test('uiResultFingerprint: same data → same id, changed cell → different id', () => {
  const a = uiResultFingerprint(grouped);
  assert.equal(a, uiResultFingerprint(JSON.parse(JSON.stringify(grouped))));
  const changed = JSON.parse(JSON.stringify(grouped)); changed.rows[0][2] = '99';
  assert.notEqual(a, uiResultFingerprint(changed));
  assert.equal(uiResultFingerprint(null), '');
});

test('uiResultDigest: grouped → section counts; ungrouped → first two body cells; never whole rows', () => {
  const d = uiResultDigest(Object.assign({}, grouped, { summary: 'Kurzfazit' }));
  assert.equal(d.summary, 'Kurzfazit');
  assert.deepEqual(d.lines, ['Status → PROJ · 2', 'Nur melden · 1', '— · 1']);
  const flat = uiResultNormalize({ columns: [{ id: 'k' }, { id: 'v' }, { id: 'd', type: 'detail' }], rows: [['PROJ-1', 'offen', 'ein langer Detailsatz, der nicht in die Zeile gehört']] });
  const fd = uiResultDigest(flat);
  assert.deepEqual(fd.lines, ['PROJ-1 · offen']);               // detail column stays out
  assert.deepEqual(uiResultDigest(null).lines, []);
});

// ---------------------------------------------------------------- run-over-run comparison
const runA = uiResultNormalize({
  columns: [{ id: 'g', type: 'group' }, { id: 'key', type: 'link' }, { id: 'st', type: 'badge' }, { id: 'd', type: 'detail' }],
  rows: [['G1', 'PROJ-1', 'offen', 'a'], ['G1', 'PROJ-2', 'offen', 'b'], ['MELD', 'PROJ-3', 'Konflikt', 'c']],
});
test('uiResultKeyIdx/RowKeys: the first link column is the row identity, else the first body column', () => {
  assert.equal(uiResultKeyIdx(runA), 1);
  assert.deepEqual(uiResultRowKeys(runA), ['PROJ-1', 'PROJ-2', 'PROJ-3']);
  const noLink = uiResultNormalize({ columns: [{ id: 'g', type: 'group' }, { id: 'name' }, { id: 'd', type: 'detail' }], rows: [['G', 'Alpha', 'x']] });
  assert.equal(uiResultKeyIdx(noLink), 1);                       // group/detail are skipped
  assert.equal(uiResultKeyIdx(uiResultNormalize({ columns: [{ id: 'g', type: 'group' }], rows: [['G']] })), -1);
});

test('uiResultNewSet: only keys absent from the previous run count as new; empty keys never do', () => {
  const nw = uiResultNewSet(runA, ['PROJ-1']);
  assert.deepEqual(Object.keys(nw).map(Number), [1, 2]);          // PROJ-2 + PROJ-3 are new
  assert.deepEqual(uiResultNewSet(runA, uiResultRowKeys(runA)), {}); // same run → nothing new
  assert.deepEqual(uiResultNewSet(runA, null), {});                // no previous run → mark nothing
  const blank = uiResultNormalize({ columns: [{ id: 'key', type: 'link' }], rows: [['']] });
  assert.deepEqual(uiResultNewSet(blank, ['x']), {});
});

test('uiResultCompare: added/removed/changed by key; different columns → null (not comparable)', () => {
  const cur = uiResultNormalize({
    columns: runA.columns,
    rows: [['G1', 'PROJ-1', 'offen', 'a'], ['G1', 'PROJ-2', 'Konflikt', 'b'], ['G1', 'PROJ-9', 'offen', 'neu']],
  });
  const c = uiResultCompare(cur, runA);
  assert.deepEqual(c.added, [2]);                                 // PROJ-9
  assert.deepEqual(c.changed, [1]);                               // PROJ-2: offen → Konflikt
  assert.deepEqual(c.removed, [2]);                               // PROJ-3 is gone (index in prev)
  assert.equal(c.keyIdx, 1);
  const other = uiResultNormalize({ columns: [{ id: 'x', type: 'link' }], rows: [['PROJ-1']] });
  assert.equal(uiResultCompare(other, runA), null);
  assert.equal(uiResultCompare(null, runA), null);
});

// ---------------------------------------------------------------- uiResultFromPattern
test('uiResultFromPattern: named groups → typed-as-text table columns, duplicate rows deduped', () => {
  const m = { result: { pattern: 'NEU:\\s*(?<key>ACME-\\d+)\\s*\\|\\s*(?<summary>[^\\n]+)' } };
  const txt = 'NEU: ACME-1 | Eins\nNEU: ACME-2 | Zwei\nNEU: ACME-1 | Eins\n';
  const r = uiResultFromPattern(txt, m);
  assert.equal(r.source, 'regex');
  assert.deepEqual(r.columns.map((c) => c.id), ['key', 'summary']);
  assert.deepEqual(r.rows, [['ACME-1', 'Eins'], ['ACME-2', 'Zwei']]);
});

test('uiResultFromPattern: plain pattern → unique chips; zero matches → empty rows (0-state), not null', () => {
  const m = { result: { pattern: 'PROJ-\\d+', label: 'Story' } };
  const r = uiResultFromPattern('PROJ-1 und PROJ-2 und PROJ-1', m);
  assert.deepEqual(r.rows, [['PROJ-1'], ['PROJ-2']]);
  const none = uiResultFromPattern('nichts', m);
  assert.deepEqual(none.columns, [{ id: 'Story', label: 'Story', type: 'text' }]);
  assert.deepEqual(none.rows, []);
});

test('uiResultFromPattern: no pattern or invalid regex → null', () => {
  assert.equal(uiResultFromPattern('x', {}), null);
  assert.equal(uiResultFromPattern('x', { result: { pattern: '(' } }), null);
});

// ---------------------------------------------------------------- uiResultSanitize / snippet
test('uiResultSanitize: re-normalizes client input and preserves regex source tag', () => {
  const r = uiResultSanitize({ source: 'regex', columns: ['A'], rows: [['1']] });
  assert.equal(r.source, 'regex');
  assert.equal(uiResultSanitize({ source: 'block', columns: ['A'], rows: [] }).source, 'block');
  assert.equal(uiResultSanitize(null), null);
  assert.equal(uiResultSanitize({ columns: [] }), null);
});

test('uiResultContractSnippet: contains the fence, the example columns and the ARRAY rule', () => {
  const s = uiResultContractSnippet([{ id: 'inc', label: 'Incident', type: 'text' }]);
  assert.ok(s.includes('```ui-result'));
  assert.ok(s.includes('"inc"'));
  assert.ok(/rows sind ARRAYS/.test(s));          // the [object Object] trap must be named explicitly
  assert.ok(s.includes('"type":"group"'));        // v2 hints available to every new skill
  assert.ok(s.includes('"type":"expand"'));       // v3: expandable rows
  assert.ok(uiResultContractSnippet().includes('jira.example.com'));
});

// ---------------------------------------------------------------- uiFollowGate
// The gate a result card asks before an approval (result.followUp[s]) may go out. It exists because the
// card is readable MID-RUN on purpose (/sync-acme-proj emits its block in the "plan" step): the button
// has to show that it is waiting instead of answering a legitimate-looking click with a toast.
test('uiFollowGate: a selection on a finished run passes', () => {
  assert.equal(uiFollowGate({ selected: 2, busy: false, locked: false }), '');
});

test('uiFollowGate: nothing selected → empty, whatever else is true', () => {
  assert.equal(uiFollowGate({ selected: 0, busy: false, locked: false }), 'empty');
  assert.equal(uiFollowGate({ selected: 0, busy: true, locked: false }), 'empty');
  assert.equal(uiFollowGate({}), 'empty');
  assert.equal(uiFollowGate(), 'empty');
});

test('uiFollowGate: while the run/turn is still writing → busy (the reported "nothing happens")', () => {
  assert.equal(uiFollowGate({ selected: 16, busy: true, locked: false }), 'busy');
});

test('uiFollowGate: a spent card stays locked — before the selection and before busy', () => {
  assert.equal(uiFollowGate({ selected: 2, busy: false, locked: true }), 'locked');
  assert.equal(uiFollowGate({ selected: 0, busy: false, locked: true }), 'locked');
  assert.equal(uiFollowGate({ selected: 2, busy: true, locked: true }), 'locked');
});

// ---------------------------------------------------------------- uiFollowPrompt / {{rows}} / newTab
const followData = uiResultNormalize({
  summary: 'App X: 2 Verstöße · Lauf 20261003-1200-x',
  groups: [{ id: 'verstoss', label: 'Verstoß', tone: 'err' }],
  columns: [
    { id: 'id', label: 'ID' }, { id: 'ergebnis', label: 'Ergebnis', type: 'group' },
    { id: 'befund', label: 'Befund' }, { id: 'anz', label: 'Anz.', type: 'number' },
    { id: 'details', label: 'Details', type: 'expand', sides: ['Ist', 'Fix'] }, { id: 'detail', label: 'Detail', type: 'detail' },
  ],
  rows: [['F-1', 'verstoss', 'Button ohne Namen', '3', '3 Kn', 'tooltip setzen'], ['F-2', 'verstoss', 'Kontrast', '1', '', '']],
  expand: [{ row: 0, rows: [{ label: 'Knoten', left: 'ohne Namen', mark: '→', right: 'tooltip', items: [{ side: 'left', text: 'Worklist--btnEdit' }] }], notes: ['UI5 1.71'] }],
}, 'block');

test('uiFollowPrompt: {{selection}}/{{count}}/{{summary}} are filled', () => {
  const out = uiFollowPrompt({ prompt: 'Auswahl {{selection}} ({{count}}) — {{summary}}' }, { ids: ['F-1', 'F-2'], data: followData });
  assert.equal(out, 'Auswahl F-1,F-2 (2) — App X: 2 Verstöße · Lauf 20261003-1200-x');
});

test('uiFollowPrompt: {{rows}} carries labels, section labels and the panel as text', () => {
  const out = uiFollowPrompt({ prompt: 'Plane:\n{{rows}}' }, { ids: ['F-1'], rowIdx: [0], data: followData, expand: followData.expand });
  assert.match(out, /### 1\. F-1/);
  assert.match(out, /- Ergebnis: Verstoß/);          // group id resolved to its label
  assert.match(out, /- Befund: Button ohne Namen/);
  assert.match(out, /- Detail: tooltip setzen/);
  assert.match(out, /- Details \(Ist \| Fix\):/);
  assert.match(out, /  - Knoten: ohne Namen \| → \| tooltip/);
  assert.match(out, /    - \[Ist\] Worklist--btnEdit/);
  assert.match(out, /  - Hinweis: UI5 1\.71/);
  assert.doesNotMatch(out, /F-2/);
});

test('uiFollowPrompt: the expand source may be a Map (renderer) and empty cells are skipped', () => {
  const m = new Map([[0, followData.expand[0]]]);
  const out = uiFollowPrompt({ prompt: '{{rows}}' }, { ids: ['F-1', 'F-2'], rowIdx: [0, 1], data: followData, expand: m });
  assert.match(out, /### 2\. F-2\n- Ergebnis: Verstoß\n- Befund: Kontrast\n- Anz\.: 1$/);
});

test('uiFollowPrompt: placeholders are replaced in ONE pass (a summary containing {{rows}} stays literal)', () => {
  const d = Object.assign({}, followData, { summary: 'sieh {{rows}}' });
  assert.equal(uiFollowPrompt({ prompt: '{{summary}}' }, { ids: [], data: d }), 'sieh {{rows}}');
});

test('uiResultRowsMarkdown: the cap cuts at a row boundary and says so', () => {
  const first = uiResultRowsMarkdown(followData, [0]).length;
  const out = uiResultRowsMarkdown(followData, [0, 1], null, first + 10);
  assert.match(out, /^### 1\. F-1/);
  assert.match(out, /… 1 weitere Zeile\(n\) gekappt/);
  assert.equal(uiResultRowsMarkdown(null, [0]), '');
});

test('uiFollowTarget: only target:"newTab" leaves the run', () => {
  assert.equal(uiFollowTarget({ target: 'newTab' }), 'newTab');
  assert.equal(uiFollowTarget({ target: 'run' }), 'run');
  assert.equal(uiFollowTarget({}), 'run');
  assert.equal(uiFollowTarget(null), 'run');
});
