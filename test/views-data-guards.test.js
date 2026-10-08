'use strict';
// PR-9b, the browser half — the four places where the panel used to throw away work, and the one where a
// stored record depended on what was VISIBLE.
//
// HOW the browser half is tested: public/js/views-memory.js, views-uiskills.js, chat-render.js and
// chat-events.js are classic scripts with no exports (they need the whole app's globals), so the
// functions under test are LIFTED OUT OF THE SHIPPED SOURCE BY NAME and run against fake globals — the
// same seam test/ultracode-honesty.test.js and test/agent-lanes.test.js use. If one of them is renamed or
// reindented these tests fail loudly instead of quietly testing a copy. The `beforeunload` listener is cut out
// of boot.js and RUN (BUILDER-1: its text pin stayed green with a typo in a typeof guard). The one wiring that
// cannot be loaded that way (the `_exit`/`_error` branches of one 700-line switch) is pinned as TEXT, on the
// token the mutation would have to remove — the same compromise, and for the same reason, as
// test/status-strip.test.js.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MEM_SRC = read('public/js/views-memory.js');
const UIS_SRC = read('public/js/views-uiskills.js');
const RENDER_SRC = read('public/js/chat-render.js');
const EVENTS_SRC = read('public/js/chat-events.js');
const PERMS_SRC = read('public/js/chat-perms.js');
const BOOT_SRC = read('public/js/boot.js');
// enumerated, never listed: a scan that claims to cover „the panel" has to ask the directory, or it stops
// covering the file somebody adds next week. 34 files when this was written.
const BROWSER_FILES = fs.readdirSync(path.join(ROOT, 'public', 'js'))
  .filter((f) => f.endsWith('.js')).sort().map((f) => 'public/js/' + f);

// ---- the lifting seam (same rule as test/ultracode-honesty.test.js) ---------------------------------
function liftFn(src, name, rel) {
  const one = new RegExp('^(?:async )?function ' + name + '\\(.*\\}[ \\t]*$', 'm');
  const multi = new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm');
  const m = one.exec(src) || multi.exec(src);
  assert.ok(m, name + '() not found in ' + rel + ' — renamed or reindented? Then these tests prove nothing.');
  return m[0];
}
function bundle(pieces, names, env) {
  const keys = Object.keys(env);
  const body = pieces.join('\n') + '\nreturn { ' + names.join(', ') + ' };';
  return new Function(...keys, body)(...keys.map((k) => env[k]));
}
// comments stripped before any text pin: a comment that happens to name the token would otherwise satisfy
// the assertion while the call itself is gone
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*$/gm, '');
const t = (k) => k; // the KEY, so an assertion can name the string without pinning its wording (i18n.test.js owns that)

// ====================================================================================================
// DATA-2 — the unsaved memory draft
// ====================================================================================================
// The editor's value is the ONLY copy of a draft (nothing is POSTed while you type), which is why the
// guard is in the browser: there is no server state a confirm could protect here.
function loadMem(state, extra) {
  const ed = Object.assign({ value: '', disabled: false }, state.ed);
  const note = { textContent: state.note == null ? '' : state.note };
  const env = Object.assign({
    $: (sel) => (sel === '#memEditor' ? ed : sel === '#memNote' ? note : null),
    MEM: state.MEM || { project: 'p', name: 'a.md' },
    MEM_LOADED: state.loaded == null ? '' : state.loaded,
    t,
    uiModal: state.uiModal || (() => Promise.resolve('cancel')),
    saveMemory: state.saveMemory || (() => Promise.resolve(true)),
  }, extra || {});
  const api = bundle(
    [liftFn(MEM_SRC, 'memDirty', 'views-memory.js'), liftFn(MEM_SRC, 'paintMemDirty', 'views-memory.js'), liftFn(MEM_SRC, 'memDraftMayGo', 'views-memory.js')],
    ['memDirty', 'paintMemDirty', 'memDraftMayGo'], env);
  return Object.assign(api, { ed, note });
}

describe('DATA-2 — a memory draft is not thrown away without being asked about', () => {
  it('memDirty: only an OPEN, loaded file whose text differs from what was loaded', () => {
    assert.equal(loadMem({ loaded: 'x', ed: { value: 'x' } }).memDirty(), false, 'unchanged');
    assert.equal(loadMem({ loaded: 'x', ed: { value: 'x ' } }).memDirty(), true, 'one typed space is a draft');
    assert.equal(loadMem({ loaded: 'x', ed: { value: 'y' }, MEM: { project: null, name: null } }).memDirty(), false,
      'no file open → the editor holds nothing anyone could lose');
    assert.equal(loadMem({ loaded: 'x', ed: { value: 'y', disabled: true } }).memDirty(), false,
      'openMemory DISABLES the editor while it loads — that state is not a draft (A1)');
  });

  it('paintMemDirty: says it while it is true, and does not wipe the „Gespeichert"-note when it is not', () => {
    const dirty = loadMem({ loaded: 'x', ed: { value: 'y' } });
    dirty.paintMemDirty();
    assert.equal(dirty.note.textContent, 'views-memory.memUngespeichert');
    const clean = loadMem({ loaded: 'x', ed: { value: 'x' }, note: 'common.gespeichert · Backup' });
    clean.paintMemDirty();
    assert.equal(clean.note.textContent, 'common.gespeichert · Backup', 'the save confirmation was overwritten');
    const was = loadMem({ loaded: 'x', ed: { value: 'x' }, note: 'views-memory.memUngespeichert' });
    was.paintMemDirty();
    assert.equal(was.note.textContent, '', 'the marker must go away once the draft is gone');
  });

  it('memDraftMayGo: a clean editor asks nothing at all', async () => {
    let asked = 0;
    const m = loadMem({ loaded: 'x', ed: { value: 'x' }, uiModal: () => { asked++; return Promise.resolve('discard'); } });
    assert.equal(await m.memDraftMayGo(), true);
    assert.equal(asked, 0, 'a dialog for nothing is its own defect');
  });

  it('memDraftMayGo: Abbrechen and Esc keep the draft; „Verwerfen" lets the switch happen', async () => {
    for (const answer of ['cancel', null, undefined, false]) {
      const m = loadMem({ loaded: 'x', ed: { value: 'y' }, uiModal: () => Promise.resolve(answer) });
      assert.equal(await m.memDraftMayGo(), false, 'answer ' + JSON.stringify(answer) + ' discarded the draft');
    }
    const d = loadMem({ loaded: 'x', ed: { value: 'y' }, uiModal: () => Promise.resolve('discard') });
    assert.equal(await d.memDraftMayGo(), true);
  });

  it('memDraftMayGo: „Speichern" only releases the draft when the save SUCCEEDED', async () => {
    let saves = 0;
    const okCase = loadMem({ loaded: 'x', ed: { value: 'y' }, uiModal: () => Promise.resolve('save'), saveMemory: () => { saves++; return Promise.resolve(true); } });
    assert.equal(await okCase.memDraftMayGo(), true);
    assert.equal(saves, 1);
    // the failure path is the one that matters: a 409/ENOENT must not read as „saved, go ahead"
    const failCase = loadMem({ loaded: 'x', ed: { value: 'y' }, uiModal: () => Promise.resolve('save'), saveMemory: () => Promise.resolve(false) });
    assert.equal(await failCase.memDraftMayGo(), false, 'a failed save let the draft be dropped');
  });

  it('the dialog offers THREE answers — without „Abbrechen" it forces the choice it asks about', () => {
    const src = noComments(liftFn(MEM_SRC, 'memDraftMayGo', 'views-memory.js'));
    for (const v of ["'cancel'", "'discard'", "'save'"]) assert.ok(src.includes(v), 'the ' + v + ' action is gone');
    assert.match(src, /escValue:\s*'cancel'/, 'Esc must mean cancel, not discard');
  });

  // the wiring: openMemory must ASK before it blanks the editor, and it must ask while MEM still names
  // the file the draft belongs to
  it('openMemory asks before it clears the editor, and before MEM moves on', () => {
    const fn = noComments(liftFn(MEM_SRC, 'openMemory', 'views-memory.js'));
    const guard = fn.indexOf('memDraftMayGo');
    const clear = fn.indexOf("ed.value = ''");
    const move = fn.indexOf('MEM = { project, name }');
    assert.ok(guard > 0, 'openMemory no longer asks about an unsaved draft — DATA-2 is back');
    assert.ok(guard < move && guard < clear, 'the question comes AFTER the editor was reassigned: too late');
  });

  it('…and a reload is covered too (UNLOAD-1): the shipped beforeunload listener, RUN, reads the same memDirty()', () => {
    const m = /^window\.addEventListener\('beforeunload'[\s\S]*?\n\}\);$/m.exec(BOOT_SRC);
    assert.ok(m, 'the beforeunload listener moved — re-check this test');
    const warns = (env) => {
      let listener = null;
      const window = { addEventListener: (type, fn) => { if (type === 'beforeunload') listener = fn; } };
      bundle([m[0]], [], Object.assign({ window, TABS: [] }, env));
      assert.ok(listener, 'the listener was not registered');
      const e = { prevented: false, preventDefault() { this.prevented = true; } };
      listener(e);
      return e.prevented;
    };
    assert.equal(warns({ memDirty: () => true }), true, 'a reload throws the draft away with no warning again');
    assert.equal(warns({ memDirty: () => false }), false);
    assert.equal(warns({}), false, 'without views-memory.js loaded it must neither throw nor warn');
    assert.equal(warns({ TABS: [{ streaming: true }] }), true, 'the running-turn warning must survive alongside it');
  });
});

// ====================================================================================================
// DATA-3 — the browser has to ASK for the guard; the route cannot guess which PUT is a create
// ====================================================================================================
describe('DATA-3 — „Neue Memory" asks the route to refuse an existing name', () => {
  const src = noComments(MEM_SRC);
  it('the create PUT carries create:true — and the editor\'s save does not', () => {
    const i = src.indexOf("$('#memNew').onclick");
    assert.ok(i > 0, 'the „Neue Memory" handler moved — re-check this pin');
    assert.match(src.slice(i), /name: slug, content: tmpl, create: true/,
      'without the flag the route overwrites a case-variant again (the browser list is a stale snapshot)');
    const save = noComments(liftFn(MEM_SRC, 'saveMemory', 'views-memory.js'));
    assert.ok(!/create:\s*true/.test(save), 'the editor\'s save must NOT claim to create — it would refuse every save');
  });
  it('the refusal becomes an offer, not a dead end', () => {
    assert.match(src, /e\.code === 'exists'[\s\S]{0,400}memExistiert/, 'the 409 is shown as a raw error message again');
    assert.match(src, /memOeffnen[\s\S]{0,200}openMemory\(project, existing\)/, 'the existing file is named but not reachable');
  });
});

// ====================================================================================================
// M2 — a new schedule must not inherit the previous skill's answers
// ====================================================================================================
function loadSched(env) {
  return bundle([liftFn(UIS_SRC, 'schedFormValues', 'views-uiskills.js')], ['schedFormValues'], env);
}
const SKILL_B = { name: 'b', manifest: { inputs: [{ id: 'thema', type: 'text' }, { id: 'tief', type: 'checkbox', default: true }] } };

describe('M2 — the schedule form takes the values of ITS skill', () => {
  it('a run form belonging to another skill is not used; defaults + „last run" are', () => {
    const { schedFormValues } = loadSched({
      RUN_SKILL: 'a', RUN_VALUES: { thema: 'Skill A hat das getippt', fremd: 1 },
      uiDefaultValues: (m) => ({ thema: '', tief: !!(m.inputs || []).find((i) => i.id === 'tief').default }),
      lastInputs: (n) => (n === 'b' ? { thema: 'B letztes Mal' } : null),
    });
    const v = schedFormValues(SKILL_B);
    assert.equal(v.thema, 'B letztes Mal', 'skill A\'s input was about to be stored as skill B\'s nightly value');
    assert.equal(v.tief, true, 'the manifest default was dropped');
    assert.ok(!('fremd' in v), 'a key skill B has no field for came along');
  });

  it('…and when the run tab IS this skill\'s, its values are used — as a COPY', () => {
    const live = { thema: 'jetzt getippt' };
    const { schedFormValues } = loadSched({
      RUN_SKILL: 'b', RUN_VALUES: live,
      uiDefaultValues: () => ({ thema: '' }), lastInputs: () => null,
    });
    const v = schedFormValues(SKILL_B);
    assert.deepEqual(v, { thema: 'jetzt getippt' });
    live.thema = 'danach weitergetippt';
    assert.equal(v.thema, 'jetzt getippt', 'the schedule holds a live reference into the open form');
  });

  it('the create button sends those values and not the global (the wiring)', () => {
    const src = noComments(UIS_SRC);
    const i = src.indexOf("const createBtn = el('button', 'primary-btn', t('views-uiskills.zeitplanAnlegen'))");
    assert.ok(i > 0, 'the create button moved — re-check this pin');
    const body = src.slice(i, i + 1600);
    assert.match(body, /values:\s*schedValues/, 'the POST body is built from the global run form again');
    assert.ok(!/values:\s*JSON\.parse\(JSON\.stringify\(RUN_VALUES\)\)/.test(body), 'RUN_VALUES is back in the schedule POST');
  });

  it('…and the values are SHOWN before they are stored (a value nobody displays is how M2 survived)', () => {
    const src = noComments(UIS_SRC);
    assert.match(src, /histInputsSummary\(m, schedValues\)/, 'the schedule form shows no summary of what it will store');
    // and the claim „uses the current inputs from the Run tab" may only be made while it is TRUE —
    // standing next to the other line it would be a contradiction, which is this repo's own bug class
    assert.match(src, /RUN_SKILL === s\.name \? t\('views-uiskills\.nutztDieAktuellenEingaben'\) : t\('views-uiskills\.zeitplanWerteQuelle'\)/,
      'nothing says where the values came from (or both lines are shown at once)');
  });
});

// ====================================================================================================
// SCHED-1 — the client's half may not disagree with the route's half
// ====================================================================================================
describe('SCHED-1 — the run form\'s rule and the server\'s rule are the same rule', () => {
  const { missingRequiredInputs } = require('../lib/pure');
  const client = bundle(
    [liftFn(UIS_SRC, 'missingRequired', 'views-uiskills.js'), liftFn(UIS_SRC, 'isVisible', 'views-uiskills.js'), liftFn(UIS_SRC, 'uiTruthy', 'views-uiskills.js')],
    ['missingRequired'], {});
  it('both answer identically for every shape the manifest allows', () => {
    const m = {
      inputs: [
        { id: 'a', required: true }, { id: 'b' },
        { id: 'c', required: true, visibleIf: 'a' },
        { id: 'd', required: true, visibleIf: { field: 'b', equals: 'ja' } },
        { id: 'tags', type: 'tags', required: true },
        { id: 'flag', type: 'checkbox', required: true },
      ],
    };
    const cases = [{}, { a: 'x' }, { a: 'x', tags: ['t'] }, { a: 'x', b: 'ja' }, { a: 'x', b: 'nein' },
      { a: false }, { a: '', flag: false }, { a: 'x', b: 'ja', c: 'y', d: 'z', tags: ['t'], flag: true }];
    for (const values of cases) {
      const mine = missingRequiredInputs(m, values);
      const theirs = client.missingRequired(m, values).map((i) => i.id);
      assert.deepEqual(mine, theirs, 'drift for ' + JSON.stringify(values) + ': server ' + JSON.stringify(mine) + ' vs form ' + JSON.stringify(theirs));
    }
  });
});

describe('SCHED-1 — the dialog refuses before the route has to', () => {
  const src = noComments(UIS_SRC);
  const i = src.indexOf("const createBtn = el('button', 'primary-btn', t('views-uiskills.zeitplanAnlegen'))");
  const body = src.slice(i, i + 1600);
  it('both refusals are in the create handler, each naming what is wrong', () => {
    assert.ok(i > 0, 'the create button moved — re-check this pin');
    assert.match(body, /missingRequired\(m, schedValues\)/, 'the schedule can be created with an empty required field again');
    assert.match(body, /timing\.type === 'daily' && !\(timing\.days \|\| \[\]\)\.length/, 'the no-weekday case reaches the route as a bare 400');
    assert.match(body, /zeitplanPflichtfelder|zeitplanOhneWochentag/, 'refused without saying why');
  });
  it('and the day picker says it the moment the last weekday goes off', () => {
    assert.match(src, /daysWarn[\s\S]{0,400}zeitplanOhneWochentag/, 'no live warning under the weekday buttons');
    assert.match(src, /syncDays\(\);/, 'the warning is never re-evaluated after a click');
  });
});

// ====================================================================================================
// DATA-UI-3 — the clear button belongs to ONE skill
// ====================================================================================================
describe('DATA-UI-3 — the request carries the skill, and the question carries the number', () => {
  const src = noComments(UIS_SRC);
  it('the POST sends { name } — without it the route empties the whole store again', () => {
    const i = src.indexOf("api('/api/uiskill/runs/clear'");
    assert.ok(i > 0, 'the clear call moved — re-check this pin');
    assert.match(src.slice(i, i + 300), /JSON\.stringify\(\{ name: s\.name \}\)/,
      'the scoped route is called unscoped: every other skill\'s runs go with it');
  });
  it('the confirmation says how many runs and which skill, and that there is a backup', () => {
    assert.match(src, /verlaufLeerenFrage'\)[\s\S]{0,200}allRuns\.length/, 'the question does not name the number it is about');
    assert.match(src, /verlaufGeleert'\)[\s\S]{0,200}r\.removed/, 'the toast reports a number nobody counted');
  });
});

// ====================================================================================================
// DATA-UI-2 — „Aus Skill erstellen" over an existing -ui skill
// ====================================================================================================
function loadConvert(opts) {
  const calls = [];
  const api = (url, init) => {
    calls.push({ url, method: (init && init.method) || 'GET', body: init && init.body ? JSON.parse(init.body) : null });
    if (url === '/api/skill/duplicate' && opts.duplicateConflict) { const e = new Error('command "x-ui" existiert bereits'); e.status = 409; return Promise.reject(e); }
    if (url.startsWith('/api/cfgfile?')) return Promise.resolve({ content: '---\ndescription: d\n---\nbody' });
    return Promise.resolve({ ok: true });
  };
  const env = {
    api, t, toast: () => {}, uiConfirm: () => Promise.resolve(!!opts.confirm),
    serializeSkillMd: (body, manifest) => body + JSON.stringify(manifest),
    skillFlow: () => [], fmDescription: () => 'd',
    loadUiSkills: () => Promise.resolve(), UISKILLS_DATA: [{ name: 'x-ui', manifest: {} }],
    UISKILL_SEL: null, UISKILL_TAB: 'run', renderUiSkillList: () => {}, renderUiSkillPanel: () => {},
    // BUILDER-1 asks about an open builder draft first; none is open here (test/builder-draft.test.js owns that)
    builderDraftMayGo: () => Promise.resolve(true),
  };
  const { convertToUiSkill } = bundle([liftFn(UIS_SRC, 'convertToUiSkill', 'views-uiskills.js')], ['convertToUiSkill'], env);
  return { convertToUiSkill, calls };
}

describe('DATA-UI-2 — an existing -ui skill is not replaced unasked', () => {
  it('the 409 of /api/skill/duplicate stops the overwrite when the user says no', async () => {
    const c = loadConvert({ duplicateConflict: true, confirm: false });
    await c.convertToUiSkill('x', 'command');
    const writes = c.calls.filter((x) => x.method === 'PUT');
    assert.equal(writes.length, 0, 'the existing -ui skill was overwritten anyway — manifest, steps and all');
  });

  it('…and goes ahead when the user says yes', async () => {
    const c = loadConvert({ duplicateConflict: true, confirm: true });
    await c.convertToUiSkill('x', 'command');
    const writes = c.calls.filter((x) => x.method === 'PUT');
    assert.equal(writes.length, 1, 'an explicit yes must still work');
    assert.equal(writes[0].body.name, 'x-ui');
  });

  it('the ordinary case (no conflict) asks nothing', async () => {
    let asked = 0;
    const calls = [];
    const env = {
      api: (url, init) => { calls.push({ url, method: (init && init.method) || 'GET' }); return Promise.resolve(url.startsWith('/api/cfgfile?') ? { content: 'x' } : { ok: true }); },
      t, toast: () => {}, uiConfirm: () => { asked++; return Promise.resolve(true); },
      serializeSkillMd: (b) => b, skillFlow: () => [], fmDescription: () => '',
      loadUiSkills: () => Promise.resolve(), UISKILLS_DATA: [], UISKILL_SEL: null, UISKILL_TAB: 'run',
      renderUiSkillList: () => {}, renderUiSkillPanel: () => {}, builderDraftMayGo: () => Promise.resolve(true),
    };
    const { convertToUiSkill } = bundle([liftFn(UIS_SRC, 'convertToUiSkill', 'views-uiskills.js')], ['convertToUiSkill'], env);
    await convertToUiSkill('neu', 'command');
    assert.equal(asked, 0, 'a confirmation for a name that is free is noise');
    assert.equal(calls.filter((x) => x.method === 'PUT').length, 1);
  });
});

// ====================================================================================================
// C4 — the stored transcript
// ====================================================================================================
describe('C4 — the run transcript is read without a layout, and without depending on what is visible', () => {
  const { uiTranscriptText } = bundle([liftFn(UIS_SRC, 'uiTranscriptText', 'views-uiskills.js')], ['uiTranscriptText'], {});
  const fakeMsgEl = (texts) => ({
    textContent: texts.join(''),
    querySelectorAll: (sel) => (sel === '.msg' ? texts.map((x) => ({ textContent: x })) : []),
    // innerText deliberately ABSENT: a mutation back to it returns undefined here, which fails loudly
  });

  it('every message survives, separated — not glued into one line', () => {
    const out = uiTranscriptText(fakeMsgEl(['Frage', 'Antwort']));
    assert.equal(out, 'Frage\n\nAntwort');
  });

  it('a message hidden by the display switches is still recorded', () => {
    // „Gedanken ausblenden" / „Tools ausblenden" are CSS classes on the scroller — innerText dropped
    // whatever they hid, so the stored history depended on checkboxes
    const out = uiTranscriptText(fakeMsgEl(['sichtbar', 'verstecktes Tool-Ergebnis']));
    assert.match(out, /verstecktes Tool-Ergebnis/);
  });

  it('no element, and an element without messages', () => {
    assert.equal(uiTranscriptText(null), '');
    assert.equal(uiTranscriptText({ textContent: '  nur Text  ', querySelectorAll: () => [] }), 'nur Text');
  });

  it('neither of the two run-end writers reads innerText any more', () => {
    const src = noComments(UIS_SRC);
    for (const m of src.matchAll(/transcript:\s*([^\n,]+)/g)) {
      assert.ok(!/innerText/.test(m[1]), 'a stored transcript still forces a full layout: ' + m[1].trim());
      assert.match(m[1], /uiTranscriptText\(/, 'unexpected transcript source: ' + m[1].trim());
    }
    assert.equal([...src.matchAll(/transcript:\s*uiTranscriptText\(/g)].length, 2, 'expected exactly the two run-end writers');
  });
});

// ====================================================================================================
// COR-1 — a broken cc_display must not take the panel down
// ====================================================================================================
describe('COR-1 — the display preferences are read with a try', () => {
  const { readDisplayPrefs } = bundle([liftFn(RENDER_SRC, 'readDisplayPrefs', 'chat-render.js')], ['readDisplayPrefs'], { console: { warn() {} } });
  it('unparsable, absent and wrong-typed values all answer with an empty record', () => {
    for (const raw of ['{kaputt', '', null, undefined, 'null', '[1,2]', '"text"', '42']) {
      assert.deepEqual(readDisplayPrefs(raw), {}, JSON.stringify(raw) + ' did not fall back');
    }
  });
  it('a valid record is passed through unchanged', () => {
    assert.deepEqual(readDisplayPrefs('{"thinking":false,"fontSize":"l"}'), { thinking: false, fontSize: 'l' });
  });
  it('it is the only localStorage read in the panel without a try', () => {
    // the regression this guards: the defect was not „a wrong value" but „a throw at LOAD TIME", and the
    // file it threw in is the one that draws the chat
    const offenders = [];
    for (const rel of BROWSER_FILES) offenders.push(...unguardedLocalStorageParses(read(rel)).map((o) => rel + ': ' + o));
    assert.deepEqual(offenders, [], 'an unguarded localStorage parse takes the panel down at load time');
  });

  it('…and the guard REACHES all three shapes, including the one this fix introduced', () => {
    // Why this test exists: the first version matched the adjacency `JSON.parse(localStorage` on ONE LINE.
    // That is precisely not the shape COR-1's own fix has — `readDisplayPrefs(localStorage.getItem(…))`,
    // where the parse happens in another function — and it could not see a multi-line `try` either. It
    // checked 15 real lines, so it was not a vacuum, but it could not claim the CLASS it was quoted for
    // („the family is empty"). Feeding it the shapes it must catch is the only way that claim is worth
    // anything: a guard that cannot fail proves nothing about the code it passes over.
    const UNRELATED_TRY = "function unrelated() { try { probe(); } catch { /* */ } }\n";
    const cases = [
      ['one line, no try', "const d = JSON.parse(localStorage.getItem('cc_x') || '{}');"],
      ['the parse split across lines', "const d = JSON.parse(\n  localStorage.getItem('cc_x') || '{}'\n);"],
      ['read into a variable, parsed later', "const raw = localStorage.getItem('cc_x');\nconst d = JSON.parse(raw);"],
      ['handed to a reader that does not try', "function readPrefs(raw) { return JSON.parse(raw); }\nreadPrefs(localStorage.getItem('cc_x'));"],
      // the two that the character-window version got WRONG: a `try` that is NEARBY but does not enclose.
      // Found by the mutation run — injecting these at the end of a real file stayed green.
      ['a try nearby but not around it (one line)', UNRELATED_TRY + "const d = JSON.parse(localStorage.getItem('cc_x'));"],
      ['a try nearby but not around it (variable)', UNRELATED_TRY + "const raw = localStorage.getItem('cc_x');\nconst d = JSON.parse(raw);"],
    ];
    for (const [what, src] of cases) {
      assert.ok(unguardedLocalStorageParses(src).length > 0, 'NOT caught: ' + what + ' → ' + src.replace(/\n/g, ' ⏎ '));
    }
    // …and the guarded forms of the same three must stay quiet, or the guard is noise and gets deleted
    const ok = [
      "try { const d = JSON.parse(localStorage.getItem('cc_x') || '{}'); } catch {}",
      "try {\n  const d = JSON.parse(\n    localStorage.getItem('cc_x')\n  );\n} catch { /* */ }",
      "const raw = localStorage.getItem('cc_x');\ntry { const d = JSON.parse(raw); } catch {}",
      "function readPrefs(raw) { try { return JSON.parse(raw) || {}; } catch { return {}; } }\nreadPrefs(localStorage.getItem('cc_x'));",
      "applyAccent(localStorage.getItem('ccui-accent'));",   // a plain string read is not a parse
      // containment, not distance: an enclosing try still catches through an `if` and through a
      // synchronous arrow, and flagging those would make the guard noise
      "try {\n  if (x) {\n    const d = JSON.parse(localStorage.getItem('cc_x'));\n  }\n} catch {}",
      "try { [1].forEach((x) => { const d = JSON.parse(localStorage.getItem('cc_x')); }); } catch {}",
    ];
    for (const src of ok) {
      assert.deepEqual(unguardedLocalStorageParses(src), [], 'false alarm on ' + src.replace(/\n/g, ' ⏎ '));
    }
  });
});
// Every way a stored string can reach JSON.parse, as three rules over the comment-stripped source.
//
// The „is it guarded" question is answered by BRACE WALKING, not by a character window. The first attempt
// here used „a `try` within 240 characters before the parse", and the mutation run killed it: injecting an
// unguarded parse at the end of a real file stayed GREEN, because some unrelated `try` further up the file
// was inside the window. A window measures distance; the question is CONTAINMENT. `inTry` walks outward
// through the unclosed `{` above the parse and asks whether any of those blocks is a `try` block — which
// also keeps it quiet for a parse nested in an `if` or a synchronous arrow inside a try (both verified
// below). Not a parser, and it does not need to be: braces inside strings would only ever make it
// over-report, and it reports nothing on the 34 shipped files.
function inTry(src, pos) {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    const ch = src[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth > 0) { depth--; continue; }
      if (/\btry\s*$/.test(src.slice(Math.max(0, i - 8), i))) return true;   // this block encloses pos
    }
  }
  return false;
}
function unguardedLocalStorageParses(src) {
  const s = noComments(src);
  const out = [];
  const where = (at) => '@line ' + s.slice(0, at).split('\n').length;
  // 1 — the parse takes the read directly, on one line or across several
  for (const m of s.matchAll(/JSON\.parse\(\s*(?:[A-Za-z_$][\w$.]*\s*\(\s*)?localStorage/g)) {
    if (!inTry(s, m.index)) out.push('direct parse without a try ' + where(m.index) + ' → ' + s.slice(m.index, m.index + 60).replace(/\s+/g, ' '));
  }
  // 2 — the read goes into a variable and is parsed somewhere else
  for (const a of s.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?localStorage\.getItem/g)) {
    const name = a[1];
    for (const p of s.matchAll(new RegExp('JSON\\.parse\\(\\s*' + name + '\\b', 'g'))) {
      if (!inTry(s, p.index)) out.push('`' + name + '` was read from localStorage and is parsed without a try ' + where(p.index));
    }
  }
  // 3 — the read is handed to a reader function, which is where the parse lives (COR-1's own fix)
  for (const h of s.matchAll(/([A-Za-z_$][\w$]*)\s*\(\s*localStorage\.getItem/g)) {
    const fn = h[1];
    // `if (localStorage.getItem(…) !== '2')` is a keyword, not a reader — the first run of this guard
    // reported `if()` as an undefined function, which is the kind of noise that gets a guard deleted
    if (/^(if|while|for|switch|return|typeof|catch|do|else|await|new|delete|void)$/.test(fn)) continue;
    if (fn === 'parse' || fn === 'JSON') continue;
    const def = new RegExp('(?:function\\s+' + fn + '\\s*\\(|(?:const|let|var)\\s+' + fn + '\\s*=)');
    // this source first (the synthetic cases define their reader inline), then the shipped files
    let body = null;
    for (const owner of [s, ...BROWSER_FILES.map((rel) => noComments(read(rel)))]) {
      const i = owner.search(def);
      if (i < 0) continue;
      body = owner.slice(i, i + 900);
      break;
    }
    if (body === null) { out.push('`' + fn + '()` takes a raw localStorage read and is defined nowhere here'); continue; }
    if (/JSON\.parse\(/.test(body) && !/\btry\b/.test(body)) out.push('`' + fn + '()` parses a raw localStorage read without a try');
  }
  return out;
}

// ====================================================================================================
// PERM-1 — the approval dialog must not outlive the process it asks for
// ====================================================================================================
describe('PERM-1 — a gone process takes its permission gate with it', () => {
  const src = noComments(EVENTS_SRC);
  const branch = (from, to) => {
    const i = src.indexOf(from); assert.ok(i > 0, from + ' not found — the event switch changed shape');
    const j = to ? src.indexOf(to, i) : src.length;
    return src.slice(i, j > 0 ? j : src.length);
  };
  it('the `_exit` branch drops the gate, next to the AskUserQuestion cleanup it always did', () => {
    // CHAT-FLOW-4: the branch's cleanup lives in endTabProcess now (shared with `_superseded`, which must drop
    // the same gates) — so the branch has to call it, and the helper has to hold both
    const b = branch("case '_exit':", "case '_error':");
    assert.match(b, /endTabProcess\(chat\)/, 'the _exit branch no longer runs the shared cleanup');
    const fn = noComments(liftFn(EVENTS_SRC, 'endTabProcess', 'chat-events.js'));
    assert.match(fn, /dropPermsForTab\(tab\)/, 'the modal survives the process again: „Erlauben" POSTs to a dead chat');
    assert.match(fn, /clearAsksForTab\(tab\)/, 'the ask cleanup disappeared — check this function by hand');
  });
  it('…and so does `_error`, which can arrive with no `_exit` behind it', () => {
    const b = branch("case '_error':");
    assert.match(b, /dropPermsForTab\(chat\)/, 'a spawn failure leaves the gate standing, and hasOutstandingPerm true for good');
  });
  it('the function it calls is the one that also closes the overlay (a call into nothing is worse)', () => {
    const fn = noComments(liftFn(PERMS_SRC, 'dropPermsForTab', 'chat-perms.js'));
    assert.match(fn, /permQueue\.splice/, 'the queued requests of that tab are not dropped any more');
    assert.match(fn, /permOverlay'\)\.classList\.add\('hidden'\)/,
      'dropPermsForTab no longer hides the overlay — then the dialog stays visible with nothing behind it');
    assert.match(fn, /clearPermWaiter\('chat'\)/, 'the „Freigabe offen"-waiter would keep re-opening the overlay (C1)');
  });
});
