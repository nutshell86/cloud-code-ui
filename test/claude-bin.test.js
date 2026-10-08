'use strict';
// Unit tests for resolveClaudeBin (lib/paths.js) — the detection order that decides which binary the
// whole panel drives. Everything it touches (fs, env, npm) is injected, so these run against a
// FIXTURE machine: no real install, no spawn, and the Windows cases are testable on any platform.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { resolveClaudeBin, defaultClaudeExe } = require('../lib/paths');

const WIN_HOME = 'C:\\Users\\kollege';
const NPM_DIR = 'C:\\Users\\kollege\\AppData\\Roaming\\npm';
const NPM_EXE = path.join(NPM_DIR, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');

// a fixture machine: `files` = the set of existing files, everything else is absent
function machine(files, extra) {
  const set = new Set((files || []).map((f) => f.toLowerCase()));
  return Object.assign({
    platform: 'win32',
    home: WIN_HOME,
    env: { APPDATA: path.join(WIN_HOME, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(WIN_HOME, 'AppData', 'Local'), PATH: '' },
    prefsFile: null,   // no ui-prefs.json unless a test asks for one
    claudeJson: null,
    isFile: (p) => set.has(String(p).toLowerCase()),
    readText: () => '',
    listDir: () => [],
    readJson: () => null,
    npmPrefix: () => '',
  }, extra || {});
}

describe('resolveClaudeBin: explicit overrides win', () => {
  it('CLAUDE_UI_CLAUDE_BIN beats everything, even a working auto-detection', () => {
    const m = machine([NPM_EXE, 'D:\\tools\\claude.exe'], { env: { PATH: '', CLAUDE_UI_CLAUDE_BIN: 'D:\\tools\\claude.exe' } });
    const r = resolveClaudeBin(m);
    assert.equal(r.path, 'D:\\tools\\claude.exe');
    assert.equal(r.source, 'CLAUDE_UI_CLAUDE_BIN');
    assert.equal(r.exists, true);
  });

  it('a typo in the override is reported as a missing named path, NOT silently re-guessed', () => {
    const m = machine([NPM_EXE], { env: { PATH: '', CLAUDE_UI_CLAUDE_BIN: 'D:\\tpyo\\claude.exe' } });
    const r = resolveClaudeBin(m);
    assert.equal(r.path, 'D:\\tpyo\\claude.exe', 'the user must see the path THEY set');
    assert.equal(r.exists, false);
  });

  it('claudeBin from ui-prefs.json is the env-var-free override', () => {
    const m = machine(['E:\\cli\\claude.exe'], {
      prefsFile: 'C:\\app\\ui-prefs.json',
      readJson: (p) => (p === 'C:\\app\\ui-prefs.json' ? { claudeBin: '  E:\\cli\\claude.exe  ' } : null),
    });
    const r = resolveClaudeBin(m);
    assert.equal(r.path, 'E:\\cli\\claude.exe', 'whitespace trimmed');
    assert.equal(r.source, 'ui-prefs.json (claudeBin)');
  });

  it('an empty/garbage prefs value does not shadow auto-detection', () => {
    const m = machine([NPM_EXE], { prefsFile: 'x', readJson: () => ({ claudeBin: '   ' }) });
    assert.equal(resolveClaudeBin(m).path, NPM_EXE);
  });

  it('a ui-prefs.json written by hand WITH A BOM is still read (Notepad / PowerShell 5.1)', () => {
    // the real fs reader runs here (no readJson seam): JSON.parse throws on U+FEFF, and the override
    // would be dropped without a word — which is the failure mode this whole resolver exists to end
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-bom-'));
    const prefs = path.join(dir, 'ui-prefs.json');
    try {
      fs.writeFileSync(prefs, '\uFEFF{"claudeBin":"C:\\\\cli\\\\claude.exe"}', 'utf8');
      const r = resolveClaudeBin(machine(['C:\\cli\\claude.exe'], { prefsFile: prefs, readJson: undefined }));
      assert.equal(r.path, 'C:\\cli\\claude.exe');
      assert.equal(r.source, 'ui-prefs.json (claudeBin)');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('resolveClaudeBin: PATH', () => {
  it('a claude.exe on PATH wins over the known locations (it is what the terminal runs)', () => {
    const onPath = 'C:\\tools\\bin\\claude.exe';
    const m = machine([onPath, NPM_EXE], { env: { PATH: 'C:\\windows;C:\\tools\\bin', APPDATA: path.join(WIN_HOME, 'AppData', 'Roaming') } });
    const r = resolveClaudeBin(m);
    assert.equal(r.path, onPath);
    assert.equal(r.source, 'PATH');
  });

  it('an npm claude.cmd shim resolves to the sibling .exe (spawn cannot run a .cmd)', () => {
    const shim = path.join(NPM_DIR, 'claude.cmd');
    const m = machine([shim, NPM_EXE], { env: { PATH: NPM_DIR, APPDATA: path.join(WIN_HOME, 'AppData', 'Roaming') } });
    const r = resolveClaudeBin(m);
    assert.equal(r.path, NPM_EXE);
    assert.match(r.source, /^PATH \(claude\.cmd\)$/);
  });

  it('a shim without the npm layout is parsed, and %dp0% expands to its own directory', () => {
    const dir = 'C:\\shims';
    const shim = path.join(dir, 'claude.cmd');
    const real = path.join(dir, 'vendor', 'claude.exe');
    const m = machine([shim, real], {
      env: { PATH: dir },
      readText: (p) => (p === shim ? '@ECHO off\r\n"%dp0%\\vendor\\claude.exe"   %*\r\n' : ''),
    });
    assert.equal(resolveClaudeBin(m).path, real);
  });

  it('a dead shim is skipped instead of being handed to spawn', () => {
    const dir = 'C:\\shims';
    const m = machine([path.join(dir, 'claude.cmd'), NPM_EXE], { env: { PATH: dir, APPDATA: path.join(WIN_HOME, 'AppData', 'Roaming') } });
    const r = resolveClaudeBin(m);
    assert.equal(r.path, NPM_EXE, 'falls through to the known locations');
    assert.ok(r.tried.includes(path.join(dir, 'claude.cmd')), 'the dead shim is reported as tried');
  });

  it('quoted and empty PATH entries do not break the scan', () => {
    const onPath = 'C:\\tools\\claude.exe';
    const m = machine([onPath], { env: { PATH: ';"C:\\tools";;' } });
    assert.equal(resolveClaudeBin(m).path, onPath);
  });
});

describe('resolveClaudeBin: known install locations', () => {
  it('native installer (~/.local/bin)', () => {
    const p = path.join(WIN_HOME, '.local', 'bin', 'claude.exe');
    const r = resolveClaudeBin(machine([p]));
    assert.equal(r.path, p);
    assert.match(r.source, /^native/);
  });

  it('native versioned install picks the NEWEST version dir', () => {
    const root = path.join(WIN_HOME, '.claude', 'versions');
    const files = ['2.1.9', '2.1.10', '2.0.30'].map((v) => path.join(root, v, 'claude.exe'));
    const r = resolveClaudeBin(machine(files, { listDir: (d) => (d === root ? ['2.1.9', '2.1.10', '2.0.30', 'tmp'] : []) }));
    assert.equal(r.path, path.join(root, '2.1.10', 'claude.exe'), '2.1.10 > 2.1.9 (numeric, not lexical)');
  });

  it('migrate-installer layout (~/.claude/local)', () => {
    const p = path.join(WIN_HOME, '.claude', 'local', 'claude.exe');
    const r = resolveClaudeBin(machine([p]));
    assert.match(r.source, /^npm-local/);
  });

  it('npm-global default prefix (%APPDATA%\\npm)', () => {
    const r = resolveClaudeBin(machine([NPM_EXE]));
    assert.equal(r.path, NPM_EXE);
    assert.match(r.source, /^npm-global/);
  });

  it('custom npm prefix via npm_config_prefix', () => {
    const pre = 'D:\\node-global';
    const p = path.join(pre, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const m = machine([p], { env: { PATH: '', npm_config_prefix: pre, APPDATA: path.join(WIN_HOME, 'AppData', 'Roaming') } });
    assert.equal(resolveClaudeBin(m).path, p);
  });

  it('nvm-windows current-version junction', () => {
    const nvm = 'C:\\nvm4w\\nodejs';
    const p = path.join(nvm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const m = machine([p], { env: { PATH: '', NVM_SYMLINK: nvm, APPDATA: path.join(WIN_HOME, 'AppData', 'Roaming') } });
    assert.equal(resolveClaudeBin(m).path, p);
  });

  it('linux/mac: unix prefix layouts and a bare `claude` name', () => {
    const p = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude';
    const m = machine([p], { platform: 'linux', home: '/home/kollege', env: { PATH: '' } });
    const r = resolveClaudeBin(m);
    assert.equal(r.path, p);
    assert.match(r.source, /^npm-global/);
  });
});

describe('resolveClaudeBin: last resort + miss', () => {
  it('`npm prefix -g` is only asked when nothing else matched', () => {
    let asked = 0;
    const hit = machine([NPM_EXE], { npmPrefix: () => { asked++; return 'D:\\p'; } });
    resolveClaudeBin(hit);
    assert.equal(asked, 0, 'a found binary must not cost an npm spawn');

    const pre = 'D:\\p';
    const p = path.join(pre, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const miss = machine([p], { npmPrefix: () => { asked++; return pre; } });
    const r = resolveClaudeBin(miss);
    assert.equal(asked, 1);
    assert.equal(r.path, p);
    assert.match(r.source, /^npm prefix -g/);
  });

  it('total miss: legacy default path, source "not-found", the tried list, installMethod hint', () => {
    const m = machine([], { claudeJson: 'C:\\Users\\kollege\\.claude.json', readJson: (p) => (p.endsWith('.claude.json') ? { installMethod: 'native' } : null) });
    const r = resolveClaudeBin(m);
    assert.equal(r.source, 'not-found');
    assert.equal(r.exists, false);
    assert.equal(r.path, defaultClaudeExe(m.env, m.home, m.platform), 'error messages still name a concrete path');
    assert.ok(r.tried.length > 5, 'the miss must document where it looked');
    assert.equal(r.installMethod, 'native');
  });
});
