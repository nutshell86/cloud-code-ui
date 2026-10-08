// Part of the Claude Code Control Panel front-end (also require'd by lib/sessions.js — same rule on
// both sides, like public/js/ui-result.js is shared with lib/engine.js).
// Classic scripts share one global scope; load order in index.html is authoritative.
// This file: tool-store.js — the ONE truncation rule for tool inputs, plus the store that makes the
// „Werkzeuge"-Schalter reversible. Pure, no DOM.
//
// Why the store exists: addToolCard (chat-render.js) deliberately does not BUILD a card while the tool
// display is off (P6 — diff LCS plus per-line highlighting for something nobody can see was measurably
// expensive) and returns null. Two things were then gone for good: the card, AND the tool's output,
// because the result handler looks its card up by tool_use_id and gives up when there is none
// (chat-events.js). So the switch was one-way — turning tools back on showed nothing for every turn
// that ran while they were off, and since a row whose only content was tool cards is now hidden as a
// whole, that loss is silent.
//
// The caps are the point of this file. The live path truncates NOTHING: a tool input can be a whole
// file (Write), a tool output up to 200 000 characters. Keeping that unbounded — or in the DOM, in a
// dataset — would trade an invisible card for an invisible leak. 8000 is not an arbitrary number: it is
// what the resume path already used (capToolInput, until now a copy in lib/sessions.js), so a rebuilt
// card is the same card a reloaded transcript paints, down to the `_truncated` marker that makes
// addToolCard show a preview instead of a diff.
var TOOL_STORE_MAX = 50;      // hidden tool calls kept per tab
var TOOL_STORE_OUTS = 10;     // outputs per call — one tool can report repeatedly (BashOutput)
var TOOL_STORE_CHARS = 8000;  // per input and per output
var TOOL_STORE_CUT = '… (gekürzt — vollständig im Transkript)';

// The same rule for a live-stashed and a resumed tool input; returns the input UNCHANGED when it fits,
// so the common case keeps its real object and still renders as a diff.
function toolStoreCapInput(input, max) {
  var lim = Number(max) > 0 ? Number(max) : TOOL_STORE_CHARS;
  try {
    var s = JSON.stringify(input);
    if (s == null) return input;            // undefined / a function — nothing to cap
    if (s.length <= lim) return input;
    return { _truncated: true, preview: s.slice(0, lim) + TOOL_STORE_CUT };
  } catch (e) { return String(input).slice(0, lim); } // circular: the string form is all there is
}
function toolStoreCapText(text, max) {
  var lim = Number(max) > 0 ? Number(max) : TOOL_STORE_CHARS;
  var t = String(text == null ? '' : text);
  return t.length > lim ? t.slice(0, lim) + '\n' + TOOL_STORE_CUT : t;
}
function toolStoreSize(store) { return store ? Object.keys(store).length : 0; }
// Stash one hidden tool call. false = the cap is reached and NOTHING was stored; the caller's stub then
// SAYS so once the display comes back, instead of leaving a gap that looks like a rendering bug.
function toolStorePut(store, id, name, input, opts) {
  if (!store || !id) return false;
  var max = (opts && Number(opts.max) > 0) ? Number(opts.max) : TOOL_STORE_MAX;
  var chars = (opts && Number(opts.chars) > 0) ? Number(opts.chars) : TOOL_STORE_CHARS;
  if (!Object.prototype.hasOwnProperty.call(store, id) && toolStoreSize(store) >= max) return false;
  store[id] = { name: String(name || 'tool'), input: toolStoreCapInput(input, chars), outs: [], stub: (opts && opts.stub) || null };
  return true;
}
// One tool_result for a stashed call. An unknown id means the CALL was never stored (over the cap, or
// the display was on back then) — inventing an entry here would resurrect a call the rebuild has no
// place to put, so it is dropped on purpose.
function toolStoreOut(store, id, text, isError, opts) {
  var e = (store && id) ? store[id] : null;
  if (!e || !Array.isArray(e.outs)) return false;
  var chars = (opts && Number(opts.chars) > 0) ? Number(opts.chars) : TOOL_STORE_CHARS;
  var outs = (opts && Number(opts.outs) > 0) ? Number(opts.outs) : TOOL_STORE_OUTS;
  if (e.outs.length >= outs) return false;
  var t = toolStoreCapText(text, chars);
  if (!t.trim()) return false;
  e.outs.push({ text: t, isError: !!isError });
  return true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TOOL_STORE_MAX, TOOL_STORE_OUTS, TOOL_STORE_CHARS, TOOL_STORE_CUT,
    toolStoreCapInput, toolStoreCapText, toolStoreSize, toolStorePut, toolStoreOut,
  };
}
