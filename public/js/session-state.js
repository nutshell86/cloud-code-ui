'use strict';
// G5 — what the CLI says about the SESSION (as opposed to about a turn, which is turn-end.js). Browser
// (classic script) AND Node (require'd by the test suite). Dependency-free and side-effect-free (ctx.js /
// turn-end.js spirit): no t()/tt(), no DOM. It returns PAYLOADS ({key, raw, sev}) and chat-status.js
// translates them.
//
// Two `system` frames, both of which the panel only receives because lib/chat.js now ASKS for them:
//   · session_state_changed {state}      — running | requires_action | idle
//   · commands_changed      {commands[]} — the full slash catalogue
//
// WHY this file exists: the frames were never on the stream at all. Measured 2026-10-02 against CLI
// 2.1.286 (docs/messung-2026-10-02.md, raw mitschnitt under ccui-probe/runs/paid-2026-10-02T19-55-29-267Z):
// the binary has exactly ONE emission site,
//     if (a.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS) Di({type:"system",subtype:"session_state_changed",state:e});
//     else if (a.CLAUDE_CODE_SDK_READS_SESSION_STATE) Di({…, sdk_host_only:true})
// and `lib/chat.js` passed neither variable on. None of the four measured frames carried `sdk_host_only`,
// so the attribution is unambiguous: they arrived BECAUSE the variable was set. G5 was a missing env
// field, not a protocol problem — and nothing here may invent a state, because there is no fallback path
// that could produce one.
//
// THE MEASUREMENT CORRECTED THE PLAN, and this file follows the measurement:
//   Lauf 1:  running (_seq 7) → requires_action (_seq 37) → running (_seq 39) → idle (_seq 80)
//   Lauf 2:  running (7) → idle (35) → requires_action (36) → idle (40) → running (54) → idle (58)
// The plan said „`idle` is the RELIABLE turn end". Lauf 2 refutes it: `idle` came THREE times, twice
// mid-run — once directly after a budget-terminated `result` (_seq 35) and once FOUR FRAMES BEFORE a
// workflow started four agents (_seq 40 against task_started at _seq 42). The CLI's own predicate is
// „no running background task, no active teammate, no open notification", i.e. a statement about NOW,
// not about the end of the turn. Reading every `idle` as „turn over" would end the same turn three times
// and declare it finished four frames before four agents start. So:
//   → `idle` NEVER ends anything here and is shown nowhere. It is stored for exactly one purpose: it is
//     what CLEARS a held `running` (see below). Dropping it would leave that marker standing for ever —
//     which is the other half of this project's rule: a state that ARRIVES must not be silently discarded.
//
// WHAT IS ACTUALLY WORTH SHOWING is the one case where the CLI's report and the panel's own display
// CONTRADICT each other. Both measured, both a real hole:
//   · `running` while the panel shows the tab at REST. This is CHAT-FLOW-3, and Lauf 1 is the proof: the
//     session stayed `running` from _seq 39 straight through the FIRST result (_seq 58, `result_index 0`)
//     and a whole follow-up turn (second `init` at _seq 66, stream_events 69–78) to the second result at
//     _seq 79 — while the panel sets `streaming = false` at the first result, which hides the Stop button
//     (`#interruptBtn`, chat-render.js setComposerBusy). The session worked on with no way to stop it.
//     Since the CHAT-FLOW-3 fix the follow-up turn itself is adopted as streaming once it streams
//     (turn-end.js turnOpenedByCli), so this chip is left for the stretch before it: only background agents
//     working, or main-thread work without stream/assistant frames (run 2).
//   · `requires_action` while the panel has NO gate of its own. The panel otherwise derives „a question is
//     open" from its own held gates (PERM queue / ASK_GATES) — which are RICHER than this frame (they carry
//     the request id, the tool name and the card), so where they exist this frame says nothing new and
//     stays silent. Where they do NOT exist, today's display reads „arbeite…" while the session is in fact
//     blocked. That hole is what this fills.
// `running` while the panel already shows a running turn adds nothing that is not on screen, so it is
// silent — per the brief, and because a permanently full status line is one nobody reads (same reasoning
// as TURN_STOP_SILENT in turn-end.js).
//
// NOT BUILT, on purpose: `local_command_output`. Unmeasurable rather than merely untriggered — the whole
// 2.1.286 binary contains no producer for it, only the Zod schema and the incoming adapter. Code for it
// would be code that never runs.

// The three values the schema names. A FOURTH one (a future CLI) must be VISIBLY unknown and must trigger
// none of the three paths — the same rule turn-end.js enforces for an unknown subtype / stop_reason /
// terminal_reason, and for the same reason: this project has shipped a surface that asserted something
// nobody confirmed three times already.
var SESSION_STATES = ['running', 'requires_action', 'idle'];

// One frame → the record a tab holds. `changed` is the idempotence the measurement demands („Mehrfaches
// `idle` muss idempotent sein" — Lauf 2 delivered three of them): a repeat of the same state is NOT a
// state change, so a caller can log/repaint on `changed` without flooding. Returns null for anything that
// is not a usable session_state_changed frame, so a garbled frame cannot wipe a good record.
// prev (the tab's record, or null) + frame -> {state, known, changed} | null
function sessionStateNote(prev, ev) {
  var e = (ev && typeof ev === 'object') ? ev : {};
  if (e.type !== 'system' || e.subtype !== 'session_state_changed') return null;
  // `state` is the only payload field besides uuid/session_id — measured, both runs, all ten frames.
  var raw = (e.state == null) ? '' : String(e.state);
  if (!raw) return null;
  var before = (prev && typeof prev === 'object') ? prev.state : null;
  return { state: raw, known: SESSION_STATES.indexOf(raw) >= 0, changed: raw !== before };
}

// The record + what the PANEL believes about the same tab -> the one thing worth saying, or nothing.
//   ctx.streaming — the panel shows this tab as a turn in flight (chat.streaming)
//   ctx.ownGate   — the panel holds a gate of its own for this tab (a permission modal/queue entry, or a
//                   held AskUserQuestion / ExitPlanMode). A FREIGABEFRAGE and an open plan/question card
//                   are not the same thing, but for this decision they are the same answer: in both cases
//                   the panel can already say WHAT is waiting, which this frame cannot.
// -> {key, tip, raw?, sev} | null   ('info' = a normal wait, 'warn' = a contradiction or an unknown value)
// `tip` travels WITH the key rather than being picked at the call site: all three payloads can land on the
// same chip, and one tooltip for three different situations would describe two of them wrongly — which is
// this project's bug class in miniature.
function sessionStateReport(rec, ctx) {
  if (!rec || typeof rec !== 'object' || !rec.state) return null; // no frame → nothing changes (older
  // CLI, or the variable unset). The whole feature is additive and this line is what makes it so.
  var c = (ctx && typeof ctx === 'object') ? ctx : {};
  // NOTE on where PRECEDENCE lives, because the obvious fix belongs elsewhere. A review found that an
  // unknown fourth state displaced the panel's own confirmed phases („warte auf Freigabe", „warte auf deine
  // Antwort", „Verbindung getrennt") — a CONFIRMED statement thrown away for a vocabulary note, this
  // project's bug class in mirror form. The tempting repair is `if (c.ownGate) return null` right here, and
  // it is wrong twice: it would silence `running` as well (a held gate is NOT the claim „nothing is running"
  // — see the test that pins this), and it cannot see RECONNECT at all, which is a phase and not a gate.
  // This function answers only „what does the session say about itself". Which of the two sentences reaches
  // the phase line is decided where the phase is known: displayPhase consults this ONLY for PHASE_WORKING.
  // A value we do not know, with its raw value next to it — and it falls through to NO other branch.
  if (!rec.known) return { key: 'session-state.unbekannt', tip: 'session-state.tipUnbekannt', raw: rec.state, sev: 'warn' };
  if (rec.state === 'requires_action') {
    return c.ownGate ? null : { key: 'session-state.wartetEntscheidung', tip: 'session-state.tipWartet', sev: 'info' };
  }
  if (rec.state === 'running') {
    return c.streaming ? null : { key: 'session-state.arbeitetNoch', tip: 'session-state.tipArbeitetNoch', sev: 'warn' };
  }
  return null; // idle — see the header: a rest report about NOW, never an end signal
}

// The slash catalogue, live. `commands_changed` carries the FULL list (60 entries in the paid run, same
// vocabulary as `init.slash_commands` — compared set against set, the two were identical, which is why
// this returns the exact shape chat-events.js already assigns on `init`: '/'-prefixed names).
// Per entry the frame carries {name, description, argumentHint} and, on some, {builtin} (45×) and
// {aliases} (9×, e.g. `frontend-design:frontend-design` → `frontend-design`). The aliases are typeable
// too, so they join the menu — under their own name, not as a replacement.
// A list that yields NO usable name returns null instead of an empty array — an empty `commands`, a
// non-array, or entries the loop below throws away. The caller's assignment would otherwise empty the
// slash menu on a malformed frame, and „the menu is gone" is not a state any frame here has been seen to
// describe (every measured list contains the builtins). ONE guard, at the end: an extra `!commands.length`
// in the line below looked like the safety net and was dead code — the mutation proof found it green.
// -> ['/name', …] | null
function commandsFromFrame(ev) {
  var e = (ev && typeof ev === 'object') ? ev : {};
  if (!Array.isArray(e.commands)) return null;
  var out = [], seen = {};
  var add = function (n) {
    var s = String(n == null ? '' : n).trim();
    if (!s || s.charAt(0) === '/') return; // the CLI sends bare names; a '/' here would make '//x'
    if (seen[s]) return;
    seen[s] = 1; out.push('/' + s);
  };
  e.commands.forEach(function (c) {
    if (!c || typeof c !== 'object') return;
    add(c.name);
    if (Array.isArray(c.aliases)) c.aliases.forEach(add);
  });
  return out.length ? out : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sessionStateNote, sessionStateReport, commandsFromFrame, SESSION_STATES };
}
