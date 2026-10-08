'use strict';
// ============================================================
//  Approvals rail (right of the chat).
//
//  WHY: every "Immer erlauben" piled another chip into the status bar above the composer — the line
//  that also carries model, mode, cwd and cost. They crowded it, and what you had blessed was easy to
//  miss. They live here instead, in one place you can scan and revoke from.
//
//  Two kinds, deliberately separated because their scope differs:
//    · "Diese Sitzung"  — tab.alwaysAllow (set by the permission dialog), tool-level, gone on restart
//    · "Dauerhaft"      — settings.local permissions.allow, carries the PATH/pattern rules
//                         (Bash(git:*), Read(…)) and survives every session
//
//  The rail collapses to a 40px strip and remembers width + state in `cc_chat_layout`.
//
//  This file also owns the OPEN POINTS (D2) — both of their views: the row in this rail and the card
//  in the transcript. They live together on purpose; two renderers of the same state in two files is
//  how the two get out of step.
//
//  …and the PLAN PROGRESS (PF-1): the live wiring of tab.plan (plan-progress.js shapes it) and its group
//  in this rail. Built the way the open points are — a fenced block the model writes is lifted out of its
//  message before the message is painted — so it sits next to them.
// ============================================================

const CHAT_LAYOUT_KEY = 'cc_chat_layout';
function chatLayoutGet() {
  try { return JSON.parse(localStorage.getItem(CHAT_LAYOUT_KEY) || '{}') || {}; } catch { return {}; }
}
function chatLayoutSet(patch) {
  const p = Object.assign(chatLayoutGet(), patch);
  try { localStorage.setItem(CHAT_LAYOUT_KEY, JSON.stringify(p)); } catch { /* private mode / quota */ }
  return p;
}

// Your last explicit click on the toggle. A grant is information, not a blocking gate, so a new one
// does NOT tear the rail back open against that choice — the count badge on the collapsed strip is
// the signal instead. Only the automatic fold of an EMPTY rail ignores this (nothing to show anyway).
let _sideUserCollapsed = false;
// RAIL-1 — and the other half of that memory: did you ever OPEN it by hand? `_sideUserCollapsed === false`
// cannot answer that (it is also the state of someone who never touched the toggle), and the rules-only
// fold below needs the difference — it must not shut a drawer you just pulled open.
let _sideUserExpanded = false;

// H2 — below 560px the rail held 160px of a 400px window, leaving the message column narrower than the
// rail's own chips. Same breakpoint as the nav drawer (NAV_MQ in boot.js), same mechanism, for the same
// reason: a hard `width: 40px` in CSS would leave #chatSideToggle reporting aria-expanded="true" and the
// „einklappen" tooltip over a strip that shows nothing. So the collapse runs through
// chatSideSetCollapsed(), exactly like a click, and title/icon/aria stay true.
const RAIL_NARROW_MQ = window.matchMedia
  ? window.matchMedia('(max-width: 560px)')
  : { matches: false, addEventListener: () => {} };
function railIsNarrow() { return !!RAIL_NARROW_MQ.matches; }
// Leaving the breakpoint restores YOUR choice, not the forced one — which only works because the
// narrow collapse is passed as `auto` and therefore never overwrote chatLayout.sideCollapsed.
function chatSideApplyNarrow() {
  if (railIsNarrow()) chatSideSetCollapsed(true, { auto: true });
  else chatSideSetCollapsed(!!chatLayoutGet().sideCollapsed, { auto: true });
}

// ---------------- persisted rules (settings.local permissions.allow) -----------------------------
function persistedAllows() {
  try { return (((STATE || {}).settingsLocal || {}).parsed || {}).permissions.allow || []; }
  catch { return []; } // no settings.local, or no permissions block
}
async function revokePersisted(entry) {
  const before = persistedAllows();
  const rest = before.filter((x) => x !== entry);
  if (rest.length === before.length) return; // already gone (a second click, or another window wrote first)
  // writes a file, so it asks first — unlike the session chips, this cannot be undone by a restart
  const ok = await uiConfirm(tt('chat-side.dauerhaftEntfernenFrage') + entry, {
    title: tt('chat-side.dauerhaftEntfernen'), okLabel: tt('common.loeschen-2'), danger: true,
  });
  if (!ok) return;
  // takes out just this rule from the file as it is now — not "the list I had minus this one"
  if (typeof localPermRemove === 'function') await localPermRemove('allow', entry);
  chatSideRefresh();
  // H4: the dialog and the undo guard two different mistakes and both happen. The dialog catches „I did
  // not mean to click anything"; it cannot catch „I confirmed, and it was the wrong one of ninety rules"
  // — the chips are ellipsised 160px-wide monospace paths, which is exactly the confusable case. The undo
  // writes the list back as it WAS (`before`), not `rest + entry`, so an order the file had is kept.
  toast(tt('chat-side.dauerhaftEntferntToast') + entry, 'ok', {
    undo: {
      onClick: async () => {
        if (typeof saveLocalPerms === 'function') await saveLocalPerms('allow', before);
        chatSideRefresh();
      },
    },
  });
}
// H4: the chip was ONE <button> with an × painted inside it, so a click anywhere — on the ∞, on the
// path, on the padding — revoked a standing rule. The × is now the only control, and the chip around it
// is a plain <span>: a button inside a button is invalid markup, and it made the whole row a single
// target for the keyboard too.
function persistedChip(entry) {
  const c = el('span', 'cs-grant cs-grant-perm');
  c.appendChild(el('span', 'cs-grant-ico', '∞'));
  const nm = el('span', 'cs-grant-nm', entry); nm.title = entry;
  c.appendChild(nm);
  const x = el('button', 'cs-grant-x', '×'); x.type = 'button';
  x.title = tt('chat-side.regelEntfernen') + entry;
  x.setAttribute('aria-label', tt('chat-side.regelEntfernen') + entry);
  x.onclick = (e) => { e.stopPropagation(); revokePersisted(entry); };
  c.appendChild(x);
  // the tooltip used to end in „klicken zum Entfernen" on the whole chip, which was both the symptom and
  // the invitation. It states what the rule IS; the instruction moved onto the × that carries it out.
  c.title = tt('chat-side.dauerhaftTooltip') + entry;
  return c;
}

// ---------------- open points (D2) ----------------------------------------------------------------
// For an uncertainty found mid-work there used to be two options and both cost the user:
// AskUserQuestion stops the whole turn until it is answered (including everything that does not
// depend on the answer), or a sentence in prose that gets scrolled past. Open points are the third
// option: they are stated, they are visible, and the work continues.
//
// Held on the TAB (not in localStorage): they belong to this conversation, and a stale question from
// yesterday reappearing in the rail would be worse than not having the rail.
//
// TWO VIEWS, ONE STATE. The rail row survives scrolling but is 220px wide; the card in the transcript
// has room for the reasoning and for one-click answers but scrolls away. Neither alone is enough — a
// rail-only question is a question you never see next to the sentence that raised it, which is exactly
// the complaint that produced this. So both are rendered, both point at the SAME point object in
// `tab.openPoints`, and every change goes through openPointResolve(). There is no second copy of the
// state to keep in step; "in sync" is a property of the data model here, not of a sync routine.
let _opSeq = 0;
// CHAT-FLOW-8 — the points of ONE finished assistant message. This used to run once per turn, on
// `result`, and read only the turn's LAST text: a block in a message after which the turn went on (a held
// plan/question card, more tools, more text) never became a card — it stayed raw JSON in the transcript and
// never reached the rail. Now every message is lifted where it stands (chat-events.js, `assistant`), in two
// steps because the frame paints in between: take = the data (before the text is rendered, so the raw JSON
// is never painted), show = the card (after the frame's own tool/question/plan cards, i.e. at the end of the
// row, where it always was).
// Returns { text: what to show (blocks removed), cards: points that need a card here, found: n }.
function takeOpenPoints(tab, text) {
  const src = String(text || '');
  if (!tab || typeof openPointsExtract !== 'function' || src.indexOf('```offene-punkte') < 0) return { text: src, cards: [], found: 0 };
  const found = openPointsExtract(src);
  const shown = openPointsStrip(src); // …the card shows it readably; the block would repeat it unreadably
  if (!found.length) return { text: shown, cards: [], found: 0 };
  const r = openPointsAdopt(tab.openPoints, found, Date.now());
  tab.openPoints = r.points;
  tab.openPoints.forEach((p) => { if (!p.id) p.id = 'op' + (++_opSeq); });
  // what the queue counts as „Claude has asked" on `result` — only points NEW in this turn (CHAT-FLOW-7)
  tab._newOpenPoints = (tab._newOpenPoints || []).concat(r.fresh);
  // `accepted` are the objects that live in tab.openPoints (a repeated question is the SAME point, so card
  // and rail share one identity) — minus the ones that already have a card further up: one point, one card.
  // Two cards for one question would both be live, both correct and both redundant.
  const cards = r.accepted.filter((p) => !(p.id && tab.msgEl && tab.msgEl.querySelector('.op-card[data-op-id="' + p.id + '"]')));
  return { text: shown, cards, found: found.length };
}
function showOpenPoints(tab, bubble, took) {
  if (!tab || !took || !took.found) return;
  if (bubble && took.cards.length) {
    // the card goes into this row, so the row may not be one of the toggle-hidden ones
    if (typeof unmarkHideableRow === 'function') unmarkHideableRow(bubble);
    addOpenPointsCard(bubble, tab, took.cards, {});
  }
  if (tab === ACTIVE) { chatSideRefresh(true); if (!_sideUserCollapsed) chatSideSetCollapsed(false, { auto: true }); }
  else renderTabs();
}
// The net on `result`: whatever the per-message lift did not catch (normally nothing — lastAssistantText is
// stored already stripped). `chat.current` is the bubble of the turn that just ended; this runs BEFORE the
// result handler drops it.
function collectOpenPoints(tab) {
  const text = (tab && tab.lastAssistantText) || '';
  if (!text || text.indexOf('```offene-punkte') < 0) return;
  const took = takeOpenPoints(tab, text);
  tab.lastAssistantText = took.text;
  const bubble = tab.current && tab.current.textEl;
  if (bubble) {
    const raw = bubble._raw != null ? bubble._raw : bubble.dataset.raw;
    if (raw && String(raw).indexOf('```offene-punkte') >= 0 && typeof setAssistantText === 'function') {
      setAssistantText(bubble, openPointsStrip(raw));
    }
  }
  showOpenPoints(tab, bubble, took);
}

// The one place a point changes state. `answer` = the text to send (''/absent = just mark it settled),
// and every view of the point is repainted afterwards — that is the sync.
// `opts.send === false` records the answer WITHOUT starting a turn: the caller is already sending the
// message that answers it (a reply typed in the chat — see openPointsMatch in sendMessage).
function openPointResolve(tab, p, answer, opts) {
  if (!tab || !p || p.done) return;
  const text = String(answer || '').trim();
  p.done = true;
  p.answer = text;
  p.staged = '';   // a settled point has nothing left to stage (and may have been staged a moment ago)
  // `guessed` = closed because it was the only open question when a free reply arrived (openPointsMatch
  // signal 3), not because anybody said so. openPointsMerge re-opens such a point if the model asks again.
  p.guessed = !!(opts && opts.guessed);
  // EVERY card, not just this one: in the automatic mode the number of open questions decides what
  // „answer" does, so settling one point can flip the meaning of all the others. Measured — with three
  // questions the buttons read „Vormerken", and after two were settled the remaining card still said
  // „Vormerken" while its click already sent immediately.
  openPointRepaintAll(tab);
  if (!text || (opts && opts.send === false)) return;
  // The turn is over by the time a point is answered, so this starts a new one — quoting the question,
  // because the answer arrives an unknown number of messages later and "Werk 2" on its own is a riddle.
  const msg = tt('chat-side.antwortAufOffenenPunkt') + p.frage + '\n\n' + text;
  if (typeof sendMessage === 'function') sendMessage({ text: msg, tab });
}
// A message that goes out answers the open points it quotes (openPointsMatch). Called where the message
// really LEAVES — not where it is queued: a queued text may still be removed or discarded (clearQueue), and
// closing a point for it then was never undone (F8). `before` = when a queued message was written; a point
// the model raised after that cannot be what it answers.
function openPointsAnswerFrom(tab, text, before) {
  if (!tab || !text || typeof openPointsMatch !== 'function' || !tab.openPoints || !tab.openPoints.length) return;
  // [Stand abfragen] (PF-1) is the panel asking, not the reader answering — but with exactly ONE open question
  // openPointsMatch reads any message as its answer („guessed"), and the click settled the question with the
  // protocol text as its answer. Decided by CONTENT, so all three ways out are covered (direct send, the queue
  // flush, the collect mode): only the panel writes a plan-schritte block into a message.
  if (typeof PLAN_STEPS_TAG === 'string' && String(text).indexOf('```' + PLAN_STEPS_TAG) >= 0) return;
  openPointsMatch(tab.openPoints, text, before ? { before } : null)
    .forEach((h) => openPointResolve(tab, h.point, h.answer, { send: false, guessed: h.guessed }));
}
// ---------------- collect mode -------------------------------------------------------------------
// „Erst alle Fragen beantworten, dann gesammelt senden." Answering one point starts a turn, and every
// further answer then waits in the queue behind it — so three open questions cost three turns, or you
// wait. In collect mode an answer is STAGED on its point and nothing is sent until you say go; then all
// staged answers travel as ONE message and all of them are marked settled together.
// The mode is a display preference (it sticks), because whether you answer one-by-one or in a batch is a
// working style, not a per-question decision.
// Three modes, and „automatisch" is the default: staging starts at the SECOND open question. With one
// question the immediate answer is right — nothing is queued behind it, and a „senden" button would be
// ceremony for its own sake. With two, answering the first is exactly what makes the second wait.
function openCollectModeNow() {
  return (typeof openCollectMode === 'function')
    ? openCollectMode(typeof DISPLAY !== 'undefined' ? DISPLAY.opCollect : 'auto') : 'auto';
}
function openCollectOn(tab) {
  const t = tab || (typeof ACTIVE !== 'undefined' ? ACTIVE : null);
  const n = (typeof openPointsOpenCount === 'function') ? openPointsOpenCount(t && t.openPoints) : 0;
  return (typeof openCollectActive === 'function') ? openCollectActive(openCollectModeNow(), n) : false;
}
// One click cycles automatisch → immer → nie. A tri-state as three labels rather than a hidden setting:
// the button says which mode is in force, and the toast says what that means for the next click.
function openCollectCycle(tab) {
  if (typeof DISPLAY === 'undefined') return;
  const order = ['auto', 'on', 'off'];
  const next = order[(order.indexOf(openCollectModeNow()) + 1) % order.length];
  openCollectSet(next, tab);
}
function openCollectSet(mode, tab) {
  if (typeof DISPLAY === 'undefined') return;
  DISPLAY.opCollect = (typeof openCollectMode === 'function') ? openCollectMode(mode) : mode;
  if (typeof saveDisplay === 'function') saveDisplay();
  const sel = $('#opCollectSel'); if (sel) sel.value = DISPLAY.opCollect;
  // Leaving collect mode must not swallow what is already written: the answers stay staged and the send
  // bar stays reachable, only NEW answers go out immediately again.
  const t = tab || (typeof ACTIVE !== 'undefined' ? ACTIVE : null);
  if (t) openPointRepaintAll(t);
  toast(tt('chat-side.sammelnModus' + DISPLAY.opCollect), 'ok');
}
// Stage (or re-stage) one answer without sending anything.
function openPointStage(tab, p, answer) {
  if (!tab || !p || p.done) return;
  p.staged = String(answer || '').trim();
  openPointRepaintAll(tab);
}
function openPointUnstage(tab, p) {
  if (!p) return;
  p.staged = '';
  openPointRepaintAll(tab);
}
// Every staged answer, one message, all points settled together. `send: false` on each resolve, because
// the ONE message below is the send — otherwise each point would start its own turn, which is the very
// thing collect mode exists to avoid.
function openPointsSendStaged(tab) {
  if (!tab) return;
  const staged = (typeof openPointsStaged === 'function') ? openPointsStaged(tab.openPoints || []) : [];
  if (!staged.length) return;
  const msg = openPointsComposeBatch(staged, { head: tt('chat-side.batchKopf'), arrow: tt('chat-side.batchPfeil') });
  staged.forEach((p) => openPointResolve(tab, p, p.staged, { send: false }));
  if (typeof sendMessage === 'function') sendMessage({ text: msg, tab });
  openPointRepaintAll(tab);
}
function openPointsDiscardStaged(tab) {
  if (!tab) return;
  (tab.openPoints || []).forEach((p) => { if (p) p.staged = ''; });
  openPointRepaintAll(tab);
  toast(tt('chat-side.verworfenToast'), 'ok');
}
// Repaint EVERY point of the tab, not just one: staging changes the send bar, which every card shows —
// and the collect threshold moves with the NUMBER of open questions, so there is no state change that
// only one card could reflect. A single-point variant existed next to this one for exactly that case and
// never found a caller; the decision is recorded here instead of as an unused function.
// Queries tab.msgEl, not document: a background tab's transcript DOM is detached.
function openPointRepaintAll(tab) {
  if (tab && tab.msgEl) {
    tab.msgEl.querySelectorAll('.op-card[data-op-id]').forEach((card) => {
      const p = (tab.openPoints || []).find((x) => x && x.id === card.dataset.opId) || card._point;
      if (p) paintOpenPointCard(card, tab, p);
    });
    tab.msgEl.querySelectorAll('.op-group').forEach((g) => paintOpenPointsBar(g, tab));
  }
  if (tab === ACTIVE) chatSideRefresh(true); else renderTabs();
}
// The bar under a card group: the collect toggle, and — as soon as something is staged — the one button
// that sends all of it. Rebuilt from the tab's points, so any group shows the same truth.
function paintOpenPointsBar(group, tab) {
  if (!group || group.classList.contains('op-history')) return;
  const old = group.querySelector(':scope > .op-bar'); if (old) old.remove();
  const staged = (typeof openPointsStaged === 'function') ? openPointsStaged(tab.openPoints || []) : [];
  const bar = el('div', 'op-bar');
  const active = openCollectOn(tab);
  const mode = openCollectModeNow();
  // The label says the MODE, not just the current effect — in „automatisch" the effect changes with the
  // number of open questions, and a button whose meaning silently flips would be worse than none.
  const tg = el('button', 'op-collect' + (active ? ' on' : ''),
    (active ? '⧉ ' : '↳ ') + tt('chat-side.sammelnModusKurz' + mode));
  tg.type = 'button'; tg.title = tt('chat-side.sammelnTooltip') + '\n' + tt('chat-side.sammelnModus' + mode);
  tg.onclick = () => openCollectCycle(tab);
  bar.appendChild(tg);
  if (staged.length) {
    const send = el('button', 'op-send-all', '➤ ' + tt('chat-side.nAntwortenSenden').replace('{n}', staged.length));
    send.type = 'button'; send.title = staged.map((p) => '· ' + p.frage + ' → ' + p.staged).join('\n');
    send.onclick = () => openPointsSendStaged(tab);
    const drop = el('button', 'op-drop-all', tt('chat-side.verwerfen'));
    drop.type = 'button';
    drop.onclick = () => openPointsDiscardStaged(tab);
    bar.appendChild(send); bar.appendChild(drop);
  }
  group.appendChild(bar);
}
// A fresh start empties the transcript (startChat) — but the open questions live on the TAB, so they are
// still waiting while their card is gone. Paint the ones that are still open back in, with a line saying
// where they come from: a card floating in an empty transcript without that line would look like a
// question the new session just asked.
function restoreOpenPointCards(tab) {
  if (!tab || !tab.msgEl || typeof addOpenPointsCard !== 'function') return;
  const open = (tab.openPoints || []).filter((p) => p && !p.done);
  const missing = open.filter((p) => !(p.id && tab.msgEl.querySelector('.op-card[data-op-id="' + p.id + '"]')));
  if (!missing.length) return;
  tab.msgEl.appendChild(el('div', 'history-note', '❓ ' + tt('chat-side.nochOffenAusVorherigem')));
  // addOpenPointsCard hangs the group off the bubble's ROW, so it needs a row — an empty bubble, hidden,
  // is enough and keeps one single painter for the card itself.
  const row = el('div', 'msg assistant op-restored');
  const bubble = el('div', 'bubble hidden');
  row.appendChild(bubble);
  tab.msgEl.appendChild(row);
  addOpenPointsCard(bubble, tab, missing, {});
}
function openPointRow(tab, p) {
  const row = el('div', 'cs-open' + (p.tone ? ' tone-' + p.tone : ''));
  const q = el('div', 'cso-q', p.frage); q.title = p.frage;
  row.appendChild(q);
  if (p.warum) row.appendChild(el('div', 'cso-why', p.warum));
  // n ready-made answers exist → say so, and let the row jump to the card that has the buttons rather
  // than duplicating them in 220px
  if (p.optionen && p.optionen.length) {
    const j = el('button', 'cso-jump', p.optionen.length + tt('chat-side.antwortenImChat'));
    j.type = 'button'; j.title = tt('chat-side.zurFrageImChat');
    j.onclick = (e) => { e.stopPropagation(); scrollToOpenPoint(tab, p); };
    row.appendChild(j);
  }
  // Staged in collect mode: the row keeps showing the QUESTION (it is not settled yet) but says that an
  // answer is already written — otherwise the rail would look untouched while three answers wait.
  if (typeof p.staged === 'string' && p.staged.trim()) {
    const s = el('span', 'cso-staged', '⧉');
    s.title = tt('chat-side.vorgemerkt') + ': ' + p.staged;
    row.appendChild(s);
  }
  const x = el('button', 'cso-x', '×'); x.type = 'button'; x.title = tt('chat-side.punktErledigt');
  x.onclick = (e) => { e.stopPropagation(); openPointResolve(tab, p, ''); };
  row.appendChild(x);
  // clicking the point puts it into the composer as the thing you are about to answer — the shortest
  // path from "I see the question" to "here is the answer", without inventing a second input field —
  // AND scrolls to its card (CHAT-FLOW-12): the question was asked in a context (the plan, the files it
  // was about) that the 220px row does not carry. The jump used to exist only behind „n Antworten", i.e.
  // only for points with options.
  q.onclick = () => {
    if (typeof composerSet === 'function') composerSet(p.frage + '\n\n', tt('chat-side.punktImComposer'));
    scrollToOpenPoint(tab, p);
  };
  mkClickable(q, p.frage);
  return row;
}
// Rail → card. The question was raised somewhere up the transcript; scrolling there beats re-reading it.
function scrollToOpenPoint(tab, p) {
  if (!tab || !tab.msgEl || !p || !p.id) return;
  if (tab !== ACTIVE && typeof activateTab === 'function') activateTab(tab);
  if (typeof showView === 'function') showView('chat');
  setTimeout(() => {
    const card = tab.msgEl.querySelector('.op-card[data-op-id="' + p.id + '"]');
    // a click that does nothing reads as „broken" — say why there is nothing to jump to
    if (!card) { toast(tt('chat-side.karteNichtMehrDa'), 'info'); return; }
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1200);
  }, 30);
}

// ---------------- the in-chat card ----------------------------------------------------------------
// Deliberately built from the AskUserQuestion card's classes (.opt-*): a question is a question, and
// two visual languages for "the model wants to know something" would be one too many. What differs is
// the promise — this card never blocks, and it says so.
//
// opts.history = painted from a resumed transcript. Those points are NOT taken back into tab.openPoints
// (a question from three days ago has usually answered itself, and the rail is for what is live), so
// the card is a record: it stays readable, its options fill the composer, nothing is sent behind your back.
function addOpenPointsCard(bubbleEl, tab, points, opts) {
  opts = opts || {};
  if (!bubbleEl || !points || !points.length) return null;
  const msg = bubbleEl.parentElement; if (!msg) return null;
  const group = el('div', 'opt-group op-group' + (opts.history ? ' op-history' : ''));
  const head = el('div', 'opt-group-head', '❓ ' + tt('chat-side.offenePunkte')
    + (points.length > 1 ? ' (' + points.length + ')' : '')
    + ' · ' + (opts.history ? tt('chat-side.ausDemVerlauf') : tt('chat-side.blockierenNicht')));
  group.appendChild(head);
  points.forEach((p) => group.appendChild(openPointCard(tab, p, opts)));
  msg.appendChild(group);
  paintOpenPointsBar(group, tab); // the collect toggle + „n Antworten senden", once per group
  return group;
}
function openPointCard(tab, p, opts) {
  const card = el('div', 'opt-card op-card' + (p.tone ? ' tone-' + p.tone : ''));
  if (p.id) card.dataset.opId = p.id;
  card.appendChild(el('div', 'opt-q', p.frage));
  if (p.warum) card.appendChild(el('div', 'opt-hint', p.warum));
  const body = el('div', 'op-body');
  card.appendChild(body);
  card._tab = tab; card._point = p; card._history = !!opts.history;
  paintOpenPointCard(card, tab, p);
  return card;
}
// The card's whole mutable part, rebuilt from the point. Called on creation and after every resolve —
// one painter, so the "answered" state cannot look different depending on where it was answered.
function paintOpenPointCard(card, tab, p) {
  const body = card.querySelector('.op-body'); if (!body) return;
  body.innerHTML = '';
  card.classList.toggle('is-done', !!p.done);
  if (p.done) {
    body.appendChild(el('div', 'opt-done', p.answer ? '→ ' + p.answer : '✓ ' + tt('chat-side.punktErledigtKurz')));
    return;
  }
  const history = !!card._history;
  // Already staged (collect mode): show the written answer instead of the input, with the two ways out —
  // change it, or drop it. Nothing has been sent, and the card says exactly that.
  if (!history && typeof p.staged === 'string' && p.staged.trim()) {
    const st = el('div', 'op-staged');
    st.appendChild(el('span', 'op-staged-mark', '⧉ ' + tt('chat-side.vorgemerkt')));
    st.appendChild(el('span', 'op-staged-text', p.staged));
    const edit = el('button', 'op-staged-edit', tt('chat-side.aendern')); edit.type = 'button';
    edit.onclick = () => { p.staged = ''; paintOpenPointCard(card, tab, p); };
    const drop = el('button', 'op-staged-drop', '×'); drop.type = 'button';
    drop.title = tt('chat-side.vormerkungVerwerfen');
    drop.onclick = () => openPointUnstage(tab, p);
    st.appendChild(edit); st.appendChild(drop);
    body.appendChild(st);
    return;
  }
  // In collect mode an answer is staged, not sent — one function decides it, so the option buttons and
  // the free-text field can never disagree about what a click does.
  const take = (text) => (openCollectOn(tab) ? openPointStage(tab, p, text) : openPointResolve(tab, p, text));
  // one-click answers, when the model offered any
  if (p.optionen && p.optionen.length) {
    const grid = el('div', 'opt-grid');
    p.optionen.forEach((o) => {
      const b = el('button', 'opt-btn'); b.type = 'button';
      b.appendChild(el('span', null, o.label));
      if (o.desc) b.appendChild(el('span', 'opt-desc', o.desc));
      // A picked option IS the answer — an open point has no other question waiting on it, so a second
      // "send" click would only add ceremony. In history mode nothing is sent; it fills the composer.
      b.onclick = () => {
        if (history) { if (typeof composerSet === 'function') composerSet(p.frage + '\n\n' + o.label + '\n\n', tt('chat-side.punktImComposer')); return; }
        take(o.label);
      };
      grid.appendChild(b);
    });
    body.appendChild(grid);
  }
  // free text: always available, because the useful answer to an open point is often "neither, do X"
  const ff = el('div', 'opt-freeform');
  const input = el('input', 'opt-ff-input'); input.type = 'text';
  input.placeholder = '✎ ' + (history ? tt('chat-side.antwortInComposer')
    : (openCollectOn(tab) ? tt('chat-side.antwortVormerken') : tt('chat-side.antwortSchreiben')));
  const send = el('button', 'opt-ff-send', history ? tt('chat-side.inComposer')
    : (openCollectOn(tab) ? tt('chat-side.vormerken') : tt('html.senden')));
  const submit = () => {
    const v = input.value.trim(); if (!v) return;
    if (history) { if (typeof composerSet === 'function') composerSet(p.frage + '\n\n' + v + '\n\n', tt('chat-side.punktImComposer')); return; }
    take(v);
  };
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); submit(); } };
  send.onclick = submit;
  ff.appendChild(input); ff.appendChild(send);
  body.appendChild(ff);
  if (history) return; // a historical point has no live state to settle
  const act = el('div', 'op-actions');
  const later = el('button', 'op-later', '✎ ' + tt('chat-side.inComposer')); later.type = 'button';
  later.title = tt('chat-side.punktImComposer');
  later.onclick = () => { if (typeof composerSet === 'function') composerSet(p.frage + '\n\n', tt('chat-side.punktImComposer')); };
  const done = el('button', 'op-done-btn', '✓ ' + tt('chat-side.punktErledigtKurz')); done.type = 'button';
  done.title = tt('chat-side.punktErledigt');
  done.onclick = () => openPointResolve(tab, p, '');
  act.appendChild(later); act.appendChild(done);
  body.appendChild(act);
}

// ---------------- plan progress (PF-1) ------------------------------------------------------------
// „Where are we in the accepted plan?" The panel's only progress display used to be #chatTodos, and it
// listens to TodoWrite alone — 0 calls in 561 transcripts, because CLI 2.1.288 switches TodoWrite and Task*
// off for Opus 5.5. So the model reports in its own text (```plan-status, see plan-progress.js), and this
// is where the report becomes visible: a group in the rail, a phase in the status strip (chat-status.js
// planPhase), a badge on the collapsed strip.
//
// The step list belongs to the MODEL. What the parser reads out of the plan is a suggestion that travels
// with the approval (chat-render.js resolvePlanGate) — for half of the plans there is nothing to read, and
// the model's first report then brings the list.
//
// Tab fields. Only tab.plan is persisted (planSave in persistTabs); the others point into the live
// transcript and go with it (startChat, closeTab):
//   tab.plan            what the rail shows — proposed → active → done | dismissed | superseded
//   tab.planCandidates  { toolId: plan } — the ExitPlanMode proposals seen, ≤ PLAN_CAPS.cands. While a plan
//                       is underway a new proposal lives only here and in its card (planOffer).
//   tab._planRows       { S3: message row } — where a step was reported, the first jump target of a click
//                       (pruneToolCards drops the rows trimTranscript took out of the DOM)
//   tab._planTools      main-thread tool calls since the model last reported (the quiet hint)
//   tab._planPrev       { toolId, plan, rows, tools } — the plan an approval put away while its POST is in
//                       flight; a failed POST brings it back (planGateFailed), a delivered one lets it go
//   tab._planOrphan     the newest ORPHANED proposal that waits under a plan underway — what its card's ▶ starts
//                       (PF-1b; the fold's f.orphan, planStartPick). Registered in planCandidates too (planOrphanSet).
//                       It comes back with a resume (lib/sessions.js planOrphan → planAdoptResumed), a reload (cc_tabs)
//                       and a fork — kept only live, the ▶ its card offered was gone after any of them.
//   tab._planLast       { title, file } of the newest ExitPlanMode seen — the name of a plan the model reports
//                       without one (planFromStatus; the fold's f.last). Comes back the same three ways.
//   tab._planChipOff    the composer chip „📋 Plan-Fortschritt mitsenden" switched off for the message being typed
//                       (chat-composer.js; back on once the composer is empty)

// Off → no group, no phase, no progress on the history cards, no step block in the approval message, no new
// proposal registered. What is NOT switched off is the bookkeeping the resume fold does anyway — reports still
// apply to a plan underway, an approval without the block still takes it down (planUntracked), a resume still
// adopts the transcript's plan — so that switching back on shows what a reload would show, not a stale plan.
function planProgressOn() { return !(typeof STATE !== 'undefined' && STATE && STATE.prefs && STATE.prefs.planProgress === false); }
// A silent model gets a line in the rail after this many tool calls. Below it, quiet is normal: a step is
// several calls long, and a hint after each of them would be noise about nothing.
const PLAN_QUIET_TOOLS = 8;
function planCandidateOf(tab, toolId) {
  if (!tab || !toolId) return null;
  return (tab.planCandidates && tab.planCandidates[toolId]) || (tab.plan && tab.plan.id === toolId ? tab.plan : null);
}
// The tab's plan as the rail shows it, or null: switched off, none, put away (×), or „Weiter planen".
function planRailPlan(tab) {
  const p = tab && tab.plan;
  return (p && planProgressOn() && typeof planVisible === 'function' && planVisible(p)) ? p : null;
}
// At rest = nothing runs and no gate holds the CLI. Only then is the running step „paused", and only then
// may [Stand abfragen] start a turn — while one runs, the question would just queue behind it.
function planTabRests(tab) {
  return !!tab && !tab.streaming && !tab._turnOpen && !(typeof hasHeldGate === 'function' && hasHeldGate(tab));
}
// …but a resting TURN is not a resting tab. A background agent or workflow this tab started (run_in_background)
// keeps working after the turn has ended — measured 05.10.: the step went grey the moment the reply was sent,
// while two workflows were still building the very step it named, and turned orange again only with the next
// message. So the step is „paused" only when the turn rests AND none of the tab's lanes still runs. The lanes
// are the 🤖 group's own (agent-lanes.js), so the two can never disagree about whether something works.
// [Stand abfragen] / ▶ keep asking planTabRests alone: they start a TURN, and a turn can start while lanes run.
function planTabBackground(tab) {
  const lanes = tab && Array.isArray(tab.agents) ? tab.agents : [];
  return lanes.some((a) => a && a.status === 'running');
}
function planTabIdle(tab) { return planTabRests(tab) && !planTabBackground(tab); }
// One path for every change: the state is saved, the ACTIVE tab's rail follows (a rebuild only when the
// structure moved — the signature decides; otherwise the live sentence is written in place). A background tab
// only gets the nav item's tooltip refreshed: that is the one place another tab's phase shows (refreshNavBusy →
// displayPhase → planPhase). NOT renderTabs: it empties the tab bar and builds it anew, and with one report
// per step that tore an open rename field out from under the typing (startTabRename) and could break a drag.
function planChanged(tab, structural) {
  if (!tab) return;
  if (typeof persistTabsSoon === 'function') persistTabsSoon();
  // a resumed transcript's history card of this plan says where it stands — and it stands somewhere else now;
  // the live card of an ORPHANED proposal offers ▶ only while that proposal is the one a start would begin
  if (structural) { planHistoryCardsPaint(tab); if (typeof planCardsPaint === 'function') planCardsPaint(tab); }
  if (tab !== ACTIVE) { if (typeof refreshNavBusy === 'function') refreshNavBusy(); return; }
  if (structural) chatSideRefresh(); else planRailPatch(tab);
  if (structural && typeof renderPlanChip === 'function') renderPlanChip(); // the composer chip follows the proposal
}

// A new ExitPlanMode card (chat-render.js addPlanCard). That function returns early for an id it has painted
// already — the assistant frame and the can_use_tool race both try — so this runs, and parses, once per
// proposal. Up to 600 KB of markdown: the parse is capped inside planNew (PLAN_CAPS.parse).
function planSeen(tab, toolId, md, file) {
  if (!tab || !toolId) return null;
  // the name a plan the model reports WITHOUT one gets (planFromStatus) — recorded with the switch off as well,
  // as the fold records it (f.last), so switching on later names that plan the way a resume would
  if (typeof planTitleOf === 'function') {
    const f = typeof planFileStr === 'function' ? planFileStr(file) : '';
    tab._planLast = { title: planTitleOf(String(md || '')) || planCleanTitle(planFileName(f).replace(/\.md$/i, '')), file: f };
  }
  if (!planProgressOn() || typeof planNew !== 'function') return null;
  let cand = planCandidateOf(tab, toolId);
  if (!cand) {
    cand = planNew(toolId, md, file, Date.now());
    if (!cand) return null;
    tab.planCandidates = tab.planCandidates || {};
    tab.planCandidates[toolId] = cand;
    const ids = Object.keys(tab.planCandidates); // insertion order = oldest first
    for (let i = 0; i < ids.length - PLAN_CAPS.cands; i++) delete tab.planCandidates[ids[i]];
  }
  const next = planOffer(tab.plan, cand); // a plan underway stays on top; otherwise the proposal shows, dimmed
  if (next !== tab.plan) { tab.plan = next; tab._planRows = {}; tab._planTools = 0; tab._planPrev = null; }
  planChanged(tab, true);
  return cand;
}
// The proposal an approval is about — null when the switch is off or the proposal is unknown (a card painted
// while the switch was off, or one evicted by three newer proposals). That approval then goes out as the
// plain sentence it always was (and planUntracked takes the rail's plan down with it).
function planGateCandidate(tab, toolId) { return planProgressOn() ? planCandidateOf(tab, toolId) : null; }
// What an approval puts away, kept until its POST is through: the gate can still fail (a 500, a dead chat),
// and planGateFailed then needs the plan that WAS underway — its steps, its ticks, its jump targets — not the
// five numbers its history entry keeps. Live only, never persisted (it can hold a 600 KB plan text).
function planKeepPrev(tab, toolId) {
  tab._planPrev = (tab.plan && tab.plan.id !== toolId) ? { toolId, plan: tab.plan, rows: tab._planRows || {}, tools: tab._planTools || 0 } : null;
}
// The approval went out (resolvePlanGate). The proposal is the plan underway now; the one underway so far
// moves into its history (planPromote, ≤ 5). Steps `null`: the approval was built from this very candidate,
// so its own steps ARE the list the model was shown — the one its IDs will refer to.
function planActivate(tab, toolId) {
  const cand = planCandidateOf(tab, toolId);
  if (!cand || typeof planPromote !== 'function') return null;
  const was = tab.plan;
  planKeepPrev(tab, toolId);
  tab.plan = planPromote(tab.plan, cand, null, Date.now());
  if (tab.planCandidates) delete tab.planCandidates[toolId]; // tab.plan holds it (and its text) from here on
  if (tab.plan !== was) tab._planRows = {};
  tab._planTools = 0;
  planChanged(tab, true);
  return tab.plan;
}
// An approval that went out WITHOUT the step block (the switch is off, or the panel never registered this
// proposal): the model works on a new plan now and was told nothing about reporting it. So the rail shows no
// plan — not the old one, which is over, and not this one, which nobody will report against. Exactly what the
// resume fold makes of the same transcript (planFoldResolve), so a reload cannot bring the old plan back.
function planUntracked(tab, toolId) {
  if (!tab || !tab.plan) return;
  tab._planPrev = { toolId, plan: tab.plan, rows: tab._planRows || {}, tools: tab._planTools || 0 };
  tab.plan = null; tab._planRows = {}; tab._planTools = 0;
  planChanged(tab, true);
}
// The POST got through: what it put away is history now.
function planGateSent(tab, toolId) { if (tab && tab._planPrev && tab._planPrev.toolId === toolId) tab._planPrev = null; }
// „Weiter planen" through a gate, and a stashed „Weiter planen" whose gate never came (clearAsksForTab): this
// proposal is off the table until the next ExitPlanMode. A plan already underway is never touched — proposals
// only. A card whose turn merely ENDED is no longer this case (PF-1b): it is orphaned (planOrphaned) and can
// still be started by message — „verfallen" without a decision was the one outcome nobody had chosen.
// A proposal the user had put away (×) is superseded underneath its dismissal — the fold sees no ×, only the „Weiter
// planen" (planStateSeen).
function planSuperseded(tab, toolId) {
  const cand = planCandidateOf(tab, toolId);
  if (!cand || typeof planSupersede !== 'function' || (typeof planStateSeen === 'function' ? planStateSeen(cand) : cand.state) !== 'proposed') return;
  planSupersede(cand, toolId);
  if (tab._planOrphan === cand) tab._planOrphan = null;
  planChanged(tab, true);
}
// PF-1b — no gate will ever decide this proposal (chat-render.js planCardOrphan): the CLI refused the ExitPlanMode
// outside plan mode (05.10.: the session ran in „Auto", no can_use_tool ever came), or the turn that held the gate
// ended undecided. Live and fold the same way (planOrphan / planFoldResolve, planFoldAbandon): the proposal stays
// on the table, „Plan liegt vor — noch nicht gestartet", and ▶ Plan starten begins it by an ordinary message.
// One under a plan underway is remembered as the tab's orphan — its card's ▶ is what would start it.
function planOrphaned(tab, toolId) {
  const cand = planCandidateOf(tab, toolId);
  if (!cand || cand.state !== 'proposed' || typeof planOrphan !== 'function') return null;
  planOrphan(cand, toolId);
  if (cand !== tab.plan && (!tab._planOrphan || (cand.seenAt || 0) >= (tab._planOrphan.seenAt || 0))) tab._planOrphan = cand;
  planChanged(tab, true);
  return cand;
}
// The proposal a start would begin (planStartPick — the fold's own rule), or null.
function planStartTarget(tab) {
  return (tab && typeof planStartPick === 'function') ? planStartPick(tab.plan, tab._planOrphan) : null;
}
function planStartTargetId(tab) { const p = planStartTarget(tab); return p ? p.id : ''; }
// The tab's orphan under a plan underway — set, or cleared with null. Registered as a candidate as well: everything that
// looks a proposal up by its id (planCandidateOf: ▶ on its card, planStartNow, planCardState) has to find it, also after
// a resume, a reload or a fork brought it back without the card that registered it.
function planOrphanSet(tab, o) {
  if (!tab) return;
  tab._planOrphan = o || null;
  if (o) { tab.planCandidates = tab.planCandidates || {}; tab.planCandidates[o.id] = o; }
}
// May ▶ Plan starten be offered for `p`? It must be the proposal a start would begin, and no gate may still be
// able to decide it: a proposal whose card waits for its can_use_tool is approved through that card — a message
// beside it would answer a question nobody asked. (planOpenGate: chat-render.js; the card stays the decider.)
function planStartable(tab, p) {
  if (!p || p !== planStartTarget(tab)) return false;
  return p.gate === 'none' || !(typeof planOpenGate === 'function' && planOpenGate(tab, p.id));
}
// A start FOR THE PROPOSAL ON THE TABLE sits in the queue (typed while a turn runs, ▶ while busy) — derived from the
// queue itself, so an entry removed by × or dropped by an interrupt leaves nothing stale behind: the proposal simply
// shows ▶ again. By the entry's `planFor` (chat-composer.js enqueueMessage): the model can propose AGAIN in the turn the
// start waits behind, and a newer proposal then said „startet nach diesem Turn" for a start that was built for the old
// one (flushQueue drops that one instead of sending it — planQueuedStale).
function planStartQueued(tab) {
  const id = planStartTargetId(tab);
  return !!(id && Array.isArray(tab.queue) && tab.queue.some((it) => it && it.planFor === id && planQueuedStarts(it)));
}
// Is this queue entry a start (with the list, or the plain head with the switch off)?
function planQueuedStarts(item) {
  const k = (item && typeof planOutgoingKind === 'function') ? planOutgoingKind(item.text) : '';
  return k === 'start' || k === 'untracked';
}
// A queued start whose proposal is no longer the one a start would begin: the model proposed again (refused again, or
// with a gate the reader answered „Weiter planen"), the plan was started some other way, or nothing is on the table any
// more. Sent, it started THAT proposal with the old one's steps — or told the model „Plan freigegeben" right after
// „Weiter planen" — and the fold, reading the same text, agreed. So it does not go out (flushQueue).
function planQueuedStale(tab, item) {
  return planQueuedStarts(item) && (item.planFor || '') !== planStartTargetId(tab);
}
// A user message is about to go out (chat-composer.js sendMessage's direct path, flushQueue): a start begins the
// proposal on the table — with exactly the steps its block carries, the list the model is shown — and a keep puts
// it away. The fold reads the same text the same way (planFoldStart), so a resume shows what this tab shows.
// Mirrors planActivate for a gate: the plan it replaces is kept until the send is known to have gone through
// (planOutgoingSettled). → the started proposal's id, or ''.
function planNoteOutgoing(tab, text) {
  if (!tab || typeof planOutgoingKind !== 'function') return '';
  const kind = planOutgoingKind(text);
  const target = kind ? planStartTarget(tab) : null;
  if (!target) return '';
  if (tab._planOrphan === target) tab._planOrphan = null;
  // started by message = no gate decides it, now or later (the fold has orphaned it by then: planFoldAbandon) —
  // which is also what it falls back to if the send fails (planOutgoingSettled → planUnaccept keeps `gate`)
  planOrphan(target, target.id);
  if (kind === 'keep') { planSupersede(target, target.id); planChanged(tab, true); return ''; }
  // the plain head (▶ with the switch off): the model works on it now, told nothing about reporting — no plan in the
  // rail, the one underway included; the rule of an approval without the block (planUntracked), and the fold's
  if (kind === 'untracked') {
    if (tab.planCandidates) delete tab.planCandidates[target.id];
    if (tab.plan) planUntracked(tab, target.id); else planChanged(tab, true);
    return target.id;
  }
  const blk = typeof planStartBlockOf === 'function' ? planStartBlockOf(text) : null;
  const was = tab.plan;
  planKeepPrev(tab, target.id);
  tab.plan = planPromote(tab.plan, target, blk ? blk.steps : null, Date.now());
  if (tab.planCandidates) delete tab.planCandidates[target.id];
  if (tab.plan !== was) tab._planRows = {};
  tab._planTools = 0;
  planChanged(tab, true);
  return target.id;
}
// …and how that send ended. Delivered → what it put away is history (planGateSent). Failed → the CLI never read
// it: the start is taken back exactly like a failed approval (planGateFailed — not once the model has reported
// against the plan), the orphan is an orphan again, and „erneut senden" starts it once more.
function planOutgoingSettled(tab, id, ok) {
  if (!tab || !id) return;
  if (ok) { planGateSent(tab, id); return; }
  planGateFailed(tab, id);
  const p = planCandidateOf(tab, id);
  if (p && p !== tab.plan && planIsOrphan(p)) { tab._planOrphan = p; planChanged(tab, true); }
}
// The queue changed (chat-composer.js): a start waiting in it turns ▶ into „startet nach diesem Turn" and hides the
// chip — for the rail, the cards and the composer, which is only worth doing for a tab that has a plan at all.
function planQueueNoted(tab) {
  if (!tab || !(tab.plan || tab._planOrphan)) return;
  if (typeof planCardsPaint === 'function') planCardsPaint(tab);
  if (tab !== ACTIVE) return;
  chatSideRefresh();
  if (typeof renderPlanChip === 'function') renderPlanChip();
}
// The gate POST failed (postGateReply): the CLI never heard the decision. An accepted plan goes back to
// „wartet auf Freigabe" (planUnaccept — but not once the model has reported against it: then the approval
// evidently did arrive), and a proposal „Weiter planen" had put away comes back with its re-armed card.
// The plan the approval had put away comes back on top, as it was before the click — while it is underway a
// proposal waits in its card (planOffer), and that is where this one waits again. Without that, the re-armed
// card's „Weiter planen" superseded the proposal and the rail was empty: the progress of the old plan gone.
function planGateFailed(tab, toolId) {
  if (!tab || typeof planUnaccept !== 'function') return;
  const prev = (tab._planPrev && tab._planPrev.toolId === toolId) ? tab._planPrev : null;
  tab._planPrev = null;
  const p = planCandidateOf(tab, toolId);
  let changed = false;
  if (p && p.state === 'superseded') { p.state = 'proposed'; changed = true; } // the inverse of planSupersede (no own name)
  else if (p && p.state === 'active' && !p.reportedAt) { planUnaccept(p, toolId); changed = true; }
  // the plan the approval put away (planActivate, planUntracked) — unless the approval evidently arrived after
  // all: then the model has reported against the new plan, which is what tab.plan still is
  if (prev && prev.plan && (changed || !tab.plan)) {
    if (p) { tab.planCandidates = tab.planCandidates || {}; tab.planCandidates[toolId] = p; }
    tab.plan = prev.plan; tab._planRows = prev.rows || {}; tab._planTools = prev.tools || 0;
    changed = true;
  }
  if (changed) planChanged(tab, true);
}

// One finished assistant message → its ```plan-status blocks applied to tab.plan, and the text without them
// (the rail shows the state; the raw JSON in the bubble as well would be the same thing twice, once
// unreadably). Called by chat-events.js BEFORE setAssistantText, like takeOpenPoints, so the JSON is never
// painted. Several blocks in one message are several reports, applied in order — the extractor caps them at
// PLAN_CAPS.blocks — with ONE repaint at the end. Through planFromStatus, the fold's own rule (PF-1b): a report
// with "schritte" and no plan it could be about STARTS a plan of the model's — the 05.10. session worked through
// „Schritt 0 …" with nothing in the rail to hang it on. Without "schritte" and without a plan the blocks are only
// stripped: a bare step change has nothing to show.
function takePlanStatus(tab, text, bubble) {
  const src = String(text || '');
  if (!tab || typeof planStatusExtract !== 'function' || src.indexOf('```' + PLAN_STATUS_TAG) < 0) return { text: src, applied: 0 };
  const shown = planStatusStrip(src);
  const ups = planStatusExtract(src);
  if (!ups.length) return { text: shown, applied: 0 };
  const now = Date.now();
  const row = bubble && bubble.parentElement;
  let structural = false, changed = false, unknown = 0, applied = 0;
  tab._planRows = tab._planRows || {};
  const mark = (id) => { if (row && id && !tab._planRows[id]) tab._planRows[id] = row; };
  ups.forEach((u) => {
    const r = planFromStatus(tab.plan || null, u, tab._planLast || null, now);
    if (!r.plan) return;
    if (r.created) { tab.plan = r.plan; tab._planRows = {}; tab._planTools = 0; tab._planPrev = null; tab._planUnknownFor = null; }
    applied++;
    structural = structural || r.structural; changed = changed || r.changed; unknown += r.unknown;
    const p = tab.plan;
    // the jump target of a step: the message it BEGAN in (the first report wins — it sits right above the
    // step's first tool calls), or for one that was never current, the message that closed it
    mark(p.current);
    (u.erledigt || []).concat(u.uebersprungen || []).forEach((ref) => mark(planStepRef(ref, p)));
  });
  const p = tab.plan;
  if (!applied || !p) return { text: shown, applied: 0 };
  // a report that hit something resets the quiet count (planApplyStatus stamps reportedAt only then)
  if (p.reportedAt === now) tab._planTools = 0;
  // IDs the plan does not have are ignored, never invented — said once per plan in the 🔔 log, because a
  // model that keeps reporting unknown IDs has lost the list, and [Stand abfragen] is the way to give it back
  // …and, for a plan WITHOUT a list, in the rail too (planUnknownSteps): the report changed nothing on its own, so the
  // fresh flag is what repaints the group from „Schritte folgen" to the hint above 📋 Schritte anfordern
  let fresh = false;
  if (unknown && tab._planUnknownFor !== p.id) {
    tab._planUnknownFor = p.id; fresh = true;
    if (typeof logEvent === 'function') logEvent(tt('chat-side.planUnbekannteIds') + unknown, 'warn');
    // 07.10. — and asked for NOW, not at the turn's end: the request goes into the running turn (injectNow) and the
    // model answers at its next tool boundary. Measured the same day: the hint stood for a whole implementation turn
    // because the first report came only as a thinking block. Once per plan (_planAutoAsked, as at the turn end).
    if (!p.steps.length && tab._planAutoAsked !== p.id && typeof injectNow === 'function' && typeof queueInjectLive === 'function' && queueInjectLive(tab)) {
      tab._planAutoAsked = p.id;
      if (typeof persistTabsSoon === 'function') persistTabsSoon();
      if (typeof logEvent === 'function') logEvent(tt('chat-side.planSchritteSofortAngefordert'), 'info');
      injectNow(tab, planStepsRequestMessage(tt('chat-side.planSchritteFrage'), p));
    }
  }
  if (structural || changed || fresh) planChanged(tab, structural || fresh);
  return { text: shown, applied };
}
// Main-thread tool calls since the last report — the count planWantsSteps reads (📋 Schritte anfordern); no hint shows it any more.
// Counted from the frames, not from tab.steps: that timeline restarts with every turn and stays empty while
// the tool display is switched off. Patched in place — a rebuild per tool call would be the churn
// planRailPatch exists to avoid.
function planNoteTools(tab, n) {
  if (!tab || !n || !tab.plan || tab.plan.state !== 'active') return;
  tab._planTools = (tab._planTools || 0) + n;
  if (tab === ACTIVE) planRailPatch(tab);
}
// No report yet. Never a guess at WHERE the model is — only that it has not said. The second line this used to
// carry, „Kein Stand seit N Werkzeugschritten", is gone (Julian, 07.10.: it read as „the rail does not update" while
// the rail was live, and said nothing a reader could act on). The count behind it (_planTools) still decides when
// 📋 Schritte anfordern is offered for a plan without a list (planWantsSteps) — that is a button, not a claim.
function planQuietText(tab, p) {
  if (!p || p.state !== 'active') return '';
  return p.reportedAt ? '' : tt('chat-side.planKeinStand');
}
function planStateWord(state) { return tt('chat-side.planZustand' + state); }
// An orphan is no „wartet auf Freigabe": nothing will ever approve it (planOrphan) — it lies there to be started.
function planStateLine(p, c) {
  if (p.state === 'proposed') return tt(p.gate === 'none' ? 'chat-side.planLiegtVor' : 'chat-side.planWartetAufFreigabe');
  if (p.state === 'done') return '✓ ' + planStateWord('done');
  return c.index ? tt('chat-side.planSchrittVon').replace('{i}', c.index).replace('{n}', c.total) : planStateWord(p.state);
}
// The count the head and the collapsed strip's badge show (PF-1b): the step it is ON, as „Schritt 3 von 8" says it
// — and between two steps (nothing current), how many are done. ✓ for a finished plan, the plain number of steps
// for a proposal, „–" for a plan whose list has not come yet.
function planCountText(p, c) {
  if (!c.total) return '–';
  if (p.state === 'done') return '✓' + c.total;
  if (p.state === 'proposed') return String(c.total);
  return (c.index || c.done) + '/' + c.total;
}
// 📋 Schritte anfordern — the plan has no list the MODEL confirmed (it never reported, or the list is empty): the
// screenshot of 05.10. („Im Plan keine Schritte erkannt" while Claude worked through „Schritt 0 …"). For a proposal
// that a start could begin (an orphan) always — that is the case where the model works without a word —, for a plan
// underway at rest, or busy once the model has gone PLAN_QUIET_TOOLS tool calls without one. Never beside a gate.
function planWantsSteps(tab, p) {
  if (!p || (p.reportedAt && p.steps.length)) return false;
  if (p.state === 'proposed') return planStartable(tab, p);
  if (p.state !== 'active') return false;
  return planTabRests(tab) || planUnknownSteps(tab, p) || ((tab && tab._planTools) || 0) >= PLAN_QUIET_TOOLS;
}
// 07.10. — a plan without a list, and the model already reported step IDs for it (takePlanStatus: „S2", „S1" done):
// it HAS a list, the panel never got it (the parser suggested none, the report that carried `schritte` did not
// arrive). „Schritte folgen" is then wrong — they will not follow by themselves; the rail says so and asks for them.
function planUnknownSteps(tab, p) { return !!(p && !p.steps.length && tab && tab._planUnknownFor === p.id); }
// What the group shows, for chatSideRefresh's guard: planSig (structure and status — NOT the sentence, which
// planRailPatch writes in place) plus what is derived at paint time: the tab at rest (the paused step and
// [Stand abfragen]), whether anything was reported yet, the history. A piece missing here is a group that
// keeps showing yesterday's state.
// Rest/busy only where it changes something on screen: a plan underway (the paused step, [Stand abfragen]) and a
// proposal a start could begin (▶ says „nach diesem Turn" while one runs). For any other proposal or a finished
// plan it changes nothing, and in the signature it rebuilt the whole rail (≈100 grant chips) at every turn start,
// turn end and held gate — the very churn the guard is for. Whether a start can begin it and whether one is queued
// come from outside the plan (the tab's orphan, the queue), so they are in it too — and so is 📋 Schritte
// anfordern, which the quiet count can bring up in the middle of a running turn.
// PF-2 — and the model's own tasks the steps show (planTaskSig: only the PLACED ones — a task in the strip is the
// strip's business and must not rebuild the rail). `split` = planTaskSplit(tab), handed in by chatSideRefresh.
function planRailSig(tab, split) {
  const p = planRailPlan(tab);
  if (!p || typeof planSig !== 'function') return '';
  const startable = planStartable(tab, p);
  return [planSig(p), (p.state === 'active' || startable) ? (planTabRests(tab) ? (planTabBackground(tab) ? 'bg' : 'rest') : 'busy') : '-', p.reportedAt ? 1 : 0,
    (p.history || []).length, p.title || '', startable ? 'S' : '-', planStartQueued(tab) ? 'Q' : '-', planWantsSteps(tab, p) ? 'W' : '-',
    planUnknownSteps(tab, p) ? 'U' : '-', planTaskSig(split || planTaskSplit(tab))].join('|');
}
// PF-2 — Julian, 05.10.: „Aufgaben mit S<n> am Schritt, übrige in der Leiste." The ONE split of the tab's task list
// (plan-progress.js planTaskMap), for both of its readers: the plan group below and #chatTodos (chat-render.js
// renderTodoStrip, through planStripTasks). Over the plan the rail SHOWS — planRailPlan is null with the switch off, put
// away, or „Weiter planen", and planTaskMap places nothing for a plan that is not underway — so a task is never at a step
// the reader cannot see in the rail.
function planTaskSplit(tab) {
  const rows = (tab && Array.isArray(tab.taskList)) ? tab.taskList : [];
  return (typeof planTaskMap === 'function') ? planTaskMap(planRailPlan(tab), rows) : { byStep: {}, unmapped: rows.slice() };
}
// What #chatTodos shows: the tasks the plan group does NOT show. With the rail folded — by a click, or by a narrow
// window (H2) — the group is out of sight, and a task at its step would be visible NOWHERE, the very failure the one
// split exists against; so a folded rail gives the strip every task. The same for the plan GROUP folded shut (its head
// shows, its steps do not): that fold is remembered for every tab and every later plan (cc_chat_layout.fold_plan), so
// one click would otherwise hide every S-task for good — and the head counts steps, it says nothing of tasks inside.
// Read from the setting chatSideGroup opens the group by, not from the DOM: this runs before the rail is (re)built.
// `key` says what the strip was split by: the strip keeps it on its box (renderTodoStrip), and planStripSync repaints
// the strip when it no longer matches.
function planStripTasks(tab) {
  const all = (tab && Array.isArray(tab.taskList)) ? tab.taskList : [];
  const rail = $('#chatSide');
  if (!all.length || (rail && rail.classList.contains('collapsed')) || chatLayoutGet().fold_plan === true) return { rows: all, key: '' };
  const m = planTaskSplit(tab);
  return { rows: m.unmapped, key: typeof planTaskSig === 'function' ? planTaskSig(m) : '' };
}
// The strip follows the PLAN as well as its tasks: a plan that finishes, is put away or starts, the switch, the rail
// or the plan group folding — none of them touches tab.taskList, so the task doors (chat-render.js taskRepaint) never
// hear of them. Every one of them ends in chatSideRefresh, chatSideSetCollapsed or the plan group's ontoggle
// (chatSideGroup), and all three call this: one string compare, and a repaint of the strip only when the split moved —
// not on every rail repaint, which would fold an opened „√ N abgeschlossen".
function planStripSync() {
  const box = $('#chatTodos');
  if (!box || typeof renderTodoStrip !== 'function') return;
  const key = planStripTasks(typeof ACTIVE !== 'undefined' ? ACTIVE : null).key;
  if ((box.dataset.split || '') !== key) renderTodoStrip();
}
// The live parts of the group, written in place: the running step's sentence, the notes, the quiet hint.
function planRailPatch(tab) {
  if (!tab || tab !== ACTIVE) return;
  const slot = $('#chatSideSlot'), g = slot && slot.querySelector('.cside-plan');
  const p = tab.plan;
  if (!g || !p || g.dataset.planId !== p.id) return;
  // the quiet count crossed the threshold → 📋 Schritte anfordern appears: that is structure, not a sentence
  if (g.dataset.wants !== (planWantsSteps(tab, p) ? '1' : '0')) { chatSideRefresh(); return; }
  g.querySelectorAll('[data-plan-step]').forEach((row) => {
    const s = p.steps.find((x) => x && x.id === row.dataset.planStep); if (!s) return;
    const sentence = (s.id === p.current && s.status === 'in_progress') ? (p.activeForm || '') : '';
    const af = row.querySelector('.csp-af'); if (af) af.textContent = sentence;
    row.classList.toggle('has-af', !!sentence);
    const note = row.querySelector('.csp-note'); if (note) note.textContent = s.note || '';
  });
  const pn = g.querySelector('.csp-plannote'); if (pn) pn.textContent = p.note || '';
  const q = g.querySelector('.csp-quiet');
  if (q) { const t = planQuietText(tab, p); q.textContent = t; q.classList.toggle('hidden', !t); }
}
// The group. Second in the rail: after the open points (a question waits on the reader, a plan does not),
// before the agents (they are HOW a step gets done; the plan is WHAT is being done).
// PF-1b — the checklist asked for on 05.10.: „Schritt 3 von 8" and a bar on top, every step with ✓ ⏳ ☐ ⤼, the
// running one bold with an accent edge, and an orphaned proposal that says it lies there to be started.
function planRailGroup(tab, p, split) {
  const c = planCounts(p), rest = planTabRests(tab), idle = planTabIdle(tab);
  const byStep = (split || planTaskSplit(tab)).byStep; // PF-2 — the model's own tasks, at the steps they name
  const items = [];
  const head = el('div', 'csp-head');
  const title = el('div', 'csp-title', p.title || tt('chat-side.plan')); title.title = p.title || '';
  head.appendChild(title);
  head.appendChild(el('div', 'csp-state', planStateLine(p, c)));
  if (p.state !== 'proposed' && c.total) {
    const bar = el('div', 'csp-bar'), fill = el('span');
    fill.style.width = Math.round((c.done / c.total) * 100) + '%';
    bar.appendChild(fill); head.appendChild(bar);
  }
  items.push(head);
  // after a compaction the model may no longer know the IDs — say so instead of showing old ticks as current
  if (p.stale && p.state === 'active') items.push(el('div', 'csp-hint', tt('chat-side.planVeraltet')));
  // always there (hidden when empty), so planRailPatch can fill it without a rebuild
  const quiet = el('div', 'csp-hint csp-quiet'), qt = planQuietText(tab, p);
  quiet.textContent = qt; quiet.classList.toggle('hidden', !qt);
  items.push(quiet);
  if (p.steps.length) items.push(planStepList(tab, p, idle, byStep));
  else if (planUnknownSteps(tab, p)) items.push(el('div', 'csp-hint csp-unknown', tt('chat-side.planSchrittePanelUnbekannt')));
  else items.push(el('div', 'csp-empty', tt(p.state !== 'proposed' ? 'chat-side.planSchritteFolgen'
    : p.gate === 'none' ? 'chat-side.planKeineSchritteVerwaist' : 'chat-side.planKeineSchritteErkannt')));
  items.push(el('div', 'csp-note csp-plannote', p.note || ''));
  items.push(planRailFoot(tab, p, rest));
  const g = chatSideGroup('plan', tt('chat-side.plan'), items, p.state !== 'done', '📋');
  g.classList.add('cside-plan', 'is-' + p.state);
  if (p.state === 'proposed' && p.gate === 'none') g.classList.add('is-orphan');
  g.dataset.planId = p.id;
  g.dataset.wants = planWantsSteps(tab, p) ? '1' : '0';
  // the head count is progress, not the number of rows in the group — steps, never the tasks under them (PF-2)
  const gc = g.querySelector('.cside-groupcount');
  if (gc) gc.textContent = planCountText(p, c);
  return g;
}
// Steps in plan order, ALL of them: the count is what the checklist is read for („wie viele noch?"), and a fold
// hides exactly that. Completed ones fold away only in a long plan (more than PLAN_RAIL_ALL steps, from four done
// on, like the console's „+N completed") — there they would push the running step below a 220px rail.
const PLAN_RAIL_ALL = 12;
// `byStep` (PF-2, planTaskMap): the model's own tasks per step — a step's tasks follow its row, inside the fold too.
// But a finished step with a task still OPEN under it stays out of the fold: the fold is shut by default and says
// „✓ N abgeschlossen", and the strip does not show that task either (it stands at its step) — folded, an open task
// would be visible nowhere, under a label claiming it is done. (A task does not tick its step, nor does a step its tasks.)
function planStepList(tab, p, idle, byStep) {
  const list = el('div', 'todo-list csp-steps');
  const open = (s) => ((byStep && byStep[s.id]) || []).some((r) => r && r.status !== 'completed');
  const done = p.steps.filter((s) => s.status === 'completed' && !open(s));
  const fold = p.steps.length > PLAN_RAIL_ALL && done.length >= 4;
  const unrep = planUnreported(p);
  const add = (box, s) => {
    box.appendChild(planStepRow(tab, p, s, idle, unrep));
    const tasks = byStep && byStep[s.id] ? planStepTasks(byStep[s.id], s.id) : null;
    if (tasks) box.appendChild(tasks);
  };
  if (fold) {
    const cd = el('details', 'todo-done-toggle');
    cd.open = !!tab._planDoneOpen; // the rail is rebuilt on every step change — an opened fold stays open
    cd.ontoggle = () => { tab._planDoneOpen = cd.open; };
    cd.appendChild(el('summary', 'todo-done-sum', planStepMark('completed') + ' ' + done.length + tt('chat-render.abgeschlossen')));
    const cl = el('div', 'todo-list td-done-list');
    done.forEach((s) => add(cl, s));
    cd.appendChild(cl);
    list.appendChild(cd);
  }
  let group = '';
  p.steps.forEach((s) => {
    if (fold && done.includes(s)) return;
    if (s.group && s.group !== group) list.appendChild(el('div', 'csp-gh', s.group));
    group = s.group || '';
    add(list, s);
  });
  return list;
}
// PF-2 — the model's own tasks for one step („S2 · …", planTaskMap), right UNDER the step row and not inside it: the
// row is a button (a click jumps to the step's message), a task is not. Indented, one size smaller, the strip's state
// colours (.todo-item.<state>) with the checklist's marks (planTaskMark: ✓ ⏳ ☐, „?" for a word nobody measured), the
// text without its prefix — the step above says S2 already; the whole text, the description and the reason it does not
// tick anything stay in the tooltip. They only SHOW: the step's state is the model's plan-status report and nothing
// else (planTaskMap says why). Normalised by taskListView, the strip's own reader, so a task looks the same in both.
// Texts only through el(…, text), i.e. textContent — the subject is model-authored.
function planStepTasks(rows, id) {
  const v = (typeof taskListView === 'function') ? taskListView(rows).rows : [];
  if (!v.length) return null;
  const box = el('div', 'todo-list csp-tasks');
  box.dataset.planTasks = id;
  box.setAttribute('role', 'list');
  box.setAttribute('aria-label', id + ' · ' + tt('chat-render.aufgaben'));
  v.forEach((t) => {
    const it = el('div', 'todo-item csp-task ' + t.state);
    it.setAttribute('role', 'listitem');
    it.appendChild(el('span', 'todo-mark', planTaskMark(t.state)));
    it.appendChild(el('span', 'todo-text', planTaskLabel((t.state === 'in_progress' && t.activeForm) ? t.activeForm : t.text)));
    const L = [t.text];
    if (t.detail && t.detail !== t.text) L.push(t.detail);
    if (t.state === 'unknown') L.push(tt('chat-render.aufgabeStatusUnbekannt') + ': ' + t.status);
    L.push(tt('chat-side.planAufgabeNurAnzeige'));
    it.title = L.join('\n');
    box.appendChild(it);
  });
  return box;
}
// What an open step the model went past says (planUnreported): in a finished plan „ohne Abschluss-Meldung", in
// one underway „nicht gemeldet" — behind the current step, never reported, and therefore NOT work still to come.
function planUnrepText(p) { return tt(p.state === 'done' ? 'chat-side.planOhneMeldung' : 'chat-side.planNichtGemeldet'); }
// One step of the checklist (✓ ⏳ ☐ ⤼, planStepMark — #chatTodos keeps its own □ ■ √). Titles come from the plan or
// the model: text nodes only. The running step carries `is-current` — bold, with the accent edge (styles.css).
// `idle` = planTabIdle: the turn rests AND no background lane of the tab runs — only then is the step paused.
function planStepRow(tab, p, s, idle, unrep) {
  const run = s.id === p.current && s.status === 'in_progress';
  const it = el('div', 'todo-item csp-step ' + s.status + (run ? ' is-current' : '') + (run && idle ? ' paused' : ''));
  it.dataset.planStep = s.id;
  it.appendChild(el('span', 'todo-mark', planStepMark(s.status)));
  const body = el('span', 'csp-body');
  const sentence = run ? (p.activeForm || '') : '';
  body.appendChild(el('span', 'csp-af', sentence)); // what is happening right now, above the step's title
  body.appendChild(el('span', 'todo-text', s.title));
  // a step the model went past without reporting it: still open, and saying so — never ticked off silently
  if (unrep && unrep[s.id]) body.appendChild(el('span', 'csp-unrep', planUnrepText(p)));
  body.appendChild(el('span', 'csp-note', s.note || ''));
  it.appendChild(body);
  if (sentence) it.classList.add('has-af');
  it.title = s.id + ' · ' + s.title + (run && idle ? '\n⏸ ' + tt('chat-side.planPausiert') : '') + (s.note ? '\n' + s.note : '');
  it.onclick = () => planJump(tab, p, s.id);
  mkClickable(it, s.title);
  return it;
}
// A foot button that starts a turn. While one runs the message would only queue — the label says so instead of
// pretending it goes out now („nach diesem Turn"), the way the send button turns into „in die Warteschlange".
function planFootBtn(cls, label, title, busy, onclick) {
  const b = el('button', 'csp-btn' + (cls ? ' ' + cls : ''), label + (busy ? ' ' + tt('chat-side.planNachDiesemTurn') : ''));
  b.type = 'button'; b.title = title + (busy ? '\n' + tt('chat-side.planNachDiesemTurnTitel') : '');
  b.onclick = (e) => { e.stopPropagation(); onclick(); };
  return b;
}
function planRailFoot(tab, p, rest) {
  const foot = el('div', 'csp-foot');
  // ▶ Plan starten FIRST: for an orphan it is the one thing to do (PF-1b) — the approval as an ordinary message
  if (planStartable(tab, p)) {
    if (planStartQueued(tab)) {
      const q = el('button', 'csp-btn is-primary', '⏳ ' + tt('chat-side.planStartetNachTurn')); q.type = 'button';
      if (typeof inertBtn === 'function') inertBtn(q, tt('chat-side.planStartetNachTurnTitel')); else q.disabled = true;
      foot.appendChild(q);
    } else foot.appendChild(planFootBtn('is-primary', '▶ ' + tt('chat-side.planStarten'), tt('chat-side.planStartenTitel'), !rest, () => planStartNow(tab, p.id)));
  }
  const open = el('button', 'csp-btn', tt('chat-side.planOeffnen')); open.type = 'button';
  open.onclick = (e) => { e.stopPropagation(); planShowSidecar(tab, p); };
  foot.appendChild(open);
  // 📋 Schritte anfordern where no list is confirmed — and [Stand abfragen] where there is one; never both
  if (planWantsSteps(tab, p)) {
    foot.appendChild(planFootBtn('is-hot', '📋 ' + tt('chat-side.planSchritteAnfordern'), tt('chat-side.planSchritteAnfordernTitel'), !rest, () => planRequestSteps(tab)));
  } else if (p.state === 'active' && rest) {
    // lit up when there is reason to ask: a compaction, or a model that has not said anything for a while
    const ask = el('button', 'csp-btn' + (p.stale || planQuietText(tab, p) ? ' is-hot' : ''), tt('chat-side.planStandAbfragen'));
    ask.type = 'button'; ask.title = tt('chat-side.planStandAbfragenTitel');
    ask.onclick = (e) => { e.stopPropagation(); planAskStatus(tab); };
    foot.appendChild(ask);
  }
  const x = el('button', 'csp-x', '×'); x.type = 'button';
  x.title = tt('chat-side.planAusblenden'); x.setAttribute('aria-label', tt('chat-side.planAusblenden'));
  // put away until the next plan — the decision is the user's and survives a reload (planSave keeps the state)
  x.onclick = (e) => { e.stopPropagation(); if (typeof planDismiss === 'function') planDismiss(p); if (tab._planOrphan === p) tab._planOrphan = null; planChanged(tab, true); };
  foot.appendChild(x);
  return foot;
}
// [Stand abfragen] — on a click only, never by itself: it starts a turn. The step list goes along WITH the
// panel's belief about each step, and so does the protocol: after a compaction the model may have lost both
// the IDs and the rules, and this message is what brings them back. One text with „📋 Schritte anfordern"
// (planStepsRequestMessage): a question never starts anything, live or in the fold.
function planAskStatus(tab) {
  const p = tab && tab.plan;
  if (!p || p.state !== 'active' || typeof sendMessage !== 'function' || typeof planStepsRequestMessage !== 'function') return;
  sendMessage({ text: planStepsRequestMessage(tt('chat-side.planStandFrage'), p), tab, planMsg: true });
}
// 📋 Schritte anfordern (PF-1b) — „melde die Schrittliste deines aktuellen Plans und den aktuellen Schritt". The
// answer — a plan-status with "schritte" and "aktuell" — makes an orphan the plan underway (planFromStatus →
// planApplyStatus: a proposal reported against is active). In the 05.10. session that is ONE click.
function planRequestSteps(tab) {
  const p = tab && tab.plan;
  if (!p || !(p.state === 'proposed' || p.state === 'active') || typeof sendMessage !== 'function' || typeof planStepsRequestMessage !== 'function') return;
  sendMessage({ text: planStepsRequestMessage(tt('chat-side.planSchritteFrage'), p), tab, planMsg: true });
}
// 07.10. (Julian) — the hint of planUnknownSteps, done for the reader: at a turn end the list is asked for by itself
// (chat-events.js `result`), ONCE per plan. Only for a plan underway with NO steps that already got a report with IDs
// the panel does not know — and only into a quiet tab: not after a cancelled/failed turn or a context op (`turn.ok`),
// not over a question (chips or new open points: `turn.asked`; a held gate), never ahead of the queue (it goes
// first). `_planAutoAsked` is saved with the tab (chat.js persistTabs), so a second result frame, a reload or the
// next unknown report does not ask again — the hint stays for exactly that case. → true when it sent.
function planAutoAskSteps(tab, turn) {
  const p = tab && tab.plan, t = turn || {};
  if (!p || p.state !== 'active' || !planUnknownSteps(tab, p) || tab._planAutoAsked === p.id) return false;
  if (!t.ok || t.asked || (tab.queue || []).length || (typeof hasHeldGate === 'function' && hasHeldGate(tab))) return false;
  tab._planAutoAsked = p.id;
  if (typeof persistTabsSoon === 'function') persistTabsSoon();
  if (typeof logEvent === 'function') logEvent(tt('chat-side.planSchritteAutoAngefordert'), 'info');
  planRequestSteps(tab);
  return true;
}
// ▶ Plan starten (rail or card): the approval, as an ordinary message (planStartMessage) — the head, the suggested
// list without states, the protocol. sendMessage queues it while a turn runs; it activates the plan when it really
// goes out (planNoteOutgoing), exactly where the fold reads it as a start.
function planStartNow(tab, id) {
  const p = id ? planCandidateOf(tab, id) : planStartTarget(tab);
  if (!p || !planStartable(tab, p) || planStartQueued(tab) || typeof sendMessage !== 'function') return false;
  sendMessage({ text: planStartMessage(tt('chat-side.planStartKopf'), p), tab, planMsg: true });
  return true;
}
// Rail → transcript. Three targets, best first: the message that reported the step, the plan card, the plan
// in the sidecar. trimTranscript drops old rows and a resume repaints without them — and a click that does
// nothing reads as „broken", so the last stage says why it landed where it did.
function planJump(tab, p, stepId) {
  if (!tab || !p) return;
  if (tab !== ACTIVE && typeof activateTab === 'function') activateTab(tab);
  if (typeof showView === 'function') showView('chat');
  setTimeout(() => {
    const target = planJumpTarget(tab, p, stepId);
    if (!target) { planShowSidecar(tab, p); toast(tt('chat-side.planSprungKeinZiel'), 'info'); return; }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 1200);
  }, 30);
}
function planJumpTarget(tab, p, stepId) {
  // a message that was only the status block is a hidden row (.only-status) — the step's work is in the
  // visible rows right after it
  let row = tab._planRows && tab._planRows[stepId];
  for (let i = 0; row && i < 6; i++, row = row.nextElementSibling) if (row.isConnected && row.offsetParent !== null) return row;
  if (tab.msgEl) for (const g of tab.msgEl.querySelectorAll('.plan-group[data-tool-id]')) if (g.dataset.toolId === p.id) return g;
  return null;
}
// [Plan öffnen] — the plan in the sidecar: where it stands, every step with its note, the plan text and the
// earlier plans. The text is the one the model offered (tab.plan.text — live only, never persisted, it can be
// 600 KB). After a reload the plan FILE is the only copy left, and the model may have edited it since the
// approval: hence the „Datei-Stand" line above it.
// `past` ({ done, total, state, label, preview, chars } from a resumed transcript's history card): an EARLIER
// plan of the session. The panel kept only its numbers, not its steps — so it says that, instead of „Schritte
// folgen". Its head says what its CARD says (`label`: the history entry's state, or how the proposal was
// answered) — not the shape planRestore needed, which read „verworfen (weiter geplant)" for an approval. Its text
// is the preview the tail carried (the plan as it was proposed), not the plan file: the CLI writes every plan of
// a session into the same file, so for an earlier plan that file usually holds a later one.
function planShowSidecar(tab, p, past) {
  if (!p || typeof sidecarShow !== 'function') return;
  const c = planCounts(p);
  const node = el('div', 'plan-detail');
  const head = el('div', 'pd-head');
  head.appendChild(el('span', 'pd-state is-' + (past ? past.state : p.state), past ? past.label : planStateLine(p, c)));
  // the rail's count (planCountText: the step it is ON), not done/total — „2/3" beside the rail's „Schritt 2 von 3"
  // read as one step fewer than the rail said
  if (c.total) head.appendChild(el('span', 'pd-count', planCountText(p, c)));
  else if (past && past.total) head.appendChild(el('span', 'pd-count', past.done + '/' + past.total));
  node.appendChild(head);
  const facts = el('div', 'pd-grid');
  const fact = (k, v, copy) => {
    facts.appendChild(el('span', 'pd-k', k));
    const ve = el('span', 'pd-v', v); if (copy) ve.appendChild(copyBtn(() => v, tt('common.kopieren')));
    facts.appendChild(ve);
  };
  if (p.file) fact(tt('chat-side.planDatei'), p.file, true);
  if (p.acceptedAt) fact(tt('chat-side.planFreigegeben'), new Date(p.acceptedAt).toLocaleString());
  if (!past) fact(tt('chat-side.planQuelle'), tt(p.src === 'model' ? 'chat-side.planQuelleModell' : 'chat-side.planQuelleParser'));
  if (p.reportedAt) fact(tt('chat-side.planLetzteMeldung'), new Date(p.reportedAt).toLocaleString());
  node.appendChild(facts);
  const sec = (title) => { const s = el('div', 'pd-sec'); s.appendChild(el('h4', 'pd-h', title)); node.appendChild(s); return s; };
  const steps = sec(tt('common.schritte') + (c.total ? ' (' + c.total + ')' : ''));
  if (past) steps.appendChild(el('div', 'csp-empty', tt('chat-side.planFruehererPlan')));
  else if (!p.steps.length) steps.appendChild(el('div', 'csp-empty', tt(p.state !== 'proposed' ? 'chat-side.planSchritteFolgen'
    : p.gate === 'none' ? 'chat-side.planKeineSchritteVerwaist' : 'chat-side.planKeineSchritteErkannt')));
  const unrep = planUnreported(p);
  p.steps.forEach((s) => {
    const r = el('div', 'todo-item ' + s.status);
    r.appendChild(el('span', 'todo-mark', planStepMark(s.status)));
    const b = el('span', 'csp-body');
    if (s.group) b.appendChild(el('span', 'csp-gh', s.group));
    b.appendChild(el('span', 'todo-text', s.id + ' · ' + s.title));
    if (s.id === p.current && p.activeForm) b.appendChild(el('span', 'csp-af', p.activeForm));
    if (unrep[s.id]) b.appendChild(el('span', 'csp-unrep', planUnrepText(p)));
    if (s.note) b.appendChild(el('span', 'csp-note', s.note));
    r.appendChild(b); steps.appendChild(r);
  });
  if (p.note) steps.appendChild(el('div', 'csp-note', p.note));
  const txt = sec(tt('chat-side.planText'));
  const hint = el('div', 'pd-hint hidden'); txt.appendChild(hint);
  const body = el('div', 'plan-body pd-body'); txt.appendChild(body);
  if (p.history && p.history.length) {
    const h = sec(tt('chat-side.planFruehere'));
    p.history.forEach((e) => h.appendChild(el('div', 'pd-hist', (e.title || e.id) + ' · ' + planStateWord(e.state) + (e.total ? ' · ' + e.done + '/' + e.total : ''))));
  }
  const text = p.text || (past && typeof past.preview === 'string' ? past.preview : '');
  sidecarShow({ title: '📋 ' + (p.title || tt('chat-side.plan')), node, kind: 'node', raw: text });
  const scroller = $('#sidecarBody'); if (scroller) scroller.scrollTop = 0;
  if (text) {
    body.innerHTML = renderMarkdown(text); // renderMarkdown escapes — model text is never raw HTML
    // the tail carries the first PLAN_CAPS.preview characters — say so when that was not all of it
    if (!p.text && past.chars > text.length) {
      hint.textContent = tt('chat-side.planVorschauGekuerzt').replace('{m}', text.length).replace('{n}', past.chars);
      hint.classList.remove('hidden');
    }
    return;
  }
  const name = typeof planFileName === 'function' ? planFileName(p.file) : '';
  if (!name) { body.textContent = tt('chat-side.planTextFehlt'); return; }
  body.textContent = tt('common.lade');
  api('/api/plan?name=' + encodeURIComponent(name)).then((r) => {
    if (SIDECAR.node !== node) return; // another panel took the sidecar in the meantime
    const content = String((r && r.content) || '');
    body.innerHTML = renderMarkdown(content);
    hint.textContent = tt(past ? 'chat-side.planDateiStandFrueher' : 'chat-side.planDateiStand'); hint.classList.remove('hidden');
    SIDECAR.raw = content; // the sidecar's copy button copies what is shown
  }).catch(() => { if (SIDECAR.node === node) body.textContent = tt('chat-side.planTextFehlt'); });
}
// The collapsed strip's plan badge — separate from #chatSideCount, so that one's order (❓ > 🤖 > grants)
// stays as it is. CSS shows it only while the rail is collapsed: open, the group head says the same.
function planBadgePaint(p) {
  const b = $('#chatSidePlan'); if (!b) return;
  if (!p) { b.classList.add('hidden'); b.textContent = ''; b.title = ''; return; }
  const c = planCounts(p);
  b.textContent = (p.state === 'done' || p.state === 'active') && c.total ? planCountText(p, c) : '📋';
  b.title = '📋 ' + (p.title || tt('chat-side.plan')) + ' — ' + planStateLine(p, c);
  b.classList.remove('hidden');
}

// ---------------- the resumed tab (PF-1) --------------------------------------------------------------
// A resume — the reload, the dead-chat heal, a restart for a new effort, the Sessions list — repaints the
// transcript into an emptied tab (sessions.js renderResumeHistory). The plan comes along from the server's
// fold over the WHOLE file (lib/sessions.js parseTranscript → result.plan), not from the 220-event tail it
// paints: the approval that set up the step list is usually far older than that. The transcript is the truth;
// the tab keeps only what lives nowhere else, for the same plan — its dismissal and its live text (planAdopt).
// Called BEFORE the paint: the history cards and the steps' jump targets read the adopted plan.
// Adopted with the switch OFF as well — off is a view decision (planRailPlan, planPhase, the history cards paint
// nothing of it). Skipping the adoption kept a stale plan in the tab while the transcript went on without it:
// switched on again, the rail showed the old plan with the newer plan's ticks.
// PF-1b — `slots` = { orphan, last } (lib/sessions.js planOrphan / planLast): the orphan under a plan underway and the
// newest proposal's name, by the same rule (`undefined` = the server said nothing → keep the tab's). Without them the
// ▶ of that orphan's card was gone after every resume, and a plan the model reports without a "titel" was named after
// the proposal in the fold but nothing in the tab.
function planAdoptResumed(tab, fromTranscript, slots) {
  if (!tab || typeof planAdopt !== 'function') return;
  const was = tab.plan;
  tab.plan = planAdopt(tab.plan, fromTranscript);
  if (slots && typeof planAdoptOrphan === 'function') {
    if (slots.orphan !== undefined) planOrphanSet(tab, planAdoptOrphan(tab._planOrphan, slots.orphan));
    if (slots.last !== undefined) tab._planLast = planLastRestore(slots.last);
  }
  if (tab.plan !== was) { tab._planUnknownFor = null; tab._planPrev = null; } // a new plan object may say „unknown IDs" once more
  if (typeof persistTabsSoon === 'function') persistTabsSoon();
  if (tab === ACTIVE) chatSideRefresh(true);
  else if (typeof refreshNavBusy === 'function') refreshNavBusy(); // see planChanged — no tab-bar rebuild
}
// Where each step was first reported within the painted tail → Map(event → step IDs), so a click on a step
// lands on its message after a resume just as it does live (takePlanStatus marks the first report). Only reports
// AFTER the plan's own ExitPlanMode count, when that is in the tail: before it they were about an earlier plan,
// whose „S1" is not this plan's S1.
function planResumeMarks(tab, events) {
  const p = tab && tab.plan, out = new Map();
  if (!p || !Array.isArray(p.steps) || !p.steps.length || typeof planStatusExtract !== 'function' || !Array.isArray(events)) return out;
  let from = 0;
  events.forEach((e, i) => { if (e && e.kind === 'assistant' && (e.tools || []).some((tl) => tl && tl.id === p.id)) from = i + 1; });
  const seen = new Set();
  for (let i = from; i < events.length; i++) {
    const e = events[i];
    if (!e || e.kind !== 'assistant' || typeof e.text !== 'string' || e.text.indexOf('```' + PLAN_STATUS_TAG) < 0) continue;
    const ids = [];
    planStatusExtract(e.text).forEach((u) => {
      [u.aktuell].concat(u.erledigt || [], u.uebersprungen || []).forEach((ref) => {
        const id = ref ? planStepRef(ref, p) : '';
        if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
      });
    });
    if (ids.length) out.set(e, ids);
  }
  return out;
}
// The resumed transcript's ExitPlanMode, as a record instead of the JSON card it used to be (the input is the
// whole plan, and the tail caps it at 8000 characters — 61 of 73 measured plans are longer): title, how the
// proposal ended and where the plan stands, [Plan öffnen]. No buttons that decide anything — the gate it
// belonged to went with the process that asked. `tl.plan` = {title, file, chars, preview} from lib/sessions.js
// tailTool (`preview`: the first PLAN_CAPS.preview characters of the plan as proposed; an older server sends none).
// Classed plan-group + data-tool-id on purpose: planJumpTarget's second stage finds it like a live plan card.
function addPlanHistoryCard(bubbleEl, tab, tl) {
  const msg = bubbleEl && bubbleEl.parentElement;
  if (!msg || !tl || !tl.id) return null;
  const info = (tl.plan && typeof tl.plan === 'object') ? tl.plan : {};
  const file = typeof info.file === 'string' ? info.file : '';
  const name = typeof planFileName === 'function' ? planFileName(file) : '';
  const card = el('div', 'opt-group plan-group plan-hist');
  card.dataset.toolId = tl.id;
  card.dataset.title = String(info.title || '');
  card.dataset.file = file;
  // a property, not a data attribute: up to 8000 characters do not belong into the DOM's attribute table
  card._planPreview = typeof info.preview === 'string' ? info.preview.slice(0, PLAN_CAPS.preview) : '';
  card._planChars = (typeof info.chars === 'number' && isFinite(info.chars)) ? info.chars : 0;
  card.appendChild(el('div', 'opt-group-head', '📋 ' + tt('chat-side.planVerlauf')));
  card.appendChild(el('div', 'ph-title', info.title || name.replace(/\.md$/i, '') || tt('chat-side.plan')));
  card.appendChild(el('div', 'ph-state'));
  card.appendChild(el('div', 'ph-reply hidden')); // the „Weiter planen" feedback, once its tool_result is painted
  // something to open: the plan the rail shows (steps, live text or file), or an earlier one's text or file
  if ((tab && tab.plan && tab.plan.id === tl.id) || name || card._planPreview) {
    const act = el('div', 'ph-act');
    const open = el('button', 'csp-btn', tt('chat-side.planOeffnen')); open.type = 'button';
    open.onclick = (e) => { e.stopPropagation(); planHistoryOpen(tab, card); };
    act.appendChild(open);
    card.appendChild(act);
  }
  msg.appendChild(card);
  // PF-1b — the card of a proposal no gate can decide any more (an orphan: on top, or under a plan underway, as the
  // resume brought it back — planAdoptResumed) is painted like the live orphan card: ▶ Plan starten, ✎ Weiter planen
  // with its feedback field (planCardPaint). A history card had no buttons, and for the orphan under a plan underway the
  // rail has none either — after a reload, a resume or a fork nothing could start what the live tab had offered.
  const cand = typeof planCandidateOf === 'function' ? planCandidateOf(tab, tl.id) : null;
  if (cand && typeof planIsOrphan === 'function' && planIsOrphan(cand) && typeof planCardPaint === 'function') planHistoryCardArm(card);
  planHistoryCardPaint(tab, card);
  if (card.classList.contains('is-orphan')) planCardPaint(tab, card);
  return card;
}
// The parts of a live plan card that planCardPaint fills — the reason line under the state, the feedback field and the
// action row above [Plan öffnen]. Why it is orphaned comes with its tool_result (planHistoryCardResult); until then, and
// for a proposal that never got one, it is the turn that ended.
function planHistoryCardArm(card) {
  card.classList.add('is-orphan');
  card.dataset.orphan = 'turnend';
  const why = el('div', 'opt-hint plan-why');
  card.insertBefore(why, card.querySelector('.ph-reply'));
  const ff = el('div', 'opt-freeform'), fb = el('input', 'opt-ff-input');
  fb.type = 'text'; fb.placeholder = '✎ ' + tt('chat-render.planFeedbackPlatzhalter');
  ff.appendChild(fb);
  const ref = card.querySelector('.ph-act');
  card.insertBefore(ff, ref); card.insertBefore(el('div', 'opt-actions'), ref);
}
// The tool_result of that ExitPlanMode — the answer the proposal got. An approval says nothing worth reading
// again (the panel's own step block and protocol); „Weiter planen" carries the user's feedback, and that is
// shown. Approval or not by planIsApproval — the fold's own rule, so the card cannot contradict the rail.
// PF-1b — a refusal or an aborted gate (planGateLost, the fold's own rule) is no answer of the user's: as „nicht
// freigegeben — weiter geplant" with the CLI's <tool_use_error> as its „feedback" the card said the opposite of what
// happened — nobody had decided anything. It says that no gate could decide it, and shows no reply.
function planHistoryCardResult(tab, card, text) {
  if (!card) return;
  const s = String(text || '').trim();
  const ok = typeof planIsApproval === 'function' && planIsApproval(s);
  const lost = !ok && typeof planGateLost === 'function' && planGateLost(s);
  card.dataset.outcome = ok ? 'ok' : lost ? 'lost' : 'no';
  const reply = card.querySelector('.ph-reply');
  // an orphan's card shows no reply either: a Stop's „doesn't want to proceed" is the CLI's, not the user's feedback
  const orphan = card.classList.contains('is-orphan');
  if (!ok && !lost && !orphan && reply && s) { reply.textContent = s.length > 400 ? s.slice(0, 399) + '…' : s; reply.classList.remove('hidden'); }
  planHistoryCardPaint(tab, card);
  if (orphan && typeof planCardPaint === 'function') {
    // the reason line follows the result: refused outside plan mode, or a turn that ended
    card.dataset.orphan = (typeof planIsNoPlanModeError === 'function' && planIsNoPlanModeError(s)) ? 'noplanmode' : 'turnend';
    card.dataset.paint = '';
    planCardPaint(tab, card);
  }
}
// The card's state line. The plan the rail shows → its live state and count (planChanged repaints it); an
// earlier plan → the numbers it was left with (its history entry); anything else → only how the proposal
// ended, which is all the tab knows about it. With the switch off only that last part: the card replaces the
// JSON card every ExitPlanMode had, so it stays — the progress it would add is what the switch turns off.
function planHistoryCardPaint(tab, card) {
  const line = card && card.querySelector('.ph-state');
  if (!line) return;
  // the labels too, not only the state: a language switch repaints the cards through here (planHistoryCardsRelabel).
  // The head of an ORPHAN's card is planCardPaint's („Plan liegt vor"), as on the live card
  const head = card.querySelector('.opt-group-head');
  if (head && !card.classList.contains('is-orphan')) head.textContent = '📋 ' + tt('chat-side.planVerlauf');
  const open = card.querySelector('.csp-btn'); if (open) open.textContent = tt('chat-side.planOeffnen');
  const id = card.dataset.toolId, plan = (tab && planProgressOn()) ? tab.plan : null;
  const p = (plan && plan.id === id && plan.state !== 'superseded') ? plan : null;
  const h = (!p && plan && Array.isArray(plan.history)) ? plan.history.find((e) => e && e.id === id) : null;
  const parts = [];
  // the rail's count (planCountText), and only where the state line does not say it already („Schritt 2 von 3")
  if (p) { const c = planCounts(p); parts.push(planStateLine(p, c)); if (c.total && !c.index) parts.push(planCountText(p, c)); }
  else if (h) { parts.push(planStateWord(h.state)); if (h.total) parts.push(h.done + '/' + h.total); }
  else parts.push(planOutcomeText(card.dataset.outcome));
  line.textContent = parts.join(' · ');
}
// How the proposal of a history card was answered (planHistoryCardResult): the card's line, and its sidecar's head.
function planOutcomeText(o) {
  return tt(o === 'ok' ? 'chat-side.planVerlaufFreigegeben' : o === 'no' ? 'chat-side.planVerlaufWeitergeplant'
    : o === 'lost' ? 'chat-side.planVerlaufOhneGate' : 'chat-side.planVerlaufOhneAntwort');
}
function planHistoryCardsPaint(tab) {
  if (!tab || !tab.msgEl || typeof tab.msgEl.querySelectorAll !== 'function') return;
  tab.msgEl.querySelectorAll('.plan-hist[data-tool-id]').forEach((card) => planHistoryCardPaint(tab, card));
}
// render.js applyLang: every tab's history cards are drawn by JS, so the static-i18n pass walks past them
function planHistoryCardsRelabel() { (typeof TABS !== 'undefined' ? TABS : []).forEach((t) => planHistoryCardsPaint(t)); }
// [Plan öffnen] on a history card: the plan the rail shows opens as it does from the rail; an earlier one as
// what is left of it — its numbers, its text as proposed (the tail's preview), else its plan file („Datei-Stand":
// the file has gone on since). The head says what the card says (planShowSidecar `past.label`).
function planHistoryOpen(tab, card) {
  const id = card.dataset.toolId, plan = (tab && planProgressOn()) ? tab.plan : null;
  if (plan && plan.id === id && plan.state !== 'superseded') { planShowSidecar(tab, plan); return; }
  const h = (plan && Array.isArray(plan.history)) ? plan.history.find((e) => e && e.id === id) : null;
  // the shape only: planRestore wants a plan state, and what the head shows comes from `past`
  const shell = typeof planRestore === 'function' ? planRestore({
    v: 1, id, title: card.dataset.title || '', file: card.dataset.file || '', state: 'superseded',
    steps: [], acceptedAt: h ? h.acceptedAt : 0,
  }) : null;
  if (!shell) return;
  const o = card.dataset.outcome;
  // a proposal „Weiter planen" put away may still have its whole text in memory (same tab, no reload)
  const live = (tab && tab.plan && tab.plan.id === id && typeof tab.plan.text === 'string') ? tab.plan.text : '';
  planShowSidecar(tab, shell, {
    done: h ? h.done : 0, total: h ? h.total : 0,
    state: h ? h.state : (o === 'ok' ? 'approved' : 'superseded'),
    label: h ? planStateWord(h.state) : planOutcomeText(o),
    preview: live || card._planPreview || '', chars: live ? live.length : (card._planChars || 0),
  });
}

// ---------------- the rail ------------------------------------------------------------------------
// Both groups fold. settings.local can hold ~100 rules; flat, that buries the session grants you
// actually came to check. The open/closed state is per group and remembered in cc_chat_layout.
// S2 — the emoji is its own span.cside-gico, not a prefix of the label: every group has one (⏱/🔒 had none),
// and the collapsed strip's jump bar (chatSideJumpPaint) reads it from there. `key` rides on the element for it.
function chatSideGroup(key, label, chips, defaultOpen, icon) {
  const d = el('details', 'cside-group cside-fold');
  d.dataset.key = key;
  d._sideLabel = label;
  d.open = chatLayoutGet()['fold_' + key] !== undefined ? !chatLayoutGet()['fold_' + key] : !!defaultOpen;
  // PF-2 — the plan group folded shut hides the tasks at its steps: the strip takes them (planStripTasks), and back
  // S1 — the head is sticky in the ONE scrolling .cside-body: a group folded by its stuck head would leave the
  // reader below it, somewhere in the next group — `nearest` pulls the head back into view (a no-op if it is)
  d.ontoggle = () => {
    chatLayoutSet({ ['fold_' + key]: !d.open });
    if (key === 'plan' && typeof planStripSync === 'function') planStripSync();
    if (!d.open && d.scrollIntoView) d.scrollIntoView({ block: 'nearest' });
  };
  const sum = el('summary', 'cside-grouphead');
  sum.appendChild(el('span', 'cside-gico', icon || ''));
  sum.appendChild(document.createTextNode(label));
  sum.appendChild(el('span', 'cside-groupcount', String(chips.length)));
  d.appendChild(sum);
  const box = el('div', 'cside-chips');
  chips.forEach((c) => box.appendChild(c));
  d.appendChild(box);
  return d;
}
// Cheap signature of what the rail currently shows. renderStatusBar() calls this on every init frame,
// tab switch and mode/model/effort change; without the guard each of those tore down and rebuilt ~100
// persisted chips for nothing (performance audit, finding 5).
let _sideSig = null;
function chatSideRefresh(force) {
  const rail = $('#chatSide'), slot = $('#chatSideSlot'), empty = $('#chatSideEmpty'), cnt = $('#chatSideCount');
  if (!rail || !slot) return;
  // PF-2 — #chatTodos shows the tasks the plan group does not; a plan that changed (done, put away, started, the switch)
  // ends here, so the strip is put right here — BEFORE the guard below, which knows nothing of the strip
  if (typeof planStripSync === 'function') planStripSync();
  const sessionTools = (typeof ACTIVE !== 'undefined' && ACTIVE && ACTIVE.alwaysAllow) ? [...ACTIVE.alwaysAllow] : [];
  const persisted = persistedAllows();
  const agents = (typeof ACTIVE !== 'undefined' && ACTIVE && ACTIVE.agents) || [];
  // The rail lists what is still WAITING. A point answered in the transcript card is settled, not
  // deleted — the card keeps the answer as a record, the rail drops the row.
  const allPoints = (typeof ACTIVE !== 'undefined' && ACTIVE && ACTIVE.openPoints) || [];
  const points = allPoints.filter((p) => !p.done);
  const plan = (typeof ACTIVE !== 'undefined') ? planRailPlan(ACTIVE) : null; // PF-1 — null when off/none/put away
  const taskSplit = plan ? planTaskSplit(ACTIVE) : null; // PF-2 — one split for the signature and the group
  // the open points MUST be part of the signature — the guard below skips the repaint otherwise and a
  // new question would never appear (D2). The signature covers the DONE flag too, otherwise answering a
  // point in the chat card left its row standing here: same questions, "nothing changed".
  const sig = sessionTools.join('|') + ' || ' + persisted.join('|')
    // lanesSig covers the row's STRUCTURE (status, badges, totals) but not its live numbers: elapsed,
    // current activity and the running token count tick in place (tickAgentMeta) — a repaint per
    // task_progress would rebuild the whole rail every ~2 seconds per agent.
    + ' || ' + (typeof lanesSig === 'function' ? lanesSig(agents) : agents.map((a) => a.id + ':' + a.status).join('|'))
    // U1 — a workflow's fan-out changes WITHOUT lanesSig() noticing: the lane's own status, desc and totals
    // stay put while eleven agents start and finish inside `task_progress.workflow_progress[]`. Without this
    // the ⚙ group would be painted once and then never again (the guard below skips the repaint on „nothing
    // changed"), which is how a rail ends up showing a run's first phase for the whole run.
    + ' || ' + (typeof wfSig === 'function' ? agents.map(wfSig).join('#') : '')
    + ' || ' + (typeof openPointsSig === 'function' ? openPointsSig(allPoints) : points.map((p) => p.frage).join('|'))
    // the plan's structure + status (not its live sentence — planRailPatch writes that in place)
    + ' || ' + (plan ? planRailSig(ACTIVE, taskSplit) : '')
    // hooks too, or a fired hook would only appear the next time something else changed
    + ' || ' + (((typeof ACTIVE !== 'undefined' && ACTIVE && ACTIVE.hooks) || []).map((h) => h.id + ':' + (h.done ? 'd' : 'r')).join('|'))
    // S3 — and the language: the jump bar's „Zu ‚…' springen" and every group label are tt() text, and a switch
    // (render.js applyLang → chatSideRefresh()) found „nothing changed" and left both in the old language
    + ' || ' + (typeof LANG !== 'undefined' ? LANG : '');
  if (!force && sig === _sideSig) return;
  _sideSig = sig;
  slot.innerHTML = '';
  const running = agents.filter((a) => a.status === 'running').length;
  // Open points come FIRST: they are the only thing in this rail that is waiting on the reader.
  // Grants are a record of what happened, agents are progress — a question is a request.
  if (points.length) {
    const g = chatSideGroup('open', tt('chat-side.offenePunkte'), points.map((p) => openPointRow(ACTIVE, p)), true, '❓');
    g.classList.add('cside-open');
    // …and the send bar right here, because the rail is where you see ALL the questions at once — the
    // card that raised one of them may be far up the transcript.
    const staged = (typeof openPointsStaged === 'function') ? openPointsStaged(ACTIVE.openPoints || []) : [];
    if (staged.length || points.length > 1) {
      const bar = el('div', 'cso-bar');
      if (staged.length) {
        const send = el('button', 'op-send-all', '➤ ' + tt('chat-side.nAntwortenSenden').replace('{n}', staged.length));
        send.type = 'button'; send.title = staged.map((p) => '· ' + p.frage + ' → ' + p.staged).join('\n');
        send.onclick = () => openPointsSendStaged(ACTIVE);
        bar.appendChild(send);
      }
      // With TWO or more open questions a prose reply is deliberately not read as an answer to any of them
      // (openPointsMatch: which one is not decidable), so those rows can only be cleared one ✕ at a time.
      // This is the escape hatch for exactly that case: settle all of them at once. Nothing is lost — the
      // questions stay in the transcript as cards, marked as settled.
      if (points.length > 1) {
        const all = el('button', 'op-clear-all', '✓ ' + tt('chat-side.alleErledigt').replace('{n}', points.length));
        all.type = 'button'; all.title = tt('chat-side.alleErledigtTitel');
        all.onclick = () => points.slice().forEach((p) => openPointResolve(ACTIVE, p, ''));
        bar.appendChild(all);
      }
      g.appendChild(bar);
    }
    slot.appendChild(g);
  }
  // The plan second (PF-1): what is being worked on, and where it stands.
  if (plan) slot.appendChild(planRailGroup(ACTIVE, plan, taskSplit));
  // U1 — a workflow run gets its OWN group, and the 🤖 group stops counting it as „one agent". The split
  // itself lives in chat-render.js agentLaneSplit() so both groups read the same rule.
  const split = (typeof agentLaneSplit === 'function') ? agentLaneSplit(typeof ACTIVE !== 'undefined' ? ACTIVE : null) : { plain: agents, workflows: [] };
  // Live activity next — it is the thing you look at while a turn runs.
  if (split.plain.length && typeof agentRows === 'function') {
    const plainRunning = split.plain.filter((a) => a.status === 'running').length;
    const label = split.plain.length > 1 ? tt('chat-render.agenten') : tt('chat-render.agent');
    const g = chatSideGroup('agents', label, agentRows(), true, '🤖');
    g.classList.add('cside-agents');
    // The plain count said "3" whether all three were working or all three were done and merely
    // fading out (#34). Running vs. finished is the whole difference between "wait" and "read", so
    // the head says both as soon as they differ.
    const gc = g.querySelector('.cside-groupcount');
    if (gc && plainRunning && plainRunning !== split.plain.length) gc.textContent = plainRunning + '/' + split.plain.length;
    else if (gc && !plainRunning) gc.textContent = '√' + split.plain.length;
    slot.appendChild(g);
  }
  // U1 — the workflow rail. Its own group because a workflow is not one row: it is phases, and agents
  // under them, and (while the run is over but an agent never reported) a sentence that no agent row in
  // the 🤖 group ever has to say. The head counts done/total and NEVER concludes „fertig": a run with
  // nothing running is also the gap between two phases (docs/messung-journal-2026-10-03.md).
  if (split.workflows.length && typeof workflowRows === 'function') {
    const c = (typeof workflowCounts === 'function') ? workflowCounts() : { total: 0, done: 0, open: 0 };
    const g = chatSideGroup('workflow', tt('chat-side.workflow'), workflowRows(), true, '⚙');
    g.classList.add('cside-workflow');
    const gc = g.querySelector('.cside-groupcount');
    if (gc) {
      // chat-render.js workflowCountLabel — the same text the ⚙ badge in the status strip shows.
      gc.textContent = (typeof workflowCountLabel === 'function') ? workflowCountLabel(c) : (c.done + '/' + c.total);
      // The count of agents the stream genuinely cannot place is IN that text („· 2?") — it belongs in the
      // head, because it is the one number a reader must not miss while scrolling past, and a folded group
      // shows its head and nothing else. The sentence that explains the `?` stays in the tooltip.
      gc.title = c.open ? tt('chat-side.workflowOffenN').replace('{n}', c.open) : (c.done + '/' + c.total);
      if (c.open) gc.classList.add('cside-count-open');
    }
    slot.appendChild(g);
  }
  // Hooks that actually FIRED this session (--include-hook-events). Folded by default: it is a
  // record, not something waiting on the reader — but "which hook changed this turn" was previously
  // unanswerable from the panel, even though the panel is where hooks are configured.
  const hooks = (typeof ACTIVE !== 'undefined' && ACTIVE && ACTIVE.hooks) || [];
  if (hooks.length) {
    const rows = hooks.slice().reverse().map((h) => {
      const it = el('div', 'cs-hook' + (h.done ? ' done' : ''));
      it.appendChild(el('span', 'csh-name', h.name));
      if (h.event && h.event !== h.name) it.appendChild(el('span', 'csh-ev', h.event));
      it.appendChild(el('span', 'csh-at', new Date(h.at).toLocaleTimeString()));
      it.title = h.name + (h.event && h.event !== h.name ? ' · ' + h.event : '') + '\n' + new Date(h.at).toLocaleString();
      return it;
    });
    slot.appendChild(chatSideGroup('hooks', tt('chat-side.hooks'), rows, false, '🪝'));
  }
  // grantChips() stays the single source for the session chip's look AND its revoke behaviour
  const session = (typeof ACTIVE !== 'undefined' && ACTIVE && typeof grantChips === 'function') ? grantChips(ACTIVE) : [];
  if (session.length) slot.appendChild(chatSideGroup('session', tt('chat-side.dieseSitzung'), session, true, '⏱'));
  if (persisted.length) slot.appendChild(chatSideGroup('perm', tt('chat-side.dauerhaft'), persisted.map(persistedChip), false, '🔒'));
  // S3 — the collapsed strip's jump bar, from the groups just painted: inside the guard above, so it is rebuilt
  // exactly when they are and can never show a group (or a count) the rail no longer has
  if (typeof chatSideJumpPaint === 'function') chatSideJumpPaint(slot);
  // the plan counts as content (an empty-looking rail folds itself away), and a plan being worked on — or
  // waiting for its approval — opens the rail like a grant does, unless you shut it yourself
  const planLive = !!plan && plan.state !== 'done';
  // …and only a step that RUNS is pending work for the warning edge: one marked running in a tab at rest (after
  // a stop, a resumed interrupted plan) is paused, and nothing waits on anything
  const planRunning = !!plan && plan.state === 'active' && planCounts(plan).running > 0 && !planTabIdle(ACTIVE);
  const total = session.length + persisted.length + agents.length + points.length + (plan ? 1 : 0);
  if (empty) empty.classList.toggle('hidden', total > 0);
  planBadgePaint(plan);
  // The head count shows what is WAITING on you first (open points), then what is live (running
  // agents), else what you granted this session — the standing rules are a fold, not news.
  if (cnt) {
    const n = points.length || running || session.length;
    // 🤖 instead of ⏱ for running agents: on the collapsed 40px strip the hourglass said "something
    // takes time", not "agents are working" — and with the rail shut that badge is the only signal
    // that a subagent exists at all (#34).
    // U1 — 🤖 counts AGENT lanes only, as the 🤖 group does; a running workflow is ⚙, after them. Counting it
    // in made the collapsed strip say „1🤖" for a tab whose rail had no 🤖 group at all. `running` (the
    // unsplit count) stays what decides that the badge shows and that the rail opens — a running workflow is
    // live work — only the WORD for it changed (chat-render.js agentLaneCounts).
    const lc = (typeof agentLaneCounts === 'function') ? agentLaneCounts(typeof ACTIVE !== 'undefined' ? ACTIVE : null) : { plainRunning: running, wfRunning: 0 };
    cnt.textContent = points.length ? points.length + '❓'
      : lc.plainRunning ? lc.plainRunning + '🤖'
        : lc.wfRunning ? lc.wfRunning + '⚙'
          : String(session.length);
    cnt.classList.toggle('hidden', !n);
  }
  rail.classList.toggle('has-pending', points.length > 0 || running > 0 || session.length > 0 || planRunning);
  const act = railAutoAction({ points: points.length, session: session.length, persisted: persisted.length, agents: agents.length, running,
    plan: plan ? 1 : 0, planLive: planLive ? 1 : 0 }, { userCollapsed: _sideUserCollapsed, userExpanded: _sideUserExpanded });
  if (act === 'fold') chatSideSetCollapsed(true, { auto: true });
  else if (act === 'open') chatSideSetCollapsed(false, { auto: true });
}
// S3 — the collapsed 40px strip as a jump bar: one button per group, its emoji and its head count, and a click
// opens the rail, opens that group and scrolls it to the top. The plan shows its 📋 only — the plan badge right
// above (planBadgePaint) already says „3/8", twice in 40px is noise. CSS shows the bar only while collapsed.
function chatSideJumpPaint(slot) {
  const bar = $('#chatSideJump');
  if (!bar) return;
  bar.innerHTML = '';
  [...slot.children].filter((g) => g.dataset && g.dataset.key).forEach((g) => {
    const key = g.dataset.key, gico = g.querySelector('.cside-gico'), gc = g.querySelector('.cside-groupcount');
    const b = el('button', 'cside-jump-btn');
    b.type = 'button';
    b.dataset.key = key;
    b.appendChild(el('span', 'cside-jump-ico', gico ? gico.textContent : ''));
    if (key !== 'plan' && gc && gc.textContent) b.appendChild(el('span', 'cside-jump-n', gc.textContent));
    const what = tt('chat-side.zuGruppeSpringen').replace('{g}', g._sideLabel || key);
    b.title = what; b.setAttribute('aria-label', what + (key !== 'plan' && gc ? ' (' + gc.textContent + ')' : ''));
    b.onclick = (e) => { if (e && e.stopPropagation) e.stopPropagation(); chatSideJumpTo(key); };
    bar.appendChild(b);
  });
}
// The group is looked up at click time — the rail may have been repainted since the bar was drawn.
function chatSideJumpTo(key) {
  chatSideSetCollapsed(false);
  chatLayoutSet({ ['fold_' + key]: false });
  const slot = $('#chatSideSlot');
  const g = slot && [...slot.children].find((x) => x.dataset && x.dataset.key === key);
  if (!g) return;
  if (!g.open) { g.open = true; if (key === 'plan' && typeof planStripSync === 'function') planStripSync(); }
  // after the rail has its width again — scrolling a display:none body does nothing
  requestAnimationFrame(() => g.scrollIntoView({ block: 'start' }));
}
// RAIL-1 — what the rail does to ITSELF after a repaint, as a decision a test can read.
//
// „Empty rail = 220px of nothing next to the chat → fold it away" was the rule, and the condition was
// `!total` with `total` INCLUDING the standing rules. settings.local can hold ~100 of them, so for anyone
// who ever clicked „immer erlauben" that condition was never true again and the automatic fold could not
// fire at all: the rail kept 220 px to show one collapsed <details> and nothing else. The head count had
// already decided this question the other way — `n` above is `points || running || session`, so the badge
// was hidden on a rail that stayed open.
//
// So the fold asks „is anything in here NEWS?" and standing rules are not news; they are a reference you
// go looking for, and the collapsed strip is one click wide. Two things it must NOT do:
//  · fold a rail that still holds a question, a session grant or an agent lane (that is the whole point of
//    the rail) — hence `news`, which keeps finished lanes in: „√3" is a result, and a result is news;
//  · fold a rail you OPENED yourself while only rules are in it. The empty-rail fold may ignore your click
//    (there is nothing to show), this one may not — you asked to see the rules, and a repaint during a
//    turn would otherwise shut the drawer in your hand.
// PF-1 — the plan is news in every state: a finished one is a result exactly like „√3", so it keeps the
// rail from folding (`plan`); a LIVE one (waiting for its approval, or being worked on) opens the rail like
// a grant does, unless you shut it yourself (`planLive`). A plan only being reported on is not a running
// agent: `running` stays the agents' count, the plan's warning edge is chatSideRefresh's own `planRunning`.
// U1 — `agents`/`running` are the UNSPLIT lane counts, workflows included, and that is deliberate: a running
// workflow is live work and opens the rail like a running agent does. The 🤖/⚙ split is a question of what a
// badge SAYS (chat-render.js agentLaneCounts), not of whether the rail has news.
function railAutoAction(counts, user) {
  const c = counts || {}, u = user || {};
  const news = (c.points || 0) + (c.session || 0) + (c.agents || 0) + (c.plan || 0);
  const total = news + (c.persisted || 0);
  if (!total) return 'fold';                                  // nothing at all — unchanged, ignores your click
  if (!news) return u.userExpanded ? '' : 'fold';             // rules only
  if ((c.points || c.session || c.running || c.planLive) && !u.userCollapsed) return 'open';
  return '';
}
function chatSideSetCollapsed(on, opts) {
  opts = opts || {};
  const rail = $('#chatSide'), btn = $('#chatSideToggle');
  if (!rail) return;
  // H2: an AUTOMATIC open is refused on a narrow window — a new grant or a running agent would
  // otherwise undo the narrow collapse a second later (chatSideRefresh reopens on exactly those).
  // An explicit click still opens it: you asked for the rail, you may have it, 160px and all.
  if (!on && opts.auto && railIsNarrow()) return;
  rail.classList.toggle('collapsed', !!on);
  // PF-2 — a folded rail hides the plan group, so the strip takes back the tasks that stood at its steps (planStripTasks)
  if (typeof planStripSync === 'function') planStripSync();
  if (btn) {
    btn.setAttribute('aria-expanded', String(!on));
    btn.title = on ? tt('chat-side.ausklappen') : tt('chat-side.einklappen');
    if (typeof ic === 'function') btn.innerHTML = ic(on ? 'chevronLeft' : 'chevronRight', 14);
  }
  // Only a real click is remembered. Persisting the AUTOMATIC collapse of an empty rail made it
  // indistinguishable from a deliberate one on the next load — the rail then stayed shut even though
  // grants existed, because _sideUserCollapsed came back as true.
  if (!opts.auto) { _sideUserCollapsed = !!on; _sideUserExpanded = !on; chatLayoutSet({ sideCollapsed: !!on }); }
}
// applyStaticI18n() resets the toggle to its data-i18n-title (the "collapse" wording), so after a
// language switch title AND icon have to be re-derived from the CURRENT collapsed state.
function refreshRailLabels() {
  const rail = $('#chatSide'), btn = $('#chatSideToggle');
  if (!rail || !btn) return;
  const on = rail.classList.contains('collapsed');
  btn.title = on ? tt('chat-side.ausklappen') : tt('chat-side.einklappen');
  if (typeof ic === 'function') btn.innerHTML = ic(on ? 'chevronLeft' : 'chevronRight', 14);
}
// NOTE: the composer deliberately does NOT follow the rail width. Indenting it by the rail made the
// rail look like it ran the full height of the view, and cost the input line width for no gain. The
// rail lives inside .chat-body and therefore ends where the message area ends; the composer below it
// always spans the full width, open or collapsed.

// ---------------- drag-to-resize (same interaction as the UI-Skills splitter) ---------------------
function initRailSplitter(grip, rail, cssVar, prefKey, def) {
  if (!grip || !rail) return;
  const clamp = (n) => Math.max(160, Math.min(560, n));
  const apply = (w) => { document.documentElement.style.setProperty(cssVar, clamp(w) + 'px'); };
  const saved = chatLayoutGet()[prefKey];
  if (saved) apply(saved);
  else if (def) apply(def);
  grip.onmousedown = (e) => {
    e.preventDefault();
    document.body.classList.add('is-resizing');
    const startX = e.clientX, startW = rail.getBoundingClientRect().width;
    const move = (ev) => apply(startW - (ev.clientX - startX)); // rail is on the right → inverted
    const up = () => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
      document.body.classList.remove('is-resizing');
      chatLayoutSet({ [prefKey]: clamp(rail.getBoundingClientRect().width) });
    };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  };
  // Reset to the stylesheet's width. NO syncComposerGutters() here: that function went with the full-width
  // composer (b2b682b) and this one call survived it, so every double-click threw a ReferenceError after the
  // reset had already worked — invisible because the width DID change and nobody reads the console for that.
  grip.ondblclick = () => { document.documentElement.style.removeProperty(cssVar); chatLayoutSet({ [prefKey]: null }); };
  grip.onkeydown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const w = clamp(rail.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? 24 : -24));
    apply(w); chatLayoutSet({ [prefKey]: w });
  };
}

function initChatLayout() {
  const rail = $('#chatSide');
  _sideUserCollapsed = !!chatLayoutGet().sideCollapsed;
  chatSideSetCollapsed(_sideUserCollapsed, { auto: true });
  const st = $('#chatSideToggle');
  if (st) st.onclick = (e) => { e.stopPropagation(); chatSideSetCollapsed(!rail.classList.contains('collapsed')); };
  // the whole 40px strip is the target when collapsed — not just the small button
  if (rail) rail.onclick = () => { if (rail.classList.contains('collapsed')) chatSideSetCollapsed(false); };
  initRailSplitter($('#chatSideResize'), rail, '--cside-w', 'sideWidth', 220);
  chatSideApplyNarrow(); // H2 — after the stored state, so a narrow window wins over it
  if (RAIL_NARROW_MQ.addEventListener) RAIL_NARROW_MQ.addEventListener('change', chatSideApplyNarrow);
  else if (RAIL_NARROW_MQ.addListener) RAIL_NARROW_MQ.addListener(chatSideApplyNarrow); // older engines
  chatSideRefresh();
}
