'use strict';
// PR-11 — the context breakdown. The question every test here asks is the same one: is the number READ or
// is it CLAIMED. The payload below is not invented: it is the real `get_context_usage` answer of the
// 2026-10-03 run (free, CLI 2.1.288 — C:/Users/you/ccui-ctxprobe/ctx-probe-result.json, key
// `ctx_cold`), copied field for field, including the two residues being exactly zero and the deferred rows
// lying outside both identities.
//
// WHY A FIXTURE FROM THE RAW RECORDING AND NOT A HAND-BUILT ONE: the repo's previous `gridRows` fixture was
// invented (text rows with a per-MCP-tool list) and the production comment that justified dropping it cited
// that invention as its reason. A test built on a made-up shape proves the code against the idea somebody
// had of the CLI, which is the failure class this project keeps paying for.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ctxMcpAggregate, ctxBreakdown, ctxBreakdownNotes } = require('../public/js/ctx-breakdown');

// --- the measured answer, verbatim (ctx_cold of the 2026-10-03 run) ------------------------------------
const CATS = [
  { name: 'System prompt', tokens: 3002, kind: 'used' },
  { name: 'System tools', tokens: 14938, kind: 'used' },
  { name: 'MCP tools (deferred)', tokens: 75605, kind: 'deferred' },
  { name: 'System tools (deferred)', tokens: 14712, kind: 'deferred' },
  { name: 'Memory files', tokens: 730, kind: 'used' },
  { name: 'Skills', tokens: 2997, kind: 'used' },
  { name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' },
  { name: 'Free space', tokens: 945333, kind: 'free' },
];
// six of the 119 measured tools, from three of the servers — with their real token figures. The per-server
// sums are therefore NOT the measured 25 429 / 50 176; what is reproduced is the RELATION the aggregation
// is checked against (Σ tools === the category value), which is the thing under test.
const TOOLS = [
  { name: 'mcp__jira__confluence_add_comment', serverName: 'jira', tokens: 367, isLoaded: false },
  { name: 'mcp__jira__jira_get_issue', serverName: 'jira', tokens: 389, isLoaded: false },
  { name: 'mcp__sap-adt__read_source', serverName: 'sap-adt', tokens: 412, isLoaded: false },
  { name: 'mcp__sap-adt__write_source', serverName: 'sap-adt', tokens: 530, isLoaded: false },
  { name: 'mcp__sap-adt__activate', serverName: 'sap-adt', tokens: 301, isLoaded: false },
  { name: 'mcp__snow-mcp__list_incidents', serverName: 'snow-mcp', tokens: 355, isLoaded: false },
];
const TOOL_SUM = 367 + 389 + 412 + 530 + 301 + 355;      // 2354
// …so the category has to carry exactly that for the aggregation to be allowed to answer
const catsWithMcp = (sum) => CATS.map((c) => (c.name === 'MCP tools (deferred)' ? { ...c, tokens: sum } : c));

// the measurement as ctxProbe stores it (ctxFromRoute's fields + gen/stamp/at)
const meas = (over) => Object.assign({
  tokens: 21667, win: 1000000, raw: 1000000, pct: 2, hasPct: true, hasTok: true,
  source: 'model-default', cats: CATS, mcp: null, gen: 1, stamp: 7, at: 1700000000000,
}, over || {});
const NOW = { gen: 1, stamp: 7 };

describe('ctx-breakdown — the two identities that make a READ breakdown checkable', () => {
  it('the measured payload satisfies both, and the breakdown reports zero residue', () => {
    const b = ctxBreakdown(meas(), NOW);
    assert.equal(b.ok, true);
    // IDENTITY 1 — Σ(used) === totalTokens. 3002 + 14938 + 730 + 2997 = 21 667.
    assert.equal(b.benutztSumme, 21667);
    assert.equal(b.total, 21667);
    assert.equal(b.offen, 0);
    // IDENTITY 2 — Σ(used) + buffer + free === maxTokens. 21 667 + 33 000 + 945 333 = 1 000 000.
    assert.equal(b.pufferSumme + b.freiSumme + b.benutztSumme, 1000000);
    assert.equal(b.rest, 0);
    assert.deepEqual(b.stimmt, { gesamt: true, fenster: true });
    assert.equal(b.widerspruch, false);
  });

  it('the three scalars are COPIES — the breakdown recomputes none of them', () => {
    // The CLI rounds its own percentage (21667/1000000 = 2,1667 → 2, `Math.round` read from the binary).
    // A panel that divided for itself would print 2,17 % next to the CLI's 2 % — two numbers, one of which
    // is wrong, which is the whole reason this file exists.
    const b = ctxBreakdown(meas(), NOW);
    assert.equal(b.pct, 2, 'the CLI\'s own percentage, not a division');
    assert.equal(b.total, 21667);
    assert.equal(b.fenster, 1000000);
    assert.equal(b.quelle, 'model-default', 'autocompactSource travels verbatim');
    // …and an answer with NO percentage gets none, rather than a computed stand-in
    const noPct = ctxBreakdown(meas({ hasPct: false, pct: 0 }), NOW);
    assert.equal(noPct.pct, null);
  });

  it('THE TRAP: deferred is in neither identity and never in the bar', () => {
    const b = ctxBreakdown(meas(), NOW);
    // 75 605 + 14 712 — the biggest single item of all, and in neither totalTokens nor „Free space"
    assert.equal(b.nachladbarSumme, 90317);
    assert.deepEqual(b.nachladbar.map((r) => r.name), ['MCP tools (deferred)', 'System tools (deferred)']);
    // the bar's segments sum to the WINDOW exactly — adding the deferred rows would make 1 090 317 of
    // 1 000 000 = 109 %, which is „Kontext 250 % · 500,8K / 200,0K" on the category axis
    const segSum = b.segmente.reduce((a, s) => a + s.tokens, 0);
    assert.equal(segSum, 1000000);
    assert.equal(b.segmente.some((s) => s.kind === 'deferred'), false, 'a deferred row reached the bar');
    const breiten = b.segmente.reduce((a, s) => a + s.breite, 0);
    assert.ok(Math.abs(breiten - 100) < 0.001, 'the segments do not fill exactly 100 %: ' + breiten);
  });

  it('a residue is a VISIBLE ROW, not a silent redistribution', () => {
    // one category 500 tokens short of the CLI's own total → „nicht zugeordnet: 500"
    const short = CATS.map((c) => (c.name === 'Skills' ? { ...c, tokens: 2497 } : c));
    const b = ctxBreakdown(meas({ cats: short }), NOW);
    assert.equal(b.offen, 500);
    assert.equal(b.stimmt.gesamt, false);
    const row = b.segmente.find((s) => s.teil === 'offen');
    assert.ok(row && row.tokens === 500, 'no visible row for the difference');
    // the parts still fill the window exactly, BECAUSE the residue is one of them
    assert.equal(b.segmente.reduce((a, s) => a + s.tokens, 0), 1000000);
    assert.equal(b.rest, 0);
    // …and it is said out loud, with its number
    const n = ctxBreakdownNotes(b).find((x) => x.key === 'ctxbd.offenHinweis');
    assert.ok(n && n.num === 500 && n.warn === true);
  });

  it('…and the window residue likewise', () => {
    const short = CATS.map((c) => (c.name === 'Free space' ? { ...c, tokens: 945000 } : c));
    const b = ctxBreakdown(meas({ cats: short }), NOW);
    assert.equal(b.rest, 333);
    assert.equal(b.stimmt.fenster, false);
    assert.ok(b.segmente.find((s) => s.teil === 'rest' && s.tokens === 333));
    assert.ok(ctxBreakdownNotes(b).some((x) => x.key === 'ctxbd.restHinweis' && x.num === 333));
  });

  it('a NEGATIVE residue drops the bar instead of hiding the contradiction', () => {
    // the rows claim more than the CLI's own total → `offen` would be negative, and a bar cannot show that
    const over = CATS.map((c) => (c.name === 'Skills' ? { ...c, tokens: 5997 } : c));
    const b = ctxBreakdown(meas({ cats: over }), NOW);
    assert.equal(b.offen, -3000);
    assert.equal(b.widerspruch, true);
    assert.deepEqual(b.segmente.map((s) => s.breite), b.segmente.map(() => 0), 'widths are suppressed');
    // the ROWS stay — the numbers are the evidence, same choice ctx.js makes for a refuted window
    assert.ok(b.segmente.find((s) => s.teil === 'offen' && s.tokens === -3000));
    assert.ok(ctxBreakdownNotes(b).some((x) => x.key === 'ctxbd.widerspruchHinweis' && x.warn === true));
  });

  it('NO WINDOW is its own state — not a window of 0, and not a contradiction', () => {
    // ctx.js:541 decides this for the whole panel: „A missing `maxTokens` leaves `win` at 0 ON PURPOSE: this
    // answer is then a measurement of the TOKENS and not of the window." The state is NAMED in the repo's own
    // suite (test/ctx.test.js, row „b) measured TOKENS but no maxTokens" with win: 0) — and the breakdown that
    // opens from exactly that gauge line used to take the 0 as a figure: identity 2 became 0 − 1 000 000, the
    // negative residue raised `widerspruch`, and the head printed „21.667 / 0" under the chip „von der CLI
    // gelesen" while the note said the CLI's numbers contradict each other. Nothing contradicted anything.
    const b = ctxBreakdown(meas({ win: 0, hasPct: false, pct: 0 }), NOW);
    assert.equal(b.ok, true, 'the rows are still worth showing — only the window half is unknown');
    assert.equal(b.hatFenster, false);
    assert.equal(b.rest, null, 'identity 2 was FORMED against a window that was never delivered');
    assert.equal(b.widerspruch, false, 'a missing window was reported as the CLI contradicting itself');
    assert.equal(b.stimmt.fenster, null, '„holds" about an identity that was not formed');
    assert.equal(b.segmente.some((s) => s.teil === 'rest'), false, 'a residue segment out of thin air');
    // IDENTITY 1 is independent of the window and stays checkable — that is the whole point of keeping the two apart
    assert.equal(b.benutztSumme, 21667);
    assert.equal(b.total, 21667);
    assert.equal(b.offen, 0);
    assert.equal(b.stimmt.gesamt, true);
    // no scale → no widths, and the painter draws no bar (asserted on the painter below)
    assert.deepEqual(b.segmente.map((s) => s.breite), b.segmente.map(() => 0));
    // what the reader gets instead: the state, in words — and NOT as a warning, because nothing is wrong
    const notes = ctxBreakdownNotes(b);
    const kf = notes.find((n) => n.key === 'ctxbd.keinFenster');
    assert.ok(kf, 'the missing window is passed over in silence');
    assert.equal(kf.warn, undefined, 'a delivered-as-designed answer is marked as a fault');
    assert.equal(notes.some((n) => n.key === 'ctxbd.restHinweis'), false);
    assert.equal(notes.some((n) => n.key === 'ctxbd.widerspruchHinweis'), false,
      '„Die gelieferten Zahlen widersprechen sich" — about an answer whose numbers are fine');
    // …and the deferred block, which never depended on a window, is unaffected
    assert.equal(b.nachladbarSumme, 90317);
  });

  it('a window that IS delivered still gets both identities, and the real contradiction still fires', () => {
    // the mirror of the test above: `widerspruch` must keep its genuine trigger. In the binary's own answer
    // builder `totalTokens = zs+Mr` while Σ(used) = zs+min(Mr,Os), so with Mr > Os the rows legitimately
    // exceed the CLI's own total — that is a contradiction and the bar is right to go.
    const over = CATS.map((c) => (c.name === 'Skills' ? { ...c, tokens: 5997 } : c));
    const b = ctxBreakdown(meas({ cats: over, win: 0 }), NOW);
    assert.equal(b.hatFenster, false);
    assert.equal(b.offen, -3000);
    assert.equal(b.widerspruch, true, 'a negative Σ(used) residue is a contradiction with or without a window');
    assert.ok(ctxBreakdownNotes(b).some((x) => x.key === 'ctxbd.widerspruchHinweis'));
    // and with a window, nothing about the normal path moved
    const n = ctxBreakdown(meas(), NOW);
    assert.equal(n.hatFenster, true);
    assert.equal(n.rest, 0);
    assert.deepEqual(n.stimmt, { gesamt: true, fenster: true });
    assert.equal(ctxBreakdownNotes(n).some((x) => x.key === 'ctxbd.keinFenster'), false);
  });

  it('a kind this panel does not know is listed, not counted', () => {
    const cats = CATS.concat([{ name: 'Something new', tokens: 999, kind: 'zukunft' }]);
    const b = ctxBreakdown(meas({ cats }), NOW);
    assert.deepEqual(b.unbekannt.map((r) => r.name), ['Something new']);
    // it is in NO part of the window: both identities still hold, so no false residue is invented either
    assert.equal(b.offen, 0);
    assert.equal(b.rest, 0);
    assert.equal(b.segmente.some((s) => s.name === 'Something new'), false);
    assert.ok(ctxBreakdownNotes(b).some((x) => x.key === 'ctxbd.unbekannteArt' && x.warn === true));
  });

  it('category NAMES are never matched on — the delivered array is what is iterated', () => {
    // the binary pushes „MCP tools", „MCP server instructions" and „Custom agents" only when non-zero, so
    // the name set is dynamic. A rename must not empty the breakdown.
    const renamed = CATS.map((c) => ({ ...c, name: 'X-' + c.name }));
    const b = ctxBreakdown(meas({ cats: renamed }), NOW);
    assert.equal(b.ok, true);
    assert.equal(b.benutztSumme, 21667);
    assert.equal(b.nachladbarSumme, 90317);
    assert.deepEqual(b.benutzt.map((r) => r.name), ['X-System prompt', 'X-System tools', 'X-Memory files', 'X-Skills']);
  });
});

describe('ctx-breakdown — freshness, because the measured value WANDERS', () => {
  it('a different GENERATION means the context is gone: nothing is shown', () => {
    // measured: the MCP block grew by 10 492 tokens between the first and the third read of ONE session
    const b = ctxBreakdown(meas({ gen: 1 }), { gen: 2, stamp: 7 });
    assert.deepEqual(b, { ok: false, grund: 'veraltet' });
  });

  it('a different STAMP shows the rows and MARKS them — hiding them would mean no breakdown mid-turn', () => {
    const b = ctxBreakdown(meas({ stamp: 7 }), { gen: 1, stamp: 9 });
    assert.equal(b.ok, true);
    assert.equal(b.bewegt, true);
    assert.ok(ctxBreakdownNotes(b).some((x) => x.key === 'ctxbd.bewegtHinweis'));
    assert.equal(ctxBreakdown(meas(), NOW).bewegt, false);
  });

  it('no measurement and no categories are two different answers', () => {
    assert.deepEqual(ctxBreakdown(null, NOW), { ok: false, grund: 'keine' });
    assert.deepEqual(ctxBreakdown(undefined, NOW), { ok: false, grund: 'keine' });
    // „the CLI answered but sent no categories" must not become „everything is one block": that would be a
    // drawing of a division nobody delivered
    assert.deepEqual(ctxBreakdown(meas({ cats: [] }), NOW), { ok: false, grund: 'keineKategorien' });
    assert.deepEqual(ctxBreakdown(meas({ cats: null }), NOW), { ok: false, grund: 'keineKategorien' });
  });

  it('never throws on junk — the payload is the CLI\'s, not ours', () => {
    for (const bad of [{ cats: [null, 7, 'x'] }, { cats: [{}] }, { tokens: 'viel', cats: CATS }, { win: null, cats: CATS }]) {
      assert.doesNotThrow(() => ctxBreakdown(meas(bad), NOW));
    }
    assert.deepEqual(ctxBreakdownNotes(null), []);
    assert.deepEqual(ctxBreakdownNotes({ ok: false }), []);
  });
});

describe('ctx-breakdown — per MCP server, and the counter-check that makes it a reading', () => {
  it('groups by serverName and hands out server names only', () => {
    const agg = ctxMcpAggregate(TOOLS, catsWithMcp(TOOL_SUM));
    assert.ok(agg);
    assert.deepEqual(agg.servers, [
      { name: 'sap-adt', tokens: 1243, toolCount: 3, loadedCount: 0 },
      { name: 'jira', tokens: 756, toolCount: 2, loadedCount: 0 },
      { name: 'snow-mcp', tokens: 355, toolCount: 1, loadedCount: 0 },
    ], 'biggest first, and no tool name anywhere in the payload');
    assert.equal(agg.tokens, TOOL_SUM);
    assert.deepEqual(agg.category, { name: 'MCP tools (deferred)', kind: 'deferred', tokens: TOOL_SUM });
    assert.equal(JSON.stringify(agg).includes('mcp__'), false, 'a full tool name reached the payload');
  });

  it('THE COUNTER-CHECK: a sum that hits no delivered category yields NOTHING', () => {
    // This is the difference from „Kontext 250 %": there, a second number was produced that could disagree
    // with the first. Here the sum has to HIT a number the CLI delivered in the same payload — and when it
    // does not, nothing is shown at all rather than a plausible-looking total.
    assert.equal(ctxMcpAggregate(TOOLS, catsWithMcp(TOOL_SUM + 1)), null);
    assert.equal(ctxMcpAggregate(TOOLS, CATS), null, 'the untouched measured categories carry 75 605, not our sum');
    assert.equal(ctxMcpAggregate(TOOLS, []), null);
    assert.equal(ctxMcpAggregate(TOOLS, null), null);
  });

  it('…and it holds for the measured sums as well — which is what made it believable', () => {
    // all three reads of the 2026-10-03 session: Σ(mcpTools.tokens) was byte-equal to „MCP tools
    // (deferred)" (75 605 · 84 291 · 86 097). Reproduced as the relation, with two servers per read.
    for (const [a, b] of [[25429, 50176], [25452, 58839], [25452, 60645]]) {
      const tools = [
        { name: 'mcp__jira__x', serverName: 'jira', tokens: a, isLoaded: false },
        { name: 'mcp__sap-adt__y', serverName: 'sap-adt', tokens: b, isLoaded: false },
      ];
      const agg = ctxMcpAggregate(tools, catsWithMcp(a + b));
      assert.ok(agg, 'the counter-check failed for ' + (a + b));
      assert.equal(agg.tokens, a + b);
      assert.deepEqual(agg.servers.map((s) => s.name).sort(), ['jira', 'sap-adt']);
    }
  });

  it('loadedCount counts what the CLI marked loaded', () => {
    // UNMEASURED in this session (all 141 tools were isLoaded:false), so it is pinned here on the field's
    // documented meaning and nowhere presented as a share of the window — the deferred tokens do not count
    // against it, so „server x takes y % of your context" would be a percentage of the wrong thing.
    const tools = [
      { name: 'mcp__a__x', serverName: 'a', tokens: 100, isLoaded: true },
      { name: 'mcp__a__y', serverName: 'a', tokens: 50, isLoaded: false },
    ];
    const agg = ctxMcpAggregate(tools, [{ name: 'MCP tools', tokens: 150, kind: 'used' }]);
    assert.deepEqual(agg.servers, [{ name: 'a', tokens: 150, toolCount: 2, loadedCount: 1 }]);
    assert.deepEqual(agg.category, { name: 'MCP tools', kind: 'used', tokens: 150 });
  });

  it('refuses what it cannot attribute, and never throws', () => {
    assert.equal(ctxMcpAggregate([], CATS), null);
    assert.equal(ctxMcpAggregate(null, CATS), null);
    // a tool whose server nobody named cannot be shown under a server
    assert.equal(ctxMcpAggregate([{ name: 'x', tokens: 5 }], [{ name: 'c', tokens: 5, kind: 'used' }]), null);
    assert.equal(ctxMcpAggregate([{ name: 'x', serverName: '', tokens: 5 }], [{ name: 'c', tokens: 5, kind: 'used' }]), null);
    // an all-zero list must not „confirm" itself against a zero-valued category
    assert.equal(ctxMcpAggregate([{ name: 'x', serverName: 'a', tokens: 0 }], [{ name: 'c', tokens: 0, kind: 'used' }]), null);
    assert.doesNotThrow(() => ctxMcpAggregate([null], CATS));
  });

  it('the breakdown passes the aggregate through, and only when it has servers', () => {
    const agg = ctxMcpAggregate(TOOLS, catsWithMcp(TOOL_SUM));
    const b = ctxBreakdown(meas({ cats: catsWithMcp(TOOL_SUM), mcp: agg }), NOW);
    assert.equal(b.mcp, agg);
    // the panel nests the block under the row the CLI's own payload names — so that name has to be there
    assert.ok(b.nachladbar.some((r) => r.name === b.mcp.category.name));
    assert.equal(ctxBreakdown(meas(), NOW).mcp, null);
    assert.equal(ctxBreakdown(meas({ mcp: { servers: [] } }), NOW).mcp, null);
  });
});

// ---------------------------------------------------------------------------------------------------
// THE VISIBLE HALF — and why it is tested by reading the painter's SOURCE
// ---------------------------------------------------------------------------------------------------
// This project has already paid for the opposite: the arithmetic was pinned, the painter was not, and a
// ONE-WORD RENAME made a feature mute while 123 tests stayed green. The panel has no DOM in its test
// environment (no dependencies, no jsdom), so the seam is the same one ctx.js uses — every decision is a
// pure function — plus the two checks below, which are about the step from the record to the screen:
//   1. every field the painter READS off the payload exists on a real payload. A rename on either side is
//      then red instead of silently `undefined` (which paints „undefined" or nothing at all).
//   2. every i18n key the painter asks for exists in the dictionary. The i18n suite cannot see these: its
//      narrow scan only matches `t('literal')`, and two of these are inside a ternary
//      (`t(s.teil === 'offen' ? … : …)`), so a typo there would print the raw key on screen.
describe('ctx-breakdown — the painter and the payload cannot drift apart', () => {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const SRC = fs.readFileSync(path.join(ROOT, 'public/js/commands.js'), 'utf8');
  // The painter, and ONLY the painter: from the first of its three functions to the next unrelated one.
  // Bounded on purpose — a scan that ran to the end of the file picked up every `s.`/`r.` in commands.js and
  // reported them as unknown row fields, i.e. a guard that cries wolf and gets deleted. Comment lines are
  // dropped too: a comment that names an old field is not a read of it.
  const FROM = SRC.indexOf('function ctxBdRow');
  const TO = SRC.indexOf('function ctxGaugeTitle');
  if (!(FROM > 0 && TO > FROM)) throw new Error('painter bounds not found — did commands.js move?');
  const painter = SRC.slice(FROM, TO).split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');

  it('the gauge really calls the panel, and the panel really exists', () => {
    // „mute by rename" in its simplest form: the click handler names a function nobody defines any more.
    assert.match(SRC, /function ctxOpenBreakdown\(/);
    assert.match(SRC, /onclick = \(\) => ctxOpenBreakdown\(/, 'the gauge no longer opens the breakdown');
    assert.match(SRC, /function ctxBdMcp\(/);
    assert.match(painter, /ctxBdMcp\(/, 'the per-server block is never painted');
    // …and the two pure seams are the ones actually used, not re-implemented in the painter
    assert.match(painter, /ctxBreakdown\(/);
    assert.match(painter, /ctxBreakdownNotes\(/);
  });

  it('with no window the painter prints no „/ 0" and draws no bar', () => {
    // The pure function can only decide; that the head and the bar FOLLOW the decision is markup, and the
    // head was the half that printed „21.667 / 0" next to the chip „von der CLI gelesen".
    assert.match(painter, /fmtNum\(bd\.total\) \+ \(bd\.hatFenster \? ' \/ ' \+ fmtNum\(bd\.fenster\) : ''\)/,
      'the head prints the window half unconditionally again');
    assert.match(painter, /if \(bd\.hatFenster && !bd\.widerspruch\) \{/, 'the bar is drawn without a scale again');
    assert.match(painter, /sect\(t\('ctxbd\.imFenster'\), bd\.hatFenster \? bd\.fenster : null\)/,
      'the „Im Fenster" heading carries a window figure that was not delivered');
  });

  it('every payload field the painter reads exists on a real payload', () => {
    const agg = ctxMcpAggregate(TOOLS, catsWithMcp(TOOL_SUM));
    const okRec = ctxBreakdown(meas({ cats: catsWithMcp(TOOL_SUM), mcp: agg }), NOW);
    const notOk = ctxBreakdown(null, NOW);
    const bdKeys = new Set([...Object.keys(okRec), ...Object.keys(notOk)]);
    const bad = [...painter.matchAll(/\bbd\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]).filter((k) => !bdKeys.has(k));
    assert.deepEqual([...new Set(bad)], [], 'the painter reads bd.<field> that no payload has');
    // the row/segment/server objects, as one union: they share name/tokens, and the fields that are not
    // shared (teil/breite · toolCount/loadedCount) are exactly the ones a rename would silence
    const rowKeys = new Set([...Object.keys(okRec.segmente[0]), ...Object.keys(okRec.nachladbar[0]), ...Object.keys(agg.servers[0])]);
    const badRow = [...painter.matchAll(/\b[sr]\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
      .filter((k) => !rowKeys.has(k) && !['appendChild', 'style', 'title', 'teil'].includes(k));
    assert.deepEqual([...new Set(badRow)], [], 'the painter reads a row field that no row has');
    // the MCP block and the notes
    const mcpKeys = new Set(Object.keys(agg));
    const badMcp = [...painter.matchAll(/\bmcp\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]).filter((k) => !mcpKeys.has(k));
    assert.deepEqual([...new Set(badMcp)], [], 'the painter reads mcp.<field> that the aggregate has not');
    const noteKeys = new Set(['key', 'num', 'text', 'warn']);
    const notes = ctxBreakdownNotes(ctxBreakdown(meas({ cats: CATS.map((c) => (c.name === 'Skills' ? { ...c, tokens: 2497 } : c)) }), { gen: 1, stamp: 9 }));
    assert.ok(notes.length >= 3, 'the note fixture must produce several sentences');
    for (const n of notes) for (const k of Object.keys(n)) assert.ok(noteKeys.has(k), 'a note carries an unknown field: ' + k);
    const badNote = [...painter.matchAll(/\bn\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]).filter((k) => !noteKeys.has(k));
    assert.deepEqual([...new Set(badNote)], [], 'the painter reads a note field that no note has');
  });

  it('every ctxbd.* key the painter and the notes ask for is in the dictionary', () => {
    const dict = fs.readFileSync(path.join(ROOT, 'public/js/i18n.js'), 'utf8');
    const used = new Set();
    for (const file of ['public/js/commands.js', 'public/js/ctx-breakdown.js']) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
      for (const m of text.matchAll(/'(ctxbd\.[\w.-]+)'/g)) used.add(m[1]);
    }
    assert.ok(used.size >= 15, 'only ' + used.size + ' keys found — did the painter stop using them?');
    const missing = [...used].filter((k) => !dict.includes("'" + k + "':"));
    assert.deepEqual(missing, [], 'keys the UI asks for and the dictionary does not define');
    // …and the one sentence that is deliberately SHARED with the gauge tooltip rather than duplicated
    assert.match(fs.readFileSync(path.join(ROOT, 'public/js/ctx-breakdown.js'), 'utf8'), /commands\.kontextGrenzeLautCli/);
  });
});

describe('ctx-breakdown — the aggregate the ROUTE builds is the one tested here', () => {
  it('lib/chat.js uses the shared function instead of its own grouping', () => {
    // The aggregation has to live server-side (11 236 bytes of tool names must not go into every tab), and
    // the logic has to live in a file Node and the browser share — otherwise the two drift. This pins that
    // lib/chat.js really calls it and did not grow a second copy.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib/chat.js'), 'utf8');
    assert.match(src, /require\('\.\.\/public\/js\/ctx-breakdown'\)/);
    assert.match(src, /mcp: ctxMcpAggregate\(/);
    // The claim is „no second copy of the aggregation", NOT „the word serverName never occurs": since G4,
    // lib/chat.js legitimately SENDS `serverName` as a field of `mcp_toggle`/`mcp_reconnect`, which has
    // nothing to do with grouping context tokens. A bare /serverName/ guard turned red on that merge and
    // would have been „fixed" by deleting the MCP request field — the assertion has to name the thing it
    // actually forbids: READING the property off a tool row, and the reduce/Map that would follow it.
    const code = src.replace(/\/\/.*$/gm, '');
    assert.equal(/\.serverName\b/.test(code), false, 'lib/chat.js reads tool.serverName — that is the shared function\'s job');
    assert.equal(/serverName\s*\]/.test(code), false, 'lib/chat.js indexes by serverName — same second copy, written differently');
    // …and the field it IS allowed to use, pinned so the two cannot be confused later.
    assert.match(code, /subtype: 'mcp_toggle', serverName: String\(name\)/);
  });
});

// The BAR, as the one part of the drawing a unit test can still check: „frei" used to be painted in --panel-2,
// which is the bar's own TRACK colour — 1,00:1. So the segment was invisible, and a stretch the bar does NOT
// account for looked exactly like free space the CLI had reported. Same failure class as everything above,
// only drawn instead of written. The ratio is computed here rather than asserted in prose, because prose is
// what the old inset outline had going for it — and that outline measured 1,01:1 in the dark theme.
describe('ctx breakdown — die Leiste sagt „frei" sichtbar', () => {
  const fs = require('fs');
  const path = require('path');
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public/styles.css'), 'utf8');
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
  const ratio = (a, b) => { const x = L(a) + 0.05, y = L(b) + 0.05; return Math.max(x, y) / Math.min(x, y); };
  // Declarations in source order: [0] = :root (dark), [1] = prefers-color-scheme light, [2] = data-theme light.
  const werte = (name) => [...CSS.matchAll(new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{6})', 'g'))].map((m) => m[1].toLowerCase());

  it('das Segment ist nicht das Gleis — und hält 3:1 in allen drei Token-Blöcken', () => {
    assert.match(CSS, /\.bd-bar \.bd-frei \{ background: var\(--bd-frei\); \}/, 'das Segment malt nicht (mehr) über das eigene Token');
    const frei = werte('bd-frei');
    const gleis = werte('panel-2');
    assert.equal(frei.length, 3, '--bd-frei fehlt in einem der drei Token-Blöcke (dunkel · auto-hell · hell) — dann erbt ein Thema die Unsichtbarkeit zurück');
    assert.equal(gleis.length, 3, '--panel-2 steht nicht in drei Blöcken — die Paarung unten wäre dann willkürlich');
    frei.forEach((f, i) => {
      assert.notEqual(f, gleis[i], 'Block ' + i + ': frei ist wieder das Gleis (' + f + ')');
      const r = ratio(f, gleis[i]);
      assert.ok(r >= 3, 'Block ' + i + ': frei ' + f + ' gegen Gleis ' + gleis[i] + ' nur ' + r.toFixed(2) + ':1 — WCAG 1.4.11 verlangt 3:1 für eine Fläche, die eine Menge trägt');
    });
  });
});
