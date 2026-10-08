'use strict';
// CHAT-FLOW-4 — two panel windows on ONE session, run instead of re-enacted.
//
// What happened before the fix (the ping-pong): window B restores the tabs window A persisted and resumes A's
// session; the server ends A's process without a word, A's stream closes, A takes that for a reaped chat and —
// onerror → reconnectIdleTabs → resumeDormant — resumes straight back, ending B's process. Every input then
// cost up to three processes and the turn of the message that was being answered.
//
// HOW: each window is its own node:vm context holding the SHIPPED browser functions — lifted by name out of
// chat.js, chat-events.js, chat-composer.js, sessions.js and commands.js (the same seam test/event-pump.js and
// test/plan-wiring.test.js use). The two windows share what real windows share: one localStorage (cc_tabs),
// one clock, and one server. The server is a stand-in with the contract the real one has — that contract
// (409 session-open-elsewhere, `takeover`, `_superseded` before the stream ends, the probe) is pinned against
// the real lib/chat.js + server.js in test/terminate-chat.test.js and test/integration.test.js. Its `old` mode
// is the server before the fix: end every process of the session, tell nobody. And it sends `init` only with
// the FIRST message, as the real CLI does (measured, chat-events.js startChat): fake-claude sends it at spawn,
// and with that the old ping-pong would never end, because the `_starting` guard in reconnectIdleTabs is
// what brakes it.
//
// The stub list is EXPLICIT on purpose. The Proxy-`with` pattern answers every unknown name with a no-op — and
// a reconnectIdleTabs that was not lifted would then be a silent no-op too, which is exactly the call the
// ping-pong runs through. Here an unknown name is a ReferenceError, and every `typeof X === 'function'` guard in
// the lifted code must be lifted, stubbed, or listed in ABSENT with the reason it may be absent.
//
// Part B (cc_tabs per window, the suites at the end) adds what real windows have besides: a sessionStorage of
// their own, and one Web Locks manager for all of them (test/fake-locks.js — checked against Node's real
// navigator.locks in test/tab-windows.test.js), in which a closed or reloaded window's locks fall (`win.close()`)
// and a frozen one keeps them while it runs nothing (`sh.locks.freeze`, Edge sleeping tabs).
// The part-A suites above it run WITHOUT navigator.locks, i.e. in the deliberate fallback of chat.js tabsBoot:
// there a second window still restores the first one's tabs — exactly the situation part A has to make safe.
// Every window boots through the shipped tabsBoot (boot.js), not through a restoreTabs() of its own.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { liftFn } = require('./event-pump');
const { makeLocks } = require('./fake-locks');

const PUB = path.join(__dirname, '..', 'public', 'js');
const SRC = Object.fromEntries(['chat.js', 'chat-events.js', 'chat-composer.js', 'sessions.js', 'commands.js', 'views-uiskills.js', 'render.js', 'tab-windows.js']
  .map((f) => [f, fs.readFileSync(path.join(PUB, f), 'utf8')]));
const constSrc = (file, name) => { const m = new RegExp('^const ' + name + ' = .*;$', 'm').exec(SRC[file]); assert.ok(m, name + ' moved'); return m[0]; };

const S = '11111111-2222-4333-8444-555555555555'; // the one session both windows want
const TURN_MS = 5000;                               // how long the fake model takes for a turn
const flush = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };

// ---- a DOM just big enough: elements with classes, children, text, a click handler --------------------
class FakeEl {
  constructor(tag) { this.tagName = String(tag || 'div').toUpperCase(); this.children = []; this.parentElement = null; this.cls = new Set(); this.text = ''; this.attrs = {}; this.style = {}; this.dataset = {}; this.value = ''; this.disabled = false; this.onclick = null; this.scrollTop = 0; this.scrollHeight = 0; }
  get className() { return [...this.cls].join(' '); }
  set className(v) { this.cls = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
  get classList() { const c = this.cls; return { add: (...a) => a.forEach((x) => c.add(x)), remove: (...a) => a.forEach((x) => c.delete(x)), contains: (x) => c.has(x), toggle: (x, on) => { const w = on === undefined ? !c.has(x) : !!on; if (w) c.add(x); else c.delete(x); return w; } }; }
  get textContent() { return this.text + this.children.map((k) => k.textContent).join(''); }
  set textContent(v) { this.text = String(v == null ? '' : v); this.children = []; }
  set innerHTML(v) { this.text = ''; for (const k of this.children) k.parentElement = null; this.children = []; }
  get innerHTML() { return ''; }
  get childElementCount() { return this.children.length; }
  get isConnected() { let n = this; while (n.parentElement) n = n.parentElement; return !!n.isRoot; }
  appendChild(k) { if (k.parentElement) k.remove(); k.parentElement = this; this.children.push(k); return k; }
  remove() { const p = this.parentElement; if (p) { p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; } }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  querySelectorAll(sel) {
    const m = /^\.([\w-]+)$/.exec(String(sel).trim());
    if (!m) throw new Error('fake DOM cannot read the selector ' + sel);
    const out = []; const walk = (n) => n.children.forEach((k) => { if (k.cls.has(m[1])) out.push(k); walk(k); }); walk(this); return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  focus() {}
}
const rootEl = () => { const e = new FakeEl('div'); e.isRoot = true; return e; };
const buttons = (n) => n.children.flatMap((k) => (k.tagName === 'BUTTON' ? [k] : buttons(k)));

// ---- one clock for everybody: the windows' timers and the server's turn timers ------------------------
function makeClock() {
  let now = 0, seq = 0; const timers = new Map();
  return {
    get now() { return now; },
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (Number(ms) || 0), fn, id }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    // runs every timer due within `ms`, in order, with the microtasks in between. Bounded: a timer that keeps
    // re-arming itself at the same instant is a loop in the code under test, and must fail, not hang.
    async advance(ms) {
      const end = now + ms;
      for (let steps = 0; ; steps++) {
        if (steps > 5000) throw new Error('the clock ran 5000 timers in ' + ms + ' ms — something re-arms itself in a loop');
        await flush();
        const due = [...timers.values()].filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers.delete(due.id); now = due.at; due.fn();
      }
      now = end; await flush();
    },
  };
}

// ---- the server stand-in -------------------------------------------------------------------------------
// mode 'new': the owner rule of lib/chat.js sessionHold (an attached stream, or a fresh process inside its claim
// window), 409 unless `takeover`, `_superseded` to an attached owner before its stream ends. mode 'old': end
// every process of the session and tell nobody — the server before the fix.
// A COPY of the rule, so no test in this file can catch a regression of the real one. The real rule is pinned
// where it lives — lib/chat.js holdsSession/sessionHold in test/terminate-chat.test.js, the route (pre-check,
// loop, fork exemption, the start of a gone browser) in test/integration.test.js. Change it there first, then here.
function fakeServer(clock, mode) {
  const srv = { mode, chats: new Map(), seq: 0, kills: 0, turnsLost: 0, turnsDone: 0, starts: [], sends: [], probes: 0 };
  const holders = (sid) => [...srv.chats.values()].filter((c) => c.alive && c.sid === sid && (c.clients.size > 0 || (!c.everAttached && clock.now - c.created < 5000)));
  const fail = (status, error, extra) => { const e = new Error(error); e.status = status; e.code = (extra && extra.code) || ''; e.data = Object.assign({ error }, extra || {}); return e; };
  srv.push = (c, ev) => { ev._seq = ++c.fseq; for (const es of [...c.clients]) if (es.onmessage) es.onmessage({ data: JSON.stringify(ev) }); };
  // the browser's side of a stream the server ended: CONNECTING + error, then `retry: 2000` → reconnect
  srv.dropStream = (es) => { if (es.closed) return; es.readyState = 0; if (es.onerror) es.onerror(); clock.setTimeout(() => { if (!es.closed) srv.connect(es); }, 2000); };
  srv.kill = (c, why) => {
    c.alive = false; srv.chats.delete(c.id);
    if (why !== 'stop') { srv.kills++; if (c.turnOpen) srv.turnsLost++; }
    for (const es of [...c.clients]) { c.clients.delete(es); srv.dropStream(es); }
  };
  srv.connect = (es) => {
    const c = srv.chats.get(es.chatId);
    if (c && c.alive) { es.readyState = 1; c.clients.add(es); c.everAttached = true; clock.setTimeout(() => { if (!es.closed && es.onopen) es.onopen(); }, 0); }
    else { es.readyState = 2; clock.setTimeout(() => { if (!es.closed && es.onerror) es.onerror(); }, 0); } // 404 → CLOSED
  };
  srv.disconnect = (es) => { for (const c of srv.chats.values()) c.clients.delete(es); };
  srv.api = (win) => async (p, opts) => {
    await null;
    const method = (opts && opts.method) || 'GET';
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (method === 'POST' && p === '/api/chat/start') {
      srv.starts.push({ win: win.name, body });
      const sid = body.resume || ('fresh-' + (srv.seq + 1));
      if (body.resume && !body.fork) {
        const h = holders(sid);
        if (srv.mode === 'new' && body.takeover !== true && h.length) {
          throw fail(409, 'session open elsewhere', { code: 'session-open-elsewhere', busy: h.some((c) => c.turnOpen), starting: h.every((c) => !c.clients.size) });
        }
        for (const c of [...srv.chats.values()].filter((x) => x.alive && x.sid === sid)) {
          if (srv.mode === 'new' && c.clients.size) srv.push(c, { type: '_superseded' });
          srv.kill(c);
        }
      }
      const c = { id: 'chat-' + (++srv.seq), sid, clients: new Set(), alive: true, created: clock.now, everAttached: false, initSent: false, turnOpen: false, fseq: 0, owner: win.name };
      srv.chats.set(c.id, c);
      return { chatId: c.id, meta: {} };
    }
    let m = /^\/api\/chat\/([^/]+)\/(stop|send)$/.exec(p);
    if (m && method === 'POST') {
      const c = srv.chats.get(m[1]);
      if (m[2] === 'stop') { if (c) srv.kill(c, 'stop'); return { ok: true }; }
      if (!c || !c.alive) throw fail(404, 'chat not found');
      srv.sends.push({ win: win.name, chat: c.id, text: body.text });
      c.turnOpen = true;
      // the real CLI's `init` (and with it the `_session` the server pushes) only arrives with the first message
      if (!c.initSent) { c.initSent = true; srv.push(c, { type: '_session', session_id: c.sid }); srv.push(c, { type: 'system', subtype: 'init', session_id: c.sid }); }
      clock.setTimeout(() => { if (c.alive && c.turnOpen) { c.turnOpen = false; srv.turnsDone++; } }, TURN_MS);
      return { ok: true };
    }
    m = /^\/api\/session\/open\?id=(.*)$/.exec(p);
    if (m && method === 'GET') {
      srv.probes++;
      if (srv.mode === 'old') throw fail(404, 'not found'); // the old server has no probe
      const h = holders(decodeURIComponent(m[1]));
      return { open: h.length > 0, busy: h.some((c) => c.turnOpen), starting: h.length > 0 && h.every((c) => !c.clients.size) };
    }
    throw fail(404, 'not found');
  };
  return srv;
}

// ---- a window --------------------------------------------------------------------------------------------
const LIFT = {
  'chat.js': ['withTab', 'makeTab', 'activateTab', 'newTab', 'sessionChipText', 'refreshSessionChip', 'persistTabs', 'restoreTabs',
    'resumeDormant', '_resumeDormantNow', 'reconnectIdleTabs', 'healDeadChat', 'holdQueueAfterResume', 'tabHeldElsewhere', 'findSessionTab',
    'takeoverQuestion', 'heldElsewhereError', 'takeBackTab', 'restartResume', '_restartResumeNow', 'whenResumeSettled', 'sessionRefFor',
    'takePendingRunCfg', 'tabCanStop', 'tabHasLiveWork', 'isDefaultTitle', 'syncRunSelectors', 'ensureModelOption', 'tabRestoreLaunch', 'tabRestoreFallback', 'modeInfo', 'tabUntouched',
    'tabsLocks', 'tabsReclaim', 'tabsBoot', 'tabsStore', 'tabsRead', 'tabsWrite', 'tabsSetItems', 'tabsWarnUnsaved', 'tabsBootDraft'],
  'chat-events.js': ['handleEvent', 'trackTurnFrames', 'handleEventBody', 'endTabProcess', 'supersedeTab', 'markTabElsewhere',
    'sessionElsewhereCard', 'clearStartSafety', 'armStartSafety', 'startChat', 'openResumeInChat', 'retireTypedModel'],
  'chat-composer.js': ['ensureChatStarted', 'sendMessage', 'deliverText', 'markSendFailed', 'markCtxOp', 'markTypedModel'],
  'sessions.js': ['resumeSession'],
  'commands.js': ['saveLastSession', 'offerLastSession', 'lastSessionMark'],
};
// typeof-guarded names the lifted code may find missing, and why that is the real browser's state too (or
// harmless here). Anything guarded that is in none of LIFT / stubs / this list fails the harness.
const ABSENT = new Set([
  'planOrphanSet', 'planAdopt', 'planAdoptOrphan', 'planLastRestore', 'planSave', 'planNoteOutgoing', 'planOutgoingKind', 'planOutgoingSettled', 'planQueuedStale', 'planQueueNoted', // the plan rail: not this test's business
  'ctxForgetContext', 'ctxForgetModel', 'ctxProbe', 'updateCtxGauge', 'clearCtxDrainTimers', 'startCtxDrain', // the context gauge
  'renderQueueStrip', 'restoreOpenPointCards', 'openPointsAnswerFrom', 'refreshUltracodeState', 'pingServer', 'refreshPermJump',
  'dropPermsForTab', 'interruptTab', 'showView', 'chatSideRefresh', 'renderAttachChips', 'applyChatDefaults', 'refreshDefaultsPin',
  'applyEffortLevelsForModel', 'retargetFollowObserver', 'commandsFromFrame', 'sessionStateNote', 'monitorEvent', 'laneAppendText',
  'agentDetailNoteText', 'ctxEnv', 'uiSkillChatTurnResult', 'turnEndBadge', 'pendingRunCfgReady', 'chatSessionGoneCard', 'trimTranscript',
  // branches of handleEventBody this harness never feeds — it sends `_session`, `system/init` and `_superseded`
  // only; assistant / user / result / stream / budget frames are other suites' (event-pump, plan-wiring, budget-ui)
  'fmtUSD', 'planChanged', 'normalizeRateLimit', 'takeOpenPoints', 'takePlanStatus', 'planNoteTools', 'trackTaskCreateResult',
  'trackTaskUpdateResult', 'planGateLost', 'planCardOrphan', 'planCandidateOf', 'toolStoreOut', 'monitorReceipt', 'refreshInterruptBtn',
  'turnCostUSD', 'turnEndInfo', 'collectOpenPoints', 'planStartTargetId', 'planAutoAskSteps',
  'projectAdoptStart', 'ensureProjects', 'projById', // the project label (Projekte Stufe 2) — projects-ui.test.js drives it
  'onBail', // a PARAMETER of uiRunFollowUp, not a global — the scan cannot tell the two apart
  'stopVoiceInput', // activateTab ends a dictation; the browser has none without the Web Speech API, this harness neither
  'resumeStage', 'resumeFinish', // the resume's stage read-out (chat.js) — the box and chip it paints are not this test's business
]);

// opts.lift: more { file: [names] } to lift; opts.stubs(rec, el): more stubs — both go through the same audit;
// opts.consts: [[file, name]] module consts that need lifted functions (persistTabsSoon = debounce(persistTabs)),
// run after the lift. opts.locks: this window has navigator.locks (the shared fake) and a sessionStorage
// (opts.session, else a fresh one) — without it, the fallback of tabsBoot, as in a browser without Web Locks.
function makeWindow(name, sh, opts) {
  opts = opts || {};
  const rec = (k) => { const f = (...a) => { (win.calls[k] = win.calls[k] || []).push(a); }; return f; };
  const win = { name, calls: {}, confirms: [], confirmAnswer: false, toasts: [] };
  const ids = {};
  const scroll = rootEl();
  win.warns = [];
  win.session = opts.locks ? (opts.session || makeSession()) : null;
  const stubs = {
    console: { log: console.log, error: console.error, warn: (...a) => { win.warns.push(a.map(String).join(' ')); } },
    JSON, Object, Array, String, Number, Boolean, Math, Date, Map, Set, Promise, Error, RegExp, encodeURIComponent, decodeURIComponent, isFinite,
    setTimeout: sh.clock.setTimeout, clearTimeout: sh.clock.clearTimeout,
    localStorage: sh.storage.forWin(name),
    ...(opts.locks ? { navigator: { locks: sh.locks.client(name) }, sessionStorage: win.session } : {}),
    api: sh.srv.api(win),
    EventSource: class FakeES {
      constructor(url) { this.url = url; this.readyState = 0; this.closed = false; this.onmessage = this.onerror = this.onopen = null; this.chatId = /\/api\/chat\/([^/?]+)\/stream/.exec(url)[1]; sh.srv.connect(this); }
      close() { this.closed = true; this.readyState = 2; sh.srv.disconnect(this); }
    },
    uiConfirm: (msg) => { win.confirms.push(msg); return Promise.resolve(win.confirmAnswer); },
    toast: (msg, kind) => { win.toasts.push([String(msg), kind]); },
    el: (tag, cls, txt) => { const e = new FakeEl(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; },
    // #resumeLast is looked up by id the way the page does (offerLastSession removes the old button by it)
    $: (sel) => {
      if (sel === '#chatScroll') return scroll;
      if (sel === '#resumeLast') return stubs.$('#chatEmpty').children.find((b) => b.id === 'resumeLast') || null;
      return ids[sel] || (ids[sel] = new FakeEl('div'));
    },
    $$: () => [],
    tt: (k) => String(k), t: (k) => String(k),
    // the module state of chat.js / chat-composer.js (their top-level `let`s), at its boot values
    TABS: [], ACTIVE: null, chat: null, TAB_SEQ: 0, TAB_HUES: [265, 200], CWD_EDIT: false, _reconnecting: false, SESSIONS: [], CHAT_COMMANDS: [], EDIT_TARGET: null,
    CHAT_DEFAULTS: { model: '', effort: '', permMode: 'plan' }, // chat.js's boot value with nothing stored
    MODELS_CACHE: null, // the model list is not loaded at boot — ensureModelOption (#94) then adds nothing
    STATE: {}, STYLE_PROMPTS: {}, DISPLAY: { style: '', guard: false }, PHASE_WORKING: 'phase:working', RECONNECT_PHASE: 'phase:reconnect', START_SAFETY_MS: 20000,
    // the transcript repaint of a resume: one marker row, so a test can tell „repainted" from „torn down"
    renderResumeHistory: async (s, tab) => { tab.msgEl.appendChild(stubs.el('div', 'history-row', 'history ' + s.id)); },
    loadSessions: async () => {},
    addMsg: (role, text) => { const m = stubs.el('div', 'msg ' + role, text); stubs.chat.msgEl.appendChild(m); return { m, b: m }; },
    hasHeldGate: () => false, typedReplyCard: () => null, ctxWindowSave: () => undefined, ctxAdoptSavedWindow: () => {},
    // #94: a typed /model is remembered on the send path (markTypedModel) and dropped at a restart
    // (retireTypedModel); the parser is the REAL one from ctx.js, so a resume that re-sends a /model is judged
    // here as the browser judges it
    ctxTypedModelArg: require('../public/js/ctx').ctxTypedModelArg,
    // CHAT-FLOW-3: handleEventBody asks it about every frame — the REAL predicate, so a frame of this harness
    // that would adopt a turn does so here as it does in the browser
    turnOpenedByCli: require('../public/js/turn-end').turnOpenedByCli,
    closeTab: rec('closeTab'), logEvent: rec('logEvent'), composerSet: rec('composerSet'), setTabTitle: rec('setTabTitle'),
  };
  for (const k of ['renderTabs', 'renderStatusBar', 'renderStatus', 'renderAgentStrip', 'renderSteps', 'renderTodoStrip', 'renderStreamEl', 'updateScrollBtn',
    'keepTabFocus', 'autoGrow', 'setComposerEnabled', 'updateCwdRowVisibility', 'startTurnStatus', 'stopTurnStatus', 'showResumeLoading', 'hideResumeLoading',
    'scrollBottom', 'setComposerBusy', 'clearAsksForTab', 'clearAskWaitersForTab', 'clearAgents', 'retirePlanCards', 'pruneToolCards', 'clearQueue',
    'pushRecentCwd', 'refreshCwdList', 'staleQuickReplies', 'cacheMcpTools', 'markTabDone', 'trackHookEvent', 'noteUnknownSystemFrame']) stubs[k] = rec(k);
  // the resume loader keeps its state on the tab, as the real one keeps its block in the tab's transcript: shown
  // only for the visible tab (chat.js showResumeLoading), gone after hide — so a test can see one left standing
  const showRec = stubs.showResumeLoading, hideRec = stubs.hideResumeLoading;
  stubs.showResumeLoading = (t) => { showRec(t); const tab = t || stubs.ACTIVE; if (tab && tab === stubs.ACTIVE) tab._loaderShown = true; };
  stubs.hideResumeLoading = (t) => { hideRec(t); const tab = t || stubs.ACTIVE; if (tab) tab._loaderShown = false; };
  if (opts.stubs) Object.assign(stubs, opts.stubs(rec, stubs.el));
  win.ctx = vm.createContext(stubs);
  // the module chat.js reads its rules from (tab-windows.js), loaded whole the way its <script> tag loads it
  vm.runInContext(SRC['tab-windows.js'], win.ctx, { filename: 'tab-windows.js' });
  // the constants the lifted code reads, taken from the source like the functions: the send path's (markCtxOp),
  // the restore's (#93 P-0: which saved mode a reload may start a tab in, tabRestoreLaunch/Fallback) and the
  // window's place in cc_tabs (part B, TABWIN)
  for (const [file, name] of [['chat-composer.js', 'CTX_COMMANDS'], ['chat.js', 'TAB_RESTORE_MODES'], ['chat.js', 'TAB_RESTORE_SAFE_MODE'], ['chat.js', 'LIVE_EFFORT_LEVELS'], ['chat.js', 'TABWIN']]) {
    vm.runInContext(constSrc(file, name), win.ctx);
  }
  const lifted = [];
  const lifts = Object.entries(LIFT).concat(Object.entries(opts.lift || {}));
  for (const [file, names] of lifts) for (const n of names) { const src = liftFn(SRC[file], n, file); lifted.push(src); vm.runInContext(src, win.ctx, { filename: file + '#' + n }); }
  for (const [file, name] of opts.consts || []) vm.runInContext(constSrc(file, name), win.ctx);
  // every guarded name is accounted for — the one place a missing lift could hide
  const guarded = new Set([...lifted.join('\n').matchAll(/typeof (\w+) === 'function'/g)].map((x) => x[1]));
  const liftedNames = new Set(lifts.flatMap(([, names]) => names).concat((opts.consts || []).map(([, n]) => n)));
  const loose = [...guarded].filter((g) => !liftedNames.has(g) && !(g in stubs) && !ABSENT.has(g));
  assert.deepEqual(loose, [], 'a typeof-guarded name nobody accounted for — lift it, stub it, or say in ABSENT why it may be missing');
  win.run = (code) => vm.runInContext(code, win.ctx);
  // the boot as boot.js runs it: chat-perms.js has made the first tab, boot.js takes the window id back first
  // (tabsReclaim, before it waits for /api/state), then tabsBoot decides. restoreTabs catches a failing entry and
  // only console.warns it (so one bad entry cannot cost the others) — which also hid a missing lift here as „no
  // tab restored". The harness says it instead. startBoot for a boot the test must drive the clock through (a
  // duplicate's grace); load() alone for the page standing in boot.js's wait for /api/state — then startBoot
  // (or win.run('tabsBoot()')) is the answer arriving.
  win.load = () => { win.loaded = true; win.run('activateTab(makeTab())'); win.run('tabsReclaim()'); };
  win.startBoot = () => { if (!win.loaded) win.load(); return win.run('tabsBoot()'); };
  win.boot = async (pending) => {
    const ok = await (pending || win.startBoot());
    assert.deepEqual(win.warns.filter((w) => /restore tab failed|boot fell back|persist tabs failed/.test(w)), [], 'the boot threw inside its own catch — a lift or stub is missing');
    return ok;
  };
  // the window's document goes (closed, crashed, reloaded): its streams close, its locks fall
  win.close = () => { for (const t of win.ctx.TABS) if (t.es) t.es.close(); sh.locks.drop(name); };
  win.tab = () => win.ctx.ACTIVE;
  win.send = async (tab, text) => { await win.ctx.sendMessage({ text, tab }); await flush(); };
  win.startsHere = () => sh.srv.starts.filter((s) => s.win === name);
  return win;
}
function makeSession(from) {
  const m = new Map(from ? from.map : []);
  return { map: m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

// One localStorage for every window, as real windows of one origin have — with a log of every cc_tabs access
// (who, and whether that window held the cc_tabs lock at that moment) and an optional quota for cc_tabs.
function shared(mode) {
  const clock = makeClock();
  const store = new Map();
  const locks = makeLocks();
  const access = [];
  const sh = { clock, store, locks, access, quota: null, srv: fakeServer(clock, mode) };
  const storage = sh.storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } };
  storage.forWin = (win) => ({
    getItem: (k) => { if (k === 'cc_tabs') access.push({ win, op: 'get', locked: locks.holds(win, 'cc_tabs') }); return storage.getItem(k); },
    setItem: (k, v) => {
      if (k === 'cc_tabs') {
        access.push({ win, op: 'set', locked: locks.holds(win, 'cc_tabs') });
        if (sh.quota != null && String(v).length > sh.quota) { const e = new Error('QuotaExceededError (synthetisch)'); e.name = 'QuotaExceededError'; throw e; }
      }
      storage.setItem(k, v);
    },
    removeItem: (k) => storage.removeItem(k),
  });
  return sh;
}
// window A: restored with session S, one message sent (so `init` came and `_starting` is false), turn finished
async function liveA(sh) {
  sh.storage.setItem('cc_tabs', JSON.stringify([{ sessionId: S, title: 'Sitzung S', cwd: 'C:\\w' }]));
  const A = makeWindow('A', sh);
  assert.equal(await A.boot(), true, 'A restored its tab');
  await sh.clock.advance(10);
  const tA = A.tab();
  assert.ok(tA.id, 'A resumed S');
  await A.send(tA, 'hallo aus A');
  assert.equal(tA._starting, false, 'premise: A got its init');
  await sh.clock.advance(TURN_MS + 10);
  return { A, tA };
}
const cardOf = (tab) => tab.msgEl.querySelector('sess-elsewhere'.replace(/^/, '.'));
// what every scenario must hold: only a CONFIRMED takeover sends `takeover: true` — restore, reconnect, heal and
// deliverText never do, so no automatic path can end another window's process
function onlyConfirmedTakeovers(sh, ...wins) {
  const takeovers = sh.srv.starts.filter((s) => s.body.takeover === true);
  const confirmedYes = wins.reduce((n, w) => n + (w.confirmAnswer ? w.confirms.length : 0), 0);
  assert.ok(takeovers.length <= confirmedYes, takeovers.length + ' takeover(s) sent, but only ' + confirmedYes + ' confirm(s) answered yes');
}

describe('two windows, one session (CHAT-FLOW-4)', () => {
  it('S0 — the harness can show the ping-pong: against the OLD server, B boots and sends → ≥ 3 processes ended and the turn of B\'s message lost', async () => {
    const sh = shared('old');
    await liveA(sh);
    const B = makeWindow('B', sh);
    await B.boot();
    await sh.clock.advance(1000);
    // B's message goes out BEFORE A's automatic take-back (retry 2000 ms + reconnect 400 ms) — only then is the
    // turn the one that dies; sent later it would survive and only the kill count would show it
    await B.send(B.tab(), 'hallo aus B');
    await sh.clock.advance(12000);
    assert.ok(sh.srv.kills >= 3, 'the harness no longer shows the ping-pong (kills: ' + sh.srv.kills + ') — then the tests below prove nothing');
    assert.ok(sh.srv.turnsLost >= 1, 'B\'s turn survived the old server — the harness timing is off');
  });

  it('S1 — B boots with A\'s tabs: nothing is ended, B\'s tab says „woanders offen" with the takeover, and stays quiet', async () => {
    const sh = shared('new');
    const { tA } = await liveA(sh);
    const B = makeWindow('B', sh);
    await B.boot();
    await sh.clock.advance(10);
    const tB = B.tab();
    assert.equal(sh.srv.kills, 0, 'B\'s restore ended A\'s process');
    assert.ok(sh.srv.chats.get(tA.id), 'A\'s chat is gone');
    assert.ok(tB._elsewhere, 'B\'s tab does not know it is held elsewhere');
    assert.equal(tB.id, null);
    assert.equal(!!tB._starting, false, 'the chip hangs on „◌ startet…"');
    assert.match(B.run('sessionChipText(ACTIVE)'), /^⇄ chat\.anderswoOffen · 11111111$/, 'the status chip hides the state');
    const card = cardOf(tB);
    assert.ok(card, 'no card in B\'s tab');
    assert.deepEqual(buttons(card).map((b) => b.textContent), ['chat-events.hierUebernehmen', 'chat-events.erneutPruefen', 'chat-events.tabSchliessen']);
    // A is idle and attached: the card says „attached elsewhere" — not the claim-window text, and no running turn
    assert.ok(card.textContent.includes('chat-events.anderswoText'), 'the card does not say why: ' + card.textContent);
    assert.ok(!card.textContent.includes('chat-events.anderswoTurnLief'), 'the card invents a turn running in A');
    assert.equal(B.toasts.filter(([m]) => /tabKonnteNichtFortgesetzt/.test(m)).length, 0, 'the refusal was toasted as a failure');
    // persistable by B's own write — not just still standing in what A wrote before B booted
    sh.storage.removeItem('cc_tabs');
    B.run('persistTabs()');
    assert.equal((JSON.parse(sh.storage.getItem('cc_tabs') || '[]')[0] || {}).sessionId, S, 'the held tab must stay persistable');
    // the automatic paths stay away: reconnect after sleep, focus, the next minutes
    const n = B.startsHere().length;
    B.run('reconnectIdleTabs()');
    await sh.clock.advance(10000);
    assert.equal(B.startsHere().length, n, 'B resumed again by itself');
    assert.equal(sh.srv.kills, 0);
    onlyConfirmedTakeovers(sh, B);
  });

  it('S2 — activating B\'s held tab again does not ask the server again', async () => {
    const sh = shared('new');
    await liveA(sh);
    const B = makeWindow('B', sh);
    await B.boot();
    await sh.clock.advance(10);
    const n = B.startsHere().length;
    B.run('activateTab(ACTIVE)');
    B.run('activateTab(newTab())'); B.run('activateTab(TABS[0])');
    await sh.clock.advance(10);
    assert.equal(B.startsHere().length, n, 'every activation re-POSTed the resume (and tore the transcript down for the same 409)');
    assert.ok(cardOf(B.run('TABS[0]')), 'the card is gone');
  });

  it('S3 — [Hier übernehmen] in B: one confirmed takeover, one process ended, A is told — and A never takes it back by itself', async () => {
    const sh = shared('new');
    const { A, tA } = await liveA(sh);
    const B = makeWindow('B', sh);
    await B.boot();
    await sh.clock.advance(10);
    const tB = B.tab();
    tB.queue = [{ text: 'wartet in B' }];
    tA.queue = [{ text: 'wartet in A' }];
    tA._turnOpen = true; // as a main-thread frame of A's process leaves it (trackTurnFrames) — the takeover cuts that turn
    B.confirmAnswer = true;
    const aStarts = A.startsHere().length;
    buttons(cardOf(tB)).find((b) => b.textContent === 'chat-events.hierUebernehmen').onclick();
    await sh.clock.advance(10);
    assert.equal(B.confirms.length, 1, 'the takeover was not confirmed first');
    assert.equal(B.confirms[0], 'chat.uebernehmenText', 'A had no open turn — the confirm must not invent one');
    const tk = sh.srv.starts.filter((s) => s.body.takeover === true);
    assert.equal(tk.length, 1); assert.equal(tk[0].win, 'B');
    assert.equal(sh.srv.kills, 1, 'exactly A\'s process');
    assert.ok(tB.id && !tB._elsewhere, 'B runs the session now');
    assert.equal(tB.queuePaused, 'resume', 'what B had queued is held after the takeover, not sent by itself');
    // the status chip of B says what B is now — it was painted before the POST, with the flags still set
    assert.equal(B.ctx.$('#sessionChip').textContent, '◦ chat.idle · 11111111', 'B\'s chip still says „anderswo offen" after the takeover');
    // A: told, not reconnecting
    assert.equal(tA._superseded, true, 'A did not learn that it was taken over');
    assert.equal(tA.id, null);
    assert.equal(tA.es, null);
    assert.ok(cardOf(tA), 'no card in A');
    assert.deepEqual(buttons(cardOf(tA)).map((b) => b.textContent), ['chat-events.zurueckholen', 'chat-events.tabSchliessen']);
    assert.match(A.ctx.$('#sessionChip').textContent, /^⇄ chat\.anderswoOffen · 11111111$/);
    assert.equal(tA._turnOpen, false, 'A\'s cut turn stays open — the plan rail would count a tab without a process as busy');
    // the visible tab's takeover goes to the 🔔 log once — no toast (the card is in view), so no second entry
    assert.equal((A.calls.logEvent || []).length, 1);
    assert.equal(A.toasts.filter(([m]) => m === 'chat-events.uebernommenToast').length, 0);
    // a decision another window made does not throw away what A had queued — and it is HELD, since no `result`
    // will ever come to drain it in a tab without a process
    assert.equal(A.calls.clearQueue, undefined, 'the takeover emptied A\'s queue');
    assert.deepEqual(tA.queue.map((q) => q.text), ['wartet in A']);
    assert.equal(tA.queuePaused, 'elsewhere', 'A\'s queue is neither held nor drainable — „⏳ Warteschlange" with no button');
    await sh.clock.advance(3000);
    A.run('reconnectIdleTabs()');
    await sh.clock.advance(3000);
    assert.equal(A.startsHere().length, aStarts, 'A resumed the session back by itself');
    assert.equal(sh.srv.kills, 1);
    onlyConfirmedTakeovers(sh, A, B);
    // [Zurückholen] in A: confirmed, one takeover — and A's chip and queue say what A is now
    A.confirmAnswer = true;
    buttons(cardOf(tA)).find((b) => b.textContent === 'chat-events.zurueckholen').onclick();
    await sh.clock.advance(10);
    assert.equal(sh.srv.starts.filter((s) => s.body.takeover === true && s.win === 'A').length, 1);
    assert.equal(sh.srv.kills, 2, 'exactly B\'s process');
    assert.ok(tA.id && !tA._superseded);
    assert.equal(tB._superseded, true);
    assert.equal(A.ctx.$('#sessionChip').textContent, '◦ chat.idle · 11111111', 'A\'s chip still says „anderswo offen" after [Zurückholen]');
    assert.equal(tA.queuePaused, 'resume', 'A\'s held queue keeps the „Sitzung anderswo" words after taking it back');
    onlyConfirmedTakeovers(sh, A, B);
  });

  it('S3b — a taken-over BACKGROUND tab: one toast (which writes the 🔔 log itself), no second log entry', async () => {
    const sh = shared('new');
    const { A, tA } = await liveA(sh);
    A.run('activateTab(newTab())'); // A looks at another tab when B takes S over
    const B = makeWindow('B', sh);
    await B.boot(); await sh.clock.advance(10);
    B.confirmAnswer = true;
    buttons(cardOf(B.tab())).find((b) => b.textContent === 'chat-events.hierUebernehmen').onclick();
    await sh.clock.advance(10);
    assert.equal(tA._superseded, true, 'premise');
    assert.equal(A.toasts.filter(([m]) => m === 'chat-events.uebernommenToast').length, 1, 'the background takeover was not said where the user looks');
    assert.equal(A.calls.logEvent, undefined, 'the same takeover stands in the 🔔 log twice (toast + logEvent)');
  });

  it('S4 — typing in the taken-over A: no start, no kill, the transcript and its card stay; the confirm names a turn running in B', async () => {
    const sh = shared('new');
    const { A, tA } = await liveA(sh);
    const B = makeWindow('B', sh);
    await B.boot();
    await sh.clock.advance(10);
    B.confirmAnswer = true;
    buttons(cardOf(B.tab())).find((b) => b.textContent === 'chat-events.hierUebernehmen').onclick();
    await sh.clock.advance(10);
    assert.equal(tA._superseded, true, 'premise');
    const aStarts = A.startsHere().length, aSends = sh.srv.sends.filter((s) => s.win === 'A').length;
    A.confirmAnswer = false;
    await A.send(tA, 'bin ich noch dran?');
    assert.equal(A.startsHere().length, aStarts, 'a message in the taken-over tab resumed it');
    assert.equal(sh.srv.kills, 1);
    assert.equal(sh.srv.sends.filter((s) => s.win === 'A').length, aSends, 'the message went out');
    assert.ok(cardOf(tA), 'the transcript (and the card in it) was torn down');
    assert.equal(!!tA._starting, false, 'the chip hangs on „◌ startet…"');
    assert.deepEqual(A.confirms, ['chat.uebernehmenText'], 'no takeover offer before the send');
    assert.ok(A.toasts.some(([m]) => m === 'chat.nichtGesendetAnderswo'), 'nobody said why the message did not go out');
    // a turn running in B → A's next offer says so, because it asks the server at the moment of the click
    await B.send(B.tab(), 'B arbeitet');
    await A.send(tA, 'und jetzt?');
    assert.equal(A.confirms[1], 'chat.uebernehmenTurnLaeuft', 'the confirm hid the turn that a takeover would cancel');
    assert.equal(sh.srv.turnsLost, 0);
    onlyConfirmedTakeovers(sh, A, B);
  });

  it('the queue A kept: held, and its real [Jetzt senden] (strip → flushQueue → deliverText) offers the takeover, nothing resumes by itself', async () => {
    const sh = shared('new');
    sh.storage.setItem('cc_tabs', JSON.stringify([{ sessionId: S, title: 'Sitzung S', cwd: 'C:\\w' }]));
    // A with the queue strip's button and the flush lifted, so the click is the shipped one end to end
    const A = makeWindow('A', sh, {
      lift: { 'chat.js': ['queueWaitText'], 'chat-composer.js': ['renderQueueStateBtns', 'flushQueue'] },
      stubs: (rec) => ({ openCardOf: () => null, renderQueueStrip: rec('renderQueueStrip'), inertBtn: rec('inertBtn'), queueChanged: rec('queueChanged') }),
    });
    await A.boot(); await sh.clock.advance(10);
    const tA = A.tab();
    await A.send(tA, 'hallo aus A'); await sh.clock.advance(TURN_MS + 10);
    tA.queue = [{ text: 'aus der Warteschlange', attachments: [] }];
    const B = makeWindow('B', sh);
    await B.boot(); await sh.clock.advance(10);
    B.confirmAnswer = true;
    buttons(cardOf(B.tab())).find((b) => b.textContent === 'chat-events.hierUebernehmen').onclick();
    await sh.clock.advance(10);
    assert.equal(tA._superseded, true, 'premise');
    const strip = new FakeEl('div');
    A.ctx.renderQueueStateBtns(strip, tA);
    assert.ok(strip.textContent.includes('chat-composer.angehaltenAnderswo'), 'the strip does not say why the queue waits: ' + strip.textContent);
    const now = buttons(strip).find((b) => b.textContent === '▶ chat-composer.jetztSenden');
    assert.ok(now, 'no [Jetzt senden] — nothing can ever send what A kept');
    assert.equal(now.title, 'chat-composer.jetztSendenTitelAnderswo');
    const aStarts = A.startsHere().length;
    A.confirmAnswer = false;
    now.onclick();
    await sh.clock.advance(10);
    assert.equal(A.startsHere().length, aStarts, 'deliverText resumed a session another window had taken');
    assert.deepEqual(A.confirms, ['chat.uebernehmenText'], 'the takeover was not offered');
    assert.ok(cardOf(tA), 'the transcript was torn down');
    assert.ok(A.toasts.some(([m]) => m === 'chat.nichtGesendetAnderswo'));
    // the bubble keeps the text and says why once — „Nicht gesendet · Nicht gesendet — …" said it twice
    const failed = tA.msgEl.querySelector('.sf-msg');
    assert.ok(failed, 'the bubble does not say it did not go out');
    assert.equal(failed.textContent, '⚠ chat-composer.nichtGesendet · render.sitzungAnderswoOffen');
    assert.equal(sh.srv.kills, 1);
  });

  it('a send whose chat was taken while its stream hung (no `_superseded` reached it): the automatic resume meets the 409 — the text comes back below the card, not lost', async () => {
    const sh = shared('new');
    const { A, tA } = await liveA(sh);
    // A's stream is in a reconnect gap: no client on the server, so B's plain resume ends A's process and tells nobody
    sh.srv.disconnect(tA.es);
    const B = makeWindow('B', sh);
    await B.boot(); await sh.clock.advance(10);
    assert.ok(B.tab().id, 'premise: B resumed S (A was not attached)');
    assert.ok(!tA._superseded, 'premise: A heard nothing');
    await A.send(tA, 'noch da?');
    await sh.clock.advance(10);
    assert.ok(cardOf(tA), 'premise: A met B\'s 409 and shows the card');
    const bubbles = tA.msgEl.querySelectorAll('.user').filter((m) => m.textContent.startsWith('noch da?'));
    assert.equal(bubbles.length, 1, 'the text is gone — the transcript was emptied with the bubble and the composer was already cleared');
    assert.ok(bubbles[0].querySelector('.send-failed-row'), 'the bubble does not say it did not go out');
    onlyConfirmedTakeovers(sh, A, B);
  });

  it('a queued send in the taken-over tab whose plain resume is refused after all (free at the probe, held at the start): the text comes back below the card', async () => {
    const sh = shared('new');
    const { A, tA } = await liveA(sh);
    const B = makeWindow('B', sh);
    await B.boot(); await sh.clock.advance(10);
    B.confirmAnswer = true;
    buttons(cardOf(B.tab())).find((b) => b.textContent === 'chat-events.hierUebernehmen').onclick();
    await sh.clock.advance(10);
    assert.equal(tA._superseded, true, 'premise');
    // the race takeBackTab cannot rule out: the probe says nobody holds it, B's stream is attached again by the start
    const realApi = A.ctx.api;
    A.ctx.api = (p, o) => (/^\/api\/session\/open/.test(p) ? Promise.resolve({ open: false, busy: false, starting: false }) : realApi(p, o));
    const node = A.run('withTab(TABS[0], () => addMsg("user", "aus der Warteschlange")).m');
    const ok = await A.ctx.deliverText(tA, 'aus der Warteschlange', [], node);
    await sh.clock.advance(10);
    assert.equal(ok, false);
    assert.ok(cardOf(tA), 'premise: the plain resume met B\'s 409');
    const bubbles = tA.msgEl.querySelectorAll('.user').filter((m) => m.textContent.startsWith('aus der Warteschlange'));
    assert.equal(bubbles.length, 1, 'the text went with the transcript the refused resume emptied');
    assert.ok(bubbles[0].querySelector('.send-failed-row'));
    assert.equal(sh.srv.kills, 1, 'the plain resume ended B');
  });

  it('a dead-chat answer (heal) in the taken-over tab offers nothing behind the user\'s back', async () => {
    const sh = shared('new');
    const { A, tA } = await liveA(sh);
    const B = makeWindow('B', sh);
    await B.boot(); await sh.clock.advance(10);
    B.confirmAnswer = true;
    buttons(cardOf(B.tab())).find((b) => b.textContent === 'chat-events.hierUebernehmen').onclick();
    await sh.clock.advance(10);
    const aStarts = A.startsHere().length;
    const handled = A.ctx.healDeadChat(tA, new Error('chat not found'));
    await sh.clock.advance(10);
    assert.equal(handled, true);
    assert.equal(A.startsHere().length, aStarts, 'healDeadChat resumed a session another window had taken');
    assert.ok(cardOf(tA));
    // …nor later: `pending` is what activateTab resumes, and the heal used to set it before asking whether the
    // tab is held — the next tab switch then traded A's transcript for B's 409 card
    assert.ok(!tA.pending, 'the heal left the taken-over tab pending');
    A.run('activateTab(newTab())'); A.run('activateTab(TABS[0])');
    await sh.clock.advance(10);
    assert.equal(A.startsHere().length, aStarts, 'a tab switch after the heal resumed the taken-over tab');
    assert.deepEqual(buttons(cardOf(tA)).map((b) => b.textContent), ['chat-events.zurueckholen', 'chat-events.tabSchliessen'], 'the card turned from „übernommen" into „woanders offen"');
  });

  it('a taken-over tab that carries `pending` is not resumed by a tab switch (the second fence, activateTab)', async () => {
    const sh = shared('new');
    const { A, tA } = await liveA(sh);
    const B = makeWindow('B', sh);
    await B.boot(); await sh.clock.advance(10);
    B.confirmAnswer = true;
    buttons(cardOf(B.tab())).find((b) => b.textContent === 'chat-events.hierUebernehmen').onclick();
    await sh.clock.advance(10);
    assert.equal(tA._superseded, true, 'premise');
    // the state healDeadChat left before its fix; no shipped path builds it now — this pins activateTab's own guard
    tA.pending = { sessionId: S, cwd: 'C:\\w' };
    const aStarts = A.startsHere().length;
    A.run('activateTab(newTab())'); A.run('activateTab(TABS[0])');
    await sh.clock.advance(10);
    assert.equal(A.startsHere().length, aStarts, 'activating a taken-over tab resumed it');
    assert.ok(cardOf(tA));
  });
});

// ---- what the card and the confirm SAY — every branch, both ways ------------------------------------------
// The fault class of this project is a text that claims more than the code knows. Each sentence below has a
// condition, and each condition is driven here in both directions: the line is there when it holds, and absent
// when it does not.
describe('the card and the confirm say only what the server reported (CHAT-FLOW-4)', () => {
  const take = (tab) => buttons(cardOf(tab)).find((b) => b.textContent === 'chat-events.hierUebernehmen');
  const again = (tab) => buttons(cardOf(tab)).find((b) => b.textContent === 'chat-events.erneutPruefen');

  it('a turn running in A when B is refused: the card says so (and S1 pins the idle case without the line)', async () => {
    const sh = shared('new');
    const { A, tA } = await liveA(sh);
    await A.send(tA, 'A arbeitet'); // the turn runs TURN_MS
    const B = makeWindow('B', sh);
    await B.boot(); await sh.clock.advance(10);
    const card = cardOf(B.tab());
    assert.ok(card, 'premise');
    assert.ok(card.textContent.includes('⚠ chat-events.anderswoTurnLief'), 'the card hides the turn the 409 reported: ' + card.textContent);
  });

  it('the claim window (a start nobody attached to yet): the card and the confirm say „gerade gestartet", not „hängt ein Tab"', async () => {
    const sh = shared('new');
    // a process of S that no stream has attached to — a window that is booting at this moment, a scheduled run
    await sh.srv.api({ name: 'X' })('/api/chat/start', { method: 'POST', body: JSON.stringify({ resume: S }) });
    sh.storage.setItem('cc_tabs', JSON.stringify([{ sessionId: S, title: 'Sitzung S', cwd: 'C:\\w' }]));
    const B = makeWindow('B', sh);
    await B.boot(); await sh.clock.advance(10);
    const tB = B.tab();
    assert.equal(tB._elsewhere && tB._elsewhere.starting, true, 'premise: the 409 said starting');
    const card = cardOf(tB);
    assert.ok(card.textContent.includes('chat-events.anderswoStartetText'), 'the card claims a tab is attached: ' + card.textContent);
    assert.ok(!card.textContent.includes('chat-events.anderswoText'));
    B.confirmAnswer = false;
    take(tB).onclick(); await sh.clock.advance(10);
    assert.deepEqual(B.confirms, ['chat.uebernehmenStartet'], 'the confirm claims something other than a fresh start');
  });

  it('the probe fails: the confirm says it could not check — never „is open … ends the process there"', async () => {
    const sh = shared('new');
    await liveA(sh);
    const B = makeWindow('B', sh);
    await B.boot(); await sh.clock.advance(10);
    const realApi = B.ctx.api;
    B.ctx.api = (p, o) => (/^\/api\/session\/open/.test(p) ? Promise.reject(new Error('503 (synthetisch)')) : realApi(p, o));
    B.confirmAnswer = false;
    take(B.tab()).onclick(); await sh.clock.advance(10);
    assert.deepEqual(B.confirms, ['chat.uebernehmenUngeprueft']);
    assert.equal(sh.srv.kills, 0);
  });

  it('[Erneut prüfen] while A holds: no start, no confirm, the card shows what the server says NOW; once A let go: one plain resume', async () => {
    const sh = shared('new');
    const { A, tA } = await liveA(sh);
    const B = makeWindow('B', sh);
    await B.boot(); await sh.clock.advance(10);
    const tB = B.tab();
    assert.equal(tB._elsewhere.busy, false, 'premise: A was idle at the 409');
    tB.msgEl.appendChild(new FakeEl('div')).className = 'keep-me'; // a row of the transcript — the check must not tear it down
    const n = B.startsHere().length;
    await A.send(tA, 'A arbeitet');
    again(tB).onclick(); await sh.clock.advance(10);
    assert.equal(B.startsHere().length, n, '[Erneut prüfen] POSTed a resume to learn what the probe already says');
    assert.ok(tB.msgEl.querySelector('.keep-me'), 'the check tore the transcript down');
    assert.deepEqual(B.confirms, []);
    assert.equal(tB._elsewhere.busy, true, 'the check did not keep what the server answered');
    assert.ok(cardOf(tB).textContent.includes('chat-events.anderswoTurnLief'), 'the card still shows the old answer');
    // A lets go (its stream is gone — a closed tab, a closed window)
    tA.es.close();
    again(tB).onclick(); await sh.clock.advance(10);
    const mine = B.startsHere().slice(n);
    assert.equal(mine.length, 1, 'one resume, once nobody holds it');
    assert.notEqual(mine[0].body.takeover, true, 'a takeover nobody confirmed');
    assert.deepEqual(B.confirms, [], 'a confirm for a session nobody holds');
    assert.ok(tB.id && !tB._elsewhere);
    assert.equal(B.ctx.$('#sessionChip').textContent, '◦ chat.idle · 11111111', 'the chip still says „anderswo offen"');
    onlyConfirmedTakeovers(sh, A, B);
  });

  it('[Erneut prüfen] when the probe itself fails: says so and stops — no blind resume, the transcript stays', async () => {
    const sh = shared('new');
    await liveA(sh);
    const B = makeWindow('B', sh);
    await B.boot(); await sh.clock.advance(10);
    const tB = B.tab();
    tB.msgEl.appendChild(new FakeEl('div')).className = 'keep-me';
    const realApi = B.ctx.api;
    B.ctx.api = (p, o) => (/^\/api\/session\/open/.test(p) ? Promise.reject(new Error('503 (synthetisch)')) : realApi(p, o));
    const n = B.startsHere().length;
    again(tB).onclick(); await sh.clock.advance(10);
    assert.equal(B.startsHere().length, n, 'a failed check resumed blind');
    assert.deepEqual(B.confirms, []);
    assert.ok(tB.msgEl.querySelector('.keep-me'), 'the transcript was torn down');
    assert.ok(cardOf(tB), 'the card is gone');
    assert.ok(B.toasts.some(([m, k]) => m === 'chat.pruefenFehlgeschlagen503 (synthetisch)' && k === 'err'), 'nobody said the check failed: ' + JSON.stringify(B.toasts));
  });
});

// ---- the active entries, for a session another WINDOW holds ----------------------------------------------
// „Fortsetzen" in the Sitzungsliste (palette, usage table), „In Chat fortsetzen" and „▶ Letzte Sitzung" in a
// fresh window B while A holds the session: the 409 is not an error, the takeover is offered right away (the
// click was for it), and declined, the card still offers it.
describe('the resume entries meet a session another window holds (CHAT-FLOW-4)', () => {
  const ENTRIES = {
    resumeSession: async (B) => { await B.ctx.resumeSession({ id: S, title: 'Sitzung S', projectPath: 'C:\\w', project: 'C--w' }, false); },
    openResumeInChat: async (B) => { B.ctx.openResumeInChat(S, 'C:\\w'); },
    offerLastSession: async (B, sh) => {
      sh.storage.setItem('cc_last_session', JSON.stringify({ id: S, cwd: 'C:\\w' }));
      B.ctx.offerLastSession();
      const btn = B.ctx.$('#chatEmpty').children.find((b) => b.id === 'resumeLast');
      assert.ok(btn, 'premise: the button is offered on B\'s empty tab');
      await btn.onclick();
    },
  };
  for (const [entry, run] of Object.entries(ENTRIES)) {
    it(entry + ': nothing ended, the card, exactly one confirm, no error toast, the loader gone, the empty-state hidden; declined, the card asks again and takes over once', async () => {
      const sh = shared('new');
      const { A, tA } = await liveA(sh);
      sh.storage.removeItem('cc_tabs'); // a fresh window: nothing to restore
      const B = makeWindow('B', sh);
      await B.boot(); await sh.clock.advance(10);
      B.confirmAnswer = false;
      await run(B, sh);
      await sh.clock.advance(10);
      const tB = B.tab();
      assert.equal(sh.srv.kills, 0, 'the resume ended A\'s process');
      assert.ok(tB._elsewhere, 'B\'s tab does not know it is held elsewhere');
      assert.ok(cardOf(tB), 'no card');
      assert.deepEqual(B.confirms, ['chat.uebernehmenText'], 'the takeover was not offered right away (or more than once)');
      assert.deepEqual(B.toasts.filter(([, k]) => k === 'err'), [], 'the refusal was toasted as an error');
      assert.equal(!!tB._loaderShown, false, 'the loader stays and the composer stays locked for its 20 s safety');
      assert.ok(B.ctx.$('#chatEmpty').classList.contains('hidden'), '„Unterhaltung starten" stands above the card');
      // the card's button: asks again, and takes over exactly once
      B.confirmAnswer = true;
      buttons(cardOf(tB)).find((b) => b.textContent === 'chat-events.hierUebernehmen').onclick();
      await sh.clock.advance(10);
      assert.equal(B.confirms.length, 2, 'the card\'s button is dead');
      assert.equal(sh.srv.starts.filter((s) => s.body.takeover === true).length, 1);
      assert.equal(sh.srv.kills, 1);
      assert.ok(tB.id, 'B does not run the session');
      assert.equal(tA._superseded, true);
      onlyConfirmedTakeovers(sh, A, B);
    });
  }
});

describe('one window, one session twice (CHAT-FLOW-4)', () => {
  it('Sitzungsliste / Palette „Fortsetzen" and „In Chat fortsetzen" on a session open in a tab of THIS window → that tab, no second resume', async () => {
    const sh = shared('new');
    const { A, tA } = await liveA(sh);
    A.run('activateTab(newTab())');
    const tabs = A.ctx.TABS.length, starts = A.startsHere().length;
    await A.ctx.resumeSession({ id: S, title: 'Sitzung S', projectPath: 'C:\\w', project: 'C--w' }, false);
    assert.equal(A.ctx.ACTIVE, tA, 'resumeSession did not switch to the tab that has it');
    A.run('activateTab(TABS[1])');
    A.ctx.openResumeInChat(S, 'C:\\w');
    await sh.clock.advance(10);
    assert.equal(A.ctx.ACTIVE, tA, '„In Chat fortsetzen" did not switch to the tab that has it');
    assert.equal(A.ctx.TABS.length, tabs, 'a second tab was opened on the same session');
    assert.equal(A.startsHere().length, starts, 'the session was resumed a second time');
    // „▶ Letzte Sitzung fortsetzen" on the empty tab — its session is not in SESSIONS here, so this is the
    // branch that used to start the resume straight into the empty tab
    A.run('activateTab(TABS[1])');
    sh.storage.setItem('cc_last_session', JSON.stringify({ id: S, cwd: 'C:\\w' }));
    A.ctx.offerLastSession();
    const last = A.ctx.$('#chatEmpty').children.find((b) => b.id === 'resumeLast');
    assert.ok(last, 'premise: the button is offered on the empty tab');
    await last.onclick();
    await sh.clock.advance(10);
    assert.equal(A.ctx.ACTIVE, tA, '„Letzte Sitzung fortsetzen" did not switch to the tab that has it');
    assert.equal(A.startsHere().length, starts, 'the last session was resumed into a second tab');
    assert.equal(sh.srv.kills, 0);
    // a FORK is a new session — never redirected
    await A.ctx.resumeSession({ id: S, title: 'Sitzung S', projectPath: 'C:\\w', project: 'C--w' }, true);
    assert.equal(A.startsHere().length, starts + 1, 'a fork must still start');
    assert.equal(A.startsHere().pop().body.fork, true);
  });
});

// ---- the UI-skill runner ------------------------------------------------------------------------------
// The run card holds a session too: its own stream while a turn runs, none once it finished (uiRunFinish closes
// it, the process lives on for a follow-up). Lifted out of views-uiskills.js the same way, in a window of its own.
const RUN_LIFT = ['uiRunResume', 'uiRunTurn', 'uiRunHeldElsewhere', 'uiRunReattach', 'uiRunHandle', 'uiRunBody', 'uiRunStreamLost', 'uiRunStatus', 'uiRunFinish', 'uiRunFollowUp',
  'runSteps', 'uiSendAndAwait', 'uiWaitIfPaused'];
function runWindow(sh) {
  const w = makeWindow('R', sh, {
    lift: { 'views-uiskills.js': RUN_LIFT },
    stubs: (rec, el) => ({
      uiRunTick: rec('uiRunTick'), updateStartBtn: rec('updateStartBtn'), extractResults: () => null, recordUiRun: rec('recordUiRun'),
      iconBtn: (cls) => el('button', cls), copyText: rec('copyText'), uiRunScroll: rec('uiRunScroll'), maybeChain: rec('maybeChain'),
      expandRunTranscript: rec('expandRunTranscript'), uiNotify: rec('uiNotify'), flashDocTitle: rec('flashDocTitle'), lastKeys: () => null,
      document: { hidden: false }, setInterval: () => 0, clearInterval: () => {},
      // the step runner's surroundings: the step rows, the prompt template, and the two gates — the retry gate
      // records and answers „stop", so a test can see it was offered without the run hanging on it
      markStep: rec('markStep'), uiInterpolate: (p) => p, uiConfirmGate: rec('uiConfirmGate'), uiEditPromptModal: rec('uiEditPromptModal'),
      uiRetryGate: (...a) => { (w.calls.uiRetryGate = w.calls.uiRetryGate || []).push(a); return Promise.resolve('stop'); },
    }),
  });
  w.calls.recordUiRun = []; // what a finished run leaves in the history — its status is the record's
  return w;
}
function makeRun(w, chatId) {
  const run = { id: 'r1', chatId, es: null, sessionId: S, skill: { name: 'sk', manifest: { title: 'Skill', run: {} } }, tab: { msgEl: rootEl() },
    statusEl: new FakeEl('span'), dotEl: new FakeEl('span'), done: false, status: 'running', lastSeq: 0, batch: true, steps: [] };
  return run;
}
const statusOf = (run) => run.statusEl.textContent;

describe('UI-skill runs and the session they hold (CHAT-FLOW-4)', () => {
  it('a follow-up whose /send failed: the run closes its OWN stream before the resume — it is not refused by itself', async () => {
    const sh = shared('new');
    const R = runWindow(sh);
    const first = await sh.srv.api(R)('/api/chat/start', { method: 'POST', body: JSON.stringify({ resume: S }) });
    const run = makeRun(R, first.chatId);
    R.ctx.uiRunReattach(run); // the follow-up re-attaches first (uiRunFollowUp)
    await sh.clock.advance(10);
    assert.equal(sh.srv.chats.get(first.chatId).clients.size, 1, 'premise: the run\'s stream is attached');
    // the /send fails for a reason that is NOT a dead chat (network, 500) — then uiRunTurn resumes anyway
    const realApi = R.ctx.api; let failed = false;
    R.ctx.api = (p, o) => { if (!failed && /\/send$/.test(p)) { failed = true; return Promise.reject(new Error('500 (synthetisch)')); } return realApi(p, o); };
    R.ctx.uiRunTurn(run, 'weiter'); // not awaited: it settles on the turn's `result`, which this server never sends
    await sh.clock.advance(10);
    assert.notEqual(run.heldElsewhere, true, 'the run was refused because of its own stream');
    assert.notEqual(run.chatId, first.chatId, 'no new process');
    assert.equal(sh.srv.sends.length, 1, 'the turn did not go out after the resume');
  });

  it('a follow-up while a chat tab holds the session (after „In Chat fortsetzen"): its own notice with the takeover, nothing ended', async () => {
    const sh = shared('new');
    const { tA } = await liveA(sh);           // the chat tab that „In Chat fortsetzen" opened, attached to S
    const R = runWindow(sh);
    const run = makeRun(R, 'chat-gone');      // the run's own process is long gone (reaped)
    run.done = true;
    await R.ctx.uiRunFollowUp(run, 'Folgeschritt');
    await sh.clock.advance(10);
    assert.equal(sh.srv.kills, 0, 'the follow-up ended the chat tab\'s process');
    assert.ok(sh.srv.chats.get(tA.id), 'the chat tab\'s chat is gone');
    assert.equal(run.heldElsewhere, true);
    assert.equal(statusOf(run), 'views-uiskills.sitzungAnderswoKurz', 'the card says only „Fehler"');
    const notice = run.tab.msgEl.querySelector('.ui-run-elsewhere');
    assert.ok(notice, 'no notice in the run');
    assert.ok(!notice.textContent.includes('views-uiskills.sitzungAnderswoTurn'), 'the notice invents a turn running in the chat tab');
    // [Hier übernehmen] → the confirm, then the SAME follow-up again, now with the takeover
    R.confirmAnswer = true;
    buttons(notice).find((b) => b.textContent === 'chat-events.hierUebernehmen').onclick();
    await sh.clock.advance(10);
    assert.deepEqual(R.confirms, ['chat.uebernehmenText']);
    const tk = sh.srv.starts.filter((s) => s.body.takeover === true);
    assert.equal(tk.length, 1, 'the takeover did not go out (or more than once)');
    assert.equal(sh.srv.kills, 1);
    assert.equal(tA._superseded, true, 'the chat tab was not told');
    assert.deepEqual(sh.srv.sends.filter((s) => s.win === 'R').map((s) => s.text), ['Folgeschritt'], 'the follow-up text was not sent again after the takeover');
  });

  it('a follow-up while a chat tab with a RUNNING turn holds the session: the notice says a turn was running there', async () => {
    const sh = shared('new');
    const { A, tA } = await liveA(sh);
    await A.send(tA, 'A arbeitet');
    const R = runWindow(sh);
    const run = makeRun(R, 'chat-gone');
    run.done = true;
    await R.ctx.uiRunFollowUp(run, 'Folgeschritt');
    await sh.clock.advance(10);
    const notice = run.tab.msgEl.querySelector('.ui-run-elsewhere');
    assert.ok(notice, 'premise');
    assert.ok(notice.textContent.includes('views-uiskills.sitzungAnderswoTurn'), 'the notice hides the turn the 409 reported: ' + notice.textContent);
  });

  it('[Hier übernehmen] on the run\'s notice while another follow-up still runs: the follow-up bails, the confirmed takeover is taken back, the notice stays', async () => {
    const sh = shared('new');
    await liveA(sh);
    const R = runWindow(sh);
    const run = makeRun(R, 'chat-gone');
    run.done = true;
    await R.ctx.uiRunFollowUp(run, 'Folgeschritt');
    await sh.clock.advance(10);
    const notice = run.tab.msgEl.querySelector('.ui-run-elsewhere');
    assert.ok(notice, 'premise');
    run.followBusy = true; // another follow-up of this run is under way when the button is clicked
    R.confirmAnswer = true;
    await buttons(notice).find((b) => b.textContent === 'chat-events.hierUebernehmen').onclick();
    await sh.clock.advance(10);
    assert.ok(R.toasts.some(([m]) => m === 'views-uiskills.folgeschrittNochAktiv'), 'premise: the follow-up bailed');
    assert.notEqual(run._takeover, true, 'the takeover stayed armed for a follow-up nobody confirmed it for');
    assert.ok(run.tab.msgEl.querySelector('.ui-run-elsewhere'), 'the notice went with the bail — and the way to take over with it');
    // the next follow-up resumes the plain way: refused again, nothing ended
    run.followBusy = false;
    await R.ctx.uiRunFollowUp(run, 'später');
    await sh.clock.advance(10);
    assert.equal(sh.srv.starts.filter((s) => s.body.takeover === true).length, 0, 'a takeover went out without its confirm');
    assert.equal(sh.srv.kills, 0);
  });

  // a run whose own stream is attached (uiRunReattach, the shipped wiring) and a chat tab in window B that takes S
  async function takeRunOver(sh) {
    sh.storage.setItem('cc_tabs', JSON.stringify([{ sessionId: S, title: 'S', cwd: 'C:\\w' }]));
    const B = makeWindow('B', sh);
    await B.boot(); await sh.clock.advance(10);
    B.confirmAnswer = true;
    buttons(cardOf(B.tab())).find((b) => b.textContent === 'chat-events.hierUebernehmen').onclick();
    await sh.clock.advance(10);
    return B;
  }

  it('a chat tab takes a RUNNING run over: the run ends as „übernommen", not as „Verbindung verloren"', async () => {
    const sh = shared('new');
    const R = runWindow(sh);
    const st = await sh.srv.api(R)('/api/chat/start', { method: 'POST', body: JSON.stringify({ resume: S }) });
    const run = makeRun(R, st.chatId);
    R.ctx.uiRunReattach(run);
    await sh.clock.advance(10);
    await takeRunOver(sh);
    await sh.clock.advance(5000);
    assert.equal(run.superseded, true, 'the run did not hear `_superseded`');
    assert.equal(run.es, null);
    assert.equal(statusOf(run), 'views-uiskills.uebernommen');
    assert.deepEqual(R.calls.recordUiRun.map((a) => a[1]), ['stopped'], 'recorded as something other than stopped');
  });

  it('a FOLLOW-UP taken over mid-turn: recorded as stopped, not as an error', async () => {
    const sh = shared('new');
    const R = runWindow(sh);
    const st = await sh.srv.api(R)('/api/chat/start', { method: 'POST', body: JSON.stringify({ resume: S }) });
    const run = makeRun(R, st.chatId);
    run.done = true; // the first turn finished: uiRunFinish closed the stream, the process lives on
    const follow = R.ctx.uiRunFollowUp(run, 'Folgeschritt');
    await sh.clock.advance(10);
    assert.deepEqual(sh.srv.sends.map((s) => s.text), ['Folgeschritt'], 'premise: the follow-up went out and waits for its result');
    await takeRunOver(sh);
    await follow;
    assert.equal(run.superseded, true);
    assert.equal(statusOf(run), 'views-uiskills.uebernommen');
    assert.deepEqual(R.calls.recordUiRun.map((a) => a[1]), ['stopped'], 'the taken-over follow-up was recorded as something other than stopped');
  });

  it('a STEP run taken over mid-step: stopped as „übernommen" — no [Wiederholen] that could never work, step 2 never sent', async () => {
    const sh = shared('new');
    const R = runWindow(sh);
    const st = await sh.srv.api(R)('/api/chat/start', { method: 'POST', body: JSON.stringify({ resume: S }) });
    const run = makeRun(R, st.chatId);
    run.values = {};
    R.ctx.uiRunReattach(run);
    await sh.clock.advance(10);
    const done = R.ctx.runSteps(run, {}, [{ id: 's1', prompt: 'eins' }, { id: 's2', prompt: 'zwei' }]);
    await sh.clock.advance(10);
    assert.deepEqual(sh.srv.sends.map((s) => s.text), ['eins'], 'premise: step 1 is out and waits for its result');
    await takeRunOver(sh);
    await done;
    assert.equal(run.superseded, true);
    assert.equal(R.calls.uiRetryGate, undefined, '[Wiederholen] offered for a step this run can never repeat (it does not resume)');
    assert.deepEqual(sh.srv.sends.filter((s) => s.win === 'R').map((s) => s.text), ['eins'], 'step 2 went out');
    assert.deepEqual(R.calls.markStep.filter((a) => a[1] === 's1').map((a) => a[2]), ['running', 'error'], 'the cut step reads as done or skipped');
    assert.equal(statusOf(run), 'views-uiskills.uebernommen');
    assert.deepEqual(R.calls.recordUiRun.map((a) => a[1]), ['stopped'], 'recorded as something other than stopped');
  });
});

// =====================================================================================================
//  PART B — cc_tabs per window (PR-15b). Every window below has navigator.locks (the shared fake) and its own
//  sessionStorage, as a browser window has; `win.close()` is a closed, crashed or reloading document.
// =====================================================================================================
const SB = (n) => 'bbbbbbbb-0000-4000-8000-00000000000' + n;   // the sessions of these scenarios
const lockWin = (name, sh, o) => makeWindow(name, sh, Object.assign({ locks: true }, o || {}));
const stored = (sh) => JSON.parse(sh.storage.getItem('cc_tabs') || '[]');
const groupOf = (sh, win) => stored(sh).filter((e) => e.win === win).map((e) => e.sessionId);
const tabSids = (w) => w.ctx.TABS.map((t) => t.sessionId || (t.pending && t.pending.sessionId) || null);
const winId = (w) => w.run('TABWIN.win');
// decision 6: in a window with Web Locks, cc_tabs is read and written ONLY under the cc_tabs lock
function underLock(sh, ...wins) {
  const names = wins.map((w) => w.name);
  const loose = sh.access.filter((a) => names.includes(a.win) && !a.locked);
  assert.deepEqual(loose, [], 'cc_tabs read or written outside the cc_tabs lock: ' + JSON.stringify(loose));
  assert.ok(sh.access.some((a) => names.includes(a.win) && a.op === 'set'), 'premise: these windows wrote cc_tabs at all');
}
// window A: the first window, on a store an older panel left (no window ids) — it adopts that list
async function firstA(sh, list, o) {
  sh.storage.setItem('cc_tabs', JSON.stringify(list || [{ sessionId: SB(1), title: 'eins', cwd: 'C:\\w' }, { sessionId: SB(2), title: 'zwei', cwd: 'C:\\w' }]));
  const A = lockWin('A', sh, o);
  assert.equal(await A.boot(), true, 'premise: the first window restores the stored tabs');
  await sh.clock.advance(10);
  return A;
}
// the shipped draft path (commands.js saveDraft/clearDraft → persistTabsSoon), for a window whose typing matters
const TYPING = { lift: { 'commands.js': ['saveDraft', 'clearDraft'] }, consts: [['render.js', 'debounce'], ['chat.js', 'persistTabsSoon']] };
const resumeIn = async (w, sh, sid, title) => { await w.ctx.resumeSession({ id: sid, title: title || sid, projectPath: 'C:\\w', project: 'C--w' }, false); await sh.clock.advance(10); };

describe('part B — every window its own tab list (CHAT-FLOW-4)', () => {
  it('S5 — a fresh second window next to a live one starts EMPTY: none of A\'s tabs, nothing resumed, no draft of A\'s, „Letzte Sitzung" offered', async () => {
    const sh = shared('new');
    const A = await firstA(sh);
    await A.send(A.tab(), 'hallo aus A'); await sh.clock.advance(TURN_MS + 10); // init → cc_last_session = SB(1)
    sh.storage.setItem('cc_draft', 'in A getippt'); // the global draft the last typing window left (commands.js saveDraft)
    const before = stored(sh);
    // A is FROZEN while B boots (Edge sleeping tabs): it runs nothing and answers nothing — its lock alone says it
    // lives (decision 5: a busy or frozen window must not count as gone, which a reply within a settle time could
    // not promise)
    sh.locks.freeze('A');
    const B = lockWin('B', sh);
    assert.equal(await B.boot(), false, 'B restored tabs');
    await sh.clock.advance(10);
    assert.deepEqual(tabSids(B), [null], 'B shows A\'s tabs');
    assert.ok(B.run('tabUntouched(TABS[0])'));
    assert.equal(B.startsHere().length, 0, 'B resumed a session');
    assert.equal(sh.srv.kills, 0);
    assert.equal(B.ctx.$('#composerInput').value, '', 'B shows the draft A typed');
    assert.ok(B.ctx.$('#resumeLast'), 'no „Letzte Sitzung" in the empty second window');
    assert.deepEqual(stored(sh).filter((e) => e.win === winId(A)), before.filter((e) => e.win === winId(A)), 'B\'s boot changed A\'s entries');
    assert.notEqual(winId(B), winId(A));
    sh.locks.thaw('A'); await sh.clock.advance(10);
    underLock(sh, A, B);
  });

  it('S6 — a tab opened in B survives A\'s next write (a keystroke in A\'s draft, the shipped saveDraft → persistTabsSoon)', async () => {
    const sh = shared('new');
    const A = await firstA(sh, null, { lift: { 'commands.js': ['saveDraft'] }, consts: [['render.js', 'debounce'], ['chat.js', 'persistTabsSoon']] });
    const B = lockWin('B', sh);
    await B.boot(); await sh.clock.advance(10);
    await resumeIn(B, sh, SB(3), 'drei');
    assert.ok(stored(sh).some((x) => x.sessionId === SB(3)), 'premise: B wrote its tab');
    A.ctx.$('#composerInput').value = 'Entwurf in A';
    A.ctx.saveDraft();
    await sh.clock.advance(600);
    assert.ok(stored(sh).some((x) => x.sessionId === SB(3)), 'A\'s write dropped the tab B opened');
    assert.deepEqual(groupOf(sh, winId(B)), [SB(3)], '…and it is still B\'s');
    assert.deepEqual(groupOf(sh, winId(A)), [SB(1), SB(2)]);
    assert.equal(stored(sh).find((e) => e.sessionId === SB(1)).draft, 'Entwurf in A', 'premise: it was A\'s draft write');
    underLock(sh, A, B);
  });

  it('S7 — a reload of A (same window id) brings back A\'s tabs, A\'s active tab and A\'s drafts — not B\'s, although B wrote last', async () => {
    const sh = shared('new');
    const A = await firstA(sh);
    A.ctx.$('#composerInput').value = 'Entwurf eins';
    A.run('activateTab(TABS[1])'); // the draft goes with tab 1, tab 2 is resumed and active
    await sh.clock.advance(10);
    const B = lockWin('B', sh);
    await B.boot(); await sh.clock.advance(10);
    await resumeIn(B, sh, SB(3), 'drei');
    assert.equal(sh.storage.getItem('cc_tabs_active'), SB(3), 'premise: B wrote last — the global active key is B\'s');
    A.close();
    const A2 = lockWin('A2', sh, { session: A.session }); // a reload keeps sessionStorage
    assert.equal(await A2.boot(), true);
    await sh.clock.advance(10);
    assert.equal(A2.run('TABWIN.kind'), 'reload');
    assert.equal(winId(A2), winId(A), 'the reload took a new window id');
    assert.deepEqual(tabSids(A2), [SB(1), SB(2)], 'the reload restored another window\'s tabs');
    assert.equal(A2.ctx.ACTIVE.sessionId, SB(2), 'the reload landed on another tab than A\'s active one');
    assert.equal(A2.ctx.TABS[0].draft, 'Entwurf eins', 'the draft did not come back with its tab');
    assert.deepEqual(groupOf(sh, winId(B)), [SB(3)], 'B\'s entries changed');
    underLock(sh, A, B, A2);
  });

  it('S7b — a reload of a window WITHOUT a session tab brings back its own draft, not the one another window typed last; the first window after a restart still gets the global one', async () => {
    const sh = shared('new');
    // the shipped draft path (commands.js saveDraft), in every window
    const typing = { lift: { 'commands.js': ['saveDraft', 'clearDraft'] }, consts: [['render.js', 'debounce'], ['chat.js', 'persistTabsSoon']] };
    const A = lockWin('A', sh, typing);
    assert.equal(await A.boot(), false, 'premise: nothing stored, nothing restored');
    await sh.clock.advance(10);
    A.ctx.$('#composerInput').value = 'Entwurf in A'; A.ctx.saveDraft();
    const B = lockWin('B', sh, typing);
    await B.boot(); await sh.clock.advance(10);
    assert.equal(B.ctx.$('#composerInput').value, '', 'premise (S5): the second window shows no draft of A\'s');
    B.ctx.$('#composerInput').value = 'Entwurf in B'; B.ctx.saveDraft();
    assert.equal(sh.storage.getItem('cc_draft'), 'Entwurf in B', 'premise: B typed last — the global draft is B\'s');
    A.close();
    const A2 = lockWin('A2', sh, Object.assign({ session: A.session }, typing));
    assert.equal(await A2.boot(), false); await sh.clock.advance(10);
    assert.equal(A2.run('TABWIN.kind'), 'reload');
    assert.equal(A2.ctx.$('#composerInput').value, 'Entwurf in A', 'the reload showed another window\'s draft, or lost its own');
    // a sent message empties it (clearDraft): the next reload shows nothing — not B's text either
    A2.ctx.$('#composerInput').value = ''; A2.ctx.clearDraft();
    A2.close();
    const A3 = lockWin('A3', sh, Object.assign({ session: A.session }, typing));
    await A3.boot(); await sh.clock.advance(10);
    assert.equal(A3.ctx.$('#composerInput').value, '', 'a draft that was sent came back with the reload');
    // every window gone, a fresh one: the global draft as before part B (the last typing of any window)
    B.ctx.$('#composerInput').value = 'Entwurf in B'; B.ctx.saveDraft();
    A3.close(); B.close();
    const C = lockWin('C', sh, typing);
    await C.boot(); await sh.clock.advance(10);
    assert.equal(C.ctx.$('#composerInput').value, 'Entwurf in B', 'the first window after a restart lost the global draft');
    underLock(sh, A, B, A2, A3, C);
  });

  it('S7c — a reload of a window WITHOUT tabs of its own, all alone: nothing restored — not the tabs of a window closed meanwhile, nothing resumed, its own draft; that group stays for a real first window', async () => {
    const sh = shared('new');
    const A = lockWin('A', sh, TYPING);
    assert.equal(await A.boot(), false, 'premise: nothing stored, nothing restored');
    await sh.clock.advance(10);
    A.ctx.$('#composerInput').value = 'Entwurf in A'; A.ctx.saveDraft();
    // B: the second window (start.cmd once more) — empty, works on SB(3), and is closed
    const B = lockWin('B', sh, TYPING);
    await B.boot(); await sh.clock.advance(10);
    await resumeIn(B, sh, SB(3), 'drei');
    B.ctx.$('#composerInput').value = 'Entwurf in B'; B.ctx.saveDraft();
    await sh.clock.advance(600);
    const bWin = winId(B);
    B.close();
    // F5 in A, which is alone now
    A.close();
    const starts = sh.srv.starts.length;
    const A2 = lockWin('A2', sh, Object.assign({ session: A.session }, TYPING));
    assert.equal(await A2.boot(), false, 'the reload brought back the tabs of the window closed before it');
    await sh.clock.advance(10);
    assert.equal(A2.run('TABWIN.kind'), 'reload');
    assert.deepEqual(tabSids(A2), [null]);
    assert.equal(sh.srv.starts.length, starts, 'the reload resumed a session of the closed window — claude.exe and its MCP servers, without a click');
    assert.equal(A2.ctx.$('#composerInput').value, 'Entwurf in A', 'the reload showed another window\'s draft, or lost its own');
    assert.deepEqual(groupOf(sh, bWin), [SB(3)], 'the closed window\'s group was taken (or lost)');
    // a window that really is a first one (no id of its own) still adopts it
    A2.close();
    const C = lockWin('C', sh);
    assert.equal(await C.boot(), true, 'the leftover group is gone for the next first window too');
    assert.deepEqual(tabSids(C), [SB(3)]);
    underLock(sh, A, B, A2, C);
  });

  it('S7d — the empty second window outlives the first and reloads: it does not take the first window\'s tabs, and that window, back with its sessionStorage, gets them', async () => {
    const sh = shared('new');
    const A = await firstA(sh);
    const aWin = winId(A);
    const B = lockWin('B', sh, TYPING);
    await B.boot(); await sh.clock.advance(10);
    B.ctx.$('#composerInput').value = 'Entwurf in B'; B.ctx.saveDraft();
    A.close();
    B.close();
    const starts = sh.srv.starts.length;
    const B2 = lockWin('B2', sh, Object.assign({ session: B.session }, TYPING));
    assert.equal(await B2.boot(), false, 'B\'s reload took A\'s tabs');
    await sh.clock.advance(10);
    assert.deepEqual(tabSids(B2), [null]);
    assert.equal(sh.srv.starts.length, starts, 'B\'s reload resumed one of A\'s sessions by itself');
    assert.equal(B2.ctx.$('#composerInput').value, 'Entwurf in B', 'B\'s own draft is not shown');
    // A comes back with its sessionStorage (a session restore, „reopen closed tab"): a reload of A
    const A2 = lockWin('A2', sh, { session: A.session });
    assert.equal(await A2.boot(), true, 'A came back empty — its tabs had gone to the other window');
    assert.equal(winId(A2), aWin);
    assert.deepEqual(tabSids(A2), [SB(1), SB(2)]);
    underLock(sh, A, B, B2, A2);
  });

  it('S7e — a reload whose old document lets go of its window lock late (300 ms, inside the shipped grace): still a reload with its own tabs, not an empty duplicate', async () => {
    const sh = shared('new');
    const A = await firstA(sh);
    const aWin = winId(A);
    for (const t of A.ctx.TABS) if (t.es) t.es.close(); // the old document goes — its lock falls a moment later
    const A2 = lockWin('A2', sh, { session: A.session });
    const pending = A2.startBoot();
    await sh.clock.advance(300);
    sh.locks.drop('A');
    await sh.clock.advance(200);
    assert.equal(await A2.boot(pending), true, 'the late lock made the reload a duplicate: it started empty and left its tabs behind');
    assert.equal(A2.run('TABWIN.kind'), 'reload');
    assert.equal(winId(A2), aWin);
    assert.deepEqual(tabSids(A2), [SB(1), SB(2)]);
    underLock(sh, A, A2);
  });

  it('S8 — after a crash (every window gone) the FIRST new window adopts the youngest group; a window opened next to it starts empty; the older group stays', async () => {
    const sh = shared('new');
    const A = await firstA(sh);
    const B = lockWin('B', sh);
    await B.boot(); await sh.clock.advance(10);
    await resumeIn(B, sh, SB(3), 'drei');
    await new Promise((r) => setTimeout(r, 3)); // A's write is the younger one, by the real clock the stamps use
    A.run('activateTab(TABS[1])'); await sh.clock.advance(10);
    const aWin = winId(A), bWin = winId(B);
    A.close(); B.close();
    const C = lockWin('C', sh);
    assert.equal(await C.boot(), true, 'the first window after the crash restored nothing');
    await sh.clock.advance(10);
    assert.deepEqual(tabSids(C), [SB(1), SB(2)], 'not the youngest group');
    assert.equal(C.ctx.ACTIVE.sessionId, SB(2), 'not A\'s active tab');
    assert.deepEqual(groupOf(sh, winId(C)), [SB(1), SB(2)], 'the adoption was not written');
    assert.deepEqual(groupOf(sh, aWin), [], 'A\'s group stands twice: adopted and still orphaned');
    assert.deepEqual(groupOf(sh, bWin), [SB(3)], 'the other orphaned group was touched');
    const D = lockWin('D', sh);
    assert.equal(await D.boot(), false, 'a second window took an orphaned group while C lives');
    assert.deepEqual(groupOf(sh, bWin), [SB(3)]);
    underLock(sh, A, B, C, D);
  });

  it('S9 — „Duplicate tab" (sessionStorage copied from B): after the grace a NEW window id, nothing of B\'s restored, then separate entries', async () => {
    const sh = shared('new');
    await firstA(sh);
    const typing = { lift: { 'commands.js': ['saveDraft'] }, consts: [['render.js', 'debounce'], ['chat.js', 'persistTabsSoon']] };
    const B = lockWin('B', sh, typing);
    await B.boot(); await sh.clock.advance(10);
    B.ctx.$('#composerInput').value = 'Entwurf in B'; B.ctx.saveDraft(); // lands in B's sessionStorage too (S7b)
    B.ctx.$('#composerInput').value = ''; // …and B moves on; the copy below still carries it
    await resumeIn(B, sh, SB(3), 'drei');
    const C2 = lockWin('C2', sh, { session: makeSession(B.session) });
    const pending = C2.startBoot();
    await sh.clock.advance(1100); // TW_GRACE_MS: the copy waits for B's lock to fall — it does not
    assert.equal(await C2.boot(pending), false);
    assert.equal(C2.run('TABWIN.kind'), 'duplicate');
    assert.equal(C2.ctx.$('#composerInput').value, '', 'the duplicate shows the draft it copied from B');
    assert.notEqual(winId(C2), winId(B), 'the duplicate kept B\'s id — every write of one would replace the other\'s tabs');
    assert.equal(C2.session.getItem('ccui-win'), winId(C2), 'the new id was not kept for C2\'s own reload');
    assert.equal(B.session.getItem('ccui-win'), winId(B));
    assert.deepEqual(tabSids(C2), [null]);
    await resumeIn(C2, sh, SB(4), 'vier');
    assert.deepEqual(groupOf(sh, winId(C2)), [SB(4)]);
    assert.deepEqual(groupOf(sh, winId(B)), [SB(3)], 'the duplicate\'s write touched B\'s entries');
    underLock(sh, B, C2);
  });

  it('S9b — the duplicate\'s own reload: still none of the original\'s draft (its copy is replaced at the first boot) — but what was typed in the duplicate itself comes back', async () => {
    const sh = shared('new');
    await firstA(sh);
    const B = lockWin('B', sh, TYPING);
    await B.boot(); await sh.clock.advance(10);
    B.ctx.$('#composerInput').value = 'Entwurf in B'; B.ctx.saveDraft();
    // C2: duplicated from B, nothing typed in it, then reloaded
    const C2 = lockWin('C2', sh, Object.assign({ session: makeSession(B.session) }, TYPING));
    const p2 = C2.startBoot();
    await sh.clock.advance(1100);
    assert.equal(await C2.boot(p2), false);
    assert.equal(C2.run('TABWIN.kind'), 'duplicate', 'premise');
    assert.equal(C2.ctx.$('#composerInput').value, '', 'premise (S9)');
    C2.close();
    const C2r = lockWin('C2r', sh, Object.assign({ session: C2.session }, TYPING));
    assert.equal(await C2r.boot(), false);
    await sh.clock.advance(10);
    assert.equal(C2r.run('TABWIN.kind'), 'reload');
    assert.equal(winId(C2r), winId(C2));
    assert.equal(C2r.ctx.$('#composerInput').value, '', 'the duplicate\'s first reload showed the draft it had copied from B');
    // C3: duplicated from B, typed into during the grace, then reloaded — that text is C3's own
    const C3 = lockWin('C3', sh, Object.assign({ session: makeSession(B.session) }, TYPING));
    const p3 = C3.startBoot();
    await sh.clock.advance(300);
    C3.ctx.$('#composerInput').value = 'in der Kopie getippt'; C3.ctx.saveDraft();
    await sh.clock.advance(800);
    assert.equal(await C3.boot(p3), false);
    assert.equal(C3.run('TABWIN.kind'), 'duplicate', 'premise');
    assert.equal(C3.ctx.$('#composerInput').value, 'in der Kopie getippt', 'the boot overwrote what was typed during the grace');
    C3.close();
    const C3r = lockWin('C3r', sh, Object.assign({ session: C3.session }, TYPING));
    await C3r.boot(); await sh.clock.advance(10);
    assert.equal(C3r.ctx.$('#composerInput').value, 'in der Kopie getippt', 'what was typed in the duplicate went with the copy');
    underLock(sh, B, C2, C2r, C3, C3r);
  });

  it('S10 — entries of an older panel (no window id) are ONE group: the first window adopts them with their active tab, a second gets nothing — and an older reader still reads the array', async () => {
    const sh = shared('new');
    sh.storage.setItem('cc_tabs_active', SB(2)); // what the older panel wrote along
    const A = await firstA(sh);
    assert.deepEqual(tabSids(A), [SB(1), SB(2)]);
    assert.equal(A.ctx.ACTIVE.sessionId, SB(2), 'the legacy active key was not honoured');
    assert.deepEqual(stored(sh).map((e) => [e.sessionId, e.win]), [[SB(1), winId(A)], [SB(2), winId(A)]], 'the adopted entries are not A\'s now');
    // decision 10: still an ARRAY of entries, and cc_tabs_active is still written (by the last writing window, as
    // before) — what an older panel reads. The reader of the fallback (restoreTabs without a pick) IS that read path.
    A.run('activateTab(TABS[0])'); await sh.clock.advance(10);
    assert.ok(Array.isArray(stored(sh)));
    assert.equal(sh.storage.getItem('cc_tabs_active'), SB(1), 'cc_tabs_active is no longer written');
    const B = lockWin('B', sh);
    assert.equal(await B.boot(), false);
    const OLD = makeWindow('OLD', sh);
    assert.equal(await OLD.boot(), true);
    assert.deepEqual(tabSids(OLD), [SB(1), SB(2)], 'the array form no longer reads in an older panel');
    underLock(sh, A, B);
  });

  it('S11 — without navigator.locks the deliberate fallback: the old behaviour (restore everything, write the whole list) — part A is what protects', async () => {
    const sh = shared('new');
    const { tA } = await liveA(sh); // a window without Web Locks, as every part-A suite above
    const B = makeWindow('B', sh);
    assert.equal(await B.boot(), true, 'the fallback is today\'s restore');
    await sh.clock.advance(10);
    assert.equal(B.run('TABWIN.win'), null);
    assert.deepEqual(tabSids(B), [S], 'the fallback restores the stored tabs, whoever wrote them');
    assert.ok(B.tab()._elsewhere && cardOf(B.tab()), 'part A did not catch it');
    assert.equal(sh.srv.kills, 0);
    assert.ok(sh.srv.chats.get(tA.id));
    B.run('persistTabs()');
    assert.deepEqual(stored(sh).map((e) => [e.sessionId, 'win' in e]), [[S, false]], 'the fallback writes another format than before');
  });
});

describe('part B — the rules behind it (CHAT-FLOW-4)', () => {
  it('decision 6: a write waits for the cc_tabs lock — while another holder has it, nothing is written', async () => {
    const sh = shared('new');
    const A = await firstA(sh);
    const X = sh.locks.client('X');
    let letGo; X.request('cc_tabs', () => new Promise((r) => { letGo = r; }));
    await flush();
    const before = sh.storage.getItem('cc_tabs');
    A.ctx.TABS[0].title = 'umbenannt';
    A.run('persistTabs()');
    await sh.clock.advance(10);
    assert.equal(sh.storage.getItem('cc_tabs'), before, 'A wrote while another window held the lock');
    letGo();
    await sh.clock.advance(10);
    assert.equal(stored(sh)[0].title, 'umbenannt', 'the write never came');
    underLock(sh, A);
  });

  it('decision 5: a window frozen right inside its cc_tabs write (Edge sleeping tabs) holds up nobody — and still counts as alive', async () => {
    const sh = shared('new');
    const A = await firstA(sh);
    // the browser freezes A between two tasks of its write — the one spot where a frozen window could sit on the
    // lock every other window needs, to boot and to write. A write whose locked section awaits anything (who is
    // alive, asked under the lock) is frozen there holding it.
    sh.locks.freezeAfterGrant('A', 'cc_tabs');
    A.ctx.TABS[0].title = 'umbenannt';
    A.run('persistTabs()');
    await sh.clock.advance(10);
    assert.ok(sh.locks.frozen('A'), 'premise: A froze inside its cc_tabs section');
    const B = lockWin('B', sh);
    const pending = B.startBoot();
    let booted = false; pending.then(() => { booted = true; }, () => { booted = true; });
    await sh.clock.advance(5000);
    assert.ok(booted, 'a window frozen inside its cc_tabs section held up the boot of the next one — B restores nothing and saves nothing until A thaws');
    assert.equal(await B.boot(pending), false, 'B took A for gone: a frozen window lost its tabs to the next one');
    assert.deepEqual(tabSids(B), [null]);
    assert.equal(stored(sh).find((e) => e.sessionId === SB(1)).title, 'umbenannt', 'A\'s write was not done before it froze');
    await resumeIn(B, sh, SB(3), 'drei');
    assert.deepEqual(groupOf(sh, winId(B)), [SB(3)], 'B\'s writes wait for a frozen A');
    sh.locks.thaw('A'); await sh.clock.advance(10);
    assert.deepEqual(groupOf(sh, winId(A)), [SB(1), SB(2)]);
    underLock(sh, A, B);
  });

  it('decision 6: two fresh windows booting at the same moment after a crash — exactly ONE adopts the orphaned group', async () => {
    const sh = shared('new');
    sh.storage.setItem('cc_tabs', JSON.stringify([{ sessionId: SB(1), title: 'eins', cwd: 'C:\\w' }]));
    const C = lockWin('C', sh), D = lockWin('D', sh);
    const pc = C.startBoot(), pd = D.startBoot();
    const rc = await C.boot(pc), rd = await D.boot(pd);
    await sh.clock.advance(10);
    assert.deepEqual([rc, rd], [true, false], 'both (or neither) restored the one orphaned group');
    assert.deepEqual(stored(sh).map((e) => e.win), [winId(C)]);
    assert.equal(sh.srv.starts.filter((s) => s.body.resume === SB(1)).length, 1, 'the session was resumed twice');
    underLock(sh, C, D);
  });

  it('decision 7: a full localStorage — first the orphaned groups go, then it SAYS so, once; the tab persistence does not just stop', async () => {
    const sh = shared('new');
    const A = await firstA(sh, [{ sessionId: SB(1), title: 'eins', cwd: 'C:\\w' }]);
    // two orphaned groups of windows long gone, with fat drafts
    const orphans = [1, 2].map((i) => ({ sessionId: SB(5 + i), title: 'alt ' + i, cwd: 'C:\\w', draft: 'x'.repeat(2000), win: 'gone' + i, at: Date.now() - i * 1000 }));
    sh.storage.setItem('cc_tabs', JSON.stringify(stored(sh).concat(orphans)));
    const own = stored(sh).filter((e) => e.win === winId(A));
    sh.quota = JSON.stringify(own).length + 500; // the own group fits, the orphans do not
    A.ctx.TABS[0].title = 'neu';
    A.run('persistTabs()'); await sh.clock.advance(10);
    assert.deepEqual(stored(sh).map((e) => [e.sessionId, e.win]), [[SB(1), winId(A)]], 'the write failed instead of dropping the orphans');
    assert.equal(stored(sh)[0].title, 'neu');
    assert.deepEqual(A.toasts.filter(([m]) => m === 'chat.tabsNichtGespeichert'), [], 'warned although the retry saved it');
    sh.quota = 10; // nothing fits any more
    A.ctx.TABS[0].title = 'neuer';
    A.run('persistTabs()'); await sh.clock.advance(10);
    A.run('persistTabs()'); await sh.clock.advance(10);
    assert.deepEqual(A.toasts.filter(([m]) => m === 'chat.tabsNichtGespeichert'), [['chat.tabsNichtGespeichert', 'warn']], 'a refused write is silent (or said on every keystroke)');
    underLock(sh, A);
  });

  it('decision 7, fallback: a window without Web Locks says it too', async () => {
    const sh = shared('new');
    const { A } = await liveA(sh);
    sh.quota = 5;
    A.run('persistTabs()');
    assert.equal(A.toasts.filter(([m]) => m === 'chat.tabsNichtGespeichert').length, 1);
  });

  it('decision 8: the boot tab used while the boot waited — an orphaned group is NOT adopted into it, it stays for a later window', async () => {
    const sh = shared('new');
    sh.storage.setItem('cc_tabs', JSON.stringify([{ sessionId: SB(1), title: 'eins', cwd: 'C:\\w', win: 'gone', at: Date.now() - 1000 }]));
    const X = sh.locks.client('X');
    let letGo; X.request('cc_tabs', () => new Promise((r) => { letGo = r; }));
    await flush();
    const C = lockWin('C', sh);
    const pending = C.startBoot();
    await sh.clock.advance(10);
    await C.send(C.tab(), 'schon losgelegt'); // the user is faster than the boot
    const t0 = C.ctx.TABS[0];
    assert.ok(t0.id, 'premise: the boot tab runs a chat');
    letGo();
    assert.equal(await C.boot(pending), false, 'the async restore overwrote the tab the user is working in');
    await sh.clock.advance(10);
    assert.equal(C.ctx.TABS.length, 1);
    assert.equal(C.ctx.TABS[0], t0);
    assert.equal(sh.srv.starts.filter((s) => s.body.resume === SB(1)).length, 0);
    assert.deepEqual(groupOf(sh, 'gone'), [SB(1)], 'the orphaned group was taken (or lost) without being restored');
    underLock(sh, C);
  });

  it('decision 8, reload: the own tabs are left behind as an orphaned group — not erased by the window\'s next write', async () => {
    const sh = shared('new');
    const A = await firstA(sh);
    const aWin = winId(A);
    A.close();
    const X = sh.locks.client('X');
    let letGo; X.request('cc_tabs', () => new Promise((r) => { letGo = r; }));
    await flush();
    const A2 = lockWin('A2', sh, { session: A.session });
    const pending = A2.startBoot();
    await sh.clock.advance(10);
    await A2.send(A2.tab(), 'schon losgelegt');
    letGo();
    assert.equal(await A2.boot(pending), false);
    await sh.clock.advance(10);
    assert.equal(winId(A2), aWin);
    const left = stored(sh).filter((e) => e.sessionId === SB(1) || e.sessionId === SB(2));
    assert.deepEqual(left.map((e) => e.sessionId), [SB(1), SB(2)], 'the reload\'s own tabs were erased');
    assert.ok(left.every((e) => e.win && e.win !== aWin), 'left under A\'s id, so A\'s next write erases them');
    underLock(sh, A, A2);
  });

  it('decision 9: a tab closed in A does not come back through B — not in the store, not after A\'s reload', async () => {
    const sh = shared('new');
    const A = await firstA(sh, null, { lift: { 'chat.js': ['closeTab'] }, stubs: (rec) => ({ updateTitleBadge: rec('updateTitleBadge'), CLOSED_TABS: [] }) });
    const B = lockWin('B', sh);
    await B.boot(); await sh.clock.advance(10);
    await resumeIn(B, sh, SB(3), 'drei');
    await A.ctx.closeTab(A.ctx.TABS[1]);
    await sh.clock.advance(10);
    B.ctx.TABS[0].title = 'drei, umbenannt';
    B.run('persistTabs()'); await sh.clock.advance(10);
    assert.ok(!stored(sh).some((e) => e.sessionId === SB(2)), 'the closed tab is back in the store');
    A.close();
    const A2 = lockWin('A2', sh, { session: A.session });
    await A2.boot(); await sh.clock.advance(10);
    assert.deepEqual(tabSids(A2), [SB(1)], 'the closed tab came back with the reload');
    underLock(sh, A, B, A2);
  });

  it('feat/projekte can hang its fields in: an entry field this version does not know survives the other windows\' writes', async () => {
    const sh = shared('new');
    const A = await firstA(sh);
    const B = lockWin('B', sh);
    await B.boot(); await sh.clock.advance(10);
    // A's group as a later version writes it
    sh.storage.setItem('cc_tabs', JSON.stringify(stored(sh).map((e) => Object.assign(e, { projectId: 'p-1', zukunft: { a: [1] } }))));
    await resumeIn(B, sh, SB(3), 'drei');
    assert.ok(stored(sh).some((x) => x.sessionId === SB(3)), 'premise: B wrote');
    const mine = stored(sh).filter((x) => x.sessionId === SB(1) || x.sessionId === SB(2));
    assert.deepEqual(mine.map((x) => [x.projectId, x.zukunft]), [['p-1', { a: [1] }], ['p-1', { a: [1] }]], 'B\'s write dropped (or rebuilt) A\'s entries');
    underLock(sh, A, B);
  });

  it('a write while boot.js still waits for /api/state (before tabsBoot): nothing is written yet — not the boot tab\'s nothing over every window\'s groups', async () => {
    const sh = shared('new');
    const A = await firstA(sh);
    const aWin = winId(A);
    const B = lockWin('B', sh);
    await B.boot(); await sh.clock.advance(10);
    await resumeIn(B, sh, SB(3), 'drei');
    A.close();
    const A2 = lockWin('A2', sh, Object.assign({ session: A.session }, TYPING));
    A2.load(); // the page stands, boot.js waits for /api/state …
    A2.ctx.$('#composerInput').value = 'schon getippt'; A2.ctx.saveDraft();
    await sh.clock.advance(900); // … long enough for the draft's persistTabsSoon (500 ms) to fire
    assert.deepEqual(groupOf(sh, winId(B)), [SB(3)], 'a write before the boot decided erased another window\'s group');
    assert.deepEqual(groupOf(sh, aWin), [SB(1), SB(2)], '…or the tabs the reload is about to bring back');
    assert.equal(await A2.boot(A2.run('tabsBoot()')), true);
    await sh.clock.advance(10);
    assert.deepEqual(tabSids(A2), [SB(1), SB(2)]);
    underLock(sh, A, B, A2);
  });

  it('a reload takes its window id back BEFORE boot.js waits for /api/state: a window that starts in that wait does not adopt the reloading window\'s tabs', async () => {
    const sh = shared('new');
    const A = await firstA(sh);
    A.close();
    const A2 = lockWin('A2', sh, { session: A.session });
    A2.load(); // boot.js: the id back first …
    await flush();
    const C = lockWin('C', sh); // … start.cmd opens a window while A2 still waits for /api/state
    assert.equal(await C.boot(), false, 'the new window took the tabs of a window in the middle of its reload');
    assert.equal(await A2.boot(A2.run('tabsBoot()')), true, 'the reload came back empty');
    await sh.clock.advance(10);
    assert.deepEqual(tabSids(A2), [SB(1), SB(2)]);
    assert.deepEqual(tabSids(C), [null]);
    underLock(sh, A, A2, C);
  });

  it('the window id is asked for ONCE per document: tabsBoot awaits the request boot.js started — a second one finds the id held by this very window and calls it a duplicate', async () => {
    const sh = shared('new');
    const A = await firstA(sh);
    A.close();
    const A2 = lockWin('A2', sh, { session: A.session });
    A2.load();
    const first = A2.run('TABWIN.reclaim');
    assert.ok(first, 'premise: boot.js\'s call started the request');
    assert.equal(A2.run('tabsReclaim()'), first, 'a second call asked again');
    const pending = A2.run('tabsBoot()');
    await sh.clock.advance(1100); // past the grace a second request would wait out
    assert.equal(await A2.boot(pending), true, 'the reload took itself for a duplicate and started empty');
    assert.equal(A2.run('TABWIN.kind'), 'reload');
    underLock(sh, A, A2);
  });

  it('typed while the boot waits, nothing to restore (a reload without tabs): the composer keeps it — the window\'s stored draft does not replace it', async () => {
    const sh = shared('new');
    const A = lockWin('A', sh, TYPING);
    await A.boot(); await sh.clock.advance(10);
    A.ctx.$('#composerInput').value = 'alter Entwurf'; A.ctx.saveDraft();
    A.close();
    const X = sh.locks.client('X');
    let letGo; X.request('cc_tabs', () => new Promise((r) => { letGo = r; }));
    await flush();
    const A2 = lockWin('A2', sh, Object.assign({ session: A.session }, TYPING));
    const pending = A2.startBoot();
    await sh.clock.advance(10);
    A2.ctx.$('#composerInput').value = 'neu getippt';
    letGo();
    assert.equal(await A2.boot(pending), false);
    await sh.clock.advance(10);
    assert.equal(A2.run('TABWIN.kind'), 'reload', 'premise');
    assert.equal(A2.ctx.$('#composerInput').value, 'neu getippt', 'the boot overwrote what was typed meanwhile');
    underLock(sh, A, A2);
  });

  it('typed while the boot waits for the cc_tabs lock, then the restore lands: the text stays in the composer, BEHIND the active tab\'s restored draft, and is saved with it', async () => {
    const sh = shared('new');
    const A = await firstA(sh, null, TYPING);
    A.ctx.$('#composerInput').value = 'Entwurf eins'; A.ctx.saveDraft();
    await sh.clock.advance(600);
    assert.equal(stored(sh).find((e) => e.sessionId === SB(1)).draft, 'Entwurf eins', 'premise: the active tab\'s draft is stored');
    A.close();
    const X = sh.locks.client('X');
    let letGo; X.request('cc_tabs', () => new Promise((r) => { letGo = r; }));
    await flush();
    const A2 = lockWin('A2', sh, Object.assign({ session: A.session }, TYPING));
    const pending = A2.startBoot();
    await sh.clock.advance(10);
    A2.ctx.$('#composerInput').value = 'neu getippt'; A2.ctx.saveDraft();
    letGo();
    assert.equal(await A2.boot(pending), true, 'premise: restored');
    await sh.clock.advance(700);
    assert.equal(A2.ctx.ACTIVE.sessionId, SB(1), 'premise: the active tab is the restored SB(1)');
    assert.equal(A2.ctx.$('#composerInput').value, 'Entwurf eins\n\nneu getippt', 'the restore swapped the text typed meanwhile for the restored draft (or dropped the restored one)');
    assert.equal(A2.ctx.ACTIVE.draft, 'Entwurf eins\n\nneu getippt');
    assert.equal(stored(sh).find((e) => e.sessionId === SB(1)).draft, 'Entwurf eins\n\nneu getippt', 'the kept text is not saved with its tab');
    assert.equal(A2.ctx.TABS[1].draft, '', 'the other tab got the text');
    underLock(sh, A, A2);
  });

  it('typed while a reload waits for its old document\'s lock (300 ms), the tab it lands on has no draft: the composer shows exactly what was typed', async () => {
    const sh = shared('new');
    const A = await firstA(sh, null, TYPING);
    for (const t of A.ctx.TABS) if (t.es) t.es.close();
    const A2 = lockWin('A2', sh, Object.assign({ session: A.session }, TYPING));
    const pending = A2.startBoot();
    await sh.clock.advance(100);
    A2.ctx.$('#composerInput').value = 'sofort getippt'; A2.ctx.saveDraft();
    await sh.clock.advance(200);
    sh.locks.drop('A');
    await sh.clock.advance(200);
    assert.equal(await A2.boot(pending), true, 'premise');
    await sh.clock.advance(700);
    assert.equal(A2.run('TABWIN.kind'), 'reload', 'premise');
    assert.equal(A2.ctx.$('#composerInput').value, 'sofort getippt', 'the restore swapped the text typed meanwhile for an empty draft');
    assert.deepEqual(stored(sh).map((e) => e.draft), ['sofort getippt', ''], 'the kept text is not saved with the active tab');
    underLock(sh, A, A2);
  });

  it('decision 8, a second tab opened while the boot waited: no restore into the first one either — the own group is left behind', async () => {
    const sh = shared('new');
    const A = await firstA(sh);
    const aWin = winId(A);
    A.close();
    const X = sh.locks.client('X');
    let letGo; X.request('cc_tabs', () => new Promise((r) => { letGo = r; }));
    await flush();
    const A2 = lockWin('A2', sh, { session: A.session });
    const pending = A2.startBoot();
    await sh.clock.advance(10);
    A2.run('activateTab(newTab())'); // „+" while the boot waits: TABS[0] itself is still untouched
    letGo();
    assert.equal(await A2.boot(pending), false, 'restored into the first tab while the user works in the second');
    await sh.clock.advance(10);
    assert.deepEqual(tabSids(A2), [null, null]);
    const left = stored(sh).filter((e) => e.sessionId === SB(1) || e.sessionId === SB(2));
    assert.deepEqual(left.map((e) => e.sessionId), [SB(1), SB(2)], 'the reload\'s own tabs were erased');
    assert.ok(left.every((e) => e.win && e.win !== aWin));
    underLock(sh, A, A2);
  });

  it('two writes while the cc_tabs lock is busy: the one request in the queue writes the NEWER state', async () => {
    const sh = shared('new');
    const A = await firstA(sh);
    const X = sh.locks.client('X');
    let letGo; X.request('cc_tabs', () => new Promise((r) => { letGo = r; }));
    await flush();
    A.ctx.TABS[0].title = 'erst'; A.run('persistTabs()');
    await sh.clock.advance(5);
    A.ctx.TABS[0].title = 'dann'; A.run('persistTabs()');
    letGo();
    await sh.clock.advance(10);
    assert.equal(stored(sh).find((e) => e.sessionId === SB(1)).title, 'dann', 'the queued request wrote the older state');
    underLock(sh, A);
  });

  it('a lock request the browser refuses does not switch the window\'s writes off: the next one goes through', async () => {
    const sh = shared('new');
    const real = sh.locks.client('A');
    let refuse = false;
    const locks = {
      request: (n, a, b) => { if (refuse && n === 'cc_tabs') { refuse = false; return Promise.reject(new Error('AbortError (synthetisch)')); } return real.request(n, a, b); },
      query: () => real.query(),
    };
    const A = await firstA(sh, [{ sessionId: SB(1), title: 'eins', cwd: 'C:\\w' }], { stubs: () => ({ navigator: { locks } }) });
    refuse = true;
    A.ctx.TABS[0].title = 'abgelehnt'; A.run('persistTabs()');
    await sh.clock.advance(10);
    assert.ok(A.warns.some((w) => /persist tabs failed/.test(w)), 'premise: the request was refused');
    A.ctx.TABS[0].title = 'danach'; A.run('persistTabs()');
    await sh.clock.advance(10);
    assert.equal(stored(sh)[0].title, 'danach', 'after one refused request every later write was skipped');
    underLock(sh, A);
  });

  it('the fallback, sessionStorage without Web Locks: the old restore — not a boot that throws and falls back', async () => {
    const sh = shared('new');
    sh.storage.setItem('cc_tabs', JSON.stringify([{ sessionId: SB(1), title: 'eins', cwd: 'C:\\w' }]));
    const W = makeWindow('W', sh, { stubs: () => ({ sessionStorage: makeSession() }) });
    assert.equal(await W.boot(), true);
    assert.equal(W.run('TABWIN.win'), null);
    assert.deepEqual(tabSids(W), [SB(1)]);
  });

  it('the fallback, a navigator.locks that cannot query (an older implementation): the old restore, and the window saves', async () => {
    const sh = shared('new');
    sh.storage.setItem('cc_tabs', JSON.stringify([{ sessionId: SB(1), title: 'eins', cwd: 'C:\\w' }]));
    const W = lockWin('W', sh, { stubs: () => ({ navigator: { locks: { request: () => Promise.reject(new Error('nicht benutzt')) } } }) });
    assert.equal(W.run('TABWIN.booting'), true, 'premise: a page with navigator.locks holds its writes until the boot decided');
    assert.equal(await W.boot(), true);
    W.ctx.TABS[0].title = 'umbenannt'; W.run('persistTabs()');
    assert.equal(stored(sh)[0].title, 'umbenannt', 'the fallback window never saves again');
  });

  it('the fallback with nothing to restore: the global cc_draft, as before part B', async () => {
    const sh = shared('new');
    sh.storage.setItem('cc_draft', 'zuletzt getippt');
    const W = makeWindow('W', sh);
    assert.equal(await W.boot(), false);
    assert.equal(W.ctx.$('#composerInput').value, 'zuletzt getippt');
  });

  it('the fallback WITH tabs to restore: the global cc_draft does not land in a restored tab — restoreTabs would keep it as typed (C8)', async () => {
    const sh = shared('new');
    sh.storage.setItem('cc_tabs', JSON.stringify([{ sessionId: SB(1), title: 'eins', cwd: 'C:\\w', draft: 'eigener Entwurf' }]));
    sh.storage.setItem('cc_draft', 'in einem anderen Tab getippt');
    const W = makeWindow('W', sh);
    assert.equal(await W.boot(), true);
    assert.equal(W.ctx.$('#composerInput').value, 'eigener Entwurf', 'the last text typed anywhere went into the restored tab');
    assert.equal(W.ctx.TABS[0].draft, 'eigener Entwurf');
  });

  it('a lock manager that refuses at boot: the fallback — everything restored as before part B, and the window keeps saving', async () => {
    const sh = shared('new');
    sh.storage.setItem('cc_tabs', JSON.stringify([{ sessionId: SB(1), title: 'eins', cwd: 'C:\\w' }]));
    sh.storage.setItem('cc_draft', 'in einem anderen Tab getippt');
    const refuse = () => Promise.reject(new Error('SecurityError (synthetisch)'));
    const W = lockWin('W', sh, { stubs: () => ({ navigator: { locks: { request: refuse, query: refuse } } }) });
    assert.equal(await W.startBoot(), true, 'a refusing lock manager cost the window its tabs');
    assert.ok(W.warns.some((w) => /boot fell back/.test(w)), 'premise: the boot fell back');
    assert.deepEqual(tabSids(W), [SB(1)]);
    assert.equal(W.ctx.$('#composerInput').value, '', 'the last text typed anywhere went into the restored tab (C8)');
    W.ctx.TABS[0].title = 'umbenannt'; W.run('persistTabs()');
    assert.equal(stored(sh)[0].title, 'umbenannt', 'after the fallback nothing is saved any more');
  });
});

// decision 2 — the „Letzte Sitzung" button of an empty window says what the probe answered, every branch both ways
describe('part B — „Letzte Sitzung" in a second window says whether the session is open elsewhere (CHAT-FLOW-4)', () => {
  const button = (w) => w.ctx.$('#resumeLast');
  async function secondWith(sh, last, setup) {
    const A = await firstA(sh);
    if (setup) await setup(A);
    sh.storage.setItem('cc_last_session', JSON.stringify({ id: last, cwd: 'C:\\w' }));
    const B = lockWin('B', sh);
    await B.boot(); await sh.clock.advance(10);
    const btn = button(B);
    assert.ok(btn, 'premise: the empty second window offers the last session');
    underLock(sh, A, B);
    return { A, B, btn };
  }
  it('open in A, A idle: marked, with the tooltip that it is the state of the moment it asked', async () => {
    const sh = shared('new');
    const { btn } = await secondWith(sh, SB(1));
    assert.equal(btn.textContent, 'commands.letzteSessionFortsetzen' + SB(1).slice(0, 8) + ')' + 'commands.letzteAnderswoOffen');
    assert.equal(btn.title, 'commands.letzteAnderswoTitel');
  });
  it('a turn running in A: says so — and only then', async () => {
    const sh = shared('new');
    const { btn } = await secondWith(sh, SB(1), (A) => A.send(A.tab(), 'A arbeitet'));
    assert.ok(btn.textContent.endsWith('commands.letzteAnderswoTurn'), btn.textContent);
  });
  it('a process just started that nobody attached to: „gerade erst gestartet", not „anderswo offen"', async () => {
    const sh = shared('new');
    const { btn } = await secondWith(sh, SB(9), () => sh.srv.api({ name: 'X' })('/api/chat/start', { method: 'POST', body: JSON.stringify({ resume: SB(9) }) }));
    assert.ok(btn.textContent.endsWith('commands.letzteAnderswoStartet'), btn.textContent);
  });
  it('nobody holds it: the plain button — no mark, no tooltip', async () => {
    const sh = shared('new');
    const { btn } = await secondWith(sh, SB(9));
    assert.equal(btn.textContent, 'commands.letzteSessionFortsetzen' + SB(9).slice(0, 8) + ')');
    assert.equal(btn.title, undefined);
  });
  it('the probe fails (an older server): the plain button — nothing is claimed either way', async () => {
    const sh = shared('old'); // the old server has no probe (404)
    sh.storage.setItem('cc_tabs', JSON.stringify([{ sessionId: SB(1), title: 'eins', cwd: 'C:\\w' }]));
    const A = lockWin('A', sh);
    await A.boot(); await sh.clock.advance(10);
    sh.storage.setItem('cc_last_session', JSON.stringify({ id: SB(1), cwd: 'C:\\w' }));
    const B = lockWin('B', sh);
    await B.boot(); await sh.clock.advance(10);
    assert.equal(B.ctx.$('#resumeLast').textContent, 'commands.letzteSessionFortsetzen' + SB(1).slice(0, 8) + ')');
    assert.ok(sh.srv.probes >= 1, 'premise: it asked');
    underLock(sh, A, B);
  });
  it('the mark says no more than the probe knows: the state „beim Prüfen", and „anderswo" — the server cannot tell a tab or window from a UI-skill run', () => {
    const src = fs.readFileSync(path.join(PUB, 'i18n.js'), 'utf8');
    const vals = (key) => [...src.matchAll(new RegExp("^\\s*'" + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "':\\s*'((?:[^'\\\\]|\\\\.)*)'", 'gm'))].map((m) => m[1]);
    for (const k of ['commands.letzteAnderswoOffen', 'commands.letzteAnderswoTurn', 'commands.letzteAnderswoStartet']) {
      const [de, en, more] = vals(k);
      assert.ok(de && en && !more, k + ': premise — one value per locale');
      assert.match(de, /beim Prüfen/, k + ' (de) states the moment of the probe as the present');
      assert.match(en, /when checked/, k + ' (en) states the moment of the probe as the present');
      assert.doesNotMatch(de, /Fenster/, k + ' (de) names a window the server never saw');
      assert.doesNotMatch(en, /window/, k + ' (en) names a window the server never saw');
    }
    // the tooltip lists what „anderswo" can be — as examples: the server also counts a scheduled run, another
    // browser or origin; a closed list would claim to know which one it is
    const [de, en] = vals('commands.letzteAnderswoTitel');
    assert.match(de, /„anderswo" kann zum Beispiel /);
    assert.match(en, /„elsewhere" can be, for example, /);
  });
  it('clicked while A still holds it: the takeover question of part A, nothing ended without it', async () => {
    const sh = shared('new');
    const { B, btn } = await secondWith(sh, SB(1));
    B.confirmAnswer = false;
    await btn.onclick(); await sh.clock.advance(10);
    assert.deepEqual(B.confirms, ['chat.uebernehmenText']);
    assert.equal(sh.srv.kills, 0);
  });
});

// ---- Projekte Stufe 2 — the start names the project (J1), the tab keeps it across a reload (J7) -----------------
describe('Projekte — the project in the start body and in cc_tabs', () => {
  it('J1: a fresh tab sends its projectId (also „none" = \'\'); a resume never does', async () => {
    const sh = shared('new');
    const A = await firstA(sh, [{ sessionId: SB(1), title: 'eins', cwd: 'C:\w', projectId: 'p-1' }]);
    const resumed = A.startsHere().filter((s) => s.body.resume === SB(1));
    assert.ok(resumed.length, 'premise: the restored tab resumed');
    assert.ok(resumed.every((s) => !('projectId' in s.body)), 'a resume sent a projectId');
    for (const pid of ['p-2', '']) {
      const t = A.run('newTab()'); t.projectId = pid;
      await A.send(t, 'hallo'); await sh.clock.advance(10);
      const fresh = A.startsHere().filter((s) => !s.body.resume).pop();
      assert.equal(fresh && fresh.body.projectId, pid, 'the fresh start did not name ' + JSON.stringify(pid));
    }
  });
  it('J7: projectId and the start\'s project state survive the reload; an unlabelled tab stores none', async () => {
    const sh = shared('new');
    const A = await firstA(sh);
    A.ctx.TABS[0].projectId = 'p-1'; A.ctx.TABS[0]._projectAt = 1500;
    A.run('persistTabs()'); await sh.clock.advance(10);
    const e = stored(sh);
    assert.deepEqual([e[0].projectId, e[0].projectAt, 'projectId' in e[1]], ['p-1', 1500, false]);
    A.close();
    const A2 = lockWin('A2', sh, { session: A.session });
    assert.equal(await A2.boot(), true);
    await sh.clock.advance(10);
    const [t1, t2] = A2.ctx.TABS;
    assert.deepEqual([t1.projectId, t1._projectAt, t1._projectRun], ['p-1', 1500, 'p-1'], 'the project did not come back with its tab');
    assert.equal(t2.projectId, undefined);
  });
});
