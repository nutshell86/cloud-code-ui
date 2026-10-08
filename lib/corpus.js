'use strict';
// ONE fold over the transcript corpus — the only place a ~/.claude/projects/**.jsonl line is parsed.
//
// WHY this module exists at all (all figures measured on the live 586 MB corpus, 2026-10-02):
//   • scanSessions and scanUsage each streamed and JSON.parse'd the SAME 471 MB: 942.5 MB read,
//     297 of 297 files opened TWICE, 22-26 s for the cold pair. JSON.parse is the bottleneck
//     (43 MB/s), so reading the bytes once is the whole win.
//   • Both of them counted every usage LINE. One answer is written as several lines, each carrying the
//     FULL usage object (52,571 lines → 25,015 distinct message.id), so the panel reported 2.15x the
//     tokens and 2.52x the cost. The CLI's own `type:"cost-state"` frames settle it: on 146 of 150
//     transcripts that carry one, the CLI's summed outputTokens equals the DEDUPED total exactly.
//   • Subagent and workflow transcripts (<session>/subagents/**/agent-*.jsonl) were invisible, because
//     a non-recursive readdir + `.jsonl` filter never sees a directory named <uuid>.
//   • Neither path had an in-flight guard, so two concurrent requests folded the same tail into the
//     same object twice — and the over-count was then stored under the fresh (size, mtime) and served
//     as a valid cache hit forever.
//
// This module stores TOKENS, never money: a managed `modelPricing` can rewrite every rate for the whole
// machine (lib/models.js applyManagedPricing), and the dedup arithmetic stays integer. Cost is derived
// in the projections (lib/usage.js) through core.costParts — which is exact, because cost is LINEAR in
// every token field for a fixed model, so pricing a summed per-(day × model) bucket equals summing the
// per-message costs, provided the ephemeral cache split is carried (it is, see foldInto).
const fsp = require('fs/promises');
const path = require('path');
const { PROJECTS_DIR, CLAUDE_DIR, TRANSCRIPT_CACHE_FILE } = require('./paths');
const { foldLines, extractText, normalizeModel, writeJsonAtomic, errorText } = require('./core');
const PC = require('../public/js/projects-core'); // v4: the Jira key rule, shared with the project field

// ---------------------------------------------------------------------------
//  1. WHICH FILES
// ---------------------------------------------------------------------------
// Explicit depth, never a `**/*.jsonl` glob: the glob also matches the 13
// subagents/workflows/wf_*/journal.jsonl files (0 usage lines, and their `result` records are the
// agent's returned CONTENT) and would hand 167 ghost ids to everything that keys a session off a file
// name. Depth 1 keeps the OLD rule (any *.jsonl) so the session list cannot change; everything BELOW
// depth 1 is matched by name.
const AGENT_RE = /^agent-[0-9a-f]+\.jsonl$/i;
const WF_DIR_RE = /^wf_[0-9a-z-]+$/i;

async function readDirSafe(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

// The agent transcripts of ONE session. The parent is the <sessionUuid> DIRECTORY name — verified 154/154
// against the agent line's own sessionId and against agentId == filename stem. The path is the primary
// source because it is the one that exists before a single line has been read.
// -> { files: [], deeper: n }   deeper = a layout below the known one (meta.spawnDepth > 1)
async function listSessionAgents(project, session, dir) {
  const files = [];
  let deeper = 0;
  const sub = path.join(dir, session, 'subagents');
  for (const e of await readDirSafe(sub)) {
    if (e.isFile()) {
      if (AGENT_RE.test(e.name)) files.push({ kind: 'subagent', project, session, agentId: e.name.replace(/\.jsonl$/, ''), full: path.join(sub, e.name) });
      continue;
    }
    if (!e.isDirectory()) continue;
    // NOTE: "workflows" exists at TWO depths. <session>/workflows/ holds state JSON + script sources and a
    // `totalTokens` field that LOOKS like a billing number (1,053,610 claimed vs 47,731,944 actually
    // billed) — it is never opened. Only <session>/subagents/workflows/ holds transcripts, which is why
    // this walk descends from `subagents` and not from the session directory.
    if (e.name !== 'workflows') { deeper++; continue; }
    const wfRoot = path.join(sub, 'workflows');
    for (const w of await readDirSafe(wfRoot)) {
      if (!w.isDirectory() || !WF_DIR_RE.test(w.name)) continue;
      for (const a of await readDirSafe(path.join(wfRoot, w.name))) {
        if (a.isFile() && AGENT_RE.test(a.name)) files.push({ kind: 'workflow', project, session, wf: w.name, agentId: a.name.replace(/\.jsonl$/, ''), full: path.join(wfRoot, w.name, a.name) });
        else if (a.isDirectory()) deeper++;
      }
    }
  }
  return { files, deeper };
}
// -> { files: [{ kind, project, session, agentId?, wf?, full }], projects: [], deeper: n }
// kind 'main'     <project>/<sessionUuid>.jsonl                                    (297 live)
// kind 'subagent' <project>/<sessionUuid>/subagents/agent-<hex>.jsonl               (69 live)
// kind 'workflow' <project>/<sessionUuid>/subagents/workflows/wf_<id>/agent-<hex>.jsonl (85 live)
async function listCorpus() {
  const files = [], projects = [];
  let deeper = 0;
  for (const d of await readDirSafe(PROJECTS_DIR)) {
    if (!d.isDirectory()) continue;
    projects.push(d.name);
    const dir = path.join(PROJECTS_DIR, d.name);
    const sessionDirs = [];
    for (const e of await readDirSafe(dir)) {
      if (e.isDirectory()) { sessionDirs.push(e.name); continue; }
      if (e.name.endsWith('.jsonl')) files.push({ kind: 'main', project: d.name, session: e.name.replace(/\.jsonl$/, ''), full: path.join(dir, e.name) });
    }
    for (const session of sessionDirs) {
      const r = await listSessionAgents(d.name, session, dir);
      for (const f of r.files) files.push(f);
      deeper += r.deeper;
    }
  }
  if (deeper && !listCorpus._warned) { listCorpus._warned = true; console.warn('[corpus] ' + deeper + ' subagent director' + (deeper === 1 ? 'y' : 'ies') + ' deeper than the known layout — not folded, CLI layout may have changed'); }
  return { files, projects, deeper };
}

// ---------------------------------------------------------------------------
//  2. THE FOLD
// ---------------------------------------------------------------------------
const n0 = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
// LOCAL day, never String(ts).slice(0,10). The timestamps are UTC ("…Z"), the hour axis was already
// local, so the day key and the hour key disagreed — a genuine hybrid. Derived through the Date API and
// never from a fixed offset: every record on the corpus today resolves to +120 min (CEST), but the data
// crosses the DST boundary on 2026-10-25.
function dayKey(dt) {
  const p = (v) => (v < 10 ? '0' : '') + v;
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
}
// Is this a key dayKey() could have written? Derived FROM dayKey by round-tripping it, NOT pattern-matched:
// dayKey pads the month and the day but never the YEAR, so '999-06-05' and '275760-09-13' (the largest JS
// date) are legal keys that a /^\d{4}-/ check would reject — and rejecting a legal record is worse than
// adopting a bogus one, because it turns the cache into a permanent MISS that refolds 586 MB on every start
// (the same trap the f/l check above documents). '' is the undated bucket and legal.
// Why the cache must check the KEY and not only the values: the range filter compares day keys as ORDERED
// STRINGS, so one key the fold can never emit silently drops that whole bucket out of every window — and
// the adopted record is flushed back under the fresh fingerprint, so from then on it is a valid hit.
function validDay(k) {
  if (k === '') return true;
  const m = /^(\d+)-(\d{2})-(\d{2})$/.exec(k);
  if (!m) return false;
  const d = new Date(2000, +m[2] - 1, +m[3]);
  d.setFullYear(+m[1]); // Date(y,…) maps 0-99 to 1900+y, hence the separate setFullYear
  return !isNaN(d) && dayKey(d) === k;
}
function weekdayOf(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3]).getDay(); // local midnight of a LOCAL day key
}

function blankRec(info) {
  return {
    full: info.full, kind: info.kind, project: info.project, session: info.session,
    agentId: info.agentId || '', wf: info.wf || '',
    s: 0, m: 0, b: 0,                       // size / mtimeMs / bytesConsumed (resume state)
    lines: 0, msgs: 0, userTurns: 0,
    cwd: '', summary: '', preview: '',
    f: null, l: null,                       // first / last timestamp
    md: {},                                 // normalized model -> message count
    d: {},                                  // LOCAL day ('' = undated) -> { m: {model:[7]}, h: {model:[24]}|null }
    ids: {},                                // message.id (minus 'msg_') -> [in,out,cacheRead,cacheWrite,eph5m,eph1h,hour,ownerDay,ownerModel]
    cs: null,                               // the CLI's own cost-state verdict, when the file carries one
    // v4 — the cockpit's fields (projects P-2), MAIN transcripts only (see foldCockpit)
    slug: '',                               // the CLI's plan slug, last one wins (plans/<slug>.md)
    jk: {},                                 // Jira key typed by the user -> number of distinct MESSAGES naming it (≤ JK_MAX keys)
    jku: [],                                // uuids of the messages already counted into jk (the dedup memory, ≤ JKU_MAX)
    last: '', lastAt: null,                 // the last assistant text (≤ LAST_MAX) + its timestamp
    lp: '', lpAt: null,                     // the CLI's own `last-prompt` record (≤ LP_MAX) + the last timestamp seen before it
    recap: '', recapAt: null,               // the last system/away_summary (≤ LAST_MAX) + its timestamp
    // v5 — project drafts (P5), MAIN and agent transcripts (see foldTools): the counts are weights, never totals
    fd: {},                                 // folder a tool touched (absolute, ≤ FD_SEGS segments) -> tool calls (≤ FD_MAX keys)
    ms: {},                                 // MCP server a tool call went to -> tool calls (≤ MS_MAX keys)
    parseErrors: 0, foldErrors: 0, foldError: '',
  };
}
// Non-destructive resume: the tail is folded into a CLONE, and only the finished clone is published.
// A concurrent reader holding the previous record can therefore never observe a half-updated one.
function cloneRec(r) {
  const c = Object.assign({}, r);
  c.md = Object.assign({}, r.md);
  c.d = {};
  for (const day in r.d) {
    const src = r.d[day], dst = { m: {}, h: null };
    for (const mdl in src.m) dst.m[mdl] = src.m[mdl].slice();
    if (src.h) { dst.h = {}; for (const mdl in src.h) dst.h[mdl] = src.h[mdl].slice(); }
    c.d[day] = dst;
  }
  c.ids = {};
  for (const id in r.ids) c.ids[id] = r.ids[id].slice();
  c.jk = Object.assign({}, r.jk);
  c.jku = (r.jku || []).slice();
  c.fd = Object.assign({}, r.fd);
  c.ms = Object.assign({}, r.ms);
  return c;
}

// ---- v4: what the projects cockpit reads (measured on the live corpus, 290 main transcripts, 2026-10-05) ----
// slug → plan file is the strong signal (12/12 against ExitPlanMode); typed Jira keys are a WEAK hint (real in 11
// sessions, plus 25 automation sessions that carry the placeholders below); the CLI's `last-prompt` line is in
// 286/290 files, the last assistant text in 270/290, away_summary in 2 sessions only. gitBranch is NOT collected:
// in system32 it is HEAD in 56 of 56 sessions, i.e. worthless as a project signal.
// The key rule itself is projects-core's — the project field and this fold must agree on what a key is: the
// allow-list of prefixes (PR-, UTF-, ISO- … are noise, not tickets) and the automation's sample keys
// ACME-1234 / PROJ-456, which are never counted.
const JK_RE = new RegExp('\\b(' + PC.PROJECT_JIRA_PREFIXES.join('|') + ')-(\\d+)\\b', 'gi');
const JK_KEY_RE = PC.PROJECT_JIRA_KEY_RE;            // the shape of a stored key (upper case)
const JK_PLACEHOLDER = new Set(PC.PROJECT_JIRA_PLACEHOLDERS);
const JK_MAX = 12;                                   // distinct keys per session — a 43-key session is ambiguous anyway
const JKU_MAX = 200;                                 // remembered message uuids per session (FIFO)
const LAST_MAX = 600, LP_MAX = 300;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,159}$/i;       // a file-name stem — never a path, never `..`
// Cut WITHOUT splitting a surrogate pair (a lone high surrogate would reach the screen as „�").
function capText(s, n) {
  const t = String(s).trim();
  if (t.length <= n) return t;
  let k = n - 1;
  const c = t.charCodeAt(k - 1);
  if (c >= 0xd800 && c <= 0xdbff) k--;
  return t.slice(0, k) + '…';
}
// The text a HUMAN typed, out of a user line that already passed the typed-text gate. A text that starts with
// `<` is a harness frame (system-reminder, local-command-stdout, task-notification, …) EXCEPT for the arguments
// of a slash command the user typed — `/copy-jira ACME-1` arrives as <command-name>…<command-args>ACME-1</…>
// (13 of the real typed keys came that way).
function typedTextOf(tx) {
  if (!tx.startsWith('<')) return tx;
  const out = [];
  for (const m of tx.matchAll(/<command-args>([\s\S]*?)<\/command-args>/g)) out.push(m[1]);
  return out.join('\n');
}
// jk = { KEY: n } where n = the number of DISTINCT messages that name KEY. Per message uuid, because after a
// compaction the CLI writes typed lines a second time under the SAME uuid (42 such duplicates on the live corpus):
// counted per line, one real mention would read as two. The uuid memory lives in the record (and the cache), so a
// duplicate that arrives in a later, resumed tail is still recognised. First JK_MAX keys win — deterministic and
// resumable; a session naming more is ambiguous and only ever a weak hint.
function foldKeys(rec, o, tx) {
  const text = typedTextOf(tx);
  if (!text) return;
  const keys = new Set();
  for (const m of text.matchAll(JK_RE)) {
    if (JK_PLACEHOLDER.has(m[2])) continue;
    keys.add(m[1].toUpperCase() + '-' + m[2]);
  }
  if (!keys.size) return;
  const uuid = typeof o.uuid === 'string' && o.uuid ? o.uuid : '';
  if (uuid) {
    if (rec.jku.includes(uuid)) return;
    rec.jku.push(uuid);
    if (rec.jku.length > JKU_MAX) rec.jku.shift();
  }
  for (const k of keys) {
    if (rec.jk[k]) rec.jk[k]++;
    else if (Object.keys(rec.jk).length < JK_MAX) rec.jk[k] = 1;
  }
}
// Does this content carry a non-blank text block? /\S/ stops at the first visible character, so this is O(1) for
// any real text — the string itself is only built once per fold, in finishCockpit.
function hasText(content) {
  if (typeof content === 'string') return /\S/.test(content);
  if (!Array.isArray(content)) return false;
  for (const b of content) if (b && b.type === 'text' && typeof b.text === 'string' && /\S/.test(b.text)) return true;
  return false;
}
function finishCockpit(rec) {
  if (rec._lastC === undefined) return;
  rec.last = capText(extractText(rec._lastC), LAST_MAX);
  delete rec._lastC;
}
// The lines that are neither user/assistant traffic nor usage — handled before the main branch, each one cheap
// next to the JSON.parse that produced `o` (no extra parse, no extra read — see CACHE_V for the refold price).
function foldCockpitMeta(rec, o) {
  if (typeof o.slug === 'string' && o.slug !== rec.slug && SLUG_RE.test(o.slug)) rec.slug = o.slug;
  if (o.type === 'last-prompt') {
    // 12 of 7503 such lines carry no lastPrompt — they leave the previous one standing
    if (typeof o.lastPrompt === 'string' && o.lastPrompt.trim()) { rec.lp = capText(o.lastPrompt, LP_MAX); rec.lpAt = rec.l; }
    return true;
  }
  if (o.type === 'system' && o.subtype === 'away_summary') { // isMeta:true — so it must be caught before that gate
    if (typeof o.content === 'string' && o.content.trim()) { rec.recap = capText(o.content, LAST_MAX); rec.recapAt = o.timestamp || rec.recapAt; }
    return true;
  }
  return false;
}

// ---- v5: what the project drafts read (P5, lib/projects.js → projects-core projectClusters) ----
// Which folders a session WORKED in and which MCP servers it used — out of the tool calls, because the cwd says nothing
// in system32 (the panel's main folder: most sessions start there). Both the main AND the agent transcripts count: what a
// subagent reads is the session's work too. A folder is the tool's path minus the file name, cut to FD_SEGS segments
// (drive included: C:\Users\x\repo\lib), absolute only; a path through .claude, AppData or \WINDOWS\ is the harness or
// the system, never a project, and is skipped. First FD_MAX / MS_MAX keys win — deterministic and resumable, like jk.
const FD_MAX = 16, MS_MAX = 16, FD_SEGS = 5, FD_LEN = 200;
// tool -> [input field, is it a FILE (then the last segment goes)]
const FD_TOOLS = {
  Read: ['file_path', true], Edit: ['file_path', true], MultiEdit: ['file_path', true], Write: ['file_path', true],
  NotebookEdit: ['notebook_path', true], Glob: ['path', false], Grep: ['path', false],
};
const MCP_TOOL_RE = /^mcp__([\w.-]+?)__/;
const FD_SKIP_RE = /^(\.claude|appdata|windows)$/i;
// -> the folder key, or '' (not absolute, a share, a traversal, a skipped tree, too long). The SAME function validates a
// cached key (validRecJson: foldDir(k) === k), so the cache can only ever hold a key the fold could have written.
function foldDir(p, isFile) {
  if (typeof p !== 'string' || p.length > 1024 || p.indexOf('\0') >= 0) return '';
  const s = p.trim();
  const win = /^[A-Za-z]:[\\/]/.test(s);
  if (!win && !/^\/(?![\\/])/.test(s)) return '';                      // relative, UNC, device path
  const segs = (win ? s.split(/[\\/]+/) : s.split('/')).filter(Boolean);
  if (isFile) segs.pop();
  if (segs.some((x) => x === '.' || x === '..' || FD_SKIP_RE.test(x))) return '';
  const cut = segs.slice(0, FD_SEGS);
  if (cut.length < 2) return '';                                       // a bare drive / root says nothing
  let out;
  if (win) { cut[0] = cut[0].toUpperCase(); out = cut.join('\\'); } else out = '/' + cut.join('/');
  return out.length > FD_LEN ? '' : out;
}
function bump(obj, key, max) {
  if (Object.prototype.hasOwnProperty.call(obj, key)) obj[key]++;
  else if (Object.keys(obj).length < max) obj[key] = 1;
}
function foldTools(rec, content) {
  for (const b of content) {
    if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') continue;
    const m = MCP_TOOL_RE.exec(b.name);
    if (m) { if (PC.projectMcpNameOk(m[1])) bump(rec.ms, m[1], MS_MAX); continue; }
    const spec = Object.prototype.hasOwnProperty.call(FD_TOOLS, b.name) ? FD_TOOLS[b.name] : null;
    if (!spec || !b.input || typeof b.input !== 'object') continue;
    const dir = foldDir(b.input[spec[0]], spec[1]);
    if (dir) bump(rec.fd, dir, FD_MAX);
  }
}

// Everything every consumer needs, from ONE JSON.parse per line. Returns true only to stop the scan.
function foldInto(rec, line) {
  let o;
  try { o = JSON.parse(line); } catch { rec.parseErrors++; return false; }
  rec.lines++;
  if (!rec.cwd && o.cwd) rec.cwd = String(o.cwd); // authoritative project path (see lib/core decodeProject)
  if (o.timestamp) { if (!rec.f) rec.f = o.timestamp; rec.l = o.timestamp; }
  if (o.type === 'summary' && o.summary && !rec.summary) rec.summary = o.summary;
  // v4 — main transcripts only: in an agent file the „user" text is the parent MODEL's prompt, not a human's, and
  // the agent's last word is not the session's state. Keeping agents out also keeps ~150 files' texts out of the cache.
  const main = rec.kind === 'main';
  if (main && foldCockpitMeta(rec, o)) return false;
  // GROUND TRUTH — the CLI writes its own cost verdict into the transcript: 150 of 464 live files carry
  // a `cost-state` frame (2 carry two; the LAST one is the session snapshot). On 146 of 150 its summed
  // outputTokens equals the DEDUPED total EXACTLY, while counting every line matches 1 of 150 and is
  // 2.11x high — so this is what settles the dedup rule without a judgement call. Captured in the fold so
  // the regression oracle costs no second pass over 586 MB. Never a DATA source: only a third of the
  // transcripts have one, and one live session lists a model in modelUsage with no assistant frame at all.
  // Note the shape: camelCase (not message.usage's snake_case) and `thinkingTokens` is a SUBSET of
  // outputTokens, so adding it would double-count.
  if (o.type === 'cost-state') {
    let out = 0;
    const mu = (o.modelUsage && typeof o.modelUsage === 'object') ? o.modelUsage : {};
    for (const k in mu) out += n0(mu[k] && mu[k].outputTokens);
    rec.cs = { c: Number(o.totalCostUSD) || 0, o: out, unknown: !!o.hasUnknownModelCost };
    return false;
  }
  // v5 — not exclusive (the same line may carry usage), and for agents too: see foldTools
  if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) foldTools(rec, o.message.content);
  // H3 — isMeta is harness bookkeeping the CLI writes as a `type:"user"` line. 171 of them on the live
  // corpus, 0 with usage, so this cannot move a token or a cent; what it moves is the TURN count
  // (8.62 % corpus-wide, up to 23.1 % in one session) and, less obviously, the TITLE: 20 of 294
  // sessions took their preview from an isMeta line, because the old guard only rejected text starting
  // with '<' and 112 of the 171 lines do not.
  if (!o.isMeta && (o.type === 'user' || o.type === 'assistant')) {
    rec.msgs++;
    // v4: a compaction summary is not isMeta (70 of them pass this gate) — it is the CLI's text, neither typed by
    // the user nor the assistant's last word; a sidechain line in a main file is an old-style inline subagent
    const own = main && !o.isCompactSummary && !o.isSidechain;
    if (o.type === 'user' && o.message) {
      const tx = extractText(o.message.content).trim();
      if (tx) {
        if (!rec.preview && !tx.startsWith('<')) rec.preview = tx.slice(0, 240);
        rec.userTurns++; // same rule as the transcript viewer's „Deine Turns"
        if (own) foldKeys(rec, o, tx);
      }
    } else if (own && o.type === 'assistant' && o.message) {
      // One answer is several lines (one content block each), so the last text block wins — tool-only lines pass.
      // Only the REFERENCE is kept here; the text is extracted once per fold in foldFile (finishCockpit): building
      // and trimming the string on every one of ~60 000 assistant lines cost a measurable share of a refold.
      if (hasText(o.message.content)) { rec._lastC = o.message.content; rec.lastAt = o.timestamp || rec.lastAt; }
    }
  }
  if (o.type !== 'assistant' || !o.message || !o.message.usage) return false;

  const u = o.message.usage;
  const model = normalizeModel(o.message.model || '') || 'unknown';
  const inTok = n0(u.input_tokens), outTok = n0(u.output_tokens), crTok = n0(u.cache_read_input_tokens);
  // The ephemeral split is cost-relevant and must survive into the bucket: a 1h cache write bills at 2x
  // the input rate, a 5m one at 1.25x, and 307.7 M of 588.5 M cache-write tokens on this corpus are 1h.
  // A usage object with NO split prices at the flat 1.25x in core.costParts — the same rate as 5m — so
  // it goes into the 5m slot and the two paths agree to the cent.
  const cc = u.cache_creation;
  const hasSplit = !!cc && (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null);
  const cwTok = n0(u.cache_creation_input_tokens) || (hasSplit ? n0(cc.ephemeral_5m_input_tokens) + n0(cc.ephemeral_1h_input_tokens) : 0);
  const w1 = hasSplit ? n0(cc.ephemeral_1h_input_tokens) : 0;
  const w5 = hasSplit ? n0(cc.ephemeral_5m_input_tokens) : cwTok;

  const dt = o.timestamp ? new Date(o.timestamp) : null;
  const dated = !!dt && !isNaN(dt);
  // DEDUP — max-wins per message.id, PER FILE, counting only the INCREMENT so the fold stays additive
  // and therefore resumable. Per file is sufficient and is the only scope a per-file cache can express:
  // 0 of 25,015 ids appear in two files (main↔main, agent↔agent, main↔agent all 0).
  // max-wins and not first-wins: on MAIN transcripts the two are identical to the cent (the duplicates
  // there are byte-identical copies), but in the agent files the FIRST line of a group is a streaming
  // partial, and first-wins loses 95.0 % of subagent output. max-wins is also the only ORDER-INDEPENDENT
  // rule: 390 groups have non-monotonic timestamps and 2 shrink to all-zero lines, where "last wins"
  // would zero out a real answer.
  const id = o.message.id ? String(o.message.id).replace(/^msg_/, '') : '';
  let dIn = inTok, dOut = outTok, dCr = crTok, dCw = cwTok, d5 = w5, d1 = w1;
  let fresh = true, hour = dated ? dt.getHours() : -1;
  // OWNER BUCKET — one deduped record belongs to exactly ONE (day, model) bucket for its whole life: the
  // one its FIRST line opened ('' = undated). The increment has to correct THAT bucket, never the current
  // line's, and that is why the owner travels in rec.ids (and therefore through the cache) next to the
  // maxima. Booking it against the current line is wrong twice over: a group straddling a local day
  // credits the increase to a day that saw only the partial, and because the increment is per FIELD it can
  // be NEGATIVE in a field that shrank while the total grew (partial in=1000/out=0 → final in=0/out=2000)
  // — a subtraction in a bucket that never held those tokens, i.e. a negative row on the screen. 0 of the
  // 17,390 duplicated groups on the live corpus straddle a local day or a model today (measured
  // 2026-10-02), so neither half can be seen on today's data — which is exactly why it needs a test.
  let day = dated ? dayKey(dt) : '', bModel = model;
  if (id) {
    const prev = rec.ids[id];
    if (prev) {
      fresh = false;
      // 29 duplicate groups straddle a local HOUR (re-measured 2026-10-02; it grows with the corpus), so
      // the hour histogram needs ONE deterministic owner per deduped record: the group's first line — the
      // same owner the day/model bucket uses.
      if (prev[6] >= 0) hour = prev[6];
      if (typeof prev[7] === 'string') day = prev[7];
      if (prev[8]) bModel = prev[8];
      if (prev[0] + prev[1] + prev[2] + prev[3] >= inTok + outTok + crTok + cwTok) return false; // not the winner
      dIn -= prev[0]; dOut -= prev[1]; dCr -= prev[2]; dCw -= prev[3]; d5 -= prev[4]; d1 -= prev[5];
    }
    rec.ids[id] = [inTok, outTok, crTok, cwTok, w5, w1, hour, day, bModel];
  }
  // A usage line with NO message.id counts once. There is none in the live corpus (0 of 52,571) — but
  // the branch is load-bearing anyway: the assistant lines in test/fixtures/projects carry no `id`.

  // '' = undated. The old code silently DROPPED such a line (`if (!day) return false`); it is counted
  // here and reported, so a CLI that stops writing timestamps shows up instead of shrinking the totals.
  const bucket = rec.d[day] || (rec.d[day] = { m: {}, h: null });
  const mm = bucket.m[bModel] || (bucket.m[bModel] = [0, 0, 0, 0, 0, 0, 0]);
  mm[0] += dIn; mm[1] += dOut; mm[2] += dCr; mm[3] += dCw; mm[4] += d5; mm[5] += d1;
  // md counts ANSWERS per model, not lines — it is what "does this session use this model" and the agent
  // list are read from, and a per-line count there would carry the 2.15x over-count straight back in.
  if (fresh) { mm[6]++; rec.md[bModel] = (rec.md[bModel] || 0) + 1; }
  const toks = dIn + dOut + dCr + dCw;
  // Hours PER MODEL, not per day: the Usage view has a model filter, and a day-level histogram made the
  // punchcard show OTHER models' hours whenever the filtered model merely appeared on that day. Cheap —
  // 583 (day × model) buckets and 859 non-zero hour slots on the whole live corpus (464 files, measured
  // 2026-10-02), i.e. the per-model split costs 44 extra rows over the 539 day buckets.
  if (hour >= 0 && toks) {
    const hh = bucket.h || (bucket.h = {});
    const hm = hh[bModel] || (hh[bModel] = new Array(24).fill(0));
    hm[hour] += toks;
  }
  return false;
}

// `opts.onLine` is a TEST SEAM, and it exists for one reason: lib/core.js foldLines wraps the callback
// in `try { … } catch { /* a bad line must not kill the scan */ }`, so EVERY exception thrown inside the
// fold is swallowed — a defect here is invisible and reports a plausible-looking 0 tokens (one
// measurement run did exactly that). The counter below is the guard; test/corpus.test.js proves a
// throwing callback is NOTICED instead of vanishing.
function foldFile(full, start, rec, opts) {
  const hook = opts && opts.onLine;
  return foldLines(full, start, (line) => {
    try {
      if (hook) hook(line, rec);
      return foldInto(rec, line);
    } catch (e) {
      rec.foldErrors++;
      if (!rec.foldError) rec.foldError = errorText(e);
      return false;
    }
  }).then((b) => { finishCockpit(rec); return b; });
}

// ---------------------------------------------------------------------------
//  3. THE CACHE (in-memory + on disk)
// ---------------------------------------------------------------------------
const CACHE_V = 5; // bump whenever the record shape OR the counting semantics change (see below)
// v1 would have been the per-line counting; v2 is max-wins dedup + LOCAL day keys + subagents; v3 adds
// the per-id OWNER bucket (ids[…][7]=day, [8]=model) and moves the hour histogram per MODEL. An old cache
// that kept being served would quietly keep serving the old numbers — a v2 record has no owner day, so
// its next resumed duplicate would book the increment on the wrong day again. This is the first VERSIONED
// store in the repo (the other 12 are plain snapshots).
// v4 adds the cockpit fields (slug, jk + jku, last/lastAt, lp/lpAt, recap/recapAt — main transcripts only), all in
// ONE version so the corpus is refolded once, not once per field. A v3 record would be ADOPTED without them and
// never get them (a hit is never re-read), so the version has to move. THE PRICE, measured on the live corpus
// (2026-10-06, 1002 files / 296 main, machine under load): one full refold on the first scan after the update,
// 47 s cold (warm afterwards 2.2 s) — the session list and the Usage page wait for it once. Tokens and costs are
// identical to v3 (the usage branch is untouched); only the record grew by the capped texts.
// v5 adds fd + ms (P5, the project drafts) for main AND agent records, so every file is refolded once more; tokens and
// costs are again identical (the usage branch is untouched). Price: see the CHANGELOG (P5).
const recCache = new Map();  // absolute path -> rec
const inflight = new Map();  // absolute path -> Promise<rec>
let diskLoad = null;         // the ONE shared load promise (null = cold)
let diskDirty = false, flushTimer = null;

// SHAPE GUARD — a cache file that PARSES but whose records are not the shape the fold writes must be a
// MISS, exactly like a truncated one. Everything validated here is dereferenced straight into a money
// figure: an `md` that is an array, a `d[day].m[model]` that is a string or a token count that is negative
// or NaN puts a wrong total on the screen — and it STICKS, because the adopted record is re-stored under
// the fresh (size, mtime) and is a valid hit from then on. So: validate what we actually depend on, and
// on the first damaged record distrust the whole file (one wrong record means the writer is not the one we
// think it is) and refold — 471 files cost ~20 s once, a wrong number costs trust.
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const uint = (v) => typeof v === 'number' && isFinite(v) && v >= 0;
const numArr = (a, n) => Array.isArray(a) && a.length === n && a.every(uint);
function validRecJson(o) {
  if (!isObj(o)) return false;
  if (!uint(o.s) || !uint(o.m)) return false;                                         // the stat fingerprint
  for (const k of ['b', 'lines', 'msgs', 'userTurns']) if (o[k] != null && !uint(o[k])) return false;
  for (const k of ['k', 'project', 'session', 'cwd', 'summary', 'preview', 'agentId', 'wf', 'slug', 'last', 'lp', 'recap']) {
    if (o[k] != null && typeof o[k] !== 'string') return false;
  }
  // f / l are the transcript's own `timestamp` value, passed through UNCOERCED — and a CLI that wrote a
  // numeric epoch would be a legal transcript. Validated loosely on purpose: this guard must reject a
  // shape the fold cannot have written, never create a permanent MISS that refolds 586 MB on every start.
  // lastAt / recapAt are such a value too; lpAt is a copy of `l`.
  for (const k of ['f', 'l', 'lastAt', 'lpAt', 'recapAt']) if (o[k] != null && typeof o[k] !== 'string' && !(typeof o[k] === 'number' && isFinite(o[k]))) return false;
  // v4: jk keys are dereferenced as a ticket id (a link, a match against a project's keys) — only the shape the
  // fold writes, each with a count ≥ 1; jku is the dedup memory and must stay a bounded list of strings
  if (o.jk != null) {
    if (!isObj(o.jk)) return false;
    const ks = Object.keys(o.jk);
    if (ks.length > JK_MAX) return false;
    for (const k of ks) if (!JK_KEY_RE.test(k) || !uint(o.jk[k]) || o.jk[k] < 1) return false;
  }
  // v5: an fd key is a folder the fold wrote (foldDir round-trips it: absolute, cut, nothing skipped — a relative path or
  // `__proto__` is not one), an ms key a server name the start route would accept; counts ≥ 1, the caps hold
  if (o.fd != null) {
    if (!isObj(o.fd)) return false;
    const ks = Object.keys(o.fd);
    if (ks.length > FD_MAX) return false;
    for (const k of ks) if (foldDir(k, false) !== k || !uint(o.fd[k]) || o.fd[k] < 1) return false;
  }
  if (o.ms != null) {
    if (!isObj(o.ms)) return false;
    const ks = Object.keys(o.ms);
    if (ks.length > MS_MAX) return false;
    for (const k of ks) if (!PC.projectMcpNameOk(k) || !uint(o.ms[k]) || o.ms[k] < 1) return false;
  }
  if (o.jku != null && (!Array.isArray(o.jku) || o.jku.length > JKU_MAX || !o.jku.every((u) => typeof u === 'string'))) return false;
  if (o.md != null) { if (!isObj(o.md)) return false; for (const k in o.md) if (!uint(o.md[k])) return false; }
  if (o.d != null) {
    if (!isObj(o.d)) return false;
    for (const day in o.d) {
      if (!validDay(day)) return false;
      const b = o.d[day];
      if (!isObj(b) || !isObj(b.m)) return false;
      for (const mdl in b.m) if (!numArr(b.m[mdl], 7)) return false;                  // [in,out,cr,cw,e5,e1,msgs]
      if (b.h != null) { if (!isObj(b.h)) return false; for (const mdl in b.h) if (!numArr(b.h[mdl], 24)) return false; }
    }
  }
  if (o.ids != null) {
    if (!isObj(o.ids)) return false;
    for (const k in o.ids) {
      const a = o.ids[k];
      if (!Array.isArray(a) || a.length !== 9) return false;
      for (let i = 0; i < 6; i++) if (!uint(a[i])) return false;                       // the per-id maxima
      if (typeof a[6] !== 'number' || !isFinite(a[6])) return false;                   // owner hour (-1 = undated)
      if (typeof a[7] !== 'string' || typeof a[8] !== 'string') return false;          // owner day + model
      if (!validDay(a[7])) return false;                                               // …and the owner day must be one dayKey can write
    }
  }
  if (o.cs != null && (!isObj(o.cs) || !uint(o.cs.c) || !uint(o.cs.o))) return false;
  return true;
}

// KEY = the ABSOLUTE PATH, never the session id: POST /api/session/delete renames the transcript into
// BACKUP_DIR and the restore route renames it back — possibly into a DIFFERENT project dir derived from
// its cwd — and rename preserves size AND mtime.
// ONE shared promise, the same shape as the in-flight fold guard: setting a "loaded" flag BEFORE the await
// let a second concurrent caller walk past an EMPTY recCache and refold all 471 files from scratch, with
// whichever fold finished last winning.
function loadDiskCache() {
  if (!diskLoad) diskLoad = readDiskCache();
  return diskLoad;
}
async function readDiskCache() {
  // Missing, truncated, unparsable, v-mismatched, claudeDir-mismatched or structurally damaged = a MISS,
  // never an error (house style: readJsonFile / readPrefs all swallow). The claudeDir check matters because
  // CLAUDE_UI_CLAUDE_DIR lets a fixture corpus otherwise be read back as production.
  let raw = null;
  try { raw = JSON.parse(await fsp.readFile(TRANSCRIPT_CACHE_FILE, 'utf8')); } catch { return; }
  if (!raw || raw.v !== CACHE_V || raw.claudeDir !== CLAUDE_DIR || !isObj(raw.files)) return;
  for (const [full, o] of Object.entries(raw.files)) {
    if (!validRecJson(o)) { recCache.clear(); return; } // structural damage = the whole file is a MISS
    const rec = blankRec({ full, kind: o.k || 'main', project: o.project || '', session: o.session || '', agentId: o.agentId, wf: o.wf });
    Object.assign(rec, {
      s: o.s, m: o.m, b: o.b || 0, lines: o.lines || 0, msgs: o.msgs || 0, userTurns: o.userTurns || 0,
      cwd: o.cwd || '', summary: o.summary || '', preview: o.preview || '', f: o.f || null, l: o.l || null,
      md: o.md || {}, d: o.d || {}, ids: o.ids || {}, cs: o.cs || null,
      slug: o.slug || '', jk: o.jk || {}, jku: o.jku || [],
      last: o.last || '', lastAt: o.lastAt || null, lp: o.lp || '', lpAt: o.lpAt || null,
      recap: o.recap || '', recapAt: o.recapAt || null,
      fd: o.fd || {}, ms: o.ms || {},
    });
    recCache.set(full, rec);
  }
}
function recToJson(r) {
  const o = { s: r.s, m: r.m, b: r.b, k: r.kind, project: r.project, session: r.session, cwd: r.cwd, lines: r.lines, msgs: r.msgs, userTurns: r.userTurns, md: r.md, d: r.d, ids: r.ids };
  if (r.agentId) o.agentId = r.agentId;
  if (r.wf) o.wf = r.wf;
  if (r.summary) o.summary = r.summary;
  if (r.preview) o.preview = r.preview;
  if (r.f) o.f = r.f;
  if (r.l) o.l = r.l;
  if (r.cs) o.cs = r.cs;
  // v4 — written only when set: the ~300 agent records stay as small as before
  if (r.slug) o.slug = r.slug;
  if (r.jk && Object.keys(r.jk).length) o.jk = r.jk;
  if (r.jku && r.jku.length) o.jku = r.jku;
  if (r.last) { o.last = r.last; if (r.lastAt) o.lastAt = r.lastAt; }
  if (r.lp) { o.lp = r.lp; if (r.lpAt) o.lpAt = r.lpAt; }
  if (r.recap) { o.recap = r.recap; if (r.recapAt) o.recapAt = r.recapAt; }
  // v5 — only when set: most agent records touch no folder worth a key
  if (r.fd && Object.keys(r.fd).length) o.fd = r.fd;
  if (r.ms && Object.keys(r.ms).length) o.ms = r.ms;
  return o;
}
// The per-id maxima AND their owner bucket (day, model, hour) MUST survive into the next tail-parse, or a
// duplicate group split across a resume boundary double-counts resp. books its increment on the wrong day.
// Measured size for the live corpus: 1.81 MiB of ids / 2.1 MB total for 465 files = 0.36 % of the 586 MB
// it replaces; the largest single file holds 5,828 ids.
async function flushCache() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!diskDirty) return false;
  diskDirty = false;
  const files = {};
  for (const [full, r] of recCache) files[full] = recToJson(r);
  const body = { v: CACHE_V, claudeDir: CLAUDE_DIR, builtAt: new Date().toISOString(), files };
  try {
    await fsp.mkdir(path.dirname(TRANSCRIPT_CACHE_FILE), { recursive: true });
    await writeJsonAtomic(TRANSCRIPT_CACHE_FILE, JSON.stringify(body)); // no pretty-print: 2 MB
    return true;
  } catch { return false; } // a cache that cannot be written is a slow panel, not a broken one
}
const FLUSH_DEBOUNCE_MS = 5000;
function scheduleFlush() {
  if (!diskDirty || flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushCache(); }, FLUSH_DEBOUNCE_MS);
  if (flushTimer.unref) flushTimer.unref(); // must never hold a test process (or a CLI run) open
}

// IN-FLIGHT MAP — a CORRECTNESS fix, not a perf nicety. The code this replaces did
// `const entry = resume ? c.entry : blank()`, so two concurrent requests that saw the same stale entry
// took the SAME OBJECT and folded the same tail into it twice (proved on a fixture: 3,300 expected →
// 4,400 tokens; 6 of 6 attempts in the session path, with three concurrent responses disagreeing with
// each other). And it was STICKY: the poisoned aggregate was stored under the fresh (size, mtime) and
// was a valid cache hit from then on.
// The second caller awaits the first fold, so it may receive a record that is one append older than its
// own stat — which is exactly what a single shared fold means, and is never double-counted.
async function getRec(info, st) {
  const key = info.full;
  const have = recCache.get(key);
  if (have && have.s === st.size && have.m === st.mtimeMs) return have; // HIT, no read
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = buildRec(info, st, have).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
async function buildRec(info, st, have) {
  // Equality only, never ordering: 17 files have an mtime LATER than their own last record timestamp
  // (4 of them by more than a day) because the CLI appends untimestamped bookkeeping lines to
  // long-finished sessions. GREW → fold the tail; shrank, same size with a new mtime, or
  // bytesConsumed > size → full refold. `b` stays the authority over `size` because the stat happens
  // before the fold, so a file growing mid-fold legitimately yields b > size.
  const resume = !!(have && st.size > have.s && have.b <= st.size);
  const rec = resume ? cloneRec(have) : blankRec(info);
  rec.kind = info.kind; rec.project = info.project; rec.session = info.session;
  rec.agentId = info.agentId || ''; rec.wf = info.wf || '';
  rec.b = await foldFile(info.full, resume ? have.b : 0, rec);
  rec.s = st.size; rec.m = st.mtimeMs;
  recCache.set(info.full, rec);
  diskDirty = true;
  return rec;
}

// ---------------------------------------------------------------------------
//  4. THE SCAN both projections consume
// ---------------------------------------------------------------------------
// -> { recs, bySession: Map<'project/session', { project, session, main, agents[] }>, stats }
// Always readdir + stat every file (76-91 ms for 465): only the FOLD may be skipped, never the stat.
async function scanCorpus() {
  await loadDiskCache();
  const { files, projects, deeper } = await listCorpus();
  const recs = [], seen = new Set();
  const stats = { files: files.length, projects: projects.length, folded: 0, deeper, parseErrors: 0, foldErrors: 0, foldError: '', sidechainMismatch: 0 };
  for (const info of files) {
    let st; try { st = await fsp.stat(info.full); } catch { continue; } // vanished between readdir and stat
    seen.add(info.full);
    const before = recCache.get(info.full);
    const rec = await getRec(info, st);
    if (rec !== before) stats.folded++;
    recs.push(rec);
    stats.parseErrors += rec.parseErrors; stats.foldErrors += rec.foldErrors;
    if (rec.foldError && !stats.foldError) stats.foldError = rec.foldError;
  }
  for (const k of recCache.keys()) if (!seen.has(k)) { recCache.delete(k); diskDirty = true; } // prune deleted files
  scheduleFlush();
  const bySession = new Map();
  for (const rec of recs) {
    const key = rec.project + '/' + rec.session;
    let g = bySession.get(key);
    if (!g) { g = { project: rec.project, session: rec.session, main: null, agents: [] }; bySession.set(key, g); }
    if (rec.kind === 'main') g.main = rec; else g.agents.push(rec);
  }
  return { recs, bySession, stats };
}

// ONE session's records (its transcript + its agent transcripts), for the transcript route. Opening a
// transcript must not pay for a scan of the whole corpus — on a cold process that would be the full fold.
// Same records, same cache, same arithmetic as scanCorpus, just a narrower list.
async function sessionRecs(project, session) {
  await loadDiskCache();
  const dir = path.join(PROJECTS_DIR, project);
  const infos = [{ kind: 'main', project, session, full: path.join(dir, session + '.jsonl') }];
  for (const f of (await listSessionAgents(project, session, dir)).files) infos.push(f);
  const recs = [];
  for (const info of infos) {
    let st; try { st = await fsp.stat(info.full); } catch { continue; }
    recs.push(await getRec(info, st));
  }
  scheduleFlush();
  return recs;
}

// Test/diagnostic seam only — scanCorpus() is the API.
function _resetCorpusCache() { recCache.clear(); inflight.clear(); diskLoad = null; diskDirty = false; if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } }

module.exports = {
  listCorpus, listSessionAgents, foldFile, blankRec, cloneRec, getRec, scanCorpus, sessionRecs, flushCache,
  dayKey, weekdayOf, CACHE_V, _resetCorpusCache, foldDir,
  COCKPIT_CAPS: { JK_MAX, JKU_MAX, LAST_MAX, LP_MAX },
  DRAFT_CAPS: { FD_MAX, MS_MAX, FD_SEGS, FD_LEN },
};
