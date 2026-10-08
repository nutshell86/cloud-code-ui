'use strict';
// Route contracts for the two features added together: the ultracode switch (global default + the
// pre-start support probe) and the prompt history (A13).
//
// Boots a throwaway server with CLAUDE_UI_DATA_DIR and CLAUDE_UI_CLAUDE_DIR pointing at temp dirs, so
// neither the live ui-prefs.json of the running panel nor the user's own ~/.claude/history.jsonl is
// touched — the trap from #34, where a settings card under test wrote into the real prefs file.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(ROOT, 'fake-claude.js');

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* */ } resolve({ status: res.statusCode, body: d, json }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function waitUp(port, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await req(port, 'GET', '/api/state'); if (r.status === 200) return; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('server did not come up on :' + port);
}

describe('ultracode + prompt history routes (hermetic dirs)', () => {
  let S, dataDir, claudeDir;
  before(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-uc-data-'));
    claudeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-uc-claude-'));
    // a terminal history with one real-shaped line, so the merge has something from the CLI side
    fs.writeFileSync(path.join(claudeDir, 'history.jsonl'),
      '{"display":"aus dem terminal","pastedContents":{},"timestamp":1790000000000,"project":"C:\\\\WINDOWS\\\\system32","sessionId":"t1"}\n');
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, CLAUDE_UI_PORT: String(port), CLAUDE_UI_FAKE_BIN: FAKE, CLAUDE_UI_DATA_DIR: dataDir, CLAUDE_UI_CLAUDE_DIR: claudeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitUp(port);
    S = { port, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }) };
  });
  after(async () => {
    if (S) await S.stop();
    for (const d of [dataDir, claudeDir]) if (d) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
  });

  // ---- ultracode: the global default -------------------------------------------------------------
  it('ultracode is off by default and /api/state says so', async () => {
    const r = await req(S.port, 'GET', '/api/state');
    assert.equal(r.status, 200);
    assert.equal(r.json.prefs.ultracode, false, 'a feature nobody switched on must not read as on');
  });

  it('POST /api/prefs { ultracode } round-trips, and OFF removes the key instead of storing false', async () => {
    let r = await req(S.port, 'POST', '/api/prefs', { ultracode: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.ultracode, true);
    assert.equal((await req(S.port, 'GET', '/api/state')).json.prefs.ultracode, true, 'and it survives a fresh read');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'ui-prefs.json'), 'utf8'));
    assert.equal(onDisk.ultracode, true);

    r = await req(S.port, 'POST', '/api/prefs', { ultracode: false });
    assert.equal(r.json.ultracode, false);
    const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'ui-prefs.json'), 'utf8'));
    assert.ok(!('ultracode' in after), 'off = absent, so the file keeps saying nothing about it');
  });

  it('saving ultracode does not clobber the other prefs in the same file', async () => {
    await req(S.port, 'POST', '/api/prefs', { guardrails: 'nichts ohne Freigabe' });
    await req(S.port, 'POST', '/api/prefs', { ultracode: true });
    const st = (await req(S.port, 'GET', '/api/state')).json.prefs;
    assert.equal(st.guardrails, 'nichts ohne Freigabe', 'read-modify-write under one lock, not a fresh object');
    assert.equal(st.ultracode, true);
    await req(S.port, 'POST', '/api/prefs', { ultracode: false });
  });

  // ---- ultracode: can this model do it, before anything is running? -----------------------------
  it('GET /api/ultracode/support answers for any model and says where the answer came from', async () => {
    // The fake binary answers no `initialize`, so the probe fails and the mirrored table decides — which
    // is exactly the fallback path worth testing: it must still produce a usable verdict, not an error.
    const r = await req(S.port, 'GET', '/api/ultracode/support?model=' + encodeURIComponent('eu.anthropic.claude-haiku-4-5-20251001-v1:0'));
    assert.equal(r.status, 200);
    assert.equal(r.json.supported, false, 'Haiku 4.5 has no xhigh, so no ultracode');
    assert.ok(['cli', 'table'].includes(r.json.source), 'source was ' + r.json.source);
    assert.ok(Array.isArray(r.json.effortLevels));
  });

  it('an unknown model is not declared incapable (a wrong "no" would hide the switch for good)', async () => {
    const r = await req(S.port, 'GET', '/api/ultracode/support?model=claude-something-9');
    assert.equal(r.json.supported, true);
  });

  // ---- ultracode: the live switch reports what is REALLY in effect -------------------------------
  // This is the behaviour the whole design turns on, and the fake binary reproduces it exactly as
  // measured on 2.1.285: apply_flag_settings{ultracode:true} answers `success` even on a model that
  // cannot do it, and only get_settings reveals requested=true / ultracode=false.
  it('POST …/ultracode on a capable model → reported as in effect', async () => {
    const start = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT });
    const id = start.json.chatId;
    const r = await req(S.port, 'POST', `/api/chat/${id}/ultracode`, { on: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.requested, true);
    assert.equal(r.json.ultracode.state, 'on');
    assert.equal(r.json.ultracode.active, true);
    assert.equal(r.json.ultracode.reason, '');
    // …and GET settings agrees, which is what the chip reads when `init` arrives
    const g = await req(S.port, 'GET', `/api/chat/${id}/settings`);
    assert.equal(g.json.ultracode.state, 'on');
    await req(S.port, 'POST', `/api/chat/${id}/stop`, {});
  });

  it('…and on a model that cannot do it: accepted, NOT in effect, with the reason named', async () => {
    const start = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, model: 'claude-haiku-4-5' });
    const id = start.json.chatId;
    const r = await req(S.port, 'POST', `/api/chat/${id}/ultracode`, { on: true });
    assert.equal(r.status, 200, 'the CLI did not refuse it — so the route must not 4xx either');
    assert.equal(r.json.requested, true, 'the wish is reported as a wish…');
    assert.equal(r.json.ultracode.state, 'ineffective', '…and separately from the effect');
    assert.equal(r.json.ultracode.active, false);
    assert.equal(r.json.ultracode.reason, 'model', 'the user has to learn WHICH half is missing');
    assert.equal(r.json.ultracode.model, 'claude-haiku-4-5');
    await req(S.port, 'POST', `/api/chat/${id}/stop`, {});
  });

  it('a chat started WITH ultracode already reports it on, before any control request', async () => {
    // the spawn path: --settings {"ultracode":true} (the fake reads it from argv, like the real CLI)
    const start = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, ultracode: true });
    assert.equal(start.json.meta.ultracode, true, 'meta is the receipt of what was launched');
    assert.equal(start.json.meta.ultracodeWish, true, '…and the WISH, which a later read-out must not erase');
    const g = await req(S.port, 'GET', `/api/chat/${start.json.chatId}/settings`);
    assert.equal(g.json.ultracode.state, 'on');
    await req(S.port, 'POST', `/api/chat/${start.json.chatId}/stop`, {});
  });

  // ---- the live EFFORT switch, which is where Ultracode was being switched off ---------------------
  it('A0: a live effort change must not switch Ultracode off', async () => {
    // THE bug, end to end. claude.exe's stdio handler for apply_flag_settings clears ultracode when an
    // effort request carries no `ultracode` key AND the level actually differs — so every effort change in
    // the panel turned Ultracode off, and nothing re-read the state, so the chip kept claiming „an".
    // The level really has to CHANGE here: re-sending the current one hits the CLI's no-op exception and
    // would prove nothing. Launched at 'high', switched to 'low'.
    const start = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, ultracode: true, effort: 'high' });
    const id = start.json.chatId;
    assert.equal((await req(S.port, 'GET', `/api/chat/${id}/settings`)).json.ultracode.state, 'on', 'precondition');
    const e = await req(S.port, 'POST', `/api/chat/${id}/effort`, { effort: 'low' });
    assert.equal(e.status, 200);
    const g = await req(S.port, 'GET', `/api/chat/${id}/settings`);
    assert.equal(g.json.effort, 'low', 'the level really changed, so the coupling really was in play');
    assert.equal(g.json.ultracode.state, 'on', 'the effort change has to carry the ultracode wish along');
    assert.equal(g.json.ultracode.requested, true);
    await req(S.port, 'POST', `/api/chat/${id}/stop`, {});
  });

  it("POST …/effort answers with the session's own read-out, not with an echo of the request", async () => {
    // Over stdio an effortLevel the CLI does not act on is a SILENT success: the control response says
    // `success` and the state is simply not updated. So the request can never report its own failure, and
    // the only honest answer is what get_settings says afterwards. `requested` keeps the echo, separately.
    const start = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, ultracode: true, effort: 'medium' });
    const id = start.json.chatId;
    const r = await req(S.port, 'POST', `/api/chat/${id}/effort`, { effort: 'xhigh' });
    assert.equal(r.status, 200);
    assert.equal(r.json.requested, 'xhigh', 'what was asked for');
    assert.equal(r.json.effort, 'xhigh', 'what the session says it is on');
    assert.equal(r.json.unconfirmed, false, 'the session answered, so this one is a fact');
    assert.equal(r.json.ultracode.state, 'on', 'the chip is corrected by the very response that changed the effort');
    await req(S.port, 'POST', `/api/chat/${id}/stop`, {});
  });

  it("POST …/effort takes 'max' and '' (auto) live, and still refuses garbage and the pseudo-level", async () => {
    const start = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, effort: 'low' });
    const id = start.json.chatId;
    // 'max' was never session-scoped — the CLI validates effortLevel against low…max. Only this route's own
    // hand-written list said otherwise, and the price was a needless session restart.
    let r = await req(S.port, 'POST', `/api/chat/${id}/effort`, { effort: 'max' });
    assert.equal(r.status, 200);
    assert.equal(r.json.effort, 'max');
    // '' = auto = no explicit level. It travels as `effortLevel: null` and reads back as null — '' on the
    // wire would be a silent no-op, which is why the READ-BACK is the assertion that matters here.
    r = await req(S.port, 'POST', `/api/chat/${id}/effort`, { effort: '' });
    assert.equal(r.status, 200);
    assert.equal(r.json.effort, null, 'the CLI\'s own encoding of „no explicit level"');
    // …and 'ultracode' stays out of the effort dropdown for good: `effortLevel:"ultracode"` does exist in
    // the CLI, but it FORCES xhigh — the coupling this whole change removes. Ultracode is a switch of its
    // own, so „max + Ultracode" has to be reachable. 'auto' is not an input value anywhere either.
    for (const bad of ['ultracode', 'quatsch', 'LOW', 'xhigh ', 'auto']) {
      assert.equal((await req(S.port, 'POST', `/api/chat/${id}/effort`, { effort: bad })).status, 400, JSON.stringify(bad));
    }
    await req(S.port, 'POST', `/api/chat/${id}/stop`, {});
  });

  it("the route's accepted effort set is lib/chat's EFFORT_LEVELS ∪ {''} — not a second list", async () => {
    // The live route kept its own copy and it had drifted (no 'max'). Reading the SPAWN list here is what
    // turns a future divergence into a test failure instead of a level that mysteriously needs a restart.
    const { EFFORT_LEVELS } = require(path.join(ROOT, 'lib', 'chat'));
    const start = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT });
    const id = start.json.chatId;
    for (const lv of EFFORT_LEVELS) {
      assert.equal((await req(S.port, 'POST', `/api/chat/${id}/effort`, { effort: lv })).status, 200, lv + ' must be live-switchable');
    }
    assert.equal((await req(S.port, 'POST', `/api/chat/${id}/effort`, { effort: '' })).status, 200, 'and auto on top of them');
    await req(S.port, 'POST', `/api/chat/${id}/stop`, {});
  });

  it('the Ultracode wish survives a model change, and becomes effective again on a capable model', async () => {
    // `ultracodeAvailable` is computed from the CURRENT model, so a model change invalidates the verdict
    // without touching the wish. Both directions matter: the warning has to appear, and it has to go away
    // again without the user re-asking for something they never withdrew.
    const start = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, ultracode: true });
    const id = start.json.chatId;
    assert.equal((await req(S.port, 'GET', `/api/chat/${id}/settings`)).json.ultracode.state, 'on', 'precondition');
    assert.equal((await req(S.port, 'POST', `/api/chat/${id}/model`, { model: 'claude-haiku-4-5' })).status, 200);
    const g = await req(S.port, 'GET', `/api/chat/${id}/settings`);
    assert.equal(g.json.ultracode.state, 'ineffective', 'the model changed, the wish did not');
    assert.equal(g.json.ultracode.requested, true);
    assert.equal(g.json.ultracode.reason, 'model', 'and WHICH half is missing');
    await req(S.port, 'POST', `/api/chat/${id}/model`, { model: 'claude-sonnet-5' });
    assert.equal((await req(S.port, 'GET', `/api/chat/${id}/settings`)).json.ultracode.state, 'on', 'nothing was re-sent — the wish was still there');
    await req(S.port, 'POST', `/api/chat/${id}/stop`, {});
  });

  it("GET /api/ultracode/support reports a model's effort levels for a CONCRETE id, not only for an alias", async () => {
    // The route joined by `m.value === model`, which only ever matches an ALIAS ("sonnet") — while the
    // panel's dropdown holds concrete Bedrock ids. So `effortLevels` came back [] for every real dropdown
    // value and the per-model effort filter could never fire. The old test only checked Array.isArray.
    const r = await req(S.port, 'GET', '/api/ultracode/support?model=' + encodeURIComponent('eu.anthropic.claude-haiku-4-5-20251001-v1:0'));
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.effortLevels));
    assert.ok(!r.json.effortLevels.includes('xhigh'), 'Haiku 4.5 offers no xhigh, and the probe must be able to say so about a concrete id');
  });

  it('…and says whether that list was actually READ, because [] answers two questions', async () => {
    // `effortLevels: []` means both „the CLI listed this model and it has no levels at all" (Haiku 4.5,
    // measured) and „nobody could tell us", and the UI acted on them identically. The route is the only
    // side that knows which of the two it is, so it states it. Asserted as an INVARIANT against `source`
    // rather than as a fixed value, because whether the probe reaches the CLI here depends on the fake.
    for (const model of ['eu.anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-something-9', '']) {
      const r = await req(S.port, 'GET', '/api/ultracode/support?model=' + encodeURIComponent(model));
      assert.equal(typeof r.json.effortLevelsKnown, 'boolean', 'the browser may not be left to guess from an empty array (' + model + ')');
      assert.equal(r.json.effortLevelsKnown, r.json.source === 'cli',
        'the flag IS „the CLI\'s own list had an entry for this model" — ' + model + ' answered source=' + r.json.source);
    }
  });

  // ---- the headless opt-in half of the wire --------------------------------------------------------
  it('POST /api/uiskill/schedules persists the Ultracode opt-in and defaults it to OFF', async () => {
    // buildSpawnPolicy has always honoured `schedule.ultracode === true` (and deliberately never inherits
    // the GLOBAL switch headless) — this route simply never stored the field, so the switch was unreachable.
    const mk = (extra) => req(S.port, 'POST', '/api/uiskill/schedules', Object.assign({ name: 'uc-skill', timing: { type: 'interval', minutes: 60 }, enabled: false }, extra));
    let r = await mk({ ultracode: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.schedule.ultracode, true);
    const id = r.json.schedule.id;
    const list = await req(S.port, 'GET', '/api/uiskill/schedules');
    assert.equal(list.json.schedules.find((x) => x.id === id).ultracode, true, 'it has to survive the file, or the nightly run never sees it');
    // absent → off, and a truthy NON-true value → off as well: this is the one schedule field that can
    // multiply the spend of an unattended run, and `--max-budget-usd` does not bound a workflow's agents.
    assert.equal((await mk({})).json.schedule.ultracode, false);
    assert.equal((await mk({ ultracode: 'yes' })).json.schedule.ultracode, false, 'only a literal true');
    // …and an UPDATE can take it back off (the update branch is the one that historically forgot fields)
    assert.equal((await mk({ id })).json.schedule.ultracode, false);
    await req(S.port, 'POST', '/api/uiskill/schedules/delete', { id });
  });

  it('/api/state ships headlessPermModes — the same list the headless cap reads', async () => {
    // The schedule dialog warns when a manifest asks for a mode an unattended run cannot keep. It has to
    // warn from THIS list, not from a copy in the browser that would silently stop matching the cap.
    const { HEADLESS_PERM_MODES } = require(path.join(ROOT, 'lib', 'pure'));
    const r = await req(S.port, 'GET', '/api/state');
    assert.deepEqual(r.json.headlessPermModes, HEADLESS_PERM_MODES);
    assert.ok(!r.json.headlessPermModes.includes('bypassPermissions'), 'the one value the manifest editor offers and the cap removes');
  });

  // ---- prompt history (A13) ----------------------------------------------------------------------
  it('GET /api/prompt-history reads the terminal history and counts both sources', async () => {
    const r = await req(S.port, 'GET', '/api/prompt-history');
    assert.equal(r.status, 200);
    assert.equal(r.json.sources.cli, 1);
    assert.equal(r.json.sources.panel, 0, 'nothing sent from the panel yet');
    assert.equal(r.json.items[0].text, 'aus dem terminal');
    assert.deepEqual(r.json.items[0].sources, ['cli']);
    assert.equal(r.json.cliError, '', 'a readable file must not report an error');
  });

  it('POST /api/prompt-history records a panel prompt; it then leads the list', async () => {
    const r = await req(S.port, 'POST', '/api/prompt-history', { text: 'aus dem panel', cwd: 'C:/repo', sessionId: 's9', model: 'sonnet' });
    assert.equal(r.status, 200);
    assert.equal(r.json.entries, 1);
    const h = await req(S.port, 'GET', '/api/prompt-history');
    assert.equal(h.json.sources.panel, 1);
    assert.equal(h.json.items[0].text, 'aus dem panel', 'newest first');
    assert.deepEqual(h.json.items[0].sources, ['panel']);
    assert.equal(h.json.items[0].project, 'C:/repo');
    assert.equal(h.json.items[0].model, 'sonnet');
  });

  it('?q= filters server-side (the corpus must not cross the wire for three letters)', async () => {
    const r = await req(S.port, 'GET', '/api/prompt-history?q=' + encodeURIComponent('PANEL'));
    assert.equal(r.json.items.length, 1);
    assert.equal(r.json.items[0].text, 'aus dem panel', 'a query is not a token');
    assert.equal((await req(S.port, 'GET', '/api/prompt-history?q=findetnichts')).json.items.length, 0);
  });

  it('an empty prompt is refused rather than stored as a blank row', async () => {
    const r = await req(S.port, 'POST', '/api/prompt-history', { text: '   ' });
    assert.equal(r.status, 400);
  });

  it('a missing terminal history is not an error — the panel half still works', async () => {
    await fsp.rm(path.join(claudeDir, 'history.jsonl'), { force: true });
    const r = await req(S.port, 'GET', '/api/prompt-history');
    assert.equal(r.status, 200);
    assert.equal(r.json.sources.cli, 0);
    assert.equal(r.json.cliError, '', 'ENOENT means "nothing typed in a terminal yet", not a failure');
    assert.ok(r.json.items.length >= 1, 'the panel prompts are still there');
  });
});
