'use strict';
// Test-only preload (`node -r test/fixtures/hang-paths-preload.js server.js`): every path that contains
// `ccui-n12-hang` behaves like a share whose host never answers — WITHOUT a network. The async fs calls on
// it never settle (that is what a dead SMB host does for ~54 s), and every SYNCHRONOUS call on it is
// written to $CCUI_TEST_HANG_LOG before it fails, because a sync call on such a path is the defect itself:
// on a real dead share it would hold the server's event loop for ~44 s (N12).
// Patched on the module objects, which is where lib/ looks them up at call time.
const fs = require('fs');
const fsp = require('fs/promises');

const MARK = 'ccui-n12-hang';
const LOG = process.env.CCUI_TEST_HANG_LOG || '';
const hit = (p) => typeof p === 'string' && p.includes(MARK);
const note = (fn, p) => { if (LOG) { try { fs.appendFileSync(LOG, fn + ' ' + p + '\n'); } catch { /* */ } } };
const never = () => new Promise(() => {});

for (const fn of ['stat', 'lstat', 'readFile', 'readdir', 'access']) {
  const real = fsp[fn];
  fsp[fn] = (p, ...a) => (hit(p) ? never() : real(p, ...a));
}
for (const fn of ['statSync', 'lstatSync', 'readFileSync', 'readdirSync']) {
  const real = fs[fn];
  fs[fn] = (p, ...a) => {
    if (hit(p)) { note(fn, p); const e = new Error('ENOENT (simulated dead share): ' + p); e.code = 'ENOENT'; throw e; }
    return real(p, ...a);
  };
}
const realExists = fs.existsSync;
fs.existsSync = (p) => { if (hit(p)) { note('existsSync', p); return false; } return realExists(p); };
