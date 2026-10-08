'use strict';
// BUILDER-1 — „Speichern & testen" and the builder draft, run instead of re-enacted.
//
// What happened before the fix: saveAndTest did `await saveBuilder(host); UISKILL_TAB = 'run'` without looking
// at the outcome. saveBuilder reported nothing — a duplicate field id ended in a bare `return`, a failed PUT in a
// toast inside its own catch — so the panel switched to the run tab in EVERY case and showed the OLD manifest
// there. Going back to „Bearbeiten" then threw the draft away for good: renderBuilderPanel re-read the file and
// rebuilt BUILDER from the server state on every render, with no notion of „unsaved". The same loss without any
// failed save: a tab switch and back, another skill, leaving the view, a language switch, a reload.
//
// HOW: one node:vm context holding the SHIPPED functions of public/js/views-uiskills.js, lifted by name (the seam
// of test/event-pump.js and test/two-windows.test.js). renderUiSkillPanel, the tab buttons it builds, the real
// renderBuilderPanel → drawBuilder → builderMeta → ubInput chain and loadUiSkills all run; a test types into the
// builder's own <input> and clicks the panel's own tab button. Stubbed are only the leaves this suite does not
// judge (the run form, history, schedule, cockpit, the list painter) — each of them RECORDS what it was handed.
// The server is a stand-in for GET/PUT /api/cfgfile, GET /api/uiskills and the delete/duplicate routes; its PUT
// contract (If-Match → 409 changed/unreadable, create → 409 exists with `existing`) and GET's „missing" are a COPY of
// the real route, which test/cfgfile-ifmatch.test.js pins against server.js. Change it there first, then here.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const crypto = require('crypto');
const { liftFn } = require('./event-pump');

const ROOT = path.join(__dirname, '..');
const UIS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views-uiskills.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
// comments stripped before a text pin: a comment that names the token would satisfy it while the code is gone
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*$/gm, '');

// ---- a DOM just big enough for the builder ----------------------------------------------------------------
class FakeEl {
  constructor(tag) { this.tagName = String(tag || 'div').toUpperCase(); this.children = []; this.parentElement = null; this.cls = new Set(); this.text = ''; this.attrs = {}; this.style = {}; this.dataset = {}; this.value = ''; this.disabled = false; this.listeners = {}; this.id = ''; this.onclick = null; this.oninput = null; this.onchange = null; }
  get className() { return [...this.cls].join(' '); }
  set className(v) { this.cls = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
  get classList() { const c = this.cls; return { add: (...a) => a.forEach((x) => c.add(x)), remove: (...a) => a.forEach((x) => c.delete(x)), contains: (x) => c.has(x), toggle: (x, on) => { const w = on === undefined ? !c.has(x) : !!on; if (w) c.add(x); else c.delete(x); return w; } }; }
  get textContent() { return this.text + this.children.map((k) => k.textContent).join(''); }
  set textContent(v) { this.text = String(v == null ? '' : v); for (const k of this.children) k.parentElement = null; this.children = []; }
  set innerHTML(v) { this.text = ''; for (const k of this.children) k.parentElement = null; this.children = []; }
  get innerHTML() { return ''; }
  get firstChild() { return this.children[0] || null; }
  get isConnected() { let n = this; while (n.parentElement) n = n.parentElement; return !!n.isRoot; }
  appendChild(k) { if (k.parentElement) k.remove(); k.parentElement = this; this.children.push(k); return k; }
  insertBefore(k, ref) { if (k.parentElement) k.remove(); const i = this.children.indexOf(ref); k.parentElement = this; if (i < 0) this.children.push(k); else this.children.splice(i, 0, k); return k; }
  remove() { const p = this.parentElement; if (p) { p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; } }
  replaceWith(k) { const p = this.parentElement; if (!p) return; const i = p.children.indexOf(this); if (k.parentElement) k.remove(); p.children[i] = k; k.parentElement = p; this.parentElement = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { const l = this.listeners[type] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
  // an event bubbles from here up to the root, like a real one
  dispatch(type) { const ev = { type, target: this, preventDefault() {}, stopPropagation() {} }; for (let n = this; n; n = n.parentElement) (n.listeners[type] || []).slice().forEach((f) => f(ev)); }
  walk(fn) { for (const k of this.children) { fn(k); k.walk(fn); } }
  find(pred) { let hit = null; this.walk((k) => { if (!hit && pred(k)) hit = k; }); return hit; }
  querySelectorAll(sel) {
    const m = /^\.([\w-]+)$/.exec(String(sel).trim());
    if (!m) throw new Error('fake DOM cannot read the selector ' + sel);
    const out = []; this.walk((k) => { if (k.cls.has(m[1])) out.push(k); }); return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  focus() {}
}
// the user's hands: type into a control (its own oninput, then the bubbling `input` the delegation listens to),
// click a button
const typeInto = (inp, value) => { inp.value = value; if (inp.oninput) inp.oninput(); inp.dispatch('input'); };
const click = async (b) => { assert.ok(b, 'the button to click is not there'); assert.ok(!b.disabled, 'the button is disabled'); await b.onclick({ stopPropagation() {}, preventDefault() {} }); await flush(); };

// ---- the server stand-in -----------------------------------------------------------------------------------
// `files`: name → text of ~/.claude/commands/<name>.md. GET /api/uiskills lists the files whose ```ui-skill block
// parses (lib/skills.js extractUiManifest: the block's JSON, nothing added). `gate(req)` may return a promise the
// request then waits for — the way a test holds a GET or a PUT open — or throw to fail it. `after(req)` is the same
// AFTER a file GET has read the file or a PUT has written it: an answer that read the old text but arrives late, a
// write that is on disk while its answer is still out. `unreadable`: names whose
// entry is there but cannot be read (a directory, a lock) — the route's EISDIR/EACCES case.
function fakeServer(files) {
  const srv = { files: new Map(Object.entries(files || {})), puts: [], gets: [], gate: null, after: null, unreadable: new Set() };
  const block = /```ui-skill\s*\n([\s\S]*?)\n```/;
  const fail = (status, data) => { const e = new Error((data && data.error) || 'HTTP ' + status); e.status = status; e.code = (data && data.code) || ''; e.data = data; return e; };
  srv.fail = fail;
  srv.api = async (url, init) => {
    await null;
    const method = (init && init.method) || 'GET';
    const body = init && init.body ? JSON.parse(init.body) : null;
    const headers = (init && init.headers) || {};
    const r = { url, method, body, headers };
    if (srv.gate) { const w = srv.gate(r); if (w) await w; }
    if (method === 'GET' && url === '/api/uiskills') {
      const skills = [];
      for (const [name, content] of srv.files) { const m = block.exec(content); let man = null; try { man = m && JSON.parse(m[1]); } catch { /* no valid block */ } if (man && typeof man === 'object') skills.push({ name, description: '', manifest: man }); }
      return { skills };
    }
    if (method === 'GET' && url === '/api/skill-favorites') return { favorites: [] };
    if (method === 'GET' && url === '/api/skills') return { commands: [...srv.files.keys()].map((name) => ({ name })), skills: [] };
    if (method === 'POST' && url === '/api/skill/duplicate') {
      srv.dups = (srv.dups || 0) + 1;
      if (srv.files.has(body.target)) throw fail(409, { error: 'command "' + body.target + '" existiert bereits' });
      srv.files.set(body.target, '---\ndescription: kopiert\n---\n\n# ' + body.target + '\n');
      return { ok: true };
    }
    let q = /^\/api\/cfgfile\?kind=commands&name=(.*)$/.exec(url);
    if (method === 'GET' && q) {
      const name = decodeURIComponent(q[1]); srv.gets.push(name);
      if (srv.unreadable.has(name)) throw fail(404, { error: 'EISDIR' });   // a 404, but NOT „missing"
      if (!srv.files.has(name)) throw fail(404, { error: 'ENOENT', code: 'missing' });
      const content = srv.files.get(name);
      const out = { content, hash: sha(content) };
      if (srv.after) { const w = srv.after(r); if (w) await w; }
      return out;
    }
    if (method === 'PUT' && url === '/api/cfgfile') {
      srv.puts.push(r);
      const name = body.name, exists = srv.files.has(name);
      const ifMatch = String(headers['If-Match'] || '').replace(/^"(.*)"$/, '$1');
      const clash = body.create === true && [...srv.files.keys()].find((k) => k.toLowerCase() === String(name).toLowerCase());
      if (clash) throw fail(409, { error: 'exists', code: 'exists', existing: clash + '.md' });
      if (ifMatch && srv.unreadable.has(name)) throw fail(409, { error: 'the file cannot be read right now', code: 'unreadable' });
      if (ifMatch && !exists) throw fail(409, { error: 'changed', code: 'changed', exists: false, hash: '' });
      if (ifMatch && sha(srv.files.get(name)) !== ifMatch) throw fail(409, { error: 'changed', code: 'changed', exists: true, hash: sha(srv.files.get(name)) });
      srv.files.set(name, body.content);
      if (srv.after) { const w = srv.after(r); if (w) await w; }
      return { ok: true, backup: exists ? 'bak' : null, hash: sha(body.content), created: !exists };
    }
    if (method === 'POST' && url === '/api/cfgfile/delete') {
      if (!srv.files.has(body.name)) throw fail(404, { error: 'ENOENT' });
      srv.files.delete(body.name);
      return { ok: true };
    }
    throw fail(404, { error: 'not found: ' + method + ' ' + url });
  };
  return srv;
}
const skillMd = (manifest, prose) => '---\ndescription: d\n---\n\n' + (prose || '# prosa') + '\n\n```ui-skill\n' + JSON.stringify(manifest, null, 2) + '\n```\n';
const manifestOf = (content) => JSON.parse(/```ui-skill\s*\n([\s\S]*?)\n```/.exec(content)[1]);

// ---- one panel ---------------------------------------------------------------------------------------------
const LIFT = [
  'serializeSkillMd', 'loadSkillFavs', 'loadUiSkills', 'openUiSkill', 'renderUiSkillPanel',
  'uniqueId', 'ubInput', 'ubLabel', 'ubRow', 'ubCheck', 'renderBuilderPanel', 'makeDraggable', 'lintManifest', 'saveAndTest',
  'insertAtCursor', 'placeholderMenu', 'drawBuilder', 'builderMeta', 'builderInputs', 'builderInputCard', 'builderOptions',
  'builderSteps', 'builderStepCard', 'builderTemplate', 'drawRawJson', 'saveBuilder', 'uiDefaultValues', 'treeDefaults', 'exportManifest', 'deleteUiSkill',
  // BUILDER-1
  'uiSkillSelFresh', 'builderSnapshot', 'builderRawPending', 'builderDirty', 'builderProbe', 'drawForeignDraft', 'builderShowDraft',
  'paintBuilderDirty', 'paintBuilderFileNote', 'builderDraftHint', 'persistBuilder', 'builderWrite', 'builderConflict', 'uiSkillCachePatch', 'paintUiSkillHead',
  'builderDraftMayGo', 'builderDiscard', 'builderDiscardAsk', 'builderCreateAgain', 'uiSkillsReload',
  // the other ways into the builder, and the quick start that goes through openUiSkill
  'fmDescription', 'convertToUiSkill', 'uiskillCreateNew', 'uiQuickStart',
];
function makePanel(srv, opts) {
  opts = opts || {};
  const rec = {};
  const note = (k) => (...a) => { (rec[k] = rec[k] || []).push(a); };
  const panel = new FakeEl('div'); panel.isRoot = true; panel.id = 'uiskillPanel';
  const list = new FakeEl('div'); list.isRoot = true; list.id = 'uiskillList';
  const fixed = { uiskillPanel: panel, uiskillList: list, uiskillSearch: Object.assign(new FakeEl('input'), { value: '' }), uiskillsCount: new FakeEl('span') };
  const byId = (id) => fixed[id] || panel.find((k) => k.id === id) || null;
  const modals = [], confirms = [], toasts = [];
  const answers = { modal: [], confirm: [], prompt: [] };
  const el = (tag, cls, txt) => { const e = new FakeEl(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const ctx = {
    console, JSON, Object, Array, String, Number, Boolean, Math, Date, Map, Set, Promise, Error, TypeError, RegExp, encodeURIComponent, decodeURIComponent,
    setTimeout, clearTimeout,
    t: (k) => String(k), LANG: 'de',
    el, $: (sel) => (String(sel).startsWith('#') ? byId(String(sel).slice(1)) : null),
    document: { getElementById: byId, createElement: (tag) => new FakeEl(tag) },
    ic: () => '', mkClickable: (e) => e,
    iconBtn: (cls, icon, o) => { o = o || {}; const b = el('button', cls); if (o.label) b.appendChild(el('span', 'btxt', o.label)); if (o.title) b.title = o.title; const al = o.title || o.label; if (al) b.setAttribute('aria-label', al); if (o.onClick) b.onclick = o.onClick; return b; },
    api: srv.api,
    toast: (msg, kind) => { toasts.push([String(msg), kind]); },
    uiModal: (o) => { modals.push(o); return Promise.resolve(answers.modal.length ? answers.modal.shift() : o.escValue); },
    uiConfirm: (msg, o) => { confirms.push([msg, o]); return Promise.resolve(answers.confirm.length ? answers.confirm.shift() : false); },
    // the module state of views-uiskills.js (its top-level `let`s), at their boot values
    UISKILLS_DATA: null, UISKILL_SEL: null, UISKILL_TAB: 'run', BUILDER: null, BUILDER_SEQ: 0, RUN_SKILL: null, RUN_VALUES: {}, RUN_MODE: 'single',
    UISKILL_PREFILL: null, SKILL_FAVS: new Set(), DRAG: null,
    // leaves this suite does not judge — each one records what it was handed
    renderUiSkillList: note('list'), renderUiSkillCockpit: note('cockpit'), errorCard: note('errorCard'),
    renderRunPanel: (host, s) => { note('run')(s.name, JSON.parse(JSON.stringify(s.manifest || {})), ctx.RUN_SKILL); host.appendChild(el('div', 'fake-run', 'run ' + s.name)); },
    renderHistoryPanel: (host, s) => { note('history')(s.name); },
    renderSchedulePanel: (host, s) => { note('schedule')(s.name); },
    uiResultContractSnippet: () => '', buildInput: () => el('div'),
    uiPrompt: () => Promise.resolve(answers.prompt.length ? answers.prompt.shift() : null),
    startUiRun: note('startRun'), lastInputs: () => null, uiAutoRunDefault: () => false,
  };
  Object.assign(ctx, opts.stubs || {});
  vm.createContext(ctx);
  for (const name of ['UI_BLOCK_RE', 'OPTION_FIELD_TYPES']) {
    const m = new RegExp('^const ' + name + ' = .*;$', 'm').exec(UIS_SRC);
    assert.ok(m, name + ' moved'); vm.runInContext(m[0], ctx);
  }
  for (const n of LIFT.concat(opts.lift || [])) vm.runInContext(liftFn(UIS_SRC, n, 'views-uiskills.js'), ctx, { filename: 'views-uiskills.js#' + n });
  // render counting goes through the global binding the shipped code calls
  const realRender = ctx.renderUiSkillPanel;
  ctx.renderUiSkillPanel = (...a) => { note('render')(ctx.UISKILL_TAB); return realRender(...a); };
  const realLoad = ctx.loadUiSkills;
  ctx.loadUiSkills = (...a) => { note('load')(ctx.UISKILL_TAB, ctx.RUN_SKILL); return realLoad(...a); };
  return {
    ctx, srv, rec, panel, modals, confirms, toasts, answers,
    count: (k) => (rec[k] || []).length,
    reset: () => { for (const k of Object.keys(rec)) delete rec[k]; modals.length = 0; confirms.length = 0; toasts.length = 0; },
    // the panel's own sub-tab buttons, in the order renderUiSkillPanel builds them
    tab: (id) => { const bar = panel.querySelector('.uiskill-subtabs'); return bar ? bar.children[['run', 'edit', 'history', 'schedule'].indexOf(id)] || null : null; },
    // the builder's own title field: the first control the builder named „Titel" (builderMeta's, above the steps)
    titleInput: () => panel.find((k) => k.tagName === 'INPUT' && k.attrs['aria-label'] === 'views-bug.titel'),
    button: (label) => panel.find((k) => k.tagName === 'BUTTON' && k.textContent === label),
    // the panel head's title (renderUiSkillPanel's h2) and what the file note above the builder says
    headTitle: () => { const h = panel.querySelector('.uh-name'); return h ? h.textContent : null; },
    fileNote: () => { const n = panel.find((k) => k.id === 'ubFileNote'); return !n || n.cls.has('hidden') ? '' : n.children[0].textContent; },
    // strict: an element that is not there at all is no proof of anything being hidden
    hidden: (id) => { const n = panel.find((k) => k.id === id); assert.ok(n, '#' + id + ' is not on screen'); return n.cls.has('hidden'); },
  };
}
const M0 = () => ({ version: 1, title: 'alt', inputs: [{ id: 'thema', type: 'text', label: 'Thema' }], steps: [], run: { permissionMode: 'plan' }, promptTemplate: '/x {{thema}}' });
// a panel with skill x selected and its builder open — what the user sees after clicking „Bearbeiten"
async function openBuilder(files, opts) {
  const srv = fakeServer(files || { x: skillMd(M0()) });
  const P = makePanel(srv, opts);
  await P.ctx.loadUiSkills();
  P.ctx.UISKILL_SEL = P.ctx.UISKILLS_DATA.find((s) => s.name === 'x');
  P.ctx.UISKILL_TAB = 'edit';
  P.ctx.renderUiSkillPanel();
  await flush();
  assert.ok(P.titleInput(), 'premise: the builder is drawn');
  P.reset();
  return P;
}

// ============================================================================================================
// The save cases click the builder's OWN buttons (drawBuilder's toolbar): a test that called saveAndTest() directly
// stayed green with the old one-liner wired back into the button.
describe('BUILDER-1 — „Speichern & testen" looks at the save before it switches', () => {
  for (const [what, err] of [
    ['a 500', { status: 500, data: { error: 'EPERM' } }],
    ['a 401 token-required', { status: 401, data: { error: 'token required', code: 'token-required' } }],
    ['a network error', null],
  ]) {
    it('a failed save (' + what + ') stays in the builder, draft intact, no run tab with the old manifest', async () => {
      const P = await openBuilder();
      typeInto(P.titleInput(), 'NEU getippt');
      let sent = 0;
      P.srv.gate = (r) => { if (r.method === 'PUT') { sent++; throw err ? P.srv.fail(err.status, err.data) : new TypeError('Failed to fetch'); } };
      await click(P.button('views-uiskills.speichernTesten'));
      assert.equal(sent, 1, 'premise: the button sent the PUT');
      assert.equal(P.ctx.UISKILL_TAB, 'edit', 'the panel switched to the run tab although nothing was saved');
      assert.equal(P.count('run'), 0, 'the run form was drawn — with the OLD manifest');
      assert.equal(P.ctx.BUILDER.manifest.title, 'NEU getippt', 'the draft is gone');
      assert.equal(manifestOf(P.srv.files.get('x')).title, 'alt', 'premise: the file was not written');
      assert.ok(P.toasts.some(([, k]) => k === 'err'), 'the failure was not reported');
    });
  }

  it('a duplicate field id is refused before any PUT — and refused means: stay', async () => {
    const P = await openBuilder();
    P.ctx.BUILDER.manifest.inputs.push({ id: 'thema', type: 'text', label: 'zwei' });
    await click(P.button('views-uiskills.speichernTesten'));
    assert.equal(P.srv.puts.length, 0, 'a manifest with a duplicate id was written');
    assert.ok(P.toasts.some(([m]) => m === 'views-uiskills.doppelteFeldIdsBitte'));
    assert.equal(P.ctx.UISKILL_TAB, 'edit');
    assert.equal(P.count('run'), 0);
  });
});

describe('BUILDER-1 — the draft survives the panel re-rendering around it', () => {
  it('Bearbeiten → tippen → Ausführen → Bearbeiten: the typed title is still there (real tab buttons)', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'NEU getippt');
    await click(P.tab('run'));
    assert.equal(P.ctx.UISKILL_TAB, 'run');
    await click(P.tab('edit'));
    assert.equal(P.titleInput().value, 'NEU getippt', 'the tab switch threw the draft away (the builder was rebuilt from the file)');
    assert.equal(P.ctx.BUILDER.manifest.title, 'NEU getippt');
  });

  it('leaving the view and coming back (loadUiSkills re-renders the panel) keeps it too', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'NEU getippt');
    await P.ctx.loadUiSkills();
    await flush();
    assert.equal(P.titleInput().value, 'NEU getippt', 'loadUiSkills (view entry, language switch, ↻) threw the draft away');
  });

  it('a stale GET cannot take BUILDER over from the builder that is on screen', async () => {
    const P = await openBuilder();
    const held = [];
    P.srv.gate = (r) => { if (r.method === 'GET' && r.url.startsWith('/api/cfgfile?')) return new Promise((res) => held.push(res)); };
    const s = P.ctx.UISKILL_SEL;
    const hostA = new FakeEl('div'), hostB = new FakeEl('div');
    P.panel.appendChild(hostA); P.panel.appendChild(hostB);
    P.ctx.BUILDER = null;
    P.ctx.renderBuilderPanel(hostA, s);
    P.ctx.renderBuilderPanel(hostB, s);
    await flush();
    assert.equal(held.length, 2, 'premise: two GETs in flight');
    held[1](); await flush();   // the later call answers first …
    held[0](); await flush();   // … the earlier one last
    P.srv.gate = null;
    const titleB = hostB.find((k) => k.tagName === 'INPUT' && k.attrs['aria-label'] === 'views-bug.titel');
    assert.ok(titleB, 'the later builder is drawn');
    typeInto(titleB, 'in B getippt');
    await P.ctx.saveBuilder();
    await flush();
    assert.equal(manifestOf(P.srv.files.get('x')).title, 'in B getippt', 'the save wrote the manifest of a builder nobody sees — the typed title is not in the file');
  });
});

describe('BUILDER-1 — a save that worked', () => {
  it('„Speichern & testen": one PUT, one list read — with the run tab and RUN_SKILL reset BEFORE it renders', async () => {
    const P = await openBuilder();
    P.ctx.RUN_SKILL = 'x';             // the run form was used before: its values belong to the OLD manifest
    typeInto(P.titleInput(), 'NEU');
    await click(P.button('views-uiskills.speichernTesten'));
    assert.equal(P.srv.puts.length, 1);
    assert.deepEqual(P.rec.load, [['run', null]], 'loadUiSkills must render the run tab with RUN_SKILL reset — else renderRunPanel keeps the old values');
    assert.equal(P.count('render'), 1, 'the panel is rendered by loadUiSkills, once — a second render is a second GET for a second host');
    const run = P.rec.run[P.rec.run.length - 1];
    assert.equal(run[1].title, 'NEU', 'the run tab shows the manifest that was just saved');
    assert.equal(P.ctx.builderDirty(), false);
    assert.equal(manifestOf(P.srv.files.get('x')).title, 'NEU');
  });

  it('„Speichern": true, the builder stays, one list read and one render — false when it did not work', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'NEU');
    await click(P.button('common.speichern'));
    assert.equal(manifestOf(P.srv.files.get('x')).title, 'NEU', '„Speichern" wrote nothing');
    assert.equal(P.ctx.UISKILL_TAB, 'edit');
    assert.equal(P.count('load'), 1);
    assert.equal(P.count('render'), 1);
    assert.equal(P.titleInput().value, 'NEU');
    P.reset();
    typeInto(P.titleInput(), 'NEU 2');
    assert.equal(await P.ctx.saveBuilder(), true);
    P.srv.gate = (r) => { if (r.method === 'PUT') throw P.srv.fail(500, { error: 'EPERM' }); };
    typeInto(P.titleInput(), 'NOCHMAL');
    assert.equal(await P.ctx.saveBuilder(), false);
  });

  it('what is typed WHILE the PUT is out stays a draft — it was not sent, so it is not saved', async () => {
    const P = await openBuilder();
    let release;
    P.srv.gate = (r) => { if (r.method === 'PUT') return new Promise((res) => { release = res; }); };
    typeInto(P.titleInput(), 'T1');
    const saving = P.ctx.saveBuilder();
    await flush();
    typeInto(P.titleInput(), 'T1 und mehr');   // the form stays live during the save
    P.srv.gate = null; release();
    assert.equal(await saving, true);
    await flush();
    assert.equal(manifestOf(P.srv.files.get('x')).title, 'T1', 'premise: the PUT carried what was there when it was sent');
    assert.equal(P.ctx.builderDirty(), true, 'the later typing was counted as saved (snapshot taken after the await)');
    assert.equal(P.titleInput().value, 'T1 und mehr', 'the reload after the save threw the later typing away');
  });

  it('a save does not write into a BUILDER that was replaced while its PUT was out (no TypeError, no stray body)', async () => {
    const P = await openBuilder();
    let release;
    P.srv.gate = (r) => { if (r.method === 'PUT') return new Promise((res) => { release = res; }); };
    typeInto(P.titleInput(), 'NEU');
    const saving = P.ctx.persistBuilder();
    await flush();
    P.ctx.BUILDER = null;              // „Verwerfen" in between
    P.srv.gate = null; release();
    assert.equal(await saving, true, 'the write worked — the answer must say so');
    assert.ok(!P.toasts.some(([, k]) => k === 'err'), 'an error was reported for a save that worked');
    assert.equal(P.ctx.BUILDER, null);
  });

  it('a double click sends ONE PUT — the second would carry a version the first is about to make stale', async () => {
    const P = await openBuilder();
    const held = [];                   // every PUT that went out, each held until released — none is left hanging
    P.srv.gate = (r) => { if (r.method === 'PUT') return new Promise((res) => held.push(res)); };
    typeInto(P.titleInput(), 'NEU');
    const a = P.ctx.persistBuilder(), b = P.ctx.persistBuilder();
    await flush();
    const sent = held.length;
    P.srv.gate = null; held.forEach((res) => res());
    const answers = [await a, await b];
    assert.equal(sent, 1, 'the second click sent its own PUT while the first was still out');
    assert.deepEqual(answers, [true, true]);
    assert.equal(P.srv.puts.length, 1);
    assert.equal(P.modals.length, 0, 'the second click met the „changed elsewhere" dialog for a save that worked');
  });

  it('lint WARNINGS do not block a save — only errors do (a duplicate id)', async () => {
    const P = await openBuilder();
    P.ctx.BUILDER.manifest.promptTemplate = '/x {{gibtsNicht}}';
    assert.ok(P.ctx.lintManifest(P.ctx.BUILDER.manifest).length > 0, 'premise: the builder warns about it');
    assert.equal(await P.ctx.saveBuilder(), true);
    assert.equal(P.srv.puts.length, 1);
  });

  it('the list read fails after the PUT: the cache already holds the saved manifest, and the run tab is drawn anyway', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'NEU');
    P.srv.gate = (r) => { if (r.url === '/api/uiskills') throw P.srv.fail(503, { error: 'restart' }); };
    assert.equal(await P.ctx.saveAndTest(), true);
    await flush();
    assert.equal(P.ctx.UISKILL_SEL.manifest.title, 'NEU', 'the selection still holds the OLD manifest — the next edit would build from it');
    const run = P.rec.run && P.rec.run[P.rec.run.length - 1];
    assert.ok(run, 'the panel stayed on the builder: nothing drew the run tab after the failed list read');
    assert.equal(run[1].title, 'NEU');
  });
});

describe('BUILDER-1 — „unsaved" is computed, not flagged', () => {
  it('a fresh builder is clean — the defaults it adds (inputs/steps/run) are no change anybody made', async () => {
    const P = await openBuilder({ x: skillMd({ version: 1, title: 'nackt', promptTemplate: '/x' }) });
    assert.equal(P.ctx.builderDirty(), false, 'a skill without inputs/steps/run opens as „ungespeichert"');
  });

  it('typed → dirty, typed back → clean; a raw import of the same content → clean, of other content → dirty', async () => {
    const P = await openBuilder();
    assert.equal(P.ctx.builderDirty(), false);
    typeInto(P.titleInput(), 'NEU');
    assert.equal(P.ctx.builderDirty(), true);
    typeInto(P.titleInput(), 'alt');
    assert.equal(P.ctx.builderDirty(), false, 'typing the change back must make the draft clean again');
    P.ctx.BUILDER.manifest = JSON.parse(JSON.stringify(P.ctx.BUILDER.manifest));
    assert.equal(P.ctx.builderDirty(), false, 'a new object with the same content is no change');
    P.ctx.BUILDER.manifest = Object.assign({}, P.ctx.BUILDER.manifest, { icon: '★' });
    assert.equal(P.ctx.builderDirty(), true);
    P.ctx.BUILDER = null;
    assert.equal(P.ctx.builderDirty(), false);
  });

  it('the marker says it while it is true: badge, „Verwerfen", the dot on the tab and its name', async () => {
    const P = await openBuilder();
    const hidden = (id) => P.panel.find((k) => k.id === id).cls.has('hidden');
    const dot = () => P.tab('edit').querySelector('.ust-draft');
    assert.ok(hidden('ubDirty') && hidden('ubDiscard') && dot().cls.has('hidden'), 'a clean builder shows no marker');
    typeInto(P.titleInput(), 'NEU');
    assert.ok(!hidden('ubDirty'), '„● ungespeichert" is not shown');
    assert.ok(!hidden('ubDiscard'), 'there is no way out of the kept draft');
    assert.ok(!dot().cls.has('hidden'), 'the tab does not show the draft');
    assert.match(P.tab('edit').getAttribute('aria-label') || '', /entwurfAria/, 'a screen reader does not hear it');
    typeInto(P.titleInput(), 'alt');
    assert.ok(hidden('ubDirty') && dot().cls.has('hidden'), 'the marker stays after the draft is gone');
  });

  it('the run and schedule tabs say that they use the SAVED version while a draft is open', async () => {
    const P = await openBuilder();
    await click(P.tab('run'));
    assert.equal(P.panel.querySelector('.ub-draft-note'), null, 'a hint without a draft is noise');
    await click(P.tab('edit'));
    typeInto(P.titleInput(), 'NEU');
    await click(P.tab('run'));
    const note = P.panel.querySelector('.ub-draft-note');
    assert.ok(note, 'the run form looks like the version that was just edited');
    assert.match(note.textContent, /entwurfHinweisLauf/);
    assert.ok(!P.tab('edit').querySelector('.ust-draft').cls.has('hidden'), 'the draft is not marked from the run tab');
    await click(P.tab('schedule'));
    const note2 = P.panel.querySelector('.ub-draft-note');
    assert.ok(note2, 'the schedule stores the saved version too');
    await click(note2.find((k) => k.tagName === 'BUTTON'));
    assert.equal(P.ctx.UISKILL_TAB, 'edit');
    assert.equal(P.titleInput().value, 'NEU');
  });
});

describe('BUILDER-1 — the question, where the draft would really be replaced', () => {
  const dirtyX = async () => { const P = await openBuilder({ x: skillMd(M0()), y: skillMd(Object.assign(M0(), { title: 'Y' })) }); typeInto(P.titleInput(), 'NEU'); return P; };

  it('builderDraftMayGo: a clean builder asks nothing', async () => {
    const P = await openBuilder();
    assert.equal(await P.ctx.builderDraftMayGo(), true);
    assert.equal(P.modals.length, 0);
  });

  it('builderDraftMayGo: Abbrechen and Esc keep the draft; „Verwerfen" lets it go', async () => {
    for (const answer of ['cancel', null, undefined, false]) {
      const P = await dirtyX();
      const b = P.ctx.BUILDER;
      P.answers.modal.push(answer);
      assert.equal(await P.ctx.builderDraftMayGo(), false, 'answer ' + JSON.stringify(answer) + ' let the draft go');
      assert.equal(P.ctx.BUILDER, b);
    }
    const P = await dirtyX();
    const b = P.ctx.BUILDER;
    P.answers.modal.push('discard');
    assert.equal(await P.ctx.builderDraftMayGo(), true);
    assert.notEqual(P.ctx.BUILDER, b, 'the discarded draft is still what the builder holds');
    assert.equal(P.ctx.builderDirty(), false);
  });

  it('builderDraftMayGo: „Speichern" releases the draft only when the save SUCCEEDED', async () => {
    const ok = await dirtyX();
    ok.answers.modal.push('save');
    assert.equal(await ok.ctx.builderDraftMayGo(), true);
    assert.equal(manifestOf(ok.srv.files.get('x')).title, 'NEU');
    const bad = await dirtyX();
    bad.srv.gate = (r) => { if (r.method === 'PUT') throw bad.srv.fail(500, { error: 'EPERM' }); };
    bad.answers.modal.push('save');
    assert.equal(await bad.ctx.builderDraftMayGo(), false, 'a failed save let the draft be dropped');
    assert.equal(bad.ctx.BUILDER.manifest.title, 'NEU');
  });

  it('the dialog offers THREE answers, and Esc means cancel', () => {
    const src = noComments(liftFn(UIS_SRC, 'builderDraftMayGo', 'views-uiskills.js'));
    for (const v of ["'cancel'", "'discard'", "'save'"]) assert.ok(src.includes(v), 'the ' + v + ' action is gone');
    assert.match(src, /escValue:\s*'cancel'/);
  });

  it('openUiSkill: another skill with a draft open asks — „Abbrechen" stays on the draft, nothing re-rendered', async () => {
    const P = await dirtyX();
    const y = P.ctx.UISKILLS_DATA.find((s) => s.name === 'y');
    P.answers.modal.push('cancel');
    assert.equal(await P.ctx.openUiSkill(y), false);
    assert.equal(P.ctx.UISKILL_SEL.name, 'x');
    assert.equal(P.count('render'), 0);
    assert.equal(P.ctx.BUILDER.manifest.title, 'NEU');
  });

  it('openUiSkill: „Verwerfen" switches, to the tab that was asked for', async () => {
    const P = await dirtyX();
    const y = P.ctx.UISKILLS_DATA.find((s) => s.name === 'y');
    P.answers.modal.push('discard');
    assert.equal(await P.ctx.openUiSkill(y, 'history'), true);
    assert.equal(P.ctx.UISKILL_SEL.name, 'y');
    assert.equal(P.ctx.UISKILL_TAB, 'history');
  });

  it('openUiSkill: the SAME skill asks nothing — the draft is kept', async () => {
    const P = await dirtyX();
    assert.equal(await P.ctx.openUiSkill(P.ctx.UISKILL_SEL), true);
    assert.equal(P.modals.length, 0);
    assert.equal(P.ctx.BUILDER.manifest.title, 'NEU');
  });

  it('„Speichern" in the question: the cached list holds the saved manifest — x reopens with it, and its next save does not write the old one back', async () => {
    const P = await dirtyX();
    const x = P.ctx.UISKILL_SEL, y = P.ctx.UISKILLS_DATA.find((s) => s.name === 'y');
    P.answers.modal.push('save');
    assert.equal(await P.ctx.openUiSkill(y), true);
    await flush();
    assert.equal(x.manifest.title, 'NEU', 'the list entry of x still holds the old manifest');
    await P.ctx.openUiSkill(x, 'edit');
    await flush();
    assert.equal(P.titleInput().value, 'NEU', 'x reopened with the version from before the save');
    await P.ctx.saveBuilder();
    assert.equal(manifestOf(P.srv.files.get('x')).title, 'NEU', 'the next save wrote the old version back');
  });

  it('the quick start ▶ of another skill: refused switch → nothing started', async () => {
    const P = await dirtyX();
    P.answers.modal.push('cancel');
    await P.ctx.uiQuickStart(P.ctx.UISKILLS_DATA.find((s) => s.name === 'y'));
    assert.equal(P.count('startRun'), 0, 'a run of y started while the panel stayed on x');
  });

  it('„Aus Skill erstellen" asks before anything — also on the branch that only OPENS the existing -ui skill', async () => {
    const P = await dirtyX();
    P.srv.files.set('z-ui', skillMd(Object.assign(M0(), { title: 'Z' })));
    await P.ctx.loadUiSkills(); await flush(); P.reset();
    P.answers.modal.push('cancel');
    await P.ctx.convertToUiSkill('z', 'command');
    assert.equal(P.modals.length, 1, 'the draft was not asked about');
    assert.equal(P.modals[0].title, 'views-uiskills.entwurfTitel');
    assert.equal(P.srv.dups || 0, 0, 'the duplicate was attempted before the question');
    assert.equal(P.ctx.UISKILL_SEL.name, 'x');
    assert.equal(P.ctx.BUILDER.manifest.title, 'NEU');
  });

  it('„Neuer UI-Skill" asks before its PUT', async () => {
    const P = await dirtyX();
    P.answers.prompt.push('neu');
    P.answers.modal.push('cancel');
    await P.ctx.uiskillCreateNew();
    assert.equal(P.modals.length, 1);
    assert.equal(P.srv.puts.length, 0, 'the new skill was written (and opened over the draft) without asking');
    assert.equal(P.ctx.BUILDER.manifest.title, 'NEU');
  });

  it('the net: renderBuilderPanel never loads another skill over a dirty draft — it leads back to it', async () => {
    const P = await dirtyX();
    const host = new FakeEl('div'); P.panel.appendChild(host);
    const y = P.ctx.UISKILLS_DATA.find((s) => s.name === 'y');
    await P.ctx.renderBuilderPanel(host, y);
    await flush();
    assert.ok(!P.srv.gets.includes('y'), 'y was loaded over the draft of x');
    assert.equal(P.ctx.BUILDER.name, 'x');
    assert.equal(P.ctx.BUILDER.manifest.title, 'NEU');
    const go = host.find((k) => k.tagName === 'BUTTON');
    assert.match(go.textContent, /entwurfZuSkill/);
    P.ctx.UISKILL_SEL = y;
    await click(go);
    assert.equal(P.ctx.UISKILL_SEL.name, 'x');
    assert.equal(P.ctx.UISKILL_TAB, 'edit');
  });
});

describe('BUILDER-1 — the file under a kept draft (If-Match, deletion)', () => {
  it('the save sends the version the builder was loaded from', async () => {
    const P = await openBuilder();
    const loaded = P.srv.files.get('x');
    typeInto(P.titleInput(), 'NEU');
    await P.ctx.saveBuilder();
    assert.equal(P.srv.puts[0].headers['If-Match'], '"' + sha(loaded) + '"', 'without If-Match a kept draft overwrites whatever was written meanwhile');
  });

  it('changed elsewhere: „Abbrechen" writes nothing and keeps the draft; the builder says the file changed', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'Entwurf');
    P.srv.files.set('x', skillMd(Object.assign(M0(), { title: 'von der CLI' })));
    P.answers.modal.push('cancel');
    await click(P.button('views-uiskills.speichernTesten'));
    assert.equal(P.modals[0].title, 'views.settGeaendertTitel');
    assert.equal(P.count('run'), 0, 'a save the conflict dialog cancelled switched to the run tab');
    assert.equal(manifestOf(P.srv.files.get('x')).title, 'von der CLI', 'the change made elsewhere was overwritten');
    assert.equal(P.ctx.UISKILL_TAB, 'edit');
    assert.equal(P.ctx.BUILDER.manifest.title, 'Entwurf');
    const note = P.panel.find((k) => k.id === 'ubFileNote');
    assert.ok(note && !note.cls.has('hidden') && /entwurfBannerGeaendert/.test(note.textContent), 'the builder does not say that the file changed');
  });

  it('changed elsewhere: „Überschreiben" writes over exactly the version the 409 reported', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'Entwurf');
    const theirs = skillMd(Object.assign(M0(), { title: 'von der CLI' }));
    P.srv.files.set('x', theirs);
    P.answers.modal.push('overwrite');
    assert.equal(await P.ctx.saveBuilder(), true);
    assert.equal(P.srv.puts.length, 2);
    assert.equal(P.srv.puts[1].headers['If-Match'], '"' + sha(theirs) + '"');
    assert.equal(manifestOf(P.srv.files.get('x')).title, 'Entwurf');
    assert.equal(P.ctx.builderDirty(), false);
  });

  it('changed elsewhere, overwritten: the note about the file goes with the save — not only with the next render', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'Entwurf');
    P.srv.files.set('x', skillMd(Object.assign(M0(), { title: 'von der CLI' })));
    P.answers.modal.push('overwrite');
    assert.equal(await P.ctx.persistBuilder(), true);   // no list reload after it: what the save itself repaints
    assert.equal(P.ctx.BUILDER.changed, false);
    assert.equal(P.fileNote(), '', 'the builder still says „changed elsewhere" about the file it just wrote');
  });

  it('changed elsewhere: „Neu laden" shows the file as it is now and drops the draft', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'Entwurf');
    P.srv.files.set('x', skillMd(Object.assign(M0(), { title: 'von der CLI' })));
    P.answers.modal.push('reload');
    assert.equal(await P.ctx.saveBuilder(), false);
    await flush();
    assert.equal(P.titleInput().value, 'von der CLI');
    assert.equal(P.ctx.builderDirty(), false);
  });

  it('a kept draft looks at its file on the way back: a change elsewhere is said before anyone saves', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'Entwurf');
    await click(P.tab('run'));
    P.srv.files.set('x', skillMd(Object.assign(M0(), { title: 'von der CLI' })));
    await click(P.tab('edit'));
    const note = P.panel.find((k) => k.id === 'ubFileNote');
    assert.ok(!note.cls.has('hidden') && /entwurfBannerGeaendert/.test(note.textContent), 'the change elsewhere is only found out at the save');
    assert.equal(P.titleInput().value, 'Entwurf', 'the probe must not touch the draft');
  });

  it('a probe that a save overtook is dropped — it read the file BEFORE that save', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'Entwurf');
    await click(P.tab('run'));
    let release;
    P.srv.gate = (r) => { if (r.method === 'GET' && r.url.startsWith('/api/cfgfile?')) { P.srv.gate = null; return new Promise((res) => { release = res; }); } };
    await click(P.tab('edit'));            // keep branch → its probe is held
    assert.ok(release, 'premise: the probe is in flight');
    const before = P.srv.files.get('x');
    P.srv.files.set('x', before + ' ');    // the probe will read THIS text …
    assert.equal(await P.ctx.persistBuilder({ tag: sha(before + ' ') }), true);   // … and a save moves the version on before it answers
    release(); await flush();
    const note = P.panel.find((k) => k.id === 'ubFileNote');
    assert.ok(!note || note.cls.has('hidden'), 'a stale probe claimed „changed elsewhere" about a file the builder itself just wrote');
  });

  it('deleted while the draft is open: the builder says so and re-creates it as a NEW file on request', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'Entwurf');
    await click(P.tab('run'));
    P.srv.files.delete('x');
    await click(P.tab('edit'));
    const note = P.panel.find((k) => k.id === 'ubFileNote');
    assert.ok(!note.cls.has('hidden') && /entwurfBannerGeloescht/.test(note.textContent), 'the deletion is not said');
    assert.ok(P.hidden('ubDelete'), '„Löschen" is offered for a file that is gone — it promises a backup and meets a 404');
    await click(note.find((k) => k.tagName === 'BUTTON' && /entwurfNeuAnlegen/.test(k.textContent)));
    assert.ok(!P.hidden('ubDelete'), 'the file is there again — so is „Löschen"');
    const put = P.srv.puts[P.srv.puts.length - 1];
    assert.equal(put.body.create, true, 'the draft of a deleted skill must be written as a NEW file, never over one');
    assert.equal(manifestOf(P.srv.files.get('x')).title, 'Entwurf');
    assert.equal(P.ctx.builderDirty(), false);
  });

  // Abnahme PR-15c, found while fixing it: the note is repainted with the dirty badge — on every `input`, and on the
  // `change` that the blur of a click fires between mousedown and mouseup. Rebuilt there, the button that was
  // pressed is gone before it is released, and „Als neue Datei anlegen" right after typing does nothing.
  it('typing, then a click on the note’s button: the blur of that click does not replace the button under it', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'Entwurf');
    await click(P.tab('run'));
    P.srv.files.delete('x');
    await click(P.tab('edit'));
    const create = () => P.panel.find((k) => k.tagName === 'BUTTON' && k.textContent === 'views-uiskills.entwurfNeuAnlegen');
    const pressed = create();
    assert.ok(pressed, 'premise: the note offers „Als neue Datei anlegen"');
    typeInto(P.titleInput(), 'Entwurf weiter');   // still a draft: the note says the same
    P.titleInput().dispatch('change');            // the field loses focus to the button being pressed
    assert.ok(pressed.isConnected, 'the note was rebuilt under the pointer — the click meets a button that is gone');
    // …while a change of what the note SAYS still repaints it: typed back to clean, the way out is „Schließen"
    typeInto(P.titleInput(), 'alt');
    assert.equal(P.fileNote(), '⚠ views-uiskills.entwurfBannerGeloeschtSauber');
    assert.ok(P.button('common.schliessen'));
  });

  it('deleted, and the save meets it: the 409 offers „Als neue Datei anlegen" — which refuses a name taken meanwhile', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'Entwurf');
    P.srv.files.delete('x');
    P.answers.modal.push('create');
    assert.equal(await P.ctx.saveBuilder(), true);
    assert.equal(P.modals[0].title, 'views-uiskills.entwurfGeloeschtTitel');
    assert.equal(manifestOf(P.srv.files.get('x')).title, 'Entwurf');
    const Q = await openBuilder(null, { stubs: { t: (k) => (k === 'views-uiskills.entwurfNameBelegt' ? 'belegt: /{name}' : String(k)) } });
    typeInto(Q.titleInput(), 'Entwurf');
    Q.srv.files.delete('x');
    Q.srv.gate = (r) => { if (r.method === 'PUT' && r.body.create) Q.srv.files.set('X', 'fremd'); };
    Q.answers.modal.push('create');
    assert.equal(await Q.ctx.saveBuilder(), false);
    assert.equal(Q.srv.files.get('X'), 'fremd');
    assert.ok(Q.toasts.some(([m]) => m === 'belegt: /X'), 'the refusal names the spelling of the draft, not the file that took the name: ' + JSON.stringify(Q.toasts));
    assert.equal(Q.ctx.BUILDER.manifest.title, 'Entwurf');
  });

  it('a skill that leaves the LIST while its draft is open stays reachable as an orphan — edit tab only', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'Entwurf');
    await click(P.tab('run'));           // looked at from the run tab — which has nothing to run once the file is gone
    P.srv.files.delete('x');
    await P.ctx.loadUiSkills();
    await flush();
    assert.ok(P.ctx.UISKILL_SEL, 'the panel dropped to the cockpit — the draft is out of reach');
    assert.equal(P.ctx.UISKILL_SEL.orphan, true);
    assert.equal(P.ctx.UISKILL_TAB, 'edit', 'the orphan was shown on a tab that runs a skill which is not there');
    assert.equal(P.titleInput().value, 'Entwurf');
    for (const id of ['run', 'history', 'schedule']) assert.equal(P.tab(id).disabled, true, id + ' is offered for a skill that is not there');
    const note = P.panel.find((k) => k.id === 'ubFileNote');
    assert.match(note.textContent, /entwurfBannerGeloescht/, 'the builder does not say what happened to the file');
    const Q = await openBuilder();       // …and without a draft there is nothing to keep
    Q.srv.files.delete('x');
    await Q.ctx.loadUiSkills();
    assert.equal(Q.ctx.UISKILL_SEL, null);
  });

  it('leaving the list is said at once — before the probe has an answer about the file', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'Entwurf');
    let release;
    P.srv.gate = (r) => { if (r.method === 'GET' && r.url.startsWith('/api/cfgfile?')) return new Promise((res) => { release = res; }); };
    P.srv.files.delete('x');
    await P.ctx.loadUiSkills();
    await flush();
    assert.ok(release, 'premise: the probe is held');
    const note = () => P.panel.find((k) => k.id === 'ubFileNote');
    assert.ok(!note().cls.has('hidden') && /entwurfBannerFehlt/.test(note().textContent), 'the list lost the skill and the builder said nothing until the probe came back');
    P.srv.gate = null; release(); await flush();
    assert.match(note().textContent, /entwurfBannerGeloescht/, 'the probe found the file gone — the more exact fact wins');
  });

  it('an orphan typed back to clean keeps its builder — there is no file to load it from', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'Entwurf');
    P.srv.files.delete('x');
    await P.ctx.loadUiSkills();
    await flush();
    assert.equal(P.ctx.UISKILL_SEL.orphan, true, 'premise: the orphan is selected');
    assert.equal(P.fileNote(), '⚠ views-uiskills.entwurfBannerGeloescht', 'premise: the probe found the file gone');
    typeInto(P.titleInput(), 'alt');     // back to what was loaded → the draft is clean
    assert.equal(P.ctx.builderDirty(), false, 'premise: clean again');
    // …and the note stops speaking of „your draft" at once — there is none; what is left is the last loaded state
    assert.equal(P.fileNote(), '⚠ views-uiskills.entwurfBannerGeloeschtSauber', 'the banner claims a draft that is gone');
    assert.ok(P.button('common.schliessen'), 'the way out is labelled „Entwurf verwerfen" with no draft to discard');
    P.reset();
    await click(P.tab('edit'));
    assert.ok(P.titleInput(), 'the pane went empty: the builder tried to load a file that is gone');
    assert.ok(!P.toasts.some(([, k]) => k === 'err'), 'a 404 toast for a file the builder already said is deleted');
    const note = P.panel.find((k) => k.id === 'ubFileNote');
    assert.ok(note && /entwurfBannerGeloescht/.test(note.textContent), 'the way back („Als neue Datei anlegen") is gone');
  });
});

describe('BUILDER-1 — the raw JSON view is part of the draft', () => {
  const openRaw = async () => {
    const P = await openBuilder();
    await click(P.panel.find((k) => k.tagName === 'BUTTON' && k.textContent === 'views-uiskills.rawImport'));
    const ta = P.panel.find((k) => k.cls.has('ub-raw'));
    assert.ok(ta, 'premise: the raw view is open');
    return { P, ta };
  };
  it('typed, not applied, tab switch and back: the raw text is still there', async () => {
    const { P, ta } = await openRaw();
    typeInto(ta, '{ "title": "halb getippt"');
    assert.equal(P.ctx.builderDirty(), true, 'unapplied raw text is not counted as unsaved');
    await click(P.tab('run'));
    await click(P.tab('edit'));
    const back = P.panel.find((k) => k.cls.has('ub-raw'));
    assert.ok(back, 'the raw view did not come back');
    assert.equal(back.value, '{ "title": "halb getippt"', 'the raw text was dropped by the tab switch');
  });
  it('„Zurück" asks before it throws unapplied text away', async () => {
    const { P, ta } = await openRaw();
    typeInto(ta, '{ "title": "anders" }');
    const back = () => P.panel.find((k) => k.tagName === 'BUTTON' && k.textContent === 'views-uiskills.zurueck');
    P.answers.confirm.push(false);
    await click(back());
    assert.equal(P.confirms.length, 1, '„Zurück" dropped the text without a word');
    assert.equal(P.confirms[0][1].okLabel, 'views-uiskills.textVerwerfen', 'the button says „Entwurf verwerfen" — and then throws away only the raw text');
    assert.ok(P.panel.find((k) => k.cls.has('ub-raw')), '„Abbrechen" must keep the raw view');
    P.answers.confirm.push(true);
    await click(back());
    assert.ok(P.titleInput(), 'confirmed, it goes back to the builder');
    assert.equal(P.ctx.builderDirty(), false);
  });
  it('a save refuses while raw text is pending — it would report „Gespeichert" without it', async () => {
    const { P, ta } = await openRaw();
    typeInto(ta, '{ "title": "anders" }');
    assert.equal(await P.ctx.persistBuilder(), false);
    assert.equal(P.srv.puts.length, 0);
    assert.ok(P.toasts.some(([m]) => m === 'views-uiskills.rohJsonOffen'));
  });
});

describe('BUILDER-1 — explicit ways out of a kept draft', () => {
  it('↻ (list reload) asks while a draft is open; „Abbrechen" keeps it, yes shows the file', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'Entwurf');
    P.answers.confirm.push(false);
    await P.ctx.uiSkillsReload();
    assert.equal(P.confirms.length, 1);
    assert.equal(P.count('load'), 0);
    assert.equal(P.ctx.BUILDER.manifest.title, 'Entwurf');
    P.answers.confirm.push(true);
    await P.ctx.uiSkillsReload();
    await flush();
    assert.equal(P.titleInput().value, 'alt');
    P.reset();                           // clean → no question
    await P.ctx.uiSkillsReload();
    assert.equal(P.confirms.length, 0);
    assert.equal(P.count('load'), 1);
    assert.match(noComments(UIS_SRC), /\$\('#uiskillsReload'\)\.onclick = uiSkillsReload;/, 'the ↻ button is wired past the question');
  });
  it('discarding an ORPHAN while the list cannot be read lands on the cockpit — not on a builder for a file that is gone', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'Entwurf');
    P.srv.files.delete('x');
    await P.ctx.loadUiSkills();
    await flush();
    assert.equal(P.ctx.UISKILL_SEL.orphan, true, 'premise: the orphan is selected');
    P.srv.gate = (r) => { if (r.url === '/api/uiskills') throw P.srv.fail(503, { error: 'restart' }); };
    P.answers.confirm.push(true);
    P.reset();
    const g0 = P.srv.gets.length;        // the probe already read x once; only what the discard does counts
    await click(P.panel.find((k) => k.id === 'ubDiscard'));
    assert.equal(P.ctx.UISKILL_SEL, null, 'the orphan stayed selected without its draft');
    assert.equal(P.count('cockpit'), 1, 'the panel did not fall back to the cockpit');
    assert.ok(!P.srv.gets.slice(g0).includes('x'), 'the builder went looking for the deleted file');
  });
  it('„Entwurf verwerfen" asks once, then shows the saved file', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'Entwurf');
    P.answers.confirm.push(false);
    await click(P.panel.find((k) => k.id === 'ubDiscard'));
    assert.equal(P.ctx.BUILDER.manifest.title, 'Entwurf');
    P.answers.confirm.push(true);
    await click(P.panel.find((k) => k.id === 'ubDiscard'));
    assert.equal(P.titleInput().value, 'alt');
    assert.equal(P.ctx.builderDirty(), false);
  });
});

// ============================================================================================================
// Abnahme (PR-15c) — what the adversarial review found, each case red against 3f0cf2c
// ============================================================================================================
describe('BUILDER-1 — a clean builder takes its manifest from the SAME answer as its hash', () => {
  // the list is read once; the file can be written after that by the CLI, an editor, a second window. The builder
  // that paired the GET's fresh hash with the list's old manifest told the server „I have seen the current state"
  // and wrote the old manifest back over it — If-Match went along, no 409, no question.
  const openOn = async (srv, tab) => {
    const W = makePanel(srv);
    await W.ctx.loadUiSkills();
    W.ctx.UISKILL_SEL = W.ctx.UISKILLS_DATA.find((s) => s.name === 'x'); W.ctx.UISKILL_TAB = tab;
    W.ctx.renderUiSkillPanel(); await flush();
    return W;
  };

  it('two windows: B saves x; A only goes Ausführen → Bearbeiten, edits another field and saves — B’s title stays', async () => {
    const srv = fakeServer({ x: skillMd(M0()) });
    const A = await openOn(srv, 'edit'), B = await openOn(srv, 'edit');
    typeInto(B.titleInput(), 'aus B');
    await click(B.button('common.speichern'));
    assert.equal(manifestOf(srv.files.get('x')).title, 'aus B', 'premise: B saved');
    await click(A.tab('run'));
    await click(A.tab('edit'));
    assert.equal(A.titleInput().value, 'aus B', 'A shows the manifest from before B’s save, next to the version of after it');
    typeInto(A.panel.find((k) => k.cls.has('ub-tpl')), '/x {{thema}} aus A');
    await click(A.button('common.speichern'));
    assert.equal(A.modals.length, 0, 'premise: nothing was in conflict — A had loaded B’s version');
    const after = manifestOf(srv.files.get('x'));
    assert.equal(after.title, 'aus B', 'A wrote the old title back over B’s save without a word');
    assert.equal(after.promptTemplate, '/x {{thema}} aus A');
  });

  it('…and the rest of A follows the file it read: the list entry, the head of the panel, the run tab', async () => {
    const srv = fakeServer({ x: skillMd(M0()) });
    const A = await openOn(srv, 'run');
    srv.files.set('x', skillMd(Object.assign(M0(), { title: 'von woanders' })));
    await click(A.tab('edit'));
    assert.equal(A.ctx.UISKILLS_DATA.find((s) => s.name === 'x').manifest.title, 'von woanders', 'the list entry still holds the old manifest');
    assert.equal(A.headTitle(), 'von woanders', 'the head shows the old title above a builder that shows the new one');
    A.reset();
    await click(A.tab('run'));
    assert.equal(A.rec.run[A.rec.run.length - 1][1].title, 'von woanders', 'the run tab shows the version from before');
  });

  it('written elsewhere after the list was read, BEFORE „Bearbeiten" is opened the first time: the save keeps it', async () => {
    const srv = fakeServer({ x: skillMd(M0()) });
    const P = await openOn(srv, 'run');
    srv.files.set('x', skillMd(Object.assign(M0(), { icon: 'EXTERN', promptTemplate: '/x {{thema}} EXTERN' })));
    await click(P.tab('edit'));
    typeInto(P.titleInput(), 'NEU');
    await click(P.button('common.speichern'));
    const after = manifestOf(srv.files.get('x'));
    assert.equal(after.icon, 'EXTERN', 'the icon written elsewhere is gone');
    assert.equal(after.promptTemplate, '/x {{thema}} EXTERN');
    assert.equal(after.title, 'NEU');
  });

  it('the file holds no valid ui-skill block any more: the builder says it shows the LIST’s version — and a save restores the block', async () => {
    const P = await openBuilder();
    await click(P.tab('run'));
    P.srv.files.set('x', '---\ndescription: d\n---\n\n# prosa neu\n\n```ui-skill\n{ kaputt\n```\n');
    await click(P.tab('edit'));
    assert.equal(P.fileNote(), '⚠ views-uiskills.entwurfBannerKeinBlock', 'the list’s manifest is shown as if it were the file’s');
    assert.equal(P.titleInput().value, 'alt');
    assert.equal(await P.ctx.persistBuilder(), true);
    assert.equal(manifestOf(P.srv.files.get('x')).title, 'alt');
    assert.match(P.srv.files.get('x'), /# prosa neu/, 'the prose of the file was replaced');
    assert.equal(P.fileNote(), '', 'the note outlived the save that put the block back');
    // a block that parses but is no object is no manifest either (the list's rule, lib/skills.js extractUiManifest)
    const Q = await openBuilder();
    await click(Q.tab('run'));
    Q.srv.files.set('x', '---\ndescription: d\n---\n\n```ui-skill\n"nur ein Text"\n```\n');
    await click(Q.tab('edit'));
    assert.equal(Q.fileNote(), '⚠ views-uiskills.entwurfBannerKeinBlock', 'a JSON string was taken for the manifest');
    assert.equal(Q.titleInput().value, 'alt');
  });
});

describe('BUILDER-1 — „Verwerfen" in the question, and then the caller stops', () => {
  const dirtyWith = async (files) => { const P = await openBuilder(Object.assign({ x: skillMd(M0()) }, files)); typeInto(P.titleInput(), 'Entwurf'); return P; };
  // what must hold on screen afterwards: no „● ungespeichert" without a draft, the form shows the file, „Speichern"
  // does something (a PUT) or says something (a toast)
  const screenFollows = async (P) => {
    assert.equal(P.ctx.builderDirty(), false, 'premise: the draft was discarded');
    assert.ok(P.hidden('ubDirty'), '„● ungespeichert" is still shown for a draft that is gone');
    assert.equal(P.titleInput().value, 'alt', 'the form still shows the discarded draft');
    P.reset();
    await click(P.button('common.speichern'));
    assert.ok(P.srv.puts.length > 0 || P.toasts.length > 0, '„Speichern" did nothing and said nothing');
  };

  it('„Neuer UI-Skill": the name is taken → „Verwerfen" → the overwrite declined', async () => {
    const P = await dirtyWith({ neu: skillMd(Object.assign(M0(), { title: 'N' })) });
    P.answers.prompt.push('neu'); P.answers.modal.push('discard'); P.answers.confirm.push(false);
    await P.ctx.uiskillCreateNew(); await flush();
    assert.equal(P.srv.puts.length, 0, 'premise: the caller stopped before its PUT');
    await screenFollows(P);
  });

  it('„Aus Skill erstellen": „Verwerfen" → the duplicate fails with a 500', async () => {
    const P = await dirtyWith({ z: '---\ndescription: z\n---\n\n# z\n' });
    P.srv.gate = (r) => { if (r.url === '/api/skill/duplicate') throw P.srv.fail(500, { error: 'EPERM' }); };
    P.answers.modal.push('discard');
    await P.ctx.convertToUiSkill('z', 'command'); await flush();
    P.srv.gate = null;
    await screenFollows(P);
  });

  it('an ORPHAN: „Verwerfen" and the caller stops → the cockpit, not a builder for a file that is gone', async () => {
    const P = await dirtyWith({ neu: skillMd(M0()) });
    P.srv.files.delete('x');
    await P.ctx.loadUiSkills(); await flush();
    assert.equal(P.ctx.UISKILL_SEL.orphan, true, 'premise: the orphan is selected');
    const g0 = P.srv.gets.length;
    P.answers.prompt.push('neu'); P.answers.modal.push('discard'); P.answers.confirm.push(false);
    await P.ctx.uiskillCreateNew(); await flush();
    assert.equal(P.ctx.UISKILL_SEL, null, 'the orphan stayed selected without its draft');
    assert.ok(P.count('cockpit') >= 1, 'the panel did not go back to the cockpit');
    assert.ok(!P.srv.gets.slice(g0).includes('x'), 'the builder went looking for the deleted file (404 toast, empty pane)');
  });

  it('„Speichern" with nothing loaded says so — a screen that outlived its draft does not stay silent', async () => {
    const P = await openBuilder();
    P.ctx.BUILDER = null;
    await click(P.button('common.speichern'));
    assert.equal(P.srv.puts.length, 0);
    assert.ok(P.toasts.some(([m, k]) => m === 'views-uiskills.nichtsZuSpeichern' && k === 'err'), 'nothing saved, nothing said');
  });

  it('„Speichern" in the question meets a 409 and „Neu laden" drops the draft: the switch goes on — no second click', async () => {
    const P = await openBuilder({ x: skillMd(M0()), y: skillMd(Object.assign(M0(), { title: 'Y' })) });
    typeInto(P.titleInput(), 'NEU');
    P.srv.files.set('x', skillMd(Object.assign(M0(), { title: 'von der CLI' })));
    P.answers.modal.push('save', 'reload');
    assert.equal(await P.ctx.openUiSkill(P.ctx.UISKILLS_DATA.find((s) => s.name === 'y')), true, 'the draft is gone, yet the switch was refused');
    assert.equal(P.ctx.UISKILL_SEL.name, 'y');
    assert.equal(manifestOf(P.srv.files.get('x')).title, 'von der CLI');
    // …while „Abbrechen" in the conflict dialog keeps both: the draft, and the skill it belongs to
    const Q = await openBuilder({ x: skillMd(M0()), y: skillMd(Object.assign(M0(), { title: 'Y' })) });
    typeInto(Q.titleInput(), 'NEU');
    Q.srv.files.set('x', skillMd(Object.assign(M0(), { title: 'von der CLI' })));
    Q.answers.modal.push('save', 'cancel');
    assert.equal(await Q.ctx.openUiSkill(Q.ctx.UISKILLS_DATA.find((s) => s.name === 'y')), false);
    assert.equal(Q.ctx.UISKILL_SEL.name, 'x');
    assert.equal(Q.ctx.BUILDER.manifest.title, 'NEU');
  });

  for (const [what, fn, deleted] of [['„Speichern & testen"', 'saveAndTest'], ['„Speichern"', 'saveBuilder'], ['„Als neue Datei anlegen"', 'builderCreateAgain', true]]) it('a switch to another skill while the PUT of ' + what + ' is out: the panel stays there, its run form is not reset', async () => {
    const P = await openBuilder({ x: skillMd(M0()), y: skillMd(Object.assign(M0(), { title: 'Y' })) });
    typeInto(P.titleInput(), 'NEU');
    if (deleted) P.srv.files.delete('x');   // „Als neue Datei anlegen" is the way back for a deleted file
    let release;
    P.srv.gate = (r) => { if (r.method === 'PUT') return new Promise((res) => { release = res; }); };
    const saving = P.ctx[fn]();
    await flush();
    P.answers.modal.push('discard');
    assert.equal(await P.ctx.openUiSkill(P.ctx.UISKILLS_DATA.find((s) => s.name === 'y')), true);
    await flush();
    P.ctx.RUN_SKILL = 'y';             // y's run form is in use
    P.reset();
    P.srv.gate = null; release();
    assert.equal(await saving, true, 'premise: the write worked');
    await flush();
    assert.equal(P.ctx.UISKILL_SEL.name, 'y');
    assert.equal(P.ctx.UISKILL_TAB, 'run');
    assert.equal(P.ctx.RUN_SKILL, 'y', 'the save of x reset the run form of y');
    assert.equal(P.count('load'), 0, 'the save of x re-rendered the panel of y');
  });
});

describe('BUILDER-1 — what the discard question and the file note say', () => {
  it('no saved file behind the draft (orphan, or a probe that found it gone): the question does not promise one', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'Entwurf');
    P.srv.files.delete('x');
    await P.ctx.loadUiSkills(); await flush();
    assert.equal(P.ctx.UISKILL_SEL.orphan, true, 'premise: the orphan');
    P.answers.confirm.push(false);
    await click(P.panel.find((k) => k.id === 'ubDiscard'));
    assert.equal(P.confirms[0][0], 'views-uiskills.entwurfVerwerfenFrageWeg', '„the builder then shows the file as it is saved" — there is none');
    const Q = await openBuilder();       // not an orphan: the list still has x, the probe found the file gone
    typeInto(Q.titleInput(), 'Entwurf');
    await click(Q.tab('run'));
    Q.srv.files.delete('x');
    await click(Q.tab('edit'));
    assert.ok(!Q.ctx.UISKILL_SEL.orphan, 'premise: not an orphan');
    Q.answers.confirm.push(false);
    await click(Q.panel.find((k) => k.id === 'ubFileNote').find((k) => k.tagName === 'BUTTON' && k.textContent === 'views-uiskills.entwurfVerwerfen'));
    assert.equal(Q.confirms[0][0], 'views-uiskills.entwurfVerwerfenFrageWeg');
    const R = await openBuilder();       // the file is there: the question may say the builder shows it
    typeInto(R.titleInput(), 'Entwurf');
    R.answers.confirm.push(false);
    await click(R.panel.find((k) => k.id === 'ubDiscard'));
    assert.equal(R.confirms[0][0], 'views-uiskills.entwurfVerwerfenFrage');
  });

  it('„Verwerfen" in the „Datei gelöscht" dialog drops the draft — and with no file left, the cockpit', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'Entwurf');
    P.srv.files.delete('x');
    P.answers.modal.push('discard');
    assert.equal(await P.ctx.saveBuilder(), false);
    await flush();
    assert.equal(P.modals[0].title, 'views-uiskills.entwurfGeloeschtTitel', 'premise: the deleted dialog');
    assert.equal(P.ctx.builderDirty(), false, '„Verwerfen" kept the draft');
    assert.equal(P.ctx.UISKILL_SEL, null);
  });

  it('a save the route cannot check (the entry is unreadable) says so in the panel’s words, writes nothing and keeps the draft', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'Entwurf');
    P.srv.unreadable.add('x');
    assert.equal(await P.ctx.saveBuilder(), false);
    assert.equal(P.modals.length, 0, 'an unreadable file is no „changed elsewhere" conflict');
    assert.ok(P.toasts.some(([m, k]) => m === 'views-uiskills.entwurfUnlesbar' && k === 'err'), 'the route’s English text was shown raw: ' + JSON.stringify(P.toasts));
    assert.equal(P.ctx.BUILDER.manifest.title, 'Entwurf');
  });

  it('„Löschen" whose list read fails lands on the cockpit — not on the builder of the skill it just deleted', async () => {
    const P = await openBuilder();
    P.srv.gate = (r) => { if (r.url === '/api/uiskills') throw P.srv.fail(503, { error: 'restart' }); };
    P.answers.confirm.push(true);
    await click(P.button('common.loeschen-2'));
    assert.equal(P.srv.files.has('x'), false, 'premise: deleted');
    assert.equal(P.ctx.UISKILL_SEL, null);
    assert.ok(P.count('cockpit') >= 1, 'the builder of the deleted skill stayed on screen');
  });

  it('openUiSkill with an OLDER object of a skill (a result card keeps the one from its run) selects the list’s entry', async () => {
    const P = await openBuilder();
    const stale = { name: 'x', manifest: Object.assign(M0(), { title: 'vom Laufstart' }) };
    assert.equal(await P.ctx.openUiSkill(stale), true);
    assert.equal(P.ctx.UISKILL_SEL, P.ctx.UISKILLS_DATA.find((s) => s.name === 'x'), 'the stale object became the selection');
    assert.equal(P.rec.run[P.rec.run.length - 1][1].title, 'alt');
  });
});

describe('BUILDER-1 — the quiet look at the file under a kept draft', () => {
  for (const [what, err] of [
    ['a 503 while the server restarts', (P) => P.srv.fail(503, { error: 'restart' })],
    ['a network error', () => new TypeError('Failed to fetch')],
    ['a 404 that is not „missing" (an unreadable entry)', null],
  ]) {
    it('a probe that learns nothing about the file claims nothing (' + what + ')', async () => {
      const P = await openBuilder();
      typeInto(P.titleInput(), 'Entwurf');
      await click(P.tab('run'));
      if (err) P.srv.gate = (r) => { if (r.method === 'GET' && r.url.startsWith('/api/cfgfile?')) throw err(P); };
      else P.srv.unreadable.add('x');
      await click(P.tab('edit'));
      assert.equal(P.fileNote(), '', 'the builder says something about a file it could not read');
      assert.ok(P.button('common.loeschen-2') && !P.hidden('ubDelete'), '„Löschen" was taken away on a guess');
    });
  }

  it('a probe that reads the file while the builder’s own PUT is out does not call that write „changed elsewhere"', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'Entwurf');
    await click(P.tab('run'));
    let release;
    // the write reaches the disk; its answer is held — the probe below reads what this very save wrote
    P.srv.after = (r) => { if (r.method === 'PUT') return new Promise((res) => { release = res; }); };
    const saving = P.ctx.persistBuilder();
    await flush();
    assert.ok(release, 'premise: the PUT has written and is held');
    await click(P.tab('edit'));
    assert.equal(P.fileNote(), '', 'the builder’s own write was announced as a change made elsewhere');
    P.srv.after = null; release();
    assert.equal(await saving, true);
  });

  it('a probe of an older render that answers last is dropped — it read the file before the newer one', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'Entwurf');
    await click(P.tab('run'));
    let release;
    P.srv.after = (r) => { if (r.url.startsWith('/api/cfgfile?')) { P.srv.after = null; return new Promise((res) => { release = res; }); } };
    await click(P.tab('edit'));          // probe 1 reads the unchanged file … and is held
    assert.ok(release, 'premise: probe 1 is held after its read');
    P.srv.files.set('x', skillMd(Object.assign(M0(), { title: 'von der CLI' })));
    await click(P.tab('run'));
    await click(P.tab('edit'));          // probe 2 reads the changed file and says so
    assert.equal(P.fileNote(), '⚠ views-uiskills.entwurfBannerGeaendert', 'premise: probe 2 found the change');
    release(); await flush();
    assert.equal(P.fileNote(), '⚠ views-uiskills.entwurfBannerGeaendert', 'the older probe took the warning back');
  });

  it('a stale GET that FAILS does not clear the newer builder’s screen or toast about it', async () => {
    const P = await openBuilder();
    const held = [];
    P.srv.gate = (r) => { if (r.method === 'GET' && r.url.startsWith('/api/cfgfile?')) return new Promise((res, rej) => held.push({ res, rej })); };
    const s = P.ctx.UISKILL_SEL;
    const hostA = new FakeEl('div'), hostB = new FakeEl('div');
    P.panel.appendChild(hostA); P.panel.appendChild(hostB);
    P.ctx.BUILDER = null;
    P.ctx.renderBuilderPanel(hostA, s);
    P.ctx.renderBuilderPanel(hostB, s);
    await flush();
    held[1].res(); await flush();
    held[0].rej(P.srv.fail(503, { error: 'restart' })); await flush();
    P.srv.gate = null;
    assert.ok(!P.toasts.some(([, k]) => k === 'err'), 'an error toast for a render nobody sees any more');
  });
});

describe('BUILDER-1 — the raw JSON view: applied is no longer pending', () => {
  it('„Übernehmen" (the real button): no longer pending, still a draft, and „Speichern" writes it', async () => {
    const P = await openBuilder();
    await click(P.button('views-uiskills.rawImport'));
    const ta = P.panel.find((k) => k.cls.has('ub-raw'));
    const o = JSON.parse(ta.value); o.title = 'aus Raw';
    typeInto(ta, JSON.stringify(o));
    await click(P.button('chat.uebernehmen'));
    assert.equal(P.ctx.builderRawPending(), false, 'the applied text still counts as pending — every save is refused');
    assert.ok(P.titleInput(), 'back in the builder');
    assert.equal(P.ctx.builderDirty(), true, 'an applied import is unsaved until it is saved');
    await click(P.button('common.speichern'));
    assert.equal(manifestOf(P.srv.files.get('x')).title, 'aus Raw', 'the import could not be saved: ' + JSON.stringify(P.toasts));
    assert.equal(P.ctx.builderDirty(), false);
  });

  it('the raw view of a draft shows „● ungespeichert" from its first paint', async () => {
    const P = await openBuilder();
    typeInto(P.titleInput(), 'Entwurf');
    await click(P.button('views-uiskills.rawImport'));
    assert.ok(P.panel.find((k) => k.cls.has('ub-raw')), 'premise: the raw view');
    assert.ok(!P.hidden('ubDirty'), 'the raw view hides that there is a draft until the first keystroke');
  });
});

// A handler inside the 800-line renderResultBlock cannot be loaded as a function — it is pinned as TEXT on the token a
// regression would remove (comments stripped first). The beforeunload listener CAN be run: it is cut out of the
// shipped boot.js as it stands and executed in its own context (a text pin stayed green with a typo in its typeof
// guard, which takes the warning away for good).
describe('BUILDER-1 — pinned wiring', () => {
  it('the schedule button keeps the prefill ORDER: set before the switch renders the run tab, dropped when refused', () => {
    const src = noComments(liftFn(UIS_SRC, 'renderResultBlock', 'views-uiskills.js'));
    const i = src.indexOf('schedBtn.onclick');
    assert.ok(i > 0, 'the schedule button moved — re-check this pin');
    const h = src.slice(i, i + 700);
    const set = h.indexOf('UISKILL_PREFILL = JSON.parse'), sw = h.indexOf('await openUiSkill(run.skill)');
    assert.ok(set >= 0 && sw > set, 'the prefill must be set BEFORE openUiSkill renders the run tab — renderRunPanel is the only place it is consumed');
    assert.match(h.slice(sw), /^await openUiSkill\(run\.skill\)\)\)\s*\{\s*UISKILL_PREFILL = null;\s*return;\s*\}/, 'a refused switch leaves the prefill lying for the next run tab of any skill');
  });
  it('the draft marker and the run-tab hint are TEXT, so they take --warning-text (plain --warning is 2,1:1 on light)', () => {
    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const sel of ['.uiskill-subtabs .ust-draft', '.ub-draft-note']) {
      const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(css);
      assert.ok(m, sel + ' moved — re-check this pin');
      assert.match(m[1], /(^|;)\s*color:\s*var\(--warning-text\)/, sel + ' writes its text in the colour that fails AA on the light theme');
    }
  });
  it('beforeunload, the shipped listener RUN: a builder draft warns, none does not, the restart reload never', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'boot.js'), 'utf8');
    const m = /^window\.addEventListener\('beforeunload'[\s\S]*?\n\}\);$/m.exec(src);
    assert.ok(m, 'the beforeunload listener moved — re-check this test');
    // env: what the other scripts would have defined (absent = the script is not loaded — the typeof guards)
    const warns = (env) => {
      let listener = null;
      const ctx = vm.createContext(Object.assign({ window: { addEventListener: (type, fn) => { if (type === 'beforeunload') listener = fn; } }, TABS: [] }, env));
      vm.runInContext(m[0], ctx, { filename: 'boot.js#beforeunload' });
      assert.ok(listener, 'the listener was not registered');
      const e = { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } };
      listener(e);
      return e.prevented;
    };
    assert.equal(warns({ builderDirty: () => true }), true, 'a reload throws the builder draft away without a warning');
    assert.equal(warns({ builderDirty: () => false }), false, 'a clean builder warns');
    assert.equal(warns({}), false, 'without views-uiskills.js loaded it must neither throw nor warn');
    assert.equal(warns({ builderDirty: () => true, RELOAD_FOR_RESTART: true }), false, 'the panel’s own reload after a restart is held up');
    assert.equal(warns({ memDirty: () => true, builderDirty: () => false }), true, 'the memory draft lost its warning next to it');
    assert.equal(warns({ TABS: [{ streaming: true }] }), true, 'a running turn lost its warning next to it');
  });
});

describe('BUILDER-1 — the restart reload names the drafts it will drop (it skips beforeunload)', () => {
  const SYS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views-system.js'), 'utf8');
  const load = (env) => {
    const ctx = vm.createContext(Object.assign({ t: (k) => k }, env));
    vm.runInContext(liftFn(SYS_SRC, 'restartDraftNote', 'views-system.js'), ctx);
    return ctx.restartDraftNote;
  };
  it('nothing open → nothing added; open drafts → named', () => {
    assert.equal(load({ memDirty: () => false, builderDirty: () => false })(), '');
    assert.equal(load({})(), '', 'the views may be absent (typeof guards)');
    const k = load({ memDirty: () => true, MEM: { name: 'fakt.md' }, builderDirty: () => true, BUILDER: { name: 'x' }, t: (key) => (key === 'views-system.neustartEntwurf' ? '{list}' : key) })();
    assert.equal(k.trim(), 'fakt.md, /x');
  });
  it('both confirmations in front of a restart carry it', () => {
    const src = noComments(SYS_SRC);
    assert.match(src, /uiConfirm\(t\('views-system\.serverNeuStartenLaufende'\) \+ restartDraftNote\(\)/, 'the restart confirmation does not name the drafts');
    assert.match(src, /uiConfirm\(t\('views-system\.updateFrage'\) \+ restartDraftNote\(\)/, 'the update confirmation (it restarts too) does not name the drafts');
  });
});
