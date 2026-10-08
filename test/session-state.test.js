'use strict';
// G5 — the CLI's own report about a SESSION. Every frame shape below is copied from the ONE paid
// measurement of 2026-10-02 against CLI 2.1.286 (docs/messung-2026-10-02.md; raw mitschnitt
// ccui-probe/runs/paid-2026-10-02T19-55-29-267Z + …T20-40-26-939Z). Nothing here is remembered, and
// nothing is invented: a `session_state_changed` carries `state` and nothing else besides uuid/session_id
// in all ten measured frames.
//
// What this suite guards, case by case, and why each one is worth its lines:
//   · the two measured state SEQUENCES, because the second one refutes the plan. The plan said „`idle` is
//     the reliable turn end"; run 2 delivered THREE idles, two of them mid-run, one four frames before a
//     workflow started four agents. A build that ends a turn on `idle` ends the same turn three times.
//   · a FOURTH state (a future CLI) must be visibly unknown and must trigger none of the three paths —
//     the same property test/turn-end.test.js enforces, and the reason this project does not ship a
//     surface that asserts what nobody confirmed.
//   · the ADDITIVE promise: with no frame at all (older CLI, variable unset) nothing may appear.
//   · the one case that is actually NEW information — `running` while the panel shows the tab at rest —
//     and its mirror, `running` while the panel already says so, which must stay silent.
//   · `requires_action` must stay silent where the panel holds a richer gate of its own, and speak where
//     it holds none.
//   · the slash catalogue must not be emptied by a malformed frame.
// verify: serial — the end-to-end case SPAWNS a real process through lib/chat.js and waits for the frames
// to arrive IN ORDER, so it must not compete for CPU with the parallel pass. It boots no server, so
// verify.js cannot recognise it from its spawns; this directive is the signal (see verify.js).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { sessionStateNote, sessionStateReport, commandsFromFrame, SESSION_STATES } = require('../public/js/session-state');
// the end-to-end suite at the bottom drives the real engine against the fake CLI — set before lib/chat
// is required so the spawn inherits it (same pattern as test/agent-lanes.test.js)
process.env.FAKE_CLAUDE_SCENARIO = 'sessionstate';
// …and the fake itself. This line was missing: under verify.js the sandbox env supplied it, but
// `node --test test/session-state.test.js` spawned the REAL claude.exe with „bitte den Workflow starten" (four
// transcripts with that user turn were left behind). lib/chat.js now refuses such a start under node --test.
// Absolute, forward slashes — the seam's documented gotcha (a relative path resolves against the chat cwd).
process.env.CLAUDE_UI_FAKE_BIN = path.join(__dirname, '..', 'fake-claude.js').replace(/\\/g, '/');
const { startChat, sendToChat, killChat, respondPermission } = require('../lib/chat');

// the fields every measured session_state_changed frame carries, so each case states only what it is ABOUT
const frame = (state) => ({
  type: 'system', subtype: 'session_state_changed', state,
  uuid: 'e85603dd-5d1c-4498-9109-31c449caa089', session_id: '7d5b9cb0-77a4-462a-a11d-c405713cc9f3',
});
// replay a sequence the way chat-events.js does: the previous record is the input to the next note
function replay(states) {
  let rec = null; const out = [];
  for (const s of states) { const n = sessionStateNote(rec, frame(s)); if (n) rec = n; out.push(n); }
  return { rec, notes: out };
}
const AT_REST = { streaming: false, ownGate: false };
const IN_TURN = { streaming: true, ownGate: false };

describe('G5 — the two measured state sequences', () => {
  // Lauf 1 (paid-2026-10-02T19-55-29-267Z): running _seq 7 → requires_action 37 → running 39 → idle 80
  it('run 1 — every frame is a change, and the last word is idle', () => {
    const { rec, notes } = replay(['running', 'requires_action', 'running', 'idle']);
    assert.deepEqual(notes.map((n) => n.state), ['running', 'requires_action', 'running', 'idle']);
    assert.deepEqual(notes.map((n) => n.changed), [true, true, true, true]);
    assert.ok(notes.every((n) => n.known), 'all four are in the schema');
    assert.equal(rec.state, 'idle');
  });

  // Lauf 2 (paid-2026-10-02T20-40-26-939Z, PROBE_CAP=0.05): running 7 → idle 35 → requires_action 36 →
  // idle 40 → running 54 → idle 58. THE finding that corrected the plan: `idle` came three times, and the
  // one at _seq 40 sits FOUR FRAMES before `task_started` (_seq 42) — i.e. before four agents ran.
  it('run 2 — idle three times, twice mid-run, and requires_action AFTER an idle is normal', () => {
    const { rec, notes } = replay(['running', 'idle', 'requires_action', 'idle', 'running', 'idle']);
    assert.deepEqual(notes.map((n) => n.state), ['running', 'idle', 'requires_action', 'idle', 'running', 'idle']);
    assert.deepEqual(notes.map((n) => n.changed), [true, true, true, true, true, true]);
    assert.equal(rec.state, 'idle');
    // and no `idle` in that run may be read as „the turn is over": the proof is that this suite nowhere
    // turns `idle` into an output at all — see the describe below.
  });

  it('a repeated state is NOT a change — the measurement demands idempotence', () => {
    const { notes } = replay(['idle', 'idle', 'idle']);
    assert.deepEqual(notes.map((n) => n.changed), [true, false, false],
      'three idles arrived in one measured run; a caller that logs/repaints per frame would flood on them');
  });
});

// All three payloads can land on the SAME chip (chat-status.js renderStatusBar), so each carries its own
// tooltip key: one tooltip for three situations would describe two of them wrongly, which is this
// project's bug class in miniature. Pinned here because nothing else can catch a tip that stops matching
// its key.
describe('G5 — every report carries its OWN tooltip', () => {
  it('key and tip never drift apart', () => {
    const cases = [
      [sessionStateNote(null, frame('compacting')), AT_REST, 'session-state.unbekannt', 'session-state.tipUnbekannt'],
      [sessionStateNote(null, frame('requires_action')), AT_REST, 'session-state.wartetEntscheidung', 'session-state.tipWartet'],
      [sessionStateNote(null, frame('running')), AT_REST, 'session-state.arbeitetNoch', 'session-state.tipArbeitetNoch'],
    ];
    for (const [rec, ctx, key, tip] of cases) {
      const r = sessionStateReport(rec, ctx);
      assert.equal(r.key, key);
      assert.equal(r.tip, tip, key + ' must not borrow the explanation of another state');
    }
  });
});

describe('G5 — a state we do not know must be visibly unknown', () => {
  it('a fourth value keeps its raw text and triggers none of the three paths', () => {
    const n = sessionStateNote(null, frame('compacting'));
    assert.equal(n.known, false);
    assert.equal(n.state, 'compacting');
    for (const ctx of [AT_REST, IN_TURN, { streaming: true, ownGate: true }]) {
      const r = sessionStateReport(n, ctx);
      assert.equal(r.key, 'session-state.unbekannt');
      assert.equal(r.raw, 'compacting', 'the CLI\'s own word is the only thing a reader can search for');
      assert.equal(r.sev, 'warn');
    }
  });
  it('the schema has exactly the three measured values — not two, not four', () => {
    assert.deepEqual(SESSION_STATES, ['running', 'requires_action', 'idle']);
  });
  it('an unknown state does not become „arbeitet noch" or „wartet" by accident', () => {
    for (const bogus of ['RUNNING', 'running ', 'idle_2', 'requires-action']) {
      const r = sessionStateReport(sessionStateNote(null, frame(bogus)), AT_REST);
      assert.equal(r.key, 'session-state.unbekannt', bogus + ' is not one of the three');
    }
  });
});

describe('G5 — nothing arrives, nothing changes (the additive promise)', () => {
  it('no record at all produces no report', () => {
    for (const v of [null, undefined, {}, { state: '' }, 42, 'idle']) {
      assert.equal(sessionStateReport(v, AT_REST), null, JSON.stringify(v));
      assert.equal(sessionStateReport(v, IN_TURN), null, JSON.stringify(v));
    }
  });
  it('a frame of another kind is not a session state', () => {
    for (const ev of [
      { type: 'system', subtype: 'init', state: 'running' },
      { type: 'result', subtype: 'success' },
      { type: 'system', subtype: 'session_state_changed' },          // no state field
      { type: 'system', subtype: 'session_state_changed', state: '' },
      null, undefined, 'session_state_changed', 7,
    ]) {
      assert.equal(sessionStateNote(null, ev), null, JSON.stringify(ev));
    }
  });
  it('a garbled frame cannot overwrite a good record', () => {
    const good = sessionStateNote(null, frame('running'));
    assert.equal(sessionStateNote(good, { type: 'system', subtype: 'session_state_changed' }), null);
    assert.equal(good.state, 'running', 'the caller keeps what it had — it only stores a non-null note');
  });
});

// THE case this file exists for. Lauf 1: the session stayed `running` from _seq 39 straight through the
// FIRST result (_seq 58, `result_index 0`) and a whole follow-up turn (second `init` _seq 66) to the
// second result at _seq 79 — while the panel sets `streaming = false` at the first result, which hides
// the Stop button (`#interruptBtn`). That is CHAT-FLOW-3, and the frame is the only thing on the stream
// that knows about it.
describe('G5 — running: silent while the panel agrees, loud where it does not', () => {
  const running = sessionStateNote(null, frame('running'));

  it('the panel already shows a running turn → nothing is added', () => {
    assert.equal(sessionStateReport(running, IN_TURN), null,
      'a permanently full status line is one nobody reads');
  });

  it('the panel shows the tab at rest → say that the session is still working', () => {
    const r = sessionStateReport(running, AT_REST);
    assert.equal(r.key, 'session-state.arbeitetNoch');
    assert.equal(r.sev, 'warn', 'a contradiction between two displays is not a routine note');
    assert.equal(r.raw, undefined, 'a KNOWN state needs no raw value next to it');
  });

  it('an own gate does not silence it — a gate is not the same claim as „still working"', () => {
    const r = sessionStateReport(running, { streaming: false, ownGate: true });
    assert.equal(r.key, 'session-state.arbeitetNoch');
  });

  // …and this is the whole job `idle` has: it is what takes that chip away again (_seq 80 in run 1).
  // Without storing `idle` the marker would stand for ever after the last result — which is the other
  // half of the rule: a state that ARRIVES must not be silently discarded.
  it('idle after running clears it — and says nothing of its own', () => {
    const { rec } = replay(['running', 'idle']);
    assert.equal(rec.state, 'idle');
    assert.equal(sessionStateReport(rec, AT_REST), null, 'idle is a rest report about NOW, never an end');
    assert.equal(sessionStateReport(rec, IN_TURN), null);
    assert.equal(sessionStateReport(rec, { streaming: true, ownGate: true }), null);
  });

  // The sequence of run 1, read the way the strip reads it: before the first result the panel is
  // streaming (silent), after it the panel is at rest while the CLI still says running (loud), and the
  // final idle makes it quiet again. Three reads of ONE record — which is why the record is stored and
  // the text derived, not painted on arrival.
  it('the run-1 timeline produces exactly one visible moment', () => {
    const { rec } = replay(['running', 'requires_action', 'running']);
    assert.equal(sessionStateReport(rec, IN_TURN), null, '_seq 39…57: the panel shows the turn itself');
    assert.equal(sessionStateReport(rec, AT_REST).key, 'session-state.arbeitetNoch', '_seq 58: first result, Stop button gone, session still running');
    const after = sessionStateNote(rec, frame('idle'));
    assert.equal(sessionStateReport(after, AT_REST), null, '_seq 80: the CLI confirms rest');
  });
});

describe('G5 — requires_action: it CONFIRMS the panel\'s gates, it does not replace them', () => {
  const ra = sessionStateNote(null, frame('requires_action'));

  // Measured trigger: an ordinary stdio permission ask (`{tool:"Workflow", allow:true}`) — a frame the
  // panel already receives as `control_request/can_use_tool`, carrying the request id, the tool name and
  // the input. The state frame carries none of that. So where the panel holds a gate it can say WHAT is
  // waiting and this frame must not say the same thing worse.
  it('the panel holds a gate of its own → silent (it can already name it)', () => {
    assert.equal(sessionStateReport(ra, { streaming: true, ownGate: true }), null);
    assert.equal(sessionStateReport(ra, { streaming: false, ownGate: true }), null);
  });

  // …and this is the hole: without a gate of its own, today's panel shows „arbeite…" while the session is
  // blocked on a decision nobody can see. The one thing a permission gate and an open plan/question card
  // have in common is that the panel KNOWS about them; this is the case where it knows nothing.
  it('no gate anywhere → say that the session is waiting for a decision', () => {
    for (const ctx of [IN_TURN, AT_REST]) {
      const r = sessionStateReport(ra, ctx);
      assert.equal(r.key, 'session-state.wartetEntscheidung');
      assert.equal(r.sev, 'info', 'a session legitimately waiting for an answer is not a fault');
    }
  });

  // Measured in BOTH runs: `requires_action` arrives ONE FRAME BEFORE the `can_use_tool` request it
  // belongs to (_seq 37 vs 38 in run 1, 36 vs 37 in run 2). So for one frame there is a state and no
  // gate, and a frame later there is both. The report must flip on its own as soon as the gate lands —
  // which is exactly why it is derived on every read instead of painted once at arrival.
  it('the one-frame window before the gate closes by itself', () => {
    assert.equal(sessionStateReport(ra, IN_TURN).key, 'session-state.wartetEntscheidung', '_seq 37: state, no gate yet');
    assert.equal(sessionStateReport(ra, { streaming: true, ownGate: true }), null, '_seq 38: the gate arrived — the panel speaks');
  });
});

describe('G5 — commands_changed: the slash catalogue pulls through', () => {
  // The measured frame carried 60 entries and the same vocabulary as `init.slash_commands` (set against
  // set: identical). Three shapes occur, all reproduced here: plain, `builtin: true` (45 of 60) and
  // `aliases` (9 of 60).
  const real = {
    type: 'system', subtype: 'commands_changed', uuid: 'u', session_id: 's',
    commands: [
      { name: 'mein-tag', description: 'Mein Tag (user)', argumentHint: '' },
      { name: 'code-review', description: 'Review the current diff', argumentHint: '[low|medium|high]', builtin: true },
      { name: 'frontend-design:frontend-design', description: '(frontend-design) …', argumentHint: '', aliases: ['frontend-design'] },
    ],
  };

  it('produces the same shape chat-events.js already assigns on `init`', () => {
    assert.deepEqual(commandsFromFrame(real),
      ['/mein-tag', '/code-review', '/frontend-design:frontend-design', '/frontend-design'],
      'an alias is typeable too — but under its own name, never instead of the real one');
  });

  it('an empty or malformed list is IGNORED, never adopted', () => {
    // A bad frame must not leave the composer with no slash menu at all — and „the menu is gone" is not a
    // state any measured frame describes: every list contains the builtins.
    for (const bad of [
      { type: 'system', subtype: 'commands_changed', commands: [] },
      { type: 'system', subtype: 'commands_changed', commands: null },
      { type: 'system', subtype: 'commands_changed' },
      { type: 'system', subtype: 'commands_changed', commands: 'help' },
      { type: 'system', subtype: 'commands_changed', commands: [null, {}, { name: '' }, { name: '   ' }] },
      null, undefined, 42,
    ]) {
      assert.equal(commandsFromFrame(bad), null, JSON.stringify(bad));
    }
  });

  it('a duplicate name is listed once, and a name that already carries a slash is dropped', () => {
    const r = commandsFromFrame({
      commands: [{ name: 'help' }, { name: 'help' }, { name: 'x', aliases: ['x', 'y'] }, { name: '/clear' }],
    });
    assert.deepEqual(r, ['/help', '/x', '/y'], '„//clear" would be a menu entry the CLI cannot accept');
  });
});

// ---------------------------------------------------------------------------------------------------
// End to end. Everything above replays states from a variable — which proves the decision but not that
// these frames arrive this way through a real process, nor that the env field that produces them is
// really set. What is observable without a browser is the layer directly under the paint:
//   fake-claude.js (FAKE_CLAUDE_SCENARIO=sessionstate) writes the measured sequence to a real stdout →
//   the REAL engine (lib/chat.js — the same startChat/readline/broadcast the SSE route uses, through its
//   `onEvent` headless seam) parses and relays it → the mirror of the browser pump below turns it into
//   records and reports. A scenario that drifts from the protocol, or an engine that swallows these
//   `system` frames, fails here instead of on a user's status strip.
// ---------------------------------------------------------------------------------------------------
describe('G5 end to end — the frames come off a real process, through the real engine', () => {
  it('scenario sessionstate: commands before init, and the chip appears at the FIRST result', async () => {
    const seen = [];
    let rec = null, cmds = null, permId = null;
    // the two moments the strip would be repainted, captured with the panel's own belief at that instant:
    // `streaming` is true from the send until the first `result` (chat-render.js setComposerBusy).
    // Modelled by hand, and valid for THIS scenario only: it sends no stream/assistant frame after the first
    // result. One that does is adopted as a running turn since CHAT-FLOW-3 (test/chat-flow3.test.js runs that).
    let streaming = false;
    const reports = [];
    const chat = startChat({ cwd: path.join(__dirname, '..'), permissionMode: 'plan' });
    try {
      await new Promise((resolve) => {
        const bail = setTimeout(resolve, 15000); // a broken scenario → the asserts below say so
        chat.onEvent = (ev) => {
          seen.push(ev);
          const n = sessionStateNote(rec, ev);
          if (n) rec = n;
          if (ev.type === 'system' && ev.subtype === 'commands_changed') cmds = commandsFromFrame(ev);
          // the panel's own gate: it exists from the control_request until it is answered
          if (ev.type === 'control_request' && ev.request && ev.request.subtype === 'can_use_tool') {
            permId = ev.request_id;
            reports.push({ at: 'gate', r: sessionStateReport(rec, { streaming, ownGate: true }) });
            respondPermission(chat, permId, 'allow');
            return;
          }
          if (ev.type === 'result') {
            streaming = false; // the panel drops it HERE — including at `result_index 0`
            reports.push({ at: 'result' + ev.result_index, r: sessionStateReport(rec, { streaming, ownGate: false }) });
            return;
          }
          if (n && n.state === 'idle') {
            reports.push({ at: 'idle', r: sessionStateReport(rec, { streaming, ownGate: false }) });
            clearTimeout(bail); resolve();
          }
        };
        streaming = true;
        sendToChat(chat, 'bitte den Workflow starten');
      });
    } finally { try { killChat(chat); } catch { /* */ } }

    // the wire really carried the shapes the cases above pin (nothing here is asserted against a mock)
    const states = seen.filter((e) => e.type === 'system' && e.subtype === 'session_state_changed').map((e) => e.state);
    assert.deepEqual(states, ['running', 'requires_action', 'running', 'idle'],
      'the measured order of run 1 (_seq 7 / 37 / 39 / 80) must survive the engine');
    // …and with the shape of the real frames: `state` plus uuid/session_id, nothing invented
    const one = seen.find((e) => e.subtype === 'session_state_changed');
    assert.deepEqual(Object.keys(one).sort(), ['_seq', 'session_id', 'state', 'subtype', 'type', 'uuid'],
      '_seq is the panel server\'s own (broadcast); everything else is the CLI\'s measured shape');

    // commands_changed arrives BEFORE init, exactly as measured (_seq 4 against _seq 8)
    const iCmd = seen.findIndex((e) => e.subtype === 'commands_changed');
    const iInit = seen.findIndex((e) => e.subtype === 'init');
    assert.ok(iCmd >= 0 && iInit > iCmd, 'commands_changed must be on the wire, and before init');
    assert.deepEqual(cmds, ['/mein-tag', '/code-review', '/frontend-design:frontend-design', '/frontend-design']);

    // THE point of the scenario: two results, and `idle` only after the LAST one
    const results = seen.filter((e) => e.type === 'result').map((e) => e.result_index);
    assert.deepEqual(results, [0, 1], 'the CLI writes several result frames per run — this is CHAT-FLOW-3');
    assert.deepEqual(reports.map((x) => x.at), ['gate', 'result0', 'result1', 'idle']);
    assert.equal(reports[0].r, null, 'at the gate the panel can name what is waiting — the frame stays silent');
    assert.equal(reports[1].r.key, 'session-state.arbeitetNoch', 'first result: Stop button gone, session still running');
    assert.equal(reports[2].r.key, 'session-state.arbeitetNoch', 'still running at the second result');
    assert.equal(reports[3].r, null, 'and idle is what takes the marker away again');
  });
});
