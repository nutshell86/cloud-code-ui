'use strict';
// Shared CSV cell encoder — browser (classic script) AND Node (require'd by lib/usage.js).
// Dependency-free and side-effect-free (pure.js spirit); no t()/DOM here.
//
// WHY IT EXISTS: three places wrote their own `esc()` with the same two lines —
// `lib/usage.js` (GET /api/usage.csv), `public/js/views-uiskills.js resultToCsv` (a UI-skill result card)
// and `…js exportHistory` (the run history). All three quoted correctly and all three did NOTHING about
// formula injection, so the fix had to land three times or once.
//
// ---- SEC-7: what "formula neutralisation" is and is not here ----------------------------------------
// This is a DATA defect first, not a hole: Excel/LibreOffice read a cell beginning with `=`, `+`, `-`,
// `@` (and a leading TAB/CR) as a formula, so a session title like `=SUM(A1)` opens as `#NAME?` and a
// model-written result row like `@foo` shows an error instead of its text. It becomes a security concern
// only in the DDE/`=cmd|…` family, and only if the person opening the file clicks through Excel's own
// "enable content" warning. Both reasons point at the same fix, so the wording of the fix is honest:
// the cell is rendered as TEXT, nothing is "sanitised away".
//
// THE TRAP, and the decision taken: the standard recipe prefixes `'` to every cell starting with one of
// those four characters — which breaks every NEGATIVE NUMBER in the file. `-5` would become `'-5`, i.e.
// text, and the column stops summing. `/api/usage.csv` has real negative-capable numeric columns (cost
// deltas, token differences), so the blanket recipe is not acceptable here.
//   So: a cell that starts with `-` or `+` is prefixed ONLY IF it is not a number. `-5`, `-5.25`,
// `-5,25`, `+3`, `-.5` and `-1.2e-3` pass through byte-identical; `-- siehe unten` and
// `-5+cmd|' /C calc'!A0` are prefixed. A cell starting with `=` or `@` is always prefixed — neither can
// begin a number, so there is nothing to protect.
//   KNOWN LIMIT, stated rather than hidden: a GROUPED number (`-1,234.56`) is not recognised as a
// number and is therefore prefixed. That is deliberate — a separator-tolerant number regex also accepts
// `-1,2,3` and would let a crafted cell through — and it costs nothing today, because every numeric
// cell this project writes comes from `String(n)`/`toFixed()` and carries no group separator.
//   The `'` is Excel's own text marker. Depending on the import path Excel shows either `=1+1` (marker
// consumed) or `'=1+1` (marker literal). In BOTH cases nothing is evaluated, and that is the point.
const CSV_FORMULA_LEAD = /^[=@\t\r]/;           // can never start a number → always neutralised
const CSV_SIGN_LEAD = /^[-+]/;                  // might be a negative/positive NUMBER → ask first
// plain decimal, optional sign, `.` or `,` as the decimal mark, optional exponent
const CSV_NUMERIC = /^[-+]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][-+]?\d+)?$/;
function csvNeedsPrefix(s) {
  if (CSV_FORMULA_LEAD.test(s)) return true;
  return CSV_SIGN_LEAD.test(s) && !CSV_NUMERIC.test(s);
}
// One cell: neutralise first, then quote. The quoting rule is unchanged from the three copies this
// replaces (`"` doubled, quotes added for `"` `,` CR LF) — `'` does not itself require quoting.
function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (csvNeedsPrefix(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// A whole table, CRLF-terminated rows (RFC 4180, and what Excel expects on Windows).
function csvRows(rows) { return (rows || []).map((r) => (r || []).map(csvCell).join(',')).join('\r\n'); }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { csvCell, csvRows, csvNeedsPrefix };
}
