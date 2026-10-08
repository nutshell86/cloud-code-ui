'use strict';
// Merging queued messages into one — browser (classic script) AND Node (require'd by the test suite).
// Keep this file dependency-free and side-effect-free (open-points.js / ui-result.js spirit); no t()/DOM here.
//
// WHY: the queue flushes ONE entry per turn. Three queued follow-ups are therefore three turns — each
// paying its own system prompt and re-reading the transcript, and each answering without knowing what
// the next two were going to ask. Very often they belong together anyway ("und bitte auch noch …").
// „Alles zusammenfassen" turns such a run into a single numbered message, i.e. one turn that sees all
// of it at once. Same trick as the staged answers in open-points.js (openPointsComposeBatch), same
// numbering style.
//
// TWO RULES that make this safe rather than merely convenient:
//  1. A slash command is never merged. `/clear`, `/compact`, `/handoff` only mean anything when they are
//     the WHOLE message; glued into a paragraph they lose their meaning and the paragraph loses its own.
//  2. Only CONSECUTIVE runs merge. `[A, /clear, B]` keeps its three entries, because B was queued to run
//     after the clear — pulling it in front of the command would silently change what the user asked for.
//     So the merge can shrink the queue, never reorder it.

var QUEUE_MERGE_MIN = 2;                // a run needs this many entries before there is anything to merge
var QUEUE_MERGE_HEAD = 'Mehrere Anliegen in einer Nachricht:'; // caller passes the translated label

function queueItemText(item) {
  return String((item && item.text) || '').trim();
}
// A message that starts with a slash addresses the CLI/panel, not the conversation → keep it standalone.
// The text form is its own predicate because the same rule decides about text that is not (yet) a queue
// entry: what is typed in the composer while a card is open (cardTakesTypedText).
function queueTextIsCommand(text) {
  return /^\//.test(String(text == null ? '' : text).trim());
}
function queueItemIsCommand(item) {
  return queueTextIsCommand(queueItemText(item));
}
// PF-1b — an entry the panel queued for the PLAN (`plan: true`: ▶ Plan starten, the composer chip's attachment,
// 📋 Schritte anfordern, [Stand abfragen]) stays standalone as well. The live tab and the resume fold read it back
// by its shape — a start where it goes out as a user message — so it must go out as it was built: merged into a
// numbered list it would start something in the middle of another request, and ridden into a card's answer
// ([Mit Antwort senden]) it would become a gate's tool_result, which the fold reads as an APPROVAL.
function queueItemMergeable(item) {
  return !!item && !queueItemIsCommand(item) && !item.plan;
}
// How many source entries a (possibly already merged) entry stands for — drives the ⧉n chip badge.
function queueMergeCount(item) {
  var n = item && Number(item.merged);
  return n && n > 1 ? Math.floor(n) : 1;
}
// The single messages an entry is made of. A merged entry keeps them in `parts`, so merging AGAIN (queue a
// third message, press the button again) re-numbers ONE flat list instead of nesting „1. 1. a … 2. b" —
// which is what the model would otherwise have to untangle.
function queueItemParts(item) {
  if (item && Array.isArray(item.parts) && item.parts.length) {
    return item.parts.map(function (p) { return String(p == null ? '' : p).trim(); }).filter(Boolean);
  }
  var txt = queueItemText(item);
  return txt ? [txt] : [];
}
function queueMergeParts(items) {
  var out = [];
  (Array.isArray(items) ? items : []).forEach(function (it) { out = out.concat(queueItemParts(it)); });
  return out;
}
// Index ranges [{from, to}] (inclusive) of consecutive mergeable entries, only where something is to gain.
function queueMergeRuns(queue) {
  var q = Array.isArray(queue) ? queue : [];
  var runs = [], start = -1;
  for (var i = 0; i <= q.length; i++) {
    var ok = i < q.length && queueItemMergeable(q[i]);
    if (ok) { if (start < 0) start = i; continue; }
    if (start >= 0 && i - start >= QUEUE_MERGE_MIN) runs.push({ from: start, to: i - 1 });
    start = -1;
  }
  return runs;
}
// Entries that would disappear if everything mergeable were merged (0 = the button has nothing to do).
function queueMergeGain(queue) {
  return queueMergeRuns(queue).reduce(function (n, r) { return n + (r.to - r.from); }, 0);
}
// The merged text: nothing fancy for a single sentence, a numbered list (house style) for several.
// Entries that carry only attachments contribute no number — they just bring their files along.
function queueMergeCompose(items, labels) {
  return queueComposeParts(queueMergeParts(items), labels);
}
function queueComposeParts(parts, labels) {
  var head = labels && labels.head != null ? String(labels.head) : QUEUE_MERGE_HEAD;
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  var numbered = parts.map(function (txt, i) { return (i + 1) + '. ' + txt; });
  return (head ? head + '\n\n' : '') + numbered.join('\n\n');
}
function queueMergeItems(items, labels) {
  var list = Array.isArray(items) ? items : [];
  var atts = [];
  var n = 0, at = 0;
  list.forEach(function (it) {
    if (it && Array.isArray(it.attachments)) atts = atts.concat(it.attachments);
    n += queueMergeCount(it);
    if (it && Number(it.queuedAt) > at) at = Number(it.queuedAt);
  });
  var parts = queueMergeParts(list);
  var merged = { text: queueComposeParts(parts, labels), attachments: atts };
  if (n > 1) merged.merged = n;
  if (parts.length > 1) merged.parts = parts;
  // the LATEST of its parts: a merged entry may only answer open points that were already on the table
  // when its newest part was written (F8 — the flush matches against points raised before `queuedAt`)
  if (at) merged.queuedAt = at;
  return merged;
}
// „↪ Jetzt einspeisen" — an entry that can go into the RUNNING turn. Measured 07.10. (CLI 2.1.292, live probe): a user
// message written to stdin mid-turn reaches the model at the next tool boundary, in the SAME turn (a `queued_command`
// attachment, mode „prompt") — the end-of-turn queue is not needed for it. Plain text only: a command acts on the session
// as a whole message, a plan entry is read back by its shape (queueItemMergeable), and files mid-turn are unmeasured.
function queueItemInjectable(item) {
  return queueItemMergeable(item) && !item.planFor && !(Array.isArray(item.attachments) && item.attachments.length);
}
// The badge's share: the LEADING run of injectable entries. It stops at the first one that is not — a queued /clear
// or a file keeps its place, and nothing typed after it slips in ahead of it.
function queueInjectTake(queue) {
  var q = Array.isArray(queue) ? queue : [];
  var n = 0;
  while (n < q.length && queueItemInjectable(q[n])) n++;
  return { take: q.slice(0, n), rest: q.slice(n) };
}
// [Mit Antwort senden] — the leading run of entries that can ride along with the answer to a held card.
// That answer is plain text (the permission reply has no channel for files), and a command only means
// something as a whole message; so the run stops at the first entry with attachments or a slash, and
// everything from there keeps its place in the queue. Taking only a LEADING run never reorders anything.
function queueTakeLeadingText(queue) {
  var q = Array.isArray(queue) ? queue : [];
  var n = 0;
  while (n < q.length && queueItemMergeable(q[n]) && !(Array.isArray(q[n].attachments) && q[n].attachments.length)) n++;
  return { take: q.slice(0, n), rest: q.slice(n) };
}
// [Mit Antwort senden], step 1: what goes out and what stays — or null when nothing can ride along.
// `own` is what the card itself already holds (picked options, its free-text/feedback field); it comes
// first, the queued entries follow as ONE numbered answer. `labels.prefix` is put in front of the gate
// text only (a plan's „bitte den Plan noch …" directive) — the bubble shows what YOU wrote, not the
// directive. `answer` (only the queued part) and `queuedAt` (its latest clock) are for the F8 matching,
// which runs once the reply really went out. The caller keeps `take` until then (step 2).
function queueCardAnswer(queue, own, labels) {
  var split = queueTakeLeadingText(queue);
  if (!split.take.length) return null;
  var answer = queueMergeParts(split.take);
  var mine = (Array.isArray(own) ? own : []).map(function (p) { return String(p == null ? '' : p).trim(); }).filter(Boolean);
  var text = queueComposeParts(mine.concat(answer), labels);
  var prefix = labels && labels.prefix ? String(labels.prefix) : '';
  var at = 0;
  split.take.forEach(function (it) { if (it && Number(it.queuedAt) > at) at = Number(it.queuedAt); });
  return {
    take: split.take, rest: split.rest, text: text,
    gate: prefix ? prefix + '\n\n' + text : text,
    answer: answer.join('\n\n'), queuedAt: at,
  };
}
// [Mit Antwort senden], step 2 — only when the POST carrying the answer failed: the taken entries go back
// to the FRONT, in their order. They left the queue before the POST (so a second click can't send them
// twice), and whatever was queued meanwhile was queued after them.
function queueRestoreTaken(queue, take) {
  return (Array.isArray(take) ? take : []).concat(Array.isArray(queue) ? queue : []);
}
// The end of a turn (`result`) — does the queue go on, wait, or is there none (CHAT-FLOW-7)?
//  · pause: something is queued, Claude asked (heuristic question/offer) or raised NEW open points, and the
//    flush wasn't forced (Strg+Enter „Jetzt senden" = `force`) → the queue must not talk over the question;
//  · flush: something is queued and nothing holds it back;
//  · chips: the quick-reply row is worth painting — with no queue, or when the queue waits for the answer.
//    A flushing queue overtakes the chips anyway.
function queueAfterTurn(s) {
  var queued = !!(s && Number(s.queued) > 0);
  var pause = queued && !(s && s.force) && (!!(s && s.asked) || Number(s && s.newPoints) > 0);
  return { pause: pause, flush: queued && !pause, chips: !queued || pause };
}
// CHAT-FLOW-9 — does typed text answer this open card (the composer's routing AND the chip that announces
// it, one predicate for both)? Only a QUESTION whose gate is held: the gate is what turns the text into the
// tool result the model is blocked on. `streaming` does not enter into it — a follow-up turn the CLI starts
// by itself (FLOW-3) runs with streaming=false and blocks at its gate all the same. Without a held gate the
// text would only become an ordinary message, so it is sent/queued as one. A plan is answered by its own
// buttons, never by a side remark. Files can't ride on a card answer → with attachments it is a message.
// A COMMAND is no answer either (rule 1 above): submitted as the card's answer, `/clear` would reach the
// model as the literal string while the session it was supposed to clear stays as it is (and the context
// gauge with it). It stays a message, so it queues and runs as a command when the turn ends.
function cardTakesTypedText(card, attachments, text) {
  var g = card && card.g;
  return !!(g && !g.isPlan && g.requestId) && !(Array.isArray(attachments) && attachments.length)
    && !queueTextIsCommand(text);
}
// The whole queue, with every mergeable run collapsed. Returns a NEW array; the input is untouched, so
// the caller can keep it as the one-step undo.
function queueMerge(queue, labels) {
  var q = Array.isArray(queue) ? queue.slice() : [];
  var runs = queueMergeRuns(q);
  if (!runs.length) return q;
  var out = [], at = 0;
  runs.forEach(function (r) {
    while (at < r.from) { out.push(q[at]); at++; }
    out.push(queueMergeItems(q.slice(r.from, r.to + 1), labels));
    at = r.to + 1;
  });
  while (at < q.length) { out.push(q[at]); at++; }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    queueItemText, queueTextIsCommand, queueItemIsCommand, queueItemMergeable, queueMergeCount,
    queueItemParts, queueMergeParts, queueComposeParts,
    queueMergeRuns, queueMergeGain, queueMergeCompose, queueMergeItems, queueMerge, queueTakeLeadingText,
    queueCardAnswer, queueRestoreTaken, queueAfterTurn, cardTakesTypedText, queueItemInjectable, queueInjectTake,
    QUEUE_MERGE_MIN, QUEUE_MERGE_HEAD,
  };
}
