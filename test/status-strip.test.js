'use strict';
// The VISIBLE half of G5 — and the reason this file exists at all.
//
// The build left `public/js/chat-status.js` and the two new branches in `chat-events.js` untested, on the
// grounds that „the project has no DOM/browser test environment". That is not true, and the cost of believing
// it was measured: renaming `chat.sessionState` to `chat.sessionStates` in chat-events.js makes G5 completely
// SILENT, and 123 of 123 tests stayed green. A feature whose only failure mode is „says nothing" cannot be
// guarded by tests that never read what it says.
//
// chat-status.js is a classic script: top-level functions plus a handful of free variables the other scripts
// own. node:vm loads the REAL file into a context holding stubs for those, and `displayPhase` is then an
// ordinary call. No jsdom, no dependency — this repo has none, and that is the point.
//
// TWO things this harness must get right, both learned the hard way while writing it:
//   · a top-level `const` in a vm script is NOT a property of the context object (a `function` is). So the
//     phase sentinels are read back with runInContext, never as `sandbox.WAIT_APPROVAL` — that was undefined
//     and the assertion guarding against exactly this fired.
//   · the gate predicates compare the tab OBJECT (`pendingPerm.tab === tab`), not an id. A stub with `tabId`
//     silently means „no gate held", which would have made the gate tests pass for the wrong reason.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const PUB = path.join(__dirname, '..', 'public', 'js');

// A minimal element: enough for the chip branch to build and for us to read what it wrote.
const makeEl = () => function el(tag, cls, text) {
  return {
    tag, className: cls || '', textContent: text == null ? '' : String(text), title: '',
    children: [], appendChild(c) { this.children.push(c); return c; }, querySelector() { return null; },
  };
};

function loadStrip() {
  const ctx = {
    // i18n returns the KEY, so an assertion names the key instead of a German sentence that moves.
    tt: (k) => String(k), t: (k) => String(k),
    el: makeEl(),
    // The strip box WITH its two in-place nodes — the shape renderStatus expects while streaming. A box
    // without them is a legitimate reason for it to fall back to a full rebuild (chat-status.js does exactly
    // that), so a null stub would make the „does not rebuild" assertion pass for the wrong reason.
    $: () => ({ querySelector: (sel) => ({ tag: 'span', className: String(sel).replace('.', ''), textContent: '', title: '' }) }),
    fmtNum: (n) => String(n), fmtUSD: (n) => '$' + Number(n).toFixed(2),
    ACTIVE: null,
    pendingPerm: null, permQueue: [], ASK_GATES: new Map(),   // the panel's OWN gates
    console, setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
    Date, Math, JSON, String, Number, Array, Object, Boolean, isNaN, parseInt, parseFloat, RegExp, Map, Set,
  };
  ctx.globalThis = ctx;
  const sandbox = vm.createContext(ctx);
  // The phase sentinels live in three different files. They are EXTRACTED from those files rather than
  // written down here: a copy would make this suite agree with itself while the panel compares something
  // else — the self-confirming test this repo keeps finding.
  for (const [file, names] of [['chat-render.js', ['PHASE_WORKING', 'ASK_WAIT_PHASE', 'PHASE_TOOLWORK', 'PHASE_WRITING']], ['chat-events.js', ['RECONNECT_PHASE']]]) {
    const src = fs.readFileSync(path.join(PUB, file), 'utf8');
    for (const n of names) {
      const m = new RegExp('(?:const|let|var)\\s+' + n + "\\s*=\\s*'([^']+)'").exec(src);
      assert.ok(m, n + ' not found in ' + file + ' — did it move or get renamed?');
      vm.runInContext('var ' + n + " = '" + m[1] + "';", sandbox);
    }
  }
  // plan-progress.js too: it is pure, and planPhase (PF-1) reads its planCounts — without it the plan branch
  // would be skipped by its typeof guard and the plan tests below would pass for the wrong reason
  for (const f of ['session-state.js', 'plan-progress.js', 'chat-status.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUB, f), 'utf8'), sandbox, { filename: f });
  }
  // AFTER the real files: phaseLabel translates every phase of the panel and would need a dozen more
  // sentinels. These tests ask whether the SESSION key reaches the line, not how a phase is worded, so the
  // label is reduced to its own input. Replacing it afterwards is what makes that possible.
  vm.runInContext('phaseLabel = function (p) { return String(p); };', sandbox);
  vm.runInContext('activeTodoPhase = function () { return ""; };', sandbox);
  const phase = (n) => vm.runInContext(n, sandbox);
  return { sandbox, ctx, phase, call: (n, ...a) => vm.runInContext(n, sandbox)(...a) };
}

const tab = (over) => Object.assign({
  id: 't1', streaming: false, phase: '', sessionState: null, turnStart: Date.now(),
  tokenBase: 0, tokenLive: 0, thinkTokens: 0, model: 'claude-sonnet-5', queue: [], todos: [],
}, over || {});
const rec = (state, known) => ({ state, known: known !== false });

describe('status strip — the reported session state never displaces a CONFIRMED phase', () => {
  // THE blocker this file was written for. Each of these phases is something the panel KNOWS: it holds the
  // request id, the tool name, or the socket state. A sentence derived from one `state` word must not replace
  // any of them — and an UNKNOWN word least of all.
  it('an unknown fourth state does not overwrite „warte auf Freigabe" or „warte auf deine Antwort"', () => {
    for (const which of ['perm', 'ask']) {
      const s = loadStrip();
      const t = tab({ streaming: true, sessionState: rec('compacting', false) });
      // the gate must really be held — otherwise displayPhase downgrades the phase to PHASE_WORKING before
      // our branch and the case would prove nothing
      if (which === 'perm') { t.phase = s.phase('WAIT_APPROVAL'); s.ctx.pendingPerm = { tab: t, id: 'p1', tool: 'Bash' }; }
      else { t.phase = s.phase('ASK_WAIT_PHASE'); s.ctx.ASK_GATES.set('g1', { tab: t, id: 'a1' }); }
      const out = s.call('displayPhase', t);
      assert.doesNotMatch(out, /session-state\./, which + ': the session word displaced a phase the panel can explain: ' + out);
      assert.match(out, /phase:/, which + ': the confirmed phase must still be what is shown, got ' + out);
    }
  });

  it('requires_action does not overwrite „Verbindung getrennt"', () => {
    const s = loadStrip();
    const t = tab({ streaming: true, phase: s.phase('RECONNECT_PHASE'), sessionState: rec('requires_action') });
    const out = s.call('displayPhase', t);
    assert.doesNotMatch(out, /session-state\./,
      'claiming in the present tense that the session awaits a decision, while the connection is gone: ' + out);
  });

  // …and the gap it IS allowed to fill. Without this the fix above could be „never show it at all", which
  // would throw away a state that arrives — the other half of the rule.
  it('…but it DOES fill „arbeite…", which is the hole it was built for', () => {
    const s = loadStrip();
    const t = tab({ streaming: true, phase: s.phase('PHASE_WORKING'), sessionState: rec('requires_action') });
    assert.match(s.call('displayPhase', t), /session-state\.wartetEntscheidung/, 'the one case G5 exists for went missing');
  });

  it('a held gate of our own keeps the session word out of the working phase too', () => {
    const s = loadStrip();
    const t = tab({ streaming: true, phase: s.phase('PHASE_WORKING'), sessionState: rec('requires_action') });
    s.ctx.pendingPerm = { tab: t, id: 'p1', tool: 'Bash' };
    assert.doesNotMatch(s.call('displayPhase', t), /session-state\./, 'the panel knows WHAT is waiting; the frame does not');
  });
});

// PF-1 — the step of the accepted plan IS the working phase: TodoWrite (the todo verb's source) is off for Opus
// 5.5, so without this the strip says „arbeite…" through a whole plan. Only a REPORTED step, never a guess.
describe('status strip — the plan step as the working phase (PF-1)', () => {
  const planTab = (s, report) => {
    const p = s.call('planAccept', s.call('planNew', 'toolu_A', '# Plan: T\n## Umsetzung\n### Modul\n### Route\n### Tests\n', '', 1), null, 2);
    if (report) s.call('planApplyStatus', p, s.call('planStatusNormalize', report), 3);
    return tab({ streaming: true, phase: s.phase('PHASE_WORKING'), plan: p });
  };
  it('„Schritt 2/3 · <the model\'s sentence>", else the step\'s title', () => {
    const s = loadStrip();
    assert.equal(s.call('displayPhase', planTab(s, { aktuell: 'S2', erledigt: ['S1'], aktiv: 'Verdrahte die Route' })), '⏳ chat-status.planSchritt2/3 · Verdrahte die Route');
    assert.equal(s.call('displayPhase', planTab(s, { aktuell: 'S3' })), '⏳ chat-status.planSchritt3/3 · Tests');
  });
  it('nothing reported, a finished plan, a proposal → the generic phase, not a guessed step', () => {
    const s = loadStrip();
    assert.equal(s.call('displayPhase', planTab(s, null)), s.phase('PHASE_WORKING'));
    assert.equal(s.call('displayPhase', planTab(s, { fertig: true })), s.phase('PHASE_WORKING'));
    const t = planTab(s, { aktuell: 'S1' }); t.plan.state = 'proposed';
    assert.equal(s.call('displayPhase', t), s.phase('PHASE_WORKING'));
  });
  it('a confirmed phase (a held gate) still wins over the plan step', () => {
    const s = loadStrip();
    const t = planTab(s, { aktuell: 'S1' });
    t.phase = s.phase('ASK_WAIT_PHASE'); s.ctx.ASK_GATES.set('g1', { tab: t });
    assert.equal(s.call('displayPhase', t), s.phase('ASK_WAIT_PHASE'));
  });
  // The phase a running plan actually sits in: every tool result sets PHASE_TOOLWORK („arbeite…"), and
  // PHASE_WORKING („Arbeite…") lasts only up to a turn's first frame. The three tests above all start from
  // PHASE_WORKING — which is how the browser could show „arbeite…" through S1 and S2 with all of them green.
  it('…and between two tool calls (PHASE_TOOLWORK) too — a named phase still wins, a tab without a plan is unchanged', () => {
    const s = loadStrip();
    const t = planTab(s, { aktuell: 'S2', erledigt: ['S1'], aktiv: 'Verdrahte die Route' });
    t.phase = s.phase('PHASE_TOOLWORK');
    assert.equal(s.call('displayPhase', t), '⏳ chat-status.planSchritt2/3 · Verdrahte die Route');
    t.phase = s.phase('PHASE_WRITING');
    assert.equal(s.call('displayPhase', t), s.phase('PHASE_WRITING'), 'schreibe… is something the panel SEES happening');
    t.phase = 'läuft Read…';
    assert.equal(s.call('displayPhase', t), 'läuft Read…', 'a running tool by name beats the step');
    const plain = tab({ streaming: true, phase: s.phase('PHASE_TOOLWORK') });
    assert.equal(s.call('displayPhase', plain), s.phase('PHASE_TOOLWORK'), 'no plan → „arbeite…" as before');
    const unreported = planTab(s, null); unreported.phase = s.phase('PHASE_TOOLWORK');
    assert.equal(s.call('displayPhase', unreported), s.phase('PHASE_TOOLWORK'), 'nothing reported → no guessed step here either');
  });
});

describe('status strip — the chip at rest', () => {
  // This is the branch the one-word mutation silenced.
  it('a session still running while the tab sits at rest produces the contradiction chip', () => {
    const s = loadStrip();
    const t = tab({ streaming: false, sessionState: rec('running') });
    const r = s.call('sessionStateReport', t.sessionState, s.call('sessionStateCtx', t, false));
    assert.ok(r, 'the chip branch would have nothing to draw');
    assert.equal(r.key, 'session-state.arbeitetNoch');
    assert.equal(r.sev, 'warn');
    assert.match(s.call('sessionStateText', r), /session-state\.arbeitetNoch/);
  });

  it('and idle takes it away again — the only job idle has', () => {
    const s = loadStrip();
    const t = tab({ streaming: false, sessionState: rec('idle') });
    assert.equal(s.call('sessionStateReport', t.sessionState, s.call('sessionStateCtx', t, false)), null);
  });
});

describe('status strip — renderStatus repaints at REST, or the chip can never change', () => {
  // The design's own justification is „a derived read heals itself at the next 200 ms tick". At rest there is
  // no tick (stopTurnStatus clears STATUS_TIMER), and the chip is shown ONLY at rest — so without a repaint
  // on the gate lifecycle that sentence was simply untrue for the chip. The gate callers already call
  // renderStatus(), so renderStatus must not be a no-op when the tab is idle.
  it('renderStatus() with a resting tab rebuilds the bar instead of returning', () => {
    const s = loadStrip();
    let built = 0;
    vm.runInContext('renderStatusBar = function () { __built(); };', s.sandbox);
    s.ctx.__built = () => { built++; };
    s.ctx.ACTIVE = tab({ streaming: false, sessionState: rec('running') });
    s.call('renderStatus');
    assert.equal(built, 1, 'at rest nothing repaints the chip — the „next tick" it relies on does not exist');
  });

  it('…and while streaming it does NOT rebuild (that is the churn the ticker avoids)', () => {
    const s = loadStrip();
    let built = 0;
    vm.runInContext('renderStatusBar = function () { __built(); };', s.sandbox);
    s.ctx.__built = () => { built++; };
    s.ctx.ACTIVE = tab({ streaming: true, phase: s.phase('PHASE_WORKING') });
    s.call('renderStatus');
    assert.equal(built, 0, 'a full rebuild 5× a second is the exact thing the in-place ticker exists for');
  });
});

// The wiring in chat-events.js cannot be loaded this way (it needs the whole event pipeline), so it is pinned
// as TEXT — deliberately on the field NAME, which is what the measured mutation changed. Weak against
// reformatting, strong against exactly this: a rename that makes the feature silent.
describe('status strip — the wiring is pinned where the mutation struck', () => {
  const src = fs.readFileSync(path.join(PUB, 'chat-events.js'), 'utf8');
  it('chat-events writes the state onto the SAME field the strip reads', () => {
    const written = [...src.matchAll(/\bchat\.(sessionState[A-Za-z]*)\s*=/g)].map((m) => m[1]);
    const strip = fs.readFileSync(path.join(PUB, 'chat-status.js'), 'utf8');
    const read = [...strip.matchAll(/\bt(?:ab)?\.(sessionState[A-Za-z]*)\b/g)].map((m) => m[1]);
    assert.ok(written.length, 'nothing in chat-events.js assigns a session state any more');
    for (const w of written) {
      assert.ok(read.includes(w), 'chat-events writes `' + w + '`, which the strip never reads — G5 would be silent');
    }
  });
  // The richer list must survive `init`. Measured: `commands_changed` arrives FIRST and carries 71 typeable
  // names (60 commands + 11 aliases), `init.slash_commands` the 60 without aliases — so an unguarded
  // assignment in the init branch threw eleven names away 6,2 s after they had arrived, while README and
  // CHANGELOG promised the opposite. Three assertions, because the guard only works if all three hold.
  it('the init branch does not replace a list commands_changed already delivered', () => {
    const init = /if \(Array\.isArray\(ev\.slash_commands\)[^\n]*CHAT_COMMANDS = /.exec(src);
    assert.ok(init, 'the init assignment of CHAT_COMMANDS moved — re-check the guard');
    assert.match(init[0], /!chat\._cmdsFromFrame/, 'init overwrites the richer list again');
    assert.match(src, /chat\._cmdsFromFrame = true/, 'nothing marks that the frame list arrived');
    assert.match(src, /tab\._cmdsFromFrame = false/,
      'the marker is never reset — a restarted tab would keep the slash menu of a process that is gone');
  });

  it('the reset runs BEFORE the only repaint in the _exit branch', () => {
    // Comments are stripped FIRST, and that is not pedantry: the comment explaining this very ordering names
    // `setComposerBusy(false)` in prose and sits above the line it describes, so a raw indexOf found the
    // explanation instead of the call and reported the order as broken while it was correct.
    const code = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const i = src.indexOf("case '_exit':");
    assert.ok(i > 0);
    // CHAT-FLOW-4 moved the branch's cleanup into endTabProcess (shared with `_superseded`): the branch must
    // call it before anything else of its own, and the order is pinned inside the helper now
    const branch = code(src.slice(i, src.indexOf("case '_superseded':", i)));
    assert.match(branch, /^case '_exit':\s*endTabProcess\(chat\);/, 'the _exit branch no longer starts with the shared cleanup');
    const at = src.indexOf('\nfunction endTabProcess(');
    assert.ok(at > 0, 'endTabProcess is gone — then the order below is pinned on nothing');
    const seg = code(src.slice(at, src.indexOf('\n}\n', at)));
    const reset = seg.indexOf('tab.sessionState = null');
    const busy = seg.indexOf('setComposerBusy(false)');
    assert.ok(reset > 0 && busy > 0, 'both lines must still be in the shared cleanup');
    assert.ok(reset < busy,
      'setComposerBusy repaints the strip; after it the stale `running` chip stands next to „beendet" for ever');
  });
});
