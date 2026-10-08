'use strict';
// The DESTRUCTIVE half of the backup browser. POST /api/backups/restore has three kinds, and only one
// of them was tested: `settings` (test/settings-routes.test.js:253-305) COPIES the bytes. The other two
// `fs.rename` — the backup is CONSUMED, so a wrong destination does not just produce a bad file, it
// loses the only copy. Neither kind had a test, nor did the refusals that stand in front of them: the
// `..`/`/`/`\` name guard (server.js:1201), the 404, the "download only" 400, and GET
// /api/backups/download in its entirety. GET /api/backups/preview joined them later (PR-14) and is here
// for one assertion only — that it answers for the SAME destination the restore writes.
// Every assertion here is about the FILE SYSTEM, not about a status code alone: what moved, what did
// not, and that nothing outside the intended target was touched. test/routes.test.js pins the route
// KEY; a key is not behaviour.
// Boots one throwaway server in the shared sandbox (test/sandbox.js), so CLAUDE_DIR is a temp tree.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { makeSandbox } = require('./sandbox');

const ROOT = path.join(__dirname, '..');
const SESSION_ID = '0c3f9a21-4d55-4e8a-9b77-1f2e3d4c5b6a';
const encodeProject = (cwd) => String(cwd || '').replace(/[:\\/]/g, '-'); // lib/core.js:405

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
// Buffer-collecting on purpose: the download route must hand back BYTES, and a utf8 round trip here
// would turn the 0xFC fixture into U+FFFD inside the test and hide exactly the bug it looks for.
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const h = data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {};
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, buf, text: buf.toString('utf8'), json, headers: res.headers });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function waitUp(port, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if ((await req(port, 'GET', '/api/state')).status === 200) return; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('server did not come up on :' + port);
}

describe('backup restore + download — what actually happens on disk (sandboxed CLAUDE_DIR)', () => {
  let S, sbx, BACKUPS, PROJECTS, COMMANDS;
  const bpath = (n) => path.join(BACKUPS, n);
  const names = () => (fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).sort() : []);
  const restore = (name) => req(S.port, 'POST', '/api/backups/restore', { name });

  before(async () => {
    sbx = makeSandbox('backups-routes', { fakeCli: true });
    BACKUPS = path.join(sbx.claudeDir, 'backups', 'claude-code-ui');
    PROJECTS = path.join(sbx.claudeDir, 'projects');
    COMMANDS = path.join(sbx.claudeDir, 'commands');
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT, env: { ...process.env, ...sbx.env, CLAUDE_UI_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitUp(port);
    S = { port, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }) };
  });
  after(async () => { if (S) await S.stop(); if (sbx) sbx.cleanup(); });
  beforeEach(() => {
    fs.rmSync(BACKUPS, { recursive: true, force: true });
    fs.rmSync(COMMANDS, { recursive: true, force: true });
    fs.mkdirSync(BACKUPS, { recursive: true });
  });

  // ---------------------------------------------------------------- kind: session (an fs.rename)
  it('a session backup with a cwd lands in its project dir and the backup is GONE (rename, not copy)', async () => {
    const name = 'deleted-' + SESSION_ID + '-1700000000000.jsonl';
    const line = JSON.stringify({ type: 'user', cwd: 'C:\\tmp\\proj', message: {} }) + '\n';
    fs.writeFileSync(bpath(name), line);
    const r = await restore(name);
    assert.equal(r.status, 200, r.text);
    const dest = path.join(PROJECTS, encodeProject('C:\\tmp\\proj'), SESSION_ID + '.jsonl');
    assert.equal(r.json.restoredTo, dest);
    assert.equal(fs.readFileSync(dest, 'utf8'), line, 'the transcript arrived byte for byte');
    assert.ok(!fs.existsSync(bpath(name)), 'a rename CONSUMES the backup — a leftover would mean two copies drifting apart');
    assert.deepEqual(names(), [], 'and nothing else was created in BACKUP_DIR');
  });

  it('a session backup with no cwd anywhere is refused — an unplaceable transcript is not destroyed', async () => {
    const name = 'deleted-' + SESSION_ID + '-1700000000001.jsonl';
    fs.writeFileSync(bpath(name), JSON.stringify({ type: 'user', message: {} }) + '\n');
    const r = await restore(name);
    assert.equal(r.status, 400);
    assert.match(r.json.error, /cwd/, 'the message has to say WHY, the UI offers "Download nutzen" next to it');
    assert.ok(fs.existsSync(bpath(name)), 'the only copy is still there');
  });

  it('a session whose destination already exists is refused with 409 and nothing is overwritten', async () => {
    const name = 'deleted-' + SESSION_ID + '-1700000000002.jsonl';
    fs.writeFileSync(bpath(name), JSON.stringify({ cwd: 'C:\\tmp\\proj' }) + '\n');
    const destDir = path.join(PROJECTS, encodeProject('C:\\tmp\\proj'));
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, SESSION_ID + '.jsonl');
    fs.writeFileSync(dest, 'LIVE TRANSCRIPT\n');
    const r = await restore(name);
    assert.equal(r.status, 409, r.text);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'LIVE TRANSCRIPT\n', 'a live transcript is never silently replaced');
    assert.ok(fs.existsSync(bpath(name)), 'and the backup survives the refusal');
  });

  // ---------------------------------------------------------------- kind: cfg (an fs.rename too)
  it('a deleted command comes back as ~/.claude/commands/<name>.md, a second restore onto it is 409', async () => {
    const mk = (ms) => { const n = 'deleted-commands-x.md.' + ms + '.bak'; fs.writeFileSync(bpath(n), '# x ' + ms); return n; };
    const first = mk(1700000000000), second = mk(1700000000001);
    const r1 = await restore(first);
    assert.equal(r1.status, 200, r1.text);
    const dest = path.join(COMMANDS, 'x.md');
    assert.equal(r1.json.restoredTo, dest);
    assert.equal(fs.readFileSync(dest, 'utf8'), '# x 1700000000000');
    assert.ok(!fs.existsSync(bpath(first)), 'consumed');
    const r2 = await restore(second);
    assert.equal(r2.status, 409, r2.text);
    assert.equal(fs.readFileSync(dest, 'utf8'), '# x 1700000000000', 'the restored file was not replaced by the older backup');
    assert.ok(fs.existsSync(bpath(second)), 'and that backup is still available for download');
  });

  // ------------------------------------------- GET /api/backups/preview, wired to the SAME destination
  // The dialog's whole value is that the path it shows is the path that gets written. Both routes read it
  // from lib/backups restoreTarget(), and this is the assertion that keeps them on it: preview, then
  // restore, then compare. A preview of a file the restore does not touch would invite the reader to call
  // a destructive backup harmless. (The content verdicts themselves are in test/backups-preview.test.js —
  // they need no server.)
  it('the preview names the path the restore then writes, and carries the same name guards', async () => {
    const name = 'deleted-commands-x.md.1700000000000.bak';
    fs.writeFileSync(bpath(name), '# x\n');
    const pv = await req(S.port, 'GET', '/api/backups/preview?name=' + encodeURIComponent(name));
    assert.equal(pv.status, 200, pv.text);
    assert.equal(pv.json.target, 'new', 'nothing lives at the destination yet');
    assert.equal(pv.json.content, 'diff');
    assert.equal(pv.json.backupText, '# x\n');
    assert.ok(fs.existsSync(bpath(name)), 'the preview is a READ — the backup is still restorable after it');
    const r = await restore(name);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.restoredTo, pv.json.dest, 'ONE destination: a diff shown for another file is worse than no diff');
    assert.equal(fs.readFileSync(pv.json.dest, 'utf8'), '# x\n');
    for (const bad of ['../settings.json', 'a/b', 'a\\b', '..']) {
      const br = await req(S.port, 'GET', '/api/backups/preview?name=' + encodeURIComponent(bad));
      assert.equal(br.status, 400, JSON.stringify(bad) + ' → ' + br.status);
      assert.equal(br.json.error, 'bad name', JSON.stringify(bad));
    }
  });

  // ---------------------------------------------------------------- the refusals
  it('a non-restorable kind is refused with "nur heruntergeladen werden" and nothing moves', async () => {
    const plain = 'notes.txt';
    const mem = 'deleted-memory-MEMORY.md.1700000000000.bak'; // server.js:665 — download-only by design
    fs.writeFileSync(bpath(plain), 'plain');
    fs.writeFileSync(bpath(mem), '# mem');
    for (const n of [plain, mem]) {
      const r = await restore(n);
      assert.equal(r.status, 400, n + ': ' + r.text);
      assert.match(r.json.error, /nur heruntergeladen werden/, n);
    }
    assert.deepEqual(names(), [mem, plain].sort(), 'both files are exactly where they were');
  });

  it('a name with .. or a separator is refused BEFORE any path is built — nothing in or out of BACKUP_DIR changes', async () => {
    // Sentinels on both sides of the fence. `../settings.json` resolves to CLAUDE_DIR/backups and
    // `../../settings.json` to CLAUDE_DIR itself, which is where the settings restore legitimately
    // writes — so if the guard ever let a traversal through, one of these two would move.
    const outside = [path.join(sbx.claudeDir, 'backups', 'settings.json'), path.join(sbx.claudeDir, 'settings.json')];
    outside.forEach((f) => fs.writeFileSync(f, 'SENTINEL ' + f));
    const inside = 'settings.json.2026-10-02T00-00-00-000Z.bak';
    fs.writeFileSync(bpath(inside), '{"restored":true}');
    const before = names();
    for (const bad of ['../settings.json', '..\\..\\settings.json', 'a/b', 'a\\b', '..', 'C:/tmp/evil.txt', './' + inside]) {
      const r = await restore(bad);
      assert.equal(r.status, 400, JSON.stringify(bad) + ' must be refused, got ' + r.status + ' ' + r.text);
      assert.equal(r.json.error, 'bad name', JSON.stringify(bad));
    }
    outside.forEach((f) => assert.equal(fs.readFileSync(f, 'utf8'), 'SENTINEL ' + f, f + ' was written to'));
    assert.deepEqual(names(), before, 'BACKUP_DIR is untouched too');
  });

  it('an unknown name is 404, not a 500 and not a silent ok', async () => {
    const r = await restore('deleted-commands-nothere.md.1700000000000.bak');
    assert.equal(r.status, 404, r.text);
    assert.match(r.json.error, /backup not found/);
  });

  // ---------------------------------------------------------------- GET /api/backups/download
  it('download hands back the exact bytes, named, as a download — and refuses the same names', async () => {
    // 0xFC is „ü" in Latin-1 and not valid UTF-8: read as text it becomes U+FFFD (EF BF BD) and the
    // downloaded file would be a corrupted copy of the user's settings. Same fixture byte as
    // settings-routes.test.js uses for the restore round trip.
    const name = 'deleted-commands-umlaut.md.1700000000000.bak';
    const bytes = Buffer.from([0x23, 0x20, 0xfc, 0x62, 0x65, 0x72, 0x0a]); // "# über\n" in Latin-1
    fs.writeFileSync(bpath(name), bytes);
    const r = await req(S.port, 'GET', '/api/backups/download?name=' + encodeURIComponent(name));
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'application/octet-stream');
    assert.match(String(r.headers['content-disposition']), /attachment; filename="deleted-commands-umlaut\.md\.1700000000000\.bak"/);
    assert.equal(Buffer.compare(r.buf, bytes), 0, 'byte-identical — not a utf8 round trip');
    assert.ok(fs.existsSync(bpath(name)), 'download is a READ: the backup stays');
    for (const bad of ['../settings.json', 'a/b', 'a\\b']) {
      const br = await req(S.port, 'GET', '/api/backups/download?name=' + encodeURIComponent(bad));
      assert.equal(br.status, 400, JSON.stringify(bad) + ' → ' + br.status);
    }
    const missing = await req(S.port, 'GET', '/api/backups/download?name=nothere.bak');
    assert.equal(missing.status, 404);
  });

  // ---------------------------------------------------------------- GET /api/backups
  it('the inventory lists every file with its classification, newest first, and names its dir', async () => {
    const entries = [
      ['notes.txt', 1_700_000_000_000],
      ['deleted-' + SESSION_ID + '-1700000100000.jsonl', 1_700_000_100_000],
      ['deleted-commands-foo.md.1700000200000.bak', 1_700_000_200_000],
    ];
    for (const [n, mtime] of entries) { fs.writeFileSync(bpath(n), 'x'); fs.utimesSync(bpath(n), mtime / 1000, mtime / 1000); }
    const r = await req(S.port, 'GET', '/api/backups');
    assert.equal(r.status, 200);
    assert.equal(r.json.dir, BACKUPS, 'the UI shows the folder it is talking about');
    assert.deepEqual(r.json.backups.map((b) => b.name), entries.map((e) => e[0]).reverse());
    // the restore buttons are drawn off `restorable`, so that flag is part of the contract
    assert.deepEqual(r.json.backups.map((b) => [b.kind, b.restorable]), [['cfg', true], ['session', true], ['other', false]]);
  });
});
