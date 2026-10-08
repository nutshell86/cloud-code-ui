'use strict';
// Skills/commands registry, UI-skill manifests, memory files, and config-file collections
// (agents/output-styles/commands). Extracted from server.js (structure-only refactor).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const readline = require('readline');
const { CLAUDE_DIR, HOME, PROJECTS_DIR, PLUGINS_DIR, PLANS_DIR, CLAUDE_EXE } = require('./paths');
const { parseFrontmatter, projectCwd, decodeProject, extractText, killTree, errorText } = require('./core');
const { isCliUpdating } = require('./cli'); // B1/FLOW-6: no registry probe while the binary is replaced
const { memoryLinkTargets } = require('./pure'); // MEM-LINK: one rule for „what does this memory file link to"

async function listMemory() {
  const out = [];
  let projectDirs = [];
  try { projectDirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    const memDir = path.join(PROJECTS_DIR, d.name, 'memory');
    let files = [];
    try { files = await fsp.readdir(memDir); } catch { continue; }
    const items = [];
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      try {
        const full = path.join(memDir, f);
        const st = await fsp.stat(full);
        const content = await fsp.readFile(full, 'utf8');
        const fm = parseFrontmatter(content);
        // type lives at frontmatter metadata.type; \btype avoids matching node_type
        const type = (fm.type || (content.match(/\btype:\s*([\w|-]+)/) || [])[1] || '').split('|')[0].trim();
        // MEM-LINK — BOTH link forms, not just `[[wiki]]`: the CLI writes MEMORY.md with ordinary Markdown
        // links (`[title](slug.md)`), so the one file that points at every other one reported none, and the
        // 🔗 count / backlinks / graph were all empty for the real data. One rule, in lib/pure.js.
        items.push({ name: f, size: st.size, mtime: st.mtimeMs, description: fm.description || '', type, links: memoryLinkTargets(content) });
      } catch { /* ignore */ }
    }
    if (items.length) {
      items.sort((a, b) => (a.name === 'MEMORY.md' ? -1 : b.name === 'MEMORY.md' ? 1 : a.name.localeCompare(b.name)));
      // real cwd from a transcript in the same project dir (cached; decodeProject is the last resort)
      out.push({ project: d.name, projectPath: (await projectCwd(d.name)) || decodeProject(d.name), files: items });
    }
  }
  // MEM-SORT — the groups came out in readdir order, i.e. sorted by the ENCODED directory name
  // („C--Users-x-foo"), which is not the string the list prints (`projectPath`) and not the one the project
  // picker in „Neue Memory" lists either. With a handful of projects that reads as no order at all. The
  // files inside a group have been sorted since this function was written; this is the same promise one
  // level up. localeCompare, because these are paths a human reads, not identifiers.
  out.sort((a, b) => String(a.projectPath || a.project).localeCompare(String(b.projectPath || b.project), undefined, { sensitivity: 'base' }));
  return out;
}
async function pluginVersion(key) {
  const at = key.lastIndexOf('@');
  if (at < 0) return null;
  const plugin = key.slice(0, at), marketplace = key.slice(at + 1);
  // Where the CLI records installs TODAY (~/.claude/plugins/installed_plugins.json). The two
  // marketplace lookups below describe the older layout and don't exist for a currently installed
  // plugin, which is why the version chip in the MCP view stayed empty for every plugin.
  // A recorded "version" can be a content hash (3ea32df27be7), and "v3ea32df27be7" is not a version
  // — so only semver-shaped values are reported and a hash keeps the chip hidden.
  try {
    const j = JSON.parse(await fsp.readFile(path.join(path.dirname(PLUGINS_DIR), 'installed_plugins.json'), 'utf8'));
    const list = (j.plugins || {})[key];
    const v = Array.isArray(list) && list.length ? list[list.length - 1].version : null;
    if (v && /^v?\d+\.\d+/.test(String(v))) return String(v).replace(/^v/, '');
  } catch { /* fall through to the marketplace layout */ }
  try { const j = JSON.parse(await fsp.readFile(path.join(PLUGINS_DIR, marketplace, 'plugins', plugin, '.claude-plugin', 'plugin.json'), 'utf8')); if (j.version) return j.version; } catch { /* */ }
  try { const m = JSON.parse(await fsp.readFile(path.join(PLUGINS_DIR, marketplace, '.claude-plugin', 'marketplace.json'), 'utf8')); const e = (m.plugins || []).find((x) => x.name === plugin); if (e && e.version) return e.version; } catch { /* */ }
  return null;
}
// generic config-file collections under ~/.claude/<kind>/
const CFG_KINDS = { agents: 'agents', 'output-styles': 'output-styles', commands: 'commands' };
function cfgDir(kind) { return CFG_KINDS[kind] ? path.join(CLAUDE_DIR, CFG_KINDS[kind]) : null; }
function cfgFilePath(kind, name) {
  const dir = cfgDir(kind);
  if (!dir || !name || name.includes('..') || name.includes('/') || name.includes('\\')) return null;
  const file = path.join(dir, /\.md$/.test(name) ? name : name + '.md');
  // trailing separator: without it a SIBLING dir satisfies the prefix test (…/agents-old/x.md passes
  // startsWith('…/agents')) — same hardening as the static-file and BACKUP_DIR guards
  if (!file.startsWith(dir + path.sep)) return null;
  return file;
}
async function listCfgFiles(kind) {
  const dir = cfgDir(kind);
  if (!dir) return null;
  let files = [];
  try { files = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    try { const full = path.join(dir, f); const st = await fsp.stat(full); const fm = parseFrontmatter(await fsp.readFile(full, 'utf8')); out.push({ name: f.replace(/\.md$/, ''), description: fm.description || '', mtime: st.mtimeMs, size: st.size }); } catch { /* */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
// ---------------------------------------------------------------------------
// Plans (A7) — ~/.claude/plans/*.md, written by plan mode. Same shape as listCfgFiles, but plans have
// no frontmatter: the first heading is the title, so the list is readable without opening each file.
// Read-only plus delete; the panel offers "als Prompt übernehmen" on the client side.
// ---------------------------------------------------------------------------
// P-2: a subagent's plan is `<parent slug>-agent-<hex>.md` (the CLI assigns one per planning agent). It is not a
// plan of the user's — listed, it would show next to its parent as a second, half-finished copy, and the cockpit's
// slug → plan link would hand a session a file the session never wrote. Readable by name (planPath), never listed.
const AGENT_PLAN_RE = /-agent-[0-9a-f]+\.md$/i;
async function listPlans() {
  let files = [];
  try { files = await fsp.readdir(PLANS_DIR); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.md') || AGENT_PLAN_RE.test(f)) continue;
    try {
      const full = path.join(PLANS_DIR, f);
      const st = await fsp.stat(full);
      // read a head slice only: a plan can be long and the list needs a title plus a teaser
      const fh = await fsp.open(full, 'r');
      const buf = Buffer.alloc(Math.min(st.size, 4096));
      await fh.read(buf, 0, buf.length, 0);
      await fh.close();
      const head = buf.toString('utf8');
      const title = (head.match(/^#\s+(.+)$/m) || [])[1] || f.replace(/\.md$/, '');
      const teaser = head.split('\n').filter((l) => l.trim() && !/^#/.test(l) && !/^-{3,}/.test(l))[0] || '';
      out.push({ name: f, title: title.trim().slice(0, 140), teaser: teaser.trim().slice(0, 200), mtime: st.mtimeMs, size: st.size });
    } catch { /* unreadable file — skip, don't fail the list */ }
  }
  out.sort((a, b) => b.mtime - a.mtime); // newest first: the plan you just wrote is the one you want
  return out;
}
function planPath(name) {
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\') || !name.endsWith('.md')) return null;
  const p = path.join(PLANS_DIR, name);
  if (!p.startsWith(PLANS_DIR + path.sep)) return null; // see cfgFilePath for why the separator matters
  return p;
}
// `project` is ONE directory entry under PROJECTS_DIR (scanSessions reports `d.name`), so it is held to
// the same separator rule as `name`. Both halves of the old check were weaker than they looked: the
// traversal guard rested on the '..' enumeration alone for `project`, and the containment check composed
// its bound out of the very value it was meant to bound — so every `project` satisfied it by construction.
// The bound is now PROJECTS_DIR, which no argument can move.
function memoryPath(project, name) {
  if (!project || !name
      || project.includes('..') || project.includes('/') || project.includes('\\')
      || name.includes('..') || name.includes('/') || name.includes('\\') || !name.endsWith('.md')) return null;
  const p = path.join(PROJECTS_DIR, project, 'memory', name);
  if (!p.startsWith(PROJECTS_DIR + path.sep)) return null; // see cfgFilePath for why the separator matters
  return p;
}

// ---------------------------------------------------------------------------
// Skills & commands
// ---------------------------------------------------------------------------
// (parseFrontmatter moved to lib/core.js)
async function scanCommands() {
  const dir = path.join(CLAUDE_DIR, 'commands');
  let files = [];
  try { files = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    try { const txt = await fsp.readFile(path.join(dir, f), 'utf8'); out.push({ name: f.replace(/\.md$/, ''), description: parseFrontmatter(txt).description || '', source: 'command' }); } catch { /* */ }
  }
  return out;
}
// --- UI Skills: a normal command whose body carries a ```ui-skill fenced JSON block ---
// the block turns a plain skill into a GUI-driven "UI Skill"; the CLI ignores it as prose.
const UI_BLOCK_RE = /```ui-skill\s*\n([\s\S]*?)\n```/;
function extractUiManifest(md) {
  const m = String(md || '').match(UI_BLOCK_RE);
  if (!m) return null;
  try { const o = JSON.parse(m[1]); return (o && typeof o === 'object') ? o : null; } catch { return null; }
}
// insert or replace the ui-skill block, preserving the surrounding prose
// replaceUiBlock removed (unused; ui-skill blocks are written client-side via serializeSkillMd)
async function scanUiSkills() {
  const dir = path.join(CLAUDE_DIR, 'commands');
  let files = [];
  try { files = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    try {
      const content = await fsp.readFile(path.join(dir, f), 'utf8');
      const manifest = extractUiManifest(content);
      if (!manifest) continue;
      const name = f.replace(/\.md$/, '');
      out.push({ name, description: manifest.description || parseFrontmatter(content).description || '', manifest });
    } catch { /* */ }
  }
  out.sort((a, b) => (a.manifest.title || a.name).localeCompare(b.manifest.title || b.name));
  return out;
}

// (scanBundledSkills removed — dead since the skills view reads the registry via getSessionInfo;
//  it also picked the "latest" version by a lexicographic sort, which misorders 2.1.30 vs 2.1.241)
// locate a bundled skill's SKILL.md by name (latest version)
async function bundledSkillPath(name) {
  if (!name || /[\\/.]/.test(name)) return null;
  const base = path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Temp', 'claude', 'bundled-skills');
  let versions = []; try { versions = await fsp.readdir(base); } catch { return null; }
  versions.sort();
  for (let i = versions.length - 1; i >= 0; i--) {
    const vdir = path.join(base, versions[i]);
    let hashes = []; try { hashes = await fsp.readdir(vdir); } catch { continue; }
    for (const h of hashes) { const f = path.join(vdir, h, name, 'SKILL.md'); if (fs.existsSync(f)) return f; }
  }
  return null;
}
// SKILL.md of a PLUGIN skill ("<plugin>:<skill>", as /api/skills reports it). Installed plugins are
// unpacked under ~/.claude/plugins/cache/<marketplace>/<plugin>/<hash>/skills/<skill>/SKILL.md, and
// installed_plugins.json says which hash is current. Both name parts are validated here as well —
// this resolves a user-supplied string into a path.
async function pluginSkillPath(qualified) {
  const [plugin, skill] = String(qualified || '').split(':');
  // `[\w.-]+` alone still admits "." and ".." — and `path.join(cache, mp, '..')` climbs out of the
  // plugin dir. Every part must therefore contain something other than dots.
  const okPart = (s) => /^[\w.-]+$/.test(s) && !/^\.+$/.test(s);
  if (!plugin || !skill || !okPart(plugin) || !okPart(skill)) return null;
  const pluginsRoot = path.dirname(PLUGINS_DIR);
  let installed = {};
  try { installed = JSON.parse(await fsp.readFile(path.join(pluginsRoot, 'installed_plugins.json'), 'utf8')).plugins || {}; } catch { /* */ }
  // installPath is authoritative (it carries marketplace + version hash)
  for (const key of Object.keys(installed)) {
    if (key !== plugin && !key.startsWith(plugin + '@')) continue;
    for (const inst of (installed[key] || [])) {
      const f = inst.installPath && path.join(inst.installPath, 'skills', skill, 'SKILL.md');
      if (f && fs.existsSync(f)) return f;
    }
  }
  // …falling back to a scan of the cache tree, for a plugin the manifest doesn't mention
  const cache = path.join(pluginsRoot, 'cache');
  let marketplaces = []; try { marketplaces = await fsp.readdir(cache); } catch { return null; }
  for (const mp of marketplaces) {
    let hashes = []; try { hashes = await fsp.readdir(path.join(cache, mp, plugin)); } catch { continue; }
    hashes.sort();
    for (let i = hashes.length - 1; i >= 0; i--) {
      const f = path.join(cache, mp, plugin, hashes[i], 'skills', skill, 'SKILL.md');
      if (fs.existsSync(f)) return f;
    }
  }
  return null;
}
// Grab the CLI's command registry (name + description) cheaply: spawn a bidi
// stream-json process, send an `initialize` control request, read the response.
// No model call, no cost.
//
// The same answer also carries `models` — [{ value, resolvedModel, displayName, supportsEffort,
// supportedEffortLevels }] — which is the CLI's own statement about which model supports which effort
// level. That is what decides whether ultracode can be offered for a model (lib/models.js
// ultracodeModelSupport), so it is kept here instead of being thrown away: one probe, two answers.
// Absent on the `init`-frame fallback path below, where only slash commands exist.
function getSessionInfo() {
  return new Promise((resolve) => {
    // an error result is not cached (getSessionInfoCached), so the first load after the update probes again
    if (isCliUpdating()) return resolve({ error: 'cli-updating', code: 'cli-updating' });
    let done = false, proc, to = null;
    // clearTimeout + killTree: the 20s guard used to stay armed after a fast answer (holding this
    // closure and the child handle), and proc.kill() left claude.exe's node grandchild running.
    const finish = (d) => { if (done) return; done = true; if (to) { clearTimeout(to); to = null; } try { rl.close(); } catch {} try { proc.stdin.end(); } catch {} killTree(proc); resolve(d); };
    // Same CLAUDE_UI_FAKE_BIN seam as lib/chat.js startChat — NOT lib/cli.js claudeSpawn, because this
    // is a bidirectional stream-json session, not a one-shot whose stdout is read at the end. Without
    // the seam this spawn resolved the machine's real binary under `node --test` and failed instantly
    // under the sandbox, so GET /api/skills had only ever been seen on its error branch.
    const FAKE_BIN = process.env.CLAUDE_UI_FAKE_BIN;
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
    try { proc = FAKE_BIN ? spawn(process.execPath, [FAKE_BIN].concat(args), { cwd: HOME, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(CLAUDE_EXE, args, { cwd: HOME, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ error: errorText(e) }); }
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let o; try { o = JSON.parse(line); } catch { return; }
      const payload = o && o.type === 'control_response' && o.response && o.response.response;
      const cmds = payload && payload.commands;
      if (Array.isArray(cmds)) finish({ commands: cmds, models: Array.isArray(payload.models) ? payload.models : [] });
      else if (o.type === 'system' && o.subtype === 'init') finish({ commands: (o.slash_commands || []).map((n) => ({ name: n, description: '' })), models: [] });
    });
    proc.on('error', (e) => finish({ error: errorText(e) }));
    try { proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'initialize' } }) + '\n'); } catch { /* */ }
    to = setTimeout(() => finish({ error: 'timeout' }), 20000);
    if (done) { clearTimeout(to); to = null; } // finish() may have raced the assignment
  });
}
// /api/skills spawns claude.exe for the command registry on every load. It rarely changes within a
// server run — cache successful results for 60s (errors aren't cached, so a failed probe retries).
let _skillRegistryCache = null; // { at, info }
async function getSessionInfoCached() {
  if (_skillRegistryCache && Date.now() - _skillRegistryCache.at < 60000) return _skillRegistryCache.info;
  const info = await getSessionInfo();
  if (info && !info.error && Array.isArray(info.commands)) _skillRegistryCache = { at: Date.now(), info };
  return info;
}

module.exports = {
  listMemory, memoryPath, listPlans, planPath, cfgDir, cfgFilePath, listCfgFiles, CFG_KINDS, pluginVersion,
  scanCommands, scanUiSkills, bundledSkillPath, pluginSkillPath, extractUiManifest, UI_BLOCK_RE,
  getSessionInfo, getSessionInfoCached,
};
