'use strict';
// G2 — the end reason of a turn. Every frame shape below is built from the schema the 2.1.286 binary
// carries in the clear (see the header of public/js/turn-end.js); nothing here is remembered.
//
// What this suite is actually guarding, and why each case is worth its lines: the panel turned EVERY
// failed turn into one `⚠ Fehler`. The replacement is only worth having if it cannot fall back into that
// — so the cases that MUST stay red without the fix are the three „unknown" ones (a future CLI's new
// subtype / stop_reason / terminal_reason), the two „this is not an error" ones (a denied tool on a
// successful turn, a user cancel), and the cumulative-counter one (a refusal from three turns ago must
// not be re-reported under this turn).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { turnEndInfo, turnEndStopBanner, turnEndBadge } = require('../public/js/turn-end');

// the fields every result frame carries, so each case below only states what it is ABOUT
const OK = {
  type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, duration_api_ms: 900,
  num_turns: 1, stop_reason: 'end_turn', total_cost_usd: 0.01, usage: {}, modelUsage: {},
  permission_denials: [], uuid: 'u', session_id: 's',
};
const ERR = { ...OK, subtype: 'error_during_execution', is_error: true, stop_reason: null, errors: ['Execution error'] };
const keys = (info) => info.parts.map((p) => p.key);
const part = (info, key) => info.parts.find((p) => p.key === key);
const stats = (refused) => ({ spawned: 0, completed: 0, failed: 0, refused });

describe('turn-end — the normal turn says nothing', () => {
  it('a clean success produces no line and no severity at all', () => {
    const i = turnEndInfo(OK, null);
    assert.deepEqual(i.parts, [], 'a footer that always carries a line is a footer nobody reads');
    assert.equal(i.severity, '');
    assert.equal(i.banner, null);
  });
  it('stop_reason tool_use is just as silent (it is on almost every frame)', () => {
    assert.deepEqual(turnEndInfo({ ...OK, stop_reason: 'tool_use' }, null).parts, []);
  });
  it('a missing / null stop_reason invents nothing', () => {
    for (const v of [null, undefined, '']) {
      assert.deepEqual(turnEndInfo({ ...OK, stop_reason: v }, null).parts, [], JSON.stringify(v));
    }
  });
  it('terminal_reason "completed" is the normal end and stays unspoken', () => {
    assert.deepEqual(turnEndInfo({ ...OK, terminal_reason: 'completed' }, null).parts, []);
  });
  it('survives a frame that is not a frame', () => {
    for (const v of [null, undefined, 42, 'result', {}]) {
      const i = turnEndInfo(v, null);
      assert.deepEqual(i.parts, []);
      assert.equal(i.severity, '');
    }
  });
});

describe('turn-end — the four error subtypes each get their own reason', () => {
  it('error_during_execution carries the CLI\'s own sentence VERBATIM', () => {
    const i = turnEndInfo({ ...ERR, errors: ['Execution error: the tool runner died'] }, null);
    assert.deepEqual(keys(i), ['turn-end.grundAusfuehrung']);
    assert.equal(i.severity, 'error');
    // untranslated on purpose: a German paraphrase of this cannot be searched for anywhere
    assert.equal(i.parts[0].text, 'Execution error: the tool runner died');
  });
  it('error_max_turns adds the turns that were actually run', () => {
    const i = turnEndInfo({ ...ERR, subtype: 'error_max_turns', num_turns: 12, errors: ['Reached maximum number of turns (12)'] }, null);
    assert.deepEqual(keys(i), ['turn-end.grundMaxTurns']);
    assert.equal(i.parts[0].num, 12);
    assert.equal(i.parts[0].text, 'Reached maximum number of turns (12)');
  });
  it('error_max_budget_usd and error_max_structured_output_retries are distinguishable', () => {
    assert.deepEqual(keys(turnEndInfo({ ...ERR, subtype: 'error_max_budget_usd' }, null)), ['turn-end.grundBudget']);
    assert.deepEqual(keys(turnEndInfo({ ...ERR, subtype: 'error_max_structured_output_retries' }, null)), ['turn-end.grundStrukturierteAusgabe']);
  });
  it('a multi-line / over-long errors[0] is collapsed and bounded, not dropped', () => {
    const i = turnEndInfo({ ...ERR, errors: ['line one\n   line two'] }, null);
    assert.equal(i.parts[0].text, 'line one line two');
    const long = turnEndInfo({ ...ERR, errors: ['x'.repeat(500)] }, null);
    assert.equal(long.parts[0].text.length, 240);
    assert.ok(long.parts[0].text.endsWith('…'));
  });
  it('an absent errors[] leaves the field off rather than inventing a sentence', () => {
    const i = turnEndInfo({ ...ERR, errors: [] }, null);
    assert.equal(i.parts[0].text, undefined);
    assert.equal(turnEndInfo({ ...ERR, errors: undefined }, null).parts[0].text, undefined);
  });
});

// THE requirement, not an edge case: the CLI gains subtypes between versions, and the old code folded
// every one of them into the same single word.
describe('turn-end — an UNKNOWN subtype is visibly unknown, with its raw value', () => {
  it('shows the unrecognised subtype itself', () => {
    const i = turnEndInfo({ ...ERR, subtype: 'error_max_quantum_flux' }, null);
    assert.deepEqual(keys(i), ['turn-end.grundUnbekannt']);
    assert.equal(i.parts[0].raw, 'error_max_quantum_flux', 'the raw value is the only thing a reader can search for');
    assert.equal(i.severity, 'error');
  });
  it('still carries errors[0] — the CLI usually explains itself even then', () => {
    const i = turnEndInfo({ ...ERR, subtype: 'error_future', errors: ['Something new went wrong'] }, null);
    assert.equal(i.parts[0].text, 'Something new went wrong');
  });
  it('an is_error frame with NO subtype at all never renders a dangling label', () => {
    for (const v of [undefined, null, '']) {
      const i = turnEndInfo({ ...ERR, subtype: v }, null);
      assert.deepEqual(keys(i), ['turn-end.grundUnbekannt']);
      assert.equal(i.parts[0].raw, '—', JSON.stringify(v) + ' must not produce "Unbekannter Grund: "');
    }
  });
  // measured: the SUCCESS variant is what an API error arrives in (is_error + api_error_status, text in
  // `result`) — so "success" must not be reported as an unknown subtype
  it('subtype success + is_error is the API error, with status and code raw', () => {
    const i = turnEndInfo({ ...OK, is_error: true, api_error_status: 529, api_error_code: 'overloaded_error' }, null);
    assert.deepEqual(keys(i), ['turn-end.grundApiFehler']);
    assert.equal(i.parts[0].raw, '529 overloaded_error');
    assert.equal(i.severity, 'error');
  });
  // This case used to assert that `is_error` + subtype 'success' ALONE is enough to call it an API error,
  // with no field to back it. That assertion was wrong, and it was wrong in this project's own bug class:
  // the binary has a second producer of exactly that pair with no api_error field near it, so the panel
  // would have named a cause the frame did not carry. What remains true is the half-sentence rule — one
  // piece of evidence is enough to NAME it, and a missing second piece must not leave a dangling label.
  it('one piece of evidence names it; a missing second piece leaves no half-sentence', () => {
    const statusOnly = turnEndInfo({ ...OK, is_error: true, api_error_status: 529 }, null);
    assert.deepEqual(keys(statusOnly), ['turn-end.grundApiFehler']);
    assert.equal(statusOnly.parts[0].raw, '529', 'the code is absent — nothing may be appended for it');
    const reasonOnly = turnEndInfo({ ...OK, is_error: true, terminal_reason: 'api_error' }, null);
    assert.deepEqual(keys(reasonOnly), ['turn-end.grundApiFehler'], 'terminal_reason is evidence too');
    assert.equal(reasonOnly.parts[0].raw, undefined, 'and carries no status to print');
  });
});

describe('turn-end — stop_reason: a truncated answer stops looking finished', () => {
  it('max_tokens and model_context_window_exceeded raise a banner AND a footer marker', () => {
    for (const [v, key] of [['max_tokens', 'turn-end.abgeschnittenAusgabelimit'], ['model_context_window_exceeded', 'turn-end.abgeschnittenKontextfenster']]) {
      const i = turnEndInfo({ ...OK, stop_reason: v }, null);
      assert.deepEqual(i.banner, { key, raw: v }, v + ' must get its own prominent place');
      assert.deepEqual(keys(i), ['turn-end.antwortUnvollstaendig']);
      assert.equal(i.severity, 'error', 'is_error is FALSE here — the truncation is the whole finding');
    }
  });
  it('refusal is its own wording, not "incomplete"', () => {
    const i = turnEndInfo({ ...OK, stop_reason: 'refusal' }, null);
    assert.deepEqual(i.banner, { key: 'turn-end.verweigert', raw: 'refusal' });
    assert.deepEqual(keys(i), ['turn-end.antwortVerweigert']);
  });
  it('pause_turn and compaction say the turn CONTINUES, as an info', () => {
    // compaction was missing from the briefing's list of seven stop reasons; the binary has eight and
    // maps pause_turn/compaction to „resume" — putting them in the unknown bucket would read as a defect
    const p = turnEndInfo({ ...OK, stop_reason: 'pause_turn' }, null);
    assert.deepEqual(keys(p), ['turn-end.stopPause']);
    assert.equal(p.severity, 'info');
    assert.deepEqual(keys(turnEndInfo({ ...OK, stop_reason: 'compaction' }, null)), ['turn-end.stopKompaktierung']);
    assert.equal(turnEndInfo({ ...OK, stop_reason: 'compaction' }, null).banner, null);
  });
  it('stop_sequence is named (this panel sets none, so it would be a surprise)', () => {
    assert.deepEqual(keys(turnEndInfo({ ...OK, stop_reason: 'stop_sequence' }, null)), ['turn-end.stopSequenz']);
  });
  it('an UNKNOWN stop_reason is shown raw — and as info, because we cannot prove a failure', () => {
    const i = turnEndInfo({ ...OK, stop_reason: 'tool_search_exhausted' }, null);
    assert.deepEqual(keys(i), ['turn-end.stopUnbekannt']);
    assert.equal(i.parts[0].raw, 'tool_search_exhausted');
    assert.equal(i.severity, 'info', 'claiming an error we did not measure is this project\'s own bug class');
  });
  it('turnEndStopBanner is the shared classification (lib/sessions uses it on resume)', () => {
    assert.deepEqual(turnEndStopBanner('refusal'), { key: 'turn-end.verweigert', raw: 'refusal' });
    for (const v of ['end_turn', 'tool_use', 'pause_turn', 'compaction', 'stop_sequence', '', null, undefined, 'nonsense']) {
      assert.equal(turnEndStopBanner(v), null, JSON.stringify(v) + ' must not raise a banner');
    }
  });
});

describe('turn-end — permission_denials are information, not a verdict', () => {
  it('a SUCCESSFUL turn with denied tools stays info, never error', () => {
    const i = turnEndInfo({ ...OK, permission_denials: [
      { tool_name: 'Bash', tool_use_id: 't1', tool_input: {} },
      { tool_name: 'Write', tool_use_id: 't2', tool_input: {} },
    ] }, null);
    assert.deepEqual(keys(i), ['turn-end.werkzeugeAbgelehnt']);
    assert.equal(i.parts[0].num, 2);
    assert.equal(i.parts[0].raw, 'Bash, Write', 'without the names the reader has to hunt the transcript');
    assert.equal(i.severity, 'info', 'a careful „nein danke" must not paint the turn red');
  });
  it('the same tool denied twice is listed once, and the count stays the real one', () => {
    const i = turnEndInfo({ ...OK, permission_denials: [
      { tool_name: 'Bash' }, { tool_name: 'Bash' }, { tool_name: 'Bash' },
    ] }, null);
    assert.equal(i.parts[0].num, 3);
    assert.equal(i.parts[0].raw, 'Bash');
  });
  it('a denied loop cannot eat the footer, and nameless denials still count', () => {
    const many = Array.from({ length: 9 }, (_, n) => ({ tool_name: 'T' + n }));
    assert.equal(turnEndInfo({ ...OK, permission_denials: many }, null).parts[0].raw, 'T0, T1, T2');
    const nameless = turnEndInfo({ ...OK, permission_denials: [{}, {}] }, null);
    assert.equal(nameless.parts[0].num, 2);
    assert.equal(nameless.parts[0].raw, undefined);
  });
  it('an error turn keeps the error on the REASON and the denial as info beside it', () => {
    const i = turnEndInfo({ ...ERR, permission_denials: [{ tool_name: 'Bash' }] }, null);
    assert.deepEqual(keys(i), ['turn-end.grundAusfuehrung', 'turn-end.werkzeugeAbgelehnt']);
    assert.equal(part(i, 'turn-end.werkzeugeAbgelehnt').sev, 'info');
    assert.equal(i.severity, 'error');
  });
});

// subagent_stats are the SESSION's running totals ("read the latest result rather than summing across
// results"). Reporting the absolute value would print the same refusal under every later turn.
describe('turn-end — refused agents: the DELTA, not the running total', () => {
  it('the first result reports what the counters say', () => {
    const i = turnEndInfo({ ...OK, subagent_stats: stats({ budget: 2, depth_limit: 0, concurrency_limit: 1 }) }, null);
    assert.deepEqual(keys(i), ['turn-end.agentenAbgelehntBudget', 'turn-end.agentenAbgelehntParallel']);
    assert.equal(part(i, 'turn-end.agentenAbgelehntBudget').num, 2);
    assert.equal(part(i, 'turn-end.agentenAbgelehntParallel').num, 1);
    assert.equal(i.severity, 'info', 'agents that were never started are an explanation, not a failure');
    assert.deepEqual(i.refusedSeen, { budget: 2, concurrency_limit: 1, depth_limit: 0 });
  });
  it('an UNCHANGED total reports nothing on the next turn', () => {
    const first = turnEndInfo({ ...OK, subagent_stats: stats({ budget: 2, depth_limit: 0, concurrency_limit: 0 }) }, null);
    const second = turnEndInfo({ ...OK, subagent_stats: stats({ budget: 2, depth_limit: 0, concurrency_limit: 0 }) }, first.refusedSeen);
    assert.deepEqual(second.parts, [], 'a refusal from an earlier turn must not be re-reported here');
    assert.equal(second.severity, '');
  });
  it('a GROWN total reports only what this turn added', () => {
    const second = turnEndInfo({ ...OK, subagent_stats: stats({ budget: 5, depth_limit: 1, concurrency_limit: 0 }) },
      { budget: 2, depth_limit: 0, concurrency_limit: 0 });
    assert.equal(part(second, 'turn-end.agentenAbgelehntBudget').num, 3);
    assert.equal(part(second, 'turn-end.agentenAbgelehntTiefe').num, 1);
  });
  it('a /clear zeroes the counters: report nothing, adopt the lower baseline', () => {
    const i = turnEndInfo({ ...OK, subagent_stats: stats({ budget: 0, depth_limit: 0, concurrency_limit: 0 }) }, { budget: 4 });
    assert.deepEqual(i.parts, [], 'a negative delta must not become "-4"');
    assert.deepEqual(i.refusedSeen, { budget: 0, concurrency_limit: 0, depth_limit: 0 });
  });
  it('a frame WITHOUT subagent_stats holds the baseline instead of resetting it', () => {
    // „Omitted by hosts without a local Agent tool and on crash/startup-error results" — resetting to 0
    // here would make the next frame that does carry stats report the whole session again
    const i = turnEndInfo(OK, { budget: 3, depth_limit: 0, concurrency_limit: 0 });
    assert.deepEqual(i.parts, []);
    assert.equal(i.refusedSeen.budget, 3);
    const next = turnEndInfo({ ...OK, subagent_stats: stats({ budget: 3, depth_limit: 0, concurrency_limit: 0 }) }, i.refusedSeen);
    assert.deepEqual(next.parts, []);
  });
  it('a broken or missing refused block changes nothing', () => {
    for (const v of [null, undefined, 'nope', 42]) {
      const i = turnEndInfo({ ...OK, subagent_stats: { spawned: 1, refused: v } }, null);
      assert.deepEqual(i.parts, [], JSON.stringify(v));
    }
  });
});

describe('turn-end — terminal_reason: what the CLI itself calls an error', () => {
  it('a user/host abort is an INFO, never a failure', () => {
    for (const v of ['aborted_streaming', 'aborted_tools']) {
      const i = turnEndInfo({ ...OK, stop_reason: null, terminal_reason: v }, null);
      assert.deepEqual(keys(i), ['turn-end.endeAbgebrochen']);
      assert.equal(i.severity, 'info', v + ' is a stop, not a defect — painting it red would be a lie');
    }
    assert.deepEqual(keys(turnEndInfo({ ...OK, terminal_reason: 'background_requested' }, null)), ['turn-end.endeHintergrund']);
  });

  // …and now the frame the CLI REALLY sends for a user cancel, which is not the one above. The shape
  // above — subtype 'success', is_error false — is the one an abort does NOT take when a tool call was
  // open, and an open tool call is the normal state of a turn being stopped (this machine's corpus:
  // stop_reason tool_use 43 569 against end_turn 2 011). Built from the binary: the result builder
  // reaches `{subtype:'error_during_execution', is_error:true, errors:[…]}` through a branch whose only
  // trigger is `aborted_streaming || aborted_tools`, and errors[0] there is the literal string
  // `[ede_diagnostic] result_type=… last_content_type=… stop_reason=…`.
  // Without the abort gate this read „⚠ Ausführungsfehler — [ede_diagnostic] result_type=assistant …",
  // severity 'error', red tab badge: the panel blaming the user for pressing its own Stop button, with an
  // internal log marker as the explanation.
  it('pressing Stop while a tool call is open is an INFO — even though the frame says is_error', () => {
    const abort = {
      ...ERR, terminal_reason: 'aborted_tools', stop_reason: 'tool_use',
      errors: ['[ede_diagnostic] result_type=assistant last_content_type=tool_use stop_reason=tool_use'],
    };
    const i = turnEndInfo(abort, null);
    assert.deepEqual(keys(i), ['turn-end.endeAbgebrochen'], 'the subtype must not win over the abort');
    assert.equal(i.severity, 'info', 'a user cancel may never redden the tab');
    assert.equal(i.banner, null, 'tool_use is the normal stop reason — no „answer truncated" banner');
    assert.ok(!/ede_diagnostic/.test(JSON.stringify(i)), 'an internal log marker was handed to the user as an explanation');
  });

  it('a real error keeps its subtype — the abort gate must not swallow failures', () => {
    const i = turnEndInfo({ ...ERR, terminal_reason: 'turn_setup_failed' }, null);
    assert.ok(keys(i).includes('turn-end.grundAusfuehrung'), 'only aborted_* outranks the subtype');
    assert.equal(i.severity, 'error');
    assert.equal(part(i, 'turn-end.grundAusfuehrung').text, 'Execution error', 'a real CLI sentence still comes through');
  });

  it('errors[] falls through markers to the first sentence meant for a reader', () => {
    const i = turnEndInfo({ ...ERR, errors: ['[ede_diagnostic] noise=1', '[session_crash] more', 'Reached maximum number of turns (12)'] }, null);
    assert.equal(part(i, 'turn-end.grundAusfuehrung').text, 'Reached maximum number of turns (12)');
  });

  // The API branch used to be reached by `is_error` + subtype 'success' ALONE. The binary has a second
  // producer of exactly that pair with no api_error field anywhere near it, so the panel would have said
  // „API-Fehler" about something that was not one — and the fields that would have proved it were sitting
  // unread in the same frame.
  it('„API-Fehler" is only claimed when the frame carries the evidence', () => {
    const bare = turnEndInfo({ ...OK, is_error: true, stop_reason: null }, null);
    assert.deepEqual(keys(bare), ['turn-end.grundUnbekannt'], 'no api_error field → say what we know');
    assert.equal(part(bare, 'turn-end.grundUnbekannt').raw, 'success');
    const real = turnEndInfo({ ...OK, is_error: true, stop_reason: null, api_error_status: 529, api_error_code: 'overloaded_error', terminal_reason: 'api_error' }, null);
    assert.deepEqual(keys(real), ['turn-end.grundApiFehler'], 'and the same fact is not also printed as a terminal reason');
    assert.equal(part(real, 'turn-end.grundApiFehler').raw, '529 overloaded_error');
  });

  // `tool_deferred` is synthesised in the result frame (it is not in the message-level enum), so it fell
  // into „unknown" — a claim of not knowing a word this file names itself, next to the same fact spelled
  // out properly by terminal_reason.
  it('a deferred tool is stated once, by its name', () => {
    const i = turnEndInfo({ ...OK, stop_reason: 'tool_deferred', terminal_reason: 'tool_deferred' }, null);
    assert.deepEqual(keys(i), ['turn-end.endeWerkzeugAufgeschoben']);
    assert.equal(i.severity, 'info');
  });

  it('the CLI\'s own error list is reported as an error, with the raw reason', () => {
    const i = turnEndInfo({ ...OK, is_error: true, terminal_reason: 'prompt_too_long' }, null);
    assert.equal(part(i, 'turn-end.endeFehler').raw, 'prompt_too_long');
    assert.equal(part(i, 'turn-end.endeFehler').sev, 'error');
    for (const v of ['blocking_limit', 'rapid_refill_breaker', 'image_error', 'model_error', 'api_error',
      'malformed_tool_use_exhausted', 'tool_deferred_unavailable', 'turn_setup_failed']) {
      assert.equal(part(turnEndInfo({ ...OK, terminal_reason: v }, null), 'turn-end.endeFehler').raw, v);
    }
  });
  it('an UNKNOWN terminal_reason is shown raw and NOT called an error', () => {
    const i = turnEndInfo({ ...OK, terminal_reason: 'hearth_relay_lost' }, null);
    assert.deepEqual(keys(i), ['turn-end.endeUnbekannt']);
    assert.equal(i.parts[0].raw, 'hearth_relay_lost');
    assert.equal(i.severity, 'info');
  });
  it('a reason the subtype already explained is not said twice', () => {
    const i = turnEndInfo({ ...ERR, subtype: 'error_max_budget_usd', terminal_reason: 'budget_exhausted' }, null);
    assert.deepEqual(keys(i), ['turn-end.grundBudget']);
    const t2 = turnEndInfo({ ...ERR, subtype: 'error_max_turns', num_turns: 9, terminal_reason: 'max_turns' }, null);
    assert.deepEqual(keys(t2), ['turn-end.grundMaxTurns']);
  });
  it('…but the SAME reason without that subtype is still reported', () => {
    // a success result that nevertheless ran into the budget: the only place this would be visible
    assert.deepEqual(keys(turnEndInfo({ ...OK, terminal_reason: 'budget_exhausted' }, null)), ['turn-end.endeFehler']);
    assert.deepEqual(keys(turnEndInfo({ ...OK, terminal_reason: 'max_turns' }, null)), ['turn-end.endeMaxTurns']);
  });
  it('a hook stop and a deferred tool are named, not swallowed', () => {
    assert.deepEqual(keys(turnEndInfo({ ...OK, terminal_reason: 'stop_hook_prevented' }, null)), ['turn-end.endeHook']);
    assert.deepEqual(keys(turnEndInfo({ ...OK, terminal_reason: 'hook_stopped' }, null)), ['turn-end.endeHook']);
    assert.deepEqual(keys(turnEndInfo({ ...OK, terminal_reason: 'tool_deferred' }, null)), ['turn-end.endeWerkzeugAufgeschoben']);
  });
});

describe('turn-end — queued_turn_count is deliberately not shown', () => {
  it('a pending queue adds no line (the panel owns and shows its own queue)', () => {
    assert.deepEqual(turnEndInfo({ ...OK, queued_turn_count: 3 }, null).parts, []);
  });
});

describe('turn-end — a frame that went wrong in several ways reports all of it, once each', () => {
  it('reason + truncation + denial + refused agents + terminal reason', () => {
    const i = turnEndInfo({
      ...OK, subtype: 'error_during_execution', is_error: true, errors: ['Execution error'],
      stop_reason: 'max_tokens', num_turns: 4,
      permission_denials: [{ tool_name: 'Bash' }],
      subagent_stats: stats({ budget: 1, depth_limit: 0, concurrency_limit: 0 }),
      terminal_reason: 'model_error',
    }, null);
    assert.deepEqual(keys(i), [
      'turn-end.grundAusfuehrung', 'turn-end.antwortUnvollstaendig', 'turn-end.werkzeugeAbgelehnt',
      'turn-end.agentenAbgelehntBudget', 'turn-end.endeFehler',
    ]);
    assert.equal(i.severity, 'error');
    assert.deepEqual(i.banner, { key: 'turn-end.abgeschnittenAusgabelimit', raw: 'max_tokens' });
  });
});

// The tab badge has to agree with the footer line. It did not: the call site added `|| ev.is_error`, so a
// user's Stop (which arrives WITH is_error) painted the badge red while the line beside it said
// „abgebrochen". The verdict was moved into turn-end.js for exactly this reason — as a condition inside a
// DOM function it was the one decision this suite could not reach.
describe('turn-end — the tab badge says the same thing as the line', () => {
  it('an abort does not redden the tab, although the frame says is_error', () => {
    const abort = { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', stop_reason: 'tool_use', errors: ['[ede_diagnostic] x'], permission_denials: [] };
    const info = turnEndInfo(abort, null);
    assert.equal(info.severity, 'info');
    assert.equal(turnEndBadge(info, abort), 'done', 'the badge must follow the verdict, not is_error');
  });

  it('a truncated answer DOES redden it, although the frame says no error', () => {
    const cut = { type: 'result', subtype: 'success', is_error: false, stop_reason: 'max_tokens', permission_denials: [] };
    const info = turnEndInfo(cut, null);
    assert.equal(info.severity, 'error');
    assert.equal(turnEndBadge(info, cut), 'error', 'is_error false is not the same as „fertig"');
  });

  it('a denied tool on a successful turn stays „fertig"', () => {
    const den = { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', permission_denials: [{ tool_name: 'Bash' }] };
    assert.equal(turnEndBadge(turnEndInfo(den, null), den), 'done');
  });

  // …and without the module there is no verdict to follow, so the old behaviour has to survive — otherwise
  // a half-loaded panel would stop reporting failures at all.
  it('with no verdict at all it falls back to is_error', () => {
    assert.equal(turnEndBadge(null, { is_error: true }), 'error');
    assert.equal(turnEndBadge(null, { is_error: false }), 'done');
    assert.equal(turnEndBadge(undefined, {}), 'done');
  });
});

// CHAT-FLOW-3 — the other edge: which frame shows that the CLI began a turn BY ITSELF. Every `false` row is a
// way to open a turn no `result` would close (see the comment on turnOpenedByCli).
describe('turnOpenedByCli — a turn the CLI starts by itself (CHAT-FLOW-3)', () => {
  const { turnOpenedByCli } = require('../public/js/turn-end');
  const IDLE = { streaming: false, exited: false, synthetic: false };
  const se = (type, extra) => Object.assign({ type: 'stream_event', event: { type } }, extra);
  const asst = (extra) => Object.assign({ type: 'assistant', message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'x' }] } }, extra);
  const rows = [
    ['message_start of the main thread', se('message_start'), IDLE, true],
    ['assistant frame of the main thread', asst(), IDLE, true],
    ['…but not while a turn already runs', asst(), { streaming: true }, false],
    ['…not after the process exited', asst(), { exited: true }, false],
    ['…not a message the CLI wrote itself (<synthetic>)', asst(), { synthetic: true }, false],
    ['…not a sub-agent frame (parent_tool_use_id)', asst({ parent_tool_use_id: 'toolu_1' }), IDLE, false],
    ['…nor in the camelCase spelling', se('message_start', { parentToolUseId: 'toolu_1' }), IDLE, false],
    ['a straggling message_stop after a result', se('message_stop'), IDLE, false],
    ['a straggling message_delta', se('message_delta'), IDLE, false],
    ['a content_block_delta', se('content_block_delta'), IDLE, false],
    ['a stream_event without event', { type: 'stream_event' }, IDLE, false],
    ['system/init', { type: 'system', subtype: 'init' }, IDLE, false],
    ['session_state_changed running', { type: 'system', subtype: 'session_state_changed', state: 'running' }, IDLE, false],
    ['a user frame', { type: 'user', message: { content: [] } }, IDLE, false],
    ['a result', { type: 'result', subtype: 'success' }, IDLE, false],
    ['no frame', null, IDLE, false],
    ['a string', 'assistant', IDLE, false],
    ['no state', asst(), null, false],
  ];
  for (const [name, ev, s, want] of rows) it(name + ' → ' + want, () => assert.equal(turnOpenedByCli(ev, s), want));
});
