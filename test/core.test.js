'use strict';
// Unit tests for the pure helpers in lib/core.js (project encode/decode, title selection, frontmatter,
// model normalisation, cost estimate, env masking). Run: `node --test test/`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const core = require('../lib/core');
const ROOT = path.join(__dirname, '..');

test('encodeProject / decodeProject round-trip on a Windows path', () => {
  assert.equal(core.encodeProject('C:\\WINDOWS\\system32'), 'C--WINDOWS-system32');
  assert.equal(core.decodeProject('C--WINDOWS-system32'), 'C:\\WINDOWS\\system32');
  assert.equal(core.encodeProject(''), '');
});

test('extractText: string passthrough, block array join, else empty', () => {
  assert.equal(core.extractText('hello'), 'hello');
  assert.equal(core.extractText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(core.extractText(null), '');
  assert.equal(core.extractText({ foo: 1 }), '');
});

test('parseFrontmatter: keys with quotes stripped; no frontmatter → {}', () => {
  const fm = core.parseFrontmatter('---\nname: foo\ndescription: "bar baz"\n---\nbody');
  assert.equal(fm.name, 'foo');
  assert.equal(fm.description, 'bar baz');
  assert.deepEqual(core.parseFrontmatter('no frontmatter here'), {});
});

test('titleFrom: strips markdown markers, truncates, null when empty', () => {
  assert.equal(core.titleFrom({ summary: '# Hello World' }), 'Hello World');
  assert.equal(core.titleFrom({ preview: '- do the thing' }), 'do the thing');
  assert.equal(core.titleFrom({ summary: '   ' }), null);
  const long = core.titleFrom({ summary: 'x'.repeat(90) });
  assert.ok(long.length <= 64 && long.endsWith('…'), 'long title not truncated with ellipsis');
});

test('projBasename / isGenericCliName', () => {
  assert.equal(core.projBasename('C--WINDOWS-system32'), 'system32');
  assert.equal(core.isGenericCliName('system32-38', 'C--WINDOWS-system32'), true);
  assert.equal(core.isGenericCliName('system32-3a', 'C--WINDOWS-system32'), true);
  assert.equal(core.isGenericCliName('My real chat', 'C--WINDOWS-system32'), false);
  assert.equal(core.isGenericCliName('', 'C--WINDOWS-system32'), false);
});

test('chooseTitle priority: custom > meaningful CLI > content > generic CLI > id', () => {
  const proj = 'C--WINDOWS-system32';
  assert.deepEqual(core.chooseTitle({ id: 'a', project: proj }, { a: 'Pinned' }, { a: 'system32-9' }), { title: 'Pinned', custom: true });
  assert.deepEqual(core.chooseTitle({ id: 'a', project: proj }, {}, { a: 'Renamed nicely' }), { title: 'Renamed nicely', custom: true });
  assert.deepEqual(core.chooseTitle({ id: 'a', project: proj, summary: 'Fix the bug' }, {}, {}), { title: 'Fix the bug', custom: false });
  // generic CLI name is used but NOT marked custom, and only after content
  assert.deepEqual(core.chooseTitle({ id: 'a', project: proj }, {}, { a: 'system32-9' }), { title: 'system32-9', custom: false });
  assert.deepEqual(core.chooseTitle({ id: 'abcdef1234', project: proj }, {}, {}), { title: 'Session abcdef12', custom: false });
});

test('normalizeModel strips [1m] and date suffix', () => {
  assert.equal(core.normalizeModel('claude-opus-4-8[1m]'), 'claude-opus-4-8');
  assert.equal(core.normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(core.normalizeModel(''), '');
});

test('costParts / costOf against the PRICING table', () => {
  const opus = core.costParts({ input_tokens: 1e6, output_tokens: 1e6 }, 'claude-opus-4-8[1m]');
  assert.ok(Math.abs(opus.inCost - 5) < 1e-9 && Math.abs(opus.outCost - 25) < 1e-9);
  assert.ok(Math.abs(opus.total - 30) < 1e-9);
  const cr = core.costOf({ cache_read_input_tokens: 1e6 }, 'claude-opus-4-8'); // 1e6 * (5/1e6) * 0.1
  assert.ok(Math.abs(cr - 0.5) < 1e-9);
  assert.equal(core.costOf({ input_tokens: 1e6 }, 'totally-unknown-model'), 0);
  assert.equal(core.costOf(null, 'claude-opus-4-8'), 0);
});

test('maskEnvValue masks secret-like keys only', () => {
  assert.equal(core.maskEnvValue('MY_API_KEY', 'abcdef123456'), 'ab••••56');
  assert.equal(core.maskEnvValue('AUTH_TOKEN', 'xy'), '••••');
  assert.equal(core.maskEnvValue('NODE_ENV', 'production'), 'production');
});

// ---- F8: value-shape masking (a PAT behind a harmless key name must not slip through) ------------
test('valueLooksSecret: token shapes and auth prefixes, not paths/prose', () => {
  const s = core.valueLooksSecret;
  assert.equal(s('ghp_0123456789abcdefghijklmnopqrstuvwxyz'), true);
  assert.equal(s('github_pat_11ABCDEFG0abcdefghij_XYZ'), true);
  assert.equal(s('sk-ant-api03-abcdefghijklmnop'), true);
  assert.equal(s('xoxb-1234-5678-abcdefghijklm'), true);
  assert.equal(s('Bearer abc'), true);                                  // scheme prefix wins over length
  assert.equal(s('Basic dXNlcjpwYXNz'), true);
  assert.equal(s('https://user:hunter2@example.com/api'), true);        // userinfo in a URL
  assert.equal(s('Zm9vYmFyYmF6cXV1eGNvcmdlMTIzNDU2Nzg5MA=='), true);    // opaque base64, 20+ chars
  // NOT secrets: short values, prose, paths (the common long MCP env value), plain URLs
  assert.equal(s('production'), false);
  assert.equal(s('a very long human readable sentence'), false);        // spaces aren't token chars
  assert.equal(s('C:\\Users\\me\\venv\\Scripts\\python.exe'), false);
  assert.equal(s('/home/me/.local/share/uv/tools/ha-mcp'), false);
  assert.equal(s('https://jira.example.net/rest/api/2'), false);
  assert.equal(s(''), false);
});

test('maskInfo / maskSecrets: masked string stays, {masked,len} comes alongside', () => {
  const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
  const i = core.maskInfo('SOME_HEADER', secret);
  assert.equal(i.masked, true);
  assert.equal(i.len, secret.length);
  assert.match(i.value, /••••/);
  assert.ok(!i.value.includes(secret.slice(4)), 'masked value still carries the secret');
  const { values, meta } = core.maskSecrets({ TOKEN: secret, NODE_ENV: 'production' });
  assert.match(values.TOKEN, /••••/);
  assert.equal(values.NODE_ENV, 'production');
  assert.deepEqual(meta, { TOKEN: { masked: true, len: secret.length } }); // only masked keys get metadata
});

// ---- F9: unknown models are flagged, not silently priced at 0 -----------------------------------
test('costParts.priced flags an unknown model; costOf stays 0 for back-compat', () => {
  assert.equal(core.costParts({ input_tokens: 1e6 }, 'claude-opus-4-8').priced, true);
  assert.equal(core.costParts({ input_tokens: 1e6 }, 'totally-unknown-model').priced, false);
  assert.equal(core.costParts({ input_tokens: 1e6 }, 'totally-unknown-model').total, 0);
  assert.equal(core.costParts(null, 'claude-opus-4-8').priced, true); // model known, just no usage yet
});

// ---- F2/S2: the authoritative cwd comes from the transcript, not from the encoded dir name -------
test('decodeProject is only a display fallback: hyphenated paths do NOT round-trip', () => {
  // hyphen-free case (the one the old test asserted) still works
  assert.equal(core.decodeProject('C--WINDOWS-system32'), 'C:\\WINDOWS\\system32');
  // real dirs from ~/.claude/projects whose names contain hyphens: the encoding is LOSSY, so these
  // decode to paths that don't exist — which is exactly why lib/sessions reads `cwd` from the .jsonl.
  assert.equal(core.encodeProject('C:\\Users\\me\\claude-code-ui'), 'C--Users-me-claude-code-ui');
  assert.notEqual(core.decodeProject('C--Users-me-claude-code-ui'), 'C:\\Users\\me\\claude-code-ui');
  assert.equal(core.decodeProject('C--Users-me-claude-code-ui'), 'C:\\Users\\me\\claude\\code\\ui');
  assert.equal(core.encodeProject('C:\\Users\\me\\.claude\\scrum-master\\sync'), 'C--Users-me-.claude-scrum-master-sync');
  assert.notEqual(core.decodeProject('C--Users-me-.claude-scrum-master-sync'), 'C:\\Users\\me\\.claude\\scrum-master\\sync');
});

// ---- session-names.json / session-mcp.json are keyed by a REQUEST-SUPPLIED id ---------------------
// Those keys are property names the server writes, so the id has to be an id and nothing else
// (js/remote-property-injection, alerts #51/#52/#54/#55). The UUID shape is the allow-list.
test('isValidSessionId: accepts a real session UUID, rejects every prototype-ish key', () => {
  const uuid = require('crypto').randomUUID();
  assert.equal(core.isValidSessionId(uuid), true);
  assert.equal(core.isValidSessionId(uuid.toUpperCase()), true, 'ids are compared case-insensitively');
  assert.equal(core.isValidSessionId('123e4567-e89b-12d3-a456-426614174000'), true);
  // the keys that make a plain-object store dangerous
  for (const k of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty']) {
    assert.equal(core.isValidSessionId(k), false, k + ' must never become a store key');
  }
  // near-misses and junk
  assert.equal(core.isValidSessionId(uuid + '/../x'), false, 'anchored — no suffix may ride along');
  assert.equal(core.isValidSessionId('__proto__' + uuid), false);
  assert.equal(core.isValidSessionId(uuid.replace(/-/g, '')), false, 'the dashes are part of the shape');
  assert.equal(core.isValidSessionId('zzzzzzzz-e89b-12d3-a456-426614174000'), false, 'hex only');
  assert.equal(core.isValidSessionId(''), false);
  for (const v of [null, undefined, 0, 42, {}, [], { toString: () => '123e4567-e89b-12d3-a456-426614174000' }]) {
    assert.equal(core.isValidSessionId(v), false, 'non-strings are not ids');
  }
});

// ---- the cwd a caller may name on GET /api/diff / GET /api/files (CWE-200, alert #5) -------------
// What this gate does and does NOT promise is written down at resolveCwdParam() in lib/core.js.
test('resolveCwdParam: absent = the route default, absolute local = normalised, everything else refused', () => {
  const r = core.resolveCwdParam('C:\\Users\\me\\repo');
  assert.equal(r.dir, path.resolve('C:\\Users\\me\\repo'));
  assert.equal(r.error, undefined);
  assert.equal(core.resolveCwdParam('C:\\Users\\me\\repo\\sub\\..').dir, path.resolve('C:\\Users\\me\\repo'), 'normalised, so git and the walk see one spelling');
  assert.equal(core.resolveCwdParam('  C:\\Users\\me\\repo  ').dir, path.resolve('C:\\Users\\me\\repo'), 'trimmed — the composer field is typed by hand');
  // "nothing given" is not an error: the route then uses its own default (REPO_DIR / HOME), which is
  // configuration and not caller input.
  for (const v of [null, undefined, '', '   ']) assert.deepEqual(core.resolveCwdParam(v), { dir: null }, JSON.stringify(v));
  // the refusals, each with a reason the client can show
  for (const v of ['\\\\192.0.2.1\\share', '\\\\server\\share\\repo', '//server/share', '\\\\?\\C:\\Windows', '\\\\.\\pipe\\x']) {
    const bad = core.resolveCwdParam(v);
    assert.equal(bad.status, 400, v + ' must be refused');
    assert.match(bad.error, /local path/, v);
    assert.equal(bad.dir, undefined, 'a refusal must not also hand back a path');
  }
  for (const v of ['relative\\dir', 'repo', '.', '..', 'C:notabsolute']) {
    assert.equal(core.resolveCwdParam(v).status, 400, v + ' must be refused');
    assert.match(core.resolveCwdParam(v).error, /absolute/, v);
  }
  assert.match(core.resolveCwdParam('C:\\x\0\\y').error, /NUL/);
});

// ---- what of an exception a client may read (js/stack-trace-exposure, alert #45) ------------------
// The rule and the reason it is drawn THERE and not at sendJson live at errorText() in lib/core.js.
// These three tests check that it holds; the fourth checks that nobody answers the question twice.
test('errorText keeps the message and cuts a stack trace that rides INSIDE it', () => {
  // Measured, not invented: this is what execFile hands run() when the child dies on a throw —
  // `node -e 'throw new Error("boom from the CLI")'`, 2026-10-03, eight frames plus the version
  // banner. claude.exe and a crashing MCP server produce the same shape, and run()'s err.message is
  // what /api/doctor, /api/auth, /api/mcp and the CLI-version row put in front of the user.
  const real = 'Command failed: C:\\Program Files\\nodejs\\node.exe -e throw new Error("boom from the CLI")\n'
    + '[eval]:1\r\nthrow new Error("boom from the CLI")\r\n^\r\n\r\nError: boom from the CLI\r\n'
    + '    at [eval]:1:7\r\n    at runScriptInThisContext (node:internal/vm:219:10)\r\n'
    + '    at node:internal/process/execution:483:12\r\n    at node:internal/main/eval_string:71:3\r\n'
    + '\r\nNode.js v26.7.0\r\n';
  const out = core.errorText(new Error(real));
  assert.ok(out.startsWith('Command failed:'), 'the CLI\'s own words stay — often the only explanation there is');
  assert.ok(out.includes('Error: boom from the CLI'), 'including what the child itself reported');
  assert.ok(!/\n\s+at\s/.test(out), 'not one stack frame may leave the process');
  assert.ok(!out.includes('node:internal'), 'and nothing a frame carried with it');
  assert.ok(out.length < real.length, 'something was actually cut');
});

test('errorText leaves a single-line message untouched — paths included, deliberately', () => {
  // Every fs error is this shape, and the absolute path IS the answer to "why did it not work".
  const e = Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\Users\\me\\.claude\\settings.json'"), { code: 'ENOENT' });
  assert.equal(core.errorText(e), e.message);
  assert.ok(core.errorText(e).includes('C:\\Users\\me'), 'no path redaction here — see the rule for why');
});

test('errorText: same answer as the idiom it replaced for everything that is not an Error', () => {
  assert.equal(core.errorText('plain string'), 'plain string');
  assert.equal(core.errorText(null), '');
  assert.equal(core.errorText(undefined), '');
  assert.equal(core.errorText(new Error('')), 'Error', 'an empty message falls back to String(e), as before');
  assert.equal(core.errorText({ message: 'from a plain object' }), 'from a plain object');
  assert.equal(core.errorText(42), '42');
  assert.equal(core.errorText(new Error('one line')), 'one line');
});

test('no route builds its own exception text — errorText() is the single answer', () => {
  // Read as TEXT, like test/routes.test.js reads the route table: the defect this guards against is a
  // call site that quietly goes back to stringifying the exception itself, which is how 18 flows into
  // one response function came about in the first place.
  const files = ['server.js', ...fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).map((f) => 'lib/' + f)];
  const IDIOM = [
    /String\(\s*([A-Za-z_$][\w$.]*?)(?:\s*&&\s*\1)?\.message\s*\|\|\s*\1\s*\)/,
    /String\(\s*\(\s*([A-Za-z_$][\w$.]*?)\s*&&\s*\1\.message\s*\)\s*\|\|\s*\1\s*\)/,
  ];
  const hits = [];
  for (const f of files) {
    fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/).forEach((l, i) => {
      if (l.includes('console.error')) return; // a LOG is exactly where the frames are supposed to go
      if (IDIOM.some((re) => re.test(l))) hits.push(f + ':' + (i + 1));
    });
  }
  assert.deepEqual(hits, [], 'these stringify an exception themselves instead of calling errorText() — see the rule in lib/core.js');
});
