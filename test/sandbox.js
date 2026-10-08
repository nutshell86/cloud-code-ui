'use strict';
// ONE hermetic environment for everything that boots server.js under test: verify.js (the test pass and
// the live smoke), smoke-test.js in own-spawn mode, and test/integration.test.js. All of the server's
// test seams at once, because a single forgotten one was enough to reach something real: the smoke
// folded the developer's 470 MB transcript corpus (and blew its 15 s timeout), the scheduler ticked
// against the live ui-skill-schedules.json, the route-parity sweep sent the real GHE PAT and could open
// an Edge tab through the real CDP port, `/api/sysinfo` and `/api/cli/version` asked the npm registry,
// and a restarted test server appended to the live panel's server.log.
//
// Not a *.test.js file on purpose — node --test must not pick it up as a suite.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(ROOT, 'fake-claude.js');
const FIXTURE_PROJECTS = path.join(__dirname, 'fixtures', 'projects');
// Nothing listens on the discard port, so every CDP call fails at connect — the spend route answers
// its honest 502 („Debug-Browser nicht erreichbar") instead of opening a tab in the user's browser.
const DEAD_CDP_URL = 'http://127.0.0.1:9';

// -> { root, dataDir, claudeDir, env, cleanup() }
// opts.fakeCli: also point CLAUDE_UI_CLAUDE_BIN at the fake script. It exists (the chat-start gate
// passes) but is not executable, so every NON-chat CLI call (`--version`, `mcp list` with its health
// checks of every real MCP server, …) fails instantly instead of spawning the real binary.
function makeSandbox(label, opts) {
  const o = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-' + (label || 'sbx') + '-'));
  const dataDir = path.join(root, 'data');
  const claudeDir = path.join(root, 'claude');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  // the synthetic corpus from test/fixtures (3 tiny sessions, see its README) instead of ~/.claude/projects
  fs.cpSync(FIXTURE_PROJECTS, path.join(claudeDir, 'projects'), { recursive: true });
  const claudeJson = path.join(root, 'claude.json');
  fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: {} }));
  // a token that opens nothing: GHE routes run their real code path, GHE answers 401 at worst
  const gheCreds = path.join(root, 'ghe.credentials.json');
  fs.writeFileSync(gheCreds, JSON.stringify({ token: 'ccui-test-dummy-not-a-pat' }));
  const env = {
    CLAUDE_UI_FAKE_BIN: FAKE,            // chat turns → the stream-json emulator, never a paid model call
    CLAUDE_UI_DATA_DIR: dataDir,         // the app's own stores (+ server.log, see lib/paths SERVER_LOG)
    CLAUDE_UI_CLAUDE_DIR: claudeDir,     // ~/.claude: settings, projects, backups, plans
    CLAUDE_UI_CLAUDE_JSON: claudeJson,   // ~/.claude.json: no MCP servers → no `npm view` per server
    CLAUDE_UI_GHE_CREDS: gheCreds,
    CLAUDE_UI_CDP_URL: DEAD_CDP_URL,
    CLAUDE_UI_NO_SCHEDULER: '1',
    CLAUDE_UI_FAKE_NPM_LATEST: '0.0.0',  // the registry "says" nothing newer — no network, no update claim
    // N9: the API-token gate OFF for the suites. The suites that boot a server (verify.js prints how many
    // on every run) drive /api/ through their own small `req()` helpers; threading a token through all of
    // them would add noise everywhere and prove nothing about the gate. The gate's own contract — on by
    // default, 401 without it, the file, the `?t=` query EventSource needs, the page staying reachable — is
    // tested by test/api-token.test.js, which boots its servers WITHOUT this variable; and verify.js's live
    // smoke overrides it back off, sends its /api/ checks through the gate and first CHECKS that the gate is
    // on there (a token-less /api/state must be 401). No count of those checks here: one stood here and one
    // in verify.js, both already wrong when written and moved again by the next merge — verify prints the
    // smoke's own „N passed" line instead.
    // Inert in production (unset → gate on).
    CLAUDE_UI_NO_API_TOKEN: '1',
  };
  if (o.fakeCli) env.CLAUDE_UI_CLAUDE_BIN = FAKE;
  const cleanup = () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* a dying child may still hold a handle */ } };
  return { root, dataDir, claudeDir, env, cleanup };
}

module.exports = { makeSandbox, FAKE, DEAD_CDP_URL };
