'use strict';
// `expandSrc`: panel data of a result card from a file. Unit part = the path allowlist and the reader
// (lib/result-file.js) against a temp dir; server part = the route contracts (200/400/403/404) and the
// persist-time resolution in POST /api/uiskill/runs, with CLAUDE_UI_CLAUDE_DIR pointing at a temp
// .claude that carries ONE ui-skill manifest whose run.cwd is the temp skill dir (hermetic allowlist).
const { describe, it, before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const { spawn } = require('child_process');
const path = require('path');
const { resultFileRoots, resolveResultFile, readExpandFile, resolveResultSrc, MAX_BYTES } = require('../lib/result-file');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(ROOT, 'fake-claude.js');

const EXPAND = [{ row: 0, open: true, sides: ['PROJ-1', 'ACME-2'], rows: [{ label: 'Status', left: 'Done', mark: '✓', right: 'In UAT', tone: 'ok' }] }, { row: 9, rows: [{ label: 'außerhalb' }] }];

// ---------------------------------------------------------------- unit: allowlist + reader
test('resultFileRoots: absolute run.cwd values of the manifests, deduped; relative/missing ones ignored', () => {
  const roots = resultFileRoots([
    { manifest: { run: { cwd: 'C:\\skills\\sync' } } }, { manifest: { run: { cwd: 'C:\\skills\\sync\\' } } },
    { manifest: { run: { cwd: 'relative\\dir' } } }, { manifest: { run: {} } }, { manifest: {} }, null,
  ]);
  assert.deepEqual(roots, [path.resolve('C:\\skills\\sync')]);
});

test('resolveResultFile: only absolute .json paths INSIDE a root; escapes, other drives and the root itself are refused', () => {
  const roots = [path.resolve('C:\\skills\\sync')];
  assert.equal(resolveResultFile('C:\\skills\\sync\\sync-expand.json', roots).path, path.resolve('C:\\skills\\sync\\sync-expand.json'));
  assert.equal(resolveResultFile('C:\\skills\\sync\\sub\\x.JSON', roots).error, undefined, 'subdirs + case-insensitive extension are fine');
  assert.equal(resolveResultFile('C:\\skills\\sync\\..\\other\\x.json', roots).status, 403, '.. escape');
  assert.equal(resolveResultFile('C:\\skills\\sync-evil\\x.json', roots).status, 403, 'prefix trick: sync-evil is not inside sync');
  assert.equal(resolveResultFile('D:\\skills\\sync\\x.json', roots).status, 403, 'other drive');
  assert.equal(resolveResultFile('C:\\skills\\sync', roots).status, 400, 'the root itself is not a file (no .json)');
  assert.equal(resolveResultFile('C:\\skills\\sync\\plan.js', roots).status, 400, 'only .json');
  assert.equal(resolveResultFile('sync-expand.json', roots).status, 400, 'relative');
  assert.equal(resolveResultFile('', roots).status, 400);
  assert.equal(resolveResultFile(null, roots).status, 400);
  assert.equal(resolveResultFile('C:\\skills\\sync\\x.json', []).status, 403, 'no roots → nothing is served');
});

describe('readExpandFile / resolveResultSrc against a temp dir', () => {
  let dir;
  before(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-rf-'));
    await fsp.writeFile(path.join(dir, 'ok.json'), JSON.stringify({ expand: EXPAND }), 'utf8');
    await fsp.writeFile(path.join(dir, 'bare.json'), JSON.stringify(EXPAND), 'utf8');
    await fsp.writeFile(path.join(dir, 'broken.json'), '{nope', 'utf8');
    await fsp.writeFile(path.join(dir, 'noexpand.json'), '{"rows":[]}', 'utf8');
    await fsp.mkdir(path.join(dir, 'folder.json'));
  });
  after(async () => { if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); });

  it('reads {expand:[…]} or a bare array and re-normalizes it against the row count', async () => {
    const r = await readExpandFile(path.join(dir, 'ok.json'), [dir], 3);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.expand.map((e) => e.row), [0], 'row 9 is outside 3 rows → dropped by the whitelist');
    assert.equal(r.expand[0].open, true);
    assert.deepEqual((await readExpandFile(path.join(dir, 'bare.json'), [dir], 10)).expand.map((e) => e.row), [0, 9]);
  });

  it('missing / directory / invalid JSON / no array → typed errors, never a throw', async () => {
    assert.equal((await readExpandFile(path.join(dir, 'missing.json'), [dir], 1)).status, 404);
    assert.equal((await readExpandFile(path.join(dir, 'folder.json'), [dir], 1)).status, 404);
    assert.equal((await readExpandFile(path.join(dir, 'broken.json'), [dir], 1)).status, 422);
    assert.equal((await readExpandFile(path.join(dir, 'noexpand.json'), [dir], 1)).status, 422);
    assert.equal((await readExpandFile(path.join(os.tmpdir(), 'x.json'), [dir], 1)).status, 403);
  });

  // ---- the check and the read must be the SAME file (js/file-system-race, CWE-367) ----------------
  // The swap is INJECTED, not raced: whichever call the implementation uses to check the file, the file
  // underneath the path is replaced the moment that call returns. A path-based check (`fsp.stat(path)`
  // then `fsp.readFile(path)`, which is what this function did) measures one file and reads another, so
  // the 4 MB cap binds nothing — and with a model-authored path into a directory the user's own tooling
  // rewrites between runs, that is a cap anyone who can write there steps over. A handle-based check
  // (`fsp.open` → `fh.stat()` → `fh.readFile()`, the house form from lib/backups.js readDiffSide) keeps
  // looking at the inode it opened, so both halves describe the same bytes.
  // Measured on this machine (Windows 11, node 26.7) before the test was written: unlinking an OPEN file
  // and recreating the name works, and the handle then reports the OLD inode (3 bytes) while the path
  // reports the new one (8 bytes). That is what makes the swap deterministic instead of a timing stunt —
  // a rename over an open handle, by contrast, fails with EPERM on Windows.
  it('the bytes come from the file that was CHECKED, even when the path is swapped in between', async () => {
    const f = path.join(dir, 'swap.json');
    const swapIn = (text) => { fs.unlinkSync(f); fs.writeFileSync(f, text, 'utf8'); };
    // wrap an fs/promises call so the swap happens right after it returns — the module object is the
    // same one lib/result-file.js holds, so this hooks whichever of the two the implementation uses
    const patch = (name, fn) => { const real = fsp[name]; fsp[name] = async (...a) => { const v = await real.apply(fsp, a); try { fn(); } catch { /* */ } return v; }; return () => { fsp[name] = real; }; };

    // (1) content swap: the opened file says 'checked', the file at the name says 'swapped in'
    await fsp.writeFile(f, JSON.stringify({ expand: [{ row: 0, rows: [{ label: 'checked' }] }] }), 'utf8');
    let once = true;
    const swapContent = () => { if (!once) return; once = false; swapIn(JSON.stringify({ expand: [{ row: 0, rows: [{ label: 'swapped in' }] }] })); };
    let undo = [patch('open', swapContent), patch('stat', swapContent)];
    let r = await readExpandFile(f, [dir], 5);
    undo.forEach((u) => u());
    assert.equal(r.error, undefined, 'the opened file is valid JSON and must be served');
    assert.equal(r.expand[0].rows[0].label, 'checked', 'the read returned the file that replaced the checked one');

    // (2) cap swap: the opened file is small, what lands at the name is over MAX_BYTES. A path-based
    // implementation refuses the small file it was asked for (413) — or, the other way round, would
    // serve a huge one it never measured.
    await fsp.writeFile(f, JSON.stringify({ expand: [{ row: 0, rows: [{ label: 'small' }] }] }), 'utf8');
    once = true;
    const swapBig = () => { if (!once) return; once = false; swapIn('{"expand":[{"row":0,"rows":[{"label":"' + 'x'.repeat(MAX_BYTES) + '"}]}]}'); };
    undo = [patch('open', swapBig), patch('stat', swapBig)];
    r = await readExpandFile(f, [dir], 5);
    undo.forEach((u) => u());
    assert.equal(r.status, undefined, 'the cap must be decided on the file that was opened, not on what the name points at now');
    assert.equal(r.expand[0].rows[0].label, 'small');
    await fsp.rm(f, { force: true });
  });

  it('resolveResultSrc: inlines the file and drops the reference; keeps the reference when the file is unusable', async () => {
    const res = await resolveResultSrc({ columns: [{ id: 'a' }], rows: [['x']], expandSrc: path.join(dir, 'ok.json') }, [dir]);
    assert.equal(res.expandSrc, undefined);
    assert.equal(res.expand.length, 1);
    const kept = await resolveResultSrc({ columns: [{ id: 'a' }], rows: [['x']], expandSrc: path.join(dir, 'missing.json') }, [dir]);
    assert.equal(kept.expandSrc, path.join(dir, 'missing.json'));
    assert.equal(kept.expand, undefined);
    const inline = await resolveResultSrc({ rows: [['x']], expand: [{ row: 0, rows: [] }], expandSrc: path.join(dir, 'ok.json') }, [dir]);
    assert.equal(inline.expandSrc, undefined, 'inline data present → reference dropped without reading');
    assert.equal(await resolveResultSrc(null, [dir]), null);
    assert.deepEqual(await resolveResultSrc({ rows: [] }, [dir]), { rows: [] });
  });
});

// ---------------------------------------------------------------- server: route + persist-time resolution
function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch {} resolve({ status: res.statusCode, body: d, json }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function waitUp(port, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await req(port, 'GET', '/api/state'); if (r.status === 200) return; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('server did not come up on :' + port);
}

describe('/api/uiskill/result-file + POST /api/uiskill/runs (hermetic .claude + data dir)', () => {
  let S, dataDir, claudeDir, skillDir, outsideFile;
  before(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-rf-data-'));
    claudeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-rf-claude-'));
    skillDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-rf-skill-'));
    await fsp.mkdir(path.join(claudeDir, 'commands'));
    const manifest = { version: 1, title: 'RF Test', run: { cwd: skillDir }, inputs: [], steps: [], promptTemplate: '/zz-rf' };
    await fsp.writeFile(path.join(claudeDir, 'commands', 'zz-rf.md'), '---\ndescription: rf\n---\n\n```ui-skill\n' + JSON.stringify(manifest) + '\n```\n', 'utf8');
    await fsp.writeFile(path.join(skillDir, 'sync-expand.json'), JSON.stringify({ expand: EXPAND }), 'utf8');
    outsideFile = path.join(os.tmpdir(), 'ccui-rf-outside-' + process.pid + '.json');
    await fsp.writeFile(outsideFile, JSON.stringify({ expand: EXPAND }), 'utf8');
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, CLAUDE_UI_PORT: String(port), CLAUDE_UI_FAKE_BIN: FAKE, CLAUDE_UI_DATA_DIR: dataDir, CLAUDE_UI_CLAUDE_DIR: claudeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
    await waitUp(port);
    S = { port, log: () => log, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }) };
  });
  after(async () => {
    if (S) await S.stop();
    for (const d of [dataDir, claudeDir, skillDir]) if (d) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
    if (outsideFile) await fsp.rm(outsideFile, { force: true }).catch(() => {});
  });

  it('serves a .json inside the registered skill cwd, normalized against ?rows', async () => {
    const r = await req(S.port, 'GET', '/api/uiskill/result-file?src=' + encodeURIComponent(path.join(skillDir, 'sync-expand.json')) + '&rows=1');
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(r.json.expand.map((e) => e.row), [0]);
    assert.equal(r.json.expand[0].sides[1], 'ACME-2');
  });

  it('refuses paths outside the allowlist (403), relative/non-json (400) and missing files (404)', async () => {
    assert.equal((await req(S.port, 'GET', '/api/uiskill/result-file?src=' + encodeURIComponent(outsideFile))).status, 403);
    assert.equal((await req(S.port, 'GET', '/api/uiskill/result-file?src=' + encodeURIComponent(path.join(skillDir, '..', path.basename(outsideFile))))).status, 403);
    assert.equal((await req(S.port, 'GET', '/api/uiskill/result-file?src=sync-expand.json')).status, 400);
    assert.equal((await req(S.port, 'GET', '/api/uiskill/result-file?src=' + encodeURIComponent(path.join(skillDir, 'server.js')))).status, 400);
    assert.equal((await req(S.port, 'GET', '/api/uiskill/result-file?src=' + encodeURIComponent(path.join(skillDir, 'gone.json')))).status, 404);
    assert.equal((await req(S.port, 'GET', '/api/uiskill/result-file')).status, 400);
  });

  it('POST /api/uiskill/runs inlines the file into the persisted result and drops expandSrc', async () => {
    const result = { source: 'block', summary: 's', columns: [{ id: 'k', label: 'K', type: 'link' }, { id: 'sync', label: 'Sync', type: 'expand' }], rows: [['PROJ-1', 'Status ✓']], expandSrc: path.join(skillDir, 'sync-expand.json') };
    const post = await req(S.port, 'POST', '/api/uiskill/runs', { name: 'zz-rf', title: 'RF Test', status: 'done', result });
    assert.equal(post.status, 200, post.body);
    const one = (await req(S.port, 'GET', '/api/uiskill/runs/' + encodeURIComponent(post.json.id))).json.run;
    assert.equal(one.result.expandSrc, undefined, 'history entry must not depend on the file');
    assert.equal(one.result.expand.length, 1);
    assert.equal(one.result.expand[0].rows[0].label, 'Status');
    // the file is rewritten by the next run — the persisted entry keeps what THIS run saw
    await fsp.writeFile(path.join(skillDir, 'sync-expand.json'), JSON.stringify({ expand: [] }), 'utf8');
    const again = (await req(S.port, 'GET', '/api/uiskill/runs/' + encodeURIComponent(post.json.id))).json.run;
    assert.equal(again.result.expand.length, 1);
  });

  it('POST with an unresolvable expandSrc keeps the reference (the card can still report why)', async () => {
    const result = { source: 'block', columns: [{ id: 'k' }], rows: [['x']], expandSrc: path.join(skillDir, 'missing.json') };
    const post = await req(S.port, 'POST', '/api/uiskill/runs', { name: 'zz-rf', status: 'done', result });
    const one = (await req(S.port, 'GET', '/api/uiskill/runs/' + encodeURIComponent(post.json.id))).json.run;
    assert.equal(one.result.expandSrc, path.join(skillDir, 'missing.json'));
    assert.equal(one.result.expand, undefined);
  });
});
