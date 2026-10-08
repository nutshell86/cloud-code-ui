'use strict';
// „Alles zusammenfassen" (public/js/queue-merge.js). Two of these tests pin promises the UI makes to the
// user rather than mere formatting: a command is never swallowed into a paragraph, and the merge never
// reorders the queue (a message queued AFTER a /clear must not end up in front of it).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  queueItemText, queueTextIsCommand, queueItemIsCommand, queueItemMergeable, queueMergeCount,
  queueMergeRuns, queueMergeGain, queueMergeCompose, queueMergeItems, queueMerge,
  queueTakeLeadingText, QUEUE_MERGE_MIN,
  queueCardAnswer, queueRestoreTaken, queueAfterTurn, cardTakesTypedText,
} = require('../public/js/queue-merge');

const m = (text, attachments) => ({ text, attachments: attachments || [] });

describe('queue-merge — classification', () => {
  it('reads text defensively', () => {
    assert.equal(queueItemText(m('  hallo  ')), 'hallo');
    assert.equal(queueItemText(m(null)), '');
    assert.equal(queueItemText(null), '');
    assert.equal(queueItemText({}), '');
  });

  it('treats a leading slash as a command, wherever the whitespace is', () => {
    assert.equal(queueItemIsCommand(m('/clear')), true);
    assert.equal(queueItemIsCommand(m('  /compact')), true);
    assert.equal(queueItemIsCommand(m('/handoff')), true);
    assert.equal(queueItemIsCommand(m('bitte /clear erklären')), false);
    assert.equal(queueItemIsCommand(m('')), false);
  });

  it('the same rule reads bare text — what the composer holds is not a queue entry yet', () => {
    assert.equal(queueTextIsCommand('/clear'), true);
    assert.equal(queueTextIsCommand('  /compact '), true);
    assert.equal(queueTextIsCommand('bitte /clear erklären'), false);
    assert.equal(queueTextIsCommand(''), false);
    assert.equal(queueTextIsCommand(null), false);
    assert.equal(queueTextIsCommand(undefined), false);
  });

  it('an attachment-only entry is mergeable (it just brings its files along)', () => {
    assert.equal(queueItemMergeable(m('', [{ kind: 'text', name: 'a.txt' }])), true);
    assert.equal(queueItemMergeable(m('/clear')), false);
    assert.equal(queueItemMergeable(null), false);
  });

  it('counts how many messages an entry stands for', () => {
    assert.equal(queueMergeCount(m('a')), 1);
    assert.equal(queueMergeCount({ text: 'a', merged: 3 }), 3);
    assert.equal(queueMergeCount({ text: 'a', merged: 0 }), 1);
    assert.equal(queueMergeCount({ text: 'a', merged: 'x' }), 1);
    assert.equal(queueMergeCount(null), 1);
  });
});

describe('queue-merge — runs and gain', () => {
  it('needs at least two neighbours before there is a run', () => {
    assert.equal(QUEUE_MERGE_MIN, 2);
    assert.deepEqual(queueMergeRuns([m('a')]), []);
    assert.deepEqual(queueMergeRuns([m('a'), m('b')]), [{ from: 0, to: 1 }]);
    assert.deepEqual(queueMergeRuns([]), []);
    assert.deepEqual(queueMergeRuns(null), []);
  });

  it('splits at commands and keeps every run separately', () => {
    const q = [m('a'), m('b'), m('/clear'), m('c'), m('d'), m('e')];
    assert.deepEqual(queueMergeRuns(q), [{ from: 0, to: 1 }, { from: 3, to: 5 }]);
    assert.equal(queueMergeGain(q), 1 + 2); // 6 entries → 3
  });

  it('reports nothing to gain when every message stands alone between commands', () => {
    const q = [m('a'), m('/clear'), m('b')];
    assert.deepEqual(queueMergeRuns(q), []);
    assert.equal(queueMergeGain(q), 0);
  });
});

describe('queue-merge — composing the text', () => {
  it('leaves a single message exactly as it was (no head, no numbering)', () => {
    assert.equal(queueMergeCompose([m('nur eins')], { head: 'H:' }), 'nur eins');
    assert.equal(queueMergeCompose([m(''), m('nur eins')], { head: 'H:' }), 'nur eins');
  });

  it('numbers several messages under the caller-supplied head', () => {
    const out = queueMergeCompose([m('erstes'), m('zweites\nmit zweiter Zeile')], { head: 'Mehrere:' });
    assert.equal(out, 'Mehrere:\n\n1. erstes\n\n2. zweites\nmit zweiter Zeile');
  });

  it('has a head of its own when the caller passes none, and none when asked for none', () => {
    assert.match(queueMergeCompose([m('a'), m('b')]), /^Mehrere Anliegen/);
    assert.equal(queueMergeCompose([m('a'), m('b')], { head: '' }), '1. a\n\n2. b');
  });

  it('never throws on junk', () => {
    assert.equal(queueMergeCompose(null), '');
    assert.equal(queueMergeCompose([]), '');
    assert.equal(queueMergeCompose([null, {}]), '');
  });
});

describe('queue-merge — merging entries', () => {
  it('concatenates attachments in order and records the count', () => {
    const merged = queueMergeItems([m('a', [{ name: '1' }]), m('b', [{ name: '2' }, { name: '3' }])], { head: '' });
    assert.equal(merged.text, '1. a\n\n2. b');
    assert.deepEqual(merged.attachments.map((x) => x.name), ['1', '2', '3']);
    assert.equal(merged.merged, 2);
  });

  it('sums the counts when an already merged entry is merged again', () => {
    const once = queueMergeItems([m('a'), m('b')], { head: '' });
    const twice = queueMergeItems([once, m('c')], { head: '' });
    assert.equal(twice.merged, 3);
  });
});

describe('queue-merge — the whole queue', () => {
  it('collapses each run and keeps the commands in place', () => {
    const q = [m('a'), m('b'), m('/clear'), m('c'), m('d')];
    const out = queueMerge(q, { head: '' });
    assert.equal(out.length, 3);
    assert.equal(out[0].text, '1. a\n\n2. b');
    assert.equal(out[1].text, '/clear');   // untouched, same object identity
    assert.equal(out[1], q[2]);
    assert.equal(out[2].text, '1. c\n\n2. d');
  });

  it('never reorders: a message queued after a command stays after it', () => {
    const q = [m('vorher'), m('/clear'), m('nachher'), m('und noch was')];
    const out = queueMerge(q, { head: '' });
    assert.deepEqual(out.map((x) => x.text), ['vorher', '/clear', '1. nachher\n\n2. und noch was']);
  });

  it('leaves the input array and its entries untouched (the caller keeps it as undo)', () => {
    const q = [m('a'), m('b')];
    const snapshot = JSON.stringify(q);
    queueMerge(q, { head: '' });
    assert.equal(q.length, 2);
    assert.equal(JSON.stringify(q), snapshot);
  });

  it('is a no-op when there is nothing to gain, and never throws on junk', () => {
    const q = [m('a'), m('/clear'), m('b')];
    assert.deepEqual(queueMerge(q, { head: '' }).map((x) => x.text), ['a', '/clear', 'b']);
    assert.deepEqual(queueMerge([]), []);
    assert.deepEqual(queueMerge(null), []);
  });

  it('a second press re-numbers ONE flat list instead of nesting', () => {
    const first = queueMerge([m('a'), m('b')], { head: '' });
    first.push(m('c'));
    const second = queueMerge(first, { head: '' });
    assert.equal(second.length, 1);
    assert.equal(second[0].merged, 3);
    assert.equal(second[0].text, '1. a\n\n2. b\n\n3. c');
    assert.deepEqual(second[0].parts, ['a', 'b', 'c']);
  });
});

describe('queue-merge — [Mit Antwort senden] + the F8 clock (CHAT-FLOW-6/8)', () => {
  it('takes the leading plain-text run and stops at the first command or entry with files', () => {
    const q = [m('a'), m('b'), m('/clear'), m('c')];
    const r = queueTakeLeadingText(q);
    assert.deepEqual(r.take.map(queueItemText), ['a', 'b']);
    assert.deepEqual(r.rest.map(queueItemText), ['/clear', 'c'], 'the rest keeps its order — nothing after the command jumps ahead');
    const withFile = [m('a'), m('b', [{ name: 'x.png' }]), m('c')];
    const r2 = queueTakeLeadingText(withFile);
    assert.deepEqual(r2.take.map(queueItemText), ['a'], 'the answer is plain text — a file cannot ride along');
    assert.deepEqual(r2.rest.map(queueItemText), ['b', 'c']);
  });
  it('a queue that starts with a command takes nothing; garbage input is an empty split, not a throw', () => {
    const r = queueTakeLeadingText([m('/compact'), m('a')]);
    assert.equal(r.take.length, 0);
    assert.equal(r.rest.length, 2);
    assert.deepEqual(queueTakeLeadingText(null), { take: [], rest: [] });
    assert.equal(queueTakeLeadingText([m('a')]).rest.length, 0);
  });
  it('a merged entry carries the LATEST queuedAt of its parts (it may only answer what was asked before its newest part)', () => {
    const a = Object.assign(m('a'), { queuedAt: 100 });
    const b = Object.assign(m('b'), { queuedAt: 300 });
    const c = Object.assign(m('c'), { queuedAt: 200 });
    assert.equal(queueMergeItems([a, b, c], { head: '' }).queuedAt, 300);
    const merged = queueMerge([a, b, m('/clear'), c], { head: '' });
    assert.equal(merged[0].queuedAt, 300);
    assert.equal(merged[2].queuedAt, 200, 'an entry outside a run keeps its own clock');
    assert.equal('queuedAt' in queueMergeItems([m('x'), m('y')], { head: '' }), false, 'no clock in → no invented clock out');
  });
});

// The client wires these straight into sendQueueWithCard / the `result` tail / sendMessage + the chip
// (chat-composer.js, chat-events.js), so what is pinned here is the decision itself, not a copy of it.
describe('queue-merge — [Mit Antwort senden] keeps what it took until the POST settled (CHAT-FLOW-6)', () => {
  const PLAN = { head: 'Mehrere:', prefix: 'Bitte den Plan noch anpassen:' };
  it('plan card + two entries: the gate text carries the feedback and both entries, the queue is left empty', () => {
    const q = [Object.assign(m('erstens'), { queuedAt: 100 }), Object.assign(m('zweitens'), { queuedAt: 200 })];
    const out = queueCardAnswer(q, ['kürzer bitte'], PLAN);
    assert.equal(out.rest.length, 0, 'everything rode along — nothing left to flush behind the answer');
    assert.deepEqual(out.take, q);
    assert.equal(out.text, 'Mehrere:\n\n1. kürzer bitte\n\n2. erstens\n\n3. zweitens', 'the card\'s own field comes first');
    assert.equal(out.gate, 'Bitte den Plan noch anpassen:\n\n' + out.text, 'the directive goes to the gate only');
    for (const part of ['kürzer bitte', 'erstens', 'zweitens']) assert.ok(out.gate.includes(part), part + ' lost on the way');
    assert.equal(out.answer, 'erstens\n\nzweitens', 'F8 matches only what was QUEUED, not the card\'s own field');
    assert.equal(out.queuedAt, 200, 'the latest clock of the taken entries');
  });
  it('a question card has no prefix: gate text and bubble are the same; one part alone stays unnumbered', () => {
    const out = queueCardAnswer([m('nur das')], [], { head: 'Mehrere:' });
    assert.equal(out.text, 'nur das');
    assert.equal(out.gate, 'nur das');
    assert.equal(out.queuedAt, 0, 'no clock in → none invented');
  });
  it('takes only the leading plain-text run — the rest keeps its order and stays queued', () => {
    const q = [m('a'), m('/clear'), m('b')];
    const out = queueCardAnswer(q, [' ', null, 'gewählt'], { head: '' });
    assert.equal(out.text, '1. gewählt\n\n2. a', 'blank own parts are dropped, not numbered');
    assert.deepEqual(out.rest.map(queueItemText), ['/clear', 'b']);
  });
  it('nothing to take (command or file first, empty or junk queue) → null, the button has nothing to send', () => {
    assert.equal(queueCardAnswer([m('/compact'), m('a')], ['x']), null);
    assert.equal(queueCardAnswer([m('a', [{ name: 'f.png' }])], ['x']), null);
    assert.equal(queueCardAnswer([], ['x']), null);
    assert.equal(queueCardAnswer(null), null);
  });
  it('a failed POST puts the taken entries back at the FRONT, in order, ahead of what was queued meanwhile', () => {
    const q = [m('a'), m('b'), m('/clear'), m('c')];
    const out = queueCardAnswer(q, [], { head: '' });
    const meanwhile = out.rest.concat([m('später')]);
    const back = queueRestoreTaken(meanwhile, out.take);
    assert.deepEqual(back.map(queueItemText), ['a', 'b', '/clear', 'c', 'später']);
    assert.equal(back[0], q[0], 'the same entries (clock, parts) — not re-created copies');
    assert.deepEqual(queueRestoreTaken(null, out.take).map(queueItemText), ['a', 'b'], 'an emptied queue is no reason to lose them');
    assert.deepEqual(queueRestoreTaken([m('x')], null).map(queueItemText), ['x']);
  });
  it('restoring is the exact inverse of taking — whichever failure gets there', () => {
    // THREE paths now settle with an error and restore: a reply the server refused (postGateReply keeps the
    // gate and re-arms the card instead of leaving the turn blocked with no card), a stashed plan decision
    // whose gate never arrived before the turn ended (clearAsksForTab), and a held gate whose chat is gone
    // (submitGroup, which used to report success AND re-queue the text). All three hand back the same `take`,
    // so the queue has to come out exactly as it went in: same entries, same order, nothing re-created.
    const q = [Object.assign(m('a'), { queuedAt: 100 }), m('b'), m('/clear'), m('c', [{ name: 'f.png' }])];
    const out = queueCardAnswer(q, ['gewählt'], { head: '' });
    assert.deepEqual(out.take.map(queueItemText), ['a', 'b']);
    assert.deepEqual(queueRestoreTaken(out.rest, out.take), q, 'take + restore is a round trip');
    assert.equal(queueRestoreTaken(out.rest, out.take)[0], q[0], 'the entry itself, not a copy of it');
    // the card is answerable again afterwards, so the next attempt takes the same leading run once more
    const again = queueCardAnswer(queueRestoreTaken(out.rest, out.take), [], { head: '' });
    assert.deepEqual(again.take.map(queueItemText), ['a', 'b']);
    assert.deepEqual(queueRestoreTaken(again.rest, again.take), q, 'and a second failure loses nothing either');
  });
});

describe('queue-merge — after a turn: pause, flush or nothing (CHAT-FLOW-7)', () => {
  // Written out, one line per case, instead of re-stating the formula: the old version computed the expected
  // answer the same way queueAfterTurn does, so ANY change to the rule would have passed. These are the
  // answers the `result` tail depends on — every one of them has to be edited on purpose.
  //                queued  asked  newPts  force  →   pause  flush  chips
  const TRUTH_TABLE = [
    [0, false, 0, false, /* → */ false, false, true],  // nothing queued → nothing to pause or flush; chips show
    [0, false, 0, true, /*  → */ false, false, true],  // force without a queue decides nothing
    [0, false, 1, false, /* → */ false, false, true],  // new open points, empty queue: still just the chips
    [0, false, 1, true, /*  → */ false, false, true],
    [0, true, 0, false, /*  → */ false, false, true],  // Claude asked, nothing queued → chips, no pause
    [0, true, 0, true, /*   → */ false, false, true],
    [0, true, 1, false, /*  → */ false, false, true],
    [0, true, 1, true, /*   → */ false, false, true],
    [2, false, 0, false, /* → */ false, true, false],  // queue, no question → out at once; a flush overtakes chips
    [2, false, 0, true, /*  → */ false, true, false],
    [2, false, 1, false, /* → */ true, false, true],   // NEW open points hold the queue back
    [2, false, 1, true, /*  → */ false, true, false],  // …unless Strg+Enter forced it
    [2, true, 0, false, /*  → */ true, false, true],   // Claude asked → the queue must not talk over the question
    [2, true, 0, true, /*   → */ false, true, false],
    [2, true, 1, false, /*  → */ true, false, true],   // both reasons at once is still one pause
    [2, true, 1, true, /*   → */ false, true, false],
  ];
  it('the full truth table: queue × asked × new points × force', () => {
    assert.equal(TRUTH_TABLE.length, 16, 'every combination of the four inputs is in the table');
    for (const [queued, asked, newPoints, force, pause, flush, chips] of TRUTH_TABLE) {
      const label = JSON.stringify({ queued, asked, newPoints, force });
      assert.deepEqual(queueAfterTurn({ queued, asked, newPoints, force }), { pause, flush, chips }, label);
      assert.ok(!(pause && flush), label + ' never both');
    }
  });
  it('spot checks the table cannot hide', () => {
    assert.deepEqual(queueAfterTurn({ queued: 1, asked: true }), { pause: true, flush: false, chips: true }, 'Claude asked → the queue waits');
    assert.deepEqual(queueAfterTurn({ queued: 1, asked: true, force: true }), { pause: false, flush: true, chips: false }, 'Strg+Enter sends regardless');
    assert.deepEqual(queueAfterTurn({ queued: 1, newPoints: 2 }), { pause: true, flush: false, chips: true }, 'new open points hold it too');
    assert.deepEqual(queueAfterTurn({ queued: 0, asked: true }), { pause: false, flush: false, chips: true }, 'no queue → nothing to pause, chips shown');
  });
  it('junk in → an idle answer, not a throw', () => {
    assert.deepEqual(queueAfterTurn(null), { pause: false, flush: false, chips: true });
    assert.deepEqual(queueAfterTurn({ queued: 'x', asked: true }), { pause: false, flush: false, chips: true });
  });
});

describe('queue-merge — does typed text answer the open card? (CHAT-FLOW-9)', () => {
  const card = (g) => ({ toolId: 't1', g });
  it('a question with a HELD gate takes it — whether or not the tab is streaming', () => {
    assert.equal(cardTakesTypedText(card({ requestId: 'r1', streaming: true }), [], 'ja, bitte so'), true);
    // FLOW-3: the CLI's own follow-up turn blocks at the gate with streaming=false — the predicate has no input for it
    assert.equal(cardTakesTypedText(card({ requestId: 'r1' }), undefined), true);
  });
  it('a typed COMMAND is never the card\'s answer — it stays a message/queue entry', () => {
    // Submitted as the answer, „/clear" went to the model as that literal string: markCtxOp never ran, the
    // ctx gauge kept the old value and the session it was meant to clear stayed as it was.
    assert.equal(cardTakesTypedText(card({ requestId: 'r1' }), [], '/clear'), false);
    assert.equal(cardTakesTypedText(card({ requestId: 'r1' }), [], '  /compact'), false);
    assert.equal(cardTakesTypedText(card({ requestId: 'r1' }), [], '/handoff'), false);
    // only a LEADING slash is a command — a sentence that mentions one is an ordinary answer
    assert.equal(cardTakesTypedText(card({ requestId: 'r1' }), [], 'bitte /clear erklären'), true);
    // no text passed (or an empty one) → nothing to object to, the gate decides as before
    assert.equal(cardTakesTypedText(card({ requestId: 'r1' }), []), true);
    assert.equal(cardTakesTypedText(card({ requestId: 'r1' }), [], ''), true);
    assert.equal(cardTakesTypedText(card({ requestId: 'r1' }), [], null), true);
  });
  it('no requestId yet → no (the text would only become an ordinary message)', () => {
    assert.equal(cardTakesTypedText(card({}), []), false);
    assert.equal(cardTakesTypedText(card({ requestId: '' }), []), false);
  });
  it('attachments → no: files cannot ride on a card answer', () => {
    assert.equal(cardTakesTypedText(card({ requestId: 'r1' }), [{ name: 'a.png' }]), false);
  });
  it('a plan card never takes typed text, even with its gate held; no card → no', () => {
    assert.equal(cardTakesTypedText(card({ requestId: 'r1', isPlan: true }), []), false);
    assert.equal(cardTakesTypedText(null, []), false);
    assert.equal(cardTakesTypedText({}, []), false);
  });
});

describe('queue-merge — the panel\'s plan messages stay standalone (PF-1b)', () => {
  // ▶ Plan starten / the composer chip / 📋 Schritte anfordern queue their message with `plan: true`. The live tab and
  // the resume fold read it back by its shape where it goes out as a USER message — merged into a numbered list it
  // would start the plan from the middle of another request, and ridden into a card answer it would become a gate's
  // tool_result, which the fold reads as an approval.
  const p = (text) => Object.assign(m(text), { plan: true });
  it('never merged, never taken into a card answer — the entries around it still are', () => {
    assert.equal(queueItemMergeable(p('plan starten\n\n```plan-schritte\n[]\n```')), false);
    const q = [m('a'), m('b'), p('START'), m('c'), m('d')];
    assert.deepEqual(queueMerge(q, { head: 'H' }).map((it) => (it.plan ? 'PLAN' : it.merged || 1)), [2, 'PLAN', 2], 'the runs on both sides merge, the plan entry stands alone');
    const r = queueTakeLeadingText(q);
    assert.deepEqual(r.take.map(queueItemText), ['a', 'b'], '[Mit Antwort senden] stops before it');
    assert.equal(queueTakeLeadingText([p('START'), m('a')]).take.length, 0);
  });
});
