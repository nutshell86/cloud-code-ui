'use strict';
// ============================================================
//  Claude Code CLI (claude.exe) — version state + the 1-click update
// ============================================================
// The System view could always SAY „↑ 2.1.267", but updating meant leaving the panel for a terminal.
// Deliberately NOT hardcoding `npm install -g @anthropic-ai/claude-code@latest`: the binary carries
// its own updater and knows how it was installed (npm-global / npm-local / native — the strings
// „AutoUpdater: Using global update method" et al. live inside claude.exe), so `claude update` is the
// one command that stays correct when the install method changes underneath us. The method is still
// DETECTED here, because the user deserves to know what a button is about to rewrite.
const fs = require('fs');
const path = require('path');
const { run, errorText, pathExists, probePath } = require('./core');
const { CLAUDE_EXE } = require('./paths');
// (no lib/mcp import any more: the registry call for THIS package is the single cached one below, and
// dropping the edge lets lib/mcp ask isCliUpdating() without a require cycle)

const CLI_PKG = '@anthropic-ai/claude-code';
const VERSION_TTL_MS = 5 * 60 * 1000;       // a 218 MB exe spawn per poll is not free
const NPM_TTL_MS = 30 * 60 * 1000;          // the registry answer changes a few times a day at most (B5)
const NPM_TIMEOUT_MS = 25000;
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;   // the updater downloads the whole binary (~200 MB, VPN)
const VERSION_TIMEOUT_MS = 20000;

// ---- the update singleton (B1/FLOW-6) ----
// While `claude update` replaces the binary, NOTHING may start claude.exe: a spawned process locks the
// file the updater is about to rename (Windows), and a chat started mid-rename runs whatever half of
// the binary happens to be on disk. Two clicks on the pill used to start two updaters against the same
// file. One flag, owned here, read by every spawner: startChat (lib/chat), the routes that run
// CLAUDE_EXE (server.js), the scheduler tick (lib/engine, defers), lib/mcp and lib/skills.
// `snapshot` = the version state from before the update, so a poll during the update can still show
// what is installed instead of an empty row.
let UPDATING = null; // { since, snapshot }
function isCliUpdating() { return !!UPDATING; }
function cliUpdatingSince() { return UPDATING ? UPDATING.since : null; }
// The error every spawner throws/answers while the flag is up — one code, one hint, so the client
// can translate it once (code: 'cli-updating', HTTP 503).
function cliUpdatingError() {
  const e = new Error('cli-updating');
  e.statusCode = 503; e.code = 'cli-updating';
  e.hint = 'Claude Code wird gerade aktualisiert — bitte nach dem Update erneut versuchen.';
  return e;
}

// pure: binary path -> install method. Only used for the wording ("was passiert, wenn ich klicke") —
// the update itself always defers to `claude update`.
function detectInstallMethod(exe) {
  const p = String(exe || '').replace(/\\/g, '/').toLowerCase();
  if (!p) return 'unknown';
  if (p.includes('/node_modules/@anthropic-ai/claude-code/')) return 'npm-global';
  if (p.includes('/.claude/local/')) return 'npm-local';
  if (/\/\.local\/(bin|share)\//.test(p) || p.includes('/.claude/versions/')) return 'native';
  return 'unknown';
}
function parseVersion(out) { const m = String(out || '').match(/\d+\.\d+\.\d+/); return m ? m[0] : ''; }
// pure: is `latest` genuinely NEWER than `current`? The old check in /api/sysinfo was `latest !== current`,
// which flags a DOWNGRADE as an available update — running a build the registry doesn't carry (yet) then
// showed a permanent "↑" that no update could ever clear. Unparsable/missing input = no claim.
function isNewer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  if (!a || !b) return false;
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (pa[i] > pb[i]) return true; if (pa[i] < pb[i]) return false; }
  return false;
}

// THE one way to run the claude binary from the server side. Inert test seam, same idea as
// CLAUDE_UI_FAKE_BIN in lib/chat.js: without it this whole chain is untestable (spawning a 218 MB
// binary, then a real registry round trip, then an actual install).
// Unset in normal operation → `run(CLAUDE_EXE, …)`, byte-identical to calling run() directly.
//
// It is EXPORTED because it used to be private, and eleven other call sites therefore spawned
// CLAUDE_EXE themselves (lib/mcp's three `mcp list`/`mcp get`, and server.js's mcp add/remove/
// login/logout, `--version` for the bug report, `doctor`, `auth status` and the `-p` one-shot behind
// /api/enhance). None of them could be driven to their SUCCESS path by a test: under the sandbox they
// fail at spawn, so only the error branch was ever exercised — and run bare, without the sandbox, they
// resolve the machine's real binary, which for /api/enhance means a REAL, PAID model turn started by
// `node --test`. Everything that starts claude goes through here now.
function claudeSpawn(args, opts) {
  const fake = process.env.CLAUDE_UI_FAKE_BIN;
  return fake ? run(process.execPath, [fake].concat(args), opts) : run(CLAUDE_EXE, args, opts);
}
// pure: `npm view <pkg> version dist-tags time.modified --json` → { latest, lastUpdated }. The JSON is
// an object keyed by the requested field names; an older npm that answers a bare string for a single
// field is accepted too. `dist-tags.latest` wins over `version` (they are the same today, but the tag
// is what `claude update` follows).
function parseNpmView(stdout) {
  let j; try { j = JSON.parse(String(stdout || '').trim()); } catch { return { latest: null, lastUpdated: '' }; }
  if (typeof j === 'string') return { latest: parseVersion(j) || null, lastUpdated: '' };
  if (!j || typeof j !== 'object') return { latest: null, lastUpdated: '' };
  const tags = (j['dist-tags'] && typeof j['dist-tags'] === 'object') ? j['dist-tags'] : {};
  const latest = parseVersion(tags.latest) || parseVersion(j.version) || null;
  const mod = j['time.modified'] || (j.time && j.time.modified) || '';
  return { latest, lastUpdated: typeof mod === 'string' ? mod : '' };
}
// ONE `npm view` call for the CLI package (B5) — it used to be two (`version`, then `time.modified`),
// each a cold npm start through cmd.exe (~3–5 s on VPN), and /api/sysinfo ran its own pair next to
// the cached one in cliVersion(). Still npm and not a raw HTTPS GET on purpose: npm carries the
// machine's .npmrc (registry mirror, auth, proxy, CA bundle), which a hand-rolled request would
// silently lose. Cached for NPM_TTL_MS; `pending` shares one in-flight call between everyone who asks
// at the same moment (boot burst: System view + pill + focus event). `force` (the ↻ button) skips the
// cache but still joins a call that is already running.
// Test seams (inert unless set): CLAUDE_UI_FAKE_NPM_LATEST answers without any process at all;
// CLAUDE_UI_FAKE_NPM points at a node script that stands in for `npm`, so a test can count calls.
let npmCache = { ts: 0, data: null, pending: null };
function npmViewOnce() {
  const fake = process.env.CLAUDE_UI_FAKE_NPM;
  const args = ['view', CLI_PKG, 'version', 'dist-tags', 'time.modified', '--json'];
  return fake ? run(process.execPath, [fake].concat(args), { timeout: NPM_TIMEOUT_MS })
    : run('npm', args, { timeout: NPM_TIMEOUT_MS, shell: true });
}
async function latestFromNpm(current, opts) {
  if (process.env.CLAUDE_UI_FAKE_NPM_LATEST) return { latest: process.env.CLAUDE_UI_FAKE_NPM_LATEST, lastUpdated: '' };
  const force = !!(opts && opts.force);
  if (!force && npmCache.data && Date.now() - npmCache.ts < NPM_TTL_MS) return npmCache.data;
  if (npmCache.pending) return npmCache.pending;
  const p = (async () => {
    const r = await npmViewOnce();
    const data = r.err ? { latest: null, lastUpdated: '' } : parseNpmView(r.stdout);
    // a failed call is NOT cached: off-VPN at boot must not mean "registry unreachable" for 30 min
    if (data.latest) npmCache = { ts: Date.now(), data, pending: null };
    return data;
  })();
  npmCache.pending = p;
  try { return await p; } finally { if (npmCache.pending === p) npmCache.pending = null; }
}

// Cached because the sidebar pill polls: `pending` also collapses the boot-time burst (System view +
// pill + a focus event can all ask within a second) into ONE spawn.
// `gen` makes invalidate() stick: a `--version` that was already running when the update started
// would otherwise land in the cache AFTER the invalidate and serve the pre-update number for 5 min.
let cache = { ts: 0, data: null, pending: null };
let cacheGen = 0;
// …and the --help flags (cliHelpFlags below) go with it: the binary they were read from is being replaced.
function invalidate() { cacheGen++; cache = { ts: 0, data: null, pending: null }; helpCache = HELP_EMPTY(); }
async function cliVersion(opts) {
  const force = !!(opts && opts.force);
  // No `--version` spawn while the updater runs (see UPDATING) — the last known state, flagged.
  if (UPDATING) {
    const snap = UPDATING.snapshot || { current: '', latest: null, lastPublished: '', method: detectInstallMethod(CLAUDE_EXE), exe: CLAUDE_EXE, updateAvailable: false, note: '' };
    return Object.assign({}, snap, { updating: true, canUpdate: false, updatingSince: UPDATING.since });
  }
  if (!force && cache.data && Date.now() - cache.ts < VERSION_TTL_MS) return cache.data;
  if (cache.pending) return cache.pending;
  const gen = cacheGen;
  const p = (async () => {
    const ver = await claudeSpawn(['--version'], { timeout: VERSION_TIMEOUT_MS });
    const current = parseVersion(ver.stdout);
    let latest = null, lastPublished = '', note = '';
    // No version = the binary did not run at all (missing / wrong CLAUDE_UI_CLAUDE_BIN). Say which,
    // instead of rendering an empty row that looks like "no update available".
    if (!current) note = (ver.stderr || ver.stdout || 'claude --version failed').slice(0, 200);
    try {
      const ni = await latestFromNpm(current, { force });
      latest = ni.latest;
      lastPublished = ni.lastUpdated;
    } catch (e) { note = note || errorText(e); }
    if (!latest && !note) note = 'npm registry unreachable';
    const method = detectInstallMethod(CLAUDE_EXE);
    const data = {
      current, latest, lastPublished, method, exe: CLAUDE_EXE,
      updateAvailable: isNewer(latest, current),
      canUpdate: !!current, // the binary ran → `claude update` can run too, whatever the method is
      updating: false,
      note,
    };
    if (gen === cacheGen) cache = { ts: Date.now(), data, pending: null };
    return data;
  })();
  cache.pending = p;
  try { return await p; } finally { if (cache.pending === p) cache.pending = null; }
}

// ---- which flags the installed binary knows: its own --help, once per binary (PR-S) ----
// WHY: the panel now passes a flag that older CLIs do not have (`--system-prompt-snapshot`, see
// lib/pure.js promptSnapshotArg), and commander answers an unknown option with „error: unknown option"
// and exit 1 — the chat would not start at all (checked against 2.1.288 with a made-up flag: `claude -p
// --no-such-flag-xyz` → exactly that). A dry run is no probe either: `--version` answers even next to an
// unknown option, so it proves nothing about the flag. A version threshold would be a guess: nothing in this
// repo records which build introduced the flag, only that 2.1.288 lists it. The binary's own --help is
// the proof, and the rule is „no proof, no flag".
// Cached per BINARY, not per time: the key is path + size + mtime of the file claudeSpawn would run, so
// a `claude update` from a terminal (or the CLI's own auto-updater) re-probes on the next start without
// the panel having been told. The spawn (~1.7 s, measured here against 2.1.288) is paid once per binary
// — and at boot (server.js listen), not on the first chat start.
// A FAILED probe (timeout, no option lines in the output) is not cached as an answer: it is remembered
// for HELP_FAIL_TTL_MS so a broken binary does not add a timeout to every start, then asked again.
const PROMPT_SNAPSHOT_FLAG = '--system-prompt-snapshot';
const HELP_TIMEOUT_MS = 15000;
const HELP_FAIL_TTL_MS = 60 * 1000;
function HELP_EMPTY() { return { key: '', flags: null, failedAt: 0, pending: null, pendingKey: '' }; }
let helpCache = HELP_EMPTY();
// pure: --help text → Set of long option names. Only OPTION lines count — at most eight spaces of indent,
// then a dash, and only the signature before the description column — so a flag that is merely
// MENTIONED in another option's description (the snapshot entry itself names `--append-system-prompt`,
// 40 spaces deep) is not mistaken for one the parser accepts. Aliases on one line
// (`--allowedTools, --allowed-tools <tools...>`) are both taken.
function parseHelpFlags(text) {
  const out = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s{1,8}(-\S.*)$/);
    if (!m) continue;
    const sig = m[1].split(/\s{2,}/)[0];
    for (const f of sig.match(/--[A-Za-z][\w-]*/g) || []) out.add(f);
  }
  return out;
}
// ASYNC on purpose (S3, test/sync-fs-paths.test.js): `bin` is CLAUDE_EXE, i.e. possibly the user's
// `claudeBin` from ui-prefs.json — a path that may sit on a share. A `fs.statSync` on an unreachable one
// held the event loop for ~44 s (measured, see lib/core.js pathExists), and this key is asked on EVERY chat
// start, every scheduled run and every GET /api/state. `fs.promises.stat` waits on the threadpool instead,
// so a dead share stalls the one request that asked, not the whole panel. N12: through probePath, so
// that stall is a few seconds and one threadpool thread per dead host, not ~54 s and one thread per ask.
async function helpKey() {
  const bin = process.env.CLAUDE_UI_FAKE_BIN || CLAUDE_EXE; // the file claudeSpawn would actually run
  const r = await probePath(bin);
  return r.state === 'ok' ? bin + '|' + r.stat.size + '|' + Math.round(r.stat.mtimeMs) : bin + '|-';
}
// → Set of flags, or null = „not proven" (probe failed, still failing, or the CLI is being updated).
async function cliHelpFlags() {
  if (UPDATING) return null; // nothing spawns claude.exe while the updater replaces it (B1/FLOW-6)
  const key = await helpKey();
  // …and asked AGAIN after that await: an update that began during the stat must not get a spawn either
  if (UPDATING) return null;
  if (helpCache.key === key) {
    if (helpCache.flags) return helpCache.flags;
    if (Date.now() - helpCache.failedAt < HELP_FAIL_TTL_MS) return null;
  }
  if (helpCache.pending && helpCache.pendingKey === key) return helpCache.pending;
  const gen = cacheGen;
  const p = (async () => {
    const r = await claudeSpawn(['--help'], { timeout: HELP_TIMEOUT_MS });
    const flags = parseHelpFlags(r.stdout);
    const ok = flags.size > 0 && !(r.err && r.err.killed);
    // an update that began meanwhile (invalidate) must not get the old binary's answer stored for the new
    if (gen === cacheGen) helpCache = { key, flags: ok ? flags : null, failedAt: ok ? 0 : Date.now(), pending: null, pendingKey: '' };
    return ok ? flags : null;
  })();
  helpCache.pending = p; helpCache.pendingKey = key;
  try { return await p; } finally { if (helpCache.pending === p) { helpCache.pending = null; helpCache.pendingKey = ''; } }
}
// Does the installed binary accept `flag`? false for „no" AND for „not proven" — the spawn path needs
// exactly one answer, and the safe one is to leave the flag out.
async function cliFlagSupported(flag) {
  const flags = await cliHelpFlags();
  return !!(flags && flags.has(flag));
}
// The same question for a DISPLAY, without spawning anything: true / false, or null when there is no
// answer for the current binary yet (probe still running, or failed). The UI says which, instead of
// rendering „not proven" as „not supported". Async only for helpKey's stat (see there) — it never spawns.
async function cliFlagKnown(flag) {
  const { key, flags } = helpCache; // ONE snapshot: a probe may replace helpCache during the await below
  if (!flags) return null;
  if (key !== await helpKey()) return null;
  return flags.has(flag);
}

// How many claude.exe processes are alive on this machine — the panel's own chats AND the terminal
// sessions it knows nothing about. Windows keeps a running .exe locked against unlink, so an npm-global
// update fired now fails PART-WAY through. null = "couldn't tell" (not win32 / no tasklist), never 0.
async function claudeProcessCount() {
  // test seam: the guard that hangs off this count is the interesting behaviour, and it cannot be
  // exercised deterministically against the machine's real process table.
  // 'unknown' stands in for "tasklist failed" (B5: the null branch is the one that needs a guard).
  if (process.env.CLAUDE_UI_FAKE_PROCS) return process.env.CLAUDE_UI_FAKE_PROCS === 'unknown' ? null : (Number(process.env.CLAUDE_UI_FAKE_PROCS) || 0);
  if (process.platform !== 'win32') return null;
  const r = await run('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/NH'], { timeout: 10000 });
  if (r.err) return null;
  return (String(r.stdout).match(/claude\.exe/gi) || []).length;
}

// The updater renames the running binary to `<name>.old.<ts>` before it writes the new one. When the
// write then fails (VPN drop, AV lock, timeout) the panel is left WITHOUT a claude.exe and every chat
// start answers an opaque ENOENT (B2). Name the leftovers so the user can rename one back instead of
// reinstalling. Full paths, newest first, capped.
// Async (N12): `exe` is CLAUDE_EXE, the configured binary, and its directory may be a share — the sync
// readdir + one statSync per leftover each held the whole server on a dead one. Called only once the
// binary was found missing, i.e. after a lookup of that same directory already answered.
async function listOldBinaries(exe) {
  try {
    const dir = path.dirname(exe), base = path.basename(exe) + '.old.';
    const names = (await fs.promises.readdir(dir)).filter((f) => f.startsWith(base));
    const rows = await Promise.all(names.map(async (f) => {
      const p = path.join(dir, f); let t = 0;
      try { t = (await fs.promises.stat(p)).mtimeMs; } catch { /* */ }
      return { p, t };
    }));
    return rows.sort((a, b) => b.t - a.t).slice(0, 10).map((x) => x.p);
  } catch { return []; }
}

// Runs fn() as THE cli update (B1/FLOW-6). Busy → { ok:false, code:'already-running' } without touching
// anything. The flag goes up SYNCHRONOUSLY (before the first await), so two requests that arrive in the
// same tick cannot both pass the check. invalidate() at the START (FLOW-6: a poll during the update must
// not be served the cached pre-update number — it gets the flagged snapshot instead) and at the end.
async function withCliUpdate(fn) {
  if (UPDATING) return { ok: false, code: 'already-running', error: 'already-running', since: UPDATING.since };
  UPDATING = { since: Date.now(), snapshot: cache.data || null };
  invalidate();
  try { return await fn(); }
  finally { UPDATING = null; invalidate(); }
}

// Runs the updater and reports what actually CHANGED (version before vs after) rather than trusting an
// exit code — `claude update` is a wrapper around several install methods and "success" from one of them
// is not proof the binary on disk moved.
async function runCliUpdate() {
  return withCliUpdate(async () => {
    // CLAUDE_EXE is watched under every seam: with CLAUDE_UI_FAKE_BIN the fake never touches it, so it
    // cannot flip from present to missing unless a test arranges exactly that (fake-claude's
    // 'updatemissing' scenario, which renames a temp CLAUDE_UI_CLAUDE_BIN stand-in).
    const watched = CLAUDE_EXE;
    const existedBefore = !!watched && await pathExists(watched); // N12: the configured binary, maybe on a share
    const before = parseVersion((await claudeSpawn(['--version'], { timeout: VERSION_TIMEOUT_MS })).stdout);
    const r = await claudeSpawn(['update'], { timeout: UPDATE_TIMEOUT_MS });
    const after = parseVersion((await claudeSpawn(['--version'], { timeout: VERSION_TIMEOUT_MS })).stdout);
    const output = ((r.stdout || '') + (r.stderr ? '\n' + r.stderr : '')).trim().slice(0, 800);
    const changed = !!(before && after && before !== after);
    if (r.err && !changed) {
      const timedOut = !!(r.err && r.err.killed);
      const res = {
        ok: false, before, after, output, timedOut,
        error: output || (timedOut ? 'timeout after 10 min — Download abgebrochen' : 'update failed'),
        // EBUSY/EPERM/„being used by another process" = the running-binary lock this is famous for
        locked: /\bEBUSY\b|\bEPERM\b|being used by another process|resource busy|access is denied/i.test(output),
      };
      // The binary was there before and is gone now = the updater moved it away and never put the new
      // one in place (B2). That is a different failure from "locked": nothing will start until fixed.
      if (existedBefore && !(await pathExists(watched))) {
        Object.assign(res, { code: 'cli-missing', missing: true, exe: watched, oldFiles: await listOldBinaries(watched) });
      }
      return res;
    }
    return { ok: true, changed, before, after, output };
  });
}

module.exports = {
  CLI_PKG, VERSION_TTL_MS, NPM_TTL_MS, UPDATE_TIMEOUT_MS,
  detectInstallMethod, parseVersion, isNewer, parseNpmView,
  cliVersion, invalidate, claudeProcessCount, runCliUpdate, latestFromNpm,
  isCliUpdating, cliUpdatingSince, cliUpdatingError, withCliUpdate, listOldBinaries,
  claudeSpawn,
  PROMPT_SNAPSHOT_FLAG, parseHelpFlags, cliHelpFlags, cliFlagSupported, cliFlagKnown,
};
