'use strict';
// The persistent fold cache (C7) and the in-flight guard.
//
// Cold cost measured on the live corpus: scanSessions 12.2-14.9 s + scanUsage 12.4-15.2 s = 22-26 s for
// the pair, reading 942.5 MB because all 297 files were opened TWICE. With one fold + this cache a warm
// restart is stat (76-91 ms) + readFile (16 ms) + JSON.parse (19-34 ms) ≈ 0.15-0.35 s. The cache MUST
// carry the per-id maxima next to the byte offset, or a duplicate group split across a resume boundary
// double-counts — which is what T20 pins.
//
// The in-flight map is a CORRECTNESS fix: without it two concurrent requests took the same stale entry
// object and folded the same tail into it twice (measured: 3,300 expected → 4,400 tokens), and the
// over-count was then stored under the fresh (size, mtime) and served as a valid hit forever.
const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const F = require('./corpus-fixture');

const C = F.mkCorpus('corpus-cache-test');
process.env.CLAUDE_UI_CLAUDE_DIR = C.claudeDir;
process.env.CLAUDE_UI_DATA_DIR = C.root;
process.on('exit', C.cleanup);

const PROJ = 'C--Users-dev-corp';
const SESS = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const FILE = F.mainPath(C, PROJ, SESS);

const { scanCorpus, flushCache, _resetCorpusCache, dayKey, CACHE_V } = require('../lib/corpus');
const { TRANSCRIPT_CACHE_FILE, ROOT } = require('../lib/paths');

const seed = () => F.writeLines(FILE, [
  F.user({ ts: '2026-04-01T09:00:00.000Z' }),
  F.asst({ id: 'msg_c1', ts: '2026-04-01T09:00:01.000Z', in: 1000, out: 100 }),
  F.asst({ id: 'msg_c2', ts: '2026-04-01T09:00:02.000Z', in: 2000, out: 200 }),
]);
const totals = (corpus) => {
  const t = { input: 0, output: 0, messages: 0 };
  for (const r of corpus.recs) for (const d in r.d) for (const m in r.d[d].m) { const b = r.d[d].m[m]; t.input += b[0]; t.output += b[1]; t.messages += b[6]; }
  return t;
};
// The record of OUR file, and one (day, model) bucket out of it. The per-day view is the point of T26/T27:
// the TOTALS can be right while the day rows are wrong, so an assertion on totals alone cannot see it.
const recOf = (corpus) => corpus.recs.find((r) => r.full === FILE);
const bucketOf = (corpus, day, model) => { const b = recOf(corpus).d[day]; return b ? (b.m[model] || null) : null; };
const hoursOf = (corpus, day, model) => { const b = recOf(corpus).d[day]; return b && b.h ? (b.h[model] || null) : null; };
// Everything a damaged cache record could get WRONG that the token totals cannot see (T23): the per-model
// answer counts, the width of the per-id tuples, whether the hour histogram is per model (v3) or the old
// day-level array (v2), and the fields that are only ever read as strings/objects.
function shapeOf(corpus) {
  const r = recOf(corpus);
  return {
    md: r.md,
    cwdType: typeof r.cwd,
    cs: r.cs,
    idTupleWidths: Object.keys(r.ids).sort().map((k) => r.ids[k].length),
    idOwnerDayTypes: Object.keys(r.ids).sort().map((k) => typeof r.ids[k][7]),
    hourShape: Object.keys(r.d).sort().map((d) => {
      const h = r.d[d].h;
      if (h == null) return 'none';
      if (Array.isArray(h)) return 'day-array';
      return Object.keys(h).sort().map((m) => m + ':' + (Array.isArray(h[m]) ? h[m].length : '?')).join(',');
    }),
  };
}

// The byte count of a file, taken off an OPEN DESCRIPTOR instead of off the path. The house form is
// lib/backups.js readDiffSide (`fsp.open` first, then `fh.stat()` on the handle): `stat(path)` and a
// later operation on the same PATH are two independent lookups, and nothing binds them to the same
// file. CodeQL flags exactly that pair — js/file-system-race, CWE-367, security-severity HIGH, alert
// #79 — and it pointed at the `fs.appendFileSync(FILE, …)` in T21, whose only path-based "check"
// ahead of it was `fs.statSync(FILE).size` a few lines above. In a sandbox corpus nobody else writes
// to, the race is not the damage; the damage would be a test that compares a byte count against a
// file it never looked at, and "the fixture kept its byte count" is the whole premise of T21's
// "same size, new mtime" case. So the number comes from the handle.
function sizeOnDisk(file) {
  const fd = fs.openSync(file, 'r');
  try { return fs.fstatSync(fd).size; } finally { fs.closeSync(fd); }
}

// a virgin full parse of the same file, by the same rule, with no cache involved at all
function groundTruth(file) {
  const ids = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'assistant' || !o.message || !o.message.usage) continue;
    const u = o.message.usage, key = o.message.id || Symbol('noid');
    const tot = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const prev = ids.get(key);
    if (!prev || prev.tot < tot) ids.set(key, { tot, input: u.input_tokens || 0, output: u.output_tokens || 0 });
  }
  let input = 0, output = 0;
  for (const v of ids.values()) { input += v.input; output += v.output; }
  return { input, output, messages: ids.size };
}

describe('lib/corpus — the persistent cache (C7)', () => {
  beforeEach(() => { _resetCorpusCache(); try { fs.rmSync(TRANSCRIPT_CACHE_FILE); } catch { /* */ } seed(); });

  it('T25 the cache file follows the data-dir seam and never lands in the git checkout', () => {
    assert.ok(TRANSCRIPT_CACHE_FILE.startsWith(C.root), 'under test it must live in the sandbox: ' + TRANSCRIPT_CACHE_FILE);
    assert.ok(!TRANSCRIPT_CACHE_FILE.startsWith(path.join(ROOT, 'transcript-cache')), 'never next to the sources');
    // …and in PRODUCTION (no CLAUDE_UI_DATA_DIR) under LOCALAPPDATA, NOT in DATA_DIR === the checkout:
    // an untracked file there makes `git status --porcelain` dirty and POST /api/version/pull answers
    // 409 `dirty-main` forever — the panel would permanently block its own Update button.
    const env = Object.assign({}, process.env, { LOCALAPPDATA: 'C:\\fake-local', CLAUDE_UI_CLAUDE_BIN: 'C:\\nope\\claude.exe' });
    delete env.CLAUDE_UI_DATA_DIR;
    const out = execFileSync(process.execPath, ['-e', 'process.stdout.write(require(process.argv[1]).TRANSCRIPT_CACHE_FILE)', path.join(ROOT, 'lib', 'paths.js')], { env, encoding: 'utf8' });
    assert.equal(out, path.join('C:\\fake-local', 'claude-code-ui', 'transcript-cache.json'));
  });

  it('T18 cold fold → write → re-read: identical aggregates and NO second fold', async () => {
    const cold = await scanCorpus();
    assert.equal(cold.stats.folded, 1);
    const before = totals(cold);
    assert.equal(await flushCache(), true, 'the cache was not written');
    _resetCorpusCache();
    const warm = await scanCorpus();
    assert.equal(warm.stats.folded, 0, 'the cache was ignored and everything was folded again');
    assert.deepEqual(totals(warm), before);
    assert.deepEqual(before, groundTruth(FILE));
  });

  it('T19 an append folds only the TAIL and still equals a virgin full parse', async () => {
    await scanCorpus();
    await flushCache();
    _resetCorpusCache();
    fs.appendFileSync(FILE, F.asst({ id: 'msg_c3', ts: '2026-04-01T09:00:03.000Z', in: 300, out: 30 }) + '\n');
    const after = await scanCorpus();
    assert.equal(after.stats.folded, 1);
    assert.deepEqual(totals(after), groundTruth(FILE));
    assert.deepEqual(totals(after), { input: 3300, output: 330, messages: 3 });
  });

  it('T20 an append INSIDE a duplicate group does not double-count (this is why the ids live in the cache)', async () => {
    await scanCorpus();
    await flushCache();
    _resetCorpusCache(); // the per-id maxima must come back FROM DISK, not from memory
    // the CLI writes the rest of msg_c2's answer: the SAME id with a larger usage
    fs.appendFileSync(FILE, F.asst({ id: 'msg_c2', ts: '2026-04-01T09:00:02.500Z', in: 2000, out: 900 }) + '\n');
    const after = await scanCorpus();
    assert.deepEqual(totals(after), groundTruth(FILE));
    assert.deepEqual(totals(after), { input: 3000, output: 1000, messages: 2 }, 'the resumed tail re-added the whole usage instead of the increment');
  });

  it('T21 shrink, same-size-new-mtime and bytesConsumed > size all force a FULL refold', async () => {
    // shrink
    await scanCorpus(); await flushCache(); _resetCorpusCache();
    F.writeLines(FILE, [F.asst({ id: 'msg_c1', ts: '2026-04-01T09:00:01.000Z', in: 1000, out: 100 })]);
    assert.deepEqual(totals(await scanCorpus()), { input: 1000, output: 100, messages: 1 });

    // same size, new mtime (rewritten in place) — equality on (size, mtime), never ordering
    await flushCache(); _resetCorpusCache();
    const sz = sizeOnDisk(FILE);
    F.writeLines(FILE, [F.asst({ id: 'msg_c9', ts: '2026-04-01T09:00:01.000Z', in: 1000, out: 100 })]);
    assert.equal(sizeOnDisk(FILE), sz, 'fixture must keep the byte count for this case');
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(FILE, t, t);
    const re = await scanCorpus();
    assert.equal(re.stats.folded, 1, 'a rewrite with the same size was served from the cache');
    assert.deepEqual(totals(re), { input: 1000, output: 100, messages: 1 });

    // bytesConsumed > size: a file that grew mid-fold. Injected through the cache file, because that is
    // exactly the state a crash between fold and stat leaves behind.
    await flushCache();
    const raw = JSON.parse(fs.readFileSync(TRANSCRIPT_CACHE_FILE, 'utf8'));
    raw.files[FILE].b = 10 ** 9;
    raw.files[FILE].d = {}; raw.files[FILE].ids = {};
    fs.writeFileSync(TRANSCRIPT_CACHE_FILE, JSON.stringify(raw));
    _resetCorpusCache();
    fs.appendFileSync(FILE, F.asst({ id: 'msg_c8', ts: '2026-04-01T09:00:09.000Z', in: 7, out: 7 }) + '\n');
    assert.deepEqual(totals(await scanCorpus()), groundTruth(FILE), 'bytesConsumed > size must refold from 0');
  });

  it('T22 a renamed/deleted file is PRUNED — no stale aggregate survives', async () => {
    await scanCorpus(); await flushCache();
    const moved = path.join(path.dirname(FILE), 'deleted-' + SESS + '-123.jsonl.bak');
    fs.renameSync(FILE, moved); // the delete route's shape: rename out of the corpus (size+mtime survive)
    try {
      const after = await scanCorpus();
      assert.deepEqual(totals(after), { input: 0, output: 0, messages: 0 });
      await flushCache();
      const raw = JSON.parse(fs.readFileSync(TRANSCRIPT_CACHE_FILE, 'utf8'));
      assert.ok(!raw.files[FILE], 'the record of a vanished file stayed in the cache');
    } finally { fs.renameSync(moved, FILE); }
  });

  it('T23 a corrupt, truncated, v-mismatched, claudeDir-mismatched or STRUCTURALLY DAMAGED cache is a MISS', async () => {
    // The syntactic half of this table was always here. The structural half is the one that bit: a file
    // that PARSES but whose md / d / ids are not the shape the fold writes was adopted anyway (the guard
    // was `typeof o.s === 'number' && typeof o.m === 'number'`, then `md: o.md || {}` and friends), so a
    // wrong money figure reached the screen — and STUCK, because the adopted record is re-stored under the
    // fresh (size, mtime) and is a valid hit from then on.
    const cold = await scanCorpus(); await flushCache();
    const good = fs.readFileSync(TRANSCRIPT_CACHE_FILE, 'utf8');
    const expect = totals(cold), expectShape = shapeOf(cold);
    assert.deepEqual(expect, groundTruth(FILE), 'the baseline itself must equal a virgin parse');
    // a damaged body: parse the GOOD file, hand our one record to fn, re-serialize
    const dmg = (fn) => { const o = JSON.parse(good); fn(o.files[FILE], o); return JSON.stringify(o); };
    const eachBucket = (r, fn) => { for (const d in r.d) for (const m in r.d[d].m) fn(r.d[d].m[m], r.d[d], m); };
    const trusted = [];
    for (const [label, body] of [
      // --- syntactic / envelope damage (unchanged) ---
      ['empty', ''],
      ['garbage', 'not json at all'],
      ['truncated', good.slice(0, Math.floor(good.length / 2))],
      ['v-mismatch', JSON.stringify(Object.assign(JSON.parse(good), { v: 999 }))],
      ['claudeDir-mismatch', JSON.stringify(Object.assign(JSON.parse(good), { claudeDir: 'C:\\somewhere-else' }))],
      // CACHE_V, never a literal: with a hardcoded 2 these two stopped testing their own case the moment
      // the version was bumped to 3 — they passed as a v-mismatch instead.
      ['no files key', JSON.stringify({ v: CACHE_V, claudeDir: C.claudeDir })],
      ['files is an array', JSON.stringify({ v: CACHE_V, claudeDir: C.claudeDir, files: [] })],
      // --- structural damage: parses, wrong shape, dereferenced straight into a money figure ---
      ['md is an array', dmg((r) => { r.md = ['claude-opus-5']; })],
      ['an md count is a string', dmg((r) => { for (const k in r.md) r.md[k] = String(r.md[k]); })],
      ['d is an array', dmg((r) => { r.d = []; })],
      ['a day bucket has no m', dmg((r) => { for (const d in r.d) r.d[d] = { h: null }; })],
      ['a model bucket is a string', dmg((r) => { eachBucket(r, (b, day, m) => { day.m[m] = 'nope'; }); })],
      ['a model bucket is too short', dmg((r) => { eachBucket(r, (b, day, m) => { day.m[m] = [1, 2, 3]; }); })],
      ['a token count is NEGATIVE', dmg((r) => { eachBucket(r, (b) => { b[0] = -1; }); })],
      ['a token count is not finite', dmg((r) => { eachBucket(r, (b) => { b[1] = NaN; }); })], // JSON → null
      ['the hour histogram is the OLD day-level array', dmg((r) => { for (const d in r.d) r.d[d].h = new Array(24).fill(1); })],
      ['an hour row is too short', dmg((r) => { for (const d in r.d) if (r.d[d].h) for (const m in r.d[d].h) r.d[d].h[m] = [1, 2]; })],
      ['ids is an array', dmg((r) => { r.ids = []; })],
      ['an ids record is the old 7-tuple', dmg((r) => { for (const k in r.ids) r.ids[k] = r.ids[k].slice(0, 7); })],
      ['an ids owner day is not a string', dmg((r) => { for (const k in r.ids) r.ids[k][7] = 20260401; })],
      ['an ids maximum is negative', dmg((r) => { for (const k in r.ids) r.ids[k][1] = -5; })],
      ['a string field is a number', dmg((r) => { r.cwd = 42; })],
      ['the cost-state verdict is damaged', dmg((r) => { r.cs = { c: 'free', o: 0 }; })],
      ['the stat fingerprint is negative', dmg((r) => { r.s = -1; })],
    ]) {
      fs.writeFileSync(TRANSCRIPT_CACHE_FILE, body);
      _resetCorpusCache();
      // every case is checked, and they are reported TOGETHER: stopping at the first one hides how many
      // of the 24 shapes are trusted, which is the whole question here.
      let why = '';
      try {
        const got = await scanCorpus();
        assert.deepEqual(totals(got), expect, 'undercounted: ' + JSON.stringify(totals(got)));
        assert.deepEqual(shapeOf(got), expectShape, 'the damaged record was ADOPTED instead of refolded');
      } catch (e) { why = e.message; }
      if (why) trusted.push(label + ' → ' + why.split('\n')[0]);
    }
    assert.deepEqual(trusted, [], 'a damaged cache must be a MISS and refold. These were trusted instead:\n  - ' + trusted.join('\n  - ') + '\n');
  });

  // B1 — the owner bucket. A deduped record belongs to the (day, model) bucket its FIRST line opened, for
  // its whole life; the max-wins INCREMENT has to correct that bucket. Booking it against the CURRENT
  // line's day was wrong twice over, and both halves are below. 0 live groups straddle a local day today,
  // which is exactly why neither half could be noticed on today's data.
  //
  // The two timestamps are built through the Date API and converted with toISOString(), so they are one
  // hour apart across a LOCAL midnight in whatever timezone this machine runs in — a hardcoded "…T22:30Z"
  // would only straddle a day in some offsets.
  const L1 = new Date(2026, 4, 10, 23, 30, 0);  // local 2026-05-10 23:30
  const L2 = new Date(2026, 4, 11, 0, 30, 0);   // local 2026-05-11 00:30
  const D1 = dayKey(L1), D2 = dayKey(L2);
  const MDL = 'claude-opus-5';
  const split = (lines) => {
    // first line folded + FLUSHED + the in-memory cache dropped, so the owner day can only come back from
    // disk: it is persisted in rec.ids, which is why CACHE_V had to move to 3.
    F.writeLines(FILE, [lines[0]]);
    return (async () => {
      await scanCorpus();
      assert.equal(await flushCache(), true, 'the cache was not written');
      _resetCorpusCache();
      fs.appendFileSync(FILE, lines[1] + '\n');
      return scanCorpus();
    })();
  };

  it('T26 a duplicate group straddling a LOCAL day books the whole answer in the FIRST line\'s day', async () => {
    assert.notEqual(D1, D2, 'the fixture must straddle a local day');
    const after = await split([
      F.asst({ id: 'msg_split', ts: L1.toISOString(), model: MDL, in: 100, out: 1, cr: 1000 }),
      F.asst({ id: 'msg_split', ts: L2.toISOString(), model: MDL, in: 100, out: 900, cr: 1000 }),
    ]);
    assert.deepEqual(bucketOf(after, D1, MDL), [100, 900, 1000, 0, 0, 0, 1],
      'the +899 increment landed in the NEXT day instead of correcting the day that holds the partial');
    assert.equal(recOf(after).d[D2], undefined, 'a day that only saw a duplicate must not get a bucket of its own');
    assert.deepEqual(hoursOf(after, D1, MDL), Object.assign(new Array(24).fill(0), { [L1.getHours()]: 2000 }),
      'the hour histogram must follow the same owner as the tokens');
    assert.deepEqual(totals(after), groundTruth(FILE));
    // …and the same file folded in ONE pass (no resume, no cache) must give the identical day rows
    _resetCorpusCache(); fs.rmSync(TRANSCRIPT_CACHE_FILE);
    const once = await scanCorpus();
    assert.deepEqual(bucketOf(once, D1, MDL), bucketOf(after, D1, MDL), 'resumed and one-pass folds disagree');
    assert.equal(recOf(once).d[D2], undefined);
  });

  it('T27 …and a field that SHRANK while the total GREW must not make a NEGATIVE day row', async () => {
    // The partial reported all input and no output; the final line reports the output and an input figure
    // of 0. The TOTAL grew, so max-wins takes the final line — and dIn is -1000. Booked against the
    // current line that is a subtraction in a day bucket that never held those tokens: a negative row.
    const after = await split([
      F.asst({ id: 'msg_neg', ts: L1.toISOString(), model: MDL, in: 1000, out: 0 }),
      F.asst({ id: 'msg_neg', ts: L2.toISOString(), model: MDL, in: 0, out: 2000 }),
    ]);
    for (const r of after.recs) for (const d in r.d) for (const m in r.d[d].m) {
      for (const v of r.d[d].m[m]) assert.ok(v >= 0, 'NEGATIVE token count in ' + (d || '(undated)') + '/' + m + ': ' + JSON.stringify(r.d[d].m[m]));
      if (r.d[d].h) for (const hm in r.d[d].h) for (const v of r.d[d].h[hm]) assert.ok(v >= 0, 'negative hour slot in ' + d + '/' + hm);
    }
    assert.deepEqual(bucketOf(after, D1, MDL), [0, 2000, 0, 0, 0, 0, 1], 'the winner\'s usage must replace the partial in ONE bucket');
    assert.equal(recOf(after).d[D2], undefined);
    assert.deepEqual(totals(after), groundTruth(FILE), 'the totals were always right — that is why this needs a per-day assertion');
  });

  it('T29 ONE damaged record distrusts the WHOLE cache file — the records read BEFORE it are refolded too', async () => {
    // A cache whose first record is fine and whose second is damaged must not be served half: the writer is
    // evidently not the one we think it is, and a record that was already adopted would stay a valid HIT
    // under its fresh (size, mtime) for ever. Two files, damage the SECOND, expect BOTH to be refolded.
    const OTHER = F.mainPath(C, PROJ, 'ffffffff-ffff-4fff-8fff-ffffffffffff');
    F.writeLines(OTHER, [F.asst({ id: 'msg_o1', ts: '2026-04-02T09:00:01.000Z', in: 11, out: 7 })]);
    try {
      const cold = await scanCorpus();
      assert.equal(cold.stats.folded, 2, 'the fixture must have two transcripts here');
      assert.equal(await flushCache(), true);
      const raw = JSON.parse(fs.readFileSync(TRANSCRIPT_CACHE_FILE, 'utf8'));
      assert.deepEqual(Object.keys(raw.files).sort(), [FILE, OTHER].sort(), 'both records must be in the cache');
      // the LAST record in iteration order is the damaged one, so the other one is adopted first
      const keys = Object.keys(raw.files);
      raw.files[keys[keys.length - 1]].md = ['not a count map'];
      fs.writeFileSync(TRANSCRIPT_CACHE_FILE, JSON.stringify(raw));
      _resetCorpusCache();
      const got = await scanCorpus();
      assert.equal(got.stats.folded, 2, 'the record read BEFORE the damaged one was adopted instead of refolded');
      for (const r of got.recs) assert.ok(!Array.isArray(r.md), 'a damaged md survived into a served record');
      assert.deepEqual(totals(got), { input: 3011, output: 307, messages: 3 });
    } finally { fs.rmSync(OTHER, { force: true }); }
  });

  it('T28 two CONCURRENT scans share ONE disk-cache load (the flag used to be set before the await)', async () => {
    await scanCorpus();
    assert.equal(await flushCache(), true);
    _resetCorpusCache();
    // The read is made slow so the race is decided, not hoped for: `diskState = 'loaded'` before
    // `await fsp.readFile` let the SECOND caller walk past an EMPTY recCache and refold every file from
    // scratch, whichever finished last winning. lib/corpus calls fsp.readFile as a property of the module
    // object, so patching it here is the same seam the module uses.
    const fsp = require('fs/promises');
    const real = fsp.readFile;
    let reads = 0;
    fsp.readFile = function (p, ...rest) {
      if (p !== TRANSCRIPT_CACHE_FILE) return real.call(fsp, p, ...rest);
      reads++;
      return new Promise((r) => setTimeout(r, 300)).then(() => real.call(fsp, p, ...rest));
    };
    try {
      const [a, b] = await Promise.all([scanCorpus(), scanCorpus()]);
      assert.equal(reads, 1, 'the cache file was read more than once');
      assert.equal(a.stats.folded, 0, 'the first scan ignored its own cache');
      assert.equal(b.stats.folded, 0, 'the second concurrent scan walked past an empty cache and refolded everything');
      assert.deepEqual(totals(b), totals(a), 'two concurrent scans disagreed');
      assert.deepEqual(totals(a), groundTruth(FILE));
    } finally { fsp.readFile = real; }
  });
});

describe('lib/usage — the in-flight guard (a correctness bug, not a perf nicety)', () => {
  const { scanUsage } = require('../lib/usage');
  before(() => { _resetCorpusCache(); try { fs.rmSync(TRANSCRIPT_CACHE_FILE); } catch { /* */ } seed(); });

  // A damaged day KEY cannot be seen through scanCorpus: the tokens are still there, only filed under a
  // name the fold can never write, so every TOTAL stays right. The damage appears one layer up, where the
  // range filter compares day keys as ORDERED STRINGS — the bucket then leaves every window. T23 asserts on
  // totals and is structurally blind to this, which is why it lives here and goes through scanUsage with a
  // range. (Learned the hard way: the first version of this test sat in T23's table, passed, and still
  // passed with the validation removed.)
  it('T30 a day key the fold can never write is a MISS — otherwise the bucket leaves every window', async () => {
    const lo = '2026-01-01', hi = '2026-12-31';
    const base = await scanUsage(lo, hi, 0, {}); await flushCache();
    assert.ok(base.total.input > 0, 'the baseline must actually have tokens inside the window');
    const good = fs.readFileSync(TRANSCRIPT_CACHE_FILE, 'utf8');
    const realDay = Object.keys(JSON.parse(good).files[FILE].d).find((k) => k !== '');
    assert.ok(realDay, 'the fixture must have a dated bucket');
    for (const [label, body] of [
      // substituted in the TEXT: assigning r.d['__proto__'] would hit the prototype setter and lose the
      // bucket for a different reason than the one under test
      ['a day key that is not a date at all', good.split('"' + realDay + '"').join('"lunchtime"')],
      ['a day key that looks like one and is none', good.split('"' + realDay + '"').join('"2026-99-99"')],
      ['an unpadded month, which dayKey never writes', good.split('"' + realDay + '"').join('"2026-4-1"')],
    ]) {
      fs.writeFileSync(TRANSCRIPT_CACHE_FILE, body);
      _resetCorpusCache();
      const got = await scanUsage(lo, hi, 0, {});
      assert.equal(got.total.input, base.total.input, label + ': the damaged record was adopted and the bucket left the window');
      const chartDays = (got.days || []).map((d) => d.date);
      assert.deepEqual(chartDays.filter((d) => !/^\d+-\d{2}-\d{2}$/.test(d)), [], label + ': a key the fold cannot write reached the daily chart (' + chartDays.join(', ') + ')');
    }
    // the owner day of an id is the same hazard one level down: the increment of a duplicate would be
    // booked into a bucket that no window can ever contain
    const o = JSON.parse(good);
    for (const k in o.files[FILE].ids) o.files[FILE].ids[k][7] = 'lunchtime';
    fs.writeFileSync(TRANSCRIPT_CACHE_FILE, JSON.stringify(o));
    _resetCorpusCache();
    const byIds = await scanUsage(lo, hi, 0, {});
    assert.equal(byIds.total.input, base.total.input, 'an id whose owner day is not a day key was trusted');
  });

  it('T24 TWO concurrent scans over a file that just grew count the append EXACTLY once', async () => {
    const first = await scanUsage(null, null, 0, {});
    assert.equal(first.total.input, 3000);
    // the shape of the measured bug: a tail appended while two requests are in flight
    for (let i = 0; i < 10; i++) fs.appendFileSync(FILE, F.asst({ id: 'msg_t' + i, ts: '2026-04-01T10:0' + i + ':00.000Z', in: 110, out: 11 }) + '\n');
    const [a, b] = await Promise.all([scanUsage(null, null, 0, {}), scanUsage(null, null, 0, {})]);
    assert.equal(a.total.input, 4100, 'expected 3000 + 10x110; the old code folded the tail twice (4,400)');
    assert.equal(b.total.input, a.total.input, 'two concurrent responses disagreed with each other');
    assert.equal(a.total.messages, 12);
    // …and it must not be STICKY: the next single scan has to agree, not serve a poisoned aggregate
    const again = await scanUsage(null, null, 0, {});
    assert.equal(again.total.input, 4100, 'the over-count was stored under the fresh (size, mtime) and became a valid hit');
  });
});
