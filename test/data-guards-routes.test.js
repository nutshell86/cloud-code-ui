'use strict';
// PR-9b — the three refusals that had to live in the SERVER, as route contracts.
//
// Why here and not in the browser: each of these three actions destroys or overwrites something on disk,
// and the dialog in front of it is not the only way in. The panel re-POSTs a stored schedule to pause it,
// „Verlauf leeren" is one POST, and a memory file can be written by anything that can reach the port. A
// confirm box in the browser protects the person who clicked; these answers protect the FILE.
//
//  · PUT  /api/memory/file  with `create: true`  — DATA-3: the name must be free, and „free" on NTFS is a
//    case-INSENSITIVE question (`Mein-Fakt.md` would have overwritten `mein-fakt.md`).
//  · POST /api/uiskill/runs/clear — DATA-UI-3: scoped to one skill, and a backup first.
//  · POST /api/uiskill/schedules  — SCHED-1: no rhythm nobody chose (`days: []` ran SEVEN days a week),
//    no unattended run with an empty required field — and switching a schedule OFF always allowed.
//
// Hermetic: makeSandbox gives the server its own ~/.claude + data dir, so the developer's memory files,
// run history and schedules are never touched. The skill manifest the schedule guard reads is written
// into that sandbox, not into the real commands dir.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { makeSandbox } = require('./sandbox');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* non-JSON body stays in .body */ } resolve({ status: res.statusCode, body: d, json }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function waitUp(port, ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await req(port, 'GET', '/api/state'); if (r.status === 200) return; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('server did not come up on :' + port);
}

// one UI skill with a REQUIRED field, so the schedule guard has a manifest to read
const SKILL_MD = '---\ndescription: guard fixture\n---\n\n# zz-guard-ui\n\n```ui-skill\n'
  + JSON.stringify({ version: 1, title: 'Guard', inputs: [{ id: 'thema', type: 'text', label: 'Thema', required: true }], promptTemplate: '/zz-guard-ui {{thema}}' })
  + '\n```\n';

describe('PR-9b server guards — memory create, history clear, schedule validation', () => {
  let S, sb;
  before(async () => {
    sb = makeSandbox('pr9b', { fakeCli: true });
    fs.mkdirSync(path.join(sb.claudeDir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(sb.claudeDir, 'commands', 'zz-guard-ui.md'), SKILL_MD);
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, ...sb.env, CLAUDE_UI_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
    await waitUp(port);
    S = { port, log: () => log, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }) };
  });
  after(async () => { if (S) await S.stop(); if (sb) sb.cleanup(); });

  // ------------------------------------------------------------------ DATA-3
  const PROJ = 'zz-guard-proj';
  const memGet = (name) => req(S.port, 'GET', '/api/memory/file?project=' + PROJ + '&name=' + encodeURIComponent(name));
  const memPut = (name, content, create) => req(S.port, 'PUT', '/api/memory/file', create ? { project: PROJ, name, content, create: true } : { project: PROJ, name, content });

  it('DATA-3: „Neue Memory" with a name that exists in ANOTHER capitalisation is refused, and the file survives', async () => {
    const first = await memPut('mein-fakt.md', 'der echte Inhalt', true);
    assert.equal(first.status, 200, 'creating the first file failed: ' + first.body);
    assert.equal(first.json.created, true, 'a new file must report created:true (no backup existed)');

    const clash = await memPut('Mein-Fakt.md', 'ÜBERSCHRIEBEN', true);
    assert.equal(clash.status, 409, 'the case variant was accepted — on NTFS that overwrites the first file');
    assert.equal(clash.json.code, 'exists');
    assert.equal(clash.json.existing, 'mein-fakt.md', 'the refusal must NAME the file in the way, otherwise it is a dead end');

    const after = await memGet('mein-fakt.md');
    assert.equal(after.json.content, 'der echte Inhalt', 'the existing memory file was overwritten anyway');
    // …and the refused spelling must not have been created as a second file either
    const dir = fs.readdirSync(path.join(sb.claudeDir, 'projects', PROJ, 'memory'));
    assert.deepEqual(dir, ['mein-fakt.md'], 'unexpected files in the memory dir: ' + dir.join(', '));
  });

  it('DATA-3: the editor\'s ordinary save (no create flag) still overwrites — that is its job', async () => {
    const save = await memPut('mein-fakt.md', 'bearbeitet', false);
    assert.equal(save.status, 200);
    assert.ok(save.json.backup, 'an overwrite without a backup would be the defect this guard is not about');
    assert.equal((await memGet('mein-fakt.md')).json.content, 'bearbeitet');
  });

  // ------------------------------------------------------------------ DATA-UI-3
  const addRun = (name) => req(S.port, 'POST', '/api/uiskill/runs', { name, title: name, status: 'done', startedAt: Date.now(), transcript: 'x' });
  const runNames = async () => ((await req(S.port, 'GET', '/api/uiskill/runs?meta=1')).json.runs || []).map((r) => r.name).sort();

  it('DATA-UI-3: clearing ONE skill\'s history leaves the other skills\' runs, and writes a backup first', async () => {
    await addRun('zz-guard-ui'); await addRun('zz-guard-ui'); await addRun('zz-other');
    assert.deepEqual(await runNames(), ['zz-guard-ui', 'zz-guard-ui', 'zz-other']);

    const r = await req(S.port, 'POST', '/api/uiskill/runs/clear', { name: 'zz-guard-ui' });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.removed, 2);
    assert.equal(r.json.kept, 1);
    assert.deepEqual(await runNames(), ['zz-other'], 'the clear reached another skill\'s runs');

    // the backup is the whole point: without it an accidental click is final
    assert.ok(r.json.backup, 'no backup path reported');
    const bak = JSON.parse(fs.readFileSync(r.json.backup, 'utf8'));
    const runs = Array.isArray(bak) ? bak : (bak.runs || []);
    assert.equal(runs.length, 3, 'the backup does not hold the three runs that existed before the clear');
    assert.ok(path.basename(r.json.backup).startsWith('ui-skill-runs.json.'), 'backup name: ' + r.json.backup);
    assert.ok(r.json.backup.startsWith(path.join(sb.claudeDir, 'backups')), 'the backup left the sandbox: ' + r.json.backup);
  });

  it('DATA-UI-3: without a name it still clears everything (unchanged), also with a backup', async () => {
    const r = await req(S.port, 'POST', '/api/uiskill/runs/clear', {});
    assert.equal(r.status, 200);
    assert.equal(r.json.removed, 1);
    assert.equal(r.json.kept, 0);
    assert.ok(r.json.backup, 'the all-skills clear is the more destructive one — it needs the backup too');
    assert.deepEqual(await runNames(), []);
  });

  // ------------------------------------------------------------------ SCHED-1
  const mkSched = (extra) => req(S.port, 'POST', '/api/uiskill/schedules', Object.assign({ name: 'zz-guard-ui', values: { thema: 'x' }, enabled: true }, extra));

  it('SCHED-1: „täglich" with every weekday clicked off is refused instead of running seven days a week', async () => {
    const r = await mkSched({ timing: { type: 'daily', time: '03:00', days: [] } });
    assert.equal(r.status, 400, 'days:[] was stored — computeNextRun then reads it as all seven days');
    assert.equal(r.json.code, 'bad-timing');
  });

  it('SCHED-1: weekdays are normalised, and values computeNextRun could never match are refused', async () => {
    const ok = await mkSched({ timing: { type: 'daily', time: '03:00', days: [5, 1, 1] } });
    assert.equal(ok.status, 200, ok.body);
    assert.deepEqual(ok.json.schedule.timing.days, [1, 5], 'duplicates/order survived into the store');
    assert.ok(ok.json.schedule.nextRun > Date.now());
    for (const days of [[9], ['1'], [1.5]]) {
      const bad = await mkSched({ timing: { type: 'daily', time: '03:00', days } });
      assert.equal(bad.status, 400, JSON.stringify(days) + ' was accepted — that schedule drifts a day per run');
    }
  });

  it('SCHED-1: a nonsense rhythm is refused at the moment of typing', async () => {
    for (const timing of [{ type: 'bogus' }, { type: 'interval', minutes: 0 }, { type: 'interval', minutes: -5 }, { type: 'daily', time: '25:00' }]) {
      const r = await mkSched({ timing });
      assert.equal(r.status, 400, JSON.stringify(timing) + ' was stored');
      assert.equal(r.json.code, 'bad-timing');
    }
  });

  it('SCHED-1: an unattended run with an empty required field is refused, naming the field', async () => {
    const r = await mkSched({ values: {}, timing: { type: 'interval', minutes: 60 } });
    assert.equal(r.status, 400, 'a schedule with an empty required input was stored: ' + r.body);
    assert.equal(r.json.code, 'missing-required');
    assert.deepEqual(r.json.fields, ['thema']);
    const filled = await mkSched({ values: { thema: 'Sprint 17' }, timing: { type: 'interval', minutes: 60 } });
    assert.equal(filled.status, 200, filled.body);
  });

  it('SCHED-1: a skill with no manifest here is not guessed about — it is stored as before', async () => {
    const r = await req(S.port, 'POST', '/api/uiskill/schedules', { name: 'zz-not-installed', values: {}, enabled: true, timing: { type: 'interval', minutes: 60 } });
    assert.equal(r.status, 200, 'the guard invented a requirement it cannot know: ' + r.body);
  });

  it('SCHED-1: switching a schedule OFF is always allowed — otherwise the guard locks the door it opens', async () => {
    // exactly the state the old code could create: seven days a week, no required value
    const scheds = path.join(sb.dataDir, 'ui-skill-schedules.json');
    const list = JSON.parse(fs.readFileSync(scheds, 'utf8'));
    list.push({ id: 'zz-legacy', name: 'zz-guard-ui', title: 'Alt', values: {}, timing: { type: 'daily', time: '03:00', days: [] }, enabled: true, nextRun: Date.now() + 1000 });
    fs.writeFileSync(scheds, JSON.stringify(list));

    const off = await req(S.port, 'POST', '/api/uiskill/schedules', { id: 'zz-legacy', name: 'zz-guard-ui', values: {}, timing: { type: 'daily', time: '03:00', days: [] }, enabled: false });
    assert.equal(off.status, 200, 'a schedule stored before the guard could no longer be paused: ' + off.body);
    assert.equal(off.json.schedule.enabled, false);
    assert.equal(off.json.schedule.nextRun, null, 'a paused schedule must not keep a due date');

    // …but turning that same one back ON is refused, because that is the moment it would run
    const on = await req(S.port, 'POST', '/api/uiskill/schedules', { id: 'zz-legacy', name: 'zz-guard-ui', values: {}, timing: { type: 'daily', time: '03:00', days: [] }, enabled: true });
    assert.equal(on.status, 400);
  });
});
