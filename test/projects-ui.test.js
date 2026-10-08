'use strict';
// P-1 Teil 2 — public/js/projects.js, the browser half of „Projekte" (Stufe 1). What is pinned here:
//   · the WIRING: nav button directly under „Sitzungen", its own section, the loaders in render.js (click and
//     language switch), the palette group „Neuer Chat: <Projekt>" — each run, not just grepped, where it can be
//   · newChatInProject: the start values land on the tab as COPIES, before activateTab and with cfgTouched (else the
//     selectors show the global defaults and the start reads those), the MCP names are reconciled against the
//     configuration first (one gone → said and dropped; all gone → ASKED, never a silent start with zero servers),
//     and nothing starts and nothing sends a projectId (Stufe 2)
//   · the editor's draft lives in PROJ_DRAFT and survives a redraw and a language switch — run against a small
//     fake DOM, the whole real projects.js loaded into a vm context (no copy of any function)
//   · every error/warning token of projects-core has a label in both languages
// The whole file is loaded the way the browser loads it (one classic script in a shared global scope), so a
// top-level name that another script also declares is caught here before it takes the panel down.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public', 'js');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, '');
const SRC = read('public/js/projects.js');
const CORE = read('public/js/projects-core.js');
const RENDER = read('public/js/render.js');
const COMMANDS = read('public/js/commands.js');
const INDEX = read('public/index.html');
const I18N = new Function(read('public/js/i18n.js') + '; return I18N;')();
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*$/gm, '');
const plain = (x) => JSON.parse(JSON.stringify(x));
const tick = () => new Promise((r) => setImmediate(r));

function liftFn(src, name, rel) {
  const one = new RegExp('^(?:async )?function ' + name + '\\(.*\\}[ \\t]*$', 'm');
  const multi = new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm');
  const m = one.exec(src) || multi.exec(src);
  assert.ok(m, name + '() not found in ' + rel + ' — renamed or reindented? Then these tests prove nothing.');
  return m[0];
}

// ---------------------------------------------------------------------------------------------------------------
// A small fake DOM — just what projects.js touches. Selectors: compound simple selectors (tag, #id, .class,
// [attr], [attr="v"]) joined by descendant spaces; data-* attributes are the element's dataset, as in a browser.
// ---------------------------------------------------------------------------------------------------------------
function makeDom() {
  const doc = { activeElement: null };
  class ClassList {
    constructor(e) { this.e = e; }
    get list() { return this.e._cls; }
    add(...c) { c.forEach((x) => { if (!this.list.includes(x)) this.list.push(x); }); }
    remove(...c) { this.e._cls = this.list.filter((x) => !c.includes(x)); }
    toggle(c, on) { const want = on === undefined ? !this.contains(c) : !!on; if (want) this.add(c); else this.remove(c); return want; }
    contains(c) { return this.list.includes(c); }
  }
  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this._cls = []; this._text = '';
      this.attrs = {}; this.dataset = {}; this.style = { setProperty: (k, v) => { this.style[k] = v; }, getPropertyValue: (k) => this.style[k] || '' };
      this.classList = new ClassList(this); this.scrollTop = 0; this.value = ''; this.options = [];
    }
    get className() { return this._cls.join(' '); }
    set className(v) { this._cls = String(v || '').split(/\s+/).filter(Boolean); }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; this._text = v == null ? '' : String(v); }
    set innerHTML(v) { this.textContent = ''; this._html = String(v); }
    get innerHTML() { return this._html || ''; }
    get childElementCount() { return this.children.length; }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === doc.body; }
    appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.push(c); if (c.tagName === 'OPTION' && this.tagName === 'SELECT') this.options.push(c); return c; }
    insertBefore(c, ref) { if (c.parentNode) c.remove(); c.parentNode = this; const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
    remove() { if (!this.parentNode) return; const p = this.parentNode; p.children = p.children.filter((x) => x !== this); p.options = p.options.filter((x) => x !== this); this.parentNode = null; }
    replaceWith(n) { const p = this.parentNode; if (!p) return; const i = p.children.indexOf(this); this.remove(); n.parentNode = p; p.children.splice(i, 0, n); }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    setAttribute(k, v) { if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = String(v); else this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
    getAttribute(k) { if (k.startsWith('data-')) { const v = this.dataset[camel(k.slice(5))]; return v === undefined ? null : v; } return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    focus() { doc.activeElement = this; }
    setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; }
    matchesSimple(sel) {
      const re = /([#.]?[\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
      let m, any = false;
      while ((m = re.exec(sel))) {
        any = true;
        if (m[1]) {
          const t = m[1];
          if (t[0] === '#') { if (this.id !== t.slice(1)) return false; }
          else if (t[0] === '.') { if (!this._cls.includes(t.slice(1))) return false; }
          else if (this.tagName !== t.toUpperCase()) return false;
        } else {
          const v = this.getAttribute(m[2]);
          if (v === null || v === undefined) return false;
          if (m[3] !== undefined && v !== m[3]) return false;
        }
      }
      return any;
    }
    matches(sel) {
      const parts = sel.trim().split(/\s+/);
      if (!this.matchesSimple(parts[parts.length - 1])) return false;
      let i = parts.length - 2, n = this.parentNode;
      while (i >= 0 && n) { if (n.matchesSimple && n.matchesSimple(parts[i])) i--; n = n.parentNode; }
      return i < 0;
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => n.children.forEach((c) => { if (sel.split(',').some((s) => c.matches(s))) out.push(c); walk(c); });
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }
  doc.createElement = (tag) => new El(tag);
  doc.createTextNode = (s) => { const n = new El('#text'); n._text = String(s); return n; };
  doc.body = new El('body');
  doc.contains = (n) => doc.body.contains(n);
  const el = (tag, cls, txt) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  return { doc, el, El };
}

// The whole real projects.js (and projects-core.js) in one vm context, with stubs for its neighbours.
function loadProjects(over) {
  const dom = makeDom();
  const calls = { api: [], toast: [], uiModal: [], overlayPush: [], released: 0, activated: [], made: 0, startChat: 0, renderTabs: 0, showView: [] };
  const lang = { v: 'de' };
  const nodes = { '#projBody': dom.el('div', 'proj-body'), '#projCount': dom.el('span'), '#composerInput': dom.el('textarea'), '#view-projects': dom.el('section', 'view active') };
  dom.doc.body.appendChild(nodes['#projBody']);
  const listeners = {};
  // localStorage as a browser has it: cc_proj_folds (P1) remembers which sections are open; over.folds presets it
  const store = new Map(over && over.folds ? [['cc_proj_folds', JSON.stringify(over.folds)]] : []);
  const env = Object.assign({
    document: dom.doc,
    setTimeout: (fn, ms) => setTimeout(fn, ms), // the vm context has no timers of its own
    clearTimeout: (h) => clearTimeout(h),
    window: { addEventListener: (k, fn) => { (listeners[k] = listeners[k] || []).push(fn); } },
    $: (s) => (Object.prototype.hasOwnProperty.call(nodes, s) ? nodes[s] : null),
    el: dom.el,
    t: (k) => lang.v + ':' + k,
    fmtInt: (n) => String(n),
    relTime: () => 'gerade',
    ic: () => '<svg/>',
    iconBtn: (cls, icon, o) => { const b = dom.el('button', cls); if (o && o.label) b.textContent = o.label; if (o && o.title) b.title = o.title; if (o && o.onClick) b.onclick = o.onClick; return b; },
    mkClickable: (e) => e,
    errorCard: (c, msg) => { c.textContent = 'ERR ' + msg; },
    emptyFiltered: () => {},
    debounce: (fn) => fn,
    shortModel: (m) => m,
    toast: (m, k) => calls.toast.push([m, k]),
    api: async (p, o) => {
      calls.api.push([p, o && o.body ? JSON.parse(o.body) : null]);
      const h = (over && over.api && over.api(p, o)) || null;
      if (h) return h instanceof Error ? Promise.reject(h) : h;
      if (p === '/api/mcp/configured') return { servers: [{ name: 'jira' }, { name: 'sap-adt' }] };
      if (p.startsWith('/api/cfgfiles')) return { files: [{ name: 'reviewer' }] };
      if (p === '/api/projects') return { projects: [] };
      if (p === '/api/sessions') return { sessions: [] };
      return {};
    },
    overlayPush: (node, opts) => { calls.overlayPush.push({ node, opts }); return () => { calls.released++; }; },
    uiModal: async (o) => { calls.uiModal.push(o); return over && over.modal ? over.modal(o) : 'cancel'; },
    uiConfirm: async () => true,
    TAB_HUES: [265, 200, 150],
    STATE: { defaultCwd: 'C:\\WINDOWS\\system32', home: 'C:\\Users\\x' },
    CHAT_DEFAULTS: { model: 'sonnet', effort: 'medium', permMode: 'plan' },
    MODELS_CACHE: { models: [{ value: 'opus[1m]' }, { value: 'blocked-1', blocked: true }] },
    TABS: [],
    ACTIVE: null,
    makeTab: () => { calls.made++; const tb = { uid: calls.made, title: 'Neuer Chat', modelSel: '', effort: '', permissionMode: '', hue: 200 }; env.TABS.push(tb); return tb; },
    // a snapshot of what activateTab gets to SEE: that is what the selectors show, and the start reads them
    activateTab: (tb) => calls.activated.push(plain(tb)),
    tabUntouched: () => false,
    renderTabs: () => { calls.renderTabs++; },
    showView: (v) => calls.showView.push(v),
    startChat: () => { calls.startChat++; },
    isDefaultTitle: (tb) => tb.defaultTitle !== false,
    persistTabs: () => {},
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } },
  }, (over && over.env) || {});
  const ctx = vm.createContext(env);
  vm.runInContext(CORE, ctx, { filename: 'projects-core.js' });
  vm.runInContext(SRC, ctx, { filename: 'projects.js' });
  // over.lift: [[source, name, file]] — the REAL neighbour, sliced out of its file and run in this context, in
  // place of the stub (render.js iconBtn, chat.js tabUntouched): a stub that agrees with the code under test proves
  // nothing about the seam
  for (const [src, name, rel] of (over && over.lift) || []) vm.runInContext(liftFn(src, name, rel), ctx, { filename: rel });
  const ev = (code) => vm.runInContext(code, ctx);
  return { ctx, ev, calls, dom, nodes, lang, listeners, env, store };
}
const CHAT = read('public/js/chat.js');
const REAL_ICONBTN = [[RENDER, 'labelSpan', 'render.js'], [RENDER, 'iconBtn', 'render.js']];
const REAL_UNTOUCHED = [[CHAT, 'tabCwdIsMain', 'chat.js'], [CHAT, 'tabUntouched', 'chat.js']];

// ===============================================================================================================
describe('P-1 wiring — the view is reachable like every other view', () => {
  it('nav: a button for "projects" DIRECTLY under „Sitzungen", labelled html.projekte, with the briefcase icon', () => {
    const views = [...INDEX.matchAll(/<button class="nav-item[^"]*" data-view="(\w+)"/g)].map((m) => m[1]);
    assert.equal(views[views.indexOf('sessions') + 1], 'projects', 'nav order: ' + views.join(', '));
    const btn = /<button class="nav-item" data-view="projects"[\s\S]*?<\/button>/.exec(INDEX)[0];
    assert.match(btn, /data-i18n="html\.projekte"/);
    const icon = /project: '([^']+)'/.exec(RENDER);
    assert.ok(icon, 'ICONS.project is missing from render.js (the empty state draws it)');
    // ICONS.project is single-quoted in render.js, so its SVG already carries plain `"` — compared as it stands
    // (a `.replace(/"/g, '"')` stood here and replaced the quote with itself: CodeQL js/identity-replacement on #97)
    assert.ok(btn.includes(icon[1]), 'the nav SVG and ICONS.project drew different shapes');
  });
  it('the section: its own view with a topbar (the 🔔 mounts into .topbar-actions) and the body the loader fills', () => {
    const sec = /<section class="view" id="view-projects">[\s\S]*?<\/section>/.exec(INDEX);
    assert.ok(sec, 'no <section id="view-projects">');
    for (const id of ['projCount', 'projSearch', 'projNew', 'projFromTab', 'projReload', 'projBody']) assert.ok(sec[0].includes('id="' + id + '"'), id + ' missing');
    assert.match(sec[0], /class="topbar-actions"/);
  });
  it('scripts: projects-core before render.js, projects.js after sessions.js (resumeSession) and before commands.js', () => {
    const at = (f) => INDEX.indexOf('/js/' + f + '"');
    assert.ok(at('projects.js') > 0, 'no <script> for projects.js');
    assert.ok(at('projects-core.js') < at('render.js'));
    assert.ok(at('sessions.js') < at('projects.js') && at('projects.js') < at('commands.js') && at('projects.js') < at('boot.js'));
  });
  it('render.js: a click on the nav item loads the view', () => {
    const block = /\$\$\('\.nav-item'\)\.forEach\(\(btn\) => \{[\s\S]*?\n\}\);/.exec(RENDER);
    assert.ok(block, 'the nav click dispatch moved');
    assert.match(noComments(block[0]), /if \(v === 'projects'\) loadProjects\(\);/);
  });
  it('render.js: a language switch re-renders it (reloadActiveView, run — not grepped)', () => {
    const called = [];
    const fn = new Function('document', 'window', liftFn(RENDER, 'reloadActiveView', 'render.js') + '\nreturn reloadActiveView;')(
      { querySelector: () => ({ dataset: { view: 'projects' } }) },
      { loadProjects: () => called.push('loadProjects'), loadSessions: () => called.push('loadSessions') });
    fn();
    assert.deepEqual(called, ['loadProjects']);
  });
  it('palette: „Gehe zu: Projekte" comes from PALETTE_VIEWS with the nav label key', () => {
    const { PALETTE_VIEWS } = require('../public/js/palette');
    assert.deepEqual(PALETTE_VIEWS.find(([v]) => v === 'projects'), ['projects', 'html.projekte']);
  });
  it('palette: „Neuer Chat: <Projekt>" per active project, the name untouched (src data), archived ones left out', () => {
    const m = /^function cmdkCommands\(\)[\s\S]*?^\}/m.exec(COMMANDS)[0];
    const ran = [];
    const env = {
      t: (k) => '«' + k + '»', $: () => ({ value: '', onclick: () => {} }), showView: () => {}, openGlobalSearch: () => {}, openModelCompare: () => {},
      openUiSkill: () => {}, insertSnippet: () => {}, savePromptFromComposer: () => {}, openPromptManager: () => {}, openPromptHistory: () => {},
      composerSet: () => {}, resumeSession: () => {}, isFav: () => false, PALETTE_VIEWS: [], UISKILLS_DATA: [], sortedPrompts: () => [],
      SNIPPETS: () => [], allChatCommands: () => [], SESSIONS: [],
      PROJECTS_DATA: [{ id: 'p-00000001', name: 'Einstellungen', archived: false }, { id: 'p-00000002', name: 'Alt', archived: true }],
      newChatInProject: (p) => ran.push(p.id),
    };
    const build = new Function(...Object.keys(env), m + '\nreturn cmdkCommands;')(...Object.values(env));
    const mine = build().filter((c) => c.group === '«projects.paletteGruppe»');
    assert.equal(mine.length, 1, 'the archived project is in the palette, or the active one is missing');
    assert.equal(mine[0].src, 'data');
    assert.equal(mine[0].label, '«projects.paletteNeuerChat»Einstellungen', 'a project name is the user\'s word — never translated');
    mine[0].run();
    assert.deepEqual(ran, ['p-00000001']);
    // and without the global (a test harness, an older load order) the builder does not throw
    const env2 = Object.assign({}, env); delete env2.PROJECTS_DATA;
    assert.doesNotThrow(() => new Function(...Object.keys(env2), m + '\nreturn cmdkCommands;')(...Object.values(env2))());
  });
  it('palette: opening it loads the projects on demand (the view need not have been visited)', () => {
    const body = noComments(liftFn(COMMANDS, 'openCmdk', 'commands.js'));
    assert.match(body, /typeof ensureProjects === 'function'[\s\S]*ensureProjects\(\)\.then/);
  });
  it('projects.js declares no top-level name another script declares (one shared global scope)', () => {
    const top = (s) => [...s.matchAll(/^(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:var|let|const)\s+([A-Za-z_$][\w$]*))/gm)].map((x) => x[1] || x[2]);
    const mine = new Set(top(SRC));
    assert.ok(mine.size > 40, 'the scan found ' + mine.size);
    const clash = [];
    for (const f of fs.readdirSync(PUB).filter((x) => x.endsWith('.js') && x !== 'projects.js')) {
      for (const n of top(fs.readFileSync(path.join(PUB, f), 'utf8'))) if (mine.has(n)) clash.push(f + ': ' + n);
    }
    assert.deepEqual(clash, []);
  });
  it('the whole file loads as a classic script next to projects-core (no ReferenceError at load)', () => {
    const w = loadProjects();
    assert.equal(w.ev('typeof newChatInProject'), 'function');
    assert.equal(w.ev('PROJECTS_DATA'), null);
    assert.ok(w.listeners.beforeunload && w.listeners.beforeunload.length === 1, 'no beforeunload guard for an open draft');
  });
});

describe('P-1 labels — every token projects-core can produce has a word, in both languages', () => {
  const w = loadProjects();
  const PC = require('../public/js/projects-core');
  const keysOf = (name) => plain(w.ev(name));
  it('errors', () => {
    const map = keysOf('PROJ_ERR_KEYS');
    assert.deepEqual(Object.keys(map).sort(), PC.PROJECT_ERROR_CODES.slice().sort());
    for (const k of Object.values(map)) { assert.ok(I18N.de[k], k + ' (de)'); assert.ok(I18N.en[k], k + ' (en)'); }
  });
  it('warnings', () => {
    const map = keysOf('PROJ_WARN_KEYS');
    assert.deepEqual(Object.keys(map).sort(), PC.PROJECT_WARNING_CODES.slice().sort());
    for (const k of Object.values(map)) { assert.ok(I18N.de[k], k + ' (de)'); assert.ok(I18N.en[k], k + ' (en)'); }
  });
  it('fields — every editable field plus the two the route names (projects cap, id)', () => {
    const map = keysOf('PROJ_FIELD_KEYS');
    for (const f of PC.PROJECT_FIELDS.concat(['projects', 'id'])) assert.ok(map[f], 'no label for field ' + f);
    for (const k of Object.values(map)) { assert.ok(I18N.de[k], k + ' (de)'); assert.ok(I18N.en[k], k + ' (en)'); }
  });
  it('modes and efforts: exactly the storable ones, in the selectors\' own wording — bypass has none', () => {
    assert.deepEqual(Object.keys(keysOf('PROJ_MODE_KEYS')).sort(), PC.PROJECT_PERM_MODES.slice().sort());
    assert.deepEqual(Object.keys(keysOf('PROJ_EFFORT_KEYS')).sort(), PC.PROJECT_EFFORTS.slice().sort());
    for (const k of Object.values(keysOf('PROJ_MODE_KEYS')).concat(Object.values(keysOf('PROJ_EFFORT_KEYS')))) {
      assert.ok(INDEX.includes('data-i18n="' + k + '"'), k + ' is not the label of a selector option in index.html');
    }
  });
  it('a warning names its value; a mode is named by its label, not its id', () => {
    const txt = w.ev('projWarningText({ code: "mcp-unknown", field: "mcpServers", value: ["a", "b"] })');
    assert.equal(txt, 'de:projects.warnMcpUnknown');
    // the value goes into the {value} slot — with the real dictionary:
    const real = loadProjects({ env: { t: (k) => I18N.de[k] || k } });
    assert.match(real.ev('projWarningText({ code: "mcp-unknown", field: "mcpServers", value: ["a", "b"] })'), /a, b/);
    assert.match(real.ev('projWarningText({ code: "perm-noask", field: "permissionMode", value: "dontAsk" })'), /Ohne Rückfragen/);
    assert.match(real.ev('projErrorText({ field: "instructions", code: "too-long", max: 2000 })'), /^Anweisungen: zu lang — höchstens 2000 Zeichen$/);
  });
});

// ===============================================================================================================
const PROJECT = () => ({
  id: 'p-0000abcd', name: 'Demoprojekt', hue: 150, cwd: '', addDirs: ['C:\\Users\\x\\repo'], mcpServers: ['jira'],
  model: 'opus[1m]', effort: 'high', permissionMode: 'acceptEdits', agent: 'reviewer', instructions: 'T01 ist Test', warnings: [],
});
async function newChat(w, p) { const r = await w.ctx.newChatInProject(p); await tick(); return r; }

describe('newChatInProject — the start values as a VISIBLE copy in the tab', () => {
  it('every start value is on the tab BEFORE activateTab, with cfgTouched — and the tab knows its project', async () => {
    const w = loadProjects();
    const p = PROJECT();
    const tab = await newChat(w, p);
    assert.ok(tab, 'no tab opened');
    assert.equal(w.calls.activated.length, 1);
    const seen = w.calls.activated[0];
    assert.deepEqual({ cfgTouched: seen.cfgTouched, modelSel: seen.modelSel, effort: seen.effort, permissionMode: seen.permissionMode },
      { cfgTouched: true, modelSel: 'opus[1m]', effort: 'high', permissionMode: 'acceptEdits' }, 'activateTab saw the defaults — the selectors would show those');
    assert.deepEqual(seen.addDirs, ['C:\\Users\\x\\repo']);
    assert.deepEqual(seen.mcpServers, ['jira']);
    assert.equal(seen.agent, 'reviewer');
    assert.equal(seen.hue, 150); assert.equal(seen.hueManual, true);
    assert.equal(seen.projectId, 'p-0000abcd');
    assert.equal('cwd' in seen, false, 'an empty project cwd must leave the tab on the main folder');
    assert.deepEqual(w.calls.showView, ['chat']);
    assert.equal(w.calls.startChat, 0, 'a start happens with the first message, never here');
  });
  it('copies, never shares: an edit in the tab does not edit the project', async () => {
    const w = loadProjects();
    const p = PROJECT();
    const tab = await newChat(w, p);
    tab.addDirs.push('C:\\other'); tab.mcpServers.length = 0;
    assert.deepEqual(p.addDirs, ['C:\\Users\\x\\repo']);
    assert.deepEqual(p.mcpServers, ['jira']);
  });
  it('a value the project leaves open is the tab\'s own default (CHAT_DEFAULTS) — MCP null asks nothing and scopes nothing', async () => {
    const w = loadProjects();
    const tab = await newChat(w, { id: 'p-00000001', name: 'Leer', mcpServers: null, warnings: [] });
    assert.equal(tab.modelSel, 'sonnet'); assert.equal(tab.effort, 'medium'); assert.equal(tab.permissionMode, 'plan');
    assert.equal(tab.mcpServers, undefined, 'null = all servers: the fresh session\'s default, nothing to send');
    assert.equal(w.calls.api.filter(([p]) => p === '/api/mcp/configured').length, 0, 'no MCP lookup for a project without names');
    assert.equal(tab.agent, undefined); assert.equal(tab.addDirs, undefined);
  });
  it('a bypass mode in a hand-edited projects.json never reaches the tab', async () => {
    const w = loadProjects();
    const tab = await newChat(w, Object.assign(PROJECT(), { permissionMode: 'bypassPermissions' }));
    assert.equal(tab.permissionMode, 'plan', 'the tab must fall back to the chat default, not take bypass from a file');
  });
  it('MCP: a name that is no longer configured is dropped AND said', async () => {
    const w = loadProjects();
    const tab = await newChat(w, Object.assign(PROJECT(), { mcpServers: ['jira', 'gone'] }));
    assert.deepEqual(plain(tab.mcpServers), ['jira']);
    const warn = w.calls.toast.find(([m, k]) => k === 'warn' && /mcpEntfernt/.test(m));
    assert.ok(warn, 'the dropped name was not said: ' + JSON.stringify(w.calls.toast));
  });
  it('MCP: none left although the project named some → ASKED; Abbrechen opens nothing, the two answers mean none / all', async () => {
    for (const [answer, expect] of [['cancel', 'nothing'], [undefined, 'nothing'], ['none', []], ['all', undefined]]) {
      const w = loadProjects({ modal: () => answer });
      const r = await newChat(w, Object.assign(PROJECT(), { mcpServers: ['gone'] }));
      assert.equal(w.calls.uiModal.length, 1, 'no question for an emptied MCP list (answer ' + answer + ')');
      assert.equal(w.calls.uiModal[0].escValue, 'cancel', 'Esc must mean „do not open"');
      if (expect === 'nothing') { assert.equal(r, null); assert.equal(w.calls.made, 0); assert.equal(w.calls.activated.length, 0); continue; }
      assert.deepEqual(plain(r.mcpServers === undefined ? null : r.mcpServers), expect === undefined ? null : expect, 'answer ' + answer);
    }
  });
  it('MCP: the configuration cannot be read → the names are copied unchecked, and that is said', async () => {
    const w = loadProjects({ api: (p) => (p === '/api/mcp/configured' ? new Error('ECONNRESET') : null) });
    const tab = await newChat(w, Object.assign(PROJECT(), { mcpServers: ['jira', 'maybe'] }));
    assert.deepEqual(plain(tab.mcpServers), ['jira', 'maybe']);
    assert.ok(w.calls.toast.some(([m, k]) => k === 'warn' && /mcpUngeprueft/.test(m)));
  });
  it('a model the IAM policy blocks yields to the chat default, with a word', async () => {
    const w = loadProjects();
    const tab = await newChat(w, Object.assign(PROJECT(), { model: 'blocked-1' }));
    assert.equal(tab.modelSel, 'sonnet');
    assert.ok(w.calls.toast.some(([m, k]) => k === 'warn' && /modellGesperrt/.test(m)));
  });
  it('an UNTOUCHED active tab is used (no second empty tab); a touched one never is', async () => {
    const reuse = loadProjects({ env: { tabUntouched: () => true } });
    const act = { uid: 99, title: 'Neuer Chat', modelSel: '', effort: '', permissionMode: '', hue: 200 };
    reuse.ctx.ACTIVE = act;
    const t1 = await newChat(reuse, PROJECT());
    assert.equal(t1, act); assert.equal(reuse.calls.made, 0);
    assert.equal(reuse.calls.renderTabs, 1, 're-activating the active tab does not repaint the tab bar by itself');
    const fresh = loadProjects({ env: { tabUntouched: () => false } });
    fresh.ctx.ACTIVE = act;
    const t2 = await newChat(fresh, PROJECT());
    assert.notEqual(t2, act); assert.equal(fresh.calls.made, 1);
  });
  it('Stufe 2: the route resolves projects, and the start body names one only on a fresh start', () => {
    assert.ok(noComments(read('public/js/chat-events.js')).includes("if (!extra.resume && typeof tab.projectId === 'string') body.projectId = tab.projectId;"), 'the start body does not send projectId on a fresh start');
    for (const fn of ['resolveStart', 'recordFreshStart', 'sessionIdHook']) assert.ok(read('server.js').includes('projectsLib.' + fn + '('),'the start route lost ' + fn);
  });
});

// ===============================================================================================================
async function openEditor(w, p, opts) {
  w.ctx.openProjectEditor(p || null, opts);
  for (let i = 0; i < 5; i++) await tick();
  const d = w.ev('PROJ_DRAFT');
  assert.ok(d, 'the editor did not open');
  return d;
}
const q = (d, sel) => d.box.querySelector(sel);
function type(d, sel, value) { const i = q(d, sel); assert.ok(i, sel + ' not in the form'); i.value = value; i.oninput(); return i; }

describe('the editor — a dialog on the overlay stack whose draft survives every redraw', () => {
  it('registers with the stack: Esc and Enter are its own, no trap autofocus, no click-outside close', async () => {
    const w = loadProjects();
    const d = await openEditor(w);
    assert.equal(w.calls.overlayPush.length, 1);
    const { node, opts } = w.calls.overlayPush[0];
    assert.ok(node.classList.contains('proj-editor-overlay') && node.classList.contains('modal-overlay'));
    assert.equal(node.getAttribute('aria-modal'), 'true');
    assert.equal(typeof opts.onEsc, 'function'); assert.equal(typeof opts.onEnter, 'function');
    assert.equal(node.onclick, undefined, 'a click next to the dialog must not throw a draft away');
    assert.equal(d.mcpConfigured.join(','), 'jira,sap-adt', 'the MCP list never arrived');
    assert.ok(q(d, '[data-pk="mcp"][data-idx="jira"]'), 'no MCP checklist');
  });
  it('typed values survive a REDRAW and a LANGUAGE SWITCH — same draft object, new labels, caret back in place', async () => {
    const w = loadProjects();
    const d = await openEditor(w);
    type(d, '[data-pk="name"]', 'Demoprojekt');
    type(d, '[data-pk="instructions"]', 'T01 ist Test');
    q(d, '[data-pk="addDirs-add"]').onclick();
    type(d, '[data-pk="addDirs"][data-idx="0"]', 'C:\\Users\\x\\repo');
    const sap = q(d, '[data-pk="mcp"][data-idx="sap-adt"]'); sap.checked = false; sap.onchange();
    const nameBefore = q(d, '[data-pk="name"]');
    nameBefore.focus(); nameBefore.selectionStart = 4; nameBefore.selectionEnd = 4;
    const before = JSON.stringify(w.ctx.projDraftBody(d));
    // the language switch: render.js reloadActiveView → loadProjects()
    w.lang.v = 'en';
    await w.ctx.loadProjects();
    await tick();
    assert.equal(w.ev('PROJ_DRAFT'), d, 'the draft object was replaced');
    assert.equal(JSON.stringify(w.ctx.projDraftBody(d)), before, 'a value changed across the switch');
    const nameAfter = q(d, '[data-pk="name"]');
    assert.notEqual(nameAfter, nameBefore, 'the form was not redrawn — then the labels stayed in the old language');
    assert.equal(nameAfter.value, 'Demoprojekt');
    assert.equal(q(d, '[data-pk="addDirs"][data-idx="0"]').value, 'C:\\Users\\x\\repo');
    assert.equal(q(d, '[data-pk="mcp"][data-idx="sap-adt"]').checked, false);
    assert.equal(q(d, '#projEdTitle').textContent, 'en:projects.editorNeu', 'the title did not follow the language');
    assert.equal(w.dom.doc.activeElement, nameAfter, 'the caret was lost in the redraw');
    assert.equal(nameAfter.selectionStart, 4);
    assert.equal(w.ctx.projDirty(), true);
    assert.deepEqual(plain(w.ctx.projDraftBody(d).mcpServers), ['jira']);
  });
  it('a second open does not replace an open draft', async () => {
    const w = loadProjects();
    const d = await openEditor(w);
    type(d, '[data-pk="name"]', 'Erst');
    w.ctx.openProjectEditor({ id: 'p-00000009', name: 'Anderes' });
    assert.equal(w.ev('PROJ_DRAFT'), d);
    assert.equal(w.ctx.projDraftBody(d).name, 'Erst');
  });
  it('Esc with a changed draft asks — „Weiter bearbeiten" keeps it, „Verwerfen" closes; a clean one closes at once', async () => {
    const answers = ['cancel', 'discard'];
    const w = loadProjects({ modal: () => answers.shift() });
    const d = await openEditor(w);
    type(d, '[data-pk="name"]', 'X');
    const esc = w.calls.overlayPush[0].opts.onEsc;
    esc(); await tick(); await tick();
    assert.equal(w.ev('PROJ_DRAFT'), d, '„Weiter bearbeiten" threw the draft away');
    esc(); await tick(); await tick();
    assert.equal(w.ev('PROJ_DRAFT'), null);
    assert.equal(w.calls.released, 1, 'the overlay was not released from the stack');
    assert.equal(d.ov.parentNode, null, 'the overlay is still in the document');
    const clean = loadProjects();
    await openEditor(clean);
    clean.calls.overlayPush[0].opts.onEsc(); await tick();
    assert.equal(clean.ev('PROJ_DRAFT'), null);
    assert.equal(clean.calls.uiModal.length, 0, 'a dialog for nothing');
  });
  it('Speichern validates with the route\'s own rules first — a refused field is NAMED, and editing it clears the mark', async () => {
    const w = loadProjects();
    const d = await openEditor(w);
    type(d, '[data-pk="instructions"]', 'x'.repeat(2001));
    assert.match(q(d, '.pe-counter[data-for="instructions"]').textContent, /2001 \/ 2000/);
    assert.ok(q(d, '.pe-counter[data-for="instructions"]').classList.contains('over'));
    assert.equal(await w.ctx.projEditorSave(), false);
    assert.equal(w.calls.api.filter(([p, b]) => p === '/api/projects' && b).length, 0, 'an invalid draft was POSTed');
    const listed = d.box.querySelectorAll('.pe-errors li').map((li) => li.dataset.field).sort();
    assert.deepEqual(listed, ['instructions', 'name'], 'required name + too-long instructions');
    assert.ok(d.box.querySelectorAll('.pe-field').find((f) => f.dataset.field === 'name').classList.contains('is-invalid'));
    type(d, '[data-pk="name"]', 'Demoprojekt');
    assert.ok(!d.box.querySelectorAll('.pe-field').find((f) => f.dataset.field === 'name').classList.contains('is-invalid'), 'the fixed field still claims an error');
    assert.deepEqual(d.box.querySelectorAll('.pe-errors li').map((li) => li.dataset.field), ['instructions']);
  });
  it('the route\'s 400 comes back as the same token list, in the open dialog; a 200 closes it and opens the page', async () => {
    let fail = true;
    const err = Object.assign(new Error('invalid project'), { status: 400, data: { errors: [{ field: 'name', code: 'duplicate' }] } });
    const w = loadProjects({ api: (p, o) => {
      if (p === '/api/projects' && o && o.method === 'POST') return fail ? err : { ok: true, created: true, project: Object.assign(PROJECT(), { id: 'p-12345678', name: 'Demoprojekt', warnings: [] }) };
      return null;
    } });
    const d = await openEditor(w);
    type(d, '[data-pk="name"]', 'Demoprojekt');
    assert.equal(await w.ctx.projEditorSave(), false);
    assert.equal(w.ev('PROJ_DRAFT'), d, 'a refused save closed the dialog');
    assert.match(q(d, '.pe-errors li').textContent, /de:projects\.fName: de:projects\.errDuplicate/);
    assert.equal(d.saving, false, 'the save button stays disabled after a refusal');
    fail = false;
    assert.equal(await w.ctx.projEditorSave(), true);
    assert.equal(w.ev('PROJ_DRAFT'), null);
    assert.equal(w.ev('PROJ_VIEW.sel'), 'p-12345678', 'the saved project\'s page did not open');
    assert.ok(w.calls.toast.some(([m, k]) => k === 'ok' && /angelegt/.test(m)));
  });
  it('„Aus aktuellem Tab" prefills from the selectors of the ACTIVE tab, drops bypass (and says so), never MOVES the guardrails', async () => {
    const sel = { '#modelSel': { value: 'opus[1m]', options: [] }, '#effortSel': { value: 'xhigh' }, '#permMode': { value: 'bypassPermissions' } };
    const tabObj = { title: 'Demoprojekt Freigabe', defaultTitle: false, cwd: 'C:\\WINDOWS\\system32', addDirs: ['C:\\r'], agent: 'reviewer', hue: 200, guardrails: 'Nur T01.', mcpServers: ['jira'] };
    const w = loadProjects({ env: {} });
    const $orig = w.ctx.$;
    w.ctx.$ = (s) => (sel[s] || $orig(s));
    w.ctx.ACTIVE = tabObj;
    await w.ctx.projectFromTab();
    for (let i = 0; i < 5; i++) await tick();
    const d = w.ev('PROJ_DRAFT');
    const v = plain(w.ctx.projDraftBody(d));
    assert.deepEqual({ name: v.name, cwd: v.cwd, addDirs: v.addDirs, mcp: v.mcpServers, model: v.model, effort: v.effort, mode: v.permissionMode, agent: v.agent, hue: v.hue, instr: v.instructions },
      { name: 'Demoprojekt Freigabe', cwd: '', addDirs: ['C:\\r'], mcp: ['jira'], model: 'opus[1m]', effort: 'xhigh', mode: '', agent: 'reviewer', hue: 200, instr: '' },
      'the main folder is no project cwd, bypass is not storable, the guardrails are not taken without a click');
    assert.ok(d.box.textContent.includes('projects.bypassNichtUebernommen'), 'the dropped bypass was not said');
    assert.equal(w.ctx.projDirty(), false, 'an untouched prefill is not a draft to ask about');
    q(d, '[data-pk="copy-guard"]').onclick();
    assert.equal(d.values.instructions, 'Nur T01.');
    assert.equal(tabObj.guardrails, 'Nur T01.', 'the tab lost its guardrails — copy, not move (critic M9)');
  });
  it('the tab\'s own stored MCP scope is read when it chose none itself (as the tab picker does)', async () => {
    const w = loadProjects({ api: (p) => (p.startsWith('/api/session/mcp') ? { selection: ['sap-adt'] } : null) });
    w.ctx.ACTIVE = { title: 'x', defaultTitle: true, sessionId: '11111111-2222-4333-8444-555555555555', hue: 150 };
    await w.ctx.projectFromTab(w.ctx.ACTIVE);
    for (let i = 0; i < 5; i++) await tick();
    assert.deepEqual(plain(w.ctx.projDraftBody(w.ev('PROJ_DRAFT')).mcpServers), ['sap-adt']);
    assert.equal(w.ctx.projDraftBody(w.ev('PROJ_DRAFT')).name, '', 'a default tab title is no project name');
  });
  it('the beforeunload guard reads projDirty()', async () => {
    const w = loadProjects();
    const d = await openEditor(w);
    const ev = { prevented: false, preventDefault() { this.prevented = true; } };
    w.listeners.beforeunload[0](ev);
    assert.equal(ev.prevented, false, 'a clean editor blocked the reload');
    type(d, '[data-pk="name"]', 'X');
    w.listeners.beforeunload[0](ev);
    assert.equal(ev.prevented, true, 'a reload throws the draft away without a word');
  });
});

describe('the view — tiles and the page are honest about what they know', () => {
  it('a broken store says so (store-corrupt) instead of showing „no projects"', async () => {
    const w = loadProjects({ api: (p) => (p === '/api/projects' ? Object.assign(new Error('projects.json is not valid JSON — left untouched'), { code: 'store-corrupt', status: 500 }) : null) });
    await w.ctx.loadProjects();
    assert.match(w.nodes['#projBody'].textContent, /^ERR de:projects\.speicherKaputt/);
  });
  it('a tile: name, the start values that are SET, „n Sitzungen · zuletzt", a warning badge with the reasons', () => {
    const w = loadProjects();
    const tile = w.ctx.projectTileEl(Object.assign(PROJECT(), { sessionCount: 3, lastActivity: Date.now(), warnings: [{ code: 'cwd-custom', field: 'cwd', value: 'C:\\r' }] }));
    assert.equal(tile.querySelector('.pt-name').textContent, 'Demoprojekt');
    assert.equal(tile.style['--proj-hue'], '150');
    assert.match(tile.querySelector('.proj-warn').textContent, /⚠ 1/);
    assert.match(tile.querySelector('.proj-warn').title, /warnCwdCustom/);
    assert.match(tile.querySelector('.pt-meta').textContent, /nSitzungen.*zuletzt/);
    const chips = tile.querySelectorAll('.proj-chip').map((c) => c.textContent);
    assert.ok(!chips.some((c) => /chipOrdner/.test(c)), 'the tile shows an unset cwd — only what IS set belongs there');
    assert.ok(chips.some((c) => /chipZusatz.*1/.test(c)));
  });
  it('the page lists the sessions the MAP labels, and the open tabs with an explicit [Zuordnen] for an unlabelled one', () => {
    const w = loadProjects({ folds: { sessions: true, instr: true } });
    const p = Object.assign(PROJECT(), { sessionCount: 1 });
    vm.runInContext('PROJECTS_DATA = ' + JSON.stringify([p]) + '; PROJ_SESSIONS = ' + JSON.stringify([
      { id: '22222222-2222-4222-8222-222222222222', title: 'Mine', projectId: p.id, projectPath: 'C:\\x', mtime: 1 },
      { id: '33333333-3333-4333-8333-333333333333', title: 'Other', projectId: null, projectPath: 'C:\\x', mtime: 1 },
    ]) + '; PROJ_VIEW.sel = "' + p.id + '"', w.ctx);
    w.env.TABS.push({ title: 'Tab A', projectId: p.id, sessionId: '44444444-4444-4444-8444-444444444444' }, { title: 'Tab B', projectId: 'p-99999999' });
    w.ctx.renderProjects();
    const body = w.nodes['#projBody'];
    const names = body.querySelectorAll('.uct-name').map((n) => n.textContent);
    assert.ok(names.includes('Mine') && !names.includes('Other'), 'session list: ' + names.join(', '));
    assert.ok(names.includes('Tab A') && !names.includes('Tab B'), 'open tabs of another project are listed');
    assert.ok(body.textContent.includes('projects.zuordnen'), 'no [Zuordnen] for a started, unlabelled tab');
    assert.ok(body.textContent.includes('projects.anweisungenWirk'), 'the page says when the instructions act (J2)');
  });
});

// ===============================================================================================================
// The Gegencheck of 05.10. — each block names the finding it pins.
// A world with a project list and a session list the fake server keeps answering with (loadProjects re-fetches
// after every action, and an empty answer would send the page back to the tiles).
const SID = (n) => String(n).repeat(8) + '-' + String(n).repeat(4) + '-4' + String(n).repeat(3) + '-8' + String(n).repeat(3) + '-' + String(n).repeat(12);
function pageWorld(o) {
  o = o || {};
  let W = null;
  const projects = o.projects || [Object.assign(PROJECT(), { updatedAt: 1000, sessionCount: 0, assignedCount: 0 })];
  const sessions = o.sessions || [];
  const w = loadProjects({
    modal: o.modal, lift: o.lift, env: o.env, folds: o.folds,
    api: (p, opt) => {
      const h = o.api && o.api(p, opt); if (h) return h;
      if (p === '/api/projects' && !(opt && opt.method === 'POST')) return { projects: plain(W.ev('PROJECTS_DATA') || []) };
      if (p === '/api/sessions') return { sessions: plain(W.ev('PROJ_SESSIONS') || []) };
      return null;
    },
  });
  W = w;
  vm.runInContext('PROJECTS_DATA = ' + JSON.stringify(projects) + '; PROJ_SESSIONS = ' + JSON.stringify(sessions), w.ctx);
  w.nodes['#projNew'] = w.dom.el('button');
  w.nodes['#projSearch'] = w.dom.el('input');
  w.dom.doc.body.appendChild(w.nodes['#projNew']);
  return w;
}
const fk = (w) => { const a = w.dom.doc.activeElement; return a && a.dataset ? a.dataset.fk || (a === w.nodes['#projNew'] ? '#projNew' : '?' + a.tagName) : null; };
const byFk = (w, k) => w.nodes['#projBody'].querySelector('[data-fk="' + k + '"]');
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
// a click on a section head, as a browser does it: `open` flips, then the toggle event (projFoldSec draws on it)
const fold = (w, key) => w.nodes['#projBody'].querySelector('details[data-key="' + key + '"]');
const unfold = (w, key, open) => { const d = fold(w, key); assert.ok(d, 'no section ' + key); d.open = open !== false; d.ontoggle(); return d; };

describe('Gegencheck — „Neuer Chat im Projekt" takes over only a tab that is really untouched', () => {
  it('an untouched tab with a folder of its OWN is not reused (real chat.js tabUntouched) — a new tab, the folder stays', async () => {
    const w = loadProjects({ lift: REAL_UNTOUCHED });
    const act = { uid: 9, title: 'Neuer Chat', defaultTitle: true, modelSel: '', effort: '', permissionMode: '', hue: 200, cwd: 'C:\\Temp' };
    w.ctx.ACTIVE = act;
    assert.equal(w.ev('tabUntouched(ACTIVE)'), false, 'J10: chat.js counts a folder of its own as touched');
    const tab = await newChat(w, PROJECT());
    assert.notEqual(tab, act, 'the project chat took over a tab set up for C:\\Temp');
    assert.equal(w.calls.made, 1);
    assert.equal(act.cwd, 'C:\\Temp');
    assert.equal(act.projectId, undefined);
  });
  it('…while a really untouched one is (no cwd, or the main folder in another spelling)', async () => {
    for (const cwd of [null, 'c:/windows/System32/']) {
      const w = loadProjects({ lift: REAL_UNTOUCHED });
      const act = { uid: 9, title: 'Neuer Chat', defaultTitle: true, modelSel: '', effort: '', permissionMode: '', hue: 200, cwd };
      w.ctx.ACTIVE = act;
      assert.equal(await newChat(w, PROJECT()), act, 'cwd ' + cwd);
      assert.equal(w.calls.made, 0);
    }
  });
  it('a project\'s OWN cwd lands on the tab before activateTab', async () => {
    const w = loadProjects();
    await newChat(w, Object.assign(PROJECT(), { cwd: 'C:\\Users\\x\\repo' }));
    assert.equal(w.calls.activated[0].cwd, 'C:\\Users\\x\\repo');
  });
  it('P1 (replaces J13): the tab is named like the project — a placeholder the first message replaces', async () => {
    const w = loadProjects({ lift: [[CHAT, 'isDefaultTitle', 'chat.js'], [CHAT, 'setTabTitle', 'chat.js']] });
    const tab = await newChat(w, Object.assign(PROJECT(), { name: 'Demoprojekt' }));
    assert.equal(w.calls.activated[0].title, 'Demoprojekt', 'the new chat is called „Neuer Chat" again');
    assert.equal(tab.projectId, 'p-0000abcd');
    assert.equal(tab.defaultTitle, true, 'the first prompt must still be allowed to name the tab');
    // what sendMessage does with the first text (chat-composer.js) — run with the REAL chat.js pair
    assert.match(read('public/js/chat-composer.js'), /if \(text && isDefaultTitle\(tab\)\) setTabTitle\(tab, text\);/, 'the send path no longer names the tab');
    if (w.ctx.isDefaultTitle(tab)) w.ctx.setTabTitle(tab, 'Bitte S3 prüfen');
    assert.equal(tab.title, 'Bitte S3 prüfen', 'the placeholder survived the first message');
    const manual = loadProjects({ env: { tabUntouched: () => true } });
    manual.ctx.ACTIVE = { uid: 3, title: 'Mein Name', defaultTitle: false, manualTitle: true };
    await newChat(manual, PROJECT());
    assert.equal(manual.ctx.ACTIVE.title, 'Mein Name', 'a title the user chose is never replaced');
  });
});

describe('Gegencheck — one start per click, and a stalled look-up does not hang it', () => {
  it('a second click while the MCP look-up is still out opens nothing; the button is busy meanwhile', async () => {
    let release;
    const held = new Promise((r) => { release = r; });
    const w = loadProjects({ api: (p) => (p === '/api/mcp/configured' ? held : null) });
    const btn = w.dom.el('button');
    const first = w.ctx.newChatInProject(PROJECT(), btn);
    await tick();
    assert.equal(btn.disabled, true); assert.equal(btn.getAttribute('aria-busy'), 'true');
    assert.equal(await w.ctx.newChatInProject(PROJECT(), btn), null, 'the second click started a second chat');
    release({ servers: [{ name: 'jira' }] });
    assert.ok(await first);
    assert.equal(w.calls.made, 1);
    assert.equal(btn.disabled, false); assert.equal(btn.getAttribute('aria-busy'), null);
    assert.ok(await newChat(w, PROJECT()), 'after the first start the project starts again');
  });
  // The test above hands newChatInProject a button directly; these two click the REAL buttons, so a call site that
  // stops passing its trigger (e.currentTarget) is caught — then the click still opens one tab, but the button
  // shows nothing while the look-up is out (Befund 13, „keine Rückmeldung").
  for (const [where, key, open] of [['tile', 'tile-chat:p-0000abcd', (w) => w.ctx.renderProjects()], ['page', 'act-chat', (w) => w.ctx.projOpen('p-0000abcd')]]) {
    it('the ' + where + '\'s [Neuer Chat] itself is busy while the MCP look-up is out, and free again after it', async () => {
      let release;
      const held = new Promise((r) => { release = r; });
      const w = pageWorld({ api: (p) => (p === '/api/mcp/configured' ? held : null) });
      open(w);
      const b = byFk(w, key);
      assert.ok(b, 'no ' + key + ' on the ' + where);
      const run = b.onclick({ currentTarget: b, stopPropagation() {} });
      await tick();
      const busy = [b.disabled, b.getAttribute('aria-busy')];
      release({ servers: [{ name: 'jira' }] });
      await run; await settle();
      assert.deepEqual(busy, [true, 'true'], 'the clicked button said nothing while the start was pending');
      assert.deepEqual([b.disabled, b.getAttribute('aria-busy')], [false, null]);
      assert.equal(w.calls.made, 1);
    });
  }
  it('the look-up has a deadline — past it the names go in unchecked, with the reason', async () => {
    const w = loadProjects({ env: { t: (k) => (k === 'projects.keineAntwort' ? 'keine Antwort nach {s} s' : k) } });
    await assert.rejects(w.ctx.projWithin(new Promise(() => {}), 20), /keine Antwort nach 0 s/);
    assert.equal(w.ev('PROJ_MCP_LOOKUP_MS'), 5000);
  });
  it('…and the start path USES that deadline: a look-up that never answers still opens the tab, names unchecked, said why', async () => {
    // the 5-s timer fires at once here; every other timer keeps its real delay
    const w = loadProjects({
      api: (p) => (p === '/api/mcp/configured' ? new Promise(() => {}) : null),
      env: { setTimeout: (fn, ms) => (ms === 5000 ? setTimeout(fn, 0) : setTimeout(fn, ms)) },
    });
    const tab = await Promise.race([newChat(w, PROJECT()), new Promise((r) => setTimeout(() => r('HUNG'), 2000))]);
    assert.notEqual(tab, 'HUNG', 'a hanging /api/mcp/configured hangs the start — the deadline is not used');
    assert.ok(tab, 'a hanging /api/mcp/configured left the click without any effect');
    assert.deepEqual(plain(w.calls.activated[0].mcpServers), ['jira'], 'unchecked names are kept, not dropped');
    assert.ok(w.calls.toast.some(([m, k]) => k === 'warn' && m.includes('projects.mcpUngeprueft') && m.includes('projects.keineAntwort')));
  });
});

describe('Gegencheck — a path that did not answer at the last save is asked about before it is copied', () => {
  const DEAD = 'Z:\\tot';
  const P = () => Object.assign(PROJECT(), { addDirs: ['C:\\Users\\x\\repo', DEAD], warnings: [{ code: 'path-unchecked', field: 'addDirs', value: DEAD }] });
  it('„Ohne diese Pfade" drops exactly those; „Trotzdem" keeps them; Abbrechen / Esc open nothing', async () => {
    for (const [answer, expect] of [['without', ['C:\\Users\\x\\repo']], ['keep', ['C:\\Users\\x\\repo', DEAD]], ['cancel', null], [undefined, null]]) {
      const w = loadProjects({ modal: () => answer });
      const tab = await newChat(w, P());
      assert.equal(w.calls.uiModal.length, 1, 'not asked (' + answer + ')');
      assert.equal(w.calls.uiModal[0].escValue, 'cancel');
      assert.ok(w.calls.uiModal[0].message.includes('projects.pfadUngeprueftFrage'));
      if (expect === null) { assert.equal(tab, null); assert.equal(w.calls.made, 0); continue; }
      assert.deepEqual(plain(w.calls.activated[0].addDirs), expect, String(answer));
    }
  });
  it('an unchecked own cwd: „Ohne" leaves the tab on the main folder', async () => {
    const w = loadProjects({ modal: () => 'without' });
    await newChat(w, Object.assign(PROJECT(), { cwd: 'Z:\\proj', warnings: [{ code: 'path-unchecked', field: 'cwd', value: 'Z:\\proj' }] }));
    assert.equal('cwd' in w.calls.activated[0], false);
  });
  it('no stored path-unchecked → no question', async () => {
    const w = loadProjects();
    await newChat(w, PROJECT());
    assert.equal(w.calls.uiModal.length, 0);
  });
});

describe('Gegencheck — the editor never overwrites another window\'s save without asking (lost update)', () => {
  const stored = () => Object.assign(PROJECT(), { updatedAt: 1000, description: 'alt', instructions: 'T01 ist Test' });
  it('an update sends ONLY the changed fields, plus the version it loaded', async () => {
    const w = loadProjects({ api: (p, o) => (p === '/api/projects' && o && o.method === 'POST' ? { ok: true, project: Object.assign(stored(), { description: 'neu', updatedAt: 1001 }) } : null) });
    const d = await openEditor(w, stored());
    type(d, '[data-pk="description"]', 'neu');
    assert.equal(await w.ctx.projEditorSave(), true);
    const sent = w.calls.api.find(([p, b]) => p === '/api/projects' && b)[1].project;
    assert.deepEqual(sent, { id: 'p-0000abcd', baseUpdatedAt: 1000, description: 'neu' });
  });
  it('409: asked; „Meine Änderungen" re-sends only mine on the NEW version; „Verwerfen" shows the stored state; Esc keeps the draft', async () => {
    const cur = Object.assign(stored(), { updatedAt: 2000, instructions: 'aus dem anderen Fenster' });
    for (const answer of ['mine', 'load', 'cancel']) {
      let n = 0, W = null;
      const w = loadProjects({
        modal: () => answer,
        api: (p, o) => {
          if (p === '/api/projects' && !(o && o.method === 'POST')) return { projects: plain(W.ev('PROJECTS_DATA') || []) };
          if (!(p === '/api/projects' && o && o.method === 'POST')) return null;
          n++;
          if (n === 1) return Object.assign(new Error('conflict'), { status: 409, data: { ok: false, error: 'conflict', errors: [{ field: '', code: 'conflict' }], project: cur } });
          return { ok: true, project: Object.assign({}, cur, { description: 'neu', updatedAt: 2001 }) };
        },
      });
      W = w;
      vm.runInContext('PROJECTS_DATA = ' + JSON.stringify([Object.assign(stored(), { sessionCount: 2 })]), w.ctx);
      const d = await openEditor(w, stored());
      type(d, '[data-pk="description"]', 'neu');
      const ok = await w.ctx.projEditorSave();
      await settle();
      const posts = w.calls.api.filter(([p, b]) => p === '/api/projects' && b).map(([, b]) => b.project);
      assert.equal(w.calls.uiModal.length, 1, 'a 409 must ask (' + answer + ')');
      assert.equal(w.calls.uiModal[0].escValue, 'cancel');
      const inList = plain(w.ev('PROJECTS_DATA')).find((x) => x.id === cur.id);
      assert.equal(inList.instructions, 'aus dem anderen Fenster', 'the list must show what is stored now');
      assert.equal(inList.sessionCount, 2, 'the per-request counts are kept');
      if (answer === 'mine') {
        assert.equal(ok, true);
        assert.deepEqual(posts[1], { id: cur.id, baseUpdatedAt: 2000, description: 'neu' }, 'only MY field, on the new base — the other window\'s instructions survive');
        assert.equal(w.ev('PROJ_DRAFT'), null);
      } else if (answer === 'load') {
        assert.equal(posts.length, 1, 'nothing may be re-sent');
        assert.equal(w.ev('PROJ_DRAFT'), null);
      } else {
        assert.equal(posts.length, 1);
        assert.equal(w.ev('PROJ_DRAFT'), d, '„Weiter bearbeiten" threw the draft away');
        assert.equal(d.saving, false);
      }
    }
  });
  it('a create sends the full record and no version', async () => {
    const w = loadProjects({ api: (p, o) => (p === '/api/projects' && o && o.method === 'POST' ? { ok: true, created: true, project: Object.assign(PROJECT(), { id: 'p-12345678' }) } : null) });
    const d = await openEditor(w);
    type(d, '[data-pk="name"]', 'Neu');
    await w.ctx.projEditorSave();
    const sent = w.calls.api.find(([p, b]) => p === '/api/projects' && b)[1].project;
    assert.equal(sent.name, 'Neu'); assert.ok(!('baseUpdatedAt' in sent)); assert.ok(!('id' in sent));
    assert.deepEqual(Object.keys(sent).sort(), plain(w.ev('PROJECT_FIELDS')).slice().sort());
  });
});

describe('Gegencheck — data is data: a code that names an Object member does not take the view down', () => {
  it('warning / error / field / mode / effort codes like `constructor` render as text, never as a function', () => {
    const real = loadProjects({ env: { t: (k) => I18N.de[k] || k } });
    assert.equal(real.ev('projWarningText({ code: "constructor", field: "cwd" })'), 'constructor');
    assert.equal(real.ev('projWarningText({ code: "toString", field: "cwd" })'), 'toString');
    assert.match(real.ev('projErrorText({ field: "constructor", code: "hasOwnProperty" })'), /^Projekt: hasOwnProperty$/);
    assert.equal(real.ev('projModeLabel("constructor")'), 'constructor');
    assert.equal(real.ev('projEffortLabel("toString")'), 'toString');
    const tile = real.ctx.projectTileEl(Object.assign(PROJECT(), { warnings: [{ code: 'constructor', field: 'cwd' }] }));
    assert.equal(tile.querySelector('.proj-warn').title, 'constructor');
  });
});

describe('Gegencheck — the view: count under a search, the tile footer, the delete count', () => {
  const three = () => ['Demoprojekt', 'Formularservice', 'Drittprojekt'].map((name, i) => Object.assign(PROJECT(), { id: 'p-0000000' + i, name, updatedAt: 10 - i }));
  it('a search shows „shown / total" (the A13 form), without one only the total', () => {
    const w = pageWorld({ projects: three() });
    w.ctx.renderProjects();
    assert.equal(w.nodes['#projCount'].textContent, 'de:projects.nProjekte');
    w.nodes['#projSearch'].value = 'demopro';
    w.ctx.renderProjects();
    assert.equal(w.nodes['#projBody'].querySelectorAll('.proj-tile').length, 1);
    assert.equal(w.nodes['#projCount'].textContent, '1 / de:projects.nProjekte');
  });
  it('the tile footer: the two buttons are ONE group, so they wrap together', () => {
    const w = loadProjects();
    const foot = w.ctx.projectTileEl(PROJECT()).querySelector('.pt-foot');
    assert.deepEqual(foot.children.map((c) => c.className), ['pt-meta', 'pt-acts']);
    assert.equal(foot.querySelector('.pt-acts').children.length, 2);
  });
  it('the delete question counts every label the delete removes (assignedCount), not only sessions with a transcript', async () => {
    const msgs = [];
    const w = pageWorld({ projects: [Object.assign(PROJECT(), { sessionCount: 0, assignedCount: 1 })], env: { uiConfirm: async (m) => { msgs.push(m); return false; } } });
    await w.ctx.deleteProjectUi(w.ev('PROJECTS_DATA')[0]);
    assert.ok(msgs[0].includes('projects.loeschenSitzungen'), 'the dialog said nothing about the one assigned session');
  });
});

describe('Gegencheck — labelling a session after a reload, and the two branches of the open-tab row', () => {
  const S_FREE_OLD = { id: SID(5), title: 'Alt', projectId: null, projectPath: 'C:\\x', mtime: 100 };
  const S_FREE_NEW = { id: SID(6), title: 'Neu', projectId: '', projectPath: 'C:\\x', mtime: 900 };
  const S_OTHER = { id: SID(7), title: 'Fremd', projectId: 'p-99999999', projectPath: 'C:\\x', mtime: 500 };
  const S_MINE = { id: SID(8), title: 'Meins', projectId: 'p-0000abcd', projectPath: 'C:\\x', mtime: 300 };
  it('„Sitzung zuordnen…" lists the sessions WITHOUT a project, newest first, and posts the ticked ones', async () => {
    let shown = null;
    const w = pageWorld({
      sessions: [S_FREE_OLD, S_OTHER, S_FREE_NEW, S_MINE], folds: { sessions: true },
      modal: (o) => { shown = o; const cb = o.body.querySelectorAll('input[data-sid]'); cb[0].checked = true; return 'assign'; },
    });
    w.ctx.projOpen('p-0000abcd');
    const btn = byFk(w, 'sess-pick');
    assert.ok(btn, 'no „Sitzung zuordnen…" on the page — after a reload no tab carries the project, and this is the only way left');
    await btn.onclick();
    await settle();
    const rows = shown.body.querySelectorAll('input[data-sid]').map((cb) => cb.dataset.sid);
    assert.deepEqual(rows, [S_FREE_NEW.id, S_FREE_OLD.id], 'only sessions without a project, newest first');
    const post = w.calls.api.find(([p]) => p === '/api/projects/assign');
    assert.deepEqual(post[1], { sessionIds: [S_FREE_NEW.id], projectId: 'p-0000abcd' });
  });
  it('…Abbrechen or Esc with a ticked box posts nothing, and neither does „Zuordnen" with none ticked', async () => {
    // a write path: a cancelled picker that still posted would label the ticked sessions without a word
    for (const [answer, ticked] of [['cancel', true], [undefined, true], ['assign', false]]) {
      const w = pageWorld({
        sessions: [S_FREE_OLD, S_FREE_NEW], folds: { sessions: true },
        modal: (o) => { if (ticked) o.body.querySelectorAll('input[data-sid]')[0].checked = true; return answer; },
      });
      w.ctx.projOpen('p-0000abcd');
      assert.equal(await byFk(w, 'sess-pick').onclick(), false, String(answer));
      await settle();
      assert.equal(w.calls.uiModal.length, 1, 'premise: the picker was shown (' + answer + ')');
      assert.equal(w.calls.api.find(([p]) => p === '/api/projects/assign'), undefined, 'answer ' + answer + (ticked ? ' with a ticked box' : ' with none ticked') + ' posted an assign');
    }
  });
  it('[Lösen] forgets the decision — projectId null, never "" (that would suppress every later suggestion)', async () => {
    const w = pageWorld({ sessions: [S_MINE], folds: { sessions: true } });
    w.ctx.projOpen('p-0000abcd');
    await byFk(w, 'sess-unassign:' + S_MINE.id).onclick({ stopPropagation() {} });
    const post = w.calls.api.find(([p]) => p === '/api/projects/assign');
    assert.deepEqual(post[1], { sessionIds: [S_MINE.id], projectId: null });
  });
  it('Grundpflege a: a rule-labelled session is listed too — „(2)", „per Regel", [Fest zuordnen] posts the project', async () => {
    const S_RULE = { id: SID(9), title: 'Regel', projectId: null, projectDerived: 'p-0000abcd', projectPath: 'C:\\Atlas', mtime: 400 };
    const w = pageWorld({ sessions: [S_MINE, S_RULE, S_FREE_OLD], folds: { sessions: true } });
    w.ctx.projOpen('p-0000abcd');
    const sec = fold(w, 'sessions');
    assert.match(sec.querySelector('h3').textContent, /\(2\)$/, 'explicit + rule = 2');
    assert.deepEqual(sec.querySelectorAll('.uct-name').map((n) => n.textContent), ['Regel', 'Meins'], 'newest first');
    assert.equal(sec.querySelectorAll('.proj-rule').length, 1, 'the rule row is not marked');
    assert.equal(byFk(w, 'sess-unassign:' + S_RULE.id), null, 'a rule row cannot be „gelöst" — there is no entry');
    await byFk(w, 'sess-fix:' + S_RULE.id).onclick({ stopPropagation() {} });
    assert.deepEqual(w.calls.api.find(([p]) => p === '/api/projects/assign')[1], { sessionIds: [S_RULE.id], projectId: 'p-0000abcd' });
  });
  it('Grundpflege b: „Sitzung zuordnen…" searches ALL sessions — no. 55 of 60 is found, a foreign one says „(jetzt: …)"', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: SID(1).slice(0, -3) + String(100 + i), title: 'Sitzung ' + (i + 1), projectId: i === 54 ? 'p-99999999' : null, projectPath: 'C:\\x', mtime: 1000 - i }));
    let body = null;
    const w = pageWorld({
      sessions: many, folds: { sessions: true },
      projects: [Object.assign(PROJECT(), { updatedAt: 1000 }), Object.assign(PROJECT(), { id: 'p-99999999', name: 'Fremd', updatedAt: 1 })],
      modal: (o) => {
        body = o.body;
        assert.equal(o.body.querySelectorAll('input[data-sid]').length, 40, 'without a search: the newest 40 without a project');
        assert.ok(!o.body.querySelectorAll('input[data-sid]').some((cb) => cb.dataset.sid === many[54].id), 'premise: no. 55 is not among them');
        o.body.querySelectorAll('input[data-sid]')[0].checked = true; // ticked BEFORE the search — must survive it
        const q = o.body.querySelector('.pd-pick-search'); q.value = 'Sitzung 55'; q.oninput();
        const hits = o.body.querySelectorAll('input[data-sid]');
        assert.deepEqual(hits.map((cb) => cb.dataset.sid), [many[54].id]);
        assert.ok(o.body.textContent.includes('de:projects.jetztBei'), 'a session labelled elsewhere does not say so');
        hits[0].checked = true;
        return 'assign';
      },
    });
    w.ctx.projOpen('p-0000abcd');
    assert.equal(await byFk(w, 'sess-pick').onclick(), true);
    assert.ok(body);
    const post = w.calls.api.find(([p]) => p === '/api/projects/assign');
    assert.deepEqual(post[1].sessionIds.slice().sort(), [many[0].id, many[54].id].sort(), 'the tick from before the search was lost');
  });
  it('[Zuordnen] on a tab whose session has no transcript yet: posts the project, and the row then says „zugeordnet"', async () => {
    const w = pageWorld({ sessions: [] });
    w.env.TABS.push({ uid: 4, title: 'Tab', projectId: 'p-0000abcd', sessionId: SID(4) });
    w.ctx.projOpen('p-0000abcd');
    await byFk(w, 'tab-assign:4').onclick({ stopPropagation() {} });
    await settle();
    assert.deepEqual(w.calls.api.find(([p]) => p === '/api/projects/assign')[1], { sessionIds: [SID(4)], projectId: 'p-0000abcd' });
    assert.equal(byFk(w, 'tab-assign:4'), null, '[Zuordnen] offered again although the click was remembered');
    assert.ok(w.nodes['#projBody'].textContent.includes('projects.zugeordnetTag'));
  });
  it('a tab another window holds says „anderswo offen", not „gestartet" (#96 tabHeldElsewhere)', () => {
    const w = pageWorld({ sessions: [] });
    w.ctx.tabHeldElsewhere = (tb) => !!(tb && tb._elsewhere);
    w.env.TABS.push({ uid: 5, title: 'Fern', projectId: 'p-0000abcd', sessionId: SID(5), _elsewhere: true });
    w.env.TABS.push({ uid: 6, title: 'Hier', projectId: 'p-0000abcd', sessionId: SID(6) });
    w.ctx.projOpen('p-0000abcd');
    const txt = w.nodes['#projBody'].textContent;
    assert.ok(txt.includes('⇄ de:chat.anderswoOffen · ' + SID(5).slice(0, 8)), 'the held tab does not say where it lives');
    assert.equal((txt.match(/projects\.tabGestartet/g) || []).length, 1, 'only the tab of THIS window is „gestartet"');
  });
});

describe('Gegencheck — the caret survives every rebuild (WCAG 2.4.3)', () => {
  const two = () => [Object.assign(PROJECT(), { updatedAt: 5 }), Object.assign(PROJECT(), { id: 'p-0000beef', name: 'Zweites', updatedAt: 4 })];
  it('open → the page heading; back → the tile it came from', () => {
    const w = pageWorld({ projects: two() });
    w.ctx.renderProjects();
    w.ctx.projOpen('p-0000beef');
    assert.equal(fk(w), 'pd-name');
    assert.equal(w.dom.doc.activeElement.tabIndex, -1, 'the heading is a target, not a Tab stop');
    byFk(w, 'back').onclick();
    assert.equal(fk(w), 'tile:p-0000beef');
  });
  it('a background rebuild keeps the caret on the same control (a new node)', () => {
    const w = pageWorld({ projects: two() });
    w.ctx.projOpen('p-0000abcd');
    const before = byFk(w, 'act-edit'); before.focus();
    w.ctx.renderProjects();
    assert.equal(fk(w), 'act-edit');
    assert.notEqual(w.dom.doc.activeElement, before);
    w.nodes['#projSearch'].focus(); // …but a caret OUTSIDE the body is never pulled in
    w.ctx.renderProjects();
    assert.equal(w.dom.doc.activeElement, w.nodes['#projSearch']);
  });
  it('after Speichern → the page\'s Bearbeiten; after Löschen → the next tile; after Lösen → the next row', async () => {
    const w = pageWorld({
      projects: two(),
      sessions: [{ id: SID(1), title: 'A', projectId: 'p-0000abcd', projectPath: 'C:\\x', mtime: 2 }, { id: SID(2), title: 'B', projectId: 'p-0000abcd', projectPath: 'C:\\x', mtime: 1 }],
      folds: { sessions: true },
      api: (p, o) => (p === '/api/projects' && o && o.method === 'POST' ? { ok: true, project: Object.assign(PROJECT(), { updatedAt: 6, description: 'x' }) } : null),
    });
    w.ctx.projOpen('p-0000abcd');
    byFk(w, 'act-edit').focus();
    const d = await openEditor(w, w.ev('PROJECTS_DATA')[0]);
    type(d, '[data-pk="description"]', 'x');
    await w.ctx.projEditorSave();
    assert.equal(fk(w), 'act-edit');
    await byFk(w, 'sess-unassign:' + SID(1)).onclick({ stopPropagation() {} });
    await settle();
    assert.equal(fk(w), 'sess-unassign:' + SID(2), 'the caret did not go to the next row');
    await w.ctx.deleteProjectUi(w.ev('PROJECTS_DATA').find((x) => x.id === 'p-0000abcd'));
    await settle();
    assert.equal(fk(w), 'tile:p-0000beef');
  });
  it('a NEW project: after Speichern the caret is on its page heading — the opener (#projNew) is not on that page', async () => {
    const w = pageWorld({
      projects: [],
      api: (p, o) => (p === '/api/projects' && o && o.method === 'POST' ? { ok: true, created: true, project: Object.assign(PROJECT(), { id: 'p-12345678', name: 'Neu', updatedAt: 7 }) } : null),
    });
    w.ctx.renderProjects();
    w.nodes['#projNew'].focus();
    const d = await openEditor(w);
    type(d, '[data-pk="name"]', 'Neu');
    assert.equal(await w.ctx.projEditorSave(), true);
    assert.equal(fk(w), 'pd-name', 'the caret was left in the closed dialog');
    assert.equal(w.dom.doc.activeElement.textContent, 'Neu');
  });
  it('[Zuordnen] on an open tab → „Zum Tab" of that row (the clicked button is replaced by „✓ zugeordnet")', async () => {
    const w = pageWorld({ sessions: [] });
    w.env.TABS.push({ uid: 4, title: 'Tab', projectId: 'p-0000abcd', sessionId: SID(4) });
    w.ctx.projOpen('p-0000abcd');
    const b = byFk(w, 'tab-assign:4');
    b.focus();
    await b.onclick({ stopPropagation() {} });
    await settle();
    assert.equal(w.dom.doc.activeElement.isConnected, true, 'the caret stayed on the removed [Zuordnen] — <body> in a browser');
    assert.equal(fk(w), 'tab-go:4');
  });
  it('409 → „Verwerfen, gespeicherten Stand zeigen": back on the ✎ of the tile that opened the editor, or on the page\'s Bearbeiten', async () => {
    // the 'load' answer rebuilds #projBody with an explicit target list, which replaces the fallback to the focused
    // control; on the overview neither the page's Bearbeiten nor its heading exists, so the caret was left on the
    // old ✎ the rebuild removed — <body> in a browser
    const cur = Object.assign(PROJECT(), { updatedAt: 2000, sessionCount: 0, assignedCount: 0, instructions: 'aus dem anderen Fenster' });
    for (const [from, opener, open] of [['tile', 'tile-edit:p-0000abcd', (w) => w.ctx.renderProjects()], ['page', 'act-edit', (w) => w.ctx.projOpen('p-0000abcd')]]) {
      let W = null;
      const w = pageWorld({
        modal: () => 'load',
        api: (p, o) => (p === '/api/projects' && o && o.method === 'POST'
          ? Object.assign(new Error('conflict'), { status: 409, data: { ok: false, error: 'conflict', errors: [{ field: '', code: 'conflict' }], project: cur } })
          : null),
        // as the real overlay stack does: the release hands the caret back to what had it at the push, if still there
        env: { overlayPush: () => { const back = W.dom.doc.activeElement; return () => { if (back && back.isConnected) back.focus(); }; } },
      });
      W = w;
      open(w);
      byFk(w, opener).focus();
      const d = await openEditor(w, w.ev('PROJECTS_DATA')[0]);
      assert.equal(d.openerFk, opener, 'premise (' + from + ')');
      type(d, '[data-pk="description"]', 'neu');
      assert.equal(await w.ctx.projEditorSave(), false);
      await settle();
      assert.equal(w.calls.uiModal.length, 1, 'premise: the conflict was asked (' + from + ')');
      assert.equal(w.ev('PROJ_DRAFT'), null, 'premise: „Verwerfen" closed the editor (' + from + ')');
      assert.equal(w.ev('PROJ_VIEW.sel'), from === 'tile' ? null : 'p-0000abcd', 'the view changed under the answer (' + from + ')');
      assert.equal(w.dom.doc.activeElement.isConnected, true, 'the caret was left on a node the rebuild removed — <body> in a browser (' + from + ')');
      assert.equal(fk(w), opener);
    }
  });
});

describe('Gegencheck — a visible word starts the accessible name (WCAG 2.5.3), with the REAL iconBtn', () => {
  it('every labelled button on the tiles, the empty state and the page: aria-label = its visible text', () => {
    const w = pageWorld({ lift: REAL_ICONBTN, folds: { sessions: true }, sessions: [{ id: SID(1), title: 'A', projectId: 'p-0000abcd', projectPath: 'C:\\x', mtime: 1 }] });
    w.env.TABS.push({ uid: 4, title: 'Tab', projectId: 'p-0000abcd', sessionId: SID(4) });
    const btns = [];
    w.ctx.renderProjects(); btns.push(...w.nodes['#projBody'].querySelectorAll('button'));
    w.ctx.projOpen('p-0000abcd'); btns.push(...w.nodes['#projBody'].querySelectorAll('button'));
    vm.runInContext('PROJECTS_DATA = []', w.ctx); w.ctx.renderProjects(); btns.push(...w.nodes['#projBody'].querySelectorAll('button'));
    const labelled = btns.filter((b) => b.querySelector('.btxt'));
    assert.ok(labelled.length >= 9, 'the scan found ' + labelled.length + ' labelled buttons');
    for (const b of labelled) {
      const visible = b.querySelector('.btxt').textContent;
      assert.equal(b.getAttribute('aria-label'), visible, '„' + visible + '" is named „' + b.getAttribute('aria-label') + '" — voice control cannot reach it');
    }
    const loesen = labelled.find((b) => b.querySelector('.btxt').textContent === 'de:projects.loesen');
    assert.equal(loesen.title, 'de:projects.loesenTooltip', 'the tooltip stays as the description');
  });
});

// ===============================================================================================================
// Projekte, Stufe 2 — the client side (J1/J4/J5/J6/J10): the REAL functions of sessions.js, chat-status.js and
// chat.js, lifted into the projects.js world (projById, ensureProjects, projectStartValues are the real ones too).
const SESS_SRC = read('public/js/sessions.js');
const STATUS_SRC = read('public/js/chat-status.js');
const SESS_LIFT = ['sessProjName', 'sessProjOf', 'sessHiddenInAll', 'sessHiddenCount', 'sessionMatches', 'visibleSessions', 'sessProjChip', 'sessProjFilterRow', 'openProjectPicker',
  'assignSessionsToProject', 'projectEffectKey', 'projectAdoptStart', 'assignTabProject', 'openTabProjectPicker', 'pickSessionProject',
  'projectApplyOnResume', 'resumeSession'].map((n) => [SESS_SRC, n, 'sessions.js']);
const P2 = () => Object.assign(PROJECT(), { updatedAt: 2000 });
function loadClient(over) {
  over = over || {};
  const rec = { restart: [], status: 0, renderSessions: 0, started: [], sync: [] };
  const sel = {};
  ['#modelSel', '#effortSel', '#permMode', '#sessSearch', '#cwdInput'].forEach((id) => { sel[id] = { value: '', id }; });
  let w;
  const env = Object.assign({
    tt: (k) => 'de:' + k,
    positionMenuAt: () => {},
    restartWhenIdle: async (tb, why) => { rec.restart.push([tb, why]); },
    promptSnapshotFresh: async () => true,
    renderStatusBar: () => { rec.status++; },
    renderSessions: () => { rec.renderSessions++; },
    syncRunSelectors: (tb) => { rec.sync.push(tb); sel['#modelSel'].value = tb.modelSel || ''; sel['#effortSel'].value = tb.effort || ''; sel['#permMode'].value = tb.permissionMode || ''; },
    setTabTitle: () => {}, renderResumeHistory: async () => {}, findSessionTab: () => null,
    newTab: () => { const tb = { uid: 99, title: 'Neuer Chat' }; w.ctx.ACTIVE = tb; return tb; },
    startChat: async (extra, tb) => { rec.started.push({ extra: plain(extra), tab: tb, seen: plain(tb), dom: { model: sel['#modelSel'].value, effort: sel['#effortSel'].value, mode: sel['#permMode'].value } }); },
    SESSIONS: [],
    api: async (p, o) => {
      w.calls.api.push([p, o && o.body ? JSON.parse(o.body) : null]);
      if (p === '/api/projects') return { projects: over.projects || [P2()] };
      return {};
    },
  }, over.env || {});
  w = loadProjects({ env, lift: [[CHAT, 'tabCwdIsMain', 'chat.js'], [CHAT, 'tabUntouched', 'chat.js'], [STATUS_SRC, 'projectStatusChip', 'chat-status.js'], ...SESS_LIFT] });
  const inert = { classList: { add() {}, remove() {} } };
  w.ctx.$ = (s) => sel[s] || (/^.nav-item|^#view-chat$/.test(s) ? inert : null);
  w.ctx.$$ = () => [];
  const d = w.dom.doc;
  d.addEventListener = () => {}; d.removeEventListener = () => {};
  d.getElementById = (id) => d.body.querySelector('#' + id);
  d.querySelector = (q) => d.body.querySelector(q);
  w.ev("var SESS_PROJ_FILTER = 'all';");
  return Object.assign(w, { rec, sel });
}
const picker = (w) => w.dom.doc.body.querySelector('#projPicker');
const pickItems = (w) => picker(w).querySelectorAll('.ctx-item');
const posts = (w) => w.calls.api.filter((c) => c[0] === '/api/projects/assign');
const SA = { id: 'aaaaaaaa-1111-4111-8111-111111111111', title: 'Alpha', preview: '', summary: '', projectPath: 'C:\\w', projectId: 'p-0000abcd' };
const SB = { id: 'bbbbbbbb-1111-4111-8111-111111111111', title: 'Beta', preview: '', summary: '', projectPath: 'C:\\w', projectId: '' };
const SC = { id: 'cccccccc-1111-4111-8111-111111111111', title: 'Gamma', preview: '', summary: '', projectPath: 'C:\\w' };

describe('Stufe 2 — the sessions list knows the project (J5)', () => {
  it('ONE filter: the project name is searchable, „Ohne Projekt" covers both \'\' and undecided, a project only its own', async () => {
    const w = loadClient();
    await w.ev('ensureProjects()');
    w.ctx.SESSIONS = [SA, SB, SC];
    const ids = (pf, q) => { w.ev('SESS_PROJ_FILTER = ' + JSON.stringify(pf)); w.sel['#sessSearch'].value = q || ''; return plain(w.ctx.visibleSessions().map((s) => s.title)); };
    assert.deepEqual(ids('all', 'demoproj'), ['Alpha'], 'the project name is not in the search');
    assert.deepEqual(ids('none'), ['Beta', 'Gamma']);
    assert.deepEqual(ids('p-0000abcd'), ['Alpha']);
    assert.deepEqual(ids('all'), ['Alpha', 'Beta', 'Gamma']);
    assert.ok(!/s\.projectPath \+ s\.id\)\.toLowerCase/.test(SESS_SRC), 'a second copy of the filter expression is back');
  });
  it('the chip: solid with the name, dashed for a deliberate „none", nothing when never decided — as text', async () => {
    const w = loadClient();
    await w.ev('ensureProjects()');
    const a = w.ctx.sessProjChip(SA), b = w.ctx.sessProjChip(SB);
    assert.equal(a.textContent, '◆ Demoprojekt'); assert.ok(!a.classList.contains('none'));
    assert.ok(b.classList.contains('none')); assert.equal(b.textContent, 'de:projects.siOhne');
    assert.equal(w.ctx.sessProjChip(SC), null);
    assert.equal(w.ctx.sessProjChip({ projectId: 'p-gone' }).textContent, '◆ de:projects.chipGeloescht', 'a deleted project after loading says so');
  });
  it('filter chips Alle · each project · Ohne Projekt; a press filters and re-renders', async () => {
    const w = loadClient();
    await w.ev('ensureProjects()');
    w.ctx.SESSIONS = [SA, SB, SC];
    const chips = w.ctx.sessProjFilterRow().querySelectorAll('.proj-filter-chip');
    assert.deepEqual(chips.map((c) => c.dataset.pf), ['all', 'p-0000abcd', 'none']);
    assert.equal(chips[0].getAttribute('aria-pressed'), 'true');
    chips[1].onclick();
    assert.equal(w.ev('SESS_PROJ_FILTER'), 'p-0000abcd'); assert.equal(w.rec.renderSessions, 1);
  });
  it('the bulk „Projekt…": ONE POST for every selected session, mirrored into the list', async () => {
    const w = loadClient();
    w.ctx.SESSIONS = [Object.assign({}, SB), Object.assign({}, SC)];
    const done = w.ctx.pickSessionProject([SB.id, SC.id], w.dom.el('button'));
    await settle();
    pickItems(w).find((i) => i.textContent.includes('Demoprojekt')).onclick();
    assert.equal(await done, true);
    assert.equal(posts(w).length, 1);
    assert.deepEqual(posts(w)[0][1], { sessionIds: [SB.id, SC.id], projectId: 'p-0000abcd' });
    assert.deepEqual(w.ctx.SESSIONS.map((s) => s.projectId), ['p-0000abcd', 'p-0000abcd']);
  });
  it('the popover: Esc closes without writing and hands the caret back (WCAG 2.4.3)', async () => {
    const w = loadClient();
    const anchor = w.dom.el('button'); w.dom.doc.body.appendChild(anchor);
    const done = w.ctx.pickSessionProject([SA.id], anchor, SA.projectId);
    await settle();
    assert.ok(picker(w), 'no popover');
    assert.ok(pickItems(w)[0].textContent.startsWith('✓'), 'the current project is not marked');
    w.calls.overlayPush.find((o) => o.node === picker(w)).opts.onEsc();
    assert.equal(await done, false);
    assert.equal(picker(w), null); assert.equal(w.dom.doc.activeElement, anchor); assert.equal(posts(w).length, 0);
  });
});

describe('Stufe 2 — the tab knows its project (J1/J4)', () => {
  it('the start answer sets the project; „none" on a fresh start stays \'\'; an older server changes nothing', () => {
    const w = loadClient();
    const tb = { projectId: 'p-0000abcd' };
    w.ctx.projectAdoptStart(tb, { project: { id: 'p-0000abcd', updatedAt: 1500, name: 'Demoprojekt' } }, true);
    assert.deepEqual([tb.projectId, tb._projectRun, tb._projectAt], ['p-0000abcd', 'p-0000abcd', 1500]);
    const none = { projectId: '' };
    w.ctx.projectAdoptStart(none, { project: null }, true);
    assert.equal(none.projectId, '');
    const old = { projectId: 'p-x' };
    w.ctx.projectAdoptStart(old, { chatId: 'c' }, true);
    assert.equal(old.projectId, 'p-x'); assert.equal(old._projectRun, undefined);
  });
  it('status chip „◆ X" — „geändert seit Start" only when the project is newer than the start', async () => {
    const w = loadClient();
    await w.ev('ensureProjects()');
    const run = { id: 'c1', sessionId: SA.id, projectId: 'p-0000abcd', _projectRun: 'p-0000abcd', _projectAt: 2000 };
    let c = w.ctx.projectStatusChip(run);
    assert.equal(c.textContent, '◆ Demoprojekt'); assert.ok(!c.classList.contains('cs-proj-changed'));
    run._projectAt = 1000;
    c = w.ctx.projectStatusChip(run);
    assert.ok(c.classList.contains('cs-proj-changed')); assert.match(c.textContent, /chipGeaendert/);
    assert.equal(w.ctx.projectStatusChip({ projectId: undefined }), null);
    assert.ok(!/promptSnapshotFresh/.test(liftFn(STATUS_SRC, 'renderStatusBar', 'chat-status.js')), 'the effect note is computed in the render');
  });
  it('an UNSTARTED tab: the pick is only the tab\'s value — no POST, no restart', async () => {
    const w = loadClient();
    const tb = { title: 'Neuer Chat' };
    await w.ctx.assignTabProject(tb, 'p-0000abcd');
    assert.equal(tb.projectId, 'p-0000abcd'); assert.equal(posts(w).length, 0); assert.equal(w.rec.restart.length, 0);
  });
  it('a RUNNING session: POST, then the restart (after the cache question); a dormant one: POST, no restart', async () => {
    const w = loadClient();
    const run = { id: 'c1', sessionId: SA.id, ctxTokens: 12000 };
    w.ctx.TABS.push(run);
    await w.ctx.assignTabProject(run, 'p-0000abcd');
    assert.deepEqual(posts(w)[0][1], { sessionIds: [SA.id], projectId: 'p-0000abcd' });
    assert.equal(run.projectId, 'p-0000abcd', 'the open tab follows the label');
    assert.equal(w.rec.restart.length, 1); assert.equal(run._projectNote, 'projects.anweisungenWirkStart');
    const dorm = { pending: { sessionId: SB.id } };
    await w.ctx.assignTabProject(dorm, '');
    assert.equal(posts(w).length, 2); assert.equal(w.rec.restart.length, 1);
  });
  it('the tab menu\'s FIRST entry names the project and opens the same popover', async () => {
    const w = loadClient();
    await w.ev('ensureProjects()');
    const src = liftFn(CHAT, 'openTabMenu', 'chat.js');
    // every other neighbour of the menu is a harmless stub here; the project entry is what is under test
    for (const n of new Set([...src.matchAll(/\b([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]))) {
      if (!['function', 'if', 'add', 'sep', 'fn', 'String', 'Number', 'Object', 'Boolean'].includes(n) && w.ev('typeof ' + n) === 'undefined') w.ctx[n] = () => '';
    }
    w.ctx.closeTabMenu = () => { const m = w.dom.doc.body.querySelector('#tabMenu'); if (m) m.remove(); };
    w.dom.El.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
    w.ctx.window.innerWidth = 1200; w.ctx.window.innerHeight = 800;
    vm.runInContext(src, w.ctx);
    const tb = { uid: 1, projectId: 'p-0000abcd', tabEl: w.dom.el('div'), addDirs: [], msgEl: { childElementCount: 0 } };
    w.ctx.openTabMenu(tb, 0, 0);
    const first = w.dom.doc.body.querySelector('#tabMenu').querySelectorAll('.ctx-item')[0];
    assert.equal(first.textContent, 'de:projects.tabMenuProjekt');
    first.onclick();
    await settle();
    assert.ok(picker(w), 'the tab menu entry opened no popover');
  });
});

describe('Stufe 2 — resuming a project session takes its start values VISIBLY (J6) — and J10', () => {
  it('extra folders, agent, model, effort, mode: on the tab AND in the selectors before the start; MCP and cwd stay', async () => {
    const w = loadClient();
    const tb = { uid: 1, title: 'Neuer Chat' }; w.ctx.ACTIVE = tb;
    await w.ctx.resumeSession(Object.assign({}, SA), false);
    const st = w.rec.started[0];
    assert.equal(st.tab, tb);
    assert.deepEqual(st.extra, { resume: SA.id, cwd: 'C:\\w', fork: false });
    assert.deepEqual([st.seen.addDirs, st.seen.agent, st.seen.projectId], [['C:\\Users\\x\\repo'], 'reviewer', 'p-0000abcd']);
    assert.deepEqual(st.dom, { model: 'opus[1m]', effort: 'high', mode: 'acceptEdits' }, 'the selectors (read by the start) did not show the copy');
    assert.equal(st.seen.mcpServers, undefined, 'the session\'s stored MCP choice must stay authoritative');
    assert.ok(w.calls.toast.some((x) => x[0] === 'de:projects.resumeUebernommen'), 'no toast says what was taken over');
  });
  it('never a bypass mode; nothing for a deliberate „none" or an undecided session', async () => {
    const w = loadClient({ projects: [Object.assign(P2(), { permissionMode: 'bypassPermissions' })] });
    w.ctx.ACTIVE = { uid: 1, title: 'Neuer Chat' };
    await w.ctx.resumeSession(Object.assign({}, SA), false);
    assert.notEqual(w.rec.started[0].dom.mode, 'bypassPermissions');
    for (const s of [SB, SC]) {
      const v = loadClient(); const tb = { uid: 1, title: 'Neuer Chat' }; v.ctx.ACTIVE = tb;
      await v.ctx.resumeSession(Object.assign({}, s), false);
      assert.deepEqual([tb.agent, tb.addDirs, tb.cfgTouched], [undefined, undefined, undefined], s.title);
    }
  });
  it('J10: a tab with a folder of its own is not reused by resumeSession either', async () => {
    const w = loadClient();
    const own = { uid: 1, title: 'Neuer Chat', cwd: 'C:\\Temp' }; w.ctx.ACTIVE = own;
    await w.ctx.resumeSession(Object.assign({}, SC), false);
    assert.notEqual(w.rec.started[0].tab, own);
    const main = { uid: 2, title: 'Neuer Chat', cwd: 'c:/windows/system32' }; w.ctx.ACTIVE = main;
    await w.ctx.resumeSession(Object.assign({}, SC), false);
    assert.equal(w.rec.started[1].tab, main, 'the main folder in another spelling is no folder of its own');
  });
});

describe('Stufe 2 — J14: the sessions list reads the folder rules and hideInAll', () => {
  const HIDE = { id: 'p-0000beef', name: 'Atlas', hue: 30, hideInAll: true, warnings: [] };
  const SD = { id: 'dddddddd-1111-4111-8111-111111111111', title: 'Delta', preview: '', summary: '', projectPath: 'C:\\w', projectId: null, projectDerived: 'p-0000abcd' };
  const SH = { id: 'eeeeeeee-1111-4111-8111-111111111111', title: 'Eps', preview: '', summary: '', projectPath: 'C:\\a', projectId: null, projectDerived: 'p-0000beef' };
  const SX = { id: 'ffffffff-1111-4111-8111-111111111111', title: 'Phi', preview: '', summary: '', projectPath: 'C:\\w', projectId: '', projectDerived: 'p-0000abcd' };
  it('a rule-only session: dashed „per Regel" chip, listed under its project; \'\' (deliberately none) beats the rule', async () => {
    const w = loadClient();
    await w.ev('ensureProjects()');
    const c = w.ctx.sessProjChip(SD);
    assert.ok(c.classList.contains('derived')); assert.equal(c.textContent, '◆ Demoprojekt · de:projects.siPerRegel');
    assert.ok(w.ctx.sessProjChip(SX).classList.contains('none'), 'a deliberate „none" got the rule\'s label');
    w.ctx.SESSIONS = [SA, SD, SX];
    const ids = (pf) => { w.ev('SESS_PROJ_FILTER = ' + JSON.stringify(pf)); return plain(w.ctx.visibleSessions().map((s) => s.title)); };
    assert.deepEqual(ids('p-0000abcd'), ['Alpha', 'Delta']);
    assert.deepEqual(ids('none'), ['Phi']);
    assert.deepEqual(plain(w.ctx.sessProjFilterRow().querySelectorAll('.proj-filter-chip').map((x) => x.dataset.pf)), ['all', 'p-0000abcd', 'none']);
  });
  it('hideInAll: out of „Alle" (counted for the hint), in its own filter — explicit and rule alike', async () => {
    const w = loadClient({ projects: [P2(), HIDE] });
    await w.ev('ensureProjects()');
    w.ctx.SESSIONS = [SA, SH, Object.assign({}, SC, { projectId: 'p-0000beef' })];
    const ids = (pf) => { w.ev('SESS_PROJ_FILTER = ' + JSON.stringify(pf)); return plain(w.ctx.visibleSessions().map((s) => s.title)); };
    assert.deepEqual(ids('all'), ['Alpha']);
    assert.equal(w.ctx.sessHiddenCount(''), 2);
    assert.equal(w.ctx.sessHiddenCount('eps'), 1, 'the hint counts what the search would show');
    assert.deepEqual(ids('p-0000beef'), ['Eps', 'Gamma']);
  });
  it('a rule never steers the start: resuming a rule-only session takes no project start values (J6 is explicit only)', async () => {
    const w = loadClient();
    const tb = { uid: 1, title: 'Neuer Chat' }; w.ctx.ACTIVE = tb;
    await w.ctx.resumeSession(Object.assign({}, SD), false);
    const st = w.rec.started[0];
    assert.equal(st.seen.projectId, undefined); assert.equal(st.seen.agent, undefined); assert.equal(st.seen.addDirs, undefined);
    assert.notEqual(st.dom.model, 'opus[1m]');
    assert.ok(!w.calls.toast.some((x) => /resumeUebernommen/.test(x[0])), 'a toast claimed values were taken over');
  });
});

describe('Stufe 2 — J7: deleting a project lets go of it in the open tabs', () => {
  it('after the delete succeeded the open tabs drop the id (an unstarted one would start with an unknown project)', async () => {
    const w = loadClient();
    await w.ev('ensureProjects()');
    const mine = { uid: 1, projectId: 'p-0000abcd' }, other = { uid: 2, projectId: 'p-other' };
    w.ctx.TABS.push(mine, other);
    await w.ctx.deleteProjectUi(P2());
    assert.deepEqual([mine.projectId, other.projectId], [undefined, 'p-other']);
  });
});
describe('Stufe 2 — J7: a restored tab whose project was deleted meanwhile', () => {
  it('says „gelöschtes Projekt" once the list is loaded — „…" before, never the old name', async () => {
    const w = loadClient();
    const tb = { projectId: 'p-gone', _projectRun: 'p-gone', _projectAt: 1, pending: { sessionId: SA.id } };
    assert.equal(w.ctx.projectStatusChip(tb).textContent, '◆ …');
    await w.ev('ensureProjects()');
    assert.equal(w.ctx.projectStatusChip(tb).textContent, '◆ de:projects.chipGeloescht');
    w.ctx.projectAdoptStart(tb, { project: null }, false); // its resume: the server knows no project → it falls away
    assert.equal(tb.projectId, undefined);
  });
});

// ===============================================================================================================
// P-2 Teil 1b — the cockpit on the page, the tile figures and „Nicht zugeordnet" (data: GET /api/projects/overview)
// ===============================================================================================================
describe('P-2 cockpit — the sections, the suggestions, the bulk assignment, safe links', () => {
  const PID = 'p-0000abcd';
  const OV_PAGE = () => ({
    ok: true, estimate: true, window: { days: 30, from: '2026-09-07' },
    projects: [{ id: PID, name: 'Demoprojekt', sessions: 3, explicitSessions: 2, derivedSessions: 1, cost: 12.5, recentCost: 4.25, tokens: 9,
      top: [{ id: SID(1), title: 'Teuer', cost: 10, recentCost: 4, tokens: 5, mtime: 1, derived: true }] }],
    recent: [{ id: SID(1), title: 'Teuer', mtime: 1, derived: false, lastPrompt: 'mach weiter mit S3', lastPromptAt: 2, lastText: 'S3 ist fertig', lastTextAt: 3, recap: '', recapAt: null }],
    plans: [{ name: 'alpha-plan.md', title: 'Alpha', teaser: 'Kurz', mtime: 4, sessionIds: [SID(1)], derived: false }],
    suggestions: [
      { id: SID(2), title: 'Vorschlag A', cost: 3, mtime: 5, strength: 'strong', reasons: [{ reason: 'plan', plan: 'alpha-plan.md' }] },
      { id: SID(3), title: 'Vorschlag B', cost: 1, mtime: 6, strength: 'weak', reasons: [{ reason: 'jira', keys: ['ACME-77'], mentions: 2 }] },
    ],
  });
  const OV_ALL = () => ({
    ok: true, estimate: true, window: { days: 30 },
    projects: [{ id: PID, name: 'Demoprojekt', recentCost: 4.25, cost: 12.5, suggestCount: 2 }],
    unassigned: { sessions: 2, cost: 9, recentCost: 2, tokens: 9, top: [
      { id: SID(5), title: 'Frei 1', cost: 6, recentCost: 1, tokens: 4, mtime: 1, suggest: [{ projectId: PID, strength: 'strong', reasons: [{ reason: 'path' }] }] },
      { id: SID(6), title: 'Frei 2', cost: 3, recentCost: 1, tokens: 5, mtime: 2, suggest: [] },
    ] },
  });
  const world = (ov, folds) => pageWorld({
    folds,
    projects: [Object.assign(PROJECT(), { updatedAt: 1000, paths: ['C:\\Atlas*'], jiraKeys: ['ACME-77', 'PROJ-456'], hideInAll: true })],
    api: (p, opt) => (p.startsWith('/api/projects/overview') ? ((ov && ov(p)) || (p.includes('?id=') ? OV_PAGE() : OV_ALL())) : (p === '/api/projects' && opt && opt.method === 'POST' ? { project: Object.assign(PROJECT(), JSON.parse(opt.body).project), created: false } : opt && opt.method === 'POST' ? { ok: true } : null)),
  });
  const posts = (w) => w.calls.api.filter(([p]) => p === '/api/projects/assign').map(([, b]) => b);
  const txt = (w) => w.nodes['#projBody'].textContent;

  it('the page renders every cockpit section from the overview: last state (Du + Claude), plans, cost as an estimate, suggestions, rules', async () => {
    const w = world(null, { plans: true, rules: true });
    w.ctx.projOpen(PID); await settle();
    assert.ok(w.calls.api.some(([p]) => p === '/api/projects/overview?id=' + PID), 'the page did not ask for its overview');
    for (const k of ['letzterStand', 'plaene', 'plaeneHinweis', 'kosten', 'kosten30', 'kostenGesamt', 'vorschlaege', 'zuordnungRegeln', 'stark', 'schwach', 'perRegel', 'fInAlleAusblenden']) {
      assert.ok(txt(w).includes('de:projects.' + k), k + ' missing');
    }
    assert.ok(txt(w).includes('mach weiter mit S3') && txt(w).includes('S3 ist fertig'), 'the last prompt and the last answer are not shown');
    assert.ok(txt(w).includes('de:projects.du') && txt(w).includes('Claude') && txt(w).includes('de:projects.quelle'), 'who said it / the source is missing');
    assert.ok(byFk(w, 'plan-open:alpha-plan.md'), 'a plan cannot be opened');
  });
  it('a cold read shows a running status line (role=status), never an empty area; a failed one says so with a retry', async () => {
    let hold = true;
    const w = world((p) => (hold ? new Promise(() => {}) : null));
    w.ctx.projOpen(PID); await settle();
    const ld = w.nodes['#projBody'].querySelector('.pd-ov-loading');
    assert.ok(ld && ld.getAttribute('role') === 'status', 'no loading status while the overview is read');
    assert.ok(ld.querySelector('[data-ov-since]'), 'the seconds are not shown');
    const w2 = world(() => Object.assign(new Error('kaputt'), { status: 500 }));
    w2.ctx.projOpen(PID); await settle();
    const er = w2.nodes['#projBody'].querySelector('.pd-ov-err');
    assert.ok(er && er.textContent.includes('kaputt') && er.getAttribute('role') === 'alert');
    assert.ok(byFk(w2, 'ov-retry:' + PID), 'no retry');
    hold = false;
  });
  it('✓ assigns explicitly, ✕ writes "" (deliberately without), „alle" posts every listed suggestion in ONE call', async () => {
    let w = world();
    w.ctx.projOpen(PID); await settle();
    await byFk(w, 'sug-ok:' + SID(2)).onclick({ stopPropagation() {} });
    assert.deepEqual(posts(w), [{ sessionIds: [SID(2)], projectId: PID }]);
    w = world(); w.ctx.projOpen(PID); await settle();
    await byFk(w, 'sug-no:' + SID(3)).onclick({ stopPropagation() {} }); await settle();
    assert.deepEqual(posts(w), [{ sessionIds: [SID(3)], projectId: '' }]);
    assert.ok(w.calls.toast.some(([m]) => m === 'de:projects.bewusstOhne'), JSON.stringify(w.calls.toast));
    w = world(); w.ctx.projOpen(PID); await settle();
    await byFk(w, 'sug-all').onclick();
    assert.deepEqual(posts(w), [{ sessionIds: [SID(2), SID(3)], projectId: PID }]);
  });
  it('a decided row leaves the list at once — the stale answer on screen does not offer it again', async () => {
    const w = world(() => (w && w.__hold ? new Promise(() => {}) : null));
    w.ctx.projOpen(PID); await settle();
    w.__hold = true;
    await byFk(w, 'sug-ok:' + SID(2)).onclick({ stopPropagation() {} });
    await settle();
    assert.equal(byFk(w, 'sug-ok:' + SID(2)), null, 'the accepted suggestion is still offered');
    assert.ok(byFk(w, 'sug-ok:' + SID(3)), 'the other suggestion vanished too');
  });
  it('tiles: 30-day cost labelled as an estimate and the „n Vorschläge" badge; „Nicht zugeordnet": ticked rows go in ONE POST', async () => {
    const w = world();
    w.ctx.renderProjects(); await settle();
    assert.ok(txt(w).includes('de:projects.kachelKosten') && txt(w).includes('de:projects.nVorschlaege'), 'tile figures missing');
    assert.ok(txt(w).includes('de:projects.nichtZugeordnet'), 'no „Nicht zugeordnet" section');
    unfold(w, 'free');
    for (const n of [5, 6]) { const cb = byFk(w, 'free-cb:' + SID(n)); cb.checked = true; cb.onchange(); }
    const go = byFk(w, 'free-go');
    assert.equal(go.disabled, false);
    await go.onclick();
    assert.deepEqual(posts(w), [{ sessionIds: [SID(5), SID(6)], projectId: PID }]);
    // a row's own suggestion is a single ✓
    const w2 = world(null, { free: true }); w2.ctx.renderProjects(); await settle();
    await byFk(w2, 'free-ok:' + SID(5)).onclick({ stopPropagation() {} });
    assert.deepEqual(posts(w2), [{ sessionIds: [SID(5)], projectId: PID }]);
  });
  it('Jira keys are links to jira.example.com over https with rel=noopener — anything else stays text', async () => {
    const w = world(null, { rules: true });
    w.ctx.projOpen(PID); await settle();
    const links = w.nodes['#projBody'].querySelectorAll('a.proj-jira');
    assert.deepEqual(links.map((a) => a.href), ['https://jira.example.com/browse/ACME-77', 'https://jira.example.com/browse/PROJ-456']);
    for (const a of links) { assert.match(a.rel, /noopener/); assert.equal(a.target, '_blank'); }
    for (const bad of ['javascript:alert(1)', 'ACME-1"><b', 'PR-12', 'https://evil.example/ACME-1']) {
      const n = w.ctx.projJiraLink(bad);
      assert.equal(n.tagName, 'SPAN', bad + ' became a link');
    }
  });
  // ---- P1 (07.10.) — the layout: foldable sections, two columns, capped lists, the cockpit actions ----------------
  const FREE_MANY = () => Object.assign(OV_ALL(), { unassigned: { sessions: 284, cost: 90, recentCost: 20, tokens: 9,
    top: Array.from({ length: 20 }, (_, i) => ({ id: SID(1).slice(0, -3) + String(100 + i), title: 'Frei ' + i, cost: 30 - i, recentCost: 1, tokens: 4, mtime: i, project: 'C--x', projectPath: 'C:\\x', projectId: null, plan: null, suggest: [] })) } });
  it('„Nicht zugeordnet" starts CLOSED without a single row, its head says what is in it; open: 10 rows + „Weitere", remembered', async () => {
    const w = world(() => FREE_MANY());
    w.ctx.renderProjects(); await settle();
    const d = fold(w, 'free');
    assert.equal(d.open, false, 'open by default');
    assert.equal(d.querySelectorAll('.pd-free-row').length, 0, 'rows were built for a closed section');
    assert.match(d.querySelector('h3').textContent, /\(284\)$/);
    assert.ok(d.querySelector('summary .pd-fold-sum').textContent.includes('de:projects.freiKurz'), 'no summary in the head');
    assert.equal(d.querySelector('summary').dataset.fk, 'sec-free', 'the fk anchor is not on the head');
    unfold(w, 'free');
    assert.equal(d.querySelectorAll('.pd-free-row').length, 10);
    assert.ok(byFk(w, 'more:free'), 'no „Weitere n zeigen"');
    const bar = d.querySelector('.pd-bulk'), first = d.querySelector('.pd-free-row');
    const kids = d.querySelector('.pd-fold-body').children;
    assert.ok(kids.indexOf(bar) < kids.indexOf(first), 'the bulk bar is not above the rows');
    assert.equal(first.title, SID(1).slice(0, -3) + '100', 'the id is not in the tooltip');
    assert.ok(!first.querySelector('.uct-sum').textContent.includes(first.title.slice(0, 8)), 'the id is still printed in the row');
    // „Alle auswählen" ticks the rows on screen, in place
    const all = byFk(w, 'free-all'); all.checked = true; all.onchange();
    assert.equal(w.ev('PROJ_BULK.size'), 10);
    assert.ok(d.querySelectorAll('.pd-free-row input').every((cb) => cb.checked));
    byFk(w, 'more:free').onclick();
    assert.equal(fold(w, 'free').querySelectorAll('.pd-free-row').length, 20);
    assert.equal(byFk(w, 'more:free'), null, 'all 20 are shown — no „Weitere" left');
    assert.equal(fk(w), 'free-cb:' + SID(1).slice(0, -3) + '110', 'the caret did not go to the first new row');
    assert.equal(JSON.parse(w.store.get('cc_proj_folds')).free, true, 'the open state is not remembered');
    unfold(w, 'free', false);
    assert.equal(JSON.parse(w.store.get('cc_proj_folds')).free, false);
  });
  it('the page: two columns, the sections in the planned order, open / closed by default, summaries in the heads', async () => {
    const w = world();
    w.ctx.planCounts = (pl) => ({ total: pl.steps.length, done: 0, index: 1 });
    w.env.TABS.push({ uid: 7, title: 'Plan-Tab', projectId: PID, sessionId: SID(1), plan: { state: 'active', steps: [{ title: 'a' }, { title: 'b' }] } });
    w.ctx.projOpen(PID); await settle();
    const col = (c) => w.nodes['#projBody'].querySelector('.pd-cols .' + c).children.map((n) => n.dataset.key + ':' + (n.open ? 'auf' : 'zu'));
    assert.deepEqual(col('pd-col-work'), ['last:auf', 'liveplan:auf', 'tabs:auf', 'sug:auf', 'sessions:zu']);
    assert.deepEqual(col('pd-col-ctx'), ['cost:auf', 'repos:auf', 'plans:zu', 'rules:zu', 'instr:zu']); // P4: Repos & PRs after Kosten
    const sum = (k) => fold(w, k).querySelector('.pd-fold-sum').textContent;
    assert.ok(sum('cost').includes('de:projects.kostenKurz') && sum('rules').includes('de:projects.zuordnungKurz') && /de:projects\.(keine|nZeichen)$/.test(sum('instr')), 'a head without its summary');
    assert.equal(fold(w, 'plans').querySelectorAll('.pd-row').length, 0, 'a closed section drew its rows');
    // the head: Neuer Chat (primary, labelled), ✎ and 🗑 as icons; the chips come after the head row
    const acts = w.nodes['#projBody'].querySelector('.pd-head-top .pd-acts').children.map((b) => b.dataset.fk);
    assert.deepEqual(acts, ['act-chat', 'act-report', 'act-edit', 'act-del'], 'P2: „Bericht kopieren" between Neuer Chat and ✎ (no start orders here)');
    assert.equal(byFk(w, 'act-edit').textContent, '', '✎ is an icon button');
    assert.equal(byFk(w, 'act-edit').title, 'de:projects.bearbeiten', 'an icon button needs its tooltip');
  });
  it('a CLOSED section takes the caret on its head — also when its content was drawn before it was closed', async () => {
    const w = pageWorld({ sessions: [{ id: SID(1), title: 'A', projectId: PID, projectPath: 'C:\\x', mtime: 1 }] });
    vm.runInContext('PROJ_VIEW.sel = "' + PID + '"; PROJ_VIEW.focus = ["sess-pick", "sec-sessions"]', w.ctx);
    w.ctx.renderProjects();
    assert.equal(fk(w), 'sec-sessions');
    assert.equal(w.dom.doc.activeElement.tagName, 'SUMMARY');
    unfold(w, 'sessions'); unfold(w, 'sessions', false); // drawn, then closed: [Sitzung zuordnen…] exists but is hidden
    assert.ok(byFk(w, 'sess-pick'), 'premise: the content is still in the DOM');
    w.ctx.projFocusFk(w.nodes['#projBody'], ['sess-pick', 'sec-sessions']);
    assert.equal(fk(w), 'sec-sessions', 'the caret went to a control inside a closed section — lost in a browser');
  });
  it('„Letzter Stand": the newest in full, the two before it as one-liners that open; ▶ / Transkript / Plan from the row', async () => {
    const r = (n, extra) => Object.assign({ id: SID(n), title: 'S' + n, mtime: 10 - n, derived: false, project: 'C--x', projectPath: 'C:\\x', projectId: PID, plan: null, lastPrompt: 'P' + n, lastPromptAt: 1, lastText: 'T' + n, lastTextAt: 2, recap: '', recapAt: null }, extra);
    const w = world((p) => (p.includes('?id=') ? Object.assign(OV_PAGE(), { recent: [r(1, { plan: 'alpha-plan.md' }), r(2), r(3)] }) : null));
    const seen = { resume: [], transcript: [], plan: [], side: [] };
    w.ctx.resumeSession = (s, fork) => seen.resume.push([plain(s), fork]);
    w.ctx.openTranscript = (s) => seen.transcript.push(plain(s));
    w.ctx.openPlan = (x) => seen.plan.push(plain(x));
    w.ctx.planShowSidecar = (tb, pl) => seen.side.push([tb.uid, pl.state]);
    w.ctx.projOpen(PID); await settle();
    const box = fold(w, 'last').querySelector('.pd-fold-body');
    assert.deepEqual(box.children.map((n) => n.className), ['pd-last', 'pd-last-old', 'pd-last-old']);
    assert.ok(!box.children[1].open, 'an older one is open from the start');
    await byFk(w, 'last-r:' + SID(1)).onclick({ stopPropagation() {} });
    assert.deepEqual(seen.resume, [[{ id: SID(1), project: 'C--x', projectPath: 'C:\\x', title: 'S1', projectId: PID }, false]], '▶ is not a plain resume');
    assert.equal(w.calls.api.filter(([p]) => p === '/api/projects/assign').length, 0, 'Fortsetzen labelled the session');
    byFk(w, 'last-t:' + SID(1)).onclick({ stopPropagation() {} });
    assert.deepEqual([w.calls.showView.at(-1), seen.transcript[0].project], ['sessions', 'C--x']);
    assert.equal(byFk(w, 'last-p:' + SID(2)), null, '[Plan] without a plan');
    byFk(w, 'last-p:' + SID(1)).onclick({ stopPropagation() {} });
    assert.deepEqual(seen.plan, [{ name: 'alpha-plan.md', title: 'Alpha' }], 'without a live tab: the plan file');
    w.env.TABS.push({ uid: 8, title: 'Live', sessionId: SID(1), plan: { state: 'active', steps: [{ title: 'a' }] } });
    byFk(w, 'last-p:' + SID(1)).onclick({ stopPropagation() {} });
    assert.deepEqual(seen.side, [[8, 'active']], 'a live tab of the session shows its plan in the sidecar');
    // the cost top 5 and the suggestions carry the actions too (icons there)
    assert.ok(byFk(w, 'cost-r:' + SID(1)) && byFk(w, 'cost-t:' + SID(1)) && byFk(w, 'sug-t:' + SID(2)));
    assert.equal(byFk(w, 'sug-r:' + SID(2)), null, 'a suggestion is not resumed from here');
  });
  it('the editor carries the three fields: folder rules, Jira keys, „in Alle ausblenden" — and saves them', async () => {
    const w = world();
    w.ctx.openProjectEditor(w.ev('PROJECTS_DATA')[0]); await settle();
    const box = w.ev('PROJ_DRAFT').box;
    for (const k of ['paths', 'jiraKeys']) assert.ok(box.querySelector('[data-pk="' + k + '"]'), k + ' has no input');
    for (const k of ['regelnEditorHinweis', 'jiraEditorHinweis', 'hideInAllHinweis']) assert.ok(box.textContent.includes('de:projects.' + k), k + ' hint missing');
    const hide = box.querySelector('[data-pk="hideInAll"]'); hide.checked = false; hide.onchange();
    await box.querySelector('[data-pk="save"]').onclick();
    const save = w.calls.api.find(([p, b]) => p === '/api/projects' && b);
    assert.deepEqual(save[1].project.hideInAll, false);
    assert.equal(save[1].project.paths, undefined, 'an unchanged field was sent (projDraftPatch)');
  });
});

// ===============================================================================================================
// P2 (07.10.) — start orders, project knowledge, the report
describe('P2 — Startaufträge: one click opens the chat AND sends the order', () => {
  const PID = 'p-0000abcd';
  const ORDERS = [{ label: 'Stand prüfen', prompt: 'Prüfe den Stand von S3' }, { label: 'Review', prompt: 'Review bitte' },
    { label: 'Tests', prompt: 'Lauf die Tests' }, { label: 'Vierter', prompt: 'vier' }];
  const sendWorld = (o) => {
    o = o || {};
    const sent = [];
    const w = pageWorld(Object.assign({
      projects: [Object.assign(PROJECT(), { updatedAt: 1000, sessionCount: 0, assignedCount: 0, starters: ORDERS }, o.project || {})],
      env: Object.assign({ sendMessage: async (x) => { sent.push({ text: x.text, tab: x.tab, title: x.tab.title, def: x.tab.defaultTitle }); } }, o.env || {}),
    }, o.world || {}));
    return { w, sent };
  };
  it('the page: every order between Neuer Chat and „Bericht kopieren"; a click sends exactly once, into the NEW tab', async () => {
    const { w, sent } = sendWorld();
    w.ctx.projOpen(PID); await settle();
    const acts = w.nodes['#projBody'].querySelector('.pd-head-top .pd-acts').children.map((b) => b.dataset.fk);
    assert.deepEqual(acts, ['act-chat', 'act-start:0', 'act-start:1', 'act-start:2', 'act-start:3', 'act-report', 'act-edit', 'act-del']);
    const b = byFk(w, 'act-start:0');
    assert.equal(b.textContent, 'Stand prüfen', 'the label is the visible word');
    assert.match(b.title, /projects\.startauftragTooltip/);
    await b.onclick({ stopPropagation() {}, currentTarget: b }); await settle();
    assert.equal(sent.length, 1, 'not exactly one sendMessage');
    assert.equal(sent[0].text, 'Prüfe den Stand von S3');
    assert.equal(sent[0].tab, w.env.TABS[w.env.TABS.length - 1], 'sent into another tab than the one it opened');
    assert.equal(w.calls.made, 1);
    assert.equal(sent[0].title, 'Stand prüfen', 'the tab is not named by the label when the order goes out');
    assert.equal(sent[0].def, false, 'the label must survive the send (setTabTitle would replace a placeholder with the prompt)');
    assert.equal(sent[0].tab.projectId, PID);
    assert.equal(w.calls.activated.length, 1, 'the start values are applied before the send, through the one activateTab');
  });
  it('„gesendet" only once it went — a cancelled send (sensitive-data question) puts the order into the composer instead', async () => {
    const box = {};
    const env = { activateTab: (tb) => { box.w.env.ACTIVE = tb; }, composerSet: (x) => { box.set = x; } };
    // sendMessage that returns without sending (what the cancelled uiConfirm does): _lastSent stays as it was
    const quiet = sendWorld({ env: Object.assign({ sendMessage: async () => {} }, env) });
    box.w = quiet.w;
    await quiet.w.ctx.projRunStarter(quiet.w.ev('PROJECTS_DATA')[0], 0, null); await settle();
    assert.equal(box.set, 'Prüfe den Stand von S3', 'the order is gone');
    assert.ok(quiet.w.calls.toast.some(([m, k]) => k === 'warn' && /startauftragNichtGesendet/.test(m)), JSON.stringify(quiet.w.calls.toast));
    assert.ok(!quiet.w.calls.toast.some(([m]) => /startauftragToast/.test(m)), 'claimed „gesendet" for nothing sent');
    // a real send records _lastSent → the ok toast, the composer untouched
    box.set = undefined;
    const real = sendWorld({ env: Object.assign({ sendMessage: async (x) => { x.tab._lastSent = { text: x.text }; } }, env) });
    box.w = real.w;
    await real.w.ctx.projRunStarter(real.w.ev('PROJECTS_DATA')[0], 0, null); await settle();
    assert.equal(box.set, undefined);
    assert.ok(real.w.calls.toast.some(([m, k]) => k === 'ok' && /startauftragToast/.test(m)), JSON.stringify(real.w.calls.toast));
  });
  it('the tile shows at most 3; a double click while the start is on its way opens no second tab', async () => {
    let release;
    const held = new Promise((r) => { release = r; });
    const { w, sent } = sendWorld({ env: { sendMessage: async (x) => { sent.push(x); await held; } } });
    w.ctx.renderProjects();
    const tile = w.nodes['#projBody'].querySelector('[data-fk="tile:' + PID + '"]');
    assert.deepEqual(tile.querySelectorAll('.pd-starter').map((x) => x.dataset.fk), ['tile-start:' + PID + ':0', 'tile-start:' + PID + ':1', 'tile-start:' + PID + ':2']);
    const b = byFk(w, 'tile-start:' + PID + ':1');
    const first = b.onclick({ stopPropagation() {}, currentTarget: b });
    await settle();
    assert.equal(b.disabled, true, 'the order button is not busy while its message goes out');
    assert.equal(await w.ctx.projRunStarter(w.ev('PROJECTS_DATA')[0], 1, b), null, 'a second click opened a second chat');
    release(); await first;
    assert.equal(sent.length, 1); assert.equal(w.calls.made, 1);
    assert.equal(b.disabled, false);
  });
  it('Abbrechen at a question before the start sends NOTHING and opens nothing', async () => {
    const { w, sent } = sendWorld({ project: { warnings: [{ code: 'path-unchecked', field: 'addDirs', value: 'Z:/tot' }], addDirs: ['Z:/tot'] }, world: { modal: () => 'cancel' } });
    const tab = await w.ctx.projRunStarter(w.ev('PROJECTS_DATA')[0], 0, null);
    await settle();
    assert.equal(tab, null);
    assert.equal(sent.length, 0, 'a cancelled start sent its order');
    assert.equal(w.calls.made, 0);
  });
  it('a plain „Neuer Chat" still sends nothing and keeps the project name as a replaceable placeholder', async () => {
    const { w, sent } = sendWorld();
    const tab = await w.ctx.newChatInProject(w.ev('PROJECTS_DATA')[0]); await settle();
    assert.equal(sent.length, 0);
    assert.equal(tab.title, 'Demoprojekt'); assert.equal(tab.defaultTitle, true);
  });
  it('palette: „Startauftrag: <Projekt> · <Label>" per order, and running it starts that order', () => {
    const m = /^function cmdkCommands\(\)[\s\S]*?^\}/m.exec(COMMANDS)[0];
    const ran = [];
    const env = {
      t: (k) => '«' + k + '»', $: () => ({ value: '', onclick: () => {} }), showView: () => {}, openGlobalSearch: () => {}, openModelCompare: () => {},
      openUiSkill: () => {}, insertSnippet: () => {}, savePromptFromComposer: () => {}, openPromptManager: () => {}, openPromptHistory: () => {},
      composerSet: () => {}, resumeSession: () => {}, isFav: () => false, PALETTE_VIEWS: [], UISKILLS_DATA: [], sortedPrompts: () => [],
      SNIPPETS: () => [], allChatCommands: () => [], SESSIONS: [],
      PROJECTS_DATA: [{ id: PID, name: 'Demoprojekt', archived: false, starters: ORDERS.slice(0, 2) }],
      newChatInProject: () => ran.push('chat'), projRunStarter: (p, i, trig, label) => ran.push([p.id, i, trig, label]),
    };
    const build = new Function(...Object.keys(env), m + '\nreturn cmdkCommands;')(...Object.values(env));
    const mine = build().filter((c) => c.group === '«projects.paletteGruppe»');
    assert.deepEqual(mine.map((c) => c.label), ['«projects.paletteNeuerChat»Demoprojekt', '«projects.paletteStartauftrag»', '«projects.paletteStartauftrag»']);
    const real = new Function(...Object.keys(env), m + '\nreturn cmdkCommands;')(...Object.values(Object.assign({}, env, { t: (k) => I18N.de[k] || k })));
    assert.deepEqual(real().filter((c) => /^Startauftrag/.test(c.label)).map((c) => c.label), ['Startauftrag: Demoprojekt · Stand prüfen', 'Startauftrag: Demoprojekt · Review']);
    mine[2].run();
    assert.deepEqual(ran, [[PID, 1, null, 'Review']]);
  });
  it('the editor: rows with label + prompt, copied deep, saved as sent; blank rows dropped', async () => {
    const { w } = sendWorld({ world: { api: (p, opt) => (p === '/api/projects' && opt && opt.method === 'POST' ? { project: Object.assign(PROJECT(), JSON.parse(opt.body).project), created: false } : null) } });
    const stored = w.ev('PROJECTS_DATA')[0];
    w.ctx.openProjectEditor(stored); await settle();
    const d = w.ev('PROJ_DRAFT');
    const box = d.box;
    assert.ok(box.querySelector('[data-pk="starters"][data-idx="l0"]') && box.querySelector('[data-pk="starters"][data-idx="p0"]'), 'no label / prompt field');
    const lab = box.querySelector('[data-pk="starters"][data-idx="l0"]'); lab.value = 'Stand prüfen!'; lab.oninput();
    assert.equal(stored.starters[0].label, 'Stand prüfen', 'typing in the editor edited the stored record (shallow copy)');
    box.querySelector('[data-pk="starters-add"]').onclick();
    await box.querySelector('[data-pk="save"]').onclick();
    const save = w.calls.api.find(([p, b]) => p === '/api/projects' && b);
    assert.equal(save[1].project.starters.length, 4, 'the blank new row was sent');
    assert.equal(save[1].project.starters[0].label, 'Stand prüfen!');
  });
});

describe('P2 — Projektwissen: the section, [Öffnen], „fehlt"', () => {
  const PID = 'p-0000abcd';
  const OV = () => ({ ok: true, estimate: true, window: { days: 30 }, projects: [{ id: PID, name: 'Demoprojekt', sessions: 0, cost: 0, recentCost: 0, top: [] }], recent: [], plans: [], suggestions: [],
    memoryProject: 'C--WINDOWS-system32',
    memory: [{ name: 'demoprojekt.md', title: 'Demoprojekt ACME-3269', description: 'Objekte, Datenmodell', type: 'project', mtime: 5, exists: true },
      { name: 'weg.md', title: 'weg', description: '', type: '', mtime: 0, exists: false }] });
  const world = (memory) => {
    const opened = [];
    const w = pageWorld({
      projects: [Object.assign(PROJECT(), { updatedAt: 1000, memory })],
      env: { openMemory: (proj, name) => opened.push([proj, name]) },
      api: (p) => (p.startsWith('/api/projects/overview') ? OV() : null),
    });
    return { w, opened };
  };
  it('between Kosten and Pläne, open; a file opens in the memory view; a gone one says „fehlt"', async () => {
    const { w, opened } = world(['demoprojekt.md', 'weg.md']);
    w.ctx.projOpen(PID); await settle();
    const col = w.nodes['#projBody'].querySelector('.pd-cols .pd-col-ctx').children.map((n) => n.dataset.key);
    assert.deepEqual(col.slice(0, 3), ['cost', 'repos', 'memory']); // P4: Repos & PRs between Kosten and Projektwissen
    const sec = fold(w, 'memory');
    assert.equal(sec.open, true);
    assert.match(sec.textContent, /de:projects\.projektwissen \(2\)/);
    assert.match(sec.textContent, /Demoprojekt ACME-3269/);
    assert.match(sec.textContent, /de:projects\.wissenFehlt/);
    assert.match(sec.textContent, /de:projects\.anweisungen(WirkStart|WirkNeu|WirkUnbelegt)/, 'the note does not say when it takes effect');
    const b = byFk(w, 'mem-open:demoprojekt.md');
    b.onclick({ stopPropagation() {} });
    assert.deepEqual(opened, [['C--WINDOWS-system32', 'demoprojekt.md']]);
    assert.ok(w.calls.showView.includes('memory'));
    assert.equal(byFk(w, 'mem-open:weg.md'), null, 'a missing file offers [Öffnen]');
  });
  it('no linked file → no section', async () => {
    const { w } = world([]);
    w.ctx.projOpen(PID); await settle();
    assert.equal(fold(w, 'memory'), null);
  });
});

describe('P2 — „Bericht kopieren": state, plans, 7 days of sessions, Jira — never a cost', () => {
  const PID = 'p-0000abcd';
  const NOW = new Date(2026, 9, 7, 12, 0).getTime();
  const DAY = 86400000;
  const OV = () => ({
    ok: true, estimate: true, window: { days: 30 }, totals: { cost: 123.45, recentCost: 123.45, sessions: 9 },
    projects: [{ id: PID, name: 'Demoprojekt', cost: 123.45, recentCost: 123.45, tokens: 12345, share: 0.123,
      top: [{ id: SID(1), title: 'Teuer', cost: 123.45, recentCost: 123.45, tokens: 1234, mtime: NOW }] }],
    recent: [{ id: SID(1), title: 'Teuer', mtime: NOW - 1000, cost: 123.45, lastPrompt: 'mach weiter', lastPromptAt: NOW - 2000, lastText: 'S3 fertig', lastTextAt: NOW - 1000, recap: '', recapAt: null }],
    plans: [{ name: 'alpha-plan.md', title: 'Alpha', mtime: NOW - DAY, cost: 123.45 }],
  });
  const SESS = [
    { id: SID(1), title: 'Heute', projectId: PID, mtime: NOW - 1000 },
    { id: SID(2), title: 'Per Regel', projectId: null, projectDerived: PID, mtime: NOW - 6 * DAY },
    { id: SID(3), title: 'Zu alt', projectId: PID, mtime: NOW - 8 * DAY },
    { id: SID(4), title: 'Fremd', projectId: 'p-00000002', mtime: NOW },
  ];
  const report = (w) => w.ctx.projReport(Object.assign(PROJECT(), { description: 'Beschreibung', jiraKeys: ['ACME-3269', 'evil" onclick'] }), OV(), SESS, NOW);
  it('carries what it should — with the REAL German strings', () => {
    const w = loadProjects({ env: { t: (k) => I18N.de[k] || k } });
    const { md, data } = report(w);
    assert.match(md, /^# Projekt „Demoprojekt“\n\nBeschreibung\n/);
    assert.match(md, /- Du: mach weiter/); assert.match(md, /- Claude: S3 fertig/);
    assert.match(md, /Alpha \(alpha-plan\.md\)/);
    assert.match(md, /## Sitzungen der letzten 7 Tage \(2\)/);
    assert.match(md, /- Heute · /); assert.match(md, /- Per Regel · .* · per Regel/);
    assert.doesNotMatch(md, /Zu alt|Fremd/, 'the 7-day window or the project filter is wrong');
    assert.match(md, /- ACME-3269 — https:\/\/jira.example.com\/browse\/ACME-3269/);
    assert.doesNotMatch(md, /onclick/, 'a key outside the allow-list became a link');
    assert.ok(data.rows.length >= 6 && data.columns[0].type === 'group');
  });
  it('NO cost, token or share anywhere — md and the rich HTML, against an overview full of them', () => {
    const w = loadProjects({ env: { t: (k) => I18N.de[k] || k } });
    const { md, data } = report(w);
    const VU = read('public/js/views-uiskills.js');
    const html = new Function(liftFn(VU, 'resultToHtml', 'views-uiskills.js') + '\nreturn resultToHtml;')()(data, 'Projekt');
    for (const out of [md, html, JSON.stringify(data)]) {
      for (const bad of ['123', '€', '$', 'Kosten', 'cost', 'Token', 'Anteil']) assert.ok(!out.includes(bad), 'the report says „' + bad + '“:\n' + out);
    }
    const src = noComments(liftFn(SRC, 'projReport', 'projects.js'));
    assert.doesNotMatch(src, /\.(cost|recentCost|tokens|share|subCost)\b/, 'projReport reads a cost field');
  });
  it('an amount Claude wrote into its own text stays out too — the sentence goes, the rest stays, the report says so', () => {
    const w = loadProjects({ env: { t: (k) => I18N.de[k] || k } });
    const ov = OV();
    ov.recent[0].lastText = 'S3 fertig. Der Lauf kostet 0,64 $. Weiter mit S4.';
    ov.recent[0].recap = 'Summe 12 EUR bisher';
    const { md } = w.ctx.projReport(PROJECT(), ov, SESS, NOW);
    assert.match(md, /- Claude: S3 fertig\. \(Satz mit Betrag ausgelassen\) Weiter mit S4\./);
    assert.match(md, /- Zusammenfassung: \(Satz mit Betrag ausgelassen\)/);
    for (const bad of ['0,64', '$', '12 EUR']) assert.ok(!md.includes(bad), 'the report says „' + bad + '“:\n' + md);
  });
  it('copy: the rich path with the full Markdown as plain text (copyResultHtml, third parameter)', async () => {
    const got = [];
    const w = pageWorld({ env: { copyResultHtml: async (data, title, text) => { got.push({ data, title, text }); } } });
    w.ctx.projOpen(PID); await settle();
    await byFk(w, 'act-report').onclick();
    assert.equal(got.length, 1);
    assert.match(got[0].text, /^# de:projects\.berichtTitel/);
    assert.ok(Array.isArray(got[0].data.rows));
    assert.match(read('public/js/views-uiskills.js'), /async function copyResultHtml\(data, title, plainText\) \{[\s\S]{0,400}typeof plainText === 'string' \? plainText : resultToMarkdown\(data\)/);
  });
});

// ===============================================================================================================
// P3 — the window switch, the figures and the activity bars under the head; the Usage view's „Ordner" wording
// ===============================================================================================================
describe('P3 — Kennzahlen, Zeitraum-Schalter und Aktivität auf der Projektseite', () => {
  const PID = 'p-0000abcd';
  const OV = (days) => ({
    ok: true, estimate: true, window: { days, from: days ? '2026-09-07' : null },
    totals: { cost: 100, recentCost: days === 7 ? 10 : 40, sessions: 9 },
    projects: [{ id: PID, name: 'Demoprojekt', sessions: 3, explicitSessions: 2, derivedSessions: 1, recentSessions: days === 7 ? 1 : 3, recentDerivedSessions: days === 7 ? 0 : 1,
      cost: 12.5, recentCost: days === 7 ? 1.5 : 4.25, tokens: 9, top: [] }],
    recent: [], plans: [{ name: 'a.md', title: 'A', mtime: 1, sessionIds: [], derived: false }], suggestions: [], memory: [],
    activity: Array.from({ length: days || 90 }, (_, i) => (i % 3 ? 0 : i)),
  });
  const world = () => pageWorld({ api: (p) => {
    if (!p.startsWith('/api/projects/overview')) return null;
    const m = /[?&]days=(\d+)/.exec(p);
    return OV(m ? Number(m[1]) : 30);
  } });
  const txt = (w) => w.nodes['#projBody'].textContent;

  it('the switch: four buttons, the default 30 pressed (aria-pressed), the default sent as before (no &days)', async () => {
    const w = world();
    w.ctx.projOpen(PID); await settle();
    const seg = w.nodes['#projBody'].querySelector('.pd-win');
    assert.ok(seg && seg.getAttribute('role') === 'group' && seg.getAttribute('aria-label'), 'the switch is not a named group');
    const btns = seg.querySelectorAll('button');
    assert.deepEqual(btns.map((b) => b.dataset.fk), ['win:7', 'win:30', 'win:90', 'win:0']);
    assert.deepEqual(btns.map((b) => b.getAttribute('aria-pressed')), ['false', 'true', 'false', 'false']);
    assert.ok(w.calls.api.some(([p]) => p === '/api/projects/overview?id=' + PID), 'the default window changed the request');
    for (const k of ['kpiSitzungen', 'kpiKosten', 'kpiAnteil', 'kpiTabs', 'kpiPlaene', 'kpiDavonRegel']) assert.ok(txt(w).includes('de:projects.' + k), k + ' missing');
  });
  it('a click on 7 asks for &days=7, presses that button and shows ITS figures', async () => {
    const w = world();
    w.ctx.projOpen(PID); await settle();
    byFk(w, 'win:7').onclick(); await settle();
    assert.ok(w.calls.api.some(([p]) => p === '/api/projects/overview?id=' + PID + '&days=7'), JSON.stringify(w.calls.api.map(([p]) => p)));
    assert.equal(byFk(w, 'win:7').getAttribute('aria-pressed'), 'true');
    assert.equal(byFk(w, 'win:30').getAttribute('aria-pressed'), 'false');
    const vals = w.nodes['#projBody'].querySelectorAll('.pd-kpis .urst-v').map((n) => n.textContent);
    assert.equal(vals[0], '1', 'sessions of the 7-day window: ' + vals.join(' | '));
    assert.ok(!txt(w).includes('de:projects.kpiDavonRegel'), 'no rule-labelled session in this window');
    byFk(w, 'win:0').onclick(); await settle();
    assert.ok(w.calls.api.some(([p]) => p === '/api/projects/overview?id=' + PID + '&days=0'));
    byFk(w, 'win:30').onclick(); await settle();
    assert.equal(w.calls.api.filter(([p]) => p === '/api/projects/overview?id=' + PID).length, 1, 'back to 30 reads the kept window, not again');
  });
  it('the sparkline is an image with a spoken summary; the SVG itself is hidden from assistive tech', async () => {
    const w = world();
    w.ctx.projOpen(PID); await settle();
    const sp = w.nodes['#projBody'].querySelector('.pd-spark');
    assert.ok(sp, 'no sparkline');
    assert.equal(sp.getAttribute('role'), 'img');
    assert.match(sp.getAttribute('aria-label'), /^de:projects\.sparkA11y/);
    assert.match(sp.innerHTML, /^<svg [^>]*aria-hidden="true"/);
    assert.equal((sp.innerHTML.match(/<rect /g) || []).length, 30, 'one bar per day of the window');
  });
  it('Nutzung & Kosten: the CLI folder is called „Ordner" (new keys), next to the new „Panel-Projekt" dropdown', () => {
    const lbl = /<label><span data-i18n="([\w.-]+)">[^<]*<\/span> <span id="uProjectMount"><\/span><\/label>/.exec(INDEX);
    assert.ok(lbl, 'the folder dropdown lost its label');
    assert.equal(I18N.de[lbl[1]], 'Ordner', 'the German label of the CLI folder filter');
    assert.match(INDEX, /data-i18n="html\.panelProjekt"[^<]*<\/span> <span id="uPProjectMount">/);
    const USAGE = read('public/js/views-usage.js');
    assert.match(USAGE, /t\('views-usage\.alleOrdner'\)/);
    assert.equal(I18N.de['views-usage.alleOrdner'], 'Alle Ordner');
    assert.match(USAGE, /qs\.push\('pproject=' \+ encodeURIComponent\(usageFilter\.pproject\)\)/);
    assert.match(USAGE, /if \(!usageFilter\.project && !usageFilter\.model && !usageFilter\.pproject\) USAGE_OPTS =/, 'the options may only be cached from UNFILTERED data');
  });
});

describe('P4 — Repos & PRs: its own request, the repo line, worktrees, PR hints, links only on the GHE host', () => {
  const PID = 'p-0000abcd';
  const GHE = 'github.example.com';
  const BS = '\\';
  const TOP = ['C:', 'Users', 'x', 'repo'].join(BS);
  const REPOS = (prs) => ({
    ok: true, checkedAt: 1, skipped: [{ dir: BS + BS + 'srv' + BS + 'x', reason: 'unc' }],
    repos: [{ repo: true, dir: TOP, top: TOP, name: 'repo', branch: 'main', upstream: 'origin/main', ahead: 2, behind: 0,
      gone: false, detached: false, changed: 3, worktrees: { count: 1, list: [{ path: TOP + '-wt', branch: 'feat/b', detached: false }] },
      remote: { host: GHE, owner: 'your-org', repo: 'repo' }, prs }],
  });
  // URL is a browser global the vm context lacks — handed in, as a browser has it
  const world = (answer) => pageWorld({ env: { URL }, api: (p) => (p.startsWith('/api/projects/repos') ? answer(p) : null) });
  const sec = (w) => fold(w, 'repos');
  it('asks GET /api/projects/repos?id= itself; the head and the row say branch ↑/↓, changed and worktrees', async () => {
    const w = world(() => REPOS({ status: 'ok', items: [], total: 0 }));
    w.ctx.projOpen(PID); await settle();
    assert.ok(w.calls.api.some(([p]) => p === '/api/projects/repos?id=' + PID), JSON.stringify(w.calls.api.map(([p]) => p)));
    assert.ok(!w.calls.api.some(([p]) => p.includes('fresh=1')), 'a plain visit skips the memo');
    const s = sec(w);
    assert.ok(s && s.open, 'the section is missing or closed');
    assert.match(s.querySelector('.pd-fold-sum').textContent, /^repo: main ↑2 ↓0 · /);
    assert.ok(s.textContent.includes('de:projects.reposHinweis'), 'no „Stand des letzten Fetch" note');
    assert.ok(s.textContent.includes('feat/b'), 'the worktree is not listed');
    assert.ok(s.textContent.includes('de:projects.prsKeine'));
    assert.ok(s.textContent.includes('de:projects.reposUebersprungen'));
    byFk(w, 'repos-reload').onclick(); await settle();
    assert.ok(w.calls.api.some(([p]) => p === '/api/projects/repos?id=' + PID + '&fresh=1'), '↻ does not read past the memo');
  });
  it('offline says „VPN?"; a failed request is said in the section and the rest of the page stays', async () => {
    let w = world(() => REPOS({ status: 'offline', items: [], total: 0 }));
    w.ctx.projOpen(PID); await settle();
    assert.ok(sec(w).textContent.includes('de:projects.prsOffline'));
    assert.equal(I18N.de['projects.prsOffline'], 'PR-Status nicht erreichbar (VPN?)');
    w = world(() => Promise.reject(new Error('boom')));
    w.ctx.projOpen(PID); await settle();
    assert.ok(sec(w).textContent.includes('de:projects.reposFehler'));
    assert.ok(fold(w, 'cost') || fold(w, 'rules'), 'the page around it is gone');
  });
  it('PR rows: state tag, „deins", a link only for https on the repo host', async () => {
    const w = world(() => REPOS({ status: 'ok', total: 2, items: [
      { number: 8, title: 'Meins', url: 'https://' + GHE + '/your-org/repo/pull/8', author: 'jdoe', branch: 'feat/b', draft: false, state: 'approved', mine: true },
      { number: 9, title: 'Fremd', url: 'http://' + GHE + '/your-org/repo/pull/9', author: 'kim', branch: 'x', draft: false, state: 'changes', mine: false },
    ] }));
    w.ctx.projOpen(PID); await settle();
    const rows = sec(w).querySelectorAll('.pd-pr');
    assert.equal(rows.length, 2);
    assert.ok(rows[0].textContent.includes('de:projects.prMein') && rows[0].textContent.includes('de:projects.prFreigegeben'));
    const a = byFk(w, 'pr-open:' + TOP + ':8');
    assert.ok(a && a.tagName === 'A' && a.href.startsWith('https://' + GHE + '/') && a.rel === 'noopener noreferrer');
    assert.equal(byFk(w, 'pr-open:' + TOP + ':9'), null, 'an http link was drawn');
  });
  it('a project without a folder of its own has no section and asks nothing', async () => {
    const w = pageWorld({ projects: [Object.assign(PROJECT(), { addDirs: [], cwd: '', updatedAt: 1 })] });
    w.ctx.projOpen(PID); await settle();
    assert.equal(sec(w), null);
    assert.ok(!w.calls.api.some(([p]) => p.startsWith('/api/projects/repos')));
  });
});

// ===============================================================================================================
// P5 — „Neue Projekte vorschlagen": drafts above „Nicht zugeordnet"; a draft assigns its sessions ONLY after a save
// that CREATED the project, and only while the editor's visible tick is still set.
// ===============================================================================================================
describe('P5 drafts — open the editor pre-filled, assign only with the tick', () => {
  const NEW = 'p-0000beef';
  const DRAFT = () => ({ key: 'k:ACME-3269', kind: 'key', label: 'ACME-3269', name: 'Demoprojekt · ACME-3269', sessions: 2,
    sessionIds: [SID(7), SID(8)], titles: ['Antrag A', 'Antrag B'], lastActivity: 5,
    why: { signal: 'key', value: 'ACME-3269', sessions: 2 }, values: { jiraKeys: ['ACME-3269'], addDirs: [], mcpServers: ['sap-adt'] } });
  const OV = () => ({ ok: true, window: { days: 30 }, projects: [], unassigned: { sessions: 2, cost: 1, recentCost: 1, tokens: 1, top: [] }, drafts: [DRAFT()] });
  const world = (o) => pageWorld(Object.assign({
    projects: [],
    api: (p, opt) => {
      if (p.startsWith('/api/projects/overview')) return OV();
      if (p === '/api/projects' && opt && opt.method === 'POST') return { ok: true, created: true, project: Object.assign(PROJECT(), JSON.parse(opt.body).project, { id: NEW }) };
      if (opt && opt.method === 'POST') return { ok: true };
      return null;
    },
  }, o || {}));
  const assigns = (w) => w.calls.api.filter(([p]) => p === '/api/projects/assign').map(([, b]) => b);
  const open = async (w) => {
    w.ctx.renderProjects(); await settle();
    const sec = fold(w, 'drafts');
    assert.ok(sec && sec.open, 'the drafts section is missing or closed although there is a draft');
    assert.ok(w.nodes['#projBody'].textContent.includes('Demoprojekt · ACME-3269'));
    byFk(w, 'draft-new:k:ACME-3269').onclick({ stopPropagation() {} });
    for (let i = 0; i < 5; i++) await tick();
    const d = w.ev('PROJ_DRAFT'); assert.ok(d, 'the editor did not open');
    return d;
  };

  it('the editor is pre-filled, the tick is visible and set, the titles are listed — saving assigns them ONCE', async () => {
    const w = world();
    const d = await open(w);
    assert.equal(d.values.name, 'Demoprojekt · ACME-3269');
    assert.deepEqual(plain(d.values.jiraKeys), ['ACME-3269']);
    assert.deepEqual(plain(d.values.mcpServers), ['sap-adt']);
    const cb = q(d, '[data-pk="draft-assign"]');
    assert.ok(cb && cb.checked, 'no ticked box');
    assert.ok(d.box.textContent.includes('Antrag A') && d.box.textContent.includes('Antrag B'), 'the titles are not listed');
    assert.equal(assigns(w).length, 0, 'assigned before the save');
    assert.equal(await w.ctx.projEditorSave(), true);
    await settle();
    assert.deepEqual(assigns(w), [{ sessionIds: [SID(7), SID(8)], projectId: NEW }]);
  });
  it('without the tick nothing is assigned — the project is still created', async () => {
    const w = world();
    const d = await open(w);
    const cb = q(d, '[data-pk="draft-assign"]'); cb.checked = false; cb.onchange();
    assert.equal(await w.ctx.projEditorSave(), true);
    await settle();
    assert.ok(w.calls.api.some(([p, b]) => p === '/api/projects' && b), 'not created');
    assert.deepEqual(assigns(w), []);
  });
  it('a failed save assigns nothing; Abbrechen assigns nothing', async () => {
    const w = world({ api: (p, opt) => (p.startsWith('/api/projects/overview') ? OV() : (p === '/api/projects' && opt && opt.method === 'POST' ? Object.assign(new Error('kaputt'), { status: 500 }) : null)) });
    await open(w);
    assert.equal(await w.ctx.projEditorSave(), false);
    await settle();
    assert.deepEqual(assigns(w), []);
    await w.ctx.projEditorClose(true);
    assert.deepEqual(assigns(w), []);
  });
  it('✕ hides the draft in this browser only (cc_proj_drafts_off) — nothing is posted', async () => {
    const w = world();
    w.ctx.renderProjects(); await settle();
    byFk(w, 'draft-off:k:ACME-3269').onclick({ stopPropagation() {} });
    assert.deepEqual(JSON.parse(w.store.get('cc_proj_drafts_off')), ['k:ACME-3269']);
    assert.ok(!byFk(w, 'draft-new:k:ACME-3269'), 'still offered');
    assert.ok(!w.calls.api.some(([, b]) => b), 'a hide must not write to the server');
    assert.equal(fold(w, 'drafts').open, false, 'nothing left to show — the section stays shut');
    unfold(w, 'drafts');
    assert.ok(byFk(w, 'drafts-show'), 'no way back');
  });
  it('an editor opened on an EXISTING project never carries a draft', async () => {
    const w = world();
    const d = await openEditor(w, Object.assign(PROJECT(), { updatedAt: 1 }), { fromDraft: { key: 'x', sessionIds: [SID(7)], titles: ['t'] } });
    assert.equal(d.fromDraft, null);
  });
});

describe('P5 drafts — an existing project as target: „Zu X zuordnen…" (confirmation, folder via the save path, never silent)', () => {
  const PID = 'p-0000c0de';
  const DIR = 'C:\\Users\\x\\claude-code-ui';
  const DRAFT = () => ({ key: 'd:' + DIR.toLowerCase(), kind: 'dir', label: 'claude-code-ui', name: 'claude-code-ui', sessions: 2,
    sessionIds: [SID(7), SID(8)], titles: ['Panel A', 'Panel B'], lastActivity: 5, target: PID, targetSessions: 3,
    why: { signal: 'dir', value: DIR, sessions: 2 }, values: { jiraKeys: [], addDirs: [DIR], mcpServers: null } });
  const OV = () => ({ ok: true, window: { days: 30 }, projects: [], unassigned: { sessions: 2, cost: 1, recentCost: 1, tokens: 1, top: [] }, drafts: [DRAFT()] });
  const world = (answer, post) => pageWorld({
    projects: [Object.assign(PROJECT(), { id: PID, name: 'Claude Code Control Panel', updatedAt: 1000, addDirs: [] })],
    modal: answer,
    api: (p, opt) => {
      if (p.startsWith('/api/projects/overview')) return OV();
      if (p === '/api/projects' && opt && opt.method === 'POST') return post ? post(JSON.parse(opt.body)) : { ok: true, project: Object.assign(PROJECT(), { id: PID, name: 'Claude Code Control Panel', updatedAt: 1001 }, JSON.parse(opt.body).project) };
      if (opt && opt.method === 'POST') return { ok: true };
      return null;
    },
  });
  const posts = (w, route) => w.calls.api.filter(([p, b]) => p === route && b).map(([, b]) => b);
  const go = async (w) => { w.ctx.renderProjects(); await settle(); assert.ok(!byFk(w, 'draft-new:' + DRAFT().key), 'a duplicate project is offered'); await byFk(w, 'draft-join:' + DRAFT().key).onclick({ stopPropagation() {} }); await settle(); };
  it('the row asks „add to"; confirmed with the ticked folder box → folder saved WITH its version, then ONE assignment', async () => {
    let seen = null;
    const w = world((o) => { seen = o; return 'ok'; });
    w.ctx.renderProjects(); await settle();
    assert.ok(w.nodes['#projBody'].textContent.includes('de:projects.entwurfZielDir'));
    await go(w);
    const cb = seen.body.querySelector('[data-pk="draft-adddir"]');
    assert.ok(cb && cb.checked, 'the folder box is missing or not ticked');
    assert.ok(seen.body.textContent.includes('Panel A') && seen.body.textContent.includes('Panel B'), 'the titles are not listed');
    assert.deepEqual(posts(w, '/api/projects'), [{ project: { id: PID, addDirs: [DIR], baseUpdatedAt: 1000 } }]);
    assert.deepEqual(posts(w, '/api/projects/assign'), [{ sessionIds: [SID(7), SID(8)], projectId: PID }]);
  });
  it('folder box off → only the assignment; Abbrechen → nothing at all', async () => {
    let w = world((o) => { const cb = o.body.querySelector('[data-pk="draft-adddir"]'); cb.checked = false; return 'ok'; });
    await go(w);
    assert.deepEqual(posts(w, '/api/projects'), []);
    assert.equal(posts(w, '/api/projects/assign').length, 1);
    w = world(() => 'cancel');
    await go(w);
    assert.deepEqual([posts(w, '/api/projects').length, posts(w, '/api/projects/assign').length], [0, 0]);
  });
  it('a 409 on the folder save assigns NOTHING and says so', async () => {
    const w = world(() => 'ok', () => Object.assign(new Error('conflict'), { status: 409 }));
    await go(w);
    assert.deepEqual(posts(w, '/api/projects/assign'), []);
    assert.ok(w.calls.toast.some(([m, k]) => m === 'de:projects.entwurfKonflikt' && k === 'err'), JSON.stringify(w.calls.toast));
  });
});

describe('P5 drafts — „Zu X zuordnen…": a double click runs once, a failed assignment after the folder is said honestly', () => {
  const PID = 'p-0000c0de';
  const DIR = 'C:/Users/x/claude-code-ui';
  const DRAFT = () => ({ key: 'd:c:/users/x/claude-code-ui', kind: 'dir', label: 'claude-code-ui', name: 'claude-code-ui', sessions: 2,
    sessionIds: [SID(7), SID(8)], titles: ['Panel A', 'Panel B'], lastActivity: 5, target: PID, targetSessions: 2,
    why: { signal: 'dir', value: DIR, sessions: 2 }, values: { jiraKeys: [], addDirs: [DIR], mcpServers: null } });
  const OV = () => ({ ok: true, window: { days: 30 }, projects: [], unassigned: { sessions: 2, cost: 1, recentCost: 1, tokens: 1, top: [] }, drafts: [DRAFT()] });
  const world = (modal, assignFails) => pageWorld({
    projects: [Object.assign(PROJECT(), { id: PID, name: 'Claude Code Control Panel', updatedAt: 1000, addDirs: [] })],
    modal,
    api: (p, opt) => {
      if (p.startsWith('/api/projects/overview')) return OV();
      if (p === '/api/projects/assign') return assignFails ? Object.assign(new Error('weg'), { status: 500 }) : { ok: true };
      if (p === '/api/projects' && opt && opt.method === 'POST') return { ok: true, project: Object.assign(PROJECT(), { id: PID, name: 'Claude Code Control Panel', updatedAt: 1001 }, JSON.parse(opt.body).project) };
      return null;
    },
  });
  const posts = (w, route) => w.calls.api.filter(([p, b]) => p === route && b);
  it('two clicks while the dialog is open → ONE dialog, ONE folder save, ONE assignment', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const w = world(() => gate.then(() => 'ok'));
    w.ctx.renderProjects(); await settle();
    assert.ok(w.nodes['#projBody'].textContent.includes('de:projects.entwurfZielDir'));
    const btn = byFk(w, 'draft-join:' + DRAFT().key);
    const a = btn.onclick({ stopPropagation() {} }); const b = btn.onclick({ stopPropagation() {} });
    release(); await a; await b; await settle();
    assert.deepEqual([w.calls.uiModal.length, posts(w, '/api/projects').length, posts(w, '/api/projects/assign').length], [1, 1, 1]);
  });
  it('folder saved, assignment failed → the toast says exactly that', async () => {
    const w = world(() => 'ok', true);
    w.ctx.renderProjects(); await settle();
    await byFk(w, 'draft-join:' + DRAFT().key).onclick({ stopPropagation() {} }); await settle();
    assert.equal(posts(w, '/api/projects').length, 1);
    assert.ok(w.calls.toast.some(([m, k]) => m === 'de:projects.entwurfOrdnerOhneZuordnung' && k === 'err'), JSON.stringify(w.calls.toast));
  });
});
