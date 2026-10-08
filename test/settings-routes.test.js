'use strict';
// Route contract for the settings writes (DATA-1, DATA-2): PUT = the full-text editor's save with
// If-Match, PATCH = the comfort actions' named ops. The two failures they exist for:
//  · a settings.json that does not parse (a hand edit with a trailing comma) was read as {}, shown as a
//    valid empty file, and the next save wrote that — the Bedrock env block was gone;
//  · every comfort action PUT the whole file from the browser's copy, so two actions in a row (or a rule
//    the CLI wrote in between) lost the earlier one.
// Boots a throwaway server in the shared sandbox (test/sandbox.js), so CLAUDE_DIR is a temp tree and the
// real ~/.claude is never read or written.
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

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function req(port, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, headers || {});
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch {} resolve({ status: res.statusCode, body: d, json, type: res.headers['content-type'] || '' }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function waitUp(port, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await req(port, 'GET', '/api/state'); if (r.status === 200) return; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('server did not come up on :' + port);
}
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const BROKEN = '{\n  "env": { "CLAUDE_CODE_USE_BEDROCK": "1", "AWS_REGION": "eu-central-1" },\n}\n';

describe('settings writes — PUT with If-Match, PATCH with ops (sandboxed CLAUDE_DIR)', () => {
  let S, sbx, SETTINGS, LOCAL, BACKUPS;
  const write = (f, text) => fs.writeFileSync(f, text);
  const read = (f) => fs.readFileSync(f, 'utf8');
  const json = (f) => JSON.parse(read(f));
  const backups = () => (fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS) : []);
  const patch = (ops, file) => req(S.port, 'PATCH', '/api/config/' + (file || 'settings'), { ops });

  before(async () => {
    sbx = makeSandbox('settings', { fakeCli: true });
    SETTINGS = path.join(sbx.claudeDir, 'settings.json');
    LOCAL = path.join(sbx.claudeDir, 'settings.local.json');
    BACKUPS = path.join(sbx.claudeDir, 'backups', 'claude-code-ui');
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT, env: { ...process.env, ...sbx.env, CLAUDE_UI_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitUp(port);
    S = { port, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }) };
  });
  after(async () => { if (S) await S.stop(); if (sbx) sbx.cleanup(); });
  // recursive: the unreadable-file case puts a FOLDER where settings.json belongs
  beforeEach(() => { for (const f of [SETTINGS, LOCAL]) fs.rmSync(f, { recursive: true, force: true }); fs.rmSync(BACKUPS, { recursive: true, force: true }); });

  // ---------------------------------------------------------------- DATA-1: a broken file
  it('/api/state hands a broken file over as its text, not as {}', async () => {
    write(SETTINGS, BROKEN);
    const st = await req(S.port, 'GET', '/api/state');
    assert.equal(st.status, 200);
    const s = st.json.settings;
    assert.equal(s.exists, true);
    assert.equal(s.parsed, null, 'parsed:{} is what let the editor show a broken file as valid and empty');
    assert.equal(s.raw, BROKEN);
    assert.ok(s.error, 'the parse error travels along for the banner');
    assert.equal(s.hash, sha(BROKEN));
  });

  it('PATCH on a broken file is refused (409 unparsable) and the bytes stay as they are', async () => {
    write(SETTINGS, BROKEN);
    const r = await patch([{ op: 'set', path: ['theme'], value: 'dark' }]);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'unparsable');
    assert.ok(r.json.parseError);
    assert.equal(r.json.settings.raw, BROKEN, 'the answer carries the file so the client can show it');
    assert.equal(read(SETTINGS), BROKEN);
    assert.deepEqual(backups(), [], 'a refused write does not even back up');
  });

  it('PUT without If-Match on a broken file is refused too — only an editor that showed it may replace it', async () => {
    write(SETTINGS, BROKEN);
    const r = await req(S.port, 'PUT', '/api/config/settings', { parsed: {} });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'unparsable');
    assert.equal(read(SETTINGS), BROKEN);
  });

  it('PUT with If-Match = the broken text\'s hash is the repair: written, and the broken file kept as backup', async () => {
    write(SETTINGS, BROKEN);
    const fixed = { env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-central-1' } };
    const r = await req(S.port, 'PUT', '/api/config/settings', { parsed: fixed }, { 'If-Match': '"' + sha(BROKEN) + '"' });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(json(SETTINGS), fixed);
    assert.ok(r.json.backup, 'names the backup');
    assert.equal(r.json.settings.hash, sha(read(SETTINGS)), 'the answer is the NEW file\'s snapshot');
    const bak = backups().filter((f) => f.startsWith('settings.json.'));
    assert.equal(bak.length, 1);
    assert.equal(fs.readFileSync(path.join(BACKUPS, bak[0]), 'utf8'), BROKEN, 'the hand-edited text is not lost');
  });

  // ---------------------------------------------------------------- DATA-2: stale editor
  it('PUT with a stale If-Match is 409 changed with the current file; nothing is written', async () => {
    write(SETTINGS, JSON.stringify({ a: 1 }, null, 2) + '\n');
    const loadedHash = (await req(S.port, 'GET', '/api/state')).json.settings.hash;
    const external = JSON.stringify({ a: 1, permissions: { allow: ['Bash(npm test)'] } }, null, 2) + '\n';
    write(SETTINGS, external); // the CLI granted a rule meanwhile
    const r = await req(S.port, 'PUT', '/api/config/settings', { parsed: { a: 2 } }, { 'If-Match': '"' + loadedHash + '"' });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'changed');
    assert.equal(r.json.settings.raw, external, 'the dialog can reload straight from the answer');
    assert.equal(r.json.settings.hash, sha(external));
    assert.equal(read(SETTINGS), external);
    // "Überschreiben" in the dialog = the same PUT with the hash it was just shown
    const o = await req(S.port, 'PUT', '/api/config/settings', { parsed: { a: 2 } }, { 'If-Match': 'W/"' + r.json.settings.hash + '"' });
    assert.equal(o.status, 200, o.body);
    assert.deepEqual(json(SETTINGS), { a: 2 });
  });

  it('PUT without If-Match on a valid file still saves (callers without a hash keep working)', async () => {
    write(SETTINGS, '{"a":1}');
    const r = await req(S.port, 'PUT', '/api/config/settings', { b: 2 });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(json(SETTINGS), { b: 2 });
    for (const bad of [[], 'x', null]) assert.equal((await req(S.port, 'PUT', '/api/config/settings', { parsed: bad })).status, 400, JSON.stringify(bad));
    // a bare JSON `null` body: was a TypeError (body.parsed of null) → 500
    const nul = await req(S.port, 'PUT', '/api/config/settings', 'null');
    assert.equal(nul.status, 400, nul.body);
    assert.deepEqual(json(SETTINGS), { b: 2 });
  });

  // ---------------------------------------------------------------- DATA-1: BOM, unreadable
  it('a settings.json with a UTF-8 BOM is a valid file, not a "broken" one — PATCH and PUT work', async () => {
    const text = '\uFEFF' + JSON.stringify({ env: { A: '1' } }, null, 2) + '\n';
    write(SETTINGS, text);
    const s = (await req(S.port, 'GET', '/api/state')).json.settings;
    assert.deepEqual(s.parsed, { env: { A: '1' } }, 'the CLI reads this file — the panel must not lock it');
    assert.equal(s.hash, sha(text), 'the version is of the bytes on disk, BOM included');
    const p = await patch([{ op: 'set', path: ['env', 'B'], value: '2' }]);
    assert.equal(p.status, 200, p.body);
    assert.deepEqual(json(SETTINGS), { env: { A: '1', B: '2' } });
    write(SETTINGS, text);
    const u = await req(S.port, 'PUT', '/api/config/settings', { parsed: { env: { A: '3' } } }, { 'If-Match': '"' + sha(text) + '"' });
    assert.equal(u.status, 200, u.body);
  });

  it('a file that cannot be read is reported as such and never written over — PATCH and PUT, any If-Match', async () => {
    fs.mkdirSync(SETTINGS); // EISDIR on read — the portable stand-in for a locked file / no permission
    const s = (await req(S.port, 'GET', '/api/state')).json.settings;
    assert.equal(s.unreadable, true);
    assert.equal(s.parsed, null);
    assert.ok(s.error);
    assert.equal(s.hash, 'unreadable', 'not sha("") — that is the hash of "missing", which a client may create');
    const p = await patch([{ op: 'set', path: ['a'], value: 1 }]);
    assert.equal(p.status, 409);
    assert.equal(p.json.code, 'unreadable');
    assert.ok(p.json.readError);
    for (const h of [undefined, { 'If-Match': '"' + sha('') + '"' }, { 'If-Match': '"unreadable"' }]) {
      const r = await req(S.port, 'PUT', '/api/config/settings', { parsed: { a: 1 } }, h);
      assert.equal(r.status, 409, JSON.stringify(h) + ' → ' + r.body);
      assert.equal(r.json.code, 'unreadable');
    }
    assert.ok(fs.statSync(SETTINGS).isDirectory(), 'untouched');
    assert.deepEqual(backups(), []);
  });

  // ---------------------------------------------------------------- DATA-2: PATCH merges
  it('two PATCHes at the same time both land (each applied to the file as the lock hands it over)', async () => {
    write(LOCAL, JSON.stringify({ permissions: { allow: ['Read'] } }));
    const rules = ['Bash(git status)', 'Bash(npm test)', 'WebFetch', 'Edit', 'Grep'];
    const rs = await Promise.all(rules.map((rule) => patch([{ op: 'push', path: ['permissions', 'allow'], value: rule }], 'settings-local')));
    for (const r of rs) assert.equal(r.status, 200, r.body);
    assert.deepEqual(json(LOCAL).permissions.allow.slice().sort(), ['Read', ...rules].sort());
  });

  it('PATCH keeps what someone else wrote to the file after the browser loaded it', async () => {
    write(SETTINGS, JSON.stringify({ env: { A: '1' } }));
    await req(S.port, 'GET', '/api/state'); // the browser's view: env.A only
    write(SETTINGS, JSON.stringify({ env: { A: '1' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] } }));
    const r = await patch([{ op: 'set', path: ['env', 'B'], value: '2' }]);
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(json(SETTINGS), { env: { A: '1', B: '2' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] } });
    assert.deepEqual(r.json.settings.parsed, json(SETTINGS), 'the answer is the file');
  });

  it('PATCH creates a missing file; a no-op writes nothing and makes no backup', async () => {
    const r = await patch([{ op: 'push', path: ['permissions', 'deny'], value: 'Bash(rm -rf *)' }], 'settings-local');
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(json(LOCAL), { permissions: { deny: ['Bash(rm -rf *)'] } });
    const before = read(LOCAL), bak = backups().length;
    const again = await patch([{ op: 'push', path: ['permissions', 'deny'], value: 'Bash(rm -rf *)' }], 'settings-local');
    assert.equal(again.status, 200);
    assert.equal(again.json.changed, false);
    assert.equal(read(LOCAL), before);
    assert.equal(backups().length, bak);
  });

  it('a hook removed in two browsers: the second strict pull is a 409 conflict, not a second deletion', async () => {
    const entry = { matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }] };
    write(SETTINGS, JSON.stringify({ hooks: { PreToolUse: [entry, { hooks: [{ type: 'command', command: 'b' }] }] } }));
    const first = await patch([{ op: 'pull', path: ['hooks', 'PreToolUse'], value: entry, strict: true }]);
    assert.equal(first.status, 200, first.body);
    const second = await patch([{ op: 'pull', path: ['hooks', 'PreToolUse'], value: entry, strict: true }]);
    assert.equal(second.status, 409);
    assert.equal(second.json.code, 'conflict');
    assert.ok(second.json.settings, 'with the current file, so the list repaints');
    assert.deepEqual(json(SETTINGS), { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'b' }] }] } });
  });

  it('malformed PATCH bodies are a JSON 400 and touch nothing', async () => {
    write(SETTINGS, '{"a":1}');
    const cases = [
      {},                                                            // what the parity sweep sends
      { ops: [] },
      { ops: [{ op: 'set', path: 'env.X', value: 1 }] },
      { ops: [{ op: 'set', path: ['__proto__', 'polluted'], value: 1 }] },
      { ops: [{ op: 'set', path: ['constructor', 'prototype', 'x'], value: 1 }] },
    ];
    for (const body of cases) {
      const r = await req(S.port, 'PATCH', '/api/config/settings', body);
      assert.equal(r.status, 400, JSON.stringify(body) + ' → ' + r.body);
      assert.match(r.type, /application\/json/);
      assert.equal(r.json.code, 'bad-op');
    }
    const garbage = await req(S.port, 'PATCH', '/api/config/settings', 'not json');
    assert.ok(garbage.status >= 400 && garbage.status < 500, 'a non-JSON body is a client error: ' + garbage.status);
    assert.equal(read(SETTINGS), '{"a":1}');
    assert.deepEqual(backups(), []);
  });

  it('a browser PATCH without X-CCUI is 403 (the guard covers the new method too)', async () => {
    write(SETTINGS, '{"a":1}');
    const origin = 'http://127.0.0.1:' + S.port;
    const ops = [{ op: 'set', path: ['a'], value: 2 }];
    const no = await req(S.port, 'PATCH', '/api/config/settings', { ops }, { Origin: origin, 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(no.status, 403);
    assert.equal(read(SETTINGS), '{"a":1}');
    const yes = await req(S.port, 'PATCH', '/api/config/settings', { ops }, { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-CCUI': '1' });
    assert.equal(yes.status, 200, yes.body);
    assert.deepEqual(json(SETTINGS), { a: 2 });
  });

  // ---------------------------------------------------------------- restore: what comes back, and from where
  it('restoring a settings backup writes it back and keeps the current file as a backup', async () => {
    write(SETTINGS, JSON.stringify({ v: 1 }));
    assert.equal((await patch([{ op: 'set', path: ['v'], value: 2 }])).status, 200);
    const bak = backups().find((f) => f.startsWith('settings.json.'));
    assert.ok(bak, 'the PATCH backed up v:1');
    const r = await req(S.port, 'POST', '/api/backups/restore', { name: bak });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(json(SETTINGS), { v: 1 });
    const kept = backups().filter((f) => f.startsWith('settings.json.')).map((f) => fs.readFileSync(path.join(BACKUPS, f), 'utf8'));
    assert.ok(kept.some((t) => JSON.parse(t).v === 2), 'the overwritten v:2 survives as a backup');
  });

  it('a restore gives back the exact bytes — also ones that are not valid UTF-8', async () => {
    fs.mkdirSync(BACKUPS, { recursive: true });
    // `"name": "Müller"` saved as Latin-1 (0xFC) — a utf8 round trip turns that byte into U+FFFD
    const bytes = Buffer.concat([Buffer.from('{"name":"M'), Buffer.from([0xFC]), Buffer.from('ller"}\n')]);
    const name = 'settings.json.2001-01-01T00-00-00-000Z.bak';
    fs.writeFileSync(path.join(BACKUPS, name), bytes);
    write(SETTINGS, '{"now":1}');
    const r = await req(S.port, 'POST', '/api/backups/restore', { name });
    assert.equal(r.status, 200, r.body);
    assert.ok(fs.readFileSync(SETTINGS).equals(bytes), 'byte for byte, not re-encoded');
  });

  it('restoring the OLDEST of 30 backups works — it is read before the backup of the current file prunes it', async () => {
    // backupFile keeps 30 per file and deletes the oldest after copying. Restoring the oldest used to
    // back up first: that prune removed the very file about to be restored → ENOENT → 500.
    fs.mkdirSync(BACKUPS, { recursive: true });
    const names = Array.from({ length: 30 }, (_, i) => 'settings.json.2000-01-01T00-' + String(i).padStart(2, '0') + '-00-000Z.bak');
    names.forEach((n, i) => fs.writeFileSync(path.join(BACKUPS, n), JSON.stringify({ v: i }) + '\n'));
    write(SETTINGS, JSON.stringify({ v: 'current' }));
    const r = await req(S.port, 'POST', '/api/backups/restore', { name: names[0] });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(json(SETTINGS), { v: 0 });
    const left = backups().filter((f) => f.startsWith('settings.json.'));
    assert.equal(left.length, 30, 'retention still holds');
    assert.ok(!left.includes(names[0]), 'the restored (oldest) one was the one pruned — its content now lives in settings.json');
    assert.ok(left.map((f) => read(path.join(BACKUPS, f))).some((t) => JSON.parse(t).v === 'current'), 'the replaced file is kept');
  });

  // The test above is also the proof that a settings restore at the limit COSTS a backup — which the
  // confirmation dialog promised it would not („Das Backup bleibt erhalten (es wird kopiert, nicht
  // verschoben)", PR-14). The preview has to name that casualty before the click, and it has to name the
  // right one: the list reads 30 before and 30 after, so a reader comparing numbers can never tell.
  it('the preview names the backup the restore then deletes — the restored one, and an uninvolved one', async () => {
    fs.mkdirSync(BACKUPS, { recursive: true });
    const seed = () => {
      fs.rmSync(BACKUPS, { recursive: true, force: true });
      fs.mkdirSync(BACKUPS, { recursive: true });
      const names = Array.from({ length: 30 }, (_, i) => 'settings.json.2000-01-01T00-' + String(i).padStart(2, '0') + '-00-000Z.bak');
      names.forEach((n, i) => fs.writeFileSync(path.join(BACKUPS, n), JSON.stringify({ v: i }) + '\n'));
      write(SETTINGS, JSON.stringify({ v: 'current' }));
      return names;
    };
    const preview = (n) => req(S.port, 'GET', '/api/backups/preview?name=' + encodeURIComponent(n));
    for (const pick of [0, 17]) {
      const names = seed();
      const pv = await preview(names[pick]);
      assert.equal(pv.status, 200, pv.body);
      assert.deepEqual(pv.json.prunes, [names[0]], 'always the oldest — that is the one lib/core.js:97 sorts to the front');
      const r = await req(S.port, 'POST', '/api/backups/restore', { name: names[pick] });
      assert.equal(r.status, 200, r.body);
      const left = backups().filter((f) => f.startsWith('settings.json.'));
      assert.equal(left.length, 30, 'before and after read the same — which is exactly why the dialog has to say it');
      assert.deepEqual(pv.json.prunes.filter((n) => left.includes(n)), [], 'what the dialog announced is really gone');
      // …and nothing BEYOND the announcement disappeared. A settings restore is a copy, so even the backup
      // that was just restored is still there unless the prune took it.
      assert.deepEqual(names.filter((n) => n !== names[0] && !left.includes(n)), [], 'no unannounced casualty');
    }
  });

  it('restoring onto a settings.json that cannot be read is 409 unreadable — like PUT/PATCH, nothing moves', async () => {
    // it could not be backed up first, so replacing it would lose whatever it holds
    fs.mkdirSync(BACKUPS, { recursive: true });
    const name = 'settings.json.2002-01-01T00-00-00-000Z.bak';
    fs.writeFileSync(path.join(BACKUPS, name), '{"v":1}\n');
    fs.mkdirSync(SETTINGS);
    const r = await req(S.port, 'POST', '/api/backups/restore', { name });
    assert.equal(r.status, 409, r.body);
    assert.equal(r.json.code, 'unreadable');
    assert.ok(fs.statSync(SETTINGS).isDirectory(), 'untouched');
    assert.deepEqual(backups(), [name], 'the backup is still there, and no new one was made');
  });
});
