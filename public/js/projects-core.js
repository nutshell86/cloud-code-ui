'use strict';
// Projects (P-1) — the pure half. Browser (classic script) AND Node (require'd by lib/projects.js and by the
// test suite). Dependency- and side-effect-free; no t()/DOM here (backups-view.js / plan-progress.js spirit):
// everything returns TOKENS (`{field, code}`), the view translates them.
//
// What a project IS here — Julian's decision of 05.10.: a START PROFILE plus a LABEL. „Neuer Chat im Projekt"
// copies the start values VISIBLY into a tab (projectStartValues), and sessions carry the project as a label
// (session-projects.json, lib/projects.js). The working directory stays system32 by default — the repo is
// meant to travel as an additional directory — so a project's own cwd is optional and earns a warning.
//
// WHY the rules live here and not only in the route: the editor (Teil 2) has to say BEFORE the save what the
// server will refuse, and two copies of „which cwd is allowed" are how a form ends up promising a save that
// then answers 400. One normaliser, one validator, one warning derivation — for both sides.
//
// The three verdicts are kept apart on purpose:
//   · projectNormalize — SHAPE: types, caps, unknown keys dropped, the one forbidden permission mode.
//   · projectValidate  — CONTENT of the strings: NUL anywhere, UNC/device paths as cwd, relative paths.
//   · projectWarnings  — what is ALLOWED but worth saying, derived from facts somebody else measured (the
//     fs checks run only on save, in lib/projects.js — never here, never on a GET).
// A client mistake is ANSWERED, never silently repaired: an over-long text is an error, not a cut — the tab
// would otherwise believe it started with instructions it did not get (same rule as server.js /api/chat/start).

// The caps. `instructions` = lib/pure GUARDRAIL_CAPS.section (2000): a longer text would be clamped with „…" at
// spawn time, so it is refused here instead. `path` = MAX_PATH; a longer cwd fails at spawn on Windows anyway.
// `mcpServers` 40 ≈ 4× the 9 servers configured on this machine; the start route's own ceiling is 64.
var PROJECT_CAPS = {
  name: 80, description: 500, instructions: 2000, addDirs: 8, mcpServers: 40, projects: 100,
  path: 260, model: 200, agent: 100,
  // P-2 cockpit: folder rules (each ≤ path + 1 characters — the trailing `*`) and the project's Jira keys
  paths: 8, jiraKeys: 20,
  // P2 (07.10.): start orders (a label for the button, the prompt it SENDS) and the memory files a start names.
  // A prompt is capped like the instructions: it is one message, and 5 × 2000 keeps a record far under the 64 KB body.
  starters: 5, starterLabel: 60, starterPrompt: 2000, memory: 10,
};
// How far past a list cap the entries are still looked at ONE BY ONE. A body may be 64 KB (server.js), and a
// list of 25 000 relative paths used to come back as 25 000 errors — 1,36 MB of answer and seconds of a frozen
// event loop, since the de-duplication was quadratic. Past this bound the list is refused AS A WHOLE
// (`too-many`) without a word per entry; the editor never gets near it (it offers at most the cap's rows).
var PROJECT_SCAN_FACTOR = 4;
// Minted by the SERVER only (lib/projects.js, crypto). The shape is an allow-list by construction: neither
// `__proto__` nor `constructor` can pass it, so an id can never name an object member.
var PROJECT_ID_RE = /^p-[0-9a-f]{8}$/;
// lib/chat.js PERM_MODES minus `bypassPermissions` — Julian's decision 05.10.: a project must never start a
// chat without asking, so that mode is not storable at all (test/projects-core.test.js pins the parity with
// lib/chat.js, so a mode added there is a red test here, not a silently unstorable choice).
var PROJECT_PERM_MODES = ['default', 'plan', 'acceptEdits', 'auto', 'manual', 'dontAsk'];
// storable, but they run tools without a prompt — the editor says so (critic F3 a)
var PROJECT_PERM_NOASK = ['auto', 'dontAsk'];
var PROJECT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']; // = lib/chat.js EFFORT_LEVELS (parity pinned)
// The fields a client may set, in the order a record is written. Everything else in a body is dropped.
var PROJECT_FIELDS = ['name', 'description', 'hue', 'cwd', 'addDirs', 'mcpServers', 'model', 'effort',
  'permissionMode', 'agent', 'instructions', 'archived', 'paths', 'hideInAll', 'jiraKeys', 'starters', 'memory'];
// What „Neuer Chat im Projekt" copies into the tab, in this order. `cwd` and `mcpServers` stay out of a
// RESUME (decision 05.10.): a resumed session keeps its own folder and its own stored MCP selection.
var PROJECT_START_KEYS = ['cwd', 'addDirs', 'mcpServers', 'model', 'effort', 'permissionMode', 'agent', 'hue'];
// The complete token sets — exported so the view's test can demand a label for every one of them (a token
// without a label renders an empty line, the failure backups-view.js was written against).
// `conflict` = the record changed since the editor loaded it (another window saved in between) — lib/projects.js
// answers it with 409 and the stored record, so nobody's edit is overwritten without being asked.
// `blocked` = a folder rule that would cover the main folder, HOME or system32 (P-2, see projectRuleBlocked).
var PROJECT_ERROR_CODES = ['type', 'required', 'too-long', 'too-many', 'invalid', 'bypass-forbidden', 'nul',
  'unc', 'relative', 'duplicate', 'unknown', 'conflict', 'blocked'];
// `jira-placeholder` = a project key the transcript fold never records (PROJECT_JIRA_PLACEHOLDERS) — allowed as a
// link, but no session will ever be suggested for it, and the editor should say so instead of staying silent.
// `memory-missing` (P2) = a linked memory file that existed when it was linked and is gone now — a warning, not a 400:
// otherwise every later save of the project would fail over a file somebody else deleted.
var PROJECT_WARNING_CODES = ['cwd-missing', 'cwd-custom', 'adddir-missing', 'adddir-unc', 'path-unchecked',
  'mcp-unknown', 'perm-noask', 'jira-placeholder', 'memory-missing'];
// P2 — a memory file NAME (never a path): one file in the memory folder of the project's working directory. No
// separator can pass the class, and `..` is refused on top (a name like `..md` would still be a file, but reads as one).
var PROJECT_MEMORY_NAME_RE = /^[\w .-]{1,120}\.md$/;
function projectMemoryNameOk(n) { return typeof n === 'string' && PROJECT_MEMORY_NAME_RE.test(n) && n.indexOf('..') < 0; }
// The Jira keys the cockpit knows (P-2) — ONE rule for the project field here and for the transcript fold
// (lib/corpus.js builds its scan pattern from the same prefixes). The allow-list exists because a free pattern
// matched PR-, UTF-, ISO- … (measured: noise only); the placeholders are the sample keys the automation sessions
// carry (ACME-1234 / PROJ-456 in 25 sessions) — counted, they would suggest every one of them for any project.
var PROJECT_JIRA_PREFIXES = ['ACME', 'PROJ'];
var PROJECT_JIRA_KEY_RE = /^(ACME|PROJ)-\d+$/;
var PROJECT_JIRA_PLACEHOLDERS = ['1234', '456'];
// Same shape every MCP route in server.js requires, plus the three names that index an object member
// (buildMcpConfigFile fills a plain {} by name — see the SEC-5 note in server.js /api/chat/start).
var PROJECT_MCP_NAME_RE = /^[\w.-]+$/;
var PROJECT_MCP_FORBIDDEN = ['__proto__', 'constructor', 'prototype'];

// ---- paths, as pure string rules -------------------------------------------------------------------------
// The SAME question as lib/core.js isUncOrDevicePath (that file is Node-only, so the rule is restated here and
// test/projects-core.test.js runs both over one table): \\server\share, \\?\…, \\.\… and the / spellings.
// Why a project cwd may not be one: a spawn with an unreachable UNC cwd holds the event loop ~31 s inside
// CreateProcessW (lib/chat.js), and a project would repeat that on EVERY chat it starts.
function projectIsUncOrDevice(p) { return /^[\\/]{2}/.test(String(p == null ? '' : p).trim()); }
// Absolute = what the SERVER's platform calls absolute, because the server is where the path is used. On Windows
// that is a drive root (`C:\`, `C:/`) and nothing else: `C:foo` (drive-relative), `foo\bar`, and a root-relative
// `\foo` or `/foo` would all resolve against the server process's own cwd or drive — a directory nobody picked
// (`/Windows` used to pass as „POSIX absolute" while `\Windows`, the same folder, was refused). On a POSIX server
// it is a single leading `/`.
// `posix` undefined = this process's platform (Node: process.platform; a browser has none → Windows, the panel's
// home). The browser half passes the server's grammar explicitly (projects.js projPosix).
function projectPosixDefault() {
  return typeof process !== 'undefined' && !!process && typeof process.platform === 'string' && process.platform !== 'win32';
}
function projectIsAbsolute(p, posix) {
  var s = String(p == null ? '' : p);
  if (posix === undefined ? projectPosixDefault() : !!posix) return /^\/(?![\\/])/.test(s);
  return /^[A-Za-z]:[\\/]/.test(s);
}
// One comparison key per directory: separators unified, trailing separator dropped (but not the one of a
// drive root), case folded — NTFS does not distinguish `C:\Repo` from `c:\repo\`, so neither does this.
function projectPathKey(p) {
  var s = String(p == null ? '' : p).trim().replace(/\//g, '\\');
  while (s.length > 1 && /\\$/.test(s) && !/^[A-Za-z]:\\$/.test(s)) s = s.slice(0, -1);
  return s.toLowerCase();
}
function projectMcpNameOk(n) {
  return typeof n === 'string' && PROJECT_MCP_NAME_RE.test(n) && PROJECT_MCP_FORBIDDEN.indexOf(n) < 0;
}

// ---- folder rules (P-2), as pure string rules -------------------------------------------------------------
// Julian's decision 05.10.: a rule is the project's OWN entry, shown with a dashed „per Regel" label, and it
// NEVER steers a start (no instructions, no start values — only an explicit assignment does, and it always wins).
// Grammar, compared the way projectPathKey compares (\ = /, case folded):
//   `C:\Atlas`        that folder and everything below it — at a PATH BOUNDARY: C:\Atlas2 is not C:\Atlas
//   `C:\ccui-wt-*`    a trailing `*` = a plain prefix of the spelling, boundary or not (ccui-wt-cockpit, …)
// A `*` anywhere else is refused (`invalid`); the part before it must be an absolute path like an addDir.
// -> { star, key } | null. For a star rule `key` keeps its trailing separator: `C:\Atlas\*` means BELOW C:\Atlas.
function projectRuleParse(rule) {
  if (typeof rule !== 'string') return null;
  var s = rule.trim();
  var star = s.charAt(s.length - 1) === '*';
  var base = star ? s.slice(0, -1) : s;
  if (!base || base.indexOf('*') >= 0) return null;
  return { star: star, key: star ? base.replace(/\//g, '\\').toLowerCase() : projectPathKey(base) };
}
// Does `rule` cover the folder `cwd`? Pure string comparison — no path is ever looked at, so a rule on a share
// costs nothing.
function projectRuleMatch(rule, cwd) {
  var r = projectRuleParse(rule);
  if (!r || typeof cwd !== 'string' || !cwd.trim()) return false;
  var c = projectPathKey(cwd);
  if (r.star) return c.indexOf(r.key) === 0;
  if (c === r.key) return true;
  return c.indexOf(/\\$/.test(r.key) ? r.key : r.key + '\\') === 0; // a drive root `c:\` keeps its one separator
}
// A rule that covers the main folder, HOME or system32 would label ~98 % of the cost (measured: system32 + HOME)
// by a guess — exactly the „stille Zuordnung" the decision rules out. So such a rule is refused on save
// (`blocked`) and ignored by projectOfSession should a hand-edited file carry one. `roots` = those folders.
function projectRuleBlocked(rule, roots) {
  return (Array.isArray(roots) ? roots : []).some(function (root) { return projectRuleMatch(rule, root); });
}
function projectJiraPlaceholder(key) {
  var m = /-(\d+)$/.exec(String(key || ''));
  return !!m && PROJECT_JIRA_PLACEHOLDERS.indexOf(m[1]) >= 0;
}
// An error list that says each thing ONCE, in constant time per entry: the same {field, code, value} twice is one
// error (a list with 3 non-strings is one `addDirs: type`, not three), and the look-up is a key, not a scan —
// the scan made a long list quadratic (critic of 05.10.: 128 s for 80 000 entries).
function projectErrorList(seed) {
  var list = [], seen = {};
  var add = function (e) {
    var k = '#' + e.field + '\u0001' + e.code + '\u0001' + (e.value === undefined ? '' : String(e.value));
    if (Object.prototype.hasOwnProperty.call(seen, k)) return;
    seen[k] = true;
    list.push(e);
  };
  (seed || []).forEach(add);
  return { list: list, add: add };
}

// ---- projectNormalize: shape ------------------------------------------------------------------------------
// -> { project, errors:[{field, code, max?, value?}] }. `project` is ALWAYS a complete record of PROJECT_FIELDS
// with safe defaults, so a caller can also use it to read a hand-edited file (lib/projects.js does): a field of
// the wrong type falls back to its default AND is reported; an over-long text or an over-full list is KEPT as it
// is AND reported, so the validator — and the person reading the error — see what was really sent.
// Only OWN properties are read, and the record is built fresh: a body or a file carrying `__proto__` can neither
// retarget the prototype nor smuggle a key through (JSON.parse makes `__proto__` an own, plain property).
function projectNormalize(o) {
  var coll = projectErrorList();
  var errors = coll.list;
  var isObj = !!o && typeof o === 'object' && !Array.isArray(o);
  if (!isObj) coll.add({ field: '', code: 'type' });
  var src = isObj ? o : {};
  var own = function (k) { return Object.prototype.hasOwnProperty.call(src, k) ? src[k] : undefined; };
  var err = function (field, code, extra) {
    var e = { field: field, code: code };
    if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k]; } }
    coll.add(e);
  };
  var text = function (field, max, oneLine) {
    var v = own(field);
    if (v == null) return '';
    if (typeof v !== 'string') { err(field, 'type'); return ''; }
    var s = oneLine ? v.replace(/\s+/g, ' ').trim() : v.trim();
    if (s.length > max) err(field, 'too-long', { max: max });
    return s;
  };
  var p = {};
  // name: one line — it becomes a heading in the appended system prompt (Stufe 2), where a newline would
  // start a section nobody wrote. Collapsing whitespace is not a „repair": nothing the user typed is lost.
  var name = text('name', PROJECT_CAPS.name, true);
  if (!name && !errors.some(function (e) { return e.field === 'name'; })) err('name', 'required');
  p.name = name;
  p.description = text('description', PROJECT_CAPS.description);
  var hue = own('hue');
  if (hue == null) p.hue = null;
  else if (typeof hue === 'number' && Math.floor(hue) === hue && hue >= 0 && hue <= 359) p.hue = hue;
  else { err('hue', 'invalid'); p.hue = null; }
  p.cwd = text('cwd', PROJECT_CAPS.path);
  var dirs = own('addDirs');
  p.addDirs = [];
  if (dirs != null && !Array.isArray(dirs)) err('addDirs', 'type');
  else if (Array.isArray(dirs)) {
    // past the scan bound the list is still READ (a hand-edited file keeps what it holds — lib/projects.js
    // writes it back unchanged), but only refused as a whole, never entry by entry
    var dirsOver = dirs.length > PROJECT_CAPS.addDirs * PROJECT_SCAN_FACTOR;
    var seenDir = {};
    for (var i = 0; i < dirs.length; i++) {
      if (typeof dirs[i] !== 'string') { if (!dirsOver) err('addDirs', 'type'); continue; }
      var d = dirs[i].trim();
      if (!d) continue;
      var dk = '#' + projectPathKey(d); // prefixed: a key can never be an Object.prototype member name
      if (seenDir[dk]) continue;
      seenDir[dk] = true;
      if (d.length > PROJECT_CAPS.path && !dirsOver) err('addDirs', 'too-long', { max: PROJECT_CAPS.path, value: d });
      p.addDirs.push(d);
    }
    if (dirsOver || p.addDirs.length > PROJECT_CAPS.addDirs) err('addDirs', 'too-many', { max: PROJECT_CAPS.addDirs });
  }
  // mcpServers: null = every configured server (no scoping, the CLI default), [] = deliberately none,
  // [names] = exactly these. Three meanings, kept apart — the tab's own picker uses the same encoding.
  var mcp = own('mcpServers');
  if (mcp == null) p.mcpServers = null;
  else if (!Array.isArray(mcp)) { err('mcpServers', 'type'); p.mcpServers = null; }
  else {
    var mcpOver = mcp.length > PROJECT_CAPS.mcpServers * PROJECT_SCAN_FACTOR; // the same bound as addDirs
    var names = [], seenName = {};
    for (var j = 0; j < mcp.length; j++) {
      if (!projectMcpNameOk(mcp[j])) {
        if (!mcpOver) err('mcpServers', 'invalid', { value: String(mcp[j]).slice(0, 80) });
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(seenName, '#' + mcp[j])) continue;
      seenName['#' + mcp[j]] = true;
      names.push(mcp[j]);
    }
    if (mcpOver || names.length > PROJECT_CAPS.mcpServers) err('mcpServers', 'too-many', { max: PROJECT_CAPS.mcpServers });
    p.mcpServers = names;
  }
  // model / agent travel as ONE argv token each (lib/chat.js argIdent): a leading `-` is refused at spawn with
  // a 400 — on every start of this project — so it is refused here, once, where it was typed.
  var model = text('model', PROJECT_CAPS.model);
  if (model && (/\s/.test(model) || /[\x00-\x1f\x7f]/.test(model) || model.charAt(0) === '-')) err('model', 'invalid');
  p.model = model;
  var effort = own('effort');
  if (effort == null || effort === '') p.effort = '';
  else if (typeof effort === 'string' && PROJECT_EFFORTS.indexOf(effort) >= 0) p.effort = effort;
  else { err('effort', 'invalid'); p.effort = ''; }
  var perm = own('permissionMode');
  if (perm == null || perm === '') p.permissionMode = '';
  else if (perm === 'bypassPermissions') { err('permissionMode', 'bypass-forbidden'); p.permissionMode = ''; }
  else if (typeof perm === 'string' && PROJECT_PERM_MODES.indexOf(perm) >= 0) p.permissionMode = perm;
  else { err('permissionMode', 'invalid'); p.permissionMode = ''; }
  var agent = text('agent', PROJECT_CAPS.agent);
  if (agent && (agent.charAt(0) === '-' || /[\\/\x00-\x1f\x7f]/.test(agent))) err('agent', 'invalid');
  p.agent = agent;
  p.instructions = text('instructions', PROJECT_CAPS.instructions);
  var arch = own('archived');
  if (arch == null) p.archived = false;
  else if (typeof arch === 'boolean') p.archived = arch;
  else { err('archived', 'type'); p.archived = false; }
  // ---- P-2 cockpit fields — none of them reaches a start (projectStartValues does not read them) ----
  // paths: folder rules (projectRuleParse). Trimmed, empties dropped, de-duplicated by the comparison key — so
  // `C:\Atlas`, `c:/atlas/` and `C:\ATLAS` are one rule, while `C:\Atlas` and `C:\Atlas*` stay two.
  var rules = own('paths');
  p.paths = [];
  if (rules != null && !Array.isArray(rules)) err('paths', 'type');
  else if (Array.isArray(rules)) {
    var rulesOver = rules.length > PROJECT_CAPS.paths * PROJECT_SCAN_FACTOR;
    var seenRule = {};
    for (var ri = 0; ri < rules.length; ri++) {
      if (typeof rules[ri] !== 'string') { if (!rulesOver) err('paths', 'type'); continue; }
      var rs = rules[ri].trim();
      if (!rs) continue;
      var rp = projectRuleParse(rs);
      var rk = '#' + (rp ? (rp.star ? '*' : '=') + rp.key : '?' + rs);
      if (seenRule[rk]) continue;
      seenRule[rk] = true;
      if (rs.length > PROJECT_CAPS.path + 1 && !rulesOver) err('paths', 'too-long', { max: PROJECT_CAPS.path + 1, value: rs });
      p.paths.push(rs);
    }
    if (rulesOver || p.paths.length > PROJECT_CAPS.paths) err('paths', 'too-many', { max: PROJECT_CAPS.paths });
  }
  // hideInAll: the session list's „Alle" leaves this project's sessions out (Atlas: 193 of 290) — Stufe 2 reads it
  var hide = own('hideInAll');
  if (hide == null) p.hideInAll = false;
  else if (typeof hide === 'boolean') p.hideInAll = hide;
  else { err('hideInAll', 'type'); p.hideInAll = false; }
  // jiraKeys: upper-cased (`acme-1` is ACME-1 — nothing typed is lost), then held to the allow-list shape
  var keys = own('jiraKeys');
  p.jiraKeys = [];
  if (keys != null && !Array.isArray(keys)) err('jiraKeys', 'type');
  else if (Array.isArray(keys)) {
    var keysOver = keys.length > PROJECT_CAPS.jiraKeys * PROJECT_SCAN_FACTOR;
    var seenKey = {};
    for (var ki = 0; ki < keys.length; ki++) {
      if (typeof keys[ki] !== 'string') { if (!keysOver) err('jiraKeys', 'type'); continue; }
      var kk = keys[ki].trim().toUpperCase();
      if (!kk) continue;
      if (!PROJECT_JIRA_KEY_RE.test(kk)) { if (!keysOver) err('jiraKeys', 'invalid', { value: kk.slice(0, 40) }); continue; }
      if (seenKey['#' + kk]) continue;
      seenKey['#' + kk] = true;
      p.jiraKeys.push(kk);
    }
    if (keysOver || p.jiraKeys.length > PROJECT_CAPS.jiraKeys) err('jiraKeys', 'too-many', { max: PROJECT_CAPS.jiraKeys });
  }
  // ---- P2 — neither of these reaches projectStartValues either ----
  // starters: [{ label, prompt }] — a button that opens a chat in the project and SENDS `prompt` at once. The label
  // names the button and the tab, so it is one line and unique (case folded: „Review" and „review" would be two
  // buttons nobody can tell apart). An entry with both halves blank is an empty editor row and dropped; one half
  // blank is `required` — a button without a prompt would send nothing, one without a label has no name.
  var st = own('starters');
  p.starters = [];
  if (st != null && !Array.isArray(st)) err('starters', 'type');
  else if (Array.isArray(st)) {
    var stOver = st.length > PROJECT_CAPS.starters * PROJECT_SCAN_FACTOR;
    var seenLabel = {};
    for (var si = 0; si < st.length; si++) {
      var se = st[si];
      if (!se || typeof se !== 'object' || Array.isArray(se)
          || (se.label != null && typeof se.label !== 'string') || (se.prompt != null && typeof se.prompt !== 'string')) {
        if (!stOver) err('starters', 'type');
        continue;
      }
      var lab = String(se.label == null ? '' : se.label).replace(/\s+/g, ' ').trim();
      var pr = String(se.prompt == null ? '' : se.prompt).trim();
      if (!lab && !pr) continue;
      if (!stOver) {
        if (!lab || !pr) err('starters', 'required', lab ? { value: lab.slice(0, 60) } : undefined);
        if (lab.length > PROJECT_CAPS.starterLabel) err('starters', 'too-long', { max: PROJECT_CAPS.starterLabel, value: lab.slice(0, 60) });
        if (pr.length > PROJECT_CAPS.starterPrompt) err('starters', 'too-long', { max: PROJECT_CAPS.starterPrompt, value: lab.slice(0, 60) });
        var lk = '#' + lab.toLowerCase();
        if (lab && seenLabel[lk]) err('starters', 'duplicate', { value: lab.slice(0, 60) });
        seenLabel[lk] = true;
      }
      p.starters.push({ label: lab, prompt: pr });
    }
    if (stOver || p.starters.length > PROJECT_CAPS.starters) err('starters', 'too-many', { max: PROJECT_CAPS.starters });
  }
  // memory: memory file names (projectMemoryNameOk), de-duplicated case-folded — NTFS does not tell them apart.
  // Whether a name EXISTS is a measurement of lib/projects.js on save (unknown when new, `memory-missing` when gone).
  var mem = own('memory');
  p.memory = [];
  if (mem != null && !Array.isArray(mem)) err('memory', 'type');
  else if (Array.isArray(mem)) {
    var memOver = mem.length > PROJECT_CAPS.memory * PROJECT_SCAN_FACTOR;
    var seenMem = {};
    for (var mi = 0; mi < mem.length; mi++) {
      if (typeof mem[mi] !== 'string') { if (!memOver) err('memory', 'type'); continue; }
      var mn = mem[mi].trim();
      if (!mn) continue;
      if (!projectMemoryNameOk(mn)) { if (!memOver) err('memory', 'invalid', { value: mn.slice(0, 80) }); continue; }
      if (seenMem['#' + mn.toLowerCase()]) continue;
      seenMem['#' + mn.toLowerCase()] = true;
      p.memory.push(mn);
    }
    if (memOver || p.memory.length > PROJECT_CAPS.memory) err('memory', 'too-many', { max: PROJECT_CAPS.memory });
  }
  return { project: p, errors: errors };
}

// ---- projectValidate: content ------------------------------------------------------------------------------
// -> { ok, errors, project, warnings }. `warnings` are only the ones a project shows WITHOUT any measurement
// (projectWarnings with an empty context — a UNC additional directory, a mode that does not ask, an own cwd).
// NUL is refused in every string: spawn() throws on it (`ERR_INVALID_ARG_VALUE`), so a NUL in any field that
// reaches argv or the cwd would make every chat of the project end in a 500.
// opts.posix: the server's path grammar (see projectIsAbsolute) — undefined = this process's own.
function projectValidate(o, opts) {
  var posix = opts && opts.posix !== undefined ? !!opts.posix : undefined;
  var n = projectNormalize(o);
  var p = n.project;
  var coll = projectErrorList(n.errors);
  var add = coll.add;
  ['name', 'description', 'cwd', 'model', 'agent', 'instructions'].forEach(function (f) {
    if (p[f].indexOf('\0') >= 0) add({ field: f, code: 'nul' });
  });
  // entry by entry only inside the scan bound — past it the list is already refused as a whole (`too-many`)
  var dirs = p.addDirs.length > PROJECT_CAPS.addDirs * PROJECT_SCAN_FACTOR ? [] : p.addDirs;
  dirs.forEach(function (d) { if (d.indexOf('\0') >= 0) add({ field: 'addDirs', code: 'nul', value: d }); });
  // a start order's prompt goes out as a chat message — a NUL in it would end that turn in an error, every time
  (p.starters.length > PROJECT_CAPS.starters * PROJECT_SCAN_FACTOR ? [] : p.starters).forEach(function (s) {
    if (s.label.indexOf('\0') >= 0 || s.prompt.indexOf('\0') >= 0) add({ field: 'starters', code: 'nul', value: s.label.replace(/\0/g, '') });
  });
  if (p.cwd) {
    if (projectIsUncOrDevice(p.cwd)) add({ field: 'cwd', code: 'unc' });
    else if (!projectIsAbsolute(p.cwd, posix)) add({ field: 'cwd', code: 'relative' });
  }
  // An additional directory MAY be a share: it becomes nothing but an argv token (lib/chat.js hands UNC
  // --add-dir values on unchecked), so no code in the panel's process ever touches it. Relative stays refused.
  dirs.forEach(function (d) {
    if (!projectIsUncOrDevice(d) && !projectIsAbsolute(d, posix)) add({ field: 'addDirs', code: 'relative', value: d });
  });
  // folder rules (P-2): the grammar of projectRuleParse, an absolute base like an addDir, and none that covers
  // the main folder, HOME or system32. opts.blockedRoots = those folders — the SERVER knows them (lib/projects.js);
  // without them nothing is claimed blocked, and the server's save is the one that refuses.
  var roots = opts && Array.isArray(opts.blockedRoots) ? opts.blockedRoots : [];
  var rulesIn = p.paths.length > PROJECT_CAPS.paths * PROJECT_SCAN_FACTOR ? [] : p.paths;
  rulesIn.forEach(function (r) {
    if (r.indexOf('\0') >= 0) { add({ field: 'paths', code: 'nul', value: r }); return; }
    var rp = projectRuleParse(r);
    if (!rp) { add({ field: 'paths', code: 'invalid', value: r }); return; }
    var base = rp.star ? r.trim().slice(0, -1) : r;
    if (!projectIsUncOrDevice(base) && !projectIsAbsolute(base, posix)) { add({ field: 'paths', code: 'relative', value: r }); return; }
    if (projectRuleBlocked(r, roots)) add({ field: 'paths', code: 'blocked', value: r });
  });
  var errors = coll.list;
  return { ok: errors.length === 0, errors: errors, project: p, warnings: projectWarnings(p, {}) };
}

// ---- projectWarnings: what is allowed but worth saying ------------------------------------------------------
// A PURE derivation from facts that were measured elsewhere — this function never asks the disk. `ctx`:
//   pathState    { "<path exactly as stored>": 'ok' | 'missing' | 'unchecked' } — lib/projects.js fills it on
//                SAVE (local paths only, at most two at a time); a path not in it was simply not checked, and
//                then nothing is claimed about it. 'unchecked' = the check ran out of time (a dead drive).
//   mcpConfigured [names] | null — the configured MCP servers; null = unknown, nothing claimed.
//   mainCwd      the panel's main working directory (ui-prefs defaultCwd, normally C:\WINDOWS\system32).
//   memoryState  { "<memory file name as stored>": 'ok' | 'missing' } (P2) — lib/projects.js reads the memory folder on
//                SAVE; a name not in it was not looked at, and nothing is claimed.
// -> [{ code, field, value? }]
// `cwd-custom` is the one to read twice: the CLI keys its memory and its session folder on the cwd, so a project
// with a cwd of its own does NOT see the MEMORY.md of the main folder — the reason the repo belongs into
// addDirs. Without a known main folder every own cwd is reported: claiming „same folder" unmeasured would be
// the dishonest direction.
function projectWarnings(p, ctx) {
  var out = [];
  if (!p || typeof p !== 'object') return out;
  var c = ctx || {};
  var ps = (c.pathState && typeof c.pathState === 'object') ? c.pathState : {};
  var stateOf = function (path) { return Object.prototype.hasOwnProperty.call(ps, path) ? ps[path] : undefined; };
  var cwd = typeof p.cwd === 'string' ? p.cwd : '';
  if (cwd) {
    var cs = stateOf(cwd);
    if (cs === 'missing') out.push({ code: 'cwd-missing', field: 'cwd', value: cwd });
    else if (cs === 'unchecked') out.push({ code: 'path-unchecked', field: 'cwd', value: cwd });
    if (!c.mainCwd || projectPathKey(cwd) !== projectPathKey(c.mainCwd)) out.push({ code: 'cwd-custom', field: 'cwd', value: cwd });
  }
  (Array.isArray(p.addDirs) ? p.addDirs : []).forEach(function (d) {
    if (typeof d !== 'string' || !d) return;
    if (projectIsUncOrDevice(d)) { out.push({ code: 'adddir-unc', field: 'addDirs', value: d }); return; }
    var s = stateOf(d);
    if (s === 'missing') out.push({ code: 'adddir-missing', field: 'addDirs', value: d });
    else if (s === 'unchecked') out.push({ code: 'path-unchecked', field: 'addDirs', value: d });
  });
  if (Array.isArray(p.mcpServers) && Array.isArray(c.mcpConfigured)) {
    // An unknown name is not refused: a project `.mcp.json` server is legitimate and cannot be enumerated from
    // here. But it costs `claude mcp get` (25 s) per name at every start and is then dropped, so it is SAID.
    var unknown = p.mcpServers.filter(function (n) { return c.mcpConfigured.indexOf(n) < 0; });
    if (unknown.length) out.push({ code: 'mcp-unknown', field: 'mcpServers', value: unknown });
  }
  if (PROJECT_PERM_NOASK.indexOf(p.permissionMode) >= 0) out.push({ code: 'perm-noask', field: 'permissionMode', value: p.permissionMode });
  (Array.isArray(p.jiraKeys) ? p.jiraKeys : []).forEach(function (k) {
    if (projectJiraPlaceholder(k)) out.push({ code: 'jira-placeholder', field: 'jiraKeys', value: k });
  });
  var ms = (c.memoryState && typeof c.memoryState === 'object') ? c.memoryState : {};
  (Array.isArray(p.memory) ? p.memory : []).forEach(function (n) {
    if (typeof n === 'string' && Object.prototype.hasOwnProperty.call(ms, n) && ms[n] === 'missing') out.push({ code: 'memory-missing', field: 'memory', value: n });
  });
  return out;
}

// ---- projectStartValues: what „Neuer Chat im Projekt" copies into the tab -----------------------------------
// -> { cwd, addDirs, mcpServers, model, effort, permissionMode, agent, hue } — '' / [] / null mean „the project
// sets nothing here, keep the tab's own default" (mcpServers null = all servers). With {resume:true} the
// cwd and mcpServers keys are ABSENT (decision 05.10.: a resumed session keeps its folder and its stored MCP).
// Defensive on purpose: the input may come from a hand-edited projects.json, so the same rules as the validator
// filter here — a bypass mode, a UNC/relative cwd or a NUL can never reach a tab through this door.
// opts.posix: the server's path grammar, as in projectValidate.
function projectStartValues(p, opts) {
  var src = (p && typeof p === 'object') ? p : {};
  var resume = !!(opts && opts.resume);
  var posix = opts && opts.posix !== undefined ? !!opts.posix : undefined;
  var str = function (v) { return (typeof v === 'string' && v.indexOf('\0') < 0) ? v.trim() : ''; };
  var out = {};
  if (!resume) {
    var cwd = str(src.cwd);
    out.cwd = (cwd && !projectIsUncOrDevice(cwd) && projectIsAbsolute(cwd, posix) && cwd.length <= PROJECT_CAPS.path) ? cwd : '';
  }
  // the cap here too: lib/chat.js has no ceiling of its own, and a hand-edited file may hold any number
  out.addDirs = (Array.isArray(src.addDirs) ? src.addDirs : []).map(str)
    .filter(function (d) { return d && (projectIsUncOrDevice(d) || projectIsAbsolute(d, posix)); })
    .slice(0, PROJECT_CAPS.addDirs);
  if (!resume) {
    out.mcpServers = Array.isArray(src.mcpServers)
      ? src.mcpServers.filter(projectMcpNameOk).slice(0, PROJECT_CAPS.mcpServers)
      : null;
  }
  var model = str(src.model);
  out.model = (model && !/[\s\x00-\x1f\x7f]/.test(model) && model.charAt(0) !== '-') ? model : '';
  out.effort = PROJECT_EFFORTS.indexOf(src.effort) >= 0 ? src.effort : '';
  out.permissionMode = PROJECT_PERM_MODES.indexOf(src.permissionMode) >= 0 ? src.permissionMode : '';
  var agent = str(src.agent);
  out.agent = (agent && agent.charAt(0) !== '-' && !/[\\/\x00-\x1f\x7f]/.test(agent)) ? agent : '';
  out.hue = (typeof src.hue === 'number' && Math.floor(src.hue) === src.hue && src.hue >= 0 && src.hue <= 359) ? src.hue : null;
  return out;
}

// ---- projectMcpReconcile: the project's MCP names against what is configured NOW --------------------------
// -> { keep, removed, emptied }. Runs right before „Neuer Chat im Projekt" copies the names into a tab (critic
// H3): a name that is no longer configured is not just useless at the start — buildMcpConfigFile falls back to
// `claude mcp get` for it (25 s, one name after the other), and when EVERY name is unknown the session starts
// under --strict-mcp-config with an empty config, i.e. with NO server at all while the project page says
// „MCP 2". So unknown names are dropped (the caller says which), and `emptied` = the project named servers and
// none of them is left — the caller must ASK then instead of starting: „none" is a different session than the
// one the project describes. `names` null (all servers) and [] (deliberately none) pass through untouched;
// `configured` not an array = unknown, nothing claimed (keep everything, remove nothing).
function projectMcpReconcile(names, configured) {
  if (!Array.isArray(names)) return { keep: null, removed: [], emptied: false };
  if (!Array.isArray(configured)) return { keep: names.slice(), removed: [], emptied: false };
  var keep = [], removed = [];
  names.forEach(function (n) { (configured.indexOf(n) >= 0 ? keep : removed).push(n); });
  return { keep: keep, removed: removed, emptied: names.length > 0 && keep.length === 0 };
}

// ---- projectOfSession: which project a session belongs to (P-2) ----------------------------------------------
// item: a session list item ({ id, projectPath } — the transcript's own cwd; a decorated item also carries the
// STORED `projectId`). map: session-projects.json ({ "<uuid lower>": 'p-…' | '' }) or null = read `item.projectId`.
// ctx: { blocked: [folders] } — the roots no rule may cover (see projectRuleBlocked).
// -> { projectId: 'p-…' | '' | null, derived: bool, rule? }
//   · an explicit entry ALWAYS wins — a project id, and '' too („deliberately without a project" is a decision a
//     rule must not overturn, critic H5); a dangling id stays what it is (the view shows „(gelöscht)")
//   · otherwise the most specific folder rule: the longest key; on a tie the folder rule before the `*` rule,
//     then the earlier project in the list — deterministic, never „whichever was read first"
//   · a rule never makes a session explicit: `derived:true` is a LABEL (dashed „per Regel"), it counts into the
//     project's costs, and nothing on the start path reads it (lib/projects.js resolveStartFrom has no cwd input)
function projectOfSession(item, projects, map, ctx) {
  var none = { projectId: null, derived: false };
  if (!item || typeof item !== 'object') return none;
  var id = typeof item.id === 'string' ? item.id.toLowerCase() : '';
  var stored;
  if (map && typeof map === 'object') stored = id && Object.prototype.hasOwnProperty.call(map, id) ? map[id] : null;
  else stored = item.projectId;
  if (stored === '' || (typeof stored === 'string' && PROJECT_ID_RE.test(stored))) return { projectId: stored, derived: false };
  var cwd = typeof item.projectPath === 'string' ? item.projectPath : (typeof item.cwd === 'string' ? item.cwd : '');
  if (!cwd) return none;
  var blocked = ctx && Array.isArray(ctx.blocked) ? ctx.blocked : [];
  var best = null;
  (Array.isArray(projects) ? projects : []).forEach(function (p, order) {
    if (!p || typeof p.id !== 'string' || !PROJECT_ID_RE.test(p.id) || !Array.isArray(p.paths)) return;
    p.paths.forEach(function (rule) {
      var rp = projectRuleParse(rule);
      if (!rp || !projectRuleMatch(rule, cwd) || projectRuleBlocked(rule, blocked)) return;
      var score = rp.key.length * 2 + (rp.star ? 0 : 1);
      if (!best || score > best.score || (score === best.score && order < best.order)) best = { score: score, order: order, projectId: p.id, rule: rule };
    });
  });
  return best ? { projectId: best.projectId, derived: true, rule: best.rule } : none;
}

// ---- projectPlanIndex: slug → plan file, and which projects already own it -----------------------------------
// sessions: decorated list items (slug, projectId); planNames: the file names GET /api/plans lists (subagent plans
// are already out, lib/skills.js). -> { "<slug>": { name, sessionIds[], projectIds[] } } — only slugs whose file
// EXISTS (the CLI hands out a slug before any plan is written: 17 sessions carry one in their first 5 lines), and
// projectIds only from EXPLICIT assignments: a rule must not promote itself into a „strong" plan signal.
// Prototype-less, because a slug like `constructor` is a legal file-name stem.
function projectPlanIndex(sessions, planNames) {
  var files = {};
  (Array.isArray(planNames) ? planNames : []).forEach(function (n) { if (typeof n === 'string') files['#' + n] = true; });
  var idx = Object.create(null);
  (Array.isArray(sessions) ? sessions : []).forEach(function (s) {
    if (!s || typeof s.slug !== 'string' || !s.slug || typeof s.id !== 'string') return;
    if (!files['#' + s.slug + '.md']) return;
    var e = idx[s.slug] || (idx[s.slug] = { name: s.slug + '.md', sessionIds: [], projectIds: [] });
    if (e.sessionIds.indexOf(s.id) < 0) e.sessionIds.push(s.id);
    if (typeof s.projectId === 'string' && PROJECT_ID_RE.test(s.projectId) && e.projectIds.indexOf(s.projectId) < 0) e.projectIds.push(s.projectId);
  });
  return idx;
}

// ---- projectSuggest: which project a session MIGHT belong to (P-2) -------------------------------------------
// Display only — ✓ / ✕ / „alle" by a human, never applied by itself (Julian's decision 05.10.). Three reasons:
//   plan  STRONG  the session's slug names a plan file an explicitly assigned session of the project already has
//                 (slug → plan is exact: 12 of 12 against ExitPlanMode on the live corpus)
//   path  STRONG  a folder rule labels the session — the suggestion turns „per Regel" into an explicit entry
//   jira  WEAK    a key the user TYPED in the session (fold v4: never an injected one, never a placeholder) is one
//                 of the project's jiraKeys — real in only 11 of 290 sessions, so it is a hint, never the reason alone
//                 to rank a project above a strong one
// Never for a session that is decided: an explicit project, or '' = deliberately without (a refused suggestion
// must not come back). Never towards an archived project.
// session: a decorated list item ({ projectId, projectDerived, slug, typedKeys }); plansBySlug: projectPlanIndex.
// -> [{ projectId, strength: 'strong'|'weak', reasons: [{ reason:'plan', plan } | { reason:'path' } |
//      { reason:'jira', keys:[…], mentions }] }], strongest first
function projectSuggest(session, projects, plansBySlug) {
  if (!session || typeof session !== 'object') return [];
  var stored = session.projectId;
  if (stored === '' || (typeof stored === 'string' && PROJECT_ID_RE.test(stored))) return [];
  var list = (Array.isArray(projects) ? projects : []).filter(function (p) {
    return p && typeof p.id === 'string' && PROJECT_ID_RE.test(p.id) && !p.archived;
  });
  var order = {};
  list.forEach(function (p, i) { order['#' + p.id] = i; });
  var acc = {};
  var add = function (pid, r) {
    if (typeof pid !== 'string' || !Object.prototype.hasOwnProperty.call(order, '#' + pid)) return;
    var e = acc['#' + pid] || (acc['#' + pid] = { projectId: pid, strength: 'weak', reasons: [] });
    if (r.reason !== 'jira') e.strength = 'strong';
    e.reasons.push(r);
  };
  var slug = typeof session.slug === 'string' ? session.slug : '';
  var plan = slug && plansBySlug && typeof plansBySlug === 'object' && Object.prototype.hasOwnProperty.call(plansBySlug, slug) ? plansBySlug[slug] : null;
  if (plan && Array.isArray(plan.projectIds)) plan.projectIds.forEach(function (pid) { add(pid, { reason: 'plan', plan: plan.name }); });
  if (typeof session.projectDerived === 'string') add(session.projectDerived, { reason: 'path' });
  var typed = session.typedKeys && typeof session.typedKeys === 'object' ? session.typedKeys : {};
  list.forEach(function (p) {
    var hits = (Array.isArray(p.jiraKeys) ? p.jiraKeys : []).filter(function (k) {
      return typeof k === 'string' && PROJECT_JIRA_KEY_RE.test(k) && !projectJiraPlaceholder(k)
        && Object.prototype.hasOwnProperty.call(typed, k) && typeof typed[k] === 'number' && typed[k] >= 1;
    });
    if (hits.length) add(p.id, { reason: 'jira', keys: hits, mentions: hits.reduce(function (n, k) { return n + typed[k]; }, 0) });
  });
  var rank = { plan: 0, path: 1, jira: 2 };
  var best = function (e) { return Math.min.apply(null, e.reasons.map(function (r) { return rank[r.reason]; })); };
  var mentions = function (e) { var j = e.reasons.filter(function (r) { return r.reason === 'jira'; })[0]; return j ? j.mentions : 0; };
  return Object.keys(acc).map(function (k) { return acc[k]; }).sort(function (a, b) {
    if (a.strength !== b.strength) return a.strength === 'strong' ? -1 : 1;
    if (best(a) !== best(b)) return best(a) - best(b);
    if (mentions(a) !== mentions(b)) return mentions(b) - mentions(a);
    return order['#' + a.projectId] - order['#' + b.projectId];
  });
}

// ---- projectClusters: new projects out of the sessions nobody has decided yet (P5) --------------------------------
// Display only, like projectSuggest: a draft becomes a project when a human presses „Als Projekt anlegen…" and saves —
// and its sessions are assigned only when the editor's (visible) tick is still set then. Nothing here writes anything.
// The thresholds were checked once against the live corpus (CHANGELOG P5); `PROJECT_DRAFT_CAPS` holds them in one place.
//   seed  key  a Jira key the user TYPED (fold v4) in ≥ minKey free sessions         — the strongest signal
//         dir  a repo root (projectRepoRoot) the session's tools touched, in ≥ minDir   (fold v5 `fd`, plus the cwd)
//         mcp  an MCP server in ≥ minMcp sessions, but in ≤ mcpShare of ALL free ones — one every session uses says nothing
// Seeds are taken in that order, the biggest first; each draft takes every still-free session that carries its seed, so
// every session lands in at most ONE draft. What a project already has (its jiraKeys, its cwd / addDirs / folder rules)
// seeds nothing: those sessions are the existing project's suggestions, not a new project. Its mcpServers do NOT count —
// measured 07.10.: the live projects list 6–8 of the 9 configured servers each, a scope list, not a topic.
var PROJECT_DRAFT_CAPS = { drafts: 8, minKey: 2, minDir: 2, minMcp: 3, mcpShare: 0.4, dirShare: 0.3, mcpKeep: 0.5, wordShare: 0.5, jiraKeys: 20, addDirs: 8, minTarget: 2 };
// a folder directly in HOME / on a drive that is a place for everything, never one project
var PROJECT_DRAFT_NOISE_RE = /^(downloads|desktop|documents|dokumente|onedrive.*|appdata|windows|program files.*|programdata|temp|tmp|users|\..*)$/i;
// title words that name no topic (≥ 4 letters — shorter ones never count anyway)
var PROJECT_DRAFT_STOP = ['bitte', 'nicht', 'eine', 'einen', 'einer', 'eines', 'diese', 'dieser', 'dieses', 'oder', 'noch', 'auch',
  'wird', 'sind', 'kann', 'soll', 'sollte', 'nach', 'über', 'unter', 'wenn', 'dann', 'dass', 'aber', 'alle', 'mehr', 'neue', 'neuen',
  'neuer', 'neues', 'mach', 'machen', 'mache', 'jetzt', 'schon', 'hier', 'warum', 'welche', 'prüfe', 'prüfen', 'with', 'from', 'that',
  'this', 'have', 'what', 'please', 'make', 'check', 'chat', 'sitzung', 'session', 'ticket', 'tickets'];
function projectSplitPath(p) {
  var s = String(p == null ? '' : p).trim();
  var win = /^[A-Za-z]:[\\/]/.test(s);
  if (!win && !/^\/(?![\\/])/.test(s)) return null;
  return { win: win, segs: (win ? s.split(/[\\/]+/) : s.split('/')).filter(Boolean) };
}
// The repo a folder belongs to, by its spelling only: HOME + one segment (C:\Users\me\claude-code-ui), else the drive +
// one segment (C:\Atlas). null for HOME itself, a drive root, a catch-all folder (Downloads, Desktop, OneDrive…, a dot
// folder) and another user's profile (C:\Users\other — the second segment of HOME's own spelling).
function projectRepoRoot(dir, home) {
  var d = projectSplitPath(dir);
  if (!d) return null;
  var h = projectSplitPath(home);
  var hs = h && h.win === d.win ? h.segs : [];
  var same = function (a, b) { return a.toLowerCase() === b.toLowerCase(); };
  var under = hs.length > 0 && d.segs.length > hs.length && hs.every(function (x, i) { return same(x, d.segs[i]); });
  var n = under ? hs.length + 1 : 2;
  if (d.segs.length < n) return null;
  if (!under && hs.length > n && same(hs[0], d.segs[0]) && same(hs[1], d.segs[1])) return null;
  if (PROJECT_DRAFT_NOISE_RE.test(d.segs[n - 1])) return null;
  var cut = d.segs.slice(0, n);
  if (d.win) { cut[0] = cut[0].toUpperCase(); return cut.join('\\'); }
  return '/' + cut.join('/');
}
// free: decorated session items ({ id, title, mtime, projectPath, projectId, projectDerived, typedKeys, dirs, mcps });
// only `projectId === null` without a rule label counts — an explicit project, '' (deliberately without) or a rule
// label is a decision this never second-guesses. projects: the stored list. opts: { home, blocked: [folders] } — HOME,
// the main folder and system32 (lib/projects.js blockedRoots) are never a seed and never an addDir.
// opts.assigned: the EXPLICITLY assigned sessions (same item shape) — see target; opts.rootOf: see mapRoot.
// -> [{ key, kind:'key'|'dir'|'mcp', label, name, sessions, sessionIds, titles, lastActivity, target?, targetSessions?,
//       why: { signal, value, sessions }, values: { jiraKeys, addDirs, mcpServers } }]
function projectClusters(free, projects, opts) {
  var C = PROJECT_DRAFT_CAPS;
  var o = opts || {};
  var home = typeof o.home === 'string' ? o.home : '';
  var blocked = (Array.isArray(o.blocked) ? o.blocked : []).concat(home ? [home] : [])
    .filter(function (x) { return typeof x === 'string' && x.trim(); }).map(projectPathKey);
  var has = function (m, k) { return Object.prototype.hasOwnProperty.call(m, k); };
  var takenKey = {}, takenDirs = [], takenRules = [];
  (Array.isArray(projects) ? projects : []).forEach(function (p) {
    if (!p || typeof p !== 'object') return;
    (Array.isArray(p.jiraKeys) ? p.jiraKeys : []).forEach(function (k) { if (typeof k === 'string') takenKey['#' + k.toUpperCase()] = true; });
    [p.cwd].concat(Array.isArray(p.addDirs) ? p.addDirs : []).forEach(function (d) { if (typeof d === 'string' && d.trim()) takenDirs.push(d); });
    (Array.isArray(p.paths) ? p.paths : []).forEach(function (r) { if (typeof r === 'string' && r.trim()) takenRules.push(r); });
  });
  var takenMemo = {};
  var dirTaken = function (root) {
    var rk = '#' + projectPathKey(root);
    if (has(takenMemo, rk)) return takenMemo[rk];
    var t = blocked.indexOf(rk.slice(1)) >= 0
      || takenDirs.some(function (d) { return projectRuleMatch(d, root) || projectRuleMatch(root, d); })
      || takenRules.some(function (r) { return projectRuleMatch(r, root); });
    takenMemo[rk] = t;
    return t;
  };
  // opts.rootOf(root) -> the root it really belongs to (lib/projects.js: a git WORKTREE → its main repo), measured by the
  // caller; anything but a non-empty string keeps the root as it is
  var mapRoot = function (root) {
    var m = typeof o.rootOf === 'function' ? o.rootOf(root) : null;
    return typeof m === 'string' && m ? m : root;
  };
  var sess = (Array.isArray(free) ? free : []).filter(function (s) {
    return s && typeof s === 'object' && typeof s.id === 'string' && s.projectId === null && !s.projectDerived;
  });
  var total = sess.length;
  // per session: its signals, prefixed keys → the value as spelled. open = a free session (what a project already has
  // does not count); an ASSIGNED one (the target check below) keeps every key and root it has
  var sigOf = function (s, open) {
    var x = { s: s, key: {}, dir: {}, mcp: {} };
    var tk = s.typedKeys && typeof s.typedKeys === 'object' ? s.typedKeys : {};
    Object.keys(tk).forEach(function (k) {
      if (PROJECT_JIRA_KEY_RE.test(k) && !projectJiraPlaceholder(k) && typeof tk[k] === 'number' && tk[k] >= 1 && !(open && takenKey['#' + k])) x.key['#' + k] = k;
    });
    var dirs = s.dirs && typeof s.dirs === 'object' ? Object.keys(s.dirs) : [];
    if (typeof s.projectPath === 'string') dirs.push(s.projectPath);
    dirs.forEach(function (d) {
      var root = projectRepoRoot(d, home);
      if (root) root = mapRoot(root);
      if (!root || blocked.indexOf(projectPathKey(root)) >= 0 || (open && dirTaken(root))) return;
      if (!has(x.dir, '#' + projectPathKey(root))) x.dir['#' + projectPathKey(root)] = root;
    });
    var ms = s.mcps && typeof s.mcps === 'object' ? s.mcps : {};
    Object.keys(ms).forEach(function (n) {
      if (!projectMcpNameOk(n) || !(typeof ms[n] === 'number' && ms[n] >= 1)) return;
      x.mcp['#' + n] = n;
    });
    return x;
  };
  var sig = sess.map(function (s) { return sigOf(s, true); });
  // a server in more than mcpShare of ALL free sessions is no seed (it would swallow everything)
  var everywhere = {};
  var mc = {};
  sig.forEach(function (x) { Object.keys(x.mcp).forEach(function (k) { mc[k] = (mc[k] || 0) + 1; }); });
  Object.keys(mc).forEach(function (k) { if (mc[k] > C.mcpShare * total) everywhere[k] = true; });
  var countIn = function (xs, field) {
    var c = {};
    xs.forEach(function (x) { Object.keys(x[field]).forEach(function (k) { if (!c[k]) c[k] = { value: x[field][k], n: 0, last: 0 }; c[k].n++; c[k].last = Math.max(c[k].last, Number(x.s.mtime) || 0); }); });
    return c;
  };
  var ranked = function (c, min) {
    return Object.keys(c).filter(function (k) { return c[k].n >= min; }).sort(function (a, b) {
      return (c[b].n - c[a].n) || (c[b].last - c[a].last) || (a < b ? -1 : a > b ? 1 : 0);
    });
  };
  var baseName = function (p) { var sp = projectSplitPath(p); return sp && sp.segs.length ? sp.segs[sp.segs.length - 1] : String(p); };
  var titleWord = function (members, label) {
    var c = {}, first = {};
    members.forEach(function (x) {
      var seen = {};
      String(x.s.title || '').split(/[^0-9A-Za-zÀ-ÖØ-öø-ÿ_-]+/).forEach(function (w) {
        if (!/^[A-Za-zÀ-ÖØ-öø-ÿ]{4,}$/.test(w)) return;
        var lw = '#' + w.toLowerCase();
        if (seen[lw] || PROJECT_DRAFT_STOP.indexOf(lw.slice(1)) >= 0 || lw.slice(1) === String(label).toLowerCase()) return;
        seen[lw] = true;
        c[lw] = (c[lw] || 0) + 1;
        if (!first[lw]) first[lw] = w;
      });
    });
    var best = Object.keys(c).filter(function (k) { return c[k] >= C.wordShare * members.length; })
      .sort(function (a, b) { return (c[b] - c[a]) || (a < b ? -1 : 1); })[0];
    return best ? first[best] : '';
  };
  var build = function (kind, seed, value, members) {
    var n = members.length;
    var byCount = function (c, keep, cap, lead) {
      var out = ranked(c, 1).filter(function (k) { return k === lead || keep(c[k].n); }).map(function (k) { return c[k].value; });
      if (lead && has(c, lead)) { var lv = c[lead].value; out = [lv].concat(out.filter(function (v) { return v !== lv; })); }
      return out.slice(0, cap);
    };
    var srv = byCount(countIn(members, 'mcp'), function (k) { return k >= C.mcpKeep * n; }, PROJECT_CAPS.mcpServers, kind === 'mcp' ? seed : null);
    var label = kind === 'dir' ? baseName(value) : value;
    var word = titleWord(members, label);
    var name = (word ? word + ' · ' + label : label).slice(0, PROJECT_CAPS.name);
    var sorted = members.slice().sort(function (a, b) { return (Number(b.s.mtime) || 0) - (Number(a.s.mtime) || 0); });
    return {
      key: kind.charAt(0) + ':' + (kind === 'dir' ? projectPathKey(value) : value),
      kind: kind, label: label, name: name, sessions: n,
      sessionIds: sorted.map(function (x) { return x.s.id; }),
      titles: sorted.map(function (x) { return String(x.s.title || x.s.id.slice(0, 8)); }),
      lastActivity: sorted.length ? Number(sorted[0].s.mtime) || 0 : 0,
      why: { signal: kind, value: value, sessions: n },
      values: {
        jiraKeys: byCount(countIn(members, 'key'), function (k) { return k >= 2; }, C.jiraKeys, kind === 'key' ? seed : null),
        addDirs: byCount(countIn(members, 'dir'), function (k) { return k >= 2 || k >= C.dirShare * n; }, C.addDirs, kind === 'dir' ? seed : null),
        mcpServers: srv.length ? srv : null,
      },
    };
  };
  var left = sig.slice();
  var drafts = [];
  [['key', C.minKey], ['dir', C.minDir], ['mcp', C.minMcp]].forEach(function (ph) {
    var field = ph[0];
    while (drafts.length < C.drafts) {
      var c = countIn(left, field);
      var pick = ranked(c, ph[1]).filter(function (k) { return field !== 'mcp' || !everywhere[k]; })[0];
      if (!pick) break;
      var members = left.filter(function (x) { return has(x[field], pick); });
      drafts.push(build(field, pick, c[pick].value, members));
      left = left.filter(function (x) { return members.indexOf(x) < 0; });
    }
  });
  // An EXISTING project instead of a duplicate: when the sessions explicitly assigned to projects carry a draft's seed
  // (the same ticket, the same repo root), at least minTarget of them, and the MAJORITY of those hits sit in ONE
  // non-archived project (one wrongly assigned session must not pull a whole cluster over), the draft
  // becomes `target: projectId` — the view offers „zu <Projekt> hinzufügen" instead of „Als Projekt anlegen".
  var live = {};
  (Array.isArray(projects) ? projects : []).forEach(function (p) { if (p && typeof p.id === 'string' && PROJECT_ID_RE.test(p.id) && !p.archived) live['#' + p.id] = true; });
  var asg = (Array.isArray(o.assigned) ? o.assigned : []).filter(function (s) {
    return s && typeof s === 'object' && typeof s.projectId === 'string' && has(live, '#' + s.projectId);
  }).map(function (s) { return sigOf(s, false); });
  drafts.forEach(function (d) {
    if (d.kind !== 'key' && d.kind !== 'dir') return;
    var seed = '#' + (d.kind === 'dir' ? projectPathKey(d.why.value) : d.why.value);
    var hits = {}, all = 0;
    asg.forEach(function (x) { if (has(x[d.kind], seed)) { hits['#' + x.s.projectId] = (hits['#' + x.s.projectId] || 0) + 1; all++; } });
    var best = Object.keys(hits).sort(function (a, b) { return (hits[b] - hits[a]) || (a < b ? -1 : 1); })[0];
    if (best && hits[best] >= C.minTarget && hits[best] * 2 > all) { d.target = best.slice(1); d.targetSessions = hits[best]; }
  });
  return drafts;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PROJECT_CAPS, PROJECT_SCAN_FACTOR, PROJECT_ID_RE, PROJECT_PERM_MODES, PROJECT_PERM_NOASK, PROJECT_EFFORTS, PROJECT_FIELDS,
    PROJECT_START_KEYS, PROJECT_ERROR_CODES, PROJECT_WARNING_CODES, PROJECT_MCP_NAME_RE, PROJECT_MCP_FORBIDDEN,
    projectIsUncOrDevice, projectIsAbsolute, projectPosixDefault, projectPathKey, projectMcpNameOk, projectErrorList,
    projectNormalize, projectValidate, projectWarnings, projectStartValues, projectMcpReconcile,
    PROJECT_JIRA_PREFIXES, PROJECT_JIRA_KEY_RE, PROJECT_JIRA_PLACEHOLDERS,
    projectRuleParse, projectRuleMatch, projectRuleBlocked, projectJiraPlaceholder,
    projectOfSession, projectPlanIndex, projectSuggest,
    PROJECT_DRAFT_CAPS, projectRepoRoot, projectClusters,
    PROJECT_MEMORY_NAME_RE, projectMemoryNameOk,
  };
}
