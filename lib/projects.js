'use strict';
// P-1 — the panel's PROJECTS: a start profile plus a label (Julian's decision 05.10.). Two stores:
//   projects.json          [{ id:'p-xxxxxxxx', name, description, hue, cwd, addDirs, mcpServers, model, effort,
//                             permissionMode, agent, instructions, archived, paths, hideInAll, jiraKeys,
//                             starters, memory, createdAt, updatedAt, warnings, checkedAt }]  (≤ 100, newest first)
//   session-projects.json  { "<session uuid, LOWER case>": "p-xxxxxxxx" | "" }
//                          '' = „deliberately without a project" — remembered, so a refused suggestion (P-2)
//                          does not come back; no entry = never decided.
// The rules for a project's fields live in public/js/projects-core.js (one validator for editor and server);
// this file owns the IO, the locks and the measurements.
//
// THE READ RULE (critic M3) — a store that does not parse is an ERROR, never an empty store. The usual pattern
// here (`catch → {}` / `[]`, lib/core.js readMcpSel/readPrompts) plus an upsert would turn ONE broken byte into
// „every project and every instruction text gone": the upsert reads [], appends, writes. So both readers follow
// readJsonFile's semantics (lib/core.js): missing / empty → empty store; unparseable, unreadable or of the wrong
// shape → a 500-class error, and the caller writes NOTHING. A broken file stays on disk exactly as it was, for
// a human to look at.
//
// THE LOCK RULE — two files, one fixed order: PROJECTS_FILE (P) before SESSION_PROJECTS_FILE (S), never the
// other way round. Everything that writes S on behalf of a SPECIFIC project (assign, the start records, the
// session-id hook) checks that the project exists INSIDE the locks, after any delete already in flight: checked
// outside, a delete running in between cleans the map and the assignment lands afterwards — a label pointing
// at nothing (test/projects.test.js „lock order"). The delete holds S while it rewrites P, so today S alone
// would already order the check; P is taken first anyway, so a future writer that removes projects under P
// alone cannot reopen the race. Writers that only remove (forget, '' / null assignments) take S alone. With
// one order there is no deadlock to construct.
//
// WHAT IS MEASURED, AND WHEN (critic M2): a fs check on a dead share or an unplugged network drive takes ~54 s
// (lib/core.js pathExists) and holds a libuv thread (4 by default) the whole time. So paths are checked ONLY on
// save, only LOCAL paths (UNC is never looked at), at most PATH_CHECK_SLOTS at a time across the whole process,
// each with a deadline — and the result is STORED with its time (`warnings`, `checkedAt`). GET /api/projects
// then reads the stored verdict and touches no user path at all. That is the one derived value this module
// keeps: it is a dated measurement, and re-measuring on every read is exactly the cost it exists to avoid.
// Session counts and „last activity" are NOT stored — they are recomputed from the session scan per request.
const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { HOME, PROJECTS_FILE, SESSION_PROJECTS_FILE, PROJECTS_DIR } = require('./paths');
const {
  readJsonFile, writeJsonAtomic, withFileLock, isValidSessionId, pathExists, readPrefs, backupFile, errorText,
  withDeadline, mapLimit, defaultCwd, projectCwd, encodeProject, parseFrontmatter,
} = require('./core');
const PC = require('../public/js/projects-core');

const { PROJECT_CAPS, PROJECT_ID_RE, PROJECT_FIELDS, PROJECT_WARNING_CODES } = PC;
const ASSIGN_MAX = 500;             // one bulk assignment (the „not assigned, by cost" list in P-2)
const PATH_CHECK_SLOTS = 2;         // process-wide: two stalled lookups can block at most two pool threads
const PATH_CHECK_MS = Number(process.env.CLAUDE_UI_TEST_PATH_CHECK_MS) || 4000; // per path (env: test-only seam); a local disk answers in well under a millisecond
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isProjectId = (v) => typeof v === 'string' && PROJECT_ID_RE.test(v);
// The path grammar of THIS server (projects-core projectIsAbsolute): on Windows `/foo` is not absolute.
const PATH_RULES = { posix: process.platform !== 'win32' };

// A store that cannot be read is a 500 with a machine code, carried through the router's catch-all
// (server.js: a thrown error with statusCode + string code keeps both). The message names the file and says
// that it was left alone — the one thing the person reading it needs to know before touching it.
function storeError(file, why) {
  const e = new Error(path.basename(file) + ' ' + why + ' — left untouched, nothing was written');
  e.statusCode = 500;
  e.code = 'store-corrupt';
  return e;
}
function corruptWhy(r) { return r.unreadable ? 'cannot be read (' + r.error + ')' : 'is not valid JSON (' + r.error + ')'; }

// ---- projects.json -----------------------------------------------------------------------------------------
// A stored record, rebuilt field by field: projectNormalize reads only OWN known keys and coerces their types,
// so a hand-edited file can carry neither `__proto__` nor a bypass mode nor a string where a list belongs into
// the panel. Over-long values are kept as they are (an edit of that project then answers what is too long).
function storedProject(e) {
  const p = Object.assign({ id: e.id }, PC.projectNormalize(e).project);
  p.createdAt = Number.isFinite(e.createdAt) ? e.createdAt : 0;
  p.updatedAt = Number.isFinite(e.updatedAt) ? e.updatedAt : p.createdAt;
  // only the codes this module writes: a hand-edited `constructor` would otherwise reach the view, whose label
  // look-up then answers with Object.prototype.constructor — and the whole page throws on `.replace`
  p.warnings = Array.isArray(e.warnings)
    ? e.warnings.filter((w) => w && typeof w === 'object' && typeof w.code === 'string' && PROJECT_WARNING_CODES.includes(w.code))
      .map((w) => ({ code: w.code, field: typeof w.field === 'string' ? w.field : '', ...(hasOwn(w, 'value') ? { value: w.value } : {}) }))
    : [];
  p.checkedAt = Number.isFinite(e.checkedAt) ? e.checkedAt : 0;
  return p;
}
async function readProjects() {
  const r = await readJsonFile(PROJECTS_FILE);
  if (!r.exists) return [];
  if (r.parsed === null) throw storeError(PROJECTS_FILE, corruptWhy(r));
  if (!String(r.raw).trim()) return []; // readJsonFile answers {} for an empty file
  if (!Array.isArray(r.parsed)) throw storeError(PROJECTS_FILE, 'is not a list of projects');
  const seen = new Set();
  const out = [];
  for (const e of r.parsed) {
    // An entry without a valid, unique id cannot be addressed by any route — and silently dropping it on the
    // next write would be the data loss this reader exists to prevent. So the whole file counts as broken.
    if (!e || typeof e !== 'object' || Array.isArray(e) || !hasOwn(e, 'id') || !isProjectId(e.id) || seen.has(e.id)) {
      throw storeError(PROJECTS_FILE, 'holds an entry without a valid, unique id');
    }
    seen.add(e.id);
    out.push(storedProject(e));
  }
  return out;
}
// Everything that was read is written back — no `.slice(0, cap)`: the cap is a rule for CREATING (upsertProject
// refuses the 101st), and a hand-edited file with 105 entries lost the last five on the next save of any other
// project, without a backup. Same rule as the reader above: what this module did not write it does not drop.
async function writeProjects(list) {
  await writeJsonAtomic(PROJECTS_FILE, JSON.stringify(list, null, 2) + '\n');
}

// ---- session-projects.json ---------------------------------------------------------------------------------
// The map comes back as an Object.create(null): its keys are session ids out of request bodies, and a map with
// a prototype answers `map['constructor']` with a function. Keys are folded to lower case — SESSION_ID_RE is
// case-insensitive (lib/core.js), so `ABC…` and `abc…` are one session and must be one entry. An entry that is
// not `<uuid>: p-…|''` cannot have been written by this module and is dropped (it names nothing reachable).
async function readSessionProjects() {
  const r = await readJsonFile(SESSION_PROJECTS_FILE);
  const map = Object.create(null);
  if (!r.exists) return map;
  if (r.parsed === null) throw storeError(SESSION_PROJECTS_FILE, corruptWhy(r));
  if (!String(r.raw).trim()) return map;
  if (!r.parsed || typeof r.parsed !== 'object' || Array.isArray(r.parsed)) throw storeError(SESSION_PROJECTS_FILE, 'is not a session → project map');
  for (const k of Object.keys(r.parsed)) {
    if (!isValidSessionId(k)) continue;
    const v = r.parsed[k];
    if (v === '' || isProjectId(v)) map[k.toLowerCase()] = v;
  }
  return map;
}
// Sorted, so the file diffs as one line per change; built with fromEntries (define, not assign — a key can
// never reach a setter), and only uuid keys, whatever the caller put into the map.
async function writeSessionProjects(map) {
  const out = Object.fromEntries(Object.keys(map).filter(isValidSessionId).sort().map((k) => [k, map[k]]));
  await writeJsonAtomic(SESSION_PROJECTS_FILE, JSON.stringify(out, null, 2) + '\n');
}

const lockS = (fn) => withFileLock(SESSION_PROJECTS_FILE, fn);
const lockPS = (fn) => withFileLock(PROJECTS_FILE, () => withFileLock(SESSION_PROJECTS_FILE, fn)); // P → S, always

// ---- path checks on save ---------------------------------------------------------------------------------
// A slot is released when the lookup REALLY settles, not when its deadline fires: a stat on a dead drive goes
// on in the thread pool after the caller stopped waiting, and only a slot held for that long bounds how many
// pool threads such lookups can occupy. A queued check whose caller already gave up never starts.
let slotsBusy = 0;
const slotQueue = [];
const idleWaiters = [];
function takeSlot() {
  if (slotsBusy < PATH_CHECK_SLOTS) { slotsBusy++; return Promise.resolve(); }
  return new Promise((resolve) => slotQueue.push(resolve));
}
function freeSlot() {
  const next = slotQueue.shift();
  if (next) { next(); return; }
  slotsBusy--;
  if (!slotsBusy) idleWaiters.splice(0).forEach((r) => r());
}
// Test seam: resolves once no lookup holds a slot and none is queued. The slots are process-wide on purpose, so
// a test whose stalled lookups outlive it hands them to the next one — waiting on a fixed sleep for them to end
// was a flaky test under load (peak 0 instead of 2).
function slotsIdle() {
  if (!slotsBusy && !slotQueue.length) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}
// J11 — since the chat START measures its paths here too (server.js POST /api/chat/start), a lookup that ran out
// of time is REMEMBERED while it still runs: the next check of the same place answers 'unchecked' at once and
// takes no slot. Without it every start of a project whose repo sits on an unplugged drive parked one more slot
// for the ~54 s the stat takes to fail — two starts, and the third one's local cwd could not be looked at at
// all. The place is the drive for a Windows drive letter other than the system drive (a mapped network drive
// that stalls one stat stalls them all), and the exact path otherwise: on the system drive a stall is one odd
// path (a junction into a share), and POSIX has one root for everything.
const stalled = new Map(); // place -> number of timed-out lookups on it that have not settled yet
const SYSTEM_DRIVE = String(process.env.SystemDrive || 'C:').slice(0, 2).toLowerCase();
function stallPlace(p) {
  const s = String(p);
  if (PATH_RULES.posix) return s;
  const m = /^([a-z]:)/i.exec(s);
  return (m && m[1].toLowerCase() !== SYSTEM_DRIVE) ? m[1].toLowerCase() : s.toLowerCase();
}
async function probePath(p, exists, ms) {
  const place = stallPlace(p);
  if (stalled.has(place)) return 'unchecked';
  let gaveUp = false, running = false, settled = false, counted = false;
  const work = (async () => {
    await takeSlot();
    try {
      if (gaveUp) return 'unchecked';
      running = true;
      return (await exists(p)) ? 'ok' : 'missing';
    } finally {
      settled = true;
      if (counted) { const n = stalled.get(place) - 1; if (n > 0) stalled.set(place, n); else stalled.delete(place); }
      freeSlot();
    }
  })();
  const r = await withDeadline(work, ms, 'unchecked');
  if (r === 'unchecked') {
    gaveUp = true;
    // only a lookup that really runs on past its deadline marks the place — a queued one never touched it
    if (running && !settled) { counted = true; stalled.set(place, (stalled.get(place) || 0) + 1); }
  }
  return r;
}
// -> { "<path>": 'ok'|'missing'|'unchecked' } for the LOCAL paths among `list`. Once one lookup ran out of time
// the rest are not even started: a drive that stalls one stat stalls the next as well, and the save should
// answer in seconds, not in 8 × 4.
// Test-only seam, inert unless set: a lookup of a path starting with CLAUDE_UI_TEST_STALL_PREFIX first waits
// CLAUDE_UI_TEST_STALL_MS — the dead drive, staged for a booted server (test/projects-start.test.js).
const STALL_PREFIX = process.env.CLAUDE_UI_TEST_STALL_PREFIX || '';
const stagedExists = async (p) => {
  if (STALL_PREFIX && String(p).startsWith(STALL_PREFIX)) await new Promise((r) => setTimeout(r, Number(process.env.CLAUDE_UI_TEST_STALL_MS) || 0));
  return pathExists(p);
};
async function checkPaths(list, deps) {
  const exists = (deps && deps.exists) || (STALL_PREFIX ? stagedExists : pathExists);
  const ms = (deps && Number.isFinite(deps.deadlineMs)) ? deps.deadlineMs : PATH_CHECK_MS;
  const state = Object.create(null);
  const todo = [...new Set(list.filter((p) => typeof p === 'string' && p && !PC.projectIsUncOrDevice(p)))];
  let stalled = false;
  await mapLimit(todo, PATH_CHECK_SLOTS, async (p) => {
    if (stalled) { state[p] = 'unchecked'; return; }
    const r = await probePath(p, exists, ms);
    if (r === 'unchecked') stalled = true;
    state[p] = r;
  });
  return state;
}
// The panel's main working directory for the `cwd-custom` warning — the configured default as a STRING. Not
// lib/core defaultCwd(): that one stats the configured path, and this is a comparison, not a reason to touch a
// path that may sit on a share.
async function mainCwdDefault() {
  const prefs = await readPrefs();
  return (typeof prefs.defaultCwd === 'string' && prefs.defaultCwd.trim()) ? prefs.defaultCwd.trim() : HOME;
}
// P-2 — the folders no folder rule may cover (projects-core projectRuleBlocked): system32, HOME and the panel's
// main folder. Together they hold ~98 % of the cost on the live corpus, and a session there says nothing about its
// project — a rule covering one would label most of the history by a guess. system32 by its usual spelling AND by
// %SystemRoot%, because a session records whichever the CLI was started with. Strings only, nothing is looked at.
function system32Roots() {
  const out = ['C:\\WINDOWS\\system32'];
  const sr = process.env.SystemRoot || process.env.windir;
  if (sr) out.push(path.win32.join(sr, 'System32'));
  return out;
}
function blockedRoots(mainCwd) {
  return [HOME, mainCwd, ...system32Roots()].filter((x) => typeof x === 'string' && x.trim());
}
async function ruleContext(deps) {
  let main = '';
  try { main = deps && deps.mainCwd ? await deps.mainCwd() : await mainCwdDefault(); } catch { main = ''; }
  return { blocked: blockedRoots(main) };
}
function newProjectId(taken, random) {
  for (let i = 0; i < 32; i++) {
    const id = 'p-' + (random ? random() : crypto.randomBytes(4).toString('hex'));
    if (isProjectId(id) && !taken.has(id)) return id;
  }
  throw new Error('could not mint a free project id'); // 32 collisions in 2^32 — a broken random source
}
const editable = (p) => { const o = {}; for (const k of PROJECT_FIELDS) o[k] = p[k]; return o; };
const bad = (status, error, errors) => ({ ok: false, status, error, errors: errors || [] });

// ---- P2: project knowledge — memory files a start names ------------------------------------------------------------
// A project links memory files by NAME (projects-core projectMemoryNameOk). The folder they live in is the CLI's memory
// folder of the project's EFFECTIVE working directory — its own cwd, else the panel's main folder (core defaultCwd) —
// because that is the folder a chat of this project runs in. There is no „cwd → folder" helper (the encoding is lossy,
// core decodeProject): the folder is the one under PROJECTS_DIR whose real cwd (core projectCwd, read from a transcript,
// cached) is that cwd; a folder without any transcript yet counts by its encoded name. Only folders WITH a memory
// subfolder are asked — the same set the memory view lists (lib/skills.js listMemory), without reading every file.
// deps.defaultCwd (optional) — the seam the tests use instead of ui-prefs.
const MEMORY_DESC_MAX = 160;
async function effectiveCwd(p, d) {
  if (p && typeof p.cwd === 'string' && p.cwd.trim()) return p.cwd.trim();
  try { return (d && d.defaultCwd) ? await d.defaultCwd() : await defaultCwd(); } catch { return HOME; }
}
// -> { project: '<dir name under PROJECTS_DIR>', dir: '<abs memory folder>' } | null
async function memoryFolderOf(cwd) {
  const key = PC.projectPathKey(cwd);
  if (!key) return null;
  const direct = encodeProject(cwd).toLowerCase();
  let dirs;
  try { dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }); } catch { return null; }
  for (const e of dirs) {
    if (!e.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, e.name, 'memory');
    try { if (!(await fsp.stat(dir)).isDirectory()) continue; } catch { continue; }
    const real = await projectCwd(e.name);
    if (real ? PC.projectPathKey(real) === key : e.name.toLowerCase() === direct) return { project: e.name, dir };
  }
  return null;
}
async function projectMemoryFolder(p, d) { return memoryFolderOf(await effectiveCwd(p, d)); }
// the .md files of a memory folder, by case-folded name → the name as it is on disk (NTFS folds case, so must this)
async function memoryFiles(folder) {
  const out = new Map();
  if (!folder) return out;
  try { for (const f of await fsp.readdir(folder.dir)) if (/\.md$/i.test(f)) out.set(f.toLowerCase(), f); } catch { /* none */ }
  return out;
}
// One linked file as the cockpit and the start read it. type = lib/skills.js listMemory's rule (frontmatter metadata).
async function memoryEntry(folder, have, name) {
  const real = have.get(name.toLowerCase());
  const base = { name, title: name.replace(/\.md$/i, ''), description: '', type: '', mtime: 0, exists: false, path: '' };
  if (!real) return base;
  let fh = null;
  try {
    const full = path.join(folder.dir, real);
    // one handle for both (as lib/backups.js): stat and read then describe the SAME open file, not a path that may
    // have been swapped in between (CodeQL js/file-system-race)
    fh = await fsp.open(full, 'r');
    const st = await fh.stat();
    const content = await fh.readFile('utf8');
    const fm = parseFrontmatter(content);
    const type = (fm.type || (content.match(/\btype:\s*([\w|-]+)/) || [])[1] || '').split('|')[0].trim();
    const desc = String(fm.description || '').replace(/\s+/g, ' ').trim();
    return Object.assign(base, {
      name: real, title: fm.name || base.title, type, mtime: st.mtimeMs, exists: true, path: full,
      description: desc.length > MEMORY_DESC_MAX ? desc.slice(0, MEMORY_DESC_MAX - 1) + '…' : desc,
    });
  } catch { return base; } finally { if (fh) await fh.close().catch(() => {}); }
}
async function memoryEntries(p, d) {
  const names = (p && Array.isArray(p.memory) ? p.memory : []).slice(0, PROJECT_CAPS.memory);
  if (!names.length) return { folder: null, files: [] };
  const folder = await projectMemoryFolder(p, d);
  const have = await memoryFiles(folder);
  return { folder, files: await Promise.all(names.map((n) => memoryEntry(folder, have, n))) };
}
// The cockpit's „Projektwissen": -> { project (the folder for openMemory) | null, files: [entry…] } — every linked name,
// a gone one with exists:false (the page says „fehlt"). At most PROJECT_CAPS.memory stat + read. No absolute path
// goes to the browser: the memory view opens a file by folder + name.
async function memoryInfo(p, d) {
  const { folder, files } = await memoryEntries(p, d);
  return { project: folder ? folder.project : null, files: files.map(({ path: _abs, ...rest }) => rest) };
}
// The START (server.js POST /api/chat/start → lib/pure buildSpawnPolicy): [{ path, description }] — only files that
// exist NOW, so a file deleted after it was linked is simply not named (the cockpit says „fehlt"). Never throws: a
// start must not fail over its project's knowledge.
async function memoryRefs(p, d) {
  try {
    const { files } = await memoryEntries(p, d);
    return files.filter((e) => e.exists).map((e) => ({ path: e.path, description: e.description }));
  } catch (e) { logStoreOnce(e); return []; }
}

// ---- upsertProject -------------------------------------------------------------------------------------------
// input: the project as the editor sends it; `id` present = update (a MERGE: a key that is absent keeps its
// value, '' / [] / null clear it), absent = create. The client never mints an id, so an unknown one is a 404,
// not an implicit create.
// `baseUpdatedAt` (optional, update only): the `updatedAt` the editor loaded. When the stored record has moved on
// since — a second window saved in between — the answer is 409 `conflict` WITH the stored record, and nothing is
// written: without it, the editor's full draft silently put back whatever the other window had changed (the
// instructions, up to 2000 characters, and no backup of an upsert). The editor then asks; „keep mine" sends only
// the fields it changed, on the new base.
// deps (all optional, the seams the tests use): exists(path) → bool, deadlineMs, mcpNames() → [names] | null,
// mainCwd() → string, random() → 8 hex chars, now() → ms, defaultCwd() → the main folder for the memory look-up (P2).
// -> { ok, status, project?, created?, error?, errors? }  — 400 carries the projects-core token list.
// Two phases: validate + measure WITHOUT the lock (the measurement may take seconds), then re-read and write
// under it, so a delete or an assignment never waits for a stat.
async function upsertProject(input, deps) {
  const d = deps || {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad(400, 'invalid project', [{ field: '', code: 'type' }]);
  const rawId = hasOwn(input, 'id') ? input.id : undefined;
  const id = (rawId === undefined || rawId === null || rawId === '') ? null : rawId;
  if (id !== null && !isProjectId(id)) return bad(400, 'invalid project id', [{ field: 'id', code: 'invalid' }]);
  const base = hasOwn(input, 'baseUpdatedAt') && input.baseUpdatedAt !== null ? input.baseUpdatedAt : undefined;
  if (base !== undefined && !Number.isFinite(base)) return bad(400, 'invalid project', [{ field: 'baseUpdatedAt', code: 'invalid' }]);
  const known = {};
  for (const k of PROJECT_FIELDS) if (hasOwn(input, k)) known[k] = input[k];
  const merge = (list) => {
    const cur = id ? list.find((p) => p.id === id) : null;
    return { cur, draft: cur ? Object.assign(editable(cur), known) : known };
  };
  const stale = (cur) => !!cur && base !== undefined && cur.updatedAt !== base;
  const conflict = (cur) => Object.assign(bad(409, 'conflict', [{ field: '', code: 'conflict' }]), { project: cur });

  // phase 1 — no lock: shape, content, measurements
  const first = merge(await readProjects()); // a broken store answers 500 here, before anything is measured
  if (id && !first.cur) return bad(404, 'unknown project', [{ field: 'id', code: 'unknown' }]);
  if (stale(first.cur)) return conflict(first.cur); // early, before seconds of measuring for nothing
  // the main folder first (a string out of ui-prefs, no path touched): it is a blocked root for the folder rules
  let mainCwd = '';
  try { mainCwd = d.mainCwd ? await d.mainCwd() : await mainCwdDefault(); } catch { mainCwd = ''; }
  const rules = Object.assign({ blockedRoots: blockedRoots(mainCwd) }, PATH_RULES);
  const v = PC.projectValidate(first.draft, rules);
  if (!v.ok) return bad(400, 'invalid project', v.errors);
  const pathState = await checkPaths([v.project.cwd, ...v.project.addDirs], d);
  // P2 — the linked memory files, in the memory folder of the effective cwd (a local folder under ~/.claude, so no
  // slot and no deadline). A name this save ADDS must exist (400 `unknown`: a typo would otherwise be linked for
  // good); one that was stored before and is gone now is a warning (`memory-missing`) — else every later save of
  // the project would answer 400 over a file somebody else deleted.
  const memoryState = Object.create(null);
  if (v.project.memory.length) {
    const have = await memoryFiles(await projectMemoryFolder(v.project, d));
    const before = new Set(((first.cur && first.cur.memory) || []).map((n) => n.toLowerCase()));
    const unknown = [];
    for (const n of v.project.memory) {
      memoryState[n] = have.has(n.toLowerCase()) ? 'ok' : 'missing';
      if (memoryState[n] === 'missing' && !before.has(n.toLowerCase())) unknown.push({ field: 'memory', code: 'unknown', value: n });
    }
    if (unknown.length) return bad(400, 'invalid project', unknown);
  }
  let mcpConfigured = null;
  try { mcpConfigured = d.mcpNames ? await d.mcpNames() : null; } catch { mcpConfigured = null; }
  if (mcpConfigured && !Array.isArray(mcpConfigured)) mcpConfigured = null;

  // phase 2 — under the lock: re-read (another save may have landed meanwhile), re-validate, write
  return withFileLock(PROJECTS_FILE, async () => {
    const list = await readProjects();
    const { cur, draft } = merge(list);
    if (id && !cur) return bad(404, 'unknown project', [{ field: 'id', code: 'unknown' }]);
    if (stale(cur)) return conflict(cur); // the decisive check: under the lock, after any save that landed meanwhile
    const v2 = PC.projectValidate(draft, rules);
    if (!v2.ok) return bad(400, 'invalid project', v2.errors);
    const p = v2.project;
    const nameKey = p.name.toLowerCase();
    if (list.some((x) => x.id !== id && String(x.name).toLowerCase() === nameKey)) {
      return bad(400, 'invalid project', [{ field: 'name', code: 'duplicate' }]);
    }
    if (!cur && list.length >= PROJECT_CAPS.projects) {
      return bad(400, 'invalid project', [{ field: 'projects', code: 'too-many', max: PROJECT_CAPS.projects }]);
    }
    const now = d.now ? d.now() : Date.now();
    // a path changed between the two phases (a concurrent edit of the same project) was not measured — the
    // warning derivation then claims nothing about it, which is the honest reading of a missing measurement
    const rec = Object.assign({ id: cur ? cur.id : newProjectId(new Set(list.map((x) => x.id)), d.random) }, p);
    rec.createdAt = cur ? cur.createdAt : now;
    // strictly increasing per record: it is the version the conflict check compares, and two saves in one
    // millisecond must not carry the same one
    rec.updatedAt = cur ? Math.max(now, (Number.isFinite(cur.updatedAt) ? cur.updatedAt : 0) + 1) : now;
    rec.warnings = PC.projectWarnings(p, { pathState, mcpConfigured, mainCwd, memoryState });
    rec.checkedAt = now;
    if (cur) list[list.indexOf(cur)] = rec; else list.unshift(rec);
    await writeProjects(list);
    return { ok: true, status: 200, project: rec, created: !cur };
  });
}

// ---- deleteProject -------------------------------------------------------------------------------------------
// HARD delete, plus every assignment to it removed under the same P → S lock. Why not „archive": archiving is
// already a field of its own (`archived`, via upsert) for „keep it, but out of the way". A delete that left the
// map entries behind would leave sessions labelled with a project nobody can open, and a later reader would
// have to guess what a dangling id means. The sessions fall back to „never decided" (no entry, not '') — the
// user removed the project, not the decision about those sessions. Neither half is unrecoverable: BOTH files are
// copied to the backup directory first (lib/core.js backupFile, System → Backups, download) — the definition
// alone would come back from a restore without the sessions it labelled.
async function deleteProject(id) {
  if (!isProjectId(id)) return bad(400, 'invalid project id', [{ field: 'id', code: 'invalid' }]);
  return lockPS(async () => {
    const list = await readProjects();
    const i = list.findIndex((p) => p.id === id);
    if (i < 0) return bad(404, 'unknown project', [{ field: 'id', code: 'unknown' }]);
    const map = await readSessionProjects(); // read BOTH before writing either: a broken map must stop the delete
    let unassigned = 0;
    for (const k of Object.keys(map)) if (map[k] === id) { delete map[k]; unassigned++; }
    const backup = await backupFile(PROJECTS_FILE);
    const backupMap = unassigned ? await backupFile(SESSION_PROJECTS_FILE) : null;
    list.splice(i, 1);
    // projects first: should the second write fail, what remains is an entry pointing at nothing, which every
    // reader treats as „no project" — the other order would leave a live project with its sessions stripped
    await writeProjects(list);
    if (unassigned) await writeSessionProjects(map);
    return { ok: true, status: 200, unassigned, backup, backupMap };
  });
}

// ---- assignSessions ------------------------------------------------------------------------------------------
// pid: 'p-…' = assign · '' = deliberately without a project · null = forget the decision (no entry).
// All or nothing: one invalid id refuses the whole request, nothing is written.
// -> { ok, status, n (distinct sessions), changed }
async function assignSessions(ids, pid) {
  if (!Array.isArray(ids) || !ids.length) return bad(400, 'sessionIds required');
  if (ids.length > ASSIGN_MAX) return bad(400, 'too many sessionIds (max ' + ASSIGN_MAX + ')');
  if (!ids.every(isValidSessionId)) return bad(400, 'invalid session id');
  if (!(pid === null || pid === '' || isProjectId(pid))) return bad(400, 'invalid projectId');
  const keys = [...new Set(ids.map((s) => s.toLowerCase()))];
  const apply = async () => {
    const map = await readSessionProjects();
    let changed = 0;
    for (const k of keys) {
      if (pid === null) { if (hasOwn(map, k)) { delete map[k]; changed++; } } else if (map[k] !== pid) { map[k] = pid; changed++; }
    }
    if (changed) await writeSessionProjects(map);
    return { ok: true, status: 200, n: keys.length, changed };
  };
  if (!isProjectId(pid)) return lockS(apply);
  return lockPS(async () => {
    if (!(await readProjects()).some((p) => p.id === pid)) return bad(404, 'unknown project', [{ field: 'projectId', code: 'unknown' }]);
    return apply();
  });
}

// ---- forgetSession: POST /api/session/delete -----------------------------------------------------------------
// A deleted session never starts again, so its entry would only ever be dead weight. A broken map is left alone
// (and said in the log) instead of failing a delete whose transcript has already been moved to the backups.
async function forgetSession(id) {
  if (!isValidSessionId(id)) return { removed: false };
  const k = id.toLowerCase();
  return lockS(async () => {
    let map;
    try { map = await readSessionProjects(); } catch (e) { logStoreOnce(e); return { removed: false, error: errorText(e) }; }
    if (!hasOwn(map, k)) return { removed: false };
    delete map[k];
    await writeSessionProjects(map);
    return { removed: true };
  });
}

// ---- decorateSessions: GET /api/sessions ---------------------------------------------------------------------
// Every item gets `projectId`: 'p-…' | '' (deliberately none) | null (never decided). Only the stored value —
// a deleted project's id cannot remain (deleteProject cleans up), and a hand-made dangling one is the client's to
// show as „(gelöscht)". A broken map must not take the session list down with it: the items then come back
// without the field, and the projects view (GET /api/projects) is where the 500 says why.
let lastStoreLog = '';
function logStoreOnce(e) {
  const m = errorText(e);
  if (m === lastStoreLog) return;
  lastStoreLog = m;
  try { console.error('[projects] ' + m); } catch { /* */ }
}
// P-2 adds `projectDerived`: 'p-…' = a folder rule labels this session (dashed „per Regel"), null = none. Only for a
// session WITHOUT a stored entry — an explicit project and '' always win (projects-core projectOfSession). It is a
// label and a cost bucket, never a start value: nothing on the start path reads it. A broken projects.json leaves
// every `projectDerived` null (no rules can be read) while `projectId` still comes from the map.
async function decorateSessions(items, deps) {
  const list = Array.isArray(items) ? items : [];
  let map;
  try { map = await readSessionProjects(); } catch (e) { logStoreOnce(e); return list; }
  let projects = null;
  try { projects = await readProjects(); } catch (e) { logStoreOnce(e); projects = null; }
  const ctx = projects && projects.some((p) => p.paths.length) ? await ruleContext(deps) : null;
  for (const it of list) {
    if (!it || typeof it.id !== 'string') continue;
    const k = it.id.toLowerCase();
    it.projectId = hasOwn(map, k) ? map[k] : null;
    const r = ctx ? PC.projectOfSession(it, projects, map, ctx) : null;
    it.projectDerived = r && r.derived ? r.projectId : null;
  }
  return list;
}

// ---- listProjects: GET /api/projects -------------------------------------------------------------------------
// The stored records (with their stored warnings) plus three numbers computed per request: sessionCount
// (transcripts that exist and are assigned) and lastActivity (newest mtime) from the session scan the caller
// hands in, and assignedCount straight from the map — every label, a session without a transcript yet included.
// The delete dialog says the latter: it is what a delete removes (sessionCount said 0 for a session assigned
// from its open tab before its first transcript line, while the delete then reported `unassigned: 1`).
// No path of a project is touched here — see the header.
// P-2: `derivedCount` = sessions a folder rule labels (no stored entry); they are NOT in sessionCount, which stays
// „explicitly assigned" — the number the P-1 page and the delete dialog already explain.
async function listProjects(sessions, deps) {
  const [list, map] = await Promise.all([readProjects(), readSessionProjects()]);
  const ctx = list.some((p) => p.paths.length) ? await ruleContext(deps) : null;
  const assigned = new Map();
  for (const k of Object.keys(map)) if (map[k]) assigned.set(map[k], (assigned.get(map[k]) || 0) + 1);
  const stats = new Map();
  const derived = new Map();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || typeof s.id !== 'string') continue;
    const k = s.id.toLowerCase();
    if (!hasOwn(map, k)) {
      const r = ctx ? PC.projectOfSession(s, list, map, ctx) : null;
      if (r && r.derived) derived.set(r.projectId, (derived.get(r.projectId) || 0) + 1);
      continue;
    }
    const pid = map[k];
    if (!pid) continue;
    const st = stats.get(pid) || { n: 0, last: 0 };
    st.n++;
    if (Number.isFinite(s.mtime) && s.mtime > st.last) st.last = s.mtime;
    stats.set(pid, st);
  }
  return list.map((p) => {
    const st = stats.get(p.id);
    return { ...p, sessionCount: st ? st.n : 0, lastActivity: st && st.last ? st.last : null, assignedCount: assigned.get(p.id) || 0, derivedCount: derived.get(p.id) || 0 };
  });
}

// ---- P5: a git worktree belongs to its main repo ------------------------------------------------------------------
// A worktree's `.git` is a FILE: `gitdir: <main>/.git/worktrees/<name>`, and git writes the way back into
// `<gitdir>/gitdir` (= `<worktree>/.git`). Without this, every C:\Users\me\ccui-wt-* would be a draft of its own next to the
// repo it is a checkout of. Both files are read through ONE handle each (open → fh.stat → fh.read, the lib/backups.js
// pattern — no separate stat + readFile on a path, CodeQL js/file-system-race), ≤ 4 KB; a `.git` file whose gitdir does
// not point back at this root (a hand-made or copied one) maps nothing.
//
// A DEAD MAPPED DRIVE must cost the server nothing (review of 07.10.: a read abandoned by a deadline keeps its libuv
// thread, two per overview call would fill the pool of 4). So, per root:
//   · first the reachability guard (lib/reach probePath on the ROOT: async stat under its own deadline, ONE stat per
//     drive/host at a time, 60 s memory for a dead one) — unreachable → the root stays as it is and is never opened;
//   · never more than ONE access in flight (WT_BUSY) — a second overview while it hangs starts none and maps nothing;
//   · a root that timed out (probe or read) is left alone for WT_BACKOFF_MS;
//   · the overview waits at most WT_MS for the lot, the drafts are built without the mapping that did not arrive.
// A result (main root, or '' = not a worktree / gone) is remembered for the process.
const WT_MEMO = new Map();          // path key -> main root | ''
const WT_BUSY = new Map();          // path key -> the one access in flight
const WT_BACKOFF = new Map();       // path key -> until (ms)
const WT_MS = 1500;
const WT_BACKOFF_MS = 10 * 60 * 1000;
const WT_RE = /^gitdir:\s*(.+?)\s*$/m;
async function readSmall(file) {
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const st = await fh.stat();
    if (!st.isFile() || st.size > 4096) return null;
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    return buf.toString('utf8', 0, bytesRead);
  } catch { return null; } finally { if (fh) await fh.close().catch(() => {}); }
}
async function worktreeMainOf(root, home) {
  const dotGit = path.join(root, '.git');
  const txt = await readSmall(dotGit);
  const m = txt == null ? null : WT_RE.exec(txt);
  if (!m) return '';
  const gitdir = path.resolve(root, m[1]);
  const cut = gitdir.replace(/\//g, '\\').search(/\\\.git\\worktrees\\[^\\]+\\?$/i);
  if (cut <= 0) return ''; // a submodule (.git/modules/…) or anything else: not a worktree
  const back = await readSmall(path.join(gitdir, 'gitdir'));
  if (back == null || PC.projectPathKey(path.resolve(gitdir, back.trim())) !== PC.projectPathKey(dotGit)) return '';
  return PC.projectRepoRoot(gitdir.slice(0, cut), home || HOME) || '';
}
// one root, at most one access at a time: the guard first, then the read; a timeout anywhere = backoff
function worktreeLookup(k, r, deps) {
  const busy = WT_BUSY.get(k);
  if (busy) return busy;
  const probe = (deps && deps.probe) || require('./reach').probePath;
  const look = (deps && deps.worktreeMainOf) || worktreeMainOf;
  const now = (deps && deps.now) || Date.now;
  const p = (async () => {
    const pr = await probe(r);
    if (!pr || pr.state === 'unreachable') { WT_BACKOFF.set(k, now() + WT_BACKOFF_MS); return; }
    if (pr.state !== 'ok') { WT_MEMO.set(k, ''); return; } // gone: it stays as it is
    const TO = {};
    const main = await withDeadline(Promise.resolve(look(r)), WT_MS, TO);
    if (main === TO) { WT_BACKOFF.set(k, now() + WT_BACKOFF_MS); return; }
    WT_MEMO.set(k, typeof main === 'string' ? main : '');
  })().catch(() => {}).finally(() => { if (WT_BUSY.get(k) === p) WT_BUSY.delete(k); });
  WT_BUSY.set(k, p);
  return p;
}
// -> Map(path key of a root -> its main repo root), only for roots that ARE worktrees.
// deps.worktreeMainOf / deps.probe / deps.now / deps.waitMs: test seams.
async function worktreeRootMap(sessions, deps) {
  const roots = new Map();
  for (const s of sessions) {
    const dirs = Object.keys((s && s.dirs && typeof s.dirs === 'object') ? s.dirs : {});
    if (s && typeof s.projectPath === 'string') dirs.push(s.projectPath);
    for (const dd of dirs) { const r = PC.projectRepoRoot(dd, HOME); if (r) roots.set(PC.projectPathKey(r), r); }
  }
  const now = (deps && deps.now) || Date.now;
  const started = [];
  for (const [k, r] of roots) {
    if (WT_MEMO.has(k) || WT_BUSY.has(k)) continue;
    const until = WT_BACKOFF.get(k);
    if (until && now() < until) continue;
    WT_BACKOFF.delete(k);
    started.push(worktreeLookup(k, r, deps));
  }
  if (started.length) await withDeadline(Promise.all(started), (deps && deps.waitMs) || WT_MS, null);
  if (WT_MEMO.size > 2000) WT_MEMO.clear();
  const out = new Map();
  for (const [k] of roots) { const m = WT_MEMO.get(k); if (m && PC.projectPathKey(m) !== k) out.set(k, m); }
  return out;
}
function _resetWorktreeMemo() { WT_MEMO.clear(); WT_BUSY.clear(); WT_BACKOFF.clear(); }

// ---- projectsOverview: GET /api/projects/overview ----------------------------------------------------------------
// The cockpit's numbers, computed per request over ALL sessions (critic: /api/usage caps at 100, and 190 sessions
// sit behind that cap — a sum in the browser would be a lower bound, and a small project could show 0).
// deps: scanSessions, scanUsage, listPlans (the server's own functions — injected, so this file stays free of the
// corpus and the tests can count), now() (ms), mainCwd() (the blocked-roots seam, see ruleContext).
// id null = every project + „nicht zugeordnet" (the mass-assignment list); id 'p-…' = that project + its page:
// plans, last state, suggestions. -> { ok, status, … } — see the CHANGELOG (P-2 Teil 1a) for the shape.
//
// COSTS ARE AN ESTIMATE, and the body says so (`estimate: true`): list prices times the deduped tokens of the
// transcripts — the figure „Nutzung & Kosten" shows, never an invoice. A session counts into a project when it is
// assigned explicitly OR labelled by a folder rule (decision 05.10.: „zählt in die Projektkosten"); `derived` on each
// row says which. '' (deliberately without) is its own bucket, `none`, and never part of „nicht zugeordnet".
// Run time: two corpus scans (the session list and one usage pass — 30 days and all-time come out of the SAME pass,
// scanUsage opts.recentFrom). Warm that is the stat of every transcript plus the projection; cold (first call
// after a server start without the cache, or after the v4 refold) it waits for the fold like the Usage page does.
// The corpus cache makes the second call warm (as /api/uiskill/costs); on top, an opt-in memo (memoMs, below).
const OVERVIEW = { days: 30, top: 5, unassigned: 20, recent: 3, suggestions: 20 };
const GROUP_NONE = '~none';   // '' — deliberately without a project (cannot collide with a p-… id)
const GROUP_FREE = '~free';   // no entry, no rule — „nicht zugeordnet"
// P3 — the page's window switch (?days=): 7 / 30 / 90 days, 0 = „Gesamt" (no window — the recent figures ARE the
// all-time ones). Anything else is a 400: a free number would be one more memo key per typo. The activity bars show
// at most ACTIVITY_DAYS days — „Gesamt" shows the last 90, not a bar per day since the first transcript.
const OVERVIEW_DAYS = [7, 30, 90, 0];
const ACTIVITY_DAYS = 90;
// the query value → a window, or null for a malformed one. Absent = the default 30 (the tiles never send it).
function overviewDays(raw) {
  if (raw === null || raw === undefined || raw === '') return OVERVIEW.days;
  const n = /^\d{1,2}$/.test(String(raw)) ? Number(raw) : NaN;
  return OVERVIEW_DAYS.includes(n) ? n : null;
}
// P3 — THE membership rule of a session, as one function: an explicit entry ('p-…', '' → GROUP_NONE), else a folder
// rule ('p-…'), else GROUP_FREE (projects-core projectOfSession). The cockpit's cost buckets and the Usage view's
// „Panel-Projekt" filter both count through it, so the two can never disagree about which sessions a project has.
const groupKeyOf = (r) => (r.projectId ? r.projectId : (r.projectId === '' ? GROUP_NONE : GROUP_FREE));
function groupFnFrom(list, map, ctx) {
  return (sid, cwd) => groupKeyOf(PC.projectOfSession({ id: sid, projectPath: cwd }, list, map, ctx));
}
// the store half: -> (sessionId, projectPath) => key. A broken store throws (a 500, as GET /api/projects).
async function sessionGroupFn(deps) {
  const [list, map] = await Promise.all([readProjects(), readSessionProjects()]);
  return groupFnFrom(list, map, await ruleContext(deps));
}
// a schedule's label (P3): does this project exist now? A malformed id is simply not one; a broken store throws.
async function projectExists(id) {
  return isProjectId(id) && (await readProjects()).some((p) => p.id === id);
}
// the Usage view's filter value: 'p-…' | '~none' | '~free' → itself, anything else → null (the route says 400)
function usageGroupKey(raw) {
  return raw === GROUP_NONE || raw === GROUP_FREE || isProjectId(raw) ? raw : null;
}
function localDay(ms) {
  const d = new Date(ms);
  const p = (v) => (v < 10 ? '0' : '') + v;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); // = lib/corpus.js dayKey (LOCAL)
}
// deps.memoMs (the server: 20 s) — a short result memo. Warm the two scans still stat ~1000 files (1–2 s); the cockpit
// asks again on every tab switch. Keyed on the id AND both stores' stat, so an assignment or a rule edit is seen at once;
// only new transcript costs may lag by memoMs (an estimate). In-flight shared, so two tabs never scan twice.
const overviewMemo = new Map(); // key -> { at, p }
async function storeStamp() {
  const one = async (f) => { try { const s = await fsp.stat(f); return s.mtimeMs + ':' + s.size; } catch { return '-'; } };
  return (await one(PROJECTS_FILE)) + '|' + (await one(SESSION_PROJECTS_FILE));
}
async function projectsOverview(id, deps) {
  const d = deps || {};
  if (!(d.memoMs > 0)) return projectsOverviewNow(id, d);
  const key = String(id || '') + '|' + String(d.days === undefined ? OVERVIEW.days : d.days) + '|' + await storeStamp();
  const now = Date.now();
  const hit = overviewMemo.get(key);
  if (hit && now - hit.at < d.memoMs) return hit.p;
  const p = projectsOverviewNow(id, d);
  if (overviewMemo.size >= 20) overviewMemo.clear(); // ≤ 20 keys (ids × store generations) — never grows unbounded
  overviewMemo.set(key, { at: now, p });
  p.then((r) => { if (!r || r.status !== 200) overviewMemo.delete(key); }, () => overviewMemo.delete(key));
  return p;
}
// deps.days (P3): one of OVERVIEW_DAYS, absent = 30 — see overviewDays.
async function projectsOverviewNow(id, d) {
  if (id !== null && id !== undefined && !isProjectId(id)) return bad(400, 'invalid project id', [{ field: 'id', code: 'invalid' }]);
  const days = d.days === undefined ? OVERVIEW.days : d.days;
  if (!OVERVIEW_DAYS.includes(days)) return bad(400, 'invalid days', [{ field: 'days', code: 'invalid' }]);
  const [list, map] = await Promise.all([readProjects(), readSessionProjects()]); // a broken store: 500, as GET /api/projects
  const project = id ? list.find((p) => p.id === id) : null;
  if (id && !project) return bad(404, 'unknown project', [{ field: 'id', code: 'unknown' }]);
  const ctx = await ruleContext(d);
  const now = d.now ? d.now() : Date.now();
  // calendar days, so a DST change does not shift the window
  const dayBack = (n) => { const b = new Date(now); b.setDate(b.getDate() - n); return localDay(b.getTime()); };
  const recentFrom = days ? dayBack(days - 1) : null; // „Gesamt": no window, the recent figures are the all-time ones

  const whose = (sid, cwd) => PC.projectOfSession({ id: sid, projectPath: cwd }, list, map, ctx);
  const items = (await d.scanSessions()).filter((s) => s && typeof s.id === 'string').map((s) => {
    const k = s.id.toLowerCase();
    const r = whose(s.id, s.projectPath);
    return Object.assign({}, s, { projectId: hasOwn(map, k) ? map[k] : null, projectDerived: r.derived ? r.projectId : null });
  });
  const groupOf = groupFnFrom(list, map, ctx);
  const usage = await d.scanUsage(null, null, 0, { groupOf: (sid, sess) => groupOf(sid, sess.projectPath), recentFrom: recentFrom || undefined, groupDays: !!project });
  const plans = await d.listPlans();
  const planIdx = PC.projectPlanIndex(items, plans.map((p) => p.name));
  const planMeta = new Map(plans.map((p) => [p.name, p]));
  // A session id can sit in two project folders (a restore into the folder of its cwd) — its numbers are SUMMED.
  const cost = new Map();
  for (const s of usage.bySession) {
    const k = s.id.toLowerCase();
    const c = cost.get(k) || { cost: 0, recentCost: 0, tokens: 0, recentTokens: 0, subCost: 0, model: s.model };
    c.cost += s.cost; c.tokens += s.tokens; c.subCost += s.subCost;
    c.recentCost += days ? (s.recentCost || 0) : s.cost; c.recentTokens += days ? (s.recentTokens || 0) : s.tokens;
    cost.set(k, c);
  }
  const groups = new Map(usage.byGroup.map((g) => [g.group, g]));
  const sumOf = (key) => { const g = groups.get(key); return { cost: g ? g.cost : 0, recentCost: g ? (days ? g.recentCost : g.cost) : 0, tokens: g ? g.tokens : 0 }; };
  // P1 cockpit actions: `project` (the CLI folder name — /api/transcript and the resume read it), `projectId` (the STORED
  // entry: null / '' / 'p-…') and `plan` (the plan file this session's slug wrote, if listed) ride on every row, so
  // ▶ Fortsetzen / Transkript / Plan work from a row without a second request
  const ref = (s) => ({ project: s.project || '', projectPath: s.projectPath, projectId: s.projectId, plan: (s.slug && planIdx[s.slug] && planIdx[s.slug].name) || null });
  const row = (s) => {
    const c = cost.get(s.id.toLowerCase());
    return {
      id: s.id, title: s.title, ...ref(s), mtime: s.mtime, derived: s.projectId === null && !!s.projectDerived,
      cost: c ? c.cost : 0, recentCost: c ? c.recentCost : 0, tokens: c ? c.tokens : 0, subCost: c ? c.subCost : 0, model: c ? c.model : '',
    };
  };
  const byCost = (a, b) => (b.cost - a.cost) || (b.mtime - a.mtime);
  const members = new Map();
  for (const s of items) {
    const pid = s.projectId || (s.projectId === null ? s.projectDerived : null);
    if (!pid) continue;
    if (!members.has(pid)) members.set(pid, []);
    members.get(pid).push(s);
  }
  // the tile's „n Vorschläge" badge: every open suggestion, not only the ≤ 20 a page lists
  const sugCount = new Map();
  for (const s of items) if (s.projectId === null) for (const h of PC.projectSuggest(s, list, planIdx)) sugCount.set(h.projectId, (sugCount.get(h.projectId) || 0) + 1);
  const block = (p) => {
    const ms = members.get(p.id) || [];
    const sum = sumOf(p.id);
    // P3 — the members with usage IN the window (all-time for „Gesamt"), and how many of them only a rule labels
    const active = ms.filter((s) => { const c = cost.get(s.id.toLowerCase()); return !!c && c.recentTokens > 0; });
    return {
      id: p.id, name: p.name, hue: p.hue, archived: p.archived, hideInAll: p.hideInAll, jiraKeys: p.jiraKeys, paths: p.paths,
      sessions: ms.length, explicitSessions: ms.filter((s) => s.projectId === p.id).length, derivedSessions: ms.filter((s) => s.projectId === null).length,
      recentSessions: active.length, recentDerivedSessions: active.filter((s) => s.projectId === null).length,
      cost: sum.cost, recentCost: sum.recentCost, tokens: sum.tokens, suggestCount: sugCount.get(p.id) || 0,
      top: ms.map(row).filter((r) => r.tokens > 0).sort(byCost).slice(0, OVERVIEW.top),
    };
  };
  let recentTotal = 0;
  for (const g of usage.byGroup) recentTotal += days ? g.recentCost : g.cost;
  const out = {
    ok: true, status: 200, estimate: true, generatedAt: now,
    window: { days, from: recentFrom },
    totals: { cost: usage.total.cost, recentCost: recentTotal, sessions: items.length },
    projects: (project ? [project] : list).map(block),
    none: Object.assign({ sessions: items.filter((s) => s.projectId === '').length }, sumOf(GROUP_NONE)),
    unpricedTokens: usage.unpricedTokens, unpricedModels: usage.unpricedModels,
    foldErrors: usage.foldErrors, parseErrors: usage.parseErrors,
  };
  if (!project) {
    const free = items.filter((s) => s.projectId === null && !s.projectDerived);
    out.unassigned = Object.assign({ sessions: free.length }, sumOf(GROUP_FREE), {
      top: free.map((s) => Object.assign(row(s), { suggest: PC.projectSuggest(s, list, planIdx) }))
        .filter((r) => r.tokens > 0).sort(byCost).slice(0, OVERVIEW.unassigned),
    });
    // P5 — „Neue Projekte vorschlagen": drafts out of the same free sessions (projects-core projectClusters). The folder
    // and server signals are there only when the caller's scan asked for them (server.js: scanSessions({signals:true})).
    // HOME, the main folder and system32 are never a draft's folder (the blocked roots of the folder rules).
    // the explicitly assigned sessions decide whether a draft is really an EXISTING project (target); a git worktree
    // root (ccui-wt-*) counts as its main repo (worktreeRootMap)
    const assigned = items.filter((s) => isProjectId(s.projectId));
    const rootOf = await worktreeRootMap(free.concat(assigned), d);
    out.drafts = PC.projectClusters(free, list, { home: HOME, blocked: ctx.blocked, assigned, rootOf: (r) => rootOf.get(PC.projectPathKey(r)) || null });
    return out;
  }
  // ---- the project's page ----
  const ms = members.get(project.id) || [];
  // P3 — messages per local day, oldest first, ending today: the window's days (≤ ACTIVITY_DAYS; „Gesamt" the last 90)
  const pg = groups.get(project.id);
  const span = Math.min(days || ACTIVITY_DAYS, ACTIVITY_DAYS);
  out.activity = [];
  for (let i = span - 1; i >= 0; i--) out.activity.push((pg && pg.days && pg.days[dayBack(i)]) || 0);
  out.activityFrom = dayBack(span - 1);
  const byPlan = new Map();
  for (const s of ms) {
    const e = s.slug ? planIdx[s.slug] : null;
    if (!e) continue;
    const m = byPlan.get(e.name) || { name: e.name, sessionIds: [], derived: true };
    m.sessionIds.push(s.id);
    if (s.projectId === project.id) m.derived = false; // derived = reached ONLY through rule-labelled sessions
    byPlan.set(e.name, m);
  }
  out.plans = [...byPlan.values()].map((m) => {
    const f = planMeta.get(m.name) || {};
    return Object.assign({ title: f.title || m.name, teaser: f.teaser || '', mtime: f.mtime || 0, size: f.size || 0 }, m);
  }).sort((a, b) => b.mtime - a.mtime);
  // P2 — „Projektwissen": the linked memory files as they are NOW (≤ 10 stat + read; the memo above covers repeats)
  const mem = await memoryInfo(project, d);
  out.memory = mem.files;
  out.memoryProject = mem.project;
  out.recent = ms.slice().sort((a, b) => b.mtime - a.mtime).slice(0, OVERVIEW.recent).map((s) => ({
    id: s.id, title: s.title, ...ref(s), mtime: s.mtime, derived: s.projectId === null,
    lastPrompt: s.lastPrompt || '', lastPromptAt: s.lastPromptAt || null, lastText: s.lastText || '', lastTextAt: s.lastTextAt || null,
    recap: s.recap || '', recapAt: s.recapAt || null,
  }));
  const strongFirst = (a, b) => ((a.strength === b.strength ? 0 : (a.strength === 'strong' ? -1 : 1)) || byCost(a, b));
  out.suggestions = items.filter((s) => s.projectId === null).map((s) => {
    const hit = PC.projectSuggest(s, list, planIdx).find((x) => x.projectId === project.id);
    return hit ? Object.assign(row(s), { strength: hit.strength, reasons: hit.reasons }) : null;
  }).filter(Boolean).sort(strongFirst).slice(0, OVERVIEW.suggestions);
  return out;
}

// ---- the start path (Stufe 2: wired into POST /api/chat/start) -----------------------------------------------
// resolveStartFrom — the pure rule. -> { pid: 'p-…' | '' | null, project | null, error | null, code? }
//   · fresh start: body.projectId decides ('' = explicitly none, a pid = that project, absent = nothing)
//   · fork (resume + fork): body.projectId if sent, else the SOURCE's entry — a fork inherits its project
//   · plain resume: only the map — body.projectId is ignored, because a change of project goes through
//     /api/projects/assign; two ways to say it would be two truths (critic H4)
//   · a malformed pid is an error (400 `project-invalid`), and so is an unknown one the BODY names (400
//     `project-unknown`): the tab believes it starts with that project's instructions, and a start that quietly
//     ran without them is the „asserted, not done" this panel keeps fixing. An unknown pid INHERITED from the map
//     (a hand-edited file — deleteProject cleans up) resolves to nothing instead: a session must stay resumable.
//   · an archived project still applies — archiving hides it, it does not disarm sessions that use it
//   · a FOLDER RULE never applies (P-2, Julian's decision 05.10.): this rule reads the map and the body, and has no
//     cwd input at all — `projectDerived` is a label and a cost bucket, never instructions or start values
//     (test/projects-cockpit.test.js „a rule never steers a start")
function resolveStartFrom(body, resume, map, list) {
  const b = (body && typeof body === 'object') ? body : {};
  const sent = hasOwn(b, 'projectId') && b.projectId !== undefined && b.projectId !== null;
  const raw = sent ? b.projectId : undefined;
  if (sent && !(raw === '' || isProjectId(raw))) return { pid: null, project: null, error: 'invalid projectId', code: 'project-invalid' };
  const res = isValidSessionId(resume) ? resume.toLowerCase() : null;
  const inherited = () => (res && map && hasOwn(map, res) ? map[res] : null);
  let pid, fromBody = false;
  if (!res) { pid = sent ? raw : null; fromBody = sent; }
  else if (b.fork) { pid = sent ? raw : inherited(); fromBody = sent; }
  else pid = inherited();
  const project = pid ? ((Array.isArray(list) ? list : []).find((p) => p.id === pid) || null) : null;
  if (pid && !project) {
    if (fromBody) return { pid: null, project: null, error: 'unknown project', code: 'project-unknown' };
    pid = null;
  }
  // P3 — `labelProjectId`: a UI-skill run started in the browser LABELS its session with a project and gets nothing
  // else of it — no instructions, no start values, no memory: `project` stays null. Only on a fresh start that names
  // no projectId (a resume keeps its label, a fork inherits one); malformed → 400 `label-invalid`, unknown → 400
  // `project-unknown`, as for projectId. The start route records it through recordFreshStart like a projectId.
  const lsent = hasOwn(b, 'labelProjectId') && b.labelProjectId !== undefined && b.labelProjectId !== null;
  if (lsent) {
    const lp = b.labelProjectId;
    if (res || sent || !isProjectId(lp)) return { pid: null, project: null, error: 'invalid labelProjectId', code: 'label-invalid' };
    if (!(Array.isArray(list) ? list : []).some((p) => p.id === lp)) return { pid: null, project: null, error: 'unknown project', code: 'project-unknown' };
    return { pid, project, error: null, labelPid: lp };
  }
  return { pid, project, error: null };
}
// The store half. A broken store must not stop every chat from starting: it resolves to „no project" and says
// so in `storeError`, for the start route to pass on (Stufe 2 decides how the tab shows it).
async function resolveStart(body, resume) {
  let map, list;
  try { [map, list] = await Promise.all([readSessionProjects(), readProjects()]); } catch (e) {
    logStoreOnce(e);
    return { pid: null, project: null, error: null, storeError: errorText(e) };
  }
  return resolveStartFrom(body, resume, map, list);
}
// A fresh start knows its session id before the spawn (server.js mints it), so the label is written THEN —
// under the lock, before the process exists — and not on the first frame: a server restart in between would
// otherwise lose it while the tab already shows the project (critic H5). '' is recorded too: „without a
// project" is a decision. pid null = nothing to record.
async function recordFreshStart(sessionId, pid) {
  if (pid === null || pid === undefined || !isValidSessionId(sessionId)) return { recorded: false };
  if (!(pid === '' || isProjectId(pid))) return { recorded: false };
  const k = sessionId.toLowerCase();
  const write = async () => { const map = await readSessionProjects(); map[k] = pid; await writeSessionProjects(map); return { recorded: true }; };
  if (pid === '') return lockS(write);
  return lockPS(async () => ((await readProjects()).some((p) => p.id === pid) ? write() : { recorded: false }));
}
// The id the CLI reports on its stream frames (lib/chat.js chat.onSessionId) — the only moment a FORK's id
// exists, and the moment a session that changed its id (e.g. after /clear) shows it. -> handler | null.
// The handler records `pid` under a NEW id only (not the source of a fork or resume, not the fresh id that
// recordFreshStart already wrote), and never over an existing entry: an assignment made in the meantime wins.
// Not awaited by its caller (a stream handler must not wait for disk), so it returns its promise for the tests
// and logs instead of throwing.
function sessionIdHook(o) {
  const pid = o && o.pid;
  if (pid === null || pid === undefined || !(pid === '' || isProjectId(pid))) return null;
  const skip = new Set([o.resume, o.sessionId].filter(isValidSessionId).map((s) => s.toLowerCase()));
  return (id) => {
    if (!isValidSessionId(id)) return Promise.resolve({ recorded: false });
    const k = id.toLowerCase();
    if (skip.has(k)) return Promise.resolve({ recorded: false });
    const write = async () => {
      const map = await readSessionProjects();
      if (hasOwn(map, k)) return { recorded: false };
      map[k] = pid;
      await writeSessionProjects(map);
      return { recorded: true };
    };
    const run = pid === '' ? lockS(write)
      : lockPS(async () => ((await readProjects()).some((p) => p.id === pid) ? write() : { recorded: false }));
    return run.catch((e) => { logStoreOnce(e); return { recorded: false, error: errorText(e) }; });
  };
}

module.exports = {
  PATH_CHECK_SLOTS, PATH_CHECK_MS, ASSIGN_MAX,
  readProjects, writeProjects, readSessionProjects, writeSessionProjects, checkPaths, slotsIdle,
  upsertProject, deleteProject, assignSessions, forgetSession, decorateSessions, listProjects,
  resolveStartFrom, resolveStart, recordFreshStart, sessionIdHook,
  blockedRoots, ruleContext, projectsOverview, OVERVIEW, GROUP_NONE, GROUP_FREE,
  OVERVIEW_DAYS, overviewDays, sessionGroupFn, usageGroupKey, projectExists,
  memoryRefs, memoryInfo,
  worktreeMainOf, worktreeRootMap, _resetWorktreeMemo,
};
