'use strict';
// MCP per TAB, LIVE (G4) — the decisions behind the „MCP-Server" entry of the tab menu. Browser (classic
// script) AND Node (require'd by test/mcp-live.test.js). Dependency-free, side-effect-free, no DOM,
// no t(): it returns payloads and i18n KEYS, the painting stays in public/js/chat.js.
//
// WHY this is its own module. „MCP für diesen Tab" was a checklist plus a session RESTART — applyTabMcp
// says so itself („MCP is fixed at launch — restart the session … so the new set applies") — and the only
// status the panel had came from `claude mcp list` in a SEPARATE process (lib/mcp.js getMcpList): the state
// of the MACHINE, not of this tab's session. The CLI can do better over the control channel. The three
// subtypes below were READ OUT of the installed binary (claude 2.1.288, BUILD 2026-10-02T16:42:03Z,
// GIT_SHA 17fe1eb736e5b1433d6ca86a1db334cec8520450) rather than guessed:
//
//   mcp_status    {}                       → {mcpServers:[{name, status, serverInfo?, error?, error_code?,
//                                             config?, scope?, source?, tools?, capabilities?}]}
//                 `status` ∈ connected · failed · needs-auth · pending · disabled — and the CLI's INTERNAL
//                 'cached' is deliberately not on the wire. The handler is `var qe=(e,o)=>({mcpServers:At(o)})`:
//                 SYNCHRONOUS, no await, no model turn. This read is free, which is what makes every verdict
//                 below affordable.
//   mcp_toggle    {serverName, enabled}    → control_response success with an EMPTY `{}` … or an error.
//   mcp_reconnect {serverName}             → the SAME verdict mapper (`lt()`), see mcpReconnectVerdict.
//
// THE TRAP this module exists for — and it is the project's own error class, one layer in:
//  · `success {}` is the whole answer. There is no „and here is the new state" in it.
//  · There is no PUSH either. `mcp_servers_changed` DOES NOT EXIST: 0 hits in the whole 249 MB binary, and
//    the complete list of `system`-frame subtypes was extracted from the schema block — it contains no MCP
//    frame at all. So „the UI learns about it by itself" is not available; whoever wants to know has to ASK.
//  · `controlRequest` resolves `{ok:true, unconfirmed:true}` on its timeout (lib/chat.js), so „the request
//    came back ok" can mean „nobody answered". That is the H1 defect, which once published „Ultracode aus"
//    over a session that had said nothing at all.
//  · And a toggle really can outrun a short ceiling: the CLI dials a server under MCP_CONNECT_TIMEOUT_MS
//    (`rPe()`, default 5000 ms) and THEN runs tools/list under MCP_TIMEOUT (`vl()`, default 30000 ms)
//    before `mcp_toggle` answers at all.
// → therefore EVERY verdict here is built from the free read-back (mcp_status), never from the fact that a
//   request was sent — and a state nobody read is 'unknown', not 'off'. Same rule as lib/pure.js
//   ultracodeState, deliberately the same shape of answer, so the UI has one pattern and not two.
//
// Two measured facts the UI has to SAY rather than hide, because they are not what „je Tab" suggests:
//  1. mcp_toggle WRITES. `W$e()` mutates `disabledMcpServers` (resp. `enabledMcpServers` for the CLI's own
//     builtin server) in the config, and the CLI's own documentation reads: „`/mcp disable <server>`
//     (persists to `\"disabledMcpServers\"` in the project entry of `~/.claude.json` …) … The `/mcp disable`
//     toggle is per-project: even for a user-scope server it applies to the current project only." So the
//     switch is PER PROJECT (cwd), not per tab — it outlives the session and reaches the next one in the
//     same directory. Which exact key the write lands under is NOT verified on this machine (no
//     disabledMcpServers exists in ~/.claude.json today), so the UI warns about the effect, not the file.
//  2. The session only knows the servers it was LAUNCHED with. lib/chat.js spawns a scoped tab with
//     `--mcp-config <temp> --strict-mcp-config`, and the handler looks the name up in
//     startupClients/sdkClients/dynamicClients, answering `Server not found: <name>` otherwise. So „live
//     dazuschalten" is not something mcp_toggle can do — see mcpSplitConfigured, which is what keeps the
//     restart path visible for exactly that case instead of offering a button that cannot work.

// The `status` enum as the 2.1.288 response schema declares it (eo(), „Current connection status").
var MCP_WIRE_STATES = ['connected', 'failed', 'needs-auth', 'pending', 'disabled'];
// The two states a reconnect is FOR („Reconnects a disconnected or failed MCP server"). 'disabled' is
// refused by the CLI, and 'connected'/'pending' have nothing to reconnect — offering it there would be a
// button whose only possible outcome is an error message.
var MCP_RECONNECT_STATES = ['failed', 'needs-auth'];

function mcpStr(v) { return (v == null) ? '' : String(v); }

// One row of mcp_status, reduced to what the tab menu may say about a server.
// An unrecognised status word becomes '' and is then treated as „nobody told us", NOT as off: the enum
// above is what THIS build declares, and a future CLI that adds a sixth state must not have it rendered
// as „aus" by accident. The raw word is kept so the UI can still name it.
function mcpStatusRows(data) {
  var list = (data && Array.isArray(data.mcpServers)) ? data.mcpServers : [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    if (!s || typeof s !== 'object') continue;
    var name = mcpStr(s.name).trim();
    if (!name) continue;                            // a nameless row cannot be addressed by mcp_toggle at all
    var raw = mcpStr(s.status);
    var row = { name: name, status: MCP_WIRE_STATES.indexOf(raw) >= 0 ? raw : '' };
    if (raw && !row.status) row.statusRaw = raw;
    var info = (s.serverInfo && typeof s.serverInfo === 'object') ? s.serverInfo : null;
    if (info && info.version != null) row.version = mcpStr(info.version);
    if (s.error) row.error = mcpStr(s.error);
    // @internal in the schema, and the UI needs exactly one of them: APPROVAL_REQUIRED means „a
    // project-scoped server awaiting the user's approval", which is NOT a broken connection and which the
    // reconnect handler refuses — see mcpCanReconnect.
    if (s.error_code) row.errorCode = mcpStr(s.error_code);
    if (s.scope) row.scope = mcpStr(s.scope);       // project · user · local · claudeai · managed · dynamic
    if (s.source) row.source = mcpStr(s.source);    // „Key trust on this, not on the name" (the CLI's own words)
    if (Array.isArray(s.tools)) row.tools = s.tools.length;
    var cfg = (s.config && typeof s.config === 'object') ? s.config : null;
    if (cfg && cfg.url) row.url = mcpStr(cfg.url);  // „includes URL for HTTP/SSE servers"
    out.push(row);
  }
  return out;
}
function mcpRow(rows, name) {
  var list = Array.isArray(rows) ? rows : [];
  var n = mcpStr(name);
  for (var i = 0; i < list.length; i++) if (list[i] && list[i].name === n) return list[i];
  return null;
}

// What the SESSION reports about this server, boiled down to the three answers a switch can be judged
// against. 'open' is the honest middle: the server is in the set but neither usable nor off.
function mcpReported(row) {
  if (!row) return 'none';
  if (row.status === 'disabled') return 'off';
  if (row.status === 'connected') return 'on';
  if (row.status === 'pending' || row.status === '') return 'open';   // still dialling / a state we don't know
  return 'half';                                                      // failed · needs-auth: enabled, not usable
}

// The verdict of a live switch. `wish` = what was asked for, `sent` = what controlRequest answered
// ({ok, unconfirmed, error}), `row` = the row of the mcp_status read-back that followed it (null = no read).
// → { state, status, reason, error, unconfirmed }
//   'on' / 'off'      the session REPORTS the wish — the only two states a button may present as done
//   'ineffective'     the session reports something that contradicts the wish (incl. „enabled but failed")
//   'unknown'         nothing was read, or the server is still dialling: no claim either way
//   'refused'         somebody answered and said no (the CLI's own wording travels in `error`)
//
// `unconfirmed` rides along in EVERY arm instead of forcing 'unknown', and that is the one place this
// deliberately differs from adoptUltracodeState (chat.js), with a reason: there the read-back reports the
// same FIELD before and after, so a read that overtook the apply is indistinguishable from a real one. Here
// the read-back is decisive by construction — a server can only be reported 'disabled' if the disable ran,
// and 'connected' after an enable of a disabled server likewise. What a timeout does cost is provenance,
// so it is passed on and the UI says „die Sitzung meldet X, auf die Schaltung selbst kam keine Antwort".
function mcpToggleVerdict(o) {
  o = o || {};
  var sent = o.sent || {};
  var wish = !!o.wish;
  var unconf = !!sent.unconfirmed;
  // A real refusal beats everything: „Server not found: <name>" (the --strict-mcp-config case),
  // „MCP server <name> is blocked by enterprise managed policy", „Connection failed", or the mapper's
  // `Server status: <type>` for a dial that ended in any non-connected state.
  if (sent.error) return { state: 'refused', error: mcpStr(sent.error), unconfirmed: unconf, status: o.row ? o.row.status : '' };
  var rep = mcpReported(o.row);
  if (rep === 'none') return { state: 'unknown', reason: 'no-status', status: '', unconfirmed: unconf };
  var st = o.row.status;
  if (rep === 'open') return { state: 'unknown', reason: st === 'pending' ? 'pending' : 'no-state', status: st, unconfirmed: unconf };
  if (wish && rep === 'on') return { state: 'on', status: st, unconfirmed: unconf };
  if (!wish && rep === 'off') return { state: 'off', status: st, unconfirmed: unconf };
  // Everything left over is a contradiction — and „enabled, but the connection failed" lands here on
  // purpose: the switch did what it was told and the server is still unusable, which is the one outcome a
  // green „eingeschaltet" would hide. The row's own error is passed on so the UI can name it.
  return { state: 'ineffective', status: st, reason: st, error: o.row.error ? mcpStr(o.row.error) : '', unconfirmed: unconf };
}
// Deliberately the SAME verdict as a toggle-on, and not out of laziness: the binary maps both subtypes
// through one function (`lt()`) — `type==='connected'` → success, `type==='failed'` → error „Connection
// failed", anything else → error „Server status: <type>". A second ruleset here could only disagree with
// the CLI. The one asymmetry worth knowing is a TIMING one and needs no code: a reconnect also does a
// tools/list and, on 'needs-auth', dials a second time after clearing its cache („Reconnect returned
// 'needs-auth'; retrying once after cache clear") — so it may take considerably longer than a connect.
function mcpReconnectVerdict(o) {
  o = o || {};
  return mcpToggleVerdict({ wish: true, sent: o.sent, row: o.row });
}

// May the menu offer „Neu verbinden" for this row? The 401 case the plan names (a server whose login
// expired) is `needs-auth`, usually with error_code CLAUDEAI_BEARER_REJECTED / FIRST_PARTY_AUTH_REJECTED.
// APPROVAL_REQUIRED is excluded although it ALSO arrives as needs-auth: the schema calls it „a
// project-scoped server awaiting the user's approval", the reconnect handler refuses servers that are not
// project-approved, and a button whose only outcome is that refusal is worse than no button.
function mcpCanReconnect(row) {
  if (!row) return false;
  if (row.errorCode === 'APPROVAL_REQUIRED') return false;
  return MCP_RECONNECT_STATES.indexOf(row.status) >= 0;
}
// What the live switch should ASK FOR next, read off the reported state. `null` = offer nothing: a status
// the panel does not understand ('' / a sixth state from a future CLI) must not be turned into a switch,
// because the only way to pick a direction would be to guess which one the server is in.
function mcpToggleWish(row) {
  if (!row || !row.status) return null;
  return row.status === 'disabled';
}
// Dot, CSS class and the i18n KEY for one status. Data, not DOM — the renderer in chat.js turns this into
// a span, and the key is resolved there (this file never calls t()/tt(); test/i18n.test.js still sees the
// keys because they are literals here).
function mcpStatusLook(status) {
  switch (status) {
    case 'connected': return { dot: '●', cls: 'ok', key: 'chat.mcpStatusConnected' };
    case 'pending': return { dot: '◌', cls: 'pending', key: 'chat.mcpStatusPending' };
    case 'failed': return { dot: '●', cls: 'bad', key: 'chat.mcpStatusFailed' };
    case 'needs-auth': return { dot: '▲', cls: 'warn', key: 'chat.mcpStatusNeedsAuth' };
    case 'disabled': return { dot: '○', cls: 'off', key: 'chat.mcpStatusDisabled' };
    default: return { dot: '?', cls: 'unknown', key: 'chat.mcpStatusUnbekannt' };
  }
}

// Split the machine's CONFIGURED server names against what this session actually has, because the two are
// not the same thing and the difference decides which control a row may show:
//   live     — the session knows it → mcp_toggle/mcp_reconnect can reach it NOW
//   extra    — configured but not in this session (a tab launched with a narrower --mcp-config, or a
//              server added after the launch): only a restart can bring it in, so the checklist stays
//   unlisted — the session has it but the machine config does not list it (scope 'dynamic'/'sdk', a plugin
//              server). It is still switchable; it just has no checkbox to pre-tick.
// Order follows `configured` for the first two and the read-back for the third, so the menu does not
// reshuffle itself between two reads.
function mcpSplitConfigured(configured, rows) {
  var cfg = Array.isArray(configured) ? configured.map(mcpStr) : [];
  var list = Array.isArray(rows) ? rows : [];
  var have = {};
  for (var i = 0; i < list.length; i++) if (list[i] && list[i].name) have[list[i].name] = true;
  var seen = {};
  var live = [], extra = [], unlisted = [];
  for (var j = 0; j < cfg.length; j++) {
    var n = cfg[j];
    if (!n || seen[n]) continue;
    seen[n] = true;
    (have[n] ? live : extra).push(n);
  }
  for (var k = 0; k < list.length; k++) {
    var r = list[k];
    if (r && r.name && !seen[r.name]) { seen[r.name] = true; unlisted.push(r.name); }
  }
  return { live: live, extra: extra, unlisted: unlisted };
}
// „n von m verbunden" for the menu head — counted from the read-back, so it cannot disagree with the dots
// below it. A row whose status we do not understand counts as neither connected nor off; it shows up in
// `unknown`, which is what keeps „3 von 3" from being printed over a session that answered with nonsense.
function mcpStatusSummary(rows) {
  var list = Array.isArray(rows) ? rows : [];
  var out = { total: list.length, connected: 0, disabled: 0, broken: 0, pending: 0, unknown: 0 };
  for (var i = 0; i < list.length; i++) {
    var st = list[i] ? list[i].status : '';
    if (st === 'connected') out.connected++;
    else if (st === 'disabled') out.disabled++;
    else if (st === 'failed' || st === 'needs-auth') out.broken++;
    else if (st === 'pending') out.pending++;
    else out.unknown++;
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MCP_WIRE_STATES, MCP_RECONNECT_STATES,
    mcpStatusRows, mcpRow, mcpReported, mcpToggleVerdict, mcpReconnectVerdict,
    mcpCanReconnect, mcpToggleWish, mcpStatusLook, mcpSplitConfigured, mcpStatusSummary,
  };
}
