#!/usr/bin/env node
'use strict';
// TEST-ONLY fake `claude`. Speaks just enough of the CLI's stream-json stdio protocol to drive the Control
// Panel's chat / resume / reconnect / self-heal paths deterministically — with NO real model call and no cost.
// Selected in tests via the CLAUDE_UI_FAKE_BIN seam in lib/chat.js (spawned as `node fake-claude.js <claude-args>`).
// Scenario via FAKE_CLAUDE_SCENARIO: echo (default) · crash · permission · plan · bgagent · fgagent · monitor · silent · openpoints · uiresult · sessionstate · updatefail · updatemissing · bgstop
//   · openpoints-plan · openpoints-ask · openpoints-split · openpoints-tail · openpoints-toolonly · openpoints-crash · question
//   · planprogress · planprogress-compact (PF-1: a held plan gate, then a model that reports its steps in ```plan-status
//     blocks; they WRITE a transcript, into a temp-dir CLAUDE_UI_CLAUDE_DIR only; see there)
//   · planorphan · planself (PF-1b: an ExitPlanMode the CLI refuses outside plan mode, then a start by MESSAGE, a
//     typed „plan starten" without a list, or the panel's request for the list; planself reports without any
//     ExitPlanMode — both write their transcript like planprogress; see there).
//   These four are the only scenarios that write a session transcript.
// `bymsg` picks the scenario PER TURN from the user's message (`sc:<name>`, optional `hold:<ms>`; after an
// `sc:planorphan` the following messages stay with it — a plan is a conversation, not one turn), so one
// throwaway server can walk a browser check through every PER-TURN case; FAKE_CLAUDE_TURN_MS = the default
// hold. It cannot offer the SESSION-WIDE ones — currently `sessionstate`, half of which is a
// `commands_changed` emitted before `init` — and this line used to promise „every case", which would have
// sent the next reader hunting for an `sc:sessionstate` that silently falls back to echo. Those run through
// FAKE_CLAUDE_SCENARIO only; the branch itself says why (see there).
// FAKE_CLAUDE_IGNORE_EOF=1 (any scenario): stays alive after stdin EOF until killed (see there).
// `--resume <id> --fork-session` (any scenario) reports a NEW random session id, like the real CLI — not <id>.
// FAKE_CLAUDE_FORK_SOURCE_FRAME=<id> (any scenario): a fork OF THAT id first emits one frame carrying <id> itself,
//   then `init` with its new id — the shape the panel's „never under the source id" lock exists for (server.js
//   storeForkScope). Keyed by id so one test server can run it for one fork and leave every other one alone.
// FAKE_CLAUDE_LATE_INIT=1 (any scenario): `init` waits for the first user message, as measured for the real CLI
//   in `-p --input-format stream-json` (CTX-4, public/js/chat-events.js) — until then a start says nothing.
// FAKE_CLAUDE_ARGV_OUT=<file> (any scenario): every chat process — and every `--help` probe — appends its argv
//   as one JSON line (see there).
// FAKE_CLAUDE_CTX_MS / FAKE_CLAUDE_CTX_SILENT=1 (any scenario): hold / withhold the `get_context_usage`
//   answer, so the panel's long timeout, its one-in-flight sharing, a LATE answer (slower than the
//   panel's ceiling) and a `set_model` that overlaps a held read are all testable (see contextUsage).
// Non-chat subcommands: --version · --help · doctor · auth status · mcp list|get|add|remove|login|logout ·
//   update · the `-p <prompt> --output-format json` one-shot (FAKE_CLAUDE_VERSION_FILE / _VERSION_MS /
//   _HELP / _HELP_MS / _UPDATE_MS / _MCP_LIST / _ENHANCE: see there)
//
// Protocol (must match what lib/chat.js parses):
//   in  (stdin, newline JSON): {type:'user', message:{content:[{type:'text',text}]}}  ·  {type:'control_response',…}
//   out (stdout, newline JSON): system/init (carries session_id) · assistant · result · control_request · _-agnostic
const readline = require('readline');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const argVal = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };

// Test seam: with CLAUDE_UI_FAKE_ARGV_LOG set to a file path, every invocation appends its argv as one
// JSON line. That is the only way a route test can assert what the PANEL ASKED FOR instead of what it
// believes it asked for — FLOW-5 (`--strict-mcp-config` on the enhance one-shot) is exactly that kind of
// claim: everything looked fine from the response, and the whole MCP set was started anyway.
if (process.env.CLAUDE_UI_FAKE_ARGV_LOG) {
  try { require('fs').appendFileSync(process.env.CLAUDE_UI_FAKE_ARGV_LOG, JSON.stringify(argv) + '\n'); } catch { /* best effort */ }
}

// ---- non-chat invocations, so a full `node verify.js` needs no real binary ----
// FAKE_CLAUDE_VERSION_FILE: the "installed" version lives in a file (default 9.9.9) — read when the
// process starts, like a binary knows its own version — and a successful `update` below writes the next
// patch level into it, so a test can prove the panel shows the NEW number after an update and never a
// cached old one. Only a file under the OS temp dir is written (same fence as `updatemissing`).
// FAKE_CLAUDE_VERSION_MS holds `--version` open after that read: a version query that is still running
// when the update starts (the race lib/cli's cacheGen guards).
const versionFile = () => {
  const os = require('os'), path = require('path');
  const f = String(process.env.FAKE_CLAUDE_VERSION_FILE || '');
  return (f && path.resolve(f).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase() + path.sep)) ? f : '';
};
const installedVersion = () => {
  const f = versionFile();
  try { return (f && require('fs').readFileSync(f, 'utf8').trim()) || '9.9.9'; } catch { return '9.9.9'; }
};
if (argv[0] === '--version') {
  const v = installedVersion();
  const hold = Number(process.env.FAKE_CLAUDE_VERSION_MS) || 0;
  if (hold > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hold);
  process.stdout.write(v + ' (fake-claude)\n');
  process.exit(0);
}
// `--help` — lib/cli.js cliHelpFlags reads it to decide whether `--system-prompt-snapshot` may be passed
// (PR-S: an older CLI rejects an unknown option and the chat would not start). Shaped like commander's
// output, because the parser only takes OPTION lines (≤ 8 spaces of indent, then a dash): the snapshot
// entry's own description mentions `--append-system-prompt` 40 spaces deep, and that is the line the
// parser must NOT count, so it is reproduced here as the real binary prints it.
// FAKE_CLAUDE_HELP=old: the same help WITHOUT the snapshot flag (a CLI that predates it) · =fail: no output,
// exit 1 (a probe that proves nothing). Without a handler the probe would fall through into chat mode.
// FAKE_CLAUDE_HELP_MS holds the answer: the window between the server's boot pre-warm and its first answer,
// in which a chat start must WAIT for the probe instead of starting without the flag (or a second probe).
// FAKE_CLAUDE_ARGV_OUT gets a `["--help"]` line per probe, so a test can count probes at server level.
// The CHAT mode below needs no change for the flag itself: it validates no options and only reads the
// ones it emulates (argVal), so `--system-prompt-snapshot off` is tolerated as it is.
if (argv[0] === '--help' || argv[0] === '-h') {
  const mode = process.env.FAKE_CLAUDE_HELP || '';
  if (process.env.FAKE_CLAUDE_ARGV_OUT) { try { require('fs').appendFileSync(process.env.FAKE_CLAUDE_ARGV_OUT, JSON.stringify(argv) + '\n'); } catch { /* */ } }
  const hold = Number(process.env.FAKE_CLAUDE_HELP_MS) || 0;
  if (hold > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hold);
  if (mode === 'fail') process.exit(1);
  const lines = [
    'Usage: claude [options] [command] [prompt]', '', 'Options:',
    '  --add-dir <directories...>            Additional directories to allow tool',
    '                                        access to',
    '  --allowedTools, --allowed-tools <tools...>',
    '      Comma or space-separated list of tool names to allow (e.g. "Bash(git *)',
    '      Edit")',
    '  --append-system-prompt <prompt>       Append a system prompt to the default',
    '                                        system prompt',
    '  -p, --print                           Print response and exit (useful for pipes)',
    '  --system-prompt <prompt>              System prompt to use for the session',
  ];
  if (mode !== 'old') {
    lines.push(
      '  --system-prompt-snapshot <on|off>     Record the system prompt once per',
      '                                        conversation and reuse it verbatim on',
      '                                        every request and resume. on (the',
      '                                        default): the prompt is rendered on the',
      '                                        conversation\'s first request — a',
      '                                        --system-prompt or',
      '                                        --append-system-prompt included — sent,',
      '                                        and recorded (fake-claude)',
    );
  }
  lines.push('  -v, --version                         Output the version number', '');
  process.stdout.write(lines.join('\n'));
  process.exit(0);
}
// EVERY non-chat subcommand below MUST exit. An argv nobody handles falls through to chat mode at the
// bottom of this file and blocks on stdin until the CALLER's own timeout — 45 s for /api/doctor, 90 s
// for /api/enhance — so a forgotten handler shows up as a slow test, never as a failing one.
// These exist because the routes that run them used to spawn CLAUDE_EXE directly, outside the
// CLAUDE_UI_FAKE_BIN seam: their success branch had never run in a test (see lib/cli.js claudeSpawn).
// `claude doctor` — /api/doctor just forwards stdout+stderr, so the content only has to be recognisable.
if (argv[0] === 'doctor') {
  process.stdout.write(['Claude Code Doctor (fake-claude)', '', '✔ Installation: ok', '✔ Auth: ok', '✔ MCP: 0 servers configured', ''].join('\n'));
  process.exit(0);
}
// `claude auth status` — server.js JSON.parse()s this stdout into `status`, so it has to be valid JSON.
if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write(JSON.stringify({
    authenticated: true, method: 'fake-claude', account: { email: 'fake@example.invalid', organization: 'Fake Org' }, scopes: ['user:inference'],
  }) + '\n');
  process.exit(0);
}
if (argv[0] === 'mcp') {
  const sub = argv[1] || '';
  // `mcp list` answers NOTHING by default, and that is load-bearing: test/mcp-update.test.js pins the
  // fix for „the Update button stopped working when the health call came back empty", so its whole
  // premise is an empty list. A populated answer is opt-in via FAKE_CLAUDE_MCP_LIST, whose value is
  // written through verbatim — the test owns the exact lines it wants parsed.
  if (sub === 'list') { process.stdout.write(process.env.FAKE_CLAUDE_MCP_LIST || 'No MCP servers configured.\n'); process.exit(0); }
  // `mcp get <name>` — the layout lib/mcp parseMcpGet reads: two spaces for a field, four for an entry
  // inside Environment:/Headers:. One secret-looking env key and one harmless one, so a test can prove
  // that mcpGetPayload masks the first and keeps the second.
  // FAKE_CLAUDE_MCP_GET_SILENT: a comma list of names `mcp get` answers NOTHING for. That is the shape
  // of a server whose `mcp get` hit its deadline or errored — the branch where GET /api/mcp/inventory
  // falls back to the configured transport string. Keyed by NAME and not by a global switch, so the
  // suite's other `mcp get` cases keep their normal answer.
  if (sub === 'get') {
    const name = argv[2] || 'server';
    // FAKE_CLAUDE_MCP_GET_SLOW_FILE + FAKE_CLAUDE_MCP_GET_MS: while that marker file exists, the NEXT `mcp get` takes it
    // and answers late — an await of the start route a test can hold open for exactly one request (projects-start)
    const slowMark = process.env.FAKE_CLAUDE_MCP_GET_SLOW_FILE;
    if (slowMark) { let took = false; try { require('fs').unlinkSync(slowMark); took = true; } catch { /* not armed */ } if (took) { const until = Date.now() + (Number(process.env.FAKE_CLAUDE_MCP_GET_MS) || 0); while (Date.now() < until) { /* hold */ } } }
    if (String(process.env.FAKE_CLAUDE_MCP_GET_SILENT || '').split(',').filter(Boolean).includes(name)) { process.stdout.write('\n'); process.exit(0); }
    process.stdout.write([
      name + ':', '  Scope: User config', '  Status: ✔ connected', '  Type: stdio',
      '  Command: node', '  Args: fake-mcp-server.js --flag', '  Environment:',
      '    FAKE_MCP_TOKEN=s3cr3t-value-not-to-be-echoed', '    FAKE_MCP_MODE=readonly', '',
    ].join('\n'));
    process.exit(0);
  }
  // add/remove/login/logout all answer one line and exit 0; the routes only forward `output`.
  if (sub === 'add') { process.stdout.write('Added MCP server ' + (argv[2] || '?') + ' (fake-claude)\n'); process.exit(0); }
  if (sub === 'remove') { process.stdout.write('Removed MCP server ' + (argv[2] || '?') + ' (fake-claude)\n'); process.exit(0); }
  if (sub === 'login') { process.stdout.write('Open this URL to finish login: https://example.invalid/oauth (fake-claude)\n'); process.exit(0); }
  if (sub === 'logout') { process.stdout.write('Logged out of ' + (argv[2] || '?') + ' (fake-claude)\n'); process.exit(0); }
  process.stdout.write('\n'); process.exit(0);
}
// The ONE-SHOT `-p <prompt> --output-format json` behind POST /api/enhance. Note the discriminator: the
// chat argv in lib/chat.js ALSO starts with `-p`, but with no positional prompt and
// `--output-format stream-json` — so a real chat must still reach the stream-json mode below.
// This is the handler that matters most: without it the route runs the machine's real binary, and that
// is a genuine, PAID model turn started by `node --test`.
if (argv[0] === '-p' && argv[1] && argv[1][0] !== '-' && argVal('--output-format') === 'json') {
  const prompt = argv[1];
  // Echo the TAIL of the prompt back: /api/enhance wraps the user's text behind a `---\n` separator, so
  // a test can assert its own text made it through the meta-prompt into the answer it gets back.
  const tail = prompt.split('\n---\n').pop();
  const improved = process.env.FAKE_CLAUDE_ENHANCE || ('VERBESSERT: ' + tail);
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: improved }) + '\n');
  process.exit(0);
}
// `claude update` — the panel's CLI-update button spawns exactly this. FAKE_CLAUDE_SCENARIO=updatefail
// reproduces the failure that actually matters on Windows: the running binary is locked against replacement.
if (argv[0] === 'update' || argv[0] === 'upgrade') {
  const sc = process.env.FAKE_CLAUDE_SCENARIO || '';
  const done = () => {
    if (sc === 'updatefail') {
      process.stderr.write('EBUSY: resource busy or locked, unlink \'bin\\claude.exe\'\n');
      process.exit(1);
    }
    // `updatemissing`: the updater moved the binary aside (`<exe>.old.<ts>`) and then failed to write
    // the new one — the panel is left without claude.exe (B2). Renames CLAUDE_UI_CLAUDE_BIN, and ONLY
    // when that is a file under the OS temp dir, so the scenario can never move a real install.
    if (sc === 'updatemissing') {
      const fs = require('fs'), os = require('os'), path = require('path');
      const exe = String(process.env.CLAUDE_UI_CLAUDE_BIN || '');
      const tmp = path.resolve(os.tmpdir()).toLowerCase();
      if (exe && path.resolve(exe).toLowerCase().startsWith(tmp + path.sep) && fs.existsSync(exe)) {
        try { fs.renameSync(exe, exe + '.old.' + Date.now()); } catch { /* */ }
      }
      process.stderr.write('Error: failed to write new binary (fake-claude)\n');
      process.exit(1);
    }
    const vf = versionFile();
    if (vf) {
      const from = installedVersion();
      const to = from.replace(/(\d+)$/, (n) => String(Number(n) + 1));
      require('fs').writeFileSync(vf, to);
      process.stdout.write('Successfully updated from ' + from + ' to version ' + to + ' (fake-claude)\n');
      process.exit(0);
    }
    process.stdout.write('Already up to date (fake-claude)\n');
    process.exit(0);
  };
  // FAKE_CLAUDE_UPDATE_MS holds the update open, so a test can probe the panel WHILE it runs (B1).
  // A synchronous sleep, not setTimeout: the chat-mode code below runs at top level and must never be
  // reached by an `update` invocation.
  const hold = Number(process.env.FAKE_CLAUDE_UPDATE_MS) || 0;
  if (hold > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hold);
  done();
}

// ---- chat (stream-json) mode ----
// FAKE_CLAUDE_ARGV_OUT (any scenario): append this process's argv as one JSON line. test/chatargs.test.js
// proves startChat's argv with an argv-printing stand-in, but only a SERVER-booted run proves the whole
// chain — prefs → the --help probe → buildSpawnPolicy → argv (PR-S: `--system-prompt-snapshot off` from the
// start route). Best-effort, like FAKE_CLAUDE_CONTROL_OUT: a missing dir must not kill the chat.
if (process.env.FAKE_CLAUDE_ARGV_OUT) { try { require('fs').appendFileSync(process.env.FAKE_CLAUDE_ARGV_OUT, JSON.stringify(argv) + '\n'); } catch { /* */ } }
const scenario = process.env.FAKE_CLAUDE_SCENARIO || 'echo';
// `--resume <id> --fork-session` is a NEW session: the real CLI writes a transcript of its own and reports the
// new id on its first frame. This fake answered with the SOURCE id, so a fork was indistinguishable from a
// plain resume — and everything the panel keys by the fork's id (session-mcp.json, the tab's sessionId) went
// untested; the fork trap of P-0 lived exactly there (test/start-fork.test.js).
const sessionId = (argVal('--resume') && argv.includes('--fork-session')) ? crypto.randomUUID()
  : (argVal('--resume') || argVal('--session-id') || crypto.randomUUID());
// `silent` says nothing at all — not even `init` — and stays alive on stdin. That is the shape of a
// start that has not identified itself yet; combined with killing the panel server (→ the SSE closes
// with no session id in hand) it is the only way to reproduce the window the start watchdog in
// chat-events.js guards. Every other scenario is unaffected.
const emit = (obj) => { if (scenario === 'silent') return; process.stdout.write(JSON.stringify(obj) + '\n'); };
const finishTurn = (n) => emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: n, session_id: sessionId, usage: { input_tokens: 1, output_tokens: 1 } });

// The model in force. `init` reports the LAUNCH model, but a `set_model` control changes it mid-session
// and every assistant frame carries the model that actually served the turn — the panel relies on both,
// so the fake has to model that too (it used to report a model exactly once and never again).
let curModel = argVal('--model') || 'fake-model';
// The two session-scoped flag settings the panel switches live (apply_flag_settings). Ultracode may also
// arrive at SPAWN as an extra `--settings {"ultracode":true}` layer, which is how the panel starts a chat
// with it on — so the initial value is read from argv, exactly like the model above.
let curEffort = argVal('--effort') || '';
// the CLI's own ladder (`--effort <level>` help: „low, medium, high, xhigh, max"). Anything else — and ''
// — is silently ignored by apply_flag_settings, which the handler below reproduces.
const EFFORT_NAMES = ['low', 'medium', 'high', 'xhigh', 'max'];
let ucRequested = (() => {
  try { return JSON.parse(argVal('--settings') || '{}').ultracode === true; } catch { return false; }
})();

// G5 — the two `system` frames the panel only receives because lib/chat.js now sets
// CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS. Field for field as captured from 2.1.286 on 2026-10-02
// (ccui-probe/runs/paid-2026-10-02T19-55-29-267Z/raw-frames.ndjson): a session_state_changed carries
// `state` and NOTHING else besides uuid/session_id — all ten frames of the two paid runs, no exceptions.
// Nothing is added here: a field invented in this file is a field the panel learns to read and the real
// CLI never sends (it has happened once already — a `post_tokens` that never existed).
const sessionState = (state) => emit({ type: 'system', subtype: 'session_state_changed', state, uuid: crypto.randomUUID(), session_id: sessionId });
// `commands_changed` carries the FULL catalogue. The three entries below reproduce the three SHAPES the
// measured list of 60 actually had — a plain user command, one with `builtin: true` (45 of 60) and one
// with `aliases` (9 of 60, e.g. `frontend-design:frontend-design` → `frontend-design`) — because the
// irregularity is what the panel's reader has to survive. Measured position: it arrives BEFORE `init`
// (_seq 4 against _seq 8), which is also the earliest moment the real catalogue exists.
const commandsChanged = () => emit({
  type: 'system', subtype: 'commands_changed', uuid: crypto.randomUUID(), session_id: sessionId,
  commands: [
    { name: 'mein-tag', description: 'Mein Tag (Scrum Master) (user)', argumentHint: '' },
    { name: 'code-review', description: 'Review the current diff', argumentHint: '[low|medium|high] [--fix]', builtin: true },
    { name: 'frontend-design:frontend-design', description: '(frontend-design) visual design guidance', argumentHint: '', aliases: ['frontend-design'] },
  ],
});
if (scenario === 'sessionstate') commandsChanged();

// What `get_context_usage` answers (the control the panel's context line reads). Both numbers move with
// the MODEL, as the real ones do: an "[1m]" alias or sonnet-5 is a 1M window, opus-5 and haiku are 200K —
// and the base context differs per model too, because each carries its own system prompt and tool
// definitions. So a test can `set_model` and watch BOTH halves move, which is the bug this control exists
// to fix. (The pairing of NAME to window is this fixture's own, and the 2026-10-03 run showed the real CLI
// does not follow it — it answered 1 000 000 for „claude-opus-5". Kept anyway: what the fixture is for is a
// pair of windows that differ across a switch, and the panel READS the window instead of deriving it from
// the name, so which name carries which number is the fixture's business. The one place that must not copy
// the shortcut is the panel — see public/js/ctx.js.)
//
// CORRECTED 2026-10-03 against the real answer (free, CLI 2.1.288 — C:/Users/you/ccui-ctxprobe/
// ctx-probe-result.json). Three things here were a fiction, and the middle one was the costly one:
//  · `gridRows` was modelled as TEXT ROWS with a per-MCP-tool breakdown („⛶ mcp__sap-adt__read_source |
//    412 tokens"). It is really a 10 × 20 = 200-cell SQUARE grid of objects — the coloured blocks /context
//    paints — whose `tokens`/`percentage` REPEAT the category aggregate (187 of 200 cells carry the same
//    number). It is reproduced in that shape below, because the route's job is to strip it and a strip
//    proven against the wrong shape proves nothing.
//  · the per-MCP-tool breakdown lives in `mcpTools`, a field this fixture did not have at all — and it is
//    where PR-11's per-SERVER share comes from. Added, with full `mcp__…` tool names, so the route can be
//    proven to aggregate them to server names instead of passing them through.
//  · the „Autocompact buffer" row was computed as 10 % of the window. Measured it is
//    maxTokens − autoCompactThreshold (1 000 000 − 967 000 = 33 000), which is 3,3 % — so the 10 % here was
//    not a rounding difference but a different rule. The absolute 33 000 is kept for BOTH windows on
//    purpose: at 200 K that is 16,5 %, so any code that re-derives the buffer as a percentage of the window
//    disagrees with the fixture in both directions and the test goes red.
// The TWO identities the real answer held exactly in all three reads are held here too, for every model —
// Σ(kind==='used') === totalTokens and Σ(used)+buffer+free === maxTokens — because they are what makes a
// READ breakdown checkable (public/js/ctx-breakdown.js). The deferred rows lie outside both, as measured.
const FAKE_MCP_TOOLS = [
  // one entry per MCP tool, exactly the four measured fields. `isLoaded` is false on all of them, as in
  // every measured read — the whole MCP block sat in the DEFERRED category there.
  { name: 'mcp__sap-adt__read_source', serverName: 'sap-adt', tokens: 412, isLoaded: false },
  { name: 'mcp__sap-adt__write_source', serverName: 'sap-adt', tokens: 530, isLoaded: false },
  { name: 'mcp__sap-adt__activate', serverName: 'sap-adt', tokens: 301, isLoaded: false },
  { name: 'mcp__jira__jira_get_issue', serverName: 'jira', tokens: 389, isLoaded: false },
  { name: 'mcp__jira__jira_search', serverName: 'jira', tokens: 420, isLoaded: false },
  { name: 'mcp__snow-mcp__list_incidents', serverName: 'snow-mcp', tokens: 355, isLoaded: false },
];
function contextUsage() {
  const m = String(curModel);
  const maxTokens = /\[1m\]|sonnet-5/i.test(m) ? 1000000 : 200000;
  const totalTokens = /sonnet-5/i.test(m) ? 34021 : /opus-5/i.test(m) ? 18529 : 12345;
  // measured relation, not a percentage of the window (see above)
  const autoCompactThreshold = maxTokens - 33000;
  const buffer = maxTokens - autoCompactThreshold;
  // the per-server sum IS the category value — that equality is the counter-check the route refuses to
  // answer without, so it is derived from the array here and cannot drift apart from it
  const mcpDeferred = FAKE_MCP_TOOLS.reduce((a, t) => a + t.tokens, 0);
  const categories = [
    { name: 'System prompt', tokens: 3200, color: 'promptBorder', kind: 'used' },
    { name: 'Skills', tokens: 2997, color: 'warning', kind: 'used' },
    { name: 'Memory files', tokens: 730, color: 'claude', kind: 'used' },
    // the remainder row, so Σ(used) === totalTokens holds for every model this fixture answers for
    { name: 'System tools', tokens: totalTokens - 3200 - 2997 - 730, color: 'inactive', kind: 'used' },
    { name: 'MCP tools (deferred)', tokens: mcpDeferred, color: 'inactive', isDeferred: true, kind: 'deferred' },
    { name: 'System tools (deferred)', tokens: 14712, color: 'inactive', isDeferred: true, kind: 'deferred' },
    { name: 'Autocompact buffer', tokens: buffer, color: 'inactive', kind: 'buffer' },
    { name: 'Free space', tokens: maxTokens - totalTokens - buffer, color: 'promptBorder', kind: 'free' },
  ];
  // the square grid: 200 cells, each repeating ITS CATEGORY's aggregate — deferred rows do not appear in
  // it at all (measured: six distinct value pairs across all 200 cells)
  const inGrid = categories.filter((c) => c.kind !== 'deferred');
  const cells = [];
  inGrid.forEach((c) => {
    const n = Math.max(1, Math.round(c.tokens / maxTokens * 200));
    for (let i = 0; i < n && cells.length < 200; i++) {
      cells.push({ color: c.color, isFilled: true, categoryName: c.name, tokens: c.tokens, percentage: Math.round(c.tokens / maxTokens * 100), squareFullness: 1 });
    }
  });
  while (cells.length < 200) cells.push({ ...cells[cells.length - 1] });
  const gridRows = [];
  for (let r = 0; r < 10; r++) gridRows.push(cells.slice(r * 20, r * 20 + 20));
  return {
    categories,
    totalTokens,
    maxTokens,
    rawMaxTokens: maxTokens, // the same expression as maxTokens in the binary (`rawMaxTokens: ze`) — never a second number
    autocompactSource: 'model-default',
    percentage: Math.round(totalTokens / maxTokens * 100), // the CLI computes AND ROUNDS it (Math.round, read from the binary)
    gridRows,
    model: m,
    mcpTools: FAKE_MCP_TOOLS,
    autoCompactThreshold,
    isAutoCompactEnabled: true,
  };
}

// What `get_hooks_listing` answers. MEASURED 2026-10-03: four fields DELIVERED (the schema has seven — three
// are spread in conditionally, see public/js/hooks-catalog.js), and the two the panel did not know are the
// ones PR-11 builds on — `eventCatalog` (every event in lifecycle order, each with the /hooks summary and
// whether its hooks take a matcher) and `policy`.
// Deliberately NOT all 33 events here: a fixture that repeats the real list would let a test pass that only
// checks „33 rows arrived". What matters for the panel is the SHAPE and the three-valued matcher question,
// so this carries a handful — including `Stop`, which takes NO matcher although the editor's old hint said
// it did, and `SessionStart`, which DOES although the hint said it did not.
// TWO SHAPE CORRECTIONS found in review of PR-11, and both were invented values this file handed out as if
// they were measured:
//  · `editable` was a BOOLEAN here. In the schema it is an OBJECT — { matcher, config, headersRedacted? },
//    present „only on rows from a settings file this session reads and may write" — and BOTH measured rows
//    carried one. A route strip proven against the wrong shape proves nothing: that is the lesson this very
//    file records for `gridRows` a few blocks up, re-made here. The object form stands now, and it is ABSENT
//    on the plugin row, because that is how the CLI says „this session may not write this row".
//  · `source: 'plugin'` is not a name the CLI emits. The raw palette is userSettings · projectSettings ·
//    localSettings · pluginHook · sessionHook · builtinHook · policySettings (claude.exe 2.1.288 @230465227
//    tests `o.source==="sessionHook"||o.source==="pluginHook"||o.source==="builtinHook"`).
function hooksListing() {
  return {
    events: [{ name: 'PostToolUse', summary: 'After tool execution', supportsMatcher: true, hookCount: 1 }],
    hooks: [{
      event: 'PostToolUse', matcher: 'Edit|Write', source: 'userSettings',
      sourceLabel: 'User settings (~/.claude/settings.json)', type: 'command',
      displayText: 'echo hook', commandText: 'echo hook', contentLabel: 'command',
      editable: { matcher: 'Edit|Write', config: { type: 'command', command: 'echo hook' } },
    }, {
      // the half the panel cannot see on its own: a hook that is NOT in the user's settings files — and
      // therefore with no `editable` at all
      event: 'SessionStart', matcher: '', source: 'pluginHook', sourceLabel: 'Plugin (demo-plugin)',
      type: 'command', displayText: 'echo plugin-hook', commandText: 'echo plugin-hook',
      contentLabel: 'command', runsInBackground: true,
    }],
    eventCatalog: [
      { name: 'PreToolUse', summary: 'Before tool execution', supportsMatcher: true },
      { name: 'PostToolUse', summary: 'After tool execution', supportsMatcher: true },
      { name: 'UserPromptSubmit', summary: 'When the user submits a prompt', supportsMatcher: false },
      { name: 'Stop', summary: 'Right before Claude concludes its response', supportsMatcher: false },
      { name: 'SessionStart', summary: 'When a new session is started', supportsMatcher: true },
      { name: 'MessageDisplay', summary: 'While assistant message text is displayed', supportsMatcher: false },
    ],
    policy: { disabledByPolicy: false, managedOnly: false, pluginOnly: false, allDisabled: false, policyHookCount: 0 },
  };
}

// ---- the MCP side of the control channel (G4) -------------------------------------------------------
// FAKE_CLAUDE_MCP_SERVERS: a JSON array of rows, each `{name, status, next?, error?, scope?, tools?}` —
// the state this session reports for `mcp_status`. Default EMPTY, like `mcp list` further up: a test owns
// the servers it wants to see, and a session launched with `--strict-mcp-config` on an empty config really
// does report `mcpServers: []`.
//   `next` = the status an enable / a reconnect moves the row to. Default 'connected'. A `next` that is
//   NOT 'connected' is how the refusal arms are reached, because the CLI's verdict mapper (`lt()`) calls
//   only 'connected' a success: 'failed' becomes the error „Connection failed", anything else
//   „Server status: <type>".
// FAKE_CLAUDE_MCP_SILENT=1: never answer mcp_toggle/mcp_reconnect at all — the shape of a dial that
// outruns the panel's ceiling (the CLI connects under MCP_CONNECT_TIMEOUT_MS and only then runs
// tools/list), which is what has to arrive in the UI as „unbestätigt" rather than as a green switch.
// FAKE_CLAUDE_MCP_MS: hold the ANSWER by this many ms (a timer, so stdin keeps being read).
const mcpRows = (() => {
  try {
    const raw = JSON.parse(process.env.FAKE_CLAUDE_MCP_SERVERS || '[]');
    return Array.isArray(raw) ? raw.filter((r) => r && r.name).map((r) => Object.assign({ status: 'connected' }, r)) : [];
  } catch { return []; }
})();
const mcpFind = (name) => mcpRows.find((r) => r.name === name) || null;
// One row as the response schema (`eo()`) declares it — field for field, because the panel reads these
// names: serverInfo only when connected („available when connected"), error only on failure, `config`
// carrying the URL for HTTP servers, plus scope/source/tools.
function mcpWireRow(r) {
  const out = { name: r.name, status: r.status };
  if (r.status === 'connected') { out.serverInfo = { name: r.name, version: r.version || '1.0.0' }; out.tools = (r.tools || []).map((t) => (typeof t === 'string' ? { name: t } : t)); }
  if (r.status === 'failed' && r.error) out.error = r.error;
  if (r.errorCode) out.error_code = r.errorCode;
  if (r.scope) out.scope = r.scope;
  if (r.source) out.source = r.source;
  // `headers` / `env` are emitted when the fixture asks for them, and that is the point: the real CLI puts
  // them here IN THE CLEAR (measured — a probe token came back as `Authorization: Bearer …` at scope
  // `dynamic`, and still did after the server was disabled). A fake that could only produce `{type, url}`
  // made the leak untestable: the F1-family test that proves no secret reaches the browser had nothing to
  // bite on, and the leak shipped with a green suite.
  if (r.url || r.headers || r.env || r.command) {
    out.config = { type: r.command ? 'stdio' : (r.type || 'http') };
    if (r.command) out.config.command = r.command;
    if (r.url) out.config.url = r.url;
    if (r.headers) out.config.headers = r.headers;
    if (r.env) out.config.env = r.env;
  }
  return out;
}
// The verdict both mcp_toggle and mcp_reconnect go through. ONE function here because it is one function in
// the binary (`lt()`), and a fake with two opinions could let a test pass that the CLI would fail.
function mcpVerdict(r) {
  if (r.status === 'connected') return null;                               // success, empty payload
  if (r.status === 'failed') return r.error || 'Connection failed';
  return 'Server status: ' + r.status;
}

// ---- tasks that can be stopped (G6) -----------------------------------------------------------------
// The tasks this process believes are running, by task_id → {kill}. `stop_task` is answered out of this
// registry so that the three measured outcomes are all reachable:
//   · a LIVE task      → really killed (frames follow), success {}
//   · a FINISHED task  → success {} with no frames — the CLI smooths `not_running` with a terminal status
//                        into success, which is exactly why a success may not be read as „I stopped it"
//   · an UNKNOWN id    → the refusal „No task found with ID: <id>" — the message VERBATIM, with no
//                        `StopTask: <code>` prefix. That prefix is the second StopTaskError argument and
//                        lands in `telemetryMessage`; the wire carries `o.message`. This fake used to invent
//                        the prefix, so the end-to-end test confirmed a parser that returned '' against the
//                        real CLI — a test proving its own fixture.
const liveTasks = new Map();
const doneTasks = new Set();

// FAKE_CLAUDE_IGNORE_EOF=1: a CLI that does NOT exit when the panel closes its stdin (stuck on an MCP
// server, mid-flush) — only a kill ends it. Its init then also carries its pid, so a test can check
// from outside that the panel really ended it (and when).
const ignoreEof = !!process.env.FAKE_CLAUDE_IGNORE_EOF;
// FAKE_CLAUDE_FORK_SOURCE_FRAME=<id>: a fork of <id> speaks with the SOURCE id once before its own. The panel stores a
// fork's MCP scope under whatever id the stream reports first (chat.onSessionId) and refuses the source id there;
// with every fork of this fake starting on its new id, that refusal never ran and could be deleted with all tests
// green. A `system` frame of a subtype nobody reads, so it moves nothing but the id capture.
const forkSourceFrame = String(process.env.FAKE_CLAUDE_FORK_SOURCE_FRAME || '');
if (forkSourceFrame && argv.includes('--fork-session') && argVal('--resume') === forkSourceFrame) {
  emit({ type: 'system', subtype: 'fake_fork_source', session_id: forkSourceFrame });
}
// init — carries session_id at top level so the server captures it and pushes a synthetic `_session` frame.
// FAKE_CLAUDE_LATE_INIT=1 holds it until the first user message: the real CLI emits NOTHING at spawn in
// `-p --input-format stream-json` (measured 2026-10-02, CTX-4 in public/js/chat-events.js), so a resumed or
// forked tab has no frame — and a fork no id — until somebody writes. Sending init at once made every browser
// check of that window pass against a CLI that does not exist (a fork's MCP picker read its scope by an id the
// real fork does not have yet; see forkCopyLaunch in public/js/chat.js).
const lateInit = !!process.env.FAKE_CLAUDE_LATE_INIT;
let initSent = false;
const sendInit = () => {
  if (initSent) return; initSent = true;
  emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), model: curModel, permissionMode: argVal('--permission-mode') || 'default', tools: [], mcp_servers: [], slash_commands: ['clear', 'compact', 'help'], ...(ignoreEof ? { pid: process.pid } : {}) });
};
if (!lateInit) sendInit();

if (scenario === 'crash') { emit({ type: 'result', subtype: 'error', is_error: true, session_id: sessionId }); process.exit(1); }

let turn = 0;
// What runs when the panel answers the held gate of this turn (openpoints-plan/-ask, planprogress). It is handed
// the control_response itself — planprogress reads the approval's message out of it. Unset → the generic
// „permission answered → done" below.
let afterGate = null;
// CHAT-FLOW-8 — a block the turn does NOT end with. The questions match the `openpoints` scenario on purpose:
// asking the same thing in a later turn must not stack a second card.
const opBlock = () => ['```offene-punkte', JSON.stringify([
  { frage: 'Welches Werk ist gemeint?', warum: 'Ich kartiere erst mal beide', optionen: ['Werk 1', 'Werk 2'] },
  { frage: 'Soll das PDF mit angehängt werden?', warum: 'Der Kommentar steht so oder so' },
]), '```'].join('\n');
const say = (content) => emit({ type: 'assistant', message: { role: 'assistant', model: curModel, content } });

// ---- PF-1: plan progress (planprogress · planprogress-compact) -------------------------------------------
// An ExitPlanMode held at its gate, and — once the panel approves it — a model that keeps the plan protocol: the
// approval carries the suggested steps as a ```plan-schritte block, and the model answers with ```plan-status
// reports, staggered by `hold` so a browser check can watch the rail move:
//   S1 (list confirmed, + a Read with its result) → S2 (S1 done) → a block that is NOT JSON → an unknown S9 →
//   S1..S3 done + fertig.   `planprogress-compact` stops after S2 with a compact_boundary instead (the rail's
//   „Stand ggf. veraltet") and leaves the rest to [Stand abfragen].
// An approval WITHOUT the step block (the switch off, an older panel, „Weiter planen") is answered „Weiter geplant."
// A user message that carries a ```plan-schritte block is [Stand abfragen]: answered with where things stand.
//
// These two (and PF-1b's planorphan · planself below) also WRITE A TRANSCRIPT — the one thing the real CLI does
// that this fake otherwise never does — because what they exist to prove ends in the resume fold
// (lib/sessions.js parseTranscript): a tab reloaded after the run must read back the same 3/3 its rail showed
// live. The lines are the CLI's shapes as measured in the live corpus (the panel's answer becomes an is_error
// tool_result plus `toolUseResult: "Error: <message>"` and `toolDenialKind: "permission-rule"`), the directory is
// the CLI's (`projects/<cwd, non-alphanumerics → '-'>`), and the plan file goes where the CLI keeps it
// (`plans/testplan.md`), so [Plan öffnen] has a „Datei-Stand" to show. Written ONLY under a CLAUDE_UI_CLAUDE_DIR
// inside the OS temp dir (a test sandbox): never a real ~/.claude. Every other scenario stays transcript-free
// (bgagent's sidechain `.output` lives under the OS temp dir, not in `projects/`), so no suite that counts the
// fixture corpus can be moved by this.
const PP_PLAN = '# Testplan\n## Umsetzung\n### 1. Modul\n### 2. Route\n### 3. Tests';
function ppClaudeDir() {
  const os = require('os'), path = require('path');
  const d = String(process.env.CLAUDE_UI_CLAUDE_DIR || '');
  return (d && path.resolve(d).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase() + path.sep)) ? d : '';
}
let ppParent = null; // the previous line's uuid — the CLI chains its lines through parentUuid
function ppTranscript(obj) {
  const dir = ppClaudeDir();
  if (!dir) return;
  const fs = require('fs'), path = require('path');
  const proj = path.join(dir, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  const uuid = crypto.randomUUID();
  const line = Object.assign({ parentUuid: ppParent, isSidechain: false, userType: 'external', entrypoint: 'sdk-cli', cwd: process.cwd(), sessionId, slug: 'testplan', uuid, timestamp: new Date().toISOString() }, obj);
  ppParent = uuid;
  try { fs.mkdirSync(proj, { recursive: true }); fs.appendFileSync(path.join(proj, sessionId + '.jsonl'), JSON.stringify(line) + '\n'); } catch { /* sandbox gone — the stream is what the live tab reads */ }
}
// The plan file, written like the CLI writes it before ExitPlanMode. Without a sandbox the path is still handed
// over (the panel only displays it then — planFileName() gives no name outside a `plans` folder).
function ppPlanFile(name, content) {
  const path = require('path'), os = require('os'), dir = ppClaudeDir();
  const base = name || 'testplan.md';
  if (!dir) return path.join(os.tmpdir(), base);
  const f = path.join(dir, 'plans', base);
  try { require('fs').mkdirSync(path.dirname(f), { recursive: true }); require('fs').writeFileSync(f, (content || PP_PLAN) + '\n'); } catch { /* */ }
  return f;
}
const ppSay = (content) => {
  say(content);
  const toolUse = content.some((b) => b && b.type === 'tool_use');
  ppTranscript({ type: 'assistant', message: { role: 'assistant', model: curModel, content, stop_reason: toolUse ? 'tool_use' : 'end_turn' } });
};
const ppResult = (id, content, extra, top) => {
  const message = { role: 'user', content: [Object.assign({ type: 'tool_result', tool_use_id: id, content }, extra || {})] };
  emit({ type: 'user', session_id: sessionId, message });
  ppTranscript(Object.assign({ type: 'user', message }, top || {}));
};
const ppStatus = (o) => '```plan-status\n' + JSON.stringify(o) + '\n```';
// The list the approval carried — a cooperative model confirms it in its first report (its titles, its IDs).
function ppSteps(msg) {
  const m = /```plan-schritte[ \t]*\r?\n([\s\S]*?)```/.exec(msg);
  try { const v = m ? JSON.parse(m[1]) : null; if (Array.isArray(v) && v.length) return v.map((s) => ({ id: s.id, titel: s.titel })); } catch { /* */ }
  return [{ id: 'S1', titel: 'Modul' }, { id: 'S2', titel: 'Route' }, { id: 'S3', titel: 'Tests' }]; // an empty block → the model lists them
}
function planProgressTurn(sc, later, said) {
  ppTranscript({ type: 'user', message: { role: 'user', content: said } });
  if (said.indexOf('```plan-schritte') >= 0) {
    ppSay([{ type: 'text', text: 'S1 und S2 sind erledigt, ich bin bei S3.\n\n' + ppStatus({ aktuell: 'S3', erledigt: ['S1', 'S2'], aktiv: 'Schreibe die Tests' }) }]);
    later(() => { ppSay([{ type: 'text', text: 'Alles umgesetzt.\n\n' + ppStatus({ erledigt: ['S1', 'S2', 'S3'], fertig: true }) }]); finishTurn(turn); });
    return;
  }
  const id = 'toolu_pp_' + turn;
  const input = { plan: PP_PLAN, planFilePath: ppPlanFile() };
  ppSay([{ type: 'text', text: 'Der Plan steht.' }, { type: 'tool_use', id, name: 'ExitPlanMode', input }]);
  emit({ type: 'control_request', request_id: 'req-' + turn, request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', tool_use_id: id, input } });
  afterGate = (ctrl) => {
    const r = (ctrl && ctrl.response && ctrl.response.response) || {};
    const msg = typeof r.message === 'string' ? r.message : '';
    // the panel answers a plan gate with deny + message in BOTH branches (a bare allow wedges stream-json); the
    // CLI records that message as an error tool_result, the way the live corpus shows it
    ppResult(id, msg || 'Denied by user', { is_error: true }, { toolUseResult: 'Error: ' + msg, toolDenialKind: 'permission-rule' });
    if (msg.indexOf('```plan-schritte') < 0) { ppSay([{ type: 'text', text: 'Weiter geplant.' }]); finishTurn(turn); return; }
    const read = 'toolu_pp_read_' + turn;
    ppSay([{ type: 'text', text: 'Ich lege los.\n\n' + ppStatus({ schritte: ppSteps(msg), aktuell: 'S1', aktiv: 'Lege das Modul an' }) },
      { type: 'tool_use', id: read, name: 'Read', input: { file_path: 'README.md' } }]);
    ppResult(read, '# README');
    later(() => {
      ppSay([{ type: 'text', text: ppStatus({ aktuell: 'S2', erledigt: ['S1'], aktiv: 'Verdrahte die Route' }) }]);
      if (sc === 'planprogress-compact') {
        // the frame as the CLI streams it ({trigger, pre_tokens}), the line as it stores it (compactMetadata)
        emit({ type: 'system', subtype: 'compact_boundary', session_id: sessionId, compact_metadata: { trigger: 'auto', pre_tokens: 180000 } });
        ppTranscript({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', level: 'info', compactMetadata: { trigger: 'auto', preTokens: 180000 } });
        later(() => { ppSay([{ type: 'text', text: 'Der Kontext wurde komprimiert — ich halte hier an.' }]); finishTurn(turn); });
        return;
      }
      later(() => {
        ppSay([{ type: 'text', text: 'Zwischenstand.\n\n```plan-status\n{"aktuell": S3 halb geschrieben\n```' }]);
        later(() => {
          ppSay([{ type: 'text', text: ppStatus({ aktuell: 'S9', aktiv: 'einen Schritt, den es nicht gibt' }) }]);
          later(() => { ppSay([{ type: 'text', text: 'Alles umgesetzt.\n\n' + ppStatus({ erledigt: ['S1', 'S2', 'S3'], fertig: true }) }]); finishTurn(turn); });
        });
      });
    });
  };
}

// ---- PF-1b: the plan nobody could approve (planorphan · planself) -------------------------------------------
// The 05.10. course, synthetically. The session runs in „Auto"; the model calls ExitPlanMode anyway, and the CLI
// refuses it BEFORE asking anybody — no can_use_tool, only an is_error tool_result „You are not in plan mode …" —
// and the turn ends. What the next user message says decides the rest:
//   · a ```plan-schritte block whose entries carry no status (▶ Plan starten, the composer chip): the model keeps the
//     protocol — confirms the list with "schritte" + "aktuell", then reports each step, staggered by `hold`, to „fertig";
//   · the protocol without such a block (📋 Schritte anfordern — or [Stand abfragen], whose entries carry a status):
//     the model answers with ITS list ("schritte", "aktuell" = where it is, "erledigt"), then works on to „fertig";
//   · anything else („plan starten" typed without the chip): the model works — a sentence and a Read — and reports
//     NOTHING, exactly like the session of 05.10.
// `planself` is the other half of the fix: no ExitPlanMode at all — the model sets its plan up on its own, with
// "titel", because the system hint asks it to (PLAN_PROGRESS_SYSTEM_HINT „auch ohne Freigabe gestartet").
// The proposal is made once per session: a resumed or forked process (`--resume`) has made it already. Tool ids
// are random — a resumed process counts its turns from 1 again, and a repeated id would be the same tool twice.
// The transcript is written like planprogress writes it (ppTranscript), so a reload and a resume fold it back.
const PO_PLAN = ['# Demoprojekt-Demo — lebender Plan (synthetisch)', '',
  '## 🔬 QA-LAUF (05.10.) — AKTUELLER AUFTRAG', '### Context', 'Warum dieser Lauf (synthetisch).', '### Entscheidungen', '- nur Testdaten',
  '### Schritt 0 — Inventar', 'Testdaten und Rollen.', '### ➕ ERWEITERUNG — Druckansicht', 'nachgereicht.',
  '### Schritt 1 — Workflow', 'Antrag bis Freigabe.', '### Schritt 2 — Abnahme', 'Bericht.', '### Verifikation', '- node --test', '',
  '## 📋 Älterer Auftrag (03.10.)', '### Schritt 1 — Alt', '### Schritt 2 — Alt'].join('\n');
const PO_OWN = [{ id: 'S1', titel: 'Inventar' }, { id: 'S2', titel: 'Workflow' }, { id: 'S3', titel: 'Abnahme' }];
const PO_ACT = ['Lege Testdaten und Rollen an', 'Baue den Workflow vom Antrag bis zur Freigabe', 'Schreibe den Abnahmebericht'];
let poProposed = !!argVal('--resume');
let poSticky = false; // bymsg: an `sc:planorphan` keeps the conversation with this scenario
const poId = (k) => 'toolu_po_' + k + '_' + crypto.randomUUID().slice(0, 8);
// The panel's plan-schritte block, read on its own terms (not with the panel's parser — a fake that used the code it
// tests would agree with it by construction): → { steps, status } or null.
function poBlock(said) {
  const m = /```plan-schritte[ \t]*\r?\n([\s\S]*?)```/.exec(said);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]);
    if (!Array.isArray(v)) return null;
    return { steps: v.filter((e) => e && typeof e === 'object' && e.id).map((e) => ({ id: e.id, titel: e.titel || e.id })), status: v.some((e) => e && typeof e === 'object' && 'status' in e) };
  } catch { return null; }
}
// 'start' (a block without states) · 'ask' (the protocol, without a start) · '' — the protocol's opening is fixed German
const poKind = (said) => { const b = poBlock(said); if (b && !b.status) return 'start'; return said.indexOf('Plan-Fortschritt: Beginne die Umsetzung') >= 0 ? 'ask' : ''; };
// step by step from index `from` to the end, then „fertig"; the first report carries the list when `confirm`
function poRun(later, steps, from, extra) {
  const ids = steps.map((s) => s.id);
  const step = (i) => {
    if (i >= steps.length) { ppSay([{ type: 'text', text: 'QA-Lauf abgeschlossen.\n\n' + ppStatus({ erledigt: ids, fertig: true }) }]); finishTurn(turn); return; }
    const o = Object.assign(i === from ? (extra || {}) : {}, { aktuell: steps[i].id, aktiv: PO_ACT[i] || ('Arbeite an ' + steps[i].titel) });
    if (i > 0 && !o.erledigt) o.erledigt = [steps[i - 1].id];
    const read = poId('read');
    const lead = i !== from ? '' : (from === 0 ? 'Ich starte mit „' : 'Ich bin bei „') + steps[i].titel + '".\n\n';
    ppSay([{ type: 'text', text: lead + ppStatus(o) }, { type: 'tool_use', id: read, name: 'Read', input: { file_path: 'README.md' } }]);
    ppResult(read, '# README (fake-claude)');
    later(() => step(i + 1));
  };
  step(from);
}
function planOrphanTurn(sc, later, said) {
  ppTranscript({ type: 'user', message: { role: 'user', content: said } });
  if (sc === 'planself') {
    poRun(later, PO_OWN, 0, { titel: 'QA-Lauf (selbst gemeldet)', schritte: PO_OWN });
    return;
  }
  const kind = poKind(said);
  if (kind === 'start') {
    const b = poBlock(said);
    const steps = b.steps.length ? b.steps : PO_OWN; // an empty block → the model lists them itself
    poRun(later, steps, 0, { schritte: steps });
    return;
  }
  if (kind === 'ask') {
    // where the model really is — its own, finer list, the first step behind it
    poRun(later, PO_OWN, 1, { schritte: PO_OWN, erledigt: ['S1'] });
    return;
  }
  if (!poProposed) {
    poProposed = true;
    const id = poId('epm');
    const input = { plan: PO_PLAN, planFilePath: ppPlanFile('demoprojekt-demo.md', PO_PLAN) };
    ppSay([{ type: 'text', text: 'Der Plan für den QA-Lauf steht.' }, { type: 'tool_use', id, name: 'ExitPlanMode', input }]);
    // the refusal comes from the CLI itself, before any can_use_tool — the panel never holds a gate for it
    const no = '<tool_use_error>You are not in plan mode. To enter plan mode, call the EnterPlanMode tool first. (fake-claude)</tool_use_error>';
    ppResult(id, no, { is_error: true }, { toolUseResult: 'Error: ' + no });
    later(() => { ppSay([{ type: 'text', text: 'Einen Freigabe-Knopf kann ich hier nicht anbieten — sag Bescheid, wenn ich loslegen soll.' }]); finishTurn(turn); });
    return;
  }
  // „plan starten" without the list: the model works, and the rail hears nothing
  const read = poId('read');
  ppSay([{ type: 'text', text: 'Ich starte mit Schritt 0 — Inventar.' }, { type: 'tool_use', id: read, name: 'Read', input: { file_path: 'README.md' } }]);
  ppResult(read, '# README (fake-claude)');
  later(() => { ppSay([{ type: 'text', text: 'Inventar steht, weiter mit dem Workflow.' }]); finishTurn(turn); });
}

function respond(sc, hold, said) {
  turn++;
  const later = (fn) => (hold > 0 ? setTimeout(fn, hold) : fn());
  if (sc === 'planprogress' || sc === 'planprogress-compact') { planProgressTurn(sc, later, String(said || '')); return; }
  if (sc === 'planorphan' || sc === 'planself') { planOrphanTurn(sc, later, String(said || '')); return; }
  if (sc === 'openpoints-plan' || sc === 'openpoints-ask') {
    // the block and a HELD card in one message: the turn stands still at the gate, no `result` comes
    // until the card is answered — the case where the block used to stay raw JSON
    const id = (sc === 'openpoints-plan' ? 'plan-op-' : 'ask-op-') + turn;
    const tool = sc === 'openpoints-plan' ? 'ExitPlanMode' : 'AskUserQuestion';
    const input = sc === 'openpoints-plan'
      ? { plan: '1. Werk 1 kartieren\n2. PDF erzeugen' }
      : { questions: [{ question: 'Welche Variante nehmen wir?', header: 'Variante', multiSelect: false, options: [{ label: 'A', description: 'schnell' }, { label: 'B', description: 'gründlich' }] }] };
    say([{ type: 'text', text: (sc === 'openpoints-plan' ? 'Der Plan steht, zwei Dinge sind offen.' : 'Kurz vorab, zwei Dinge sind offen.') + '\n\n' + opBlock() }, { type: 'tool_use', id, name: tool, input }]);
    emit({ type: 'control_request', request_id: 'req-' + turn, request: { subtype: 'can_use_tool', tool_name: tool, tool_use_id: id, input } });
    afterGate = () => { say([{ type: 'text', text: sc === 'openpoints-plan' ? 'Weiter geplant, der Plan bleibt.' : 'Gut, dann so.' }]); finishTurn(turn); };
    return;
  }
  if (sc === 'openpoints-split') {
    // the block arrives in stream deltas first — mid-block the bubble must say „…werden gesammelt", never
    // show half a JSON array — and only then as the finished frame
    const text = 'Zwei Dinge sind offen.\n\n' + opBlock();
    const cut = [0, 30, 60, 110, 170, text.length];
    emit({ type: 'stream_event', event: { type: 'message_start' } });
    emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
    let i = 0;
    const step = () => {
      if (i < cut.length - 1) {
        emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(cut[i], cut[i + 1]) } } });
        i++; setTimeout(step, Math.max(120, hold / 5));
        return;
      }
      say([{ type: 'text', text }]);
      finishTurn(turn);
    };
    step();
    return;
  }
  if (sc === 'openpoints-tail') {
    // block in message A, the turn goes on with message B — which asks the SAME questions again (one card)
    say([{ type: 'text', text: 'Erster Teil fertig, zwei Dinge sind offen.\n\n' + opBlock() }]);
    later(() => { say([{ type: 'text', text: 'Zweiter Teil auch fertig. Die Fragen von oben gelten weiter.\n\n' + opBlock() }]); finishTurn(turn); });
    return;
  }
  if (sc === 'openpoints-toolonly') {
    // nothing but the block next to a tool call: no text left in the bubble, the card still has to stand
    const tu = 'toolu_op_' + turn;
    say([{ type: 'text', text: opBlock() }, { type: 'tool_use', id: tu, name: 'Read', input: { file_path: 'README.md' } }]);
    emit({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: '# README' }] } });
    later(() => { say([{ type: 'text', text: 'Gelesen.' }]); finishTurn(turn); });
    return;
  }
  if (sc === 'openpoints-crash') {
    // the process dies after the block and before any `result` — the card must stand anyway
    say([{ type: 'text', text: 'Zwei Dinge sind offen.\n\n' + opBlock() }]);
    setTimeout(() => process.exit(1), Math.max(50, hold));
    return;
  }
  if (sc === 'question') {
    // a plain-text question (no tool, no block) → the panel's heuristic chips; `hold` keeps the turn open
    // long enough to queue something behind it (CHAT-FLOW-7)
    later(() => { say([{ type: 'text', text: 'Der Report ist fertig. Soll ich ihn gleich anhängen?' }]); finishTurn(turn); });
    return;
  }
  if (sc === 'permission') { // ask for a tool permission; the panel answers with a control_response
    // FAKE_CLAUDE_PERM_TOOL: WHICH tool is asked for. It was hardcoded to 'Bash' — the one tool
    // lib/engine's headlessToolAllowed denies unconditionally — so the allow branch that #15/#20 was
    // fixed for could not be driven end to end at all. Default stays 'Bash' (the existing suites).
    const tool = process.env.FAKE_CLAUDE_PERM_TOOL || 'Bash';
    const input = tool === 'Bash' ? { command: 'echo hi' } : {};
    emit({ type: 'control_request', request_id: 'req-' + turn, request: { subtype: 'can_use_tool', tool_name: tool, input } });
    return; // the turn finishes when the control_response arrives
  }
  // Keyed on `scenario`, not on the per-turn `sc`, and deliberately so: half of this scenario is the
  // `commands_changed` emitted at startup BEFORE `init` (see above), which no per-turn `sc:…` can
  // reproduce. It is a whole-SESSION sequence, so `bymsg` cannot offer it and must not pretend to.
  if (scenario === 'sessionstate') {
    // G5 — the measured order of run 1, which is the test vector for the whole feature:
    //   running (_seq 7) → requires_action (_seq 37) → running (_seq 39) → idle (_seq 80)
    // Two details are reproduced because both are load-bearing and neither is obvious:
    //   · `requires_action` arrives ONE FRAME BEFORE the `can_use_tool` request it belongs to (_seq 37 vs
    //     38). The panel must therefore not paint a message at arrival — it would state a hole that closes
    //     a frame later.
    //   · the FIRST `result` (`result_index 0`) lands while the session is still `running`, and `idle` only
    //     comes after the LAST one (_seq 58 / 79 / 80). That is CHAT-FLOW-3: the panel drops `streaming`
    //     at the first result and the Stop button goes with it, while the CLI is still working.
    sessionState('running');
    sessionState('requires_action');
    emit({ type: 'control_request', request_id: 'req-' + turn, request: { subtype: 'can_use_tool', tool_name: 'Workflow', input: { scriptPath: 'probe-wf.js' } } });
    return; // continues in the control_response handler below
  }
  if (sc === 'plan') {
    emit({ type: 'assistant', message: { role: 'assistant', model: curModel, content: [{ type: 'tool_use', id: 'plan-' + turn, name: 'ExitPlanMode', input: { plan: '1. do a thing\n2. do another' } }] } });
    return;
  }
  if (sc === 'bgagent') {
    // #32 — the sequence of a BACKGROUNDED sub-agent, field for field as it was captured from the real CLI
    // (2.1.274). The fixtures in test/agent-lanes.test.js pin the same shapes; this scenario is what puts
    // them on a real stdout, through the real engine, so the frames→lane path is not only replay-tested:
    //   Agent tool_use (run_in_background) → background_tasks_changed → task_started → the tool's own
    //   "async_launched" RECEIPT (tool_use_result sits NEXT to the message) → task_progress →
    //   a FIRST result WHILE the agent works (this is where the rail used to clear itself) →
    //   list empty · task_updated · task_notification (summary + usage) → the final result.
    const tu = 'toolu_fake_bg_' + turn, tid = 'faketask' + turn, desc = 'Dateien auflisten';
    const prompt = 'Liste alle Dateinamen auf …';
    // #34 — a REAL transcript file, in the place and the format the CLI uses:
    //   <tmp>/claude/<project-slug>/<sessionId>/tasks/<agentId>.output, JSONL, isSidechain:true.
    // Without it the detail view's live tail could only be tested against a hand-written fixture, and
    // the one thing worth proving here is that the path the CLI reports is a path the panel may read
    // (lib/agent-output agentOutputPathOk) and can parse. Written incrementally, like the real one.
    const fsx = require('fs'), pathx = require('path'), osx = require('os');
    const taskDir = pathx.join(osx.tmpdir(), 'claude', 'fake-' + pathx.basename(process.cwd()), sessionId, 'tasks');
    const outFile = pathx.join(taskDir, tid + '.output');
    const sidechain = (o) => { try { fsx.appendFileSync(outFile, JSON.stringify(Object.assign({ isSidechain: true, agentId: tid, timestamp: new Date().toISOString() }, o)) + '\n'); } catch { /* temp dir gone — the route reports `missing` */ } };
    try { fsx.mkdirSync(taskDir, { recursive: true }); fsx.writeFileSync(outFile, ''); } catch { /* */ }
    sidechain({ type: 'user', message: { role: 'user', content: prompt } });
    sidechain({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'tool_use', name: 'Glob', input: { pattern: '**/*.txt' } }] } });
    const sysFrame = (subtype, extra) => emit(Object.assign({ type: 'system', subtype, session_id: sessionId }, extra));
    const resultFrame = (index, stats) => emit({ type: 'result', subtype: 'success', is_error: false, result_index: index, duration_ms: 5, num_turns: turn, session_id: sessionId, usage: { input_tokens: 1, output_tokens: 1 }, subagent_stats: stats });
    const stats = (completed) => ({ spawned: 1, requested: { background: 1, foreground: 0, unset: 0 }, started_in_background: 1, max_depth: 1, spawned_by_subagents: 0, completed, failed: 0, killed: { parent: 0, user: 0, system: 0 }, refused: { depth_limit: 0, concurrency_limit: 0, budget: 0 }, by_type: { Explore: 1 } });
    emit({ type: 'assistant', message: { role: 'assistant', model: curModel, content: [{ type: 'tool_use', id: tu, name: 'Agent', input: { description: desc, subagent_type: 'Explore', prompt, run_in_background: true } }] } });
    sysFrame('background_tasks_changed', { tasks: [{ task_id: tid, task_type: 'local_agent', description: desc }] });
    sysFrame('task_started', { task_id: tid, tool_use_id: tu, description: desc, subagent_type: 'Explore', is_backgrounded: true, spawn_depth: 1, task_type: 'local_agent' });
    emit({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: 'Async agent launched successfully…' }] }, tool_use_result: { isAsync: true, status: 'async_launched', agentId: tid, description: desc, resolvedModel: 'eu.anthropic.claude-sonnet-5', prompt, outputFile: outFile, canReadOutputFile: true } });
    sysFrame('task_progress', { task_id: tid, tool_use_id: tu, description: 'Finding *', subagent_type: 'Explore', usage: { total_tokens: 18724, tool_uses: 1, duration_ms: 2046 }, last_tool_name: 'Glob' });
    emit({ type: 'assistant', message: { role: 'assistant', model: curModel, content: [{ type: 'text', text: 'Der Explore-Agent läuft im Hintergrund — ich melde das Ergebnis, sobald er fertig ist.' }] } });
    resultFrame(0, stats(0));
    // …and only later the agent's own end. The delay is what makes the first result a result DURING the run.
    setTimeout(() => {
      sidechain({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.txt' } }] } });
      sysFrame('task_progress', { task_id: tid, tool_use_id: tu, description: 'Reading a.txt', subagent_type: 'Explore', usage: { total_tokens: 18941, tool_uses: 2, duration_ms: 5739 }, last_tool_name: 'Read' });
      sidechain({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: '7 Dateien gefunden: a.txt, b.txt …' }] } });
      sysFrame('background_tasks_changed', { tasks: [] });
      sysFrame('task_updated', { task_id: tid, patch: { status: 'completed', end_time: Date.now() } });
      sysFrame('task_notification', { task_id: tid, tool_use_id: tu, status: 'completed', summary: '7 Dateien gefunden', output_file: outFile, usage: { total_tokens: 20031, tool_uses: 2, duration_ms: 7206 } });
      emit({ type: 'assistant', message: { role: 'assistant', model: curModel, content: [{ type: 'text', text: '7 Dateien.' }] } });
      resultFrame(1, stats(1));
    }, 150);
    return;
  }
  if (sc === 'bgstop') {
    // G6 — a BACKGROUNDED agent that keeps working until somebody STOPS it. The opening is the measured
    // `bgagent` sequence (so the lane exists exactly as in production, with a task_id and a first `result`
    // while the agent runs); the ending is the one shape the recorded runs never contained — a kill. Its
    // three frames and their ORDER are taken from the recorded interrupt run (frames 9/10/11):
    //   background_tasks_changed {tasks: []} → task_updated {patch.status:'killed'} → task_notification
    //   {status:'stopped'} …and only then the turn's closing `result`.
    // Deliberately NO self-timeout: this scenario's whole purpose is a task that does not end by itself, so
    // „the stop never arrived" is observable (the panel then has to say „unbestätigt", not „gestoppt"). The
    // process still exits on stdin EOF like every other scenario.
    const tu = 'toolu_fake_stop_' + turn, tid = 'stoptask' + turn, desc = 'Langläufer beobachten';
    const sysFrame = (subtype, extra) => emit(Object.assign({ type: 'system', subtype, session_id: sessionId }, extra));
    const resultFrame = (index, stats) => emit({ type: 'result', subtype: 'success', is_error: false, result_index: index, duration_ms: 5, num_turns: turn, session_id: sessionId, usage: { input_tokens: 1, output_tokens: 1 }, subagent_stats: stats });
    const stats = (done) => ({ spawned: 1, started_in_background: 1, completed: 0, failed: 0, killed: { parent: 0, user: done ? 1 : 0, system: 0 }, by_type: { Explore: 1 } });
    emit({ type: 'assistant', message: { role: 'assistant', model: curModel, content: [{ type: 'tool_use', id: tu, name: 'Agent', input: { description: desc, subagent_type: 'Explore', prompt: 'Beobachte etwas sehr lange …', run_in_background: true } }] } });
    sysFrame('background_tasks_changed', { tasks: [{ task_id: tid, task_type: 'local_agent', description: desc }] });
    sysFrame('task_started', { task_id: tid, tool_use_id: tu, description: desc, subagent_type: 'Explore', is_backgrounded: true, spawn_depth: 1, task_type: 'local_agent' });
    emit({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: 'Async agent launched successfully…' }] }, tool_use_result: { isAsync: true, status: 'async_launched', agentId: tid, description: desc, resolvedModel: 'eu.anthropic.claude-sonnet-5' } });
    sysFrame('task_progress', { task_id: tid, tool_use_id: tu, description: 'Beobachtet', subagent_type: 'Explore', usage: { total_tokens: 1200, tool_uses: 1, duration_ms: 900 }, last_tool_name: 'Bash' });
    say([{ type: 'text', text: 'Der Agent läuft im Hintergrund weiter.' }]);
    resultFrame(0, stats(false));
    liveTasks.set(tid, () => {
      sysFrame('background_tasks_changed', { tasks: [] });
      sysFrame('task_updated', { task_id: tid, patch: { status: 'killed', end_time: Date.now() } });
      sysFrame('task_notification', { task_id: tid, tool_use_id: tu, status: 'stopped', summary: 'Vom Benutzer gestoppt', usage: { total_tokens: 1500, tool_uses: 2, duration_ms: 2400 } });
      say([{ type: 'text', text: 'Der Agent wurde gestoppt.' }]);
      resultFrame(1, stats(true));
    });
    return;
  }
  if (sc === 'budget') {
    // PR-13 — the shape the cost brake exists for, as measured on 2026-10-01 (docs/ideas.md U3): a WORKFLOW
    // whose agent keeps spending after the parent's `result`, in a transcript of its own
    // (<session>/subagents/workflows/wf_<id>/agent-<hex>.jsonl) that `--max-budget-usd` never sees. The main
    // file gets one answer worth $0.01 (1,000 Sonnet 5 output tokens at $10/MTok); the agent then writes one
    // answer worth $0.05 every 100 ms until a `stop_task` ends it — or 200 answers, the self-limit, so a
    // broken brake cannot leave it writing for ever. Frames as in `bgstop`; the transcripts are written ONLY
    // under a temp CLAUDE_UI_CLAUDE_DIR (ppClaudeDir), never into a real ~/.claude.
    const fsx = require('fs'), pathx = require('path');
    const tu = 'toolu_fake_wf_' + turn, tid = 'wftask' + turn, run = 'wf_fake' + turn, desc = 'Workflow-Probe';
    const dir = ppClaudeDir();
    const proj = dir ? pathx.join(dir, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-')) : '';
    const wfDir = proj ? pathx.join(proj, sessionId, 'subagents', 'workflows', run) : '';
    const answer = (id, out) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), sessionId, message: { id: 'msg_' + id, role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 0, output_tokens: out }, content: [{ type: 'text', text: '…' }] } }) + '\n';
    const append = (file, line) => { if (!file) return; try { fsx.mkdirSync(pathx.dirname(file), { recursive: true }); fsx.appendFileSync(file, line); } catch { /* sandbox gone */ } };
    const sysFrame = (subtype, extra) => emit(Object.assign({ type: 'system', subtype, session_id: sessionId }, extra));
    append(proj && pathx.join(proj, sessionId + '.jsonl'), answer('main' + turn, 1000));
    emit({ type: 'assistant', message: { role: 'assistant', model: curModel, content: [{ type: 'tool_use', id: tu, name: 'Workflow', input: { scriptPath: 'probe-wf.js' } }] } });
    sysFrame('background_tasks_changed', { tasks: [{ task_id: tid, task_type: 'local_workflow', description: desc }] });
    sysFrame('task_started', { task_id: tid, tool_use_id: tu, description: desc, task_type: 'local_workflow', is_backgrounded: true });
    emit({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: 'Workflow launched' }] }, tool_use_result: { status: 'async_launched', taskId: tid, taskType: 'local_workflow', workflowName: 'probe', runId: run, transcriptDir: wfDir } });
    say([{ type: 'text', text: 'Der Workflow läuft im Hintergrund.' }]);
    emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: turn, session_id: sessionId, total_cost_usd: 0.01, usage: { input_tokens: 0, output_tokens: 1000 } });
    let n = 0;
    const agentFile = wfDir && pathx.join(wfDir, 'agent-a1b2c3d4.jsonl');
    const iv = setInterval(() => { append(agentFile, answer('wf' + turn + '_' + (n++), 5000)); if (n >= 200) clearInterval(iv); }, 100);
    liveTasks.set(tid, () => {
      clearInterval(iv);
      sysFrame('background_tasks_changed', { tasks: [] });
      sysFrame('task_updated', { task_id: tid, patch: { status: 'killed', end_time: Date.now() } });
      sysFrame('task_notification', { task_id: tid, tool_use_id: tu, status: 'stopped', summary: 'gestoppt' });
    });
    return;
  }
  if (sc === 'fgagent') {
    // A FOREGROUND subagent with --forward-subagent-text, field for field as measured on 2.1.278:
    // the forwarded frames carry `parent_tool_use_id` plus `subagent_type`/`task_description`, and
    // the agent writes NOTHING to disk (its .output file stays empty) — which is why these frames
    // are the only record of its work and must not land in the transcript.
    const tu = 'toolu_fake_fg_' + turn, tid = 'fgtask' + turn, desc = 'probe';
    const sysFrame = (subtype, extra) => emit(Object.assign({ type: 'system', subtype, session_id: sessionId }, extra));
    const fwd = (role, content) => emit({
      type: role, session_id: sessionId, parent_tool_use_id: tu, subagent_type: 'Explore',
      task_description: desc, message: { role, model: curModel, content },
    });
    emit({ type: 'assistant', message: { role: 'assistant', model: curModel, content: [{ type: 'tool_use', id: tu, name: 'Agent', input: { description: desc, subagent_type: 'Explore', prompt: 'Antworte nur mit OK', run_in_background: false } }] } });
    sysFrame('task_started', { task_id: tid, tool_use_id: tu, description: desc, subagent_type: 'Explore', is_backgrounded: false, spawn_depth: 1, task_type: 'local_agent' });
    fwd('user', [{ type: 'text', text: 'Antworte nur mit OK' }]);               // the prompt echo (dropped)
    fwd('assistant', [{ type: 'thinking', thinking: 'kurz nachdenken' }]);
    fwd('assistant', [{ type: 'text', text: 'OK — 3 Treffer gefunden.' }]);
    // a foreground agent ends with its tool_result, not with a launch receipt
    emit({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: 'OK — 3 Treffer gefunden.' }] }, tool_use_result: { status: 'completed', agentId: tid, agentType: 'Explore', prompt: 'Antworte nur mit OK', content: [{ type: 'text', text: 'OK' }], totalTokens: 1234, totalToolUseCount: 2, totalDurationMs: 3400, resolvedModel: 'claude-sonnet-5', usage: { input_tokens: 900, output_tokens: 334, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
    sysFrame('hook_started', { hook_id: 'hook-' + turn, hook_name: 'Stop', hook_event: 'Stop' });
    emit({ type: 'assistant', message: { role: 'assistant', model: curModel, content: [{ type: 'text', text: 'Der Agent meldet: OK.' }] } });
    finishTurn(turn);
    return;
  }
  // A background WATCH (Monitor). Shapes from sdk-tools.d.ts, which is the only documentation there is:
  //   MonitorInput  {description, timeout_ms, command? | ws?}
  //   MonitorOutput {taskId, timeoutMs, persistent?}   ← a launch RECEIPT, not a result
  // What the watch then observes arrives as system/task_* frames carrying that taskId — frames that
  // match no subagent lane. Reproduced here because that is exactly the path the panel now renders, and
  // the real thing cannot be triggered without a model turn.
  if (sc === 'monitor') {
    const sysFrame = (subtype, extra) => emit(Object.assign({ type: 'system', subtype, session_id: sessionId }, extra));
    const tu = 'toolu_mon_' + turn;
    const taskId = 'task_watch_' + turn;
    emit({ type: 'assistant', message: { role: 'assistant', model: curModel, content: [{ type: 'tool_use', id: tu, name: 'Monitor', input: { description: 'CI-Lauf beobachten', timeout_ms: 300000, command: 'npm test -- --watch' } }] } });
    emit({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: 'Watching…' }] }, tool_use_result: { taskId, timeoutMs: 300000 } });
    sysFrame('task_notification', { task_id: taskId, status: 'event', summary: '3 Tests fehlgeschlagen' });
    setTimeout(() => {
      sysFrame('task_updated', { task_id: taskId, patch: { status: 'expired' } });
      emit({ type: 'assistant', message: { role: 'assistant', model: curModel, content: [{ type: 'text', text: 'Die Beobachtung ist abgelaufen.' }] } });
      finishTurn(turn);
    }, 300);
    return;
  }
  if (sc === 'openpoints') {
    // D2 — an answer that ends with an ```offene-punkte``` block: points with and without ready-made
    // answers. Drives the whole path (strip the raw JSON out of the bubble → card under the answer → row
    // in the rail) with no model call. Written as a real fenced block, exactly as a model would.
    // THREE points on purpose: collect mode exists because answering one starts a turn and the other
    // answers then queue up behind it — with fewer than three that is not visible.
    const block = ['```offene-punkte', JSON.stringify([
      { frage: 'Welches Werk ist gemeint?', warum: 'Ich kartiere erst mal beide', tone: 'info', optionen: ['Werk 1', { label: 'beide', desc: 'kostet einen zweiten Durchlauf' }] },
      { frage: 'Soll das PDF mit angehängt werden?', warum: 'Der Kommentar steht so oder so' },
      { frage: 'Auch die Testfälle anpassen?', warum: 'Betrifft nur den zweiten Durchlauf', tone: 'warn', optionen: ['ja', 'nein'] },
    ]), '```'].join('\n');
    emit({ type: 'assistant', message: { role: 'assistant', model: curModel, content: [{ type: 'text', text: 'Fertig, drei Dinge sind noch offen.\n\n' + block }] } });
    later(() => finishTurn(turn)); // `hold` → time to queue a message behind it (CHAT-FLOW-7/8 pause)
    return;
  }
  if (sc === 'uiresult') {
    // An answer that ends with a ```ui-result``` block — the channel every radar skill delivers through.
    // The block comes from a FILE (FAKE_CLAUDE_CARD, default test/fixtures/ui-result-card.md), so the very
    // block a skill's script produces can be pushed through the real render path: hydration → card →
    // sections → row selection → follow-up buttons, with no model call and no Jira. The second turn
    // answers an approval, which is how a follow-up prompt gets exercised end-to-end.
    const fs = require('fs');
    const path = require('path');
    const file = process.env.FAKE_CLAUDE_CARD || path.join(__dirname, 'test', 'fixtures', 'ui-result-card.md');
    let card = '';
    try { card = fs.readFileSync(file, 'utf8').trim(); } catch (e) { card = '(kein Kartenblock: ' + e.message + ')'; }
    const lead = turn === 1
      ? 'Vorschau steht, es wurde nichts geschrieben.\n\n🔗 Dashboard: file:///dev/null\nSYNC FERTIG: Vorschau'
      : 'Freigabe angekommen, ich hätte jetzt geschrieben.\n\nSYNC FERTIG: Freigabe';
    emit({ type: 'assistant', message: { role: 'assistant', model: curModel, content: [{ type: 'text', text: lead + '\n\n' + card }] } });
    finishTurn(turn);
    return;
  }
  emit({ type: 'assistant', message: { role: 'assistant', model: curModel, content: [{ type: 'text', text: 'OK' }] } });
  finishTurn(turn);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let obj; try { obj = JSON.parse(line); } catch { return; }
  if (obj.type === 'user') {
    sendInit();   // FAKE_CLAUDE_LATE_INIT: the first message is what makes the real CLI speak (no-op otherwise)
    let sc = scenario, hold = Number(process.env.FAKE_CLAUDE_TURN_MS) || 0;
    const c = obj.message && obj.message.content;
    const said = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '');
    // A TYPED „/model <arg>" is a local command of the real CLI: it switches the session's model and no model
    // answers it — the transcript records „<local-command-stdout>Set model to `…`</local-command-stdout>" and the
    // NEXT turn's frames carry the new model (Julian's sessions, 2026-10-01 and -05). The fake used to answer it
    // like any message, with the old model, so the panel's takeover of a typed switch (chat-events.js
    // settleTypedModel) had nothing to confirm it. Now: the model changes (any scenario), the turn ends with a
    // `result` and no assistant frame, and an id containing „restricted" is kept out, as for set_model — so a
    // rejected switch is testable too: the next turn simply goes on answering with the old model.
    // Aliases resolve to a concrete id with the suffix kept (`opus[1m]` → `claude-opus-5[1m]`), so the frames name
    // a model rather than an alias, and contextUsage() still sees the „[1m]" that decides its window.
    const typed = /^\/model[ \t]+(\S+)$/.exec(said.trim());
    if (typed) {
      const want = typed[1];
      turn++;
      if (/restricted/i.test(want)) {
        emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 0, session_id: sessionId, result: 'Kept model as ' + curModel, usage: { input_tokens: 0, output_tokens: 0 } });
        return;
      }
      const FAMILY = { opus: 'claude-opus-5', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5' };
      const fam = /^(opus|sonnet|haiku)(\[1m\])?$/i.exec(want);
      curModel = fam ? FAMILY[fam[1].toLowerCase()] + (fam[2] || '') : want;
      emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 0, session_id: sessionId, result: 'Set model to `' + want + '`', usage: { input_tokens: 0, output_tokens: 0 } });
      return;
    }
    if (scenario === 'bymsg') {
      // A message WITHOUT `sc:` that carries a ```plan-schritte block is the panel's [Stand abfragen] — what a model
      // that keeps the plan protocol answers with a report — so it goes to the plan scenario instead of to `echo`.
      // PF-1b: a block WITHOUT states is a start by message (▶ Plan starten, the chip), and the protocol without a
      // block is 📋 Schritte anfordern — both are planorphan's; and after an `sc:planorphan` the conversation stays there.
      const m = /\bsc:([\w-]+)/.exec(said);
      if (m) sc = m[1];
      else if (poSticky) sc = 'planorphan';
      else if (said.indexOf('```plan-schritte') >= 0) sc = poKind(said) === 'start' ? 'planorphan' : 'planprogress';
      else sc = poKind(said) === 'ask' ? 'planorphan' : 'echo';
      if (sc === 'planorphan') poSticky = true;
      const h = /\bhold:(\d+)/.exec(said); if (h) hold = Number(h[1]);
    }
    respond(sc, hold, said);
    return;
  }
  if (obj.type === 'control_response') { // our can_use_tool was answered → finish the turn
    // FAKE_CLAUDE_CONTROL_OUT: append every control_response we RECEIVE as one JSON line. The verdict
    // (allow/deny + the reason the responder names) exists nowhere else — the transcript records the
    // tool CALL, not the decision — so without this a behaviour test of headlessToolAllowed could only
    // assert the argv, never what was actually answered. Best-effort: a missing dir must not kill a turn.
    // It stands FIRST, ahead of every branch that returns: a seam that records what was answered is
    // worthless if one scenario's early return makes it skip the answer.
    const out = process.env.FAKE_CLAUDE_CONTROL_OUT;
    if (out) { try { require('fs').appendFileSync(out, JSON.stringify(obj) + '\n'); } catch { /* */ } }
    if (scenario === 'sessionstate') {
      // the decision was taken → back to `running` (_seq 39), then TWO results and only then `idle`
      sessionState('running');
      emit({ type: 'assistant', message: { role: 'assistant', model: curModel, content: [{ type: 'text', text: 'FERTIG' }] } });
      // `result_index` is a real field of the real frames (measured 0 and 1 on _seq 58 / 79); the rest of
      // the shape is finishTurn's, so the two paths cannot drift apart. It returns WITHOUT finishTurn:
      // a third, index-less `result` is exactly what test/session-state.test.js pins against.
      emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 1, session_id: sessionId, usage: { input_tokens: 1, output_tokens: 1 }, result_index: 0 });
      emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 1, session_id: sessionId, usage: { input_tokens: 1, output_tokens: 1 }, result_index: 1 });
      sessionState('idle');
      return;
    }
    if (afterGate) { const f = afterGate; afterGate = null; f(obj); return; } // the answer itself: planprogress reads its message
    emit({ type: 'assistant', message: { role: 'assistant', model: curModel, content: [{ type: 'text', text: 'done' }] } });
    finishTurn(turn);
    return;
  }
  if (obj.type === 'control_request' && obj.request) { // panel→CLI controls (initialize/set_model/interrupt/…): ack
    // The real CLI VALIDATES a set_model and refuses ids it will not run — an unknown one, or one the
    // organisation restricts ("…is restricted by your organization's settings. Using … instead"). Any
    // id containing "restricted" is refused here so that path is testable; everything else is accepted
    // and really changes what serves the next turn.
    if (obj.request.subtype === 'set_model') {
      const want = obj.request.model;
      if (want && /restricted/i.test(String(want))) {
        emit({ type: 'control_response', response: { subtype: 'error', request_id: obj.request_id, error: 'Model "' + want + '" is restricted by your organization\'s settings. Using ' + curModel + ' instead.' } });
        return;
      }
      curModel = want || (argVal('--model') || 'fake-model');
    }
    // apply_flag_settings — the one control the panel uses for TWO settings, and the one whose real
    // behaviour is least guessable. Three properties are reproduced here, each verified against the stdio
    // handler (`tv`) in claude.exe 2.1.286, chunk-1w8x69eb:
    //
    //  1. An ultracode it CANNOT honour is accepted, not refused. Measured on 2.1.285 with --model haiku:
    //     the request answers `success`, and only a following get_settings reveals requested=true /
    //     ultracode=false. That asymmetry is why the panel re-reads the state, so the fake keeps it — a
    //     model name containing "haiku" cannot do it. NOTE this is CONNECTION-specific, not a property of
    //     the CLI: 2.1.286 has a second handler for Remote Control (`JYt`) which DOES refuse
    //     `ultracode:true` on an incapable model and names the reason. The panel talks stdio, so do not
    //     „correct" this into refusing — the whole three-state chip exists because it does not.
    //  2. An EFFORT-ONLY request switches ultracode OFF — but only when the level really changes:
    //       let S = "ultracode" in e ? void 0 : g || (Efn(r.model, v, n) ? !1 : void 0);
    //     with `Efn` = „the requested level differs from the one in force". A no-op effort set leaves
    //     ultracode alone, and that exception is not cosmetic: it is what makes „send the level you are
    //     already on" a safe probe, and a fake that cleared unconditionally would let a test pass that
    //     proves nothing. Carrying an `ultracode` key skips the coupling entirely.
    //  3. `effortLevel: null` means „no explicit level" (what the CLI displays as „auto") and IS acted on,
    //     while '' and an unrecognised name are SILENT no-ops: `fH('')` returns undefined, the state
    //     update is skipped, and the response is `success` regardless. So the key's presence is not enough
    //     — the VALUE decides whether anything happens, which is why the panel can only learn the truth
    //     from get_settings.
    if (obj.request.subtype === 'apply_flag_settings') {
      const s = obj.request.settings || {};
      if ('ultracode' in s) ucRequested = s.ultracode === true;
      if ('effortLevel' in s) {
        const raw = s.effortLevel;
        // '' / garbage → undefined = the state is not touched at all (and neither is ultracode)
        const lv = (raw === null || raw === undefined) ? ''
          : (EFFORT_NAMES.includes(String(raw)) ? String(raw) : undefined);
        if (lv !== undefined) {
          const before = curEffort;
          curEffort = lv;
          if (!('ultracode' in s) && lv !== before) ucRequested = false;   // the `Efn` coupling
        }
      }
    }
    // `get_context_usage` answers out of band, because the two things worth testing about it are timing:
    // it may be slow (12.2 s measured on a cold start with MCP servers coming up) and an older CLI does
    // not know the subtype at all.
    if (obj.request.subtype === 'get_context_usage') {
      // Emitted on ARRIVAL, before any hold and before the answer, so a test can count how many control
      // requests really reached the CLI — the panel shares one in flight, and a second one would show up
      // here as a second frame.
      emit({ type: '_ctxprobe', model: curModel });
      // FAKE_CLAUDE_CTX_SILENT=1: never answer, which is what a CLI that does not support this control
      // does — the panel's own (long) timeout has to turn that into `unconfirmed`, not into a hang.
      if (process.env.FAKE_CLAUDE_CTX_SILENT === '1') return;
      // FAKE_CLAUDE_CTX_MS holds the ANSWER, not the process: a timer and not Atomics.wait on purpose, so
      // stdin keeps being read and a second control request would still be seen (and probed) immediately.
      // The figure is SNAPSHOT here, at arrival — not computed when the hold expires. That is the plausible
      // reading of the real 12.2 s cold call: the CLI is already working on the answer while later stdin
      // lines queue up behind it. Computing it at answer time would let a `set_model` that arrives DURING a
      // held read rewrite an answer that is already in flight — the one overlap the panel must not be
      // tested against, because a real CLI would hand the asker the numbers of the model it asked about.
      const hold = Number(process.env.FAKE_CLAUDE_CTX_MS) || 0;
      const snapshot = contextUsage();
      const answer = () => emit({ type: 'control_response', response: { subtype: 'success', request_id: obj.request_id, response: snapshot } });
      if (hold > 0) setTimeout(answer, hold); else answer();
      return;
    }
    // ---- MCP over the control channel (G4) ----
    // Answers out of band like get_context_usage, for the same two reasons: an answer can be SLOW (the CLI
    // dials the server and runs tools/list before it answers at all) and a CLI that does not know the
    // subtype answers nothing — both of which the panel has to turn into „unbestätigt" rather than into a
    // claim. The validation wording is the CLI's own.
    if (/^mcp_(status|toggle|reconnect)$/.test(obj.request.subtype)) {
      const sub = obj.request.subtype;
      const fail = (error) => emit({ type: 'control_response', response: { subtype: 'error', request_id: obj.request_id, error } });
      const ok = (payload) => {
        const send = () => emit({ type: 'control_response', response: { subtype: 'success', request_id: obj.request_id, response: payload } });
        const ms = Number(process.env.FAKE_CLAUDE_MCP_MS) || 0;
        if (sub !== 'mcp_status' && process.env.FAKE_CLAUDE_MCP_SILENT === '1') return;   // never answers
        if (ms > 0 && sub !== 'mcp_status') setTimeout(send, ms); else send();
      };
      if (sub === 'mcp_status') { ok({ mcpServers: mcpRows.map(mcpWireRow) }); return; }
      if (typeof obj.request.serverName !== 'string') return fail(sub + ': serverName must be a string');
      if (sub === 'mcp_toggle' && typeof obj.request.enabled !== 'boolean') return fail('mcp_toggle: enabled must be a boolean');
      const row = mcpFind(obj.request.serverName);
      if (!row) return fail('Server not found: ' + obj.request.serverName);
      if (sub === 'mcp_toggle' && obj.request.enabled === false) {
        // „Ausschalten" cannot fail and cannot be slow: markDynamicServerDisabled turns the client row into
        // {name, type:'disabled', config} and the handler returns without a value → success {}.
        row.status = 'disabled';
        return ok({});
      }
      // An enable / a reconnect DIALS first and answers afterwards — so the row moves to `next` and the
      // verdict is read off the result, which is the whole reason a failed switch is an error here and not
      // an „ok" the panel would have to see through.
      row.status = row.next || 'connected';
      const err = mcpVerdict(row);
      if (err) return fail(err);
      return ok({});
    }
    // ---- stop_task (G6) ----
    // Three outcomes, all three measured — see the `liveTasks` registry above for why the middle one
    // matters most: a success is NOT a receipt for „this click stopped it".
    if (obj.request.subtype === 'stop_task') {
      const id = obj.request.task_id;
      if (typeof id !== 'string') { emit({ type: 'control_response', response: { subtype: 'error', request_id: obj.request_id, error: 'stop_task: task_id must be a string' } }); return; }
      const live = liveTasks.get(id);
      if (live) {
        // The kill really runs BEFORE the answer (`rhe` awaits K.kill), so the frames go out first.
        try { live(); } catch { /* a scenario that already ended */ }
        liveTasks.delete(id); doneTasks.add(id);
        emit({ type: 'control_response', response: { subtype: 'success', request_id: obj.request_id, response: {} } });
        return;
      }
      if (doneTasks.has(id)) { emit({ type: 'control_response', response: { subtype: 'success', request_id: obj.request_id, response: {} } }); return; }
      emit({ type: 'control_response', response: { subtype: 'error', request_id: obj.request_id, error: 'No task found with ID: ' + id } });
      return;
    }
    const resp = { subtype: 'success', request_id: obj.request_id };
    // FAKE_CLAUDE_HOOKS_SILENT=1: a CLI that never answers this one. The hook editor has to label its
    // fallback („nicht von der CLI gelesen") instead of hanging or quietly looking measured — that is the
    // one state the measurement named as forbidden.
    if (obj.request.subtype === 'get_hooks_listing') {
      if (process.env.FAKE_CLAUDE_HOOKS_SILENT === '1') return;
      resp.response = hooksListing();
    }
    // `reload_skills` takes no arguments and answers with the refreshed list (schema read out of the real
    // binary: „Reloads skills from disk and returns the refreshed skill list.").
    if (obj.request.subtype === 'reload_skills') {
      emit({ type: '_reloadskills' });   // so a test can count that it really reached the CLI
      resp.response = { skills: [{ name: 'demo', description: 'reloaded' }] };
    }
    if (obj.request.subtype === 'initialize') {
      resp.response = {
        commands: [{ name: 'help', description: 'help' }],
        // …and the model list the real `initialize` carries, which is where ultracode availability is
        // read from (xhigh in supportedEffortLevels). Same field names as measured.
        models: [
          { value: 'default', resolvedModel: curModel, displayName: 'Fake', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
          { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku 4.5' },
        ],
      };
    }
    if (obj.request.subtype === 'get_settings') {
      const available = !/haiku/i.test(String(curModel));
      resp.response = {
        effective: {}, sources: {},
        applied: {
          model: curModel, effort: curEffort || null, advisor: null,
          ultracode: ucRequested && available,
          ultracodeRequested: ucRequested,
          ultracodeAvailable: available,
        },
      };
    }
    emit({ type: 'control_response', response: resp });
    return;
  }
});
rl.on('close', () => {
  // parent closed our stdin → exit cleanly; under FAKE_CLAUDE_IGNORE_EOF idle on instead (self-ends
  // after 60 s as a last resort, so a broken kill cannot leave it behind for good)
  if (ignoreEof) { setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000); return; }
  process.exit(0);
});
