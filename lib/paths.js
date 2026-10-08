'use strict';
// Shared path & binary constants for the Claude Code Control Panel backend.
// Extracted from server.js (structure-only refactor) so lib/* modules can require them without duplicating.
// NOTE: this file lives in lib/, so project-root files resolve via ROOT (= __dirname/..), NOT __dirname.
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const { execFileSync, execFile } = require('child_process');
const { probePath, withinOr, PROBE_TIMEOUT_MS } = require('./reach');

const HOME = os.homedir();
const ROOT = path.join(__dirname, '..'); // project root (parent of lib/)

// ~/.claude data.
// CLAUDE_UI_CLAUDE_DIR is a test-only seam (like CLAUDE_UI_DATA_DIR / CLAUDE_UI_FAKE_BIN): point it at
// a temp tree and settings / projects / backups / sessions all move with it, so a test can write
// settings, restore backups or scan a fixture transcript corpus WITHOUT touching the real ~/.claude.
// Inert in production (unset → ~/.claude, unchanged).
const CLAUDE_DIR = process.env.CLAUDE_UI_CLAUDE_DIR || path.join(HOME, '.claude');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const SETTINGS_LOCAL = path.join(CLAUDE_DIR, 'settings.local.json');
// Same test-only seam as CLAUDE_UI_CLAUDE_DIR, but for the CLI's own config file: it does NOT live
// under ~/.claude, so it needs its own override. Point it at a fixture and the MCP server set, the
// plugin list and the update check can be tested without touching the real ~/.claude.json.
const CLAUDE_JSON = process.env.CLAUDE_UI_CLAUDE_JSON || path.join(HOME, '.claude.json');
// Managed (MDM/policy) settings — an organisation's file, not the user's. The panel reads exactly one
// key out of it: `modelPricing` (CLI 2.1.271), because a managed rate makes every cost this UI prints
// wrong otherwise. The CLI's own env override wins, then the per-platform default; most machines have
// none of them, and then nothing here exists and nothing changes.
const MANAGED_SETTINGS = process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH
  || (process.platform === 'win32' ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'ClaudeCode', 'managed-settings.json')
    : process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json'
      : '/etc/claude-code/managed-settings.json');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
// The CLI's own prompt history — one JSON object per line, written by the terminal REPL's input box:
// { display, pastedContents, timestamp, project, sessionId }. Read-only for the panel; the CLI prunes
// it by its own retention rules.
const CLI_HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const BACKUP_DIR = path.join(CLAUDE_DIR, 'backups', 'claude-code-ui');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PLUGINS_DIR = path.join(CLAUDE_DIR, 'plugins', 'marketplaces');
// Plan artefacts written by plan mode. They are the output of the most expensive thinking in a
// session and were invisible to the panel until now (A7).
const PLANS_DIR = path.join(CLAUDE_DIR, 'plans');

// app-owned data files (project root). CLAUDE_UI_DATA_DIR is a test-only seam (like
// CLAUDE_UI_FAKE_BIN): a throwaway test server writes its stores into a temp dir instead
// of the live ones. Inert in production (unset → project root, unchanged).
const DATA_DIR = process.env.CLAUDE_UI_DATA_DIR || ROOT;
// The panel's OWN git checkout — the one the version/update routes read, pull and report as
// „App-Version". CLAUDE_UI_REPO_DIR is the test-only seam for it (same family as DATA_DIR above):
// without it those routes can only be exercised against the developer's live working tree, so the
// update test either asserted nothing (tree happens to be dirty) or performed a REAL pull in the
// checkout the suite runs from. Point it at a throwaway repo and the whole contract — behind/ahead,
// the dirty refusals, the branch switch, a successful fast-forward — becomes testable without
// touching anything real. Inert in production (unset → project root, unchanged).
const REPO_DIR = process.env.CLAUDE_UI_REPO_DIR || ROOT;
const FAVORITES_FILE = path.join(DATA_DIR, 'favorites.json');
const NAMES_FILE = path.join(DATA_DIR, 'session-names.json');
const MCP_SEL_FILE = path.join(DATA_DIR, 'session-mcp.json'); // sessionId -> [enabled server names] (per-session MCP scope, authoritative)
const PREFS_FILE = path.join(DATA_DIR, 'ui-prefs.json');
const UISKILL_RUNS_FILE = path.join(DATA_DIR, 'ui-skill-runs.json');
const UISKILL_SCHEDULES_FILE = path.join(DATA_DIR, 'ui-skill-schedules.json');
const SKILL_FAV_FILE = path.join(DATA_DIR, 'skill-favorites.json');
const PROMPTS_FILE = path.join(DATA_DIR, 'prompts.json');
// D4 — the corrections you give ("nicht so, sondern so"). Within a session a correction lands; across
// sessions it used to evaporate unless someone remembered to write a memory file about it. New chats
// get the newest ones back through the appended system prompt (see lib/pure composeAppendSystem).
const CORRECTIONS_FILE = path.join(DATA_DIR, 'corrections.json');
const SPEND_CACHE_FILE = path.join(DATA_DIR, 'spend-cache.json'); // cached Spend-Limit-Manager snapshot
// Which Claude models this machine's Bedrock role may actually invoke (lib/bedrock.js). Measured, not
// configured: on Bedrock nothing on disk says what the IAM policy allows, so the panel asks Bedrock and
// remembers the answer here. Cheap to rebuild (a probe costs no tokens), so losing the file is harmless.
const BEDROCK_ACCESS_FILE = path.join(DATA_DIR, 'bedrock-models.json');
// A13 — the prompts SENT FROM THIS PANEL. The CLI keeps its own history (CLI_HISTORY_FILE below) but
// only for what was typed in the terminal REPL; a panel prompt goes in as a stream-json message and
// appears nowhere. Kept here rather than in localStorage so the history survives a cleared browser
// profile, is searchable server-side, and is the same list on every browser that opens the panel.
const PROMPT_HISTORY_FILE = path.join(DATA_DIR, 'prompt-history.json');
// P-1 — the panel's PROJECTS (start profile + label, lib/projects.js). Not to be confused with PROJECTS_DIR
// above: that is the CLI's per-working-directory transcript tree, these are the user's own named projects.
// Two files, because they change at different rates and for different reasons: the definitions are edited by
// hand in the editor, the session → project map grows with every chat that is started or assigned.
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');                  // [{ id:'p-xxxxxxxx', name, … }]
const SESSION_PROJECTS_FILE = path.join(DATA_DIR, 'session-projects.json');  // { "<session uuid, lower>": "p-…" | "" }
const PUBLIC_DIR = path.join(ROOT, 'public');

// GitHub Enterprise personal-access-token store (shared with the GitHub MCP server) — used by the Report-Bug
// view (create issue) and the PR-status footer. JSON shape: { "token": "<pat>" }.
// CLAUDE_UI_GHE_CREDS is the test-only seam (same family as CLAUDE_UI_DATA_DIR): the route-parity sweep
// probes every GHE route, and without it each probe went out with the developer's REAL PAT. Point it at
// a dummy file and the routes are exercised with a token that opens nothing. Inert in production.
const GHE_CREDS = process.env.CLAUDE_UI_GHE_CREDS || path.join(HOME, '.config', 'ghe', 'credentials.json');
// The logged-in DEBUG browser the spend fetch drives (lib/spend.js). CLAUDE_UI_CDP_URL is the test-only
// seam: `POST /api/spend/refresh` opens a TAB in that browser when the dashboard isn't open yet,
// so a test that reached the real :9222 opened an Edge tab on the developer's screen. Point it at a dead
// port and the route answers its honest 502 instead. Inert in production (unset → 127.0.0.1:9222).
const CDP_URL = process.env.CLAUDE_UI_CDP_URL || 'http://127.0.0.1:9222'; // never "localhost" — Node resolves ::1 → ECONNREFUSED
// Where a restarted server (POST /api/restart) logs; start.ps1 writes the same file. Under the
// CLAUDE_UI_DATA_DIR seam it moves into that dir, so a test that restarts its throwaway server does not
// append to the live panel's log.
const SERVER_LOG = process.env.CLAUDE_UI_DATA_DIR
  ? path.join(DATA_DIR, 'server.log')
  : path.join(process.env.LOCALAPPDATA || ROOT, 'claude-code-ui', 'server.log');
// The folded transcript corpus (lib/corpus.js) — the ONLY versioned store in the repo, because it caches
// DERIVED numbers and a counting-rule change must invalidate it. It follows SERVER_LOG's pattern, not the
// pattern of the other stores, and that is deliberate: in production DATA_DIR === ROOT === the panel's own
// git checkout, lib/pure.js parsePorcelain keeps `??` lines, so an untracked 2 MB cache there makes
// `git status --porcelain` dirty and POST /api/version/pull answers 409 `dirty-main` FOREVER — the panel
// would permanently block its own Update button. LOCALAPPDATA also gives the main checkout and a worktree
// ONE shared cache, and the CLAUDE_UI_DATA_DIR seam keeps it testable (and out of the git tree).
const TRANSCRIPT_CACHE_FILE = process.env.CLAUDE_UI_DATA_DIR
  ? path.join(DATA_DIR, 'transcript-cache.json')
  : path.join(process.env.LOCALAPPDATA || ROOT, 'claude-code-ui', 'transcript-cache.json');

// N9 — the API token: the one thing a SECOND LOCAL USER of this machine does not have. Host, Origin,
// Sec-Fetch-Site and X-CCUI all judge a BROWSER on a foreign page; none of them stops `curl` from another
// Windows account, which reaches 127.0.0.1 and sets any header it likes.
// NOT under DATA_DIR, and that is the deviation worth naming: in production DATA_DIR === ROOT === the
// panel's own git checkout, so the token would sit one `git add -A` away from a commit. It follows
// SERVER_LOG / TRANSCRIPT_CACHE_FILE instead — a per-user directory, because the file's ONLY protection is
// the directory's ACL. Measured on this machine with `icacls`: `C:\Users\<user>` grants exactly
// SYSTEM, Administrators and the owning user (plus one AppContainer SID with (S,X) on the folder) — no
// `Users`, `Authenticated Users` or `Everyone` entry — and `%LOCALAPPDATA%\claude-code-ui` inherits those
// three unchanged. So another standard account cannot read it; a machine Administrator can, and nothing
// in user space changes that (that is what the Named-Pipe-with-DACL idea in docs/ideas.md would buy).
// Off Windows there is no LOCALAPPDATA: `~/.claude-code-ui` instead, and the write below uses mode 0600,
// which is the only thing that matters there. Under the CLAUDE_UI_DATA_DIR seam it moves into the
// sandbox, so a test can read the very token its server generated. Inert in production (unset).
// USER_STATE_DIR is module-local, not exported: nothing outside imports it, and SERVER_LOG /
// TRANSCRIPT_CACHE_FILE above cannot simply switch to it — their off-Windows fallback is ROOT, this one's
// is ~/.claude-code-ui (ROOT is the checkout, exactly where a SECRET must not land), so unifying them
// would move two existing files on Linux/macOS. That is a change of its own, not a tidy-up of this one.
const USER_STATE_DIR = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'claude-code-ui')
  : path.join(HOME, '.claude-code-ui');
const API_TOKEN_FILE = process.env.CLAUDE_UI_DATA_DIR
  ? path.join(DATA_DIR, 'api-token')
  : path.join(USER_STATE_DIR, 'api-token');

// server bind
const HOST = '127.0.0.1';
const PORT = Number(process.env.CLAUDE_UI_PORT || 8787);

// ---------------------------------------------------------------------------
//  Locate the claude binary
// ---------------------------------------------------------------------------
// This used to be ONE hardcoded path (%APPDATA%\npm\node_modules\…\bin\claude.exe) — correct for a
// default `npm i -g` on the machine it was written on, wrong for the native installer, for a custom
// npm prefix and for nvm. A colleague who clones the repo then gets „claude.exe nicht gefunden —
// Chat deaktiviert" with no way forward except guessing an env var. Detection now walks an explicit
// order of sources AND reports which one won (startup log + System view), because „not found" is
// only actionable if you can see where it looked:
//   1. CLAUDE_UI_CLAUDE_BIN        explicit override; honoured even when the file is missing, so a
//                                  typo surfaces as a named path instead of being silently re-guessed
//   2. claudeBin in ui-prefs.json  the same override, persisted, no env var needed
//   3. PATH                        what `claude` means in the user's own terminal (a Windows
//                                  claude.cmd shim is resolved to the .exe it calls — child_process
//                                  refuses to spawn .cmd/.bat without a shell)
//   4. known install locations     native (~/.local/bin, ~/.claude/versions/<v>), migrate-installer
//                                  (~/.claude/local), npm-global under the usual prefixes
//   5. `npm prefix -g`             one sync spawn, only when 1–4 all missed
// Resolution runs once at require time. A Claude installed WHILE the panel runs needs a restart
// (sidebar → Neustart) — the resolved path is a constant for every consumer.
const PKG_BIN = ['node_modules', '@anthropic-ai', 'claude-code', 'bin']; // npm package layout, bin = bin/claude.exe

function binName(platform) { return platform === 'win32' ? 'claude.exe' : 'claude'; }
// Join with the TARGET platform's rules, not the host's: everything below builds candidate paths for
// `platform`, and path.join on Windows would turn a posix candidate into `\usr\local\…`.
function joiner(platform) { return platform === 'win32' ? path.win32 : path.posix; }
// The pre-existing guess, kept as the value CLAUDE_EXE falls back to on a total miss: every
// „not found at <path>" message stays a concrete path rather than an empty string.
function defaultClaudeExe(env, home, platform) {
  const P = joiner(platform);
  return P.join(env.APPDATA || P.join(home, 'AppData', 'Roaming'), 'npm', ...PKG_BIN, binName(platform));
}

// fs seams — every one of these is injectable through resolveClaudeBin(opts) so the resolver can be
// unit-tested against a fixture machine (see test/claude-bin.test.js) instead of the real disk.
// N12: the sync ones run at REQUIRE time only (before the server listens) and never on the configured
// path — see resolveClaudeBin below. Every later resolution is resolveClaudeBinAsync.
function isFileSync(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function readTextSync(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function listDirSync(p) { try { return fs.readdirSync(p); } catch { return []; } }
// The BOM is stripped on purpose (escaped, not literal, so it stays visible in an editor): a
// hand-edited ui-prefs.json — Notepad, or `Set-Content -Encoding utf8` on PowerShell 5.1 — starts with
// U+FEFF, JSON.parse throws on it, and the override would be ignored WITHOUT a word: exactly the kind
// of silent failure this resolver exists to end.
function readJsonSync(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return null; } }
function npmGlobalPrefix() {
  try {
    // shell:true on Windows: npm is npm.cmd and Node refuses to spawn .cmd/.bat without a shell.
    const win = process.platform === 'win32';
    const out = execFileSync(win ? 'npm.cmd' : 'npm', ['prefix', '-g'], {
      encoding: 'utf8', timeout: 15000, windowsHide: true, shell: win, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(out).trim().split(/\r?\n/).pop().trim();
  } catch { return ''; } // no npm on PATH (native install) — not an error, just no answer
}

// The async twins (N12). Each one has a deadline (lib/reach.js), because a refresh that waits for the OS on
// a dead share never settles and so never refreshes; a timeout answers like a miss.
const asyncFs = {
  isFile: async (p) => { const r = await probePath(p); return r.state === 'ok' && r.stat.isFile(); },
  readText: (p) => withinOr(fsp.readFile(p, 'utf8'), PROBE_TIMEOUT_MS, ''),
  listDir: (p) => withinOr(fsp.readdir(p), PROBE_TIMEOUT_MS, []),
  readJson: async (p) => {
    const t = await withinOr(fsp.readFile(p, 'utf8'), PROBE_TIMEOUT_MS, null);
    try { return t == null ? null : JSON.parse(String(t).replace(/^﻿/, '')); } catch { return null; }
  },
  npmPrefix: () => new Promise((resolve) => {
    const win = process.platform === 'win32';
    try {
      execFile(win ? 'npm.cmd' : 'npm', ['prefix', '-g'], { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: win },
        (err, out) => resolve(err ? '' : String(out || '').trim().split(/\r?\n/).pop().trim()));
    } catch { resolve(''); }
  }),
};

// The resolver is written ONCE, as a generator that yields every question it has for the filesystem
// (`[op, arg]`) and is driven either synchronously (require time) or asynchronously (every later look).
// Two copies of the detection order would drift apart, and the order IS the documentation of where we look.
function driveSync(gen, deps) {
  let r = gen.next();
  while (!r.done) r = gen.next(deps[r.value[0]](r.value[1]));
  return r.value;
}
async function driveAsync(gen, deps) {
  let r = gen.next();
  while (!r.done) r = gen.next(await deps[r.value[0]](r.value[1]));
  return r.value;
}

// newest first, so a native install with several versions side by side resolves to the current one
function* versionDirs(dir) {
  const cmp = (a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return y - x; }
    return a < b ? 1 : a > b ? -1 : 0;
  };
  const names = yield ['listDir', dir];
  return (Array.isArray(names) ? names : []).filter((n) => /^\d+\.\d+\.\d+/.test(n)).sort(cmp);
}

// Every install location we can name without asking anyone. Order = most specific first; the list is
// also what a miss reports as „tried", so it doubles as the documentation of where we looked.
function* binCandidates(env, home, platform) {
  const win = platform === 'win32';
  const P = joiner(platform);
  const bin = binName(platform);
  const out = [];
  const add = (p, source) => out.push({ path: p, source });

  // native installer (`claude install` / install.sh): stable launcher + versioned binaries
  add(P.join(home, '.local', 'bin', bin), 'native (~/.local/bin)');
  const versRoot = P.join(home, '.claude', 'versions');
  for (const v of yield* versionDirs(versRoot)) add(P.join(versRoot, v, bin), 'native (~/.claude/versions/' + v + ')');
  // `claude migrate-installer` relocates a global npm install here
  add(P.join(home, '.claude', 'local', bin), 'npm-local (~/.claude/local)');
  add(P.join(home, '.claude', 'local', ...PKG_BIN, bin), 'npm-local (~/.claude/local)');

  // npm-global under the prefixes that exist in practice
  const prefixes = [];
  if (env.npm_config_prefix) prefixes.push(env.npm_config_prefix); // `npm config set prefix`, exported by npm
  if (win) {
    prefixes.push(P.join(env.APPDATA || P.join(home, 'AppData', 'Roaming'), 'npm'));
    prefixes.push(P.join(env.LOCALAPPDATA || P.join(home, 'AppData', 'Local'), 'npm'));
    if (env.NVM_SYMLINK) prefixes.push(env.NVM_SYMLINK); // nvm-windows' "current version" junction
    if (env.ProgramFiles) prefixes.push(P.join(env.ProgramFiles, 'nodejs'));
  } else {
    prefixes.push('/usr/local', '/usr', '/opt/homebrew', P.join(home, '.npm-global'), P.join(home, '.local'));
  }
  for (const pre of prefixes) {
    add(P.join(pre, ...PKG_BIN, bin), 'npm-global (' + pre + ')');          // Windows prefix layout
    add(P.join(pre, 'lib', ...PKG_BIN, bin), 'npm-global (' + pre + ')');   // unix prefix layout
    add(P.join(pre, 'bin', bin), 'npm-global (' + pre + ')');               // unix prefix/bin symlink
  }
  return out;
}

// A .cmd/.ps1 shim is not spawnable without a shell (and a shell would break the stdio/kill handling
// the chat engine depends on), so the shim is only ever a pointer to the real binary.
function* resolveWindowsShim(shim, dir) {
  // npm's generated claude.cmd calls "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
  const sibling = path.win32.join(dir, ...PKG_BIN, 'claude.exe');
  if (yield ['isFile', sibling]) return sibling;
  // anything else: take the last claude.exe path the shim mentions and expand its %dp0% / $basedir
  const m = String(yield ['readText', shim]).match(/((?:%~?dp0%?|\$basedir|[A-Za-z]:)[^"'\r\n]*claude\.exe)/i);
  if (!m) return '';
  const p = path.win32.normalize(m[1].replace(/%~?dp0%?/gi, dir + path.win32.sep).replace(/\$basedir/gi, dir));
  return (yield ['isFile', p]) ? p : '';
}

function* fromSearchPath(env, platform, tried) {
  const win = platform === 'win32';
  const P = joiner(platform);
  const names = win ? ['claude.exe', 'claude.cmd', 'claude.bat', 'claude.ps1'] : ['claude'];
  for (const raw of String(env.PATH || env.Path || '').split(win ? ';' : ':')) {
    const dir = raw.trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    for (const n of names) {
      const hit = P.join(dir, n);
      if (!(yield ['isFile', hit])) continue;
      tried.push(hit);
      if (!win || n === 'claude.exe') return { path: hit, source: 'PATH' };
      const real = yield* resolveWindowsShim(hit, dir);
      if (real) return { path: real, source: 'PATH (' + n + ')' };
    }
  }
  return null;
}

// The configured path (env, ui-prefs) is asked as its own op, `isConfigured`, because it is the one a USER
// chose — routinely a share on a corporate machine — and the sync driver must not stat it (below).
function* binSteps(env, home, platform, prefsFile, claudeJson) {
  const tried = [];

  const envBin = String(env.CLAUDE_UI_CLAUDE_BIN || '').trim();
  if (envBin) return { path: envBin, source: 'CLAUDE_UI_CLAUDE_BIN', exists: yield ['isConfigured', envBin], tried };

  const prefs = prefsFile ? yield ['readJson', prefsFile] : null;
  const prefBin = prefs && typeof prefs.claudeBin === 'string' ? prefs.claudeBin.trim() : '';
  if (prefBin) return { path: prefBin, source: 'ui-prefs.json (claudeBin)', exists: yield ['isConfigured', prefBin], tried };

  const onPath = yield* fromSearchPath(env, platform, tried);
  if (onPath) return { path: onPath.path, source: onPath.source, exists: true, tried };

  for (const c of yield* binCandidates(env, home, platform)) {
    tried.push(c.path);
    if (yield ['isFile', c.path]) return { path: c.path, source: c.source, exists: true, tried };
  }

  const prefix = String((yield ['npmPrefix']) || '').trim();
  if (prefix) {
    const P = joiner(platform);
    const bin = binName(platform);
    for (const p of [P.join(prefix, ...PKG_BIN, bin), P.join(prefix, 'lib', ...PKG_BIN, bin), P.join(prefix, 'bin', bin)]) {
      tried.push(p);
      if (yield ['isFile', p]) return { path: p, source: 'npm prefix -g (' + prefix + ')', exists: true, tried };
    }
  }

  const cj = claudeJson ? yield ['readJson', claudeJson] : null;
  return {
    path: defaultClaudeExe(env, home, platform), source: 'not-found', exists: false, tried,
    installMethod: (cj && typeof cj.installMethod === 'string') ? cj.installMethod : '',
  };
}
function stepsFor(opts) {
  return binSteps(opts.env || process.env, opts.home || HOME, opts.platform || process.platform,
    opts.prefsFile === undefined ? PREFS_FILE : opts.prefsFile, opts.claudeJson === undefined ? CLAUDE_JSON : opts.claudeJson);
}

// -> { path, source, exists, tried[], installMethod }  (installMethod only on a miss: it is the CLI's
// own statement in ~/.claude.json about how it was installed and narrows down where to look next)
// SYNCHRONOUS, and therefore only for require time: the configured path is taken as named but NOT
// looked at — `exists: null`, „not asked" — unless a test injects `isFile`. Measured on a share whose host
// does not answer, that one statSync held the whole process for ~44 s at every panel start (N12); its
// answer is now resolveClaudeBinAsync's, and the server holds it in a cache (server.js BIN_STATE).
function resolveClaudeBin(o) {
  const opts = o || {};
  return driveSync(stepsFor(opts), {
    isFile: opts.isFile || isFileSync,
    isConfigured: opts.isFile || (() => null),
    readText: opts.readText || readTextSync,
    listDir: opts.listDir || listDirSync,
    readJson: opts.readJson || readJsonSync,
    npmPrefix: opts.npmPrefix || npmGlobalPrefix,
  });
}
// The same order, every lookup awaited and bounded (lib/reach.js) — the event loop stays free however
// dead the share is. Same seams as the sync form; they may return a value or a promise.
function resolveClaudeBinAsync(o) {
  const opts = o || {};
  return driveAsync(stepsFor(opts), {
    isFile: opts.isFile || asyncFs.isFile,
    isConfigured: opts.isFile || asyncFs.isFile,
    readText: opts.readText || asyncFs.readText,
    listDir: opts.listDir || asyncFs.listDir,
    readJson: opts.readJson || asyncFs.readJson,
    npmPrefix: opts.npmPrefix || asyncFs.npmPrefix,
  });
}

const DEFAULT_CLAUDE_EXE = defaultClaudeExe(process.env, HOME, process.platform);
const CLAUDE_BIN_INFO = resolveClaudeBin();
const CLAUDE_EXE = CLAUDE_BIN_INFO.path;

module.exports = {
  // DATA_DIR was NOT exported before, so `require('./paths').DATA_DIR` was undefined — and it does not
  // resolve relative to the CWD either (ROOT = __dirname/.., i.e. the module's own checkout).
  HOME, ROOT, REPO_DIR, DATA_DIR, CLAUDE_DIR, SETTINGS, SETTINGS_LOCAL, MANAGED_SETTINGS, CLAUDE_JSON, PROJECTS_DIR,
  BACKUP_DIR, SESSIONS_DIR, PLUGINS_DIR, PLANS_DIR, FAVORITES_FILE, NAMES_FILE, MCP_SEL_FILE,
  PREFS_FILE, UISKILL_RUNS_FILE, UISKILL_SCHEDULES_FILE, SKILL_FAV_FILE, PROMPTS_FILE, CORRECTIONS_FILE,
  SPEND_CACHE_FILE, BEDROCK_ACCESS_FILE, CLI_HISTORY_FILE, PROMPT_HISTORY_FILE, TRANSCRIPT_CACHE_FILE,
  API_TOKEN_FILE, PROJECTS_FILE, SESSION_PROJECTS_FILE,
  PUBLIC_DIR, GHE_CREDS, CDP_URL, SERVER_LOG, HOST, PORT, DEFAULT_CLAUDE_EXE, CLAUDE_EXE,
  CLAUDE_BIN_INFO, resolveClaudeBin, resolveClaudeBinAsync, defaultClaudeExe,
};
