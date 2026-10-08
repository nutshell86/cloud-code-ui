#!/usr/bin/env node
/*
 * Claude Code Control Panel — local backend
 * Pure Node, zero dependencies. Binds to 127.0.0.1 only.
 *
 * Serves a modern browser UI to:
 *   - chat with Claude Code (drives claude.exe via bidirectional stream-json)
 *   - browse / resume past sessions (~/.claude/projects/**.jsonl)
 *   - view & edit settings.json / settings.local.json (with backups)
 *   - view MCP servers & enabled plugins
 *
 * Nothing leaves this machine: no external calls, localhost bind, own data only.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process'); // /api/restart spawns the detached successor process

// ---------------------------------------------------------------------------
// Paths & config
// ---------------------------------------------------------------------------
// Path & binary constants live in lib/paths.js (structure-only refactor) so lib/* modules can share them.
const {
  HOME, CLAUDE_DIR, SETTINGS, SETTINGS_LOCAL, MANAGED_SETTINGS, CLAUDE_JSON, BACKUP_DIR,
  FAVORITES_FILE, NAMES_FILE, MCP_SEL_FILE, PREFS_FILE, UISKILL_RUNS_FILE, UISKILL_SCHEDULES_FILE,
  SKILL_FAV_FILE, PROMPTS_FILE, CLI_HISTORY_FILE, PROMPT_HISTORY_FILE, SPEND_CACHE_FILE, PUBLIC_DIR, GHE_CREDS, HOST, PORT, CLAUDE_EXE,
  PLANS_DIR, CORRECTIONS_FILE, CLAUDE_BIN_INFO, resolveClaudeBinAsync, REPO_DIR, SERVER_LOG, API_TOKEN_FILE,
} = require('./lib/paths');

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------
// HTTP/IO/settings helpers + JSON stores live in lib/core.js (structure-only refactor).
const {
  sendJson, sendText, errorText, readJsonBody, readJsonFile, readSettingsSnapshot, textHash,
  backupFile, writeSettings, writeJsonAtomic, withFileLock, mapLimit, withDeadline,
  isValidSessionId, projectTranscriptPath, resolveCwdParam, pathExists, pathIsFile, probePath, ensureApiToken, apiTokenEquals,
  readFavorites, writeFavorites, readCustomNames, writeCustomNames, readMcpSel, writeMcpSel,
  readPrefs, writePrefs, readUiRuns, writeUiRuns, readSchedules, writeSchedules,
  readSkillFavs, writeSkillFavs, readPrompts, writePrompts, readPromptHistory, writePromptHistory,
  readCorrections, writeCorrections, readSpendCache, writeSpendCache, defaultCwd,
  maskEnvValue, run, parseFrontmatter, PRICING,
} = require('./lib/core');
const { firstUnreachable } = require('./lib/reach'); // N12: the pre-spawn reachability check (POST /api/chat/start)
const { buildModelMenu, buildBedrockMenu, bedrockBase, applyManagedPricing, effectivePricing, pricingIsManaged, ultracodeModelSupport, modelEffortLevels } = require('./lib/models');
const { bedrockConfig, getBedrockAccess } = require('./lib/bedrock'); // Bedrock: entitlement is an IAM policy, so it is measured
const { scanUsage, csvCell } = require('./lib/usage');
const { scanSessions, searchSessions, readTranscript } = require('./lib/sessions');
// The one fold both of the above project over (lib/corpus.js); the server only ever flushes its cache.
const { flushCache: flushCorpusCache } = require('./lib/corpus');
const {
  getMcpList, configuredServers, configuredTransport, mcpGet, getMcpTools, mcpToolsCache, mcpRowSafe, MCP_PROBE_CONCURRENCY,
  buildMcpConfigFile, enrichMcp, parseMcpTarget,
} = require('./lib/mcp');
const { classifyBackup, listBackups, restoreTarget, previewBackup, DOWNLOAD_ONLY } = require('./lib/backups');
const {
  listMemory, memoryPath, listPlans, planPath, cfgDir, cfgFilePath, listCfgFiles, pluginVersion, pluginSkillPath,
  scanCommands, scanUiSkills, bundledSkillPath,
  getSessionInfoCached,
} = require('./lib/skills');
const {
  chats, startChat, sendToChat, respondPermission, interruptChat,
  setChatMode, setChatEffort, setChatModel, setChatUltracode, getChatSettings, getChatContext, getChatHooks, reloadChatSkills, killChat, terminateChat, PERM_MODES, EFFORT_LEVELS, effortLevelsUpTo,
  endResumeCollisions, getMcpStatus, setMcpEnabled, reconnectMcp, stopTask,
  sessionHold, refuseIfHeld, refuseIfOpenElsewhere,
} = require('./lib/chat');
const { engineRuns, runScheduled, scheduleRunning, activeRunCount, MAX_CONCURRENT_RUNS, abortHeadlessRuns } = require('./lib/engine');
const { computeNextRun, normalizeScheduleTiming, missingRequiredInputs, joinRunCosts, selectCorrections, CORRECTION_CAPS, parseRevListLeftRight, parsePorcelain, parsePorcelainBranch, normalizeSubagentCfg, ultracodeState, buildSpawnPolicy, HEADLESS_PERM_MODES, applySettingsOps, validateSettingsOps, PROMPT_SNAPSHOT_MODES, normalizePromptSnapshot } = require('./lib/pure');
const { agentOutputPathOk, parseAgentOutput } = require('./lib/agent-output'); // #34: a subagent's own transcript
const { parseCliHistory, appendPanelPrompt, mergeHistory } = require('./lib/history'); // A13: prompt history
const { uiResultSanitize } = require('./public/js/ui-result'); // shared browser/Node result channel
// Write counter per session for session-mcp.json, bumped by every write of an entry: a refused start's rollback
// must tell its OWN write from another window's identical one, which a value comparison cannot.
const MCP_SEL_GEN = new Map();
const bumpMcpSelGen = (id) => { const g = (MCP_SEL_GEN.get(id) || 0) + 1; MCP_SEL_GEN.set(id, g); return g; };
const { resultFileRoots, readExpandFile, resolveResultSrc } = require('./lib/result-file'); // `expandSrc`: panel data from a file
const { fetchSpendViaCdp, sanitizeSpend, SPEND_URL, DEBUG_BROWSER_CMD } = require('./lib/spend');
const github = require('./lib/github');
// P-1 — the panel's projects (start profile + label). Its own line on purpose: the import lines above are where
// the parallel branches add names, and a shared line is a merge conflict for nothing.
const projectsLib = require('./lib/projects');
const projectRepos = require('./lib/project-repos'); // P4 „Repos & PRs"
const PROJECTS_BODY_MAX = 64 * 1024; // the three POST /api/projects* routes (500 session ids ≈ 20 KB fit)
// J12 — the start route's own ceiling for --add-dir, the SAME number a project may carry (one rule source)
const START_ADD_DIRS_MAX = require('./public/js/projects-core').PROJECT_CAPS.addDirs;
// `cliMod`, not `cli`: the /api/sysinfo route already has a local `cli` (the version regex match).
const cliMod = require('./lib/cli'); // claude.exe version + `claude update` (System row + sidebar pill)
// …and cliMod.claudeSpawn is how a route STARTS the binary. Never `run(CLAUDE_EXE, …)` directly: that
// bypasses the CLAUDE_UI_FAKE_BIN seam, so the route's success path cannot be tested — and for
// POST /api/enhance (a `claude -p` one-shot) an untested success path means a test run that spends money.
// B1/FLOW-6: every route that runs the binary asks this first. While `claude update` replaces the
// binary a spawn either locks the file the updater is renaming or runs half a binary — so the route
// answers 503 { error/code: 'cli-updating', hint, since } instead (the client translates the code).
// startChat() throws the same error for the paths that do not come through a route.
function refuseWhileCliUpdating(res) {
  if (!cliMod.isCliUpdating()) return false;
  const e = cliMod.cliUpdatingError();
  sendJson(res, 503, { error: e.code, code: e.code, hint: e.hint, since: cliMod.cliUpdatingSince() });
  return true;
}

// Enabled plugins live in settings.json AND in ~/.claude.json, so both are MERGED — not first-wins.
// The MCP view's plugin switch writes settings.json; letting a (possibly empty, still truthy) object
// in .claude.json win turned that switch into a silent no-op: flip it, reload, old state is back.
// .claude.json overrides per key, because that is where the CLI writes when it installs a plugin.
const mergedEnabledPlugins = (settingsFile, claudeJsonFile) => ({
  ...((settingsFile && settingsFile.parsed && settingsFile.parsed.enabledPlugins) || {}),
  ...((claudeJsonFile && claudeJsonFile.parsed && claudeJsonFile.parsed.enabledPlugins) || {}),
});

// The ultracode read-out the browser gets: the CLI's own `applied` block, plus the REASON a requested
// ultracode is not in effect. `ultracodeAvailable` is the AND of „workflows on" and „model does xhigh",
// so deciding which half is missing needs the model half separately.
//
// That half is taken from the mirrored table here (lib/models ultracodeModelSupport with no CLI list),
// deliberately NOT from getSessionInfoCached(): this runs on every chat's `init`, and a cold cache there
// would mean spawning claude.exe on the critical path of every session start. The table is a copy of the
// check inside this binary, and everything the user is TOLD about being on or off still comes straight
// from the CLI — only the wording of the reason uses the table. The on-demand support route below does
// consult the CLI's list, because there a wait is acceptable.
//
// `effort` rides along in the same read-out, because the effort route needs it for exactly the reason the
// chip needs the ultracode half: over stdio an unrecognised `effortLevel` — and '' — is a SILENT no-op
// (the control response still says success, the state is simply not updated), so the only honest source
// for „which level is the session on now" is get_settings. `null` is the CLI's own encoding of „no
// explicit level", i.e. what it DISPLAYS as „auto", and the dropdown needs it to stop lying after a reset.
//
// `applied === null` means the session did not answer (controlRequest resolves „success" on its timeout,
// so every caller here can hand over a null). ultracodeState then answers state 'unknown', and this must
// pass that through UNCHANGED: the previous version let `{}` stand in for „nothing read", which turned a
// timeout into a published `{state:'off', available:true}` — the panel claiming „Ultracode aus" on the
// strength of a session that said nothing at all. `unconfirmed` in the envelope says the same thing a
// second time, deliberately: a client that only reads one of the two still cannot be misled.
function ultracodeStateFor(applied, chat) {
  const model = (applied && applied.model) || (chat && chat.meta && chat.meta.model) || '';
  const sup = ultracodeModelSupport(null, model);
  const st = ultracodeState(applied, sup.source === 'unknown' ? undefined : sup.supported);
  // the model is the one fact that is known even when nothing was read — it comes from the launch, not
  // from the answer, and a message about an unknown state may still name the session it is about
  if (st.state === 'unknown' && !st.model) st.model = model;
  return { ultracode: st, effort: (applied && typeof applied.effort === 'string') ? applied.effort : null };
}

// ---- settings.json / settings.local.json writes (DATA-1, DATA-2) ----
// Two ways in, both serialised on the file's lock so they cannot interleave with each other:
//  · PUT  — the full-text editor saves the WHOLE file. It sends If-Match: the hash of the text it was
//           loaded from. A file that changed since (the CLI granted a rule, a comfort action ran, a
//           second window saved) answers 409 `changed` with the current state instead of being
//           overwritten; the editor then offers to reload. Without If-Match a PUT behaves as before.
//  · PATCH — everything else: { ops: [...] } (lib/pure applySettingsOps), applied to the file as it
//           is on disk at that moment, so two actions in a row (or a rule the CLI wrote in between)
//           both survive.
// A file that exists but does not parse is never replaced blind: PATCH refuses it outright, PUT only
// accepts it with an If-Match for exactly that broken text — the hash of the text the editor showed,
// or the one a 409 `changed` just reported to it. A file that cannot be read at all is refused by
// both: nobody has seen what it holds, so nothing may replace it.
// Both answer with the file's new snapshot ({ exists, raw, parsed, hash }) so the browser's copy is
// the file again, not what it believes it sent.
const settingsIfMatch = (req) => String(req.headers['if-match'] || '').trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
const UNPARSABLE_MSG = 'the file is not valid JSON — repair it in the full-text editor first';
const UNREADABLE_MSG = 'the file cannot be read right now — nothing is written until it can';
const unreadableAnswer = (cur) => [409, { error: UNREADABLE_MSG, code: 'unreadable', readError: cur.error, settings: cur }];
async function putSettings(file, req, res) {
  const body = await readJsonBody(req);
  const parsed = body && body.parsed !== undefined ? body.parsed : body; // a bare `null` body is a 400, not a TypeError
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return sendJson(res, 400, { error: 'Settings must be a JSON object' });
  const ifMatch = settingsIfMatch(req);
  const out = await withFileLock(file, async () => {
    const cur = await readSettingsSnapshot(file);
    if (cur.unreadable) return unreadableAnswer(cur);
    if (ifMatch && ifMatch !== cur.hash) return [409, { error: 'the file has changed since it was loaded', code: 'changed', settings: cur }];
    if (cur.exists && cur.parsed === null && !ifMatch) return [409, { error: UNPARSABLE_MSG, code: 'unparsable', parseError: cur.error, settings: cur }];
    const r = await writeSettings(file, parsed);
    return [200, { ok: true, ...r, settings: await readSettingsSnapshot(file) }];
  });
  return sendJson(res, out[0], out[1]);
}
async function patchSettings(file, req, res) {
  const body = await readJsonBody(req);
  const v = validateSettingsOps(body && body.ops); // a malformed request 400s before it waits for the lock
  if (!v.ok) return sendJson(res, v.status, { error: v.error, code: v.code, op: v.index });
  const out = await withFileLock(file, async () => {
    const cur = await readSettingsSnapshot(file);
    if (cur.unreadable) return unreadableAnswer(cur);
    if (cur.exists && cur.parsed === null) return [409, { error: UNPARSABLE_MSG, code: 'unparsable', parseError: cur.error, settings: cur }];
    const r = applySettingsOps(cur.parsed || {}, body.ops);
    if (!r.ok) return [r.status, { error: r.error, code: r.code, op: r.index, settings: cur }];
    // nothing changed (the rule was already there, the key already gone) → no write, no backup churn
    if (!r.changed) return [200, { ok: true, changed: false, backup: null, settings: cur }];
    const w = await writeSettings(file, r.value);
    return [200, { ok: true, changed: true, ...w, settings: await readSettingsSnapshot(file) }];
  });
  return sendJson(res, out[0], out[1]);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `127.0.0.1:${PORT}`, `localhost:${PORT}`]);
// The panel's OWN origins, exactly — not "anything on localhost". The old /^https?:\/\/(127\.0\.0\.1|
// localhost)(:\d+)?$/ let every local port in: a dev server, a Home-Assistant card or any other page
// served from 127.0.0.1 could POST a `text/plain` body (no preflight) to /api/mcp/add and then have
// /api/mcp/tools spawn it — code execution from a page the user merely had open.
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => 'http://' + h));
const isOwnOrigin = (o) => ALLOWED_ORIGINS.has(String(o || '').toLowerCase());
// GET routes that are an ACTION on a caller-named directory rather than a read of the panel's own
// state, and are therefore held to the same X-CCUI proof as a write (see the guard in the request
// handler). Deliberately a short, named list and not a rule: every other GET must stay reachable from a
// bookmark and from curl.
const GET_NEEDS_CCUI = new Set(['/api/diff', '/api/files']);

// N9 — the API token. Everything above judges a BROWSER: a foreign Host, a foreign Origin, a cross-site
// fetch, a page that cannot add a custom header. None of it touches the caller the alert is actually
// about: another LOCAL USER of this machine, who reaches 127.0.0.1 and whose `curl` sets `X-CCUI: 1` in
// one flag. Only a secret they do not have closes that, so every `/api/` request now has to carry one.
// Three ways in, in this order, and each exists for a named client:
//   · `X-CCUI-Token` header  — the panel's own page (public/js/api-token.js wraps window.fetch), and curl
//   · `?t=` query parameter  — EventSource CANNOT set headers, so the SSE stream has no other way
//   · nothing                — 401 with an ACTIONABLE body (code `token-required`, the file to look in)
// WHAT IS GATED: `/api/*` only. NOT the page, not `/js/*`, not `/styles.css` — a deliberate, smaller
// choice than gating everything, for a reason that is mechanical rather than aesthetic: the page strips
// `?t=` out of the address bar (so it is not on a screenshot or in the tab's back/forward entry — NOT out
// of the browser's own history database, which keeps the first visit with `?t=`: measured, see
// public/js/api-token.js), so a RELOAD arrives without it. Gating the document would therefore break F5
// unless the token also became a cookie, which is a second transport with its own CSRF surface. A foreign
// local user can load the shell: whatever lies under public/, which is markup, scripts, one stylesheet and
// no data — no count here on purpose (one stood here, „24 static files", while public/ held 45); the „no
// data" half is pinned by test/api-token.test.js, which fails on any file under public/ that is not page
// code. Every /api/ call that shell makes is 401.
// `CLAUDE_UI_API_TOKEN` is an honest override (a fixed token for a scripted client, e.g. verify.js's live
// smoke). `CLAUDE_UI_NO_API_TOKEN=1` is the test-only seam, same family as CLAUDE_UI_NO_SCHEDULER: the
// suites that boot a server (verify.js prints how many on every run, „… boot a server") drive their routes
// through their own tiny `req()` helpers, and threading a token through all of them would buy nothing —
// the gate itself is covered by test/api-token.test.js, which boots servers WITHOUT the seam and proves it
// is on by default, and verify.js's live smoke runs with it ON and checks that it is. Inert in production.
const API_TOKEN = process.env.CLAUDE_UI_NO_API_TOKEN === '1'
  ? ''
  : (String(process.env.CLAUDE_UI_API_TOKEN || '').trim() || ensureApiToken(API_TOKEN_FILE));
// The 401 says what to do, in both languages, because the reader is a human in a browser OR a human at a
// shell — and a bare „forbidden" is the failure mode this whole project keeps paying for. `tokenFile` is a
// PATH, not the secret: a foreign local user learns where the file is and still cannot read it (that is
// the directory ACL's job, measured in lib/paths.js), while the legitimate user — who mistyped a URL or
// opened the panel in a second browser profile — gets the one sentence that helps.
function sendTokenRequired(res) {
  return sendJson(res, 401, {
    error: 'api token required — open the panel via start.cmd, or append ?t=<token> to the URL',
    code: 'token-required',
    tokenFile: API_TOKEN_FILE,
    hint: 'Das Token steht in ' + API_TOKEN_FILE + ' — start.cmd öffnet die URL damit.'
      + ' / The token is in that file; start.cmd opens the URL with it.',
  });
}

// The self-update proper (POST /api/version/pull) — moved out of the table unchanged (one indentation
// level less) so the route can wrap it in the selfPulling singleton (B1) with a plain try/finally.
let selfPulling = 0; // ms timestamp of the running pull, 0 = idle
async function selfPull(req, res) {
  if (!github.tokenPresent()) return sendJson(res, 400, { error: 'no-token' });
  // Refuse on a non-main branch instead of fast-forwarding a feature branch onto origin/main:
  // the old version ran the pull regardless, so on a feature branch it either did nothing
  // ("Already up to date") while still reporting success, or moved the wrong branch.
  const curBranch = ((await run('git', ['-C', REPO_DIR, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout || '').trim();
  // A dirty tree blocks the update on EVERY branch, not only when we would switch: `git pull
  // --ff-only` refuses to update a file that carries local changes and aborts with git's own
  // wording ("error: Entry 'CHANGELOG.md' not uptodate. Cannot merge."). This check used to sit
  // INSIDE the switch-to-main case below, so ON MAIN the route ran the pull anyway and the card
  // showed that raw stderr, truncated to 400 characters — the update button read as broken
  // (reported 2026-09-18: „kein update möglich", while the obstacle was three uncommitted files
  // two of which the incoming commit also touched). Name the obstacle and the files instead, so
  // the client can say what to do about it.
  const dirty = parsePorcelain((await run('git', ['-C', REPO_DIR, 'status', '--porcelain'])).stdout)
    .map((f) => f.path);
  // After every merged PR you are sitting on a feature branch, so a bare refusal made the update
  // button permanently useless. The client may ask to do the obvious thing — switch to main first —
  // but only with a CLEAN tree, so an in-progress change can never be silently carried across.
  let switched = null;
  if (curBranch && curBranch !== 'main') {
    const body = await readJsonBody(req).catch(() => ({}));
    if (!(body && body.switchToMain)) return sendJson(res, 409, { error: 'not-on-main', branch: curBranch });
    if (dirty.length) return sendJson(res, 409, { error: 'dirty', branch: curBranch, files: dirty.slice(0, 20), count: dirty.length });
    const co = await run('git', ['-C', REPO_DIR, 'checkout', 'main'], { timeout: 30000 });
    if (co.err) return sendJson(res, 500, { error: (co.stderr || 'checkout failed').slice(0, 400) });
    switched = curBranch;
  } else if (dirty.length) {
    // Separate code from `dirty`: there is no branch switch to decline here, the fix is to commit
    // or stash. A single code would have the client offer advice about the wrong problem.
    return sendJson(res, 409, { error: 'dirty-main', branch: curBranch || 'main', files: dirty.slice(0, 20), count: dirty.length });
  }
  const before = ((await run('git', ['-C', REPO_DIR, 'rev-parse', 'HEAD'])).stdout || '').trim();
  // gitEnvForRemote → gitAuthEnv for our own host: BASIC auth + no credential helper. The previous
  // `Authorization: token …` was the REST scheme, which git's transport rejects, and the resulting
  // 401 handed the call to Git Credential Manager, which cannot prompt here and simply hung until
  // the timeout below.
  //
  // The host check is NOT redundant here even though this is the panel's own repo: the panel runs
  // from whatever clone the user made, and `git remote set-url` is one command away — a mirror on a
  // foreign forge, or plain http:// against our own host, would otherwise have received the PAT
  // just because the pull happens to be a self-update. The pull names `origin main` explicitly, so
  // origin's url IS the url git will contact; a non-GHE origin simply pulls with the neutral env
  // (no token, no credential prompt) and fails with a readable message if it needs auth.
  //
  // REPO_DIR, not __dirname: the update route reads and writes one repo only, and since
  // `CLAUDE_UI_REPO_DIR` became its test seam that repo is no longer always the panel's own
  // directory. The url that decides about the PAT has to come from the repo the pull runs in.
  const selfOriginUrl = ((await run('git', ['-C', REPO_DIR, 'remote', 'get-url', 'origin'])).stdout || '').trim();
  const pull = await run('git', ['-C', REPO_DIR, 'pull', '--ff-only', 'origin', 'main'], {
    timeout: 60000, env: github.gitEnvForRemote(selfOriginUrl),
  });
  // A timeout leaves err set but both streams empty — say so instead of the bare "pull failed"
  // that used to be the only thing a hung credential prompt produced.
  if (pull.err) {
    const detail = (pull.stderr || pull.stdout || '').slice(0, 400);
    return sendJson(res, 500, { error: detail || (pull.err.killed ? 'timeout after 60s — remote unreachable (VPN?)' : 'pull failed'), switched });
  }
  const after = ((await run('git', ['-C', REPO_DIR, 'rev-parse', 'HEAD'])).stdout || '').trim();
  // `changed` lets the client say "already up to date" instead of a green "updated" toast that
  // promised something the pull never did.
  return sendJson(res, 200, { ok: true, changed: !!(before && after && before !== after), switched, output: (pull.stdout || '').slice(0, 400) });
}

// ---------------------------------------------------------------------------
// Routing table
// ---------------------------------------------------------------------------
// One entry per exact route, keyed "<METHOD> <path>". Lifted out of the request handler, which had
// grown to 86 `if (p === … && req.method === …)` branches in one 1400-line function — the place where
// a 500 once hid for weeks (`computeNextRun` used without its require) because nothing could see that
// a branch existed at all. A table can be ENUMERATED: test/routes.test.js compares it against the
// list of routes this panel is supposed to have, so a route that disappears in a refactor breaks a
// test instead of quietly answering 404.
//
// The bodies below were MOVED, not rewritten: same statements, same order, one indentation level
// less. Every handler gets (req, res, url, p) — the four locals the old closure provided (verified:
// no body referenced anything else from it).
// N12 — what the read routes say about the claude binary, from a CACHE. It used to be asked live on every
// GET /api/state and /api/sysinfo: `fs.existsSync(CLAUDE_EXE)` plus a full synchronous resolveClaudeBin(),
// i.e. on a binary configured on a dead share every panel start froze the whole server for ~44 s per lookup.
// Filled asynchronously (lib/reach.js deadlines, so a refresh always settles), at boot before the banner,
// after every POST /api/prefs { claudeBin }, and in the background when a read finds it older than
// BIN_STATE_TTL_MS — a hand-edited ui-prefs.json is therefore seen one poll late, never by a frozen loop.
const BIN_STATE = { exeExists: null, exeReach: null, resolved: null, at: 0 };
const BIN_STATE_TTL_MS = 10000;
let binRefresh = null;
// `force`: start a NEW round even if one is running — after a write, a round that began before it would
// report the old value. It queues behind the running one, so two rounds never write the cache out of order.
function refreshBinState(force) {
  if (binRefresh && !force) return binRefresh;
  const prev = binRefresh;
  const round = (async () => {
    if (prev) await prev.catch(() => {});
    const [exe, resolved] = await Promise.all([probePath(CLAUDE_EXE), resolveClaudeBinAsync()]);
    BIN_STATE.exeReach = exe.state;
    BIN_STATE.exeExists = exe.state === 'ok';
    BIN_STATE.resolved = resolved;
    BIN_STATE.at = Date.now();
  })();
  binRefresh = round;
  round.catch(() => {}).then(() => { if (binRefresh === round) binRefresh = null; });
  return round;
}
// For a read route: the cache as it is, a background refresh when it is stale — and only before the very
// first fill a wait, which is asynchronous like the rest.
async function binState() {
  if (!BIN_STATE.at) await refreshBinState().catch(() => {});
  else if (Date.now() - BIN_STATE.at > BIN_STATE_TTL_MS) refreshBinState().catch(() => {});
  return BIN_STATE;
}
refreshBinState().catch(() => {});
// P3 — the Usage view's „Panel-Projekt" filter (?pproject=p-…|~none|~free): the sessions the cockpit books into that
// bucket, through the SAME rule (lib/projects.js sessionGroupFn — explicit + per folder rule). -> { filter } | { error }
// (malformed → the route's 400). Absent → { filter: null }, and the scan is exactly the unfiltered one.
async function usagePanelFilter(url) {
  const raw = url.searchParams.get('pproject');
  if (raw === null || raw === '') return { filter: null };
  const want = projectsLib.usageGroupKey(raw);
  if (!want) return { error: 'invalid pproject' };
  const groupOf = await projectsLib.sessionGroupFn();
  return { filter: (sid, cwd) => groupOf(sid, cwd) === want };
}
const ROUTES = {
  // cheap liveness probe for the UI connection indicator (polled every few seconds)
  'GET /api/ping': async (req, res, url, p) => {
    let alive = 0; for (const c of chats.values()) if (c.alive) alive++;
    return sendJson(res, 200, { ok: true, ts: Date.now(), uptime: Math.round(process.uptime()), chats: alive });
  },
  'GET /api/state': async (req, res, url, p) => {
    // snapshots carry the text hash the full-text editor sends back as If-Match
    const [s, sl] = await Promise.all([readSettingsSnapshot(SETTINGS), readSettingsSnapshot(SETTINGS_LOCAL)]);
    const cj = await readJsonFile(CLAUDE_JSON);
    const enabledPlugins = mergedEnabledPlugins(s, cj);
    const pluginVersions = {};
    await Promise.all(Object.keys(enabledPlugins).map(async (k) => { pluginVersions[k] = await pluginVersion(k); }));
    return sendJson(res, 200, {
      home: HOME,
      defaultCwd: await defaultCwd(),
      // D1/D2/D4 — the client needs these to fill the settings fields and to seed a new tab's
      // guardrails from the global default
      prefs: await (async () => { const pr = await readPrefs(); return { guardrails: pr.guardrails || '', useCorrections: pr.useCorrections !== false, openPoints: pr.openPoints !== false, claudeBin: pr.claudeBin || '', subagents: normalizeSubagentCfg(pr.subagents), mcpStartupWaitMs: pr.mcpStartupWaitMs || 0, includeHookEvents: pr.includeHookEvents === true, forwardSubagentText: pr.forwardSubagentText !== false, ultracode: pr.ultracode === true, planProgress: pr.planProgress !== false, promptSnapshot: normalizePromptSnapshot(pr.promptSnapshot) }; })(),
      // PR-S — does the installed CLI list --system-prompt-snapshot in its --help? true/false, or null = no
      // answer for this binary yet (probe running or failed). Read from the cache only: this route must not
      // wait 1.7 s for a spawn, and the boot pre-warm (listen, below) has normally answered long before.
      // Awaited for the binary's async stat alone (is the cached answer still THIS file's? — lib/cli helpKey).
      // The Settings card and „Leitplanken jetzt anwenden" need it to say whether a resume really re-renders.
      promptSnapshotFlag: await cliMod.cliFlagKnown(cliMod.PROMPT_SNAPSHOT_FLAG),
      // Which reasoning levels this machine may actually use: `maxEffortLevel` (settings.json, CLI
      // 2.1.267) caps them, and a picker that offers a capped level only fails at the spawn.
      effortLevels: effortLevelsUpTo(s && s.parsed && s.parsed.maxEffortLevel),
      // The permission modes an UNATTENDED run may keep (SEC-H). Anything else is capped to acceptEdits at
      // the headless start, so the schedule dialog has to be able to warn about a manifest that asks for
      // one — and it must warn from the SAME list the cap reads, not from a second copy kept in the
      // browser that would silently stop matching the day the cap changes. public/js cannot require
      // lib/pure, so it travels here next to effortLevels.
      headlessPermModes: HEADLESS_PERM_MODES,
      claudeDir: CLAUDE_DIR,
      // the RUNNING pick (what chats are actually spawned with — the boot toast + chat gating key on it)
      claudeExe: CLAUDE_EXE,
      claudeExeExists: !!(await binState()).exeExists, // N12: from the cache, see BIN_STATE
      // WHICH source found it (env / ui-prefs / PATH / known location / npm prefix) — the boot toast
      // for a miss is otherwise a dead end on a machine that is not this one
      claudeBinSource: CLAUDE_BIN_INFO.source,
      // …and what a start RIGHT NOW would use, so the Settings field can state „gespeichert, wirkt nach
      // Neustart" after a reload too (the source wording stays server-side). Resolved asynchronously into
      // BIN_STATE rather than live here (N12); POST /api/prefs refreshes it before it answers.
      ...((i) => ({ claudeBinResolved: i.path, claudeBinResolvedSource: i.source, claudeBinResolvedExists: !!i.exists, claudeBinRestartNeeded: i.path !== CLAUDE_EXE }))((await binState()).resolved || CLAUDE_BIN_INFO),
      paths: { settings: SETTINGS, settingsLocal: SETTINGS_LOCAL },
      settings: s, settingsLocal: sl, enabledPlugins, pluginVersions,
    });
  },

  'POST /api/prefs': async (req, res, url, p) => {
    const body = await readJsonBody(req);
    // validate BEFORE taking the lock — a bad path must 400 without holding up other writers
    let newCwd; // undefined = leave as is, '' = clear
    if (body.defaultCwd !== undefined) {
      newCwd = String(body.defaultCwd || '').trim();
      // `await pathExists`, not `fs.existsSync` (S3). The judgement is unchanged — something there =
      // accepted, nothing there = 400 naming the path — but the WAIT no longer lands on the one thread
      // that serves every request: measured, the sync form held the event loop for 43 918 ms on a path
      // whose SMB host does not answer, the async form for 93 ms (lib/core.js pathExists). A UNC path is
      // deliberately NOT refused here; see lib/chat.js startChat for why the panel does not judge a
      // network path it cannot cheaply reach.
      if (newCwd && !(await pathExists(newCwd))) return sendJson(res, 400, { error: 'directory not found: ' + newCwd });
    }
    // The claude binary, for the machine where auto-detection misses (lib/paths resolveClaudeBin
    // step 2). Rejected early and specifically — the whole point of the field is to END a
    // "not found" situation, so saving a path that cannot work would just move the confusion.
    let newBin; // undefined = leave as is, '' = back to auto-detection
    if (body.claudeBin !== undefined) {
      newBin = String(body.claudeBin || '').trim().replace(/^"(.*)"$/, '$1'); // pasted from Explorer → quoted
      if (newBin && !path.isAbsolute(newBin)) return sendJson(res, 400, { error: 'not an absolute path: ' + newBin });
      // ONE stat, where this used to ask the filesystem about the same NAME twice (`existsSync` and then
      // `statSync`) — that is the CWE-367 rule behind alert #79, and it is not academic here: between the
      // two lookups the thing at that name can be replaced, so the `isFile()` the route acted on need not
      // describe what the `existsSync()` found. A single stat answers both questions about one object.
      // And it is awaited rather than sync for the reason above — this is the field a user fills in with a
      // path pasted from Explorer, which on a corporate machine is routinely a share.
      // The judgement is unchanged and test/prefs-claudebin.test.js pins it: a DIRECTORY is still refused.
      if (newBin && !(await pathIsFile(newBin))) return sendJson(res, 400, { error: 'file not found: ' + newBin });
    }
    // PR-S — an allow-list, answered with 400 rather than coerced: unlike the booleans next to it this is
    // a choice between two named behaviours, and a value that is neither must not silently become one.
    if (body.promptSnapshot !== undefined && !PROMPT_SNAPSHOT_MODES.includes(body.promptSnapshot)) {
      return sendJson(res, 400, { error: 'invalid promptSnapshot (' + PROMPT_SNAPSHOT_MODES.join('|') + ')' });
    }
    // read-modify-write under the same per-path lock the other stores use: two concurrent POSTs
    // (or a POST racing a future prefs writer) would otherwise drop one side's keys
    await withFileLock(PREFS_FILE, async () => {
      const prefs = await readPrefs();
      if (newCwd !== undefined) { if (newCwd) prefs.defaultCwd = newCwd; else delete prefs.defaultCwd; }
      // D1/D2/D4 — the standing constraints for NEW chats, plus the two switches that decide what
      // else rides along in the appended system prompt. Same read-modify-write lock: they share the
      // file with defaultCwd and must not clobber each other.
      if (body.guardrails !== undefined) { const g = String(body.guardrails || '').trim(); if (g) prefs.guardrails = g.slice(0, 2000); else delete prefs.guardrails; }
      if (body.useCorrections !== undefined) prefs.useCorrections = !!body.useCorrections;
      if (body.openPoints !== undefined) prefs.openPoints = !!body.openPoints;
      // #34 — the global subagent policy. Normalised before it is stored (unknown model, absurd
      // ceiling) so the file can never hold a value that would silently do nothing at spawn time.
      if (body.subagents !== undefined) {
        const sa = normalizeSubagentCfg(body.subagents);
        if (Object.keys(sa).length) prefs.subagents = sa; else delete prefs.subagents;
      }
      // Ultracode as the DEFAULT for new chats (a tab can still override it either way; a headless
      // run never inherits it — lib/pure.js buildSpawnPolicy). Stored only
      // when on, so the file keeps saying nothing about a feature nobody switched on — and `undefined`
      // stays distinguishable from `false` for resolveUltracode.
      if (body.ultracode !== undefined) { if (body.ultracode === true) prefs.ultracode = true; else delete prefs.ultracode; }
      // PR-S — whether a resumed session gets the CURRENT appended prompt (lib/pure.js promptSnapshotArg).
      // 'off' is the default and therefore stored as ABSENT, like ultracode's off: only 'on' is written.
      if (body.promptSnapshot !== undefined) { if (body.promptSnapshot === 'on') prefs.promptSnapshot = 'on'; else delete prefs.promptSnapshot; }
      // Ceiling for the first turn's MCP wait. Clamped rather than trusted: 0 would mean "do not
      // wait at all" (every MCP tool missing on the first turn), and an hour is not a ceiling.
      if (body.includeHookEvents !== undefined) { if (body.includeHookEvents) prefs.includeHookEvents = true; else delete prefs.includeHookEvents; }
      // default ON: a foreground subagent has no other live source, and the extra frames are text
      // the panel routes into the agent view instead of the transcript.
      if (body.forwardSubagentText !== undefined) { if (body.forwardSubagentText === false) prefs.forwardSubagentText = false; else delete prefs.forwardSubagentText; }
      // PF-1 — the plan's progress in the side rail (step list + protocol in the plan approval). Default ON and
      // stored the same way: only an explicit `false` is written, so the file keeps saying nothing about it.
      if (body.planProgress !== undefined) { if (body.planProgress === false) prefs.planProgress = false; else delete prefs.planProgress; }
      if (body.mcpStartupWaitMs !== undefined) {
        const n = Math.floor(Number(body.mcpStartupWaitMs));
        if (Number.isFinite(n) && n >= 1000) prefs.mcpStartupWaitMs = Math.min(n, 600000);
        else delete prefs.mcpStartupWaitMs;
      }
      if (newBin !== undefined) { if (newBin) prefs.claudeBin = newBin; else delete prefs.claudeBin; }
      await writePrefs(prefs);
    });
    const prefsNow = await readPrefs();
    const out = { ok: true, defaultCwd: await defaultCwd(), guardrails: prefsNow.guardrails || '', useCorrections: prefsNow.useCorrections !== false, openPoints: prefsNow.openPoints !== false, subagents: normalizeSubagentCfg(prefsNow.subagents), mcpStartupWaitMs: prefsNow.mcpStartupWaitMs || 0, includeHookEvents: prefsNow.includeHookEvents === true, forwardSubagentText: prefsNow.forwardSubagentText !== false, ultracode: prefsNow.ultracode === true, planProgress: prefsNow.planProgress !== false, promptSnapshot: normalizePromptSnapshot(prefsNow.promptSnapshot) };
    if (newBin !== undefined) {
      // Re-resolve NOW so the answer states what the next start will actually use — after clearing
      // the field that is auto-detection's own pick, which is the only honest thing to show. A forced
      // BIN_STATE round (N12): asynchronous, and GET /api/state reads this same answer afterwards.
      await refreshBinState(true);
      const info = BIN_STATE.resolved || CLAUDE_BIN_INFO;
      out.claudeBin = prefsNow.claudeBin || '';
      out.claudeBinResolved = info.path;
      out.claudeBinSource = info.source;
      out.claudeBinExists = !!info.exists;
      out.restartNeeded = info.path !== CLAUDE_EXE; // the running process holds the old path as a constant
      // `--version` is the only real proof the path is a Claude binary. Existence alone is what made
      // the old miss so hard to debug, so the field reports what the binary actually answers.
      // (skipped while `claude update` runs — the field then simply stays absent, see refuseWhileCliUpdating)
      if (info.exists && !cliMod.isCliUpdating()) {
        const r = await run(info.path, ['--version'], { timeout: 20000 });
        const m = String(r.stdout || '').match(/\d+\.\d+\.\d+/);
        out.claudeBinVersion = m ? m[0] : '';
        if (!m) out.claudeBinError = String((r.stderr || '') || errorText(r.err) || 'no version output').slice(0, 200);
      }
    }
    return sendJson(res, 200, out);
  },

  // The full-text editor's save: the whole file, as the user typed it (DATA-1/DATA-2). See putSettings.
  'PUT /api/config/settings': async (req, res, url, p) => {
    return putSettings(SETTINGS, req, res);
  },
  'PUT /api/config/settings-local': async (req, res, url, p) => {
    return putSettings(SETTINGS_LOCAL, req, res);
  },
  // Every other settings change in the panel: named operations, merged into the file as it is NOW.
  'PATCH /api/config/settings': async (req, res, url, p) => {
    return patchSettings(SETTINGS, req, res);
  },
  'PATCH /api/config/settings-local': async (req, res, url, p) => {
    return patchSettings(SETTINGS_LOCAL, req, res);
  },

  'GET /api/mcp': async (req, res, url, p) => {
    const r = await getMcpList();
    if (url.searchParams.get('updates') === '1') {
      // The health list can come back empty (CLI cold/slow/timed out — see MCP_LIST_TIMEOUT_MS).
      // "Updates prüfen" must not turn that into "0 servers, all up to date": fall back to the
      // configured set, flag the health as unknown, and check versions anyway.
      let base = r.servers || [];
      if (!base.length) { base = (await configuredServers()).map((s) => ({ ...s, healthUnknown: true })); r.healthUnavailable = true; }
      if (base.length) r.servers = await enrichMcp(base);
    }
    // SEC-3: `transport` is the last place in the MCP view that still carried a raw argv/URL to the
    // browser. Masked HERE and not in getMcpList/enrichMcp, because the same string is what
    // parseMcpTarget classifies — see lib/mcp.js mcpRowSafe.
    if (Array.isArray(r.servers)) r.servers = r.servers.map(mcpRowSafe);
    return sendJson(res, 200, r);
  },
  // Fast, HEALTH-FREE server list straight from ~/.claude.json (no `claude mcp list` connect check),
  // so the MCP view can paint tiles instantly; health (ok/status) is filled in afterward via /api/mcp.
  // Returns only { name, transport } — env/headers stay server-side (never leak secrets to the client).
  'GET /api/mcp/configured': async (req, res, url, p) => {
    return sendJson(res, 200, { servers: (await configuredServers()).map(mcpRowSafe) });
  },
  // Check ONE server for updates + "last updated" (ToDo 06): classify the transport, probe the
  // running version where a comparison needs it, then enrich (git behind / npm / PyPI / local mtime).
  'GET /api/mcp/check': async (req, res, url, p) => {
    const name = url.searchParams.get('name') || '';
    if (!/^[\w.-]+$/.test(name)) return sendJson(res, 400, { error: 'bad name' });
    // The transport comes from the config, NOT from `claude mcp list` — that health call alone needs
    // ~4s per configured server, so it used to eat the whole budget below and every check answered
    // "check timeout". What is left is bounded: probe (≤20s, only where it buys something) plus
    // `npm view`/`git fetch` (≤30s). One deadline for the lot; on expiry the tile gets an honest
    // "check timeout" instead of a spinner that never ends (work is abandoned, not cancelled).
    const MCP_CHECK_DEADLINE_MS = 60000;
    const info = await withDeadline((async () => {
      const transport = await configuredTransport(name);
      // Only npm/PyPI compare "installed vs latest", and only they need the server's own version
      // (serverInfo from a probe). git reads the repo, http/local have nothing to compare — skipping
      // the spawn there keeps those checks at a click's worth of waiting.
      const kind = parseMcpTarget(transport).kind;
      if (kind === 'npm' || kind === 'pypi') { try { await getMcpTools(name); } catch { /* best effort */ } }
      const [one] = await enrichMcp([{ name, transport }]);
      return one;
    })(), MCP_CHECK_DEADLINE_MS, () => ({ name, transport: '', timedOut: true, update: { kind: 'unknown', updateAvailable: false, status: 'check timeout', lastUpdated: '' } }));
    return sendJson(res, 200, mcpRowSafe(info)); // SEC-3: `transport` masked on the way out, as above
  },
  'POST /api/mcp/add': async (req, res, url, p) => {
    const b = await readJsonBody(req);
    if (!b.name || !/^[\w.-]+$/.test(b.name)) return sendJson(res, 400, { error: 'invalid server name (letters, digits, . _ - only)' });
    const scope = ['local', 'user', 'project'].includes(b.scope) ? b.scope : 'user';
    let args;
    if (b.transport === 'http' || b.transport === 'sse') {
      if (!b.url || !/^https?:\/\//i.test(b.url)) return sendJson(res, 400, { error: 'valid http(s) URL required' });
      args = ['mcp', 'add', '-t', b.transport, b.name, b.url, '-s', scope];
      (b.headers || []).forEach((h) => { const v = String(h).trim(); if (v) { args.push('-H', v); } });
    } else {
      if (!b.command) return sendJson(res, 400, { error: 'command required' });
      args = ['mcp', 'add', b.name, '-s', scope];
      (b.env || []).forEach((e) => { const v = String(e).trim(); if (v) { args.push('-e', v); } });
      args.push('--', String(b.command).trim(), ...(b.args || []).map((a) => String(a)).filter((a) => a !== ''));
    }
    if (refuseWhileCliUpdating(res)) return;
    const r = await cliMod.claudeSpawn(args, { timeout: 30000 });
    if (r.err) return sendJson(res, 500, { error: (r.stderr || r.stdout || 'add failed').slice(0, 500) });
    return sendJson(res, 200, { ok: true, output: (r.stdout || '').slice(0, 400) });
  },
  'POST /api/mcp/remove': async (req, res, url, p) => {
    const b = await readJsonBody(req);
    if (!b.name || !/^[\w.-]+$/.test(b.name)) return sendJson(res, 400, { error: 'invalid name' });
    if (refuseWhileCliUpdating(res)) return;
    const r = await cliMod.claudeSpawn(['mcp', 'remove', b.name], { timeout: 20000 });
    if (r.err) return sendJson(res, 500, { error: (r.stderr || r.stdout || 'remove failed').slice(0, 400) });
    return sendJson(res, 200, { ok: true, output: (r.stdout || '').slice(0, 400) });
  },
  'GET /api/mcp/get': async (req, res, url, p) => {
    const name = url.searchParams.get('name') || '';
    if (!/^[\w.-]+$/.test(name)) return sendJson(res, 400, { error: 'bad name' });
    return sendJson(res, 200, await mcpGet(name));
  },
  'GET /api/mcp/tools': async (req, res, url, p) => {
    const one = url.searchParams.get('name') || '';
    if (one && !/^[\w.-]+$/.test(one)) return sendJson(res, 400, { error: 'bad name' });
    if (url.searchParams.get('force') === '1') { if (one) mcpToolsCache.delete(one); else mcpToolsCache.clear(); }
    // Names from the config, not from the health list: probing needs no health, and a slow/failed
    // `claude mcp list` used to silently reduce the bulk probe to zero servers.
    const names = one ? [one] : (await configuredServers()).map((s) => s.name);
    // Object.create(null), because the SERVER NAME is the property name below and `?name=__proto__`
    // passes the shape check above (`\w` covers `_` — found while writing the SEC-5 test, which assumed
    // the opposite). On a plain `{}` that assignment sets the PROTOTYPE, so the answer would be an empty
    // `tools` object and the card would say „keine Tools" for a probe that ran. A null-prototype object
    // takes it as an ordinary own property, and JSON.stringify treats it like any other object.
    const tools = Object.create(null);
    // Without ?name this route SPAWNS every configured stdio server AT ONCE (20+ node/python
    // processes, each up to 20s) — one click could stall the machine.
    // PERF-1: the SERVER-spawn bound is no longer this route's. lib/mcp owns it now, so it holds for
    // every caller instead of only for this one (`GET /api/mcp/check` probes too — line 452 — and had
    // no bound at all, and two clicks on the same card spawned the server twice). It takes the number
    // from lib/mcp so there is one place that decides it.
    //   What this mapLimit still bounds, PRECISELY: the step before that spawn. For a server in
    // ~/.claude.json that is one file read — but for a project `.mcp.json` server it is NOT:
    // mcpRawConfig falls back to `claude mcp get <name>`, a spawn with a 25 s timeout, and THAT one is
    // outside lib/mcp's gate (the gate sits around queryMcpToolsStdio). So this bound is still load-
    // bearing here, and `GET /api/mcp/check` is unbounded for it — one name per request, which is why
    // it costs nothing today. Said rather than implied: the gate covers the MCP servers, not every
    // CLI spawn on the way to them.
    await mapLimit(names, MCP_PROBE_CONCURRENCY, async (n) => { tools[n] = await getMcpTools(n); });
    return sendJson(res, 200, { tools, ts: Date.now() });
  },
  'GET /api/mcp/inventory': async (req, res, url, p) => {
    // The configured set is the authoritative "which servers exist", and `mcp get` per server
    // already reports status/scope/type — so the health list would only add its own ~4 s per
    // server on top (measured: 68 s for this download, of which 37 s were `claude mcp list`).
    const servers = await configuredServers();
    // …and `mcp get` connects too, so ONE slow server (a uvx package that re-resolves on start)
    // otherwise decides how long the whole download takes. Per-server deadline: that server's
    // section reports what the config knows and says the status wasn't checked.
    const details = await Promise.all(servers.map((s) => withDeadline(mcpGet(s.name), 12000, { detail: { status: 'nicht geprüft (Zeitüberschreitung)' }, timedOut: true })));
    let md = '# MCP-Server-Inventar\n\n_' + new Date().toLocaleString() + ' · ' + servers.length + ' Server_\n\n';
    servers.forEach((s, i) => {
      const d = details[i].detail;
      md += '## ' + s.name + '\n\n';
      // SEC-3: `d.*` is already masked by parseMcpGet — but `s.transport` is the RAW config string, and
      // it is reached exactly when `mcp get` did not answer (the 12 s deadline above, a CLI error): the
      // one branch of this download that nobody looks at while it works. So the fallback is masked too.
      md += '- **Status:** ' + (d.status || s.status || '—') + '\n- **Scope:** ' + (d.scope || '—') + '\n- **Typ:** ' + (d.type || mcpRowSafe(s).transport || '—') + '\n';
      if (d.command) md += '- **Command:** `' + d.command + (d.args ? ' ' + d.args : '') + '`\n';
      if (d.url) md += '- **URL:** ' + d.url + '\n';
      const envKeys = Object.keys(d.env || {});
      if (envKeys.length) { md += '- **Environment:**\n'; envKeys.forEach((k) => { md += '  - `' + k + '=' + d.env[k] + '`\n'; }); }
      md += '\n';
    });
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="mcp-inventory.md"', 'Cache-Control': 'no-store' });
    return res.end(md);
  },
  'POST /api/mcp/login': async (req, res, url, p) => {
    const b = await readJsonBody(req);
    if (!/^[\w.-]+$/.test(b.name || '')) return sendJson(res, 400, { error: 'bad name' });
    // OAuth login is interactive (opens a browser / prints a URL). Run with a timeout
    // and return whatever it emitted; may need to be completed in a browser.
    if (refuseWhileCliUpdating(res)) return;
    const r = await cliMod.claudeSpawn(['mcp', 'login', b.name], { timeout: 25000 });
    return sendJson(res, 200, { ok: !r.err, output: ((r.stdout || '') + (r.stderr ? '\n' + r.stderr : '')).slice(0, 1500), timedOut: !!(r.err && (r.err.killed || /timed out|ETIMEDOUT/i.test(String(r.err.message || '')))) });
  },
  'POST /api/mcp/logout': async (req, res, url, p) => {
    const b = await readJsonBody(req);
    if (!/^[\w.-]+$/.test(b.name || '')) return sendJson(res, 400, { error: 'bad name' });
    if (refuseWhileCliUpdating(res)) return;
    const r = await cliMod.claudeSpawn(['mcp', 'logout', b.name], { timeout: 20000 });
    if (r.err) return sendJson(res, 500, { error: (r.stderr || r.stdout || 'logout failed').slice(0, 400) });
    return sendJson(res, 200, { ok: true, output: (r.stdout || '').slice(0, 400) });
  },
  'POST /api/mcp/update': async (req, res, url, p) => {
    const body = await readJsonBody(req);
    if (!/^[\w.-]+$/.test(body.name || '')) return sendJson(res, 400, { error: 'bad name' });
    // Resolved from the config: a `claude mcp list` that came back slow or empty made this answer
    // "server not found" for servers that plainly exist, i.e. the Update button stopped working.
    const transport = await configuredTransport(body.name);
    if (!transport) return sendJson(res, 404, { error: 'server not found' });
    const tgt = parseMcpTarget(transport);
    if (tgt.kind !== 'git') return sendJson(res, 400, { error: 'not git-managed (' + tgt.kind + ')' });
    // Never open a credential window, and send our PAT only to our own host over https (see
    // gitEnvForRemote). gitFetchTarget resolves the remote this pull will really contact — a bare
    // `git pull` follows branch.<current>.remote, which need not be `origin`, so the url that decided
    // the token and the host that receives it were not necessarily the same one — and names that
    // remote in the argv so the pull cannot follow a different one.
    const tgtRemote = await github.gitFetchTarget(tgt.repoDir, run);
    const pull = await run('git', ['-C', tgt.repoDir, 'pull', '--ff-only', ...tgtRemote.args], { timeout: 60000, env: tgtRemote.env });
    if (pull.err) return sendJson(res, 500, { error: (pull.stderr || pull.stdout || 'pull failed').slice(0, 400) });
    return sendJson(res, 200, { ok: true, output: (pull.stdout || '').slice(0, 400) });
  },

  'GET /api/sessions': async (req, res, url, p) => {
    // P-1: every item carries `projectId` ('p-…' | '' deliberately none | null never decided) — the stored
    // assignment only, nothing derived (lib/projects.js decorateSessions)
    return sendJson(res, 200, { sessions: await projectsLib.decorateSessions(await scanSessions()) });
  },
  // { hits, indexedFiles, skippedFiles, truncatedFiles } — the coverage fields are additive, the
  // client keeps reading `hits` (see public/js/commands.js).
  'GET /api/search': async (req, res, url, p) => {
    const r = await searchSessions(url.searchParams.get('q') || '', Number(url.searchParams.get('limit')) || 60);
    return sendJson(res, 200, r);
  },
  // (no GET /api/favorites: the favourite flag reaches the UI on every session object from
  // GET /api/sessions — lib/sessions.js folds it in — so a separate id list had no caller.)
  'POST /api/favorites/toggle': async (req, res, url, p) => {
    const b = await readJsonBody(req);
    if (!b.id) return sendJson(res, 400, { error: 'id required' });
    const favorite = await withFileLock(FAVORITES_FILE, async () => {
      const favs = await readFavorites();
      const i = favs.indexOf(b.id);
      if (i >= 0) favs.splice(i, 1); else favs.push(b.id);
      await writeFavorites(favs);
      return favs.includes(b.id);
    });
    return sendJson(res, 200, { favorite });
  },
  'POST /api/session/rename': async (req, res, url, p) => {
    const b = await readJsonBody(req);
    if (!b.id) return sendJson(res, 400, { error: 'id required' });
    // The id is the PROPERTY NAME written into session-names.json — validate it against the session-id
    // shape (see isValidSessionId) before it can name anything else, e.g. `__proto__`/`constructor`.
    const sid = isValidSessionId(b.id) ? b.id : null;
    if (!sid) return sendJson(res, 400, { error: 'invalid session id' });
    const name = (b.name || '').trim();
    const finalName = await withFileLock(NAMES_FILE, async () => {
      const store = await readCustomNames();
      if (name) store[sid] = name.slice(0, 120); else delete store[sid];
      await writeCustomNames(store);
      return store[sid] || null;
    });
    return sendJson(res, 200, { ok: true, name: finalName });
  },
  'POST /api/session/delete': async (req, res, url, p) => {
    const b = await readJsonBody(req);
    // The id is a PROPERTY NAME below — it is deleted from favorites, session-names.json and (P-0)
    // session-mcp.json — so it is held to the session-id shape first, exactly like the rename route above,
    // before it can name anything else (`__proto__`, `constructor`). Every transcript the panel lists is
    // `<uuid>.jsonl`, so no real session is refused. CodeQL flagged the new session-mcp line for this
    // (js/remote-property-injection, high, PR #93); the hasOwnProperty guards stay as the second fence.
    const id = isValidSessionId(b.id) ? b.id : null;
    if (!id) return sendJson(res, 400, { error: 'invalid session id' });
    const project = b.project;
    // Same rule as /api/transcript (projectTranscriptPath in lib/core.js). This route MOVES the
    // file, so it must not be the weaker of the two: `project` was not held to the separator rule
    // that `id` was, and the containment check derived its bound from `project` itself.
    const src = projectTranscriptPath(project, id);
    if (!src) return sendJson(res, 400, { error: 'bad params' });
    try {
      await fsp.mkdir(BACKUP_DIR, { recursive: true });
      const dest = path.join(BACKUP_DIR, 'deleted-' + id + '-' + Date.now() + '.jsonl');
      await fsp.rename(src, dest);
      // under the same locks the toggle/rename routes use — a concurrent toggle must not
      // read-modify-write in parallel and silently reinstate the deleted session's entry
      await withFileLock(FAVORITES_FILE, async () => { const favs = await readFavorites(); const fi = favs.indexOf(id); if (fi >= 0) { favs.splice(fi, 1); await writeFavorites(favs); } });
      // hasOwnProperty, not `nm[id]`: for an id like "constructor" the plain read hits the inherited
      // Object.prototype member and rewrites the whole store for a name that was never in it.
      await withFileLock(NAMES_FILE, async () => { const nm = await readCustomNames(); if (Object.prototype.hasOwnProperty.call(nm, id)) { delete nm[id]; await writeCustomNames(nm); } });
      // P-0 — …and its MCP scope, by the same rule. The only other removal is a start that explicitly asks for
      // „all servers" (null, in /api/chat/start) — and a deleted session never starts again, so session-mcp.json
      // kept an entry for every deleted session that ever had a selection.
      await withFileLock(MCP_SEL_FILE, async () => { const st = await readMcpSel(); if (Object.prototype.hasOwnProperty.call(st, id)) { delete st[id]; bumpMcpSelGen(id); await writeMcpSel(st); } });
      // P-1 — …and its project label (session-projects.json). A broken map is left alone and logged by
      // forgetSession rather than failing a delete whose transcript has already been moved.
      await projectsLib.forgetSession(id);
      return sendJson(res, 200, { ok: true, backup: dest });
    } catch (e) { return sendJson(res, 404, { error: errorText(e) }); }
  },
  'GET /api/transcript': async (req, res, url, p) => {
    const project = url.searchParams.get('project');
    const id = url.searchParams.get('id');
    if (!project || !id) return sendJson(res, 400, { error: 'project and id required' });
    // Guard against traversal: reject the traversal characters, THEN prove the composed path really
    // is inside PROJECTS_DIR. Both steps live in projectTranscriptPath (lib/core.js) so this route
    // and /api/session/delete cannot drift apart again.
    if (!projectTranscriptPath(project, id)) {
      return sendJson(res, 400, { error: 'bad params' });
    }
    const tail = parseInt(url.searchParams.get('tail') || '0', 10) || 0;
    try {
      return sendJson(res, 200, await readTranscript(project, id, { tail: tail > 0 ? tail : 0 }));
    } catch (e) {
      // A transcript that is simply GONE (session file deleted, project dir renamed) is an expected
      // state — a restored chat tab hits it on every reload. It gets its own code so the client can
      // say "existiert nicht mehr" instead of turning a raw ENOENT + full path into a sticky error.
      const missing = e && (e.code === 'ENOENT' || /ENOENT|no such file/i.test(errorText(e)));
      return sendJson(res, 404, { error: missing ? 'transcript-missing' : errorText(e), missing: !!missing });
    }
  },

  'GET /api/usage': async (req, res, url, p) => {
    const from = url.searchParams.get('from') || null;
    const to = url.searchParams.get('to') || null;
    const project = url.searchParams.get('project') || null;
    const model = url.searchParams.get('model') || null;
    const pf = await usagePanelFilter(url);
    if (pf.error) return sendJson(res, 400, { error: pf.error });
    return sendJson(res, 200, await scanUsage(from, to, undefined, { project, model, sessionFilter: pf.filter || undefined }));
  },
  'GET /api/usage.csv': async (req, res, url, p) => {
    const from = url.searchParams.get('from') || null, to = url.searchParams.get('to') || null;
    const pf = await usagePanelFilter(url);
    if (pf.error) return sendJson(res, 400, { error: pf.error });
    const j = await scanUsage(from, to, 0, { project: url.searchParams.get('project') || null, model: url.searchParams.get('model') || null, sessionFilter: pf.filter || undefined });
    const rows = [['title', 'project', 'session_id', 'model', 'model_calls', 'total_tokens', 'input', 'output', 'cache_read', 'cache_write', 'cost_usd', 'last_active']];
    for (const s of j.bySession) rows.push([s.title || '', s.projectPath, s.id, s.model || '', s.messages, s.tokens, s.input, s.output, s.cacheRead, s.cacheWrite, (s.cost || 0).toFixed(6), new Date(s.mtime).toISOString()]);
    const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="claude-usage' + (from ? '-' + from : '') + '.csv"', 'Cache-Control': 'no-store' });
    return res.end(csv);
  },

  // ---- Memory ----
  'GET /api/memory': async (req, res, url, p) => {
    return sendJson(res, 200, { groups: await listMemory() });
  },
  'GET /api/memory/file': async (req, res, url, p) => {
    const file = memoryPath(url.searchParams.get('project'), url.searchParams.get('name'));
    if (!file) return sendJson(res, 400, { error: 'bad params' });
    try { return sendJson(res, 200, { content: await fsp.readFile(file, 'utf8') }); }
    catch (e) { return sendJson(res, 404, { error: errorText(e) }); }
  },
  'PUT /api/memory/file': async (req, res, url, p) => {
    const body = await readJsonBody(req);
    const file = memoryPath(body.project, body.name);
    if (!file) return sendJson(res, 400, { error: 'bad params' });
    if (typeof body.content !== 'string') return sendJson(res, 400, { error: 'content required' });
    // DATA-3 — `create: true` means „this is a NEW memory", and on this filesystem that is a claim only
    // the directory can confirm. NTFS compares names case-INSENSITIVELY: writing `Mein-Fakt.md` next to
    // an existing `mein-fakt.md` does not create a second file, it overwrites the first one, and
    // `fs.existsSync(file)` would answer the same for both spellings anyway.
    // Server-side and not in the browser: the panel's file list is a snapshot that is minutes old (the
    // CLI writes memory files itself, and a second window may have just added one), and this route is
    // reachable without the browser at all. The directory read HERE is the only answer that is current.
    if (body.create === true) {
      let siblings = [];
      try { siblings = await fsp.readdir(path.dirname(file)); } catch { /* no memory/ dir yet → nothing to collide with */ }
      const want = path.basename(file).toLowerCase();
      const clash = siblings.find((f) => f.toLowerCase() === want);
      if (clash) return sendJson(res, 409, { error: 'memory "' + clash + '" existiert bereits', code: 'exists', existing: clash });
    }
    await fsp.mkdir(path.dirname(file), { recursive: true }); // create memory/ dir for a new file
    // No existsSync ahead of the copy: backupFile() answers a missing source with null itself, so
    // "there was nothing to back up" (= a NEW file) comes from the copy attempt instead of from a
    // separate look at the path that can already be stale by the time the write below runs.
    const backup = await backupFile(file);
    await fsp.writeFile(file, body.content, 'utf8');
    return sendJson(res, 200, { ok: true, backup, created: !backup });
  },
  'POST /api/memory/file/delete': async (req, res, url, p) => {
    const body = await readJsonBody(req);
    const file = memoryPath(body.project, body.name);
    if (!file) return sendJson(res, 400, { error: 'bad params' });
    if (body.name === 'MEMORY.md') return sendJson(res, 400, { error: 'MEMORY.md ist der Index — nicht löschbar' });
    try {
      await fsp.mkdir(BACKUP_DIR, { recursive: true });
      await fsp.rename(file, path.join(BACKUP_DIR, 'deleted-memory-' + path.basename(file) + '.' + Date.now() + '.bak'));
      return sendJson(res, 200, { ok: true });
    } catch (e) { return sendJson(res, 404, { error: errorText(e) }); }
  },

  // ---- Config file collections (agents, output-styles) ----
  'GET /api/cfgfiles': async (req, res, url, p) => {
    const files = await listCfgFiles(url.searchParams.get('kind'));
    if (files === null) return sendJson(res, 400, { error: 'bad kind' });
    return sendJson(res, 200, { files });
  },
  // ---- Corrections (D4) ----
  // The corrections the user gives ("nicht so, sondern so") are the highest-value signal in the
  // whole tool and the one that evaporated most reliably: they worked inside a session and were gone
  // in the next one. Stored here, injected into new sessions by composeAppendSystem — under a cap, and
  // GET reports which entries are past that cap so the UI can mark them as no longer active instead
  // of letting a stale rule look live forever.
  'GET /api/corrections': async (req, res, url, p) => {
    const list = await readCorrections();
    const sel = selectCorrections(list);
    return sendJson(res, 200, { corrections: list, injected: sel.used.length, dropped: sel.dropped, caps: CORRECTION_CAPS });
  },
  'POST /api/corrections': async (req, res, url, p) => {
    const b = await readJsonBody(req);
    const text = String((b && b.text) || '').trim();
    if (!text) return sendJson(res, 400, { error: 'text required' });
    const entry = {
      id: crypto.randomUUID(),
      text: text.slice(0, 600), // stored fuller than it is injected (CORRECTION_CAPS.chars) so nothing is lost here
      at: Date.now(),
      origin: String((b && b.origin) || '').slice(0, 120), // tab title / view it came from
    };
    await withFileLock(CORRECTIONS_FILE, async () => { const list = await readCorrections(); list.push(entry); await writeCorrections(list); });
    return sendJson(res, 200, { ok: true, correction: entry });
  },
  'DELETE /api/corrections': async (req, res, url, p) => {
    const id = (url.searchParams.get('id') || '').trim();
    if (!id) return sendJson(res, 400, { error: 'id required' });
    const removed = await withFileLock(CORRECTIONS_FILE, async () => {
      const list = await readCorrections();
      const next = list.filter((c) => c.id !== id);
      await writeCorrections(next);
      return list.length - next.length;
    });
    return sendJson(res, removed ? 200 : 404, { ok: !!removed, removed });
  },

  // ---- Plans (A7): ~/.claude/plans/*.md — the output of plan mode, invisible to the panel until now ----
  'GET /api/plans': async (req, res, url, p) => {
    return sendJson(res, 200, { plans: await listPlans(), dir: PLANS_DIR });
  },
  'GET /api/plan': async (req, res, url, p) => {
    const file = planPath(url.searchParams.get('name'));
    if (!file) return sendJson(res, 400, { error: 'bad params' });
    try { return sendJson(res, 200, { content: await fsp.readFile(file, 'utf8') }); }
    catch (e) { return sendJson(res, 404, { error: errorText(e) }); }
  },
  'DELETE /api/plan': async (req, res, url, p) => {
    const file = planPath(url.searchParams.get('name'));
    if (!file) return sendJson(res, 400, { error: 'bad params' });
    try { await fsp.unlink(file); return sendJson(res, 200, { ok: true }); }
    catch (e) { return sendJson(res, 404, { error: errorText(e) }); }
  },
  // BUILDER-1 — `hash` is the version a caller sends back as If-Match (PUT below), and `code: 'missing'` tells
  // „the file is gone" apart from „it could not be read": both used to be the same bare 404 with an OS message,
  // and only the first one may be said as „deleted".
  'GET /api/cfgfile': async (req, res, url, p) => {
    const file = cfgFilePath(url.searchParams.get('kind'), url.searchParams.get('name'));
    if (!file) return sendJson(res, 400, { error: 'bad params' });
    try { const content = await fsp.readFile(file, 'utf8'); return sendJson(res, 200, { content, hash: textHash(content) }); }
    catch (e) { return sendJson(res, 404, { error: errorText(e), code: e.code === 'ENOENT' ? 'missing' : undefined }); }
  },
  // BUILDER-1 — the UI-skill builder keeps a draft across tab, view and language switches now, and a draft that
  // is kept longer can be older than the file: the CLI, an editor or a second window may have written the skill in
  // between, and a blind PUT overwrote that without a word. Same contract as the settings editor (putSettings):
  //  · If-Match: the hash of the text the caller loaded. Changed since → 409 `changed` with the file's current
  //    { exists: true, hash }; deleted since → the same 409 with exists:false. Nothing is written either way.
  //  · create: true — „this is a NEW file": 409 `exists` when the name is taken, compared case-INSENSITIVELY
  //    (NTFS — the rule of PUT /api/memory/file, DATA-3). A deleted skill's draft is re-created this way.
  //  · neither — exactly the old behaviour. The config editor (views-system.js) and „Neuer UI-Skill" / „Aus Skill
  //    erstellen" overwrite on purpose (the latter two after their own question) and send no version.
  // Check and write run under the file's lock, so two saves with the same version cannot both pass the check.
  'PUT /api/cfgfile': async (req, res, url, p) => {
    const body = await readJsonBody(req);
    const file = cfgFilePath(body.kind, body.name);
    if (!file) return sendJson(res, 400, { error: 'bad params' });
    if (typeof body.content !== 'string') return sendJson(res, 400, { error: 'content required' });
    const ifMatch = settingsIfMatch(req);
    const out = await withFileLock(file, async () => {
      if (body.create === true) {
        let siblings = [];
        try { siblings = await fsp.readdir(path.dirname(file)); } catch (e) {
          // no commands/ dir yet → nothing to collide with. Any OTHER failure means nobody can tell whether the name
          // is taken — „never an overwrite" must not rest on a swallowed error.
          if (e.code !== 'ENOENT') return [409, { error: UNREADABLE_MSG, code: 'unreadable', readError: errorText(e) }];
        }
        const want = path.basename(file).toLowerCase();
        const clash = siblings.find((f) => f.toLowerCase() === want);
        if (clash) return [409, { error: '"' + clash + '" existiert bereits', code: 'exists', existing: clash }];
      }
      if (ifMatch) {
        let cur = null;
        try { cur = await fsp.readFile(file, 'utf8'); } catch (e) {
          // nobody has seen what an unreadable file holds — nothing may replace it on the strength of a version
          if (e.code !== 'ENOENT') return [409, { error: UNREADABLE_MSG, code: 'unreadable', readError: errorText(e) }];
        }
        if (cur === null) return [409, { error: 'the file was deleted since it was loaded', code: 'changed', exists: false, hash: '' }];
        const hash = textHash(cur);
        if (hash !== ifMatch) return [409, { error: 'the file has changed since it was loaded', code: 'changed', exists: true, hash }];
      }
      await fsp.mkdir(cfgDir(body.kind), { recursive: true });
      // backupFile answers null only for ENOENT (no file to copy) and throws on every other failure — so
      // `!backup` here does mean „there was no file", and `created` says no more than that
      const backup = await backupFile(file);
      await fsp.writeFile(file, body.content, 'utf8');
      // the version of what is on disk NOW — the caller's next If-Match
      return [200, { ok: true, backup, created: !backup, hash: textHash(body.content) }];
    });
    return sendJson(res, out[0], out[1]);
  },
  'POST /api/cfgfile/delete': async (req, res, url, p) => {
    const body = await readJsonBody(req);
    const file = cfgFilePath(body.kind, body.name);
    if (!file) return sendJson(res, 400, { error: 'bad params' });
    try {
      await fsp.mkdir(BACKUP_DIR, { recursive: true });
      await fsp.rename(file, path.join(BACKUP_DIR, 'deleted-' + body.kind + '-' + path.basename(file) + '.' + Date.now() + '.bak'));
      return sendJson(res, 200, { ok: true });
    } catch (e) { return sendJson(res, 404, { error: errorText(e) }); }
  },

  // ---- System: doctor + auth ----
  'GET /api/changelog': async (req, res, url, p) => {
    const r = await run('git', ['-C', REPO_DIR, 'log', '--pretty=format:%h%x09%ad%x09%s', '--date=format:%Y-%m-%d %H:%M', '-n', '100'], { timeout: 15000 });
    const commits = (r.stdout || '').split('\n').filter(Boolean).map((line) => {
      const parts = line.split('\t');
      return { hash: parts[0], date: parts[1], subject: parts.slice(2).join(' ') };
    });
    return sendJson(res, 200, { commits, error: r.err && !commits.length ? errorText(r.err) : null });
  },
  'GET /api/sysinfo': async (req, res, url, p) => {
    // B5: the version comes from the SAME cache the sidebar pill polls (lib/cli cliVersion: one
    // `--version` per 5 min, one `npm view` per 30 min, shared in-flight). This route used to run its
    // own `--version` (a 218 MB exe start) plus its own registry pair on EVERY System-view open — next
    // to the cached pair the pill had just fetched. While the CLI updates, cliVersion() answers the
    // pre-update snapshot without spawning anything.
    // The process count rides along (tasklist, read-only, ~100 ms): null = "could not tell", which the
    // update route treats as a reason to ask first (process-state-unknown), so the view says so too.
    const [cv, procs] = await Promise.all([
      cliMod.cliVersion().catch(() => ({})),
      cliMod.claudeProcessCount().catch(() => null),
    ]);
    const cj = await readJsonFile(CLAUDE_JSON);
    const s = await readJsonFile(SETTINGS);
    const enabledPlugins = mergedEnabledPlugins(s, cj);
    const env = {};
    for (const k of Object.keys(process.env)) { if (/^(ANTHROPIC_|CLAUDE_|CC_)/.test(k)) env[k] = maskEnvValue(k, process.env[k]); }
    return sendJson(res, 200, {
      cliVersion: cv.current || '',
      // isNewer (inside cliVersion), not `!==`: a locally installed build the registry doesn't carry
      // (yet) is not an "update available", and used to show a "↑" that no update could ever clear.
      cliLatest: cv.latest || null, updateAvailable: !!cv.updateAvailable,
      cliUpdating: cliMod.isCliUpdating(),
      claudeRunning: (typeof procs === 'number') ? procs : null,
      claudeRunningWarning: (typeof procs === 'number') ? null : 'process-state-unknown',
      node: process.version, platform: os.platform(), release: os.release(), arch: os.arch(),
      claudeExe: CLAUDE_EXE, claudeDir: CLAUDE_DIR, home: HOME,
      // detection diagnostics (lib/paths resolveClaudeBin): source = which rule won, tried = every
      // path that was checked, installMethod = the CLI's own claim in ~/.claude.json (miss only)
      claudeExeExists: !!(await binState()).exeExists, claudeBinSource: CLAUDE_BIN_INFO.source, // N12: cached
      claudeBinTried: CLAUDE_BIN_INFO.tried || [], claudeInstallMethod: CLAUDE_BIN_INFO.installMethod || '',
      pluginCount: Object.keys(enabledPlugins).length,
      port: PORT, uptimeSec: Math.round(process.uptime()), env,
    });
  },
  // ---- Claude Code CLI (claude.exe): version state + 1-click update ----
  // Separate from /api/sysinfo because the sidebar pill POLLS this (sysinfo runs once per view) and
  // because it is the pair of the app's own /api/version + /api/version/pull: same pill, same wording,
  // one for the panel, one for the CLI it drives. Server-side cached (see lib/cli.js).
  'GET /api/cli/version': async (req, res, url, p) => {
    return sendJson(res, 200, await cliMod.cliVersion({ force: url.searchParams.get('force') === '1' }));
  },
  'POST /api/cli/update': async (req, res, url, p) => {
    const body = await readJsonBody(req).catch(() => ({}));
    // B1: ONE updater at a time. A second click (or a second tab) used to start a second `claude update`
    // against the same file. Checked here for the early answer AND inside runCliUpdate (withCliUpdate),
    // which is the authoritative, synchronous gate — two requests that both pass this line during the
    // process count below still end with exactly one updater.
    if (cliMod.isCliUpdating()) return sendJson(res, 409, { error: 'already-running', code: 'already-running', since: cliMod.cliUpdatingSince() });
    // Windows keeps a RUNNING .exe locked against unlink, so an update fired while any claude.exe is
    // alive can fail part-way through — the worst possible moment for the binary this panel drives.
    // Count first (the panel's own chats AND the terminal sessions it can't see), refuse with the
    // numbers, and let the client re-send `force` once the user has seen them.
    if (!body.force) {
      let panelChats = 0; for (const c of chats.values()) if (c.alive) panelChats++;
      const procs = await cliMod.claudeProcessCount();
      if (panelChats > 0 || (procs !== null && procs > 0)) {
        return sendJson(res, 409, { error: 'claude-running', code: 'claude-running', chats: panelChats, procs });
      }
      // B5: null = tasklist failed / not Windows = "could not tell" — that used to count as "nothing
      // running" and let the update through blind. Ask instead; `force` is the informed yes.
      if (procs === null) {
        return sendJson(res, 409, { error: 'process-state-unknown', code: 'process-state-unknown', chats: panelChats, procs: null });
      }
    }
    const r = await cliMod.runCliUpdate();
    if (r.code === 'already-running') return sendJson(res, 409, r);
    // failure: 500 as before; `code: 'cli-missing'` (+ exe, oldFiles) when the binary is GONE afterwards
    return sendJson(res, r.ok ? 200 : 500, r);
  },
  // ---- Model list: mirrors the console's /model menu, assembled from the CLI's own ~/.claude.json ----
  // First-party auth: offline (no CLI spawn/network): buildModelMenu reads modelAccessCache +
  // additionalModelOptionsCache so the dropdown matches the account (e.g. Fable appears when entitled).
  // pricing feeds the client's cost estimate. Aliases (opus/sonnet/haiku) resolve at spawn time.
  // On Bedrock those caches do not exist and entitlement is an IAM policy → measured instead
  // (lib/bedrock.js, token-free probe, cached). `?recheck=1` forces a fresh measurement.
  'GET /api/models': async (req, res, url, p) => {
    const cj = await readJsonFile(CLAUDE_JSON); // mirror the console's /model list from the CLI's own state
    const st = await readJsonFile(SETTINGS);
    const settings = st.parsed || {};
    // `pricing` is the EFFECTIVE table: a managed modelPricing (CLI 2.1.271) replaces the list
    // prices for this machine, and the browser must price a turn exactly as the server does.
    const money = { pricing: effectivePricing(), pricingManaged: pricingIsManaged() };
    const cfg = bedrockConfig(settings);
    // settings.json `model` is what the CLI falls back to when the panel passes no --model, so it is what
    // "Default" really starts — on BOTH menus. The first-party one was built without it, which left its
    // Default row with `resolves: ''` (lib/models.js): a Default tab running the 1M model then carried no
    // evidence of its own wideness anywhere, and the context gauge measured it against the name table's
    // 200 000 — „Kontext 250 % · 500,8K / 200,0K". It matters on Bedrock too, because of the fallback below.
    const settingsModel = String(settings.model || '');
    if (!cfg.enabled) return sendJson(res, 200, { models: buildModelMenu(cj.parsed || {}, settingsModel), ...money, bedrock: { enabled: false } });
    // A FAILED measurement must not empty the dropdown: then the old console menu stands and
    // `bedrock.error` says why nothing was judged.
    const access = await getBedrockAccess(cfg, { force: url.searchParams.get('recheck') === '1' });
    const verdictOf = (id) => {
      const hit = (access.models || []).find((m) => bedrockBase(m.id) === bedrockBase(id));
      return hit ? hit.verdict : '';
    };
    return sendJson(res, 200, {
      // …and the fallback carries `settingsModel` too: without it the ONE case where the probe answered
      // nothing (no VPN, no credentials) was also the case where every Default tab lost the only statement
      // about its variant.
      models: (access.models || []).length ? buildBedrockMenu(access, settingsModel) : buildModelMenu(cj.parsed || {}, settingsModel),
      ...money,
      bedrock: {
        enabled: true, region: cfg.region, profile: cfg.profile,
        checkedAt: access.checkedAt || 0, error: access.error || '',
        // What "Default" really starts: settings.json `model` is what the CLI falls back to when the
        // panel passes no --model, so its verdict belongs in the UI, not in a comment.
        defaultModel: { id: settingsModel, verdict: settingsModel ? (verdictOf(settingsModel) || 'unknown') : '' },
        denied: (access.models || []).filter((m) => m.verdict === 'denied').map((m) => m.id),
      },
    });
  },
  // ---- Can ultracode be offered for a model, BEFORE a session exists? ----
  // The authoritative answer (`ultracodeAvailable`) only exists on a running session, but the switch has
  // to be labelled honestly in the tab menu and in Settings, where nothing is running yet. So this asks
  // the CLI the one question it can answer for free: the `initialize` control response lists every model
  // with its `supportedEffortLevels`, and ultracode needs `xhigh`. Same probe /api/skills already uses
  // (60 s cache, usually warm, no model call). Falls back to the mirrored table when the probe fails —
  // and an unknown model counts as supported, because get_settings corrects an optimistic answer within
  // a second of the session starting, while a wrong „no" would hide the switch for good.
  'GET /api/ultracode/support': async (req, res, url, p) => {
    const model = url.searchParams.get('model') || '';
    const info = await getSessionInfoCached();
    const cliModels = (info && Array.isArray(info.models)) ? info.models : null;
    const sup = ultracodeModelSupport(cliModels, model);
    return sendJson(res, 200, {
      model,
      supported: sup.supported,
      source: sup.source,                                  // 'cli' | 'table' | 'unknown'
      probeError: (info && info.error) ? String(info.error) : '',
      // Was a plain `find(m => m.value === (model || 'default'))` here, which only ever matched an ALIAS —
      // so for every concrete Bedrock id the dropdown holds this came back [] and the per-model effort
      // filter could never fire. modelEffortLevels does the same alias↔resolvedModel join
      // ultracodeModelSupport two lines up has always done.
      effortLevels: modelEffortLevels(cliModels, model),
      // …and the fact modelEffortLevels CANNOT carry, because it answers [] to two different questions:
      // „the CLI listed this model and it has no effort levels at all" (Haiku 4.5 — measured) and „nobody
      // could tell us" (the probe failed, or no entry matched). The route knows which of the two it is —
      // `sup.source === 'cli'` means the CLI's own list had an entry for this model — so it states it
      // instead of leaving the browser to guess from an empty array.
      //
      // The DROPDOWN deliberately keeps conflating them: with `known && []` the honest filter would
      // disable every level, and an effort picker in which nothing is selectable is a dead end the user
      // cannot argue with — while a CLI that one day stops populating the field would produce exactly
      // that shape for every model (the same failure mode `fieldIsLive` guards in ultracodeModelSupport).
      // So the picker stays open and `effortLevelsKnown` is used for the one thing that cannot mislead:
      // the warning line may now say „this model has no effort levels" for a model the CLI really listed
      // that way, and stays silent when nobody checked (public/js/chat.js effortLevelNotInModel).
      effortLevelsKnown: sup.source === 'cli',
    });
  },
  // ---- App self-version: local HEAD (git) vs remote main via the GHE REST token (#27) ----
  // The detached server can't `git fetch` the private GHE remote (no git creds in that process), but the REST
  // token works (same path as Report-Bug). So compare via REST → "offline" now means REST is truly unreachable.
  'GET /api/version': async (req, res, url, p) => {
    const g = (a, o) => run('git', ['-C', REPO_DIR].concat(a), o);
    // %H (full sha) rides along in the same log call — this used to be a second `rev-parse HEAD`
    // process. The route is polled now, so every avoidable spawn is one the user pays for repeatedly.
    const FMT = '--format=%h%x1f%cI%x1f%s%x1f%H'; // %x1f = unit separator (subjects can contain | or tabs)
    // One `status --porcelain --branch` answers BOTH questions this route used to ask separately:
    // which branch HEAD is on (was its own `rev-parse --abbrev-ref`) and whether the tree is dirty.
    // So `dirty` costs no extra process. It belongs here because the update button cannot run with
    // local changes at all (`git pull --ff-only` refuses): without it the row kept offering an
    // update that was bound to be refused, and you only learned that by clicking it.
    const st = parsePorcelainBranch((await g(['status', '--porcelain', '--branch'])).stdout);
    const branch = st.branch;
    const curLog = ((await g(['log', '-1', FMT, 'HEAD'])).stdout || '').split('\x1f');
    const curFull = (curLog[3] || '').trim();
    // serverStale = the running process booted from an OLDER commit than the working tree on disk → restart needed
    const serverStale = !!(BOOT_COMMIT && curFull && BOOT_COMMIT !== curFull);
    let fetchOk = false, behind = 0, ahead = 0, remote = '', remoteDate = '', remoteSubject = '', note = '';
    // compareOk = behind/ahead are REAL counts. A failed compare used to silently set `behind = 1`,
    // which rendered as a permanent phantom "Update · 1" whenever the local commits aren't on the
    // remote at all (an unpushed branch) — and the update button then pulled nothing, forever. The
    // counts are now either exact or explicitly unknown. localOnly = the remote has never seen our HEAD.
    let compareOk = true, localOnly = false;
    // Deadline on the REMOTE half only (the local git reads above are cheap): with tries:3 + a 20s
    // socket timeout the two chained gheGets can burn ~60s off-VPN, and the System view just spun.
    // The local commit info is already known here, so a timeout degrades to the same "offline"
    // rendering the error path produces.
    const VERSION_REMOTE_DEADLINE_MS = 15000;
    // gheGet retries a transient (cold-boot) failure once + coalesces the two concurrent boot-time checks + briefly
    // caches the success, so the first render can't get stuck on a false "offline" (#27 cold-start hardening).
    const timedOut = await withDeadline((async () => {
      const br = await github.gheGet('/repos/' + github.REPO_OWNER + '/' + github.REPO + '/branches/main', { tries: 3, ttlMs: 15000 });
      if (!br.error && br.status === 200 && br.json && br.json.commit) {
        fetchOk = true;
        const rc = br.json.commit;
        remote = (rc.sha || '').slice(0, 7);
        remoteSubject = (((rc.commit && rc.commit.message) || '').split('\n')[0]) || '';
        remoteDate = (rc.commit && rc.commit.committer && rc.commit.committer.date) || '';
        if (curFull && rc.sha && curFull !== rc.sha) {
          // LOCAL-FIRST: when the local repo already knows the remote tip (the usual case — we are
          // ahead of it, or merely behind after a fetch), `rev-list --left-right --count` answers
          // exactly, with no API call. Only an unknown remote tip needs the compare endpoint.
          const known = !(await g(['cat-file', '-e', rc.sha + '^{commit}'])).err;
          const counted = known ? parseRevListLeftRight((await g(['rev-list', '--left-right', '--count', rc.sha + '...HEAD'])).stdout) : null;
          if (counted) { behind = counted.behind; ahead = counted.ahead; }
          else {
            // compare base=local...head=main: ahead_by = commits main has that local lacks = how far local is BEHIND
            const cmp = await github.gheGet('/repos/' + github.REPO_OWNER + '/' + github.REPO + '/compare/' + curFull + '...' + rc.sha, { tries: 2 });
            if (!cmp.error && cmp.status === 200 && cmp.json) { behind = cmp.json.ahead_by || 0; ahead = cmp.json.behind_by || 0; }
            else {
              // Can't compare. Distinguish "our commit is unknown to the remote" (unpushed work —
              // there is nothing to pull) from a plain API failure, and never invent a count.
              compareOk = false;
              const probe = await github.gheGet('/repos/' + github.REPO_OWNER + '/' + github.REPO + '/commits/' + curFull, { tries: 1 });
              localOnly = !probe.error && probe.status === 404;
              if (!note) note = localOnly ? 'local commits not on the remote (branch not pushed)' : ('compare failed' + (cmp.status ? ' (HTTP ' + cmp.status + ')' : ''));
            }
          }
        }
      } else {
        note = br.error ? String(br.error) : (br.status === 0 ? 'unreachable (VPN/token)' : ('HTTP ' + br.status));
      }
      return false;
    })(), VERSION_REMOTE_DEADLINE_MS, true);
    if (timedOut) { fetchOk = false; note = 'timeout (VPN/token)'; }
    return sendJson(res, 200, {
      fetchOk, branch,
      current: curLog[0] || '', currentDate: curLog[1] || '', currentSubject: curLog[2] || '',
      remote, remoteDate, remoteSubject,
      behind, ahead, compareOk, localOnly,
      upToDate: fetchOk && compareOk && behind === 0,
      // capped like the refusal's list: a row/tooltip names a handful of files, it does not need 300
      dirty: st.files.slice(0, 20), dirtyCount: st.files.length,
      boot: (BOOT_COMMIT || '').slice(0, 7), serverStale,
      note,
    });
  },
  // ---- 1-click sync: token-authed `git pull --ff-only` so it works in the detached server (#27) ----
  'POST /api/version/pull': async (req, res, url, p) => {
    // B1: ONE self-update at a time. Two clicks (or two tabs) ran two `git checkout main` + `git pull`
    // against the same checkout concurrently — git's index.lock then failed one of them half-way, with
    // a raw "Unable to create '.git/index.lock'" in the card. The flag is set synchronously, before the
    // first await, and cleared in `finally` (not on response 'close': a client that disconnects must
    // not let a second pull start while git is still running).
    if (selfPulling) return sendJson(res, 409, { error: 'already-running', code: 'already-running', since: selfPulling });
    selfPulling = Date.now();
    try {
      // test-only seam (inert unless set): hold the guarded section open so a test can send the second
      // request while the first is provably inside it — no git, no network involved
      const hold = Number(process.env.CLAUDE_UI_FAKE_PULL_DELAY_MS) || 0;
      if (hold > 0) await new Promise((r) => setTimeout(r, hold));
      return await selfPull(req, res);
    } finally { selfPulling = 0; }
  },
  // ---- Restart the panel process itself, so "Neustart nötig" isn't a dead end (a server can't
  // restart in place: we spawn a DETACHED successor that waits for the port to be released, starts
  // a fresh `node server.js` in this repo, and exits — then this process exits). Localhost-only and
  // Origin-guarded like every other route; the client confirms first and polls /api/ping to reload.
  'POST /api/restart': async (req, res, url, p) => {
    // #2: not while `claude update` replaces the binary (shutdown would cut it off half-way and its
    // own response would never arrive) or a self-pull is inside git (a successor booting from a
    // half-checked-out tree). 409 + WHAT is busy and since when, so the client can say so and offer
    // the restart again. The pull → restart chain still works: every pull answer is sent before the
    // route's `finally` clears selfPulling, a microtask later — no new request is parsed in between.
    const busy = cliMod.isCliUpdating() ? 'cli' : (selfPulling ? 'pull' : null);
    if (busy) return sendJson(res, 409, { error: 'busy-updating', code: 'busy-updating', what: busy, since: busy === 'cli' ? cliMod.cliUpdatingSince() : selfPulling });
    // #4: and not once a restart is already under way. server.close() only refuses NEW connections, so
    // a second click (another window, or this one's button that no busy flag locks) can still arrive on
    // an open keep-alive socket — it would hand the port to a SECOND successor, and the loser then dies
    // on EADDRINUSE and leaves an error in the log for a restart the user believes worked.
    if (refuseWhileShuttingDown(res)) return;
    const LAUNCHER = `
      const net = require('net'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
      const root = process.env.CCUI_RESTART_ROOT, port = Number(process.env.CCUI_RESTART_PORT), logFile = process.env.CCUI_RESTART_LOG;
      const portFree = () => new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.once('listening', () => s.close(() => r(true))); s.listen(port, '127.0.0.1'); });
      (async () => {
        for (let i = 0; i < 80 && !(await portFree()); i++) await new Promise((r) => setTimeout(r, 250)); // wait out the old listener (<=20s)
        let out = 'ignore';
        try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); out = fs.openSync(logFile, 'a'); } catch { /* log is best-effort */ }
        spawn(process.execPath, ['server.js'], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, out] }).unref();
      })();
    `;
    let child = null;
    try {
      child = spawn(process.execPath, ['-e', LAUNCHER], {
        detached: true, windowsHide: true, stdio: 'ignore',
        // SERVER_LOG (lib/paths) = start.ps1's log, or the test data dir under CLAUDE_UI_DATA_DIR
        env: { ...process.env, CCUI_RESTART_ROOT: __dirname, CCUI_RESTART_PORT: String(PORT), CCUI_RESTART_LOG: SERVER_LOG },
      });
      child.unref();
    } catch (e) {
      return sendJson(res, 500, { error: 'spawn failed: ' + errorText(e) }); // still alive — don't exit
    }
    if (!child || !child.pid) return sendJson(res, 500, { error: 'launcher did not start' });
    // `log` (B4): where the successor writes. When it fails to come up (port still held, syntax error
    // after a pull) the panel just never answers again — the client can at least name the file.
    sendJson(res, 200, { ok: true, launcher: child.pid, port: PORT, log: SERVER_LOG });
    // Exit only AFTER the response has actually flushed — exiting on a fixed timer raced the write
    // and the caller got ECONNRESET instead of the confirmation. `finish` fires when the body is out.
    // FLOW-2: through shutdown(), not a bare exit — the chats and headless runs of this process used to
    // be left behind as orphaned claude.exe trees (and 'running' records nobody would ever close).
    let gone = false;
    const handOver = () => {
      if (gone) return; gone = true;
      shutdown('restart', 0);
    };
    if (res.writableEnded) handOver(); else res.once('finish', handOver);
    setTimeout(handOver, 3000).unref(); // safety net if `finish` never arrives
    return;
  },
  // ---- A subagent's own transcript, incrementally (#34) ----
  // A backgrounded agent writes its full JSONL transcript to `outputFile` while it works (see
  // lib/agent-output.js for the path shape and what is in it). This hands the browser the part it
  // has not seen yet, as compact display events — never the raw 500 KB file, and never a file
  // outside %TEMP%/claude, whatever the query string says.
  'GET /api/agent/output': async (req, res, url, p) => {
    const file = url.searchParams.get('file') || '';
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    if (!agentOutputPathOk(file)) return sendJson(res, 400, { error: 'invalid agent output path' });
    const MISSING = { ok: true, missing: true, size: 0, events: [], nextOffset: 0, eof: true };
    // ONE descriptor for the size AND for the read (#69). It was a name-based stat followed by a
    // name-based open, i.e. two lookups of a path that a temp cleanup (or a new agent reusing the id)
    // can replace in between: the bytes read were then not the bytes that had been measured, and the
    // client got a length it could not trust. fh.stat() measures the file this descriptor already
    // holds, so nothing can be swapped underneath it.
    // A failing open is not an error either: the file appears a moment after the launch receipt and is
    // deleted with the session's temp directory. Both read as "nothing to show yet/any more".
    let fh = null;
    try { fh = await fsp.open(file, 'r'); } catch { return sendJson(res, 200, MISSING); }
    try {
      const st = await fh.stat();
      if (!st.isFile()) return sendJson(res, 400, { error: 'not a file' });
      const size = st.size;
      // A file that SHRANK (temp cleanup + a new agent reusing the id) would otherwise be read from a
      // stale offset, i.e. from the middle of a record — start over instead.
      const from = offset > size ? 0 : offset;
      const MAX_CHUNK = 2 * 1024 * 1024;
      const end = Math.min(size, from + MAX_CHUNK);
      let text = '';
      if (end > from) {
        const buf = Buffer.alloc(end - from);
        const { bytesRead } = await fh.read(buf, 0, buf.length, from);
        text = buf.slice(0, bytesRead).toString('utf8');
      }
      const { events, consumed, truncated } = parseAgentOutput(text);
      const nextOffset = from + consumed;
      return sendJson(res, 200, {
        ok: true, size, events, nextOffset,
        // `eof` = the client has seen everything currently on disk. Not "the agent is done" — that is
        // the lane's job to know; a quiet agent and a finished one look identical from here.
        eof: nextOffset >= size, truncated: !!truncated || end < size, restarted: offset > size,
      });
    } finally { await fh.close().catch(() => {}); }
  },
  // ---- Working-copy diff of a cwd (ToDo 03: /diff viewer) ----
  'GET /api/diff': async (req, res, url, p) => {
    // Which directories a caller may name — and which part of alert #5 this answers and which it does
    // not — is written down once, at resolveCwdParam() in lib/core.js. `__dirname` is the panel's own
    // checkout and configuration, not input, so it is not gated.
    const c = resolveCwdParam(url.searchParams.get('cwd'));
    if (c.error) return sendJson(res, c.status, { error: c.error, code: 'cwd-refused' });
    const dir = c.dir || __dirname;
    // `await fsp.stat`, not `fs.statSync`: the gate above refuses the UNC path that blocked for 54 875
    // ms, but a mapped drive letter on a dead share is the same wait with a local-looking name, and on
    // the threadpool that stalls this ONE request instead of every request the panel has.
    try { if (!(await fsp.stat(dir)).isDirectory()) return sendJson(res, 400, { error: 'not a directory' }); }
    catch { return sendJson(res, 400, { error: 'no such directory' }); }
    const isRepo = await run('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { timeout: 8000 });
    if (isRepo.err || (isRepo.stdout || '').trim() !== 'true') return sendJson(res, 200, { repo: false, dir });
    const branch = ((await run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 8000 })).stdout || '').trim();
    const statR = await run('git', ['-C', dir, 'diff', '--stat'], { timeout: 15000 });
    const patchR = await run('git', ['-C', dir, 'diff'], { timeout: 20000 });
    const porcR = await run('git', ['-C', dir, 'status', '--porcelain'], { timeout: 10000 });
    const files = parsePorcelain(porcR.stdout);
    let patch = patchR.stdout || ''; const truncated = patch.length > 200000; if (truncated) patch = patch.slice(0, 200000);
    // A diff bigger than run()'s 8MB maxBuffer makes execFile kill git and hand back an err with a
    // truncated (often empty) stdout — which rendered as "no changes", i.e. a clean tree. Say so
    // explicitly: an empty patch must never be indistinguishable from a real one.
    const patchTooLarge = !!(patchR.err && (patchR.err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(String(patchR.err.message || ''))));
    const out = { repo: true, dir, branch, stat: statR.stdout || '', patch, files, truncated: truncated || patchTooLarge };
    if (patchTooLarge) out.patchError = 'too-large';
    return sendJson(res, 200, out);
  },
  // ---- Open PRs of your-org/claude-code-ui + review state (ToDo 03: PR-status footer) ----
  // The review state is an N+1: one GHE call per PR. Those ran STRICTLY SEQUENTIALLY, so 15 open PRs
  // on the VPN meant 15 round trips (each up to 20s) before the footer painted anything. Now: 4 in
  // parallel, and the whole route is capped — on expiry the PRs collected so far go out with
  // `partial: true` and the un-fetched ones keep their 'pending' state.
  'GET /api/prs': async (req, res, url, p) => {
    if (!github.tokenPresent()) return sendJson(res, 200, { ok: false, reason: 'no-token', prs: [] });
    const PRS_DEADLINE_MS = 15000, PRS_CONCURRENCY = 4;
    const prs = [];
    let reason = null, partial = true;
    await withDeadline((async () => {
      const r = await github.listPulls();
      if (r.error || !Array.isArray(r.json)) { reason = r.error || ('status ' + r.status); return; }
      const list = r.json.slice(0, 15);
      // seed the output first, so a deadline hit still returns every PR (just with 'pending' review state)
      for (const pr of list) prs.push({ number: pr.number, title: pr.title, url: pr.html_url, author: pr.user && pr.user.login, draft: !!pr.draft, state: pr.draft ? 'draft' : 'pending' });
      await mapLimit(list, PRS_CONCURRENCY, async (pr, i) => {
        if (pr.draft) return;
        const rv = await github.pullReviews(pr.number);
        if (!Array.isArray(rv.json) || !rv.json.length) return;
        const latest = {}; rv.json.forEach((x) => { if (x.user && x.state) latest[x.user.login] = x.state; });
        const states = Object.values(latest);
        if (states.includes('CHANGES_REQUESTED')) prs[i].state = 'changes';
        else if (states.includes('APPROVED')) prs[i].state = 'approved';
      });
      partial = false;
    })(), PRS_DEADLINE_MS, null);
    if (reason && !prs.length) return sendJson(res, 200, { ok: false, reason, prs: [] });
    return sendJson(res, 200, { ok: true, prs, partial });
  },
  // ---- Report a bug → open a GitHub issue in your-org/claude-code-ui (ToDo 04) ----
  'POST /api/bug': async (req, res, url, p) => {
    const b = await readJsonBody(req);
    const title = String(b.title || '').trim();
    const desc = String(b.description || '').trim();
    const category = ['bug', 'enhancement', 'question'].includes(b.category) ? b.category : 'bug';
    if (!title) return sendJson(res, 400, { error: 'title required' });
    if (!github.tokenPresent()) return sendJson(res, 400, { error: 'no-token', tokenMissing: true, credsPath: GHE_CREDS });
    // compose the body server-side; append ONLY safe diagnostics — never env values, tokens, or transcript
    let body = desc || '_(keine Beschreibung / no description)_';
    if (b.includeDiagnostics) {
      const verR = await run('git', ['-C', REPO_DIR, 'log', '-1', '--format=%h %s (%cI)'], { timeout: 8000 });
      // (no spawn while `claude update` runs — the row then says '?' instead of the report failing)
      const cliR = cliMod.isCliUpdating() ? { stdout: '' } : await cliMod.claudeSpawn(['--version'], { timeout: 10000 });
      const cliV = ((cliR.stdout || '').match(/\d+\.\d+\.\d+/) || [''])[0];
      body += '\n\n---\n<details><summary>Diagnostics</summary>\n\n| | |\n|---|---|\n'
        + `| App version | \`${(verR.stdout || '?').trim()}\` |\n`
        + `| CLI | ${cliV || '?'} |\n`
        + `| Node | ${process.version} |\n`
        + `| OS | ${os.platform()} ${os.release()} · ${os.arch()} |\n`
        + `| Browser | ${String(b.ua || '').slice(0, 200).replace(/\|/g, '/')} |\n`
        + `| View | ${String(b.view || '').slice(0, 40).replace(/\|/g, '/')} |\n`
        + `| Server | uptime ${Math.round(process.uptime())}s · port ${PORT} |\n`
        + '\n</details>';
    }
    const labels = [category];
    const target = `${github.REPO_OWNER}/${github.REPO}`;
    if (url.searchParams.get('dryRun') === '1') {
      return sendJson(res, 200, { ok: true, dryRun: true, target, title, labels, bodyPreview: body.slice(0, 2000) });
    }
    const r = await github.createIssue({ title, body, labels });
    if (r.error || (r.status !== 201 && r.status !== 200) || !r.json) {
      return sendJson(res, 502, { error: r.error || ('GitHub returned ' + r.status), detail: r.json && r.json.message });
    }
    return sendJson(res, 200, { ok: true, number: r.json.number, html_url: r.json.html_url, target });
  },
  // ---- Recent open issues for the Report-Bug "zuletzt gemeldet" list (ToDo 04) ----
  'GET /api/bugs': async (req, res, url, p) => {
    if (!github.tokenPresent()) return sendJson(res, 200, { ok: false, reason: 'no-token', issues: [] });
    const r = await github.listIssues('open');
    if (r.error || !Array.isArray(r.json)) return sendJson(res, 200, { ok: false, reason: r.error || ('status ' + r.status), issues: [] });
    const issues = r.json.filter((i) => !i.pull_request).slice(0, 15)
      .map((i) => ({ number: i.number, title: i.title, url: i.html_url, state: i.state, labels: (i.labels || []).map((l) => l.name || l), created: i.created_at }));
    return sendJson(res, 200, { ok: true, issues });
  },
  'GET /api/backups': async (req, res, url, p) => {
    return sendJson(res, 200, { backups: await listBackups(), dir: BACKUP_DIR });
  },
  'GET /api/backups/download': async (req, res, url, p) => {
    const name = url.searchParams.get('name') || '';
    if (name.includes('..') || name.includes('/') || name.includes('\\')) return sendText(res, 400, 'bad name');
    const file = path.join(BACKUP_DIR, name);
    if (!file.startsWith(BACKUP_DIR + path.sep)) return sendText(res, 403, 'forbidden');
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + name + '"', 'Cache-Control': 'no-store' });
      return res.end(data);
    } catch { return sendText(res, 404, 'not found'); }
  },
  // What the confirmation dialog is built from: current content vs. backup content, plus WHICH of the
  // three outcomes a restore has here (new file · overwrite · refused with 409). Read-only, and it goes
  // through the same restoreTarget() the restore below uses — a preview of a different file than the one
  // that gets written would be worse than no preview at all.
  'GET /api/backups/preview': async (req, res, url, p) => {
    const r = await previewBackup(url.searchParams.get('name') || '');
    return sendJson(res, r.status, r.body);
  },
  'POST /api/backups/restore': async (req, res, url, p) => {
    const b = await readJsonBody(req);
    const name = String(b.name || '');
    if (name.includes('..') || name.includes('/') || name.includes('\\')) return sendJson(res, 400, { error: 'bad name' });
    const src = path.join(BACKUP_DIR, name);
    if (!src.startsWith(BACKUP_DIR + path.sep) || !fs.existsSync(src)) return sendJson(res, 404, { error: 'backup not found' });
    const info = classifyBackup(name);
    try {
      // The destination comes from lib/backups restoreTarget(), shared with GET /api/backups/preview
      // above, so „where would this land" has exactly one answer. The refusals it carries are the ones
      // this route always had: no cwd in the transcript → 400, an unusable cfg target → 400, a kind no
      // restore can place → the download-only 400.
      const tgt = await restoreTarget(src, info);
      if (tgt.error) return sendJson(res, tgt.status, { error: tgt.error });
      if (info.kind === 'session') {
        if (fs.existsSync(tgt.dest)) return sendJson(res, 409, { error: 'Session existiert bereits im Projekt' });
        await fsp.mkdir(tgt.dir, { recursive: true });
        await fsp.rename(src, tgt.dest);
        return sendJson(res, 200, { ok: true, restoredTo: tgt.dest });
      }
      if (info.kind === 'cfg') {
        if (fs.existsSync(tgt.dest)) return sendJson(res, 409, { error: 'Datei existiert bereits' });
        await fsp.mkdir(tgt.dir, { recursive: true });
        await fsp.rename(src, tgt.dest);
        return sendJson(res, 200, { ok: true, restoredTo: tgt.dest });
      }
      if (info.kind === 'settings') {
        const dest = tgt.dest;
        // On the same lock as the editor's PUT and the comfort PATCHes, and atomic: a restore that ran
        // between a PATCH's read and its write would otherwise be undone by it a moment later.
        // The backup is read as BYTES (a utf8 round trip would turn every non-UTF-8 byte into U+FFFD —
        // a restore must give back what was saved) and BEFORE backupFile: that one prunes the oldest
        // backups, and restoring the oldest of 30 would otherwise delete its own source first.
        // A target that cannot be read is refused like PUT/PATCH do: it could not be backed up first.
        const refused = await withFileLock(dest, async () => {
          const cur = await readSettingsSnapshot(dest);
          if (cur.unreadable) return unreadableAnswer(cur);
          const data = await fsp.readFile(src);
          await backupFile(dest); // back up the current one first
          await writeJsonAtomic(dest, data);
          return null;
        });
        if (refused) return sendJson(res, refused[0], refused[1]);
        return sendJson(res, 200, { ok: true, restoredTo: dest });
      }
      // Unreachable today — restoreTarget() already refused every kind without a branch above. It stays
      // because the alternative to a wrong answer here is NO answer: a kind that gains a destination
      // without gaining a branch would fall off the end of this handler and leave the request hanging.
      return sendJson(res, 400, { error: DOWNLOAD_ONLY });
    } catch (e) { return sendJson(res, 500, { error: errorText(e) }); }
  },
  'GET /api/doctor': async (req, res, url, p) => {
    if (refuseWhileCliUpdating(res)) return;
    const r = await cliMod.claudeSpawn(['doctor'], { timeout: 45000 });
    return sendJson(res, 200, { output: (r.stdout || '') + (r.stderr ? '\n' + r.stderr : ''), error: r.err ? errorText(r.err) : null });
  },
  'GET /api/auth': async (req, res, url, p) => {
    if (refuseWhileCliUpdating(res)) return;
    const r = await cliMod.claudeSpawn(['auth', 'status'], { timeout: 20000 });
    let status = null; try { status = JSON.parse(r.stdout); } catch { /* */ }
    return sendJson(res, 200, { status, raw: r.stdout || r.stderr || '', error: r.err ? errorText(r.err) : null });
  },

  // ---- @-file mention: list files under a cwd (bounded walk) ----
  'GET /api/files': async (req, res, url, p) => {
    // Same gate as /api/diff (resolveCwdParam, lib/core.js) — HOME is the route's default and not input.
    const c = resolveCwdParam(url.searchParams.get('cwd'));
    // A REFUSED cwd is not an empty result: this route is the @-mention picker, and the picker renders an
    // empty list as "nothing matches". It has to be able to say "that directory, not your query" —
    // chat-composer.js updateAt() shows the reason as a row in the menu.
    if (c.error) return sendJson(res, c.status, { error: c.error, code: 'cwd-refused' });
    const base = c.dir || HOME;
    const q = (url.searchParams.get('q') || '').toLowerCase();
    // A directory that is merely not there stays an empty list, unchanged: the picker asks on every
    // keystroke while a path is being TYPED, and half a path is not an error.
    if (!(await fsp.stat(base).then((st) => st.isDirectory(), () => false))) return sendJson(res, 200, { files: [] });
    const SKIP = new Set(['node_modules', '.git', '.svn', 'dist', 'build', 'out', '.idea', '.vscode', 'target', '__pycache__']);
    const found = []; const CAP = 400;
    // The CAP only counts MATCHES: with a selective query over a big tree (e.g. cwd = C:\ or a
    // monorepo) the walk kept descending for minutes and blocked the event loop. Bound the work
    // itself too — nodes visited and wall-clock — and tell the client the list is partial.
    const NODE_CAP = 20000, TIME_BUDGET_MS = 500;
    const t0 = Date.now();
    let visited = 0, exhausted = false;
    const walk = async (dir, depth) => {
      if (found.length >= CAP || depth > 6 || exhausted) return;
      let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (found.length >= CAP) break;
        if (++visited > NODE_CAP || Date.now() - t0 > TIME_BUDGET_MS) { exhausted = true; break; }
        if (e.name.startsWith('.') && e.name !== '.claude') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP.has(e.name)) await walk(full, depth + 1); }
        else { const rel = path.relative(base, full); if (!q || rel.toLowerCase().includes(q)) found.push(rel.replace(/\\/g, '/')); }
      }
    };
    await walk(base, 0);
    found.sort((a, b) => a.length - b.length);
    return sendJson(res, 200, { files: found.slice(0, 60), partial: exhausted, visited });
  },

  // ---- Prompt enhancer: one-shot claude call, no tools ----
  // FLOW-5: "no tools" was the INTENT and not the argv. `claude -p` inherits the user's whole MCP set,
  // so a prompt rewrite connected all 9 configured servers of this machine (MEASURED 2026-10-03 out of
  // ~/.claude.json) before it could answer — every one of them with its own startup cost, its own
  // tokens in the system prompt, and `uvx <pkg>@latest` servers re-resolving against PyPI (27,7 s was
  // measured for one of them in lib/mcp.js). `--permission-mode plan` kept them from being USED; it did
  // not keep them from being STARTED.
  //   `--strict-mcp-config` WITHOUT a `--mcp-config` file means zero MCP servers. MEASURED in the
  // installed binary (claude.exe 2.1.288): the flag is a plain boolean (`"--strict-mcp-config": …
  // n.strictMcpConfig=!0`), and its own wording is "MCP servers are restricted to explicitly passed
  // config here, e.g. --strict-mcp-config or --bare" / "This session runs with --strict-mcp-config,
  // which connects no plugin servers".
  //   The one case it would REFUSE is an enterprise `managed-mcp.json` ("You cannot use
  // --strict-mcp-config when an enterprise MCP config is present"). There is none on this machine
  // (C:\ProgramData\ClaudeCode does not exist), and the panel already launches scoped CHAT sessions with
  // the same flag (lib/chat.js:346), so this adds no new failure mode that feature does not already have.
  'POST /api/enhance': async (req, res, url, p) => {
    const body = await readJsonBody(req);
    const text = String(body.text || '').trim();
    if (!text) return sendJson(res, 400, { error: 'text required' });
    const meta = 'Improve the following prompt for an AI coding assistant working on SAP/ABAP/UI5/OData/frontend tasks. '
      + 'Make it clearer, add helpful structure and any obviously-missing specifics, keep the original intent and language, and keep placeholders like <X>. '
      + 'Reply with ONLY the improved prompt, no preamble, no code fences.\n\n---\n' + text;
    // `await pathExists`, not `fs.existsSync` (S3): the enhancer is a one-shot `claude -p`, and the cwd
    // it is given is the chat tab's — which may well be a share. The fall-back to HOME is unchanged:
    // here the cwd only decides which project's settings the one-shot call inherits, so getting it wrong
    // costs nothing the user would have to be told about, unlike a whole chat session (lib/chat.js).
    const cwd = body.cwd && await pathExists(body.cwd) ? body.cwd : HOME;
    if (refuseWhileCliUpdating(res)) return;
    const r = await cliMod.claudeSpawn(['-p', meta, '--output-format', 'json', '--permission-mode', 'plan', '--strict-mcp-config'], { timeout: 90000, cwd });
    if (r.err && !r.stdout) return sendJson(res, 500, { error: errorText(r.err) });
    let out = r.stdout;
    try { const j = JSON.parse(r.stdout); out = j.result || j.text || r.stdout; } catch { /* plain text */ }
    return sendJson(res, 200, { text: String(out).trim() });
  },

  // ---- Skills ----
  'GET /api/skills': async (req, res, url, p) => {
    const [cmdFiles, info] = await Promise.all([scanCommands(), getSessionInfoCached()]);
    const all = info.commands || [];
    const userNames = new Set(cmdFiles.map((c) => c.name));
    const clean = (d) => (d || '').replace(/\s*\(user\)\s*$/i, '').trim();
    const commands = all.filter((c) => userNames.has(c.name)).map((c) => ({ name: c.name, description: clean(c.description) || (cmdFiles.find((x) => x.name === c.name) || {}).description || '' }));
    cmdFiles.forEach((cf) => { if (!commands.some((c) => c.name === cf.name)) commands.push({ name: cf.name, description: cf.description }); });
    const skills = all.filter((c) => !userNames.has(c.name)).map((c) => ({ name: c.name, description: clean(c.description) }));
    return sendJson(res, 200, { commands, skills, slashCommands: all.map((c) => c.name), error: info.error || null });
  },
  // full body + frontmatter of a command or bundled skill
  'GET /api/skill': async (req, res, url, p) => {
    const name = url.searchParams.get('name') || '';
    const source = url.searchParams.get('source') || 'command';
    // A PLUGIN skill is named "<plugin>:<skill>", and /api/skills lists those — so a flat
    // "no colon allowed" turned every plugin skill in the list into "bad name" the moment you
    // clicked it. Each part is still validated strictly (no separator, no `..`, no NTFS stream).
    if (!/^[\w.-]+(:[\w.-]+)?$/.test(name)) return sendJson(res, 400, { error: 'bad name' });
    let file = null;
    if (name.includes(':')) file = await pluginSkillPath(name);
    else if (source === 'command') file = cfgFilePath('commands', name);
    else file = await bundledSkillPath(name);
    if (!file) return sendJson(res, 200, { name, source, content: '', frontmatter: {}, path: null, available: false });
    try {
      const content = await fsp.readFile(file, 'utf8');
      return sendJson(res, 200, { name, source, content, frontmatter: parseFrontmatter(content), path: file, available: true });
    } catch (e) { return sendJson(res, 200, { name, source, content: '', frontmatter: {}, path: file, available: false, error: errorText(e) }); }
  },
  // duplicate a user command (or a bundled skill, if a body exists) into a new editable command
  'POST /api/skill/duplicate': async (req, res, url, p) => {
    const b = await readJsonBody(req);
    const name = b.name || '';
    if (!/^[\w.-]+$/.test(name)) return sendJson(res, 400, { error: 'bad name' });
    const src = (b.source === 'command') ? cfgFilePath('commands', name) : (await bundledSkillPath(name));
    if (!src || !fs.existsSync(src)) return sendJson(res, 404, { error: 'Quelle nicht gefunden / kein lokaler Inhalt' });
    let target = (b.target || (name + '-copy')).replace(/[^\w.-]/g, '');
    if (!target) return sendJson(res, 400, { error: 'bad target name' });
    const dest = cfgFilePath('commands', target);
    if (!dest) return sendJson(res, 400, { error: 'bad target' });
    if (fs.existsSync(dest)) return sendJson(res, 409, { error: 'command "' + target + '" existiert bereits' });
    try {
      await fsp.mkdir(cfgDir('commands'), { recursive: true });
      await fsp.copyFile(src, dest);
      return sendJson(res, 200, { ok: true, name: target });
    } catch (e) { return sendJson(res, 500, { error: errorText(e) }); }
  },
  // ---- UI Skills ----
  // list every command that carries a valid ```ui-skill block (name + parsed manifest + run stats)
  'GET /api/uiskills': async (req, res, url, p) => {
    const [skills, runs] = await Promise.all([scanUiSkills(), readUiRuns()]);
    const stats = {};
    for (const r of runs) { const k = r.name; if (!stats[k]) stats[k] = { runCount: 0, lastRun: 0 }; stats[k].runCount++; if ((r.startedAt || 0) > stats[k].lastRun) stats[k].lastRun = r.startedAt || 0; }
    skills.forEach((s) => { const st = stats[s.name] || { runCount: 0, lastRun: 0 }; s.runCount = st.runCount; s.lastRun = st.lastRun; });
    return sendJson(res, 200, { skills });
  },
  // favorites (shared by the Skills and UI Skills views, keyed by command/skill name)
  'GET /api/skill-favorites': async (req, res, url, p) => {
    return sendJson(res, 200, { favorites: await readSkillFavs() });
  },
  'POST /api/skill-favorites/toggle': async (req, res, url, p) => {
    const b = await readJsonBody(req);
    const name = String(b.name || '');
    if (!name) return sendJson(res, 400, { error: 'name required' });
    const favorite = await withFileLock(SKILL_FAV_FILE, async () => {
      const favs = await readSkillFavs();
      const i = favs.indexOf(name);
      let fav;
      if (i >= 0) { favs.splice(i, 1); fav = false; } else { favs.push(name); fav = true; }
      await writeSkillFavs(favs);
      return fav;
    });
    return sendJson(res, 200, { ok: true, favorite });
  },
  // ---- personal prompt library ----
  'GET /api/prompts': async (req, res, url, p) => {
    return sendJson(res, 200, { prompts: await readPrompts() });
  },
  'POST /api/prompts': async (req, res, url, p) => {
    const b = await readJsonBody(req);
    const text = String((b && b.text) || '').trim();
    if (!text) return sendJson(res, 400, { error: 'text required' });
    const saved = await withFileLock(PROMPTS_FILE, async () => {
      const list = await readPrompts();
      const clean = {
        title: String((b.title || '') || text.split('\n')[0]).slice(0, 120),
        text: text.slice(0, 20000),
        tags: Array.isArray(b.tags) ? b.tags.map((t) => String(t).slice(0, 40)).slice(0, 12) : [],
        pinned: !!b.pinned,
        updatedAt: Date.now(),
      };
      let it = b.id ? list.find((x) => x.id === b.id) : null;
      if (it) Object.assign(it, clean);
      else { it = Object.assign({ id: crypto.randomUUID(), createdAt: Date.now() }, clean); list.unshift(it); }
      await writePrompts(list);
      return it;
    });
    return sendJson(res, 200, { ok: true, prompt: saved });
  },
  'POST /api/prompts/delete': async (req, res, url, p) => {
    const b = await readJsonBody(req);
    await withFileLock(PROMPTS_FILE, async () => { const list = await readPrompts(); await writePrompts(list.filter((x) => x.id !== (b && b.id))); });
    return sendJson(res, 200, { ok: true });
  },
  // ---- P-1: projects (start profile + label) — the logic is lib/projects.js, these only translate ----
  // A broken projects.json / session-projects.json answers 500 `store-corrupt` through the router's catch-all
  // and is NOT overwritten (lib/projects.js, the read rule). The stored `warnings` + `checkedAt` come from the
  // last save; this GET looks at no project path at all — a dead share must not stall the list (critic M2).
  'GET /api/projects': async (req, res, url, p) => {
    return sendJson(res, 200, { projects: await projectsLib.listProjects(await scanSessions()) });
  },
  // { project: {…} } — with `project.id` an update (merge), without one a create. 400 carries `errors`, the
  // token list of public/js/projects-core.js, so the editor can mark the field instead of showing a sentence;
  // 409 `conflict` carries the stored record (`project.baseUpdatedAt` was not the stored `updatedAt`).
  // The body is read with a SMALL ceiling: the largest legitimate record is ~15 KB (2000 characters of
  // instructions JSON-escaped, 8 paths), and the 5 MB default let one bad script call hand the validator a list
  // of 80 000 entries.
  'POST /api/projects': async (req, res, url, p) => {
    const b = await readJsonBody(req, PROJECTS_BODY_MAX);
    if (!b || typeof b.project !== 'object' || b.project === null || Array.isArray(b.project)) {
      return sendJson(res, 400, { ok: false, error: 'project required', errors: [{ field: '', code: 'type' }] });
    }
    // the configured MCP names, for the `mcp-unknown` warning — the config file, not `claude mcp list`
    const { status, ...out } = await projectsLib.upsertProject(b.project, { mcpNames: async () => (await configuredServers()).map((s) => s.name) });
    return sendJson(res, status, out);
  },
  'POST /api/projects/delete': async (req, res, url, p) => {
    const b = await readJsonBody(req, PROJECTS_BODY_MAX);
    const { status, ...out } = await projectsLib.deleteProject(b && b.id);
    return sendJson(res, status, out);
  },
  // { sessionIds: [uuid…≤500], projectId: 'p-…' | '' | null } — '' = deliberately without a project,
  // null = forget the decision. The key itself is required: a body without it is a 400, not a silent „forget".
  'POST /api/projects/assign': async (req, res, url, p) => {
    const b = await readJsonBody(req, PROJECTS_BODY_MAX);
    const pid = (b && Object.prototype.hasOwnProperty.call(b, 'projectId')) ? b.projectId : undefined;
    const { status, ...out } = await projectsLib.assignSessions(b && b.sessionIds, pid);
    return sendJson(res, status, out);
  },
  // P-2 cockpit: ?id= absent = every project + „nicht zugeordnet" (by cost, with suggestions); ?id=p-… = that
  // project + its plans, last state and suggestions. Costs over ALL sessions (not /api/usage's top 100), 30 days and
  // all-time from one pass, flagged `estimate: true`. Warm a read of the corpus cache, cold it waits for the fold —
  // the same contract as /api/uiskill/costs. 400 malformed id, 404 unknown, 500 store-corrupt (lib/projects.js).
  'GET /api/projects/overview': async (req, res, url, p) => {
    const id = url.searchParams.get('id');
    // P3 — ?days=7|30|90|0 (0 = „Gesamt", absent = 30); anything else 400 before a scan
    const days = projectsLib.overviewDays(url.searchParams.get('days'));
    if (days === null) return sendJson(res, 400, { ok: false, error: 'invalid days', errors: [{ field: 'days', code: 'invalid' }] });
    const { status, ...out } = await projectsLib.projectsOverview(id === null || id === '' ? null : id, { scanSessions: () => scanSessions({ signals: true }), scanUsage, listPlans, memoMs: 20000, days });
    return sendJson(res, status, out);
  },
  // P4 „Repos & PRs": the git state of the project's LOCAL folders (no fetch — the state of the last one) and the open
  // PRs of their GHE remotes under one 8-s deadline; the remote goes out as {host, owner, repo}, never as its URL. Memo
  // 30 s per id + updatedAt; `fresh=1` (the section's ↻) skips it. 400 malformed id, 404 unknown — lib/project-repos.js.
  'GET /api/projects/repos': async (req, res, url, p) => {
    const { status, ...out } = await projectRepos.projectRepos(url.searchParams.get('id'), {
      run, gheGet: github.gheGet, tokenPresent: github.tokenPresent, fresh: url.searchParams.get('fresh') === '1',
    });
    return sendJson(res, status, out);
  },
  // ---- A13: global prompt history (terminal + panel) ----
  // Filtered and capped SERVER-side: the two sources hold ~1700 prompts together, and shipping all of
  // them for a three-letter query is exactly the kind of thing that made the sessions list slow.
  // `sources` per row so the overlay can say where a prompt came from instead of implying one origin.
  'GET /api/prompt-history': async (req, res, url, p) => {
    let cliText = '';
    let cliError = '';
    try { cliText = await fsp.readFile(CLI_HISTORY_FILE, 'utf8'); }
    catch (e) { if (e && e.code !== 'ENOENT') cliError = errorText(e); }
    const cli = parseCliHistory(cliText);
    const panel = await readPromptHistory();
    const merged = mergeHistory(cli, panel, { q: url.searchParams.get('q') || '', limit: Number(url.searchParams.get('limit')) || 120 });
    return sendJson(res, 200, {
      ...merged,
      // An honest count per source: „nothing found" must be distinguishable from „the terminal history
      // could not be read", and a panel history of 0 explains itself (nothing sent from here yet).
      sources: { cli: cli.length, panel: panel.length },
      cliError,
    });
  },
  // Recorded by the composer at the same point the local ↑-history is fed (chat-composer pushHistory),
  // i.e. exactly when a HUMAN sent a prompt — quick replies, retries and UI-skill runs do not pass there.
  'POST /api/prompt-history': async (req, res, url, p) => {
    const b = await readJsonBody(req);
    const text = String((b && b.text) || '').trim();
    if (!text) return sendJson(res, 400, { error: 'text required' });
    const n = await withFileLock(PROMPT_HISTORY_FILE, async () => {
      const list = appendPanelPrompt(await readPromptHistory(), {
        text, ts: Date.now(),
        project: String((b && b.cwd) || ''),
        sessionId: String((b && b.sessionId) || ''),
        model: String((b && b.model) || ''),
      });
      await writePromptHistory(list);
      return list.length;
    });
    return sendJson(res, 200, { ok: true, entries: n });
  },
  // run history (append-only, capped). List supports ?name=<skill> and ?meta=1 (no transcripts —
  // the file can grow to megabytes; details come from GET /api/uiskill/runs/<id>).
  'GET /api/uiskill/runs': async (req, res, url, p) => {
    let runs = await readUiRuns();
    const name = url.searchParams.get('name');
    if (name) runs = runs.filter((r) => r.name === name);
    if (url.searchParams.get('meta') === '1') runs = runs.map((r) => { const slim = Object.assign({}, r); slim.hasTranscript = !!(slim.transcript && slim.transcript.length); delete slim.transcript; return slim; });
    return sendJson(res, 200, { runs });
  },
  // What a radar actually costs (A4) — a join of the run history against the per-session cost
  // aggregation, not a second measurement. `?days=30` narrows the window; `unpriced` counts the runs
  // whose session is no longer in the transcript corpus, so a gap is visible instead of read as 0 $.
  'GET /api/uiskill/costs': async (req, res, url, p) => {
    const days = Math.max(0, Math.min(365, Number(url.searchParams.get('days')) || 0));
    const since = days ? Date.now() - days * 86400000 : 0;
    const all = await readUiRuns();
    const runs = since ? all.filter((r) => (r.startedAt || 0) >= since) : all;
    // limit:0 = every session; the usage cache makes this a warm read after the first call
    const usage = await scanUsage(null, null, 0);
    const joined = joinRunCosts(runs, usage.bySession);
    return sendJson(res, 200, Object.assign({ days, runCount: runs.length }, joined));
  },
  // Panel data of a result card from a file (`expandSrc` in the ui-result block). The sync skill's
  // comparison panels are ~70 KB per run — too much to have the model type them out. Served only from
  // .json files inside a registered UI-skill run.cwd; trust model in lib/result-file.js.
  'GET /api/uiskill/result-file': async (req, res, url, p) => {
    const roots = resultFileRoots(await scanUiSkills());
    const rows = Math.max(0, Math.min(500, Number(url.searchParams.get('rows')) || 0));
    const r = await readExpandFile(url.searchParams.get('src') || '', roots, rows);
    if (r.error) return sendJson(res, r.status || 400, { error: r.error });
    return sendJson(res, 200, { expand: r.expand });
  },
  // writes are file-locked: parallel/batch runs + the headless engine finish concurrently and would
  // otherwise lose entries to read-modify-write interleaving
  'POST /api/uiskill/runs': async (req, res, url, p) => {
    const b = await readJsonBody(req);
    if (!b || !b.name) return sendJson(res, 400, { error: 'name required' });
    // a result that points at a panel file gets the file's content NOW — the file is overwritten by
    // the next run, the history entry must stay what this run saw
    const result = await resolveResultSrc(b.result, resultFileRoots(await scanUiSkills()));
    const entry = {
      id: crypto.randomUUID(),
      name: String(b.name).slice(0, 120),
      title: String(b.title || b.name).slice(0, 160),
      inputs: (b.inputs && typeof b.inputs === 'object') ? b.inputs : {},
      startedAt: b.startedAt || Date.now(),
      status: ['done', 'stopped', 'error', 'running'].includes(b.status) ? b.status : 'done',
      sessionId: b.sessionId || null,
      dryRun: !!b.dryRun,
      mode: b.mode === 'steps' ? 'steps' : 'single',
      durationMs: Number(b.durationMs) || 0,
      steps: Array.isArray(b.steps) ? b.steps.slice(0, 50) : [],
      result: uiResultSanitize(result),
      transcript: typeof b.transcript === 'string' ? b.transcript.slice(0, 40000) : '',
    };
    await withFileLock(UISKILL_RUNS_FILE, async () => { const runs = await readUiRuns(); runs.push(entry); await writeUiRuns(runs); });
    return sendJson(res, 200, { ok: true, id: entry.id });
  },
  // DATA-UI-3 — „Verlauf leeren" sits in ONE skill's history tab and used to truncate the whole file:
  // every skill's runs, every stored result, every transcript, with no copy anywhere. Two changes, both
  // here rather than in the dialog, because this route is what destroys the data and it is reachable
  // without the dialog (the panel has route tests for exactly that reason):
  //   · `name` limits the delete to that skill — what the button's position promises;
  //   · a backup of the file is written FIRST, always, so an accidental click is recoverable. It lands in
  //     BACKUP_DIR as `ui-skill-runs.json.<stamp>.bak` (lib/core backupFile), i.e. visible and
  //     downloadable in the Backups view — classifyBackup files it under `kind:'file'`, so it is not
  //     restorable by one click; the download is the way back.
  // No `name` = the old behaviour (everything), still available and still backed up.
  'POST /api/uiskill/runs/clear': async (req, res, url, p) => {
    // an empty body is `{}` (lib/core readJsonBody) — malformed JSON keeps its 400 instead of being
    // read as „no name", which would mean „delete everything" for a request nobody could parse
    const b = await readJsonBody(req);
    const name = (b && typeof b.name === 'string' && b.name) ? b.name : '';
    const r = await withFileLock(UISKILL_RUNS_FILE, async () => {
      const runs = await readUiRuns();
      const backup = runs.length ? await backupFile(UISKILL_RUNS_FILE) : null; // nothing stored → nothing to back up
      const next = name ? runs.filter((x) => x.name !== name) : [];
      await writeUiRuns(next);
      return { removed: runs.length - next.length, kept: next.length, backup };
    });
    return sendJson(res, 200, Object.assign({ ok: true, name: name || null }, r));
  },
  'POST /api/uiskill/runs/delete': async (req, res, url, p) => {
    const b = await readJsonBody(req);
    const removed = await withFileLock(UISKILL_RUNS_FILE, async () => {
      const runs = await readUiRuns();
      const next = runs.filter((r) => r.id !== b.id);
      await writeUiRuns(next);
      return runs.length - next.length;
    });
    return sendJson(res, 200, { ok: true, removed });
  },
  // ---- UI-skill schedules (headless engine) ----
  'GET /api/uiskill/schedules': async (req, res, url, p) => { return sendJson(res, 200, { schedules: await readSchedules() }); },
  'POST /api/uiskill/schedules': async (req, res, url, p) => {
    const b = await readJsonBody(req);
    if (!b || !b.name) return sendJson(res, 400, { error: 'name required' });
    const rawTiming = (b.timing && typeof b.timing === 'object') ? b.timing : { type: 'interval', minutes: 60 };
    // SCHED-1 — the two checks that make an unattended schedule a thing the user actually chose. Both in
    // the SERVER, because the dialog is not the only way in: this route has tests, the panel re-POSTs a
    // stored schedule to pause/resume it, and the engine reads the file, not the browser. A browser-only
    // check would leave the file's content unguarded.
    // SWITCHING OFF IS ALWAYS ALLOWED. Without that exception the guard would lock the door it exists to
    // open: a schedule stored BEFORE this check (seven days a week, or a missing required field) could no
    // longer be paused, only deleted.
    const wantsOff = b.enabled === false;
    const tn = normalizeScheduleTiming(rawTiming);
    if (tn.error && !wantsOff) return sendJson(res, 400, { error: 'invalid timing: ' + tn.error, code: 'bad-timing' });
    const timing = tn.timing || rawTiming;
    // the manifest is the only place the required fields are written down; a schedule for a skill that is
    // not installed here cannot be checked against one, and is left alone rather than guessed about
    const skill = (await scanUiSkills()).find((x) => x.name === b.name);
    const missing = skill ? missingRequiredInputs(skill.manifest, b.values) : [];
    if (missing.length && !wantsOff) return sendJson(res, 400, { error: 'required inputs missing: ' + missing.join(', '), code: 'missing-required', fields: missing });
    const now = Date.now();
    // A3: a dollar ceiling for the unattended run. 0 / absent = no cap (unchanged behaviour); the
    // upper bound is a guard against a typo turning "5" into "500" in a nightly schedule.
    const budget = Number(b.maxBudgetUsd);
    const maxBudgetUsd = (Number.isFinite(budget) && budget > 0) ? Math.min(budget, 100) : null;
    // G3: the schedule's stand-in model. Normalised to null here, so an empty field can never reach the
    // spawn as `--fallback-model ""`; the flag-shaped guard is argIdent's at the spawn (lib/chat.js),
    // which is also where a headless run and a ui-skill manifest pass through.
    // `b.fallbackModel ? …` and not `== null ? …`: a falsy NON-string from a client (false / 0) would
    // stringify to the literal "false"/"0" and be stored as a model id — see test/schedules.test.js.
    const fallbackModel = (b.fallbackModel ? String(b.fallbackModel).trim().slice(0, 200) : '') || null;
    // …and a flag-shaped value is refused HERE, not at the spawn. argIdent does catch it, but that throw
    // happens inside `runUiSkillHeadless` long after this route answered 200 — the result is a stored
    // schedule that fails every night with nothing in the history to say why. A 400 at the moment of
    // typing is the same deal `permissionMode` already gets a few dozen lines down.
    if (fallbackModel && /^-/.test(fallbackModel)) {
      return sendJson(res, 400, { error: 'invalid fallbackModel' });
    }
    // Ultracode for an unattended run — the opt-in half that was missing. The backend has always honoured
    // `schedule.ultracode === true` (lib/pure buildSpawnPolicy, which deliberately never inherits the
    // GLOBAL switch headless), and lib/engine forwards it; this route simply never stored the field, so the
    // switch could not be reached from anywhere. A literal true only: a schedule that fans one task into a
    // workflow of agents is not something a truthy string should be able to turn on.
    const ultracode = b.ultracode === true;
    // P3 — „Projekt (nur Etikett)": the run's session is LABELLED with this project (lib/engine.js, on the init frame)
    // and gets nothing else of it — buildSpawnPolicy never sees it, a headless run stays without instructions and
    // start values. null / absent = no label; a malformed or unknown id is a 400 — except when switching OFF (the
    // rule above): a schedule whose project was deleted since must stay pausable, and it pauses without the label.
    let projectId = null;
    if (b.projectId !== undefined && b.projectId !== null && b.projectId !== '') {
      if (await projectsLib.projectExists(b.projectId)) projectId = b.projectId;
      else if (!wantsOff) return sendJson(res, 400, { error: 'unknown project', code: 'project-unknown' });
    }
    const sc = await withFileLock(UISKILL_SCHEDULES_FILE, async () => {
      const list = await readSchedules();
      let s = b.id ? list.find((x) => x.id === b.id) : null;
      if (s) { Object.assign(s, { name: b.name, title: b.title || s.title, values: b.values || {}, timing, dryRun: !!b.dryRun, allowWrites: !!b.allowWrites, enabled: !!b.enabled, maxBudgetUsd, fallbackModel, ultracode, projectId }); s.nextRun = s.enabled ? computeNextRun(timing, now) : null; }
      else { s = { id: crypto.randomUUID(), name: b.name, title: b.title || b.name, values: b.values || {}, timing, dryRun: !!b.dryRun, allowWrites: !!b.allowWrites, enabled: !!b.enabled, maxBudgetUsd, fallbackModel, ultracode, projectId, createdAt: now, lastRun: null, lastStatus: null, nextRun: b.enabled ? computeNextRun(timing, now) : null }; list.push(s); }
      await writeSchedules(list);
      return s;
    });
    return sendJson(res, 200, { ok: true, schedule: sc });
  },
  'POST /api/uiskill/schedules/delete': async (req, res, url, p) => { const b = await readJsonBody(req); await withFileLock(UISKILL_SCHEDULES_FILE, async () => { const list = await readSchedules(); await writeSchedules(list.filter((x) => x.id !== (b && b.id))); }); return sendJson(res, 200, { ok: true }); },
  // Manual "jetzt ausführen". Honours the SAME concurrency ceiling as the 30s tick — without it a
  // few clicks spawn one unattended claude.exe per schedule with no ceiling at all.
  'POST /api/uiskill/schedules/run': async (req, res, url, p) => {
    const b = await readJsonBody(req);
    const list = await readSchedules();
    const sc = list.find((x) => x.id === (b && b.id));
    if (!sc) return sendJson(res, 404, { error: 'not found' });
    // B1/FLOW-6: refused, not queued — the click gets an answer it can show; the 30s tick DEFERS instead
    if (refuseWhileCliUpdating(res)) return;
    if (refuseWhileShuttingDown(res)) return;
    if (scheduleRunning(sc.id)) return sendJson(res, 409, { error: 'already running' });
    if (activeRunCount() >= MAX_CONCURRENT_RUNS) return sendJson(res, 429, { error: 'too many runs', active: activeRunCount(), max: MAX_CONCURRENT_RUNS });
    runScheduled(sc);
    return sendJson(res, 200, { ok: true });
  },
  'GET /api/uiskill/engine/runs': async (req, res, url, p) => { return sendJson(res, 200, { runs: [...engineRuns.values()].reverse() }); },

  // ---- Enterprise AI-tool spend (Spend-Limit-Manager — Claude Enterprise) ----
  // GET returns the cached snapshot instantly (no CDP); refresh fetches live via the logged-in
  // debug browser (CDP :9222, see lib/spend.js) and updates the cache.
  'GET /api/spend': async (req, res, url, p) => {
    const snap = await readSpendCache();
    snap.dashboardUrl = SPEND_URL; snap.debugCmd = DEBUG_BROWSER_CMD;
    return sendJson(res, 200, snap);
  },
  'POST /api/spend/refresh': async (req, res, url, p) => {
    try {
      const raw = await fetchSpendViaCdp();
      const data = sanitizeSpend(raw);
      if (!data) return sendJson(res, 502, { error: 'unexpected-payload', message: 'Dashboard-Antwort hatte nicht die erwartete Struktur' });
      const snap = { fetchedAt: Date.now(), data };
      await withFileLock(SPEND_CACHE_FILE, () => writeSpendCache(snap));
      return sendJson(res, 200, Object.assign({ dashboardUrl: SPEND_URL, debugCmd: DEBUG_BROWSER_CMD }, snap));
    } catch (e) {
      return sendJson(res, 502, { error: e.code || 'fetch-failed', message: errorText(e), dashboardUrl: SPEND_URL, debugCmd: DEBUG_BROWSER_CMD });
    }
  },

  // ---- Chat ----
  'POST /api/chat/start': async (req, res, url, p) => {
    const body = await readJsonBody(req);
    // B1/FLOW-6: answered before anything is written (MCP selection, temp MCP config) — startChat()
    // would refuse anyway, but only after this route had already done its side effects.
    if (refuseWhileCliUpdating(res)) return;
    if (refuseWhileShuttingDown(res)) return;
    // B2: `code` lets the client tell "binary gone" (e.g. a failed update left only claude.exe.old.*)
    // apart from any other 500 and point at the System view instead of a generic error.
    // N12: probePath, not existsSync — CLAUDE_EXE is the CONFIGURED binary, which may sit on a share, and the
    // sync lookup of a dead one held the whole server. A binary that does not answer says so instead of „not found".
    const exe = await probePath(CLAUDE_EXE);
    if (exe.state !== 'ok') {
      const gone = exe.state === 'unreachable';
      const secs = gone ? Math.ceil(exe.timeoutMs / 1000) : 0;
      return sendJson(res, 500, { error: (gone ? 'claude.exe not reachable (no answer in ' + secs + ' s) at ' : 'claude.exe not found at ') + CLAUDE_EXE, code: 'cli-missing', exe: CLAUDE_EXE, unreachable: gone, timeoutSec: secs || undefined, oldFiles: gone ? [] : await cliMod.listOldBinaries(CLAUDE_EXE) });
    }
    // A resume id names a stored Claude session — and it becomes the KEY this route writes into
    // session-mcp.json below, so it is validated first (see isValidSessionId): an unchecked body
    // value could name the property itself (`__proto__`, `constructor`, …) instead of a session.
    // `claude --resume` only accepts a session UUID either way, so nothing legitimate is lost.
    const resume = isValidSessionId(body.resume) ? body.resume : null;
    if (body.resume && !resume) return sendJson(res, 400, { error: 'invalid resume id' });
    // same allowlist as the live mode switch below — without it a client could start a session
    // in any string it likes (including bypassPermissions) with no validation at all.
    // P-0: answered BEFORE anything is written, like every other refusal of this route. It used to sit
    // after the MCP block below, so a 400 had already stored the very selection it refused to start with.
    if (body.permissionMode != null && !PERM_MODES.includes(body.permissionMode)) {
      return sendJson(res, 400, { error: 'invalid permissionMode' });
    }
    // J12 — the start path's own ceiling for --add-dir. Until now only the doors in front of it bounded the list
    // (projectStartValues cuts to 8, the tab editor offers no ninth), and every root is one more path measured
    // below and one more argv token. A client mistake is answered, not trimmed: a tab that sent nine roots and
    // started with eight would show a root the session cannot read. Before anything is written, like the 400s above.
    if (Array.isArray(body.addDirs) && body.addDirs.length > START_ADD_DIRS_MAX) {
      return sendJson(res, 400, { error: 'too many addDirs (max ' + START_ADD_DIRS_MAX + ')', code: 'too-many-adddirs', max: START_ADD_DIRS_MAX });
    }
    // N12 — the directories this chat will run in, asked BEFORE anything is written and before the owner check.
    // (J11's checkPaths further down measures the LOCAL paths again for the verdicts startChat reads; it skips
    // network paths by design, and those are the ones whose spawn froze the loop — so this probe covers them,
    // and its negative memory keeps a repeated click on a dead host from taking another threadpool slot.)
    // Windows resolves a process's cwd inside CreateProcessW, on this very thread: `spawn()` with the cwd
    // \\192.0.2.14\share held the event loop for 30 939 ms (measured), and a mapped drive on a dead share is
    // the same wait under a local-looking name that no shape test can see. Only an async stat sees both, so
    // it happens here, with a deadline, and a path that does not answer ends the start with the reason
    // instead of a frozen panel. startChat stays synchronous — the stretch between endResumeCollisions and
    // the spawn must stay free of awaits (test/start-invariant.test.js). The addDirs are asked too: they
    // reach no spawn of THIS process, but the CLI started in them would hang on its own, and a start that
    // takes 30 s to report a dead --add-dir is no better than one that says so now.
    const dead = await firstUnreachable([body.cwd].concat(Array.isArray(body.addDirs) ? body.addDirs.map((d) => String(d || '').trim()) : []));
    if (dead) {
      const secs = Math.ceil(dead.timeoutMs / 1000);
      return sendJson(res, 504, { error: 'path not reachable (no answer in ' + secs + ' s): ' + dead.path, code: 'path-unreachable', path: dead.path, timeoutSec: secs, remembered: dead.remembered });
    }
    // CHAT-FLOW-4 — a session another browser stream is attached to belongs to THAT browser (lib/chat.js
    // sessionHold says why the server decides this). Refusing is the DEFAULT, so no caller — restore,
    // reconnect, heal, a UI-skill follow-up — can resume over it by forgetting a flag; only the explicit
    // `takeover: true` of a user who confirmed it ends the other process. Asked HERE, before the MCP selection
    // is persisted and the temp config is built: a refused resume that carried mcpServers (every restart of a
    // tab sends its own) would otherwise have rewritten the stored scope of a session running in another
    // window. Asked again in the loop below, because the awaits in between can let a new owner in — there in
    // the same tick as the kill (lib/chat.js refuseIfHeld says why that has to be synchronous). That second
    // refusal comes AFTER the write below: two resumes that both pass this check while the route waits (two
    // windows right after a server restart) and carry DIFFERENT mcpServers can leave the loser's selection stored
    // for the winner's session. Not moved behind the spawn here, deliberately: main's P-0 (#93) reworked exactly
    // that block (the fork's scope is written after the spawn there) — the move belongs to the merge with it.
    // A fork is exempt for the reason the loop gives: it writes its own transcript and ends nobody.
    const takeover = body.takeover === true;
    if (resume && !body.fork && !takeover) await refuseIfOpenElsewhere(resume);
    // the Claude session id this process runs as (key for the per-session MCP scope)
    const sessionId = resume || crypto.randomUUID();
    // J1/J3 — the session's project: a fresh start's body.projectId ('p-…' | '' | absent), a fork's inherited
    // label, a resume's label (lib/projects.js resolveStartFrom). Behind the owner check; a 400 writes nothing.
    const proj = await projectsLib.resolveStart(body, resume);
    if (proj.error) return sendJson(res, 400, { error: proj.error, code: proj.code });
    // P2 — the project's linked memory files, as absolute paths of the files that exist NOW (a deleted one is simply
    // not named). Before the resume loop like every await of this route (start-invariant); never refuses a start.
    const projMemory = proj.project ? await projectsLib.memoryRefs(proj.project) : [];
    // J11 — cwd and every --add-dir measured HERE, off the event loop and with a deadline, and handed to the
    // synchronous startChat (opts.pathCheck): a dead drive under a local letter froze the whole panel there.
    // Before the resume loop (start-invariant). An unmeasured cwd is refused — spawning in it would block in
    // CreateProcess the way the stat did. Keys as startChat reads them: cwd as sent, --add-dir trimmed.
    const addDirsIn = Array.isArray(body.addDirs) ? body.addDirs.map((d) => String(d || '').trim()) : [];
    const pathCheck = await projectsLib.checkPaths([body.cwd, ...addDirsIn]);
    // asked again AFTER the new awaits (rails b): an owner may have attached, or the page left, while they ran
    if (resume && !body.fork && !takeover) refuseIfHeld(resume);
    if (res.destroyed || req.socket.destroyed) throw clientGoneError();
    if (typeof body.cwd === 'string' && pathCheck[body.cwd] === 'unchecked') {
      return sendJson(res, 503, { error: 'cwd not reachable in time: ' + body.cwd, code: 'cwd-unchecked' });
    }
    // resolve MCP scope: an explicit client choice wins (and is persisted to the session); a plain resume
    // inherits the session's stored choice. undefined / null / all-selected → all servers (no scoping).
    // SEC-5 — ROBUSTNESS, not a hole, and it is worth saying which. Nothing here escalates a privilege:
    // every name is looked up in the user's OWN config, an unknown one is dropped, and the file this
    // builds is the NARROWING `--strict-mcp-config` (lib/mcp buildMcpConfigFile). What was missing is a
    // bound: the array was taken as-is, and for every name that ~/.claude.json does not know,
    // buildMcpConfigFile falls back to `claude mcp get <name>` — a spawn with a 25 s timeout, SERIALLY.
    // So an array of 200 names was ~83 minutes of CLI spawns on one request, and the list was persisted
    // into session-mcp.json unbounded on top.
    //
    // Three cheap properties instead: the SHAPE every other MCP route already requires (`/^[\w.-]+$/`),
    // de-duplication (the same name twice meant the same lookup twice), and a ceiling.
    //   The shape alone is NOT enough, and that was measured rather than assumed: `__proto__` matches
    // `/^[\w.-]+$/` (`\w` covers `_`), and buildMcpConfigFile fills a plain `{}` with `mcpServers[name] =
    // entry` — for `__proto__` that assignment sets the object's PROTOTYPE instead of an entry, so the
    // server silently vanishes from the generated config and the session runs with a scope nobody chose.
    // Hence the explicit name rejection next to the shape. (The same shape guards every other MCP route
    // in this file; none of them indexes an object with the name, which is why this is the only one.)
    // The ceiling is 64. MEASURED against this machine's 9 configured servers (~/.claude.json, 2026-10-03)
    // — roughly seven times the real set, so no legitimate selection can hit it, including the project
    // `.mcp.json` servers this route deliberately cannot enumerate (that is exactly why the names are NOT
    // intersected with configuredServers(): that would break the `.mcp.json` case the CLI fallback exists
    // for). What it bounds is the worst case: 64 × 25 s instead of unbounded.
    const MCP_SEL_MAX = 64;
    const MCP_NAME_FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
    const mcpNameOk = (n) => typeof n === 'string' && /^[\w.-]+$/.test(n) && !MCP_NAME_FORBIDDEN.has(n);
    let sel; const explicit = (body.mcpServers !== undefined);
    if (explicit) {
      sel = Array.isArray(body.mcpServers) ? body.mcpServers : null;
      // A CLIENT mistake is answered, not silently repaired — otherwise the tab believes it started
      // with a scope it did not get.
      if (Array.isArray(sel)) {
        if (sel.length > MCP_SEL_MAX) return sendJson(res, 400, { error: 'too many mcpServers (max ' + MCP_SEL_MAX + ')' });
        if (!sel.every(mcpNameOk)) return sendJson(res, 400, { error: 'invalid mcpServers name' });
        sel = [...new Set(sel)];
      }
    } else if (resume) {
      // A STORED selection is filtered instead: it was written by this route in an older version, and a
      // 400 here would make a resumable session unresumable for a name nobody can correct from the UI.
      const st = await readMcpSel(); const stored = st[resume];
      sel = Array.isArray(stored) ? [...new Set(stored.filter(mcpNameOk))].slice(0, MCP_SEL_MAX) : stored;
    }
    // P-0 — a FORK runs under an id that does not exist yet: `sessionId` is the SOURCE id here (see above),
    // so writing the fork's choice under it rewrote the scope of the tab being duplicated — and an explicit
    // „all" (null) deleted it. The fork's scope is stored under the fork's own id instead, once the CLI has
    // reported it (the hook after startChat below).
    const forking = !!(resume && body.fork);
    // A refused start writes nothing: the awaits below (and the owner check in the resume loop) can still refuse it,
    // so the previous entry is kept and put back by undoMcpSel — unless someone else has written the entry since.
    let mcpUndo = null;
    if (explicit && !forking) {
      await withFileLock(MCP_SEL_FILE, async () => {
        const st = await readMcpSel();
        mcpUndo = { had: Object.prototype.hasOwnProperty.call(st, sessionId), prev: st[sessionId], wrote: Array.isArray(sel) ? sel : undefined };
        if (Array.isArray(sel)) st[sessionId] = sel; else delete st[sessionId];
        mcpUndo.gen = bumpMcpSelGen(sessionId);
        await writeMcpSel(st);
      });
    }
    const undoMcpSel = async () => {
      const u = mcpUndo; mcpUndo = null;
      if (!u) return;
      await withFileLock(MCP_SEL_FILE, async () => {
        const st = await readMcpSel();
        // only while the last write is still ours — another window may have written the very same selection since
        if (MCP_SEL_GEN.get(sessionId) !== u.gen || JSON.stringify(st[sessionId]) !== JSON.stringify(u.wrote)) return;
        if (u.had) st[sessionId] = u.prev; else delete st[sessionId];
        bumpMcpSelGen(sessionId);
        await writeMcpSel(st);
      }).catch((e) => { try { console.error('[chat/start] MCP selection not restored for ' + sessionId + ': ' + errorText(e)); } catch { /* */ } });
    };
    let mcpConfigPath = null;
    if (Array.isArray(sel)) { try { mcpConfigPath = await buildMcpConfigFile(sel); } catch (e) { await undoMcpSel(); return sendJson(res, 500, { error: 'MCP-Config konnte nicht erstellt werden: ' + errorText(e) }); } }
    // D1/D2/D4 + #34 + ultracode — what the session inherits from the panel's settings: the appended
    // prompt (style, global + tab guardrails, newest corrections, open-points protocol), the subagent
    // policy, ultracode, the MCP wait and the two opt-in stream widenings (hook lifecycle; the text of
    // FOREGROUND subagents, the only place their work exists at all). ONE function decides it for this
    // route AND for lib/engine's headless runs, which get a deliberately narrower set — see
    // lib/pure.js buildSpawnPolicy.
    // `snapshotFlag` (PR-S): the installed CLI's --help lists --system-prompt-snapshot — cached per binary in
    // lib/cli, so this await costs nothing after the boot pre-warm. Without that proof the flag is left out.
    const prefs = await readPrefs();
    const policy = buildSpawnPolicy(prefs, await readCorrections(), { mode: 'chat', body, project: proj.project, projectMemory: projMemory, snapshotFlag: await cliMod.cliFlagSupported(cliMod.PROMPT_SNAPSHOT_FLAG) });
    // J1 — a fresh start's label is written NOW, before the process exists (critic H5: a restart in between must
    // not lose it), '' included. Last await before the try, so every refusal above has written nothing; a start
    // refused inside the try takes it back (catch below). P3: a UI-skill run's `labelProjectId` is recorded the same way —
    // the label only, `proj.project` stays null (no instructions, no start values; lib/projects.js resolveStartFrom).
    const recordPid = proj.pid !== null ? proj.pid : (proj.labelPid || null);
    const fresh = !resume && recordPid !== null
      ? await projectsLib.recordFreshStart(sessionId, recordPid).catch((e) => ({ recorded: false, error: errorText(e) }))
      : { recorded: false };
    let chat;
    try {
      // #1/#17: a resume spawns only once every process still attached to that transcript is GONE —
      // including one the stop route just asked to end gracefully (the client's stop → start {resume}),
      // which is no longer in `chats`. startChat's own guard is synchronous and cannot wait for that.
      // Checked first: an update or a shutdown that began during the awaits above would otherwise get
      // the old session killed and then the new one refused. Looped, because a second resume of the
      // same session can spawn while this one waits; each round is bounded by killTree's KILL_TREE_WAIT_MS.
      // A FORK is exempt (as in startChat's backstop): `--fork-session` writes its own transcript, so
      // there is no second writer to wait for — and waiting would kill the source tab's process and
      // block "Duplizieren" for the length of a taskkill (~3 s).
      // CHAT-FLOW-4: each round asks the owner question again, synchronously, in the same tick as the kill, so
      // no other resume can spawn between the verdict and the kill. And once more after the loop: when all three
      // rounds awaited a kill, the last verdict is as old as that wait — without it, startChat's backstop would
      // end whatever spawned in the meantime, an attached owner included, unasked. Still synchronous, so the
      // stretch from the loop's end to the spawn stays free of awaits (start-invariant).
      // Last, the page that asked may be GONE: a reload while its own restart (stop → start {resume}) still waits
      // for the kill here. Spawning anyway made a process no browser would ever attach to — and its claim window
      // then refused the reloaded page's resume of the same session (409 starting:true) while the orphan ran
      // until the reaper. Asked of EVERY start (a fresh one whose page left would be just as orphaned), synchronously
      // too, and as late as it can be: right before the spawn.
      if (resume && !body.fork) {
        if (cliMod.isCliUpdating()) throw cliMod.cliUpdatingError();
        if (SHUTTING_DOWN) throw shuttingDownError();
        for (let i = 0; i < 3; i++) { if (!takeover) refuseIfHeld(resume); const gone = endResumeCollisions(resume); if (!gone) break; await gone; }
        if (!takeover) refuseIfHeld(resume);
      }
      if (SHUTTING_DOWN) throw shuttingDownError(); // began during an await: shutdown's sweep is past us
      if (res.destroyed || req.socket.destroyed) throw clientGoneError();
      chat = startChat({
        ...policy,
        cwd: body.cwd,
        model: body.model,
        // G3 — the stand-in model, a LAUNCH property like the model itself (the CLI has no live switch for
        // it). Per-run, never a global pref: see the reasoning at the flag in lib/chat.js. It sits HERE and
        // not in buildSpawnPolicy because that function carries only what the panel's SETTINGS decide; this
        // one comes from the start body alone, which is also why the headless path reads it off the schedule.
        fallbackModel: body.fallbackModel,
        permissionMode: body.permissionMode,
        effort: body.effort,
        maxBudgetUsd: body.maxBudgetUsd,
        addDirs: body.addDirs,
        // C2/C3 — session agent and git worktree. Both are LAUNCH properties (the CLI has no live
        // switch for either), so they travel with the start the way cwd and addDirs do.
        agent: body.agent,
        worktree: body.worktree,
        name: body.name,
        promptSuggestions: !!body.promptSuggestions,
        resume,
        fork: body.fork,
        sessionId,
        mcpConfigPath,
        pathCheck,
      });
    } catch (e) {
      // a refused start (e.g. 503 cli-updating: the update began during the awaits above) owns no
      // process that would clean the temp MCP config up on exit — do it here, then let the router answer
      if (mcpConfigPath) fs.promises.unlink(mcpConfigPath).catch(() => {});
      if (fresh.recorded) projectsLib.forgetSession(sessionId).catch(() => {}); // no session, no label
      await undoMcpSel(); // after the spawn failed — no await between the loop and startChat (start-invariant)
      throw e;
    }
    // P-0 — the fork's MCP scope under the fork's OWN id. That id exists only once the CLI reports it on a
    // stream frame (lib/chat.js chat.onSessionId), so the scope the fork was LAUNCHED with — the explicit
    // choice, or the source's stored one it inherited above — is written then. Without it the fork's first
    // restart (a plain resume of the new id, nothing stored under it) ran with EVERY server.
    // Set here, after the try and with no await since startChat returned: readline delivers the first line on
    // a later tick at the earliest, so no frame can slip past — and the immediate call keeps that true should
    // an await ever be added in between. Not awaited and never failing the start: the process already runs
    // with the right set, a lost write costs the next restart, and it is logged. Only an array is stored
    // (no entry already means „all servers"), and never under the source id: that is the bug this replaces.
    const hooks = [];
    if (forking && Array.isArray(sel)) {
      const forkSel = sel.slice();
      const storeForkScope = (id) => {
        if (!isValidSessionId(id) || id.toLowerCase() === resume.toLowerCase()) return;
        withFileLock(MCP_SEL_FILE, async () => { const st = await readMcpSel(); st[id] = forkSel; bumpMcpSelGen(id); await writeMcpSel(st); })
          .catch((e) => { try { console.error('[chat/start] fork MCP scope not stored for ' + id + ': ' + errorText(e)); } catch { /* */ } });
      };
      hooks.push(storeForkScope);
    }
    // J1/J3 — the project label under a NEW id (a fork, or the id after /clear), next to — never instead of — the
    // fork's MCP scope: one property, so the hooks are COMPOSED (each guarded, one failing costs not the other).
    // recordPid, not proj.pid: a UI-skill run's LABEL (labelProjectId) must follow its session to the id after /clear
    // as a projectId does — otherwise the label stays on the old id and the run's later cost counts as „nicht zugeordnet“
    const projHook = projectsLib.sessionIdHook({ pid: recordPid, resume, sessionId });
    if (projHook) hooks.push(projHook);
    if (hooks.length) {
      chat.onSessionId = (id, info) => { for (const h of hooks) { try { h(id, info); } catch { /* logged by the hook */ } } };
      if (chat.sessionId) chat.onSessionId(chat.sessionId);
    }
    const p0 = proj.project;
    // a sibling of meta (chat.meta stays the launch facts): what the session runs with, for the tab to show
    return sendJson(res, 200, { chatId: chat.id, meta: chat.meta, project: p0 ? { id: p0.id, updatedAt: p0.updatedAt, name: p0.name } : null, ...(proj.storeError ? { projectError: proj.storeError } : {}) });
  },
  // stored per-session MCP scope (for the tab context-menu picker to pre-check boxes)
  'GET /api/session/mcp': async (req, res, url, p) => {
    const id = (url.searchParams.get('id') || '').trim();
    const st = await readMcpSel();
    return sendJson(res, 200, { selection: (id && Array.isArray(st[id])) ? st[id] : null });
  },
  // CHAT-FLOW-4 — is session `id` held by another browser right now, and is a turn open there? The SAME
  // sessionHold the start route refuses with, read without starting anything: the browser asks this when the
  // user clicks [Hier übernehmen] / [Zurückholen], so the confirm can warn about a running turn as it is NOW
  // (the 409 that produced the card may be minutes old) — and a [Erneut prüfen] does not have to tear the
  // tab's transcript down just to learn the answer.
  'GET /api/session/open': async (req, res, url, p) => {
    const id = (url.searchParams.get('id') || '').trim();
    if (!isValidSessionId(id)) return sendJson(res, 400, { error: 'invalid session id' });
    return sendJson(res, 200, sessionHold(id));
  },

};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;
  // No framing, by anyone — set here, before any branch, because the 403 guards below, the SSE stream
  // and the static handler all answer through writeHead directly and would each have to remember it.
  // (The sandboxed srcdoc preview in render.js is not served from here and is unaffected.)
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  // localhost-only guard: block DNS-rebinding (foreign Host header) and cross-site
  // requests / CSRF (foreign Origin). The server spawns processes + writes files, so a
  // page the user merely visits must not be able to drive it.
  // Fails CLOSED: an ABSENT Host header used to skip the check entirely, so the one guard against a
  // foreign name resolving to 127.0.0.1 could be turned off by leaving the header out. Host is
  // mandatory in HTTP/1.1 and every browser, curl and node client sends it, so nothing legitimate
  // loses its access — only a hand-built request that omits it.
  const hostHdr = (req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(hostHdr)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('forbidden: host'); }
  const origin = req.headers.origin;
  if (origin && !isOwnOrigin(origin)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('forbidden: origin'); }
  // The Origin check above only fires when an Origin header IS there — that is the whole CSRF defence for
  // a state-changing request, and "absent" passes it. Browsers do send Origin on cross-origin POSTs, so
  // add the second signal they also send and that cannot be absent-by-omission: Sec-Fetch-Site. Only
  // METHODS THAT CHANGE STATE are judged by it — a cross-site GET navigation (a link to the panel from a
  // wiki page or a chat message) keeps working, it just cannot POST. Clients that send no Sec-Fetch-Site
  // at all (node, curl, the smoke test) are unaffected: this narrows nothing that Origin already allows.
  // "Cross-site" here means cross-site AND not one of the panel's own origins: localhost and 127.0.0.1
  // are different sites to a browser, and the panel answers on both.
  const fetchSite = req.headers['sec-fetch-site'];
  const xSite = !isOwnOrigin(origin) && !!fetchSite && !['same-origin', 'none'].includes(String(fetchSite).toLowerCase());
  if (xSite && req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('forbidden: cross-site');
  }
  // Cross-site requests never reach the API — not even a GET, not even a top-level navigation. Several
  // GET routes DO something instead of just reading (/api/mcp/check spawns every configured MCP server,
  // /api/doctor and /api/auth run the CLI, /api/diff?cwd= runs git, on a UNC path too). A foreign page
  // cannot READ the answer, but the side effect is the attack. The earlier rule still let a top-level
  // navigation through, which a page triggers with a plain link or `location =`. Nothing legitimate links
  // into /api/ from outside; the cross-site link to the panel ITSELF (/, a wiki page, a chat message)
  // keeps working, it is not under /api/.
  if (xSite && p.startsWith('/api/')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('forbidden: cross-site');
  }
  // A browser that IS on the panel's origin still has to prove it is the panel's own script: every
  // state-changing /api call carries X-CCUI (the window.fetch wrapper in public/js/api-token.js now adds
  // it for every /api/ call, so the raw fetches carry it too). A custom header forces a CORS preflight
  // that this server never answers, so no other page can send it — and that holds even where
  // Origin/Sec-Fetch-Site are missing or spoofable by an extension or an old browser.
  // "Browser" = it sends Origin or any Sec-Fetch-* header. Node, curl and the tests send neither, so THIS
  // guard never judges them — they are stopped one block further down, by the token, which is the guard
  // that was missing when this one was written.
  const isBrowser = !!origin || Object.keys(req.headers).some((h) => h.startsWith('sec-fetch-'));
  if (isBrowser && req.method !== 'GET' && req.method !== 'HEAD' && p.startsWith('/api/') && req.headers['x-ccui'] !== '1') {
    res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('forbidden: missing X-CCUI');
  }
  // …and two GETs are held to the same proof, because they are not reads of the panel's own state: they
  // ACT on a directory the caller names. /api/diff spawns five git processes in it and hands back up to
  // 200 000 characters of patch text, /api/files walks it (alert #5, CWE-200). Cross-site they are
  // already 403 by the rule above — but only for a browser that SENDS Sec-Fetch-Site; one that does not
  // (an old engine, a stripping extension) still reached them, and X-CCUI cannot be added from a foreign
  // page at all. render.js api() sends the header on every call including GETs, so the panel is
  // unaffected. The headerless clients (node, curl, the smoke test) are not judged HERE — the token gate
  // below is what they have to satisfy.
  if (isBrowser && GET_NEEDS_CCUI.has(p) && req.headers['x-ccui'] !== '1') {
    res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('forbidden: missing X-CCUI');
  }
  // N9 — and now the one guard that does not care what kind of client this is: the token (see API_TOKEN
  // above for what is gated and why only `/api/`). Last of the five on purpose, so a cross-site probe
  // still gets its honest „forbidden: cross-site" instead of a 401 that would tell it the panel has a
  // token worth guessing.
  if (API_TOKEN && p.startsWith('/api/')) {
    const given = req.headers['x-ccui-token'] || url.searchParams.get('t') || '';
    if (!apiTokenEquals(given, API_TOKEN)) return sendTokenRequired(res);
  }
  try {
    // ---- API ----
    // Exact route first (the table), then the two shapes a table cannot express: the /api/uiskill/runs/
    // prefix and the /api/chat/<uuid>/<action> family. Order is preserved where it matters — the exact
    // POST routes /api/uiskill/runs/clear|delete never reached the GET-only prefix branch either.
    const handler = ROUTES[req.method + ' ' + p];
    if (handler) {
      await handler(req, res, url, p);
      // A route that returns without answering used to fall through to the static handler and leave an
      // API caller with 404 text/plain (or, worse, a hanging request). Say it out loud instead, naming
      // the route: this is a bug in the handler, not a missing endpoint.
      if (!res.headersSent) return sendJson(res, 500, { error: 'route did not answer: ' + req.method + ' ' + p });
      return;
    }

    if (p.startsWith('/api/uiskill/runs/') && req.method === 'GET') {
      const id = decodeURIComponent(p.slice('/api/uiskill/runs/'.length));
      const one = (await readUiRuns()).find((r) => r.id === id);
      if (!one) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, { run: one });
    }

    const chatMatch = p.match(/^\/api\/chat\/([0-9a-f-]{36})\/(stream|send|permission|interrupt|mode|effort|model|ultracode|settings|context|hooks|reload-skills|stop|mcp-status|mcp-toggle|mcp-reconnect|stop-task)$/);
    if (chatMatch) {
      const chat = chats.get(chatMatch[1]);
      const action = chatMatch[2];
      if (!chat) return sendJson(res, 404, { error: 'chat not found' });

      if (action === 'stream' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 2000\n\n');
        // ONE keepalive timer per CHAT, not per client: three tabs on the same chat used to arm three
        // 20s intervals writing the same ping. Started with the first client, stopped with the last.
        const startPing = () => {
          if (chat._pingTimer) return;
          chat._pingTimer = setInterval(() => {
            if (!chat.clients.size) { clearInterval(chat._pingTimer); chat._pingTimer = null; return; }
            for (const c of chat.clients) { try { c.write(': ping\n\n'); } catch { /* client gone */ } }
          }, 20000);
          if (chat._pingTimer.unref) chat._pingTimer.unref();
        };
        // Replay only events the client hasn't seen (Last-Event-ID); frames are pre-serialised.
        // On a first connect (no header) this replays the WHOLE buffer — up to SSE_BUFFER_CAP (5000)
        // frames. The old tight write() loop ignored the socket's high-water mark, so node queued the
        // entire backlog in memory for a slow/paused client. Write until the stream says stop, resume
        // on 'drain', and bail out if the socket died mid-replay. The client only becomes a live
        // broadcast target once it has caught up, so frames can't arrive out of order.
        // `?from=<seq>` is the same contract for a DELIBERATE re-attach: the browser's EventSource sends
        // Last-Event-ID only on its OWN auto-reconnect and cannot set headers, so a client that closed the
        // stream itself (UI-skill run: the finish closes it, a follow-up turn re-opens it) had no way to say
        // "I have seen up to N" — and got the whole finished turn replayed into its live handler.
        let sent = parseInt(req.headers['last-event-id'] || url.searchParams.get('from') || '0', 10) || 0;
        const pump = () => {
          if (res.writableEnded || res.destroyed) return;
          for (const b of chat.buffer) { // ascending seq; may have grown/been trimmed since the last drain
            if (b.seq <= sent) continue;
            res.write(b.frame); sent = b.seq;
            if (res.writableNeedDrain) { res.once('drain', pump); return; }
          }
          // `_everAttached` ends the chat's claim window (CHAT-FLOW-4, lib/chat.js holdsSession): from here on it
          // owns its session only while a stream is actually attached.
          if (!chat.clients.has(res)) { chat.clients.add(res); chat._everAttached = true; startPing(); }
        };
        pump();
        req.on('close', () => {
          chat.clients.delete(res);
          if (!chat.clients.size && chat._pingTimer) { clearInterval(chat._pingTimer); chat._pingTimer = null; }
        });
        return;
      }
      if (action === 'send' && req.method === 'POST') {
        const body = await readJsonBody(req, 32 * 1024 * 1024);
        if (!chat.alive) return sendJson(res, 409, { error: 'process not running' });
        const hasText = body.text && body.text.trim();
        const hasAtt = Array.isArray(body.attachments) && body.attachments.length;
        if (!hasText && !hasAtt) return sendJson(res, 400, { error: 'text or attachment required' });
        // PR-13 — a tripped brake stays on for the life of this process (lib/budget.js). A message sent now
        // would start a turn the next poll interrupts at once; saying so here is the honest answer, and the
        // way out is a NEW budget, which is a launch flag (tab menu → restart).
        if (chat.budget && chat.budget.tripped) {
          return sendJson(res, 409, { error: 'budget-reached', spentUsd: chat.budget.spentUsd, limitUsd: chat.budget.limitUsd });
        }
        sendToChat(chat, body.text || '', body.attachments);
        return sendJson(res, 200, { ok: true });
      }
      if (action === 'permission' && req.method === 'POST') {
        const body = await readJsonBody(req);
        respondPermission(chat, body.requestId, body.behavior, body.updatedInput, body.message, body.updatedPermissions);
        return sendJson(res, 200, { ok: true });
      }
      if (action === 'interrupt' && req.method === 'POST') {
        interruptChat(chat);
        return sendJson(res, 200, { ok: true });
      }
      if (action === 'mode' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const mode = String(body.mode || '');
        if (!PERM_MODES.includes(mode)) return sendJson(res, 400, { error: 'invalid mode' });
        if (!chat.alive) return sendJson(res, 409, { error: 'process not running' });
        // FLOW-3: the answer is the CLI's verdict, not "stdin accepted the bytes". A refusal
        // (bypass_restricted / bypass_disabled / bypass_not_launched / invalid_mode …) reaches the user in
        // the CLI's own words, and `mode` is what the SESSION reported — it may differ from the request.
        // 409, like the model and effort switches: the request was understood and declined.
        const r = await setChatMode(chat, mode);
        if (!r.ok) return sendJson(res, 409, { error: r.error || 'mode rejected', requested: mode });
        return sendJson(res, 200, { ok: true, mode: r.mode, requested: mode, unconfirmed: !!r.unconfirmed });
      }
      // The reasoning effort of the running session. Validated against lib/chat's EFFORT_LEVELS, the SAME
      // list the spawn uses, instead of a hand-written copy here — that copy was missing `max`, which the
      // CLI has accepted live all along, so the one level people reach for on a hard problem was answered
      // with 400 and detoured through a session restart. '' is accepted and means „auto" = no explicit
      // level, which travels as `effortLevel: null`.
      if (action === 'effort' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const effort = String(body.effort || '');
        if (effort && !EFFORT_LEVELS.includes(effort)) return sendJson(res, 400, { error: 'invalid effort' });
        if (!chat.alive) return sendJson(res, 409, { error: 'process not running' });
        // The ultracode WISH travels with the level in one apply_flag_settings, or the CLI turns ultracode
        // off behind the user's back (see lib/chat setChatEffort for the decoded rule). An absent body
        // field means „re-assert whatever this session's wish is", so a stale tab cannot drop it.
        const wish = (body.ultracode === true || body.ultracode === false) ? body.ultracode : undefined;
        const r = await setChatEffort(chat, effort, wish);
        // A refusal that is about ULTRACODE must not fail the effort part: the stdio handler does not
        // refuse an unavailable ultracode today (only the Remote-Control one does), but if a future CLI
        // adopted that, an effort change would start failing for a reason that has nothing to do with it.
        // `refused`, NOT `unconfirmed`: somebody answered, and what they said was „no". Calling that
        // „unconfirmed" told the client the opposite of what happened. What IS unknown here is the
        // resulting state — nothing was read back — and ultracodeStateFor(null) now says exactly that
        // ('unknown'), which is what the client keys on to leave its own values alone.
        if (!r.ok && /ultracode/i.test(String(r.error || ''))) return sendJson(res, 200, { ok: true, refused: true, requested: effort, ultracodeError: String(r.error), ...ultracodeStateFor(null, chat) });
        if (!r.ok) return sendJson(res, 409, { error: r.error || 'effort rejected' });
        // The answer is the session's own read-out, not an echo of the request: over stdio an unknown
        // level (and '') is a silent success, so the request can never report its own failure. `effort`
        // therefore comes from get_settings — null = auto — and `unconfirmed` says when nobody answered
        // and there is consequently nothing to believe. The ultracode state rides along so the browser's
        // chip is corrected by the very response that changed the effort.
        return sendJson(res, 200, { ok: true, unconfirmed: !!r.unconfirmed, requested: effort, ...ultracodeStateFor(r.applied, chat) });
      }
      if (action === 'model' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const model = String(body.model || ''); // '' = back to the session default (set_model null)
        if (!chat.alive) return sendJson(res, 409, { error: 'process not running' });
        // The CLI validates the id and refuses a forbidden or unknown one. setChatModel now WAITS for
        // that answer, so a refusal reaches the user in the CLI's own words ("restricted by your
        // organization's settings…") instead of a green "switched live" toast over an unchanged session.
        const r = await setChatModel(chat, model);
        if (!r.ok) return sendJson(res, 409, { error: r.error || 'model rejected' });
        return sendJson(res, 200, { ok: true, model, unconfirmed: !!r.unconfirmed });
      }
      // Ultracode on/off on the running session. Answers with the state that is REALLY in effect, not
      // with the wish: the CLI accepts `ultracode:true` even on a model that cannot do it (measured on
      // Haiku 4.5), so setChatUltracode re-reads get_settings and this route passes THAT on.
      if (action === 'ultracode' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const on = body.on === true;
        if (!chat.alive) return sendJson(res, 409, { error: 'process not running' });
        const r = await setChatUltracode(chat, on);
        if (!r.ok) return sendJson(res, 409, { error: r.error || 'ultracode rejected' });
        // `unconfirmed` = there was no read-back at all (a control request that timed out still resolves
        // „success"), so the client knows the state here is the optimistic one and the `effort: null` beside
        // it means „unknown" rather than „auto".
        return sendJson(res, 200, { ok: true, requested: on, unconfirmed: !!r.unconfirmed || !r.applied, ...ultracodeStateFor(r.applied, chat) });
      }
      // What the session says about its own runtime settings (model, effort, ultracode). The panel asks
      // once when `init` arrives — that is the first moment the truth about ultracode exists.
      if (action === 'settings' && req.method === 'GET') {
        if (!chat.alive) return sendJson(res, 409, { error: 'process not running' });
        const r = await getChatSettings(chat);
        if (!r.ok) return sendJson(res, 409, { error: r.error || 'no answer' });
        // TWO facts travel here, and neither replaces the other — they answer different questions.
        // `unconfirmed`: a control request that TIMES OUT still resolves „ok" (so a future CLI that stops
        // answering does not produce a wall of false errors), which arrives here as `applied: null`. Said
        // out loud, because the client has to be able to tell „the session is on no explicit level" from
        // „nobody answered".
        // `model`: the RUNTIME-resolved model, i.e. the one the session is really on. The panel needs it
        // after a REFUSED model switch — the CLI substitutes a model and names it in the refusal, and when
        // that sentence cannot be parsed, asking the session is the honest answer instead of guessing
        // (public/js/chat.js applyLiveModel).
        return sendJson(res, 200, { ok: true, unconfirmed: !r.applied, model: (r.applied && r.applied.model) || '', ...ultracodeStateFor(r.applied, chat) });
      }
      // How full this session's context is, as the CLI itself reports it right now (lib/chat
      // getChatContext → `get_context_usage`). The context line used to be painted from frame
      // arithmetic that only a `result` refreshed, so a long turn showed a stale number against the
      // window of the model from BEFORE a live switch („Kontext 250 % · 500,8K / 200,0K"). This is the
      // fresh value, and the answer goes to THIS caller only — never over SSE: it is one browser's
      // gauge asking, not an event every tab needs, and pushing an 8 KB-derived payload into every open
      // stream once per tab per turn boundary is exactly the noise the replay buffer does not need.
      //
      // No refuseWhileCliUpdating / refuseWhileShuttingDown here, unlike the routes that START
      // something: this spawns nothing. It writes one line to the stdin of an ALREADY running child,
      // which `claude update` (it replaces the binary on disk) cannot disturb — the same reason the
      // sibling GET /settings has no such gate. A chat whose process is gone is the 409 below, and
      // shutdown terminates the chats, so that 409 covers the shutting-down case too.
      if (action === 'context' && req.method === 'GET') {
        if (!chat.alive) return sendJson(res, 409, { error: 'process not running' });
        // Always 200, even when the CLI stayed silent: `{ unconfirmed: true }` tells the client to keep
        // its frame-arithmetic fallback, where an error status would make it paint a failure instead.
        return sendJson(res, 200, await getChatContext(chat));
      }
      // PR-11 — which hook events this CLI knows (all 33, with the /hooks summary and whether each takes a
      // matcher), which hooks are in FORCE and where each comes from, and whether an administrator
      // restricted them. The editor used to offer nine hard-coded events and a matcher rule that was wrong
      // for six of them; see public/js/hooks-catalog.js for the measurement.
      // Same shape as the context route above and for the same reasons: always 200, `unconfirmed: true`
      // when the CLI stayed silent (the editor then labels its fallback instead of painting an error), no
      // update/shutdown gate because nothing is spawned, and 409 only when the process is gone.
      if (action === 'hooks' && req.method === 'GET') {
        if (!chat.alive) return sendJson(res, 409, { error: 'process not running' });
        return sendJson(res, 200, await getChatHooks(chat));
      }
      // …and the counterpart for the skill editor: a session that is already running holds its skill
      // listing in its context, so a skill saved to disk is not the one the model sees. `reload_skills`
      // makes it re-read the directories. POST, because it changes the session's state.
      if (action === 'reload-skills' && req.method === 'POST') {
        if (!chat.alive) return sendJson(res, 409, { error: 'process not running' });
        const r = await reloadChatSkills(chat);
        if (!r.ok) return sendJson(res, 409, { error: r.error || 'no answer' });
        // `unconfirmed` is passed on rather than swallowed: the save already happened, and a reload nobody
        // confirmed must not look like one that worked (the same rule the effort switch follows).
        return sendJson(res, 200, { ok: true, unconfirmed: !!r.unconfirmed });
      }
      if (action === 'stop' && req.method === 'POST') {
        killChat(chat); // kills the process AND ends the registered SSE responses (no socket leak)
        return sendJson(res, 200, { ok: true });
      }
      // ---- MCP on the running session (G4) ----
      // What this session says about its own MCP connections. Free and synchronous on the CLI side
      // (`var qe=(e,o)=>({mcpServers:At(o)})`), which is what lets the tab menu read it on every open —
      // and it is the READ-BACK every verdict below is built from, because `mcp_toggle` answers with an
      // empty `{}`, there is no MCP push frame in this CLI at all, and a timed-out control request still
      // resolves „ok". The raw rows travel; public/js/mcp-live.js mcpStatusRows() decides what the UI may
      // say about them, so the server does not get a second opinion about the same enum.
      if (action === 'mcp-status' && req.method === 'GET') {
        if (!chat.alive) return sendJson(res, 409, { error: 'process not running' });
        const r = await getMcpStatus(chat);
        if (!r.ok) return sendJson(res, 409, { error: r.error || 'no answer' });
        // 200 with `unconfirmed` rather than an error, like GET /context: „nobody answered" is a state the
        // menu has to be able to show, and an error status would make it paint a failure instead.
        if (!r.servers) return sendJson(res, 200, { ok: true, unconfirmed: true, mcpServers: [] });
        return sendJson(res, 200, { ok: true, mcpServers: r.servers });
      }
      // Switch one server on/off in THIS session — the live replacement for the restart that applyTabMcp
      // used to need. Two things the answer deliberately keeps apart: whether the REQUEST got through
      // (`ok`/`error`/`unconfirmed`) and what the session REPORTS afterwards (`mcpServers`). The browser
      // forms the verdict out of the second one (mcpToggleVerdict), because the first cannot carry it:
      // `mcp_toggle` success is an empty payload.
      if (action === 'mcp-toggle' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const name = String(body.server == null ? '' : body.server).trim();
        // Validated here, at the edge, and not left to the CLI: `serverName` must be a string (the CLI's own
        // refusal is „mcp_toggle: serverName must be a string"), and a name is also what the response is
        // matched against in the browser — an empty one could only produce „Server not found" at best.
        if (!name) return sendJson(res, 400, { error: 'server required' });
        if (typeof body.enabled !== 'boolean') return sendJson(res, 400, { error: 'enabled must be a boolean' });
        if (!chat.alive) return sendJson(res, 409, { error: 'process not running' });
        const r = await setMcpEnabled(chat, name, body.enabled);
        return sendJson(res, 200, {
          ok: r.ok, server: name, requested: body.enabled, error: r.error || '',
          unconfirmed: !!r.unconfirmed, statusUnconfirmed: !!r.statusUnconfirmed, mcpServers: r.servers || [],
        });
      }
      // „Neu verbinden" — the 401 case the plan names: a server whose login expired reports `needs-auth`
      // (error_code CLAUDEAI_BEARER_REJECTED). Same answer shape as the toggle on purpose, so the browser
      // has one code path for both; the only difference is the ceiling (lib/chat: a reconnect may dial
      // twice and does a tools/list).
      if (action === 'mcp-reconnect' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const name = String(body.server == null ? '' : body.server).trim();
        if (!name) return sendJson(res, 400, { error: 'server required' });
        if (!chat.alive) return sendJson(res, 409, { error: 'process not running' });
        const r = await reconnectMcp(chat, name);
        return sendJson(res, 200, {
          ok: r.ok, server: name, error: r.error || '',
          unconfirmed: !!r.unconfirmed, statusUnconfirmed: !!r.statusUnconfirmed, mcpServers: r.servers || [],
        });
      }
      // ---- stop ONE task (G6) ----
      // Deliberately NOT the `interrupt` path: that ends the whole turn, and the browser half around it
      // clears the queue and marks every lane aborted (CHAT-FLOW-9 is what a shared path costs). This one
      // writes a single `stop_task {task_id}` and touches nothing else.
      // `ok: true` is NOT „the agent is stopped": the CLI smooths `not_found` and a terminal `not_running`
      // into success, so a task that had just finished by itself answers the same way. The lane may only
      // say „gestoppt" once a `task_updated {status:'killed'}` / `task_notification {status:'stopped'}`
      // frame arrives (public/js/task-stop.js) — which is why this route reports the REQUEST and nothing
      // about the task.
      if (action === 'stop-task' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const taskId = String(body.taskId == null ? '' : body.taskId).trim();
        // No blind pass-through: the CLI's only argument is this id, and a lane can legitimately exist
        // WITHOUT one for a moment (laneStart runs before any task_* frame). An empty id must fail here,
        // visibly, instead of becoming „stop_task: task_id must be a string" from the CLI.
        if (!taskId) return sendJson(res, 400, { error: 'taskId required' });
        if (!chat.alive) return sendJson(res, 409, { error: 'process not running' });
        const r = await stopTask(chat, taskId);
        if (!r.ok) return sendJson(res, 409, { error: r.error || 'stop_task rejected', taskId });
        return sendJson(res, 200, { ok: true, taskId, unconfirmed: !!r.unconfirmed });
      }
    }

    // Unknown /api/* never falls through to the static handler. It used to: a typo'd or removed
    // endpoint answered 404 text/plain from the file branch, so the client's `api()` helper tried to
    // JSON.parse HTML/text and reported a parse error instead of "route not there" (and a stale
    // browser against a newer server got misleading diagnostics — see /api/version's routeMissing).
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });

    // ---- Static files ----
    if (req.method === 'GET') {
      let rel;
      try { rel = decodeURIComponent(p); } catch { return sendText(res, 400, 'bad request'); }
      if (rel === '/' || rel === '') rel = '/index.html';
      const safe = path.normalize(rel).replace(/^([/\\])+/, '');
      const file = path.join(PUBLIC_DIR, safe);
      // trailing sep so a sibling like …/public-old can't satisfy the prefix test
      if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return sendText(res, 403, 'forbidden');
      try {
        const st = await fsp.stat(file);
        if (!st.isFile()) return sendText(res, 404, 'not found');
        const ext = path.extname(file).toLowerCase();
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
        // Revalidate-on-reload: an ETag/Last-Modified + `no-cache` lets the browser send a conditional
        // request and get a tiny 304 when the ~500KB of JS/CSS is unchanged (was `no-store` = always a
        // full re-download). `no-cache` (not `max-age`) means it always revalidates, so edits show on
        // reload with no staleness.
        const etag = 'W/"' + st.size.toString(16) + '-' + Math.round(st.mtimeMs).toString(16) + '"';
        const headers = { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag, 'Last-Modified': new Date(st.mtimeMs).toUTCString() };
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
        const data = await fsp.readFile(file);
        res.writeHead(200, headers);
        return res.end(data);
      } catch {
        return sendText(res, 404, 'not found');
      }
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    // headers already out (e.g. mid-SSE or mid-download) → can't send JSON anymore; drop the socket
    if (res.headersSent) { try { res.destroy(); } catch { /* */ } return; }
    // The other half of errorText()'s rule (lib/core.js): the client gets the MESSAGE, and the full
    // error — stack frames included — goes to the server log, which is where a stack is useful and
    // where nobody but the person running the panel can read it. Only for a real 500: an error that
    // carries its own statusCode is a judged client-input case (badRequest), and its message IS the
    // whole story. Without this the stack was simply gone, for every failure of every route.
    if (!(e && e.statusCode)) { try { console.error('[route] ' + req.method + ' ' + p + ' —', (e && e.stack) || e); } catch { /* */ } }
    // a thrown error that carries a machine `code` (startChat's 'cli-updating', B1) keeps it, plus its
    // hint — the client translates the code instead of showing the raw message
    const out = { error: errorText(e) };
    if (e && e.statusCode && typeof e.code === 'string') out.code = e.code;
    if (e && typeof e.hint === 'string') out.hint = e.hint;
    // …and the fields a judged refusal explains itself with (CHAT-FLOW-4: `busy`/`starting` of a session open
    // elsewhere). Never over error/code/hint — those are this router's.
    if (e && e.statusCode && e.extra && typeof e.extra === 'object') for (const k of Object.keys(e.extra)) if (!(k in out)) out[k] = e.extra[k];
    return sendJson(res, e && e.statusCode ? e.statusCode : 500, out);
  }
});

// Last-resort safety net: a local dev server must not die from a stray async error (e.g. a broken child
// pipe or a socket write after close). Log and keep running instead of exiting.
process.on('uncaughtException', (e) => { try { console.error('[uncaughtException]', (e && e.stack) || e); } catch { /* */ } });
process.on('unhandledRejection', (e) => { try { console.error('[unhandledRejection]', (e && e.message) || e); } catch { /* */ } });

// FLOW-2: ONE way out of this process, for POST /api/restart and for the console signals alike. Each
// exit path used to do its own thing — restart closed the listener and exited after 150 ms, Ctrl+C
// exited at once — and both left every chat's claude.exe tree running as an orphan (plus its MCP
// servers), and every headless run as a 'running' record in ui-skill-runs.json / a schedule whose
// lastStatus never changed. Now: stop accepting, end the headless runs as 'aborted' (history + schedule
// lastStatus written), terminate every chat through the shared terminateChat (EOF → grace → tree
// kill), exit. Idempotent (a second call returns the first promise; a second SIGINT exits at once),
// and bounded: the hard-exit timer is deliberately NOT unref'd — it is the guarantee that a hung
// write or a stuck taskkill can never keep a half-shut-down server alive.
const SHUTDOWN_HARD_MS = 5000;
let SHUTTING_DOWN = null;
// #4: once shutdown() has begun, the routes that START something (a chat, a scheduled run) refuse —
// 503 + code 'shutting-down', the same shape as 'cli-updating' — instead of spawning a claude.exe the
// sweep below has already passed. Thrown form for the start route's re-check after its awaits.
function shuttingDownError() {
  const e = new Error('shutting-down');
  e.statusCode = 503; e.code = 'shutting-down';
  return e;
}
// CHAT-FLOW-4 (review) — the start route's „the browser that asked is gone" (see there). Thrown, so the route's
// catch deletes the temp MCP config; the answer it then gets goes to a closed socket and nowhere. 499 is nginx's
// „client closed request" — a judged case with its own statusCode, so the router does not log it as a crash.
function clientGoneError() {
  const e = new Error('client gone');
  e.statusCode = 499; e.code = 'client-gone';
  return e;
}
function refuseWhileShuttingDown(res) {
  if (!SHUTTING_DOWN) return false;
  sendJson(res, 503, { error: 'shutting-down', code: 'shutting-down' });
  return true;
}
function shutdown(reason, exitCode) {
  if (SHUTTING_DOWN) return SHUTTING_DOWN;
  const code = Number.isInteger(exitCode) ? exitCode : 0;
  const all = [...chats.values()];
  try { console.log('[shutdown] ' + reason + ' — ' + all.length + ' chat(s), ' + activeRunCount() + ' scheduled run(s)'); } catch { /* */ }
  setTimeout(() => process.exit(code), SHUTDOWN_HARD_MS);
  SHUTTING_DOWN = (async () => {
    try { server.close(); } catch { /* */ } // stop accepting; a restart's successor takes the port
    try { await abortHeadlessRuns('aborted'); } catch { /* */ }
    // the snapshot (taken first: abort removes headless chats from the map, and their terminateChat is
    // joined here instead of lost) PLUS anything that registered while the abort was being awaited
    const toEnd = new Set([...all, ...chats.values()]);
    await Promise.allSettled([...toEnd].map((c) => { try { return terminateChat(c); } catch { return null; } }));
    // #4: the backstop for the 503 'shutting-down' gates — whatever still registered while the sweep
    // above was awaited (a spawn path without its own check) is ended too, at once (tree kill, no
    // grace: the exit is near)
    const late = [...chats.values()].filter((c) => !toEnd.has(c));
    await Promise.allSettled(late.map((c) => { try { return terminateChat(c, { resume: true }); } catch { return null; } }));
    // Flush the folded transcript corpus. Its write is debounced by ~5 s on an UNREF'd timer, so a
    // restart inside that window would throw the fold away and the next /api/sessions would pay the
    // full cold fold again. Cheap (~40 ms for 2.3 MB) and it may never fail loudly.
    try { await flushCorpusCache(); } catch { /* a cache that cannot be written is a slow start, not an error */ }
  })().finally(() => { setTimeout(() => process.exit(code), 150); });
  return SHUTTING_DOWN;
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  try {
    process.on(sig, () => {
      if (SHUTTING_DOWN) process.exit(0); // second Ctrl+C: the user means it
      shutdown(sig, 0);
    });
  } catch { /* signal not supported on this platform */ }
}

// B4: a port that is already taken used to surface as an unhandled 'error' event → the
// uncaughtException net above logged it and KEPT THE PROCESS ALIVE: no listener, but the scheduler
// ticking and the reaper running — a zombie panel next to the real one (e.g. a double-clicked start,
// or a restart whose predecessor did not let go). A listen that fails is fatal, with a line that says
// which port and what to do. Registered BEFORE listen() so the very first error has a handler.
let LISTENING = false;
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    try { console.error(`\n  ✗ Port ${PORT} on ${HOST} is already in use (EADDRINUSE) — is another Control Panel running?\n    Stop it, or start this one with CLAUDE_UI_PORT=<free port>. Exiting.\n`); } catch { /* */ }
    process.exit(1);
  }
  try { console.error('[server error]', (e && e.stack) || e); } catch { /* */ }
  if (!LISTENING) process.exit(1); // any other listen failure (EACCES, …) leaves nothing to serve either
});

// the git commit the running process booted from — compared against the on-disk HEAD by /api/version so the
// System view can warn "server läuft auf älterem Stand — Neustart nötig" after a pull/commit (ToDo 07)
let BOOT_COMMIT = '';
server.listen(PORT, HOST, async () => {
  LISTENING = true;
  console.log(`\n  Claude Code Control Panel`);
  // N9: the way IN, not just the address. A bookmark on `http://127.0.0.1:8787` answers 401 on every /api/
  // call until the browser has seen a token once, so printing the bare origin alone would be the „the
  // surface claims something nobody checked" failure in one line. The token itself is NOT printed: this
  // output IS server.log (start.ps1 redirects it there), and a log is what gets pasted into a ticket, a
  // chat, or read by a Claude session into its transcript — the token file is none of those. It used to
  // be printed (Jupyter-style, „same ACL'd directory"), and CodeQL flagged it on #87
  // (js/clear-text-logging). Nobody needed it: start.ps1 reads the FILE and opens `/?t=…` itself.
  if (API_TOKEN) {
    console.log(`  → http://${HOST}:${PORT}  — open it via start.cmd (it appends the API token), or append ?t=<token>`);
    console.log(`  token: ${API_TOKEN_FILE}  (stable across restarts; deliberately not printed — this output is the log)`);
  } else {
    console.log(`  → http://${HOST}:${PORT}`);
    console.log('  token: DISABLED (CLAUDE_UI_NO_API_TOKEN=1) — every local user of this machine can call /api/');
  }
  // On a miss this is the only place a new user gets told WHERE we looked — printing just
  // "NOT FOUND (set CLAUDE_UI_CLAUDE_BIN)" made every foreign install a guessing game.
  // N12: from the BIN_STATE round started at require time — this was one more sync lookup of a possibly
  // remote path, AFTER the server already listened.
  await refreshBinState().catch(() => {});
  if (BIN_STATE.exeExists) {
    console.log(`  claude: ${CLAUDE_EXE}  [${CLAUDE_BIN_INFO.source}]\n`);
  } else {
    console.log(`  claude: NOT FOUND  [${CLAUDE_BIN_INFO.source}]`);
    if (BIN_STATE.exeReach === 'unreachable') console.log(`    configured path does not answer (share offline?): ${CLAUDE_EXE}`);
    else if (CLAUDE_BIN_INFO.source !== 'not-found') console.log(`    configured path does not exist: ${CLAUDE_EXE}`);
    if (CLAUDE_BIN_INFO.installMethod) console.log(`    ~/.claude.json says installMethod=${CLAUDE_BIN_INFO.installMethod}`);
    for (const p of (CLAUDE_BIN_INFO.tried || []).slice(0, 12)) console.log(`    tried: ${p}`);
    console.log('    fix: run `claude --version` in a terminal, then either put that binary on PATH,');
    console.log('         set CLAUDE_UI_CLAUDE_BIN=<full path>, or add {"claudeBin":"<full path>"} to ui-prefs.json\n');
  }
  try { BOOT_COMMIT = ((await run('git', ['-C', REPO_DIR, 'rev-parse', 'HEAD'])).stdout || '').trim(); } catch { /* not a repo / no git */ }
  // PR-S — read the binary's --help once now, so the first chat start does not pay the ~1.7 s spawn and
  // /api/state can already say whether --system-prompt-snapshot is known. Not awaited: a slow or broken
  // binary must not hold up the boot, and a failed probe is simply asked again on the next start.
  cliMod.cliHelpFlags().catch(() => {});
  // A managed `modelPricing` changes what a token costs for this whole machine (CLI 2.1.271). Read
  // once at boot — it is an organisation's policy file, not something a session edits — and say so,
  // because "the panel's cost numbers are not list prices" is not something to discover later.
  try {
    const managed = await readJsonFile(MANAGED_SETTINGS);
    const table = applyManagedPricing(managed && managed.parsed && managed.parsed.modelPricing);
    if (table) console.log(`  pricing: managed modelPricing applied (${MANAGED_SETTINGS})\n`);
  } catch { /* no managed settings on this machine → list prices, which is the normal case */ }
});
