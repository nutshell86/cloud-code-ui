'use strict';
// Chat engine — one claude.exe process per conversation, SSE broadcast, live controls
// (mode/effort/model), permission responses, and the orphan/dead reaper. Owns the `chats` Map.
// Extracted from server.js (structure-only refactor).
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const { CLAUDE_EXE, HOME } = require('./paths');
const { ultracodeSpawnSettings } = require('./pure');
const { killTree, maskUrl, errorText, isUncOrDevicePath } = require('./core');
const { isCliUpdating, cliUpdatingError, PROMPT_SNAPSHOT_FLAG } = require('./cli');
const { createBudgetWatch } = require('./budget');
// the SAME aggregation the browser's breakdown panel is tested against (lib/engine.js and
// lib/result-file.js reach into public/js for the same reason): the grouping and its counter-check are
// pure logic, and a second copy on the server is a second rule one refactor away from drifting.
const { ctxMcpAggregate } = require('../public/js/ctx-breakdown');
const { hookListingTrim } = require('../public/js/hooks-catalog');

const chats = new Map(); // chatId -> { proc, clients:Set<res>, buffer:[], meta, sessionId, alive }

// The permission modes the CLI accepts (`claude --help`: --permission-mode). The panel offered four of
// them for a long time; `auto` is the middle ground between "asks about every tool" and "asks about
// nothing", `manual`/`dontAsk` are the two edges (A6). One list, used by the start route AND the live
// switch, so the two can't drift apart.
const PERM_MODES = ['default', 'plan', 'acceptEdits', 'auto', 'manual', 'dontAsk', 'bypassPermissions'];
// The reasoning levels the CLI accepts (`claude --help`: --effort, literally „Effort level for the
// current session (low, medium, high, xhigh, max)"). ONE list for the spawn AND for the live switch, same
// reason as PERM_MODES: the live route kept its own hand-written copy that was missing `max`, so a level
// the CLI has always accepted live was answered with 400 and detoured through a session restart. `max`
// reaches a running process just like the others — the CLI validates `effortLevel` against exactly this
// ladder. 'auto' is NOT in it and never can be: it is the CLI's own DISPLAY word for „no explicit level"
// (`--effort auto` is rejected with "Unknown --effort value"), and over the control channel it is
// `effortLevel: null` (see setChatEffort).
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
// `maxEffortLevel` (settings.json, CLI 2.1.267) caps how high a session may reason. The panel offered
// every level regardless, so a capped machine failed at the spawn instead of in the picker. Reading
// the cap here keeps the CLI's own ordering as the single source of what "higher" means.
function effortLevelsUpTo(max) {
  const i = EFFORT_LEVELS.indexOf(String(max || '').trim().toLowerCase());
  return i < 0 ? EFFORT_LEVELS.slice() : EFFORT_LEVELS.slice(0, i + 1);
}

// argv is assembled from request/manifest values (model, effort, name, prompt …). spawn() runs WITHOUT a
// shell, so a value can never split into extra arguments — but a value that LOOKS like a flag makes the
// CLI's own option parser read the token after it as something else than the value it was meant to be.
// So the ids that can never legitimately begin with a dash are checked here, at the one place every
// caller (start route, headless engine, skill manifest) passes through. Free text (--append-system-prompt,
// --name) is deliberately NOT checked: a guardrail line or a tab name may well start with "- ". Those two
// are passed as `--flag=<value>`, one argv token, so they need no check (see below).
function argIdent(what, v) {
  const s = String(v);
  if (s.startsWith('-')) { const e = new Error('invalid ' + what); e.statusCode = 400; throw e; }
  return s;
}
// `--resume`/`--session-id` never carry free text: the value is the UUID the CLI mints for a session and
// names its <id>.jsonl after. The start route already checks the body (isValidSessionId), but the headless
// engine and a skill manifest reach this spawn without passing through server.js — and an id is the one
// argv value that is ALSO a file name, so it is held to the exact shape here, at the sink. An allow-list
// by construction: a flag-shaped id (leading '-') cannot pass it either.
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function argSessionId(what, v) {
  const s = String(v);
  if (!SESSION_UUID_RE.test(s)) { const e = new Error('invalid ' + what); e.statusCode = 400; throw e; }
  return s;
}

// Drop a chat from the map AND end its registered SSE responses. Deleting without ending used to
// leak the sockets (plus their 20s ping timers) until the browser navigated away — ending the
// response fires the request's 'close', which clears the ping interval registered in server.js.
// Only deletes the map entry if it still IS this chat (B2/FLOW-1): a stale handle (a finish() that
// runs late, a reaper pass over a snapshot, a second terminate of the same object) must never take
// out whatever lives under that key now.
function removeChat(chat) {
  for (const res of chat.clients) { try { res.end(); } catch { /* */ } }
  chat.clients.clear();
  if (chats.get(chat.id) === chat) chats.delete(chat.id);
}
// THE way a chat process ends (B2/FLOW-1) — killChat, the stop route, the reaper, the headless engine's
// finish() and shutdown() all go through here. It used to be `stdin.end(); proc.kill()` in two copies:
// proc.kill() on Windows is TerminateProcess on claude.exe only, so its MCP children (node/python
// servers) survived as orphans, and it fired in the same tick as stdin.end(), so the CLI never got the
// chance to flush its transcript on the clean EOF path.
//   • resume (a new process is about to `--resume` the same .jsonl): killTree NOW — two writers on
//     one transcript is the thing to avoid, a clean flush of the old one is not worth the overlap;
//   • otherwise: EOF first, give it graceMs (1.5 s) to exit on its own, then killTree only if it is
//     still running (exitCode AND signalCode both null — after a clean exit the pid may already be
//     reused by an unrelated process, and taskkill /T would take that one's tree instead).
// The map entry goes immediately either way (a dead handle must not be found by the next lookup) — but
// the chat stays in TERMINATING until its process is gone, so a resume can still find it (below).
// Returns a promise that settles when the process is gone: on its 'exit', or — after a tree kill —
// at the latest TERMINATE_EXIT_WAIT_MS after killTree settled (taskkill's answer, or at most
// KILL_TREE_WAIT_MS; taskkill itself is never cut short, see lib/core killTree). Only past both bounds
// can it settle with the process still running. Callers that do not care (killChat users, the reaper)
// simply don't await it — the timers are unref'd.
// A resume ESCALATES a graceful end that is still in its grace: the client's normal path is the stop
// route (graceful) and THEN start {resume}, and joining the pending promise would have let the new
// `--resume` writer run next to the old one for the rest of the grace (#1/#17).
const TERMINATE_GRACE_MS = 1500;
const TERMINATE_EXIT_WAIT_MS = 1000;
const TERMINATING = new Set(); // chats whose process is being ended; each leaves when its promise settles
function terminateChat(chat, opts) {
  if (!chat) return Promise.resolve();
  const resume = !!(opts && opts.resume);
  const graceMs = (opts && Number.isFinite(opts.graceMs)) ? opts.graceMs : TERMINATE_GRACE_MS;
  removeChat(chat);
  const proc = chat.proc;
  const running = () => !!proc && proc.exitCode === null && proc.signalCode === null;
  if (!running()) return Promise.resolve();
  if (chat.terminating) { // idempotent: a second call joins the first (a resume makes it end NOW)
    if (resume) chat.terminateNow();
    return chat.terminating;
  }
  TERMINATING.add(chat);
  try { proc.stdin.end(); } catch { /* */ }
  chat.terminating = new Promise((resolve) => {
    let t = null, killed = false;
    const done = () => { clearTimeout(t); proc.removeListener('exit', done); TERMINATING.delete(chat); resolve(); };
    proc.once('exit', done);
    // the tree kill, at most once. No proc.kill() before it: that ends the parent only, and taskkill
    // /T then finds no process to start the tree from — the MCP children are orphaned.
    chat.terminateNow = () => {
      if (killed) return;
      killed = true;
      clearTimeout(t);
      if (!running()) { done(); return; }
      killTree(proc).then(() => {
        if (!running()) { done(); return; }
        // taskkill has answered (or killTree stopped waiting for it); 'exit' follows once the OS has
        // actually torn the process down
        t = setTimeout(done, TERMINATE_EXIT_WAIT_MS);
        if (t.unref) t.unref();
      });
    };
    if (resume) { chat.terminateNow(); return; }
    t = setTimeout(chat.terminateNow, graceMs);
    if (t.unref) t.unref();
  });
  return chat.terminating;
}
function killChat(chat, opts) { return terminateChat(chat, opts); }

// Every live process attached to session `id` — in the map, AND already removed from it but still
// being ended (a graceful stop in its grace). Matched against the id the chat was STARTED with as
// well as the one a stream frame reported (see startChat).
function resumeCollisions(id) {
  const hit = new Set();
  for (const c of [...chats.values(), ...TERMINATING]) {
    if (c.alive && (c.sessionId === id || c.claudeSessionId === id)) hit.add(c);
  }
  return [...hit];
}
// CHAT-FLOW-4 — WHO a session belongs to, decided here and nowhere else. The resume guard above ended every
// process of a session, whether a browser was still reading its stream or not — and that browser learned
// nothing (terminateChat → removeChat ends the stream BEFORE the process's `_exit` is broadcast), took the end
// for a reaped chat and resumed straight back. Two panel windows on one session (start.cmd a second time,
// localhost next to 127.0.0.1, a second browser) killed each other's process on every input, turns included.
// The browser cannot decide this: a BroadcastChannel only reaches the same origin and profile, and two
// windows that boot at the same moment would both resume before either heard the other. The start route is
// the one place every resume passes through, serialised — so the owner is decided here:
//   · the process a browser stream is ATTACHED to owns its session;
//   · and so does a FRESH process for CLAIM_MS after its spawn, as long as no stream ever attached: between
//     POST /api/chat/start and its EventSource there is no client yet (and the server adds one only after the
//     replay), so two resumes that land in that gap — two windows after a server restart — would kill each
//     other silently, with no `_superseded` reaching anyone.
// A process that is already being ended (`terminating`) owns nothing any more. Neither does one whose
// stream attached once and has gone — that is the reload, or a tab that was closed; ending it is right.
// What is NOT an owner by this rule, deliberately (docs: CHANGELOG): a headless engine run never attaches a
// stream, so it holds its session only for the claim window. That is the existing behaviour of a resume
// against a scheduled run, unchanged — not part of the two-window fix.
const ATTACH_SETTLE_MS = 500;
const CLAIM_MS = 5000;
function holdsSession(c, now) {
  if (c.terminating) return false;
  if (c.clients && c.clients.size > 0) return true;
  return !c._everAttached && now - (c.createdAt || 0) < CLAIM_MS;
}
// What the 409 and the read-only probe (GET /api/session/open) both answer — ONE function, so the card that
// offers the takeover and the refusal that produced it cannot disagree.
//   open     — some live process of `id` is owned by the rule above;
//   busy     — one of them has a turn OPEN: a message went in (or the model began to answer on the main
//              thread) and no `result` came back yet. A follow-up turn the CLI runs by itself after a
//              background agent reports is caught by its frames; an agent working in the background with no
//              main-thread frame is NOT — so `false` does not mean „nothing runs there", and the browser
//              must not say it does;
//   starting — every owner is in its claim window, i.e. no browser has attached to it yet.
function sessionHold(id) {
  const now = Date.now();
  const held = id ? resumeCollisions(id).filter((c) => holdsSession(c, now)) : [];
  return {
    open: held.length > 0,
    busy: held.some((c) => !!c.turnOpen),
    starting: held.length > 0 && held.every((c) => !(c.clients && c.clients.size)),
  };
}
// The refusal, in two halves, both thrown (not answered): the route's second call sits in a try whose catch has
// a temp file to clean up. `extra` carries `busy`/`starting` into the JSON answer (server.js's router passes it
// on), so the card can warn about a running turn.
//   · refuseIfHeld — SYNCHRONOUS, for the route's resume loop, called right before endResumeCollisions in the
//     same tick. An `await` between the verdict and the kill would let a second resume of the same session —
//     one that passed its own check during the route's awaits — spawn its process in that gap, and this one
//     would then end it unasked (test/integration.test.js releases two starts from the same --help probe await:
//     with an `await` here the second one kills the first, synchronously it gets its 409);
//   · refuseIfOpenElsewhere — the first check, before the route writes anything. A browser that RELOADS asks to
//     resume before its old stream is reported closed (the socket's 'close' can trail the new page's first
//     request), so an attached owner is given ATTACH_SETTLE_MS to let go before the answer is no. The claim
//     window is not waited out: no client can leave a stream it never had, so the verdict would not change.
function refuseIfHeld(id) {
  const st = sessionHold(id);
  if (!st.open) return;
  const e = new Error('session open elsewhere');
  e.statusCode = 409; e.code = 'session-open-elsewhere';
  e.extra = { busy: st.busy, starting: st.starting };
  throw e;
}
async function refuseIfOpenElsewhere(id) {
  const t0 = Date.now();
  let st = sessionHold(id);
  while (st.open && !st.starting && Date.now() - t0 < ATTACH_SETTLE_MS) {
    await new Promise((r) => setTimeout(r, 50));
    st = sessionHold(id);
  }
  refuseIfHeld(id);
}
// A process ended because ANOTHER caller resumes its session is told so first. Only a chat with a client —
// nobody else could read it, and a stand-in without a replay buffer would not survive broadcast() — and
// strictly BEFORE terminateChat: its removeChat ends the streams, after that there is no one left to tell.
function endSuperseded(c) {
  if (c.clients && c.clients.size) broadcast(c, { type: '_superseded' });
  return terminateChat(c, { resume: true });
}
// The awaitable half of the resume guard, for the start route (#1/#17): tree-kills every process of
// session `id` now and settles once they are gone (bounded by killTree's 5 s cap plus
// TERMINATE_EXIT_WAIT_MS). null when nothing collides — the common start then pays nothing.
// Whether it MAY end them is not decided here: the route asks refuseIfHeld in the same tick first, unless the
// user asked for the takeover (CHAT-FLOW-4).
function endResumeCollisions(id) {
  const hit = id ? resumeCollisions(id) : [];
  if (!hit.length) return null;
  return Promise.allSettled(hit.map(endSuperseded)).then(() => {});
}

const SSE_BUFFER_CAP = 5000, SSE_BUFFER_SLACK = 512;
function broadcast(chat, event) {
  const seq = event._seq = chat.seq = (chat.seq || 0) + 1;
  chat.lastActivity = Date.now();
  // Serialise ONCE into a full SSE frame (with an `id:` for Last-Event-ID resume) and reuse it for
  // both the live write and any reconnect replay. Buffer holds {seq, frame}.
  const frame = `id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`;
  chat.buffer.push({ seq, frame });
  // amortised trim instead of a per-event Array.shift() (which is O(n) once the buffer is full)
  if (chat.buffer.length > SSE_BUFFER_CAP + SSE_BUFFER_SLACK) chat.buffer.splice(0, chat.buffer.length - SSE_BUFFER_CAP);
  if (chat.onEvent) { try { chat.onEvent(event); } catch { /* headless listener */ } }
  for (const res of chat.clients) {
    try { res.write(frame); } catch { /* client gone */ }
  }
}

function startChat(opts) {
  // B1/FLOW-6: no claude.exe while `claude update` replaces it. Checked HERE, at the one function every
  // chat spawn passes through (start route, headless engine, ui-skill runs), so a new caller cannot
  // forget it. Thrown before anything else — in particular before the resume guard below kills the
  // old process of a session that then could not be restarted. 503 + code 'cli-updating' (+ hint).
  if (isCliUpdating()) throw cliUpdatingError();
  // A test run never starts a CHAT on the real binary (the other spawns — lib/cli claudeSpawn, since #86 also
  // the --help probe every server boot pre-warms — are not covered here, see docs/ideas.md R4). Under
  // `node --test` (the runner sets NODE_TEST_CONTEXT in every test process, and every server a suite boots
  // inherits it) a start without CLAUDE_UI_FAKE_BIN would spawn CLAUDE_EXE — the paid model. verify.js hides
  // that by putting the fake into every suite's env, so a suite that forgot the seam went green there and
  // spent money when run on its own: test/session-state.test.js did exactly that (four transcripts with a
  // real user turn, found in the P-0 cross-check). Thrown before anything else, like the update gate above,
  // so not even the resume guard below runs. Production never sees it: nothing sets NODE_TEST_CONTEXT outside
  // the test runner.
  if (process.env.NODE_TEST_CONTEXT && !process.env.CLAUDE_UI_FAKE_BIN) {
    const e = new Error('startChat under node --test without CLAUDE_UI_FAKE_BIN — refusing to spawn the real CLI (' + CLAUDE_EXE + ')');
    e.statusCode = 500; e.code = 'real-cli-in-test';
    throw e;
  }
  const chatId = crypto.randomUUID();
  // The two ids are resolved (and validated) BEFORE anything else, because the guard below needs them:
  // `claudeSessionId` is the session this process will run as — known here, synchronously, for a fresh
  // spawn too (its `--session-id` used to be minted inline and then existed nowhere).
  const resumeId = opts.resume ? argSessionId('resume id', opts.resume) : null;
  const claudeSessionId = resumeId || (opts.sessionId ? argSessionId('session id', opts.sessionId) : crypto.randomUUID());
  // Resuming a session that ALREADY has a live process (e.g. a reload re-resumes the auto-activated tab while
  // the pre-reload process lingers client-less) → kill the old one first, so two claude.exe don't stay
  // `--resume`-attached to the same transcript .jsonl (contention) until the 30-min orphan reaper.
  // Matched against the id the chat was STARTED with as well, not only the one a stream frame reported:
  // `chat.sessionId` is filled from a LATER frame, so between the spawn and that frame the scan below
  // found nothing and a second resume of the same transcript slipped through. The id is recorded in
  // `chats` synchronously at the bottom of this function, which makes that window zero.
  // This is the BACKSTOP and does not wait (startChat is synchronous): the start route awaits
  // endResumeCollisions() first, so there the old process is already gone when we get here.
  // A FORK is exempt, for the same reason it reserves no id (see claudeSessionId below):
  // `--fork-session` writes its OWN transcript, so it is in contention with nothing — and killing the
  // source would end the very tab the user asked to duplicate (forkTab keeps it open next to the fork).
  if (resumeId && !opts.fork) {
    for (const c of resumeCollisions(resumeId)) endSuperseded(c); // a browser on it is told first (CHAT-FLOW-4)
  }
  // Validated here, not only in the HTTP route: the headless engine and a ui-skill manifest reach
  // this spawn without passing through server.js, and they rewrite only the single literal
  // 'bypassPermissions'. PERM_MODES is right at the top of this file, and --effort below already
  // takes exactly this shape, so the mode should not be the one argv value nobody checks.
  const permMode = opts.permissionMode ? String(opts.permissionMode) : 'plan';
  if (!PERM_MODES.includes(permMode)) { const e = new Error('invalid permission mode'); e.statusCode = 400; throw e; }
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    // Route every "ask" permission decision back over the stdout control channel as a
    // `can_use_tool` control_request (answered via respondPermission), instead of silently
    // denying it. The literal "stdio" is the CLI's sentinel for exactly this (it's what the
    // Agent SDK passes when a canUseTool callback is supplied). Harmless in bypass/plan mode
    // and for allow-listed/safe tools — those never produce an "ask".
    '--permission-prompt-tool', 'stdio',
    '--permission-mode', permMode,
  ];
  if (opts.model) args.push('--model', argIdent('model', opts.model));
  // G3 — the stand-in model (`--fallback-model <model>`, verified against the 2.1.286 binary's own
  // --help: „Enable automatic fallback to specified model(s) when the default model is overloaded or not
  // available. Accepts a comma-separated list to try each in order. Re-tries the primary at the start of
  // each user turn."). The flag did not appear anywhere in this repo, so the one thing that turns a 529
  // into a completed turn was unreachable from the panel.
  //
  // A per-RUN value, never a global preference, and deliberately so: the fallback is a DIFFERENT model
  // than the one that was chosen, so an unattended schedule quietly falling to it is a state change
  // somebody has to be told about. It therefore travels exactly like `model` and `effort` — explicitly
  // set on this start, on the skill's run block, or on the schedule — and is recorded with the run
  // (lib/engine.js). When PR-1's buildSpawnPolicy lands it must carry it the same way: alongside
  // model/effort, NOT in the inherited-global group next to the guardrails.
  //
  // The EMPTY case is the one that needs the care, because the field is optional in three places (start
  // body, manifest run block, schedule): `--fallback-model ""` would hand the CLI an empty model id for
  // every run nobody filled it in for. Hence `opts.fallbackModel ? …` rather than `== null ? …` — a falsy
  // NON-string (the `false`/`0` a checkbox or an empty number field sends) stringifies to the literal
  // "false"/"0" and would travel on as a model id. Same guard shape as appendSystem / agent / name below.
  const fallbackModel = opts.fallbackModel ? String(opts.fallbackModel).trim() : '';
  let fallbackDropped = '';   // …and it reaches `meta` below, which is only built once the args are done
  if (fallbackModel) {
    // A fallback equal to the main model is DROPPED here rather than thrown at, for two reasons.
    // The justification this used to carry was simply false: „the CLI refuses this itself at STARTUP".
    // „Fallback model cannot be the same as the main model" sits in exactly one code position in the
    // binary — inside the Agent SDK's own argv builder, beside „Spawning Claude Code (custom): " — i.e. a
    // pre-check a CALLER runs on itself. The CLI's own consumer registers `--fallback-model`, splits it on
    // commas and trims it, and never compares it to the model. The panel was forbidding a configuration
    // the CLI accepts, and citing the CLI for it.
    // Worse, a throw HERE is not a 400 in a form: this function is also the spawn path of every scheduled
    // run, where it lands in a catch that writes `status: 'error'` without ever reaching the history. A
    // nightly schedule would have died unexplained every night — the exact failure class this PR removes.
    // So the ROUTES reject it with a 400 where the value was typed, and the spawn path only declines to
    // pass a flag that could do nothing anyway, and records that it did.
    // String equality only: `opus[1m]` and `opus` are the same model to the CLI but not to this check, and
    // the CLI stays the authority on that.
    if (opts.model && String(opts.model).trim() === fallbackModel) {
      fallbackDropped = fallbackModel;
    } else {
      args.push('--fallback-model', argIdent('fallback model', fallbackModel));
    }
  }
  if (opts.effort) {
    const eff = String(opts.effort);
    if (!EFFORT_LEVELS.includes(eff)) { const e = new Error('invalid effort'); e.statusCode = 400; throw e; }
    args.push('--effort', eff);
  }
  // Subagent policy (#34) — composed by lib/pure subagentSpawnConfig from the global default and this
  // tab's override, so a headless run inherits it too. Read here, not further down, because its
  // `tools` belong in the SAME denial list as the caller's own (see right below).
  const subagents = (opts.subagents && typeof opts.subagents === 'object') ? opts.subagents : {};
  // A SECOND enforcement point for a caller that denies tools (the headless engine passes its shell set
  // here). The CLI refuses these names itself for the whole session, so the permission responder is no
  // longer the only thing standing between an unattended run and a shell. Comma-separated on purpose —
  // `--disallowed-tools <tools...>` is variadic, and one token cannot swallow the flags that follow it.
  //
  // ONE list, ONE flag — and that is not cosmetic: the subagent off-switch used to push its own
  // `--disallowedTools Agent Task` further down, so a headless run (which always denies the shell
  // tools through `opts.disallowedTools`) with subagents switched off emitted the flag TWICE. Whether
  // the CLI unions both occurrences or lets the last one win is not documented — and "last wins"
  // would silently drop the shell denial in exactly the unattended run where it is the only guard.
  const denied = [...(Array.isArray(opts.disallowedTools) ? opts.disallowedTools : []),
    ...(Array.isArray(subagents.tools) ? subagents.tools : [])]
    .map((t) => argIdent('tool', t));
  const deniedOnce = [...new Set(denied)];
  if (deniedOnce.length) args.push('--disallowed-tools', deniedOnce.join(','));
  // `--flag=<value>`, not two tokens (#17): these two carry FREE TEXT — a guardrail line or a tab name
  // may legitimately begin with "- ", so argIdent above must not be applied to them, and a value that
  // looks like a flag is then the CLI option parser's problem. In the `=` form the flag and its value
  // are ONE argv token, so there is no following token to be reinterpreted, whatever the parser does
  // with a dash. Same reason --disallowed-tools is joined into one token further up.
  if (opts.appendSystem && String(opts.appendSystem).trim()) args.push('--append-system-prompt=' + String(opts.appendSystem).trim());
  // PR-S — without this the line above does not reach a RESUMED session: the CLI records the system
  // prompt on a conversation's first request and replays that record on every resume until the next
  // compaction (measured 2026-10-03 against 2.1.288 — see the note at the top of lib/pure.js). Decided in
  // lib/pure.js buildSpawnPolicy (setting + proof that this CLI lists the flag in its --help), so here it
  // is only ever the literal 'off' or nothing: 'on' is the CLI default and travels as NO flag, which keeps
  // that argv byte-identical to before. Not tied to appendSystem — the record covers the whole prompt.
  // Two tokens, not `--flag=value`: the value is generated, never free text, so it cannot look like a flag.
  if (opts.systemPromptSnapshot === 'off') args.push(PROMPT_SNAPSHOT_FLAG, 'off');
  // Hard dollar ceiling for a run (A3). The CLI ends the session once it is reached — which is the
  // only real control for an unattended schedule; before this the sole limit was the engine's 10-minute
  // timeout, so a radar that looped at night just kept spending. `--max-budget-usd` needs --print,
  // which this spawn always uses.
  const budget = Number(opts.maxBudgetUsd);
  if (Number.isFinite(budget) && budget > 0) args.push('--max-budget-usd', String(budget));
  // Extra readable roots (A15) — e.g. the repo AND an ABAP export in one chat, instead of copying
  // between them. Non-existent paths are dropped rather than failing the start: a stale entry in a
  // restored tab must not make the tab unusable.
  // A NETWORK or device path is NOT checked, it is handed on — the reason is written out at the cwd
  // below, and here the pass-through is free as well as right: an --add-dir value becomes nothing but an
  // argv token, so no code in THIS process ever touches that path. The CLI resolves it and reports its
  // own failure. Checking it instead cost 43 918 ms of frozen panel per stale entry, measured, and the
  // reward for the wait was to silently drop a root the user had asked for (lib/core.js pathExists).
  // J11 — a mapped drive letter on a dead share looks local and still froze the panel here, once per chat of a
  // project that carries it. So the start ROUTE measures cwd and every --add-dir BEFORE this call, off the event
  // loop and with a deadline (lib/projects.js checkPaths), and hands the verdicts in as `opts.pathCheck`
  // { "<path as given>": 'ok' | 'missing' | 'unchecked' }. This function stays synchronous — the route's owner
  // check relies on „verdict and spawn in one tick" (refuseIfHeld) — and only READS them: 'missing' is what
  // existsSync's false was (dropped / HOME, as before), 'ok' and 'unchecked' are kept, an unmeasured root like a
  // share (the route refuses an unmeasured cwd before it gets here). Callers without a measurement — the headless
  // engine, UI-skill runs — still ask below, as before.
  const measured = (opts.pathCheck && typeof opts.pathCheck === 'object') ? opts.pathCheck : null;
  const reach = (p) => ((measured && typeof p === 'string' && Object.prototype.hasOwnProperty.call(measured, p)) ? measured[p] !== 'missing' : undefined);
  if (Array.isArray(opts.addDirs)) {
    for (const d of opts.addDirs) {
      const dir = String(d || '').trim();
      if (dir && dir !== opts.cwd && (reach(dir) ?? (isUncOrDevicePath(dir) || fs.existsSync(dir)))) args.push('--add-dir', dir);
    }
  }
  // C2 — the session agent (`--agent <name>`, „Agent for the current session. Overrides the 'agent'
  // setting."). The panel already MANAGES these files (lib/skills.js CFG_KINDS.agents: list, editor,
  // backups) — this is the piece that was missing: using one. A launch flag, so it is picked before the
  // start like the cwd. `--agents <json>` stays out: the CLI validates that itself, and a JSON field in
  // a tab menu is an invitation to broken sessions.
  if (opts.agent && String(opts.agent).trim()) args.push('--agent', argIdent('agent', String(opts.agent).trim()));
  // C3 — a git worktree of its own for this chat (`-w, --worktree [name]`). The name is OPTIONAL: true
  // means „let the CLI name it". Consequence the panel has to carry: the session's cwd is then NOT the
  // cwd that was requested, which is why chat-events.js adopts the cwd the `init` frame reports.
  if (opts.worktree) {
    args.push('--worktree');
    const wt = (opts.worktree === true) ? '' : String(opts.worktree).trim();
    if (wt) args.push(argIdent('worktree', wt));
  }
  // Ultracode — standing dynamic-workflow orchestration for this session (see lib/pure.js
  // resolveUltracode for what it is and why the panel needs its own switch). `--settings` adds one more
  // settings LAYER from a JSON string; it does not replace the settings files. Two argv tokens rather
  // than the `--flag=value` form used for free text above: this value is generated here and always
  // starts with `{`, so it can never be read as a flag. MEASURED (2.1.285): with this at spawn,
  // get_settings reports `applied.ultracode: true` before the first turn.
  const ucSettings = ultracodeSpawnSettings(opts.ultracode === true);
  if (ucSettings) args.push('--settings', ucSettings);
  // Give the CLI the same display name the panel shows (N2), so the terminal's `/resume` picker and the
  // panel agree instead of the CLI keeping its own auto-title. Only at spawn — a later rename in the
  // panel reaches the CLI at the next start/resume.
  if (opts.name && String(opts.name).trim()) args.push('--name=' + String(opts.name).trim().slice(0, 80));
  // Let the CLI predict the next prompt itself (N1) instead of the panel guessing quick replies from
  // the answer text with a regex. Emits a `prompt_suggestion` frame after each turn; opt-in.
  if (opts.promptSuggestions) args.push('--prompt-suggestions', 'true');
  // Two opt-in stream widenings. Both cost extra frames per turn, so neither is ever on by default:
  //   · hook lifecycle events — the panel configures hooks but could not show that one FIRED;
  //   · subagent text/thinking as frames with parent_tool_use_id — the only live source for a
  //     FOREGROUND agent, which writes no transcript file of its own (#34).
  if (opts.includeHookEvents) args.push('--include-hook-events');
  if (opts.forwardSubagentText) args.push('--forward-subagent-text');
  if (resumeId) {
    args.push('--resume', resumeId);
    if (opts.fork) args.push('--fork-session');
  } else {
    args.push('--session-id', claudeSessionId);
  }
  // per-session MCP scope: run ONLY the servers in the caller-built temp config. Absent → all (default, unchanged).
  if (opts.mcpConfigPath) args.push('--mcp-config', opts.mcpConfigPath, '--strict-mcp-config');
  // (the subagent policy is read further up — its denied tools share the one --disallowed-tools list;
  // its model and ceilings ride in `env` at the spawn below)

  // ---- the directory this chat really runs in: a form-aware fork, and the fork is the point ----
  // A LOCAL path is checked exactly as before, and a missing one still becomes HOME.
  // A NETWORK path (\\server\share) or a device path (\\?\…) is PASSED THROUGH UNCHECKED.
  //
  // That second branch is a deliberate behaviour change, and not primarily a performance one. What
  // `fs.existsSync` did to such a path, measured here on 2026-10-03 (node v26.7.0, fresh TEST-NET-1 host
  // \\192.0.2.12\share so no negative cache could help): it took 43 918 ms, and all 43 919 ms of that
  // were the EVENT LOOP — the single thread that serves every request — so one chat start froze the whole
  // panel for three quarters of a minute. Then it answered `false`, and the session was started in HOME:
  // the panel had passed judgement on something it cannot cheaply check and then quietly acted somewhere
  // other than where the user said. That is this repo's own recurring defect, the surface asserting what
  // nobody verified, and it is the half worth fixing. So the panel does not guess: the path goes to the
  // spawn, and whatever really cannot reach it says so — the tab gets a `_error` frame carrying the real
  // reason (proc.on('error') further down) instead of a session in the wrong directory.
  //
  // What this function canNOT do on its own: Windows resolves a process's working directory inside
  // CreateProcessW, which libuv calls on this very thread, so `spawn()` with an unreachable UNC cwd held
  // the loop for 30 939 ms before its ENOENT — and a mapped drive letter (Z:\) on a dead share is the same
  // wait wearing a local-looking name that no shape test sees. Only an async stat catches both, and this
  // function stays synchronous (the resume wait before it must reach the spawn without an await). So the
  // CALLERS ask first: POST /api/chat/start and the headless engine refuse a cwd or --add-dir that does not
  // answer within a few seconds (N12, lib/reach.js firstUnreachable, network paths included), and the start
  // route hands its local verdicts in as `opts.pathCheck` (J11, see --add-dir above), which `reach` reads here.
  const cwd = (opts.cwd && (reach(opts.cwd) ?? (isUncOrDevicePath(opts.cwd) || fs.existsSync(opts.cwd)))) ? opts.cwd : HOME;
  // Test-only seam: point CLAUDE_UI_FAKE_BIN at a node script that emulates claude's stream-json protocol, so the
  // resume/reconnect/self-heal path can be exercised with no real model call and no cost. Inert in production
  // (unset → byte-identical to spawning CLAUDE_EXE). Spawns `node <fake> <claude-args>` (no shell, cross-platform).
  const FAKE_BIN = process.env.CLAUDE_UI_FAKE_BIN;
  const [spawnBin, spawnPre] = FAKE_BIN ? [process.execPath, [FAKE_BIN]] : [CLAUDE_EXE, []];
  // How long the FIRST non-interactive turn may wait for the MCP servers to come up
  // (CLAUDE_CODE_MCP_STARTUP_WAIT_MS, CLI 2.1.274). Measured on this machine: with eight configured
  // servers the `init` frame can take minutes, and the tab sits on "◌ startet…" for all of it. A
  // ceiling turns that into a bounded wait — the servers keep connecting, the turn just stops
  // blocking on them. Panel-side only, so it is passed as env rather than baked into settings.json.
  const mcpWait = Number(opts.mcpStartupWaitMs);
  const panelEnv = {};
  if (Number.isFinite(mcpWait) && mcpWait > 0) panelEnv.CLAUDE_CODE_MCP_STARTUP_WAIT_MS = String(Math.round(mcpWait));
  // G5 — ask the CLI to report its own session state (`system/session_state_changed` with
  // running | requires_action | idle). MEASURED 2026-10-02 against 2.1.286
  // (docs/messung-2026-10-02.md): the binary has exactly ONE emission site for that frame and it is
  // gated on this variable — `else if (CLAUDE_CODE_SDK_READS_SESSION_STATE)` only yields a
  // `sdk_host_only` variant, which the TypeScript SDK sets for itself. That is the whole reason the SDK
  // sees these frames and this panel did not: nothing here passed either variable on. None of the ten
  // measured frames carried `sdk_host_only`, so this flag is the cause of their arrival, not a theory.
  // Unconditional, not a preference: it costs no tokens (local frames, no API call), and a tab whose
  // state the CLI reports must not depend on a switch nobody would find.
  // The HEADLESS/schedule path (lib/engine.js) runs through this same startChat, so it gets the frames
  // too — DELIBERATELY without changing where an unattended run decides it is finished. That decision
  // stays on `result`: the same measurement's second run showed `idle` arriving three times, twice
  // mid-run, once four frames before a workflow started four agents (`idle` _seq 40, `task_started`
  // _seq 42). A run that finished on `idle` would cut itself off there; one that WAITED for it would
  // hang past a `result` the CLI will not follow with another frame. The frames are harmless where
  // nobody reads them, and the browser (chat-events.js) is where they mean something.
  panelEnv.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1';
  const proc = spawn(spawnBin, [...spawnPre, ...args], {
    cwd,
    windowsHide: true,
    // The panel's own env comes LAST so a value set here wins over the same variable inherited from
    // the shell the server was started in — otherwise the UI would claim a setting the CLI ignores.
    env: { ...process.env, FORCE_COLOR: '0', ...panelEnv, ...(subagents.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // A broken pipe to the child (it exited / was killed, then we write to its stdin) emits an async
  // 'error' on the stream. With no listener that becomes an uncaughtException and would kill the whole
  // panel server. Swallow child-stream errors here — writers already handle the "process not running" case.
  proc.stdin.on('error', () => {});
  proc.stdout.on('error', () => {});
  proc.stderr.on('error', () => {});

  const chat = {
    id: chatId,
    proc,
    clients: new Set(),
    buffer: [],
    pendingControls: new Map(), // request_id -> resolver, for control requests the CLI ANSWERS (see controlRequest)
    // The subset of those whose ANSWER must not reach the browsers (controlRequest `noBroadcast`): a read
    // like get_context_usage would otherwise push its payload (38 KB measured, see getChatContext) into
    // replay buffer every time any tab refreshes its context line (see getChatContext). A marker outlives
    // its request on purpose, so a LATE answer stays quiet too — bound: see markQuiet.
    quietControls: new Set(),
    // The id this process was LAUNCHED with = the resume guard's reservation (see above). A FORK is
    // deliberately not reserved: `--fork-session` writes a NEW transcript, so it is not in contention
    // with the source — reserving the source id here would let a later resume of the original kill the
    // fork. Its own id arrives with the first stream frame (chat.sessionId).
    claudeSessionId: (resumeId && opts.fork) ? null : claudeSessionId,
    sessionId: null,
    alive: true,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    // `ultracode` and `ultracodeWish` are two different facts and both are needed. `ultracode` is what
    // is APPLIED — it starts as the launch value and is overwritten from get_settings by the live
    // switches below, which is also why the start route can hand `meta` to the browser as the receipt of
    // what was launched. `ultracodeWish` is what the user ASKED for and is never overwritten by a
    // read-out: a model that cannot honour it turns `ultracode` to false while the wish stands, and a
    // live effort change has to re-assert exactly that wish (see setChatEffort).
    // G3 travels on the same receipt and for the same reason: `fallbackModel` is the stand-in that was
    // ALLOWED, `fallbackDropped` the one that was refused because it equalled the main model (see above).
    // Both or neither — a dropped flag the panel still displayed as active is the lie this PR removes.
    // `promptSnapshot` (PR-S) is what was PASSED: 'off', or null = no flag, i.e. whatever this CLI does by
    // itself — not 'on', because for a CLI that does not list the flag that would be a claim nobody checked.
    meta: { cwd, model: opts.model || null, fallbackModel: fallbackModel || null, fallbackDropped: fallbackDropped || null, effort: opts.effort || null, permissionMode: opts.permissionMode || 'default', resume: opts.resume || null, maxBudgetUsd: (Number.isFinite(budget) && budget > 0) ? budget : null, subagents: subagents.cfg || {}, mcpStartupWaitMs: panelEnv.CLAUDE_CODE_MCP_STARTUP_WAIT_MS ? Number(panelEnv.CLAUDE_CODE_MCP_STARTUP_WAIT_MS) : null, agent: opts.agent || null, worktree: opts.worktree || null, ultracode: opts.ultracode === true, ultracodeWish: opts.ultracode === true, promptSnapshot: opts.systemPromptSnapshot === 'off' ? 'off' : null },
  };
  chats.set(chatId, chat);
  // PR-13 — the cost brake, for a chat launched with a budget (lib/budget.js). Server-side so that a
  // scheduled run, which has no tab, is braked too; null when there is no budget.
  chat.budget = createBudgetWatch(chat, { stopTask, interrupt: interruptChat, broadcast });

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let obj;
    try { obj = JSON.parse(line); } catch { broadcast(chat, { type: '_raw', line }); return; }
    // Capture the CLI session id off ANY frame that carries it (--resume/--fork often omit it from `init`),
    // and on first capture / any change PUSH it to the browser via a synthetic `_session` frame — the client
    // only reads session_id from `init`, so without this it never learns a resumed/forked session's id and the
    // tab can't be persisted for reload.
    if (obj.session_id && chat.sessionId !== obj.session_id) {
      chat.sessionId = obj.session_id;
      // P-0 — the one place the id becomes known, so the one place to report it: a PROPERTY the caller sets
      // after startChat (server.js stores a fork's MCP scope under its new id), not an opts field, and never
      // chat.onEvent, which is the reaper's mark of a headless run. A failing hook must not cost the frame.
      if (typeof chat.onSessionId === 'function') { try { chat.onSessionId(obj.session_id, { fork: !!(resumeId && opts.fork), resume: resumeId }); } catch { /* the caller's business */ } }
      broadcast(chat, { type: '_session', session_id: obj.session_id });
    }
    // Hand a control_response to whoever is waiting for that request_id (still broadcast it as well —
    // the browser transcript is unchanged). Without this the CLI's refusals were dropped on the floor.
    if (obj.type === 'control_response' && obj.response && obj.response.request_id) {
      const rid = obj.response.request_id;
      // …except for the answers the asker declared quiet: those belong to ONE HTTP caller. The transcript
      // gains nothing from them and the replay buffer (SSE_BUFFER_CAP frames, replayed in full to a
      // reconnecting tab) must not fill up with a gauge's reads. This is the ONLY place a marker is retired
      // — an answer the asker already gave up on (past the ceiling, hence no waiter below) still has to be
      // swallowed here, so the marker cannot be tied to the request's lifetime.
      const quiet = !!(chat.quietControls && chat.quietControls.delete(rid));
      const waiter = chat.pendingControls.get(rid);
      if (waiter) waiter(obj.response);
      if (quiet) return;
    }
    if (chat.budget) chat.budget.onFrame(obj); // the brake's task list + its „still active" clock
    // CHAT-FLOW-4 — whether a turn is open, for the takeover warning (sessionHold `busy`). Main-thread
    // output opens it (also a follow-up turn the CLI starts by itself, which no send announces), `result`
    // closes it; sendToChat opens it too. A subagent's forwarded frame is not the session's turn.
    if (obj.type === 'result') chat.turnOpen = false;
    else if ((obj.type === 'stream_event' || obj.type === 'assistant') && !obj.parent_tool_use_id) chat.turnOpen = true;
    broadcast(chat, obj);
  });

  let errBuf = '';
  proc.stderr.on('data', (d) => { errBuf += d.toString(); if (errBuf.length > 20000) errBuf = errBuf.slice(-20000); });
  proc.on('error', (e) => {
    broadcast(chat, { type: '_error', message: errorText(e) });
    // A spawn that FAILS never reports an exit. MEASURED on this machine (2026-10-03, node v26.7.0):
    // `spawn(node, { cwd: <a directory that is not there> })` emits `error ENOENT` and `close -4058` and
    // NO `exit` event at all. So the 'exit' handler below — the only place that ends a chat — does not
    // run, and a chat whose process never came up stayed `alive: true` for ever. Three consequences, all
    // of them this repo's own defect class (a surface asserting something nobody verified):
    //   · resumeCollisions() only looks at LIVE chats, so the phantom kept its claudeSessionId reserved
    //     and a later resume of that session tried to tree-kill a process that never existed;
    //   · the reaper is told never to touch a live chat, so the entry sat in the map for half an hour;
    //   · the per-session MCP config in TEMP was never deleted.
    // This became reachable with the cwd fork above — a network path now goes to the spawn instead of
    // being replaced by HOME — so closing it is part of that change, not a drive-by.
    // `proc.pid === undefined` is precisely "never started": a LATER 'error' on a child process (a kill
    // that failed) must not be read as an end, because that process is still running.
    if (proc.pid === undefined && chat.alive) {
      chat.alive = false;
      chat.endedAt = Date.now();
      if (chat.budget) chat.budget.stop();
      if (opts.mcpConfigPath) fsp.unlink(opts.mcpConfigPath).catch(() => {});
      // The browser already has a dedicated `_error` branch (chat-events.js) that frees the composer and
      // the gates, so this frame is not what tells the USER — it is what tells every server-side reader
      // of `alive`. `code: null` on purpose: there was no exit code, and inventing 1 would claim the
      // process ran and failed.
      broadcast(chat, { type: '_exit', code: null, signal: null, stderr: errorText(e) });
    }
  });
  proc.on('exit', (code, signal) => {
    chat.alive = false;
    chat.endedAt = Date.now();
    if (chat.budget) chat.budget.stop();
    if (opts.mcpConfigPath) fsp.unlink(opts.mcpConfigPath).catch(() => {}); // clean up the temp MCP config
    broadcast(chat, { type: '_exit', code, signal, stderr: errBuf.slice(-4000) });
  });

  return chat;
}

// Reaper — keep the `chats` map from growing without bound:
//   • finished chats linger briefly (buffer replay for a late reconnect), then go;
//   • interactive chats orphaned by a browser reload (no SSE clients, no activity)
//     are killed after a long idle window. Headless engine runs (chat.onEvent set)
//     are never touched — they legitimately run with zero SSE clients.
const CHAT_DEAD_GRACE_MS = 5 * 60 * 1000;
const CHAT_ORPHAN_IDLE_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, chat] of chats) {
    if (!chat.alive) {
      if (now - (chat.endedAt || chat.lastActivity || 0) > CHAT_DEAD_GRACE_MS) removeChat(chat);
      continue;
    }
    if (chat.onEvent) continue; // headless run — leave it alone
    if (chat.clients.size === 0 && now - (chat.lastActivity || chat.createdAt || now) > CHAT_ORPHAN_IDLE_MS) {
      killChat(chat);
    }
  }
}, 2 * 60 * 1000).unref();

function sendToChat(chat, text, attachments) {
  const content = [];
  for (const a of attachments || []) {
    if (a.kind === 'image' && a.data) content.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType || 'image/png', data: a.data } });
    else if (a.kind === 'pdf' && a.data) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } });
    else if (a.kind === 'text' && a.text != null) content.push({ type: 'text', text: (a.name || 'Eingefügter Text') + '\n```\n' + a.text + '\n```' }); // clean label line + plain fence (name is not a code-fence language tag)
  }
  if (text && text.trim()) content.push({ type: 'text', text });
  if (!content.length) content.push({ type: 'text', text: '' });
  const msg = { type: 'user', message: { role: 'user', content } };
  try { if (chat.proc && chat.proc.stdin.writable) { chat.proc.stdin.write(JSON.stringify(msg) + '\n'); chat.turnOpen = true; } } catch { /* child gone */ }
}

function respondPermission(chat, requestId, behavior, updatedInput, message, updatedPermissions) {
  let response;
  if (behavior === 'allow') {
    // IMPORTANT: the CLI runs the tool with `updatedInput ?? originalInput`. Sending an empty
    // {} would REPLACE the model's arguments with nothing (breaking args-bearing tools like
    // jira_get_issue). So only include updatedInput when the caller genuinely modified it —
    // otherwise omit it and let the CLI keep the original, schema-valid input.
    response = { behavior: 'allow' };
    if (updatedInput && typeof updatedInput === 'object' && Object.keys(updatedInput).length) response.updatedInput = updatedInput;
    // "Allow always": addRules suggestions ({toolName, behavior, destination:'session'|'localSettings'}).
    if (Array.isArray(updatedPermissions) && updatedPermissions.length) response.updatedPermissions = updatedPermissions;
  } else {
    response = { behavior: 'deny', message: message || 'Denied by user' };
  }
  const ctrl = {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  };
  try { if (chat.proc && chat.proc.stdin.writable) chat.proc.stdin.write(JSON.stringify(ctrl) + '\n'); } catch { /* child gone */ }
}

function interruptChat(chat) {
  const ctrl = { type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'interrupt' } };
  try { chat.proc.stdin.write(JSON.stringify(ctrl) + '\n'); } catch { /* ignore */ }
}

// switch the permission mode of a RUNNING session live (the stream-json equivalent of the console's
// Shift+Tab), so a mode change takes effect immediately instead of only at the next spawn.
//
// FLOW-3 — this used to write to stdin and return `true`. The route then answered `{ok:true, mode}` and
// the browser set its chip to the picked mode, with nobody having checked anything. That is the same bug
// PR #44 fixed for set_model, in the one place where being wrong is a PERMISSION question.
//
// `set_permission_mode` is answered and it can REFUSE — MEASURED in the installed binary
// (claude.exe 2.1.288, strings as latin1):
//   · the success payload exists and ECHOES the result:
//     `u({mode: de().optional().describe("The permission mode now in effect. Headless CLIs echo it;
//      other hosts may acknowledge with an empty object.")}) .describe("Success payload answering
//      set_permission_mode.")`
//     — the panel talks to a headless CLI over stdio, so the echo is a real read-back, not a hope.
//   · and the refusal reasons are enumerated:
//     `set_permission_mode: invalid_mode, bypass_restricted, bypass_disabled, bypass_not_launched, and
//      for auto auto_mode_settings, auto_mode_circuit_breaker, auto_mode_fast_mode, auto_mode_model or
//      auto_mode_unavailable`.
//     Three of those are about bypassPermissions, which is exactly the mode a managed policy takes away —
//     so the old code's silent „ok" painted a bypassPermissions chip over a session still in `default`.
// → { ok, mode, unconfirmed, error }. `mode` is what the SESSION reported where it reported one, the
// requested value otherwise; `unconfirmed` is controlRequest's 5 s timeout, where the optimistic value
// stands but must be labelled as such (same rule as setChatEffort). A timeout is deliberately NOT a
// failure: should a future CLI stop answering this control, the old behaviour returns rather than a wall
// of false errors.
async function setChatMode(chat, mode) {
  const r = await controlRequest(chat, { subtype: 'set_permission_mode', mode });
  if (!r.ok) return { ok: false, error: String(r.error || 'rejected') };
  const echoed = (r.data && typeof r.data.mode === 'string') ? r.data.mode : '';
  const effective = echoed || mode;
  chat.meta.permissionMode = effective;
  return { ok: true, mode: effective, unconfirmed: !!r.unconfirmed };
}

// (the live EFFORT switch lives next to the ultracode switch further down: the two share one control
// request, for the reason documented there)

// A control request whose ANSWER matters. Fire-and-forget was fine for the controls nobody can refuse,
// but `set_model` is validated by the CLI and it does refuse — measured live (2026-09-02):
//   set_model "claude-fable-5-1[1m]" → error "…is restricted by your organization's settings.
//                                              Using claude-opus-5[1m] instead."
//   set_model "quatsch-modell"       → error "…is not a recognized model id."
//   set_model "fable[1m]"            → success (and the next turn really was served by claude-fable-5)
// Writing to stdin and returning `true` therefore reported a switch that never happened. A timeout is
// deliberately NOT a failure: should a future CLI stop answering, the old optimistic behaviour returns
// instead of a wall of false errors.
// `opts.noBroadcast` keeps the ANSWER off the SSE stream (see quietControls) — for a read whose payload
// is nobody's business but the one caller's.
const CONTROL_TIMEOUT_MS = 5000;
// Mark a request id as "never broadcast its answer". Deliberately NOT retired when the request itself is
// over (see finish): the marker's whole job is to survive the timeout, because an answer slower than the
// ceiling is exactly the one that would otherwise be broadcast ownerless. What keeps the set from growing
// without end: a marker is only orphaned by an answer that NEVER arrives at all — a refusal („Unsupported
// control request subtype") is an answer and retires it — and the only producer, getChatContext, keeps at
// most ONE read in flight per chat, so a chat collects at most one orphan per timed-out read. The set is
// per chat and dies with it: removeChat drops the chat object, the reaper does that CHAT_DEAD_GRACE_MS
// after the process exits, and while the process is dead the route answers 409 and issues no further read.
// The one case that argument does not bound is a chat whose process stays ALIVE but has stopped answering
// controls for good — hence the cap. It evicts in insertion order, i.e. always the oldest = a stale marker,
// never the single in-flight one.
const QUIET_CONTROL_CAP = 64;
function markQuiet(chat, rid) {
  if (!chat.quietControls) return;
  while (chat.quietControls.size >= QUIET_CONTROL_CAP) chat.quietControls.delete(chat.quietControls.values().next().value);
  chat.quietControls.add(rid);
}
function controlRequest(chat, request, timeoutMs = CONTROL_TIMEOUT_MS, opts) {
  return new Promise((resolve) => {
    if (!chat.proc || !chat.proc.stdin || !chat.proc.stdin.writable) return resolve({ ok: false, error: 'process not running' });
    const rid = crypto.randomUUID();
    let done = false;
    // Retires the WAITER only. The quiet marker stays — deleting it here used to mean that an answer which
    // arrived after the ceiling found neither waiter nor marker and was broadcast to every SSE client and
    // appended to the replay buffer, untrimmed (38 KB for get_context_usage). Only the line handler retires
    // the marker, on arrival; markQuiet above says what bounds the ones whose answer never comes.
    const finish = (r) => { if (done) return; done = true; clearTimeout(to); chat.pendingControls.delete(rid); resolve(r); };
    const to = setTimeout(() => finish({ ok: true, unconfirmed: true }), timeoutMs);
    if (to.unref) to.unref();
    if (opts && opts.noBroadcast) markQuiet(chat, rid);
    chat.pendingControls.set(rid, (resp) => {
      const err = resp && (resp.error || (resp.subtype === 'error' && 'rejected'));
      // The answer's PAYLOAD is passed through as `data` (it lives at control_response.response.response).
      // Callers that only care whether it worked keep reading `.ok` — but get_settings is a control
      // request whose whole point IS its answer, and dropping it here would make the panel guess at
      // exactly the state the CLI just told it.
      finish(err ? { ok: false, error: String(resp.error || 'rejected') }
        : { ok: true, data: (resp && typeof resp.response === 'object') ? resp.response : null });
    });
    try { chat.proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: rid, request }) + '\n'); }
    catch (e) { finish({ ok: false, error: errorText(e) }); }
  });
}
// switch the MODEL of a RUNNING session live (the stream-json equivalent of the console's /model), via the
// `set_model` control. `null`/'' = back to the session default. Returns the CLI's verdict, so the route can
// pass a refusal (and its wording) on to the user instead of claiming success.
async function setChatModel(chat, model) {
  const r = await controlRequest(chat, { subtype: 'set_model', model: model || null });
  if (r.ok) {
    chat.meta.model = model || null;
    // A model change invalidates a get_context_usage read in BOTH its halves — the window (1M → 200K) and
    // the base context (34021 → 18529 tokens in the same empty session, because system prompt and tool
    // definitions are per model). So the shared in-flight read has to go: it was issued BEFORE the switch,
    // and the client asks for the context exactly HERE, on a model change. Joining it to the old request
    // would answer that ask with the previous model's numbers — the „250 % · 500,8K / 200,0K" this is
    // meant to kill. Dropping the slot does not cancel the running read; its own caller still gets its
    // answer (getChatContext only clears the slot if it is still its own promise).
    // Tied to the same `r.ok` that updates meta.model, `unconfirmed` included: wherever the panel BELIEVES
    // the model changed, a stale shared read is the worse of the two errors — the cost is one extra control
    // request.
    chat._ctxPending = null;
  }
  return r;
}

// What the running session says about itself: `get_settings` → { effective, sources, applied }, where
// `applied` = { model, effort, advisor, ultracode, ultracodeRequested, ultracodeAvailable } are the
// RUNTIME-resolved values after env overrides and model defaults, i.e. what actually goes to the API.
// MEASURED over this exact stdio connection (2.1.285): answered, no „not available on this connection".
// Only `applied` is returned — `effective`/`sources` are the merged settings files including env blocks
// with credentials, and the browser has no business seeing those.
async function getChatSettings(chat) {
  const r = await controlRequest(chat, { subtype: 'get_settings' });
  if (!r.ok) return r;
  const applied = (r.data && typeof r.data.applied === 'object') ? r.data.applied : null;
  return { ok: true, applied };
}
// How full the context of a RUNNING session is — asked of the CLI (`get_context_usage`) instead of added
// up from the stream frames. The frame arithmetic in public/js/ctx.js is only ever as fresh as the last
// `result`, so a turn that runs for an hour paints a number from before it started, and a `set_model`
// in between invalidates BOTH halves of it: the window changes (1M → 200K) and so does the base context,
// because system prompt and tool definitions differ per model (MEASURED 2026-10-02: totalTokens 34021 on
// sonnet-5 vs 18529 on opus-5 in the same empty session). That is the „250 % · 500,8K / 200,0K" the user
// saw. This control answers the truth at the moment it is asked.
//
// MEASURED over this exact stdio connection (2026-10-02), and the measurements are why the code looks
// like this:
//  · It answers while the session is IDLE and before any turn — in `-p --input-format stream-json` the
//    CLI emits nothing at all at spawn (even `init` only arrives with the first message), yet this
//    request is served. So the panel can ask straight after the start.
//  · It can be SLOW on the first call: 1.5 s warm, but 12.2 s in one cold run while the MCP servers were
//    still coming up. CONTROL_TIMEOUT_MS (5 s) would report `unconfirmed` for every first query, hence
//    the own, much longer ceiling below.
//  · `detail: 'summary'` is ignored — there is no narrow variant to ask for, so the answer has to be
//    trimmed here. RE-MEASURED 2026-10-03 with a sharper proof than „identical payload": the key set is
//    identical AND `totalTokens` is identical (21 667), and the one difference (mcpTools 119 → 138 entries,
//    +1 829 B) belongs to an MCP server that connected in between, not to the flag.
//
// CORRECTED 2026-10-03 — the size and TWO of the field claims above were wrong, and the corrections are
// what PR-11 is built on (free, CLI 2.1.288, C:/Users/you/ccui-ctxprobe/ctx-probe.js, raw answer
// ctx-probe-result.json; three reads of one session):
//  · the payload is NOT ~8 KB but 38 353 bytes cold and 40 479 at the third read — it GROWS during the
//    session, because MCP servers start up late. It carries 17 fields, not 7: beside the ones below also
//    `model`, `memoryFiles`, `mcpTools`, `agents`, `slashCommands`, `skills`, `autoCompactThreshold`,
//    `isAutoCompactEnabled`, `messageBreakdown`, `apiUsage`.
//  · the cold call took 2,4 s here, not the 12,2 s recorded above; the 25 s ceiling stays right anyway,
//    because the answer only comes once the MCP servers are up, and that is a property of the machine.
//  · `gridRows` is dropped, and that stays right — but the REASON stated here („the console's display grid
//    plus a per-MCP-tool breakdown") was wrong, and a wrong reason is what the next decision leans on.
//    Measured, it is a 10 × 20 = 200-cell SQUARE GRID — the coloured blocks /context paints in the
//    terminal. Each cell is { color, isFilled, categoryName, tokens, percentage, squareFullness }, and
//    `tokens`/`percentage` REPEAT the category aggregate: 187 of the 200 cells carry the same 945 333 (Free
//    space 187 · Autocompact buffer 7 · System tools 3 · System prompt 1 · Memory files 1 · Skills 1), and
//    across all 200 cells there are six distinct value pairs — exactly the non-deferred rows of `categories`.
//    So it holds nothing `categories` does not carry exactly and 37× more compactly (643 B against
//    24 051 B), and it is useless for the breakdown. (This said „190" until it was counted: the one number
//    in the CORRECTED reason for dropping gridRows was itself unchecked.)
//  · the per-MCP-TOOL breakdown is not in `gridRows` at all. It is `mcpTools` — a flat array, one entry per
//    tool, { name, serverName, tokens, isLoaded } — which is where the per-SERVER share comes from (below).
const CONTEXT_TIMEOUT_MS = 25000;
async function getChatContext(chat) {
  // At most ONE of these in flight per chat (the shape lib/cli's cliVersion uses). NOT because anything
  // polls it — the client asks only at the turn boundaries (start · result · model change · /clear ·
  // /compact), precisely because the answer is 38 KB — but because those triggers COINCIDE: a start and a
  // model switch within the same second, or a `result` while a second tab on the same chat asks for its own
  // line. A 12 s cold call must not turn three askers into three control requests down one stdin.
  // The deliberate exception is a model switch, which DROPS this slot (setChatModel): sharing is only
  // honest while the thing being measured has not changed underneath.
  if (chat._ctxPending) return chat._ctxPending;
  const p = (async () => {
    // A machine with more MCP servers than the one this was measured on may need longer than 25 s; the
    // env override is that knob (and the seam the route's timeout test uses).
    const ms = Number(process.env.CLAUDE_UI_CONTEXT_TIMEOUT_MS) || CONTEXT_TIMEOUT_MS;
    // Two things wrap the control request:
    //  · `noBroadcast` — the answer is for the asking HTTP caller alone. Every other control answer is part
    //    of the transcript; this one is a GAUGE's read, so broadcasting it would ship those 38 KB to every
    //    open tab (and into the replay buffer) on every turn boundary of every tab.
    //  · the race against the process ending, which the long ceiling makes worth doing: a Stop or a crash
    //    during a 12 s cold call would otherwise keep the caller waiting out all 25 s for an answer that
    //    can no longer come. The exit listener is removed as soon as the control answers, so repeated reads
    //    cannot pile them up on a long-lived process.
    //    What that race LEAVES BEHIND when exit wins: the controlRequest underneath is still open, so its
    //    pendingControls waiter and its quiet marker live on until its own ceiling expires (an unref'd
    //    timer — it holds nothing up). Verified harmless instead of papered over with a cancel path: the
    //    process is gone, so nothing can match that rid any more EXCEPT a line stdout had already buffered
    //    before 'exit' (node emits 'exit' before stdio is drained) — and that one is precisely what the
    //    surviving marker must still catch, or it would be broadcast. chat.alive is false by then, so the
    //    route answers 409 and no further read is issued, and the reaper removes the whole chat
    //    CHAT_DEAD_GRACE_MS after the exit, taking map entry, waiter and marker with it.
    const r = await new Promise((resolve) => {
      const onExit = () => resolve({ ok: false, error: 'process not running' });
      chat.proc.once('exit', onExit);
      controlRequest(chat, { subtype: 'get_context_usage' }, ms, { noBroadcast: true })
        .then((v) => { chat.proc.off('exit', onExit); resolve(v); });
    });
    // No answer, or a refusal (an older CLI: „Unsupported control request subtype") → say so instead of
    // inventing numbers. `unconfirmed` is not an error: the caller falls back to the frame arithmetic,
    // which is what the panel did before this route existed.
    if (r.unconfirmed) return { ok: true, unconfirmed: true };
    if (!r.ok) return { ok: true, unconfirmed: true, reason: r.error || 'no answer' };
    const d = (r.data && typeof r.data === 'object') ? r.data : {};
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const cats = Array.isArray(d.categories) ? d.categories.filter((c) => c && typeof c === 'object').map((c) => ({
      name: String(c.name == null ? '' : c.name),
      tokens: num(c.tokens) || 0,
      kind: typeof c.kind === 'string' ? c.kind : '',
    })) : [];
    return {
      ok: true,
      totalTokens: num(d.totalTokens),
      // Both halves of the window are passed on although every measurement had them equal (1M/1M and
      // 200K/200K): `maxTokens` is what the CLI compacts against, `rawMaxTokens` the model's raw window,
      // and the panel must not be the one that decides they are the same forever. There is no
      // `contextWindow` field in this answer — that one lives in `result.modelUsage`.
      maxTokens: num(d.maxTokens),
      rawMaxTokens: num(d.rawMaxTokens),
      percentage: num(d.percentage), // the CLI's own rounding, so the label cannot disagree with the console
      autocompactSource: typeof d.autocompactSource === 'string' ? d.autocompactSource : null,
      // `color` (a console ANSI name) and `isDeferred` (already in `kind`) are dropped on purpose.
      categories: cats,
      // PR-11 — the share per MCP SERVER, aggregated HERE and not in the browser: `mcpTools` is 11 236 bytes
      // and 141 full tool names, and this route exists precisely so the 38 KB do not go into every tab. What
      // leaves is the server NAME and three counts per server — never a tool name (which is also what
      // test/integration.test.js watches for with its `mcp__` rule).
      // The aggregation refuses to answer unless its sum HITS a category value the CLI delivered in the same
      // payload (ctxMcpAggregate): measured, Σ(mcpTools.tokens) was byte-equal to „MCP tools (deferred)" in
      // all three reads (75 605 · 84 291 · 86 097). That counter-check is what makes this a reading instead
      // of a second number that could disagree with the first.
      mcp: ctxMcpAggregate(Array.isArray(d.mcpTools) ? d.mcpTools : null, cats),
    };
  })();
  chat._ctxPending = p;
  try { return await p; } finally { if (chat._ctxPending === p) chat._ctxPending = null; }
}

// PR-11 — the hook events the CLI really knows, and the hooks really in force. MEASURED 2026-10-03 (free,
// CLI 2.1.288): `get_hooks_listing` answers in 20 ms — the fastest control of the whole run — and carries
// FOUR fields, two of which this panel did not know existed: `eventCatalog` (all 33 events in lifecycle
// order, each with the /hooks summary and whether its hooks take a matcher) and `policy` (whether an
// administrator switched hooks off or restricted them). The editor offered nine hard-coded events and a
// matcher rule that was wrong for six of them — see public/js/hooks-catalog.js for the measurement and for
// why the fallback has to be LABELLED rather than silent.
// The default CONTROL_TIMEOUT_MS is kept on purpose: unlike get_context_usage this does not wait for MCP
// servers, and 20 ms against a 5 s ceiling leaves three orders of magnitude of headroom.
// `noBroadcast` for the same reason the context read uses it: this is one editor's read, not part of the
// transcript, and it carries the user's own hook command lines.
async function getChatHooks(chat) {
  const r = await controlRequest(chat, { subtype: 'get_hooks_listing' }, undefined, { noBroadcast: true });
  if (r.unconfirmed) return { ok: true, unconfirmed: true };
  if (!r.ok) return { ok: true, unconfirmed: true, reason: r.error || 'no answer' };
  return Object.assign({ ok: true }, hookListingTrim(r.data));
}

// Make a RUNNING session pick up a skill file that was just written. The skill editor saves to disk, but a
// session that is already up has its skill listing in its context — so the skill the user just changed is
// not the one the model sees until the next start.
// `reload_skills` is a real control subtype in this binary, read out of claude.exe 2.1.288 (gratis): the
// schema is `u({subtype:A("reload_skills")}).describe("Reloads skills from disk and returns the refreshed
// skill list.")`, the stdio dispatcher has its branch (`D.request.subtype==="reload_skills"` → re-reads the
// directories and answers with the refreshed commands), and the cloud-routing switch passes it through
// unchanged. It takes no arguments.
// Deliberately NOT verified by a second read: unlike apply_flag_settings (which reports success for a wish
// it did not grant) this request's own answer IS the refreshed list, so there is nothing a get_settings
// could add. A failure is passed on as-is — the save itself already happened, and a reload that did not
// work must not look like one that did.
async function reloadChatSkills(chat) {
  return controlRequest(chat, { subtype: 'reload_skills' }, undefined, { noBroadcast: true });
}

// ---- MCP on the RUNNING session (G4) ---------------------------------------------------------------
// Three control requests, read out of claude 2.1.288 (see public/js/mcp-live.js for the schemas and for
// why every verdict is built from the read-back rather than from the request's own answer).
//
// WHY these need ceilings of their own, and why 5 s would be the wrong one: `mcp_toggle {enabled:true}`
// only answers once the dial has RUN. The CLI dials under MCP_CONNECT_TIMEOUT_MS
// (`function rPe(){let _=a.MCP_CONNECT_TIMEOUT_MS; return _&&_>0?Math.min(_,2147483647):5000}`) and then
// runs tools/list under MCP_TIMEOUT (`function vl(){… :30000}`). CONTROL_TIMEOUT_MS (5 s) would therefore
// report `unconfirmed` for a toggle that is simply doing its job — and this repo's own npx/uvx probes
// already take ~9 s. A reconnect can take even longer: it does the same tools/list and, on 'needs-auth',
// dials a SECOND time after clearing its cache („Reconnect returned 'needs-auth'; retrying once after
// cache clear"). Both are env-overridable, which is also the seam the tests use.
const MCP_CONTROL_TIMEOUT_MS = 40000;
const MCP_RECONNECT_TIMEOUT_MS = 75000;
const mcpTimeout = () => Number(process.env.CLAUDE_UI_MCP_TIMEOUT_MS) || MCP_CONTROL_TIMEOUT_MS;
const mcpReconnectTimeout = () => Number(process.env.CLAUDE_UI_MCP_TIMEOUT_MS) || MCP_RECONNECT_TIMEOUT_MS;

// What the session says about its own MCP connections, right now. The handler is SYNCHRONOUS
// (`var qe=(e,o)=>({mcpServers:At(o)})` — it reads o.mcpConnections() and returns, no await, no model
// turn), so this costs nothing but a round trip and is the read-back every verdict below leans on.
// `noBroadcast`, for the reason getChatContext gives: this is a GAUGE's read, and a server list with its
// tool arrays would otherwise be pushed into every open SSE stream and into the replay buffer each time a
// tab menu is opened. The toggle/reconnect answers are NOT quiet — those are actions and belong in the
// transcript.
// → { ok:true, servers:[…] } · { ok:true, unconfirmed:true } · { ok:false, error }
async function getMcpStatus(chat) {
  const r = await controlRequest(chat, { subtype: 'mcp_status' }, CONTROL_TIMEOUT_MS, { noBroadcast: true });
  if (r.unconfirmed) return { ok: true, unconfirmed: true };
  if (!r.ok) return { ok: false, error: r.error || 'no answer' };
  const list = (r.data && Array.isArray(r.data.mcpServers)) ? r.data.mcpServers : null;
  // An answer without the one field the schema promises is not a status: say „nobody told us" instead of
  // handing the browser an empty list, which it would render as „this session has no MCP servers".
  if (!list) return { ok: true, unconfirmed: true, reason: 'no mcpServers in the answer' };
  return { ok: true, servers: list.map(mcpStatusRowSafe) };
}
// `config` is REBUILT from an allow-list before it leaves this process, and that is a secret fix, not tidying.
// MEASURED against a real 2.1.288 with control requests only: every `mcp_status` row of an http/sse server
// carries `config.headers` IN THE CLEAR — a probe token came back as
// `"Authorization":"Bearer PROBE-SECRET-AAA111"`, at scope `dynamic`, and it still did after the server had
// been switched to `disabled`. The routes hand these rows straight to the browser, so the token would have
// travelled into a page, into the SSE replay buffer and into any inventory export. This machine is concretely
// affected: its `jira` server is `type: http` with a PAT in a header.
// lib/mcp.js already states the rule for the sibling path — „Never returns env/headers — callers hand this to
// the browser" — and test/mcp.test.js pins it (F1). Same rule, one path later.
// An ALLOW-list, not maskSecrets(): masking decides per key NAME, so a header called `X-Internal-Token`, or a
// stdio `env` entry whose name says nothing, would walk straight through. The UI reads exactly two fields out
// of `config` (public/js/mcp-live.js: `cfg.url`, plus the transport), so everything else is dropped rather
// than judged. `withheld` counts what was removed, so the panel can SAY that something was held back instead
// of implying the server has no configuration — not hiding what exists is the other half of the same rule.
function mcpStatusRowSafe(s) {
  if (!s || typeof s !== 'object') return s;
  const row = { ...s };
  const cfg = (s.config && typeof s.config === 'object') ? s.config : null;
  if (!cfg) return row;
  const safe = {};
  if (cfg.type != null) safe.type = cfg.type;
  // SEC-3: the allow-list keeps `url` BECAUSE the panel renders it — and a URL is the one allowed field
  // that can carry a credential in its own value (userinfo `https://u:pw@host/`, a `?token=…` query).
  // An allow-list cannot judge that; lib/core.js maskUrl can, and says there what it covers and what not.
  if (cfg.url != null) safe.url = maskUrl(String(cfg.url));
  const withheld = Object.keys(cfg).filter((k) => k !== 'type' && k !== 'url').length;
  if (withheld) safe.withheld = withheld;
  row.config = safe;
  return row;
}
// Switch one server on/off in the RUNNING session, then READ BACK. The read-back is the verdict, exactly as
// get_settings is the verdict for the ultracode switch: `mcp_toggle` answers `success` with an EMPTY `{}`,
// there is no push for MCP (`mcp_servers_changed` does not exist in this binary), and a timeout resolves
// „ok" as well. So the only way to know is to ask — which is free.
// The read-back runs even when the toggle itself was refused: the refusal names a reason, and the status
// beside it is what tells the user whether anything moved at all.
// → { ok, unconfirmed, error, servers } — `error` is the CLI's own wording („Server not found: …",
//   „… blocked by enterprise managed policy", „Connection failed", „Server status: <type>").
async function setMcpEnabled(chat, name, enabled) {
  const r = await controlRequest(chat, { subtype: 'mcp_toggle', serverName: String(name), enabled: !!enabled }, mcpTimeout());
  const after = await getMcpStatus(chat);
  return {
    ok: !r.error, unconfirmed: !!r.unconfirmed, error: r.ok ? '' : String(r.error || 'rejected'),
    servers: after.ok && after.servers ? after.servers : null,
    statusUnconfirmed: !(after.ok && after.servers),
  };
}
// Reconnect a disconnected/failed server — the 401 case: a server whose login expired reports
// `needs-auth`, usually with error_code CLAUDEAI_BEARER_REJECTED. Same read-back rule as above, and the
// same shape of answer, so the route and the browser have one pattern to handle.
async function reconnectMcp(chat, name) {
  const r = await controlRequest(chat, { subtype: 'mcp_reconnect', serverName: String(name) }, mcpReconnectTimeout());
  const after = await getMcpStatus(chat);
  return {
    ok: !r.error, unconfirmed: !!r.unconfirmed, error: r.ok ? '' : String(r.error || 'rejected'),
    servers: after.ok && after.servers ? after.servers : null,
    statusUnconfirmed: !(after.ok && after.servers),
  };
}

// ---- stopping ONE task (G6) -------------------------------------------------------------------------
// `stop_task {task_id}` — deliberately NOT routed through interruptChat(): that sends `{subtype:'interrupt'}`
// for the whole turn, and the browser half around it empties the queue and marks every lane aborted. One
// shared path for „stop everything" and „stop this one" is how CHAT-FLOW-9 happened.
//
// The answer is `success` with an empty payload, and it arrives only after the kill really ran (`rhe` awaits
// `K.kill(…)`). It is still NOT a receipt for „I stopped it": the CLI smooths `not_found` and a terminal
// `not_running` into success on purpose, so a task that had just finished by itself answers the same way.
// Hence this function reports what HAPPENED to the request and nothing about the task — the lane is only
// allowed to say „gestoppt" once a `task_updated {status:'killed'}` / `task_notification {status:'stopped'}`
// frame lands on it (public/js/task-stop.js stopView).
// Left at CONTROL_TIMEOUT_MS: the kill is local (no network, no model), so 5 s is the right ceiling here —
// and an `unconfirmed` is passed through rather than hidden, because the frames are the real confirmation
// either way.
async function stopTask(chat, taskId) {
  const r = await controlRequest(chat, { subtype: 'stop_task', task_id: String(taskId) });
  if (!r.ok) return { ok: false, error: String(r.error || 'rejected') };
  return { ok: true, unconfirmed: !!r.unconfirmed };
}

// Turn ultracode on/off on a RUNNING session (no restart — unlike the subagent policy, this is a live
// lever). `apply_flag_settings` is the same control the effort switch below uses. It is NOT a two-key
// request: the stdio dispatcher validates the payload with `Zk`, which only checks that `settings` is an
// object and does not nest too deep, and the handler branches on `fastMode`, `model`, `agent` and
// `viewMode` as well. Which matters here, because the effort switch relies on sending TWO of those keys.
//
// The verdict is NOT the control response. MEASURED with --model haiku (which cannot do ultracode):
// the request answers `success` anyway, and only a following get_settings reveals
// `ultracodeRequested: true, ultracode: false`. So this re-reads the state and returns what is REALLY
// in effect — a switch that reports its own wish back as fact is the bug PR #44 fixed for set_model.
//
// That „it never refuses" is connection-specific, not a property of the CLI: claude.exe 2.1.286 has TWO
// apply_flag_settings handlers. The Remote-Control/bridge one (`JYt`) DOES refuse `ultracode:true` on an
// incapable model and names the reason; the stdio one the panel talks to (`tv`) has no availability check
// at all. So the panel may never wait for a refusal that will not come — only get_settings can tell it.
async function setChatUltracode(chat, on) {
  // the WISH is recorded before the request and survives whatever the session answers: it is what a
  // later effort change has to re-assert, and what the chip shows as „requested but not in effect".
  // „Survives the ANSWER" is not „survives a FAILURE", though: a request that never reached the process
  // (stdin gone) or came back refused changed nothing, so the wish is rolled back. Otherwise a failed
  // switch left the session carrying a wish the user never got — and the next live effort change would
  // have asserted it, turning a visible error into a silent later effect.
  const wishBefore = chat.meta.ultracodeWish;
  chat.meta.ultracodeWish = !!on;
  const r = await controlRequest(chat, { subtype: 'apply_flag_settings', settings: { ultracode: !!on } });
  if (!r.ok) { chat.meta.ultracodeWish = wishBefore; return r; }
  const s = await getChatSettings(chat);
  if (s.ok && s.applied) chat.meta.ultracode = s.applied.ultracode === true;
  else chat.meta.ultracode = !!on; // no answer to read → keep the optimistic value, like the effort switch
  return { ok: true, applied: (s.ok && s.applied) ? s.applied : null, unconfirmed: !!r.unconfirmed };
}

// switch the reasoning EFFORT of a RUNNING session live (the stream-json equivalent of the console's
// /effort command), through the same `apply_flag_settings` control, with the SDK-documented `effortLevel`
// key — so effort is applied as a behavioural signal through the flag-settings layer (the org effort cap
// still applies at the API layer; this is NOT a raw thinking-token bypass). Confirmed against the live
// control protocol: apply_flag_settings{effortLevel} → control_response success; a made-up `set_effort`
// subtype → "Unsupported control request subtype".
//
// WHY the ultracode wish rides along in the SAME request, always. Read out of claude.exe 2.1.286
// (chunk-1w8x69eb, the stdio handler `tv`):
//     let S = "ultracode" in e ? void 0 : g || (Efn(r.model, v, n) ? !1 : void 0);
// — an effort request that carries NO `ultracode` key switches ultracode OFF. CONDITIONALLY: `Efn` means
// „the requested level actually differs from the one the session runs at", so re-sending the current
// level leaves ultracode alone. The panel only fires on a real change, so it always tripped the coupling:
// every live effort change silently turned Ultracode off, and „max + Ultracode" could not be held at all.
// Sending both keys fixes it and is order-independent — `"ultracode" in e` makes the effort branch skip
// the coupling (S stays undefined) and the handler's own `if ("ultracode" in e)` sets the flag.
// (Since CLI 2.1.284 the two are separate switches by design: ultracode „no longer forces xhigh effort
// and stays on at any effort level". Only the legacy terminal shortcut `/effort ultracode` still couples
// them, by mapping to level xhigh — which is exactly why the key-based switch must not.)
//
// `level`: a name from EFFORT_LEVELS, or ''/null/undefined for „auto". Auto is sent as `effortLevel: null`
// and NEVER as '': `fH('')` returns undefined, so the whole state update is skipped while the control
// response still reports success. An unrecognised level string behaves identically. That is why the
// verdict here is a following get_settings and not the request's own answer — the response cannot fail.
// `wish`: the ultracode wish to re-assert. Absent → chat.meta.ultracodeWish, so a stale browser tab that
// sends no wish cannot reintroduce the bug.
// → { ok, applied, unconfirmed }. `unconfirmed` means nobody answered (controlRequest resolves
// `{ok:true,unconfirmed:true}` on its 5 s timeout, so `.ok` alone proves nothing) — the caller must then
// present the optimistic value as unconfirmed rather than as fact.
async function setChatEffort(chat, level, wish) {
  const lv = (level === undefined || level === null || level === '') ? null : String(level);
  const uc = (wish === true || wish === false) ? wish : (chat.meta.ultracodeWish === true);
  const wishBefore = chat.meta.ultracodeWish;
  chat.meta.ultracodeWish = uc;
  const r = await controlRequest(chat, { subtype: 'apply_flag_settings', settings: { effortLevel: lv, ultracode: uc } });
  if (!r.ok) { chat.meta.ultracodeWish = wishBefore; return r; }   // nothing was applied → nothing is remembered
  const s = await getChatSettings(chat);
  if (s.ok && s.applied) {
    // `applied.effort` is null when no explicit level is set — the CLI's own encoding of what it displays
    // as „auto", and the same shape `--effort <level>` at spawn reports once it is back to the default.
    chat.meta.effort = (typeof s.applied.effort === 'string') ? s.applied.effort : null;
    chat.meta.ultracode = s.applied.ultracode === true;
    return { ok: true, applied: s.applied, unconfirmed: !!r.unconfirmed };
  }
  chat.meta.effort = lv;                      // no answer to read → keep the optimistic value…
  chat.meta.ultracode = uc;
  return { ok: true, applied: null, unconfirmed: true };  // …and say that it is exactly that
}

module.exports = {
  chats, broadcast, startChat, sendToChat, respondPermission, interruptChat,
  setChatMode, setChatEffort, setChatModel, setChatUltracode, getChatSettings, getChatContext, getChatHooks, reloadChatSkills, controlRequest, killChat, PERM_MODES,
  getMcpStatus, setMcpEnabled, reconnectMcp, stopTask,
  mcpStatusRowSafe, // exported for the test only: a pure allow-list is worth asserting directly
  EFFORT_LEVELS, effortLevelsUpTo, terminateChat, removeChat, TERMINATE_GRACE_MS, endResumeCollisions,
  sessionHold, refuseIfHeld, refuseIfOpenElsewhere, ATTACH_SETTLE_MS, CLAIM_MS, // CHAT-FLOW-4
};
