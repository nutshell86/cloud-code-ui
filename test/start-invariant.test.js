'use strict';
// #1/#17 — the invariant of the resume wait in POST /api/chat/start: between the END of the
// endResumeCollisions loop and the startChat call there is NO await. The loop is what makes „the old writer of
// this transcript is gone" true; an await after it hands the event loop to whatever is queued — a second
// start of the same session, the stop route, a resume from another tab — and the new process spawns against a
// premise that may no longer hold. Two writers on one .jsonl is the defect #1/#17 exists for.
//
// A SOURCE check, deliberately: the property is syntactic (no `await` in that stretch), and a behaviour test
// would have to win a race to fail. Measured from the loop's end, not from the `if (resume …)` above it —
// the awaits INSIDE the loop are the wait itself. Comments are stripped first, so a sentence that mentions
// „await" cannot trip it. Agreed with the parallel session on 2026-10-05: its fix/start-fork-reload moves the
// permissionMode check above the MCP write and sets onSessionId after the try — both outside this stretch.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');

describe('POST /api/chat/start — no await between the resume wait and the spawn (#1/#17)', () => {
  it('the stretch from the end of the endResumeCollisions loop to startChat( holds no await', () => {
    const loop = SRC.indexOf('endResumeCollisions(resume)');
    assert.ok(loop > 0, 'the resume wait loop is gone or renamed — then this guard guards nothing');
    const awaitGone = SRC.indexOf('await gone', loop);
    assert.ok(awaitGone > loop && awaitGone - loop < 200, 'the loop no longer awaits `gone` right there — re-anchor this test');
    const loopEnd = SRC.indexOf('}', awaitGone);
    const spawn = SRC.indexOf('startChat(', loopEnd);
    assert.ok(spawn > loopEnd, 'no startChat( after the loop');
    const stretch = SRC.slice(loopEnd + 1, spawn);
    assert.ok(stretch.split('\n').length < 12, 'the spawn moved far away from the wait (' + stretch.split('\n').length + ' lines) — look at what came in between');
    assert.doesNotMatch(stripComments(stretch), /\bawait\b/, 'an await between the resume wait and the spawn:\n' + stretch);
  });

  // CHAT-FLOW-4 (review) — when all three rounds of the loop awaited a kill, the last owner verdict is as old as that
  // wait; startChat's backstop would then end whatever spawned meanwhile, an attached owner included, unasked. So the
  // question is asked once more after the loop, in that same await-free stretch. A SOURCE check for the same reason
  // as above: the behaviour needs a fourth resume to spawn inside the third round's kill — a race a test cannot
  // stage reliably (the review could not reproduce it either).
  it('after the loop the owner question is asked once more, synchronously, before the spawn (CHAT-FLOW-4)', () => {
    const loop = SRC.indexOf('endResumeCollisions(resume)');
    const loopEnd = SRC.indexOf('}', SRC.indexOf('await gone', loop));
    const stretch = stripComments(SRC.slice(loopEnd + 1, SRC.indexOf('startChat(', loopEnd)));
    assert.match(stretch, /if \(!takeover\) refuseIfHeld\(resume\);/, 'no owner check between the loop and the spawn:\n' + stretch);
  });
  // Stufe 2 (rails a/b) — the project lookup, the path check with its deadline (J11) and the fresh start's label are
  // awaits of this route; all three must come BEFORE the loop, and the stretch after it still ends in the owner
  // question and the „page gone" check, both synchronous, right before the spawn.
  it('the Stufe-2 awaits sit before the loop; the stretch still ends with refuseIfHeld + the client-gone check', () => {
    const code = stripComments(SRC);
    const loop = code.indexOf('endResumeCollisions(resume)');
    for (const call of ['await projectsLib.resolveStart(', 'await projectsLib.checkPaths(', 'await projectsLib.recordFreshStart(']) {
      const at = code.indexOf(call);
      assert.ok(at > 0 && at < loop, call + ' is missing or after the resume loop');
    }
    const loopEnd = code.indexOf('}', code.indexOf('await gone', loop));
    const stretch = code.slice(loopEnd + 1, code.indexOf('startChat(', loopEnd));
    assert.match(stretch, /if \(res\.destroyed \|\| req\.socket\.destroyed\) throw clientGoneError\(\);\s*chat = $/, 'the client-gone check is not the last thing before the spawn:\n' + stretch);
  });
  // rails (c) — refuseIfHeld's „verdict and spawn in one tick" holds only while startChat itself never awaits: the
  // path check with its deadline (J11) runs in the route and is handed in as opts.pathCheck.
  it('lib/chat.js startChat stays synchronous', () => {
    const CHAT = fs.readFileSync(path.join(__dirname, '..', 'lib', 'chat.js'), 'utf8');
    assert.match(CHAT, /^function startChat\(opts\) \{$/m);
    assert.doesNotMatch(CHAT, /async\s+function\s+startChat/);
  });
});
