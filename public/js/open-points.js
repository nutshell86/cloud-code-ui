'use strict';
// Shared "open points" channel — browser (classic script) AND Node (require'd by the test suite).
// Keep this file dependency-free and side-effect-free (ui-result.js / pure.js spirit); no t()/DOM here.
//
// WHY this channel exists: for an uncertainty found mid-work there were exactly two options, and both
// cost the user. AskUserQuestion stops the WHOLE turn until it is answered — including the ten things
// that don't depend on the answer. A sentence in prose inside a long answer gets scrolled past. So the
// realistic outcomes were "block" or "guess".
//
// The protocol: an answer may end with ONE fenced block
//   ```offene-punkte
//   [{ "frage": "Welches Z_EXAMPLE ist gemeint — Werk 1 oder 2?",
//      "warum": "Ich kartiere erst mal die Aufrufer von beiden", "tone": "info",
//      "optionen": ["Werk 1", "Werk 2", {"label": "beide", "desc": "kostet einen zweiten Durchlauf"}] }]
//   ```
// The panel shows each point in TWO places at once — a card in the transcript, where the question was
// asked, and a row in the side rail, which survives scrolling. Both read this same object.
// The protocol text itself is injected via lib/pure composeAppendSystem, so a session can discover
// the channel without anyone having read the README.
//
// `optionen` is optional and turns the card's free-text field into a set of one-click answers. It does
// NOT make the point a blocking question — an open point is answered when it suits the reader, or not
// at all; that is the whole difference to AskUserQuestion.
//
// The block is MODEL-AUTHORED, therefore untrusted: same hardening as ui-result — length caps, a tone
// allowlist, coercion of every field, and a hard cap on the number of entries.

var OPEN_POINT_TONES = ['ok', 'warn', 'err', 'info', 'muted'];
var OPEN_POINT_CAPS = { points: 10, frage: 400, warum: 400, optionen: 6, label: 90, desc: 200 };

function openPointStr(v, max) {
  if (v == null) return '';
  var s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
function openPointTone(v) { return OPEN_POINT_TONES.indexOf(String(v == null ? '' : v)) >= 0 ? String(v) : ''; }

// Ready-made answers for one point. A plain string is the common case ("Werk 1"); the object form adds
// the one line of consequence that makes a choice decidable without asking back.
function openPointOptions(v) {
  if (!Array.isArray(v)) return [];
  var out = [];
  for (var i = 0; i < v.length && out.length < OPEN_POINT_CAPS.optionen; i++) {
    var o = v[i], label = '', desc = '';
    if (o == null) continue;
    if (typeof o === 'object' && !Array.isArray(o)) {
      label = openPointStr(o.label != null ? o.label : o.titel, OPEN_POINT_CAPS.label);
      desc = openPointStr(o.desc != null ? o.desc : (o.description != null ? o.description : o.beschreibung), OPEN_POINT_CAPS.desc);
    } else {
      label = openPointStr(o, OPEN_POINT_CAPS.label);
    }
    if (label) out.push(desc ? { label: label, desc: desc } : { label: label, desc: '' });
  }
  return out;
}

// One entry. Accepts the object form and a bare string (a model that only writes the question is
// being cooperative, not wrong — don't drop it over the shape).
function openPointNormalizeOne(p) {
  if (p == null) return null;
  if (typeof p === 'string' || typeof p === 'number') {
    var s = openPointStr(p, OPEN_POINT_CAPS.frage);
    return s ? { frage: s, warum: '', tone: '' } : null;
  }
  if (typeof p !== 'object' || Array.isArray(p)) return null;
  var frage = openPointStr(p.frage != null ? p.frage : (p.question != null ? p.question : p.text), OPEN_POINT_CAPS.frage);
  if (!frage) return null; // an entry without a question is not an open point
  var out = { frage: frage, warum: openPointStr(p.warum != null ? p.warum : p.why, OPEN_POINT_CAPS.warum), tone: openPointTone(p.tone) };
  // only set when there is something to set — a point without ready-made answers keeps the plain
  // three-field shape it always had (and the card falls back to its free-text field)
  var opts = openPointOptions(p.optionen != null ? p.optionen : p.options);
  if (opts.length) out.optionen = opts;
  return out;
}
function openPointsNormalize(data) {
  var arr = Array.isArray(data) ? data : (data && Array.isArray(data.punkte) ? data.punkte : (data && Array.isArray(data.points) ? data.points : null));
  if (!arr) {
    // a single object is a plausible shape too — one open point, not wrapped in an array
    var one = openPointNormalizeOne(data);
    return one ? [one] : [];
  }
  var out = [];
  for (var i = 0; i < arr.length && out.length < OPEN_POINT_CAPS.points; i++) {
    var n = openPointNormalizeOne(arr[i]);
    if (n) out.push(n);
  }
  return out;
}

// Every valid block in the text, flattened. Unlike ui-result (where a later block REPLACES the
// result) open points accumulate: two blocks in one turn are two sets of questions, not a correction.
function openPointsExtract(text) {
  var re = /```offene-punkte\s*\n([\s\S]*?)```/g;
  var out = [];
  var m;
  while ((m = re.exec(String(text || ''))) !== null) {
    try {
      var pts = openPointsNormalize(JSON.parse(m[1]));
      for (var i = 0; i < pts.length && out.length < OPEN_POINT_CAPS.points; i++) out.push(pts[i]);
    } catch { /* invalid JSON in the block → skip it, never throw into the render path */ }
  }
  return out;
}
// Strip the blocks from the text. The rail is where the points belong; leaving the raw JSON in the
// transcript as well would show the same content twice, once unreadably.
// A block that is not JSON at all stays: openPointsExtract skips it, so stripping it would make it vanish
// without a trace — left in place, the transcript shows it as a code block (render.js) and it can be read.
function openPointsStrip(text) {
  return String(text == null ? '' : text).replace(/```offene-punkte\s*\n([\s\S]*?)```\s*/g, function (all, body) {
    try { JSON.parse(body); return ''; } catch { return all; }
  });
}
// Identity of a point, so the same question asked again in a later turn doesn't stack up in the rail.
function openPointNorm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim(); }
function openPointKey(p) { return openPointNorm((p && p.frage) || ''); }

// A point can be answered in the chat without ever touching the card — the rail puts the question into
// the composer (openPointRow in chat-side.js), so the sent message QUOTES it. That path existed but its
// last step was missing: sending closed nothing, and the row stayed in the rail after it was answered.
//
// Two signals are decidable without guessing, and nothing else counts:
//   1. the message contains the question → the answer is what remains once the quote is removed
//   2. the message IS one of the ready-made options ("beides") — but only when that label belongs to
//      exactly ONE open point; two candidates would mean picking one at random
// A free reply with neither signal ("ja, mach das") stays open on purpose: silently dropping a question
// the reader still wants is worse than a row they dismiss with ✕.
var OPEN_POINT_QUOTE_MIN = 12; // "welches werk" — below that a quote match is coincidence, not a quote

// `opts.before` (a timestamp) = the message was WRITTEN then — a queued message goes out later, and by then
// the model may have asked something new. Only points raised before it (`raisedAt` < before) can be what it
// answers; a point without `raisedAt` is older than this rule and counts as raised before (F8).
function openPointsMatch(points, text, opts) {
  var raw = String(text == null ? '' : text).trim();
  var norm = openPointNorm(raw);
  if (!norm) return [];
  var before = opts && Number(opts.before) > 0 ? Number(opts.before) : 0;
  var open = [];
  for (var i = 0; i < (points || []).length; i++) {
    var p = points[i];
    if (p && !p.done && openPointKey(p) && !(before && Number(p.raisedAt) >= before)) open.push(p);
  }
  var out = [], taken = [];
  open.forEach(function (p) {
    var k = openPointKey(p);
    if (k.length < OPEN_POINT_QUOTE_MIN || norm.indexOf(k) < 0) return;
    // cut the quoted question out of the ORIGINAL text — what is left is the answer
    var rest = raw, at = raw.indexOf(p.frage);
    if (at >= 0) rest = raw.slice(0, at) + raw.slice(at + p.frage.length);
    rest = rest.trim();
    if (!rest) return;                     // the question alone is not an answer to it
    // …and neither is the question typed AGAIN in other words: the literal cut above misses it (the text
    // differs), so what remains is the whole message and looked like an answer that happens to be the
    // question. Compare normalised, the same way the match itself is decided.
    if (openPointNorm(rest) === k) return;
    taken.push(p);
    out.push({ point: p, answer: rest });
  });
  var hits = [];
  open.forEach(function (p) {
    if (taken.indexOf(p) >= 0) return;
    var opts = p.optionen || [];
    for (var j = 0; j < opts.length; j++) {
      if (opts[j] && openPointNorm(opts[j].label) === norm) { hits.push(p); return; }
    }
  });
  if (hits.length === 1) out.push({ point: hits[0], answer: raw });
  // 3. exactly ONE question is still open → the next message is decidable as well: there is nothing else
  //    it could be answering. This is the same „exactly one candidate" rule as (2), and it is what the
  //    report „beantwortete Fragen verschwinden nicht" was about — an answer typed in the reader's own
  //    words („ja, mach das") matched neither signal, so the row stayed until it was dismissed by hand.
  //    The hit is marked `guessed`, and a guess is reversible: if the model asks the SAME question again,
  //    openPointsMerge re-opens the point (see there). That is what makes reading this reply as the answer
  //    safe — the earlier objection („silently dropping a question the reader still wants") only holds
  //    while such a close is final.
  //    Two things are never an answer: a slash command (it addresses the CLI, not the question) and any
  //    message while an answer is already STAGED on that point — there the send bar is the path, and this
  //    text is something else. With two or more open questions nothing is guessed: which one a prose reply
  //    belongs to is not decidable, and picking one would be worse than a row that waits.
  if (!out.length && open.length === 1 && !/^\//.test(raw)
      && !(typeof open[0].staged === 'string' && open[0].staged.trim())) {
    // The rail prefills the composer with the QUESTION — sending that unchanged is not an answer to it.
    // So cut a quoted question out first and require that something is left (same rule as signal 1, which
    // only skipped this message because the question was too short to be recognised as a quote).
    var sole = open[0], rest2 = raw, at2 = raw.indexOf(sole.frage);
    if (at2 >= 0) rest2 = (raw.slice(0, at2) + raw.slice(at2 + sole.frage.length)).trim();
    if (rest2 && openPointNorm(rest2) !== openPointKey(sole)) out.push({ point: sole, answer: rest2, guessed: true });
  }
  return out;
}

// Merge new points into a tab's list: known questions keep their place (and their dismissed state),
// new ones are appended, and the cap holds.
function openPointsMerge(existing, incoming) {
  var out = (existing || []).slice();
  var seen = {};
  out.forEach(function (p) { seen[openPointKey(p)] = true; });
  var byKey = function (k) {
    for (var i = 0; i < out.length; i++) if (out[i] && openPointKey(out[i]) === k) return out[i];
    return null;
  };
  (incoming || []).forEach(function (p) {
    var k = openPointKey(p);
    if (!k) return;
    if (seen[k]) {
      // The model is asking again. A point that was closed by a GUESS (openPointsMatch signal 3: a free
      // reply read as its answer) is re-opened — the model insisting IS the evidence that the guess was
      // wrong. An explicitly answered or explicitly dismissed point stays closed: that was a decision,
      // and a question the reader put away must not crawl back every turn.
      var prev = byKey(k);
      if (prev && prev.done && prev.guessed) { prev.done = false; prev.answer = ''; prev.guessed = false; }
      return;
    }
    seen[k] = true;
    // Cap reached → make room by dropping the oldest SETTLED point. Answered points counted against the
    // cap, and the rail hides them — so after ten questions in one tab the list was full of rows nobody
    // could see and every genuinely NEW question was dropped without a trace. A waiting question is never
    // evicted: if all ten are still open that is a real overflow and refusing is right.
    if (out.length >= OPEN_POINT_CAPS.points) {
      var at = -1;
      for (var i = 0; i < out.length; i++) if (out[i] && out[i].done) { at = i; break; }
      if (at < 0) return;
      delete seen[openPointKey(out[at])]; // evicted → that question may legitimately be asked again
      out.splice(at, 1);
    }
    out.push(p);
  });
  return out;
}
// Merge, and say what became of each incoming point — the panel needs both answers (CHAT-FLOW-8):
//  · accepted — the objects that now LIVE in the list, one per question. A repeat resolves to the point
//    already there (card and rail share one identity); a point the cap refused is left out, because a card
//    for it would be a question without a row in the rail and without anybody keeping its state.
//  · fresh — open now and not open before: asked for the first time, or asked again after a guessed close.
//    That is what counts as „Claude has asked" for the queue (CHAT-FLOW-7); a point that was open anyway
//    and is only listed again does not. Each gets `raisedAt` = now, the clock openPointsMatch's `before` reads.
function openPointsAdopt(existing, incoming, now) {
  var wasOpen = {};
  (existing || []).forEach(function (p) { if (p && !p.done) wasOpen[openPointKey(p)] = true; });
  var points = openPointsMerge(existing, incoming);
  var accepted = [], fresh = [];
  (incoming || []).forEach(function (f) {
    var k = openPointKey(f);
    if (!k) return;
    var p = null;
    for (var i = 0; i < points.length; i++) if (points[i] && openPointKey(points[i]) === k) { p = points[i]; break; }
    if (!p || accepted.indexOf(p) >= 0) return;
    accepted.push(p);
    if (!p.done && !wasOpen[k]) { if (now != null) p.raisedAt = now; fresh.push(p); }
  });
  return { points: points, accepted: accepted, fresh: fresh };
}

// Are these two lists the same set of open questions? The card in the transcript and the row in the
// rail are two views of ONE array, so the repaint guard has to notice a resolved point — comparing the
// questions alone said "unchanged" and the row stayed after it had been answered.
function openPointsSig(points) {
  return (points || []).map(function (p) {
    // the staged answer belongs in the signature too: staging changes the rail (a ⧉ marker and the
    // „n Antworten senden" bar), and without it the rail would keep showing the pre-staging state.
    var staged = (p && typeof p.staged === 'string' && p.staged.trim()) ? '⧉' + p.staged.length : '';
    return openPointKey(p) + (p && p.done ? '!' : '') + ((p && p.optionen ? p.optionen.length : 0)) + staged;
  }).join('|');
}

// ---------------- collect mode: answer several points, send once ---------------------------------
// Why this exists: answering ONE point starts a turn, and while that turn runs every further answer is
// queued behind it — so with three open questions you either send three turns or you wait. Staging keeps
// the answers on the points until you say go, and then they travel as ONE message.
//
// A staged answer is `p.staged` (a string). It is NOT `p.answer`: that one means „this point is
// settled", and a point whose answer has not been sent yet is not settled. Keeping them apart is what
// lets the rail keep showing the question while the answer is already written.
function openPointsStaged(points) {
  return (points || []).filter(function (p) {
    return p && !p.done && typeof p.staged === 'string' && p.staged.trim();
  });
}
// How many questions are still waiting — the number the automatic mode decides on.
function openPointsOpenCount(points) {
  return (points || []).filter(function (p) { return p && typeof p === 'object' && p.frage && !p.done; }).length;
}
// The three modes, and the threshold the automatic one uses.
//   'auto' (default) — stage as soon as there are TWO or more open questions. With one question the
//                      immediate answer is right: nothing is queued behind it, and a „send" button would
//                      be pure ceremony. With two, answering the first is what makes the second wait.
//   'on'  — always stage.  'off' — never stage.
var OPEN_POINT_COLLECT_MIN = 2;
var OPEN_POINT_COLLECT_MODES = ['auto', 'on', 'off'];
// Accepts the old boolean too: this preference used to be `true`/`false` before the automatic mode
// existed, and a stored `true` means „the user asked for collecting" — that is 'on', not 'auto'.
function openCollectMode(v) {
  if (v === true) return 'on';
  if (v === false) return 'auto';
  return OPEN_POINT_COLLECT_MODES.indexOf(String(v || '')) >= 0 ? String(v) : 'auto';
}
function openCollectActive(mode, openCount, min) {
  var m = openCollectMode(mode);
  if (m === 'on') return true;
  if (m === 'off') return false;
  var n = Number(min) > 0 ? Number(min) : OPEN_POINT_COLLECT_MIN;
  return (Number(openCount) || 0) >= n;
}
// The one message for all staged answers. Numbered and quoting each question, for the same reason the
// single-answer path quotes it: the answers arrive an unknown number of messages after the questions,
// and „Werk 2 · ja · später" on its own is a riddle. Labels come from the caller — this file stays free
// of t()/DOM.
function openPointsComposeBatch(points, labels) {
  var l = labels || {};
  var head = String(l.head || 'Answers to the open points:');
  var arrow = String(l.arrow || '→ ');
  var staged = openPointsStaged(points);
  if (!staged.length) return '';
  var parts = staged.map(function (p, i) {
    return (i + 1) + '. ' + String(p.frage || '').trim() + '\n' + arrow + String(p.staged).trim();
  });
  return head + '\n\n' + parts.join('\n\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    openPointsExtract, openPointsNormalize, openPointsStrip, openPointsMerge, openPointsAdopt, openPointKey,
    openPointNorm, openPointsMatch, openPointOptions, openPointsSig,
    openPointsStaged, openPointsComposeBatch, openPointsOpenCount,
    openCollectMode, openCollectActive,
    OPEN_POINT_CAPS, OPEN_POINT_TONES, OPEN_POINT_QUOTE_MIN,
    OPEN_POINT_COLLECT_MIN, OPEN_POINT_COLLECT_MODES,
  };
}
