'use strict';
// UI-skill headless engine + cron scheduler (server-driven runs; no browser). Extracted from server.js.
// Pure prompt/timing helpers live in ./pure so the test suite can import them without booting the server.
const crypto = require('crypto');
const { UISKILL_SCHEDULES_FILE, UISKILL_RUNS_FILE } = require('./paths');
const { readUiRuns, writeUiRuns, readSchedules, writeSchedules, withFileLock, readPrefs, readCorrections, errorText } = require('./core');
const { startChat, sendToChat, respondPermission, terminateChat } = require('./chat');
const { firstUnreachable } = require('./reach');
const { isCliUpdating, cliFlagSupported, PROMPT_SNAPSHOT_FLAG } = require('./cli');
const { scanUiSkills } = require('./skills');
const { computeNextRun, buildSpawnPolicy, headlessPermissionMode } = require('./pure');
const { uiResultExtract, uiResultFromPattern, uiResultDigest } = require('../public/js/ui-result'); // same extraction as the browser
// No `labels` is passed anywhere below on purpose: a scheduled run's prompt must read the same as an
// interactive one's, whatever language the panel that created the schedule was in.
const { uiComposePrompt } = require('../public/js/ui-skill-prompt'); // same prompt composition as the browser
const { resultFileRoots, resolveResultSrc } = require('./result-file'); // `expandSrc` → inline panel data before persisting
// P3 — a schedule's „Projekt (nur Etikett)": the session id of the run is labelled on its init frame, nothing else
const projectsLib = require('./projects');

const DRY_HINT_SRV = '[TESTLAUF] Nur beschreiben, was du tun würdest — nichts schreiben, anlegen oder ausführen.\n\n';

// The shell/exec tools an unattended run may never use. ONE list, enforced TWICE and independently:
// the CLI itself refuses them for the whole session (--disallowed-tools, passed to startChat below), and
// the permission responder denies them again should it ever be asked. Until now the responder was the
// only gate — a responder that is not reached (a listener that throws, an event shape that changes) left
// nothing behind it. Deriving the regex from the same array keeps the two from drifting apart.
const HEADLESS_DENIED_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'KillBash'];
const HEADLESS_DENIED_RE = new RegExp('^(' + HEADLESS_DENIED_TOOLS.join('|') + ')$', 'i');
// …and what a write-run may be GRANTED (#15/#20). The responder answered `allowWrites && !shell` →
// allow, which is a DENY-list decision: every tool name outside the four literals above was granted,
// so an unattended run could also be handed an mcp__* tool (each of those writes into a system of its
// own), WebFetch or Task — none of which anybody named when the schedule was confirmed, and none of
// which the four-name deny-list can ever cover, because the set of MCP tools on a machine is open.
// So it is an allow-list now: the inspection and file tools a write-run exists FOR, plus whatever the
// skill DECLARES for itself in its manifest (`run.allowTools`: exact tool names, or a prefix ending in
// `*`, e.g. `mcp__jira__*`). Everything else is denied — and the log line below names it, so a skill
// that needs one more tool says which one instead of failing silently.
// Compared case-SENSITIVELY on purpose: a differently spelled name is not the tool that was reviewed.
const HEADLESS_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
function headlessToolAllowed(tool, declared) {
  if (HEADLESS_DENIED_RE.test(tool)) return false; // the shell set stays denied even if a manifest asks for it
  if (HEADLESS_ALLOWED_TOOLS.includes(tool)) return true;
  return (Array.isArray(declared) ? declared : []).some((d) => {
    const s = String(d || '');
    if (s.endsWith('*')) return s.length > 1 && tool.startsWith(s.slice(0, -1));
    return s !== '' && s === tool;
  });
}

const engineRuns = new Map(); // id -> live/last headless run status
// rec.id -> finish(status) of every run still in flight, so shutdown() can end them as 'aborted'
// (FLOW-2) instead of leaving a 'running' record behind that no process will ever close.
const RUN_ABORTERS = new Map();
async function runUiSkillHeadless(skill, values, opts) {
  opts = opts || {};
  // What the run inherits from the panel's settings (guardrails, corrections, subagent policy, MCP wait —
  // and deliberately not the rest, see lib/pure.js buildSpawnPolicy). Read per run, so an edited
  // guardrail reaches the next scheduled run without a server restart. Both readers fall back to
  // empty instead of throwing.
  // `snapshotFlag` (PR-S): the same --help proof the chat start route asks for — the policy decides from
  // it, so a scheduled run and a chat can never disagree about whether the flag is passed.
  const prefs = await readPrefs();
  const policy = buildSpawnPolicy(prefs, await readCorrections(), { mode: 'headless', schedule: { ultracode: opts.ultracode === true }, snapshotFlag: await cliFlagSupported(PROMPT_SNAPSHOT_FLAG) });
  // N12 — the manifest's run.cwd is configuration, and on a dead share the spawn below would resolve it inside
  // CreateProcessW on the event loop (30 939 ms measured for the chat start). Asked here, among the awaits
  // that already precede the spawn, and a cwd that does not answer ends the run with that reason in its
  // history record — the same path any other spawn failure takes.
  const runCwd = skill && skill.manifest && skill.manifest.run && skill.manifest.run.cwd;
  const deadCwd = await firstUnreachable([runCwd]);
  return new Promise((resolve) => {
    const m = skill.manifest || {};
    const dryRun = !!opts.dryRun;
    const allowWrites = !!opts.allowWrites && !dryRun;
    // Headless safety: unattended runs only use a mode in which the CLI ASKS the permission responder
    // below (SEC-H, lib/pure.js headlessPermissionMode — bypassPermissions, auto and dontAsk are capped
    // to acceptEdits), and that responder grants only what the allow-list above covers even when
    // allowWrites is on — so a scheduled write-run can edit files, but neither runs shell commands nor
    // reaches another system unsupervised.
    // The tools this skill declares for itself on top of that (see HEADLESS_ALLOWED_TOOLS).
    const declaredTools = (m.run && Array.isArray(m.run.allowTools)) ? m.run.allowTools : [];
    const pmv = headlessPermissionMode(m.run && m.run.permissionMode, { dryRun, allowWrites });
    const permissionMode = pmv.mode;
    let prompt = uiComposePrompt(skill, values, { autoRun: true });
    if (dryRun) prompt = DRY_HINT_SRV + prompt;
    // P3 — the schedule's project label (opts.projectId): written for the FIRST id the CLI reports, once
    const labelHook = opts.projectId ? projectsLib.sessionIdHook({ pid: opts.projectId }) : null;
    let labelled = false;
    const started = Date.now();
    const rec = { id: crypto.randomUUID(), name: skill.name, title: m.title || skill.name, startedAt: started, status: 'running', dryRun, allowWrites, sessionId: null, permissionMode, permissionCapped: pmv.capped, ultracode: policy.ultracode };
    // the cap is a silent downgrade otherwise — name it, so a write-run that suddenly asks for edits
    // it used to get without asking has an explanation in the log
    if (pmv.capped) { try { console.log('[headless] ' + rec.id + ' permission mode ' + pmv.capped + ' → ' + permissionMode + ' (not allowed unattended)'); } catch { /* */ } }
    engineRuns.set(rec.id, rec);
    // Evict the oldest FINISHED record. Insertion order made the eviction hit a still-'running' run
    // when 60 runs piled up — its status/summary then never reached the panel (the finish() handler
    // updates an object nobody can look up anymore).
    if (engineRuns.size > 60) {
      for (const [k, v] of engineRuns) { if (v && v.status !== 'running') { engineRuns.delete(k); break; } }
    }
    let assistantText = '', finished = false, chat = null, to = null, finishing = null;
    // Returns the SAME promise to every caller, so abortHeadlessRuns() can await the history write of
    // a run whose finish() an event had already started.
    const finish = (status) => {
      if (finished) return finishing || Promise.resolve(rec);
      finished = true;
      finishing = doFinish(status);
      return finishing;
    };
    const doFinish = async (status) => {
      RUN_ABORTERS.delete(rec.id);
      if (to) clearTimeout(to);
      rec.status = status; rec.durationMs = Date.now() - started; rec.finishedAt = Date.now();
      // shared extraction (ui-result block preferred, regex fallback) — identical to the browser path
      let norm = null;
      try { norm = uiResultExtract(assistantText) || uiResultFromPattern(assistantText, m, { defaultLabel: 'Ergebnis' }); } catch { /* */ }
      // panel data from a file → resolve now, same as the POST /api/uiskill/runs path (history is self-contained)
      try { if (norm && norm.expandSrc) norm = await resolveResultSrc(norm, resultFileRoots(await scanUiSkills())); } catch { /* keep the reference */ }
      // schedule panel expects string[] — but joining WHOLE rows produced text sausages once rows
      // carried group + detail columns, so it gets the digest (section counts / first body cells).
      const dig = norm ? uiResultDigest(norm) : null;
      // …and a spawn that never ran has no assistant text to digest: its own sentence IS the summary,
      // otherwise the history gains an entry that is just as silent as the missing one was.
      rec.summary = dig ? dig.summary : (rec.error || '');
      rec.rowCount = norm ? (norm.rows || []).length : 0;
      rec.result = dig ? dig.lines : [];
      try {
        await withFileLock(UISKILL_RUNS_FILE, async () => {
          const runs = await readUiRuns();
          // scheduleId (A4): without it, cost could only be attributed to "headless runs of this
          // skill" — fine for one schedule per skill, wrong as soon as there are two (different
          // inputs, different cadence). Recorded going forward; the join falls back for old records.
          // `fallbackModel` is in the record because a run that MAY answer from a model other than the one
          // the skill names is a state change worth keeping. It records that the fallback was ALLOWED, not
          // that it was used — the frame that would say so (`model_fallback`) is not wired yet, and the
          // field hint in the UI now says exactly that much and no more. The earlier version of this
          // comment claimed the history „is the only place an unattended run can report it afterwards",
          // which reads as a promise that the history shows a fallback HAPPENED. It does not, and no drawer
          // read the field either (G3).
          runs.push({ id: crypto.randomUUID(), name: skill.name, title: m.title || skill.name, inputs: values, startedAt: started, status, sessionId: rec.sessionId, dryRun, mode: 'single', durationMs: rec.durationMs, steps: [], result: norm, transcript: assistantText.slice(0, 40000), headless: true, scheduleId: opts.scheduleId || null, error: rec.error || null, fallbackModel: (chat && chat.meta && chat.meta.fallbackModel) || null });
          await writeUiRuns(runs);
        });
      } catch { /* */ }
      // B2/FLOW-1: the shared termination (EOF → grace → tree kill if still running), not a bare
      // proc.kill() that left the run's MCP children orphaned; the map entry is dropped only if it is
      // still this chat. Not awaited — the record is complete, the process end is housekeeping.
      try { if (chat) terminateChat(chat); } catch { /* */ }
      resolve(rec);
      return rec;
    };
    RUN_ABORTERS.set(rec.id, finish);
    // FLOW-2: shutdown already swept RUN_ABORTERS while this run was still in its awaits above (prefs,
    // corrections, the --help probe) — spawning now would leave a claude.exe that no one terminates.
    // Recorded, not started.
    if (ENGINE_CLOSED) { finish(ENGINE_CLOSED); return; }
    try {
      // maxBudgetUsd (A3): a hard dollar ceiling for a run nobody is watching. The 10-minute timeout
      // below bounds TIME, not spend — a schedule that loops fast can burn a lot inside it.
      if (deadCwd) throw new Error('cwd not reachable (no answer in ' + Math.ceil(deadCwd.timeoutMs / 1000) + ' s): ' + deadCwd.path);
      chat = startChat({
        ...policy,
        cwd: (m.run && m.run.cwd) || undefined, permissionMode,
        model: (m.run && m.run.model) || undefined, effort: (m.run && m.run.effort) || undefined,
        // G3: the stand-in model, same precedence as the budget — the schedule overrides the manifest.
        // NOT inherited from a global preference: an unattended run that silently answers from a
        // different model is a state change, so it only ever happens where someone asked for it by name
        // (and the run record below says which name).
        fallbackModel: opts.fallbackModel || (m.run && m.run.fallbackModel) || undefined,
        maxBudgetUsd: opts.maxBudgetUsd || (m.run && m.run.maxBudgetUsd) || undefined,
        // enforced by the CLI too, not only by the responder below. startChat merges it with the
        // subagent policy's denied tools (policy.subagents.tools) into ONE --disallowed-tools flag.
        disallowedTools: HEADLESS_DENIED_TOOLS,
      });
      chat.onEvent = (ev) => {
        // A permission request must ALWAYS be answered. The request id is therefore read FIRST and the
        // catch at the bottom DENIES it: an exception anywhere on the way to respondPermission (an event
        // shape that changed, a throw inside the branch) used to be swallowed silently, and the CLI then
        // waited for a verdict that never came — the unattended run hung until the 10-minute timeout.
        const permReq = !!(ev && ev.type === 'control_request' && ev.request && ev.request.subtype === 'can_use_tool');
        const permId = permReq ? (ev.request_id || ev.requestId) : null;
        try {
          if (ev.type === 'system' && ev.subtype === 'init') {
            if (ev.session_id) rec.sessionId = ev.session_id;
            // P3 — the label only (opts.projectId, the schedule's): never over an existing entry, the project checked
            // under the lock, never throws (lib/projects.js sessionIdHook). Not awaited — a stream handler does not
            // wait for disk. The spawn above never saw the project: no instructions, no start values headless.
            if (labelHook && ev.session_id && !labelled) { labelled = true; labelHook(ev.session_id); }
          }
          else if (ev.type === 'assistant') { const c = (ev.message && ev.message.content) || []; c.forEach((b) => { if (b.type === 'text' && b.text) assistantText += b.text + '\n'; }); }
          else if (permReq) {
            const tool = String(ev.request.tool_name || ev.request.toolName || '');
            const shell = HEADLESS_DENIED_RE.test(tool);
            const behavior = (allowWrites && headlessToolAllowed(tool, declaredTools)) ? 'allow' : 'deny';
            // Audit trail: WHICH tool an unattended run was granted existed nowhere — the transcript
            // records the call, not the verdict, so a scheduled write-run could not be reviewed after
            // the fact. Tool NAME and run id only; the tool INPUT is deliberately not logged (it can
            // carry file contents or credentials).
            try { console.log('[headless] ' + rec.id + ' ' + behavior + ' ' + (tool || '(unnamed)')); } catch { /* */ }
            // Name the REASON for a denial, it is the only thing the model (and the transcript) gets:
            // "not allowed here" and "not allowed in a read-only run" are two different situations.
            const why = shell ? 'Headless-Policy: shell tools denied unattended'
              : behavior === 'allow' ? 'Headless-Policy'
                : allowWrites ? 'Headless-Policy: tool not in this run allow-list (declare it as run.allowTools in the manifest)'
                  : 'Headless-Policy: run without write permission';
            respondPermission(chat, permId, behavior, {}, why);
          }
          else if (ev.type === 'result') { finish(ev.is_error ? 'error' : 'done'); }
          else if (ev.type === '_exit') { finish(ev.code ? 'error' : (rec.status === 'running' ? 'done' : rec.status)); }
          else if (ev.type === '_error') { finish('error'); }
        } catch (e) {
          try { console.error('[headless] ' + rec.id + ' event error: ' + String((e && e.message) || e)); } catch { /* */ }
          if (permId) { try { respondPermission(chat, permId, 'deny', {}, 'Headless-Policy: Fehler bei der Entscheidung'); } catch { /* */ } }
        }
      };
      sendToChat(chat, prompt);
      to = setTimeout(() => { if (!finished) finish('error'); }, 10 * 60 * 1000);
      if (finished) { clearTimeout(to); to = null; } // finish() may have raced the assignment
    } catch (e) {
      rec.error = errorText(e);
      // B1/FLOW-6: startChat refuses while `claude update` runs. That is not a failure of the skill —
      // 'deferred' tells runScheduled to retry on the next tick instead of recording an error, and it is
      // the ONE end that deliberately bypasses finish(): a run that never started has no result, so it
      // must not leave a history record (or a lastStatus) claiming one.
      if (e && e.code === 'cli-updating') {
        RUN_ABORTERS.delete(rec.id);
        rec.status = 'deferred'; finished = true; resolve(rec);
        return;
      }
      // Every OTHER spawn that never got off the ground — a rejected flag, a missing binary, a bad cwd —
      // used to take this same shortcut, which skipped finish() and therefore wrote NO history record at
      // all: the schedule showed „(Fehler)" and there was nothing anywhere that said why. For an
      // unattended nightly run that is the worst possible outcome, and it is the failure class this PR is
      // about — so the reason travels into the history like any other end reason, through the same
      // finish() that writes every other run (it clears RUN_ABORTERS, sets `finished` and resolves this
      // promise itself, so there is no second resolve here and nothing to await in a non-async executor).
      finish('error');
    }
  });
}
// FLOW-2: end every headless run still in flight as `status` ('aborted' by default) and wait until
// their history records are written. Used by shutdown() — a restart used to leave runs 'running' in
// ui-skill-runs.json forever (nothing was left to finish them).
// One-way: this IS the engine's shutdown. ENGINE_CLOSED stays set, so a run that was between its first
// await and its spawn when the sweep ran ends as `status` too, and the tick starts nothing new.
let ENGINE_CLOSED = null;
async function abortHeadlessRuns(status) {
  const st = status || 'aborted';
  ENGINE_CLOSED = st;
  const pending = [...RUN_ABORTERS.values()].map((fin) => { try { return fin(st); } catch { return null; } });
  await Promise.allSettled(pending);
  // runScheduled writes lastStatus AFTER its run resolves — wait for those writes too
  await Promise.allSettled([...SCHED_PROMISES]);
}
const ACTIVE_SCHED = new Set(); // schedule ids with a run in flight — the 30s tick and the manual
const MAX_CONCURRENT_RUNS = 3;  // /run route share this guard, so one schedule never spawns twice
function scheduleRunning(id) { return ACTIVE_SCHED.has(id); }
// how many headless runs are in flight — the manual /run route needs the same cap the tick honours,
// otherwise clicking "Jetzt ausführen" on N schedules spawns N claude.exe with no ceiling
function activeRunCount() { return ACTIVE_SCHED.size; }
const SCHED_PROMISES = new Set(); // in-flight runScheduled() calls — abortHeadlessRuns waits for their lastStatus write
function runScheduled(sc) {
  const p = runScheduledInner(sc);
  SCHED_PROMISES.add(p);
  p.finally(() => SCHED_PROMISES.delete(p)).catch(() => {});
  return p;
}
// A run the tick picked (and stamped: lastRun = now, nextRun = the next slot) that never ran: put it
// back to due for the first tick after the update and take the stamp back — the last REAL status stays.
// `_prevLastRun` is what the tick hands over when it stamps; a manual run carries none and was never stamped.
function putBackDue(s, sc) {
  s.nextRun = Date.now();
  if (Object.prototype.hasOwnProperty.call(sc, '_prevLastRun')) s.lastRun = sc._prevLastRun;
}
async function runScheduledInner(sc) {
  // B1/FLOW-6: a run that would start while `claude update` replaces the binary is not attempted. The
  // tick already skipped it (nextRun stays due → the first tick after the update runs it); this catches
  // the manual "Jetzt ausführen" path and a tick that raced the flag.
  if (isCliUpdating()) {
    // #3: the race is a tick whose re-check under the lock passed, then the flag went up while it read
    // and wrote the file — it stamped the schedule and hands it over here. Bailing without taking the
    // stamp back skipped a whole interval (and lastRun claimed a run that never happened).
    if (sc.id && Object.prototype.hasOwnProperty.call(sc, '_prevLastRun')) {
      try {
        await withFileLock(UISKILL_SCHEDULES_FILE, async () => {
          const list = await readSchedules(); const s = list.find((x) => x.id === sc.id);
          if (!s) return;
          putBackDue(s, sc);
          await writeSchedules(list);
        });
      } catch { /* */ }
    }
    return null;
  }
  if (sc.id) { if (ACTIVE_SCHED.has(sc.id)) return null; ACTIVE_SCHED.add(sc.id); }
  try {
    const skills = await scanUiSkills();
    const skill = skills.find((s) => s.name === sc.name);
    // FLOW-7: a schedule whose skill is gone used to `return` here — and the tick above had ALREADY
    // stamped `lastRun = now` and moved `nextRun` an interval ahead. So the card went on reading
    // „zuletzt vor 2 Minuten (fertig)": the time of a run that never happened, next to the STATUS OF THE
    // LAST ONE THAT DID. A skill is deleted or renamed by hand (`~/.claude/commands/*.md`), so this is
    // the normal end of a schedule's life, not an exotic case.
    // Written as its own status, not as 'error': nothing failed, the skill is not there — and
    // histStatusLabel in public/js/views-uiskills.js says exactly that („Skill fehlt" / „skill missing").
    // `nextRun` is deliberately NOT put back to due (unlike the cli-updating branch above): retrying a
    // skill that does not exist would just restamp the same miss every interval.
    if (!skill) {
      if (sc.id) {
        await withFileLock(UISKILL_SCHEDULES_FILE, async () => {
          const list = await readSchedules(); const s = list.find((x) => x.id === sc.id);
          if (!s) return;
          s.lastStatus = 'missing-skill'; s.lastRun = Date.now();
          await writeSchedules(list);
        });
      }
      return;
    }
    // `ultracode` is the schedule's own opt-in — the global switch is never inherited (buildSpawnPolicy).
    // `fallbackModel` (G3) is handed over for the same reason: the schedule overrides the manifest, and
    // like ultracode it is never taken from a global preference.
    const rec = await runUiSkillHeadless(skill, sc.values || {}, { dryRun: !!sc.dryRun, allowWrites: !!sc.allowWrites, maxBudgetUsd: sc.maxBudgetUsd, fallbackModel: sc.fallbackModel, scheduleId: sc.id, ultracode: sc.ultracode === true, projectId: sc.projectId || null });
    await withFileLock(UISKILL_SCHEDULES_FILE, async () => {
      const list = await readSchedules(); const s = list.find((x) => x.id === sc.id);
      if (!s) return;
      // 'deferred' (the update flag went up between the check above and the spawn): not a result —
      // put the run back to due so the next tick after the update picks it up, keep the last REAL status.
      if (rec.status === 'deferred') putBackDue(s, sc);
      else { s.lastStatus = rec.status; s.lastRun = rec.startedAt; }
      await writeSchedules(list);
    });
  } catch { /* */ } finally { if (sc.id) ACTIVE_SCHED.delete(sc.id); }
}
let SCHED_TICKING = false;
async function scheduleTick() {
  // B1/FLOW-6: DEFER, don't fail — while the CLI updates, the tick does nothing at all. Due schedules
  // keep their nextRun (≤ now), so the first tick after the update runs them; no lastStatus is written.
  if (isCliUpdating() || ENGINE_CLOSED) return;
  if (SCHED_TICKING) return; SCHED_TICKING = true;
  try {
    const toRun = await withFileLock(UISKILL_SCHEDULES_FILE, async () => {
      // re-checked under the lock: the update may have started while we waited for it
      if (isCliUpdating()) return [];
      const list = await readSchedules(); const now = Date.now(); let changed = false; const run = [];
      for (const sc of list) {
        if (!sc.enabled) continue;
        if (!sc.nextRun) { sc.nextRun = computeNextRun(sc.timing, now); changed = true; continue; }
        if (sc.nextRun <= now) {
          // still running, or too many runs in flight → leave nextRun due; a later tick picks it up
          if (ACTIVE_SCHED.has(sc.id) || run.length + ACTIVE_SCHED.size >= MAX_CONCURRENT_RUNS) continue;
          const prevLastRun = sc.lastRun;
          sc.lastRun = now; sc.nextRun = computeNextRun(sc.timing, now + 1000); changed = true; run.push(Object.assign({}, sc, { _prevLastRun: prevLastRun }));
        }
      }
      if (changed) await writeSchedules(list);
      return run;
    });
    for (const sc of toRun) runScheduled(sc);
  } catch { /* */ } finally { SCHED_TICKING = false; }
}
// .unref(): the scheduler tick must not be the reason the process refuses to exit — a test that
// requires lib/engine (directly or via server.js) would otherwise hang for 30s per tick forever.
// CLAUDE_UI_NO_SCHEDULER=1 is the test-only seam: a test server that forgot CLAUDE_UI_DATA_DIR ticked
// against the REAL ui-skill-schedules.json and could start a real, paid headless run. verify.js sets
// it for everything it boots. Inert in production (unset → the tick runs as before).
if (process.env.CLAUDE_UI_NO_SCHEDULER !== '1') setInterval(scheduleTick, 30000).unref();

module.exports = { engineRuns, runUiSkillHeadless, runScheduled, scheduleRunning, activeRunCount, MAX_CONCURRENT_RUNS, HEADLESS_DENIED_TOOLS, headlessToolAllowed, scheduleTick, abortHeadlessRuns };
