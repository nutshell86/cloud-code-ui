'use strict';
// A13 — the global prompt history: two sources, one list.
//
// WHY THIS EXISTS: recalling a prompt was possible in exactly one way — ↑ in the composer, backed by
// `cc_prompt_history` in localStorage (chat-composer.js), capped at 100, not searchable, gone with the
// browser profile. Meanwhile the CLI keeps 700+ prompts of its own in ~/.claude/history.jsonl, which the
// panel never showed. Neither source is complete on its own:
//
//   ~/.claude/history.jsonl   what was typed in the TERMINAL. Written by the REPL's input box — the
//                             panel's prompts go in as stream-json messages and never reach it. (Visible
//                             in the data: entries like "/model", "/effort" and the TUI paste
//                             placeholders "[Pasted text #1 +6 lines]", which the panel cannot produce
//                             because it expands its own paste chips before sending.)
//   prompt-history.json       what was sent FROM THE PANEL, recorded by the panel itself.
//
// This module holds the pure half: parsing, merging, capping. The I/O is in lib/core.js and server.js,
// so the decisions here are testable without touching a file.

// A line of the CLI's history. Shape measured on 2.1.285 (734 entries):
//   {"display":"…","pastedContents":{…},"timestamp":1790773572007,"project":"C:\\WINDOWS\\system32",
//    "sessionId":"70a51853-…"}
// `pastedContents` is deliberately NOT carried over: 31 of those 734 entries embed whole pasted blocks
// (MCP error dumps and the like). The panel only needs to SAY that a paste belonged to the prompt, so
// only the flag travels — the payload never reaches the browser.
function parseCliHistoryLine(line) {
  let o;
  try { o = JSON.parse(String(line)); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const text = String(o.display == null ? '' : o.display);
  if (!text.trim()) return null;
  const pastes = (o.pastedContents && typeof o.pastedContents === 'object') ? Object.keys(o.pastedContents).length : 0;
  return {
    text,
    ts: Number(o.timestamp) || 0,
    project: String(o.project || ''),
    sessionId: String(o.sessionId || ''),
    pastes,
    source: 'cli',
  };
}
// The whole file → newest entries first, bounded. The file is small (≈170 KB here) but it is the CLI's
// to grow, so the cap is on ENTRIES and applied after sorting — taking the last N lines instead would
// assume the file is append-ordered, and the CLI rewrites it when it prunes.
function parseCliHistory(text, max) {
  const cap = max > 0 ? max : 2000;
  const out = [];
  for (const line of String(text == null ? '' : text).split('\n')) {
    if (!line.trim()) continue;
    const e = parseCliHistoryLine(line);
    if (e) out.push(e);
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, cap);
}

const PANEL_CAPS = { entries: 1000, chars: 4000 };
// One panel prompt into the store. Newest LAST (append order = the file reads like a log), and the
// caller writes the returned array.
//
// Two guards, both from the behaviour the ↑-history already has: a prompt identical to the previous one
// is not a second entry (you re-sent it, you did not write it twice), and a pasted wall of text is
// clipped rather than stored whole — the store is for recall, not for archiving payloads.
function appendPanelPrompt(list, entry, caps) {
  const c = Object.assign({}, PANEL_CAPS, caps || {});
  const arr = Array.isArray(list) ? list.slice() : [];
  const text = String((entry && entry.text) || '').trim();
  if (!text) return arr;
  const clipped = text.length > c.chars ? text.slice(0, c.chars) + '…' : text;
  const last = arr[arr.length - 1];
  if (last && last.text === clipped) {
    // same prompt again → refresh the timestamp instead of adding a duplicate row
    arr[arr.length - 1] = Object.assign({}, last, { ts: Number(entry.ts) || Date.now() });
    return arr;
  }
  arr.push({
    text: clipped,
    ts: Number(entry.ts) || Date.now(),
    project: String((entry && entry.project) || ''),
    sessionId: String((entry && entry.sessionId) || ''),
    model: String((entry && entry.model) || ''),
  });
  return arr.length > c.entries ? arr.slice(arr.length - c.entries) : arr;
}

// Both sources → what the overlay shows. Newest first, de-duplicated by the prompt TEXT (the same
// prompt typed in the terminal and later re-sent from the panel is ONE row, carrying the newer
// timestamp and both source marks) and filtered server-side, so a 700-entry corpus does not cross the
// wire for a three-letter query.
function mergeHistory(cli, panel, opts) {
  const o = opts || {};
  const q = String(o.q == null ? '' : o.q).trim().toLowerCase();
  const limit = Math.min(500, Math.max(1, Number(o.limit) || 120));
  const all = [];
  for (const e of (Array.isArray(cli) ? cli : [])) if (e && e.text) all.push(Object.assign({}, e, { source: 'cli' }));
  for (const e of (Array.isArray(panel) ? panel : [])) if (e && e.text) all.push(Object.assign({}, e, { source: 'panel' }));
  const byText = new Map(); // text -> { newest row, Set of sources }
  for (const e of all) {
    if (q && e.text.toLowerCase().indexOf(q) < 0) continue;
    let slot = byText.get(e.text);
    if (!slot) { slot = { row: e, sources: new Set() }; byText.set(e.text, slot); }
    slot.sources.add(e.source);
    // the newest use owns the metadata (project/session/model), the source marks are cumulative
    if ((e.ts || 0) > (slot.row.ts || 0)) slot.row = e;
  }
  const rows = [...byText.values()]
    .map((s) => Object.assign({}, s.row, { sources: [...s.sources] }))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return {
    items: rows.slice(0, limit).map((e) => ({
      text: e.text,
      ts: e.ts || 0,
      project: e.project || '',
      sessionId: e.sessionId || '',
      model: e.model || '',
      pastes: e.pastes || 0,
      sources: e.sources,
    })),
    total: rows.length,
    truncated: rows.length > limit,
  };
}

module.exports = { parseCliHistoryLine, parseCliHistory, appendPanelPrompt, mergeHistory, PANEL_CAPS };
