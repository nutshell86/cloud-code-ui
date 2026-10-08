'use strict';
// Shared context-window arithmetic — browser (classic script) AND Node (require'd by the test suite).
// Keep this file dependency-free and side-effect-free (open-points.js / pure.js spirit); no t()/DOM here.
//
// WHY this exists as its own module: the gauge above the composer showed two numbers that could not both
// be true — a tab on „Opus 5 (1M)" reading „Kontext 250 % · 500,8K / 200,0K", i.e. the window of a model
// it was not running. Two rounds of patching did not converge, because the window had FIVE independent
// sources, each with its own freshness rule, and the reviewers kept finding new COMBINATIONS rather than
// new bugs: the CLI measurement from GET /api/chat/:id/context · this session's `result.modelUsage` · the
// learned localStorage store · the name guess · the „[1m]" spelling in the selector.
//
// So there is now exactly ONE decision — `ctxDecide` — and it answers, for a tab: which model is really
// running, which window, from which source, and may any of it be called MEASURED. Everything that paints
// or persists goes through it, and test/ctx.test.js pins it with one TABLE: one row per (source
// availability × variant case), each asserting the whole returned record. A newly discovered path has to
// be expressible as a ROW — a missing row is then a visible gap in the table instead of a bug in the field.
//
// The five properties the table exists to pin:
//  1. The MODEL is resolved first, and only then the window question is asked. „Default" is what bypassed
//     the wide-variant refusal before: its menu value is the empty string, so no spelling carries „[1m]"
//     even when the session really runs a 1M model — the menu entry's `resolves` field is the only thing
//     that says so, and it is consulted here (ctxResolveModel). When even that is empty, the variant is
//     UNKNOWN rather than „not wide" (`varUnknown`): the variant-keyed sources then abstain and the line
//     paints „–", because the alternative is a name-table 200 000 (today: haiku-4-5) over a 1M session — i.e. „250 %".
//  2. Tokens and window each carry their OWN source and freshness. „measured" was set from the token count
//     alone, so a measured token count next to a GUESSED window printed no „≈" and claimed to be measured.
//     A route answer with `totalTokens` but no `maxTokens` is a token measurement and not a window one.
//  3. A variant never inherits across the wide boundary: a „[1m]" spelling may not take a non-wide number
//     and a non-wide spelling may not take a wide one — not from the learned store, not from the name
//     table, not from `modelUsage`. „Unknown" is an acceptable answer and is painted as „–".
//     The ONE ungated source is the route measurement: it is the CLI answering about THIS session's
//     context right now, so it is never an inheritance — if it contradicts the variant, that is reported
//     as a conflict (`conflict`), not silently replaced by something more plausible.
//  4. Freshness is compared by EQUALITY, never by „newer than": the old comparison used `ctxSeq`, which
//     the /clear branch and ctxForgetModel reset to 0, so a measurement captured at seq 5 outranked the
//     next 5 frames of the NEW model. A generation (`_ctxGen`) and a monotonic stamp (`ctxStamp`) are both
//     compared with `===`, so a counter that is reset can only ever make them DIFFER — which discards the
//     measurement and falls through to the derived number. That is the safe direction, and it holds no
//     matter what resets what.
//  5. A DERIVED window is FALSIFIABLE, and the frames falsify it. One `assistant` frame is one API call, and
//     an accepted call cannot have carried more tokens than the window holds — so „500 800 / 200 000" is not
//     a context that is 250 % full, it is a window that is wrong. Any derived window the observed count
//     exceeds is therefore dropped to „–" and marked (`conflict: 'over-window'`), the token count stays (it
//     is the evidence), and the probe is re-armed because the CLI is the only source that can replace it.
//     That is what makes the line self-correcting for a variant which changed where nothing in the tab can
//     see it — a „/model opus[1m]" typed into the composer, for instance, which the CLI accepts without
//     applyLiveModel ever running — without that path having to be enumerated anywhere.
//     A refutation is recorded as a FACT, not chased through the holders of the number: the record carries
//     `refuted` = { key, below }, and that becomes a FLOOR for the variant (ctxFloorMerge) which every DERIVED
//     source has to pass — the name constant, the learned store, this session's result, `ctxReported`.
//     (`ctxMeasured` and a fresh answer from the CLI were on that list too, until 2026-10-05: see 6 below — a
//     measurement now outranks every floor and refutes the ones above it.) Deleting the disproved entries
//     stays (hygiene), but it cannot be the guarantee: CTX_NAME_WINDOWS is a module constant, and the CLI
//     re-files `contextWindow` in every single result. See „THE FLOOR" below for why that bound cannot
//     over-reach.
//     And because this refutation is one-sided — it can only ever catch a window that is too SMALL, since a
//     too-large one is never reached before the session auto-compacts — a window that has not been MEASURED
//     stays „in doubt" (ctxWindowInDoubt) until the CLI has confirmed it once. The cost of that is stated there.
//
// Measured against the live CLI — 1 and 2 by a probe on 2026-09-10 (one turn with one tool call), 3 and 4
// by control requests on 2026-10-02:
//
//  1. `result.usage` is the SUM OVER THE WHOLE TURN, not the state of the context at the end of it.
//     The probe's three assistant frames carried cache_creation 38 955 / 38 955 / 3 306 and the result
//     reported `cache_creation_input_tokens: 42 261` — 38 955 + 3 306 added up. What the context really
//     held at the last call was that call's input side (2 + 38 955 + 3 306 ≈ 42 k), while the summed
//     result usage said ≈ 81 k. The error grows with the number of tool calls: every extra call adds its
//     own cache READ of the same conversation again, so a 20-step turn reported a context several times
//     the size of the conversation. → the context is read from the `assistant` frames (one frame = one
//     API call = one context), and the summed result usage is only a last-resort fallback.
//
//  2. The window was guessed from the model NAME (`/1m/`) — and that guess was wrong for exactly the
//     sessions this panel runs. The `[1m]` suffix only ever lives on the SELECTOR value ("opus[1m]", or,
//     for „Default", on the entry's `resolves`); the `assistant` frames name the concrete model
//     (`claude-opus-5`). So the regex missed and every 1M session was measured against 200 000: the
//     transcripts in this project reach 999 651 tokens, i.e. the gauge sat at „Kontext 100 % ·
//     561 195 / 200 000" — a label that contradicts its own numbers.
//
//  3. The window outlived its MODEL. It was written only on `result` and preferred over everything else,
//     and no model switch invalidated it — so a tab switched from a 1M model to a 200 K one went on
//     measuring against 1 000 000, and the other direction produced the reported „250 % · 500,8K /
//     200,0K" on a single turn. The token side was wrong too: the context a model starts with depends on
//     the model (measured empty-session totals: 34 021 on sonnet-5, 18 529 on opus-5 — system prompt and
//     tool definitions differ), so after a switch BOTH numbers belong to the model that is no longer
//     answering.
//
//  4. There was no way to simply ASK. Measured 2026-10-02 (control requests only, no model call):
//     `get_context_usage` answers while the session is IDLE — before the first turn and before the `init`
//     frame — and there is NO `contextWindow` field in that answer. `set_model` is live, and the very next
//     `get_context_usage` already reports the NEW window (1 000 000 → 200 000). `detail: 'summary'` is
//     ignored, which is why this is asked at the turn BOUNDARIES and never polled during a turn — mid-turn
//     the frame arithmetic moves the display.
//     CAVEAT on every window this file hands out: it is what the CLI REPORTS from its own model table,
//     not a promise from the gateway (the real inference call for Opus 5.5 is a 403 for this role).
//
//  5. RE-MEASURED 2026-10-03 (free, CLI 2.1.288 — C:/Users/you/ccui-ctxprobe/ctx-probe.js, raw answer
//     ctx-probe-result.json, three reads of one session). Three corrections to the sentences above, and
//     they are the ones PR-11 is built on:
//      · the answer carries SEVENTEEN fields, not seven: beside the ones named above also `model`,
//        `memoryFiles`, `mcpTools`, `agents`, `slashCommands`, `skills`, `autoCompactThreshold`,
//        `isAutoCompactEnabled`, `messageBreakdown`, `apiUsage`. It is 38 353 bytes cold and 40 479 at the
//        third read of the SAME session — it grows while MCP servers come up. „~8 KB" was never measured.
//      · `detail: 'summary'` is confirmed ineffective, now with a sharper proof than „identical payload":
//        identical key set, identical `totalTokens` (21 667), and the single difference (mcpTools 119 → 138
//        entries) belongs to an MCP server that connected in between.
//      · `maxTokens === rawMaxTokens` is not a coincidence of the measurements but the SAME EXPRESSION:
//        the binary builds the answer as `rawMaxTokens: ze` next to `maxTokens: ze` (@213344157). So
//        ctxSourceCeiling's `Math.max(value, raw)` is provably a no-op in this build, and the table row
//        that exercises a context BETWEEN the two (d3) describes a state claude.exe 2.1.288 cannot produce.
//        Kept anyway, and this is a deliberate choice rather than an oversight: one build's identity is not
//        a promise about the next, the branch costs one `Math.max`, and the alternative — deleting a
//        defensive bound because today's binary happens not to need it — is the mirror of the error this
//        file exists for. What changes is only that the row is now documented as hypothetical.
//      · and the numbers in 3 above („34 021 on sonnet-5 vs 18 529 on opus-5") are NOT in any kept raw
//        recording, and this run contradicts their shape: opus-5 answered totalTokens 21 667 in a
//        1 000 000 window here, not 18 529 in 200 000. `set_model claude-sonnet-5` failed with „API error:
//        503", so the per-model comparison itself could not be redone. The CLAIM the code rests on — both
//        halves move with the model — is unaffected and is what the fixture reproduces; the two concrete
//        figures should be read as illustrations, not as measurements. What IS measured: the total moves
//        WITHIN one session too, so no number here may be treated as a constant of the model.
//
//  6. AN ESTIMATE IS NO PROOF (2026-10-05 — Julian's tab read „Kontext … 580K / –" over a session the CLI
//     itself measured at maxTokens 1 000 000). Its console dump held `cc_ctx_floors` =
//     {"claude-opus-5-5[1m]": 1 089 676}: a floor ABOVE the window, larger than any single call in any
//     transcript (maximum of that session 628 766, of the Demoprojekt session 999 651). It came from (8),
//     which counted `get_context_usage.totalTokens` as „one accepted call" — but `totalTokens` is the CLI's
//     ESTIMATE of the NEXT request, and right before an auto-compaction (or a prompt-too-long) it may sit
//     above the window. Filed once, the bound refused every source for that variant forever, the CLI's own
//     `maxTokens` included, with no provenance and no expiry. Four rules since:
//      · a floor is filed only from the ONE count that is an accepted call — a main-thread `assistant`
//        frame, not summed, refuting a DERIVED window (ctxDecide (8)); never from `totalTokens`;
//      · a floor carries its provenance, `{ below, src: 'frame', at }`; a bare number is a LEGACY entry
//        nobody can vouch for and reads as no floor at all (ctxFloorAt) — ctxFloorStoreClean drops it;
//      · a MEASURED window is never gated by a floor: it is the CLI talking about this session now. A floor
//        above it is refuted by it and removed once the measurement is the younger of the two (`healed`) —
//        and only while nothing this tab has SEEN contradicts the measurement itself (a frame of this
//        generation above it): a measurement the tab's own evidence beats cannot refute anything;
//      · and an estimate above the window of the SAME answer proves nothing in either direction. It files no
//        floor and is not remembered, but it is not printed as a ratio either: the first version of this round
//        did („Kontext 109 % · 1.089.676 / 1.000.000", the CLI's own pair), and the counter-check showed the
//        same exemption printing „250 % · 500,8K / 200,0K" — without a ⚠ — for a live switch from a 1M model
//        onto Haiku, whose first answer is exactly that pair. The sentence this file exists to stop may not be
//        printable from ANY pair, so the window goes to „–" with a ⚠ whose tooltip says it was an estimate.
//     Re-measured the same day (free: get_context_usage without a user message, CLI 2.1.289 installed that
//     morning): bare `eu.anthropic.claude-opus-5-5`, its „[1m]" spelling, first-party `claude-opus-5-5` and
//     bare `eu.anthropic.claude-opus-5` ALL answer maxTokens 1 000 000 — so the bare opus-5 had 200 000 under
//     2.1.288 and 1 000 000 under 2.1.289. A window is a property of model AND CLI build, which is the
//     strongest argument yet for letting the measurement win over everything this file derives.
//     THE RESIDUAL CASE of that sentence, stated rather than hidden: neither a floor nor a measurement carries
//     the CLI build. A tab whose process still runs an OLDER build (one that measures the bare opus-5 at
//     200 000) can therefore heal a floor that a tab on a NEWER build proved honestly. What that costs is
//     bounded: the floor only ever judges DERIVED windows, so the next fresh tab of that variant shows the name
//     table's number until its own first measurement lands (seconds; the window stays in doubt and is asked at
//     every boundary). Pinning floors to a build would need the version on every frame path; not done here.

var CTX_WIDE_WINDOW = 1000000;    // the „(1M)" a „[1m]" spelling and a „(1M)" menu label promise

// The windows the CLI really reported, per model — the name „guess" reduced to what was actually measured.
// MEASURED 2026-10-06 under CLI 2.1.291, free (get_context_usage without a user message, no model turn; raw
// answers in C:/Users/you/ccui-impl-kontext/ctxprobe/messung-2026-10-06.txt): the bare `eu.anthropic.`
// spellings of opus-5, opus-5-5, sonnet-5, sonnet-5-5 and opus-4-8 all answer maxTokens 1 000 000, and
// haiku-4-5-20251001-v1:0 answers 200 000 — maxTokens === rawMaxTokens in every one of the six answers.
// A WINDOW IS A PROPERTY OF THE CLI BUILD, not of the model alone: on 02.10. (CLI 2.1.286, lib/models.js) the bare
// opus-5 measured 200 000 and this table said so; the 03.10. probe (2.1.288, first-party spelling, docs/messung-
// 2026-10-03.md) already got 1 000 000 — whether the build or the spelling made that difference is not settled;
// under 2.1.289 (05.10., see 6 at the top) and 2.1.291 the eu.anthropic. spelling answers 1 000 000. So this table is the LAST resort and nothing more: the CLI's own
// measurement of the session (ctxDecide (2)), the window this session's `result` reports (3) and a learned
// window (cc_ctx_windows) all outrank it — the table only speaks when none of those offers a number this
// decision accepts, and a window only the table vouches for stays in doubt (ctxWindowInDoubt) until the CLI has
// measured it. A table that is one build behind is therefore wrong for the seconds before the first
// measurement, not for a session — on any CLI that has the context control at all (ctxProbeUnsupported).
// Why a table at all, instead of nothing: the old blanket fallback of 200 000 was not a guess but a lie for the
// model it mattered for — `claude-sonnet-5` measures 1 000 000 WITHOUT any „[1m]" in its name, so the fallback
// printed „/ 200,0K" over a 1M session and produced the reported „250 %" line all on its own, with no race and
// no stale state involved. A model that is not in here and carries no „[1m]" is UNKNOWN until the CLI says
// otherwise — the probe answers within seconds, and „–" is honest in between.
// Keyed by variant key (ctxVariantKey — ctxNormModel's reduction: no gateway prefix, no -vN, no date), so a
// future wide spelling with a different window can be stated. haiku-4-5 is the ONE row below 1M since this
// measurement, which is why test/ctx.test.js uses it wherever a row needs this table to offer a number that a
// proven floor refuses.
var CTX_NAME_WINDOWS = {
  'claude-opus-5': 1000000,
  'claude-opus-5-5': 1000000,
  'claude-sonnet-5': 1000000,
  'claude-sonnet-5-5': 1000000,
  'claude-opus-4-8': 1000000,
  'claude-haiku-4-5': 200000,
};
// …and the rule for the wide spellings, which needs no table: „[1m]" is the CLI's own request for the 1M
// beta, and all three wide spellings measured on 2026-10-02 answered 1 000 000 (opus-5[1m], opus-5-5[1m],
// sonnet-5[1m]). A wide spelling therefore guesses CTX_WIDE_WINDOW and never a smaller number.

// The same normalization the rest of the panel uses on model ids (chat-status.js normModelId,
// lib/models.js bedrockBase): drop the "[1m]" suffix, the gateway's provider prefix, a Bedrock -vN and
// a trailing -YYYYMMDD date, so the key `claude-haiku-4-5-20251001` from modelUsage matches the
// `claude-haiku-4-5` a frame reported — and `eu.anthropic.claude-opus-5-v1:0` from a Bedrock selector
// matches both. The prefix and the -vN were MISSING here, which is why on Bedrock no modelUsage key
// ever matched the tab's model and the window came from the token-weight fallback below instead.
function ctxNormModel(m) {
  return String(m == null ? '' : m)
    .replace(/\[1m\]/i, '')
    .replace(/^[a-z]{2,6}(-[a-z]+)?\.(anthropic|bedrock)\./i, '')
    .replace(/-v\d+(:\d+)?$/i, '')
    .replace(/-\d{8}$/, '')
    .toLowerCase();
}
// Does this spelling ASK for the wide variant? Only a selector value or a menu entry's `resolves` can
// (the frames never carry the suffix), and it is the one property that may never be inherited.
function ctxIsWide(m) { return /\[1m\]/i.test(String(m == null ? '' : m)); }
// Store/table key for ONE variant. The reduction above deliberately drops „[1m]", because one model is
// spelled several ways across frames, selectors and modelUsage keys — but that suffix is the one
// difference that changes the window itself (measured 02.10. under CLI 2.1.286: `eu.anthropic.claude-opus-5`
// 200 000 vs `eu.anthropic.claude-opus-5[1m]` 1 000 000), so a store that ignored it let a 200 K session
// overwrite what a 1M session had learned about „the same" model. (Under 2.1.291 both spellings of opus-5
// answer 1 000 000 — the key keeps the variants apart anyway, because the next build may part them again.)
function ctxVariantKey(m) {
  var id = ctxNormModel(m);
  return id ? id + (ctxIsWide(m) ? '[1m]' : '') : '';
}
// CTX-8 — „<synthetic>" is not a model. The CLI uses that name for messages it composed itself (an error
// text, a cancellation notice), and adopting it as the tab's model made the status strip, the tab glyph
// and the per-turn price name a model that does not exist — and it would have invalidated the window of
// the model that really is answering. Any `<…>` name is treated the same: the brackets are the CLI's
// marker for „not a real model id".
function ctxSyntheticModel(m) { return /^<.*>$/.test(String(m == null ? '' : m)); }

// ---------------------------------------------------------------------------------------------------
// 1. WHICH MODEL — resolved before the window question is asked
// ---------------------------------------------------------------------------------------------------
// A tab is named by up to THREE strings, and they say different things:
//   · `reported`  — the id the `assistant`/`init` frames carry. This is who is ANSWERING, so it decides
//                   the identity. It never carries „[1m]".
//   · `sel`       — the raw selector value, the one string that CAN carry „[1m]"… except for „Default",
//                   whose value is the empty string.
//   · `resolves`  — the concrete model the selected menu entry stands for (lib/models.js). For „Default"
//                   on Bedrock this is settings.json's `model`, suffix and all — which is why „Default"
//                   used to bypass the whole wide-variant refusal: nothing else in the tab says 1M.
// The wide flag only carries over when the selector still names the model that is RUNNING: on a CLI-side
// fallback it names somebody else, and „[1m]" said about another model is no evidence about this one.
// Returns { id, key, wide, varUnknown, src } — `src` names which of the three decided the identity, '' for
// none; `varUnknown` says that NOTHING in this tab is about this model's variant (see below).
function ctxResolveModel(parts) {
  var p = parts || {};
  var rep = String(p.reported == null ? '' : p.reported);
  if (ctxSyntheticModel(rep)) rep = '';            // the CLI wrote that message, no model did
  var repId = ctxNormModel(rep);
  var res = String(p.resolves == null ? '' : p.resolves);
  var sel = String(p.sel == null ? '' : p.sel);
  var resId = ctxNormModel(res);
  var selId = resId || ctxNormModel(sel);          // what the selected entry stands for
  var id = repId || selId;
  var wide = !!(id && selId === id && (ctxIsWide(sel) || ctxIsWide(res)));
  // „not wide" and „nobody said" are DIFFERENT answers, and conflating them is the root cause of the
  // reported line. Only a string that is about THIS model can carry „[1m]" — the selector, or its menu
  // entry's `resolves`. When the frames name the model and neither of those two is about it, nothing in
  // this tab says which variant is running: „Default" whose menu entry has no `resolves` (lib/models.js
  // used to hardcode ''), and the CLI-side fallback where the selector names somebody else. The
  // variant-KEYED sources (the learned store, the name table) then have no answer, and „–" is the honest
  // one — guessing the bare row there is what measured a real 1M session against 200 000 and printed
  // „Kontext 250 % · 500,8K / 200,0K". The sources that describe THIS session by measurement (the route
  // answer, this session's own `modelUsage`) are unaffected: they do not need to know the spelling.
  var varUnknown = !!(id && selId !== id);
  // …and the third way nothing in the tab can say it: a „/model X" typed into the composer that the CLI has not
  // confirmed yet (`pending`, chat-composer.js → tab._modelPending). Until a frame names the model, the selector
  // describes the session BEFORE the switch, and a window learned or adopted under its key in that gap is
  // filed for a variant that may no longer be running — the shape of „claude-opus-5-5: 1 000 000" under a
  // bare key. Same answer as the other two: the variant-keyed sources abstain and nothing is filed.
  if (id && p.pending && String(p.pending) !== sel) { varUnknown = true; wide = false; }
  return {
    id: id,
    key: id ? id + (wide ? '[1m]' : '') : '',
    wide: wide,
    varUnknown: varUnknown,
    src: repId ? 'frame' : (resId ? 'resolves' : (selId ? 'sel' : '')),
  };
}

// ---------------------------------------------------------------------------------------------------
// 2. THE PIECES — each source of a number, with the variant gate applied the same way everywhere
// ---------------------------------------------------------------------------------------------------
// The context ONE API call carried: its whole input side. Cached tokens are part of the context — they
// are only billed differently — so all three input counters belong in the sum. Output is NOT: it is in
// the context of the NEXT call, which reports it as input again.
function ctxTokensOfFrame(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  var n = (Number(usage.input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0)
    + (Number(usage.cache_creation_input_tokens) || 0);
  return n > 0 ? n : 0;
}
function ctxEntryWindow(e) { return (e && typeof e === 'object') ? (Number(e.contextWindow) || 0) : 0; }
// The input side one modelUsage entry has accumulated. Cumulative over the SESSION, not over the turn —
// that is what makes it useless as a „who answered just now" signal on its own (see the delta below).
function ctxUsageTokens(e) {
  if (!e || typeof e !== 'object') return 0;
  return (Number(e.inputTokens) || 0) + (Number(e.cacheReadInputTokens) || 0)
    + (Number(e.cacheCreationInputTokens) || 0);
}
// Can a number reported under a variant-AGNOSTIC spelling be this model's window? The wide boundary is
// crossed in two directions and both are refused, but by two different tests, because the two sources spell
// variants differently:
//   · where the spelling CARRIES the variant (the learned store, and a modelUsage object that holds both
//     variants of one model as separate keys) the test is the key itself — exact match, no fallback either
//     way. That is the reported „250 % · 500,8K / 200,0K": a „[1m]" tab inheriting the model-wide 200 000.
//   · where it does not (the CLI's own `result.modelUsage` keys never carry „[1m]", measured) the number is
//     all there is: a session that asked for 1M can only be described by a 1M number, so a smaller one is
//     a contradiction and no evidence about this variant.
// A non-wide model taking a big number is NOT a crossing: `claude-sonnet-5` measures 1 000 000 without any
// suffix, so there is deliberately no upper bound on the non-wide side.
function ctxVariantFits(model, win) {
  var m = model || {};
  if (!m.key) return false;
  var w = Number(win) || 0;
  if (w <= 0) return false;
  return m.wide ? w >= CTX_WIDE_WINDOW : true;
}
// The window the CLI reported in THIS session's `result.modelUsage`, for the model that served the turn.
// `modelUsage` is keyed by model id and holds SEVERAL models — the main one plus small side-calls (title
// generation runs on haiku, 200 000, while the conversation runs on 1 000 000). Picking the wrong entry is
// the same class of error as guessing, and that is what happened on Bedrock: nothing matched by name
// (ctxNormModel stripped neither the provider prefix nor the -vN), so every tab fell through to the token
// weight — and since those counters are CUMULATIVE, enough haiku side-calls eventually made the 200 000
// entry the heaviest one and the conversation's window flipped to a fifth of its real size.
// Order: the keys that name the resolved model — exactly when the object distinguishes the variants (it
// then holds one key per variant and matching loosely would hand a 1M session the 200 K entry), by bare id
// otherwise, because a variant-agnostic key in THIS session's own result describes THIS session · and only
// then the token weight, as the DELTA to the previous result, i.e. who carried THIS turn rather than who
// has carried the most since the session began.
// Returns { win, refused }: the window, 0 when nothing usable or nothing variant-compatible is there — the
// caller falls back, this function never invents a window. `refused` is the one case that must not be
// swallowed: a window reported for THIS model that the wide gate threw out (the session asked for 1M and
// the CLI answered with less). Falling through to the name table would then print 1 000 000 over a session
// the CLI just said is smaller — the same „window of a model it is not running" in the other direction —
// so ctxDecide turns it into a visible conflict instead.
// (No `canonicalModel` lookup any more: no CLI answer in any measurement or fixture outside this repo's own
// code ever carried that field.)
function ctxWindowFromUsage(modelUsage, model, prev) {
  var none = { win: 0, refused: 0 };
  if (!modelUsage || typeof modelUsage !== 'object') return none;
  var m = model || {};
  var keys = Object.keys(modelUsage).filter(function (k) { return ctxEntryWindow(modelUsage[k]) > 0; });
  if (!keys.length) return none;
  // Does this object MENTION the tab's model at all — under any spelling, with or without a window? Read over
  // ALL keys, not the window-carrying ones, because that is the whole point: an entry for this model that
  // reports no `contextWindow` is filtered out of `keys` above, so no name matches, and the token-weight
  // fallback below then handed the tab the heaviest OTHER entry — the title-generation side-call on haiku,
  // 200 000, for a conversation whose own entry simply did not state a window. One modelUsage object holding
  // the conversation's model next to a side-call is the normal shape of a turn, so nothing exotic is needed to
  // trigger it, and step (7) of ctxDecide PERSISTS what comes back as `fresh`.
  // So the fallback is gated by the same rule the rest of this function reads by: a number may only be
  // attributed to a model that nothing else in the object can be about. „The object knows this model and
  // reported no window for it" is an answer of its own — 0, i.e. „–" — and not a licence to pick a stranger's.
  // (No model identified at all needs no gate of its own: `ctxVariantFits` refuses every window for an empty
  // key, which is the single statement of that rule — pinned by its own unit test and by row x4. The second,
  // redundant `if (!m.id) return none` that used to stand here could be removed without reddening anything,
  // which is exactly what a rule stated twice looks like.)
  var namesThisModel = !!m.id && Object.keys(modelUsage).some(function (k) { return ctxNormModel(k) === m.id; });
  var distinguishes = keys.some(ctxIsWide);   // several keys for one model, told apart only by „[1m]"
  var hit = 0, refused = 0;
  for (var i = 0; m.id && i < keys.length && !hit; i++) {
    var win = ctxEntryWindow(modelUsage[keys[i]]);
    if (distinguishes) {
      // The object tells the variants apart, so the KEY is the test — but the NUMBER still has to be one
      // that variant can have. An entry spelled „…opus-5[1m]" carrying 200 000 contradicts ITSELF, and
      // accepting it on the exact-key match was the very inheritance this function refuses on every other
      // path, only spelled differently: a wide tab ending up on 200 000 → „250 % · 500,8K / 200,0K".
      // Booked as `refused`, so ctxDecide says it out loud instead of swallowing it.
      if (ctxVariantKey(keys[i]) === m.key) {
        if (ctxVariantFits(m, win)) hit = win;
        else if (win > refused) refused = win;
      }
      continue;
    }
    if (ctxNormModel(keys[i]) !== m.id) continue;
    if (ctxVariantFits(m, win)) hit = win;
    else if (win > refused) refused = win;
  }
  if (hit || refused) return { win: hit, refused: refused };
  // The object names this model (it just reported no usable window for it) → nothing here is about this tab.
  if (namesThisModel) return none;
  // nobody matched the name (an opaque inference-profile id, a model the menu does not know): fall back to
  // who carried THIS turn. Still gated — a wide session must not end up on a side-call's 200 000.
  var p = (prev && typeof prev === 'object') ? prev : {};
  var best = 0, bestTok = -1;
  keys.forEach(function (key) {
    var win = ctxEntryWindow(modelUsage[key]);
    if (distinguishes && ctxIsWide(key) !== m.wide) return;  // the object tells the variants apart
    // …and the gate that also covers „no model identified at all" (a „Default" selection whose only frame was
    // „<synthetic>", i.e. an error the CLI composed itself): ctxVariantFits refuses every window for an empty
    // key, so the heaviest-delta entry — typically the title-generation side-call on haiku, 200 000 — is not
    // adopted by a tab that is talking to nobody. The line then shows the token count over „–" (row x4).
    if (!ctxVariantFits(m, win)) return;
    var delta = ctxUsageTokens(modelUsage[key]) - ctxUsageTokens(p[key]);
    if (delta > bestTok) { bestTok = delta; best = win; }
  });
  return { win: best, refused: 0 };
}
// What may be WRITTEN to the learned store from one `modelUsage` object — the same rule as reading, which
// is where round 2 went wrong in the other direction: it filed a window under the WIDE key merely because
// the selector was wide, without checking that the number belonged to the wide variant. Evidence that a
// number is the wide variant's is either in the key itself („…opus-5[1m]") or in the number (≥ 1M);
// a selector that asks for 1M while the CLI reports 200 000 for that model is a CONTRADICTION and is filed
// nowhere — neither under the wide key (nobody measured 1M) nor under the bare one (nobody measured the
// bare variant). ctxDecide reports it as a conflict instead.
// Returns [{ key, win }] — the caller owns the store (ctxStoreMerge writes it).
function ctxLearnEntries(modelUsage, model) {
  var out = [];
  if (!modelUsage || typeof modelUsage !== 'object') return out;
  var m = model || {};
  Object.keys(modelUsage).forEach(function (key) {
    var win = ctxEntryWindow(modelUsage[key]);
    if (win <= 0) return;
    var kv = ctxVariantKey(key);
    if (!kv) return;
    if (ctxIsWide(key)) {
      // The key names the variant itself — but only TOGETHER with a number that variant can have. Filing
      // „…opus-5[1m]: 200 000" would hand the next wide tab exactly the 200 000 that produced „250 % ·
      // 500,8K / 200,0K", with the learned store as the carrier this time; and under the bare key it would
      // claim a measurement of a variant nobody measured. So a self-contradicting entry is filed NOWHERE.
      // Same function as the read side (ctxVariantFits), so the two rules cannot drift apart.
      if (ctxVariantFits({ key: kv, wide: true }, win)) out.push({ key: kv, win: win });
      return;
    }
    if (m.id && kv === m.id) {
      // The entry names THIS tab's model, under the only spelling the CLI's own `modelUsage` uses — a bare
      // one. The key therefore says nothing about the variant, so the TAB has to; and when the tab cannot
      // (varUnknown — a „Default" whose menu entry resolves to nothing, a CLI-side fallback where the
      // selector names somebody else), nobody can say WHICH variant this window was reported for. Both
      // variant-keyed READ sources abstain in exactly that state (ctxLearnedWindow, ctxNameWindow) and the
      // write side has to, or the asymmetry files the number under the bare key by default — and that store
      // is persisted, shared across every tab and outlives the session that guessed, so the next „[1m]" tab
      // reads back a 200 000 nobody ever measured for it. „Nothing learned" costs one control request.
      if (m.varUnknown) return;
      if (m.wide) {                                                   // only the selector says „1M"
        if (ctxVariantFits(m, win)) out.push({ key: m.key, win: win });
        return;
      }
      // this tab's own model under a bare spelling and a KNOWN bare variant: the tab says which variant, and a
      // bare model has no upper bound (sonnet-5 is 1M without a suffix), so the number goes to the bare key
      out.push({ key: kv, win: win });
      return;
    }
    // An entry for ANOTHER model — the haiku side-call, a subagent, or the model this session ran BEFORE a
    // /model switch (modelUsage is cumulative over the session). Its key is bare because the CLI's keys always
    // are (measured), so the key says nothing about the variant, and the tab cannot say either: its selector is
    // about its own model. Only the NUMBER can: a window below CTX_WIDE_WINDOW cannot be a „[1m]" window
    // (ctxVariantFits), so it is the bare variant's. A 1 000 000 is a number BOTH variants can have, and filing
    // it under the bare key is exactly the variant-blind write the pre-PR-3b store did for every key
    // („eu.anthropic.claude-opus-5": 1 000 000 in Julian's store, 05.10. — from opus-5[1m] sessions, while the
    // bare opus-5 measured 200 000 at the time). Not filed — the model's own tab learns it when it runs.
    if (win < CTX_WIDE_WINDOW) out.push({ key: kv, win: win });
  });
  return out;
}
// ---------------------------------------------------------------------------------------------------
// 2b. THE FLOOR — the one thing a deletion could not do
// ---------------------------------------------------------------------------------------------------
// The biggest window a SOURCE claims — the number a token count has to beat before it may call that source
// wrong. Only the route answer has a second, larger number beside its 100 % line (`rawMaxTokens`), so „the
// bigger of the two" exists for the MEASURED source alone; session · learned · name are a single bare window
// with nothing above them (B3 · rows d3/d4). ONE function, because the refutation in (8) and the floor below
// have to read the same ceiling: if they differed, a state one of them calls legal (a context between the
// compaction line and the raw window) would be refused by the other at the next turn boundary.
function ctxSourceCeiling(win) {
  var w = (win && typeof win === 'object') ? win : {};
  var v = Number(w.value) || 0;
  return w.measured ? Math.max(v, Number(w.raw) || 0) : v;
}
// WHY A FLOOR AND NOT A DELETION. The previous round DELETED a refuted window — from the learned store, from
// `tab.ctxReported` and from the not-yet-adopted `_ctxWindowSaved`. That machinery is right and is kept (an
// entry the evidence disproves has no business in a store every tab reads), but it cannot be the GUARANTEE,
// for three reasons no deletion can fix:
//   · CTX_NAME_WINDOWS is a module CONSTANT. For every model in that table the refuted window is handed
//     straight back at the next compaction — unmarked and byte-identical, with both stores EMPTY, so no stale
//     data is involved at all. You cannot delete a number out of a constant.
//   · the CLI RE-FILES it: `result.modelUsage[…].contextWindow` arrives fresh in every single result and
//     re-fills the store the deletion just emptied, so the correction survived until the next ordinary turn.
//   · two more holders were never cleaned either — `tab.ctxMeasured` (only ctxForgetContext/ctxForgetModel
//     clear it, so a token count that DROPS inside one generation reads the refuted measurement back) and a
//     SECOND tab that adopted the same number for the same variant on its own.
// So the refutation is recorded as a FACT instead of being chased through its holders: ONE accepted API call
// carried `below` tokens, therefore the real window of that variant is AT LEAST `below`, therefore every
// window smaller than `below` is wrong — whoever offers it, however often, and however much later. That is a
// floor; every DERIVED source passes it (ctxDecide (4)), and a source it refuses is marked exactly like a variant
// mismatch rather than silently turning into „–". (The one source it does not judge, since 2026-10-05, is the
// CLI's own measurement of this session — which judges the floor instead; see point 5 below and 6 at the top.)
// WHY IT CANNOT OVER-REACH — the thing to check about a bound that is shared and persisted:
//   1. it is keyed by VARIANT, like the windows beside it: a floor proven for „claude-opus-5" is never read
//      for „claude-opus-5[1m]" and vice versa, so the 1M sibling of a 200 K session is untouched;
//   2. it is a LOWER bound from an ACCEPTED call, so it is by construction ≤ the real window of the session
//      that proved it — a genuinely 200 K session cannot carry more than 200 000 tokens, so its floor can
//      never exceed 200 000 and a later, genuinely 1M window passes it unchanged (1 000 000 > 200 000).
//      „Shrinking a bigger session" is arithmetically impossible: the bound only grows (ctxFloorMerge takes
//      the max, so a compaction cannot talk it down) and only ever refuses numbers strictly BELOW it;
//   3. it is filed only where the VARIANT IS KNOWN (ctxDecide (8): `varUnknown` files nothing), the same gate
//      the learned store and `adopt` already carry — without it a session whose variant nobody can name would
//      stamp its (possibly 1M) count onto the BARE key, which is one way 1 and 2 could be fooled;
//   4. and it is filed only from a count that really is ONE call. The one number in this file that may be a SUM
//      over the turn is the last-resort fallback (ctxNoteFrame `summed`), and a bound raised from an over-count
//      would be ABOVE the real window — the only direction in which a floor can refuse something true. The
//      display refutation still fires there (it lasts one turn and the probe re-asks); nothing durable does.
//      The SECOND number that is not a call was missed here, and that is how point 2 was broken in the field
//      (05.10., see 6 at the top): `get_context_usage.totalTokens` is the CLI's estimate of the next request,
//      and it was counted as one. Now the rule is stated positively — a floor needs a FRAME count (main
//      thread, not summed) — instead of as a list of exceptions that can miss one;
//   5. and only against a DERIVED window. A frame that beats the CLI's own measurement still drops it from the
//      line (row d2), but it files nothing: the measurement outranks every floor (it is never gated and it
//      refutes the floors above it, `healed`), so a bound filed there would be removed by the very next read
//      of the same answer — a write/delete treadmill — and the contradiction itself most likely means the
//      variant changed under the key (a typed „/model", now tracked at the source), not that the CLI is wrong
//      about the model it runs.
//      What that must NOT give up is F2's protection (the third holder in the list above): a measurement the
//      frames have beaten, read back once the count drops inside the same generation, would be on the line again
//      unmarked — „≈ 60 % · 120.000 / 200.000" over a session whose own call carried 500 800 (counter-check of
//      05.10.). So the evidence is kept where it belongs, ON THE MEASUREMENT (`beaten`, ctxNoteBeaten): that
//      measurement is no candidate any more, its count is a bound for every derived source of this decision,
//      and the next measurement or the next generation drops it together with the measurement. Per tab and per
//      generation, never shared and never persisted — which is exactly what point 5 asks of it.
// PROVENANCE. An entry is `{ below, src: 'frame', at }` — the count, where it came from, and when (the panel's
// clock, like a measurement's `at`). Before 05.10. it was a bare number, and a bare number cannot say whether it
// came from a frame, from a measured estimate (the bug) or from a frame that beat a measurement (no longer a
// source): it is LEGACY and reads as no floor (ctxFloorAt), and the store drops it on load (ctxFloorStoreClean).
// Legacy entries yield to the derived sources as well, not only to a measurement — decided on purpose: a sound
// one is rebuilt by the frames within one turn (the display refutation needs no floor, and a frame that beats a
// derived window files a new, proven one), while an unsound one costs „–" on every UNMEASURED state of its
// variant — every fresh tab before its start, and for good on a CLI that cannot measure. Julian's tab heals at
// the next page load, with no measurement needed.
// THE RESIDUAL CASE, stated rather than hidden: a variant key whose real window genuinely SHRINKS later — a
// „/model opus[1m]" typed into the composer and then taken back, where the frames spell both sessions
// „claude-opus-5" and nothing in the tab can tell them apart. The floor then refuses a number that has become
// true again, and the line shows „–" with the ⚠ and a tooltip naming the proven bound. That is the same answer
// this file gives to every contradiction it cannot resolve, and it fails in the loud direction: a wrong „–" is
// visible and keeps the probe asking, while a wrong „200,0K" is the sentence this whole file exists to stop.
// The arithmetic, once: a window is wrong exactly when it is SMALLER than the proven bound. A window the count
// fills exactly is legal (a context at 100 % is a real state, not a contradiction) and a bigger one is not
// touched at all — an unconditional delete would throw away an entry the evidence says nothing about (a
// learned 1 000 000 while a measured 200 000 was the half that got refuted).
function ctxBelowFloor(win, floor) {
  var f = Number(floor) || 0, n = Number(win) || 0;
  return !!(f > 0 && n > 0 && n < f);
}
// The PROVEN entry for one variant key, or null. Exact key, like ctxLearnedWindow — see 1 above. Only an entry
// that says where it came from counts (see PROVENANCE): a bare number is legacy and is no floor.
function ctxFloorEntry(floors, key) {
  if (!floors || typeof floors !== 'object' || !key) return null;
  var e = floors[String(key)];
  if (!e || typeof e !== 'object' || e.src !== 'frame') return null;
  var n = Number(e.below) || 0;
  return n > 0 ? { below: n, src: 'frame', at: Math.max(0, Number(e.at) || 0) } : null;
}
// The floor in force for one variant key — its count, 0 when none is proven.
function ctxFloorAt(floors, key) {
  var e = ctxFloorEntry(floors, key);
  return e ? e.below : 0;
}
// Raise it. MONOTONIC on purpose: the next compaction shrinks the context, but the disproof already happened —
// a floor that followed the count back down would un-prove itself one turn later, which is precisely the hole
// the deletion left open. Returns 1 when something changed, so the caller can skip the write.
// The refutation has to SAY it is a frame's (`src: 'frame'`, which only ctxDecide (8) hands out, and only for a
// frame count): a second gate behind the decision's own, so that a future caller with some other number in hand
// cannot turn it into a bound by accident — the way an estimate became one. `now` is the caller's clock; it is
// what lets a younger measurement refute the floor later (ctxDecide `healed`).
function ctxFloorMerge(floors, refuted, now) {
  if (!floors || typeof floors !== 'object') return 0;
  var r = (refuted && typeof refuted === 'object') ? refuted : null;
  var key = r ? String(r.key || '') : '';
  var below = r ? Number(r.below) || 0 : 0;
  if (!key || !(below > 0) || r.src !== 'frame' || ctxFloorAt(floors, key) >= below) return 0;
  floors[key] = { below: below, src: 'frame', at: Math.max(0, Number(now) || 0) };
  return 1;
}
// …and take it back: a measurement refuted it (ctxDecide `healed` = { key, below }). Only the entry that was
// refuted — if a bigger proof replaced it in the meantime, that one is evidence the measurement did not see.
// Returns 1 when something was removed, so the caller persists and reports it once.
function ctxFloorDrop(floors, healed) {
  if (!floors || typeof floors !== 'object' || !healed || !healed.key) return 0;
  var key = String(healed.key);
  if (!Object.prototype.hasOwnProperty.call(floors, key) || ctxFloorAt(floors, key) !== Number(healed.below)) return 0;
  delete floors[key];
  return 1;
}
// LOADING the two shared stores. Both are localStorage, written by every version of this panel that ever ran on
// this machine, so what comes back is not necessarily what this file would write — Julian's 05.10. dump held
// both kinds of leftover. Pure, so the table can pin it; commands.js applies it on every load of a store (the first
// read of a page, and the fresh read before every write — see ctxStoreFresh there) and persists the result.
// Returns what was dropped, so the caller can say it in the 🔔 log instead of silently changing the store.
//
// THE FLOORS: only proven entries under a canonical key survive. A bare number is legacy (see PROVENANCE) and is
// dropped — it reads as no floor anyway, and a store that keeps entries nobody reads is how the next round
// misreads it.
function ctxFloorStoreClean(raw) {
  var src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  var floors = {}, dropped = [];
  Object.keys(src).forEach(function (k) {
    var e = ctxFloorEntry(src, k);
    if (e && ctxVariantKey(k) === k) { floors[k] = e; return; }
    var v = src[k];
    dropped.push({ key: k, below: Number(v && typeof v === 'object' ? v.below : v) || 0 });
  });
  return { floors: floors, dropped: dropped, changed: dropped.length > 0 };
}
// THE LEARNED WINDOWS: keys are normalized to the variant key (ctxVariantKey) — the pre-PR-3b writer
// (ctxLearnWindows, 2026-09-22 … 10-02) filed the CLI's raw `modelUsage` keys, gateway prefix, -vN and date
// included, and it stripped „[1m]" before filing. Those entries are never READ (every reader looks up the
// canonical key), but they are not harmless either: the next refactor that matches them loosely inherits them.
// So every NON-canonical key is DROPPED, and none is migrated. The first version of this round migrated a legacy
// value below 1M onto its canonical key („it can only be the bare variant's"), and the counter-check showed why
// that is a guess rather than a cleanup: a key that was never read changes nothing while it sits there, but
// lifted into the read path it starts deciding the line — and its number is a window of an OLDER CLI build.
// „eu.anthropic.claude-opus-5-5": 200 000 (filed 01.10. under 2.1.286) became „≈ 15 % · 30.000 / 200.000" on a
// bare opus-5-5 tab, while the probe under 2.1.289 answers 1 000 000 for exactly that model. A window is a
// property of model AND build (6 at the top), so an unattributed old number is no evidence about today's.
// Dropping is lossless by construction: nothing ever read those keys, so the line cannot change by it.
// CANONICAL keys are a different case and are KEPT, including a bare one at 1 000 000 that the variant-blind
// path of PR-3b may have written (another model's 1M under its bare key — ctxLearnEntries, closed in this round).
// Two reasons, both checked: those keys ARE read today, so dropping one changes the line and needs evidence
// against it — and the evidence points the other way: the free probe of 05.10. (CLI 2.1.289) answers 1 000 000
// for the bare opus-5, opus-5-5 and sonnet-5 alike, so every such entry is numerically right under the CLI that
// runs now. And if one ever is not, it is an over-claim, the direction the frames cannot catch — which is why an
// unmeasured window stays in doubt (ctxWindowInDoubt) and is re-asked at every boundary until the CLI's own
// measurement, which outranks it, has replaced it. Only an entry that contradicts ITSELF goes: a „[1m]" key below
// 1M (ctxVariantFits).
function ctxWindowStoreClean(raw) {
  var src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  var known = {}, dropped = [];
  Object.keys(src).forEach(function (k) {
    var w = Number(src[k]);
    var kv = ctxVariantKey(k);
    if (!kv || kv !== k || !(w > 0) || !isFinite(w) || (ctxIsWide(k) && w < CTX_WIDE_WINDOW)) { dropped.push(k); return; }
    known[k] = w;
  });
  return { known: known, dropped: dropped, changed: dropped.length > 0 };
}
// Is a stored window refuted by THIS refutation? `refuted` is what ctxDecide hands out when the frames
// disproved the window (see (8)): { key, below } — the variant, and the token count ONE accepted API call
// carried. Same arithmetic as the floor, same key rule, so „corrected" cannot come to mean two different
// things in the two places. This is the HYGIENE half: the entry that is already filed is removed as well, so
// the store does not keep a number the panel would refuse on every read anyway.
function ctxWindowRefuted(win, refuted) {
  var w = (refuted && typeof refuted === 'object') ? refuted : null;
  return !!(w && w.key) && ctxBelowFloor(win, w.below);
}
// …the same question for the window a TAB carries (tab.ctxReported, which chat.js persists). Keyed by variant
// like the learned store, so a refutation of one variant never deletes the other one's number.
function ctxReportedRefuted(reported, refuted) {
  if (!reported || typeof reported !== 'object' || !refuted || !refuted.key) return false;
  if (String(reported.key || '') !== String(refuted.key)) return false;
  return ctxWindowRefuted(reported.win, refuted);
}
// …and the THIRD holder of that one number: a saved window that has not been ADOPTED yet, because the model
// menu had not answered when the tab came back (chat.js `_ctxWindowSaved` → ctxAdoptSavedWindow). It is the
// same value in a different box — {variante, fenster}, as persistTabs writes it — and it is handed to
// `tab.ctxReported` LATER, so a deletion that only cleans the two live stores is undone by the menu
// answering: the refuted window would be back a second after it was deleted. Same rule, same key comparison.
// (Since the floor gates `ctxReported` on every read, this one is hygiene too — the number cannot be SHOWN any
// more either way, but a holder that quietly keeps a disproved value is how the last four rounds went.)
function ctxSavedRefuted(saved, refuted) {
  if (!saved || typeof saved !== 'object' || !refuted || !refuted.key) return false;
  if (String(saved.variante == null ? '' : saved.variante) !== String(refuted.key)) return false;
  return ctxWindowRefuted(saved.fenster, refuted);
}
// Merge learned entries into the store. Returns how many entries CHANGED, so the caller can skip a write:
// a turn reports the same window every time, and this runs on every result frame of every tab.
// `refuted` is the DELETE path, and the store still wants one: a disproved entry that stays is a number every
// read has to refuse again, and the store is shared by every tab and every future session. It is HYGIENE, not
// the guarantee — the guarantee is the floor (see „THE FLOOR"), because the same number arrives fresh in the
// next `result` and the name constant cannot be deleted at all. A deletion counts as a change, so the caller
// persists it. Entries are merged BEFORE the deletion, so a refutation always wins over a number reported in
// the same breath.
function ctxStoreMerge(known, entries, refuted) {
  if (!known || typeof known !== 'object') return 0;
  var changed = 0;
  if (Array.isArray(entries)) entries.forEach(function (e) {
    if (!e || !e.key || !(Number(e.win) > 0)) return;
    if (known[e.key] === e.win) return;
    known[e.key] = e.win; changed++;
  });
  var w = (refuted && typeof refuted === 'object') ? refuted : null;
  if (w && w.key && ctxWindowRefuted(known[w.key], w)) { delete known[w.key]; changed++; }
  return changed;
}
// The learned window for ONE variant — exact key, no fallback in either direction. The fallback used to
// re-create the reported bug with no race at all: a 200 K session on „eu.anthropic.claude-opus-5" writes
// only the model-wide entry (it has no variant to distinguish), and a later tab on „…claude-opus-5[1m]"
// inherited that 200 000 and painted „Kontext 250 % · 500,8K / 200,0K". The mirror case is just as wrong,
// so it is refused too: a bare spelling does not read the „[1m]" entry.
function ctxLearnedWindow(known, model) {
  if (!known || typeof known !== 'object') return 0;
  var m = model || {};
  // Both variant-keyed sources abstain when the variant is not known (ctxResolveModel varUnknown): the key
  // would be the BARE one by default, and reading the bare entry for a session that may well be the wide
  // one is the same inheritance as reading the wide entry for a bare session — refused in both directions.
  if (m.varUnknown) return 0;
  var key = m.key || '';
  return key ? (Number(known[key]) || 0) : 0;
}
// The name table (see CTX_NAME_WINDOWS): the last resort, and the only one that is a guess.
function ctxNameWindow(model) {
  var m = model || {};
  if (!m.id) return 0;
  if (m.varUnknown) return 0;   // see ctxLearnedWindow — a table keyed by variant has no row for „unknown"
  if (m.wide) return CTX_WIDE_WINDOW;
  return Number(CTX_NAME_WINDOWS[m.key]) || 0;
}

// CTX-4 — the /context route's answer, reduced to what the line needs. The field names are the CLI's own
// (see the measurement at the top of this file). Two of them matter beyond the arithmetic:
//   · `percentage` is computed by the CLI and is the number its auto-compaction acts on, so it is
//     preferred over our own division — but only while BOTH halves of the line come from this answer, see
//     ctxDecide: a CLI percentage next to a window from somewhere else is a third number that agrees with
//     neither of the two beside it.
//   · `maxTokens` is the 100 % line (what /context itself shows); `rawMaxTokens` was identical in every
//     measurement, so it is only worth showing when it differs.
// A missing `maxTokens` leaves `win` at 0 ON PURPOSE: this answer is then a measurement of the TOKENS and
// not of the window, and ctxDecide keeps those two apart (property 2).
// `unconfirmed: true` means the CLI did not answer in time. That is NOT „the context is empty" — the
// whole point of returning null here is that it must never be mistaken for a measurement of 0.
// `hasTok` is the mirror of `hasPct`, and it exists because 0 is a LEGAL token count: a session that has
// just been cleared really holds 0 against a known window, and that pair is accepted here on purpose. The
// decision below used to test the number itself (`tokens > 0`) and therefore could not tell „the CLI
// measured an empty context" from „no answer carried a token count" — so a measured 0 was painted as
// „wird gemessen…", a promise about a query that had already been answered.
function ctxFromRoute(r) {
  if (!r || typeof r !== 'object' || r.unconfirmed) return null;
  var tot = Math.max(0, Number(r.totalTokens) || 0);
  var max = Math.max(0, Number(r.maxTokens) || 0);
  if (!tot && !max) return null;
  var pct = Number(r.percentage);
  var hasPct = r.percentage != null && isFinite(pct);
  var hasTok = r.totalTokens != null && isFinite(Number(r.totalTokens));
  return {
    tokens: tot, win: max, raw: Math.max(0, Number(r.rawMaxTokens) || 0),
    pct: hasPct ? Math.max(0, pct) : 0, hasPct: hasPct, hasTok: hasTok,
    source: String(r.autocompactSource || ''),
    // PR-11 — the BREAKDOWN travels with the measurement, and that is the whole reason the panel does not
    // ask a second time to open it: the route answer is 38 KB on the wire of the CLI's stdin and PR-3b
    // deliberately asks it at the turn BOUNDARIES only. The categories and the per-server aggregate are
    // already in the answer the gauge just read, so the click costs nothing. ctxDecide ignores both fields
    // (its table asserts the whole record per row, and the breakdown may not be able to move the gauge's
    // numbers) — public/js/ctx-breakdown.js reads them off `tab.ctxMeasured`.
    // Carried RAW, not summed: the arithmetic lives in ctx-breakdown.js, where it is one function with one
    // test, instead of here where it would be a second source of totals beside `tokens`.
    cats: Array.isArray(r.categories) ? r.categories : [],
    mcp: (r.mcp && typeof r.mcp === 'object') ? r.mcp : null,
  };
}

// ---------------------------------------------------------------------------------------------------
// 3. FRESHNESS — two counters, both compared with ===
// ---------------------------------------------------------------------------------------------------
// `_ctxGen` — the per-tab GENERATION: bumped by every change that makes an in-flight `get_context_usage`
// query answer about a state that no longer exists (a model switch, /clear, a compaction, a restart). A
// measurement records the generation it was asked in; a different one means „the CLI answered, correctly,
// about a context that is gone".
// `ctxStamp` — the per-tab STAMP: bumped by every event that moves the context NUMBER (an `assistant`
// frame that reported usage, and every state change above). A measurement is the current token count only
// while the stamp is unchanged, i.e. while nothing newer has arrived.
// Both are compared with `===`, never with `<`/`>`, and that is the whole fix for the counter the /clear
// branch reset: an ordering test let a measurement captured at seq 5 outrank the next five frames of the
// new model, while an equality test can only ever FAIL after a reset — which discards the measurement and
// falls back to the derived number. Wrong in the harmless direction, by construction.
function ctxBumpGen(tab) { if (tab) tab._ctxGen = (Number(tab._ctxGen) || 0) + 1; return ctxGenOf(tab); }
function ctxGenOf(tab) { return Number(tab && tab._ctxGen) || 0; }
function ctxStamp(tab) { if (tab) tab.ctxStamp = (Number(tab.ctxStamp) || 0) + 1; return ctxStampOf(tab); }
function ctxStampOf(tab) { return Number(tab && tab.ctxStamp) || 0; }
// NOT a miss when this is false: the CLI answered, and correctly — just about a context that is gone.
function ctxAnswerUsable(tab, gen) { return ctxGenOf(tab) === (Number(gen) || 0); }
// What a query captures when it goes out, and what ctxDecide compares a stored answer against.
function ctxAskedAt(tab) { return { gen: ctxGenOf(tab), stamp: ctxStampOf(tab) }; }

// An `assistant` frame reported a context. The ONE place that writes the derived token count, so the stamp
// can not be forgotten at a call site (chat-events.js used to bump its own counter by hand).
// `summed` is the ONE caller that does not hand in a single call: the last-resort fallback for a turn where no
// `assistant` frame carried usage at all publishes `result.usage`, which ADDS the input side of every call in
// the turn (measured: 81 220 reported for a context that held 42 263 — see 1 at the top of this file). Keeping
// the gauge alive with it is right; turning it into a FLOOR would not be, because a bound filed from an
// over-count refuses the model's real window for every future tab and session. So the number is marked, and (8)
// files nothing durable from a marked one.
function ctxNoteFrame(tab, tokens, summed) {
  var n = Math.max(0, Number(tokens) || 0);
  if (!tab || !(n > 0)) return ctxStampOf(tab);
  tab.ctxTokens = n;
  tab.ctxTokensStale = false;   // a real new number arrived → whatever made the old one stale is over
  tab.ctxTokensSummed = !!summed;
  ctxNoteBeaten(tab);           // …and if this one call carried more than the CLI measured, that is remembered
  return ctxStamp(tab);
}
// A frame of THIS generation carried more than the window the CLI measured for it: remember that ON the
// measurement (`beaten` = the biggest such count), because the frame count itself moves on. Without the memory the
// refuted window came back unmarked as soon as the count dropped inside the same generation — F2's holder, given
// up by the first version of the 05.10. round, see „THE FLOOR" point 5. Two writers on purpose: a frame that
// arrives after the measurement (ctxNoteFrame) and a measurement that arrives after the frame that beats it (the
// probe asked at an older stamp — commands.js ctxProbe calls this right after storing the answer). Only a count
// that is ONE call marks it (not stale, not the summed fallback — the same rule as filing a floor), and the mark
// dies with the measurement: the next answer replaces the object, and every state change clears it.
// Returns the biggest count that has beaten it, 0 when the current count does not.
function ctxNoteBeaten(tab) {
  var m = tab && tab.ctxMeasured;
  if (!m || typeof m !== 'object' || !(Number(m.win) > 0)) return 0;
  if ((Number(m.gen) || 0) !== ctxGenOf(tab) || tab.ctxTokensStale || tab.ctxTokensSummed) return 0;
  var n = Number(tab.ctxTokens) || 0;
  if (!(n > ctxSourceCeiling({ value: Number(m.win), raw: Number(m.raw) || 0, measured: true }))) return 0;
  if (!(Number(m.beaten) >= n)) m.beaten = n;
  return Number(m.beaten);
}
// CTX-1 — everything that was measured for the PREVIOUS model. The window is a property of the model, and
// it was never invalidated by a switch, so a tab moved from a 1M model to a 200 K one kept dividing by
// 1 000 000 — and the reported „250 % · 500,8K / 200,0K" is the other direction. The token count goes too:
// the context a model starts with is its own (measured on an empty session: 34 021 on sonnet-5 vs 18 529
// on opus-5). `keepTokens` is for the one caller that knows better — the `assistant` frame that REPORTED
// the new model also carries that model's context, so that number is already right.
function ctxForgetModel(tab, keepTokens) {
  if (!tab) return;
  tab.ctxReported = null; tab.ctxMeasured = null; tab._ctxMisses = 0; tab._ctxModelUsage = null;
  if (!keepTokens) tab.ctxTokens = 0;
  tab.ctxTokensStale = false;   // either it is 0 now, or it is the number the switching frame just carried
  // …and its provenance goes with it. 0 is no count at all; a KEPT number keeps its mark — the switching frame
  // replaces it right after (ctxNoteFrame, which sets the mark anew), but a frame without usage does not, and
  // clearing the mark here would launder a summed fallback into „one call" (and a floor) on that path.
  if (!keepTokens) tab.ctxTokensSummed = false;
  ctxBumpGen(tab); ctxStamp(tab);
}
// CTX-6 — the context changed without the MODEL changing: /clear emptied it, a compaction replaced it
// with a summary. Both void the last measurement (it describes a context that no longer exists) and both
// make an in-flight query stale. `tokens` is passed ONLY by a caller that really knows the new size:
// /clear knows it is 0, a compaction does not — the CLI's `compact_boundary` carries `{trigger,
// pre_tokens}`, i.e. the size of what was just thrown AWAY, and synthesising a 0 from the missing
// post-compaction field is what made the gauge publish the summed turn usage as the new context.
// A caller that passes no number is saying „the context changed and I do not know the new size". Ending the
// operation was only HALF of that: the derived count stood untouched, so the tab went on painting the
// PRE-compaction number — the size of what had just been thrown away, as a number with no „measuring" hint
// on it (the compact_boundary caller, chat-events.js, deliberately passes nothing because the frame carries
// only `pre_tokens`). So the value is additionally marked STALE: it is not invented away (writing a 0 here
// is the other half of the old bug) and it is not shown either — the line says it is measuring until the
// probe answers, which is the one state that is true.
function ctxForgetContext(tab, tokens) {
  if (!tab) return;
  tab.ctxMeasured = null;
  if (tokens != null) { tab.ctxTokens = Math.max(0, Number(tokens) || 0); tab.ctxTokensStale = false; tab.ctxTokensSummed = false; }
  else tab.ctxTokensStale = true;
  ctxBumpGen(tab); ctxStamp(tab);
}

// Which triggers may ask, and when to stop. „At most one query in flight per tab" is the first half; the
// second is that a CLI which has not answered twice in a row will probably not answer the third time either,
// and every further `result` would spend the route's (deliberately long) timeout for nothing. A state CHANGE
// — a start, a model switch, /clear, /compact — is new information and re-arms it; so is a window that is in
// DOUBT (below), because there the budget is protecting a number that is wrong.
var CTX_MAX_MISSES = 2;
var CTX_REARM_TRIGGERS = ['start', 'model', 'clear', 'compact'];
// „Unsupported control request subtype" — a CLI that does not HAVE this control. lib/chat.js maps a refusal
// to the same `unconfirmed: true` a TIMEOUT produces, with the CLI's own wording in `reason`, and those two
// are not the same fact at all: a timeout is a slow answer that the next turn may well get (measured: 12,2 s
// cold while the MCP servers came up), while a refusal is a PERMANENT property of this binary. Counted as a
// miss it spent the two attempts and left whatever number was on screen standing for the life of the tab —
// and re-armed by the rule below it would spend the route's 25 s ceiling at every single turn boundary for an
// answer that cannot come. So it is remembered instead (the caller sets `_ctxNoSupport`, the line says „CLI
// kann nicht messen" and the tooltip says the numbers stay derived), and this tab stops asking.
// A re-ask makes sense only after a (re)start — that is a new process, and the binary may have been updated.
function ctxProbeUnsupported(r) {
  if (!r || typeof r !== 'object' || !r.unconfirmed) return false;
  return /unsupported|not supported|unrecognized|unknown (control |request )?subtype/i.test(String(r.reason == null ? '' : r.reason));
}
// CTX-2 — and such a state change must not be DROPPED by the in-flight guard. The model-switch trigger is
// the one that arrives mid-flight most often (the switch itself is what started the previous query's
// conversation partner), and the answer still on its way describes the state that just ended — so silently
// returning left the line on the old model's numbers until the next turn. `queue` tells the caller to
// re-ask once the current flight settles.
// `st.doubt` is the other half of the self-correction that never arrived: an ordinary turn boundary did not
// re-arm the counter, so after two silences the probe was dead and a DERIVED window stood uncorrected for
// the rest of the session — including the one case where the line is provably wrong (the frames refuted the
// window, ctxDecide `over-window`) and the one where there is no window at all. „The window is in doubt"
// (ctxWindowInDoubt) is exactly when one more 38 KB answer is worth its price, so a `result` then re-arms
// too; while the line is consistent, the two-silence budget still holds.
// `st.unsupported` is the one state that may never ask again — see ctxProbeUnsupported.
function ctxAskDecision(st, trigger) {
  var s = st || {};
  var misses = Number(s.misses) || 0;
  if (s.unsupported) return { ask: false, misses: misses, queue: false };
  var change = CTX_REARM_TRIGGERS.indexOf(String(trigger)) >= 0;
  var rearm = change || !!s.doubt;
  if (rearm) misses = 0;
  var ask = !s.inflight && misses < CTX_MAX_MISSES;
  // only a state CHANGE is queued behind a flight in progress: the answer on its way describes the state
  // that just ended, so it cannot settle the doubt — whereas for an ordinary turn boundary that same answer
  // is about this very state, and queueing a second query behind it would buy nothing.
  return { ask: ask, misses: misses, queue: !ask && change && !!s.inflight };
}

// The window a tab carries into the next browser session. Stored as {variante, fenster} — the variant KEY
// plus the number — because the number alone cannot say which variant it was measured for, and the two
// variants of one model have different windows. A restore whose variant no longer matches discards the
// value instead of showing it; the CLI is asked again within seconds, so all that is lost is a wrong
// number. A legacy bare number (and a legacy entry that stored the raw selector value rather than the
// variant key) is discarded for the same reason: it could have been measured for anything.
function ctxWindowSave(reported) {
  var w = reported ? Number(reported.win) || 0 : 0;
  var key = reported ? String(reported.key || '') : '';
  return (w > 0 && key) ? { variante: key, fenster: w } : undefined;
}
function ctxWindowLoad(saved, key) {
  if (!saved || typeof saved !== 'object' || !key) return null;
  var w = Number(saved.fenster) || 0;
  if (w <= 0) return null;
  return String(saved.variante == null ? '' : saved.variante) === String(key) ? { win: w, key: String(key) } : null;
}

// ---------------------------------------------------------------------------------------------------
// 4. THE ONE DECISION
// ---------------------------------------------------------------------------------------------------
// Everything the context line shows, persists and compares, decided in ONE place — so the painter holds no
// arithmetic and no precedence, and the decision is testable without a DOM. test/ctx.test.js asserts the
// WHOLE record per row.
//
// `tab`  — the tab state: { id, _exited, model, modelSel, ctxTokens, ctxTokensStale, ctxTokensSummed,
//          ctxStamp, _ctxGen, _ctxMisses, _ctxNoSupport, ctxMeasured, ctxReported }
// `env`  — what only the caller can know:
//            known    : the learned store (localStorage cc_ctx_windows)
//            floors   : the proven lower bounds per variant (localStorage cc_ctx_floors) — see „THE FLOOR".
//                       Shared and persisted like `known`, because the holders a refutation has to survive
//                       are a module constant, a second tab and the next `result` of the CLI itself.
//            sel      : the selector value to judge by (an unstarted VISIBLE tab is judged by the
//                       dropdown — the same rule tabCwd follows for the working directory)
//            resolves : the concrete model that selector entry stands for (lib/models.js `resolves`)
//            label    : the menu label the strip shows for this model, for the conflict check
//            usage    : { now, prev } — a `result` frame's modelUsage and the previous one, when the
//                       caller is handling exactly that event
//
// Returned record:
//   model  { id, key, wide, varUnknown, src }  who is running, which variant — and whether anything in this
//                                          tab could say which variant at all (then the variant-keyed
//                                          sources abstain and the window is „unknown", painted „–")
//   win    { value, src, measured, raw }   src: measured · session · learned · name · unknown. `raw` is the
//                                          CLI's `rawMaxTokens` and exists on the MEASURED source only — it
//                                          is the one answer that reports one — so it is 0 for session ·
//                                          learned · name, and those three therefore have no legal region
//                                          above their own number (see (8) and row d4).
//   tokens { value, src, measured }        src: measured · frames · none (a measured 0 IS a number;
//                                          „none" also covers a derived count marked stale)
//   pct, bar, level, unknownWin            what the gauge draws (pct is NOT clamped — a percentage
//                                          clamped to 100 next to „561 195 / 200 000" is how the broken
//                                          window stayed invisible; `bar` is the clamped one)
//   measured                               both halves come from the CLI's own answer about this state
//   pending, pendingWhy                    no number yet, and what it is waiting for: measuring · idle ·
//                                          silent · unsupported (this CLI has no such control at all)
//   conflict, shows                        two statements that cannot both be true, and which of them the
//                                          line prints: over-window (the frames refute a derived window →
//                                          „tokens", the window is dropped to „–") · below-floor (a source
//                                          offered a window this session has already disproved → „tokens"
//                                          when nothing is left) · label-wide (→ „window") · variant-usage
//                                          (→ „promise")
//   floor                                  the proven lower bound in force for this variant, 0 when none (and 0
//                                          once a measurement refuted it, see `healed`). On the record because
//                                          it is EVIDENCE, not a flag: the tooltip names the token count a real
//                                          call carried, and the table can assert it. Includes the count that
//                                          has BEATEN this generation's measurement (`ctxMeasured.beaten`, see
//                                          ctxNoteBeaten) — a bound of this tab only, never filed.
//   healed { key, below } | null           a floor the MEASUREMENT just refuted: the CLI reports a window
//                                          below it for this session, and the measurement is the younger of
//                                          the two. The caller removes exactly that entry (ctxFloorDrop) and
//                                          says so once in the 🔔 log. Only where the variant is KNOWN, and
//                                          only while no frame of this generation has carried more than the
//                                          measured window (the tab's own evidence would then confirm the floor).
//   autocompact                            the CLI's own `autocompactSource` for a MEASURED window — WHY that
//                                          number is the 100 % line (its model default, or a setting). '' for
//                                          every other source, which reports no such field.
//   adopt  { win, key } | null             what the caller may store as this tab's session window
//   learn  [{ key, win }]                  what the caller may write to the learned store
//   refuted { key, below, src } | null     the FACT the frames just established: for this variant a window of
//                                          less than `below` is impossible, because one accepted API call
//                                          carried `below` tokens. The caller raises the floor with it
//                                          (ctxFloorMerge — the guarantee) and deletes the entries it
//                                          disproves (ctxStoreMerge, ctxReportedRefuted, ctxSavedRefuted —
//                                          hygiene). Filed only where the variant is KNOWN, only from a FRAME
//                                          count (`src: 'frame'`) and only against a DERIVED window, see (8).
function ctxDecide(tab, env) {
  var t = tab || {}, e = env || {};
  var known = (e.known && typeof e.known === 'object') ? e.known : {};
  // (1) the model FIRST — every question below is about this variant
  var model = ctxResolveModel({
    reported: t.model,
    sel: e.sel != null ? e.sel : t.modelSel,
    resolves: e.resolves,
    // a typed „/model X" the CLI has not confirmed yet (chat-composer.js) — see ctxResolveModel
    pending: (t._modelPending && typeof t._modelPending === 'object') ? t._modelPending.arg : '',
  });
  // (2) the measurement, with its own two freshness tests
  var m = (t.ctxMeasured && typeof t.ctxMeasured === 'object') ? t.ctxMeasured : null;
  var sameGen = !!m && (Number(m.gen) || 0) === ctxGenOf(t);
  var sameStamp = !!m && (Number(m.stamp) || 0) === ctxStampOf(t);
  var winMeasured = !!(sameGen && Number(m.win) > 0);        // a window measurement survives new frames:
  // …the token count does not. Tested on `hasTok`, not on the number: 0 is a legal measurement (an empty
  // context against a known window — ctxFromRoute accepts exactly that pair), and reading it as „nothing
  // measured" made the line promise a query that had already been answered.
  var tokMeasured = !!(sameGen && sameStamp && m.hasTok);
  // (3) this session's own reported window: from the `result` being handled right now, else what an
  //     earlier result of this tab adopted — and only while it belongs to the SAME variant
  var reported = e.usage ? ctxWindowFromUsage(e.usage.now, model, e.usage.prev) : { win: 0, refused: 0 };
  var fresh = reported.win;
  var kept = 0;
  if (!fresh && t.ctxReported && String(t.ctxReported.key || '') === model.key) kept = Number(t.ctxReported.win) || 0;
  var session = fresh || kept;
  // (4) the window, most-certain first — and every DERIVED candidate has to clear the FLOOR. That is the whole point of
  //     this round: a refutation used to be a DELETION, and several holders of the number cannot be deleted at
  //     all — CTX_NAME_WINDOWS is a module constant, the CLI re-reports `contextWindow` in the next result,
  //     `tab.ctxMeasured` is cleared by nothing in that path, and a second tab has its own copy. Here they are
  //     all ONE kind of thing — a source OFFERING a number — and a source offering a window this variant has
  //     already disproved is refused exactly like one that crosses the wide boundary: skipped, booked as a
  //     visible conflict, and the next source gets its turn (row fl9).
  //     The lookup is by the model's own variant key, like ctxLearnedWindow. When the variant is UNKNOWN that
  //     key is the bare one, and reading the bare floor is still sound in the one direction that matters: a
  //     bound proven for the bare variant is a bound for the wide one too (a „[1m]" window is never smaller),
  //     so it can only refuse numbers that are wrong for either reading. The WRITE side is the asymmetric one
  //     and is gated — see (8).
  //     EXCEPT the measurement (05.10., see 6 at the top). It is the CLI answering about THIS session in this
  //     generation, and gating it is what turned one bad bound into „580K / –" for good: the floor refused the
  //     CLI's own maxTokens with nothing left that could ever overrule it. So it is never refused here — and a
  //     floor ABOVE it is refuted by it: `healed` names that entry, and the caller removes it (commands.js
  //     ctxFloorHeal). Two conditions on the removal, none on the display: the variant must be KNOWN (the same
  //     gate as filing — with it unknown the key is the bare one by default and the measurement may be about the
  //     other variant), and the measurement must be the YOUNGER of the two pieces of evidence (`m.at` against
  //     the floor's `at`, both the panel's clock): a tab's old measurement must not erase a bound another tab
  //     proved since. Every other source is judged by the floor that remains.
  //     A THIRD condition on the removal (counter-check, 05.10.): the measurement must not be contradicted by this
  //     tab's OWN evidence. Healing was decided before the tokens were known and was never taken back, so a record
  //     could say „the frames refute the measurement" (over-window) and „the measurement refutes the floor" at
  //     once — and the floor a 520 000-token call had just confirmed was deleted. A measurement whose ceiling a
  //     count of this generation exceeds (the current one, or the one remembered as `beaten`) refutes nothing.
  //     …and such a BEATEN measurement is no candidate at all any more (F2, see „THE FLOOR" point 5): its window
  //     is out, and the count that beat it bounds every derived source in this decision — so the name table's
  //     identical 200 000 cannot step in for it once the count has dropped. Not filed: it is this tab's evidence
  //     about this generation, and it goes with the measurement.
  // (5) the tokens — their own source, so „measured" can never be claimed for a number the frames derived.
  //     `ctxTokensStale` is the derived number that is known to be WRONG but has no replacement yet (a
  //     compaction): not shown, not invented away, and the line says it is measuring (see ctxForgetContext).
  //     Read BEFORE the window since 05.10.: the removal of a floor (above) depends on them.
  var tokens = { value: 0, src: 'none', measured: false };
  if (tokMeasured) tokens = { value: Math.max(0, Number(m.tokens) || 0), src: 'measured', measured: true };
  else if (!t.ctxTokensStale && Number(t.ctxTokens) > 0) tokens = { value: Math.max(0, Number(t.ctxTokens)), src: 'frames', measured: false };
  var floorEntry = ctxFloorEntry(e.floors, model.key);
  var floor = floorEntry ? floorEntry.below : 0;
  var healed = null;
  var floorRefused = 0;                       // the biggest window the floor threw out → the visible marking
  var cands = [];
  if (winMeasured) {
    var mc = { value: Number(m.win), src: 'measured', measured: true, raw: Number(m.raw) || 0 };
    var mCeil = ctxSourceCeiling(mc);
    var beaten = Number(m.beaten) > mCeil ? Number(m.beaten) : 0;
    var ownBeats = beaten > 0 || (tokens.src !== 'none' && tokens.value > mCeil);
    if (floorEntry && model.key && !model.varUnknown && ctxBelowFloor(mCeil, floor)
      && (Number(m.at) || 0) > floorEntry.at && !ownBeats) healed = { key: model.key, below: floor };
    if (beaten) { floorRefused = mc.value; if (beaten > floor) floor = beaten; }
    else cands.push(mc);
  }
  if (healed) floor = 0;                      // refuted — no source below is judged by it any more
  if (session > 0) cands.push({ value: session, src: 'session', measured: false, raw: 0 });
  var learned = ctxLearnedWindow(known, model);
  if (learned > 0) cands.push({ value: learned, src: 'learned', measured: false, raw: 0 });
  var named = ctxNameWindow(model);
  if (named > 0) cands.push({ value: named, src: 'name', measured: false, raw: 0 });
  var win = { value: 0, src: 'unknown', measured: false, raw: 0 };
  for (var ci = 0; ci < cands.length; ci++) {
    // the ceiling the source itself CLAIMS, not its bare number: a measured 100 % line may have a bigger raw
    // window beside it, and that bigger one is what the evidence has to contradict (rows d3/d4) — the same
    // function the refutation in (8) uses, so the two can never disagree about one state.
    if (cands[ci].src !== 'measured' && ctxBelowFloor(ctxSourceCeiling(cands[ci]), floor)) {
      if (cands[ci].value > floorRefused) floorRefused = cands[ci].value;
      continue;
    }
    win = cands[ci];
    break;
  }
  // …and a measurement ON the line that a proven floor still contradicts — not refuted by it (the floor is the
  // younger evidence, or the variant is unknown), not refused either (6 at the top: a measurement is never gated).
  // Shown, but MARKED (counter-check, 05.10., row fl3): „two statements that cannot both be true" is this file's
  // definition of a conflict, and a younger call that carried more than the CLI's window is the stronger one —
  // the very argument row d2 makes for a frame. The window stays on screen (`shows` ''), the tooltip names the
  // bound, and the conflict keeps the window in doubt, so the next answer is asked for and can heal the floor.
  var floorContradicts = win.src === 'measured' && ctxBelowFloor(ctxSourceCeiling(win), floor);
  // (6) the arithmetic. The CLI's own `percentage` is used only while BOTH halves come from that same
  //     answer: next to a window from anywhere else it is a third number that agrees with neither of the
  //     two printed beside it, and „two numbers that cannot both be true" is the bug this file is about.
  var both = tokens.measured && win.measured;
  var pct = (both && m.hasPct) ? Math.max(0, Number(m.pct) || 0)
    : (win.value > 0 ? tokens.value / win.value * 100 : 0);
  pct = Math.round(pct * 100) / 100;   // the record is compared whole in the table; a float tail is noise
  // (7) what may be remembered. Same variant rule as reading (ctxLearnEntries), so a contradicting number
  //     is shown but not filed — and the FLOOR gates the write side too, per ENTRY key: the CLI reports
  //     `contextWindow` in every single result, so without this the number a refutation just deleted is filed
  //     again at the next turn and the hygiene half would be a treadmill. Each entry is judged by its own
  //     variant's floor (a side-call's haiku window has nothing to do with this tab's bound).
  //     (This tab's own key is judged by the floor that is still in force — 0 once the measurement refuted it.)
  var learn = (e.usage ? ctxLearnEntries(e.usage.now, model) : []).filter(function (x) {
    return !ctxBelowFloor(x.win, x.key === model.key ? floor : ctxFloorAt(e.floors, x.key));
  });
  var adopt = null;
  // `varUnknown` stops BOTH writers here, for the same reason it stops both variant-keyed readers: the key
  // they would write under is the BARE one by default, and this session may well be the wide variant. The
  // learned store is the loud case (shared, persisted, outlives the session — see ctxLearnEntries), but
  // `tab.ctxReported` is persisted too (chat.js persistTabs → ctxWindowSave {variante, fenster}) and is read
  // back by exact key equality — so a bare-keyed entry written while nobody knew the variant is exactly what
  // a later bare-variant tab inherits. The cost is that such a tab shows „–" between turns instead of the
  // window its last result reported; that is this file's own answer to „nobody said" everywhere else, and
  // the probe is now re-armed at every turn boundary while the window is in doubt (ctxAskDecision), so the
  // CLI's own measurement — which needs no spelling and is shown ungated — arrives within seconds.
  if (model.key && !model.varUnknown) {
    // `tab.ctxReported` is PERSISTED (chat.js persistTabs → ctxWindowSave), so it is a second store and it
    // gets the SAME gate as the first one — the two sibling branches here state one rule, not two. Today
    // ctxWindowFromUsage already refuses a contradiction on every path (the invariant test pins that), so
    // this gate changes no row; it is here because „the store with the weaker rule wins" is exactly how a
    // 200 000 reached a „[1m]" tab, and a rule that exists in only one of two writers is one refactor away
    // from being the weaker one again.
    // …and both branches pass the floor as well, for the same reason the learn entries do: `ctxReported` is the
    // holder a reload restores, so adopting a number the line itself refuses would hand it to the next session
    // as „the window of the last finished turn".
    // The MEASURED branch is judged by the bare `win.value`, NOT by the ceiling that let it onto the line. The
    // two are the same number in every measurement so far, and the difference is deliberate where they part: a
    // measured pair may legally sit between the CLI's compaction line and its raw window (row d3), so SHOWING it
    // is judged by max(value, raw) — but what gets FILED is `value` alone, and a filed number comes back as a
    // session/learned candidate with no `raw` beside it (ctxSourceCeiling returns the bare value for those).
    // Judging the write by the ceiling therefore filed a window that this very decision refuses on the next
    // read — a holder quietly keeping a disproved number, which is the pattern this round exists to end, and
    // two sibling branches stating two different rules again (row fl11).
    if (fresh > 0 && ctxVariantFits(model, fresh) && !ctxBelowFloor(fresh, floor)) adopt = { win: fresh, key: model.key };
    else if (winMeasured && win.src === 'measured' && ctxVariantFits(model, win.value)
      && !ctxBelowFloor(win.value, floor)) {
      adopt = { win: win.value, key: model.key };
      if (!learn.length) learn = [{ key: model.key, win: win.value }];
    }
  }
  // (8) THE FRAMES REFUTE THE WINDOW. `tokens` is the input side of ONE API call (ctxTokensOfFrame: input +
  //     cache_read + cache_creation of a single `assistant` frame), and that call was ACCEPTED: the API answered
  //     it. A request cannot carry more tokens than the window holds, so a count ABOVE the window is not „a
  //     context that is 250 % full" — it is proof that the window beside it is wrong. The derivation loses
  //     against the evidence.
  //     (This sentence used to go on „— or `totalTokens`, the same quantity as the CLI measures it". It is NOT
  //     the same quantity: `totalTokens` is the CLI's estimate of the NEXT request, no call that anybody
  //     accepted, and reading it as one is what filed Julian's 1 089 676 — see 6 at the top and `oneCall` below
  //     for what an estimate may and may not do here.)
  //     WHAT THE LINE SHOWS, and why this choice: the window is dropped to „–" and the ratio with it, while the
  //     TOKEN count stays. The alternative — mark it, keep both numbers — would leave „⚠ Kontext 250 % ·
  //     500,8K / 200,0K" on screen, and the ⚠ does not make the 250 % true; of the two numbers the token count
  //     is the one a real call carried, so the window is the half that goes. That is this file's rule
  //     everywhere else, too: a number that cannot be true is not shown, and „–" is honest (rows f, x, z).
  //     The tooltip names which of the two is in doubt — the window, not the count — because that is the
  //     question a ⚠ raises (ctxTitleLines, `over-window`).
  //     The test is the TOKEN COUNT against the biggest window THIS SOURCE claims, not `pct > 100`: for a
  //     MEASURED window that is max(maxTokens, rawMaxTokens) — `maxTokens` is the line the CLI auto-compacts at
  //     and `rawMaxTokens` the model's raw window (identical in every measurement so far, but the panel must
  //     not be the one that decides they are the same forever), so a context between the two is legal and
  //     refuting on it would throw away a window that is right (row d3).
  //     For the other three sources the ceiling is the window itself, because `raw` is NOT a field they have:
  //     only the route answer reports `rawMaxTokens`, and the session/learned/name numbers are a single bare
  //     window with no second, larger one beside it. The old expression max(win, raw) hid that — it read as if
  //     every source had a raw window and silently compared against 0 for three of the four — so the legal
  //     region row d3 describes is the MEASURED case only, and the derived mirror of d3 is refuted (row d4).
  //     Inventing a raw for the derived sources is the alternative, and it would be a guess about a guess.
  //     And when both halves are measured the percentage is the CLI's OWN, which need not follow our division.
  //     A MEASURED window is NOT exempt, deliberately: it is the CLI's answer about this session at the moment
  //     it was asked, and a frame that arrives afterwards is younger evidence about the same session. Keeping
  //     it would hold the one sentence this whole file exists to kill on screen for the rest of the turn.
  //     Nothing is REPLACED by something more plausible (that is what §3 forbids for a measurement) — the
  //     panel just stops claiming a window it can prove wrong, and asks again.
  //     This is what makes the line self-correcting for a variant that changed INVISIBLY — e.g. „/model
  //     opus[1m]" typed into the composer, which the CLI accepts without applyLiveModel ever running, so
  //     nothing in the tab carries the „[1m]" and the frames never do (they name `claude-opus-5`). The 200 000
  //     then meets a 500 800-token call, is refuted, and the re-armed probe asks the one source that knows
  //     (ctxAskDecision + ctxWindowInDoubt). No such path has to be enumerated for that to work.
  //     An ESTIMATE above the window (`totalTokens`, the CLI's guess at the NEXT request) is no accepted call, so it
  //     proves nothing durable — `oneCall` below files no floor from it, and nothing is adopted or learned. But it
  //     still takes the window off the line, and that includes the window of the SAME answer (both halves
  //     measured). The first version of this round exempted that pair („the CLI's own pair, over 100 % included"),
  //     and the counter-check walked straight back into the sentence: a live switch from a 1M tab onto Haiku is
  //     answered by `totalTokens 500 800 · maxTokens 200 000` (measured 02.10.: the very next answer already
  //     carries the new window), and the exemption printed „Kontext 250 % · 500.800 / 200.000" — with no ⚠, and
  //     with the 200 000 adopted and learned. Whether the pair is „right before an auto-compaction" or a CLI model
  //     table that is wrong (2.1.288 → 2.1.289 changed the bare opus-5 from 200 000 to 1 000 000) cannot be told
  //     from the pair itself, so the line does what it does for every contradiction it cannot resolve: the count
  //     stays, the window goes to „–", the ⚠ and the tooltip say it was an ESTIMATE (ctxTitleLines), and the
  //     window stays in doubt, so the next boundary asks again. Julian's „580K / –" does not come back by this:
  //     that was a FLOOR, and an estimate files none — the next frame below the window puts it straight back.
  var ceiling = ctxSourceCeiling(win);
  var overWindow = win.value > 0 && tokens.src !== 'none' && tokens.value > ceiling;
  var refuted = null;
  if (overWindow) {
    // Nothing that is refuted may be FILED. Both stores outlive this line — the learned one is shared by every
    // tab and every future session (see ctxLearnEntries), `ctxReported` is persisted per tab — and a window
    // this session has just disproved would be read back by a tab whose context is still small enough that
    // nothing contradicts it. Only this tab's own model is dropped: the side-call entries in the same
    // `modelUsage` describe OTHER models, and nothing was proved about those.
    adopt = null;
    learn = learn.filter(function (x) { return x && x.key !== model.key; });
    // …and both of those are writes that do NOT HAPPEN, which corrects nothing that is already filed — and, as
    // the last round proved, deleting what IS filed does not correct it either: CTX_NAME_WINDOWS is a module
    // constant (for every model in it the same number is handed back at the next compaction, with both
    // stores empty), the CLI re-reports `contextWindow` in the very next result, and a second tab holds its own
    // copy. So the record states the FACT instead, and the caller turns it into a FLOOR every source has to
    // pass (ctxFloorMerge) and, as hygiene, deletes the entries it disproves (ctxStoreMerge · ctxReportedRefuted
    // · ctxSavedRefuted).
    // `below` is the evidence, not just a flag: the accepted call proves the window is LARGER than this count,
    // so exactly the numbers smaller than it are wrong — a window the count fills exactly stays legal.
    // Only where the VARIANT IS KNOWN: the key would otherwise be the bare one by default, and a floor stamped
    // onto the bare key by a session that may well have been the wide one is the single way this bound could
    // ever over-reach (see „THE FLOOR", point 3). Nothing is filed then — the same answer (7) gives — while the
    // window is still dropped and marked, because what the evidence refutes is refuted regardless.
    // …and the count has to be ONE call. It is, for both sources, with exactly one exception: the last-resort
    // fallback that publishes the SUMMED turn usage when no `assistant` frame carried any (ctxNoteFrame
    // `summed`), which can be several times the real context. Dropping the window from it stays — that is this
    // turn only and the probe re-asks — but a DURABLE bound filed from an over-count would refuse the model's
    // real window for every future tab and session, which is the second way this could over-reach.
    // 05.10. — and that sentence was wrong about „both sources": `tokens.src === 'measured'` was counted as one
    // call, and a measured count is `totalTokens`, the CLI's ESTIMATE (see above and 6 at the top). That is the
    // whole of Julian's „580K / –". So the rule is stated POSITIVELY now: a bound needs a FRAME count — the
    // input side of one main-thread `assistant` frame (chat-events.js routes subagent frames away before
    // ctxNoteFrame, and skips „<synthetic>"), not the summed fallback — and a DERIVED window to refute: a frame
    // that beats the MEASURED window drops it from the line (row d2) but files nothing, because the measurement
    // outranks every floor and would refute this one at the very next read (see „THE FLOOR", point 5).
    var oneCall = tokens.src === 'frames' && !t.ctxTokensSummed;
    if (model.key && !model.varUnknown && oneCall && win.src !== 'measured') refuted = { key: model.key, below: tokens.value, src: 'frame' };
    win = { value: 0, src: 'unknown', measured: false, raw: 0 };
    pct = 0;
    // …and the pair is then a measurement of nothing: the record may never say „measured" while the window says
    // „unknown". Reachable since the counter-check of 05.10. — an estimate above the window of its own answer
    // (row j2) has both halves measured, and this is the line that takes `measured` back.
    both = false;
  }
  // (9) the one-sided contradiction: something PROMISES a million over a smaller window. The reverse is
  //     normal — „Sonnet 5" really is 1M without saying so in its name — and flagging it would put a ⚠ on
  //     almost every session. Both promises count: the menu label the strip shows („Opus 5 (1M)") and the
  //     resolved variant itself, which is the „Default" case where no label says 1M at all.
  //     Two different contradictions, and which one it is decides WHICH of the two numbers the line prints:
  //       label-wide    — the window on screen is smaller than the promise. The number wins (it is the CLI's
  //                       own measurement of this session) and the promise is marked.
  //       variant-usage — a window reported for this model was refused for crossing the wide boundary, so
  //                       the line prints the PROMISED window and the smaller report is not on screen. Said
  //                       out loud, because silently preferring the bigger number is the same bug mirrored.
  var promises = model.wide || /\b1m\b/i.test(String(e.label == null ? '' : e.label));
  var conflict = '', shows = '';
  // the refutation first: it is the only one of these that already changed the numbers, and with the
  // window gone the others have nothing left to compare against (a refused variant report is then the
  // smaller of two numbers that are both off the screen — the tooltip's refutation sentence covers it)
  if (overWindow) { conflict = 'over-window'; shows = 'tokens'; }
  // …then the floor, for the same reason it beats the two below: it is evidence about the numbers on the line
  // (a source was thrown out because THIS session disproved it), while „label-wide" is a statement about a
  // string. A refused source must be MARKED and not silently become „–" — that is the whole difference between
  // „the panel has no window" and „the panel refuses the window it was offered". `shows` is set only when
  // nothing survived: then the line really does print the token count alone, like the refutation above.
  // A measurement on the line below a floor that still stands is the same kind of evidence (see
  // `floorContradicts`) — marked the same way, with both numbers left on screen.
  else if (floorRefused > 0 || floorContradicts) { conflict = 'below-floor'; shows = win.value > 0 ? '' : 'tokens'; }
  else if (promises && win.value > 0 && win.value < CTX_WIDE_WINDOW) { conflict = 'label-wide'; shows = 'window'; }
  else if (reported.refused > 0) { conflict = 'variant-usage'; shows = 'promise'; }
  var pendingWhy = '';
  // „no number" is the SOURCE being empty, not the value being 0: a measured 0 is a number (the CLI said the
  // context is empty), and announcing a measurement for it would be a promise about an answered query.
  if (tokens.src === 'none') {
    // „wird gemessen…" is a claim about a query that is on its way, and for three of these states that is
    // simply untrue: a tab that was never started (and one whose process has exited) has no session to ask
    // — ctxProbe returns at `!tb.id` — a tab whose two silences spent the ask budget is not waiting for
    // anything either, it has been told no twice, and a CLI that does not HAVE the control will never answer
    // at all (ctxProbeUnsupported). The third is checked FIRST of those two, because it is the stronger
    // statement: „CLI antwortet nicht" invites waiting, „CLI kann nicht messen" is final for this process.
    pendingWhy = (!t.id || t._exited) ? 'idle'
      : (t._ctxNoSupport ? 'unsupported'
        : ((Number(t._ctxMisses) || 0) >= CTX_MAX_MISSES ? 'silent' : 'measuring'));
  }
  return {
    model: model,
    win: win,
    tokens: tokens,
    pct: pct,
    bar: Math.max(0, Math.min(100, pct)),
    level: pct > 85 ? 'hot' : pct > 60 ? 'warm' : '',
    unknownWin: !(win.value > 0),
    measured: both,
    pending: tokens.src === 'none',
    pendingWhy: pendingWhy,
    conflict: conflict,
    // which of the two contradicting statements is on screen (see (8)). The label itself is never rewritten
    // here: it belongs to the status strip, and this decision cannot know which of the two is wrong.
    shows: shows,
    // the proven lower bound in force for this variant — 0 when nothing was ever refuted (or the measurement just
    // refuted the bound itself, `healed`). Carried on the record
    // because the tooltip names the token count that proved it: „evidence, not a flag" has to survive the trip
    // from the store to the sentence, or the user is told „refused" with no reason.
    floor: floor,
    // WHY the 100 % line is where it is, in the CLI's own word (`autocompactSource`) — a field only the route
    // answer has, so it is '' for every derived window, and it is dropped together with a window the evidence
    // refuted (there is no ceiling left to explain).
    autocompact: win.src === 'measured' ? String((m && m.source) || '') : '',
    adopt: adopt,
    learn: learn,
    refuted: refuted,
    // a floor the MEASUREMENT just refuted (see (4)) — the caller removes that entry and reports it once
    healed: healed,
  };
}

// Is the window on screen worth one more control request at the next turn boundary? Every window that has not
// been MEASURED says yes — a `conflict`, no window at all („–"), and also a perfectly consistent derived one.
//
// WHY the consistent case belongs here, although it looks like „asking again for probably right": the
// arithmetic refutation in (8) is ONE-SIDED, and that is structural rather than accidental. `tokens > ceiling`
// can only ever falsify a window that is too SMALL. A window that is too LARGE is unfalsifiable by
// construction, because the real session auto-compacts at its real, smaller ceiling, so the count never
// reaches the over-claimed divisor: „≈ 15 % · 150.000 / 1.000.000" on a 200 K session grows to 199 000 and
// then compacts — never above 100 %, never a conflict, and under the old rule (conflict || unknownWin) never
// „in doubt" either, so the self-correction was blind to exactly the half it could not compute. The only thing
// that can ever catch an over-claim is a live measurement, so the probe budget is kept armed until one real
// measurement has confirmed or replaced the number.
//
// THE COST, stated: in the worst case this re-asks ONCE PER TURN BOUNDARY, for as long as no measurement
// lands. Four things keep that from becoming the polling this change deliberately avoided:
//   · the trigger — boundaries only (start · result · model · clear · compact). Never the 200 ms ticker, never
//     mid-turn, so the rate is bounded by how often the user sends something, not by a clock.
//   · one in flight per tab (ctxAskDecision `inflight`): a flurry of short turns cannot stack queries, and an
//     ordinary boundary that arrives mid-flight is dropped rather than queued.
//   · the first successful answer ENDS it: `win.src` becomes 'measured', doubt goes false, and the
//     two-silence budget governs again. The expensive state is therefore self-terminating.
//   · a CLI that cannot answer at all is remembered after its FIRST refusal („Unsupported control request
//     subtype" → `unsupported`) and is never asked again — that is the one case where an unbounded re-ask
//     would have been paid forever for nothing.
// A measurement the FLOOR refuses leaves the window unmeasured too, so it also keeps the budget armed — on
// purpose: only a BIGGER measurement can settle a session whose own evidence contradicts what the CLI reports,
// and the three bounds above (boundaries only · one in flight · the first ACCEPTED answer ends it) hold for it
// unchanged, so the cost is the same bounded one and never a poll.
// What remains is a CLI that silently times out: it then costs one (long) request per turn boundary instead
// of two per session. That is the price of being able to catch an over-claim at all, and it is paid only while
// the panel has never had a measurement. A visible consequence to be honest about: `pendingWhy: 'silent'`
// („CLI antwortet nicht") becomes nearly unreachable for an unmeasured window, because the budget is re-armed
// before each ask — the line says „wird gemessen…" instead, which is then simply true.
// Pure, and a seam on purpose — the caller feeds it straight into ctxAskDecision (`doubt`).
// The two clauses are NOT one rule written twice, and the difference is worth one line: a `conflict` can stand
// next to a MEASURED window (rows j and z4 — the CLI measured 200 000 while the label or the variant promises
// 1M), so it survives the source test below and has to be asked for separately. „No window at all" does not:
// every source that produces a number sets `win.value > 0`, so `unknownWin` can only be true while `src` is
// 'unknown', which the source test already catches. It used to be named here as well, and that term reddened
// nothing once B2 widened the test — the same shape as the second `!m.id` guard removed from
// ctxWindowFromUsage, and removed for the same reason. The row that pins the unknown case is byName('x') in
// the B2 test; the row that pins the conflict case is byName('j').
function ctxWindowInDoubt(rec) {
  if (!rec || typeof rec !== 'object') return false;
  if (rec.conflict) return true;
  return ((rec.win || {}).src !== 'measured');
}

// The painted SENTENCE, as a pure function of the record — because the thing the user reported was a
// string („Kontext 250 % · 500,8K / 200,0K"), and a table that only pins the record leaves the step from
// the record to that string untested: a painter that ignored `measured` would drop the „≈" and every row
// would stay green. The translated pieces and the number formatter are passed IN, so this file keeps its
// „no i18n, no DOM" rule: `txt.kontext` is the label's head, `txt.pending` the already-looked-up text for
// this record's `pendingWhy`.
function ctxGaugeLine(rec, txt, fmt) {
  var r = rec || {}, s = txt || {};
  var num = (typeof fmt === 'function') ? fmt : function (n) { return String(n); };
  var win = (r.unknownWin || !r.win) ? '–' : num(r.win.value);
  var head = (r.conflict ? '⚠ ' : '') + String(s.kontext == null ? '' : s.kontext);
  if (r.pending) return head + '· ' + String(s.pending == null ? '' : s.pending) + ' / ' + win;
  // No window → NO percentage. „≈ 0 % · 500,8K / –" printed the result of a division that never happened:
  // with an unknown divisor the ratio is unknown too, and a „0 %" next to half a million tokens is the one
  // reading that is certainly false. The token count is real, so it is shown — the ratio is simply absent.
  if (r.unknownWin) return head + '· ' + num(r.tokens.value) + ' / ' + win;
  return head + (r.measured ? '' : '≈ ') + Number(r.pct || 0).toFixed(0) + '% · ' + num(r.tokens.value) + ' / ' + win;
}

// The TOOLTIP, as the same kind of pure seam as ctxGaugeLine and for the same reason: two of its sentences
// were WRONG and nothing could see it. commands.js pushed ONE key for BOTH conflict kinds, so
//   · „variant-usage" (the CLI reported a smaller window than the wide variant promises, and the report was
//     refused) was described as „the model label promises 1M" — blaming a label that may not even mention
//     1M, and naming the wrong one of the two statements as the suspect; and
//   · „label-wide" whose promise comes from the VARIANT („Default" resolving to a „[1m]" model, where no
//     label says 1M at all) got that label sentence too, pointing at an innocent string.
// Returns the sentences as i18n KEYS, in order — so the table can assert them without a dictionary or a DOM:
//   { key }                — a plain sentence
//   { key, label: true }   — „{m}" is filled with the menu label by the caller
//   { key, num }           — a number is appended by the caller (formatted in its locale)
//   { key, text }          — a string the CLI itself used is appended verbatim (autocompactSource)
//   { warn: true }         — prefix „⚠"
function ctxTitleLines(rec) {
  var r = rec || {}, w = r.win || {}, tk = r.tokens || {}, mdl = r.model || {};
  var out = [{ key: 'commands.kontextFensterLautCli' }];
  out.push({ key: tk.measured ? 'commands.kontextQuelleGemessen' : 'commands.kontextQuelleHergeleitet' });
  // WHERE the window comes from — except when the evidence took it away: there is no source to name then, the
  // slot's „unknown" sentences would both be wrong („solange kein Modell benannt ist" over a tab whose model
  // the frames just named), and the one thing the user needs is WHICH of the two numbers beside each other is
  // in doubt. Two shapes of that: the refutation (`over-window`, the count beat the window on screen) and the
  // FLOOR with nothing left (`below-floor`, every source offered a window an earlier call already disproved) —
  // the latter's sentence is pushed below, where it also serves the case in which a bigger source survived.
  // An over-window from an ESTIMATE (`totalTokens`, a measured token count) is not „a single call carried more" —
  // no call was made — so it gets its own sentence: the window is open, nothing is remembered, the CLI is asked.
  if (r.conflict === 'over-window') {
    out.push({ key: tk.measured ? 'commands.kontextFensterUeberSchaetzung' : 'commands.kontextFensterWiderlegt', warn: true });
  } else if (r.conflict !== 'below-floor' || w.value > 0) out.push({ key: {
    measured: 'commands.kontextFensterGemeldet', session: 'commands.kontextFensterLetzterTurn',
    learned: 'commands.kontextFensterGelernt', name: 'commands.kontextFensterGeraten',
  }[w.src] || (mdl.varUnknown ? 'commands.kontextFensterVarianteUnbekannt' : 'commands.kontextFensterUnbekannt') });
  if (w.raw && w.raw !== w.value) out.push({ key: 'commands.kontextRohfenster', num: w.raw });
  // …and WHY that is the 100 % line, when the CLI said so: `autocompactSource` is its own answer to „whose
  // limit is this", and the tooltip is where this panel already names the CLI's fields verbatim (rawMaxTokens).
  if (r.autocompact) out.push({ key: 'commands.kontextGrenzeLautCli', text: r.autocompact });
  if (r.conflict === 'label-wide') {
    // which of the two promised the million decides which sentence is true. The variant is the stronger
    // statement (the session really asked for 1M), so it is named when it is the one promising.
    out.push(mdl.wide ? { key: 'commands.kontextVarianteWiderspruch', warn: true }
      : { key: 'commands.kontextLabelWiderspruch', label: true, warn: true });
  } else if (r.conflict === 'variant-usage') {
    out.push({ key: 'commands.kontextMeldungAbgelehnt', warn: true });
  } else if (r.conflict === 'below-floor') {
    // the evidence, with its number: „refused" without the count that refutes it is a flag, and a flag is what
    // the user cannot check. The same sentence whether a bigger source survived or the line now shows „–" —
    // except when the window on the line IS the measurement: that one was not refused (it never is), it is
    // contradicted, and „abgelehnt" over a number that is on screen would be false.
    out.push({ key: w.src === 'measured' ? 'commands.kontextMessungUnterBoden' : 'commands.kontextFensterUnterBoden', num: r.floor, warn: true });
  }
  if (r.shows === 'window') out.push({ key: 'commands.kontextZeigtFenster' });
  else if (r.shows === 'promise') out.push({ key: 'commands.kontextZeigtZusage' });
  else if (r.shows === 'tokens') out.push({ key: 'commands.kontextZeigtTokens' });
  // …and whether anybody is still going to settle it. „CLI kann nicht messen" is the one state where the
  // promise in the sentences above („Die CLI wird gefragt") would be false for the rest of this process.
  if (r.pendingWhy === 'unsupported') out.push({ key: 'commands.kontextKeineMessungMoeglichTooltip', warn: true });
  return out;
}

// A refused model switch is a SUBSTITUTION, not a no-op. The CLI's refusal names the model the session is
// now on — measured wording (2026-09-02): `set_model "claude-fable-5-1[1m]"` → „Model "claude-fable-5-1[1m]"
// is restricted by your organization's settings. Using claude-opus-5[1m] instead." Treating that as „the
// switch did not happen" left the panel on the model that was REFUSED: the strip, the per-turn price and
// every window decision were then about a model that is not running — the same „window of a model it is not
// running" this whole file exists for, arriving through the error path.
// Lives here because „which model is really running" is this file's first question (see ctxResolveModel).
// Returns the substituted id INCLUDING a „[1m]" suffix — that suffix is the variant and dropping it would
// re-create the bug one line later — or '' when the sentence names nothing usable; the caller then ASKS the
// session (get_settings) instead of guessing.
function ctxModelFromRefusal(msg) {
  // Anchored on the CLI's own „Using … instead" phrase: the id quoted at the FRONT of the message is the
  // refused wish, so „any model-shaped word" would pick exactly the wrong one of the two.
  var m = /\busing\s+["'`]?([A-Za-z0-9._:-]+(?:\[1m\])?)["'`]?\s+instead\b/i.exec(String(msg == null ? '' : msg));
  var id = m ? String(m[1]).replace(/[.,;:]+$/, '') : '';
  if (!id || ctxSyntheticModel(id)) return '';
  // A model id always carries a separator („claude-opus-5", „eu.anthropic.claude-opus-5-v1:0"); a bare word
  // („Using default instead") is prose, not an id. Rejecting it sends the caller to get_settings, which is
  // the safe direction — a guessed model would be stated as fact to the user and to the gauge.
  if (!/[-.]/.test(id)) return '';
  return id;
}

// A „/model X" TYPED into the composer (05.10., Julian's own way of switching). The CLI takes it as a local
// command and switches the session, but nothing in the panel saw it: `tab.modelSel` kept the old value, the
// frames name the new model without „[1m]" (they never carry it), and ctxResolveModel then read the selector as
// being about ANOTHER model — variant unknown, the line „… / –". Recomputed with the real menu entries from
// /api/models: the same numbers under the selection „Opus 5.5 (1M)" give „/ 1,0M".
// The argument of a message that is NOTHING BUT „/model <arg>" — '' for anything else: „/model" alone opens the
// CLI's picker (nothing to adopt), and a sentence that merely mentions „/model x" is a sentence. One token only:
// model ids carry no spaces, and „[1m]" is part of the token.
function ctxTypedModelArg(text) {
  var m = /^\/model[ \t]+(\S+)$/.exec(String(text == null ? '' : text).trim());
  return m ? m[1] : '';
}
// Did the CLI CONFIRM the typed switch? The panel does not take the wish for the fact — the same rule
// applyLiveModel follows for its own `set_model` (a refusal can substitute another model): the switch counts
// once a frame (`assistant` or `init`) names a model that is the argument's. `served` is the id the frame
// carries, `argResolves` what the menu entry with exactly that value stands for ('' when the menu has none).
// Returns 'confirm' · 'reject' · '' (no verdict: no model named, or the CLI's own „<synthetic>" sender).
// Matching is by the normalized MODEL id — never by variant, because the frames never carry „[1m]"; the
// variant comes from the argument itself when the selection is adopted. A family alias („opus", „sonnet[1m]")
// has no id of its own unless the menu resolves it, so a bare family word matches a served id of that family.
// „default" is the CLI's way back to settings.json's model: matched against the „Default" entry's `resolves`
// when the menu has one, and confirmed by any real model otherwise — nothing in the tab could check it, and the
// „Default" selection makes no variant claim the gauge could be misled by (ctxResolveModel varUnknown).
function ctxTypedModelVerdict(arg, served, argResolves) {
  var s = String(served == null ? '' : served);
  if (!s || ctxSyntheticModel(s)) return '';
  var a = String(arg == null ? '' : arg);
  var want = ctxNormModel(argResolves || a);
  var got = ctxNormModel(s);
  if (!want || !got) return '';
  if (/^default$/i.test(a) && !argResolves) return 'confirm';
  if (want === got) return 'confirm';
  if (!/[-.]/.test(want) && new RegExp('(^|-)' + want.replace(/[^a-z0-9]/g, '') + '(-|$)').test(got)) return 'confirm';
  return 'reject';
}
// …and WHEN a verdict may be acted on — the timing half, which is about the frame and not about the model ids.
// `pending` is tab._modelPending ({ arg, from, sawResult }: `from` the model the tab ran when the /model went out),
// `via` 'frame' (an `assistant` frame) or 'init'. Returns 'confirm' · 'reject' · '' (no verdict YET).
//   · a REJECTION needs an `assistant` frame after the command's own turn end (`sawResult`): an `init` may precede
//     the command's processing, and earlier frames may belong to a turn the CLI began before it read the /model.
//   · a confirmation from an `init` must also agree on the VARIANT: an init carries the „[1m]" suffix (a frame never
//     does), so an init naming the right model in the other variant — the previous one, before the command was
//     processed — confirms nothing (counter-check of 05.10.: verdict('…opus-5[1m]', '…opus-5') was 'confirm').
//     „default" is exempt: its variant is settings.json's business, and the „Default" selection claims none.
//   · and a switch of the VARIANT ONLY — the argument already names the model that was running (`from`), e.g.
//     „/model opus" out of „opus[1m]" — cannot be confirmed by a model id at all: every frame of the OLD session
//     names the same model. So no init confirms it, and a frame only after the command's own turn end, i.e. one
//     of the next turn, which the CLI answers on the switched session. (What is still not caught: a CLI that
//     refuses a variant switch without an error `result` — the next frame names the same model either way.
//     Only the CLI's own `model` in get_context_usage, which carries the suffix, could tell; docs/ideas.md P11.)
function ctxTypedModelSettle(pending, served, via, argResolves) {
  var p = (pending && typeof pending === 'object') ? pending : null;
  if (!p) return '';
  var verdict = ctxTypedModelVerdict(p.arg, served, argResolves);
  if (!verdict) return '';
  var byFrame = via === 'frame';
  if (verdict === 'reject') return (byFrame && p.sawResult) ? 'reject' : '';
  var arg = String(p.arg == null ? '' : p.arg);
  if (!byFrame && !/^default$/i.test(arg) && ctxIsWide(arg) !== ctxIsWide(served)) return '';
  var variantOnly = !!p.from && ctxTypedModelVerdict(arg, p.from, argResolves) === 'confirm';
  if (variantOnly && !(byFrame && p.sawResult)) return '';
  return 'confirm';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    // ctxEntryWindow and CTX_NAME_WINDOWS are deliberately NOT exported: they are reached through
    // ctxWindowFromUsage / ctxNameWindow, and a test that pokes the table directly would be a second
    // statement of the same rule — which is how the last round ended up with a test re-implementing a
    // function the panel no longer had.
    ctxNormModel, ctxVariantKey, ctxIsWide, ctxSyntheticModel, ctxResolveModel,
    ctxTokensOfFrame, ctxUsageTokens, ctxVariantFits,
    ctxWindowFromUsage, ctxLearnEntries, ctxStoreMerge, ctxLearnedWindow, ctxNameWindow,
    ctxSourceCeiling, ctxBelowFloor, ctxFloorEntry, ctxFloorAt, ctxFloorMerge, ctxFloorDrop,
    ctxFloorStoreClean, ctxWindowStoreClean,
    ctxWindowRefuted, ctxReportedRefuted, ctxSavedRefuted,
    ctxFromRoute, ctxAskDecision, ctxProbeUnsupported, ctxWindowInDoubt,
    ctxDecide, ctxGaugeLine, ctxTitleLines, ctxModelFromRefusal, ctxTypedModelArg, ctxTypedModelVerdict,
    ctxTypedModelSettle,
    ctxBumpGen, ctxGenOf, ctxStamp, ctxStampOf, ctxAnswerUsable, ctxAskedAt,
    ctxNoteFrame, ctxNoteBeaten, ctxForgetModel, ctxForgetContext, ctxWindowSave, ctxWindowLoad,
    CTX_WIDE_WINDOW, CTX_MAX_MISSES,
  };
}
