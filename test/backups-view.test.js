'use strict';
// public/js/backups-view.js — the grouping of the backup browser and the verdict its restore dialog is
// built from. Both were new surfaces, and the half that is hard to test here is the half that broke last
// time: the DRAWING. So this file does two different things on purpose.
//
//  1. The pure functions, against names built the way the FOUR WRITERS build them (server.js:611 session,
//     :691 memory, :776 cfg, lib/core.js:93 backupFile) — the same rule test/backups.test.js:26 follows,
//     and for the same reason: a regex tested against the regex's own idea of a name proves nothing.
//  2. A source-text check that views-system.js has a label for EVERY token the module can emit. The
//     tokens are the seam between the tested half and the drawn half, and this repo has already shipped a
//     PR where a one-word rename made the visible half mute while 123 tests stayed green.
//
// No timers, no spawn, no clock assertions — but TZ is written per case (Node applies it to the next
// `new Date`), which is the only way to prove the day boundary is LOCAL without depending on where the
// machine happens to stand.
const { describe, it, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const BV = require('../public/js/backups-view');

// Every case gets a KNOWN zone, set before it runs. The two hemisphere cases below override it for
// themselves; without this pin the day assertions would silently depend on which test ran last and on the
// machine — i.e. on exactly the thing they exist to rule out. The fixture tables are built while this file
// is being evaluated, so the zone is set here too, not only in beforeEach.
const TZ0 = process.env.TZ;
after(() => { if (TZ0 === undefined) delete process.env.TZ; else process.env.TZ = TZ0; });
process.env.TZ = 'Europe/Berlin';
beforeEach(() => { process.env.TZ = 'Europe/Berlin'; });

// the writers' own expressions, so a change there breaks these fixtures too
const SID = '0c3f9a21-4d55-4e8a-9b77-1f2e3d4c5b6a';
const sessionName = (id, ms) => 'deleted-' + id + '-' + ms + '.jsonl';                   // server.js:611
const memoryName = (base, ms) => 'deleted-memory-' + base + '.' + ms + '.bak';           // server.js:691
const cfgName = (kind, base, ms) => 'deleted-' + kind + '-' + base + '.' + ms + '.bak';  // server.js:776
const isoStamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');               // lib/core.js:92
const editName = (base, ms) => base + '.' + isoStamp(ms) + '.bak';                       // lib/core.js:93
// what GET /api/backups hands the browser: listBackups() spreads classifyBackup() over {name,size,mtime}
const { classifyBackup } = require('../lib/backups');
const entry = (name, mtime, size) => Object.assign({ name, size: size == null ? 1 : size, mtime }, classifyBackup(name));

const T = Date.UTC(2026, 8, 24, 10, 0, 0); // a fixed, boring base moment for fixtures

describe('backups-view — the timestamp comes out of the NAME, in all three spellings', () => {
  it('reads the ms of the memory and cfg deletes, and the hyphen-separated one of a session delete', () => {
    assert.deepEqual(BV.backupStampMs(memoryName('MEMORY.md', 1700000000000)), { ms: 1700000000000, from: 'name' });
    assert.deepEqual(BV.backupStampMs(cfgName('commands', 'my.skill.md', 1700000000001)), { ms: 1700000000001, from: 'name' });
    // the uuid in front of the stamp is full of hyphens — a left-to-right parse would take the first one
    assert.deepEqual(BV.backupStampMs(sessionName(SID, 1700000000002)), { ms: 1700000000002, from: 'name' });
  });

  it('reads backupFile()\'s ISO stamp back to the millisecond it was written from', () => {
    // the round trip is the assertion: `replace(/[:.]/g,'-')` is undone field by field, so the three
    // hyphens of the DATE must survive and the four that replaced `:`/`.` must not
    assert.equal(BV.backupStampMs(editName('settings.local.json', T)).ms, T);
    assert.equal(BV.backupStampMs(editName('uiskill-demo.md', T + 123)).ms, T + 123);
    assert.equal(BV.backupStampMs('settings.json.2026-10-02T13-44-55-123Z.bak').ms, Date.parse('2026-10-02T13:44:55.123Z'));
  });

  it('a number too short to be a clock is not read as one', () => {
    // `notes.1.bak` is a hand-made file; read as a timestamp it would be 1970 and sit at the very bottom
    // of the view for good, which is a backup nobody finds again
    assert.equal(BV.backupStampMs('notes.1.bak'), null);
    assert.equal(BV.backupStampMs('notes.txt'), null);
    assert.equal(BV.backupStampMs('settings.json.bak'), null);
  });

  it('a name with NO stamp falls back to mtime and says so', () => {
    // reachable, not hypothetical: classifyBackup's cfg rule accepts `[\dTZ.-]+` where the writer puts
    // Date.now(), so this IS a cfg backup — with nothing to read
    const name = 'deleted-commands-x.md.-.bak';
    assert.equal(classifyBackup(name).kind, 'cfg', 'the premise: the classifier accepts this name');
    assert.equal(BV.backupStampMs(name), null);
    assert.deepEqual(BV.backupStampOf({ name, mtime: 42 }), { ms: 42, from: 'mtime' });
    // …and the name's stamp WINS when there is one, even against a very different mtime: fs.rename keeps
    // the original file's mtime, so for a deleted session the two are days apart (27 of 91 here)
    assert.deepEqual(BV.backupStampOf({ name: sessionName(SID, T), mtime: T - 3 * 86400000 }), { ms: T, from: 'name' });
  });
});

describe('backups-view — the day boundary is LOCAL', () => {
  // Both hemispheres, because „local" has to be wrong in BOTH directions for a UTC slice to be a bug.
  // TZ is set per case and restored in after(): with a UTC-based day key each of these flips to the
  // neighbouring day, which is the whole point of pinning it.
  it('east of UTC: 00:30 Berlin belongs to the day the user calls it, not to the UTC day before', () => {
    process.env.TZ = 'Europe/Berlin';
    const ms = Date.UTC(2026, 0, 15, 23, 30); // = 2026-01-16 00:30 +01:00
    assert.equal(new Date(ms).toISOString().slice(0, 10), '2026-01-15', 'premise: UTC says the 15th');
    assert.equal(BV.backupDayKey(ms), '2026-01-16');
  });

  it('west of UTC: 23:30 Los Angeles belongs to that day, not to the UTC day after', () => {
    process.env.TZ = 'America/Los_Angeles';
    const ms = Date.UTC(2026, 0, 16, 7, 30); // = 2026-01-15 23:30 -08:00
    assert.equal(new Date(ms).toISOString().slice(0, 10), '2026-01-16', 'premise: UTC says the 16th');
    assert.equal(BV.backupDayKey(ms), '2026-01-15');
  });

  it('„heute / gestern" is counted between local midnights, so a DST day still counts as one', () => {
    process.env.TZ = 'Europe/Berlin';
    const now = new Date(2026, 9, 26, 9, 0).getTime();     // the Sunday after the CEST→CET switch
    assert.equal(BV.backupDayOffset('2026-10-26', now), 0);
    assert.equal(BV.backupDayOffset('2026-10-25', now), 1, '25 hours long — still exactly one day ago');
    assert.equal(BV.backupDayOffset('2026-10-24', now), 2);
    assert.equal(BV.backupDayOffset('nonsense', now), null);
  });
});

describe('backups-view — which backups are the same FILE', () => {
  it('takes the file identity from the classification where there is one', () => {
    assert.equal(BV.backupFileOf(entry(sessionName(SID, T), T)).key, 'session:' + SID);
    // a dotted command name must keep both parts — classifyBackup's target already does, this must not
    // undo it by re-parsing the name
    assert.deepEqual(BV.backupFileOf(entry(cfgName('commands', 'my.skill.md', T), T)),
      { key: 'cfg:commands/my.skill', file: 'my.skill.md', collection: 'commands' });
    assert.deepEqual(BV.backupFileOf(entry(editName('settings.local.json', T), T)),
      { key: 'settings:settings.local.json', file: 'settings.local.json', collection: 'settings' });
  });

  it('and from the name where the classifier is silent — memory deletes and every other backupFile product', () => {
    // `deleted-memory-…` is {kind:'file'} (test/backups.test.js:68 pins that) and carries no target
    assert.equal(classifyBackup(memoryName('MEMORY.md', T)).target, undefined, 'the premise');
    assert.deepEqual(BV.backupFileOf(entry(memoryName('MEMORY.md', T), T)),
      { key: 'memory:MEMORY.md', file: 'MEMORY.md', collection: 'memory' }, 'a dotted base is not cut at the first dot');
    assert.deepEqual(BV.backupFileOf(entry(editName('uiskill-demo.md', T), T)),
      { key: 'file:uiskill-demo.md', file: 'uiskill-demo.md', collection: '' });
  });

  it('a deleted collection nobody knows keeps its full name and claims no collection', () => {
    // There is no `skills` collection cfgFilePath would accept, so this can only be hand-made — and
    // splitting it into collection + file would be a guess. `commands-sync-active-sprint-proj-acme-ui`
    // (a real name in this BACKUP_DIR) is why a greedy split guesses wrong.
    assert.deepEqual(BV.backupFileOf(entry('deleted-skills-x.md.1700000000000.bak', T)),
      { key: 'deleted:skills-x.md', file: 'skills-x.md', collection: '' });
  });

  it('what no rule reads is null — the caller must keep it visible, not drop it', () => {
    assert.equal(BV.backupFileOf(entry('notes.txt', T)), null);
    assert.equal(BV.backupFileOf(entry('settings.json.bak', T)), null, 'no stamp → not a backupFile product');
  });
});

describe('backups-view — backupGroups', () => {
  const D1 = Date.UTC(2026, 8, 24, 8, 0);   // 10:00 local
  const D2 = Date.UTC(2026, 8, 25, 8, 0);   // the next local day
  const list = [
    entry(editName('settings.local.json', D1), D1, 100),
    entry(editName('settings.local.json', D1 + 900), D1 + 900, 101),   // same file, same SECOND
    entry(editName('settings.local.json', D2), D2, 102),               // same file, next day
    entry(sessionName(SID, D2 + 5000), D1 - 3 * 86400000, 103),        // mtime 3 days older than the name
    entry(memoryName('MEMORY.md', D1 + 10), D1 + 10, 104),
    entry('notes.txt', D1, 105),                                       // unparseable
  ];
  const g = BV.backupGroups(list);

  it('groups by local day, then by file, and NOTHING is dropped', () => {
    const counted = g.days.reduce((n, d) => n + d.count, 0) + g.unmatched.length;
    assert.equal(g.total, list.length);
    assert.equal(counted, g.total, 'every entry is in exactly one group — a lost backup is one nobody looks for');
    assert.deepEqual(g.days.map((d) => [d.day, d.count]), [['2026-09-25', 2], ['2026-09-24', 3]], 'newest day first');
    assert.deepEqual(g.unmatched.map((i) => i.entry.name), ['notes.txt']);
  });

  it('two backups of the same file in the same second both survive, in a stable order', () => {
    // Same second, different millisecond — which is the only form this can take: the stamp is part of the
    // FILE NAME, so two backups of one file in the same millisecond would be one file on disk (the second
    // copyFile/rename would land on the first). A grouping keyed by file + second loses one of these.
    const day = g.days.find((d) => d.day === '2026-09-24');
    const fg = day.files.find((f) => f.key === 'settings:settings.local.json');
    assert.equal(fg.count, 2, 'neither of the two was overwritten by the other');
    assert.deepEqual(fg.items.map((i) => i.stampMs), [D1 + 900, D1], 'newest first');
  });

  it('an exactly equal timestamp still has a total order — the view must not reshuffle per paint', () => {
    // Reachable in two places, and both are tied by the NAME as the last resort:
    //  · different files in the same millisecond — six session deletes in this BACKUP_DIR share
    //    …-1783677695457 and four siblings, i.e. one bulk delete;
    const bulk = BV.backupGroups([entry(sessionName('aaaaaaaa-0000-4000-8000-000000000001', D1), D1), entry(sessionName('bbbbbbbb-0000-4000-8000-000000000002', D1), D1)]);
    assert.deepEqual(bulk.days[0].files.map((f) => f.file), ['bbbbbbbb-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001']);
    //  · and unparseable names, which have no stamp at all and fall back to the same mtime
    const un = BV.backupGroups([entry('a-notes.txt', D1), entry('b-notes.txt', D1)]);
    assert.deepEqual(un.unmatched.map((i) => i.entry.name), ['b-notes.txt', 'a-notes.txt']);
  });

  it('files the day: the session lands under its NAME\'s day, not under its mtime', () => {
    const day = g.days.find((d) => d.day === '2026-09-25');
    assert.deepEqual(day.files.map((f) => f.key).sort(), ['session:' + SID, 'settings:settings.local.json']);
    const s = day.files.find((f) => f.key === 'session:' + SID);
    assert.equal(s.items[0].stampFrom, 'name');
    assert.equal(s.kind, 'session', 'the restore buttons are drawn off the entry — the kind travels with the group');
  });

  it('does not touch the caller\'s array or its entries', () => {
    const before = JSON.stringify(list);
    BV.backupGroups(list);
    assert.equal(JSON.stringify(list), before, 'the server answer stays the server answer');
  });

  it('an empty inventory is an empty answer, not a crash', () => {
    assert.deepEqual(BV.backupGroups([]), { days: [], unmatched: [], total: 0 });
    assert.deepEqual(BV.backupGroups(null), { days: [], unmatched: [], total: 0 });
  });
});

describe('backups-view — what a restore would DO (backupDiffVerdict)', () => {
  const side = (bytes, text, binary) => ({ bytes, text, binary: !!binary });

  it('three different targets for three kinds — „überschreiben" is only ever true for settings', () => {
    // settings COPIES over the destination (server.js:1285-1300); session and cfg `fs.rename` and are
    // refused with 409 when it exists (test/backups-routes.test.js:101 and :115). So a dialog that says
    // „overwrite" for a session is simply wrong, and a button for it could only fail.
    assert.equal(BV.backupDiffVerdict({ kind: 'settings', exists: true, backup: side(1, 'a'), current: side(1, 'b') }).target, 'overwrite');
    assert.equal(BV.backupDiffVerdict({ kind: 'session', exists: true, backup: side(1, 'a'), current: side(1, 'b') }).target, 'blocked');
    assert.equal(BV.backupDiffVerdict({ kind: 'cfg', exists: true, backup: side(1, 'a'), current: side(1, 'b') }).target, 'blocked');
    for (const kind of ['settings', 'session', 'cfg']) {
      assert.equal(BV.backupDiffVerdict({ kind, exists: false, backup: side(1, 'a') }).target, 'new', kind);
    }
  });

  it('says whether the backup survives the restore', () => {
    assert.equal(BV.backupDiffVerdict({ kind: 'session', exists: false, backup: side(1, 'a') }).consumes, true);
    assert.equal(BV.backupDiffVerdict({ kind: 'cfg', exists: false, backup: side(1, 'a') }).consumes, true);
    assert.equal(BV.backupDiffVerdict({ kind: 'settings', exists: true, backup: side(1, 'a'), current: side(1, 'a') }).consumes, false);
    assert.equal(BV.backupRestoreConsumes('file'), false);
    assert.equal(BV.backupRestoreOverwrites('session'), false);
  });

  it('identical means „renderDiff would draw nothing", not „the sizes match"', () => {
    const v = BV.backupDiffVerdict({ kind: 'settings', exists: true, backup: side(9, '{"a":1}'), current: side(400, '{"a":1}') });
    assert.equal(v.content, 'identical');
    // …and a difference the sizes would hide is still a difference
    assert.equal(BV.backupDiffVerdict({ kind: 'settings', exists: true, backup: side(3, 'ab'), current: side(3, 'ba') }).content, 'diff');
  });

  it('a missing file is a diff against nothing — never an empty box', () => {
    const v = BV.backupDiffVerdict({ kind: 'cfg', exists: false, backup: side(5, '# x\n') });
    assert.equal(v.target, 'new');
    assert.equal(v.content, 'diff', 'the whole backup is an addition — that is the honest rendering of a re-creation');
  });

  it('SIZE is decided before any text comparison, and both reasons name the side', () => {
    // The ordering is the whole point. A side past the cap is NOT read, so it arrives with `text: null` —
    // and two unread sides compared as text are two empty strings, i.e. „dieses Backup ändert nichts" for
    // two files that may have nothing in common. The size question therefore has to be answered first.
    const big = BV.backupDiffVerdict({ kind: 'settings', exists: true, limit: 10, backup: side(11, null, false), current: side(2, 'ab') });
    assert.equal(big.content, 'too-large');
    assert.equal(big.bigSide, 'backup');
    assert.equal(big.binarySide, null);
    const both = BV.backupDiffVerdict({ kind: 'settings', exists: true, limit: 10, backup: side(300, null), current: side(400, null) });
    assert.equal(both.content, 'too-large', 'two unread sides are NEVER reported as identical');
    assert.equal(both.bigSide, 'both');
    assert.equal(BV.backupDiffVerdict({ kind: 'settings', exists: true, limit: 10, backup: side(2, 'ab'), current: side(11) }).bigSide, 'current');
    const bin = BV.backupDiffVerdict({ kind: 'cfg', exists: false, backup: side(7, null, true) });
    assert.equal(bin.content, 'binary');
    assert.equal(bin.binarySide, 'backup');
    assert.equal(BV.backupDiffVerdict({ kind: 'settings', exists: true, backup: side(1, null, true), current: side(1, null, true) }).binarySide, 'both');
  });

  it('a side that does not exist is never the reason for anything', () => {
    // `exists:false` must make `current` irrelevant even when a caller passes one in
    const v = BV.backupDiffVerdict({ kind: 'cfg', exists: false, limit: 10, backup: side(2, 'ab'), current: side(999, null, true) });
    assert.equal(v.content, 'diff');
    assert.equal(v.bigSide, null);
    assert.equal(v.binarySide, null);
  });
});

describe('backups-view — what a restore COSTS: the retention prune (backupRetentionPrune)', () => {
  // The settings restore calls lib/core.js backupFile(dest), which copies the destination into BACKUP_DIR
  // and then keeps only the newest 30 `<base>.*.bak`. So at the limit a restore DELETES a backup, and the
  // dialog's „Das Backup bleibt erhalten (es wird kopiert, nicht verschoben)" was false. The repo has
  // pinned the self-deleting half of it for a long time (test/settings-routes.test.js:277), and on this
  // machine settings.local.json has exactly 30 versions — one click, not a thought experiment.
  const base = 'settings.json';
  const sib = (n) => Array.from({ length: n }, (_, i) => base + '.2000-01-01T00-' + String(i).padStart(2, '0') + '-00-000Z.bak');
  const ask = (p) => BV.backupRetentionPrune(Object.assign({ kind: 'settings', exists: true, base, keep: 30 }, p));

  it('at the limit it names the oldest sibling — the one backupFile() then unlinks', () => {
    assert.deepEqual(ask({ names: sib(30) }), [sib(30)[0]]);
    assert.deepEqual(ask({ names: sib(29) }), [], 'one short of the limit nothing is lost');
    // 30 siblings are already enough because the copy of the CURRENT file is made before the prune runs
    assert.deepEqual(ask({ names: sib(32) }), sib(32).slice(0, 3), 'a dir filled past the limit loses the whole surplus');
  });

  it('counts and sorts exactly what the prune counts and sorts', () => {
    // lib/core.js:97 filters `startsWith(base + '.') && endsWith('.bak')` and sorts plainly. A second rule
    // here would mean the dialog names one file and the restore deletes another.
    const mixed = sib(30).concat([
      'settings.local.json.2000-01-01T00-00-00-000Z.bak', // a DIFFERENT file — not this file's retention
      'deleted-commands-x.md.1700000000000.bak',
      'settings.json.2000-01-01T00-00-00-000Z.txt',       // right prefix, not a .bak
      'notes.txt',
    ]);
    assert.deepEqual(ask({ names: mixed }), [sib(1)[0]]);
    assert.deepEqual(ask({ names: sib(29).concat(['settings.local.json.9999-01-01T00-00-00-000Z.bak']) }), [],
      'another file\'s 30th version does not cost this file anything');
  });

  it('no copy, no prune: only an overwrite can cost a backup', () => {
    const names = sib(30);
    assert.deepEqual(ask({ names, exists: false }), [], 'a missing destination makes backupFile answer ENOENT and copy nothing');
    for (const kind of ['session', 'cfg', 'file', 'other', undefined]) {
      assert.deepEqual(BV.backupRetentionPrune({ kind, exists: true, base, keep: 30, names }), [], String(kind) + ' never calls backupFile');
    }
    assert.deepEqual(ask({ names, keep: 0 }), [], 'without a limit there is nothing to prune');
    assert.deepEqual(ask({ names: null }), [], 'a BACKUP_DIR that could not be read names nothing');
    assert.deepEqual(BV.backupRetentionPrune(), [], 'and no answer at all is not a crash');
  });
});

describe('backups-view — what the dialog may say about the backup itself (backupKeepNote)', () => {
  const NAME = 'settings.json.2000-01-01T00-05-00-000Z.bak';
  const OLD = 'settings.json.1999-01-01T00-00-00-000Z.bak';
  const note = (p) => BV.backupKeepNote(Object.assign({ kind: 'settings', target: 'overwrite', name: NAME, prunes: [] }, p));

  it('says NOTHING in the blocked state — nothing is written, so there is nothing to promise', () => {
    // the rule the move/keep sentence already had to learn once, now stated where it cannot be forgotten
    assert.equal(note({ kind: 'cfg', target: 'blocked' }), null);
    assert.equal(note({ kind: 'session', target: 'blocked' }), null);
    assert.equal(note({ target: 'blocked', prunes: [NAME] }), null, 'a prune cannot happen for a restore that is refused');
  });

  it('a rename is a MOVE, a copy that costs nothing is KEPT', () => {
    assert.equal(note({ kind: 'session', target: 'new' }), 'moved');
    assert.equal(note({ kind: 'cfg', target: 'new' }), 'moved');
    assert.equal(note({}), 'kept');
    assert.equal(note({ target: 'new' }), 'kept');
  });

  it('…and „bleibt erhalten" gives way as soon as the retention takes something', () => {
    assert.equal(note({ prunes: [NAME] }), 'pruned-self', 'restoring the oldest of 30 deletes the very backup the dialog is about');
    assert.equal(note({ prunes: [OLD] }), 'pruned-other', 'restoring any other one costs an uninvolved backup instead');
    assert.equal(note({ prunes: [OLD, NAME] }), 'pruned-self', '„this one goes" outranks „another one goes"');
  });
});

describe('backups-view — the caption over the diff, and which side is which', () => {
  it('under `blocked` the caption does not claim an effect', () => {
    // „Das ändert das Wiederherstellen:" stood two elements below „… wird dann abgelehnt und nichts
    // überschrieben. Nur Download." — two sentences in one box, one of them untrue.
    assert.equal(BV.backupContentCaption({ target: 'blocked', content: 'diff' }), 'diff-blocked');
    assert.equal(BV.backupContentCaption({ target: 'overwrite', content: 'diff' }), 'diff');
    assert.equal(BV.backupContentCaption({ target: 'new', content: 'diff' }), 'diff');
    // the other three say nothing about an effect, so the state leaves them alone
    for (const c of ['identical', 'binary', 'too-large']) assert.equal(BV.backupContentCaption({ target: 'blocked', content: c }), c);
  });

  it('the OLD side is the current file and the NEW side is the backup', () => {
    // renderDiff(oldStr, newStr) (render.js:362) paints the FIRST argument as the removals, and a restore
    // makes the file become the backup. Swapped, a settings backup pulled from „opus" back to „sonnet"
    // would show „sonnet" red and „opus" green — the opposite of the outcome.
    assert.deepEqual(BV.backupDiffSides({ currentText: 'model: opus\n', backupText: 'model: sonnet\n' }),
      { old: 'model: opus\n', new: 'model: sonnet\n' });
    assert.deepEqual(BV.backupDiffSides({ currentText: null, backupText: '# x\n' }),
      { old: '', new: '# x\n' }, 'a re-creation is the whole backup as an ADDITION, never as a deletion');
    assert.deepEqual(BV.backupDiffSides({}), { old: '', new: '' });
  });
});

describe('backups-view — every token it emits has a label in views-system.js', () => {
  // The seam between the tested half and the drawn half. views-system.js is read as TEXT (the same reason
  // test/i18n.test.js and test/routes.test.js do): requiring it would need a DOM, and what has to be
  // proven is not behaviour but COVERAGE — that no token can reach the renderer without a label.
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views-system.js'), 'utf8');
  const mapKeys = (name) => {
    const m = new RegExp('const ' + name + ' = \\{([^}]*)\\}').exec(SRC);
    assert.ok(m, name + ' is gone from views-system.js — the renderer no longer maps this token family');
    return [...m[1].matchAll(/(?:^|,)\s*'?([\w-]+)'?\s*:/g)].map((x) => x[1]);
  };
  const cases = [
    ['BACKUP_DIFF_TARGETS', 'BK_TARGET_KEY', BV.BACKUP_DIFF_TARGETS],
    // BACKUP_CAPTIONS, not BACKUP_DIFF_CONTENTS: the caption is chosen per target × content, so it has one
    // token more than the verdict ('diff-blocked'), and the set is derived from the verdict's own so a new
    // content cannot slip past this check.
    ['BACKUP_CAPTIONS', 'BK_CONTENT_KEY', BV.BACKUP_CAPTIONS],
    ['BACKUP_NOTE_STATES', 'BK_NOTE_KEY', BV.BACKUP_NOTE_STATES],
    ['BACKUP_STAMP_SOURCES', 'BK_STAMP_KEY', BV.BACKUP_STAMP_SOURCES],
  ];
  for (const [tokenSet, mapName, tokens] of cases) {
    it(mapName + ' covers all of ' + tokenSet, () => {
      assert.deepEqual(tokens.slice().sort(), mapKeys(mapName).sort(),
        'the renderer must label exactly the tokens the module can emit — a gap renders an empty dialog, a surplus is a dead key');
    });
  }
  it('BK_SIDE_KEY covers the three sides bigSide/binarySide can name', () => {
    assert.deepEqual(mapKeys('BK_SIDE_KEY').sort(), ['backup', 'both', 'current']);
  });
  it('the sets themselves are complete — produced by the verdict, not written down twice', () => {
    // A token set that drifted away from what backupDiffVerdict returns would make the coverage check
    // above pass while the renderer is still missing a label. So the sets are checked against reality.
    const seen = new Set();
    const s = (bytes, text, binary) => ({ bytes, text, binary: !!binary });
    for (const kind of ['settings', 'session', 'cfg']) {
      for (const exists of [true, false]) {
        for (const bk of [s(1, 'a'), s(1, 'b'), s(5, null, true), s(9e9, null)]) {
          const v = BV.backupDiffVerdict({ kind, exists, limit: 10, backup: bk, current: s(1, 'a') });
          seen.add('t:' + v.target); seen.add('c:' + v.content);
        }
      }
    }
    BV.BACKUP_DIFF_TARGETS.forEach((x) => assert.ok(seen.has('t:' + x), 'no input produces target ' + x));
    BV.BACKUP_DIFF_CONTENTS.forEach((x) => assert.ok(seen.has('c:' + x), 'no input produces content ' + x));
  });
  it('and the two STATE sets are produced by their own functions, over every target × content', () => {
    // The caption and the note are chosen from a pair, so the pair is what has to be swept: a combination
    // nobody labelled is an empty line in the dialog, and a token nothing produces is a dead key.
    const caps = new Set(), notes = new Set();
    for (const target of BV.BACKUP_DIFF_TARGETS) {
      for (const content of BV.BACKUP_DIFF_CONTENTS) {
        const cap = BV.backupContentCaption({ target, content });
        assert.ok(BV.BACKUP_CAPTIONS.includes(cap), target + ' × ' + content + ' → ' + cap + ', which is not in BACKUP_CAPTIONS');
        caps.add(cap);
      }
      for (const kind of ['settings', 'session', 'cfg']) {
        for (const prunes of [[], ['x.bak'], ['me.bak']]) {
          const n = BV.backupKeepNote({ kind, target, name: 'me.bak', prunes });
          assert.ok(n === null || BV.BACKUP_NOTE_STATES.includes(n), target + ' × ' + kind + ' → ' + n);
          if (n) notes.add(n);
        }
      }
    }
    BV.BACKUP_CAPTIONS.forEach((x) => assert.ok(caps.has(x), 'no target × content produces caption ' + x));
    BV.BACKUP_NOTE_STATES.forEach((x) => assert.ok(notes.has(x), 'no state produces note ' + x));
  });
});

// =====================================================================================================
//  The DRAWING in public/js/views-system.js. Everything above is the half that was always easy to test —
//  and the half that broke is this one: three mutations in the renderer left all 71 tests green. Limiting
//  the version loop to `[fg.items[0]]` dropped 29 of the 30 settings.local.json versions; dropping the
//  `backupUnmatchedNode` append hid every name no rule reads; swapping the two renderDiff arguments showed
//  every restore mirrored. The token check above only ever proved that a LABEL exists.
//  views-system.js is a browser script with no exports, so the functions are lifted out of the source BY
//  NAME and run against fake globals — the way test/agent-lanes.test.js:153 and test/ctx.test.js:1887
//  already do for chat-render.js / chat.js. That puts the wiring itself under test instead of a copy of
//  it, and a rename or a reindent fails loudly here instead of silently skipping.
// =====================================================================================================
const SYS_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views-system.js'), 'utf8');
// a single-line `const NAME = …;` (the token→key maps, bkKB) or a whole `function NAME(…) {…}` block
function sysChunk(name) {
  const c = SYS_SRC.match(new RegExp('^const ' + name + ' = .*;$', 'm'));
  if (c) return c[0];
  const f = SYS_SRC.match(new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
  assert.ok(f, name + ' not found in public/js/views-system.js — renamed or reindented?');
  return f[0];
}
// `names` are pulled in in order and the LAST one is handed back; everything the chunk references has to
// arrive through `env`, so a new dependency in the renderer shows up here as a ReferenceError rather than
// as a quietly skipped test.
function loadSys(names, env) {
  const keys = Object.keys(env);
  return new Function(...keys, names.map(sysChunk).join('\n') + '\nreturn ' + names[names.length - 1] + ';')(...keys.map((k) => env[k]));
}
// A DOM stub that does exactly what these functions ask of a node and nothing more.
const el = (tag, cls, txt) => ({ tag, cls: cls || '', textContent: txt == null ? '' : String(txt), kids: [], appendChild(n) { this.kids.push(n); return n; } });
const texts = (n) => [n.textContent].concat((n.kids || []).flatMap(texts)).filter(Boolean);

describe('views-system.js — the view attaches EVERY version, not just the first', () => {
  const rows = [];
  const fileNode = loadSys(['backupFileNode'], {
    el,
    t: (k) => k,
    backupCollLabel: (c) => (c ? 'coll:' + c : ''),
    bkCountChip: (n) => el('span', 'bk-count', String(n)),
    bkFold: (cls, head, open) => { const d = el('details', cls); d.open = !!open; head.forEach((h) => d.appendChild(h)); return d; },
    bkExact: (ms) => 'exact:' + ms,
    backupItemNode: (it, label, coll) => { rows.push({ name: it.entry.name, label, coll }); return el('div', 'backup-item', label); },
  });

  it('a file with 30 versions draws 30 rows', () => {
    const d0 = Date.UTC(2026, 8, 24, 8, 0);
    const list = Array.from({ length: 30 }, (_, i) => entry(editName('settings.local.json', d0 + i * 1000), d0 + i * 1000));
    const fg = BV.backupGroups(list).days[0].files[0];
    assert.equal(fg.count, 30, 'premise: the grouping itself found all 30');
    rows.length = 0;
    fileNode(fg);
    assert.equal(rows.length, 30, 'one row per version — 29 of them missing is what used to stay green');
    assert.deepEqual(rows.map((r) => r.name).sort(), list.map((e) => e.name).sort(), 'and they are THOSE 30, not the first one 30 times');
  });

  it('a single version stays a plain row labelled with the file name', () => {
    rows.length = 0;
    const node = fileNode(BV.backupGroups([entry(editName('uiskill-demo.md', T), T)]).days[0].files[0]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, 'uiskill-demo.md', 'wrapping one item in a collapsible would hide it behind a click for nothing');
    assert.equal(node.tag, 'div', 'the row itself, not a <details> around it');
  });
});

describe('views-system.js — loadBackups draws every group, „Nicht zugeordnet" included', () => {
  let LIST = [];
  const drawn = [];
  const boxEl = el('div'), countEl = el('span');
  const load = loadSys(['loadBackups'], {
    $: (sel) => (sel === '#backupCount' ? countEl : boxEl),
    t: (k) => k,
    api: async () => ({ backups: LIST }),
    backupGroups: BV.backupGroups,
    BK_OPEN: null,
    backupDayNode: (d) => { drawn.push('day:' + d.day + ':' + d.count); return el('details'); },
    backupUnmatchedNode: (items) => { drawn.push('unmatched:' + items.length); return el('details'); },
    errorCard: (box, msg) => { drawn.push('error:' + msg); },
  });

  it('attaches one node per day AND the unassigned group — the count stays the SERVER\'s number', async () => {
    const d1 = Date.UTC(2026, 8, 24, 8, 0), d2 = Date.UTC(2026, 8, 25, 8, 0);
    LIST = [
      entry(editName('settings.local.json', d1), d1),
      entry(editName('settings.local.json', d1 + 1000), d1 + 1000),
      entry(memoryName('MEMORY.md', d2), d2),
      entry('notes.txt', d1),      // no rule reads this one
      entry('settings.json.bak', d1),
    ];
    drawn.length = 0;
    await load();
    assert.deepEqual(drawn, ['day:2026-09-25:1', 'day:2026-09-24:2', 'unmatched:2'],
      'a group that is never appended is a backup its owner stops looking for');
    assert.equal(countEl.textContent, '· 5views-system.eintraege', 'the heading counts what the server sent, not what got drawn');
  });

  it('an empty inventory says so instead of drawing an empty page', async () => {
    LIST = [];
    drawn.length = 0;
    await load();
    assert.deepEqual(drawn, []);
    assert.match(boxEl.innerHTML, /keineBackups/);
  });
});

describe('views-system.js — what the restore dialog actually puts on screen', () => {
  // `t` is the identity here on purpose: what has to be proven is WHICH KEY the dialog picks for a state,
  // not how it reads. That the keys exist in both languages is test/i18n.test.js's job.
  const NAME = 'settings.json.2000-01-01T00-05-00-000Z.bak';
  const OLD = 'settings.json.1999-01-01T00-00-00-000Z.bak';
  const diffCalls = [];
  const previewBody = loadSys(['BK_TARGET_KEY', 'BK_CONTENT_KEY', 'BK_NOTE_KEY', 'BK_SIDE_KEY', 'bkKB', 'backupPreviewBody'], {
    el,
    t: (k) => k,
    renderDiff: (oldStr, newStr, lang) => { diffCalls.push({ old: oldStr, new: newStr, lang }); return el('div', 'diff'); },
    extLang: (p) => 'lang:' + p,
    capDiffHeight: (d) => d,
    backupKeepNote: BV.backupKeepNote,
    backupContentCaption: BV.backupContentCaption,
    backupDiffSides: BV.backupDiffSides,
  });
  const pv = (p) => Object.assign({
    kind: 'settings', target: 'overwrite', content: 'identical', name: NAME,
    dest: 'C:/u/.claude/settings.json', exists: true, currentBytes: 120, backupBytes: 118, prunes: [],
  }, p);

  it('„Das Backup bleibt erhalten" only where the restore can keep it', () => {
    assert.ok(texts(previewBody(pv({}))).includes('views-system.backupBleibtErhalten'));
    const self = texts(previewBody(pv({ prunes: [NAME] })));
    assert.ok(!self.includes('views-system.backupBleibtErhalten'), 'the promise is GONE, not merely qualified somewhere else');
    assert.ok(self.some((s) => s.startsWith('views-system.backupPruneDieses') && s.includes(NAME)),
      'it says instead that the retention removes THIS backup, and names it: ' + JSON.stringify(self));
  });

  it('…and an uninvolved backup that disappears is named too', () => {
    // the list goes from 30 to 30, so a reader comparing numbers would see nothing at all
    const other = texts(previewBody(pv({ prunes: [OLD] })));
    assert.ok(other.some((s) => s.startsWith('views-system.backupPruneAnderes') && s.includes(OLD)), JSON.stringify(other));
    assert.ok(!other.includes('views-system.backupBleibtErhalten'));
    const two = texts(previewBody(pv({ prunes: [OLD, NAME] })));
    assert.ok(two.some((s) => s.includes(OLD) && s.includes(NAME)), 'both casualties, so the second one cannot be swallowed by the sentence');
  });

  it('a session/cfg restore still says the backup is MOVED', () => {
    assert.ok(texts(previewBody(pv({ kind: 'session', target: 'new', exists: false }))).includes('views-system.backupWirdVerschoben'));
  });

  it('a blocked restore claims neither a move nor an effect', () => {
    const got = texts(previewBody(pv({
      kind: 'cfg', target: 'blocked', content: 'diff', name: 'deleted-commands-x.md.1700000000000.bak',
      dest: 'C:/u/.claude/commands/x.md', currentText: '# live\n', backupText: '# backup\n',
    })));
    assert.ok(got.includes('views-system.backupZielBlockiert'), 'the state sentence itself still stands');
    assert.ok(!got.includes('views-system.backupWirdVerschoben'), 'nothing is moved — the restore answers 409');
    assert.ok(!got.includes('views-system.backupBleibtErhalten'));
    assert.ok(got.includes('views-system.backupInhaltDiffBlockiert'), '„Das ändert das Wiederherstellen" claims an effect there is none of');
    assert.ok(!got.includes('views-system.backupInhaltDiff'), JSON.stringify(got));
  });

  it('the diff is drawn with the CURRENT file as the old side and the BACKUP as the new one', () => {
    diffCalls.length = 0;
    previewBody(pv({ content: 'diff', currentText: '{"model":"opus"}\n', backupText: '{"model":"sonnet"}\n' }));
    assert.deepEqual(diffCalls, [{ old: '{"model":"opus"}\n', new: '{"model":"sonnet"}\n', lang: 'lang:C:/u/.claude/settings.json' }],
      'swapped, pulling a settings backup from „opus" back to „sonnet" would paint „sonnet" red and „opus" green');
  });

  it('and no diff at all where the verdict said one would be a lie', () => {
    diffCalls.length = 0;
    for (const content of ['identical', 'binary', 'too-large']) previewBody(pv({ content, limit: 256 * 1024 }));
    assert.deepEqual(diffCalls, []);
  });
});
