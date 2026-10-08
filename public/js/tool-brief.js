'use strict';
// U1 / PR-12 — the COMPACT card for the tools the panel used to dump as raw JSON. Browser (classic
// script) AND Node (require'd by test/tool-brief.test.js). Dependency-free, no DOM, no t(): every label
// is returned as an i18n KEY and resolved by the renderer, the same seam task-stop.js stopView() uses.
//
// Why these tools and not others: they are the ones the CLI actually calls on this machine, counted over
// every transcript under ~/.claude/projects (606 *.jsonl files, 2026-10-03):
//   ToolSearch 1011 · Workflow 51 · TaskStop 23 · TaskUpdate 18 · TaskCreate 12 · Skill 12 ·
//   SendMessage 10 · ScheduleWakeup 3 · ListAgents 1
// …and three that this change covers WITHOUT a single observed call: ReportFindings, Cron* and
// EnterWorktree/ExitWorktree are 0 of 606. Their field names are therefore read off the tool SCHEMAS
// (fetched in this session), not off traffic, and that is why every field is read defensively: a brief
// that assumed a shape would print nothing the day the shape differs. Each `rows` entry is dropped when
// its value is absent, so an unexpected input degrades to the summary line instead of to an empty card.
//
// The INPUT KEY SETS are measured, not assumed:
//   Workflow       {script}×30 · {description,script}×12 · {resumeFromRunId,scriptPath}×5 ·
//                  {description,resumeFromRunId,scriptPath}×2 · {scriptPath}×2
//                  → `script` carries the whole source INLINE in 42 of 51 calls, which is precisely why
//                    the raw JSON card was unreadable: a 40-line workflow as one escaped string.
//   ToolSearch     {max_results,query}×994 · {query}×18
//   Skill          {args,skill}×8 · {skill}×4
//   ScheduleWakeup {delaySeconds,noop,prompt,reason}×2 · {stop}×1
//   TaskCreate     {activeForm,description,subject}×11   (the 12th is a refused {tasks} call)
//   TaskUpdate     {status,taskId}×18

function tbStr(v) { return (v == null) ? '' : String(v); }
function tbOneLine(v, max) {
  var s = tbStr(v).replace(/\s+/g, ' ').trim();
  var cap = max || 120;
  return s.length > cap ? s.slice(0, cap - 1) + '…' : s;
}
function tbInt(v) { var n = Number(v); return (isFinite(n)) ? n : null; }
// The last path segment, for either slash. A workflow's scriptPath is an absolute Windows path and the
// summary line of a card is 1 line wide; the full path stays in the card body.
function tbBase(p) {
  var s = tbStr(p).replace(/[\\/]+$/, '');
  var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}
function tbLines(s) { return tbStr(s) ? tbStr(s).split('\n').length : 0; }

// Which tools get a compact card. Exported so the renderer and the tests ask ONE list — a second copy in
// chat-render.js is how a tool ends up in the switch and not in the card, or the other way round.
var TB_TOOLS = ['Workflow', 'ReportFindings', 'CronCreate', 'CronList', 'CronDelete', 'ScheduleWakeup',
  'Skill', 'ToolSearch', 'EnterWorktree', 'ExitWorktree'];
function tbHas(name) { return TB_TOOLS.indexOf(tbStr(name)) >= 0; }

// -> { icon, title, sum, sumKey, rows: [{ key, val, valKey }], body?: {key, text} } | null
// `title` replaces the bare tool name in the summary, `sum`/`sumKey` is the one-line gist, `rows` are
// key/value lines in the card, `body` is the one long text that may not be thrown away (a workflow's
// source, a wakeup's prompt) and is kept verbatim.
//
// Why a VALUE can be an i18n key, and why that is marked with a flag instead of sniffed from the string:
// some values are words of ours („ja", „Suche") rather than data of the model's. A renderer that decided
// „does this look like a key?" would translate a ToolSearch query that happens to read `tool-brief.x`, and
// „it looked like one of ours" is precisely the class of guess this repo pays for. `valKey: true` says it.
function toolBrief(name, input) {
  var n = tbStr(name);
  if (!tbHas(n)) return null;
  var o = (input && typeof input === 'object' && !input._truncated) ? input : null;
  if (!o) return null;                       // a truncated input has no fields to read — keep the raw card
  var rows = [];
  var add = function (key, val) { if (val !== '' && val != null) rows.push({ key: key, val: tbStr(val), valKey: false }); };
  var addKey = function (key, valKey) { rows.push({ key: key, val: tbStr(valKey), valKey: true }); };

  if (n === 'Workflow') {
    // A workflow call is either inline source (`script`) or a file (`scriptPath`), and either may carry a
    // `resumeFromRunId` — measured: 7 of 51 calls resume a previous run, which is the single most useful
    // thing to see on the card and was invisible inside the JSON blob.
    var wfName = tbOneLine(o.description) || tbBase(o.scriptPath);
    add('tool-brief.wfScript', o.scriptPath ? tbStr(o.scriptPath) : '');
    if (!o.scriptPath && o.script) add('tool-brief.wfInline', tbLines(o.script));
    add('tool-brief.wfResume', tbStr(o.resumeFromRunId));
    return {
      icon: '⚙', title: 'Workflow', sum: wfName, sumKey: '', rows: rows,
      body: o.script ? { key: 'tool-brief.wfQuelle', text: tbStr(o.script) } : null,
    };
  }
  if (n === 'ReportFindings') {
    // Schema-read, zero observed calls. The card counts the findings and lists them as
    // „file:line — short_summary", because that is what a reviewer scans. `verdict`/`outcome` are
    // OPTIONAL in the schema, so they are only summarised when they are really there.
    var f = Array.isArray(o.findings) ? o.findings : [];
    var confirmed = 0, fixed = 0;
    for (var i = 0; i < f.length; i++) {
      if (f[i] && f[i].verdict === 'CONFIRMED') confirmed++;
      if (f[i] && f[i].outcome === 'fixed') fixed++;
    }
    add('tool-brief.rfAnzahl', String(f.length));
    if (confirmed) add('tool-brief.rfBestaetigt', String(confirmed));
    if (fixed) add('tool-brief.rfBehoben', String(fixed));
    add('tool-brief.rfStufe', tbStr(o.level));
    for (var k = 0; k < f.length && k < 12; k++) {
      var it = f[k] || {};
      var where = tbStr(it.file) + (tbInt(it.line) != null ? ':' + tbInt(it.line) : '');
      add('tool-brief.rfBefund', (where ? where + ' — ' : '') + tbOneLine(it.short_summary || it.summary, 90));
    }
    return { icon: '🔎', title: 'ReportFindings', sum: f.length ? String(f.length) : '', sumKey: '', rows: rows, body: null };
  }
  if (n === 'CronCreate') {
    add('tool-brief.cronAusdruck', tbStr(o.cron));
    // Both flags DEFAULT in the CLI (recurring true, durable false), so „absent" is a statement and the
    // row prints the effective value rather than leaving the reader to remember the default.
    addKey('tool-brief.cronWiederkehrend', o.recurring === false ? 'tool-brief.nein' : 'tool-brief.ja');
    addKey('tool-brief.cronDauerhaft', o.durable === true ? 'tool-brief.ja' : 'tool-brief.nein');
    return {
      icon: '⏰', title: 'CronCreate', sum: tbStr(o.cron), sumKey: '', rows: rows,
      body: o.prompt ? { key: 'tool-brief.cronAuftrag', text: tbStr(o.prompt) } : null,
    };
  }
  if (n === 'CronDelete') {
    add('tool-brief.cronId', tbStr(o.id));
    return { icon: '⏰', title: 'CronDelete', sum: tbStr(o.id), sumKey: '', rows: rows, body: null };
  }
  if (n === 'CronList') return { icon: '⏰', title: 'CronList', sum: '', sumKey: '', rows: [], body: null };
  if (n === 'ScheduleWakeup') {
    // Two measured shapes: `{delaySeconds,noop,prompt,reason}` and `{stop}`. The second one CANCELS a
    // pending wakeup and must not be drawn as if it scheduled one.
    if (o.stop) return { icon: '⏱', title: 'ScheduleWakeup', sum: '', sumKey: 'tool-brief.wakeStop', rows: [], body: null };
    var sec = tbInt(o.delaySeconds);
    add('tool-brief.wakeIn', sec == null ? '' : String(sec));
    if (o.noop === true) addKey('tool-brief.wakeNoop', 'tool-brief.ja');
    add('tool-brief.wakeGrund', tbOneLine(o.reason, 200));
    return {
      icon: '⏱', title: 'ScheduleWakeup', sum: sec == null ? '' : String(sec), sumKey: '', rows: rows,
      body: o.prompt ? { key: 'tool-brief.wakeAuftrag', text: tbStr(o.prompt) } : null,
    };
  }
  if (n === 'Skill') {
    add('tool-brief.skillName', tbStr(o.skill));
    add('tool-brief.skillArgs', tbOneLine(o.args, 200));
    return { icon: '📚', title: 'Skill', sum: tbStr(o.skill), sumKey: '', rows: rows, body: null };
  }
  if (n === 'ToolSearch') {
    // By far the most called tool here (1011 of all the ones this file covers) and the one whose raw card
    // said the least: two short fields wrapped in JSON. `select:a,b,c` is a different act from a keyword
    // search — it fetches named schemas — so the card names which of the two it is.
    var q = tbStr(o.query);
    var sel = /^select:/i.test(q.trim());
    addKey('tool-brief.tsArt', sel ? 'tool-brief.tsSelect' : 'tool-brief.tsSuche');
    add('tool-brief.tsAbfrage', tbOneLine(sel ? q.trim().slice(7) : q, 200));
    add('tool-brief.tsMax', tbInt(o.max_results) == null ? '' : String(tbInt(o.max_results)));
    return { icon: '🧰', title: 'ToolSearch', sum: tbOneLine(q, 90), sumKey: '', rows: rows, body: null };
  }
  if (n === 'EnterWorktree') {
    // The schema makes `name` and `path` mutually exclusive and both optional: with neither, the CLI
    // generates a name. So „nothing given" is a real case and gets its own word instead of a blank row.
    if (o.path) add('tool-brief.wtPfad', tbStr(o.path));
    else if (o.name) add('tool-brief.wtName', tbStr(o.name));
    else addKey('tool-brief.wtName', 'tool-brief.wtGeneriert');
    return { icon: '🌿', title: 'EnterWorktree', sum: tbStr(o.path || o.name), sumKey: '', rows: rows, body: null };
  }
  if (n === 'ExitWorktree') {
    addKey('tool-brief.wtAktion', o.action === 'remove' ? 'tool-brief.wtEntfernen' : 'tool-brief.wtBehalten');
    if (o.discard_changes === true) addKey('tool-brief.wtVerwerfen', 'tool-brief.ja');
    return { icon: '🌿', title: 'ExitWorktree', sum: tbStr(o.action), sumKey: '', rows: rows, body: null };
  }
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TB_TOOLS, tbHas, toolBrief, tbBase, tbOneLine, tbLines };
}
