'use strict';
// What an UNATTENDED run actually launches with (BACKEND-M1 + SEC-H). The headless engine used to build
// its own startChat options and passed almost nothing of the panel's settings: a scheduled write-run
// ran without the guardrails ("T01 ist das Testsystem") and without the corrections, while the README
// said it inherited both. argv is the only place where that is visible, so this suite asserts it —
// through the same CLAUDE_UI_FAKE_BIN seam as chatargs.test.js, with a fake that prints its argv,
// answers the first prompt with a `result` and exits.
//
// Env BEFORE the requires: lib/paths resolves DATA_DIR at load time, and this file runs in its own
// process (node --test), so nothing here leaks into another suite.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeSandbox } = require('./sandbox');

const SBX = makeSandbox('engine-policy');
Object.assign(process.env, SBX.env); // temp DATA_DIR/CLAUDE_DIR, no scheduler tick, no real CDP/GHE
const ARGV_OUT = path.join(SBX.root, 'argv.json');
const FAKE = path.join(SBX.root, 'echo-argv-result.js');
fs.writeFileSync(FAKE, [
  'const fs = require("fs");',
  // PR-S: the engine reads the binary's --help (lib/cli cliHelpFlags) before it spawns — answered like the
  // real CLI lists the snapshot flag, and BEFORE the argv write, so the probe never overwrites the argv of
  // the run under test
  'if (process.argv[2] === "--help") { process.stdout.write("Options:\\n  --system-prompt-snapshot <on|off>     Record the system prompt once\\n"); process.exit(0); }',
  'fs.writeFileSync(' + JSON.stringify(ARGV_OUT) + ', JSON.stringify(process.argv.slice(2)));',
  // answer the prompt like the CLI would end a turn, then leave — the engine finishes on `result`
  'let buf = "";',
  'process.stdin.on("data", (d) => { buf += d; if (buf.includes("\\n")) {',
  '  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }) + "\\n");',
  '  process.exit(0);',
  '} });',
].join('\n') + '\n');
process.env.CLAUDE_UI_FAKE_BIN = FAKE.replace(/\\/g, '/');

// the panel's settings as a user would have them: guardrail + correction set, AND every switch that a
// headless run must NOT take over turned on (global ultracode, hook events; forwardSubagentText is on
// by default), plus the subagent off-switch whose denied tools must merge into the one flag
fs.writeFileSync(path.join(SBX.dataDir, 'ui-prefs.json'), JSON.stringify({
  guardrails: 'T01 ist das Testsystem', ultracode: true, includeHookEvents: true, subagents: { allow: false },
}));
fs.writeFileSync(path.join(SBX.dataDir, 'corrections.json'), JSON.stringify([{ text: 'Belege immer mit Dateipfad', at: 1 }]));

const { runUiSkillHeadless, headlessToolAllowed, HEADLESS_DENIED_TOOLS } = require('../lib/engine');
after(() => SBX.cleanup());

const SKILL = (mode) => ({ name: 'x-ui', manifest: { title: 'X', run: mode ? { permissionMode: mode } : {} } });
async function launch(skill, opts) {
  try { fs.rmSync(ARGV_OUT, { force: true }); } catch { /* */ }
  const rec = await runUiSkillHeadless(skill, {}, opts);
  let argv = [];
  try { argv = JSON.parse(fs.readFileSync(ARGV_OUT, 'utf8')); } catch { /* */ }
  return { rec, argv };
}
const valOf = (argv, flag) => { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1]; };
const eqOf = (argv, flag) => { const a = argv.find((x) => x.startsWith(flag + '=')); return a === undefined ? null : a.slice(flag.length + 1); };

describe('lib/engine — a headless run launches with the panel policy', () => {
  it('inherits guardrails, corrections and the subagent policy — but not the UI-only layer', async () => {
    const { rec, argv } = await launch(SKILL(), { allowWrites: true });
    assert.equal(rec.status, 'done', 'the fake answered with a result');
    const sys = eqOf(argv, '--append-system-prompt') || '';
    assert.match(sys, /T01 ist das Testsystem/, 'the guardrail reaches the unattended run');
    assert.match(sys, /Belege immer mit Dateipfad/, 'so does the correction');
    assert.doesNotMatch(sys, /Offene Punkte/, 'no open-points protocol without a UI that reads it');
    assert.ok(!argv.includes('--forward-subagent-text'), 'subagent text would end up in the run result');
    assert.ok(!argv.includes('--include-hook-events'));
    // ONE flag, shell denial and subagent off-switch merged — a second flag could drop the shell denial
    assert.equal(argv.filter((x) => x === '--disallowed-tools').length, 1);
    const denied = valOf(argv, '--disallowed-tools').split(',');
    ['Bash', 'BashOutput', 'KillShell', 'KillBash', 'Agent', 'Task'].forEach((t) => assert.ok(denied.includes(t), t));
  });

  // PR-S — the same ONE setting as the chat start route, decided by the same buildSpawnPolicy. A headless
  // run never resumes today, so the flag changes nothing there yet; what this pins is that the two launch
  // paths cannot disagree about it.
  it('passes --system-prompt-snapshot off by default, and nothing when the setting is on', async () => {
    const def = await launch(SKILL(), { allowWrites: true });
    assert.equal(valOf(def.argv, '--system-prompt-snapshot'), 'off', 'the default reaches the unattended run');
    const prefsFile = path.join(SBX.dataDir, 'ui-prefs.json');
    const keep = fs.readFileSync(prefsFile, 'utf8');
    try {
      fs.writeFileSync(prefsFile, JSON.stringify(Object.assign(JSON.parse(keep), { promptSnapshot: 'on' })));
      const on = await launch(SKILL(), { allowWrites: true });
      assert.ok(!on.argv.includes('--system-prompt-snapshot'), "'on' = the CLI default = no flag");
      assert.equal(on.rec.status, 'done');
    } finally { fs.writeFileSync(prefsFile, keep); }
  });

  it('never inherits the global ultracode — only the schedule opt-in turns it on', async () => {
    const off = await launch(SKILL(), { allowWrites: true });
    assert.equal(valOf(off.argv, '--settings'), null, 'global ultracode:true must not reach a headless run');
    assert.equal(off.rec.ultracode, false);
    const on = await launch(SKILL(), { allowWrites: true, ultracode: true });
    assert.deepEqual(JSON.parse(valOf(on.argv, '--settings')), { ultracode: true });
    assert.equal(on.rec.ultracode, true);
  });

  it('caps a non-asking permission mode to acceptEdits and records it', async () => {
    for (const mode of ['bypassPermissions', 'auto', 'dontAsk']) {
      const { rec, argv } = await launch(SKILL(mode), { allowWrites: true });
      assert.equal(valOf(argv, '--permission-mode'), 'acceptEdits', mode);
      assert.equal(rec.permissionMode, 'acceptEdits');
      assert.equal(rec.permissionCapped, mode, 'the downgrade is named, not silent');
    }
  });

  it('keeps an asking mode, and a read-only or dry run is plan whatever the manifest says', async () => {
    const def = await launch(SKILL('default'), { allowWrites: true });
    assert.equal(valOf(def.argv, '--permission-mode'), 'default');
    assert.equal(def.rec.permissionCapped, null);
    const ro = await launch(SKILL('bypassPermissions'), { allowWrites: false });
    assert.equal(valOf(ro.argv, '--permission-mode'), 'plan');
    const dry = await launch(SKILL('acceptEdits'), { allowWrites: true, dryRun: true });
    assert.equal(valOf(dry.argv, '--permission-mode'), 'plan');
  });
});

// The VERDICT, not the argv. The suite above proves what the CLI is launched with; this block proves
// what the permission responder answers when the CLI asks anyway — the second of the two independent
// gates (lib/engine.js:19-20). It had no test at all, and four of its lines are each a single point of
// failure for "an unattended run may not reach another system": the deny-list beating a manifest, the
// allow-list being case-sensitive, `s.length > 1` stopping a bare '*', and `s !== ''` stopping an empty
// declaration. Each of those is one character away from granting everything on the machine.
describe('lib/engine headlessToolAllowed — the allow-list, per invariant', () => {
  it('the shell set stays denied even when the manifest declares it', () => {
    for (const t of HEADLESS_DENIED_TOOLS) {
      assert.equal(headlessToolAllowed(t, [t]), false, t + ' declared in run.allowTools must still be denied');
      assert.equal(headlessToolAllowed(t, ['*', t + '*']), false, t + ' must survive a wildcard declaration too');
    }
    assert.deepEqual(HEADLESS_DENIED_TOOLS, ['Bash', 'BashOutput', 'KillShell', 'KillBash'], 'the denied set itself');
  });

  it('grants exactly the inspection/file tools with no declaration, and nothing beyond them', () => {
    for (const t of ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      assert.equal(headlessToolAllowed(t, []), true, t);
    }
    // the #15/#20 regression: these three were GRANTED while the rule was `allowWrites && !shell`
    for (const t of ['mcp__jira__create_issue', 'WebFetch', 'Task', 'Agent', 'WebSearch']) {
      assert.equal(headlessToolAllowed(t, []), false, t + ' must not be granted without a declaration');
    }
  });

  it('a prefix wildcard grants ONE server, not all of them', () => {
    assert.equal(headlessToolAllowed('mcp__jira__create_issue', ['mcp__jira__*']), true);
    assert.equal(headlessToolAllowed('mcp__other__x', ['mcp__jira__*']), false, 'the prefix is a fence, not a hint');
    assert.equal(headlessToolAllowed('mcp__jira__create_issue', ['mcp__jira__create_issue']), true, 'exact names work too');
    assert.equal(headlessToolAllowed('mcp__jira__create_issue2', ['mcp__jira__create_issue']), false, 'exact means exact');
  });

  it("a bare '*' grants nothing — the s.length > 1 guard", () => {
    assert.equal(headlessToolAllowed('anything', ['*']), false);
    assert.equal(headlessToolAllowed('WebFetch', ['*']), false);
    // one character more and it IS a prefix: the guard must not be an accidental ban on short prefixes
    assert.equal(headlessToolAllowed('Web', ['W*']), true);
  });

  it("an empty declared entry grants nothing — the s !== '' guard", () => {
    for (const declared of [[''], ['  '], [null], [undefined], ['', '']]) {
      assert.equal(headlessToolAllowed('x', declared), false, JSON.stringify(declared));
    }
    // '  ' must not match a tool literally named '  ' either — but it also must not match ''
    assert.equal(headlessToolAllowed('', ['']), false, 'an unnamed tool is never allowed');
  });

  it('the allow-list is case-SENSITIVE, the deny-list is not', () => {
    assert.equal(headlessToolAllowed('Read', []), true);
    assert.equal(headlessToolAllowed('read', []), false, 'a differently spelled name is not the reviewed tool');
    assert.equal(headlessToolAllowed('bash', []), false, 'the shell denial does not care about case');
    assert.equal(headlessToolAllowed('BASHOUTPUT', []), false);
  });

  it('a missing or non-array declaration is answered, not thrown at', () => {
    for (const declared of [undefined, null, 'Read', 42, {}]) {
      assert.equal(headlessToolAllowed('Read', declared), true, 'allow-list still answers: ' + String(declared));
      assert.equal(headlessToolAllowed('WebFetch', declared), false, 'and nothing leaks through: ' + String(declared));
    }
  });
});

// …and now the same decision through a REAL headless run, because the function being right is not the
// same as the responder sending its answer. This needs two things the fake did not have: a configurable
// tool name (its `permission` scenario hardcoded 'Bash' — the one tool that is denied unconditionally,
// so the ALLOW branch #15/#20 was fixed for could not be driven at all) and a record of the
// control_response it receives, since the verdict exists in no transcript.
describe('lib/engine — the permission responder actually sends that verdict', () => {
  const FAKE_CLAUDE = path.join(__dirname, '..', 'fake-claude.js').replace(/\\/g, '/');
  const CTRL_OUT = path.join(SBX.root, 'control.jsonl');
  const MCP_SKILL = (allowTools) => ({ name: 'perm-ui', manifest: { title: 'Perm', run: allowTools ? { allowTools } : {} } });

  // Swap in fake-claude for the duration of one run: lib/chat reads CLAUDE_UI_FAKE_BIN at spawn time,
  // and the suite above needs its own argv-printing fake back afterwards.
  async function askFor(tool, skill, opts) {
    const keep = { bin: process.env.CLAUDE_UI_FAKE_BIN, sc: process.env.FAKE_CLAUDE_SCENARIO, t: process.env.FAKE_CLAUDE_PERM_TOOL, out: process.env.FAKE_CLAUDE_CONTROL_OUT };
    Object.assign(process.env, {
      CLAUDE_UI_FAKE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_SCENARIO: 'permission',
      FAKE_CLAUDE_PERM_TOOL: tool, FAKE_CLAUDE_CONTROL_OUT: CTRL_OUT,
    });
    try { fs.rmSync(CTRL_OUT, { force: true }); } catch { /* */ }
    try {
      const rec = await runUiSkillHeadless(skill, {}, opts);
      const lines = fs.readFileSync(CTRL_OUT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.equal(lines.length, 1, 'exactly one control_response per asked tool');
      return { rec, answer: lines[0].response.response };
    } finally {
      for (const [k, v] of [['CLAUDE_UI_FAKE_BIN', keep.bin], ['FAKE_CLAUDE_SCENARIO', keep.sc], ['FAKE_CLAUDE_PERM_TOOL', keep.t], ['FAKE_CLAUDE_CONTROL_OUT', keep.out]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }

  it('an undeclared mcp tool is DENIED, and the reason names run.allowTools', async () => {
    const { rec, answer } = await askFor('mcp__x__y', MCP_SKILL(null), { allowWrites: true });
    assert.equal(answer.behavior, 'deny');
    assert.match(answer.message, /run\.allowTools/, 'the model only gets this string — it has to say what to do');
    assert.equal(rec.status, 'done', 'the run still finishes: a denied tool is not a crash');
  });

  it('the same tool declared as a prefix in the manifest is ALLOWED', async () => {
    const { rec, answer } = await askFor('mcp__x__y', MCP_SKILL(['mcp__x__*']), { allowWrites: true });
    assert.equal(answer.behavior, 'allow', 'the declared prefix is the whole point of run.allowTools');
    assert.equal(answer.message, undefined, 'an allow carries no denial reason');
    assert.equal(rec.status, 'done');
  });

  it('a read-only run denies it even when the manifest declares it', async () => {
    const { answer } = await askFor('mcp__x__y', MCP_SKILL(['mcp__x__*']), { allowWrites: false });
    assert.equal(answer.behavior, 'deny');
    assert.match(answer.message, /without write permission/, 'a different situation deserves a different reason');
  });

  it('a shell tool is denied even with a wildcard declaration — both gates, not just the argv one', async () => {
    const { answer } = await askFor('Bash', MCP_SKILL(['Bash', 'Bash*']), { allowWrites: true });
    assert.equal(answer.behavior, 'deny');
    assert.match(answer.message, /shell tools denied unattended/);
  });
});

// ---- FLOW-7: a schedule whose skill is gone must not vanish silently -------------------------------
// scheduleTick stamps `lastRun = now` and advances `nextRun` BEFORE runScheduled runs. runScheduled then
// returned without writing anything when the skill could not be found — so the card went on reading
// "zuletzt vor 2 Minuten (fertig)": the time of a run that never happened next to the status of the last
// one that did. Deleting or renaming a skill .md by hand is the normal end of a schedule's life.
describe('FLOW-7 — a missing skill is a STATUS, not a silent return', () => {
  const engine = require('../lib/engine');
  const SCHED = path.join(SBX.dataDir, 'ui-skill-schedules.json');
  const read = () => JSON.parse(fs.readFileSync(SCHED, 'utf8'));

  it('writes lastStatus "missing-skill" and does not leave the previous verdict standing', async () => {
    const now = Date.now();
    fs.writeFileSync(SCHED, JSON.stringify([{
      id: 'sc-gone', name: 'skill-that-was-deleted', enabled: true,
      timing: { type: 'interval', minutes: 60 }, nextRun: now + 3600000, lastRun: now, lastStatus: 'done',
    }]));
    await engine.runScheduled({ id: 'sc-gone', name: 'skill-that-was-deleted', values: {} });
    const s = read()[0];
    assert.equal(s.lastStatus, 'missing-skill', 'a run that could not start may not keep reading "done"');
    assert.ok(s.lastRun >= now, 'and the stamp belongs to THIS attempt');
    assert.ok(s.nextRun > Date.now(), 'nextRun is NOT put back to due — retrying a deleted skill just restamps the miss');
  });

  it('a schedule that was deleted meanwhile is left alone (no resurrection)', async () => {
    fs.writeFileSync(SCHED, JSON.stringify([]));
    await engine.runScheduled({ id: 'sc-vanished', name: 'skill-that-was-deleted', values: {} });
    assert.deepEqual(read(), [], 'writing a status for a schedule nobody kept would re-create it');
  });

  it('…and the schedule view has a LABEL for it — a status no view reads says "lief"', () => {
    const views = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views-uiskills.js'), 'utf8');
    const fn = views.slice(views.indexOf('function histStatusLabel('), views.indexOf('function histInputsSummary('));
    assert.match(fn, /'missing-skill'/, 'without this branch the row falls through to „lief"');
    const i18n = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'i18n.js'), 'utf8');
    assert.equal((i18n.match(/'views-uiskills\.skillFehlt'/g) || []).length, 2, 'de and en, both blocks');
  });
});

// ---- P3: a schedule's „Projekt (nur Etikett)" -------------------------------------------------------------
// The run's session is LABELLED on its init frame (lib/projects.js sessionIdHook) — and that is all: the spawn never
// sees the project, so argv carries no project block, no instructions, no start values. Through runScheduled, the
// way the 30 s tick and „Jetzt ausführen" start it: the old engine dropped sc.projectId on the way (red before P3).
describe('P3 — a scheduled run labels its session with the project, and nothing else', () => {
  const engine = require('../lib/engine');
  const P = require('../lib/projects');
  const MAP = path.join(SBX.dataDir, 'session-projects.json');
  const SID = '5e55a0e0-0000-4000-8000-00000000abcd';
  const INIT_FAKE = path.join(SBX.root, 'init-argv-result.js');
  fs.writeFileSync(INIT_FAKE, [
    'const fs = require("fs");',
    'if (process.argv[2] === "--help") { process.stdout.write("Options:\\n"); process.exit(0); }',
    'fs.writeFileSync(' + JSON.stringify(ARGV_OUT) + ', JSON.stringify(process.argv.slice(2)));',
    'process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: ' + JSON.stringify(SID) + ' }) + "\\n");',
    'let buf = "";',
    'process.stdin.on("data", (d) => { buf += d; if (buf.includes("\\n")) {',
    '  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }) + "\\n");',
    '  process.exit(0);',
    '} });',
  ].join('\n') + '\n');
  const CMDS = path.join(SBX.claudeDir, 'commands');
  fs.mkdirSync(CMDS, { recursive: true });
  fs.writeFileSync(path.join(CMDS, 'lbl-ui.md'), '---\ndescription: d\n---\n\n# Etikett\n\n```ui-skill\n' + JSON.stringify({ title: 'Etikett', prompt: 'Sag ok' }) + '\n```\n');

  it('sc.projectId → the init frame\'s session id is labelled; argv has no „## Projekt"', async () => {
    const proj = (await P.upsertProject({ name: 'Nachtlauf', instructions: 'GEHEIME-PROJEKTREGEL' }, { exists: async () => true, mcpNames: async () => [] })).project;
    assert.ok(proj, 'premise: a project');
    const keep = process.env.CLAUDE_UI_FAKE_BIN;
    process.env.CLAUDE_UI_FAKE_BIN = INIT_FAKE.replace(/\\/g, '/');
    try {
      try { fs.rmSync(ARGV_OUT, { force: true }); } catch { /* */ }
      await engine.runScheduled({ id: 'sc-label', name: 'lbl-ui', values: {}, projectId: proj.id });
    } finally { process.env.CLAUDE_UI_FAKE_BIN = keep; }
    let map = {};
    for (let i = 0; i < 50; i++) { try { map = JSON.parse(fs.readFileSync(MAP, 'utf8')); } catch { /* not yet */ } if (map[SID]) break; await new Promise((r) => setTimeout(r, 40)); }
    assert.equal(map[SID], proj.id, 'the run\'s session is not labelled: ' + JSON.stringify(map));
    const argv = JSON.parse(fs.readFileSync(ARGV_OUT, 'utf8'));
    const all = argv.join('\n');
    assert.doesNotMatch(all, /## Projekt/, 'a headless run got a project block');
    assert.doesNotMatch(all, /GEHEIME-PROJEKTREGEL/, 'a headless run got the project instructions');
  });
});
