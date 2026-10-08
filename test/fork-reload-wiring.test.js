'use strict';
// P-0, the browser half of the start path: three places where a tab started with values it never had.
//   1. forkTab (chat.js) opened a plain newTab(), whose activateTab painted the GLOBAL defaults into the selectors
//      — the fork started on the default model and mode, without the source's roots, agent, MCP scope,
//      guardrails, subagent policy, Ultracode wish or colour. It copies them now (forkCopyLaunch), before the
//      activation, with cfgTouched.
//   2. persistTabs/restoreTabs did not keep the permission mode and the effort, and a restored tab had no
//      cfgTouched — so a reload resumed every tab in the global defaults. Both come back now (tabRestoreLaunch),
//      except bypassPermissions, which a reload never restores; an entry written before P-0 restores as before.
//   3. resumeSession (sessions.js) reused ANY active tab without an id and without rows — also one with roots,
//      an agent or an MCP scope set up for something else, which the start body then took along. Only an
//      untouched tab is reused now (tabUntouched).
// The functions are lifted out of the real sources by name (as test/plan-wiring.test.js does) and run in a vm
// context with stubs for their neighbours, so it is the wiring itself that is under test, not a copy of it.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const PUB = path.join(__dirname, '..', 'public', 'js');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const CHAT = read('chat.js');
const SESSIONS = read('sessions.js');
const CHAT_EVENTS = read('chat-events.js');

// a top-level function by name — a one-liner, or a block that ends with `}` at column 0
function liftFn(src, name, rel) {
  const one = new RegExp('^(?:async )?function ' + name + '\\(.*\\}$', 'm').exec(src);
  const m = (one && !/\{\s*$/.test(one[0])) ? one : new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm').exec(src);
  assert.ok(m, name + '() not found in ' + rel + ' — renamed or reindented? Then these tests prove nothing.');
  return m[0];
}
function liftConst(src, name, rel) {
  const m = new RegExp('^const ' + name + ' = .*;$', 'm').exec(src);
  assert.ok(m, 'const ' + name + ' not found in ' + rel);
  return m[0];
}
// values made inside the vm context are of ITS Array/Object — deepStrictEqual compares prototypes too
const plain = (x) => JSON.parse(JSON.stringify(x));
const world = (globals, code) => { const ctx = vm.createContext(globals); vm.runInContext(code, ctx); return ctx; };

// ---- 1. forkTab ------------------------------------------------------------------------------------------
function forkWorld() {
  const log = [];
  const ctx = world({
    makeTab: () => { const t = { uid: 7, title: 'Neuer Chat', defaultTitle: true, hue: 150, modelSel: '', effort: '', permissionMode: '', msgEl: { childElementCount: 0 } }; log.push(['make', t]); return t; },
    // what activateTab gets to see decides what the selectors show, and the start reads the selectors
    activateTab: (t) => log.push(['activate', { cfgTouched: t.cfgTouched, modelSel: t.modelSel, effort: t.effort, permissionMode: t.permissionMode, mcpServers: t.mcpServers }]),
    startChat: async (extra, tab) => { log.push(['start', extra, tab]); return {}; },
    $: () => ({ focus() {} }), toast: () => {}, tt: (k) => k,
    planAdopt: (_, p) => p, planSave: (p) => (p ? Object.assign({}, p) : null),
  }, [liftFn(CHAT, 'forkTab', 'chat.js'), liftFn(CHAT, 'forkCopyLaunch', 'chat.js')].join('\n'));
  return { ctx, log, fork: async (t) => { await ctx.forkTab(t); return log.find((e) => e[0] === 'make')[1]; } };
}
const SRC_TAB = () => ({
  sessionId: '11111111-2222-4333-8444-555555555555', title: 'Demoprojekt', cwd: 'C:\\WINDOWS\\system32',
  modelSel: 'opus[1m]', effort: 'high', permissionMode: 'acceptEdits',
  addDirs: ['C:\\Users\\x\\repo'], agent: 'reviewer', worktree: 'feature-x', maxBudgetUsd: 2.5,
  guardrails: 'T01 ist Test', subagents: { model: 'haiku', maxConcurrent: 2 }, ultracode: false,
  mcpServers: ['sap-adt', 'jira'], hue: 32, hueManual: true,
});

describe('P-0 forkTab — the fork starts with the source\'s launch values, not the global defaults', () => {
  it('copies every launch value, BEFORE the activation and with cfgTouched, and starts a fork of the source', async () => {
    const w = forkWorld();
    const src = SRC_TAB();
    const nt = await w.fork(src);
    const act = w.log.find((e) => e[0] === 'activate');
    assert.ok(act, 'the fork tab was never activated');
    // at activation time: cfgTouched set and the selector values in place — otherwise activateTab paints the
    // defaults (applyChatDefaults) and the start reads THOSE
    assert.deepEqual(plain(act[1]), { cfgTouched: true, modelSel: 'opus[1m]', effort: 'high', permissionMode: 'acceptEdits', mcpServers: ['sap-adt', 'jira'] });
    assert.equal(nt.title, 'Demoprojekt (Fork)');
    assert.equal(nt.cwd, src.cwd);
    assert.deepEqual(plain(nt.addDirs), src.addDirs);
    assert.equal(nt.agent, 'reviewer');
    assert.equal(nt.maxBudgetUsd, 2.5);
    assert.equal(nt.guardrails, 'T01 ist Test');
    assert.deepEqual(plain(nt.subagents), src.subagents);
    assert.equal(nt.ultracode, false, 'a deliberate OFF must stay off, not fall back to the global default');
    assert.deepEqual(plain(nt.mcpServers), ['sap-adt', 'jira']);
    assert.equal(nt.hue, 32); assert.equal(nt.hueManual, true);
    // the source's cwd already IS its worktree — a second --worktree would nest one inside it
    assert.equal(nt.worktree, undefined, 'the worktree must not be carried over');
    const st = w.log.find((e) => e[0] === 'start');
    assert.deepEqual(plain(st[1]), { resume: src.sessionId, cwd: src.cwd, fork: true });
    assert.equal(st[2], nt, 'the fork was started in another tab');
    assert.ok(w.log.indexOf(act) < w.log.indexOf(st), 'activated after the copy, started after the activation');
  });

  it('copies, never shares: an edit in one tab cannot change the other\'s next start', async () => {
    const src = SRC_TAB();
    const nt = await forkWorld().fork(src);
    for (const k of ['addDirs', 'subagents', 'mcpServers']) assert.notEqual(nt[k], src[k], k + ' is the same object in both tabs');
    nt.addDirs.push('C:\\other'); nt.mcpServers.length = 0; nt.subagents.model = 'opus';
    assert.deepEqual(src.addDirs, ['C:\\Users\\x\\repo']);
    assert.deepEqual(src.mcpServers, ['sap-adt', 'jira']);
    assert.equal(src.subagents.model, 'haiku');
  });

  it('a value the source never set stays unset — MCP undefined (the server inherits the stored scope), Ultracode „global"', async () => {
    const src = { sessionId: '11111111-2222-4333-8444-555555555555', title: 'T', cwd: 'C:\\x', modelSel: '', effort: '', permissionMode: 'plan', hue: 95 };
    const nt = await forkWorld().fork(src);
    assert.equal('mcpServers' in nt, false, 'an undefined scope became an explicit one');
    assert.equal(nt.ultracode, undefined);
    assert.equal(nt.addDirs, undefined); assert.equal(nt.agent, undefined); assert.equal(nt.subagents, undefined);
    assert.equal(nt.cfgTouched, true, 'still the tab\'s OWN (empty) values — not the global defaults');
    // …but it remembers WHOSE stored scope it inherited, for the MCP picker (see the pickTabMcp block below)
    assert.equal(nt._mcpFrom, src.sessionId, 'the fork forgot where its inherited MCP scope is stored');
    // explicit „all" (null) is a choice of its own and comes along as null
    const all = await forkWorld().fork(Object.assign(SRC_TAB(), { mcpServers: null }));
    assert.equal(all.mcpServers, null);
    // an explicit choice (array or null) is the fork's own — nothing to look up elsewhere
    assert.equal(all._mcpFrom, undefined);
    assert.equal((await forkWorld().fork(SRC_TAB()))._mcpFrom, undefined);
  });

  it('bypassPermissions comes along — a decision: a fork is the user\'s own click on a tab running in it (unlike a reload)', async () => {
    const nt = await forkWorld().fork(Object.assign(SRC_TAB(), { permissionMode: 'bypassPermissions' }));
    assert.equal(nt.permissionMode, 'bypassPermissions');
  });

  it('every launch value the start body reads off a tab is either copied by the fork or excluded on purpose', () => {
    // Self-maintaining: a launch field added to chat-events.js startChat later shows up here and has to be
    // decided on, instead of quietly being one more thing a fork loses.
    const start = liftFn(CHAT_EVENTS, 'startChat', 'chat-events.js');
    const body = start.slice(start.indexOf('const body = {'), start.indexOf('tab.cwd = body.cwd;'));
    assert.ok(body.length > 200, 'the start body was not found — did startChat change shape?');
    const read = new Set((body.match(/\btab\.(\w+)/g) || []).map((m) => m.slice(4)));
    const copy = liftFn(CHAT, 'forkCopyLaunch', 'chat.js');
    const copied = new Set((copy.match(/\bdst\.(\w+)\s*=/g) || []).map((m) => m.slice(4).replace(/\s*=$/, '')));
    // `title` is forkTab's own (+ „ (Fork)"); `worktree`: see the test above
    // `projectId`: only a FRESH start sends it — a fork inherits its source's label on the server (J3)
    const excluded = new Set(['title', 'worktree', 'projectId']);
    const lost = [...read].filter((k) => !copied.has(k) && !excluded.has(k));
    assert.deepEqual(lost, [], 'read by the start body, but neither copied nor excluded by the fork: ' + lost.join(', '));
    for (const k of ['addDirs', 'agent', 'guardrails', 'subagents', 'ultracode', 'mcpServers', 'modelSel', 'effort', 'permissionMode']) assert.ok(read.has(k), 'premise: the body reads tab.' + k);
  });

  it('activateTab still shows a cfgTouched tab\'s OWN values — the reason the copy must carry it', () => {
    // #94 lifted the selector sync out of activateTab into syncRunSelectors (and added ensureModelOption, so a
    // model the menu does not list — a typed /model — still shows). The rule this test guards is unchanged: a
    // started or cfgTouched tab paints ITS OWN mode/model/effort, only an untouched one gets the defaults.
    assert.match(liftFn(CHAT, 'activateTab', 'chat.js'), /\bsyncRunSelectors\(t\)/, 'activateTab goes through syncRunSelectors');
    const sync = liftFn(CHAT, 'syncRunSelectors', 'chat.js');
    assert.match(sync, /if \(t\.id \|\| t\.cfgTouched\) \{ \$\('#permMode'\)\.value = t\.permissionMode \|\| 'plan';[^}]*\$\('#modelSel'\)\.value = t\.modelSel \|\| ''; \$\('#effortSel'\)\.value = t\.effort \|\| ''; \}/);
    assert.match(sync, /else if \(typeof applyChatDefaults === 'function'\) applyChatDefaults\(\);/, '…and only an untouched tab gets the defaults');
  });
});

// ---- 1b. the fork's MCP picker before the fork has an id -------------------------------------------------
// The real CLI says nothing at spawn (CTX-4), so a fresh fork has no session id until the first message — and the
// picker read the stored scope only by that id. It found nothing, ticked EVERY server while the process ran the
// source's scope, and an „Übernehmen" there made the fork's scope an explicit „all". fake-claude sent `init` at
// once, which is why the browser check passed (FAKE_CLAUDE_LATE_INIT now reproduces the real timing).
// pickTabMcp runs here for real, against a DOM stand-in just big enough for its rows.
function pickerWorld(stored) {
  const asked = [];
  const mk = (tag, cls, text) => {
    const n = { tag, cls: cls || '', text: text == null ? '' : String(text), children: [], isConnected: true, style: {}, type: '', checked: false,
      appendChild(c) { this.children.push(c); return c; }, remove() {}, set innerHTML(_) { this.children = []; },
      querySelectorAll() { return []; } };
    return n;
  };
  let menu = null;
  const ctx = world({
    closeTabMenu: () => {}, $: () => null, tt: (k) => k, positionMenuAt: () => {}, autoCloseOnOutside: () => {},
    el: (tag, cls, text) => { const n = mk(tag, cls, text); if (cls && /\bmcp-pop\b/.test(cls)) menu = n; return n; },
    document: { body: { appendChild: () => {} } },
    api: async (url) => {
      asked.push(url);
      if (url === '/api/mcp/configured') return { servers: [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }] };
      const m = /^\/api\/session\/mcp\?id=(.*)$/.exec(url);
      if (m) { const id = decodeURIComponent(m[1]); return { selection: Array.isArray(stored[id]) ? stored[id] : null }; }
      throw new Error('unexpected ' + url);
    },
    mcpLiveRead: async () => null,                       // no live rows: only the checkbox half is under test
    mcpSplitConfigured: (servers) => ({ live: servers.slice(), unlisted: [], extra: [] }),
    mcpStatusSummary: () => ({ connected: 0, total: 0 }), mcpRow: () => null, mcpLiveControls: () => {},
    applyTabMcp: () => {},
  }, liftFn(CHAT, 'pickTabMcp', 'chat.js'));
  // name → ticked, read off the rows the picker built (label.mcp-check = [checkbox, name])
  const ticks = () => {
    const out = {};
    const walk = (n) => { if (n.cls === 'mcp-check') out[n.children[1].text] = !!n.children[0].checked; (n.children || []).forEach(walk); };
    walk(menu); return out;
  };
  return { open: async (t) => { await ctx.pickTabMcp(t); return ticks(); }, asked, sessionLookups: () => asked.filter((u) => u.startsWith('/api/session/mcp')) };
}
const SRC_ID = '11111111-2222-4333-8444-555555555555', FORK_ID = '99999999-2222-4333-8444-555555555555';

describe('P-0 pickTabMcp — a fork without its own id yet shows the scope it runs with', () => {
  it('end to end through forkTab: the fork asks by its SOURCE id and ticks exactly the inherited scope', async () => {
    const src = { sessionId: SRC_ID, title: 'Quelle', cwd: 'C:\\x', modelSel: '', effort: '', permissionMode: 'plan', hue: 3 };
    const nt = await forkWorld().fork(src);
    nt.id = 'chat-1'; nt.sessionId = null;                // running, but the CLI has not spoken yet
    const w = pickerWorld({ [SRC_ID]: ['alpha'] });
    assert.deepEqual(plain(await w.open(nt)), { alpha: true, beta: false, gamma: false }, 'the picker ticked servers the fork does not run');
    assert.deepEqual(w.sessionLookups(), ['/api/session/mcp?id=' + SRC_ID]);
  });

  it('once the fork has its own id, that id wins (the server stored the same scope under it)', async () => {
    const w = pickerWorld({ [SRC_ID]: ['alpha'], [FORK_ID]: ['beta'] });
    assert.deepEqual(plain(await w.open({ id: 'chat-1', sessionId: FORK_ID, _mcpFrom: SRC_ID, title: 'F' })), { alpha: false, beta: true, gamma: false });
    assert.deepEqual(w.sessionLookups(), ['/api/session/mcp?id=' + FORK_ID]);
  });

  it('unchanged elsewhere: an explicit choice asks nobody, a tab with no id and no source ticks everything', async () => {
    const w = pickerWorld({ [SRC_ID]: ['alpha'] });
    assert.deepEqual(plain(await w.open({ id: 'c', sessionId: SRC_ID, mcpServers: ['gamma'], title: 'E' })), { alpha: false, beta: false, gamma: true });
    assert.deepEqual(plain(await w.open({ id: null, sessionId: null, title: 'N' })), { alpha: true, beta: true, gamma: true });
    assert.deepEqual(w.sessionLookups(), [], 'nothing to look up in either case');
  });
});

// ---- 2. persistTabs / restoreTabs ------------------------------------------------------------------------
function tabsWorld(opts) {
  const o = opts || {};
  const ls = new Map(Object.entries(o.ls || {}));
  const toasts = [];
  const TABS = [];
  const makeTab = (mo) => {
    const t = { uid: TABS.length + 1, title: (mo && mo.title) || 'Neuer Chat', defaultTitle: true, modelSel: '', effort: '', permissionMode: '', sessionId: null, hue: 200, draft: '',
      msgEl: { childElementCount: 0, appendChild() { this.childElementCount++; } } };
    TABS.push(t); return t;
  };
  const ctx = world({
    TABS, ACTIVE: null, makeTab, console,
    localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) },
    // the one template whose placeholders matter here; every other key comes back as itself
    $: () => ({ value: '' }), el: () => ({}), tt: (k) => (k === 'chat.bypassNichtWiederhergestellt' ? 'BYPASS {t} → {m}' : k),
    toast: (msg, kind) => toasts.push([msg, kind]),
    autoGrow: () => {}, renderTabs: () => {}, activateTab: (t) => { ctx.ACTIVE = t; },
    ctxWindowSave: () => null, ctxAdoptSavedWindow: () => {}, planSave: () => null, planAdopt: () => null,
    CHAT_DEFAULTS: Object.assign({ model: '', effort: '', permMode: 'plan' }, o.defaults || {}),
  }, [liftConst(CHAT, 'LIVE_EFFORT_LEVELS', 'chat.js'), liftConst(CHAT, 'TAB_RESTORE_MODES', 'chat.js'),
    liftConst(CHAT, 'TAB_RESTORE_SAFE_MODE', 'chat.js'), liftFn(CHAT, 'tabRestoreFallback', 'chat.js'),
    liftFn(CHAT, 'modeInfo', 'chat.js'), liftFn(CHAT, 'tabRestoreLaunch', 'chat.js'),
    // CHAT-FLOW-4 part B: the write goes through tabsStore, the active tab through tab-windows.js — here in the
    // fallback without Web Locks (no navigator in this world), i.e. the one list for every window as before
    read('tab-windows.js'), liftConst(CHAT, 'TABWIN', 'chat.js'), liftFn(CHAT, 'tabsStore', 'chat.js'), liftFn(CHAT, 'tabsSetItems', 'chat.js'),
    liftFn(CHAT, 'tabsWarnUnsaved', 'chat.js'),
    liftFn(CHAT, 'persistTabs', 'chat.js'), liftFn(CHAT, 'restoreTabs', 'chat.js')].join('\n'));
  return { ctx, TABS, toasts, ls, makeTab };
}
const SID = (n) => '00000000-0000-4000-8000-00000000000' + n;

describe('P-0 persistTabs / restoreTabs — a reload keeps effort and mode, never bypassPermissions', () => {
  it('round trip: mode + effort come back, the tab is marked configured; bypass falls back to the default with ONE toast', () => {
    const a = tabsWorld();
    const A = a.makeTab(); Object.assign(A, { sessionId: SID(1), title: 'A', permissionMode: 'acceptEdits', effort: 'high', modelSel: 'opus' });
    const B = a.makeTab(); Object.assign(B, { sessionId: SID(2), title: 'B', permissionMode: 'bypassPermissions', effort: 'max' });
    const C = a.makeTab(); Object.assign(C, { sessionId: SID(3), title: 'C', permissionMode: 'auto', effort: '' });
    a.ctx.persistTabs();
    const saved = JSON.parse(a.ls.get('cc_tabs'));
    assert.deepEqual(saved.map((x) => [x.permissionMode, x.effort]), [['acceptEdits', 'high'], ['bypassPermissions', 'max'], ['auto', '']],
      'what the tab ran in is saved as it is — the restore decides what may come back');

    const b = tabsWorld({ ls: { cc_tabs: a.ls.get('cc_tabs') } });
    b.makeTab();                                   // the boot tab restoreTabs reuses
    assert.equal(b.ctx.restoreTabs(), true);
    const [rA, rB, rC] = b.TABS;
    assert.deepEqual([rA.permissionMode, rA.effort, rA.cfgTouched, rA.modelSel], ['acceptEdits', 'high', true, 'opus']);
    assert.deepEqual([rC.permissionMode, rC.effort, rC.cfgTouched], ['auto', '', true]);
    assert.equal(rB.permissionMode, 'plan', 'bypassPermissions came back after a reload');
    assert.equal(rB.effort, 'max', 'only the mode is withheld — the effort comes back');
    assert.equal(rB.cfgTouched, true);
    assert.deepEqual(b.toasts, [['BYPASS B → chat.plan', 'warn']], 'one toast, naming the tab and the mode it starts in instead');
  });

  it('the bypass toast prints tab titles verbatim — a title is the user\'s text, not a replacement pattern', () => {
    // String.prototype.replace with a STRING expands `$&` / `$'` / `$$` in it, and the second replace would hit a
    // „{m}" inside a title instead of the template's own.
    const w = tabsWorld({ ls: { cc_tabs: JSON.stringify([{ sessionId: SID(1), title: 'Preis $& {m} $\' $$', permissionMode: 'bypassPermissions', effort: '' }]) } });
    w.makeTab();
    w.ctx.restoreTabs();
    assert.deepEqual(w.toasts, [['BYPASS Preis $& {m} $\' $$ → chat.plan', 'warn']]);
  });

  it('an entry from before P-0 (no mode stored) restores exactly as before: no cfgTouched, defaults stay in charge', () => {
    const old = [{ sessionId: SID(4), title: 'alt', cwd: 'C:\\x', modelSel: 'opus', def: false }];
    const w = tabsWorld({ ls: { cc_tabs: JSON.stringify(old) } });
    w.makeTab();
    assert.equal(w.ctx.restoreTabs(), true);
    const t = w.TABS[0];
    assert.equal(t.cfgTouched, undefined, 'an old entry was promoted to „own values" it never had');
    assert.equal(t.permissionMode, ''); assert.equal(t.effort, '');
    assert.equal(t.modelSel, 'opus', 'unchanged: the model was restored before P-0 too');
    assert.deepEqual(w.toasts, []);
    // …and persisting it again (still dormant, nothing known) keeps it in the old format
    w.ctx.persistTabs();
    assert.equal('permissionMode' in JSON.parse(w.ls.get('cc_tabs'))[0], false, 'an unknown mode was written as a new-format entry');
  });

  it('localStorage is not trusted: an unknown mode or effort falls back, a non-string mode is the old format', () => {
    const w = tabsWorld({ ls: { cc_tabs: JSON.stringify([
      { sessionId: SID(5), title: 'x', permissionMode: 'yolo', effort: 'ludicrous' },
      { sessionId: SID(6), title: 'y', permissionMode: 5, effort: 'high' },
    ]) } });
    w.makeTab();
    w.ctx.restoreTabs();
    assert.deepEqual([w.TABS[0].permissionMode, w.TABS[0].effort, w.TABS[0].cfgTouched], ['plan', '', true]);
    assert.deepEqual([w.TABS[1].permissionMode, w.TABS[1].effort, w.TABS[1].cfgTouched], ['', '', undefined]);
    assert.deepEqual(w.toasts, [], 'an unknown mode is not a withheld bypass');
  });

  it('a LIVE switch of mode or effort is saved at once — a reload right after it must not bring the old value back', async () => {
    // Found in the browser check: nothing on these two paths persisted, so the switch reached cc_tabs only with
    // whatever happened to persist next (a keystroke in the draft, a title change).
    const saved = [];
    const t = { id: 'c1', permissionMode: 'plan', effort: '' };
    const ctx = world({
      ACTIVE: t, tt: (k) => k, toast: () => {}, renderStatusBar: () => {}, $: () => null, scheduleRunCfg: () => {},
      persistTabs: () => saved.push({ permissionMode: t.permissionMode, effort: t.effort }),
      adoptUltracodeState: (_, r) => !!(r && r.read),
      api: async (url, o) => (/\/mode$/.test(url) ? { mode: JSON.parse(o.body).mode } : { read: true, effort: JSON.parse(o.body).effort }),
    }, [liftFn(CHAT, 'modeInfo', 'chat.js'), liftFn(CHAT, 'applyLiveMode', 'chat.js'), liftFn(CHAT, 'applyLiveEffort', 'chat.js')].join('\n'));
    await ctx.applyLiveMode('acceptEdits');
    assert.deepEqual(plain(saved), [{ permissionMode: 'acceptEdits', effort: '' }], 'the live mode switch was not saved');
    await ctx.applyLiveEffort('high');
    assert.deepEqual(plain(saved[1]), { permissionMode: 'acceptEdits', effort: 'high' }, 'the live effort switch was not saved');
  });

  it('a live switch says what it did — not „auch als Standard gemerkt", which no live switch has done since C10', async () => {
    // Before: all three toasts ended in „· auch als Standard gemerkt" while nothing saved a default (the pin next
    // to the selectors is the only way since C10). After P-0 that showed: a tab switched live to bypass came back
    // after F5 in the default mode — under a toast that had called bypass the default.
    const toasts = [], defaultsSaved = [];
    const t = { id: 'c1', permissionMode: 'plan', effort: '', modelSel: '' };
    const ctx = world({
      ACTIVE: t, tt: (k) => k, toast: (msg, kind) => toasts.push([msg, kind]), renderStatusBar: () => {}, renderTabs: () => {}, $: () => null,
      scheduleRunCfg: () => {}, persistTabs: () => {}, saveChatDefaults: () => defaultsSaved.push(1),
      adoptUltracodeState: () => true, modelResolves: (v) => v, shortModel: (v) => v,
      api: async (url, o) => (/\/mode$/.test(url) ? { mode: JSON.parse(o.body).mode } : (/\/effort$/.test(url) ? { effort: JSON.parse(o.body).effort } : {})),
    }, [liftFn(CHAT, 'modeInfo', 'chat.js'), liftFn(CHAT, 'applyLiveMode', 'chat.js'), liftFn(CHAT, 'applyLiveEffort', 'chat.js'), liftFn(CHAT, 'applyLiveModel', 'chat.js')].join('\n'));
    await ctx.applyLiveMode('bypassPermissions');
    await ctx.applyLiveEffort('high');
    await ctx.applyLiveModel('opus');
    assert.equal(toasts.length, 3, 'one toast per switch: ' + JSON.stringify(toasts));
    assert.deepEqual(toasts.map((x) => x[1]), ['ok', 'ok', 'ok']);
    for (const [msg] of toasts) assert.doesNotMatch(msg, /Standard|default/i, 'a live switch claims a saved default: ' + msg);
    assert.deepEqual(toasts.map((x) => x[0]), ['chat.modusLiveGewechselt' + 'chat.bypass', 'chat.effortLiveGewechselthigh', 'chat.modellLiveGewechseltopus']);
    assert.deepEqual(defaultsSaved, [], 'premise: no live switch saves a default — the toast must not say it did');
  });

  // R3 — Julian, 05.10.: „nie automatisch Bypass". The first cut let a remembered default of bypassPermissions
  // through as „the user's own standing choice" (and this test pinned exactly that); the decision is that a reload
  // never brings bypass back, the default included — bypass is entered by hand, in the tab.
  it('R3: a default that IS bypassPermissions does not bring bypass back either — the tab restores in „default"', () => {
    const w = tabsWorld({ defaults: { permMode: 'bypassPermissions' }, ls: { cc_tabs: JSON.stringify([{ sessionId: SID(7), title: 'z', permissionMode: 'bypassPermissions', effort: '' }]) } });
    w.makeTab();
    w.ctx.restoreTabs();
    assert.equal(w.TABS[0].permissionMode, 'default');
    assert.equal(w.toasts.length, 1, 'and it says so, once');
    assert.deepEqual(w.toasts[0], ['BYPASS z → ' + w.ctx.modeInfo('default').label, 'warn'],
      'the toast names the mode the tab REALLY starts in, not the (bypass) default');
    // an unknown mode from localStorage under a bypass default: the same safe mode, never the default
    const u = tabsWorld({ defaults: { permMode: 'bypassPermissions' }, ls: { cc_tabs: JSON.stringify([{ sessionId: SID(8), title: 'u', permissionMode: 'made-up', effort: '' }]) } });
    u.makeTab(); u.ctx.restoreTabs();
    assert.equal(u.TABS[0].permissionMode, 'default');
    // …and a harmless default is still the fallback, unchanged
    assert.equal(w.ctx.tabRestoreFallback({ permMode: 'acceptEdits' }), 'acceptEdits');
    assert.equal(w.ctx.tabRestoreFallback({ permMode: 'bypassPermissions' }), 'default');
    assert.equal(w.ctx.tabRestoreFallback(null), 'plan');
  });

  it('R3: an entry from before P-0 (no mode stored) under a bypass default restores in „default" too, the rest as before', () => {
    const w = tabsWorld({ defaults: { permMode: 'bypassPermissions', effort: 'high', model: 'opus' }, ls: { cc_tabs: JSON.stringify([{ sessionId: SID(9), title: 'alt' }]) } });
    w.makeTab();
    w.ctx.restoreTabs();
    const t = w.TABS[0];
    assert.equal(t.permissionMode, 'default', 'without this, activateTab would paint the bypass default into the selector');
    assert.ok(t.cfgTouched, 'pinned — activateTab paints the defaults for every tab WITHOUT cfgTouched');
    assert.equal(t.effort, 'high', 'the rest of the defaults is kept, so an old entry still behaves as it did');
    assert.equal(t.modelSel, 'opus');
    assert.equal(w.toasts.length, 1);
    // with a harmless default an old entry behaves exactly as before: no pin, no toast
    const p = tabsWorld({ defaults: { permMode: 'plan' }, ls: { cc_tabs: JSON.stringify([{ sessionId: SID(6), title: 'alt2' }]) } });
    p.makeTab(); p.ctx.restoreTabs();
    assert.ok(!p.TABS[0].cfgTouched);
    assert.deepEqual(p.toasts, []);
  });

  it('the pure restore rule, for the record', () => {
    const w = tabsWorld({});
    assert.deepEqual(plain(w.ctx.tabRestoreLaunch({ permissionMode: 'bypassPermissions', effort: 'low' }, { permMode: 'default' })), { permissionMode: 'default', effort: 'low', bypassDropped: true });
    assert.equal(w.ctx.tabRestoreLaunch({ title: 'no mode' }, { permMode: 'plan' }), null);
    // a top-level const is a lexical binding of the context, not a property of it
    assert.equal(vm.runInContext('TAB_RESTORE_MODES.includes("bypassPermissions")', w.ctx), false);
  });
});

// ---- 3. resumeSession ------------------------------------------------------------------------------------
function resumeWorld(prep) {
  const calls = { newTab: 0, started: [] };
  const mk = () => ({ id: null, sessionId: null, title: 'Neuer Chat', msgEl: { childElementCount: 0 } });
  const first = mk(); if (prep) prep(first);
  const ctx = world({
    ACTIVE: first, t: (k) => k, toast: () => {}, setTabTitle: () => {},
    newTab: () => { calls.newTab++; ctx.ACTIVE = mk(); return ctx.ACTIVE; },
    startChat: async (extra, tab) => { calls.started.push([extra, tab]); },
    renderResumeHistory: async () => {},
    $$: () => [], $: () => ({ classList: { add() {}, remove() {} }, value: '' }),
  }, [liftFn(SESSIONS, 'resumeSession', 'sessions.js'), liftFn(CHAT, 'tabUntouched', 'chat.js')].join('\n'));
  return { ctx, calls, first };
}
const SESSION = { id: SID(8), title: 'Fremde Sitzung', projectPath: 'C:\\x', project: 'C--x' };

describe('P-0 resumeSession — only an UNTOUCHED tab is reused', () => {
  it('an untouched tab is reused (empty arrays/objects count as untouched)', async () => {
    for (const prep of [null, (t) => { t.addDirs = []; }, (t) => { t.subagents = {}; }, (t) => { t.attachments = []; }]) {
      const w = resumeWorld(prep);
      await w.ctx.resumeSession(SESSION, false);
      assert.equal(w.calls.newTab, 0);
      assert.equal(w.calls.started[0][1], w.first, 'the session went to another tab');
    }
  });

  const TOUCHED = {
    'a running chat': (t) => { t.id = 'c1'; },
    'a session id': (t) => { t.sessionId = SID(9); },
    'a dormant session': (t) => { t.pending = { sessionId: SID(9) }; },
    'a transcript row': (t) => { t.msgEl.childElementCount = 1; },
    'a pasted attachment (it would ride along with the next message)': (t) => { t.attachments = [{ name: 'shot.png', kind: 'image' }]; },
    'a start in flight': (t) => { t._starting = true; },
    'a resume in flight': (t) => { t._resuming = true; },
    'a selector pick (cfgTouched)': (t) => { t.cfgTouched = true; },
    'an MCP scope': (t) => { t.mcpServers = ['jira']; },
    'an explicit „all servers"': (t) => { t.mcpServers = null; },
    'a project (even „none")': (t) => { t.projectId = ''; },
    'extra roots': (t) => { t.addDirs = ['C:\\repo']; },
    'an agent': (t) => { t.agent = 'reviewer'; },
    'a worktree wish': (t) => { t.worktree = true; },
    'a budget cap': (t) => { t.maxBudgetUsd = 1; },
    'guardrails': (t) => { t.guardrails = 'T01 ist Test'; },
    'a subagent policy': (t) => { t.subagents = { model: 'haiku' }; },
    'an Ultracode choice (also OFF)': (t) => { t.ultracode = false; },
  };
  for (const [what, prep] of Object.entries(TOUCHED)) {
    it('a tab with ' + what + ' is left alone — the session opens in a new tab', async () => {
      const w = resumeWorld(prep);
      await w.ctx.resumeSession(SESSION, true);
      assert.equal(w.calls.newTab, 1, 'the touched tab was reused');
      assert.notEqual(w.calls.started[0][1], w.first);
      assert.equal(w.calls.started[0][1], w.ctx.ACTIVE);
      assert.deepEqual(plain(w.calls.started[0][0]), { resume: SESSION.id, cwd: SESSION.projectPath, fork: true });
    });
  }
});

// ---- 3b. offerLastSession — the boot button's fallback took the active tab as it was -----------------------
// „▶ Letzte Sitzung fortsetzen" (commands.js) goes through resumeSession when the session list knows the id, and
// straight into startChat({resume}, ACTIVE) when it does not — past the rule above. The button stays in the empty
// state until it is clicked, so the tab it lands in can have been set up for something else by then.
const COMMANDS = read('commands.js');
function lastSessionWorld(prep) {
  const calls = { newTab: 0, started: [] };
  const mk = () => ({ id: null, sessionId: null, title: 'Neuer Chat', attachments: [], msgEl: { childElementCount: 0 } });
  const first = mk(); if (prep) prep(first);
  let btn = null;
  const ls = { cc_last_session: JSON.stringify({ id: SID(5), cwd: 'C:/x' }) };
  const ctx = world({
    ACTIVE: first, chat: { id: null }, SESSIONS: [], t: (k) => k, toast: () => {},
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null) },
    $: (s) => (s === '#chatEmpty' ? { appendChild: (b) => { btn = b; } } : null),
    el: () => ({ style: {} }),
    newTab: () => { calls.newTab++; ctx.ACTIVE = mk(); return ctx.ACTIVE; },
    startChat: async (extra, tab) => { calls.started.push([extra, tab]); },
    resumeSession: () => { throw new Error('premise: the id is not in SESSIONS — the fallback branch is under test'); },
    api: async () => ({ open: false }), // the button's probe (CHAT-FLOW-4 part B, lastSessionMark): nobody holds it
  }, [liftFn(COMMANDS, 'offerLastSession', 'commands.js'), liftFn(COMMANDS, 'lastSessionMark', 'commands.js'), liftFn(CHAT, 'tabUntouched', 'chat.js')].join('\n'));
  return { ctx, calls, first, click: async () => { ctx.offerLastSession(); assert.ok(btn, 'premise: the button was offered'); await btn.onclick(); } };
}

describe('P-0 offerLastSession — the boot button follows the same rule', () => {
  it('an untouched tab takes the session', async () => {
    const w = lastSessionWorld();
    await w.click();
    assert.equal(w.calls.newTab, 0);
    assert.equal(w.calls.started[0][1], w.first);
    assert.deepEqual(plain(w.calls.started[0][0]), { resume: SID(5), cwd: 'C:/x' });
  });
  for (const [what, prep] of Object.entries({
    'a selector pick': (t) => { t.cfgTouched = true; }, 'extra roots': (t) => { t.addDirs = ['C:/repo']; },
    'an MCP scope': (t) => { t.mcpServers = ['jira']; }, 'a pasted attachment': (t) => { t.attachments = [{ name: 'a.png' }]; },
  })) {
    it('a tab with ' + what + ' is left alone — the session opens in a new tab', async () => {
      const w = lastSessionWorld(prep);
      await w.click();
      assert.equal(w.calls.newTab, 1, 'the touched tab was reused');
      assert.notEqual(w.calls.started[0][1], w.first);
    });
  }
});
