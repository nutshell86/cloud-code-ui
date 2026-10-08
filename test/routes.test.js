'use strict';
// E1 — the routing table is the inventory, and this is what makes it one.
//
// Before the table, `server.js` answered requests from 86 `if (p === … && req.method === …)` branches
// inside one 1400-line function. Nothing could enumerate them, so nothing could notice a route going
// missing: a deleted or mistyped endpoint answered 404 like an endpoint that was never there, and a
// 500 hid inside a branch for weeks (`computeNextRun` used without its require) because no test ever
// touched it.
//
// The list below is therefore not decoration — it is the expected surface of this panel's API. A route
// added or removed without touching this file breaks the suite, which is exactly the moment to ask
// whether the client still matches. Read from the SOURCE on purpose: requiring server.js would boot a
// listener, and the point is to check the table, not a running process.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const KEY_RE = /^ {2}'([A-Z]+ \/[^']*)': async \(req, res, url, p\) => \{/gm;
const found = [...SRC.matchAll(KEY_RE)].map((m) => m[1]);

// The API as of 2026-10-07 (95 exact routes — P-1 added the four /api/projects routes, P-2 the cockpit's
// GET /api/projects/overview, P4 GET /api/projects/repos, CHAT-FLOW-4 the GET /api/session/open probe). Sorted, so a diff reads as one added/removed line.
const EXPECTED = [
  'DELETE /api/corrections',
  'DELETE /api/plan',
  'GET /api/agent/output',
  'GET /api/spend',
  'GET /api/auth',
  'GET /api/backups',
  'GET /api/backups/download',
  'GET /api/backups/preview',
  'GET /api/bugs',
  'GET /api/cfgfile',
  'GET /api/cfgfiles',
  'GET /api/changelog',
  'GET /api/cli/version',
  'GET /api/corrections',
  'GET /api/diff',
  'GET /api/doctor',
  'GET /api/files',
  'GET /api/mcp',
  'GET /api/mcp/check',
  'GET /api/mcp/configured',
  'GET /api/mcp/get',
  'GET /api/mcp/inventory',
  'GET /api/mcp/tools',
  'GET /api/memory',
  'GET /api/memory/file',
  'GET /api/models',
  'GET /api/ping',
  'GET /api/plan',
  'GET /api/plans',
  'GET /api/projects',
  'GET /api/projects/overview',
  'GET /api/projects/repos', // P4: Repos & PRs (lib/project-repos.js)
  'GET /api/prompt-history',
  'GET /api/prompts',
  'GET /api/prs',
  'GET /api/search',
  'GET /api/session/mcp',
  'GET /api/session/open', // CHAT-FLOW-4: the takeover probe (lib/chat.js sessionHold)
  'GET /api/sessions',
  'GET /api/skill',
  'GET /api/skill-favorites',
  'GET /api/skills',
  'GET /api/state',
  'GET /api/sysinfo',
  'GET /api/transcript',
  'GET /api/uiskill/costs',
  'GET /api/uiskill/engine/runs',
  'GET /api/uiskill/result-file',
  'GET /api/uiskill/runs',
  'GET /api/uiskill/schedules',
  'GET /api/uiskills',
  'GET /api/ultracode/support',
  'GET /api/usage',
  'GET /api/usage.csv',
  'GET /api/version',
  'PATCH /api/config/settings',
  'PATCH /api/config/settings-local',
  'POST /api/spend/refresh',
  'POST /api/backups/restore',
  'POST /api/bug',
  'POST /api/cfgfile/delete',
  'POST /api/chat/start',
  'POST /api/cli/update',
  'POST /api/corrections',
  'POST /api/enhance',
  'POST /api/favorites/toggle',
  'POST /api/mcp/add',
  'POST /api/mcp/login',
  'POST /api/mcp/logout',
  'POST /api/mcp/remove',
  'POST /api/mcp/update',
  'POST /api/memory/file/delete',
  'POST /api/prefs',
  'POST /api/projects',
  'POST /api/projects/assign',
  'POST /api/projects/delete',
  'POST /api/prompt-history',
  'POST /api/prompts',
  'POST /api/prompts/delete',
  'POST /api/restart',
  'POST /api/session/delete',
  'POST /api/session/rename',
  'POST /api/skill-favorites/toggle',
  'POST /api/skill/duplicate',
  'POST /api/uiskill/runs',
  'POST /api/uiskill/runs/clear',
  'POST /api/uiskill/runs/delete',
  'POST /api/uiskill/schedules',
  'POST /api/uiskill/schedules/delete',
  'POST /api/uiskill/schedules/run',
  'POST /api/version/pull',
  'PUT /api/cfgfile',
  'PUT /api/config/settings',
  'PUT /api/config/settings-local',
  'PUT /api/memory/file',
];

describe('routes — the table is the API surface', () => {
  it('contains exactly the expected routes', () => {
    assert.deepEqual(found.slice().sort(), EXPECTED.slice().sort(),
      'a route was added or removed — update EXPECTED in this file and check the client against it');
  });
  it('has no duplicate keys (the later one would silently win)', () => {
    const seen = new Set(), dup = [];
    for (const k of found) { if (seen.has(k)) dup.push(k); seen.add(k); }
    assert.deepEqual(dup, []);
  });
  it('every key is "<METHOD> /path" with a known method', () => {
    for (const k of found) {
      assert.match(k, /^(GET|POST|PUT|PATCH|DELETE) \/api\/[\w./-]*$/, 'malformed route key: ' + k);
    }
  });
});

describe('routes — the shapes a table cannot express are still wired up', () => {
  it('dispatches the table before anything else, and refuses to let a handler stay silent', () => {
    assert.match(SRC, /const handler = ROUTES\[req\.method \+ ' ' \+ p\];/);
    // A handler that returns without answering used to fall through to the static file branch, where an
    // API caller got 404 text/plain. This is the line that turns that into a named 500.
    assert.match(SRC, /if \(!res\.headersSent\) return sendJson\(res, 500, \{ error: 'route did not answer: '/);
  });
  it('keeps the /api/uiskill/runs/<id> prefix route', () => {
    assert.match(SRC, /if \(p\.startsWith\('\/api\/uiskill\/runs\/'\) && req\.method === 'GET'\)/);
  });
  // The chat family is the one part of the API the table cannot hold (a uuid in the path), so its action
  // list is pinned here instead — same purpose as EXPECTED above: an action added or dropped is one line
  // in a diff, and the moment to check the client against it.
  it('keeps the /api/chat/<uuid>/<action> family with all seventeen actions', () => {
    // The charset accepts `-` for two independent reasons that landed in the same release: PR-11's
    // `reload-skills` and G4/G6's `mcp-status`/`mcp-toggle`/`mcp-reconnect`/`stop-task`. Without it this
    // match fails ENTIRELY, and `assert.ok(m)` is then the only thing standing between that and a green
    // test that checks nothing.
    const m = SRC.match(/\/\^\\\/api\\\/chat\\\/\(\[0-9a-f-\]\{36\}\)\\\/\(([a-z|-]+)\)\$\//);
    assert.ok(m, 'the chat action regex is gone');
    assert.deepEqual(m[1].split('|').sort(),
      ['context', 'effort', 'hooks', 'interrupt', 'mcp-reconnect', 'mcp-status', 'mcp-toggle', 'mode',
        'model', 'permission', 'reload-skills', 'send', 'settings', 'stop', 'stop-task', 'stream',
        'ultracode'].sort());
    // `stop-task` is only reachable because the alternation is ANCHORED: `stop` matches first, fails the
    // `$` and backtracks. Without the anchor every stop-task POST would land in the process killer.
    assert.match(SRC, /\|stop-task\)\$\//, 'the action alternation must stay anchored with $');
  });
  it('still answers an unknown /api/* with JSON 404 instead of falling through to the file handler', () => {
    assert.match(SRC, /if \(p\.startsWith\('\/api\/'\)\) return sendJson\(res, 404, \{ error: 'not found' \}\);/);
  });

  // The refusal of a cwd (alert #5) is a FIELD, and a field without a reader is this project's own
  // error class: /api/files feeds the @-mention picker, which paints an empty list as "no matches", so
  // every caller has to be able to tell the two apart. The caller list is READ from public/js, never
  // kept here — a third picker added later fails this test instead of quietly lying.
  it('`cwd-refused` has a reader in every browser caller of /api/files', () => {
    assert.ok(SRC.includes("code: 'cwd-refused'"), 'server.js no longer emits the code at all');
    const dir = path.join(__dirname, '..', 'public', 'js');
    const callers = fs.readdirSync(dir).filter((f) => f.endsWith('.js'))
      .map((f) => ({ f, src: fs.readFileSync(path.join(dir, f), 'utf8') }))
      .filter((x) => x.src.includes('/api/files?'));
    assert.ok(callers.length >= 2, 'expected the composer @-menu and the UI-skill file picker, found ' + callers.length);
    // the code has to be COMPARED, not merely mentioned: the first version of this test accepted a
    // caller whose only occurrence was in a comment, and a comment shows the user nothing
    const READS = /\.code\s*===\s*'cwd-refused'/;
    const blind = callers.filter((x) => !READS.test(x.src)).map((x) => x.f);
    assert.deepEqual(blind, [], 'these call /api/files but cannot tell a refused directory from an empty result');
  });
});
