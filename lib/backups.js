'use strict';
// Backup listing + classification for the System → Backups browser. Extracted from server.js.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { BACKUP_DIR, CLAUDE_DIR, PROJECTS_DIR } = require('./paths');
// BACKUP_KEEP travels with backupFile(): the settings restore calls it (server.js:1295) and its prune is
// part of what the preview has to disclose, so this has to be the SAME number and not a copy of it.
const { encodeProject, firstCwdOf, BACKUP_KEEP } = require('./core');
const { cfgDir, cfgFilePath } = require('./skills');
// same decisions as the browser draws the view from (public/js/backups-view.js) — a second verdict here is
// how a dialog ends up promising something other than what the restore does
const { backupDiffVerdict, backupRetentionPrune, BACKUP_DIFF_MAX_BYTES } = require('../public/js/backups-view');

// The refusal for a backup kind no restore can place. One constant, because restoreTarget() and the
// route's unreachable fallback must not drift apart: test/backups-routes.test.js:165 matches on the text.
const DOWNLOAD_ONLY = 'dieser Backup-Typ kann nur heruntergeladen werden';

// classify a file in BACKUP_DIR into a restorable backup descriptor
function classifyBackup(name) {
  let m;
  if ((m = name.match(/^deleted-([0-9a-f]{8}-[0-9a-f-]{27,})-(\d+)\.jsonl$/i))) return { kind: 'session', id: m[1], restorable: true };
  if ((m = name.match(/^deleted-(agents|commands|output-styles)-(.+)\.md\.[\dTZ.-]+\.bak$/))) return { kind: 'cfg', cfgKind: m[1], target: m[2], restorable: true };
  if ((m = name.match(/^(settings\.json|settings\.local\.json)\.[\dTZ.-]+\.bak$/))) return { kind: 'settings', target: m[1], restorable: true };
  if (/\.bak$/.test(name)) return { kind: 'file', restorable: false };
  if (/\.jsonl$/.test(name)) return { kind: 'session?', restorable: false };
  return { kind: 'other', restorable: false };
}
async function listBackups() {
  let files = [];
  try { files = await fsp.readdir(BACKUP_DIR); } catch { return []; }
  const out = [];
  for (const f of files) {
    try { const st = await fsp.stat(path.join(BACKUP_DIR, f)); if (!st.isFile()) continue; out.push({ name: f, size: st.size, mtime: st.mtimeMs, ...classifyBackup(f) }); } catch { /* */ }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// WHERE a restore would put this backup — the one answer the preview and the restore both read.
// It used to exist only inside POST /api/backups/restore, and a preview with its own copy of these three
// destination rules is the worst kind of diff: one that is shown for a file the restore does not touch.
// Returns {dest, dir, cwd} or {error, status} with the SAME refusals, in the same order, as before.
// Deliberately NOT part of it: the „destination already exists" question. The restore turns that into a
// 409 and the preview into a diff, so the caller owns it.
async function restoreTarget(src, info) {
  if (info.kind === 'session') {
    // derive the project dir from the session's cwd. STREAMED: a backed-up transcript can be 100MB —
    // readFile+split held the whole file (plus a same-size array of lines) in RAM just to read one field
    // a few lines in. readline stops at the first `cwd`.
    const cwd = await firstCwdOf(src);
    if (!cwd) return { error: 'kein cwd im Transkript gefunden — Download nutzen', status: 400 };
    const dir = path.join(PROJECTS_DIR, encodeProject(cwd));
    return { dest: path.join(dir, info.id + '.jsonl'), dir, cwd };
  }
  if (info.kind === 'cfg') {
    const dest = cfgFilePath(info.cfgKind, info.target);
    if (!dest) return { error: 'bad target', status: 400 };
    return { dest, dir: cfgDir(info.cfgKind) };
  }
  if (info.kind === 'settings') return { dest: path.join(CLAUDE_DIR, info.target), dir: CLAUDE_DIR };
  return { error: DOWNLOAD_ONLY, status: 400 };
}

// One side of the comparison. null = there is nothing at that path, which is what makes a restore a NEW
// file rather than an overwrite.
// ONE file handle for the check AND the read — a security fix, not style. The first version did
// `stat(file)` → size check → `readFile(file)`: two separate lookups of the same PATH, so between them the
// file could be replaced and the cap bound nothing. A 10 KB file swapped for a 2 GB one after the stat is
// read whole into memory; swapped for a symlink, the read goes somewhere else entirely. CodeQL named it as a
// HIGH-severity finding („The file may have changed since it was checked") — and neither the build nor two
// adversarial reviews caught it, because they were checking behaviour and honesty, not a race.
// With a handle, `fh.stat()` and `fh.readFile()` describe the SAME open inode, so the cap really binds the
// read.
async function readDiffSide(file) {
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
  } catch (e) {
    // A DIRECTORY cannot be opened for reading (EISDIR on POSIX, EPERM/EACCES on Windows), and calling it
    // „does not exist" would promise a restore that then fails on rename/write. So one `stat` decides which
    // of the two it is — safe here precisely because nothing is READ on this path.
    const code = e && e.code;
    if (code === 'EISDIR' || code === 'EPERM' || code === 'EACCES') {
      try {
        const sd = await fsp.stat(file);
        if (!sd.isFile()) return { bytes: sd.size, binary: true, text: null };
      } catch { /* vanished between the two — treat as absent, like any other miss */ }
    }
    return null;
  }
  try {
    return await readDiffHandle(fh);
  } finally {
    try { await fh.close(); } catch { /* the only state that matters is „closed" */ }
  }
}
async function readDiffHandle(fh) {
  const st = await fh.stat();
  // A directory that slipped past `open` (POSIX allows opening one read-only) is not a thing we can diff,
  // and „does not exist" would promise a restore that then fails. Reported as the one content state that
  // says „will not be shown as text" instead.
  if (!st.isFile()) return { bytes: st.size, binary: true, text: null };
  // Past the cap the bytes are NOT read: the verdict decides size before binary-ness for exactly this
  // reason (public/js/backups-view.js backupDiffVerdict).
  if (st.size > BACKUP_DIFF_MAX_BYTES) return { bytes: st.size, binary: false, text: null };
  const buf = await fh.readFile();
  const text = buf.toString('utf8');
  // NOT a plain utf8 read: 0xFC is „ü" in Latin-1 and invalid UTF-8, so it decodes to U+FFFD
  // (test/backups-routes.test.js:200 keeps a fixture of exactly that byte). A diff built from replacement
  // characters would show a change on every such line that the restore does not make — and hide the ones
  // it does. A NUL byte is the cheap half of the same test.
  const binary = buf.includes(0) || Buffer.compare(Buffer.from(text, 'utf8'), buf) !== 0;
  return { bytes: st.size, binary, text: binary ? null : text };
}

// GET /api/backups/preview — what the confirmation dialog shows before anything is overwritten.
// Same name guard and same 404 as download/restore (an answer here must not be reachable for a name the
// restore would refuse). `{status, body}` rather than a thrown error so the route stays one line.
async function previewBackup(name) {
  const n = String(name == null ? '' : name);
  if (!n || n.includes('..') || n.includes('/') || n.includes('\\')) return { status: 400, body: { error: 'bad name' } };
  const src = path.join(BACKUP_DIR, n);
  if (!src.startsWith(BACKUP_DIR + path.sep) || !fs.existsSync(src)) return { status: 404, body: { error: 'backup not found' } };
  const info = classifyBackup(n);
  const tgt = await restoreTarget(src, info);
  if (tgt.error) return { status: tgt.status, body: { error: tgt.error } };
  const backup = await readDiffSide(src);
  if (!backup) return { status: 404, body: { error: 'backup not found' } }; // vanished between existsSync and stat
  const current = await readDiffSide(tgt.dest);
  const v = backupDiffVerdict({ kind: info.kind, exists: !!current, limit: BACKUP_DIFF_MAX_BYTES, current, backup });
  // What the restore's own safety copy costs. This is the only place that knows BOTH the destination and
  // BACKUP_DIR, and without it the dialog promised „das Backup bleibt erhalten" for a settings restore that
  // deletes one. The readdir is unconditional although only an overwrite can prune: whether to ask at all
  // is part of the decision and belongs to the one function that owns it, and the cost is one directory
  // read per opened dialog. An unreadable dir names nothing — the same best-effort stance as the prune.
  let names = [];
  try { names = await fsp.readdir(BACKUP_DIR); } catch { /* */ }
  const prunes = backupRetentionPrune({ kind: info.kind, exists: !!current, base: path.basename(tgt.dest), names, keep: BACKUP_KEEP });
  return {
    status: 200,
    body: {
      ok: true, name: n, kind: info.kind, dest: tgt.dest, exists: !!current,
      target: v.target, content: v.content, consumes: v.consumes, bigSide: v.bigSide, binarySide: v.binarySide,
      prunes,
      limit: BACKUP_DIFF_MAX_BYTES,
      currentBytes: current ? current.bytes : null, backupBytes: backup.bytes,
      // The texts travel ONLY for a real diff. For 'identical' they would be two copies of the same
      // thing, and for 'binary'/'too-large' sending them would contradict the verdict that said they
      // cannot be shown.
      currentText: v.content === 'diff' && current ? current.text : null,
      backupText: v.content === 'diff' ? backup.text : null,
    },
  };
}

module.exports = { classifyBackup, listBackups, restoreTarget, previewBackup, readDiffSide, DOWNLOAD_ONLY };
