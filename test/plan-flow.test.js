'use strict';
// PF-1 end to end, without a model: a real `node server.js` drives fake-claude's `planprogress` scenarios.
// plan-progress.test.js pins the pure rules and plan-wiring.test.js the browser wiring; what only a running
// server can show is the chain BETWEEN them:
//   1. the approval reaches the CLI verbatim — deny + message, the message carrying the ```plan-schritte block
//      and the protocol (FAKE_CLAUDE_CONTROL_OUT records what the fake RECEIVED, which no transcript holds);
//   2. the model's reports arrive on the stream as the live tab will read them — including the two it must
//      survive (a block that is not JSON, an unknown step ID);
//   3. after the run, GET /api/transcript — the resume path — folds the plan back out of the transcript as
//      3 of 3 done, from the WHOLE file and not from the tail it paints, with a compact ExitPlanMode entry for
//      the history card instead of an 8000-character JSON fragment.
// The two scenarios write that transcript themselves (into this suite's own temp sandbox, never into the
// shared fixture corpus: makeSandbox copies the fixtures into a fresh directory per suite).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { makeSandbox, FAKE } = require('./sandbox');
const P = require('../public/js/plan-progress');

const ROOT = path.join(__dirname, '..');
const SBX = makeSandbox('planflow', { fakeCli: true });
after(() => SBX.cleanup());
// the head of the approval as the German panel sends it (i18n chat-render.planGenehmigtDerPlan)
const HEAD = 'Plan genehmigt — der Plan-Modus ist beendet. Bitte setze den Plan jetzt um.';

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* */ } resolve({ status: res.statusCode, body: d, json }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function startServer(scenario, controlOut) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...SBX.env, CLAUDE_UI_PORT: String(port), CLAUDE_UI_FAKE_BIN: FAKE, FAKE_CLAUDE_SCENARIO: scenario, FAKE_CLAUDE_CONTROL_OUT: controlOut },
  });
  let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  const t0 = Date.now();
  for (;;) {
    try { if ((await req(port, 'GET', '/api/state')).status === 200) break; } catch { /* not up yet */ }
    if (Date.now() - t0 > 12000) throw new Error('server did not come up on :' + port + '\n' + log);
    await new Promise((r) => setTimeout(r, 150));
  }
  return { port, log: () => log, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }) };
}
// The chat's SSE stream from its start (a first connect replays the buffer), until `until(frames)` holds.
function frames(port, chatId, until, timeout = 8000) {
  return new Promise((resolve) => {
    const got = []; let done = false;
    const fin = () => { if (done) return; done = true; try { r.destroy(); } catch { /* */ } resolve(got); };
    const r = http.get({ host: '127.0.0.1', port, path: '/api/chat/' + chatId + '/stream' }, (res) => {
      res.setEncoding('utf8'); let buf = '';
      res.on('data', (c) => {
        buf += c; let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const dl = block.split('\n').find((l) => l.startsWith('data:'));
          if (!dl) continue;
          try { got.push(JSON.parse(dl.slice(5).trim())); } catch { continue; }
          if (until(got)) fin();
        }
      });
    });
    r.on('error', fin);
    setTimeout(fin, timeout);
  });
}
const results = (n) => (f) => f.filter((e) => e.type === 'result').length >= n;
const texts = (f) => f.filter((e) => e.type === 'assistant').flatMap((e) => (e.message.content || []).filter((b) => b.type === 'text').map((b) => b.text));
// the transcript the fake wrote: its project dir is the CLI's encoding of the cwd — found, not recomputed
function projectOf(sid) {
  const root = path.join(SBX.claudeDir, 'projects');
  return fs.readdirSync(root).find((d) => fs.existsSync(path.join(root, d, sid + '.jsonl'))) || null;
}
// start → user message → the held ExitPlanMode gate. → { chatId, sid, gate (the control_request), input }
async function toGate(S, text) {
  const s = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, permissionMode: 'plan' });
  assert.equal(s.status, 200, s.body);
  const chatId = s.json.chatId;
  const pre = frames(S.port, chatId, (f) => f.some((e) => e.type === 'control_request'));
  await new Promise((r) => setTimeout(r, 250));
  assert.equal((await req(S.port, 'POST', '/api/chat/' + chatId + '/send', { text: text || 'Plane das bitte.' })).status, 200);
  const f = await pre;
  const gate = f.find((e) => e.type === 'control_request');
  assert.ok(gate, 'no plan gate on the stream:\n' + S.log());
  assert.equal(gate.request.tool_name, 'ExitPlanMode');
  const sid = (f.find((e) => e.type === '_session') || {}).session_id || (f.find((e) => e.session_id) || {}).session_id;
  assert.ok(sid, 'no session id on the stream');
  return { chatId, sid, gate, input: gate.request.input };
}
// the panel's answer, through the panel's route — deny + message in both branches, as resolvePlanGate sends it
const answer = (S, chatId, gate, message) => req(S.port, 'POST', '/api/chat/' + chatId + '/permission', { requestId: gate.request_id, behavior: 'deny', message });

describe('PF-1 end to end — approval, reports, and the resume fold (fake-claude planprogress)', () => {
  let S, OUT;
  before(async () => { OUT = path.join(SBX.root, 'control-planprogress.ndjson'); S = await startServer('planprogress', OUT); });
  after(async () => { if (S) await S.stop(); });

  it('the approval reaches the CLI with the step block and the protocol; the reports end at 3/3 — and a resume reads 3/3 back', async () => {
    const { chatId, sid, gate, input } = await toGate(S);
    assert.match(String(input.planFilePath), /[\\/]plans[\\/]testplan\.md$/, 'the plan file where the CLI keeps it');
    // what the browser builds (chat-render.js resolvePlanGate → planAcceptMessage of the card's candidate)
    const cand = P.planNew(gate.request.tool_use_id, input.plan, input.planFilePath, Date.now());
    assert.deepEqual(cand.steps.map((s) => s.title), ['Modul', 'Route', 'Tests'], 'the parser suggests the three steps');
    const after1 = frames(S.port, chatId, results(1));
    assert.equal((await answer(S, chatId, gate, P.planAcceptMessage(HEAD, cand))).status, 200);
    const f = await after1;

    // 1. what the CLI received — the only record of the decision (the transcript holds the call, not the verdict)
    const got = fs.readFileSync(OUT, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(got.length, 1);
    const verdict = got[0].response.response;
    assert.equal(verdict.behavior, 'deny', 'a bare allow wedges stream-json — both branches are deny + message');
    assert.ok(verdict.message.startsWith(HEAD + '\n\n```plan-schritte\n'), verdict.message.slice(0, 120));
    assert.ok(verdict.message.endsWith(P.PLAN_PROGRESS_PROTOCOL), 'the protocol travels with the approval');
    assert.deepEqual(P.planStepsBlockParse(verdict.message).map((s) => s.id + ' ' + s.title), ['S1 Modul', 'S2 Route', 'S3 Tests']);

    // 2. the reports, applied the way the live tab applies them (takePlanStatus → planApplyStatus, in order)
    const t = texts(f);
    assert.ok(t.some((x) => /Ich lege los/.test(x)), 'the scenario took the plan-schritte branch, not „Weiter geplant"');
    const live = P.planPromote(null, cand, null, Date.now());
    let unknown = 0;
    t.forEach((x) => P.planStatusExtract(x).forEach((u) => { unknown += P.planApplyStatus(live, u, Date.now()).unknown; }));
    assert.equal(live.state, 'done');
    assert.equal(live.src, 'model', 'the model confirmed the list in its first report');
    assert.deepEqual(P.planCounts(live).done, 3);
    assert.equal(unknown, 1, 'S9 was reported and ignored — never invented');
    // the block that is not JSON is never applied, and stays in the text as something readable
    const bad = t.find((x) => /halb geschrieben/.test(x));
    assert.ok(bad && P.planStatusExtract(bad).length === 0 && P.planStatusStrip(bad).includes('```plan-status'));
    // every valid block leaves the text; the reports that were nothing else leave nothing behind
    assert.equal(t.filter((x) => P.planStatusStrip(x).trim() === '').length, 2, 'S2 and S9 were status-only messages');

    // 3. the resume path: the server folds the WHOLE transcript the fake wrote
    const project = projectOf(sid);
    assert.ok(project, 'the scenario wrote no transcript into the sandbox');
    const q = (tail) => req(S.port, 'GET', '/api/transcript?tail=' + tail + '&project=' + encodeURIComponent(project) + '&id=' + sid);
    const r = await q(220);
    assert.equal(r.status, 200, r.body);
    const plan = r.json.plan;
    assert.ok(plan, 'no plan in the transcript payload');
    assert.equal(plan.id, gate.request.tool_use_id);
    assert.equal(plan.title, 'Testplan');
    assert.equal(plan.state, 'done');
    assert.equal(plan.src, 'model');
    assert.deepEqual(plan.steps.map((s) => s.id + ':' + s.status), ['S1:completed', 'S2:completed', 'S3:completed']);
    assert.equal(plan.text, undefined, 'the fold never carries plan text');
    assert.deepEqual(P.planRestore(plan), plan, 'the payload is the planSave form — restorable as it is');
    // the ExitPlanMode entry of the tail: the history card's facts and the plan as MARKDOWN (≤ PLAN_CAPS.preview —
    // an earlier plan's card opens that, not the plan file the CLI has written later plans into), not a JSON preview
    const epm = r.json.events.flatMap((e) => e.tools || []).find((tl) => tl && tl.name === 'ExitPlanMode');
    assert.ok(epm, 'the ExitPlanMode call is not in the tail');
    assert.deepEqual(epm.plan, { title: 'Testplan', file: input.planFilePath, chars: input.plan.length, preview: input.plan.slice(0, P.PLAN_CAPS.preview) });
    assert.equal(epm.input, undefined);
    assert.ok(r.json.events.flatMap((e) => e.tools || []).some((tl) => tl && tl.name === 'Read' && tl.input && tl.input.file_path === 'README.md'), 'other tools keep their input');
    // …and its tool_result is the approval, which the history card reads as „freigegeben"
    const res = r.json.events.flatMap((e) => e.results || []).find((x) => x.tool_use_id === gate.request.tool_use_id);
    assert.ok(res && P.planIsApproval(res.text));
    // independent of the window: with a tail of 2 the approval is long gone from the events, the plan is not
    const r2 = await q(2);
    assert.equal(r2.json.events.length, 2);
    assert.deepEqual(r2.json.plan, plan);
    // what a reloaded tab makes of it (sessions.js renderResumeHistory → planAdopt)
    assert.equal(P.planCounts(P.planAdopt(null, plan)).done, 3);
    // [Plan öffnen] after a reload: the plan FILE through the existing route („Datei-Stand")
    const pf = await req(S.port, 'GET', '/api/plan?name=' + encodeURIComponent(P.planFileName(plan.file)));
    assert.equal(pf.status, 200, pf.body);
    assert.match(pf.json.content, /^# Testplan/);
  });

  it('„Weiter planen" (no step block) keeps planning — and the fold takes the proposal off the table', async () => {
    const { chatId, sid, gate } = await toGate(S);
    const after1 = frames(S.port, chatId, results(1));
    await answer(S, chatId, gate, 'Bitte den Plan noch überarbeiten: Die Route zuerst.');
    const t = texts(await after1);
    assert.ok(t.includes('Weiter geplant.'), JSON.stringify(t));
    assert.ok(!t.some((x) => x.includes('```plan-status')), 'no reports for a plan nobody approved');
    const r = await req(S.port, 'GET', '/api/transcript?tail=220&project=' + encodeURIComponent(projectOf(sid)) + '&id=' + sid);
    assert.equal(r.json.plan.state, 'superseded');
    assert.equal(P.planVisible(P.planAdopt(null, r.json.plan)), false, 'a reloaded tab shows no plan group for it');
  });
});

describe('PF-1 end to end — a compaction mid-plan, then [Stand abfragen] (fake-claude planprogress-compact)', () => {
  let S;
  before(async () => { S = await startServer('planprogress-compact', path.join(SBX.root, 'control-compact.ndjson')); });
  after(async () => { if (S) await S.stop(); });

  it('after the compaction the plan is stale at S2; the status question brings the list back and the answer clears it', async () => {
    const { chatId, sid, gate, input } = await toGate(S);
    const cand = P.planNew(gate.request.tool_use_id, input.plan, input.planFilePath, Date.now());
    const after1 = frames(S.port, chatId, results(1));
    await answer(S, chatId, gate, P.planAcceptMessage(HEAD, cand));
    const f1 = await after1;
    assert.ok(f1.some((e) => e.type === 'system' && e.subtype === 'compact_boundary'), 'no compact_boundary on the stream');
    const q = () => req(S.port, 'GET', '/api/transcript?tail=220&project=' + encodeURIComponent(projectOf(sid)) + '&id=' + sid);
    const p1 = (await q()).json.plan;
    assert.equal(p1.state, 'active');
    assert.equal(p1.stale, true, 'the rail must say its state may be stale');
    assert.equal(p1.current, 'S2');
    // [Stand abfragen] as the rail sends it (chat-side.js planAskStatus): the question, the list WITH the panel's
    // belief about each step, the protocol
    const ask = 'Wo stehen wir im Plan?\n\n' + P.planStepsBlock(P.planRestore(p1), { status: true }) + '\n\n' + P.PLAN_PROGRESS_PROTOCOL;
    assert.match(ask, /"status":"läuft"/);
    const after2 = frames(S.port, chatId, results(2));
    await req(S.port, 'POST', '/api/chat/' + chatId + '/send', { text: ask });
    await after2;
    const p2 = (await q()).json.plan;
    assert.equal(p2.state, 'done');
    assert.equal(p2.stale, false, 'a report that hit known steps clears the flag');
    assert.equal(P.planCounts(p2).done, 3);
  });
});

// ---- PF-1b: the plan no gate can approve (fake-claude planorphan · planself) -----------------------------------
// The 05.10. course over the real server: the CLI refuses ExitPlanMode outside plan mode (no control_request at all),
// the panel starts the plan by an ordinary MESSAGE — or the reader types „plan starten" without the list and asks for
// it later — and the resume fold reads the same plan back the live tab shows.
const HEAD_START = 'Plan freigegeben — bitte jetzt umsetzen.';
const HEAD_ASK = 'Melde die Schrittliste deines aktuellen Plans und den aktuellen Schritt als plan-status-Block.';
async function chatOf(S) {
  const s = await req(S.port, 'POST', '/api/chat/start', { cwd: ROOT, permissionMode: 'auto' });
  assert.equal(s.status, 200, s.body);
  return s.json.chatId;
}
// send one message, collect the stream up to its `result`; → { frames, sid }
async function turnOf(S, chatId, text, nResults) {
  const got = frames(S.port, chatId, results(nResults));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await req(S.port, 'POST', '/api/chat/' + chatId + '/send', { text })).status, 200);
  const f = await got;
  const sid = (f.find((e) => e.type === '_session') || {}).session_id || (f.find((e) => e.session_id) || {}).session_id;
  return { frames: f, sid };
}
const foldOf = async (S, sid) => (await req(S.port, 'GET', '/api/transcript?tail=220&project=' + encodeURIComponent(projectOf(sid)) + '&id=' + sid)).json.plan;

describe('PF-1b end to end — refused outside plan mode, started by message (fake-claude planorphan)', () => {
  let S, OUT;
  before(async () => { OUT = path.join(SBX.root, 'control-planorphan.ndjson'); S = await startServer('planorphan', OUT); });
  after(async () => { if (S) await S.stop(); });

  it('no gate at all — the refusal is a tool_result; the fold keeps the proposal ORPHANED with the current order\'s steps', async () => {
    const chatId = await chatOf(S);
    const { frames: f, sid } = await turnOf(S, chatId, 'Plane den QA-Lauf.', 1);
    assert.ok(!f.some((e) => e.type === 'control_request'), 'the CLI asks nobody before it refuses');
    const epm = f.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content).find((b) => b.type === 'tool_use' && b.name === 'ExitPlanMode');
    assert.ok(epm, 'the ExitPlanMode call is on the stream');
    const refusal = f.filter((e) => e.type === 'user').flatMap((e) => e.message.content).find((b) => b.tool_use_id === epm.id);
    assert.ok(refusal && refusal.is_error && P.planIsNoPlanModeError(refusal.content), 'the refusal as the live tab reads it (chat-events.js)');
    const plan = await foldOf(S, sid);
    assert.deepEqual([plan.id, plan.state, plan.gate], [epm.id, 'proposed', 'none']);
    assert.equal(plan.title, 'Demoprojekt-Demo — lebender Plan (synthetisch)');
    assert.deepEqual(plan.steps.map((s) => s.title), ['Schritt 0 — Inventar', 'Schritt 1 — Workflow', 'Schritt 2 — Abnahme'], 'parser rule 0');
    assert.equal(P.planVisible(P.planAdopt(null, plan)), true, 'a reloaded tab shows it: „Plan liegt vor"');

    // „plan starten" with the chip: what the composer sends (planChipAttachment = planStartMessage('', plan))
    const typed = 'plan starten\n\n' + P.planStartMessage('', P.planRestore(plan));
    const { frames: f2 } = await turnOf(S, chatId, typed, 2);
    // the live tab: the start where the message went out (planNoteOutgoing → planPromote with the block's steps), then
    // every report through planFromStatus — in the order takePlanStatus applies them
    const target = P.planOrphan(P.planRestore(plan));
    let live = P.planPromote(target, target, P.planStartBlockOf(typed).steps, Date.now());
    // the name a report without "titel" would get — as a reloaded tab has it: from the transcript (planLast), not from
    // a card it painted (PF-1b counter-check: after a reload it was nothing, so live and fold named such a plan apart)
    const tr = (await req(S.port, 'GET', '/api/transcript?tail=220&project=' + encodeURIComponent(projectOf(sid)) + '&id=' + sid)).json;
    assert.deepEqual(tr.planLast, { title: plan.title, file: plan.file }, 'the newest proposal\'s name and file travel with the plan');
    assert.equal(tr.planOrphan, null, 'no orphan under a plan underway here — and null, not missing: the fold ran');
    let reports = 0;
    texts(f2).forEach((x) => P.planStatusExtract(x).forEach((u) => { reports++; live = P.planFromStatus(live, u, P.planLastRestore(tr.planLast), Date.now()).plan; }));
    assert.ok(reports >= 4, 'the model kept the protocol: list, each step, „fertig" — ' + reports + ' reports');
    assert.deepEqual([live.state, P.planCounts(live).done, live.src], ['done', 3, 'model']);
    const back = await foldOf(S, sid);
    for (const k of ['id', 'title', 'file', 'state', 'gate', 'src', 'steps', 'current']) assert.deepEqual(back[k], P.planSave(live)[k], k);
    // the CLI never got a gate answer for it — there was no gate
    assert.ok(!fs.existsSync(OUT) || !fs.readFileSync(OUT, 'utf8').trim(), 'no control_response for a plan that never had a gate');
  });
});

describe('PF-1b end to end — „plan starten" WITHOUT the list, then 📋 Schritte anfordern; a plan the model reports on its own (bymsg)', () => {
  let S;
  before(async () => { S = await startServer('bymsg', path.join(SBX.root, 'control-bymsg.ndjson')); });
  after(async () => { if (S) await S.stop(); });

  it('the model works without a word — the orphan stays; one request brings the list, and the answer makes the orphan the plan', async () => {
    const chatId = await chatOf(S);
    const { sid } = await turnOf(S, chatId, 'sc:planorphan Plane den QA-Lauf.', 1);
    const orphan = await foldOf(S, sid);
    assert.deepEqual([orphan.state, orphan.gate], ['proposed', 'none']);
    // the 05.10. message: typed, no chip — the model starts working and reports nothing
    const { frames: f2 } = await turnOf(S, chatId, 'plan starten', 2);
    assert.ok(texts(f2).some((x) => /Ich starte mit Schritt 0/.test(x)), 'it works…');
    assert.ok(!texts(f2).some((x) => x.includes('```plan-status')), '…without a single report');
    assert.equal((await foldOf(S, sid)).state, 'proposed', 'and the fold says what the rail says: still on the table');
    // 📋 Schritte anfordern, as the rail sends it (planRequestSteps → planStepsRequestMessage): a question, no start
    const ask = P.planStepsRequestMessage(HEAD_ASK, P.planRestore(orphan));
    assert.equal(P.planOutgoingKind(ask), '');
    await turnOf(S, chatId, ask, 3);
    const p = await foldOf(S, sid);
    assert.deepEqual([p.id, p.state, p.src], [orphan.id, 'done', 'model'], 'the answer was about the orphan — no plan of its own');
    assert.deepEqual(p.steps.map((s) => s.title + ':' + s.status), ['Inventar:completed', 'Workflow:completed', 'Abnahme:completed']);
  });

  it('▶ Plan starten as the card sends it: the head and the block, routed to the plan conversation without an sc: tag', async () => {
    const chatId = await chatOf(S);
    const { sid } = await turnOf(S, chatId, 'sc:planorphan Plane.', 1);
    const orphan = await foldOf(S, sid);
    await turnOf(S, chatId, P.planStartMessage(HEAD_START, P.planRestore(orphan)), 2);
    const p = await foldOf(S, sid);
    assert.deepEqual([p.id, p.state, P.planCounts(p).done], [orphan.id, 'done', 3]);
  });

  it('planself: no ExitPlanMode at all — the model sets its plan up with "titel" and the fold starts the same plan', async () => {
    const chatId = await chatOf(S);
    const { frames: f, sid } = await turnOf(S, chatId, 'sc:planself Mach den QA-Lauf.', 1);
    const first = P.planStatusExtract(texts(f).find((x) => x.includes('```plan-status')))[0];
    const p = await foldOf(S, sid);
    assert.deepEqual([p.state, p.src, p.title, p.gate], ['done', 'model', 'QA-Lauf (selbst gemeldet)', 'none']);
    assert.equal(p.id, P.planFromStatus(null, first, null, 0).plan.id, 'the id the live tab derives from the same report');
  });
});
