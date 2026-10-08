// Part of the Claude Code Control Panel front-end (split from app.js).
// Classic scripts share one global scope; load order in index.html is authoritative: render → chat → sessions → views → commands → boot.
// This file: chat-events.js

// tab-aware: `chat` is swapped to the event's tab so background tabs render
// into their own container; UI-only lines are gated on `chat === ACTIVE`.
function handleEvent(tab, ev) {
  trackTurnFrames(tab, ev); withTab(tab, () => handleEventBody(ev));
  // ⏹ also stands for frame-only work now (tabCanStop) — the first such frame is what has to show it
  if (tab === ACTIVE && !tab.streaming && typeof refreshInterruptBtn === 'function') refreshInterruptBtn();
}
// What a deferred restart must not cut off (tabHasLiveWork): after a background agent reports back the CLI
// may run a follow-up turn by itself. handleEventBody adopts one that streams (CHAT-FLOW-3, turnOpenedByCli),
// but main-thread work with no stream/assistant frame stays `streaming=false`, so its frames are what show it.
// A main-thread frame opens the turn, a result/exit closes it; _lastFrameAt feeds the quiet window.
// `_superseded` closes it too (CHAT-FLOW-4): the process is ended right after it, and no `result` follows — a tab
// taken over mid-turn would otherwise stand in the plan rail as „busy" without a process (planTabRests).
function trackTurnFrames(tab, ev) {
  if (!tab || !ev) return;
  tab._lastFrameAt = Date.now();
  // …and the same moment as „the process WORKS" — except for a control_response: that only acknowledges a request
  // of the panel. Measured with the fake CLI: after ⏹ the one frame that came was the interrupt's own
  // `control_response/success`, and as a sign of life it kept a hung turn from ever escalating (chat.js stopTab).
  if (ev.type !== 'control_response') tab._lastWorkAt = tab._lastFrameAt;
  if (ev.type === 'result' || ev.type === '_exit' || ev.type === '_error' || ev.type === '_superseded') tab._turnOpen = false;
  else if ((ev.type === 'stream_event' || ev.type === 'assistant' || ev.type === 'user') && !ev.parent_tool_use_id) tab._turnOpen = true;
}
// The tool list is the same on every session start, but it was JSON.stringify'd and written to localStorage on
// EVERY system/init (a few hundred names, synchronously, per tab start/restart). Only write on a real change;
// the first call seeds the comparison from what is already stored. (P6)
let _mcpToolsKey = null;
function cacheMcpTools(tools) {
  const key = tools.join('|');
  if (_mcpToolsKey === null) { try { const p = JSON.parse(localStorage.getItem('cc_mcp_tools') || 'null'); _mcpToolsKey = (p && Array.isArray(p.tools)) ? p.tools.join('|') : ''; } catch { _mcpToolsKey = ''; } }
  if (key === _mcpToolsKey) return;
  _mcpToolsKey = key;
  try { localStorage.setItem('cc_mcp_tools', JSON.stringify({ tools, ts: Date.now() })); } catch {}
}
// A `system` frame this build has no renderer for. The CLI keeps adding subtypes (2.1.273 added a
// mid-session MCP-disconnect notice, 2.1.274 the task_* family this panel now depends on) and every
// one of them used to be dropped here without a trace — so "the CLI told us and the panel stayed
// silent" was indistinguishable from "nothing happened". Recorded in the 🔔 log, not toasted: it is
// evidence, not an interruption. Once per subtype per tab, because some of them repeat per turn.
// Hook lifecycle (--include-hook-events). Measured shape on 2.1.278:
//   {type:'system', subtype:'hook_started', hook_id, hook_name, hook_event, uuid, session_id}
// The panel lets hooks be configured but could never show that one FIRED — a hook that changes a
// turn was invisible. Kept per tab (capped) and surfaced as a rail group, not as transcript lines:
// a PreToolUse hook on a busy turn would otherwise scroll the answer away.
const HOOK_MAX = 20;
function trackHookEvent(tab, ev) {
  const name = String(ev.hook_name || ev.hook_event || '').trim();
  if (!name) return;
  tab.hooks = tab.hooks || [];
  const id = ev.hook_id || '';
  // `hook_started` and its later completion share the hook_id — update the row instead of adding one
  const prev = id ? tab.hooks.find((h) => h.id === id) : null;
  const done = /completed|finished|stopped|failed/i.test(String(ev.subtype || ''));
  if (prev) { prev.done = prev.done || done; prev.at = Date.now(); }
  else {
    tab.hooks.push({ id, name, event: String(ev.hook_event || name), at: Date.now(), done });
    while (tab.hooks.length > HOOK_MAX) tab.hooks.shift();
  }
  if (tab === ACTIVE && typeof chatSideRefresh === 'function') chatSideRefresh(true);
}
function noteUnknownSystemFrame(tab, ev) {
  const KNOWN = ['task_started', 'task_progress', 'task_updated', 'task_notification', 'background_tasks_changed',
    // handled elsewhere, so never logged as "unknown": the live thinking-token estimate (A2, its own
    // branch in handleEventBody — dozens of frames per turn) and the hook lifecycle right above.
    'thinking_tokens'];
  const sub = String((ev && ev.subtype) || '').trim();
  if (!sub || KNOWN.includes(sub) || /^hook_/.test(sub) || typeof logEvent !== 'function') return;
  tab._seenSysSubtypes = tab._seenSysSubtypes || new Set();
  if (tab._seenSysSubtypes.has(sub)) return;
  tab._seenSysSubtypes.add(sub);
  logEvent(tt('chat-events.systemFrame') + sub, 'warn');
}
// An agentic turn is MANY assistant frames, and each one gets its own message row (message_start
// clears `chat.current`). A frame that carried only thinking, or only tool calls, produces a row whose
// content both display toggles can hide — and `addMsg` always paints the „Claude" head row. The result
// was a transcript full of labelled rows with nothing under them: the old code hid the BUBBLE
// (`display:none`) but never the row around it.
//
// Marked, not hidden here on purpose: the same CSS switch that hides the content hides the row, so
// turning „Nachdenken" back on brings both back. Hiding it in JS at render time would make those rows
// disappear for good. A row that ALSO carries a question or a plan card is never marked — that content
// has no toggle and must stay visible.
function markHideableRow(bubbleEl, has) {
  const row = bubbleEl && bubbleEl.parentElement;
  if (!row || (has.text && has.text.trim()) || has.other) return;
  if (has.thinking) row.classList.add('only-thinking');
  if (has.tools) row.classList.add('only-tools');
  // PF-1 — a message that was NOTHING but a ```plan-status block: its content moved into the rail, and no
  // display switch could ever bring anything back into this row — an empty „Claude" head is all it would show.
  // So this one is hidden outright (CSS .only-status), not marked for a toggle like the two above.
  if (has.status && !has.thinking && !has.tools) row.classList.add('only-status');
}
// …and a row that later receives an open-points card must not stay hidden: that card is a question to
// the reader, and it is appended to the LAST bubble of the turn — which can be one of these rows.
function unmarkHideableRow(bubbleEl) {
  const row = bubbleEl && bubbleEl.parentElement;
  if (row) row.classList.remove('only-thinking', 'only-tools', 'only-status');
}
// A system/task_* frame whose task id belongs to a Monitor card (its receipt registered it), not to a
// subagent lane. Deliberately narrow: only a task id the panel has SEEN as a watch receipt is accepted,
// so this can never swallow a subagent's frame — the lane machinery has already had its turn above.
function routeWatchFrame(tab, ev) {
  const id = ev && (ev.task_id || ev.taskId);
  const card = (id && tab.watchCards) ? tab.watchCards[String(id)] : null;
  if (!card || !card.isConnected) return;
  if (typeof monitorEvent === 'function') monitorEvent(card, ev);
}
// One forwarded subagent frame → its lane. `user` frames of this kind are the prompt the parent gave
// it (already on the lane as `prompt`), so only the agent's OWN output is kept: text and thinking.
function routeSubagentFrame(tab, ev) {
  const id = ev.parent_tool_use_id || ev.parentToolUseId;
  const content = (ev.message && ev.message.content) || [];
  if (typeof laneAppendText !== 'function' || !Array.isArray(content)) return;
  let added = false;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && String(b.text || '').trim()) added = laneAppendText(tab.agents || [], id, b.text, 'text') || added;
    else if (b.type === 'thinking' && String(b.thinking || '').trim()) added = laneAppendText(tab.agents || [], id, b.thinking, 'thinking') || added;
  }
  // No rail repaint: the row shows counters, not this text, and a repaint per forwarded block would
  // rebuild the rail several times a second. The open detail panel refreshes on its own poll.
  if (added && typeof agentDetailNoteText === 'function') agentDetailNoteText(id);
}
// G2 — one place turns a turn-end payload (turn-end.js) into a footer string. `key` is translated;
// `num`, `raw` and `text` are NOT. `raw` is the CLI's own value for something we did not recognise (an
// unknown subtype, an unknown stop_reason) and must stay exactly as it arrived — it is the only thing a
// reader can search for. `text` is `errors[0]`, the sentence the CLI wrote itself; a German paraphrase of
// it would be unfindable in the CLI's logs, its issue tracker or a web search.
function turnEndPartText(p) {
  let s = tt(p.key);
  if (p.num != null) s += ' ' + p.num;
  if (p.raw) s += ' (' + p.raw + ')';
  if (p.text) s += ' — ' + p.text;
  return s;
}
function turnEndGlyph(sev) { return sev === 'error' ? '⚠ ' : sev === 'info' ? 'ℹ ' : ''; }
// A turn ended: what its `result.modelUsage` means for this tab's window and for the shared learned store —
// decided in ONE place (ctx.js ctxDecide) and applied in ONE place (commands.js ctxRemember), so the rule
// cannot differ between this caller and the probe's. `prev` is passed in because the entry counters are
// CUMULATIVE: „who served THIS turn" is the delta to the previous result, not the running total.
// Lifted out of the switch so a test can run it: what a refutation does — raise that variant's FLOOR so even
// the name constant and the CLI's next report are refused, and clean the stores that still hold the disproved
// number — has to be observable in both callers, and a `case` block inside a 500-line switch is reachable only
// through the DOM.
// Guarded on ctxEnv, not on ctxDecide: ctx.js is loaded long before this file, commands.js (which owns the
// store and the DOM selector) only after it — so ctxEnv is the one that says „everything is here".
function ctxNoteResult(tab, now, prev) {
  if (!tab || typeof ctxEnv !== 'function') return null;
  const rec = ctxDecide(tab, ctxEnv(tab, { usage: { now, prev } }));
  ctxRemember(tab, rec);
  return rec;
}
// A typed „/model <arg>" (chat-composer.js markTypedModel) is CONFIRMED by the first frame that names a model
// which is the argument's (ctx.js ctxTypedModelVerdict) — the CLI's word, not the wish, the rule applyLiveModel
// follows for its own set_model. Then the tab takes it over exactly as a dropdown switch would: the selection
// (the menu value that stands for it, else the raw argument as a visible temporary option — chat.js
// modelSelForTyped / ensureModelOption), persisted, and the context of the previous model forgotten and asked
// anew. `via` is 'frame' (an `assistant` frame — its own context is the new model's, so its token count stays)
// or 'init'. WHEN a verdict counts is ctx.js ctxTypedModelSettle: only a frame after the command's own turn end
// (`sawResult`) can REJECT; an `init` confirms only in the argument's variant; and a switch of the variant alone
// (same model, „[1m]" on or off) is confirmed by a frame of the NEXT turn only, because every frame of the old
// session names the same model. A rejection changes nothing and says so in the 🔔 log. Lifted out of the switch
// so a test can run it, like ctxNoteResult.
function settleTypedModel(tab, served, via) {
  const p = tab && tab._modelPending;
  if (!p || typeof ctxTypedModelSettle !== 'function') return '';
  const argEntry = (typeof MODELS_CACHE !== 'undefined' && MODELS_CACHE && MODELS_CACHE.models || [])
    .find((m) => m.value === (/^default$/i.test(p.arg) ? '' : p.arg));
  const verdict = ctxTypedModelSettle(p, served, via, argEntry ? argEntry.resolves || '' : '');
  if (!verdict) return '';
  tab._modelPending = null;
  if (verdict === 'reject') {
    logEvent(tt('chat.modellPerTippenAbgelehnt').replace('{a}', p.arg).replace('{m}', shortModel(served) || served), 'warn');
    if (tab === ACTIVE && typeof updateCtxGauge === 'function') updateCtxGauge(tab);  // the variant is known again
    return verdict;
  }
  const v = modelSelForTyped(p.arg, served);
  tab.modelSel = v;
  tab.model = served;
  persistTabs();
  // the window belongs to the model, and the CLI just switched it (CTX-1) — the same three steps as applyLiveModel
  if (typeof ctxForgetModel === 'function') ctxForgetModel(tab, via === 'frame');
  if (typeof ctxProbe === 'function') ctxProbe(tab, 'model');
  if (typeof refreshUltracodeState === 'function') refreshUltracodeState(tab);
  // …and the per-model FORECAST (can it do Ultracode, which effort levels) — the step a dropdown switch does in
  // its change handler (chat.js) and this path had left out: `_ucSupport` kept the previous model, and the effort
  // menu went on filtering and warning by that model's levels after the CLI had switched.
  tab._ucSupport = null;
  if (typeof fetchUltracodeSupport === 'function') {
    fetchUltracodeSupport(tab, v, () => {
      if (tab !== ACTIVE) return;
      if (typeof applyEffortLevelsForModel === 'function') applyEffortLevelsForModel();
      renderStatusBar();
    });
  }
  if (tab === ACTIVE) {
    ensureModelOption(v, true);   // `true`: this value really came from a typed /model — the option says so
    const sel = $('#modelSel'); if (sel) sel.value = v;
    if (typeof refreshDefaultsPin === 'function') refreshDefaultsPin();
    if (typeof applyEffortLevelsForModel === 'function') applyEffortLevelsForModel(); // drop the old verdict at once
  }
  renderTabs();
  if (tab === ACTIVE) { renderStatusBar(); if (typeof updateCtxGauge === 'function') updateCtxGauge(tab); }
  logEvent(tt('chat.modellPerTippenUebernommen').replace('{v}', v || tt('html.standardmodell')).replace('{m}', shortModel(served) || served), 'info');
  return verdict;
}
// A typed /model still waiting for its confirmation, at a `result`: the first one after it is the command's own
// turn end. An ERROR there is the CLI refusing it — nothing is taken over, and the 🔔 log says what the CLI said.
// Otherwise it is only noted: from here on a frame that names another model is a rejection (settleTypedModel),
// while the frames before it may belong to a turn the CLI began before it read the /model. Lifted out of the
// `result` case (it was inline there) so a test can run it instead of matching its source text.
// Returns 'rejected' · 'noted' · '' (nothing pending).
function noteTypedModelResult(tab, ev) {
  const pm = tab && tab._modelPending;
  if (!pm) return '';
  if (ev && ev.is_error && !pm.sawResult) {
    tab._modelPending = null;
    const why = (Array.isArray(ev.errors) && ev.errors[0]) || (typeof ev.result === 'string' ? ev.result : '');
    logEvent(tt('chat.modellPerTippenAbgelehnt').replace('{a}', pm.arg).replace('{m}', shortModel(tab.model) || tab.model || '?')
      + (why ? ' — ' + String(why).slice(0, 200) : ''), 'warn');
    return 'rejected';
  }
  pm.sawResult = true;
  return 'noted';
}
// A (re)start replaces the process a typed /model was sent to, and the new one starts on the TAB's selection — so
// a switch that is still pending is gone. That is right when the /model never reached the CLI (the dead-chat
// recovery re-marks it before it re-sends, chat-composer.js deliverText). It is a LOSS when the CLI had already
// processed it (`sawResult`, its own turn end without an error) and only the confirming frame was missing: the
// old session ran the new model, the new session runs the old one, and nothing said so. Now the 🔔 log does.
function retireTypedModel(tab) {
  const pm = tab && tab._modelPending;
  if (!tab) return;
  tab._modelPending = null;
  if (pm && pm.sawResult && typeof logEvent === 'function') logEvent(tt('chat.modellPerTippenVerworfen').replace('{a}', pm.arg), 'warn');
}
function handleEventBody(ev) {
  // CHAT-FLOW-3 — a turn the CLI starts by itself (after an agent reports back) is adopted as a running turn,
  // so Stop, the queue and the status strip work in it like in any other; its `result` below ends it. Before
  // the switch so the cases go on setting the concrete phase. `_cliTurn` marks it for interruptTab: its end is
  // not guaranteed the way the end of a turn WE started is (chat.js armCliTurnStop). The strip is repainted
  // because a [Jetzt senden] standing there changes meaning (it stops this turn now).
  if (typeof turnOpenedByCli === 'function' && turnOpenedByCli(ev, {
    streaming: chat.streaming, exited: chat._exited,
    synthetic: ev.type === 'assistant' && ctxSyntheticModel((ev.message && ev.message.model) || ''),
  })) {
    chat._cliTurn = true;
    setComposerBusy(true);
    if (chat === ACTIVE && typeof renderQueueStrip === 'function') renderQueueStrip();
  }
  switch (ev.type) {
    // synthetic frame the server emits the moment it captures the CLI's session id (covers --resume and
    // --fork-session, where the `init` event doesn't reliably carry session_id to the browser) → claim it +
    // persist so a reload can restore this tab.
    // PR-13 — the server's cost brake (lib/budget.js): spend since this launch, subagent and workflow-agent
    // transcripts included, against the tab's budget. Kept on the tab for the status strip (budgetChip); a
    // trip is said ONCE in the transcript — every later frame only repeats the state.
    case '_budget': {
      const was = chat.budgetLive;
      chat.budgetLive = {
        limitUsd: Number(ev.limitUsd) || 0, spentUsd: Number(ev.spentUsd) || 0, parts: ev.parts || {},
        unpricedTokens: Number(ev.unpricedTokens) || 0, tripped: !!ev.tripped,
        trippedAtUsd: ev.trippedAtUsd == null ? null : Number(ev.trippedAtUsd),
        stopped: Array.isArray(ev.stopped) ? ev.stopped : [], running: Number(ev.running) || 0,
      };
      const b = chat.budgetLive;
      if (b.tripped && !(was && was.tripped)) {
        const money = (v) => (typeof fmtUSD === 'function' ? fmtUSD(v) : '$' + Number(v || 0).toFixed(2));
        const stopped = b.stopped.filter((s) => s && s.ok).length, failed = b.stopped.length - stopped;
        addMsg('system', '⛔ ' + tt('chat-events.budgetErreicht').replace('{spent}', money(b.trippedAtUsd == null ? b.spentUsd : b.trippedAtUsd)).replace('{limit}', money(b.limitUsd))
          + (stopped ? ' ' + tt('chat-events.budgetGestoppt').replace('{n}', String(stopped)) : '')
          + (failed ? ' ' + tt('chat-events.budgetNichtGestoppt').replace('{n}', String(failed)) : ''), { error: true });
      }
      if (chat === ACTIVE && typeof renderStatusBar === 'function') renderStatusBar();
      break;
    }
    case '_session':
      clearStartSafety(chat); // the session identified itself → the start watchdog has nothing left to guard
      if (ev.session_id && chat.sessionId !== ev.session_id) { chat.sessionId = ev.session_id; if (typeof saveLastSession === 'function') saveLastSession(ev.session_id, chat.cwd); refreshSessionChip(chat); persistTabs(); }
      break;
    case 'system':
      if (ev.subtype === 'init') {
        clearStartSafety(chat);                       // the launch resolved — see START_SAFETY_MS
        chat._starting = false; chat._exited = false; // launch resolved → chip leaves "◌ startet…"
        chat.model = ev.model || chat.model;
        // a typed /model the CLI now starts its turn with → taken over (an `init` can only confirm, never reject)
        if (chat._modelPending && ev.model) settleTypedModel(chat, ev.model, 'init');
        if (ev.permissionMode) chat.permissionMode = ev.permissionMode;
        renderTabs(); // reflect the model glyph on the tab
        if (chat === ACTIVE) renderStatusBar(); // model/mode may have arrived — refresh the strip
        // C3 — with `--worktree` the CLI works in a NEW directory, not the one the tab asked for. The
        // `init` frame reports the cwd the session actually uses, so that is what the tab shows from
        // here on: a status line still naming the main tree would have you edit in the belief you are
        // somewhere you are not. Narrow on purpose (only when a worktree was requested): otherwise a
        // path the CLI merely normalised would silently rewrite the tab's cwd.
        if (chat.worktree && ev.cwd && ev.cwd !== chat.cwd) {
          chat.cwd = ev.cwd;
          if (chat === ACTIVE && typeof renderStatusBar === 'function') renderStatusBar();
          logEvent(tt('chat-events.worktreeCwd') + ev.cwd, 'info');
        }
        if (ev.session_id) { chat.sessionId = ev.session_id; saveLastSession(ev.session_id, ev.cwd); persistTabs(); }
        refreshSessionChip(chat); // now that sessionId is known → "● live · <id>"
        if (Array.isArray(ev.tools) && ev.tools.length) cacheMcpTools(ev.tools);
        // Ultracode: ask the session what it ACTUALLY applied. This is the first moment that answer
        // exists — and it has to be asked, because the CLI accepts `ultracode:true` on a model that
        // cannot do it and says nothing (measured on Haiku 4.5). Fire-and-forget: the chip fills in when
        // the answer lands, and an older server without the route leaves it silent.
        if (typeof refreshUltracodeState === 'function') refreshUltracodeState(chat);
        // …but NOT over a list `commands_changed` already delivered for this process. Measured: that frame
        // arrives BEFORE `init` and carries 71 typeable names (60 commands + 11 aliases), while
        // `init.slash_commands` has the 60 names without aliases — so an unconditional assignment here threw
        // eleven names away that the CLI accepts (/frontend-design /review /checkup /proactive /reset /new
        // /settings /name /cost /stats /peers), 6,2 s after they had arrived. The richer list wins; the
        // marker is per process, so a restart starts over from `init`.
        if (Array.isArray(ev.slash_commands) && !chat._cmdsFromFrame) CHAT_COMMANDS = ev.slash_commands.map((c) => '/' + c); // LOCAL_COMMANDS are added on read (C6)
      } else if (ev.subtype === 'status' && ev.status === 'compacting' && chat === ACTIVE && !chat._ctxOp) {
        // the CLI is compacting (manual /compact confirmation OR auto-compaction when the window fills) →
        // show the forward progress bar even when the user didn't type the command (ToDo 02)
        chat._ctxOp = 'compact'; if (typeof startCtxDrain === 'function') startCtxDrain('compact');
      } else if (ev.subtype === 'session_state_changed') {
        // G5 — the CLI's own report on this SESSION (running | requires_action | idle). It only arrives
        // because lib/chat.js sets CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS; without it this branch never
        // runs and nothing in the panel changes (additive, see session-state.js).
        // Stored on the tab, never painted from here: both consumers in chat-status.js DERIVE what they
        // show from the record plus the panel's own belief about the same tab, and they re-derive it
        // constantly (the 200 ms ticker / every strip repaint). That matters for one measured detail —
        // `requires_action` arrives ONE FRAME BEFORE the `can_use_tool` request it belongs to (_seq 37 vs
        // 38 in run 1, 36 vs 37 in run 2), so for an instant the panel has the state but not yet the gate.
        // A message painted at arrival would state a hole that closes a frame later; a derived read heals
        // itself at the next tick, when the richer gate is there.
        const st = (typeof sessionStateNote === 'function') ? sessionStateNote(chat.sessionState, ev) : null;
        if (st) {
          chat.sessionState = st;
          // Only an UNKNOWN state reaches the 🔔 log, and only once per value per tab. The log holds 30
          // entries (logEvent) while the measured runs produced four and six state changes in ONE turn —
          // a line per transition would evict every real signal within a handful of turns. A fourth state
          // is different: that is evidence the CLI's vocabulary grew, which is exactly what this log is for.
          if (!st.known && st.changed && typeof logEvent === 'function') {
            chat._seenStates = chat._seenStates || new Set();
            if (!chat._seenStates.has(st.state)) {
              chat._seenStates.add(st.state);
              logEvent(tt('session-state.logUnbekannt') + st.state, 'warn');
            }
          }
          // A changed state can flip what the strip says — but only the ACTIVE tab has a strip, and only
          // a repaint reads the record. While streaming the 200 ms ticker (renderStatus) already does;
          // at rest nothing ticks, so the chip needs this one repaint.
          if (st.changed && chat === ACTIVE && typeof renderStatusBar === 'function') renderStatusBar();
        }
      } else if (ev.subtype === 'commands_changed') {
        // G5 — the slash catalogue, live. Measured: the frame carries the FULL list (60 entries, the same
        // set as `init.slash_commands`), and it arrives BEFORE `init` (_seq 4 vs 8), so it is also the
        // earliest moment the real catalogue exists. Until now the menu was frozen at whatever `init`
        // reported at launch: a `/reload-skills`, an installed plugin or a newly written skill stayed
        // untypeable for the rest of the session even though the CLI had already announced it.
        // No route and no server work: the frame already rides the SSE stream this handler reads.
        // `/api/skills` stays what it is — the panel's own scan of ~/.claude/commands, which is how a UI
        // skill is FOUND and rendered as a form; this is the CLI's list of what it will ACCEPT.
        // A malformed or empty list is ignored rather than adopted (commandsFromFrame returns null), so a
        // bad frame cannot leave the composer with no slash menu at all.
        const cmds = (typeof commandsFromFrame === 'function') ? commandsFromFrame(ev) : null;
        if (cmds) { CHAT_COMMANDS = cmds; chat._cmdsFromFrame = true; } // LOCAL_COMMANDS are added on read (C6), exactly as on `init`
        // …and the marker keeps the `init` branch from replacing this richer list with the alias-free one
        // (it arrives second — measured 6,2 s later; see there).
      } else if (ev.subtype === 'compact_boundary') {
        // CTX-6 — the end of a compaction. An AUTO-compaction happens mid-turn, so without this the op
        // stayed open until the turn's `result` and the gauge was then zeroed and hidden in the middle of a
        // running turn — the line vanished at the one moment it was being watched. The boundary closes the
        // op right here; the SIZE afterwards has to come from somewhere else.
        // What this frame carries is `{trigger, pre_tokens}` — the DOCUMENTED metadata, i.e. the size
        // BEFORE the compaction, which is the size of what was just thrown away. There is no
        // post-compaction count anywhere: not in the documented shape, not in any 2026-10-02 measurement.
        // So the operation ends here without a token value and the probe below fills it in. Two fields this
        // used to read — `post_tokens`/`postTokens` and the `compactMetadata` spelling — exist nowhere
        // outside this repo's own code, and the one that „worked" wrote `Number(undefined) || 0` = 0, after
        // which the `result` handler's „no context reported yet" branch replaced that 0 with the turn's
        // SUMMED usage: roughly the size of the discarded context, published as the new one.
        chat._ctxOp = null;
        // voids the measurement (it describes the context before the compaction) and makes an in-flight
        // query stale — and deliberately passes NO number, rather than synthesising one. Passing nothing is
        // also what marks the derived count STALE (ctx.js ctxForgetContext): ending the op alone left the
        // PRE-compaction number standing, so the gauge went on painting the size of what was just discarded
        // as if it were the new context. Now the line says it is measuring until the probe below answers.
        if (typeof ctxForgetContext === 'function') ctxForgetContext(chat);
        // The drain is ONE global element and ONE global timer: the op that owns it just ended, so it must
        // be stopped even from a background tab. Gated on `chat === ACTIVE` it survived a tab switch during
        // the compaction — `_ctxOp` was nulled anyway, so the `result` handler could not clear it either and
        // the line stayed on the green bar until the 90 s safety net. Only the REPAINT is tab-scoped: the
        // element belongs to whichever tab is visible.
        if (typeof clearCtxDrainTimers === 'function') clearCtxDrainTimers();
        if (typeof updateCtxGauge === 'function') updateCtxGauge(chat === ACTIVE ? chat : null);
        if (typeof ctxProbe === 'function') ctxProbe(chat, 'compact'); // …and let the CLI say how big it is now
        // PF-1 — the compaction may have taken the approval message with it, and with it the step IDs and the
        // protocol. The rail says its state may be stale (and lights up [Stand abfragen]) until a report that
        // hits a known step clears the flag again (planApplyStatus). Only for a plan that is underway.
        if (chat.plan && chat.plan.state === 'active' && !chat.plan.stale) {
          chat.plan.stale = true;
          if (typeof planChanged === 'function') planChanged(chat, true);
        }
      } else if (ev.subtype === 'thinking_tokens') {
        // A2 — the CLI's own live estimate of the thinking spent on this turn ({estimated_tokens,
        // estimated_tokens_delta}, measured: 34 frames in ONE turn). Only stored here; renderStatus's
        // 200 ms tick draws it (chat-status.js), because a repaint per frame is exactly the churn that
        // ticker exists to avoid. Without a number, „denkt…" on xhigh/max is indistinguishable from a
        // hang for minutes at a time.
        chat.thinkTokens = Number(ev.estimated_tokens) || 0;
      } else {
        // #32 — the sub-agent lifecycle lives in these frames (task_started · task_progress · task_updated ·
        // task_notification · background_tasks_changed) and they were dropped on the floor here, which is why
        // the rail had to guess a sub-agent's state from its tool_result (a launch receipt) and from `result`
        // (which arrives while background agents keep working). agentSystemEvent ignores every other subtype.
        agentSystemEvent(chat, ev);
        // …and the task frames that belong to a WATCH rather than to a subagent. A Monitor is a
        // background task too, so it produces task_notification / task_updated with its own task id —
        // for which `agentSystemEvent` finds no lane and returns false. Before this they were dropped
        // silently: a watch whose deadline expired reported to nobody. Its card collects them.
        routeWatchFrame(chat, ev);
        if (/^hook_/.test(String(ev.subtype || ''))) trackHookEvent(chat, ev);
        noteUnknownSystemFrame(chat, ev);
      }
      break;
    // N1 — with --prompt-suggestions the CLI emits its OWN prediction of the next prompt after each
    // turn. That replaces the panel's regex guesswork (chat-render.js buildQuickReplies) for the tabs
    // that opted in: the chips only come from the model's actual reading of the conversation.
    // Stashed here and rendered by the `result` handler, so the chip row still lands under the answer.
    case 'prompt_suggestion': {
      const s = ev.prompt || ev.suggestion || ev.text || (ev.message && ev.message.prompt) || '';
      if (s && typeof s === 'string') chat._cliSuggestions = [s.trim().slice(0, 240)];
      break;
    }
    // A3 — „Rate limit event emitted when rate limit info changes" (2.1.278). The one frame that
    // explains why a turn stands still, and the panel had no case for it: it fell through the switch
    // and vanished. Two outputs, no toast (a limit is not something you dismiss): a chip in the status
    // strip while it is pending, and ONE system line in the transcript for a rejection — that is the
    // moment a turn really stops, and the moment you would otherwise be guessing.
    case 'rate_limit_event': {
      const rl = (typeof normalizeRateLimit === 'function') ? normalizeRateLimit(ev.rate_limit_info || ev.rateLimitInfo) : null;
      if (!rl) break;
      const wasRejected = !!(chat.rateLimit && chat.rateLimit.rejected);
      chat.rateLimit = rl;
      if (chat === ACTIVE) renderStatusBar();
      if (typeof logEvent === 'function') {
        logEvent(tt('chat-events.limitLog') + (rl.type || rl.status || '?')
          + (rl.resetsAtMs ? ' · ' + fmtClock(rl.resetsAtMs) : ''), rl.rejected ? 'warn' : 'info');
      }
      // Once per rejection, not once per frame: the CLI re-sends the info while the limit holds, and a
      // line per frame would push the answer off screen.
      if (rl.rejected && !wasRejected) {
        addMsg('system', tt('chat-events.limitErreicht') + (rl.type ? ' (' + rl.type + ')' : '')
          + (rl.resetsAtMs ? tt('chat-events.limitReset') + fmtClock(rl.resetsAtMs) : '')
          + (rl.fallbackAvailable ? tt('chat-events.limitFallback') : ''));
      }
      break;
    }
    case 'stream_event': {
      const e = ev.event; if (!e) break;
      if (e.type === 'message_start') {
        // note: the in-window resume loader is removed by renderResumeHistory once the transcript is painted
        // (not here) so the emptied transcript never flashes as a blank "new chat" (ToDo 01/04)
        // finalize any prior bubble; defer creating the next one until real text arrives
        if (chat.current) { chat.current.textEl.classList.remove('streaming'); chat.current.consumed = true; }
        chat.current = null;
      } else if (e.type === 'content_block_start') {
        const t = e.content_block && e.content_block.type;
        if (t === 'thinking' || t === 'redacted_thinking') setPhase(PHASE_THINKING);
        else if (t === 'text') setPhase(PHASE_WRITING);
        else if (t === 'tool_use') setPhase(tt('chat-events.bereite') + (e.content_block.name || 'tool') + '…');
      } else if (e.type === 'content_block_delta' && e.delta) {
        if (e.delta.type === 'text_delta') { setPhase(PHASE_WRITING); const b = ensureBubble().textEl; b._raw = (b._raw || '') + (e.delta.text || ''); if (chat === ACTIVE) scheduleStreamRender(b); }
        else if (e.delta.type === 'thinking_delta') setPhase(PHASE_THINKING);
      } else if (e.type === 'message_delta') {
        if (e.usage && e.usage.output_tokens != null) chat.tokenLive = e.usage.output_tokens;
      } else if (e.type === 'message_stop') {
        if (chat.current) chat.current.textEl.classList.remove('streaming');
      }
      break;
    }
    case 'assistant': {
      // A SUBAGENT's frame, not the main model's (--forward-subagent-text). Measured on 2.1.278 these
      // carry `parent_tool_use_id` plus `subagent_type`/`task_description`, so they identify themselves.
      // They must not reach the transcript: they are not this session's answer, and letting them
      // through would also make them the tab title, the source of `lastAssistantText` (→ open points
      // parsed out of a subagent's text) and a second stream of bubbles under the real answer.
      // Their place is the agent's own lane, which the detail view reads — and for a FOREGROUND agent
      // this is the only record of its work that exists anywhere (its .output file stays empty).
      if (ev.parent_tool_use_id || ev.parentToolUseId) { routeSubagentFrame(chat, ev); break; }
      // The frame names the model that actually served this turn — the only authoritative source once a
      // session runs. `init` reports the LAUNCH model only, and it can be wrong minutes later: after a
      // live /model switch, after a resume, or if the CLI fell back on its own. Correcting from here keeps
      // the status strip, the tab glyph and the per-turn price (turnCostUSD reads chat.model) honest even
      // when nobody touched the dropdown.
      // CTX-8 — „<synthetic>" is not a model. The CLI uses it for messages it composed itself (an error
      // text, a cancellation notice), and adopting it as `chat.model` made the strip, the tab glyph and the
      // per-turn price name a model that does not exist — and it would have invalidated the context window
      // of the model that really is answering.
      const served = (ev.message && ev.message.model) || '';
      const synthetic = ctxSyntheticModel(served);    // "<synthetic>" — the CLI wrote this one, no model did
      const realModel = synthetic ? '' : served;
      // 05.10. — a typed „/model X" is settled HERE, before the block below: a confirmation takes the selection
      // over and forgets the old model's context itself (settleTypedModel), and since it also records the served
      // model, the block below then sees no change and does not forget and probe a second time.
      if (chat._modelPending && realModel) settleTypedModel(chat, realModel, 'frame');
      if (realModel && chat.model !== realModel) {
        // CTX-1 — the window belongs to the MODEL, and a switch can happen without anybody touching the
        // dropdown (a resume on another model, a fallback the CLI made on its own). The old window then
        // kept being divided into, which is the reported „Kontext 250 % · 500,8K / 200,0K". This frame
        // carries the NEW model's own context, so that one number survives (keepTokens).
        // Compared NORMALIZED, because `init` and the frames can spell one model differently (a gateway id
        // against the bare name) and taking that for a switch would throw the window away on the first
        // frame of every session. The frames never carry the „[1m]" suffix, so the two context variants of
        // one model cannot be told apart here — that case belongs to applyLiveModel, which has the
        // selector value. And when the variant changes where NOBODY has the selector value either — „/model
        // opus[1m]" typed into the composer, which the CLI accepts and applyLiveModel never sees — it is
        // caught one layer down instead of here: the frames that this handler cannot read the variant from
        // are the very evidence that refutes the old window once the context outgrows it (ctx.js (8),
        // `over-window`), and that puts the probe back on the question.
        if (chat.model && ctxNormModel(chat.model) !== ctxNormModel(realModel) && typeof ctxForgetModel === 'function') {
          ctxForgetModel(chat, true);
          if (typeof ctxProbe === 'function') ctxProbe(chat, 'model');
        }
        chat.model = realModel; renderTabs(); if (chat === ACTIVE) renderStatusBar();
      }
      const content = (ev.message && ev.message.content) || [];
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const allTools = content.filter((b) => b.type === 'tool_use' && b.name);
      const askQ = allTools.filter((b) => b.name === 'AskUserQuestion');
      const planBlocks = allTools.filter((b) => b.name === 'ExitPlanMode'); // rendered inline, not as a generic tool card (ToDo 07b)
      const todoBlocks = allTools.filter((b) => b.name === 'TodoWrite'); // live → sticky checklist strip, not per-update inline cards (ToDo 05)
      const tools = allTools.filter((b) => b.name !== 'AskUserQuestion' && b.name !== 'ExitPlanMode' && b.name !== 'TodoWrite');
      const thinking = content.filter((b) => b.type === 'thinking' && b.thinking).map((b) => b.thinking).join('\n\n');
      if (!text.trim() && !allTools.length && !thinking) break; // truly empty message
      const target = (chat.current && !chat.current.consumed) ? chat.current : ensureBubble(true);
      if (thinking) addThinking(target.textEl, thinking);
      // CHAT-FLOW-8 — open points are lifted out of THIS message, before it is painted (the raw JSON never
      // reaches the bubble), not out of the turn's last text on `result`: a turn that goes on after the
      // block (a held plan/question card, more tools, more text) left it raw and out of the rail.
      const op = text.indexOf('```offene-punkte') >= 0 && typeof takeOpenPoints === 'function' ? takeOpenPoints(chat, text) : null;
      // PF-1 — the same lift for the plan's ```plan-status blocks: applied to tab.plan and cut out of what is
      // painted. Main thread only, by construction: a subagent's frame left this case at the top
      // (routeSubagentFrame), so a subagent reporting „S3 erledigt" about its own sub-task cannot move our plan.
      const ps = text.indexOf('```plan-status') >= 0 && typeof takePlanStatus === 'function' ? takePlanStatus(chat, op ? op.text : text, target.textEl) : null;
      const shown = ps ? ps.text : op ? op.text : text;
      if (shown.trim()) { setAssistantText(target.textEl, shown); chat.lastAssistantText = shown; }
      else {
        // nothing left but the block: clear what the stream painted (the „…werden gesammelt" placeholder)
        if (text.trim()) { setAssistantText(target.textEl, ''); chat.lastAssistantText = ''; }
        if (!allTools.length) target.textEl.style.display = 'none'; // thinking-/points-only: no empty bubble
      }
      target.textEl.classList.remove('streaming');
      tools.forEach((t) => {
        // toolId lets an Agent card reopen its lane's detail view later (#34) — the tool_use id IS the
        // lane id, so no extra mapping is needed.
        const card = addToolCard(target.textEl, t.name, t.input, { toolId: t.id }); // null when tool display is off (P6)
        if (card && t.id) chat.toolCards[t.id] = card;
        // A4 — display off: keep a stub plus the (capped) input, so switching „Werkzeuge" back on can
        // rebuild the card instead of leaving the turn permanently blank. tool-store.js owns the caps.
        else if (!card && t.id) stashHiddenTool(chat, target.textEl, t);
        // the whole input goes in (model override, isolation, run_in_background, prompt) — the lane is the
        // place those show up now (#33). No subagent_type gate any more: an Agent call without one is still
        // a running agent, and hiding its lane was the one case where the rail silently showed nothing.
        if (isAgentTool(t.name) && t.id) trackAgentStart(chat, t.id, t.input);
      });
      // PF-1 — the count behind 📋 Schritte anfordern (planWantsSteps): this thread's tool calls since the
      // model last reported (takePlanStatus above has already reset the count for a report in THIS message)
      if (tools.length && typeof planNoteTools === 'function') planNoteTools(chat, tools.length);
      askQ.forEach((t) => addOptionCard(target.textEl, t.id, t.input));
      planBlocks.forEach((t) => addPlanCard(target.textEl, t.id, (t.input && t.input.plan) || '', t.input && t.input.planFilePath));
      todoBlocks.forEach((t) => updateTodos(chat, t.input && t.input.todos)); // live task list → sticky strip (ToDo 05)
      // U1 — the strip's REAL feed. `TodoWrite` is called 0 times in the whole local corpus (606
      // transcripts); `TaskCreate`/`TaskUpdate` are the tools the CLI offers. Both go through
      // public/js/task-list.js, so the strip merges them instead of one replacing the other. The generic
      // tool card stays: a TaskCreate's long `description` only fits there, and the strip is one line wide.
      allTools.forEach((t) => {
        if (t.name !== 'TaskCreate' && t.name !== 'TaskUpdate') return;
        // The tool name per tool_use id, so the RESULT half can find it without a tool card (the card does
        // not exist when „Werkzeuge" is switched off). Bounded: the map is dropped with the tab/session.
        if (t.id) {
          if (!chat.taskToolIds) chat.taskToolIds = {};
          chat.taskToolIds[t.id] = t.name;
          // Bounded: a long session must not grow this map for ever. The result follows its own tool_use
          // within a frame or two, so the oldest entries are long spent — 400 is far past any real gap
          // (the whole local corpus holds 30 Task* calls).
          const ids = Object.keys(chat.taskToolIds);
          if (ids.length > 400) for (const k of ids.slice(0, ids.length - 400)) delete chat.taskToolIds[k];
        }
        // TaskUpdate: only the WISH is noted here — the row moves when the answer says so (result half below)
        if (t.name === 'TaskCreate') trackTaskCreate(chat, t.id, t.input);
        else trackTaskUpdate(chat, t.id, t.input);
      });
      // the points card goes last in the row, after this message's own question/plan cards
      if (op && op.found) showOpenPoints(chat, target.textEl, op);
      markHideableRow(target.textEl, { text: shown, thinking, tools: tools.length, status: !!ps, other: askQ.length + planBlocks.length + (op ? op.cards.length : 0) });
      target.consumed = true;
      const u = ev.message && ev.message.usage;
      if (u && u.output_tokens != null) { chat.tokenBase = (chat.tokenBase || 0) + u.output_tokens; chat.tokenLive = 0; }
      // How full the context is — from THIS frame, i.e. from one API call, because that is what a context
      // is (ctx.js: the result event's usage is the sum over the turn and grew with every tool call).
      // A subagent's frames are skipped: they run in their own, much smaller context, and letting them
      // through would make the gauge jump down and back up for the length of a Task.
      // A „<synthetic>" frame is skipped for the same reason: the CLI wrote it, so its usage is not a
      // measurement of this conversation's context (CTX-8).
      // ctxNoteFrame also moves the tab's STAMP, which is what tells ctxDecide that the CLI's last
      // measurement is no longer the younger of the two numbers (it is deliberately not polled during a
      // turn). Done in ctx.js, not here: a counter bumped by hand at the call site is a counter a call site
      // can forget.
      if (!(ev.parent_tool_use_id || ev.parentToolUseId) && !synthetic) ctxNoteFrame(chat, ctxTokensOfFrame(u));
      if (tools.length) setPhase(tt('chat-events.laeuft') + tools[0].name + (tools.length > 1 ? ' +' + (tools.length - 1) : '') + '…');
      break;
    }
    case 'user': {
      setPhase(PHASE_TOOLWORK);
      // attach live tool outputs to their tool cards (parity with resumed history)
      const content = (ev.message && ev.message.content) || [];
      if (Array.isArray(content)) {
        const results = content.filter((b) => b && b.type === 'tool_result');
        // The tool's full Output object sits NEXT to the message, not inside the block. For the Agent tool it
        // is the only place the per-agent totals live (resolvedModel · totalTokens · toolStats → #33) and the
        // only place a backgrounded agent admits that this frame is a LAUNCH RECEIPT, not a result (#32).
        // There is exactly one such object per frame, so mapping it onto a lane is only safe when the frame
        // carries a single tool_result — with two, nothing says which one it describes.
        const soleOut = (results.length === 1) ? (ev.tool_use_result || ev.toolUseResult || null) : null;
        results.forEach((b) => {
          let txt = liveToolResultText(b);
          agentToolResult(chat, b.tool_use_id, !!b.is_error, soleOut); // finishes the lane ONLY if this really was the end
          // U1 — the task strip's half of the result, and it sits ABOVE the `if (!card)` return on purpose.
          // `TaskCreate` answers `{task:{id, subject}}`, and that id exists NOWHERE else (the input carries
          // subject/description/activeForm and no id), so without it a row could never be updated.
          // `TaskUpdate` answers `{success, statusChange:{from,to}}`, and THIS is where the row moves — the
          // tool_use half above only noted the wish. A refusal must not move it, and both kinds are handed on
          // rather than filtered out here: `is_error` (the measured form of a refused Task* call) and an
          // Output whose `success` is not true. Gating this call on `!b.is_error`, as it used to be, is what
          // made „a refused update does not move the row" untrue: the wish had already been applied at the
          // tool_use, and the refusal never reached anything that could keep it from standing.
          // `soleOut` may be null (several tool_results in one frame) — the BLOCK is still attributed by its
          // tool_use_id, so it is passed on anyway and public/js/task-list.js decides what null means.
          // Deliberately NOT keyed off `card.dataset.toolName` the way the Monitor receipt below is: with
          // „Werkzeuge" switched off there IS no card, and a strip that silently stops filling because a
          // DISPLAY setting is off is the exact failure class this change is about. The tool name is taken
          // from the tab's own note, written when the tool_use was seen.
          const taskTool = (chat.taskToolIds && chat.taskToolIds[b.tool_use_id]) || '';
          if (taskTool === 'TaskCreate' && typeof trackTaskCreateResult === 'function') {
            trackTaskCreateResult(chat, b.tool_use_id, soleOut, !!b.is_error);
          } else if (taskTool === 'TaskUpdate' && typeof trackTaskUpdateResult === 'function') {
            trackTaskUpdateResult(chat, b.tool_use_id, !!b.is_error, soleOut);
          }
          // The CLI denies non-allow-listed tools (esp. MCP) in plan/default/acceptEdits without
          // ever emitting a can_use_tool request — surface that instead of a buried error.
          if (b.is_error && /requested permissions to use|haven'?t granted it yet/i.test(txt || '')) {
            const m = (txt || '').match(/use (mcp__[\w.-]+|[A-Za-z][\w.-]*)/); chatPermDenied(m ? m[1] : null);
          }
          // PF-1b — an ExitPlanMode no gate will ever decide: the CLI refused it outside plan mode („You are not in plan
          // mode" — the 05.10. session ran in „Auto", and no can_use_tool came at all), or it aborted the permission
          // request. The card's approval buttons answered nobody and the rail said „wartet auf Freigabe" for good; now
          // the card offers ▶ Plan starten and the rail „Plan liegt vor". Only for a plan card or candidate of THIS tab
          // (a tool_result of anything else that happens to say it is no plan's business), and the subagent branch
          // never gets here: their frames left at the top of the `assistant` case, their results carry no plan card.
          if (b.is_error && typeof planGateLost === 'function' && planGateLost(txt) && typeof planCardOrphan === 'function'
            && ((ASK_GATES.get(b.tool_use_id) || {}).isPlan || (typeof planCandidateOf === 'function' && planCandidateOf(chat, b.tool_use_id)))) {
            planCardOrphan(chat, b.tool_use_id, planIsNoPlanModeError(txt) ? 'noplanmode' : 'turnend');
          }
          const card = chat.toolCards[b.tool_use_id];
          // No card, but the call was stashed while the display was off (A4) → the OUTPUT has to be
          // stashed too. This early return was the second half of the loss: even after rebuilding the
          // cards, every tool result would have been missing.
          if (!card) {
            if (typeof toolStoreOut === 'function') toolStoreOut(chat.hiddenTools, b.tool_use_id, txt, !!b.is_error);
            return;
          }
          // A Monitor's „result" is a launch receipt (taskId · timeoutMs): the watch starts working
          // afterwards. Register the card under that id so the task frames it produces have somewhere
          // to land — see the system branch above.
          if (card.dataset.toolName === 'Monitor' && soleOut && typeof monitorReceipt === 'function') {
            monitorReceipt(card, soleOut, chat);
          }
          if (!txt || !txt.trim()) return;
          if (txt.length > 200000) txt = txt.slice(0, 200000) + tt('chat-events.gekuerzt');
          addToolOutput(card, txt, !!b.is_error);
        });
      }
      break;
    }
    case 'control_request':
      if (ev.request && (ev.request.subtype === 'can_use_tool')) {
        const tool = ev.request.tool_name || ev.request.toolName || '';
        if (tool === 'AskUserQuestion') {
          // HOLD this permission instead of allowing (allowing runs the tool → headless has no picker →
          // instant "did not answer" → the model self-defaults). Holding blocks the turn at the tool call;
          // the inline card is the answer UI, and submitGroup/answerAsk resolves this gate with the answer.
          const rid = ev.request_id || ev.requestId;
          const toolId = ev.request.tool_use_id || ev.request.toolUseId || 'ask';
          const prev = ASK_GATES.get(toolId);
          if (prev && prev.answeredFallback) {
            // rare race: the user already answered before this gate arrived (sent as a normal message) → allow
            ASK_GATES.delete(toolId);
            api('/api/chat/' + chat.id + '/permission', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: rid, behavior: 'allow' }) }).catch(() => {});
          } else {
            ASK_GATES.set(toolId, Object.assign(prev || {}, { requestId: rid, tab: chat }));
            chat.phase = ASK_WAIT_PHASE; if (chat === ACTIVE && typeof renderStatus === 'function') renderStatus();
            // the card takes answers only from now on — [Mit Antwort senden] and the „beantwortet" chip wait for this
            if (chat === ACTIVE && typeof renderQueueStrip === 'function') renderQueueStrip();
          }
        } else if (tool === 'ExitPlanMode') {
          // HOLD the plan gate like AskUserQuestion → the inline plan card (from the assistant msg) is the
          // approve UI; no blocking modal by default (ToDo 07b). Approve = allow (+ leave plan mode); keep = deny.
          const rid = ev.request_id || ev.requestId;
          const toolId = ev.request.tool_use_id || ev.request.toolUseId || 'plan';
          const prev = ASK_GATES.get(toolId);
          if (prev && prev.answeredFallback) {
            // user clicked the card before this gate arrived → apply their stashed decision now (shared lever).
            // The entry STAYS (it already carries group/isPlan, now the requestId too) and `toolId` goes along:
            // postGateReply drops it on success and re-arms the card on failure, exactly like a direct click.
            // Deleting it here left a failure that was no dead chat with nothing to re-arm — the card kept its
            // done marker, [Mit Antwort senden] had already taken its queue entries out, and the CLI stayed
            // blocked in ExitPlanMode's can_use_tool with nothing left that could answer it.
            // The stash is spent, so it is cleared: otherwise clearAsksForTab would settle it a SECOND time
            // later and the entries it took would go back into the queue twice.
            const accept = (prev.pendingBehavior || 'allow') === 'allow';
            const message = prev.pendingMessage, settle = prev.pendingSettle;
            ASK_GATES.set(toolId, Object.assign(prev, { requestId: rid, tab: chat, isPlan: true, answeredFallback: false, pendingBehavior: null, pendingMessage: null, pendingSettle: null }));
            resolvePlanGate(chat, rid, accept, message, settle, toolId);
          } else {
            ASK_GATES.set(toolId, Object.assign(prev || {}, { requestId: rid, tab: chat, isPlan: true }));
            chat.phase = ASK_WAIT_PHASE; if (chat === ACTIVE && typeof renderStatus === 'function') renderStatus();
            // assistant msg may not have rendered the card yet (order race) → render it from the request input
            // (planFilePath along with it: whichever of the two paints the card is the one that registers the plan)
            if (!prev || !prev.group) { const inp = (ev.request.input || ev.request.tool_input) || {}; if (inp.plan) { const target = (chat.current && !chat.current.consumed) ? chat.current : ensureBubble(true); addPlanCard(target.textEl, toolId, inp.plan, inp.planFilePath); } }
            // the strip needs no repaint for a plan (its button works without a gate), but Stop does: from
            // here on the gate holds the turn, so ⏹ must be reachable even with nothing streaming (FLOW-3)
            if (chat === ACTIVE && typeof refreshInterruptBtn === 'function') refreshInterruptBtn();
          }
        } else { setPhase(WAIT_APPROVAL); showPermission(ev); }
      }
      break;
    case 'result': {
      const foot = el('div', 'result-foot');
      const parts = [];
      const op = chat._ctxOp; // 'clear' | 'compact' | null — a context op, not a normal model turn
      const u = ev.usage || null;
      const totTok = u ? ((u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)) : 0;
      if (ev.duration_ms != null) parts.push((ev.duration_ms / 1000).toFixed(1) + 's');
      if (op) parts.push(op === 'clear' ? '🧹 ' + tt('chat-events.kontextGeleert') : '⚙ ' + tt('chat-events.kontextKompaktiert')); // instead of the confusing 0-turn/0-tok line
      if (u && totTok > 0) {
        // THIS turn's cost, computed from this turn's usage (not the cumulative session total)
        const c = (typeof turnCostUSD === 'function') ? turnCostUSD(u, chat.model) : 0;
        if (c > 0) parts.push(typeof fmtUSD === 'function' ? fmtUSD(c) : '$' + c.toFixed(4));
        parts.push(totTok + ' tok');
        parts.push((u.output_tokens || 0) + ' out · ' + (u.input_tokens || 0) + ' in'
          + (u.cache_read_input_tokens ? ' · ' + u.cache_read_input_tokens + ' cache read' : '')
          + (u.cache_creation_input_tokens ? ' · ' + u.cache_creation_input_tokens + ' cache write' : ''));
      }
      // cumulative session spend — clearly LABELED so it is never mistaken for this turn's cost (ToDo 03)
      if (ev.total_cost_usd != null) parts.push(tt('chat-events.sitzung') + (typeof fmtUSD === 'function' ? fmtUSD(Number(ev.total_cost_usd)) : '$' + Number(ev.total_cost_usd).toFixed(4)));
      // keep the running totals on the tab so the status strip can show them after the footer scrolled away (M19)
      if (ev.total_cost_usd != null) chat.sessionCost = Number(ev.total_cost_usd);
      if (totTok > 0) chat.sessionTokens = (chat.sessionTokens || 0) + totTok;
      // G2 — the end reason in plain words. This line used to be `if (ev.is_error) parts.unshift('⚠ ' +
      // tt('chat-events.fehler'))`: four distinguishable error subtypes, the CLI's own `errors[0]`,
      // `stop_reason`, `terminal_reason`, the denied tools and the agents that were never started all
      // collapsed into one word. turn-end.js does the reading (including which of those numbers are
      // per-turn and which are the session's running totals); this only translates and paints.
      const endInfo = (typeof turnEndInfo === 'function') ? turnEndInfo(ev, chat._refusedSeen) : null;
      if (endInfo) {
        chat._refusedSeen = endInfo.refusedSeen; // cumulative counters → the next turn reports the delta
        // reverse + unshift: the end reason belongs in FRONT of the duration/cost run, in its own order
        endInfo.parts.slice().reverse().forEach((p) => parts.unshift(turnEndGlyph(p.sev) + turnEndPartText(p)));
      } else if (ev.is_error) parts.unshift('⚠ ' + tt('chat-events.fehler')); // turn-end.js not loaded — keep the old word rather than none
      // A truncated or refused answer does NOT live in the footer alone, and that is a deliberate
      // exception: the footer sits UNDER a finished-looking answer, among „12.3s · 0,04 € · 8231 tok",
      // which is precisely where nobody looks — while the failure here is that the text ABOVE it reads
      // as complete. So it also gets a red system row of its own, appended BEFORE the footer so it sits
      // directly beneath the answer it corrects. No „erneut senden" button (addTurnError): re-sending the
      // same prompt is what produced the same ceiling, so offering it would be an empty promise.
      if (endInfo && endInfo.banner) addMsg('system', '⚠ ' + tt(endInfo.banner.key) + ' (' + endInfo.banner.raw + ')', { error: true });
      parts.forEach((p) => foot.appendChild(el('span', null, p)));
      chat.msgEl.appendChild(foot);
      trimTranscript(chat);                       // bound transcript DOM at each turn end
      // A typed /model still waiting for its confirmation: this may be the command's own turn end (see there).
      if (chat._modelPending) noteTypedModelResult(chat, ev);
      // The window is what the CLI SAYS it is for the model that served this turn (result.modelUsage) —
      // never a guess from the model name; ctx.js has the measurement that killed the old guess. Both the
      // tab's own window AND what may be remembered per model come out of the ONE decision, so the variant
      // rule cannot differ between the two: the entry that may be SHOWN and the key it may be FILED under
      // are decided together (ctx.js (7)). `usage.prev` is there because the entry weights are cumulative —
      // „who served this turn" is the DELTA to the previous result, not the running total.
      ctxNoteResult(chat, ev.modelUsage, chat._ctxModelUsage);
      if (ev.modelUsage && typeof ev.modelUsage === 'object') chat._ctxModelUsage = ev.modelUsage;
      // No assistant frame carried usage in this whole session yet (a turn that only ran tools, a
      // resumed tab): then the summed result usage is all there is — an over-estimate, but better than
      // an empty gauge. Any later frame overwrites it with the real thing.
      // NOT for a context op (CTX-6): the usage of a /clear or /compact turn is the size of the context
      // that was just thrown AWAY, so publishing it as the new context is the worst number available —
      // and it is also the largest. Those two cases get their number from the probe below instead.
      // `ctxTokensStale` closes the same door for an AUTO-compaction, which ends at `compact_boundary` and
      // therefore leaves `_ctxOp` null before this line is reached: the tab is then waiting for a number,
      // and „waiting" must not be filled with the size of the context that was just discarded.
      // …and it is handed over MARKED as a sum (`summed`): it adds the input side of every call in the turn, so
      // it can be several times the real context (measured: 81 220 for a context of 42 263). Good enough to keep
      // the gauge alive, never good enough to become a durable bound — ctx.js (8) files no refutation from it.
      if (!chat.ctxTokens && !chat.ctxTokensStale && !op) ctxNoteFrame(chat, ctxTokensOfFrame(ev.usage), true);
      // a /clear or /compact just finished: stop the green drain animation FIRST (without forcing green 100%),
      // then let updateCtxGauge settle the bar to the real value — so /compact shows the true % and never
      // sticks green at 100% (ToDo 02). An AUTO-compaction normally never gets here: `compact_boundary`
      // already closed the op mid-turn (CTX-6). Not gated on `chat === ACTIVE`: the drain is one global
      // element and timer, so the tab whose op ended has to stop it even from the background.
      if (chat._ctxOp && typeof clearCtxDrainTimers === 'function') clearCtxDrainTimers();
      const endedOp = chat._ctxOp;
      if (endedOp) {
        chat._ctxOp = null;
        // CTX-6 — only an explicit /clear really leaves the context at 0. /compact replaces it with a
        // summary whose size the compaction's own usage does NOT state (that usage is the size of what was
        // thrown away), so zeroing there published a 0 that was never true — and hiding the line on top of
        // it meant the one number worth watching after a compaction was the one you could not see.
        // Either way the CLI is asked below, which is the only source that actually knows.
        // ctxForgetContext also moves the tab's generation, so a query that went out before the /clear can
        // not land afterwards and re-publish the context that was just thrown away (CTX-2).
        if (endedOp === 'clear' && typeof ctxForgetContext === 'function') ctxForgetContext(chat, 0);
      }
      if (chat === ACTIVE) updateCtxGauge(chat);
      // …and when a BACKGROUND tab's op ended, the element it was animating still belongs to the visible
      // tab: repaint that one instead of leaving a stopped green bar standing over its line (CTX-6).
      else if (endedOp && typeof updateCtxGauge === 'function') updateCtxGauge();
      // CTX-4 — the turn boundary: ask the CLI what the context really holds now. A measured value
      // replaces the frame arithmetic for the whole idle period until the next turn moves it again.
      if (typeof ctxProbe === 'function') ctxProbe(chat, endedOp || 'result');
      // D2 — lift any ```offene-punkte``` block out of the final answer into a card UNDER the answer and
      // a row in the side rail, so an uncertainty that did not justify stopping the turn is visible
      // instead of buried in prose. Since CHAT-FLOW-8 every message is lifted on its own `assistant` frame,
      // so this is the net and normally finds nothing. Two reasons it must still run HERE and not further down:
      //   · it needs `chat.current` — that is the bubble the card is appended to, and the element whose
      //     raw text still holds the JSON block. Called after `chat.current = null` it silently did
      //     neither, which is why the raw block kept showing up in the transcript.
      //   · the queue flush below `break`s out of the case, so with the call after it every turn that
      //     had a queued follow-up message dropped its open points entirely.
      // Still before buildQuickReplies, which consumes (and clears) lastAssistantText.
      if (typeof collectOpenPoints === 'function') collectOpenPoints(chat);
      chat.current = null;
      // #32 — this used to be `clearAgents(chat)` with the comment „turn ended → no agents are running
      // anymore". Both halves are wrong: the CLI writes SEVERAL result frames per run (`result_index`
      // 0,1,…) and the first one arrives WHILE the backgrounded agents work — in the capture next to
      // `subagent_stats {spawned:2, completed:0}` and the answer „Beide Explore-Agenten laufen im
      // Hintergrund". Emptying the list there killed the group and folded the whole rail. Now the frame
      // only retires the lanes that really ended; a run whose own stats say everything settled, and a turn
      // that ended in error/interrupt, still close their lanes (nothing may hang for ever).
      agentsAfterResult(chat, ev);
      setComposerBusy(false);
      // CHAT-FLOW-7 — a queued message used to go out right here and `break`, which skipped everything
      // below: the quick-reply chips, the done-notice of a background tab, the UI-skill result card (and its
      // run record) and the deferred restart. Now the turn is always finished first, and the queue decides
      // last. If Claude asked something (heuristic chips, or open points NEW in this turn — re-listed ones
      // don't count), the queue waits instead of talking over the question: chips stay, strip says
      // „angehalten", a chip/typed answer goes out first, [Jetzt senden] releases it. Strg+Enter
      // (`_flushNoPause`) sends regardless — that is what it was pressed for.
      const tab = chat;
      const qr = buildQuickReplies(); // consumes lastAssistantText + _cliSuggestions in every branch
      // points raised (takeOpenPoints) during this turn and still open — one answered in the meantime asks nothing
      const newPts = (tab._newOpenPoints || []).filter((p) => p && !p.done).length; tab._newOpenPoints = [];
      const force = !!tab._flushNoPause; tab._flushNoPause = false;
      // pause / flush / chips — the truth table lives in queue-merge.js (queueAfterTurn), under test
      const next = queueAfterTurn({ queued: (tab.queue || []).length, asked: !!(qr && qr.asked), newPoints: newPts, force });
      tab.queuePaused = next.pause;
      if (qr && next.chips) tab.msgEl.appendChild(qr.row); // a flushing queue overtakes them anyway
      // …and the tab badge follows the SAME verdict as the footer line: a turn whose answer was cut off at
      // the output limit is not „fertig" just because `is_error` was false. An 'info' severity (a denied
      // tool, a user cancel, agents that were refused) deliberately does NOT redden the tab.
      // The `|| ev.is_error` this line used to carry broke exactly that promise, and it broke it for the
      // one case the promise was written for: a user's Stop arrives WITH `is_error: true`, so the verdict
      // said „abgebrochen, kein Fehler" in the footer while the badge beside it said failure. The decision
      // now lives in turn-end.js beside the verdict it must agree with — a condition in here is the one
      // place the suite cannot reach, which is how the contradiction survived.
      markTabDone(tab, (typeof turnEndBadge === 'function') ? turnEndBadge(endInfo, ev) : (ev.is_error ? 'error' : 'done'));
      // UI-skill chat tab: append the result card + record the run (first result event only)
      if (tab.uiSkill && typeof uiSkillChatTurnResult === 'function') uiSkillChatTurnResult(tab, ev);
      scrollBottom();
      if (next.pause) { if (tab === ACTIVE) renderQueueStrip(); renderTabs(); }
      else if (next.flush) flushQueue(tab);
      // a plan running without a list whose reports name steps the panel does not know: ask for the list once
      // (chat-side.js planAutoAskSteps) — like a queued message, ahead of the deferred restart below
      else if (typeof planAutoAskSteps === 'function' && planAutoAskSteps(tab, { ok: ev.subtype === 'success' && !ev.is_error && !endedOp, asked: !!(qr && qr.asked) || newPts > 0 })) { /* sent */ }
      // an effort/model change (or a tab-menu restart) was deferred → apply it now, if nothing is live any
      // more: background agents may still run after this result, and the queue drains first
      else maybeApplyPendingRunCfg(tab);
      break;
    }
    case '_exit':
      // the cleanup of a process that is gone lives in endTabProcess — the `_superseded` frame below needs the
      // same list (minus the queue), and a second copy is how a forgotten gate survives (PERM-1, CHAT-FLOW-10)
      endTabProcess(chat);
      // A gone session is the common case after a restart or a cleared history — say that in plain
      // words with a way out, instead of dumping the CLI's English stderr on the user.
      if (/No conversation found with session ID/i.test(String(ev.stderr || ''))) chatSessionGoneCard(chat);
      else {
        // exit code 0 = the process ended cleanly (/stop, a finished headless run) → a plain note.
        // Anything else ended the turn against your will → error treatment + retry (B2).
        const msg = tt('chat-events.sitzungsprozessBeendet') + (ev.code != null ? ` (code ${ev.code})` : '') + (ev.stderr ? '\n' + ev.stderr : '');
        if (ev.code) addTurnError('⚠ ' + msg); else addMsg('system', msg);
      }
      trimTranscript(chat); // a turn that ends by EXIT grew the transcript just as much as one ending in `result` (P1)
      markTabDone(chat, ev.code ? 'error' : 'done');
      break;
    case '_superseded':
      // CHAT-FLOW-4 — the server is about to end this process because another tab or window took the session
      // over (lib/chat.js endSuperseded sends this just before the stream ends). Without it the end of the
      // stream read like a reaped chat, and onerror → reconnectIdleTabs resumed straight back — the ping-pong.
      supersedeTab(chat);
      break;
    case '_error':
      clearStartSafety(chat); // the failure is already on screen — no second card for the same event
      setComposerBusy(false);
      clearAgents(chat); // the session failed to run at all → no sub-agent of it can still be alive (#32)
      // The same three as in `_exit`, and now for a sharper reason: a HELD gate counts as live work, so one
      // that survives this keeps hasHeldGate(tab) true for good — every later message would be queued with
      // no `result` ever coming to flush it, and a deferred restart would wait forever. A spawn failure
      // (`proc.on('error')`) is the case that arrives here WITHOUT an `_exit` behind it to clean up.
      retirePlanCards(chat);
      clearAsksForTab(chat);
      if (typeof dropPermsForTab === 'function') dropPermsForTab(chat); // PERM-1 — same reason as in `_exit`
      clearAskWaitersForTab(chat);
      clearQueue(chat, tt('common.fehler'));
      addTurnError('⚠ ' + (ev.message || tt('chat-events.fehler')));
      pruneToolCards(chat);
      trimTranscript(chat);
      markTabDone(chat, 'error');
      break;
  }
}

// The cleanup for a tab whose CLI process is gone. Shared by `_exit` (the process ended) and `_superseded` (it
// is being ended because another tab or window took the session) — one list, so the two cannot drift apart.
// `opts.keepQueue`: a takeover is not the end of the conversation, only of THIS tab's hold on it — what was
// queued here stays and is held once the tab takes the session back (holdQueueAfterResume), instead of being
// thrown away by a decision another window made.
function endTabProcess(tab, opts) {
  clearStartSafety(tab); // the process reported its own end — that IS the answer the watchdog waits for
  // The CLI's last reported session state died with the process (G5), and it has to be cleared BEFORE
  // `setComposerBusy(false)` — not further down where it reads better. That call is the only repaint in
  // this branch (it sets streaming=false and runs stopTurnStatus → renderStatusBar); with the reset after
  // it, the chip „⚠ Sitzung arbeitet noch" was built from the still-present `running` record and then
  // left standing next to „◦ beendet", because nothing in the rest of the branch repaints: clearAgents
  // only does when lanes exist, markTabDone returns early for the active focused tab, and the others do
  // not touch the strip. Two contradictory verdicts about the same tab — the bug class this PR removes,
  // produced by line order alone. Keep it here.
  tab.sessionState = null;
  withTab(tab, () => setComposerBusy(false));
  // op interrupted by exit → drop the drain, keep the line (ToDo 02, CTX-3). The drain is one global
  // element+timer, so it is stopped even when this tab is in the background — otherwise a /compact in a
  // tab you switched away from left the green bar running over the visible tab's line (CTX-6).
  if (tab._ctxOp) {
    tab._ctxOp = null;
    if (typeof clearCtxDrainTimers === 'function') clearCtxDrainTimers();
    if (typeof updateCtxGauge === 'function') updateCtxGauge(tab === ACTIVE ? tab : null);
  }
  tab._exited = true; tab._starting = false; hideResumeLoading(tab); refreshSessionChip(tab); // "◦ beendet" — never stuck on "startet…" (tab-explicit: a BACKGROUND tab's exit must not unlock the active tab's composer)
  tab.current = null;
  clearAgents(tab); // the CLI process is gone → its sub-agents died with it, so here the hard clear IS correct (unlike `result`, #32)
  retirePlanCards(tab); // CHAT-FLOW-10 — before the gates go, or the open plan card stays clickable for nothing
  clearAsksForTab(tab); // process gone → drop any held AskUserQuestion permission
  // PERM-1 — and the can_use_tool gate too. It used to survive the process that asked: the modal stayed
  // up over „◦ beendet", „Erlauben" POSTed to a chat that no longer exists, and hasOutstandingPerm(tab)
  // kept the tab counting as live work for good (chat-status.js:53), so every later message was queued
  // behind a `result` that can never come. The sibling case — a CLOSED tab — has been handled since C1
  // (chat.js:1476); this is the same cleanup for the process ending underneath an open tab.
  if (typeof dropPermsForTab === 'function') dropPermsForTab(tab);
  clearAskWaitersForTab(tab); // …and ONLY this tab's pulsing "Rückfrage offen" markers (was: all of them, but only when active — C1)
  pruneToolCards(tab);        // the turn is over: drop the card refs so a closed/exited tab doesn't pin its transcript
  if (!(opts && opts.keepQueue)) clearQueue(tab, tt('chat-events.prozessBeendet'));
}
// CHAT-FLOW-4 — this tab's process is being ended because another tab or window resumed the session with
// [Hier übernehmen] (the server's `_superseded` frame). The stream is closed HERE and the chat id dropped, so
// nothing reconnects: reconnectIdleTabs skips a tab without an id, and activateTab only resumes a `pending`
// one. The tab keeps its session id — it is still that conversation, and a reload restores it (and then meets
// the owner's 409 instead of taking it back) — and its queue (endTabProcess keepQueue). What it gets instead
// of a silent resume is the card: take it back, or close the tab.
// The kept queue is PAUSED, with a reason of its own: it drains only on `result`, and no `result` comes to a tab
// without a process — unpaused, the strip showed „⏳ Warteschlange (n)" with no button and nothing ever sent it.
// Paused, [Jetzt senden] is there, and it goes through deliverText to the takeover confirm like a typed message.
function supersedeTab(tab) {
  if (tab.es) { try { tab.es.close(); } catch { /* */ } tab.es = null; }
  tab.id = null; tab._sseDead = false;
  tab._superseded = true; tab._elsewhere = null;
  endTabProcess(tab, { keepQueue: true });
  if (tab.queue && tab.queue.length) { tab.queuePaused = 'elsewhere'; if (tab === ACTIVE && typeof renderQueueStrip === 'function') renderQueueStrip(); }
  sessionElsewhereCard(tab);
  refreshSessionChip(tab);
  if (typeof renderTabs === 'function') renderTabs();
  // a background tab says it where the user is looking — the card waits in the tab for when they come back. The
  // toast writes the 🔔 log itself (render.js toast), so only the visible tab's takeover is logged here: both
  // made the same event stand in the log twice.
  const said = tt('chat-events.uebernommenToast').replace('{tab}', tab.title || '');
  if (tab !== ACTIVE) toast(said, 'warn');
  else if (typeof logEvent === 'function') logEvent(said, 'warn');
}
// CHAT-FLOW-4 — POST /api/chat/start answered 409 session-open-elsewhere: another tab or window holds this
// session and the server refused to end it. Called from startChat's catch, the ONE place every resume path
// passes (restore, reconnect, heal, restart, Sitzungsliste, „In Chat fortsetzen"), so none of them can show
// the generic error instead. startChat has already emptied the transcript by then (it does that before the
// POST); the card is what goes into it. `pending` keeps the tab persistable and is what the card resumes —
// set only where the tab knows no session yet (a fresh tab from the Sitzungsliste), a restored tab keeps its own.
function markTabElsewhere(tab, err, sid, cwd) {
  const d = (err && err.data) || {};
  tab.id = null;
  tab._superseded = false;
  // what the server said AT THIS MOMENT — the card says „beim Prüfen", and the takeover asks again
  tab._elsewhere = { busy: d.busy === true, starting: d.starting === true };
  if (!tab.sessionId && !(tab.pending && tab.pending.sessionId)) tab.pending = { sessionId: sid, cwd: cwd || null };
  sessionElsewhereCard(tab);
  if (typeof persistTabs === 'function') persistTabs();
}
// The card for both states — „übernommen" (this tab lost it, `_superseded`) and „woanders offen" (this tab
// asked and was refused, `_elsewhere`). One card per tab: a second refusal replaces the first instead of
// stacking them. Texts say „in einem anderen Tab oder Fenster": the server only knows that SOME browser stream
// is attached — another chat tab of this window, another window, another origin or browser look the same to it.
function sessionElsewhereCard(tab) {
  withTab(tab, () => {
    const old = tab.msgEl.querySelector('.sess-elsewhere'); if (old) old.remove();
    const sup = !!tab._superseded, info = tab._elsewhere || {};
    const box = el('div', 'msg system sess-elsewhere');
    const b = el('div', 'bubble chat-gone');
    b.appendChild(el('div', 'cg-title', tt(sup ? 'chat-events.uebernommenTitel' : 'chat-events.anderswoTitel')));
    b.appendChild(el('div', 'cg-body', tt(sup ? 'chat-events.uebernommenText' : info.starting ? 'chat-events.anderswoStartetText' : 'chat-events.anderswoText')));
    // only what the server reported — a missing `busy` is not „nothing runs there"
    if (!sup && info.busy) b.appendChild(el('div', 'cg-body', '⚠ ' + tt('chat-events.anderswoTurnLief')));
    const row = el('div', 'ui-perm-row');
    const take = el('button', 'primary-btn', tt(sup ? 'chat-events.zurueckholen' : 'chat-events.hierUebernehmen'));
    // a takeover sends nothing, so what the queue kept is held visibly afterwards instead of going out by itself
    take.onclick = () => takeBackTab(tab).then((ok) => { if (ok) holdQueueAfterResume(tab); }).catch((e) => toast(String((e && e.message) || e), 'err'));
    row.appendChild(take);
    if (!sup) {
      const again = el('button', 'ghost-btn', tt('chat-events.erneutPruefen'));
      again.onclick = () => takeBackTab(tab, { check: true }).then((ok) => { if (ok) holdQueueAfterResume(tab); }).catch((e) => toast(String((e && e.message) || e), 'err'));
      row.appendChild(again);
    }
    const close = el('button', 'ghost-btn', tt('chat-events.tabSchliessen'));
    close.onclick = () => { if (typeof closeTab === 'function') closeTab(tab); };
    row.appendChild(close);
    b.appendChild(row); box.appendChild(b);
    tab.msgEl.appendChild(box);
    // appended directly, not through addMsg — so the empty-state („Unterhaltung starten", ▶ Letzte Sitzung) that
    // addMsg would have hidden stood above the card in a fresh tab (Sitzungsliste, „In Chat fortsetzen")
    if (tab === ACTIVE) { const empty = $('#chatEmpty'); if (empty) empty.classList.add('hidden'); scrollBottom(); }
  });
}
// "Diese Sitzung gibt es nicht mehr" — with the two things you actually want to do next.
// Replaces the raw CLI stderr (`No conversation found with session ID: <uuid>`), which read like a
// broken app even though only the old session file was gone.
function chatSessionGoneCard(tab) {
  withTab(tab, () => {
    const box = el('div', 'msg system');
    const b = el('div', 'bubble chat-gone');
    b.appendChild(el('div', 'cg-title', tt('chat-events.sitzungWegTitel')));
    b.appendChild(el('div', 'cg-body', tt('chat-events.sitzungWegText')));
    const row = el('div', 'ui-perm-row');
    const fresh = el('button', 'primary-btn', tt('chat-events.neuStartenOhneVerlauf'));
    fresh.onclick = () => { box.remove(); tab.sessionId = null; tab.pending = null; startChat({}, tab).catch((e) => toast(e.message, 'err')); };
    const close = el('button', 'ghost-btn', tt('chat-events.tabSchliessen'));
    close.onclick = () => { box.remove(); if (typeof closeTab === 'function') closeTab(tab); };
    row.appendChild(fresh); row.appendChild(close);
    b.appendChild(row); box.appendChild(b);
    tab.msgEl.appendChild(box);
    if (tab === ACTIVE) scrollBottom();
  });
}
// „Der Start hat sich nie gemeldet" — the one state in which the panel used to stay quietly wrong.
// Every other recovery path keys on the session id: reconnectIdleTabs() returns early without one
// (chat.js), and the EventSource onerror below only flags `_sseDead` when one exists. In the window
// between POST /api/chat/start and the first `init`/`_session` frame there IS no session id yet — so if
// the server dies exactly there (a restart, a crash), nothing fires: no `_exit`, no error, no reconnect.
// The tab just sits on „◌ startet…" until the user reloads the page.
// Hence a watchdog armed at spawn time and disarmed as soon as the session identifies itself.
const START_SAFETY_MS = 20000;
function clearStartSafety(tab) { if (tab && tab._startSafety) { clearTimeout(tab._startSafety); tab._startSafety = null; } }
function armStartSafety(tab) {
  clearStartSafety(tab);
  // A plain --resume claims its session id optimistically before the stream opens, and a tab that HAS one
  // is already covered by reconnectIdleTabs + the _resumeSafety unlock. The hole is the id-less start.
  if (tab.sessionId) return;
  tab._startSafety = setTimeout(async () => {
    tab._startSafety = null;
    const gone = () => (typeof TABS !== 'undefined' && !TABS.includes(tab)) || tab.sessionId || tab._exited || !tab.id;
    if (gone()) return; // closed, identified itself, or already reported
    // Still no session id — but that on its own is NOT a verdict: a busy machine can take a while to
    // spawn, and an error card for a session that is merely slow would be worse than the silence.
    // The verdict is whether the panel SERVER is still there. Note this cannot be read off the
    // EventSource: when the server process dies, the stream does not go CLOSED (2) — the browser keeps
    // retrying, so it sits at CONNECTING (0) for ever. Measured, not assumed.
    let alive = true;
    try { await api('/api/ping'); } catch { alive = false; }
    if (gone()) return; // it arrived while we were asking
    // A permanently CLOSED stream means the (restarted) server answered and does not know this chat any
    // more — equally unrecoverable, and equally silent without this.
    const sseClosed = !tab.es || tab.es.readyState === 2;
    if (alive && !sseClosed) { armStartSafety(tab); return; } // slow but connected → look again later
    tab._starting = false;
    hideResumeLoading(tab);        // also re-enables the composer if a resume had locked it
    refreshSessionChip(tab);       // leave "◌ startet…" behind
    withTab(tab, () => setComposerBusy(false));
    chatStartStalledCard(tab);
  }, START_SAFETY_MS);
}
// Same shape as chatSessionGoneCard: say what happened in plain words and offer the two things worth
// doing, instead of a spinner that never resolves.
function chatStartStalledCard(tab) {
  withTab(tab, () => {
    const box = el('div', 'msg system');
    const b = el('div', 'bubble chat-gone');
    b.appendChild(el('div', 'cg-title', tt('chat-events.startHaengtTitel')));
    b.appendChild(el('div', 'cg-body', tt('chat-events.startHaengtText')));
    const row = el('div', 'ui-perm-row');
    const again = el('button', 'primary-btn', tt('chat-events.erneutStarten'));
    again.onclick = () => { box.remove(); tab.id = null; startChat({}, tab).catch((e) => toast(e.message, 'err')); };
    const close = el('button', 'ghost-btn', tt('chat-events.tabSchliessen'));
    close.onclick = () => { box.remove(); if (typeof closeTab === 'function') closeTab(tab); };
    row.appendChild(again); row.appendChild(close);
    b.appendChild(row); box.appendChild(b);
    tab.msgEl.appendChild(box);
    if (tab === ACTIVE) scrollBottom();
  });
}
const RECONNECT_PHASE = 'phase:reconnect'; // sentinel key (translated in phaseLabel) — shown only while genuinely disconnected mid-turn
async function startChat(extra = {}, tab = chat) {
  // `tab` is the session's owner — passed explicitly by the resume/restart family so a mid-flight tab
  // switch (or an `await` inside a caller) can't rebind the spawned session onto whatever tab is ACTIVE
  // when we resolve. Defaults to the current ambient `chat` for the plain new-chat path.
  // resuming/forking a session takes a moment (process spawn + transcript fetch) → cover the empty
  // transcript with the loading overlay from the START, on EVERY resume path (ToDo 04). New chats: no overlay.
  // a still-deferred effort/model change belongs to THIS launch — the reset below drops pendingRunCfg
  const pendingCfg = typeof takePendingRunCfg === 'function' ? takePendingRunCfg(tab) : {};
  if (tab.es) { tab.es.close(); tab.es = null; }
  if (tab.id) { try { await api('/api/chat/' + tab.id + '/stop', { method: 'POST' }); } catch {} }
  clearStartSafety(tab);                      // a fresh start supersedes the previous one's watchdog
  // CHAT-FLOW-1 — the old process's turn ends here, and with its EventSource closed its `result`/`_exit`
  // never arrives: `streaming` stayed true, the tab spun for good and every later message only queued.
  if (tab.streaming) withTab(tab, () => setComposerBusy(false));
  tab._turnOpen = false; tab._flushNoPause = false; tab._newOpenPoints = [];
  // A RESUME keeps the queue (and with it its pause): it continues the same conversation, and the commonest
  // resume of all is the dead-chat recovery INSIDE a flush (flushQueue → deliverText → restartResume), which
  // used to wipe every entry behind the one being sent — silently. The rest goes out on the next `result`
  // as usual; a paused queue keeps its [Jetzt senden]. A fresh start or a fork is a different conversation.
  if (!extra.resume) { tab.queue = []; tab.queuePaused = false; }
  // PF-1 — the plan follows the same line: it belongs to the CONVERSATION, so a resume — the reload, the
  // dead-chat heal, a restart for a new effort, a fork (which passes `resume` too) — keeps working on it, and
  // a fresh start drops it. Its candidates, jump targets and quiet count go either way: they point into the
  // transcript that is emptied below.
  if (!extra.resume) tab.plan = null;
  // …and so do the orphan under a plan underway and the newest proposal's name (PF-1b): a resume keeps them until the
  // fold says otherwise (planAdoptResumed), and a fork — which paints no transcript — keeps the copies forkTab made
  const orphan = extra.resume ? tab._planOrphan : null;
  tab.planCandidates = {}; tab._planRows = {}; tab._planTools = 0; tab._planPrev = null; tab._planOrphan = null;
  if (orphan && typeof planOrphanSet === 'function') planOrphanSet(tab, orphan);
  if (!extra.resume) tab._planLast = null; // the name a report without one would get comes from THIS conversation (PF-1b)
  tab._resumeGen = (tab._resumeGen || 0) + 1; // invalidate a still-running sliced history paint (P4)
  tab.msgEl.innerHTML = '';
  if (extra.resume || extra.fork) showResumeLoading(tab); // in-window loader into the freshly-cleared transcript (ToDo 01/04)
  tab.current = null;
  tab.toolCards = {};
  tab.hiddenTools = {}; // the stubs they belonged to died with the transcript we just emptied (A4)
  tab.watchCards = {};  // …and so did the Monitor cards those task ids pointed at (D)
  tab.agents = [];
  tab.steps = [];   // the step timeline belonged to the turn we just tore down (its cards are gone too)
  tab.lastSeq = 0;
  // fresh (re)start → drop the stale context numbers. Through ctxForgetContext, so a `get_context_usage`
  // still in flight for the session we are tearing down can not land in the new one (CTX-2), and so both
  // counters MOVE instead of restarting: ctx.js compares them with `===`, so a moved counter discards the
  // old capture while a restarted one could make it look younger than the new session's own frames.
  if (typeof ctxForgetContext === 'function') ctxForgetContext(tab, 0);
  tab._ctxModelUsage = null;
  retireTypedModel(tab); // a typed /model belonged to the process being replaced; the new one starts on tab.modelSel
  // …the pending run-cfg (taken above) + the task list. U1: `taskList` is the live one, `todos` is kept
  // reset too so a tab that was restarted by an older build of the panel cannot keep a stale half-list.
  tab.pendingRunCfg = null; tab.todos = null; tab.taskList = []; tab.taskToolIds = null;
  // …and the baseline for the CUMULATIVE refused-agent counters (G2): „a resumed session starts fresh",
  // so the new process counts from zero. Keeping the old baseline would swallow the new session's first
  // refusals until they passed the previous session's total.
  tab._refusedSeen = null;
  // …and the CLI's last reported SESSION state (G5), for a harder reason than staleness: the one thing it
  // is used for is the contradiction „the CLI says this session is still running while the panel shows it
  // at rest". A `running` left over from the process we just replaced would make the new, silent tab claim
  // exactly that about a session that has not said a word yet. The `_seenStates` set goes with it so a new
  // process's unknown state is reported again instead of being swallowed as „already seen".
  tab.sessionState = null; tab._seenStates = null;
  // …and the marker that a `commands_changed` already delivered the richer list for THIS process. Without
  // the reset a restarted tab would keep refusing the new `init`'s list for ever, i.e. keep the slash menu
  // of a process that is gone.
  tab._cmdsFromFrame = false;
  if (tab === ACTIVE && typeof renderQueueStrip === 'function') renderQueueStrip(); // the queue may just have emptied
  if (typeof renderTabs === 'function') renderTabs();
  // ctxReported (this session's window, with the variant it was measured for) survives the reset as long as
  // the MODEL does — dropping it would put the line back on the name table for no reason. When this restart
  // changes the model it is dropped below, once the launch config is known (CTX-1): it used to survive that
  // too, and the first turn of the new session was then measured against the window of the model that had
  // just been left.
  clearAsksForTab(tab); // fresh (re)start → drop any stale held AskUserQuestion permission for this tab
  clearAskWaitersForTab(tab); // …and its waiters — the transcript we just emptied no longer holds those cards
  // …but an open POINT is not stale: it is held on the tab, not in the DOM, and it is still waiting on the
  // reader. The reset above took its card with it — which is most visible when answering a point in a
  // tab without a live session, because that answer STARTS the session and so wipes the very card that
  // was just used. The rail kept the question, the transcript lost it. Only for a fresh start: a
  // resume/fork repaints its own history (including the historical open-point cards) a moment later.
  if (!extra.resume && !extra.fork && typeof restoreOpenPointCards === 'function') restoreOpenPointCards(tab);
  if (tab === ACTIVE) renderAgentStrip();
  // …and the gauge must stop showing the PREVIOUS session's number — but not stop showing (CTX-3): it
  // repaints into „wird gemessen…", naming the window the new session will be measured against, and the
  // probe below fills the number in. Hiding it here meant a restarted tab had no context read-out at all
  // until its first turn ended, which on a long first turn is an hour of nothing.
  if (tab === ACTIVE && typeof updateCtxGauge === 'function') updateCtxGauge(tab);
  // read run-config from the DOM selectors ONLY when this tab is the visible one; for a background
  // restart (deferred pendingRunCfg on a non-active tab) read the tab's OWN stored config so we never
  // bleed the ACTIVE tab's Model/Effort/Mode onto it. `extra` still overrides (e.g. the changed field).
  const fromDom = tab === ACTIVE;
  const body = {
    cwd: (fromDom ? $('#cwdInput').value.trim() : '') || tab.cwd || (STATE && (STATE.defaultCwd || STATE.home)),
    permissionMode: (fromDom ? $('#permMode').value : tab.permissionMode) || 'plan',
    model: (fromDom ? $('#modelSel').value : tab.modelSel) || undefined,
    effort: (fromDom ? $('#effortSel').value : tab.effort) || undefined,
    appendSystem: STYLE_PROMPTS[DISPLAY.style] || undefined,
    // N2: give the CLI the panel's own title, so the terminal `/resume` picker shows the same name
    // instead of its auto-title. Only meaningful once the tab HAS a real title.
    name: (!isDefaultTitle(tab) && tab.title) ? tab.title : undefined,
    // N1: let the CLI predict the follow-up prompt instead of the panel guessing it from the text
    promptSuggestions: !!DISPLAY.suggest,
    // A15/A3 — per-tab launch flags set from the tab menu (extra readable roots, dollar ceiling)
    addDirs: (tab.addDirs && tab.addDirs.length) ? tab.addDirs : undefined,
    maxBudgetUsd: tab.maxBudgetUsd || undefined,
    // D1 — this tab's standing constraints. The SERVER composes the final appended prompt (style +
    // global guardrails + these + corrections + the open-points protocol), so there is one truth.
    guardrails: tab.guardrails || undefined,
    // #34 — this tab's subagent policy (model, ceilings, may-they-spawn). Same split as the guardrails:
    // the server layers it over the global default, so headless runs inherit the global one.
    subagents: (tab.subagents && Object.keys(tab.subagents).length) ? tab.subagents : undefined,
    // Ultracode — three-state on purpose: `undefined` means „use the global default", which the server
    // resolves (resolveUltracode). Sending `false` for an untouched tab would silently override a
    // global ON, so the field is only present when this tab really decided.
    ultracode: (tab.ultracode === true || tab.ultracode === false) ? tab.ultracode : undefined,
    // C2/C3 — the session agent and a worktree of this chat's own. Launch flags like addDirs above:
    // they only apply to a (re)start, and `worktree: true` means „let the CLI pick the name".
    agent: tab.agent || undefined,
    worktree: tab.worktree || undefined,
    ...extra,
    ...pendingCfg, // newer than extra: _restartResumeNow takes its share before it calls, so this is a later wish
  };
  // per-session MCP scope: send the tab's explicit choice (array = subset, null = all). Omitted on a plain
  // resume so the server applies the session's stored choice (authoritative). `extra` can override.
  if (body.mcpServers === undefined && tab.mcpServers !== undefined) body.mcpServers = tab.mcpServers;
  // J1 — three-state like ultracode, and only on a FRESH start: 'p-…' names the project, '' says „deliberately
  // none", absent leaves it undecided. A resume or fork never sends it — the server takes the stored assignment.
  if (!extra.resume && typeof tab.projectId === 'string') body.projectId = tab.projectId;
  tab.cwd = body.cwd;
  // CTX-1 — a restart on ANOTHER model: everything measured for the previous one goes, and the probe below
  // re-asks. Also drops tab.model, so the window can't be re-derived from a model that is no longer running.
  if ((tab.modelSel || '') !== (body.model || '')) { if (typeof ctxForgetModel === 'function') ctxForgetModel(tab); tab.model = null; }
  tab.permissionMode = body.permissionMode; tab.effort = body.effort || ''; tab.modelSel = body.model || '';
  tab._starting = true; tab._exited = false; refreshSessionChip(tab); // "◌ startet…" until init resolves
  // repaint (not hide — CTX-3) now that the launch model is settled: the window may just have changed
  if (tab === ACTIVE && typeof updateCtxGauge === 'function') updateCtxGauge(tab);
  pushRecentCwd(body.cwd); refreshCwdList();
  let r;
  try { r = await api('/api/chat/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (e) {
    // A refused launch starts nothing — so the chip must not go on saying „◌ startet…" (it did, for every
    // failed start, until a reload) and the loader must not keep the composer locked for its 20 s safety.
    tab._starting = false;
    hideResumeLoading(tab);
    // CHAT-FLOW-4 — refused because another tab or window holds the session: the card, not a raw error.
    if (e && e.code === 'session-open-elsewhere' && extra.resume) markTabElsewhere(tab, e, extra.resume, body.cwd);
    refreshSessionChip(tab);
    throw e;
  }
  tab.id = r.chatId;
  if (typeof projectAdoptStart === 'function') projectAdoptStart(tab, r, !extra.resume); // J1/J4 — sessions.js
  tab._superseded = false; tab._elsewhere = null; // the session is this tab's again (CHAT-FLOW-4)
  // a queue held because the session was elsewhere is now held after a resume — same button, the right words
  if (tab.queuePaused === 'elsewhere') tab.queuePaused = 'resume';
  // On a plain --resume the sessionId is exactly the id we resumed → claim it NOW (optimistic, like
  // resumeDormant) instead of waiting for the `init` event, which on --resume doesn't reliably carry it. Without
  // this, persistTabs() sees no sessionId and drops the tab, so a reload can't restore a Sessions-list resume.
  // Fork mints a NEW id (only `init`/the `_session` event report it), so it stays on the init/_session path.
  if (extra.resume && !extra.fork) { tab.sessionId = tab.sessionId || extra.resume; if (typeof persistTabs === 'function') persistTabs(); }
  // The chip was last painted before the POST — with the flags just cleared still set, i.e. „⇄ anderswo offen"
  // after a takeover — and nothing else repaints it until the first message brings `init` (CHAT-FLOW-4, review).
  refreshSessionChip(tab);
  if (tab === ACTIVE) updateCwdRowVisibility(); // chat now started → hide the cwd row
  tab.es = new EventSource('/api/chat/' + tab.id + '/stream');
  // CTX-4 — ask the CLI how full the context is, right now. Measured 2026-10-02: in `-p --input-format
  // stream-json` the CLI emits NOTHING at spawn (the `system/init` frame only arrives with the first
  // message), yet it answers `get_context_usage` while idle — so this must NOT wait for init. On a
  // --resume it is the only number there is until the first turn of the new process ends.
  if (typeof ctxProbe === 'function') ctxProbe(tab, 'start');
  armStartSafety(tab); // disarmed by the first `_session`/`init` frame — see START_SAFETY_MS above
  tab.es.onmessage = (e) => { if (tab.phase === RECONNECT_PHASE) tab.phase = PHASE_WORKING; try { const ev = JSON.parse(e.data); if (ev._seq != null) { if (ev._seq <= (tab.lastSeq || 0)) return; tab.lastSeq = ev._seq; } handleEvent(tab, ev); } catch (err) { console.warn('bad event', err); } };
  tab.es.onopen = () => { tab._sseDead = false; if (tab.phase === RECONNECT_PHASE) { tab.phase = tab.streaming ? PHASE_WORKING : ''; if (tab === ACTIVE) renderStatus(); } if (typeof pingServer === 'function') pingServer(); }; // (re)connected → clear stale reconnect text + refresh the dot
  tab.es.onerror = () => {
    const dead = tab.es && tab.es.readyState === 2 && (tab.sessionId || (tab.pending && tab.pending.sessionId)); // 2 = CLOSED (fatal)
    if (tab.streaming && !dead) { tab.phase = RECONNECT_PHASE; if (tab === ACTIVE) renderStatus(); } // transient drop mid-turn → just show reconnecting
    // a permanently-closed stream (server reaped the session — INCLUDING one wedged at a permission/ask gate, which
    // stays streaming=true) → recover it shortly even while "streaming"; also survives a server restart (sessions
    // persist on disk). Backstops: focus/online + next send. (#25, ToDo 02/06)
    else if (dead) { tab._sseDead = true; if (typeof reconnectIdleTabs === 'function') setTimeout(reconnectIdleTabs, 400); }
    if (typeof pingServer === 'function') pingServer();
  };
  return r;
}

// open a new chat tab that resumes an existing session (UI Skills → „In Chat fortsetzen")
function openResumeInChat(sessionId, cwd) {
  if (typeof showView === 'function') showView('chat');
  // CHAT-FLOW-4 — already open in a tab of THIS window → that tab, not a second one: a second resume would
  // be refused by the server (and a double click on the button used to open two tabs that ended each other)
  const open = typeof findSessionTab === 'function' ? findSessionTab(sessionId) : null;
  if (open) { activateTab(open); return; }
  const t = makeTab({ title: tt('chat-events.fortsetzung') });
  activateTab(t);
  if (cwd) $('#cwdInput').value = cwd;
  // repaint the prior transcript like the Sessions-list resume (was only a "resumed" note → empty pane).
  const s = sessionRefFor(sessionId, cwd);
  startChat({ resume: sessionId, cwd: cwd || undefined }, t)
    .then(() => renderResumeHistory(s, t))
    // held by another tab or window: startChat put the card into the tab — offer the takeover right away
    .catch((e) => { if (e && e.code === 'session-open-elsewhere') return takeBackTab(t).then((ok) => { if (ok) holdQueueAfterResume(t); }); toast(e.message, 'err'); })
    .catch((e) => toast(String((e && e.message) || e), 'err'));
}
// launch a skill / composed prompt into a fresh chat tab with a given run-config (used by the skill launcher)
async function launchInNewTab(opts) {
  opts = opts || {};
  if (typeof showView === 'function') showView('chat');
  const t = makeTab({ title: opts.title || 'Skill' });
  // tab launched from a UI-skill form → tag it so the result event can render the result card + record the run
  if (opts.uiSkill) t.uiSkill = Object.assign({ startedAt: Date.now(), recorded: false }, opts.uiSkill);
  activateTab(t);
  if (opts.cwd) $('#cwdInput').value = opts.cwd;
  if (opts.model != null) $('#modelSel').value = opts.model || '';
  if (opts.effort != null) $('#effortSel').value = opts.effort || '';
  if (opts.permissionMode != null) $('#permMode').value = opts.permissionMode || 'plan';
  if (opts.title) t.manualTitle = true;
  chat = t;
  try {
    await startChat({}, t); // bind the spawned session to THIS tab even if the user switches during the await
    withTab(t, () => addMsg('user', opts.prompt || ''));
    withTab(t, () => setComposerBusy(true));
    await api('/api/chat/' + t.id + '/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: opts.prompt || '' }) });
  } catch (e) { toast(e.message, 'err'); setComposerBusy(false); }
}
// open a fresh tab with the composer pre-filled (user adds args + hits Enter) — for slash skills
function prefillNewTab(text, title) {
  if (typeof showView === 'function') showView('chat');
  const t = makeTab({ title: title || 'Skill' }); activateTab(t);
  const ci = $('#composerInput'); ci.value = text || ''; autoGrow(); ci.focus();
  try { const s = ci.value.length; ci.setSelectionRange(s, s); } catch { /* */ }
  return t;
}

