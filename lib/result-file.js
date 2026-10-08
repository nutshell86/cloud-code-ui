'use strict';
// Panel data of a result card from a FILE instead of the model's output (`expandSrc` in a ui-result
// block). Why: /sync-acme-proj's comparison panels weigh ~70 KB per run — typed out verbatim by the
// model that is ~20k output tokens for data that already sits on disk next to the plan. The block now
// carries only an absolute path; the browser fetches the file through GET /api/uiskill/result-file, and
// the run history receives the RESOLVED data at persist time (a history entry must not depend on a
// file that the next run overwrites).
//
// Trust model: the path is model-authored. It is served only when it names a `.json` file INSIDE the
// `run.cwd` of a registered UI skill (= the user's own tooling directories), is size-capped, and its
// content is re-normalized by the same whitelist as an inline block (uiResultExpand).
const fsp = require('fs/promises');
const path = require('path');
const { uiResultExpand } = require('../public/js/ui-result');

const MAX_BYTES = 4 * 1024 * 1024;

// the directories a result file may live in: every UI-skill manifest's run.cwd (absolute ones only)
function resultFileRoots(skills) {
  const out = new Set();
  for (const s of skills || []) {
    const cwd = s && s.manifest && s.manifest.run && s.manifest.run.cwd;
    if (typeof cwd === 'string' && cwd.trim() && path.isAbsolute(cwd.trim())) out.add(path.resolve(cwd.trim()));
  }
  return [...out];
}

// path check only (no I/O) → { path } | { error, status }
function resolveResultFile(src, roots) {
  if (typeof src !== 'string' || !src.trim()) return { error: 'src required', status: 400 };
  const s = src.trim();
  if (!path.isAbsolute(s)) return { error: 'src must be an absolute path', status: 400 };
  const p = path.resolve(s);
  if (path.extname(p).toLowerCase() !== '.json') return { error: 'only .json files are served', status: 400 };
  // containment via path.relative: '' = the root itself (not a file), '..' prefix = escaped, absolute = other drive
  const inside = (roots || []).some((root) => { const rel = path.relative(root, p); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); });
  if (!inside) return { error: 'src is outside the registered UI-skill directories', status: 403 };
  return { path: p };
}

// read + validate → { expand, path } | { error, status }. Accepts `{ "expand": [...] }` or a bare array.
// ONE file handle for the CHECK and the READ — the same fix, and the same reason, as lib/backups.js
// readDiffSide: `fsp.stat(path)` followed by `fsp.readFile(path)` are two independent lookups of the same
// NAME, so the size cap the first one decided does not bind what the second one reads. That matters here
// more than almost anywhere else in the panel: the path is MODEL-AUTHORED (see the trust model at the top
// of this file) and it points into a directory the user's own tooling rewrites between runs — a 4 MB cap
// that was passed, and a file that has since become 2 GB read whole into the panel's memory. With a
// handle, `fh.stat()` and `fh.readFile()` describe the SAME open inode, so the cap really binds the read.
// CodeQL names the pair js/file-system-race (CWE-367, security-severity HIGH) and has found six of them
// in this repo. A DIRECTORY needs no second branch the way readDiffSide needs one: both the failing
// `open` (EISDIR/EPERM) and the `!isFile()` below answer with the same 404 this route always gave.
//
// AND THE ALERT THE FIX ITSELF RAISED, left open on purpose — read this before „fixing" it. CodeQL files
// `js/insecure-temporary-file` (HIGH) on the `fsp.open` below, because its dataflow reaches a path under the
// OS temp dir (a `roots` entry does, in the tests). That rule is about CREATING a file there. This opens
// with `'r'`, which is O_RDONLY and carries no O_CREAT — measured rather than argued:
//     open(<nonexistent>, 'r')  →  throws ENOENT, and the path does NOT exist afterwards
//     open(<nonexistent>, 'w')  →  the file DOES exist afterwards   ← that is what creation looks like
// So the rule's premise does not hold here. The alert stays OPEN rather than dismissed, and the code is NOT
// reshaped to silence it: turning a red gate green by rewriting correct code is the move this repo punishes,
// and `O_RDONLY` instead of `'r'` would be exactly that — a change whose only purpose is a quieter scanner.
// If this ever becomes a WRITE, the premise flips and the alert is real.
async function readExpandFile(src, roots, rowCount) {
  const r = resolveResultFile(src, roots);
  if (r.error) return r;
  let fh = null;
  try { fh = await fsp.open(r.path, 'r'); } catch { return { error: 'file not found', status: 404 }; }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { error: 'file not found', status: 404 };
    if (st.size > MAX_BYTES) return { error: 'file too large', status: 413 };
    let json;
    try { json = JSON.parse(await fh.readFile('utf8')); } catch { return { error: 'invalid JSON', status: 422 }; }
    const arr = Array.isArray(json) ? json : (json && typeof json === 'object' && Array.isArray(json.expand) ? json.expand : null);
    if (!arr) return { error: 'no expand array in file', status: 422 };
    return { expand: uiResultExpand(arr, Number(rowCount) > 0 ? Number(rowCount) : 500), path: r.path };
  } finally { try { await fh.close(); } catch { /* the only state that matters is „closed" */ } }
}

// persist-time resolution for the run history: inline the file's data, drop the reference.
// On failure the reference stays — the card can still try (and tell the user why it failed).
async function resolveResultSrc(result, roots) {
  if (!result || typeof result !== 'object' || typeof result.expandSrc !== 'string') return result;
  if (Array.isArray(result.expand) && result.expand.length) { const o = Object.assign({}, result); delete o.expandSrc; return o; }
  const rows = Array.isArray(result.rows) ? result.rows.length : 0;
  const r = await readExpandFile(result.expandSrc, roots, rows);
  if (r.error) return result;
  const out = Object.assign({}, result);
  delete out.expandSrc;
  if (r.expand.length) out.expand = r.expand;
  return out;
}

module.exports = { resultFileRoots, resolveResultFile, readExpandFile, resolveResultSrc, MAX_BYTES };
