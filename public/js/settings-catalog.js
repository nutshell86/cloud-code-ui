'use strict';
// THE SETTINGS CONTROL STATE — pure logic, shared by the browser (classic script) and Node
// (test/settings-catalog.test.js requires it). No t()/tt(), no DOM: this returns a payload the painter in
// views.js renderMoreSettings translates (ctx.js / hooks-catalog.js spirit).
//
// WHY THIS FILE EXISTS, and it is one bug, found in review of PR-11. The options catalog's SELECT branch
// already protects a value it does not know: a `theme` of „custom:my-colors" is shown as its own option with
// a ⚠ and is PRESERVED, because silently falling back to „(nicht gesetzt)" would misreport the file. The
// CHECKBOX branch had no such protection, and one of the keys it drives is not a boolean at all:
//
//   `attribution` is a UNION in the CLI's schema — `Fe([M(), i])` with
//   i = { commit, pr, sessionUrl } (claude.exe 2.1.288 @204653647). Its own describe says:
//   „Set to false to hide all attribution, the same as { "commit": "", "pr": "", "sessionUrl": false }.
//    … Older Claude Code versions reject true or false here, so use the object form in settings files
//    shared across versions."
//
// So the CLI RECOMMENDS the object form, and `{ commit: '', pr: '' }` means attribution is OFF. An object is
// truthy, so `cb.checked = !!s[key]` printed „AN" for exactly the value that switches attribution off — and
// a click then wrote a boolean over it, because applySettingsOps does not check the shape of a top-level
// `set` (lib/pure.js: `cur[last] = value`). The per-channel configuration was gone without a question, no
// 409, no hint. The state is reachable from the panel itself: the reference list's „einfügen" template for
// the same key inserts `{ commit: '', pr: '' }`.
//
// That is this project's failure class in its MIRROR form: not „the surface claims something nobody
// confirmed" but „something CONFIRMED is thrown away". Hence a FOURTH state (`fremd`) beside the three the
// checkbox already had, and it takes the SAME remedy the select branch uses — show it, keep it, refuse to
// overwrite it — rather than a second mechanism.

// Which state a bool row is in, from the catalog entry and the parsed settings file.
//   haken       — what the box shows (false while `unbestimmt` or `fremd`)
//   unbestimmt  — indeterminate: the key is unset AND nobody stated a default
//   fremd       — the key IS set, but to something that is not a boolean (see above)
//   schreibbar  — may a click write a boolean here? FALSE for `fremd`, and that is the whole point
//   standard    — the box is showing the CLI's own stated default, not a value from the file
// → { haken, unbestimmt, fremd, schreibbar, standard, gesetzt }
function settingsBoolState(eintrag, settings) {
  const e = (eintrag && typeof eintrag === 'object') ? eintrag : {};
  const s = (settings && typeof settings === 'object') ? settings : {};
  const key = e.key == null ? '' : String(e.key);
  const gesetzt = !!key && Object.prototype.hasOwnProperty.call(s, key);
  const wert = gesetzt ? s[key] : undefined;
  // THE FOURTH STATE. `typeof` and not a truthiness test: an object, an array and a string are all truthy,
  // and „attribution: { commit: '', pr: '' }" is the one that means OFF. null is caught here too — it is not
  // a boolean either, and writing `true` over an explicit null is the same silent replacement.
  if (gesetzt && typeof wert !== 'boolean') {
    return { haken: false, unbestimmt: false, fremd: true, schreibbar: false, standard: false, gesetzt: true };
  }
  if (gesetzt) return { haken: wert, unbestimmt: false, fremd: false, schreibbar: true, standard: false, gesetzt: true };
  // not set: the CLI's own stated default, or INDETERMINATE when no source states one. A box that showed
  // „aus" for a key whose default nobody gave would be the same invention one level down.
  if (e.def === true || e.def === false) {
    return { haken: e.def, unbestimmt: false, fremd: false, schreibbar: true, standard: true, gesetzt: false };
  }
  return { haken: false, unbestimmt: true, fremd: false, schreibbar: true, standard: false, gesetzt: false };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { settingsBoolState };
}
