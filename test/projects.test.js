'use strict';
// P-1 — lib/projects.js (the stores, the locks, the measurements) and the four /api/projects routes, plus the two
// existing routes it touches (GET /api/sessions decorates, POST /api/session/delete forgets).
//
// What has to hold, and the defect each line guards against:
//   · a broken store is an ERROR — 500, and the file stays byte-identical. The usual `catch → []` plus an upsert
//     would have turned one bad byte into „every project and its instructions gone" (critic M3).
//   · ids are server-minted `p-xxxxxxxx`, unique; session keys are validated uuids, folded to lower case, read
//     into a prototype-less map — a body cannot name `__proto__` / `constructor` in either store.
//   · the lock order P → S: an assignment racing a delete must not land a label pointing at nothing.
//   · paths are measured only on save, only local ones, at most two at a time process-wide, each with a deadline;
//     GET touches no project path (critic M2).
//   · the start-path helpers (Stufe 2 wires them into /api/chat/start) keep their rules: fresh / fork / resume.
// Hermetic: two sandboxes (test/sandbox.js) — one for the in-process half (its env is set BEFORE lib/paths is
// loaded, which is where the store paths are fixed), one for the server the HTTP half boots; a third server
// runs with the API-token gate ON, because every other suite switches it off.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { makeSandbox } = require('./sandbox');

const ROOT = path.join(__dirname, '..');
const SBX = makeSandbox('projects-lib', { fakeCli: true });
Object.assign(process.env, SBX.env); // before the first require of lib/paths — the store paths are fixed there
const P = require('../lib/projects');
const { PROJECTS_FILE, SESSION_PROJECTS_FILE, BACKUP_DIR } = require('../lib/paths');
const { withFileLock } = require('../lib/core');
const { PROJECT_ERROR_CODES, PROJECT_ID_RE } = require('../public/js/projects-core');
after(() => SBX.cleanup());

const B = '\\';
const S1 = '11111111-1111-4111-8111-111111111111'; // the three fixture sessions (test/fixtures/projects)
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const SA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));
const raw = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const reset = () => { for (const f of [PROJECTS_FILE, SESSION_PROJECTS_FILE]) { try { fs.unlinkSync(f); } catch { /* none */ } } };
// the deps every in-process save uses unless a case says otherwise: no real disk lookups, a known main folder
const MAIN = 'C:' + B + 'WINDOWS' + B + 'system32';
const deps = (o) => Object.assign({ exists: async () => true, mainCwd: async () => MAIN, mcpNames: async () => ['jira', 'sap-adt'] }, o);
const create = async (o, d) => { const r = await P.upsertProject(Object.assign({ name: 'P' + crypto.randomBytes(3).toString('hex') }, o), deps(d)); assert.equal(r.status, 200, JSON.stringify(r)); return r.project; };
const projectFile = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p-' + String(i).padStart(8, '0'), name: 'Projekt ' + i, createdAt: 1, updatedAt: 1 }));

describe('lib/projects — upsert', () => {
  before(reset);

  it('create: a server-minted id, timestamps, the stored measurement — newest first in the file', async () => {
    const a = await create({ name: 'Demoprojekt', addDirs: ['C:' + B + 'repo'] });
    const b = await create({ name: 'Formularservice' });
    assert.match(a.id, PROJECT_ID_RE);
    assert.notEqual(a.id, b.id);
    assert.ok(a.createdAt > 0 && a.updatedAt === a.createdAt && a.checkedAt === a.createdAt);
    assert.deepEqual(a.warnings, []);
    const file = readJson(PROJECTS_FILE);
    assert.deepEqual(file.map((p) => p.name), ['Formularservice', 'Demoprojekt']);
    assert.deepEqual(Object.keys(file[1]), ['id', 'name', 'description', 'hue', 'cwd', 'addDirs', 'mcpServers', 'model', 'effort',
      'permissionMode', 'agent', 'instructions', 'archived', 'paths', 'hideInAll', 'jiraKeys', 'starters', 'memory', 'createdAt', 'updatedAt', 'warnings', 'checkedAt']);
  });

  it('update is a MERGE — an absent key keeps its value, createdAt stays, updatedAt moves', async () => {
    const p = await create({ name: 'Merge', instructions: 'bleibt', addDirs: ['C:' + B + 'x'] });
    const r = await P.upsertProject({ id: p.id, description: 'neu' }, deps({ now: () => p.createdAt + 1000 }));
    assert.equal(r.status, 200);
    assert.equal(r.created, false);
    assert.equal(r.project.instructions, 'bleibt');
    assert.deepEqual(r.project.addDirs, ['C:' + B + 'x']);
    assert.equal(r.project.description, 'neu');
    assert.equal(r.project.createdAt, p.createdAt);
    assert.equal(r.project.updatedAt, p.createdAt + 1000);
    const cleared = await P.upsertProject({ id: p.id, addDirs: [], instructions: '' }, deps());
    assert.deepEqual([cleared.project.addDirs, cleared.project.instructions], [[], '']);
  });

  it('the client never mints an id: unknown id → 404, malformed → 400 — nothing written', async () => {
    const before = raw(PROJECTS_FILE);
    const unknown = await P.upsertProject({ id: 'p-deadbeef', name: 'x' }, deps());
    assert.equal(unknown.status, 404);
    for (const id of ['__proto__', 'P-DEADBEEF', 'p-1', 7]) {
      const r = await P.upsertProject({ id, name: 'x' }, deps());
      assert.equal(r.status, 400, String(id));
      assert.deepEqual(r.errors, [{ field: 'id', code: 'invalid' }]);
    }
    assert.equal(raw(PROJECTS_FILE), before);
  });

  it('a refused save writes nothing and answers the token list (bypass, UNC cwd, instructions > 2000, NUL)', async () => {
    const before = raw(PROJECTS_FILE);
    const r = await P.upsertProject({ name: 'Böse', permissionMode: 'bypassPermissions', cwd: B + B + 'srv' + B + 'share',
      instructions: 'x'.repeat(2001), description: 'a\0b' }, deps());
    assert.equal(r.status, 400);
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors.map((e) => e.field + ':' + e.code).sort(),
      ['cwd:unc', 'description:nul', 'instructions:too-long', 'permissionMode:bypass-forbidden']);
    assert.equal(raw(PROJECTS_FILE), before);
  });

  it('names are unique without regard to case; the 101st project is refused', async () => {
    await create({ name: 'Einzigartig' });
    const dup = await P.upsertProject({ name: '  EINZIGARTIG ' }, deps());
    assert.deepEqual([dup.status, dup.errors], [400, [{ field: 'name', code: 'duplicate' }]]);
    reset();
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projectFile(100)));
    const full = await P.upsertProject({ name: 'Nummer 101' }, deps());
    assert.deepEqual([full.status, full.errors], [400, [{ field: 'projects', code: 'too-many', max: 100 }]]);
    // an UPDATE of an existing one is still fine at the cap
    const upd = await P.upsertProject({ id: 'p-00000007', description: 'geht' }, deps());
    assert.equal(upd.status, 200);
    reset();
  });

  it('a minted id that collides is drawn again — ids are unique', async () => {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projectFile(1)));   // holds p-00000000
    const draws = ['00000000', '00000000', 'abcdef01'];
    const r = await P.upsertProject({ name: 'Kollision' }, deps({ random: () => draws.shift() }));
    assert.equal(r.project.id, 'p-abcdef01');
    reset();
  });

  it('every error code lib/projects emits is a projects-core token (the editor labels exactly those)', async () => {
    const dd = await create({ name: 'Doppelt' });
    const out = [
      await P.upsertProject({ name: 'doppelt' }, deps()),
      await P.upsertProject({ id: 'p-deadbeef' }, deps()),
      await P.upsertProject({ id: 'x' }, deps()),
      await P.upsertProject('x', deps()),
      await P.upsertProject({ id: dd.id, baseUpdatedAt: dd.updatedAt - 1 }, deps()),
      await P.upsertProject({ id: dd.id, baseUpdatedAt: 'gestern' }, deps()),
      await P.deleteProject('p-deadbeef'),
      await P.assignSessions([SA], 'p-deadbeef'),
    ];
    for (const r of out) for (const e of r.errors) assert.ok(PROJECT_ERROR_CODES.includes(e.code), e.code);
    assert.ok(out.some((r) => r.errors.some((e) => e.code === 'conflict')), 'the conflict case did not run');
    reset();
  });

  it('lost update: a save on a version that is no longer the stored one is 409 WITH the stored record — nothing written', async () => {
    reset();
    const p = await create({ name: 'Zwei Fenster', instructions: 'erste Fassung' });
    // window B saves first …
    const b = await P.upsertProject({ id: p.id, baseUpdatedAt: p.updatedAt, instructions: 'aus Fenster B' }, deps());
    assert.equal(b.status, 200);
    assert.ok(b.project.updatedAt > p.updatedAt);
    // … window A still holds the version it opened
    const before = raw(PROJECTS_FILE);
    const a = await P.upsertProject({ id: p.id, baseUpdatedAt: p.updatedAt, description: 'aus Fenster A' }, deps());
    assert.deepEqual([a.status, a.error, a.errors], [409, 'conflict', [{ field: '', code: 'conflict' }]]);
    assert.equal(a.project.instructions, 'aus Fenster B', 'the answer must carry what is stored now');
    assert.equal(raw(PROJECTS_FILE), before, 'a conflicting save wrote');
    // „keep mine": only A's field, on B's version → both survive
    const mine = await P.upsertProject({ id: p.id, baseUpdatedAt: a.project.updatedAt, description: 'aus Fenster A' }, deps());
    assert.equal(mine.status, 200);
    assert.deepEqual([mine.project.instructions, mine.project.description], ['aus Fenster B', 'aus Fenster A']);
    // without a version it is the merge it always was (scripts, older clients)
    assert.equal((await P.upsertProject({ id: p.id, description: 'ohne Version' }, deps())).status, 200);
    assert.equal((await P.upsertProject({ id: p.id, baseUpdatedAt: 'gestern' }, deps())).status, 400);
  });

  it('lost update in a RACE: two saves on the same version measured side by side — the one that gets the lock second is 409', async () => {
    // Both pass the early check (phase 1 reads the same stored version), both measure their paths, and only the
    // check UNDER the lock can tell that the other one landed in between. Without it both answer 200 and the
    // second silently puts back what the first changed.
    reset();
    await P.slotsIdle();
    const p = await create({ name: 'Wettlauf', cwd: 'C:' + B + 'w', instructions: 'alt', description: 'alt' });
    const slow = async () => { await sleep(30); return true; };
    const [a, b] = await Promise.all([
      P.upsertProject({ id: p.id, baseUpdatedAt: p.updatedAt, description: 'aus A' }, deps({ exists: slow })),
      P.upsertProject({ id: p.id, baseUpdatedAt: p.updatedAt, instructions: 'aus B' }, deps({ exists: slow })),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], 'both saves landed: ' + JSON.stringify([a.status, b.status]));
    const won = a.status === 200 ? a : b, lost = a.status === 200 ? b : a;
    const stored = (await P.readProjects()).find((x) => x.id === p.id);
    assert.equal(stored.updatedAt, won.project.updatedAt, 'the stored record is the winner\'s');
    assert.equal(lost.project.updatedAt, won.project.updatedAt, 'the 409 carries the record that is stored now');
    reset();
  });

  it('the version moves with EVERY save of a record, even two in one millisecond', async () => {
    const p = await create({ name: 'Takt' }, { now: () => 5000 });
    const r1 = await P.upsertProject({ id: p.id, description: '1' }, deps({ now: () => 5000 }));
    const r2 = await P.upsertProject({ id: p.id, description: '2' }, deps({ now: () => 5000 }));
    assert.ok(p.updatedAt < r1.project.updatedAt && r1.project.updatedAt < r2.project.updatedAt,
      [p.updatedAt, r1.project.updatedAt, r2.project.updatedAt].join(' < '));
    assert.equal((await P.upsertProject({ id: p.id, baseUpdatedAt: r1.project.updatedAt, description: 'x' }, deps())).status, 409);
  });

  it('a root-relative cwd (`/Windows`) is refused on Windows, like `\\Windows`', { skip: process.platform !== 'win32' }, async () => {
    for (const cwd of ['/Windows', B + 'Windows']) {
      const r = await P.upsertProject({ name: 'Wurzel', cwd }, deps());
      assert.deepEqual([r.status, r.errors], [400, [{ field: 'cwd', code: 'relative' }]], cwd);
    }
  });

  it('the cap is a rule for CREATING — a file with more entries keeps all of them through a save (no silent cut)', async () => {
    reset();
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projectFile(105)));
    const upd = await P.upsertProject({ id: 'p-00000000', description: 'geändert' }, deps());
    assert.equal(upd.status, 200);
    const after = readJson(PROJECTS_FILE);
    assert.equal(after.length, 105, 'the save of ONE project dropped ' + (105 - after.length) + ' others');
    assert.ok(after.some((x) => x.id === 'p-00000104'));
    assert.equal((await P.upsertProject({ name: 'Nummer 106' }, deps())).status, 400, 'creating stays refused past the cap');
    await P.deleteProject('p-00000001');
    assert.equal(readJson(PROJECTS_FILE).length, 104, 'a delete removes exactly one');
    reset();
  });

  it('stored warnings: only the codes this module writes survive a read (a `constructor` would take the view down)', async () => {
    reset();
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify([{ id: 'p-0000000c', name: 'Hand', warnings: [
      { code: 'constructor', field: 'cwd' }, { code: 'toString' }, { code: '__proto__' }, { code: 'cwd-missing', field: 'cwd', value: 'C:' + B + 'x' }] }]));
    const [p] = await P.readProjects();
    assert.deepEqual(p.warnings, [{ code: 'cwd-missing', field: 'cwd', value: 'C:' + B + 'x' }]);
    reset();
  });
});

describe('lib/projects — the measurement on save (and only there)', () => {
  before(reset);

  it('warnings from the facts: missing cwd/addDir, unknown MCP name, own cwd ≠ main folder; stored with checkedAt', async () => {
    const cwd = 'C:' + B + 'repo', gone = 'C:' + B + 'gone';
    const p = await create({ cwd, addDirs: [gone, 'C:' + B + 'da'], mcpServers: ['jira', 'ghost'] },
      { exists: async (x) => x !== gone && x !== cwd });
    assert.deepEqual(p.warnings.map((w) => w.code).sort(), ['adddir-missing', 'cwd-custom', 'cwd-missing', 'mcp-unknown']);
    const stored = readJson(PROJECTS_FILE).find((x) => x.id === p.id);
    assert.deepEqual(stored.warnings, p.warnings, 'the warnings are STORED — GET reads them, it does not measure');
    assert.equal(stored.checkedAt, p.checkedAt);
    const same = await create({ cwd: 'c:/windows/System32' });
    assert.deepEqual(same.warnings, [], 'the main folder in another spelling is not an own cwd');
  });

  it('UNC additional directories are NEVER looked at — they are named as such instead', async () => {
    const asked = [];
    const unc = B + B + 'srv' + B + 'share';
    const p = await create({ addDirs: [unc, 'C:' + B + 'lokal'] }, { exists: async (x) => { asked.push(x); return true; } });
    assert.deepEqual(asked, ['C:' + B + 'lokal']);
    assert.deepEqual(p.warnings.map((w) => w.code + ':' + w.value), ['adddir-unc:' + unc]);
  });

  it('at most TWO lookups at a time — across two concurrent saves, too', async () => {
    let active = 0, peak = 0, calls = 0;
    const exists = async () => { calls++; active++; peak = Math.max(peak, active); await sleep(25); active--; return true; };
    const dirs = (t) => Array.from({ length: 8 }, (_, i) => 'C:' + B + t + i);
    await Promise.all([
      create({ cwd: 'C:' + B + 'a', addDirs: dirs('a') }, { exists }),
      create({ cwd: 'C:' + B + 'b', addDirs: dirs('b') }, { exists }),
    ]);
    assert.equal(calls, 18, 'every local path was checked');
    assert.equal(P.PATH_CHECK_SLOTS, 2);
    assert.equal(peak, 2, 'concurrent lookups: ' + peak);
  });

  it('a stalled lookup: the save answers at ONE deadline, says „unchecked", and starts no further lookups', async () => {
    await P.slotsIdle();
    let calls = 0, unstall;
    const stalled = new Promise((r) => { unstall = r; });
    const exists = () => { calls++; return stalled.then(() => true); }; // a dead drive: answers only when released
    const DL = 150;
    const t0 = Date.now();
    const p = await create({ cwd: 'C:' + B + 'tot', addDirs: Array.from({ length: 6 }, (_, i) => 'Z:' + B + 'd' + i) }, { exists, deadlineMs: DL });
    const took = Date.now() - t0;
    // not the stall (1200 ms), and not one deadline per remaining path either (≈ 4 × 150 ms with the 7 paths
    // queueing two by two): once a drive stalls, the rest of the save does not wait on it path by path
    assert.ok(took < DL * 2.5, 'the save waited ' + took + ' ms — more than one deadline (' + DL + ' ms)');
    assert.equal(calls, 2, 'after the first stall no new lookup may start (only the two already running)');
    assert.equal(p.warnings.filter((w) => w.code === 'path-unchecked').length, 7);
    assert.ok(!p.warnings.some((w) => w.code === 'cwd-missing' || w.code === 'adddir-missing'), 'an unmeasured path is not „missing"');
    // the two stalled lookups still hold their (process-wide) slots: end them, and wait until they are really
    // free — a fixed sleep for that was this suite's flaky test under load (the next case saw peak 0, not 2)
    unstall();
    await P.slotsIdle();
  });

  it('a lookup slot is held until the lookup REALLY ends, not just until its deadline', async () => {
    await P.slotsIdle();
    let release;
    const stall = new Promise((r) => { release = r; });
    let active = 0, peak = 0;
    const exists = async (x) => {
      active++; peak = Math.max(peak, active);
      try { if (x.startsWith('Y:')) await stall; else await sleep(5); return true; } finally { active--; }
    };
    // two stalls take both slots past their deadline …
    await Promise.all([create({ cwd: 'Y:' + B + 'a' }, { exists, deadlineMs: 20 }), create({ cwd: 'Y:' + B + 'b' }, { exists, deadlineMs: 20 })]);
    // … so a third save cannot start a lookup until they end: its own deadline passes with nothing started
    const third = await create({ cwd: 'C:' + B + 'c' }, { exists, deadlineMs: 30 });
    assert.ok(third.warnings.some((w) => w.code === 'path-unchecked'), JSON.stringify(third.warnings));
    assert.equal(peak, 2, 'a third lookup ran while two stalled ones still held the pool: ' + peak);
    release();
    await P.slotsIdle();
    const fourth = await create({ cwd: 'C:' + B + 'd' }, { exists, deadlineMs: 500 });
    assert.ok(!fourth.warnings.some((w) => w.code === 'path-unchecked'), 'the slots came back');
  });

  // J11 — the chat start measures through the same slots. Without the memory, every start on a dead drive parked one
  // more slot for the ~54 s its stat takes to fail, and after two of them a third start's LOCAL cwd went unmeasured.
  it('a place whose lookup timed out answers „unchecked" at once, without a slot, until that lookup ends (J11)', async () => {
    await P.slotsIdle();
    let release; const stall = new Promise((r) => { release = r; });
    const asked = [];
    const exists = async (x) => { asked.push(x); if (x.startsWith('Z:')) await stall; return true; };
    const sys = String(process.env.SystemDrive || 'C:').slice(0, 2);
    assert.deepEqual({ ...await P.checkPaths(['Z:' + B + 'repo1'], { exists, deadlineMs: 30 }) }, { ['Z:' + B + 'repo1']: 'unchecked' });
    const t0 = Date.now();
    const again = await P.checkPaths(['Z:' + B + 'repo2', sys + B + 'lokal'], { exists, deadlineMs: 2000 });
    assert.ok(Date.now() - t0 < 500, 'the second check waited on the dead drive again: ' + (Date.now() - t0) + ' ms');
    assert.deepEqual({ ...again }, { ['Z:' + B + 'repo2']: 'unchecked', [sys + B + 'lokal']: 'ok' }, 'the same DRIVE is not asked again, a local path still is');
    assert.deepEqual(asked, ['Z:' + B + 'repo1', sys + B + 'lokal']);
    release();
    await P.slotsIdle();
    assert.deepEqual({ ...await P.checkPaths(['Z:' + B + 'repo2'], { exists, deadlineMs: 500 }) }, { ['Z:' + B + 'repo2']: 'ok' }, 'once the lookup ended the drive is asked again');
  });

  it('on the system drive only the exact path that stalled is remembered — not the whole drive (J11)', async () => {
    await P.slotsIdle();
    const sys = String(process.env.SystemDrive || 'C:').slice(0, 2);
    let release; const stall = new Promise((r) => { release = r; });
    const exists = async (x) => { if (x.endsWith('junction')) await stall; return true; };
    await P.checkPaths([sys + B + 'junction'], { exists, deadlineMs: 30 });
    assert.deepEqual({ ...await P.checkPaths([sys + B + 'junction', sys + B + 'repo'], { exists, deadlineMs: 500 }) },
      { [sys + B + 'junction']: 'unchecked', [sys + B + 'repo']: 'ok' });
    release();
    await P.slotsIdle();
  });
});

describe('lib/projects — a broken store is an error, never an empty store (M3)', () => {
  const garbage = [
    ['not JSON', '{"id":"p-00000000", nope'],
    ['not a list', '{"projects":[]}'],
    ['an entry without an id', '[{"name":"x"}]'],
    ['an id of the wrong shape', '[{"id":"__proto__","name":"x"}]'],
    ['a duplicate id', '[{"id":"p-00000000","name":"a"},{"id":"p-00000000","name":"b"}]'],
  ];
  for (const [why, text] of garbage) {
    it('projects.json ' + why + ' → 500 store-corrupt, and the file stays byte-identical', async () => {
      reset();
      fs.writeFileSync(PROJECTS_FILE, text);
      for (const op of [() => P.upsertProject({ name: 'neu' }, deps()), () => P.readProjects(), () => P.listProjects([]),
        () => P.deleteProject('p-00000000'), () => P.assignSessions([SA], 'p-00000000')]) {
        await assert.rejects(op(), (e) => e.statusCode === 500 && e.code === 'store-corrupt' && /projects\.json .*left untouched/.test(e.message));
      }
      assert.equal(raw(PROJECTS_FILE), text);
    });
  }

  it('an EMPTY or missing projects.json is simply „no projects yet"', async () => {
    reset();
    assert.deepEqual(await P.readProjects(), []);
    fs.writeFileSync(PROJECTS_FILE, '');
    assert.deepEqual(await P.readProjects(), []);
    fs.writeFileSync(PROJECTS_FILE, '\uFEFF  \n');
    assert.deepEqual(await P.readProjects(), []);
    reset();
  });

  it('a broken session-projects.json: assign/delete/record refuse (500, nothing written); decorate and forget degrade', async () => {
    reset();
    const p = await create({ name: 'Bleibt' });
    const before = raw(PROJECTS_FILE);
    const text = '{"' + SA + '": "' + p.id + '",';
    fs.writeFileSync(SESSION_PROJECTS_FILE, text);
    for (const op of [() => P.assignSessions([SB], p.id), () => P.assignSessions([SB], ''), () => P.deleteProject(p.id),
      () => P.recordFreshStart(SB, p.id), () => P.listProjects([])]) {
      await assert.rejects(op(), (e) => e.statusCode === 500 && e.code === 'store-corrupt');
    }
    assert.equal(raw(SESSION_PROJECTS_FILE), text, 'the map was rewritten');
    assert.equal(raw(PROJECTS_FILE), before, 'the delete went ahead although the map could not be cleaned');
    // the session list must not die of it — the items come back without the field
    const items = await P.decorateSessions([{ id: SA }]);
    assert.deepEqual(items, [{ id: SA }]);
    // a session delete has already moved its transcript — forgetting must not fail it, and must not write
    const f = await P.forgetSession(SA);
    assert.equal(f.removed, false);
    assert.match(f.error, /session-projects\.json/);
    assert.equal(raw(SESSION_PROJECTS_FILE), text);
    // the start path resolves to „no project" and SAYS why, instead of blocking every chat start
    const rs = await P.resolveStart({ projectId: p.id }, null);
    assert.equal(rs.project, null);
    assert.match(rs.storeError, /session-projects\.json/);
    reset();
  });
});

describe('lib/projects — prototype-safe stores', () => {
  before(reset);

  it('the map reads into a prototype-less object: only <uuid> keys, folded to lower case, only p-…|"" values', async () => {
    const p = await create({ name: 'Proto' });
    fs.writeFileSync(SESSION_PROJECTS_FILE, '{"__proto__":"' + p.id + '","constructor":"' + p.id + '","'
      + SA.toUpperCase() + '":"' + p.id + '","' + SB + '":"","' + S1 + '":"not-a-project","' + S2 + '":5}');
    const map = await P.readSessionProjects();
    assert.equal(Object.getPrototypeOf(map), null);
    assert.deepEqual(Object.keys(map).sort(), [SA, SB]);
    assert.equal(map[SA], p.id);
    assert.equal(map.constructor, undefined, 'a prototype-less map has no inherited constructor to answer with');
    assert.equal(({}).polluted, undefined);
  });

  it('a body cannot name an object member as a session or a project', async () => {
    const before = raw(SESSION_PROJECTS_FILE);
    for (const ids of [['__proto__'], ['constructor'], [SA, 'toString']]) {
      const r = await P.assignSessions(ids, '');
      assert.deepEqual([r.status, r.error], [400, 'invalid session id'], JSON.stringify(ids));
    }
    for (const pid of ['__proto__', 'constructor', undefined, 5, 'P-00000000']) {
      assert.equal((await P.assignSessions([SA], pid)).status, 400, String(pid));
    }
    assert.deepEqual(await P.forgetSession('constructor'), { removed: false });
    assert.equal(await P.deleteProject('__proto__').then((r) => r.status), 400);
    assert.equal(raw(SESSION_PROJECTS_FILE), before);
  });

  it('a hand-edited projects.json cannot smuggle a bypass mode, a UNC cwd into a start, or a __proto__ key', async () => {
    reset();
    fs.writeFileSync(PROJECTS_FILE, '[{"id":"p-0000000a","name":"Hand","permissionMode":"bypassPermissions","__proto__":{"x":1},"extra":1,"cwd":"C:\\\\ok"}]');
    const [p] = await P.readProjects();
    assert.equal(p.permissionMode, '');
    assert.equal(p.extra, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(p, '__proto__'));
    assert.equal(p.cwd, 'C:' + B + 'ok');
    reset();
  });
});

describe('lib/projects — assign, forget, delete, decorate, list', () => {
  let X, Y;
  before(async () => { reset(); X = await create({ name: 'X' }); Y = await create({ name: 'Y' }); });

  it('assign: pid / "" (deliberately none) / null (forget) — ids folded to lower case, all-or-nothing', async () => {
    const r = await P.assignSessions([SA.toUpperCase(), SA, SB], X.id);
    assert.deepEqual([r.status, r.n, r.changed], [200, 2, 2]);
    assert.deepEqual(readJson(SESSION_PROJECTS_FILE), { [SA]: X.id, [SB]: X.id });
    assert.equal((await P.assignSessions([SB], '')).changed, 1);
    assert.equal(readJson(SESSION_PROJECTS_FILE)[SB], '', '"" is STORED — a refused suggestion must not come back');
    assert.equal((await P.assignSessions([SB], null)).changed, 1);
    assert.ok(!(SB in readJson(SESSION_PROJECTS_FILE)));
    assert.equal((await P.assignSessions([SA], X.id)).changed, 0, 'unchanged is not a write');
    const before = raw(SESSION_PROJECTS_FILE);
    assert.equal((await P.assignSessions([SB, 'nope'], X.id)).status, 400);
    assert.equal((await P.assignSessions([SB], 'p-deadbeef')).status, 404);
    assert.equal((await P.assignSessions(Array.from({ length: 501 }, () => SB), X.id)).status, 400);
    assert.equal((await P.assignSessions([], X.id)).status, 400);
    assert.equal(raw(SESSION_PROJECTS_FILE), before);
  });

  it('decorate: every item gets the STORED value only — p-… | "" | null, case-insensitive', async () => {
    await P.assignSessions([SB], '');
    const items = await P.decorateSessions([{ id: SA.toUpperCase() }, { id: SB }, { id: S3 }, null, { title: 'no id' }]);
    assert.deepEqual(items.map((i) => i && i.projectId), [X.id, '', null, null, undefined]);
    // P-2: the only derived field is the folder-rule label, and without a rule it is null for every item
    assert.deepEqual(Object.keys(items[0]).sort(), ['id', 'projectDerived', 'projectId'], 'nothing else derived is added');
    assert.deepEqual(items.map((i) => i && i.projectDerived), [null, null, null, null, undefined]);
  });

  it('list: stored records + sessionCount / lastActivity from the session scan handed in', async () => {
    const list = await P.listProjects([{ id: SA, mtime: 500 }, { id: SB, mtime: 900 }, { id: S1, mtime: 700 }]);
    const x = list.find((p) => p.id === X.id), y = list.find((p) => p.id === Y.id);
    assert.deepEqual([x.sessionCount, x.lastActivity], [1, 500]);
    assert.deepEqual([y.sessionCount, y.lastActivity], [0, null], 'the "" session counts for no project');
    assert.ok(!('sessionCount' in readJson(PROJECTS_FILE)[0]), 'the counts are never written');
  });

  it('forget: removes exactly that entry (any case), and does not write when there is none', async () => {
    assert.deepEqual(await P.forgetSession(SB.toUpperCase()), { removed: true });
    assert.ok(!(SB in readJson(SESSION_PROJECTS_FILE)));
    const before = fs.statSync(SESSION_PROJECTS_FILE).mtimeMs;
    await sleep(15);
    assert.deepEqual(await P.forgetSession(SB), { removed: false });
    assert.equal(fs.statSync(SESSION_PROJECTS_FILE).mtimeMs, before);
  });

  it('delete: HARD, its assignments go (to „never decided", not ""), the others stay, a backup is made', async () => {
    await P.assignSessions([SA, S1], X.id);
    await P.assignSessions([S2], Y.id);
    await P.assignSessions([S3], '');
    const r = await P.deleteProject(X.id);
    assert.deepEqual([r.status, r.unassigned], [200, 2]);
    assert.ok(r.backup && fs.existsSync(r.backup) && r.backup.startsWith(BACKUP_DIR), 'no backup of projects.json: ' + r.backup);
    assert.ok(JSON.parse(fs.readFileSync(r.backup, 'utf8')).some((p) => p.id === X.id), 'the backup holds the deleted definition');
    // …and the labels it removes: restoring the definition alone would bring the project back without its sessions
    assert.ok(r.backupMap && fs.existsSync(r.backupMap) && r.backupMap.startsWith(BACKUP_DIR), 'no backup of session-projects.json: ' + r.backupMap);
    assert.equal(JSON.parse(fs.readFileSync(r.backupMap, 'utf8'))[SA], X.id, 'the map backup holds the removed labels');
    assert.ok(!readJson(PROJECTS_FILE).some((p) => p.id === X.id));
    assert.deepEqual(readJson(SESSION_PROJECTS_FILE), { [S2]: Y.id, [S3]: '' });
    assert.equal((await P.deleteProject(X.id)).status, 404);
    const quiet = await create({ name: 'Ohne Sitzungen' });
    assert.equal((await P.deleteProject(quiet.id)).backupMap, null, 'nothing removed from the map → no map backup');
  });

  it('list: assignedCount = every label in the map, a session WITHOUT a transcript included (the delete dialog says it)', async () => {
    const W = await create({ name: 'W' });
    await P.assignSessions([SA, SB], W.id);
    const w = (await P.listProjects([{ id: SA, mtime: 1 }])).find((p) => p.id === W.id); // SB has no transcript yet
    assert.deepEqual([w.sessionCount, w.assignedCount], [1, 2]);
    assert.equal((await P.deleteProject(W.id)).unassigned, w.assignedCount, 'the number the dialog shows is the number the delete removes');
  });

  it('lock order, the discriminating case: an assignment WAITS while someone holds P alone (S alone would let it through)', async () => {
    const Q = await create({ name: 'Q' });
    let release;
    const held = withFileLock(PROJECTS_FILE, () => new Promise((r) => { release = r; })); // a future writer under P only
    await tick();
    const before = raw(SESSION_PROJECTS_FILE);
    let done = false;
    const asg = P.assignSessions([SA], Q.id).then((r) => { done = true; return r; });
    for (let i = 0; i < 10; i++) await tick();
    await sleep(20);
    assert.equal(done, false, 'the assignment finished while P was held — it took S alone');
    assert.equal(raw(SESSION_PROJECTS_FILE), before, 'the map was written while P was held');
    release(); await held;
    assert.equal((await asg).status, 200);
    assert.equal(readJson(SESSION_PROJECTS_FILE)[SA], Q.id);
  });

  it('lock order P → S: an assignment racing a delete of the same project cannot land a dangling label', async () => {
    const Z = await create({ name: 'Z' });
    await P.assignSessions([S1], Z.id);
    let release;
    const held = withFileLock(SESSION_PROJECTS_FILE, () => new Promise((r) => { release = r; })); // someone holds S
    await tick();
    const del = P.deleteProject(Z.id);           // takes P, then waits for S
    await tick(); await tick();
    const asg = P.assignSessions([SA], Z.id);    // queued behind the delete (the case after this one tells P from S)
    await tick(); await tick();
    release(); await held;
    const [d, a] = await Promise.all([del, asg]);
    assert.equal(d.status, 200);
    assert.equal(a.status, 404, 'the assignment saw the project although it was being deleted — the result, whichever lock ordered it: ' + JSON.stringify(a));
    const map = readJson(SESSION_PROJECTS_FILE);
    assert.ok(!Object.values(map).includes(Z.id), 'a label points at a deleted project: ' + JSON.stringify(map));
  });
});

describe('lib/projects — the start path (Stufe 2)', () => {
  let X, ARCH;
  before(async () => { reset(); X = await create({ name: 'Start' }); ARCH = await create({ name: 'Archiv', archived: true }); });
  const map = () => ({ [SA]: X.id, [SB]: '' });
  const list = () => [X, ARCH];
  const r = (body, resume) => { const o = P.resolveStartFrom(body, resume, map(), list()); return [o.pid, o.project && o.project.id, o.error]; };

  it('fresh start: body.projectId decides; "" is a decision; absent is nothing; an unknown one is an error (J1)', () => {
    assert.deepEqual(r({ projectId: X.id }, null), [X.id, X.id, null]);
    assert.deepEqual(r({ projectId: '' }, null), ['', null, null]);
    assert.deepEqual(r({}, null), [null, null, null]);
    assert.deepEqual(r({ projectId: null }, null), [null, null, null]);
    assert.deepEqual(r({ projectId: 'p-deadbeef' }, null), [null, null, 'unknown project'], 'the tab believes it starts with that project — a 400, not a start without it');
    assert.equal(P.resolveStartFrom({ projectId: 'p-deadbeef' }, null, map(), list()).code, 'project-unknown');
    assert.equal(P.resolveStartFrom({ projectId: 5 }, null, map(), list()).code, 'project-invalid');
    assert.deepEqual(r({ projectId: ARCH.id }, null), [ARCH.id, ARCH.id, null], 'archived hides, it does not disarm');
    for (const bad of ['__proto__', 5, 'X']) assert.equal(r({ projectId: bad }, null)[2], 'invalid projectId', String(bad));
  });

  it('fork: inherits the SOURCE\'s entry unless the body says otherwise', () => {
    assert.deepEqual(r({ fork: true }, SA), [X.id, X.id, null]);
    assert.deepEqual(r({ fork: true }, SA.toUpperCase()), [X.id, X.id, null], 'the resume id is folded like the keys');
    assert.deepEqual(r({ fork: true }, SB), ['', null, null], 'a deliberate „none" is inherited too');
    assert.deepEqual(r({ fork: true, projectId: '' }, SA), ['', null, null]);
    assert.deepEqual(r({ fork: true }, S3), [null, null, null]);
    assert.deepEqual(r({ fork: true, projectId: 'p-deadbeef' }, SA), [null, null, 'unknown project'], 'a pid the body names must exist');
    for (const fork of [true, false]) {
      const o = P.resolveStartFrom({ fork }, S1, { [S1]: 'p-deadbeef' }, list());
      assert.deepEqual([o.pid, o.project, o.error], [null, null, null], 'an INHERITED unknown pid resolves to nothing — the session stays resumable (fork ' + fork + ')');
    }
  });

  it('plain resume: only the map — body.projectId is ignored (a change goes through assign)', () => {
    assert.deepEqual(r({ projectId: ARCH.id }, SA), [X.id, X.id, null]);
    assert.deepEqual(r({ projectId: X.id }, S3), [null, null, null]);
  });

  it('recordFreshStart: writes pid and "" under the known id; null is nothing; a vanished project is not recorded', async () => {
    assert.deepEqual(await P.recordFreshStart(SA, X.id), { recorded: true });
    assert.deepEqual(await P.recordFreshStart(SB, ''), { recorded: true });
    assert.deepEqual(await P.recordFreshStart(S1, null), { recorded: false });
    assert.deepEqual(await P.recordFreshStart(S2, 'p-deadbeef'), { recorded: false });
    assert.deepEqual(await P.recordFreshStart('nope', X.id), { recorded: false });
    assert.deepEqual(readJson(SESSION_PROJECTS_FILE), { [SA]: X.id, [SB]: '' });
  });

  it('sessionIdHook: only for a NEW id, never over an existing entry; null when there is nothing to record', async () => {
    assert.equal(P.sessionIdHook({ pid: null }), null);
    assert.equal(P.sessionIdHook({ pid: 'junk' }), null);
    const h = P.sessionIdHook({ pid: X.id, resume: S1, sessionId: S1 });
    assert.deepEqual(await h(S1.toUpperCase()), { recorded: false }, 'the fork SOURCE keeps its own entry');
    assert.deepEqual(await h(S2), { recorded: true }, 'the fork\'s new id gets the project');
    assert.deepEqual(await h('not-an-id'), { recorded: false });
    await P.assignSessions([S3], '');
    assert.deepEqual(await h(S3), { recorded: false }, 'an assignment made meanwhile wins');
    assert.equal(readJson(SESSION_PROJECTS_FILE)[S2], X.id);
    assert.equal(readJson(SESSION_PROJECTS_FILE)[S3], '');
    const fresh = P.sessionIdHook({ pid: '', sessionId: SA });
    assert.deepEqual(await fresh(SA), { recorded: false }, 'recordFreshStart already wrote the fresh id');
    await P.deleteProject(X.id);
    const late = P.sessionIdHook({ pid: X.id, sessionId: SA });
    assert.deepEqual(await late(SB.replace(/b/g, 'c')), { recorded: false }, 'no label for a project deleted meanwhile');
  });
});

// P2 (07.10.) — „Projektwissen": memory files by name, in the memory folder of the project's effective cwd. Staged in
// the sandbox's ~/.claude/projects: a folder without a transcript counts by its encoded name (lib/core encodeProject).
describe('lib/projects — P2 project knowledge (memory)', () => {
  const { PROJECTS_DIR } = require('../lib/paths');
  const CWD = 'C:' + B + 'p2' + B + 'wissen';
  const MEMDIR = path.join(PROJECTS_DIR, 'C--p2-wissen', 'memory');
  before(() => {
    reset();
    fs.mkdirSync(MEMDIR, { recursive: true });
    fs.writeFileSync(path.join(MEMDIR, 'demoprojekt.md'), '---\nname: Demoprojekt ACME-3269\ndescription: Objekte, Datenmodell, Statusfluss\nmetadata:\n  type: project\n---\nText');
    fs.writeFileSync(path.join(MEMDIR, 'weg.md'), '---\ndescription: wird gelöscht\n---\n');
  });

  it('a NEW name that does not exist is refused (400 unknown, nothing written); existing ones are stored without a word', async () => {
    const r = await P.upsertProject({ name: 'Wissen', cwd: CWD, memory: ['demoprojekt.md', 'tippfehler.md'] }, deps());
    assert.equal(r.status, 400);
    assert.deepEqual(r.errors, [{ field: 'memory', code: 'unknown', value: 'tippfehler.md' }]);
    assert.equal(raw(PROJECTS_FILE), null, 'a refused save wrote the store');
    const ok = await create({ name: 'Wissen', cwd: CWD, memory: ['Demoprojekt.md', 'weg.md'] });
    assert.deepEqual(ok.memory, ['Demoprojekt.md', 'weg.md']);
    assert.equal(ok.warnings.filter((w) => w.code === 'memory-missing').length, 0);
  });

  it('a stored name whose file is gone is only a WARNING on the next save — and the start no longer names it', async () => {
    const p = (await P.readProjects()).find((x) => x.name === 'Wissen');
    const refs = await P.memoryRefs(p);
    assert.deepEqual(refs.map((x) => path.basename(x.path)).sort(), ['demoprojekt.md', 'weg.md'], 'the file name as on disk, the case folded');
    assert.ok(refs.every((x) => path.isAbsolute(x.path)));
    assert.equal(refs.find((x) => /demoprojekt/.test(x.path)).description, 'Objekte, Datenmodell, Statusfluss');
    fs.unlinkSync(path.join(MEMDIR, 'weg.md'));
    const r = await P.upsertProject({ id: p.id, description: 'neu' }, deps());
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.deepEqual(r.project.warnings.filter((w) => w.code === 'memory-missing'), [{ code: 'memory-missing', field: 'memory', value: 'weg.md' }]);
    assert.deepEqual((await P.memoryRefs(r.project)).map((x) => path.basename(x.path)), ['demoprojekt.md'], 'a deleted file is named at the start');
    const info = await P.memoryInfo(r.project);
    assert.equal(info.project, 'C--p2-wissen', 'the folder the memory view opens it by');
    assert.deepEqual(info.files.map((f) => [f.name, f.title, f.type, f.exists]), [['demoprojekt.md', 'Demoprojekt ACME-3269', 'project', true], ['weg.md', 'weg', '', false]]);
    assert.ok(info.files.every((f) => !('path' in f)), 'no absolute path goes to the browser');
  });

  it('without an own cwd the main folder decides (deps.defaultCwd); an unknown folder knows no file', async () => {
    const d = deps({ defaultCwd: async () => CWD });
    const r = await P.upsertProject({ name: 'Ohne cwd', memory: ['demoprojekt.md'] }, d);
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal((await P.memoryRefs(r.project, d)).length, 1);
    assert.deepEqual(await P.memoryRefs(r.project, deps({ defaultCwd: async () => 'C:' + B + 'nirgends' })), []);
  });
});

describe('repo hygiene', () => {
  it('both stores are git-ignored — an untracked store in the checkout blocks the Update button (409 dirty-main)', () => {
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
    for (const f of [PROJECTS_FILE, SESSION_PROJECTS_FILE]) assert.ok(gi.includes(path.basename(f)), path.basename(f));
  });
});

// ---------------------------------------------------------------------------------------------------- HTTP
function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function req(port, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const h = Object.assign({}, headers || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = data.length; }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* text */ } resolve({ status: res.statusCode, body: d, json }); });
    });
    r.setTimeout(20000, () => r.destroy(new Error('no answer: ' + method + ' ' + p)));
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function boot(sbx, extraEnv, token) {
  const port = await freePort();
  const env = { ...process.env, ...sbx.env, CLAUDE_UI_PORT: String(port), ...(extraEnv || {}) };
  if (token) { delete env.CLAUDE_UI_NO_API_TOKEN; env.CLAUDE_UI_API_TOKEN = token; }
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  const stop = () => new Promise((r) => { if (child.exitCode != null) return r(); child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); });
  const t0 = Date.now();
  for (;;) {
    try { const r = await req(port, 'GET', '/api/state', null, token ? { 'X-CCUI-Token': token } : {}); if (r.status === 200) break; } catch { /* not up */ }
    if (Date.now() - t0 > 15000) { await stop(); throw new Error('server did not come up\n' + log); }
    await sleep(150);
  }
  return { port, log: () => log, stop };
}

describe('HTTP — the /api/projects routes, /api/sessions and /api/session/delete (sandbox server)', () => {
  let S, sb, SP, PJ;
  const call = (m, p, b) => req(S.port, m, p, b);
  before(async () => {
    sb = makeSandbox('projects-http', { fakeCli: true });
    PJ = path.join(sb.dataDir, 'projects.json');
    SP = path.join(sb.dataDir, 'session-projects.json');
    S = await boot(sb);
  });
  after(async () => { if (S) await S.stop(); if (sb) sb.cleanup(); });
  let A;

  it('GET /api/projects with no store yet: an empty list', async () => {
    const r = await call('GET', '/api/projects');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { projects: [] });
  });

  it('POST /api/projects creates — and the route hands the CONFIGURED MCP names to the warning', async () => {
    const r = await call('POST', '/api/projects', { project: { name: 'Demoprojekt', mcpServers: ['ghost'], addDirs: ['C:' + B + 'nirgends-' + crypto.randomBytes(4).toString('hex')] } });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.status, undefined, 'the internal status does not leak into the body');
    A = r.json.project;
    assert.match(A.id, PROJECT_ID_RE);
    // the sandbox's ~/.claude.json has no MCP servers, so `ghost` is unknown; the addDir does not exist
    assert.deepEqual(A.warnings.map((w) => w.code).sort(), ['adddir-missing', 'mcp-unknown']);
  });

  it('POST /api/projects refuses with the token list — and writes nothing', async () => {
    const before = raw(PJ);
    const r = await call('POST', '/api/projects', { project: { name: 'X', permissionMode: 'bypassPermissions', cwd: '//srv/share', instructions: 'i'.repeat(2001) } });
    assert.equal(r.status, 400);
    assert.deepEqual(r.json.errors.map((e) => e.field + ':' + e.code).sort(), ['cwd:unc', 'instructions:too-long', 'permissionMode:bypass-forbidden']);
    for (const body of [{}, { project: null }, { project: [] }, { project: 'x' }, { name: 'top-level is not accepted' }]) {
      assert.equal((await call('POST', '/api/projects', body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await call('POST', '/api/projects', { project: { id: 'p-deadbeef', name: 'x' } })).status, 404);
    assert.equal(raw(PJ), before);
  });

  it('POST /api/projects reads a SMALL body: 25 000 relative paths are refused at the door, not validated for seconds', async () => {
    const before = raw(PJ);
    const big = { project: { name: 'Riesig', addDirs: Array.from({ length: 25000 }, (_, i) => 'rel' + i) } };
    let status = null;
    try { status = (await call('POST', '/api/projects', big)).status; } catch (e) { status = 'reset: ' + e.code; } // the reader cuts the socket
    assert.ok(status === 413 || /^reset/.test(String(status)), 'a 214 KB body was accepted: ' + status);
    assert.equal(raw(PJ), before);
    // a GET in parallel is not held up behind it any more — and the server still answers afterwards
    assert.equal((await call('GET', '/api/projects')).status, 200);
    // the largest legitimate record fits: 2000 characters of instructions, 8 long paths, 40 MCP names
    const max = { name: 'Groß', instructions: 'ä"\\'.repeat(667).slice(0, 2000), addDirs: Array.from({ length: 8 }, (_, i) => 'C:' + B + 'x'.repeat(250) + i),
      mcpServers: Array.from({ length: 40 }, (_, i) => 'server-' + i), description: 'd'.repeat(500) };
    const ok = await call('POST', '/api/projects', { project: max });
    assert.equal(ok.status, 200, ok.body);
    assert.equal((await call('POST', '/api/projects/delete', { id: ok.json.project.id })).status, 200);
  });

  it('POST /api/projects answers a stale version with 409 and the stored record (and no internal status)', async () => {
    const r = await call('POST', '/api/projects', { project: { id: A.id, baseUpdatedAt: A.updatedAt - 1, description: 'alt' } });
    assert.equal(r.status, 409, r.body);
    assert.equal(r.json.error, 'conflict');
    assert.deepEqual(r.json.errors, [{ field: '', code: 'conflict' }]);
    assert.equal(r.json.project.id, A.id);
    assert.equal(r.json.status, undefined);
  });

  it('assign → GET /api/sessions carries projectId (pid / "" / null); GET /api/projects counts', async () => {
    assert.equal((await call('POST', '/api/projects/assign', { sessionIds: [S1, S2.toUpperCase()], projectId: A.id })).status, 200);
    assert.equal((await call('POST', '/api/projects/assign', { sessionIds: [S3], projectId: '' })).status, 200);
    const s = await call('GET', '/api/sessions');
    assert.equal(s.status, 200);
    const by = Object.fromEntries(s.json.sessions.map((x) => [x.id, x]));
    assert.deepEqual([by[S1].projectId, by[S2].projectId, by[S3].projectId], [A.id, A.id, '']);
    const g = await call('GET', '/api/projects');
    const a = g.json.projects.find((p) => p.id === A.id);
    assert.equal(a.sessionCount, 2);
    assert.equal(a.lastActivity, Math.max(by[S1].mtime, by[S2].mtime));
    assert.deepEqual(a.warnings, A.warnings, 'GET returns the STORED measurement');
    assert.equal(a.checkedAt, A.checkedAt);
  });

  it('assign: a missing projectId key is a 400, not a silent „forget"; bad ids 400; unknown project 404', async () => {
    const before = raw(SP);
    assert.equal((await call('POST', '/api/projects/assign', { sessionIds: [S1] })).status, 400);
    assert.equal((await call('POST', '/api/projects/assign', { sessionIds: ['__proto__'], projectId: '' })).status, 400);
    assert.equal((await call('POST', '/api/projects/assign', { sessionIds: [S1], projectId: 'p-deadbeef' })).status, 404);
    assert.equal(raw(SP), before);
  });

  it('POST /api/session/delete forgets the session\'s project label (and leaves the others)', async () => {
    const r = await call('POST', '/api/session/delete', { id: S1, project: 'C--Users-dev-plain' });
    assert.equal(r.status, 200, r.body);
    const map = readJson(SP);
    assert.ok(!(S1 in map), 'the deleted session kept its label: ' + JSON.stringify(map));
    assert.equal(map[S2], A.id);
    assert.equal(map[S3], '');
  });

  it('a broken projects.json: GET and POST answer 500 store-corrupt, the file is untouched, /api/sessions lives', async () => {
    const good = raw(PJ);
    const bad = good.slice(0, Math.floor(good.length / 2));
    fs.writeFileSync(PJ, bad);
    const g = await call('GET', '/api/projects');
    assert.deepEqual([g.status, g.json.code], [500, 'store-corrupt']);
    assert.match(g.json.error, /projects\.json/);
    const p = await call('POST', '/api/projects', { project: { name: 'Neu' } });
    assert.deepEqual([p.status, p.json.code], [500, 'store-corrupt']);
    assert.equal((await call('POST', '/api/projects/delete', { id: A.id })).status, 500);
    assert.equal(raw(PJ), bad, 'a broken store was overwritten');
    assert.equal((await call('GET', '/api/sessions')).status, 200);
    fs.writeFileSync(PJ, good);
  });

  it('POST /api/projects/delete: 400 bad id, 404 unknown, 200 with the count of labels it removed', async () => {
    assert.equal((await call('POST', '/api/projects/delete', { id: '__proto__' })).status, 400);
    assert.equal((await call('POST', '/api/projects/delete', {})).status, 400);
    assert.equal((await call('POST', '/api/projects/delete', { id: 'p-deadbeef' })).status, 404);
    const r = await call('POST', '/api/projects/delete', { id: A.id });
    assert.deepEqual([r.status, r.json.unassigned], [200, 1]);
    assert.deepEqual(readJson(SP), { [S3]: '' });
    assert.deepEqual((await call('GET', '/api/projects')).json, { projects: [] });
  });
});

describe('HTTP — the routes sit behind the API-token gate (#87) like every /api/*', () => {
  let S, sb;
  const TOKEN = 'projects-test-' + crypto.randomBytes(8).toString('hex');
  before(async () => { sb = makeSandbox('projects-token', { fakeCli: true }); S = await boot(sb, null, TOKEN); });
  after(async () => { if (S) await S.stop(); if (sb) sb.cleanup(); });

  it('without the token every projects route is 401 and writes nothing; with it they answer', async () => {
    for (const [m, p, b] of [['GET', '/api/projects'], ['POST', '/api/projects', { project: { name: 'x' } }],
      ['POST', '/api/projects/delete', { id: 'p-00000000' }], ['POST', '/api/projects/assign', { sessionIds: [S1], projectId: '' }]]) {
      const r = await req(S.port, m, p, b);
      assert.equal(r.status, 401, m + ' ' + p);
    }
    assert.ok(!fs.existsSync(path.join(sb.dataDir, 'projects.json')) && !fs.existsSync(path.join(sb.dataDir, 'session-projects.json')));
    const h = { 'X-CCUI-Token': TOKEN };
    assert.equal((await req(S.port, 'GET', '/api/projects', null, h)).status, 200);
    assert.equal((await req(S.port, 'POST', '/api/projects', { project: { name: 'Mit Token' } }, h)).status, 200);
    assert.equal((await req(S.port, 'GET', '/api/projects?t=' + TOKEN)).status, 200, 'the ?t= form EventSource needs');
  });
});
