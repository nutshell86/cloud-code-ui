'use strict';
// verify: serial
// G4 — MCP live per tab. The one thing this suite is about: a switch may only report what the SESSION
// reported back, never what was sent to it.
//
// The trap is in the plumbing, not in the feature. `mcp_toggle` answers `success` with an EMPTY payload,
// this CLI has no MCP push frame at all (`mcp_servers_changed` does not exist — 0 hits in the 249 MB
// binary), and `controlRequest` resolves `{ok:true, unconfirmed:true}` on its own timeout. So „the request
// came back ok" is compatible with „nobody answered, nothing happened" — which is exactly how the panel
// once published „Ultracode aus" over a silent session (H1).
//
// Three layers, because each one can be green while the next is broken:
//  1. the decisions (public/js/mcp-live.js, require'd — pure);
//  2. the VISIBLE half (public/js/chat.js), lifted out of the source by name and run against fake globals,
//     the seam test/ultracode-honesty.test.js established. That is deliberate: a previous round shipped a
//     tested pure module behind an untested renderer, and a one-word rename made the feature mute while
//     123 tests stayed green;
//  3. end to end over the REAL engine against fake-claude's control channel, so a route that stops
//     answering, or a schema that drifts, fails here and not in a menu.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  mcpStatusRows, mcpRow, mcpReported, mcpToggleVerdict, mcpReconnectVerdict,
  mcpCanReconnect, mcpToggleWish, mcpStatusLook, mcpSplitConfigured, mcpStatusSummary, MCP_WIRE_STATES,
} = require('../public/js/mcp-live');

const ROOT = path.join(__dirname, '..');
const CHAT_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// ---- the lifting seam (same shape as test/ultracode-honesty.test.js) ---------------------------------
function liftFn(src, name, rel) {
  const one = new RegExp('^(?:async )?function ' + name + '\\(.*\\}[ \\t]*$', 'm');
  const multi = new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm');
  const m = one.exec(src) || multi.exec(src);
  assert.ok(m, name + '() not found in ' + rel + ' — renamed or reindented? Then these tests prove nothing.');
  return m[0];
}
function bundle(pieces, names, env) {
  const keys = Object.keys(env);
  return new Function(...keys, pieces.join('\n') + '\nreturn { ' + names.join(', ') + ' };')(...keys.map((k) => env[k]));
}
function loadChat(names, env) {
  return bundle(names.map((n) => liftFn(CHAT_SRC, n, 'public/js/chat.js')), names, env);
}
const tt = (k) => k;                                        // the KEY, so an assertion names the string without pinning its wording
function recorder() { const got = []; const f = (...a) => got.push(a); f.got = got; return f; }
function fakeApi(answer) {
  const calls = [];
  const api = (url, opts) => {
    calls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null });
    const r = answer(url, opts);
    return (r instanceof Error) ? Promise.reject(r) : Promise.resolve(r);
  };
  api.calls = calls;
  return api;
}
// A DOM stand-in; `children` is what the assertions read. Rich enough for the whole MENU, not just one row:
// draw() clears the list with `innerHTML = ''`, the footer buttons reach for querySelectorAll('input'), and
// pickTabMcp aborts when its popover is no longer `isConnected`.
function fakeEl(tag, cls, txt) {
  const n = {
    tag, className: cls || '', textContent: txt == null ? '' : txt, title: '', type: '', disabled: false,
    checked: false, id: '', isConnected: true, attrs: {}, children: [], onclick: null, onchange: null,
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = v; },
    remove() { this.isConnected = false; },
    querySelectorAll(sel) { return descendants(this).filter((c) => c.tag === sel); },
  };
  // the one DOM behaviour the menu actually depends on: assigning '' throws every row away, which is why a
  // „schaltet…" that lives in a button element cannot survive another row's answer (see pickTabMcp's `state`)
  Object.defineProperty(n, 'innerHTML', { get: () => '', set(v) { if (!v) n.children.length = 0; } });
  return n;
}
function descendants(n) {
  const out = [];
  (n.children || []).forEach((c) => { out.push(c); descendants(c).forEach((d) => out.push(d)); });
  return out;
}
const liveEnv = (over) => Object.assign({
  tt, el: fakeEl, api: null, toast: recorder(), logEvent: recorder(),
  mcpStatusRows, mcpRow, mcpToggleVerdict, mcpReconnectVerdict, mcpCanReconnect, mcpToggleWish, mcpStatusLook,
  mcpSplitConfigured, mcpStatusSummary,
  mcpLiveToast: null, applyMcpLive: null, mcpLiveRead: null, mcpLiveControls: null,
}, over || {});
// The menu's model as mcpLiveControls expects it (see pickTabMcp): the read-back, the verdicts of switches
// this menu performed, and which switches are in flight.
const liveState = (over) => Object.assign({ rows: null, marks: {}, busy: {} }, over || {});

// A read-back as the measured schema delivers it (eo(): „Server name as configured", „Current connection
// status", serverInfo „available when connected", error „available when status is 'failed'").
const WIRE = {
  mcpServers: [
    { name: 'alpha', status: 'connected', serverInfo: { name: 'alpha', version: '2.0.1' }, tools: [{ name: 'a' }, { name: 'b' }], scope: 'user', source: 'user' },
    { name: 'beta', status: 'needs-auth', error_code: 'CLAUDEAI_BEARER_REJECTED', config: { type: 'http', url: 'https://example.invalid/mcp' } },
    { name: 'gamma', status: 'failed', error: 'spawn ENOENT' },
    { name: 'delta', status: 'disabled' },
  ],
};

describe('mcp-live — reading what the session said', () => {
  it('normalises the measured response shape, field for field', () => {
    const rows = mcpStatusRows(WIRE);
    assert.deepEqual(rows.map((r) => r.name), ['alpha', 'beta', 'gamma', 'delta']);
    const a = mcpRow(rows, 'alpha');
    assert.equal(a.status, 'connected');
    assert.equal(a.version, '2.0.1');
    assert.equal(a.tools, 2, 'the tool ARRAY is reduced to a count — the rail shows a number, not 40 names');
    assert.equal(mcpRow(rows, 'beta').errorCode, 'CLAUDEAI_BEARER_REJECTED');
    assert.equal(mcpRow(rows, 'beta').url, 'https://example.invalid/mcp', 'the URL is the only way to tell two http servers apart');
    assert.equal(mcpRow(rows, 'gamma').error, 'spawn ENOENT');
  });

  it('a status word this build does not declare becomes UNKNOWN, not off', () => {
    // The CLI has an internal 'cached' state that the schema does NOT put on the wire, and a future build
    // may add a sixth. Mapping an unknown word onto „aus" would be the H1 defect in miniature: a state
    // nobody reported, rendered as a position.
    const rows = mcpStatusRows({ mcpServers: [{ name: 'x', status: 'cached' }] });
    assert.equal(rows[0].status, '');
    assert.equal(rows[0].statusRaw, 'cached', 'what it said is kept, so the tooltip can name it');
    assert.equal(mcpToggleWish(rows[0]), null, 'and NO switch is offered — a direction would have to be guessed');
    assert.equal(mcpStatusLook(rows[0].status).key, 'chat.mcpStatusUnbekannt');
  });

  it('a nameless row is dropped (mcp_toggle has nothing to address it with)', () => {
    assert.deepEqual(mcpStatusRows({ mcpServers: [{ status: 'connected' }, { name: '  ', status: 'connected' }] }), []);
  });

  it('a missing mcpServers field yields no rows instead of an invented state', () => {
    assert.deepEqual(mcpStatusRows({}), []);
    assert.deepEqual(mcpStatusRows(null), []);
  });

  it('the wire enum is exactly the five the schema declares', () => {
    assert.deepEqual(MCP_WIRE_STATES, ['connected', 'failed', 'needs-auth', 'pending', 'disabled']);
  });

  it('counts for the menu head come from the read-back, and an unknown row counts as neither', () => {
    const s = mcpStatusSummary(mcpStatusRows(WIRE).concat(mcpStatusRows({ mcpServers: [{ name: 'q', status: 'nonsense' }] })));
    assert.deepEqual(s, { total: 5, connected: 1, disabled: 1, broken: 2, pending: 0, unknown: 1 });
  });
});

describe('mcp-live — the verdict of a switch is the READ-BACK, never the request', () => {
  const rows = mcpStatusRows(WIRE);

  it('a confirmed switch-on says „on" (and the counter-case: off)', () => {
    assert.equal(mcpToggleVerdict({ wish: true, sent: { ok: true }, row: mcpRow(rows, 'alpha') }).state, 'on');
    assert.equal(mcpToggleVerdict({ wish: false, sent: { ok: true }, row: mcpRow(rows, 'delta') }).state, 'off');
  });

  it('NO read-back = unknown — the whole point: a timeout resolves `{ok:true}`', () => {
    const v = mcpToggleVerdict({ wish: true, sent: { ok: true, unconfirmed: true }, row: null });
    assert.equal(v.state, 'unknown');
    assert.equal(v.reason, 'no-status');
    assert.notEqual(v.state, 'off', 'the request „ok" must never become a position');
  });

  it('the session contradicting the wish is „ineffective", not a success', () => {
    // asked for ON, the session reports „disabled": the switch did not take
    const v = mcpToggleVerdict({ wish: true, sent: { ok: true }, row: mcpRow(rows, 'delta') });
    assert.equal(v.state, 'ineffective');
    assert.equal(v.status, 'disabled');
  });

  it('„enabled, but the connection failed" is ineffective WITH the server\'s own error', () => {
    // This is the arm a green „eingeschaltet" would hide: the toggle did what it was told and the server is
    // unusable. The CLI itself refuses such a dial („Connection failed"), but the same state is reachable
    // through a timeout + read-back, and then only this arm is left to tell the truth.
    const v = mcpToggleVerdict({ wish: true, sent: { ok: true, unconfirmed: true }, row: mcpRow(rows, 'gamma') });
    assert.equal(v.state, 'ineffective');
    assert.equal(v.error, 'spawn ENOENT');
    assert.equal(v.unconfirmed, true, 'and the provenance survives: nobody answered the switch itself');
  });

  it('„pending" is unknown — a server mid-dial is not a verdict', () => {
    const v = mcpToggleVerdict({ wish: true, sent: { ok: true, unconfirmed: true }, row: { name: 'p', status: 'pending' } });
    assert.equal(v.state, 'unknown');
    assert.equal(v.reason, 'pending');
  });

  it('a refusal is a refusal, with the CLI\'s own wording — and is NOT called unconfirmed', () => {
    const v = mcpToggleVerdict({ wish: true, sent: { ok: false, error: 'Server not found: zzz' }, row: null });
    assert.equal(v.state, 'refused');
    assert.equal(v.error, 'Server not found: zzz');
  });

  it('an unconfirmed switch whose read-back MATCHES is believed — with provenance', () => {
    // Deliberately different from adoptUltracodeState, which discards a read-back after a timeout: there
    // the read reports the same FIELD before and after, here „disabled" can only be true if the disable ran.
    const v = mcpToggleVerdict({ wish: false, sent: { ok: true, unconfirmed: true }, row: mcpRow(rows, 'delta') });
    assert.equal(v.state, 'off');
    assert.equal(v.unconfirmed, true);
  });

  it('a reconnect is judged by the SAME mapper the CLI uses for both subtypes', () => {
    assert.equal(mcpReconnectVerdict({ sent: { ok: true }, row: mcpRow(rows, 'alpha') }).state, 'on');
    assert.equal(mcpReconnectVerdict({ sent: { ok: true }, row: mcpRow(rows, 'beta') }).state, 'ineffective');
    assert.equal(mcpReconnectVerdict({ sent: { ok: true }, row: null }).state, 'unknown');
  });

  it('„neu verbinden" is offered for failed/needs-auth — and NOT for a server awaiting approval', () => {
    assert.equal(mcpCanReconnect(mcpRow(rows, 'gamma')), true);
    assert.equal(mcpCanReconnect(mcpRow(rows, 'beta')), true, 'the 401 case is exactly what the button is for');
    assert.equal(mcpCanReconnect(mcpRow(rows, 'alpha')), false);
    assert.equal(mcpCanReconnect(mcpRow(rows, 'delta')), false, 'a disabled server is refused by the handler');
    // APPROVAL_REQUIRED also arrives as needs-auth, but a reconnect of a not-yet-approved project server is
    // refused — a button whose only outcome is that refusal is worse than no button.
    assert.equal(mcpCanReconnect({ name: 'p', status: 'needs-auth', errorCode: 'APPROVAL_REQUIRED' }), false);
  });

  it('reports what each state MEANS for the switch (the three answers a verdict is built on)', () => {
    assert.equal(mcpReported(null), 'none');
    assert.equal(mcpReported({ status: 'connected' }), 'on');
    assert.equal(mcpReported({ status: 'disabled' }), 'off');
    assert.equal(mcpReported({ status: 'pending' }), 'open');
    assert.equal(mcpReported({ status: 'failed' }), 'half');
  });
});

describe('mcp-live — configured ≠ in this session (--strict-mcp-config)', () => {
  it('splits the three groups, so only the reachable ones get a live switch', () => {
    // A tab launched with a narrow --mcp-config knows only its own set; mcp_toggle answers „Server not
    // found" for the rest. That is why the checkbox + restart path has to stay for `extra`.
    const s = mcpSplitConfigured(['alpha', 'beta', 'zeta'], mcpStatusRows(WIRE));
    assert.deepEqual(s.live, ['alpha', 'beta']);
    assert.deepEqual(s.extra, ['zeta'], 'configured but not in this session → only a restart can add it');
    assert.deepEqual(s.unlisted, ['gamma', 'delta'], 'in the session but not in the machine config (dynamic/sdk/plugin)');
  });
  it('without a read-back nothing is „not in this session" — everything is just the start selection', () => {
    const s = mcpSplitConfigured(['alpha'], []);
    assert.deepEqual(s, { live: [], extra: ['alpha'], unlisted: [] });
  });
});

// =====================================================================================================
describe('the VISIBLE half — public/js/chat.js may not claim what it did not read', () => {
  it('mcpLiveRead: an `unconfirmed` answer yields null, NOT an empty server list', () => {
    const e = liveEnv({ api: fakeApi(() => ({ ok: true, unconfirmed: true, mcpServers: [] })) });
    const fn = loadChat(['mcpLiveRead'], e);
    return fn.mcpLiveRead({ id: 'c1' }).then((rows) => {
      assert.equal(rows, null, 'an empty list would render as „diese Sitzung hat keine MCP-Server" — a claim');
    });
  });

  it('mcpLiveRead: a tab without a process asks nothing at all', () => {
    const e = liveEnv({ api: fakeApi(() => assert.fail('no request may go out without a chat id')) });
    const fn = loadChat(['mcpLiveRead'], e);
    return fn.mcpLiveRead({}).then((rows) => assert.equal(rows, null));
  });

  it('mcpLiveRead: a dead session (409) is quiet, any other failure is logged — and never invents rows', () => {
    const e = liveEnv({ api: fakeApi(() => Object.assign(new Error('gone'), { status: 409 })) });
    let fn = loadChat(['mcpLiveRead'], e);
    return fn.mcpLiveRead({ id: 'c1' }).then((rows) => {
      assert.equal(rows, null);
      assert.deepEqual(e.logEvent.got, [], '409 is the normal end of a session, not news');
      const e2 = liveEnv({ api: fakeApi(() => Object.assign(new Error('boom'), { status: 500 })) });
      fn = loadChat(['mcpLiveRead'], e2);
      return fn.mcpLiveRead({ id: 'c1' }).then((r2) => {
        assert.equal(r2, null);
        assert.equal(e2.logEvent.got.length, 1, 'a server that breaks must not fail silently');
        assert.match(e2.logEvent.got[0][0], /mcpLiveStatusUnlesbar/);
      });
    });
  });

  it('applyMcpLive: posts to mcp-toggle with the measured body and forms the verdict from the read-back', async () => {
    const e = liveEnv({ api: fakeApi(() => ({ ok: true, server: 'delta', requested: true, mcpServers: [{ name: 'delta', status: 'connected', serverInfo: { name: 'delta', version: '1' } }] })) });
    const fn = loadChat(['mcpLiveToast', 'applyMcpLive'], e);
    const r = await fn.applyMcpLive({ id: 'c1' }, 'delta', true);
    assert.equal(e.api.calls[0].url, '/api/chat/c1/mcp-toggle');
    assert.deepEqual(e.api.calls[0].body, { server: 'delta', enabled: true }, 'serverName + enabled are the only fields the CLI takes');
    assert.equal(r.verdict.state, 'on');
    assert.deepEqual(e.toast.got.map((a) => a[1]), ['ok'], 'a CONFIRMED switch is the only green one');
  });

  it('applyMcpLive: an unanswered switch is a STICKY error toast, not a green one', async () => {
    // The whole feature in one assertion: the route answered „ok" (a 40 s timeout still resolves ok) and
    // could not read the state back. „abgeschaltet" here would be the Ultracode lie all over again.
    const e = liveEnv({ api: fakeApi(() => ({ ok: true, unconfirmed: true, statusUnconfirmed: true, mcpServers: [] })) });
    const fn = loadChat(['mcpLiveToast', 'applyMcpLive'], e);
    const r = await fn.applyMcpLive({ id: 'c1' }, 'delta', false);
    assert.equal(r.verdict.state, 'unknown');
    assert.equal(e.toast.got[0][1], 'err', "'err' is also what makes the toast sticky (render.js) — this one may not be missed");
    assert.match(e.toast.got[0][0], /mcpLiveUnbestaetigt/);
  });

  it('applyMcpLive: a reconnect goes to its OWN route and sends no `enabled`', async () => {
    const e = liveEnv({ api: fakeApi(() => ({ ok: true, mcpServers: [{ name: 'beta', status: 'connected', serverInfo: { name: 'beta', version: '1' } }] })) });
    const fn = loadChat(['mcpLiveToast', 'applyMcpLive'], e);
    const r = await fn.applyMcpLive({ id: 'c1' }, 'beta', null);
    assert.equal(e.api.calls[0].url, '/api/chat/c1/mcp-reconnect');
    assert.deepEqual(e.api.calls[0].body, { server: 'beta' }, 'mcp_reconnect takes serverName and nothing else');
    assert.equal(r.verdict.state, 'on');
    assert.match(e.toast.got[0][0], /mcpReconnectBestaetigt/);
  });

  it('applyMcpLive: a switch that did not take is reported as such, with the reason', async () => {
    const e = liveEnv({ api: fakeApi(() => ({ ok: true, mcpServers: [{ name: 'delta', status: 'disabled' }] })) });
    const fn = loadChat(['mcpLiveToast', 'applyMcpLive'], e);
    const r = await fn.applyMcpLive({ id: 'c1' }, 'delta', true);
    assert.equal(r.verdict.state, 'ineffective');
    assert.equal(e.toast.got[0][1], 'err');
    assert.match(e.toast.got[0][0], /mcpLiveUnwirksam/);
    assert.match(e.toast.got[0][0], /mcpStatusDisabled/, 'and it names what the session reports instead');
  });

  it('mcpLiveControls: a row renders the dot, the state word and exactly the switches that can work', () => {
    const e = liveEnv();
    const fn = loadChat(['mcpLiveControls'], e);
    const row = fakeEl('div', 'mcp-row');
    fn.mcpLiveControls(row, { id: 'c1' }, mcpRow(mcpStatusRows(WIRE), 'beta'), liveState(), () => {});
    const classes = row.children.map((c) => c.className);
    assert.ok(classes.some((c) => /mcp-dot warn/.test(c)), 'needs-auth is a warning, not a failure');
    assert.ok(row.children.some((c) => c.textContent === 'chat.mcpStatusNeedsAuth'), 'the state is NAMED, not only coloured');
    const btns = row.children.filter((c) => c.tag === 'button');
    assert.equal(btns.length, 2, 'ausschalten + neu verbinden');
    // the reconnect is a glyph (a second text button wrapped every broken row in the real popover), so the
    // words have to be reachable for a screen reader and on hover
    assert.equal(btns[1].textContent, '↻');
    assert.match(btns[1].title, /mcpLiveNeuVerbinden/);
    assert.match(btns[1].attrs['aria-label'], /mcpLiveNeuVerbinden/);
    // the tooltip carries what does not fit in a 320px row: the server's error, version, scope, URL
    assert.match(row.children[0].title, /example\.invalid/);
  });

  it('mcpLiveControls: an unknown status offers NO switch (a direction would have to be guessed)', () => {
    const e = liveEnv();
    const fn = loadChat(['mcpLiveControls'], e);
    const row = fakeEl('div', 'mcp-row');
    fn.mcpLiveControls(row, { id: 'c1' }, { name: 'x', status: '', statusRaw: 'cached' }, liveState(), () => {});
    assert.equal(row.children.filter((c) => c.tag === 'button').length, 0);
  });

  it('mcpLiveControls: an unconfirmed switch leaves a CHIP on the row, not just a vanishing toast', () => {
    const e = liveEnv();
    const fn = loadChat(['mcpLiveControls'], e);
    const row = fakeEl('div', 'mcp-row');
    fn.mcpLiveControls(row, { id: 'c1' }, mcpRow(mcpStatusRows(WIRE), 'alpha'), liveState({ marks: { alpha: { state: 'unknown', reason: 'no-status' } } }), () => {});
    const note = row.children.find((c) => /mcp-note/.test(c.className));
    assert.ok(note, 'the toast is gone in four seconds, the row stays — so the row has to say it');
    assert.equal(note.textContent, 'chat.mcpLiveUnbestaetigtKurz');
    assert.match(note.className, /bad/);
  });

  it('mcpLiveControls: a CONFIRMED switch whose request went unanswered says so quietly', () => {
    const e = liveEnv();
    const fn = loadChat(['mcpLiveControls'], e);
    const row = fakeEl('div', 'mcp-row');
    fn.mcpLiveControls(row, { id: 'c1' }, mcpRow(mcpStatusRows(WIRE), 'alpha'), liveState({ marks: { alpha: { state: 'on', unconfirmed: true } } }), () => {});
    const note = row.children.find((c) => /mcp-note/.test(c.className));
    assert.equal(note.textContent, 'chat.mcpLiveOhneAntwortKurz');
    assert.doesNotMatch(note.className, /bad/, 'the state WAS read back — provenance, not a failure');
  });

  it('mcpLiveControls: a switch IN FLIGHT says so and cannot be clicked again — out of the model, not the DOM', () => {
    // `draw()` empties the list and rebuilds every row, so the run state had to leave the button element: the
    // answer of ANOTHER row rebuilt this one with a fresh, enabled „ausschalten" over a switch that was still
    // dialling (up to 75 s for a reconnect), and a second click went out on the same server.
    const e = liveEnv();
    const fn = loadChat(['mcpLiveControls'], e);
    const row = fakeEl('div', 'mcp-row');
    fn.mcpLiveControls(row, { id: 'c1' }, mcpRow(mcpStatusRows(WIRE), 'beta'), liveState({ busy: { beta: true } }), () => {});
    const btns = row.children.filter((c) => c.tag === 'button');
    assert.equal(btns[0].textContent, 'chat.mcpLiveLaeuft');
    assert.equal(btns[0].disabled, true);
    assert.equal(btns[1].disabled, true, 'and „neu verbinden" is a switch on the same server too');
    assert.equal(row.children.filter((c) => /mcp-note/.test(c.className)).length, 0, 'no chip beside „schaltet…": the previous verdict no longer describes this row');
  });

  it('mcpLiveControls: a FAILED switch stops the row claiming „schaltet…" — and repaints', async () => {
    // The old catch reset `disabled` and left the label: an enabled button reading „schaltet…" over a switch
    // that had already failed, with no chip anywhere and no repaint — only the sticky toast told the truth.
    const e = liveEnv({ api: fakeApi(() => new Error('process not running')) });
    const fn = loadChat(['mcpLiveToast', 'applyMcpLive', 'mcpLiveControls'], e);
    const state = liveState({ rows: mcpStatusRows(WIRE) });
    const draws = [];
    const redraw = () => draws.push({ busy: !!state.busy.alpha, mark: state.marks.alpha });
    const row = fakeEl('div', 'mcp-row');
    fn.mcpLiveControls(row, { id: 'c1' }, mcpRow(state.rows, 'alpha'), state, redraw);
    const btn = row.children.find((c) => c.tag === 'button');
    await btn.onclick({ stopPropagation: () => {}, preventDefault: () => {} });
    assert.deepEqual(draws.map((d) => d.busy), [true, false], 'both edges repaint — the failure edge is the one that was missing');
    assert.equal(state.busy.alpha, false, 'nothing may stay „schaltet…" after an answer');
    assert.equal(state.marks.alpha.state, 'refused');
    assert.equal(state.marks.alpha.error, 'process not running');
    assert.deepEqual(e.toast.got, [['process not running', 'err']]);
    // …and the rebuilt row is the honest one: a usable button plus the refusal as a chip
    const again = fakeEl('div', 'mcp-row');
    fn.mcpLiveControls(again, { id: 'c1' }, mcpRow(state.rows, 'alpha'), state, redraw);
    const b2 = again.children.find((c) => c.tag === 'button');
    assert.equal(b2.textContent, 'chat.mcpLiveAus');
    assert.equal(b2.disabled, false);
    assert.equal(again.children.find((c) => /mcp-note/.test(c.className)).textContent, 'chat.mcpLiveAbgelehntKurz');
  });

  it('the live buttons stop the click from reaching the row (the <label> would toggle the checkbox)', () => {
    // Not cosmetic and not theoretical: the checkbox is the START selection, so a „neu verbinden" that
    // also ticks it would change what the next restart launches.
    const src = liftFn(CHAT_SRC, 'mcpLiveControls', 'public/js/chat.js');
    const handlers = src.match(/^ *b\.onclick = .*$/gm) || [];
    assert.equal(handlers.length, 2, 'both buttons must have a handler');
    for (const h of handlers) {
      assert.match(h, /e\.stopPropagation\(\)/);
      assert.match(h, /e\.preventDefault\(\)/);
    }
  });
});

// =====================================================================================================
// The MENU. pickTabMcp is the ONLY place where mcpLiveRead, mcpSplitConfigured, mcpStatusSummary, mcpRow and
// mcpLiveControls are wired together — and it was the one function of the whole feature that no test ran.
// Proven, not assumed: replacing its `await mcpLiveRead(t)` with `null` removes the entire live half (no
// mcp_status is ever read, the menu falls back to the old checklist) and 125 tests stayed green. That is
// literally the failure this repo has a rule about: „the visible half was untested, a one-word rename made
// the feature mute, and 123 tests stayed green".
// =====================================================================================================
describe('the MENU — pickTabMcp is where the live half is actually wired', () => {
  const CONFIGURED = ['alpha', 'beta', 'zeta'];
  // the one key whose SUBSTITUTION carries information: it has to report the read-back, not a constant
  const menuTt = (k) => (k === 'chat.mcpLiveKopf' ? '{n} von {m} verbunden' : k);
  function menuEnv(over) {
    const body = fakeEl('div', 'body');
    const e = liveEnv(Object.assign({
      tt: menuTt, closeTabMenu: () => {}, $: () => null, document: { body },
      positionMenuAt: () => {}, autoCloseOnOutside: () => {}, applyTabMcp: recorder(),
      mcpLiveRead: null, applyMcpLive: null, mcpLiveToast: null, mcpLiveControls: null, pickTabMcp: null,
    }, over || {}));
    e.body = body;
    return e;
  }
  // everything the menu needs, lifted TOGETHER — so the read really goes through api() and not through a stub
  const loadMenu = (e) => loadChat(['mcpLiveRead', 'mcpLiveToast', 'applyMcpLive', 'mcpLiveControls', 'pickTabMcp'], e);
  const answer = (status) => (url) => {
    if (url === '/api/mcp/configured') return { servers: CONFIGURED.map((n) => ({ name: n })) };
    if (/\/mcp-status$/.test(url)) return status();
    if (/\/mcp-(toggle|reconnect)$/.test(url)) return status();
    throw new Error('unexpected url ' + url);
  };
  const listOf = (e) => e.body.children[0].children[1];
  const rowOf = (listEl, name) => listEl.children.find((c) => /mcp-row/.test(c.className)
    && descendants(c).some((d) => /mcp-name/.test(d.className) && d.textContent === name));
  const btnsOf = (row) => row.children.filter((c) => c.tag === 'button');

  it('asks the SESSION for its status and renders a dot, a state word and the switch that can work', async () => {
    const e = menuEnv({ api: fakeApi(answer(() => WIRE)) });
    await loadMenu(e).pickTabMcp({ id: 'c1' });
    assert.deepEqual(e.api.calls.map((c) => c.url), ['/api/mcp/configured', '/api/chat/c1/mcp-status'],
      'no mcp_status read = no live half at all, whatever the rest of the menu looks like');
    const listEl = listOf(e);
    // the live line FIRST, and it counts the read-back (1 of 4 connected in WIRE)
    assert.equal(listEl.children[0].textContent, '1 von 4 verbunden');
    assert.match(listEl.children[0].className, /mcp-sub/);
    // the order is mcpSplitConfigured's: in this session → session-only → configured but absent
    assert.deepEqual(listEl.children.filter((c) => /mcp-row/.test(c.className))
      .map((c) => descendants(c).find((d) => /mcp-name/.test(d.className)).textContent),
      ['alpha', 'beta', 'gamma', 'delta', 'zeta']);
    const alpha = rowOf(listEl, 'alpha');
    assert.ok(descendants(alpha).some((d) => /mcp-dot ok/.test(d.className)), 'connected has no status dot');
    assert.ok(descendants(alpha).some((d) => d.textContent === 'chat.mcpStatusConnected'), 'the state is NAMED, not only coloured');
    assert.deepEqual(btnsOf(alpha).map((b) => b.textContent), ['chat.mcpLiveAus']);
    assert.deepEqual(btnsOf(rowOf(listEl, 'beta')).map((b) => b.textContent), ['chat.mcpLiveAus', '↻'], 'needs-auth is what the reconnect is for');
    assert.deepEqual(btnsOf(rowOf(listEl, 'delta')).map((b) => b.textContent), ['chat.mcpLiveAn'], 'disabled → the switch points the other way');
    // the checkbox half: it is the START selection, and only a configured name can be pre-ticked
    assert.ok(descendants(rowOf(listEl, 'alpha')).some((d) => d.tag === 'input' && d.checked));
    assert.ok(descendants(rowOf(listEl, 'gamma')).some((d) => /mcp-nobox/.test(d.className)), 'a session-only server has no start checkbox to tick');
    assert.equal(rowOf(listEl, 'zeta') && btnsOf(rowOf(listEl, 'zeta')).length, 0, 'not in this session → mcp_toggle cannot reach it');
    assert.ok(descendants(rowOf(listEl, 'zeta')).some((d) => d.textContent === 'chat.mcpLiveNichtInSitzung'));
    assert.equal(listEl.children[listEl.children.length - 1].textContent, 'chat.mcpLiveHinweis', 'the per-project warning belongs under a list that offers switches');
  });

  it('a status that could NOT be read says so — and offers no switch at all', async () => {
    // `{unconfirmed:true}` is what a timeout resolves to. The menu then falls back to the start selection,
    // which is the truth; inventing an off position out of it is the H1 defect.
    const e = menuEnv({ api: fakeApi(answer(() => ({ ok: true, unconfirmed: true, mcpServers: [] }))) });
    await loadMenu(e).pickTabMcp({ id: 'c1' });
    const listEl = listOf(e);
    assert.equal(listEl.children[0].textContent, 'chat.mcpLiveUnlesbar');
    assert.equal(descendants(listEl).filter((c) => c.tag === 'button').length, 0);
    assert.equal(descendants(listEl).filter((c) => /mcp-dot/.test(c.className)).length, 0);
    assert.ok(rowOf(listEl, 'zeta'), 'the checkbox half still works — that is the restart path');
    assert.ok(!descendants(listEl).some((d) => d.textContent === 'chat.mcpLiveNichtInSitzung'),
      'without a read-back nothing is „not in this session": there is nothing to compare against');
  });

  it('a tab with no process says „keine Sitzung" instead of reading anything', async () => {
    const e = menuEnv({ api: fakeApi(answer(() => assert.fail('a tab without an id has no session to ask'))) });
    await loadMenu(e).pickTabMcp({});
    assert.deepEqual(e.api.calls.map((c) => c.url), ['/api/mcp/configured']);
    assert.equal(listOf(e).children[0].textContent, 'chat.mcpLiveKeineSitzung');
  });

  it('the live line comes first even when there is nothing to list', async () => {
    // Observed in the real popover after a reload had left a stale chat id behind: the menu said „Keine
    // MCP-Server konfiguriert" — a statement about the MACHINE standing in for one about the session, whose
    // state could not be read at all. The live line is therefore unconditional and goes above the list.
    const e = menuEnv({ api: fakeApi((url) => (url === '/api/mcp/configured' ? { servers: [] } : { ok: true, unconfirmed: true })) });
    await loadMenu(e).pickTabMcp({ id: 'c1' });
    assert.deepEqual(listOf(e).children.map((c) => c.textContent), ['chat.mcpLiveUnlesbar', 'chat.keineMcpServerKonfiguriert']);
  });

  it('switching a server from the menu posts the toggle and repaints the row from the ANSWER', async () => {
    let served = WIRE;
    const e = menuEnv({ api: fakeApi(answer(() => served)) });
    await loadMenu(e).pickTabMcp({ id: 'c1' });
    // the answer reports alpha as disabled afterwards — the row has to follow the read-back, not the wish
    served = { ok: true, mcpServers: [Object.assign({}, WIRE.mcpServers[0], { status: 'disabled', serverInfo: undefined, tools: undefined })].concat(WIRE.mcpServers.slice(1)) };
    await btnsOf(rowOf(listOf(e), 'alpha'))[0].onclick({ stopPropagation: () => {}, preventDefault: () => {} });
    const toggle = e.api.calls.find((c) => /mcp-toggle$/.test(c.url));
    assert.ok(toggle, 'no toggle was sent');
    assert.deepEqual(toggle.body, { server: 'alpha', enabled: false });
    const alpha = rowOf(listOf(e), 'alpha');
    assert.ok(descendants(alpha).some((d) => d.textContent === 'chat.mcpStatusDisabled'), 'the row still shows the OLD state');
    assert.deepEqual(btnsOf(alpha).map((b) => b.textContent), ['chat.mcpLiveAn'], 'and the switch has turned around');
    assert.deepEqual(e.toast.got.map((t) => t[1]), ['ok'], 'a confirmed switch is the only green one');
    assert.equal(listOf(e).children[0].textContent, '0 von 4 verbunden', 'the head counts the fresh read-back');
  });

  it('a switch whose state cannot be read back leaves the „unbestätigt" chip ON the row', async () => {
    // The repaint rebuilds every row from the read-back. Without the menu's own `marks` the chip would be
    // dropped and the row would fall back to a plain status word — the optimistic reading of a request
    // nobody answered, which is the whole defect this feature exists for.
    let served = WIRE;
    const e = menuEnv({ api: fakeApi(answer(() => served)) });
    await loadMenu(e).pickTabMcp({ id: 'c1' });
    served = { ok: true, unconfirmed: true, statusUnconfirmed: true, mcpServers: [] };
    await btnsOf(rowOf(listOf(e), 'alpha'))[0].onclick({ stopPropagation: () => {}, preventDefault: () => {} });
    const alpha = rowOf(listOf(e), 'alpha');
    assert.equal(descendants(alpha).find((d) => /mcp-note/.test(d.className)).textContent, 'chat.mcpLiveUnbestaetigtKurz');
    assert.equal(e.toast.got[0][1], 'err', "'err' is also what makes the toast sticky (render.js)");
  });

  it('while a switch is in flight the row says „schaltet…" and the button is dead — even after a repaint', async () => {
    // The bug this pins: the run state lived in the button element and `draw()` throws every row away, so the
    // next answer handed the user a fresh, enabled button over a switch that was still running.
    let release;
    const held = new Promise((r) => { release = r; });
    const e = menuEnv({ api: fakeApi((url) => (url === '/api/mcp/configured' ? { servers: CONFIGURED.map((n) => ({ name: n })) }
      : /\/mcp-status$/.test(url) ? WIRE : held)) });
    await loadMenu(e).pickTabMcp({ id: 'c1' });
    const click = btnsOf(rowOf(listOf(e), 'beta'))[0].onclick({ stopPropagation: () => {}, preventDefault: () => {} });
    // the repaint has already happened — synchronously, before the request is awaited
    const busyRow = rowOf(listOf(e), 'beta');
    assert.equal(btnsOf(busyRow)[0].textContent, 'chat.mcpLiveLaeuft');
    assert.equal(btnsOf(busyRow)[0].disabled, true);
    assert.equal(btnsOf(busyRow)[1].disabled, true);
    // …and it survives a repaint caused by ANOTHER row, which is how the old version lost it
    assert.deepEqual(btnsOf(rowOf(listOf(e), 'alpha')).map((b) => b.disabled), [false], 'only the switched server is blocked');
    release({ ok: true, mcpServers: [{ name: 'beta', status: 'disabled' }] });
    await click;
    const done = rowOf(listOf(e), 'beta');
    assert.equal(btnsOf(done)[0].textContent, 'chat.mcpLiveAn');
    assert.equal(btnsOf(done)[0].disabled, false);
  });

  it('a switch that throws leaves a usable button and the refusal on the row, not a frozen „schaltet…"', async () => {
    const e = menuEnv({ api: fakeApi((url) => (url === '/api/mcp/configured' ? { servers: CONFIGURED.map((n) => ({ name: n })) }
      : /\/mcp-status$/.test(url) ? WIRE : new Error('process not running'))) });
    await loadMenu(e).pickTabMcp({ id: 'c1' });
    await btnsOf(rowOf(listOf(e), 'alpha'))[0].onclick({ stopPropagation: () => {}, preventDefault: () => {} });
    const alpha = rowOf(listOf(e), 'alpha');
    assert.equal(btnsOf(alpha)[0].textContent, 'chat.mcpLiveAus', 'a button reading „schaltet…" over a failed switch is a claim nobody made');
    assert.equal(btnsOf(alpha)[0].disabled, false);
    assert.equal(descendants(alpha).find((d) => /mcp-note/.test(d.className)).textContent, 'chat.mcpLiveAbgelehntKurz');
    assert.deepEqual(e.toast.got, [['process not running', 'err']]);
  });

  it('a menu closed while the status is in flight paints nothing', async () => {
    // `autoCloseOnOutside` can remove the popover during the read; drawing into a detached node would leave
    // the next opening with a stale list.
    const e = menuEnv({ api: fakeApi(answer(() => WIRE)) });
    const fn = loadMenu(e);
    const done = fn.pickTabMcp({ id: 'c1' });
    e.body.children[0].remove();
    await done;
    assert.equal(listOf(e).children.length, 1, 'only the „lade…" placeholder it started with');
  });
});

describe('the routes exist and refuse what the CLI would only refuse later', () => {
  it('server.js carries all three MCP actions', () => {
    for (const a of ['mcp-status', 'mcp-toggle', 'mcp-reconnect']) {
      assert.ok(SERVER_SRC.includes("action === '" + a + "'"), 'missing route branch for ' + a);
    }
  });
  it('the toggle validates server + enabled at the edge instead of forwarding junk', () => {
    const branch = SERVER_SRC.slice(SERVER_SRC.indexOf("action === 'mcp-toggle'"));
    assert.match(branch.slice(0, 1200), /error: 'server required'/);
    assert.match(branch.slice(0, 1200), /enabled must be a boolean/);
  });
  it('mcp_status is read with noBroadcast — a gauge read may not fill every SSE stream', () => {
    const lib = fs.readFileSync(path.join(ROOT, 'lib', 'chat.js'), 'utf8');
    const fn = liftFn(lib, 'getMcpStatus', 'lib/chat.js');
    assert.match(fn, /noBroadcast: true/);
  });
  it('a toggle gets a ceiling of its own — 5 s would report every honest dial as unconfirmed', () => {
    const lib = fs.readFileSync(path.join(ROOT, 'lib', 'chat.js'), 'utf8');
    assert.match(lib, /const MCP_CONTROL_TIMEOUT_MS = (\d+)/);
    const ms = Number(/const MCP_CONTROL_TIMEOUT_MS = (\d+)/.exec(lib)[1]);
    // measured: MCP_CONNECT_TIMEOUT_MS default 5000 + MCP_TIMEOUT (tools/list) default 30000
    assert.ok(ms >= 35000, 'the measured worst case for an enable is 5 s dial + 30 s tools/list, got ' + ms);
  });
});

// =====================================================================================================
// End to end. Everything above runs against fixtures; this drives the REAL engine (lib/chat.js — the same
// controlRequest the route uses) against fake-claude's control channel. So a drifted schema, a route that
// stops reading the answer, or a timeout that swallows the verdict fails HERE and not in a menu.
// =====================================================================================================
process.env.CLAUDE_UI_FAKE_BIN = path.join(__dirname, '..', 'fake-claude.js').replace(/\\/g, '/');
process.env.FAKE_CLAUDE_MCP_SERVERS = JSON.stringify([
  { name: 'alpha', status: 'connected', tools: ['a', 'b'], scope: 'user' },
  { name: 'beta', status: 'needs-auth', errorCode: 'CLAUDEAI_BEARER_REJECTED', next: 'connected' },
  { name: 'gamma', status: 'disabled', next: 'failed', error: 'spawn ENOENT' },
  // The two rows the F1 test below needs: a secret in a HEADER (http) and one in ENV (stdio). The real CLI
  // puts both here in the clear — measured against 2.1.288, a probe token came back as
  // ‚Authorization: Bearer …‘ at scope 'dynamic', and still did after the server was disabled.
  { name: 'delta', status: 'connected', url: 'https://example.invalid/mcp', scope: 'dynamic',
    headers: { Authorization: 'Bearer LEAK-CANARY-AAA111', 'X-Internal-Token': 'LEAK-CANARY-BBB222' } },
  { name: 'epsilon', status: 'connected', command: 'node srv.js', env: { GH_PAT: 'LEAK-CANARY-CCC333' } },
]);
const { startChat, killChat, getMcpStatus, setMcpEnabled, reconnectMcp } = require('../lib/chat');

describe('G4 end to end — the control channel really answers these three subtypes', () => {
  const withChat = async (fn) => {
    const chat = startChat({ cwd: ROOT, permissionMode: 'plan' });
    try { return await fn(chat); } finally { try { killChat(chat); } catch { /* */ } }
  };

  it('mcp_status answers with no turn, no message and no cost', async () => {
    const r = await withChat((chat) => getMcpStatus(chat));
    assert.ok(r.ok && r.servers, 'no status came back: ' + JSON.stringify(r));
    const rows = mcpStatusRows({ mcpServers: r.servers });
    // Die zwei Kanarienvogel-Zeilen (delta/epsilon) gehören dazu — sie stehen in derselben Fixture und
    // tragen die Geheimnisse für den F1-Test unten. Die Liste ist bewusst vollständig statt gefiltert: eine
    // Zeile, die die Reihenfolge ändert oder verschwindet, soll hier auffallen.
    assert.deepEqual(rows.map((x) => x.name + ':' + x.status),
      ['alpha:connected', 'beta:needs-auth', 'gamma:disabled', 'delta:connected', 'epsilon:connected']);
    assert.equal(mcpRow(rows, 'alpha').tools, 2);
  });

  it('switching OFF is confirmed by the following read-back', async () => {
    const r = await withChat((chat) => setMcpEnabled(chat, 'alpha', false));
    assert.equal(r.ok, true);
    assert.equal(r.unconfirmed, false);
    const v = mcpToggleVerdict({ wish: false, sent: r, row: mcpRow(mcpStatusRows({ mcpServers: r.servers }), 'alpha') });
    assert.equal(v.state, 'off');
  });

  it('an enable that CANNOT connect comes back as an error, not as an ok', async () => {
    // the CLI's verdict mapper: type 'failed' → error „Connection failed" / anything non-connected →
    // „Server status: <type>". So the panel must not have to see through a success here.
    const r = await withChat((chat) => setMcpEnabled(chat, 'gamma', true));
    assert.equal(r.ok, false);
    assert.match(r.error, /ENOENT|Connection failed|Server status/);
    const v = mcpToggleVerdict({ wish: true, sent: r, row: mcpRow(mcpStatusRows({ mcpServers: r.servers }), 'gamma') });
    assert.equal(v.state, 'refused');
  });

  it('a server the session does not have is refused by name (the --strict-mcp-config case)', async () => {
    const r = await withChat((chat) => setMcpEnabled(chat, 'does-not-exist', true));
    assert.equal(r.ok, false);
    assert.match(r.error, /Server not found: does-not-exist/);
  });

  it('a reconnect fixes the 401 case and the read-back proves it', async () => {
    const r = await withChat((chat) => reconnectMcp(chat, 'beta'));
    assert.equal(r.ok, true);
    const v = mcpReconnectVerdict({ sent: r, row: mcpRow(mcpStatusRows({ mcpServers: r.servers }), 'beta') });
    assert.equal(v.state, 'on');
  });

  it('a CLI that never answers the switch produces `unconfirmed` — and the state is read anyway', async () => {
    // The measured worry: a dial can outrun any ceiling. With a short one set here, the toggle times out —
    // and the free status read is what still answers the user's question.
    process.env.CLAUDE_UI_MCP_TIMEOUT_MS = '400';
    process.env.FAKE_CLAUDE_MCP_SILENT = '1';
    try {
      const r = await withChat((chat) => setMcpEnabled(chat, 'beta', true));
      assert.equal(r.unconfirmed, true, 'nobody answered the toggle');
      assert.equal(r.ok, true, 'controlRequest resolves ok on a timeout — which is exactly why ok is not a verdict');
      assert.ok(r.servers, 'the status read must still work: it is a different, synchronous handler');
      // The fake applies the enable before it falls silent, so the read-back shows it — and the verdict
      // carries the provenance rather than swallowing it.
      const v = mcpToggleVerdict({ wish: true, sent: r, row: mcpRow(mcpStatusRows({ mcpServers: r.servers }), 'beta') });
      assert.equal(v.unconfirmed, true);
      assert.ok(['on', 'unknown'].includes(v.state), 'got ' + v.state);
    } finally {
      delete process.env.CLAUDE_UI_MCP_TIMEOUT_MS;
      delete process.env.FAKE_CLAUDE_MCP_SILENT;
    }
  });
});

// =====================================================================================================
// F1 for the live path. The sibling rule is written down in lib/mcp.js („Never returns env/headers — callers
// hand this to the browser") and pinned by test/mcp.test.js; this is the same rule one path later, and it was
// NOT held: measured against a real 2.1.288, every `mcp_status` row of an http/sse server carries
// `config.headers` in the clear, and the three new routes handed those rows to the browser verbatim. On this
// machine that is a live PAT (the `jira` server is type=http with a header token).
// The canaries are deliberately in TWO shapes — a header whose name says „secret" and one whose name says
// nothing (`X-Internal-Token`), plus a stdio `env` entry. The second one is why this is an allow-list and not
// maskSecrets(): a per-key-NAME masker lets a harmless-looking name through.
// =====================================================================================================
describe('G4 F1 — no secret from `config` survives into what the panel receives', () => {
  const CANARIES = ['LEAK-CANARY-AAA111', 'LEAK-CANARY-BBB222', 'LEAK-CANARY-CCC333'];

  it('getMcpStatus strips everything from `config` the UI does not read', async () => {
    const chat = startChat({ cwd: ROOT, permissionMode: 'plan' });
    let r;
    try { r = await getMcpStatus(chat); } finally { try { killChat(chat); } catch { /* */ } }
    assert.ok(r.ok && r.servers, 'no status came back: ' + JSON.stringify(r));
    // the fixture really did send them — otherwise this test would pass by measuring nothing
    const raw = JSON.parse(process.env.FAKE_CLAUDE_MCP_SERVERS);
    assert.ok(raw.some((x) => x.headers) && raw.some((x) => x.env), 'the fixture lost its secret-bearing rows');
    const body = JSON.stringify(r.servers);
    for (const c of CANARIES) assert.ok(!body.includes(c), c + ' reached the panel payload: ' + body.slice(0, 400));
    assert.ok(!/"headers"/.test(body) && !/"env"/.test(body), 'headers/env survived as a key: ' + body.slice(0, 400));
    // …and the two fields the menu DOES read are still there, or the fix would have broken the feature
    const delta = r.servers.find((x) => x.name === 'delta');
    assert.ok(delta && delta.config, 'the http row lost its config entirely');
    assert.equal(delta.config.url, 'https://example.invalid/mcp');
    assert.equal(delta.config.type, 'http');
    // what was withheld is COUNTED, not silently gone — „this server has no configuration" would be a lie
    assert.equal(delta.config.withheld, 1, 'the two headers collapse into one withheld entry: ' + JSON.stringify(delta.config));
    const eps = r.servers.find((x) => x.name === 'epsilon');
    assert.equal(eps.config.type, 'stdio');
    assert.ok(eps.config.withheld >= 1, 'the stdio env was dropped without saying so');
  });
});

// …und dieselbe Probe für die ZWEI AKTIONSPFADE. Sie geben ebenfalls `servers` an den Browser
// (server.js: die toggle- und die reconnect-Route), und heute sind sie sauber — aber nur, weil beide intern
// getMcpStatus rufen. Genau das ist die Naht, an der ein späterer Fix wieder etwas durchlässt: wer die
// Rücklesung einmal durch einen direkten `r.data.mcpServers`-Zugriff ersetzt, umgeht die Positivliste, und
// ohne diesen Test wäre das wieder ein grüner Durchgang mit einem Token im Seitenrumpf.
describe('G4 F1 — auch die beiden AKTIONSpfade geben nichts Geheimes heraus', () => {
  const CANARIES = ['LEAK-CANARY-AAA111', 'LEAK-CANARY-BBB222', 'LEAK-CANARY-CCC333'];
  const clean = (r, wo) => {
    assert.ok(r && r.servers, wo + ': keine Zeilen zurück — der Test hätte nichts gemessen: ' + JSON.stringify(r));
    const body = JSON.stringify(r.servers);
    for (const c of CANARIES) assert.ok(!body.includes(c), wo + ': ' + c + ' erreichte die Antwort');
    assert.ok(!/"headers"/.test(body) && !/"env"/.test(body), wo + ': headers/env überlebten als Schlüssel');
    // …und die zwei Felder, die das Menü liest, sind noch da — sonst wäre „dicht" nur „leer"
    const delta = r.servers.find((x) => x.name === 'delta');
    assert.ok(delta && delta.config && delta.config.url, wo + ': die http-Zeile verlor ihre url');
  };

  it('setMcpEnabled gibt die eingedampften Zeilen zurück', async () => {
    const chat = startChat({ cwd: ROOT, permissionMode: 'plan' });
    let r; try { r = await setMcpEnabled(chat, 'delta', false); } finally { try { killChat(chat); } catch { /* */ } }
    clean(r, 'setMcpEnabled');
  });

  it('reconnectMcp ebenso', async () => {
    const chat = startChat({ cwd: ROOT, permissionMode: 'plan' });
    let r; try { r = await reconnectMcp(chat, 'delta'); } finally { try { killChat(chat); } catch { /* */ } }
    clean(r, 'reconnectMcp');
  });
});
