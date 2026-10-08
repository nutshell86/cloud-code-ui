'use strict';
// How a turn ENDED, read out of the `result` frame — browser (classic script) AND Node (require'd by
// the test suite and by lib/sessions.js). Dependency-free and side-effect-free (ctx.js / limits.js
// spirit): no t()/tt(), no DOM. It returns PAYLOADS ({key, sev, num, raw, text}) and the drawer in
// chat-events.js translates them.
// Plus, at the bottom, its one counterpart: turnOpenedByCli — the frame that shows a turn has BEGUN
// without the panel sending anything (CHAT-FLOW-3). Same file because it is the other edge of the same
// lifecycle and needs the same Node seam for its table test.
//
// WHY this file exists: the panel turned EVERY failed turn into one `⚠ Fehler`
// (chat-events.js, case 'result': `if (ev.is_error) parts.unshift('⚠ ' + tt('chat-events.fehler'))`)
// while the SAME frame already carried four distinguishable subtypes, the CLI's own plain-text
// `errors[]`, a `stop_reason`, a `terminal_reason`, the tools the run was denied and the agents it
// never started. This project has shipped a surface that asserted something nobody confirmed three
// times already (a derived context window shown as „measured", a switch timeout shown as „Ultracode
// aus", a live model key reported dead), so one rule is baked into every branch below:
//
//   A VALUE WE DO NOT KNOW MUST BE VISIBLY UNKNOWN, WITH ITS RAW VALUE NEXT TO IT.
//
// A new `subtype` in a future CLI must not quietly become „Fehler"; the same for an unknown
// `stop_reason` and an unknown `terminal_reason`. test/turn-end.test.js fails without that property.
//
// The vocabulary below is MEASURED, not remembered: `claude.exe` (2.1.286) carries its Zod schemas with
// their .describe() texts in the clear, and reading strings out of the binary costs nothing while a turn
// costs money.
//   · result (error variant): subtype ∈ {error_during_execution, error_max_turns, error_max_budget_usd,
//     error_max_structured_output_retries}, plus `errors: string[]`
//   · result (success variant): same frame, but `is_error` + api_error_status/api_error_code exist here
//     too, and the schema says in so many words: subtype "success" carries the final assistant text —
//     „or, with is_error true, the error text when the turn ended on an API error".
//   · stop_reason ∈ {end_turn, max_tokens, stop_sequence, tool_use, pause_turn, compaction, refusal,
//     model_context_window_exceeded} — EIGHT values. `compaction` is in the binary's own list and in its
//     stop-reason switch (pause_turn/compaction → „resume"), and it was missing from the briefing's list
//     of seven. Guessing it into the unknown bucket would have been harmless; leaving it out of the
//     „the turn continues" group would not.
//   · terminal_reason: `U(tw).describe("Why the query loop terminated. Unset when the loop was bypassed
//     (local slash command).")` over 19 values — and the binary classifies them itself (see
//     TURN_TERMINAL_ERROR), so this file does not have to guess which of them is a failure.
//   · permission_denials: {tool_name, tool_use_id, tool_input}[]
//   · subagent_stats.refused: {depth_limit, concurrency_limit, budget} — „Agent tool calls turned down
//     because one of these limits was reached". Agents that NEVER STARTED, which is exactly what
//     explains a run that did less than expected.
//
// TWO different lifetimes, and mixing them up would produce this project's bug class all over again:
//   · `permission_denials` is built FRESH per turn — the binary creates the array inside the turn runner
//     (`G_(canUseTool)` → `let r=[]`, one per turn), so its length IS this turn's number.
//   · `subagent_stats` is the SESSION's running total: „Cumulative like modelUsage: read the latest
//     result rather than summing across results." Printing `refused.budget: 2` from the absolute value
//     would re-report the same two refusals under every later turn of the session. So the caller hands
//     in what it had already seen, only the DELTA is reported, and the new baseline comes back as
//     `refusedSeen`.
//
// NOT shown, deliberately: `queued_turn_count` („User-initiated sends still waiting in the command
// queue when this result was produced"). It is not a statement about how this turn ended — it is the
// CLI's count of the panel's OWN queue, which the panel already owns, shows in the composer and flushes
// itself (`flushQueue` right below this case). A second, independently-derived number for the same thing
// is how two counters start disagreeing in public.

var TURN_END_SUBTYPE_KEYS = {
  error_during_execution: 'turn-end.grundAusfuehrung',
  error_max_turns: 'turn-end.grundMaxTurns',
  error_max_budget_usd: 'turn-end.grundBudget',
  error_max_structured_output_retries: 'turn-end.grundStrukturierteAusgabe',
};
// stop_reason, split by what it means for the answer that is ALREADY ON SCREEN.
// end_turn and tool_use are the normal case of every single turn: a line for them would make the footer
// permanently full, and a permanently full line is one nobody reads — which is how the three values
// below stayed invisible in the first place.
// `tool_deferred` joins them for a different reason: it is not the normal case, but the SAME frame also
// carries `terminal_reason: 'tool_deferred'`, which this file already turns into „Werkzeug aufgeschoben".
// Left out, the footer said the fact twice — and the first half said it as „Unbekannter Stoppgrund
// (tool_deferred)", i.e. claimed not to know a word the table 100 lines down names explicitly. (It is
// not in the message-level stop_reason enum, which is why it was missed: the CLI synthesises the value
// in the result frame itself.)
var TURN_STOP_SILENT = ['end_turn', 'tool_use', 'tool_deferred'];
// …and these three mean the text above the footer is NOT what it looks like. Each gets a banner of its
// own (see turnEndStopBanner), not just a footer chip.
var TURN_STOP_BANNER_KEYS = {
  max_tokens: 'turn-end.abgeschnittenAusgabelimit',
  model_context_window_exceeded: 'turn-end.abgeschnittenKontextfenster',
  refusal: 'turn-end.verweigert',
};
// The turn is not over at all — the loop pauses and comes back (the binary maps both to „resume").
var TURN_STOP_CONTINUES = { pause_turn: 'turn-end.stopPause', compaction: 'turn-end.stopKompaktierung' };
// A complete answer that ended on a stop sequence. „The panel sets none, so this never shows up" was the
// first version of this comment and it is wrong: 59 of 56 761 assistant lines in this machine's corpus
// carry `stop_sequence`. Rare, then, not impossible — and how often it reaches the FOOTER is a different
// number again, because the footer shows the stop reason of a turn's LAST message, which none of those 59
// has been shown to be. So: kept visible, and the comment claims only what was counted.
var TURN_STOP_OTHER = { stop_sequence: 'turn-end.stopSequenz' };

// Entries of `errors[]` that are log markers rather than sentences for a reader. Not invented here: the
// CLI filters exactly these two prefixes out of `errors[]` in two of its own consumers.
var TURN_ERR_INTERNAL = /^\s*\[(?:ede_diagnostic|session_crash)\b/;

// terminal_reason — the CLI's OWN error/not-error split, copied verbatim from the switch in the binary
// that answers exactly this question (it returns true for these eleven and false for aborted_streaming,
// aborted_tools, stop_hook_prevented, hook_stopped, tool_deferred, max_turns, background_requested and
// completed). Taking the CLI's classification instead of inventing one is the whole point: a user
// cancel (aborted_*) must never be painted as a failure, and „prompt_too_long" must never be painted as
// a harmless note.
var TURN_TERMINAL_ERROR = ['blocking_limit', 'rapid_refill_breaker', 'prompt_too_long', 'image_error',
  'model_error', 'api_error', 'malformed_tool_use_exhausted', 'budget_exhausted',
  'structured_output_retry_exhausted', 'tool_deferred_unavailable', 'turn_setup_failed'];
// The non-error ends that are worth a word. `completed` maps to null on purpose: it is the normal end
// and saying so every time is noise. A value present here is KNOWN — the raw string is not shown.
var TURN_TERMINAL_INFO_KEYS = {
  aborted_streaming: 'turn-end.endeAbgebrochen',
  aborted_tools: 'turn-end.endeAbgebrochen',
  background_requested: 'turn-end.endeHintergrund',
  stop_hook_prevented: 'turn-end.endeHook',
  hook_stopped: 'turn-end.endeHook',
  tool_deferred: 'turn-end.endeWerkzeugAufgeschoben',
  max_turns: 'turn-end.endeMaxTurns',
  completed: null,
};
// …and where the subtype has ALREADY said it. `error_max_budget_usd` always travels with
// `terminal_reason: "budget_exhausted"`, so printing both would put the same fact in the line twice.
var TURN_TERMINAL_BY_SUBTYPE = {
  budget_exhausted: 'error_max_budget_usd',
  max_turns: 'error_max_turns',
  structured_output_retry_exhausted: 'error_max_structured_output_retries',
};
var TURN_REFUSED_KEYS = [
  ['budget', 'turn-end.agentenAbgelehntBudget'],
  ['concurrency_limit', 'turn-end.agentenAbgelehntParallel'],
  ['depth_limit', 'turn-end.agentenAbgelehntTiefe'],
];

function turnEndRank(sev) { return sev === 'error' ? 2 : sev === 'info' ? 1 : 0; }
function turnEndCount(v) { var n = Number(v); return (isFinite(n) && n > 0) ? Math.round(n) : 0; }
// The CLI's own sentence, collapsed to one line and length-bounded because it lands in a one-line
// footer. Bounded, NOT translated — see the `text` field in turnEndInfo.
function turnEndClip(v, max) {
  var s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// The one end reason that also survives a RELOAD, factored out for that reason. A transcript .jsonl
// holds no `result` line at all — measured over 25 files of the live corpus, the line types are
// user / assistant / attachment / summary / system / queue-operation / last-prompt / atis-latch /
// cost-state — so subtype, errors[], terminal_reason, permission_denials and subagent_stats are
// genuinely GONE once a tab is resumed; no panel code can bring them back. ONE field is persisted:
// every assistant line carries `message.stop_reason` (same corpus: tool_use 666×, end_turn 31×). So the
// end reason that changes how the TEXT must be read is still available after a reload, and lib/sessions
// uses this function to decide which values are worth carrying into the transcript payload.
// -> {key, raw} | null
function turnEndStopBanner(stop) {
  var s = (stop == null) ? '' : String(stop);
  return TURN_STOP_BANNER_KEYS[s] ? { key: TURN_STOP_BANNER_KEYS[s], raw: s } : null;
}

// result frame (+ the refused counters seen at the previous result of this tab, or null)
// -> { severity:'error'|'info'|'', parts:[{key,sev,num?,raw?,text?}], banner:{key,raw}|null,
//      refusedSeen:{budget,concurrency_limit,depth_limit} }
function turnEndInfo(ev, prevRefused) {
  var e = (ev && typeof ev === 'object') ? ev : {};
  var parts = [], banner = null;
  var isError = e.is_error === true;
  var subtype = (e.subtype == null) ? '' : String(e.subtype);
  // VERBATIM, not translated. The CLI writes these itself („Reached maximum number of turns (12)") and a
  // German paraphrase of it cannot be found again — not by a web search, not in the CLI's issue tracker,
  // not by the next person grepping this transcript for the wording they saw on screen.
  // …but not every entry is addressed to a reader. On an abort the first entry is
  // `[ede_diagnostic] result_type=assistant last_content_type=tool_use stop_reason=tool_use` — an
  // internal log marker, and the CLI strips exactly these prefixes in two of its OWN consumers. Printed
  // verbatim it put a diagnostic string in front of the user as though it were the explanation. So the
  // first entry that is not a marker wins; if there is none, the line stays without a sentence rather
  // than borrowing one that was never meant for anybody.
  var errText = '';
  if (Array.isArray(e.errors)) {
    for (var ei = 0; ei < e.errors.length; ei++) {
      var cand = turnEndClip(e.errors[ei], 240);
      if (cand && !TURN_ERR_INTERNAL.test(cand)) { errText = cand; break; }
    }
  }

  // AN ABORT OUTRANKS THE SUBTYPE. This inversion corrects a real defect, not a hypothetical one:
  // pressing Stop (or Strg+Enter while a tool call is open) does NOT produce a tidy „cancelled" frame.
  // The CLI builds `{subtype:'error_during_execution', is_error:true, terminal_reason:'aborted_tools',
  // errors:['[ede_diagnostic] …']}`. Evaluated subtype-first, the panel called the user's own Stop
  // button „⚠ Ausführungsfehler", pasted the diagnostic marker into the footer and painted the tab red —
  // while the comment above TURN_TERMINAL_ERROR promised the exact opposite in the same file.
  // `terminal_reason` is the more reliable of the two signals: in the binary `aborted_streaming` and
  // `aborted_tools` are produced for aborts and for nothing else, whereas this `is_error` comes from a
  // branch that cannot tell an abort from a crash. And it is the frequent path, not the exotic one — on
  // this machine's corpus a turn ending with an open tool call is the normal case (stop_reason tool_use
  // 43 569 against end_turn 2 011).
  var term = (e.terminal_reason == null) ? '' : String(e.terminal_reason);
  var aborted = (term === 'aborted_streaming' || term === 'aborted_tools');
  var apiNamed = false;

  if (aborted) {
    parts.push({ key: 'turn-end.endeAbgebrochen', sev: 'info' });
  } else if (TURN_END_SUBTYPE_KEYS[subtype]) {
    var r = { key: TURN_END_SUBTYPE_KEYS[subtype], sev: 'error' };
    // The CLI puts the ceiling in the message, but `num_turns` is the number that was actually run —
    // and „nach 12 Zügen" is the half of it a reader can act on.
    if (subtype === 'error_max_turns' && turnEndCount(e.num_turns)) r.num = turnEndCount(e.num_turns);
    if (errText) r.text = errText;
    parts.push(r);
  } else if (isError && subtype === 'success' && (turnEndCount(e.api_error_status)
      || (e.api_error_code != null && String(e.api_error_code).trim()) || term === 'api_error')) {
    // The success variant IS what an API error arrives in, with the status on `api_error_status` — but
    // only naming it when the frame CARRIES that evidence. It used to be named from `is_error` + subtype
    // alone, and the binary has a second producer of exactly that pair with no api_error field anywhere
    // near it: the panel would then have printed „API-Fehler" about something that was not one. Naming a
    // cause the data does not carry is this project's bug class, and the fields that would have proved it
    // were sitting in the same frame unread. Without evidence the turn falls through to „unbekannter
    // Grund" below, which says what we actually know.
    // Status and code go into `raw` TOGETHER rather than into `num`: either can be absent („Absent when
    // the turn did not end on an API error or the response carried no code"), and a label ending in
    // „· Status" with nothing behind it is the kind of half-sentence this PR exists to remove.
    var a = { key: 'turn-end.grundApiFehler', sev: 'error' };
    var bits = [];
    if (turnEndCount(e.api_error_status)) bits.push(String(turnEndCount(e.api_error_status)));
    if (e.api_error_code != null && String(e.api_error_code).trim()) bits.push(String(e.api_error_code).trim());
    if (bits.length) a.raw = bits.join(' ');
    parts.push(a);
    apiNamed = true;   // …so the terminal_reason below does not say `api_error` a second time
  } else if (isError) {
    // THE requirement this file was written for, not an edge case: a CLI that gains a fifth error
    // subtype must make it SHOW, with its raw value, instead of folding it into the same „Fehler" as
    // the other four. `—` rather than an empty string so the line can never read „Unbekannter Grund: ".
    parts.push({ key: 'turn-end.grundUnbekannt', sev: 'error', raw: subtype || '—' });
    if (errText) parts[parts.length - 1].text = errText;
  }

  var stop = (e.stop_reason == null) ? '' : String(e.stop_reason);
  if (stop && TURN_STOP_SILENT.indexOf(stop) < 0) {
    banner = turnEndStopBanner(stop);
    if (banner) {
      // The footer keeps a SHORT marker (the long sentence is in the banner, two rows up): the same
      // sentence printed twice a row apart trains the eye to skip both, but a footer that stays silent
      // would describe this turn as clean once the banner has scrolled away.
      parts.push({ key: stop === 'refusal' ? 'turn-end.antwortVerweigert' : 'turn-end.antwortUnvollstaendig', sev: 'error' });
    } else if (TURN_STOP_CONTINUES[stop]) parts.push({ key: TURN_STOP_CONTINUES[stop], sev: 'info' });
    else if (TURN_STOP_OTHER[stop]) parts.push({ key: TURN_STOP_OTHER[stop], sev: 'info' });
    // An unknown stop_reason is INFO, never an error: we do not know whether it broke anything, and
    // claiming a failure we cannot prove is the exact mistake this whole PR is about.
    else parts.push({ key: 'turn-end.stopUnbekannt', sev: 'info', raw: stop });
  }

  var den = Array.isArray(e.permission_denials) ? e.permission_denials : [];
  if (den.length) {
    // A denial is INFORMATION, never the verdict on the turn — the ordinary case is a SUCCESSFUL turn in
    // which one tool was refused and the model took another route. So it carries 'info' even on a failed
    // turn (the real end reason above owns the 'error'), and it can never by itself paint a turn red.
    // The tool names come along because „1 Werkzeug abgelehnt" without saying which one sends the reader
    // hunting through the transcript; capped at three so a denied loop cannot eat the footer.
    var names = [];
    den.forEach(function (d) {
      var n = (d && d.tool_name != null) ? String(d.tool_name).trim() : '';
      if (n && names.indexOf(n) < 0 && names.length < 3) names.push(n);
    });
    var dp = { key: 'turn-end.werkzeugeAbgelehnt', sev: 'info', num: den.length };
    if (names.length) dp.raw = names.join(', ');
    parts.push(dp);
  }

  var stats = e.subagent_stats || e.subagentStats || null;
  var ref = (stats && typeof stats.refused === 'object' && stats.refused) ? stats.refused : null;
  var prev = (prevRefused && typeof prevRefused === 'object') ? prevRefused : null;
  var seen = { budget: 0, concurrency_limit: 0, depth_limit: 0 };
  if (ref) {
    TURN_REFUSED_KEYS.forEach(function (pair) {
      var total = turnEndCount(ref[pair[0]]);
      seen[pair[0]] = total;
      // Delta, see the header. A NEGATIVE delta (a mid-session /clear zeroes the counters) reports
      // nothing and simply takes the lower value as the new baseline — a „-2" would be worse than silence.
      var delta = total - (prev ? turnEndCount(prev[pair[0]]) : 0);
      if (delta > 0) parts.push({ key: pair[1], sev: 'info', num: delta });
    });
  } else if (prev) {
    // No stats in this frame („Omitted by hosts without a local Agent tool and on crash/startup-error
    // results"): hold the baseline instead of resetting it to zero, or the next frame that does carry
    // stats would report every refusal of the session again.
    seen = { budget: turnEndCount(prev.budget), concurrency_limit: turnEndCount(prev.concurrency_limit), depth_limit: turnEndCount(prev.depth_limit) };
  }

  // `term` was read at the top (the abort gate needs it). Three reasons to stay silent here, all of them
  // „this line already says that": the subtype said it (the table), the abort gate said it, or the API
  // branch said it — the last one is why `api_error` needs its own test: it travels with
  // `subtype: 'success'`, so the subtype table cannot catch it and a real 529 was printed twice.
  if (term && !aborted && !(apiNamed && term === 'api_error') && TURN_TERMINAL_BY_SUBTYPE[term] !== subtype) {
    if (Object.prototype.hasOwnProperty.call(TURN_TERMINAL_INFO_KEYS, term)) {
      var ik = TURN_TERMINAL_INFO_KEYS[term];
      if (ik) parts.push({ key: ik, sev: 'info' });
    } else if (TURN_TERMINAL_ERROR.indexOf(term) >= 0) {
      // Known to be a failure, but there are eleven of them and they are machine words. One key plus the
      // raw value beats eleven invented German sentences: `prompt_too_long` is what the CLI's own logs,
      // its issue tracker and a web search all call it.
      parts.push({ key: 'turn-end.endeFehler', sev: 'error', raw: term });
    } else {
      parts.push({ key: 'turn-end.endeUnbekannt', sev: 'info', raw: term });
    }
  }

  var sev = banner ? 'error' : '';
  parts.forEach(function (p) { if (turnEndRank(p.sev) > turnEndRank(sev)) sev = p.sev; });
  return { severity: sev, parts: parts, banner: banner, refusedSeen: seen };
}

// The tab badge, as a FUNCTION rather than as a condition at the call site. Not a style choice: the
// condition there read `((endInfo && endInfo.severity === 'error') || ev.is_error)`, and that trailing
// `|| ev.is_error` broke the promise its own comment made — a user's Stop arrives WITH `is_error: true`,
// so the footer said „abgebrochen, kein Fehler" while the badge beside it said failure. A condition in a
// DOM function is also the one place no test here could reach, which is how it survived the review of the
// line directly above it. So the verdict lives next to the verdict it has to agree with, and the suite
// covers both. `is_error` is consulted ONLY when there is no verdict to follow (turn-end.js not loaded).
function turnEndBadge(info, ev) {
  if (info && typeof info === 'object') return info.severity === 'error' ? 'error' : 'done';
  return (ev && ev.is_error === true) ? 'error' : 'done';
}

// CHAT-FLOW-3 — the turn the CLI starts BY ITSELF. After a background agent reports back the CLI runs a
// follow-up turn with no user message behind it, and `streaming` — set only by the panel's own send paths,
// cleared by every `result` — read „idle" for all of it: no ⏹, a typed message went straight to stdin past
// the queue, the strip showed no phase. handleEventBody adopts such a turn (setComposerBusy(true)) when this
// says so; its own `result` then ends it like any other turn.
// Deliberately narrow, every exclusion is a way to open a turn no `result` will ever close:
//   · only `message_start` among the stream events — run 2 shows a `result` landing between message_delta
//     and the (missing) message_stop, so a straggler content_block_stop/message_delta/message_stop after a
//     result is possible, and it must not open anything;
//   · a whole `assistant` frame too, because the follow-up turn of fake-claude's bgagent (and a CLI without
//     --include-partial-messages) sends no stream events at all;
//   · main thread only: a frame relayed from a sub-agent (parent_tool_use_id) is the agent's, not a turn;
//   · not `synthetic` — a message the CLI composed itself (an error text, a cancel notice, model
//     „<synthetic>"). The caller computes it with ctxSyntheticModel, the one place that rule lives;
//   · never while a turn already runs (it would reset turnStart/tokenBase mid-turn) and never after the
//     process exited (`_exit` hangs on proc 'exit', and stdout lines may still follow it — adopting one would
//     clear `_exited` and bring a dead tab back to life).
// `user`, `system/init` and `session_state_changed` open nothing: init timing differs by CLI version, and
// `running` also covers the stretch in which only background agents work.
// NOT covered, measured in run 2: main-thread work after result#0 that carries no stream/assistant frame at
// all (a permission request, a Workflow run, a follow-up turn of only system frames) still reads as idle.
function turnOpenedByCli(ev, s) {
  if (!ev || typeof ev !== 'object' || !s || s.streaming || s.exited) return false;
  if (ev.parent_tool_use_id || ev.parentToolUseId) return false;
  if (ev.type === 'stream_event') return !!(ev.event && ev.event.type === 'message_start');
  if (ev.type === 'assistant') return !s.synthetic;
  return false;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    turnEndInfo, turnEndStopBanner, turnEndClip, turnEndBadge, turnOpenedByCli,
    TURN_END_SUBTYPE_KEYS, TURN_STOP_SILENT, TURN_STOP_BANNER_KEYS, TURN_TERMINAL_ERROR,
    TURN_TERMINAL_INFO_KEYS, TURN_TERMINAL_BY_SUBTYPE,
  };
}
