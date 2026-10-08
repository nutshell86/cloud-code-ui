'use strict';
// Plan progress (public/js/plan-progress.js) — the pure half of „where are we in the accepted plan".
// Four contracts, each one a promise the rail makes to the reader:
//   1. the PARSER only suggests, and says nothing rather than something wrong — a living plan (618 KB, emoji `##`,
//      272 `###`) yields the `###` of its CURRENT order that name themselves a step, and nothing when there are
//      none; the approval then asks the model for the list;
//   2. the plan-status block is MODEL-AUTHORED: aliases, type checks, caps, unknown IDs ignored and counted,
//      invalid JSON left readable in the text;
//   3. the status rules (erledigt only forward, offen re-opens, fertig never ticks off silently);
//   4. persistence and the resume FOLD agree with the live path — and survive what real transcripts do
//      (sidechains, compaction, lines the CLI writes twice with the same uuid).
// Every plan text and transcript line below is SYNTHETIC — shaped after the measured forms, no real content.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../public/js/plan-progress');
const {
  PLAN_CAPS, PLAN_PROGRESS_PROTOCOL, PLAN_PROGRESS_SYSTEM_HINT,
  planTitleOf, planStepsParse, planStepsFromMarkdown, planStepsNormalize, planFileName,
  planNew, planAccept, planSupersede, planUnaccept, planDismiss, planVisible, planChain, planOffer, planPromote,
  planStepsBlock, planStepsBlockParse, planAcceptMessage,
  planStatusExtract, planStatusStrip, planStatusNormalize, planStepRef, planCurrentStep,
  planApplyStatus, planCounts, planUnreported, planSig, planSave, planRestore, planAdopt, planCleanTitle,
  planFoldNew, planFoldLine, planFoldResult, planFromStatus,
} = P;

const status = (body) => '```plan-status\n' + body + '\n```';
const titles = (steps) => steps.map((s) => s.title);
const HEAD_DE = 'Plan genehmigt — der Plan-Modus ist beendet. Bitte setze den Plan jetzt um.';
const HEAD_EN = 'Plan approved — plan mode is over. Please implement the plan now.';
// A plan without ANY structure the parser could read — no heading below the title, no list, no bold lead. Since 07.10.
// the living plan yields a suggestion (its current order's `###`), so the „approved with an EMPTY block" cases use this.
const PROSE = '# Kleiner Auftrag\n\nEin Absatz, der sagt, was zu tun ist, ohne Gliederung.\n\nNoch ein Absatz mit Hintergrund.\n';
const SMALL = '# Plan: Testvorhaben\n\n## Kontext\nWarum.\n\n## Umsetzung\n### 1. Modul\nText\n### 2. Route\nText\n### 3. Tests\nText\n\n## Verifikation\n- node --test\n';
// An accepted plan with the three steps of SMALL, at a fixed clock.
const accepted = (md, id) => planAccept(planNew(id || 'toolu_A', md || SMALL, 'C:\\Users\\x\\.claude\\plans\\test-plan.md', 1000), null, 2000);

// The living plan, rebuilt SYNTHETICALLY from its measured structure: 78 `##` that carry emoji and dates (two
// say „AKTUELLER AUFTRAG"), 272 `###`, numbered lists, a „🎯 UMSETZUNGSPLAN …" status section with 9 `###`, a
// „🧭 PLAN „Paket 3 NEU"" section with 12 — and, like the real file, the ORIGINAL plan at the very bottom
// (`## Arbeitspakete` with 3 `###`), past 600 000 characters.
// `current` = the `###` of the FIRST section, the current order. Default: numbered sub-points that name no step
// (the shape the parser must answer with nothing). LIVING_CURRENT is the shape measured on 05.10.: the order
// mixes Context / Entscheidungen / Vorbedingungen / ERWEITERUNG with exactly two step headings.
const LIVING_CURRENT = ['Context', 'Entscheidungen (Stand 05.10.)', 'Vorbedingungen (vor Schritt 0)', 'Schritt 0 — Inventar (Testdaten, Rollen)',
  '➕ ERWEITERUNG — Druckansicht', '➕ ERWEITERUNG 2 — Mail an den Betriebsrat', 'Schritt 1–5 — Workflow (Antrag bis Freigabe)', 'Ergebnis (Bericht)', 'Verifikation (Abnahme)'];
function livingPlan(current) {
  const emo = ['🔬', '🐞', '📄', '🎬', '⭐⭐⭐', '✅', '🏁🏁', '📌', '🔑🔑🔑', '✅✅'];
  const filler = 'Befund und Stand in synthetischer Prosa, damit der Plan so lang wird wie das Original. '.repeat(25);
  const out = ['# Testvorhaben — Umsetzung nach Termin (synthetisch)', ''];
  let h2 = 0, h3 = 0;
  const sec = (head, n3, nOl, heads) => {
    h2++;
    out.push('## ' + head, '', filler);
    for (let i = 0; i < nOl; i++) out.push((i + 1) + '. Punkt ' + (i + 1) + ' dieses Abschnitts');
    for (let i = 0; i < n3; i++) { h3++; out.push('', '### ' + (heads ? heads[i] : (i + 1) + '. Unterpunkt ' + h3), filler); }
    out.push('');
  };
  sec('🔬 KOMPLETTER LAUF (Plan 03.10.2026) — AKTUELLER AUFTRAG', 9, 3, current);
  sec('🎯 UMSETZUNGSPLAN nach dem Abstimmungstermin (31.08.2026) — Stand', 9, 0);
  sec('🧭 PLAN „Paket 3 NEU" — Stunden einfrieren (Stand 29.09.2026)', 12, 5);
  for (let i = 0; h2 < 72; i++) sec(emo[i % emo.length] + ' TERMIN ' + (1 + (i % 28)) + '.09.2026 — Auswertung ' + i, i % 3 === 0 ? 0 : 3, i % 4);
  sec('🔬 ZWEITER LAUF — AKTUELLER AUFTRAG', 272 - h3 - 3, 2);
  sec('Context', 0, 0);
  sec('Entscheidungen', 0, 2);
  sec('Arbeitspakete', 3, 0);
  sec('Verifikation', 0, 4);
  sec('Offene Punkte', 0, 0);
  return { md: out.join('\n'), h2, h3 };
}

// ---- transcript line builders (the shapes measured in ~/.claude/projects/**/*.jsonl) ----
let UID = 0;
const ts = (n) => new Date(Date.UTC(2026, 9, 3, 8, 0, n)).toISOString();
const epm = (id, plan, o = {}) => ({ type: 'assistant', uuid: o.uuid || 'u' + (++UID), timestamp: ts(UID), isSidechain: !!o.side,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'ExitPlanMode', input: { plan, planFilePath: 'C:\\Users\\x\\.claude\\plans\\' + (o.slug || 'test-plan') + '.md' } }] } });
// the panel answers BOTH ways with behavior:'deny' + message, so the result is an is_error string (50 of 70)
const res = (id, text, o = {}) => ({ type: 'user', uuid: o.uuid || 'u' + (++UID), timestamp: ts(UID), isSidechain: !!o.side,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: o.isError !== false, content: o.array ? [{ type: 'text', text }] : text }] },
  toolUseResult: o.tur !== undefined ? o.tur : 'Error: ' + text });
const say = (text, o = {}) => ({ type: 'assistant', uuid: o.uuid || 'u' + (++UID), timestamp: ts(UID), isSidechain: !!o.side,
  message: { role: 'assistant', content: [{ type: 'text', text }] } });
const compact = (o = {}) => ({ type: 'system', subtype: 'compact_boundary', uuid: o.uuid || 'u' + (++UID), timestamp: ts(UID), isSidechain: !!o.side, content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 1 } });
// a typed (or panel-sent) user message — the panel sends text parts (lib/chat.js sendToChat), the CLI may store a string
const user = (text, o = {}) => ({ type: 'user', uuid: o.uuid || 'u' + (++UID), timestamp: ts(UID), isSidechain: !!o.side,
  ...(o.compact ? { isCompactSummary: true } : {}), ...(o.meta ? { isMeta: true } : {}),
  message: { role: 'user', content: o.str ? text : [{ type: 'text', text }] } });
const fold = (lines) => { const f = planFoldNew(); lines.forEach((l) => planFoldLine(f, l)); return planFoldResult(f); };
const panelAccept = (md, head) => planAcceptMessage(head || HEAD_DE, planNew('toolu_tmp', md, '', 0));
// what the CLI answers an ExitPlanMode called outside plan mode (the shape measured 05.10., text synthetic after the prefix)
const NO_PLAN_MODE = '<tool_use_error>You are not in plan mode. To enter plan mode, call EnterPlanMode first (synthetisch).</tool_use_error>';
const HEAD_START = 'Plan freigegeben — bitte jetzt umsetzen.';
const panelStart = (md, head) => P.planStartMessage(head || HEAD_START, planNew('toolu_tmp', md, '', 0));

describe('plan-progress — one file, two worlds (classic script AND require)', () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const JS = path.join(__dirname, '..', 'public', 'js');
  const SRC = fs.readFileSync(path.join(JS, 'plan-progress.js'), 'utf8');
  const topNames = (src) => [...src.matchAll(/^(?:function\s+([A-Za-z_$][\w$]*)|(?:var|let|const)\s+([A-Za-z_$][\w$]*))/gm)].map((m) => m[1] || m[2]);

  it('as a classic script (no `module`) its functions land in the global scope', () => {
    const ctx = vm.createContext({});
    vm.runInContext(SRC, ctx);
    for (const n of ['planStatusExtract', 'planApplyStatus', 'planFoldLine', 'planAcceptMessage', 'PLAN_PROGRESS_PROTOCOL',
      'planOrphan', 'planIsOrphan', 'planGateLost', 'planStartMessage', 'planStepsRequestMessage', 'planFromStatus', 'planStepMark']) {
      assert.notEqual(vm.runInContext('typeof ' + n, ctx), 'undefined', n);
    }
    assert.equal(vm.runInContext('planStepRef("Schritt 3")', ctx), 'S3');
  });

  it('none of its top-level names is declared by another script — classic scripts share ONE global scope', () => {
    const mine = new Set(topNames(SRC));
    assert.ok(mine.size > 40, 'the declaration scan found ' + mine.size);
    const clash = [];
    let others = 0;
    for (const f of fs.readdirSync(JS).filter((x) => x.endsWith('.js') && x !== 'plan-progress.js')) {
      for (const n of topNames(fs.readFileSync(path.join(JS, f), 'utf8'))) { others++; if (mine.has(n)) clash.push(f + ': ' + n); }
    }
    assert.ok(others > 500, 'the scan must actually have read the other scripts (' + others + ')');
    // views-uiskills.js has a `planSteps` of its own — the reason no export here is called that
    assert.deepEqual(clash, []);
  });
});

describe('plan-progress — the contract texts', () => {
  it('the protocol names every field the parser reads, in the language-fixed German form', () => {
    for (const k of ['plan-status', 'plan-schritte', '"schritte"', '"aktuell"', '"erledigt"', '"aktiv"', '"fertig"', '"uebersprungen"', '"offen"', 'höchstens 30', 'Kompaktierung', 'Werkzeugaufruf']) {
      assert.ok(PLAN_PROGRESS_PROTOCOL.includes(k), 'protocol lacks ' + k);
    }
    // it speaks OF a code block but contains none — a fence in it would be read back by the extractor
    assert.ok(!PLAN_PROGRESS_PROTOCOL.includes('```'));
    // the plan's own name, at the block's top level and marked optional — a model that leaves it out is not wrong
    assert.match(PLAN_PROGRESS_PROTOCOL, /\{"titel":"…","schritte":\[/);
    assert.match(PLAN_PROGRESS_PROTOCOL, /"titel" vorn = Name des Plans, optional/);
  });

  it('every JSON example in the protocol and the hint is understood by our own normaliser', () => {
    // the examples ARE the contract — an example this file cannot read would teach the model a dead shape
    const examples = (s) => {
      const out = []; let depth = 0, start = -1;
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '{') { if (!depth) start = i; depth++; }
        else if (s[i] === '}' && depth) { depth--; if (!depth) out.push(s.slice(start, i + 1)); }
      }
      return out;
    };
    const all = examples(PLAN_PROGRESS_PROTOCOL).concat(examples(PLAN_PROGRESS_SYSTEM_HINT));
    assert.ok(all.length >= 5, 'found ' + all.length + ' examples');
    for (const ex of all) {
      const json = ex.replace(/"…"/g, '"x"').replace(/\[…\]/g, '["S1"]');
      assert.ok(planStatusNormalize(JSON.parse(json)), 'not understood: ' + ex);
    }
  });

  it('the system hint is short (two sentences for composeAppendSystem) and names the channel', () => {
    assert.ok(PLAN_PROGRESS_SYSTEM_HINT.length < 600, PLAN_PROGRESS_SYSTEM_HINT.length + ' chars');
    for (const k of ['plan-status', '"schritte"', '"aktuell"', '"fertig"', 'Kompaktierung']) assert.ok(PLAN_PROGRESS_SYSTEM_HINT.includes(k), k);
    assert.ok(!PLAN_PROGRESS_SYSTEM_HINT.includes('```'));
  });

  it('the system hint covers a plan started WITHOUT the approval button, and shows the plan\'s name in its first example', () => {
    // the 05.10. case: ExitPlanMode refused outside plan mode, „plan starten" typed — no approval, so no protocol
    assert.match(PLAN_PROGRESS_SYSTEM_HINT, /auch ohne Freigabe gestartet/);
    assert.doesNotMatch(PLAN_PROGRESS_SYSTEM_HINT, /^Nach einer Plan-Freigabe/, 'it must not read as „only after an approval"');
    const first = planStatusExtract('```plan-status\n' + PLAN_PROGRESS_SYSTEM_HINT.match(/\{"titel"[^]*?"aktuell":"S1"\}/)[0] + '\n```');
    assert.equal(first.length, 1);
    assert.equal(first[0].titel, '…');
    assert.equal(first[0].schritte.length, 1);
  });

  it('PLAN_CAPS are the documented ceilings', () => {
    assert.deepEqual({ steps: PLAN_CAPS.steps, title: PLAN_CAPS.title, activeForm: PLAN_CAPS.activeForm, note: PLAN_CAPS.note, history: PLAN_CAPS.history, parse: PLAN_CAPS.parse },
      { steps: 30, title: 90, activeForm: 120, note: 200, history: 5, parse: 200000 });
  });
});

describe('plan-progress — planTitleOf', () => {
  it('first # heading, without a „Plan:" prefix and without markdown', () => {
    assert.equal(planTitleOf('# Plan: Plan-Fortschritt in der **Seitenleiste**\n\n## Kontext'), 'Plan-Fortschritt in der Seitenleiste');
    assert.equal(planTitleOf('# Umsetzungsplan — `Z_EXAMPLE` anpassen'), 'Z_EXAMPLE anpassen');
    assert.equal(planTitleOf('# Plan-Fortschritt im Panel'), 'Plan-Fortschritt im Panel', 'a compound is not a prefix');
  });
  it('a heading inside a code block is not the title; without any # the first line is', () => {
    assert.equal(planTitleOf('```md\n# kein Titel\n```\n# Echter Titel'), 'Echter Titel');
    assert.equal(planTitleOf('Nur ein Satz als Plan.\n\nMehr.'), 'Nur ein Satz als Plan.');
    assert.equal(planTitleOf(''), '');
    assert.equal(planTitleOf(null), '');
    assert.equal(planTitleOf({}), '');
  });
  it('is capped', () => {
    const t = planTitleOf('# ' + 'x'.repeat(300));
    assert.equal(t.length, PLAN_CAPS.title);
    assert.ok(t.endsWith('…'));
  });
});

describe('plan-progress — the parser (a suggestion, three ways, otherwise nothing)', () => {
  it('way 1: ### inside a work section, enumerators stripped, IDs S1…', () => {
    const r = planStepsParse(SMALL);
    assert.equal(r.how, 'h3-work');
    assert.deepEqual(r.steps, [{ id: 'S1', title: 'Modul', group: '' }, { id: 'S2', title: 'Route', group: '' }, { id: 'S3', title: 'Tests', group: '' }]);
    assert.deepEqual(planStepsFromMarkdown(SMALL), r.steps);
  });

  it('way 1 over two work packages (Paket F1 / F2) — named prefixes kept, groups set', () => {
    const md = '# X\n## Context\n### Hintergrund\n## Paket F1 — Aufgabenliste (eigener PR)\n### F1.0 · Check, zuerst\n### F1.1 · Modul\n### F1.2 · Verdrahtung\n'
      + '## Paket F2 — Nachzug\n### F2.1 · Preise\n### F2.2 · Einstellung\n## Verifikation (für beide)\n### Tests\n## Reihenfolge\n1. F1\n2. F2\n';
    const r = planStepsParse(md);
    assert.equal(r.how, 'h3-work');
    assert.deepEqual(titles(r.steps), ['F1.0 · Check, zuerst', 'F1.1 · Modul', 'F1.2 · Verdrahtung', 'F2.1 · Preise', 'F2.2 · Einstellung']);
    assert.deepEqual([...new Set(r.steps.map((s) => s.group))], ['Paket F1 — Aufgabenliste (eigener PR)', 'Paket F2 — Nachzug']);
  });

  it('way 1 recognises the work words as WHOLE words, after emoji or numbering — and nothing compound', () => {
    const one = (head) => planStepsParse('## ' + head + '\n### A eins\n### B zwei\n').how;
    for (const h of ['Umsetzung', '🛠 Umsetzung', '2. Umsetzung', 'Umsetzung A — Panel', 'Teil 1 — Kern', 'Teil A: Panel', 'Phase 2', 'Welle 1 — Fehler zuerst', 'Ablauf', 'Arbeitspakete', 'Implementation', 'Steps']) {
      assert.equal(one(h), 'h3-work', h);
    }
    // not a work section — so the ### fall to way 3 (whole document), which still finds these two
    for (const h of ['🎯 UMSETZUNGSPLAN nach dem Termin', 'Teilergebnis', 'Arbeitsweise für alle PRs', 'Ablaufdiagramm']) {
      assert.equal(one(h), 'h3-doc', h);
    }
  });

  it('way 1 skips blocked ### inside a work section (Kritische Dateien is not a step)', () => {
    const md = '## Umsetzung\n### Schritt 1 — Modul\n### Kritische Dateien\n### Schritt 2: Route\n### 3) Tests\n### Verifikation\n';
    assert.deepEqual(titles(planStepsFromMarkdown(md)), ['Modul', 'Route', 'Tests']);
  });

  it('way 2: a top-level numbered list in a work section (nested items do not count)', () => {
    const md = '# T\n\nEinleitung.\n\n## Schritte\n1. do a thing\n   1. nested detail\n2) do another\n3. and **the third** one\n\n## Verifikation\n1. not a step\n2. neither\n';
    const r = planStepsParse(md);
    assert.equal(r.how, 'list-work');
    assert.deepEqual(titles(r.steps), ['do a thing', 'do another', 'and the third one']);
  });

  it('way 3: ### in the whole document, minus the blocked headings and the ### under blocked ##', () => {
    const md = '# T\n## Kontext\n### Befund A\n### Befund B\n## Lösung\n### Erstens\n### Zweitens\n### Risiken\n## Verifikation\n### Tests laufen\n';
    const r = planStepsParse(md);
    assert.equal(r.how, 'h3-doc');
    assert.deepEqual(titles(r.steps), ['Erstens', 'Zweitens']);
  });

  // 07.10. (Julian: „jede Schreibweise … damit er immer im Panel die Punkte anzeigt") — this test pinned the opposite
  // decision. Bold paragraph leads in a work section ARE a way now (measured: both FLP plans and the function-test plan
  // write their steps exactly like this); bullets and a blocked section's list still are not.
  it('bold paragraph leads in a work section are steps (bold-work) — bullets and a blocked section are not; prose alone → []', () => {
    const md = '# T\n## Kontext\nText.\n## Umsetzung\n**Phase 0 — Vorbereitung.** Text.\n**Phase 1 — Bau.** Text.\n- ein Punkt\n- noch einer\n## Verifikation\n1. a\n2. b\n';
    const r = planStepsParse(md);
    assert.equal(r.how, 'bold-work');
    assert.deepEqual(titles(r.steps), ['Phase 0 — Vorbereitung', 'Phase 1 — Bau']);
    assert.deepEqual(planStepsParse(PROSE), { steps: [], how: '' });
    assert.deepEqual(planStepsFromMarkdown(''), []);
    assert.deepEqual(planStepsFromMarkdown(null), []);
    assert.deepEqual(planStepsFromMarkdown(42), []);
  });

  it('one step is no plan — and neither are more than 30 (no fallback to the ## level)', () => {
    assert.deepEqual(planStepsFromMarkdown('## Umsetzung\n### Nur einer\n'), []);
    const many = '## Umsetzung\n' + Array.from({ length: 31 }, (_, i) => '### Teil ' + i + ' bauen').join('\n') + '\n';
    assert.deepEqual(planStepsFromMarkdown(many), []);
    // …but a work section whose ### overflow can still carry a usable numbered list (way 2)
    const r = planStepsParse(many + '1. erst\n2. dann\n');
    assert.equal(r.how, 'list-work');
    assert.equal(planStepsFromMarkdown('## Umsetzung\n' + Array.from({ length: 30 }, (_, i) => '### Teil ' + i + ' bauen').join('\n')).length, 30);
  });

  it('headings inside code blocks are ignored — backticks, tildes, longer fences, and inline ```` ```x ```` in prose', () => {
    const md = '## Umsetzung\nProse mit ```` ```plan-schritte ```` im Satz.\n```md\n### fake eins\n### fake zwei\n```\n### echt eins\n~~~\n### fake drei\n~~~\n'
      + '````\n```\n### fake vier\n```\n````\n### echt zwei\n';
    assert.deepEqual(titles(planStepsFromMarkdown(md)), ['echt eins', 'echt zwei']);
  });

  it('titles lose their markdown but keep ABAP underscores, and are capped at 90', () => {
    const md = '## Umsetzung\n### 2. **Route** in `server.js` [verdrahten](http://example.invalid)\n### Z_EXAMPLE anpassen\n### ' + 'Lang '.repeat(40) + '\n';
    const st = planStepsFromMarkdown(md);
    assert.equal(st[0].title, 'Route in server.js verdrahten');
    assert.equal(st[1].title, 'Z_EXAMPLE anpassen');
    assert.equal(st[2].title.length, 90);
    assert.ok(st[2].title.endsWith('…'));
    assert.ok(st.every((s) => !s.title.includes('`')));
  });

  it('model-authored titles cannot stall the parse — the regex chain runs on a capped input (was 67 s for 100k `<`)', () => {
    const ms = (f) => { const t0 = process.hrtime.bigint(); f(); return Number(process.hrtime.bigint() - t0) / 1e6; };
    const lt = '<'.repeat(100000), link = '[a]('.repeat(25000), img = '![a]('.repeat(20000), blanks = 'a' + ' \t'.repeat(50000) + '#x';
    // a step list in a report — the browser's takePlanStatus and the server's fold both go through here
    const t1 = ms(() => planStatusExtract(status(JSON.stringify({ schritte: [lt, link, img, blanks] }))));
    assert.ok(t1 < 250, 'four hostile step titles: ' + t1.toFixed(1) + ' ms');
    // the plan's title (first `# ` line, else the first line) and its headings — per ExitPlanMode in the fold
    for (const [label, md] of [['# + links', '# ' + link], ['first line of <', lt], ['heading of blanks', '## Umsetzung\n### a' + ' \t'.repeat(50000) + 'x\n### b\n']]) {
      const t = ms(() => { planTitleOf(md); planStepsParse(md); });
      assert.ok(t < 250, label + ': ' + t.toFixed(1) + ' ms');
    }
    assert.deepEqual(titles(planStepsParse('## Umsetzung\n### a' + ' \t'.repeat(50000) + '\n### b\n').steps), ['a', 'b'], 'trailing blanks still go');
    // …and the cap sits far enough out that an ordinary long markdown link still comes out whole
    assert.equal(planCleanTitle('[Route](https://example.invalid/' + 'x'.repeat(600) + ') verdrahten'), 'Route verdrahten');
  });

  it('only the first 200 000 characters are read', () => {
    const md = '# T\n' + 'Prosa ohne Struktur.\n'.repeat(Math.ceil(PLAN_CAPS.parse / 21) + 10) + '## Umsetzung\n### A\n### B\n';
    assert.ok(md.length > PLAN_CAPS.parse);
    assert.deepEqual(planStepsFromMarkdown(md), []);
    assert.equal(planStepsFromMarkdown(md.slice(-30)).length, 2, 'the same section near the top is found');
  });

  // Rule 0 does not reach this fixture: its current order („— AKTUELLER AUFTRAG") holds `### 1. Unterpunkt …`, none of
  // which NAMES itself a step. Until 07.10. „nothing" was the answer; now the current order's `###` themselves are the
  // suggestion (h3-current-any) — still only the CURRENT order's, never the 272 of the whole file.
  it('a LIVING PLAN whose current order has no step headings (emoji ##, 272 ###, > 600 KB) → that order\'s ### (h3-current-any)', () => {
    const L = livingPlan();
    assert.equal(L.h2, 78);
    assert.equal(L.h3, 272);
    assert.ok(L.md.length > 600000, L.md.length + ' chars');
    const r = planStepsParse(L.md);
    assert.equal(r.how, 'h3-current-any');
    assert.deepEqual(titles(r.steps), Array.from({ length: 9 }, (_, i) => 'Unterpunkt ' + (i + 1)));
    // a plan with nothing to read → the approval ASKS for the list: an empty block plus the protocol
    const msg = planAcceptMessage(HEAD_DE, planNew('toolu_P', PROSE, '', 0));
    assert.ok(msg.includes('```plan-schritte\n[]\n```'));
    assert.ok(msg.includes(PLAN_PROGRESS_PROTOCOL));
    assert.ok(msg.includes('ist der Block leer, stelle die Liste selbst auf'));
  });

  it('the 200k cap is load-bearing for the living plan — its ORIGINAL plan sits at the bottom', () => {
    // Pinned on purpose: without the cap, the three `###` of the old `## Arbeitspakete` far below would
    // become the suggestion for today's work. Raising the cap is a decision, not a tweak.
    const L = livingPlan();
    const keep = PLAN_CAPS.parse;
    try {
      PLAN_CAPS.parse = 10 * 1000 * 1000;
      const r = planStepsParse(L.md);
      assert.equal(r.how, 'h3-work');
      assert.equal(r.steps.length, 3);
    } finally { PLAN_CAPS.parse = keep; }
  });
});

// Way 2b (07.10.): the plan of this very PR — its steps are `##` that NAME themselves („## S — …", „## P1 — …"), with
// bold paragraphs and bullets under them and no `###` anywhere. It got `plan-schritte []`, and the rail waited.
describe('plan-progress — parser way 2b: ## that name themselves a step (h2-named)', () => {
  const NAMED = '# Seitenleiste: eine Scrollleiste + Icons · Projekte: echter Mehrwert\n\n## Context\nBefund.\n- Zu 1: …\n\n'
    + '## Vorgehen\n- 6 PRs: …\n- Je PR baut ein Agent.\n\n'
    + '## S — Seitenleiste (`fix/seitenleiste-scroll-icons`, Worktree `ccui-wt-seitenleiste`)\n**S1 Eine Scrollleiste**\n- styles.css:334 …\n\n'
    + '## P1 — Übersichtlicher Aufbau, Aktionen, Chat-Name, Grundpflege (`feat/projekte-aufbau`)\n**Liste**\n- …\n\n'
    + '## P2 — Startaufträge + Projektwissen + Bericht (`feat/projekte-start-wissen`, Prüfer)\n- …\n\n'
    + '## P3 — Verlauf + Usage-Filter + Automationen (`feat/projekte-verlauf`, Prüfer)\n- …\n\n'
    + '## P4 — Repos & PRs (`feat/projekte-repos`)\n- …\n\n'
    + '## P5 — Projekte aus Sitzungen vorschlagen (`feat/projekte-entwuerfe`, Prüfer)\n- …\n\n'
    + '## Verifikation\n- Je PR einmal `node verify.js`.\n';
  it('the measured plan → its six named sections, prefix kept, Context / Vorgehen / Verifikation left out', () => {
    const r = planStepsParse(NAMED);
    assert.equal(r.how, 'h2-named');
    assert.deepEqual(r.steps.map((s) => s.id), ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
    assert.deepEqual(titles(r.steps).map((t) => t.split(' (')[0]), ['S — Seitenleiste', 'P1 — Übersichtlicher Aufbau, Aktionen, Chat-Name, Grundpflege',
      'P2 — Startaufträge + Projektwissen + Bericht', 'P3 — Verlauf + Usage-Filter + Automationen', 'P4 — Repos & PRs', 'P5 — Projekte aus Sitzungen vorschlagen']);
    assert.ok(r.steps.every((s) => s.group === '' && !s.title.includes('`')));
    // …and that is what the approval now hands the model instead of an empty block
    assert.deepEqual(titles(planStepsBlockParse(planAcceptMessage(HEAD_DE, planNew('toolu_N', NAMED, '', 0)))), titles(r.steps));
  });
  it('step words with a letter or number, PR-n, „## 1. …" — but not the work section, a blocked one or a lower-case word', () => {
    const one = (heads) => planStepsParse('# P\n' + heads.map((h) => '## ' + h + '\nText.\n').join(''));
    assert.deepEqual(titles(one(['Teil A — Backend', 'Teil B: Frontend', 'Stufe 2 Abnahme', 'Welle 1 — Fehler', 'PR-2 · Doku']).steps),
      ['Teil A — Backend', 'Teil B: Frontend', 'Stufe 2 Abnahme', 'Welle 1 — Fehler', 'PR-2 · Doku']);
    assert.deepEqual(titles(one(['Kontext', '1. Modul', '2. Route', '3. Umsetzung', 'A — Kontext', 'Verifikation']).steps), ['1. Modul', '2. Route']);
    assert.notEqual(one(['Teil Ablauf', 'so - nicht', 'Phase Eins', 'Umsetzung']).how, 'h2-named'); // the last resort (h2-any) may list them
    assert.equal(one(['S — allein', 'Kontext']).how, '', 'one named section is no plan');
    // a bare acronym is a topic, not a step ID — only one capital, or capitals WITH a number
    assert.notEqual(one(['API: Route', 'UI — Liste', 'DB: Schema']).how, 'h2-named');
    assert.deepEqual(titles(one(['AB12 — eins', 'AB13 — zwei']).steps), ['AB12 — eins', 'AB13 — zwei']);
  });
  it('„## Commit n — …" are steps (the measured plan of PR #115), „## Commits" and „## Commit-Message" are not', () => {
    // the headings of ~/.claude/plans/hier-sind-ein-paar-cozy-flask.md, as approved on 07.10. — it got `plan-schritte []`
    const PR115 = '# Panel-Komfort: Statuszeile ruhig + Sergejs drei Vorschläge\n\n## Kontext\nText.\n\n---\n\n'
      + '## Commit 1 — Statuszeile: Dropdowns in Zeile 2, kein Springen\n- …\n\n'
      + '## Commit 2 — Spracheingabe: an der Cursorposition einfügen, Tippen bleibt erhalten\n- …\n\n'
      + '## Commit 3 — Linke Navigation per Knopf einklappen\n- …\n\n'
      + '## Commit 4 — Textgröße: Browser-Zoom auffindbar machen\n- …\n\n---\n\n'
      + '## Dateien\n- …\n\n## Tests (neu, im bestehenden `node --test`-Stil)\n- …\n\n## Prüfung\n1. …\n';
    const r = planStepsParse(PR115);
    assert.equal(r.how, 'h2-named');
    assert.deepEqual(titles(r.steps), ['Commit 1 — Statuszeile: Dropdowns in Zeile 2, kein Springen',
      'Commit 2 — Spracheingabe: an der Cursorposition einfügen, Tippen bleibt erhalten',
      'Commit 3 — Linke Navigation per Knopf einklappen', 'Commit 4 — Textgröße: Browser-Zoom auffindbar machen']);
    // …so the approval hands the model these four instead of an empty block
    assert.equal(planStepsBlockParse(planAcceptMessage(HEAD_DE, planNew('toolu_C', PR115, '', 0))).length, 4);
    const one = (heads) => planStepsParse('# P\n' + heads.map((h) => '## ' + h + '\nText.\n').join(''));
    assert.notEqual(one(['Commits', 'Commit-Message', 'Kontext']).how, 'h2-named');
    assert.deepEqual(titles(one(['Commit 1: eins', 'Commits', 'Commit 2: zwei']).steps), ['Commit 1: eins', 'Commit 2: zwei']);
  });
  it('07.10. — every notation measured in the 82 plans of all transcripts yields its steps', () => {
    const ws = (md) => { const r = planStepsParse(md); return [r.how, titles(r.steps)]; };
    // „## 1 · Nachleuchten" / „## 0 · Aufräumen (zuerst)" — a number with a middle dot, dash or colon
    assert.deepEqual(ws('# T\n## Context\nx\n## 1 · Nachleuchten\nx\n## 2 · Rail: Badge\nx\n## 3 · Detailansicht\nx\n## Verifikation\nx\n'),
      ['h2-named', ['1 · Nachleuchten', '2 · Rail: Badge', '3 · Detailansicht']]);
    assert.deepEqual(ws('# T\n## 0 · Aufräumen (zuerst)\nx\n## 1 — Fehler in PR #53\nx\n## 2: Kleinpaket\nx\n## 3 · Kontext\nx\n')[1],
      ['0 · Aufräumen (zuerst)', '1 — Fehler in PR #53', '2: Kleinpaket'], 'a numbered Kontext is still Kontext');
    // „## Aktion 1 — …", „## Block 2 — …", „## Etappe 3 — …"
    assert.deepEqual(ws('# T\n## Context\nx\n## Aktion 1 — Kundenreport als PDF\nx\n## Aktion 2 — Interne Findings\nx\n## Verifikation\nx\n'),
      ['h2-named', ['Aktion 1 — Kundenreport als PDF', 'Aktion 2 — Interne Findings']]);
    // „## Aktionen (nach Freigabe)" + a numbered list
    assert.deepEqual(ws('# T\n## Context\nx\n## Aktionen (nach Freigabe)\n1. **todos.md** — ergänzen\n2. **dashboard-data.js** — spiegeln\n3. **Memory** — schärfen\n## Verifikation\nx\n'),
      ['list-work', ['todos.md — ergänzen', 'dashboard-data.js — spiegeln', 'Memory — schärfen']]);
    // „## Etappen" / „## Ablauf" / „## Umsetzung" + bold paragraph leads; a label with a colon is no step
    assert.deepEqual(ws('# T\n## Etappen\n**E1 — Lesen (Fundament).** Text.\n**Hinweis:** nur ein Label\n**E2 — Delta-Semantik.** Text.\n**E3 — Apply.** Text.\n'),
      ['bold-work', ['E1 — Lesen (Fundament)', 'E2 — Delta-Semantik', 'E3 — Apply']]);
    // a living plan whose current order has „### Block n — …" (rule 0, the step word „Block")
    assert.deepEqual(ws('# M\n## 🧭 GESAMMELTER PLAN 05.10.\n### Context\nx\n### Block 1 — Bericht\nx\n### Block 2 — SAP-Schreibweg\nx\n## Alt\n### a\n### b\n'),
      ['h3-current', ['Block 1 — Bericht', 'Block 2 — SAP-Schreibweg']]);
    // bold leads that NAME a step, outside any work section
    assert.deepEqual(ws('# T\n## Zu erledigen heute\n**Phase 1 — MCP-Seite.** a\nText\n**Phase 2 — die restlichen Views.** b\n'),
      ['bold-named', ['Phase 1 — MCP-Seite', 'Phase 2 — die restlichen Views']]);
    // the first numbered list under any heading that is not blocked
    assert.deepEqual(ws('# T\n## Context\n1. kein\n2. Schritt\n## Was der Helfer bei jedem Lauf tut\n1. **Todos laden** aus todos.md\n2. **Board-Signale ableiten**\n'),
      ['list-any', ['Todos laden aus todos.md', 'Board-Signale ableiten']]);
    // the last resort: the headings themselves
    assert.deepEqual(ws('# T\n## Kontext\nx\n## Kunde informieren\nx\n## Ticket schließen\nx\n'), ['h2-any', ['Kunde informieren', 'Ticket schließen']]);
  });
  it('comes after ways 0–2 and before way 3 — a ### step list inside a work section still wins, loose ### do not', () => {
    assert.equal(planStepsParse('## P1 — eins\n## P2 — zwei\n## Umsetzung\n### A\n### B\n').how, 'h3-work');
    // decided: `## Schritt n` with `###` under them is now the `##` list (was h3-doc) — the `##` say what the steps are
    const r = planStepsParse('# P\n## Kontext\n## Schritt 1 — Modul\n### Datei a\n### Datei b\n## Schritt 2 — Route\n### Datei c\n');
    assert.equal(r.how, 'h2-named');
    assert.deepEqual(titles(r.steps), ['Schritt 1 — Modul', 'Schritt 2 — Route']);
  });
});

describe('plan-progress — parser rule 0: the CURRENT order of a living plan', () => {
  it('the living plan as measured on 05.10. (AKTUELLER AUFTRAG first, 78 ##, 272 ###, > 600 KB) → exactly its two step headings', () => {
    const L = livingPlan(LIVING_CURRENT);
    assert.equal(L.h2, 78);
    assert.equal(L.h3, 272);
    assert.ok(L.md.length > 600000, L.md.length + ' chars');
    const r = planStepsParse(L.md);
    assert.equal(r.how, 'h3-current');
    // Context / Entscheidungen / Vorbedingungen (vor Schritt 0) / ERWEITERUNG / Ergebnis / Verifikation are not steps;
    // the author's „Schritt 0" and „Schritt 1–5" stay in the title — they are not the rail's S1 / S2
    assert.deepEqual(r.steps, [
      { id: 'S1', title: 'Schritt 0 — Inventar (Testdaten, Rollen)', group: '' },
      { id: 'S2', title: 'Schritt 1–5 — Workflow (Antrag bis Freigabe)', group: '' },
    ]);
    // …and that is what the approval (or ▶ Plan starten) shows the model
    const back = planStepsBlockParse(planAcceptMessage(HEAD_DE, planNew('toolu_L', L.md, '', 0)));
    assert.deepEqual(titles(back), titles(r.steps));
  });

  it('rule 0 wins even with the whole file read — the current order beats the original plan at the bottom', () => {
    const L = livingPlan(LIVING_CURRENT);
    const keep = PLAN_CAPS.parse;
    try {
      PLAN_CAPS.parse = 10 * 1000 * 1000;
      assert.equal(planStepsParse(L.md).how, 'h3-current');
    } finally { PLAN_CAPS.parse = keep; }
  });

  it('a step heading is recognised behind emoji and markdown, by its own word and number', () => {
    const md = '# P\n## 🔬 Lauf — AKTUELLER AUFTRAG\n### ✅ **Schritt 2** — Bau\n### 🔧 Phase 1: Vorbereitung\n### PR-3 · Route\n### PR 4 — Doku\n'
      + '### Step 5 — Tests\n### Teil 6 Abnahme\n### Paket 7 – Rollout\n'
      + '### Vorbedingungen (vor Schritt 0)\n### Schritte im Überblick\n### Teilergebnis 2\n### ➕ ERWEITERUNG 2\n### Phase A\n### Stepper 3\n';
    const r = planStepsParse(md);
    assert.equal(r.how, 'h3-current');
    assert.deepEqual(titles(r.steps), ['Schritt 2 — Bau', 'Phase 1: Vorbereitung', 'PR-3 · Route', 'PR 4 — Doku', 'Step 5 — Tests', 'Teil 6 Abnahme', 'Paket 7 – Rollout']);
  });

  it('only the FIRST ## or one that says „aktuell"/„current" — never a blocked one, and „Concurrent" is not „current"', () => {
    // the current order further down, after a context section that is the first ##
    const down = planStepsParse('# P\n## Context\n### Hintergrund\n## Lauf vom 05.10. — current order\n### Step 1 — eins\n### Step 2 — zwei\n## Verifikation\n### Tests\n');
    assert.equal(down.how, 'h3-current');
    assert.deepEqual(titles(down.steps), ['Step 1 — eins', 'Step 2 — zwei']);
    // a plain ## further down is no current order: way 3 takes it, with its enumerators stripped as before
    const plain = planStepsParse('# P\n## Context\n### Hintergrund\n## Lösung\n### Schritt 1 — eins\n### Schritt 2 — zwei\n');
    assert.equal(plain.how, 'h3-doc');
    assert.deepEqual(titles(plain.steps), ['eins', 'zwei']);
    const conc = planStepsParse('# P\n## Kontext\nText.\n## Concurrent writes\n### Schritt 1 — eins\n### Schritt 2 — zwei\n');
    assert.equal(conc.how, 'h3-doc', '„Concurrent" contains „current" but does not say it');
    // a blocked first ## describes the past: its „Phase 1/2" are not today's steps
    const blocked = planStepsParse('# P\n## Kontext\n### Phase 1 — früher\n### Phase 2 — früher\n## Umsetzung\n### A\n### B\n');
    assert.equal(blocked.how, 'h3-work');
    assert.deepEqual(titles(blocked.steps), ['A', 'B']);
  });

  it('a WORK section keeps way 1 (whole section, enumerators stripped); rule 0 is its fallback when way 1 overflows', () => {
    // way 1 reads all of „Umsetzung": the „3) Tests" without a step word belongs to it, too (the existing contract)
    const w = planStepsParse('## Umsetzung — aktueller Stand\n### Schritt 1 — Modul\n### Kritische Dateien\n### Schritt 2: Route\n### 3) Tests\n');
    assert.equal(w.how, 'h3-work');
    assert.deepEqual(titles(w.steps), ['Modul', 'Route', 'Tests']);
    // …but with 31+ `###` across the work sections way 1 says nothing, and the current order still does
    const more = Array.from({ length: 30 }, (_, i) => '## Teil ' + (i + 2) + ' — früher\n### Punkt ' + i + '\n').join('');
    const r = planStepsParse('## Umsetzung — aktueller Stand\n### Schritt 1 — Modul\n### Schritt 2 — Route\n' + more);
    assert.equal(r.how, 'h3-current');
    assert.deepEqual(titles(r.steps), ['Schritt 1 — Modul', 'Schritt 2 — Route']);
  });

  it('2…30 step headings, as for every way — one is no plan, 31 are no suggestion', () => {
    const head = '# P\n## 🔬 AKTUELLER AUFTRAG\n';
    assert.equal(planStepsParse(head + '### Schritt 1 — allein\n### Context\n').how, '');
    const many = (n) => head + Array.from({ length: n }, (_, i) => '### Schritt ' + i + ' — x' + i).join('\n') + '\n';
    assert.equal(planStepsParse(many(30)).steps.length, 30);
    assert.equal(planStepsParse(many(30)).how, 'h3-current');
    assert.notEqual(planStepsParse(many(31)).how, 'h3-current');
  });
});

describe('plan-progress — planStepRef', () => {
  it('reads every way of writing „step 3"', () => {
    for (const v of [3, '3', 'S3', 's3', 'S03', 'Schritt 3', 'schritt3', 'Step 3', 'step #3', '#3', '3.', 'S3 · Route', 'S3: Route']) {
      assert.equal(planStepRef(v), 'S3', JSON.stringify(v));
    }
  });
  it('keeps an ID of the model\'s own shape (upper-cased), refuses everything else', () => {
    assert.equal(planStepRef('F1.1'), 'F1.1');
    assert.equal(planStepRef('a2'), 'A2');
    for (const v of [0, -1, 3.5, NaN, Infinity, '', '   ', null, undefined, {}, [], true, 'S0', 'S1000', '3 4', 'x'.repeat(13), 'zwei Wörter']) {
      assert.equal(planStepRef(v), '', JSON.stringify(v));
    }
  });
  it('with a plan: the ID must exist; an EXACT title resolves; a near miss does not', () => {
    const p = accepted();
    assert.equal(planStepRef('S2', p), 'S2');
    assert.equal(planStepRef('S9', p), '');
    assert.equal(planStepRef('route', p), 'S2');
    assert.equal(planStepRef('  ROUTE! ', p), 'S2');
    assert.equal(planStepRef('Rout', p), '');
    assert.equal(planStepRef('Route verdrahten', p), '');
  });
});

describe('plan-progress — the plan-status block (untrusted input)', () => {
  it('reads the documented shapes', () => {
    assert.deepEqual(planStatusExtract(status('{"schritte":[{"id":"S1","titel":"Modul"},{"id":"S2","titel":"Route"}],"aktuell":"S1"}')),
      [{ schritte: [{ id: 'S1', title: 'Modul', group: '' }, { id: 'S2', title: 'Route', group: '' }], aktuell: 'S1' }]);
    assert.deepEqual(planStatusExtract('Text.\n\n' + status('{"aktuell":"S3","erledigt":["S1","S2"],"aktiv":"Verdrahte die Route"}')),
      [{ aktuell: 'S3', erledigt: ['S1', 'S2'], aktiv: 'Verdrahte die Route' }]);
    assert.deepEqual(planStatusExtract(status('{"fertig":true}')), [{ fertig: true }]);
  });

  it('accepts the de/en aliases a cooperative model might write', () => {
    assert.deepEqual(planStatusNormalize({ current: 2, done: ['S1'], skipped: 'S4', reopen: ['S5'], activeForm: 'tippe', note: 'n', finished: true }),
      { aktuell: '2', erledigt: ['S1'], uebersprungen: ['S4'], offen: ['S5'], aktiv: 'tippe', notiz: 'n', fertig: true });
    assert.deepEqual(planStatusNormalize({ 'übersprungen': ['S2'], steps: ['nur Titel'] }),
      { schritte: [{ id: 'S1', title: 'nur Titel', group: '' }], uebersprungen: ['S2'] });
    // a bare array is a step list; `"done": true` can only mean the whole plan
    assert.deepEqual(planStatusNormalize([{ titel: 'A' }, 'B']), { schritte: [{ id: 'S1', title: 'A', group: '' }, { id: 'S2', title: 'B', group: '' }] });
    assert.deepEqual(planStatusNormalize({ done: true }), { fertig: true });
    // `active` is NOT an alias of `aktiv`: {"active":"S3"} means the step just as plausibly as the sentence
    assert.equal(planStatusNormalize({ active: 'S3' }), null);
  });

  it('type checks: wrong shapes are dropped, not coerced into nonsense', () => {
    assert.equal(planStatusNormalize({ fertig: 'ja' }), null);
    assert.equal(planStatusNormalize({ fertig: 1 }), null);
    assert.equal(planStatusNormalize({ aktiv: { x: 1 } }), null);
    assert.equal(planStatusNormalize({ erledigt: [{ id: 'S1' }, null, true] }), null);
    assert.equal(planStatusNormalize({ aktuell: { id: 'S1' } }), null);
    assert.equal(planStatusNormalize({ schritte: 'S1' }), null);
    assert.equal(planStatusNormalize({}), null);
    for (const v of [null, 3, 'x', true]) assert.equal(planStatusNormalize(v), null, JSON.stringify(v));
    // an explicit null/"" clears the current step — that is information, not junk
    assert.deepEqual(planStatusNormalize({ aktuell: null }), { aktuell: '' });
    assert.deepEqual(planStatusNormalize({ erledigt: 'S1' }), { erledigt: ['S1'] });
  });

  it('caps every field', () => {
    const u = planStatusNormalize({
      aktiv: 'a'.repeat(500), notiz: 'n'.repeat(500),
      schritte: Array.from({ length: 50 }, (_, i) => ({ id: 'S' + (i + 1), titel: 't'.repeat(200) })),
      erledigt: Array.from({ length: 80 }, (_, i) => 'S' + (i + 1)),
    });
    assert.equal(u.aktiv.length, PLAN_CAPS.activeForm);
    assert.equal(u.notiz.length, PLAN_CAPS.note);
    assert.equal(u.schritte.length, PLAN_CAPS.steps);
    assert.ok(u.schritte.every((s) => s.title.length === PLAN_CAPS.title));
    assert.equal(u.erledigt.length, PLAN_CAPS.steps);
  });

  it('several blocks in one text are several reports, in order; an invalid one is skipped, the rest still read', () => {
    const txt = status('{"aktuell":"S1"}') + '\nArbeit…\n' + status('{ kein json') + '\n' + status('{"erledigt":["S1"],"aktuell":"S2"}');
    assert.deepEqual(planStatusExtract(txt), [{ aktuell: 'S1' }, { erledigt: ['S1'], aktuell: 'S2' }]);
    const many = Array.from({ length: 40 }, (_, i) => status('{"aktuell":"S' + ((i % 30) + 1) + '"}')).join('\n');
    assert.equal(planStatusExtract(many).length, PLAN_CAPS.blocks);
  });

  it('only the exact language tag counts — plan-schritte, plan-statusX and offene-punkte are not status blocks', () => {
    assert.deepEqual(planStatusExtract('```plan-schritte\n[{"id":"S1","titel":"A"}]\n```'), []);
    assert.deepEqual(planStatusExtract('```plan-statusx\n{"aktuell":"S1"}\n```'), []);
    assert.deepEqual(planStatusExtract('```offene-punkte\n[{"frage":"?"}]\n```'), []);
    // …while a block written on one line (no newline after the tag) is still read
    assert.deepEqual(planStatusExtract('Weiter: ```plan-status {"aktuell":"S2"}```'), [{ aktuell: 'S2' }]);
    // and the approval message itself contains NO status block (its JSON examples are prose)
    assert.deepEqual(planStatusExtract(panelAccept(SMALL)), []);
  });

  it('never throws on junk', () => {
    for (const v of [undefined, null, '', 42, {}, [], status(''), status('null'), status('[]'), status('"x"'), '```plan-status\n{"aktuell":"S1"}', '```plan-status']) {
      assert.doesNotThrow(() => planStatusExtract(v));
      assert.doesNotThrow(() => planStatusStrip(v));
    }
  });

  it('strip: valid blocks go (even meaningless ones), invalid JSON stays readable, the text around stays', () => {
    assert.equal(planStatusStrip('Vorher.\n\n' + status('{"aktuell":"S1"}') + '\n\nNachher.'), 'Vorher.\n\nNachher.');
    assert.equal(planStatusStrip(status('{}')), '');
    assert.equal(planStatusStrip(status('{"aktuell":"S1"}') + status('{"aktuell":"S2"}') + 'Rest'), 'Rest');
    const bad = status('{ kein json');
    assert.equal(planStatusStrip('A\n' + bad + '\nB'), 'A\n' + bad + '\nB');
    const op = '```offene-punkte\n[{"frage":"?"}]\n```';
    assert.equal(planStatusStrip(op), op, 'the open-points channel is not ours to strip');
    assert.equal(planStatusStrip(null), '');
  });

  it('a state per entry of the list (the echo of [Stand abfragen]) counts like the lists — forward only, the first „läuft" is current', () => {
    const st = (n) => Array.from({ length: n }, (_, i) => ({ id: 'S' + (i + 1), title: String.fromCharCode(65 + i), group: '' }));
    assert.deepEqual(planStatusNormalize({ schritte: [
      { id: 'S1', titel: 'A', status: 'erledigt' }, { id: 'S2', titel: 'B', status: 'übersprungen' }, { id: 'S3', titel: 'C', status: 'läuft' },
      { id: 'S4', titel: 'D', status: 'offen' }, { id: 'S5', titel: 'E', status: 'läuft' }] }),
    { schritte: st(5), erledigt: ['S1'], uebersprungen: ['S2'], aktuell: 'S3' }, '„offen" and the second „läuft" say nothing');
    // English words, merged into an explicit list without doubling it — and an explicit `aktuell` wins
    assert.deepEqual(planStatusNormalize({ steps: [{ id: 'S1', title: 'A', state: 'done' }, { id: 'S2', title: 'B', status: 'In_Progress' }], current: 'S1', done: ['S1'] }),
      { schritte: st(2), aktuell: 'S1', erledigt: ['S1'] });
    // an entry without an ID gets its free ID first — the state follows the entry, not its position
    assert.deepEqual(planStatusNormalize({ schritte: [{ titel: 'A', status: 'erledigt' }, { id: 'S1', titel: 'B' }] }).erledigt, ['S2']);
    assert.deepEqual(planStatusNormalize({ schritte: [{ id: 'S1', titel: 'A', status: 'vielleicht' }, { id: 'S2', titel: 'B', status: 7 }] }), { schritte: st(2) });
  });

  it('"titel" — the plan\'s own name: aliases, cleaned like a heading, capped; never an object', () => {
    assert.deepEqual(planStatusNormalize({ titel: 'QA-Lauf **Demoprojekt** `Z_EXAMPLE_X`', schritte: ['A'] }), { titel: 'QA-Lauf Demoprojekt Z_EXAMPLE_X', schritte: [{ id: 'S1', title: 'A', group: '' }] });
    for (const k of ['title', 'planTitel', 'planTitle', 'name']) assert.equal(planStatusNormalize({ [k]: 'X' }).titel, 'X', k);
    assert.equal(planStatusNormalize({ titel: 'x'.repeat(300) }).titel.length, PLAN_CAPS.title);
    assert.equal(planStatusNormalize({ titel: 7 }).titel, '7');
    for (const v of [{ a: 1 }, ['x'], true, '', '   ', null]) assert.equal(planStatusNormalize({ titel: v }), null, JSON.stringify(v));
    assert.equal(planStatusNormalize({ plan: 'Name?' }), null, '`plan` is no alias — it may hold the whole plan text');
    // the block's own name vs. a step's "titel" inside the list: two levels, two meanings
    assert.equal(planStatusNormalize({ schritte: [{ id: 'S1', titel: 'Schritt' }] }).titel, undefined);
  });

  it('a reference named like an Object.prototype member is a reference like any other', () => {
    assert.deepEqual(planStatusNormalize({ erledigt: ['constructor', 'toString', '__proto__', 'S1'] }), { erledigt: ['constructor', 'toString', '__proto__', 'S1'] });
    const p = accepted('# P\n## Umsetzung\n### constructor\n### toString\n');
    const r = planApplyStatus(p, planStatusNormalize({ erledigt: ['constructor'], aktuell: 'toString' }), 3000);
    assert.equal(r.unknown, 0, 'quoted by their exact titles');
    assert.deepEqual(p.steps.map((s) => s.status), ['completed', 'in_progress']);
  });

  it('an unclosed LAST block is read up to its blank line: the report applies, the prose after it stays', () => {
    const t = 'Ich mache weiter.\n\n```plan-status\n{"aktuell":"S2"}\n\nWICHTIG: danach geht es weiter.';
    assert.deepEqual(planStatusExtract(t), [{ aktuell: 'S2' }]);
    assert.equal(planStatusStrip(t), 'Ich mache weiter.\n\nWICHTIG: danach geht es weiter.');
    assert.equal(planStatusStrip('A\n```plan-status\n{"aktuell":"S2"}'), 'A\n', 'without a blank line it ends with the text');
    assert.deepEqual(planStatusExtract('A ```plan-status {"aktuell":"S2"}'), [{ aktuell: 'S2' }], 'JSON on the fence line, too');
    // not JSON up to the blank line → nothing applied, nothing taken out
    const bad = 'A\n\n```plan-status\nkein json\n\nB';
    assert.deepEqual(planStatusExtract(bad), []);
    assert.equal(planStatusStrip(bad), bad);
    // a ``` that CLOSES an earlier block opens nothing
    const closes = '```js\nx\n```plan-status\n{"aktuell":"S2"}';
    assert.deepEqual(planStatusExtract(closes), []);
    assert.equal(planStatusStrip(closes), closes);
    // closed blocks before it as before, the open one last; a fence after it means it is not the open one
    assert.deepEqual(planStatusExtract(status('{"aktuell":"S1"}') + '\n```plan-status\n{"erledigt":["S1"]}'), [{ aktuell: 'S1' }, { erledigt: ['S1'] }]);
    assert.deepEqual(planStatusExtract('```plan-status\n{"aktuell":"S1"}\n\nText\n```js\nx\n```'), [], 'closed by a later fence — the existing rule decides');
  });
});

describe('plan-progress — planApplyStatus (the rules)', () => {
  it('the first report confirms or replaces the list: src → model, status kept for surviving IDs', () => {
    const p = accepted();
    assert.equal(p.src, 'parser');
    planApplyStatus(p, { erledigt: ['S1'] }, 3000);
    const r = planApplyStatus(p, { schritte: [{ id: 'S1', title: 'Modul' }, { id: 'S2', title: 'Route bauen' }, { id: 'S4', title: 'Doku' }], aktuell: 'S2' }, 4000);
    assert.equal(r.changed, true);
    assert.equal(r.structural, true);
    assert.equal(p.src, 'model');
    assert.deepEqual(p.steps.map((s) => [s.id, s.title, s.status]), [['S1', 'Modul', 'completed'], ['S2', 'Route bauen', 'in_progress'], ['S4', 'Doku', 'pending']]);
    assert.equal(p.current, 'S2');
    assert.equal(p.reportedAt, 4000);
    assert.equal(p.updatedAt, 4000);
  });

  it('aktuell: the new step runs, the previous unfinished one goes back to pending', () => {
    const p = accepted();
    planApplyStatus(p, { aktuell: 'S1', aktiv: 'baue' }, 1);
    planApplyStatus(p, { aktuell: 'S3' }, 2);
    assert.deepEqual(p.steps.map((s) => s.status), ['pending', 'pending', 'in_progress']);
    assert.equal(p.activeForm, '', 'a new step without a sentence does not inherit the old one');
    assert.deepEqual(planCounts(p), { total: 3, done: 0, skipped: 0, open: 3, running: 1, current: 'S3', index: 3 });
  });

  it('erledigt only moves forward — a partial list undoes nothing; jumping back does not re-open; offen does', () => {
    const p = accepted();
    planApplyStatus(p, { erledigt: ['S1', 'S2'], aktuell: 'S3' }, 1);
    planApplyStatus(p, { erledigt: ['S1'] }, 2);
    assert.equal(p.steps[1].status, 'completed', 'S2 is not undone by a list that merely omits it');
    planApplyStatus(p, { aktuell: 'S1' }, 3);
    assert.equal(p.current, 'S1');
    assert.equal(p.steps[0].status, 'completed', 'jumping back to S1 does not re-open it');
    assert.equal(p.steps[2].status, 'pending', 'the step that was running is back to pending');
    planApplyStatus(p, { offen: ['S2'] }, 4);
    assert.equal(p.steps[1].status, 'pending');
    planApplyStatus(p, { offen: ['S1'] }, 5);
    assert.equal(p.steps[0].status, 'in_progress', 're-opening the CURRENT step makes it run');
  });

  it('uebersprungen never demotes a completed step; a skipped one can still be completed', () => {
    const p = accepted();
    planApplyStatus(p, { erledigt: ['S1'], uebersprungen: ['S1', 'S2'] }, 1);
    assert.deepEqual(p.steps.map((s) => s.status), ['completed', 'skipped', 'pending']);
    planApplyStatus(p, { erledigt: ['S2'] }, 2);
    assert.equal(p.steps[1].status, 'completed');
    assert.equal(planCounts(p).done, 2);
  });

  it('unknown IDs are ignored and COUNTED; the sentence of an unknown current step is dropped with it', () => {
    const p = accepted();
    planApplyStatus(p, { aktuell: 'S1', aktiv: 'baue das Modul' }, 1);
    const sig = planSig(p);
    const r = planApplyStatus(p, { aktuell: 'S9', erledigt: ['S7', 'S8'], aktiv: 'schreibe was anderes', notiz: 'x' }, 2);
    assert.equal(r.unknown, 3);
    assert.equal(r.changed, false);
    assert.equal(planSig(p), sig);
    assert.equal(p.current, 'S1');
    assert.equal(p.activeForm, 'baue das Modul', 'not pinned on the wrong step');
    assert.equal(p.reportedAt, 1, 'a report of only unknown IDs is no report');
    assert.equal(p.steps.length, 3, 'nothing is invented');
  });

  it('a step quoted by its exact title is found', () => {
    const p = accepted();
    planApplyStatus(p, { aktuell: 'Route', erledigt: ['modul'] }, 1);
    assert.equal(p.current, 'S2');
    assert.equal(p.steps[0].status, 'completed');
  });

  it('closing the running step without naming the next one leaves no step running', () => {
    const p = accepted();
    planApplyStatus(p, { aktuell: 'S2', aktiv: 'tippe' }, 1);
    planApplyStatus(p, { erledigt: ['S2'] }, 2);
    assert.equal(p.current, '');
    assert.equal(p.activeForm, '');
    assert.equal(planCurrentStep(p), null);
  });

  it('fertig → done; steps nobody reported stay open (never ticked off silently)', () => {
    const p = accepted();
    planApplyStatus(p, { aktuell: 'S2', erledigt: ['S1'], aktiv: 'tippe' }, 1);
    planApplyStatus(p, { fertig: true }, 2);
    assert.equal(p.state, 'done');
    assert.equal(p.current, '');
    assert.equal(p.activeForm, '');
    assert.deepEqual(p.steps.map((s) => s.status), ['completed', 'pending', 'pending']);
    assert.deepEqual(planCounts(p), { total: 3, done: 1, skipped: 0, open: 2, running: 0, current: '', index: 0 });
  });

  it('after fertig: a late completion keeps it done, naming a current step (or re-opening) makes it active again', () => {
    const p = accepted();
    planApplyStatus(p, { erledigt: ['S1', 'S2'], fertig: true }, 1);
    planApplyStatus(p, { erledigt: ['S3'] }, 2);
    assert.equal(p.state, 'done');
    planApplyStatus(p, { aktuell: 'S3' }, 3);
    assert.equal(p.state, 'done', 'S3 is completed — moving onto it re-opens nothing');
    planApplyStatus(p, { offen: ['S2'] }, 4);
    assert.equal(p.state, 'active');
  });

  it('notiz goes to the running step, or to the plan once it is done', () => {
    const p = accepted();
    planApplyStatus(p, { aktuell: 'S1', notiz: 'braucht Rückfrage' }, 1);
    assert.equal(p.steps[0].note, 'braucht Rückfrage');
    planApplyStatus(p, { fertig: true, notiz: 'alles bis auf Doku' }, 2);
    assert.equal(p.note, 'alles bis auf Doku');
  });

  it('a new sentence alone is a change but not a STRUCTURAL one (the rail patches, it does not rebuild)', () => {
    const p = accepted();
    planApplyStatus(p, { aktuell: 'S1' }, 1);
    const sig = planSig(p);
    const r = planApplyStatus(p, { aktiv: 'schreibe den Test' }, 2);
    assert.deepEqual(r, { changed: true, structural: false, unknown: 0 });
    assert.equal(planSig(p), sig);
    assert.deepEqual(planApplyStatus(p, { aktiv: 'schreibe den Test' }, 3), { changed: false, structural: false, unknown: 0 });
  });

  it('stale (after a compaction) is cleared by a report that hits something — not by unknown IDs or a sentence', () => {
    const p = accepted();
    p.stale = true;
    planApplyStatus(p, { aktuell: 'S9' }, 1);
    assert.equal(p.stale, true);
    planApplyStatus(p, { aktiv: 'irgendwas' }, 2);
    assert.equal(p.stale, true);
    planApplyStatus(p, { aktuell: 'S1' }, 3);
    assert.equal(p.stale, false);
  });

  it('a new list drops a current step whose ID is gone, and keeps notes of surviving steps', () => {
    const p = accepted();
    planApplyStatus(p, { aktuell: 'S3', notiz: 'n3' }, 1);
    planApplyStatus(p, { aktuell: 'S1', notiz: 'n1' }, 2);
    planApplyStatus(p, { aktuell: 'S3' }, 3);
    planApplyStatus(p, { schritte: [{ id: 'S1', titel: 'A' }, { id: 'S2', titel: 'B' }] }, 4);
    assert.equal(p.current, '');
    assert.equal(p.steps[0].note, 'n1');
  });

  it('a proposal the model reports against was evidently approved → active; a superseded one is left alone', () => {
    const p = planNew('toolu_P', SMALL, '', 1);
    planApplyStatus(p, { aktuell: 'S1' }, 5);
    assert.equal(p.state, 'active');
    assert.equal(p.acceptedAt, 5);
    const q = planSupersede(planNew('toolu_Q', SMALL, '', 1));
    assert.deepEqual(planApplyStatus(q, { aktuell: 'S1', fertig: true }, 5), { changed: false, structural: false, unknown: 0 });
    assert.equal(q.state, 'superseded');
  });

  it('a dismissed plan stays dismissed, even through fertig', () => {
    const p = planDismiss(accepted());
    planApplyStatus(p, { erledigt: ['S1'], fertig: true }, 1);
    assert.equal(p.state, 'dismissed');
    assert.equal(p.steps[0].status, 'completed');
  });

  it('garbage in → no change, no throw', () => {
    const p = accepted();
    for (const [a, b] of [[null, {}], [p, null], [p, 'x'], [{}, { aktuell: 'S1' }], [{ steps: 'x' }, { aktuell: 'S1' }]]) {
      assert.deepEqual(planApplyStatus(a, b, 1), { changed: false, structural: false, unknown: 0 });
    }
  });
});

describe('plan-progress — counts and the repaint signature', () => {
  it('planSig moves with structure and status, not with the sentence or a note', () => {
    const p = accepted();
    const s0 = planSig(p);
    p.activeForm = 'x'; p.note = 'y'; p.steps[0].note = 'z';
    assert.equal(planSig(p), s0);
    p.steps[0].status = 'completed';
    const s1 = planSig(p);
    assert.notEqual(s1, s0);
    p.steps[1].title = 'Route neu';
    assert.notEqual(planSig(p), s1);
    const s2 = planSig(p);
    p.stale = true;
    assert.notEqual(planSig(p), s2);
    const s3 = planSig(p);
    p.state = 'done';
    assert.notEqual(planSig(p), s3);
    assert.equal(planSig(null), '');
  });
  it('planUnreported: the open steps the model went past — behind the current one, or all open ones once finished', () => {
    const p = accepted('# P\n## Umsetzung\n### A\n### B\n### C\n### D\n');
    const keys = () => Object.keys(planUnreported(p));
    assert.deepEqual(keys(), [], 'nothing reported yet: nothing is „past"');
    planApplyStatus(p, { aktuell: 'S1' }, 3000);
    planApplyStatus(p, { aktuell: 'S4' }, 3100);
    assert.deepEqual(keys(), ['S1', 'S2', 'S3'], 'jumped ahead without `erledigt`');
    planApplyStatus(p, { aktuell: 'S2' }, 3200);
    assert.deepEqual(keys(), ['S1'], 'back to S2: S1 is still behind it, S4 is ahead again');
    planApplyStatus(p, { erledigt: ['S1', 'S2'] }, 3300);
    assert.deepEqual(keys(), [], 'no current step → no „past" — never a guess beyond what was said');
    planApplyStatus(p, { fertig: true }, 3400);
    assert.deepEqual(keys(), ['S3', 'S4'], 'finished: every open step is one');
    assert.deepEqual(Object.keys(planUnreported(null)), []);
    const prop = planNew('toolu_P', SMALL, '', 1);
    assert.deepEqual(Object.keys(planUnreported(prop)), [], 'a proposal has no past');
  });

  it('planCounts of nothing is zero', () => {
    assert.deepEqual(planCounts(null), { total: 0, done: 0, skipped: 0, open: 0, running: 0, current: '', index: 0 });
  });
});

describe('plan-progress — state transitions', () => {
  it('planNew: a proposal with the parser\'s steps, all pending, the live text kept', () => {
    const p = planNew('toolu_A', SMALL, 'C:\\Users\\x\\.claude\\plans\\test-plan.md', 1000);
    assert.equal(p.state, 'proposed');
    assert.equal(p.src, 'parser');
    assert.equal(p.title, 'Testvorhaben');
    assert.equal(p.text, SMALL);
    assert.deepEqual(p.steps.map((s) => [s.id, s.status]), [['S1', 'pending'], ['S2', 'pending'], ['S3', 'pending']]);
    assert.equal(p.seenAt, 1000);
    assert.equal(p.acceptedAt, 0);
    assert.equal(planNew('', SMALL), null);
    assert.equal(planNew('bad id with spaces', SMALL), null);
    assert.equal(planNew('toolu_B', '', 'C:\\x\\plans\\mein-plan.md', 1).title, 'mein-plan', 'no text → the file name');
  });

  it('planAccept: the list the approval CARRIED replaces the parse; without one the parse stays', () => {
    const p = planAccept(planNew('toolu_A', SMALL, '', 1), [{ id: 'S1', titel: 'Anders' }, 'Zweitens'], 50);
    assert.equal(p.state, 'active');
    assert.equal(p.acceptedAt, 50);
    assert.deepEqual(p.steps.map((s) => [s.id, s.title, s.status]), [['S1', 'Anders', 'pending'], ['S2', 'Zweitens', 'pending']]);
    assert.equal(titles(accepted().steps).join(), 'Modul,Route,Tests');
    assert.equal(planAccept(null), null);
  });

  it('supersede / unaccept / dismiss — each only where it applies, guarded by the tool id', () => {
    const a = planNew('toolu_A', SMALL, '', 1);
    planSupersede(a, 'toolu_OTHER');
    assert.equal(a.state, 'proposed');
    planSupersede(a, 'toolu_A');
    assert.equal(a.state, 'superseded');
    const b = accepted(SMALL, 'toolu_B');
    planSupersede(b);
    assert.equal(b.state, 'active', '„Weiter planen" never touches a plan already underway');
    planUnaccept(b, 'toolu_X');
    assert.equal(b.state, 'active');
    planUnaccept(b, 'toolu_B');
    assert.equal(b.state, 'proposed');
    assert.equal(b.acceptedAt, 0);
    const c = accepted(SMALL, 'toolu_C');
    planApplyStatus(c, { aktuell: 'S1' }, 9);
    planUnaccept(c, 'toolu_C');
    assert.equal(c.state, 'active', 'the model reported against it — the approval did arrive');
    assert.equal(planDismiss(c).state, 'dismissed');
    assert.equal(planVisible(c), false);
    assert.equal(planVisible(accepted()), true);
    assert.equal(planVisible(a), false);
    assert.equal(planVisible(null), false);
  });

  it('planChain: an accepted plan goes into the history (newest first, ≤ 5); a mere proposal does not', () => {
    let cur = accepted(SMALL, 'toolu_0');
    planApplyStatus(cur, { erledigt: ['S1'] }, 1);
    for (let i = 1; i <= 6; i++) cur = planChain(cur, planAccept(planNew('toolu_' + i, SMALL, '', i), null, i));
    assert.equal(cur.history.length, PLAN_CAPS.history);
    assert.deepEqual(cur.history.map((h) => h.id), ['toolu_5', 'toolu_4', 'toolu_3', 'toolu_2', 'toolu_1']);
    assert.deepEqual(Object.keys(cur.history[0]).sort(), ['acceptedAt', 'done', 'id', 'state', 'title', 'total']);
    const prop = planNew('toolu_p', SMALL, '', 1);
    const next = planChain(planChain(cur, prop), planNew('toolu_q', SMALL, '', 2));
    assert.deepEqual(next.history.map((h) => h.id), ['toolu_6', 'toolu_5', 'toolu_4', 'toolu_3', 'toolu_2'], 'the unaccepted proposal left no entry');
  });

  it('a history entry says how its plan was LEFT: replaced while underway, done as it was — a dismissed one as the transcript sees it', () => {
    const next = () => planNew('toolu_N', SMALL, '', 9);
    assert.equal(planPromote(accepted(SMALL, 'toolu_A'), next(), null, 10).history[0].state, 'replaced');
    const done = accepted(SMALL, 'toolu_D'); planApplyStatus(done, { fertig: true }, 1);
    assert.equal(planPromote(done, next(), null, 10).history[0].state, 'done');
    // the × lives only in the tab: the fold writes the line of the state underneath, and so does the live tab now —
    // otherwise „Frühere Pläne" changed on every resume
    assert.equal(planPromote(planDismiss(accepted(SMALL, 'toolu_X')), next(), null, 10).history[0].state, 'replaced');
    const dd = accepted(SMALL, 'toolu_DD'); planApplyStatus(dd, { fertig: true }, 1);
    assert.equal(planPromote(planDismiss(dd), next(), null, 10).history[0].state, 'done');
    // an older entry that says „dismissed" still restores
    assert.equal(planRestore({ ...planSave(accepted()), history: [{ id: 'toolu_O', state: 'dismissed', done: 0, total: 3 }] }).history[0].state, 'dismissed');
    // restorable as such — and only in a history entry: as the state of the plan itself it is junk
    const r = planRestore({ ...planSave(accepted()), history: [{ id: 'toolu_R', title: 'R', state: 'replaced', done: 1, total: 3, acceptedAt: 5 }, { id: 'toolu_Y', state: 'bogus' }] });
    assert.deepEqual(r.history.map((h) => [h.id, h.state]), [['toolu_R', 'replaced']]);
    assert.equal(planRestore({ ...planSave(accepted()), state: 'replaced' }), null);
  });

  it('planOffer: a plan underway stays on top; otherwise the proposal takes the place; the same id is a no-op', () => {
    const run = accepted(SMALL, 'toolu_A');
    const cand = planNew('toolu_B', SMALL, '', 5);
    assert.equal(planOffer(run, cand), run);
    const done = accepted(SMALL, 'toolu_D');
    planApplyStatus(done, { fertig: true }, 1);
    const shown = planOffer(done, cand);
    assert.equal(shown, cand);
    assert.deepEqual(shown.history.map((h) => [h.id, h.state]), [['toolu_D', 'done']]);
    assert.equal(planOffer(run, planNew('toolu_A', 'anderer Text', '', 9)), run, 'a repeated id never resets a plan');
    assert.equal(planOffer(null, cand), cand);
    assert.equal(planOffer(run, null), run);
    assert.equal(planOffer(null, null), null);
  });

  it('planPromote: the accepted candidate becomes the plan, its predecessor goes into the history', () => {
    const run = accepted(SMALL, 'toolu_A');
    const cand = planNew('toolu_B', SMALL, '', 5);
    const p = planPromote(run, cand, [{ id: 'S1', titel: 'Nur' }], 9);
    assert.equal(p, cand);
    assert.equal(p.state, 'active');
    assert.equal(p.acceptedAt, 9);
    assert.deepEqual(titles(p.steps), ['Nur']);
    assert.deepEqual(p.history.map((h) => h.id), ['toolu_A']);
    const prop = planNew('toolu_C', SMALL, '', 1);
    assert.equal(planPromote(prop, prop, null, 3), prop, 'the shown proposal itself is accepted in place');
    assert.equal(prop.history.length, 0);
    assert.equal(planPromote(run, null), run);
  });
});

describe('plan-progress — the approval message and the plan-schritte block', () => {
  it('head, then the suggested list, then the protocol', () => {
    const msg = panelAccept(SMALL);
    assert.ok(msg.startsWith(HEAD_DE + '\n\n```plan-schritte\n[\n{"id":"S1","titel":"Modul"},'));
    assert.ok(msg.endsWith('\n```\n\n' + PLAN_PROGRESS_PROTOCOL));
    assert.equal(planAcceptMessage('', null), '```plan-schritte\n[]\n```\n\n' + PLAN_PROGRESS_PROTOCOL);
    assert.equal(planAcceptMessage('  ' + HEAD_EN + '  ', null).indexOf(HEAD_EN + '\n\n```'), 0);
  });

  it('round trip: the block parses back to exactly the steps it was built from — backticks cannot break the fence', () => {
    const p = accepted();
    p.steps[1].title = 'Route ```böse``` `x`';
    p.steps[2].group = 'Teil `2`';
    const back = planStepsBlockParse(planAcceptMessage(HEAD_DE, p));
    assert.deepEqual(back.map((s) => s.id), ['S1', 'S2', 'S3']);
    assert.equal(back[1].title, "Route '''böse''' 'x'");
    assert.equal(back[2].group, "Teil '2'");
    assert.deepEqual(planStepsBlockParse('```plan-schritte\n[]\n```'), []);
    assert.equal(planStepsBlockParse('```plan-schritte\n{ kaputt\n```'), null);
    assert.equal(planStepsBlockParse('```plan-schritte\n{"id":"S1"}\n```'), null, 'not a list');
    assert.equal(planStepsBlockParse('kein Block'), null);
    assert.equal(planStepsBlockParse(null), null);
  });

  it('with {status:true} each step carries its state in the words the protocol uses', () => {
    const p = accepted();
    planApplyStatus(p, { erledigt: ['S1'], aktuell: 'S2', uebersprungen: ['S3'] }, 1);
    const rows = JSON.parse(planStepsBlock(p, { status: true }).replace(/^```plan-schritte\n|\n```$/g, ''));
    assert.deepEqual(rows.map((r) => r.status), ['erledigt', 'läuft', 'übersprungen']);
    assert.ok(!planStepsBlock(p).includes('"status"'));
  });

  it('[Stand abfragen] round trip: the list as the panel sends it, echoed back with the model\'s ticks, lands as ticks', () => {
    const p = accepted();
    planApplyStatus(p, { aktuell: 'S1' }, 3000);
    p.stale = true; // a compaction took the IDs away — the reason the button is there
    const sent = () => JSON.parse(planStepsBlock(p, { status: true }).replace(/^```plan-schritte\n|\n```$/g, ''));
    const rows = sent();
    assert.deepEqual(rows.map((r) => r.status), ['läuft', 'offen', 'offen']);
    rows[0].status = 'erledigt'; rows[1].status = 'erledigt'; rows[2].status = 'läuft';
    planStatusExtract(status(JSON.stringify({ schritte: rows }))).forEach((u) => planApplyStatus(p, u, 4000));
    assert.deepEqual(p.steps.map((s) => [s.id, s.status]), [['S1', 'completed'], ['S2', 'completed'], ['S3', 'in_progress']]);
    assert.equal(p.current, 'S3');
    assert.equal(p.stale, false);
    assert.equal(p.src, 'model');
    // the panel's own belief coming back changes nothing — „offen" re-opens nothing (only an explicit list does)
    const again = sent();
    again[0].status = 'offen';
    planStatusExtract(status(JSON.stringify({ schritte: again }))).forEach((u) => planApplyStatus(p, u, 5000));
    assert.equal(p.steps[0].status, 'completed');
    planApplyStatus(p, { erledigt: ['S3'], fertig: true }, 6000);
    assert.deepEqual(Object.keys(planUnreported(p)), [], 'every step was reported — nothing is „ohne Abschluss-Meldung"');
  });

  it('planStepsNormalize: explicit IDs are reserved first, duplicates get a free ID, the cap holds', () => {
    assert.deepEqual(planStepsNormalize([{ titel: 'a' }, { id: 'S1', titel: 'b' }, { id: 'S1', titel: 'c' }, 'd']).map((s) => s.id + '=' + s.title),
      ['S2=a', 'S1=b', 'S3=c', 'S4=d']);
    assert.deepEqual(planStepsNormalize([{ id: 3 }, null, [], { titel: '' }, 7]).map((s) => s.id + '=' + s.title), ['S3=S3', 'S2=7']);
    assert.equal(planStepsNormalize(Array.from({ length: 40 }, (_, i) => 'T' + i)).length, PLAN_CAPS.steps);
    assert.deepEqual(planStepsNormalize('x'), []);
  });
});

describe('plan-progress — planSave / planRestore / planAdopt', () => {
  it('round trip through JSON: compact, without the plan text, field for field the same', () => {
    const p = accepted();
    planApplyStatus(p, { schritte: [{ id: 'S1', titel: 'A', gruppe: 'G1' }, { id: 'S2', titel: 'B', gruppe: 'G2' }], aktuell: 'S2', aktiv: 'tippe', notiz: 'n' }, 7);
    p.stale = true;
    const saved = planSave(p);
    assert.equal(saved.text, undefined);
    assert.ok(!('text' in saved));
    const back = planRestore(JSON.parse(JSON.stringify(saved)));
    assert.deepEqual(back, saved);
    assert.equal(back.current, 'S2');
    assert.equal(back.stale, true);
    assert.equal(back.src, 'model');
    assert.ok(JSON.stringify(saved).length < 1500);
  });

  it('garbage → null', () => {
    const ok = planSave(accepted());
    for (const v of [null, undefined, 'x', 3, [], {}, { ...ok, id: '' }, { ...ok, id: 'mit leerzeichen' }, { ...ok, id: 'x'.repeat(200) },
      { ...ok, state: 'running' }, { ...ok, state: undefined }, { ...ok, steps: 'S1' }, { ...ok, steps: undefined }, { ...ok, v: 2 }]) {
      assert.equal(planRestore(v), null, JSON.stringify(v && v.state) + '/' + JSON.stringify(v && v.id));
    }
  });

  it('every field is forced again: statuses, IDs, the current step, times, flags, caps', () => {
    const r = planRestore({
      id: 'toolu_X', state: 'active', src: 'hacker', stale: 'yes', file: 'C:\\x\u0007.md', title: 't'.repeat(300),
      steps: [{ id: 'S1', title: 'a', status: 'exploded' }, { id: 'S1', title: 'dupe' }, null, 'S9', { id: '', title: 'no id' }, { id: 2, title: { x: 1 }, note: 'n'.repeat(400) }]
        .concat(Array.from({ length: 40 }, (_, i) => ({ id: 'S' + (i + 10), title: 'x' }))),
      current: 'S7', activeForm: { evil: true }, acceptedAt: NaN, updatedAt: -5, reportedAt: 'soon', seenAt: 1e20,
      history: [null, { id: 'toolu_h', state: 'done', done: 99, total: 3, title: 7 }, { id: 'toolu_bad', state: 'zzz' }],
    });
    assert.equal(r.src, 'parser');
    assert.equal(r.stale, false);
    assert.equal(r.file, '');
    assert.equal(r.title.length, PLAN_CAPS.title);
    assert.equal(r.steps.length, PLAN_CAPS.steps);
    assert.deepEqual(r.steps.slice(0, 2).map((s) => [s.id, s.title, s.status]), [['S1', 'a', 'pending'], ['S2', 'S2', 'pending']]);
    assert.equal(r.steps[1].note.length, PLAN_CAPS.note);
    assert.equal(r.current, '', 'S7 is not a step of this plan');
    assert.equal(r.activeForm, '');
    assert.deepEqual([r.acceptedAt, r.updatedAt, r.reportedAt, r.seenAt], [0, 0, 0, 0]);
    assert.deepEqual(r.history, [{ id: 'toolu_h', title: '7', state: 'done', done: 0, total: 3, acceptedAt: 0 }]);
  });

  it('planAdopt: the transcript is the truth; locally only a dismissal and the live text survive, for the SAME plan', () => {
    const local = planDismiss(accepted(SMALL, 'toolu_A'));
    const fromT = planSave(accepted(SMALL, 'toolu_A'));
    planApplyStatus(fromT, { erledigt: ['S1'] }, 3);
    const a = planAdopt(local, fromT);
    assert.equal(a.state, 'dismissed');
    assert.equal(a.steps[0].status, 'completed', 'the transcript\'s progress wins');
    assert.equal(a.text, SMALL);
    const other = planAdopt(local, planSave(accepted(SMALL, 'toolu_B')));
    assert.equal(other.state, 'active', 'a dismissal of ANOTHER plan does not carry over');
    assert.equal(other.text, undefined);
    assert.equal(planAdopt(local, null), null, 'the transcript holds no plan → none');
    assert.equal(planAdopt(local, { junk: true }), null);
    assert.equal(planAdopt(local, undefined), local, 'the server said nothing → keep ours');
    assert.equal(planAdopt(null, undefined), null);
  });

  it('planAdopt: a proposal the transcript left unanswered comes back ORPHANED — no resumed process holds its gate', () => {
    // the fold says what the transcript says (an ExitPlanMode without a tool_result is „proposed")…
    const r = fold([epm('toolu_1', SMALL)]);
    assert.equal(r.state, 'proposed');
    assert.equal(r.gate, '');
    // …but the gate went with the process that asked: as a plain „proposed" the rail would wait for a card that no
    // longer exists. It used to come back superseded and vanish — now it stays on the table as an orphan, which
    // „▶ Plan starten" can start by an ordinary message. Even when the tab still holds the same proposal locally.
    const a = planAdopt(planNew('toolu_1', SMALL, '', 1), r);
    assert.equal(a.state, 'proposed');
    assert.equal(a.gate, 'none');
    assert.equal(P.planIsOrphan(a), true);
    assert.equal(planVisible(a), true, 'the rail keeps it — as a proposal nothing but a start can decide');
    assert.equal(a.steps.length, 3, 'with the steps a start would carry');
    assert.equal(a.text, SMALL, 'the live text of the same plan survives anyway — [Plan öffnen] on its card shows it');
    // an accepted plan, a finished one, a dismissal and „Weiter planen" are untouched by this
    for (const st of ['active', 'done', 'dismissed', 'superseded']) {
      const b = planAdopt(null, { ...planSave(accepted()), state: st });
      assert.equal(b.state, st);
      assert.equal(b.gate, '', st + ' is no orphan');
    }
  });

  it('planIsApproval: one rule for the fold and the resumed card — the step block, or the approval sentences', () => {
    const { planIsApproval } = P;
    assert.equal(planIsApproval(planAcceptMessage(HEAD_DE, accepted())), true);
    // the resumed tail caps a result at 4000 characters, which can cut the block before its closing fence
    assert.equal(planIsApproval('Freigabe\n\n```plan-schritte\n[{"id":"S1","titel":"A"},'), true);
    for (const s of [HEAD_DE, HEAD_EN, 'User has approved your plan. You can now start coding.']) assert.equal(planIsApproval(s), true, s);
    for (const s of ['Bitte den Plan noch überarbeiten: kürzer', "The user doesn't want to proceed with this tool use.", '', null, undefined]) {
      assert.equal(planIsApproval(s), false, String(s));
    }
    // …and the sentence must OPEN the text. As `(?:a|b)|c` the third alternative was unanchored, so a „weiter
    // planen" that quotes it, or a model writing it in prose, counted as an approval — and the fold would have
    // dropped the plan it was still reporting against (CodeQL js/regex/missing-regexp-anchor, PR #85).
    for (const s of ['Bitte überarbeiten. User has approved your plan stand da nicht.',
      'Hinweis: Plan genehmigt war gestern — heute bitte nicht.',
      'Siehe oben: Plan approved gilt hier nicht.']) assert.equal(planIsApproval(s), false, s);
  });

  it('planIsApproval knows the panel\'s OWN sentences, in both languages — the fold decides by them for an approval without a block', () => {
    const { planIsApproval } = P;
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'js', 'i18n.js'), 'utf8');
    // `    'key': 'value',` — the dictionary's one-entry-per-line shape (test/i18n.test.js relies on it too)
    const vals = (key) => src.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("'" + key + "': '"))
      .map((l) => l.slice(key.length + 5).replace(/',?$/, '').replace(/\\'/g, "'"));
    const ok = vals('chat-render.planGenehmigtDerPlan'), keep = vals('chat-render.bitteDenPlanNoch');
    assert.equal(ok.length, 2, 'de + en');
    assert.equal(keep.length, 2, 'de + en');
    for (const v of ok) assert.equal(planIsApproval(v), true, v);
    for (const v of keep) assert.equal(planIsApproval(v), false, v);
  });

  it('planFileName: only a .md in a plans folder, as GET /api/plan?name= serves it', () => {
    assert.equal(planFileName('C:\\Users\\x\\.claude\\plans\\tingly-test.md'), 'tingly-test.md');
    assert.equal(planFileName('/home/x/.claude/plans/a-b.md'), 'a-b.md');
    for (const v of ['C:\\Users\\x\\docs\\a.md', 'C:\\x\\plans\\a.txt', 'a.md', '', null, 7, 'C:\\plans\\a\u0000.md']) assert.equal(planFileName(v), '', String(v));
  });
});

describe('plan-progress — the resume fold over transcript lines', () => {
  it('a panel approval with a plan-schritte block → active with EXACTLY those steps, then the reports', () => {
    const shown = planNew('toolu_1', SMALL, '', 0);
    shown.steps.pop(); // what the model was SHOWN is what counts — not what the parser makes of the text now
    const r = fold([
      epm('toolu_1', SMALL),
      res('toolu_1', planAcceptMessage(HEAD_DE, shown)),
      say('Los geht es.\n' + status('{"schritte":[{"id":"S1","titel":"Modul"},{"id":"S2","titel":"Route"}],"aktuell":"S1"}')),
      say(status('{"aktuell":"S2","erledigt":["S1"],"aktiv":"Verdrahte die Route"}')),
    ]);
    assert.equal(r.state, 'active');
    assert.equal(r.src, 'model');
    assert.equal(r.title, 'Testvorhaben');
    assert.equal(r.file, 'C:\\Users\\x\\.claude\\plans\\test-plan.md');
    assert.deepEqual(r.steps.map((s) => [s.id, s.status]), [['S1', 'completed'], ['S2', 'in_progress']]);
    assert.equal(r.activeForm, 'Verdrahte die Route');
    assert.ok(r.acceptedAt > 0 && r.reportedAt >= r.acceptedAt);
  });

  it('the block wins even over a parser that would read more — and an empty block means „the model lists them"', () => {
    const r = fold([epm('toolu_1', SMALL), res('toolu_1', HEAD_DE + '\n\n```plan-schritte\n[]\n```\n\n' + PLAN_PROGRESS_PROTOCOL)]);
    assert.equal(r.state, 'active');
    assert.deepEqual(r.steps, []);
  });

  it('an approval WITHOUT a step block — older panel de/en, native CLI, the switch off — leaves no plan, and takes the one underway down', () => {
    // Measured over the local corpus: 11 of the 12 sessions with a plan were approved this way and came back as
    // „in Arbeit · Noch kein Stand gemeldet" — opening the rail on every resume, for plans finished weeks ago.
    const native = 'User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\nYour plan has been saved to: C:\\x\\plans\\test-plan.md';
    for (const text of [HEAD_DE, HEAD_EN, native]) {
      assert.equal(fold([epm('toolu_1', SMALL), res('toolu_1', text, { isError: text !== native, tur: text === native ? { plan: SMALL, isAgent: false } : undefined })]), null, text.slice(0, 24));
    }
    // a report WITHOUT a list after it changes nothing: there is no list to show, and nothing it could tick off…
    assert.equal(fold([epm('toolu_1', SMALL), res('toolu_1', HEAD_DE), say(status('{"aktuell":"S1","erledigt":["S2"]}'))]), null);
    // …while a report WITH one is a plan the model reports on its own (PLAN_PROGRESS_SYSTEM_HINT „auch ohne
    // Freigabe"): it starts a plan — named after the proposal it was approved for, since it brings no name itself.
    // This replaced „a report cannot invent a plan" (PF-1b): the 05.10. session worked through its steps with no
    // approval the rail could hang them on. Old transcripts carry no such report, so they still fold to nothing.
    const own = fold([epm('toolu_1', SMALL), res('toolu_1', HEAD_DE), say(status('{"schritte":["X","Y"],"aktuell":"S1"}'))]);
    assert.equal(own.src, 'model');
    assert.equal(own.state, 'active');
    assert.equal(own.title, 'Testvorhaben');
    assert.match(own.id, /^status:/);
    assert.deepEqual(own.steps.map((s) => [s.id, s.title, s.status]), [['S1', 'X', 'in_progress'], ['S2', 'Y', 'pending']]);
    // the plan underway goes with it — the model works on the new one now (the live tab does the same: planUntracked)
    const work = [epm('toolu_1', SMALL), res('toolu_1', panelAccept(SMALL)), say(status('{"aktuell":"S2","erledigt":["S1"]}')), epm('toolu_2', SMALL)];
    assert.equal(fold(work.concat([res('toolu_2', HEAD_DE)])), null);
    // …while „Weiter planen" on that second proposal leaves the first where it was
    const kept = fold(work.concat([res('toolu_2', 'Bitte den Plan noch nicht ausführen — weiter planen.')]));
    assert.equal(kept.id, 'toolu_1');
    assert.equal(kept.current, 'S2');
    // and the next panel approval (with its block) is a plan again, from scratch
    const next = fold([epm('toolu_1', SMALL), res('toolu_1', HEAD_DE), epm('toolu_2', SMALL), res('toolu_2', panelAccept(SMALL))]);
    assert.equal(next.id, 'toolu_2');
    assert.equal(next.state, 'active');
    assert.deepEqual(next.history, []);
  });

  it('„Weiter planen" and a native rejection take the proposal off the table; the next one is a fresh proposal', () => {
    const keep = fold([epm('toolu_1', SMALL), res('toolu_1', 'Bitte den Plan noch nicht ausführen — weiter planen.\n\nNoch die Doku.')]);
    assert.equal(keep.state, 'superseded');
    const rej = fold([epm('toolu_1', SMALL), res('toolu_1', "The user doesn't want to proceed with this tool use.", { isError: true })]);
    assert.equal(rej.state, 'superseded', 'the transcript ends on it — no Stop (the interrupt marker would be the next line)');
    const fed = fold([epm('toolu_1', SMALL), res('toolu_1', "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nerst die Doku (synthetisch)"), say('Verstanden.')]);
    assert.equal(fed.state, 'superseded', 'a rejection with feedback, the model answers it');
    const typed = fold([epm('toolu_1', SMALL), res('toolu_1', 'stop, erst noch die fragen')]);
    assert.equal(typed.state, 'superseded', 'a free reply is no approval');
    const again = fold([epm('toolu_1', SMALL), res('toolu_1', 'Bitte den Plan noch nicht ausführen — weiter planen.'), epm('toolu_2', SMALL), res('toolu_2', panelAccept(SMALL))]);
    assert.equal(again.id, 'toolu_2');
    assert.equal(again.state, 'active');
    assert.deepEqual(again.history, [], 'a superseded proposal is no earlier plan');
  });

  it('a proposal without an answer yet is the result as „proposed"', () => {
    const r = fold([epm('toolu_1', SMALL)]);
    assert.equal(r.state, 'proposed');
    assert.equal(r.steps.length, 3);
  });

  it('two plans: the second replaces the first, which goes into the history with its numbers', () => {
    const r = fold([
      epm('toolu_1', SMALL), res('toolu_1', panelAccept(SMALL)),
      say(status('{"erledigt":["S1","S2"],"aktuell":"S3"}')),
      epm('toolu_2', '# Plan: Zweiter\n## Umsetzung\n### X\n### Y\n'),
      say(status('{"aktuell":"S3","aktiv":"noch am ersten"}')),
      res('toolu_2', panelAccept('# Plan: Zweiter\n## Umsetzung\n### X\n### Y\n')),
    ]);
    assert.equal(r.id, 'toolu_2');
    assert.equal(r.title, 'Zweiter');
    // „replaced", not „active": it did not go on — as „in Arbeit · 2/3" it stood next to the plan that really is
    assert.deepEqual(r.history, [{ id: 'toolu_1', title: 'Testvorhaben', state: 'replaced', done: 2, total: 3, acceptedAt: r.history[0].acceptedAt }]);
  });

  it('while a plan is underway a NEW proposal does not displace it; after it is done, it does', () => {
    const during = fold([epm('toolu_1', SMALL), res('toolu_1', panelAccept(SMALL)), say(status('{"aktuell":"S1"}')), epm('toolu_2', SMALL)]);
    assert.equal(during.id, 'toolu_1');
    assert.equal(during.state, 'active');
    const after = fold([epm('toolu_1', SMALL), res('toolu_1', panelAccept(SMALL)), say(status('{"erledigt":["S1","S2","S3"],"fertig":true}')), epm('toolu_2', SMALL)]);
    assert.equal(after.id, 'toolu_2');
    assert.equal(after.state, 'proposed');
    assert.deepEqual(after.history.map((h) => [h.id, h.state, h.done, h.total]), [['toolu_1', 'done', 3, 3]]);
  });

  it('isSidechain lines never move the plan (subagents)', () => {
    const r = fold([
      epm('toolu_1', SMALL), res('toolu_1', panelAccept(SMALL)),
      say(status('{"aktuell":"S1"}')),
      say(status('{"erledigt":["S1","S2","S3"],"fertig":true}'), { side: true }),
      epm('toolu_9', SMALL, { side: true }), res('toolu_9', panelAccept(SMALL), { side: true }),
      compact({ side: true }),
    ]);
    assert.equal(r.id, 'toolu_1');
    assert.equal(r.state, 'active');
    assert.equal(r.current, 'S1');
    assert.equal(r.stale, false);
  });

  it('compact_boundary marks an active plan stale; the next report that hits something clears it', () => {
    const base = [epm('toolu_1', SMALL), res('toolu_1', panelAccept(SMALL)), say(status('{"aktuell":"S1"}')), compact()];
    assert.equal(fold(base).stale, true);
    assert.equal(fold(base.concat([say(status('{"aktuell":"S7"}'))])).stale, true, 'unknown IDs prove nothing');
    assert.equal(fold(base.concat([say(status('{"aktuell":"S2","erledigt":["S1"]}'))])).stale, false);
    assert.equal(fold([epm('toolu_1', SMALL), compact()]).stale, false, 'a proposal is not „underway"');
  });

  it('lines the CLI writes twice (same uuid, re-written after a compaction) are folded once', () => {
    const l1 = epm('toolu_1', SMALL), r1 = res('toolu_1', panelAccept(SMALL));
    const s1 = say(status('{"erledigt":["S1"]}'));
    const l2 = epm('toolu_2', '# Plan: Zweiter\n## Umsetzung\n### X\n### Y\n'), r2 = res('toolu_2', panelAccept('# Plan: Zweiter\n## Umsetzung\n### X\n### Y\n'));
    const r = fold([l1, r1, s1, l2, r2, compact(), l1, r1, s1, say(status('{"aktuell":"S2"}'))]);
    assert.equal(r.id, 'toolu_2', 'the replayed old plan is not put back on top');
    assert.equal(r.current, 'S2');
    assert.deepEqual(r.history.map((h) => [h.id, h.done]), [['toolu_1', 1]]);
    // the same tool id under a NEW uuid is idempotent as well
    const dup = fold([l1, r1, s1, epm('toolu_1', SMALL), res('toolu_1', 'Bitte den Plan noch nicht ausführen — weiter planen.')]);
    assert.equal(dup.state, 'active');
    assert.equal(dup.steps[0].status, 'completed');
  });

  it('tool_result content as an array of text parts is read too', () => {
    const r = fold([epm('toolu_1', SMALL), res('toolu_1', panelAccept(SMALL), { array: true })]);
    assert.equal(r.state, 'active');
  });

  it('a plan without structure, approved with its EMPTY block: active with NO steps until the model sends them', () => {
    const L = PROSE;
    const before = fold([epm('toolu_L', L, { slug: 'tingly-test' }), res('toolu_L', panelAccept(L))]);
    assert.equal(before.state, 'active');
    assert.deepEqual(before.steps, []);
    const after = fold([epm('toolu_L', L, { slug: 'tingly-test' }), res('toolu_L', panelAccept(L)),
      say(status('{"schritte":["Befunde nachtesten","Doku nachziehen"],"aktuell":"S1"}'))]);
    assert.equal(after.src, 'model');
    assert.deepEqual(after.steps.map((s) => [s.id, s.title, s.status]), [['S1', 'Befunde nachtesten', 'in_progress'], ['S2', 'Doku nachziehen', 'pending']]);
    assert.equal(planFileName(after.file), 'tingly-test.md');
  });

  it('the result is the planSave form — no text, no parse buffer, restorable as it is', () => {
    const L = livingPlan().md;
    for (const r of [fold([epm('toolu_1', SMALL)]), fold([epm('toolu_L', L), res('toolu_L', panelAccept(L))]), fold([epm('toolu_1', SMALL), res('toolu_1', panelAccept(SMALL))])]) {
      const json = JSON.stringify(r);
      assert.ok(!('text' in r) && !('_md' in r));
      assert.ok(json.length < 4000, json.length + ' bytes');
      assert.deepEqual(planRestore(JSON.parse(json)), r);
    }
  });

  it('the history holds at most five plans', () => {
    const lines = [];
    for (let i = 1; i <= 7; i++) lines.push(epm('toolu_' + i, SMALL), res('toolu_' + i, panelAccept(SMALL)));
    const r = fold(lines);
    assert.equal(r.id, 'toolu_7');
    assert.deepEqual(r.history.map((h) => h.id), ['toolu_6', 'toolu_5', 'toolu_4', 'toolu_3', 'toolu_2']);
  });

  it('no plan, junk lines, reports without a plan → null, and never a throw', () => {
    const f = planFoldNew();
    for (const l of [null, undefined, 'x', 3, {}, { type: 'assistant' }, { type: 'assistant', message: {} }, { type: 'assistant', message: { content: 'nur text ```plan-status\n{"aktuell":"S1"}\n```' } },
      { type: 'user', message: { content: 'getippt' } }, { type: 'user', message: { content: [null, { type: 'tool_result' }] } },
      { type: 'assistant', message: { content: [null, { type: 'tool_use', name: 'ExitPlanMode' }] } }, { type: 'system', subtype: 'compact_boundary' }]) {
      assert.doesNotThrow(() => planFoldLine(f, l));
    }
    assert.equal(planFoldResult(f), null);
    assert.equal(planFoldResult(null), null);
    assert.equal(planFoldLine(null, epm('toolu_1', SMALL)), false);
  });

  it('planFoldLine says whether a line moved the fold', () => {
    const f = planFoldNew();
    assert.equal(planFoldLine(f, say('nur Prosa')), false);
    assert.equal(planFoldLine(f, epm('toolu_1', SMALL)), true);
    assert.equal(planFoldLine(f, res('toolu_other', 'x')), false);
    assert.equal(planFoldLine(f, res('toolu_1', panelAccept(SMALL))), true);
    assert.equal(planFoldLine(f, compact()), true);
  });

  it('the live approval and the fold agree: what the panel sends is what a resume reads back', () => {
    const live = planNew('toolu_1', SMALL, 'C:\\Users\\x\\.claude\\plans\\test-plan.md', 1);
    const msg = planAcceptMessage(HEAD_EN, live);
    planAccept(live, null, 2);
    planApplyStatus(live, { aktuell: 'S2', erledigt: ['S1'] }, 3);
    const r = fold([epm('toolu_1', SMALL), res('toolu_1', msg), say(status('{"aktuell":"S2","erledigt":["S1"]}'))]);
    assert.deepEqual(r.steps, planSave(live).steps);
    assert.equal(r.current, live.current);
    assert.equal(r.state, live.state);
  });

  it('PF-1b: live and fold agree — the orphan, its start by message, the reports, a plan the model starts on its own', () => {
    const FILE = 'C:\\Users\\x\\.claude\\plans\\test-plan.md';
    // 1. the refused ExitPlanMode: live the tab orphans its candidate (chat-events.js), the fold reads the result
    const live = P.planOrphan(planNew('toolu_1', SMALL, FILE, 1), 'toolu_1');
    const l1 = [epm('toolu_1', SMALL), res('toolu_1', NO_PLAN_MODE)];
    const f1 = fold(l1);
    for (const k of ['id', 'title', 'file', 'state', 'gate', 'steps']) assert.deepEqual(f1[k], planSave(live)[k], '1. ' + k);
    // 2. ▶ Plan starten: what the panel sends, then planActivate's planPromote with the candidate's own steps
    const msg = P.planStartMessage(HEAD_START, live);
    planPromote(live, live, null, 2);
    const l2 = l1.concat([user(msg)]);
    const f2 = fold(l2);
    for (const k of ['id', 'state', 'gate', 'steps', 'current']) assert.deepEqual(f2[k], planSave(live)[k], '2. ' + k);
    // 3. reports, „fertig", then a plan the model names and starts on its own — the same id on both sides
    const reps = [status('{"aktuell":"S1"}'), status('{"erledigt":["S1","S2","S3"],"fertig":true}'), status('{"titel":"Nachtrag","schritte":["Doku","PR"],"aktuell":"S1"}')];
    let lp = live;
    reps.forEach((t, i) => planStatusExtract(t).forEach((u) => { lp = planFromStatus(lp, u, { title: live.title, file: live.file }, 10 + i).plan; }));
    const f3 = fold(l2.concat(reps.map((t) => say(t))));
    assert.equal(f3.title, 'Nachtrag');
    for (const k of ['id', 'title', 'file', 'state', 'src', 'gate', 'steps', 'current']) assert.deepEqual(f3[k], planSave(lp)[k], '3. ' + k);
    assert.deepEqual(f3.history.map((h) => [h.id, h.state, h.done, h.total]), planSave(lp).history.map((h) => [h.id, h.state, h.done, h.total]));
    assert.deepEqual(f3.history.map((h) => [h.id, h.state]), [['toolu_1', 'done']]);
  });
});

describe('plan-progress — orphaned proposals (PF-1b): no gate will ever decide them', () => {
  it('planIsNoPlanModeError / planGateLost: the CLI\'s refusal and an aborted gate — anchored, so feedback quoting them is feedback', () => {
    const { planIsNoPlanModeError, planGateLost } = P;
    for (const s of [NO_PLAN_MODE, 'You are not in plan mode.', '  <tool_use_error>  you are NOT in plan mode', 'Error: You are not in plan mode', "You're not currently in plan mode"]) {
      assert.equal(planIsNoPlanModeError(s), true, s);
      assert.equal(planGateLost(s), true, s);
    }
    const aborted = 'Tool permission request failed: AbortError: The operation was aborted (synthetisch)';
    assert.equal(planIsNoPlanModeError(aborted), false);
    assert.equal(planGateLost(aborted), true);
    for (const s of ['Bitte den Plan noch nicht ausführen — weiter planen.\n\nYou are not in plan mode, sagt die CLI', HEAD_DE, "The user doesn't want to proceed with this tool use.",
      'stop, erst noch die fragen', 'Hinweis: Tool permission request failed: AbortError stand im Log', '', null, undefined, 42]) {
      assert.equal(planIsNoPlanModeError(s), false, String(s));
      assert.equal(planGateLost(s), false, String(s));
    }
  });

  it('planOrphan: a proposal only, guarded by the tool id, sticky through an accept that is taken back', () => {
    const { planOrphan, planIsOrphan } = P;
    const p = planNew('toolu_A', SMALL, '', 1);
    assert.equal(p.gate, '');
    planOrphan(p, 'toolu_OTHER');
    assert.equal(planIsOrphan(p), false);
    planOrphan(p, 'toolu_A');
    assert.equal(planIsOrphan(p), true);
    assert.equal(p.state, 'proposed', 'still the plan on the table');
    assert.equal(planVisible(p), true);
    planAccept(p, null, 5);
    assert.equal(planIsOrphan(p), false, 'accepted is no proposal');
    planUnaccept(p, 'toolu_A');
    assert.equal(planIsOrphan(p), true, 'taken back it is an orphan again — not „wartet auf Freigabe"');
    for (const st of ['active', 'done', 'dismissed', 'superseded']) {
      const q = { ...planNew('toolu_B', SMALL, '', 1), state: st };
      planOrphan(q);
      assert.equal(q.gate, '', st);
    }
    assert.equal(planOrphan(null), null);
    assert.equal(planIsOrphan(null), false);
  });

  it('the gate is part of the repaint signature and of the saved form (forced: anything but "none" is "")', () => {
    const p = planNew('toolu_A', SMALL, '', 1);
    const s0 = planSig(p);
    P.planOrphan(p);
    assert.notEqual(planSig(p), s0, 'an orphan looks different in the rail — it must be rebuilt');
    const back = planRestore(JSON.parse(JSON.stringify(planSave(p))));
    assert.equal(back.gate, 'none');
    assert.deepEqual(back, planSave(p));
    assert.equal(planRestore({ ...planSave(p), gate: 'open' }).gate, '');
    assert.equal(planRestore({ ...planSave(p), gate: { x: 1 } }).gate, '');
    const legacy = planSave(p);
    delete legacy.gate; // a tab saved before PF-1b
    assert.equal(planRestore(legacy).gate, '');
  });

  it('the fold keeps the refused proposal as an orphan — the 05.10. case, which it used to supersede', () => {
    const r = fold([epm('toolu_1', SMALL), res('toolu_1', NO_PLAN_MODE)]);
    assert.equal(r.state, 'proposed');
    assert.equal(r.gate, 'none');
    assert.equal(r.steps.length, 3, 'with its parsed steps — what a start would carry');
    assert.equal(planVisible(planAdopt(null, r)), true, 'and a resumed tab shows it');
    // an aborted gate (the turn ended while the card still waited) the same way; content as text parts
    assert.equal(P.planIsOrphan(fold([epm('toolu_1', SMALL), res('toolu_1', 'Tool permission request failed: AbortError: aborted', { array: true })])), true);
    // „Weiter planen" still takes it off the table
    assert.equal(fold([epm('toolu_1', SMALL), res('toolu_1', 'Bitte den Plan noch nicht ausführen — weiter planen.')]).state, 'superseded');
    // a model report against the orphan says it was started after all → active (the rule for any proposal)
    const rep = fold([epm('toolu_1', SMALL), res('toolu_1', NO_PLAN_MODE), say(status('{"aktuell":"S1"}'))]);
    assert.equal(rep.state, 'active');
    assert.equal(rep.current, 'S1');
  });

  it('while another plan is underway the refused proposal waits in its card — the plan underway stays on top', () => {
    const r = fold([epm('toolu_1', SMALL), res('toolu_1', panelAccept(SMALL)), say(status('{"aktuell":"S2","erledigt":["S1"]}')),
      epm('toolu_2', '# Plan: Zweiter\n## Umsetzung\n### X\n### Y\n'), res('toolu_2', NO_PLAN_MODE)]);
    assert.equal(r.id, 'toolu_1');
    assert.equal(r.state, 'active');
    assert.equal(r.current, 'S2');
  });
});

describe('plan-progress — ▶ Plan starten: the approval as an ordinary message (PF-1b)', () => {
  it('planStartMessage is the approval\'s shape: head, the suggested list WITHOUT states, the protocol', () => {
    const p = planNew('toolu_1', SMALL, '', 0);
    const msg = P.planStartMessage(HEAD_START, p);
    assert.equal(msg, planAcceptMessage(HEAD_START, p));
    assert.ok(msg.startsWith(HEAD_START + '\n\n```plan-schritte\n[\n{"id":"S1","titel":"Modul"},'));
    assert.ok(msg.endsWith('\n```\n\n' + PLAN_PROGRESS_PROTOCOL));
    assert.deepEqual(P.planStepsBlockOf(msg), { steps: [{ id: 'S1', title: 'Modul', group: '' }, { id: 'S2', title: 'Route', group: '' }, { id: 'S3', title: 'Tests', group: '' }], status: false });
    assert.equal(P.planStartMessage('', null), '```plan-schritte\n[]\n```\n\n' + PLAN_PROGRESS_PROTOCOL);
    // the composer chip: the typed text is the head
    assert.ok(P.planStartMessage('plan starten', p).startsWith('plan starten\n\n```plan-schritte\n'));
    assert.deepEqual(planStatusExtract(msg), [], 'no status block in it — the panel must not read its own start as a report');
  });

  it('the fold reads a user TEXT with the block as the start of the orphan: active with exactly those steps, then the reports', () => {
    const shown = planNew('toolu_1', SMALL, '', 0);
    shown.steps.pop(); // what the model was SHOWN counts, not what the parser makes of the text now
    for (const str of [false, true]) {
      const r = fold([epm('toolu_1', SMALL), res('toolu_1', NO_PLAN_MODE), user(P.planStartMessage(HEAD_START, shown), { str }),
        say(status('{"aktuell":"S2","erledigt":["S1"]}'))]);
      assert.equal(r.state, 'active', 'content as a string: ' + str);
      assert.ok(r.acceptedAt > 0);
      assert.deepEqual(r.steps.map((s) => [s.id, s.title, s.status]), [['S1', 'Modul', 'completed'], ['S2', 'Route', 'in_progress']]);
      assert.equal(r.gate, 'none', 'still the orphan it was — started by message, not through a gate');
    }
    // the typed „plan starten" with the chip's attachment, and an empty list (a plan the parser reads nothing in)
    const L = PROSE;
    const e = fold([epm('toolu_L', L), res('toolu_L', NO_PLAN_MODE), user(P.planStartMessage('plan starten', planNew('toolu_x', L, '', 0)))]);
    assert.equal(e.state, 'active');
    assert.deepEqual(e.steps, []);
  });

  it('a start also for a proposal whose gate went with its process — and a late result for it re-accepts nothing', () => {
    const r = fold([epm('toolu_1', SMALL), user(panelStart(SMALL))]);
    assert.equal(r.state, 'active');
    assert.equal(r.steps.length, 3);
    const late = fold([epm('toolu_1', SMALL), user(panelStart(SMALL)), say(status('{"aktuell":"S2"}')), res('toolu_1', panelAccept(SMALL))]);
    assert.equal(late.current, 'S2', 'planAccept would have reset the current step');
  });

  it('nothing to start → no effect: no plan, a superseded proposal, a finished plan', () => {
    assert.equal(fold([user(panelStart(SMALL))]), null);
    assert.equal(fold([epm('toolu_1', SMALL), res('toolu_1', 'Bitte den Plan noch nicht ausführen — weiter planen.'), user(panelStart(SMALL))]).state, 'superseded');
    assert.equal(fold([epm('toolu_1', SMALL), res('toolu_1', panelAccept(SMALL)), say(status('{"fertig":true}')), user(panelStart(SMALL))]).state, 'done');
  });

  it('not the user speaking → no start: a line with a tool_result, a compaction summary, a meta line, a sidechain; a duplicate once', () => {
    const base = [epm('toolu_1', SMALL), res('toolu_1', NO_PLAN_MODE)];
    const msg = panelStart(SMALL);
    const withResult = { type: 'user', uuid: 'u' + (++UID), timestamp: ts(UID),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }, { type: 'text', text: msg }] } };
    for (const [label, l] of [['tool_result', withResult], ['compact', user(msg, { compact: true })], ['compact str', user(msg, { compact: true, str: true })],
      ['meta', user(msg, { meta: true })], ['sidechain', user(msg, { side: true })]]) {
      assert.equal(fold(base.concat([l])).state, 'proposed', label);
    }
    // the same line twice (re-written after a compaction): folded once — a second start would reset the progress
    const s = user(msg);
    const r = fold(base.concat([s, say(status('{"aktuell":"S2","erledigt":["S1"]}')), compact(), s]));
    assert.equal(r.current, 'S2');
    assert.equal(r.steps[0].status, 'completed');
  });

  it('the text part with the block is the LAST one — the panel sends pasted attachments first', () => {
    // a pasted note that happens to quote an older start: its list is not what this message started
    const pasted = 'alte-nachricht.txt\n' + P.planStartMessage('vorher', { steps: [{ id: 'S1', title: 'Alt', group: '', status: 'pending' }] });
    const l = { type: 'user', uuid: 'u' + (++UID), timestamp: ts(UID), message: { role: 'user', content: [
      { type: 'text', text: pasted }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
      { type: 'text', text: panelStart(SMALL) }] } };
    const r = fold([epm('toolu_1', SMALL), res('toolu_1', NO_PLAN_MODE), l]);
    assert.equal(r.state, 'active');
    assert.deepEqual(titles(r.steps), ['Modul', 'Route', 'Tests']);
  });

  it('while another plan is underway a start begins the NEWEST orphan (its card); the plan underway goes into the history', () => {
    const second = '# Plan: Zweiter\n## Umsetzung\n### X\n### Y\n';
    const run = [epm('toolu_1', SMALL), res('toolu_1', panelAccept(SMALL)), say(status('{"aktuell":"S2","erledigt":["S1"]}'))];
    const r = fold(run.concat([epm('toolu_2', second), res('toolu_2', NO_PLAN_MODE), user(panelStart(second))]));
    assert.equal(r.id, 'toolu_2');
    assert.equal(r.state, 'active');
    assert.deepEqual(titles(r.steps), ['X', 'Y']);
    assert.deepEqual(r.history.map((h) => [h.id, h.state, h.done]), [['toolu_1', 'replaced', 1]]);
    // without an orphan a start while a plan is underway does nothing
    const none = fold(run.concat([user(panelStart(SMALL))]));
    assert.equal(none.id, 'toolu_1');
    assert.equal(none.current, 'S2');
  });
});

describe('plan-progress — [Stand abfragen] / 📋 Schritte anfordern: one question, never a start (PF-1b)', () => {
  it('planStepsRequestMessage: with steps the list WITH each state, without steps no block at all — the protocol always', () => {
    const p = accepted();
    planApplyStatus(p, { aktuell: 'S2', erledigt: ['S1'] }, 3);
    const q = P.planStepsRequestMessage('Wo stehen wir?', p);
    assert.equal(q, 'Wo stehen wir?\n\n' + planStepsBlock(p, { status: true }) + '\n\n' + PLAN_PROGRESS_PROTOCOL);
    assert.equal(P.planStepsBlockOf(q).status, true);
    const empty = planAccept(planNew('toolu_L', PROSE, '', 0), null, 1);
    assert.equal(P.planStepsRequestMessage('Melde die Liste.', empty), 'Melde die Liste.\n\n' + PLAN_PROGRESS_PROTOCOL);
    assert.equal(P.planStepsRequestMessage('  x  ', null), 'x\n\n' + PLAN_PROGRESS_PROTOCOL);
    assert.equal(P.planStepsRequestMessage('', null), PLAN_PROGRESS_PROTOCOL);
    assert.deepEqual(planStatusExtract(q), [], 'the question holds no report either');
  });

  it('planStepsBlockOf tells a question from a start by the entries\' states — independent of the UI language', () => {
    assert.deepEqual(P.planStepsBlockOf('```plan-schritte\n[{"id":"S1","titel":"A","status":"offen"}]\n```'), { steps: [{ id: 'S1', title: 'A', group: '' }], status: true });
    assert.equal(P.planStepsBlockOf('```plan-schritte\n[{"id":"S1","titel":"A","stand":"läuft"}]\n```').status, true);
    assert.equal(P.planStepsBlockOf('```plan-schritte\n[{"id":"S1","titel":"A"},"B"]\n```').status, false);
    assert.equal(P.planStepsBlockOf('```plan-schritte\n[]\n```').status, false);
    for (const t of ['kein Block', '```plan-schritte\n{"id":"S1"}\n```', '```plan-schritte\n{ kaputt\n```', null]) assert.equal(P.planStepsBlockOf(t), null, String(t));
  });

  it('the question in a transcript starts nothing: not with a plan underway, not with an orphan — the ANSWER does', () => {
    const run = [epm('toolu_1', SMALL), res('toolu_1', panelAccept(SMALL)), say(status('{"aktuell":"S2","erledigt":["S1"]}'))];
    const before = fold(run);
    assert.deepEqual(fold(run.concat([user(P.planStepsRequestMessage('Wo stehen wir im Plan?', planRestore(before)))])), before);
    // an older panel sent `[]` for a plan without steps — while it is underway that is no start either
    const L = PROSE;
    const living = [epm('toolu_L', L), res('toolu_L', panelAccept(L))];
    assert.deepEqual(fold(living.concat([user('Wo stehen wir im Plan?\n\n```plan-schritte\n[]\n```\n\n' + PLAN_PROGRESS_PROTOCOL)])), fold(living));
    // an orphan with the parser's steps: „Schritte anfordern" carries their states → no start (the model may not answer)
    const orphan = [epm('toolu_1', SMALL), res('toolu_1', NO_PLAN_MODE)];
    const ask = user(P.planStepsRequestMessage('Melde die Schrittliste.', planNew('toolu_1', SMALL, '', 0)));
    assert.equal(fold(orphan.concat([ask])).state, 'proposed');
    const ans = fold(orphan.concat([ask, say(status('{"schritte":[{"id":"S1","titel":"Modul"},{"id":"S2","titel":"Route"}],"aktuell":"S1"}'))]));
    assert.equal(ans.state, 'active');
    assert.equal(ans.id, 'toolu_1', 'the answer is about the orphan — no plan of its own');
    assert.deepEqual(titles(ans.steps), ['Modul', 'Route']);
  });
});

describe('plan-progress — a plan the model reports on its own (planFromStatus, PF-1b)', () => {
  const U = (o) => planStatusNormalize(o);
  const META = { title: 'Letzter Vorschlag', file: 'C:\\Users\\x\\.claude\\plans\\test-plan.md' };

  it('no plan + a report with "schritte" → an active plan of the model, named by "titel", else after the last proposal', () => {
    const r = planFromStatus(null, U({ titel: 'QA-Lauf', schritte: ['Inventar', 'Workflow'], aktuell: 'S1', aktiv: 'lege Testdaten an' }), META, 5000);
    assert.deepEqual([r.created, r.changed, r.structural, r.unknown], [true, true, true, 0]);
    const p = r.plan;
    assert.deepEqual([p.state, p.src, p.gate, p.title, p.file], ['active', 'model', 'none', 'QA-Lauf', ''], 'its own name — not the file of the proposal before it');
    assert.match(p.id, /^status:[0-9a-z]+$/);
    assert.deepEqual(p.steps.map((s) => [s.id, s.title, s.status]), [['S1', 'Inventar', 'in_progress'], ['S2', 'Workflow', 'pending']]);
    assert.equal(p.activeForm, 'lege Testdaten an');
    assert.deepEqual([p.acceptedAt, p.reportedAt, p.updatedAt], [5000, 5000, 5000]);
    assert.deepEqual(planRestore(JSON.parse(JSON.stringify(planSave(p)))), planSave(p), 'restorable as it is (the id passes planIdOf)');
    const unnamed = planFromStatus(null, U({ schritte: ['A', 'B'] }), META, 1).plan;
    assert.deepEqual([unnamed.title, unnamed.file], ['Letzter Vorschlag', META.file], 'no "titel": the plan last proposed, with its file');
    const same = planFromStatus(null, U({ titel: 'letzter vorschlag!', schritte: ['A', 'B'] }), META, 1).plan;
    assert.equal(same.file, META.file, 'a "titel" that IS the proposal\'s name (case and punctuation aside) keeps its file');
    assert.equal(planFromStatus(null, U({ schritte: ['A', 'B'] }), null, 1).plan.title, '', 'no name to be had — the rail says „Plan"');
    assert.equal(planFromStatus(null, U({ schritte: ['A', 'B'] }), { title: 'x', file: 'C:\\bad\u0007.md' }, 1).plan.file, '');
  });

  it('without "schritte" nothing is started — a bare step change has nothing to show', () => {
    for (const u of [U({ aktuell: 'S1' }), U({ erledigt: ['S1'], fertig: true }), U({ titel: 'Nur ein Name' }), null, undefined, 'x']) {
      assert.deepEqual(planFromStatus(null, u, META, 1), { plan: null, created: false, changed: false, structural: false, unknown: 0 }, JSON.stringify(u));
    }
  });

  it('the id comes from the report, not from a clock or a uuid — the live tab and the fold derive the same one', () => {
    const u = U({ titel: 'QA-Lauf', schritte: ['Inventar', 'Workflow'], aktuell: 'S1' });
    const a = planFromStatus(null, u, META, 1).plan.id;
    assert.equal(planFromStatus(null, u, { title: 'anders' }, 999999).plan.id, a);
    assert.notEqual(planFromStatus(null, U({ titel: 'QA-Lauf', schritte: ['Inventar', 'Workflow', 'Bericht'] }), META, 1).plan.id, a);
    assert.notEqual(planFromStatus(null, U({ titel: 'Anderer Lauf', schritte: ['Inventar', 'Workflow'] }), META, 1).plan.id, a);
  });

  it('a proposal (an orphan, too) or a plan underway: the report is about IT — an active plan is never split or renamed', () => {
    const orphan = P.planOrphan(planNew('toolu_1', SMALL, '', 1));
    const r = planFromStatus(orphan, U({ titel: 'Eigener Name', schritte: ['A', 'B'], aktuell: 'S1' }), META, 7);
    assert.equal(r.created, false);
    assert.equal(r.plan, orphan);
    assert.equal(orphan.state, 'active');
    assert.equal(orphan.title, 'Testvorhaben', 'the proposal\'s name stays');
    const run = accepted();
    const r2 = planFromStatus(run, U({ titel: 'Paraphrase des Modells', schritte: ['Modul', 'Route', 'Tests'], aktuell: 'S1' }), META, 8);
    assert.equal(r2.plan, run);
    assert.deepEqual([run.id, run.title], ['toolu_A', 'Testvorhaben']);
    // not even with a list of its own: the first report after an approval may replace the suggestion entirely (the
    // living plan's two headings → the model's finer list), and that is the approved plan, not a new one
    const run2 = accepted();
    const r2b = planFromStatus(run2, U({ titel: 'QA-Lauf im Detail', schritte: ['Rollen', 'Testdaten', 'Antrag', 'Freigabe'], aktuell: 'S1' }), META, 8);
    assert.equal(r2b.created, false);
    assert.equal(r2b.plan, run2);
    assert.deepEqual([run2.id, run2.src, titles(run2.steps).join()], ['toolu_A', 'model', 'Rollen,Testdaten,Antrag,Freigabe']);
    // …but a plan WITHOUT a name takes the one a report brings
    const nameless = accepted();
    nameless.title = '';
    const r3 = planFromStatus(nameless, U({ titel: 'Endlich ein Name', aktiv: 'x' }), META, 9);
    assert.equal(nameless.title, 'Endlich ein Name');
    assert.equal(r3.structural, true, 'the title is in the rail\'s guard, so the rail must be rebuilt');
  });

  it('after „Weiter planen" a model that works anyway starts its own plan; the superseded proposal leaves no history', () => {
    const sup = planSupersede(planNew('toolu_1', SMALL, '', 1));
    const r = planFromStatus(sup, U({ schritte: ['A', 'B'], aktuell: 'S1' }), { title: sup.title, file: sup.file }, 5);
    assert.equal(r.created, true);
    assert.equal(r.plan.title, 'Testvorhaben');
    assert.deepEqual(r.plan.history, []);
  });

  it('a finished or dismissed plan: the same plan unless the report names ANOTHER one — a dismissal stays the user\'s', () => {
    const done = accepted();
    planApplyStatus(done, { erledigt: ['S1', 'S2', 'S3'], fertig: true }, 3);
    const same = planFromStatus(done, U({ schritte: ['Modul', 'Route', 'Tests', 'Nachtrag'], aktuell: 'S4' }), META, 4);
    assert.equal(same.created, false, 'a correction after „fertig" is still about it');
    assert.equal(same.plan.state, 'active');
    assert.equal(same.plan.steps[0].status, 'completed');
    const done2 = accepted();
    planApplyStatus(done2, { fertig: true }, 3);
    assert.equal(planFromStatus(done2, U({ titel: 'testvorhaben!', schritte: ['X'] }), META, 4).created, false, 'its own name, case and punctuation aside');
    const done3 = accepted();
    planApplyStatus(done3, { erledigt: ['S1'], fertig: true }, 3);
    const next = planFromStatus(done3, U({ titel: 'Nächster Auftrag', schritte: ['X', 'Y'], aktuell: 'S1' }), META, 5);
    assert.equal(next.created, true);
    assert.deepEqual(next.plan.steps.map((s) => s.status), ['in_progress', 'pending'], 'nothing carried over by ID from the finished plan');
    assert.deepEqual(next.plan.history.map((h) => [h.id, h.state, h.done]), [['toolu_A', 'done', 1]]);
    const dis = planDismiss(accepted());
    const kept = planFromStatus(dis, U({ schritte: ['Modul', 'Route'], aktuell: 'S2' }), META, 6);
    assert.equal(kept.plan, dis);
    assert.equal(dis.state, 'dismissed');
    // a dismissed plan UNDERWAY: still underway for the transcript — a report under another "titel" is about it, as
    // the fold reads it (an active plan is never split). It used to start a new plan live, and a resume then brought
    // the dismissed plan back with the new list under its old name.
    const under = planDismiss(accepted());
    const other = planFromStatus(under, U({ titel: 'Ganz anderes', schritte: ['A', 'B'] }), META, 7);
    assert.deepEqual([other.created, other.plan, under.state, under.dismissedFrom], [false, under, 'dismissed', 'active']);
    // a dismissed FINISHED plan: a new one may begin, exactly as after a finished one the fold sees
    const fin = accepted(); planApplyStatus(fin, { fertig: true }, 3); planDismiss(fin);
    const next2 = planFromStatus(fin, U({ titel: 'Ganz anderes', schritte: ['A', 'B'] }), META, 7);
    assert.equal(next2.created, true);
    assert.equal(next2.plan.state, 'active');
    assert.deepEqual(next2.plan.history.map((h) => h.state), ['done']);
  });

  it('live and resume agree after a dismissal — the report moves the plan underneath it, the × stays (planAdopt)', () => {
    const A = '# Plan A\n\n## Umsetzung\n### 1. Eins\nx\n### 2. Zwei\nx\n';
    const rep = status('{"titel":"Neues Vorhaben","schritte":[{"id":"S1","titel":"Alpha"},{"id":"S2","titel":"Beta"},{"id":"S3","titel":"Gamma"}],"aktuell":"S1"}');
    const lines = [epm('toolu_A', A), res('toolu_A', panelAccept(A))];
    // live: approved, put away by ×, then the model reports another plan on its own
    let live = planPromote(null, planNew('toolu_A', A, '', 1), null, 2);
    planDismiss(live);
    live = planFromStatus(live, planStatusExtract(rep)[0], null, 3).plan;
    const folded = fold(lines.concat([say(rep)]));
    const resumed = planAdopt(live, folded);
    assert.deepEqual([live.id, live.state], [folded.id, 'dismissed'], 'the same plan in both — the dismissal only live');
    assert.deepEqual([resumed.id, resumed.state, resumed.dismissedFrom], ['toolu_A', 'dismissed', 'active'], 'the resume keeps it put away');
    assert.deepEqual(titles(resumed.steps), titles(live.steps));
    // …and it travels through planSave (cc_tabs) with the state underneath
    assert.equal(planRestore(JSON.parse(JSON.stringify(planSave(live)))).dismissedFrom, 'active');
    assert.equal(planRestore({ ...planSave(live), dismissedFrom: 'bogus' }).dismissedFrom, undefined);
    // finished underneath: the report that finishes it finishes it there too, and the next plan may begin
    planApplyStatus(live, { fertig: true }, 4);
    assert.deepEqual([live.state, P.planStateSeen(live)], ['dismissed', 'done']);
    // a proposal put away, then „Weiter planen" on its card: off the table underneath (the fold supersedes it)
    const prop = planDismiss(planNew('toolu_P', SMALL, '', 0));
    planSupersede(prop, 'toolu_P');
    assert.deepEqual([prop.state, P.planStateSeen(prop)], ['dismissed', 'superseded']);
    // a new proposal while a dismissed plan is underway waits in its card — as the fold keeps the plan underway on top
    const run = planDismiss(accepted());
    assert.equal(planOffer(run, planNew('toolu_C', SMALL, '', 5)), run);
  });

  it('a list re-sent after a compaction under the model\'s OWN name is still that plan — the dismissal holds, the ticks stay', () => {
    // the hint's first example leads with "titel", so a re-send will often carry a paraphrase of the heading
    const dis = planDismiss(accepted());
    planApplyStatus(dis, { erledigt: ['S1'] }, 2);
    const r = planFromStatus(dis, U({ titel: 'Das Testvorhaben umsetzen', schritte: ['Modul', 'Route', 'Tests'], aktuell: 'S2' }), META, 3);
    assert.equal(r.created, false);
    assert.equal(dis.state, 'dismissed');
    assert.equal(dis.steps[0].status, 'completed');
    // half the list shared is still the same plan; less than half is another one
    const done = () => { const d = accepted('# P\n## Umsetzung\n### A\n### B\n### C\n### D\n'); planApplyStatus(d, { fertig: true }, 2); return d; };
    assert.equal(planFromStatus(done(), U({ titel: 'Neu', schritte: ['A', 'B', 'X', 'Y'] }), META, 3).created, false);
    assert.equal(planFromStatus(done(), U({ titel: 'Neu', schritte: ['A', 'X', 'Y'] }), META, 3).created, true);
  });

  it('the fold: a report on its own makes the same plan — after nothing at all, or about the orphan it belongs to', () => {
    const t = '{"titel":"QA-Lauf","schritte":["Inventar","Workflow"],"aktuell":"S1"}';
    const r = fold([say('Ich starte.\n' + status(t))]);
    assert.deepEqual([r.state, r.src, r.title, r.id], ['active', 'model', 'QA-Lauf', planFromStatus(null, planStatusExtract(status(t))[0], null, 0).plan.id]);
    // the 05.10. course, synthetically: refused outside plan mode, „plan starten" typed WITHOUT the chip, the model
    // works — and now reports, because the system hint asks it to: the report is about the orphan on the table
    const L = livingPlan(LIVING_CURRENT).md;
    const o = fold([epm('toolu_L', L, { slug: 'tingly-test' }), res('toolu_L', NO_PLAN_MODE), user('plan starten', { str: true }),
      say('Ich starte mit Schritt 0.\n' + status('{"schritte":["Inventar","Workflow"],"aktuell":"S1"}'))]);
    assert.deepEqual([o.id, o.state, o.src], ['toolu_L', 'active', 'model']);
    assert.equal(planFileName(o.file), 'tingly-test.md');
    // a sidechain's report is a subagent's, never a plan of the session
    assert.equal(fold([say(status(t), { side: true })]), null);
  });
});

describe('plan-progress — the checklist marks (PF-1b)', () => {
  it('planStepMark: ✓ done, ⏳ running, ☐ open, ⤼ skipped — anything else is open', () => {
    const { planStepMark } = P;
    assert.deepEqual(['completed', 'in_progress', 'pending', 'skipped'].map(planStepMark), ['✓', '⏳', '☐', '⤼']);
    for (const v of ['', 'done', 'constructor', '__proto__', 'toString', null, undefined, 3, {}]) assert.equal(planStepMark(v), '☐', String(v));
  });
});

describe('plan-progress — what an outgoing message does to the proposal on the table (PF-1b, step 2)', () => {
  it('planOutgoingKind: a start block without states, the keep sentence in both languages — and nothing else', () => {
    const { planOutgoingKind } = P;
    const p = planNew('toolu_1', SMALL, '', 0);
    assert.equal(planOutgoingKind(P.planStartMessage(HEAD_START, p)), 'start');
    assert.equal(planOutgoingKind('plan starten\n\n' + P.planStartMessage('', p)), 'start', 'the chip: typed text first');
    assert.equal(planOutgoingKind(P.planStartMessage('', null)), 'start', 'an empty list is a start too (the model lists them)');
    // the keep sentences are the dictionary's own (chat-render.bitteDenPlanNoch), read back like planIsApproval does
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'js', 'i18n.js'), 'utf8');
    const keep = src.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("'chat-render.bitteDenPlanNoch': '"))
      .map((l) => l.slice("'chat-render.bitteDenPlanNoch': '".length).replace(/',?$/, '').replace(/\\'/g, "'"));
    assert.equal(keep.length, 2, 'de + en');
    for (const k of keep) { assert.equal(planOutgoingKind(k), 'keep', k); assert.equal(planOutgoingKind('  ' + k + '\n\nErst die Route.'), 'keep'); }
    for (const t of [P.planStepsRequestMessage('Wo stehen wir?', accepted()), P.planStepsRequestMessage('Melde die Liste.', null),
      'plan starten', 'Danke! Bitte den Plan noch nicht ausführen — weiter planen.', '```plan-schritte\n{ kaputt\n```', '', null, undefined, 7]) {
      assert.equal(planOutgoingKind(t), '', String(t).slice(0, 40));
    }
  });

  it('planStartPick: the proposal on top, else the orphan under a plan underway — never something that is not a proposal', () => {
    const { planStartPick } = P;
    const top = planNew('toolu_1', SMALL, '', 0), orphan = P.planOrphan(planNew('toolu_2', SMALL, '', 0));
    assert.equal(planStartPick(top, orphan), top);
    assert.equal(planStartPick(accepted(), orphan), orphan);
    assert.equal(planStartPick(accepted(), null), null);
    assert.equal(planStartPick(null, planSupersede(planNew('toolu_3', SMALL, '', 0))), null);
    assert.equal(planStartPick(null, null), null);
  });

  it('planMessageSplit: the user row of a start or a question — what was typed, the steps, the kind; anything else is null', () => {
    const { planMessageSplit } = P;
    const p = planNew('toolu_1', SMALL, '', 0);
    assert.deepEqual(planMessageSplit('plan starten\n\n' + P.planStartMessage('', p)), { head: 'plan starten', steps: planStepsNormalize(['Modul', 'Route', 'Tests']), status: false, kind: 'start' });
    assert.deepEqual(planMessageSplit(P.planStartMessage(HEAD_START, null)), { head: HEAD_START, steps: [], status: false, kind: 'start' });
    const q = planMessageSplit(P.planStepsRequestMessage('Wo stehen wir?', accepted()));
    assert.deepEqual([q.head, q.kind, q.status, q.steps.length], ['Wo stehen wir?', 'ask', true, 3]);
    assert.deepEqual(planMessageSplit(P.planStepsRequestMessage('Melde die Liste.', null)), { head: 'Melde die Liste.', steps: [], status: false, kind: 'ask' });
    assert.equal(planMessageSplit(P.planStartMessage('', p) + '\n\n').head, '', 'trailing blanks do not hide the protocol');
    // only the panel's own shape: a protocol quoted in the middle, a block without the protocol, plain text
    for (const t of ['Hier steht ' + PLAN_PROGRESS_PROTOCOL + ' mitten im Text.', '```plan-schritte\n[]\n```', 'plan starten', '', null, 3]) {
      assert.equal(planMessageSplit(t), null, String(t).slice(0, 30));
    }
  });
});

describe('plan-progress — the fold, PF-1b step 2: the keep sentence, and proposals the user talked past', () => {
  const KEEP = 'Bitte den Plan noch nicht ausführen — weiter planen.';
  it('a keep sent from the composer puts the orphan away — as „Weiter planen" through a gate does', () => {
    const r = fold([epm('toolu_1', SMALL), res('toolu_1', NO_PLAN_MODE), user(KEEP + '\n\nErst die Route.')]);
    assert.equal(r.state, 'superseded');
    assert.equal(planVisible(planAdopt(null, r)), false, 'a reloaded tab shows no group for it');
    // a keep under a plan underway puts the orphan away and leaves the plan underway where it was
    const run = [epm('toolu_1', SMALL), res('toolu_1', panelAccept(SMALL)), say(status('{"aktuell":"S2","erledigt":["S1"]}'))];
    const second = '# Plan: Zweiter\n## Umsetzung\n### X\n### Y\n';
    const k = fold(run.concat([epm('toolu_2', second), res('toolu_2', NO_PLAN_MODE), user(KEEP), user(panelStart(second))]));
    assert.deepEqual([k.id, k.state, k.current], ['toolu_1', 'active', 'S2'], 'nothing left that a later start could begin');
    // a keep with nothing on the table changes nothing; a reply that merely quotes the sentence is a reply
    assert.equal(fold(run.concat([user(KEEP)])).state, 'active');
    assert.equal(fold([epm('toolu_1', SMALL), res('toolu_1', NO_PLAN_MODE), user('Danke. ' + KEEP)]).state, 'proposed');
  });

  it('a proposal nobody answered before the user spoke again is orphaned — under a plan underway it is the one ▶ starts', () => {
    // the turn that held its gate ended without a result line (an interrupt, the process gone — 4 of 77 measured)
    const r = fold([epm('toolu_1', SMALL), user('was ist mit dem Plan?')]);
    assert.deepEqual([r.state, r.gate], ['proposed', 'none']);
    const run = [epm('toolu_1', SMALL), res('toolu_1', panelAccept(SMALL)), say(status('{"aktuell":"S2","erledigt":["S1"]}'))];
    const second = '# Plan: Zweiter\n## Umsetzung\n### X\n### Y\n';
    const s = fold(run.concat([epm('toolu_2', second), user('stopp, erst essen'), user(panelStart(second))]));
    assert.deepEqual([s.id, s.state], ['toolu_2', 'active'], 'the live tab orphans that card when it retires it — its ▶ is this start');
    assert.deepEqual(s.history.map((h) => [h.id, h.state]), [['toolu_1', 'replaced']]);
    // the NEWER of two orphans is the one: by the order the proposals came in, not by when they were orphaned
    const third = '# Plan: Dritter\n## Umsetzung\n### P\n### Q\n';
    const t = fold(run.concat([epm('toolu_2', second), epm('toolu_3', third), res('toolu_2', NO_PLAN_MODE), user('weiter'), user(panelStart(third))]));
    assert.equal(t.id, 'toolu_3');
    assert.deepEqual(titles(t.steps), ['P', 'Q']);
    // …and a late result for an abandoned proposal re-decides nothing
    const late = fold([epm('toolu_1', SMALL), user('hallo'), res('toolu_1', panelAccept(SMALL))]);
    assert.deepEqual([late.state, late.gate], ['proposed', 'none']);
  });

  it('not the user speaking abandons nothing: a meta line, a compaction summary, a sidechain, a tool_result for something else', () => {
    for (const l of [user('x', { meta: true }), user('x', { compact: true }), user('x', { side: true }), res('toolu_other', 'ok')]) {
      const r = fold([epm('toolu_1', SMALL), l]);
      assert.deepEqual([r.state, r.gate], ['proposed', ''], JSON.stringify(l).slice(0, 60));
    }
    // a duplicate line (re-written after a compaction) is folded once — the abandon too
    const u = user('hallo');
    assert.equal(fold([epm('toolu_1', SMALL), u, compact(), u]).gate, 'none');
  });

  it('cheap for the common line: a user line with nothing waiting and no plan text is never even recorded as seen', () => {
    const f = planFoldNew();
    for (let i = 0; i < 50; i++) planFoldLine(f, user('nur Text ' + i));
    assert.equal(f.nSeen, 0, 'the duplicate check keeps PLAN_CAPS.seen uuids — ordinary chat must not use them up');
    assert.equal(planFoldLine(f, epm('toolu_1', SMALL)), true);
    assert.equal(planFoldLine(f, user('und jetzt?')), true, 'with a proposal waiting it moves the fold');
  });
});

// ---- PF-1b, the counter-check (Gegencheck): what a message must look like to START something, Stop vs. rejection,
// the slots a reload keeps, and the regex that was quadratic on a run of blanks -------------------------------------
const dictVals = (key) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'js', 'i18n.js'), 'utf8');
  return src.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("'" + key + "': '"))
    .map((l) => l.slice(("'" + key + "': '").length).replace(/',?$/, '').replace(/\\'/g, "'"));
};
// the [Stand abfragen] message of #85 (main c194b93) for a plan without steps — its EMPTY block stated no status, which
// is what a start looks like; the protocol of that time is quoted as it was (it had no "titel" yet)
const OLD_PROTOCOL = 'Plan-Fortschritt: Beginne die Umsetzung mit einem Codeblock der Sprache `plan-status`, der die Schrittliste festlegt: {"schritte":[{"id":"S1","titel":"…"}],"aktuell":"S1"} — übernimm die vorgeschlagene Liste aus dem `plan-schritte`-Block oder ersetze sie (höchstens 30 Schritte, IDs S1, S2, …; ist der Block leer, stelle die Liste selbst auf). Melde danach jeden Schrittwechsel als eigenen `plan-status`-Block {"aktuell":"S3","erledigt":["S1","S2"],"aktiv":"…"} direkt vor dem ersten Werkzeugaufruf des Schritts; "aktiv" sagt in einem kurzen Satz, was gerade passiert. Bei Bedarf "uebersprungen":["S4"] für ausgelassene und "offen":["S2"] für wieder geöffnete Schritte. Am Ende {"erledigt":[…],"fertig":true}. Das Panel blendet die Blöcke aus und zeigt den Stand in der Seitenleiste — erwähne sie nicht im Fließtext. Kennst du die IDs nicht mehr (z. B. nach einer Kompaktierung), sende "schritte" neu.';
const oldAsk = (head) => head + '\n\n```plan-schritte\n[]\n```\n\n' + OLD_PROTOCOL;
const QUOTED = 'Schau mal, so sah das im anderen Tab aus:\n\n```plan-schritte\n[{"id":"S1","titel":"Fremd A"},{"id":"S2","titel":"Fremd B"}]\n```\n\nWas meinst du?';

describe('plan-progress — only the panel\'s own attachment starts a plan (planPanelTail, PF-1b counter-check)', () => {
  it('the protocol opens with PLAN_PROTOCOL_HEAD, now and in #85 — the anchor every start and question is read by', () => {
    assert.ok(PLAN_PROGRESS_PROTOCOL.startsWith(P.PLAN_PROTOCOL_HEAD));
    assert.ok(OLD_PROTOCOL.startsWith(P.PLAN_PROTOCOL_HEAD));
    assert.equal(PLAN_PROGRESS_PROTOCOL.indexOf('\n'), -1, 'one line — planPanelTail takes the last paragraph as the protocol only when it is one');
  });

  it('a block quoted in a message, or pasted along as a text attachment, starts nothing — live and in the fold', () => {
    const { planOutgoingKind } = P;
    assert.equal(planOutgoingKind(QUOTED), '');
    assert.equal(planOutgoingKind('Hier die alte Nachricht:\n\n' + panelStart(SMALL) + '\n\nund das ist meine Frage'), '', 'a start followed by more text is a quote');
    // lib/chat.js sendToChat wraps a pasted text attachment in a fence of its own — its protocol never ends the part
    assert.equal(planOutgoingKind('Eingefügter Text\n```\n' + panelStart(SMALL) + '\n```'), '');
    // the fold, under a plan underway with an orphan beneath it: the quote changes nothing
    const run = [epm('toolu_1', SMALL), res('toolu_1', panelAccept(SMALL)), say(status('{"aktuell":"S2","erledigt":["S1"]}'))];
    const second = '# Plan: Zweiter\n## Umsetzung\n### X\n### Y\n';
    const lines = run.concat([epm('toolu_2', second), res('toolu_2', NO_PLAN_MODE), user(QUOTED)]);
    const r = fold(lines);
    assert.deepEqual([r.id, r.state, r.current], ['toolu_1', 'active', 'S2']);
    const f = planFoldNew(); lines.forEach((l) => planFoldLine(f, l));
    assert.equal(P.planFoldOrphan(f).id, 'toolu_2', 'the orphan stays where it was');
    // …and with no plan underway: the orphan stays an orphan
    assert.equal(fold([epm('toolu_1', SMALL), res('toolu_1', NO_PLAN_MODE), user(QUOTED)]).state, 'proposed');
    // a pasted attachment WITH a start, typed text without one: the typed part decides, as live (planNoteOutgoing gets
    // only the typed text) — sendToChat sends the attachment as the FIRST part, the typed message as the last
    const two = { type: 'user', uuid: 'u-two', timestamp: ts(1), message: { role: 'user', content: [
      { type: 'text', text: 'Eingefügter Text\n```\n' + panelStart(SMALL) + '\n```' }, { type: 'text', text: 'schau dir das an' }] } };
    assert.equal(fold([epm('toolu_1', SMALL), res('toolu_1', NO_PLAN_MODE), two]).state, 'proposed');
    // …even when an earlier part IS a start in the panel's shape (a transcript another client wrote): only the last
    // part, the typed one, is what the live tab read when the message went out
    const bare = { type: 'user', uuid: 'u-bare', timestamp: ts(2), message: { role: 'user', content: [
      { type: 'text', text: panelStart(SMALL) }, { type: 'text', text: 'schau dir das an' }] } };
    assert.equal(fold([epm('toolu_1', SMALL), res('toolu_1', NO_PLAN_MODE), bare]).state, 'proposed');
  });

  it('the chip\'s attachment after a quoted block: the LAST block counts — the plan\'s own list, not the quoted one', () => {
    const p = planNew('toolu_1', SMALL, '', 0);
    const out = QUOTED + '\n\n' + P.planStartMessage('', p);
    assert.equal(P.planOutgoingKind(out), 'start');
    assert.deepEqual(titles(P.planStartBlockOf(out).steps), ['Modul', 'Route', 'Tests']);
    const r = fold([epm('toolu_1', SMALL), res('toolu_1', NO_PLAN_MODE), user(out)]);
    assert.deepEqual([r.state, titles(r.steps)], ['active', ['Modul', 'Route', 'Tests']]);
  });

  it('[Stand abfragen] of #85 with an empty list is a question, not a start — in both languages, as a fixture of that time', () => {
    const asks = dictVals('chat-side.planStandFrage');
    assert.equal(asks.length, 2, 'de + en');
    for (const h of asks) {
      assert.equal(P.planOutgoingKind(oldAsk(h)), '', h.slice(0, 30));
      assert.equal(P.planMessageSplit(oldAsk(h)).kind, 'ask', 'and its row folds as a question');
    }
    // the fold: a plan approved with an empty list, an orphan beneath it, then that old question → the orphan stays
    const empty = '# Plan: Leer\n\nNur Prosa.\n';
    const r = fold([epm('toolu_1', empty), res('toolu_1', panelAccept(empty)), epm('toolu_2', SMALL), user('stopp'), user(oldAsk(asks[0]))]);
    assert.deepEqual([r.id, r.state], ['toolu_1', 'active'], 'it used to make the orphan the plan underway');
    // a typed „Wo stehen wir im Plan?" with the chip is still a start: only the panel's two opening sentences count
    assert.equal(P.planOutgoingKind('Wo stehen wir im Plan?\n\n' + P.planStartMessage('', planNew('toolu_1', SMALL, '', 0))), 'start');
  });

  it('the start head alone (▶ with the switch off) is an UNTRACKED start: no plan, live and in the fold — anchored at both ends', () => {
    const heads = dictVals('chat-side.planStartKopf');
    assert.equal(heads.length, 2, 'de + en');
    const cand = planNew('toolu_1', SMALL, '', 0);
    for (const h of heads) {
      assert.equal(P.planOutgoingKind(h), 'untracked', h);
      assert.equal(P.planOutgoingKind('  ' + h + '\n'), 'untracked');
      assert.equal(P.planOutgoingKind(h + ' Und noch etwas.'), '', 'more than the head is a message');
      assert.equal(P.planOutgoingKind('Okay. ' + h), '');
      assert.equal(P.planOutgoingKind(P.planStartMessage(h, cand)), 'start', 'with the list and the protocol it is the ordinary start');
    }
    assert.equal(fold([epm('toolu_1', SMALL), res('toolu_1', NO_PLAN_MODE), user(heads[0])]), null, 'it used to stay on the table — ▶ again after a reload');
    // under a plan underway, started from the orphan's card: the plan underway is over too (as through a gate)
    const run = [epm('toolu_1', SMALL), res('toolu_1', panelAccept(SMALL))];
    const f = planFoldNew();
    run.concat([epm('toolu_2', SMALL), res('toolu_2', NO_PLAN_MODE), user(heads[1])]).forEach((l) => planFoldLine(f, l));
    assert.deepEqual([planFoldResult(f), P.planFoldOrphan(f)], [null, null]);
    // nothing on the table: nothing happens
    assert.equal(fold(run.concat([user(heads[0])])).state, 'active');
  });
});

describe('plan-progress — Stop on a waiting plan card vs. a rejection (PF-1b counter-check)', () => {
  // the shapes measured in 446598fa… (structure only; after the first sentence the wording is the CLI's boilerplate)
  const STOP = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
  const INTERRUPT = '[Request interrupted by user for tool use]';
  it('„doesn\'t want to proceed" + the interrupt marker = a Stop: the proposal stays on the table, orphaned — as the live card', () => {
    const r = fold([epm('toolu_1', SMALL), res('toolu_1', STOP), user(INTERRUPT)]);
    assert.deepEqual([r.state, r.gate], ['proposed', 'none']);
    assert.equal(planVisible(planAdopt(null, r)), true);
    // …and so it can be started by message afterwards
    assert.equal(fold([epm('toolu_1', SMALL), res('toolu_1', STOP), user(INTERRUPT), user(panelStart(SMALL))]).state, 'active');
    // under a plan underway: the orphan the card's ▶ starts
    const f = planFoldNew();
    [epm('toolu_A', SMALL), res('toolu_A', panelAccept(SMALL)), epm('toolu_B', SMALL), res('toolu_B', STOP), user(INTERRUPT)].forEach((l) => planFoldLine(f, l));
    assert.deepEqual([planFoldResult(f).id, P.planFoldOrphan(f).id, P.planFoldOrphan(f).gate], ['toolu_A', 'toolu_B', 'none']);
  });
  it('without the interrupt marker it is a rejection: off the table — the model answering, the user typing, the transcript ending', () => {
    for (const next of [say('Verstanden, ich plane weiter.'), user('nein, anders'), null]) {
      const r = fold([epm('toolu_1', SMALL), res('toolu_1', STOP)].concat(next ? [next] : []));
      assert.equal(r.state, 'superseded', next ? JSON.stringify(next.message.content).slice(0, 40) : 'end of transcript');
    }
    // a meta line or a system line in between decides nothing — the marker after it still makes it a Stop
    assert.equal(fold([epm('toolu_1', SMALL), res('toolu_1', STOP), user('x', { meta: true }), compact(), user(INTERRUPT)]).gate, 'none');
    // the marker with no reject waiting does not touch a plan underway
    assert.equal(fold([epm('toolu_A', SMALL), res('toolu_A', panelAccept(SMALL)), user(INTERRUPT)]).state, 'active');
  });
});

describe('plan-progress — what a reload keeps beside the plan: the orphan under it, the last proposal\'s name (PF-1b counter-check)', () => {
  it('planFoldOrphan / planAdoptOrphan: only a proposal, orphaned, never the plan itself; undefined keeps the tab\'s', () => {
    const f = planFoldNew();
    [epm('toolu_A', SMALL), res('toolu_A', panelAccept(SMALL)), epm('toolu_B', '# Plan: B\n## Umsetzung\n### Alpha\n### Beta\n'), res('toolu_B', NO_PLAN_MODE)]
      .forEach((l) => planFoldLine(f, l));
    const o = P.planFoldOrphan(f);
    assert.deepEqual([o.id, o.state, o.gate, titles(o.steps)], ['toolu_B', 'proposed', 'none', ['Alpha', 'Beta']]);
    assert.equal(o.text, undefined, 'never the plan text');
    assert.equal(P.planFoldOrphan(planFoldNew()), null);
    const local = { ...planNew('toolu_B', SMALL, '', 0), text: '# lokal' };
    assert.equal(P.planAdoptOrphan(local, undefined), local);
    assert.equal(P.planAdoptOrphan(local, null), null);
    assert.equal(P.planAdoptOrphan(local, o).text, '# lokal', 'the live text of the same proposal stays');
    assert.equal(P.planAdoptOrphan(null, { ...o, state: 'active' }), null, 'only a proposal is an orphan');
    assert.equal(P.planAdoptOrphan(null, { ...o, gate: '' }).gate, 'none', 'its gate went with the process that asked');
  });
  it('planFoldLast / planLastRestore: the newest proposal\'s name and file, forced like everything from outside', () => {
    const KEEP = 'Bitte den Plan noch nicht ausführen — weiter planen.';
    const f = planFoldNew();
    [epm('toolu_X', '# Demoprojekt QA\n', { slug: 'qa' }), res('toolu_X', KEEP)].forEach((l) => planFoldLine(f, l));
    assert.deepEqual(P.planFoldLast(f), { title: 'Demoprojekt QA', file: 'C:\\Users\\x\\.claude\\plans\\qa.md' });
    assert.equal(P.planFoldLast(planFoldNew()), null);
    assert.deepEqual(P.planLastRestore({ title: 'x'.repeat(500), file: 'C:\\bad\u0007.md' }), { title: 'x'.repeat(89) + '…', file: '' });
    for (const v of [null, undefined, 'x', 3, []]) assert.equal(P.planLastRestore(v), null, String(v));
    // the name a report without "titel" gets after a reload is the one the fold gives it
    const rep = status('{"schritte":[{"id":"S1","titel":"Eins"},{"id":"S2","titel":"Zwei"}],"aktuell":"S1"}');
    const folded = fold([epm('toolu_X', '# Demoprojekt QA\n', { slug: 'qa' }), res('toolu_X', KEEP), say(rep)]);
    const meta = P.planLastRestore(JSON.parse(JSON.stringify(P.planFoldLast(f))));
    const live = planFromStatus(planAdopt(null, planFoldResult(f)), planStatusExtract(rep)[0], meta, 9).plan;
    assert.deepEqual([live.id, live.title, live.file], [folded.id, folded.title, folded.file]);
    assert.equal(live.title, 'Demoprojekt QA');
  });
});

describe('plan-progress — linear on a long run of blanks (PF-1b counter-check)', () => {
  it('planMessageSplit / planOutgoingKind: 200 000 blanks inside a text cost no time (the /\\s+$/ replace took 6,9 s at 40 000)', () => {
    const long = 'a' + ' '.repeat(200000) + 'x';
    const withHead = 'a' + ' '.repeat(200000) + '\n' + P.PLAN_PROTOCOL_HEAD + ' und weiter';
    const withBlock = '```plan-schritte\n[' + ' '.repeat(200000) + ']\n```\n\n' + PLAN_PROGRESS_PROTOCOL;
    const t0 = Date.now();
    for (const s of [long, withHead, withBlock, '\n'.repeat(200000) + 'x']) { P.planMessageSplit(s); P.planOutgoingKind(s); }
    assert.ok(Date.now() - t0 < 50, 'took ' + (Date.now() - t0) + ' ms');
    assert.equal(P.planMessageSplit(withBlock).kind, 'start');
  });
});

// ---- PF-2: the model's own tasks at the step they name ---------------------------------------------------------
// Julian, 05.10. (Rail-Sitzung): „Aufgaben mit S<n> am Schritt, übrige in der Leiste." ONE split for both readers —
// the plan group in the rail and #chatTodos above the composer — so they cannot disagree about a task (shown in both
// places, or in neither). The rows are the ones public/js/task-list.js keeps in tab.taskList, made by its own
// functions here, so the shape is the shipped one and not a guess.
describe('PF-2 — planTaskMap: one split, two readers', () => {
  const TL = require('../public/js/task-list');
  // written at 3000 — while the plan below is underway (seen at 1000, accepted at 2000): only a task made since its
  // plan came up is about that plan (the counter-check case further down)
  const AT = 3000;
  const tasks = (...texts) => TL.todoWriteApply([], texts.map((t) => ({ content: t, status: 'pending' })), AT);
  const created = (toolId, subject, at) => { const l = []; TL.taskCreateSeen(l, toolId, { subject, description: subject }, at || AT); return l[0]; };
  // a plan underway with three steps (S1–S3) — the accepted SMALL
  const three = () => accepted();
  const texts = (rows) => rows.map((r) => r && r.text);
  // every input row lands in exactly ONE of the two places
  const once = (m, rows) => {
    const all = [].concat(...Object.values(m.byStep), m.unmapped);
    assert.equal(all.length, rows.length, 'a row was lost or doubled');
    rows.forEach((r) => assert.equal(all.filter((x) => x === r).length, 1, 'row ' + JSON.stringify(r && r.text) + ' is not in exactly one place'));
  };

  it('(a) Rail-Sitzung: „S2 · …" stands at step 2, the one without a prefix stays in the strip — each exactly once', () => {
    const rows = tasks('S2 · Route verdrahten', 'Ohne Präfix');
    const m = P.planTaskMap(three(), rows);
    assert.deepEqual(Object.keys(m.byStep), ['S2']);
    assert.equal(m.byStep.S2[0], rows[0], 'the SAME row object — the strip and the group read one list');
    assert.deepEqual(m.unmapped, [rows[1]]);
    once(m, rows);
  });

  it('(b) Rail-Sitzung: „S9 · …" in a plan of three steps does not vanish — it stays in the strip; so does a prefix no step has', () => {
    const rows = tasks('S9 · Gibt es nicht', 'S4 · Auch nicht', 'S0 · Null ist keine Schritt-ID');
    const m = P.planTaskMap(three(), rows);
    assert.deepEqual(m.byStep, {});
    assert.deepEqual(m.unmapped, rows);
    // a plan whose steps carry IDs of their own shape: „S1 ·" names none of them
    const p = three();
    assert.ok(planApplyStatus(p, planStatusNormalize({ schritte: [{ id: 'A1', titel: 'Eins' }, { id: 'A2', titel: 'Zwei' }] }), 3000).structural);
    const m2 = P.planTaskMap(p, tasks('S1 · Erster', 'A1 · Eigene ID'));
    assert.deepEqual(m2.byStep, {}, 'only the S<n> prefix places a task (Julian\'s rule) — never a guess at another ID shape');
    assert.equal(m2.unmapped.length, 2);
  });

  it('without a plan UNDERWAY every task stays in the strip — none, proposed, orphaned, done, dismissed, superseded', () => {
    const rows = tasks('S1 · Eins', 'S2 · Zwei', 'frei');
    const proposed = planNew('toolu_P', SMALL, '', 1);
    const orphan = P.planOrphan(planNew('toolu_O', SMALL, '', 1));
    const done = three(); planApplyStatus(done, planStatusNormalize({ fertig: true }), 3000);
    const dismissed = planDismiss(three());
    const superseded = planSupersede(planNew('toolu_S', SMALL, '', 1));
    for (const [name, p] of [['none', null], ['undefined', undefined], ['proposed', proposed], ['orphan', orphan], ['done', done], ['dismissed', dismissed], ['superseded', superseded]]) {
      const m = P.planTaskMap(p, rows);
      assert.deepEqual(m.byStep, {}, name);
      assert.equal(m.unmapped.length, rows.length, name);
      m.unmapped.forEach((r, i) => assert.equal(r, rows[i], name + ': the strip gets the very rows, in their order'));
    }
    // they all have steps S1–S3, so it really is the state that decides and not a missing step
    assert.deepEqual([proposed, orphan, done, dismissed, superseded].map((p) => p.steps.length), [3, 3, 3, 3, 3]);
    // an active plan with no list yet places nothing either
    const empty = planAccept(planNew('toolu_E', '# Nur Prosa\n', '', 1), null, 2);
    assert.equal(P.planTaskMap(empty, rows).unmapped.length, 3);
  });

  it('the prefix variants Julian named — „S2 ·", „S2:", „[S2]", „S2 -", „S2 —" — in any case, and what is NOT a prefix', () => {
    const yes = ['S2 · a', 'S2: a', 'S2:a', '[S2] a', '[S2]a', '[S2] · a', '[ s2 ]: a', 'S2 - a', 'S2 — a', 'S2 – a', 's2 · a', 's2: a', 'S02 · a', '  S2 · a'];
    for (const t of yes) {
      const pre = P.planTaskPrefix(t);
      assert.ok(pre, t + ' was not read as a prefix');
      assert.deepEqual([pre.step, pre.text], ['S2', 'a'], t);
      assert.deepEqual(Object.keys(P.planTaskMap(three(), tasks(t)).byStep), ['S2'], t);
    }
    // a bare blank is no separator, a prefix needs text after it, and only at the start; S0 / S1000 are no S-number
    const no = ['S2 a', 'S2', 'S2 ·', '[S2]', 'S2:   ', 'Schritt 2: a', 'xS2 · a', 'S2x · a', 'S0 · a', 'S1000 · a', 'Fix S2 · a', '(S2) a', 'S 2 · a', '#2 · a'];
    for (const t of no) {
      assert.equal(P.planTaskPrefix(t), null, t + ' was read as a prefix');
      assert.deepEqual(P.planTaskMap(three(), tasks(t)).byStep, {}, t);
    }
    // non-strings are no text at all
    for (const v of [null, undefined, 2, {}, ['S2 · a']]) assert.equal(P.planTaskPrefix(v), null, String(v));
  });

  it('counter-check: a hyphen that joins a word is no separator, and a range names no ONE step — both stay in the strip, whole', () => {
    // „S4-HANA" and „S3-Bucket" are names (the SAP world is full of them); „S1–S3", „S2 - S3", „[S2][S3]" name several
    // steps, and putting the task under the first one would be a guess
    const no = ['S3-Bucket anlegen', 'S4-HANA Migration', 'S2-S4 vorbereiten', 'S2-3 Tests', 'S1–S3 zusammenfassen', 'S2–S3 · Übergreifend',
      'S2 - S3: beides', 'S2 – 3 Tests', 'S2 —S3 x', '[S2][S3] beides', '[S2] - S3 x', 'S2 · S3: beides', 'S2: [S3] beides'];
    for (const t of no) {
      assert.equal(P.planTaskPrefix(t), null, t + ' was read as a prefix');
      const rows = tasks(t);
      const m = P.planTaskMap(three(), rows);
      assert.deepEqual(m.byStep, {}, t);
      assert.equal(m.unmapped[0], rows[0], t + ': in the strip');
      assert.equal(P.planTaskLabel(t), t, t + ': shown whole — nothing cut off that was not a prefix');
    }
    // …and what still is one: a hyphen with a blank on one side, the en/em dash without blanks (they join no word),
    // a step number as TEXT after „·" or „:"
    for (const [t, text] of [['S2- a', 'a'], ['S2 -a', 'a'], ['S2—Route', 'Route'], ['S2–Route', 'Route'], ['[S2]-Bucket', 'Bucket'],
      ['S2 · S3-Bucket anlegen', 'S3-Bucket anlegen'], ['S2: 3 Tests', '3 Tests'], ['S2 · 3 Endpunkte', '3 Endpunkte'], ['S2 · a', 'a'], ['S2\u00a0· a', 'a'] /* a no-break space */,
      ['S2 – 2FA einrichten', '2FA einrichten']]) {
      assert.deepEqual(P.planTaskPrefix(t), { step: 'S2', text }, t);
    }
  });

  it('counter-check: only a task made since its plan came up is about it — the tasks of plan A never stand under the steps of B', () => {
    // A: seen at 1000, accepted at 2000; the task of A at 3000; A finished; B seen at 5000, accepted at 6000
    const a = three();
    const old = created('tuA', 'S2 · Route verdrahten', 3000);
    old.status = 'completed';
    assert.deepEqual(Object.keys(P.planTaskMap(a, [old]).byStep), ['S2'], 'under A: at its step');
    const b = planAccept(planNew('toolu_B', '# Plan: Zweiter\n## Schritte\n### Datenbank\n### Migration\n### Rollout\n', '', 5000), null, 6000);
    assert.deepEqual(b.steps.map((s) => s.id), ['S1', 'S2', 'S3']);
    let m = P.planTaskMap(b, [old]);
    assert.deepEqual(m.byStep, {}, 'B/S2 „Migration" is untouched — a ticked task of A must not stand under it');
    assert.equal(m.unmapped[0], old, '…it stays in the strip');
    // a task for B — after B came up, also BEFORE its approval (a proposal's own steps are what it names) — is placed
    const mid = created('tuB1', 'S2 · Migration schreiben', 5500), late = created('tuB2', 'S3 · Rollout', 7000);
    m = P.planTaskMap(b, [old, mid, late]);
    assert.deepEqual(Object.keys(m.byStep), ['S2', 'S3']);
    assert.equal(m.byStep.S2[0], mid);
    assert.deepEqual(m.unmapped, [old]);
    // the same moment counts as „since"
    assert.ok(P.planTaskMap(b, [created('tuB3', 'S1 · gleichzeitig', 5000)]).byStep.S1);
    // a TodoWrite row the model writes NEW for B is believed — a row it only carries over from its list under A is not:
    // TodoWrite re-sends the whole list, and the carried row keeps the moment its text first appeared (task-list.js)
    const before = TL.todoWriteApply([], [{ content: 'S2 · alt', status: 'completed' }], 3000);
    assert.deepEqual(P.planTaskMap(b, before).byStep, {});
    const again = TL.todoWriteApply(before, [{ content: 'S2 · alt', status: 'completed' }, { content: 'S2 · neu für B', status: 'pending' }], 6500);
    m = P.planTaskMap(b, again);
    assert.deepEqual(texts(m.byStep.S2), ['S2 · neu für B'], 'the new row stands at B/S2, the carried one does not');
    assert.deepEqual(texts(m.unmapped), ['S2 · alt'], 'A\'s ticked row stays in the strip, whole');
    // a TaskUpdate moves a row, it does not make it new: the old task stays out after an update under B
    old.status = 'in_progress';
    assert.deepEqual(P.planTaskMap(b, [old]).byStep, {});
    // a plan without a time (an old saved one) draws no line; a row without `created` is not held against one
    const timeless = Object.assign(three(), { seenAt: 0, acceptedAt: 0 });
    assert.ok(P.planTaskMap(timeless, [old]).byStep.S2);
    assert.ok(P.planTaskMap(b, [{ text: 'S2 · ohne Zeit', status: 'pending' }]).byStep.S2);
    // a plan the model started by REPORTING it (planFromStatus) came up with that report
    const r = planFromStatus(null, planStatusNormalize({ titel: 'Dritter', schritte: [{ id: 'S1', titel: 'Eins' }, { id: 'S2', titel: 'Zwei' }] }), null, 8000).plan;
    assert.equal(r.seenAt, 8000);
    assert.deepEqual(P.planTaskMap(r, [old, late]).byStep, {}, 'both from before it');
    assert.ok(P.planTaskMap(r, [created('tuC', 'S2 · danach', 8001)]).byStep.S2);
  });

  it('Gegenprobe: a plan that takes the place of another one underway draws its line where it took over (planPromote tookOverAt)', () => {
    const B_MD = '# Plan: Zweiter\n## Schritte\n### Datenbank\n### Migration\n### Rollout\n';
    // A underway (seen 1000, accepted 2000); B comes up at 5000 and waits under it; A's task at 5500; B taken over at 6000
    const aTask = created('tuA', 'S2 · Route verdrahten', 5500);
    aTask.status = 'completed';
    const bTask = created('tuB', 'S2 · Migration schreiben', 6500);
    const over = planPromote(three(), planNew('toolu_B', B_MD, '', 5000), null, 6000);
    assert.deepEqual([over.id, over.state, over.seenAt, over.tookOverAt], ['toolu_B', 'active', 5000, 6000]);
    let m = P.planTaskMap(over, [aTask, bTask]);
    assert.deepEqual(texts(m.byStep.S2), ['S2 · Migration schreiben'], 'only what came after the take-over stands at B/S2');
    assert.deepEqual(m.unmapped, [aTask], 'A\'s task — made after B came up, while A still ran — stays in the strip');
    // …the same when A finished while B waited under it (▶ on the orphan after „erst A fertig machen")
    const done = three(); planApplyStatus(done, planStatusNormalize({ fertig: true }), 5800);
    const afterDone = planPromote(done, planNew('toolu_B', B_MD, '', 5000), null, 6000);
    assert.equal(afterDone.tookOverAt, 6000);
    assert.deepEqual(P.planTaskMap(afterDone, [aTask]).byStep, {});
    // …and when A was put away (×) while underway: for the transcript it still ran (planStateSeen)
    assert.equal(planPromote(planDismiss(three()), planNew('toolu_B', B_MD, '', 5000), null, 6000).tookOverAt, 6000);
    // a proposal that was itself on top (nothing underway when it came up) keeps seenAt: a task for it before its
    // approval names its steps — the wiring test „approving it moves the S-tasks" is this case
    const top = planNew('toolu_B', B_MD, '', 5000);
    const own = planPromote(top, top, null, 6000);
    assert.equal(own.tookOverAt, undefined);
    assert.deepEqual(Object.keys(P.planTaskMap(own, [aTask]).byStep), ['S2']);
    for (const prev of [null, planSupersede(planNew('toolu_S', SMALL, '', 1))]) {
      assert.equal(planPromote(prev, planNew('toolu_B', B_MD, '', 5000), null, 6000).tookOverAt, undefined, String(prev && prev.state));
    }
    // a take-over that never reached the CLI did not happen (planUnaccept) — and the next one sets its own line
    planUnaccept(over, 'toolu_B');
    assert.deepEqual([over.state, over.acceptedAt, over.tookOverAt], ['proposed', 0, 0]);
    assert.equal(planPromote(three(), over, null, 9000).tookOverAt, 9000);
    // live only, like the plan text: the task list it is held against starts empty after a reload or a resume
    assert.ok(!('tookOverAt' in planSave(afterDone)));
  });

  it('the prefix is ONE constant, and the label shown at the step is the text without it', () => {
    assert.ok(P.PLAN_TASK_PREFIX_RE instanceof RegExp);
    assert.ok(P.PLAN_TASK_PREFIX_RE.test('S2 · x') && !P.PLAN_TASK_PREFIX_RE.test('S2 x'));
    assert.equal(P.planTaskLabel('S2 · Route verdrahten'), 'Route verdrahten');
    assert.equal(P.planTaskLabel('[S3] Tests: grün'), 'Tests: grün', 'only the prefix goes — a colon later in the text stays');
    assert.equal(P.planTaskLabel('Ohne Präfix'), 'Ohne Präfix', 'a text without a prefix is shown as it is');
    assert.equal(P.planTaskLabel('S2 ·'), 'S2 ·', 'nothing after the prefix → it is not one, the text stays whole');
    assert.equal(P.planTaskLabel(null), '');
  });

  it('the order is kept — per step, and in the strip', () => {
    const rows = tasks('S2 · a', 'x', 'S1 · b', 'S2 · c', 'y', 's3: d');
    const m = P.planTaskMap(three(), rows);
    assert.deepEqual(texts(m.byStep.S2), ['S2 · a', 'S2 · c']);
    assert.deepEqual(texts(m.byStep.S1), ['S1 · b']);
    assert.deepEqual(texts(m.byStep.S3), ['s3: d']);
    assert.deepEqual(texts(m.unmapped), ['x', 'y']);
    once(m, rows);
    // TaskCreate rows (the other source) are placed by the same rule
    const c = created('tu1', 'S3 · Tests schreiben');
    const m2 = P.planTaskMap(three(), rows.concat([c]));
    assert.equal(m2.byStep.S3[1], c);
  });

  it('empty and broken rows: nothing throws, nothing is dropped — what cannot be placed stays with the strip and its reader', () => {
    const rows = [null, undefined, 42, 'S2 · ein String ist keine Zeile', {}, { text: 5 }, { text: '' }, { text: 'S2 · gut', status: 'pending', src: 'todo', id: 'todo-7' }];
    const m = P.planTaskMap(three(), rows);
    assert.deepEqual(texts(m.byStep.S2), ['S2 · gut']);
    assert.equal(m.unmapped.length, 7);
    once(m, rows);
    // taskListView (the strip's reader) sees exactly what it saw before PF-2, minus the placed row — it decides about the
    // rest as it always did (it drops what has no text; a number as text it shows, as before)
    assert.deepEqual(TL.taskListView(m.unmapped), TL.taskListView(rows.slice(0, 7)));
    for (const bad of [null, undefined, 'x', 3, {}]) assert.deepEqual(P.planTaskMap(three(), bad), { byStep: {}, unmapped: [] }, String(bad));
    // a broken plan places nothing
    for (const p of [{ state: 'active' }, { state: 'active', steps: 'S2' }, { state: 'active', steps: [null] }]) {
      assert.equal(P.planTaskMap(p, tasks('S1 · a')).unmapped.length, 1);
    }
  });

  it('planTaskSig: what the group shows of the tasks — moves with a placed task, not with one in the strip', () => {
    const rows = tasks('S2 · a', 'frei');
    const sig = () => P.planTaskSig(P.planTaskMap(three(), rows));
    const s0 = sig();
    assert.notEqual(s0, '');
    rows.push(...tasks('nochmal frei'));
    assert.equal(sig(), s0, 'a task in the strip does not rebuild the rail');
    rows[0].status = 'in_progress';
    assert.notEqual(sig(), s0, 'a placed task changed its status');
    const s1 = sig();
    rows.push(...tasks('S3 · neu'));
    assert.notEqual(sig(), s1, 'a new placed task');
    const s2 = sig();
    rows[0].text = 'S2 · a, umbenannt';
    assert.notEqual(sig(), s2, 'its text');
    const s3 = sig();
    rows[0].activeForm = 'Baue a';
    assert.notEqual(sig(), s3, 'its working form (shown while it runs)');
    assert.equal(P.planTaskSig(P.planTaskMap(null, rows)), '', 'nothing placed, nothing to sign');
    assert.equal(P.planTaskSig(null), '');
  });

  it('planTaskMark: the checklist\'s own marks (✓ ⏳ ☐), and „?" for a word nobody measured — never ☐ for it', () => {
    assert.deepEqual(['completed', 'in_progress', 'pending'].map((s) => P.planTaskMark(s)), ['✓', '⏳', '☐']);
    for (const s of ['unknown', 'blocked', 'skipped', '', null, 'constructor']) assert.equal(P.planTaskMark(s), '?', String(s));
  });

  it('a task never ticks a step off — the status stays with the plan-status protocol', () => {
    const p = three();
    planApplyStatus(p, planStatusNormalize({ aktuell: 'S2' }), 3000);
    const rows = TL.todoWriteApply([], [{ content: 'S2 · alles erledigt', status: 'completed' }, { content: 'S3 · auch', status: 'completed' }], AT);
    const before = planSig(p);
    const m = P.planTaskMap(p, rows);
    assert.deepEqual(Object.keys(m.byStep), ['S2', 'S3']);
    assert.equal(planSig(p), before, 'the split reads the plan, it never writes it');
    assert.deepEqual(p.steps.map((s) => s.status), ['pending', 'in_progress', 'pending']);
  });
});
