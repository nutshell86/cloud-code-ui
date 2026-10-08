'use strict';
// Matching for the Strg+K palette — browser (classic script) AND Node (require'd by test/palette.test.js).
// Dependency-free and side-effect-free (ctx.js / turn-end.js spirit): no t()/tt(), no DOM.
//
// WHY: H5. Two separate German defects sat in `cmdkScore`/`cmdkCommands` (commands.js).
//
//  1. Nine palette entries carried HARDCODED ENGLISH labels — „Gehe zu Settings", „Gehe zu Memory",
//     „Gehe zu Token Usage" — in a panel whose navigation says „Einstellungen", „Speicher", „Nutzung &
//     Kosten". So the one search box that is supposed to find anything could not be reached with the
//     word that is on the screen. The view list lives here as (viewId, i18n key) pairs now; there is no
//     English literal left to go stale. The list was also INCOMPLETE — „Läufe" (view-agents) existed in
//     the nav and not in the palette at all.
//
//  2. `h.indexOf(q)` after `toLowerCase()` is not a German search. „laufe" does not find „Läufe",
//     „zuruck" does not find „Zurück", „Grosse" does not find „Große" — and typing the umlaut is exactly
//     what somebody reaching for a keyboard-only palette does NOT do. Both spellings a German keyboard
//     produces have to hit: the diacritic itself („läufe") and the digraph substitute („laeufe").
//     paletteVariants() therefore offers the haystack in BOTH shapes, and the query is folded once.
//
// What must NOT be translated: the labels that come out of DATA — a session title, a saved prompt, a
// UI-skill title, a slash command, an MCP tool name. Those are the user's own words or the CLI's, and
// running them through a dictionary would at best do nothing and at worst rename them in the list while
// leaving them unchanged everywhere else. The split is explicit: PALETTE_VIEWS holds keys and
// commands.js resolves them with t(); a data label is passed through untouched, and
// test/palette.test.js checks both halves against the real i18n.js and the real commands.js.

// Every view the shell has, with the i18n key its own nav button uses — one wording for the nav and for
// the palette, and a renamed view cannot drift apart from its palette entry.
var PALETTE_VIEWS = [
  ['chat', 'html.chat'],
  ['sessions', 'html.sitzungen'],
  ['projects', 'html.projekte'], // P-1 — directly under „Sitzungen", as in the nav
  // KEINE Zeile für `agents`/„Läufe". Die Ansicht ist in PR #66 entfernt worden, und `html.laeufe` steht
  // nicht mehr im Wörterbuch. Der erste Entwurf dieser Liste hatte sie — gebaut gegen einen `main`-Stand,
  // der sie noch kannte — und hätte in der Palette „html.laeufe" als ROHEN Schlüssel angeboten, mit einem
  // Sprung auf eine Ansicht, die es nicht gibt. Gefunden hat das die Zusicherung im Test beim Merge, nicht
  // das Durchlesen; genau dafür wird die Liste gegen index.html geprüft statt geglaubt.
  ['usage', 'html.nutzungKosten'],
  ['settings', 'html.einstellungen'],
  ['mcp', 'html.mcpPlugins'],
  ['skills', 'html.skills'],
  ['uiskills', 'html.uiSkills'],
  ['memory', 'html.speicher'],
  ['system', 'common.system'],
];

// ä→a, ö→o, ü→u, ß→ss, é→e. NFD splits a letter into base + combining mark, and the mark range
// U+0300–U+036F is then dropped — so this also covers the accented characters an English or French
// entry name brings along, not just the three German umlauts.
function paletteFold(s) {
  var t = String(s == null ? '' : s).toLowerCase().replace(/ß/g, 'ss');
  // `\p{M}` (any combining mark) rather than a literal U+0300–U+036F range: a bare range of invisible
  // characters is unreadable in a diff and would be destroyed by a careless re-encode of this file —
  // after which the fold would silently stop folding. Same `u`-flag style as the initials match below.
  if (t.normalize) t = t.normalize('NFD').replace(/\p{M}/gu, '');
  return t;
}
// The second spelling: the digraph a German keyboard falls back to. „Läufe" → „laeufe", so a query typed
// without umlauts hits either way. Returned as its own string rather than merged into one canonical form
// on purpose — collapsing „ue" to „u" would make „neue" match „nu" and every such match would be noise.
function paletteFoldDigraph(s) {
  var t = String(s == null ? '' : s).toLowerCase().replace(/ß/g, 'ss');
  if (t.normalize) t = t.normalize('NFC');
  return t.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue');
}
function paletteVariants(s) {
  var a = paletteFold(s), b = paletteFoldDigraph(s);
  return a === b ? [a] : [a, b];
}

// Three tiers, best first: substring (earlier = better) → word initials → subsequence. Unchanged from
// A19's cmdkScore except that it now works on folded text and takes the best of the two spellings.
// `hay` is the RAW label — folding happens in here, so no caller can forget it.
function paletteScore(hay, q) {
  var query = paletteFold(q);
  if (!query) return 1;
  var forms = paletteVariants(hay), best = 0;
  for (var v = 0; v < forms.length; v++) {
    var h = forms[v];
    var s = 0;
    var i = h.indexOf(query);
    if (i >= 0) s = 100 - Math.min(i, 40);
    else {
      // initials of the folded form, so „gz" still finds „Gehe zu …" and „nk" finds „Nutzung & Kosten"
      var words = h.match(/[\p{L}\p{N}]+/gu) || [];
      var initials = words.map(function (w) { return w[0]; }).join('');
      if (initials.indexOf(query) >= 0) s = 60;
      else {
        var k = 0;
        for (var j = 0; j < h.length && k < query.length; j++) if (h[j] === query[k]) k++;
        if (k === query.length) s = 30;
      }
    }
    if (s > best) best = s;
  }
  return best;
}
// What renderCmdk ranks by: the label matters more than the drawer it sits in, which is why a group/hint
// hit is worth 5 less. Here so the two scoring calls cannot drift apart.
function paletteRank(entry, q) {
  if (!entry) return 0;
  var byLabel = paletteScore(entry.label, q);
  var byMeta = paletteScore((entry.group || '') + ' ' + (entry.hint || ''), q) - 5;
  return Math.max(byLabel, byMeta);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PALETTE_VIEWS, paletteFold, paletteFoldDigraph, paletteVariants, paletteScore, paletteRank };
}
