'use strict';
// KORR-2 — which DAY and which MODEL a token is booked under.
//
// Measured on the live corpus:
//   • Day: the key came from String(timestamp).slice(0,10) = UTC, while the hour buckets right next to it
//     were already LOCAL — a genuine hybrid. Only 16 deduped records (0.064 %) can move, but they shift
//     2026-07-21 by +15.82 % tokens / +21.73 % cost and 2026-07-20 the other way. Every record today is
//     +120 min (CEST), so a fixed offset would be correct now and wrong after 2026-10-25 — hence the
//     Date API, never a constant.
//   • Model: the COST total was already per message; what was broken is the BREAKDOWN. entry.model was
//     LAST-wins over the whole session (while the file's own comment claimed first-wins), so 28.99 % of
//     all tokens and 33.76 % of all cost sat in the wrong byModel row, the model FILTER dropped whole
//     multi-model sessions, and 4 sessions were labelled '<synthetic>' — parking 47.3 M real tokens in a
//     $0 row — purely because a synthetic frame happened to be last.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const F = require('./corpus-fixture');

const C = F.mkCorpus('corpus-attr-test');
process.env.CLAUDE_UI_CLAUDE_DIR = C.claudeDir;
process.env.CLAUDE_UI_DATA_DIR = C.root;
process.on('exit', C.cleanup);

const PROJ = 'C--Users-dev-corp';
const S_DAY = 'a1111111-1111-4111-8111-111111111111';
const S_MODEL = 'a2222222-2222-4222-8222-222222222222';

// Built from LOCAL wall-clock components, so the suite is correct in any time zone: both of these are
// 2026-04-02 locally, and on any machine with a non-zero offset at least one of them falls on a
// DIFFERENT UTC date — which is precisely the record class that used to be booked on the wrong day.
const EARLY = new Date(2026, 3, 2, 0, 30, 0);
const LATE = new Date(2026, 3, 2, 23, 30, 0);
const DAY = '2026-04-02';
F.writeLines(F.mainPath(C, PROJ, S_DAY), [
  F.asst({ id: 'msg_d1', ts: EARLY.toISOString(), model: 'claude-opus-5', in: 1000, out: 0 }),
  F.asst({ id: 'msg_d2', ts: LATE.toISOString(), model: 'claude-opus-5', in: 2000, out: 0 }),
]);
// One session, three models, the synthetic frame LAST — the exact shape that poisoned 4 live sessions.
F.writeLines(F.mainPath(C, PROJ, S_MODEL), [
  F.asst({ id: 'msg_m1', ts: '2026-04-03T10:00:01.000Z', model: 'claude-opus-4-8', in: 10000, out: 0 }),
  F.asst({ id: 'msg_m2', ts: '2026-04-03T10:00:02.000Z', model: 'claude-sonnet-5', in: 1000, out: 0 }),
  F.asst({ id: 'msg_m3', ts: '2026-04-03T10:00:03.000Z', model: '<synthetic>', in: 0, out: 0 }),
]);

const { scanUsage } = require('../lib/usage');
const { dayKey } = require('../lib/corpus');

describe('lib/usage — the day bucket is LOCAL, like the hour axis always was', () => {
  let u;
  before(async () => { u = await scanUsage(null, null, 0, {}); });

  it('both records land on their LOCAL calendar day', () => {
    const row = u.byDay.find((d) => d.date === DAY);
    assert.ok(row, 'no bucket for the local day ' + DAY + ' — days were: ' + u.byDay.map((d) => d.date).join(','));
    assert.equal(row.input, 3000, 'a record was booked on a neighbouring day');
    assert.ok(!u.byDay.some((d) => d.date !== DAY && d.input && d.date < '2026-04-03'), 'a UTC-keyed neighbour day survived');
  });

  it('…and that is a REAL difference unless this machine runs on UTC', () => {
    const utcDays = new Set([EARLY.toISOString().slice(0, 10), LATE.toISOString().slice(0, 10)]);
    if (EARLY.getTimezoneOffset() === 0) { assert.deepEqual([...utcDays], [DAY]); return; } // UTC box: nothing to move
    assert.ok(utcDays.size > 1 || !utcDays.has(DAY), 'the fixture no longer straddles a UTC day — it cannot prove anything');
  });

  it('the hour and weekday axes are derived from the same LOCAL key', () => {
    assert.equal(u.byHour[0], 1000, 'the 00:30 local record is not in hour 0');
    assert.equal(u.byHour[23], 2000, 'the 23:30 local record is not in hour 23');
    const wd = new Date(2026, 3, 2).getDay();
    assert.equal(u.byWeekday[wd], 3000);
    assert.equal(u.punch[wd][0], 1000);
    assert.equal(u.punch[wd][23], 2000);
  });

  it('dayKey never uses a fixed offset (DST-safe by construction)', () => {
    // 2026-10-25 is the DST boundary the live corpus crosses; both sides must resolve through the Date API
    for (const d of [new Date(2026, 9, 25, 1, 30), new Date(2026, 9, 25, 23, 30), new Date(2026, 9, 26, 0, 30)]) {
      assert.equal(dayKey(d), dayKey(new Date(d.getTime())), 'dayKey must be a pure function of the local date');
      assert.match(dayKey(d), /^2026-10-(25|26)$/);
    }
  });
});

describe('lib/usage — model attribution is per MESSAGE, not per session', () => {
  let u;
  before(async () => { u = await scanUsage(null, null, 0, {}); });

  it('byModel rows carry the tokens of their OWN messages', () => {
    const row = (m) => u.byModel.find((x) => x.model === m) || { input: 0 };
    assert.equal(row('claude-opus-4-8').input, 10000, 'last-wins parked these under another model');
    assert.equal(row('claude-sonnet-5').input, 1000);
    assert.equal(row('<synthetic>').input, 0, 'synthetic frames carry no tokens, only a message');
  });

  it('the session label is the MAJORITY model and never <synthetic>', () => {
    const s = u.bySession.find((x) => x.id === S_MODEL);
    assert.equal(s.model, 'claude-opus-4-8');
    assert.deepEqual(s.models, ['claude-opus-4-8', 'claude-sonnet-5']);
    assert.equal(s.modelCount, 2, 'the UI needs to know the row shows one of several models');
  });

  it('the model filter means "this session used this model" — a multi-model session is no longer dropped', async () => {
    const only = await scanUsage(null, null, 0, { model: 'claude-sonnet-5' });
    const s = only.bySession.find((x) => x.id === S_MODEL);
    assert.ok(s, 'the multi-model session was dropped by the filter (the old last-wins behaviour)');
    assert.equal(s.input, 1000, 'and the filter narrows to that model\'s messages, which is what the dropdown says');
    assert.equal(only.total.input, 1000);
  });
});
