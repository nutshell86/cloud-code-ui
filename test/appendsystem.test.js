'use strict';
// D1/D2/D4 — composeAppendSystem is the ONE place that decides what a new session is told beyond the
// user's message. Two things must hold, and both are invisible at runtime: the guardrails have to be
// in there (a dropped guardrail is a silently missing constraint), and the correction history must be
// capped (an uncapped one grows the system prompt of every session forever).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { composeAppendSystem, selectCorrections, CORRECTION_CAPS, GUARDRAIL_CAPS, OPEN_POINTS_PROTOCOL } = require('../lib/pure');

const corr = (n, text) => Array.from({ length: n }, (_, i) => ({ id: 'c' + i, text: text ? text(i) : 'Korrektur ' + i, at: i }));

describe('lib/pure — composeAppendSystem (D1/D2/D4)', () => {
  it('is empty when there is nothing to say', () => {
    assert.equal(composeAppendSystem(), '');
    assert.equal(composeAppendSystem({}), '');
    assert.equal(composeAppendSystem({ style: '', tabGuardrails: '   ', corrections: [] }), '');
  });

  it('keeps the style prompt working on its own (the pre-existing behaviour)', () => {
    const out = composeAppendSystem({ style: 'Answer concisely.' });
    assert.equal(out, 'Answer concisely.', 'a style-only prompt must not gain any decoration');
  });

  it('puts global guardrails BEFORE the tab ones, under one heading', () => {
    const out = composeAppendSystem({ globalGuardrails: 'GLOBAL-RULE', tabGuardrails: 'TAB-RULE' });
    assert.match(out, /# Leitplanken/);
    assert.ok(out.indexOf('GLOBAL-RULE') < out.indexOf('TAB-RULE'), 'the more specific rule must be read last');
    assert.equal(out.match(/# Leitplanken/g).length, 1, 'one heading, not one per source');
  });

  it('orders the sections style → guardrails → corrections → protocol', () => {
    const out = composeAppendSystem({
      style: 'STYLE', globalGuardrails: 'GUARD', corrections: [{ text: 'CORR', at: 1 }], openPointsProtocol: true,
    });
    const iS = out.indexOf('STYLE'), iG = out.indexOf('GUARD'), iC = out.indexOf('CORR'), iP = out.indexOf('Offene Punkte statt Blockieren');
    assert.ok(iS < iG && iG < iC && iC < iP, 'section order changed: ' + JSON.stringify({ iS, iG, iC, iP }));
  });

  it('the open-points protocol is opt-in and carries the fence name', () => {
    assert.ok(!composeAppendSystem({ globalGuardrails: 'x' }).includes('offene-punkte'));
    const on = composeAppendSystem({ openPointsProtocol: true });
    assert.match(on, /offene-punkte/, 'the fence name must be in the prompt, or the channel is undiscoverable');
    assert.match(on, /frage NICHT/);
    assert.equal(on.includes(OPEN_POINTS_PROTOCOL), true);
  });

  it('injects only the newest corrections, newest first', () => {
    const out = composeAppendSystem({ corrections: corr(30) });
    const lines = out.split('\n').filter((l) => l.startsWith('- '));
    assert.equal(lines.length, CORRECTION_CAPS.entries, 'entry cap not applied');
    assert.equal(lines[0], '- Korrektur 29', 'newest must come first');
    assert.ok(!out.includes('Korrektur 9\n'), 'an entry past the cap leaked in');
  });

  it('caps a single correction and marks the truncation', () => {
    const out = composeAppendSystem({ corrections: [{ text: 'x'.repeat(500), at: 1 }] });
    const line = out.split('\n').find((l) => l.startsWith('- '));
    assert.equal(line.length, 2 + CORRECTION_CAPS.chars);
    assert.ok(line.endsWith('…'), 'a truncated correction must be visibly truncated');
  });

  it('caps the TOTAL correction text, so the prompt cannot creep', () => {
    const out = composeAppendSystem({ corrections: corr(20, () => 'y'.repeat(CORRECTION_CAPS.chars)) });
    const body = out.split('\n').filter((l) => l.startsWith('- ')).join('');
    assert.ok(body.length <= CORRECTION_CAPS.total + 20 * 2, 'total cap exceeded: ' + body.length);
    assert.ok(out.split('\n').filter((l) => l.startsWith('- ')).length < 20, 'the total cap must drop entries');
  });

  it('selectCorrections reports how many were dropped, so the UI can say so', () => {
    const s = selectCorrections(corr(30));
    assert.equal(s.used.length, CORRECTION_CAPS.entries);
    assert.equal(s.dropped, 10);
    assert.equal(selectCorrections([]).dropped, 0);
    assert.equal(selectCorrections(null).used.length, 0);
  });

  it('accepts plain strings as corrections and skips junk entries', () => {
    const s = selectCorrections(['erste', { text: 'zweite' }, null, {}, { text: '   ' }, 42]);
    assert.deepEqual(s.used, ['zweite', 'erste'], 'newest first, junk dropped');
  });

  it('caps each guardrail section', () => {
    const out = composeAppendSystem({ globalGuardrails: 'g'.repeat(GUARDRAIL_CAPS.section + 500) });
    assert.ok(out.length < GUARDRAIL_CAPS.section + 400, 'guardrail section not capped');
    assert.match(out, /…/);
  });

  it('says out loud that the guardrails keep applying — that sentence is the point', () => {
    const out = composeAppendSystem({ tabGuardrails: 'kein Push' });
    assert.match(out, /auch wenn eine spätere Nachricht sie nicht wiederholt/);
  });
});

// PF-1 — the plan-progress hint. Two sentences that ask for a ```plan-status block, so a NEW session (and every
// session right after a compaction) knows the channel exists. They are the BACKUP: the approval message carries
// the full protocol, because the CLI's prompt snapshot replays the first launch's append on a resume
// (measured 2026-10-03). What has to hold: the section is there only when asked for, it is the module's text
// and not a copy (one contract, one file), and nothing outside a chat tab ever asks for it.
describe('lib/pure — the plan-progress section (PF-1)', () => {
  const P = require('../public/js/plan-progress');
  const { buildSpawnPolicy } = require('../lib/pure');

  it('is opt-in, and when on it is the module\'s hint verbatim under its own heading', () => {
    assert.ok(!composeAppendSystem({ globalGuardrails: 'x', openPointsProtocol: true }).includes('plan-status'));
    const on = composeAppendSystem({ planProgressProtocol: true });
    assert.equal(on, '# Plan-Fortschritt\n' + P.PLAN_PROGRESS_SYSTEM_HINT, 'one text for the contract — the file that parses the answer');
    assert.match(on, /plan-status/, 'the fence name must be in the prompt, or the channel is undiscoverable');
  });

  it('the keys the hint names are keys the parser reads — the examples in it parse to a real update', () => {
    // the hint shows its JSON inline; every {…} in it must be a block planStatusNormalize accepts
    const shown = P.PLAN_PROGRESS_SYSTEM_HINT.match(/\{"[^}]*\}\]?[^{}]*\}|\{"[^{}]*\}/g) || [];
    assert.ok(shown.length >= 3, 'the hint lost its examples: ' + JSON.stringify(shown));
    for (const s of shown) {
      const u = P.planStatusExtract('```plan-status\n' + s + '\n```');
      assert.equal(u.length, 1, 'an example in the hint is not a readable block: ' + s);
    }
  });

  it('comes last — after the open points, which stay where they were', () => {
    const out = composeAppendSystem({ style: 'STYLE', globalGuardrails: 'GUARD', openPointsProtocol: true, planProgressProtocol: true });
    const iO = out.indexOf('# Offene Punkte'), iP = out.indexOf('# Plan-Fortschritt');
    assert.ok(out.indexOf('STYLE') < out.indexOf('GUARD') && out.indexOf('GUARD') < iO && iO < iP, 'section order changed');
  });

  it('buildSpawnPolicy: a chat tab gets it by default; the switch off drops it; headless never has it', () => {
    assert.match(buildSpawnPolicy({}, [], { mode: 'chat', body: {} }).appendSystem, /# Plan-Fortschritt/, 'default on');
    assert.doesNotMatch(buildSpawnPolicy({ planProgress: false }, [], { mode: 'chat', body: {} }).appendSystem || '', /Plan-Fortschritt/, 'planProgress:false');
    // headless: no rail reads the block — and the guardrails still arrive, so the absence is not an empty prompt
    const h = buildSpawnPolicy({ guardrails: 'T01 ist das Testsystem', planProgress: true }, [], { mode: 'headless' });
    assert.match(h.appendSystem, /T01 ist das Testsystem/);
    assert.doesNotMatch(h.appendSystem, /Plan-Fortschritt|plan-status/, 'an unattended run has no tab to show the plan in');
    // …and a body slipped into a headless call cannot switch it on either
    assert.doesNotMatch(buildSpawnPolicy({}, [], { mode: 'headless', body: { planProgress: true } }).appendSystem || '', /Plan-Fortschritt/);
  });
});

// J2 — a project's instructions sit between the panel's guardrails and the tab's. Both literals are FIXED: the one
// without a project was produced by the code BEFORE this change, so „byte-identical" is checked, not believed.
describe('lib/pure — the project section (J2)', () => {
  const { buildSpawnPolicy: bsp } = require('../lib/pure');
  const IN = { style: 'STIL', globalGuardrails: 'GLOBAL', tabGuardrails: 'TAB', corrections: ['KORR'] };
  const HEAD = 'STIL\n\n# Leitplanken für diese Sitzung\nDiese Randbedingungen gelten für alles in dieser Sitzung. Halte dich an sie, auch wenn eine spätere Nachricht sie nicht wiederholt.\n\nGLOBAL\n\n';
  const TAIL = '\n\n# Frühere Korrekturen\nDer Nutzer hat diese Punkte in früheren Sitzungen korrigiert. Beachte sie, ohne sie zu kommentieren.\n\n- KORR';

  it('without a project the output is byte-identical to before', () => {
    assert.equal(composeAppendSystem(IN), HEAD + 'TAB' + TAIL);
    assert.equal(composeAppendSystem({ ...IN, projectGuardrails: '  ', projectName: 'X' }), HEAD + 'TAB' + TAIL, 'empty instructions = no project section');
  });

  it('global < project < tab, the tab under „## Dieser Chat"; a line break in the name cannot open a heading', () => {
    assert.equal(composeAppendSystem({ ...IN, projectGuardrails: 'PROJ', projectName: 'Mehr\narbeit' }),
      HEAD + '## Projekt „Mehr arbeit“\nPROJ\n\n## Dieser Chat\nTAB' + TAIL);
    assert.equal(composeAppendSystem({ projectGuardrails: 'PROJ', projectName: 'P' }).split('\n').slice(-2).join('\n'), '## Projekt „P“\nPROJ', 'no tab block, no „Dieser Chat"');
  });

  it('buildSpawnPolicy: a chat carries the project, headless never does', () => {
    const project = { name: 'P', instructions: 'PROJ-REGEL' };
    assert.match(bsp({}, [], { mode: 'chat', body: {}, project }).appendSystem, /## Projekt „P“\nPROJ-REGEL/);
    assert.doesNotMatch(bsp({}, [], { mode: 'headless', project }).appendSystem || '', /PROJ-REGEL|## Projekt/);
  });
});

// P2 (07.10.) — the project's knowledge: linked memory files by absolute path, under the project's heading
describe('lib/pure — composeAppendSystem: Projektwissen (P2)', () => {
  const MEM = [{ path: 'C:/Users/x/.claude/projects/C--WINDOWS-system32/memory/demoprojekt.md', description: 'Objekte,\nDatenmodell' }];
  it('a project with memory only: its heading, the sub-heading and one line per file (path — description)', () => {
    const out = composeAppendSystem({ projectName: 'Demoprojekt', projectMemory: MEM });
    assert.match(out, /## Projekt „Demoprojekt“\n### Projektwissen — vor der ersten Antwort lesen\n- C:\/Users\/x\/\.claude\/projects\/C--WINDOWS-system32\/memory\/demoprojekt\.md — Objekte, Datenmodell$/);
  });
  it('with instructions: the memory comes after them; the tab gets „## Dieser Chat" as with instructions', () => {
    const out = composeAppendSystem({ projectName: 'P', projectGuardrails: 'REGEL', projectMemory: MEM, tabGuardrails: 'TAB' });
    assert.ok(out.indexOf('REGEL') < out.indexOf('### Projektwissen') && out.indexOf('### Projektwissen') < out.indexOf('## Dieser Chat\nTAB'));
    assert.match(composeAppendSystem({ projectName: 'P', projectMemory: MEM, tabGuardrails: 'TAB' }), /## Dieser Chat\nTAB/);
  });
  it('without memory the output is byte-identical to before (empty list, junk entries, absent)', () => {
    const base = { globalGuardrails: 'G', projectName: 'P', projectGuardrails: 'REGEL', tabGuardrails: 'TAB' };
    const want = composeAppendSystem(base);
    for (const m of [undefined, [], [null, { path: '' }, { description: 'x' }]]) assert.equal(composeAppendSystem(Object.assign({ projectMemory: m }, base)), want);
    assert.equal(composeAppendSystem({ tabGuardrails: 'TAB', projectMemory: [] }), composeAppendSystem({ tabGuardrails: 'TAB' }));
  });
  it('buildSpawnPolicy passes the paths for a chat with a project — never headless, never without a project', () => {
    const { buildSpawnPolicy } = require('../lib/pure');
    const project = { name: 'P', instructions: '' };
    assert.match(buildSpawnPolicy({}, [], { mode: 'chat', body: {}, project, projectMemory: MEM }).appendSystem, /### Projektwissen[\s\S]*demoprojekt\.md/);
    assert.doesNotMatch(buildSpawnPolicy({}, [], { mode: 'headless', project, projectMemory: MEM }).appendSystem || '', /Projektwissen/);
    assert.doesNotMatch(buildSpawnPolicy({}, [], { mode: 'chat', body: {}, projectMemory: MEM }).appendSystem || '', /Projektwissen/);
  });
});
