// Part of the Claude Code Control Panel front-end (split from app.js).
// Classic scripts share one global scope; load order in index.html is authoritative: render → chat → sessions → views → commands → boot.
// This file: chat-status.js

// --- persistent status strip: always shows model + colour-coded mode of the ACTIVE tab;
//     while streaming it also shows the pulsing dot · phase · (elapsed · ↓tokens · effort). ---
const WAIT_APPROVAL = 'phase:wait-approval'; // sentinel key — translated in phaseLabel, never compared as text
// true while a permission modal/queue entry is genuinely outstanding for this tab — used to suppress a
// stale "waiting for approval…" phase (it was never reset after the permission resolved).
function hasOutstandingPerm(tab) { return (pendingPerm && pendingPerm.tab === tab) || permQueue.some((i) => i.tab === tab); }
// true while a held AskUserQuestion / ExitPlanMode gate is still outstanding for this tab
function hasOutstandingAsk(tab) { for (const g of ASK_GATES.values()) if (g.tab === tab) return true; return false; }
// the current in-progress task's active form (console shows this as the working verb, e.g. "Building…")
// U1 — reads `tab.taskList` through taskListView(), i.e. the SAME normalisation the strip uses, because the
// feed changed: `TodoWrite` is called 0 times on this machine, and `TaskCreate`/`TaskUpdate` are what the CLI
// really offers (public/js/task-list.js has the counts). This is the reader that would otherwise have gone
// quietly blind while the strip above it filled up — the exact failure this project keeps paying for.
function activeTodoPhase(tab) {
  if (!tab) return '';
  const rows = (typeof taskListView === 'function') ? taskListView(tab.taskList || []).rows : [];
  const cur = rows.find((x) => x.state === 'in_progress');
  return cur ? (cur.activeForm || cur.text || '') : '';
}
// PF-1 — the step of the accepted plan, as the model reported it: „⏳ Schritt 3/7 · Verdrahte die Route" (the ⏳ is
// the checklist's mark for the running step, planStepMark — PF-1b: one sign for „läuft" in rail and strip). Ahead of
// the todo verb, because TodoWrite is switched off for Opus 5.5 (CLI 2.1.288) — for most tabs the plan IS the
// only answer to „what is being done right now". Nothing without a reported current step: a step guessed from
// the order of the list would be stated in the present tense about work nobody said had started.
function planPhase(tab) {
  const p = tab && tab.plan;
  if (!p || p.state !== 'active' || typeof planCounts !== 'function') return '';
  if (typeof planProgressOn === 'function' && !planProgressOn()) return '';
  const c = planCounts(p);
  if (!c.index) return '';
  const s = p.steps[c.index - 1];
  return planStepMark('in_progress') + ' ' + tt('chat-status.planSchritt') + c.index + '/' + c.total + ' · ' + (p.activeForm || (s && s.title) || '');
}
// the phase to actually display: heal a stale "waiting" phase when nothing is actually outstanding for this
// tab (the approval-wait AND the ask/plan-wait — the latter guards a plan-accept that resolved its gate).
// When the phase is just the generic "Working…", surface the current in-progress todo as the verb (ToDo 01).
function phaseLabel(p) { // sentinel key → the CURRENT language's text (free-form phases pass through)
  if (p === PHASE_WORKING) return tt('common.arbeite');
  if (p === PHASE_WRITING) return tt('chat-events.schreibe');
  if (p === PHASE_THINKING) return tt('chat-events.denkeNach');
  if (p === PHASE_TOOLWORK) return tt('chat-events.arbeite');
  if (p === WAIT_APPROVAL) return tt('chat-status.warteAufFreigabe');
  if (p === ASK_WAIT_PHASE) return '⏳ ' + tt('chat-render.warteAufDeineAntwort');
  if (p === RECONNECT_PHASE) return tt('chat-events.verbindungGetrenntReconnect');
  return p;
}
// G5 — one place turns a session-state payload (session-state.js) into a string. `key` is translated,
// `raw` is the CLI's own word for a state we do not know and must stay exactly as it arrived: it is the
// only thing a reader can search for. Same split as turnEndPartText in chat-events.js.
function sessionStateText(r) {
  return (r.sev === 'warn' ? '⚠ ' : '⏳ ') + tt(r.key) + (r.raw ? ' (' + r.raw + ')' : '');
}
// The two things the panel already knows about its own tab, handed to the pure decision so it can stay
// silent wherever the panel can say more than the frame can (session-state.js sessionStateReport).
function sessionStateCtx(tab, streaming) {
  return { streaming: !!streaming, ownGate: hasOutstandingPerm(tab) || hasOutstandingAsk(tab) };
}
function displayPhase(tab) {
  let p = tab.phase || PHASE_WORKING;
  if (p === WAIT_APPROVAL && !hasOutstandingPerm(tab)) p = PHASE_WORKING;
  if (p === ASK_WAIT_PHASE && !hasOutstandingAsk(tab)) p = PHASE_WORKING;
  // G5 — what the CLI itself reports about this session, but ONLY where the panel has nothing better, and
  // „nothing better" means `p === PHASE_WORKING` and nothing else. An earlier version put this ahead of the
  // `p` check, reasoning that „of the three states only `requires_action` can produce anything here" — which
  // overlooked the branch for an UNKNOWN state right below it. A fourth state from a future CLI therefore
  // displaced „warte auf Freigabe", „warte auf deine Antwort", the running todo verb and „Verbindung
  // getrennt – versuche erneut…", and stayed until a known state arrived. The reachable half was worse:
  // `requires_action` with no gate of our own overwrote the reconnect phase, so the panel claimed in the
  // present tense that the session awaits a decision while the connection was gone and the record could not
  // be updated at all. Throwing away a phase the panel HAS a request id for, in favour of a sentence that
  // cannot name what is waiting, is this project's bug class in its mirror form. The hole this fills IS
  // „arbeite…" — so that is the only phase it may replace.
  // Derived on every 200 ms tick on purpose: the frame arrives ONE FRAME BEFORE the `can_use_tool` request it
  // belongs to (measured _seq 37 vs 38), so a painted message would state a hole that closes a frame later,
  // while this read heals itself at the next tick.
  // The `tab.sessionState` test comes FIRST, before sessionStateCtx: it is null until a frame has arrived,
  // and sessionStateCtx reads `pendingPerm`/`permQueue`, which chat-perms.js declares with `let`/`const`
  // and therefore later in load order than this file. No frame can exist before that script has run, so
  // this ordering is also what keeps the lookup out of its temporal dead zone.
  if (p === PHASE_WORKING) {
    const rep = (tab.sessionState && typeof sessionStateReport === 'function')
      ? sessionStateReport(tab.sessionState, sessionStateCtx(tab, true)) : null;
    if (rep) return sessionStateText(rep);
  }
  if (p === PHASE_WORKING) return planPhase(tab) || activeTodoPhase(tab) || phaseLabel(PHASE_WORKING);
  // PF-1 — „arbeite…" between two tool calls is the OTHER generic phase (PHASE_TOOLWORK: every tool result sets
  // it), and in a running plan it is the one the strip shows nearly all the time — PHASE_WORKING only lasts from
  // a turn's start or a gate's answer to the first frame. With the plan step behind PHASE_WORKING alone, the
  // strip said „arbeite…" through the whole plan after all (seen in the browser: S1, S2, never a step). The plan
  // step only: the todo verb keeps its old reach, and a NAMED phase (läuft Read…, schreibe…) still wins.
  if (p === PHASE_TOOLWORK) return planPhase(tab) || phaseLabel(p);
  return phaseLabel(p);
}
// --- status-strip chips -------------------------------------------------------------------------------
// The working directory decides which CLAUDE.md applies, what /diff compares and what @-completion can see,
// so it must stay visible and changeable (C5). It no longer does that from a chip in this row: at up to
// 198px it was the single widest thing in a line that was already cutting the token count off. It lives in
// the tab's context menu and on the tab's tooltip now — same information, no permanent cost.
function shortCwd(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  if (!s) return '—';
  const parts = s.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? s : '…' + s.slice(s.length - (parts.slice(-2).join('/').length + 1));
}
// The cwd this tab would actually run in: its own, else the pending input, else the server default.
function tabCwd(t) {
  if (!t) return '';
  return t.cwd || (!t.id && $('#cwdInput') ? $('#cwdInput').value.trim() : '') || (STATE && (STATE.defaultCwd || STATE.home)) || '';
}
// Session cost + tokens: the numbers already arrive with every `result` event and were only shown in the
// per-turn footer, which scrolls away. One quiet chip keeps "what is this session costing" answerable (M19).
// The token count is prefixed "Σ" because it is the SUM over all turns — millions of tokens in a long
// session — and it sits a few pixels above a gauge whose number is the context (at most one window).
// Two unlabelled "… tok" in one corner read as two answers to the same question; only the tooltip said
// which was which.
function costChip(t) {
  if (!t.sessionCost && !t.sessionTokens) return null;
  const cost = t.sessionCost || 0, tok = t.sessionTokens || 0;
  const c = el('span', 'cs-cost');
  c.textContent = (cost ? (typeof fmtUSD === 'function' ? fmtUSD(cost) : '$' + cost.toFixed(4)) : '')
    + (cost && tok ? ' · ' : '') + (tok ? 'Σ ' + fmtNum(tok) + ' tok' : '');
  c.title = tt('chat-status.sitzungskostenTooltip');
  return c;
}
// PR-13 — the cost brake's own count (lib/budget.js `_budget` frames): spend since this launch INCLUDING
// the subagent and workflow-agent transcripts, against the tab's budget. A second chip and not a second
// number in costChip on purpose: that one is the CLI's `total_cost_usd`, which never contains a workflow
// agent — merging the two would hide exactly the gap this brake exists for. Shown for as long as the server
// reports a budget (show, don't hide): marked from 80 %, red once the brake has tripped.
function budgetChip(t) {
  const b = t.budgetLive;
  if (!b || !(b.limitUsd > 0)) return null;
  const money = (v) => (typeof fmtUSD === 'function' ? fmtUSD(v) : '$' + Number(v || 0).toFixed(2));
  const share = b.spentUsd / b.limitUsd;
  const c = el('span', 'cs-budget' + (b.tripped ? ' bad' : share >= 0.8 ? ' warn' : ''));
  c.textContent = (b.tripped ? '⛔ ' : '💰 ') + money(b.spentUsd) + ' / ' + money(b.limitUsd);
  const p = b.parts || {};
  c.title = tt(b.tripped ? 'chat-status.budgetGebremst' : 'chat-status.budgetTooltip')
    + '\n' + tt('chat-status.budgetHaupt') + money(p.main || 0)
    + '\n' + tt('chat-status.budgetSubagenten') + money(p.subagents || 0)
    + '\n' + tt('chat-status.budgetWorkflows') + money(p.workflows || 0)
    + (b.unpricedTokens ? '\n' + tt('chat-status.budgetOhnePreis').replace('{n}', fmtNum(b.unpricedTokens)) : '')
    + '\n\n' + tt('chat-status.budgetGrenze');
  return c;
}
// Ultracode = standing dynamic-workflow orchestration. It changes how the session WORKS (a turn may
// become a whole workflow of agents), which is exactly the kind of thing that must not be invisible —
// and it has a third state most switches do not: requested but not in effect, because the CLI accepts
// `ultracode:true` on a model that cannot do it and reports success anyway (measured on Haiku 4.5).
// Showing only on/off would therefore mean showing a lie half the time. The four states come from
// ultracodeView (chat.js), which is also what the tab menu and the dialog read:
//   on          → 🌀 Ultracode. Click switches it off.
//   off         → 🌀 Ultracode aus, muted. Shown only when the model CAN do it, and clickable — that is
//                 the whole point: the switch used to be reachable only through a right-click tab menu.
//   ineffective → 🌀 Ultracode, marked, with the reason on the tooltip. Click WITHDRAWS the wish; turning
//                 it on from here is impossible, and offering it would be the lie the states prevent.
//   none        → nothing. Not possible AND not wished for is not news, and it is what the CLI shows too.
//   unknown     → 🌀 Ultracode unbestätigt, dashed. The session was asked and did not answer (a control
//                 request times out after 5 s and still resolves „success"), so there is no state to show.
//                 It must NOT fall back to the muted „aus" chip: that was the H1 defect — a silence from the
//                 session was published as „Ultracode aus", i.e. the panel answered a question nobody had
//                 answered. Click re-asks instead of toggling, because toggling from an unknown state would
//                 be guessing twice.
// A tab that has not started yet shows its WISH (dashed), so what you set is visible before the first turn.
//
// A BUTTON, on the grantChips pattern below, including its `e.stopPropagation()`: the strip itself is
// clickable, so without that the chip's click would also fire the strip's.
function ultracodeChip(t) {
  const v = (typeof ultracodeView === 'function') ? ultracodeView(t) : null;
  if (!v || v.chip === 'none') return null;
  // 'unknown' takes the DASHED wish look through the last arm, and by construction rather than through a
  // branch of its own: ultracodeView only reports `running` for a read-out that said something, so an unknown
  // state can never reach the solid „on" look. What it must never take is ` cs-ultra-off` — the muted look
  // belongs to a state somebody actually read. (An arm `v.chip === 'unknown' ? ' cs-ultra-wish'` stood here
  // and produced the identical class: a branch no test can tell from its absence is worse than no branch.)
  const cls = v.chip === 'ineffective' ? ' cs-ultra-bad' : v.chip === 'off' ? ' cs-ultra-off' : (v.running ? '' : ' cs-ultra-wish');
  const c = el('button', 'cs-ultra' + cls); c.type = 'button';
  c.textContent = '🌀 ' + tt('chat-status.ultracode')
    + (v.chip === 'off' ? ' ' + tt('chat-status.ultracodeAusKurz') : '')
    + (v.chip === 'unknown' ? ' ' + tt('chat-status.ultracodeUnbekanntKurz') : '');
  // „is not in effect" is a statement about a running session. Before a start the same shape is only the
  // model-list FORECAST, so it is prefixed as one — a guess must not be worn as a measurement. And the
  // muted „aus" chip only promises „dieses Modell könnte es" once the forecast has actually answered
  // (`canDoKnown`); before that it says that it has not been checked (M2).
  const what = v.chip === 'unknown' ? tt('chat-status.ultracodeUnbekanntTooltip')
    : v.chip === 'ineffective'
      ? (v.running ? '' : tt('chat.ultracodeVoraussichtlich') + ' ') + tt('chat-status.ultracodeUnwirksamTooltip')
        + (typeof ultracodeReasonText === 'function' ? ' ' + ultracodeReasonText(v) : '')
      : v.chip === 'off' ? (v.canDoKnown ? tt('chat-status.ultracodeAusTooltip') : tt('chat-status.ultracodeAusUngeprueftTooltip'))
        : v.running ? tt('chat-status.ultracodeAnTooltip') : tt('chat-status.ultracodeWunschTooltip');
  const click = v.chip === 'unknown' ? tt('chat-status.ultracodeKlickNachfragen')
    : v.chip === 'ineffective' ? tt('chat-status.ultracodeKlickZuruecknehmen')
      : v.chip === 'on' ? tt('chat-status.ultracodeKlickAus') : tt('chat-status.ultracodeKlickAn');
  c.title = what + '\n' + click;
  c.setAttribute('aria-label', what + ' — ' + click);
  c.onclick = (e) => { e.stopPropagation(); ultracodeChipClick(t, v); };
  return c;
}
// The chip's click. Kept out of the render so the three outcomes can be read side by side — and because
// 'ineffective' does TWO things at once (withdraw the WISH and switch the session off), which needs a toast
// of its own: „off" alone would read as if the model had simply been asked to stop doing something it was
// doing. The wish is only ever withdrawn, never silently re-aimed: switching back to a capable model makes
// a wish that is still set effective again, which is why nothing here clears it on a model change.
async function ultracodeChipClick(t, v) {
  // 'unknown' is not a position, so there is nothing to toggle: the only useful action is to ask the session
  // again. Toggling would have switched it OFF (`v.chip === 'off'` is false for 'unknown'), which is a real
  // change made on the basis of a state nobody knows.
  if (v.chip === 'unknown') {
    if (typeof refreshUltracodeState === 'function') await refreshUltracodeState(t);
    return;
  }
  const next = v.chip === 'off';                      // 'on' → off · 'off' → on · 'ineffective' → off
  const was = t.ultracode;                            // handed to applyLiveUltracode so a failed switch rolls back
  t.ultracode = next;
  if (typeof persistTabs === 'function') persistTabs();
  if (v.chip === 'ineffective') toast(tt('chat-status.ultracodeWunschZurueck'), 'ok');
  if (!t.id) {                                        // nothing running yet → it is a stored wish, nothing else
    renderStatusBar();
    if (v.chip !== 'ineffective') toast(tt('chat.ultracodeGemerkt'), 'ok');
    return;
  }
  // The wish is written optimistically (the chip has to answer the click at once), so the request owns the
  // rollback: the server undoes its own `ultracodeWish` when nothing was applied, and the browser must not
  // be left holding a wish the session never got.
  if (typeof applyLiveUltracode === 'function') await applyLiveUltracode(t, next, was);
  else renderStatusBar();
}
// „Immer erlauben" grants were invisible and permanent for the session: you couldn't see WHAT you had blessed,
// let alone take it back. One chip per granted tool, × = revoke (C14).
//
// H4: the chip used to BE the button — a click anywhere on it, on the ✓ or on the padding, dropped a
// grant instantly and silently, and in the 160px rail the chips sit stacked and touching. Two changes:
// only the × acts, and the notice carries the way back. The grant lives in memory, so the undo is just
// putting the entry back into the Set — no file, no round trip, nothing that can half-succeed.
function grantChips(t) {
  const out = [];
  if (!t.alwaysAllow || !t.alwaysAllow.size) return out;
  [...t.alwaysAllow].forEach((tool) => {
    const c = el('span', 'cs-grant');
    c.appendChild(el('span', 'cs-grant-ico', '✓'));
    c.appendChild(el('span', 'cs-grant-nm', tool)); // named so the narrow rail can ellipsise it
    const x = el('button', 'cs-grant-x', '×'); x.type = 'button';
    x.title = tt('chat-status.freigabeEntfernen') + tool;
    x.setAttribute('aria-label', tt('chat-status.freigabeEntfernen') + tool);
    x.onclick = (e) => {
      e.stopPropagation();
      t.alwaysAllow.delete(tool);
      // _autoAllowSeen is the „this one was already auto-answered" ledger. It has to come back together
      // with the grant; a restored grant that lost its ledger entry would behave like a fresh one.
      const wasSeen = !!(t._autoAllowSeen && t._autoAllowSeen.has(tool));
      if (t._autoAllowSeen) t._autoAllowSeen.delete(tool);
      // renderStatusBar() ends in chatSideRefresh(), which is what actually repaints these chips —
      // they live in the rail, not in the status line. One call, not two.
      toast(tt('chat-status.freigabeZurueckgenommen') + tool, 'ok', {
        undo: {
          onClick: () => {
            t.alwaysAllow.add(tool);
            if (wasSeen && t._autoAllowSeen) t._autoAllowSeen.add(tool);
            renderStatusBar();
          },
        },
      });
      renderStatusBar();
    };
    c.appendChild(x);
    c.title = tt('chat-status.immerErlaubtKlickenZum') + tool;
    out.push(c);
  });
  return out;
}

// The „als Standard merken" pin (C10). Injected once next to the three selectors — renderStatusBar only
// rebuilds .cs-left, so it survives every repaint.
function ensureDefaultsPin() {
  const right = document.querySelector('#chatStatus .cs-right');
  if (!right || $('#pinDefaults')) return;
  const b = el('button', 'cs-pin'); b.id = 'pinDefaults'; b.type = 'button';
  b.innerHTML = ic('pin', 13);
  b.onclick = (e) => { e.stopPropagation(); saveChatDefaults(); refreshDefaultsPin(); toast(tt('chat.alsStandardGemerkt'), 'ok'); };
  right.appendChild(b);
}
function refreshDefaultsPin() {
  const b = $('#pinDefaults'); if (!b) return;
  const same = ($('#modelSel').value || '') === (CHAT_DEFAULTS.model || '')
    && ($('#effortSel').value || '') === (CHAT_DEFAULTS.effort || '')
    && ($('#permMode').value || 'plan') === (CHAT_DEFAULTS.permMode || 'plan');
  b.classList.toggle('is-pinned', same);
  b.title = same ? tt('chat-status.entsprichtDemStandard') : tt('chat-status.alsStandardFuerNeueChats');
}
// The concrete model the CURRENT selector entry stands for (menu field `resolves`, derived in
// lib/models.js from the entitlement cache). '' for an entry we cannot resolve — then the read-out chip
// below stays visible, because nothing else in the bar would name the model.
function selectedModelResolves() {
  const sel = $('#modelSel');
  return (sel && typeof modelResolves === 'function') ? modelResolves(sel.value) : '';
}
// Two ids mean the same model when they reduce to the same bare name. On Bedrock the menu's values and
// `resolves` are gateway ids ("eu.anthropic.claude-opus-5") while the session reports the bare
// "claude-opus-5", so without dropping the provider prefix and the Bedrock version suffix EVERY Bedrock
// session would paint the orange „running ≠ selected" marker and claim a divergence that isn't there.
// Same reduction as lib/models.js `bedrockBase` and agent-lanes.js `laneModelId` (both are separately
// require'd pure modules, so they each carry their own copy).
const normModelId = (m) => String(m || '')
  .replace(/\[1m\]/i, '')
  .replace(/^[a-z]{2,6}(-[a-z]+)?\.(anthropic|bedrock)\./i, '')
  .replace(/-v\d+(:\d+)?$/i, '')
  .replace(/-\d{8}$/, '');
// The name the model MENU gives a concrete model id, so the strip says "Opus 5 (1M)" — the exact wording
// of the dropdown two chips to the right — instead of the raw api name "claude-opus-5". '' when no menu
// entry stands for this model (an old resumed model, or the list hasn't loaded yet) → caller falls back.
// CTX-7 — `sel` (the tab's raw selector value) is consulted FIRST, and that is not a nicety: the match
// below runs through normModelId, which drops the "[1m]" suffix, so "claude-opus-5" matches both the 1M
// entry and the 200 K one and `find` simply takes whichever comes first in the menu. That is how a tab on
// the 200 K model got labelled „Opus 5 (1M)" while its window said 200 000 — the label and the window
// came from two different places. The selector value still carries the suffix, so it identifies the exact
// entry. It is only skipped for „Default" (value ''), whose own label names no model at all — there the
// `init` model is the only thing that does.
function modelMenuLabel(id, sel) {
  const list = (typeof MODELS_CACHE !== 'undefined' && MODELS_CACHE && MODELS_CACHE.models) || [];
  const n = normModelId(id);
  const entry = list.find((m) => m.value === sel) || null;
  if (sel && entry) {
    // …but only while that entry still stands for the model that is RUNNING. The CLI can fall back on its
    // own, and then the selector names somebody else — this chip reports who is answering, not who was
    // asked for. The comparison passes for both context variants of one model, which is the point.
    if (!n || normModelId(entry.resolves) === n || normModelId(entry.value) === n) return entry.label;
  }
  if (!n) return '';
  // Which VARIANT to label. „Default" has no spelling of its own (its value is the empty string), so its
  // entry's `resolves` is the only thing that says whether this session is the 1M one — and without that
  // the search below returned whichever context variant the menu happens to list first, which is the wide
  // one (lib/models.js pushes „… (1M)" before the plain row). That is how a Default tab running the 200 K
  // model got labelled „Opus 5 (1M)" — and the context line then flagged a label/window contradiction that
  // was the label's own invention.
  const wide = (x) => /\[1m\]/i.test(String(x == null ? '' : x));
  const want = wide(entry ? (entry.value || entry.resolves) : sel);
  const same = (m) => m.value && (normModelId(m.resolves) === n || normModelId(m.value) === n);
  const hit = list.find((m) => same(m) && wide(m.value) === want) || list.find(same);
  return hit ? hit.label : '';
}
// Modes that are always spelled out in the strip, dot or no dot: what they permit is not something to
// discover by hovering. `bypassPermissions` runs everything; `dontAsk` stops asking.
const LOUD_MODES = ['bypassPermissions', 'dontAsk'];
// #34 — the agent badge. The rail can be collapsed (and is, by default, when nothing is pending), so
// without this a turn could spawn five subagents, spend minutes and real money, and the only trace on
// screen would be a 40px strip with a number on it. Clicking opens the rail; with exactly one agent
// it goes straight into its detail view, which is what you wanted in that case anyway.
// U1 — TWO badges, out of the same split the rail uses (chat-render.js agentLaneSplit): 🤖 for agent lanes,
// ⚙ for workflow runs. Before, this read `t.agents` whole, so a running workflow and nothing else made the
// strip say „🤖 1" over a rail with no 🤖 group in it — and the one-lane shortcut then opened the DETAIL
// view of that workflow lane, which has nothing to show for one (no outputFile; docs/ideas.md U5). So:
//  · 🤖 counts, lists and shortcuts the agent lanes only — „exactly one agent" means one AGENT row;
//  · ⚙ shows the same count as the ⚙ group head (workflowCountLabel) and only opens the rail. There is no
//    detail view for a workflow yet, and a click that opens an empty one is worse than none.
function laneStatusBadges(t) {
  const out = [];
  if (!t) return out;
  const split = (typeof agentLaneSplit === 'function') ? agentLaneSplit(t) : { plain: t.agents || [], workflows: [] };
  const lanes = split.plain;
  if (lanes.length) {
    const run = lanes.filter((a) => a.status === 'running').length;
    const bad = lanes.some((a) => a.status === 'error');
    const aEl = el('button', 'cs-agents' + (run ? ' live' : '') + (bad ? ' bad' : ''),
      '🤖 ' + (run ? String(run) : '√' + lanes.length));
    aEl.type = 'button';
    aEl.title = (run ? tt('chat-status.agentenLaufen').replace('{n}', run) : tt('chat-status.agentenFertig').replace('{n}', lanes.length))
      + '\n' + lanes.map((a) => {
        const m = laneMetrics(a);
        return (m.live ? '▸ ' : m.status === 'error' ? '✕ ' : '√ ') + m.type + (m.desc ? ' · ' + m.desc : '');
      }).join('\n');
    aEl.onclick = (e) => {
      e.stopPropagation();
      if (typeof chatSideSetCollapsed === 'function') chatSideSetCollapsed(false);
      if (lanes.length === 1 && typeof agentDetailShow === 'function') agentDetailShow(lanes[0], t);
    };
    out.push(aEl);
  }
  const runs = split.workflows;
  if (runs.length && typeof workflowCounts === 'function' && typeof wfView === 'function') {
    const c = workflowCounts(t);
    const run = runs.filter((a) => a.status === 'running').length;
    const bad = runs.some((a) => a.status === 'error');
    const wEl = el('button', 'cs-agents cs-workflows' + (run ? ' live' : '') + (bad ? ' bad' : ''),
      '⚙ ' + workflowCountLabel(c));
    wEl.type = 'button';
    // The run's own line per workflow: its name and its done/total — never „fertig" for a run whose agents
    // are not all through (the same rule as the ⚙ group head), and the open sentence when one cannot be placed.
    wEl.title = (run ? tt('chat-status.workflowsLaufen').replace('{n}', run) : tt('chat-status.workflowsBeendet').replace('{n}', runs.length))
      + '\n' + runs.map((a) => {
        const v = wfView(a);
        return (a.status === 'running' ? '▸ ' : a.status === 'error' ? '✕ ' : '· ') + (v.name || tt('chat-render.wfUnbenannt'))
          + (v.counts.total ? ' · ' + v.counts.done + '/' + v.counts.total : '');
      }).join('\n')
      + (c.open ? '\n' + tt('chat-side.workflowOffenN').replace('{n}', c.open) : '');
    wEl.onclick = (e) => {
      e.stopPropagation();
      if (typeof chatSideSetCollapsed === 'function') chatSideSetCollapsed(false);
    };
    out.push(wEl);
  }
  return out;
}
// J4 — „◆ X": the tab's project, and „geändert seit Start" when the running process knows an older state (the project
// was edited after the start, or the tab was assigned another one). The WHEN of that is t._projectNote, computed once
// at the start / the assign (sessions.js projectEffectKey) — not here. Ellipsises under pressure, never hides.
function projectStatusChip(t) {
  if (!t || !t.projectId || typeof sessProjName !== 'function') return null;
  const p = typeof projById === 'function' ? projById(t.projectId) : null;
  const name = p ? p.name : (t._projectRun === t.projectId && t._projectName) || sessProjName(t.projectId);
  const started = !!(t.id || t.sessionId);
  const changed = started && (t._projectRun !== t.projectId || (!!p && t._projectAt != null && Number(p.updatedAt) > t._projectAt));
  const c = el('button', 'proj-cs-chip' + (changed ? ' cs-proj-changed' : ''), '◆ ' + name + (changed ? ' · ' + tt('projects.chipGeaendert') : ''));
  c.type = 'button';
  c.title = tt('projects.chipTitel').replace('{name}', name)
    + (changed ? '\n' + tt('projects.chipGeaendertTitel') + (t._projectNote ? '\n' + tt(t._projectNote) : '') : '')
    + (started ? '' : '\n' + tt('projects.chipBeimStart'));
  c.onclick = (e) => { e.stopPropagation(); openTabProjectPicker(t, c); };
  return c;
}
function renderStatusBar() {
  const box = $('#chatStatus'); if (!box) return;
  ensureDefaultsPin(); refreshDefaultsPin();
  const t = ACTIVE;
  // the 3 dropdowns live in a static .cs-right sibling (ToDo 07a) — only rebuild the dynamic left half
  const left = box.querySelector('.cs-left') || box; left.innerHTML = '';
  if (!t) return;
  box.classList.remove('hidden');
  box.classList.toggle('idle', !t.streaming);
  statusLiveReserve(box);
  // Model read-out — ALWAYS on. It used to be conditional: hidden whenever the running model was what
  // the selector already points at, on the theory that naming it twice is wasted width. What that
  // actually produced was a strip that went wordless exactly when everything was normal — mid-turn you
  // were left with a pulsing dot and an 8px mode dot and nothing else, and the one question this row
  // exists to answer ("who is answering me right now?") had no answer on screen. Two dots and no words
  // reads as broken, not as "all fine", and because the chip did appear in the odd cases, the model
  // name seemed to come and go at random. The model is named unconditionally now; what gets MARKED is
  // the interesting case — running ≠ selected.
  // Compare like for like: the selector's VALUE is an alias ("opus[1m]"), while `resolves` and the model
  // the CLI reports back are concrete ids ("claude-opus-5"), so the selector value is resolved too.
  const mdlRaw = t.model || (!t.id && $('#modelSel') ? $('#modelSel').value : '') || '';
  const mdl = (t.id || typeof modelResolves !== 'function') ? mdlRaw : (modelResolves(mdlRaw) || mdlRaw);
  const selRes = selectedModelResolves();
  // Only a resolvable selection can disagree: with "Default" picked (`resolves` = '') the CLI chooses,
  // so whatever it chose is not a divergence — and an empty list must not paint everything as one.
  const mdlDiff = !!mdl && !!selRes && normModelId(mdl) !== normModelId(selRes);
  const g = modelGlyph(mdl);
  const mdlEl = el('span', 'cs-model' + (mdlDiff ? ' cs-model-diff' : ''),
    (g ? g + ' ' : '') + (modelMenuLabel(mdl, t.modelSel) || shortModel(mdl) || tt('chat-status.standardmodell')));
  mdlEl.title = (mdlDiff ? tt('chat-status.modellWeichtAb') : tt('chat-status.modellDerSitzung'))
    + (mdl || tt('chat-status.standardmodell'));
  left.appendChild(mdlEl);
  // Actual running permission mode. The LABEL duplicated the mode selector sitting 20px to the right,
  // and that duplication is what pushed the cost chip out of the row (measured: 57px for a word you can
  // already read). Only spell it out when the two genuinely differ — the colour dot always stays, it is
  // the at-a-glance "what may Claude do" signal and costs 8px.
  const selMode = $('#permMode') ? $('#permMode').value : 'plan';
  const mode = t.id ? (t.permissionMode || 'plan') : selMode;
  const mi = modeInfo(mode);
  // Full autonomy means no more questions, whatever the tool — and an 8px dot was the only signal for
  // it (B18). The input line itself carries a danger outline while that mode is the running one.
  const comp = document.querySelector('.composer');
  if (comp) comp.classList.toggle('is-bypass', mode === 'bypassPermissions');
  // D1 — standing constraints must be VISIBLE, otherwise they are just another invisible setting.
  // Click opens the field; the tooltip carries the full text.
  const grd = t.guardrails || (STATE && STATE.prefs && STATE.prefs.guardrails) || '';
  if (grd) {
    const own = !!t.guardrails;
    const gEl = el('button', 'cs-guard' + (own ? '' : ' cs-guard-global'), '🛡 ' + guardrailCount(grd));
    gEl.type = 'button';
    gEl.title = (own ? tt('chat-status.leitplankenTab') : tt('chat-status.leitplankenGlobal')) + '\n\n' + grd;
    gEl.onclick = (e) => { e.stopPropagation(); editTabGuardrails(t); };
    left.appendChild(gEl);
  }
  const pc = projectStatusChip(t); if (pc) left.appendChild(pc); // J4 ◆
  // #34 — the agent badge, and since U1 the ⚙ badge next to it (laneStatusBadges, right above this function).
  laneStatusBadges(t).forEach((b) => left.appendChild(b));
  // A3 — the usage limit, for as long as it is pending. It sits next to the agent badge because both
  // answer the same question („why is nothing happening?"), and it leaves on its own: a one-shot timer
  // repaints the strip at the reset moment, so the chip can never outlive the limit it reports.
  clearTimeout(LIMIT_TIMER); LIMIT_TIMER = null;
  if (typeof rateLimitPending === 'function' && rateLimitPending(t.rateLimit)) {
    const rl = t.rateLimit;
    const lEl = el('span', 'cs-limit' + (rl.rejected ? ' bad' : ''),
      '⏳ ' + tt('chat-status.limit') + (rl.resetsAtMs ? ' · ' + fmtClock(rl.resetsAtMs) : ''));
    lEl.title = tt('chat-status.limitTitel') + (rl.status || '?') + (rl.type ? ' · ' + rl.type : '')
      + (rl.resetsAtMs ? '\n' + tt('chat-status.limitReset') + new Date(rl.resetsAtMs).toLocaleString() : '')
      + (rl.usingOverage ? '\n' + tt('chat-status.limitOverage') : '')
      + (rl.overageDisabledReason ? '\n' + rl.overageDisabledReason : '')
      + (rl.fallbackAvailable ? '\n' + tt('chat-status.limitFallback') : '');
    left.appendChild(lEl);
    if (rl.resetsAtMs) {
      const due = Math.max(1000, Math.min(6 * 3600 * 1000, rl.resetsAtMs - Date.now() + 500));
      LIMIT_TIMER = setTimeout(() => { if (ACTIVE === t) renderStatusBar(); }, due);
    }
  }
  // G5 — the CLI's own session state, next to the two chips that answer the same question („why is
  // nothing happening?"). ONLY for a tab the panel shows at REST: while streaming the phase text two
  // lines down owns this payload, and saying it twice in one row trains the eye to skip both (the same
  // reasoning that keeps `running` silent in session-state.js). Measured, this is CHAT-FLOW-3 itself: in
  // run 1 the session stayed `running` from _seq 39 through the FIRST result (_seq 58, result_index 0) and
  // a whole follow-up turn to _seq 79, while the panel drops `streaming` at that first result — which
  // hid the Stop button. The follow-up turn is adopted as streaming now (CHAT-FLOW-3), so the chip covers
  // what is left: background-only work, frame-less main-thread work. `idle` (_seq 80) is what takes the
  // chip away again, and that is the only job `idle` has here.
  // `t.sessionState` is tested before sessionStateCtx for the load-order reason spelled out in
  // displayPhase above — this function runs at boot (chat-perms.js bootstraps the first tab), and no
  // state frame can have arrived by then.
  if (!t.streaming && t.sessionState) {
    const sRep = (typeof sessionStateReport === 'function')
      ? sessionStateReport(t.sessionState, sessionStateCtx(t, false)) : null;
    if (sRep) {
      const sEl = el('span', 'cs-sstate', sessionStateText(sRep));
      // the tooltip comes WITH the payload (session-state.js): all three reports land on this one chip,
      // and a single tooltip would describe two of them wrongly
      sEl.title = tt(sRep.tip);
      left.appendChild(sEl);
    }
  }
  const modeEl = el('span', 'cs-mode ' + mi.cls); modeEl.title = tt('chat-status.modus') + mi.label;
  modeEl.appendChild(el('span', 'cs-mdot'));
  // Dot-only is fine for the modes that ask before they act. It is NOT an adequate account of "runs
  // every tool without asking": with everything matching the selectors, the left half of the strip
  // collapsed to a single 8px red dot standing where the model name normally is — which reads as
  // something being broken, not as full autonomy being on. For those two modes the label stays even
  // though it repeats the selector; the duplication costs ~57px, the silence costs a surprise.
  if (mode !== selMode || LOUD_MODES.includes(mode)) modeEl.appendChild(el('span', null, mi.label));
  left.appendChild(modeEl);
  // effort read-out — same story: identical to the effort selector unless the running session still
  // carries an older level, which is the only case worth the width
  const selEff = $('#effortSel') ? $('#effortSel').value : '';
  const eff = t.id ? (t.effort || '') : selEff;
  if (eff && eff !== selEff) left.appendChild(el('span', 'cs-effort', '⚡ ' + eff));
  // …and the case the width IS worth even when the two agree: the switch was never confirmed. The CLI
  // reports success for a level it silently ignored, so an unread level is a wish and not a read-out — the
  // same distinction the ultracode chip makes with „unknown" one field over. Without this the doubt lived
  // only in the toast and vanished with it after four seconds.
  else if (t.id && t._effortUnread) {
    const u = el('span', 'cs-effort cs-effort-unread', '⚡ ' + (eff || tt('chat.effortAuto')) + ' ?');
    u.title = tt('chat-status.effortUnbestaetigtTitel');
    left.appendChild(u);
  }
  // A5 — the picked level is not one this model offers. The <option> is disabled and carries the reason,
  // but only while the dropdown is open, so the strip states it as well. Silent until the per-model probe
  // has answered: „not checked yet" must not look like „not possible".
  const badEff = (typeof effortLevelNotInModel === 'function') ? effortLevelNotInModel(t) : '';
  if (badEff) {
    const h = el('span', 'cs-hint', '⚠ ' + badEff);
    h.title = tt('chat.effortNichtImModell').replace('{l}', badEff)
      .replace('{m}', (t._ucSupport && t._ucSupport.model) || tt('chat.ultracodeModellDefault'));
    left.appendChild(h);
  }
  const uc = ultracodeChip(t); if (uc) left.appendChild(uc);    // 🌀 standing dynamic workflows
  const cost = costChip(t); if (cost) left.appendChild(cost);   // session cost/tokens (M19)
  const bud = budgetChip(t); if (bud) left.appendChild(bud);    // PR-13 — the brake's count, agents included
  // grantChips are NOT appended here any more — they piled up in this one line next to model, mode,
  // cwd and cost. They render in the approvals rail (chat-side.js) instead; grantChips() stays the
  // single source for the chip and its revoke click.
  if (typeof chatSideRefresh === 'function') chatSideRefresh();
  // if the selector was changed on a running tab, the picked mode only applies at next start — say so
  if (t.id && $('#permMode') && $('#permMode').value !== (t.permissionMode || 'plan')) {
    const sel = modeInfo($('#permMode').value);
    // the mode name is already on the selector two chips to the right — the news here is the "not yet"
    const h = el('span', 'cs-hint', '↻' + tt('chat-status.abNeustart'));
    h.title = tt('chat-status.derGewaehlteModus') + sel.label + tt('chat-status.giltErstAbDem');
    left.appendChild(h);
  }
  // A deferred restart — an effort/model change, or guardrails/subagents/MCP from the tab menu — is still
  // owed: say what for, and in the tooltip what it is waiting on. „After the turn" alone was not true any
  // more since it also waits for running agents and the queue (CHAT-FLOW-1/5).
  if (t.pendingRunCfg) {
    const p = t.pendingRunCfg, bits = (p._why || []).slice();
    if (p.effort != null) bits.push('⚡ ' + (p.effort || 'default'));
    if (p.model != null) bits.push(shortModel(p.model) || 'default');
    const h = el('span', 'cs-hint', '↻ ' + tt('chat-status.neustartAusstehend') + (bits.length ? ' · ' + bits.join(' · ') : ''));
    // U1 — agents and workflows are counted apart here too: „wartet auf 1 laufende(n) Agenten" for a running
    // workflow was the same „a workflow is one agent" reading as the 🤖 badge (chat-render.js agentLaneCounts).
    const lc = (typeof agentLaneCounts === 'function') ? agentLaneCounts(t)
      : { plainRunning: (t.agents || []).filter((a) => a && a.status === 'running').length, wfRunning: 0 };
    const waits = [];
    if (lc.plainRunning) waits.push(tt('chat-status.wartetAufAgenten').replace('{n}', String(lc.plainRunning)));
    if (lc.wfRunning) waits.push(tt('chat-status.wartetAufWorkflows').replace('{n}', String(lc.wfRunning)));
    if (t.queue && t.queue.length) waits.push(tt('chat-status.wartetAufWarteschlange').replace('{n}', String(t.queue.length)));
    h.title = tt('chat-status.greiftNachDemAktuellen') + (waits.length ? '\n' + waits.join('\n') : '');
    left.appendChild(h);
  }
  // The live slot: pulse dot · phase · timing, ALWAYS present — empty at rest. It has a fixed width
  // (--cs-live-w, statusLiveReserve), so the row's max-content width no longer depends on what the phase
  // says this tick, nor on whether a turn is running. That max-content width is what `flex-wrap` on
  // .chat-status decides by: the selectors drop to a second line when the WHOLE strip would not fit, and
  // „denke nach…" → „läuft mcp__sap-adt__read_source…" → „schreibe…" can no longer flip the layout.
  // (Before, below 720px .cs-left wrapped its own chips, so every phase change reshuffled the rows; and the
  // dot + phase + timing appeared only while streaming, so every turn start and end changed the width.)
  // The phase ellipsises inside the slot; the timing never does, it would be sliced mid-digit.
  const live = el('span', 'cs-live');
  if (t.streaming) {
    live.appendChild(el('span', 'cs-dot'));
    live.appendChild(el('span', 'cs-phase', displayPhase(t)));
    live.appendChild(el('span', 'cs-meta'));
  } else if (live.setAttribute) live.setAttribute('aria-hidden', 'true');
  left.appendChild(live);
  if (t.streaming) renderStatus(); // fill the timing immediately
}
// The width the live slot reserves: the longest FIXED phase of the current language (capped — tool and plan
// phases have no upper bound, they ellipsise), plus the longest timing read-out, plus dot and gaps. Measured
// once per language with the strip's own font and written to --cs-live-w; the stylesheet carries a `ch`
// fallback for when there is no canvas (and for the fake DOM of the unit tests).
const STATUS_PHASE_CAP_CH = 32;
const STATUS_META_TEMPLATE = '(9999s · 💭 999.9k · ↓999.9k tok)';
let STATUS_RESERVE_KEY = '';
function statusLivePhases() {
  return [PHASE_WORKING, PHASE_WRITING, PHASE_THINKING, PHASE_TOOLWORK, WAIT_APPROVAL, ASK_WAIT_PHASE, RECONNECT_PHASE]
    .map((p) => String(phaseLabel(p) || ''));
}
// pure: measure(text) → px is the only thing that touches a font
function statusLiveWidth(measure, phases, metaTemplate, capCh, dotPx, gapPx) {
  const capPx = measure('0'.repeat(capCh));
  const phasePx = Math.min(capPx, Math.max(0, ...phases.map((s) => measure(s))));
  return Math.ceil(dotPx + gapPx + phasePx + gapPx + measure(metaTemplate));
}
function statusLiveReserve(box) {
  try {
    if (!box || !box.style || typeof box.style.setProperty !== 'function') return;
    const cs = getComputedStyle(box);
    const font = cs && cs.font;
    const key = (typeof LANG !== 'undefined' ? LANG : '') + '|' + (font || '');
    if (!font || key === STATUS_RESERVE_KEY) return;
    const ctx = (statusLiveReserve._c = statusLiveReserve._c || document.createElement('canvas')).getContext('2d');
    if (!ctx) return;
    ctx.font = font;
    const gap = parseFloat(cs.columnGap) || 9;
    const w = statusLiveWidth((s) => ctx.measureText(s).width, statusLivePhases(), STATUS_META_TEMPLATE, STATUS_PHASE_CAP_CH, 9, gap);
    if (!(w > 0)) return;
    box.style.setProperty('--cs-live-w', w + 'px');
    STATUS_RESERVE_KEY = key;
  } catch { /* no canvas / no layout: the stylesheet's ch fallback stands */ }
}
// 200ms ticker while streaming: update only the phase + timing text in place (no rebuild → no churn)
function renderStatus() {
  if (!ACTIVE) return;
  // At REST this used to return and do nothing at all, which was right as long as the strip held only
  // numbers that tick. G5's session-state chip broke that: it is shown ONLY at rest, and its payload depends
  // on whether the panel holds a gate of its own (`ownGate`) — so every gate that opens or closes while the
  // tab is idle changes what the chip should say, with nothing to repaint it. The one sentence that justifies
  // the whole derived-not-painted design — „it heals itself at the next 200 ms tick" — did not hold for the
  // chip, because at rest there is no tick. The callers in the gate lifecycle (chat-perms.js) already call
  // this function; so instead of adding repaint calls at each of them, the quiet case repaints the bar here.
  // A full rebuild is affordable exactly because it is the quiet case: no ticker, so this runs on an event,
  // not sixty times a second.
  if (!ACTIVE.streaming) { renderStatusBar(); return; }
  const box = $('#chatStatus');
  const phase = box.querySelector('.cs-phase'), meta = box.querySelector('.cs-meta');
  if (!phase || !meta) { renderStatusBar(); return; }
  const secs = ((Date.now() - ACTIVE.turnStart) / 1000).toFixed(0);
  const toks = (ACTIVE.tokenBase || 0) + (ACTIVE.tokenLive || 0);
  // A2 — the CLI's own thinking estimate (system/thinking_tokens). It rides along in this tick because
  // the frame arrives dozens of times per turn and the whole point of this function is to write numbers
  // in place instead of repainting. On a high effort level it is the difference between „still thinking"
  // and „hung": both look identical for minutes without it.
  const think = ACTIVE.thinkTokens || 0;
  phase.textContent = displayPhase(ACTIVE);
  meta.textContent = '(' + secs + 's' + (think ? ' · 💭 ' + fmtNum(think) : '') + (toks ? ' · ↓' + fmtNum(toks) + ' tok' : '') + ')'; // effort now shown by the ⚡ chip (was duplicated here)
  // CTX-2 — the context gauge rides along on this tick. The `assistant` frames write `ctxTokens` without
  // repainting anything, so the line sat frozen at the value the last `result` had left for as long as the
  // turn ran (the report: one turn, over an hour, „250 %" the whole time). This is the right place for it:
  // the function exists to write live numbers without rebuilding the strip, and ctxGaugeTick repaints only
  // when the value actually changed — updateCtxGauge rebuilds its element, so an unchanged tick must not.
  if (typeof ctxGaugeTick === 'function') ctxGaugeTick(ACTIVE);
}
function startTurnStatus() { // status bar shows the ACTIVE tab only
  if (chat !== ACTIVE) return;
  renderStatusBar();
  clearInterval(STATUS_TIMER); STATUS_TIMER = setInterval(renderStatus, 200);
}
function stopTurnStatus() {
  clearInterval(STATUS_TIMER); STATUS_TIMER = null;
  renderStatusBar(); // repaint the idle strip (model + mode stay visible)
}
function setPhase(p) { chat.phase = p; } // the 200ms interval renders — avoids per-token DOM churn

