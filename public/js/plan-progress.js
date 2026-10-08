'use strict';
// Plan progress — "where are we in the accepted plan". Browser (classic script) AND Node (require'd by
// lib/sessions.js for the resume fold, by lib/pure.js for the system-prompt hint, and by the test suite).
// Dependency-free and side-effect-free (open-points.js / ui-result.js spirit): no t()/DOM here — the
// caller passes translated sentences in and paints what comes out.
//
// WHY this channel exists: the panel's only progress display was #chatTodos, and it listens to TodoWrite
// alone — which occurs 0× in 561 transcripts. CLI 2.1.288 switches TodoWrite AND Task* off for Opus 5.5
// (`Sj()` / the `Gcr` model list in the binary), so a native tool will not tell the panel anything. What
// does work is a fenced block the model writes into its text: ```offene-punkte occurs 782× in 64
// transcripts. So the model reports its plan state the same way:
//   ```plan-status
//   {"aktuell": "S3", "erledigt": ["S1", "S2"], "aktiv": "Verdrahte die Route"}
//   ```
//
// WHO OWNS THE STEP LIST: the model, not the parser. The parser below only makes a SUGGESTION from the
// plan's markdown — and for half of the plans it cannot: the median plan is 46.9k characters, and the
// living Demoprojekt plan (618 KB, 78 `##` with emoji and dates, 272 `###`) has no step structure at all.
// The approval message therefore carries the suggestion as a ```plan-schritte block plus the protocol, and
// the model's first ```plan-status either confirms it or replaces it. Parser IDs are a proposal only.
//
// WHY the protocol rides in the approval message and not only in the system prompt: with the CLI's prompt
// snapshot on (its own default), a changed --append-system-prompt reaches a RESUMED session only after its
// next compaction (measured 2026-10-03, CLI 2.1.288: cache_read on the resume = the full prefix of the
// first launch). The panel passes `--system-prompt-snapshot off` by default since #86 (PR-S) — but only when
// the CLI's --help lists the flag, and the setting can be „an". The approval is the one place every
// implementing turn is guaranteed to read, under either setting. The two-sentence PLAN_PROGRESS_SYSTEM_HINT
// covers the other half: new sessions, every session right after a compaction — exactly when the approval
// message has been compacted away — and, with the snapshot „aus", every resumed session on its next start.
//
// The blocks are MODEL-AUTHORED, therefore untrusted: aliases are coerced, every field is type-checked and
// capped, unknown step IDs are counted and ignored (never invented), and a block that is not JSON stays in
// the text as a readable code block instead of vanishing.
//
// Data model — tab.plan (live; the persisted form is planSave(), which never carries `text`):
//   { v:1, id:'toolu_…' (the ExitPlanMode tool_use id) | 'status:…' (a plan the model started by reporting it,
//       planFromStatus), title, file (planFilePath | ''),
//     state: 'proposed' | 'active' | 'done' | 'dismissed' | 'superseded',
//     dismissedFrom (only when dismissed: the state underneath — what the transcript sees, planStateSeen),
//     gate: '' (an approval card may still decide it) | 'none' (no gate will ever come — the CLI refused the
//       ExitPlanMode, or the process that held the gate is gone: an ORPHANED proposal, planOrphan; sticky),
//     src: 'parser' | 'model' (who wrote the current step list), stale (set by a compaction),
//     steps: [{ id:'S1', title, group, status:'pending'|'in_progress'|'completed'|'skipped', note }],
//     current: 'S3' | '', activeForm, note (plan-level, e.g. with „fertig"),
//     seenAt, acceptedAt, updatedAt, reportedAt (ms; reportedAt 0 = the model never reported),
//     history: [{ id, title, state (+ 'replaced'), done, total, acceptedAt }] (earlier accepted plans, newest first, ≤ 5),
//     tookOverAt (ms — set only on a plan that took the place of another one underway, planPromote; the line of the
//       tasks it shows, planTaskMap. LIVE ONLY, not persisted: the task list it is held against is live only as well),
//     text (the full plan markdown — LIVE ONLY, never persisted, never part of the fold) }

var PLAN_CAPS = {
  steps: 30, title: 90, activeForm: 120, note: 200, history: 5, parse: 200000,
  blocks: 20,  // status blocks applied per text — a bound, not an expectation (one per message is normal)
  cands: 3,    // unresolved ExitPlanMode candidates the fold keeps (each holds parsed steps, never text)
  ref: 200,    // a raw step reference — an ID, or a title the model quoted instead of the ID
  file: 1000,  // planFilePath
  seen: 10000, // transcript lines the fold remembers for its duplicate check
  // the plan text a resumed tail carries per ExitPlanMode (lib/sessions.js tailTool) — the same 8000 characters
  // the generic tool card had, so an EARLIER plan of the session can still be read as it was proposed
  preview: 8000,
};
var PLAN_STATES = ['proposed', 'active', 'done', 'dismissed', 'superseded'];
// A history entry may also say „replaced": the plan was still underway when a newer one was approved over it.
// Kept as 'active' it read „in Arbeit · 1/3" in „Frühere Pläne", right next to the plan that really is.
var PLAN_HISTORY_STATES = PLAN_STATES.concat(['replaced']);
var PLAN_STEP_STATUSES = ['pending', 'in_progress', 'completed', 'skipped'];
var PLAN_SRCS = ['parser', 'model'];
var PLAN_STATUS_TAG = 'plan-status';
var PLAN_STEPS_TAG = 'plan-schritte';
// The words the model sees for a step's status ([Stand abfragen] sends them back) — German like the protocol.
var PLAN_STATUS_WORDS = { pending: 'offen', in_progress: 'läuft', completed: 'erledigt', skipped: 'übersprungen' };

// The contract with the model. Language-fixed on purpose (like OPEN_POINTS_PROTOCOL in lib/pure.js): it is
// parsed back by this file, so an i18n switch must never change a single key in it.
var PLAN_PROGRESS_PROTOCOL = [
  'Plan-Fortschritt: Beginne die Umsetzung mit einem Codeblock der Sprache `plan-status`, der die Schrittliste festlegt:',
  '{"titel":"…","schritte":[{"id":"S1","titel":"…"}],"aktuell":"S1"} ("titel" vorn = Name des Plans, optional)',
  '— übernimm die vorgeschlagene Liste aus dem `plan-schritte`-Block',
  'oder ersetze sie (höchstens 30 Schritte, IDs S1, S2, …; ist der Block leer, stelle die Liste selbst auf).',
  'Melde danach jeden Schrittwechsel als eigenen `plan-status`-Block {"aktuell":"S3","erledigt":["S1","S2"],"aktiv":"…"}',
  'direkt vor dem ersten Werkzeugaufruf des Schritts; "aktiv" sagt in einem kurzen Satz, was gerade passiert.',
  'Bei Bedarf "uebersprungen":["S4"] für ausgelassene und "offen":["S2"] für wieder geöffnete Schritte.',
  'Am Ende {"erledigt":[…],"fertig":true}.',
  'Das Panel blendet die Blöcke aus und zeigt den Stand in der Seitenleiste — erwähne sie nicht im Fließtext.',
  'Kennst du die IDs nicht mehr (z. B. nach einer Kompaktierung), sende "schritte" neu.',
  // 07.10., measured twice in one day: the FIRST block after an approval reached the transcript only as a summarised
  // thinking block, never as text — the rail knew no step for the whole turn. A second copy of the list costs a line.
  'Schicke "schritte" auch im zweiten Block noch einmal mit — der erste kommt nicht immer an.',
].join(' ');
// The protocol's opening words — what a user message that carries the panel's attachment is recognised by
// (planPanelTail). Only the opening, never the whole text: the protocol has changed once already (#85 → PF-1b gained
// "titel"), and a start or a question sent under an older wording must stay readable in its transcript. Every
// version so far opens with these words and is ONE line (joined by blanks) — the two facts planPanelTail relies on.
var PLAN_PROTOCOL_HEAD = 'Plan-Fortschritt: Beginne die Umsetzung';
// Two sentences for composeAppendSystem. They reach new sessions and every session right after a
// compaction (the snapshot is re-recorded then) — the moment the approval message is most likely gone —
// and, with the Prompt-Snapshot at its default „aus" (#86, flag listed by the CLI), every resumed session on
// its next start. A process that is already running keeps the text it was launched with until it is relaunched.
// „auch ohne Freigabe" on purpose: the one plan this channel failed on (05.10.) was started by a typed „plan
// starten" after an ExitPlanMode the CLI refused outside plan mode — no approval, so no protocol, so no report.
// A first report with "schritte" now sets the plan up by itself (planFromStatus); "titel" names it.
var PLAN_PROGRESS_SYSTEM_HINT = [
  'Setzt du einen Plan mit mehreren Schritten um, auch ohne Freigabe gestartet, meldest du den Fortschritt in Codeblöcken',
  'der Sprache `plan-status`, die das Panel als Schrittliste in der Seitenleiste zeigt: zu Beginn',
  '{"titel":"…","schritte":[{"id":"S1","titel":"…"}],"aktuell":"S1"}, bei jedem Schrittwechsel',
  '{"aktuell":"S3","erledigt":["S1","S2"],"aktiv":"…"} direkt vor dem ersten Werkzeugaufruf des Schritts, am Ende {"fertig":true}.',
  'Kennst du die Schritt-IDs nicht mehr (z. B. nach einer Kompaktierung), sende "schritte" neu, und erwähne die Blöcke',
  'nicht im Fließtext.',
].join(' ');

// ---------------- small coercions ------------------------------------------------------------------------
// Only strings and numbers are text. An object where a sentence belongs is a model getting the shape wrong;
// String({…}) would put „[object Object]" into the rail.
function planStr(v, max) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  var s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
function planNowOf(now) { return (typeof now === 'number' && isFinite(now) && now >= 0) ? now : Date.now(); }
function planTime(v) { return (typeof v === 'number' && isFinite(v) && v >= 0 && v < 1e14) ? v : 0; }
function planTsOf(iso) { var n = typeof iso === 'string' ? Date.parse(iso) : NaN; return isFinite(n) && n > 0 ? n : 0; }
// tool_use ids are `toolu_…`; anything else (and anything long) is not an id we wrote
function planIdOf(v) { return (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(v)) ? v : ''; }
function planFileStr(v) { return (typeof v === 'string' && v.length <= PLAN_CAPS.file && !/[\u0000-\u001f]/.test(v)) ? v : ''; }
function planHas(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
// The first alias that is present. `undefined` = not given at all, which is NOT the same as an explicit
// null/"" (that clears `aktuell`).
function planPick(o, keys) {
  for (var i = 0; i < keys.length; i++) if (planHas(o, keys[i]) && o[keys[i]] !== undefined) return o[keys[i]];
  return undefined;
}
// The file name the existing GET /api/plan?name= serves — only for a .md that lies in a `plans` folder,
// because that route resolves names against PLANS_DIR and nothing else.
function planFileName(file) {
  var f = planFileStr(file);
  if (!f) return '';
  var parts = f.split(/[\\/]/);
  var base = parts[parts.length - 1] || '';
  var dir = (parts[parts.length - 2] || '').toLowerCase();
  return (dir === 'plans' && /^[^\\/]+\.md$/i.test(base) && base.indexOf('..') < 0) ? base : '';
}

// ---------------- titles ---------------------------------------------------------------------------------
// Markdown out, text in. Backticks go entirely: a title travels inside a fenced block (planStepsBlock), and a
// ``` in it would close the fence early. Single underscores stay — ABAP names (Z_EXAMPLE) are full of them.
// Cut BEFORE the regex chain, not only after it: `<[^>]*>`, the link patterns and the trailing-`#` rule are
// quadratic on a run of `<` / `[a](` / blanks (measured: 100k `<` in one step title = 67 s, and the server is
// single-threaded — one such block in a transcript stalled every tab on the next /api/transcript). The input is
// model-authored, so that is not a theoretical case. 1000 characters keep a long markdown link whole, and on
// that length the worst case is a fraction of a millisecond.
var PLAN_CLEAN_IN = 1000;
function planCleanTitle(s, max) {
  if (typeof s !== 'string' && typeof s !== 'number') return '';
  var cap = max || PLAN_CAPS.title;
  var t = String(s).slice(0, Math.max(PLAN_CLEAN_IN, 4 * cap))
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\*\*/g, '')
    .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\s+#+\s*$/, '')
    .replace(/\s+/g, ' ').trim()
    .replace(/\s*:$/, '');
  return planStr(t, cap);
}
// A step title without its own enumerator: the rail already says S3, so „S3 · 3. Modul" says it twice.
// Named prefixes (F1.1 ·, PR-1 ·, A ·) are kept — they are part of what the author called the step.
var PLAN_ENUM_RE = /^(?:(?:schritt|step)\s*\d{1,2}|s\d{1,2}(?=\s*[·:—–-])|\d{1,2}(?:\.\d{1,2})*)(?:[.):]|\s*[·:—–-])?\s+/i;
function planStepTitle(s) {
  var t = planCleanTitle(s);
  var u = t.replace(PLAN_ENUM_RE, '').trim();
  return u || t;
}
// Comparing a title the model quoted against ours: case and punctuation do not make it another step.
function planTitleKey(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }

// The plan's name: the first `# ` heading (outside code), without a „Plan:" prefix — else the first line.
function planTitleOf(md) {
  var lines = String(typeof md === 'string' ? md : '').slice(0, PLAN_CAPS.parse).split(/\r?\n/);
  var fence = null, first = '';
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i], f = planFenceOf(l);
    if (fence) { if (f && planFenceCloses(fence, l)) fence = null; continue; }
    if (f) { fence = f; continue; }
    var m = /^ {0,3}#[ \t]+(.+)$/.exec(l);
    if (m) {
      // „Plan: X" / „Plan — X", but not the hyphen of a compound: „Plan-Fortschritt" stays whole
      var h = planCleanTitle(m[1].replace(/^(?:plan|implementierungsplan|umsetzungsplan|implementation plan)(?:\s*:\s*|\s+[—–-]\s+)/i, ''));
      if (h) return h;
    }
    if (!first && l.trim() && !/^ {0,3}#{2,6}[ \t]/.test(l)) first = l.slice(0, PLAN_CLEAN_IN); // a title, not a 200k line
  }
  return planCleanTitle(String(first).replace(/^\s*#+\s*/, ''));
}

// ---------------- the parser: a SUGGESTION, three ways and no more -------------------------------------
// A work section is a `##` whose text STARTS with one of these words (emoji, „2." or „A ·" before it are
// skipped). Whole words only: „UMSETZUNGSPLAN nach dem Termin" in the living plan is a status report, not
// a work section, and its 9 `###` would otherwise become a suggestion that has nothing to do with the work.
// 07.10.: measured over the 82 distinct plans in all transcripts — 23 got no step at all, among them „## Aktionen
// (nach Freigabe)", „## Etappen" and „## Was der Helfer … tut". The vocabulary below is that measurement, widened by
// the obvious synonyms; the new fallback ways further down catch what no word list can.
// NOT „Reihenfolge": in the two plans that have one it restates the order of steps already found above, and as a
// work section its list was appended to them a second time (measured old vs. new over all 82 plans).
var PLAN_WORK_RE = /^(?:umsetzung|umsetzungsschritte|implementierung|implementation|arbeitspakete?|arbeitsschritte|schritte|steps|ablauf|vorgehen|vorgehensweise|phasen?|phases?|pakete?|teil|part|wellen?|stages?|work ?packages?|aktionen|ma(?:ß|ss)nahmen|aufgaben|tasks|to-?dos?|etappen|meilensteine|milestones|fahrplan|roadmap|durchf(?:ü|ue)hrung|n(?:ä|ae)chste schritte|next steps|approach|plan of action)(?![\p{L}\p{N}])/iu;
// Headings that are about the plan, not steps of it — as `###` they are skipped, as `##` their `###` are.
var PLAN_BLOCKED_RE = /^(?:kontext|context|hintergrund|background|ziele?|zielbild|goals?|befunde?|befundlage|findings|verifikation|verification|kritische dateien|critical files|betroffene dateien|risiken|risks|fallstricke|wiederverwendung|reuse|nicht im umfang|out of scope|rahmenbedingungen|constraints|entscheidungen|decisions|datenkontrakt|offene fragen|open questions|annahmen|assumptions)(?![\p{L}\p{N}])/iu;
function planHeadKey(text) {
  return planCleanTitle(text, 200).replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/^(?:\d{1,2}(?:\.\d{1,2})*\s*[.):·—–-]?|[A-Z][.)]|[A-Z]\s+·)\s+/, '').replace(/^[^\p{L}\p{N}]+/u, '');
}
// CommonMark fences: a line of ≥3 backticks/tildes opens, the same character at least as long closes. A
// backtick „fence" whose info string holds a backtick is an inline code span (```` ```x ```` in prose).
function planFenceOf(l) {
  var m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l);
  if (!m) return null;
  if (m[1][0] === '`' && m[2].indexOf('`') >= 0) return null;
  return m[1];
}
function planFenceCloses(fence, l) {
  var m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l);
  return !!(m && m[1][0] === fence[0] && m[1].length >= fence.length);
}
// Headings and top-level numbered items outside code, from the first PLAN_CAPS.parse characters.
function planScanLines(md) {
  var src = String(typeof md === 'string' ? md : '');
  if (src.length > PLAN_CAPS.parse) src = src.slice(0, PLAN_CAPS.parse);
  var lines = src.split(/\r?\n/), out = [], fence = null;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i], f = planFenceOf(l), m;
    if (fence) { if (f && planFenceCloses(fence, l)) fence = null; continue; }
    if (f) { fence = f; continue; }
    // `(.*)` and trimEnd(), not `(.*?)[ \t]*$`: the lazy group re-tried the blank run at every position of a
    // heading full of blanks and tabs — quadratic (20k characters: 800 ms)
    if ((m = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(l))) { var ht = m[2].trimEnd(); if (ht.trim()) out.push({ kind: 'h', level: m[1].length, text: ht }); continue; }
    if ((m = /^(\d{1,2})[.)][ \t]+(\S.*)$/.exec(l))) { out.push({ kind: 'ol', text: m[2] }); continue; }
    if ((m = /^(?:\*\*|__)([^*_\n]{2,140}?)(?:\*\*|__)/.exec(l)) && !/:\s*$/.test(m[1])) out.push({ kind: 'bl', text: m[1].replace(/[.\s]+$/, '') });
  }
  return out;
}
// The CURRENT order of a living plan (rule 0). A plan that is worked on for weeks grows at the top: the newest
// order goes in as the FIRST `##` („🔬 KOMPLETTER QA-LAUF (…) — AKTUELLER AUFTRAG"), the older ones slide down,
// and the original plan ends up at the bottom (measured 05.10. on the 618 KB Demoprojekt plan: 78 `##`, 272 `###`).
// Inside that order, Context / Entscheidungen / Vorbedingungen / ERWEITERUNG sit as `###` next to the real
// steps — so only `###` that NAME themselves a step count: „Schritt 0 — …", „Phase 2: …", „PR-1 · …".
// The prefix boundary keeps „Concurrent" from reading as „current".
var PLAN_CURRENT_RE = /(?:^|[^\p{L}])(?:aktuell|current)/iu;
var PLAN_STEP_HEAD_RE = /^(?:schritt|phase|step|teil|paket|pr-?|commit|block|etappe|aktion|aufgabe|task|stufe|welle|meilenstein|milestone|punkt|iteration)\s*\d/i;
// Way 2b (h2-named): a plan whose STEPS are the `##` themselves — „## S — Seitenleiste", „## P1 — …" … „## P5 — …",
// no `###` under them (measured 07.10.: such a plan got `plan-schritte []`, and the model's first report never came
// through as text, so the rail said „Schritte folgen" until 📋 Schritte anfordern). A `##` counts when it names itself:
// a step word with a number OR a letter („Teil A", „Stufe 2", „Welle 1"), a short upper-case ID before a dash
// („S — …", „P1 — …"; „PR-2 · …" is the step word), or a number („## 1. …"). Rule 0's PLAN_STEP_HEAD_RE stays as it
// is: there „### Phase A" next to the real steps is pinned as NOT a step (test/plan-progress.test.js).
// „Commit n" counts too, with a NUMBER only (like „PR-n"): the plan of PR #115 was „## Commit 1 — …" … „## Commit 4 — …",
// got `plan-schritte []`, and the model's first report again never arrived as text — so the rail knew no step and
// said „Claude meldet Schritte, die das Panel nicht kennt" for the whole turn (07.10.). A letter is not allowed here:
// the `i` flag would let „## Commits" (a section that LISTS them) through as „commit" + „s".
var PLAN_H2_STEP_RE = /^(?:(?:schritt|phase|step|teil|paket|stufe|welle|stage|wave|part|block|etappe|aktion|aufgabe|task|meilenstein|milestone|iteration)\s*(?:\d|[A-Z](?![\p{L}\p{N}]))|pr-?\s*\d|commit\s*\d|punkt\s*\d)/iu;
// One capital with or without a number („S — …", „P1 — …"), or two/three capitals only WITH one („AB12 — …"): a bare
// acronym is a topic, not a step — „## API: Route", „## UI — Liste" would otherwise turn a design note into a checklist.
var PLAN_H2_ID_RE = /^(?:[A-Z]\d{0,2}|[A-Z]{2,3}\d{1,2})\s*[—–:·-]\s+(?=\S)/; // case-sensitive on purpose: „S — …", not „so - …"
var PLAN_H2_NUM_RE = /^\d{1,2}(?:\.\d{1,2})?\s*[.):·—–-]\s*(?=\S)/;
function planH2Named(t, key) {
  if (PLAN_H2_STEP_RE.test(t)) return true;
  // „## 2. Umsetzung" is the section that HOLDS the steps, not one of them — and „## A — Kontext" is still Kontext
  if (PLAN_WORK_RE.test(key) || PLAN_BLOCKED_RE.test(t.replace(PLAN_H2_ID_RE, ''))) return false;
  return PLAN_H2_ID_RE.test(t) || PLAN_H2_NUM_RE.test(t);
}
// → { steps:[{id,title,group}], how: 'h3-current' | 'h3-work' | 'list-work' | 'h2-named' | 'h3-doc' | '' }
//   0. `###` that name themselves a step, inside the FIRST `##` or a `##` that says „aktuell"/„current";
//   1. `###` inside work sections;  2. top-level numbered list inside work sections;
//   2b. `##` that name themselves a step (planH2Named), titles kept whole like rule 0's;
//   3. `###` anywhere, minus the blocked ones — each only when it yields 2…30 steps. Otherwise nothing:
//   a wrong suggestion costs the model a correction, a missing one costs nothing (it is asked for the list).
// Rule 0 comes FIRST, ahead of the 200k cap mattering at all: the current order stands at the top, and with the
// whole file read, way 1 would find the original plan's `## Arbeitspakete` at the bottom instead. It yields to way
// 1 for a section that is itself a work section („## Umsetzung — aktuell"): way 1 reads that section whole,
// enumerators stripped, and stays the fallback only if way 1 finds nothing usable. A blocked `##` (Kontext,
// Verifikation …) is never the current order. Rule-0 titles keep their „Schritt 0 —": the author's numbers are
// not the rail's (0-based, „Schritt 1–5" ranges), so they are part of the name here, not a repetition of S1.
function planStepsParse(md) {
  var items = planScanLines(md), sec = null, h3w = [], olw = [], h2s = [], h3all = [], h2n = 0, cur = null;
  // the fallback ways of 07.10. (after every older way, so nothing that was recognised before reads differently):
  var blw = [], h3cur = [], bln = [], h2any = [], olFirst = null;
  var okLen = function (l) { return l.length >= 2 && l.length <= PLAN_CAPS.steps; };
  var closeSec = function () {
    if (!cur && sec && sec.cur && okLen(sec.steps)) cur = { steps: sec.steps, work: sec.work };
    if (!h3cur.length && sec && sec.cur && okLen(sec.h3)) h3cur = sec.h3;
    if (!olFirst && sec && !sec.blocked && okLen(sec.ol)) olFirst = sec.ol;
  };
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.kind === 'h') {
      if (it.level <= 2) {
        closeSec();
        if (it.level === 1) { sec = null; continue; }
        var key = planHeadKey(it.text), blocked = PLAN_BLOCKED_RE.test(key);
        h2n++;
        var h2t = planCleanTitle(it.text).replace(/^[^\p{L}\p{N}]+/u, '');
        if (!blocked && planH2Named(h2t, key)) h2s.push({ title: h2t, group: '' });
        if (!blocked && h2t) h2any.push({ title: planStepTitle(it.text), group: '' });
        sec = { title: planCleanTitle(it.text), work: PLAN_WORK_RE.test(key), blocked: blocked,
          cur: !blocked && (h2n === 1 || PLAN_CURRENT_RE.test(key)), steps: [], h3: [], ol: [] };
        continue;
      }
      if (it.level !== 3) continue;
      if (sec && sec.cur) {
        var named = planCleanTitle(it.text).replace(/^[^\p{L}\p{N}]+/u, '');
        if (PLAN_STEP_HEAD_RE.test(named)) sec.steps.push({ title: named, group: '' });
      }
      var title = planStepTitle(it.text);
      if (!title || PLAN_BLOCKED_RE.test(planHeadKey(it.text))) continue;
      if (sec && sec.cur) sec.h3.push({ title: planStepTitle(it.text).replace(/^[^\p{L}\p{N}]+/u, ''), group: '' });
      var e = { title: title, group: sec ? sec.title : '' };
      if (sec && sec.work) h3w.push(e);
      if (!(sec && sec.blocked)) h3all.push(e);
    } else if (it.kind === 'ol' && sec) {
      var t2 = planStepTitle(it.text);
      if (!t2) continue;
      if (sec.work) olw.push({ title: t2, group: sec.title });
      sec.ol.push({ title: t2, group: '' });
    } else if (it.kind === 'bl' && !(sec && sec.blocked)) {
      var bt = planCleanTitle(it.text).replace(/^[^\p{L}\p{N}]+/u, '');
      if (!bt) continue;
      if (sec && sec.work) blw.push({ title: bt, group: sec.title });
      if (planH2Named(bt, planHeadKey(bt))) bln.push({ title: bt, group: sec ? sec.title : '' });
    }
  }
  closeSec();
  var ways = [['h3-work', h3w], ['list-work', olw], ['bold-work', blw], ['h2-named', h2s], ['h3-doc', h3all],
    ['h3-current-any', h3cur], ['bold-named', bln], ['list-any', olFirst || []], ['h2-any', h2any]];
  if (cur) ways.splice(cur.work ? 1 : 0, 0, ['h3-current', cur.steps]);
  for (var w = 0; w < ways.length; w++) {
    var list = ways[w][1];
    if (list.length < 2 || list.length > PLAN_CAPS.steps) continue;
    // one group for all is no grouping — the rail would print the same heading above every row. A map without a
    // prototype: the keys are headings, and a heading „__proto__" would set the prototype instead of being counted
    var groups = Object.create(null);
    list.forEach(function (s) { groups[s.group] = true; });
    var grouped = Object.keys(groups).length > 1;
    return { steps: list.map(function (s, k) { return { id: 'S' + (k + 1), title: s.title, group: grouped ? s.group : '' }; }), how: ways[w][0] };
  }
  return { steps: [], how: '' };
}
function planStepsFromMarkdown(md) { return planStepsParse(md).steps; }

// ---------------- step references -----------------------------------------------------------------------
// What the model may write for „step 3": 3, "3", "S3", "s3", "S03", "Schritt 3", "Step 3", "#3", "S3 · Route".
// An ID of its own shape ("F1", "A2") is kept as it is (upper-cased). With `p`, the reference must exist in
// that plan — and an exact title (case and punctuation aside) resolves to its step. Never anything fuzzier:
// a near-miss that ticks off the wrong step is worse than one report that is ignored.
function planStepRef(v, p) {
  var raw = typeof v === 'number' ? ((isFinite(v) && v % 1 === 0) ? String(v) : '') : (typeof v === 'string' ? v.trim() : '');
  if (!raw || raw.length > PLAN_CAPS.ref) return '';
  var syn = '', m;
  if ((m = /^(?:(?:schritt|step)\s*#?\s*|#\s*)?s?0*([1-9]\d{0,2})[.):]?$/i.exec(raw))) syn = 'S' + Number(m[1]);
  else if ((m = /^s0*([1-9]\d{0,2})\s*[·:—–-]\s*\S/i.exec(raw))) syn = 'S' + Number(m[1]);
  // own-shape IDs — but not „S0"/„S1000": an S-number is ours, and those two are outside its range
  else if (/^[A-Za-z][A-Za-z0-9._-]{0,11}$/.test(raw) && !/^s\d+$/i.test(raw)) syn = raw.toUpperCase();
  if (!p || !Array.isArray(p.steps)) return syn;
  if (syn && planStepIndex(p, syn) >= 0) return syn;
  var k = planTitleKey(planCleanTitle(raw, PLAN_CAPS.ref));
  if (!k) return '';
  for (var i = 0; i < p.steps.length; i++) if (p.steps[i] && planTitleKey(p.steps[i].title) === k) return p.steps[i].id;
  return '';
}
function planStepIndex(p, id) {
  if (!p || !Array.isArray(p.steps) || !id) return -1;
  for (var i = 0; i < p.steps.length; i++) if (p.steps[i] && p.steps[i].id === id) return i;
  return -1;
}
function planStepById(p, id) { var i = planStepIndex(p, id); return i >= 0 ? p.steps[i] : null; }
function planCurrentStep(p) { return p ? planStepById(p, p.current) : null; }
function planFreeId(taken, n) { while (taken['S' + n]) n++; return 'S' + n; }

// A step list as the model (or the plan-schritte block) wrote it → [{id,title,group}], ≤ 30. Entries may be
// objects or bare titles. Explicit IDs are reserved FIRST, so an entry without one never takes the ID that a
// later entry names — otherwise „S1" in the model's next report would tick off the wrong step.
function planStepsNormalize(v) { return planStepsRead(v).steps; }
// The keys under which a list entry states its own state — read here, and the mark of a STATUS block (the list
// [Stand abfragen] sends, planStepsBlockOf): a start never carries them.
var PLAN_ROW_STATUS_KEYS = ['status', 'stand', 'zustand', 'state'];
// …and the same pass with what an entry says about its own STATE ({"id":"S1","status":"erledigt"}). That is
// the shape [Stand abfragen] shows the model (planStepsBlock with {status:true}), so it is the shape a model
// asked „where are we" most likely echoes back — its ticks must not be lost because the protocol asks for
// them in `erledigt` instead. → { steps, said: [{ id, status }] } (status one of PLAN_STEP_STATUSES)
function planStepsRead(v) {
  if (!Array.isArray(v)) return { steps: [], said: [] };
  var pre = [], taken = Object.create(null);
  for (var i = 0; i < v.length && pre.length < PLAN_CAPS.steps; i++) {
    var e = v[i], id = '', title = '', group = '', said = '';
    if (typeof e === 'string' || typeof e === 'number') title = planCleanTitle(e);
    else if (e && typeof e === 'object' && !Array.isArray(e)) {
      id = planStepRef(planPick(e, ['id', 'nr', 'key']));
      title = planCleanTitle(planPick(e, ['titel', 'title', 'name', 'text', 'schritt', 'step']));
      group = planCleanTitle(planPick(e, ['gruppe', 'group']));
      said = planStatusWordOf(planPick(e, PLAN_ROW_STATUS_KEYS));
    } else continue;
    if (!title && !id) continue;
    if (id && taken[id]) id = '';  // a duplicate ID is no ID — it gets a free one below
    if (id) taken[id] = true;
    pre.push({ id: id, title: title, group: group, said: said });
  }
  var out = { steps: [], said: [] };
  pre.forEach(function (s, k) {
    var id = s.id;
    if (!id) { id = planFreeId(taken, k + 1); taken[id] = true; }
    out.steps.push({ id: id, title: s.title || id, group: s.group });
    if (s.said) out.said.push({ id: id, status: s.said });
  });
  return out;
}
// A status word as the model may write it → one of PLAN_STEP_STATUSES, or '' for anything else. The German
// words are the ones planStepsBlock sends (PLAN_STATUS_WORDS), the rest are what a model writes instead.
var PLAN_STATUS_WORD_ALIASES = {
  completed: ['erledigt', 'fertig', 'abgeschlossen', 'done', 'completed', 'complete', 'finished'],
  skipped: ['übersprungen', 'uebersprungen', 'ausgelassen', 'skipped', 'skip'],
  in_progress: ['läuft', 'laeuft', 'aktuell', 'aktiv', 'in arbeit', 'in_progress', 'in progress', 'running', 'current', 'active'],
  pending: ['offen', 'pending', 'open', 'todo'],
};
function planStatusWordOf(v) {
  if (typeof v !== 'string') return '';
  var w = v.trim().toLowerCase();
  for (var st in PLAN_STATUS_WORD_ALIASES) if (PLAN_STATUS_WORD_ALIASES[st].indexOf(w) >= 0) return st;
  return '';
}
function planStepNew(s) { return { id: s.id, title: s.title, group: s.group || '', status: 'pending', note: '' }; }

// ---------------- state transitions ---------------------------------------------------------------------
// A candidate: the ExitPlanMode input as the model offered it. Parsed once, here.
function planNew(toolId, md, file, now) {
  var id = planIdOf(toolId);
  if (!id) return null;
  var text = typeof md === 'string' ? md : '';
  var f = planFileStr(file);
  var at = planNowOf(now);
  return {
    v: 1, id: id, title: planTitleOf(text) || planCleanTitle(planFileName(f).replace(/\.md$/i, '')),
    file: f, state: 'proposed', gate: '', src: 'parser', stale: false,
    steps: planStepsParse(text).steps.map(planStepNew),
    current: '', activeForm: '', note: '',
    seenAt: at, acceptedAt: 0, updatedAt: at, reportedAt: 0, history: [], text: text,
  };
}
// Accepted. `steps` (optional) = the list the approval message actually carried — what the model was SHOWN,
// which is what its IDs refer to; without it the candidate's own parse stays.
function planAccept(p, steps, now) {
  if (!p) return p;
  if (Array.isArray(steps)) { p.steps = planStepsNormalize(steps).map(planStepNew); p.src = 'parser'; }
  p.state = 'active';
  p.acceptedAt = planNowOf(now);
  p.updatedAt = p.acceptedAt;
  p.current = ''; p.activeForm = ''; p.stale = false;
  return p;
}
// No gate will ever decide this proposal: the CLI refused the ExitPlanMode („You are not in plan mode" — the
// model called it in a session running in Auto/default mode, measured 05.10.: no can_use_tool at all), or the
// process that held the gate is gone (a turn that ended undecided, a reload, a resume, a fork). It stays a
// PROPOSAL — the plan is still the one on the table, and „▶ Plan starten" can start it by an ordinary message
// (planStartMessage) — instead of „wartet auf Freigabe" forever (live) or a silent supersede (the old fold).
// Sticky: an orphan accepted by message and taken back (planUnaccept) is an orphan again, not a waiting gate.
function planOrphan(p, toolId) {
  if (p && p.state === 'proposed' && (!toolId || p.id === toolId)) p.gate = 'none';
  return p;
}
function planIsOrphan(p) { return !!(p && p.state === 'proposed' && p.gate === 'none'); }
// The ExitPlanMode tool_result of a call the CLI refused outside plan mode. Anchored, like PLAN_APPROVED_RE: a
// „Weiter planen" whose feedback says „you are not in plan mode" is feedback, not the CLI's error. The CLI wraps
// it in <tool_use_error> (measured: 1 of 77 ExitPlanMode results in the local corpus, the 05.10. session).
var PLAN_NO_PLAN_MODE_RE = /^\s*(?:<tool_use_error>\s*)?(?:Error:\s*)?(?:You are |You're )?not (?:currently )?in plan mode/i;
function planIsNoPlanModeError(text) { return PLAN_NO_PLAN_MODE_RE.test(String(text == null ? '' : text)); }
// Every result that says „no decision, and none will come": the refusal above, or the permission request the
// turn's end aborted while the card still waited (an interrupt, the process exit — measured 1 of 77,
// „Tool permission request failed: AbortError"). The live tab orphans the same proposal when it retires the card.
var PLAN_GATE_ABORTED_RE = /^\s*(?:<tool_use_error>\s*)?(?:Error:\s*)?Tool permission request failed:\s*AbortError/i;
function planGateLost(text) {
  var s = String(text == null ? '' : text);
  return PLAN_NO_PLAN_MODE_RE.test(s) || PLAN_GATE_ABORTED_RE.test(s);
}
// „Weiter planen": this proposal is off the table until the next ExitPlanMode. A proposal the user had put away (×)
// is off the table underneath its dismissal too — the fold sees exactly that (planStateSeen).
function planSupersede(p, toolId) {
  if (!p || (toolId && p.id !== toolId)) return p;
  if (p.state === 'proposed') p.state = 'superseded';
  else if (p.state === 'dismissed' && planStateSeen(p) === 'proposed') p.dismissedFrom = 'superseded';
  return p;
}
// The approval never reached the CLI (POST failed, dead chat) — the plan must not claim to be underway. Not
// once the model has reported against it: then the approval evidently did arrive.
function planUnaccept(p, toolId) {
  // a take-over that never reached the CLI did not happen either (planPromote's tookOverAt)
  if (p && p.state === 'active' && (!toolId || p.id === toolId) && !p.reportedAt) { p.state = 'proposed'; p.acceptedAt = 0; if (p.tookOverAt) p.tookOverAt = 0; }
  return p;
}
// × in the rail. A dismissal lives only in this tab — the transcript never hears of it, so the resume fold goes on
// seeing the plan in the state it was put away in, and a report later moves it there (planApplyStatus). That state is
// kept (`dismissedFrom`), and every decision about WHICH plan a report or a proposal belongs to reads it instead of
// 'dismissed' (planStateSeen): decided by the dismissal, live and fold disagreed, and a resume brought the dismissed
// plan back on top with a foreign list.
function planDismiss(p) { if (p) { if (p.state !== 'dismissed') p.dismissedFrom = p.state; p.state = 'dismissed'; } return p; }
var PLAN_SEEN_STATES = ['proposed', 'active', 'done', 'superseded'];
// The state the TRANSCRIPT sees: a dismissed plan's own state underneath (an older saved one without it: 'active' —
// the safe side, a report then stays with the plan that was put away instead of bringing something back).
function planStateSeen(p) {
  if (!p) return '';
  if (p.state !== 'dismissed') return p.state;
  return PLAN_SEEN_STATES.indexOf(p.dismissedFrom) >= 0 ? p.dismissedFrom : 'active';
}
// Shown in the rail at all? (dismissed = the user put it away, superseded = „Weiter planen")
function planVisible(p) { return !!(p && (p.state === 'proposed' || p.state === 'active' || p.state === 'done')); }
// A plan's line in its successor's history. Its state as it was left — except that one still underway (or
// accepted and taken back to a proposal) did not go on: it was replaced.
// A dismissed plan by the state the transcript sees (planStateSeen) — the fold, which knows no dismissal, writes the
// same line for it.
function planSummary(p) {
  var c = planCounts(p), seen = planStateSeen(p);
  var st = (seen === 'active' || seen === 'proposed') ? 'replaced' : seen;
  return { id: p.id, title: p.title || '', state: st, done: c.done, total: c.total, acceptedAt: planTime(p.acceptedAt) };
}
// `next` takes the place of `prev`. A plan that was ever accepted goes into the history (≤ 5, newest first);
// a proposal nobody accepted does not — it was never part of the session's work. Shared by the live path
// and the fold, so a reload and a resume agree on what „earlier plans" means.
function planChain(prev, next) {
  if (!next || !prev || prev === next || prev.id === next.id) return next;
  var h = [], seen = planStateSeen(prev);
  if (planTime(prev.acceptedAt) > 0 || seen === 'active' || seen === 'done') h.push(planSummary(prev));
  (Array.isArray(prev.history) ? prev.history : []).forEach(function (e) { if (e && e.id !== next.id) h.push(e); });
  next.history = h.slice(0, PLAN_CAPS.history);
  return next;
}
// The two decisions about WHICH plan a tab shows, shared by the live path (chat-render.js) and the fold, so
// a reload, a resume and the running tab cannot disagree on them.
// A new ExitPlanMode candidate arrives: while a plan is being worked on it stays on top (the candidate lives
// only in its card until it is accepted); otherwise the proposal takes the place. The same id again = no-op.
// A plan underway that the user put away (×) is still underway for the transcript (planStateSeen): the proposal
// waits in its card there too — on top of it, the fold would keep the dismissed plan and a resume bring it back.
function planOffer(cur, cand) {
  if (!cand) return cur || null;
  if (cur && cur.id === cand.id) return cur;
  return (cur && planStateSeen(cur) === 'active') ? cur : planChain(cur, cand);
}
// The approval for `cand` went through → the plan now underway (`steps` as for planAccept).
// A candidate that takes the place of ANOTHER plan that was underway — still running, or finished while the candidate
// waited under it (planOffer keeps a running plan on top, so `cand` waited there as a card or an orphan) — gets
// `tookOverAt`: until this moment the model was working on that other plan, and a task it wrote then, also one written
// after the candidate came up („erst A fertig machen"), is that plan's, never the candidate's (planTaskMap). A
// candidate that was itself on top (`cur` is `cand`: nothing was underway when it came up) keeps `seenAt` as the line —
// what the model writes for the proposal on the table names that proposal's steps.
function planPromote(cur, cand, steps, now) {
  if (!cand) return cur || null;
  var seen = planStateSeen(cur);
  var over = !!(cur && cur.id !== cand.id && (seen === 'active' || seen === 'done'));
  var p = planAccept((cur && cur.id === cand.id) ? cur : planChain(cur, cand), steps, now);
  if (over) p.tookOverAt = p.acceptedAt;
  return p;
}

// ---------------- the blocks ----------------------------------------------------------------------------
// The step list for the model. `opts.status` adds each step's state — [Stand abfragen] sends that back, so
// a model that lost track after a compaction sees what the panel believes.
function planStepsBlock(p, opts) {
  var withStatus = !!(opts && opts.status);
  var steps = (p && Array.isArray(p.steps)) ? p.steps.slice(0, PLAN_CAPS.steps) : [];
  var rows = steps.map(function (s) {
    var o = { id: s.id, titel: String(s.title || s.id).replace(/`/g, "'") };
    if (s.group) o.gruppe = String(s.group).replace(/`/g, "'");
    if (withStatus) o.status = PLAN_STATUS_WORDS[s.status] || PLAN_STATUS_WORDS.pending;
    return JSON.stringify(o);
  });
  return '```' + PLAN_STEPS_TAG + '\n' + (rows.length ? '[\n' + rows.join(',\n') + '\n]' : '[]') + '\n```';
}
// The approval: the caller's translated „Plan genehmigt …", the suggested list (or []), the protocol. The
// block doubles as the marker the resume fold recognises — independent of the UI language of the sentence.
function planAcceptMessage(head, plan) {
  var h = typeof head === 'string' ? head.trim() : '';
  return (h ? h + '\n\n' : '') + planStepsBlock(plan) + '\n\n' + PLAN_PROGRESS_PROTOCOL;
}
// „▶ Plan starten" (and the composer chip): the SAME approval, as an ordinary user message — for a proposal no
// gate will ever decide (planOrphan). Same shape on purpose: the model learns the same list and the same rules,
// and the fold recognises it the same way, only in a user TEXT instead of a tool_result (planFoldLine). Its own
// name because it has its own contract: its block never carries a step's status — that is what tells a start
// apart from [Stand abfragen] in a transcript (planPanelTail), independent of the UI language of the head — and the
// block stands right before the protocol, which is what tells it apart from a block merely quoted in a message.
function planStartMessage(head, plan) { return planAcceptMessage(head, plan); }
// [Stand abfragen] and „📋 Schritte anfordern" — one text for both: the question, the list AS THE PANEL SEES IT
// (each step with its state) when there is one, and the protocol. Without steps there is no block at all: an
// empty list says nothing the question does not, and `[]` is what a START carries — the fold must never read
// a question as a start. The protocol always: after a compaction the model may have lost the rules too.
function planStepsRequestMessage(head, plan) {
  var h = typeof head === 'string' ? head.trim() : '';
  var has = !!(plan && Array.isArray(plan.steps) && plan.steps.length);
  return (h ? h + '\n\n' : '') + (has ? planStepsBlock(plan, { status: true }) + '\n\n' : '') + PLAN_PROGRESS_PROTOCOL;
}
// „Weiter planen" for an ORPHANED proposal: no gate can carry the feedback, so the card puts it into the composer
// headed by the panel's own keep sentence (i18n chat-render.bitteDenPlanNoch, the same one the gate's deny sends).
// Both languages, anchored at the start like PLAN_APPROVED_RE: that sentence is how the live tab and the fold
// both know the message put the proposal away — a reply that merely QUOTES it later in the text is a reply.
var PLAN_KEEP_RE = /^\s*(?:Bitte den Plan noch nicht ausführen|Please don't run the plan yet)/;
// „▶ Plan starten" with the switch OFF (chat-render.js planCardPaint, 'plain'): the head ALONE (i18n
// chat-side.planStartKopf, both languages), exactly — no list, no protocol. The model works on the plan from here on
// and was told nothing about reporting it, so no plan stands in the rail: the rule of an approval without the block
// through a gate (planUntracked live, planFoldResolve in the fold). Read as nothing at all it left the proposal on
// the table, and a reload with the switch on again offered ▶ for a plan that had long been running.
// Anchored at both ends: a reply that merely contains the sentence is a reply.
var PLAN_UNTRACKED_RE = /^\s*(?:Plan freigegeben — bitte jetzt umsetzen\.|Plan approved — please implement it now\.)\s*$/;
// The head [Stand abfragen] sent — on main (#85) WITH the list even when it was empty: ```plan-schritte\n[]\n``` and no
// step stating a status, which is exactly what a start looks like. Its own two opening sentences (i18n
// chat-side.planStandFrage, both languages) tell it apart, so such a question in a transcript of that time never
// starts the plan on a resume. Two sentences, not one: a typed „Wo stehen wir im Plan?" stays a message of its own.
var PLAN_ASK_RE = /^\s*(?:Wo stehen wir im Plan\? Bitte melde den aktuellen Stand|Where are we in the plan\? Please report the current state)/;
// What an outgoing user text does to a proposal on the table — ONE rule for the live tab (chat-side.js
// planNoteOutgoing, when the message goes out) and the fold (when the transcript says it went out):
//   'start'     — it ENDS with the panel's attachment: a ```plan-schritte block whose entries state no status, right
//                 before the protocol (▶ Plan starten, the chip — planPanelTail). A block merely quoted in a message,
//                 or pasted along as a text attachment, starts nothing: it used to start whatever proposal was on
//                 the table, with the quoted (foreign) list as its steps;
//   'keep'      — it opens with the keep sentence („Weiter planen" of an orphan card, sent from the composer);
//   'untracked' — the start head alone (the switch off), see PLAN_UNTRACKED_RE;
//   ''          — anything else, a question ([Stand abfragen], 📋 Schritte anfordern) included.
function planOutgoingKind(text) {
  var s = String(text == null ? '' : text);
  if (PLAN_KEEP_RE.test(s)) return 'keep';
  if (PLAN_UNTRACKED_RE.test(s)) return 'untracked';
  if (s.indexOf(PLAN_PROTOCOL_HEAD) < 0) return ''; // the common message: one linear scan, nothing else
  var t = planPanelTail(s);
  return (t && t.block && !t.block.status && !PLAN_ASK_RE.test(s)) ? 'start' : '';
}
// The panel's attachment at the END of a user text, or null: the protocol as the LAST paragraph — at the start of a
// line, one line long, nothing after it — and right before it, optionally, a ```plan-schritte block (the LAST one of
// the text). That is the shape planStartMessage / planStepsRequestMessage build and the chip appends, and it is what
// sets the panel's attachment apart from the same words quoted in prose or in a pasted text attachment (lib/chat.js
// sendToChat wraps that one in a fence of its own, so its protocol never ends the part).
// Linear on any input: lastIndexOf, trimEnd, one regex anchored on the block's own slice. The /\s+$/ replace that
// stood here was quadratic on a run of blanks that does NOT end the text (40 000 blanks: 6,9 s) — and it ran on
// every user row painted, live and in a resumed transcript.
// → { head, block: { steps, status } | null } — `head` is what precedes the attachment, trimmed.
function planPanelTail(text) {
  var s = String(text == null ? '' : text).trimEnd();
  var p = s.lastIndexOf(PLAN_PROTOCOL_HEAD);
  if (p < 0 || (p > 0 && s.charAt(p - 1) !== '\n') || s.indexOf('\n', p) >= 0) return null;
  var body = s.slice(0, p).trimEnd(), head = body, block = null;
  var at = body.slice(-3) === '```' ? body.lastIndexOf('```' + PLAN_STEPS_TAG) : -1;
  if (at >= 0) {
    var m = /^```plan-schritte[ \t]*\r?\n([\s\S]*?)```$/.exec(body.slice(at));
    if (m) { block = planStepsBlockRead(m[1]); if (block) head = body.slice(0, at); }
  }
  return { head: head.trim(), block: block };
}
// The proposal an outgoing start (or keep) is about: the plan on top when it is a proposal, else the newest orphan
// that waits UNDER a plan underway (its card's ▶). Shared by the fold (f.plan / f.orphan) and the live tab
// (tab.plan / tab._planOrphan), so both pick the same one. → the proposal, or null when nothing is on the table.
function planStartPick(cur, orphan) {
  if (cur && cur.state === 'proposed') return cur;
  return (orphan && orphan.state === 'proposed') ? orphan : null;
}
// The user row of a message that carries the panel's own attachment — a start (▶, the chip) or a question
// ([Stand abfragen], 📋 Schritte anfordern): what the reader typed (or the panel's head) and the attachment, so the
// transcript can show the attachment folded as „📋 Plan-Fortschritt" instead of a wall of JSON and protocol. By the
// same anchor planOutgoingKind reads (planPanelTail), so the row says „Start" exactly where the rail starts the plan —
// and a question of #85, under the older wording of the protocol, folds as well.
// → { head, steps, status, kind: 'start' | 'ask' } or null (an ordinary message, painted as it is).
function planMessageSplit(text) {
  var s = String(text == null ? '' : text);
  if (s.indexOf(PLAN_PROTOCOL_HEAD) < 0) return null;
  var t = planPanelTail(s);
  if (!t) return null;
  var b = t.block, start = !!(b && !b.status && !PLAN_ASK_RE.test(s));
  return { head: t.head, steps: b ? b.steps : [], status: !!(b && b.status), kind: start ? 'start' : 'ask' };
}
// The steps a START carries (planOutgoingKind 'start'): its panel block → { steps, status }, or null.
function planStartBlockOf(text) { var t = planPanelTail(text); return t ? t.block : null; }
// The body of a ```plan-schritte block → { steps, status } — `status` true when any entry states its own state (a
// question's list: planStepsRequestMessage), false for an approval or a start — or null when it is no JSON list.
function planStepsBlockRead(body) {
  var v;
  try { v = JSON.parse(body); } catch { return null; }
  if (!Array.isArray(v)) return null;
  var status = v.some(function (e) { return !!e && typeof e === 'object' && !Array.isArray(e) && planPick(e, PLAN_ROW_STATUS_KEYS) !== undefined; });
  return { steps: planStepsNormalize(v), status: status };
}
// The first ```plan-schritte block of a text → planStepsBlockRead, or null when there is no readable block. For a
// gate's tool_result (the approval: planFoldResolve), where the block is the panel's by construction.
function planStepsBlockOf(text) {
  var m = /```plan-schritte[ \t]*\r?\n([\s\S]*?)```/.exec(String(text == null ? '' : text));
  return m ? planStepsBlockRead(m[1]) : null;
}
// The list as an approval carried it → array (possibly []), or null when there is no readable block.
function planStepsBlockParse(text) { var b = planStepsBlockOf(text); return b ? b.steps : null; }

var PLAN_ALIASES = {
  // the plan's NAME (the block's top level — a step's own "titel" lives inside `schritte`). Not `plan`: that key
  // is as likely to hold the whole plan text, or an object
  titel: ['titel', 'title', 'planTitel', 'planTitle', 'name'],
  schritte: ['schritte', 'steps', 'liste'],
  aktuell: ['aktuell', 'current', 'currentStep', 'aktuellerSchritt', 'jetzt', 'now'],
  erledigt: ['erledigt', 'done', 'completed', 'abgeschlossen'],
  uebersprungen: ['uebersprungen', 'übersprungen', 'skipped', 'skip'],
  offen: ['offen', 'reopen', 'reopened', 'open'],
  // not `active`: {"active":"S3"} reads as „the active step" just as well, and would put an ID into the sentence
  aktiv: ['aktiv', 'activeForm', 'taetigkeit', 'tätigkeit', 'doing'],
  notiz: ['notiz', 'note', 'hinweis'],
  fertig: ['fertig', 'finished', 'complete', 'planDone', 'allDone'],
};
function planRefRaw(v) { return (typeof v === 'string' || (typeof v === 'number' && isFinite(v))) ? planStr(v, PLAN_CAPS.ref) : ''; }
function planRefList(v) {
  // no prototype: a reference can be a step's TITLE, and „constructor" or „toString" were „seen" before the first
  var arr = Array.isArray(v) ? v : [v], out = [], seen = Object.create(null);
  for (var i = 0; i < arr.length && out.length < PLAN_CAPS.steps; i++) {
    var r = planRefRaw(arr[i]);
    if (r && !seen[r]) { seen[r] = true; out.push(r); }
  }
  return out;
}
// One block → a normalised update, or null when nothing in it is usable. A bare array is a step list (a
// model that writes only the list is cooperating, not wrong). `"done": true` is read as „fertig" — the
// English alias of `erledigt` holding a boolean can only mean the whole plan.
function planStatusNormalize(o) {
  if (Array.isArray(o)) o = { schritte: o };
  if (!o || typeof o !== 'object') return null;
  var u = {}, any = false, v, said = [];
  // cleaned like a heading (no markdown, no backticks, ≤ PLAN_CAPS.title): it is shown as the rail's title
  v = planPick(o, PLAN_ALIASES.titel);
  if (typeof v === 'string' || typeof v === 'number') { var ti = planCleanTitle(v); if (ti) { u.titel = ti; any = true; } }
  v = planPick(o, PLAN_ALIASES.schritte);
  if (v !== undefined) { var st = planStepsRead(v); if (st.steps.length) { u.schritte = st.steps; said = st.said; any = true; } }
  v = planPick(o, PLAN_ALIASES.aktuell);
  if (v === null || v === '' || v === false) { u.aktuell = ''; any = true; }
  else if (v !== undefined) { var r = planRefRaw(v); if (r) { u.aktuell = r; any = true; } }
  ['erledigt', 'uebersprungen', 'offen'].forEach(function (k) {
    var x = planPick(o, PLAN_ALIASES[k]);
    if (x === undefined) return;
    if (k === 'erledigt' && x === true) { u.fertig = true; any = true; return; }
    var l = planRefList(x);
    if (l.length) { u[k] = l; any = true; }
  });
  // A state given per entry of the list (the echo of [Stand abfragen]) means what the protocol's lists mean:
  // „erledigt" joins `erledigt`, „übersprungen" `uebersprungen`, and the first „läuft" is `aktuell` — unless the
  // block names one itself. „offen" re-opens NOTHING: it is the panel's own belief coming back, and a step the
  // panel has ticked off goes back only through an explicit `offen` list (erledigt only ever moves forward).
  said.forEach(function (s) {
    var k = s.status === 'completed' ? 'erledigt' : s.status === 'skipped' ? 'uebersprungen' : '';
    if (k) { var l = u[k] || (u[k] = []); if (l.indexOf(s.id) < 0 && l.length < PLAN_CAPS.steps) l.push(s.id); any = true; }
    else if (s.status === 'in_progress' && !planHas(u, 'aktuell')) { u.aktuell = s.id; any = true; }
  });
  v = planPick(o, PLAN_ALIASES.aktiv);
  if (typeof v === 'string' || typeof v === 'number') { u.aktiv = planStr(v, PLAN_CAPS.activeForm); any = true; }
  v = planPick(o, PLAN_ALIASES.notiz);
  if (typeof v === 'string' || typeof v === 'number') { u.notiz = planStr(v, PLAN_CAPS.note); any = true; }
  if (planPick(o, PLAN_ALIASES.fertig) === true) { u.fertig = true; any = true; }
  return any ? u : null;
}
// The language tag must END at a newline or go straight into the JSON — so ```plan-schritte (and any other
// tag that merely starts the same) is never read as a status block.
var PLAN_STATUS_RE_SRC = '```plan-status[ \\t]*(?:\\r?\\n|(?=[{\\[]))([\\s\\S]*?)```';
// A LAST block whose closing fence never came — the model forgot it, and while the message streamed nothing
// showed it (renderMarkdown hides an open block). It ends at the first blank line, or with the text: a status
// block is a line of JSON, and what follows a blank line is prose again. Only when that ``` really OPENS
// something (an even number of fences before it) and no fence follows at all. → { start, from, to } | null
function planStatusOpenTail(s) {
  var tag = '```' + PLAN_STATUS_TAG, i = s.lastIndexOf(tag);
  if (i < 0) return null;
  var j = i + tag.length, m = /^[ \t]*(?:\r?\n|(?=[{\[]))/.exec(s.slice(j, j + 64));
  if (!m || s.indexOf('```', j) >= 0) return null;
  var n = 0;
  for (var k = s.indexOf('```'); k >= 0 && k < i; k = s.indexOf('```', k + 3)) n++;
  if (n % 2) return null; // this ``` closes an earlier block — it opens nothing
  var from = j + m[0].length, blank = s.slice(from).search(/\r?\n[ \t]*\r?\n/);
  return { start: i, from: from, to: blank < 0 ? s.length : from + blank };
}
// Every valid block in the text, in order — several in one message are several reports, applied in turn.
function planStatusExtract(text) {
  var re = new RegExp(PLAN_STATUS_RE_SRC, 'g'), out = [], m, s = String(text == null ? '' : text);
  while ((m = re.exec(s)) !== null && out.length < PLAN_CAPS.blocks) {
    try { var u = planStatusNormalize(JSON.parse(m[1])); if (u) out.push(u); } catch { /* not JSON → skip, never throw into the render path */ }
  }
  var t = out.length < PLAN_CAPS.blocks ? planStatusOpenTail(s) : null;
  if (t) { try { var ut = planStatusNormalize(JSON.parse(s.slice(t.from, t.to))); if (ut) out.push(ut); } catch { /* prose after all — it stays */ } }
  return out;
}
// Strip the blocks from the text. The rail is where the state belongs; the raw JSON in the transcript as well
// would be the same thing twice, once unreadably. A block that is not JSON at all stays (as in openPointsStrip):
// stripping it would make it vanish without a trace, left in place it renders as a code block and can be read.
// The unclosed last block by the same rule: its JSON goes, the text after its blank line stays.
function planStatusStrip(text) {
  var s = String(text == null ? '' : text).replace(new RegExp(PLAN_STATUS_RE_SRC + '\\s*', 'g'), function (all, body) {
    try { JSON.parse(body); return ''; } catch { return all; }
  });
  var t = planStatusOpenTail(s);
  if (t) { try { JSON.parse(s.slice(t.from, t.to)); s = s.slice(0, t.start) + s.slice(t.to).replace(/^\s+/, ''); } catch { /* stays */ } }
  return s;
}

// ---------------- applying a report ---------------------------------------------------------------------
// The rules (plan part 1):
//   · `schritte` replaces the list; a step keeps its status (and note) when its ID survives → src 'model'.
//   · `offen` re-opens. `erledigt` only ever moves forward — a partial list must not undo earlier reports,
//     so the only way back is `offen`. `uebersprungen` never demotes a completed step.
//   · `aktuell` marks the step in_progress and returns the previous current one, if still unfinished, to
//     pending. Jumping back is allowed; it does not re-open a completed step (that is `offen` again).
//   · Unknown IDs are ignored and COUNTED (returned) — never invented. `aktiv`/`notiz` that belong to an
//     unknown `aktuell` are dropped with it instead of being pinned on the wrong step.
//   · `fertig` → state 'done'. Steps nobody reported stay open („ohne Abschluss-Meldung") — never ticked off
//     silently. A later report that names a current step (or re-opens one) makes the plan active again.
//   · A report that hits something known clears `stale` (the model evidently still knows the IDs); one made
//     only of unknown IDs does not. A proposal the model reports against was evidently approved → active.
// → { changed, structural (planSig changed → rebuild; else only activeForm/note → patch), unknown }
// A DISMISSED plan takes the report as the plan it was put away as (planStateSeen) and stays put away: the fold knows
// no dismissal and moves that plan exactly so — a report that finishes it makes it done there, one that names a step
// makes a proposal active — and the next decision about it (planFromStatus, planOffer) must see the same state.
function planApplyStatus(p, u, now) {
  if (!p || p.state !== 'dismissed') return planApplyStatusRaw(p, u, now);
  p.state = planStateSeen(p);
  try { return planApplyStatusRaw(p, u, now); } finally { p.dismissedFrom = p.state; p.state = 'dismissed'; }
}
function planApplyStatusRaw(p, u, now) {
  var res = { changed: false, structural: false, unknown: 0 };
  if (!p || !u || typeof u !== 'object' || !Array.isArray(p.steps)) return res;
  if (p.state === 'superseded') return res;
  var at = planNowOf(now);
  var sig0 = planSig(p), af0 = p.activeForm, note0 = planNotesSig(p);
  var hit = 0, reopened = false, closedCurrent = false;
  var resolve = function (ref) { var id = planStepRef(ref, p); if (!id) res.unknown++; return id; };
  // normalised again on purpose: idempotent for what planStatusNormalize produced, and a caller handing
  // in a raw block cannot smuggle an uncapped or duplicate-ID list past it
  var list = Array.isArray(u.schritte) ? planStepsNormalize(u.schritte) : [];
  if (list.length) {
    var old = Object.create(null);
    p.steps.forEach(function (s) { old[s.id] = s; });
    p.steps = list.map(function (s) {
      var o = old[s.id];
      return { id: s.id, title: s.title, group: s.group || '', status: o ? o.status : 'pending', note: o ? o.note : '' };
    });
    p.src = 'model';
    if (p.current && planStepIndex(p, p.current) < 0) p.current = '';
    hit++;
  }
  (u.offen || []).forEach(function (r) {
    var s = planStepById(p, resolve(r));
    if (!s) return;
    s.status = s.id === p.current ? 'in_progress' : 'pending';
    hit++; reopened = true;
  });
  (u.erledigt || []).forEach(function (r) {
    var s = planStepById(p, resolve(r));
    if (!s) return;
    if (s.id === p.current && s.status !== 'completed') closedCurrent = true;
    s.status = 'completed'; hit++;
  });
  (u.uebersprungen || []).forEach(function (r) {
    var s = planStepById(p, resolve(r));
    if (!s) return;
    if (s.status !== 'completed') { if (s.id === p.current && s.status !== 'skipped') closedCurrent = true; s.status = 'skipped'; }
    hit++;
  });
  var curGiven = planHas(u, 'aktuell'), curOk = false, movedTo = '';
  if (curGiven) {
    var nid = u.aktuell === '' ? '' : resolve(u.aktuell);
    if (u.aktuell === '' || nid) {
      curOk = true; hit++;
      if (p.current && p.current !== nid) {
        var ps = planStepById(p, p.current);
        if (ps && ps.status === 'in_progress') ps.status = 'pending';
      }
      if (nid) {
        var ns = planStepById(p, nid);
        if (ns.status === 'pending') ns.status = 'in_progress';
        if (ns.status === 'in_progress') movedTo = nid; // onto a finished step (jumping back) re-opens nothing
      }
      if (nid !== p.current) { p.current = nid; if (u.aktiv === undefined) p.activeForm = ''; }
    }
  }
  // The step that was running and that THIS report closed is no longer running. Only this report's doing: a
  // current step that was already finished (a jump back onto it) stays current until the model moves on.
  if (!curOk && closedCurrent) { p.current = ''; if (u.aktiv === undefined) p.activeForm = ''; }
  var orphan = curGiven && !curOk; // aktiv/notiz describe a step we do not know
  if (u.aktiv !== undefined && !orphan) p.activeForm = planStr(u.aktiv, PLAN_CAPS.activeForm);
  if (u.fertig === true) {
    p.steps.forEach(function (s) { if (s.status === 'in_progress') s.status = 'pending'; });
    p.current = ''; p.activeForm = '';
    if (p.state !== 'dismissed') p.state = 'done';
    hit++;
  } else if (hit && p.state === 'proposed') {
    p.state = 'active';
    if (!planTime(p.acceptedAt)) p.acceptedAt = at;
  } else if (p.state === 'done' && (movedTo || reopened)) {
    p.state = 'active';
  }
  if (u.notiz !== undefined && !orphan) {
    var n = planStr(u.notiz, PLAN_CAPS.note), cur = planCurrentStep(p);
    if (cur && u.fertig !== true) cur.note = n; else p.note = n;
  }
  if (hit) p.stale = false;
  if (hit || (!orphan && (u.aktiv !== undefined || u.notiz !== undefined))) p.reportedAt = at;
  // "titel" names a plan that has no name — it never renames one: the first report after an approval may well
  // carry the model's own paraphrase, and the rail must go on saying what the card said
  var titled = typeof u.titel === 'string' && !!u.titel && !p.title;
  if (titled) p.title = planCleanTitle(u.titel);
  res.structural = planSig(p) !== sig0 || titled; // the title is in the rail's guard (planRailSig), not in planSig
  res.changed = res.structural || p.activeForm !== af0 || planNotesSig(p) !== note0;
  if (res.changed) p.updatedAt = at;
  return res;
}
function planNotesSig(p) { return (p.note || '') + '\u0001' + p.steps.map(function (s) { return s.note || ''; }).join('\u0001'); }

// A plan the MODEL started by reporting it — no ExitPlanMode it could belong to, or none that is still on the
// table. The 05.10. session is the case: the CLI refused the ExitPlanMode outside plan mode, the user typed „plan
// starten", the model worked through „Schritt 0 …" — and the rail had nothing to hang a report on. With the
// system hint (PLAN_PROGRESS_SYSTEM_HINT) a model reports such a plan's list on its own; this is what makes that
// list a plan. ONE function for the live tab (chat-side.js takePlanStatus) and the fold, so both create the same
// plan with the same id from the same report.
//   · Only a report WITH "schritte" can start a plan: a bare {"aktuell":"S3"} has nothing to show.
//   · `cur` proposed (an orphan, too) or active → the report is about it (planApplyStatus; a proposal reported
//     against becomes active, as before). An active plan is never split, not even by another "titel" — the first
//     report after an approval may name the approved plan in its own words.
//   · `cur` superseded („Weiter planen", a rejection) → a new plan: the model is evidently working anyway.
//   · `cur` done → the same plan, unless the report is ANOTHER one: a "titel" that is not its title AND a list that
//     is mostly not its list (fewer than half of the titles shared). Both conditions, because the hint's first
//     example leads with "titel": a model that re-sends its list after a compaction will likely name the plan in its
//     own words. Without a "titel" the report stays with that plan (a correction after „fertig" is still about it).
//   · `cur` dismissed → decided by the state it was put away in (planStateSeen), never by the dismissal: the fold
//     knows none, so a dismissed plan underway took a report as a NEW plan live and as its own in the fold — and a
//     resume brought the dismissed plan back with the new list under its old name. The report moves it
//     as it would without the ×, and it stays put away (planApplyStatus).
// `meta` = { title, file } of the newest ExitPlanMode candidate seen (the fold's f.last): the name when the
// report brings none — the model implements the plan last proposed — and the file [Plan öffnen] can read. The file
// only for THAT plan: a report whose "titel" names another one is not the proposal's text, and [Plan öffnen] showed
// the file of a plan „Weiter planen" had put away under the new plan's name.
// The id is derived from the REPORT ('status:' + a hash of its "titel" and step list), not from a time or a
// message uuid: the live tab and the fold see the same text, but not the same clock — and an id that differs
// between them loses the dismissal and the jump targets on every resume (planAdopt matches by id).
// → { plan, created, changed, structural, unknown } (the last three as planApplyStatus says them)
function planFromStatus(cur, u, meta, now) {
  var out = { plan: cur || null, created: false, changed: false, structural: false, unknown: 0 };
  if (!u || typeof u !== 'object') return out;
  var list = Array.isArray(u.schritte) ? planStepsNormalize(u.schritte) : [];
  var titel = typeof u.titel === 'string' ? planCleanTitle(u.titel) : '';
  var seen = planStateSeen(cur);
  var fresh = list.length > 0 && (!cur || seen === 'superseded'
    || (seen === 'done' && !!titel && planTitleKey(titel) !== planTitleKey(cur.title)
      && planShared(cur, list) * 2 < list.length));
  if (fresh) {
    var at = planNowOf(now), m = (meta && typeof meta === 'object') ? meta : {};
    var mt = planCleanTitle(m.title);
    var p = {
      v: 1, id: 'status:' + planHash(titel + '\u0002' + list.map(function (s) { return s.id + '\u0001' + s.title; }).join('\u0002')),
      title: titel || mt || '', file: (!titel || planTitleKey(titel) === planTitleKey(mt)) ? planFileStr(m.file) : '',
      state: 'active', gate: 'none', src: 'model', stale: false, steps: [],
      current: '', activeForm: '', note: '', seenAt: at, acceptedAt: at, updatedAt: at, reportedAt: 0, history: [],
    };
    out.plan = planChain(cur, p);
    out.created = true;
  }
  if (!out.plan) return out;
  var r = planApplyStatus(out.plan, u, now);
  out.changed = r.changed || out.created; out.structural = r.structural || out.created; out.unknown = r.unknown;
  return out;
}
// How many of `list`'s step titles the plan has as well (case and punctuation aside, like planStepRef).
function planShared(p, list) {
  var have = Object.create(null), n = 0;
  (p && Array.isArray(p.steps) ? p.steps : []).forEach(function (s) { if (s) have[planTitleKey(s.title)] = true; });
  list.forEach(function (s) { if (have[planTitleKey(s.title)]) n++; });
  return n;
}
// FNV-1a, 32 bit, base 36 — deterministic in the browser and in Node; a name, not a security property.
function planHash(s) {
  var h = 0x811c9dc5, str = String(s);
  for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

// ---------------- numbers, signature, persistence --------------------------------------------------------
// A plan step's mark in the checklist the rail shows (✓ done · ⏳ running · ☐ open · ⤼ skipped) — the look asked
// for on 05.10. („✓ erledigt, ⏳ aktueller Schritt, ☐ offen"). Its own set for the plan group only: chat-render.js
// todoMark (√ ■ □ ⤼) stays as it is for #chatTodos. Anything unknown is open; own-property lookup, so a status
// „constructor" is no mark.
var PLAN_STEP_MARKS = { completed: '✓', in_progress: '⏳', pending: '☐', skipped: '⤼' };
function planStepMark(status) { return (typeof status === 'string' && planHas(PLAN_STEP_MARKS, status)) ? PLAN_STEP_MARKS[status] : PLAN_STEP_MARKS.pending; }

// ---------------- the model's own tasks at the step they name (PF-2) ----------------------------------------------
// Julian, 05.10.: „Aufgaben mit S<n> am Schritt, übrige in der Leiste." The model's own tasks (tab.taskList — TaskCreate /
// TaskUpdate / TodoWrite, public/js/task-list.js) whose text OPENS with a step ID of the plan underway stand at that step
// in the rail; every other task stays in #chatTodos above the composer. ONE function decides that for both readers
// (chat-side.js the plan group, chat-render.js renderTodoStrip the strip): two rules would sooner or later disagree about
// a task, and it would then show in both places or in neither.
// The prefix and nothing else — „S2 ·", „S2:", „[S2]", „S2 -", „S2 —" (also –, any case, S02 = S2), the forms Julian
// named. A bare blank is no separator („S3 Tests" may be a name), text must follow it, and only an S-number of THIS
// plan's steps places a task: never a guess at another ID shape or at a step title — a task put under the wrong step is
// worse than one left in the strip (planStepRef's rule). Anchored at the start; read on the first PLAN_CAPS.ref
// characters only, so a text of any length costs the same.
// The hyphen-minus is a separator only with a blank on one side of it: without one it JOINS a word — „S4-HANA
// Migration", „S3-Bucket anlegen" name a product and a bucket, not step 4 and step 3. The en and em dash join no word,
// so „S2—Route" stays a prefix (English sets the em dash without blanks).
var PLAN_TASK_PREFIX_RE = /^\s*(?:\[\s*s0*([1-9]\d{0,2})\s*\]\s*([·:—–-])?|s0*([1-9]\d{0,2})(?:\s*([·:—–])|\s+(-)|(-)(?=\s)))\s*(?=\S)/i;
// What follows a DASH and makes it a range: another step number, standing alone — „S1–S3 …", „S2 - S3: …", „S2 – 3 …"
// (not „S2 – 2FA einrichten": a number inside a word is text).
var PLAN_TASK_RANGE_RE = /^\[?\s*s?0*\d{1,3}\b/i;
// → { step: 'S2', text: what follows the prefix } | null
// A prefix names ONE step. A range („S1–S3 zusammenfassen") or a second prefix right behind the first („[S2][S3] beides",
// „S2 · S3: beides") names several, and putting the task under the first of them is a guess — so neither is a prefix,
// and the task stays in the strip, whole. A step number as TEXT after „·"/„:" is fine („S2 · S3-Bucket anlegen").
function planTaskPrefix(text) {
  if (typeof text !== 'string') return null;
  var m = PLAN_TASK_PREFIX_RE.exec(text.slice(0, PLAN_CAPS.ref));
  if (!m) return null;
  var rest = text.slice(m[0].length);
  var dash = /[—–-]/.test(m[2] || m[4] || m[5] || m[6] || '');
  if ((dash && PLAN_TASK_RANGE_RE.test(rest)) || PLAN_TASK_PREFIX_RE.test(rest.slice(0, PLAN_CAPS.ref))) return null;
  return { step: 'S' + Number(m[1] || m[3]), text: rest };
}
// The text a task shows at its step: without the prefix — the step above it already says S2.
function planTaskLabel(text) { var pre = planTaskPrefix(text); return pre ? pre.text : (typeof text === 'string' ? text : ''); }
// → { byStep: { S2: [row, …] }, unmapped: [row, …] } — the SAME row objects, each in exactly one of the two places, in
// the order of `rows`. Only a plan UNDERWAY places anything (state 'active'): a proposal (an orphan too) is not work yet,
// a finished plan is over, one put away (×) or set aside („Weiter planen") is not in the rail — then `unmapped` is the
// list itself, and the strip shows what it showed before PF-2. The caller hands in the plan its rail SHOWS (chat-side.js
// planRailPlan: null with the switch off), so „underway" here means „underway on screen".
// What is no row (null, a string, no text) goes to `unmapped` untouched: the strip's reader (taskListView) drops it as
// it always did — this function decides where a task stands, nothing more.
// Only a task made SINCE THIS PLAN CAME UP is about it. The task list lives as long as the process (it is emptied only
// by startChat), a plan does not: „S2 · Route verdrahten" of a finished plan A would otherwise stand, ticked, under step
// S2 of the next plan B — a step nobody has touched. A row's `created` (task-list.js: a TaskCreate's own moment; a
// TodoWrite row the moment its text first appeared in the list) is held against the plan's `seenAt`, the moment the
// proposal arrived or the report made it: a task the model writes for a proposal before it is approved still counts
// (its steps are the ones the task names), one from before the proposal does not — it stays in the strip, whole, as
// before PF-2. A plan that took the place of another one underway (`tookOverAt`, planPromote) draws its line where it
// took over: while it waited under that plan — as a card, or as an orphan ▶ started later — the model was still
// working on the other one. A TodoWrite row the model writes anew after the line is believed; one it merely carries
// over from its previous list keeps its old moment, so the ticked rows of A do not move under B with B's first list.
// READ ONLY, on purpose: a task never ticks its step off. The step's state is what the model reports in its plan-status
// blocks — the contract the resume fold replays from the transcript (lib/sessions.js), while the task list starts empty
// on every (re)start (chat-events.js startChat). A tick that came from a task would be gone after the next reload, and
// three tasks under a step say nothing about whether the step has more work than the model wrote down.
function planTaskMap(p, rows) {
  var out = { byStep: {}, unmapped: [] };
  var list = Array.isArray(rows) ? rows : [];
  var live = !!(p && p.state === 'active' && Array.isArray(p.steps));
  // 0 (an old saved plan): no boundary; a plan that took another one's place: not before it did (planPromote)
  var since = live ? Math.max(planTime(p.seenAt) || planTime(p.acceptedAt), planTime(p.tookOverAt)) : 0;
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    var pre = (live && r && typeof r === 'object') ? planTaskPrefix(r.text) : null;
    var older = !!(pre && since && typeof r.created === 'number' && r.created < since);
    // keys are 'S' + a number, never a name of Object.prototype — a plain object is safe here
    var id = (pre && !older && planStepIndex(p, pre.step) >= 0) ? pre.step : '';
    if (id) (out.byStep[id] || (out.byStep[id] = [])).push(r);
    else out.unmapped.push(r);
  }
  return out;
}
// The rail's repaint guard for the tasks the steps show (chat-side.js planRailSig): what a task row SHOWS — text, state,
// working form, the description in its tooltip — keyed by step. The tasks left in the strip are not in it: the strip
// repaints itself, and rebuilding the rail (≈100 grant chips) for a task the rail does not show would be waste.
function planTaskSig(m) {
  if (!m || !m.byStep || typeof m.byStep !== 'object') return '';
  return Object.keys(m.byStep).map(function (k) {
    return k + '=' + m.byStep[k].map(function (r) { return [r.src, r.id, r.toolId, r.status, r.text, r.activeForm, r.detail].join(':'); }).join('\u0001');
  }).join('\u0002');
}
// A task's mark at its step: the checklist's own (✓ ⏳ ☐) for the three words TaskUpdate writes, „?" for any other — a
// word nobody has measured must not read as „not started yet" (task-list.js taskListView calls it `unknown`).
function planTaskMark(state) { return (state === 'completed' || state === 'in_progress' || state === 'pending') ? PLAN_STEP_MARKS[state] : '?'; }
// → { total, done, skipped, open, running, current, index } — index is 1-based (0 = no current step).
function planCounts(p) {
  var c = { total: 0, done: 0, skipped: 0, open: 0, running: 0, current: '', index: 0 };
  if (!p || !Array.isArray(p.steps)) return c;
  p.steps.forEach(function (s) {
    if (!s) return;
    c.total++;
    if (s.status === 'completed') c.done++;
    else if (s.status === 'skipped') c.skipped++;
    else { c.open++; if (s.status === 'in_progress') c.running++; }
  });
  c.current = planStepIndex(p, p.current) >= 0 ? p.current : '';
  c.index = c.current ? planStepIndex(p, c.current) + 1 : 0;
  return c;
}
// The steps the model went PAST without a word: still open, but behind the step it now names as current — it
// jumped ahead ({"aktuell":"S4"} with nothing in `erledigt`), or back over steps it never reported. Shown as
// „nicht gemeldet" instead of as a plain □ that reads like work not yet begun (plan part 2, case 8). In a
// finished plan every open step is one. Never a guess beyond that: with no current step there is no „past".
// → { S2: true, … }
function planUnreported(p) {
  var out = Object.create(null);
  if (!p || !Array.isArray(p.steps)) return out;
  var lim = p.state === 'done' ? p.steps.length : (p.state === 'active' && p.reportedAt) ? planCounts(p).index - 1 : 0;
  for (var i = 0; i < lim && i < p.steps.length; i++) { var s = p.steps[i]; if (s && s.status === 'pending') out[s.id] = true; }
  return out;
}
// The rail's repaint guard. Structure and status only — NOT activeForm/note: those change with every report
// and are patched into the DOM in place; rebuilding the rail (≈100 chips) for a new sentence is waste.
// The gate is in it: an orphaned proposal looks different (no „wartet auf Freigabe", a start button instead).
function planSig(p) {
  if (!p || !Array.isArray(p.steps)) return '';
  return [p.id, p.state, p.gate || '', p.src, p.stale ? 1 : 0, p.current || ''].join('|') + '|'
    + p.steps.map(function (s) { return s ? s.id + ':' + s.status + ':' + (s.group || '') + ':' + s.title : ''; }).join('\u0001');
}
// a step count — an integer within the step cap, anything else is 0
function planCount(x) { return (typeof x === 'number' && x % 1 === 0 && x >= 0 && x <= PLAN_CAPS.steps) ? x : 0; }
function planHistoryRestore(v) {
  if (!Array.isArray(v)) return [];
  var out = [];
  for (var i = 0; i < v.length && out.length < PLAN_CAPS.history; i++) {
    var e = v[i];
    if (!e || typeof e !== 'object') continue;
    var id = planIdOf(e.id);
    if (!id || PLAN_HISTORY_STATES.indexOf(e.state) < 0) continue;
    out.push({ id: id, title: planStr(e.title, PLAN_CAPS.title), state: e.state, done: planCount(e.done), total: planCount(e.total), acceptedAt: planTime(e.acceptedAt) });
  }
  return out;
}
// The one canonical shape. localStorage and the server's fold are both outside this file's control, so every
// field is forced and capped again; what cannot be a plan (no id, unknown state, steps not a list) → null.
// The plan text is never part of it: it can be 600 KB, and the file / the transcript hold it already.
function planRestore(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (o.v !== undefined && o.v !== 1) return null;
  var id = planIdOf(o.id);
  if (!id || PLAN_STATES.indexOf(o.state) < 0 || !Array.isArray(o.steps)) return null;
  var steps = [], taken = Object.create(null);
  for (var i = 0; i < o.steps.length && steps.length < PLAN_CAPS.steps; i++) {
    var s = o.steps[i];
    if (!s || typeof s !== 'object') continue;
    var sid = planStepRef(s.id);
    if (!sid || taken[sid]) continue;
    taken[sid] = true;
    steps.push({
      id: sid, title: planStr(s.title, PLAN_CAPS.title).replace(/`/g, '') || sid,
      group: planStr(s.group, PLAN_CAPS.title).replace(/`/g, ''),
      status: PLAN_STEP_STATUSES.indexOf(s.status) >= 0 ? s.status : 'pending',
      note: planStr(s.note, PLAN_CAPS.note),
    });
  }
  var cur = planStepRef(o.current);
  var r = {
    v: 1, id: id, title: planStr(o.title, PLAN_CAPS.title), file: planFileStr(o.file),
    state: o.state, gate: o.gate === 'none' ? 'none' : '', src: PLAN_SRCS.indexOf(o.src) >= 0 ? o.src : 'parser', stale: o.stale === true,
    steps: steps, current: (cur && taken[cur]) ? cur : '',
    activeForm: planStr(o.activeForm, PLAN_CAPS.activeForm), note: planStr(o.note, PLAN_CAPS.note),
    seenAt: planTime(o.seenAt), acceptedAt: planTime(o.acceptedAt), updatedAt: planTime(o.updatedAt), reportedAt: planTime(o.reportedAt),
    history: planHistoryRestore(o.history),
  };
  // the state a dismissed plan was put away in (planDismiss) — only on a dismissed one, and only a state it can have
  if (r.state === 'dismissed' && PLAN_SEEN_STATES.indexOf(o.dismissedFrom) >= 0) r.dismissedFrom = o.dismissedFrom;
  return r;
}
function planSave(p) { return planRestore(p); }
// The resumed transcript is the truth (`fromTranscript` = the server's fold; null = the transcript holds no
// plan). Locally only two things survive, and only for the SAME plan: a dismissal (the user's decision lives
// nowhere else) and the live text (a resume in the same tab without a reload still has it in memory).
// `undefined` = the server said nothing at all (older server, or a fold that failed) → keep what we have.
// A proposal the transcript left UNANSWERED comes back ORPHANED (planOrphan): its gate was held by the process
// that asked, and a resume is always a new process (POST /api/chat/start spawns one; the dead-chat heal says
// „this answer is lost") — the same holds for a reload (restoreTabs) and a fork (forkTab), which come through
// here as well. As a plain „proposed" it would stand in the rail as „wartet auf Freigabe" with no card that could
// approve. It used to come back superseded and vanish; since „▶ Plan starten" can start it by an ordinary message,
// it stays on the table — the same thing the live tab does with a card whose turn ended undecided.
function planAdopt(local, fromTranscript) {
  if (fromTranscript === undefined) return local || null;
  var t = planRestore(fromTranscript);
  if (!t) return null;
  planOrphan(t);
  if (local && local.id === t.id) {
    // the transcript's state IS the state underneath the dismissal — the fold knows nothing else (planStateSeen)
    if (local.state === 'dismissed') planDismiss(t);
    if (typeof local.text === 'string' && local.text) t.text = local.text;
  }
  return t;
}
// The orphan UNDER a plan underway (the fold's f.orphan, the tab's _planOrphan — what its card's ▶ starts), by the same
// rule: the transcript is the truth, `undefined` = the server said nothing (keep the tab's), and only a proposal comes
// back, orphaned — its gate went with the process that asked. Without it a reload, a resume or a fork lost every way to
// start it, while the live tab had offered ▶ on its card.
function planAdoptOrphan(local, fromTranscript) {
  if (fromTranscript === undefined) return local || null;
  var t = planRestore(fromTranscript);
  if (!t || t.state !== 'proposed') return null;
  planOrphan(t);
  if (local && local.id === t.id && typeof local.text === 'string' && local.text) t.text = local.text;
  return t;
}
// { title, file } of the newest ExitPlanMode — the name a plan the model reports without one gets (planFromStatus's
// `meta`; the fold's f.last, the tab's _planLast). Forced like everything that comes from outside this file; planStr
// and not planCleanTitle, so the name is the one the fold used, character for character (it is clean already).
function planLastRestore(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return { title: planStr(v.title, PLAN_CAPS.title), file: planFileStr(v.file) };
}

// ---------------- the resume fold ----------------------------------------------------------------------
// One pass over the transcript's parsed lines (lib/sessions.js parseTranscript runs it over the WHOLE file,
// independent of the 220-event tail):
//   assistant tool_use ExitPlanMode → candidate (input.plan parsed once, input.planFilePath)
//   user tool_result for a candidate → accepted when it carries a ```plan-schritte block (exactly those steps
//     — what the model was shown). An approval WITHOUT one (an older panel's „Plan genehmigt" / „Plan
//     approved", the native CLI's „User has approved your plan", a panel with the switch off) leaves NO plan:
//     the model never got the protocol, so nothing will ever be reported against it, and as „in Arbeit ·
//     Noch kein Stand" it would open the rail on every resume — measured over the local corpus: 11 of the 12
//     sessions with a plan came back that way, among them plans finished 64 days ago. The plan it was approved
//     over is gone as well: the model works on the new one now. (The live tab does the same: planUntracked.)
//     Only a report the model makes on its own after all — WITH a step list, because the system hint asks for one
//     (planFromStatus) — brings a plan back; such transcripts did not exist before PF-1b, so the measurement holds.
//     A result that says no gate will ever decide it (planGateLost: the CLI's „You are not in plan mode", an
//     aborted permission request) → the proposal stays, ORPHANED — as the live tab keeps it. „The user doesn't want
//     to proceed" without an answer → decided by the next line: the interrupt marker makes it a Stop (orphaned, as
//     the live tab retires the card), anything else a rejection (planFoldRejectSettle).
//     Anything else → that proposal is off.
//   user TEXT (not a tool_result): first, every proposal still waiting for an answer is orphaned — the user only
//     speaks once the turn that held its gate is over (planFoldAbandon). Then planOutgoingKind decides, on the LAST
//     text part (the typed one): the panel's attachment at its end — a ```plan-schritte block that states no step's
//     status, right before the protocol → a start (planStartMessage: „▶ Plan starten", the composer chip) of the
//     proposal on the table — or, while another plan is underway, of the newest orphan (its card's button). Exactly
//     those steps. The start head alone (the switch off) → that proposal is started untracked: no plan. The keep
//     sentence → that proposal is put away (an orphan card's „Weiter planen", sent from the composer). A block WITH
//     states, or under [Stand abfragen]'s head, is a question and starts nothing; a block quoted anywhere else is
//     text; a start with nothing to start does nothing either. Compaction summaries and meta lines are not the user
//     speaking: never a start, never an abandon.
//   assistant text with ```plan-status → planFromStatus (applies to the plan, or starts a model-reported one).
//   system compact_boundary → stale.
// Skipped: isSidechain lines, and lines seen before. The CLI re-writes preserved messages after a compaction
// WITH THEIR UUID (measured: 7 ExitPlanMode lines appear twice in one transcript, same uuid, after a
// compact_boundary) — replaying them would put an old plan back on top of a newer one.
// EVERY alternative inside the group, so `^\s*` binds to all three: as `(?:a|b)|c` the third one was
// unanchored and matched ANYWHERE in the text — a „weiter planen" whose feedback quotes the sentence, or a
// model that writes it in prose, would have counted as an approval (CodeQL js/regex/missing-regexp-anchor on
// PR #85). All three real texts START with their sentence: the panel's two i18n heads and the native CLI's
// result, which opens with „User has approved your plan" (measured over the local corpus).
var PLAN_APPROVED_RE = /^\s*(?:Plan genehmigt|Plan approved|User has approved your plan)/;
// Was this ExitPlanMode answer an approval? One rule for the fold and for the resumed tab's history card
// (chat-side.js), so the card cannot call „weiter geplant" what the fold counted as accepted. The bare fence
// name is enough: the panel writes a plan-schritte block into approvals only — and in the resumed tail the
// result text is capped at 4000 characters, which can cut the block before its closing fence.
function planIsApproval(text) {
  var s = String(text == null ? '' : text);
  return s.indexOf('```' + PLAN_STEPS_TAG) >= 0 || PLAN_APPROVED_RE.test(s);
}
// `orphan`: the newest orphaned proposal that is NOT f.plan (one was underway when it came) — what a start from
// its card refers to. One slot, the newest: a transcript says „start", not which card. `last`: { title, file } of
// the newest candidate — planFromStatus's name for a plan the model reports without one.
// `reject`: a proposal whose result said „The user doesn't want to proceed" without an answer — decided by the NEXT
// line (planFoldRejectSettle).
function planFoldNew() { return { plan: null, cands: Object.create(null), order: [], resolved: Object.create(null), seen: Object.create(null), nSeen: 0, orphan: null, last: null, nCand: 0, reject: null }; }
function planFoldFresh(f, obj) {
  var uid = typeof obj.uuid === 'string' ? obj.uuid : '';
  if (!uid) return true;
  if (f.seen[uid]) return false;
  if (f.nSeen < PLAN_CAPS.seen) { f.seen[uid] = true; f.nSeen++; }
  return true;
}
function planToolResultText(b) {
  var c = b && b.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(function (x) { return (x && x.type === 'text' && typeof x.text === 'string') ? x.text : ''; }).join('\n');
  return '';
}
function planFoldCandidate(f, b, ts) {
  var id = planIdOf(b.id);
  if (!id || f.resolved[id] || f.cands[id] || (f.plan && f.plan.id === id)) return;
  var input = (b.input && typeof b.input === 'object') ? b.input : {};
  var md = typeof input.plan === 'string' ? input.plan : '';
  // Parsed on first NEED, not here (planFoldSteps). Measured on the largest transcript (41 806 lines, 40
  // plans of up to 600 KB): parsing every candidate up front cost ≈ 280 of the fold's ≈ 330 ms — and an
  // approval that carries a plan-schritte block, or a proposal that is superseded, never needs the parse.
  var cand = planNew(id, '', input.planFilePath, ts);
  cand.title = planTitleOf(md) || cand.title;
  delete cand.text; // the fold's RESULT never holds plan text; `_md` lives only until the parse
  cand._md = md;
  cand._n = ++f.nCand; // arrival order — which of two orphans is the newer one (planFoldAbandon)
  f.cands[id] = cand; f.order.push(id);
  while (f.order.length > PLAN_CAPS.cands) delete f.cands[f.order.shift()];
  f.last = { title: cand.title, file: cand.file };
  f.plan = planOffer(f.plan, cand);
}
function planFoldForget(f, id) {
  delete f.cands[id];
  f.order = f.order.filter(function (x) { return x !== id; });
  f.resolved[id] = true;
}
// The CLI's own text for a permission it was refused WITHOUT an answer it could carry: the user's ⏹ on a held gate
// writes it, and then the user line PLAN_INTERRUPT_RE (measured 446598fa…, lines 974 → 975). A refusal WITH feedback
// starts the same way but goes on („To tell you how to proceed, the user said: …", line 934) and is followed by the
// model — and in a panel session „Weiter planen" always carries the keep sentence, which the CLI writes verbatim (line
// 42239). So the interrupt line after it is what tells a Stop from a rejection.
var PLAN_NOT_PROCEED_RE = /^\s*(?:<tool_use_error>\s*)?The user doesn.t want to proceed/;
var PLAN_INTERRUPT_RE = /^\s*\[Request interrupted by user for tool use\]\s*$/;
// The proposal `id` stays on the table, ORPHANED — the rule of planGateLost, shared with planFoldRejectSettle.
function planFoldOrphanOf(f, id, cand) {
  if (f.plan && f.plan.id === id) planOrphan(f.plan, id);
  else if (cand) { planOrphan(cand, id); if (!f.orphan || (cand._n || 0) > (f.orphan._n || 0)) f.orphan = cand; }
}
function planFoldResolve(f, b, ts) {
  var id = b.tool_use_id, cand = f.cands[id];
  planFoldForget(f, id);
  var text = planToolResultText(b);
  var steps = planStepsBlockParse(text);
  if (steps === null) {
    if (planIsApproval(text)) f.plan = null; // approved, but without the protocol — see above
    // kept, not superseded: the live tab keeps it too (planOrphan) — a resume must not show something else
    else if (planGateLost(text)) planFoldOrphanOf(f, id, cand);
    // a Stop or a rejection — the next line says which (the live tab orphans the card a Stop retires: interruptTab →
    // retirePlanCards; the resume superseded it, so live and resume disagreed again)
    else if (PLAN_NOT_PROCEED_RE.test(text)) f.reject = { id: id, cand: cand || null };
    else if (f.plan && f.plan.id === id) planSupersede(f.plan, id);
    return;
  }
  var base = (f.plan && f.plan.id === id) ? f.plan : cand;
  delete base._md;
  f.plan = planPromote(f.plan, base, steps, ts);
}
// A user text that carries a start or a keep (planOutgoingKind; see the fold's header). → true when it moved
// something. A start takes exactly the steps of its block; a keep puts the proposal away, as „Weiter planen"
// through a gate does (planFoldResolve) — the orphan card's feedback goes out from the composer instead.
// An 'untracked' start (the head alone, the switch off) leaves NO plan — the one underway included: the model works on
// the started proposal now, and nobody will report against it. The rule of an approval without the block (above).
function planFoldStart(f, text, kind, ts) {
  var target = planStartPick(f.plan, f.orphan);
  if (!target) return false;
  planFoldForget(f, target.id); // a late tool_result for it (an aborted gate) must not re-accept it
  delete target._md;
  if (f.orphan === target || (f.orphan && f.orphan.id === target.id)) f.orphan = null;
  if (kind === 'keep') { planSupersede(target); return true; }
  if (kind === 'untracked') { f.plan = null; return true; }
  f.plan = planPromote(f.plan, target, planStartBlockOf(text).steps, ts);
  return true;
}
// The line after a „doesn't want to proceed" result (planFoldResolve): the interrupt marker → that was a Stop, the
// proposal stays on the table orphaned, as the live tab's retired card does; anything else → a rejection, off the
// table. Lines that are no message of either side (meta, a compaction summary, system lines) decide nothing.
function planFoldRejectSettle(f, obj) {
  if (obj.type !== 'user' && obj.type !== 'assistant') return;
  if (obj.type === 'user' && (obj.isMeta === true || obj.isCompactSummary === true)) return;
  var r = f.reject, parts = obj.type === 'user' ? planUserParts(obj) : null;
  f.reject = null;
  if (parts && parts.length === 1 && PLAN_INTERRUPT_RE.test(parts[0])) planFoldOrphanOf(f, r.id, r.cand);
  else if (f.plan && f.plan.id === r.id) planSupersede(f.plan, r.id);
}
// The user has spoken, so the turn that held these proposals' gates is over — and no answer came for them
// (none can any more: a gate belongs to the process's turn). The live tab orphans exactly these cards when it
// retires them (chat-render.js retirePlanCards: an interrupt, the process exit — the CLI writes no tool_result
// for them, measured 4 of 77 in the local corpus; one more wrote „AbortError", planGateLost). Without this, an
// unanswered proposal UNDER a plan underway was lost to the fold, while the live tab offered ▶ on its card.
// The newest one becomes f.orphan, by the order the proposals came in (f.nCand), not by when it was orphaned.
function planFoldAbandon(f) {
  if (!f.order.length) return false;
  var ids = f.order.slice();
  ids.forEach(function (id) {
    var c = f.cands[id];
    planFoldForget(f, id);
    if (!c || c.state !== 'proposed') return;
    planOrphan(c, id);
    if (c !== f.plan && (!f.orphan || (c._n || 0) > (f.orphan._n || 0))) f.orphan = c;
  });
  return true;
}
// The text parts of a user line, or null — compaction summaries and meta lines are the CLI's, not the user's, and
// a line with a tool_result is an answer to a tool, not a message.
function planUserParts(obj) {
  if (obj.isCompactSummary === true || obj.isMeta === true) return null;
  var c = obj.message && obj.message.content;
  if (typeof c === 'string') return c.trim() ? [c] : null;
  if (!Array.isArray(c) || c.some(function (b) { return b && b.type === 'tool_result'; })) return null;
  var out = c.filter(function (b) { return b && b.type === 'text' && typeof b.text === 'string' && b.text.trim(); }).map(function (b) { return b.text; });
  return out.length ? out : null;
}
// The text that decides what a user line does (planOutgoingKind): the LAST part — the panel sends pasted text
// attachments first and the typed message (with a chip's block) last (lib/chat.js sendToChat), and the typed message
// is what the live tab reads when it goes out (planNoteOutgoing gets `out`, never the attachments). Searching the
// parts for a block let a pasted attachment start the proposal in the fold while the live tab started nothing.
function planUserText(parts) { return parts[parts.length - 1]; }
// A fold candidate's steps, parsed now if they were not yet (see planFoldCandidate).
function planFoldSteps(p) {
  if (p && typeof p._md === 'string') { p.steps = planStepsParse(p._md).steps.map(planStepNew); delete p._md; }
  return p;
}
// → true when the line moved the fold (cheap to call for every line: irrelevant lines return early)
function planFoldLine(f, obj) {
  if (!f || !obj || typeof obj !== 'object' || obj.isSidechain === true) return false;
  if (f.reject) planFoldRejectSettle(f, obj);
  var ts = planTsOf(obj.timestamp);
  if (obj.type === 'system') {
    if (obj.subtype !== 'compact_boundary' || !f.plan || f.plan.state !== 'active' || !planFoldFresh(f, obj)) return false;
    f.plan.stale = true;
    return true;
  }
  var c = obj.message && obj.message.content;
  if (obj.type === 'assistant') {
    var blocks = Array.isArray(c) ? c : (typeof c === 'string' ? [{ type: 'text', text: c }] : []);
    var relevant = blocks.some(function (b) {
      return b && ((b.type === 'tool_use' && b.name === 'ExitPlanMode')
        || (b.type === 'text' && typeof b.text === 'string' && b.text.indexOf('```' + PLAN_STATUS_TAG) >= 0));
    });
    if (!relevant || !planFoldFresh(f, obj)) return false;
    blocks.forEach(function (b) {
      if (!b) return;
      if (b.type === 'tool_use' && b.name === 'ExitPlanMode') planFoldCandidate(f, b, ts);
      else if (b.type === 'text' && typeof b.text === 'string') {
        var ups = planStatusExtract(b.text);
        if (ups.length && f.plan) planFoldSteps(f.plan);
        ups.forEach(function (u) { f.plan = planFromStatus(f.plan, u, f.last, ts).plan; });
      }
    });
    return true;
  }
  if (obj.type === 'user') {
    var hits = Array.isArray(c) ? c.filter(function (b) { return b && b.type === 'tool_result' && typeof b.tool_use_id === 'string' && f.cands[b.tool_use_id]; }) : [];
    if (hits.length) {
      if (!planFoldFresh(f, obj)) return false;
      hits.forEach(function (b) { planFoldResolve(f, b, ts); });
      return true;
    }
    var parts = planUserParts(obj);
    if (!parts) return false;
    var said = planUserText(parts), kind = planOutgoingKind(said);
    // cheap for the common line: nothing waits for an answer, and the text neither starts nor keeps anything
    if ((!f.order.length && !kind) || !planFoldFresh(f, obj)) return false;
    var moved = planFoldAbandon(f);
    if (kind) moved = planFoldStart(f, said, kind, ts) || moved;
    return moved;
  }
  return false;
}
// → the planSave form (with `history`), or null when the transcript holds no plan. A „doesn't want to proceed" that
// the transcript ENDS on was no Stop — the CLI writes the interrupt marker as the very next line (446598fa…, 974 →
// 975) — so it reads as the rejection it says it is; on a copy, so a fold that goes on afterwards still decides it by
// its next line.
function planFoldResult(f) {
  if (!f || !f.plan) return null;
  var r = planSave(planFoldSteps(f.plan));
  if (r && f.reject && f.reject.id === r.id && r.state === 'proposed') r.state = 'superseded';
  return r;
}
// …and the two slots beside it that a live tab keeps as well (lib/sessions.js sends them with the plan): the orphan
// under a plan underway (what its card's ▶ starts — tab._planOrphan, planAdoptOrphan) and the newest proposal's name
// and file (tab._planLast). Without them a reload, a resume or a fork lost the ▶ of that card, and a plan the model
// reports without a "titel" was named after the proposal in the fold and nothing live.
function planFoldOrphan(f) {
  var o = f && f.orphan;
  return (o && o.state === 'proposed' && !(f.plan && f.plan.id === o.id)) ? planSave(planFoldSteps(o)) : null;
}
function planFoldLast(f) { return f ? planLastRestore(f.last) : null; }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PLAN_CAPS, PLAN_STATES, PLAN_HISTORY_STATES, PLAN_STEP_STATUSES, PLAN_STATUS_TAG, PLAN_STEPS_TAG, PLAN_STATUS_WORDS,
    PLAN_PROGRESS_PROTOCOL, PLAN_PROGRESS_SYSTEM_HINT, PLAN_PROTOCOL_HEAD,
    planTitleOf, planCleanTitle, planStepsParse, planStepsFromMarkdown, planStepsNormalize, planFileName,
    planNew, planAccept, planSupersede, planUnaccept, planDismiss, planStateSeen, planVisible, planChain, planOffer, planPromote,
    planOrphan, planIsOrphan, planIsNoPlanModeError, planGateLost, planOutgoingKind, planStartPick, planMessageSplit,
    planPanelTail, planStartBlockOf,
    planStepsBlock, planStepsBlockParse, planStepsBlockOf, planAcceptMessage, planStartMessage, planStepsRequestMessage,
    planStatusExtract, planStatusStrip, planStatusNormalize, planStepRef, planCurrentStep,
    planApplyStatus, planFromStatus, planCounts, planUnreported, planSig, planSave, planRestore, planAdopt, planAdoptOrphan,
    planLastRestore, planIsApproval,
    planStepMark,
    PLAN_TASK_PREFIX_RE, planTaskPrefix, planTaskLabel, planTaskMap, planTaskSig, planTaskMark,
    planFoldNew, planFoldLine, planFoldResult, planFoldOrphan, planFoldLast,
  };
}
