'use strict';
// Reading a subagent's own transcript (#34) — path check + line parser, no I/O, so both halves are
// testable without a file. server.js does the reading, this decides what is allowed and what it means.
//
// WHERE THIS COMES FROM: a backgrounded Agent answers its own tool call with an `async_launched` receipt
// that carries `outputFile` — measured on a real run (claude 2.1.276):
//   C:\Users\<user>\AppData\Local\Temp\claude\<project-slug>\<sessionId>\tasks\<agentId>.output
// The file is NOT the agent's final answer, it is its full transcript as JSONL, written while it works:
// one record per message, `isSidechain: true`, the agent's own `tool_use` blocks included. A 109-line
// sample held 59 assistant / 39 user / 11 attachment records (25× Bash, 12× Read, 1× Grep) and ended
// with the report the parent later quoted. That is the only place the panel can learn what a subagent
// actually DID — the event stream carries counters (task_progress) but no content.
//
// The path reaches the server via the browser (it is lane state), so it is treated as untrusted input
// even though the CLI produced it: agentOutputPathOk is an allowlist, not a sanitiser.

const path = require('path');
const os = require('os');

const MAX_EVENTS = 300;        // per response — a long agent run is thousands of records
const MAX_TEXT = 400;          // per text/thinking block; the detail view expands from the raw view
const MAX_SUMMARY = 200;       // per tool one-liner

// The only directory the CLI writes these to. Everything else is refused — a request must not be able
// to name an arbitrary file and have the panel read it back over HTTP.
function agentOutputRoot(tmpDir) {
  return path.join(tmpDir || os.tmpdir(), 'claude');
}
function agentOutputPathOk(p, tmpDir) {
  if (typeof p !== 'string' || !p.trim()) return false;
  if (p.indexOf('\0') >= 0) return false;
  const abs = path.resolve(p);
  if (!/\.output$/i.test(abs)) return false;
  const root = path.resolve(agentOutputRoot(tmpDir));
  // path.relative is the containment test that survives `..`, mixed separators and a prefix that is
  // merely a string match ("…\claude-evil" must not pass for a root of "…\claude").
  const rel = path.relative(root, abs);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return false;
  return true;
}

// One-line description of a tool call, from the field that actually says what it did. Same idea as the
// client's toolSummary(), deliberately re-implemented small: this runs per record on the server and must
// never throw on a shape it has not seen.
function toolOneLiner(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick = ['description', 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'skill'];
  for (const k of pick) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY);
  }
  return '';
}
function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\r/g, '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// One JSONL record → zero or more display events. `attachment` records and the agent's own tool_results
// are dropped: the first is CLI bookkeeping, the second repeats the tool call that is already a row and
// would double the list for nothing.
function recordEvents(o) {
  if (!o || typeof o !== 'object') return [];
  const ts = o.timestamp || '';
  const msg = o.message;
  if (!msg || typeof msg !== 'object') return [];
  const out = [];
  const content = msg.content;
  if (typeof content === 'string') {
    // the opening record: the parent's prompt, i.e. the agent's assignment
    if (msg.role === 'user' && content.trim()) out.push({ ts, kind: 'prompt', text: clip(content, MAX_TEXT * 4) });
    return out;
  }
  if (!Array.isArray(content)) return [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'tool_use') {
      out.push({ ts, kind: 'tool', name: String(b.name || 'tool'), summary: toolOneLiner(b.name, b.input) });
    } else if (b.type === 'text' && String(b.text || '').trim()) {
      out.push({ ts, kind: 'text', text: clip(b.text, MAX_TEXT), full: String(b.text).length > MAX_TEXT });
    } else if (b.type === 'thinking' && String(b.thinking || '').trim()) {
      out.push({ ts, kind: 'thinking', text: clip(b.thinking, MAX_TEXT), full: String(b.thinking).length > MAX_TEXT });
    }
  }
  return out;
}

// Parse a chunk read from `offset`. Returns the events plus how many BYTES were actually consumed:
// the file is being appended to while we read it, so the last line is regularly a half-written record.
// Consuming it would drop it (and 2 s later the next poll would start mid-JSON and drop the rest too) —
// so an unterminated tail is left for the next call, and `consumed` tells the caller where to resume.
// `text` must be the chunk decoded as utf8 from a byte offset the previous call returned, never a
// slice taken in the middle of a multi-byte character.
function parseAgentOutput(text, opts) {
  const o = opts || {};
  const maxEvents = o.maxEvents || MAX_EVENTS;
  const s = String(text == null ? '' : text);
  const events = [];
  let consumed = 0;          // bytes of `s` that are fully processed — what the caller resumes after
  let truncated = false;
  let i = 0;
  while (i < s.length) {
    const nl = s.indexOf('\n', i);
    if (nl < 0) break;                                   // partial last line → leave it for next time
    // The cap is checked BEFORE the line is consumed, so a capped response resumes exactly at the first
    // line it did not report. Checking it inside the record loop instead would consume a line whose
    // later blocks were dropped, and those events would never be delivered by any later poll.
    if (events.length >= maxEvents) { truncated = true; break; }
    const line = s.slice(i, nl);
    i = nl + 1;
    consumed += Buffer.byteLength(line, 'utf8') + 1;     // +1 = the \n; a \r of CRLF is part of `line`
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try { rec = JSON.parse(trimmed); } catch { continue; } // a torn line is skipped, never fatal
    for (const ev of recordEvents(rec)) events.push(ev);
  }
  return { events, consumed, truncated };
}

// The agent's closing report = the text of the LAST assistant record. Used for the "Ergebnis" section
// when the lane has no `summary` of its own (a notification can be missing, see agent-lanes.js).
function lastAssistantText(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.kind === 'text' && e.text) return e.text;
  }
  return '';
}

module.exports = {
  agentOutputRoot, agentOutputPathOk, parseAgentOutput, recordEvents, toolOneLiner, lastAssistantText,
  MAX_EVENTS, MAX_TEXT,
};
