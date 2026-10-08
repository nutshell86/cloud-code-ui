'use strict';
// Shared IO / HTTP / settings helpers for the backend. Extracted from server.js (structure-only refactor)
// so lib/* domain modules and the router share one implementation. Depends only on node builtins + lib/paths.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { probePath, isNetworkPath } = require('./reach');
const { execFile, spawn } = require('child_process');
const {
  BACKUP_DIR, HOME, SESSIONS_DIR, PROJECTS_DIR, FAVORITES_FILE, NAMES_FILE, MCP_SEL_FILE, PREFS_FILE,
  UISKILL_RUNS_FILE, UISKILL_SCHEDULES_FILE, SKILL_FAV_FILE, PROMPTS_FILE, CORRECTIONS_FILE, SPEND_CACHE_FILE,
  PROMPT_HISTORY_FILE,
} = require('./paths');

// ---- HTTP response helpers ----
// The `res.end(body)` below is the sink CodeQL names in js/stack-trace-exposure (alert #45, 18 flows).
// It is deliberately NOT where that is decided — see errorText() right after sendText for the rule and
// the reason the filter cannot live here.
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}

// ---- the only way an exception's text reaches a client (js/stack-trace-exposure, alert #45) ----
// CodeQL counts 18 flows that end in sendJson's `res.end(body)`, and every one of them starts at a
// caught exception whose text a route puts into `{ error }`. The SINK cannot decide this: sendJson
// serialises every payload the panel has — settings text, transcripts, up to 200 000 characters of git
// patch, memory files that legitimately contain paths and code — so a filter sitting there would mangle
// content that was measured on purpose. The rule is therefore enforced on the way IN, here, and every
// place that turns an exception into something a client reads calls this one function.
//
// THE RULE — the message stays, a stack never leaves the process:
//  · The MESSAGE goes out verbatim. This panel is a local developer tool on 127.0.0.1, and the words of
//    the CLI or of Node are frequently the ONLY explanation the user gets for why something did not
//    work — the same decision that is already written down for the verbatim `error` of mcp_toggle and
//    for /api/doctor's output. Replacing it with "an error occurred" would throw away the one piece of
//    information that was actually measured, which is the mirror image of this project's own error
//    class. (The AI scanner raised exactly that demand once, as CWE-209-1 against the catch-all and
//    these routes; that alert is closed, the messages stayed.)
//  · A STACK TRACE does not. `err.stack` is read nowhere in a payload in this repo — all three reads are
//    console.error in server.js, i.e. the log — so the rule's remaining job is the frames that ride INSIDE a
//    message: execFile's "Command failed: …" text carries the child's stderr, and a crashing claude.exe
//    or an MCP server writes a V8 stack into it. Those frames name files and line numbers of code the
//    user cannot act on, and they are cut off here. The whole error, frames included, is logged
//    server-side by the router's catch-all instead (server.js, the `catch (e)` around the route table).
//  · Absolute PATHS are deliberately kept. "ENOENT … open 'C:\Users\…\settings.json'" is the answer to
//    the user's question, the panel displays those paths in a dozen other fields anyway (`dest`,
//    `restoredTo`, `path`), and the home directory of the person sitting in front of the panel is not a
//    secret from them. Redacting them here would cost the diagnosis and buy nothing measurable.
// A V8 frame line: a newline, indentation, "at ", and the rest of the line. The cut is at the FIRST
// such line, so everything the message said before it survives; a single-line message (the common case,
// e.g. every fs error) is returned untouched.
const STACK_FRAME_RE = /\n\s+at\s/;
function errorText(e) {
  if (e == null) return '';
  const raw = String((e && e.message) ? e.message : e);
  const cut = raw.search(STACK_FRAME_RE);
  return (cut >= 0 ? raw.slice(0, cut) : raw).trimEnd();
}

// client-input errors carry a statusCode so the router's catch-all can answer 400 instead of 500
function badRequest(msg) { const e = new Error(msg); e.statusCode = 400; return e; }

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(badRequest('body too large'), { statusCode: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw badRequest('invalid JSON body'); }
}

// ---- file read / atomic write / backup / per-path lock ----
// A file that does not parse keeps its TEXT (DATA-1). It used to come back as `raw: ''`, and the
// settings editor then showed `{}` as a valid, empty file — the next save wrote exactly that, and the
// Bedrock env block was gone. `parsed: null` + `raw` + `error` lets the editor show what is really
// there, and lets the write routes refuse to replace a file nobody has looked at.
// A file that cannot be READ at all (EPERM, EBUSY, a directory in its place) is a third case, flagged
// `unreadable`: there is no text to show, and an empty editor would read as "valid, empty" again.
async function readJsonFile(file) {
  let raw;
  try { raw = await fsp.readFile(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, raw: '', parsed: {} };
    return { exists: true, raw: '', parsed: null, unreadable: true, error: errorText(e) };
  }
  // A leading BOM is not a syntax error: Windows PowerShell 5.1 (`-Encoding UTF8`) and Notepad's
  // "UTF-8 with BOM" write one, and the CLI strips it before parsing. Without this the panel locked a
  // file Claude Code reads fine, behind an error about a character nobody can see. Only the PARSE skips
  // it — `raw` (and with it the If-Match hash) stays the exact text on disk.
  const body = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  try { return { exists: true, raw, parsed: body.trim() ? JSON.parse(body) : {} }; }
  catch (e) { return { exists: true, raw, parsed: null, error: errorText(e) }; }
}
// The version a client edited from: a hash of the file's TEXT, sent back as If-Match by the full-text
// editor (server.js PUT /api/config/settings). A missing file hashes like an empty one — both mean
// "nothing there", and a client that saw nothing may create it. An unreadable file gets a hash no text
// can have, so it never matches what a client saw of a missing or empty file.
const UNREADABLE_HASH = 'unreadable';
function textHash(raw) { return crypto.createHash('sha256').update(String(raw || ''), 'utf8').digest('hex'); }
async function readSettingsSnapshot(file) {
  const r = await readJsonFile(file);
  return Object.assign(r, { hash: r.unreadable ? UNREADABLE_HASH : textHash(r.raw) });
}

const BACKUP_KEEP = 30; // retain the newest N backups per file (ISO-stamped names sort chronologically)
async function backupFile(file) {
  try {
    await fsp.mkdir(BACKUP_DIR, { recursive: true });
    const base = path.basename(file);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `${base}.${stamp}.bak`);
    await fsp.copyFile(file, dest);
    // retention: prune oldest so a frequently-saved file can't grow BACKUP_DIR without bound
    try {
      const mine = (await fsp.readdir(BACKUP_DIR)).filter((f) => f.startsWith(base + '.') && f.endsWith('.bak')).sort();
      for (const f of mine.slice(0, Math.max(0, mine.length - BACKUP_KEEP))) { try { await fsp.unlink(path.join(BACKUP_DIR, f)); } catch { /* */ } }
    } catch { /* prune is best-effort */ }
    return dest;
  } catch (e) {
    if (e.code === 'ENOENT') return null; // nothing to back up yet
    throw e;
  }
}

async function writeSettings(file, parsedObj) {
  // Validate it's a plain object, pretty-print, back up existing, then write.
  if (parsedObj === null || typeof parsedObj !== 'object' || Array.isArray(parsedObj)) {
    throw new Error('Settings must be a JSON object');
  }
  const backup = await backupFile(file);
  const text = JSON.stringify(parsedObj, null, 2) + '\n';
  await writeJsonAtomic(file, text);
  return { backup };
}

// Crash-safe write: serialize to a temp file, then atomically rename over the
// target (rename is atomic on the same volume — a crash leaves the old file intact).
async function writeJsonAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  try { await fsp.writeFile(tmp, text, 'utf8'); await fsp.rename(tmp, file); }
  catch (e) { try { await fsp.unlink(tmp); } catch { /* */ } throw e; }
}
// Per-path mutex: chain operations on the same file so read-modify-write critical
// sections can't interleave (e.g. the scheduler tick vs. a schedule POST).
const _fileLocks = new Map();
const FILE_LOCK_TIMEOUT_MS = 30000;
// `opts.timeoutMs` exists for the test suite only (a 30-second stall is not something a test waits for).
function withFileLock(file, fn, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || FILE_LOCK_TIMEOUT_MS;
  const prev = _fileLocks.get(file) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // A critical section that never settles (a hung child, a lost await) would wedge EVERY later write
  // to this file for the life of the process — the panel would look alive but silently stop saving.
  // Cap it: 30s after THIS section starts, the lock is released for the next waiter and the stall is
  // logged. The caller's promise (`run`) is untouched — it still resolves with the real result.
  // The clock starts when fn STARTS, not when it is queued (KORR-3): it used to start at the call, so
  // a waiter behind a slow section spent its 30s in the queue, and its gate could open while it was
  // still running — the next section then ran concurrently with it, which is what the lock prevents.
  const start = () => {
    const t = setTimeout(() => { try { console.error('[withFileLock] ' + timeoutMs + 'ms timeout — releasing lock for ' + file); } catch { /* */ } release(); }, timeoutMs);
    if (t.unref) t.unref(); // a pending lock timer must not keep the process alive
    let p;
    try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
    const done = () => { clearTimeout(t); release(); };
    p.then(done, done);
    return p;
  };
  const run = prev.then(start, start);      // prev is a gate — it always resolves; run fn regardless
  _fileLocks.set(file, gate);
  // the last waiter leaves no entry behind (the map was keyed by every file ever locked)
  gate.then(() => { if (_fileLocks.get(file) === gate) _fileLocks.delete(file); });
  return run;
}

// ---- small JSON stores (app-owned data files) ----
// session-names.json and session-mcp.json are keyed by a Claude session id that arrives in a REQUEST
// BODY — the id IS the property name those routes write. Unchecked, a request picks the key itself:
// `__proto__` retargets the assignment at the object's prototype instead of an entry, and
// `constructor` / `toString` / `hasOwnProperty` plant an OWN property that shadows the Object.prototype
// member for every later reader of the file (`custom[id]`, `st[id]`). So the key is validated against
// the only shape a Claude session id ever has: the UUID the CLI mints for `--session-id` and names its
// <id>.jsonl transcript after. An allow-list by construction — the dangerous names cannot pass it.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidSessionId(v) { return typeof v === 'string' && SESSION_ID_RE.test(v); }

// <PROJECTS_DIR>/<project>/<id>.jsonl, or null if project/id may not name that file.
// The routes that read and that MOVE a transcript both used to build their own check, and both
// bounded the composed path with `path.join(PROJECTS_DIR, project)` — a bound derived from the very
// value it was meant to bound, so it could not reject anything; the whole protection sat in the
// character filter next to it. Here the bound is PROJECTS_DIR itself, which is a constant, and the
// two routes share one rule instead of disagreeing about what a legal `project` is.
function projectTranscriptPath(project, id) {
  for (const s of [project, id]) {
    if (typeof s !== 'string' || !s) return null;
    // Rejecting the characters is still the first step: it is what stops traversal. The resolve
    // below is the second, independent step — it catches what an enumeration of forbidden
    // characters misses (e.g. a platform-specific separator or a drive-relative segment).
    if (s.includes('..') || s.includes('/') || s.includes('\\') || s.includes('\0')) return null;
  }
  const root = path.resolve(PROJECTS_DIR);
  const file = path.resolve(root, project, id + '.jsonl');
  if (file !== path.join(root, project, id + '.jsonl')) return null;
  if (!file.startsWith(root + path.sep)) return null;
  return file;
}
// ---- the `cwd` a caller may name (GET /api/diff, GET /api/files — CWE-200, alert #5) ----
// Both routes take a directory from the query string and DO something in it: /api/diff runs five git
// processes there and returns up to 200 000 characters of patch, /api/files walks it to depth 6. The
// alert asks for an allow-list, and that is the one part of it this deliberately does NOT build. Two
// reasons, both measured rather than aesthetic:
//  · The PURPOSE of the routes is "the diff / the files of the directory this chat runs in", and that
//    directory is a free text field in the composer (#cwdInput, public/js/chat-composer.js). The panel
//    is used across many repos (this checkout, its worktrees, C:\Atlas, C:\Tooling, a game and a
//    scrum-master directory), so a list that has to be GUESSED either refuses a repo the user
//    legitimately typed — and the @-file picker would answer an empty list, which reads as "no files
//    here" — or it is derived from the cwds the panel already knows, which is EXACTLY the set an
//    attacker would be after. Containment that must admit every interesting directory protects
//    nothing; it only looks like protection.
//  · What is left after the 127.0.0.1 bind, the Host allow-list, the own-origin check and SEC-2
//    (cross-site → /api/ is 403 for a GET too, server.js) is an unauthenticated caller on the loopback
//    interface — another local user on a shared machine. No path rule closes that; a token on the API
//    does, and that is now BUILT, next door: ensureApiToken() below + the `/api/` gate in server.js
//    (N9). So this gate no longer stands alone, and this comment no longer points at a plan.
// So this is a SHAPE gate, and it earns its keep on one measured defect: `fs.statSync` on a UNC path
// whose host is unreachable blocks for 54 875 ms (measured 2026-10-03 against \\192.0.2.1\share,
// TEST-NET-1) — synchronously, in the one thread that serves every request, so a single GET froze the
// whole panel for nearly a minute. The same call also makes the panel's Windows identity authenticate
// to whatever SMB host the caller names. A relative path, meanwhile, silently resolved against the
// SERVER's process cwd, which is a directory no user picked.
// (Re-measured independently at pathExists() below: 44 505 ms for the same call against a different
// TEST-NET-1 host. The two numbers differ because the SMB/name-resolution retry budget differs per run,
// not because either is wrong — the finding is the ORDER of magnitude and who waits, not the digits.)
// → { dir } absolute + normalised · { dir: null } = "nothing given, use the route's own default" (a
// default is configuration, not input, so it is not gated) · { error, status }.
const UNC_OR_DEVICE_RE = /^[\\/]{2}/; // \\server\share, \\?\…, \\.\… and the / spellings of all three
// "Is this path one that may cost a network round trip to even LOOK at?" — one definition, two very
// different consumers, which is exactly why it lives here and not in either of them:
//  · the two read routes below REFUSE such a path (they would run git in it / walk it);
//  · lib/chat.js startChat PASSES IT THROUGH unchecked (the user may legitimately work on a share).
// The two answers must not be allowed to drift apart on what the question even means.
function isUncOrDevicePath(p) { return UNC_OR_DEVICE_RE.test(String(p == null ? '' : p).trim()); }
function resolveCwdParam(raw) {
  if (raw == null) return { dir: null };
  const s = String(raw).trim();
  if (!s) return { dir: null };
  if (s.includes('\0')) return { error: 'cwd must not contain a NUL byte', status: 400 };
  if (isUncOrDevicePath(s)) return { error: 'cwd must be a local path — no UNC or device path', status: 400 };
  if (!path.isAbsolute(s)) return { error: 'cwd must be an absolute path', status: 400 };
  return { dir: path.resolve(s) };
}

// ---- N9: the API token — the rest of alert #5 that no path rule can reach -------------------------
// 32 random bytes as hex (64 chars). Why a FILE and why STABLE across restarts: the token has to travel
// in the URL the launcher opens (`/?t=…`), because the gate must stand in front of the data, and a page
// that got the secret from the server would hand it to whoever may GET the page. A token regenerated per
// start would make every bookmark a one-time link; a stable one in a file keeps `http://127.0.0.1:8787/?t=…`
// working for ever, and the launcher reads the same file. The file's ONLY protection is its directory's
// ACL — see API_TOKEN_FILE in lib/paths.js for the icacls measurement that backs that claim.
// 0600 on the write is for the non-Windows case, where it IS the protection; on NTFS the mode is ignored
// (measured: the file inherits the three ACEs of the parent either way), so it is cheap honesty, not a
// second mechanism.
// The parameter is called `tokenFile`, not `file`, on purpose: test/sync-fs-paths.js keys its inventory of
// synchronous fs calls on `<file> | <fn> | <first argument verbatim>`, and a generic `file` would make the
// entry vouch for any future sync read in this module. The name IS the identity there.
function readApiToken(tokenFile) {
  try { return String(fs.readFileSync(tokenFile, 'utf8')).trim(); } catch { return ''; }
}
// Read-or-create, synchronously and once at boot: every later request compares against the value in
// memory, and a server that cannot write its token must say so rather than run unprotected — so the
// write error is NOT swallowed. Synchronous is safe here in the one way that matters (S3): the path is a
// constant from lib/paths, never a caller's, and this runs before server.listen(), so no request waits.
function ensureApiToken(tokenFile) {
  const have = readApiToken(tokenFile);
  if (have) return have;
  const tok = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFile, tok + '\n', { mode: 0o600 });
  return tok;
}
// Constant-time, and length-checked FIRST because timingSafeEqual throws a RangeError on different
// lengths — and the caller is the token gate in server.js, which sits BEFORE the request handler's
// try/catch. So the throw would not even become a 500: it rejects the async handler, the process-level
// net in server.js logs „[unhandledRejection] Input buffers must have the same byte length" and keeps the
// server alive — and NOTHING answers that request. Measured 2026-10-05 with this check removed: a 1-char
// token got no response within 4 s, the server was still running and answered the next request; every
// wrong-length guess leaves one socket hanging, and a legitimate user with a truncated token sees a page
// that loads for ever instead of the token screen. The timing argument is thin over loopback; the throw
// is not, and that is the real reason this is a function rather than `===`.
function apiTokenEquals(given, expected) {
  const a = Buffer.from(String(given == null ? '' : given), 'utf8');
  const b = Buffer.from(String(expected == null ? '' : expected), 'utf8');
  if (!b.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---- "is there something at this path?", asked without freezing the panel (S3) ----
// The async twins of `fs.existsSync(p)` and `fs.existsSync(p) && fs.statSync(p).isFile()`, and they
// exist because of a MEASUREMENT, not for tidiness. On this machine (2026-10-03, node v26.7.0, a fresh
// unrouted TEST-NET-1 host per case so Windows' negative name cache could not flatter the later ones):
//   fs.existsSync('\\192.0.2.12\share')   43 918 ms elapsed — 43 919 ms of it with the EVENT LOOP held
//   fs.statSync  ('\\192.0.2.11\share')   44 505 ms elapsed — 44 506 ms of it with the EVENT LOOP held
//   await fsp.stat('\\192.0.2.13\share')  53 973 ms elapsed —         93 ms of it with the loop held
// The wall-clock wait is the network's and no code here can shorten it. What changes is WHO waits: the
// sync form stops the single thread that serves every request, so one lookup froze the entire panel for
// three quarters of a minute; the async form stalls only the request that asked. That is the whole
// point — these are not faster, they are survivable.
//
// pathIsFile() additionally answers with ONE name lookup where the old idiom used two
// (`existsSync(p)` and then `statSync(p)` — CWE-367, the rule behind alert #79): between two lookups of
// the same name the thing can be replaced, so the second call need not describe what the first one
// judged. One stat, one answer, nothing to race.
//
// Both swallow EVERY rejection, deliberately: that is what existsSync did (it has no error path at all,
// not even for a non-string argument), and these are drop-in replacements for it — a changed answer for
// a bad input would be a behaviour change smuggled in under a performance fix. The sync throw that
// fs/promises raises for a non-string path lands in the same catch, because it happens inside an async
// function and is therefore a rejection.
//
// N12 — both now go through lib/reach.js probePath: the same single stat, but with a deadline of a few
// seconds, one stat per host at a time and a 60 s memory of a host that did not answer. Without it each
// call on a dead share still held one of libuv's four threadpool threads for ~54 s, and a dead
// `defaultCwd` did that on EVERY GET /api/state. An unreachable path answers `false`, as it did ~54 s
// later before. A route that owes the user the difference asks probePath itself (POST /api/chat/start).
async function pathExists(p) { return (await probePath(p)).state === 'ok'; }
async function pathIsFile(p) { const r = await probePath(p); return r.state === 'ok' && r.stat.isFile(); }
async function readFavorites() { try { const a = JSON.parse(await fsp.readFile(FAVORITES_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
async function writeFavorites(arr) { await writeJsonAtomic(FAVORITES_FILE, JSON.stringify(arr)); }
async function readCustomNames() { try { const o = JSON.parse(await fsp.readFile(NAMES_FILE, 'utf8')); return (o && typeof o === 'object') ? o : {}; } catch { return {}; } }
async function writeCustomNames(o) { await writeJsonAtomic(NAMES_FILE, JSON.stringify(o)); }
async function readMcpSel() { try { const o = JSON.parse(await fsp.readFile(MCP_SEL_FILE, 'utf8')); return (o && typeof o === 'object') ? o : {}; } catch { return {}; } }
async function writeMcpSel(o) { await writeJsonAtomic(MCP_SEL_FILE, JSON.stringify(o, null, 2)); }
async function readPrefs() { try { const o = JSON.parse(await fsp.readFile(PREFS_FILE, 'utf8')); return (o && typeof o === 'object') ? o : {}; } catch { return {}; } }
async function writePrefs(o) { await writeJsonAtomic(PREFS_FILE, JSON.stringify(o, null, 2)); }
// ui-skill-runs.json is the one app store that grows into megabytes (up to 40 KB of transcript per
// run), and SIX GET routes used to JSON.parse all of it on every request. Cache the parsed array by
// mtime+size and hand out a shallow copy, so a caller's push/splice can't corrupt the snapshot.
let _uiRunsCache = null; // { mtime, size, runs }
async function readUiRuns() {
  try {
    const st = await fsp.stat(UISKILL_RUNS_FILE);
    if (_uiRunsCache && _uiRunsCache.mtime === st.mtimeMs && _uiRunsCache.size === st.size) return _uiRunsCache.runs.slice();
    const a = JSON.parse(await fsp.readFile(UISKILL_RUNS_FILE, 'utf8'));
    const runs = Array.isArray(a) ? a : [];
    _uiRunsCache = { mtime: st.mtimeMs, size: st.size, runs };
    return runs.slice();
  } catch { return []; }
}
const UIRUNS_KEEP = 200;           // entry cap (unchanged)
const UIRUNS_TRANSCRIPT_KEEP = 20; // only the newest N keep their raw transcript
async function writeUiRuns(arr) {
  const kept = arr.slice(-UIRUNS_KEEP);
  const cut = kept.length - UIRUNS_TRANSCRIPT_KEEP;
  const out = kept.map((r, i) => {
    if (i >= cut || !r || !r.transcript) return r;
    // Rotate the raw text out of older entries: metadata + structured result stay (that's what the
    // history list and the stats need), only the bulky transcript goes — flagged so the viewer can
    // say WHY it's gone instead of opening an empty pane.
    return Object.assign({}, r, { transcript: '', transcriptRotated: true });
  });
  _uiRunsCache = null; // invalidate BEFORE the write: a concurrent reader must not get the old snapshot
  await writeJsonAtomic(UISKILL_RUNS_FILE, JSON.stringify(out)); // no pretty-print — nobody reads this by hand
}
async function readSchedules() { try { const a = JSON.parse(await fsp.readFile(UISKILL_SCHEDULES_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
async function writeSchedules(arr) { await writeJsonAtomic(UISKILL_SCHEDULES_FILE, JSON.stringify(arr.slice(-200), null, 2)); }
async function readSkillFavs() { try { const a = JSON.parse(await fsp.readFile(SKILL_FAV_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
async function writeSkillFavs(arr) { await writeJsonAtomic(SKILL_FAV_FILE, JSON.stringify(arr)); }
async function readPrompts() { try { const a = JSON.parse(await fsp.readFile(PROMPTS_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
async function writePrompts(arr) { await writeJsonAtomic(PROMPTS_FILE, JSON.stringify(arr.slice(0, 500), null, 2)); }
// A13 — the panel's own prompt history (the CLI's terminal history is read straight from
// ~/.claude/history.jsonl, see lib/history.js). The entry cap lives in lib/history appendPanelPrompt, so
// the writer decides how much history exists and this is only the file access.
async function readPromptHistory() { try { const a = JSON.parse(await fsp.readFile(PROMPT_HISTORY_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
async function writePromptHistory(arr) { await writeJsonAtomic(PROMPT_HISTORY_FILE, JSON.stringify(arr, null, 2)); }
// D4 — corrections ("nicht so, sondern so"). 200 entries on disk; how many of them actually reach a
// new session is a separate, tighter cap in lib/pure (CORRECTION_CAPS), so the store can keep history
// without the appended system prompt growing without bound.
async function readCorrections() { try { const a = JSON.parse(await fsp.readFile(CORRECTIONS_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
async function writeCorrections(arr) { await writeJsonAtomic(CORRECTIONS_FILE, JSON.stringify(arr.slice(-200), null, 2)); }
async function readSpendCache() { try { const o = JSON.parse(await fsp.readFile(SPEND_CACHE_FILE, 'utf8')); return (o && typeof o === 'object') ? o : { fetchedAt: null, data: null }; } catch { return { fetchedAt: null, data: null }; } }
async function writeSpendCache(o) { await writeJsonAtomic(SPEND_CACHE_FILE, JSON.stringify(o, null, 2)); }
// `await pathExists`, not `fs.existsSync` — and this one was the worst of the family, because the path
// is whatever the Settings field was last given and this function runs on GET /api/state, i.e. on every
// single load of the panel. A default cwd on a share that is up when it is saved and unreachable when the
// laptop is off the VPN therefore froze the panel's own state route for ~44 s at boot (see pathExists for
// the measurement). Unchanged in judgement: gone → HOME.
async function defaultCwd() { const p = await readPrefs(); return (p.defaultCwd && await pathExists(p.defaultCwd)) ? p.defaultCwd : HOME; }

// ---- concurrency helpers (bounded fan-out + route deadlines) ----
// Run `fn` over `items` with at most `limit` in flight. Keeps the result order of `items`.
// Used where an N+1 pattern would otherwise fire N requests/spawns at once (PR reviews, MCP probes).
async function mapLimit(items, limit, fn) {
  const list = Array.from(items || []);
  const out = new Array(list.length);
  let cursor = 0;
  const worker = async () => { while (cursor < list.length) { const i = cursor++; out[i] = await fn(list[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker));
  return out;
}
// Resolve `p`, or after `ms` resolve with `fallback` instead. Node has no cancellation, so the work
// keeps running in the background — callers must therefore be happy with a PARTIAL result (that's the
// point: a route on a corporate VPN must answer with what it has instead of hanging for a minute).
function withDeadline(p, ms, fallback) {
  return new Promise((resolve) => {
    let settled = false;
    const fin = (v) => { if (settled) return; settled = true; clearTimeout(t); resolve(v); };
    const t = setTimeout(() => fin(typeof fallback === 'function' ? fallback() : fallback), ms);
    if (t.unref) t.unref(); // a pending deadline must not hold the process open
    p.then(fin, () => fin(typeof fallback === 'function' ? fallback() : fallback));
  });
}

// ---- process / env helpers ----
// Secret masking is KEY-name based first (cheap, precise) and value-shape based second: a PAT lives
// just as often behind a harmless name (X_API, MY_HEADER, GH_PAT_FOR_CI) as behind "token". The
// value heuristics deliberately over-mask rather than leak — the MCP view is a config viewer, not a
// credential store.
const SECRET_KEY_RE = /token|secret|password|passwd|pwd|api[_-]?key|auth|credential|bearer/i;
// prefixes that are secrets by construction (auth schemes + well-known token formats)
const SECRET_PREFIX_RE = /^(Bearer\s|Basic\s|Token\s|ghp_|github_pat_|sk-|xox[bp]-)/i;
// opaque-token shape: long enough to be a credential and made only of token-safe characters
const TOKEN_CHARS_RE = /^[A-Za-z0-9_\-.=+/]+$/;
// URL carrying userinfo (https://user:secret@host/…) — the password is in the value, not the key
const URL_USERINFO_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/;
// Paths are the most common LONG env value in MCP configs (venv dirs, PYTHONPATH) and would all trip
// the opaque-token charset. Require 2+ separators (or a drive letter) so a base64 token that merely
// starts with '/' is still masked.
function looksLikePath(v) {
  if (/^[A-Za-z]:[\\/]/.test(v) || v.includes('\\')) return true;
  return (v.match(/\//g) || []).length >= 2;
}
function valueLooksSecret(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return false;
  if (SECRET_PREFIX_RE.test(s)) return true;
  if (URL_USERINFO_RE.test(s)) return true;
  return s.length >= 20 && TOKEN_CHARS_RE.test(s) && !looksLikePath(s);
}
function maskValue(val) { const s = String(val); return s.length <= 6 ? '••••' : s.slice(0, 2) + '••••' + s.slice(-2); }
// { value, masked, len } — `len` lets the UI render "•••• (50 Zeichen)" without ever seeing the secret.
function maskInfo(key, val) {
  const s = String(val == null ? '' : val);
  if (SECRET_KEY_RE.test(String(key)) || valueLooksSecret(s)) return { value: maskValue(s), masked: true, len: s.length };
  return { value: val, masked: false, len: s.length };
}
function maskEnvValue(key, val) { return maskInfo(key, val).value; }
// Mask a whole key→value map. Returns the masked values plus per-key {masked, len} metadata
// (metadata only for masked keys, so an all-plaintext map yields an empty `meta`).
function maskSecrets(obj) {
  const values = {}, meta = {};
  for (const k of Object.keys(obj || {})) {
    const info = maskInfo(k, obj[k]);
    values[k] = info.value;
    if (info.masked) meta[k] = { masked: true, len: info.len };
  }
  return { values, meta };
}
// ---- SEC-3: the two config fields the masking above could never see --------------------------------
// maskInfo/maskSecrets only ever got key→value MAPS handed to them (an MCP server's `env`, its
// `headers`). The same server's `args` and `url` travel to the browser as single opaque STRINGS — the
// MCP view's tile line (`views-mcp.js:87` s.transport), its detail block (`:106` command+args, url),
// "Config kopieren", and the Markdown inventory (`server.js` GET /api/mcp/inventory) — so nothing
// looked at them at all.
//
// MEASURED here first (2026-10-03, the 9 servers in this machine's ~/.claude.json): not one `args`
// token trips valueLooksSecret, and the single `url` carries neither userinfo nor a query string. So
// the hole is latent on this machine, exactly as the audit says. That is the reason to close it — the
// next `npx mcp-remote <url> --header "Authorization: Bearer …"` entry is one `claude mcp add` away —
// and NOT a licence to claim more than the code does.
//
// WHAT THIS COVERS / WHAT IT DOES NOT — the honest half of the fix:
//   · covers: a token-SHAPED argv token (valueLooksSecret — Bearer/Basic/ghp_/sk-/xox… prefixes, or
//     ≥20 opaque chars that are not a path), a `name=value` / `name: value` pair inside one argv token
//     whose NAME reads secret, the token that FOLLOWS a secret-named flag (`--token X`, `-H …`), a
//     URL's userinfo password, and a secret-named query parameter.
//   · does NOT cover: a short secret behind a harmless flag (`--key abc` — 3 chars, no shape), a secret
//     sitting in a URL PATH segment (a Slack webhook `/services/T…/B…/xxxx` offers no key name to
//     judge and no shape that a path does not also have), or a secret that looks like a file path.
//   · and it is deliberately NOT the allow-list that lib/chat.js mcpStatusRowSafe uses for
//     `config.headers`. An allow-list works there because the UI reads two known fields; it cannot
//     work here, because `args` and `url` ARE the fields the MCP view exists to show. Shape-based
//     masking is the weaker tool, and this is the place where it is the only one available.
//
// There is deliberately no `argsMasked`/`urlMasked` flag beside these: the `••••` is itself the visible
// signal in the one line that gets rendered, and a field no view reads is a finding in this repo, not
// progress. (env/headers carry {masked,len} because their view prints "•••• (50 Zeichen)".)
const SECRET_FLAG_VALUE = /^-{1,2}[A-Za-z]/;         // the token before a value: is it a flag at all?
// `name=value` / `name: value` inside ONE argv token — the two shapes a header or env pair takes there.
// The name part is anchored and narrow so a Windows path (`C:\Users\…`) and a URL (`https://…`) fall
// through to the value test below instead of being torn into a bogus pair.
const ARG_PAIR_RE = /^(-{0,2}[A-Za-z][\w.-]*)([=:])[ \t]*([\s\S]+)$/;
function maskArgToken(tok) {
  const s = String(tok == null ? '' : tok);
  const pair = ARG_PAIR_RE.exec(s);
  if (pair) {
    const info = maskInfo(pair[1].replace(/^-+/, ''), pair[3]);
    if (info.masked) return pair[1] + pair[2] + (pair[2] === ':' ? ' ' : '') + info.value;
  }
  return valueLooksSecret(s) ? maskValue(s) : s;
}
// An argv as an ARRAY. The one thing a per-token masker cannot see on its own: `--token` and its value
// are two separate tokens, so the previous token decides for the next one.
function maskArgv(argv) {
  const list = Array.isArray(argv) ? argv : [];
  return list.map((a, i) => {
    const prev = i > 0 ? String(list[i - 1]) : '';
    if (SECRET_FLAG_VALUE.test(prev) && !prev.includes('=') && SECRET_KEY_RE.test(prev.replace(/^-+/, ''))) {
      const s = String(a == null ? '' : a);
      // the value may itself be `Authorization: Bearer …` (that is how `-H` is passed) — mask the pair,
      // otherwise the whole token, because its NAME was the flag and the flag said "secret".
      const pair = ARG_PAIR_RE.exec(s);
      if (pair) return pair[1] + pair[2] + (pair[2] === ':' ? ' ' : '') + maskValue(pair[3]);
      return maskValue(s);
    }
    return maskArgToken(a);
  });
}
// The same for an argv that only exists as a PRINTED line (`claude mcp get`'s `Args:`, the `transport`
// string). Quotes are preserved so a masked line still reads like the command it describes.
function splitArgsLine(line) { return String(line == null ? '' : line).match(/(?:[^\s"]+|"[^"]*")+/g) || []; }
function maskArgsLine(line) {
  const toks = splitArgsLine(line);
  if (!toks.length) return String(line == null ? '' : line);
  const quoted = toks.map((tk) => /^"[\s\S]*"$/.test(tk));
  const bare = toks.map((tk, i) => (quoted[i] ? tk.slice(1, -1) : tk));
  return maskArgv(bare).map((v, i) => (quoted[i] ? '"' + v + '"' : v)).join(' ');
}
// A URL, masked by STRING SURGERY and not through `new URL().toString()`: the round trip normalises
// (adds a trailing slash, percent-encodes), and a panel that prints a URL differing from the config is
// its own small lie. An unchanged URL is therefore returned byte-identical.
const URL_USERINFO_CAP = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/;
function maskUrl(u) {
  let s = String(u == null ? '' : u);
  if (!s) return s;
  // the USER half stays readable — it is a name, not a credential; the password half is the secret
  s = s.replace(URL_USERINFO_CAP, (m, scheme, user, pw) => scheme + user + ':' + maskValue(pw) + '@');
  s = s.replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (m, sep, k, v) => {
    const info = maskInfo(k, v);
    return info.masked ? sep + k + '=' + info.value : m;
  });
  return s;
}
// What `claude mcp list` / ~/.claude.json call a server's "transport": a URL for http/sse, a printed
// `command args…` for stdio. One entry point so a route does not have to guess which it is.
function maskTransport(t) {
  const s = String(t == null ? '' : t);
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(s.trim()) ? maskUrl(s) : maskArgsLine(s);
}
// Kill a spawned child AND its descendants. On Windows child.kill() only signals the process we
// spawned — `claude.exe`, `uvx`, `npx` are launchers that fork a real node/python grandchild which
// survives, keeps its stdio pipes open and (for MCP probes) holds a server socket. taskkill /T walks
// the whole tree; /F forces it. POSIX keeps the plain kill (process groups aren't set up here).
// Returns a promise that settles once taskkill has answered, or after KILL_TREE_WAIT_MS, whichever is
// first (callers that only fire-and-forget can ignore it — shutdown and terminateChat await it).
//
// taskkill is never killed, and a SLOW taskkill never falls back to child.kill(). Measured 2026-10-05 on
// this machine (parent + detached grandchild, the shape of test/terminate-chat #19): taskkill /T takes
// 2.8–4.0 s idle (2.1–3.3 s even without /T — the tool itself is slow here), 3.9–9.6 s while ANOTHER
// process loads the machine (2×CPUs busy loops + steady process churn), and 11–16.5 s when that churn
// runs in the CALLER's own process — measured through the old execFile call; the call below (spawn,
// detached, no pipes) took 2.7–4.7 s under that same load, so not all of those seconds were the walk
// itself. The old code gave it
// `timeout: 5000`: execFile killed taskkill in the middle of the walk, and the fallback child.kill()
// ended the parent only — the one step that makes the rest of the tree unreachable, because taskkill /T
// walks from a LIVE parent. Under the foreign load that cut taskkill short in 2 of 10 runs (the grandchild
// happened to be dead already, taskkill takes it before the parent); under the in-process load it
// orphaned the grandchild (an MCP server, in real life) in 2 of 20 runs — it lived until it exited on
// its own, and terminateChat had reported the chat ended 220–340 ms before its parent was actually gone.
// So the bound is on how long a CALLER waits, not on the work: taskkill keeps going and finishes the tree.
// For the same reason it is DETACHED: libuv puts every non-detached child into a kill-on-close job, so a
// server that exits (shutdown, restart) mid-walk would take taskkill with it — test/terminate-chat
// „a server that EXITS while taskkill is still walking" is red without `detached`. No pipes, simply
// because only the exit code is read — with pipes the tree still went (measured), so that is tidiness,
// not a fix.
// child.kill() is only the answer to an ERROR (no taskkill on this machine, a pid it cannot find) — then
// the tree cannot be walked anyway, and only while the child is still running.
// 30 s ≈ twice the slowest run measured (16.5 s). Idle it changes nothing: taskkill answers after ~3 s
// and the promise settles then.
const KILL_TREE_WAIT_MS = 30000;
function killTree(child, opts) {
  const pid = child && child.pid;
  if (!pid || process.platform !== 'win32') { try { child && child.kill(); } catch { /* already gone */ } return Promise.resolve(); }
  const waitMs = (opts && Number.isFinite(opts.waitMs)) ? opts.waitMs : KILL_TREE_WAIT_MS;
  const running = () => child.exitCode === null && child.signalCode === null;
  return new Promise((resolve) => {
    let wait = null;
    const settle = () => { if (wait) { clearTimeout(wait); wait = null; } resolve(); };
    const fallback = () => { if (running()) { try { child.kill(); } catch { /* already gone */ } } settle(); };
    let tk;
    try {
      tk = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, detached: true, stdio: 'ignore' });
    } catch { fallback(); return; }
    tk.once('error', fallback); // no taskkill on this machine
    tk.once('exit', (code) => { if (code !== 0) fallback(); else settle(); });
    wait = setTimeout(settle, waitMs);
    if (wait.unref) wait.unref();
  });
}
// After the kill, how long run() still waits for the child's pipes to close before it resolves anyway.
const RUN_KILL_GRACE_MS = 3000;
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeout || 15000;
    // NO `timeout` option for execFile any more (B2/FLOW-1): its own timeout only sends SIGTERM to the
    // process it spawned. With shell:true (npm) and with launchers (claude.exe, uvx, npx) that is a
    // cmd.exe/launcher whose grandchild keeps the stdout/stderr pipes open — execFile's callback waits
    // for 'close', which then never comes, and the route that awaited run() hung with it (the
    // "Hänger" of the CLI update and the `npm view` in /api/sysinfo). So: our own timer, a TREE kill,
    // and a hard resolve RUN_KILL_GRACE_MS after the kill whether the pipes ever close or not.
    const o = { windowsHide: true, shell: !!opts.shell, maxBuffer: 8 * 1024 * 1024 };
    if (opts.cwd) o.cwd = opts.cwd;
    if (opts.env) o.env = opts.env;
    let done = false, timer = null, hard = null, killed = false;
    // what the child wrote so far — the hard-resolve path has no execFile callback to hand it over
    let outSoFar = '', errSoFar = '';
    const CAP = 256 * 1024;
    const finish = (err, stdout, stderr) => {
      if (done) return; done = true;
      if (timer) clearTimeout(timer);
      if (hard) clearTimeout(hard);
      if (killed) {
        // `err.killed === true` is the contract the callers read for "timed out" (lib/cli.js
        // runCliUpdate, /api/version/pull). execFile only sets it when IT did the killing — a
        // taskkill'd child just reports exit code 1 — so it is set here, explicitly.
        if (!err) err = new Error('timed out after ' + Math.round(timeoutMs / 1000) + 's');
        err.killed = true;
        if (!err.code) err.code = 'ETIMEDOUT';
        if (!/timed out/i.test(String(err.message || ''))) { try { err.message = 'timed out after ' + Math.round(timeoutMs / 1000) + 's: ' + err.message; } catch { /* */ } }
      }
      resolve({ err, stdout: String(stdout == null ? '' : stdout).trim(), stderr: String(stderr == null ? '' : stderr).trim() });
    };
    // execFile can throw SYNCHRONOUSLY (a misconfigured CLAUDE_UI_CLAUDE_BIN gives `spawn EFTYPE`,
    // a missing cwd gives ENOENT) — not every failure arrives via the callback. Unwrapped, that threw
    // straight out of the route and the router's catch-all answered 500 on /api/doctor, /api/auth,
    // /api/sysinfo, /api/mcp*. A failed spawn is a normal error result, not a server fault.
    let child;
    try {
      child = execFile(cmd, args, o, (err, stdout, stderr) => finish(err, stdout, stderr));
    } catch (e) { resolve({ err: e, stdout: '', stderr: errorText(e) }); return; }
    // EOF on stdin right away: nothing ever writes to it, and a child that stops to ASK (git's
    // credential prompt, an npm/updater confirmation) otherwise waited on an open pipe until the
    // timeout. The error listener matters: ending the stdin of a child that already died (ENOENT)
    // emits EPIPE asynchronously, and unhandled that is an uncaughtException.
    try { if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(); } } catch { /* */ }
    try { if (child.stdout) child.stdout.on('data', (d) => { if (outSoFar.length < CAP) outSoFar += d; }); } catch { /* */ }
    try { if (child.stderr) child.stderr.on('data', (d) => { if (errSoFar.length < CAP) errSoFar += d; }); } catch { /* */ }
    timer = setTimeout(() => {
      killed = true;
      // The grace starts when taskkill has ANSWERED, not when it was launched: taskkill itself takes
      // ~3 s on this machine (measured, even for a pid that no longer exists), so a grace counted from
      // the launch expired before the kill had happened and resolved with the tree still alive. Bounded
      // anyway: killTree waits at most KILL_TREE_WAIT_MS for that answer, so the worst case is
      // timeout + KILL_TREE_WAIT_MS + RUN_KILL_GRACE_MS (taskkill itself may still be finishing the tree).
      const arm = () => { if (!done) hard = setTimeout(() => finish(null, outSoFar, errSoFar), RUN_KILL_GRACE_MS); };
      killTree(child).then(arm, arm);
    }, timeoutMs);
  });
}

// ---- project path <-> encoded name, content-text, frontmatter ----
function decodeProject(name) {
  // DISPLAY FALLBACK ONLY — the encoding is lossy: encodeProject() maps ':' '\' '/' AND leaves real
  // hyphens alone, so "C--Users-me-claude-code-ui" decodes to "C:\Users\me\claude\code\ui" instead of
  // "…\claude-code-ui". Anything that needs a usable cwd (resume, git, @-files) must take it from the
  // transcript via projectCwd()/firstCwdOf() — a wrong cwd made chat.js fall back to HOME silently.
  let s = name;
  const m = s.match(/^([A-Za-z])--(.*)$/);
  if (m) s = m[1] + ':\\' + m[2].replace(/-/g, '\\');
  else s = s.replace(/-/g, '\\');
  return s;
}
function encodeProject(cwd) { return String(cwd || '').replace(/[:\\/]/g, '-'); } // "C:\WINDOWS\system32" -> "C--WINDOWS-system32"
// Stream `file` from byte offset `start` and hand every COMPLETE line to onLine(text); resolves with
// the byte offset just after the last complete line. onLine may return true to stop early.
// Raw Buffers (no stream encoding) are what make the offset EXACT: a resumed parse has to restart on a
// line boundary, and a character count is not a byte count once umlauts/emoji appear. '\n' (0x0A) can
// never occur inside a multi-byte UTF-8 sequence, so splitting on it and keeping the tail as a Buffer
// cannot cut a character in half. A trailing partial line (the active session is being written to
// right now) is deliberately NOT consumed — it gets re-read on the next pass.
function foldLines(file, start, onLine) {
  return new Promise((resolve) => {
    let consumed = start || 0, rest = null, done = false, stream;
    const finish = () => { if (done) return; done = true; try { stream && stream.destroy(); } catch { /* */ } resolve(consumed); };
    try { stream = fs.createReadStream(file, { start: consumed }); } catch { return resolve(consumed); }
    stream.on('error', finish);
    stream.on('data', (chunk) => {
      const buf = rest && rest.length ? Buffer.concat([rest, chunk]) : chunk;
      let from = 0, i;
      while ((i = buf.indexOf(0x0a, from)) >= 0) {
        const text = buf.toString('utf8', from, i).replace(/\r$/, '');
        consumed += (i - from) + 1;
        from = i + 1;
        if (text) { let stop = false; try { stop = onLine(text) === true; } catch { /* a bad line must not kill the scan */ } if (stop) { rest = null; return finish(); } }
      }
      rest = from < buf.length ? buf.subarray(from) : null;
    });
    stream.on('end', finish);
    stream.on('close', finish);
  });
}
// Authoritative cwd of a transcript: the first record that carries one (the very first lines can be
// bookkeeping types — queue-operation / ai-title / mode — with no cwd). Streamed and stopped at the
// first hit, so a 100MB backup costs a few KB of reads instead of a full readFile+split.
const CWD_SCAN_MAX_LINES = 200; // a transcript that has no cwd in its first 200 records has none
// Real cwd per project DIRECTORY, so callers that have no transcript at hand (memory files, search
// hits) get the authoritative path too. Filled for free by the session/usage parsers via
// setProjectCwd(); resolved from the newest transcripts on a miss. null = genuinely unknown.
const projectCwdCache = new Map(); // dirName -> { at, cwd }
const PROJECT_CWD_TTL_MS = 5 * 60 * 1000;
function setProjectCwd(dirName, cwd) { if (dirName && cwd) projectCwdCache.set(dirName, { at: Date.now(), cwd }); }
async function projectCwd(dirName) {
  const hit = projectCwdCache.get(dirName);
  if (hit && Date.now() - hit.at < PROJECT_CWD_TTL_MS) return hit.cwd;
  const dir = path.join(PROJECTS_DIR, dirName);
  let cwd = null;
  try {
    const stated = [];
    for (const f of await fsp.readdir(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      try { stated.push({ f, m: (await fsp.stat(path.join(dir, f))).mtimeMs }); } catch { /* */ }
    }
    stated.sort((a, b) => b.m - a.m);
    for (const s of stated.slice(0, 3)) { cwd = await firstCwdOf(path.join(dir, s.f)); if (cwd) break; } // newest first
  } catch { /* dir gone */ }
  projectCwdCache.set(dirName, { at: Date.now(), cwd });
  return cwd;
}
// one place that decides which path to show/use: transcript cwd > cached project cwd > lossy decode
function projectPathOf(dirName, cwdFromParse) {
  if (cwdFromParse) { setProjectCwd(dirName, cwdFromParse); return cwdFromParse; }
  const hit = projectCwdCache.get(dirName);
  return (hit && hit.cwd) || decodeProject(dirName);
}
function firstCwdOf(file) {
  return new Promise((resolve) => {
    let stream, rl, done = false, seen = 0;
    const finish = (v) => { if (done) return; done = true; try { rl && rl.close(); } catch { /* */ } try { stream && stream.destroy(); } catch { /* */ } resolve(v); };
    try { stream = fs.createReadStream(file, { encoding: 'utf8' }); } catch { return resolve(null); }
    stream.on('error', () => finish(null));
    rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line) return;
      if (++seen > CWD_SCAN_MAX_LINES) return finish(null);
      try { const o = JSON.parse(line); if (o && o.cwd) return finish(String(o.cwd)); } catch { /* partial/invalid line */ }
    });
    rl.on('close', () => finish(null));
    rl.on('error', () => finish(null));
  });
}
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}
function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (mm) fm[mm[1]] = mm[2].replace(/^["']|["']$/g, '').trim();
  }
  return fm;
}

// ---- session title selection + per-file name cache ----
function titleFrom(item) {
  // content-derived title from summary/first prompt; null when there's nothing.
  let base = (item.summary || item.preview || '').trim();
  if (!base) return null;
  let line = base.split('\n').map((l) => l.trim()).find((l) => l) || base;
  line = line.replace(/^#+\s*/, '').replace(/^[-*>]\s*/, '').replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
  if (line.length > 64) line = line.slice(0, 63).replace(/\s\S*$/, '') + '…';
  return line || null;
}
function projBasename(project) {
  // accepts either an encoded dir name or an already-resolved real path (encoded names never contain
  // a separator) — with the real path the basename is correct even for hyphenated dirs
  const s = String(project || '');
  const p = /[\\/]/.test(s) ? s : (decodeProject(s) || '');
  return (p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '').toLowerCase();
}
// Claude Code auto-names sessions "<cwd-basename>-<short hex>" (e.g. system32-38).
function isGenericCliName(name, project) {
  if (!name) return false;
  const b = projBasename(project).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return b ? new RegExp('^' + b + '-[0-9a-f]{1,6}$', 'i').test(name.trim()) : false;
}
// priority: panel custom rename > meaningful CLI /rename > content title > generic CLI name > id
function chooseTitle(item, custom, names) {
  if (custom[item.id]) return { title: custom[item.id], custom: true };
  const cli = names[item.id];
  // prefer the resolved projectPath: the CLI auto-name is "<cwd-basename>-<hex>", and the lossy
  // decode of a hyphenated dir yields the wrong basename (→ a generic name looked "meaningful")
  if (cli && !isGenericCliName(cli, item.projectPath || item.project)) return { title: cli, custom: true };
  const content = titleFrom(item);
  if (content) return { title: content, custom: false };
  if (cli) return { title: cli, custom: false };
  return { title: 'Session ' + item.id.slice(0, 8), custom: false };
}
// one sessionId can have several <pid>.json files; keep the newest name per sessionId. mtime-cached.
const sessionNameCache = new Map(); // fp -> { mtime, sessionId, name }
async function readSessionNames() {
  const map = {}, mt = {};
  let files = [];
  try { files = await fsp.readdir(SESSIONS_DIR); } catch { return map; }
  const seen = new Set();
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const fp = path.join(SESSIONS_DIR, f); seen.add(fp);
    try {
      const st = await fsp.stat(fp);
      let c = sessionNameCache.get(fp);
      if (!c || c.mtime !== st.mtimeMs) { const o = JSON.parse(await fsp.readFile(fp, 'utf8')); c = { mtime: st.mtimeMs, sessionId: o.sessionId, name: o.name }; sessionNameCache.set(fp, c); }
      if (c.sessionId && c.name && (mt[c.sessionId] == null || st.mtimeMs > mt[c.sessionId])) { map[c.sessionId] = c.name; mt[c.sessionId] = st.mtimeMs; }
    } catch { /* */ }
  }
  for (const k of sessionNameCache.keys()) if (!seen.has(k)) sessionNameCache.delete(k);
  return map;
}

// ---- cost estimation (USD per 1M tokens; estimates for the Usage view) ----
// A Bedrock id ("eu.anthropic.claude-haiku-4-5-20251001-v1:0") has to reduce to the same PRICING key as
// the bare name the first-party API reports ("claude-haiku-4-5"), or the same turn is priced on one
// auth path and counted as unpriced on the other. That reduction lives in lib/models.js next to the
// candidate table it was derived from; this is only the cost-side name for it.
function normalizeModel(m) {
  if (!m) return '';
  return bedrockBase(m);
}
// PRICING now lives in lib/models.js (single source of truth, shared with the /api/models endpoint).
// Read through pricingFor(), not off the table directly: a managed `modelPricing` can replace the
// rates for the whole machine, and the aggregation here must not price a turn differently from the
// footer the user read in the chat.
const { PRICING, pricingFor, bedrockBase } = require('./models');
// `priced` tells callers whether the model was actually in the PRICING table. Without it an unknown
// model (a new alias, a Bedrock id, "unknown") is indistinguishable from a genuinely free one: the
// Usage view then showed a cost total that silently EXCLUDED those tokens and looked complete.
function costParts(usage, model) {
  const p = pricingFor(normalizeModel(model));
  const priced = !!p;
  if (!p || !usage) return { inCost: 0, outCost: 0, crCost: 0, cwCost: 0, total: 0, priced };
  const inP = p.in / 1e6, outP = p.out / 1e6;
  const cc = usage.cache_creation || {};
  const w5 = cc.ephemeral_5m_input_tokens, w1 = cc.ephemeral_1h_input_tokens;
  const cwCost = (w5 != null || w1 != null)
    ? (w5 || 0) * inP * 1.25 + (w1 || 0) * inP * 2
    : (usage.cache_creation_input_tokens || 0) * inP * 1.25;
  const inCost = (usage.input_tokens || 0) * inP;
  const outCost = (usage.output_tokens || 0) * outP;
  const crCost = (usage.cache_read_input_tokens || 0) * inP * 0.1;
  return { inCost, outCost, crCost, cwCost, total: inCost + outCost + crCost + cwCost, priced };
}
// back-compat: still 0 for an unknown model (callers that only want a number keep working)
function costOf(usage, model) { return costParts(usage, model).total; }

module.exports = {
  sendJson, sendText, errorText, readBody, readJsonBody, readJsonFile, readSettingsSnapshot, textHash,
  BACKUP_KEEP, backupFile, writeSettings, writeJsonAtomic, withFileLock, mapLimit, withDeadline,
  isValidSessionId, projectTranscriptPath, resolveCwdParam, isUncOrDevicePath, pathExists, pathIsFile, probePath, isNetworkPath,
  readApiToken, ensureApiToken, apiTokenEquals,
  readFavorites, writeFavorites, readCustomNames, writeCustomNames, readMcpSel, writeMcpSel,
  readPrefs, writePrefs, readUiRuns, writeUiRuns, readSchedules, writeSchedules,
  readSkillFavs, writeSkillFavs, readPrompts, writePrompts, readPromptHistory, writePromptHistory,
  readCorrections, writeCorrections, readSpendCache, writeSpendCache, defaultCwd,
  maskEnvValue, maskInfo, maskSecrets, valueLooksSecret, killTree, KILL_TREE_WAIT_MS, RUN_KILL_GRACE_MS, run,
  maskArgToken, maskArgv, maskArgsLine, maskUrl, maskTransport,
  decodeProject, encodeProject, foldLines, firstCwdOf, projectCwd, setProjectCwd, projectPathOf, extractText, parseFrontmatter,
  titleFrom, projBasename, isGenericCliName, chooseTitle, sessionNameCache, readSessionNames,
  normalizeModel, PRICING, costParts, costOf,
};
