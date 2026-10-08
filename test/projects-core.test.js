'use strict';
// P-1 — public/js/projects-core.js, the pure half of „Projekte": the ONE set of rules the editor (Teil 2) and
// the server (lib/projects.js) both apply. What is pinned here, and why each matters:
//   · the file works in BOTH worlds (classic script with a shared global scope, and require) — a top-level name
//     another script also declares is a SyntaxError that takes the whole panel down, not just this feature
//   · the caps and the id shape (an id is a property name in two stores — `__proto__` must not be one)
//   · the client mistakes that are ANSWERED, not repaired: over-long text, over-full lists, a bypass mode,
//     a UNC/device cwd (it froze the panel ~31 s per spawn), NUL (spawn throws on it), relative paths
//   · the warnings are a pure derivation: no measurement in, no claim out
//   · the start values a tab receives — defensive, because they may come from a hand-edited file
//   · parity with the Node-side lists they restate (lib/chat.js PERM_MODES / EFFORT_LEVELS, lib/core.js
//     isUncOrDevicePath): a mode added there must be a red test here, not a silently unstorable choice
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PC = require('../public/js/projects-core');
const {
  PROJECT_CAPS, PROJECT_ID_RE, PROJECT_PERM_MODES, PROJECT_EFFORTS, PROJECT_FIELDS, PROJECT_START_KEYS,
  PROJECT_ERROR_CODES, PROJECT_WARNING_CODES,
  projectNormalize, projectValidate, projectWarnings, projectStartValues, projectIsUncOrDevice, projectIsAbsolute, projectPathKey,
} = PC;

const B = '\\';
const JS = path.join(__dirname, '..', 'public', 'js');
const codes = (r) => r.errors.map((e) => e.field + ':' + e.code).sort();
const ok = (o) => Object.assign({ name: 'Demoprojekt' }, o);

describe('projects-core — one file, two worlds', () => {
  const SRC = fs.readFileSync(path.join(JS, 'projects-core.js'), 'utf8');
  const topNames = (src) => [...src.matchAll(/^(?:function\s+([A-Za-z_$][\w$]*)|(?:var|let|const)\s+([A-Za-z_$][\w$]*))/gm)].map((m) => m[1] || m[2]);

  it('as a classic script (no `module`) its names land in the global scope', () => {
    const ctx = vm.createContext({});
    vm.runInContext(SRC, ctx);
    for (const n of ['PROJECT_CAPS', 'PROJECT_ID_RE', 'projectNormalize', 'projectValidate', 'projectWarnings', 'projectStartValues']) {
      assert.notEqual(vm.runInContext('typeof ' + n, ctx), 'undefined', n);
    }
    assert.equal(vm.runInContext('projectValidate({name:"x"}).ok', ctx), true);
  });

  it('none of its top-level names is declared by another script — classic scripts share ONE global scope', () => {
    const mine = new Set(topNames(SRC));
    assert.ok(mine.size >= 15, 'the declaration scan found ' + mine.size);
    const clash = [];
    let others = 0;
    for (const f of fs.readdirSync(JS).filter((x) => x.endsWith('.js') && x !== 'projects-core.js')) {
      for (const n of topNames(fs.readFileSync(path.join(JS, f), 'utf8'))) { others++; if (mine.has(n)) clash.push(f + ': ' + n); }
    }
    assert.ok(others > 500, 'the scan must actually have read the other scripts (' + others + ')');
    assert.deepEqual(clash, []);
  });

  it('index.html loads it before the scripts that will use it (render.js, chat.js)', () => {
    const html = fs.readFileSync(path.join(JS, '..', 'index.html'), 'utf8');
    const at = (f) => html.indexOf('/js/' + f + '"');
    assert.ok(at('projects-core.js') > 0, 'no <script> for projects-core.js');
    assert.ok(at('projects-core.js') < at('render.js') && at('projects-core.js') < at('chat.js'));
  });
});

describe('projects-core — caps, ids and the lists it restates', () => {
  it('the caps are the agreed ones', () => {
    assert.deepEqual(
      [PROJECT_CAPS.name, PROJECT_CAPS.description, PROJECT_CAPS.instructions, PROJECT_CAPS.addDirs, PROJECT_CAPS.mcpServers, PROJECT_CAPS.projects],
      [80, 500, 2000, 8, 40, 100]);
  });

  it('instructions cap = the guardrail section cap the spawn clamps at (so a stored text is never cut with „…")', () => {
    const { GUARDRAIL_CAPS } = require('../lib/pure');
    assert.equal(PROJECT_CAPS.instructions, GUARDRAIL_CAPS.section);
  });

  it('PROJECT_ID_RE: p- + 8 lower-case hex, nothing else — and no object member name can pass it', () => {
    for (const good of ['p-0123abcd', 'p-00000000', 'p-ffffffff']) assert.ok(PROJECT_ID_RE.test(good), good);
    for (const badId of ['__proto__', 'constructor', 'prototype', 'toString', 'p-0123ABCD', 'p-0123abc', 'p-0123abcde',
      'xp-0123abcd', 'p-0123abcd\n', ' p-0123abcd', 'p-0123abcg', '']) {
      assert.ok(!PROJECT_ID_RE.test(badId), JSON.stringify(badId));
    }
  });

  it('permission modes = lib/chat.js PERM_MODES minus bypassPermissions; efforts = EFFORT_LEVELS', () => {
    const { PERM_MODES, EFFORT_LEVELS } = require('../lib/chat');
    assert.deepEqual(PROJECT_PERM_MODES, PERM_MODES.filter((m) => m !== 'bypassPermissions'));
    assert.ok(PERM_MODES.includes('bypassPermissions'), 'premise: the mode this rule excludes still exists');
    assert.deepEqual(PROJECT_EFFORTS, EFFORT_LEVELS);
  });

  it('UNC/device rule = lib/core.js isUncOrDevicePath over one table', () => {
    const { isUncOrDevicePath } = require('../lib/core');
    const table = [B + B + 'srv' + B + 'share', '//srv/share', B + B + '?' + B + 'C:' + B + 'x', B + B + '.' + B + 'pipe' + B + 'x',
      '  ' + B + B + 'srv' + B + 'x', B + '/srv', 'C:' + B + 'x', 'c:/x', '/home/x', 'rel', '', B + 'x'];
    for (const p of table) assert.equal(projectIsUncOrDevice(p), isUncOrDevicePath(p), JSON.stringify(p));
  });
});

describe('projectNormalize — shape', () => {
  it('a full, valid record comes back complete, in field order, without the unknown keys', () => {
    const r = projectNormalize({
      name: '  Demoprojekt  ', description: ' d ', hue: 200, cwd: ' C:' + B + 'repo ', addDirs: ['C:' + B + 'a'], mcpServers: ['sap-adt'],
      model: 'eu.anthropic.claude-opus-5-5[1m]', effort: 'high', permissionMode: 'plan', agent: 'reviewer', instructions: ' x ',
      archived: true, foo: 1, id: 'p-0123abcd', createdAt: 5, warnings: [{ code: 'x' }],
    });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(Object.keys(r.project), PROJECT_FIELDS, 'only the editable fields, in the written order');
    assert.equal(r.project.name, 'Demoprojekt');
    assert.equal(r.project.cwd, 'C:' + B + 'repo');
    assert.equal(r.project.instructions, 'x');
    assert.equal(r.project.archived, true);
  });

  it('defaults: an empty-but-named record', () => {
    const r = projectNormalize({ name: 'x' });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.project, { name: 'x', description: '', hue: null, cwd: '', addDirs: [], mcpServers: null, model: '',
      effort: '', permissionMode: '', agent: '', instructions: '', archived: false, paths: [], hideInAll: false, jiraKeys: [], starters: [], memory: [] });
  });

  it('caps are ERRORS, not cuts — at the cap fine, one over refused (and the value kept as sent)', () => {
    const at = projectNormalize({ name: 'n'.repeat(80), description: 'd'.repeat(500), instructions: 'i'.repeat(2000),
      addDirs: Array.from({ length: 8 }, (_, i) => 'C:' + B + 'd' + i), mcpServers: Array.from({ length: 40 }, (_, i) => 'm' + i) });
    assert.deepEqual(at.errors, []);
    const over = projectNormalize({ name: 'n'.repeat(81), description: 'd'.repeat(501), instructions: 'i'.repeat(2001),
      addDirs: Array.from({ length: 9 }, (_, i) => 'C:' + B + 'd' + i), mcpServers: Array.from({ length: 41 }, (_, i) => 'm' + i),
      cwd: 'C:' + B + 'x'.repeat(260), model: 'm'.repeat(201), agent: 'a'.repeat(101) });
    assert.deepEqual(codes(over), ['addDirs:too-many', 'agent:too-long', 'cwd:too-long', 'description:too-long', 'instructions:too-long',
      'mcpServers:too-many', 'model:too-long', 'name:too-long'].sort());
    assert.equal(over.project.instructions.length, 2001, 'the over-long text is reported, not silently clamped');
    assert.equal(over.errors.find((e) => e.field === 'instructions').max, 2000);
  });

  it('a list far past its cap is refused AS A WHOLE, in linear time — one error, not one per entry', () => {
    // 25 000 relative paths in a 214 KB body used to answer 25 001 errors (1,36 MB) after seconds of a frozen
    // event loop: the de-duplication of the errors and of the MCP names scanned the list for every entry
    const N = 80000;
    const t0 = Date.now();
    const dirs = projectValidate(ok({ addDirs: Array.from({ length: N }, (_, i) => 'rel' + i) }));
    const mcp = projectValidate(ok({ mcpServers: Array.from({ length: N }, (_, i) => 'm' + i) }));
    const badMcp = projectValidate(ok({ mcpServers: Array.from({ length: N }, (_, i) => 'bad name ' + i) }));
    const took = Date.now() - t0;
    assert.deepEqual(dirs.errors, [{ field: 'addDirs', code: 'too-many', max: 8 }]);
    assert.deepEqual(mcp.errors, [{ field: 'mcpServers', code: 'too-many', max: 40 }]);
    assert.deepEqual(badMcp.errors, [{ field: 'mcpServers', code: 'too-many', max: 40 }]);
    // linear ≈ 0,5 s here; the quadratic version needed ~43 s for the addDirs case alone — a wide margin for a loaded CI
    assert.ok(took < 10000, 'three validations of ' + N + ' entries took ' + took + ' ms (was minutes)');
    // …but READ in full: a hand-edited file keeps what it holds (lib/projects.js writes the record back)
    assert.equal(projectNormalize(ok({ addDirs: Array.from({ length: 50 }, (_, i) => 'C:' + B + 'd' + i) })).project.addDirs.length, 50);
  });

  it('inside the scan bound every entry is still named — and the same error is said once', () => {
    const bound = PROJECT_CAPS.addDirs * PC.PROJECT_SCAN_FACTOR;
    const r = projectValidate(ok({ addDirs: Array.from({ length: bound }, (_, i) => 'rel' + i) }));
    assert.equal(r.errors.filter((e) => e.code === 'relative').length, bound, 'each relative entry with its value');
    assert.equal(r.errors.filter((e) => e.code === 'too-many').length, 1);
    assert.deepEqual(codes(projectNormalize(ok({ addDirs: [1, 2, 3, 'C:' + B + 'x'] }))), ['addDirs:type'], 'three non-strings are ONE type error');
    assert.equal(projectValidate(ok({ addDirs: Array.from({ length: bound + 1 }, (_, i) => 'rel' + i) })).errors.length, 1, 'one past the bound: the whole list, once');
  });

  it('past the scan bound the SHAPE pass names no entry either — a too-long path or a non-string is not said one by one', () => {
    // projectNormalize has its own bound: each too-long entry carries its whole value, so a list of them was the
    // same 1 MB answer by another door (and a hand-edited file is read through here on every GET)
    const bound = PROJECT_CAPS.addDirs * PC.PROJECT_SCAN_FACTOR;
    const long = Array.from({ length: bound + 1 }, (_, i) => 'C:' + B + 'x'.repeat(300) + i);
    assert.deepEqual(projectNormalize(ok({ addDirs: long })).errors, [{ field: 'addDirs', code: 'too-many', max: 8 }]);
    const mixed = Array.from({ length: bound + 1 }, (_, i) => (i % 2 ? i : 'C:' + B + 'd' + i));
    assert.deepEqual(projectNormalize(ok({ addDirs: mixed })).errors, [{ field: 'addDirs', code: 'too-many', max: 8 }]);
    // inside the bound both are still named
    assert.deepEqual(codes(projectNormalize(ok({ addDirs: long.slice(0, 2).concat([7]) }))), ['addDirs:too-long', 'addDirs:too-long', 'addDirs:type']);
  });

  it('types: a wrong type falls back to the default AND is reported', () => {
    const r = projectNormalize({ name: 5, description: {}, hue: '200', cwd: [], addDirs: 'C:' + B + 'x', mcpServers: 'all',
      effort: 3, permissionMode: true, archived: 'yes', model: 1, agent: null, instructions: ['x'] });
    assert.deepEqual(codes(r), ['addDirs:type', 'archived:type', 'cwd:type', 'description:type', 'effort:invalid', 'hue:invalid',
      'instructions:type', 'mcpServers:type', 'model:type', 'name:type', 'permissionMode:invalid'].sort());
    assert.equal(r.project.addDirs.length, 0);
    assert.equal(r.project.mcpServers, null);
    assert.equal(r.project.archived, false);
    for (const bad of [null, 'x', 3, ['a']]) assert.deepEqual(codes(projectNormalize(bad)), [':type', 'name:required'], JSON.stringify(bad));
  });

  it('name: required, one line (whitespace collapsed before the cap is measured)', () => {
    assert.deepEqual(codes(projectNormalize({})), ['name:required']);
    assert.deepEqual(codes(projectNormalize({ name: '   ' })), ['name:required']);
    const r = projectNormalize({ name: ' Zeile 1\n\n Zeile\t2 ' });
    assert.equal(r.project.name, 'Zeile 1 Zeile 2');
    assert.deepEqual(projectNormalize({ name: 'a' + ' '.repeat(100) + 'b' }).errors, [], '100 spaces are one space, not 100 characters');
  });

  it('bypassPermissions is not storable — its own code, and the record does not carry it', () => {
    const r = projectNormalize(ok({ permissionMode: 'bypassPermissions' }));
    assert.deepEqual(codes(r), ['permissionMode:bypass-forbidden']);
    assert.equal(r.project.permissionMode, '');
    for (const m of PROJECT_PERM_MODES) assert.deepEqual(projectNormalize(ok({ permissionMode: m })).errors, [], m);
    assert.deepEqual(codes(projectNormalize(ok({ permissionMode: 'yolo' }))), ['permissionMode:invalid']);
  });

  it('hue: integer 0–359 or null', () => {
    for (const h of [0, 200, 359, null, undefined]) assert.deepEqual(projectNormalize(ok({ hue: h })).errors, [], String(h));
    for (const h of [-1, 360, 1.5, NaN, Infinity]) assert.deepEqual(codes(projectNormalize(ok({ hue: h }))), ['hue:invalid'], String(h));
  });

  it('addDirs: trimmed, empties dropped, de-duplicated the way NTFS compares (case, / vs \\, trailing separator)', () => {
    const r = projectNormalize(ok({ addDirs: [' C:/Repo ', 'c:' + B + 'repo' + B, '', '  ', 'C:' + B + 'Other'] }));
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.project.addDirs, ['C:/Repo', 'C:' + B + 'Other']);
    assert.deepEqual(codes(projectNormalize(ok({ addDirs: ['C:' + B + 'x', 7] }))), ['addDirs:type']);
  });

  it('mcpServers: null = all, [] = none, names by the MCP shape — and never an object member name', () => {
    assert.equal(projectNormalize(ok({ mcpServers: null })).project.mcpServers, null);
    assert.deepEqual(projectNormalize(ok({ mcpServers: [] })).project.mcpServers, []);
    assert.deepEqual(projectNormalize(ok({ mcpServers: ['jira', 'jira', 'sap-adt'] })).project.mcpServers, ['jira', 'sap-adt']);
    for (const bad of ['__proto__', 'constructor', 'prototype', 'a b', '', 'x/y', 5]) {
      assert.deepEqual(codes(projectNormalize(ok({ mcpServers: [bad] }))), ['mcpServers:invalid'], JSON.stringify(bad));
    }
  });

  it('model / agent: one argv token each — no whitespace, no leading dash, agent no path separator', () => {
    assert.deepEqual(projectNormalize(ok({ model: 'eu.anthropic.claude-opus-5-5[1m]', agent: 'code-reviewer' })).errors, []);
    for (const m of ['-p', 'opus 4', 'a\tb']) assert.deepEqual(codes(projectNormalize(ok({ model: m }))), ['model:invalid'], m);
    for (const a of ['-x', 'a/b', 'a' + B + 'b']) assert.deepEqual(codes(projectNormalize(ok({ agent: a }))), ['agent:invalid'], a);
  });

  it('prototype keys in a parsed body neither retarget the prototype nor survive as fields', () => {
    const input = JSON.parse('{"__proto__":{"polluted":1,"name":"evil"},"constructor":{"x":1},"name":"real","hasOwnProperty":1}');
    const r = projectNormalize(input);
    assert.deepEqual(r.errors, []);
    assert.equal(r.project.name, 'real');
    assert.equal(Object.getPrototypeOf(r.project), Object.prototype);
    assert.ok(!Object.prototype.hasOwnProperty.call(r.project, '__proto__'));
    assert.equal(({}).polluted, undefined, 'Object.prototype was polluted');
    // an INHERITED field is not an own one — it is not read
    const inherited = Object.create({ name: 'from-prototype', permissionMode: 'bypassPermissions' });
    assert.deepEqual(codes(projectNormalize(inherited)), ['name:required']);
  });
});

describe('projectValidate — content of the strings', () => {
  it('NUL is refused in every string field (spawn throws on it — every chat of the project would 500)', () => {
    for (const f of ['name', 'description', 'cwd', 'model', 'agent', 'instructions']) {
      const o = ok({}); o[f] = (f === 'cwd' ? 'C:' + B + 'x' : 'x') + '\0y';
      const r = projectValidate(o);
      assert.equal(r.ok, false, f);
      assert.ok(r.errors.some((e) => e.field === f && e.code === 'nul'), f + ': ' + JSON.stringify(r.errors));
    }
    const d = projectValidate(ok({ addDirs: ['C:' + B + 'a\0b'] }));
    assert.ok(d.errors.some((e) => e.field === 'addDirs' && e.code === 'nul'));
    assert.deepEqual(codes(projectValidate(ok({ mcpServers: ['a\0'] }))), ['mcpServers:invalid']);
  });

  it('cwd: optional; a UNC or device path is refused (the spawn would hold the event loop ~31 s)', () => {
    assert.equal(projectValidate(ok({ cwd: '' })).ok, true);
    for (const c of [B + B + 'srv' + B + 'share', '//srv/share', B + B + '?' + B + 'C:' + B + 'x', B + B + '.' + B + 'pipe' + B + 'p']) {
      assert.deepEqual(codes(projectValidate(ok({ cwd: c }))), ['cwd:unc'], c);
    }
  });

  it('cwd: relative / drive-relative / root-relative is refused on Windows (it would resolve against the SERVER\'s cwd or drive)', () => {
    const WIN = { posix: false };
    // `/Windows` and `\Windows` are the SAME folder on the server's current drive — both refused, not only one
    for (const c of ['repo', 'C:repo', '.' + B + 'x', '..' + B + 'x', B + 'x', '/x', '/Windows', '/home/me']) {
      assert.deepEqual(codes(projectValidate(ok({ cwd: c }), WIN)), ['cwd:relative'], c);
    }
    for (const c of ['C:' + B + 'repo', 'c:/repo', 'D:' + B]) assert.equal(projectValidate(ok({ cwd: c }), WIN).ok, true, c);
    assert.deepEqual(codes(projectValidate(ok({ addDirs: ['/Windows'] }), WIN)), ['addDirs:relative'], 'an additional directory follows the same grammar');
    assert.equal(projectStartValues({ cwd: '/Windows', addDirs: ['/x', 'C:' + B + 'ok'] }, WIN).cwd, '', 'nor does a hand-edited one reach a tab');
    assert.deepEqual(projectStartValues({ addDirs: ['/x', 'C:' + B + 'ok'] }, WIN).addDirs, ['C:' + B + 'ok']);
  });

  it('cwd on a POSIX server: a single leading / is absolute, a drive path is not', () => {
    const PX = { posix: true };
    for (const c of ['/home/me', '/x']) assert.equal(projectValidate(ok({ cwd: c }), PX).ok, true, c);
    for (const c of ['C:' + B + 'repo', 'repo', B + 'x']) assert.deepEqual(codes(projectValidate(ok({ cwd: c }), PX)), ['cwd:relative'], c);
    assert.equal(projectStartValues({ cwd: '/home/me' }, PX).cwd, '/home/me');
  });

  it('without opts the grammar is this process\'s platform (the server half relies on that)', () => {
    assert.equal(PC.projectPosixDefault(), process.platform !== 'win32');
    assert.equal(projectIsAbsolute('/x'), process.platform !== 'win32');
    assert.equal(projectValidate(ok({ cwd: '/x' })).ok, process.platform !== 'win32');
  });

  it('addDirs: a share is ALLOWED (it only becomes an argv token) but carries a warning; relative is refused', () => {
    const unc = B + B + 'srv' + B + 'share';
    const r = projectValidate(ok({ addDirs: [unc, 'C:' + B + 'x'] }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.warnings.map((w) => w.code + ':' + w.value), ['adddir-unc:' + unc]);
    const rel = projectValidate(ok({ addDirs: ['sub' + B + 'dir'] }));
    assert.deepEqual(rel.errors, [{ field: 'addDirs', code: 'relative', value: 'sub' + B + 'dir' }]);
  });

  it('the shape errors come through, and every code is in the exported token set', () => {
    const r = projectValidate({ name: '', permissionMode: 'bypassPermissions', cwd: B + B + 'x' + B + 'y', instructions: 'i'.repeat(2001),
      addDirs: ['rel', 'C:' + B + 'a\0'], hue: 999, mcpServers: ['__proto__'] });
    assert.equal(r.ok, false);
    for (const e of r.errors) assert.ok(PROJECT_ERROR_CODES.includes(e.code), e.code);
    assert.deepEqual(codes(r), ['addDirs:nul', 'addDirs:relative', 'cwd:unc', 'hue:invalid', 'instructions:too-long', 'mcpServers:invalid',
      'name:required', 'permissionMode:bypass-forbidden'].sort());
  });

  it('path helpers: absolute and the comparison key', () => {
    assert.equal(projectIsAbsolute('C:' + B + 'x', false), true);
    assert.equal(projectIsAbsolute('/x', false), false, 'root-relative on Windows');
    assert.equal(projectIsAbsolute('/x', true), true);
    assert.equal(projectIsAbsolute('C:' + B + 'x', true), false);
    assert.equal(projectIsAbsolute('//x', true), false, 'that is UNC, not absolute-local');
    assert.equal(projectPathKey('C:/WINDOWS/System32/'), projectPathKey('c:' + B + 'windows' + B + 'system32'));
    assert.equal(projectPathKey('C:' + B), 'c:' + B, 'a drive root keeps its separator');
    assert.notEqual(projectPathKey('C:' + B + 'Atlas'), projectPathKey('C:' + B + 'Atlas2'));
  });
});

describe('projectWarnings — a pure derivation from measured facts', () => {
  const SYS32 = 'C:' + B + 'WINDOWS' + B + 'system32';
  const w = (p, ctx) => projectWarnings(projectValidate(ok(p)).project, ctx).map((x) => x.code + (x.value !== undefined ? ':' + [].concat(x.value).join(',') : ''));

  it('no measurement → no claim: without a pathState nothing is said about existence', () => {
    assert.deepEqual(w({ cwd: SYS32, addDirs: ['C:' + B + 'a'] }, { mainCwd: SYS32 }), []);
    assert.deepEqual(w({ mcpServers: ['ghost'] }, {}), [], 'no configured list → no mcp-unknown');
  });

  it('cwd-missing / adddir-missing / path-unchecked come only from the pathState', () => {
    const a = 'C:' + B + 'a', b = 'C:' + B + 'b', cwd = 'C:' + B + 'repo';
    assert.deepEqual(w({ cwd, addDirs: [a, b] }, { mainCwd: cwd, pathState: { [cwd]: 'missing', [a]: 'missing', [b]: 'ok' } }),
      ['cwd-missing:' + cwd, 'adddir-missing:' + a]);
    assert.deepEqual(w({ cwd, addDirs: [a] }, { mainCwd: cwd, pathState: { [cwd]: 'unchecked', [a]: 'unchecked' } }),
      ['path-unchecked:' + cwd, 'path-unchecked:' + a]);
  });

  it('cwd-custom: an own cwd that is not the main folder — compared the way NTFS compares; unknown main → said', () => {
    assert.deepEqual(w({ cwd: 'c:/windows/System32/' }, { mainCwd: SYS32 }), [], 'same folder, other spelling');
    assert.deepEqual(w({ cwd: 'C:' + B + 'repo' }, { mainCwd: SYS32 }), ['cwd-custom:C:' + B + 'repo']);
    assert.deepEqual(w({ cwd: 'C:' + B + 'repo' }, {}), ['cwd-custom:C:' + B + 'repo'], 'no main folder known → no „same folder" claim');
    assert.deepEqual(w({ cwd: '' }, {}), [], 'no own cwd → nothing');
  });

  it('mcp-unknown lists exactly the names the configured list does not have; [] and null say nothing', () => {
    assert.deepEqual(w({ mcpServers: ['jira', 'ghost', 'sap-adt', 'gone'] }, { mcpConfigured: ['jira', 'sap-adt'] }), ['mcp-unknown:ghost,gone']);
    assert.deepEqual(w({ mcpServers: [] }, { mcpConfigured: [] }), []);
    assert.deepEqual(w({ mcpServers: null }, { mcpConfigured: [] }), []);
  });

  it('perm-noask for the two modes that run tools without asking — and only those', () => {
    assert.deepEqual(w({ permissionMode: 'auto' }, {}), ['perm-noask:auto']);
    assert.deepEqual(w({ permissionMode: 'dontAsk' }, {}), ['perm-noask:dontAsk']);
    for (const m of ['', 'default', 'plan', 'acceptEdits', 'manual']) assert.deepEqual(w({ permissionMode: m }, {}), [], m);
  });

  it('every code it can emit is in the exported token set', () => {
    const all = projectWarnings({ cwd: 'C:' + B + 'x', addDirs: [B + B + 's' + B + 'h', 'C:' + B + 'm', 'C:' + B + 'u'], mcpServers: ['g'], permissionMode: 'auto', jiraKeys: ['PROJ-456'], memory: ['gone.md'] },
      { pathState: { ['C:' + B + 'x']: 'missing', ['C:' + B + 'm']: 'missing', ['C:' + B + 'u']: 'unchecked' }, mcpConfigured: [], memoryState: { 'gone.md': 'missing' } });
    const seen = new Set(all.map((x) => x.code));
    for (const c of seen) assert.ok(PROJECT_WARNING_CODES.includes(c), c);
    // …and the set holds nothing this function cannot say (a token nobody emits is a label nobody reads)
    assert.deepEqual([...seen].sort(), PROJECT_WARNING_CODES.slice().sort());
  });
});

describe('projectStartValues — what „Neuer Chat im Projekt" copies into the tab', () => {
  const full = { name: 'x', cwd: 'C:' + B + 'repo', addDirs: ['C:' + B + 'a', B + B + 's' + B + 'h'], mcpServers: ['jira'], model: 'opus[1m]',
    effort: 'high', permissionMode: 'acceptEdits', agent: 'rev', hue: 150, instructions: 'not a start value', description: 'neither' };

  it('the start keys, in order, and nothing else (instructions are the server\'s business, Stufe 2)', () => {
    const s = projectStartValues(full);
    assert.deepEqual(Object.keys(s), PROJECT_START_KEYS);
    assert.deepEqual(s, { cwd: 'C:' + B + 'repo', addDirs: ['C:' + B + 'a', B + B + 's' + B + 'h'], mcpServers: ['jira'], model: 'opus[1m]',
      effort: 'high', permissionMode: 'acceptEdits', agent: 'rev', hue: 150 });
  });

  it('resume: the session keeps its own cwd and its stored MCP selection — both keys ABSENT (decision 05.10.)', () => {
    const s = projectStartValues(full, { resume: true });
    assert.deepEqual(Object.keys(s), PROJECT_START_KEYS.filter((k) => k !== 'cwd' && k !== 'mcpServers'));
    assert.equal(s.agent, 'rev');
  });

  it('copies, never aliases — a tab that edits its list does not edit the project', () => {
    const s = projectStartValues(full);
    s.addDirs.push('C:' + B + 'z'); s.mcpServers.push('y');
    assert.equal(full.addDirs.length, 2);
    assert.deepEqual(full.mcpServers, ['jira']);
  });

  it('defensive against a hand-edited file: bypass, UNC/relative cwd, NUL, bad names never reach a tab', () => {
    const s = projectStartValues({ cwd: B + B + 'srv' + B + 'x', addDirs: ['rel', 'C:' + B + 'ok', 'C:' + B + 'n\0'], mcpServers: ['__proto__', 'a'],
      permissionMode: 'bypassPermissions', effort: 'turbo', model: '-p', agent: '../x', hue: 400 });
    assert.deepEqual(s, { cwd: '', addDirs: ['C:' + B + 'ok'], mcpServers: ['a'], model: '', effort: '', permissionMode: '', agent: '', hue: null });
    assert.equal(projectStartValues({ cwd: 'relative' }).cwd, '');
    assert.deepEqual(projectStartValues(null), { cwd: '', addDirs: [], mcpServers: null, model: '', effort: '', permissionMode: '', agent: '', hue: null });
  });

  it('the caps hold at this door too — lib/chat.js has no ceiling of its own for --add-dir', () => {
    const many = Array.from({ length: 12 }, (_, i) => 'C:' + B + 'd' + i);
    const s = projectStartValues({ addDirs: many, mcpServers: Array.from({ length: 50 }, (_, i) => 'm' + i) }, { posix: false });
    assert.deepEqual(s.addDirs, many.slice(0, 8));
    assert.equal(s.mcpServers.length, 40);
  });
});

describe('projectMcpReconcile — the project\'s MCP names against what is configured NOW (critic H3)', () => {
  const { projectMcpReconcile } = PC;
  it('keeps the configured names in the project\'s order and says which ones it dropped', () => {
    assert.deepEqual(projectMcpReconcile(['sap-adt', 'gone', 'jira'], ['jira', 'sap-adt', 'x']),
      { keep: ['sap-adt', 'jira'], removed: ['gone'], emptied: false });
  });
  it('emptied = the project named servers and NONE is left — the caller must ask, not start with zero servers', () => {
    assert.deepEqual(projectMcpReconcile(['gone', 'also-gone'], ['jira']), { keep: [], removed: ['gone', 'also-gone'], emptied: true });
  });
  it('null (all) and [] (deliberately none) pass through — neither is a list of names to check', () => {
    assert.deepEqual(projectMcpReconcile(null, ['jira']), { keep: null, removed: [], emptied: false });
    assert.deepEqual(projectMcpReconcile([], ['jira']), { keep: [], removed: [], emptied: false }, '[] is a choice, not an emptied list');
  });
  it('an unknown configuration claims nothing: everything kept, nothing removed', () => {
    assert.deepEqual(projectMcpReconcile(['a', 'b'], null), { keep: ['a', 'b'], removed: [], emptied: false });
  });
  it('copies, never aliases', () => {
    const names = ['jira'];
    const r = projectMcpReconcile(names, ['jira']);
    r.keep.push('x');
    assert.deepEqual(names, ['jira']);
  });
});

// P2 (07.10.) — start orders and project knowledge are two more fields of the record, and neither reaches a start value
describe('P2 — starters and memory: shape, caps, duplicates', () => {
  const errs = (o) => PC.projectNormalize(Object.assign({ name: 'X' }, o)).errors.map((e) => e.field + ':' + e.code + (e.value != null ? ':' + e.value : ''));
  it('starters: label one line, both halves required, blank rows dropped, the label unique regardless of case', () => {
    const n = PC.projectNormalize({ name: 'X', starters: [{ label: ' Review \n heute ', prompt: ' Bitte prüfen ' }, { label: '', prompt: '' }] });
    assert.deepEqual(n.errors, []);
    assert.deepEqual(n.project.starters, [{ label: 'Review heute', prompt: 'Bitte prüfen' }]);
    assert.deepEqual(errs({ starters: [{ label: 'A', prompt: '' }] }), ['starters:required:A']);
    assert.deepEqual(errs({ starters: [{ label: '', prompt: 'p' }] }), ['starters:required']);
    assert.deepEqual(errs({ starters: [{ label: 'Review', prompt: 'a' }, { label: 'REVIEW', prompt: 'b' }] }), ['starters:duplicate:REVIEW']);
    assert.deepEqual(errs({ starters: 'x' }), ['starters:type']);
    assert.deepEqual(errs({ starters: [{ label: 1, prompt: 'p' }] }), ['starters:type']);
  });
  it('starters: label ≤ 60, prompt ≤ 2000, at most 5 — refused, never cut', () => {
    assert.deepEqual(errs({ starters: [{ label: 'L'.repeat(61), prompt: 'p' }] }).map((x) => x.split(':').slice(0, 2).join(':')), ['starters:too-long']);
    assert.deepEqual(errs({ starters: [{ label: 'L', prompt: 'p'.repeat(2001) }] }), ['starters:too-long:L']);
    assert.deepEqual(errs({ starters: [{ label: 'L', prompt: 'p'.repeat(2000) }] }), []);
    const six = Array.from({ length: 6 }, (_, i) => ({ label: 'S' + i, prompt: 'p' }));
    assert.deepEqual(errs({ starters: six }), ['starters:too-many']);
    assert.deepEqual(errs({ starters: six.slice(0, 5) }), []);
    assert.equal(PC.projectNormalize({ name: 'X', starters: six }).project.starters.length, 6, 'an over-full list is kept as sent, and reported');
    assert.ok(PC.projectValidate({ name: 'X', starters: [{ label: 'A', prompt: 'p\0q' }] }).errors.some((e) => e.field === 'starters' && e.code === 'nul'));
  });
  it('memory: names only — no separator, no `..`, `.md`; ≤ 10; de-duplicated case-folded', () => {
    assert.deepEqual(PC.projectNormalize({ name: 'X', memory: ['Demoprojekt.md', 'demoprojekt.md', ' b_c-d 1.md '] }).project.memory, ['Demoprojekt.md', 'b_c-d 1.md']);
    for (const bad of ['..' + B + 'x.md', 'a/b.md', 'x.txt', '..md', 'a' + B + 'b.md']) assert.deepEqual(errs({ memory: [bad] }), ['memory:invalid:' + bad], bad);
    assert.deepEqual(errs({ memory: Array.from({ length: 11 }, (_, i) => 'm' + i + '.md') }), ['memory:too-many']);
  });
  it('neither reaches a start: projectStartValues knows no starters and no memory', () => {
    const sv = PC.projectStartValues({ name: 'X', starters: [{ label: 'A', prompt: 'p' }], memory: ['a.md'] });
    assert.equal('starters' in sv, false); assert.equal('memory' in sv, false);
    assert.equal(PC.PROJECT_START_KEYS.includes('starters') || PC.PROJECT_START_KEYS.includes('memory'), false);
  });
  it('memory-missing only for a name the save measured as gone', () => {
    const w = PC.projectWarnings({ memory: ['a.md', 'b.md', 'c.md'] }, { memoryState: { 'a.md': 'ok', 'b.md': 'missing' } });
    assert.deepEqual(w, [{ code: 'memory-missing', field: 'memory', value: 'b.md' }]);
  });
});
