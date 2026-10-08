#!/usr/bin/env node
'use strict';
// One-command, zero-dependency self-check for the Control Panel. Runs three layers and exits non-zero on any
// failure, so "did my change work?" is answerable in seconds without leftover ports or a running server:
//   1) node --check on every *.js (catches load-time syntax errors)
//   2) node --test on the unit + fake-driven integration tests (no real model call, no cost)
//   3) a self-contained live smoke: pick a free port, boot server.js with the fake bin, run smoke-test.js, tear down
//      — and this is the layer that runs WITH the N9 API-token gate on (the unit suites run with it off, see
//        test/sandbox.js), so the smoke's /api/ checks go through the gate instead of around it, and a
//        token-less probe first proves the gate really is on
// Layers 2 and 3 run inside a throwaway sandbox (test/sandbox.js): temp data + ~/.claude dirs with the
// fixture corpus, no scheduler, a dead CDP port, a dummy GHE token, no npm registry. Nothing real is
// read or written — not the live stores, not the transcript corpus, not the panel's server.log.
// Usage: node verify.js [--quick]   (--quick skips the live smoke)
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { makeSandbox, FAKE } = require('./test/sandbox');

const ROOT = __dirname;
const NODE = process.execPath;
const quick = process.argv.includes('--quick');
// The fake binary is not optional: without it every chat a test starts would be a REAL, paid CLI turn.
// Refuse outright instead of quietly falling back to whatever claude.exe the machine has.
if (!fs.existsSync(FAKE)) {
  console.error('\n✗ verify: ' + path.relative(ROOT, FAKE) + ' is missing — refusing to run the tests against the real (paid) claude binary.\n');
  process.exit(1);
}
let failures = 0;
const ok = (name, pass, detail) => { console.log((pass ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : '')); if (!pass) failures++; };

function jsFiles() {
  const out = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { if (/^(node_modules|\.git)$/.test(f)) continue; const p = path.join(d, f); const st = fs.statSync(p); if (st.isDirectory()) walk(p); else if (f.endsWith('.js')) out.push(p); } };
  for (const d of ['lib', 'public/js', 'test']) { const dd = path.join(ROOT, d); if (fs.existsSync(dd)) walk(dd); }
  for (const f of ['server.js', 'smoke-test.js', 'verify.js', 'fake-claude.js']) { const p = path.join(ROOT, f); if (fs.existsSync(p)) out.push(p); }
  return out;
}
function freePort() { return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
// `token` is not optional any more in practice: the smoke server below runs with the N9 token gate ON, so
// a header-less /api/state here would poll 401 until the timeout and report "server did not come up".
function get(port, p, token) { return new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: p, headers: token ? { 'X-CCUI-Token': token } : {} }, (res) => { res.resume(); resolve(res.statusCode); }); r.on('error', reject); }); }
async function waitUp(port, ms = 12000, token) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await get(port, '/api/state', token) === 200) return; } catch {} await new Promise((r) => setTimeout(r, 150)); } throw new Error('server did not come up'); }
// Which tests are red, with WHERE and WHY — not just the top-level line. node's TAP reporter nests a
// failing `it` under its `describe`; printing only `^not ok` showed the group („not ok 425 - L1 — …") and
// hid which case failed and with what message, so every red run meant re-running the file by hand to find
// out (2026-10-05, the flaky-test hunt). Each `not ok` at any depth, with the `location:` and the first
// line of the `error:` from the YAML block under it.
function tapFailures(tap) {
  const L = String(tap || '').split('\n');
  const out = [];
  for (let i = 0; i < L.length; i++) {
    const m = /^(\s*)not ok \d+ - (.*)$/.exec(L[i]);
    if (!m) continue;
    const pad = '  '.repeat(Math.floor(m[1].length / 4));
    out.push(pad + 'not ok - ' + m[2]);
    for (let k = i + 1; k < L.length && !/^\s*\.\.\.\s*$/.test(L[k]) && !/^\s*(not )?ok \d+ - /.test(L[k]); k++) {
      const loc = /^\s*location: '?(.*?)'?\s*$/.exec(L[k]);
      if (loc) out.push(pad + '  at ' + loc[1].replace(/\\\\/g, '\\')); // YAML doubles the backslashes
      const er = /^\s*error: (.*)$/.exec(L[k]);
      if (er) {
        let msg = er[1].trim();
        if (/^[|>]-?$/.test(msg) && k + 1 < L.length) msg = L[k + 1].trim(); // a block scalar: the message is on the next line
        out.push(pad + '  ' + msg.replace(/^'|'$/g, '').slice(0, 300));
      }
    }
  }
  return out;
}

(async () => {
  console.log('\nControl Panel — verify\n');

  // 1) syntax
  console.log('1) Syntax (node --check)');
  const files = jsFiles(); let bad = 0;
  for (const f of files) { const r = spawnSync(NODE, ['--check', f], { encoding: 'utf8' }); if (r.status !== 0) { bad++; console.log('    ' + path.relative(ROOT, f) + ': ' + (r.stderr || '').split('\n').find(Boolean)); } }
  ok(files.length + ' files checked', bad === 0, bad ? bad + ' failed' : '');

  // 2) tests
  console.log('\n2) Tests (node --test)');
  const testFiles = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => path.join('test', f));
  // Two passes on purpose. The suites that boot a real server assert on TIMING (resume, reconnect,
  // SSE replay); running them in parallel with everything else made them compete for CPU and ports,
  // which surfaced as a flaky failure in the resume/self-heal suite while each file passed alone.
  // So: pure suites in parallel (fast), server-booting suites serially (deterministic) — and the split
  // is read out of the suites THEMSELVES, not out of a list kept here. A hand-written list silently
  // misfiles every suite added after it was last touched (it had four of them), and a misfiled timing
  // suite is a flake, not a failure. Two signals, because neither alone is honest: `spawn(… 'server.js')`
  // finds the booters, and the `// verify: serial` directive is how the THREE suites that boot no server say
  // so themselves: `run-timeout` and `terminate-chat` assert on kill timing (taskkill /T, kill grace), and
  // `session-state` spawns a real process through lib/chat.js and waits for frames to arrive IN ORDER.
  // This sentence said „the two process-tree suites" while there were two, and the third was added without
  // anyone noticing it — the same stale-enumeration trap the hand-written list above was removed for, just
  // one layer up in a comment. The guard counts the two SIGNALS, not their members, so nothing caught it.
  // Across LINES, bounded. The one way this detection rots is formatting: the very same call wrapped over
  // three lines by a formatter (`spawn(` · `process.execPath,` · `['server.js'],`) is invisible to a
  // single-line match, and it rots SILENTLY — the suite is parallelised and turns into a flake rather than a
  // failure. Bounded at 200 chars so the match cannot run past its own argument list into a LATER call and
  // misfile a pure suite that merely mentions the file in a comment.
  const BOOTS_SERVER = /spawn\w*\([\s\S]{0,200}?['"]server\.js['"]/;   // it starts a `node server.js`
  const SAYS_SERIAL = /^\s*\/\/\s*verify:\s*serial\b/m;           // …or it says so itself
  const isServer = (f) => { const s = fs.readFileSync(path.join(ROOT, f), 'utf8'); return BOOTS_SERVER.test(s) || SAYS_SERIAL.test(s); };
  // Every suite inherits the sandbox env, and every server a suite boots inherits it from there (they
  // all spread process.env). A suite that sets its own CLAUDE_UI_DATA_DIR & co. still wins; one that
  // forgets lands in the sandbox instead of the live files.
  const sbx = makeSandbox('verify-tests', { fakeCli: true });
  const pass = (files, extra) => {
    if (!files.length) return { status: 0, stdout: '', stderr: '' };
    return spawnSync(NODE, ['--test', ...extra, '--test-reporter=tap', ...files], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...sbx.env } });
  };
  const srvFiles = testFiles.filter(isServer);
  // A signal that matches NOTHING cannot rot either — it just quietly parallelises the timing suites
  // again, which is the exact flake the two passes exist to prevent. So each signal is counted on its
  // OWN: a guard on the SUM could never fail, because the two directive suites hold it at ≥ 2 for ever
  // while a dead `BOOTS_SERVER` sends a dozen server-booting suites into the parallel pass — green, and
  // flaky. The numbers are reported, not pinned to an expected count: a count in here would have to be
  // edited with every new suite, which is the hand-written list this replaced.
  const srcOf = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const nBoot = testFiles.filter((f) => BOOTS_SERVER.test(srcOf(f))).length;
  const nSaid = testFiles.filter((f) => SAYS_SERIAL.test(srcOf(f))).length;
  ok('serial pass recognised — both signals alive', nBoot > 0 && nSaid > 0,
    nBoot + ' boot a server + ' + nSaid + ' say so = ' + srvFiles.length + ' serial / ' + (testFiles.length - srvFiles.length) + ' parallel');
  const rPure = pass(testFiles.filter((f) => !isServer(f)), []);
  const rSrv = pass(srvFiles, ['--test-concurrency=1']);
  sbx.cleanup();
  let tests = 0, passed = 0, failed = 0;
  for (const r of [rPure, rSrv]) {
    const tap = (r.stdout || '') + (r.stderr || '');
    for (const line of tap.split('\n')) {
      const m = /^# (tests|pass|fail) (\d+)/.exec(line);
      if (m) { if (m[1] === 'tests') tests += +m[2]; else if (m[1] === 'pass') passed += +m[2]; else failed += +m[2]; }
    }
    for (const l of tapFailures(tap)) console.log('    ' + l);
  }
  console.log('    # tests ' + tests + '  # pass ' + passed + '  # fail ' + failed);
  const tOk = rPure.status === 0 && rSrv.status === 0;
  ok('unit + integration tests', tOk, tOk ? '' : 'see failures above');

  // 3) live smoke
  if (!quick) {
    console.log('\n3) Live smoke (fake-bin server on a free port)');
    const port = await freePort();
    const sbx = makeSandbox('verify-smoke', { fakeCli: true });
    // N9: the ONE layer that runs with the token gate ON. The sandbox switches it off for the unit suites
    // (test/sandbox.js says why), and a gate that is off in every layer would be a guard nothing exercises
    // end-to-end — the failure class this project keeps paying for. So the live smoke overrides the seam
    // back off and hands server AND client the same fixed token: the smoke's /api/ checks then have to pass
    // THROUGH the gate, which is also the only place a route that forgot about it would show up. (Its
    // static-file checks never meet the gate — `/`, `/js/*` and `/styles.css` are open by design.)
    // How many checks that is, is NOT written here: a fixed set plus one per script index.html links, so it
    // moves with every new front-end module; both places that spelled it out were wrong when written and
    // moved again by the next merge.
    // The number's reader is the smoke line below, which prints the smoke's own „N passed, M failed".
    const smokeToken = crypto.randomBytes(32).toString('hex');
    const srvEnv = { ...process.env, ...sbx.env, CLAUDE_UI_PORT: String(port), CLAUDE_UI_NO_API_TOKEN: '', CLAUDE_UI_API_TOKEN: smokeToken };
    const child = spawn(NODE, ['server.js'], { cwd: ROOT, env: srvEnv, stdio: ['ignore', 'ignore', 'ignore'] });
    try {
      await waitUp(port, 12000, smokeToken);
      // „gate ON" is a claim this layer prints, so it is MEASURED, not inferred from srvEnv: the token-less
      // twin of the readiness probe must be refused. Without this, dropping the `CLAUDE_UI_NO_API_TOKEN: ''`
      // override above leaves the sandbox's '1' in force — gate off, every smoke check still green (the
      // header is simply ignored), and the label still saying „ON".
      const bare = await get(port, '/api/state');
      const gateOn = bare === 401;
      ok('token gate ON in the smoke server — /api/state without the token', gateOn, 'HTTP ' + bare + (gateOn ? '' : ', expected 401'));
      // the port goes in as argv — smoke-test.js prefers it over an inherited CLAUDE_UI_PORT
      const s = spawnSync(NODE, ['smoke-test.js', String(port)], { cwd: ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CLAUDE_UI_API_TOKEN: smokeToken } });
      const summary = (s.stdout || '').split('\n').filter(Boolean).pop() || '';
      ok('smoke-test on :' + port + ' (API token gate ' + (gateOn ? 'ON' : 'NOT on') + ')', s.status === 0, summary);
      if (s.status !== 0) for (const line of ((s.stdout || '') + (s.stderr || '')).split('\n')) if (/✗|error/i.test(line)) console.log('    ' + line.trim());
    } catch (e) { ok('smoke-test', false, e.message); }
    finally {
      await new Promise((r) => { child.once('exit', r); try { child.kill(); } catch { r(); } setTimeout(r, 1500); });
      sbx.cleanup();
    }
  } else { console.log('\n3) Live smoke skipped (--quick)'); }

  console.log('\n' + (failures ? '✗ verify: ' + failures + ' step(s) failed' : '✓ verify: all green') + '\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('verify crashed:', e); process.exit(1); });
