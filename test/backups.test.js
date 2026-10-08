'use strict';
// lib/backups — the classifier that decides whether the System → Backups browser offers a RESTORE
// button, and the listing it builds that browser from. Both were untested, and the classifier is the
// only thing standing between "this file can be put back where it came from" and a rename into the
// wrong place: it derives kind/id/target from the file NAME alone, while three different writers in
// server.js invent those names independently (session delete :585, memory delete :665, cfg delete :750)
// and lib/core backupFile() invents a fourth shape for settings. Nothing asserted that the two sides
// still agree, so a writer could change its name format and every backup it produces would silently
// become `{kind:'file', restorable:false}` — download-only, with no error anywhere.
// So the fixtures below are built the way the WRITERS build them, not the way the regexes read.
//
// Env BEFORE the require: lib/paths resolves BACKUP_DIR at load time (same reason as
// engine-policy.test.js:17-18), and this file runs in its own process under `node --test`.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeSandbox } = require('./sandbox');

const SBX = makeSandbox('backups');
Object.assign(process.env, SBX.env);
const BACKUP_DIR = path.join(SBX.claudeDir, 'backups', 'claude-code-ui');
const { classifyBackup, listBackups } = require('../lib/backups');
after(() => SBX.cleanup());

// the exact expressions the writers use, so a change there breaks these names too
const SESSION_ID = '0c3f9a21-4d55-4e8a-9b77-1f2e3d4c5b6a';
const sessionName = (id, ms) => 'deleted-' + id + '-' + ms + '.jsonl';                      // server.js:585
const memoryName = (base, ms) => 'deleted-memory-' + base + '.' + ms + '.bak';              // server.js:665
const cfgName = (kind, base, ms) => 'deleted-' + kind + '-' + base + '.' + ms + '.bak';     // server.js:750
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');                         // lib/core backupFile
const settingsName = (base) => base + '.' + stamp() + '.bak';

describe('lib/backups — classifyBackup against the names its writers actually produce', () => {
  it('a deleted session is restorable and yields its session id', () => {
    const c = classifyBackup(sessionName(SESSION_ID, Date.now()));
    assert.deepEqual(c, { kind: 'session', id: SESSION_ID, restorable: true });
  });

  it('a deleted agents/commands/output-styles file is a restorable cfg backup, target without .md', () => {
    for (const kind of ['agents', 'commands', 'output-styles']) {
      const c = classifyBackup(cfgName(kind, 'foo.md', 1759000000000));
      assert.deepEqual(c, { kind: 'cfg', cfgKind: kind, target: 'foo', restorable: true }, kind);
    }
    // a dotted name must not be truncated at the first dot — `.+` is greedy, the target keeps both parts
    assert.deepEqual(classifyBackup(cfgName('commands', 'my.skill.md', 1759000000000)),
      { kind: 'cfg', cfgKind: 'commands', target: 'my.skill', restorable: true });
  });

  it('the cfg kind set is CLOSED — an unknown collection is download-only, never silently restorable', () => {
    // There is no `plugins` collection under ~/.claude that cfgFilePath would accept, so a restore
    // would have nowhere to put this. It must fall through to {kind:'file'}, not grow a new branch.
    assert.deepEqual(classifyBackup('deleted-plugins-x.md.1759000000000.bak'), { kind: 'file', restorable: false });
    assert.deepEqual(classifyBackup('deleted-skills-x.md.1759000000000.bak'), { kind: 'file', restorable: false });
  });

  it('settings.json / settings.local.json backups are restorable, an unstamped .bak is not', () => {
    for (const base of ['settings.json', 'settings.local.json']) {
      const c = classifyBackup(settingsName(base));
      assert.deepEqual(c, { kind: 'settings', target: base, restorable: true }, base);
    }
    // no timestamp between name and .bak → not a backupFile() product, so not a settings restore
    assert.deepEqual(classifyBackup('settings.json.bak'), { kind: 'file', restorable: false });
    // …and a look-alike target is not accepted either: the restore writes CLAUDE_DIR/<target>
    assert.deepEqual(classifyBackup('settings.other.json.' + stamp() + '.bak'), { kind: 'file', restorable: false });
  });

  it('a deleted MEMORY file is download-only — the asymmetry is a decision, not an accident', () => {
    // server.js:665 names memory backups `deleted-memory-<base>.<ms>.bak`, and `memory` is not one of
    // the three cfg collections — so the UI can hand the file back but never rename it into place.
    // Pinned on purpose: if this is ever meant to be restorable it needs its own branch AND a
    // destination rule, not a widened cfg regex.
    const c = classifyBackup(memoryName('MEMORY.md', Date.now()));
    assert.deepEqual(c, { kind: 'file', restorable: false });
  });

  it('the two fallbacks stay non-restorable', () => {
    assert.deepEqual(classifyBackup('x.jsonl'), { kind: 'session?', restorable: false });
    assert.deepEqual(classifyBackup('notes.txt'), { kind: 'other', restorable: false });
    // a transcript-looking name whose id is not a uuid is a `session?`, not a session
    assert.deepEqual(classifyBackup('deleted-nope-123.jsonl'), { kind: 'session?', restorable: false });
  });
});

describe('lib/backups — listBackups', () => {
  before(() => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    // write with EXPLICIT, increasing mtimes: the sort is by mtime, and three files created in the
    // same millisecond would make the order a coin flip
    const files = [
      ['notes.txt', 'plain', 1_700_000_000_000],
      [sessionName(SESSION_ID, 1_700_000_100_000), '{"cwd":"C:\\\\tmp"}\n', 1_700_000_100_000],
      [cfgName('commands', 'foo.md', 1_700_000_200_000), '# foo', 1_700_000_200_000],
    ];
    for (const [name, body, mtime] of files) {
      const f = path.join(BACKUP_DIR, name);
      fs.writeFileSync(f, body);
      fs.utimesSync(f, mtime / 1000, mtime / 1000);
    }
    fs.mkdirSync(path.join(BACKUP_DIR, 'a-subdir'), { recursive: true });
  });

  it('lists newest first, carries name/size/mtime + the classification, and skips directories', async () => {
    const list = await listBackups();
    assert.deepEqual(list.map((b) => b.name), [
      cfgName('commands', 'foo.md', 1_700_000_200_000),
      sessionName(SESSION_ID, 1_700_000_100_000),
      'notes.txt',
    ], 'newest mtime first');
    assert.ok(!list.some((b) => b.name === 'a-subdir'), 'a directory in BACKUP_DIR is not a backup');
    const cfg = list[0];
    assert.equal(cfg.kind, 'cfg');
    assert.equal(cfg.restorable, true);
    assert.equal(cfg.size, 5);
    assert.equal(typeof cfg.mtime, 'number');
    assert.equal(list[2].kind, 'other', 'the classification travels with every entry, not just the restorable ones');
  });

  it('answers [] for a BACKUP_DIR that does not exist instead of throwing', async () => {
    // readdir throws ENOENT on a fresh machine (nothing was ever deleted yet) — the System view must
    // render an empty list, not a 500.
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
    assert.deepEqual(await listBackups(), []);
  });
});
