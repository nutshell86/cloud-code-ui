'use strict';
// Unit tests for lib/models.js — buildModelMenu mirrors the console /model menu from ~/.claude.json
// (base template gated on modelAccessCache entitlements + additionalModelOptionsCache extras,
// tier-sorted Default→Opus→Fable→Sonnet→Haiku) and the PRICING table's shape.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildModelMenu, buildBedrockMenu, resolveDefaultModel, bedrockBase, PRICING, BEDROCK_CANDIDATES } = require('../lib/models');

// What „Default" RESOLVES TO was hardcoded as '' in the first-party menu, and that empty string is the root
// of the reported context line: the Default entry's value is '' too, so nothing in such a tab could say that
// the session runs the 1M variant — the gauge then measured a real 1M session against the model-name window
// (200 000) and painted „Kontext 250 % · 500,8K / 200,0K". One row per (what settings.json says × what the
// entitlement cache knows); the „[1m]" suffix is the variant and must survive every one of them.
describe('resolveDefaultModel — „Default" says what it starts', () => {
  const ACCESS = [
    { apiName: 'claude-opus-5', entitled: true },
    { apiName: 'claude-opus-4-8', entitled: true },
    { apiName: 'claude-fable-5', entitled: true },
    { apiName: 'claude-fable-5-1', entitled: false },
  ];
  const ROWS = [
    { name: 'no `model` in settings.json → only the CLI knows, and „" says exactly that', set: '', access: ACCESS, want: '' },
    { name: 'a concrete id stands for itself', set: 'claude-opus-4-8', access: ACCESS, want: 'claude-opus-4-8' },
    { name: 'an ALIAS resolves to the newest entitled member — the suffix survives', set: 'opus[1m]', access: ACCESS, want: 'claude-opus-5[1m]' },
    { name: '…and without the suffix it stays the bare variant', set: 'opus', access: ACCESS, want: 'claude-opus-5' },
    { name: 'an alias whose advertised version is not entitled lands on the one that is', set: 'fable', access: ACCESS, want: 'claude-fable-5' },
    { name: 'a concrete id with the suffix keeps both', set: 'eu.anthropic.claude-opus-5[1m]', access: ACCESS, want: 'eu.anthropic.claude-opus-5[1m]' },
    // With no access cache an alias cannot be resolved. It is passed on as the family — the consumer reads
    // that as „the variant is known, the model is not" and paints „–" rather than inventing a window
    // (public/js/ctx.js ctxResolveModel/varUnknown); inventing a concrete id here would be a guess stated
    // as a fact, which is the class of bug this whole round is about.
    { name: 'no access cache → the alias is passed on unresolved, never guessed into an id', set: 'opus[1m]', access: null, want: 'opus[1m]' },
    { name: 'whitespace and junk say nothing', set: '   ', access: ACCESS, want: '' },
  ];
  ROWS.forEach((r) => it(r.name, () => assert.equal(resolveDefaultModel(r.set, r.access), r.want)));

  it('…and the menu carries it on the Default row (both call sites of the menu depend on it)', () => {
    const cj = { modelAccessCache: ACCESS };
    assert.equal(buildModelMenu(cj, 'opus[1m]')[0].resolves, 'claude-opus-5[1m]');
    assert.equal(buildModelMenu(cj)[0].resolves, '', 'no settings model passed → no claim');
    assert.equal(buildModelMenu(cj, 'opus[1m]')[0].value, '', 'Default is still the empty value');
  });
});

describe('buildModelMenu', () => {
  it('empty/unreadable claude.json → unfiltered base template (never an empty dropdown)', () => {
    for (const cj of [null, {}, { modelAccessCache: 'garbage' }]) {
      const m = buildModelMenu(cj);
      assert.deepEqual(m.map((x) => x.label), ['Default', 'Opus (1M)', 'Sonnet', 'Haiku']);
      assert.equal(m[0].value, '', 'Default must be the empty value (CLI picks)');
    }
  });

  it('entitlements gate the base entries per family', () => {
    const cj = { modelAccessCache: [
      { apiName: 'claude-sonnet-5', entitled: true },
      { apiName: 'claude-opus-5', entitled: false },
      { apiName: 'claude-haiku-4-5', entitled: true },
    ] };
    const labels = buildModelMenu(cj).map((x) => x.label);
    assert.deepEqual(labels, ['Default', 'Sonnet 5', 'Haiku 4.5'], 'un-entitled Opus must be dropped');
  });

  it('cache extras merge in and tier-sort into console order (Fable between Opus and Sonnet)', () => {
    const cj = {
      modelAccessCache: [
        { apiName: 'claude-opus-5', entitled: true },
        { apiName: 'claude-fable-5', entitled: true },
        { apiName: 'claude-sonnet-5', entitled: true },
        { apiName: 'claude-haiku-4-5', entitled: true },
      ],
      additionalModelOptionsCache: [
        { value: 'claude-fable-5[1m]', label: 'Fable', description: 'Most capable' },
        { value: null }, // malformed entry must be skipped
      ],
    };
    const m = buildModelMenu(cj);
    assert.deepEqual(m.map((x) => x.label), ['Default', 'Opus 5 (1M)', 'Fable 5', 'Sonnet 5', 'Haiku 4.5']);
    const fable = m.find((x) => x.resolves === 'claude-fable-5');
    assert.equal(fable.desc, 'Most capable', 'console description becomes the tooltip');
    assert.equal(fable.value, 'fable[1m]', 'the ALIAS is sent, so the CLI resolves the entitled member');
  });

  // Regression (2026-09-02, measured against the live CLI): additionalModelOptionsCache advertised
  // `claude-fable-5-1[1m]` while modelAccessCache said that exact id was NOT entitled. The menu offered
  // it anyway, and set_model answered `error: … is restricted by your organization's settings. Using
  // claude-opus-5[1m] instead.` — the session kept running Opus while the dropdown claimed Fable.
  it('an extra whose advertised version is not entitled falls back to the entitled one (alias + label)', () => {
    const cj = {
      modelAccessCache: [
        { apiName: 'claude-opus-5', entitled: true },
        { apiName: 'claude-fable-5', entitled: true },   // this is what the account may use
        { apiName: 'claude-fable-5-1', entitled: false }, // …and this is what the cache advertises
      ],
      additionalModelOptionsCache: [{ value: 'claude-fable-5-1[1m]', label: 'Fable', description: 'd' }],
    };
    const fable = buildModelMenu(cj).find((x) => /fable/i.test(x.value));
    assert.equal(fable.value, 'fable[1m]', 'never send the restricted concrete id');
    assert.equal(fable.resolves, 'claude-fable-5', 'resolves names the entitled member');
    assert.equal(fable.label, 'Fable 5', 'the label must not advertise a version we cannot get');
  });

  it('an extra whose whole family is un-entitled is dropped', () => {
    const cj = {
      modelAccessCache: [{ apiName: 'claude-opus-5', entitled: true }, { apiName: 'claude-fable-5', entitled: false }],
      additionalModelOptionsCache: [{ value: 'claude-fable-5-1[1m]', label: 'Fable' }],
    };
    assert.equal(buildModelMenu(cj).find((x) => /fable/i.test(x.value + x.label)), undefined);
  });

  it('without an access cache an extra is still offered verbatim (never hide a model we cannot judge)', () => {
    const m = buildModelMenu({ additionalModelOptionsCache: [{ value: 'claude-newthing-9[1m]', label: 'NewThing' }] });
    const x = m.find((e) => e.value === 'claude-newthing-9[1m]');
    assert.ok(x, 'kept as-is when there is nothing to check it against');
    assert.equal(x.resolves, 'claude-newthing-9');
  });

  it('the version is derived from the newest entitled family member, not hardcoded', () => {
    const cj = { modelAccessCache: [
      { apiName: 'claude-3-opus-20240229', entitled: false },
      { apiName: 'claude-opus-4-1-20250805-claude-ai', entitled: true }, // date + word suffix must not leak in
      { apiName: 'claude-opus-4-8', entitled: true },
      { apiName: 'claude-opus-5', entitled: true },                     // newest wins
      { apiName: 'claude-sonnet-9', entitled: true },                   // a future release needs no code change
    ] };
    const m = buildModelMenu(cj);
    const opus = m.find((x) => x.value === 'opus[1m]');
    assert.equal(opus.label, 'Opus 5 (1M)');
    assert.equal(opus.resolves, 'claude-opus-5', 'the tooltip names the concrete model');
    assert.equal(m.find((x) => x.value === 'sonnet').label, 'Sonnet 9');
  });

  it('an already-versioned extra label is not versioned twice (no access cache → verbatim)', () => {
    const cj = { additionalModelOptionsCache: [{ value: 'claude-fable-5-1[1m]', label: 'Fable 5.1' }] };
    assert.equal(buildModelMenu(cj).find((x) => x.value === 'claude-fable-5-1[1m]').label, 'Fable 5.1');
  });

  it('…but a version in the label is corrected when the entitlement cache disagrees', () => {
    const cj = {
      modelAccessCache: [{ apiName: 'claude-fable-5', entitled: true }, { apiName: 'claude-fable-5-1', entitled: false }],
      additionalModelOptionsCache: [{ value: 'claude-fable-5-1[1m]', label: 'Fable 5.1' }],
    };
    assert.equal(buildModelMenu(cj).find((x) => /fable/i.test(x.value)).label, 'Fable 5');
  });
});

describe('PRICING', () => {
  it('every entry has positive in/out USD-per-1M numbers, keyed by normalized concrete ids', () => {
    const keys = Object.keys(PRICING);
    assert.ok(keys.length >= 5);
    for (const k of keys) {
      assert.match(k, /^claude-[a-z0-9-]+$/, 'no [1m] suffix / date suffix in PRICING keys: ' + k);
      assert.ok(PRICING[k].in > 0 && PRICING[k].out > PRICING[k].in, k + ': out must exceed in');
    }
  });
  it('the current default families are priced', () => {
    for (const k of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5']) assert.ok(PRICING[k], k + ' missing');
  });
  // Regression: normalizeModel strips "[1m]" and a date, but not the "-1" of a point release — so every
  // id the dropdown can actually hand out needs its own key, or that model's cost silently reads 0.
  it('every concrete dropdown id normalizes onto a PRICING key', () => {
    const norm = (m) => String(m).replace(/\[1m\]/i, '').replace(/-\d{8}$/, '');
    const cj = { additionalModelOptionsCache: [{ value: 'claude-fable-5-1[1m]', label: 'Fable' }] };
    buildModelMenu(cj)
      .filter((m) => /^claude-/.test(m.value)) // aliases are priced via the id the CLI reports back
      .forEach((m) => assert.ok(PRICING[norm(m.value)], 'unpriced dropdown model: ' + m.value));
  });
  // The assertion above only sees buildModelMenu's output, whose concrete ids come from
  // additionalModelOptionsCache — which is how claude-opus-5-5 reached 396.8 M tokens priced at $0.00
  // on the live corpus: it lives in BEDROCK_CANDIDATES only, and nothing ever checked THAT table.
  it('every BEDROCK_CANDIDATE reduces onto a PRICING key (the hole opus-5-5 came through)', () => {
    for (const c of BEDROCK_CANDIDATES) assert.ok(PRICING[bedrockBase(c.id)], 'unpriced Bedrock candidate: ' + c.id + ' → ' + bedrockBase(c.id));
  });
  // Rates measured against the CLI's own `cost-state` frames, not read off a price list. Pinned so a
  // later tidy-up cannot silently restore the 50 % Sonnet error or drop the Opus 5.5 row again.
  it('the rates the CLI itself bills are the rates in the table', () => {
    assert.deepEqual(PRICING['claude-sonnet-5'], { in: 2, out: 10 }, 'Sonnet 5 at 3/15 is exactly 1.5000x what the CLI bills');
    assert.deepEqual(PRICING['claude-opus-5-5'], { in: 5, out: 25 }, 'Opus 5.5 missing = the dominant subagent model costs $0');
  });
  // A bare "anthropic." id (no region) occurs in real transcripts AND as a cost-state.modelUsage key.
  it('bedrockBase reduces a Bedrock id with AND without a region prefix', () => {
    assert.equal(bedrockBase('anthropic.claude-haiku-4-5-20251001-v1:0'), 'claude-haiku-4-5');
    assert.equal(bedrockBase('eu.anthropic.claude-haiku-4-5-20251001-v1:0'), 'claude-haiku-4-5');
    assert.equal(bedrockBase('eu.anthropic.claude-opus-5[1m]'), 'claude-opus-5');
    assert.equal(bedrockBase('claude-opus-5-5'), 'claude-opus-5-5', 'a bare model id must pass through untouched');
  });
});

// ------------------------------------------------------- managed modelPricing (CLI 2.1.271)
// An organisation can set `modelPricing: { multiplier, overrides }` in managed settings. The panel
// prints cost in four places; if it kept its list prices there, every one of them would be wrong by
// that factor without a hint. These tests also pin the "nothing managed" case, which is what this
// machine has — the overlay must then be absent, not an identical copy.
const { applyManagedPricing, effectivePricing, pricingFor, pricingIsManaged } = require('../lib/models');
const { costOf } = require('../lib/core');

describe('managed modelPricing', () => {

  it('modelPricing: absent/garbage leaves the list prices in place', () => {
    for (const bad of [undefined, null, 'nope', 42, {}, { multiplier: 0 }, { multiplier: -1 }, { multiplier: 11 }]) {
      applyManagedPricing(bad);
      assert.equal(pricingIsManaged(), false, JSON.stringify(bad) + ' must not install an overlay');
      assert.equal(effectivePricing(), PRICING);
    }
  });

  it('modelPricing: the multiplier scales every rate, and costOf follows it', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 0 };
    const listCost = costOf(usage, 'claude-opus-5');
    try {
      applyManagedPricing({ multiplier: 2 });
      assert.equal(pricingIsManaged(), true);
      assert.equal(pricingFor('claude-opus-5').in, PRICING['claude-opus-5'].in * 2);
      assert.equal(costOf(usage, 'claude-opus-5'), listCost * 2, 'the aggregation must not keep list prices');
    } finally { applyManagedPricing(null); }
    assert.equal(costOf(usage, 'claude-opus-5'), listCost, 'and it goes back when the setting goes away');
  });

  it('modelPricing: an override wins over the list price, the multiplier applies on top', () => {
    try {
      applyManagedPricing({ multiplier: 3, overrides: { 'claude-opus-5': { in: 1, out: 2 } } });
      assert.deepEqual(pricingFor('claude-opus-5'), { in: 3, out: 6 });
      // a model the override does not name still gets the multiplier
      assert.equal(pricingFor('claude-haiku-4-5').in, PRICING['claude-haiku-4-5'].in * 3);
    } finally { applyManagedPricing(null); }
  });

  it('modelPricing: an unusable override row is dropped, not guessed at', () => {
    try {
      applyManagedPricing({ overrides: { 'claude-opus-5': { in: 'free' }, 'claude-haiku-4-5': { in: -1, out: 2 }, 'claude-sonnet-5': { input: 4, output: 8 } } });
      assert.deepEqual(pricingFor('claude-opus-5'), PRICING['claude-opus-5'], 'half a row is not a price');
      assert.deepEqual(pricingFor('claude-haiku-4-5'), PRICING['claude-haiku-4-5'], 'a negative rate is not a price');
      assert.deepEqual(pricingFor('claude-sonnet-5'), { in: 4, out: 8 }, 'input/output spelling is accepted');
    } finally { applyManagedPricing(null); }
  });

  it('modelPricing: the base table itself is never mutated', () => {
    const before = JSON.stringify(PRICING);
    applyManagedPricing({ multiplier: 5, overrides: { 'claude-opus-5': { in: 99, out: 99 } } });
    applyManagedPricing(null);
    assert.equal(JSON.stringify(PRICING), before, 'a later run must still see the real list prices');
  });
});

// ---- Bedrock ------------------------------------------------------------------------------------
// The measurement these tests stand in for is real: eu-central-1, 2026-09-24, corporate Bedrock role.
// Opus 5 / Sonnet 5 / Sonnet 4.6 / Haiku 4.5 were authorized, Opus 5.5 and every `global.*` profile
// answered 403 AccessDenied, and Fable exists ONLY as a global profile — which is why picking "Fable"
// in the CLI's menu wrote `global.anthropic.claude-fable-5-1` into settings.json and turned every later
// "Default" run into a 403 for a model nobody had knowingly chosen.
const ACCESS = {
  region: 'eu-central-1', checkedAt: 1, error: '', models: [
    { id: 'eu.anthropic.claude-opus-5', verdict: 'allowed' },
    { id: 'eu.anthropic.claude-opus-5-5', verdict: 'denied' },
    { id: 'eu.anthropic.claude-opus-4-8', verdict: 'allowed' },
    { id: 'global.anthropic.claude-fable-5-1', verdict: 'denied' },
    { id: 'eu.anthropic.claude-sonnet-5', verdict: 'allowed' },
    { id: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0', verdict: 'allowed' },
    { id: 'eu.anthropic.claude-mythos-5', verdict: 'absent' },
    { id: 'eu.anthropic.claude-sonnet-4-6', verdict: 'unknown' },
  ],
};
const menuValues = (m) => m.map((x) => x.value);
const blockedOf = (m) => m.filter((x) => x.blocked).map((x) => x.value);

describe('buildBedrockMenu', () => {
  it('offers the concrete profile id — never a family alias', () => {
    const m = buildBedrockMenu(ACCESS, 'eu.anthropic.claude-opus-5');
    for (const e of m.slice(1)) assert.match(e.value, /^(eu|us|apac|global)\.anthropic\./, e.value + ' must be a concrete Bedrock id');
  });

  it('allowed models are selectable, denied ones stay VISIBLE but blocked, absent/unknown are dropped', () => {
    const m = buildBedrockMenu(ACCESS, '');
    assert.deepEqual(blockedOf(m), ['eu.anthropic.claude-opus-5-5', 'global.anthropic.claude-fable-5-1']);
    const vals = menuValues(m);
    assert.ok(!vals.includes('eu.anthropic.claude-mythos-5'), 'a model that does not exist here is not a choice');
    assert.ok(!vals.includes('eu.anthropic.claude-sonnet-4-6'), 'an unmeasured model is not presented as measured');
    assert.ok(vals.includes('eu.anthropic.claude-haiku-4-5-20251001-v1:0'));
  });

  it('the 1M-context entry exists only where the candidate table says so, and sorts above the plain one', () => {
    const vals = menuValues(buildBedrockMenu(ACCESS, ''));
    assert.ok(vals.indexOf('eu.anthropic.claude-opus-5[1m]') < vals.indexOf('eu.anthropic.claude-opus-5'));
    assert.ok(!vals.some((v) => /sonnet.*\[1m\]/.test(v)), 'a 1M variant is never guessed for a model we did not verify it on');
  });

  // C3 — the premise the panel's reverse lookup (chat.js modelMenuValueFor) has to cope with, stated here
  // against the real builders instead of assumed over there: a „(1M)" row's `resolves` is the BARE model id.
  // It has to be — `resolves` answers „which model is this", and the suffix is a request for a beta rather than
  // part of any model's name — but it means `resolves` ALONE cannot tell the two rows of one model apart, and
  // the wide row is also the FIRST of the two. So a lookup for the bare model that matches on `resolves` lands
  // on the „(1M)" row, and the dropdown then promises 1M for a 200 K session. Both menus build it that way.
  it('a „(1M)" row resolves to the BARE id — so `resolves` alone cannot identify a variant', () => {
    const bedrock = buildBedrockMenu(ACCESS, '');
    const wide = bedrock.find((e) => e.value === 'eu.anthropic.claude-opus-5[1m]');
    const plain = bedrock.find((e) => e.value === 'eu.anthropic.claude-opus-5');
    assert.equal(wide.resolves, 'eu.anthropic.claude-opus-5');
    assert.equal(wide.resolves, plain.resolves, 'the two rows of one model are indistinguishable by `resolves`');
    assert.ok(!/\[1m\]/i.test(wide.resolves), 'the suffix lives on the VALUE only');
    // the first-party menu says the same about its alias row
    const fp = buildModelMenu({ modelAccessCache: [{ apiName: 'claude-opus-5', entitled: true }] });
    const fpWide = fp.find((e) => e.value === 'opus[1m]');
    assert.equal(fpWide.label, 'Opus 5 (1M)');
    assert.equal(fpWide.resolves, 'claude-opus-5', 'the 1M alias row resolves to the plain model too');
  });

  it('order: Default, then opus → fable → sonnet → haiku, newest first, blocked last within the family', () => {
    assert.deepEqual(buildBedrockMenu(ACCESS, '').map((x) => x.label), [
      'Default', 'Opus 5 (1M)', 'Opus 5', 'Opus 4.8', 'Opus 5.5', 'Fable 5.1', 'Sonnet 5', 'Haiku 4.5',
    ]);
  });

  it('Default names what settings.json really starts — and is BLOCKED when that model is forbidden', () => {
    const bad = buildBedrockMenu(ACCESS, 'global.anthropic.claude-fable-5-1')[0];
    assert.equal(bad.value, '', 'Default keeps the empty value: the CLI still picks');
    assert.equal(bad.resolves, 'global.anthropic.claude-fable-5-1', 'the UI must be able to NAME the trap');
    assert.equal(bad.blocked, true);
    assert.equal(bad.reason, 'denied');
  });

  it('Default is fine when settings.json points at an allowed model, or at nothing at all', () => {
    assert.equal(buildBedrockMenu(ACCESS, 'eu.anthropic.claude-opus-5')[0].blocked, false);
    assert.equal(buildBedrockMenu(ACCESS, '')[0].blocked, false, 'no `model` key = the CLI chooses = nothing to warn about');
    assert.equal(buildBedrockMenu(ACCESS, 'eu.anthropic.claude-sonnet-4-6')[0].blocked, false, 'unknown is not a denial');
  });

  it('a failed measurement yields no entries beyond Default (the route then keeps the old menu)', () => {
    for (const a of [null, {}, { models: [] }, { models: 'nope' }]) assert.equal(buildBedrockMenu(a, '').length, 1);
  });

  it('entry shape matches the first-party menu, so the dropdown has one renderer', () => {
    const keys = (e) => Object.keys(e).sort().join(',');
    assert.equal(keys(buildBedrockMenu(ACCESS, '')[1]), keys(buildModelMenu({})[1]));
  });
});

describe('bedrockBase', () => {
  it('reduces every id spelling to the bare name the PRICING table is keyed by', () => {
    const cases = {
      'eu.anthropic.claude-opus-5': 'claude-opus-5',
      'eu.anthropic.claude-opus-5[1m]': 'claude-opus-5',
      'global.anthropic.claude-fable-5-1': 'claude-fable-5-1',
      'eu.anthropic.claude-opus-4-6-v1': 'claude-opus-4-6',
      'eu.anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5',
      'us-gov.anthropic.claude-sonnet-5': 'claude-sonnet-5',
      'claude-opus-5': 'claude-opus-5',
      // …and the spelling with NO region at all. Every case above has one, which is why the pattern was
      // allowed to require it for so long. This id is not hypothetical: it is the one the CLI wrote for
      // all four workflow agents in the control run of 2026-10-02 (8 usage records), and unreduced it
      // priced at 0 €.
      'anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5',
      'anthropic.claude-sonnet-5': 'claude-sonnet-5',
      'bedrock.claude-opus-5': 'claude-opus-5',
      '': '',
    };
    for (const [id, want] of Object.entries(cases)) assert.equal(bedrockBase(id), want, id);
  });
  it('every reduced Bedrock candidate that we price is actually in the table', () => {
    // the point: a Bedrock turn must not silently count as free in the Usage view
    for (const id of ['eu.anthropic.claude-opus-5', 'eu.anthropic.claude-sonnet-5',
      'eu.anthropic.claude-haiku-4-5-20251001-v1:0', 'anthropic.claude-haiku-4-5-20251001-v1:0'])
      assert.ok(PRICING[bedrockBase(id)], id + ' would be unpriced');
  });
  // The bug this guards is not „an id looks wrong" but „a real turn costs 0 €", so the check is made on
  // the number the Usage view actually shows.
  it('a Haiku turn written with the bare anthropic. prefix does not cost 0 €', () => {
    const { costParts } = require('../lib/core');
    const usage = { input_tokens: 10000, output_tokens: 2000, cache_read_input_tokens: 5000 };
    for (const id of ['anthropic.claude-haiku-4-5-20251001-v1:0', 'eu.anthropic.claude-haiku-4-5-20251001-v1:0']) {
      const c = costParts(usage, id);
      assert.equal(c.priced, true, id + ' is not in the pricing table');
      assert.ok(c.total > 0, id + ' folded to zero — those tokens would be invisible in the cost total');
    }
    // and the two spellings must agree: the region cannot change what a turn costs
    assert.equal(costParts(usage, 'anthropic.claude-haiku-4-5-20251001-v1:0').total,
      costParts(usage, 'eu.anthropic.claude-haiku-4-5-20251001-v1:0').total);
  });
});

// ---- ultracode: which models can do it ------------------------------------------------------------
// The CLI's `initialize` answer is the source of truth (it lists supportedEffortLevels per model, and
// ultracode needs xhigh). MEASURED shape on 2.1.285 with Bedrock, reproduced in the fixture below:
// Haiku 4.5 carries NO effort fields at all, Sonnet/Opus 5 carry the full ladder.
const { ultracodeModelSupport, cliModelEntry, MODELS_WITHOUT_XHIGH } = require('../lib/models');

const CLI_MODELS = [
  { value: 'default', resolvedModel: 'eu.anthropic.claude-sonnet-5', displayName: 'Default', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', resolvedModel: 'eu.anthropic.claude-sonnet-5', displayName: 'Sonnet 5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus', resolvedModel: 'eu.anthropic.claude-opus-5-5', displayName: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', resolvedModel: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0', displayName: 'Haiku 4.5' },
];

describe('ultracodeModelSupport', () => {
  it('reads the CLI list by alias AND by the concrete id the dropdown actually uses', () => {
    // the panel's Bedrock dropdown holds concrete ids, the CLI list is keyed by alias → join via bedrockBase
    for (const id of ['sonnet', 'eu.anthropic.claude-sonnet-5', 'eu.anthropic.claude-sonnet-5[1m]']) {
      assert.deepEqual(ultracodeModelSupport(CLI_MODELS, id), { supported: true, source: 'cli' }, id);
    }
    assert.deepEqual(ultracodeModelSupport(CLI_MODELS, 'eu.anthropic.claude-opus-5-5'), { supported: true, source: 'cli' });
  });
  it('Haiku 4.5 has no effort levels at all → not supported, and that IS the CLI saying so', () => {
    // measured: ultracodeAvailable was false for haiku, and apply_flag_settings still answered `success`
    assert.deepEqual(ultracodeModelSupport(CLI_MODELS, 'haiku'), { supported: false, source: 'cli' });
    assert.deepEqual(ultracodeModelSupport(CLI_MODELS, 'eu.anthropic.claude-haiku-4-5-20251001-v1:0'), { supported: false, source: 'cli' });
  });
  it('"" = the panel\'s Default entry resolves to the CLI\'s "default" alias', () => {
    assert.deepEqual(ultracodeModelSupport(CLI_MODELS, ''), { supported: true, source: 'cli' });
    assert.equal(cliModelEntry(CLI_MODELS, '').value, 'default');
  });
  it('without the probe it falls back to the mirrored table', () => {
    assert.deepEqual(ultracodeModelSupport(null, 'eu.anthropic.claude-haiku-4-5-20251001-v1:0'), { supported: false, source: 'table' });
    assert.deepEqual(ultracodeModelSupport([], 'claude-opus-4-5'), { supported: false, source: 'table' });
    assert.deepEqual(ultracodeModelSupport(null, 'claude-3-5-sonnet'), { supported: false, source: 'table' });
    assert.deepEqual(ultracodeModelSupport(null, 'eu.anthropic.claude-sonnet-5'), { supported: true, source: 'unknown' });
  });
  it('an unknown model counts as supported — a wrong "no" would hide the switch for good', () => {
    // a false yes is corrected by get_settings a second after the session starts; a false no is forever
    assert.equal(ultracodeModelSupport(null, 'claude-something-7').supported, true);
    assert.equal(ultracodeModelSupport(null, '').supported, true);
  });
  it('the fallback table lists only models the CLI itself excludes', () => {
    for (const id of MODELS_WITHOUT_XHIGH) assert.match(id, /^claude-(opus|sonnet|haiku)-4-\d$/, id);
  });
});

// ---- which effort levels a model offers (the per-model effort filter) -------------------------------
// The CLI states this per model, and the panel's picker offered the whole ladder regardless: on Haiku 4.5,
// which has no effort levels at all, picking xhigh looked like it worked and did nothing.
describe('modelEffortLevels', () => {
  const { modelEffortLevels } = require('../lib/models');
  const FULL = ['low', 'medium', 'high', 'xhigh', 'max'];
  it("returns the CLI's list — by alias AND by the concrete id the dropdown actually holds", () => {
    // THE defect this helper exists for: /api/ultracode/support joined with `m.value === model`, which only
    // ever matches an ALIAS. The panel's Bedrock dropdown produces concrete ids, so the list came back empty
    // for every real selection and the per-model filter could never fire.
    for (const id of ['sonnet', 'eu.anthropic.claude-sonnet-5', 'eu.anthropic.claude-sonnet-5[1m]'])
      assert.deepEqual(modelEffortLevels(CLI_MODELS, id), FULL, id);
    assert.deepEqual(modelEffortLevels(CLI_MODELS, ''), FULL, '"" = the CLI\'s "default" alias');
  });
  it('a model the CLI lists WITHOUT effort levels reports none — which is how xhigh gets disabled', () => {
    assert.deepEqual(modelEffortLevels(CLI_MODELS, 'haiku'), []);
    assert.deepEqual(modelEffortLevels(CLI_MODELS, 'eu.anthropic.claude-haiku-4-5-20251001-v1:0'), []);
  });
  it('no probe, or a model nobody lists → [] = do not filter, never an empty dropdown', () => {
    // A failed probe has to FAIL OPEN. An empty effort picker is a dead end the user cannot argue with,
    // while an over-wide one is corrected by the session itself a second after the start.
    for (const list of [null, undefined, [], 'quatsch']) assert.deepEqual(modelEffortLevels(list, 'sonnet'), [], String(list));
    assert.deepEqual(modelEffortLevels(CLI_MODELS, 'claude-something-9'), []);
  });
  it('the returned list is a COPY — a caller must not be able to edit the probe answer', () => {
    modelEffortLevels(CLI_MODELS, 'sonnet').push('ultracode');
    assert.deepEqual(modelEffortLevels(CLI_MODELS, 'sonnet'), FULL, 'the CLI list must be untouched');
  });
});
