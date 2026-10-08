'use strict';
// BUILDER-1, the server half — PUT /api/cfgfile learns If-Match and `create`, as a route contract.
//
// Why the server: the UI-skill builder now keeps a draft across tab, view and language switches, so the draft can
// be older than the file it will be saved over — the CLI, an editor or a second panel window may have written the
// skill in between. Only the route sees the file as it is at the moment of the write; a check in the browser would
// compare against a list that is already stale. The browser half (test/builder-draft.test.js) runs against a
// stand-in that copies THIS contract — change it here first, then there.
//
// Pinned as well: a PUT without either keeps the old behaviour, because the config editor (views-system.js) and
// „Neuer UI-Skill" / „Aus Skill erstellen" send none and overwrite on purpose.
// Hermetic: makeSandbox gives the server its own ~/.claude, so no real command file is read or written.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { makeSandbox } = require('./sandbox');

const ROOT = path.join(__dirname, '..');
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function req(port, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const h = Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, headers || {});
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* non-JSON stays in .body */ } resolve({ status: res.statusCode, body: d, json }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function waitUp(port, ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await req(port, 'GET', '/api/state'); if (r.status === 200) return; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('server did not come up on :' + port);
}

describe('PUT /api/cfgfile — If-Match and create (BUILDER-1, sandboxed ~/.claude)', () => {
  let S, sb, DIR;
  const file = (name) => path.join(DIR, name + '.md');
  const get = (name) => req(S.port, 'GET', '/api/cfgfile?kind=commands&name=' + encodeURIComponent(name));
  const put = (body, hash) => req(S.port, 'PUT', '/api/cfgfile', Object.assign({ kind: 'commands' }, body), hash !== undefined ? { 'If-Match': '"' + hash + '"' } : {});
  before(async () => {
    sb = makeSandbox('cfgfile', { fakeCli: true });
    DIR = path.join(sb.claudeDir, 'commands');
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, ...sb.env, CLAUDE_UI_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    await waitUp(port);
    S = { port, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }) };
  });
  after(async () => { if (S) await S.stop(); if (sb) sb.cleanup(); });
  beforeEach(() => { fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true }); });

  it('GET hands out the version (the hash of the text) — and says „missing" only for a file that is not there', async () => {
    fs.writeFileSync(file('zz-a'), 'eins');
    const r = await get('zz-a');
    assert.equal(r.status, 200);
    assert.equal(r.json.content, 'eins');
    assert.equal(r.json.hash, sha('eins'), 'without the version the builder has nothing to send as If-Match');
    const gone = await get('zz-nope');
    assert.equal(gone.status, 404);
    assert.equal(gone.json.code, 'missing', 'the builder may only say „gelöscht" when the route says the file is not there');
  });

  it('If-Match of the loaded text → written, and the answer carries the NEW version', async () => {
    fs.writeFileSync(file('zz-a'), 'eins');
    const r = await put({ name: 'zz-a', content: 'zwei' }, sha('eins'));
    assert.equal(r.status, 200, r.body);
    assert.equal(fs.readFileSync(file('zz-a'), 'utf8'), 'zwei');
    assert.equal(r.json.hash, sha('zwei'), 'the next save needs the version of what is on disk now');
  });

  it('the file changed since it was loaded → 409 changed with its current version, and NOTHING is written', async () => {
    fs.writeFileSync(file('zz-a'), 'von der CLI geändert');
    const r = await put({ name: 'zz-a', content: 'alter Entwurf' }, sha('eins'));
    assert.equal(r.status, 409, 'a draft older than the file overwrote it — the change made in between is gone');
    assert.equal(r.json.code, 'changed');
    assert.equal(r.json.exists, true);
    assert.equal(r.json.hash, sha('von der CLI geändert'), 'the deliberate overwrite needs the version the 409 is about');
    assert.equal(fs.readFileSync(file('zz-a'), 'utf8'), 'von der CLI geändert');
    // …and the overwrite with exactly that version goes through
    const ow = await put({ name: 'zz-a', content: 'alter Entwurf' }, r.json.hash);
    assert.equal(ow.status, 200, ow.body);
    assert.equal(fs.readFileSync(file('zz-a'), 'utf8'), 'alter Entwurf');
  });

  it('the file was deleted since it was loaded → 409 changed with exists:false, and it is NOT re-created', async () => {
    const r = await put({ name: 'zz-weg', content: 'Entwurf' }, sha('eins'));
    assert.equal(r.status, 409, 'a save with a version re-created a file someone had deleted');
    assert.equal(r.json.code, 'changed');
    assert.equal(r.json.exists, false);
    assert.equal(fs.existsSync(file('zz-weg')), false);
  });

  it('create:true writes a NEW file, and refuses a name that is taken — in any capitalisation', async () => {
    const ok = await put({ name: 'zz-neu', content: 'neu', create: true });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(ok.json.created, true);
    assert.equal(fs.readFileSync(file('zz-neu'), 'utf8'), 'neu');
    const clash = await put({ name: 'ZZ-Neu', content: 'ÜBERSCHRIEBEN', create: true });
    assert.equal(clash.status, 409, 'on NTFS this overwrites zz-neu.md');
    assert.equal(clash.json.code, 'exists');
    assert.equal(clash.json.existing, 'zz-neu.md', 'the builder names the file that took the name — in ITS spelling');
    assert.equal(fs.readFileSync(file('zz-neu'), 'utf8'), 'neu');
  });

  // Abnahme PR-15c: only the ENOENT half of „missing" was pinned — a route that said „missing" for every 404 stayed
  // green, and the builder would have called a locked or unreadable file „deleted" and offered to create it anew.
  it('an entry that is there but cannot be read (a directory named zz-dir.md) is NOT „missing" — and If-Match against it writes nothing', async () => {
    fs.mkdirSync(file('zz-dir'));
    const g = await get('zz-dir');
    assert.equal(g.status, 404);
    assert.notEqual(g.json.code, 'missing', 'the route says „missing" for an entry that is there — the builder would call it deleted');
    const p = await put({ name: 'zz-dir', content: 'Entwurf' }, sha('eins'));
    assert.equal(p.status, 409, p.body);
    assert.equal(p.json.code, 'unreadable', 'an unreadable entry was answered as „deleted" (or written over)');
    assert.ok(fs.statSync(file('zz-dir')).isDirectory(), 'the entry was replaced');
  });

  it('create:true where the directory cannot be listed → 409 unreadable — „never an overwrite" does not rest on a swallowed error', async () => {
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.writeFileSync(DIR, 'kein Verzeichnis');   // readdir → ENOTDIR, not ENOENT: nobody can tell whether the name is taken
    const r = await put({ name: 'zz-neu', content: 'neu', create: true });
    assert.equal(r.status, 409, r.body);
    assert.equal(r.json.code, 'unreadable');
    assert.equal(fs.readFileSync(DIR, 'utf8'), 'kein Verzeichnis');
  });

  it('no If-Match, no create → the old overwrite, unchanged (config editor, „Neuer UI-Skill")', async () => {
    fs.writeFileSync(file('zz-a'), 'eins');
    const r = await put({ name: 'zz-a', content: 'überschrieben' });
    assert.equal(r.status, 200, r.body);
    assert.equal(fs.readFileSync(file('zz-a'), 'utf8'), 'überschrieben');
    assert.ok(r.json.backup, 'the overwrite still makes its backup first');
    const fresh = await put({ name: 'zz-b', content: 'neu angelegt' });
    assert.equal(fresh.status, 200, 'a PUT without a version still creates a missing file');
    assert.equal(fresh.json.created, true);
  });
});
