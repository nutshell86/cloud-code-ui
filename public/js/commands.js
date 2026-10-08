// Part of the Claude Code Control Panel front-end (split from app.js).
// Classic scripts share one global scope; load order in index.html is authoritative: render → chat → sessions → views → commands → boot.
// This file: commands.js

// ============================================================
//  SAP snippets · command palette · shortcuts
// ============================================================
// A19: a FUNCTION, not a load-time const — for two reasons. (1) The old array resolved its t() labels once
// at load, so a live language switch left them in the boot language. (2) The prompt BODIES were hardcoded
// German while only the labels were translated; they are user-facing text that lands in the composer, so
// they now live in i18n too (commands.snip*) and follow the UI language.
const SNIPPETS = () => [
  { cat: 'ABAP', label: t('commands.abapObjektErklaeren'), text: t('commands.snipAbapErklaeren') },
  { cat: 'ABAP', label: t('commands.atcCheckFixes'), text: t('commands.snipAtc') },
  { cat: 'ABAP', label: t('commands.abapUnitTests'), text: t('commands.snipAbapUnit') },
  { cat: 'ABAP', label: t('commands.kurzdumpAnalysieren'), text: t('commands.snipDump') },
  { cat: 'ABAP', label: t('commands.selectCdsUmbauen'), text: t('commands.snipSelectCds') },
  { cat: 'CDS', label: t('commands.cdsViewAusTabelle'), text: t('commands.snipCdsView') },
  { cat: 'UI5', label: t('commands.controlApiBeispiel'), text: t('commands.snipUi5Api') },
  { cat: 'UI5', label: t('commands.xmlViewSnippet'), text: t('commands.snipUi5Xml') },
  { cat: 'UI5', label: t('commands.odataV2ImController'), text: t('commands.snipUi5Odata') },
  { cat: 'OData', label: t('commands.metadataAnalysieren'), text: t('commands.snipMetadata') },
  { cat: 'OData', label: t('commands.odataQueryBauen'), text: t('commands.snipOdataQuery') },
  { cat: 'i18n', label: t('commands.i18nPropertiesPruefen'), text: t('commands.snipI18n') },
  { cat: 'CSS/HTML', label: t('commands.cssReviewen'), text: t('commands.snipCss') },
  { cat: 'Git', label: t('commands.aenderungenReviewen'), text: t('commands.snipGit') },
];

function showView(v) { const nav = document.querySelector('.nav-item[data-view="' + v + '"]'); if (nav) nav.click(); }
// Templates / saved prompts land AT THE CARET and keep a half-written draft (with a one-click undo) —
// this used to overwrite the composer with no way back (C7). Placeholder selection kept.
function insertSnippet(text) {
  showView('chat');
  composerInsert(text, { selectPlaceholder: true, newline: true, label: t('commands.eingefuegt') });
}

// --- personal prompt library (user-saved reusable prompts) ---
let USER_PROMPTS = [];
function sortedPrompts() { return (USER_PROMPTS || []).slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0)); }
async function loadPrompts() { try { const r = await api('/api/prompts'); USER_PROMPTS = r.prompts || []; } catch { USER_PROMPTS = []; } }
async function savePrompt(body) { const r = await api('/api/prompts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); await loadPrompts(); return r.prompt; }
async function deletePrompt(id) { await api('/api/prompts/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); await loadPrompts(); }
async function savePromptFromComposer() {
  const text = (($('#composerInput') && $('#composerInput').value) || '').trim();
  if (!text) { toast(t('commands.composerIstLeerErst'), 'err'); return; }
  const title = await uiPrompt(t('commands.titelFuerDenPrompt'), text.split('\n')[0].slice(0, 80), { title: t('commands.promptSpeichern'), okLabel: t('common.speichern') });
  if (title == null) return;
  try { await savePrompt({ title, text }); toast(t('commands.promptGespeichert'), 'ok'); } catch (e) { toast(e.message, 'err'); }
}
function openPromptManager() {
  const ov = el('div', 'modal-overlay'); ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
  const box = el('div', 'modal modal-wide');
  const head = el('div', 'modal-head'); head.innerHTML = ic('star', 18); head.appendChild(el('h3', null, t('commands.promptBibliothek'))); box.appendChild(head);
  const listEl = el('div', 'prompt-list'); box.appendChild(listEl);
  const acts = el('div', 'modal-actions');
  const addBtn = iconBtn('ghost-btn', 'plus', { label: t('commands.ausComposer'), onClick: async () => { await savePromptFromComposer(); draw(); } });
  const closeBtn = el('button', 'primary-btn', t('common.schliessen')); closeBtn.onclick = () => close();
  acts.appendChild(addBtn); acts.appendChild(closeBtn); box.appendChild(acts);
  // The stack owns Esc, Tab and the z-index (overlays.js). This dialog's own handler called
  // preventDefault() and nothing else, so the keystroke carried on to the global chain at the bottom of
  // this file and armed „Esc twice stops the turn" behind a dialog the user was only closing (VIEWS-ESC).
  const close = () => { overlayPop(ov); ov.remove(); };
  const draw = () => {
    listEl.innerHTML = '';
    const items = sortedPrompts();
    if (!items.length) { listEl.appendChild(el('div', 'empty-mini', t('commands.nochKeinePromptsTippe'))); return; }
    items.forEach((pr) => {
      const row = el('div', 'prompt-row');
      const star = iconBtn('fav-star' + (pr.pinned ? ' on' : ''), 'star', { title: pr.pinned ? t('commands.losloesen') : t('commands.anheften'), onClick: async () => { try { await savePrompt(Object.assign({}, pr, { pinned: !pr.pinned })); draw(); } catch (e) { toast(e.message, 'err'); } } });
      const info = el('div', 'prompt-info'); info.appendChild(el('div', 'prompt-title', pr.title)); info.appendChild(el('div', 'prompt-text', pr.text));
      mkClickable(info, t('commands.promptEinfuegen') + pr.title); info.onclick = () => { insertSnippet(pr.text); close(); };
      const edit = iconBtn('mini-btn', 'edit', { title: t('common.bearbeiten'), onClick: async () => {
        const nt = await uiPrompt(t('commands.titel'), pr.title, { title: t('commands.promptBearbeiten'), okLabel: t('html.weiter') }); if (nt == null) return;
        const nx = await uiPrompt(t('commands.text'), pr.text, { title: t('commands.promptText'), okLabel: t('common.speichern'), multiline: true, rows: 8 }); if (nx == null) return;
        try { await savePrompt({ id: pr.id, title: nt, text: nx, tags: pr.tags, pinned: pr.pinned }); draw(); } catch (e) { toast(e.message, 'err'); }
      } });
      const del = iconBtn('mini-btn', 'trash', { title: t('common.loeschen-2'), onClick: async () => { if (await uiConfirm(t('commands.prompt') + pr.title + t('common.loeschen'), { danger: true, okLabel: t('common.loeschen-2') })) { try { await deletePrompt(pr.id); draw(); } catch (e) { toast(e.message, 'err'); } } } });
      const rowActs = el('div', 'prompt-acts'); rowActs.appendChild(edit); rowActs.appendChild(del);
      row.appendChild(star); row.appendChild(info); row.appendChild(rowActs);
      listEl.appendChild(row);
    });
  };
  draw();
  ov.onclick = (e) => { if (e.target === ov) close(); };
  ov.appendChild(box); document.body.appendChild(ov);
  overlayPush(ov, { box, onEsc: close });
}

// --- global cross-session content search (Strg+Shift+F) ---
let _gsearchTimer = null;
function highlightMatch(text, q) {
  const wrap = el('span');
  const low = String(text).toLowerCase(), lq = String(q).toLowerCase();
  let i = 0, idx;
  while (lq && (idx = low.indexOf(lq, i)) >= 0) {
    if (idx > i) wrap.appendChild(document.createTextNode(text.slice(i, idx)));
    const mark = el('mark'); mark.textContent = text.slice(idx, idx + q.length); wrap.appendChild(mark);
    i = idx + q.length;
  }
  if (i < text.length) wrap.appendChild(document.createTextNode(text.slice(i)));
  return wrap;
}
// `prefill` + `sessionId` are the two handoffs into this overlay:
//  - in-chat search (C12): `sessionId` filters the hit list to one session, so "search the whole
//    session, not just what's painted" has an answer;
//  - the Sitzungen view (A14): hands its current filter query over as `prefill`, so "the list filter
//    found nothing" leads into the real full-text search instead of a dead end.
function openGlobalSearch(prefill, sessionId) {
  const existing = document.getElementById('gsearchOverlay'); if (existing) { existing.querySelector('.gsearch-input').focus(); return; }
  const ov = el('div', 'cmdk-overlay'); ov.id = 'gsearchOverlay'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
  const box = el('div', 'cmdk gsearch');
  const inp = el('input', 'gsearch-input'); inp.type = 'text'; inp.placeholder = sessionId ? t('commands.inDieserSessionSuchen') : t('commands.alleSessionsNachNachrichten'); inp.spellcheck = false; inp.autocomplete = 'off';
  if (prefill) inp.value = prefill;
  box.appendChild(inp);
  if (sessionId) {
    const sc = el('div', 'gsearch-scope');
    sc.appendChild(el('span', null, '⌖ ' + t('commands.nurDieseSession') + ' ' + sessionId.slice(0, 8)));
    const all = el('button', 'mini-btn', t('commands.alleSessions'));
    all.onclick = () => { sc.remove(); sessionId = null; inp.placeholder = t('commands.alleSessionsNachNachrichten'); run(); };
    sc.appendChild(all);
    box.appendChild(sc);
  }
  const listEl = el('div', 'cmdk-list gsearch-list'); box.appendChild(listEl);
  // overlayPop hands focus back where it came from (it remembers the opener at push time) and takes this
  // overlay off the stack, so Esc below it keeps working — see openPromptManager for what it replaces.
  const close = () => { overlayPop(ov); ov.remove(); };
  const run = async () => {
    const q = inp.value.trim();
    if (q.length < 2) { listEl.innerHTML = '<div class="cmdk-empty">' + t('commands.mindestens2Zeichen') + '</div>'; return; }
    listEl.innerHTML = '<div class="cmdk-empty">' + t('commands.suche') + '</div>';
    let hits = [];
    try { const r = await api('/api/search?q=' + encodeURIComponent(q) + '&limit=80'); hits = r.hits || []; }
    catch (e) { const d = el('div', 'cmdk-empty', t('common.fehler-2') + e.message); listEl.innerHTML = ''; listEl.appendChild(d); return; }
    if (inp.value.trim() !== q) return; // a newer keystroke superseded this response
    if (sessionId) hits = hits.filter((h) => h.sessionId === sessionId); // session-scoped handoff (C12)
    listEl.innerHTML = '';
    if (!hits.length) { listEl.innerHTML = '<div class="cmdk-empty">' + t('commands.keineTreffer') + '</div>'; return; }
    hits.forEach((h) => {
      const it = el('div', 'gsearch-hit');
      const meta = el('div', 'gsearch-meta');
      meta.appendChild(el('span', 'gsearch-role ' + h.role, h.role === 'user' ? t('common.du') : 'Claude'));
      meta.appendChild(el('span', 'gsearch-proj', h.projectPath || h.project));
      if (h.ts) meta.appendChild(el('span', 'gsearch-time', relTime(new Date(h.ts).getTime())));
      it.appendChild(meta);
      const sn = el('div', 'gsearch-snip'); sn.appendChild(highlightMatch(h.snippet, q)); it.appendChild(sn);
      mkClickable(it, t('commands.sessionOeffnen'));
      it.onclick = () => { close(); const s = { id: h.sessionId, project: h.project, projectPath: h.projectPath, title: '' }; showView('sessions'); if (typeof openTranscript === 'function') openTranscript(s, null); };
      listEl.appendChild(it);
    });
  };
  inp.addEventListener('input', () => { clearTimeout(_gsearchTimer); _gsearchTimer = setTimeout(run, 250); });
  ov.onclick = (e) => { if (e.target === ov) close(); };
  ov.appendChild(box); document.body.appendChild(ov);
  // autofocus:false — the input is focused below, together with the handed-over query's first search
  overlayPush(ov, { box, autofocus: false, onEsc: close, onEnter: () => overlayFocusFirst(listEl, '.gsearch-hit') });
  setTimeout(() => { inp.focus(); if (prefill) run(); }, 0); // a handed-over query should search immediately
}

// --- A13: global prompt history (Strg+Shift+H) ------------------------------------------------------
//
// WHY: recalling a prompt was ↑ in the composer and nothing else — `cc_prompt_history`, 100 entries, one
// browser's localStorage, not searchable. Two better sources existed all along and neither was reachable:
// the CLI's own terminal history (~/.claude/history.jsonl, 700+ prompts) and the prompts this panel
// sends (now recorded server-side, see chat-composer pushHistory). This overlay is the one place both
// show up, with the same shape as the full-text search (Strg+Shift+F) so there is nothing new to learn.
//
// Deliberately NOT a nav view: you want this MID-TYPING, and a view switch loses the composer's focus
// and its half-written draft. insertSnippet puts the prompt at the caret and keeps an undo (C7).
let _phTimer = null;
function openPromptHistory(prefill) {
  const existing = document.getElementById('phOverlay');
  if (existing) { existing.querySelector('.gsearch-input').focus(); return; }
  const ov = el('div', 'cmdk-overlay'); ov.id = 'phOverlay';
  ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
  const box = el('div', 'cmdk gsearch');
  const inp = el('input', 'gsearch-input'); inp.type = 'text';
  inp.placeholder = t('commands.promptHistorieSuchen'); inp.spellcheck = false; inp.autocomplete = 'off';
  if (prefill) inp.value = prefill;
  box.appendChild(inp);
  const scope = el('div', 'gsearch-scope ph-scope'); box.appendChild(scope);
  const listEl = el('div', 'cmdk-list gsearch-list'); box.appendChild(listEl);
  const close = () => { overlayPop(ov); ov.remove(); };   // the stack remembers the opener and the focus
  const run = async () => {
    const q = inp.value.trim();
    listEl.innerHTML = '<div class="cmdk-empty">' + t('common.lade') + '</div>';
    let r;
    try { r = await api('/api/prompt-history?limit=150' + (q ? '&q=' + encodeURIComponent(q) : '')); }
    catch (e) { listEl.innerHTML = ''; listEl.appendChild(el('div', 'cmdk-empty', t('common.fehler-2') + e.message)); return; }
    if (inp.value.trim() !== q) return; // a newer keystroke superseded this response
    // Say what was searched, per source. „Nothing found" and „the terminal history could not be read"
    // are different answers and the second one is not the user's fault.
    scope.innerHTML = '';
    const src = r.sources || {};
    scope.appendChild(el('span', null, t('commands.promptHistorieQuellen')
      .replace('{c}', String(src.cli || 0)).replace('{p}', String(src.panel || 0))
      + (r.truncated ? t('commands.promptHistorieGekuerzt').replace('{n}', String(r.total || 0)) : '')));
    if (r.cliError) scope.appendChild(el('span', 'ph-err', '⚠ ' + r.cliError));
    listEl.innerHTML = '';
    const items = r.items || [];
    if (!items.length) { listEl.appendChild(el('div', 'cmdk-empty', t('commands.keineTreffer'))); return; }
    items.forEach((h) => {
      const it = el('div', 'gsearch-hit ph-hit');
      const meta = el('div', 'gsearch-meta');
      (h.sources || []).forEach((s) => meta.appendChild(el('span', 'ph-src ph-' + s, s === 'cli' ? t('commands.promptQuelleTerminal') : t('commands.promptQuellePanel'))));
      if (h.ts) meta.appendChild(el('span', 'gsearch-time', relTime(h.ts)));
      if (h.project) meta.appendChild(el('span', 'gsearch-proj', h.project.split(/[\\/]/).filter(Boolean).pop() || h.project));
      if (h.pastes) meta.appendChild(el('span', 'ph-paste', '📋 ' + h.pastes));
      it.appendChild(meta);
      const sn = el('div', 'gsearch-snip ph-text');
      sn.appendChild(q ? highlightMatch(h.text, q) : document.createTextNode(h.text));
      it.appendChild(sn);
      // The row itself is the „use it" surface; the small buttons are the extras, so a stray click on a
      // row can never do something destructive.
      const acts = el('div', 'ph-acts');
      acts.appendChild(iconBtn('mini-btn', 'star', { title: t('commands.inDieBibliothek'), onClick: async (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        try { await savePrompt({ title: h.text.split('\n')[0].slice(0, 80), text: h.text }); toast(t('commands.promptGespeichert'), 'ok'); }
        catch (err) { toast(err.message, 'err'); }
      } }));
      acts.appendChild(iconBtn('mini-btn', 'copy', { title: t('common.kopieren'), onClick: (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        copyText(h.text);
      } }));
      if (h.sessionId) {
        acts.appendChild(iconBtn('mini-btn', 'fork', { title: t('commands.sessionOeffnen'), onClick: (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          close();
          if (typeof openResumeInChat === 'function') openResumeInChat(h.sessionId, h.project || '');
        } }));
      }
      it.appendChild(acts);
      mkClickable(it, t('commands.promptUebernehmen'));
      it.onclick = () => { close(); insertSnippet(h.text); };
      listEl.appendChild(it);
    });
  };
  inp.addEventListener('input', () => { clearTimeout(_phTimer); _phTimer = setTimeout(run, 200); });
  ov.onclick = (e) => { if (e.target === ov) close(); };
  ov.appendChild(box); document.body.appendChild(ov);
  overlayPush(ov, { box, autofocus: false, onEsc: close, onEnter: () => overlayFocusFirst(listEl, '.ph-hit') });
  // Opens with the newest prompts already listed — unlike the full-text search this is browsable, not
  // just searchable: „what did I ask yesterday" has no query.
  setTimeout(() => { inp.focus(); run(); }, 0);
}

// --- multi-model compare: one prompt → N models side by side ---
// fallback list; rebuilt at boot from /api/models (pinned entries) via rebuildCompareModels().
let COMPARE_MODELS = [
  { value: 'claude-opus-5', label: 'Opus 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];
function rebuildCompareModels() {
  const list = (typeof MODELS_CACHE !== 'undefined' && MODELS_CACHE && MODELS_CACHE.models) || null;
  if (!list) return;
  const pinned = list.filter((m) => m.kind === 'pinned').map((m) => ({ value: m.value, label: m.label }));
  if (pinned.length) COMPARE_MODELS = pinned;
}
const COMPARE = { cols: [], ov: null };
function compareCleanup() {
  (COMPARE.cols || []).forEach((c) => { try { if (c.es) c.es.close(); } catch {} try { if (c.timer) clearInterval(c.timer); } catch {} if (c.chatId && !c.done) api('/api/chat/' + c.chatId + '/stop', { method: 'POST' }).catch(() => {}); });
  COMPARE.cols = [];
}
function startCompareColumn(model, prompt, effort, container) {
  const label = (COMPARE_MODELS.find((m) => m.value === model) || {}).label || model;
  const colEl = el('div', 'cmp-col');
  const ch = el('div', 'cmp-col-head');
  const dot = el('span', 'urs-dot run'); ch.appendChild(dot);
  ch.appendChild(el('span', 'cmp-col-model', label));
  const meta = el('span', 'cmp-col-meta', t('common.startet')); ch.appendChild(meta);
  const stop = iconBtn('ghost-btn cmp-stop', 'stop', { size: 12, title: t('html.stopp'), onClick: () => stopCol() });
  ch.appendChild(stop);
  colEl.appendChild(ch);
  const body = el('div', 'cmp-col-body msg assistant'); const bubble = el('div', 'bubble'); body.appendChild(bubble); colEl.appendChild(body);
  container.appendChild(colEl);
  const col = { model, chatId: null, es: null, bubble, dot, meta, startedAt: Date.now(), tokens: 0, done: false, _raw: '', _pending: false, timer: null };
  const render = () => { if (typeof DISPLAY !== 'undefined' && DISPLAY.raw) bubble.textContent = col._raw; else { bubble.innerHTML = renderMarkdown(col._raw); decorateCode(bubble); } };
  const tick = () => { if (col.done) return; meta.textContent = ((Date.now() - col.startedAt) / 1000).toFixed(0) + 's' + (col.tokens ? ' · ' + fmtNum(col.tokens) + ' tok' : ''); };
  col.timer = setInterval(tick, 1000);
  const finish = (status) => { if (col.done) return; col.done = true; clearInterval(col.timer); col.dot.className = 'urs-dot ' + (status === 'error' ? 'error' : status === 'stopped' ? 'stopped' : 'done'); meta.textContent = ((Date.now() - col.startedAt) / 1000).toFixed(1) + 's · ' + fmtNum(col.tokens) + ' tok'; if (stop.parentNode) stop.remove(); try { if (col.es) col.es.close(); } catch {} col.es = null; if (col.chatId) api('/api/chat/' + col.chatId + '/stop', { method: 'POST' }).catch(() => {}); };
  const stopCol = () => { if (col.chatId) api('/api/chat/' + col.chatId + '/interrupt', { method: 'POST' }).catch(() => {}); finish('stopped'); };
  col.stopCol = stopCol;
  (async () => {
    try {
      const r = await api('/api/chat/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, effort: effort || undefined, permissionMode: 'plan' }) });
      col.chatId = r.chatId;
      col.es = new EventSource('/api/chat/' + r.chatId + '/stream');
      col.es.onmessage = (e) => {
        let ev; try { ev = JSON.parse(e.data); } catch { return; }
        if (ev.type === 'stream_event' && ev.event) {
          const x = ev.event;
          if (x.type === 'content_block_delta' && x.delta && x.delta.type === 'text_delta') { col._raw += x.delta.text || ''; if (!col._pending) { col._pending = true; setTimeout(() => { col._pending = false; bubble._raw = col._raw; renderStreamEl(bubble); }, 90); } }
          else if (x.type === 'message_delta' && x.usage && x.usage.output_tokens != null) col.tokens = x.usage.output_tokens;
        } else if (ev.type === 'assistant') {
          const c = (ev.message && ev.message.content) || []; const t = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n'); if (t) { col._raw = t; render(); }
        } else if (ev.type === 'control_request' && ev.request && ev.request.subtype === 'can_use_tool') {
          api('/api/chat/' + col.chatId + '/permission', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: ev.request_id || ev.requestId, behavior: 'deny', message: 'Vergleichsmodus: keine Tools' }) }).catch(() => {});
        } else if (ev.type === 'result') finish(ev.is_error ? 'error' : 'done');
        else if (ev.type === '_exit') finish(ev.code ? 'error' : 'done');
        else if (ev.type === '_error') { bubble.textContent = ev.message || t('common.fehler'); finish('error'); }
      };
      col.es.onerror = () => {};
      await api('/api/chat/' + r.chatId + '/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: prompt }) });
    } catch (e) { bubble.textContent = t('common.fehler-2') + e.message; finish('error'); }
  })();
  return col;
}
function openModelCompare(prefill) {
  // overlayPop first: a second ⚡ while one is open replaced the overlay, and a bare remove() would have
  // left the old one on the stack (overlayPrune would catch it, but saying it is cheaper than relying on it)
  if (COMPARE.ov) { overlayPop(COMPARE.ov); COMPARE.ov.remove(); compareCleanup(); }
  const ov = el('div', 'modal-overlay cmp-overlay'); COMPARE.ov = ov;
  const box = el('div', 'cmp-box');
  const head = el('div', 'cmp-head'); head.innerHTML = ic('bolt', 18); head.appendChild(el('h3', null, t('commands.modelleVergleichen')));
  const closeAll = () => { overlayPop(ov); ov.remove(); compareCleanup(); COMPARE.ov = null; };
  const closeX = iconBtn('urs-close', 'close', { title: t('common.schliessen'), onClick: closeAll }); head.appendChild(closeX);
  box.appendChild(head);
  const form = el('div', 'cmp-form');
  const ta = el('textarea', 'ui-input cmp-prompt'); ta.rows = 3; ta.placeholder = t('commands.promptAnAlleGewaehlten'); ta.value = prefill || '';
  form.appendChild(ta);
  const opts = el('div', 'cmp-opts');
  const modelBoxes = COMPARE_MODELS.map((m, i) => { const w = el('label', 'ui-check'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = i < 3; cb.value = m.value; w.appendChild(cb); w.appendChild(el('span', null, m.label)); opts.appendChild(w); return cb; });
  // SELECT-NAME: a bare dropdown in a toolbar — nothing around it says what it sets, for a screen reader
  // or for a mouse. title + aria-label, both from the key the Settings field already uses.
  const eff = el('select', 'ui-input cmp-eff'); eff.title = t('html.aufwandsstufe'); eff.setAttribute('aria-label', t('html.aufwandsstufe'));
  [['', t('commands.effortStandard')], ['low', 'low'], ['medium', 'medium'], ['high', 'high']].forEach(([v, l]) => { const o = el('option'); o.value = v; o.textContent = l; eff.appendChild(o); }); opts.appendChild(eff);
  const runBtn = iconBtn('primary-btn', 'play', { label: t('commands.vergleichen'), onClick: () => run() }); opts.appendChild(runBtn);
  form.appendChild(opts); box.appendChild(form);
  const cols = el('div', 'cmp-cols'); box.appendChild(cols);
  // Esc still DECLINES to close while a column streams (closing would abandon N paid turns) — but it is
  // now swallowed either way. Before, the declined keystroke travelled on to the global chain and armed
  // „Esc twice stops the turn" on the chat tab behind this overlay (VIEWS-ESC).
  const onEsc = () => { if (!(COMPARE.cols || []).some((c) => !c.done)) closeAll(); };
  const run = async () => {
    const prompt = ta.value.trim(); if (!prompt) { toast(t('commands.promptFehlt'), 'err'); return; }
    const models = modelBoxes.filter((cb) => cb.checked).map((cb) => cb.value);
    if (!models.length) { toast(t('commands.mindestensEinModellWaehlen'), 'err'); return; }
    if (models.length > 4) { toast(t('commands.max4Modelle'), 'err'); return; }
    compareCleanup(); cols.innerHTML = '';
    cols.style.gridTemplateColumns = 'repeat(' + models.length + ', minmax(0, 1fr))';
    COMPARE.cols = models.map((mdl) => startCompareColumn(mdl, prompt, eff.value, cols));
  };
  ov.appendChild(box); document.body.appendChild(ov);
  // no onEnter: the prompt field is a <textarea>, where Enter is a newline and the stack leaves it alone
  overlayPush(ov, { box, autofocus: false, onEsc });
  setTimeout(() => ta.focus(), 0);
}

// --- command palette (Strg/⌘+K) ---
const CMDK = { open: false, items: [], filtered: [], sel: 0, opener: null };
// H5 — every entry declares WHERE ITS LABEL COMES FROM, and the two sources are not interchangeable:
//   · src: 'i18n' — panel wording. Must go through t(), or the German UI shows an English palette.
//   · src: 'data' — a session title, a saved prompt, a UI-skill title, a slash command, i.e. the user's
//     own words or the CLI's. Passed through UNTOUCHED. Translating these would rename things in this
//     one list while they keep their real name everywhere else; a session called „Settings" is not the
//     settings view, and „/clear" is not a word in any dictionary.
// The marker is not decoration: test/palette.test.js runs this builder against stub data whose titles are
// deliberately German/English words and fails if a data label came out changed, or if any 'i18n' label is
// a hardcoded literal rather than a dictionary hit.
function cmdkCommands() {
  const c = [];
  c.push({ group: t('commands.aktion'), src: 'i18n', label: t('chat.neuerChat'), run: () => { showView('chat'); $('#newChatBtn').onclick(); } });
  c.push({ group: t('commands.aktion'), src: 'i18n', label: t('commands.sessionsDurchsuchenInhaltStrg'), run: () => openGlobalSearch() });
  c.push({ group: t('commands.aktion'), src: 'i18n', label: t('commands.modelleVergleichenEinPrompt'), run: () => openModelCompare($('#composerInput') ? $('#composerInput').value.trim() : '') });
  // Ultracode decides whether one turn becomes a whole workflow of agents — the switch in this panel that
  // changes most about what a prompt costs. It was reachable only from a right-click tab menu, which is not
  // where someone looking for a session setting looks; the 🌀 chip in the status strip is the other way in.
  c.push({ group: t('commands.aktion'), src: 'i18n', label: t('commands.ultracodeSchalten'), run: () => { showView('chat'); if (ACTIVE && typeof editTabUltracode === 'function') editTabUltracode(ACTIVE); } });
  // This was nine hardcoded ENGLISH labels („Gehe zu Settings" under a nav button reading
  // „Einstellungen"). PALETTE_VIEWS pairs each view with the key its OWN nav button uses — one wording for
  // both, and nothing left over to go stale. The first draft of this list also carried „Läufe"
  // (view-agents), which main had removed in the meantime; test/palette.test.js caught it on this very
  // merge („PALETTE_VIEWS names a view the shell has not got"), which is the whole reason the list is
  // asserted against index.html instead of being trusted.
  PALETTE_VIEWS.forEach(([v, key]) => c.push({ group: t('html.ansicht'), src: 'i18n', label: t('commands.geheZu') + t(key), run: () => showView(v) }));
  (typeof UISKILLS_DATA !== 'undefined' && UISKILLS_DATA ? UISKILLS_DATA.slice() : [])
    .sort((a, b) => (isFav(b.name) ? 1 : 0) - (isFav(a.name) ? 1 : 0))
    .forEach((s) => c.push({ group: t('commands.uiSkill'), src: 'data', hint: s.manifest.writes ? t('commands.schreibt') : '', label: (isFav(s.name) ? '★ ' : '') + t('commands.uiSkill-2') + (s.manifest.title || s.name), run: () => { showView('uiskills'); openUiSkill(s); } }));
  // P-1 — „Neuer Chat: <Projekt>": the project's start values as a visible copy in a fresh tab (projects.js). The
  // name is the user's own word → src 'data'; an archived project stays out of the way here as on its page.
  (typeof PROJECTS_DATA !== 'undefined' && PROJECTS_DATA ? PROJECTS_DATA.filter((p) => !p.archived) : [])
    .forEach((p) => {
      c.push({ group: t('projects.paletteGruppe'), src: 'data', label: t('projects.paletteNeuerChat') + p.name, run: () => newChatInProject(p) });
      // P2 — „Startauftrag: <Projekt> · <Label>": opens the chat AND sends the order (projects.js projRunStarter)
      (Array.isArray(p.starters) ? p.starters : []).forEach((s, i) => c.push({ group: t('projects.paletteGruppe'), src: 'data',
        label: t('projects.paletteStartauftrag').replace('{name}', p.name).replace('{label}', s.label), run: () => projRunStarter(p, i, null, s.label) }));
    });
  sortedPrompts().forEach((pr) => c.push({ group: t('commands.prompt-2'), src: 'data', hint: (pr.pinned ? '★ ' : '') + (pr.tags || []).join(' '), label: pr.title, run: () => insertSnippet(pr.text) }));
  c.push({ group: t('commands.prompt-2'), src: 'i18n', label: t('commands.aktuelleEingabeAlsPrompt'), run: () => savePromptFromComposer() });
  c.push({ group: t('commands.prompt-2'), src: 'i18n', label: t('commands.promptsVerwalten'), run: () => openPromptManager() });
  c.push({ group: t('commands.prompt-2'), src: 'i18n', label: t('commands.promptHistorieOeffnen'), run: () => openPromptHistory() });
  SNIPPETS().forEach((sn) => c.push({ group: t('commands.vorlage'), src: 'i18n', hint: sn.cat, label: sn.label, run: () => insertSnippet(sn.text) })); // function: bodies are translated at call time (A19)
  // incl. the panel's own LOCAL_COMMANDS (/diff), which system/init would otherwise drop (C6). A slash command
  // only works as the WHOLE message, so this replaces the composer — but undoably (C7).
  allChatCommands().forEach((cmd) => c.push({ group: t('commands.slash'), src: 'data', label: cmd, run: () => { showView('chat'); composerSet(cmd + ' ', t('commands.befehlEingesetzt')); } }));
  (SESSIONS || []).slice(0, 8).forEach((s) => c.push({ group: t('commands.session'), src: 'data', hint: s.projectPath, label: t('commands.fortsetzen') + (s.title || s.id.slice(0, 8)), run: () => resumeSession(s, false) }));
  return c;
}
// a11y: the input is the combobox, #cmdkList the listbox — without these the arrow keys move a selection
// that no screen reader can observe.
function cmdkA11yInit() {
  const inp = $('#cmdkInput'), list = $('#cmdkList');
  if (!inp || !list) return;
  list.setAttribute('role', 'listbox');
  inp.setAttribute('role', 'combobox'); inp.setAttribute('aria-controls', 'cmdkList');
  inp.setAttribute('aria-expanded', 'true'); inp.setAttribute('aria-autocomplete', 'list');
}
function openCmdk(prefill) {
  CMDK.open = true; CMDK.opener = document.activeElement; CMDK.items = cmdkCommands(); CMDK.sel = 0;
  const ov = $('#cmdkOverlay');
  ov.classList.remove('hidden');
  // The palette's Esc sat at the very BOTTOM of the global handler below, AFTER the „stop the turn"
  // branch had already returned — so with a turn running, Esc armed the abort and left the palette open
  // (VIEWS-ESC). On the stack it is simply the topmost overlay. No trap: the palette is one input plus a
  // list of role=option divs, and Tab out of it is the documented way to leave without choosing.
  // CMDK.opener/closeCmdk keep the focus restore, so restoreFocus is off here.
  overlayPush(ov, {
    trap: false, restoreFocus: false,
    alive: () => !ov.classList.contains('hidden'),
    onEsc: closeCmdk,
  });
  cmdkA11yInit();
  const inp = $('#cmdkInput'); inp.value = prefill || ''; setTimeout(() => inp.focus(), 0);
  renderCmdk();
  // A19: "Session · Fortsetzen" was empty until the Sitzungen view had been visited once — the palette is
  // exactly where you'd look for a session, so pull the list on demand and re-render when it lands.
  if (typeof ensureSessions === 'function' && !SESSIONS.length) {
    ensureSessions().then(() => { if (CMDK.open) { CMDK.items = cmdkCommands(); renderCmdk(); } });
  }
  // …and the projects for „Neuer Chat: <Projekt>" — same rule, the view need not have been visited (P-1)
  if (typeof ensureProjects === 'function' && typeof PROJECTS_DATA !== 'undefined' && !PROJECTS_DATA) {
    ensureProjects().then((list) => { if (list && list.length && CMDK.open) { CMDK.items = cmdkCommands(); renderCmdk(); } });
  }
}
function closeCmdk() {
  CMDK.open = false; $('#cmdkOverlay').classList.add('hidden');
  overlayPop($('#cmdkOverlay'));
  const inp = $('#cmdkInput'); if (inp) inp.removeAttribute('aria-activedescendant');
  // a11y: restore focus to whatever opened the palette (Strg+K from the composer, or the ⌘ button)
  const o = CMDK.opener; CMDK.opener = null;
  if (o && document.contains(o) && o.offsetParent !== null && o.focus) { try { o.focus(); } catch { /* */ } }
}
// A19: a rerender must not let a STATIONARY pointer steal the selection — after ArrowDown the list
// repaints under the cursor, mouseenter fires, and Enter suddenly ran a different command. So track real
// pointer movement and reset the flag on every render.
const CMDK_PTR = { x: -1, y: -1, moved: false };
document.addEventListener('mousemove', (e) => { if (e.clientX !== CMDK_PTR.x || e.clientY !== CMDK_PTR.y) { CMDK_PTR.x = e.clientX; CMDK_PTR.y = e.clientY; CMDK_PTR.moved = true; } }, { passive: true });
const CMDK_CUT = 60;
function renderCmdk() {
  // NOT .toLowerCase() here any more — paletteRank folds the query itself (umlauts, ß, accents), and
  // lowercasing twice was how „laufe" ended up never matching „Läufe". One place does the folding.
  const q = $('#cmdkInput').value.trim();
  if (q) {
    const scored = CMDK.items.map((c, i) => ({ c, i, s: paletteRank(c, q) })).filter((x) => x.s > 0);
    scored.sort((a, b) => (b.s - a.s) || (a.i - b.i)); // stable: equal scores keep the authored order
    CMDK.filtered = scored.map((x) => x.c);
  } else CMDK.filtered = CMDK.items.slice();
  if (CMDK.sel >= CMDK.filtered.length) CMDK.sel = 0;
  const list = $('#cmdkList'); list.innerHTML = '';
  CMDK_PTR.moved = false;
  const inp = $('#cmdkInput');
  if (!CMDK.filtered.length) { list.innerHTML = '<div class="cmdk-empty">' + t('commands.nichtsGefunden') + '</div>'; if (inp) inp.removeAttribute('aria-activedescendant'); return; }
  CMDK.filtered.slice(0, CMDK_CUT).forEach((c, i) => {
    const it = el('div', 'cmdk-item' + (i === CMDK.sel ? ' sel' : ''));
    it.id = 'cmdk-opt-' + i; it.setAttribute('role', 'option'); it.setAttribute('aria-selected', i === CMDK.sel ? 'true' : 'false');
    const main = el('div', 'cmdk-main');
    main.appendChild(el('span', 'cmdk-group', c.group || ''));
    main.appendChild(el('span', 'cmdk-label', c.label));
    it.appendChild(main);
    if (c.hint) it.appendChild(el('div', 'cmdk-hint', c.hint));
    it.onmouseenter = () => {
      if (!CMDK_PTR.moved) return; // the pointer hasn't actually moved — the list moved under it
      CMDK.sel = i;
      [...list.children].forEach((n, j) => { n.classList.toggle('sel', j === i); if (n.getAttribute('role') === 'option') n.setAttribute('aria-selected', j === i ? 'true' : 'false'); });
      if (inp) inp.setAttribute('aria-activedescendant', it.id);
    };
    it.onclick = () => runCmdk(i);
    list.appendChild(it);
  });
  // A19: the 60-item cut was silent — a missing entry read as "the palette doesn't know it"
  if (CMDK.filtered.length > CMDK_CUT) list.appendChild(el('div', 'cmdk-empty cmdk-more', t('common.nWeitere').replace('{n}', CMDK.filtered.length - CMDK_CUT) + ' · ' + t('commands.nWeitereTippen')));
  if (inp) { const selEl = list.children[CMDK.sel]; if (selEl && selEl.id) inp.setAttribute('aria-activedescendant', selEl.id); }
}
function ensureCmdkVisible() { const s = $('#cmdkList .cmdk-item.sel'); if (s) s.scrollIntoView({ block: 'nearest' }); }
function runCmdk(i) { const c = CMDK.filtered[i]; if (!c) return; closeCmdk(); try { c.run(); } catch (e) { toast(e.message, 'err'); } }

let _escArmed = false, _escTimer = null; // Esc-to-interrupt needs a second press within 2 s (C14)
document.addEventListener('keydown', (e) => {
  // tab shortcuts (Alt+…) — Alt avoids the browser's Ctrl+Tab/Ctrl+n/Ctrl+w
  if (e.altKey && !e.ctrlKey && !e.metaKey && $('#view-chat').classList.contains('active')) {
    if ((e.key === 't' || e.key === 'T') && e.shiftKey) { e.preventDefault(); reopenClosedTab(); return; }
    if (e.key === 't' || e.key === 'T') { e.preventDefault(); newTab(); return; }
    if (e.key === 'w' || e.key === 'W') { e.preventDefault(); if (TABS.length > 1) closeTab(ACTIVE); return; }
    if (e.key === 'i' || e.key === 'I') { e.preventDefault(); const c = $('#composerInput'); if (c) { c.focus(); try { c.setSelectionRange(c.value.length, c.value.length); } catch { /* */ } } return; } // M18
    // Alt+↑/↓ — jump between YOUR messages, the natural sections of a long transcript (M5)
    if (e.key === 'ArrowUp' && typeof jumpUserMessage === 'function') { e.preventDefault(); jumpUserMessage(-1); return; }
    if (e.key === 'ArrowDown' && typeof jumpUserMessage === 'function') { e.preventDefault(); jumpUserMessage(1); return; }
    if (TABS.length > 1) {
      if (e.key >= '1' && e.key <= '9') { const i = +e.key - 1; if (TABS[i]) { e.preventDefault(); activateTab(TABS[i]); return; } }
      if (e.key === 'ArrowRight') { const i = TABS.indexOf(ACTIVE); if (TABS[i + 1]) { e.preventDefault(); activateTab(TABS[i + 1]); return; } }
      if (e.key === 'ArrowLeft') { const i = TABS.indexOf(ACTIVE); if (i > 0) { e.preventDefault(); activateTab(TABS[i - 1]); return; } }
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openGlobalSearch(); return; }
  // A13 — next to Strg+Shift+F on purpose: both are „find something I wrote", one in the answers, one in
  // my own prompts. The composer's own ↑ stays what it is (the last few, no dialog).
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); openPromptHistory(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); CMDK.open ? closeCmdk() : openCmdk(''); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && $('#view-chat').classList.contains('active')) { e.preventDefault(); openChatSearch(); return; }
  if (e.key === 'Escape') {
    // DIALOGS ARE NOT IN THIS CHAIN ANY MORE. overlays.js owns Esc for all thirteen of them in the capture
    // phase and stops the event there, so this handler never even runs while one is open. The three that
    // used to be listed here by hand (#permOverlay, #cfgOverlay, #mcpOverlay) are the clearest reason why:
    // resolvePerm() hides #permOverlay SYNCHRONOUSLY, so chat-perms' own capture handler had already made
    // the „is it open?" test below false by the time it ran — Esc denied the permission AND armed the abort
    // for the very turn that had asked for it (VIEWS-ESC). The guard is kept as a guard, not as a branch:
    // if a future overlay forgets to register, it must at worst do nothing rather than stop the turn.
    if (typeof overlayCount === 'function' && overlayCount()) return;
    // F-Drawer first: the off-canvas nav covers everything below it, so Esc must dismiss it before it
    // reaches any of the panels underneath.
    if (document.documentElement.classList.contains('nav-open')) { e.preventDefault(); if (typeof closeNav === 'function') closeNav(); return; }
    // popovers, chat search and the sidecar — the Tastenkürzel table promises "Esc schließt die Suche",
    // but the search's own handler only fired while focus was still in its input
    const optsPop = $('#chatOptsPop'), stepsPop = $('#stepsPop');
    if (optsPop && !optsPop.classList.contains('hidden')) { e.preventDefault(); optsPop.classList.add('hidden'); if ($('#chatOptsBtn')) $('#chatOptsBtn').setAttribute('aria-expanded', 'false'); return; }
    if (stepsPop && !stepsPop.classList.contains('hidden')) { e.preventDefault(); stepsPop.classList.add('hidden'); if ($('#stepsBtn')) $('#stepsBtn').setAttribute('aria-expanded', 'false'); return; }
    const search = $('#chatSearch');
    if (search && !search.classList.contains('hidden')) { e.preventDefault(); closeChatSearch(); return; }
    const sidecar = $('#sidecar');
    if (sidecar && !sidecar.classList.contains('hidden') && typeof closeSidecar === 'function') { e.preventDefault(); closeSidecar(); return; }
    // Last in the chain (so it can never swallow a dialog's Esc): stop the running turn. Two presses, like the
    // console — a stray Esc must not kill a long task (C14). tabCanStop, not `streaming`: a held gate blocks
    // the CLI with nothing streaming (FLOW-3), and Esc-Esc is one of the three ways out of it.
    if (tabCanStop(ACTIVE) && $('#view-chat').classList.contains('active')) {
      e.preventDefault();
      clearTimeout(_escTimer);
      if (_escArmed) { _escArmed = false; stopTab(ACTIVE); } // a second Esc-Esc in the same stop = the hard stop (stopTab)
      else { _escArmed = true; _escTimer = setTimeout(() => { _escArmed = false; }, 2000); toast(t('commands.escNochmalZumStoppen'), 'ok'); }
      return;
    }
  }
  if (!CMDK.open) return;
  // Escape is NOT handled here any more — it was the bug: this line sits below the „stop the turn" branch
  // above, which returns, so Esc with a turn running armed the abort instead of closing the palette.
  // The palette registers with the overlay stack in openCmdk() and is closed from there.
  if (e.key === 'ArrowDown') { e.preventDefault(); CMDK.sel = Math.min(CMDK.filtered.length - 1, CMDK.sel + 1); renderCmdk(); ensureCmdkVisible(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); CMDK.sel = Math.max(0, CMDK.sel - 1); renderCmdk(); ensureCmdkVisible(); }
  else if (e.key === 'Enter') { e.preventDefault(); runCmdk(CMDK.sel); }
});
$('#cmdkInput').addEventListener('input', () => { CMDK.sel = 0; renderCmdk(); });
$('#cmdkOverlay').addEventListener('click', (e) => { if (e.target === $('#cmdkOverlay')) closeCmdk(); });
$('#snipBtn').onclick = () => openCmdk('');

// send a slash command as a normal chat message (reuses the composer send path)
// The context remedies are ordinary sends now — including while a turn runs. sendMessage queues them
// like any other message, so a pressed „Handoff schreiben" shows up as a cancellable chip in the queue
// strip and in the tab's ⏳ badge and goes out when the turn ends. Refusing with „läuft noch, bitte
// warten" meant the exact moment you want a handoff — a long turn eating the last of the context — was
// the moment the button stopped working, and the press left no trace at all.
// Explicit-args form: the composer is not touched, so a half-written draft survives (it used to be
// overwritten by the command even when the send went through immediately).
function sendChatCommand(cmd) {
  const tab = (typeof ACTIVE !== 'undefined' && ACTIVE) || null;
  if (!tab || typeof sendMessage !== 'function') return;
  sendMessage({ text: cmd, tab });
}
// --- context-window gauge ---
// Takes the TAB, not a usage object: what belongs in this gauge is per-tab state that two different
// events feed (the context from the `assistant` frames, the window from the `result`), and the old
// signature invited the call sites to hand it the one usage object that is NOT the context —
// result.usage, the sum over the whole turn. The arithmetic and the measurements live in ctx.js.
// What the CLI has already told us about a model's window, across sessions and reloads. The window is
// a property of the model, so a value measured yesterday is still true today — and it is the honest
// answer for a tab that has no finished turn yet (a fresh chat, and every restored tab after a browser
// reload). Without it those tabs fell back to the name guess, which cannot see a 1M session because
// the running model id carries no "[1m]" — so a 1M chat was measured against 200 000.
const CTX_WINDOWS_KEY = 'cc_ctx_windows';
let CTX_WINDOWS = null;
// Both stores are CLEANED whenever they are loaded (ctx.js ctxWindowStoreClean / ctxFloorStoreClean): they are
// written by every version of this panel that ever ran here, and Julian's 05.10. dump held leftovers of two of
// them — raw gateway keys from the variant-blind writer before PR-3b, and a floor without provenance that refused
// the CLI's own window. What the cleanup changed is persisted at once (so the next load does not do it again) and
// said in the 🔔 log, with the keys: a line that changes its window after an update without any trace of why is
// the kind of silence this file keeps paying for. (After the first load of a page this only speaks again when a
// panel window that still runs OLD code has written leftovers in between — which is then worth saying.)
function ctxStoreLoad(key, clean, field, logKey) {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { raw = {}; }
  const r = clean(raw);
  if (r.changed) {
    try { localStorage.setItem(key, JSON.stringify(r[field])); } catch { /* private mode / quota */ }
    const what = (r.dropped || []).map((d) => (typeof d === 'object' ? d.key + (d.below ? ' ≥ ' + fmtNum(d.below) : '') : d));
    if (typeof logEvent === 'function') {
      logEvent(t(logKey).replace('{n}', String(what.length)) + (what.length ? ' ' + what.join(', ') : ''), 'info');
    }
  }
  return r[field];
}
// SEVERAL PANEL WINDOWS share these two stores (one localStorage per origin), while each page caches its own copy.
// Writing the whole cached object back — what every writer did — let the last writer win: window 1 removes a
// refuted floor and writes {}, window 2 still holds it and writes it back with its next, unrelated bound; and in
// the other direction a bound window 1 just proved was erased by window 2's next write. Since this round a store
// can also SHRINK (ctxFloorHeal, the load cleanup), so that resurrection is the dangerous half. Two rules close it:
//   · a WRITE starts from what is in localStorage NOW (ctxStoreFresh: drop the cache, load + clean again), applies
//     its one change and replaces the cache — so it carries no other window's stale state along;
//   · and a READ does not keep a copy another window has replaced: the `storage` event (fired in every OTHER
//     document of the origin on a write) drops the cache, and the next read loads the current store.
// Tabs inside one window share the cached object and were never affected.
function ctxStoreFresh(which) {
  if (which === 'floors') { CTX_FLOORS = null; return ctxFloorStore(); }
  CTX_WINDOWS = null; return ctxWindowStore();
}
// `key` null is localStorage.clear() — both stores went with it
function ctxStoreForget(e) {
  const k = e ? e.key : null;
  if (k == null || k === CTX_FLOORS_KEY) CTX_FLOORS = null;
  if (k == null || k === CTX_WINDOWS_KEY) CTX_WINDOWS = null;
}
if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') window.addEventListener('storage', ctxStoreForget);
function ctxWindowStore() {
  if (CTX_WINDOWS) return CTX_WINDOWS;
  CTX_WINDOWS = ctxStoreLoad(CTX_WINDOWS_KEY, ctxWindowStoreClean, 'known', 'commands.kontextFensterSpeicherBereinigt');
  return CTX_WINDOWS;
}
// …and what this panel has DISPROVED about a window, per variant: one accepted API call carried N tokens, so
// that variant's window is at least N and every smaller number offered for it is wrong (ctx.js „THE FLOOR").
// A SECOND store rather than a reserved key inside the first one, for three reasons: the two have different
// merge rules (a window is replaced, a floor only ever grows), the first one's keys are model ids that an
// opaque inference-profile id can make look like anything, and a reader of localStorage can see at a glance
// which of the two it is looking at. Shared across tabs and sessions exactly like the windows, because the
// holders a refutation has to outlive are a module CONSTANT, the CLI's next `result` and a second tab —
// none of which a per-tab bound would reach (see ctx.js, „WHY A FLOOR AND NOT A DELETION").
const CTX_FLOORS_KEY = 'cc_ctx_floors';
let CTX_FLOORS = null;
function ctxFloorStore() {
  if (CTX_FLOORS) return CTX_FLOORS;
  CTX_FLOORS = ctxStoreLoad(CTX_FLOORS_KEY, ctxFloorStoreClean, 'floors', 'commands.kontextBoedenBereinigt');
  return CTX_FLOORS;
}
// Raise the floor from what the ONE decision established. Monotonic (ctxFloorMerge takes the max), so the
// compaction that follows a refutation cannot talk the bound back down, and persisted, so a reload cannot
// either. Only on a real change — this runs at every turn boundary of every tab. Stamped with the panel's clock
// (`at`), the same clock a measurement's `at` reads, because a later measurement may refute it (ctxFloorHeal).
// From the CURRENT store, not this page's copy (ctxStoreFresh — several panel windows).
function ctxFloorLearn(refuted) {
  if (!refuted) return;                       // the common case, every turn boundary: nothing to read or write
  const floors = ctxStoreFresh('floors');
  if (!ctxFloorMerge(floors, refuted, Date.now())) return;
  try { localStorage.setItem(CTX_FLOORS_KEY, JSON.stringify(floors)); } catch { /* private mode / quota */ }
}
// …and take one back: the CLI measured a window below it for this session, and the measurement is younger than
// the bound (ctx.js ctxDecide `healed`). The display never needed this — a measured window is not gated by any
// floor — but the store does: every OTHER source of that variant (the name table, the learned store, a second
// tab before its first measurement) would still be refused by a bound the CLI has just contradicted. Said once in
// the 🔔 log, with both numbers, because a bound that silently disappears is as unverifiable as one that
// silently refuses.
function ctxFloorHeal(healed, win) {
  if (!healed) return;
  const floors = ctxStoreFresh('floors');     // from the current store (several panel windows, see ctxStoreFresh)
  if (!ctxFloorDrop(floors, healed)) return;
  try { localStorage.setItem(CTX_FLOORS_KEY, JSON.stringify(floors)); } catch { /* private mode / quota */ }
  if (typeof logEvent === 'function') {
    logEvent(t('commands.kontextBodenWiderlegt').replace('{k}', healed.key).replace('{n}', fmtNum(healed.below))
      .replace('{w}', fmtNum(win || 0)), 'info');
  }
}
// Write what ctxDecide decided may be remembered — `rec.learn`, i.e. one { key, win } per variant the CLI
// really reported a window for. The decision which KEY a number may be filed under is not made here: it is
// the same variant rule the reading side uses (ctx.js ctxLearnEntries), because round 2 filed a window
// under the wide key merely because the SELECTOR was wide. This function only merges and persists, and only
// on a real change — a turn reports the same window every time and this runs on every result frame.
// `refuted` is the other direction, and the store still wants it: a window the frames just DISPROVED (ctx.js
// (8)) is deleted here rather than merely not re-written, so cc_ctx_windows does not keep a number every read
// would refuse anyway. This is HYGIENE and no longer the guarantee — the guarantee is the floor below, because
// a constant cannot be deleted and the CLI re-reports the same `contextWindow` in the very next result.
function ctxLearn(entries, refuted) {
  if (!(Array.isArray(entries) && entries.length) && !refuted) return;
  const store = ctxStoreFresh('windows');     // from the current store (several panel windows, see ctxStoreFresh)
  if (!ctxStoreMerge(store, entries, refuted)) return;
  try { localStorage.setItem(CTX_WINDOWS_KEY, JSON.stringify(store)); } catch { /* private mode / quota */ }
}
// What the ONE decision says may be remembered, applied to BOTH stores — the shared one (cc_ctx_windows) and
// the tab's own persisted window. One function for the two callers (the probe below and the `result` handler in
// chat-events.js), because „corrected" must not come to mean two different things in two places: that is
// precisely how a rule ended up existing in only one of two writers, and the weaker writer then won.
function ctxRemember(tab, rec) {
  if (!tab || !rec) return;
  // FIRST the floor: that is the half that holds for the holders no deletion can reach — the name constant in
  // ctx.js, the `contextWindow` the CLI re-reports every turn, and another tab that adopted the same number.
  // Everything below is the cleanup that follows from it. (Not this tab's own measurement any more: since 05.10.
  // a measurement outranks every floor, and a floor above it is the one that goes — `healed`, right here.)
  ctxFloorHeal(rec.healed, rec.win && rec.win.value);
  ctxFloorLearn(rec.refuted);
  ctxLearn(rec.learn, rec.refuted);
  let moved = false;
  if (rec.adopt) { tab.ctxReported = rec.adopt; moved = true; }
  else if (ctxReportedRefuted(tab.ctxReported, rec.refuted)) { tab.ctxReported = null; moved = true; }
  // …and the third holder of the very same number: a saved window the model menu has not adopted yet. Cleaning
  // only the two live stores would be undone a second later by loadModels → ctxAdoptSavedWindow handing the
  // refuted value back into `ctxReported` (ctx.js ctxSavedRefuted) — which the floor now refuses on read too,
  // so this is hygiene as well: the number cannot be shown, and it is not kept around either.
  if (ctxSavedRefuted(tab._ctxWindowSaved, rec.refuted)) { tab._ctxWindowSaved = null; moved = true; }
  if (moved && typeof persistTabsSoon === 'function') persistTabsSoon();   // nothing moved → no write
}
// Everything ctxDecide needs that only the browser can know. ONE place, so the painter, the `result`
// handler and the probe all judge a tab by the same selector value and the same menu entry.
// An unstarted tab has no model of its own yet, so for the VISIBLE one the dropdown is what it WOULD run
// (the same rule tabCwd follows for the working directory) — that lets a fresh tab already name the window
// it is going to be measured against instead of „–". For any other tab the dropdown belongs to somebody
// else. `resolves` is the load-bearing part: „Default" has the empty string as its value, so its entry's
// resolved id is the ONLY thing that can say the session really runs a 1M model.
function ctxEnv(tab, extra) {
  const tb = tab || {};
  const sel = (!tb.id && tb === ACTIVE && $('#modelSel')) ? (tb.modelSel || $('#modelSel').value || '') : (tb.modelSel || '');
  const env = {
    known: ctxWindowStore(),
    // …and the bounds this panel has already PROVEN for a variant. Handed in beside the learned windows because
    // every source has to pass them — including the name table in ctx.js and a window the CLI reports anew.
    floors: ctxFloorStore(),
    sel,
    resolves: (typeof modelResolves === 'function') ? modelResolves(sel) : '',
    label: (typeof modelMenuLabel === 'function') ? modelMenuLabel(tb.model, sel) : '',
  };
  return extra ? Object.assign(env, extra) : env;
}
// ctxForgetModel / ctxForgetContext live in ctx.js now: both are pure tab arithmetic (which of the four
// ctx fields a state change voids, and the generation an in-flight query is checked against), and they
// belong next to the precedence that reads those fields — where a test can reach them without a DOM.
//
// CTX-4 — ask the CLI itself. Measured 2026-10-02: `get_context_usage` answers while the session is IDLE,
// before the first turn and before `init`, so this can fire at a start without waiting for anything —
// and after `set_model` the very next answer already carries the NEW window. Called at the turn
// BOUNDARIES only (start · result · model change · /clear · /compact): `detail` is ignored by the CLI, so
// a mid-turn query would pull the full 38 KB answer for a number the frame arithmetic already moves.
// A measured value wins over anything derived; the derived one stays marked with „≈" (ctx.js ctxDecide).
async function ctxProbe(tab, trigger) {
  const tb = tab;
  if (!tb || !tb.id || tb._exited) return;
  // „this CLI has no such control" is a property of the PROCESS, so a (re)start is the one event that may
  // forget it — that is a new child, possibly a newer binary (`claude update` replaces it on disk).
  if (String(trigger) === 'start') tb._ctxNoSupport = false;
  // …and whether this turn boundary is worth a 38 KB answer: while the window is in doubt it is (ctx.js
  // ctxWindowInDoubt — no window at all, or one the frames/the variant contradict), and then a plain
  // `result` re-arms the two-attempt budget too. Without that the probe was dead after two silences and a
  // provably wrong window stood for the rest of the session with nothing left to correct it.
  const d = ctxAskDecision({
    inflight: !!tb._ctxQuery, misses: tb._ctxMisses, unsupported: !!tb._ctxNoSupport,
    doubt: ctxWindowInDoubt(ctxDecide(tb, ctxEnv(tb))),
  }, trigger);
  tb._ctxMisses = d.misses;
  // CTX-2 — a state change that arrives while a query is in flight must not be dropped: the answer on its
  // way was asked for the model/context that just ended, so dropping the trigger left the line on numbers
  // nothing will correct until the next turn. Remembered here and re-asked when the flight settles.
  if (!d.ask) { if (d.queue) tb._ctxRearm = trigger; return; }
  tb._ctxQuery = true;
  // The state this query is ABOUT, captured at ASK time: its generation (a switch/clear/compaction during
  // the flight moves it — the answer that then lands measured a context that is gone, and it used to be
  // stored as this tab's measurement AND written into the learned store under the NEW model's key) and its
  // stamp (a frame that arrives while we wait is the younger number — reading the counter afterwards would
  // hand the stale answer the right of way). ctx.js compares both with `===`, so neither can be fooled by a
  // counter that gets reset.
  const asked = ctxAskedAt(tb);
  let stale = false;
  try {
    const r = await api('/api/chat/' + tb.id + '/context');
    // A stale answer is DROPPED and is not counted as a miss — the CLI answered, and correctly, about a
    // state that no longer exists; charging it would spend one of the two attempts the new state is
    // entitled to. The re-ask below covers it.
    stale = !ctxAnswerUsable(tb, asked.gen);
    if (!stale) {
      const m = ctxFromRoute(r);
      // `unconfirmed` — the CLI did not answer, which is NOT „0 tokens". Two very different reasons hide
      // behind that one flag (lib/chat.js maps both to it): a TIMEOUT, which the next turn may well get (12,2 s
      // cold was measured), and a REFUSAL — „Unsupported control request subtype" from a CLI that does not
      // have this control at all. Counting the refusal as a miss spent the budget and then left whatever
      // number was on screen standing forever; re-arming it would spend a 25 s ceiling at every turn boundary
      // for an answer that cannot come. So it is remembered as what it is, and the line says „CLI kann nicht
      // messen" instead of promising a measurement (ctx.js pendingWhy 'unsupported').
      if (!m) {
        if (ctxProbeUnsupported(r)) tb._ctxNoSupport = true;
        else tb._ctxMisses = (tb._ctxMisses || 0) + 1;
      } else {
        m.gen = asked.gen; m.stamp = asked.stamp;
        // …and WHEN we received it. Our own clock, not a CLI number, and only the breakdown panel reads it:
        // the measured value WANDERS (the MCP block grew by 10 492 tokens between the first and the third
        // read of one session, because servers were still coming up), so a breakdown shown without its age
        // claims a stability that does not exist.
        m.at = Date.now();
        tb.ctxMeasured = m; tb._ctxMisses = 0;
        // a frame that arrived while this answer was on its way may already carry more than it reports — the
        // measurement then lands beaten, and that has to be remembered on it like a later frame would (ctx.js
        // ctxNoteBeaten), or the window comes back unmarked once the count drops inside this generation
        if (typeof ctxNoteBeaten === 'function') ctxNoteBeaten(tb);
        // …and let the ONE decision say what this answer means for the stored window and for the learned
        // store: a measured window is shown unconditionally (it is the CLI talking about THIS session), but
        // it is only remembered when it fits the variant — see ctx.js (8)/(7). A measurement the frames beat
        // (the count already above what the CLI just reported) is dropped from the line but files NOTHING since
        // 05.10.: a measurement outranks every floor, so a bound filed here would be refuted by this very answer
        // at the next read. The other way round is what this call now does: a floor ABOVE the measured window
        // is refuted by it (`rec.healed`), and ctxRemember removes it from the shared store.
        ctxRemember(tb, ctxDecide(tb, ctxEnv(tb)));
      }
    }
  } catch { stale = !ctxAnswerUsable(tb, asked.gen); if (!stale) tb._ctxMisses = (tb._ctxMisses || 0) + 1; } // e.g. a server without the route yet
  finally { tb._ctxQuery = false; }
  // the trigger that arrived mid-flight gets its query now — and a discarded answer asks again on its own,
  // so the new state is never left with nothing just because the old one's query was still open
  const again = tb._ctxRearm || (stale ? trigger : '');
  tb._ctxRearm = '';
  if (again) { ctxProbe(tb, again); return; }
  if (tb === ACTIVE) updateCtxGauge(tb);
}
// What a line without a number says about itself, per the `pendingWhy` of ctxDecide: only one of the four is
// a promise that something is on its way.
const CTX_PENDING_KEYS = {
  measuring: 'commands.kontextWirdGemessen',   // a query is (or can be) in flight
  idle: 'commands.kontextNochKeineMessung',    // no session to ask: never started, or already exited
  silent: 'commands.kontextKeineAntwort',      // asked twice, no answer — nothing is waiting any more
  // …and the one that is final for this process: the CLI answered the query with „Unsupported control
  // request subtype", i.e. it does not have it. „antwortet nicht" would invite waiting for an answer that
  // this binary can never give (ctx.js ctxProbeUnsupported).
  unsupported: 'commands.kontextKeineMessungMoeglich',
};
// Everything the painted line depends on, the tab included: the gauge is ONE shared element, so „nothing
// changed" has to mean „nothing changed about what is on screen", not „nothing changed on this tab".
// It is the DECIDED record, serialised — not a hand-picked list of tab fields. That list was a second
// freshness path: it had to be kept in step with the precedence by hand, and a field it forgot (or a state
// like „CLI antwortet nicht", which changes the text without moving a number) froze the line.
let CTX_PAINTED = '';
// CTX-2 — the frames moved `ctxTokens` and nothing repainted: the line kept whatever the last `result`
// had left for as long as the turn ran (the report: one turn, over an hour, a frozen number). Called from
// the 200 ms status ticker, so it repaints only on a real change — updateCtxGauge rebuilds the element.
// The drain animation owns that element while it runs, so the tick keeps its hands off it.
function ctxGaugeTick(tab) {
  const tb = tab || (typeof ACTIVE !== 'undefined' ? ACTIVE : null);
  if (!tb || CTX_PROG) return;
  updateCtxGauge(tb, true);
}
function updateCtxGauge(tab, onlyIfChanged) {
  const tb = tab || (typeof ACTIVE !== 'undefined' ? ACTIVE : null);
  if (!tb) return;
  const g = $('#ctxGauge'); if (!g) return;
  // ONE decision — which model, which window, from which source, and may it be called measured (ctx.js).
  const env = ctxEnv(tb);
  const rec = ctxDecide(tb, env);
  const key = tb.uid + '|' + JSON.stringify(rec);
  if (onlyIfChanged && key === CTX_PAINTED) return;
  CTX_PAINTED = key;
  const pct = rec.pct;
  g.classList.remove('hidden'); g.innerHTML = '';
  g.classList.toggle('ctx-pending', rec.pending);
  // CTX-7 — the menu label and the window do not come from the same place, which is how „Opus 5 (1M)" ended
  // up over a 200 000 window. Neither of the two is hidden: the contradiction is MARKED, because nothing
  // here can know which of them is the wrong one — the line shows the window (rec.shows).
  const clash = !!rec.conflict;
  // „zeigen statt verstecken" (CTX-3): with no number yet the line stays and names its state, instead of
  // leaving — a line that disappears is how a wrong value stayed unchallenged. Which state that is, is
  // decided in ctx.js: „wird gemessen…" would be a claim about a query that an unstarted tab never sends
  // and a twice-silent one has stopped sending.
  // „≈" marks a line the panel DERIVED rather than one the CLI measured — and BOTH halves have to be
  // measured for it to go away. Round 2 set that flag from the token count alone, so a measured token count
  // next to a guessed window printed no „≈" and its tooltip claimed „von der CLI gemessen".
  // The sentence itself is composed in ctx.js, where the table can assert it character by character: the
  // reported bug WAS a string, and composing it here left the step from the decision to that string untested.
  const label = ctxGaugeLine(rec, {
    kontext: t('commands.kontext'),
    pending: t(CTX_PENDING_KEYS[rec.pendingWhy] || CTX_PENDING_KEYS.measuring),
  }, fmtNum);
  g.classList.toggle('ctx-clash', clash);
  // PR-11 — the line and the bar are now a real BUTTON: clicking them opens the breakdown (where the
  // context goes, per category and per MCP server). A real <button> and not a click handler on the div, for
  // the reason removeX in views.js already states: a div with an onclick is not focusable, has no
  // Enter/Space and is announced as nothing at all. The two remedy buttons below stay SIBLINGS of it —
  // nesting them inside would make „/compact" also open the panel.
  const open = el('button', 'ctx-open'); open.type = 'button';
  open.appendChild(el('span', 'ctx-label', label));
  const bar = el('div', 'ctx-bar'); const fill = el('div', 'ctx-fill' + (rec.level ? ' ' + rec.level : '')); fill.style.width = rec.bar.toFixed(1) + '%'; bar.appendChild(fill); open.appendChild(bar);
  // The tooltip moves to the button, which covers the whole line: on the container it would ALSO show over
  // the „Kompaktieren"/„Leeren" buttons, where it describes something else.
  open.title = ctxGaugeTitle(rec, env.label) + '\n' + t('ctxbd.klickHinweis');
  open.setAttribute('aria-label', label + ' — ' + t('ctxbd.titel'));
  open.onclick = () => ctxOpenBreakdown(tb);
  g.appendChild(open);
  // at high usage, offer the remedies inline instead of the plain "/compact erwägen" text
  if (!rec.pending && pct > 80) {
    g.classList.add('ctx-warn');
    const acts = el('span', 'ctx-acts');
    // D5 — FIRST the handoff, then the two lossy options. Auto-compaction keeps a summary, but IT
    // decides what mattered: exact object names, rejected alternatives and the "why not" get thinned,
    // and you notice hours later when something settled long ago is asked again. Writing the handoff
    // while the context is still complete is the move that preserves it — so it leads here.
    if ((CHAT_COMMANDS || []).includes('/handoff')) {
      const b0 = el('button', 'ctx-btn ctx-btn-primary', t('commands.handoffSchreiben'));
      b0.title = t('commands.handoffTooltip');
      b0.onclick = () => sendChatCommand('/handoff');
      acts.appendChild(b0);
    }
    const b1 = el('button', 'ctx-btn', t('commands.kompaktieren')); b1.title = t('commands.bisherigenVerlaufKomprimierenCompact'); b1.onclick = () => sendChatCommand('/compact');
    // /clear throws the whole context away irreversibly, and since it can now be QUEUED it may fire
    // minutes after the click — so it asks first, the same rule the tab menu already follows.
    const b2 = el('button', 'ctx-btn', t('commands.leeren')); b2.title = t('commands.kontextLeerenClearSession');
    b2.onclick = async () => { if (await uiConfirm(t('chat.clearFrage'), { title: t('chat.kontextLeeren'), danger: true, okLabel: t('chat.leeren') })) sendChatCommand('/clear'); };
    acts.appendChild(b1); acts.appendChild(b2); g.appendChild(acts);
    // …and say it once per threshold crossing, so a run you are not watching still gets the hint.
    // Re-armed when usage drops back below the threshold (a compaction), not on every repaint.
    // The flag belongs to the tab being MEASURED (`tb`), not to the ambient `chat`: a repaint on tab
    // switch would otherwise arm/disarm the warning of whichever tab last ran an event.
    if (!tb._ctxWarned) {
      tb._ctxWarned = true;
      // A warning, not an error — nothing failed here. As 'err' it was STICKY (toast() keeps errors up
      // until they are clicked, so a real failure can't be missed by looking away), which meant a
      // routine "context is filling up" notice sat in the corner demanding a click, and looked like
      // something had gone wrong. It is advice with three buttons already sitting in the gauge below,
      // so it may fade on its own; the 🔔 log keeps it either way.
      toast('⚠ ' + t('commands.kontextWarnung').replace('{p}', pct.toFixed(0)), 'warn');
      if (typeof chatNotify === 'function') chatNotify('⚠ ' + t('commands.kontextWarnungKurz'), t('commands.kontextWarnung').replace('{p}', pct.toFixed(0)));
    }
  } else {
    g.classList.remove('ctx-warn');
    if (pct < 70) tb._ctxWarned = false; // hysteresis: don't re-fire while hovering at the line
  }
}

// ---- PR-11: the breakdown behind the gauge — WHERE the context goes ---------------------------------
// Opened by clicking the gauge. THE ONE THING THIS MUST NOT DO is ask the CLI again: the answer is 38 KB
// on the child's stdin and PR-3b decided on purpose to ask only at the turn boundaries (start · result ·
// model change · /clear · /compact). The categories and the per-server aggregate already travel with the
// measurement the gauge is painted from (ctx.js ctxFromRoute `cats`/`mcp`), so this reads what is there and
// issues no request at all — not even a refresh button, which would be exactly the extra traffic the
// previous decision ruled out. If there is no measurement yet, the panel says so; the probe re-arms at the
// next boundary on its own while the window is in doubt (ctx.js ctxWindowInDoubt).
// All arithmetic is in ctx-breakdown.js, where a test can reach it without a DOM — this function only puts
// numbers it was handed into elements. That split is not cosmetic: the half that was untested last time was
// the VISIBLE one, and a one-word rename made a feature mute while 123 tests stayed green.
function ctxBdRow(name, tokens, cls) {
  const r = el('div', 'bd-row' + (cls ? ' ' + cls : ''));
  r.appendChild(el('span', 'bd-name', name));
  r.appendChild(el('span', 'bd-num', fmtNum(tokens)));
  return r;
}
function ctxOpenBreakdown(tab) {
  const tb = tab || (typeof ACTIVE !== 'undefined' ? ACTIVE : null);
  if (!tb) return;
  const rec = ctxDecide(tb, ctxEnv(tb));
  const bd = ctxBreakdown(tb.ctxMeasured, { gen: ctxGenOf(tb), stamp: ctxStampOf(tb) });
  const body = el('div', 'bd');
  if (!bd.ok) {
    // „zeigen statt verstecken", one level down: the panel opens and names the state instead of refusing to
    // open. Which state it is comes from ctx-breakdown.js, so this list cannot drift from the decision.
    const why = { keine: 'ctxbd.keineMessung', veraltet: 'ctxbd.veraltet', keineKategorien: 'ctxbd.keineKategorien' };
    body.appendChild(el('p', 'bd-empty', t(why[bd.grund] || why.keine)));
    // …and what the gauge itself is waiting for, in its own words — the same sentence the line shows, so
    // the two cannot say different things about one state.
    if (rec.pending) body.appendChild(el('p', 'bd-note', t(CTX_PENDING_KEYS[rec.pendingWhy] || CTX_PENDING_KEYS.measuring)));
    uiModal({ icon: '◴', title: t('ctxbd.titel'), body, wide: true, escValue: true,
      actions: [{ label: t('views-uiskills.ok'), value: true, primary: true }] });
    return;
  }
  // The head repeats the CLI's own three numbers — total, window, percentage — and nothing is recomputed
  // here: `pct` is null when the answer carried no `percentage`, and then no ratio is printed at all
  // (ctxGaugeLine makes the same choice for the line: an unknown ratio is absent, not „0 %").
  // …and the WINDOW half is absent for the same reason, not printed as „/ 0": a missing `maxTokens` leaves
  // `win` at 0 on purpose (ctx.js:541 — the answer then measures the TOKENS, not the window), so „21.667 / 0"
  // would put a figure on screen the CLI never sent, right beside the chip „von der CLI gelesen". The note
  // block below names the state in words (`ctxbd.keinFenster`).
  const head = el('div', 'bd-head');
  head.appendChild(el('span', 'bd-big', fmtNum(bd.total) + (bd.hatFenster ? ' / ' + fmtNum(bd.fenster) : '')));
  if (bd.pct != null) head.appendChild(el('span', 'bd-pct', bd.pct + ' %'));
  head.appendChild(el('span', 'bd-src', t('ctxbd.gelesen')));
  // WHEN, because the value wanders: between the first and the third read of ONE session the MCP block grew
  // by 10 492 tokens while servers were still coming up. Two breakdowns of the same chat may legitimately
  // differ, and a panel without a time on it claims otherwise. `bd.bewegt` adds that newer frames have
  // arrived since — the rows are then the last real measurement, which is shown and marked, not hidden.
  if (bd.at) head.appendChild(el('span', 'bd-at' + (bd.bewegt ? ' bd-moved' : ''), t('ctxbd.gemessenUm') + fmtClock(bd.at)));
  body.appendChild(head);

  // the bar: one segment per delivered row, in window order. The segments sum to the window EXACTLY by
  // construction (ctx-breakdown.js appends both residues as segments of their own), so there is no
  // „remainder" the drawing has to swallow. When a residue came out negative the numbers contradict each
  // other and no bar is drawn — see `widerspruch` there.
  // …and with no window there is no scale to draw against at all: every width would be 0 and the bar would
  // be an empty frame suggesting „nothing in the context".
  if (bd.hatFenster && !bd.widerspruch) {
    const barBox = el('div', 'bd-bar');
    bd.segmente.forEach((s) => {
      const seg = el('span', 'bd-seg bd-' + s.teil);
      seg.style.width = s.breite.toFixed(2) + '%';
      seg.title = (s.name || t(s.teil === 'offen' ? 'ctxbd.offen' : 'ctxbd.rest')) + ' · ' + fmtNum(s.tokens);
      barBox.appendChild(seg);
    });
    body.appendChild(barBox);
  }

  // the rows. Category NAMES are the CLI's own strings and are printed verbatim — the same rule the tooltip
  // already follows for `autocompactSource` and the hook catalog for `summary`: translating a name the CLI
  // generates makes it unsearchable, and the list is dynamic (the binary pushes „MCP tools", „MCP server
  // instructions" and „Custom agents" only when they are non-zero), so there is no fixed set to translate.
  const list = el('div', 'bd-list');
  const sect = (titel, n) => { const h = el('div', 'bd-sect'); h.appendChild(el('span', null, titel)); if (n != null) h.appendChild(el('span', 'bd-num', fmtNum(n))); list.appendChild(h); };
  sect(t('ctxbd.imFenster'), bd.hatFenster ? bd.fenster : null);
  bd.segmente.forEach((s) => {
    list.appendChild(ctxBdRow(s.name || t(s.teil === 'offen' ? 'ctxbd.offen' : 'ctxbd.rest'), s.tokens, 'bd-' + s.teil));
    // the per-SERVER share is nested under the row the CLI's own payload says it belongs to (name match, not
    // a hard-coded category), and only when the route's counter-check held: Σ(per server) has to HIT that
    // delivered value or lib/chat.js hands out nothing at all.
    if (bd.mcp && bd.mcp.category && s.name && s.name === bd.mcp.category.name) list.appendChild(ctxBdMcp(bd.mcp));
  });
  if (bd.nachladbar.length) {
    // THE TRAP, and the reason this block is separate and below: `deferred` is in neither totalTokens nor
    // „Free space". Stacking it into the bar gave 1 090 317 of 1 000 000 = 109 % in the measured session —
    // „Kontext 250 % · 500,8K / 200,0K" one axis over. It is the biggest single item, so it is shown; it is
    // not part of the window, so it is shown apart.
    sect(t('ctxbd.nachladbar'), bd.nachladbarSumme);
    bd.nachladbar.forEach((r) => {
      list.appendChild(ctxBdRow(r.name, r.tokens, 'bd-nachladbar'));
      if (bd.mcp && bd.mcp.category && r.name === bd.mcp.category.name) list.appendChild(ctxBdMcp(bd.mcp));
    });
  }
  if (bd.unbekannt.length) {
    sect(t('ctxbd.unbekannt'), null);
    bd.unbekannt.forEach((r) => list.appendChild(ctxBdRow(r.name, r.tokens, 'bd-unbekannt')));
  }
  body.appendChild(list);

  // the sentences: which identity failed, what is only nachladbar, whether newer frames have arrived, and
  // the CLI's own word for why the 100 % line is where it is. Keys come from ctx-breakdown.js for the same
  // reason the tooltip's do (ctx.js ctxTitleLines): two sentences were wrong there and nothing could see it.
  const notes = ctxBreakdownNotes(bd);
  if (notes.length) {
    const box = el('div', 'bd-notes');
    notes.forEach((n) => {
      let s = t(n.key);
      if (n.num != null) s += fmtNum(n.num);
      if (n.text) s += String(n.text);     // a word the CLI itself used — verbatim, never translated
      box.appendChild(el('p', n.warn ? 'bd-warn' : null, (n.warn ? '⚠ ' : '') + s));
    });
    body.appendChild(box);
  }
  uiModal({ icon: '◴', title: t('ctxbd.titel'), body, wide: true, escValue: true,
    actions: [{ label: t('views-uiskills.ok'), value: true, primary: true }] });
}
// one block of MCP servers, biggest first. `loadedCount` is reported only when it is non-zero: in every
// measured read all 141 tools were `isLoaded: false`, so „0 geladen" on every row would be noise — and a
// row that says „x von y geladen" when it really is loaded is the information that matters.
// The wording avoids „server x takes y % of your context" on purpose: in the measured session the whole MCP
// block sat in the DEFERRED category, i.e. outside totalTokens, so a percentage of the window would be a
// share of something these tokens do not count against.
function ctxBdMcp(mcp) {
  const box = el('div', 'bd-mcp');
  mcp.servers.forEach((s) => {
    const r = el('div', 'bd-row bd-sub');
    r.appendChild(el('span', 'bd-name', s.name));
    // singular/plural, because a server with ONE tool is the normal case for the small MCPs and „1
    // Werkzeuge" is the kind of detail that makes a panel look machine-written (seen in the sight check)
    const meta = el('span', 'bd-meta', t(s.toolCount === 1 ? 'ctxbd.werkzeug' : 'ctxbd.werkzeuge').replace('{n}', String(s.toolCount))
      + (s.loadedCount ? ' · ' + t('ctxbd.geladen').replace('{n}', String(s.loadedCount)) : ''));
    r.appendChild(meta);
    r.appendChild(el('span', 'bd-num', fmtNum(s.tokens)));
    box.appendChild(r);
  });
  // the counter-check, said out loud: the sum of the rows above IS a number the CLI delivered under this
  // name. That is what makes the aggregation a reading instead of a second number beside the first.
  box.appendChild(el('div', 'bd-check', t('ctxbd.gegenprobe').replace('{c}', mcp.category.name).replace('{n}', fmtNum(mcp.tokens))));
  return box;
}
// The tooltip carries what does not fit in one line: where each half of the number comes from, and the
// Bedrock caveat. The window is what the CLI REPORTS from its own model table — measured on 2026-10-02,
// the gateway disagreed for Opus 5.5 (the inference call is a 403 for this role), so it is never
// presented as a guarantee. `rawMaxTokens` is only named when it differs from the 100 % line: in every
// measurement the two were identical, and repeating the same number reads as a second, different limit.
// The two halves are reported SEPARATELY, because they have separate sources: a measured token count over a
// guessed window used to produce one line claiming „von der CLI gemessen" about the pair.
// WHICH sentences, in which order, is decided in ctx.js (ctxTitleLines) for the same reason the LINE is
// composed there: two of them were simply wrong and nothing could see it — the same key was pushed for both
// kinds of conflict, so a refused variant report („variant-usage") was described as „the model label
// promises 1M", blaming a label that need not mention 1M at all. This function only looks the keys up and
// fills in what needs the browser: the menu label and a locale-formatted number.
function ctxGaugeTitle(rec, mdlLabel) {
  return ctxTitleLines(rec).map((l) => {
    let s = t(l.key);
    if (l.label) s = s.replace('{m}', mdlLabel || '?');
    if (l.num != null) s += fmtNum(l.num);
    // a word the CLI itself used (`autocompactSource`) — appended verbatim, like „rawMaxTokens" above it: it is
    // the CLI's own name for the limit, and translating or prettifying it would make it unsearchable
    if (l.text) s += String(l.text);
    return (l.warn ? '⚠ ' : '') + s;
  }).join('\n');
}
// „zeigen statt verstecken" (CTX-3). Every caller of this meant „this NUMBER is gone", not „this line is
// gone": a fresh tab, a restart, a finished /clear, the drain's safety timeout. The window usually
// survives all of them, and where it does not the line says „wird gemessen…" — so the element stays and
// the gauge is repainted instead of dropped. Only with no tab at all is there nothing to show.
function hideCtxGauge() {
  const tb = (typeof ACTIVE !== 'undefined' && ACTIVE) || null;
  if (!tb) { const g = $('#ctxGauge'); if (g) g.classList.add('hidden'); return; }
  updateCtxGauge(tb);
}
// --- clear/compact visual feedback: a FORWARD green progress bar with a live % (ToDo 02) ---
// The CLI exposes no determinate progress (it signals start via `system/status status:"compacting"` and end
// via the result — no % in between), so the % is an eased ESTIMATE that approaches ~92% and snaps to 100%
// when the op finishes; then updateCtxGauge settles the bar to the real post-op value (CTX-3: it settles,
// it never drops the line — not even when the safety timeout below fires mid-turn).
let CTX_PROG = null; // { timer, pct, op }
function stopCtxProgTimer() { if (CTX_PROG && CTX_PROG.timer) { clearInterval(CTX_PROG.timer); CTX_PROG.timer = null; } if (CTX_PROG && CTX_PROG.safety) { clearTimeout(CTX_PROG.safety); CTX_PROG.safety = null; } }
function startCtxDrain(op) {
  const g = $('#ctxGauge'); if (!g) return;
  stopCtxProgTimer();
  CTX_PAINTED = ''; // the drain takes the element over → whatever the gauge last painted is gone
  g.classList.remove('hidden'); g.innerHTML = '';
  const verb = op === 'clear' ? t('commands.kontextWirdGeleert') : t('commands.kontextWirdKompaktiert');
  const label = el('span', 'ctx-label'); g.appendChild(label);
  const bar = el('div', 'ctx-bar'); const fill = el('div', 'ctx-fill working'); bar.appendChild(fill); g.appendChild(bar);
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const st = { op, pct: reduce ? 60 : 4, timer: null, safety: null };
  const paint = () => { fill.style.width = st.pct.toFixed(0) + '%'; label.textContent = verb + '… ' + st.pct.toFixed(0) + '%'; };
  paint();
  if (!reduce) st.timer = setInterval(() => { st.pct += (92 - st.pct) * 0.12; if (st.pct > 91.5) st.pct = 91.5; paint(); }, 220);
  // never hang the bar — but CTX-6: the safety net gives the element back to the real gauge, it does not
  // blank it. An auto-compaction fires MID-TURN, so a 90 s timeout that hid the line took the context
  // read-out away in the middle of a running turn, exactly when it is being watched.
  st.safety = setTimeout(() => { try { clearCtxDrainTimers(); updateCtxGauge(); } catch { /* */ } }, 90000);
  CTX_PROG = st;
}
// stop the green drain animation timers WITHOUT clobbering the fill to green 100% — the caller then lets
// updateCtxGauge settle the bar to the real post-op value (or hideCtxGauge drop it). Fixes the /compact bug
// where the bar stuck green at 100% because the old stopCtxDrain forced width:100% after updateCtxGauge (ToDo 02).
function clearCtxDrainTimers() { stopCtxProgTimer(); CTX_PROG = null; }
// The very first tab is created in chat-perms.js, which loads BEFORE this file — so its activateTab() found
// no updateCtxGauge yet and a freshly opened panel showed no context line at all until something else
// repainted it. Paint it once, now that the function exists (CTX-3: the line is there from the start).
if (typeof ACTIVE !== 'undefined' && ACTIVE) updateCtxGauge(ACTIVE);

// --- recent / favorite working dirs ---
function recentCwds() { try { return JSON.parse(localStorage.getItem('cc_recent_cwd') || '[]'); } catch { return []; } }
function pushRecentCwd(c) { if (!c) return; let a = recentCwds().filter((x) => x !== c); a.unshift(c); localStorage.setItem('cc_recent_cwd', JSON.stringify(a.slice(0, 8))); }
function refreshCwdList() {
  const dl = $('#cwdList'); if (!dl) return; dl.innerHTML = '';
  const projs = [...new Set((SESSIONS || []).map((s) => s.projectPath).filter(Boolean))];
  const all = [...new Set([...recentCwds(), STATE && STATE.defaultCwd, STATE && STATE.home, ...projs].filter(Boolean))];
  all.slice(0, 20).forEach((p) => { const o = document.createElement('option'); o.value = p; dl.appendChild(o); });
}

// ============================================================
//  Export · in-chat search · sensitive-data guard · drafts
// ============================================================
// Export the WHOLE session from /api/transcript instead of scraping the painted DOM: the DOM holds only what
// the transcript cap kept (and, before WP-2, queued messages in the wrong order), so the export silently lost
// history without telling anyone. A tab without a session yet still exports what's painted. (C12)
async function exportChat(fmt, tabArg) {
  const tab = tabArg || ACTIVE;
  if (!tab) return;
  const sid = tab.sessionId;
  let items = null, complete = false;
  if (sid) {
    const s = sessionRefFor(sid, tab.cwd);
    try {
      const r = await api('/api/transcript?project=' + encodeURIComponent(s.project) + '&id=' + encodeURIComponent(s.id));
      items = (r.events || [])
        .filter((e) => (e.text && e.text.trim()) || (e.tools && e.tools.length) || e.kind === 'summary')
        .map((e) => ({
          role: e.kind === 'user' ? t('common.du') : e.kind === 'assistant' ? 'Claude' : e.kind,
          ts: e.ts || null,
          text: (e.text || '') + ((e.tools && e.tools.length) ? '\n\n⚙ ' + e.tools.map((x) => (x && x.name) || x).join(', ') : ''),
        }));
      complete = true;
    } catch (e) { toast(t('commands.exportVollstaendigFehlgeschlagen') + e.message, 'err'); }
  }
  if (!items) {
    const msgs = [...tab.msgEl.querySelectorAll('.msg')];
    if (!msgs.length) { toast(t('commands.keinChatZumExportieren'), 'err'); return; }
    items = msgs.map((m) => {
      const role = m.classList.contains('user') ? t('common.du') : m.classList.contains('assistant') ? 'Claude' : t('common.system');
      const b = m.querySelector('.bubble');
      const text = b ? ((m.classList.contains('assistant') && b.dataset.raw != null) ? b.dataset.raw : b.innerText) : '';
      return { role, text, ts: m.dataset.ts ? Number(m.dataset.ts) : null };
    });
  }
  const tag = (sid || tab.id || 'export').slice(0, 8);
  let blob, fname;
  if (fmt === 'json') {
    blob = new Blob([JSON.stringify({ session: sid || tab.id, model: tab.model, complete, exported: new Date().toISOString(), messages: items }, null, 2)], { type: 'application/json' });
    fname = 'chat-' + tag + '.json';
  } else {
    const md = items.map((it) => '## ' + it.role + (it.ts ? ' · ' + new Date(it.ts).toLocaleString() : '') + '\n\n' + it.text).join('\n\n---\n\n');
    blob = new Blob([t('commands.claudeCodeChatExport') + '\n\n_' + new Date().toLocaleString() + '_\n\n'
      + (complete ? '' : '> ' + t('commands.exportNurGeladeneNachrichten') + '\n\n') + md + '\n'], { type: 'text/markdown' });
    fname = 'chat-' + tag + '.md';
  }
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  toast(t('commands.exportiert') + fname + (complete ? '' : ' · ' + t('commands.nurGeladen')), 'ok');
}
$('#exportMd').onclick = () => exportChat('md');
$('#exportJson').onclick = () => exportChat('json');

// --- in-chat search (message-level) ---
const SEARCH = { matches: [], idx: -1 };
function clearSearchHl() { [...ACTIVE.msgEl.querySelectorAll('.search-hit, .search-cur')].forEach((m) => m.classList.remove('search-hit', 'search-cur')); }
// innerText reflects layout, so reading it forces a REFLOW per message — on a large transcript that was a full
// reflow storm per keystroke. Cache the lowercased text per node (invalidated when the search opens); a bubble
// that is still streaming is never cached. (P6)
function msgSearchText(m) {
  if (m.querySelector('.streaming')) return (m.innerText || '').toLowerCase();
  if (m._searchText == null) m._searchText = (m.innerText || '').toLowerCase();
  return m._searchText;
}
function invalidateSearchCache() { if (ACTIVE) ACTIVE.msgEl.querySelectorAll('.msg').forEach((m) => { m._searchText = null; }); }
function runChatSearch() {
  clearSearchHl();
  const q = $('#chatSearchInput').value.trim().toLowerCase();
  SEARCH.matches = [];
  if (q) [...ACTIVE.msgEl.querySelectorAll('.msg')].forEach((m) => { if (msgSearchText(m).includes(q)) { m.classList.add('search-hit'); SEARCH.matches.push(m); } });
  SEARCH.idx = SEARCH.matches.length ? 0 : -1;
  updateSearchCur();
  updateSearchScopeHint(q);
}
// Ctrl+F only ever searched the LOADED (capped) DOM and said nothing about it — a miss looked like "not in this
// session" when it just wasn't painted. Offer the handoff to the existing cross-session search, scoped to this
// session. (C12)
function updateSearchScopeHint(q) {
  const bar = $('#chatSearch'); if (!bar) return;
  let hint = bar.querySelector('.cs-scope');
  if (!hint) {
    hint = el('button', 'cs-scope'); hint.type = 'button';
    hint.onclick = () => { const sid = ACTIVE && ACTIVE.sessionId; openGlobalSearch($('#chatSearchInput').value.trim(), sid || null); };
    bar.insertBefore(hint, $('#chatSearchClose'));
  }
  const trimmed = ACTIVE && ACTIVE.msgEl.querySelector('.history-note.trim-note, .history-note');
  hint.textContent = '⌕ ' + t('commands.auchInDerGanzenSession');
  hint.title = t('commands.nurGeladeneNachrichten') + (trimmed ? ' ' + t('commands.aeltereAusgeblendet') : '');
  hint.classList.toggle('hidden', !q);
}
function updateSearchCur() {
  [...ACTIVE.msgEl.querySelectorAll('.search-cur')].forEach((m) => m.classList.remove('search-cur'));
  $('#chatSearchCount').textContent = SEARCH.matches.length ? (SEARCH.idx + 1) + '/' + SEARCH.matches.length : '0/0';
  const cur = SEARCH.matches[SEARCH.idx];
  if (cur) { cur.classList.add('search-cur'); cur.scrollIntoView({ block: 'center' }); }
}
function searchStep(d) { if (!SEARCH.matches.length) return; SEARCH.idx = (SEARCH.idx + d + SEARCH.matches.length) % SEARCH.matches.length; updateSearchCur(); }
function openChatSearch() { showView('chat'); invalidateSearchCache(); $('#chatSearch').classList.remove('hidden'); const i = $('#chatSearchInput'); i.focus(); i.select(); runChatSearch(); }
function closeChatSearch() { $('#chatSearch').classList.add('hidden'); clearSearchHl(); SEARCH.matches = []; SEARCH.idx = -1; }
$('#chatSearchBtn').onclick = openChatSearch;
$('#chatSearchClose').onclick = closeChatSearch;
$('#chatSearchNext').onclick = () => searchStep(1);
$('#chatSearchPrev').onclick = () => searchStep(-1);
$('#chatSearchInput').addEventListener('input', debounce(runChatSearch, 140));
$('#chatSearchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); searchStep(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); closeChatSearch(); }
});

// --- sensitive-data guard (local heuristic, soft warning) ---
function scanSensitive(text) {
  const hits = [];
  const s = String(text || '');
  if (/\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i.test(s)) hits.push(t('commands.eMailAdresse'));
  if (/\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){2,7}[A-Z0-9]{1,4}\b/.test(s)) hits.push(t('commands.iban'));
  if (/\b(?:\d[ -]?){13,19}\b/.test(s)) hits.push(t('commands.langeZahlenfolgeKarteNummer'));
  if (/\b(?:versicherungsnummer|policennummer|sozialversicherung|geburtsdatum|kreditkarte|personalnummer|kyc|aml|schadennummer)\b/i.test(s)) hits.push(t('commands.regulierterBegriff'));
  return [...new Set(hits)];
}

// --- composer draft + last session ---
// The draft belongs to the TAB it was typed in (C8): it is stored on the tab and persisted inside the tab's
// `cc_tabs` entry. For the case where no tab is restored at all (chat.js tabsBoot) there are two more: the
// global `cc_draft` — the last text typed in ANY window, for the first window after a restart — and this
// window's own copy in sessionStorage (CHAT-FLOW-4 part B, tab-windows.js twBootDraft), for its reload: with the
// global key alone, a reload of A showed what B had typed last. As the only store, the global key made every
// tab show the last-typed text after a reload (C8).
function saveDraft() {
  const v = $('#composerInput').value;
  if (typeof ACTIVE !== 'undefined' && ACTIVE) { ACTIVE.draft = v; if (typeof persistTabsSoon === 'function') persistTabsSoon(); }
  try { localStorage.setItem('cc_draft', v); } catch {}
  try { sessionStorage.setItem(TW_DRAFT_KEY, v); } catch { /* no sessionStorage: tabsBoot's fallback reads the global key */ }
}
function clearDraft() {
  if (typeof ACTIVE !== 'undefined' && ACTIVE) { ACTIVE.draft = ''; if (typeof persistTabsSoon === 'function') persistTabsSoon(); }
  try { localStorage.removeItem('cc_draft'); } catch {}
  try { sessionStorage.removeItem(TW_DRAFT_KEY); } catch { /* as above */ }
}
function saveLastSession(id, cwd) { try { localStorage.setItem('cc_last_session', JSON.stringify({ id, cwd })); } catch {} }
function offerLastSession() {
  let last; try { last = JSON.parse(localStorage.getItem('cc_last_session') || 'null'); } catch { last = null; }
  const host = $('#chatEmpty'); const old = $('#resumeLast'); if (old) old.remove();
  if (!last || !last.id || chat.id) return;
  const btn = el('button', 'ghost-btn'); btn.id = 'resumeLast'; btn.textContent = t('commands.letzteSessionFortsetzen') + last.id.slice(0, 8) + ')';
  btn.style.marginTop = '14px';
  btn.onclick = async () => {
    const s = (SESSIONS || []).find((x) => x.id === last.id);
    if (s) { resumeSession(s, false); return; } // looks in this window's tabs itself (CHAT-FLOW-4)
    // CHAT-FLOW-4 — the same two rules as resumeSession: a tab of this window that has it wins, and a 409
    // (another tab or window holds it) asks about the takeover instead of showing the bare refusal
    const open = typeof findSessionTab === 'function' ? findSessionTab(last.id) : null;
    if (open) { activateTab(open); return; }
    // the same rule as resumeSession (P-0, chat.js tabUntouched): the button sits in the empty state of whatever
    // tab is active when it is clicked, and that tab may have roots, an agent, an MCP scope or an attachment set
    // up meanwhile — the start body would take them into the resumed session
    const tab = tabUntouched(ACTIVE) ? ACTIVE : newTab();
    try { await startChat({ resume: last.id, cwd: last.cwd }, tab); }
    catch (e) {
      if (e && e.code === 'session-open-elsewhere' && typeof takeBackTab === 'function') {
        try { if (await takeBackTab(tab)) holdQueueAfterResume(tab); } catch (e2) { toast(e2.message, 'err'); }
      } else toast(e.message, 'err');
    }
  };
  host.appendChild(btn);
  lastSessionMark(btn, last.id);
}
// CHAT-FLOW-4 part B — cc_last_session is written by EVERY window (the last init wins), so the one button of a
// fresh second window points, almost always, at the session the first window is running. Ask the server (the
// probe of part A, the same rule as its 409) and say so on the button; the click then goes through the takeover
// question as before. Marked, not skipped: cc_last_session holds one session, there is no earlier one to offer
// instead. Says only what the probe answered — nothing when it could not be asked (an older server, offline),
// „Turn lief" only when the server reported one, „beim Prüfen" because it is the state of that moment, and
// „anderswo" rather than „in einem anderen Fenster": the server sees an attached stream, not whose it is (a tab,
// a window, a UI-skill run).
function lastSessionMark(btn, id) {
  api('/api/session/open?id=' + encodeURIComponent(id)).then((st) => {
    if (!st || !st.open) return;
    btn.textContent += t(st.busy ? 'commands.letzteAnderswoTurn' : st.starting ? 'commands.letzteAnderswoStartet' : 'commands.letzteAnderswoOffen');
    btn.title = t('commands.letzteAnderswoTitel');
  }).catch(() => { /* not asked → not claimed */ });
}

