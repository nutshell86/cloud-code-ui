// Part of the Claude Code Control Panel front-end (split from app.js).
// Classic scripts share one global scope; load order in index.html is authoritative: render → chat → sessions → views → commands → boot.
// This file: chat-composer.js

// --- composer prompt history (↑/↓ recall, like a shell) ---
let PROMPT_HISTORY = []; try { PROMPT_HISTORY = JSON.parse(localStorage.getItem('cc_prompt_history') || '[]'); } catch {}
let HIST_IDX = -1, HIST_DRAFT = '';
// the 100-entry list is stringified + written synchronously on every send → debounce it, and flush on unload
// so nothing is lost when the page goes away inside the window (P6)
const _flushHistory = () => { try { localStorage.setItem('cc_prompt_history', JSON.stringify(PROMPT_HISTORY)); } catch {} };
const _saveHistoryDebounced = debounce(_flushHistory, 800);
window.addEventListener('beforeunload', _flushHistory);
function pushHistory(text, tab) {
  if (!text) return;
  PROMPT_HISTORY = PROMPT_HISTORY.filter((x) => x !== text); PROMPT_HISTORY.push(text);
  if (PROMPT_HISTORY.length > 100) PROMPT_HISTORY.shift();
  _saveHistoryDebounced(); HIST_IDX = -1;
  // …and into the SERVER-side history (A13). This local list is 100 entries in one browser's
  // localStorage; the store behind /api/prompt-history is searchable, survives a cleared profile and is
  // shown next to the CLI's own terminal history in the 🕘 overlay. Recorded HERE because the only
  // caller is the human-typed path (`fromComposer`) — quick replies, retries and UI-skill runs do not
  // pass through, which is exactly the filter a prompt history wants. Fire-and-forget: a failed record
  // must never hold up the send.
  try {
    api('/api/prompt-history', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        cwd: (tab && tab.cwd) || ($('#cwdInput') && $('#cwdInput').value) || '',
        sessionId: (tab && tab.sessionId) || '',
        model: (tab && (tab.model || tab.modelSel)) || '',
      }),
    }).catch(() => {});
  } catch { /* older server without the route */ }
}
function historyRecall(dir) { // dir -1 = older, +1 = newer
  const inp = $('#composerInput');
  if (!PROMPT_HISTORY.length) return false;
  if (HIST_IDX === -1) { if (dir > 0) return false; HIST_DRAFT = inp.value; HIST_IDX = PROMPT_HISTORY.length; }
  HIST_IDX += dir;
  if (HIST_IDX >= PROMPT_HISTORY.length) { HIST_IDX = -1; inp.value = HIST_DRAFT; autoGrow(); return true; }
  if (HIST_IDX < 0) HIST_IDX = 0;
  inp.value = PROMPT_HISTORY[HIST_IDX]; autoGrow();
  try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch {}
  return true;
}

// the composer's post-send reset — was copy-pasted at three return paths (and drifted)
function resetComposer() {
  const inp = $('#composerInput');
  inp.value = ''; autoGrow(); clearAttachments(); clearEditing(); hideSlash(); hideAt(); clearDraft();
  planChipReset(ACTIVE); // the chip's „aus" belonged to the message that just went (PF-1b)
}
// Make sure `tab` has a live CLI process, WITHOUT ever forking a second one.
async function ensureChatStarted(tab) {
  // a deferred restart whose wait is over (nothing live any more) goes BEFORE this message — otherwise the
  // message would start a new turn on the old config and push the restart back once more
  if (tab.id && typeof pendingRunCfgReady === 'function' && pendingRunCfgReady(tab)) { await restartResume(tab, {}); return; }
  if (tab.id) return;
  await whenResumeSettled(tab); // a dormant tab may already be resuming — let it finish, don't fork a 2nd process
  if (tab.id) return;
  // CHAT-FLOW-4 — another tab or window holds this session. A resume here would be refused anyway, but only
  // AFTER startChat had emptied the transcript (card included) and set „◌ startet…" — so the takeover is offered
  // first, with its warning; declined, the message does not go out and the composer keeps it (heldElsewhereError).
  if (typeof tabHeldElsewhere === 'function' && tabHeldElsewhere(tab)) {
    if (await takeBackTab(tab)) return;
    throw heldElsewhereError();
  }
  // a restored/dormant tab (or one whose process exited) still points at a REAL session → RESUME it,
  // don't spawn a fresh empty one. Otherwise a typed /clear→"(no content)" and /compact→"Not enough
  // messages to compact" run against an empty session while the ctx gauge still shows the old one (ToDo 09).
  if (tab.sessionId || (tab.pending && tab.pending.sessionId)) {
    if (tab.pending) { tab.sessionId = tab.sessionId || tab.pending.sessionId; tab.cwd = tab.cwd || tab.pending.cwd; tab.pending = null; }
    await restartResume(tab, {});
  } else await startChat({}, tab);
}
// Send the composer's content — or an explicit { text, attachments, tab, supersede }, in which case the
// composer is NOT touched, so a half-written draft survives a quick reply, a retry or an edit-resend
// (C7/C9/C11). Everything (ask-gate answer, queueing while streaming, dead-chat recovery) is shared.
// PF-1b — `planMsg`: a message the panel built for the plan (▶ Plan starten, 📋 Schritte anfordern, [Stand abfragen])
// — never a card's answer, and in the queue a standalone entry (queue-merge.js queueItemMergeable). The composer chip
// „📋 Plan-Fortschritt mitsenden" applies to what is TYPED only — not to an explicit text (a quick reply, a retry).
async function sendMessage(opts) {
  opts = opts || {};
  const inp = $('#composerInput');
  const fromComposer = opts.text == null;
  const target = opts.tab || chat;
  const text = String(fromComposer ? inp.value : opts.text).trim();
  const attachments = (fromComposer ? attachmentsOf(target) : (opts.attachments || [])).slice();
  if (!text && !attachments.length) return;
  // local-only command: /diff opens the working-copy diff viewer (never sent to the CLI) (ToDo 03)
  if (text === '/diff') { if (fromComposer) resetComposer(); openDiffViewer((target && target.cwd) || ($('#cwdInput') && $('#cwdInput').value) || ''); return; }
  if (DISPLAY.guard && text) {
    const hits = scanSensitive(text);
    if (hits.length && !(await uiConfirm(tt('chat-composer.moeglicherweiseSensibleDatenErkannt') + hits.join(', ') + tt('chat-composer.richtlinieKeinePersonenbezogenen'), { title: '⚠ ' + tt('chat-composer.sensibleDaten'), danger: true, okLabel: tt('chat-composer.trotzdemSenden') }))) return;
  }
  if (text && fromComposer) pushHistory(text, target); // quick replies/retries would only pollute the ↑-history
  // The composer's text goes out → the dictation that wrote it ends here (Sergej, Nachtrag): left running, it wrote
  // its next segment into the empty field of the NEXT message. Only for a send FROM the composer — a plan request or
  // a quick reply the panel sends by itself must not cut off someone who is still dictating.
  if (fromComposer && typeof stopVoiceInput === 'function') stopVoiceInput();
  // An open QUESTION card takes a typed reply as its answer — but visibly now (CHAT-FLOW-6): the chip above
  // the composer says so before you send (its × routes the text into the queue instead), and the answer
  // shows up as your own message, not only as „→ …" inside the card. Files can't ride on a card answer,
  // so a message with attachments queues. A PLAN card is never answered from here: a side remark used to
  // reject the plan silently („weiter planen + Text"). Typed text queues; the card's own buttons decide.
  // Which card takes the text is the chip's predicate too (typedReplyCard): a HELD gate, whether or not
  // the tab is streaming — a FLOW-3 follow-up turn blocks at its gate with streaming=false (CHAT-FLOW-9).
  // A typed COMMAND is never a card answer (the text goes in, so the predicate can tell): /clear as an
  // answer reached the model as the literal string and left the session (and the ctx gauge) untouched.
  const open = (text && !opts.planMsg) ? typedReplyCard(target, attachments, text) : null;
  if (open) {
    if (fromComposer) resetComposer();
    const bubble = withTab(target, () => addMsg('user', text, { midTurn: true })).m;
    // A gate reply can fail (postGateReply then re-arms the card). Without this the bubble kept standing as
    // if the answer had gone out, while the composer was already cleared — so the text existed nowhere else,
    // exactly the hole markSendFailed was written for. `quiet`: postGateReply has already toasted the reason.
    submitGroup(open.g.group, text, open.toolId, text, (err) => { if (err) markSendFailed(target, bubble, text, attachments, err, { quiet: true }); });
    return;
  }
  // A turn is still running in this tab → queue the message and flush it when the turn ends (like the console).
  // A HELD gate counts as running (hasHeldGate, chat-render.js): the CLI is blocked inside can_use_tool, and
  // the follow-up turn it starts by itself runs with `streaming` false (FLOW-3) — so without this the × on the
  // ask-route chip („Getipptes stattdessen einreihen") posted the text via /send into a turn that cannot take
  // it, i.e. the chip promised one thing and something else happened. Queued, the text rides along with the
  // card's answer ([Mit Antwort senden]) or flushes on the next `result`.
  // flushQueue does NOT come through here (it calls deliverText directly), so the queue can't feed itself.
  // PF-1b — the chip's attachment from here on: what goes OUT is the typed text plus the step list and the
  // protocol (`out`); history, title, the sensitive-data guard and the open points read what was typed (`text`).
  const att = fromComposer ? planChipAttachment(target, text) : '';
  const out = att ? (text ? text + '\n\n' + att : att) : text;
  // Whatever moves the plan when it goes out is a plan message, however it got here — a start or a keep the reader
  // typed, pasted back or re-sent („erneut senden") as well: queued as an ordinary entry it could be merged („1. … 2.
  // Bitte den Plan noch nicht …") or ridden into a card's answer, and then it no longer moved what it promised to.
  const kind = typeof planOutgoingKind === 'function' ? planOutgoingKind(out) : '';
  const planMsg = !!(opts.planMsg || att || kind);
  if (target.streaming || hasHeldGate(target)) {
    // a start remembers which proposal it was built for (planFor), and the chip's what was typed (planTyped) — at the
    // flush a newer proposal may lie on the table (chat-side.js planQueuedStale)
    enqueueMessage(target, out, attachments, { plan: planMsg, planFor: (kind && typeof planStartTargetId === 'function') ? planStartTargetId(target) : '', planTyped: att ? text : null });
    if (fromComposer) resetComposer();
    // „Send now": the CLI gained a key for this (ctrl+enter, 2.1.275) — stop what is running and take
    // THIS instead. No second send path is needed for it: the queue already flushes on the `result`
    // frame, and an interrupt produces one. So the message is queued exactly as above and the turn is
    // cut short; it goes out a moment later, in order, through the same code as every other message.
    // keepQueue: the interrupt must not clear the queue this very message was just put in (CHAT-FLOW-9)
    if (opts.interrupt && typeof interruptTab === 'function') interruptTab(target, { keepQueue: true });
    return;
  }
  // Answering an open point in the chat closes it. The rail hands the question to the composer, so the
  // sent text quotes it; a reply that is exactly one of the ready-made options counts too. Placed after
  // the ASK_GATES return (a gate reply answers the gate, not a point), after the sensitive-data guard (an
  // aborted send leaves the rail untouched) and after the queue: a queued message is matched when it really
  // goes out (flushQueue), it may yet be removed or discarded (F8).
  if (text && typeof openPointsAnswerFrom === 'function') openPointsAnswerFrom(target, text);
  const tab = target; // capture the send target: the resume/restart awaits below let the ACTIVE tab change under us
  let sent = null;
  try {
    await ensureChatStarted(tab);
    if (text && isDefaultTitle(tab)) setTabTitle(tab, text);
    // the message this send REPLACES — from the edit chip, or explicitly (retry of a superseding send)
    const replaced = opts.supersede || (fromComposer && EDIT_TARGET && EDIT_TARGET.tab === tab ? EDIT_TARGET.node : null);
    if (replaced) supersedeFrom(tab, replaced); // dim the original + everything after it (C11)
    staleQuickReplies(tab);                     // older quick-reply chips are answered/obsolete now (C9)
    // the answer to a question the queue was holding back for goes out first; the queue follows on the
    // next result as usual (and may pause again there, CHAT-FLOW-7)
    if (tab.queuePaused) { tab.queuePaused = false; if (tab === ACTIVE) renderQueueStrip(); renderTabs(); }
    sent = withTab(tab, () => addMsg('user', out, { attachments })).m;
    // Remember what went out, so a turn that dies afterwards (process exit / _error) can offer
    // "erneut senden" instead of leaving you to retype it — see addTurnError() in chat-render.js (B2).
    tab._lastSent = { text: out, attachments };
    if (fromComposer) resetComposer();
    withTab(tab, () => setComposerBusy(true));
    markCtxOp(tab, out); // /clear · /compact drain the ctx bar and get their own result footer
    markTypedModel(tab, out); // /model <arg> → a pending switch the next frame has to confirm
    // a start (▶, the chip) begins the plan HERE, where the message goes out — and where the fold will read it
    const started = typeof planNoteOutgoing === 'function' ? planNoteOutgoing(tab, out) : '';
    const ok = await deliverText(tab, out, attachments, sent);
    if (started && typeof planOutgoingSettled === 'function') planOutgoingSettled(tab, started, ok);
  } catch (e) { markSendFailed(tab, sent, out, attachments, e); }
}
// One POST of a message, plus the single transparent recovery for a chat the server reaped while it sat idle
// (e.g. laptop sleep): resume the session and resend ONCE, instead of surfacing "chat not found" and forcing a
// close+reopen (ToDo 02/06). Every other failure lands on markSendFailed.
// → true once the message is delivered, false when it is not (markSendFailed has said so) — a start by message
// needs to know (planOutgoingSettled): one that never reached the CLI must not stand in the rail as underway.
async function deliverText(tab, text, attachments, node) {
  const post = () => api('/api/chat/' + tab.id + '/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, attachments }) });
  // CHAT-FLOW-4 — a tab another tab or window holds has no process to post to (its id is gone): the queue it
  // kept ([Jetzt senden]) lands here. And a POST that finds its chat gone may have raced the `_superseded`
  // frame — then the chat is not dead but TAKEN, and resuming it the automatic way would empty this transcript
  // only to meet the owner's 409. Both go through the takeover offer instead.
  const held = () => typeof tabHeldElsewhere === 'function' && tabHeldElsewhere(tab);
  if (tab.id || !held()) {
    try { await post(); return true; }
    catch (e) {
      const dead = /chat not found|process not running/i.test(String(e.message || e));
      if (!dead || !(tab.sessionId || (tab.pending && tab.pending.sessionId))) { markSendFailed(tab, node, text, attachments, e); return false; }
      tab.id = null;
    }
  }
  if (tab.pending) { tab.sessionId = tab.sessionId || tab.pending.sessionId; tab.cwd = tab.cwd || tab.pending.cwd; tab.pending = null; }
  // A resume that met the owner's 409 has taken the bubble down with the transcript (startChat empties it before
  // its POST; the card is all that is left) — and the composer was cleared on send, so the bubble was the only copy
  // of the text. That happens when this tab never got `_superseded` (its stream hung in a reconnect gap when the
  // other window took the session), so held() was false and the automatic resume ran. Put back below the card.
  const putBack = () => { if (node && !node.isConnected) node = withTab(tab, () => addMsg('user', text, { attachments })).m; };
  try {
    // declined: nothing was torn down, the bubble is still there and says it did not go out; refused again
    // (nobody held it at the probe, somebody did at the start): the bubble comes back below the card
    if (held()) { if (!(await takeBackTab(tab))) { putBack(); markSendFailed(tab, node, text, attachments, heldElsewhereError()); return false; } }
    else await restartResume(tab, {}); // re-attach the session + repaint history (this clears the just-added user bubble)
    node = withTab(tab, () => addMsg('user', text, { attachments })).m; // re-append it below the history
    // the resume adopted the transcript's plan, and the transcript does not hold this message yet: a start it
    // carries is applied again (a no-op when the plan is already underway — planNoteOutgoing finds no proposal)
    if (typeof planNoteOutgoing === 'function') planNoteOutgoing(tab, text);
    withTab(tab, () => setComposerBusy(true));
    // …and a /model is pending AGAIN: the restart dropped it (startChat → retireTypedModel, right for a process
    // that is gone), but this text is about to reach the NEW process, which will switch on it. Without the re-mark
    // the panel never noticed that switch — the selection stayed on the old model while the CLI ran the new one.
    // Same for a takeover: that, too, is a new process receiving this text.
    markTypedModel(tab, text);
    await post();
    return true;
  } catch (e2) { if (e2 && e2.code === 'session-open-elsewhere') putBack(); markSendFailed(tab, node, text, attachments, e2); return false; }
}
// A failed send used to leave a bubble that looked delivered: the composer was already cleared, so the text
// existed nowhere but in that bubble, and the only signal was a 4 s toast. Now the bubble itself says it
// didn't go out and offers a retry that resends the CAPTURED text + attachments (C3).
// opts.quiet: the caller has already said what went wrong (a failed gate reply toasts in postGateReply) —
// only the bubble still needs fixing, and two toasts for one failure read like two failures.
function markSendFailed(tab, node, text, attachments, err, opts) {
  // PR-13 — the server's tripped cost brake refuses new turns with `budget-reached`; the raw code would
  // say nothing about the way out (a new budget is a launch flag: tab menu → restart).
  const raw = String((err && err.message) || err || '');
  const msg = /budget-reached/.test(raw) ? tt('chat-composer.budgetErreicht') : raw;
  if (!(opts && opts.quiet)) toast(msg || tt('chat-composer.sendenFehlgeschlagen'), 'err');
  withTab(tab, () => setComposerBusy(false));
  // a /model that never reached the CLI is no pending switch — the next frame would otherwise „reject" it
  if (tab && tab._modelPending && typeof ctxTypedModelArg === 'function' && ctxTypedModelArg(text) === tab._modelPending.arg) tab._modelPending = null;
  if (!node || !node.isConnected || node.querySelector('.send-failed-row')) return;
  node.classList.add('send-failed');
  const row = el('div', 'send-failed-row');
  // a send held back because the session is elsewhere (heldElsewhereError) toasts „Nicht gesendet — …"; the row
  // already begins with „Nicht gesendet", so it gets the reason alone instead of saying it twice (CHAT-FLOW-4)
  const why = err && err.code === 'session-open-elsewhere' ? tt('render.sitzungAnderswoOffen') : msg;
  row.appendChild(el('span', 'sf-msg', '⚠ ' + tt('chat-composer.nichtGesendet') + (why ? ' · ' + why : '')));
  const again = el('button', 'sf-retry', '↻ ' + tt('chat-composer.erneutSenden'));
  again.onclick = () => { node.remove(); sendMessage({ text, attachments, tab }); };
  const drop = el('button', 'sf-drop', tt('chat-composer.verwerfen'));
  drop.title = tt('chat-composer.nachrichtVerwerfen');
  drop.onclick = () => node.remove();
  const back = el('button', 'sf-back', tt('chat-composer.zurueckInDenComposer'));
  back.onclick = () => { node.remove(); composerSet(text, tt('chat-composer.wiederhergestellt')); };
  row.appendChild(again); row.appendChild(back); row.appendChild(drop);
  node.appendChild(row);
  if (tab === ACTIVE) scrollBottom();
}

// --- message queue (type-ahead while a turn is running, flushed on result) ---
// A queued message used to be appended to the TRANSCRIPT the moment it was typed — so it sat ABOVE the answer
// it was waiting for, and stayed in that wrong order forever (exports included). Queued items now live as chips
// in the strip above the composer and only enter the transcript at flush time, in send order. (C2/C20)
// A /clear or /compact is not an ordinary message: the ctx gauge runs its forward progress bar while it
// works, and the result footer says „Kontext geleert/kompaktiert" instead of reading like a 0-token turn.
// One truth for that, because BOTH the immediate send and the queued one have to do it — a queued
// /compact used to flush without any of it, so the gauge kept the old value and the footer looked empty.
// The drain paints the single global gauge, so only the visible tab may start it.
const CTX_COMMANDS = { '/clear': 'clear', '/compact': 'compact' };
function markCtxOp(tab, text) {
  const op = CTX_COMMANDS[text];
  if (!op) return;
  tab._ctxOp = op;
  if (tab === ACTIVE && typeof startCtxDrain === 'function') startCtxDrain(op);
}
// …and a typed „/model <arg>" (05.10.) is not an ordinary message either: the CLI switches the session's model
// on it, and nothing in the panel used to notice — `tab.modelSel` stayed on the old model, the frames named the
// new one, and the context line went to „–" (ctx.js ctxTypedModelArg). It is remembered here as a PENDING switch,
// at the same two places as the ctx ops (the immediate send and the queue flush), i.e. when the text really goes
// out — a queued /model that is removed again never reaches this. Taken over only once the CLI confirms it
// (chat-events.js settleTypedModel); until then the context decision treats the variant as unknown, so nothing
// is filed under the old selector's key in between. „/model" without an argument opens the CLI's own picker:
// nothing to adopt, nothing remembered.
function markTypedModel(tab, text) {
  const arg = (typeof ctxTypedModelArg === 'function') ? ctxTypedModelArg(text) : '';
  if (!arg || !tab) return;
  tab._modelPending = { arg, from: tab.model || '', at: Date.now(), sawResult: false };
  if (tab === ACTIVE && typeof updateCtxGauge === 'function') updateCtxGauge(tab);
}
function enqueueMessage(tab, text, attachments, extra) {
  tab.queue = tab.queue || [];
  const item = { text, attachments: attachments || [], queuedAt: Date.now() };
  if (extra && extra.plan) item.plan = true; // the panel's plan message: standalone in the queue (queueItemMergeable)
  if (extra && extra.planFor) item.planFor = extra.planFor;               // the proposal a start was built for
  if (extra && typeof extra.planTyped === 'string') item.planTyped = extra.planTyped; // the chip's: what was typed
  tab.queue.push(item);
  tab._queueUndo = null; // a new entry ends the undo window of an earlier merge (it wasn't part of it)
  if (tab === ACTIVE) { renderQueueStrip(); toast(tt('chat-composer.inWarteschlange') + tab.queue.length + ')', 'ok'); }
  renderTabs(); // a background tab shows its queue length on the tab
  if (typeof planQueueNoted === 'function') planQueueNoted(tab); // a queued start: ▶ → „startet nach diesem Turn"
}
const QUEUE_CMD_GLYPH = { '/clear': '🧹', '/compact': '⚙', '/handoff': '📝' };
// The card (question or plan) of `tab` that is waiting for an answer right now, or null.
function openCardOf(tab) {
  for (const [toolId, g] of ASK_GATES) if (g.tab === tab && g.group && !g.group._done) return { toolId, g };
  return null;
}
// The open QUESTION card a typed reply would answer — unless its chip's × sent replies to the queue.
function askRouteOf(tab) {
  const c = openCardOf(tab);
  return c && !c.g.isPlan && tab._askBypass !== c.toolId ? c : null;
}
// …and the one that really takes it: same card, but only once its gate is held, while no files are attached
// and for text that is not a command (cardTakesTypedText, queue-merge.js). sendMessage routes by it and the
// chip announces by it, so the chip can't promise „beantwortet" for a text that then goes out as an
// ordinary message. `text` is what is about to be sent — the composer's content for the chip.
function typedReplyCard(tab, attachments, text) {
  const c = tab ? askRouteOf(tab) : null;
  return c && cardTakesTypedText(c, attachments, text) ? c : null;
}
// what the composer holds right now — the chip has to judge the text you are looking at, not an empty one
function composerText() { const i = $('#composerInput'); return i ? i.value : ''; }
let _routeTextCmd = false; // was the composer holding a command when the strip was last painted? (input listener)
function renderQueueStrip() {
  const box = $('#chatQueue'); if (!box) return;
  renderPlanChip(); // a card opening or closing shows or hides the plan chip (PF-1b)
  // Stop appears and disappears with a held gate too, and that gate changes in exactly the moments that
  // bring us here (card rendered · gate arrived · answered · dropped · tab switched) — chat-render.js
  if (typeof refreshInterruptBtn === 'function') refreshInterruptBtn();
  const tab = ACTIVE;
  const q = (tab && tab.queue) || [];
  const typed = composerText();
  _routeTextCmd = queueTextIsCommand(typed);
  const route = tab ? typedReplyCard(tab, attachmentsOf(tab), typed) : null;
  if (!q.length && !route) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.innerHTML = '';
  if (route) box.appendChild(askRouteChip(tab, route));
  if (!q.length) { box.classList.remove('hidden'); return; }
  box.appendChild(el('span', 'cq-head', (tab.queuePaused ? '⏸ ' : '⏳ ') + tt('chat-composer.warteschlange') + ' (' + q.length + ')'));
  renderQueueStateBtns(box, tab);
  renderQueueMergeBtn(box, q);
  const live = queueInjectLive(tab);
  renderQueueInjectBtn(box, tab, live);
  q.forEach((item) => {
    const chip = el('div', 'cq-chip');
    // A merged chip is previewed from its PARTS, not from its composed text: that starts with the head line
    // („Mehrere Anliegen…"), so the 60 visible characters would be spent on a label that is the same for
    // every merged chip instead of on what is actually waiting.
    const parts = queueItemParts(item);
    const oneLine = (parts.length > 1 ? parts.join(' · ') : String(item.text || '')).replace(/\s+/g, ' ').trim();
    // A waiting command is not the same kind of thing as a waiting sentence: it acts on the session
    // itself, and /clear does so irreversibly. Mark those so the row can be read at a glance instead of
    // hunting for a slash in a line of grey text — that is the whole point of queueing them visibly.
    const glyph = QUEUE_CMD_GLYPH[oneLine];
    if (glyph) { chip.classList.add('cq-cmd'); if (oneLine === '/clear') chip.classList.add('cq-cmd-danger'); }
    // The text is the way to EDIT the entry (it used to be removable only): a click opens it in a dialog, in place —
    // the entry keeps its position. A plan entry of the panel is read back by its shape, so it is not editable.
    const txt = el('button', 'cq-txt', glyph ? glyph + ' ' + oneLine
      : oneLine ? (oneLine.length > 60 ? oneLine.slice(0, 58) + '…' : oneLine) : '📎');
    txt.type = 'button';
    if (item.plan || item.planFor) inertBtn(txt, tt('chat-composer.planNichtBearbeitbar'));
    else txt.onclick = () => editQueued(ACTIVE, item);
    chip.appendChild(txt);
    if (item.attachments && item.attachments.length) chip.appendChild(el('span', 'cq-att', '📎' + item.attachments.length));
    // a merged chip says how many messages are inside it — otherwise the merge is invisible except for a
    // shorter row, and the (truncated) text of the first entry looks like the whole thing
    const count = queueMergeCount(item);
    if (count > 1) { const n = el('span', 'cq-n', '⧉' + count); n.title = count + tt('chat-composer.nachrichtenZusammengefasst'); chip.appendChild(n); }
    chip.title = (count > 1 ? String(item.text || '') : oneLine) + '\n\n' + tt('chat-composer.klickenZumBearbeiten'); // hover a merged chip = the message as it will go out
    if (live && queueItemInjectable(item)) {
      const inj = el('button', 'cq-inj', '↪'); inj.type = 'button';
      inj.title = tt('chat-composer.einspeisenEinerTitel');
      inj.setAttribute('aria-label', inj.title);
      inj.onclick = () => injectQueued(ACTIVE, [item]);
      chip.appendChild(inj);
    }
    const x = el('button', 'cq-x'); x.type = 'button'; x.innerHTML = ic('close', 11);
    x.title = tt('chat-composer.ausDerWarteschlangeEntfernen');
    x.onclick = () => { const tab = ACTIVE; const i = tab.queue.indexOf(item); if (i >= 0) tab.queue.splice(i, 1); tab._queueUndo = null; queueChanged(tab); };
    chip.appendChild(x);
    box.appendChild(chip);
  });
  box.classList.remove('hidden');
}
// „↳ beantwortet: <Frage>" — typing while a question card is open answers it. That used to happen without
// a word; now the chip says so before you send, and its × makes the next replies queue instead (the card
// stays open and keeps its own buttons and free-text field).
function askRouteChip(tab, route) {
  const chip = el('div', 'cq-chip cq-route');
  const q = route.g.group.querySelector('.opt-q');
  const label = String((q && q.textContent) || tt('chat-render.frage')).replace(/\s+/g, ' ').trim();
  chip.appendChild(el('span', 'cq-txt', '↳ ' + tt('chat-composer.beantwortet') + ' ' + (label.length > 48 ? label.slice(0, 46) + '…' : label)));
  chip.title = tt('chat-composer.beantwortetTitel');
  chip.onclick = (e) => { if (e.target.closest('.cq-x')) return; if (route.g.group.isConnected) { route.g.group.scrollIntoView({ block: 'center', behavior: 'smooth' }); flashEl(route.g.group); } };
  const x = el('button', 'cq-x'); x.type = 'button'; x.innerHTML = ic('close', 11);
  x.title = tt('chat-composer.stattdessenEinreihen');
  x.onclick = () => { tab._askBypass = route.toolId; renderQueueStrip(); };
  chip.appendChild(x);
  return chip;
}
function flashEl(node) { node.classList.add('flash'); setTimeout(() => node.classList.remove('flash'), 1200); }
// A queue button that can do nothing right now explains WHY instead of vanishing — but `disabled` + `title`
// never delivered that explanation: Chromium dispatches no mouse events on a disabled control, so the native
// tooltip does not open, and on a touch screen a tooltip says nothing at all. So the button stays a real,
// focusable button that only LOOKS and BEHAVES inert (aria-disabled + the same :disabled styling, styles.css)
// and answers a click — mouse, touch or Enter — with the reason as a toast. 'warn', not 'err': nothing failed,
// there is simply nothing to do yet. Three callers below share this; none of them wires up its action.
function inertBtn(b, reason) {
  b.setAttribute('aria-disabled', 'true');
  b.title = reason;
  b.onclick = () => toast(reason, 'warn');
  return b;
}
// What the queue is waiting for, and the one action that ends the wait:
//  · a card is open → „wartet auf deine Antwort" + [Mit Antwort senden]. In a planning round (question →
//    answer → question → ExitPlanMode → „weiter planen") no `result` comes, so a queue that only flushes on
//    `result` would sit there until Claude ends the turn by itself; the button hands it over WITH the answer.
//  · paused because Claude asked (CHAT-FLOW-7) → „angehalten – Claude hat gefragt" + [Jetzt senden];
//    held after a resume that sent nothing (queuePaused === 'resume', holdQueueAfterResume) → same button.
function renderQueueStateBtns(box, tab) {
  const card = openCardOf(tab);
  // A QUESTION is answerable only through its held gate. Until the gate arrives the answer would turn into an
  // ordinary message instead (submitGroup's fallback), so the button waits for it — the control_request
  // repaints the strip. A plan card keeps working without a gate: finalizePlan stashes the decision.
  const held = !!card && (card.g.isPlan || !!card.g.requestId);
  if (card) {
    box.appendChild(el('span', 'cq-state', tt('chat-composer.wartetAufAntwort')));
    const take = queueTakeLeadingText(tab.queue).take.length;
    const b = el('button', 'cq-act', '↳ ' + tt('chat-composer.mitAntwortSenden'));
    b.type = 'button';
    if (!held) inertBtn(b, tt('chat-composer.mitAntwortSendenKeinGate'));
    else if (take) { b.title = tt('chat-composer.mitAntwortSendenTitel').replace('{n}', String(take)); b.onclick = () => sendQueueWithCard(tab); }
    else inertBtn(b, tt('chat-composer.mitAntwortSendenNicht'));
    box.appendChild(b);
    // a question without a gate blocks no turn — if the queue is paused meanwhile, [Jetzt senden] must stay
    // reachable, or a disabled button would be the only way out of the pause
    if (held || !tab.queuePaused) return;
  }
  if (!tab.queuePaused) return;
  // CHAT-FLOW-4 — held because another tab or window took the session (supersedeTab): the button goes through
  // deliverText, which asks about the takeover before anything is sent, so its title says that
  const resumed = tab.queuePaused === 'resume', elsewhere = tab.queuePaused === 'elsewhere';
  box.appendChild(el('span', 'cq-state', queueWaitText(tab)));
  const b = el('button', 'cq-act', '▶ ' + tt('chat-composer.jetztSenden'));
  // CHAT-FLOW-3 — a pause can now meet a running turn: result#0 pauses the queue (Claude asked), then the CLI's
  // own follow-up turn is adopted as streaming. The button used to return silently then („nothing is running to
  // cut short" no longer held). Now it does what Strg+Enter does — stop, and the stop's `result` sends the queue
  // (keepQueue) — and its title says so. The strip is repainted when such a turn is adopted (chat-events.js).
  const busy = !!tab.streaming && typeof interruptTab === 'function';
  b.type = 'button'; b.title = busy ? tt('chat-composer.jetztSendenTitelLaufend') : resumed ? tt('chat-composer.jetztSendenTitelFortgesetzt') : elsewhere ? tt('chat-composer.jetztSendenTitelAnderswo') : tt('chat-composer.jetztSendenTitel');
  b.onclick = () => { if (tab.streaming) { if (typeof interruptTab === 'function') interruptTab(tab, { keepQueue: true }); return; } flushQueue(tab); };
  box.appendChild(b);
}
// [Mit Antwort senden] — the leading plain-text entries go out together with whatever the card already
// holds (picked options / free text for a question, the feedback field for a plan) as ONE answer, shown
// as your own message; the queue keeps only what can't ride along (files, commands).
// The taken entries leave the queue at once (a second click must not send them twice) but are kept here
// until the POST that carries them settles: a failed reply used to lose them — the queue already had them
// out, the bubble looked delivered. Now they go back to the FRONT, before healDeadChat resumes a reaped
// chat (a resume keeps the queue, holdQueueAfterResume shows [Jetzt senden] for it).
function sendQueueWithCard(tab) {
  const card = openCardOf(tab); if (!card) return;
  if (!card.g.isPlan && !card.g.requestId) return; // a question answers through its held gate only (the button says so)
  const group = card.g.group;
  const ff = group.querySelector('.opt-ff-input');
  const own = [];
  if (!card.g.isPlan && typeof group._picked === 'function') { const p = group._picked(); if (p) own.push(p); }
  if (ff && ff.value.trim()) own.push(ff.value.trim());
  const out = queueCardAnswer(tab.queue, own, { head: tt('chat-composer.mehrereAnliegen'), prefix: card.g.isPlan ? tt('chat-render.bitteDenPlanNoch') : '' });
  if (!out) return;
  tab.queue = out.rest; tab._queueUndo = null;
  const bubble = withTab(tab, () => addMsg('user', out.text, { midTurn: true })).m;
  const settle = (err) => {
    // delivered → only now do the entries answer open points (as in flushQueue, F8): a failed one answered nothing
    if (!err) { if (typeof openPointsAnswerFrom === 'function') openPointsAnswerFrom(tab, out.answer, out.queuedAt); return; }
    if (bubble && bubble.isConnected) bubble.remove();
    tab.queue = queueRestoreTaken(tab.queue, out.take);
    queueChanged(tab);
    toast(tt('chat-composer.mitAntwortZurueck').replace('{n}', String(out.take.length)), 'err');
  };
  if (card.g.isPlan) finalizePlan(group, card.toolId, 'deny', out.gate, '→ ' + tt('chat-perms.weiterPlanen') + ' · ' + tt('chat-composer.mitWarteschlange'), settle);
  else submitGroup(group, out.text, card.toolId, tt('chat-render.antwortGesendet'), settle);
  queueChanged(tab);
}
// „Alles zusammenfassen" — right at the front of the ⏳ badge, because that is where the count that makes
// you want it is. It collapses consecutive queued messages into ONE numbered message (see queue-merge.js:
// the queue flushes one entry per turn, so three follow-ups otherwise cost three turns and each answer is
// written without knowing the next question). Commands stay standalone; nothing is reordered. Merging is
// lossy for the boundaries between the messages, so the pre-merge queue is kept for a one-click undo.
function renderQueueMergeBtn(box, q) {
  if (q.length >= QUEUE_MERGE_MIN) {
    const gain = queueMergeGain(q);
    const b = el('button', 'cq-merge', '⧉ ' + tt('chat-composer.allesZusammenfassen'));
    b.type = 'button';
    if (gain > 0) {
      b.title = tt('chat-composer.zusammenfassenTitel').replace('{n}', String(gain + 1));
      b.onclick = () => mergeQueueOf(ACTIVE);
    } else {
      // every mergeable entry is alone between commands → the button would do nothing. Say why instead of
      // vanishing: a button that disappears for an unexplained reason is read as a bug. inertBtn makes the
      // reason reachable (a `disabled` button's title never opens), the button itself still does nothing.
      inertBtn(b, tt('chat-composer.zusammenfassenNurBefehle'));
    }
    box.appendChild(b);
  }
  if (ACTIVE && ACTIVE._queueUndo) {
    const u = el('button', 'cq-undo', '↩ ' + tt('chat-composer.rueckgaengig'));
    u.type = 'button'; u.title = tt('chat-composer.zusammenfassenRueckgaengig');
    u.onclick = () => undoQueueMerge(ACTIVE);
    box.appendChild(u);
  }
}
// „↪ Jetzt einspeisen" (Julian, 07.10.: „manchmal sind Sachen sehr lange in der Warteschlange, die eigentlich einen
// aktuellen Schritt näher erklären würden"). Same look as „⧉ Alles zusammenfassen". It sends the leading text entries
// NOW, as one message, into the running turn — no interrupt: the CLI hands a stdin message to the model at the next
// tool boundary of the SAME turn (measured, see queue-merge.js). Only while a turn runs and no card holds the CLI —
// with a card open [Mit Antwort senden] is the way; at rest the queue flushes by itself anyway.
function queueInjectLive(tab) { return !!(tab && tab.id && tab.streaming && !(typeof hasHeldGate === 'function' && hasHeldGate(tab))); }
function renderQueueInjectBtn(box, tab, live) {
  if (!live) return;
  const take = queueInjectTake(tab.queue).take;
  if (!take.length) return;
  const b = el('button', 'cq-merge cq-inject', take.length > 1
    ? '↪ ' + tt('chat-composer.nEinspeisen').replace('{n}', String(take.length)) : '↪ ' + tt('chat-composer.jetztEinspeisen'));
  b.type = 'button';
  b.title = tt('chat-composer.einspeisenTitel');
  b.onclick = () => injectQueued(tab, queueInjectTake(tab.queue).take);
  box.appendChild(b);
}
// The one injection path — for the queue (above) and for the panel's own mid-turn requests (chat-side.js: the plan's
// step list). The bubble goes up at once, marked „↪ eingespeist"; deliverText shares the retry/recovery of a send.
// → Promise<boolean> (false: not live, or the send failed — then markSendFailed has said so on the bubble).
function injectNow(tab, text) {
  if (!queueInjectLive(tab) || !String(text || '').trim()) return Promise.resolve(false);
  const node = withTab(tab, () => addMsg('user', text, { midTurn: true, injected: true })).m;
  return deliverText(tab, text, [], node);
}
function injectQueued(tab, items) {
  if (!tab || !queueInjectLive(tab)) { toast(tt('chat-composer.einspeisenNichtLaufend'), 'warn'); return; }
  const take = (items || []).filter((it) => tab.queue.includes(it) && queueItemInjectable(it));
  if (!take.length) return;
  const merged = queueMergeItems(take, { head: tt('chat-composer.mehrereAnliegen') });
  tab.queue = tab.queue.filter((it) => !take.includes(it)); tab._queueUndo = null;
  queueChanged(tab);
  injectNow(tab, merged.text).then((ok) => {
    if (ok) {
      if (typeof openPointsAnswerFrom === 'function') openPointsAnswerFrom(tab, merged.text, merged.queuedAt);
      if (tab === ACTIVE) toast(tt('chat-composer.eingespeist'), 'ok');
      return;
    }
    // not delivered → back to the FRONT, in their order (queueRestoreTaken, as [Mit Antwort senden] does)
    tab.queue = queueRestoreTaken(tab.queue, take);
    queueChanged(tab);
    if (tab === ACTIVE) toast(tt('chat-composer.einspeisenZurueck'), 'err');
  });
}
async function editQueued(tab, item) {
  if (!tab || !item) return;
  const v = await uiPrompt(tt('chat-composer.eintragBearbeitenHinweis'), String(item.text || ''), {
    title: tt('chat-composer.eintragBearbeiten'), multiline: true, rows: 6, okLabel: tt('common.speichern'), icon: '✎' });
  if (v == null) return;
  if (!tab.queue.includes(item)) { toast(tt('chat-composer.schonGesendet'), 'warn'); return; } // flushed meanwhile
  const text = String(v).trim();
  if (!text && !(item.attachments && item.attachments.length)) { toast(tt('chat-composer.leerNichtGespeichert'), 'warn'); return; }
  // an edited entry is ONE message again: its old parts were the pieces of a text that no longer exists
  item.text = text; delete item.parts; delete item.merged;
  tab._queueUndo = null;
  queueChanged(tab);
}
function mergeQueueOf(tab) {
  if (!tab || !tab.queue || tab.queue.length < QUEUE_MERGE_MIN) return;
  const before = tab.queue;
  const after = queueMerge(before, { head: tt('chat-composer.mehrereAnliegen') });
  if (after.length >= before.length) { toast(tt('chat-composer.zusammenfassenNurBefehle'), 'err'); return; }
  tab._queueUndo = before.map((it) => ({ ...it, attachments: (it.attachments || []).slice() }));
  tab.queue = after;
  if (tab === ACTIVE) renderQueueStrip();
  renderTabs();
  toast(tt('chat-composer.zusammengefasst').replace('{n}', String(before.length)).replace('{m}', String(after.length)), 'ok');
}
function undoQueueMerge(tab) {
  if (!tab || !tab._queueUndo) return;
  tab.queue = tab._queueUndo; tab._queueUndo = null;
  if (tab === ACTIVE) renderQueueStrip();
  renderTabs();
}
function flushQueue(tab) { // the result tail passes the event's tab; [Jetzt senden] the visible one
  tab = tab || chat;
  if (!tab.queue || !tab.queue.length) return;
  const item = tab.queue.shift();
  tab._queueUndo = null; // the first entry is on its way — restoring the pre-merge queue would re-send it
  tab.queuePaused = false;
  // PF-1b — a start built for a proposal that is no longer the one on the table (chat-side.js planQueuedStale): the
  // chip's attachment comes off and what was typed goes out on its own; a start that was nothing but the panel's (▶)
  // does not go out at all — and the next entry takes its place, since this turn's end sends nothing else. Said once,
  // because something the reader asked for did not happen. Nothing of it reaches the transcript, so the fold agrees.
  if (typeof planQueuedStale === 'function' && planQueuedStale(tab, item)) {
    const typed = typeof item.planTyped === 'string' ? item.planTyped : null;
    if (tab === ACTIVE) toast(tt(typed != null ? 'chat-composer.planAnhangVeraltet' : 'chat-composer.planStartVeraltet'), 'warn');
    if (typed == null || !(typed.trim() || (item.attachments || []).length)) { queueChanged(tab); flushQueue(tab); return; }
    item.text = typed; delete item.planFor; delete item.planTyped;
  }
  if (tab === ACTIVE) renderQueueStrip();
  renderTabs();
  staleQuickReplies(tab);
  // only now does it answer open points — and only those raised before it was written (F8)
  if (item.text && typeof openPointsAnswerFrom === 'function') openPointsAnswerFrom(tab, item.text, item.queuedAt);
  const sent = withTab(tab, () => addMsg('user', item.text, { attachments: item.attachments })).m; // now, in send order
  withTab(tab, () => setComposerBusy(true));
  markCtxOp(tab, item.text); // a QUEUED /clear·/compact behaves exactly like a typed one (gauge + footer)
  markTypedModel(tab, item.text); // …and so does a queued /model <arg>
  // a queued start begins the plan when it really goes out, as a direct one does (PF-1b)
  const started = typeof planNoteOutgoing === 'function' ? planNoteOutgoing(tab, item.text) : '';
  if (typeof planQueueNoted === 'function') planQueueNoted(tab);
  deliverText(tab, item.text, item.attachments, sent) // shares the retry/recovery path with a normal send (C3)
    .then((ok) => { if (started && typeof planOutgoingSettled === 'function') planOutgoingSettled(tab, started, ok); });
}
function clearQueue(tab, reason) {
  if (!tab.queue || !tab.queue.length) { if (tab.queuePaused) queueChanged(tab); return; }
  const n = tab.queue.length; tab.queue = []; tab._queueUndo = null;
  queueChanged(tab);
  if (tab === ACTIVE && reason) toast(n + tt('chat-composer.nachrichtEnVerworfen') + reason, 'err');
}
// An entry left the queue by hand (×) or all of them did: an empty queue has nothing left to hold back,
// and it was the last thing a deferred restart may have waited for.
function queueChanged(tab) {
  if (!tab.queue || !tab.queue.length) tab.queuePaused = false;
  if (tab === ACTIVE) renderQueueStrip();
  renderTabs();
  if (typeof maybeApplyPendingRunCfg === 'function') maybeApplyPendingRunCfg(tab);
  if (typeof planQueueNoted === 'function') planQueueNoted(tab); // a start taken out by × → ▶ is offered again
}

// --- attachments (per tab, see attachmentsOf() in chat.js — C8) ---
function renderAttachChips() {
  const wrap = $('#attachChips'); if (!wrap) return;
  wrap.innerHTML = '';
  const list = attachmentsOf(ACTIVE);
  list.forEach((a, i) => {
    const chip = el('div', 'att-chip');
    if (a.kind === 'image') { const img = el('img'); img.src = 'data:' + a.mediaType + ';base64,' + a.data; chip.appendChild(img); }
    chip.appendChild(el('span', null, a.name + (a.lines ? ' · ' + a.lines + tt('chat-composer.zeilen') : a.kind === 'text' ? ' · text' : a.kind === 'pdf' ? ' · pdf' : '')));
    if (a.kind === 'text' && a.text) chip.title = a.text.length > 600 ? a.text.slice(0, 600) + '\n…' : a.text; // hover to preview
    const x = el('span', 'x'); x.innerHTML = ic('close', 12); x.title = tt('chat-composer.entfernen'); x.onclick = () => { list.splice(i, 1); renderAttachChips(); }; chip.appendChild(x);
    wrap.appendChild(chip);
  });
  renderPlanChip(); // the plan chip stands last in the same row (PF-1b)
  // a file makes typed text a message instead of the card's answer (typedReplyCard) — the chip has to follow
  if (ACTIVE && openCardOf(ACTIVE)) renderQueueStrip();
}
function clearAttachments(tab) { const t = tab || ACTIVE; if (t) t.attachments = []; renderAttachChips(); }

// --- PF-1b: the composer chip „📋 Plan-Fortschritt mitsenden" (Julian's decision of 05.10.) ---
// The 05.10. session was started by a typed „plan starten" — and the protocol only rode along with the approval
// BUTTON, so the model never reported and the rail never moved. While a proposal lies there to be started (an
// orphan, or a proposal no gate decides) and no card is waiting, the next message the reader sends carries what ▶
// Plan starten carries: the step list and the protocol, VISIBLY — the chip above the composer says so, and the user
// row shows it folded as „📋 Plan-Fortschritt". On by default, switched off with one click for the message being
// typed (back on once the composer is empty). Sent with it, the plan is underway and the chip is gone: it can never
// be attached twice. A typed command, a keep („Weiter planen") and a text that already carries a block never get it.
function planChipShown(tab) {
  if (!tab || (typeof planProgressOn === 'function' && !planProgressOn())) return false;
  const p = tab.plan;
  if (!p || p.state !== 'proposed' || typeof planStartable !== 'function' || !planStartable(tab, p)) return false;
  if (typeof planStartQueued === 'function' && planStartQueued(tab)) return false; // one start is on its way already
  return !openCardOf(tab); // a card waiting for an answer decides first — the chip would talk over it
}
// What a message sent now gets attached ('' = nothing): only the shown chip, switched on, for a text that is
// neither a command (it must stay the whole message) nor already a start or a keep of its own. A block the text merely
// quotes is no start (planOutgoingKind reads only the panel's attachment at the end), so the chip still attaches — and
// its block, the LAST one, is what the start takes. The bare start head typed by hand gets it too: with the list it is
// a start, without it an untracked one.
function planChipAttachment(tab, text) {
  if (!planChipShown(tab) || tab._planChipOff || typeof planStartMessage !== 'function') return '';
  const k = typeof planOutgoingKind === 'function' ? planOutgoingKind(text) : '';
  if (queueTextIsCommand(text) || k === 'start' || k === 'keep') return '';
  return planStartMessage('', tab.plan);
}
function planChipReset(tab) { if (tab && tab._planChipOff) { tab._planChipOff = false; renderPlanChip(); } }
// Painted into #attachChips, after the attachments — one row of „what goes along with this message".
function renderPlanChip() {
  const wrap = $('#attachChips'); if (!wrap) return;
  const old = wrap.querySelector('.plan-chip'); if (old) old.remove();
  const tab = ACTIVE;
  if (!planChipShown(tab)) return;
  const on = !tab._planChipOff;
  const chip = el('button', 'att-chip plan-chip ' + (on ? 'is-on' : 'is-off'));
  chip.type = 'button';
  chip.setAttribute('aria-pressed', on ? 'true' : 'false');
  chip.appendChild(el('span', 'pc-mark', on ? '✓' : '○'));
  chip.appendChild(el('span', 'pc-label', '📋 ' + tt('chat-composer.planChip')));
  chip.appendChild(el('span', 'pc-state', tt(on ? 'chat-composer.planChipAn' : 'chat-composer.planChipAus')));
  chip.title = tt(on ? 'chat-composer.planChipTitelAn' : 'chat-composer.planChipTitelAus');
  chip.onclick = () => { tab._planChipOff = !tab._planChipOff; renderPlanChip(); const i = $('#composerInput'); if (i) i.focus(); };
  wrap.appendChild(chip);
}
function addFile(file) {
  if (file.size > 12 * 1024 * 1024) { toast(file.name + tt('chat-composer.zuGross12mb'), 'err'); return; }
  const reader = new FileReader(), type = file.type || '';
  const own = ACTIVE; // the file lands on the tab that was visible when it was dropped/picked, not on whichever
  const add = (att) => { attachmentsOf(own).push(att); if (own === ACTIVE) renderAttachChips(); }; // is active when the FileReader resolves
  if (type.startsWith('image/')) { reader.onload = () => add({ kind: 'image', name: file.name, mediaType: type, data: reader.result.split(',')[1] }); reader.readAsDataURL(file); }
  else if (type === 'application/pdf' || /\.pdf$/i.test(file.name)) { reader.onload = () => add({ kind: 'pdf', name: file.name, data: reader.result.split(',')[1] }); reader.readAsDataURL(file); }
  else { reader.onload = () => add({ kind: 'text', name: file.name, text: reader.result }); reader.readAsText(file); }
}
// --- composer insertion (C7) ---
// Inserting a slash command / snippet / saved prompt used to overwrite whatever was half-written, with no way
// back. Insert at the CARET (with sane spacing) and, when something was replaced, offer a one-click undo.
function composerInsert(text, opts) {
  opts = opts || {};
  const inp = $('#composerInput'); if (!inp || !text) return;
  const prev = inp.value;
  const s = inp.selectionStart != null ? inp.selectionStart : prev.length;
  const e = inp.selectionEnd != null ? inp.selectionEnd : prev.length;
  const head = prev.slice(0, s), tail = prev.slice(e);
  const gap = head && !/\s$/.test(head) ? (opts.newline ? '\n' : ' ') : '';
  const pad = tail && !/^\s/.test(tail) ? ' ' : '';
  inp.value = head + gap + text + pad + tail;
  inp.focus();
  // put the caret on the template's first <PLACEHOLDER> so it can be typed over right away
  const ph = opts.selectPlaceholder ? text.match(/<[^>\n]+>/) : null;
  const at = (head + gap).length;
  try { if (ph) inp.setSelectionRange(at + text.indexOf(ph[0]), at + text.indexOf(ph[0]) + ph[0].length); else inp.setSelectionRange(at + text.length, at + text.length); } catch { /* */ }
  autoGrow(); saveDraft();
  if (prev.trim() && prev !== inp.value) offerComposerUndo(prev, opts.label || tt('chat-composer.eingefuegt'));
}
// replace the whole composer content (slash commands only work as the entire message) — but undoably
function composerSet(text, label) {
  const inp = $('#composerInput'); if (!inp) return;
  const prev = inp.value;
  inp.value = text; autoGrow(); saveDraft(); inp.focus();
  try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch { /* */ }
  if (prev.trim()) offerComposerUndo(prev, label || tt('chat-composer.ersetzt'));
}
function offerComposerUndo(prev, label) {
  const chip = $('#editingChip'); if (!chip) return;
  chip.classList.remove('hidden'); chip.innerHTML = '';
  chip.appendChild(el('span', null, '✎ ' + label));
  const u = el('span', 'x', tt('chat-composer.rueckgaengig'));
  u.onclick = () => { const inp = $('#composerInput'); inp.value = prev; autoGrow(); saveDraft(); clearEditing(); inp.focus(); };
  chip.appendChild(u);
}

// --- slash commands ---
let SLASH_SEL = -1;
function slashItems() { return [...$('#slashMenu').querySelectorAll('.slash-item')]; }
function hideSlash() { $('#slashMenu').classList.add('hidden'); SLASH_SEL = -1; }
function applySlash(c) { $('#composerInput').value = c + ' '; hideSlash(); $('#composerInput').focus(); autoGrow(); }
function updateSlash() {
  const v = $('#composerInput').value, menu = $('#slashMenu');
  const m = v.match(/^\/(\S*)$/);
  if (!m) { hideSlash(); return; }
  const q = m[1].toLowerCase();
  const matches = allChatCommands().filter((c) => c.slice(1).toLowerCase().startsWith(q)).slice(0, 8); // incl. LOCAL_COMMANDS (C6)
  if (!matches.length) { hideSlash(); return; }
  menu.innerHTML = ''; SLASH_SEL = 0;
  let hasUi = false;
  matches.forEach((c, i) => {
    // UI skills (a ```ui-skill manifest in the command .md) get a marker + open their GUI form on Enter
    const us = (typeof uiSkillByName === 'function') ? uiSkillByName(c.slice(1)) : null;
    const it = el('div', 'slash-item' + (i === 0 ? ' sel' : '') + (us ? ' slash-ui' : ''));
    it.dataset.cmd = c;
    it.appendChild(el('span', 'sc-name', (us ? '▶ ' : '') + c));
    if (us) {
      hasUi = true; it.dataset.ui = '1';
      const title = (us.manifest && us.manifest.title) || '';
      if (title) it.appendChild(el('span', 'sc-title', title));
      it.onclick = () => { if (typeof openUiSkillSlash === 'function') openUiSkillSlash(us); else applySlash(c); };
    } else it.onclick = () => applySlash(c);
    menu.appendChild(it);
  });
  if (hasUi) menu.appendChild(el('div', 'slash-hint', tt('chat-composer.slashUiHint')));
  menu.classList.remove('hidden');
}

// --- @-file mention autocomplete ---
let AT_SEL = -1, AT_TOKEN = null, AT_TIMER = null;
function atItems() { return [...$('#atMenu').querySelectorAll('.slash-item')]; }
function hideAt() { $('#atMenu').classList.add('hidden'); AT_SEL = -1; AT_TOKEN = null; }
function applyAt(pathStr) {
  const inp = $('#composerInput'); const v = inp.value;
  if (!AT_TOKEN) return;
  const before = v.slice(0, AT_TOKEN.start), after = v.slice(AT_TOKEN.end);
  inp.value = before + '@' + pathStr + ' ' + after;
  const pos = (before + '@' + pathStr + ' ').length;
  hideAt(); inp.focus(); try { inp.setSelectionRange(pos, pos); } catch {} autoGrow(); saveDraft();
}
function updateAt() {
  const inp = $('#composerInput'); const v = inp.value; const caret = inp.selectionStart;
  // find an @token ending at the caret (no spaces inside)
  const upto = v.slice(0, caret);
  const m = upto.match(/(^|\s)@([^\s@]*)$/);
  if (!m) { hideAt(); return; }
  const q = m[2];
  AT_TOKEN = { start: caret - m[2].length - 1, end: caret };
  clearTimeout(AT_TIMER);
  AT_TIMER = setTimeout(async () => {
    let files = [], refused = '';
    try { const r = await api('/api/files?q=' + encodeURIComponent(q) + '&cwd=' + encodeURIComponent($('#cwdInput').value.trim() || (STATE && (STATE.defaultCwd || STATE.home)) || '')); files = r.files || []; }
    catch (e) { files = []; if (e && e.code === 'cwd-refused') refused = String(e.message || ''); }
    const menu = $('#atMenu');
    // A REFUSED directory is not "no matches": without this row the picker answers an empty list, and an
    // empty list reads as "there are no files here" — the server's reason (GET /api/files, code
    // `cwd-refused`) is the only thing that tells the user it was the cwd and not the query. `.slash-hint`
    // is deliberately not a `.slash-item`, so atItems() stays empty and Enter cannot "pick" it.
    if (refused) {
      menu.innerHTML = ''; AT_SEL = -1;
      menu.appendChild(el('div', 'slash-hint', '⚠ ' + tt('common.ordnerAbgelehnt') + refused));
      menu.classList.remove('hidden');
      return;
    }
    if (!files.length) { hideAt(); return; }
    menu.innerHTML = ''; AT_SEL = 0;
    files.slice(0, 12).forEach((f, i) => { const it = el('div', 'slash-item' + (i === 0 ? ' sel' : '')); it.dataset.path = f; it.appendChild(el('span', 'sc-name', f)); it.onclick = () => applyAt(f); menu.appendChild(it); });
    menu.classList.remove('hidden');
  }, 140);
}

// --- edit / rewind ---
// „Bearbeiten" used to ONLY refill the composer: the message object handed to it was ignored, so the original
// stayed put and after sending, the transcript showed the old and the new ask side by side as if they were two
// separate requests. EDIT_TARGET remembers WHICH message is being replaced; sendMessage supersedes it (C11).
let EDIT_TARGET = null; // { tab, node }
function clearEditing() { EDIT_TARGET = null; const c = $('#editingChip'); c.classList.add('hidden'); c.innerHTML = ''; }
function startEdit(text, node) {
  const inp = $('#composerInput');
  const prev = inp.value; // cancelling puts the draft back instead of emptying the composer (C7)
  inp.value = text; autoGrow(); saveDraft(); inp.focus();
  try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch { /* */ }
  EDIT_TARGET = node ? { tab: chat, node } : null;
  const chip = $('#editingChip'); chip.classList.remove('hidden'); chip.innerHTML = '';
  chip.appendChild(el('span', null, '✎ ' + tt('chat-composer.bearbeitenErsetztDieNachricht')));
  const x = el('span', 'x', tt('chat-composer.abbrechen'));
  x.onclick = () => { clearEditing(); inp.value = prev; autoGrow(); saveDraft(); };
  chip.appendChild(x);
}

$('#sendBtn').onclick = () => sendMessage(); // (not `= sendMessage` — the click event would land in opts)
$('#interruptBtn').onclick = () => stopTab(chat); // same path as the tab menu's „Stoppen" and Esc-Esc — the second press is the hard stop
$('#newChatBtn').onclick = () => {
  // open a fresh parallel tab (existing tabs keep running in the background)
  newTab();
  hideCtxGauge();
  clearAttachments(); clearEditing(); hideSlash();
};
$('#skillLaunchBtn').onclick = () => { if (typeof openSkillLauncher === 'function') openSkillLauncher(); };
if ($('#promptLibBtn')) $('#promptLibBtn').onclick = () => { if (typeof openPromptManager === 'function') openPromptManager(); }; // M11
// A13 — the ↑-history only reaches back through the last 100 prompts of THIS browser; this opens the
// searchable one (terminal + panel) without leaving the composer.
if ($('#promptHistBtn')) $('#promptHistBtn').onclick = () => { if (typeof openPromptHistory === 'function') openPromptHistory(); };
$('#cwdDefaultBtn').onclick = async () => {
  const c = $('#cwdInput').value.trim();
  try {
    const r = await api('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultCwd: c }) });
    if (STATE) STATE.defaultCwd = r.defaultCwd;
    toast(tt('chat-composer.standardArbeitsverzeichnisGespeichert') + r.defaultCwd, 'ok');
  } catch (e) { toast(e.message, 'err'); }
};

const composer = $('#composerInput');
function autoGrow() { composer.style.height = 'auto'; composer.style.height = Math.min(composer.scrollHeight, 220) + 'px'; }
// writing .style.height forces a synchronous layout; on a fast typist that fired per keystroke. Coalesce to
// one write per frame — every non-input caller still uses the direct autoGrow(). (P6)
let _growRAF = false;
function autoGrowSoon() { if (_growRAF) return; _growRAF = true; requestAnimationFrame(() => { _growRAF = false; autoGrow(); }); }
const _saveDraftDebounced = debounce(() => saveDraft(), 300); // was a localStorage write per keystroke
// ONE input listener (there were two on the same event) doing the cheap gating first: the slash menu can only
// apply when the value starts with '/', the @-menu only when there is an '@' before the caret. Before, every
// keystroke ran both regexes over the whole value and re-armed the @-completion timer. (P6)
composer.addEventListener('input', () => {
  HIST_IDX = -1; // typing exits prompt-history navigation
  autoGrowSoon();
  const v = composer.value;
  if (v.charCodeAt(0) === 47) updateSlash();                                              // 47 = '/'
  else if (!$('#slashMenu').classList.contains('hidden')) hideSlash();
  if (v.lastIndexOf('@', Math.max(0, (composer.selectionStart || 0) - 1)) >= 0) updateAt();
  else if (!$('#atMenu').classList.contains('hidden')) hideAt();
  // The „↳ beantwortet" chip promises exactly what cardTakesTypedText does — and a command is no card
  // answer, so the chip has to go while one is typed and come back when it is deleted again. Repainted
  // only when the leading slash FLIPS against what the strip was painted for, and only with a card open.
  if (ACTIVE && queueTextIsCommand(v) !== _routeTextCmd && openCardOf(ACTIVE)) renderQueueStrip();
  if (!v.trim()) planChipReset(ACTIVE); // the composer emptied: the chip is back on for the next message (PF-1b)
  _saveDraftDebounced();
});
// shared keyboard handling for the two composer popovers (slash + @) — the two copies had already drifted
// (the slash menu scrolled its selection into view, the @-menu didn't)
function menuKeydown(e, cfg) {
  const items = cfg.items();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = Math.max(0, Math.min(items.length - 1, cfg.get() + (e.key === 'ArrowDown' ? 1 : -1)));
    cfg.set(next); items.forEach((it, i) => it.classList.toggle('sel', i === next));
    if (items[next]) items[next].scrollIntoView({ block: 'nearest' });
    return true;
  }
  if (e.key === 'Escape') { e.preventDefault(); cfg.hide(); return true; }
  const cur = items[cfg.get()];
  if (cur && (e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.altKey) { e.preventDefault(); cfg.accept(cur, e.key); return true; }
  return false;
}
composer.addEventListener('keydown', (e) => {
  if (!$('#slashMenu').classList.contains('hidden')) {
    const handled = menuKeydown(e, {
      items: slashItems, get: () => SLASH_SEL, set: (i) => { SLASH_SEL = i; }, hide: hideSlash,
      accept: (it, key) => {
        // Tab = always plain-text insert (escape hatch for UI skills); Enter opens a UI skill's form
        if (key === 'Enter' && it.dataset.ui && typeof uiSkillByName === 'function' && typeof openUiSkillSlash === 'function') {
          const us = uiSkillByName(it.dataset.cmd.slice(1)); if (us) { openUiSkillSlash(us); return; }
        }
        applySlash(it.dataset.cmd);
      },
    });
    if (handled) return;
  }
  if (!$('#atMenu').classList.contains('hidden')) {
    const handled = menuKeydown(e, {
      items: atItems, get: () => AT_SEL, set: (i) => { AT_SEL = i; }, hide: hideAt,
      accept: (it) => applyAt(it.dataset.path),
    });
    if (handled) return;
  }
  // prompt history: ↑/↓ when no menu is open, single-line, caret at an edge
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.ctrlKey && !e.altKey) {
    const v = composer.value, atEdge = e.key === 'ArrowUp' ? composer.selectionStart === 0 : composer.selectionStart === v.length;
    const singleLine = !v.includes('\n') || HIST_IDX !== -1;
    if (atEdge && singleLine) { if (historyRecall(e.key === 'ArrowUp' ? -1 : 1)) { e.preventDefault(); return; } }
  }
  // Alt+Enter (like Shift+Enter) = newline instead of send
  if (e.key === 'Enter' && e.altKey) {
    e.preventDefault();
    const s = composer.selectionStart, en = composer.selectionEnd, v = composer.value;
    composer.value = v.slice(0, s) + '\n' + v.slice(en);
    composer.selectionStart = composer.selectionEnd = s + 1;
    autoGrow(); _saveDraftDebounced();
    return;
  }
  // Ctrl+Enter = send NOW: stop the running turn and take this message instead (the CLI's own
  // ctrl+enter, 2.1.275). Without a turn running it is an ordinary send, so the key never needs a
  // second thought about when it applies.
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage({ interrupt: true }); return; }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// --- voice input (Web Speech API) ---
// Final segments go in at the caret, each once (voice-insert.js); what is still being recognised shows in
// #voicePreview, never in the field — so typing or correcting while listening survives. (The old handler froze
// the text at the start and rewrote the WHOLE field on every recognition step.) A dictation belongs to the tab
// it started in: a tab switch ends it (stopVoiceInput, from activateTab) — otherwise the next segment would land
// in the other tab's draft.
let VOICE_STOP = null;
function stopVoiceInput() { if (VOICE_STOP) VOICE_STOP(); }
(function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $('#micBtn');
  if (!SR) { btn.style.display = 'none'; return; } // not supported
  const prev = $('#voicePreview');
  let rec = null, listening = false, doneIdx = -1;
  const showPreview = (txt) => {
    if (!prev) return;
    prev.textContent = '🎤 ' + (txt || tt('chat-composer.hoertZu'));
    prev.classList.toggle('is-interim', !!txt);
    prev.classList.remove('hidden');
  };
  const hidePreview = () => { if (prev) { prev.classList.add('hidden'); prev.textContent = ''; } };
  const ended = () => { listening = false; rec = null; VOICE_STOP = null; btn.classList.remove('listening'); hidePreview(); };
  const insertFinal = (text) => {
    const s = composer.selectionStart, e = composer.selectionEnd, v = composer.value;
    const j = voiceJoin(v.slice(0, s), text, v.slice(e));
    if (!j.text) return;
    // Focused: one undo step per segment (Strg+Z takes a misheard one back); execCommand fires `input`, which
    // already runs autoGrow and the draft. Without focus: setRangeText leaves the rest of the field untouched.
    if (document.activeElement === composer && document.execCommand && document.execCommand('insertText', false, j.text)) {
      composer.setSelectionRange(s + j.caret, s + j.caret);
    } else {
      composer.setRangeText(j.text, s, e, 'end');
      composer.setSelectionRange(s + j.caret, s + j.caret);
      autoGrow(); saveDraft();
    }
  };
  btn.onclick = () => {
    if (listening) { try { rec.stop(); } catch {} return; }
    const r = new SR(); rec = r; doneIdx = -1;
    r.lang = (typeof LANG !== 'undefined' && LANG === 'en') ? 'en-US' : 'de-DE'; r.interimResults = true; r.continuous = true;
    r.onresult = (e) => {
      if (rec !== r) return; // ended by a tab switch: nothing more goes into the composer
      const sp = voiceSplit(e.results, e.resultIndex, doneIdx);
      sp.finals.forEach((x) => { insertFinal(x.text); doneIdx = x.i; });
      if (listening) showPreview(sp.interim);
    };
    r.onend = () => { if (rec === r) { ended(); saveDraft(); } };
    r.onerror = (e) => {
      if (rec !== r) return;
      if (e && (e.error === 'not-allowed' || e.error === 'service-not-allowed')) toast(tt('chat-composer.spracheingabeNichtVerfuegbar'), 'err');
      ended();
    };
    try {
      r.start(); listening = true; btn.classList.add('listening');
      VOICE_STOP = () => { if (rec !== r) return; try { r.abort(); } catch {} ended(); };
      composer.focus(); // the click moved focus to 🎤 — back to the field, caret where it was
      showPreview('');
      toast(tt('chat-composer.hoereZuNochmalZum'), 'ok');
    } catch (err) { rec = null; toast(tt('chat-composer.spracheingabeNichtVerfuegbar'), 'err'); }
  };
})();

// --- prompt enhancer ---
$('#enhanceBtn').onclick = async () => {
  const inp = $('#composerInput'); const text = inp.value.trim();
  if (!text) { toast(tt('chat-composer.erstEinenPromptEingeben'), 'err'); return; }
  const btn = $('#enhanceBtn'); btn.disabled = true; btn.classList.add('spinning');
  const original = text;
  try {
    const r = await api('/api/enhance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, cwd: $('#cwdInput').value.trim() || undefined }) });
    if (r.text) {
      inp.value = r.text; autoGrow(); saveDraft();
      // offer undo
      const chip = $('#editingChip'); chip.classList.remove('hidden'); chip.innerHTML = '';
      chip.appendChild(el('span', null, '✨ ' + tt('chat-composer.promptVerbessert')));
      const u = el('span', 'x', tt('chat-composer.rueckgaengig')); u.onclick = () => { inp.value = original; autoGrow(); clearEditing(); }; chip.appendChild(u);
    }
  } catch (e) { toast(tt('chat-composer.enhanceFehlgeschlagen') + e.message, 'err'); }
  finally { btn.disabled = false; btn.classList.remove('spinning'); }
};
// ＋ is a <label for="fileInput"> — the browser opens the dialog natively (no JS .click()).
$('#fileInput').onchange = (e) => { [...e.target.files].forEach(addFile); e.target.value = ''; };
composer.addEventListener('paste', (e) => {
  const imgs = [...((e.clipboardData && e.clipboardData.items) || [])].filter((it) => it.type.startsWith('image/'));
  if (imgs.length) { imgs.forEach((it) => { const f = it.getAsFile(); if (f) addFile(f); }); return; }
  // Large text paste → collapse into a chip instead of dumping the whole thing into the input
  // (like the terminal / PowerShell). It's sent inline (fenced) on submit — server expands kind:'text'.
  const txt = (e.clipboardData && e.clipboardData.getData('text')) || '';
  const lines = txt ? txt.split('\n').length : 0;
  if (txt && (lines >= 6 || txt.length > 800)) {
    e.preventDefault();
    attachmentsOf(ACTIVE).push({ kind: 'text', name: '📋 ' + tt('chat-composer.eingefuegterText') + (++PASTE_SEQ), text: txt, lines });
    renderAttachChips();
    toast(tt('chat-composer.grosserTextAlsAnhang') + lines + tt('chat-composer.zeilenWirdBeimSenden'), 'ok');
    $('#composerInput').focus();
  }
});
// drag & drop files anywhere in the chat view
(function () {
  const zone = $('#view-chat');
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { if (hasFiles(e)) { e.preventDefault(); zone.dataset.dropLabel = tt('chat-composer.dateienHierAblegen'); zone.classList.add('drop-active'); } })); // label resolved at drag time (CSS content: attr()) so it follows a live language switch
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('drop-active'); });
  zone.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); zone.classList.remove('drop-active');
    const files = [...(e.dataTransfer.files || [])];
    files.forEach(addFile);
    if (files.length) { toast(files.length + tt('chat-composer.dateiEnAngehaengt'), 'ok'); $('#composerInput').focus(); }
  });
})();

// --- /diff viewer: the working-copy git diff of the tab's cwd, shown in a modal (ToDo 03) ---
async function openDiffViewer(cwd) {
  const body = el('div', 'diff-view');
  body.innerHTML = '<div class="loading">' + tt('chat-composer.ladeDiff') + '</div>';
  const p = uiModal({ title: tt('chat-composer.aenderungenGitDiff'), icon: '±', wide: true, body, actions: [{ label: tt('common.schliessen'), value: true, primary: true }] });
  try {
    const j = await api('/api/diff?cwd=' + encodeURIComponent(cwd || ''));
    body.innerHTML = '';
    if (!j.repo) { body.appendChild(el('div', 'diff-empty', tt('chat-composer.keinGitRepositoryIm') + ' ' + (j.dir || cwd || '—'))); return p; }
    body.appendChild(el('div', 'diff-head', (j.branch ? '⎇ ' + j.branch + ' · ' : '') + (j.files && j.files.length ? j.files.length + tt('chat-composer.geaenderteDateiEn') : tt('chat-composer.keineAenderungen'))));
    if (!j.patch) { body.appendChild(el('div', 'diff-empty', tt('chat-composer.keineUncommittetenAenderungen'))); return p; }
    const pre = el('pre', 'diff-pre'); pre.appendChild(renderDiffLines(j.patch)); body.appendChild(pre);
    if (j.truncated) body.appendChild(el('div', 'diff-empty', tt('chat-composer.gekuerztVollstaendigViaGit')));
  } catch (e) { body.innerHTML = ''; const msg = String(e.message || e); body.appendChild(el('div', 'diff-empty', msg)); }
  return p;
}
// colorize a unified diff into per-line spans (add/del/hunk/meta)
function renderDiffLines(patch) {
  const frag = document.createDocumentFragment();
  patch.split('\n').forEach((line) => {
    let cls = 'dl';
    if (line.startsWith('+') && !line.startsWith('+++')) cls = 'dl add';
    else if (line.startsWith('-') && !line.startsWith('---')) cls = 'dl del';
    else if (line.startsWith('@@')) cls = 'dl hunk';
    else if (/^(diff |index |\+\+\+ |--- |new file|deleted file|rename )/.test(line)) cls = 'dl meta';
    frag.appendChild(el('span', cls, line + '\n'));
  });
  return frag;
}

// reusable fully-themed dropdown (button + popover listbox) — replaces native <select> so the
// open list follows the theme (native <option> popups can't be styled). onChange(value, isPreview):
// isPreview=true fires on hover / close for a non-committing preview; isPreview=false on a real pick.
function ccSelect(current, options, onChange) {
  const wrap = el('div', 'cc-dd');
  const btn = el('button', 'cc-dd-btn'); btn.type = 'button'; btn.setAttribute('aria-haspopup', 'listbox');
  const list = el('div', 'cc-dd-list hidden'); list.setAttribute('role', 'listbox');
  let val = current;
  const optOf = (v) => options.find((o) => o.value === v) || options[0];
  function paintBtn() { btn.innerHTML = ''; btn.appendChild(el('span', 'cc-dd-cur', optOf(val).label)); btn.appendChild(el('span', 'cc-dd-caret', '▾')); }
  function buildList() {
    list.innerHTML = '';
    options.forEach((o) => {
      const it = el('div', 'cc-dd-opt' + (o.value === val ? ' sel' : '')); it.setAttribute('role', 'option');
      it.appendChild(el('span', 'cc-dd-check', o.value === val ? '✓' : ''));
      it.appendChild(el('span', 'cc-dd-lbl', o.label));
      it.onmouseenter = () => onChange && onChange(o.value, true);
      it.onclick = (e) => { e.stopPropagation(); commit(o.value); close(); };
      list.appendChild(it);
    });
  }
  function commit(v) { val = v; paintBtn(); onChange && onChange(v, false); }
  function open() { closeAllCcDd(); buildList(); list.classList.remove('hidden'); wrap.classList.add('open'); }
  function close() { list.classList.add('hidden'); wrap.classList.remove('open'); onChange && onChange(val, true); }
  btn.onclick = (e) => { e.stopPropagation(); list.classList.contains('hidden') ? open() : close(); };
  btn.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const i = options.findIndex((o) => o.value === val); const ni = Math.max(0, Math.min(options.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))); commit(options[ni].value); if (!list.classList.contains('hidden')) buildList(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); list.classList.contains('hidden') ? open() : close(); }
    else if (e.key === 'Escape') { close(); }
  };
  paintBtn(); wrap.appendChild(btn); wrap.appendChild(list);
  wrap._close = close; wrap.getValue = () => val; wrap.setValue = (v) => { val = v; paintBtn(); };
  return wrap;
}
function closeAllCcDd() { document.querySelectorAll('.cc-dd.open').forEach((w) => { if (w._close) w._close(); }); }

// chat display-options popover
(function () {
  const pop = $('#chatOptsPop'), btn = $('#chatOptsBtn');
  // Antwort-Stil: label + a canned sample rendered in that style's shape (the live preview).
  // Functions, not load-time consts — the labels must re-resolve on a live language switch
  // (module-load tt() froze the boot language into the dropdowns until a reload).
  const styleOptions = () => [
    { value: '', label: '◇ ' + tt('chat-composer.standardModellDefault') },
    { value: 'concise', label: '✂ ' + tt('chat-composer.kurzDirekt') },
    { value: 'bullets', label: '• ' + tt('chat-composer.stichpunkte') },
    { value: 'detailed', label: '📖 ' + tt('chat-composer.ausfuehrlich') },
    { value: 'teacher', label: '🎓 ' + tt('chat-composer.erklaerend') },
    { value: 'code', label: '‹/› ' + tt('chat-composer.codeFokussiert') },
  ];
  const styleSamples = () => ({
    '': tt('chat-composer.ausgewogeneStandardAntwortFliesstext'),
    concise: tt('chat-composer.kernaussageZuerstKeinVorgeplaenkel'),
    bullets: tt('chat-composer.ersterKernpunktZweiterKernpunkt'),
    detailed: tt('chat-composer.ueberblickAusfuehrlicheStrukturierteAntwort'),
    teacher: tt('chat-composer.zuerstDerBegriffKontext'),
    code: tt('chat-composer.jsFunctionDemoReturn'),
  });
  const styleLabel = (v) => { const o = styleOptions(); return (o.find((x) => x.value === v) || o[0]).label; };
  function updateStylePreview(v) {
    const box = $('#stylePreview'); if (!box) return;
    const samples = styleSamples();
    const sample = samples[v] != null ? samples[v] : samples[''];
    box.innerHTML = '';
    box.appendChild(el('div', 'co-preview-cap', tt('chat-composer.vorschau') + styleLabel(v)));
    const body = el('div', 'co-preview-body bubble'); body.innerHTML = renderMarkdown(sample); decorateCode(body);
    box.appendChild(body);
  }

  // (re)build the two themed dropdowns into their mounts — called at load and from applyLang
  function rebuildDisplayDropdowns() {
    const sm = $('#styleSelMount'); if (sm) sm.innerHTML = '';
    const styleDd = ccSelect(DISPLAY.style || '', styleOptions(), (v, isPreview) => {
      updateStylePreview(v);
      if (!isPreview) { DISPLAY.style = v; saveDisplay(); toast(tt('chat-composer.stilGiltAbNew'), 'ok'); }
    });
    if (sm) sm.appendChild(styleDd);
    updateStylePreview(DISPLAY.style || '');
    const fm = $('#fontSizeMount'); if (fm) fm.innerHTML = '';
    const fontDd = ccSelect(DISPLAY.fontSize || 'm', [
      { value: 's', label: tt('chat-composer.klein') }, { value: 'm', label: tt('chat-composer.normal') }, { value: 'l', label: tt('chat-composer.gross') },
    ], (v, isPreview) => { if (!isPreview) { DISPLAY.fontSize = v; saveDisplay(); applyDisplay(); } });
    if (fm) fm.appendChild(fontDd);
  }
  window.rebuildDisplayDropdowns = rebuildDisplayDropdowns;
  rebuildDisplayDropdowns();

  // hydrate the checkboxes from persisted DISPLAY
  $('#tgThinking').checked = DISPLAY.thinking;
  $('#tgTools').checked = DISPLAY.tools;
  $('#tgFoot').checked = DISPLAY.foot;
  $('#tgRaw').checked = DISPLAY.raw;
  $('#tgGuard').checked = DISPLAY.guard;
  if ($('#tgNotify')) $('#tgNotify').checked = !!DISPLAY.notify;
  if ($('#tgSuggest')) $('#tgSuggest').checked = !!DISPLAY.suggest;
  // D2 — three modes, so a select: „automatisch" is one of the answers, not the absence of a setting
  if ($('#opCollectSel')) $('#opCollectSel').value = (typeof openCollectMode === 'function') ? openCollectMode(DISPLAY.opCollect) : 'auto';
  if ($('#tgDense')) $('#tgDense').checked = DISPLAY.density === 'dense';
  applyDisplay();
  btn.onclick = (e) => { e.stopPropagation(); pop.classList.toggle('hidden'); btn.setAttribute('aria-expanded', String(!pop.classList.contains('hidden'))); };
  pop.onclick = (e) => { e.stopPropagation(); closeAllCcDd(); }; // click in the dialog (not on a dd) closes an open dd
  document.addEventListener('click', () => { pop.classList.add('hidden'); closeAllCcDd(); btn.setAttribute('aria-expanded', 'false'); });
  const bind = (id, key) => { $(id).onchange = (e) => { DISPLAY[key] = e.target.checked; saveDisplay(); applyDisplay(); }; };
  bind('#tgThinking', 'thinking'); bind('#tgFoot', 'foot'); bind('#tgRaw', 'raw');
  // tools are now SKIPPED at build time while hidden (P6), so re-enabling can't bring back the cards of the
  // turns that ran while it was off — say so instead of leaving the user hunting for them
  $('#tgTools').onchange = (e) => {
    DISPLAY.tools = e.target.checked; saveDisplay(); applyDisplay();
    if (DISPLAY.tools) toast(tt('chat-composer.toolsWiederSichtbar'), 'ok');
  };
  $('#tgGuard').onchange = (e) => { DISPLAY.guard = e.target.checked; saveDisplay(); };
  // A12: ask for the browser permission at opt-in time, and say plainly when it was refused —
  // otherwise the checkbox looks on while nothing ever appears.
  if ($('#tgNotify')) $('#tgNotify').onchange = (e) => {
    DISPLAY.notify = e.target.checked; saveDisplay();
    if (!DISPLAY.notify) return;
    if (typeof chatNotifyAsk === 'function') chatNotifyAsk();
    if ('Notification' in window && Notification.permission === 'denied') toast(tt('chat-composer.benachrichtigungenBlockiert'), 'err');
  };
  // N1: takes effect on the next start — the flag is a spawn argument, not a live control
  if ($('#tgSuggest')) $('#tgSuggest').onchange = (e) => { DISPLAY.suggest = e.target.checked; saveDisplay(); toast(tt('chat-composer.giltAbNaechstemChat'), 'ok'); };
  // D2 collect mode: the cards decide per click what „answer" means, so the only thing to do here is to
  // hand the mode over — openCollectSet owns the preference, the toast and the repaint.
  if ($('#opCollectSel')) $('#opCollectSel').onchange = (e) => { if (typeof openCollectSet === 'function') openCollectSet(e.target.value); };
  if ($('#tgDense')) $('#tgDense').onchange = (e) => { DISPLAY.density = e.target.checked ? 'dense' : 'normal'; saveDisplay(); applyDisplay(); };
})();

