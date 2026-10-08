'use strict';
// D2 — the offene-punkte block is MODEL-AUTHORED, so it is untrusted input on the render path. Same
// contract as ui-result: it must never throw, never exceed its caps, and never let an arbitrary field
// through. Plus the merge rule the rail depends on (the same question twice is one point, not two).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  openPointsExtract, openPointsNormalize, openPointsStrip, openPointsMerge, openPointKey,
  openPointOptions, openPointsSig, openPointsMatch, openPointsStaged, openPointsComposeBatch,
  openPointsOpenCount, openCollectMode, openCollectActive, openPointsAdopt,
  OPEN_POINT_CAPS, OPEN_POINT_COLLECT_MIN,
} = require('../public/js/open-points');

const fence = (body) => '```offene-punkte\n' + body + '\n```';

describe('open-points — extraction (D2)', () => {
  it('reads the documented shape', () => {
    const pts = openPointsExtract('Text davor.\n\n' + fence('[{"frage":"Werk 1 oder 2?","warum":"Ich kartiere beide","tone":"info"}]'));
    assert.equal(pts.length, 1);
    assert.deepEqual(pts[0], { frage: 'Werk 1 oder 2?', warum: 'Ich kartiere beide', tone: 'info' });
  });

  it('finds nothing in text without a block, and never throws on junk', () => {
    assert.deepEqual(openPointsExtract('nur Prosa'), []);
    assert.deepEqual(openPointsExtract(''), []);
    assert.deepEqual(openPointsExtract(null), []);
    assert.deepEqual(openPointsExtract(fence('{ not json')), []);
    assert.deepEqual(openPointsExtract(fence('null')), []);
    assert.deepEqual(openPointsExtract(fence('"a string"')), [{ frage: 'a string', warum: '', tone: '' }]);
  });

  it('accumulates ACROSS blocks (two blocks = two sets of questions)', () => {
    const txt = fence('[{"frage":"A"}]') + '\nmehr Text\n' + fence('[{"frage":"B"}]');
    assert.deepEqual(openPointsExtract(txt).map((p) => p.frage), ['A', 'B']);
  });

  it('accepts the alternative shapes a cooperative model might write', () => {
    assert.deepEqual(openPointsNormalize(['kurz']).map((p) => p.frage), ['kurz']);
    assert.deepEqual(openPointsNormalize({ punkte: [{ frage: 'X' }] }).map((p) => p.frage), ['X']);
    assert.deepEqual(openPointsNormalize({ points: [{ question: 'Y', why: 'weil' }] })[0], { frage: 'Y', warum: 'weil', tone: '' });
    assert.deepEqual(openPointsNormalize({ frage: 'Z' }).map((p) => p.frage), ['Z'], 'a single object is one point');
  });

  it('drops entries without a question', () => {
    const pts = openPointsNormalize([{ warum: 'nur Begründung' }, {}, null, [], { frage: '   ' }, { frage: 'echt' }]);
    assert.deepEqual(pts.map((p) => p.frage), ['echt']);
  });

  it('caps the number of points', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ frage: 'F' + i }));
    assert.equal(openPointsNormalize(many).length, OPEN_POINT_CAPS.points);
    assert.equal(openPointsExtract(fence(JSON.stringify(many))).length, OPEN_POINT_CAPS.points);
  });

  it('caps the text of each field and marks the truncation', () => {
    const p = openPointsNormalize([{ frage: 'x'.repeat(900), warum: 'y'.repeat(900) }])[0];
    assert.equal(p.frage.length, OPEN_POINT_CAPS.frage);
    assert.equal(p.warum.length, OPEN_POINT_CAPS.warum);
    assert.ok(p.frage.endsWith('…') && p.warum.endsWith('…'));
  });

  it('only allows known tones, and collapses whitespace', () => {
    assert.equal(openPointsNormalize([{ frage: 'a', tone: 'ok' }])[0].tone, 'ok');
    assert.equal(openPointsNormalize([{ frage: 'a', tone: 'rainbow' }])[0].tone, '', 'an unknown tone must be dropped, not passed to the DOM');
    assert.equal(openPointsNormalize([{ frage: 'a\n\n  b\tc' }])[0].frage, 'a b c');
  });

  it('ignores fields it does not know', () => {
    const p = openPointsNormalize([{ frage: 'a', onclick: 'alert(1)', html: '<img>' }])[0];
    assert.deepEqual(Object.keys(p).sort(), ['frage', 'tone', 'warum']);
  });
});

describe('open-points — strip + merge (D2)', () => {
  it('removes the block from the transcript text', () => {
    const txt = 'Antwort.\n\n' + fence('[{"frage":"A"}]') + '\n\nSchluss.';
    const out = openPointsStrip(txt);
    assert.ok(!out.includes('offene-punkte'));
    assert.match(out, /Antwort\./);
    assert.match(out, /Schluss\./);
    assert.equal(openPointsStrip(null), '');
  });

  it('the same question twice stays ONE point', () => {
    const a = [{ frage: 'Welches Werk?', warum: '', tone: '' }];
    const merged = openPointsMerge(a, [{ frage: 'welches   werk ?', warum: 'anders formuliert', tone: '' }]);
    assert.equal(merged.length, 1, 'a re-asked question must not stack up in the rail');
    assert.equal(merged[0].warum, '', 'the existing entry keeps its state');
  });

  it('new questions are appended, and the cap holds through merges', () => {
    let list = [];
    for (let i = 0; i < 30; i++) list = openPointsMerge(list, [{ frage: 'F' + i }]);
    assert.equal(list.length, OPEN_POINT_CAPS.points);
    assert.equal(list[0].frage, 'F0', 'merging must not reorder what is already shown');
  });

  it('makes room for a NEW question by dropping the oldest SETTLED one', () => {
    let list = [];
    for (let i = 0; i < OPEN_POINT_CAPS.points; i++) list = openPointsMerge(list, [{ frage: 'Frage ' + i + ' zum Thema?' }]);
    list.forEach((p) => { p.done = true; });          // all answered → the rail shows none of them
    list = openPointsMerge(list, [{ frage: 'Eine ganz neue Frage?' }]);
    assert.equal(list.length, OPEN_POINT_CAPS.points, 'the cap still holds');
    assert.ok(list.some((p) => p.frage === 'Eine ganz neue Frage?'), 'a new question must not be dropped for invisible settled ones');
    assert.ok(!list.some((p) => p.frage === 'Frage 0 zum Thema?'), 'the OLDEST settled point is the one that goes');
  });

  it('never evicts a question that is still waiting', () => {
    let list = [];
    for (let i = 0; i < OPEN_POINT_CAPS.points; i++) list = openPointsMerge(list, [{ frage: 'Frage ' + i + ' zum Thema?' }]);
    const out = openPointsMerge(list, [{ frage: 'Noch eine Frage?' }]);
    assert.equal(out.length, OPEN_POINT_CAPS.points);
    assert.ok(!out.some((p) => p.frage === 'Noch eine Frage?'), 'ten waiting questions = a real overflow, refusing is right');
    assert.equal(out[0].frage, 'Frage 0 zum Thema?');
  });

  it('a re-asked question re-opens a point that was closed by a GUESS, but not one that was decided', () => {
    const guessed = { frage: 'Soll das PDF dran?', done: true, answer: 'ja, mach das', guessed: true };
    const decided = { frage: 'Auch die Testfälle anpassen?', done: true, answer: 'nein' };
    const dismissed = { frage: 'Welches Werk ist gemeint?', done: true, answer: '' };
    const list = openPointsMerge([guessed, decided, dismissed], [
      { frage: 'Soll das PDF dran?' }, { frage: 'Auch die Testfälle anpassen?' }, { frage: 'Welches Werk ist gemeint?' },
    ]);
    assert.equal(list.length, 3, 'still no stacking');
    assert.equal(list[0].done, false, 'the model insisting is the evidence that the guess was wrong');
    assert.equal(list[0].answer, '');
    assert.equal(list[0].guessed, false);
    assert.equal(list[1].done, true, 'an explicit answer stays answered');
    assert.equal(list[2].done, true, 'a dismissed question must not crawl back every turn');
  });

  it('the key ignores punctuation and case but keeps umlauts', () => {
    assert.equal(openPointKey({ frage: 'Größe?' }), openPointKey({ frage: 'größe' }));
    assert.notEqual(openPointKey({ frage: 'A' }), openPointKey({ frage: 'B' }));
    assert.equal(openPointKey(null), '');
  });
});

// The in-chat card turns `optionen` into buttons whose labels are sent verbatim, so the same
// untrusted-input contract applies to them as to the question itself.
describe('open-points — one-click answers (optionen)', () => {
  it('reads both the string and the object form', () => {
    const p = openPointsNormalize([{ frage: 'Werk?', optionen: ['Werk 1', { label: 'beide', desc: 'zweiter Durchlauf' }] }])[0];
    assert.deepEqual(p.optionen, [{ label: 'Werk 1', desc: '' }, { label: 'beide', desc: 'zweiter Durchlauf' }]);
    assert.deepEqual(openPointsNormalize([{ frage: 'a', options: [{ label: 'x', description: 'y' }] }])[0].optionen,
      [{ label: 'x', desc: 'y' }], 'the english field names are accepted like everywhere else');
  });

  it('leaves the plain three-field shape untouched when no options are given', () => {
    const p = openPointsNormalize([{ frage: 'a' }])[0];
    assert.deepEqual(Object.keys(p).sort(), ['frage', 'tone', 'warum'], 'no empty optionen array on every point');
  });

  it('caps the count and the text, and drops anything unusable', () => {
    const many = Array.from({ length: 20 }, (_, i) => 'O' + i);
    assert.equal(openPointOptions(many).length, OPEN_POINT_CAPS.optionen);
    const [o] = openPointOptions([{ label: 'x'.repeat(300), desc: 'y'.repeat(500) }]);
    assert.equal(o.label.length, OPEN_POINT_CAPS.label);
    assert.equal(o.desc.length, OPEN_POINT_CAPS.desc);
    assert.deepEqual(openPointOptions(['', null, {}, [], { desc: 'ohne label' }, 'ok']), [{ label: 'ok', desc: '' }]);
    assert.deepEqual(openPointOptions('nicht mal ein array'), []);
    assert.deepEqual(openPointOptions(undefined), []);
  });

  it('ignores unknown option fields', () => {
    const [o] = openPointOptions([{ label: 'a', onclick: 'alert(1)', href: 'javascript:x' }]);
    assert.deepEqual(Object.keys(o).sort(), ['desc', 'label']);
  });
});

// The card in the transcript and the row in the rail are two views of ONE array. The rail's repaint
// guard compares this signature — if it does not move when a point is answered, the row stays standing
// after the card has already recorded the answer (the bug this signature exists to prevent).
describe('open-points — signature keeps the two views in step', () => {
  it('changes when a point is settled', () => {
    const pts = [{ frage: 'A' }, { frage: 'B' }];
    const before = openPointsSig(pts);
    pts[0].done = true;
    assert.notEqual(openPointsSig(pts), before, 'answering a point must invalidate the rail repaint guard');
  });

  it('changes when a point is added, and is stable otherwise', () => {
    const pts = [{ frage: 'A' }];
    const sig = openPointsSig(pts);
    assert.equal(openPointsSig([{ frage: 'a?' }]), sig, 'the same question re-asked is the same signature');
    assert.notEqual(openPointsSig(pts.concat({ frage: 'B' })), sig);
    assert.equal(openPointsSig([]), '');
    assert.equal(openPointsSig(null), '');
  });
});

// Answering in the chat has to close the point — the rail hands the question to the composer, and until
// this matcher existed the send closed nothing, so an answered question kept standing in the rail.
// The rule is deliberately narrow: quote or exact option label, everything else stays open.
describe('open-points — a chat reply closes the point', () => {
  const werk = { id: 'op1', frage: 'Welches Z_EXAMPLE ist gemeint — Werk 1 oder 2?', optionen: [{ label: 'Werk 1' }, { label: 'Werk 2' }, { label: 'beide' }] };
  const fix = { id: 'op2', frage: 'Soll ich den Fix umsetzen — und wenn ja, welchen?', optionen: [{ label: 'A · Renderer-Fix' }, { label: 'beides' }] };

  it('matches the composer path: question quoted, answer below it', () => {
    const hits = openPointsMatch([werk], werk.frage + '\n\nWerk 2, die anderen sind stillgelegt.');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].point, werk);
    assert.equal(hits[0].answer, 'Werk 2, die anderen sind stillgelegt.', 'the quote is cut, the answer remains');
  });

  it('matches an exact option label typed in the chat', () => {
    const hits = openPointsMatch([fix], 'beides');
    assert.deepEqual(hits.map((h) => h.point.id), ['op2']);
    assert.equal(hits[0].answer, 'beides');
  });

  it('is case- and punctuation-insensitive on the label', () => {
    assert.equal(openPointsMatch([werk], '  WERK 2!  ').length, 1);
  });

  it('refuses an ambiguous label rather than picking one', () => {
    const a = { id: 'a', frage: 'Erste lange Frage zum Thema?', optionen: [{ label: 'beides' }] };
    const b = { id: 'b', frage: 'Zweite lange Frage zum Thema?', optionen: [{ label: 'beides' }] };
    assert.deepEqual(openPointsMatch([a, b], 'beides'), [], 'two candidates → the panel must not guess');
  });

  it('leaves a free reply open', () => {
    assert.deepEqual(openPointsMatch([werk, fix], 'ja, mach das bitte'), []);
  });

  it('does not treat the bare question as its own answer', () => {
    assert.deepEqual(openPointsMatch([werk], werk.frage), [], 'the rail prefill alone is not an answer');
  });

  it('skips points that are already settled', () => {
    assert.deepEqual(openPointsMatch([{ ...fix, done: true }], 'beides'), []);
  });

  it('will not quote-match a question too short to be a quote', () => {
    const kurz = { id: 'k', frage: 'Wo?', optionen: [] };
    // TWO open points on purpose: with a single one the sole-question rule below would close it anyway
    // (which is fine — but then this test would no longer be about quoting).
    const other = { id: 'o', frage: 'Eine zweite offene Frage zum Thema?', optionen: [] };
    assert.deepEqual(openPointsMatch([kurz, other], 'Wo? Im Werk.'), [], 'a 3-letter question matches by accident, not by quoting');
  });

  it('can close two points from one message', () => {
    const hits = openPointsMatch([werk, fix], werk.frage + ' → Werk 2. ' + fix.frage + ' → A.');
    assert.equal(hits.length, 2);
  });

  it('never throws on junk input', () => {
    assert.deepEqual(openPointsMatch(null, 'x'), []);
    assert.deepEqual(openPointsMatch([null, 5, {}], 'x'), []);
    assert.deepEqual(openPointsMatch([werk], ''), []);
    assert.deepEqual(openPointsMatch([werk], null), []);
  });
});

// Signal 3, added after the report „beantwortete Fragen verschwinden nicht aus dem rechten Panel": with
// exactly ONE question still open, the next ordinary message is its answer — an answer in the reader's own
// words matched neither the quote nor the label rule, so the row stayed until it was dismissed by hand.
// The close is marked as a GUESS; openPointsMerge re-opens it if the model asks the same thing again.
describe('open-points — the sole open question is answered by the next message', () => {
  const sole = { id: 's1', frage: 'Soll das PDF mit angehängt werden?' };

  it('reads a free reply as the answer and marks it as a guess', () => {
    const hits = openPointsMatch([sole], 'ja, mach das so');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].point, sole);
    assert.equal(hits[0].answer, 'ja, mach das so');
    assert.equal(hits[0].guessed, true, 'the caller must be able to tell a guess from a decision');
  });

  it('guesses nothing as soon as a second question is open', () => {
    assert.deepEqual(openPointsMatch([sole, { id: 's2', frage: 'Auch die Testfälle anpassen?' }], 'ja, mach das so'), []);
  });

  it('a slash command is never an answer', () => {
    assert.deepEqual(openPointsMatch([sole], '/compact'), []);
    assert.deepEqual(openPointsMatch([sole], '/clear'), []);
  });

  it('leaves a point alone while an answer is staged on it (the send bar is that path)', () => {
    assert.deepEqual(openPointsMatch([{ ...sole, staged: 'ja' }], 'etwas ganz anderes'), []);
  });

  it('the prefilled question alone is still not an answer', () => {
    assert.deepEqual(openPointsMatch([sole], sole.frage), []);
    assert.deepEqual(openPointsMatch([sole], sole.frage + '\n\n'), []);
    assert.deepEqual(openPointsMatch([sole], '  soll das pdf mit angehängt werden  '), [], 'same question, other punctuation');
  });

  it('keeps the quote rule where it applies: the quote is cut, not counted as a guess', () => {
    const hits = openPointsMatch([sole], sole.frage + '\n\nja bitte');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].answer, 'ja bitte');
    assert.ok(!hits[0].guessed, 'this one is decidable — it is not a guess');
  });
});

// Collect mode: answering one point starts a turn, so with three open questions the second and third
// answer sit in the queue behind the first. Staging keeps them on the points; one send takes them all.
// The two rules worth pinning: what counts as staged, and that the batch message quotes every question
// (the answers arrive an unknown number of messages after the questions).
describe('open-points — collect mode (D2)', () => {
  const pts = () => [
    { id: 'a', frage: 'Werk 1 oder 2?', staged: 'Werk 2' },
    { id: 'b', frage: 'Sonde erlaubt?', staged: '  ja  ' },
    { id: 'c', frage: 'Noch offen?' },
    { id: 'd', frage: 'Schon erledigt?', staged: 'egal', done: true },
    { id: 'e', frage: 'Leer vorgemerkt?', staged: '   ' },
  ];

  it('counts only points that are staged AND still open', () => {
    const s = openPointsStaged(pts());
    assert.deepEqual(s.map((p) => p.id), ['a', 'b'], 'done or blank-staged points must not count');
    assert.deepEqual(openPointsStaged(null), []);
    assert.deepEqual(openPointsStaged([null, 7, 'x', {}]), []);
  });

  it('composes ONE numbered message that quotes every question', () => {
    const msg = openPointsComposeBatch(pts(), { head: 'Antworten auf die offenen Punkte:', arrow: '→ ' });
    assert.equal(msg,
      'Antworten auf die offenen Punkte:\n\n'
      + '1. Werk 1 oder 2?\n→ Werk 2\n\n'
      + '2. Sonde erlaubt?\n→ ja');
    assert.ok(!/Noch offen|Schon erledigt|Leer vorgemerkt/.test(msg), 'only staged points belong in the batch');
  });

  it('is empty when nothing is staged — the caller must not send an empty turn', () => {
    assert.equal(openPointsComposeBatch([{ frage: 'x' }], {}), '');
    assert.equal(openPointsComposeBatch([], {}), '');
    assert.equal(openPointsComposeBatch(null, {}), '');
  });

  it('falls back to its own labels instead of printing "undefined"', () => {
    const msg = openPointsComposeBatch([{ frage: 'A?', staged: 'B' }]);
    assert.ok(!/undefined/.test(msg), msg);
    assert.match(msg, /1\. A\?/);
    assert.match(msg, /B$/);
  });

  it('the rail signature changes when an answer is staged (otherwise the rail would not repaint)', () => {
    const before = openPointsSig([{ frage: 'A?' }]);
    const after = openPointsSig([{ frage: 'A?', staged: 'B' }]);
    assert.notEqual(before, after);
    // …and a blank staging is not a change: it is the same „unanswered" state
    assert.equal(openPointsSig([{ frage: 'A?', staged: '  ' }]), before);
  });
});

// „Automatisch ab 2" is the default, and it is the whole point of the mode: with ONE open question the
// immediate answer is right (nothing is queued behind it), with two, answering the first is exactly what
// makes the second wait. So the threshold — not the preference — is what needs pinning.
describe('open-points — when collecting switches itself on', () => {
  const open = (n) => Array.from({ length: n }, (_, i) => ({ frage: 'F' + i }));

  it('counts the questions that are still waiting', () => {
    assert.equal(openPointsOpenCount(open(3)), 3);
    assert.equal(openPointsOpenCount([{ frage: 'a', done: true }, { frage: 'b' }]), 1);
    assert.equal(openPointsOpenCount([{ warum: 'ohne frage' }, null, 'x', {}]), 0, 'a row without a question is not a question');
    assert.equal(openPointsOpenCount(null), 0);
  });

  it('automatic: off with one question, on from the second', () => {
    assert.equal(OPEN_POINT_COLLECT_MIN, 2);
    assert.equal(openCollectActive('auto', 0), false);
    assert.equal(openCollectActive('auto', 1), false, 'one question must not gain a send button');
    assert.equal(openCollectActive('auto', 2), true);
    assert.equal(openCollectActive('auto', 7), true);
  });

  it('the two explicit modes ignore the count', () => {
    assert.equal(openCollectActive('on', 0), true);
    assert.equal(openCollectActive('on', 1), true);
    assert.equal(openCollectActive('off', 9), false);
  });

  it('an unknown or missing mode falls back to automatic, and the OLD boolean still means something', () => {
    assert.equal(openCollectMode(undefined), 'auto');
    assert.equal(openCollectMode('quatsch'), 'auto');
    assert.equal(openCollectMode(''), 'auto');
    // the preference used to be a boolean; a stored `true` was „the user asked for collecting"
    assert.equal(openCollectMode(true), 'on');
    assert.equal(openCollectMode(false), 'auto');
    assert.equal(openCollectActive(true, 1), true, 'a migrated true must keep collecting');
    assert.equal(openCollectActive(undefined, 1), false);
  });
});

describe('open-points — adopt per frame + the F8 clock (CHAT-FLOW-8)', () => {
  const P = (frage, extra) => Object.assign({ frage, warum: '' }, extra || {});
  it('fresh = open now and not open before; only fresh points get raisedAt', () => {
    const old = P('Welches Werk ist gemeint?', { raisedAt: 5 });
    const r = openPointsAdopt([old], [P('Welches Werk ist gemeint?'), P('Soll der Report auch PDF können?')], 1000);
    assert.equal(r.points.length, 2);
    assert.equal(r.accepted.length, 2);
    assert.equal(r.accepted[0], old, 'a repeat resolves to the point already in the list (card and rail share one object)');
    assert.equal(old.raisedAt, 5, 'an already open point keeps its clock');
    assert.deepEqual(r.fresh.map((p) => p.frage), ['Soll der Report auch PDF können?']);
    assert.equal(r.fresh[0].raisedAt, 1000);
  });
  it('a point closed by a GUESS that is asked again is fresh again; an explicit close is not', () => {
    const guessed = P('Welches Werk ist gemeint?', { done: true, guessed: true, answer: 'ja', raisedAt: 5 });
    const dismissed = P('Soll der Report auch PDF können?', { done: true });
    const r = openPointsAdopt([guessed, dismissed], [P('Welches Werk ist gemeint?'), P('Soll der Report auch PDF können?')], 2000);
    assert.deepEqual(r.fresh.map((p) => p.frage), ['Welches Werk ist gemeint?']);
    assert.equal(guessed.done, false);
    assert.equal(guessed.raisedAt, 2000, 'asked again → the clock restarts');
    assert.equal(r.accepted.length, 2, 'the dismissed one still resolves (its card stays settled)');
  });
  it('a point the cap refused is neither accepted nor fresh; the same question twice in one frame is one point', () => {
    const full = Array.from({ length: OPEN_POINT_CAPS.points }, (_, i) => P('Offene Frage Nummer ' + i));
    const r = openPointsAdopt(full, [P('Eine ganz neue Frage, die nicht mehr passt')], 1);
    assert.equal(r.points.length, OPEN_POINT_CAPS.points);
    assert.equal(r.accepted.length, 0);
    assert.equal(r.fresh.length, 0);
    const twice = openPointsAdopt([], [P('Welches Werk ist gemeint?'), P('welches werk ist gemeint')], 1);
    assert.equal(twice.accepted.length, 1);
    assert.equal(twice.fresh.length, 1);
  });
  it('without a clock nothing is stamped (the resume path re-adopts history)', () => {
    const r = openPointsAdopt([], [P('Welches Werk ist gemeint?')]);
    assert.equal(r.fresh.length, 1);
    assert.equal('raisedAt' in r.fresh[0], false);
  });
  it('openPointsMatch with before: a point raised at or after the message was written is not what it answers (F8)', () => {
    const early = P('Welches Werk ist gemeint?', { raisedAt: 100 });
    const late = P('Soll der Report auch PDF können?', { raisedAt: 500 });
    // sole-open guess: only the early point is a candidate, so the free reply goes there
    let hits = openPointsMatch([early, late], 'ja, mach das', { before: 300 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].point, early);
    assert.equal(hits[0].guessed, true);
    // a quote of the LATE question does not count either — the message predates it
    hits = openPointsMatch([late], 'Soll der Report auch PDF können? ja', { before: 300 });
    assert.equal(hits.length, 0);
    // raisedAt == before is excluded (written in the same instant = not seen yet)
    assert.equal(openPointsMatch([P('Welches Werk ist gemeint?', { raisedAt: 300 })], 'ja', { before: 300 }).length, 0);
    // a point without raisedAt predates the rule and counts as raised before
    assert.equal(openPointsMatch([P('Welches Werk ist gemeint?')], 'ja', { before: 300 }).length, 1);
    // without before nothing is filtered
    assert.equal(openPointsMatch([late], 'ja').length, 1);
  });
  it('strip keeps a block that is not JSON (it would otherwise vanish without a trace)', () => {
    const bad = fence('{ das ist kein json');
    const good = fence(JSON.stringify([{ frage: 'Welches Werk ist gemeint?' }]));
    const out = openPointsStrip(['Vorher', bad, 'Mitte', good, 'Nachher'].join('\n'));
    assert.ok(out.includes('{ das ist kein json'), 'the broken block stays readable');
    assert.ok(!out.includes('Welches Werk'), 'the valid block is gone');
    assert.ok(out.includes('Nachher'));
  });
});
