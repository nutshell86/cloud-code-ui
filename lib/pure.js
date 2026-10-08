'use strict';
/*
 * Pure, side-effect-free helpers shared by the server and the test suite.
 * Kept in their own module so `node --test` can import them without booting
 * the HTTP server / scheduler. No I/O — just data in, data out. The ONE require is
 * public/js/plan-progress.js, itself dependency-free and side-effect-free (see
 * PLAN_PROGRESS_SYSTEM_HINT below for why that text may not live here).
 */

// (UI-skill prompt composition used to live here, and the panel kept its own copy of the same five
// functions in views-uiskills.js. The two drifted on the boolean label, so one skill sent two different
// prompts depending on who started it. One implementation now: public/js/ui-skill-prompt.js — see its
// header for the rule. Deliberately NOT re-exported from here: a re-export is one more name for the one
// implementation, and the next reader takes it for a second one.)

// ---- MEM-LINK: which other memory files does this one point at? -----------------------------------
//
// The memory view has three readers of this answer — the 🔗 count per file, „Verlinkt von" (backlinks),
// and the graph — and all three asked only for `[[wiki-links]]`. The index file this panel exists to show,
// ~/.claude/projects/<p>/memory/MEMORY.md, is written by the CLI in ordinary Markdown:
//     - [sap-adt MCP limits](sap-adt-mcp-limits.md) — what the MCP server can and cannot do
// So for the one file that links to every other one, the count said 0, the graph had no edges, and no file
// had a backlink. The feature was not broken in a corner; it was off for the real data.
//
// Both forms are returned as the TARGET's bare name (no `.md`, no path), because that is what every reader
// compares against: `f.name.replace(/\.md$/,'').toLowerCase()`.
// What is deliberately NOT a link:
//  · anything with a scheme or protocol-relative (`https:`, `mailto:`, `//host/x.md`) — not a memory file;
//  · a target outside this memory directory (`../x.md`, `sub/x.md`, `C:\…`) — the readers resolve names
//    WITHIN one project's memory dir, so admitting a path would invent a node that cannot be opened;
//  · a `#fragment` or an empty target.
// An EMPTY link text (`[](x.md)`) is still a link: the audit's own example, and the target is what counts.
const MD_LINK_RE = /\[[^\]\n]*\]\(([^()\s]+)\)/g;
const WIKI_LINK_RE = /\[\[([^\]\n]+)\]\]/g;
function memoryLinkTargets(content) {
  const src = String(content == null ? '' : content);
  const out = [];
  const push = (raw) => {
    let v = String(raw == null ? '' : raw).trim();
    if (!v || v.startsWith('#')) return;
    v = v.split('#')[0].trim();                       // drop a fragment, keep the file
    if (!v) return;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) return;  // https:, mailto:, file:, C: …
    if (v.startsWith('//')) return;                   // protocol-relative
    if (v.includes('/') || v.includes('\\')) return;   // another directory — not this memory dir
    out.push(v.replace(/\.md$/i, ''));
  };
  for (const m of src.matchAll(WIKI_LINK_RE)) push(m[1]);
  for (const m of src.matchAll(MD_LINK_RE)) push(m[1]);
  // de-duplicated case-INSENSITIVELY (a file list is case-insensitive on this filesystem), first spelling
  // wins so the list still reads like the document it came from
  const seen = new Set(), uniq = [];
  out.forEach((v) => { const k = v.toLowerCase(); if (!seen.has(k)) { seen.add(k); uniq.push(v); } });
  return uniq;
}

// ---- scheduler timing ----
function computeNextRun(timing, from) {
  from = from || Date.now();
  if (!timing || !timing.type) return from + 3600000;
  if (timing.type === 'interval') { const min = Math.max(1, Number(timing.minutes) || 60); return from + min * 60000; }
  if (timing.type === 'daily') {
    const parts = String(timing.time || '09:00').split(':'); const hh = parseInt(parts[0], 10) || 0, mm = parseInt(parts[1], 10) || 0;
    const days = Array.isArray(timing.days) && timing.days.length ? timing.days : [0, 1, 2, 3, 4, 5, 6];
    const d = new Date(from);
    for (let i = 0; i <= 8; i++) { const cand = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, hh, mm, 0, 0); if (cand.getTime() > from && days.includes(cand.getDay())) return cand.getTime(); }
    return from + 86400000;
  }
  return from + 3600000;
}

// SCHED-1 — what the schedule ROUTE is allowed to store. computeNextRun above is deliberately
// forgiving (it has to answer for whatever is already on disk), and that forgiveness was the whole
// defect: `{type:'daily', days:[]}` — what the day picker produces once you click the last weekday
// off — hits the `days.length ? days : [0..6]` fallback on line 20 and runs SEVEN days a week, which
// is the opposite of what the user just clicked. A rhythm nobody chose must be refused at the moment
// of typing, not re-interpreted at 03:00.
// Returns { timing } (normalised: de-duplicated, sorted, no stray values) or { error }.
// An ABSENT `days` stays "every day" — that is the API default for `{type:'daily', time}` and the
// only reading a caller who never sent the field can have meant. `days: []` is a CHOICE, and an
// empty one, so it is an error rather than a silent seven.
function normalizeScheduleTiming(timing) {
  const ty = timing && timing.type;
  if (ty === 'interval') {
    const min = Number(timing.minutes);
    if (!Number.isFinite(min) || min < 1) return { error: 'interval needs minutes >= 1' };
    // one year: a typo that turns 60 into 600000 is a schedule that never runs again, which looks
    // exactly like a broken one
    return { timing: { type: 'interval', minutes: Math.min(Math.round(min), 525600) } };
  }
  if (ty === 'daily') {
    const time = String(timing.time == null ? '09:00' : timing.time);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { error: 'daily needs time as HH:MM' };
    if (timing.days == null) return { timing: { type: 'daily', time } };
    if (!Array.isArray(timing.days)) return { error: 'daily days must be an array' };
    const days = [...new Set(timing.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
    // Both empty cases land here, and on purpose: `[]` is "every weekday clicked off", `[9]` is a
    // value computeNextRun can never match — it would walk its 9-day window, find nothing and return
    // `from + 86400000` forever, i.e. a schedule that drifts a day per run with nobody told.
    if (!days.length) return { error: 'daily needs at least one weekday' };
    return { timing: { type: 'daily', time, days } };
  }
  return { error: 'timing type must be interval or daily' };
}

// SCHED-1, second half — the required fields of the skill the schedule runs. The run form checks this
// before it starts a WATCHED run (views-uiskills.js missingRequired, which marks the fields red); the
// schedule dialog never did, so an unattended run went out every night with an empty {{thema}} in its
// prompt. Returns the ids of the inputs that are required, VISIBLE and empty.
// `visibleIf` has to be part of it: a required field that its own condition hides is not missing, and a
// server rule that forgot that would refuse schedules the run form happily starts.
// This mirrors views-uiskills.js `missingRequired` + `isVisible`; test/views-data-guards.test.js lifts
// those two out of the shipped browser file and pins both answers against the same table, so the pair
// cannot drift the way the prompt composer once did.
function missingRequiredInputs(manifest, values) {
  const vals = (values && typeof values === 'object') ? values : {};
  const truthy = (v) => (Array.isArray(v) ? v.length > 0 : !!v);
  const visible = (input) => {
    const c = input.visibleIf;
    if (!c) return true;
    if (typeof c === 'string') return truthy(vals[c]);
    if (c && typeof c === 'object' && c.field) return vals[c.field] === c.equals;
    return true;
  };
  return ((manifest && manifest.inputs) || [])
    .filter((i) => i && i.required && visible(i) && (vals[i.id] == null || vals[i.id] === '' || (Array.isArray(vals[i.id]) && !vals[i.id].length)))
    .map((i) => String(i.id));
}

// ---- appended system prompt: style + guardrails + corrections + protocol (D1/D2/D4) ----
//
// WHY this exists at all: everything the user tells me about the BOUNDARIES of the work ("T01 is the
// test system", "nothing gets pushed without my ok") lived only in the conversation. After a
// compaction, in a new tab, or in tomorrow's session it was gone — so it had to be repeated, or it was
// silently missing. Guardrails are that knowledge, held by the user, visible in the UI, and re-sent on
// every launch.
//
// WHY server-side: there would otherwise be two truths about the appended prompt (one composed in the
// browser, one in the server for headless runs). Both callers reach it through buildSpawnPolicy below —
// the chat start route AND lib/engine. (Going through the same startChat was NOT enough: the engine
// called startChat without an appendSystem, so for a long time unattended runs carried no guardrails at
// all while this comment claimed they did.)
//
// A note on the mechanism — this paragraph used to say the opposite, and it was wrong. It claimed that
// passing --append-system-prompt turns the CLI's system-prompt snapshot OFF, so an edited guardrail
// would reach a resumed session. The CLI's own --help (2.1.288, `--system-prompt-snapshot <on|off>`)
// says: „on (the default): the prompt is rendered on the conversation's first request — a
// --system-prompt or --append-system-prompt included — sent, and recorded; every later request and
// resume sends the record as-is, even when a later launch passes different text, until the
// conversation is compacted." MEASURED 2026-10-03 against 2.1.288 (Haiku, three `-p --output-format
// json` launches of ONE session, each with a different append): T1 `--session-id` + ALPHA → cache_read 0,
// cache_creation 33164; T2 `--resume` + BETA → cache_read 33164, i.e. the byte-identical prefix of T1 =
// ALPHA was sent although BETA was passed; T3 `--resume` + GAMMA + `--system-prompt-snapshot off` →
// cache_read 17247, cache_creation 16517 — the cached prefix breaks after 17247 tokens, so the prompt was
// rendered anew. The transcript has exactly one `prompt_snapshot` attachment, with ALPHA.
// So without the flag a changed append reaches a CONTINUED session only after its next compaction —
// guardrails, corrections, style, and „Leitplanken jetzt anwenden" (public/js/chat.js), which relaunches
// the same session for exactly this purpose. The panel therefore passes `--system-prompt-snapshot off`
// by default (promptSnapshotArg below, `promptSnapshot` in ui-prefs.json).
// Its price — only ONE point of it is measured, and the Settings card says exactly that: T3 above, a
// resume that changed the text AND set the flag at once, wrote 16517 tokens to the cache (T2 with the
// replay: 484). What `off` does is wider than „on resume": per --help it is „never record; the prompt is
// rendered fresh every request" — every request, inside one running process as well. NOT measured: a
// resume with `off` and UNCHANGED text, a second turn in the same process with `off`, and whether the
// prompt's dynamic parts (date, MCP instructions of a server that connects late) then move the prefix
// from turn to turn. So „the cache keeps hitting afterwards" is a plausible expectation, not a finding,
// and no text in the panel may state it as one.
const GUARDRAIL_CAPS = { section: 2000 };
// How much of the correction history actually reaches a session. The store keeps more (see
// lib/core.readCorrections); this is the ceiling on what gets injected, so the prompt cannot creep.
const CORRECTION_CAPS = { entries: 20, chars: 240, total: 3000 };

function clampText(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
// Which corrections are injected, newest first, under both the per-entry and the total cap. Returned
// alongside `dropped` so the UI can SAY that older entries are no longer being sent instead of
// letting them look active forever.
function selectCorrections(list) {
  const arr = (Array.isArray(list) ? list : []).filter((c) => c && (typeof c === 'string' || c.text));
  const newest = arr.slice(-CORRECTION_CAPS.entries).reverse(); // newest first
  const used = [];
  let total = 0;
  for (const c of newest) {
    const text = clampText(typeof c === 'string' ? c : c.text, CORRECTION_CAPS.chars);
    if (!text) continue;
    if (total + text.length > CORRECTION_CAPS.total) break;
    total += text.length;
    used.push(text);
  }
  return { used, dropped: Math.max(0, arr.length - used.length) };
}

// The protocol for D2 travels WITH the prompt, so any session knows the channel exists — documenting
// it only in the README would mean it works exactly as often as someone happens to read the README.
const OPEN_POINTS_PROTOCOL = [
  'Offene Punkte statt Blockieren: Wenn du bei einer Unsicherheit weiterarbeiten kannst, halte an und frage NICHT.',
  'Schreibe die offenen Punkte stattdessen am Ende der Antwort in einen Codeblock mit der Sprache `offene-punkte`,',
  'als JSON-Array: [{"frage": "…", "warum": "…"}].',
  // `optionen` is what turns a point into something answerable with one click instead of a typed
  // sentence — worth spelling out, because a model that does not know the field simply never uses it.
  'Wenn die Antwort aus wenigen bekannten Möglichkeiten besteht, gib sie mit an:',
  '"optionen": ["Werk 1", "Werk 2"] oder [{"label": "beide", "desc": "kostet einen zweiten Durchlauf"}], höchstens 6.',
  'Das Panel zeigt jeden Punkt als Karte unter der Antwort UND als Zeile in der Seitenleiste; die Optionen',
  'werden dort zu Antwort-Knöpfen. Beantwortet wird, wenn es passt. Nur für echte Unsicherheiten, die die Arbeit',
  'nicht sofort stoppen — was die Arbeit sofort stoppt, fragst du direkt.',
].join(' ');

// PF-1 — the plan-progress hint (two sentences). Its text is NOT kept here, and that is the reason for the one
// require of this module: it names the keys of the ```plan-status block (schritte / aktuell / erledigt /
// fertig), and public/js/plan-progress.js is the file that READS those keys back — next to the full protocol
// the approval message carries. A copy here would be a second statement of the contract that can drift from
// the parser (a renamed key here, the old one there), which is exactly how the ui-skill prompt once forked.
// The approval message is the main carrier, this hint only the backup. With the prompt snapshot at the CLI's
// own default (`promptSnapshot: 'on'`) a resume replays the FIRST launch's append (measured 2026-10-03, CLI
// 2.1.288: the resume's cache_read equalled the whole prefix of the first launch), so the hint reaches only
// new sessions and a continued one right after its compaction — the moment the approval message is most
// likely gone. At the panel's default `off` (promptSnapshotArg below) every launch renders it fresh, a
// resume included. The approval message carries the protocol under both settings.
const { PLAN_PROGRESS_SYSTEM_HINT } = require('../public/js/plan-progress');

function composeAppendSystem(o) {
  o = o || {};
  const parts = [];
  const style = clampText(o.style, GUARDRAIL_CAPS.section);
  if (style) parts.push(style);
  const global = clampText(o.globalGuardrails, GUARDRAIL_CAPS.section);
  const tab = clampText(o.tabGuardrails, GUARDRAIL_CAPS.section);
  // J2 — a project's instructions sit BETWEEN the two: more specific than the panel's, less than the tab's.
  // Same cap as a guardrail section (projects-core caps them at 2000 on save, so the clamp never fires for a
  // stored project). The name is folded onto one line: it becomes a heading, and a line break in it would
  // start a heading of its own.
  const proj = clampText(o.projectGuardrails, GUARDRAIL_CAPS.section);
  // P2 — the project's knowledge: memory files by ABSOLUTE path (lib/projects.js memoryRefs — only files that exist at
  // this start), each with its frontmatter description on one line. The CLI reads its own memory folder by itself; a
  // project names the few files that matter for it, so the model reads them before it answers instead of guessing.
  // At most 10 (projects-core caps them on save, the slice repeats it for a hand-made caller).
  const mem = (Array.isArray(o.projectMemory) ? o.projectMemory : [])
    .filter((m) => m && typeof m.path === 'string' && m.path && m.path.indexOf('\0') < 0).slice(0, 10)
    .map((m) => {
      const pth = String(m.path).replace(/[\r\n]+/g, ' ');
      const desc = clampText(String(m.description == null ? '' : m.description).replace(/\s+/g, ' '), 160);
      return '- ' + pth + (desc ? ' — ' + desc : '');
    });
  const projSec = !!(proj || mem.length);
  if (global || projSec || tab) {
    const lines = ['# Leitplanken für diese Sitzung', 'Diese Randbedingungen gelten für alles in dieser Sitzung. Halte dich an sie, auch wenn eine spätere Nachricht sie nicht wiederholt.'];
    if (global) lines.push('', global);
    if (projSec) {
      const name = clampText(String(o.projectName == null ? '' : o.projectName).replace(/\s+/g, ' '), 80);
      lines.push('', name ? '## Projekt „' + name + '“' : '## Projekt');
      if (proj) lines.push(proj);
      if (mem.length) lines.push(...(proj ? [''] : []), '### Projektwissen — vor der ersten Antwort lesen', ...mem);
    }
    // the tab's own guardrails come last: on a conflict the more specific instruction should be the
    // one that was read most recently. Under a project section they get a heading of their own — otherwise
    // they would read as part of the project's. Without one the block stays exactly as it was
    // (test/appendsystem.test.js holds it byte for byte).
    if (tab) lines.push('', ...(projSec ? ['## Dieser Chat', tab] : [tab]));
    parts.push(lines.join('\n'));
  }
  const cor = selectCorrections(o.corrections);
  if (cor.used.length) {
    parts.push(['# Frühere Korrekturen', 'Der Nutzer hat diese Punkte in früheren Sitzungen korrigiert. Beachte sie, ohne sie zu kommentieren.', '', ...cor.used.map((c) => '- ' + c)].join('\n'));
  }
  if (o.openPointsProtocol) parts.push('# Offene Punkte\n' + OPEN_POINTS_PROTOCOL);
  if (o.planProgressProtocol) parts.push('# Plan-Fortschritt\n' + PLAN_PROGRESS_SYSTEM_HINT);
  return parts.join('\n\n');
}

// ---- subagent policy: model, ceilings, and whether they may spawn at all (#34) ----
//
// WHY: a turn can spawn agents that each run their own model and burn their own tokens, and the panel
// had no say in any of it. „Which model do my subagents use" and „don't spawn any here" were simply not
// answerable. Both are session-start decisions, so they belong next to composeAppendSystem: the same
// place where a TAB choice is layered over the GLOBAL default. A headless/scheduled run gets the global
// layer through buildSpawnPolicy, so an unattended radar inherits the global ceiling.
//
// The mechanism is environment variables the CLI reads (verified against the 2.1.276 binary, they are
// not in --help): CLAUDE_CODE_SUBAGENT_MODEL (an alias, or "inherit" = take the parent's model),
// CLAUDE_CODE_SUBAGENT_MODEL_FORCE (drops the `model` parameter from the Agent tool schema outright, so
// the main model cannot override per call), and the three ceilings. Switching subagents OFF is not an
// env var but a denied tool: the names go into the ONE --disallowed-tools list lib/chat.js builds
// (`Task` is what the session calls the tool on 2.1.278, `Agent` what older builds called it).
//
// Everything is validated HERE rather than passed through: a typo'd env value doesn't fail loudly, it
// makes a session behave inexplicably — the one failure mode that costs an afternoon.
const SUBAGENT_MODELS = ['inherit', 'opus', 'sonnet', 'haiku', 'fable']; // = AgentInput.model + inherit
const SUBAGENT_CAPS = { concurrent: [1, 20], perSession: [1, 200], depth: [1, 10] };

// Below the minimum is UNSET, not the minimum. The fields mean "empty = no limit", so a 0 (or a -1)
// has to land on the same "no limit" as an empty field — clamping it UP to 1 would turn "no ceiling"
// into the tightest ceiling there is, which is the opposite of what was typed. Above the maximum is
// clamped down, like the budget cap: that is a typo guard (a 500 meant as 50), not a meaning change.
function clampInt(v, range) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < range[0]) return null;
  return Math.min(n, range[1]);
}
// One layer of settings, cleaned. Unknown/empty fields come back absent, so `undefined` keeps meaning
// "not set here" and a tab can fall back to the global value field by field.
function normalizeSubagentCfg(c) {
  const src = (c && typeof c === 'object') ? c : {};
  const out = {};
  if (src.allow === false) out.allow = false; else if (src.allow === true) out.allow = true;
  const m = String(src.model == null ? '' : src.model).trim().toLowerCase();
  if (SUBAGENT_MODELS.includes(m)) out.model = m;
  // `force` only exists together with a concrete model — it means "do not let the main model override
  // THIS model". Kept on its own it would sit in ui-prefs.json as a ticked checkbox that changes
  // nothing (subagentSpawnConfig drops it), i.e. a setting that lies about being in effect.
  if (src.force && out.model && out.model !== 'inherit') out.force = true;
  const c1 = clampInt(src.maxConcurrent, SUBAGENT_CAPS.concurrent); if (c1 !== null) out.maxConcurrent = c1;
  const c2 = clampInt(src.maxPerSession, SUBAGENT_CAPS.perSession); if (c2 !== null) out.maxPerSession = c2;
  const c3 = clampInt(src.maxDepth, SUBAGENT_CAPS.depth); if (c3 !== null) out.maxDepth = c3;
  return out;
}
// global ⊕ tab → what the process gets. Field by field, so a tab that only sets `allow:false` still
// inherits the global model — merging whole objects would silently drop the rest of the global policy.
function mergeSubagentCfg(globalCfg, tabCfg) {
  return Object.assign({}, normalizeSubagentCfg(globalCfg), normalizeSubagentCfg(tabCfg));
}
// → { env, tools, cfg }. `cfg` is the merged policy so the caller can report what it applied, `tools`
// is the list of tool names to DENY — deliberately not a ready-made `--disallowed-tools` argument:
// lib/chat.js already builds that flag from `opts.disallowedTools` (the headless engine denies the
// shell tools through it), and a second occurrence of the same flag in one spawn is a coin toss
// between "the CLI merges both" and "the last one wins". The latter would silently drop the headless
// shell denial — in exactly the unattended run where it matters most. One list, one flag.
// A `model` of "inherit" is the CLI's own default; it is still passed explicitly, because it has to
// OVERRIDE an inherited CLAUDE_CODE_SUBAGENT_MODEL from the panel's own environment — dropping it
// would make "inherit" mean "whatever the machine's env says", which is not what the UI promises.
function subagentSpawnConfig(globalCfg, tabCfg) {
  const cfg = mergeSubagentCfg(globalCfg, tabCfg);
  const env = {};
  if (cfg.model) env.CLAUDE_CODE_SUBAGENT_MODEL = cfg.model;
  // FORCE without a model would pin subagents to whatever "inherit" resolves to AND take the override
  // away — a combination nobody asks for on purpose, so it only travels together with a real model.
  if (cfg.force && cfg.model && cfg.model !== 'inherit') env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '1';
  if (cfg.maxConcurrent) env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = String(cfg.maxConcurrent);
  if (cfg.maxPerSession) env.CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION = String(cfg.maxPerSession);
  if (cfg.maxDepth) env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = String(cfg.maxDepth);
  // Off means off: the ceilings are pointless next to it, and leaving a model set would suggest the
  // session still spawns something.
  // Both spellings: the session names the tool `Task` on 2.1.278 (measured), older builds say `Agent`.
  if (cfg.allow === false) {
    return { env: {}, tools: ['Agent', 'Task'], cfg: { allow: false } };
  }
  return { env, tools: [], cfg };
}

// ---- ultracode: standing dynamic-workflow orchestration for a session ----
//
// WHAT IT IS (quoted from the CLI's own settings schema, 2.1.285): „Enable ultracode for the session:
// standing dynamic-workflow orchestration at any effort level. Session-scoped — typically provided via
// --settings or the apply_flag_settings control request; interactive toggles never persist it. Requires
// workflows to be enabled and a model that supports ultracode."
//
// WHY THE PANEL NEEDS ITS OWN SWITCH: in the terminal you turn it on with `/effort ultracode` or by
// typing the word „ultracode" in a prompt. Neither reaches this panel — the keyword is REPL-side prompt
// preprocessing (`workflow_keyword_request`) that does not run on the headless stream-json input the
// panel feeds. The settings key is the only lever a host has.
//
// Layered like the subagent policy right above: a tab's explicit choice wins over the global default,
// and „not set" stays distinguishable from „off" so a tab can inherit. A headless/scheduled run does
// NOT inherit the global default — see buildSpawnPolicy for why.
function resolveUltracode(globalPref, tabPref) {
  if (tabPref === true || tabPref === false) return tabPref;
  return globalPref === true;
}
// The spawn form. `--settings` takes a file path OR a JSON string and adds ONE more settings layer, so
// it carries the session-scoped key without touching settings.json. Returns null when off — passing
// `{"ultracode":false}` would be an equally valid layer, but an absent flag keeps the argv of an
// ordinary chat byte-identical to what it was before this feature existed.
function ultracodeSpawnSettings(on) {
  return on === true ? JSON.stringify({ ultracode: true }) : null;
}
// What the panel should DISPLAY, from the `applied` block of a get_settings control response.
// MEASURED (2.1.285, --model haiku): apply_flag_settings{ultracode:true} answers `success` even when the
// model cannot do it, and afterwards `ultracodeRequested` is true while `ultracode` stays false. So
// „the control request succeeded" is NOT the same as „ultracode is on", and a UI that believes the
// former shows a lit switch that does nothing. FOUR states, never two:
//   'on'        — requested and in effect
//   'ineffective' — requested, not in effect (+ the reason, in the CLI's own words)
//   'off'       — not requested
//   'unknown'   — nothing was read (see below); the one state that must never be smoothed into 'off'
//
// `modelSupported` is the second input the reason needs: `ultracodeAvailable` is the AND of „workflows
// enabled" and „model supports xhigh", so on its own a false says which of the two is missing. The
// caller knows the model half independently (lib/models.js ultracodeModelSupport), and without it the
// panel could only report „not available", which is the one message that helps nobody.
//
// FOURTH state, and the reason this function may not default: 'unknown'. There was no `applied` block to
// read. That happens for real — controlRequest resolves `{ok:true, unconfirmed:true}` on its 5 s timeout,
// getChatSettings turns that into `applied: null`, and the route then called this with null. The old code
// coerced null to `{}`, and `{}` reads as „not requested, available" — so a TIMEOUT was published to the
// browser as a fully-formed `{state:'off', available:true}`, i.e. the panel told the user Ultracode was
// off because the session had failed to answer. An unread state is UNKNOWN, and the fields that would
// carry a claim are null rather than false, so no consumer can accidentally read „off" out of them.
function ultracodeState(applied, modelSupported) {
  // Detected by CONTENT, not by shape: `{}` and `[]` are objects and passed straight through, and the three
  // reads below then produced a fully-formed „off, and available" out of an answer that said nothing — the
  // same lie this function exists to remove, one layer in. An answer carrying none of the three keys has
  // told us nothing about Ultracode.
  const hasClaim = !!applied && typeof applied === 'object'
    && ('ultracode' in applied || 'ultracodeRequested' in applied || 'ultracodeAvailable' in applied);
  if (!hasClaim) {
    return { state: 'unknown', active: null, requested: null, available: null, reason: '', model: '' };
  }
  const a = applied;
  const active = a.ultracode === true;
  const requested = a.ultracodeRequested === true;
  const available = a.ultracodeAvailable !== false;
  let reason = '';
  if (!active && (requested || !available)) {
    if (modelSupported === false) reason = 'model';
    else if (available) reason = 'unavailable';                        // „nicht in Kraft", ohne dass die Sitzung sagt warum
    else reason = modelSupported === true ? 'workflows_off' : 'unavailable';
  }
  // A marked chip with no reason is the one thing the three states exist to prevent — found by a real
  // ultracode workflow reviewing this file (2026-10-01): requested=true + available=true + ultracode=false
  // is a shape the CLI should not produce, but if it ever does, the UI said „wirkt nicht" and fell silent
  // about why. So „ineffective" always carries a reason, even when that reason is „die Sitzung sagt es nicht".
  if (!active && requested && !reason) reason = 'unavailable';
  return {
    state: active ? 'on' : (requested ? 'ineffective' : 'off'),
    active, requested, available, reason,
    model: String(a.model || ''),
  };
}

// ---- prompt snapshot: does a resumed session get the CURRENT appended prompt? (PR-S) ----
// See the note at the top of this file for the measurement. One setting for chat AND headless, 'off' by
// default (Julian's call, 2026-10-03): the whole point of guardrails is that an edit takes effect, and
// with the snapshot on it silently does not, on exactly the sessions that are continued.
// Stored only when it deviates from the default — the file keeps saying nothing about a setting nobody
// touched, like ultracode. Anything that is not literally 'on' reads as 'off', so a hand-edited typo
// lands on the documented default instead of on a third state.
const PROMPT_SNAPSHOT_MODES = ['off', 'on'];
function normalizePromptSnapshot(v) { return v === 'on' ? 'on' : 'off'; }
// → the value for `--system-prompt-snapshot`, or null = pass no flag at all.
//   'on'  → null: it is the CLI's own default, and an absent flag keeps the argv of such a launch
//           byte-identical to what it was before this setting existed.
//   'off' → 'off' ONLY when the installed CLI is proven to know the flag (`flagSupported`, its --help —
//           lib/cli.js cliFlagSupported). An older CLI answers an unknown option with an error and the
//           chat would not start; without the proof the flag is left out and the CLI behaves as it does.
function promptSnapshotArg(pref, flagSupported) {
  if (normalizePromptSnapshot(pref) !== 'off') return null;
  return flagSupported === true ? 'off' : null;
}

// ---- spawn policy: what a session inherits from the panel's settings (BACKEND-M1) ----
//
// WHY one function: the chat start route composed guardrails, corrections, subagent policy, ultracode
// and the MCP wait inline, and lib/engine called startChat with none of it. Comments on both sides said
// the headless run „inherits" — it did not, so every scheduled run went out without the user's
// guardrails. Two callers, one function, and a test on the difference between them.
//
// → the policy part of the startChat options. The caller adds its own launch facts (cwd, model, …).
// `mode`:
//   'chat'     — global prefs ⊕ the tab's choices (`body`: appendSystem, guardrails, subagents, ultracode).
//                ⊕ the session's project (`o.project`: its instructions, J2 — see composeAppendSystem).
//   'headless' — global prefs only, and deliberately LESS of them:
//     · guardrails, corrections, the subagent policy and the MCP wait ARE inherited — they are the user's
//       boundaries and limits, and an unattended run needs them more than a watched one.
//     · the open-points protocol is NOT: it asks for a block the panel turns into cards, and a headless run
//       has no panel — the block would only end up in the stored transcript, or in the result.
//     · nor is the plan-progress hint (PF-1), for the same reason: its block is read by a tab's rail, and an
//       unattended run has no tab to show it in.
//     · nor is a project (J2): a schedule has none, and a run must not pick one up by accident.
//     · forwardSubagentText / includeHookEvents are NOT: lib/engine collects every assistant text frame
//       into the result, so forwarded subagent text would leak into it.
//     · ultracode is NOT taken from the global switch, ever: one workflow fans out into many agents that
//       --max-budget-usd does not cap. Only the run's own opt-in (`schedule.ultracode === true`) turns it on.
//   both — the prompt snapshot (`systemPromptSnapshot`), from the global setting alone; no tab overrides it.
//     A headless run never resumes today (lib/engine always launches a fresh --session-id), so the REPLAY
//     this setting exists for cannot happen there. That does not make the flag inert in a run: per --help,
//     `on` sends the first request's record on every later request and `off` renders the prompt fresh on
//     each one — so a multi-turn run with tool calls may send a different prompt from request 2 on (e.g.
//     MCP instructions of a server that connected after the first request, see mcpStartupWaitMs). What
//     that changes, and costs, inside one run is NOT measured. It is passed anyway, deliberately: ONE
//     setting decides every launch, a resuming run added later is not a second place somebody has to
//     remember, and „aus" in Settings must not mean one thing for a chat and another for a schedule.
// `o.snapshotFlag`: whether the installed CLI lists --system-prompt-snapshot (lib/cli.js
// cliFlagSupported). An I/O fact, so the CALLER asks and passes the answer; the decision stays here.
function buildSpawnPolicy(prefs, corrections, o) {
  const pr = (prefs && typeof prefs === 'object') ? prefs : {};
  o = o || {};
  const headless = o.mode === 'headless';
  const body = (!headless && o.body && typeof o.body === 'object') ? o.body : {};
  const schedule = (o.schedule && typeof o.schedule === 'object') ? o.schedule : {};
  // J2 — the session's project (server.js resolves it: the fresh start's choice, else the session's label). A
  // CHAT only: a schedule or a UI-skill run carries no project, and one handed in here anyway is not used.
  const project = (!headless && o.project && typeof o.project === 'object') ? o.project : null;
  return {
    appendSystem: composeAppendSystem({
      style: body.appendSystem,
      tabGuardrails: body.guardrails,
      globalGuardrails: pr.guardrails,
      projectGuardrails: project ? project.instructions : undefined,
      projectName: project ? project.name : undefined,
      // P2 — the caller (server.js) resolved the paths (lib/projects.js memoryRefs); a headless run has no project
      projectMemory: project && Array.isArray(o.projectMemory) ? o.projectMemory : undefined,
      corrections: pr.useCorrections === false ? [] : corrections,
      openPointsProtocol: !headless && pr.openPoints !== false,
      planProgressProtocol: !headless && pr.planProgress !== false,
    }),
    subagents: subagentSpawnConfig(pr.subagents, body.subagents),
    ultracode: headless ? schedule.ultracode === true : resolveUltracode(pr.ultracode, body.ultracode),
    // a property of this machine's MCP set, not of one conversation → global only, in both modes
    mcpStartupWaitMs: pr.mcpStartupWaitMs,
    includeHookEvents: !headless && pr.includeHookEvents === true,
    forwardSubagentText: !headless && pr.forwardSubagentText !== false,
    systemPromptSnapshot: promptSnapshotArg(pr.promptSnapshot, o.snapshotFlag === true),
  };
}

// ---- headless permission mode (SEC-H) ----
// An unattended run is only as safe as its permission responder (lib/engine: allow-list, shell denied),
// so it may only run in a mode in which the CLI ASKS that responder. `auto` lets a classifier approve
// instead, `bypassPermissions` approves everything, `dontAsk` decides without asking — each one takes
// the responder, and with it HEADLESS_ALLOWED_TOOLS, out of the loop. A manifest's mode serves the
// WATCHED run too (where bypassPermissions is a deliberate builder option), so it is not rejected at
// save time; the headless start caps it, which also covers every old manifest already on disk.
// `manual` is what the CLI (2.1.286 --help) lists in place of `default`; both mean „ask".
const HEADLESS_PERM_MODES = ['plan', 'acceptEdits', 'default', 'manual'];
// → { mode, capped }. `capped` is the requested mode when it was not allowed (for the log and the run
// record), else null. Read-only and dry runs are always `plan`, whatever the manifest says.
function headlessPermissionMode(requested, o) {
  o = o || {};
  if (o.dryRun || !o.allowWrites) return { mode: 'plan', capped: null };
  const want = requested ? String(requested) : 'acceptEdits';
  if (HEADLESS_PERM_MODES.includes(want)) return { mode: want, capped: null };
  // acceptEdits: what a write-run is FOR, and the cap bypassPermissions always had
  return { mode: 'acceptEdits', capped: want };
}

// ---- settings.json edits as operations (DATA-2) ----
// Every comfort action in the panel (add an allow rule, an env var, a hook, flip a plugin) used to PUT
// the WHOLE file, rebuilt from the browser's copy of it. That copy is as old as the last page load: a
// rule the CLI wrote in between, or a second action fired before the first one's reload, was silently
// overwritten. So the browser now sends WHAT it changes, and the server applies it to the file as it is
// on disk right now, under the file lock (server.js PATCH /api/config/settings).
//
//   { op: 'set',    path, value }  create/replace the key (intermediate objects are created)
//   { op: 'delete', path }         remove the key — a no-op if it is not there
//   { op: 'push',   path, value }  append to the array (created if missing) unless an equal element is
//                                  already in it: two tabs allowing the same tool keep ONE rule
//   { op: 'pull',   path, value }  remove every element equal to value; `strict: true` makes "nothing
//                                  matched" a conflict instead of a no-op (a hook that changed meanwhile)
//
// `path` is an array of key names, never a dotted string — env keys and plugin names may contain dots.
// Objects only: no array indices, because an index computed from the browser's copy is exactly the
// stale value this exists to avoid (an element is named by its VALUE, via pull). `delete` and `pull`
// also drop the containers they leave empty along their path (permissions.allow → permissions), which
// is what every client action did by hand before; `set` with an explicit {} or [] keeps it.
//
// Returns { ok: true, value, changed } with a NEW object (the input is not mutated), or
// { ok: false, status, code, error, index }: 400 `bad-op` for a malformed op; 409 when the op does not
// fit the file as it is now — `conflict` when a strict pull no longer finds its element (someone changed
// it meanwhile: reload and retry), `shape` when a key on the path holds something else than an object,
// or push/pull meets a non-array (the file is shaped differently: a retry fails the same way).
const SETTINGS_OPS = ['set', 'delete', 'push', 'pull'];
const SETTINGS_OPS_MAX = 100;
const SETTINGS_PATH_MAX = 10;
// keys that would address the prototype instead of an own property (see lib/core isValidSessionId)
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function jsonEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  if (isPlainObj(a)) {
    if (!isPlainObj(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}
function validateSettingsOps(ops) {
  const bad = (index, error) => ({ ok: false, status: 400, code: 'bad-op', error, index });
  if (!Array.isArray(ops) || !ops.length) return bad(-1, 'ops must be a non-empty array');
  if (ops.length > SETTINGS_OPS_MAX) return bad(-1, 'too many ops (max ' + SETTINGS_OPS_MAX + ')');
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    if (!isPlainObj(o) || !SETTINGS_OPS.includes(o.op)) return bad(i, 'op must be one of ' + SETTINGS_OPS.join('|'));
    const p = o.path;
    if (!Array.isArray(p) || !p.length || p.length > SETTINGS_PATH_MAX) return bad(i, 'path must be an array of 1–' + SETTINGS_PATH_MAX + ' key names');
    for (const k of p) {
      if (typeof k !== 'string' || !k || k.length > 200) return bad(i, 'path segments must be non-empty strings');
      if (UNSAFE_KEYS.has(k)) return bad(i, 'path segment not allowed: ' + k);
    }
    if (o.op !== 'delete' && o.value === undefined) return bad(i, o.op + ' needs a value');
  }
  return { ok: true };
}
function applySettingsOps(obj, ops) {
  const v = validateSettingsOps(ops);
  if (!v.ok) return v;
  if (!isPlainObj(obj)) return { ok: false, status: 409, code: 'not-object', error: 'settings file does not hold a JSON object', index: -1 };
  const root = JSON.parse(JSON.stringify(obj)); // work on a copy — a failing op must leave nothing half-applied
  const conflict = (index, error) => ({ ok: false, status: 409, code: 'conflict', error, index });
  const shape = (index, error) => ({ ok: false, status: 409, code: 'shape', error, index });
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  let changed = false;
  for (let i = 0; i < ops.length; i++) {
    const { op, path: p } = ops[i];
    const value = ops[i].value === undefined ? undefined : JSON.parse(JSON.stringify(ops[i].value));
    const create = op === 'set' || op === 'push'; // delete/pull never build the path they walk
    // walk to the parent, remembering it for the empty-container cleanup afterwards
    const chain = [root];
    let cur = root, missing = false;
    for (let d = 0; d < p.length - 1; d++) {
      const k = p[d];
      if (!own(cur, k)) {
        if (!create) { missing = true; break; }
        cur[k] = {};
      } else if (!isPlainObj(cur[k])) return shape(i, p.slice(0, d + 1).join(' › ') + ' is not an object');
      cur = cur[k]; chain.push(cur);
    }
    const last = p[p.length - 1];
    if (missing) {
      if (op === 'pull' && ops[i].strict) return conflict(i, p.join(' › ') + ' no longer contains that element');
      continue;
    }
    if (op === 'set') {
      if (!own(cur, last) || !jsonEqual(cur[last], value)) { cur[last] = value; changed = true; }
      continue;
    }
    if (op === 'delete') {
      if (!own(cur, last)) continue; // nothing removed → nothing to clean up either
      delete cur[last]; changed = true;
    } else if (op === 'push') {
      if (!own(cur, last)) cur[last] = [];
      else if (!Array.isArray(cur[last])) return shape(i, p.join(' › ') + ' is not a list');
      if (!cur[last].some((x) => jsonEqual(x, value))) { cur[last].push(value); changed = true; }
      continue;
    } else { // pull
      if (!own(cur, last)) { if (ops[i].strict) return conflict(i, p.join(' › ') + ' no longer contains that element'); continue; }
      if (!Array.isArray(cur[last])) return shape(i, p.join(' › ') + ' is not a list');
      const kept = cur[last].filter((x) => !jsonEqual(x, value));
      if (kept.length === cur[last].length) { if (ops[i].strict) return conflict(i, p.join(' › ') + ' no longer contains that element'); continue; }
      cur[last] = kept; changed = true;
      if (kept.length) continue;
      delete cur[last];
    }
    // drop the containers this op emptied, innermost first — never the root itself
    for (let d = chain.length - 1; d > 0; d--) {
      if (Object.keys(chain[d]).length) break;
      delete chain[d - 1][p[d - 1]];
    }
  }
  return { ok: true, value: root, changed };
}

// ---- cost per UI-skill / per schedule (A4) ----
// The panel knew cost per SESSION and per day, but not per radar — so "was kostet mein-tag im Monat"
// was unanswerable, which is exactly the number you need for schedule tuning and for justifying an
// EUC. Every run record already carries the `sessionId` it ran as, and lib/usage.js already aggregates
// cost per session, so this is a join, not a new measurement.
//
// runs:      [{ id, name, title, sessionId, startedAt, status, headless?, scheduleId?, dryRun? }]
// bySession: [{ id, cost, tokens }] (from scanUsage(..., limit: 0)) or a Map of the same
// Honest about gaps: a run whose session is no longer in the transcript corpus (deleted session,
// no-persistence run) contributes to `unpriced`, it is NOT silently counted as 0.
function joinRunCosts(runs, bySession) {
  const costOf = new Map();
  if (bySession instanceof Map) for (const [k, v] of bySession) costOf.set(k, v);
  else for (const s of (bySession || [])) if (s && s.id) costOf.set(s.id, s);
  const byRun = {}, skills = new Map(), scheds = new Map();
  let unpriced = 0, total = 0;
  const bump = (map, key, seed) => { let e = map.get(key); if (!e) { e = seed; map.set(key, e); } return e; };
  for (const r of (runs || [])) {
    if (!r) continue;
    const u = r.sessionId ? costOf.get(r.sessionId) : null;
    const cost = u ? (Number(u.cost) || 0) : 0;
    const tokens = u ? (Number(u.tokens) || 0) : 0;
    if (!u) unpriced++;
    total += cost;
    if (r.id) byRun[r.id] = { cost, tokens, priced: !!u };
    if (r.name) {
      const e = bump(skills, r.name, { name: r.name, title: r.title || r.name, runs: 0, priced: 0, cost: 0, tokens: 0, lastRun: 0 });
      e.runs++; e.cost += cost; e.tokens += tokens; if (u) e.priced++;
      if ((r.startedAt || 0) > e.lastRun) { e.lastRun = r.startedAt || 0; e.title = r.title || e.title; }
    }
    // Per SCHEDULE: newer records carry `scheduleId`. Older ones don't, so an unattended run falls back
    // to "headless run of this skill" — the same bucket the scheduler produces, just not per schedule.
    const skey = r.scheduleId || (r.headless ? 'skill:' + r.name : null);
    if (skey) {
      const e = bump(scheds, skey, { key: skey, scheduleId: r.scheduleId || null, name: r.name || '', runs: 0, cost: 0, lastRun: 0, exact: !!r.scheduleId });
      e.runs++; e.cost += cost; if ((r.startedAt || 0) > e.lastRun) e.lastRun = r.startedAt || 0;
      if (!r.scheduleId) e.exact = false;
    }
  }
  const fin = (e) => Object.assign(e, { avgCost: e.runs ? e.cost / e.runs : 0 });
  return {
    total,
    unpriced, // runs we could not price — shown as a footnote, never folded into `total` as 0
    byRun,
    bySkill: [...skills.values()].map(fin).sort((a, b) => b.cost - a.cost),
    bySchedule: [...scheds.values()].map(fin).sort((a, b) => b.cost - a.cost),
  };
}
// Cost of the last N days for one skill — the "12 $/Monat" read-out, derived from the same join so
// there is one definition of a skill's cost.
function runCostWindow(runs, bySession, name, sinceMs) {
  const sel = (runs || []).filter((r) => r && r.name === name && (r.startedAt || 0) >= sinceMs);
  const j = joinRunCosts(sel, bySession);
  return { runs: sel.length, cost: j.total, unpriced: j.unpriced };
}

// ---- version compare ----
// Parse `git rev-list --left-right --count <remote>...<HEAD>` → how far the local HEAD is behind /
// ahead of the remote tip. Left side = commits only on the remote (= behind), right side = commits
// only here (= ahead). Used to answer the version check EXACTLY and locally whenever the remote tip
// is already known to the local repo — no API call, works off-VPN, and never has to guess.
// Returns null for unparseable output so callers can fall back instead of reporting a made-up count.
function parseRevListLeftRight(stdout) {
  const m = String(stdout || '').trim().match(/^(\d+)\s+(\d+)$/);
  if (!m) return null;
  return { behind: Number(m[1]), ahead: Number(m[2]) };
}

// ---- git status --porcelain ----
// Format is `XY <path>` — but run() trims stdout, so a leading-space status (` M path`, i.e. modified
// and unstaged, by far the common case) loses that space on the FIRST line only. A fixed slice(3) then
// ate the first character of that path ("public/x" → "ublic/x"). Match the separator instead of
// assuming a column, so a 1- or 2-char status both parse.
function parsePorcelain(stdout) {
  return String(stdout || '').split('\n').filter(Boolean).map((l) => {
    const m = l.match(/^(..?)\s(.+)$/); // greedy: takes both status columns when they are there
    return m ? { status: m[1].trim(), path: m[2] } : { status: '', path: l };
  });
}

// ---- git status --porcelain --branch ----
// ONE spawn where /api/version used two: the `##` header answers "which branch is HEAD on" (what a
// separate `rev-parse --abbrev-ref HEAD` was for) and everything after it is the dirty list the route
// now reports. The header has four shapes worth knowing:
//   `## main...origin/main [behind 1]`  branch with an upstream (the ahead/behind part is NOT read —
//                                      it comes from the local remote-tracking ref, which the detached
//                                      server can never fetch, so it would be stale by design)
//   `## main`                          branch without an upstream
//   `## HEAD (no branch)`              detached HEAD — `HEAD`, same answer rev-parse gave
//   `## No commits yet on main`        fresh repo, nothing committed
// Returns { branch, files } with branch '' when git printed no header at all (failed call) — the same
// empty-string shape the route produced before when git errored.
function parsePorcelainBranch(stdout) {
  let branch = '';
  const rest = [];
  for (const l of String(stdout || '').split('\n')) {
    if (!l) continue;
    if (!branch && l.startsWith('## ')) {
      const h = l.slice(3).trim();
      const fresh = h.match(/^No commits yet on (.+)$/);
      branch = fresh ? fresh[1].trim() : h.split('...')[0].split(' ')[0];
      continue;
    }
    rest.push(l);
  }
  return { branch, files: parsePorcelain(rest.join('\n')).map((f) => f.path) };
}

// ---- P4 „Repos & PRs" (lib/project-repos.js) ----
// The `##` header of `git status --porcelain --branch` IN FULL — unlike parsePorcelainBranch above, the cockpit
// does show ahead/behind: they are counted against the LOCAL remote-tracking ref, i.e. the state of the last fetch,
// and the page says exactly that. Shapes:
//   `## main...origin/main [ahead 2, behind 1]`   `## main...origin/main [gone]` (upstream branch deleted)
//   `## main` (no upstream)   `## HEAD (no branch)` (detached)   `## No commits yet on main`
// Accepts the whole stdout or the header line alone. -> { branch, upstream, ahead, behind, gone, detached };
// ahead/behind are 0 without an upstream (there is nothing to count against), branch '' when there was no header.
function parseBranchHeader(stdout) {
  const out = { branch: '', upstream: '', ahead: 0, behind: 0, gone: false, detached: false };
  const line = String(stdout || '').split('\n').find((l) => l.startsWith('## '));
  if (!line) return out;
  let h = line.slice(3).trim();
  const fresh = h.match(/^No commits yet on (.+)$/);
  if (fresh) { out.branch = fresh[1].trim(); return out; }
  if (/^HEAD \(no branch\)/.test(h)) { out.branch = 'HEAD'; out.detached = true; return out; }
  const bracket = h.match(/\s\[([^\]]*)\]$/);
  if (bracket) {
    h = h.slice(0, bracket.index);
    for (const part of bracket[1].split(',').map((s) => s.trim())) {
      const m = part.match(/^(ahead|behind) (\d+)$/);
      if (m) out[m[1]] = Number(m[2]);
      else if (part === 'gone') out.gone = true;
    }
  }
  const dots = h.indexOf('...');
  out.branch = (dots >= 0 ? h.slice(0, dots) : h).trim();
  out.upstream = dots >= 0 ? h.slice(dots + 3).trim() : '';
  return out;
}

// `git worktree list --porcelain`: one block per worktree, blocks separated by a blank line, the first block is the
// main worktree. Lines: `worktree <path>`, `HEAD <sha>`, `branch refs/heads/<name>`, `detached`, `bare`,
// `locked [reason]`, `prunable [reason]`. -> [{ path, branch, detached, bare, locked, prunable }] — branch without
// `refs/heads/`, '' when detached or bare. Lines before the first `worktree` line belong to no block and are dropped.
function parseWorktreePorcelain(stdout) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur && cur.path) out.push(cur); cur = null; };
  for (const raw of String(stdout || '').split('\n')) {
    const l = raw.replace(/\r$/, '');
    if (!l.trim()) { flush(); continue; }
    const sp = l.indexOf(' ');
    const key = sp < 0 ? l : l.slice(0, sp);
    const val = sp < 0 ? '' : l.slice(sp + 1);
    if (key === 'worktree') { flush(); cur = { path: val, branch: '', detached: false, bare: false, locked: false, prunable: false }; continue; }
    if (!cur) continue;
    if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '');
    else if (key === 'detached' || key === 'bare' || key === 'locked' || key === 'prunable') cur[key] = true;
  }
  flush();
  return out;
}

// A remote URL → { host, owner, repo } or null. The three forms git writes: https (also with `user:token@`),
// ssh:// and the scp shorthand `git@host:owner/repo.git`. ONLY these three parts leave the server: the raw URL can
// carry a token in its userinfo, so it is never handed on. Owner and repo must match ^[\w.-]+$ and are not `.`/`..`;
// a trailing `.git` and `/` are dropped; exactly two path segments (owner/repo), anything else is not a repo URL.
const GHE_NAME_RE = /^[\w.-]+$/;
function parseGheRepo(url) {
  const s = String(url == null ? '' : url).trim();
  if (!s) return null;
  let host = '', pathPart = '';
  const scp = /^[^/\\@:]+@([^/\\:]+):(?!\/)(.+)$/.exec(s);
  if (scp) { host = scp[1]; pathPart = scp[2]; }
  else {
    let u;
    try { u = new URL(s); } catch { return null; }
    if (!/^(https?|ssh|git):$/.test(u.protocol) || !u.hostname) return null;
    host = u.hostname; pathPart = u.pathname;
  }
  const segs = pathPart.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').split('/');
  if (segs.length !== 2) return null;
  const [owner, repo] = segs;
  const ok = (n) => GHE_NAME_RE.test(n) && !/^\.+$/.test(n);
  if (!ok(owner) || !ok(repo)) return null;
  return { host: host.toLowerCase(), owner, repo };
}

module.exports = {
  computeNextRun, normalizeScheduleTiming, missingRequiredInputs, memoryLinkTargets,
  composeAppendSystem, selectCorrections, CORRECTION_CAPS, GUARDRAIL_CAPS, OPEN_POINTS_PROTOCOL,
  subagentSpawnConfig, mergeSubagentCfg, normalizeSubagentCfg, SUBAGENT_MODELS, SUBAGENT_CAPS,
  resolveUltracode, ultracodeSpawnSettings, ultracodeState,
  PROMPT_SNAPSHOT_MODES, normalizePromptSnapshot, promptSnapshotArg,
  buildSpawnPolicy, headlessPermissionMode, HEADLESS_PERM_MODES,
  applySettingsOps, validateSettingsOps, jsonEqual,
  joinRunCosts, runCostWindow, parseRevListLeftRight, parsePorcelain, parsePorcelainBranch,
  parseBranchHeader, parseWorktreePorcelain, parseGheRepo,
};
