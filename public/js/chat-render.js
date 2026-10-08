// Part of the Claude Code Control Panel front-end (split from app.js).
// Classic scripts share one global scope; load order in index.html is authoritative: render → chat → sessions → views → commands → boot.
// This file: chat-render.js

// --- chat display preferences (persisted) ---
// COR-1: read with a try. This runs at LOAD TIME, so a single unparsable `cc_display` (a half-written
// value, a quota-truncated string, a hand-edited one) did not degrade the display preferences — it threw
// inside this file's evaluation, and with chat-render.js gone the whole panel was a blank page until
// someone cleared localStorage by hand. Every other localStorage read in the panel is already guarded
// (chat.js:1318 tabs, chat-side.js:27 layout, commands.js:569 ctx, views-uiskills.js:355 prefs); this was
// the last one that was not. The broken value is kept rather than deleted: the next saveDisplay()
// replaces it anyway, and deleting data because we cannot read it is how the original gets lost.
function readDisplayPrefs(raw) {
  try {
    const v = JSON.parse(raw || '{}');
    // `null` and an array both parse fine and would make Object.assign silently contribute nothing or
    // index keys — only a plain object is a preferences record
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch {
    if (typeof console !== 'undefined' && console.warn) console.warn('cc_display ist kein gültiges JSON — Anzeige-Einstellungen auf Standard');
    return {};
  }
}
const DISPLAY = Object.assign(
  // notify (A12) and suggest (N1) are opt-in: the first triggers a browser permission prompt, the
  // second costs a small prediction per turn. Both default off so nothing changes unasked.
  // opCollect (D2) — answer several open points and send them as ONE message: 'auto' (from the second
  // open question on) · 'on' · 'off'. 'auto' is the default because the trade-off flips with the count:
  // with ONE question the immediate answer is right, with two, answering the first is what makes the
  // second wait in the queue.
  { thinking: true, tools: true, foot: true, raw: false, guard: true, style: '', fontSize: 'm', density: 'normal', notify: false, suggest: false, opCollect: 'auto' },
  readDisplayPrefs(localStorage.getItem('cc_display'))
);
function saveDisplay() { localStorage.setItem('cc_display', JSON.stringify(DISPLAY)); }
// Antwort-Stil presets -> --append-system-prompt (applied to NEW sessions)
const STYLE_PROMPTS = {
  '': '',
  concise: 'Answer concisely and directly. Prefer short paragraphs and bullet points over long prose. Skip preamble.',
  detailed: 'Give thorough, well-structured answers with headings, context and reasoning. Explain trade-offs.',
  code: 'Prioritise code. Reply with code blocks and only minimal surrounding explanation.',
  teacher: 'Explain like a patient teacher: define terms, give step-by-step reasoning and small examples.',
  bullets: 'Always structure the answer as short, scannable bullet points. Avoid long paragraphs.',
};
function applyDisplay() {
  const sc = $('#chatScroll');
  sc.classList.toggle('hide-thinking', !DISPLAY.thinking);
  sc.classList.toggle('hide-tools', !DISPLAY.tools);
  sc.classList.toggle('hide-foot', !DISPLAY.foot);
  sc.classList.toggle('raw-md', !!DISPLAY.raw);
  sc.classList.remove('fs-s', 'fs-m', 'fs-l'); sc.classList.add('fs-' + (DISPLAY.fontSize || 'm'));
  sc.classList.toggle('dense', DISPLAY.density === 'dense');
  reRenderAssistants();
  rebuildHiddenTools();
}
// render assistant text honoring the raw/markdown toggle; keep raw text for re-render.
// Also the canonical final render for a streamed bubble — produces the exact full-renderMarkdown
// DOM and clears the incremental streaming state, so any transient streaming imperfection self-corrects.
function setAssistantText(elx, text) {
  if (typeof _streamPending !== 'undefined' && _streamPending) _streamPending.delete(elx); // cancel a pending incremental render so it can't rebuild the wrapper after finalize
  elx.dataset.raw = text;
  elx._committedLen = null; elx._live = null; elx._fence = null; elx._raw = text; // reset incremental stream state
  if (DISPLAY.raw) elx.textContent = text;
  // hydrateResultBlocks turns a ```ui-result placeholder into the real result card (views-uiskills.js)
  else { elx.innerHTML = renderMarkdown(text); decorateCode(elx); if (typeof hydrateResultBlocks === 'function') hydrateResultBlocks(elx); }
  maybeFoldAssistant(elx, text);
}
// Tool output folds at 2000 chars, but a 20-screen answer pushed everything else out of the window with no way
// to collapse it. Same affordance for long assistant answers (M3).
const ASSISTANT_FOLD_CHARS = 4000;
function maybeFoldAssistant(elx, text) {
  const host = elx.parentElement; if (!host) return;
  const old = host.querySelector(':scope > .fold-more'); if (old) old.remove();
  elx.classList.remove('folded');
  if (!text || text.length <= ASSISTANT_FOLD_CHARS || DISPLAY.raw) return;
  elx.classList.add('folded');
  const btn = el('button', 'fold-more');
  const paint = () => { btn.textContent = elx.classList.contains('folded') ? '▼ ' + tt('chat-render.mehrAnzeigen') + (typeof fmtNum === 'function' ? fmtNum(text.length) : text.length) + tt('chat-render.zeichen') : '▲ ' + tt('chat-render.weniger'); };
  btn.onclick = (e) => { e.stopPropagation(); elx.classList.toggle('folded'); paint(); };
  paint();
  host.insertBefore(btn, elx.nextSibling);
}
// Alt+↑/↓ — jump between your own messages (M5). "Current" = the last user message at or above the viewport
// top; a first ↑ inside a long message snaps to its start instead of skipping it.
function jumpUserMessage(dir) {
  if (!ACTIVE) return;
  const msgs = [...ACTIVE.msgEl.querySelectorAll('.msg.user')];
  if (!msgs.length) return;
  const top = $('#chatScroll').getBoundingClientRect().top;
  let idx = -1, curOffset = 0;
  msgs.forEach((m, i) => { const d = m.getBoundingClientRect().top - top; if (d < 4) { idx = i; curOffset = d; } });
  let next = dir < 0 ? (idx >= 0 && curOffset < -8 ? idx : idx - 1) : idx + 1;
  next = Math.max(0, Math.min(msgs.length - 1, next));
  const target = msgs[next];
  ACTIVE.stick = false;
  target.scrollIntoView({ block: 'start' });
  target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 900);
  updateScrollBtn();
}
function reRenderAssistants() {
  if (!ACTIVE) return;
  [...ACTIVE.msgEl.querySelectorAll('.msg.assistant .bubble')].forEach((b) => {
    if (b.dataset.raw == null) return;
    if (DISPLAY.raw) b.textContent = b.dataset.raw;
    else { b.innerHTML = renderMarkdown(b.dataset.raw); decorateCode(b); if (typeof hydrateResultBlocks === 'function') hydrateResultBlocks(b); }
    maybeFoldAssistant(b, b.dataset.raw); // keep the M3 fold in sync with the display mode (raw = never folded)
  });
}

// throttled markdown render of the streaming bubble (kills the raw->markdown flash).
// INCREMENTAL: markdown blocks before the last safe boundary are rendered+highlighted ONCE and
// frozen as direct children; only the active tail is re-rendered each tick. Turns the per-tick
// cost from O(whole message) into O(open block) → removes the O(N²) streaming hot path.
// A "safe boundary" = a blank line (\n\n) with balanced ``` fences before it (so a closed
// paragraph/list/code block never re-renders). Fences are balanced at _committedLen by construction.
function streamCommitBoundary(raw, from) {
  let parity = 0, lastSafe = from, i = from; const n = raw.length;
  while (i < n) {
    if (raw.charCodeAt(i) === 96 && raw.charCodeAt(i + 1) === 96 && raw.charCodeAt(i + 2) === 96) { parity ^= 1; i += 3; continue; }
    if (raw.charCodeAt(i) === 10 && raw.charCodeAt(i + 1) === 10 && parity === 0) { i += 2; lastSafe = i; continue; }
    i++;
  }
  return lastSafe;
}
// position of an UNCLOSED ``` at/after `from` (-1 when the fences in that range are balanced)
function openFenceStart(raw, from) {
  let i = from, start = -1;
  for (;;) {
    const j = raw.indexOf('```', i);
    if (j < 0) return start;
    start = start < 0 ? j : -1; // toggle: every second fence closes the previous one
    i = j + 3;
  }
}
// While the model writes a LONG file there is no blank line at fence parity 0, so the whole growing code block
// was re-rendered (markdown split + per-line highlighting) every 90 ms → O(n²) and visible stutter. Inside an
// open fence we therefore switch to append-only: complete lines are appended as text nodes to one <pre>, and
// only the partial last line is rewritten. When the fence closes, the cheap preview is dropped and the finished
// block goes through the normal render ONCE (with highlighting). setAssistantText is still the canonical final
// render, so this preview can be plain without any lasting imperfection. (P3)
const STREAM_FENCE_MIN = 240; // short snippets keep the pretty path
function enterFenceMode(elx, raw, at) {
  if (at > elx._committedLen) { // a fence always starts a fresh markdown block → freezing the prose before it is safe
    const frag = document.createElement('div');
    frag.innerHTML = renderMarkdown(raw.slice(elx._committedLen, at));
    decorateCode(frag);
    while (frag.firstChild) elx.insertBefore(frag.firstChild, elx._live);
  }
  const nl = raw.indexOf('\n', at);
  const lang = raw.slice(at + 3, nl < 0 ? raw.length : nl).replace(/[^\w-]/g, '');
  const pre = el('pre', 'md-pre stream-fence');
  const code = el('code', 'lang-' + lang);
  const tail = document.createTextNode('');
  code.appendChild(tail); pre.appendChild(code);
  elx.insertBefore(pre, elx._live);
  elx._committedLen = nl < 0 ? raw.length : nl + 1;
  elx._fence = { pre, code, tail, startLen: at };
}
function renderStreamEl(elx) {
  const raw = elx._raw || '';
  if (DISPLAY.raw) { elx._committedLen = null; elx._fence = null; elx.textContent = raw; return; }
  // (re)initialise the frozen/live structure (fresh bubble, or after a raw-mode/finalize reset)
  if (elx._committedLen == null || !elx._live || elx._live.parentNode !== elx) {
    elx.innerHTML = ''; elx._committedLen = 0; elx._fence = null;
    elx._live = el('div', 'stream-live'); elx.appendChild(elx._live);
  }
  if (elx._fence) {
    const close = raw.indexOf('```', elx._committedLen);
    if (close < 0) {
      const nl = raw.lastIndexOf('\n');
      if (nl >= elx._committedLen) { // freeze the complete lines — pure append, no re-render
        elx._fence.code.insertBefore(document.createTextNode(raw.slice(elx._committedLen, nl + 1)), elx._fence.tail);
        elx._committedLen = nl + 1;
      }
      elx._fence.tail.nodeValue = raw.slice(elx._committedLen); // only the partial last line is rewritten
      if (elx._live.firstChild) elx._live.innerHTML = '';
      return;
    }
    // The fence closed: drop the cheap preview and render the finished block ONCE — right up to the end of the
    // closing fence line. Waiting for the next blank line would put the whole (possibly 2000-line) block back
    // into the per-tick tail render, i.e. exactly the O(n²) we just avoided.
    const endNl = raw.indexOf('\n', close + 3);
    const startLen = elx._fence.startLen;
    elx.removeChild(elx._fence.pre);
    elx._committedLen = startLen; elx._fence = null;
    if (endNl >= 0) {
      const frag = document.createElement('div');
      frag.innerHTML = renderMarkdown(raw.slice(startLen, endNl + 1));
      decorateCode(frag);
      while (frag.firstChild) elx.insertBefore(frag.firstChild, elx._live);
      elx._committedLen = endNl + 1;
    }
  }
  const boundary = streamCommitBoundary(raw, elx._committedLen);
  if (boundary > elx._committedLen) {                        // freeze newly-stable blocks (render+highlight once)
    const frag = document.createElement('div');
    frag.innerHTML = renderMarkdown(raw.slice(elx._committedLen, boundary));
    decorateCode(frag);
    while (frag.firstChild) elx.insertBefore(frag.firstChild, elx._live);
    elx._committedLen = boundary;
  }
  const f = openFenceStart(raw, elx._committedLen);
  // the lifted blocks (ui-result, offene-punkte, plan-status — render.js MD_LIFTED_FENCES) are swapped away by
  // renderMarkdown while still open — leave those alone (fence mode would stream their raw JSON into a <pre>,
  // the very thing renderMarkdown hides)
  if (f >= 0 && raw.length - f > STREAM_FENCE_MIN && !MD_LIFTED_FENCE_RE.test(raw.slice(f, f + 16))) {
    enterFenceMode(elx, raw, f);
    return renderStreamEl(elx); // one level: _fence is set and _committedLen is past the header
  }
  // re-render only the active tail — the one render that sees a block still OPEN (`stream`: renderMarkdown hides
  // an open ```plan-status only here; a finished message keeps an unclosed one readable)
  elx._live.innerHTML = renderMarkdown(raw.slice(elx._committedLen), { stream: true });
  decorateCode(elx._live);
}
const _streamPending = new Set(); let _streamTimer = null;
function scheduleStreamRender(elx) { _streamPending.add(elx); if (_streamTimer) return; _streamTimer = setTimeout(() => { _streamTimer = null; const els = [..._streamPending]; _streamPending.clear(); els.forEach(renderStreamEl); scrollBottom(); }, 90); }

function nearBottom() { const s = $('#chatScroll'); return (s.scrollHeight - s.scrollTop - s.clientHeight) < 120; }
function updateScrollBtn() {
  const b = $('#scrollLatest'); if (!b) return;
  const atBottom = !ACTIVE || nearBottom() || ACTIVE.msgEl.childElementCount === 0;
  b.classList.toggle('hidden', atBottom);
  if (atBottom && ACTIVE) setUnseenCount(0); // caught up
  else paintUnseenBadge();
}
// "N neue" on the jump-to-bottom button: while scrolled up, every message group that arrives is counted, so
// the button says how much you'd catch up on instead of just "Neueste" (M10).
function setUnseenCount(n) { if (!ACTIVE) return; ACTIVE.unseen = Math.max(0, n | 0); paintUnseenBadge(); }
function bumpUnseen() { if (!ACTIVE || ACTIVE.stick) return; ACTIVE.unseen = (ACTIVE.unseen || 0) + 1; paintUnseenBadge(); }
function paintUnseenBadge() {
  const b = $('#scrollLatest'); if (!b) return;
  const n = (ACTIVE && ACTIVE.unseen) || 0;
  let badge = b.querySelector('.sl-count');
  if (!n) { if (badge) { badge.remove(); b.title = tt('html.zuDenNeuestenNachrichten'); } return; }
  if (!badge) { badge = el('span', 'sl-count'); b.appendChild(badge); }
  badge.textContent = n > 99 ? '99+' : String(n);
  b.title = n + ' ' + tt('chat-render.neueNachrichten');
}
let _scrollRAF = false;
function scrollBottom(force) {
  if (chat !== ACTIVE) return;
  const s = $('#chatScroll');
  if (force) { s.scrollTop = s.scrollHeight; updateScrollBtn(); return; }
  if (!ACTIVE.stick) { updateScrollBtn(); return; }
  if (_scrollRAF) return; _scrollRAF = true;
  requestAnimationFrame(() => { _scrollRAF = false; if (chat === ACTIVE && ACTIVE.stick) { const s2 = $('#chatScroll'); s2.scrollTop = s2.scrollHeight; } updateScrollBtn(); });
}
// passive: this listener never calls preventDefault, and a non-passive scroll listener makes the browser wait
// for it before compositing. nearBottom() is computed ONCE and reused (it reads scrollHeight/clientHeight →
// layout), instead of once here and again inside updateScrollBtn. (P6)
$('#chatScroll').addEventListener('scroll', () => {
  const atBottom = nearBottom();
  if (ACTIVE) { ACTIVE.stick = atBottom; if (atBottom) ACTIVE.unseen = 0; }
  const b = $('#scrollLatest'); if (b) { b.classList.toggle('hidden', atBottom || !ACTIVE || ACTIVE.msgEl.childElementCount === 0); paintUnseenBadge(); }
}, { passive: true });
$('#scrollLatest').onclick = () => { ACTIVE.stick = true; ACTIVE.unseen = 0; $('#chatScroll').scrollTop = $('#chatScroll').scrollHeight; updateScrollBtn(); };
// Robust auto-follow: while pinned to the bottom, ANY content added to the transcript (streaming
// text, tool cards, footers, permission cards, banners) keeps the view at the bottom — fixes the
// "doesn't always scroll down" cases the scattered scrollBottom() calls missed.
// Observes ONLY the active tab's container and is re-targeted on every switch: watching the whole #chatScroll
// subtree meant a busy BACKGROUND tab's mutations woke this callback — and its scrollHeight read forced a
// layout — for the visible tab, i.e. pure stutter for content nobody is looking at. (P2)
let _followRAF = false;
const _followObserver = new MutationObserver(() => {
  if (!ACTIVE || !ACTIVE.stick || _followRAF) return; _followRAF = true;
  requestAnimationFrame(() => { _followRAF = false; if (ACTIVE && ACTIVE.stick) { const s = $('#chatScroll'); s.scrollTop = s.scrollHeight; } updateScrollBtn(); });
});
function retargetFollowObserver() {
  _followObserver.disconnect();
  if (ACTIVE && ACTIVE.msgEl) _followObserver.observe(ACTIVE.msgEl, { childList: true, subtree: true });
}
retargetFollowObserver();

// --- pending tool-permission tracker → floating "Freigabe ausstehend" jump button ---
// Any unanswered permission (chat modal or an inline runner card) registers a "waiter" whose focus
// fn re-surfaces + focuses it. The pulsing button jumps to the oldest open one.
const PERM_WAITERS = new Map(); // key -> focus fn (open tool-permission prompts)
// key -> { tab, focus } for open AskUserQuestion/plan groups. The OWNING TAB is stored alongside the focus
// closure because every teardown path is per-tab: closing a tab left its waiter behind, so the floating
// button activated a REMOVED tab (ACTIVE pointing at detached DOM → every transcript hidden), and the
// closure kept the whole detached transcript alive. Conversely the old clearAllAskWaiters() wiped OTHER
// tabs' waiters on one tab's exit. (C1)
const ASK_WAITERS = new Map();
function registerPermWaiter(key, focus) { PERM_WAITERS.set(key, focus); refreshPermJump(); }
function clearPermWaiter(key) { if (PERM_WAITERS.delete(key)) refreshPermJump(); }
function registerAskWaiter(key, tab, focus) { ASK_WAITERS.set(key || 'ask', { tab, focus }); refreshPermJump(); }
function clearAskWaiter(key) { if (ASK_WAITERS.delete(key || 'ask')) refreshPermJump(); }
// drop the ask waiters of exactly ONE tab (close · interrupt · process exit · restart)
function clearAskWaitersForTab(tab) {
  let n = 0;
  for (const [k, w] of ASK_WAITERS) if (w.tab === tab) { ASK_WAITERS.delete(k); n++; }
  if (n) refreshPermJump();
}
// Held AskUserQuestion permissions. The CLI gates AskUserQuestion via a can_use_tool control_request;
// allowing it lets the tool run, and headless has no interactive picker so it instantly returns
// "did not answer" and the model self-defaults. Instead we HOLD the permission (the turn blocks at the
// tool call — can_use_tool has no timeout) and, when the user answers the card, resolve it with
// deny+message = their answer, which the CLI hands back as the tool result → the model continues in the
// SAME turn. toolId -> { requestId?, tab, group?, answeredFallback? }.
const ASK_GATES = new Map();
// Phases are stored on the tab as stable sentinel KEYS and translated only at display time
// (phaseLabel in chat-status.js). Storing translated strings broke the identity comparisons
// (`p === ASK_WAIT_PHASE` etc.) when the language was switched mid-turn.
const PHASE_WORKING = 'phase:working';
const ASK_WAIT_PHASE = 'phase:ask-wait';
// The three hot phases get sentinels too: setPhase(tt('…')) ran a dictionary lookup + string build for EVERY
// streamed token, only for the 200 ms status ticker to read the last value. (P7)
const PHASE_WRITING = 'phase:writing';
const PHASE_THINKING = 'phase:thinking';
const PHASE_TOOLWORK = 'phase:toolwork';
// A gate whose `requestId` is there HOLDS the CLI: the turn is blocked inside can_use_tool until this card
// is answered. That is live work even though it looks idle from the outside — `streaming` is false for the
// follow-up turn the CLI starts by itself (FLOW-3) and no frame arrives while it waits — which is why a
// typed message is queued rather than posted (chat-composer) and a deferred restart waits (chat.js).
function hasHeldGate(tab) { for (const g of ASK_GATES.values()) if (g.tab === tab && g.requestId) return true; return false; }
// `settle` belongs to the CALLER ([Mit Antwort senden] puts the entries it took back, the rail matches open
// points), so it must not decide the fate of this POST: a throw in the success handler became an unhandled
// rejection, and one in the failure handler skipped the dead-chat recovery AND the error toast.
function settleGate(settle, err) {
  if (typeof settle !== 'function') return;
  try { settle(err); } catch (e) { console.warn('gate settle failed', e); }
}
// The one POST that answers a held gate (question answer, plan decision). `settle(err|null)` — optional —
// hears how it ended, and on failure BEFORE the dead-chat recovery: [Mit Antwort senden] keeps the queue
// entries it took until here and must put them back while the queue still belongs to this session (the
// resume healDeadChat starts keeps it). Any other failure says so — the plan path used to swallow it.
// `toolId` (optional): the gate entry this POST answers. It stays in ASK_GATES until the POST is through —
// a failure that is NOT a dead chat (a 500, a wedged server) used to leave the turn blocked at the tool call
// with no card left to answer it, so the only way on was Stop, which then threw the just-restored queue
// entries away again. Now such a failure re-arms the card, and only success drops the entry.
function postGateReply(tab, body, settle, toolId) {
  api('/api/chat/' + tab.id + '/permission', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(() => {
      ASK_GATES.delete(toolId); refreshInterruptBtn(); settleGate(settle, null);
      if (toolId && typeof planGateSent === 'function') planGateSent(tab, toolId); // what the approval put away is history now (PF-1)
    }, (e) => {
      settleGate(settle, e); // first, see above: the queue entries go back before a resume adopts the queue
      // PF-1 — the CLI never heard this decision, so the plan rail must not claim it either: a plan accepted a
      // moment ago goes back to „wartet auf Freigabe", a „Weiter planen" brings the proposal back. Both the
      // re-armed card and the dead-chat heal below land here, which is the point — in neither case did it arrive.
      if (toolId && typeof planGateFailed === 'function') planGateFailed(tab, toolId);
      // reaped chat → recover the session (#25). The REAPED process had no turn in flight, so the resumed one
      // brings no gate back: this answer is lost, and the toast of the heal says so („bitte erneut
      // bestätigen"). Its clearAsksForTab drops the entry, so there is nothing left to re-arm here either.
      if (!(typeof healDeadChat === 'function' && healDeadChat(tab, e))) { rearmGateCard(toolId); toast(String((e && e.message) || e), 'err'); }
    });
}
function answerAsk(toolId, text, settle) {
  const g = ASK_GATES.get(toolId);
  if (!g || !g.requestId || !g.tab || !g.tab.id) return false; // no held gate → caller falls back to a follow-up message
  postGateReply(g.tab, { requestId: g.requestId, behavior: 'deny', message: text }, settle, toolId); // drops the entry on success
  return true;
}
// A gate reply that did not get through (and was no dead chat) leaves the CLI blocked at the tool call: this
// card is still the only way on, so it goes back to answerable — done marker off, controls back, the pulsing
// „Rückfrage offen" marker and the strip's chip back. The entry itself was never dropped (postGateReply), so
// the next click posts again.
function rearmGateCard(toolId) {
  const g = ASK_GATES.get(toolId); if (!g || !g.group) return;
  const group = g.group;
  group._done = false;
  group.querySelectorAll('.opt-done').forEach((n) => n.remove());
  group.querySelectorAll('button, input, textarea').forEach((b) => { b.disabled = false; });
  if (typeof group._rearm === 'function') group._rearm(); // „Antwort senden" stays disabled until something is picked
  if (g.tab) registerAskWaiter(toolId, g.tab, askCardFocus(g.tab, group));
  if (g.tab === ACTIVE && typeof renderQueueStrip === 'function') renderQueueStrip(); // the card waits again
}
// drop the HELD gates of one tab (their `group` refs pin the transcript, so this is also a heap fix)
function clearAsksForTab(tab) {
  for (const [k, g] of ASK_GATES) {
    if (g.tab !== tab) continue;
    const stashed = g.pendingSettle; // finalizePlan stashed a decision for a gate that had not arrived yet
    ASK_GATES.delete(k);
    // PF-1 — a plan decision stashed that way never reached the CLI either, and nothing can carry it any more.
    // retirePlanCards skips such a card (it is _done already — it says „→ Plan angenommen"), and planActivate only
    // runs once the gate is there, so without this the rail went on saying „wartet auf Freigabe" until the next
    // resume. PF-1b: either way the proposal is ORPHANED, and the card says the decision did not get through. A
    // stashed „Weiter planen" used to supersede it — but the CLI never heard it, so the transcript has no answer for
    // it (no result, an AbortError, or a Stop's „doesn't want to proceed"), and the resume brought it back as an
    // orphan with ▶: live and resume disagreed. Now the card offers ▶ and ✎ Weiter planen again, its feedback still
    // in the field — sent from the composer, that is a keep for the live tab and the fold alike.
    if (g.isPlan && g.answeredFallback) planCardOrphan(tab, k, 'lost', g.group);
    // …and the turn ends first, so the POST that would have carried it never happens. Say so: otherwise
    // [Mit Antwort senden] loses the entries it already took out of the queue without a word — its settle
    // puts them back and says why (CHAT-FLOW-6).
    settleGate(stashed, new Error('turn ended before the gate arrived'));
  }
  if (tab === ACTIVE && typeof renderQueueStrip === 'function') renderQueueStrip(); // no card waits any more
}
// Approving ExitPlanMode leaves read-only plan mode. The CLI won't tell us the new mode, so we DRIVE it to a
// safe known one (default — still asks before writes) + reflect it in the strip/dropdown. Shared by the inline
// plan card and the residual permission modal (ToDo 07b).
// FLOW-3: the route now answers the mode the SESSION reported, so this takes that instead of assuming
// 'default' landed. The assumption mattered here more than anywhere else — "wir fahren jetzt default" is
// a statement about what the session will do without asking, and this is the one path that makes it
// without the user having picked anything.
async function approvePlanMode(tab) {
  if (!tab || !tab.id) return;
  try {
    const r = await api('/api/chat/' + tab.id + '/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'default' }) });
    const effective = (r && typeof r.mode === 'string' && r.mode) ? r.mode : 'default';
    tab.permissionMode = effective;
    if (tab === ACTIVE) { if ($('#permMode')) $('#permMode').value = effective; if (typeof renderStatusBar === 'function') renderStatusBar(); }
    toast(tt('chat-render.planAngenommenModusDefault'), 'ok');
  } catch (e) { toast(tt('chat-render.planAngenommenModuswechselFehlgeschlagen') + e.message, 'err'); }
}
// Resolve a HELD ExitPlanMode gate. BOTH branches use deny+message: the CLI feeds the message back as the
// ExitPlanMode tool_result so the model continues in the SAME turn (exactly like AskUserQuestion / "Weiter
// planen"). A bare `allow` WEDGES headless stream-json — the CLI runs the tool but the turn never resumes and
// no `result` arrives, so the tab stays stuck on "⏳ Warte auf deine Antwort…" and any typed message is queued
// behind a result that never comes. accept=true → directive to implement now + leave read-only plan mode;
// accept=false → keep planning (stay in plan mode).
// PF-1 — the approval is also where the model learns how to report its progress: the message carries the
// suggested step list (a ```plan-schritte block, [] when the parser found none) and the protocol
// (planAcceptMessage). It becomes the ExitPlanMode tool_result, i.e. the one text every implementing turn is
// guaranteed to read — the system prompt reaches a RESUMED session only after its next compaction while the
// CLI's prompt snapshot is on (measured 2026-10-03: the panel's Prompt-Snapshot „an", or a CLI whose --help
// lacks the flag, PR-S), and a running process never. No candidate (the switch is off, or the card predates it) →
// the plain sentence, exactly as before.
function resolvePlanGate(tab, requestId, accept, keepMessage, settle, toolId) {
  if (!tab || !tab.id) { settleGate(settle, new Error('no chat')); return; }
  const cand = (accept && typeof planGateCandidate === 'function') ? planGateCandidate(tab, toolId) : null;
  const message = accept
    ? (cand ? planAcceptMessage(tt('chat-render.planGenehmigtDerPlan'), cand) : tt('chat-render.planGenehmigtDerPlan'))
    : keepMessage;
  const body = { requestId, behavior: 'deny' };
  if (message) body.message = message;
  postGateReply(tab, body, settle, toolId); // same heal path as answerAsk — a reaped chat resumes instead of hanging
  if (accept) approvePlanMode(tab); // leave read-only plan mode so the implementation can write
  // …and the rail follows the decision right away. The POST is still in flight: if it fails, postGateReply
  // takes this back (planGateFailed) — which is why the rail is told HERE, where the decision is sent, and not
  // on a click that may only have stashed it (finalizePlan before the gate arrived).
  // An approval WITHOUT a candidate (the switch is off, the card predates it) went out as the plain sentence:
  // the rail shows no plan from here on (planUntracked) — the same the resume fold reads out of it.
  if (accept) {
    if (cand && typeof planActivate === 'function') planActivate(tab, toolId);
    else if (typeof planUntracked === 'function') planUntracked(tab, toolId);
  } else if (typeof planSuperseded === 'function') planSuperseded(tab, toolId);
  // un-wedge the status: the turn continues now, so drop the "Warte auf deine Antwort…" phase
  if (tab.phase === ASK_WAIT_PHASE) { tab.phase = PHASE_WORKING; if (tab === ACTIVE && typeof renderStatus === 'function') renderStatus(); }
}
// resolve a HELD ExitPlanMode gate from the inline card. allow = accept (implement now); deny = keep planning.
function answerPlan(toolId, behavior, message, settle) {
  const g = ASK_GATES.get(toolId);
  if (!g || !g.requestId || !g.tab || !g.tab.id) return false; // gate not arrived yet → caller stashes the decision
  resolvePlanGate(g.tab, g.requestId, behavior === 'allow', message, settle, toolId); // drops the entry on success
  return true;
}
function refreshPermJump() {
  const btn = $('#permJump'); if (!btn) return;
  const perms = PERM_WAITERS.size, asks = ASK_WAITERS.size;
  btn.classList.toggle('hidden', perms + asks === 0);
  btn.classList.toggle('is-ask', perms === 0 && asks > 0);
  const t = btn.querySelector('.pj-txt');
  if (t) t.textContent = perms ? (perms > 1 ? tt('chat-render.freigabenAusstehend') + perms + ')' : tt('html.freigabeAusstehend'))
    : (asks > 1 ? tt('chat-render.rueckfragenOffen') + asks + ')' : tt('chat-render.rueckfrageOffen'));
}
// permissions take priority; else jump to the first open question
if ($('#permJump')) $('#permJump').onclick = () => {
  const ask = ASK_WAITERS.values().next().value;
  const f = PERM_WAITERS.values().next().value || (ask && ask.focus);
  if (typeof f === 'function') f();
};

// Heap bound: a long-running live conversation would otherwise grow the transcript DOM without
// limit (this is what crashed the tab). Keep only the most recent message groups; older ones drop
// from the DOM — the full transcript stays in the Sessions view. Same contract a resumed session
// already has (capped at tail=220), so in-chat search/export (which scan loaded nodes) need no change.
const LIVE_MSG_CAP = 140;       // max top-level message groups kept per tab
const LIVE_MSG_TRIM = 40;       // trim in batches to avoid per-turn churn
const LIVE_NODE_BUDGET = 12000; // …and a NODE budget (P1)
const LIVE_KEEP_MIN = 3;        // never trim the exchange being read right now
const LIVE_KEEP_CARDS = 4;      // …nor the newest tool cards inside it
function trimTranscript(tab) {
  if (!tab || !tab.msgEl) return;
  const host = tab.msgEl;
  // The cap counted GROUPS only. One agentic turn is a SINGLE group that can hold 30 Edit cards à 200 diff
  // lines (24 000 nodes measured), so the tab kept growing until it crawled while the counter said
  // "6 messages". Count the nodes too. (P1)
  let nodes = host.getElementsByTagName('*').length;
  if (host.childElementCount <= LIVE_MSG_CAP + 4 && nodes <= LIVE_NODE_BUDGET) return; // cheap pre-guard
  const groups = host.querySelectorAll(':scope > .msg, :scope > .superseded'); // static list; note/sep excluded
  const maxRemove = Math.max(0, groups.length - LIVE_KEEP_MIN);
  let remove = groups.length > LIVE_MSG_CAP ? groups.length - LIVE_MSG_CAP + LIVE_MSG_TRIM : 0;
  if (nodes > LIVE_NODE_BUDGET) { // drop the oldest groups until we're back inside the budget
    let acc = nodes, i = 0;
    while (i < maxRemove && acc > LIVE_NODE_BUDGET) { acc -= groups[i].getElementsByTagName('*').length + 1; i++; }
    if (i > remove) remove = i;
  }
  remove = Math.min(remove, maxRemove);
  if (remove > 0) {
    for (let i = 0; i < remove; i++) { nodes -= groups[i].getElementsByTagName('*').length + 1; groups[i].remove(); }
    pruneToolCards(tab); // drop the now-detached card refs
    if (!host.querySelector('.history-note.trim-note')) host.insertBefore(el('div', 'history-note trim-note', tt('chat-render.fruehereNachrichtenAusgeblendetSpeicher')), host.firstChild);
  }
  // Dropping whole groups can't help while ONE turn holds everything (and the last few groups must stay), which
  // is exactly the agentic case. Shed the heavy bodies of the OLDEST diff cards instead: the card and its file
  // header stay as a marker, the content is still complete in the Sessions transcript.
  if (nodes > LIVE_NODE_BUDGET) shedHeavyCards(tab, nodes);
}
function shedHeavyCards(tab, nodes) {
  const cards = tab.msgEl.querySelectorAll('.tool-card.is-diff:not(.is-shed)');
  for (let i = 0; i < cards.length - LIVE_KEEP_CARDS && nodes > LIVE_NODE_BUDGET; i++) {
    const body = cards[i].querySelector('.tc-diff-body');
    if (!body) continue;
    nodes -= body.getElementsByTagName('*').length + 1;
    body.remove();
    cards[i].open = false;
    cards[i].classList.add('is-shed');
    cards[i].appendChild(el('div', 'tc-shed', tt('chat-render.inhaltEntferntSpeicher')));
  }
}

// tab.toolCards maps tool_use_id -> card element for the WHOLE session; every entry pins its card (and with
// it a diff of up to a few thousand nodes). Once a turn can no longer deliver outputs (turn end, interrupt,
// exit, close) the map is dead weight — drop the detached ones, and everything on a hard stop.
function pruneToolCards(tab, all) {
  if (!tab) return;
  // The hidden-tool store (A4) is pruned by the same rule in BOTH modes, never wholesale: its entries
  // are rebuildable content, not refs to a turn that is over. `all` is also passed on an interrupt,
  // where the transcript (and with it every stub) stays on screen. What makes it bounded is the stub:
  // once trimTranscript drops the row, the entry has no place left to go and leaves with it.
  if (tab.hiddenTools) {
    for (const k in tab.hiddenTools) { const e = tab.hiddenTools[k]; if (!e || !e.stub || !e.stub.isConnected) delete tab.hiddenTools[k]; }
  }
  // PF-1 — the plan's jump targets are message rows too (≤ 30, takePlanStatus / renderResumeHistory), and the
  // report sits right above a step's first tool calls, so a kept row usually holds that step's Edit cards. Same
  // rule as the stubs: a row trimTranscript took out goes; planJumpTarget falls back to the card / the sidecar.
  if (tab._planRows) {
    for (const k in tab._planRows) { const r = tab._planRows[k]; if (!r || !r.isConnected) delete tab._planRows[k]; }
  }
  if (!tab.toolCards) return;
  if (all) { tab.toolCards = {}; return; }
  for (const k in tab.toolCards) { const c = tab.toolCards[k]; if (!c || !c.isConnected) delete tab.toolCards[k]; }
}
// A4 — „Werkzeuge" is a display switch, but it was a one-way door: addToolCard returns null while tools
// are hidden (P6) and nothing was kept, so those calls were unrecoverable — and since a row whose only
// content is tool cards is now hidden as a whole, they disappeared without leaving a gap to notice.
// The stub marks the exact place the card belongs; the call itself goes into the tab's store
// (tool-store.js), capped, because the live path truncates nothing.
function stashHiddenTool(tab, bubbleEl, t) {
  const row = bubbleEl && bubbleEl.parentElement;
  if (!row || !t || !t.id || typeof toolStorePut !== 'function') return;
  tab.hiddenTools = tab.hiddenTools || {};
  const stub = el('div', 'tool-stub');
  stub.dataset.tid = t.id;
  row.appendChild(stub);
  // Over the cap: the stub stays and SAYS so once the display is back. Fifty calls are a lot to keep;
  // losing the fifty-first quietly is the one thing this mechanism exists to prevent.
  if (!toolStorePut(tab.hiddenTools, t.id, t.name, t.input, { stub })) markLostToolStub(stub);
}
function markLostToolStub(stub) {
  if (!stub || stub.classList.contains('tool-lost')) return;
  stub.classList.add('tool-lost');
  stub.textContent = tt('chat-render.werkzeugNichtGespeichert');
  stub.title = tt('chat-render.werkzeugNichtGespeichertTitel');
}
// Tools switched back on → every stub becomes its card again. Walks ALL tabs on purpose: DISPLAY is
// global, and nothing re-renders a background tab's transcript when you switch to it.
// `silent: true` is the resumed-history flag (sessions.js): no step for a turn that is long over — the
// „Schritte" list is the CURRENT turn's timeline (P5) — and one scroll at the end instead of per card.
function rebuildHiddenTools() {
  if (!DISPLAY.tools || typeof TABS === 'undefined' || typeof addToolCard !== 'function') return;
  let any = false;
  TABS.forEach((tab) => {
    const stubs = tab.msgEl ? [...tab.msgEl.querySelectorAll('.tool-stub:not(.tool-lost)')] : [];
    if (!stubs.length) return;
    const store = tab.hiddenTools || {};
    withTab(tab, () => {
      stubs.forEach((stub) => {
        const id = stub.dataset.tid;
        const e = id ? store[id] : null;
        const bubble = stub.parentElement ? stub.parentElement.querySelector(':scope > .bubble') : null;
        if (!e || !bubble) { markLostToolStub(stub); return; }
        const card = addToolCard(bubble, e.name, e.input, { silent: true, toolId: id });
        if (!card) { markLostToolStub(stub); return; }
        (e.outs || []).forEach((o) => addToolOutput(card, o.text, o.isError, { silent: true }));
        stub.parentElement.insertBefore(card, stub); // addToolCard appends to the row — put it back where it belonged
        if (tab.toolCards) tab.toolCards[id] = card; // a tool still running can deliver its output again
        stub.remove(); delete store[id];
        any = true;
      });
    });
  });
  if (any) scrollBottom(); // once, not per card (P5)
}

// hh:mm for the message row (full date/time in the tooltip) — M1
function fmtClock(ts) { try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }
function clearNewSince(tab) { if (tab && tab._newSinceEl) { if (tab._newSinceEl.isConnected) tab._newSinceEl.remove(); tab._newSinceEl = null; } }
// looking away = this tab isn't the visible one, or the window doesn't have focus
function tabUnwatched(tab) { return tab !== ACTIVE || !document.hasFocus(); }
window.addEventListener('focus', () => { if (ACTIVE) ACTIVE._newSinceActive = false; }); // a new "neu seit" period may start again

function addMsg(role, text, opts) {
  opts = opts || {};
  const atts = opts.attachments || [];
  const hist = !!opts.hist; // painted from a stored transcript (resume) — not a live arrival
  if (chat === ACTIVE) $('#chatEmpty').classList.add('hidden');
  // A message arriving while nobody watched this tab gets a divider, so after switching back it is obvious
  // where the new part starts. One divider per unwatched period (M1). A historical paint never does.
  if (!hist && tabUnwatched(chat) && !chat._newSinceActive) {
    chat._newSinceActive = true;
    clearNewSince(chat);
    chat._newSinceEl = el('div', 'history-sep new-since', tt('chat-render.neuSeitDeinemBlick'));
    chat.msgEl.appendChild(chat._newSinceEl);
  }
  const m = el('div', 'msg ' + role + (opts.error ? ' is-error' : ''));
  const ts = opts.ts ? (typeof opts.ts === 'number' ? opts.ts : Date.parse(opts.ts) || Date.now()) : Date.now();
  m.dataset.ts = ts;
  const roleRow = el('div', 'role', role === 'user' ? tt('common.du') : role === 'assistant' ? 'Claude' : tt('common.system'));
  const timeEl = el('span', 'msg-time', fmtClock(ts)); // hover-visible: no timestamp existed anywhere (C13)
  try { timeEl.title = new Date(ts).toLocaleString(); } catch { /* */ }
  roleRow.appendChild(timeEl);
  // sent INTO a running turn (queue ↪, the panel's own mid-turn request) — or read back as such from the transcript
  if (opts.injected) { m.classList.add('injected'); const inj = el('span', 'msg-inj', tt('chat-render.eingespeist')); inj.title = tt('chat-render.eingespeistTitel'); roleRow.appendChild(inj); }
  const b = el('div', 'bubble');
  // PF-1b — a message carrying the panel's plan attachment (▶ Plan starten, the composer chip, [Stand abfragen],
  // 📋 Schritte anfordern): the bubble shows what was typed, the attachment sits folded below it as „📋 Plan-
  // Fortschritt" — live and in a resumed transcript alike, both paint through here. As raw text it was a wall of
  // JSON and protocol under every such message.
  const planAtt = (role === 'user' && typeof planMessageSplit === 'function') ? planMessageSplit(text) : null;
  const shown = planAtt ? planAtt.head : text;
  if (shown) b.textContent = shown;
  else if (atts.length || planAtt) b.classList.add('hidden'); // attachment-only message: no empty bubble
  else if (text != null) b.textContent = text;     // keep the empty streaming bubble for assistant turns
  if (role === 'user' || role === 'assistant') {
    roleRow.appendChild(copyBtn(() => (role === 'assistant' && b.dataset.raw != null) ? b.dataset.raw : b.innerText, tt('chat-render.nachrichtKopieren')));
  }
  // D4 — the correction button. Corrections are the most valuable thing the user tells me and the one
  // that evaporated most reliably: inside a session it lands, across sessions it was gone unless
  // someone thought to write a memory file. One line here reaches every FUTURE chat.
  if (role === 'assistant' && !hist) {
    roleRow.appendChild(iconBtn('corr-btn', 'edit', {
      size: 12, title: tt('chat-render.korrekturTooltip'),
      onClick: () => addCorrection(chat),
    }));
  }
  m.appendChild(roleRow);
  m.appendChild(b);
  if (planAtt) m.appendChild(planAttachmentEl(planAtt));
  if (atts.length) m.appendChild(renderMsgAttachments(atts)); // show pasted text / images fully in the bubble
  if (role === 'user') {
    if (shown) { const eb = iconBtn('edit-btn', 'edit', { size: 13, label: tt('chat-render.bearbeiten'), onClick: () => startEdit(b.textContent, m) }); m.appendChild(eb); }
    // a historical paint must NOT pin the scroll or clear the live step list (the resume paint walks over many
    // user messages, which would have wiped the steps of the turn we just painted)
    // …and neither may an answer given INSIDE a running turn (a card reply, CHAT-FLOW-6): the turn goes on
    if (!hist) { chat.stick = true; if (!opts.midTurn) resetSteps(); }
  }
  chat.msgEl.appendChild(m);
  if (chat === ACTIVE && !hist) bumpUnseen(); // "N neue" on the jump-to-bottom button while scrolled up (M10)
  scrollBottom(role === 'user');
  return { m, b };
}
// The folded „📋 Plan-Fortschritt" of a user row (planMessageSplit): what kind of attachment it was, the steps it
// carried (their titles come from the plan or the model — text nodes only), and that the protocol rode along.
function planAttachmentEl(a) {
  const d = el('details', 'plan-att');
  const what = a.kind === 'start'
    ? (a.steps.length ? tt('chat-render.planAnhangStart').replace('{n}', a.steps.length) : tt('chat-render.planAnhangStartLeer'))
    : tt('chat-render.planAnhangFrage');
  d.appendChild(el('summary', 'plan-att-sum', '📋 ' + tt('chat-render.planAnhang') + ' · ' + what));
  const body = el('div', 'plan-att-body');
  if (a.steps.length) {
    const ol = el('ol', 'plan-att-steps');
    a.steps.forEach((s) => ol.appendChild(el('li', null, s.id + ' · ' + s.title)));
    body.appendChild(ol);
  }
  body.appendChild(el('div', 'plan-att-proto', tt('chat-render.planAnhangProtokoll')));
  d.appendChild(body);
  return d;
}
// D4 — record one correction. Deliberately NOT injected into the current chat: it already stands in
// this conversation, and re-sending it would just be noise. It applies from the next start, in every
// tab, via the appended system prompt (see lib/pure composeAppendSystem).
async function addCorrection(tab) {
  const v = await uiPrompt(tt('chat-render.korrekturFrage'), '', {
    icon: '✎', title: tt('chat-render.korrekturTitel'), multiline: true, rows: 3,
    placeholder: tt('chat-render.korrekturPlaceholder'), okLabel: tt('chat-render.korrekturSpeichern'),
  });
  if (v == null || !String(v).trim()) return;
  try {
    await api('/api/corrections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: String(v).trim(), origin: (tab && tab.title) || '' }) });
    toast(tt('chat-render.korrekturGespeichert'), 'ok');
  } catch (e) { toast(e.message, 'err'); }
}
// A turn that DIED (process exit with a code, or an `_error` frame) is not an ordinary system note: the
// thing you asked for did not happen, and the old rendering was the same dashed grey box as the harmless
// "Kontext geleert" — with nothing to act on (B2). This one is red, and it offers the single action that
// matters: send the last message again. The send path self-heals a reaped session on its own, so a retry
// after an idle-kill usually just works.
function addTurnError(text) {
  const tab = chat; // owning tab (chat is swapped to it during event handling)
  // BELL-1 — and into the 🔔 log, which is the panel's own answer to „was ist passiert, während ich in
  // einem anderen Fenster war?" (render.js, above EVENTS). A turn that DIED reached that log through
  // nothing: no toast, no entry — only this red box, in the transcript of a tab that is very often not the
  // one on screen (a background tab, or another view entirely). The tab name travels with it, because
  // „⚠ Prozess beendet (1)" on its own is not a usable record of WHICH chat ended.
  if (typeof logEvent === 'function') logEvent(((tab && tab.title) ? tab.title + ': ' : '') + text, 'err');
  const { m } = addMsg('system', text, { error: true });
  const last = tab._lastSent;
  if (!last || !last.text) return m;
  const row = el('div', 'msg-retry');
  const again = el('button', '', '↻ ' + tt('chat-composer.erneutSenden'));
  again.type = 'button';
  again.onclick = () => { row.remove(); sendMessage({ text: last.text, attachments: last.attachments || [], tab }); };
  const back = el('button', '', tt('chat-composer.zurueckInDenComposer'));
  back.type = 'button';
  back.onclick = () => { row.remove(); composerSet(last.text, tt('chat-composer.wiederhergestellt')); };
  row.appendChild(again); row.appendChild(back);
  m.appendChild(row);
  if (tab === ACTIVE) scrollBottom();
  return m;
}
// render the attachments of a sent user message inline: pasted/loaded text is shown in FULL (scrollable
// code block), images as a thumbnail, PDFs as a labelled chip — so the transcript mirrors what was sent.
function renderMsgAttachments(atts) {
  const wrap = el('div', 'msg-attachments');
  atts.forEach((a) => {
    if (a.kind === 'image' && a.data) {
      const fig = el('div', 'msg-att is-img');
      const img = el('img'); img.src = 'data:' + (a.mediaType || 'image/png') + ';base64,' + a.data; img.alt = a.name || tt('chat-render.bild');
      fig.appendChild(img);
      if (a.name) fig.appendChild(el('div', 'msg-att-cap', a.name));
      wrap.appendChild(fig);
    } else if (a.kind === 'pdf') {
      wrap.appendChild(el('div', 'msg-att is-file', '📄 ' + (a.name || tt('chat-render.dokumentPdf'))));
    } else if (a.text != null) { // kind:'text' (pasted block or loaded text file)
      const box = el('div', 'msg-att is-paste');
      const head = el('div', 'msg-att-head');
      head.appendChild(el('span', 'msg-att-title', /^📋/.test(a.name || '') ? a.name : ('📋 ' + (a.name || tt('chat-render.eingefuegterText')))));
      if (a.lines) head.appendChild(el('span', 'msg-att-meta', a.lines + tt('chat-composer.zeilen')));
      box.appendChild(head);
      const pre = el('pre', 'paste-body'); pre.textContent = a.text;
      pre.appendChild(copyBtn(() => a.text, tt('chat-render.textKopieren')));
      box.appendChild(pre);
      wrap.appendChild(box);
    }
  });
  return wrap;
}

function ensureBubble(forceNew) {
  if (forceNew || !chat.current || chat.current.consumed) {
    const { b } = addMsg('assistant', '');
    b.classList.add('streaming');
    chat.current = { textEl: b, consumed: false, hasTools: false };
  }
  return chat.current;
}

function toolSummary(input) {
  try {
    if (input && typeof input === 'object') {
      if (input._truncated) return tt('chat-render.grosserInputZumAnsehen');
      if (input.command) return input.command;
      if (input.file_path) return input.file_path + (input.old_string ? '  (edit)' : '');
      if (input.pattern) return input.pattern + (input.path ? '  in ' + input.path : '');
      if (input.url) return input.url;
      if (input.query) return input.query;
      if (input.prompt) return input.prompt;
      return JSON.stringify(input);
    }
    return String(input == null ? '' : input);
  } catch { return ''; }
}
function isEditInput(name, input) {
  return input && !input._truncated && typeof input === 'object' &&
    (/edit|update|replace/i.test(name)) && typeof input.old_string === 'string' && typeof input.new_string === 'string';
}
function isWriteInput(name, input) {
  return input && !input._truncated && typeof input === 'object' &&
    (/^write$|create_file|str_replace_editor/i.test(name)) && typeof input.content === 'string';
}
// "vscode://file/C:/path" link for a file path (clickable jump to editor)
function fileHeader(fp) {
  const row = el('div', 'tc-file');
  row.appendChild(el('span', 'tc-file-path', fp));
  const uri = 'vscode://file/' + String(fp).replace(/\\/g, '/');
  const a = el('a', 'tc-file-open', tt('chat-render.inVsCodeOeffnen')); a.href = uri; a.title = uri;
  a.onclick = (e) => { e.stopPropagation(); };
  row.appendChild(a);
  return row;
}
// the CLI spawns subagents via the "Agent" tool (older builds: "Task") — match both
function isAgentTool(name) { return name === 'Agent' || name === 'Task'; }
// monitorCardInfo (the deadline arithmetic) lives in limits.js — pure and unit-tested there, next to
// the rate-limit arithmetic it shares its honesty rule with.
// The receipt (MonitorOutput: taskId · timeoutMs · persistent?) is a LAUNCH confirmation, not a result:
// whatever the watch observes arrives later as system/task_* frames carrying that same task id. Those
// frames match no agent lane, so before this they were dropped on the floor — an expiring watch
// reported to nobody. The card registers itself under its task id (chat-events.js) and collects them.
function monitorReceipt(card, out, tab) {
  if (!card || !out || typeof out !== 'object') return '';
  const taskId = String(out.taskId || out.task_id || '');
  const events = card.querySelector('.tcm-events');
  if (events) {
    const line = el('div', 'tcm-event');
    line.appendChild(el('span', 'tcm-when', fmtClock(Date.now())));
    line.appendChild(el('span', null, tt('chat-render.monitorGestartet') + (taskId || '?')));
    events.appendChild(line);
  }
  if (taskId && tab) { tab.watchCards = tab.watchCards || {}; tab.watchCards[taskId] = card; }
  return taskId;
}
// One system/task_* frame that belongs to a watch rather than to a subagent.
function monitorEvent(card, ev) {
  const events = card && card.querySelector('.tcm-events');
  if (!events) return;
  const status = String(ev.status || (ev.patch && ev.patch.status) || '').trim();
  const text = String(ev.summary || ev.description || '').trim();
  if (!status && !text) return;
  const line = el('div', 'tcm-event' + (/fail|error|timeout|expired/i.test(status) ? ' bad' : ''));
  line.appendChild(el('span', 'tcm-when', fmtClock(Date.now())));
  line.appendChild(el('span', null, (status ? status + (text ? ' · ' : '') : '') + text));
  events.appendChild(line);
  while (events.childElementCount > 40) events.removeChild(events.firstChild); // a chatty watch must not grow without bound
  card.open = true;
}
// emoji per subagent_type for the Agent tool (spawned agents)
function agentIcon(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('explore')) return '🔍';
  if (t.includes('plan')) return '📐';
  if (t.includes('guide')) return '📘';
  if (t.includes('statusline')) return '📊';
  if (t.includes('general')) return '🤖';
  return '🧩';
}
// A 600-line diff pushed everything else out of the window and there was no way to shorten it. Cap the height
// and offer „ganz anzeigen" (M4). Wraps the diff so the cap is a container property — the diff itself is
// untouched, so copy/pin and the word marks keep working.
const DIFF_MAX_LINES = 24;
function capDiffHeight(diffEl) {
  const lines = diffEl.childElementCount;
  if (lines <= DIFF_MAX_LINES) return diffEl;
  const wrap = el('div', 'diff-cap');
  wrap.appendChild(diffEl);
  const btn = el('button', 'diff-cap-btn');
  const paint = () => { btn.textContent = wrap.classList.contains('open') ? '▲ ' + tt('chat-render.weniger') : '▼ ' + tt('chat-render.ganzAnzeigen') + ' (' + lines + tt('chat-composer.zeilen') + ')'; };
  btn.onclick = (e) => { e.stopPropagation(); e.preventDefault(); wrap.classList.toggle('open'); paint(); };
  paint();
  wrap.appendChild(btn);
  return wrap;
}
// Same rows as renderDiff (render.js), but WITHOUT the per-changed-line word diff — that is a token-level LCS
// per line pair and it dominated the resume paint when ~200 historical cards were built at once. Only used for
// history; a live card still gets the word-level marks. (P4)
function renderDiffFast(oldStr, newStr, lang) {
  const wrap = el('div', 'diff');
  const rows = diffLines(oldStr, newStr);
  const big = rows.length > 300; // same threshold as renderDiff: skip highlighting on huge diffs
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    const cls = r.t === '+' ? 'add' : r.t === '-' ? 'del' : 'ctx';
    wrap.appendChild(diffRow(cls, r.t === '+' ? '+' : r.t === '-' ? '−' : ' ', (big ? diffEsc(r.s) : highlightCode(r.s, lang)) || '&nbsp;'));
  }
  return wrap;
}
function addToolCard(bubble, name, input, opts) {
  opts = opts || {};
  const diffFn = opts.silent ? renderDiffFast : renderDiff;
  // Tool display off → don't BUILD the card at all (P6). It was fully constructed (diff LCS, per-line syntax
  // highlighting, thousands of nodes) and then hidden by CSS — invisible work for invisible output.
  if (!DISPLAY.tools) return null;
  const card = el('details', 'tool-card');
  card.dataset.toolName = name; // the result handler needs to know WHICH tool this card belongs to
  const sum = el('summary');
  sum.appendChild(el('span', 'tc-caret', '▸'));
  sum.appendChild(el('span', 'tc-name', name));
  const oneLine = toolSummary(input).replace(/\s+/g, ' ').trim();
  if (oneLine) sum.appendChild(el('span', 'tc-sum', oneLine));
  card.appendChild(sum);
  let stepName = name, stepSum = oneLine; // what the "Schritte" timeline shows (overridden for agents)
  // U1 — computed ONCE, before the chain: a compact brief for the ten tools that used to render as raw
  // JSON (public/js/tool-brief.js). null for every other tool, so the chain below is unchanged for them.
  const brief = (typeof toolBrief === 'function') ? toolBrief(name, input) : null;

  if (isAgentTool(name) && input && typeof input === 'object' && input.subagent_type) {
    // spawned agent → dedicated card: icon + subagent type + description; prompt collapsed inside
    const type = input.subagent_type || 'agent';
    const icon = agentIcon(type);
    const desc = (input.description || '').trim();
    card.classList.add('is-agent');
    const nm = sum.querySelector('.tc-name'); if (nm) nm.textContent = icon + ' ' + type;
    const sm = sum.querySelector('.tc-sum'); if (sm) sm.remove();
    if (desc) sum.appendChild(el('span', 'tc-sum', '„' + desc + '"'));
    stepName = icon + ' ' + type; stepSum = desc || type;
    // #34 — the rail row for this agent is gone two minutes after it finished; the card in the
    // transcript is not. `opts.toolId` is the tool_use id, i.e. the lane id, so the card can reopen
    // the same detail view later from the tab's archive. Hidden when the lane is unknown (a resumed
    // transcript has cards but no lanes — nothing to show, so nothing is promised).
    if (opts.toolId) {
      const btn = el('button', 'tc-agent-open', '🤖 ' + tt('chat-render.agentDetails'));
      btn.type = 'button'; btn.title = tt('chat-render.agentDetailsTitel');
      btn.onclick = (e) => {
        e.stopPropagation(); e.preventDefault();
        const lane = (typeof agentLaneById === 'function') ? agentLaneById(ACTIVE, opts.toolId) : null;
        if (lane) agentDetailShow(lane, ACTIVE);
        else toast(tt('chat-render.agentKeineDetails'), 'warn');
      };
      sum.appendChild(btn);
    }
    if (input.prompt) {
      const body = el('div', 'tc-agent-body');
      body.appendChild(el('div', 'tc-agent-label', tt('chat-render.auftrag')));
      const pre = el('pre'); pre.textContent = String(input.prompt);
      pre.appendChild(copyBtn(() => String(input.prompt), tt('chat-render.promptKopieren')));
      body.appendChild(pre);
      card.appendChild(body);
    }
  } else if (name === 'Monitor' && input && typeof input === 'object') {
    // A `Monitor` is a BACKGROUND WATCH, and the generic JSON card hid what matters about it: what is
    // being watched and until when. Its schema is read, not guessed (sdk-tools.d.ts MonitorInput):
    // description · timeout_ms (default 300000, capped at 1800000) · command OR ws{url,protocols}.
    // Measured: `Monitor` really is in a session's tool list (143 tools on this account).
    const mi = monitorCardInfo(input);
    card.classList.add('is-monitor');
    const nm = sum.querySelector('.tc-name'); if (nm) nm.textContent = '👁 Monitor';
    const sm = sum.querySelector('.tc-sum'); if (sm) sm.textContent = mi.desc || mi.what || '';
    const body = el('div', 'tc-monitor');
    if (mi.what) {
      const row = el('div', 'tcm-row');
      row.appendChild(el('span', 'tcm-key', mi.ws ? tt('chat-render.monitorWs') : tt('chat-render.monitorKommando')));
      const v = el('code', 'tcm-val', mi.what); v.title = mi.what;
      row.appendChild(v);
      body.appendChild(row);
    }
    const dl = el('div', 'tcm-row');
    dl.appendChild(el('span', 'tcm-key', tt('chat-render.monitorFrist')));
    // The CLI kills the watch at the deadline and says so; an absolute time answers „is this still
    // running?" without arithmetic. `persistent` (timeout 0) is a different statement and gets its own.
    dl.appendChild(el('span', 'tcm-val', mi.persistent ? tt('chat-render.monitorOhneFrist')
      : (fmtClock(mi.deadlineMs) + ' (' + tt('chat-render.monitorNochN').replace('{n}', Math.round(mi.timeoutMs / 60000)) + ')')));
    body.appendChild(dl);
    body.appendChild(el('div', 'tcm-events'));  // filled by the receipt and by later task frames
    card.appendChild(body);
    card.open = true;
  } else if (name === 'TodoWrite' && input && Array.isArray(input.todos)) {
    const list = el('div', 'todo-list');
    const done = input.todos.filter((t) => t.status === 'completed').length;
    sum.querySelector('.tc-sum') && sum.querySelector('.tc-sum').remove();
    sum.appendChild(el('span', 'tc-sum', done + '/' + input.todos.length + tt('chat-render.erledigt')));
    input.todos.forEach((t) => list.appendChild(todoRow(t)));
    card.appendChild(list);
    card.classList.add('is-todo'); card.open = true;
  } else if (brief) {
    // U1 — ten tools that used to be a blob of escaped JSON. The worst of them was `Workflow`: measured,
    // 42 of 51 calls pass the whole script INLINE in `script`, so the card was a 40-line program on one
    // line. What the brief decides lives in public/js/tool-brief.js; this is only the paint.
    card.classList.add('is-brief');
    const nm = sum.querySelector('.tc-name'); if (nm) nm.textContent = brief.icon + ' ' + brief.title;
    const sm = sum.querySelector('.tc-sum');
    const sumText = brief.sumKey ? tt(brief.sumKey) : brief.sum;
    if (sm) { if (sumText) sm.textContent = sumText; else sm.remove(); }
    else if (sumText) sum.appendChild(el('span', 'tc-sum', sumText));
    stepName = brief.icon + ' ' + brief.title; stepSum = sumText || brief.title;
    if (brief.rows.length) {
      const body = el('div', 'tc-brief');
      brief.rows.forEach((r) => {
        const row = el('div', 'tcb-row');
        row.appendChild(el('span', 'tcb-key', tt(r.key)));
        // `valKey` is the module's own flag, never a guess from the string's shape — a ToolSearch query
        // that happens to read like a key must stay the user's text (see tool-brief.js toolBrief).
        const v = el('span', 'tcb-val', r.valKey ? tt(r.val) : r.val);
        v.title = r.valKey ? tt(r.val) : r.val;
        row.appendChild(v);
        body.appendChild(row);
      });
      card.appendChild(body);
    }
    // The long text is NOT dropped on the way to a compact card: it moves into the card's body, where the
    // caret opens it. Throwing away what the model really sent is the mirror of inventing something.
    if (brief.body) {
      const lbl = el('div', 'tcb-label', tt(brief.body.key));
      card.appendChild(lbl);
      const pre = el('pre'); pre.textContent = brief.body.text;
      pre.appendChild(copyBtn(() => brief.body.text, tt('common.kopieren')));
      card.appendChild(pre);
    }
  } else if (isEditInput(name, input)) {
    const lang = extLang(input.file_path);
    sum.appendChild(pinBtn(() => sidecarShow({ title: input.file_path || tt('common.bearbeiten'), raw: input.new_string, old: input.old_string, lang, kind: 'diff' })));
    const body = el('div', 'tc-diff-body');
    if (input.file_path) body.appendChild(fileHeader(input.file_path));
    body.appendChild(capDiffHeight(diffFn(input.old_string, input.new_string, lang)));
    body.appendChild(copyBtn(() => input.new_string, tt('chat-render.neuenCodeKopieren')));
    card.appendChild(body);
    card.classList.add('is-diff');
  } else if (isWriteInput(name, input)) {
    const lang = extLang(input.file_path);
    sum.appendChild(pinBtn(() => sidecarShow({ title: input.file_path || tt('chat-render.schreiben'), raw: input.content, lang, kind: 'code' })));
    const body = el('div', 'tc-diff-body');
    if (input.file_path) body.appendChild(fileHeader(input.file_path));
    body.appendChild(capDiffHeight(diffFn('', input.content, lang))); // new file -> all additions
    body.appendChild(copyBtn(() => input.content, tt('html.inhaltKopieren')));
    card.appendChild(body);
    card.classList.add('is-diff');
  } else {
    let full = '';
    try {
      if (input && input._truncated) full = input.preview || '';
      else full = (input && typeof input === 'object') ? JSON.stringify(input, null, 2) : String(input == null ? '' : input);
    } catch { full = oneLine; }
    if (full.length > 6000) full = full.slice(0, 6000) + '…';
    const pre = el('pre'); pre.innerHTML = highlightCode(full, 'json');
    const cmd = (input && typeof input === 'object' && input.command) ? input.command : full;
    pre.appendChild(copyBtn(() => cmd, tt('common.kopieren')));
    card.appendChild(pre);
  }
  bubble.parentElement.appendChild(card);
  // register a timeline step for this turn — historical cards don't: "Schritte" is the CURRENT turn's timeline,
  // and a resume used to fill it with 200 steps whose cards then scrolled out of the cap anyway (P5)
  if (name !== 'TodoWrite' && !opts.silent) {
    const step = { name: stepName, summary: stepSum, card, status: 'running' };
    card._step = step; chat.steps.push(step);
    if (chat === ACTIVE) scheduleSteps();
  }
  if (!opts.silent) scrollBottom(); // history paint scrolls once at the end instead of per card (P5)
  return card;
}
// append a tool output/result section inside a tool card
function addToolOutput(card, text, isError, opts) {
  opts = opts || {};
  // Don't pin the full ≤200KB output in the paint/copy closures — cap what we retain per card;
  // the complete output always stays in the Sessions transcript. Bounds tool-heavy sessions.
  const RETAIN = 24000;
  if (text && text.length > RETAIN) text = text.slice(0, RETAIN) + tt('chat-render.gekuerztVollstaendigeAusgabeIm');
  const out = el('div', 'tc-out' + (isError ? ' err' : ''));
  out.appendChild(el('div', 'tc-out-label', isError ? '⎿ ' + tt('common.fehler') : '⎿ ' + tt('chat-render.ausgabe')));
  const pre = el('pre');
  const LIMIT = 2000; const long = text.length > LIMIT; let expanded = false;
  const paint = () => { pre.textContent = (long && !expanded) ? text.slice(0, LIMIT) : text; pre.appendChild(copyBtn(() => text, tt('chat-render.ausgabeKopieren'))); };
  paint(); out.appendChild(pre);
  if (long) {
    const more = el('button', 'tc-more');
    const setLabel = () => { more.textContent = expanded ? '▲ ' + tt('chat-render.weniger') : '▼ ' + tt('chat-render.mehrAnzeigen') + (typeof fmtNum === 'function' ? fmtNum(text.length) : text.length) + tt('chat-render.zeichen'); };
    more.onclick = (e) => { e.stopPropagation(); expanded = !expanded; paint(); setLabel(); };
    setLabel(); out.appendChild(more);
  }
  card.appendChild(out);
  card.classList.add('has-out');
  if (isError) card.open = true;
  if (card._step) { card._step.status = isError ? 'error' : 'done'; if (chat === ACTIVE && !opts.silent) scheduleSteps(); }
}
// --- agent timeline (per-turn tool steps, jump-to) ---
function resetSteps() { if (chat) chat.steps = []; if (chat === ACTIVE) scheduleSteps(); }
// renderSteps rebuilds the pill (and the popover when open) and walked the step list twice. It was called once
// per tool card AND once per tool output — up to 2× per tool — and on resume once per historical card. One paint
// per frame is enough; the history paint passes silent and paints once at the end. (P5)
let _stepsRAF = false;
function scheduleSteps() { if (_stepsRAF) return; _stepsRAF = true; requestAnimationFrame(() => { _stepsRAF = false; renderSteps(); }); }
function renderSteps() {
  const btn = $('#stepsBtn'), pop = $('#stepsPop');
  const steps = (ACTIVE && ACTIVE.steps) || [];
  let running = 0, errs = 0; // one pass instead of two .filter() walks
  for (let i = 0; i < steps.length; i++) { const st = steps[i].status; if (st === 'running') running++; else if (st === 'error') errs++; }
  btn.innerHTML = ic('steps', 16) + '<span class="btxt">' + tt('common.schritte') + (steps.length ? ' (' + steps.length + ')' : '') + '</span>';
  btn.classList.toggle('has-err', errs > 0);
  btn.classList.toggle('busy', running > 0);
  if (pop.classList.contains('hidden')) return;
  pop.innerHTML = '';
  if (!steps.length) { pop.appendChild(el('div', 'steps-empty', tt('chat-render.nochKeineToolSchritte'))); return; }
  steps.forEach((s, i) => {
    const it = el('div', 'step-item ' + s.status);
    it.appendChild(el('span', 'step-mark', s.status === 'done' ? '✓' : s.status === 'error' ? '✕' : '◐'));
    it.appendChild(el('span', 'step-name', s.name));
    if (s.summary) it.appendChild(el('span', 'step-sum', s.summary));
    it.onclick = () => { if (!s.card || !s.card.isConnected) { toast(tt('chat-render.schrittNichtMehrImVerlauf'), 'err'); return; } s.card.open = true; s.card.scrollIntoView({ block: 'center' }); s.card.classList.add('flash'); setTimeout(() => s.card.classList.remove('flash'), 1200); };
    mkClickable(it);
    pop.appendChild(it);
  });
}
$('#stepsBtn').onclick = (e) => { e.stopPropagation(); const p = $('#stepsPop'); p.classList.toggle('hidden'); $('#stepsBtn').setAttribute('aria-expanded', String(!p.classList.contains('hidden'))); renderSteps(); };
$('#stepsPop').onclick = (e) => e.stopPropagation();
document.addEventListener('click', () => { $('#stepsPop').classList.add('hidden'); $('#stepsBtn').setAttribute('aria-expanded', 'false'); });

// --- live "aktive Agenten" lanes: one row per Task/Agent sub-agent ---
// WHEN a lane starts, when it may end and what it is allowed to say lives in the pure module
// public/js/agent-lanes.js (tested in test/agent-lanes.test.js) — this file only paints it. The split
// exists because both #32 bugs were single wrong lines in the event pump with no way to test them.
function agentLanes(tab) { if (!tab) return []; if (!tab.agents) tab.agents = []; return tab.agents; }
function agentRepaint(tab, changed) {
  if (changed && tab === ACTIVE) renderAgentStrip();
  agentArchive(tab);
  // CHAT-FLOW-5 — a lane that ends may have been the last thing a deferred restart waited for (quiet: the
  // CLI may still follow up on the agent's report, see maybeApplyPendingRunCfg)
  if (changed && tab && tab.pendingRunCfg && typeof maybeApplyPendingRunCfg === 'function') maybeApplyPendingRunCfg(tab, { quiet: true });
  return !!changed;
}
// A finished lane keeps its row for two minutes and is then dropped (LANE_AFTERGLOW_MS). The DETAIL
// view must outlive that: you open it, read for three minutes, and the panel would go blank under you —
// and the agent's tool card in the transcript would have nothing left to open. So every lane is
// mirrored here, newest 30 per tab, and agentLaneById() falls back to this snapshot. It is deliberately
// a mirror of the same objects, not a copy: a lane that is still running keeps updating through it.
const AGENT_ARCHIVE_MAX = 30;
function agentArchive(tab) {
  if (!tab) return;
  if (!tab.agentArchive) tab.agentArchive = {};
  const lanes = tab.agents || [];
  for (const a of lanes) if (a && a.id) tab.agentArchive[a.id] = a;
  const ids = Object.keys(tab.agentArchive);
  if (ids.length <= AGENT_ARCHIVE_MAX) return;
  // oldest first by start time — a lane without one sorts old, which is the safe direction
  ids.sort((x, y) => ((tab.agentArchive[x] || {}).start || 0) - ((tab.agentArchive[y] || {}).start || 0));
  for (const id of ids.slice(0, ids.length - AGENT_ARCHIVE_MAX)) delete tab.agentArchive[id];
}
// the Agent tool_use appeared in an assistant frame → the lane opens. `input` is passed whole: model
// override, isolation, run_in_background and the prompt are all lane content now (#33).
function trackAgentStart(tab, id, input) {
  if (!tab || !id) return;
  laneStart(agentLanes(tab), { id, input });
  agentRepaint(tab, true);
}
// A tool_result naming this lane. NOT automatically its end: a backgrounded agent answers its own call
// with `status: "async_launched"` a second after the start (#32) — agent-lanes.js decides which it is.
function agentToolResult(tab, id, isError, out) {
  if (!tab || !id || !tab.agents || !tab.agents.length) return;
  let changed = laneToolResult(tab.agents, { id, isError, out });
  // U1 — the Workflow tool's own receipt carries runId · transcriptDir · workflowName · scriptPath, and
  // all four used to be dropped on the floor (public/js/workflow-lanes.js wfApplyLaunch has the
  // measurement). `transcriptDir` is carried for PR-13, the rest is what the ⚙ group's head says.
  if (typeof wfApplyLaunch === 'function') {
    const lane = laneFind(tab.agents, id);
    if (lane && wfApplyLaunch(lane, out)) changed = true;
  }
  agentRepaint(tab, changed);
}
// system/task_* + background_tasks_changed — the authoritative lifecycle. task_progress deliberately
// reports "nothing structural changed": its numbers are written in place by tickAgentMeta.
// …and `task_progress.workflow_progress[]` on top, which is the whole fan-out of a workflow run — read by
// public/js/workflow-lanes.js. Called NEXT to laneSystemEvent, not from inside it: agent-lanes.js has no
// dependencies and keeps none, so both halves stay separately testable. Both are always asked, never one
// or the other: the SAME frame carries the lane's live numbers and the run's structure.
function agentSystemEvent(tab, ev) {
  if (!tab || !ev) return;
  const lanes = agentLanes(tab);
  const a = laneSystemEvent(lanes, ev);
  const b = (typeof wfSystemEvent === 'function') ? wfSystemEvent(lanes, ev, Date.now()) : false;
  agentRepaint(tab, a || b);
}
// a `result` frame retires the lanes that really ended — see agent-lanes.js lanesAfterResult (#32)
function agentsAfterResult(tab, ev) {
  const before = (tab && tab.agents) || [];
  if (!before.length) return;
  const after = lanesAfterResult(before, ev);
  tab.agents = after;
  agentRepaint(tab, after.length !== before.length);
}
function clearAgents(tab) { if (tab && tab.agents && tab.agents.length) { tab.agents = []; agentRepaint(tab, true); } }
// Stop: the interrupt is a control_request, the CLI process stays alive — so NO `_exit` arrives and
// nothing else would ever tell these lanes that their agents were killed with the turn (`killed.parent`).
// Marked as aborted rather than deleted, so the rail says why they stopped; the `result` frame that ends
// every interrupted turn retires them a moment later (they are no longer running).
function agentsAborted(tab) {
  const lanes = (tab && tab.agents) || [];
  let changed = false;
  lanes.forEach((a) => { if (a.status === 'running' && laneFinish(a, { isError: true, aborted: true })) changed = true; });
  agentRepaint(tab, changed);
}
// per-agent elapsed seconds (live while running, the agent's own reported duration once done) (#24)
function agentElapsed(a) { return Math.max(0, Math.round(laneElapsedMs(a) / 1000)); }
let AGENT_TIMER = null;
function ensureAgentTimer() {
  const lanes = (ACTIVE && ACTIVE.agents) || [];
  // Any lane at all keeps the ticker alive, not just a running one: a FINISHED lane expires on the
  // clock (LANE_AFTERGLOW_MS), and a turn can end minutes before anything else happens in the chat.
  // Tied to `running` only, the row of a finished agent would sit there until the next frame — i.e.
  // possibly for the rest of the session. The ticker stops itself once the list is empty.
  if (lanes.length && !AGENT_TIMER) AGENT_TIMER = setInterval(tickAgentMeta, 1000);
  else if (!lanes.length && AGENT_TIMER) { clearInterval(AGENT_TIMER); AGENT_TIMER = null; }
}
// Update only the RUNNING rows — elapsed, the live line (activity · tokens · tool calls) AND the row
// tooltip — in place. Not through renderAgentStrip: that rebuilds the entire rail (incl. every grant chip),
// and the CLI sends a task_progress per agent every ~2 s, so a repaint per update would flicker for nothing.
// The tooltip HAS to travel with the live line: it carries the same live facts in long form (current
// activity, last tool, tokens, tool calls), and lanesSig() deliberately leaves those out — so without this
// a background agent's tooltip would stay empty (or keep a stale sibling-repaint state) for its whole run.
function tickAgentMeta() {
  const lanes = (ACTIVE && ACTIVE.agents) || [];
  // …and the guard against the opposite of #32: a background agent whose end never arrives (lost frame,
  // killed helper) would otherwise spin for the rest of the session → closed as „no signal any more".
  if (lanesPruneStale(lanes)) {
    renderAgentStrip();
    if (ACTIVE && ACTIVE.pendingRunCfg && typeof maybeApplyPendingRunCfg === 'function') maybeApplyPendingRunCfg(ACTIVE, { quiet: true });
    return;
  }
  // #34 — a finished lane leaves on the clock, two minutes after it ended. Identity change = something
  // was dropped; the archive (agentArchive) has already kept a snapshot, so an open detail panel and
  // the „🤖 Details" button on the tool card keep working after the row is gone.
  if (ACTIVE) {
    const kept = lanesPruneFaded(lanes);
    if (kept !== lanes) { ACTIVE.agents = kept; renderAgentStrip(); return; }
    // G6 — the one thing that changes a row with NO frame arriving: a requested stop whose confirmation
    // window runs out. „Stopp angefordert…" has to become „unbestätigt" on the clock, because a `stop_task`
    // success is also what a task nobody could find answers. Guarded by the signature so this costs one
    // repaint per transition and not one per second; the click handler seeds `_stopSig`, so a fresh request
    // does not pay for a second repaint here.
    const ssig = stopSig(lanes);
    if (ssig !== (ACTIVE._stopSig || '')) { ACTIVE._stopSig = ssig; renderAgentStrip(); return; }
  }
  const byId = {};
  lanes.forEach((a) => { byId[a.id] = a; });
  document.querySelectorAll('.agent-item.running').forEach((it) => {
    const a = byId[it.dataset.agentLane]; if (!a) return;
    const m = laneMetrics(a); // ONE snapshot for all three writes, so they cannot disagree by a tick
    const meta = it.querySelector('.agent-meta');
    if (meta) meta.textContent = '⏱ ' + Math.max(0, Math.round((m.elapsedMs || 0) / 1000)) + 's';
    const live = it.querySelector('.agent-live'); if (live) live.textContent = agentLiveText(m);
    // only on a real change: re-assigning `title` every second would dismiss an already open tooltip
    const title = agentLaneTitle(m); if (it.title !== title) it.title = title;
  });
  // U1 — the same in-place write for the ⚙ group's head: the RUN's own clock. Its own loop and its own
  // attribute, so neither selector can pick up the other's rows, and only the ONE number that ticks is
  // rewritten — the phase rows and the agent rows below it change on frames, not on the clock (their time is
  // the runtime's own `durationMs` / the age at its last report, both of which arrive with a frame).
  document.querySelectorAll('.wf-head.running').forEach((it) => {
    const a = byId[it.dataset.wfLane]; if (!a) return;
    const t = it.querySelector('.wf-head-time');
    if (t) t.textContent = '⏱ ' + Math.max(0, Math.round(laneElapsedMs(a) / 1000)) + 's';
  });
  ensureAgentTimer(); // self-stop once nothing is running
}
// short number for the lane (thousands as K) — same reading as the status strip's Σ chip
function agentNum(n) { return (typeof fmtNum === 'function') ? fmtNum(n) : String(n); }
// ⏳ background · ☁ remote cloud session · 🌿 own worktree. Only from fields the CLI actually sent.
// The hourglass is a statement about NOW („keeps running in the background — this row stays until the
// agent reports back"), so it hangs on m.live, not on m.bg alone: a backgrounded lane that has already
// reported back carries √ + its final numbers, and an hourglass next to those is simply false — with two
// parallel agents the rail showed the same background promise on both rows while only one of them ran (#33).
function agentBadges(m) {
  const out = [];
  const add = (txt, title) => { const b = el('span', 'agent-badge', txt); b.title = title; out.push(b); };
  if (m.sessionUrl) add('☁', tt('chat-render.agentRemote'));      // WHERE it ran — stays true once it is over
  else if (m.bg && m.live) add('⏳', tt('chat-render.agentHintergrund'));
  const iso = m.worktreeBranch || ((m.isolation && m.isolation !== 'none') ? m.isolation : '');
  if (iso) add('🌿', tt('chat-render.agentIsolation') + iso);
  return out;
}
// Third line WHILE RUNNING: what this agent is doing right now, and its own live counters
// (system/task_progress: description → current activity, last_tool_name, usage.total_tokens, tool_uses).
// The MODEL belongs here too (#33): the status strip names the model of the running turn for the whole
// turn, and „alle Infos, die im normalen Chat Status auch angezeigt werden" is the ask — while the lane
// had it only on finished rows and in the tooltip, although a backgrounded agent's launch receipt reports
// `resolvedModel` at the very start (and it can be a different model than the turn's, e.g. `model: 'sonnet'`
// on an Opus turn — exactly the case where reading the strip instead is wrong). Same shortening as the
// finished row (menu label, else the api id without its `claude-` prefix) and behind `m.model`, so an
// agent whose model nobody reported shows nothing rather than „undefined"; it sits AFTER the activity so
// the ellipsis of a narrow rail eats the static id first, not the line that changes every 2 s.
function agentLiveText(m) {
  const parts = [];
  const act = m.phase || m.lastTool;
  if (act) parts.push('▸ ' + act);
  if (m.model) parts.push(((typeof modelMenuLabel === 'function' && modelMenuLabel(m.model)) || shortModel(m.model)));
  if (m.tokens) parts.push('Σ ' + agentNum(m.tokens) + ' tok');
  if (m.toolUses) parts.push('🔧 ' + m.toolUses);
  return parts.join(' · ');
}
// Third line ONCE DONE: the totals the agent reported about itself. The cost only appears when the
// per-token-type usage came with it (AgentOutput) — a backgrounded agent only reports total_tokens, and
// a total cannot be priced (cache reads cost a tenth of fresh input). No estimate is better than a wrong one.
function agentStatsText(m) {
  const parts = [];
  if (m.model) parts.push(((typeof modelMenuLabel === 'function' && modelMenuLabel(m.model)) || shortModel(m.model)));
  if (m.tokens) parts.push('Σ ' + agentNum(m.tokens) + ' tok');
  const cost = (m.usage && typeof turnCostUSD === 'function') ? turnCostUSD(m.usage, m.model) : 0;
  if (cost > 0) parts.push((typeof fmtUSD === 'function') ? fmtUSD(cost) : '$' + cost.toFixed(4));
  if (m.toolUses) parts.push('🔧 ' + m.toolUses);
  if (m.linesAdded || m.linesRemoved) parts.push('+' + (m.linesAdded || 0) + '/−' + (m.linesRemoved || 0));
  return parts.join(' · ');
}
// The long form goes in the tooltip, so the row stays two/three short lines even in a 160px rail (#33):
// prompt, agent id, summary, the tool breakdown — and the honest note that these tokens are a SUBSET of
// the session Σ, not an extra bill.
function agentLaneTitle(m) {
  const L = [m.type + (m.desc ? ' · ' + m.desc : '')];
  if (m.sessionUrl) L.push(tt('chat-render.agentRemote'));
  else if (m.bg && m.live) L.push(tt('chat-render.agentHintergrund')); // present tense → only while it runs
  if (m.stale) L.push(tt('chat-render.agentKeinSignal'));
  if (m.aborted) L.push(tt('chat-render.agentAbgebrochen'));
  if (m.phase) L.push(tt('chat-render.agentAktuell') + m.phase);
  if (m.lastTool) L.push(tt('chat-render.agentLetztesTool') + m.lastTool);
  if (m.model) L.push(tt('chat-render.agentModell') + (((typeof modelMenuLabel === 'function' && modelMenuLabel(m.model)) || shortModel(m.model)) + (m.modelsUsed ? ' (' + m.modelsUsed.map(laneModelId).map(shortModel).join(' → ') + ')' : '')));
  if (m.tokens) L.push(tt('chat-render.agentTokens') + fmtInt(m.tokens) + tt('chat-render.agentTokensHinweis')); // NUM-LOC: the PANEL's language, not the browser's
  if (m.toolUses) L.push(tt('chat-render.agentToolAufrufe') + m.toolUses);
  const cost = (m.usage && typeof turnCostUSD === 'function') ? turnCostUSD(m.usage, m.model) : 0;
  if (cost > 0) L.push(tt('chat-render.agentKosten') + ((typeof fmtUSD === 'function') ? fmtUSD(cost) : '$' + cost.toFixed(4)));
  // no duration line while it runs: the row's ⏱ ticks every second, a tooltip built once would lie
  if (!m.live) L.push(tt('chat-render.agentDauer') + Math.max(0, Math.round((m.elapsedMs || 0) / 1000)) + 's');
  const tools = [];
  if (m.reads) tools.push(m.reads + '× Read');
  if (m.searches) tools.push(m.searches + '× Search');
  if (m.bash) tools.push(m.bash + '× Bash');
  if (m.edits) tools.push(m.edits + '× Edit');
  if (m.linesAdded || m.linesRemoved) tools.push('+' + (m.linesAdded || 0) + '/−' + (m.linesRemoved || 0));
  if (tools.length) L.push(tt('chat-render.agentWerkzeuge') + tools.join(' · '));
  if (m.summary) L.push(tt('chat-render.agentErgebnis') + m.summary.replace(/\s+/g, ' ').slice(0, 300));
  if (m.agentId) L.push(tt('chat-render.agentIdLabel') + m.agentId);
  if (m.prompt) L.push(tt('chat-render.agentAuftrag') + m.prompt.replace(/\s+/g, ' ').slice(0, 300));
  return L.join('\n');
}
// ---- G6: stopping ONE lane -----------------------------------------------------------------------------
// The ⏹ button of a row, plus the chip that says what came of pressing it. Everything it decides lives in
// public/js/task-stop.js; this is only the paint.
//
// Three properties worth stating, because each of them is a bug that was available here:
//  1. `e.stopPropagation()` is mandatory. The row itself is clickable (it opens the detail sidecar), so
//     without it this button would open that panel as well.
//  2. The button is DISABLED while the lane has no `taskId`. `stop_task` takes exactly one argument and
//     there is nothing to fall back on — laneStart() creates the lane from the assistant frame, before any
//     task_* frame, so the window is real. A guess here would stop somebody else's task.
//  3. It is NOT the interrupt path. interruptTab() ends the whole turn and, around it, empties the queue,
//     retires the plan cards and marks EVERY lane aborted (that shared path is what CHAT-FLOW-9 was).
//     This one writes a single control request and touches nothing else.
function agentStopParts(a, tab) {
  const out = [];
  if (!a) return out;
  const target = stopTaskTarget(a);
  // The button appears exactly when stopTaskTarget would ACCEPT a request — one evaluation, so the row and
  // the lock can never disagree. 'already' is the single reason that hides it instead of disabling it: the
  // chip right next to it says „Stopp angefordert…", and a greyed-out ⏹ beside that sentence says nothing
  // more. Everything else (no id yet) stays visible and disabled WITH a reason in the tooltip.
  // Why this is not `!a.stopAt || a.stopError`: nothing ever resets `stopAt`, so that test hid the button
  // for good after a stop whose success nobody confirmed — i.e. in the one state where the agent may still
  // be running and a second attempt is the only thing left short of interrupting the whole turn.
  if (a.status === 'running' && target.reason !== 'already') {
    const b = el('button', 'agent-stop', '⏹');
    b.type = 'button';
    const workflow = stopTaskScope(a) === 'workflow';
    // The WORDING follows the measurement: a workflow carries ONE task_id for its whole fan-out, so this
    // button stops the entire workflow and may not pretend to pick one agent out of it.
    b.title = target.ok ? tt(workflow ? 'chat-render.agentStoppWorkflowTooltip' : 'chat-render.agentStoppTooltip')
      : tt(target.reason === 'no-task-id' ? 'chat-render.agentStoppKeineId' : 'chat-render.agentStoppNichtMoeglich');
    b.disabled = !target.ok;
    b.setAttribute('aria-label', b.title);
    b.onclick = (e) => { e.stopPropagation(); if (target.ok) agentStopClick(a, tab); };
    out.push(b);
  }
  const v = stopView(a);
  if (v.state === 'none') return out;
  // 'stopped' is the ONLY state allowed to read „gestoppt". 'ended' exists because the opposite claim is
  // just as wrong: the lane is over, but a `stop_task` success can also be the CLI smoothing over a task
  // that had already finished — so the row says „beendet, ob der Stopp es war, ist unbestätigt".
  const cls = v.state === 'stopped' ? 'ok' : v.state === 'pending' ? 'wait' : 'bad';
  const chip = el('span', 'agent-stopnote ' + cls, tt(v.key));
  chip.title = v.error || tt(v.key);
  out.push(chip);
  return out;
}
// The click. Marks the lane as „stop requested" BEFORE the request (so the row stops offering a button it
// has already fired) and then reports only what happened to the REQUEST — never that the agent stopped.
// That verdict can only come from the CLI's own `task_updated {status:'killed'}` / `task_notification
// {status:'stopped'}`, which agent-lanes.js lands on the lane; until then stopView() says „angefordert" and,
// after its window, „unbestätigt".
async function agentStopClick(a, tab) {
  const target = stopTaskTarget(a);
  if (!target.ok) return;
  if (!tab || !tab.id) { toast(tt('chat-render.agentStoppKeineSitzung'), 'err'); return; }
  stopTaskMark(a, Date.now());
  // The ticker watches this signature for the „angefordert → unbestätigt" flip; seeding it here keeps that
  // transition the ONLY repaint the clock causes (the repaint for the mark itself happens right below).
  tab._stopSig = stopSig(tab.agents);
  agentRepaint(tab, true);
  try {
    const r = await api('/api/chat/' + tab.id + '/stop-task', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: target.taskId }),
    });
    // Deliberately NO success toast: „ok" here means the control request was answered, and the CLI answers
    // `success` for a task it could not find as well as for one it really killed. The row's chip is the
    // honest report, and it only turns into „gestoppt" when a frame says so.
    if (r && r.unconfirmed) toast(tt('chat-render.agentStoppOhneAntwort'), 'err');
  } catch (e) {
    // A refusal is kept ON the lane, not only in the toast: the toast is gone in four seconds while
    // „why is this agent still running" stays a question. What is kept is the CLI's SENTENCE („No task found
    // with ID: …", „Task x is not running (status: …)", „… is owned by …", „Unsupported task type: …") —
    // the wire carries no code next to it, see public/js/task-stop.js.
    stopTaskFailed(a, e.message);
    toast(tt('chat-render.agentStoppAbgelehnt') + ': ' + e.message, 'err');
  }
  tab._stopSig = stopSig(tab.agents);
  agentRepaint(tab, true);
}
// U1 — the two halves of ACTIVE.agents. A workflow lane lives in the SAME list (it is created by the same
// `task_started` frame, keyed on the same tool_use id) but it gets its own rail group, because one row
// cannot say „this is a whole fan-out of eleven agents across three phases". Split in ONE place so the two
// groups can never both claim the same lane — or both skip it.
function agentLaneSplit(tab) {
  const lanes = (tab && tab.agents) || [];
  const isWf = (typeof wfIsWorkflow === 'function') ? wfIsWorkflow : () => false;
  return { plain: lanes.filter((a) => !isWf(a)), workflows: lanes.filter((a) => isWf(a)) };
}
// The counts of that split, for every reader that NAMES what it counts — the 🤖 in the status strip and on the
// collapsed rail, the ⚙ next to it, „wartet auf N Agenten". The 🤖 group was the only reader that used the
// split, and every other one went on counting a workflow as „1 Agent": a running workflow and nothing else
// made the strip say „🤖 1" over a rail with no 🤖 group in it, and a click on that badge opened the detail
// view of the workflow lane (agentDetailShow), which has nothing to show for one (no outputFile; docs/ideas.md
// U5). One function, so 🤖 means the same thing everywhere.
// NOT for the rail's fold decision: there a running workflow is pending work like any lane (railAutoAction is
// handed the UNSPLIT list on purpose, see chat-side.js chatSideRefresh).
function agentLaneCounts(tab) {
  const s = agentLaneSplit(tab);
  const live = (l) => l.filter((a) => a && a.status === 'running').length;
  const bad = (l) => l.some((a) => a && a.status === 'error');
  return {
    plain: s.plain.length, plainRunning: live(s.plain), plainError: bad(s.plain),
    workflows: s.workflows.length, wfRunning: live(s.workflows), wfError: bad(s.workflows),
  };
}
// One row per subagent with a state icon (running spinner · done √ · error ✕). This is the single
// builder for that row; the approvals rail renders it (chat-side.js), so the rows look the same
// wherever they end up.
function agentRows() {
  const lanes = agentLaneSplit(ACTIVE).plain;
  return lanes.map((a) => {
    const m = laneMetrics(a);
    // `faded` = finished and living on borrowed time (#34). Dimming it is the only honest way to say
    // "this row is a record, not activity" without adding a word to a 220px line.
    const it = el('div', 'agent-item ' + a.status + (a.stale ? ' stale' : '') + (a.status !== 'running' ? ' faded' : ''));
    it.dataset.agentLane = a.id; // the ticker finds its lane through this (no re-render needed)
    const mark = el('span', 'todo-mark agent-mark');
    if (a.status === 'running') mark.appendChild(el('span', 'ca-spin'));
    else mark.textContent = a.status === 'error' ? '✕' : '√';
    it.appendChild(mark);
    it.appendChild(el('span', 'agent-ico', agentIcon(m.type)));
    // ↳ = spawned BY a subagent (spawn_depth > 1), otherwise two identical types are indistinguishable
    it.appendChild(el('span', 'agent-type', (a.depth > 1 ? '↳ ' : '') + m.type));
    agentBadges(m).forEach((b) => it.appendChild(b));
    const meta = el('span', 'agent-meta', (m.live ? '⏱ ' : '') + agentElapsed(a) + 's');
    if (a.start) meta.dataset.start = a.start;
    it.appendChild(meta);
    if (m.desc) it.appendChild(el('span', 'agent-desc', m.desc)); // own line in the rail, ellipsised
    // Third line: live activity while it runs, the agent's own totals once it is over. Always created
    // while running (even empty — CSS hides it) so the 1 s ticker can fill it without a repaint.
    if (m.live) it.appendChild(el('span', 'agent-live', agentLiveText(m)));
    else { const s = agentStatsText(m); if (s) it.appendChild(el('span', 'agent-stats', s)); }
    agentStopParts(a, ACTIVE).forEach((p) => it.appendChild(p)); // G6 — the ⏹ for THIS lane, and what came of it
    it.title = agentLaneTitle(m);
    // #34 — the row is the entrance to the full picture: assignment, model, cost, tool breakdown and
    // the agent's own live transcript, in the sidecar. The tooltip stays as the quick read.
    it.onclick = () => agentDetailShow(a, ACTIVE);
    mkClickable(it, m.desc || m.type);
    return it;
  });
}
// ---- U1: the ⚙ Workflow group of the rail --------------------------------------------------------------
// WHAT each state word is allowed to say, in ONE place so the mark, the class and the sentence cannot
// drift apart. The third entry is the point of this whole change: an agent the runtime last reported as
// 'start', on a run that is OVER, is „läuft noch oder abgebrochen" — both, because the data says exactly
// that much and no more (public/js/workflow-lanes.js wfAgentState has the measurement).
const WF_MARKS = {
  done: { mark: '√', cls: 'done', key: 'chat-render.wfFertig' },
  running: { mark: '', cls: 'running', key: 'chat-render.wfLaeuft' },
  open: { mark: '?', cls: 'open', key: 'chat-render.wfOffen' },
  unknown: { mark: '!', cls: 'unknown', key: 'chat-render.wfUnbekannt' },
};
function wfMark(state) { return WF_MARKS[state] || WF_MARKS.unknown; }
// Seconds for a row, with the one distinction that matters: `elapsedFinal` is the runtime's OWN total for
// that agent, everything else is the age at its last report — up to one progress interval behind, so it is
// prefixed with „~" instead of being passed off as a duration.
function wfSecs(v) {
  if (!v || v.elapsedMs == null) return '';
  return (v.elapsedFinal ? '' : '~') + Math.max(0, Math.round(v.elapsedMs / 1000)) + 's';
}
// The long read for one agent row. Only facts the frames carried; absent stays absent.
function wfRowTitle(v) {
  const L = [v.label || ('#' + v.index)];
  if (v.phase) L.push(tt('chat-render.wfPhase') + ': ' + v.phase);
  // The runtime's own word in brackets behind our sentence — always, not only for an unknown one. It is how
  // „start" (queued, nothing reported yet) stays distinguishable from „progress" (working, has reported),
  // which the row itself has no width for: both read „läuft".
  L.push(tt(wfMark(v.state).key) + (v.raw ? ' (' + v.raw + ')' : ''));
  if (v.cached) L.push(tt('chat-render.wfZwischenspeicher'));
  else if (v.elapsedMs != null) L.push((v.elapsedFinal ? tt('chat-render.agentDauer') : tt('chat-render.wfAlterLetzteMeldung')) + wfSecs(v));
  if (v.model) L.push(tt('chat-render.agentModell') + laneModelId(v.model));
  if (v.agentType) L.push(tt('chat-render.wfAgentTyp') + ': ' + v.agentType);
  if (v.tokens) L.push(tt('chat-render.agentTokens') + fmtInt(v.tokens) + tt('chat-render.agentTokensHinweis'));
  if (v.toolCalls) L.push(tt('chat-render.agentToolAufrufe') + v.toolCalls);
  if (v.lastTool) L.push(tt('chat-render.wfLetztesWerkzeug') + ': ' + v.lastTool + (v.lastToolSummary ? ' — ' + v.lastToolSummary : ''));
  if (v.attempt) L.push(tt('chat-render.wfVersuch').replace('{n}', v.attempt) + (v.attemptReason ? ' (' + v.attemptReason + ')' : ''));
  if (v.agentId) L.push(tt('chat-render.agentIdLabel') + v.agentId);
  if (v.result) L.push(tt('chat-render.agentErgebnis') + v.result.replace(/\s+/g, ' ').slice(0, 300));
  if (v.prompt) L.push(tt('chat-render.agentAuftrag') + v.prompt.replace(/\s+/g, ' ').slice(0, 300));
  return L.join('\n');
}
// Phase header + its agents, in the order the run produced them. One flat list of rows, because the rail is
// 220 px wide and a nested tree there costs more indent than it buys.
function workflowRows() {
  const lanes = agentLaneSplit(ACTIVE).workflows;
  const out = [];
  lanes.forEach((a) => {
    const v = wfView(a);
    // The run's own line: name, run id, and — while anything is unfinished on a run that has ENDED — the
    // one sentence the files could never justify. It is said ONCE here instead of per row, so a run with
    // nine stranded agents does not repeat it nine times.
    const head = el('div', 'wf-head' + (a.status === 'running' ? ' running' : ''));
    // The ticker finds the head through this (same idea as `data-agent-lane` on an agent row, a separate
    // attribute so the two loops in tickAgentMeta can never pick up each other's rows).
    head.dataset.wfLane = a.id;
    head.appendChild(el('span', 'wf-name', '⚙ ' + (v.name || tt('chat-render.wfUnbenannt'))));
    if (v.runId) { const r = el('span', 'wf-run', v.runId); r.title = v.runId; head.appendChild(r); }
    // The RUN's own clock, ticking. It moved here with the lane: a workflow used to sit in the 🤖 group and
    // got its ⏱ from agentRows(). Leaving it out would have been a silent loss of exactly the number a
    // reader wants from a run that takes minutes.
    const wt = el('span', 'wf-head-time', (a.status === 'running' ? '⏱ ' : '') + agentElapsed(a) + 's');
    if (a.start) wt.dataset.start = a.start;
    head.appendChild(wt);
    head.title = [v.name, v.runId, v.scriptPath].filter(Boolean).join('\n');
    // G6 — and so did the ⏹. `stop_task` takes ONE id and a workflow carries one for its whole fan-out, so
    // this button stops the ENTIRE run; task-stop.js stopTaskScope() already distinguishes that wording from
    // „stop this one agent". Without it here, the one stop the panel had for a workflow would have vanished
    // with the row it used to live on.
    agentStopParts(a, ACTIVE).forEach((p) => head.appendChild(p));
    out.push(head);
    if (!v.phases.length) {
      // The lane exists (task_started arrived) but no task_progress has carried a workflow_progress yet.
      // Saying „0 Agenten" here would be a claim; „noch keine Meldung" is what is true.
      out.push(el('div', 'wf-empty', tt('chat-render.wfNochKeineMeldung')));
      return;
    }
    v.phases.forEach((p) => {
      const ph = el('div', 'wf-phase');
      ph.appendChild(el('span', 'wf-phase-title', (p.title || tt('chat-render.wfOhnePhase'))));
      const nDone = p.agents.filter((x) => x.state === 'done').length;
      ph.appendChild(el('span', 'wf-phase-count', nDone + '/' + p.agents.length));
      if (p.unannounced) ph.classList.add('wf-phase-guessed');
      ph.title = (p.title || tt('chat-render.wfOhnePhase')) + ' — ' + nDone + '/' + p.agents.length;
      out.push(ph);
      p.agents.forEach((x) => {
        const info = wfMark(x.state);
        const it = el('div', 'wf-item ' + info.cls);
        const mk = el('span', 'todo-mark wf-mark');
        if (x.state === 'running') mk.appendChild(el('span', 'ca-spin'));
        else mk.textContent = info.mark;
        it.appendChild(mk);
        it.appendChild(el('span', 'wf-label', x.label || ('#' + x.index)));
        if (x.attempt) { const b = el('span', 'wf-badge', '↻' + x.attempt); b.title = tt('chat-render.wfVersuch').replace('{n}', x.attempt) + (x.attemptReason ? ' (' + x.attemptReason + ')' : ''); it.appendChild(b); }
        if (x.cached) { const c = el('span', 'wf-badge', '⚡'); c.title = tt('chat-render.wfZwischenspeicher'); it.appendChild(c); }
        it.appendChild(el('span', 'wf-time', x.cached ? '—' : wfSecs(x)));
        // The honest sentence, on its own line and only where it applies — an unfinished agent on a run
        // that is over, and a state word nobody has measured.
        if (x.state === 'open' || x.state === 'unknown') {
          it.appendChild(el('span', 'wf-note', tt(info.key) + (x.state === 'unknown' && x.raw ? ': ' + x.raw : '')));
        }
        it.title = wfRowTitle(x);
        out.push(it);
      });
    });
  });
  return out;
}
// „how many agents of every workflow on this tab are through" — the group head's count. Reported as
// done/total, and NEVER as „fertig": a workflow with nothing running is also the state between two phases
// (messung-journal-2026-10-03.md), so the head counts and does not conclude. `tab` defaults to the ACTIVE one
// (the rail's caller); the status strip passes its own.
function workflowCounts(tab) {
  const lanes = agentLaneSplit(tab || ACTIVE).workflows;
  let total = 0, done = 0, open = 0;
  lanes.forEach((a) => { const c = wfView(a).counts; total += c.total; done += c.done; open += c.open + c.unknown; });
  return { runs: lanes.length, total, done, open };
}
// The ONE text for that count — the ⚙ group head and the ⚙ badge in the status strip both show it, so the two
// cannot say different things about the same run. `done/total`, the number of runs while no frame has named an
// agent yet, and — VISIBLY, not only in a tooltip — how many agents the run cannot place („· 2?", the same `?`
// their rows carry). It used to be the colour and the tooltip alone, i.e. invisible on a folded group unless
// you hovered it, while the comment above it said it was „the one number a reader must not miss".
function workflowCountLabel(c) {
  if (!c) return '';
  return (c.total ? c.done + '/' + c.total : String(c.runs || 0)) + (c.open ? ' · ' + c.open + '?' : '');
}
// The agent list used to be a strip above the composer, costing vertical space for the whole run.
// It lives in the side rail now — which is otherwise idle — so the transcript keeps the height.
function renderAgentStrip() {
  if (typeof chatSideRefresh === 'function') chatSideRefresh(true); // agent status changed → force a repaint
  // …and the badge in the status strip follows the same state (#34). It sits in the strip's left half,
  // which only renderStatusBar() builds; the call is cheap here because it runs on STRUCTURAL changes
  // only — the per-second live numbers are written in place by tickAgentMeta. Its own trailing
  // chatSideRefresh() is unforced and stops at the signature guard, so the rail is not built twice.
  if (typeof renderStatusBar === 'function') renderStatusBar();
  ensureAgentTimer(); // start/stop the 1s live-elapsed ticker (#24)
}
// console-style task markers: pending □ · in_progress ■ · completed √ (ToDo 01) · skipped ⤼ (a plan step, PF-1)
// …and `?` for a status word nobody has measured (U1). It used to fall through to □, i.e. the panel claimed
// „not started yet" about a word it had never seen. Four words are KNOWN: pending/in_progress/completed
// are what TaskUpdate writes (measured over the whole local corpus, see public/js/task-list.js), and
// `skipped` is what a PLAN step can be (PF-1, public/js/plan-progress.js) — two producers, one marker.
// The merge of the two branches is why this comment names both: either side alone was wrong here — the
// rail's `?` would have shown a skipped plan step as „unknown", and the plan's `□` fallback would have
// undone the rail's fix.
function todoMark(status) {
  return status === 'completed' ? '√' : status === 'in_progress' ? '■' : status === 'pending' ? '□' : status === 'skipped' ? '⤼' : '?';
}
// One row. Accepts BOTH shapes on purpose: the raw `TodoWrite` todo (`content`) that the tool card passes
// in, and the normalised row of taskListView (`text`, `state`) that the strip passes in. One builder, so
// the two can never look different.
function todoRow(t) {
  const status = t.state || t.status || 'pending';
  const text = t.text || t.content || '';
  const it = el('div', 'todo-item ' + status);
  it.appendChild(el('span', 'todo-mark', todoMark(status)));
  it.appendChild(el('span', 'todo-text', (status === 'in_progress' && t.activeForm) ? t.activeForm : text));
  // The tooltip is where the unmapped word is named, and where a TaskCreate's long `description` lives —
  // the strip line is one line wide and the subject is what belongs on it.
  const L = [text];
  if (t.detail && t.detail !== text) L.push(t.detail);
  if (status === 'unknown' || (t.status && t.status !== status)) L.push(tt('chat-render.aufgabeStatusUnbekannt') + ': ' + (t.status || status));
  it.title = L.join('\n');
  return it;
}
// Live task checklist — a sticky, in-place strip below the status strip (like the console), updated on every
// task call instead of scattering a tool card per update (ToDo 05). Console tree: active items shown inline,
// completed ones collapsed under a "√ N abgeschlossen" toggle (ToDo 01).
//
// U1 — it now has THREE sources instead of one. Measured over 606 transcripts: `TodoWrite` is called **0**
// times in the whole corpus, so this strip had no feed at all. `TaskCreate` (12) / `TaskUpdate` (18) are the
// tools the CLI really offers — dormant too (newest call 2026-07), which is exactly why the old reader is
// KEPT rather than replaced: public/js/task-list.js merges both and a TodoWrite call rewrites only the rows
// it owns.
function taskListOf(tab) { if (!tab) return []; if (!tab.taskList) tab.taskList = []; return tab.taskList; }
// PF-2 — a task can stand at a plan step in the rail („S2 · …", plan-progress.js planTaskMap), so a task change repaints
// the rail as well as the strip. Unforced: the rail's signature carries only the tasks it shows (planRailSig), so a task
// that stays in the strip stops at the guard and the ≈100 grant chips are not rebuilt for it.
function taskRepaint(tab) {
  if (tab !== ACTIVE) return;
  renderTodoStrip();
  if (typeof chatSideRefresh === 'function') chatSideRefresh();
}
function updateTodos(tab, todos) {
  if (!tab || !Array.isArray(todos)) return;
  tab.taskList = todoWriteApply(taskListOf(tab), todos);
  taskRepaint(tab);
}
// `TaskCreate` was called — the row appears now, without an id (the id only exists in the result).
function trackTaskCreate(tab, toolId, input) {
  if (!tab) return;
  if (taskCreateSeen(taskListOf(tab), toolId, input)) taskRepaint(tab);
}
// …and its result, which carries `{task:{id}}`. Without the id the row stays but can never be updated —
// `TaskUpdate` takes the id and nothing else, so that is the truth and not a gap to paper over. A REFUSED
// create (`isError`) takes its row down again: no task exists, so the strip must not show one.
function trackTaskCreateResult(tab, toolId, out, isError) {
  if (!tab) return;
  if (taskCreateResult(taskListOf(tab), toolId, out, !!isError)) taskRepaint(tab);
}
// `TaskUpdate` was called: the wish is noted on its row, and nothing moves yet (task-list.js taskUpdateAsked).
function trackTaskUpdate(tab, toolId, input) {
  if (!tab) return;
  if (taskUpdateAsked(taskListOf(tab), toolId, input)) taskRepaint(tab);
}
// …and its answer, paired with that wish by the tool_use id. Only here does a row move, and a refusal —
// `is_error`, or an Output whose `success` is not true — leaves it where it was (task-list.js taskUpdateAnswered).
function trackTaskUpdateResult(tab, toolId, isError, out) {
  if (!tab) return;
  if (taskUpdateAnswered(taskListOf(tab), toolId, !!isError, out)) taskRepaint(tab);
}
// PF-2 — Julian, 05.10.: „Aufgaben mit S<n> am Schritt, übrige in der Leiste." With a plan underway in the rail, the
// tasks that name one of its steps stand at that step (chat-side.js planStepTasks), and this strip shows the REST —
// filtered BEFORE taskListView, so its count is the count of what it shows. The split is chat-side.js planStripTasks,
// i.e. plan-progress.js planTaskMap: the same function the group reads, so the two can never both show a task, or both
// leave it out. The box keeps the split it was painted by (`data-split`): planStripSync repaints the strip when the
// PLAN moves under it — a change that never comes through the task doors above.
function renderTodoStrip() {
  const box = $('#chatTodos'); if (!box) return;
  const split = (typeof planStripTasks === 'function') ? planStripTasks(ACTIVE) : { rows: (ACTIVE && ACTIVE.taskList) || [], key: '' };
  box.dataset.split = split.key;
  const view = (typeof taskListView === 'function') ? taskListView(split.rows) : { rows: [], done: 0, total: 0 };
  const todos = view.rows;
  if (!todos.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.innerHTML = '';
  const doneItems = todos.filter((t) => t.state === 'completed');
  const active = todos.filter((t) => t.state !== 'completed');
  const det = el('details', 'ct-det'); det.open = true;
  const sum = el('summary', 'ct-sum');
  sum.appendChild(el('span', 'ct-title', '✓ ' + tt('chat-render.aufgaben')));
  sum.appendChild(el('span', 'ct-count', doneItems.length + '/' + todos.length));
  det.appendChild(sum);
  const list = el('div', 'todo-list ct-list');
  active.forEach((t) => list.appendChild(todoRow(t)));
  if (doneItems.length) {
    const cd = el('details', 'todo-done-toggle'); // collapsed "+N completed" like the console
    cd.appendChild(el('summary', 'todo-done-sum', '√ ' + doneItems.length + tt('chat-render.abgeschlossen')));
    const cl = el('div', 'todo-list td-done-list');
    doneItems.forEach((t) => cl.appendChild(todoRow(t)));
    cd.appendChild(cl);
    list.appendChild(cd);
  }
  det.appendChild(list);
  box.appendChild(det);
  box.classList.remove('hidden');
}

function addThinking(bubbleEl, text) {
  const msg = bubbleEl.parentElement;
  const det = el('details', 'thinking-card');
  det.appendChild(el('summary', null, '💭 ' + tt('chat-render.nachdenken')));
  const body = el('div', 'thinking-body'); body.textContent = text;
  det.appendChild(body);
  msg.insertBefore(det, bubbleEl);
}

// Send a choice as a normal follow-up (robust: works regardless of headless tool wiring). Goes through
// sendMessage's explicit-text path, so it neither eats the composer draft nor silently drops the click while a
// turn is running — a streaming tab queues it like any other typed message (C9).
// PF-1b — the plan chip does NOT apply to a quick reply. The chip stands above the composer, the click happens on a
// message in the transcript, and the button says only „Als Antwort senden: Nein" — so „Nein" to the model's last
// question went out with „Plan-Fortschritt: Beginne die Umsetzung" and started the orphan, live and in the fold.
function sendQuick(text) { if (text) sendMessage({ text, tab: chat }); }
// A used quick-reply row is done: freeze it so the same choice can't be clicked twice.
function qrPick(row, btn, text) {
  if (row.classList.contains('qr-stale')) return;
  row.classList.add('qr-used', 'qr-stale');
  row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  if (btn) btn.classList.add('sel');
  sendQuick(text);
}
// Quick-reply chips live in the transcript forever; once the conversation moved on they were still clickable
// and (while streaming) silently did nothing. Every send retires the rows above it (C9).
function staleQuickReplies(tab) {
  const host = tab && tab.msgEl; if (!host) return;
  host.querySelectorAll('.qr-row:not(.qr-stale)').forEach((row) => {
    row.classList.add('qr-stale');
    row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  });
}
// „Bearbeiten" resend: move the replaced message and everything after it into a collapsed, dimmed block so the
// transcript shows ONE live thread instead of the old and the new ask standing side by side. headless can't
// truly rewind (the model keeps the old context), which the note says out loud. (C11)
function supersedeFrom(tab, node) {
  if (!tab || !node || !node.isConnected || node.parentElement !== tab.msgEl) return;
  const items = []; for (let n = node; n; n = n.nextElementSibling) items.push(n);
  if (!items.length) return;
  const nMsgs = items.filter((x) => x.classList.contains('msg')).length;
  const box = el('details', 'superseded');
  const sum = el('summary');
  sum.appendChild(el('span', 'sup-title', '✎ ' + tt('chat-render.ersetzt')));
  sum.appendChild(el('span', 'sup-count', tt('chat-render.nNachrichtenAusgeblendet').replace('{n}', nMsgs)));
  box.appendChild(sum);
  tab.msgEl.insertBefore(box, node);
  items.forEach((x) => box.appendChild(x));
  box.appendChild(el('div', 'sup-note', tt('chat-render.supersedeHinweis')));
}
// AskUserQuestion -> ONE grouped card holding every question. Selections are collected and submitted
// together via a single "Antwort senden" button (fixes: answering one question no longer ends the turn
// and strands the others). A lone single-select question still submits immediately on click (snappy).
function addOptionCard(bubbleEl, toolId, input) {
  const msg = bubbleEl.parentElement;
  const owner = chat; // the tab this question belongs to (chat is swapped to it during event handling)
  const qs = (input && input.questions) || [];
  if (!qs.length) return;
  const autoSend = qs.length === 1 && !qs[0].multiSelect; // lone single-select → submit on click
  const group = el('div', 'opt-group');
  if (qs.length > 1) group.appendChild(el('div', 'opt-group-head', qs.length + tt('chat-render.fragenAlleBeantwortenDann')));
  const answers = qs.map(() => new Set());
  let sendBtn = null;
  const updateSend = () => { if (sendBtn) sendBtn.disabled = answers.some((s) => !s.size); };

  qs.forEach((q, qi) => {
    const card = el('div', 'opt-card');
    if (qs.length > 1) card.appendChild(el('div', 'opt-idx', (qi + 1) + '/' + qs.length));
    card.appendChild(el('div', 'opt-q', q.question || q.header || tt('chat-render.auswahl')));
    card.appendChild(el('div', 'opt-hint', (q.multiSelect ? tt('chat-render.mehrfachauswahl') : tt('chat-render.eineOptionWaehlen')) + (q.header ? ' · ' + q.header : '')));
    const grid = el('div', 'opt-grid');
    (q.options || []).forEach((o) => {
      const b = el('button', 'opt-btn');
      b.appendChild(el('span', null, o.label));
      if (o.description) b.appendChild(el('span', 'opt-desc', o.description));
      b.onclick = () => {
        if (group._done) return;
        if (q.multiSelect) {
          if (answers[qi].has(o.label)) { answers[qi].delete(o.label); b.classList.remove('sel'); }
          else { answers[qi].add(o.label); b.classList.add('sel'); }
        } else {
          answers[qi].clear(); answers[qi].add(o.label);
          [...grid.children].forEach((c) => c.classList.remove('sel'));
          b.classList.add('sel');
          if (autoSend) { submitAnswers(group, qs, answers, toolId); return; }
        }
        updateSend();
      };
      grid.appendChild(b);
    });
    card.appendChild(grid);
    group.appendChild(card);
  });

  if (!autoSend) {
    const act = el('div', 'opt-actions');
    sendBtn = el('button', 'opt-send', '✓ ' + tt('chat-render.antwortSenden'));
    sendBtn.disabled = true;
    sendBtn.onclick = () => { if (!sendBtn.disabled) submitAnswers(group, qs, answers, toolId); };
    act.appendChild(sendBtn);
    group.appendChild(act);
  }
  // escape hatch: type a free-text answer or a counter-question instead of (only) picking an option
  const ff = el('div', 'opt-freeform');
  const ffInput = el('input', 'opt-ff-input'); ffInput.type = 'text'; ffInput.placeholder = '✎ ' + tt('chat-render.eigeneAntwortOderRueckfrage');
  const ffSend = el('button', 'opt-ff-send', tt('html.senden'));
  const ffSubmit = () => { const v = ffInput.value.trim(); if (v && !group._done) submitGroup(group, v, toolId, v); };
  ffInput.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); ffSubmit(); } };
  ffSend.onclick = ffSubmit;
  ff.appendChild(ffInput); ff.appendChild(ffSend);
  group.appendChild(ff);

  // what is picked but not sent yet — [Mit Antwort senden] in the queue strip sends it along (CHAT-FLOW-6)
  group._picked = () => {
    if (!answers.some((s) => s.size)) return '';
    return qs.length === 1 ? [...answers[0]].join(', ')
      : qs.map((q, i) => answers[i].size ? (i + 1) + '. ' + (q.header || q.question || tt('chat-render.frage')) + ': ' + [...answers[i]].join(', ') : '').filter(Boolean).join('\n');
  };
  // rearmGateCard re-enables every control after a failed reply — only this card knows that „Antwort senden"
  // stays disabled until something is picked again
  group._rearm = updateSend;
  msg.appendChild(group);
  // record this question's group so a held permission (or a composer reply) can resolve exactly this card
  ASK_GATES.set(toolId, Object.assign(ASK_GATES.get(toolId) || {}, { group, tab: owner }));
  if (owner === ACTIVE && typeof renderQueueStrip === 'function') renderQueueStrip(); // „↳ beantwortet: …" chip
  // sticky: pull the question into view (only if its tab is showing) + surface the jump button until answered.
  // The jump activates the OWNING tab first, then scrolls to the exact group — questions can be in a background tab.
  if (owner === ACTIVE) group.scrollIntoView({ block: 'center', behavior: 'smooth' });
  registerAskWaiter(toolId, owner, askCardFocus(owner, group));
}
// What the pulsing jump button does for an ask/plan card: activate its OWNING tab (cards can be in a
// background one), switch to the chat view (#23), then scroll to the exact group and flash it. Shared by the
// question card, the plan card and a card re-armed after a failed reply.
function askCardFocus(owner, group) {
  return () => {
    if (owner !== ACTIVE) activateTab(owner);
    if (typeof showView === 'function') showView('chat');
    setTimeout(() => { group.scrollIntoView({ block: 'center' }); group.classList.add('flash'); setTimeout(() => group.classList.remove('flash'), 1200); }, 30);
  };
}
function submitAnswers(group, qs, answers, toolId) {
  const text = qs.length === 1
    ? [...answers[0]].join(', ')
    : qs.map((q, i) => (i + 1) + '. ' + (q.header || q.question || tt('chat-render.frage')) + ': ' + [...answers[i]].join(', ')).join('\n');
  submitGroup(group, text, toolId, qs.length === 1 ? text : tt('chat-render.antwortGesendet'));
}
// finalize an option group with the given answer text (from picked options OR a free-text reply).
// `settle` (optional): told once whether the answer was delivered — see postGateReply.
function submitGroup(group, text, toolId, doneLabel, settle) {
  if (group._done || !text) { settleGate(settle, new Error('card closed')); return; }
  const owner = (ASK_GATES.get(toolId) || {}).tab || chat;
  group._done = true;
  group.querySelectorAll('button, input').forEach((b) => { b.disabled = true; });
  clearAskWaiter(toolId);
  group.appendChild(el('div', 'opt-done', '→ ' + (doneLabel || text)));
  // Prefer answering the HELD permission in-band (model continues the same turn); otherwise (no gate yet —
  // rare race where the user out-ran the can_use_tool) fall back to a follow-up message. When that late gate
  // arrives it's allowed, the turn ends, and this queued reply flushes — the old behaviour.
  if (!answerAsk(toolId, text, settle)) {
    const g = ASK_GATES.get(toolId) || {};
    // A gate that IS held but whose chat is gone (reaped, dormant) is NOT that race: nothing can carry this
    // answer. A caller that took queue entries for it has to hear a failure — settle(null) plus sendMessage()
    // put the same text into the queue a second time (sendMessage queues while a gate is held) under a bubble
    // that claimed it had gone out. Without a settle the text still has a home as an ordinary message, which
    // resumes the session on the way, so that path stays as it was. (chatclient Gap 3)
    if (g.requestId && settle) { settleGate(settle, new Error('chat not running')); rearmGateCard(toolId); }
    else {
      ASK_GATES.set(toolId, Object.assign(g, { answeredFallback: true }));
      // one path for both cases: sendMessage queues it itself when the owning tab is still streaming
      sendMessage({ text, tab: g.tab || chat });
      settleGate(settle, null); // the text is the message path's now (queue / retry row) — nothing to hand back
    }
  }
  if (owner === ACTIVE && typeof renderQueueStrip === 'function') renderQueueStrip(); // the card no longer waits
}
// --- inline plan approval (ToDo 07b): ExitPlanMode is held like AskUserQuestion + shown as an in-chat card,
//     not a blocking modal, so the user can read the plan and switch tabs freely. ---
// `file` = the input's planFilePath (PF-1): after a reload the plan text is gone from memory, and the file is
// what the rail's [Plan öffnen] can still show.
function addPlanCard(bubbleEl, toolId, plan, file) {
  const existing = ASK_GATES.get(toolId);
  if (existing && existing.group) return; // already rendered (assistant msg + control_request race)
  const msg = bubbleEl.parentElement;
  const owner = chat; // the tab this plan belongs to
  const group = el('div', 'opt-group plan-group');
  // the rail's jump target for a step nobody has reported yet (chat-side.js planJumpTarget)
  if (toolId) group.dataset.toolId = toolId;
  group.appendChild(el('div', 'opt-group-head', '📋 ' + tt('chat-render.planZurFreigabeVerlaesst')));
  const body = el('div', 'plan-body');
  body.innerHTML = (typeof renderMarkdown === 'function') ? renderMarkdown(String(plan || '')) : mdEscape(String(plan || ''));
  group.appendChild(body);
  // Feedback for „Weiter planen" lives ON the card (CHAT-FLOW-6): the composer no longer answers a plan —
  // a side remark typed there used to reject it silently — so this field is where the „what instead" goes.
  const ff = el('div', 'opt-freeform');
  const fb = el('input', 'opt-ff-input'); fb.type = 'text'; fb.placeholder = '✎ ' + tt('chat-render.planFeedbackPlatzhalter');
  const act = el('div', 'opt-actions');
  const accept = el('button', 'opt-send', '✓ ' + tt('chat-perms.planAnnehmen'));
  const keep = el('button', 'opt-btn plan-keep', '✎ ' + tt('chat-perms.weiterPlanen'));
  const keepPlanning = () => {
    const v = fb.value.trim();
    finalizePlan(group, toolId, 'deny', v ? tt('chat-render.bitteDenPlanNoch') + '\n\n' + v : tt('chat-render.bitteDenPlanNoch'),
      '→ ' + tt('chat-perms.weiterPlanen') + (v ? ': ' + (v.length > 80 ? v.slice(0, 78) + '…' : v) : ''));
  };
  accept.onclick = () => finalizePlan(group, toolId, 'allow', null, '→ ' + tt('chat-render.planAngenommen'));
  keep.onclick = keepPlanning;
  fb.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); keepPlanning(); } };
  ff.appendChild(fb);
  group.appendChild(ff);
  act.appendChild(accept); act.appendChild(keep);
  group.appendChild(act);
  msg.appendChild(group);
  ASK_GATES.set(toolId, Object.assign(existing || {}, { group, tab: owner, isPlan: true }));
  // PF-1 — the proposal as a candidate (parsed once, here: the early return above makes this once per id), and
  // as the rail's dimmed „wartet auf Freigabe" group unless a plan is already being worked on
  if (typeof planSeen === 'function') planSeen(owner, toolId, String(plan || ''), file);
  if (owner === ACTIVE && typeof renderQueueStrip === 'function') renderQueueStrip(); // „wartet auf deine Antwort"
  if (owner === ACTIVE) group.scrollIntoView({ block: 'center', behavior: 'smooth' });
  // like questions: the floating jump button activates the owning tab + switches to the chat view + re-surfaces the card
  registerAskWaiter(toolId, owner, askCardFocus(owner, group));
}
function finalizePlan(group, toolId, behavior, message, doneLabel, settle) {
  if (group._done) { settleGate(settle, new Error('card closed')); return; }
  const owner = (ASK_GATES.get(toolId) || {}).tab || chat;
  group._done = true;
  group.querySelectorAll('button, input').forEach((b) => { b.disabled = true; });
  clearAskWaiter(toolId);
  group.appendChild(el('div', 'opt-done', doneLabel));
  if (!answerPlan(toolId, behavior, message, settle)) {
    // the can_use_tool gate hasn't arrived yet (rare race) → stash the decision; control_request applies it
    // (and its `settle` with it: the POST that decides happens only then)
    const g = ASK_GATES.get(toolId) || {};
    ASK_GATES.set(toolId, Object.assign(g, { answeredFallback: true, pendingBehavior: behavior, pendingMessage: message, pendingSettle: settle || null, tab: g.tab || chat, isPlan: true }));
  }
  if (owner === ACTIVE && typeof renderQueueStrip === 'function') renderQueueStrip(); // the card no longer waits
}
// CHAT-FLOW-10 — the turn holding this plan is over (interrupt, process exit) and its gate is about to be
// dropped. The card stayed clickable and answered „Plan angenommen" to nobody (finalizePlan only stashes a
// decision when no gate is there). A question card needs none of this: without a gate its answer falls back
// to an ordinary message, which still reaches Claude.
// PF-1b — and a plan needs no gate either: the card is ORPHANED (planCardOrphan) instead of retired for good — its
// approval buttons become ▶ Plan starten, the same approval as an ordinary message. It used to supersede the
// proposal, so a plan nobody had decided on vanished from the rail while the resume fold kept it.
function retirePlanCards(tab) {
  for (const [toolId, g] of ASK_GATES) {
    if (g.tab !== tab || !g.isPlan || !g.group || g.group._done) continue;
    planCardOrphan(tab, toolId, 'turnend', g.group);
  }
  if (tab === ACTIVE && typeof renderQueueStrip === 'function') renderQueueStrip();
}
// A gate that is still able to decide this proposal: a can_use_tool held for it, its card still waiting for one — or a
// decision parked on the card for a gate that has not come yet (finalizePlan's stash: `answeredFallback`, the card is
// `_done` already). In that window the parked click decides the moment the gate arrives; ▶ and the chip beside it
// started a plan the parked „Weiter planen" then put away (and „Plan freigegeben" still reached the model after it).
// While it exists, the card decides — ▶ and the composer chip stay away (chat-side.js planStartable). Once nothing can
// carry the parked decision any more, planCardOrphan drops the entry and the plan is startable.
function planOpenGate(tab, toolId) {
  const g = toolId ? ASK_GATES.get(toolId) : null;
  return !!(g && g.tab === tab && (g.requestId || g.answeredFallback || (g.group && !g.group._done)));
}
// PF-1b — no gate will ever decide this plan card: the CLI refused the ExitPlanMode outside plan mode (chat-events.js:
// „You are not in plan mode" — the 05.10. session ran in „Auto", no can_use_tool ever came), or the turn that held
// the gate ended undecided (retirePlanCards, clearAsksForTab). The card had kept „Plan annehmen" — a button that
// stashed a decision for a gate that could never come, while the rail said „wartet auf Freigabe" for good.
// Now: the gate entry goes (nothing can answer it, and as an open card it would hold the queue strip's „wartet auf
// deine Antwort"), the proposal is orphaned (chat-side.js planOrphaned) and the card is repainted from the plan's
// state from then on (planCardPaint). `group` for a caller that has already dropped the entry.
function planCardOrphan(tab, toolId, why, group) {
  const g = ASK_GATES.get(toolId);
  const card = group || (g && g.group) || null;
  if (g && g.answeredFallback) why = 'lost'; // a decision was parked on the card — it is that one that got lost
  if (g && g.tab === tab) {
    ASK_GATES.delete(toolId);
    if (g.pendingSettle) settleGate(g.pendingSettle, new Error('no gate for this plan')); // a stashed approval: nothing carries it
  }
  clearAskWaiter(toolId);
  if (typeof planOrphaned === 'function') planOrphaned(tab, toolId);
  if (card && !card.classList.contains('is-orphan')) {
    card._done = true;
    card.classList.add('is-orphan');
    card.dataset.orphan = (why === 'noplanmode' || why === 'lost') ? why : 'turnend';
    card.querySelectorAll('.opt-done').forEach((n) => n.remove()); // a stashed „→ Plan angenommen" that never was
  }
  if (card) planCardPaint(tab, card);
  if (tab === ACTIVE && typeof renderQueueStrip === 'function') renderQueueStrip();
}
// What an orphaned card offers, from the plan's state — so it follows the rail instead of keeping what was true when
// it was painted: ▶ only on the card of the proposal a start would begin (the fold knows only the newest orphan
// under a plan underway, so an older card offering it would start something a resume never could), „startet nach
// diesem Turn" while its start is queued, the outcome once there is one.
function planCardState(tab, toolId) {
  // the switch is off: the start goes out as the plain sentence, without a list — as an approval does then
  // (resolvePlanGate) — also for a proposal registered before it was switched off, or brought back by a resume
  const off = typeof planProgressOn === 'function' && !planProgressOn();
  const p = (typeof planCandidateOf === 'function') ? planCandidateOf(tab, toolId) : null;
  if (!p) {
    const h = tab && tab.plan && Array.isArray(tab.plan.history) ? tab.plan.history.find((e) => e && e.id === toolId) : null;
    if (h) return 'started';
    return off ? 'plain' : 'gone'; // off: no candidate was ever registered — the card can still say „start"
  }
  if (p.state === 'superseded') return 'kept';
  if (p.state === 'dismissed') return p.acceptedAt ? 'started' : 'dismissed';
  if (p.state !== 'proposed') return 'started';
  if (!(typeof planStartable === 'function' && planStartable(tab, p))) return 'gone';
  if (typeof planStartQueued === 'function' && planStartQueued(tab)) return 'queued';
  return off ? 'plain' : 'start';
}
function planCardPaint(tab, card) {
  if (!card || !card.classList || !card.classList.contains('is-orphan')) return;
  const toolId = card.dataset.toolId || '';
  const st = card._started ? 'started' : planCardState(tab, toolId); // _started: the plain start (switch off)
  const busy = !!(tab && (tab.streaming || (typeof hasHeldGate === 'function' && hasHeldGate(tab))));
  const key = st + '|' + (busy ? 1 : 0);
  if (card.dataset.paint === key) return; // a repaint per plan change — only when what it shows moved
  card.dataset.paint = key; card.dataset.state = st;
  const head = card.querySelector('.opt-group-head');
  if (head) head.textContent = '📋 ' + tt('chat-side.planLiegtVor');
  let why = card.querySelector('.plan-why');
  if (!why) { why = el('div', 'opt-hint plan-why'); card.insertBefore(why, card.querySelector('.plan-body') || null); }
  why.textContent = tt(card.dataset.orphan === 'noplanmode' ? 'chat-render.planOhneGateNichtPlanmodus'
    : card.dataset.orphan === 'lost' ? 'chat-render.planOhneGateEntscheidungVerloren' : 'chat-render.planOhneGateTurnEnde');
  const act = card.querySelector('.opt-actions'), ff = card.querySelector('.opt-freeform');
  card.querySelectorAll('.opt-done').forEach((n) => n.remove());
  if (act) act.innerHTML = '';
  const live = st === 'start' || st === 'plain';
  if (ff) { ff.classList.toggle('hidden', !live); ff.querySelectorAll('input').forEach((i) => { i.disabled = !live; }); }
  if (!live || !act) {
    const done = { started: '→ ▶ ' + tt('chat-render.planGestartet'), queued: '⏳ ' + tt('chat-side.planStartetNachTurn'),
      kept: '→ ' + tt('chat-perms.weiterPlanen'), dismissed: '→ ' + tt('chat-side.planZustanddismissed') }[st] || '⏹ ' + tt('chat-render.planNichtMehrStartbar');
    card.appendChild(el('div', 'opt-done', done));
    return;
  }
  const go = el('button', 'opt-send', '▶ ' + tt('chat-side.planStarten') + (busy ? ' ' + tt('chat-side.planNachDiesemTurn') : ''));
  go.type = 'button';
  go.title = tt('chat-side.planStartenTitel') + (busy ? '\n' + tt('chat-side.planNachDiesemTurnTitel') : '');
  go.onclick = () => {
    if (st === 'plain') { // switch off: the plain sentence, like an approval without a candidate (resolvePlanGate)
      card._started = true; card.dataset.paint = '';
      if (typeof sendMessage === 'function') sendMessage({ text: tt('chat-side.planStartKopf'), tab, planMsg: true });
      planCardPaint(tab, card);
      return;
    }
    if (typeof planStartNow === 'function') planStartNow(tab, toolId);
  };
  // „Weiter planen" without a gate: the feedback goes into the composer, headed by the keep sentence — sent from
  // there it puts the proposal away, live and in the fold alike (planOutgoingKind 'keep'). Nothing is decided by
  // the click itself: the composer still lets you change your mind, and ▶ stays until the message goes out.
  const keep = el('button', 'opt-btn plan-keep', '✎ ' + tt('chat-perms.weiterPlanen'));
  keep.type = 'button'; keep.title = tt('chat-render.planWeiterImComposer');
  keep.onclick = () => {
    const fb = card.querySelector('.opt-ff-input'), v = fb ? fb.value.trim() : '';
    if (tab && tab !== ACTIVE && typeof activateTab === 'function') activateTab(tab);
    if (tab) tab._planChipOff = true; // a keep carries no start — the chip says so for this message
    if (typeof composerSet === 'function') composerSet(tt('chat-render.bitteDenPlanNoch') + (v ? '\n\n' + v : '\n\n'), tt('chat-perms.weiterPlanen'));
    if (typeof renderPlanChip === 'function') renderPlanChip();
  };
  const fbIn = card.querySelector('.opt-ff-input');
  if (fbIn) fbIn.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); keep.onclick(); } };
  act.appendChild(go); act.appendChild(keep);
}
// Every orphaned card of a tab (planChanged → structural, the queue, a turn starting or ending).
function planCardsPaint(tab) {
  if (!tab || !tab.msgEl || typeof tab.msgEl.querySelectorAll !== 'function') return;
  tab.msgEl.querySelectorAll('.plan-group.is-orphan').forEach((card) => planCardPaint(tab, card));
}
// render.js applyLang: the paint guard (state|busy) knows nothing of the language — forget it, in every tab
function planCardsRelabel() {
  (typeof TABS !== 'undefined' ? TABS : []).forEach((t) => {
    if (t && t.msgEl) t.msgEl.querySelectorAll('.plan-group.is-orphan').forEach((card) => { card.dataset.paint = ''; planCardPaint(t, card); });
  });
}
// heuristic quick replies: even when the model doesn't use the AskUserQuestion tool, it often
// presents choices or a suggestion as plain text — detect a trailing enumerated list, a question,
// or an offer/proposal and offer clickable chips (fill the composer, no auto-send).
// client-side per-turn cost estimate (mirrors server PRICING/costParts; USD per 1M tokens) so the result-foot
// can show THIS turn's cost, not the cumulative session total (ToDo 03). cache read 0.1×in, cache write 1.25×in.
// fallback table; overwritten at boot by updateChatPricing() from /api/models (single source: lib/models.js)
let CHAT_PRICING = {
  'claude-opus-5': { in: 5, out: 25 }, 'claude-opus-4-8': { in: 5, out: 25 }, 'claude-opus-4-7': { in: 5, out: 25 }, 'claude-opus-4-6': { in: 5, out: 25 }, 'claude-opus-4-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15 }, 'claude-sonnet-4-6': { in: 3, out: 15 }, 'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 }, 'claude-fable-5': { in: 10, out: 50 }, 'claude-fable-5-1': { in: 10, out: 50 }, 'claude-mythos-5': { in: 10, out: 50 },
};
function updateChatPricing(p) { if (p && typeof p === 'object') CHAT_PRICING = p; }
function turnCostUSD(usage, model) {
  if (!usage) return 0;
  const p = CHAT_PRICING[String(model || '').replace(/\[1m\]/i, '').replace(/-\d{8}$/, '')];
  if (!p) return 0;
  const inP = p.in / 1e6, outP = p.out / 1e6;
  return (usage.input_tokens || 0) * inP + (usage.output_tokens || 0) * outP
    + (usage.cache_read_input_tokens || 0) * inP * 0.1 + (usage.cache_creation_input_tokens || 0) * inP * 1.25;
}
// Detection without painting: → { row, asked } or null. The result tail needs to know whether Claude ASKED
// something before it lets a queued message go out (CHAT-FLOW-7). `asked` is ALWAYS the heuristic's
// question or offer: a CLI prediction of the next prompt (--prompt-suggestions) is no question itself, but
// its presence says nothing about whether the answer ENDED in one — answering `asked: false` whenever it
// came let the queue talk over a question in every tab with the flag. Its chips may still replace the
// heuristic's. Consumes lastAssistantText + _cliSuggestions either way, so an unused suggestion can't
// resurface under a later turn.
function buildQuickReplies() {
  const t = (chat.lastAssistantText || '').trim();
  chat.lastAssistantText = '';
  const heur = t ? heuristicQuickReplies(t) : null; // the question test — runs whether or not the CLI predicted
  // N1: if the CLI predicted the next prompt itself (--prompt-suggestions), show THAT — it read the
  // whole conversation, the heuristic only reads the last two lines. The heuristic's chips stay for
  // every tab without the flag, and as the fallback when no frame arrived for this turn.
  const cli = chat._cliSuggestions; chat._cliSuggestions = null;
  if (cli && cli.length) {
    const row = el('div', 'qr-row');
    cli.forEach((s) => {
      const b = el('button', 'qr-btn qr-cli', s.length > 60 ? s.slice(0, 58) + '…' : s);
      b.title = tt('chat-render.vorschlagDerCli') + s;
      b.onclick = () => qrPick(row, b, s);
      row.appendChild(b);
    });
    const own = el('button', 'qr-btn qr-continue', tt('chat-render.weiter'));
    own.title = tt('chat-render.selbstImChatWeiterschreiben');
    own.onclick = () => { const inp = $('#composerInput'); if (inp) inp.focus(); };
    row.appendChild(own);
    return { row, asked: !!heur };
  }
  return heur ? { row: heur, asked: true } : null;
}
// The heuristic's chip row for the last answer `t` (a question / offer at its end), or null.
function heuristicQuickReplies(t) {
  const rawLines = t.split('\n');
  const opts = [];
  for (let i = rawLines.length - 1; i >= 0; i--) {
    const ln = rawLines[i].trim();
    if (!ln) { if (opts.length) break; else continue; }
    const m = ln.match(/^(?:\d+[.)]|[-*•]|[A-Za-z][.)])\s+(.{1,90})$/);
    if (m) opts.unshift(m[1].replace(/\*\*/g, '').trim()); else break;
  }
  const hasQ = /\?/.test(t);
  const row = el('div', 'qr-row');
  let any = false;
  if (hasQ && opts.length >= 2 && opts.length <= 6) {
    opts.forEach((o) => { const b = el('button', 'qr-btn', o.length > 46 ? o.slice(0, 44) + '…' : o); b.title = tt('chat-render.alsAntwortSenden').replace('{x}', o); b.onclick = () => qrPick(row, b, o); row.appendChild(b); });
    any = true;
  } else {
    const nonEmpty = rawLines.map((s) => s.trim()).filter(Boolean);
    const last = nonEmpty[nonEmpty.length - 1] || '';
    const tail = nonEmpty.slice(-2).join(' '); // proposals usually sit in the last line or two
    const endsQ = /\?["')\]]?\s*$/.test(last);
    // offers/suggestions WITHOUT a "?" — e.g. "Als Nächstes könnten wir …", "Soll ich …", "I could … / Shall we …"
    const isSuggestion = /(soll(en)?\s+(ich|wir)|m[öo]cht(est|en)\s+du|k[öo]nnt?en?\s+wir|ich\s+k[öo]nnte|wir\s+k[öo]nnten|als\s+n[äa]chstes|schlage?\s+vor|mein\s+vorschlag|willst\s+du\s+dass|should\s+i|shall\s+(we|i)|would\s+you\s+like|want\s+me\s+to|could\s+(we|i)|i\s+could|next,?\s+(we|i)\s+could)/i.test(tail);
    if (endsQ || isSuggestion) {
      [tt('chat-render.ja'), tt('chat-render.nein'), tt('chat-render.weiter')].forEach((x, xi) => {
        // click = send the answer immediately (ToDo 01); „Weiter"/"Continue" (index 2) instead just focuses the composer to type your own
        const isCont = xi === 2;
        const b = el('button', 'qr-btn' + (isCont ? ' qr-continue' : ''), x);
        if (isCont) { b.title = tt('chat-render.selbstImChatWeiterschreiben'); b.onclick = () => { const inp = $('#composerInput'); if (inp) inp.focus(); }; }
        else { b.title = tt('chat-render.alsAntwortSenden').replace('{x}', x); b.onclick = () => qrPick(row, b, x); }
        row.appendChild(b);
      });
      any = true;
    }
  }
  return any ? row : null;
}

// ⏹ Stop is shown for whatever can be stopped (tabCanStop, chat.js) — a HELD gate included: setComposerBusy
// paints the turn's EDGES, but a gate arrives and is answered between them, and main-thread work after a
// `result` that carries no stream/assistant frame (a gate, measured in run 2) has no edge at all — a follow-up
// turn that does stream is adopted since CHAT-FLOW-3 (turnOpenedByCli). So the one state that needs Stop most
// (a held gate as the only live work, which also keeps a deferred restart waiting) was the one without it.
// The gate transitions of the visible tab all repaint the queue strip, which calls this.
// Since the Nachtrag (Sergej) ⏹ also stands while the CLI works without streaming or sub-agents run — and nothing
// repaints when THAT runs out (a lane ends, frames stop), so while the button stands for one of those, or for the
// armed second press, it looks again once a second. The armed state is said on the button before it is pressed.
let STOP_VIS_TIMER = null;
function refreshInterruptBtn() {
  const b = $('#interruptBtn'); if (!b) return;
  const t = ACTIVE, can = tabCanStop(t);
  b.classList.toggle('hidden', !can);
  const armed = can && typeof stopArmed === 'function' && stopArmed(t);
  b.classList.toggle('is-armed', armed);
  b.title = armed ? tt('chat.stoppenHart') : tt('html.unterbrechen');
  const decays = can && !t.streaming && !hasHeldGate(t);
  if ((decays || armed) && !STOP_VIS_TIMER) STOP_VIS_TIMER = setInterval(refreshInterruptBtn, 1000);
  else if (!decays && !armed && STOP_VIS_TIMER) { clearInterval(STOP_VIS_TIMER); STOP_VIS_TIMER = null; }
}
function setComposerBusy(busy) {
  chat.streaming = busy;
  // every end of a turn ends an adopted one too, and its Stop watchdog with it (CHAT-FLOW-3, chat.js armCliTurnStop)
  if (!busy) { chat._cliTurn = false; clearTimeout(chat._cliStopTimer); chat._cliStopTimer = null; }
  // thinkTokens is reset with the other per-turn counters (A2): the CLI's estimate is per turn, and a
  // turn that does no thinking at all would otherwise inherit the previous turn's number.
  if (busy) { chat.turnStart = Date.now(); chat.tokenBase = 0; chat.tokenLive = 0; chat.thinkTokens = 0; chat.phase = PHASE_WORKING; chat._exited = false; chat._stopAt = 0; clearTimeout(chat._stopTimer); chat._stopTimer = null; }
  refreshSessionChip(chat); // live ↔ idle transition on the top chip
  if (chat === ACTIVE) {
    // send stays enabled while busy — a message sent mid-turn is queued and flushed when the turn ends
    $('#sendBtn').disabled = false;
    $('#sendBtn').classList.toggle('queueing', busy);
    $('#sendBtn').title = busy ? tt('chat-render.inDieWarteschlangeStellen') : tt('html.sendenEnter');
    refreshInterruptBtn();
    if (busy) startTurnStatus(); else stopTurnStatus();
  }
  renderTabs(); // reflect the streaming spinner on the tab
  // an orphaned plan card says „▶ Plan starten (nach diesem Turn)" while one runs (PF-1b)
  if (chat.plan || chat._planOrphan) planCardsPaint(chat);
}

