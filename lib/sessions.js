'use strict';
// Session browsing, cross-session search, and transcript reading. Extracted from server.js
// (structure-only refactor). Scans ~/.claude/projects/**.jsonl.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { PROJECTS_DIR } = require('./paths');
const { projectPathOf, extractText, chooseTitle, readSessionNames, readFavorites, readCustomNames, costParts, errorText } = require('./core');
const { scanCorpus, sessionRecs, DRAFT_CAPS } = require('./corpus');
// One truncation rule for tool inputs, shared with the browser (same idea as lib/engine.js requiring
// public/js/ui-result.js): the live path stashes hidden tool calls with exactly this cap, so a card
// rebuilt when „Werkzeuge" comes back on looks like one painted from a resumed transcript.
const { toolStoreCapInput } = require('../public/js/tool-store');
// G2 — same reason again: one classification of „this answer was cut off / refused", shared with the
// live path. The transcript holds NO `result` line (measured over 25 files of the live corpus: the line
// types are user / assistant / attachment / summary / system / queue-operation / last-prompt /
// atis-latch / cost-state), so a resumed tab has lost subtype, errors[], terminal_reason,
// permission_denials and subagent_stats for good. `message.stop_reason` IS persisted per assistant
// message — and it is the one end reason that changes how the text on screen must be READ, so without
// it a reload would quietly turn a truncated answer back into a complete-looking one.
const { turnEndStopBanner } = require('../public/js/turn-end');
// PF-1 — and once more: the plan's progress is folded out of the transcript by the very rules the live tab
// applies the model's reports with (planApplyStatus in the same file). A second reading of ```plan-status here
// would be a second opinion on which step is done — and a resume would then quietly disagree with the tab.
const { planFoldNew, planFoldLine, planFoldResult, planFoldOrphan, planFoldLast, planTitleOf, PLAN_CAPS } = require('../public/js/plan-progress');

// The session list is a PROJECTION over the one shared fold (lib/corpus.js) — it owns no parse and no
// cache of its own any more. That is what killed the duplicate work: this function and scanUsage used to
// stream and JSON.parse the identical 471 MB (942.5 MB read, every file opened twice, 22-26 s cold), and
// their two independent folds were also the reason the session detail and the Usage page could disagree.
// Exactly the MAIN transcripts are listed: the 154 subagent/workflow transcripts are folded INTO their
// parent session and must never become list entries (a naive `**/*.jsonl` would add 167 ghosts).
// opts.signals (P5): every item also carries `dirs` / `mcps` — only the projects overview asks for them.
async function scanSessions(opts) {
  const signals = !!(opts && opts.signals);
  const [names, favs, custom] = await Promise.all([readSessionNames(), readFavorites(), readCustomNames()]);
  let corpus;
  try { corpus = await scanCorpus(); } catch { return []; }
  const sessions = [];
  for (const rec of corpus.recs) {
    if (rec.kind !== 'main') continue;
    const item = {
      project: rec.project,
      projectPath: projectPathOf(rec.project, rec.cwd), // authoritative cwd, not the lossy dir-name decode
      id: rec.session,
      mtime: rec.m,
      size: rec.s,
      messages: rec.msgs,
      preview: rec.preview,
      summary: rec.summary,
    };
    const ct = chooseTitle(item, custom, names);
    item.title = ct.title; item.customName = ct.custom;
    item.favorite = favs.includes(item.id);
    // P-2 cockpit (fold v4, lib/corpus.js): the plan slug, the Jira keys the user TYPED ({KEY: messages}), and the
    // „last state" — the CLI's last-prompt record (Du) and the last assistant text (Claude), each with its date.
    // Capped in the fold (300 / 600 characters), so the list grows by well under 1 KB per session.
    item.slug = rec.slug || '';
    item.typedKeys = Object.assign({}, rec.jk);
    item.lastPrompt = rec.lp || ''; item.lastPromptAt = rec.lpAt || null;
    item.lastText = rec.last || ''; item.lastTextAt = rec.lastAt || null;
    item.recap = rec.recap || ''; item.recapAt = rec.recapAt || null;
    // P5 — fold v5: the folders the session's tools touched and the MCP servers it used, its agents' calls summed in.
    // ONLY for the projects overview (the drafts): /api/sessions stays as large as before.
    if (signals) {
      const g = corpus.bySession.get(rec.project + '/' + rec.session);
      const recs = [rec].concat(g ? g.agents : []);
      item.dirs = sumCounts(recs.map((r) => r.fd), DRAFT_CAPS.FD_MAX);
      item.mcps = sumCounts(recs.map((r) => r.ms), DRAFT_CAPS.MS_MAX);
    }
    sessions.push(item);
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

// {key: n} maps summed into a fresh object — own keys only (a key is a folder or a server name, never a member) — and
// cut back to `max` keys afterwards (main + agents could hold 16 each): the largest counts first, ties by key, so the
// cut is deterministic
function sumCounts(list, max) {
  const sum = new Map();
  for (const m of list) {
    if (!m) continue;
    for (const k of Object.keys(m)) sum.set(k, (sum.get(k) || 0) + m[k]);
  }
  const keep = [...sum].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, max);
  const out = {};
  for (const [k, n] of keep) out[k] = n;
  return out;
}

// ---- cross-session content search (find any past conversation by message text) ----
// The old rule was "skip any file > 8MB", which silently made 94% of the corpus BY SIZE unsearchable
// (four transcripts, ~197 of 210MB) — and the biggest files are exactly the long-running sessions
// people search for. Bound the INDEX instead of the file: every message contributes at most
// SEARCH_MSG_CAP chars and only the newest SEARCH_MAX_MSGS messages are kept, so a 100MB transcript
// (≈3500 messages, 2.2M chars) indexes into ~2MB and streams in ~350ms once.
const SEARCH_MSG_CAP = 1000;     // chars kept per message (a snippet needs context, not the essay)
const SEARCH_MAX_MSGS = 20000;   // newest messages per file
const SEARCH_INDEX_MAX = 50;     // LRU: files kept indexed in memory
const searchIndex = new Map(); // fullPath -> { mtime, size, msgs:[{role, ts, text}], dropped, cwd }
function indexSessionFile(full) {
  return new Promise((resolve) => {
    const msgs = []; let dropped = 0, err = null, cwd = '', stream, rl, done = false;
    const finish = () => { if (done) return; done = true; try { rl && rl.close(); } catch { /* */ } try { stream && stream.destroy(); } catch { /* */ } resolve({ msgs, dropped, cwd, error: err }); };
    const fail = (e) => { err = errorText(e) || 'read error'; finish(); };
    try { stream = fs.createReadStream(full, { encoding: 'utf8' }); } catch (e) { return resolve({ msgs, dropped: 0, cwd: '', error: errorText(e) }); }
    stream.on('error', fail);
    rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line) return;
      let obj; try { obj = JSON.parse(line); } catch { return; }
      if (!cwd && obj.cwd) cwd = String(obj.cwd); // free: authoritative project path (see lib/core)
      if (obj.type === 'user' || obj.type === 'assistant') {
        const t = extractText(obj.message && obj.message.content).trim();
        if (t) msgs.push({ role: obj.type, ts: obj.timestamp || null, text: t.slice(0, SEARCH_MSG_CAP) });
        // amortised ring trim (block splice, not a per-message shift — shift on a 20k array is O(n))
        if (msgs.length > SEARCH_MAX_MSGS + 512) { const cut = msgs.length - SEARCH_MAX_MSGS; msgs.splice(0, cut); dropped += cut; }
      }
    });
    rl.on('close', finish); rl.on('error', fail);
  });
}
// → { hits, indexedFiles, skippedFiles, truncatedFiles }: the UI must be able to say "searched 23 of
// 25 sessions" instead of presenting a silently incomplete result as the whole truth.
async function searchSessions(query, limit) {
  const q = String(query || '').toLowerCase().trim();
  const empty = { hits: [], indexedFiles: 0, skippedFiles: [], truncatedFiles: [] };
  if (q.length < 2) return empty;
  limit = Math.min(200, Math.max(1, limit || 60));
  let projectDirs = [];
  try { projectDirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }); } catch { return empty; }
  const files = [];
  for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, d.name);
    let list = []; try { list = await fsp.readdir(dir); } catch { continue; }
    for (const f of list) { if (f.endsWith('.jsonl')) files.push({ project: d.name, f, full: path.join(dir, f) }); }
  }
  const withStat = [];
  for (const fi of files) { try { const st = await fsp.stat(fi.full); withStat.push(Object.assign(fi, { mtime: st.mtimeMs, size: st.size })); } catch { /* */ } }
  withStat.sort((a, b) => b.mtime - a.mtime); // newest sessions first
  const seen = new Set(withStat.map((f) => f.full));
  for (const k of searchIndex.keys()) if (!seen.has(k)) searchIndex.delete(k); // prune deleted files
  const hits = [], skippedFiles = [], truncatedFiles = [];
  let indexedFiles = 0;
  for (const fi of withStat) {
    if (hits.length >= limit) break;
    let entry = searchIndex.get(fi.full);
    if (entry && entry.mtime === fi.mtime && entry.size === fi.size) {
      searchIndex.delete(fi.full); searchIndex.set(fi.full, entry); // LRU touch (Map keeps insertion order)
    } else {
      const r = await indexSessionFile(fi.full);
      if (r.error) { skippedFiles.push(fi.f); continue; } // unreadable → say so, don't pretend it was searched
      entry = { mtime: fi.mtime, size: fi.size, msgs: r.msgs, dropped: r.dropped, cwd: r.cwd };
      searchIndex.set(fi.full, entry);
      while (searchIndex.size > SEARCH_INDEX_MAX) searchIndex.delete(searchIndex.keys().next().value); // evict LRU
    }
    indexedFiles++;
    if (entry.dropped) truncatedFiles.push(fi.f); // only the newest SEARCH_MAX_MSGS messages are searchable
    const projectPath = projectPathOf(fi.project, entry.cwd);
    let perFile = 0;
    for (const mg of entry.msgs) {
      if (perFile >= 3 || hits.length >= limit) break;
      const idx = mg.text.toLowerCase().indexOf(q);
      if (idx < 0) continue;
      const start = Math.max(0, idx - 40);
      const snippet = (start > 0 ? '…' : '') + mg.text.slice(start, idx + q.length + 90).replace(/\s+/g, ' ').trim() + '…';
      hits.push({ sessionId: fi.f.replace(/\.jsonl$/, ''), project: fi.project, projectPath, role: mg.role, ts: mg.ts, snippet, mtime: fi.mtime });
      perFile++;
    }
  }
  return { hits, indexedFiles, skippedFiles, truncatedFiles };
}

function capToolInput(input) { return toolStoreCapInput(input); }
function toolResultText(block) {
  const c = block && block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && p.type === 'text') ? (p.text || '') : (p && p.type === 'image') ? '[image]' : '').join('\n');
  return '';
}
function capText(t, n) { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n) + '\n… (gekürzt — vollständig im Transkript)' : t; }
// One tool call of the tail as the resumed tab paints it. PF-1 — ExitPlanMode is the exception: its input IS
// the whole plan (median 46.9k characters; 61 of 73 measured plans are over the 8000 cap), so the capped
// preview was a JSON fragment nobody could read. The resumed tab paints a compact history card instead
// (chat-side.js addPlanHistoryCard): title, plan file, size — and the first 8000 characters as MARKDOWN
// (`preview`, the same cap the generic card had). Without it [Plan öffnen] on an earlier plan could only read the
// plan FILE, and the CLI writes every plan of a session into one file per session (10 files for 73 plans in the
// corpus), so each earlier card opened the newest plan under its own title.
function tailTool(b) {
  if (b.name === 'ExitPlanMode') {
    const inp = (b.input && typeof b.input === 'object') ? b.input : {};
    const md = typeof inp.plan === 'string' ? inp.plan : '';
    const file = typeof inp.planFilePath === 'string' ? inp.planFilePath.slice(0, 1000) : '';
    return { name: b.name, id: b.id, plan: { title: planTitleOf(md), file, chars: md.length, preview: md.slice(0, PLAN_CAPS.preview) } };
  }
  return { name: b.name, id: b.id, input: capToolInput(b.input) };
}
// Streamed transcript parse: meta is accumulated over every line, but `events` keeps only the last
// `tailN` (a bounded ring) so a tail request never materialises the whole 30MB file or a full event
// array. Result is cached per (file, tail) by mtime/size.
const transcriptCache = new Map(); // `${full}|${tail}` -> { mtime, size, result }
function parseTranscript(full, tailN, withInputs) {
  return new Promise((resolve) => {
    const events = []; let truncated = 0;
    // No token / cost / model arithmetic here any more: those numbers come from the shared fold in
    // readTranscript below, so the detail tile and the Usage page are the SAME fold instead of two
    // independent ones taken at two instants (which is what made them disagree on the active session).
    const meta = { userTurns: 0, firstTs: null, lastTs: null };
    const push = (ev) => { events.push(ev); if (tailN > 0 && events.length > tailN) { events.shift(); truncated++; } };
    // PF-1 — the plan, folded over EVERY line like `meta`, never only over the tail: the approval that set up the
    // step list is routinely thousands of events older than the newest 220. Lines that cannot matter return at
    // the first check, so this is cheap — measured ≈300–500 ms on the largest transcript (41 806 lines, 40 plans)
    // against ≈10 s to read it. A fold that throws costs the plan, never the transcript: `plan` is then left
    // undefined, which the client reads as „the server says nothing" and keeps the tab's own (planAdopt).
    const pf = planFoldNew(); let pfOk = true;
    let stream, rl, done = false;
    const finish = () => {
      if (done) return; done = true;
      try { rl && rl.close(); } catch {} try { stream && stream.destroy(); } catch {}
      let plan, planOrphan, planLast;
      // PF-1b — and the two slots a live tab keeps beside it: the orphan under a plan underway (its card's ▶ — without
      // it a reload, a resume or a fork could no longer start it) and the newest proposal's name and file (what a plan
      // the model reports without "titel" is named after). Same rule: a fold that failed says nothing (undefined).
      if (pfOk) {
        try { plan = planFoldResult(pf); planOrphan = planFoldOrphan(pf); planLast = planFoldLast(pf); }
        catch { plan = planOrphan = planLast = undefined; }
      }
      resolve({ meta, events, truncated, plan, planOrphan, planLast });
    };
    try { stream = fs.createReadStream(full, { encoding: 'utf8' }); } catch { return finish(); }
    stream.on('error', finish);
    rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line) return;
      let obj; try { obj = JSON.parse(line); } catch { return; }
      if (obj.timestamp) { if (!meta.firstTs) meta.firstTs = obj.timestamp; meta.lastTs = obj.timestamp; }
      if (pfOk) { try { planFoldLine(pf, obj); } catch { pfOk = false; } }
      if (obj.type === 'summary') {
        push({ kind: 'summary', text: obj.summary || '' });
      } else if (obj.type === 'attachment' && obj.attachment && obj.attachment.type === 'queued_command'
        && obj.attachment.commandMode === 'prompt' && !obj.attachment.isMeta
        && (!obj.attachment.origin || obj.attachment.origin.kind === 'human')) {
        // „↪ Jetzt einspeisen": a message sent INTO a running turn is not a `user` line — the CLI keeps it as a
        // queued_command attachment (measured 07.10., 2.1.292; prompt = content array or string). Without this a resume
        // dropped it from the history although Claude had read it. Task notifications, agent and cross-session
        // messages ride the same channel with another mode or origin — those are not something you typed.
        const p = obj.attachment.prompt;
        const text = typeof p === 'string' ? p : extractText(p);
        if (text && text.trim() && !/^<(?:task-notification|agent-message|cross-session-message)[\s>]/.test(text.trim())) push({ kind: 'user', text, ts: obj.timestamp, injected: true });
      } else if (obj.type === 'user' && obj.message) {
        const text = extractText(obj.message.content);
        const trBlocks = Array.isArray(obj.message.content) ? obj.message.content.filter((b) => b && b.type === 'tool_result') : [];
        // H3: an isMeta line is harness bookkeeping, not something you typed. 8.62 % of all turns on the
        // corpus were phantom this way (up to 23.1 % in a single session), and it is not even visible as
        // a turn in the transcript, only in the count.
        if (obj.isMeta) { /* bookkeeping — neither a turn nor an event */ }
        else if (text.trim()) { push({ kind: 'user', text, ts: obj.timestamp }); meta.userTurns++; }
        else if (trBlocks.length) {
          const ev = { kind: 'tool_result', count: trBlocks.length, ts: obj.timestamp };
          if (withInputs) ev.results = trBlocks.map((b) => ({ tool_use_id: b.tool_use_id, is_error: !!b.is_error, text: capText(toolResultText(b), 4000) }));
          push(ev);
        }
      } else if (obj.type === 'assistant' && obj.message) {
        const text = extractText(obj.message.content);
        const toolBlocks = Array.isArray(obj.message.content) ? obj.message.content.filter((b) => b && b.type === 'tool_use') : [];
        const tools = withInputs ? toolBlocks.map(tailTool) : toolBlocks.map((b) => b.name);
        const thinking = Array.isArray(obj.message.content) && obj.message.content.some((b) => b && b.type === 'thinking');
        const aev = { kind: 'assistant', text, tools, thinking, ts: obj.timestamp };
        // G2 — only the NOTABLE stop reasons travel (turnEndStopBanner decides): `tool_use` and `end_turn`
        // are on virtually every assistant line of every transcript — 697 of 697 in the sample — and
        // carrying them would grow a 220-event tail by 220 fields that say „normal". The notable ones have
        // to survive a reload, or a cut-off answer reads like a finished one in the replayed tail.
        // No token / cost / model arithmetic beside it any more (see the note on `meta` above) — those
        // numbers come from the shared fold in readTranscript.
        if (turnEndStopBanner(obj.message.stop_reason)) aev.stopReason = String(obj.message.stop_reason);
        push(aev);
      }
    });
    rl.on('close', finish); rl.on('error', finish);
  });
}
// Cap the cache by ESTIMATED BYTES, not entry count: 80 entries of a 30MB transcript's parsed events
// is gigabytes, while 80 tiny sessions is nothing. Cost is approximated from the retained event text
// (a full JSON.stringify of every result just to measure it would defeat the purpose).
const TRANSCRIPT_CACHE_MAX_BYTES = 50 * 1024 * 1024;
let transcriptCacheBytes = 0;
function estimateResultBytes(result) {
  let n = 512; // meta + wrapper
  for (const ev of (result.events || [])) {
    n += 120; // per-event object overhead (kind/ts/flags)
    if (ev.text) n += ev.text.length * 2; // JS strings are UTF-16 in memory
    // (an ExitPlanMode's plan preview is up to 8000 characters of the event — PF-1, tailTool)
    if (Array.isArray(ev.tools)) for (const tl of ev.tools) n += typeof tl === 'string' ? tl.length * 2 + 16 : 256 + ((tl && tl.plan && typeof tl.plan.preview === 'string') ? tl.plan.preview.length * 2 : 0);
    if (Array.isArray(ev.results)) for (const r of ev.results) n += ((r.text || '').length * 2) + 96;
  }
  // PF-1 — the folded plan: ≤ 30 steps and ≤ 5 history entries, all capped (planSave), so it is a few KB —
  // but it is in the cached object, and an estimate that leaves something out is how the cap drifts
  for (const k of ['plan', 'planOrphan', 'planLast']) if (result[k]) { try { n += JSON.stringify(result[k]).length * 2; } catch { n += 4096; } }
  return n;
}
// The cost tile's numbers, taken from the SHARED fold so they are the same arithmetic the Usage page
// shows — including this session's subagent and workflow transcripts, reported separately so the tile can
// say "davon Subagenten" instead of quietly inflating the session.
async function transcriptMeta(project, id) {
  const m = { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, model: '', models: [], messages: 0, subTokens: 0, subCost: 0, subMessages: 0, agentFiles: 0, agents: [] };
  let recs;
  try { recs = await sessionRecs(project, id); } catch { return m; }
  const byModel = new Map();
  for (const rec of recs) {
    const isSub = rec.kind !== 'main';
    let subTok = 0, subCost = 0, subMsgs = 0;
    for (const day in rec.d) {
      for (const model in rec.d[day].m) {
        const b = rec.d[day].m[model];
        const usage = { input_tokens: b[0], output_tokens: b[1], cache_read_input_tokens: b[2], cache_creation_input_tokens: b[3], cache_creation: { ephemeral_5m_input_tokens: b[4], ephemeral_1h_input_tokens: b[5] } };
        const cost = costParts(usage, model).total;
        const toks = b[0] + b[1] + b[2] + b[3];
        m.input += b[0]; m.output += b[1]; m.cacheRead += b[2]; m.cacheWrite += b[3];
        m.messages += b[6]; m.cost += cost; m.tokens += toks;
        if (model !== '<synthetic>') byModel.set(model, (byModel.get(model) || 0) + toks);
        if (isSub) { subTok += toks; subCost += cost; subMsgs += b[6]; }
      }
    }
    if (isSub) {
      m.subTokens += subTok; m.subCost += subCost; m.subMessages += subMsgs; m.agentFiles++;
      m.agents.push({ agentId: rec.agentId, wf: rec.wf || '', tokens: subTok, cost: subCost, messages: subMsgs, models: Object.keys(rec.md) });
    }
  }
  m.agents.sort((a, b) => b.tokens - a.tokens);
  const ranked = [...byModel.entries()].sort((a, b) => b[1] - a[1]);
  m.models = ranked.map(([k]) => k);
  m.model = ranked.length ? ranked[0][0] : ''; // majority model, never the last frame that happened to carry one
  return m;
}
async function readTranscript(project, id, opts = {}) {
  const tail = opts.tail > 0 ? opts.tail : 0;
  const full = path.join(PROJECTS_DIR, project, id + '.jsonl');
  const st = await fsp.stat(full); // throws if missing → route returns 404 (same as the old readFile)
  const key = full + '|' + tail;
  const c = transcriptCache.get(key);
  if (c && c.mtime === st.mtimeMs && c.size === st.size) {
    // LRU touch: re-inserting moves the key to the end of the Map's insertion order, so the eviction
    // loop below always drops the LEAST recently used entry instead of the oldest-inserted one.
    transcriptCache.delete(key); transcriptCache.set(key, c);
    return c.result;
  }
  if (c) { transcriptCacheBytes -= c.bytes || 0; transcriptCache.delete(key); } // stale (file changed)
  const result = await parseTranscript(full, tail, tail > 0);
  // events-only fields (userTurns, firstTs, lastTs) win over the fold's. NOTE the cache key is this
  // transcript's (mtime, size): if an agent file of the session grows while the parent does not, the
  // „davon Subagenten" figure can lag by one request. In practice the parent grows with every turn, and
  // ↻ forces a fresh read.
  result.meta = Object.assign(await transcriptMeta(project, id), result.meta);
  const bytes = estimateResultBytes(result);
  transcriptCache.set(key, { mtime: st.mtimeMs, size: st.size, result, bytes });
  transcriptCacheBytes += bytes;
  while (transcriptCacheBytes > TRANSCRIPT_CACHE_MAX_BYTES && transcriptCache.size > 1) {
    const k = transcriptCache.keys().next().value;
    transcriptCacheBytes -= (transcriptCache.get(k).bytes || 0);
    transcriptCache.delete(k);
  }
  return result;
}

// capToolInput is exported for one reason: a test asserts that the resume path and the browser's
// hidden-tool store cap a tool input by the SAME rule — otherwise a rebuilt card would quietly differ
// from one painted out of the transcript.
module.exports = { scanSessions, searchSessions, readTranscript, capToolInput };
