'use strict';
// lib/backups previewBackup() — everything the restore dialog says BEFORE it overwrites anything.
//
// WHY this is its own suite and not a few more cases in test/backups-routes.test.js: that one boots a
// server to prove what RESTORE does to the disk, and this one has to prove the opposite — that the
// preview touches nothing while still reading the same destination. Driving the function directly also
// makes the two cases that are the whole reason the preview exists cheap to state: a backup that changes
// NOTHING (and used to be presented with the same „… wiederherstellen?" as a destructive one), and one
// whose bytes must not be shown as text.
//
// Env BEFORE the require: lib/paths resolves CLAUDE_DIR/BACKUP_DIR at load time (same reason as
// test/backups.test.js:12), and this file runs in its own process under `node --test`.
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');   // für das Wegwerf-Verzeichnis der TOCTOU-Probe am Dateiende
const { makeSandbox } = require('./sandbox');

const SBX = makeSandbox('backups-preview');
Object.assign(process.env, SBX.env);
const BACKUPS = path.join(SBX.claudeDir, 'backups', 'claude-code-ui');
const COMMANDS = path.join(SBX.claudeDir, 'commands');
const PROJECTS = path.join(SBX.claudeDir, 'projects');
const { previewBackup, readDiffSide } = require('../lib/backups');
const { BACKUP_DIFF_MAX_BYTES } = require('../public/js/backups-view');
after(() => SBX.cleanup());

const SID = '0c3f9a21-4d55-4e8a-9b77-1f2e3d4c5b6a';
const encodeProject = (cwd) => String(cwd || '').replace(/[:\\/]/g, '-'); // lib/core.js:405
const isoStamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-'); // lib/core.js:92
const bpath = (n) => path.join(BACKUPS, n);
const put = (name, body) => { fs.writeFileSync(bpath(name), body); return name; };

describe('backups preview — the three outcomes a restore can have', () => {
  before(() => { fs.mkdirSync(BACKUPS, { recursive: true }); });
  beforeEach(() => {
    fs.rmSync(BACKUPS, { recursive: true, force: true });
    fs.rmSync(COMMANDS, { recursive: true, force: true });
    fs.rmSync(path.join(SBX.claudeDir, 'settings.json'), { force: true });
    fs.mkdirSync(BACKUPS, { recursive: true });
  });

  it('settings: the file exists → OVERWRITE, with the real diff and the destination it writes', () => {
    const dest = path.join(SBX.claudeDir, 'settings.json');
    fs.writeFileSync(dest, '{\n  "model": "sonnet"\n}\n');
    const name = put('settings.json.' + isoStamp(1_759_000_000_000) + '.bak', '{\n  "model": "opus"\n}\n');
    return previewBackup(name).then((r) => {
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.dest, dest, 'the path the dialog shows is the path the restore writes');
      assert.equal(r.body.exists, true);
      assert.equal(r.body.target, 'overwrite');
      assert.equal(r.body.content, 'diff');
      assert.equal(r.body.consumes, false, 'settings is a copy — the backup stays in the list afterwards');
      assert.match(r.body.currentText, /sonnet/);
      assert.match(r.body.backupText, /opus/);
      assert.equal(r.body.currentBytes, fs.statSync(dest).size);
    });
  });

  it('settings: a backup identical to the file says so instead of showing an empty diff', async () => {
    // The case the old dialog could not tell from a destructive one: „… wiederherstellen?" either way.
    const body = '{\n  "model": "opus"\n}\n';
    fs.writeFileSync(path.join(SBX.claudeDir, 'settings.json'), body);
    const name = put('settings.json.' + isoStamp(1_759_000_000_001) + '.bak', body);
    const r = await previewBackup(name);
    assert.equal(r.body.content, 'identical');
    assert.equal(r.body.target, 'overwrite', 'it still overwrites — „ändert nichts" is about the CONTENT');
    assert.equal(r.body.currentText, null, 'no texts travel for a verdict that needs none');
    assert.equal(r.body.backupText, null);
  });

  it('cfg: the file is gone → NEW, and the diff is the whole backup as an addition', async () => {
    const name = put('deleted-commands-x.md.1700000000000.bak', '# x\nline two\n');
    const r = await previewBackup(name);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.dest, path.join(COMMANDS, 'x.md'));
    assert.equal(r.body.exists, false);
    assert.equal(r.body.target, 'new');
    assert.equal(r.body.content, 'diff');
    assert.equal(r.body.consumes, true, 'session/cfg restore is an fs.rename — the backup is consumed');
    assert.equal(r.body.currentText, null);
    assert.equal(r.body.currentBytes, null);
    assert.equal(r.body.backupText, '# x\nline two\n');
  });

  it('cfg: the file is BACK → blocked, because the restore answers 409 and changes nothing', async () => {
    // test/backups-routes.test.js:115 pins that 409. A dialog offering „Wiederherstellen" here would be a
    // button that can only fail; the diff still earns its place (it says why you want the download).
    fs.mkdirSync(COMMANDS, { recursive: true });
    fs.writeFileSync(path.join(COMMANDS, 'x.md'), '# live\n');
    const name = put('deleted-commands-x.md.1700000000001.bak', '# backup\n');
    const r = await previewBackup(name);
    assert.equal(r.body.target, 'blocked');
    assert.equal(r.body.content, 'diff');
    assert.equal(r.body.currentText, '# live\n');
  });

  it('session: the destination comes from the cwd INSIDE the transcript, like the restore', async () => {
    const name = put('deleted-' + SID + '-1700000000002.jsonl', JSON.stringify({ type: 'user', cwd: 'C:\\tmp\\proj', message: {} }) + '\n');
    const r = await previewBackup(name);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.dest, path.join(PROJECTS, encodeProject('C:\\tmp\\proj'), SID + '.jsonl'));
    assert.equal(r.body.target, 'new');
  });

  it('session without a cwd is refused with the SAME 400 the restore gives — not a diff of nothing', async () => {
    const name = put('deleted-' + SID + '-1700000000003.jsonl', JSON.stringify({ type: 'user', message: {} }) + '\n');
    const r = await previewBackup(name);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /cwd/, 'the dialog repeats the reason, and the row still offers ⭳ Download');
  });

  it('a download-only kind is refused here too — no preview for a restore that cannot happen', async () => {
    for (const name of [put('notes.txt', 'plain'), put('deleted-memory-MEMORY.md.1700000000000.bak', '# mem')]) {
      const r = await previewBackup(name);
      assert.equal(r.status, 400, name);
      assert.match(r.body.error, /nur heruntergeladen werden/, name);
    }
  });
});

describe('backups preview — what the restore COSTS: the retention of its own safety copy', () => {
  // The dialog said „Das Backup bleibt erhalten (es wird kopiert, nicht verschoben)". The restore then
  // calls backupFile(dest) (server.js:1295), whose prune deletes the oldest `<base>.*.bak` once
  // BACKUP_KEEP = 30 is reached — so afterwards either the restored backup itself or an uninvolved one is
  // gone, and the list reads 30 before and 30 after either way. Here the numbers the dialog is built from;
  // what the disk looks like afterwards is test/settings-routes.test.js.
  const dest = path.join(SBX.claudeDir, 'settings.json');
  const seed = (n) => Array.from({ length: n }, (_, i) => put('settings.json.2000-01-01T00-' + String(i).padStart(2, '0') + '-00-000Z.bak', '{"v":' + i + '}\n'));
  before(() => { fs.mkdirSync(BACKUPS, { recursive: true }); });
  beforeEach(() => {
    fs.rmSync(BACKUPS, { recursive: true, force: true });
    fs.rmSync(COMMANDS, { recursive: true, force: true });
    fs.rmSync(dest, { force: true });
    fs.mkdirSync(BACKUPS, { recursive: true });
  });

  it('at the limit it names the backup that goes — the restored one, or an uninvolved one', async () => {
    const names = seed(30);
    fs.writeFileSync(dest, '{"v":"current"}\n');
    const oldest = await previewBackup(names[0]);
    assert.deepEqual(oldest.body.prunes, [names[0]], 'restoring the oldest deletes exactly the backup this dialog is about');
    const middle = await previewBackup(names[17]);
    assert.deepEqual(middle.body.prunes, [names[0]], 'restoring any other one costs a backup nobody asked about');
    assert.notEqual(middle.body.name, middle.body.prunes[0]);
  });

  it('one version short of the limit, nothing is lost', async () => {
    const names = seed(29);
    fs.writeFileSync(dest, '{"v":"current"}\n');
    assert.deepEqual((await previewBackup(names[0])).body.prunes, []);
  });

  it('a restore that makes no safety copy costs nothing — a NEW file, and the two rename kinds', async () => {
    const names = seed(30);
    // no destination → backupFile answers ENOENT and copies nothing, so there is no prune to disclose
    const fresh = await previewBackup(names[0]);
    assert.equal(fresh.body.target, 'new', 'the premise: settings.json does not exist here');
    assert.deepEqual(fresh.body.prunes, []);
    // …and a cfg restore is an fs.rename that never calls backupFile, however full its own group is
    fs.mkdirSync(COMMANDS, { recursive: true });
    fs.writeFileSync(path.join(COMMANDS, 'x.md'), '# live\n');
    for (let i = 0; i < 30; i++) put('deleted-commands-x.md.17000000000' + String(i).padStart(2, '0') + '.bak', '# b' + i);
    const cfg = await previewBackup('deleted-commands-x.md.1700000000000.bak');
    assert.equal(cfg.body.target, 'blocked');
    assert.deepEqual(cfg.body.prunes, []);
  });
});

describe('backups preview — the two cases where a diff would be a lie', () => {
  before(() => { fs.mkdirSync(BACKUPS, { recursive: true }); });
  beforeEach(() => { fs.rmSync(BACKUPS, { recursive: true, force: true }); fs.rmSync(COMMANDS, { recursive: true, force: true }); fs.mkdirSync(BACKUPS, { recursive: true }); });

  it('bytes that are not UTF-8 are reported as binary, not diffed as U+FFFD', async () => {
    // 0xFC is „ü" in Latin-1 and invalid UTF-8 — the same fixture byte test/backups-routes.test.js:200
    // uses for the download round trip. Read as text it becomes U+FFFD, so a diff would mark that line
    // changed when the restore keeps the byte exactly as it is.
    const name = 'deleted-commands-umlaut.md.1700000000000.bak';
    fs.writeFileSync(bpath(name), Buffer.from([0x23, 0x20, 0xfc, 0x62, 0x65, 0x72, 0x0a]));
    const r = await previewBackup(name);
    assert.equal(r.body.content, 'binary');
    assert.equal(r.body.binarySide, 'backup');
    assert.equal(r.body.backupText, null, 'the verdict said it cannot be shown — then it is not sent either');
    assert.equal(r.body.backupBytes, 7, 'the size is still named, so ⭳ Download is an informed choice');
  });

  it('past the cap it says „too large" with the limit — it does not read the file', async () => {
    const name = 'deleted-commands-big.md.1700000000000.bak';
    fs.writeFileSync(bpath(name), 'x'.repeat(BACKUP_DIFF_MAX_BYTES + 1));
    const r = await previewBackup(name);
    assert.equal(r.body.content, 'too-large');
    assert.equal(r.body.bigSide, 'backup');
    assert.equal(r.body.limit, BACKUP_DIFF_MAX_BYTES);
    assert.equal(r.body.backupText, null);
    assert.equal(r.body.backupBytes, BACKUP_DIFF_MAX_BYTES + 1);
  });
});

describe('backups preview — the refusals in front of it, and that it writes NOTHING', () => {
  before(() => { fs.mkdirSync(BACKUPS, { recursive: true }); });

  it('refuses a traversing name before any path is built, and 404s an unknown one', async () => {
    for (const bad of ['../settings.json', '..\\..\\settings.json', 'a/b', 'a\\b', '..', 'C:/tmp/evil.txt', '']) {
      const r = await previewBackup(bad);
      assert.equal(r.status, 400, JSON.stringify(bad) + ' → ' + r.status);
      assert.equal(r.body.error, 'bad name', JSON.stringify(bad));
    }
    const miss = await previewBackup('deleted-commands-nothere.md.1700000000000.bak');
    assert.equal(miss.status, 404);
    assert.match(miss.body.error, /backup not found/);
  });

  it('is a READ: the backup, the destination and BACKUP_DIR are untouched afterwards', async () => {
    fs.rmSync(BACKUPS, { recursive: true, force: true });
    fs.mkdirSync(BACKUPS, { recursive: true });
    fs.mkdirSync(COMMANDS, { recursive: true });
    const dest = path.join(COMMANDS, 'x.md');
    fs.writeFileSync(dest, '# live\n');
    const name = put('deleted-commands-x.md.1700000000000.bak', '# backup\n');
    const before = fs.readdirSync(BACKUPS).sort();
    await previewBackup(name);
    assert.deepEqual(fs.readdirSync(BACKUPS).sort(), before, 'nothing moved out of or into BACKUP_DIR');
    assert.equal(fs.readFileSync(dest, 'utf8'), '# live\n', 'the live file is exactly as it was');
    assert.equal(fs.readFileSync(bpath(name), 'utf8'), '# backup\n', 'and so is the backup');
  });
});

// Die Race selbst, festgenagelt. CodeQL hat sie als HIGH gemeldet („The file may have changed since it was
// checked"): die erste Fassung machte `stat(pfad)` → Größenprüfung → `readFile(pfad)`, also ZWEI Lookups
// desselben Pfads. Zwischen ihnen kann die Datei ersetzt werden, und dann bindet die Grenze nichts mehr.
// Geprüft wird nicht das Zeitfenster (das wäre flockig), sondern die EIGENSCHAFT, die es schließt: Prüfung
// und Lesen müssen sich auf dasselbe geöffnete Inode beziehen. Dafür wird `fsp.open` so verbogen, dass das
// Handle eine ANDERE, große Datei liefert als der Pfad — hält der Code das Handle, gewinnt die Grenze; liest
// er noch einmal über den Pfad, kommt der kleine Inhalt durch und der Test wird rot.
describe('readDiffSide — die Größengrenze bindet den Lesevorgang, nicht nur den Pfad', () => {
  it('prüft und liest dasselbe Handle (eine Pfad-Neulesung fällt auf)', async () => {
    const fsp2 = require('fs').promises;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-toctou-'));
    const klein = path.join(dir, 'klein.txt');
    const gross = path.join(dir, 'gross.txt');
    fs.writeFileSync(klein, 'winzig\n');
    // deutlich über der Diff-Grenze, damit „zu groß" das erwartete Urteil ist
    fs.writeFileSync(gross, Buffer.alloc(BACKUP_DIFF_MAX_BYTES + 4096, 0x61));
    const echtesOpen = fsp2.open;
    let geoeffnet = 0;
    fsp2.open = async (p, ...rest) => {
      // Jede Anfrage nach der kleinen Datei bekommt das Handle der GROSSEN: ab hier darf nur noch zählen,
      // was am Handle hängt.
      if (String(p) === klein) { geoeffnet++; return echtesOpen.call(fsp2, gross, ...rest); }
      return echtesOpen.call(fsp2, p, ...rest);
    };
    try {
      const r = await readDiffSide(klein);
      assert.equal(geoeffnet, 1, 'der Pfad wurde nicht über ein Handle gelesen — genau das war die Race');
      assert.ok(r, 'nichts zurückgegeben');
      assert.ok(r.bytes > BACKUP_DIFF_MAX_BYTES, 'die Größe kam vom Pfad, nicht vom Handle: ' + r.bytes);
      assert.equal(r.text, null, 'der Inhalt wurde trotz überschrittener Grenze gelesen');
    } finally {
      fsp2.open = echtesOpen;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});
