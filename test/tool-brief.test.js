'use strict';
// U1 / PR-12 — the compact tool card. Both halves: the brief (public/js/tool-brief.js) and the CARD that is
// supposed to render it (chat-render.js addToolCard, lifted out of the source). The second half is the point:
// a brief nobody paints is the „vocabulary without a reader" this repo counts as a finding, not progress.
//
// THE INPUTS ARE MEASURED, not invented — counted over every transcript under ~/.claude/projects (606
// *.jsonl files, 2026-10-03), one fixture per observed key set:
//   Workflow       {script}×30 · {description,script}×12 · {resumeFromRunId,scriptPath}×5 ·
//                  {description,resumeFromRunId,scriptPath}×2 · {scriptPath}×2
//   ToolSearch     {max_results,query}×994 · {query}×18
//   Skill          {args,skill}×8 · {skill}×4
//   ScheduleWakeup {delaySeconds,noop,prompt,reason}×2 · {stop}×1
// Three of the ten tools have ZERO observed calls — ReportFindings, Cron* and Enter/ExitWorktree. Their
// fixtures are built from the tool SCHEMAS, which is written down here because it is the difference between
// „pinned behaviour" and „pinned guess": if one of those shapes turns out to differ, the brief degrades to
// its summary line (every row is dropped when its value is absent) rather than printing a wrong label.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TB_TOOLS, tbHas, toolBrief, tbBase, tbLines } = require('../public/js/tool-brief');

const row = (b, key) => (b.rows.find((r) => r.key === key) || null);
const val = (b, key) => { const r = row(b, key); return r ? r.val : undefined; };
// the real inline script of the paid probe run (docs/messung-2026-10-02.md), shortened to its shape
const PROBE_SCRIPT = "export const meta = {\n  name: 'ccui-probe',\n  description: 'Protokollsonde',\n  phases: [{ title: 'Probe' }],\n}\n\nconst LABELS = ['a1', 'a2']\nreturn { ok: 2 }\n";

describe('U1 — toolBrief covers exactly the ten tools, and nothing else', () => {
  it('the list is one list — the renderer and this test ask the same question', () => {
    assert.deepEqual(TB_TOOLS, ['Workflow', 'ReportFindings', 'CronCreate', 'CronList', 'CronDelete',
      'ScheduleWakeup', 'Skill', 'ToolSearch', 'EnterWorktree', 'ExitWorktree']);
    for (const t of TB_TOOLS) assert.equal(tbHas(t), true, t);
    // the tools that already HAVE a dedicated card must not be captured by this one
    for (const t of ['Agent', 'Task', 'Monitor', 'TodoWrite', 'Read', 'Edit', 'Write', 'Bash', 'TaskCreate', 'TaskUpdate']) {
      assert.equal(tbHas(t), false, t + ' must keep its own rendering');
      assert.equal(toolBrief(t, { a: 1 }), null, t);
    }
  });

  it('a truncated input keeps the RAW card instead of a brief built on nothing', () => {
    // tool-store.js replaces a huge input with `{_truncated:true, preview}`. A brief over that would print
    // empty rows next to a tool name, i.e. it would look like „this call had no arguments".
    assert.equal(toolBrief('Workflow', { _truncated: true, preview: '{"script":"…' }), null);
    assert.equal(toolBrief('Workflow', null), null);
    assert.equal(toolBrief('Workflow', 'a string'), null);
  });
});

describe('U1 — Workflow: the card the raw JSON made unreadable', () => {
  it('an INLINE script (42 of 51 measured calls) is counted, not dumped into the summary', () => {
    const b = toolBrief('Workflow', { description: 'Protokollsonde', script: PROBE_SCRIPT });
    assert.equal(b.title, 'Workflow');
    assert.equal(b.sum, 'Protokollsonde');
    assert.equal(val(b, 'tool-brief.wfInline'), String(tbLines(PROBE_SCRIPT)));
    assert.equal(val(b, 'tool-brief.wfScript'), undefined, 'there is no file — no row may claim one');
    // …and the source itself is NOT thrown away: it moves into the card body, verbatim
    assert.equal(b.body.key, 'tool-brief.wfQuelle');
    assert.equal(b.body.text, PROBE_SCRIPT);
  });

  it('a script FILE names the path, and the summary falls back to its basename', () => {
    const p = 'C:\\Users\\you\\ccui-probe\\runs\\paid-2026-10-02T19-55-29-267Z\\sandbox\\probe-wf.js';
    const b = toolBrief('Workflow', { scriptPath: p });
    assert.equal(b.sum, 'probe-wf.js');
    assert.equal(val(b, 'tool-brief.wfScript'), p);
    assert.equal(val(b, 'tool-brief.wfInline'), undefined);
    assert.equal(b.body, null);
    assert.equal(tbBase('C:/a/b/c.js'), 'c.js');
    assert.equal(tbBase('C:\\a\\b\\c.js'), 'c.js');
  });

  it('a RESUMED run says so — 7 of 51 calls, and it was invisible inside the blob', () => {
    const b = toolBrief('Workflow', { description: 'PR-3 Fix', resumeFromRunId: 'wf_370eadee-715', scriptPath: 'C:/x/fix.js' });
    assert.equal(val(b, 'tool-brief.wfResume'), 'wf_370eadee-715');
  });
});

describe('U1 — the three tools with ZERO observed calls are read defensively', () => {
  it('ReportFindings counts and lists, and only summarises the OPTIONAL fields that are there', () => {
    const b = toolBrief('ReportFindings', {
      level: 'high',
      findings: [
        { file: 'lib/core.js', line: 264, short_summary: 'cwd gate never called', verdict: 'CONFIRMED' },
        { file: 'public/js/chat-side.js', summary: 'rail skips the repaint', verdict: 'PLAUSIBLE', outcome: 'fixed' },
      ],
    });
    assert.equal(val(b, 'tool-brief.rfAnzahl'), '2');
    assert.equal(val(b, 'tool-brief.rfBestaetigt'), '1');
    assert.equal(val(b, 'tool-brief.rfBehoben'), '1');
    assert.equal(val(b, 'tool-brief.rfStufe'), 'high');
    const found = b.rows.filter((r) => r.key === 'tool-brief.rfBefund');
    assert.equal(found.length, 2);
    assert.match(found[0].val, /^lib\/core\.js:264 — cwd gate never called$/);
    assert.match(found[1].val, /^public\/js\/chat-side\.js — rail skips the repaint$/, 'no line → no „:undefined"');
  });

  it('…and with none of the optional fields it prints a count and stops', () => {
    const b = toolBrief('ReportFindings', { findings: [{ file: 'a.js', summary: 's', failure_scenario: 'f' }] });
    assert.equal(val(b, 'tool-brief.rfBestaetigt'), undefined);
    assert.equal(val(b, 'tool-brief.rfBehoben'), undefined);
    assert.equal(val(b, 'tool-brief.rfStufe'), undefined);
    // an empty findings array is a real answer („nothing survived verification") and must read as 0, not blank
    const empty = toolBrief('ReportFindings', { findings: [] });
    assert.equal(val(empty, 'tool-brief.rfAnzahl'), '0');
  });

  it('CronCreate prints the EFFECTIVE value of both defaulting flags', () => {
    // recurring defaults to true, durable to false — „absent" is a statement, so the row must not be blank
    const plain = toolBrief('CronCreate', { cron: '57 8 * * *', prompt: 'Lauf prüfen' });
    assert.deepEqual(row(plain, 'tool-brief.cronWiederkehrend'), { key: 'tool-brief.cronWiederkehrend', val: 'tool-brief.ja', valKey: true });
    assert.deepEqual(row(plain, 'tool-brief.cronDauerhaft'), { key: 'tool-brief.cronDauerhaft', val: 'tool-brief.nein', valKey: true });
    assert.equal(plain.body.text, 'Lauf prüfen');
    const once = toolBrief('CronCreate', { cron: '30 14 28 2 *', prompt: 'x', recurring: false, durable: true });
    assert.equal(val(once, 'tool-brief.cronWiederkehrend'), 'tool-brief.nein');
    assert.equal(val(once, 'tool-brief.cronDauerhaft'), 'tool-brief.ja');
    assert.equal(toolBrief('CronList', {}).rows.length, 0);
    assert.equal(val(toolBrief('CronDelete', { id: 'job-7' }), 'tool-brief.cronId'), 'job-7');
  });

  it('EnterWorktree distinguishes „path", „name" and „neither" (the CLI generates one)', () => {
    assert.equal(val(toolBrief('EnterWorktree', { path: 'C:/r/.claude/worktrees/a' }), 'tool-brief.wtPfad'), 'C:/r/.claude/worktrees/a');
    assert.equal(val(toolBrief('EnterWorktree', { name: 'pr-12' }), 'tool-brief.wtName'), 'pr-12');
    const gen = toolBrief('EnterWorktree', {});
    assert.deepEqual(row(gen, 'tool-brief.wtName'), { key: 'tool-brief.wtName', val: 'tool-brief.wtGeneriert', valKey: true });
    assert.equal(val(toolBrief('ExitWorktree', { action: 'remove', discard_changes: true }), 'tool-brief.wtAktion'), 'tool-brief.wtEntfernen');
    assert.equal(val(toolBrief('ExitWorktree', { action: 'keep' }), 'tool-brief.wtVerwerfen'), undefined);
  });
});

describe('U1 — the measured shapes of the tools that really run here', () => {
  it('ScheduleWakeup: a STOP is not drawn as a scheduled wakeup', () => {
    const stop = toolBrief('ScheduleWakeup', { stop: true });
    assert.equal(stop.sumKey, 'tool-brief.wakeStop');
    assert.equal(stop.sum, '');
    assert.equal(stop.rows.length, 0, 'there is no delay, no reason and no prompt to show');
    const real = toolBrief('ScheduleWakeup', { delaySeconds: 1800, noop: false, reason: 'Fallback heartbeat', prompt: 'Check the fix workflow' });
    assert.equal(real.sum, '1800');
    assert.equal(val(real, 'tool-brief.wakeGrund'), 'Fallback heartbeat');
    assert.equal(val(real, 'tool-brief.wakeNoop'), undefined, 'noop:false must not print a row');
    assert.equal(real.body.text, 'Check the fix workflow');
  });

  it('ToolSearch: `select:` is a different act from a keyword search and says so', () => {
    const sel = toolBrief('ToolSearch', { query: 'select:whoami,inbox,board_read', max_results: 10 });
    assert.equal(val(sel, 'tool-brief.tsArt'), 'tool-brief.tsSelect');
    assert.equal(val(sel, 'tool-brief.tsAbfrage'), 'whoami,inbox,board_read');
    assert.equal(val(sel, 'tool-brief.tsMax'), '10');
    const q = toolBrief('ToolSearch', { query: 'notebook jupyter' });
    assert.equal(val(q, 'tool-brief.tsArt'), 'tool-brief.tsSuche');
    assert.equal(val(q, 'tool-brief.tsAbfrage'), 'notebook jupyter');
    assert.equal(val(q, 'tool-brief.tsMax'), undefined, '18 of 1011 calls pass no cap — no row invents one');
  });

  it('a value that LOOKS like an i18n key stays the user\'s text', () => {
    // the flag decides, never the string's shape: a renderer that sniffed „does this look like a key?"
    // would translate this query away
    const b = toolBrief('ToolSearch', { query: 'tool-brief.ja' });
    assert.deepEqual(row(b, 'tool-brief.tsAbfrage'), { key: 'tool-brief.tsAbfrage', val: 'tool-brief.ja', valKey: false });
  });

  it('Skill: with and without args (12 measured calls, 4 of them bare)', () => {
    const a = toolBrief('Skill', { skill: 'claude-api', args: 'pricing for sonnet-5-5' });
    assert.equal(a.sum, 'claude-api');
    assert.equal(val(a, 'tool-brief.skillArgs'), 'pricing for sonnet-5-5');
    assert.equal(val(toolBrief('Skill', { skill: 'handoff' }), 'tool-brief.skillArgs'), undefined);
  });
});

// ---- the reader -------------------------------------------------------------------------------------
// addToolCard() lifted out of the shipped chat-render.js, run against a fake DOM: so the CARD is under
// test, not a copy of the brief.
const RENDER_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat-render.js'), 'utf8');
function fakeEl(tag, cls, text) {
  const n = {
    tag, className: cls || '', textContent: text == null ? '' : String(text), title: '', children: [],
    dataset: {}, open: false, innerHTML: '',
    appendChild(c) { this.children.push(c); return c; },
    classList: { add(c) { n.className += ' ' + c; } },
    querySelector(sel) {
      const want = String(sel).replace(/^\./, '');
      const walk = (x) => { for (const c of x.children) { if (String(c.className).split(/\s+/).includes(want)) return c; const d = walk(c); if (d) return d; } return null; };
      return walk(n);
    },
    remove() { n.removed = true; },
  };
  return n;
}
function loadAddToolCard(chat) {
  const m = new RegExp('^function addToolCard\\([\\s\\S]*?^\\}', 'm').exec(RENDER_SRC);
  assert.ok(m, 'addToolCard() not found in public/js/chat-render.js — renamed or reindented?');
  const env = {
    el: fakeEl, tt: (k) => k, toolBrief, DISPLAY: { tools: true },
    toolSummary: (i) => JSON.stringify(i || {}),
    isAgentTool: (n) => n === 'Agent' || n === 'Task',
    isEditInput: () => false, isWriteInput: () => false,
    copyBtn: () => fakeEl('button', 'copy-btn'),
    chat, scheduleSteps: () => {}, scrollBottom: () => {}, ACTIVE: chat,
    renderDiff: () => fakeEl('div', 'diff'), renderDiffFast: () => fakeEl('div', 'diff'),
    highlightCode: (s) => s,                            // only the generic <pre> path reaches this
  };
  const keys = Object.keys(env);
  return new Function(...keys, m[0] + '\nreturn addToolCard;')(...keys.map((k) => env[k]));
}
const texts = (n) => [n.textContent].concat(n.children.map(texts)).flat(9).filter(Boolean);

describe('U1 — addToolCard really paints the brief (and the raw path still works)', () => {
  it('the summary shows icon + tool name + gist, and the JSON blob is gone', () => {
    const chat = { steps: [], toolCards: {} };
    const add = loadAddToolCard(chat);
    const bubble = fakeEl('div', 'bubble');
    bubble.parentElement = fakeEl('div', 'msg');
    const card = add(bubble, 'Workflow', { description: 'Protokollsonde', script: PROBE_SCRIPT }, {});
    assert.match(String(card.className), /is-brief/);
    const sum = card.children[0];
    assert.equal(sum.querySelector('.tc-name').textContent, '⚙ Workflow');
    assert.equal(sum.querySelector('.tc-sum').textContent, 'Protokollsonde');
    // the key/value rows exist and carry the i18n KEYS, i.e. the brief reached the DOM
    const body = card.children.find((c) => String(c.className) === 'tc-brief');
    assert.ok(body, 'classes: ' + JSON.stringify(card.children.map((c) => c.className)));
    assert.deepEqual(body.children.map((r) => r.children[0].textContent), ['tool-brief.wfInline']);
    // …and the source is in the card, not lost
    assert.ok(texts(card).includes('tool-brief.wfQuelle'));
    assert.ok(card.children.some((c) => c.tag === 'pre' && c.textContent === PROBE_SCRIPT));
    // the step timeline gets the compact name too
    assert.deepEqual(chat.steps.map((s) => s.name), ['⚙ Workflow']);
    assert.equal(chat.steps[0].summary, 'Protokollsonde');
  });

  it('a row whose value is a WORD of ours is translated; the user\'s text is not', () => {
    const chat = { steps: [], toolCards: {} };
    const add = loadAddToolCard(chat);
    const bubble = fakeEl('div', 'bubble'); bubble.parentElement = fakeEl('div', 'msg');
    const card = add(bubble, 'ToolSearch', { query: 'tool-brief.ja', max_results: 5 }, {});
    const rows = card.children.find((c) => String(c.className) === 'tc-brief').children
      .map((r) => [r.children[0].textContent, r.children[1].textContent]);
    assert.deepEqual(rows, [
      ['tool-brief.tsArt', 'tool-brief.tsSuche'],   // ours → translated (tt returns the key here)
      ['tool-brief.tsAbfrage', 'tool-brief.ja'],    // the user's query → untouched
      ['tool-brief.tsMax', '5'],
    ]);
  });

  it('a sumKey-only brief (ScheduleWakeup stop) still gets a summary line', () => {
    const chat = { steps: [], toolCards: {} };
    const add = loadAddToolCard(chat);
    const bubble = fakeEl('div', 'bubble'); bubble.parentElement = fakeEl('div', 'msg');
    const card = add(bubble, 'ScheduleWakeup', { stop: true }, {});
    assert.equal(card.children[0].querySelector('.tc-sum').textContent, 'tool-brief.wakeStop');
    assert.equal(card.children.find((c) => String(c.className) === 'tc-brief'), undefined, 'no rows → no empty box');
  });

  it('a tool the brief does NOT cover keeps the raw JSON card (the counter-test)', () => {
    const chat = { steps: [], toolCards: {} };
    const add = loadAddToolCard(chat);
    const bubble = fakeEl('div', 'bubble'); bubble.parentElement = fakeEl('div', 'msg');
    const card = add(bubble, 'Grep', { pattern: 'x', glob: '*.js' }, {});
    assert.doesNotMatch(String(card.className), /is-brief/);
    assert.ok(card.children.some((c) => c.tag === 'pre'), 'the generic <pre> path must be untouched');
  });
});
