'use strict';
// N12 — lib/reach.js and the three places that now go through it instead of a synchronous lookup:
// the claude-binary resolver (lib/paths), the MCP transport classifier (lib/mcp) and the headless engine's
// cwd (lib/engine). No network: a hang is an injected stat that never settles, or a `\\?\…` path (the local
// Win32 long form) under patched fs functions. Env BEFORE the requires — lib/paths and lib/reach read their
// seams at load time.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { makeSandbox } = require('./sandbox');

const SBX = makeSandbox('reach', { fakeCli: true });
Object.assign(process.env, SBX.env, { CLAUDE_UI_PATH_PROBE_MS: '150' });
after(() => SBX.cleanup());

const reach = require('../lib/reach');
const { resolveClaudeBin, resolveClaudeBinAsync } = require('../lib/paths');
const { parseMcpTarget, enrichMcp } = require('../lib/mcp');
const { runUiSkillHeadless } = require('../lib/engine');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a stat whose answers the test controls: `hang` paths never settle until released
function fakeStat(hang) {
  const calls = [];
  const pending = new Map();
  const stat = (p) => {
    calls.push(p);
    if (hang.some((h) => p.includes(h))) return new Promise((resolve, reject) => pending.set(p, { resolve, reject }));
    if (p.includes('missing')) { const e = new Error('ENOENT'); e.code = 'ENOENT'; return Promise.reject(e); }
    return Promise.resolve({ isFile: () => true });
  };
  return { stat, calls, pending };
}

describe('lib/reach — isNetworkPath / reachKey', () => {
  it('a network path in every spelling, and not the local device forms', () => {
    for (const p of ['\\\\192.0.2.1\\share', '//host/share/x', '\\/host/share', '\\\\?\\UNC\\host\\share', '//?/UNC/host/share', '  \\\\host\\s  ']) {
      assert.equal(reach.isNetworkPath(p), true, JSON.stringify(p));
    }
    for (const p of ['\\\\?\\C:\\Windows', '\\\\.\\pipe\\x', '//?/C:/x', 'C:\\Users', 'C:/a//b', '/usr/local', 'rel', '', null, undefined]) {
      assert.equal(reach.isNetworkPath(p), false, JSON.stringify(p));
    }
  });
  it('a dead answer is shared per HOST and per drive letter', () => {
    assert.equal(reach.reachKey('\\\\Srv\\a\\b'), reach.reachKey('//srv/c'));
    assert.equal(reach.reachKey('\\\\?\\UNC\\srv\\x'), 'net:srv');
    assert.equal(reach.reachKey('Z:\\a'), reach.reachKey('z:/b'));
    assert.equal(reach.reachKey('\\\\?\\Z:\\a'), 'drv:z');
    assert.notEqual(reach.reachKey('Z:\\a'), reach.reachKey('Y:\\a'));
  });
});

describe('lib/reach — createProber: deadline, one stat per host, negative memory', () => {
  it('answers ok / missing like a stat, and unreachable after its own deadline', async () => {
    const f = fakeStat(['dead']);
    const probe = reach.createProber({ stat: f.stat, timeoutMs: 60 });
    assert.equal((await probe('C:\\here')).state, 'ok');
    assert.deepEqual(await probe('C:\\missing'), { state: 'missing', code: 'ENOENT' });
    const t0 = Date.now();
    const r = await probe('\\\\192.0.2.1\\dead');
    assert.equal(r.state, 'unreachable');
    assert.equal(r.timeoutMs, 60);
    assert.ok(Date.now() - t0 < 1000, 'the deadline, not the OS');
    for (const junk of [null, undefined, 42, '', 'a\0b']) assert.equal((await probe(junk)).state, 'missing', JSON.stringify(junk));
  });

  it('a host that timed out is answered from memory — no second stat, also not for another share on it', async () => {
    let t = 1000;
    const f = fakeStat(['dead']);
    const probe = reach.createProber({ stat: f.stat, timeoutMs: 40, negativeMs: 60000, now: () => t });
    assert.equal((await probe('\\\\h1\\dead\\a')).state, 'unreachable');
    assert.equal(f.calls.length, 1);
    const again = await probe('\\\\h1\\dead\\a');
    assert.deepEqual([again.state, again.remembered], ['unreachable', true]);
    assert.equal((await probe('//h1/other/share')).remembered, true, 'same host, different share');
    assert.equal(f.calls.length, 1, 'every repeat would hold another of libuv\'s four threadpool threads');
    // while the first stat still hangs the memory holds even past negativeMs — a re-ask would add a thread
    t += 120000;
    assert.equal((await probe('\\\\h1\\dead\\a')).remembered, true);
    // it finally fails (a dead host ends in ENOENT, ~50 s late): remembered for negativeMs from then on
    f.pending.get('\\\\h1\\dead\\a').reject(Object.assign(new Error('x'), { code: 'ENOENT' }));
    await sleep(5);
    assert.equal((await probe('\\\\h1\\dead\\a')).remembered, true);
    t += 61000;
    await probe('\\\\h1\\dead\\a');
    assert.equal(f.calls.length, 2, 'after the memory runs out the host is asked again');
  });

  it('a host that answers late after all is no longer remembered as dead', async () => {
    const f = fakeStat(['slow']);
    const probe = reach.createProber({ stat: f.stat, timeoutMs: 30 });
    assert.equal((await probe('\\\\vpn\\slow')).state, 'unreachable');
    f.pending.get('\\\\vpn\\slow').resolve({ isFile: () => false });
    await sleep(5);
    assert.equal((await probe('\\\\vpn\\fast')).state, 'ok');
  });

  it('concurrent asks share the stat in flight — per path, and per host', async () => {
    const f = fakeStat(['dead']);
    const probe = reach.createProber({ stat: f.stat, timeoutMs: 50 });
    const rs = await Promise.all([probe('\\\\h2\\dead\\a'), probe('\\\\h2\\dead\\a'), probe('\\\\h2\\dead\\b')]);
    assert.deepEqual(rs.map((r) => r.state), ['unreachable', 'unreachable', 'unreachable']);
    assert.equal(f.calls.length, 1, 'three asks on one dead host = one thread');
  });

  it('firstUnreachable names the dead one and leaves a missing path to the caller', async () => {
    const f = fakeStat(['dead']);
    const probe = reach.createProber({ stat: f.stat, timeoutMs: 30 });
    assert.equal(await reach.firstUnreachable(['C:\\missing', 'C:\\ok', undefined, ''], probe), null);
    const d = await reach.firstUnreachable(['C:\\ok', '\\\\h3\\dead'], probe);
    assert.deepEqual(d, { path: '\\\\h3\\dead', timeoutMs: 30, remembered: false });
  });
});

describe('lib/paths — the configured claude binary is never looked at synchronously', () => {
  // patched on the module object, which is where isFileSync() looks statSync up
  function recordSync(fn) {
    const seen = [];
    const real = { statSync: fs.statSync, existsSync: fs.existsSync };
    fs.statSync = (p, ...a) => { seen.push(String(p)); return real.statSync(p, ...a); };
    fs.existsSync = (p) => { seen.push(String(p)); return real.existsSync(p); };
    try { return { out: fn(), seen }; } finally { Object.assign(fs, real); }
  }
  const DEAD = '\\\\?\\Q:\\ccui-n12\\claude.exe';

  it('env override: taken as named, exists = null („not asked"), no stat of it', () => {
    const { out, seen } = recordSync(() => resolveClaudeBin({ env: { CLAUDE_UI_CLAUDE_BIN: DEAD }, prefsFile: null, claudeJson: null }));
    assert.equal(out.path, DEAD);
    assert.equal(out.exists, null);
    assert.deepEqual(seen.filter((p) => p.includes('ccui-n12')), [], 'a statSync of a share binary held the boot for ~44 s');
  });

  it('ui-prefs override: the same', () => {
    const { out, seen } = recordSync(() => resolveClaudeBin({ env: { PATH: '' }, prefsFile: 'x', readJson: () => ({ claudeBin: DEAD }), claudeJson: null }));
    assert.equal(out.source, 'ui-prefs.json (claudeBin)');
    assert.equal(out.exists, null);
    assert.deepEqual(seen.filter((p) => p.includes('ccui-n12')), []);
  });

  it('resolveClaudeBinAsync walks the same order, awaiting async seams', async () => {
    const files = new Set(['c:\\bin\\claude.exe']);
    const r = await resolveClaudeBinAsync({
      platform: 'win32', home: 'C:\\Users\\k', env: { PATH: 'C:\\nope;C:\\bin' }, prefsFile: null, claudeJson: null,
      isFile: async (p) => { await sleep(1); return files.has(p.toLowerCase()); },
      readText: async () => '', listDir: async () => [], readJson: async () => null, npmPrefix: async () => '',
    });
    assert.deepEqual([r.path, r.source, r.exists], ['C:\\bin\\claude.exe', 'PATH', true]);
    const cfg = await resolveClaudeBinAsync({ env: { CLAUDE_UI_CLAUDE_BIN: DEAD }, prefsFile: null, claudeJson: null });
    assert.deepEqual([cfg.path, cfg.exists], [DEAD, false], 'the async form DOES ask, and answers');
  });
});

describe('lib/mcp — a network path in a transport is classified, not looked at', () => {
  function recordSync(fn) {
    const seen = [];
    const real = { statSync: fs.statSync, existsSync: fs.existsSync };
    fs.statSync = (p, ...a) => { seen.push(String(p)); return real.statSync(p, ...a); };
    fs.existsSync = (p) => { seen.push(String(p)); return real.existsSync(p); };
    return Promise.resolve().then(fn).then((out) => ({ out, seen })).finally(() => Object.assign(fs, real));
  }
  const net = (seen) => seen.filter((p) => p.includes('192.0.2.'));

  it('parseMcpTarget: //host/share → { kind: local, network: true }, and no sync lookup of it', async () => {
    const { out, seen } = await recordSync(() => parseMcpTarget('node //192.0.2.77/share/mcp/server.js --stdio'));
    assert.deepEqual(out, { kind: 'local', network: true });
    assert.deepEqual(net(seen), [], 'up to nine ~44 s freezes in a row with the git walk');
  });

  it('a LOCAL path next to it is still classified as before', async () => {
    const repo = path.join(__dirname, '..');
    const { out } = await recordSync(() => parseMcpTarget('node //192.0.2.78/share/x.js ' + path.join(repo, 'server.js').replace(/\\/g, '/')));
    assert.equal(out.kind, 'git');
  });

  it('enrichMcp says „Netzpfad, nicht geprüft" and pkgEntryMtime does not stat it', async () => {
    const { out, seen } = await recordSync(() => enrichMcp([{ name: 'x', transport: 'node //192.0.2.79/share/s.js' }]));
    assert.equal(out[0].update.status, 'Netzpfad, nicht geprüft');
    assert.equal(out[0].update.network, true);
    assert.deepEqual(net(seen), []);
  });
});

describe('lib/engine — a scheduled run in a cwd that does not answer', () => {
  it('ends as error with the reason, without reaching the spawn', async () => {
    const real = fsp.stat;
    fsp.stat = (p, ...a) => (String(p).includes('ccui-n12-hang') ? new Promise(() => {}) : real(p, ...a));
    try {
      const dead = '\\\\?\\Q:\\ccui-n12-hang\\repo';
      const rec = await runUiSkillHeadless({ name: 'x-ui', manifest: { title: 'X', run: { cwd: dead } } }, {}, {});
      assert.equal(rec.status, 'error');
      assert.match(String(rec.error), /not reachable \(no answer in \d+ s\)/, 'the old engine spawned into it: ' + rec.error);
      assert.ok(String(rec.error).includes(dead));
    } finally { fsp.stat = real; }
  });
});
