'use strict';
// PR-11 — after saving a skill, the RUNNING sessions have to re-read it. A session that is already up holds
// its skill listing in its context, so until now the file the user had just edited was not the one the model
// saw, and nothing said so. `reload_skills` is a real control of claude.exe 2.1.288 (read gratis from the
// binary: „Reloads skills from disk and returns the refreshed skill list.", with its own branch in the stdio
// dispatcher and no arguments).
//
// The route contract is in test/integration.test.js (it asserts the control really reaches the child, via
// fake-claude's `_reloadskills` frame). What is pinned HERE is the browser half, by reading the source:
// whether the save actually calls it, for which kind, and whether the outcome is reported rather than
// assumed. Without this the call could be dropped in a refactor and every other test would stay green.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SYS = fs.readFileSync(path.join(ROOT, 'public/js/views-system.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const CHAT = fs.readFileSync(path.join(ROOT, 'lib/chat.js'), 'utf8');

describe('skill reload — a saved skill reaches the running sessions', () => {
  it('the save calls the route, for every running session', () => {
    assert.match(SYS, /function reloadSkillsInSessions\(/);
    assert.match(SYS, /api\('\/api\/chat\/' \+ id \+ '\/reload-skills', \{ method: 'POST' \}\)/);
    // EVERY running session, not just the active tab: the file is global, and reloading one would leave the
    // others quietly stale — which is the shape of the bug being fixed
    assert.match(SYS, /TABS\b/);
    assert.match(SYS, /new Set\(tabs\.filter\(\(tb\) => tb && tb\.id && !tb\._exited\)/);
    // …and it is wired into the SAVE
    const save = SYS.slice(SYS.indexOf("$('#cfgSave').onclick"), SYS.indexOf("$('#cfgDelete').onclick"));
    assert.match(save, /reloadSkillsInSessions\(\)/, 'saving a skill no longer reloads anything');
    assert.match(save, /kind !== 'commands'/, 'the reload is no longer limited to the kind it was measured for');
  });

  it('the outcome is REPORTED, not assumed', () => {
    // `unconfirmed` means nobody answered. A reload nobody confirmed must not read like one that worked —
    // the same rule the effort switch follows (lib/chat.js setChatEffort).
    assert.match(SYS, /r\.unconfirmed\) out\.offen\+\+/);
    const save = SYS.slice(SYS.indexOf("$('#cfgSave').onclick"), SYS.indexOf("$('#cfgDelete').onclick"));
    assert.match(save, /skillsNeuGelesen/);
    assert.match(save, /skillsReloadOffen/);
    assert.match(save, /'warn'/, 'an unconfirmed reload is reported as if it had worked');
    // The DIALOG closes before the reload is even asked for: the write to disk is done at that point and
    // nothing the sessions answer can undo it. Only the toast waits, so that both halves are one sentence.
    assert.ok(save.indexOf('closeCfgOverlay()') < save.indexOf('reloadSkillsInSessions()'),
      'the editor now stays open while the sessions are asked');
    for (const k of ['views-system.skillsNeuGelesen', 'views-system.skillsReloadOffen']) {
      assert.ok(fs.readFileSync(path.join(ROOT, 'public/js/i18n.js'), 'utf8').includes("'" + k + "':"), 'missing key ' + k);
    }
  });

  it('the server side sends the measured control and nothing else', () => {
    assert.match(CHAT, /subtype: 'reload_skills'/);
    // no arguments — the schema is `{subtype:"reload_skills"}` and nothing more
    assert.match(CHAT, /controlRequest\(chat, \{ subtype: 'reload_skills' \}, undefined, \{ noBroadcast: true \}\)/);
    assert.match(SERVER, /action === 'reload-skills' && req\.method === 'POST'/);
    // POST, and only on a live process — writing to a dead stdin would report „nobody answered" for a CLI
    // that is not there at all (the same guard the context route carries)
    const route = SERVER.slice(SERVER.indexOf("action === 'reload-skills'"), SERVER.indexOf("action === 'stop'"));
    assert.match(route, /if \(!chat\.alive\) return sendJson\(res, 409/);
    assert.match(route, /unconfirmed: !!r\.unconfirmed/);
  });
});
