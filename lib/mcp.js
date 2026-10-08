'use strict';
// MCP server management: list/get/tools-probe/config-build + update-check (npm/pypi/git).
// Extracted from server.js (structure-only refactor).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const readline = require('readline');
const { CLAUDE_JSON } = require('./paths');
const { run, maskInfo, maskArgsLine, maskUrl, maskArgToken, maskTransport, killTree, readJsonFile, errorText } = require('./core');
const { isNetworkPath } = require('./reach');
const github = require('./github'); // only for the git-auth env rules (DAG leaf — no cycle)
// B1/FLOW-6: no `claude mcp …` while `claude update` replaces the binary (lib/cli no longer requires
// this module, so the edge is one-way). The three spawners below answer their normal error shape.
// claudeSpawn from the same module is THE way to start the binary — see lib/cli.js. The three calls
// below used to be bare `execFile(CLAUDE_EXE, …)`, which bypassed the CLAUDE_UI_FAKE_BIN seam, so no
// test could ever reach their success branch.
const { isCliUpdating, claudeSpawn } = require('./cli');

// `claude mcp list` is a HEALTH check: it connects to every configured server before it prints a
// single line, so its runtime grows with the server count (~4 s each; 9 servers ≈ 35 s here) and it
// is the wrong source for the mere QUESTION "which servers exist". It used to be the only source,
// and when the wall-clock passed the timeout below every feature built on it died at once —
// update-check, git pull, inventory, the bulk tool probe. Those now read the config (see
// configuredServers) and only genuine health still waits for the CLI. Timeout kept generous.
const MCP_LIST_TIMEOUT_MS = 120000;
// NOTE on why these three go through claudeSpawn/run() and not through execFile: a spawn can fail
// SYNCHRONOUSLY (bad/absent CLAUDE_EXE → `spawn EFTYPE`/ENOENT). Unwrapped that propagates out of the
// route and the router's catch-all turns a misconfigured CLI into a 500 on /api/mcp, /api/mcp/tools and
// /api/mcp/inventory. run() catches exactly that and reports it as a normal `{ err }` result, so the
// hand-rolled try/catch around each execFile is no longer needed — and the CLAUDE_UI_FAKE_BIN seam
// comes along, which is what makes the SUCCESS branch testable at all.
async function getMcpList() {
  if (isCliUpdating()) return { servers: [], error: 'cli-updating', code: 'cli-updating' };
  const r = await claudeSpawn(['mcp', 'list'], { timeout: MCP_LIST_TIMEOUT_MS });
  const servers = [];
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_.-]+):\s+(.*?)\s+-\s+(.+)$/);
    if (m) {
      const status = m[3];
      servers.push({
        name: m[1],
        transport: m[2],
        status: status.replace(/[✔✖✓✗√]/g, '').replace(/^[^A-Za-z0-9]+/, '').trim(),
        ok: /✔|✓|√|Connected/i.test(status),
      });
    }
  }
  return { servers, error: r.err ? errorText(r.err) : null };
}
// The configured server set straight from ~/.claude.json: [{ name, transport }], no health check,
// no CLI, milliseconds. `transport` is the same printable string `claude mcp list` shows (URL for
// http/sse, `command args…` for stdio) so parseMcpTarget/enrichMcp accept it unchanged.
// User scope (top level) wins over project scope, matching the CLI's own precedence.
// Never returns env/headers — callers hand this to the browser.
async function configuredServers() {
  const cj = await readJsonFile(CLAUDE_JSON);
  const parsed = (cj && cj.parsed) || {};
  const out = new Map(); // name -> transport
  const addMap = (m) => {
    if (!m || typeof m !== 'object') return;
    for (const name of Object.keys(m)) {
      if (out.has(name)) continue;
      const s = m[name] || {};
      const transport = s.url ? s.url : [s.command].concat(Array.isArray(s.args) ? s.args : []).filter(Boolean).join(' ');
      out.set(name, transport || s.command || s.url || '');
    }
  };
  addMap(parsed.mcpServers);
  const projs = parsed.projects || {};
  for (const key of Object.keys(projs)) addMap(projs[key] && projs[key].mcpServers);
  return [...out.entries()].map(([name, transport]) => ({ name, transport }));
}
// SEC-3. `transport` stays RAW in configuredServers()/getMcpList() on purpose: it is also the INPUT to
// parseMcpTarget, pkgEntryMtime and npmInfo, and a mask applied there would classify `npx pkg@latest`
// as "local" and silently kill every update check. A mask applied too early breaks the logic it was
// meant to protect — so the masking happens on the way OUT, in the routes that hand a row to the
// browser (`GET /api/mcp`, `GET /api/mcp/configured`). Scope and limits: lib/core.js maskTransport.
function mcpRowSafe(s) {
  if (!s || typeof s !== 'object' || s.transport == null) return s;
  return { ...s, transport: maskTransport(s.transport) };
}
// Transport of ONE configured server ('' if unknown) — what an update check/pull needs to classify it.
async function configuredTransport(name) {
  const hit = (await configuredServers()).find((s) => s.name === name);
  return (hit && hit.transport) || '';
}
// mask secret-looking env values (keep the config viewable but not leak tokens)
// parse `claude mcp get <name>` into structured detail (env secrets masked)
function parseMcpGet(stdout) {
  const out = { scope: '', status: '', ok: false, type: '', command: '', args: '', url: '', env: {}, headers: {}, envMeta: {}, headersMeta: {} };
  const lines = (stdout || '').split(/\r?\n/);
  let section = null;
  for (const line of lines) {
    const kv = line.match(/^\s{2}([A-Za-z][A-Za-z ]*?):\s*(.*)$/);
    if (kv) {
      const k = kv[1].trim().toLowerCase(), v = kv[2].trim();
      if (k === 'scope') out.scope = v;
      else if (k === 'status') { out.status = v.replace(/[✔✖✓✗√]/g, '').replace(/^[^A-Za-z0-9]+/, '').trim(); out.ok = /✔|✓|√|connected/i.test(v); }
      else if (k === 'type') out.type = v;
      // SEC-3: `command`, `args` and `url` are masked HERE, at the one parser whose output is
      // display-only — mcpGetPayload → GET /api/mcp/get → the MCP view, "Config kopieren" and the
      // Markdown inventory. The SPAWN config comes from a different parser (mcpRawConfigViaCli /
      // rawConfigFromFile) and stays unmasked, because a masked token would launch a broken server.
      else if (k === 'command') out.command = maskArgToken(v);
      else if (k === 'args') out.args = maskArgsLine(v);
      else if (k === 'url') out.url = maskUrl(v);
      else if (k === 'environment') section = 'env';
      else if (k === 'headers') section = 'headers';
      else section = null;
      continue;
    }
    // Env entries print as `KEY=value`, headers as `key: value` — accept BOTH separators. The old
    // `=`-only pattern silently dropped every header from `detail`, which is exactly why the copy
    // button had to fall back to the raw (unmasked) stdout. Key part is lazy so a value containing
    // ':' or '=' (URLs, base64 padding) stays intact.
    const deep = line.match(/^\s{4,}([^:=]+?)\s*[:=]\s*(.*)$/);
    if (deep && section) {
      const key = deep[1].trim();
      const info = maskInfo(key, deep[2]);
      out[section][key] = info.value;
      if (info.masked) out[section === 'env' ? 'envMeta' : 'headersMeta'][key] = { masked: true, len: info.len };
    }
  }
  return out;
}
// Re-print a parsed (MASKED) detail in `claude mcp get` layout. This is what the MCP view's
// "Config kopieren" hands to the clipboard — the raw stdout must never leave the server because it
// carries Headers:/Environment: values (x-jira-authorization & friends) in PLAINTEXT.
function serializeMcpGet(name, d) {
  const L = [(name || 'server') + ':'];
  const kv = (label, v) => { if (v) L.push('  ' + label + ': ' + v); };
  kv('Scope', d.scope);
  kv('Status', d.status);
  kv('Type', d.type);
  kv('Command', d.command);
  kv('Args', d.args);
  kv('URL', d.url);
  const envKeys = Object.keys(d.env || {});
  if (envKeys.length) { L.push('  Environment:'); envKeys.forEach((k) => L.push('    ' + k + '=' + d.env[k])); }
  const hdrKeys = Object.keys(d.headers || {});
  if (hdrKeys.length) { L.push('  Headers:'); hdrKeys.forEach((k) => L.push('    ' + k + ': ' + d.headers[k])); }
  return L.join('\n') + '\n';
}
// Pure payload builder — the exact object /api/mcp/get returns, so a unit test can assert
// "no unmasked value survives" without spawning the CLI.
function mcpGetPayload(name, stdout, err) {
  const detail = parseMcpGet(stdout || '');
  const config = serializeMcpGet(name, detail);
  // `raw` keeps its name (views-mcp.js copies j.raw) but now holds the MASKED re-serialisation.
  return { detail, config, raw: config, error: err ? errorText(err) : null };
}
async function mcpGet(name) {
  if (isCliUpdating()) return mcpGetPayload(name, '', new Error('cli-updating'));
  const r = await claudeSpawn(['mcp', 'get', name], { timeout: 30000 });
  return mcpGetPayload(name, r.stdout || '', r.err);
}

// --- MCP direct tool query ---------------------------------------------------------------------
// The CLI exposes no tool list, and a chat session defers MCP tools (system/init lists 0 MCP tools —
// servers connect async). So we ask each server itself via the MCP protocol: spawn its stdio
// transport, JSON-RPC `initialize` + `tools/list`. `serverInfo` also yields the real server version.
// Read-only (schemas only, no data). Config (incl. UNMASKED env for the spawn) comes from `mcp get`
// and is used server-side only — never returned to the client.
// Same thing straight from ~/.claude.json — command, argv, env, url and headers as stored, nothing
// parsed out of a CLI table. Preferred over `claude mcp get` because that CONNECTS to the server
// before it prints: for the slowest server here it never made the 25 s window, so the tool probe
// reported "Konfiguration nicht lesbar" for a perfectly healthy server. `argv` keeps the arguments
// as an array — round-tripping them through a string broke any argument containing a space.
async function rawConfigFromFile(name) {
  const cj = await readJsonFile(CLAUDE_JSON);
  const parsed = (cj && cj.parsed) || {};
  let s = (parsed.mcpServers || {})[name];
  if (!s) { // project scope
    for (const key of Object.keys(parsed.projects || {})) {
      const m = (parsed.projects[key] && parsed.projects[key].mcpServers) || {};
      if (m[name]) { s = m[name]; break; }
    }
  }
  if (!s || typeof s !== 'object') return null;
  const argv = Array.isArray(s.args) ? s.args.map(String) : [];
  return {
    type: s.type || (s.url ? 'http' : 'stdio'),
    command: s.command || '',
    argv,
    args: argv.map((a) => (/\s/.test(a) ? '"' + a + '"' : a)).join(' '),
    url: s.url || '',
    env: (s.env && typeof s.env === 'object') ? s.env : {},
    headers: (s.headers && typeof s.headers === 'object') ? s.headers : {},
  };
}
async function mcpRawConfigViaCli(name) {
  if (isCliUpdating()) return null;
  const r = await claudeSpawn(['mcp', 'get', name], { timeout: 25000 });
  const out = r.stdout || '';
  if (!out) return null; // includes a synchronous spawn failure — run() reports that as { err } too
  const get = (re) => ((out.match(re) || [])[1] || '').trim();
  const cfg = { type: get(/^\s{2}Type:\s*(.+)$/m), command: get(/^\s{2}Command:\s*(.+)$/m), args: get(/^\s{2}Args:\s*(.+)$/m), url: get(/^\s{2}URL:\s*(.+)$/m), env: {}, headers: {} };
  const eb = out.split(/^\s{2}Environment:\s*$/m)[1];
  if (eb) for (const l of eb.split(/\r?\n/)) { const m = l.match(/^\s{4,}([^=]+)=(.*)$/); if (m) cfg.env[m[1].trim()] = m[2]; else if (l.trim() && !/^\s{4,}/.test(l)) break; }
  const hb = out.split(/^\s{2}Headers:\s*$/m)[1];
  if (hb) for (const l of hb.split(/\r?\n/)) { const m = l.match(/^\s{4,}([^:=]+)[:=]\s*(.*)$/); if (m) cfg.headers[m[1].trim()] = m[2]; else if (l.trim() && !/^\s{4,}/.test(l)) break; }
  return cfg;
}
// File first, CLI as the fallback (a `.mcp.json` project server isn't in ~/.claude.json).
async function mcpRawConfig(name) {
  return (await rawConfigFromFile(name)) || (await mcpRawConfigViaCli(name));
}
// argv as stored beats re-splitting a printed string; the split stays for the CLI fallback.
function cfgArgv(cfg) {
  if (Array.isArray(cfg.argv)) return cfg.argv;
  return ((cfg.args || '').match(/(?:[^\s"]+|"[^"]*")+/g) || []).map((a) => a.replace(/^"|"$/g, ''));
}
// How long a server may take from spawn to `tools/list`. 20 s was too short for the real world: a
// `uvx <pkg>@latest` server re-resolves its package against PyPI on EVERY start — measured 27,7 s
// here — so its card always reported "keine Tools" while the CLI connected to it just fine.
const MCP_PROBE_TIMEOUT_MS = 45000;
// The MCP protocol revision this probe offers, and the fallback it accepts a refusal with.
//
// It stood at '2024-11-05' — a guess from the SDK's docs, four revisions behind. MEASURED out of the
// binary this machine actually runs (claude.exe 2.1.288, 249 MB, strings read as latin1 — the same way
// this project measured the control-request schemas):
//   · `var rye="2025-11-25", nRr="2025-03-26", DY=[rye,"2025-06-18","2025-03-26","2024-11-05","2024-10-07"]`
//     exported as LATEST_PROTOCOL_VERSION, DEFAULT_NEGOTIATED_PROTOCOL_VERSION and
//     SUPPORTED_PROTOCOL_VERSIONS respectively;
//   · the client's default list `oFe=["2025-11-25","2025-06-18","2025-03-26","2024-11-05","2024-10-07"]`;
//   · and `_legacyHandshake` sends `protocolVersion: a` where `a` is the FIRST pre-2026-07-28 entry of
//     that list. So a stdio server on this machine is initialized by the CLI with **2025-11-25**.
// (2026-07-28 exists in the binary too, as the "modern era" that requires a `server/discover` probe and
//  a `_meta` envelope. That is a different handshake, not a version this probe may simply put in its
//  `initialize` — hence the newest LEGACY revision, which is what the CLI itself uses here.)
//
// Why a fallback at all: the spec says a server that does not know the offered revision answers with
// one it does know, and the handshake continues — but a STRICT server answers a JSON-RPC error instead,
// and this probe reports JSON-RPC errors (rightly, since #23). Moving four revisions forward would turn
// a healthy old server's card from "12 Tools" into an error, so a refusal that NAMES the protocol is
// retried once with the old value, on the SAME connection (no second spawn, one extra round trip).
const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2024-11-05'];
function queryMcpToolsStdio(cfg) {
  return new Promise((resolve) => {
    const args = cfgArgv(cfg);
    let child; try { child = spawn(cfg.command, args, { windowsHide: true, env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ error: errorText(e) }); }
    let done = false, info = null, to = null, nonJson = 0, verIdx = 0;
    // clearTimeout on completion: without it the 20s guard below kept an active timer (and this whole
    // closure, incl. the child handle) alive for 20s after every probe — 20+ servers × every refresh.
    const fin = (r) => { if (done) return; done = true; if (to) { clearTimeout(to); to = null; } try { rl.close(); } catch {} try { child.stdin.end(); } catch {} killTree(child); resolve(r); };
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch {} };
    // id 1 = the first initialize, id 11 = the retry with the older revision, id 2 = tools/list.
    const INIT_IDS = new Set([1, 11]);
    const sendInit = (id) => send({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSIONS[verIdx], capabilities: {}, clientInfo: { name: 'ccui', version: '1' } } });
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      // Skipping a non-JSON line is right — servers do print banners and logs on stdout. Skipping it
      // without leaving a trace was not (#23): a server whose ANSWER does not parse (a framing bug, a
      // truncated line, a debug print glued in front of the reply) then looked exactly like one that
      // never answered at all, and the card said "timeout (45 s)" 45 seconds later. So the line is
      // COUNTED and the count is named in the timeout below. The content stays out of the message for
      // the same reason stderr does: it likes to quote the token the server was called with.
      if (!line.trim()) return; let o; try { o = JSON.parse(line); } catch { nonJson++; return; }
      // A JSON-RPC ERROR is an ANSWER. It was dropped on the floor, so a server that REFUSES
      // initialize/tools/list (missing token, bad argument, unsupported protocol version) looked
      // exactly like one that never replied: the card said "timeout (45 s)" — 45 seconds later.
      if ((INIT_IDS.has(o.id) || o.id === 2) && o.error) {
        const msg = String((o.error && o.error.message) || 'Fehler').replace(/\s+/g, ' ').slice(0, 300);
        // A refusal that NAMES the protocol revision is the one case worth a second try (see
        // MCP_PROTOCOL_VERSIONS): offer the old value on the same connection instead of reporting an
        // error for a server that is perfectly healthy and merely older than the CLI.
        if (INIT_IDS.has(o.id) && verIdx + 1 < MCP_PROTOCOL_VERSIONS.length && /protocol|version/i.test(msg)) { verIdx++; return sendInit(11); }
        return fin({ error: 'JSON-RPC-Fehler' + ((o.error && o.error.code != null) ? ' ' + o.error.code : '') + ': ' + msg });
      }
      if (INIT_IDS.has(o.id) && o.result) { info = o.result.serverInfo || null; send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }); }
      else if (o.id === 2) { const tools = ((o.result && o.result.tools) || []).map((t) => ({ name: t.name, description: String(t.description || '').replace(/\s+/g, ' ').slice(0, 240) })); fin({ tools, version: (info && info.version) || '', serverName: (info && info.name) || '' }); }
    });
    // Drain stderr. The child is spawned with a stderr PIPE that nobody read, so a server that writes
    // more than the pipe buffer holds (~64 KB — a `uvx`/`npx` download progress log gets there) BLOCKS
    // on its next write, before it ever answers tools/list: the probe could then only end in the
    // timeout. Discarded on purpose rather than reported: a failing server's stderr tends to quote the
    // token or header it was called with, and this text ends up on the MCP card.
    child.stderr.on('data', () => {});
    child.on('error', (e) => fin({ error: errorText(e) }));
    // Name the END, not just the fact: one fixed string covered a missing package, an immediate crash
    // and our own kill, so the card could not tell the user which of the three it was.
    // The dropped-line count belongs on this branch too: a server that prints a malformed or
    // truncated answer and then exits is exactly the case #23 is about, and without it the card
    // reports only the exit code.
    child.on('exit', (code, signal) => fin({ error: 'Server vor tools/list beendet (' + (signal ? 'Signal ' + signal : 'Exit-Code ' + code)
      + (nonJson ? ', ' + nonJson + ' Zeile(n) auf stdout waren kein JSON' : '') + ')' }));
    sendInit(1);
    to = setTimeout(() => fin({ error: 'timeout (' + Math.round(MCP_PROBE_TIMEOUT_MS / 1000) + ' s ohne Antwort'
      + (nonJson ? ', ' + nonJson + ' Zeile(n) auf stdout waren kein JSON' : '') + ')' }), MCP_PROBE_TIMEOUT_MS);
    if (done) { clearTimeout(to); to = null; } // fin() may have raced the assignment (server exited instantly)
  });
}
const mcpToolsCache = new Map(); // name -> { at, result }
const MCP_TOOLS_TTL = 5 * 60 * 1000;
// ---- PERF-1: one gate for every probe, and never the same server twice at once -----------------------
// A probe SPAWNS a real server (node/python/uvx, up to 45 s, its own sockets). Two things were missing,
// and only one of them had a workaround:
//   · the FAN-OUT was bounded in ONE route (`GET /api/mcp/tools`, mapLimit 3) — so `GET /api/mcp/check`
//     and every future caller spawned without any limit, and N parallel clicks meant N servers.
//     The gate therefore lives HERE, where the spawn is, not in one of the callers.
//   · nothing DEDUPED: the cache is only written when a probe FINISHES, so a second request for the
//     same server while the first is still running started a second server — reliably reproducible by
//     clicking two cards of the same slow server, and by the tools route racing a check route.
// MEASURED ceiling: 3, the same number the route used. Not derived from anything but "a click must not
// stall the machine"; it is the smallest number that still lets a view of 9 servers finish in ~3 waves.
// WHAT THE GATE DOES NOT COVER, said here rather than discovered later: it wraps queryMcpToolsStdio, so
// it bounds the MCP SERVERS. The step in front of it can spawn too — for a server that is not in
// ~/.claude.json, mcpRawConfig falls back to `claude mcp get <name>` (25 s). That spawn is still only
// bounded by the caller (GET /api/mcp/tools' mapLimit; GET /api/mcp/check asks for one name). → ideas N8.
const MCP_PROBE_CONCURRENCY = 3;
const mcpProbeInFlight = new Map(); // name -> the one running promise
let probeBusy = 0;
const probeWaiting = [];
function probeGate() {
  if (probeBusy < MCP_PROBE_CONCURRENCY) { probeBusy++; return Promise.resolve(); }
  return new Promise((resolve) => probeWaiting.push(resolve));
}
function probeRelease() {
  const next = probeWaiting.shift();
  if (next) next(); else probeBusy--;   // the slot is HANDED OVER, so probeBusy stays exact
}
async function probeMcpTools(name) {
  const cfg = await mcpRawConfig(name);
  let result;
  if (!cfg) result = { error: 'Konfiguration nicht lesbar' };
  else if (/http|sse/i.test(cfg.type) || (!cfg.command && cfg.url)) result = { transport: cfg.type || 'http', error: 'HTTP/SSE-Server — Tools nur über eine Chat-Session sichtbar' };
  else if (cfg.command) {
    // only the SPAWNING branch takes a slot — an http/sse row and an unreadable config cost nothing and
    // must not queue behind three slow stdio servers.
    // `finally`, not a release after the await: queryMcpToolsStdio resolves rather than rejects today,
    // but a slot that leaks once is a gate that closes for the rest of the process lifetime.
    await probeGate();
    try { result = await queryMcpToolsStdio(cfg); } finally { probeRelease(); }
  } else result = { error: 'unbekannter Transport' };
  result.ts = Date.now();
  mcpToolsCache.set(name, { at: Date.now(), result });
  return result;
}
function getMcpTools(name) {
  const c = mcpToolsCache.get(name);
  if (c && Date.now() - c.at < MCP_TOOLS_TTL) return Promise.resolve(c.result);
  const live = mcpProbeInFlight.get(name);
  if (live) return live;   // JOIN the running probe instead of starting a second server
  // The in-flight entry is removed on settle, not in a .finally() chain the callers receive: every
  // caller must get the SAME promise, so the map holds exactly the promise that is handed out.
  const p = probeMcpTools(name);
  mcpProbeInFlight.set(name, p);
  p.then(() => mcpProbeInFlight.delete(name), () => mcpProbeInFlight.delete(name));
  return p;
}

// Build a temp `--mcp-config` file containing ONLY the named servers (full, UNMASKED defs read via
// `mcp get`). Launched with `--strict-mcp-config` this makes a chat session see exactly this set.
// An empty `names` yields a valid zero-server config. Written 0600 to the OS temp dir, deleted on exit.
const MCP_CFG_DIR = path.join(os.tmpdir(), 'claude-code-ui-mcp');
// Boot-time sweep: the per-chat configs are normally unlinked on the child's exit, but a server
// crash/kill leaves them behind — and they contain UNMASKED env/headers. Anything older than an
// hour can't belong to a live chat of this fresh process, so clear it out.
(async () => {
  try {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const f of await fsp.readdir(MCP_CFG_DIR)) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(MCP_CFG_DIR, f);
      try { if ((await fsp.stat(full)).mtimeMs < cutoff) await fsp.unlink(full); } catch { /* */ }
    }
  } catch { /* dir doesn't exist yet */ }
})();
async function buildMcpConfigFile(names) {
  const mcpServers = {};
  for (const name of (names || [])) {
    const cfg = await mcpRawConfig(name);
    if (!cfg) continue;
    const type = (cfg.type || '').toLowerCase();
    let entry;
    if (cfg.url && /http|sse/.test(type)) {
      entry = { type: type.includes('sse') ? 'sse' : 'http', url: cfg.url };
      if (cfg.headers && Object.keys(cfg.headers).length) entry.headers = cfg.headers;
    } else if (cfg.command) {
      entry = { type: 'stdio', command: cfg.command };
      const a = cfgArgv(cfg);
      if (a && a.length) entry.args = a;
      if (cfg.env && Object.keys(cfg.env).length) entry.env = cfg.env;
    } else { continue; }
    mcpServers[name] = entry;
  }
  // 0700 on the DIRECTORY, not only 0600 on the file: this lives in the shared OS temp dir and the files
  // in it hold UNMASKED MCP env/headers. A default-mode dir (0777 & ~umask) lets any local account list
  // the names and, on a machine with a lax umask, drop files in beside them. Windows ignores the mode.
  await fsp.mkdir(MCP_CFG_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(MCP_CFG_DIR, crypto.randomUUID() + '.json');
  await fsp.writeFile(file, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
  return file;
}

function firstGitAncestor(startPath) {
  let dir = startPath;
  for (let i = 0; i < 8 && dir; i++) {
    try { if (fs.existsSync(path.join(dir, '.git'))) return dir; } catch { /* */ }
    const parent = path.dirname(dir);
    if (parent === dir) break; dir = parent;
  }
  return null;
}
function parseMcpTarget(transport) {
  const t = (transport || '').trim();
  if (/^https?:\/\//i.test(t)) return { kind: 'http' };
  // uvx / pipx / uv tool run <pkg>[@ver] → PyPI. MUST come before the npm @latest match: `uvx ha-mcp@latest`
  // otherwise matches the npm regex and gets checked against the npm registry (wrong). ToDo 06.
  const uvx = t.match(/\b(?:uvx(?:\.exe)?|pipx(?:\.exe)?|uv(?:\.exe)?\s+tool\s+run)\s+(?:--[^\s]+\s+)*([A-Za-z0-9][\w.-]*)/i);
  if (uvx) return { kind: 'pypi', pkg: uvx[1].replace(/@.*$/, '') };
  const npm = t.match(/(@?[\w][\w.-]*\/?[\w.-]*)@latest/);
  if (npm) return { kind: 'npm', pkg: npm[1] };
  const paths = t.match(/[A-Za-z]:[\\/][^\s"]+|\/[^\s"]+/g) || [];
  // N12 — the second alternative of that regex also catches the forward-slash spelling of a UNC path
  // (`//host/share/…`), and one synchronous lookup of a dead host held the whole server for ~44 s — up to
  // nine in a row with firstGitAncestor's walk. Such a path is not looked at: it is reported as „network
  // path, not checked" (`network: true`), which keeps this function synchronous and pure for its three
  // callers. A LOCAL path in the same transport is still classified as before.
  let network = false;
  for (const raw of paths) {
    const norm = raw.replace(/\\/g, '/');
    if (isNetworkPath(norm)) { network = true; continue; }
    let start; try { start = fs.existsSync(norm) && fs.statSync(norm).isDirectory() ? norm : path.dirname(norm); } catch { start = path.dirname(norm); }
    const git = firstGitAncestor(start);
    if (git) return { kind: 'git', repoDir: git };
  }
  return network ? { kind: 'local', network: true } : { kind: 'local' };
}
// best-effort "last updated" for local/venv installs with no registry: newest mtime among referenced paths
function pkgEntryMtime(transport) {
  const paths = (transport || '').match(/[A-Za-z]:[\\/][^\s"]+|\/[^\s"]+/g) || [];
  let newest = 0;
  for (const raw of paths) { const norm = raw.replace(/\\/g, '/'); if (isNetworkPath(norm)) continue; try { const m = fs.statSync(norm).mtimeMs; if (m > newest) newest = m; } catch { /* */ } }
  return newest ? new Date(newest).toISOString() : '';
}
// tiny JSON GET for the PyPI registry (npm/git use their own CLIs, which already honour the corporate proxy)
function httpsJson(u, timeoutMs) {
  return new Promise((resolve) => {
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const https = require('https');
      const rq = https.get(u, { timeout: timeoutMs || 8000, headers: { accept: 'application/json', 'user-agent': 'ccui-mcp-check' } }, (r) => {
        if (r.statusCode !== 200) { r.resume(); return fin(null); }
        let d = ''; r.on('data', (c) => { d += c; if (d.length > 4e6) r.destroy(); }); r.on('end', () => { try { fin(JSON.parse(d)); } catch { fin(null); } });
      });
      rq.on('error', () => fin(null)); rq.on('timeout', () => { rq.destroy(); fin(null); });
    } catch { fin(null); }
  });
}
// The env for a git call in an MCP server's repo — see gitEnvForRemote/gitFetchTarget. Without it this
// fetch popped a Git Credential Manager WINDOW per private repo (these clones carry
// `credential.helper = manager`), once for every "check updates" in the MCP view. The rule itself lives
// in lib/github.js so there is one place that decides where the PAT may go.
async function gitUpdateInfo(dir) {
  const branch = (await run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout || '?';
  // The remote the fetch will contact is resolved first (branch.<b>.remote, else origin) and NAMED in
  // the argv: without it a bare `git fetch` could go to a remote other than the one whose url decided
  // the token — an MCP server is a clone of anything, including a fork tracking a foreign upstream.
  const remote = await github.gitFetchTarget(dir, run);
  const fetch = await run('git', ['-C', dir, 'fetch', '--quiet', ...remote.args], { timeout: 30000, env: remote.env });
  if (fetch.err) return { kind: 'git', repoDir: dir, branch, status: 'fetch failed', updateAvailable: false, lastUpdated: '', note: (fetch.stderr || '').slice(0, 160) };
  const behindR = await run('git', ['-C', dir, 'rev-list', '--count', 'HEAD..@{u}']);
  const behind = behindR.err ? 0 : (parseInt(behindR.stdout, 10) || 0);
  const logR = (await run('git', ['-C', dir, 'log', '-1', '--format=%h|%cI'])).stdout;
  const [cur, date] = (logR || '').split('|');
  return { kind: 'git', repoDir: dir, branch, behind, updateAvailable: behind > 0, current: cur, date: date || '', lastUpdated: date || '', status: behind > 0 ? (behind + ' behind') : 'up to date' };
}
// `env` = the MCP server's own environment. A server installed from a PRIVATE registry carries that
// registry in `npm_config_*` (that is how npx finds it at all), and without those two variables
// `npm view` answers E404 and the tile said a flat "check failed" for a package that is perfectly
// fine. ONLY the npm_config_* keys are forwarded — the rest of a server's env is tokens.
function npmEnvFrom(env) {
  const out = {};
  for (const k of Object.keys(env || {})) if (/^npm_config_/i.test(k)) out[k] = env[k];
  return Object.keys(out).length ? { ...process.env, ...out } : undefined;
}
async function npmInfo(pkg, installed, env) {
  const npmEnv = npmEnvFrom(env);
  const vR = await run('npm', ['view', pkg, 'version'], { timeout: 25000, shell: true, env: npmEnv });
  const latest = vR.err ? null : (vR.stdout || '').trim();
  let lastUpdated = '';
  if (latest) { const tR = await run('npm', ['view', pkg, 'time.modified'], { timeout: 25000, shell: true, env: npmEnv }); if (!tR.err) lastUpdated = (tR.stdout || '').trim(); }
  const updateAvailable = !!(installed && latest && installed !== latest);
  // Registry unreachable/unknown: say so, and still report what is actually RUNNING rather than
  // throwing away the one fact we have.
  const failed = installed ? ('läuft v' + installed + ' · Registry nicht erreichbar') : 'check failed (Registry nicht erreichbar)';
  return { kind: 'npm', pkg, latest, current: installed || null, updateAvailable, lastUpdated,
    status: latest ? (installed ? (updateAvailable ? ('Update → v' + latest) : ('aktuell · v' + latest)) : ('npm @latest · v' + latest)) : failed };
}
async function pypiInfo(pkg, installed) {
  const j = await httpsJson('https://pypi.org/pypi/' + encodeURIComponent(pkg) + '/json', 8000);
  if (!j || !j.info) return { kind: 'pypi', pkg, latest: null, updateAvailable: false, lastUpdated: '', status: 'check failed (PyPI nicht erreichbar)' };
  const latest = j.info.version;
  let lastUpdated = '';
  try { const rel = (j.releases && j.releases[latest]) || []; lastUpdated = (rel[0] && (rel[0].upload_time_iso_8601 || rel[0].upload_time)) || ''; } catch { /* */ }
  const updateAvailable = !!(installed && latest && installed !== latest);
  return { kind: 'pypi', pkg, latest, current: installed || null, updateAvailable, lastUpdated,
    status: latest ? (installed ? (updateAvailable ? ('Update → v' + latest) : ('aktuell · v' + latest)) : ('PyPI · v' + latest)) : 'check failed' };
}
async function enrichMcp(servers) {
  return Promise.all(servers.map(async (s) => {
    const tgt = parseMcpTarget(s.transport);
    let installed = null; // running version from a prior probe (cache only — never force-spawn on a bulk check)
    try { const c = mcpToolsCache.get(s.name); if (c && c.result && c.result.version) installed = c.result.version; } catch { /* */ }
    let info;
    if (tgt.kind === 'http') info = { kind: 'http', updateAvailable: false, status: 'remote (server-managed)', lastUpdated: '' };
    else if (tgt.kind === 'npm') info = await npmInfo(tgt.pkg, installed, ((await rawConfigFromFile(s.name)) || {}).env);
    else if (tgt.kind === 'pypi') info = await pypiInfo(tgt.pkg, installed);
    else if (tgt.kind === 'git') info = await gitUpdateInfo(tgt.repoDir);
    else if (tgt.network) info = { kind: 'local', network: true, updateAvailable: false, status: 'Netzpfad, nicht geprüft', lastUpdated: '' };
    else info = { kind: 'local', updateAvailable: false, status: 'lokale Installation', lastUpdated: pkgEntryMtime(s.transport) };
    return { ...s, update: info };
  }));
}

module.exports = {
  getMcpList, configuredServers, configuredTransport, rawConfigFromFile, cfgArgv, mcpRowSafe,
  parseMcpGet, serializeMcpGet, mcpGetPayload, mcpGet, mcpRawConfig, getMcpTools, mcpToolsCache,
  buildMcpConfigFile, enrichMcp, parseMcpTarget, npmInfo,
  MCP_PROTOCOL_VERSIONS, MCP_PROBE_CONCURRENCY,
};
