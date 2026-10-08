'use strict';
// S3 — no synchronous fs call may be handed a path a CALLER chose.
//
// The defect, measured on this machine (2026-10-03, node v26.7.0, a fresh unrouted TEST-NET-1 host per
// case so Windows' negative name cache could not flatter the later ones):
//     fs.existsSync('\\192.0.2.12\share')   43 918 ms elapsed, 43 919 ms of it with the EVENT LOOP held
//     fs.statSync  ('\\192.0.2.11\share')   44 505 ms elapsed, 44 506 ms of it with the EVENT LOOP held
//     await fsp.stat('\\192.0.2.13\share')  53 973 ms elapsed,         93 ms of it with the loop held
// The server is ONE thread, so the sync form does not make one request slow — it makes every request
// stop. One GET froze the whole panel for three quarters of a minute, and the same lookup logs the
// panel's Windows identity in to whatever SMB host the caller named.
//
// Why this is a SOURCE test and not a behavioural one: the behaviour is a 44-second wait against a host
// that must not answer. A suite cannot afford that, and a suite that mocks fs would be testing the mock.
// What CAN be checked cheaply and completely is the thing that actually regressed: a call site. So this
// is an INVENTORY — every synchronous fs call in server.js and lib/ has to be on the list below with a
// reason, and anything new fails until somebody decides which kind of path it is handed.
//
// It deliberately does not hang on a line number: the key is file + function + the expression, so moving
// code around is free and only a NEW or CHANGED path argument trips it.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = ['server.js', ...fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).sort().map((f) => 'lib/' + f)];

// Blank out comments while keeping every other character in place (so line numbers and string literals
// survive). Needed because this repo explains itself at length and several comments QUOTE the very
// idiom under test — `// The async twins of fs.existsSync(p) …` in lib/core.js would otherwise be
// reported as a call site, and an inventory that lists prose is an inventory nobody keeps up to date.
function blankComments(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out[i] = ' '; i++; } continue; }
    if (c === '/' && d === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] !== '\n') out[i] = ' '; i++; }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < n && src[i] !== c) { if (src[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    // a regex literal can contain // and /* — step over it so its body is not mistaken for a comment.
    // Crude but sufficient here: a `/` that follows an operator or an opening bracket starts a literal.
    if (c === '/') {
      let k = i - 1;
      while (k >= 0 && /\s/.test(src[k])) k--;
      if (k < 0 || '(,=:[!&|?{};+*%<>~^'.includes(src[k])) {
        i++;
        while (i < n && src[i] !== '/' && src[i] !== '\n') { if (src[i] === '\\') i++; i++; }
        i++;
        continue;
      }
    }
    i++;
  }
  return out.join('');
}

// -> [{ file, line, fn, arg }] for every `fs.<something>Sync(` in real code
function syncFsCalls() {
  const hits = [];
  for (const file of FILES) {
    const code = blankComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    code.split(/\r?\n/).forEach((line, idx) => {
      const re = /\bfs\.([a-z]\w*Sync)\s*\(/g;
      let m;
      while ((m = re.exec(line))) {
        let depth = 1, j = re.lastIndex, arg = '';
        while (j < line.length && depth > 0) {
          const ch = line[j];
          if (ch === '(' || ch === '[') depth++;
          else if (ch === ')' || ch === ']') { depth--; if (depth === 0) break; }
          else if (ch === ',' && depth === 1) break;
          arg += ch; j++;
        }
        hits.push({ file, line: idx + 1, fn: m[1], arg: arg.trim() });
      }
    });
  }
  return hits;
}

// The inventory. Key = `<file> | <fn> | <first argument, verbatim>`; value = why that path is NOT one a
// caller chose. Repeats of the same key (CLAUDE_EXE is asked about in four places) share one entry — the
// question "whose path is this" has one answer per expression, not per occurrence.
//
// Anything here that STILL reaches a caller-named path is named as such with its follow-up, because an
// inventory that quietly re-labels an open defect as "fine" is worse than no inventory.
const ALLOWED = new Map(Object.entries({
  // ---- paths the panel owns outright: its own checkout, its own data dir, its own ~/.claude ----
  'server.js | mkdirSync | path.dirname(logFile)': 'the successor server log under the panel\'s own data dir (lib/paths SERVER_LOG)',
  'server.js | openSync | logFile': 'ditto — and it is opened in the few lines before the process re-execs itself',
  'server.js | existsSync | src': 'two call sites, both confined before they get here: BACKUP_DIR + a name with no / \\ or .. (POST /api/backups/restore), and cfgFilePath(\'commands\', /^[\\w.-]+$/) (POST /api/skill/duplicate)',
  'server.js | existsSync | dest': 'cfgFilePath(\'commands\', …) with the target stripped to [\\w.-] — inside ~/.claude/commands by construction',
  'server.js | existsSync | tgt.dest': 'lib/backups restoreTarget(): PROJECTS_DIR + encodeProject(cwd), cfgDir(kind) or CLAUDE_DIR — all three are panel directories, and encodeProject flattens a cwd into one name so it cannot escape',
  'lib/backups.js | existsSync | src': 'same BACKUP_DIR confinement as the route above',
  'lib/bedrock.js | readFileSync | credentialsPath()': '~/.aws/credentials — the machine\'s own AWS config',
  'lib/bedrock.js | readFileSync | BEDROCK_ACCESS_FILE': 'the panel\'s own entitlement cache in its data dir',
  'lib/bedrock.js | writeFileSync | BEDROCK_ACCESS_FILE': 'ditto, and best-effort (its failure is swallowed)',
  'lib/github.js | readFileSync | GHE_CREDS': 'the GHE PAT file, a fixed path from lib/paths',
  'lib/skills.js | existsSync | f': 'bundled skill / plugin lookup, all under CLAUDE_DIR',
  'lib/mcp.js | existsSync | path.join(dir, \'.git\')': 'walks UP from a path already taken from the MCP config — see the two norm entries below, same provenance',
  // ---- N9, the API token: a lib/paths constant, read and created BEFORE the server listens ----
  // Both halves of the S3 rule are satisfied, not just one: the path is never a caller's (API_TOKEN_FILE,
  // lib/paths.js), and the calls happen once at module/boot time in front of server.listen(), so even on a
  // pathological filesystem no REQUEST is the thing that waits. The parameter is named `tokenFile` rather
  // than `file` so these three entries cannot silently start vouching for some other sync read in lib/core.
  'lib/core.js | readFileSync | tokenFile': 'readApiToken(API_TOKEN_FILE) — the panel\'s own token under %LOCALAPPDATA%\\claude-code-ui (or DATA_DIR under the test seam)',
  'lib/core.js | mkdirSync | path.dirname(tokenFile)': 'ditto — creating that per-user directory on first start, 0700',
  'lib/core.js | writeFileSync | tokenFile': 'ditto — writing the generated token 0600; its failure is deliberately NOT swallowed (a server that cannot persist its token must not run unprotected)',

  // ---- the local branch of startChat's form-aware fork (THIS change) ----
  // Guarded, and the guard is checked separately below — the inventory can see the argument but not the
  // short-circuit in front of it, and the short-circuit is the entire point.
  'lib/chat.js | existsSync | dir': 'an --add-dir value, but only ever reached for a LOCAL path: isUncOrDevicePath() hands a network/device path straight to argv unchecked (asserted below); since J11 only for callers WITHOUT the async measurement of the start route with a deadline (opts.pathCheck — the headless engine, UI-skill runs)',
  'lib/chat.js | existsSync | opts.cwd': 'the chat cwd, same fork: a network/device path is passed through to the spawn unchecked, so this lookup only ever sees a local path (asserted below); since J11 only for callers without opts.pathCheck, like the --add-dir lookup',

  // ---- the CONFIGURED claude binary: resolved (N12), except for one named boot-time remainder ----
  // The four CLAUDE_EXE lookups in server.js and the three in lib/cli.js are gone (async + deadline, the
  // read routes serve the BIN_STATE cache). What is left are the sync seams of the resolver, and they run
  // only through the sync driver: at REQUIRE time, before the server listens, and never on the configured
  // path itself (`isConfigured` answers null there — asserted below, as is the absence of any sync
  // resolveClaudeBin() call in server.js).
  'lib/paths.js | statSync | p': 'isFileSync(), require-time auto-detection only (PATH dirs, ~/.local, ~/.claude, npm prefixes). NOT the configured claudeBin/CLAUDE_UI_CLAUDE_BIN (asserted below). Remainder, named in docs/ideas.md: a PATH entry on a dead share still delays the BOOT, before listen',
  'lib/paths.js | readFileSync | p': 'readTextSync()/readJsonSync(), require time only: ui-prefs.json and ~/.claude.json (panel/CLI files) plus a claude.cmd shim already found on PATH',
  'lib/paths.js | readdirSync | p': 'listDirSync(), require time only: ~/.claude/versions',

  // ---- paths pulled out of an MCP transport string: resolved (N12) ----
  // A network path (`//host/share/...`, `\\?\UNC\...`) is classified „not checked" before any of these
  // lines is reached (lib/reach.js isNetworkPath; asserted behaviourally below), so they only ever see a
  // local path. The existsSync + statSync pair on one name (CWE-367) stays: local, best-effort, it decides
  // nothing but where the git walk starts.
  'lib/mcp.js | existsSync | norm': 'a LOCAL path from the MCP transport; a network path is skipped by isNetworkPath() first (asserted below)',
  'lib/mcp.js | statSync | norm': 'ditto, in parseMcpTarget and pkgEntryMtime — both skip a network path first (asserted below)',
}));

describe('S3 — synchronous fs calls, and whose path each one is handed', () => {
  it('every synchronous fs call in server.js and lib/ is on the inventory', () => {
    const calls = syncFsCalls();
    assert.ok(calls.length > 15, 'the scanner found only ' + calls.length + ' calls — it has stopped seeing the code');
    const unknown = calls
      .filter((c) => !ALLOWED.has(c.file + ' | ' + c.fn + ' | ' + c.arg))
      .map((c) => c.file + ':' + c.line + '  fs.' + c.fn + '(' + c.arg + ')');
    assert.deepEqual([...new Set(unknown)], [],
      'a synchronous fs call on a path that nobody has classified. If the path comes from a request, a '
      + 'chat option or ui-prefs, it must become `await pathExists/pathIsFile` (lib/core.js) — on an '
      + 'unreachable share the sync form holds the WHOLE server for ~44 s. If the panel owns the path, '
      + 'add it to ALLOWED with the reason.');
  });

  it('the inventory has no entry for a call site that is gone', () => {
    const live = new Set(syncFsCalls().map((c) => c.file + ' | ' + c.fn + ' | ' + c.arg));
    const stale = [...ALLOWED.keys()].filter((k) => !live.has(k));
    assert.deepEqual(stale, [],
      'these entries describe code that no longer exists — drop them, or the list starts vouching for '
      + 'calls nobody can find');
  });

  // The inventory can read the ARGUMENT but not what stands in front of it, and for lib/chat.js the
  // thing in front is the whole fix: a UNC or device path must never reach the lookup. Without this,
  // deleting the short-circuit would leave both tests above perfectly green.
  it('every surviving sync lookup in lib/chat.js is short-circuited for a UNC/device path', () => {
    const code = blankComments(fs.readFileSync(path.join(ROOT, 'lib', 'chat.js'), 'utf8'));
    const lines = code.split(/\r?\n/).map((l, i) => ({ n: i + 1, l })).filter((x) => /\bfs\.\w+Sync\s*\(/.test(x.l));
    assert.equal(lines.length, 2, 'expected exactly the --add-dir and the cwd lookup, found ' + lines.length);
    for (const { n, l } of lines) {
      // the guard has to be on the SAME expression, in front, as an OR — anything else does not stop
      // the lookup from happening
      const m = l.match(/isUncOrDevicePath\(\s*([^)]+?)\s*\)\s*\|\|\s*fs\.\w+Sync\(\s*([^)]+?)\s*\)/);
      assert.ok(m, 'lib/chat.js:' + n + ' does a synchronous lookup that is not shape-guarded: ' + l.trim());
      assert.equal(m[1], m[2], 'lib/chat.js:' + n + ' guards a different expression than it looks up: ' + l.trim());
    }
  });

  // N12 — the inventory sees `fs.*Sync(` but not a call of the SYNC resolver, whose seams are exactly those
  // calls. It may run at require time only (lib/paths), never from a route: every later look is
  // resolveClaudeBinAsync into server.js BIN_STATE. Behaviour of the seams: test/path-reach.test.js.
  it('no module calls the synchronous resolveClaudeBin() — only lib/paths itself, at require time', () => {
    for (const file of FILES.filter((f) => f !== 'lib/paths.js')) {
      const code = blankComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
      assert.doesNotMatch(code, /\bresolveClaudeBin\s*\(/, file + ' resolves the claude binary synchronously');
    }
  });

  // One definition of "may cost a network round trip to look at", because two callers draw OPPOSITE
  // conclusions from it (the read routes refuse such a path, startChat passes it through) and a second
  // copy would eventually disagree about what the question means.
  it('isUncOrDevicePath is shared, and recognises every spelling of both shapes', () => {
    const core = require('../lib/core');
    for (const p of ['\\\\192.0.2.1\\share', '\\\\server\\share\\repo', '//server/share', '\\\\?\\C:\\Windows',
      '\\\\.\\pipe\\x', '\\/server/share', '  \\\\server\\share  ', '\\\\?\\UNC\\host\\share']) {
      assert.equal(core.isUncOrDevicePath(p), true, JSON.stringify(p) + ' is a path that may cost a network trip');
    }
    for (const p of ['C:\\Users\\me\\repo', '\\single', '/usr/local', 'relative\\dir', '', null, undefined, 'C:/x//y']) {
      assert.equal(core.isUncOrDevicePath(p), false, JSON.stringify(p) + ' is local');
    }
  });

  // The async twins must answer exactly what the sync idioms answered, for everything a route can be
  // handed — a changed answer for a bad input would be a behaviour change smuggled in under a
  // performance fix. pathIsFile additionally has to do it in ONE lookup (CWE-367, alert #79).
  it('pathExists / pathIsFile answer like the idioms they replaced', async () => {
    const core = require('../lib/core');
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-s3-'));
    const file = path.join(tmp, 'a.txt');
    fs.writeFileSync(file, 'x');
    try {
      assert.equal(await core.pathExists(tmp), true, 'a directory exists');
      assert.equal(await core.pathExists(file), true, 'so does a file');
      assert.equal(await core.pathExists(path.join(tmp, 'nope')), false);
      assert.equal(await core.pathIsFile(file), true);
      assert.equal(await core.pathIsFile(tmp), false, 'a DIRECTORY is not a file — this is the judgement POST /api/prefs { claudeBin } rests on');
      assert.equal(await core.pathIsFile(path.join(tmp, 'nope')), false);
      // existsSync has no error path at all, not even for a non-string, and these stand in for it
      for (const junk of [null, undefined, 42, true, {}, '', '\0']) {
        assert.equal(await core.pathExists(junk), false, 'pathExists(' + JSON.stringify(junk) + ') must answer, not throw');
        assert.equal(await core.pathIsFile(junk), false, 'pathIsFile(' + JSON.stringify(junk) + ') must answer, not throw');
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  // CWE-367 (the rule behind alert #79), and COUNTED rather than eyeballed. `fs.existsSync(p)` followed
  // by `fs.statSync(p)` is two lookups of the same NAME: between them whatever is at that name can be
  // replaced, so the `isFile()` the caller acts on need not describe the thing the `existsSync()` found.
  // POST /api/prefs { claudeBin } was built that way, and its whole purpose is to decide which binary
  // this panel will execute. One stat = one object = nothing to race.
  it('pathIsFile asks the filesystem about the name exactly ONCE', async () => {
    const core = require('../lib/core');
    const fsp = require('fs/promises');
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-s3-once-'));
    const file = path.join(tmp, 'claude.exe');
    fs.writeFileSync(file, 'x');
    // lib/core calls `fsp.stat(...)` as a property of the module object, so counting here really counts
    // its calls — no bundler or destructuring stands in between.
    const realStat = fsp.stat;
    const realLstat = fsp.lstat;
    const realAccess = fsp.access;
    const seen = [];
    fsp.stat = (...a) => { seen.push('stat'); return realStat(...a); };
    fsp.lstat = (...a) => { seen.push('lstat'); return realLstat(...a); };
    fsp.access = (...a) => { seen.push('access'); return realAccess(...a); };
    try {
      assert.equal(await core.pathIsFile(file), true);
      assert.deepEqual(seen, ['stat'], 'two lookups of one name is the defect, not an implementation detail');
      seen.length = 0;
      assert.equal(await core.pathExists(file), true);
      assert.deepEqual(seen, ['stat'], 'pathExists too — it stands in for existsSync, which is one lookup');
    } finally {
      fsp.stat = realStat; fsp.lstat = realLstat; fsp.access = realAccess;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
