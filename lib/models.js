'use strict';
// Model menu for the chat dropdown + pricing. Pure data/logic — requires nothing (DAG leaf), so
// lib/core.js and server.js can both require it without a cycle.
//
// The dropdown mirrors the console's `/model` list, assembled at request time from the CLI's own
// on-disk state in ~/.claude.json (so it stays in sync with the account, "read at startup"):
//   - a stable BASE template (Default / Opus 1M / Sonnet / Haiku) — the console's base entries live
//     only inside claude.exe, so we reproduce their labels here and gate each on entitlement;
//   - the account-specific EXTRAS the CLI caches in `additionalModelOptionsCache`
//     (shape {value,label,description} — e.g. Fable), taken 1:1;
//   - filtered by `modelAccessCache` ([{apiName,entitled}]) and tier-sorted to match the console
//     order (Default, Opus, Fable, Sonnet, Haiku).
// If those (undocumented) cache keys are missing (e.g. a future CLI renames them), we fall back to
// the unfiltered base template so the dropdown is never empty. Aliases (opus/sonnet/haiku) resolve
// to the newest model at spawn time, so the list never goes stale.
//
// Version numbers are DERIVED, never written down: the base entries carry an alias as their value, so
// the only honest source for "which model is this actually" is the entitlement cache — the newest
// entitled member of the family. That is reported as `resolves` (the concrete id, for the tooltip) and
// condensed into the label ("Opus 5"). Without an access cache there is nothing to derive and the
// labels stay versionless, exactly as before.

// The model families the CLI knows. The family name doubles as the CLI's own ALIAS for "newest
// entitled member of this family" (`--model fable`, `set_model "fable"`), which is why it is worth
// naming them in one place.
const FAMILIES = ['opus', 'fable', 'mythos', 'sonnet', 'haiku'];
function famOf(s) { s = String(s || '').toLowerCase(); return FAMILIES.find((f) => s.includes(f)) || ''; }

// capability tier → console ordering (Default is always first)
function tierOf(s) {
  s = String(s || '');
  if (/opus/i.test(s)) return 1;
  if (/fable|mythos/i.test(s)) return 2;
  if (/sonnet/i.test(s)) return 3;
  if (/haiku/i.test(s)) return 4;
  return 5;
}

// "claude-opus-5" → [5] · "claude-haiku-4-5-20251001" → [4,5] · "claude-opus-4-1-20250805-claude-ai" → [4,1]
// The numeric run after the family name IS the version; an 8-digit date or any word after it ends it.
function versionOf(apiName) {
  const v = [];
  for (const part of String(apiName || '').split('-')) {
    if (/^\d{8}$/.test(part)) break;            // release date, not a version segment
    if (/^\d+$/.test(part)) v.push(Number(part));
    else if (v.length) break;                   // "-claude-ai" and friends
  }
  return v;
}
function cmpVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}
const verLabel = (v) => v.join('.');
// The concrete model an alias will most likely spawn as: newest entitled member of the family.
function newestEntitled(access, fam) {
  const re = new RegExp(fam, 'i');
  const hit = (access || [])
    .filter((m) => m && m.entitled && re.test(m.apiName || ''))
    .sort((a, b) => cmpVersion(versionOf(b.apiName), versionOf(a.apiName)))[0];
  return hit ? hit.apiName : '';
}

// base entries split into name/suffix so the derived version can slot in between ("Opus 5 (1M)")
const BASE = [
  // "(1M context)" spelled out made this the widest option and therefore the width of the whole select
  { fam: 'opus', value: 'opus[1m]', name: 'Opus', suffix: ' (1M)', tier: 1 },
  { fam: 'sonnet', value: 'sonnet', name: 'Sonnet', suffix: '', tier: 3 },
  { fam: 'haiku', value: 'haiku', name: 'Haiku', suffix: '', tier: 4 },
];

// What the "Default" entry really starts, as a concrete id — the same question buildBedrockMenu answers
// from `settingsModel`, and the same source: the CLI falls back to settings.json `model` when no --model is
// passed. `resolves` was hardcoded '' here, and that empty string is the root of the reported context line:
// a Default tab has the empty string as its selector value, so NOTHING in it could say that the session
// really runs the 1M variant — the gauge fell through to the model-name window (200 000) and painted
// „Kontext 250 % · 500,8K / 200,0K" over a 1M session, with no race and no stale state involved.
// An ALIAS in that setting ("opus[1m]") is resolved through the same entitlement cache the base entries use;
// the "[1m]" suffix is KEPT, because it is the variant and the variant is what changes the window. With no
// access cache the family alias is all we have — it then names a family rather than a model, which the
// consumer reads as "variant unknown" and paints "–" rather than inventing a window (public/js/ctx.js
// ctxResolveModel/varUnknown). Empty stays empty: a machine with no `model` in settings.json lets the CLI
// pick, and only the CLI can say what it picked.
function resolveDefaultModel(settingsModel, access) {
  const raw = String(settingsModel || '').trim();
  if (!raw) return '';
  const wide = /\[1m\]$/i.test(raw);
  const bare = raw.replace(/\[1m\]$/i, '');
  const fam = FAMILIES.includes(bare.toLowerCase()) ? bare.toLowerCase() : '';
  const id = (fam && access ? newestEntitled(access, fam) : '') || bare;
  return id ? id + (wide ? '[1m]' : '') : '';
}

// cj = the parsed ~/.claude.json object (or {} when unreadable)
// settingsModel = settings.json `model`, i.e. what "Default" really starts (see resolveDefaultModel)
function buildModelMenu(cj, settingsModel) {
  cj = cj || {};
  const access = Array.isArray(cj.modelAccessCache) ? cj.modelAccessCache : null;

  // Default = let the CLI pick — but say WHICH model that is, as far as this machine's own state knows
  const out = [{ value: '', label: 'Default', desc: '', resolves: resolveDefaultModel(settingsModel, access), tier: 0 }];
  BASE.forEach((b) => {
    // no access info (fallback) → keep the family, unversioned; otherwise gate on an entitled member
    const concrete = access ? newestEntitled(access, b.fam) : '';
    if (access && !concrete) return;
    const ver = verLabel(versionOf(concrete));
    out.push({
      value: b.value, label: b.name + (ver ? ' ' + ver : '') + b.suffix,
      desc: '', resolves: concrete, tier: b.tier,
    });
  });

  // Account-specific extras from the CLI's own cache (e.g. Fable). These used to be taken 1:1, which
  // was wrong in both directions — measured against the live CLI on 2026-09-02:
  //   • `additionalModelOptionsCache` ADVERTISES a version the account may not have. Here it offered
  //     `claude-fable-5-1[1m]` while `modelAccessCache` said `claude-fable-5-1` entitled=false (and
  //     `claude-fable-5` entitled=true). Selecting it made the CLI answer the set_model with
  //     `error: Model "claude-fable-5-1[1m]" is restricted by your organization's settings. Using
  //     claude-opus-5[1m] instead.` — so the session kept running Opus while the dropdown said Fable.
  //   • The cached CONCRETE id is therefore the wrong thing to send. The family alias is what the CLI
  //     resolves to the newest entitled member: `set_model "fable[1m]"` → success, and the next
  //     assistant frame reported `claude-fable-5`. Same reasoning as the BASE entries above.
  // So: gate on entitlement like BASE, send the alias, and let the entitlement cache name the version.
  const extras = Array.isArray(cj.additionalModelOptionsCache) ? cj.additionalModelOptionsCache : [];
  extras.forEach((e) => {
    if (!e || !e.value) return;
    const raw = String(e.value);
    const wide = /\[1m\]/i.test(raw);
    const fam = famOf(raw + ' ' + (e.label || ''));
    // No access cache (fallback) or an unfamiliar family → keep the entry verbatim, as before: we
    // cannot judge it, and hiding a legitimately new model would be worse than offering it.
    if (!access || !fam) {
      const concrete = raw.replace(/\[1m\]/i, '');
      const ver0 = verLabel(versionOf(concrete));
      let label0 = e.label || raw;
      if (ver0 && !/\d/.test(label0)) label0 += ' ' + ver0;
      out.push({ value: raw, label: label0, desc: e.description || '', resolves: concrete, tier: tierOf(raw + ' ' + (e.label || '')) });
      return;
    }
    const concrete = newestEntitled(access, fam);
    if (!concrete) return; // the whole family is forbidden → do not offer what cannot be selected
    const ver = verLabel(versionOf(concrete));
    // The label must name the version we can ACTUALLY get, not the one the cache advertises: a label
    // reading "Fable 5.1" for a session that runs Fable 5 is the same lie one layer up. A label that
    // already carries a version is rewritten, because that version came from the same stale cache.
    let label = String(e.label || raw).replace(/\s+\d+(?:\.\d+)*\s*$/, '');
    if (ver) label += ' ' + ver;
    out.push({
      value: fam + (wide ? '[1m]' : ''), label, desc: e.description || '',
      resolves: concrete, tier: tierOf(raw + ' ' + (e.label || '')),
    });
  });

  out.sort((a, b) => a.tier - b.tier);
  // `blocked`/`reason` keep the entry shape identical to the Bedrock menu below, so the dropdown has
  // one renderer instead of two. On first-party auth nothing is ever blocked: an un-entitled model is
  // not offered at all, because there the entitlement cache is authoritative and complete.
  return out.map(({ value, label, desc, resolves }) => ({ value, label, desc, resolves, blocked: false, reason: '' }));
}

// ---- Amazon Bedrock -----------------------------------------------------------------------------
// On Bedrock everything the menu above is built from is GONE: the CLI writes no `modelAccessCache`
// and no `additionalModelOptionsCache` into ~/.claude.json, because entitlement there is not an
// account flag but an AWS IAM policy. buildModelMenu's documented fallback ("no access info → offer
// the base template unfiltered") then becomes permanent, and the dropdown quietly offers whatever
// the CLI knows — including models the role may not invoke. Measured on this machine 2026-09-24:
// `haiku`, `claude-opus-5-5` and every `global.*` profile answer 403 AccessDeniedException.
//
// So on Bedrock the menu is built from a MEASUREMENT instead (lib/bedrock.js probes each candidate
// for `bedrock:InvokeModelWithResponseStream`), and it offers the CONCRETE inference-profile id, not
// a family alias. That is the whole lesson of the incident this replaced: picking the alias "fable"
// made the CLI resolve it to `global.anthropic.claude-fable-5-1`, persist THAT into settings.json,
// and every later run — including the ones that looked like plain "Default" — died with a 403 naming
// a model nobody had knowingly chosen.
//
// The bare model ids the CLI ships for Bedrock (extracted from claude.exe, which is the only place
// they exist; the version-suffix spelling differs per model and cannot be derived, e.g. opus-5 has
// none while opus-4-6 needs `-v1` and opus-4-5 needs `-20251101-v1:0`). The region prefix is added by
// lib/bedrock.js. Unknown-to-Bedrock entries are harmless: a probe answers "invalid model
// identifier" and they are dropped.
// `wide` is MEASURED, never guessed (see the 1M row below). Evidence for the two that carry it, taken
// on 2026-10-02 by asking the running CLI (`get_context_usage`, a free control request): `opus-5[1m]`
// and `opus-5-5[1m]` both report maxTokens 1.000.000, while the same models without the suffix report
// 200.000 (that was CLI 2.1.286; from 2.1.288/2.1.291 on the bare spellings answer 1.000.000 as well, see
// CTX_NAME_WINDOWS in public/js/ctx.js — the suffix then labels the row more than it changes the window) — so the CLI distinguishes them, and its number is the OPERATIVE one, because the CLI decides
// from it when to auto-compact. Two cheaper checks were tried and do NOT belong in this decision: the
// role's authorisation probe (both models `allowed`) says nothing about the window, and sending
// `anthropic_beta: ["context-1m-2025-08-07"]` to Bedrock is accepted for EVERY model, Haiku 4.5
// included — Bedrock validates the beta id against its list, not against the model. Proving the window
// at the API level would need a 200K+ token request; not worth its price for a menu row.
const BEDROCK_CANDIDATES = [
  { id: 'claude-opus-5', fam: 'opus', label: 'Opus 5', wide: true },
  { id: 'claude-opus-5-5', fam: 'opus', label: 'Opus 5.5', wide: true },
  { id: 'claude-opus-4-8', fam: 'opus', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', fam: 'opus', label: 'Opus 4.7' },
  { id: 'claude-opus-4-6-v1', fam: 'opus', label: 'Opus 4.6' },
  { id: 'claude-opus-4-5-20251101-v1:0', fam: 'opus', label: 'Opus 4.5' },
  { id: 'claude-fable-5-1', fam: 'fable', label: 'Fable 5.1' },
  { id: 'claude-fable-5', fam: 'fable', label: 'Fable 5' },
  { id: 'claude-mythos-5', fam: 'mythos', label: 'Mythos 5' },
  // Sonnet 5.5 was MISSING here while Bedrock already served it — found 2026-10-02 by listing the
  // region's inference profiles (`eu.anthropic.claude-sonnet-5-5`, ACTIVE). That is the standing weakness
  // of this table: a model nobody adds by hand stays invisible, however long it has been published. No
  // `wide` flag, because its window has not been measured; `sonnet-5` reports 1M WITHOUT any suffix, so
  // for this family the suffix is probably the wrong mechanism anyway. See docs/ideas.md (A22) for
  // deriving the whole table from ListInferenceProfiles + ListFoundationModels instead.
  { id: 'claude-sonnet-5-5', fam: 'sonnet', label: 'Sonnet 5.5' },
  { id: 'claude-sonnet-5', fam: 'sonnet', label: 'Sonnet 5' },
  { id: 'claude-sonnet-4-6', fam: 'sonnet', label: 'Sonnet 4.6' },
  { id: 'claude-sonnet-4-5-20250929-v1:0', fam: 'sonnet', label: 'Sonnet 4.5' },
  { id: 'claude-haiku-4-5-20251001-v1:0', fam: 'haiku', label: 'Haiku 4.5' },
];
// A Bedrock id back to the bare model name the PRICING table and the labels are keyed by:
// "eu.anthropic.claude-opus-4-6-v1" → "claude-opus-4-6".
// The region prefix is OPTIONAL. Transcripts contain the bare id "anthropic.claude-haiku-4-5-20251001-v1:0"
// (15 lines / 233,488 tokens on the live corpus), and the CLI's own `cost-state` frames key modelUsage by
// full Bedrock ids too. While a region was REQUIRED those ids reduced to "anthropic.claude-haiku-4-5" —
// a key PRICING cannot know — so their tokens were counted as unpriced, which is exactly what the promise
// above normalizeModel (lib/core.js) says must not happen.
// A second, independent sighting of the same bare form (control run 2026-10-02): the CLI wrote it for all
// four workflow agents, 8 usage records, so the Usage view would have reported their entire spend as 0 €.
// `priced: false` was doing its job and flagging it — nothing was silently wrong — but the id it could not
// price is one the CLI writes routinely, which is why the prefix has to be optional and not merely tidy.
function bedrockBase(id) {
  return String(id || '')
    .replace(/\[1m\]$/i, '')
    .replace(/^([a-z]{2,6}(-[a-z]+)?\.)?(anthropic|bedrock)\./i, '')
    .replace(/-v\d+(:\d+)?$/i, '')
    .replace(/-\d{8}$/, '');
}
const bedrockLabelFor = (id) => {
  const base = bedrockBase(id);
  const hit = BEDROCK_CANDIDATES.find((c) => bedrockBase(c.id) === base);
  if (hit) return hit.label;
  const fam = famOf(base);
  const ver = verLabel(versionOf(base));
  return fam ? (fam[0].toUpperCase() + fam.slice(1) + (ver ? ' ' + ver : '')) : base;
};

// access = what lib/bedrock.js measured: { region, checkedAt, error, models: [{ id, base, verdict }] }
// verdict: 'allowed' (authorized) · 'denied' (403 by IAM) · 'absent' (no such model here) · 'unknown'
// settingsModel = settings.json `model`, i.e. what the CLI falls back to when no --model is passed —
// so it is what the "Default" entry really means, and it has to be shown and judged, not assumed safe.
function buildBedrockMenu(access, settingsModel) {
  const models = (access && Array.isArray(access.models)) ? access.models : [];
  const verdictOf = (id) => {
    const b = bedrockBase(id);
    const hit = models.find((m) => bedrockBase(m.id) === b);
    return hit ? hit.verdict : '';
  };
  const def = String(settingsModel || '');
  const defVerdict = def ? verdictOf(def) : '';
  const out = [{
    value: '', label: 'Default', desc: '', resolves: def,
    // A Default that resolves to a model the role cannot invoke is not a default, it is a trap: every
    // new chat starts on it and fails on the first turn with an AWS error, not a panel error.
    blocked: !!def && (defVerdict === 'denied' || defVerdict === 'absent'),
    reason: (!def || defVerdict === 'allowed') ? '' : defVerdict || 'unknown',
  }];
  const tierFam = { opus: 1, fable: 2, mythos: 2, sonnet: 3, haiku: 4 };
  const rows = [];
  for (const m of models) {
    if (m.verdict !== 'allowed' && m.verdict !== 'denied') continue; // 'absent' does not exist here, 'unknown' is not a claim
    const base = bedrockBase(m.id);
    const cand = BEDROCK_CANDIDATES.find((c) => bedrockBase(c.id) === base);
    const fam = (cand && cand.fam) || famOf(base);
    const tier = tierFam[fam] || 5;
    const ver = versionOf(base);
    if (cand && cand.wide && m.verdict === 'allowed') {
      // The 1M-context beta is requested with the CLI's `[1m]` suffix — on a concrete id too (that is
      // the shape the CLI itself advertises in additionalModelOptionsCache). Offered only where the
      // candidate table says the model has it, never guessed.
      rows.push({ value: m.id + '[1m]', label: bedrockLabelFor(m.id) + ' (1M)', desc: '', resolves: m.id, blocked: false, reason: '', tier, ver, sub: 0 });
    }
    rows.push({
      value: m.id, label: bedrockLabelFor(m.id), desc: '', resolves: m.id,
      blocked: m.verdict === 'denied', reason: m.verdict === 'denied' ? 'denied' : '', tier, ver, sub: 1,
    });
  }
  // newest first inside a family (the CLI's own ordering is tier, then version), blocked ones last so
  // the list still opens on something usable
  rows.sort((a, b) => (a.tier - b.tier) || (Number(a.blocked) - Number(b.blocked))
    || cmpVersion(b.ver, a.ver) || (a.sub - b.sub));
  rows.forEach((r) => out.push({ value: r.value, label: r.label, desc: r.desc, resolves: r.resolves, blocked: r.blocked, reason: r.reason }));
  return out;
}

// USD per 1M tokens (in/out). Keyed by the normalized concrete id (see normalizeModel in core.js —
// strips the [1m] suffix and any -YYYYMMDD date). Aliases have no entry: cost is computed from the
// concrete model the CLI reports back in the result usage, never from the alias the user picked.
const PRICING = {
  'claude-opus-5': { in: 5, out: 25 },
  // Opus 5.5 was in BEDROCK_CANDIDATES (and is the DOMINANT subagent model — 60 % of all agent tokens)
  // but had no rate, so 396.8 M tokens of the live corpus were priced at $0.00 = $379.11 invisible, with
  // no warning anywhere (the Usage view never rendered its own unpriced footnote either). Rates taken
  // from the Opus family, which is what the CLI's own `cost-state` frames bill it at.
  'claude-opus-5-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-opus-4-5': { in: 5, out: 25 },
  // MEASURED against the CLI itself, not assumed: the `cost-state` frames the CLI writes into every
  // transcript bill Sonnet 5 at $2/$10, and the ratio panel÷CLI was EXACTLY 1.5000 on all 145
  // single-model cost-state files (reproduced to the cent: $3.9223 panel vs $2.6148 CLI). The $3/$15
  // here was the published standing price with the note "intro pricing $2/$10 ran through 2026-08-31" —
  // but the CLI never switched, so every Sonnet 5 cost this panel has ever shown was 50 % too high.
  'claude-sonnet-5': { in: 2, out: 10 },
  // Sonnet 5.5 — needed because this PR puts it into BEDROCK_CANDIDATES (Bedrock serves it; found by
  // listing the region's inference profiles), and the guard below refuses any candidate that reduces onto no
  // rate: a model sitting in the dropdown while costing $0.00 is the entire reason that guard exists.
  // Rate from the published first-party table ($2/$10 per MTok) — the same pair as Sonnet 5, which this
  // panel has MEASURED against the CLI's own `cost-state` frames. NOT measured for 5.5 itself: no turn on
  // this machine has used it yet. When one does, re-check it the way Sonnet 5 was re-checked (panel ÷ CLI
  // must come out 1.0000, not 1.5000).
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-fable-5': { in: 10, out: 50 },
  // 5.1 is what the dropdown actually offers (additionalModelOptionsCache). normalizeModel only strips
  // "[1m]" and a date suffix, not the "-1", so without its own key every Fable turn scored as unpriced
  // and its cost silently dropped out of the totals. Price assumed equal to Fable 5 — the CLI's
  // `additionalModelCostsCache` is empty, so there is no authoritative local source to copy.
  'claude-fable-5-1': { in: 10, out: 50 },
  'claude-mythos-5': { in: 10, out: 50 },
};

// ---- managed `modelPricing` (CLI 2.1.271) ------------------------------------------------------
// An organisation can change what a token COSTS for everyone on the machine, through the managed
// setting `modelPricing: { multiplier, overrides }` — the CLI validates it as "a number greater than
// 0 and at most 10" and "an object mapping model ID to rates". The panel keeps its own list-price
// table, so on such a machine every cost it prints (turn footer, status chip, usage view, cost per
// radar) would be wrong by that factor — silently, and everywhere at once. Cost is a load-bearing
// number in this UI, so the table follows the setting.
//
// `overrides` win over the list price; the multiplier then applies to what is left standing. An
// override row that is not two non-negative numbers is DROPPED rather than guessed at — the same
// thing the CLI does with it ("Invalid pricing row was ignored").
let PRICING_OVERLAY = null;   // null = list prices, i.e. nothing managed
function normalizeRate(r) {
  if (!r || typeof r !== 'object') return null;
  const inp = Number(r.in != null ? r.in : r.input);
  const out = Number(r.out != null ? r.out : r.output);
  if (!Number.isFinite(inp) || !Number.isFinite(out) || inp < 0 || out < 0) return null;
  return { in: inp, out };
}
function applyManagedPricing(modelPricing) {
  const cfg = (modelPricing && typeof modelPricing === 'object') ? modelPricing : null;
  if (!cfg) { PRICING_OVERLAY = null; return null; }
  const mult = Number(cfg.multiplier);
  const factor = (Number.isFinite(mult) && mult > 0 && mult <= 10) ? mult : 1;
  const table = {};
  for (const [id, rate] of Object.entries(PRICING)) table[id] = { in: rate.in, out: rate.out };
  const ov = (cfg.overrides && typeof cfg.overrides === 'object') ? cfg.overrides : {};
  let rows = 0;
  for (const [id, raw] of Object.entries(ov)) { const r = normalizeRate(raw); if (r) { table[id] = r; rows++; } }
  if (factor !== 1) for (const id of Object.keys(table)) table[id] = { in: table[id].in * factor, out: table[id].out * factor };
  // Nothing usable in the setting → stay on the list prices instead of installing an identical copy,
  // which would make pricingIsManaged() claim a managed table where there is none.
  PRICING_OVERLAY = (factor !== 1 || rows > 0) ? table : null;
  return PRICING_OVERLAY;
}
function effectivePricing() { return PRICING_OVERLAY || PRICING; }
function pricingFor(normalizedId) { return effectivePricing()[normalizedId]; }
function pricingIsManaged() { return !!PRICING_OVERLAY; }

// ---- does a model support ultracode? ----
//
// Ultracode (standing dynamic-workflow orchestration) needs TWO things: dynamic workflows enabled for
// the account, and a model that supports the `xhigh` effort level. The second half is what this answers.
//
// The good source is the CLI itself: the `initialize` control_response carries a `models` array —
// { value, resolvedModel, displayName, supportsEffort, supportedEffortLevels } — and lib/skills.js
// getSessionInfo already performs exactly that handshake (no model call, no cost). MEASURED on 2.1.285
// with Bedrock: Sonnet 5 / Opus 5.5 report supportedEffortLevels ["low","medium","high","xhigh","max"],
// Haiku 4.5 reports NO effort fields at all. So "xhigh is in the list" IS the predicate.
//
// The denylist below is only the fallback for when that probe is unavailable (older CLI, failed spawn).
// It mirrors the check inside claude.exe 2.1.285, read from the binary.
const MODELS_WITHOUT_XHIGH = [
  'claude-opus-4-0', 'claude-opus-4-1', 'claude-opus-4-5', 'claude-opus-4-6',
  'claude-sonnet-4-0', 'claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-haiku-4-5',
];
// One entry of the CLI's `models` list for the id the panel is asking about. The dropdown's values are
// concrete Bedrock ids ("eu.anthropic.claude-sonnet-5", optionally "[1m]") while the CLI's list is keyed
// by ALIAS ("sonnet") and names the concrete model in `resolvedModel` — so the join has to go through
// bedrockBase(), which strips the provider prefix, the [1m] suffix, the -vN and the date.
function cliModelEntry(cliModels, modelValue) {
  const list = Array.isArray(cliModels) ? cliModels : [];
  const want = String(modelValue == null ? '' : modelValue).trim();
  // '' = the panel's "Default" entry, which is the CLI's "default" alias
  const alias = want || 'default';
  const byValue = list.find((m) => m && String(m.value || '') === alias);
  if (byValue) return byValue;
  if (!want) return null;
  const base = bedrockBase(want);
  return list.find((m) => m && m.resolvedModel && bedrockBase(m.resolvedModel) === base) || null;
}
// → the effort levels the CLI says THIS model offers, or [] when it says nothing about it (no probe, an
// unknown model, a CLI that stopped populating the field). [] means „do not filter", because the picker has
// to fail OPEN: an empty effort dropdown is a dead end, an over-wide one is corrected by the session itself
// a second after the start.
//
// It goes through cliModelEntry for the same reason ultracodeModelSupport does, and that is not cosmetic:
// the panel's dropdown holds CONCRETE ids ("eu.anthropic.claude-sonnet-5[1m]") while the CLI's list is keyed
// by ALIAS and names the concrete model in `resolvedModel`. A plain `find(m => m.value === model)` therefore
// matches nothing for almost every value the dropdown actually produces — which is exactly what
// /api/ultracode/support did, so its `effortLevels` came back EMPTY for every Bedrock id and the per-model
// filter could never fire. The existing route test only asserted `Array.isArray(...)`, so it never noticed.
function modelEffortLevels(cliModels, modelValue) {
  const hit = cliModelEntry(Array.isArray(cliModels) ? cliModels : [], modelValue);
  return (hit && Array.isArray(hit.supportedEffortLevels)) ? hit.supportedEffortLevels.slice() : [];
}
// → { supported, source } — `source` so the UI can say whether this is the CLI's own statement
// ('cli'), the mirrored denylist ('table') or a model nobody has an opinion about ('unknown').
//
// An unknown model is treated as SUPPORTED on purpose: a false negative hides the switch outright,
// while a false positive is corrected within a second by get_settings once the session runs (which is
// the only authoritative answer and the one the chip actually displays).
function ultracodeModelSupport(cliModels, modelValue) {
  const list = Array.isArray(cliModels) ? cliModels : [];
  const hit = cliModelEntry(list, modelValue);
  if (hit && Array.isArray(hit.supportedEffortLevels)) {
    return { supported: hit.supportedEffortLevels.includes('xhigh'), source: 'cli' };
  }
  if (hit && hit.supportsEffort === false) return { supported: false, source: 'cli' };
  // A found entry with NO effort fields at all is how the CLI describes Haiku 4.5 (measured) — but only
  // if the field is being populated elsewhere in the same list. Checking that first is what keeps a
  // future CLI that drops the field entirely from turning every model into „not supported", i.e. into a
  // switch that has silently disappeared.
  const fieldIsLive = list.some((m) => m && Array.isArray(m.supportedEffortLevels));
  if (hit && fieldIsLive) return { supported: false, source: 'cli' };
  // Fall back to the mirrored table, on the CONCRETE id: an alias like "haiku" says nothing by itself,
  // and the CLI list is the only place that resolves it.
  const raw = (hit && hit.resolvedModel) || String(modelValue == null ? '' : modelValue).trim();
  const base = bedrockBase(raw);
  if (!base) return { supported: true, source: 'unknown' };          // Default with no CLI list to read
  if (/^claude-3-/.test(base)) return { supported: false, source: 'table' };
  if (MODELS_WITHOUT_XHIGH.includes(base)) return { supported: false, source: 'table' };
  return { supported: true, source: 'unknown' };
}

module.exports = {
  buildModelMenu, buildBedrockMenu, resolveDefaultModel, BEDROCK_CANDIDATES, bedrockBase, bedrockLabelFor,
  PRICING, applyManagedPricing, effectivePricing, pricingFor, pricingIsManaged,
  MODELS_WITHOUT_XHIGH, cliModelEntry, ultracodeModelSupport, modelEffortLevels,
};
