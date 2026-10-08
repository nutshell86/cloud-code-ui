'use strict';
// Shared UI-skill result channel — browser (classic script) AND Node (require'd by lib/engine.js,
// server.js). Keep this file dependency-free and side-effect-free (pure.js spirit); no t()/DOM here.
// A skill's prompt instructs Claude to emit ONE fenced ```ui-result block with JSON:
//   { "summary": "...", "stats": [{"label","value","tone"}], "groups": [{"id","label","note","tone","open"}],
//     "columns": [{"id","label","type","linkBase","tones"}|"Name", ...], "rows": [[...], ...] }
// uiResultExtract parses the LAST valid block; uiResultFromPattern is the legacy regex fallback
// (moved here so browser + headless engine share one implementation).
//
// Column TYPES carry a layout role, not just a format (added 2026-08-27 for long grouped results):
//   text|link|badge|number → a normal table cell
//   group                  → NOT a cell: its value buckets the row into a collapsible section
//   detail                 → NOT a cell: rendered as a wrapped secondary line under the row
//   expand                 → a cell whose string value is only the TEXT FALLBACK (exports, search,
//                            history compare); with an `expand[]` entry for the row it renders a
//                            toned chip strip + a ▸ toggle that opens a side-by-side panel under the row
// So a 100-action sync plan reads as ~8 sections of short rows instead of one flat wall of table.
//
// Expandable rows (added 2026-09-15 for /sync-acme-proj — "where exactly is this pair out of sync?"):
//   "expand": [{ "row": 0, "open": true, "sides": ["PROJ-1", "ACME-2"],
//                "rows": [{ "label": "Kommentare", "short": "Kmt", "left": "4", "mark": "◀ 3", "right": "12",
//                           "tone": "warn", "note": "…", "items": [{ "side": "left|right|both", "text": "…", "mark": "◀ G3", "tone": "warn" }] }],
//                "notes": ["…"] }]
// `row` = index into rows (must exist, unique). Only `rows[].tone` feeds the confirmTones arming — item
// tones are decoration. The panel needs no `expand` column (the toggle then sits in the first cell).
// Instead of inline `expand`, a block may carry `"expandSrc": "<absolute path to a .json file>"` whose
// content is `{ "expand": [...] }` — the browser fetches it via GET /api/uiskill/result-file (served
// only from inside a registered UI-skill run.cwd, see lib/result-file.js) and the run history gets the
// resolved data at persist time. Saves the model from typing ~70 KB of panel data per sync run.

// normalized shape:
// { source:'block'|'regex', summary:'', columns:[{id,label,type,linkBase?,tones?,sides?,legend?}], rows:[[string,…]],
//   stats?:[{label,value,tone?}], groups?:[{id,label,note?,tone?,open?}],
//   expand?:[{row,open?,sides?,rows:[{label,short?,left,right,mark,tone?,note?,items?}],notes?}], expandSrc?:'<abs path>' }
var UI_RESULT_TYPES = ['text', 'link', 'badge', 'number', 'group', 'detail', 'expand'];
var UI_RESULT_TONES = ['ok', 'warn', 'err', 'info', 'muted'];
var UI_RESULT_SIDES = ['left', 'right', 'both'];
// `detail` cells carry a whole sentence of reasoning → a wider cap than ordinary cells.
// x* = caps inside an `expand[]` entry (dimension rows, line items, side labels, notes).
var UI_RESULT_CAPS = { rows: 500, columns: 12, cell: 500, detail: 1200, summary: 300, stats: 10, groups: 30, label: 80, note: 160, tones: 40, digest: 80,
  xrows: 12, xitems: 30, xtext: 240, xval: 120, xlabel: 40, xshort: 16, xnote: 240, xnotes: 6, xside: 24, xsrc: 400 };

// the block is model-authored → untrusted: hrefs only ever come from https?:// values
function uiResultSafeUrl(v) { return /^https?:\/\//i.test(String(v || '')) ? String(v) : ''; }
// …and every other model-authored string is length-capped + coerced before it reaches the DOM.
// A capped value ends in "…" so a truncated detail line is visibly truncated instead of silently cut.
function uiResultStr(v, max) {
  if (v == null) return '';
  var s = String(v);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
function uiResultTone(v) { return UI_RESULT_TONES.indexOf(String(v == null ? '' : v)) >= 0 ? String(v) : ''; }

// badge column → { "<cell value>": "ok|warn|err|info|muted" }; unknown tones are dropped, not guessed.
// A key may use `*` as a wildcard — see uiResultToneFor for why that is not a nicety.
function uiResultTones(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  var keys = Object.keys(o).slice(0, UI_RESULT_CAPS.tones);
  var out = null;
  for (var i = 0; i < keys.length; i++) {
    var tn = uiResultTone(o[keys[i]]);
    if (tn) { if (!out) out = {}; out[uiResultStr(keys[i], UI_RESULT_CAPS.label)] = tn; }
  }
  return out;
}

// Cell value → tone. Exact key wins; then keys containing `*` are tried as patterns, in DECLARATION
// order (JSON preserves it), first match wins; `''` when nothing matches.
// Why patterns exist: a badge that carries a count and a direction ("7 Kmt. → PROJ · 2 Kmt. → ACME")
// can never be hit exactly, yet it is precisely the cell that must go red — ACME is the customer.
// Without this, colour was only available to closed vocabularies, so /sync-acme-proj had to choose
// between an informative cell and a coloured one. Everything except `*` is escaped: a tone key is
// model- or script-authored and must not be able to inject a regex.
function uiResultToneFor(col, value) {
  var tones = col && col.tones;
  if (!tones) return '';
  var s = String(value == null ? '' : value).trim();
  if (Object.prototype.hasOwnProperty.call(tones, s)) return tones[s]; // an explicit "" key still works
  if (!s) return '';                                                   // …but a catch-all `*` must not colour an empty cell
  var keys = Object.keys(tones);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf('*') < 0) continue;
    var parts = keys[i].split('*');
    for (var p = 0; p < parts.length; p++) parts[p] = parts[p].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try { if (new RegExp('^' + parts.join('.*') + '$').test(s)) return tones[keys[i]]; } catch (e) { /* unusable key → skip */ }
  }
  return '';
}

// head strip of KPI chips ("33 Paare", "100 Aktionen") — the numbers you want before reading any row
function uiResultStats(a) {
  if (!Array.isArray(a)) return [];
  var out = [];
  for (var i = 0; i < a.length && out.length < UI_RESULT_CAPS.stats; i++) {
    var s = a[i];
    if (s == null) continue;
    if (typeof s !== 'object' || Array.isArray(s)) { out.push({ label: uiResultStr(s, UI_RESULT_CAPS.label), value: '' }); continue; }
    var st = { label: uiResultStr(s.label, UI_RESULT_CAPS.label), value: uiResultStr(s.value, UI_RESULT_CAPS.label) };
    if (!st.label && !st.value) continue;
    var tn = uiResultTone(s.tone);
    if (tn) st.tone = tn;
    out.push(st);
  }
  return out;
}

// section metadata for the `group` column: fixes the ORDER, adds label/note/tone, `open:true` = expanded
function uiResultGroups(a) {
  if (!Array.isArray(a)) return [];
  var out = [];
  var seen = {};
  for (var i = 0; i < a.length && out.length < UI_RESULT_CAPS.groups; i++) {
    var g = a[i];
    if (g == null) continue;
    var o = (typeof g === 'object' && !Array.isArray(g)) ? g : { id: g };
    var id = uiResultStr(o.id != null ? o.id : o.label, UI_RESULT_CAPS.label);
    if (!id || seen[id]) continue;
    seen[id] = 1;
    var grp = { id: id, label: uiResultStr(o.label != null ? o.label : id, UI_RESULT_CAPS.label) };
    var note = uiResultStr(o.note, UI_RESULT_CAPS.note);
    if (note) grp.note = note;
    var tn = uiResultTone(o.tone);
    if (tn) grp.tone = tn;
    if (typeof o.open === 'boolean') grp.open = o.open; // sections render COLLAPSED by default → open:true expands
    out.push(grp);
  }
  return out;
}

// ["PROJ", "ACME"] → the two side labels of a comparison panel (column default or per-entry override)
function uiResultSides(v) {
  if (!Array.isArray(v) || v.length < 2) return null;
  var l = uiResultStr(v[0], UI_RESULT_CAPS.xside), r = uiResultStr(v[1], UI_RESULT_CAPS.xside);
  return (l || r) ? [l, r] : null;
}

// the dimension rows of ONE expand entry: label + left/mark/right + optional tone/note/items
function uiResultExpandRows(a) {
  if (!Array.isArray(a)) return [];
  var out = [];
  for (var i = 0; i < a.length && out.length < UI_RESULT_CAPS.xrows; i++) {
    var r = a[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    var label = uiResultStr(r.label, UI_RESULT_CAPS.xlabel);
    if (!label) continue;
    var row = { label: label, left: uiResultStr(r.left, UI_RESULT_CAPS.xval), right: uiResultStr(r.right, UI_RESULT_CAPS.xval), mark: uiResultStr(r.mark, UI_RESULT_CAPS.xval) };
    var short = uiResultStr(r.short, UI_RESULT_CAPS.xshort);
    if (short) row.short = short;
    var tn = uiResultTone(r.tone);
    if (tn) row.tone = tn;
    var note = uiResultStr(r.note, UI_RESULT_CAPS.xnote);
    if (note) row.note = note;
    if (Array.isArray(r.items)) {
      var items = [];
      for (var j = 0; j < r.items.length && items.length < UI_RESULT_CAPS.xitems; j++) {
        var it = r.items[j];
        if (it == null) continue;
        if (typeof it !== 'object' || Array.isArray(it)) { var s = uiResultStr(it, UI_RESULT_CAPS.xtext); if (s) items.push({ side: 'both', text: s }); continue; }
        var text = uiResultStr(it.text, UI_RESULT_CAPS.xtext);
        if (!text) continue;
        var o = { side: UI_RESULT_SIDES.indexOf(it.side) >= 0 ? it.side : 'both', text: text };
        var im = uiResultStr(it.mark, UI_RESULT_CAPS.xval);
        if (im) o.mark = im;
        var itn = uiResultTone(it.tone);
        if (itn) o.tone = itn;
        items.push(o);
      }
      if (items.length) row.items = items;
    }
    out.push(row);
  }
  return out;
}

// `expand[]` → one validated entry per row index. Entries pointing outside `rows`, duplicates and
// entries without any content are dropped (a model-authored index must not address a row it has not emitted).
function uiResultExpand(a, rowCount) {
  if (!Array.isArray(a)) return [];
  var out = [];
  var seen = {};
  for (var i = 0; i < a.length && out.length < UI_RESULT_CAPS.rows; i++) {
    var e = a[i];
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    var ri = Number(e.row);
    if (!(ri >= 0 && ri < rowCount && Math.floor(ri) === ri) || seen[ri]) continue;
    var rows = uiResultExpandRows(e.rows);
    var notes = [];
    if (Array.isArray(e.notes)) {
      for (var n = 0; n < e.notes.length && notes.length < UI_RESULT_CAPS.xnotes; n++) { var ns = uiResultStr(e.notes[n], UI_RESULT_CAPS.xnote); if (ns) notes.push(ns); }
    }
    if (!rows.length && !notes.length) continue;
    seen[ri] = 1;
    var entry = { row: ri, rows: rows };
    if (notes.length) entry.notes = notes;
    if (e.open === true) entry.open = true;           // rows render COLLAPSED by default → open:true expands
    var sides = uiResultSides(e.sides);
    if (sides) entry.sides = sides;
    out.push(entry);
  }
  return out;
}

function uiResultNormalize(parsed, source) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  var colsIn = Array.isArray(parsed.columns) ? parsed.columns.slice(0, UI_RESULT_CAPS.columns) : [];
  if (!colsIn.length) return null;
  var columns = colsIn.map(function (c, i) {
    if (c == null || typeof c !== 'object') { var s = uiResultStr(c == null ? 'c' + (i + 1) : c, UI_RESULT_CAPS.label); return { id: s, label: s, type: 'text' }; }
    var id = uiResultStr(c.id != null ? c.id : (c.label != null ? c.label : 'c' + (i + 1)), UI_RESULT_CAPS.label);
    var label = uiResultStr(c.label != null ? c.label : id, UI_RESULT_CAPS.label);
    var type = UI_RESULT_TYPES.indexOf(c.type) >= 0 ? c.type : 'text';
    var out = { id: id, label: label, type: type };
    var lb = uiResultSafeUrl(c.linkBase);
    if (lb) out.linkBase = lb;
    var tones = uiResultTones(c.tones);
    if (tones) out.tones = tones;
    if (type === 'expand') { // side labels + legend live on the column; an entry may override the sides
      var sides = uiResultSides(c.sides);
      if (sides) out.sides = sides;
      var legend = uiResultStr(c.legend, UI_RESULT_CAPS.xnote);
      if (legend) out.legend = legend;
    }
    return out;
  });
  var rowsIn = Array.isArray(parsed.rows) ? parsed.rows.slice(0, UI_RESULT_CAPS.rows) : [];
  var rows = [];
  for (var r = 0; r < rowsIn.length; r++) {
    var src = Array.isArray(rowsIn[r]) ? rowsIn[r] : [rowsIn[r]];
    var row = [];
    for (var c2 = 0; c2 < columns.length; c2++) {
      row.push(uiResultStr(src[c2], columns[c2].type === 'detail' ? UI_RESULT_CAPS.detail : UI_RESULT_CAPS.cell));
    }
    rows.push(row);
  }
  var out = {
    source: source || 'block',
    summary: uiResultStr(parsed.summary, UI_RESULT_CAPS.summary),
    columns: columns,
    rows: rows,
  };
  // optional v2 extras — only when present, so persisted history entries stay lean
  var stats = uiResultStats(parsed.stats);
  if (stats.length) out.stats = stats;
  var groups = uiResultGroups(parsed.groups);
  if (groups.length) out.groups = groups;
  var expand = uiResultExpand(parsed.expand, rows.length);
  if (expand.length) out.expand = expand;
  else { // …or a reference to a panel file; inline data always wins, the server validates the path
    var src = uiResultStr(parsed.expandSrc, UI_RESULT_CAPS.xsrc).trim();
    if (src) out.expandSrc = src;
  }
  return out;
}

// ---- pure view logic, shared by the card renderer, the headless engine and the tests --------------
// Kept here (dependency-free, side-effect-free) instead of inside the DOM renderer so it can be
// unit-tested without a browser — same reason lib/engine.js already requires this file.

// rows → sections for a `group` column. `groups[]` fixes the order, then first appearance wins;
// pre-declared but unused groups drop out. Rows may carry a group id OR its label → both resolve
// to the same section. Returns ROW INDICES so callers keep their own row objects.
function uiResultBuckets(data, groupIdx, ungroupedLabel) {
  var groups = (data && Array.isArray(data.groups)) ? data.groups : [];
  var meta = {};
  groups.forEach(function (g) { meta[g.id] = g; if (!(g.label in meta)) meta[g.label] = g; });
  var order = [];
  var map = {};
  groups.forEach(function (g) { if (!map[g.id]) { map[g.id] = []; order.push(g.id); } });
  var rows = (data && Array.isArray(data.rows)) ? data.rows : [];
  for (var i = 0; i < rows.length; i++) {
    var raw = uiResultStr(rows[i][groupIdx], UI_RESULT_CAPS.label).trim();
    var key = (meta[raw] && meta[raw].id) || raw || (ungroupedLabel || '—');
    if (!map[key]) { map[key] = []; order.push(key); }
    map[key].push(i);
  }
  var used = [];
  for (var j = 0; j < order.length; j++) if (map[order[j]].length) used.push(order[j]);
  return { order: used, map: map, meta: meta };
}

// comparator over raw rows: numeric-aware for number columns, natural order otherwise
// (so PROJ-9 sorts before PROJ-11 and "11" after "2")
function uiResultRowCmp(idx, dir, numeric) {
  var d = dir < 0 ? -1 : 1;
  return function (a, b) {
    var x = uiResultStr(a && a[idx], UI_RESULT_CAPS.cell).trim();
    var y = uiResultStr(b && b[idx], UI_RESULT_CAPS.cell).trim();
    if (numeric) {
      var nx = parseFloat(x.replace(',', '.'));
      var ny = parseFloat(y.replace(',', '.'));
      if (!isNaN(nx) || !isNaN(ny)) return ((isNaN(nx) ? -Infinity : nx) - (isNaN(ny) ? -Infinity : ny)) * d;
    }
    return x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }) * d;
  };
}

// free-text filter across ALL cells of a row (including group/detail values) and — when the row has
// an expand entry — across its panel (dimension values, marks, notes, line items): a comment author
// or a file name must be findable even though it only lives in the panel.
function uiResultMatch(row, query, entry) {
  var q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q) return true;
  var hit = function (s) { return String(s == null ? '' : s).toLowerCase().indexOf(q) >= 0; };
  for (var i = 0; i < (row || []).length; i++) {
    if (hit(row[i])) return true;
  }
  if (entry && typeof entry === 'object') {
    var rows = Array.isArray(entry.rows) ? entry.rows : [];
    for (var r = 0; r < rows.length; r++) {
      var x = rows[r] || {};
      if (hit(x.label) || hit(x.left) || hit(x.right) || hit(x.mark) || hit(x.note)) return true;
      var items = Array.isArray(x.items) ? x.items : [];
      for (var k = 0; k < items.length; k++) if (items[k] && (hit(items[k].text) || hit(items[k].mark))) return true;
    }
    var notes = Array.isArray(entry.notes) ? entry.notes : [];
    for (var n = 0; n < notes.length; n++) if (hit(notes[n])) return true;
  }
  return false;
}

// identity of a rendered result — lets callers tell "new data" from "same block seen again"
// (a follow-up turn that emits no new block must not fake a fresh card). Panels count: the same
// rows with a different comparison IS new data. v1 blocks keep their old fingerprint.
function uiResultFingerprint(d) {
  if (!d || !Array.isArray(d.columns)) return '';
  try {
    var parts = [d.columns.map(function (c) { return c.id; }), d.rows || []];
    if (Array.isArray(d.expand) && d.expand.length) parts.push(d.expand);
    return JSON.stringify(parts);
  } catch (e) { return ''; }
}

// ---- run-over-run comparison ("what is new since last time?") -------------------------------------
// A row's identity is its key cell: the first `link` column (ticket/incident number), falling back to
// the first ordinary body column. Grouped radar skills re-emit the same keys every run, so key set
// difference = "new since last run".
function uiResultKeyIdx(norm) {
  if (!norm || !Array.isArray(norm.columns)) return -1;
  var fallback = -1;
  for (var i = 0; i < norm.columns.length; i++) {
    var ty = norm.columns[i].type;
    if (ty === 'link') return i;
    if (fallback < 0 && ty !== 'group' && ty !== 'detail') fallback = i;
  }
  return fallback;
}
function uiResultRowKeys(norm) {
  var idx = uiResultKeyIdx(norm);
  if (idx < 0) return [];
  return (norm.rows || []).map(function (r) { return String(r[idx] == null ? '' : r[idx]).trim(); });
}
// indices of rows in `norm` whose key was NOT present in `prevKeys` (empty keys never count as new)
function uiResultNewSet(norm, prevKeys) {
  var out = {};
  if (!Array.isArray(prevKeys)) return out;
  var prev = {};
  for (var p = 0; p < prevKeys.length; p++) prev[String(prevKeys[p]).trim()] = 1;
  var keys = uiResultRowKeys(norm);
  for (var i = 0; i < keys.length; i++) if (keys[i] && !prev[keys[i]]) out[i] = 1;
  return out;
}
// two runs of the same skill → added / removed / changed row indices. Requires the same column ids
// (same contract); otherwise returns null so callers can say "nicht vergleichbar" instead of lying.
function uiResultCompare(cur, prev) {
  if (!cur || !prev || !Array.isArray(cur.columns) || !Array.isArray(prev.columns)) return null;
  var ids = function (n) { return n.columns.map(function (c) { return c.id; }).join(','); };
  if (ids(cur) !== ids(prev)) return null;
  var idx = uiResultKeyIdx(cur);
  if (idx < 0) return null;
  var byKey = function (n) {
    var m = {};
    (n.rows || []).forEach(function (r, i) { var k = String(r[idx] == null ? '' : r[idx]).trim(); if (k && !(k in m)) m[k] = i; });
    return m;
  };
  var cm = byKey(cur), pm = byKey(prev);
  var added = [], removed = [], changed = [];
  Object.keys(cm).forEach(function (k) {
    if (!(k in pm)) { added.push(cm[k]); return; }
    if ((cur.rows[cm[k]] || []).join('\u0001') !== (prev.rows[pm[k]] || []).join('\u0001')) changed.push(cm[k]);
  });
  Object.keys(pm).forEach(function (k) { if (!(k in cm)) removed.push(pm[k]); });
  return { added: added, removed: removed, changed: changed, keyIdx: idx };
}

// compact projection for surfaces that only have a line or two: the headless engine record and the
// schedule panel. Grouped results digest to section counts ("G1 · 3"), ungrouped ones to the first
// two body cells per row. Never returns whole rows — that produced unreadable text sausages.
function uiResultDigest(norm) {
  var out = { summary: (norm && norm.summary) || '', lines: [] };
  if (!norm || !Array.isArray(norm.columns)) return out;
  var rows = Array.isArray(norm.rows) ? norm.rows : [];
  var gi = -1;
  var body = [];
  for (var i = 0; i < norm.columns.length; i++) {
    var ty = norm.columns[i].type;
    if (ty === 'group') { if (gi < 0) gi = i; }
    else if (ty !== 'detail') body.push(i);
  }
  if (gi >= 0) {
    var b = uiResultBuckets(norm, gi);
    for (var k = 0; k < b.order.length; k++) {
      var key = b.order[k];
      var m = b.meta[key];
      out.lines.push(uiResultStr(((m && m.label) || key) + ' · ' + b.map[key].length, UI_RESULT_CAPS.digest));
    }
    return out;
  }
  for (var r = 0; r < rows.length && r < 20; r++) {
    var parts = [];
    for (var c = 0; c < body.length && c < 2; c++) {
      var v = String(rows[r][body[c]] == null ? '' : rows[r][body[c]]).trim();
      if (v) parts.push(v);
    }
    if (parts.length) out.lines.push(uiResultStr(parts.join(' · '), UI_RESULT_CAPS.digest));
  }
  return out;
}

function uiResultParseBlocks(text) {
  var out = [];
  var re = /```ui-result\s*\n([\s\S]*?)```/g;
  var m;
  while ((m = re.exec(String(text || ''))) !== null) {
    try { var norm = uiResultNormalize(JSON.parse(m[1]), 'block'); if (norm) out.push(norm); } catch { /* invalid block → skip */ }
  }
  return out;
}

// preferred channel: the LAST valid ```ui-result block in the transcript (later turns win)
function uiResultExtract(text) {
  var blocks = uiResultParseBlocks(text);
  return blocks.length ? blocks[blocks.length - 1] : null;
}

// legacy fallback: manifest.result.pattern regex over the transcript.
// named capture groups → one column each (a table); otherwise unique whole-matches / group 1 (chips).
function uiResultFromPattern(text, manifest, opts) {
  var m = manifest || {};
  if (!m.result || !m.result.pattern) return null;
  var re;
  try { re = new RegExp(m.result.pattern, 'g'); } catch { return null; }
  var label = (m.result && m.result.label) || (opts && opts.defaultLabel) || 'Ergebnis';
  var matches = [];
  var mm;
  while ((mm = re.exec(String(text || ''))) !== null) { matches.push(mm); if (mm.index === re.lastIndex) re.lastIndex++; }
  var mkCols = function (names) { return names.map(function (n) { return { id: n, label: n, type: 'text' }; }); };
  if (!matches.length) return { source: 'regex', summary: '', columns: mkCols([label]), rows: [] };
  var groups = matches[0].groups;
  if (groups && Object.keys(groups).length) {
    var columns = Object.keys(groups);
    var seen = {}; var rows = [];
    matches.forEach(function (x) {
      var row = columns.map(function (c) { return x.groups[c] != null ? String(x.groups[c]) : ''; });
      var key = row.join(' ');
      if (!seen[key]) { seen[key] = 1; rows.push(row); }
    });
    return { source: 'regex', summary: '', columns: mkCols(columns), rows: rows };
  }
  var uniq = {}; var vals = [];
  matches.forEach(function (x) { var v = x[1] != null ? x[1] : x[0]; if (!uniq[v]) { uniq[v] = 1; vals.push(v); } });
  return { source: 'regex', summary: '', columns: mkCols([label]), rows: vals.map(function (v) { return [v]; }) };
}

// server-side validation of a client-reported result (POST /api/uiskill/runs) — re-normalize or drop
function uiResultSanitize(x) {
  if (!x || typeof x !== 'object') return null;
  return uiResultNormalize(x, x.source === 'regex' ? 'regex' : 'block');
}

// May an approval (result.followUp[s]) go out right now? One rule, one place — the card shows the
// answer ON the button instead of refusing a click that looked legitimate.
//   ''       → go ahead
//   'locked' → an approval already went out from this card; it is spent (checked FIRST: a locked card
//              stays locked even when the selection changes or the run starts another turn)
//   'empty'  → nothing selected
//   'busy'   → the run/turn that produced the card is still going. A card is deliberately readable
//              mid-run (the sync skill emits its block in the "plan" step), so this wait is normal —
//              and it is the state the user has to SEE, not one to answer with a toast.
function uiFollowGate(s) {
  var st = s || {};
  if (st.locked) return 'locked';
  if (!(Number(st.selected) > 0)) return 'empty';
  if (st.busy) return 'busy';
  return '';
}

// Selected rows as compact Markdown — the `{{rows}}` placeholder of a follow-up prompt. A follow-up
// that opens a NEW chat tab (`target:"newTab"`) starts a session that never saw the run, so the
// prompt has to carry the rows themselves: every non-empty cell with its column label (group values
// resolved to their section label), then the comparison panel as text when one is loaded.
// `expand` may be the renderer's Map (row → entry), a plain object or the block's `expand[]` array.
// Capped (default 24 000 chars) at a row boundary; the cut is said, not silent.
var UI_FOLLOW_ROWS_CAP = 24000;
function uiResultRowsMarkdown(data, rowIdx, expand, cap) {
  if (!data || !Array.isArray(data.columns) || !Array.isArray(data.rows)) return '';
  var max = Number(cap) > 0 ? Number(cap) : UI_FOLLOW_ROWS_CAP;
  var cols = data.columns;
  var key = uiResultKeyIdx(data);
  var meta = uiResultBuckets(data, 0).meta;
  var entryOf = function (ri) {
    if (!expand) return null;
    if (typeof expand.get === 'function') return expand.get(ri) || null;
    if (Array.isArray(expand)) { for (var e = 0; e < expand.length; e++) if (expand[e] && expand[e].row === ri) return expand[e]; return null; }
    return expand[ri] || null;
  };
  var flat = function (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); };
  var idx = Array.isArray(rowIdx) ? rowIdx : [];
  var blocks = [];
  var used = 0;
  for (var n = 0; n < idx.length; n++) {
    var row = data.rows[idx[n]];
    if (!row) continue;
    var lines = ['### ' + (n + 1) + '. ' + (flat(key >= 0 ? row[key] : '') || ('Zeile ' + (idx[n] + 1)))];
    for (var c = 0; c < cols.length; c++) {
      if (c === key) continue;
      var v = flat(row[c]);
      if (!v) continue;
      if (cols[c].type === 'group' && meta[v] && meta[v].label) v = meta[v].label;
      lines.push('- ' + cols[c].label + ': ' + v);
    }
    var x = entryOf(idx[n]);
    if (x && Array.isArray(x.rows) && x.rows.length) {
      var expCol = null;
      for (var k = 0; k < cols.length; k++) if (cols[k].type === 'expand') { expCol = cols[k]; break; }
      var sides = x.sides || (expCol && expCol.sides) || null;
      lines.push('- Details' + (sides ? ' (' + flat(sides[0]) + ' | ' + flat(sides[1]) + ')' : '') + ':');
      for (var d = 0; d < x.rows.length; d++) {
        var dr = x.rows[d] || {};
        var vals = [flat(dr.left), flat(dr.mark), flat(dr.right)].filter(Boolean).join(' | ');
        lines.push('  - ' + flat(dr.label) + (vals ? ': ' + vals : '') + (dr.note ? ' (' + flat(dr.note) + ')' : ''));
        var items = Array.isArray(dr.items) ? dr.items : [];
        for (var it = 0; it < items.length; it++) {
          if (!items[it] || !items[it].text) continue;
          var side = items[it].side === 'left' && sides ? flat(sides[0]) : (items[it].side === 'right' && sides ? flat(sides[1]) : '');
          lines.push('    - ' + (side ? '[' + side + '] ' : '') + flat(items[it].text) + (items[it].mark ? ' ' + flat(items[it].mark) : ''));
        }
      }
      (Array.isArray(x.notes) ? x.notes : []).forEach(function (nt) { if (flat(nt)) lines.push('  - Hinweis: ' + flat(nt)); });
    }
    var block = lines.join('\n');
    if (used + block.length + 2 > max) {
      blocks.push('… ' + (idx.length - n) + ' weitere Zeile(n) gekappt (Längenbegrenzung).');
      break;
    }
    blocks.push(block);
    used += block.length + 2;
  }
  return blocks.join('\n\n');
}

// A follow-up's text: one pass over the placeholders, so a value that happens to contain "{{rows}}"
// is never expanded a second time. {{selection}}/{{count}} as before; {{summary}} = the card summary;
// {{rows}} = uiResultRowsMarkdown of the selected rows (computed only when the prompt asks for it).
function uiFollowPrompt(fu, ctx) {
  var c = ctx || {};
  var ids = Array.isArray(c.ids) ? c.ids : [];
  var text = String((fu && fu.prompt) || '');
  var rowsMd = null;
  return text.replace(/\{\{(selection|count|summary|rows)\}\}/g, function (all, k) {
    if (k === 'selection') return ids.join(',');
    if (k === 'count') return String(ids.length);
    if (k === 'summary') return String((c.data && c.data.summary) || '');
    if (rowsMd === null) rowsMd = uiResultRowsMarkdown(c.data, c.rowIdx, c.expand, c.cap);
    return rowsMd;
  });
}

// Where does a follow-up go? 'newTab' → a fresh chat tab with its own permission mode (default plan:
// "plan the implementation of what I ticked"), anything else → the next turn of the same run.
function uiFollowTarget(fu) { return (fu && fu.target === 'newTab') ? 'newTab' : 'run'; }

// German prompt paragraph the builder appends to a promptTemplate ("Ergebnis-Kontrakt").
// columns: optional [{id,label,type,linkBase}] to bake a concrete example into the snippet.
// grouped: true → the example already carries the v2 layout (group + detail column, stats, groups),
// which is what a skill with more than a handful of rows should start from.
function uiResultContractSnippet(columns, grouped) {
  var cols = (Array.isArray(columns) && columns.length) ? columns
    : grouped
      ? [{ id: 'bereich', label: 'Bereich', type: 'group' }, { id: 'key', label: 'Ticket', type: 'link', linkBase: 'https://jira.example.com/browse/' },
        { id: 'signal', label: 'Signal', type: 'badge', tones: { offen: 'warn', kritisch: 'err' } }, { id: 'detail', label: 'Detail', type: 'detail' }]
      : [{ id: 'key', label: 'Ticket', type: 'link', linkBase: 'https://jira.example.com/browse/' }, { id: 'summary', label: 'Titel', type: 'text' }];
  var example = { summary: '<Kurzfazit in 1 Satz>', columns: cols, rows: [] };
  if (grouped) {
    example.stats = [{ label: '<Kennzahl>', value: '<n>', tone: 'warn' }];
    example.groups = [{ id: '<bereich-id>', label: '<Sektionstitel>', note: '<Randnotiz>', tone: 'warn', open: true }];
  }
  return 'Gib am ENDE deiner Antwort GENAU EINEN Codeblock mit der Sprache ui-result aus (maschinenlesbares Ergebnis):\n'
    + '```ui-result\n' + JSON.stringify(example) + '\n```\n'
    + 'Regeln: gültiges JSON; **rows sind ARRAYS in Spaltenreihenfolge**, NIE Objekte mit Spaltennamen '
    + '(die Karte würde sie als [object Object] rendern); KEINE Backticks im JSON; '
    + 'wenn nichts gefunden wurde: rows:[] und summary entsprechend ("Keine Treffer …").\n'
    + 'Optional für lange Ergebnisse: "stats":[{"label":"…","value":"…","tone":"ok|warn|err|info|muted"}] '
    + '(Kennzahlen im Kartenkopf) · eine Spalte mit "type":"group" (ihr Wert gliedert die Zeilen in '
    + 'einklappbare Sektionen; mehrere group-Spalten = Umschalter) · "groups":[{"id":"…","label":"…",'
    + '"note":"…","tone":"…"}] (Reihenfolge/Beschriftung der Sektionen) · eine Spalte mit "type":"detail" '
    + '(langer Text als Zweitzeile unter der Zeile) · "tones":{"<Zellwert>":"warn"} an einer badge-Spalte.\n'
    + 'Aufklappbare Zeile (Seitenvergleich): eine Spalte mit "type":"expand" (Zellwert = Textfassung) plus '
    + '"expand":[{"row":<Zeilenindex>,"sides":["<links>","<rechts>"],"rows":[{"label":"…","short":"…","left":"…",'
    + '"mark":"…","right":"…","tone":"warn","items":[{"side":"left|right","text":"…"}]}],"notes":["…"]}] '
    + '— zugeklappt ein Chip je rows-Eintrag, aufgeklappt links | mark | rechts. Große Panel-Daten statt inline als '
    + '"expandSrc":"<absoluter Pfad zu einer .json-Datei {expand:[…]} im run.cwd des Skills>" — das Panel lädt sie selbst.';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    uiResultNormalize, uiResultParseBlocks, uiResultExtract, uiResultFromPattern, uiResultSanitize,
    uiResultContractSnippet, uiResultSafeUrl, uiResultToneFor,
    uiResultBuckets, uiResultRowCmp, uiResultMatch, uiResultFingerprint, uiResultDigest,
    uiResultKeyIdx, uiResultRowKeys, uiResultNewSet, uiResultCompare, uiResultExpand,
    uiFollowGate, uiFollowPrompt, uiFollowTarget, uiResultRowsMarkdown,
  };
}
