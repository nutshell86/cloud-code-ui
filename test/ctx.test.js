'use strict';
// The context gauge showed a number that could not be true — a tab on „Opus 5 (1M)" reading
// „Kontext 250 % · 500,8K / 200,0K", i.e. the window of a model it was not running. Two rounds of patching
// produced 13 and then 15 more defects without killing it, because the window had FIVE independent sources
// with five freshness rules and every review found new COMBINATIONS rather than new bugs.
//
// So the precedence is ONE pure function now (ctx.js ctxDecide) and this file pins it with ONE TABLE: one
// row per (source availability × variant case), each asserting the WHOLE returned record. That is the
// structural point — a newly discovered path has to be expressible as a ROW, and a missing row shows up as
// a gap in the table instead of as a bug in the field.
//
// The fixtures are NOT invented: the frames are a real probe run (claude 2.1.x, 2026-09-10, `-p` with one
// Read tool call), the route answer and the per-model windows are the control-request probe of 2026-10-02
// (sonnet-5 1M · opus-5 200K · opus-5[1m] 1M · opus-5-5[1m] 1M · haiku-4-5 200K; totalTokens moves with the
// model: 34 021 sonnet-5 vs 18 529 opus-5).
// RE-MEASURED 2026-10-06 under CLI 2.1.291 (free, no model turn): the bare opus-5 answers 1 000 000 now, like
// opus-5-5, sonnet-5, sonnet-5-5 and opus-4-8; haiku-4-5 is the only one left at 200 000, and ctx.js
// CTX_NAME_WINDOWS says exactly that. Two consequences for the fixtures below:
//  · every row and test that needs the NAME TABLE to offer 200 000 (the constant a deletion cannot reach, the
//    window a pending line is measured against) uses claude-haiku-4-5 since then — it was claude-opus-5 before,
//    which the table no longer lists at 200 000;
//  · the measured / learned / session 200 000 for opus-5 elsewhere stay as they are. They stand for what an
//    older CLI (02.10., 2.1.286) really reported for that model, and the decision never compares a measurement or a store with
//    the name table — it only falls back to the table when none of them offers a number the decision accepts. (Checked both ways: on the suite as
//    it stood, setting the opus-5 entry to 1 000 000, to a sentinel or deleting it changed the outcome of
//    exactly the tests now on haiku-4-5, plus the two that pin the entry itself; on the suite as it is now,
//    setting it back to 200 000, to a sentinel or deleting it reaches only those two pins.)
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  ctxNormModel, ctxVariantKey, ctxIsWide, ctxSyntheticModel, ctxResolveModel,
  ctxTokensOfFrame, ctxUsageTokens, ctxVariantFits,
  ctxWindowFromUsage, ctxLearnEntries, ctxStoreMerge, ctxLearnedWindow, ctxNameWindow,
  ctxSourceCeiling, ctxBelowFloor, ctxFloorEntry, ctxFloorAt, ctxFloorMerge, ctxFloorDrop,
  ctxFloorStoreClean, ctxWindowStoreClean, ctxTypedModelArg, ctxTypedModelVerdict,
  ctxWindowRefuted, ctxReportedRefuted, ctxSavedRefuted,
  ctxFromRoute, ctxAskDecision, ctxProbeUnsupported, ctxWindowInDoubt,
  ctxDecide, ctxGaugeLine, ctxTitleLines, ctxModelFromRefusal,
  ctxBumpGen, ctxGenOf, ctxStamp, ctxStampOf, ctxAnswerUsable, ctxAskedAt,
  ctxNoteFrame, ctxNoteBeaten, ctxForgetModel, ctxForgetContext, ctxWindowSave, ctxWindowLoad,
  CTX_WIDE_WINDOW, CTX_MAX_MISSES,
} = require('../public/js/ctx');

// --- the probe: three assistant frames and the result they produced -----------------------------------
const FRAMES = [
  { input_tokens: 2, cache_creation_input_tokens: 38955, cache_read_input_tokens: 0, output_tokens: 2 },
  { input_tokens: 2, cache_creation_input_tokens: 38955, cache_read_input_tokens: 0, output_tokens: 2 },
  { input_tokens: 2, cache_creation_input_tokens: 3306, cache_read_input_tokens: 38955, output_tokens: 3 },
];
const RESULT_USAGE = { // note: cache_creation = 38 955 + 3 306 — the SUM over the turn
  input_tokens: 4, cache_creation_input_tokens: 42261, cache_read_input_tokens: 38955, output_tokens: 527,
};
// `get_context_usage` on a fresh 200 K session (opus-5, CLI 2.1.288 — see the header for 2.1.291). `categories`/`gridRows` are the display grid —
// ~8 KB of it, and `detail: 'summary'` is ignored — which is why this is asked at the turn boundaries and
// never polled during a turn. There is no `contextWindow` field in this answer; `maxTokens` is the 100 % line.
const ROUTE_ANSWER = {
  totalTokens: 18529, maxTokens: 200000, rawMaxTokens: 200000, percentage: 9,
  autocompactSource: 'model-default',
  categories: [{ name: 'System prompt', tokens: 3200, kind: 'used' }, { name: 'Free space', tokens: 181471, kind: 'free' }],
};
// What the CLI's `result.modelUsage` really looks like on Bedrock: the keys carry the gateway prefix and a
// -vN, they never carry „[1m]" (the selector does), and a haiku side-call sits in the same object with a
// different window. Its counters are CUMULATIVE over the session, which is what made the side-call win.
const BEDROCK_USAGE = {
  'eu.anthropic.claude-opus-5-v1:0': { inputTokens: 20, cacheReadInputTokens: 18500, cacheCreationInputTokens: 0, contextWindow: 1000000 },
  'eu.anthropic.claude-haiku-4-5-20251001-v1:0': { inputTokens: 500000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 200000 },
};
// A measurement, as ctxProbe stores it: ctxFromRoute's fields plus the generation and the stamp it was
// ASKED at (ctx.js compares both with `===`). `hasTok` mirrors what ctxFromRoute derives — „the answer
// carried a totalTokens field" — because 0 is a legal count and the number alone cannot say whether it was
// measured or simply absent.
const measured = (o) => Object.assign(
  { tokens: 0, win: 0, raw: 0, pct: 0, hasPct: false, hasTok: !!(o && o.tokens != null), source: '', gen: 0, stamp: 0 }, o);
// A PROVEN floor entry, as cc_ctx_floors stores it since 05.10. (ctx.js „PROVENANCE"): the count one accepted
// call carried, where it came from, and when. Before that round the store held bare numbers, and the rows below
// used them; a bare number is a legacy entry now and reads as no floor at all (row j1 is that case), so the rows
// that are ABOUT a floor state it in the shape that is one. `at: 1` — younger than a measurement without a
// clock (`measured()` carries none, i.e. 0), so a measured row only heals a floor when it says it is younger.
const FL = (below, at) => ({ below, src: 'frame', at: at == null ? 1 : at });
// …and the bounds a store holds, as plain numbers — what the assertions are about (`at` is the clock of the run).
const bounds = (floors) => Object.fromEntries(Object.keys(floors || {}).map((k) => [k, ctxFloorAt(floors, k)]));

// =====================================================================================================
//  THE TABLE — one row per (source availability × variant case), whole record asserted
//  `finding` names the round-2 defect the row converts, where there is one.
// =====================================================================================================
const ROWS = [
  {
    name: 'a) measured window + measured tokens, same variant → measured, no „≈"',
    finding: 'C-round2: „measured" claimed for pairs that were not both measured',
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 42263, ctxStamp: 3,
      ctxMeasured: measured({ tokens: 18529, win: 200000, raw: 200000, pct: 9, hasPct: true, source: 'model-default', stamp: 3 }),
    },
    env: { known: {}, resolves: 'claude-opus-5', label: 'Opus 5' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 200000, src: 'measured', measured: true, raw: 200000 },
      tokens: { value: 18529, src: 'measured', measured: true },
      pct: 9, bar: 9, level: '', unknownWin: false, measured: true,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: { win: 200000, key: 'claude-opus-5' }, learn: [{ key: 'claude-opus-5', win: 200000 }],
      // F3 — the CLI says WHY 200 000 is the 100 % line, and that answer now reaches the tooltip instead of
      // being read into a field nobody consumed. It exists on the MEASURED source only (see row b).
      autocompact: 'model-default',
    },
    line: 'Kontext 9% · 18.529 / 200.000',
    title: ['commands.kontextFensterLautCli', 'commands.kontextQuelleGemessen',
      'commands.kontextFensterGemeldet', 'commands.kontextGrenzeLautCli'],
  },
  {
    name: 'b) measured TOKENS but no maxTokens → window from elsewhere, not measured, „≈", and the CLI\'s own percentage is dropped',
    finding: 'round 2 set „measured" from the token count alone; the CLI % then stood next to a foreign window',
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 42263, ctxStamp: 3,
      ctxMeasured: measured({ tokens: 18529, win: 0, raw: 0, pct: 9, hasPct: true, stamp: 3 }),
    },
    env: { known: { 'claude-opus-5': 200000 }, resolves: 'claude-opus-5', label: 'Opus 5' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 200000, src: 'learned', measured: false, raw: 0 },
      tokens: { value: 18529, src: 'measured', measured: true },
      pct: 9.26, bar: 9.26, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: null, learn: [],
    },
    line: 'Kontext ≈ 9% · 18.529 / 200.000',
  },
  {
    name: 'b2) …the same for a window from this session\'s result: one measured half does not make the pair measured',
    finding: 'round 2: „measured" was a property of the LINE, not of each half of it',
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 42263, ctxStamp: 2,
      ctxMeasured: measured({ tokens: 18529, win: 0, pct: 9, hasPct: true, stamp: 2 }),
    },
    env: {
      known: {}, resolves: 'claude-opus-5', label: 'Opus 5',
      usage: { now: { 'claude-opus-5': { inputTokens: 10, contextWindow: 200000 } } },
    },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 200000, src: 'session', measured: false, raw: 0 },
      tokens: { value: 18529, src: 'measured', measured: true },
      pct: 9.26, bar: 9.26, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: { win: 200000, key: 'claude-opus-5' }, learn: [{ key: 'claude-opus-5', win: 200000 }],
    },
  },
  {
    name: 'c) „Default" whose resolved model is the 1M variant → wide treatment, the learned 200 K refused',
    finding: 'round 2: „Default" (menu value "") carried no „[1m]", so the whole wide refusal was bypassed',
    tab: { id: 'c1', model: 'claude-opus-5', modelSel: '', ctxTokens: 500800, ctxStamp: 2 },
    env: { known: { 'claude-opus-5': 200000 }, sel: '', resolves: 'eu.anthropic.claude-opus-5[1m]', label: 'Default' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5[1m]', wide: true, varUnknown: false, src: 'frame' },
      win: { value: 1000000, src: 'name', measured: false, raw: 0 },
      tokens: { value: 500800, src: 'frames', measured: false },
      pct: 50.08, bar: 50.08, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: null, learn: [],
    },
    line: 'Kontext ≈ 50% · 500.800 / 1.000.000',
  },
  {
    name: 'd) „Default" resolving to the 200 K variant while a single call carried 500 800 → the FRAMES refute the window',
    finding: 'C1: this row used to assert that 250 % „is then the TRUTH" — it cannot be',
    // Re-stated: a 200 K-window model cannot RECEIVE a 500 K context. One `assistant` frame is one API call
    // and that call was accepted, so the count is evidence and the learned 200 000 is an inference the
    // evidence kills — „250 % · 500,8K / 200,0K" is not a context that is two and a half times full, it is
    // the reported bug's own sentence. So the window goes („–"), the ratio goes with it (no divisor), the
    // token count stays, and the ⚠ plus the tooltip say WHICH of the two numbers is in doubt.
    // The same shape is what a „/model opus[1m]" typed into the composer leaves behind — the CLI switches
    // the session's variant, applyLiveModel never runs and the frames never carry „[1m]" — which is why this
    // rule needs no knowledge of that path.
    tab: { id: 'c1', model: 'claude-opus-5', modelSel: '', ctxTokens: 500800, ctxStamp: 2 },
    env: { known: { 'claude-opus-5': 200000 }, sel: '', resolves: 'eu.anthropic.claude-opus-5', label: 'Default' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 0, src: 'unknown', measured: false, raw: 0 },
      tokens: { value: 500800, src: 'frames', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: true, measured: false,
      pending: false, pendingWhy: '', conflict: 'over-window', shows: 'tokens',
      adopt: null, learn: [],
      // B1 — and the learned 200 000 that produced this line is WITHDRAWN, not merely not re-written: it was
      // filed on an earlier turn, cc_ctx_windows is shared by every tab and every future session, and
      // `tab.ctxReported` is persisted too. `below` is the evidence (the count one accepted call carried), so
      // the entries smaller than it go and a bigger one is left alone. The whole cycle has its own rows.
      // 05.10. — and it says where it came from: a FRAME count (ctxFloorMerge files nothing without that).
      refuted: { key: 'claude-opus-5', below: 500800, src: 'frame' },
    },
    line: '⚠ Kontext · 500.800 / –',
    title: ['commands.kontextFensterLautCli', 'commands.kontextQuelleHergeleitet',
      'commands.kontextFensterWiderlegt', 'commands.kontextZeigtTokens'],
  },
  {
    name: 'd2) …and a MEASURED window is refuted the same way: a frame that arrived later is younger evidence',
    finding: 'C1 — the path that stays open if only derived windows are checked (the composer /model switch)',
    // The CLI measured 200 000 at the last turn boundary; then the session's variant changed where nothing in
    // the tab can see it and a call carried 500 800. The measurement is not REPLACED by something more
    // plausible (§3 forbids that) — the panel simply stops claiming a window it can prove wrong, and the
    // re-armed probe asks again at the next boundary. Nothing is filed either: the learned store is shared
    // and would hand the refuted 200 000 to the next tab whose context is still small enough to not notice.
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 500800, ctxStamp: 9,
      ctxMeasured: measured({ tokens: 18529, win: 200000, raw: 200000, pct: 9, hasPct: true, stamp: 3 }),
    },
    env: { known: {}, resolves: 'claude-opus-5', label: 'Opus 5' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 0, src: 'unknown', measured: false, raw: 0 },
      tokens: { value: 500800, src: 'frames', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: true, measured: false,
      pending: false, pendingWhy: '', conflict: 'over-window', shows: 'tokens',
      adopt: null, learn: [],
      // CHANGED 05.10. — this row used to file `refuted` here too, i.e. a FLOOR of 500 800 above the CLI's own
      // measurement. Since then a measurement outranks every floor and refutes the ones above it (ctx.js „THE
      // FLOOR", point 5): filed here, the bound would be removed by the very next read of this same answer — a
      // write/delete treadmill — and it is no evidence about the KEY either: the CLI measured 200 000 for
      // „claude-opus-5" and a call carried 500 800 in the same tab, which most likely means the variant changed
      // under the key (the typed „/model", tracked at the source since that round), not that the bare variant is
      // bigger. A floor stamped onto the bare key there would refuse the bare variant's genuine window in every
      // other tab — the over-reach „THE FLOOR" exists to rule out. So: dropped from the line, filed nowhere.
      refuted: null,
    },
    line: '⚠ Kontext · 500.800 / –',
  },
  {
    name: 'd2b) …and once the count DROPS in the same generation, the beaten measurement does not come back unmarked',
    finding: 'counter-check F2: d2 filed nothing any more, so 200 000 / 500 800 / 120 000 read „≈ 60 % · 120.000 / 200.000" again',
    // d2 one frame later: the context shrank without a compaction boundary (no new generation). The measurement
    // carries the count that beat it (`beaten`, ctxNoteBeaten — written when that frame arrived), so it is no
    // candidate any more, and the same count bounds the derived sources of THIS decision: the name table's
    // identical 200 000 is refused as well. Nothing is filed (`refuted` null — the d2 reasoning holds), and the
    // bound dies with the measurement (next answer, next generation). The line is main's, without main's floor.
    // On claude-haiku-4-5 since 06.10. (it was d2's opus-5): the name table has to OFFER that identical 200 000
    // for the refusal to be observable, and since CLI 2.1.291 haiku-4-5 is the only model it lists below 1M —
    // with opus-5 at 1 000 000 the table's number clears the bound (that is row d2c), and the refusal this row
    // is about never happens.
    tab: {
      id: 'c1', model: 'claude-haiku-4-5', modelSel: 'claude-haiku-4-5', ctxTokens: 120000, ctxStamp: 10,
      ctxMeasured: measured({ tokens: 18529, win: 200000, raw: 200000, pct: 9, hasPct: true, stamp: 3, beaten: 500800 }),
    },
    env: { known: {}, resolves: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    want: {
      model: { id: 'claude-haiku-4-5', key: 'claude-haiku-4-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 0, src: 'unknown', measured: false, raw: 0 },
      tokens: { value: 120000, src: 'frames', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: true, measured: false,
      pending: false, pendingWhy: '', conflict: 'below-floor', shows: 'tokens',
      adopt: null, learn: [], floor: 500800, refuted: null,
    },
    line: '⚠ Kontext · 120.000 / –',
    title: ['commands.kontextFensterLautCli', 'commands.kontextQuelleHergeleitet',
      'commands.kontextFensterUnterBoden', 'commands.kontextZeigtTokens'],
  },
  {
    name: 'd2c) …while a derived window ABOVE the count that beat it still gets through — marked, both numbers shown',
    finding: 'the beaten count is a bound like a floor: it refuses smaller windows, it does not blank the line',
    // „claude-sonnet-5": the name table says 1 000 000, which a 500 800-token call does not contradict.
    tab: {
      id: 'c1', model: 'claude-sonnet-5', modelSel: 'claude-sonnet-5', ctxTokens: 120000, ctxStamp: 10,
      ctxMeasured: measured({ tokens: 18529, win: 200000, raw: 200000, stamp: 3, beaten: 500800 }),
    },
    env: { known: {}, resolves: 'claude-sonnet-5', label: 'Sonnet 5' },
    want: {
      model: { id: 'claude-sonnet-5', key: 'claude-sonnet-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 1000000, src: 'name', measured: false, raw: 0 },
      tokens: { value: 120000, src: 'frames', measured: false },
      pct: 12, bar: 12, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: 'below-floor', shows: '',
      adopt: null, learn: [], floor: 500800, refuted: null,
    },
    line: '⚠ Kontext ≈ 12% · 120.000 / 1.000.000',
  },
  {
    name: 'd3) …but a context BETWEEN maxTokens and rawMaxTokens is legal and must not be refuted — for a MEASURED window',
    finding: 'C1, the false positive: `pct > 100` would throw away a window that is right',
    // `maxTokens` is the line the CLI auto-compacts at, `rawMaxTokens` the model's raw window. They were
    // identical in every measurement, but the panel must not decide they are the same forever — so the test
    // is the token count against the BIGGER of the two, and 190 000 in a 180 000/200 000 pair stays a ratio
    // over 100 % rather than becoming „–".
    // B3 — „the bigger of the two" exists only HERE. `rawMaxTokens` is a field of the route answer, so only
    // the MEASURED source has a raw window; session · learned · name are a single bare number with nothing
    // larger beside them, and for those the ceiling is the number itself (row d4 is this row's mirror). The
    // old expression max(win, raw) read as if all four sources had one and silently compared against 0 for
    // three of them — which is why this row has to say which source it is about.
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 190000, ctxStamp: 9,
      ctxMeasured: measured({ tokens: 0, hasTok: false, win: 180000, raw: 200000, stamp: 3 }),
    },
    env: { known: {}, resolves: 'claude-opus-5', label: 'Opus 5' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 180000, src: 'measured', measured: true, raw: 200000 },
      tokens: { value: 190000, src: 'frames', measured: false },
      pct: 105.56, bar: 100, level: 'hot', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: { win: 180000, key: 'claude-opus-5' }, learn: [{ key: 'claude-opus-5', win: 180000 }],
    },
    line: 'Kontext ≈ 106% · 190.000 / 180.000',
  },
  {
    name: 'd4) …and the DERIVED mirror of d3 IS refuted: a learned 180 000 has no raw window beside it',
    finding: 'B3 — `raw` was carried on the measured source only, so the rule refuted a state d3 calls legal',
    // The same numbers as d3, with the window coming from the learned store instead of from the CLI. There is
    // no `rawMaxTokens` for a learned number — nobody reported one — so there is no region between „the
    // compaction line" and „the raw window" in which 190 000 could be legal: a call that carried 190 000 proves
    // the real window is bigger than 180 000, and the inference loses against the evidence. The alternative
    // would be to invent a raw for the derived sources, i.e. a guess about a guess; this row is what goes red
    // if that is ever done, and d3 is what goes red if the measured source loses its raw.
    // „claude-opus-7" so that nothing but the store can answer: the name table knows no such model.
    tab: { id: 'c1', model: 'claude-opus-7', modelSel: 'claude-opus-7', ctxTokens: 190000, ctxStamp: 9 },
    env: { known: { 'claude-opus-7': 180000 }, resolves: 'claude-opus-7', label: 'Opus 7' },
    want: {
      model: { id: 'claude-opus-7', key: 'claude-opus-7', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 0, src: 'unknown', measured: false, raw: 0 },
      tokens: { value: 190000, src: 'frames', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: true, measured: false,
      pending: false, pendingWhy: '', conflict: 'over-window', shows: 'tokens',
      adopt: null, learn: [], refuted: { key: 'claude-opus-7', below: 190000, src: 'frame' },
    },
    line: '⚠ Kontext · 190.000 / –',
  },
  {
    name: 'e) the store holds only the model-wide 200 K, the tab is „[1m]" → the 200 K is refused',
    finding: 'C1: the „[1m]" tab inherited the model-wide entry and painted „250 % · 500,8K / 200,0K"',
    tab: { id: 'c1', model: 'claude-opus-7', modelSel: 'claude-opus-7[1m]', ctxTokens: 0, ctxStamp: 0 },
    env: { known: { 'claude-opus-7': 200000 }, resolves: 'claude-opus-7', label: 'Opus 7 (1M)' },
    want: {
      model: { id: 'claude-opus-7', key: 'claude-opus-7[1m]', wide: true, varUnknown: false, src: 'frame' },
      // A model nobody has ever measured, so the learned 200 000 of the OTHER variant is all there is — and
      // it is refused. What answers instead is the „[1m]" contract (1M, measured on three wide spellings),
      // not „unknown": a wide spelling always has that one piece of evidence about itself. Unknown is
      // reachable for a BARE spelling only — row f.
      win: { value: 1000000, src: 'name', measured: false, raw: 0 },
      tokens: { value: 0, src: 'none', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: false, measured: false,
      pending: true, pendingWhy: 'measuring', conflict: '', shows: '',
      adopt: null, learn: [],
    },
    line: 'Kontext · MESSE / 1.000.000',
  },
  {
    name: 'f) the store holds a „[1m]" entry, the tab is the bare model → unknown, NOT 1M',
    finding: 'C1 mirrored: the 200 K variant reading the wide variant\'s entry',
    tab: { id: 'c1', model: 'claude-opus-7', modelSel: 'claude-opus-7', ctxTokens: 0, ctxStamp: 0 },
    env: { known: { 'claude-opus-7[1m]': 1000000 }, resolves: 'claude-opus-7', label: 'Opus 7' },
    want: {
      model: { id: 'claude-opus-7', key: 'claude-opus-7', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 0, src: 'unknown', measured: false, raw: 0 },
      tokens: { value: 0, src: 'none', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: true, measured: false,
      pending: true, pendingWhy: 'measuring', conflict: '', shows: '',
      adopt: null, learn: [],
    },
    line: 'Kontext · MESSE / –',
  },
  {
    name: 'g) modelUsage names the model that ANSWERED and a different one that was asked for → the answerer wins',
    finding: 'C6: trying the selector first handed the turn the window of the model that did not serve it',
    tab: { id: 'c1', model: 'claude-haiku-4-5', modelSel: 'claude-opus-5[1m]', ctxTokens: 40000, ctxStamp: 1 },
    env: {
      known: {}, resolves: 'claude-opus-5', label: 'Haiku 4.5',
      usage: { now: {
        'claude-opus-5': { inputTokens: 10, contextWindow: 1000000 },       // asked for, did not answer
        'claude-haiku-4-5': { inputTokens: 40000, contextWindow: 200000 },  // the frames name this one
      } },
    },
    want: {
      // the selector's „[1m]" names ANOTHER model here, so it is no evidence about this one — which also
      // means nothing in this tab says which VARIANT the answering model runs (varUnknown). Harmless for what
      // is SHOWN: the window comes from this session's own result, and a measurement needs no spelling.
      model: { id: 'claude-haiku-4-5', key: 'claude-haiku-4-5', wide: false, varUnknown: true, src: 'frame' },
      win: { value: 200000, src: 'session', measured: false, raw: 0 },
      tokens: { value: 40000, src: 'frames', measured: false },
      pct: 20, bar: 20, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      // C2 — and NOT harmless for what is WRITTEN: both stores are keyed by variant, and with the variant
      // unknown the key would be the bare one by default. The CLI's own `modelUsage` keys never carry „[1m]",
      // so „claude-haiku-4-5: 200 000" says nothing about which variant served this turn — it is filed
      // nowhere, exactly as the two variant-keyed READ sources abstain in this state.
      // CHANGED 05.10. — the entry for the OTHER model used to be filed as „claude-opus-5: 1 000 000", under the
      // BARE key. Its key is bare only because the CLI's keys always are, and this row says so itself: that model
      // was asked for as „claude-opus-5[1m]". 1 000 000 is a number both variants can have, so the bare key was
      // a guess — the same variant-blind write that left „eu.anthropic.claude-opus-5": 1 000 000 in Julian's
      // store while the bare opus-5 measured 200 000 (ctxLearnEntries). Below 1M it is still filed (row r).
      adopt: null,
      learn: [],
    },
  },
  {
    name: 'h) a measurement older than the current generation → discarded, falls through',
    finding: 'C2/round 2: the reset counter let a capture from the previous model outrank the new one\'s frames',
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 21000, ctxStamp: 6, _ctxGen: 2,
      ctxMeasured: measured({ tokens: 500800, win: 1000000, raw: 1000000, pct: 50, hasPct: true, gen: 1, stamp: 5 }),
    },
    env: { known: { 'claude-opus-5': 200000 }, resolves: 'claude-opus-5', label: 'Opus 5' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 200000, src: 'learned', measured: false, raw: 0 },
      tokens: { value: 21000, src: 'frames', measured: false },
      pct: 10.5, bar: 10.5, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: null, learn: [],
    },
  },
  {
    name: 'i) nothing at all → unknown, the line paints „–" and says it was never started',
    tab: {},
    env: { known: {} },
    want: {
      model: { id: '', key: '', wide: false, varUnknown: false, src: '' },
      win: { value: 0, src: 'unknown', measured: false, raw: 0 },
      tokens: { value: 0, src: 'none', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: true, measured: false,
      pending: true, pendingWhy: 'idle', conflict: '', shows: '',
      adopt: null, learn: [],
    },
    line: 'Kontext · NOCH-NICHT / –',
  },
  {
    name: 'j) label and number contradict → ⚠, and the line shows the NUMBER (the measurement of this session)',
    finding: 'CTX-7: „Opus 5 (1M)" over a 200 000 window',
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5[1m]', ctxTokens: 0, ctxStamp: 1,
      ctxMeasured: measured({ tokens: 18529, win: 200000, raw: 200000, pct: 9, hasPct: true, source: 'model-default', stamp: 1 }),
    },
    env: { known: {}, resolves: 'claude-opus-5', label: 'Opus 5 (1M)' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5[1m]', wide: true, varUnknown: false, src: 'frame' },
      // ungated ON PURPOSE: the route answer is the CLI talking about THIS session, never an inheritance
      win: { value: 200000, src: 'measured', measured: true, raw: 200000 },
      tokens: { value: 18529, src: 'measured', measured: true },
      pct: 9, bar: 9, level: '', unknownWin: false, measured: true,
      pending: false, pendingWhy: '', conflict: 'label-wide', shows: 'window',
      // …and it is NOT filed: a 200 000 measured while „[1m]" was asked for belongs to no variant we can name
      adopt: null, learn: [], autocompact: 'model-default',
    },
    line: '⚠ Kontext 9% · 18.529 / 200.000',
  },
  {
    name: 'k) the reported line itself: „[1m]" tab, 500 800 derived, only the model-wide 200 K learned',
    finding: 'the user\'s symptom — must read 50 % of 1 000 000, never 250 % of 200 000',
    tab: { id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5[1m]', ctxTokens: 500800, ctxStamp: 4 },
    env: { known: { 'claude-opus-5': 200000 }, resolves: 'claude-opus-5', label: 'Opus 5 (1M)' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5[1m]', wide: true, varUnknown: false, src: 'frame' },
      win: { value: 1000000, src: 'name', measured: false, raw: 0 },
      tokens: { value: 500800, src: 'frames', measured: false },
      pct: 50.08, bar: 50.08, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: null, learn: [],
    },
    line: 'Kontext ≈ 50% · 500.800 / 1.000.000',
  },
  {
    name: 'k2) …and the „[1m]" contract against the NAME TABLE: a wide spelling never takes its bare row, not even a 200 000 one',
    finding: '06.10. — row k could no longer tell the two apart: under CLI 2.1.291 the bare opus-5 row is 1 000 000 too',
    // Until the 06.10. measurement row k proved this as well: the bare opus-5 row was 200 000, so a lookup that
    // dropped the suffix (wide spelling → bare row) printed the reported „250 % · 500,8K / 200,0K" there. Now that
    // row says 1 000 000 — the very number the contract gives — and k stays green under exactly that defect. The
    // one row below 1M is haiku-4-5, so the contract is pinned on it. „claude-haiku-4-5[1m]" is a spelling no menu
    // offers; the contract is about spellings („[1m]" asks for the 1M window, never for a smaller one), which is
    // why a hypothetical one is the honest fixture here rather than an invented window for a real one.
    tab: { id: 'c1', model: 'claude-haiku-4-5', modelSel: 'claude-haiku-4-5[1m]', ctxTokens: 500800, ctxStamp: 4 },
    env: { known: {}, resolves: 'claude-haiku-4-5', label: 'Haiku 4.5 (1M)' },
    want: {
      model: { id: 'claude-haiku-4-5', key: 'claude-haiku-4-5[1m]', wide: true, varUnknown: false, src: 'frame' },
      win: { value: 1000000, src: 'name', measured: false, raw: 0 },
      tokens: { value: 500800, src: 'frames', measured: false },
      pct: 50.08, bar: 50.08, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: null, learn: [],
    },
    line: 'Kontext ≈ 50% · 500.800 / 1.000.000',
  },
  {
    name: 'l) a frame arrived AFTER the measurement → the tokens fall back to the frames, the WINDOW measurement stays',
    finding: 'round 2: one freshness rule for both halves',
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 42263, ctxStamp: 4,
      ctxMeasured: measured({ tokens: 18529, win: 200000, raw: 200000, pct: 9, hasPct: true, stamp: 3 }),
    },
    env: { known: {}, resolves: 'claude-opus-5', label: 'Opus 5' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 200000, src: 'measured', measured: true, raw: 200000 },
      tokens: { value: 42263, src: 'frames', measured: false },
      pct: 21.13, bar: 21.13, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: { win: 200000, key: 'claude-opus-5' }, learn: [{ key: 'claude-opus-5', win: 200000 }],
    },
  },
  {
    name: 'l2) a measurement captured at a HIGHER stamp than the tab carries (the counter was set back) → discarded',
    finding: 'C2/round 2: `ctxSeq` was reset to 0, and an ordering test then promoted a capture from before',
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 21000, ctxStamp: 0,
      ctxMeasured: measured({ tokens: 500800, win: 1000000, raw: 1000000, pct: 50, hasPct: true, stamp: 5 }),
    },
    env: { known: {}, resolves: 'claude-opus-5', label: 'Opus 5' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      // the WINDOW survives (same generation → still the same model), the token count does not
      win: { value: 1000000, src: 'measured', measured: true, raw: 1000000 },
      tokens: { value: 21000, src: 'frames', measured: false },
      pct: 2.1, bar: 2.1, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: { win: 1000000, key: 'claude-opus-5' }, learn: [{ key: 'claude-opus-5', win: 1000000 }],
    },
  },
  {
    name: 'm) „<synthetic>" names no model → the selector decides, and sonnet-5 is 1M without any suffix',
    finding: 'CTX-8 · and the old blanket fallback of 200 000, which was simply wrong for sonnet-5',
    tab: { id: 'c1', model: '<synthetic>', modelSel: 'claude-sonnet-5', ctxTokens: 34021, ctxStamp: 2 },
    env: { known: {}, resolves: 'claude-sonnet-5', label: 'Sonnet 5' },
    want: {
      model: { id: 'claude-sonnet-5', key: 'claude-sonnet-5', wide: false, varUnknown: false, src: 'resolves' },
      win: { value: 1000000, src: 'name', measured: false, raw: 0 },
      tokens: { value: 34021, src: 'frames', measured: false },
      pct: 3.4, bar: 3.4, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: null, learn: [],
    },
  },
  {
    name: 'n) a wide session\'s own result: a BARE key reporting 1 000 000 → session window, filed under the wide key',
    finding: 'C-round2/6: the write side has to check the NUMBER, not just the selector',
    tab: { id: 'c1', model: 'claude-opus-5', modelSel: 'eu.anthropic.claude-opus-5[1m]', ctxTokens: 500800, ctxStamp: 3 },
    env: {
      known: {}, resolves: 'eu.anthropic.claude-opus-5', label: 'Opus 5 (1M)',
      usage: { now: BEDROCK_USAGE },
    },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5[1m]', wide: true, varUnknown: false, src: 'frame' },
      win: { value: 1000000, src: 'session', measured: false, raw: 0 },
      tokens: { value: 500800, src: 'frames', measured: false },
      pct: 50.08, bar: 50.08, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: { win: 1000000, key: 'claude-opus-5[1m]' },
      // the side-call keeps its OWN bare key — a haiku window may never land on this tab's variant
      learn: [{ key: 'claude-opus-5[1m]', win: 1000000 }, { key: 'claude-haiku-4-5', win: 200000 }],
    },
  },
  {
    name: 'o) a wide session whose result reports 200 000 for that model → refused, nothing filed, and SAID out loud',
    finding: 'requirement 3 (modelUsage) — and the silent swallow that refusal alone would create',
    tab: { id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5[1m]', ctxTokens: 500800, ctxStamp: 3 },
    env: {
      known: {}, resolves: 'claude-opus-5', label: 'Opus 5 (1M)',
      usage: { now: { 'claude-opus-5': { inputTokens: 10, contextWindow: 200000 } } },
    },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5[1m]', wide: true, varUnknown: false, src: 'frame' },
      win: { value: 1000000, src: 'name', measured: false, raw: 0 },
      tokens: { value: 500800, src: 'frames', measured: false },
      pct: 50.08, bar: 50.08, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '',
      // the line shows the PROMISE (1M) and the refused 200 000 is not on screen — so it is on the tooltip
      conflict: 'variant-usage', shows: 'promise',
      adopt: null, learn: [],
    },
    line: '⚠ Kontext ≈ 50% · 500.800 / 1.000.000',
  },
  {
    name: 'p) a result that holds BOTH variants of one model → exact variant match, no crossing either way',
    tab: { id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 100000, ctxStamp: 1 },
    env: {
      known: {}, resolves: 'claude-opus-5', label: 'Opus 5',
      usage: { now: {
        'claude-opus-5': { inputTokens: 10, contextWindow: 200000 },
        'claude-opus-5[1m]': { inputTokens: 10, contextWindow: 1000000 },
      } },
    },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 200000, src: 'session', measured: false, raw: 0 },
      tokens: { value: 100000, src: 'frames', measured: false },
      pct: 50, bar: 50, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: { win: 200000, key: 'claude-opus-5' },
      learn: [{ key: 'claude-opus-5', win: 200000 }, { key: 'claude-opus-5[1m]', win: 1000000 }],
    },
  },
  {
    name: 'q) a restored tab: the window its own turns reported, for the variant it was measured for',
    tab: { id: null, model: null, modelSel: 'claude-opus-5[1m]', ctxTokens: 0, ctxStamp: 0, ctxReported: { win: 1000000, key: 'claude-opus-5[1m]' } },
    env: { known: {}, resolves: 'claude-opus-5', label: 'Opus 5 (1M)' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5[1m]', wide: true, varUnknown: false, src: 'resolves' },
      win: { value: 1000000, src: 'session', measured: false, raw: 0 },
      tokens: { value: 0, src: 'none', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: false, measured: false,
      pending: true, pendingWhy: 'idle', conflict: '', shows: '',
      adopt: null, learn: [],
    },
  },
  {
    name: 'q2) …and a restored window measured for the OTHER variant is ignored, not inherited',
    tab: { id: null, model: null, modelSel: 'claude-opus-5[1m]', ctxTokens: 0, ctxStamp: 0, ctxReported: { win: 200000, key: 'claude-opus-5' } },
    env: { known: {}, resolves: 'claude-opus-5', label: 'Opus 5 (1M)' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5[1m]', wide: true, varUnknown: false, src: 'resolves' },
      win: { value: 1000000, src: 'name', measured: false, raw: 0 },
      tokens: { value: 0, src: 'none', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: false, measured: false,
      pending: true, pendingWhy: 'idle', conflict: '', shows: '',
      adopt: null, learn: [],
    },
  },
  {
    name: 'r) nothing matched a name at all → the model that carried THIS turn (the delta), not the heaviest',
    finding: 'the cumulative counters: enough haiku side-calls made the 200 000 entry the heaviest one',
    tab: { id: 'c1', model: 'wer-auch-immer', modelSel: '', ctxTokens: 50000, ctxStamp: 1 },
    env: {
      known: {}, resolves: '', label: '',
      usage: {
        now: {
          'claude-haiku-4-5': { inputTokens: 300000, contextWindow: 200000 },  // untouched this turn
          'claude-sonnet-5': { inputTokens: 90000, contextWindow: 1000000 },   // +40 000 — this turn's model
        },
        prev: {
          'claude-haiku-4-5': { inputTokens: 300000, contextWindow: 200000 },
          'claude-sonnet-5': { inputTokens: 50000, contextWindow: 1000000 },
        },
      },
    },
    want: {
      model: { id: 'wer-auch-immer', key: 'wer-auch-immer', wide: false, varUnknown: true, src: 'frame' },
      win: { value: 1000000, src: 'session', measured: false, raw: 0 },
      tokens: { value: 50000, src: 'frames', measured: false },
      pct: 5, bar: 5, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      // C2 — shown (this session's own result), but not ADOPTED: `ctxReported` is persisted per tab and read
      // back by exact variant key, so a number filed under the bare key while nobody could say the variant is
      // what a later bare-variant tab inherits. The cost is „–" between turns for such a tab, which is what
      // „nobody said" is painted as everywhere else — and the probe is re-armed while the window is in doubt.
      adopt: null,
      // CHANGED 05.10. — the sonnet-5 entry (1 000 000 under a bare key, for a model that is not this tab's) is no
      // longer filed: nothing says whether it was „claude-sonnet-5" or „claude-sonnet-5[1m]" (see row g). The
      // haiku one is: 200 000 cannot be a „[1m]" window, so it can only be the bare variant's.
      learn: [{ key: 'claude-haiku-4-5', win: 200000 }],
    },
  },
  {
    name: 'r2) …but the fallback is only for a model the object says NOTHING about: its own entry with no window → „–"',
    finding: 'B4 — the delta-weight fallback handed the tab the side-call\'s window, and step (7) persisted it',
    // The trigger needs nothing exotic: the conversation's model sits in `modelUsage` next to a side-call, and
    // its entry simply carries no `contextWindow` (the counters are always there, the window is not). Such an
    // entry is filtered out before the name loop, so nothing matched the name — and the weight fallback then
    // picked the heaviest DELTA, i.e. the title-generation call on haiku: 200 000 for a conversation nobody
    // measured, adopted as this tab's session window and persisted with it. Gated now by the same rule the rest
    // of the read side follows: the object names this model, so „no window reported" is the answer, and „–" is
    // what that looks like. Row r keeps the fallback alive for the case it exists for (an opaque id).
    tab: { id: 'c1', model: 'claude-opus-7', modelSel: 'claude-opus-7', ctxTokens: 40000, ctxStamp: 1 },
    env: {
      known: {}, resolves: 'claude-opus-7', label: 'Opus 7',
      usage: { now: {
        'eu.anthropic.claude-opus-7-v1:0': { inputTokens: 20, cacheReadInputTokens: 18500 },        // no window
        'eu.anthropic.claude-haiku-4-5-20251001-v1:0': { inputTokens: 500000, contextWindow: 200000 },
      } },
    },
    want: {
      model: { id: 'claude-opus-7', key: 'claude-opus-7', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 0, src: 'unknown', measured: false, raw: 0 },
      tokens: { value: 40000, src: 'frames', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: true, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      // the side-call keeps its own key, as always — that entry says nothing about this tab
      adopt: null, learn: [{ key: 'claude-haiku-4-5', win: 200000 }],
    },
    line: 'Kontext · 40.000 / –',
  },
  {
    name: 's) a started tab with no number yet → „wird gemessen…", with the window it will be measured against',
    // s … s5 run on claude-haiku-4-5 since 06.10. (they ran on opus-5): „the window it will be measured against"
    // is the NAME TABLE's, and a 200 000 there can only come from that table's one row below 1M — under CLI
    // 2.1.291 the opus-5 row is 1 000 000, the same number a blanket wide fallback would give.
    tab: { id: 'c1', model: 'claude-haiku-4-5', modelSel: 'claude-haiku-4-5' },
    env: { known: {}, resolves: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    want: {
      model: { id: 'claude-haiku-4-5', key: 'claude-haiku-4-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 200000, src: 'name', measured: false, raw: 0 },
      tokens: { value: 0, src: 'none', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: false, measured: false,
      pending: true, pendingWhy: 'measuring', conflict: '', shows: '',
      adopt: null, learn: [],
    },
  },
  {
    name: 's2) …after two silences it stops promising: „CLI antwortet nicht"',
    finding: 'C7: „wird gemessen…" claimed a query that nothing was sending any more',
    tab: { id: 'c1', model: 'claude-haiku-4-5', modelSel: 'claude-haiku-4-5', _ctxMisses: 2 },
    env: { known: {}, resolves: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    want: {
      model: { id: 'claude-haiku-4-5', key: 'claude-haiku-4-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 200000, src: 'name', measured: false, raw: 0 },
      tokens: { value: 0, src: 'none', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: false, measured: false,
      pending: true, pendingWhy: 'silent', conflict: '', shows: '',
      adopt: null, learn: [],
    },
  },
  {
    name: 's3) …and an exited process is not waiting for anything either',
    tab: { id: 'c1', _exited: true, model: 'claude-haiku-4-5', modelSel: 'claude-haiku-4-5' },
    env: { known: {}, resolves: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    want: {
      model: { id: 'claude-haiku-4-5', key: 'claude-haiku-4-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 200000, src: 'name', measured: false, raw: 0 },
      tokens: { value: 0, src: 'none', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: false, measured: false,
      pending: true, pendingWhy: 'idle', conflict: '', shows: '',
      adopt: null, learn: [],
    },
  },
  {
    name: 't) a 1M label over a 1M window is no contradiction, and a window WIDER than the label never is',
    tab: { id: 'c1', model: 'claude-sonnet-5', modelSel: 'claude-sonnet-5', ctxTokens: 900000, ctxStamp: 9 },
    env: { known: { 'claude-sonnet-5': 1000000 }, resolves: 'claude-sonnet-5', label: 'Sonnet 5' },
    want: {
      model: { id: 'claude-sonnet-5', key: 'claude-sonnet-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 1000000, src: 'learned', measured: false, raw: 0 },
      tokens: { value: 900000, src: 'frames', measured: false },
      pct: 90, bar: 90, level: 'hot', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: null, learn: [],
    },
  },
  {
    name: 'u) an „unconfirmed" answer is no measurement at all → the derived number keeps the line alive',
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 42263, ctxStamp: 2,
      ctxMeasured: ctxFromRoute({ unconfirmed: true }),  // → null
    },
    env: { known: { 'claude-opus-5': 200000 }, resolves: 'claude-opus-5', label: 'Opus 5' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 200000, src: 'learned', measured: false, raw: 0 },
      tokens: { value: 42263, src: 'frames', measured: false },
      pct: 21.13, bar: 21.13, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: null, learn: [],
    },
  },
  {
    name: 'v) rawMaxTokens differs from the 100 % line → it rides along for the tooltip',
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 0, ctxStamp: 5,
      ctxMeasured: measured({ tokens: 18529, win: 180000, raw: 200000, pct: 10, hasPct: true, stamp: 5 }),
    },
    env: { known: {}, resolves: 'claude-opus-5', label: 'Opus 5' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 180000, src: 'measured', measured: true, raw: 200000 },
      tokens: { value: 18529, src: 'measured', measured: true },
      pct: 10, bar: 10, level: '', unknownWin: false, measured: true,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: { win: 180000, key: 'claude-opus-5' }, learn: [{ key: 'claude-opus-5', win: 180000 }],
    },
  },
  {
    name: 'w) the selector alone (no menu yet, no frame): the alias is the only thing that says 1M',
    tab: { id: 'c1', model: null, modelSel: 'opus[1m]', ctxTokens: 0, ctxStamp: 0 },
    env: { known: { 'opus[1m]': 1000000 }, resolves: '', label: '' },
    want: {
      model: { id: 'opus', key: 'opus[1m]', wide: true, varUnknown: false, src: 'sel' },
      win: { value: 1000000, src: 'learned', measured: false, raw: 0 },
      tokens: { value: 0, src: 'none', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: false, measured: false,
      pending: true, pendingWhy: 'measuring', conflict: '', shows: '',
      adopt: null, learn: [],
    },
  },
  // --- round 3: the paths the adversarial verifier named, each as its own row ---------------------------
  {
    name: 'x) „Default" with NO resolves at all, on a session that really runs 1M → unknown, never 200 000',
    finding: 'H1 — lib/models.js built the first-party Default row with `resolves: \'\'` hardcoded',
    // This is the reported line's own tab: a „Default" selection (value ""), a frame naming the model but
    // never the variant, and a learned 200 000 for the bare spelling. Nothing here can say „1M" — so the
    // honest answer is „–". The old code read the bare learned/name entry and painted „250 %".
    tab: { id: 'c1', model: 'claude-opus-5', modelSel: '', ctxTokens: 500800, ctxStamp: 2 },
    env: { known: { 'claude-opus-5': 200000 }, sel: '', resolves: '', label: 'Default' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: true, src: 'frame' },
      win: { value: 0, src: 'unknown', measured: false, raw: 0 },
      tokens: { value: 500800, src: 'frames', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: true, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: null, learn: [],
    },
    // …and no „0 %": with no divisor there is no ratio, and printing one was a number that measured nothing
    line: 'Kontext · 500.800 / –',
    title: ['commands.kontextFensterLautCli', 'commands.kontextQuelleHergeleitet', 'commands.kontextFensterVarianteUnbekannt'],
  },
  {
    name: 'x2) …and with the resolves the fixed menu now sends, the same tab is measured against 1M',
    finding: 'H1, the other half: the Default row names what settings.json really starts',
    tab: { id: 'c1', model: 'claude-opus-5', modelSel: '', ctxTokens: 500800, ctxStamp: 2 },
    env: {
      known: { 'claude-opus-5': 200000 }, sel: '', resolves: 'claude-opus-5[1m]', label: 'Default',
      usage: { now: { 'claude-opus-5': { inputTokens: 10, contextWindow: 1000000 } } },
    },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5[1m]', wide: true, varUnknown: false, src: 'frame' },
      win: { value: 1000000, src: 'session', measured: false, raw: 0 },
      tokens: { value: 500800, src: 'frames', measured: false },
      pct: 50.08, bar: 50.08, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: { win: 1000000, key: 'claude-opus-5[1m]' }, learn: [{ key: 'claude-opus-5[1m]', win: 1000000 }],
    },
    line: 'Kontext ≈ 50% · 500.800 / 1.000.000',
  },
  {
    name: 'y) a modelUsage key that CARRIES „[1m]" while its number says 200 000 → refused on the exact match',
    finding: 'H2a — the `distinguishes` branch took an exact-key hit with no variant check at all',
    tab: { id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5[1m]', ctxTokens: 500800, ctxStamp: 3 },
    env: {
      known: {}, resolves: 'claude-opus-5', label: 'Opus 5 (1M)',
      usage: { now: { 'claude-opus-5[1m]': { inputTokens: 10, contextWindow: 200000 } } },
    },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5[1m]', wide: true, varUnknown: false, src: 'frame' },
      // the self-contradicting entry is neither shown nor filed — and it is SAID, like row o
      win: { value: 1000000, src: 'name', measured: false, raw: 0 },
      tokens: { value: 500800, src: 'frames', measured: false },
      pct: 50.08, bar: 50.08, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: 'variant-usage', shows: 'promise',
      adopt: null, learn: [],
    },
    line: '⚠ Kontext ≈ 50% · 500.800 / 1.000.000',
    title: ['commands.kontextFensterLautCli', 'commands.kontextQuelleHergeleitet', 'commands.kontextFensterGeraten',
      'commands.kontextMeldungAbgelehnt', 'commands.kontextZeigtZusage'],
  },
  {
    name: 'y2) …and such an entry is not LEARNED either, not under the wide key and not under the bare one',
    finding: 'H2c — ctxLearnEntries filed any „[1m]"-spelled entry with no check on the number',
    // the entry belongs to another model, so only the write side is exercised here
    tab: { id: 'c1', model: 'claude-sonnet-5', modelSel: 'claude-sonnet-5', ctxTokens: 34021, ctxStamp: 1 },
    env: {
      known: {}, resolves: 'claude-sonnet-5', label: 'Sonnet 5',
      usage: { now: { 'claude-opus-5[1m]': { inputTokens: 10, contextWindow: 200000 } } },
    },
    want: {
      model: { id: 'claude-sonnet-5', key: 'claude-sonnet-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 1000000, src: 'name', measured: false, raw: 0 },
      tokens: { value: 34021, src: 'frames', measured: false },
      pct: 3.4, bar: 3.4, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: null, learn: [],   // ← the 200 000 under „…opus-5[1m]" is filed NOWHERE
    },
  },
  {
    name: 'x3) „Default" with no resolves and a MEASURED window → shown, but filed in neither store',
    finding: 'C2 — the second writer: ctxDecide files the measured window itself when modelUsage says nothing',
    // The H1 tab again, this time with an answer from the CLI. The number is SHOWN unconditionally (the route
    // is the CLI talking about this session, which needs no spelling) — and written nowhere, because both
    // stores are keyed by variant and this tab cannot say which variant the 200 000 was measured for. Filing
    // it under the bare key is precisely how a „[1m]" tab came to read back a 200 000 nobody measured for it.
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: '', ctxTokens: 0, ctxStamp: 4,
      ctxMeasured: measured({ tokens: 18529, win: 200000, raw: 200000, pct: 9, hasPct: true, stamp: 4 }),
    },
    env: { known: {}, sel: '', resolves: '', label: 'Default' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: true, src: 'frame' },
      win: { value: 200000, src: 'measured', measured: true, raw: 200000 },
      tokens: { value: 18529, src: 'measured', measured: true },
      pct: 9, bar: 9, level: '', unknownWin: false, measured: true,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: null, learn: [],
    },
    line: 'Kontext 9% · 18.529 / 200.000',
  },
  {
    name: 'x4) NO model identified at all, and a result full of modelUsage → unknown, never the side-call\'s window',
    finding: 'C4 — the token-weight fallback ran ungated when the tab had no model key',
    // Reachable: a „Default" selection the menu cannot resolve whose only frame was „<synthetic>" (an error the
    // CLI composed itself names no model). The heaviest-delta entry would be the title-generation side-call on
    // haiku — a 200 000 that belongs to a model this tab is not talking to. The line shows the token count over
    // „–"; the tooltip says the window is unknown while no model is named, which is exactly what is true.
    tab: { id: 'c1', model: '<synthetic>', modelSel: '', ctxTokens: 42263, ctxStamp: 2 },
    env: {
      known: { 'claude-haiku-4-5': 200000 }, sel: '', resolves: '', label: '',
      usage: { now: { 'claude-haiku-4-5': { inputTokens: 500000, contextWindow: 200000 } } },
    },
    want: {
      model: { id: '', key: '', wide: false, varUnknown: false, src: '' },
      win: { value: 0, src: 'unknown', measured: false, raw: 0 },
      tokens: { value: 42263, src: 'frames', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: true, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      // the side-call's own window is still LEARNED under its own name — that entry says nothing about this tab
      adopt: null, learn: [{ key: 'claude-haiku-4-5', win: 200000 }],
    },
    line: 'Kontext · 42.263 / –',
    title: ['commands.kontextFensterLautCli', 'commands.kontextQuelleHergeleitet', 'commands.kontextFensterUnbekannt'],
  },
  {
    name: 's4) the CLI does not HAVE the context control → „CLI kann nicht messen", not „antwortet nicht"',
    finding: 'C1 — „Unsupported control request subtype" was counted as a transient miss',
    // A refusal is a permanent property of this binary, so the line must not promise a measurement and must
    // not read like a CLI that is merely slow. The tooltip says the numbers stay derived from here on.
    // (claude-haiku-4-5 for the reason given at row s.)
    tab: { id: 'c1', model: 'claude-haiku-4-5', modelSel: 'claude-haiku-4-5', _ctxNoSupport: true },
    env: { known: {}, resolves: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    want: {
      model: { id: 'claude-haiku-4-5', key: 'claude-haiku-4-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 200000, src: 'name', measured: false, raw: 0 },
      tokens: { value: 0, src: 'none', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: false, measured: false,
      pending: true, pendingWhy: 'unsupported', conflict: '', shows: '',
      adopt: null, learn: [],
    },
    line: 'Kontext · KANN-NICHT / 200.000',
    title: ['commands.kontextFensterLautCli', 'commands.kontextQuelleHergeleitet', 'commands.kontextFensterGeraten',
      'commands.kontextKeineMessungMoeglichTooltip'],
  },
  {
    name: 's5) …and „kann nicht" outranks „antwortet nicht" when both would apply',
    tab: { id: 'c1', model: 'claude-haiku-4-5', modelSel: 'claude-haiku-4-5', _ctxMisses: 2, _ctxNoSupport: true },
    env: { known: {}, resolves: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    want: {
      model: { id: 'claude-haiku-4-5', key: 'claude-haiku-4-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 200000, src: 'name', measured: false, raw: 0 },
      tokens: { value: 0, src: 'none', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: false, measured: false,
      pending: true, pendingWhy: 'unsupported', conflict: '', shows: '',
      adopt: null, learn: [],
    },
    line: 'Kontext · KANN-NICHT / 200.000',
  },
  {
    name: 'z) tokens known, window UNKNOWN → the count is shown, the ratio is absent (no „0 %")',
    finding: 'the verifier\'s row 4: „≈ 0% · 500.8K / –" was a percentage nobody computed',
    tab: { id: 'c1', model: 'claude-opus-9', modelSel: 'claude-opus-9', ctxTokens: 123456, ctxStamp: 2 },
    env: { known: {}, resolves: 'claude-opus-9', label: 'Opus 9' },
    want: {
      model: { id: 'claude-opus-9', key: 'claude-opus-9', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 0, src: 'unknown', measured: false, raw: 0 },
      tokens: { value: 123456, src: 'frames', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: true, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: null, learn: [],
    },
    line: 'Kontext · 123.456 / –',
    title: ['commands.kontextFensterLautCli', 'commands.kontextQuelleHergeleitet', 'commands.kontextFensterUnbekannt'],
  },
  {
    name: 'z2) a measured WINDOW with a measured 0 tokens → „0 %", measured, and NOT „wird gemessen…"',
    finding: 'the verifier\'s row 5: ctxFromRoute accepts that pair on purpose, and `tokens > 0` read it as „no answer"',
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5[1m]', ctxTokens: 0, ctxStamp: 4,
      // an emptied session: the CLI answered „0 of 1 000 000", which is a measurement and not a silence
      ctxMeasured: measured({ tokens: 0, hasTok: true, win: 1000000, raw: 1000000, pct: 0, hasPct: true, stamp: 4 }),
    },
    env: { known: {}, resolves: 'claude-opus-5', label: 'Opus 5 (1M)' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5[1m]', wide: true, varUnknown: false, src: 'frame' },
      win: { value: 1000000, src: 'measured', measured: true, raw: 1000000 },
      tokens: { value: 0, src: 'measured', measured: true },
      pct: 0, bar: 0, level: '', unknownWin: false, measured: true,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: { win: 1000000, key: 'claude-opus-5[1m]' }, learn: [{ key: 'claude-opus-5[1m]', win: 1000000 }],
    },
    line: 'Kontext 0% · 0 / 1.000.000',
  },
  {
    name: 'z2b) …and an answer that carried NO token field is no token measurement, even in step (row b\'s mirror)',
    finding: 'the same `tokens > 0` test: „absent" and „0" were indistinguishable in BOTH directions',
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 42263, ctxStamp: 5,
      ctxMeasured: measured({ tokens: 0, hasTok: false, win: 200000, raw: 200000, stamp: 5 }),
    },
    env: { known: {}, resolves: 'claude-opus-5', label: 'Opus 5' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 200000, src: 'measured', measured: true, raw: 200000 },
      tokens: { value: 42263, src: 'frames', measured: false },   // …and NOT a measured 0
      pct: 21.13, bar: 21.13, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: { win: 200000, key: 'claude-opus-5' }, learn: [{ key: 'claude-opus-5', win: 200000 }],
    },
    line: 'Kontext ≈ 21% · 42.263 / 200.000',
  },
  {
    name: 'z3) a measurement from a LATER generation than the tab\'s → discarded (row h\'s mirror)',
    finding: 'the verifier\'s row 6: with `>=` instead of `===` no row went red for a generation from ahead',
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 21000, ctxStamp: 6, _ctxGen: 2,
      ctxMeasured: measured({ tokens: 500800, win: 1000000, raw: 1000000, pct: 50, hasPct: true, gen: 3, stamp: 6 }),
    },
    env: { known: { 'claude-opus-5': 200000 }, resolves: 'claude-opus-5', label: 'Opus 5' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 200000, src: 'learned', measured: false, raw: 0 },
      tokens: { value: 21000, src: 'frames', measured: false },
      pct: 10.5, bar: 10.5, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: null, learn: [],
    },
  },
  {
    name: 'z4) the 1M promise comes from the VARIANT, not from the label → the ⚠ names the variant',
    finding: 'the verifier\'s row 8: both conflict kinds shared one sentence, which blamed the label',
    // „Default" resolving to the wide variant: no label says 1M anywhere, so „das Modell-Label verspricht
    // 1M" would point at a string that promises nothing
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: '', ctxTokens: 0, ctxStamp: 1,
      ctxMeasured: measured({ tokens: 18529, win: 200000, raw: 200000, pct: 9, hasPct: true, stamp: 1 }),
    },
    env: { known: {}, sel: '', resolves: 'eu.anthropic.claude-opus-5[1m]', label: 'Default' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5[1m]', wide: true, varUnknown: false, src: 'frame' },
      win: { value: 200000, src: 'measured', measured: true, raw: 200000 },
      tokens: { value: 18529, src: 'measured', measured: true },
      pct: 9, bar: 9, level: '', unknownWin: false, measured: true,
      pending: false, pendingWhy: '', conflict: 'label-wide', shows: 'window',
      adopt: null, learn: [],
    },
    line: '⚠ Kontext 9% · 18.529 / 200.000',
    title: ['commands.kontextFensterLautCli', 'commands.kontextQuelleGemessen', 'commands.kontextFensterGemeldet',
      'commands.kontextVarianteWiderspruch', 'commands.kontextZeigtFenster'],
  },
  {
    name: 'z5) right after a compaction: the pre-compaction count is STALE → measuring, not a number',
    finding: 'M2 — ctxForgetContext ended the op but left the size of what was just discarded on screen',
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 500800, ctxTokensStale: true, ctxStamp: 8,
    },
    env: { known: { 'claude-opus-5': 200000 }, resolves: 'claude-opus-5', label: 'Opus 5' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      // the WINDOW is unaffected — a compaction does not change the model
      win: { value: 200000, src: 'learned', measured: false, raw: 0 },
      tokens: { value: 0, src: 'none', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: false, measured: false,
      pending: true, pendingWhy: 'measuring', conflict: '', shows: '',
      adopt: null, learn: [],
    },
    line: 'Kontext · MESSE / 200.000',
  },
  // --- round 4: the FLOOR. The rows in which the NAME CONSTANT itself must speak — fl1, fl2, fl6, fl8 — use a
  //     model that really IS in CTX_NAME_WINDOWS at 200 000; that is the point. The previous round's withdrawal
  //     rows were green only because their fixture model („claude-opus-7") is in no table, so the one holder a
  //     deletion cannot reach never spoke in them. That model was „claude-opus-5" until the 06.10. measurement
  //     (CLI 2.1.291: opus-5 is 1 000 000 now, and a 1M constant clears every bound below it); it is
  //     „claude-haiku-4-5" since, the table's only row below 1M. The other fl-rows keep „claude-opus-5": in them
  //     a measurement, a learned window or an unknown variant answers before the constant is reached (fl3*,
  //     fl7, fl10, fl11), or they are about its wide sibling, which only opus-5 has (fl4, fl5). -----
  {
    name: 'fl1) refuted, then a compaction: the NAME CONSTANT offers the same 200 000 again → refused, and the line stays honest',
    finding: 'B1 could not work: CTX_NAME_WINDOWS is a module constant, so there was nothing to delete',
    // Both stores are EMPTY here — no stale data is involved at all, which is exactly why the withdrawal was not
    // the guarantee: for every model in that table the refuted number is handed back by ctx.js itself, at the
    // next compaction, unmarked and byte-identical. The floor is what refuses it, and it says why.
    tab: { id: 'c1', model: 'claude-haiku-4-5', modelSel: 'claude-haiku-4-5', ctxTokens: 120000, ctxStamp: 7 },
    env: { known: {}, floors: { 'claude-haiku-4-5': FL(500800) }, resolves: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    want: {
      model: { id: 'claude-haiku-4-5', key: 'claude-haiku-4-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 0, src: 'unknown', measured: false, raw: 0 },
      tokens: { value: 120000, src: 'frames', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: true, measured: false,
      pending: false, pendingWhy: '', conflict: 'below-floor', shows: 'tokens',
      adopt: null, learn: [], floor: 500800,
    },
    // NOT „≈ 60 % · 120.000 / 200.000" — the sentence the last round's comment promised was gone and was not
    line: '⚠ Kontext · 120.000 / –',
    title: ['commands.kontextFensterLautCli', 'commands.kontextQuelleHergeleitet',
      'commands.kontextFensterUnterBoden', 'commands.kontextZeigtTokens'],
  },
  {
    name: 'fl2) …and the CLI re-reports the same maxTokens in the NEXT result → still refused, and not re-filed either',
    finding: 'B1\'s second hole: modelUsage.contextWindow arrives fresh every turn and refilled the emptied store',
    // The turn after the refutation: the context has been compacted, nothing contradicts 200 000 any more, and
    // `result.modelUsage` states it again — which is how the deletion survived exactly until the next ordinary
    // turn. The floor refuses the source AND the write: `learn` empty, `adopt` null, so the store stays clean
    // instead of being refilled with the number that was just disproved.
    tab: { id: 'c1', model: 'claude-haiku-4-5', modelSel: 'claude-haiku-4-5', ctxTokens: 120000, ctxStamp: 7 },
    env: {
      known: {}, floors: { 'claude-haiku-4-5': FL(500800) }, resolves: 'claude-haiku-4-5', label: 'Haiku 4.5',
      usage: { now: { 'claude-haiku-4-5': { inputTokens: 10, cacheReadInputTokens: 119990, contextWindow: 200000 } } },
    },
    want: {
      model: { id: 'claude-haiku-4-5', key: 'claude-haiku-4-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 0, src: 'unknown', measured: false, raw: 0 },
      tokens: { value: 120000, src: 'frames', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: true, measured: false,
      pending: false, pendingWhy: '', conflict: 'below-floor', shows: 'tokens',
      adopt: null, learn: [], floor: 500800,
    },
    line: '⚠ Kontext · 120.000 / –',
  },
  {
    name: 'fl3) the MEASUREMENT is not gated by a floor — shown, but not filed below a bound it did not refute (05.10.)',
    finding: 'F2 gated tab.ctxMeasured by the floor; one bad bound then refused the CLI\'s own maxTokens for good (j1)',
    // CHANGED 05.10. — this row asserted the opposite: the floor gated the measurement too, and the line was
    // „⚠ Kontext · 120.000 / –". That gate is exactly what made Julian's „580K / –" permanent: a bound above the
    // window refused the one source that could ever have overruled it. The measurement is the CLI talking about
    // THIS session in this generation; it is shown. (F2's own holder — a measurement refuted by the frames and
    // read back after the count dropped — no longer produces a floor at all: row d2.)
    // What the floor still does here: this measurement carries no clock (`at` 0) and the bound was proven later
    // (FL `at` 1), so it is not REFUTED by it (`healed` null — see fl3b) and it still gates what gets FILED:
    // `adopt`/`learn` stay empty, like fl11. The line shows the CLI's number, the stores keep the proven bound.
    // CHANGED again in the counter-check of 05.10.: shown, but no longer UNMARKED. The bound is the younger evidence
    // (a call carried 500 800 after the CLI said 200 000) — the argument row d2 makes for a frame — so the two
    // statements cannot both be true, and that is a conflict: ⚠, both numbers stay on screen (`shows` ''), the
    // tooltip says the measurement sits below the bound (not „abgelehnt": it is not refused, it is contradicted),
    // and the conflict keeps the window in doubt so the next answer can settle it (fl3b is what that answer does).
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 120000, ctxStamp: 9,
      ctxMeasured: measured({ tokens: 18529, win: 200000, raw: 200000, pct: 9, hasPct: true, source: 'model-default', stamp: 3 }),
    },
    env: { known: {}, floors: { 'claude-opus-5': FL(500800) }, resolves: 'claude-opus-5', label: 'Opus 5' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 200000, src: 'measured', measured: true, raw: 200000 },
      tokens: { value: 120000, src: 'frames', measured: false },
      pct: 60, bar: 60, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: 'below-floor', shows: '',
      adopt: null, learn: [], floor: 500800, autocompact: 'model-default',
    },
    line: '⚠ Kontext ≈ 60% · 120.000 / 200.000',
    title: ['commands.kontextFensterLautCli', 'commands.kontextQuelleHergeleitet', 'commands.kontextFensterGemeldet',
      'commands.kontextGrenzeLautCli', 'commands.kontextMessungUnterBoden'],
  },
  {
    name: 'fl3b) …and a measurement YOUNGER than the floor refutes it: `healed`, the bound is gone for every source',
    finding: '05.10. — a floor had no way out: no provenance, no expiry, and nothing allowed to overrule it',
    // fl3 with clocks: the bound was proven at 2, the CLI answered at 5. The CLI now reports, for this session and
    // after the evidence, a window below the bound — the bound is refuted. `healed` names the entry (the caller
    // removes exactly that one and says so once in the 🔔 log), the decision itself already judges by „no floor":
    // the measured window is adopted and learned, which fl3 refused.
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 120000, ctxStamp: 9,
      ctxMeasured: measured({ tokens: 18529, win: 200000, raw: 200000, pct: 9, hasPct: true, source: 'model-default', stamp: 3, at: 5 }),
    },
    env: { known: {}, floors: { 'claude-opus-5': FL(500800, 2) }, resolves: 'claude-opus-5', label: 'Opus 5' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 200000, src: 'measured', measured: true, raw: 200000 },
      tokens: { value: 120000, src: 'frames', measured: false },
      pct: 60, bar: 60, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: { win: 200000, key: 'claude-opus-5' }, learn: [{ key: 'claude-opus-5', win: 200000 }],
      floor: 0, autocompact: 'model-default', healed: { key: 'claude-opus-5', below: 500800 },
    },
    line: 'Kontext ≈ 60% · 120.000 / 200.000',
  },
  {
    name: 'fl3c) …but not while the VARIANT is unknown — the measurement is shown, the bare-keyed bound is left alone',
    finding: 'the same gate as filing (fl7): with the variant unknown the key is the bare one by default',
    // fl3b's clocks on a „Default" tab whose menu entry resolves to nothing. The measurement is shown (it needs no
    // spelling), but it may be the „[1m]" session's — and a 1M answer would not refute anything, while this 200 000
    // might belong to the other variant than the bound. Removing a bound needs the same certainty as filing one.
    // CHANGED in the counter-check (with fl3): marked. Reading the bare bound under an unknown variant is sound in
    // the direction that matters (a „[1m]" window is never smaller, see ctxDecide (4)), so a measured 200 000 below
    // it contradicts the bound under EITHER reading — the bound stays, and the line says the two disagree.
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: '', ctxTokens: 120000, ctxStamp: 9,
      ctxMeasured: measured({ tokens: 18529, win: 200000, raw: 200000, pct: 9, hasPct: true, stamp: 3, at: 5 }),
    },
    env: { known: {}, floors: { 'claude-opus-5': FL(500800, 2) }, sel: '', resolves: '', label: 'Default' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: true, src: 'frame' },
      win: { value: 200000, src: 'measured', measured: true, raw: 200000 },
      tokens: { value: 120000, src: 'frames', measured: false },
      pct: 60, bar: 60, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: 'below-floor', shows: '',
      adopt: null, learn: [], floor: 500800,
    },
    line: '⚠ Kontext ≈ 60% · 120.000 / 200.000',
  },
  {
    name: 'fl3d) …and a measurement exactly as OLD as the floor refutes nothing — only the younger one does',
    finding: 'counter-check mutation R11: `>=` instead of `>` in the clock comparison stayed green',
    // fl3b with both clocks at 5. „Younger" is strict: two pieces of evidence from the same moment are not ordered,
    // and erasing a proven bound needs the measurement to come AFTER it. So the bound stands (and marks the line).
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 120000, ctxStamp: 9,
      ctxMeasured: measured({ tokens: 18529, win: 200000, raw: 200000, pct: 9, hasPct: true, source: 'model-default', stamp: 3, at: 5 }),
    },
    env: { known: {}, floors: { 'claude-opus-5': FL(500800, 5) }, resolves: 'claude-opus-5', label: 'Opus 5' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 200000, src: 'measured', measured: true, raw: 200000 },
      tokens: { value: 120000, src: 'frames', measured: false },
      pct: 60, bar: 60, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: 'below-floor', shows: '',
      adopt: null, learn: [], floor: 500800, autocompact: 'model-default', healed: null,
    },
  },
  {
    name: 'fl3e) a measurement the tab\'s OWN frames beat refutes no floor — it is over-window, and the bound stays',
    finding: 'counter-check B: `healed` was decided before the tokens and never taken back — a bound a 520 000-token call had just confirmed was deleted',
    // The bound (500 800, proven at 5) and a younger measurement of 200 000 (at 10, same generation) — fl3b so far.
    // But a frame of this tab has carried 520 000 since (the stamp moved, so the tokens are the frames'): the
    // measurement is refuted by the tab's own evidence (row d2), and a refuted measurement refutes nothing. Before
    // the fix this record said both „the frames refute the measurement" AND „the measurement refutes the floor".
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 520000, ctxStamp: 9,
      ctxMeasured: measured({ tokens: 18529, win: 200000, raw: 200000, pct: 9, hasPct: true, stamp: 3, at: 10 }),
    },
    env: { known: {}, floors: { 'claude-opus-5': FL(500800, 5) }, resolves: 'claude-opus-5', label: 'Opus 5' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 0, src: 'unknown', measured: false, raw: 0 },
      tokens: { value: 520000, src: 'frames', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: true, measured: false,
      pending: false, pendingWhy: '', conflict: 'over-window', shows: 'tokens',
      adopt: null, learn: [], floor: 500800, refuted: null, healed: null,
    },
    line: '⚠ Kontext · 520.000 / –',
  },
  {
    name: 'fl3f) …nor does a measurement whose OWN estimate is above its window (the gauge\'s pair 500 800 / 200 000)',
    finding: 'counter-check A3: healed AND adopted AND learned the 200 000 below a bound of 500 800',
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 0, ctxStamp: 3,
      ctxMeasured: measured({ tokens: 500800, win: 200000, raw: 200000, pct: 250, hasPct: true, stamp: 3, at: 10 }),
    },
    env: { known: {}, floors: { 'claude-opus-5': FL(500800, 5) }, resolves: 'claude-opus-5', label: 'Opus 5' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 0, src: 'unknown', measured: false, raw: 0 },
      tokens: { value: 500800, src: 'measured', measured: true },
      pct: 0, bar: 0, level: '', unknownWin: true, measured: false,
      pending: false, pendingWhy: '', conflict: 'over-window', shows: 'tokens',
      adopt: null, learn: [], floor: 500800, refuted: null, healed: null,
    },
    line: '⚠ Kontext · 500.800 / –',
  },
  {
    name: 'fl4) a window ABOVE the floor is accepted normally — the bound refuses, it does not shrink',
    finding: 'the over-reach check: a floor proven at 500 800 must leave a 1M window alone',
    // Point 2 of „why it cannot over-reach": the floor is a LOWER bound from an accepted call, so it is at most
    // the real window of the session that proved it and a genuinely bigger one passes untouched. No ⚠, no „–".
    tab: { id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5[1m]', ctxTokens: 500800, ctxStamp: 4 },
    env: { known: {}, floors: { 'claude-opus-5[1m]': FL(500800) }, resolves: 'claude-opus-5', label: 'Opus 5 (1M)' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5[1m]', wide: true, varUnknown: false, src: 'frame' },
      win: { value: 1000000, src: 'name', measured: false, raw: 0 },
      tokens: { value: 500800, src: 'frames', measured: false },
      pct: 50.08, bar: 50.08, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: null, learn: [], floor: 500800,
    },
    line: 'Kontext ≈ 50% · 500.800 / 1.000.000',
  },
  {
    name: 'fl5) …and it is keyed by VARIANT: a bound proven for the bare spelling says nothing about „[1m]"',
    finding: 'the over-reach check, point 1 — the floor must be as careful as the windows beside it',
    // Row j with a bare-keyed floor added. If the lookup dropped the „[1m]" the way a store without variant keys
    // once did, the measured 200 000 would be refused here and the line would lose a number the CLI itself just
    // reported about this session. `floor: 0` in the record is the assertion: nothing is in force for this key.
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5[1m]', ctxTokens: 0, ctxStamp: 1,
      ctxMeasured: measured({ tokens: 18529, win: 200000, raw: 200000, pct: 9, hasPct: true, stamp: 1 }),
    },
    env: { known: {}, floors: { 'claude-opus-5': FL(500800) }, resolves: 'claude-opus-5', label: 'Opus 5 (1M)' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5[1m]', wide: true, varUnknown: false, src: 'frame' },
      win: { value: 200000, src: 'measured', measured: true, raw: 200000 },
      tokens: { value: 18529, src: 'measured', measured: true },
      pct: 9, bar: 9, level: '', unknownWin: false, measured: true,
      pending: false, pendingWhy: '', conflict: 'label-wide', shows: 'window',
      adopt: null, learn: [], floor: 0,
    },
    line: '⚠ Kontext 9% · 18.529 / 200.000',
  },
  {
    name: 'fl6) a window the count EXACTLY fills is accepted — 100 % is a real state, not a contradiction',
    finding: 'the floor is evidence, not a flag: only STRICTLY smaller windows are wrong',
    // A call that carried 200 000 tokens proves the window is at least 200 000 — and a window of exactly 200 000
    // is then full, not impossible. Refusing it („at or below") would turn the last turn before an auto-compaction
    // into „–" on every 200 K session. (The 200 K session is haiku-4-5 since 06.10. — see the round-4 header.)
    tab: { id: 'c1', model: 'claude-haiku-4-5', modelSel: 'claude-haiku-4-5', ctxTokens: 200000, ctxStamp: 5 },
    env: { known: {}, floors: { 'claude-haiku-4-5': FL(200000) }, resolves: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    want: {
      model: { id: 'claude-haiku-4-5', key: 'claude-haiku-4-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 200000, src: 'name', measured: false, raw: 0 },
      tokens: { value: 200000, src: 'frames', measured: false },
      pct: 100, bar: 100, level: 'hot', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: null, learn: [], floor: 200000,
    },
    line: 'Kontext ≈ 100% · 200.000 / 200.000',
  },
  {
    name: 'fl7) a refutation while the VARIANT is unknown files nothing — the one way the bound could over-reach',
    finding: 'the over-reach check, point 3 — a bare-keyed floor stamped by a session that may have been 1M',
    // Row x3's tab with a context that refutes its measurement. The window is still dropped and marked (what the
    // evidence refutes is refuted), but `refuted` is null: the key would be the BARE one by default, and a floor
    // of 500 800 filed there by a session that was really the wide variant would refuse the bare variant's
    // genuine 200 000 for every future tab and session. Same gate as (7)'s two writers.
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: '', ctxTokens: 500800, ctxStamp: 9,
      ctxMeasured: measured({ tokens: 18529, win: 200000, raw: 200000, pct: 9, hasPct: true, stamp: 4 }),
    },
    env: { known: {}, sel: '', resolves: '', label: 'Default' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: true, src: 'frame' },
      win: { value: 0, src: 'unknown', measured: false, raw: 0 },
      tokens: { value: 500800, src: 'frames', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: true, measured: false,
      pending: false, pendingWhy: '', conflict: 'over-window', shows: 'tokens',
      adopt: null, learn: [], refuted: null,
    },
    line: '⚠ Kontext · 500.800 / –',
  },
  {
    name: 'fl10) the count that may be a SUM over the turn refutes the line but files no bound',
    finding: 'the over-reach check, point 4 — a floor ABOVE the real window is the one that refuses something true',
    // The last-resort fallback: a turn where no `assistant` frame carried usage publishes `result.usage`, which
    // adds every call's input side together (measured: 81 220 for a context of 42 263). The window on screen is
    // still dropped — that costs one turn and the probe re-asks — but nothing durable may be filed from a number
    // that is possibly three times the real context, because a bound above the real window would refuse the
    // model's correct 200 000 for every future tab and session. `ctxTokensSummed` is what ctxNoteFrame marks.
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5',
      ctxTokens: 500800, ctxTokensSummed: true, ctxStamp: 2,
    },
    env: { known: { 'claude-opus-5': 200000 }, resolves: 'claude-opus-5', label: 'Opus 5' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 0, src: 'unknown', measured: false, raw: 0 },
      tokens: { value: 500800, src: 'frames', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: true, measured: false,
      pending: false, pendingWhy: '', conflict: 'over-window', shows: 'tokens',
      adopt: null, learn: [], refuted: null,
    },
    line: '⚠ Kontext · 500.800 / –',
  },
  {
    name: 'fl9) a refused source FALLS THROUGH to the next one — and the ⚠ still says a number was thrown out',
    finding: 'the floor refuses single numbers, not the whole question — exactly like a variant mismatch',
    // „claude-sonnet-5" is 1 000 000 in CTX_NAME_WINDOWS with no „[1m]" anywhere (that is why the old blanket
    // 200 000 fallback was a lie for it). A learned 200 000 for that key — mis-attributed by an earlier session
    // and then disproved by a 500 800-token call — is refused, the constant's 1M answers instead, and the line
    // shows a real window WITH the mark: „refused" is not the same as „missing", and the user can see which it is.
    tab: { id: 'c1', model: 'claude-sonnet-5', modelSel: 'claude-sonnet-5', ctxTokens: 500800, ctxStamp: 6 },
    env: {
      known: { 'claude-sonnet-5': 200000 }, floors: { 'claude-sonnet-5': FL(500800) },
      resolves: 'claude-sonnet-5', label: 'Sonnet 5',
    },
    want: {
      model: { id: 'claude-sonnet-5', key: 'claude-sonnet-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 1000000, src: 'name', measured: false, raw: 0 },
      tokens: { value: 500800, src: 'frames', measured: false },
      pct: 50.08, bar: 50.08, level: '', unknownWin: false, measured: false,
      // marked, but `shows` is empty: both halves of the line are on screen, so there is no „which of the two"
      pending: false, pendingWhy: '', conflict: 'below-floor', shows: '',
      adopt: null, learn: [], floor: 500800,
    },
    line: '⚠ Kontext ≈ 50% · 500.800 / 1.000.000',
    title: ['commands.kontextFensterLautCli', 'commands.kontextQuelleHergeleitet',
      'commands.kontextFensterGeraten', 'commands.kontextFensterUnterBoden'],
  },
  {
    name: 'fl8) the SECOND tab: it adopted the same 200 000 for itself, and the shared floor refuses that too',
    finding: 'B1\'s third hole — a withdrawal in tab A cannot reach what tab B holds',
    // Tab B never learned anything (`known` empty) and never ran the refuting turn; what it has is its own
    // `ctxReported` from its own earlier result, plus the name constant. A per-tab floor would leave exactly this
    // tab showing „≈ 60 % · 120.000 / 200.000"; the shared one refuses both of its sources.
    // (haiku-4-5 since 06.10.: „both of its sources" includes the constant, see the round-4 header.)
    tab: {
      id: 'c2', model: 'claude-haiku-4-5', modelSel: 'claude-haiku-4-5', ctxTokens: 120000, ctxStamp: 3,
      ctxReported: { win: 200000, key: 'claude-haiku-4-5' },
    },
    env: { known: {}, floors: { 'claude-haiku-4-5': FL(500800) }, resolves: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    want: {
      model: { id: 'claude-haiku-4-5', key: 'claude-haiku-4-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 0, src: 'unknown', measured: false, raw: 0 },
      tokens: { value: 120000, src: 'frames', measured: false },
      pct: 0, bar: 0, level: '', unknownWin: true, measured: false,
      pending: false, pendingWhy: '', conflict: 'below-floor', shows: 'tokens',
      adopt: null, learn: [], floor: 500800,
    },
    line: '⚠ Kontext · 120.000 / –',
  },
  {
    name: 'fl11) a measured window SHOWN over the floor (legal region) is still not FILED below it — row d3 plus a bound',
    finding: 'the write side judged itself by the ceiling that let it onto the line, so a disproved number was filed anyway',
    // Row d3 verbatim, with one bound added: a floor of 190 000 for this variant. The measured pair clears the
    // floor on its CEILING (max(180 000, 200 000) = 200 000), so it stays on the line — that is d3's whole point,
    // and nothing about the display changes here. But what used to be FILED was the bare 180 000, into
    // `tab.ctxReported` (persisted, restored after a reload) and into the shared learned store — and a filed
    // number comes back as a session/learned candidate, which has NO raw window beside it, so this very decision
    // refuses it on the next read as `below-floor`. That is a holder quietly keeping a disproved value, which is
    // the pattern the floor exists to end, and it was the only write branch in (7) that did not pass the bound
    // while its sibling (`fresh`) did. Now both do, judged by the number that actually gets written.
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 190000, ctxStamp: 9,
      ctxMeasured: measured({ tokens: 0, hasTok: false, win: 180000, raw: 200000, stamp: 3 }),
    },
    env: { known: {}, floors: { 'claude-opus-5': FL(190000) }, resolves: 'claude-opus-5', label: 'Opus 5' },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 180000, src: 'measured', measured: true, raw: 200000 },
      tokens: { value: 190000, src: 'frames', measured: false },
      // no ⚠: nothing was REFUSED — the source passed, it is simply not durable (see d3 for the legal region)
      pct: 105.56, bar: 100, level: 'hot', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: null, learn: [], floor: 190000,
    },
    line: 'Kontext ≈ 106% · 190.000 / 180.000',
  },
  // --- round 5 (05.10.): an ESTIMATE is no proof. Julian's tab, verbatim from his browser console. ---------
  {
    name: 'j1) Julian 05.10.: the CLI measures 1 000 000 for this session, a stored bound of 1 089 676 nobody proved → the measurement',
    finding: '„580K / –" — a floor filed from get_context_usage.totalTokens refused the CLI\'s own maxTokens for good',
    // The state as the console dumped it: selector „…opus-5-5[1m]", frames „claude-opus-5-5" → key
    // „claude-opus-5-5[1m]"; the CLI answered maxTokens 1 000 000 in this generation; the frames have moved on
    // since (627 860, so the token half is the frames'). And in cc_ctx_floors a BARE NUMBER 1 089 676 for that
    // key — larger than any single call in any transcript (maximum of this session 628 766, of Demoprojekt
    // 999 651). It can only have come from `totalTokens`, the CLI's ESTIMATE for the next request, which the old
    // (8) counted as „one accepted call". Two rules turn the row: a bare number is a legacy entry without
    // provenance (ctxFloorAt reads only {below, src:'frame'}), and a measured window is never gated by a floor.
    // The learned store is Julian's own, legacy keys included: the decision reads it by canonical key only.
    tab: {
      id: 'c1', model: 'claude-opus-5-5', modelSel: 'eu.anthropic.claude-opus-5-5[1m]', ctxTokens: 627860, ctxStamp: 9,
      ctxMeasured: measured({ tokens: 625470, win: 1000000, raw: 1000000, pct: 63, hasPct: true, source: 'model-default', stamp: 8 }),
    },
    env: {
      known: {
        'eu.anthropic.claude-opus-5': 1000000, 'eu.anthropic.claude-haiku-4-5-20251001-v1:0': 200000,
        'eu.anthropic.claude-opus-5-5': 200000, 'eu.anthropic.claude-sonnet-5': 1000000,
        'claude-opus-5[1m]': 1000000, 'claude-haiku-4-5': 200000, 'claude-opus-5-5': 1000000,
      },
      floors: { 'claude-opus-5-5[1m]': 1089676 },
      sel: 'eu.anthropic.claude-opus-5-5[1m]', resolves: 'eu.anthropic.claude-opus-5-5', label: 'Opus 5.5 (1M)',
    },
    want: {
      model: { id: 'claude-opus-5-5', key: 'claude-opus-5-5[1m]', wide: true, varUnknown: false, src: 'frame' },
      win: { value: 1000000, src: 'measured', measured: true, raw: 1000000 },
      tokens: { value: 627860, src: 'frames', measured: false },
      pct: 62.79, bar: 62.79, level: 'warm', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: { win: 1000000, key: 'claude-opus-5-5[1m]' }, learn: [{ key: 'claude-opus-5-5[1m]', win: 1000000 }],
      autocompact: 'model-default',
    },
    line: 'Kontext ≈ 63% · 627.860 / 1.000.000',
  },
  {
    name: 'j2) …the moment that filed it: an ESTIMATE over the window of its own answer → window „–", ⚠, nothing filed',
    finding: 'the old (8) read totalTokens > maxTokens as „one call beat the window" — dropped the window AND filed 1 089 676',
    // `totalTokens` and `maxTokens` from the SAME answer: the CLI says its next request would be 1 089 676 tokens in
    // a 1 000 000 window. That is no accepted call, so it files NOTHING — no floor (the bug), no adopted or learned
    // window. CHANGED in the counter-check of 05.10.: the first version also SHOWED the pair as the CLI states it
    // („Kontext 109 % · 1.089.676 / 1.000.000"), and that exemption is exactly what let a live switch onto Haiku
    // print „250 % · 500,8K / 200,0K" without a ⚠ (row j5). The pair cannot say which of its halves is off, so the
    // line treats it like every unresolved contradiction: the count stays, the window goes to „–", the tooltip says
    // it was an ESTIMATE — and the next frame below the window (600 000 here) puts the measured 1M straight back.
    tab: {
      id: 'c1', model: 'claude-opus-5-5', modelSel: 'eu.anthropic.claude-opus-5-5[1m]', ctxTokens: 600000, ctxStamp: 4,
      ctxMeasured: measured({ tokens: 1089676, win: 1000000, raw: 1000000, pct: 109, hasPct: true, source: 'model-default', stamp: 4 }),
    },
    env: { known: {}, floors: {}, sel: 'eu.anthropic.claude-opus-5-5[1m]', resolves: 'eu.anthropic.claude-opus-5-5', label: 'Opus 5.5 (1M)' },
    want: {
      model: { id: 'claude-opus-5-5', key: 'claude-opus-5-5[1m]', wide: true, varUnknown: false, src: 'frame' },
      win: { value: 0, src: 'unknown', measured: false, raw: 0 },
      tokens: { value: 1089676, src: 'measured', measured: true },
      pct: 0, bar: 0, level: '', unknownWin: true, measured: false,
      pending: false, pendingWhy: '', conflict: 'over-window', shows: 'tokens',
      adopt: null, learn: [], refuted: null,
    },
    line: '⚠ Kontext · 1.089.676 / –',
    title: ['commands.kontextFensterLautCli', 'commands.kontextQuelleGemessen',
      'commands.kontextFensterUeberSchaetzung', 'commands.kontextZeigtTokens'],
  },
  {
    name: 'j5) a live switch from a 1M tab onto Haiku: the first answer is 500 800 / 200 000 → never „250 % · 500,8K / 200,0K"',
    finding: 'counter-check (hoch): the cliPair exemption printed „Kontext 250% · 500.800 / 200.000" without ⚠ and adopted + learned the 200 000',
    // applyLiveModel → ctxForgetModel (count 0, new generation) → ctxProbe('model'); measured 02.10.: the very next
    // get_context_usage already reports the NEW window, next to the old conversation's size. Both halves measured,
    // and the pair is the reported sentence verbatim. Now: the count, „–", ⚠ with the estimate sentence; nothing
    // adopted, learned or filed. (The CLI compacts before the next request; the frames after it settle the line.)
    tab: {
      id: 'c1', model: 'claude-haiku-4-5', modelSel: 'claude-haiku-4-5', ctxTokens: 0, ctxStamp: 6, _ctxGen: 2,
      ctxMeasured: measured({ tokens: 500800, win: 200000, raw: 200000, pct: 250, hasPct: true, source: 'model-default', stamp: 6, gen: 2 }),
    },
    env: { known: {}, floors: {}, resolves: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    want: {
      model: { id: 'claude-haiku-4-5', key: 'claude-haiku-4-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 0, src: 'unknown', measured: false, raw: 0 },
      tokens: { value: 500800, src: 'measured', measured: true },
      pct: 0, bar: 0, level: '', unknownWin: true, measured: false,
      pending: false, pendingWhy: '', conflict: 'over-window', shows: 'tokens',
      adopt: null, learn: [], refuted: null,
    },
    line: '⚠ Kontext · 500.800 / –',
  },
  {
    name: 'j3) an ESTIMATE over a DERIVED window still drops it from the line — but files no bound',
    finding: 'the protection against derived windows stands; only the durable half moved to frame counts',
    // An answer with `totalTokens` and no `maxTokens` (property 2: a token measurement, not a window one), next
    // to the name table's 200 000: „250 % · 500,8K / 200,0K" over a guessed window is never printed, exactly as
    // before. But an estimate is no accepted call, so `refuted` is null — no floor, no deletion.
    // On claude-haiku-4-5 since 06.10. (was opus-5): the name table's 200 000 has to be the window on offer, and
    // haiku-4-5 is the one model it still lists at 200 000 (CLI 2.1.291).
    tab: {
      id: 'c1', model: 'claude-haiku-4-5', modelSel: 'claude-haiku-4-5', ctxTokens: 120000, ctxStamp: 3,
      ctxMeasured: measured({ tokens: 500800, win: 0, stamp: 3 }),
    },
    env: { known: {}, resolves: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    want: {
      model: { id: 'claude-haiku-4-5', key: 'claude-haiku-4-5', wide: false, varUnknown: false, src: 'frame' },
      win: { value: 0, src: 'unknown', measured: false, raw: 0 },
      tokens: { value: 500800, src: 'measured', measured: true },
      pct: 0, bar: 0, level: '', unknownWin: true, measured: false,
      pending: false, pendingWhy: '', conflict: 'over-window', shows: 'tokens',
      adopt: null, learn: [],
    },
    line: '⚠ Kontext · 500.800 / –',
    // an estimate, not a call: the tooltip must not claim „ein einzelner Aufruf trug mehr"
    title: ['commands.kontextFensterLautCli', 'commands.kontextQuelleGemessen',
      'commands.kontextFensterUeberSchaetzung', 'commands.kontextZeigtTokens'],
  },
  {
    name: 'j4) a typed „/model opus[1m]" not yet confirmed → the variant is UNKNOWN, nothing is filed under the old key',
    finding: '05.10. — between the typed switch and its confirmation the selector describes the session before it',
    // The CLI has switched (its `result.modelUsage` reports 1 000 000 for „claude-opus-5"), the selector still
    // says the bare „claude-opus-5". Without the pending marker this tab is a KNOWN bare variant and both writers
    // would file 1 000 000 under the bare key — the shape of a „claude-opus-5-5: 1 000 000" nobody can attribute.
    // With it: shown (this session's own result needs no spelling), adopted nowhere, learned nowhere.
    tab: {
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 50000, ctxStamp: 2,
      _modelPending: { arg: 'opus[1m]', from: 'claude-opus-5', at: 1, sawResult: false },
    },
    env: {
      known: {}, resolves: 'claude-opus-5', label: 'Opus 5',
      usage: { now: { 'claude-opus-5': { inputTokens: 50000, contextWindow: 1000000 } } },
    },
    want: {
      model: { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: true, src: 'frame' },
      win: { value: 1000000, src: 'session', measured: false, raw: 0 },
      tokens: { value: 50000, src: 'frames', measured: false },
      pct: 5, bar: 5, level: '', unknownWin: false, measured: false,
      pending: false, pendingWhy: '', conflict: '', shows: '',
      adopt: null, learn: [],
    },
    line: 'Kontext ≈ 5% · 50.000 / 1.000.000',
  },
];

// The painted sentence, for the rows that carry a `line`. The reported bug WAS a string, so the step from
// the record to that string is asserted in the same table — the translated pieces are stubbed, because what
// is under test is the composition (the „≈", the „⚠", the „–", the rounding), not the dictionary.
const PENDING_STUB = { measuring: 'MESSE', idle: 'NOCH-NICHT', silent: 'KEINE-ANTWORT', unsupported: 'KANN-NICHT' };
const fmtDe = (n) => new Intl.NumberFormat('de-DE').format(Math.round(n));
const painted = (rec) => ctxGaugeLine(rec, { kontext: 'Kontext ', pending: PENDING_STUB[rec.pendingWhy] }, fmtDe);
// …and the TOOLTIP, by its i18n keys: the sentences are what was wrong about it (one key served both kinds
// of conflict, so one of the two always described the wrong suspect), and keys can be asserted without a
// dictionary. `row.title` lists them in order.
const titled = (rec) => ctxTitleLines(rec).map((l) => l.key);
// The record is still compared WHOLE — this only spells the QUIET case of the three fields the refutation
// rounds added, so that a row has to state them only when it is about them: „nothing was refuted" (`refuted`),
// „no bound has ever been proven for this variant" (`floor`) and „the CLI named no reason for the 100 % line"
// (`autocompact`) are true of most rows. A record that refutes, floors or explains something a row did NOT ask
// for still fails here — the defaults are the expectation, not a hole in it.
// `healed` (05.10.) joins them: „no floor was refuted by the measurement" is true of every row but the ones
// about exactly that.
const wantOf = (row) => Object.assign({ refuted: null, floor: 0, autocompact: '', healed: null }, row.want);

describe('ctx — the ONE decision, one row per (source × variant) combination', () => {
  ROWS.forEach((row) => {
    it(row.name, () => {
      const rec = ctxDecide(row.tab, row.env);
      assert.deepEqual(rec, wantOf(row));
      if (row.line != null) assert.equal(painted(rec), row.line, 'the painted line');
      if (row.title != null) assert.deepEqual(titled(rec), row.title, 'the tooltip sentences');
    });
  });

  it('…and the reported sentence is unreachable for the tab that reported it', () => {
    // „Kontext 250 % · 500,8K / 200,0K" on a tab set to „Opus 5 (1M)" — every row that paints a line is
    // checked for it, so a future path that brings it back has to break this.
    ROWS.filter((r) => r.line != null).forEach((r) => {
      const rec = ctxDecide(r.tab, r.env);
      const wideTab = rec.model.wide;
      assert.equal(wideTab && rec.win.value < 1000000 && !rec.conflict, false,
        r.name + ': a wide tab measured against a smaller window must at least be marked');
    });
  });

  it('…and no row prints a ratio its own window cannot hold', () => {
    // The general form of the reported sentence, which „250 %" was only one instance of: a single API call
    // cannot carry more tokens than the window it was sent to, so a ratio over 100 % is only ever legal
    // between `maxTokens` and `rawMaxTokens` (row d3). Any other row above 100 % means the refutation in
    // ctxDecide (8) stopped working — and unlike the wide-tab check above, this one covers the bare variant,
    // which is where the composer /model switch lands.
    ROWS.forEach((r) => {
      const rec = ctxDecide(r.tab, r.env);
      if (!(rec.pct > 100)) return;
      // (No exemption any more. The first version of 05.10. let both-halves-measured pairs through here — the
      // CLI's own estimate over its own window, row j2 — and that very exemption is what printed „250 % ·
      // 500,8K / 200,0K" for a live switch onto Haiku, row j5. Removed with it in the counter-check.)
      // the same ceiling the decision uses, and for the same reason: `rawMaxTokens` is a field of the route
      // answer, so only a MEASURED window has a second, larger number beside it (B3 · rows d3/d4)
      const ceiling = rec.win.measured ? Math.max(rec.win.value, rec.win.raw || 0) : rec.win.value;
      assert.ok(rec.tokens.value <= ceiling,
        r.name + ': ' + rec.tokens.value + ' tokens against a window of ' + ceiling + ' is not a full context, it is a wrong window');
    });
  });

  it('every row is distinct — a duplicated row hides a missing one', () => {
    const seen = new Map();
    ROWS.forEach((r) => {
      const k = JSON.stringify([r.tab, r.env]);
      assert.equal(seen.has(k), false, r.name + ' repeats ' + seen.get(k));
      seen.set(k, r.name);
    });
  });

  it('the decision is pure — it writes nothing on the tab it is given', () => {
    ROWS.forEach((r) => {
      const before = JSON.stringify(r.tab);
      ctxDecide(r.tab, r.env);
      assert.equal(JSON.stringify(r.tab), before, r.name);
    });
  });
});

// =====================================================================================================
//  The helpers the table stands on. Not a second precedence — each of these answers ONE question, and the
//  table above is the only place where they are ordered.
// =====================================================================================================
describe('ctx — the context is ONE call, not the turn', () => {
  it('reads a frame as its whole input side (cached tokens are in the context too)', () => {
    assert.equal(ctxTokensOfFrame(FRAMES[2]), 2 + 3306 + 38955);
  });

  it('never lets the summed result usage pass as the context', () => {
    // this is the bug: 81 220 reported for a context that held 42 263
    const last = ctxTokensOfFrame(FRAMES[2]);
    const summed = ctxTokensOfFrame(RESULT_USAGE);
    assert.ok(summed > last, 'fixture no longer shows the aggregation');
    // the surplus is the earlier call's input side counted a second time (38 955 cache_creation + 2 in)
    assert.equal(summed - last, 38957);
  });

  it('is 0 for anything that is not a usage object, and never negative', () => {
    [null, undefined, 0, 'x', [], {}, { output_tokens: 500 }].forEach((v) => assert.equal(ctxTokensOfFrame(v), 0));
    assert.equal(ctxTokensOfFrame({ input_tokens: -5 }), 0);
    assert.equal(ctxTokensOfFrame({ input_tokens: 'abc', cache_read_input_tokens: 10 }), 10);
  });

  it('ctxUsageTokens reads the input side of a modelUsage entry and ignores everything else', () => {
    assert.equal(ctxUsageTokens({ inputTokens: 2, cacheReadInputTokens: 10, cacheCreationInputTokens: 5 }), 17);
    assert.equal(ctxUsageTokens({ outputTokens: 500 }), 0);
    assert.equal(ctxUsageTokens(null), 0);
  });
});

describe('ctx — one normalizer, and the variant that changes the window', () => {
  it('reduces a Bedrock id to the bare model (the prefix and the -vN used to be missing)', () => {
    assert.equal(ctxNormModel('eu.anthropic.claude-opus-5[1m]'), 'claude-opus-5');
    assert.equal(ctxNormModel('eu.anthropic.claude-haiku-4-5-20251001-v1:0'), 'claude-haiku-4-5');
    assert.equal(ctxNormModel('us.anthropic.claude-sonnet-5-v1'), 'claude-sonnet-5');
    assert.equal(ctxNormModel('claude-opus-5'), 'claude-opus-5', 'and leaves a bare id alone');
  });

  it('keeps „[1m]" in the KEY — it is the one difference that changes the window', () => {
    // measured: eu.anthropic.claude-opus-5 = 200 000, eu.anthropic.claude-opus-5[1m] = 1 000 000
    assert.equal(ctxVariantKey('eu.anthropic.claude-opus-5[1m]'), 'claude-opus-5[1m]');
    assert.equal(ctxVariantKey('claude-opus-5'), 'claude-opus-5');
    assert.notEqual(ctxVariantKey('opus[1m]'), ctxVariantKey('opus'));
    assert.equal(ctxVariantKey(''), '');
    assert.equal(ctxIsWide('eu.anthropic.claude-opus-5[1m]'), true);
    assert.equal(ctxIsWide('claude-opus-5'), false);
  });

  it('„<synthetic>" is the CLI\'s own sender name, and nothing else is', () => {
    assert.equal(ctxSyntheticModel('<synthetic>'), true);
    assert.equal(ctxSyntheticModel('<any-other-cli-marker>'), true);
    assert.equal(ctxSyntheticModel('claude-opus-5'), false);
    assert.equal(ctxSyntheticModel('eu.anthropic.claude-opus-5[1m]'), false);
    assert.equal(ctxSyntheticModel(''), false);
    assert.equal(ctxSyntheticModel(null), false);
    assert.equal(ctxSyntheticModel('<nicht am ende>x'), false);
  });
});

describe('ctx — the model is resolved first (the „Default" trap)', () => {
  it('„Default" is resolved through its menu entry, which is the only thing that can say 1M', () => {
    assert.deepEqual(ctxResolveModel({ reported: 'claude-opus-5', sel: '', resolves: 'eu.anthropic.claude-opus-5[1m]' }),
      { id: 'claude-opus-5', key: 'claude-opus-5[1m]', wide: true, varUnknown: false, src: 'frame' });
    assert.deepEqual(ctxResolveModel({ reported: 'claude-opus-5', sel: '', resolves: 'eu.anthropic.claude-opus-5' }),
      { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' });
  });

  it('the frames decide WHO is answering; the selector only decides the variant, and only for that model', () => {
    // a CLI-side fallback: the selector names the 1M opus, the frames name haiku — „[1m]" is then no
    // evidence at all about the model that is really answering
    assert.deepEqual(ctxResolveModel({ reported: 'claude-haiku-4-5', sel: 'claude-opus-5[1m]', resolves: 'claude-opus-5' }),
      { id: 'claude-haiku-4-5', key: 'claude-haiku-4-5', wide: false, varUnknown: true, src: 'frame' });
    // …and the alias case, where only `resolves` connects "opus[1m]" to the running id
    assert.deepEqual(ctxResolveModel({ reported: 'claude-opus-5', sel: 'opus[1m]', resolves: 'claude-opus-5' }),
      { id: 'claude-opus-5', key: 'claude-opus-5[1m]', wide: true, varUnknown: false, src: 'frame' });
  });

  it('„not wide" and „nobody said" are different answers (varUnknown)', () => {
    // the H1 case: a „Default" selection whose menu entry resolves to nothing. The model is known (a frame
    // named it), the VARIANT is not — and the sources that are keyed by variant must then stay silent
    // instead of answering for the bare spelling.
    assert.deepEqual(ctxResolveModel({ reported: 'claude-opus-5', sel: '', resolves: '' }),
      { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: true, src: 'frame' });
    assert.equal(ctxNameWindow({ id: 'claude-opus-5', key: 'claude-opus-5', varUnknown: true }), 0,
      'the name table must not answer for a variant nobody named');
    assert.equal(ctxLearnedWindow({ 'claude-opus-5': 200000 }, { id: 'claude-opus-5', key: 'claude-opus-5', varUnknown: true }), 0,
      '…and neither must the learned store');
    // …while the same tab WITH a resolves is a perfectly determined non-wide model
    assert.deepEqual(ctxResolveModel({ reported: 'claude-opus-5', sel: '', resolves: 'claude-opus-5' }),
      { id: 'claude-opus-5', key: 'claude-opus-5', wide: false, varUnknown: false, src: 'frame' });
    // …and for it the table DOES answer. 1 000 000 since the 06.10. measurement (CLI 2.1.291; 200 000 under
    // 2.1.288) — what this line contrasts with the 0 above is that it answers at all, not which number.
    assert.equal(ctxNameWindow({ id: 'claude-opus-5', key: 'claude-opus-5' }), 1000000);
  });

  it('a synthetic sender names no model, and nothing at all is „unknown" rather than a default', () => {
    assert.deepEqual(ctxResolveModel({ reported: '<synthetic>', sel: 'claude-sonnet-5' }),
      { id: 'claude-sonnet-5', key: 'claude-sonnet-5', wide: false, varUnknown: false, src: 'sel' });
    assert.deepEqual(ctxResolveModel({}), { id: '', key: '', wide: false, varUnknown: false, src: '' });
  });
});

describe('ctx — the variant gate, read and write', () => {
  it('a wide model can only be described by a wide number; a non-wide one has no upper bound', () => {
    const wide = { id: 'claude-opus-5', key: 'claude-opus-5[1m]', wide: true };
    const bare = { id: 'claude-opus-5', key: 'claude-opus-5', wide: false };
    assert.equal(ctxVariantFits(wide, 1000000), true);
    assert.equal(ctxVariantFits(wide, 200000), false, 'asked for 1M, got a fifth of it → no evidence');
    assert.equal(ctxVariantFits(bare, 1000000), true, 'sonnet-5 is 1M without any suffix — no upper bound');
    assert.equal(ctxVariantFits(bare, 0), false);
    assert.equal(ctxVariantFits({ id: '', key: '', wide: false }, 200000), false, 'no model → nothing fits');
  });

  it('the learned store is read by exact variant key, with no fallback in either direction', () => {
    const known = { 'claude-opus-5': 200000, 'claude-sonnet-5[1m]': 1000000 };
    assert.equal(ctxLearnedWindow(known, { id: 'claude-opus-5', key: 'claude-opus-5' }), 200000);
    assert.equal(ctxLearnedWindow(known, { id: 'claude-opus-5', key: 'claude-opus-5[1m]' }), 0);
    assert.equal(ctxLearnedWindow(known, { id: 'claude-sonnet-5', key: 'claude-sonnet-5' }), 0);
    assert.equal(ctxLearnedWindow(null, { key: 'claude-opus-5' }), 0);
    assert.equal(ctxLearnedWindow(known, {}), 0);
  });

  it('the name table is what was MEASURED, plus the „[1m]" contract — and nothing else', () => {
    // 2026-10-06, CLI 2.1.291, get_context_usage without a model turn — maxTokens of the bare eu.anthropic.
    // spelling, keyed the way ctxNormModel reduces it (prefix, -vN and the haiku date dropped)
    const MEASURED_2_1_291 = {
      'eu.anthropic.claude-opus-5': 1000000, 'eu.anthropic.claude-opus-5-5': 1000000,
      'eu.anthropic.claude-sonnet-5': 1000000, 'eu.anthropic.claude-sonnet-5-5': 1000000,
      'eu.anthropic.claude-opus-4-8': 1000000, 'eu.anthropic.claude-haiku-4-5-20251001-v1:0': 200000,
    };
    Object.keys(MEASURED_2_1_291).forEach((id) => {
      const m = ctxResolveModel({ reported: ctxNormModel(id), sel: id, resolves: id });
      assert.equal(ctxNameWindow(m), MEASURED_2_1_291[id], id + ' (key ' + m.key + ')');
    });
    assert.equal(ctxNameWindow({ id: 'claude-opus-5', key: 'claude-opus-5[1m]', wide: true }), CTX_WIDE_WINDOW);
    // …and the contract where it can be told from the bare row: haiku-4-5 is the only row below 1M since 06.10.,
    // so a „[1m]" spelling of it (hypothetical — see row k2) is what proves the wide guess never takes the bare row
    assert.equal(ctxNameWindow({ id: 'claude-haiku-4-5', key: 'claude-haiku-4-5[1m]', wide: true }), CTX_WIDE_WINDOW);
    assert.equal(ctxNameWindow({ id: 'claude-opus-9', key: 'claude-opus-9' }), 0, 'an unmeasured model is unknown, not 200 000');
    assert.equal(ctxNameWindow({ id: '', key: '' }), 0);
  });

  it('ctxWindowFromUsage claims nothing when the CLI said nothing', () => {
    const m = { id: 'claude-opus-5', key: 'claude-opus-5', wide: false };
    assert.deepEqual(ctxWindowFromUsage(null, m), { win: 0, refused: 0 });
    assert.deepEqual(ctxWindowFromUsage({}, m), { win: 0, refused: 0 });
    assert.deepEqual(ctxWindowFromUsage({ 'claude-opus-5': { inputTokens: 5 } }, m), { win: 0, refused: 0 });
    assert.deepEqual(ctxWindowFromUsage({ 'claude-opus-5': null }, m), { win: 0, refused: 0 });
  });

  it('ctxWindowFromUsage never hands out a window its own gate would refuse', () => {
    // The invariant the `adopt` gate in ctxDecide states a second time (ctx.js (7)): whatever this function
    // returns as `win` fits the variant. It is asserted here because that second gate is NOT reachable
    // through ctxDecide — if this invariant holds, no input can produce a contradicting `fresh` — so no
    // table row can go red for it. The gate stays because `tab.ctxReported` is a PERSISTED store and „the
    // weaker of two rules wins" is exactly how a 200 000 reached a „[1m]" tab; this test is what keeps the
    // two in step, and it is the thing that goes red if the gate here is ever removed.
    const wide = { id: 'claude-opus-5', key: 'claude-opus-5[1m]', wide: true };
    const cases = [
      { 'claude-opus-5[1m]': { contextWindow: 200000 } },                                   // exact key, wrong number
      { 'claude-opus-5': { contextWindow: 200000 } },                                       // bare key, wrong number
      { 'claude-opus-5[1m]': { contextWindow: 200000 }, 'claude-opus-5': { contextWindow: 200000 } },
      { 'fremd[1m]': { contextWindow: 200000, inputTokens: 9 } },                           // the weight fallback
      { fremd: { contextWindow: 200000, inputTokens: 9 } },
    ];
    cases.forEach((u, i) => {
      const r = ctxWindowFromUsage(u, wide);
      assert.equal(r.win === 0 || ctxVariantFits(wide, r.win), true, 'case ' + i + ' handed out ' + r.win);
    });
  });

  it('ctxLearnEntries ignores junk and never invents a window', () => {
    const m = { id: 'claude-opus-5', key: 'claude-opus-5', wide: false };
    assert.deepEqual(ctxLearnEntries(null, m), []);
    assert.deepEqual(ctxLearnEntries({ x: null, y: { contextWindow: 0 }, z: { contextWindow: 'viel' } }, m), []);
    assert.deepEqual(ctxLearnEntries({ '': { contextWindow: 200000 } }, m), [], 'a nameless key is no knowledge');
  });

  it('ctxStoreMerge writes only real changes, so a repeated report is not a localStorage write', () => {
    const known = {};
    assert.equal(ctxStoreMerge(known, [{ key: 'claude-opus-5', win: 200000 }]), 1);
    assert.equal(ctxStoreMerge(known, [{ key: 'claude-opus-5', win: 200000 }]), 0);
    assert.equal(ctxStoreMerge(known, [{ key: 'claude-opus-5', win: 1000000 }]), 1, 'the newer report wins');
    assert.deepEqual(known, { 'claude-opus-5': 1000000 });
    assert.equal(ctxStoreMerge(known, [{ key: '', win: 5 }, { key: 'x', win: 0 }, null]), 0);
    assert.equal(ctxStoreMerge(null, [{ key: 'a', win: 1 }]), 0);
  });

  it('ctxStoreMerge DELETES a withdrawn window — a store with no delete path cannot be corrected (B1)', () => {
    const known = { 'claude-opus-7': 200000, 'claude-opus-7[1m]': 1000000, 'claude-haiku-4-5': 200000 };
    const w = { key: 'claude-opus-7', below: 500800 };
    assert.equal(ctxStoreMerge(known, [], w), 1, 'a deletion is a change, so the caller persists it');
    assert.deepEqual(known, { 'claude-opus-7[1m]': 1000000, 'claude-haiku-4-5': 200000 },
      'the OTHER variant and the side-call are untouched — nothing was proved about those');
    assert.equal(ctxStoreMerge(known, [], w), 0, 'and it is gone, so there is nothing left to write');
    assert.equal(ctxStoreMerge(known, [], { key: 'claude-opus-7[1m]', below: 500800 }), 0,
      'a window ABOVE the count that refuted the other one is not refuted by it');
    assert.equal(ctxStoreMerge(known, [], { key: 'gibt-es-nicht', below: 9 }), 0);
    assert.equal(ctxStoreMerge(known, null, null), 0, 'nothing to merge and nothing to withdraw is not a write');
    // a report and a withdrawal in one call: merged first, so the withdrawal always wins
    const k2 = { 'claude-opus-7': 200000 };
    assert.equal(ctxStoreMerge(k2, [{ key: 'claude-haiku-4-5', win: 200000 }], w), 2);
    assert.deepEqual(k2, { 'claude-haiku-4-5': 200000 });
  });

  it('…and „refuted" is ONE rule for all three holders (ctxWindowRefuted / ctxReportedRefuted / ctxSavedRefuted)', () => {
    // The evidence is a token count ONE accepted call carried, so the real window is LARGER than it: the
    // numbers smaller than the count are wrong, the one it fills exactly is a context at 100 % and legal, and a
    // bigger one is not touched. Both the shared store and the tab's persisted window ask this same question —
    // „the store with the weaker rule wins" is exactly how a 200 000 reached a „[1m]" tab.
    const w = { key: 'claude-opus-7', below: 500800 };
    assert.equal(ctxWindowRefuted(200000, w), true);
    assert.equal(ctxWindowRefuted(500800, w), false, 'a window the count exactly FILLS is not refuted');
    assert.equal(ctxWindowRefuted(1000000, w), false);
    assert.equal(ctxWindowRefuted(0, w), false);
    assert.equal(ctxWindowRefuted(200000, null), false);
    assert.equal(ctxWindowRefuted(200000, { key: '', below: 500800 }), false, 'no variant → nothing to withdraw');
    assert.equal(ctxReportedRefuted({ win: 200000, key: 'claude-opus-7' }, w), true);
    assert.equal(ctxReportedRefuted({ win: 200000, key: 'claude-opus-7[1m]' }, w), false,
      'the other variant\'s window was not the one the frames disproved');
    assert.equal(ctxReportedRefuted({ win: 1000000, key: 'claude-opus-7' }, w), false);
    assert.equal(ctxReportedRefuted(null, w), false);
    assert.equal(ctxReportedRefuted({ win: 200000, key: 'claude-opus-7' }, null), false);
    // the third holder, in the shape persistTabs writes ({variante, fenster} — ctxWindowSave)
    assert.equal(ctxSavedRefuted({ variante: 'claude-opus-7', fenster: 200000 }, w), true);
    assert.equal(ctxSavedRefuted({ variante: 'claude-opus-7[1m]', fenster: 200000 }, w), false, 'other variant');
    assert.equal(ctxSavedRefuted({ variante: 'claude-opus-7', fenster: 1000000 }, w), false, 'not refuted by 500 800');
    assert.equal(ctxSavedRefuted(1000000, w), false, 'a legacy bare number names no variant');
    assert.equal(ctxSavedRefuted(null, w), false);
    assert.equal(ctxSavedRefuted({ variante: 'claude-opus-7', fenster: 200000 }, null), false);
  });
});

describe('ctx — the FLOOR: the arithmetic, the key and the growth (F1)', () => {
  it('refuses strictly SMALLER windows only — the one the count fills exactly is a context at 100 %', () => {
    // The whole difference between „at or below" and „below": a 200 K session whose last call before the
    // auto-compaction carried 200 000 tokens would otherwise refuse its own, correct window and print „–".
    assert.equal(ctxBelowFloor(199999, 200000), true);
    assert.equal(ctxBelowFloor(200000, 200000), false, 'exactly full is a real state, not a contradiction');
    assert.equal(ctxBelowFloor(1000000, 200000), false);
    assert.equal(ctxBelowFloor(200000, 0), false, 'no bound proven → nothing is refused');
    assert.equal(ctxBelowFloor(0, 200000), false, '„no window at all" is not a window to refuse');
    assert.equal(ctxBelowFloor(null, null), false);
  });

  it('is read by the EXACT variant key, like the windows beside it', () => {
    // Point 1 of „why it cannot over-reach": the 200 K variant and the 1M one are two keys, so a bound proven
    // for one is never in force for the other — in either direction (row fl5 is the same rule as a record).
    const floors = { 'claude-opus-5': FL(500800), 'claude-opus-5[1m]': FL(900000) };
    assert.equal(ctxFloorAt(floors, 'claude-opus-5'), 500800);
    assert.equal(ctxFloorAt(floors, 'claude-opus-5[1m]'), 900000);
    assert.equal(ctxFloorAt(floors, 'claude-sonnet-5'), 0, 'nothing proven about a model nobody refuted');
    assert.equal(ctxFloorAt(floors, ''), 0);
    assert.equal(ctxFloorAt(null, 'claude-opus-5'), 0);
    assert.equal(ctxFloorAt({ 'claude-opus-5': FL(-5) }, 'claude-opus-5'), 0, 'a broken store proves nothing');
  });

  it('only a PROVEN entry is a floor — a bare number is legacy and reads as none (05.10.)', () => {
    // A bare number is what every floor looked like before this round, and it cannot say whether it came from a
    // frame, from a measured ESTIMATE (Julian's 1 089 676) or from a frame that beat a measurement. So it is not
    // evidence; ctxFloorStoreClean drops it on load, and ctxFloorAt does not read it in between either.
    assert.equal(ctxFloorAt({ 'claude-opus-5-5[1m]': 1089676 }, 'claude-opus-5-5[1m]'), 0, 'legacy');
    assert.equal(ctxFloorAt({ k: { below: 500800 } }, 'k'), 0, 'no provenance named');
    assert.equal(ctxFloorAt({ k: { below: 500800, src: 'measured' } }, 'k'), 0, 'an estimate is no proof');
    assert.equal(ctxFloorAt({ k: FL(500800) }, 'k'), 500800);
    assert.deepEqual(ctxFloorEntry({ k: FL(500800, 7) }, 'k'), { below: 500800, src: 'frame', at: 7 });
    assert.equal(ctxFloorEntry({ k: 500800 }, 'k'), null);
  });

  it('grows and never shrinks — a bound that followed the context down would un-prove itself', () => {
    const floors = {};
    const fr = (below) => ({ key: 'claude-opus-5', below, src: 'frame' });
    assert.equal(ctxFloorMerge(floors, fr(500800), 10), 1, 'a change the caller persists');
    assert.equal(ctxFloorMerge(floors, fr(500800), 11), 0, 'the same fact twice is no write');
    assert.equal(ctxFloorMerge(floors, fr(120000), 12), 0, 'a compaction proves nothing new');
    assert.equal(ctxFloorMerge(floors, fr(700000), 13), 1, 'a bigger disproof raises it');
    // stored WITH its provenance and the clock of the proof that raised it last (05.10.)
    assert.deepEqual(floors, { 'claude-opus-5': { below: 700000, src: 'frame', at: 13 } });
    assert.equal(ctxFloorMerge(floors, null), 0);
    assert.equal(ctxFloorMerge(floors, { key: '', below: 9, src: 'frame' }), 0, 'no variant named → nothing is filed');
    assert.equal(ctxFloorMerge(floors, { key: 'x', below: 0, src: 'frame' }), 0);
    assert.equal(ctxFloorMerge(null, { key: 'x', below: 1, src: 'frame' }), 0);
    // …and the second gate behind the decision's: a refutation that does not say it is a FRAME's files nothing
    assert.equal(ctxFloorMerge(floors, { key: 'y', below: 900000 }), 0, 'no provenance → no bound');
    assert.equal(ctxFloorMerge(floors, { key: 'y', below: 900000, src: 'measured' }), 0, 'an estimate → no bound');
    // a legacy number under the key is no bound, so the first proven one replaces it
    const legacy = { 'claude-opus-5-5[1m]': 1089676 };
    assert.equal(ctxFloorMerge(legacy, { key: 'claude-opus-5-5[1m]', below: 628766, src: 'frame' }, 5), 1);
    assert.deepEqual(legacy, { 'claude-opus-5-5[1m]': { below: 628766, src: 'frame', at: 5 } });
  });

  it('…and a refuted floor is taken back exactly — not one a bigger proof replaced since (ctxFloorDrop)', () => {
    const floors = { a: FL(500800), b: FL(700000) };
    assert.equal(ctxFloorDrop(floors, { key: 'a', below: 500800 }), 1);
    assert.equal(ctxFloorDrop(floors, { key: 'a', below: 500800 }), 0, 'already gone → no second write, no second log line');
    assert.equal(ctxFloorDrop(floors, { key: 'b', below: 600000 }), 0, 'the bound in force is not the one the measurement refuted');
    assert.deepEqual(bounds(floors), { b: 700000 });
    assert.equal(ctxFloorDrop(null, { key: 'b', below: 700000 }), 0);
    assert.equal(ctxFloorDrop(floors, null), 0);
  });

  it('…and the ceiling a source claims is ONE function, shared with the refutation', () => {
    // If the floor and the refutation in (8) read different ceilings, a context between the CLI's compaction line
    // and its raw window (row d3 calls that legal) would be refused by the other one at the next turn boundary.
    assert.equal(ctxSourceCeiling({ value: 180000, raw: 200000, measured: true }), 200000);
    assert.equal(ctxSourceCeiling({ value: 180000, raw: 200000, measured: false }), 180000,
      'only the route answer reports a raw window — the derived sources have nothing above their own number');
    assert.equal(ctxSourceCeiling({ value: 200000, measured: true }), 200000);
    assert.equal(ctxSourceCeiling(null), 0);
    // …so a measured 180 000/200 000 pair survives a floor of 190 000, while the learned mirror of it does not
    assert.equal(ctxBelowFloor(ctxSourceCeiling({ value: 180000, raw: 200000, measured: true }), 190000), false);
    assert.equal(ctxBelowFloor(ctxSourceCeiling({ value: 180000, measured: false }), 190000), true);
  });
});

describe('ctx — the two shared stores are CLEANED on load (05.10., Julian\'s dump)', () => {
  // verbatim from his browser console — written by every panel version that ever ran on that machine
  const JULIAN_KNOWN = {
    'eu.anthropic.claude-opus-5': 1000000, 'eu.anthropic.claude-haiku-4-5-20251001-v1:0': 200000,
    'eu.anthropic.claude-opus-5-5': 200000, 'eu.anthropic.claude-sonnet-5': 1000000,
    'claude-opus-5[1m]': 1000000, 'claude-haiku-4-5': 200000, 'claude-opus-5-5': 1000000,
  };
  it('the learned windows: canonical keys stay, every legacy key goes — nothing is guessed', () => {
    // The four prefixed keys are the pre-PR-3b writer's (raw modelUsage keys, „[1m]" stripped — variant-blind).
    // None of them was ever READ (every reader looks up the canonical key), so dropping them cannot change the line.
    // „claude-opus-5-5": 1 000 000 STAYS: the probe of 05.10. (CLI 2.1.289, no model turn) answers maxTokens
    // 1 000 000 for the bare eu.anthropic.claude-opus-5-5 — the premise that it is 200K was refuted by measuring
    // (re-run in the counter-check the same day: 1 000 000 again, also for the bare eu.anthropic.claude-opus-5).
    const r = ctxWindowStoreClean(JULIAN_KNOWN);
    assert.deepEqual(r.known, { 'claude-opus-5[1m]': 1000000, 'claude-haiku-4-5': 200000, 'claude-opus-5-5': 1000000 });
    assert.deepEqual(r.dropped.slice().sort(), ['eu.anthropic.claude-haiku-4-5-20251001-v1:0', 'eu.anthropic.claude-opus-5',
      'eu.anthropic.claude-opus-5-5', 'eu.anthropic.claude-sonnet-5']);
    assert.equal(r.changed, true);
    assert.equal('migrated' in r, false, 'nothing is migrated any more, so there is no such field to read');
    const again = ctxWindowStoreClean(r.known);
    assert.equal(again.changed, false, 'idempotent — the next page load writes nothing');
    assert.deepEqual(again.known, r.known);
  });
  it('…a legacy value below 1M is DROPPED too, not migrated: a never-read key must not start deciding the line', () => {
    // Counter-check of 05.10.: the first version migrated a legacy value below 1M („it can only be the bare
    // variant's"). With Julian's own leftover „eu.anthropic.claude-opus-5-5": 200 000 (filed 01.10. under CLI
    // 2.1.286) and no canonical entry, a bare opus-5-5 tab went from „Kontext · 30.000 / –" to „≈ 15 % · 30.000 /
    // 200.000" — while the probe under 2.1.289 answers 1 000 000 for that very model. An old build's number is no
    // evidence about today's window (ctx.js 6), so the key goes with the others.
    // CHANGED 06.10. — the two lines read „Kontext · 30.000 / –" until the name table learned opus-5-5 (CLI 2.1.291
    // measures the bare one at 1 000 000). The property is unchanged: before and after the cleanup the line is the
    // TABLE's, and the legacy 200 000 — read, or migrated onto the canonical key — is what would turn it into
    // „≈ 15 % · 30.000 / 200.000".
    const lone = { 'eu.anthropic.claude-opus-5-5': 200000 };
    const tab = { id: 'c1', model: 'claude-opus-5-5', modelSel: 'eu.anthropic.claude-opus-5-5', ctxTokens: 30000, ctxStamp: 1 };
    const env = (known) => ({ known, resolves: 'eu.anthropic.claude-opus-5-5', label: 'Opus 5.5' });
    assert.equal(painted(ctxDecide(tab, env(lone))), 'Kontext ≈ 3% · 30.000 / 1.000.000', 'before: the legacy key is not read');
    const r = ctxWindowStoreClean(lone);
    assert.deepEqual(r.known, {});
    assert.equal(painted(ctxDecide(tab, env(r.known))), 'Kontext ≈ 3% · 30.000 / 1.000.000', 'after: still not — the cleanup changed nothing on screen');
    const mixed = ctxWindowStoreClean({
      'eu.anthropic.claude-haiku-4-5-20251001-v1:0': 200000,              // legacy, < 1M → dropped all the same
      'eu.anthropic.claude-opus-7': 200000, 'us.anthropic.claude-opus-7-v1:0': 180000,
      'claude-opus-9[1m]': 200000,                                         // canonical but contradicts itself (ctxVariantFits)
      'claude-opus-8': 'viel', '': 5, 'claude-opus-6': -1,                 // junk
      'claude-sonnet-5': 1000000,                                          // canonical bare 1M: read today, right under 2.1.289
    });
    assert.deepEqual(mixed.known, { 'claude-sonnet-5': 1000000 });
    assert.deepEqual(mixed.dropped.slice().sort(), ['', 'claude-opus-6', 'claude-opus-8', 'claude-opus-9[1m]',
      'eu.anthropic.claude-haiku-4-5-20251001-v1:0', 'eu.anthropic.claude-opus-7', 'us.anthropic.claude-opus-7-v1:0']);
    assert.deepEqual(ctxWindowStoreClean(null), { known: {}, dropped: [], changed: false });
  });
  it('the floors: a proven entry stays, a bare number (Julian\'s 1 089 676) goes — and is NAMED for the log', () => {
    const r = ctxFloorStoreClean({
      'claude-opus-5-5[1m]': 1089676, 'claude-opus-5': FL(500800, 3), 'eu.anthropic.claude-opus-7': FL(400000, 2),
      'claude-opus-8': { below: 300000 }, nope: null,
    });
    assert.deepEqual(r.floors, { 'claude-opus-5': { below: 500800, src: 'frame', at: 3 } });
    assert.deepEqual(r.dropped, [{ key: 'claude-opus-5-5[1m]', below: 1089676 }, { key: 'eu.anthropic.claude-opus-7', below: 400000 },
      { key: 'claude-opus-8', below: 300000 }, { key: 'nope', below: 0 }]);
    assert.equal(r.changed, true);
    assert.equal(ctxFloorStoreClean(r.floors).changed, false);
  });
  it('Julian end to end: his dump as this version loads it → the line reads the CLI\'s window', () => {
    const row = ROWS.find((x) => /^j1\)/.test(x.name));
    const env = Object.assign({}, row.env, { known: ctxWindowStoreClean(row.env.known).known, floors: ctxFloorStoreClean(row.env.floors).floors });
    assert.deepEqual(env.floors, {});
    assert.equal(painted(ctxDecide(row.tab, env)), 'Kontext ≈ 63% · 627.860 / 1.000.000');
    // …and the same tab BEFORE its first measurement no longer shows „–" either: the „[1m]" contract answers
    const fresh = Object.assign({}, row.tab, { ctxMeasured: null });
    assert.equal(painted(ctxDecide(fresh, env)), 'Kontext ≈ 63% · 627.860 / 1.000.000');
  });
  it('commands.js loads each store ONCE per page: cleaned, persisted, one 🔔 line that names what went', () => {
    const ls = { cc_ctx_floors: JSON.stringify({ 'claude-opus-5-5[1m]': 1089676 }), cc_ctx_windows: JSON.stringify(JULIAN_KNOWN) };
    const writes = []; const log = [];
    const env = {
      localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { writes.push(k); ls[k] = v; } },
      logEvent: (m, k) => log.push([m, k]), t: (k) => k + ' n={n}', fmtNum: (n) => String(n),
    };
    const ctxStoreLoad = loadCmdFn('ctxStoreLoad', env);
    const floorStore = loadCmdFn('ctxFloorStore', { CTX_FLOORS: null, CTX_FLOORS_KEY: 'cc_ctx_floors', ctxStoreLoad, ctxFloorStoreClean });
    const windowStore = loadCmdFn('ctxWindowStore', { CTX_WINDOWS: null, CTX_WINDOWS_KEY: 'cc_ctx_windows', ctxStoreLoad, ctxWindowStoreClean });
    assert.deepEqual(floorStore(), {});
    assert.equal(floorStore(), floorStore(), 'cached: the same object every call');
    assert.deepEqual(JSON.parse(ls.cc_ctx_floors), {}, 'the cleaned store is persisted at once');
    assert.deepEqual(windowStore(), { 'claude-opus-5[1m]': 1000000, 'claude-haiku-4-5': 200000, 'claude-opus-5-5': 1000000 });
    windowStore();
    assert.deepEqual(writes, ['cc_ctx_floors', 'cc_ctx_windows'], 'one write per store, not one per read');
    assert.equal(log.length, 2);
    assert.equal(log[0][0], 'commands.kontextBoedenBereinigt n=1 claude-opus-5-5[1m] ≥ 1089676');
    assert.match(log[1][0], /^commands\.kontextFensterSpeicherBereinigt n=4 /);
    // a clean store is read and NOT rewritten, and says nothing
    const ls2 = { cc_ctx_floors: JSON.stringify({ k: FL(5, 1) }) }; const w2 = []; const l2 = [];
    const load2 = loadCmdFn('ctxStoreLoad', { localStorage: { getItem: (k) => ls2[k] || null, setItem: (k) => w2.push(k) },
      logEvent: (m) => l2.push(m), t: (k) => k, fmtNum: String });
    assert.deepEqual(load2('cc_ctx_floors', ctxFloorStoreClean, 'floors', 'x'), { k: { below: 5, src: 'frame', at: 1 } });
    assert.deepEqual([w2, l2], [[], []]);
  });
  // --- several PANEL WINDOWS on one localStorage (counter-check of 05.10.) -----------------------------------
  // Each page caches both stores; every writer used to write its whole cached object back, so the last writer won —
  // and since this round a store can SHRINK (a healed floor, the load cleanup), which made that a resurrection.
  // Two pages are built here from commands.js's own functions, each with its own cache variables, over ONE fake
  // localStorage — the shape of two browser windows of the panel.
  const PAGE_FNS = ['ctxStoreLoad', 'ctxStoreFresh', 'ctxStoreForget', 'ctxFloorStore', 'ctxWindowStore',
    'ctxFloorLearn', 'ctxFloorHeal', 'ctxLearn'];
  function page(ls, log) {
    const src = PAGE_FNS.map((n) => {
      const m = CMD_SRC.match(new RegExp('^function ' + n + '\\([\\s\\S]*?^\\}', 'm'));
      assert.ok(m, n + '() not found in public/js/commands.js');
      return m[0];
    }).join('\n');
    const env = {
      localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = v; } },
      CTX_FLOORS_KEY: 'cc_ctx_floors', CTX_WINDOWS_KEY: 'cc_ctx_windows',
      ctxFloorStoreClean, ctxWindowStoreClean, ctxFloorMerge, ctxFloorDrop, ctxStoreMerge,
      logEvent: (m) => (log || []).push(m), t: (k) => k, fmtNum: String, Date,
    };
    const names = Object.keys(env);
    return new Function(...names, 'let CTX_FLOORS = null, CTX_WINDOWS = null;\n' + src + '\nreturn { ' + PAGE_FNS.join(', ') + ' };')(
      ...names.map((k) => env[k]));
  }
  it('two panel windows: a floor one window HEALED is not written back by the other\'s next, unrelated write', () => {
    const ls = { cc_ctx_floors: JSON.stringify({ 'claude-opus-5': FL(500800, 1) }) };
    const w1 = page(ls), w2 = page(ls);
    assert.equal(ctxFloorAt(w1.ctxFloorStore(), 'claude-opus-5'), 500800);
    assert.equal(ctxFloorAt(w2.ctxFloorStore(), 'claude-opus-5'), 500800, 'both windows hold it in their cache');
    w1.ctxFloorHeal({ key: 'claude-opus-5', below: 500800 }, 1000000);
    assert.deepEqual(JSON.parse(ls.cc_ctx_floors), {}, 'window 1 removed it');
    // window 2 has not seen the storage event yet (or never will, see below) and proves a bound for another key
    w2.ctxFloorLearn({ key: 'claude-sonnet-5', below: 300000, src: 'frame' });
    assert.deepEqual(bounds(JSON.parse(ls.cc_ctx_floors)), { 'claude-sonnet-5': 300000 },
      'the healed bound is NOT back — the write started from the current store, not from window 2\'s copy');
    assert.deepEqual(bounds(w2.ctxFloorStore()), { 'claude-sonnet-5': 300000 }, '…and window 2\'s cache is that store now');
    // the other direction: a bound window 1 proves is not erased by window 2's next heal of something else
    w1.ctxFloorLearn({ key: 'claude-opus-5[1m]', below: 900000, src: 'frame' });
    w2.ctxFloorHeal({ key: 'claude-sonnet-5', below: 300000 }, 1000000);
    assert.deepEqual(bounds(JSON.parse(ls.cc_ctx_floors)), { 'claude-opus-5[1m]': 900000 });
  });
  it('…the same for the learned windows, and a `storage` event drops a cache another window has replaced', () => {
    const ls = { cc_ctx_windows: JSON.stringify({ 'claude-opus-5': 200000 }) };
    const w1 = page(ls), w2 = page(ls);
    assert.deepEqual(w1.ctxWindowStore(), { 'claude-opus-5': 200000 });
    assert.deepEqual(w2.ctxWindowStore(), { 'claude-opus-5': 200000 });
    w1.ctxLearn([], { key: 'claude-opus-5', below: 500800 });              // the hygiene delete of a refuted window
    w2.ctxLearn([{ key: 'claude-haiku-4-5', win: 200000 }], null);
    assert.deepEqual(JSON.parse(ls.cc_ctx_windows), { 'claude-haiku-4-5': 200000 }, 'the deleted window stays deleted');
    // a READ keeps its cache until the browser says another window wrote — then it reloads
    assert.deepEqual(w1.ctxWindowStore(), {}, 'window 1 still reads its own copy (no event yet)');
    w1.ctxStoreForget({ key: 'cc_ctx_windows' });
    assert.deepEqual(w1.ctxWindowStore(), { 'claude-haiku-4-5': 200000 }, '…and the current store after the event');
    w1.ctxStoreForget({ key: 'some-other-key' });
    assert.deepEqual(w1.ctxWindowStore(), { 'claude-haiku-4-5': 200000 });
    // localStorage.clear() fires the event with key null — both stores went
    ls.cc_ctx_floors = JSON.stringify({ 'claude-opus-5': FL(500800, 1) });
    w1.ctxStoreForget({ key: 'cc_ctx_floors' });
    assert.deepEqual(bounds(w1.ctxFloorStore()), { 'claude-opus-5': 500800 }, '(the floors are cached on window 1 now)');
    delete ls.cc_ctx_windows; delete ls.cc_ctx_floors;
    w1.ctxStoreForget({ key: null });
    assert.deepEqual([w1.ctxWindowStore(), w1.ctxFloorStore()], [{}, {}]);
    // …and the listener is really registered on the page (a wiring line: the event comes from the browser)
    assert.match(CMD_SRC, /window\.addEventListener\('storage', ctxStoreForget\)/);
  });
  it('…an OLD page that writes leftovers in between is cleaned again on the next write, and says so', () => {
    const log = [];
    const ls = { cc_ctx_floors: '{}' };
    const w = page(ls, log);
    w.ctxFloorStore();
    ls.cc_ctx_floors = JSON.stringify({ 'claude-opus-5-5[1m]': 1089676 });    // what the pre-fix code still files
    w.ctxFloorLearn({ key: 'claude-opus-5', below: 500800, src: 'frame' });
    assert.deepEqual(bounds(JSON.parse(ls.cc_ctx_floors)), { 'claude-opus-5': 500800 }, 'the bare number is gone again');
    assert.equal(log.length, 1, 'and the 🔔 log names it');
  });
  it('the learn path no longer files ANOTHER model\'s 1M under its bare key (the variant-blind write that remained)', () => {
    const m = { id: 'claude-opus-5', key: 'claude-opus-5[1m]', wide: true, varUnknown: false };
    // modelUsage after a /model switch is cumulative: the model before (opus-5-5, 1M) sits beside the current one
    const out = ctxLearnEntries({
      'eu.anthropic.claude-opus-5': { contextWindow: 1000000 },
      'eu.anthropic.claude-opus-5-5': { contextWindow: 1000000 },
      'eu.anthropic.claude-haiku-4-5-20251001-v1:0': { contextWindow: 200000 },
    }, m);
    assert.deepEqual(out, [{ key: 'claude-opus-5[1m]', win: 1000000 }, { key: 'claude-haiku-4-5', win: 200000 }],
      'this tab\'s own model under its known variant, and the side-call that can only be bare — not the 1M of opus-5-5');
    // …while the tab's OWN bare model still files its own number, without an upper bound (sonnet-5 is 1M bare)
    assert.deepEqual(ctxLearnEntries({ 'claude-sonnet-5': { contextWindow: 1000000 } },
      { id: 'claude-sonnet-5', key: 'claude-sonnet-5', wide: false, varUnknown: false }), [{ key: 'claude-sonnet-5', win: 1000000 }]);
  });
});

describe('ctx — the measured answer (CTX-4)', () => {
  it('reads the fields the CLI actually sends', () => {
    const m = ctxFromRoute(ROUTE_ANSWER);
    assert.equal(m.tokens, 18529);
    assert.equal(m.win, 200000);
    assert.equal(m.raw, 200000);
    assert.equal(m.pct, 9);
    assert.equal(m.hasPct, true);
    assert.equal(m.source, 'model-default');
  });

  it('…and `autocompactSource` reaches the TOOLTIP now, verbatim (F3)', () => {
    // F3 was „nothing reads it — use it or drop it". It is the CLI's own answer to „whose limit is the 100 %
    // line", and the tooltip is where this panel already prints the CLI's field names (rawMaxTokens), so it is
    // used: carried on the record, appended untranslated. The row that pins the sentence ORDER is a); this pins
    // that the string itself travels, which `titled()` (keys only) cannot see.
    const rec = ctxDecide({
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxStamp: 3,
      ctxMeasured: measured({ tokens: 18529, win: 200000, raw: 200000, pct: 9, hasPct: true, source: 'model-default', stamp: 3 }),
    }, { known: {}, resolves: 'claude-opus-5', label: 'Opus 5' });
    const line = ctxTitleLines(rec).find((l) => l.key === 'commands.kontextGrenzeLautCli');
    assert.ok(line, 'the sentence is there');
    assert.equal(line.text, 'model-default', 'with the CLI\'s own word, not a translation of it');
    // …and a derived window has no such field, so nothing is claimed about a limit nobody reported
    const derived = ctxDecide({ id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 1000 },
      { known: { 'claude-opus-5': 200000 }, resolves: 'claude-opus-5', label: 'Opus 5' });
    assert.equal(derived.autocompact, '');
    assert.equal(ctxTitleLines(derived).some((l) => l.key === 'commands.kontextGrenzeLautCli'), false);
  });

  it('a missing maxTokens leaves the WINDOW unmeasured — that is the whole of property 2', () => {
    const m = ctxFromRoute({ totalTokens: 18529, percentage: 9 });
    assert.equal(m.tokens, 18529);
    assert.equal(m.win, 0, 'no maxTokens → this answer says nothing about the window');
  });

  it('„unconfirmed" is not a measurement of 0 — it is no measurement at all', () => {
    assert.equal(ctxFromRoute({ unconfirmed: true }), null);
    // the zeros-only case asserted nothing about `unconfirmed`: `!tot && !max` rejects it on its own, so the
    // flag could have been ignored and the test stayed green. A FULL answer carrying the flag is the one
    // input where only the flag can decide — it is the CLI's timeout, and the numbers beside it are stale.
    assert.equal(ctxFromRoute({ unconfirmed: true, totalTokens: 18529, maxTokens: 200000, percentage: 9 }), null,
      'a complete-looking answer marked unconfirmed is still no measurement');
    assert.equal(ctxFromRoute(null), null);
    assert.equal(ctxFromRoute({}), null);
    assert.equal(ctxFromRoute({ totalTokens: 0, maxTokens: 1000000 }).win, 1000000, 'an empty context with a known window IS one');
  });

  it('a measured 0 is a NUMBER, and a missing totalTokens is not (hasTok)', () => {
    // the pair the row above accepts on purpose: 0 tokens against a known window. The decision tested the
    // number itself (`> 0`), so a measured empty context read as „nothing measured" and the line promised a
    // query that had already been answered.
    assert.equal(ctxFromRoute({ totalTokens: 0, maxTokens: 1000000 }).hasTok, true);
    assert.equal(ctxFromRoute({ maxTokens: 1000000 }).hasTok, false, 'no field → this answer says nothing about the tokens');
    assert.equal(ctxFromRoute({ totalTokens: 'viel', maxTokens: 1000000 }).hasTok, false);
    assert.equal(ctxFromRoute(ROUTE_ANSWER).hasTok, true);
  });

  it('a missing percentage is reported as missing, so the caller divides instead', () => {
    const m = ctxFromRoute({ totalTokens: 100, maxTokens: 200000 });
    assert.equal(m.hasPct, false);
    assert.equal(m.pct, 0);
  });

  // One row per (state × trigger) — because this is the second precedence in the file (which QUESTION is
  // asked, as opposed to which ANSWER is believed), and the defect was a missing row rather than a wrong
  // line: nothing re-armed an exhausted budget at an ordinary turn boundary, so a line that was provably
  // wrong stayed wrong for the rest of the session with no query left to correct it.
  const ASK_ROWS = [
    { name: 'a fresh tab asks at a turn boundary', st: {}, trg: 'result', want: { ask: true, misses: 0, queue: false } },
    { name: 'at most one query per tab', st: { inflight: true }, trg: 'result', want: { ask: false, misses: 0, queue: false } },
    { name: 'one silence still has an attempt left', st: { misses: CTX_MAX_MISSES - 1 }, trg: 'result', want: { ask: true, misses: 1, queue: false } },
    { name: 'twice silent → stop asking', st: { misses: CTX_MAX_MISSES }, trg: 'result', want: { ask: false, misses: 2, queue: false } },
    { name: 'a start re-arms the budget', st: { misses: 9 }, trg: 'start', want: { ask: true, misses: 0, queue: false } },
    { name: 'a model switch re-arms it', st: { misses: 9 }, trg: 'model', want: { ask: true, misses: 0, queue: false } },
    { name: '/clear re-arms it', st: { misses: 9 }, trg: 'clear', want: { ask: true, misses: 0, queue: false } },
    { name: '/compact re-arms it', st: { misses: 9 }, trg: 'compact', want: { ask: true, misses: 0, queue: false } },
    { name: 're-armed, but still one query at a time', st: { misses: 9, inflight: true }, trg: 'model', want: { ask: false, misses: 0, queue: true } },
    { name: 'a state change mid-flight is QUEUED, never dropped (CTX-2)', st: { inflight: true }, trg: 'model', want: { ask: false, misses: 0, queue: true } },
    { name: '…while an ordinary turn boundary mid-flight may be dropped — that answer is about THIS state',
      st: { inflight: true }, trg: 'result', want: { ask: false, misses: 0, queue: false } },
    { name: 'nothing to queue behind', st: {}, trg: 'model', want: { ask: true, misses: 0, queue: false } },
    // C1, the half that makes the correction ARRIVE: while the window is in doubt (no window at all, or one
    // that contradicts something — ctxWindowInDoubt) a turn boundary re-arms the exhausted budget too. That
    // is the only state where one more 8 KB answer per turn is worth its price.
    { name: 'the window is in doubt → a turn boundary re-arms the spent budget',
      st: { misses: CTX_MAX_MISSES, doubt: true }, trg: 'result', want: { ask: true, misses: 0, queue: false } },
    { name: '…but a doubt mid-flight is not queued: the answer on its way is about this very state',
      st: { misses: 9, doubt: true, inflight: true }, trg: 'result', want: { ask: false, misses: 0, queue: false } },
    { name: 'no doubt → the two-silence budget still holds',
      st: { misses: CTX_MAX_MISSES, doubt: false }, trg: 'result', want: { ask: false, misses: 2, queue: false } },
    // …and the state that may never ask again, however often the window is in doubt: this CLI does not have
    // the control, so every further query would spend the route's 25 s ceiling for an answer that cannot come.
    { name: 'a CLI without the control is not asked at a turn boundary',
      st: { unsupported: true, doubt: true }, trg: 'result', want: { ask: false, misses: 0, queue: false } },
    { name: '…nor on a model switch, a /clear or a /compact',
      st: { unsupported: true, misses: 1 }, trg: 'model', want: { ask: false, misses: 1, queue: false } },
    { name: '…and a start is the caller\'s business: it clears the flag first, so this row only has to not ask',
      st: { unsupported: true }, trg: 'start', want: { ask: false, misses: 0, queue: false } },
  ];
  ASK_ROWS.forEach((r) => {
    it('ctxAskDecision: ' + r.name, () => assert.deepEqual(ctxAskDecision(r.st, r.trg), r.want));
  });

  // Which „unconfirmed" is which. lib/chat.js maps BOTH a timeout and a refusal to `unconfirmed: true`, and
  // only the refusal carries the CLI's own wording in `reason` — the one measured example being an older CLI
  // answering „Unsupported control request subtype".
  const UNSUPPORTED_ROWS = [
    { name: 'the measured refusal of an older CLI', r: { ok: true, unconfirmed: true, reason: 'Unsupported control request subtype' }, want: true },
    { name: 'the same sentence spelled differently', r: { ok: true, unconfirmed: true, reason: 'unknown subtype: get_context_usage' }, want: true },
    { name: 'a plain TIMEOUT carries no reason at all → transient, counts as a miss', r: { ok: true, unconfirmed: true }, want: false },
    { name: 'a dead process is not „cannot answer", it is „nobody to ask"', r: { ok: true, unconfirmed: true, reason: 'process not running' }, want: false },
    { name: 'a real answer is no refusal', r: ROUTE_ANSWER, want: false },
    { name: 'nothing at all', r: null, want: false },
  ];
  UNSUPPORTED_ROWS.forEach((r) => {
    it('ctxProbeUnsupported: ' + r.name, () => assert.equal(ctxProbeUnsupported(r.r), r.want));
  });

  it('ctxWindowInDoubt: everything the CLI has not MEASURED is in doubt (B2)', () => {
    // the seam between the two tables: what the decision says, fed straight into the ask decision
    const doubtOf = (row) => ctxWindowInDoubt(ctxDecide(row.tab, row.env));
    const byName = (n) => ROWS.find((r) => r.name.startsWith(n + ')'));
    assert.equal(doubtOf(byName('d')), true, 'a refuted window is in doubt');
    assert.equal(doubtOf(byName('x')), true, 'no window at all is in doubt');
    assert.equal(doubtOf(byName('o')), true, 'a refused variant report is in doubt');
    assert.equal(doubtOf(byName('j')), true, 'a 1M label over a measured 200 000 is in doubt');
    assert.equal(doubtOf(byName('a')), false, 'a measured, uncontradicted window is settled');
    assert.equal(doubtOf(byName('v')), false, '…also when its raw window differs from the 100 % line');
    // B2 — and the three DERIVED sources are in doubt however consistent they look, because the arithmetic
    // refutation is one-sided by construction: `tokens > ceiling` can only catch a window that is too SMALL.
    assert.equal(doubtOf(byName('k')), true, 'a guessed window nobody measured stays in doubt');
    assert.equal(doubtOf(byName('t')), true, '…and so does a learned one: nobody measured it in THIS session');
    assert.equal(doubtOf(byName('b2')), true, '…and a window from this session\'s own result is still not a measurement');
    // …and a source the FLOOR refused: the line has no window, so the one thing that could replace it is a
    // measurement — the probe has to keep asking rather than settle on „–" for the rest of the session.
    assert.equal(doubtOf(byName('fl1')), true, 'a window refused by the proven bound is in doubt');
    assert.equal(doubtOf(byName('fl8')), true, '…on the second tab as well');
    assert.equal(doubtOf(byName('fl6')), true, 'a window the count exactly fills is accepted — but still unmeasured');
    // the worked over-claim: „≈ 15 % · 150.000 / 1.000.000" on a session whose real ceiling is 200 000. It
    // grows to 199 000 and then auto-compacts, so the count never passes the over-claimed divisor — no
    // conflict, ever, no „–" either. Under the old rule this was „settled" and the probe stopped asking after
    // two silences, which made the self-correction blind to exactly the half it cannot compute.
    const overclaim = ctxDecide(
      { id: 'c1', model: 'claude-sonnet-5', modelSel: 'claude-sonnet-5', ctxTokens: 150000, ctxStamp: 2 },
      { known: {}, resolves: 'claude-sonnet-5', label: 'Sonnet 5' });
    assert.equal(overclaim.conflict, '', 'nothing contradicts it — that is the whole problem');
    assert.equal(overclaim.unknownWin, false);
    assert.equal(overclaim.pct, 15);
    assert.equal(ctxWindowInDoubt(overclaim), true, 'only a live measurement can ever catch an over-claim');
    assert.equal(ctxWindowInDoubt(null), false);
  });
});

describe('ctx — the two counters, and why both are compared with ===', () => {
  it('a model switch voids everything measured for the previous model and moves both counters', () => {
    const tb = { ctxTokens: 42263, ctxStamp: 5, ctxReported: { win: 1000000, key: 'claude-opus-5[1m]' },
      _ctxMisses: 2, _ctxModelUsage: { a: 1 },
      ctxMeasured: measured({ tokens: 500800, win: 1000000, stamp: 5 }) };
    const asked = ctxAskedAt(tb);        // what a query in flight captured
    ctxForgetModel(tb);
    assert.equal(ctxAnswerUsable(tb, asked.gen), false, 'the answer asked for the old model must be discarded');
    assert.equal(tb.ctxMeasured, null);
    assert.equal(tb.ctxReported, null);
    assert.equal(tb.ctxTokens, 0);
    assert.equal(tb._ctxMisses, 0, 'a switch re-arms the two attempts');
    assert.equal(tb.ctxStamp, 6, 'the stamp MOVES — it is never set back');
    assert.equal(ctxAnswerUsable(tb, ctxGenOf(tb)), true, 'a query asked after the switch is fine');
    ctxBumpGen(tb);
    assert.equal(ctxGenOf(tb), asked.gen + 2);
    assert.equal(ctxGenOf(null), 0);
    assert.equal(ctxStampOf(null), 0);
  });

  it('keepTokens leaves the number the switching frame itself carried', () => {
    const tb = { ctxTokens: 18529, ctxStamp: 4, ctxReported: { win: 1000000, key: 'claude-opus-5' } };
    ctxForgetModel(tb, true);
    assert.equal(tb.ctxTokens, 18529, 'the assistant frame that named the new model carried its context');
    assert.equal(tb.ctxReported, null, 'the window is still the old model\'s');
  });

  it('an EQUALITY test cannot be fooled by a counter that is set back', () => {
    // the old comparison was „was the measurement captured at or after the current count", and the /clear
    // branch set that count to 0 — which made a capture taken at 5 look younger than the next five frames
    // of the model that had just taken over. With `===` the same reset can only ever DISCARD the capture.
    const tb = { id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 21000, ctxStamp: 5,
      ctxMeasured: measured({ tokens: 500800, win: 1000000, stamp: 5 }) };
    assert.equal(ctxDecide(tb, { known: {} }).tokens.src, 'measured', 'in step → the measurement shows');
    tb.ctxStamp = 0;                                     // the reset that used to promote the old capture
    const st = ctxDecide(tb, { known: {} });
    assert.equal(st.tokens.src, 'frames', 'out of step → the derived number, marked „≈"');
    assert.equal(st.tokens.measured, false);
  });

  it('ctxNoteFrame is the only writer of the derived count, and it always moves the stamp', () => {
    const tb = { ctxTokens: 0, ctxStamp: 0 };
    assert.equal(ctxNoteFrame(tb, 18529), 1);
    assert.equal(tb.ctxTokens, 18529);
    assert.equal(ctxNoteFrame(tb, 0), 1, 'a frame without usage is no context report');
    assert.equal(tb.ctxTokens, 18529, '…and must not zero the number');
    assert.equal(ctxNoteFrame(tb, 42263), 2);
    assert.equal(ctxStampOf(tb), 2);
  });

  it('…and it says whether the number is ONE call or a SUM — a mark that is never cleared loses the floor', () => {
    // The fallback's number may be several times the real context, so no durable bound is filed from it (row
    // fl10). The mark therefore has to go away again when a real `assistant` frame reports — otherwise one
    // fallback turn would silence the refutation for the rest of that tab's life, which nothing on screen shows.
    const tb = { ctxTokens: 0, ctxStamp: 0 };
    ctxNoteFrame(tb, 81220, true);
    assert.equal(tb.ctxTokensSummed, true, 'the summed turn usage is marked');
    ctxNoteFrame(tb, 42263);
    assert.equal(tb.ctxTokensSummed, false, '…and one call clears it again');
    ctxNoteFrame(tb, 50000, true);
    ctxForgetModel(tb);
    assert.equal(tb.ctxTokensSummed, false, 'a model switch starts over');
    ctxNoteFrame(tb, 50000, true);
    ctxForgetContext(tb, 0);
    assert.equal(tb.ctxTokensSummed, false, '…and so does a /clear that knows the new size');
    // 05.10. — but a switch that KEEPS the number keeps its provenance too: the switching frame replaces it right
    // after (ctxNoteFrame sets the mark anew), and when that frame carries no usage the kept number is still the
    // sum it was. Clearing the mark there laundered a summed fallback into „one call" — and into a floor.
    ctxNoteFrame(tb, 81220, true);
    ctxForgetModel(tb, true);
    assert.equal(tb.ctxTokens, 81220);
    assert.equal(tb.ctxTokensSummed, true, 'a kept SUM stays a sum');
    ctxNoteFrame(tb, 0);
    assert.equal(tb.ctxTokensSummed, true, '…also when the switching frame reports no usage');
    const rec = ctxDecide(Object.assign({ id: 'c1', model: 'claude-opus-7', modelSel: 'claude-opus-7' }, tb, { ctxTokens: 500800 }),
      { known: { 'claude-opus-7': 200000 }, resolves: 'claude-opus-7' });
    assert.equal(rec.conflict, 'over-window');
    assert.equal(rec.refuted, null, 'and files no bound');
  });

  it('a frame that beats this generation\'s measurement is REMEMBERED on it — the F2 holder (ctxNoteBeaten)', () => {
    // Counter-check of 05.10.: since a frame that beats a measurement files no floor any more (row d2), nothing
    // remembered the refutation, and the measured 200 000 was back on the line, unmarked, as soon as the count
    // dropped inside the same generation. The mark lives on the measurement and dies with it.
    // On claude-haiku-4-5 since 06.10. (was opus-5), for row d2b's reason: the „–" below has to mean that the name
    // table's identical 200 000 was refused too, and haiku-4-5 is the one model it still lists at 200 000.
    const tab = { id: 'c1', model: 'claude-haiku-4-5', modelSel: 'claude-haiku-4-5', _ctxGen: 4, ctxStamp: 3,
      ctxMeasured: measured({ tokens: 18529, win: 200000, raw: 200000, gen: 4, stamp: 3 }) };
    const env = { known: {}, resolves: 'claude-haiku-4-5', label: 'Haiku 4.5' };
    ctxNoteFrame(tab, 150000);
    assert.equal(tab.ctxMeasured.beaten, undefined, 'a count the window holds marks nothing');
    ctxNoteFrame(tab, 500800);
    assert.equal(tab.ctxMeasured.beaten, 500800, 'one call above the measured window → remembered');
    assert.equal(painted(ctxDecide(tab, env)), '⚠ Kontext · 500.800 / –');
    ctxNoteFrame(tab, 120000);                                       // the count drops, no new generation
    assert.equal(tab.ctxMeasured.beaten, 500800, 'a smaller count does not talk it down');
    const rec = ctxDecide(tab, env);
    assert.equal(painted(rec), '⚠ Kontext · 120.000 / –', 'NOT „≈ 60 % · 120.000 / 200.000" — main\'s line, without main\'s floor');
    assert.deepEqual([rec.conflict, rec.floor, rec.refuted], ['below-floor', 500800, null], 'marked, bounded, nothing filed');
    assert.equal(ctxWindowInDoubt(rec), true, '…and the next boundary asks the CLI again');
    // the mark goes with the measurement: a new generation (a compaction) or a new answer ends it
    ctxForgetContext(tab);
    assert.equal(tab.ctxMeasured, null);
    // only ONE call marks it — not the summed fallback, not a stale count, not another generation, not the raw region
    const fresh = (o) => Object.assign({ id: 'c1', _ctxGen: 1, ctxMeasured: measured({ win: 200000, raw: 200000, gen: 1 }) }, o);
    const summed = fresh(); ctxNoteFrame(summed, 500800, true);
    assert.equal(summed.ctxMeasured.beaten, undefined, 'a sum over the turn proves nothing about one call');
    const stale = fresh({ ctxTokens: 500800, ctxTokensStale: true });
    assert.equal(ctxNoteBeaten(stale), 0);
    const older = fresh({ _ctxGen: 2, ctxTokens: 500800 });
    assert.equal(ctxNoteBeaten(older), 0, 'a measurement of another generation is not this one\'s to mark');
    const between = fresh({ ctxMeasured: measured({ win: 180000, raw: 200000, gen: 1 }), ctxTokens: 190000 });
    assert.equal(ctxNoteBeaten(between), 0, 'between maxTokens and rawMaxTokens is legal for a measurement (row d3)');
    assert.equal(ctxNoteBeaten({ id: 'c1' }), 0);
    assert.equal(ctxNoteBeaten(null), 0);
  });
  it('…and a measurement that LANDS already beaten (the frame came while it was on its way) is marked by the probe', async () => {
    // The second writer: the probe asked at stamp 3, a frame of 500 800 arrived at stamp 4, then the answer landed.
    // ctxNoteFrame had no measurement to mark at that point, so ctxProbe marks it right after storing it.
    // (claude-haiku-4-5 since 06.10., for the reason given in the test above.)
    const probe = loadCmdFn('ctxProbe', {
      ACTIVE: null, api: async () => ({ totalTokens: 18529, maxTokens: 200000, rawMaxTokens: 200000 }),
      ctxEnv: () => ({ known: {}, floors: {}, resolves: 'claude-haiku-4-5', label: 'Haiku 4.5' }),
      ctxRemember: () => {}, updateCtxGauge: () => {}, ctxNoteBeaten,
      ctxAskDecision, ctxWindowInDoubt, ctxDecide, ctxAskedAt, ctxAnswerUsable, ctxFromRoute, ctxProbeUnsupported,
    });
    const tab = { id: 'c1', model: 'claude-haiku-4-5', modelSel: 'claude-haiku-4-5', ctxTokens: 500800, ctxStamp: 4 };
    await probe(tab, 'result');
    assert.equal(tab.ctxMeasured.beaten, 500800);
    tab.ctxTokens = 120000; tab.ctxStamp = 5;
    assert.equal(painted(ctxDecide(tab, { known: {}, resolves: 'claude-haiku-4-5', label: 'Haiku 4.5' })), '⚠ Kontext · 120.000 / –');
  });
  it('/clear and a compaction void the measurement too, and only /clear knows the new size', () => {
    // `id` so the state the line reports is the honest one for a RUNNING session (an unstarted tab is „idle",
    // it is not waiting for anything — see ctxDecide pendingWhy)
    const made = () => ({ id: 'c1', ctxTokens: 500800, ctxStamp: 7, ctxMeasured: measured({ tokens: 500800, win: 1000000, stamp: 7 }) });
    const cleared = made(); const asked = ctxAskedAt(cleared);
    ctxForgetContext(cleared, 0);
    assert.equal(cleared.ctxTokens, 0, '/clear really does leave the context empty');
    assert.equal(cleared.ctxStamp, 8, 'a new number arrived → the measurement is out of step');
    assert.equal(cleared.ctxMeasured, null);
    assert.equal(ctxAnswerUsable(cleared, asked.gen), false, 'a query from before the /clear may not land after it');
    // A compaction states no post-compaction size ANYWHERE: `compact_boundary` carries {trigger,
    // pre_tokens} — the size of what was just thrown away. So nothing is invented (writing a 0 here is what
    // made the gauge publish the summed turn usage as the new context) and nothing is SHOWN either: the
    // number that is still in the field is the size of what was just discarded, and „≈" over it was not
    // enough — the tab painted the old number as if it described the new context. It is marked STALE, and
    // the line then says it is measuring until the probe answers.
    const compacted = made();
    ctxForgetContext(compacted);
    assert.equal(compacted.ctxTokens, 500800, 'no invented number, not even 0');
    assert.equal(compacted.ctxTokensStale, true, '…and not a number to show either');
    assert.equal(compacted.ctxMeasured, null, 'the measurement described the context before it');
    const after = ctxDecide(compacted, { known: {} });
    assert.equal(after.tokens.src, 'none', '→ the pre-compaction size is NOT what the line shows');
    assert.equal(after.pendingWhy, 'measuring', '→ …and the line says so');
    assert.equal(cleared.ctxTokensStale, false, 'a caller that knows the size (/clear: 0) leaves nothing stale');
    // …and the next real number clears it again, through the one writer of the derived count
    ctxNoteFrame(compacted, 1234);
    assert.equal(compacted.ctxTokensStale, false);
    assert.equal(ctxDecide(compacted, { known: {} }).tokens.value, 1234);
  });
});

describe('ctx — a window that survives a reload belongs to a variant (CTX-3)', () => {
  it('saves the number together with the variant KEY it was measured for', () => {
    assert.deepEqual(ctxWindowSave({ win: 1000000, key: 'claude-opus-5[1m]' }),
      { variante: 'claude-opus-5[1m]', fenster: 1000000 });
    assert.equal(ctxWindowSave({ win: 0, key: 'x' }), undefined, 'nothing measured → nothing stored');
    assert.equal(ctxWindowSave({ win: 1000000, key: '' }), undefined, 'no variant → the number says nothing');
    assert.equal(ctxWindowSave(null), undefined);
  });

  it('restores it only for the variant it was measured for', () => {
    const saved = ctxWindowSave({ win: 1000000, key: 'claude-opus-5[1m]' });
    assert.deepEqual(ctxWindowLoad(saved, 'claude-opus-5[1m]'), { win: 1000000, key: 'claude-opus-5[1m]' });
    assert.equal(ctxWindowLoad(saved, 'claude-opus-5'), null, 'the 200 K variant must not inherit 1M');
    assert.equal(ctxWindowLoad(saved, ''), null);
    assert.equal(ctxWindowLoad(1000000, 'claude-opus-5[1m]'), null, 'a legacy bare number names no variant');
    assert.equal(ctxWindowLoad({ variante: 'eu.anthropic.claude-opus-5[1m]', fenster: 1000000 }, 'claude-opus-5[1m]'), null,
      'a legacy entry that stored the raw selector value is dropped too — the CLI is re-asked in seconds');
    assert.equal(ctxWindowLoad(null, 'x'), null);
    assert.equal(ctxWindowLoad({ variante: 'x', fenster: 0 }, 'x'), null);
  });

  // The SAVE and the LOAD appeared in no row together, and that is where the third H1 amplifier lived: the
  // adopt key is computed from the running model (a frame named it), the restore key from the SELECTOR and
  // the menu — and at boot the menu is not loaded yet, so `modelResolves()` answered '' for every entry.
  // One row per (what was adopted × what the menu can say at restore time), so the two keys are compared in
  // the test instead of only in the field.
  const RESTORE_ROWS = [
    { name: 'the menu knows the alias → the key matches what was adopted',
      adopt: { win: 1000000, key: 'claude-opus-5[1m]' }, sel: 'opus[1m]', resolves: 'claude-opus-5',
      want: { win: 1000000, key: 'claude-opus-5[1m]' } },
    { name: 'the same tab restored BEFORE the menu answered → the key is the ALIAS and the window is lost',
      adopt: { win: 1000000, key: 'claude-opus-5[1m]' }, sel: 'opus[1m]', resolves: '', want: null },
    { name: '„Default" with the menu loaded (its entry now carries a real resolves) → the key matches',
      adopt: { win: 1000000, key: 'claude-opus-5[1m]' }, sel: '', resolves: 'eu.anthropic.claude-opus-5[1m]',
      want: { win: 1000000, key: 'claude-opus-5[1m]' } },
    { name: '„Default" before the menu answered → no key at all, so nothing restores',
      adopt: { win: 1000000, key: 'claude-opus-5[1m]' }, sel: '', resolves: '', want: null },
    { name: 'a concrete Bedrock selection restores on its own variant…',
      adopt: { win: 200000, key: 'claude-opus-5' }, sel: 'eu.anthropic.claude-opus-5', resolves: 'eu.anthropic.claude-opus-5',
      want: { win: 200000, key: 'claude-opus-5' } },
    { name: '…and the OTHER variant of the same model inherits nothing',
      adopt: { win: 200000, key: 'claude-opus-5' }, sel: 'eu.anthropic.claude-opus-5[1m]', resolves: 'eu.anthropic.claude-opus-5',
      want: null },
  ];
  RESTORE_ROWS.forEach((r) => {
    it('save → load: ' + r.name, () => {
      const key = ctxResolveModel({ sel: r.sel, resolves: r.resolves }).key;
      assert.deepEqual(ctxWindowLoad(ctxWindowSave(r.adopt), key), r.want);
    });
  });

  it('…so the two rows that LOSE the window are why the restore waits for the model menu', () => {
    // Not a property of these functions but of their CALLER: both losing rows have `resolves: ''`, i.e. the
    // menu had not answered yet — the state restoreTabs runs in at boot. chat.js therefore keeps the saved
    // value raw (`_ctxWindowSaved`) and adopts it from loadModels (ctxAdoptSavedWindow); persistTabs writes
    // it back unchanged in the meantime, so a persist in that window cannot be what deletes it.
    const lost = RESTORE_ROWS.filter((r) => r.want === null && r.resolves === '');
    assert.equal(lost.length, 2, 'both the alias and the „Default" case');
    lost.forEach((r) => {
      const later = ctxResolveModel({ sel: r.sel, resolves: r.sel === '' ? 'eu.anthropic.claude-opus-5[1m]' : 'claude-opus-5' }).key;
      assert.deepEqual(ctxWindowLoad(ctxWindowSave(r.adopt), later), r.adopt, 'the same value survives once the menu can resolve it');
    });
  });
});

// =====================================================================================================
//  A refused model switch is a SUBSTITUTION (H3) — one row per message shape the CLI really sends
// =====================================================================================================
describe('ctx — the model named in a refusal', () => {
  const REFUSALS = [
    { name: 'the measured refusal: restricted id, substitute named — the SUFFIX comes along',
      msg: 'Model "claude-fable-5-1[1m]" is restricted by your organization\'s settings. Using claude-opus-5[1m] instead.',
      want: 'claude-opus-5[1m]' },
    { name: 'the refused id at the FRONT is the wish, never the answer',
      msg: 'Model "quatsch-modell" is not a recognized model id.', want: '' },
    { name: 'a Bedrock inference-profile id survives verbatim (prefix, -vN and all)',
      msg: 'restricted. Using eu.anthropic.claude-opus-5-v1:0 instead.', want: 'eu.anthropic.claude-opus-5-v1:0' },
    { name: 'quoted substitute',
      msg: 'Using "claude-sonnet-5" instead', want: 'claude-sonnet-5' },
    { name: 'prose that names no id → nothing is claimed, the caller asks the session instead',
      msg: 'Using the default model instead.', want: '' },
    { name: 'a bare word is prose too — an id always carries a separator',
      msg: 'Using default instead.', want: '' },
    { name: 'no such sentence at all',
      msg: 'process not running', want: '' },
    { name: 'nothing to read', msg: '', want: '' },
    { name: 'nothing at all', msg: null, want: '' },
  ];
  REFUSALS.forEach((r) => {
    it(r.name, () => assert.equal(ctxModelFromRefusal(r.msg), r.want));
  });

  it('the substitute is a usable model for the decision — variant included', () => {
    const sub = ctxModelFromRefusal('restricted. Using claude-opus-5[1m] instead.');
    assert.equal(ctxVariantKey(sub), 'claude-opus-5[1m]', 'dropping the suffix here would re-create the bug one line later');
    assert.deepEqual(ctxResolveModel({ reported: sub, sel: sub }),
      { id: 'claude-opus-5', key: 'claude-opus-5[1m]', wide: true, varUnknown: false, src: 'frame' });
  });
});

// =====================================================================================================
//  The two pieces of WIRING in public/js/chat.js that feed the decision. Both were defects of their own —
//  a refusal that silently left the panel on the wrong model, and a restore that computed its variant key
//  from a model menu that was not loaded yet — and neither is reachable from a pure function, so neither
//  had a row. They are lifted out of the browser script by name and run against fake globals, the way
//  test/agent-lanes.test.js already does for chat-render.js: that puts the WIRING under test instead of a
//  copy of it, and a rename or a reindent fails loudly here rather than silently skipping.
// =====================================================================================================
const CHAT_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');
function loadChatFn(name, env) {
  const m = CHAT_SRC.match(new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
  assert.ok(m, name + '() not found in public/js/chat.js — renamed or reindented?');
  const names = Object.keys(env);
  return new Function(...names, m[0] + '\nreturn ' + name + ';')(...names.map((k) => env[k]));
}

describe('chat.js — a refused model switch is a SUBSTITUTION (H3)', () => {
  // The menu this fake panel shows, in the order lib/models.js really emits it: „Default", an alias entry, and
  // the concrete Bedrock pair with the „(1M)" row FIRST (buildBedrockMenu sorts sub 0 before sub 1). Both wide
  // rows carry the BARE id as their `resolves` — that is the fact C3 is about, and test/models.test.js pins it
  // against the real builders.
  const MENU = [
    { value: '', label: 'Default', resolves: 'claude-opus-5' },
    { value: 'opus[1m]', label: 'Opus 5 (1M)', resolves: 'claude-opus-5' },
    { value: 'eu.anthropic.claude-opus-5[1m]', label: 'Opus 5 (1M)', resolves: 'eu.anthropic.claude-opus-5' },
    { value: 'eu.anthropic.claude-opus-5', label: 'Opus 5', resolves: 'eu.anthropic.claude-opus-5' },
    { value: 'eu.anthropic.claude-sonnet-5', label: 'Sonnet 5', resolves: 'eu.anthropic.claude-sonnet-5' },
    { value: 'fable[1m]', label: 'Fable 5', resolves: 'claude-fable-5' },
  ];
  const menuValueFor = (list) => loadChatFn('modelMenuValueFor', {
    MODELS_CACHE: { models: list }, ctxVariantKey,
    modelMenuKey: loadChatFn('modelMenuKey', { ctxNormModel, ctxIsWide }),
  });
  // C3 — one row per (what is looked up × which entry may answer). The reverse direction of modelResolves, and
  // it has to be matched on the VARIANT: a wide row's `resolves` is the bare id, so matching on `resolves`
  // alone answered a BARE substitution with the „(1M)" row — and because that row is also the first of the
  // two, every bare substitution on Bedrock did.
  const MENU_VALUE_ROWS = [
    { name: 'the bare model gets the plain row, never the „(1M)" one that resolves to it',
      id: 'eu.anthropic.claude-opus-5', want: 'eu.anthropic.claude-opus-5' },
    { name: '…also when the substitute is spelled without the gateway prefix',
      id: 'claude-opus-5', want: 'eu.anthropic.claude-opus-5' },
    { name: 'the wide variant gets the „(1M)" row',
      id: 'eu.anthropic.claude-opus-5[1m]', want: 'eu.anthropic.claude-opus-5[1m]' },
    { name: '…and an alias entry answers for the wide variant it resolves to, when it is the first that fits',
      id: 'claude-fable-5[1m]', want: 'fable[1m]' },
    { name: 'a bare model whose only entry is a wide one → nothing, and the dropdown keeps its value',
      id: 'claude-fable-5', want: '' },
    { name: 'a model the menu does not have at all → nothing',
      id: 'claude-mythos-5', want: '' },
    { name: 'the alias spelling itself still matches its own entry (a menu with no `resolves` yet)',
      id: 'opus[1m]', want: 'opus[1m]', list: [{ value: 'opus[1m]', label: 'Opus (1M)', resolves: '' }] },
    { name: 'a blocked entry is never offered',
      id: 'claude-opus-5', want: '', list: [{ value: 'eu.anthropic.claude-opus-5', resolves: 'eu.anthropic.claude-opus-5', blocked: true }] },
    { name: 'nothing to look up', id: '', want: '' },
  ];
  MENU_VALUE_ROWS.forEach((r) => {
    it('modelMenuValueFor: ' + r.name, () => assert.equal(menuValueFor(r.list || MENU)(r.id), r.want));
  });
  // one run of applyLiveModel against a fake CLI. `switchError` = what the POST /model answers (null = ok),
  // `settingsModel` = what GET /settings reports, 'throw' = that route is not there.
  async function run(tab, value, switchError, settingsModel) {
    const calls = { toasts: [], probes: [], forgets: 0, paths: [] };
    const sel = { value: 'SOMETHING-ELSE' };
    const fn = loadChatFn('applyLiveModel', {
      ACTIVE: tab,
      api: async (p) => {
        calls.paths.push(p);
        if (/\/model$/.test(p)) {
          if (switchError) { const e = new Error(switchError); e.status = 409; throw e; }
          return { ok: true };
        }
        if (/\/settings$/.test(p)) {
          if (settingsModel === 'throw') throw new Error('no such route');
          return { ok: true, model: settingsModel || '' };
        }
        throw new Error('unexpected ' + p);
      },
      $: () => sel,
      // the key is DELIMITED so the assertion can read it back exactly: „…Ersetzt" is a prefix of
      // „…ErsetztNachgefragt", and a startsWith check would not tell the two sentences apart
      tt: (k) => '<' + k + '>',
      toast: (msg) => calls.toasts.push((String(msg).match(/^<([^>]+)>/) || [, String(msg)])[1]),
      renderTabs: () => {}, renderStatusBar: () => {}, refreshDefaultsPin: () => {},
      updateCtxGauge: () => {}, persistTabsSoon: () => {},
      shortModel: (s) => s,
      modelResolves: (v) => { const h = MENU.find((m) => m.value === v); return h ? h.resolves : ''; },
      modelMenuValueFor: menuValueFor(MENU),
      ctxForgetModel: (t) => { calls.forgets++; ctxForgetModel(t); },
      ctxProbe: (t, trg) => calls.probes.push(trg),
      ctxModelFromRefusal, ctxVariantKey,
    });
    await fn(value);
    return calls;
  }

  const SWITCH_ROWS = [
    {
      name: 'the switch goes through → the tab runs what was asked for',
      tab: { id: 'c1', model: 'claude-opus-5', modelSel: 'eu.anthropic.claude-sonnet-5' },
      value: 'opus[1m]', error: null,
      want: { model: 'claude-opus-5', modelSel: 'opus[1m]', toast: 'chat.modellLiveGewechselt', probes: ['model'], forgets: 1 },
    },
    {
      name: 'the measured refusal names the substitute → the tab adopts THAT model, not the refused one',
      tab: { id: 'c1', model: 'claude-opus-5', modelSel: 'opus[1m]' },
      value: 'fable[1m]',
      error: 'Model "claude-fable-5-1[1m]" is restricted by your organization\'s settings. Using eu.anthropic.claude-opus-5[1m] instead.',
      // the menu knows that id → the dropdown moves with it and `model` becomes the concrete resolves
      want: { model: 'eu.anthropic.claude-opus-5', modelSel: 'eu.anthropic.claude-opus-5[1m]',
        toast: 'chat.modellwechselErsetzt', probes: ['model'], forgets: 1 },
    },
    {
      name: 'a refusal that substitutes the BARE model must not land on the „(1M)" row',
      finding: 'C3 — modelMenuValueFor matched on `resolves`, which for a wide row IS the bare id',
      // The damaging half of H3: the dropdown would read „Opus 5 (1M)" for a 200 K session, and the window
      // decision takes the selector's „[1m]" as this session's variant — so the gauge measures a 200 K session
      // against 1 000 000 and nothing contradicts it until the context grows past 200 000.
      tab: { id: 'c1', model: 'claude-fable-5', modelSel: 'fable[1m]' },
      value: 'fable[1m]',
      error: 'Model "claude-fable-5-1[1m]" is restricted by your organization\'s settings. Using eu.anthropic.claude-opus-5 instead.',
      want: { model: 'eu.anthropic.claude-opus-5', modelSel: 'eu.anthropic.claude-opus-5',
        toast: 'chat.modellwechselErsetzt', probes: ['model'], forgets: 1 },
    },
    {
      name: 'a substitute the menu does not know is still adopted — the strip must name the running model',
      tab: { id: 'c1', model: 'claude-opus-5', modelSel: 'opus[1m]' },
      value: 'fable[1m]', error: 'restricted. Using claude-mythos-5 instead.',
      want: { model: 'claude-mythos-5', modelSel: 'opus[1m]', toast: 'chat.modellwechselErsetzt', probes: ['model'], forgets: 1 },
    },
    {
      name: 'an unknown id substitutes nothing → asked, the session names the model it was already on, nothing changes',
      tab: { id: 'c1', model: 'claude-opus-5', modelSel: 'opus[1m]' },
      value: 'quatsch', error: 'Model "quatsch" is not a recognized model id.', settings: 'claude-opus-5',
      want: { model: 'claude-opus-5', modelSel: 'opus[1m]', toast: 'chat.modellwechselAbgelehnt', probes: [], forgets: 0 },
    },
    {
      name: 'an unparseable refusal over a session that IS on another model → asked, adopted, and said so',
      tab: { id: 'c1', model: 'claude-opus-5', modelSel: 'opus[1m]' },
      value: 'fable[1m]', error: 'policy says no', settings: 'eu.anthropic.claude-sonnet-5',
      want: { model: 'eu.anthropic.claude-sonnet-5', modelSel: 'eu.anthropic.claude-sonnet-5',
        toast: 'chat.modellwechselErsetztNachgefragt', probes: ['model'], forgets: 1 },
    },
    {
      name: '…and when the session cannot be asked either, nothing is guessed',
      tab: { id: 'c1', model: 'claude-opus-5', modelSel: 'opus[1m]' },
      value: 'fable[1m]', error: 'policy says no', settings: 'throw',
      want: { model: 'claude-opus-5', modelSel: 'opus[1m]', toast: 'chat.modellwechselAbgelehnt', probes: [], forgets: 0 },
    },
    {
      name: 'a bare family alias from get_settings is prose, not a model → not adopted over the concrete id',
      tab: { id: 'c1', model: 'claude-opus-5', modelSel: 'opus[1m]' },
      value: 'fable[1m]', error: 'policy says no', settings: 'opus',
      want: { model: 'claude-opus-5', modelSel: 'opus[1m]', toast: 'chat.modellwechselAbgelehnt', probes: [], forgets: 0 },
    },
  ];
  SWITCH_ROWS.forEach((r) => {
    it(r.name, async () => {
      const tab = Object.assign({}, r.tab);
      const calls = await run(tab, r.value, r.error, r.settings);
      assert.equal(tab.model, r.want.model, 'the model the tab believes is running');
      assert.equal(tab.modelSel, r.want.modelSel, 'what the dropdown claims');
      assert.deepEqual(calls.toasts, [r.want.toast], 'what the user is told');
      assert.deepEqual(calls.probes, r.want.probes, 'whether the context is re-asked');
      assert.equal(calls.forgets, r.want.forgets, 'whether the old model\'s window is dropped');
    });
  });

  it('…and the adopted substitute is what the gauge then decides about', () => {
    // the whole point of adopting it: ctxDecide is asked about the model that is RUNNING. With the refused
    // „fable[1m]" left standing, the window question would be about a model nobody is talking to.
    const tab = { id: 'c1', model: 'eu.anthropic.claude-opus-5', modelSel: 'eu.anthropic.claude-opus-5[1m]', ctxTokens: 500800, ctxStamp: 1 };
    const rec = ctxDecide(tab, { known: {}, resolves: 'eu.anthropic.claude-opus-5', label: 'Opus 5 (1M)' });
    assert.equal(rec.model.key, 'claude-opus-5[1m]');
    // (since 06.10. the bare opus-5 is 1 000 000 in the name table too, so the window alone no longer tells the
    // variants apart — the key above does; the contract against a smaller bare row is pinned by row k2)
    assert.equal(rec.win.value, CTX_WIDE_WINDOW, 'the wide variant\'s window');
  });
});

describe('chat.js — the restored window waits for the model menu (H1, third amplifier)', () => {
  // restoreTabs runs at boot BEFORE loadModels() answers, so `modelResolves()` returns '' for every entry
  // and the variant key comes out wrong for exactly the two selections that matter. One row per (what the
  // menu can say × what was saved).
  const MENU = [
    { value: '', label: 'Default', resolves: 'eu.anthropic.claude-opus-5[1m]' },
    { value: 'opus[1m]', label: 'Opus 5 (1M)', resolves: 'claude-opus-5' },
  ];
  const adoptWith = (cache) => loadChatFn('ctxAdoptSavedWindow', {
    MODELS_CACHE: cache,
    modelResolves: (v) => { const h = (cache && cache.models || []).find((m) => m.value === v); return h ? h.resolves : ''; },
    ctxResolveModel, ctxWindowLoad,
  });
  const SAVED = { variante: 'claude-opus-5[1m]', fenster: 1000000 };

  const ADOPT_ROWS = [
    { name: 'menu loaded, alias selection → the window its own turns measured is back',
      cache: { models: MENU }, modelSel: 'opus[1m]', saved: SAVED,
      want: { win: 1000000, key: 'claude-opus-5[1m]' }, keepsRaw: false },
    { name: 'menu loaded, „Default" whose entry now carries a real resolves → also back',
      cache: { models: MENU }, modelSel: undefined, saved: SAVED,
      want: { win: 1000000, key: 'claude-opus-5[1m]' }, keepsRaw: false },
    { name: 'menu NOT loaded yet → nothing is decided and the saved value is KEPT for the second attempt',
      cache: null, modelSel: 'opus[1m]', saved: SAVED, want: undefined, keepsRaw: true },
    // a stale saved selection (an alias on a menu that no longer offers it): the only thing left to judge
    // the number by is the selector's own spelling, and „opus[1m]" is not the „claude-opus-5[1m]" it was
    // filed under. So it is DROPPED rather than inherited — same rule as everywhere else in this file, and
    // the CLI is asked again seconds after the resume.
    { name: 'menu loaded but it knows no such entry → judged by the raw spelling, and that does not match',
      cache: { models: [] }, modelSel: 'opus[1m]', saved: SAVED, want: null, keepsRaw: false },
    { name: '„Default" on a menu that has no Default entry → no key at all, so nothing is decided',
      cache: { models: [] }, modelSel: '', saved: SAVED, want: undefined, keepsRaw: true },
    { name: 'a window measured for the OTHER variant is dropped, not inherited',
      cache: { models: MENU }, modelSel: 'opus[1m]', saved: { variante: 'claude-opus-5', fenster: 200000 },
      want: null, keepsRaw: false },
    { name: 'a legacy bare number names no variant and dies here',
      cache: { models: MENU }, modelSel: 'opus[1m]', saved: 1000000, want: null, keepsRaw: false },
  ];
  ADOPT_ROWS.forEach((r) => {
    it(r.name, () => {
      const tab = { modelSel: r.modelSel, _ctxWindowSaved: r.saved };
      adoptWith(r.cache)(tab);
      assert.deepEqual(tab.ctxReported, r.want);
      assert.equal(tab._ctxWindowSaved != null, r.keepsRaw, 'whether the raw value survives for a later attempt');
    });
  });

  it('both call sites really go through it — restoreTabs defers, loadModels retries', () => {
    // A wiring assertion, not a behavioural one: restoreTabs and loadModels are too entangled with the DOM
    // and localStorage to lift, and the defect was precisely in WHERE the decision is taken. If the eager
    // computation ever comes back, these two go red instead of the window silently disappearing on reload.
    const src = (name) => {
      const m = CHAT_SRC.match(new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
      assert.ok(m, name + '() not found in public/js/chat.js');
      return m[0];
    };
    assert.match(src('restoreTabs'), /_ctxWindowSaved\s*=\s*info\.ctxWindow/, 'the saved value is kept RAW at boot');
    assert.doesNotMatch(src('restoreTabs'), /ctxWindowLoad\(/, '…and not decided there, where no menu is loaded yet');
    assert.match(src('loadModels'), /ctxAdoptSavedWindow/, 'and the menu answering is what triggers the decision');
    assert.match(src('persistTabs'), /ctxWindowSave\(t\.ctxReported\)\s*\|\|\s*t\._ctxWindowSaved/,
      'a persist while the value is still undecided must not be what deletes it');
  });

  it('the boot order itself: undecided before loadModels, adopted right after', () => {
    // exactly the sequence that used to lose the window on every reload
    const tab = { modelSel: 'opus[1m]', _ctxWindowSaved: SAVED };
    adoptWith(null)(tab);                                   // restoreTabs, boot
    assert.equal(tab.ctxReported, undefined, 'nothing decided while the menu is unknown');
    adoptWith({ models: MENU })(tab);                       // loadModels answered
    assert.deepEqual(tab.ctxReported, { win: 1000000, key: 'claude-opus-5[1m]' });
    assert.equal(tab._ctxWindowSaved, null, 'and it is not adopted twice');
  });
});

// =====================================================================================================
//  C5 — the alias migration has THREE holders, not two. On a Bedrock menu a first-party alias ("opus[1m]")
//  is no longer one of the entries; populateModelSelect moved the dropdown and the saved default over, but
//  every restored TAB kept the alias in its own `modelSel` — and that string is what the whole context
//  decision judges the tab by (ctxEnv → ctxResolveModel). The consequence is not cosmetic: the alias
//  resolves to nothing on that menu, so the tab's variant becomes UNKNOWN (the gauge drops to „–" and
//  nothing may be filed any more, see row g) and the window the tab measured for itself is discarded on the
//  next reload, because ctxWindowLoad compares the variant key.
//  One row per (what the tab holds × what the menu offers).
// =====================================================================================================
describe('chat.js — a Bedrock menu migrates the TABS too, not just the dropdown (C5)', () => {
  const MENU = [
    { value: '', label: 'Default', resolves: 'eu.anthropic.claude-opus-5[1m]' },
    { value: 'eu.anthropic.claude-opus-5[1m]', label: 'Opus 5 (1M)', resolves: 'eu.anthropic.claude-opus-5' },
    { value: 'eu.anthropic.claude-opus-5', label: 'Opus 5', resolves: 'eu.anthropic.claude-opus-5' },
    { value: 'eu.anthropic.claude-sonnet-5', label: 'Sonnet 5', resolves: 'eu.anthropic.claude-sonnet-5' },
  ];
  const migrateWith = (tabs) => loadChatFn('migrateTabAliasSelections', {
    TABS: tabs,
    bedrockEntryForAlias: loadChatFn('bedrockEntryForAlias', {}),
    persistTabsSoon: () => { tabs._persisted = (tabs._persisted || 0) + 1; },
  });

  const MIGRATE_ROWS = [
    { name: 'the wide alias moves to the concrete wide entry', sel: 'opus[1m]', want: 'eu.anthropic.claude-opus-5[1m]' },
    { name: 'a plain alias moves to the plain entry of the same family', sel: 'sonnet', want: 'eu.anthropic.claude-sonnet-5' },
    // B5 — the row that can actually OBSERVE the wide-flag guard in bedrockEntryForAlias. „haiku[1m]" below
    // cannot: this menu has no haiku entry at all, so the guard is never reached and the alias is kept for that
    // reason. „opus" can: the menu holds BOTH opus rows and the „(1M)" one comes FIRST (buildBedrockMenu sorts
    // the wide variant before the plain one), so without the guard a plain 200 K selection would be migrated
    // onto the 1M row — and the context decision reads the selector's „[1m]" as this session's variant, i.e.
    // a 200 K session measured against 1 000 000 with nothing to contradict it until the context passes 200 000.
    { name: 'a plain alias never lands on the „(1M)" row of the same family — which this menu lists first',
      sel: 'opus', want: 'eu.anthropic.claude-opus-5' },
    { name: 'a wide alias never lands on the plain entry', sel: 'haiku[1m]', want: 'haiku[1m]' },
    { name: 'a value the menu already has is left alone', sel: 'eu.anthropic.claude-opus-5', want: 'eu.anthropic.claude-opus-5' },
    { name: '„Default" is not an alias and must not be rewritten', sel: '', want: '' },
    { name: 'a tab that never touched the dropdown has nothing to migrate', sel: undefined, want: undefined },
    { name: 'an alias with no counterpart at all keeps it — the CLI is still the one that resolves it',
      sel: 'mythos', want: 'mythos' },
  ];
  MIGRATE_ROWS.forEach((r) => {
    it(r.name, () => {
      const tabs = [{ uid: 1, modelSel: r.sel }];
      migrateWith(tabs)(MENU);
      assert.equal(tabs[0].modelSel, r.want);
    });
  });

  it('every tab is migrated, not just the visible one — and a real move is persisted once', () => {
    const tabs = [{ uid: 1, modelSel: 'opus[1m]' }, { uid: 2, modelSel: 'sonnet' }, { uid: 3, modelSel: 'eu.anthropic.claude-opus-5' }];
    assert.equal(migrateWith(tabs)(MENU), 2, 'two of the three held a stale alias');
    assert.deepEqual(tabs.map((t) => t.modelSel),
      ['eu.anthropic.claude-opus-5[1m]', 'eu.anthropic.claude-sonnet-5', 'eu.anthropic.claude-opus-5']);
    assert.equal(tabs._persisted, 1, 'one persist for the whole rebuild, not one per tab');
    assert.equal(migrateWith(tabs)(MENU), 0, 'and a second rebuild changes nothing');
  });

  it('…and the migrated tab is then judged by a value the menu can resolve — which is the whole point', () => {
    // before: the alias names a FAMILY, so the tab's model and its selector do not name the same model and
    // the variant is unknown → no window may be read, none may be written, and the saved one is dropped.
    const saved = ctxWindowSave({ win: 1000000, key: 'claude-opus-5[1m]' });
    const before = ctxResolveModel({ reported: 'claude-opus-5', sel: 'opus[1m]', resolves: '' });
    assert.equal(before.varUnknown, true);
    assert.equal(ctxWindowLoad(saved, before.key), null, 'the window measured by this very tab is lost');
    const tabs = [{ uid: 1, modelSel: 'opus[1m]' }];
    migrateWith(tabs)(MENU);
    const after = ctxResolveModel({ reported: 'claude-opus-5', sel: tabs[0].modelSel, resolves: 'eu.anthropic.claude-opus-5' });
    assert.deepEqual(after, { id: 'claude-opus-5', key: 'claude-opus-5[1m]', wide: true, varUnknown: false, src: 'frame' });
    assert.deepEqual(ctxWindowLoad(saved, after.key), { win: 1000000, key: 'claude-opus-5[1m]' }, '…and is back afterwards');
  });

  it('populateModelSelect really calls it, and only on a Bedrock menu', () => {
    // A wiring assertion like the restore one above: populateModelSelect is pure DOM and cannot be lifted, and
    // the defect was precisely that this call was missing. It must sit inside the `bed && bed.enabled` branch —
    // on a first-party menu the alias IS a legitimate entry and rewriting it would be the opposite bug.
    const m = CHAT_SRC.match(/^function populateModelSelect\([\s\S]*?^\}/m);
    assert.ok(m, 'populateModelSelect() not found in public/js/chat.js');
    const branch = m[0].match(/if \(bed && bed\.enabled\) \{[\s\S]*?\n  \}/);
    assert.ok(branch, 'the Bedrock migration branch is gone');
    assert.match(branch[0], /migrateTabAliasSelections\(list\)/, 'the tabs are migrated with the same list');
    assert.match(branch[0], /CHAT_DEFAULTS\.model = mig/, '…together with the saved default');
  });
});

// =====================================================================================================
//  The PROBE itself (public/js/commands.js ctxProbe) — the wiring that decides whether the CLI is asked at
//  all. The two pure seams above (ctxAskDecision, ctxProbeUnsupported) only say what SHOULD happen; the
//  defect was in this function, which charged a refusal to the two-attempt budget and never re-armed it at
//  an ordinary turn boundary — so the self-correction never arrived however wrong the line was. Lifted by
//  name against fake globals, like the chat.js functions above.
// =====================================================================================================
const CMD_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'commands.js'), 'utf8');
function loadCmdFn(name, env) {
  const m = CMD_SRC.match(new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
  assert.ok(m, name + '() not found in public/js/commands.js — renamed or reindented?');
  const names = Object.keys(env);
  return new Function(...names, m[0] + '\nreturn ' + name + ';')(...names.map((k) => env[k]));
}

describe('commands.js — the probe asks again exactly when it is worth it', () => {
  const TIMEOUT = { ok: true, unconfirmed: true };                                     // the CLI was slow
  const REFUSED = { ok: true, unconfirmed: true, reason: 'Unsupported control request subtype' }; // …or has no such control
  // a probe wired to a scripted sequence of route answers; `calls.asked` counts the real requests.
  // `ctxRemember` is the REAL one (the shared applier both callers use), with only the store writes faked — so
  // what the probe does with `rec.learn` and `rec.refuted` is this file's code, not a copy of it.
  function probeWith(answers, resolves) {
    const calls = { asked: 0, learned: [], refutations: [], floored: [], healed: [] };
    const ctxRemember = loadCmdFn('ctxRemember', {
      ctxLearn: (e, w) => { calls.learned.push(...(e || [])); if (w) calls.refutations.push(w); },
      ctxFloorLearn: (r) => { if (r) calls.floored.push(r); },
      ctxFloorHeal: (h) => { if (h) calls.healed.push(h); },
      ctxReportedRefuted, ctxSavedRefuted, persistTabsSoon: () => {},
    });
    const fn = loadCmdFn('ctxProbe', {
      ACTIVE: null,
      api: async () => { calls.asked++; return answers[Math.min(calls.asked - 1, answers.length - 1)]; },
      ctxEnv: (tb) => ({ known: {}, sel: tb.modelSel || '', resolves: resolves == null ? tb.modelSel || '' : resolves, label: '' }),
      ctxRemember,
      updateCtxGauge: () => {},
      ctxAskDecision, ctxWindowInDoubt, ctxDecide, ctxAskedAt, ctxAnswerUsable, ctxFromRoute, ctxProbeUnsupported,
    });
    return { fn, calls };
  }
  // a tab whose window is DERIVED but consistent (the name table knows opus-5) and one that has no window at
  // all (nobody knows opus-9). Since B2 both are „in doubt": only a measurement settles a window.
  const settled = () => ({ id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5' });
  const doubtful = () => ({ id: 'c1', model: 'claude-opus-9', modelSel: 'claude-opus-9' });
  // …and the only state that really is settled: the CLI has answered about THIS session.
  const measuredTab = () => ({ id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxStamp: 0, _ctxGen: 0,
    ctxMeasured: measured({ tokens: 18529, win: 200000, raw: 200000, pct: 9, hasPct: true, stamp: 0, gen: 0 }) });

  it('a refusal is remembered, not charged to the budget — and ends the asking for this process', async () => {
    const { fn, calls } = probeWith([REFUSED]);
    const tb = settled();
    await fn(tb, 'result');
    assert.equal(calls.asked, 1);
    assert.equal(tb._ctxNoSupport, true, 'the CLI said it does not have this control');
    assert.equal(tb._ctxMisses || 0, 0, 'that is not a silence, so it costs no attempt');
    await fn(tb, 'result'); await fn(tb, 'model'); await fn(tb, 'compact');
    assert.equal(calls.asked, 1, 'nothing asks again — not even a state change');
    // …and the line says so, instead of promising a measurement
    assert.equal(ctxDecide(tb, { known: {}, resolves: 'claude-opus-5' }).pendingWhy, 'unsupported');
  });

  it('…and a (re)start forgets it: that is a new process, possibly a new binary', async () => {
    const { fn, calls } = probeWith([REFUSED, ROUTE_ANSWER]);
    const tb = settled();
    await fn(tb, 'result');
    assert.equal(calls.asked, 1);
    await fn(tb, 'start');
    assert.equal(calls.asked, 2, 'asked once more after the restart');
    assert.equal(tb._ctxNoSupport, false);
    assert.equal(tb.ctxMeasured && tb.ctxMeasured.win, 200000, 'and this time it answered');
  });

  it('a TIMEOUT is a silence: two of them spend the budget, and a MEASURED window leaves it spent', async () => {
    const { fn, calls } = probeWith([TIMEOUT]);
    const tb = measuredTab();
    await fn(tb, 'result');
    assert.equal(tb._ctxMisses, 1);
    await fn(tb, 'result');
    assert.equal(tb._ctxMisses, 2);
    assert.equal(calls.asked, 2);
    await fn(tb, 'result');
    assert.equal(calls.asked, 2, 'twice silent over a window the CLI itself measured → stop asking');
    assert.equal(tb._ctxNoSupport, undefined, 'and that is NOT „cannot measure"');
  });

  it('…while a DERIVED window re-arms the spent budget at every boundary until one measurement lands (B2)', async () => {
    // The price of B2, as a row: the refutation can only catch a window that is too small, so a derived number
    // stays in doubt however consistent it looks and the probe keeps asking — ONCE per turn boundary, never
    // mid-turn, never two at a time. And it stops by itself: the first real answer makes the window „measured",
    // after which the ordinary two-silence budget governs again. That second half is what keeps this from
    // becoming polling, so it is asserted in the same test.
    const { fn, calls } = probeWith([TIMEOUT, TIMEOUT, TIMEOUT, ROUTE_ANSWER, TIMEOUT]);
    const tb = settled();                                  // the name table's window (1M since 06.10.): consistent, unmeasured
    await fn(tb, 'result'); await fn(tb, 'result'); await fn(tb, 'result');
    assert.equal(calls.asked, 3, 'three boundaries, three asks — a spent budget is re-armed while nothing was measured');
    assert.equal(tb._ctxMisses, 1, 'the counter never reaches the cap: each boundary resets it before asking');
    await fn(tb, 'result');                                // …and this one answers
    assert.equal(tb.ctxMeasured.win, 200000);
    await fn(tb, 'result'); await fn(tb, 'result');         // two silences over a measured window
    const spent = calls.asked;
    await fn(tb, 'result');
    assert.equal(calls.asked, spent, 'from there the two-silence budget holds again — the expensive state ends itself');
  });

  it('…but while the window is in DOUBT every turn boundary tries again — that is the self-correction', async () => {
    const { fn, calls } = probeWith([TIMEOUT]);
    const tb = doubtful();
    await fn(tb, 'result'); await fn(tb, 'result'); await fn(tb, 'result'); await fn(tb, 'result');
    assert.equal(calls.asked, 4, 'the spent budget is re-armed as long as the line has no honest window');
    // the counter never reaches the cap: each boundary resets it before asking, so the ONE silence standing
    // at any moment is the one from the attempt just made
    assert.equal(tb._ctxMisses, 1);
    assert.ok(tb._ctxMisses < CTX_MAX_MISSES, 'never spent, so the next boundary asks again too');
  });

  it('a refuted window is in doubt too — the over-window line asks the one source that can settle it', async () => {
    // exactly row d's tab: a derived 200 000 that a 500 800-token call disproved
    const { fn, calls } = probeWith([TIMEOUT], 'claude-opus-5');
    const tb = { id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxTokens: 500800, ctxStamp: 2, _ctxMisses: 2 };
    await fn(tb, 'result');
    assert.equal(calls.asked, 1, 'the budget was spent, and the refutation re-armed it');
  });

  it('an answer settles it: the measurement is stored, the budget is reset, the window is learned', async () => {
    const { fn, calls } = probeWith([ROUTE_ANSWER]);
    const tb = settled(); tb._ctxMisses = 1;
    await fn(tb, 'result');
    assert.equal(calls.asked, 1);
    assert.equal(tb.ctxMeasured.win, 200000);
    assert.equal(tb.ctxMeasured.hasTok, true);
    assert.equal(tb._ctxMisses, 0);
    assert.deepEqual(calls.learned, [{ key: 'claude-opus-5', win: 200000 }]);
    assert.deepEqual(tb.ctxReported, { win: 200000, key: 'claude-opus-5' });
  });

  it('an unstarted or exited tab is never asked', async () => {
    const { fn, calls } = probeWith([ROUTE_ANSWER]);
    await fn({ model: 'claude-opus-5' }, 'start');
    await fn({ id: 'c1', _exited: true, model: 'claude-opus-5' }, 'start');
    assert.equal(calls.asked, 0);
  });
});

// =====================================================================================================
//  ROUND 4 — THE FLOOR. A refutation is a FACT about this session, not a deletion.
//  The previous round DELETED a refuted window from the three holders it could reach (the learned store,
//  `tab.ctxReported`, the not-yet-adopted `_ctxWindowSaved`), and its rows were green — because their fixture
//  model („claude-opus-7") is in no table, so the holder a deletion CANNOT reach never spoke in them. Three
//  holders cannot be emptied at all: CTX_NAME_WINDOWS is a module constant, the CLI re-reports
//  `contextWindow` in every single result, and a second tab has its own copy. So the fact is recorded once —
//  „one accepted call of this variant carried N tokens" — and becomes a floor every source has to pass.
//  The rows below use a model that really IS in CTX_NAME_WINDOWS at 200 000, and they run the whole cycle
//  through the real code of both callers: refute → the floor is raised and the stores cleaned → the context
//  shrinks → the constant, the CLI and a second tab offer the same 200 000 again → still refused, and the
//  line says why instead of printing it. That model was „claude-opus-5" until the 06.10. measurement; under
//  CLI 2.1.291 opus-5 is 1 000 000, a constant that clears every bound below it, so the rows use
//  „claude-haiku-4-5" since — the table's only row below 1M (and the CLI really answers 200 000 for it).
// =====================================================================================================
const EVENTS_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat-events.js'), 'utf8');
function loadEventsFn(name, env) {
  const m = EVENTS_SRC.match(new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
  assert.ok(m, name + '() not found in public/js/chat-events.js — renamed or reindented?');
  const names = Object.keys(env);
  return new Function(...names, m[0] + '\nreturn ' + name + ';')(...names.map((k) => env[k]));
}

describe('ctx — a refutation becomes a FLOOR every source must pass (B1 · F1 · F2)', () => {
  const KEY = 'claude-haiku-4-5';                   // …and this one the name constant really knows: 200 000
  // the real writers: commands.js owns both shared stores, so its three functions are lifted with only
  // localStorage faked — the merge, the delete, the monotonic floor and the „did anything change" test are the
  // panel's own code. The fake KEEPS the written JSON, because „survives a reload" can only be shown by
  // reading back what was really persisted.
  function wire(seed) {
    const store = seed || { [KEY]: 200000 };          // learned on an EARLIER turn, by an earlier session
    const floors = {};
    const calls = { written: 0, floorWrites: 0, persisted: 0, json: {} };
    // (the fresh re-read before a write — several panel windows — is its own test below; here one page owns both)
    const fresh = (which) => (which === 'floors' ? floors : store);
    const ctxLearn = loadCmdFn('ctxLearn', {
      ctxStoreFresh: fresh, ctxStoreMerge, CTX_WINDOWS_KEY: 'cc_ctx_windows',
      localStorage: { setItem: (k, v) => { calls.written++; calls.json[k] = v; } },
    });
    const ctxFloorLearn = loadCmdFn('ctxFloorLearn', {
      ctxStoreFresh: fresh, ctxFloorMerge, CTX_FLOORS_KEY: 'cc_ctx_floors',
      localStorage: { setItem: (k, v) => { calls.floorWrites++; calls.json[k] = v; } },
    });
    // …and the one that takes a bound back (05.10.), with the 🔔 log captured instead of painted
    calls.log = [];
    const ctxFloorHeal = loadCmdFn('ctxFloorHeal', {
      ctxStoreFresh: fresh, ctxFloorDrop, CTX_FLOORS_KEY: 'cc_ctx_floors',
      localStorage: { setItem: (k, v) => { calls.floorWrites++; calls.json[k] = v; } },
      logEvent: (m, k) => calls.log.push([m, k]), t: (k) => k + ' {k} {n} {w}', fmtNum: (n) => String(n),
    });
    const ctxRemember = loadCmdFn('ctxRemember', {
      ctxLearn, ctxFloorLearn, ctxFloorHeal, ctxReportedRefuted, ctxSavedRefuted, persistTabsSoon: () => { calls.persisted++; },
    });
    return { store, floors, calls, ctxRemember };
  }
  const refutedTab = (key) => ({
    id: 'c1', model: key || KEY, modelSel: key || KEY, ctxTokens: 500800, ctxStamp: 2,
    // what this tab's own earlier turn adopted and chat.js persisted (ctxWindowSave → {variante, fenster})
    ctxReported: { win: 200000, key: key || KEY },
  });
  const envOf = (w, key) => ({
    known: w.store, floors: w.floors, sel: key || KEY, resolves: key || KEY, label: 'Haiku 4.5',
  });

  const CALLERS = [
    {
      name: 'the result handler (chat-events.js ctxNoteResult)',
      // the turn ends: no modelUsage window for this model, so the window on the line is the one the tab
      // itself adopted earlier — and the frames of this turn refute it
      run: async (w, tab, key, usage) => loadEventsFn('ctxNoteResult', {
        ctxEnv: (tb, extra) => Object.assign(envOf(w, key), extra),
        ctxDecide, ctxRemember: w.ctxRemember,
      })(tab, usage || {}, null),
    },
    {
      name: 'the probe (commands.js ctxProbe)',
      // the CLI answers 200 000 at this turn boundary and a single call of this very session carried 500 800:
      // the measurement is the younger evidence' loser, and the number must not stay in the stores either
      run: async (w, tab, key) => loadCmdFn('ctxProbe', {
        ACTIVE: null,
        api: async () => ({ maxTokens: 200000, rawMaxTokens: 200000 }),
        ctxEnv: (tb, extra) => Object.assign(envOf(w, key), extra),
        ctxRemember: w.ctxRemember,
        updateCtxGauge: () => {},
        ctxAskDecision, ctxWindowInDoubt, ctxDecide, ctxAskedAt, ctxAnswerUsable, ctxFromRoute, ctxProbeUnsupported,
      })(tab, 'result'),
    },
  ];

  // CHANGED 05.10. — this loop ran BOTH callers through the same cycle. The probe's version had the CLI answer
  // 200 000 while a call of the same session carried 500 800, and required a FLOOR from it: a bound above the
  // CLI's own measurement. Since then a measurement outranks every floor (ctx.js „THE FLOOR", point 5), so the
  // probe no longer FILES bounds — it REFUTES them; its two rows follow the loop. The result handler is the caller
  // whose frames refute a DERIVED window, and it runs the whole cycle as before.
  [CALLERS[0]].forEach((c) => {
    it('through ' + c.name + ': refute → floor raised + stores cleaned → a compaction → the CONSTANT is refused too', async () => {
      const w = wire();
      const tab = refutedTab();
      // 1. the frames refute the window, and the record states the FACT, with the count that proves it
      const before = ctxDecide(tab, envOf(w));
      assert.equal(before.conflict, 'over-window');
      assert.deepEqual(before.refuted, { key: KEY, below: 500800, src: 'frame' });
      // 2. the caller applies it: the FLOOR first (the guarantee), then the cleanup of what is already filed
      await c.run(w, tab);
      assert.deepEqual(bounds(w.floors), { [KEY]: 500800 }, 'the proven bound is recorded');
      assert.ok(w.calls.floorWrites > 0, '…and persisted, because it has to survive a reload');
      assert.equal(Object.prototype.hasOwnProperty.call(w.store, KEY), false,
        'the learned entry is deleted as well — hygiene, no longer the guarantee');
      assert.ok(w.calls.written > 0, 'and the corrected store is persisted');
      assert.equal(tab.ctxReported, null, 'the tab\'s own persisted window is gone too');
      assert.ok(w.calls.persisted > 0, '…and that is persisted as well');
      // 3. the context SHRINKS — an auto-compaction, which states no post-compaction size anywhere, and then
      //    the next frame carries the new one. At 120 000 tokens nothing contradicts 200 000 any more.
      ctxForgetContext(tab);
      ctxNoteFrame(tab, 120000);
      // 4. …and now the holder no deletion can reach speaks: CTX_NAME_WINDOWS knows claude-haiku-4-5 = 200 000
      //    (claude-opus-5 until 06.10. — it is 1 000 000 since CLI 2.1.291, see the header of this round).
      //    BOTH stores are empty in this call, so nothing stale is involved — this is the constant alone.
      const after = ctxDecide(tab, { known: {}, floors: w.floors, sel: KEY, resolves: KEY, label: 'Haiku 4.5' });
      assert.equal(after.win.src, 'unknown');
      assert.equal(after.win.value, 0);
      assert.equal(after.conflict, 'below-floor', 'refused and MARKED — not silently missing');
      assert.equal(after.floor, 500800, '…and the evidence travels to the tooltip with it');
      assert.notEqual(painted(after), 'Kontext ≈ 60% · 120.000 / 200.000');
      assert.equal(painted(after), '⚠ Kontext · 120.000 / –', 'the count over „–", not over a disproved window');
      assert.deepEqual(titled(after).slice(2),
        ['commands.kontextFensterUnterBoden', 'commands.kontextZeigtTokens'],
        'and the tooltip names the floor, not „unknown while no model is named" over a model the frames named');
      assert.equal(ctxWindowInDoubt(after), true, 'so the probe keeps asking the only source that can replace it');
    });
  });

  it('through the probe (commands.js ctxProbe): the CLI\'s own 200 000 beaten by a call drops off the line, but files NOTHING', async () => {
    // The probe's half of the old loop, with what it does now. The answer is the CLI's statement about THIS
    // session; a call that carried more drops it from the line (row d2) — and that is all. No bound (it would sit
    // above a measurement, which refutes it), and no deletion: the learned 200 000 and the tab's own 200 000 are
    // what the CLI just said, so the panel has nothing to correct them WITH.
    const w = wire();
    const tab = refutedTab();
    await CALLERS[1].run(w, tab);
    assert.equal(tab.ctxMeasured && tab.ctxMeasured.win, 200000, 'the answer was stored');
    const rec = ctxDecide(tab, envOf(w));
    assert.equal(rec.conflict, 'over-window', 'dropped from the line — the call is younger evidence');
    assert.equal(rec.refuted, null);
    assert.deepEqual(bounds(w.floors), {}, 'no bound above the CLI\'s own measurement');
    assert.equal(w.calls.floorWrites, 0);
    assert.equal(w.store[KEY], 200000, 'the learned entry agrees with the CLI and stays');
    assert.deepEqual(tab.ctxReported, { win: 200000, key: KEY }, '…and so does the tab\'s own');
  });

  it('…and a probe answer YOUNGER than a proven bound refutes it: removed, persisted, said once in the 🔔 log', async () => {
    // Rule 3 of 05.10.: the CLI's maxTokens for the running model in this generation stands over a floor. The bound
    // here was proven before the probe asked (`at` 1 — another tab's frames, say); the answer comes later and says
    // 200 000 for this very session. The bound is refuted and goes — for EVERY source of the variant, which is why
    // it is removed from the shared store and not merely ignored on this line.
    const w = wire({});
    w.floors[KEY] = FL(500800, 1);
    const tab = { id: 'c1', model: KEY, modelSel: KEY, ctxTokens: 120000, ctxStamp: 2 };
    assert.equal(ctxDecide(tab, envOf(w)).conflict, 'below-floor', 'before: the name constant is refused by it');
    await CALLERS[1].run(w, tab);
    assert.deepEqual(bounds(w.floors), {}, 'the refuted bound is gone');
    assert.deepEqual(JSON.parse(w.calls.json.cc_ctx_floors), {}, '…and that is what was persisted');
    assert.equal(w.calls.log.length, 1, 'said once in the 🔔 log');
    assert.match(w.calls.log[0][0], /^commands\.kontextBodenWiderlegt claude-haiku-4-5 500800 200000$/, '…naming key, bound and the measured window');
    const rec = ctxDecide(tab, envOf(w));
    assert.equal(rec.win.src, 'measured');
    assert.equal(rec.conflict, '');
    assert.deepEqual(tab.ctxReported, { win: 200000, key: KEY }, 'and the measured window is adopted now');
    // a second application of the same decision writes nothing and says nothing (the entry is already gone)
    const writes = w.calls.floorWrites;
    w.ctxRemember(tab, ctxDecide(tab, Object.assign(envOf(w), { floors: { [KEY]: FL(500800, 1) } })));
    assert.equal(w.calls.floorWrites, writes);
    assert.equal(w.calls.log.length, 1);
    // …and a second tab of that variant, without a measurement of its own, is no longer refused: it reads the
    // window this answer just taught the shared store
    const tabB = { id: 'c2', model: KEY, modelSel: KEY, ctxTokens: 120000, ctxStamp: 1 };
    const recB = ctxDecide(tabB, envOf(w));
    assert.deepEqual([recB.win.src, recB.win.value, recB.conflict], ['learned', 200000, '']);
    // the mirror: an answer OLDER than the bound does not erase it (a tab's old measurement vs. a newer proof)
    const w3 = wire({});
    w3.floors[KEY] = FL(500800, Date.now() + 60000);
    await CALLERS[1].run(w3, { id: 'c3', model: KEY, modelSel: KEY, ctxTokens: 120000, ctxStamp: 2 });
    assert.deepEqual(bounds(w3.floors), { [KEY]: 500800 }, 'younger evidence is not erased by older evidence');
  });

  it('…and the CLI re-reporting the same contextWindow in the NEXT result does not undo it', async () => {
    // The second hole the deletion left: `result.modelUsage` carries `contextWindow` every single turn, so the
    // emptied entry was refilled one turn later and „corrected" lasted exactly one turn. Run through the REAL
    // result handler, with the floor already in force and the context compacted so that nothing contradicts
    // 200 000 by arithmetic any more.
    const w = wire();
    const tab = refutedTab();
    await CALLERS[0].run(w, tab);
    ctxForgetContext(tab);
    ctxNoteFrame(tab, 120000);
    const usage = { [KEY]: { inputTokens: 10, cacheReadInputTokens: 119990, contextWindow: 200000 } };
    const rec = await CALLERS[0].run(w, tab, null, usage);
    assert.equal(rec.win.src, 'unknown', 'the freshly reported 200 000 is refused like any other source');
    assert.equal(rec.conflict, 'below-floor');
    assert.deepEqual(rec.learn, [], 'and it is not filed again — the hygiene half would be a treadmill otherwise');
    assert.equal(rec.adopt, null);
    assert.equal(Object.prototype.hasOwnProperty.call(w.store, KEY), false, 'so the store stays clean');
    assert.equal(tab.ctxReported, null);
    assert.deepEqual(bounds(w.floors), { [KEY]: 500800 }, 'and the bound is unchanged — one fact, filed once');
  });

  it('…and it survives a RELOAD: the persisted floor, parsed back, refuses the restored window and the constant', async () => {
    const w = wire();
    await CALLERS[0].run(w, refutedTab());
    // what really went into localStorage, read back the way ctxFloorStore() reads it after a restart
    const reloaded = JSON.parse(w.calls.json['cc_ctx_floors']);
    assert.deepEqual(bounds(reloaded), { [KEY]: 500800 });
    assert.equal(reloaded[KEY].src, 'frame', '…persisted WITH its provenance (05.10.)');
    assert.ok(reloaded[KEY].at > 0, '…and the clock of the proof, so a later measurement can refute it');
    // a tab coming back from persistTabs: chat.js restores {variante, fenster} through ctxWindowLoad, and that
    // function knows nothing about floors — the gate is in the decision, which is where every source meets it
    const restored = ctxWindowLoad({ variante: KEY, fenster: 200000 }, KEY);
    assert.deepEqual(restored, { win: 200000, key: KEY }, 'the restore itself still hands the number over');
    const tab = { id: 'c9', model: KEY, modelSel: KEY, ctxTokens: 120000, ctxStamp: 1, ctxReported: restored };
    const rec = ctxDecide(tab, { known: {}, floors: reloaded, sel: KEY, resolves: KEY, label: 'Haiku 4.5' });
    assert.equal(rec.win.value, 0, 'neither the restored window nor the name constant gets through');
    assert.equal(rec.conflict, 'below-floor');
    assert.equal(painted(rec), '⚠ Kontext · 120.000 / –');
  });

  it('…and a SECOND tab on the same variant is covered — which is why the floor is in the shared store', async () => {
    // The holder a per-tab bound cannot reach: tab B never ran the refuting turn and never learned anything, it
    // simply adopted 200 000 from its own earlier result. A floor kept on tab A would leave exactly this tab
    // printing „≈ 60 % · 120.000 / 200.000"; the shared one refuses both of tab B's sources (its own window and
    // the constant). The price of sharing is stated in ctx.js („THE RESIDUAL CASE").
    const w = wire();
    const tabA = refutedTab();
    await CALLERS[0].run(w, tabA);
    const tabB = {
      id: 'c2', model: KEY, modelSel: KEY, ctxTokens: 120000, ctxStamp: 3,
      ctxReported: { win: 200000, key: KEY },
    };
    const rec = ctxDecide(tabB, { known: {}, floors: w.floors, sel: KEY, resolves: KEY, label: 'Haiku 4.5' });
    assert.equal(rec.win.value, 0);
    assert.equal(rec.conflict, 'below-floor');
    assert.equal(rec.floor, 500800);
    assert.equal(painted(rec), '⚠ Kontext · 120.000 / –');
  });

  it('…and the floor only GROWS: the compaction that follows the refutation cannot talk it back down', async () => {
    // A bound that followed the context down would un-prove itself one turn later, which is the hole the
    // deletion left in the first place. A LATER, bigger disproof does raise it (the window is at least that big).
    // Stays on „claude-opus-5" on purpose (06.10.): the constant plays no part in how a bound grows, and the second
    // half needs a model whose wide sibling is a real key — no menu offers one for haiku-4-5.
    const K5 = 'claude-opus-5';
    const w = wire({ [K5]: 200000 });
    const tab = refutedTab(K5);
    await CALLERS[0].run(w, tab, K5);
    ctxForgetContext(tab); ctxNoteFrame(tab, 120000);
    await CALLERS[0].run(w, tab, K5);
    assert.deepEqual(bounds(w.floors), { 'claude-opus-5': 500800 }, 'a smaller context proves nothing new');
    // …and the wide variant, on which a 900 000-token call was accepted, is a key of its own
    assert.equal(ctxFloorMerge(w.floors, { key: 'claude-opus-5[1m]', below: 900000, src: 'frame' }), 1);
    assert.equal(ctxFloorMerge(w.floors, { key: 'claude-opus-5', below: 700000, src: 'frame' }), 1, 'a bigger disproof raises it');
    assert.equal(ctxFloorMerge(w.floors, { key: 'claude-opus-5', below: 300000, src: 'frame' }), 0, '…a smaller one does not');
    assert.deepEqual(bounds(w.floors), { 'claude-opus-5': 700000, 'claude-opus-5[1m]': 900000 });
  });

  // --- the hygiene half, on „claude-opus-7": a model NOTHING knows, so the stores are provably the only
  //     sources and a deletion can be observed on its own ------------------------------------------------
  const K7 = 'claude-opus-7';
  it('a refutation takes only what the evidence refutes — the other variant and the side-calls stay', async () => {
    const w = wire({ 'claude-opus-7': 200000, 'claude-opus-7[1m]': 1000000, 'claude-haiku-4-5': 200000 });
    const tab = refutedTab(K7);
    await CALLERS[0].run(w, tab, K7);
    assert.deepEqual(w.store, { 'claude-opus-7[1m]': 1000000, 'claude-haiku-4-5': 200000 },
      'the wide variant (1M is not refuted by 500 800) and the side-call survive');
    assert.deepEqual(bounds(w.floors), { 'claude-opus-7': 500800 }, 'and the bound is filed for one variant only');
  });

  it('…and the tab keeps a stored window the evidence does NOT touch', async () => {
    // The mirror, and the reason the refutation carries the count rather than being a flag: the refuted half is
    // the learned 200 000 on the line, while the number this tab has saved for itself is 1 000 000 — which a
    // 500 800-token call does not contradict at all. An unconditional delete would correct something nobody
    // measured, in the direction that loses a window that is probably right.
    // CHANGED 05.10. — the refuted half used to be a MEASURED 200 000 (with the 1 000 000 in `ctxReported`). A
    // frame that beats a measurement files nothing durable any more (row d2), so that setup would delete nothing
    // at all and prove nothing; the same property is now shown on a DERIVED refuted half, with the 1 000 000 in
    // the third holder (a restored window the menu has not adopted yet), which the line does not read.
    const w = wire({ 'claude-opus-7': 200000 });
    const tab = refutedTab(K7);
    tab.ctxReported = null;
    tab._ctxWindowSaved = { variante: K7, fenster: 1000000 };
    const rec = ctxDecide(tab, envOf(w, K7));
    assert.equal(rec.win.src, 'unknown');
    assert.equal(rec.conflict, 'over-window');
    assert.deepEqual(rec.refuted, { key: K7, below: 500800, src: 'frame' });
    await CALLERS[0].run(w, tab, K7);
    assert.equal(Object.prototype.hasOwnProperty.call(w.store, K7), false, 'the refuted 200 000 goes');
    assert.deepEqual(tab._ctxWindowSaved, { variante: K7, fenster: 1000000 }, '…and the 1 000 000 stays');
    // …and the floor leaves it alone as well: 1 000 000 is above the bound, so it is still readable afterwards
    const later = Object.assign(refutedTab(K7), { ctxTokens: 120000, ctxReported: { win: 1000000, key: K7 } });
    const after = ctxDecide(later, envOf(w, K7));
    assert.equal(after.win.value, 1000000);
    assert.equal(after.conflict, '');
    // …and the MEASURED case of old: a frame that beats the CLI's own 200 000 deletes nothing and files nothing —
    // the learned 200 000 agrees with the CLI, and a bound above a measurement would be refuted by its next read
    const w2 = wire({ 'claude-opus-7': 200000 });
    const tabM = Object.assign(refutedTab(K7), {
      ctxReported: { win: 1000000, key: K7 },
      ctxMeasured: measured({ tokens: 0, hasTok: false, win: 200000, raw: 200000, stamp: 2, gen: 0 }),
    });
    const recM = ctxDecide(tabM, envOf(w2, K7));
    assert.equal(recM.conflict, 'over-window', 'still dropped from the line (row d2)');
    assert.equal(recM.refuted, null);
    await CALLERS[0].run(w2, tabM, K7);
    assert.deepEqual(w2.store, { 'claude-opus-7': 200000 });
    assert.deepEqual(bounds(w2.floors), {});
    assert.deepEqual(tabM.ctxReported, { win: 1000000, key: K7 });
  });

  it('…and the THIRD holder goes too: a saved window the model menu has not adopted yet', async () => {
    // The one that would undo the whole correction a second after it happened: at boot the saved value is kept
    // RAW (`_ctxWindowSaved`) because `modelResolves()` answers '' until loadModels has run, and it is handed to
    // `ctxReported` only when the menu arrives. A refutation that cleans just the two live stores is therefore
    // reverted by loadModels — so this row runs the real ctxAdoptSavedWindow AFTERWARDS and requires that
    // nothing comes back. (The floor refuses the number on read too; both halves are cheap, and a holder that
    // quietly keeps a disproved value is how the last rounds went.)
    const w = wire({});
    const tab = refutedTab(K7);
    tab.ctxReported = null;                              // nothing adopted yet
    tab._ctxWindowSaved = { variante: K7, fenster: 200000 };
    const rec = ctxDecide(tab, envOf(w, K7));
    assert.equal(rec.win.value, 0, 'the saved value is not even readable yet — only the refutation matters here');
    // the refutation comes from the same tab one line later, once the window is on the line again
    const refuting = ctxDecide(Object.assign(refutedTab(K7), { ctxReported: { win: 200000, key: K7 } }), envOf(w, K7));
    assert.deepEqual(refuting.refuted, { key: K7, below: 500800, src: 'frame' });
    w.ctxRemember(tab, refuting);
    assert.equal(tab._ctxWindowSaved, null, 'the undecided saved window is withdrawn as well');
    // and now the menu answers, which is where it used to come back
    const adopt = loadChatFn('ctxAdoptSavedWindow', {
      MODELS_CACHE: { models: [{ value: K7, label: 'Opus 7', resolves: K7 }] },
      modelResolves: () => K7, ctxResolveModel, ctxWindowLoad,
    });
    adopt(tab);
    assert.equal(tab.ctxReported, null, 'nothing is handed back — the refuted 200 000 is gone for good');
  });

  it('both call sites really go through the one applier, and the decision really gets the floors', () => {
    // A wiring assertion like the restore ones above. The defect B1 was about was that each caller had its OWN
    // two lines, so „corrected" could mean two different things; the defect THIS round is about is subtler — if
    // ctxEnv forgot to hand the floors over, every gate in ctxDecide would read `undefined`, the pure table above
    // would stay green and the whole round would be inert in the browser. So that line is pinned too.
    assert.match(EVENTS_SRC, /ctxNoteResult\(chat, ev\.modelUsage, chat\._ctxModelUsage\)/,
      'the result handler delegates instead of touching the stores itself');
    assert.match(CMD_SRC, /function ctxRemember\(tab, rec\)[\s\S]*?ctxFloorLearn\(rec\.refuted\)/,
      'the applier raises the FLOOR — the half that also holds for the constant and for the next result');
    assert.match(CMD_SRC, /function ctxRemember\(tab, rec\)[\s\S]*?ctxLearn\(rec\.learn, rec\.refuted\)/,
      '…and passes the refutation to the store it can clean');
    assert.match(CMD_SRC, /function ctxRemember\(tab, rec\)[\s\S]*?ctxReportedRefuted\(tab\.ctxReported, rec\.refuted\)/,
      '…and nulls the tab\'s own window by the same rule');
    assert.match(CMD_SRC, /function ctxEnv\(tab, extra\)[\s\S]*?floors: ctxFloorStore\(\)/,
      'and ctxEnv hands the proven bounds to the decision — without this every floor gate reads undefined');
    assert.match(CMD_SRC, /ctxRemember\(tb, ctxDecide\(tb, ctxEnv\(tb\)\)\)/, 'the probe goes through it too');
    assert.doesNotMatch(EVENTS_SRC, /ctxLearn\(|ctxFloorLearn\(/, 'and no caller writes a store behind its back');
    // …and the one token count that is a SUM really is handed over marked (row fl10 only states what the
    // decision does with the mark — if the call site stopped setting it, a bound could be filed from an
    // over-count and the row would stay green)
    assert.match(EVENTS_SRC, /ctxNoteFrame\(chat, ctxTokensOfFrame\(ev\.usage\), true\)/,
      'the last-resort result usage is marked as a sum');
    assert.match(EVENTS_SRC, /ctxNoteFrame\(chat, ctxTokensOfFrame\(u\)\);/,
      '…while a real assistant frame is one call and is not marked');
  });

  it('j1 in the panel\'s own number format: Julian\'s line reads „/ 1,0M", not „/ –" (05.10.)', () => {
    // the painter the gauge really uses (views-usage.js fmtNum over render.js fmtDec/fmtInt), lifted from source
    // with LANG = 'de' — so the string asserted here is the one on Julian's screen, magnitude letters and all
    const RENDER_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'render.js'), 'utf8');
    const USAGE_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views-usage.js'), 'utf8');
    const grab = (src, name) => src.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}', 'm'))[0];
    const fmtNum = new Function('LANG', [grab(RENDER_SRC, 'numLocale'), RENDER_SRC.match(/^function fmtInt\(.*$/m)[0],
      grab(RENDER_SRC, 'fmtDec'), grab(USAGE_SRC, 'fmtNum'), 'return fmtNum;'].join('\n'))('de');
    const row = ROWS.find((r) => /^j1\)/.test(r.name));
    const rec = ctxDecide(row.tab, row.env);
    assert.equal(ctxGaugeLine(rec, { kontext: 'Kontext ', pending: '' }, fmtNum), 'Kontext ≈ 63% · 627,9K / 1,0M');
  });

  it('an ESTIMATE files no floor: get_context_usage with totalTokens > maxTokens leaves cc_ctx_floors empty (05.10.)', async () => {
    // How Julian's 1 089 676 got into the store. `totalTokens` is the CLI's estimate for the NEXT request — right
    // before an auto-compaction (or a prompt-too-long) it may sit above the window — and the old (8) counted a
    // MEASURED token count as „one accepted call" (`oneCall = tokens.src === 'measured' || …`). Run through the
    // real probe and the real applier with only localStorage faked, so the assertion is about what is persisted.
    const floors = {};
    const json = {};
    const ctxFloorLearn = loadCmdFn('ctxFloorLearn', {
      ctxStoreFresh: () => floors, ctxFloorMerge, CTX_FLOORS_KEY: 'cc_ctx_floors',
      localStorage: { setItem: (k, v) => { json[k] = v; } }, Date,
    });
    const ctxRemember = loadCmdFn('ctxRemember', {
      ctxLearn: () => {}, ctxFloorLearn, ctxFloorHeal: () => {}, ctxReportedRefuted, ctxSavedRefuted, persistTabsSoon: () => {},
    });
    const KEY5 = 'eu.anthropic.claude-opus-5-5[1m]';
    const probe = loadCmdFn('ctxProbe', {
      ACTIVE: null,
      api: async () => ({ totalTokens: 1089676, maxTokens: 1000000, rawMaxTokens: 1000000, percentage: 109, autocompactSource: 'model-default' }),
      ctxEnv: () => ({ known: {}, floors, sel: KEY5, resolves: 'eu.anthropic.claude-opus-5-5', label: 'Opus 5.5 (1M)' }),
      ctxRemember, updateCtxGauge: () => {},
      ctxAskDecision, ctxWindowInDoubt, ctxDecide, ctxAskedAt, ctxAnswerUsable, ctxFromRoute, ctxProbeUnsupported,
    });
    const tab = { id: 'c1', model: 'claude-opus-5-5', modelSel: KEY5, ctxTokens: 600000, ctxStamp: 4 };
    await probe(tab, 'result');
    assert.ok(tab.ctxMeasured, 'the answer was stored as this tab\'s measurement');
    assert.deepEqual(floors, {}, 'no bound filed from an estimate');
    assert.equal(json.cc_ctx_floors, undefined, '…and nothing persisted');
  });

  it('…and the RENDERER really puts the evidence on screen — number, verbatim word and label (F1 · F3)', () => {
    // ctxTitleLines is a pure seam and the table asserts its KEYS; ctxGaugeTitle in commands.js is the step that
    // turns those keys into the string the user hovers. That step was unpinned, and a mutation run proved it:
    // deleting the one line that appends `l.text` broke nothing, i.e. F3's „use `autocompactSource`" held only
    // as far as the record and could have been silently undone in the renderer. The same gap covers the FLOOR's
    // own evidence — „refused" without the proven bound beside it is exactly the flag this round replaced.
    // So all three payload kinds of a tooltip line are asserted here, against the real function.
    const render = loadCmdFn('ctxGaugeTitle', {
      ctxTitleLines,
      t: (k) => (k === 'commands.kontextLabelWiderspruch' ? 'LABEL „{m}" VERSPRICHT 1M' : k),
      fmtNum: (n) => '<' + n + '>',
    });
    // { key, text } — the CLI's own word for WHY that is the 100 % line, appended untranslated
    const lit = render(ctxDecide({
      id: 'c1', model: 'claude-opus-5', modelSel: 'claude-opus-5', ctxStamp: 3,
      ctxMeasured: measured({ tokens: 18529, win: 200000, raw: 200000, pct: 9, hasPct: true, source: 'model-default', stamp: 3 }),
    }, { known: {}, resolves: 'claude-opus-5', label: 'Opus 5' }), 'Opus 5');
    // (the stub returns the bare key where the real dictionary ends in „: ", so the two sit flush here)
    assert.match(lit, /commands\.kontextGrenzeLautClimodel-default/,
      'the CLI\'s autocompactSource reaches the hovered string, verbatim');
    // The next two need the NAME TABLE to offer 200 000 — a source the floor refuses, a window below the label's
    // promise — so they run on claude-haiku-4-5 since 06.10. (were opus-5, which the table lists at 1 000 000 under
    // CLI 2.1.291). „Haiku 4.5 (1M)" is a label no menu shows; what is under test is that „{m}" gets filled.
    // { key, num, warn } — the floor's evidence: the proven bound, formatted, behind the ⚠
    const floored = render(ctxDecide({
      id: 'c1', model: 'claude-haiku-4-5', modelSel: 'claude-haiku-4-5', ctxTokens: 120000, ctxStamp: 3,
    }, { known: {}, floors: { 'claude-haiku-4-5': FL(500800) }, resolves: 'claude-haiku-4-5', label: 'Haiku 4.5' }), 'Haiku 4.5');
    assert.match(floored, /⚠ commands\.kontextFensterUnterBoden<500800>/,
      'a refused source names the count that refuted it — not just „refused"');
    // { key, label, warn } — „{m}" filled by the caller, which only the renderer can do
    const labelled = render(ctxDecide({
      id: 'c1', model: 'claude-haiku-4-5', modelSel: 'claude-haiku-4-5', ctxTokens: 1000, ctxStamp: 3,
    }, { known: {}, resolves: 'claude-haiku-4-5', label: 'Haiku 4.5 (1M)' }), 'Haiku 4.5 (1M)');
    assert.match(labelled, /⚠ LABEL „Haiku 4\.5 \(1M\)" VERSPRICHT 1M/, 'the menu label is substituted, not printed as „{m}"');
  });
});
