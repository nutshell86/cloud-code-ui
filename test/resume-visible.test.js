'use strict';
// A resuming tab says that it resumes, what it waits for and for how long (07.10.: a tab that took long after a server
// restart read as hung — the tab bar showed nothing, the chip said „◦ idle", and the only loader vanished after 20 s
// while the resume was still running). The shipped functions are lifted out of chat.js and run against stubs.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { liftFn } = require('./event-pump');

const PUB = path.join(__dirname, '..', 'public', 'js');
const CHAT = fs.readFileSync(path.join(PUB, 'chat.js'), 'utf8');
const SESS = fs.readFileSync(path.join(PUB, 'sessions.js'), 'utf8');
const lift = (names, env) => new Function(...Object.keys(env), names.map((n) => liftFn(CHAT, n, 'chat.js')).join('\n') + '\nreturn {' + names.join(',') + '};')(...Object.values(env));

describe('the chip says „wird fortgesetzt" with seconds — not „idle" — while a tab resumes', () => {
  const { sessionChipText } = lift(['sessionChipText'], { tt: (k) => k, Date: { now: () => 10500 } });
  it('resuming beats the optimistically claimed session id', () => {
    assert.equal(sessionChipText({ sessionId: '11111111-x', _resuming: true, _resumeAt: 3000 }), '◌ chat.wirdFortgesetzt · 8 s');
    assert.equal(sessionChipText({ sessionId: '11111111-x', _resuming: true }), '◌ chat.wirdFortgesetzt');
  });
  it('…and once it is done, the chip is what it was', () => {
    assert.equal(sessionChipText({ sessionId: '11111111-x', id: 'c1' }), '◦ chat.idle · 11111111');
  });
});

describe('resumeSlowest — the stage the 🔔 log line names', () => {
  const { resumeSlowest } = lift(['resumeSlowest'], {});
  it('the longest closed stage, and an open one counts up to now', () => {
    assert.deepEqual(resumeSlowest([{ key: 'sessions', at: 0, end: 400 }, { key: 'spawn', at: 400, end: 21400 }, { key: 'history', at: 21400, end: 21700 }], 22000), { key: 'spawn', ms: 21000 });
    assert.deepEqual(resumeSlowest([{ key: 'spawn', at: 0, end: 300 }, { key: 'paint', at: 300 }], 9300), { key: 'paint', ms: 9000 });
    assert.equal(resumeSlowest([], 1), null);
  });
});

describe('the 20 s safety frees the composer but KEEPS the box — for a resume', () => {
  const calls = { enabled: [], hidden: 0, painted: 0 };
  const env = { ACTIVE: null, setComposerEnabled: (on) => calls.enabled.push(on), hideResumeLoading: () => { calls.hidden++; }, resumePaint: () => { calls.painted++; } };
  const { resumeTooSlow } = lift(['resumeTooSlow'], env);
  it('a resume still running: marked slow, composer freed, box stays (no hide)', () => {
    const t = { _resuming: true };
    env.ACTIVE = t;
    const fn = lift(['resumeTooSlow'], Object.assign({}, env, { ACTIVE: t })).resumeTooSlow;
    fn(t);
    assert.equal(t._resumeSlow, true);
    assert.deepEqual(calls.enabled, [true]);
    assert.equal(calls.hidden, 0);
  });
  it('not a resume (a fork\'s start): the old rule — hide', () => {
    resumeTooSlow({ _resuming: false });
    assert.equal(calls.hidden, 1);
  });
});

describe('wiring', () => {
  it('the tab bar spins for a resuming tab, too', () => {
    assert.match(CHAT, /else if \(t\._resuming\) \{ const sp = el\('span', 'ct-spin resuming'\);/);
  });
  it('the safety goes through resumeTooSlow, no longer straight to hideResumeLoading', () => {
    assert.match(CHAT, /tab\._resumeSafety = setTimeout\(\(\) => resumeTooSlow\(tab\), RESUME_SLOW_MS\);/);
    assert.doesNotMatch(CHAT, /_resumeSafety = setTimeout\(\(\) => hideResumeLoading\(tab\), 20000\)/);
  });
  it('both resume paths mark their stages, finish, and repaint chip + tab bar; the history fetch marks „paint"', () => {
    for (const fn of ['_resumeDormantNow', '_restartResumeNow']) {
      const src = liftFn(CHAT, fn, 'chat.js');
      assert.match(src, /resumeStage\((t|tab), 'spawn'\)/, fn);
      assert.match(src, /resumeStage\((t|tab), 'history'\)/, fn);
      assert.match(src, /resumeFinish\((t|tab)\)/, fn);
      assert.match(src, /refreshSessionChip\((t|tab)\)/, fn);
      assert.match(src, /renderTabs\(\)/, fn);
    }
    assert.match(liftFn(CHAT, '_resumeDormantNow', 'chat.js'), /'sessions' : 'spawn'/);
    assert.match(liftFn(SESS, 'renderResumeHistory', 'sessions.js'), /if \(tab\._resuming && typeof resumeStage === 'function'\) resumeStage\(tab, 'paint'\);/);
  });
});
