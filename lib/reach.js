'use strict';
// N12 — "does this path answer?", asked without holding the event loop and without trusting it to answer.
//
// Why a module of its own: an unreachable path costs this panel in two different currencies, and every
// existing check paid one of them. `fs.existsSync` on \\<dead host>\share held the EVENT LOOP for 43 918 ms
// (test/sync-fs-paths.test.js has the numbers). `await fsp.stat` on the same path frees the loop but
// waits 53 973 ms — and for all of that time it occupies one of libuv's FOUR threadpool threads, which
// every other async fs call, dns lookup and zlib job of this process queues behind. A user who clicks
// "start" five times on a dead share would therefore stall the panel's whole file I/O, just more politely.
//
// So the probe here has three properties, each answering one of those costs:
//  · its own deadline (PROBE_TIMEOUT_MS): the caller gets an honest „no answer in N s" instead of a minute
//    of nothing. The stat itself cannot be cancelled — it keeps its thread until the OS gives up.
//  · one stat per reach key at a time (host for a UNC path, drive letter for X:\…): a second path on the
//    same dead host waits for the stat already in flight instead of taking a second thread.
//  · a negative memory: once a key timed out it is answered as unreachable WITHOUT a stat while that stat
//    still hangs and for NEGATIVE_MS after — so repeated clicks cost nothing.
// Positive answers are never cached: a directory that exists now may be deleted the next second, and the
// callers act on the answer.
const fsp = require('fs/promises');

// A few seconds, not the OS's ~50: a share that has not answered by then is not one a chat should start
// in. The env override is a TEST seam (the suites run with a fraction of a second); clamped so a typo can
// neither turn the probe off nor make it wait longer than the thing it replaces.
const PROBE_TIMEOUT_MS = (() => {
  const n = Math.floor(Number(process.env.CLAUDE_UI_PATH_PROBE_MS));
  return Number.isFinite(n) && n >= 20 ? Math.min(n, 60000) : 5000;
})();
const NEGATIVE_MS = 60000;
const TIMEOUT = Symbol('timeout');

// \\host\share and //host/share — and the device spelling of the same thing, \\?\UNC\host\share, which
// is a network path wearing the long-path prefix. NOT the local device forms \\?\C:\… and \\.\pipe\…:
// those never leave the machine (the suites use \\?\ precisely because it costs no network trip).
const DEVICE_UNC_RE = /^[\\/]{2}[?.][\\/]UNC[\\/]/i;
const DEVICE_RE = /^[\\/]{2}[?.][\\/]/;
const UNC_RE = /^[\\/]{2}[^\\/]/;
function isNetworkPath(p) {
  const s = String(p == null ? '' : p).trim();
  if (DEVICE_UNC_RE.test(s)) return true;
  if (DEVICE_RE.test(s)) return false;
  return UNC_RE.test(s);
}

// What a dead answer is shared across. A UNC path: its HOST (a dead host makes every share on it hang).
// A drive letter: the LETTER — a mapped drive on a dead share looks local, and every path on it hangs alike.
// Anything else (relative, posix): the path itself.
function reachKey(p) {
  const s = String(p == null ? '' : p).trim();
  if (isNetworkPath(s)) {
    const rest = DEVICE_UNC_RE.test(s) ? s.replace(DEVICE_UNC_RE, '') : s.replace(/^[\\/]{2}/, '');
    return 'net:' + rest.split(/[\\/]/)[0].toLowerCase();
  }
  const local = s.replace(DEVICE_RE, '');
  const drv = /^([A-Za-z]):/.exec(local);
  return drv ? 'drv:' + drv[1].toLowerCase() : 'path:' + s;
}

function within(promise, ms) {
  let timer;
  const to = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), ms); });
  return Promise.race([promise, to]).finally(() => clearTimeout(timer));
}

// -> probe(p): Promise<{ state: 'ok', stat } | { state: 'missing', code } | { state: 'unreachable', timeoutMs, remembered? }>
// `stat`, `timeoutMs`, `negativeMs` and `now` are injectable so the suites can drive a hang without a network.
function createProber(o) {
  const opts = o || {};
  // a property lookup at call time, not a captured reference: test/sync-fs-paths.test.js counts stats by
  // patching fsp.stat, and that only works if this reads it per call
  const stat = opts.stat || ((p) => fsp.stat(p));
  const timeoutMs = opts.timeoutMs || PROBE_TIMEOUT_MS;
  const negativeMs = opts.negativeMs == null ? NEGATIVE_MS : opts.negativeMs;
  const now = opts.now || Date.now;
  const running = new Map(); // path -> settled promise of the stat in flight for it
  const gates = new Map();   // reach key -> the stat currently in flight under that key
  const dead = new Map();    // reach key -> { until, pending: Set<stat promise> }

  const isDead = (key) => {
    const d = dead.get(key);
    if (!d) return false;
    if (d.pending.size || now() < d.until) return true;
    dead.delete(key);
    return false;
  };
  // A stat outlived its deadline: the key is dead while it hangs and for negativeMs after. If it does
  // come back with a STAT the host is evidently there again, so the memory is dropped early — a slow VPN
  // share should not stay locked out for a minute after it finally answered. An error after the hang is
  // not such proof: a dead host also ends in ENOENT, just ~50 s late.
  const markDead = (key, st) => {
    let d = dead.get(key);
    if (!d) { d = { until: 0, pending: new Set() }; dead.set(key, d); }
    d.until = Math.max(d.until, now() + negativeMs);
    if (d.pending.has(st)) return;
    d.pending.add(st);
    st.then((r) => {
      d.pending.delete(st);
      if (r.ok) { if (dead.get(key) === d && !d.pending.size) dead.delete(key); }
      else d.until = Math.max(d.until, now() + negativeMs);
    });
  };
  const startStat = (s, key) => {
    const live = running.get(s);
    if (live) return live;
    const st = Promise.resolve().then(() => stat(s)).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
    running.set(s, st);
    gates.set(key, st);
    st.then(() => { if (running.get(s) === st) running.delete(s); if (gates.get(key) === st) gates.delete(key); });
    return st;
  };
  const unreachable = (remembered) => (remembered ? { state: 'unreachable', timeoutMs, remembered: true } : { state: 'unreachable', timeoutMs });

  return async function probe(p) {
    // existsSync's contract, which pathExists stands in for: any non-path is an answer, never a throw
    if (typeof p !== 'string' || !p || p.includes('\0')) return { state: 'missing', code: 'EINVAL' };
    const key = reachKey(p);
    if (isDead(key)) return unreachable(true);
    // another path on the same host/drive is being asked right now: wait for THAT answer before taking a
    // second thread for the same question
    const gate = gates.get(key);
    if (gate && running.get(p) !== gate) {
      if ((await within(gate, timeoutMs)) === TIMEOUT) { markDead(key, gate); return unreachable(false); }
      if (isDead(key)) return unreachable(true);
    }
    const st = startStat(p, key);
    const r = await within(st, timeoutMs);
    if (r === TIMEOUT) { markDead(key, st); return unreachable(false); }
    if (r.ok) return { state: 'ok', stat: r.v };
    return { state: 'missing', code: (r.e && r.e.code) || '' };
  };
}

// The one prober the server uses — one negative memory for every route, or a click on "start" would not
// know what the Settings field just found out.
const probePath = createProber();

// A deadline for any other async fs read on a path that may be remote (lib/paths resolveClaudeBinAsync):
// TIMEOUT-less callers would otherwise wait for the OS, and a refresh that never settles never refreshes.
async function withinOr(promise, ms, fallback) {
  try { const r = await within(promise, ms); return r === TIMEOUT ? fallback : r; } catch { return fallback; }
}

// -> the first of `paths` that did not answer in time, as { path, timeoutMs, remembered }, or null.
// All asked at once (the gates above still keep it to one stat per host), so a start with a dead cwd AND a
// dead --add-dir waits one deadline, not two. Only `unreachable` counts: a path that answered „not there"
// is left to the caller's own rule (startChat drops a missing --add-dir and falls back to HOME for a
// missing local cwd — tested behaviour this does not change).
async function firstUnreachable(paths, probe) {
  const ask = probe || probePath;
  const list = [...new Set((paths || []).filter((p) => typeof p === 'string' && p))];
  const res = await Promise.all(list.map((p) => ask(p)));
  const i = res.findIndex((r) => r.state === 'unreachable');
  return i < 0 ? null : { path: list[i], timeoutMs: res[i].timeoutMs, remembered: !!res[i].remembered };
}

module.exports = { PROBE_TIMEOUT_MS, NEGATIVE_MS, isNetworkPath, reachKey, createProber, probePath, firstUnreachable, withinOr };
