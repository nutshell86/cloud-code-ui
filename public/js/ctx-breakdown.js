'use strict';
// The context BREAKDOWN — where the context goes, per category and per MCP server. Pure logic, shared by
// the browser (classic script) and Node (lib/chat.js requires the aggregation, test/ctx-breakdown.test.js
// requires all of it). No t()/tt(), no DOM: this file returns payloads (ctx.js / open-points.js spirit).
//
// WHY A SEPARATE FILE FROM ctx.js: ctx.js answers ONE question — which window, which model, may it be
// called measured — and its table asserts the whole record per row. The breakdown asks a different one
// (how does the measured total DIVIDE UP) and must not be able to move the gauge's numbers. Two files,
// one direction of dependency: the breakdown reads what the measurement already carries and computes no
// window, no percentage and no token total of its own.
//
// THE RULE THIS FILE EXISTS TO HOLD. The numbers are READ, not recomputed — the CLI delivers `percentage`,
// `totalTokens`, `maxTokens` and the categories itself. A second, self-computed number can contradict the
// first, and that is exactly how „Kontext 250 % · 500,8K / 200,0K" came about. So the only arithmetic here
// is SUBTRACTION FOR THE VISIBLE RESIDUE: whatever the delivered rows do not account for becomes a row of
// its own („Rest" / „nicht zugeordnet"), never a silent redistribution.
//
// MEASURED 2026-10-03 (free, CLI 2.1.288, control requests only — C:/Users/you/ccui-ctxprobe/
// ctx-probe.js, raw answer ctx-probe-result.json; three reads of one session). Everything below is pinned
// to that payload:
//
//  · `categories` carries 8 rows of { name, tokens, color, kind } (+ `isDeferred: true` on the deferred
//    ones, which `kind` already says). `kind` is one of four values the CLI sets itself: used · deferred ·
//    buffer · free. The NAMES are dynamic and conditional (the binary pushes „MCP tools", „MCP server
//    instructions" and „Custom agents" only `if (x > 0)`, and none of those three appeared in this run), so
//    nothing here matches on a category NAME — it iterates the delivered array and groups by `kind`.
//
//  · TWO ARITHMETIC IDENTITIES held EXACTLY in all three reads, and they are what makes a READ breakdown
//    checkable against a number the CLI itself delivered:
//        Σ(kind === 'used')                     === totalTokens   (21 667 === 21 667)
//        Σ(used) + Σ(buffer) + Σ(free)          === maxTokens     (21 667 + 33 000 + 945 333 === 1 000 000)
//    They are not assumed: both residues are computed and SHOWN when they are not zero (see `offen` and
//    `rest` below). A breakdown that quietly distributed the difference would be the claim this panel is
//    not allowed to make.
//
//  · AND THE TRAP, which is this project's failure class on the category axis: `deferred` lies OUTSIDE both
//    identities — it is in neither `totalTokens` nor „Free space". Stacking all eight rows as shares of the
//    gauge gives 21 667 + 90 317 + 33 000 + 945 333 = 1 090 317 of 1 000 000 = 109 %. That is „250 % ·
//    500,8K / 200,0K" again, one axis over. The deferred rows are the BIGGEST single item (90 317 tokens)
//    and must be visible, but they are reported separately as „would cost if loaded" and never as part of
//    the bar — `segmente` holds what is in the window, `nachladbar` what is not.
//
//  · the „Autocompact buffer" row is NOT 10 % of the window (fake-claude.js computed that, which would be
//    100 000 here): it measured 33 000 = maxTokens − autoCompactThreshold (1 000 000 − 967 000). Nothing
//    here derives it — the row is read.

// ---------------------------------------------------------------------------------------------------
// 1. PER MCP SERVER — the aggregation, with its own counter-check inside the same payload
// ---------------------------------------------------------------------------------------------------
// `mcpTools` is a flat array, one entry per MCP tool: { name, serverName, tokens, isLoaded }. 141 entries
// and 11 236 bytes in the measured session, which is why this runs in lib/chat.js and not in the browser:
// the route exists so the 38 KB answer does not go into every tab, and the full TOOL names never leave the
// server (one of them, `mcp__…`, is also what test/integration.test.js watches for).
//
// WHAT MAKES THIS A READING AND NOT A CLAIM: in all three measured reads Σ(mcpTools.tokens) was BYTE-EQUAL
// to the delivered category value — 75 605 / 84 291 / 86 097, each matching „MCP tools (deferred)" exactly.
// So the sum has a counter-check in the SAME payload, and this function refuses to hand out anything when
// the check fails (returns null). That is the difference from „Kontext 250 %": there a second number was
// produced that could disagree with the first; here the sum has to HIT a delivered number or nothing is
// shown at all.
// The category is found by its VALUE, deliberately not by its name: the name („MCP tools (deferred)") is
// one of several the binary can emit, and hard-coding it would make the feature silently vanish on a
// session whose MCP tools are loaded rather than deferred — while matching the value keeps the proof.
// `tokens > 0` is required for that match: with an all-zero tool list every zero-valued category would
// „confirm" the sum.
// THE ONE WEAKNESS OF MATCHING BY VALUE, named rather than hidden: if two categories happened to carry the
// SAME token count, the first one wins and the panel would nest the server rows under the wrong row. The
// numbers stay right — only the heading above them would be — and the alternative (matching the name
// „MCP tools (deferred)") trades that for a feature that vanishes silently as soon as the CLI picks one of
// the other names it can emit. A misplaced heading is the cheaper failure.
// → { servers: [{ name, tokens, toolCount, loadedCount }], tokens, category: { name, kind, tokens } } | null
function ctxMcpAggregate(mcpTools, categories) {
  if (!Array.isArray(mcpTools) || !mcpTools.length) return null;
  const by = new Map();
  for (const tool of mcpTools) {
    if (!tool || typeof tool !== 'object') return null;
    const name = String(tool.serverName == null ? '' : tool.serverName);
    if (!name) return null;      // a tool whose server nobody named cannot be shown under a server
    const e = by.get(name) || { name, tokens: 0, toolCount: 0, loadedCount: 0 };
    e.tokens += Math.max(0, Number(tool.tokens) || 0);
    e.toolCount++;
    if (tool.isLoaded === true) e.loadedCount++;
    by.set(name, e);
  }
  // biggest first — the question „where does my context go" is answered top-down; name as the tie-break so
  // the order is stable across reads (two servers with equal weight must not swap between two panels).
  const servers = [...by.values()].sort((a, b) => (b.tokens - a.tokens) || (a.name < b.name ? -1 : 1));
  const tokens = servers.reduce((a, s) => a + s.tokens, 0);
  if (!(tokens > 0)) return null;
  const cats = Array.isArray(categories) ? categories : [];
  const cat = cats.find((c) => c && typeof c === 'object' && Number(c.tokens) === tokens);
  if (!cat) return null;         // the sum hits no delivered number → nothing is shown (see above)
  return {
    servers,
    tokens,
    category: { name: String(cat.name == null ? '' : cat.name), kind: String(cat.kind == null ? '' : cat.kind), tokens },
  };
}

// ---------------------------------------------------------------------------------------------------
// 2. THE BREAKDOWN — the payload the panel paints
// ---------------------------------------------------------------------------------------------------
// `meas` is the stored measurement, exactly as ctx.js ctxFromRoute returns it plus the generation and the
// stamp ctxProbe captured at ASK time: { tokens, win, raw, pct, hasPct, hasTok, source, cats, mcp, gen,
// stamp, at }.
// `now` is the tab's CURRENT freshness: { gen, stamp } — compared with `===`, the same rule ctx.js uses, so
// a counter that is reset can only ever make them DIFFER (the safe direction).
//
// WHY FRESHNESS BELONGS HERE AT ALL: the measured value WANDERS. Between the first and the third read of
// the same session the MCP block grew by 10 492 tokens because servers were still coming up (github,
// playwright, ui5, sap-flp, ha-mcp stood at „pending" during the first read). Two breakdowns of one chat can
// legitimately show different sums, so a breakdown without its freshness claims a stability that does not
// exist — and ctx.js already carries the right instrument (`_ctxGen` / `ctxStamp`).
//   · a different GENERATION means the context this answer describes is gone (a model switch, /clear, a
//     compaction, a restart): nothing is shown, `grund: 'veraltet'`, and the caller re-asks.
//   · a different STAMP means newer `assistant` frames have arrived since: the rows are still the last real
//     measurement, so they ARE shown and marked (`bewegt: true`) rather than hidden. Hiding them would mean
//     no breakdown is ever available mid-turn, which is when the question is asked.
// → { ok: false, grund } · or { ok: true, … } (see the fields at the end)
function ctxBreakdown(meas, now) {
  const m = (meas && typeof meas === 'object') ? meas : null;
  const n = (now && typeof now === 'object') ? now : {};
  if (!m) return { ok: false, grund: 'keine' };
  if ((Number(m.gen) || 0) !== (Number(n.gen) || 0)) return { ok: false, grund: 'veraltet' };
  const cats = Array.isArray(m.cats) ? m.cats.filter((c) => c && typeof c === 'object') : [];
  const total = Math.max(0, Number(m.tokens) || 0);
  const fenster = Math.max(0, Number(m.win) || 0);
  // NO WINDOW IS ITS OWN STATE, not a window of 0 — and ctx.js:541 decides this explicitly: „A missing
  // `maxTokens` leaves `win` at 0 ON PURPOSE: this answer is then a measurement of the TOKENS and not of the
  // window, and ctxDecide keeps those two apart." The first version of this file did not hold that line: it
  // took 0 as a real figure, formed identity 2 against it (rest = 0 − 1 000 000), raised `widerspruch` from
  // the negative result and let the head print „21.667 / 0". Both halves were a claim about the CLI that is
  // false here — nothing contradicts itself, there simply was no window. `widerspruch` has a REAL trigger
  // too (the binary's own `totalTokens = zs+Mr` against Σ(used) = zs+min(Mr,Os) can legitimately overfill),
  // and that is precisely why it must not also fire for „no window": the warning could then no longer tell
  // „the CLI overfilled" from „no window was delivered". Same rule the line beside it already follows for
  // `pct`: an unknown ratio is ABSENT, not 0.
  const hatFenster = fenster > 0;
  // No categories at all → there is nothing to break down, and inventing rows from the two scalars
  // („everything is one block") would be a drawing of a number nobody delivered.
  if (!cats.length) return { ok: false, grund: 'keineKategorien' };

  const row = (c) => ({
    name: String(c.name == null ? '' : c.name),
    tokens: Math.max(0, Number(c.tokens) || 0),
    kind: String(c.kind == null ? '' : c.kind),
  });
  const ofKind = (k) => cats.filter((c) => String(c.kind) === k).map(row);
  const sum = (rows) => rows.reduce((a, r) => a + r.tokens, 0);
  const benutzt = ofKind('used');
  const puffer = ofKind('buffer');
  const frei = ofKind('free');
  const nachladbar = ofKind('deferred');
  // Anything the CLI labelled with a kind this file does not know. It is NOT silently dropped and not
  // silently counted: an unknown kind cannot be placed in the window (is it used? is it free?), so it is
  // listed for what it is. A future CLI that adds a fifth kind then shows up as a visible row instead of
  // as a quietly wrong bar.
  const KINDS = ['used', 'buffer', 'free', 'deferred'];
  const unbekannt = cats.filter((c) => KINDS.indexOf(String(c.kind)) < 0).map(row);

  // IDENTITY 1 — Σ(used) === totalTokens. The difference is a ROW, so a context the categories do not fully
  // explain says so instead of looking complete. Signed on purpose: a negative value (the rows claim more
  // than the CLI's own total) is a contradiction and must be readable as one, not clamped to 0.
  const benutztSumme = sum(benutzt);
  const offen = total - benutztSumme;
  // IDENTITY 2 — Σ(used) + buffer + free === maxTokens. Measured against the SEGMENTS, i.e. including the
  // residue above, so the bar's parts add up to the window exactly by construction.
  const pufferSumme = sum(puffer);
  const freiSumme = sum(frei);
  const segmente = benutzt.map((r) => ({ ...r, teil: 'benutzt' }));
  if (offen !== 0) segmente.push({ name: '', tokens: offen, kind: 'used', teil: 'offen' });
  puffer.forEach((r) => segmente.push({ ...r, teil: 'puffer' }));
  frei.forEach((r) => segmente.push({ ...r, teil: 'frei' }));
  // …and identity 2 is only FORMED when there is a window to form it against. `null`, not 0: „not checkable"
  // and „checked, came out zero" are different answers, and the note below must not fire for the first.
  const rest = hatFenster ? fenster - (benutztSumme + offen + pufferSumme + freiSumme) : null;
  if (rest) segmente.push({ name: '', tokens: rest, kind: '', teil: 'rest' });

  // The bar is only drawn while every segment is drawable. A negative residue means the delivered numbers
  // contradict each other (the parts exceed the window, or the rows exceed the CLI's own total) — and a bar
  // cannot show that, it can only hide it. So the rows stay, with their signed numbers, and the bar goes:
  // same choice ctx.js makes when the frames refute a window (the number that cannot be true is not drawn).
  const widerspruch = segmente.some((s) => s.tokens < 0);
  const breite = (tok) => (hatFenster && !widerspruch ? Math.max(0, tok) / fenster * 100 : 0);
  segmente.forEach((s) => { s.breite = breite(s.tokens); });

  return {
    ok: true,
    // the three scalars are COPIES of what the CLI delivered — this file never recomputes them
    total, fenster, hatFenster, pct: m.hasPct ? Math.max(0, Number(m.pct) || 0) : null,
    quelle: String(m.source || ''),           // autocompactSource: WHY that is the 100 % line, in the CLI's word
    // „the rows are the last measurement, newer frames have arrived since" — shown, and marked
    bewegt: (Number(m.stamp) || 0) !== (Number(n.stamp) || 0),
    at: Number(m.at) || 0,                    // when WE received it (our clock, not a CLI number)
    segmente,                                 // what is IN the window, in bar order, summing to it exactly
    benutzt, puffer, frei, unbekannt,
    benutztSumme, pufferSumme, freiSumme,
    // …and what is NOT in the window: nachladbar is the biggest item of all and the one that produced 109 %
    // when it was stacked into the bar. Reported on its own, never as a share of the gauge.
    nachladbar, nachladbarSumme: sum(nachladbar),
    offen, rest, widerspruch,
    // `fenster: null` = not checkable, because no window was delivered. Saying `true` there would report a
    // held identity that was never formed.
    stimmt: { gesamt: offen === 0, fenster: hatFenster ? rest === 0 : null },
    // per MCP server, only when the route's counter-check held (ctxMcpAggregate). The row it belongs under
    // is named by the CLI itself, so the panel nests it by NAME MATCH instead of by a hard-coded category.
    mcp: (m.mcp && typeof m.mcp === 'object' && Array.isArray(m.mcp.servers) && m.mcp.servers.length) ? m.mcp : null,
  };
}

// The breakdown's own sentences, as i18n KEYS in order — the same seam ctx.js ctxTitleLines uses, and for
// the same reason: the step from the record to the words is where two wrong sentences hid last time.
//   { key }            — a plain sentence
//   { key, num }       — a number the caller formats in its locale
//   { key, text }      — a string the CLI itself used, appended verbatim (autocompactSource)
//   { warn: true }     — prefix „⚠"
function ctxBreakdownNotes(bd) {
  const b = (bd && typeof bd === 'object') ? bd : {};
  const out = [];
  if (!b.ok) return out;
  // The two identities, in the order a reader needs them: first „do the rows explain the total", then „do
  // the parts fill the window". Silence when they hold — a panel that says „stimmt" on every normal read
  // trains the eye to skip the line where it finally does not.
  if (b.offen) out.push({ key: 'ctxbd.offenHinweis', num: b.offen, warn: true });
  if (b.rest) out.push({ key: 'ctxbd.restHinweis', num: b.rest, warn: true });
  // „zeigen statt verstecken" for the missing window: identity 2 was not formed, and the panel says why
  // instead of leaving the reader to wonder where the second number went. NOT a warning — nothing is wrong,
  // the answer measured the tokens and not the window (ctx.js:541).
  if (!b.hatFenster) out.push({ key: 'ctxbd.keinFenster' });
  if (b.widerspruch) out.push({ key: 'ctxbd.widerspruchHinweis', warn: true });
  if (b.unbekannt && b.unbekannt.length) out.push({ key: 'ctxbd.unbekannteArt', warn: true });
  if (b.nachladbarSumme > 0) out.push({ key: 'ctxbd.nachladbarHinweis', num: b.nachladbarSumme });
  if (b.bewegt) out.push({ key: 'ctxbd.bewegtHinweis' });
  // the SAME key the gauge's tooltip uses for this sentence (ctx.js ctxTitleLines): it says the same thing
  // about the same field, and two keys with one meaning drift apart on the next edit
  if (b.quelle) out.push({ key: 'commands.kontextGrenzeLautCli', text: b.quelle });
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ctxMcpAggregate, ctxBreakdown, ctxBreakdownNotes };
}
