// Part of the Claude Code Control Panel front-end (split from app.js).
// Classic scripts share one global scope; load order in index.html is authoritative: render → chat → sessions → views → commands → boot.
// This file: sessions.js

// ============================================================
//  SESSIONS
// ============================================================
let SESSIONS = [];
let SEL_MODE = false;
const SELECTED = new Set();
// A6: which session's transcript is open. Every rerender (favorite toggle, rename, nav click) used to
// rebuild the list and drop the .active marker — the user lost track of what they were reading.
let OPEN_SESSION_ID = null;
let SESSIONS_LOADED = false; // A18/A19: has /api/sessions ever answered? (cwd autocomplete + palette need it)
async function loadSessions() {
  $('#sessionsList').innerHTML = '<div class="loading">' + t('sessions.sessionsWerdenGeladen') + '</div>';
  // A14: the placeholder promised full-text ("Text") but the filter only ever saw the preview — say so.
  // Set here, not via data-i18n-ph, because applyStaticI18n runs BEFORE reloadActiveView on a language switch.
  if ($('#sessSearch')) $('#sessSearch').placeholder = t('sessions.sessSuchePh');
  try {
    const r = await api('/api/sessions');
    SESSIONS = r.sessions;
    SESSIONS_LOADED = true;
    renderSessions();
    refreshCwdList();
    // the project chips name their project — the list is loaded once, then the rows are drawn again (J5)
    if (typeof ensureProjects === 'function' && typeof PROJECTS_DATA !== 'undefined' && !PROJECTS_DATA) ensureProjects().then((d) => { if (d) renderSessions(); });
  } catch (e) { errorCard('#sessionsList', t('sessions.sessListeFehler') + e.message, loadSessions); }
}
// A18/A19: load the session list ONCE on demand — the cwd autocomplete (boot) and the palette's
// "Session · Fortsetzen" group both need SESSIONS, and neither should force a visit to the Sitzungen view.
let _sessEnsure = null;
function ensureSessions() {
  if (SESSIONS_LOADED) return Promise.resolve(SESSIONS);
  if (!_sessEnsure) {
    _sessEnsure = api('/api/sessions')
      .then((r) => { SESSIONS = r.sessions || []; SESSIONS_LOADED = true; refreshCwdList(); return SESSIONS; })
      .catch(() => { _sessEnsure = null; return SESSIONS; }); // allow a later retry, stay silent (background load)
  }
  return _sessEnsure;
}
function sessionItemEl(s) {
  const item = el('div', 'session-item' + (SEL_MODE && SELECTED.has(s.id) ? ' selected' : '') + (s.id === OPEN_SESSION_ID ? ' active' : ''));
  item.dataset.id = s.id; item.dataset.project = s.project;
  if (SEL_MODE) {
    const cb = el('input', 'si-check'); cb.type = 'checkbox'; cb.checked = SELECTED.has(s.id);
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => toggleSelect(s.id, item, cb.checked);
    item.appendChild(cb);
  }
  const top = el('div', 'si-top');
  top.appendChild(el('span', 'si-proj', s.projectPath));
  const pc = sessProjChip(s); if (pc) top.appendChild(pc); // J5
  const star = iconBtn('si-star' + (s.favorite ? ' on' : ''), 'star', { title: s.favorite ? t('sessions.favoritEntfernen') : t('sessions.favorisieren'), onClick: (e) => { e.stopPropagation(); toggleFavorite(s); } });
  top.appendChild(star);
  top.appendChild(el('span', 'si-time', relTime(s.mtime)));
  item.appendChild(top);
  const prev = el('div', 'si-prev' + (s.customName ? ' named' : ''), s.title || s.preview || t('sessions.ohneTitel'));
  item.appendChild(prev);
  const meta = el('div', 'si-meta');
  meta.appendChild(el('span', null, s.messages + t('sessions.nachr')));
  meta.appendChild(el('span', 'si-spacer', (s.size / 1024).toFixed(0) + ' KB'));
  meta.appendChild(iconBtn('mini-btn si-ico', 'edit', { title: t('chat.umbenennen'), onClick: (e) => { e.stopPropagation(); renameSession(s); } }));
  const pb = iconBtn('mini-btn si-ico', 'project', { title: t('projects.siMenu'), onClick: (e) => { e.stopPropagation(); pickSessionProject([s.id], pb, s.projectId); } });
  meta.appendChild(pb);
  meta.appendChild(iconBtn('mini-btn si-ico si-del', 'trash', { title: t('sessions.sessionLoeschen'), onClick: (e) => { e.stopPropagation(); deleteSession(s); } }));
  meta.appendChild(iconBtn('mini-btn si-ico', 'fork', { title: t('sessions.forkNeueSessionAbzweigen'), onClick: (e) => { e.stopPropagation(); resumeSession(s, true); } }));
  meta.appendChild(iconBtn('mini-btn', 'play', { label: t('common.fortsetzen'), onClick: (e) => { e.stopPropagation(); resumeSession(s, false); } }));
  item.appendChild(meta);
  item.onclick = () => {
    if (SEL_MODE) { const cb = item.querySelector('.si-check'); cb.checked = !cb.checked; toggleSelect(s.id, item, cb.checked); }
    else openTranscript(s, item);
  };
  mkClickable(item, t('sessions.session-2') + (s.title || s.preview || s.id.slice(0, 8)));
  return item;
}
// A13: while filtering, #sessCount showed the UNFILTERED total — "37 Sitzungen" over a list of 3.
function updateSessCount(shown) {
  const total = SESSIONS.length;
  $('#sessCount').textContent = (shown != null && shown !== total) ? (shown + ' / ' + total + t('sessions.sessions')) : (total + t('sessions.sessions'));
}
async function renameSession(s) {
  const name = await uiPrompt(t('sessions.sessionUmbenennenLeerLassen'), s.customName ? s.title : '', { title: t('sessions.sessionUmbenennen'), okLabel: t('chat.umbenennen') });
  if (name === null) return;
  try {
    const r = await api('/api/session/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.id, name }) });
    toast(r.name ? t('sessions.umbenannt') : t('sessions.aufAutomatischenTitelZurueckgesetzt'), 'ok');
    await loadSessions();
    syncTabTitleFromSession(s.id, r.name); // keep an open tab for this session in sync (other rename direction)
  } catch (e) { toast(e.message, 'err'); }
}
// mirror of the tab→session rename (chat.js): when a session is renamed here, update any OPEN tab bound to
// it. `newName` = the server's stored name, or null/'' on reset-to-auto (then take the recomputed title).
function syncTabTitleFromSession(sessionId, newName) {
  if (typeof TABS === 'undefined' || !sessionId) return;
  const trunc = (v) => (v && v.length > 26 ? v.slice(0, 25) + '…' : v);
  const auto = newName ? null : ((SESSIONS || []).find((x) => x.id === sessionId) || {}).title || '';
  let hit = false;
  TABS.forEach((t) => {
    if ((t.sessionId || (t.pending && t.pending.sessionId)) !== sessionId) return;
    if (newName) { t.title = trunc(newName); t.manualTitle = true; }
    else { t.manualTitle = false; if (auto) t.title = trunc(auto); }
    hit = true;
  });
  if (hit && typeof renderTabs === 'function') { renderTabs(); if (typeof persistTabs === 'function') persistTabs(); }
}
async function deleteSession(s) {
  if (!(await uiConfirm(t('sessions.session') + (s.title || s.id.slice(0, 8)) + t('sessions.loeschenDasTranskriptWird'), { title: t('sessions.sessionLoeschen'), danger: true, okLabel: t('common.loeschen-2') }))) return;
  try {
    await api('/api/session/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: s.project, id: s.id }) });
    toast(t('sessions.sessionGeloeschtGesichert'), 'ok');
    if (OPEN_SESSION_ID === s.id) OPEN_SESSION_ID = null;
    $('#transcript').innerHTML = '<div class="empty-state small"><div class="empty-glyph">' + ic('inbox', 40) + '</div><p>' + t('sessions.waehleEineSessionUm') + '</p></div>';
    await loadSessions();
  } catch (e) { toast(e.message, 'err'); }
}
function renderSessions() {
  const q = $('#sessSearch').value.toLowerCase();
  const list = $('#sessionsList');
  const keepScroll = list.scrollTop; // A6: a favorite toggle must not jump the list back to the top
  list.innerHTML = '';
  list.classList.toggle('sel-mode', SEL_MODE);
  const filtered = visibleSessions();
  updateSessCount(filtered.length);
  const pf = sessProjFilterRow(); if (pf) list.appendChild(pf);
  const hid = SESS_PROJ_FILTER === 'all' ? sessHiddenCount(q) : 0;
  if (hid) list.appendChild(el('div', 'proj-hidden-hint', t('projects.ausgeblendetHinweis').replace('{n}', fmtInt(hid))));
  if (!filtered.length) {
    // a search that hides everything needs the way back, not just a verdict (B12)
    if ((q || SESS_PROJ_FILTER !== 'all') && typeof emptyFiltered === 'function') emptyFiltered(list, () => { $('#sessSearch').value = ''; SESS_PROJ_FILTER = 'all'; renderSessions(); });
    else list.appendChild(el('div', 'empty-mini', t('sessions.keinePassendenSessions')));
    return;
  }
  const favs = filtered.filter((s) => s.favorite);
  const rest = filtered.filter((s) => !s.favorite);
  if (favs.length) {
    list.appendChild(el('div', 'sess-group', t('common.favoriten')));
    favs.forEach((s) => list.appendChild(sessionItemEl(s)));
    if (rest.length) list.appendChild(el('div', 'sess-group', t('sessions.alleSessions')));
  }
  rest.forEach((s) => list.appendChild(sessionItemEl(s)));
  list.scrollTop = keepScroll;
}
async function toggleFavorite(s) {
  try {
    const r = await api('/api/favorites/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.id }) });
    s.favorite = r.favorite;
    renderSessions();
    toast(r.favorite ? t('sessions.favorisiert') : t('sessions.nichtMehrFavorisiert'), 'ok');
  } catch (e) { toast(e.message, 'err'); }
}
$('#sessSearch').addEventListener('input', debounce(renderSessions));
$('#sessReload').onclick = loadSessions;
// A14: cross-session full-text search existed (Strg+Shift+F) but was invisible from here — hand the
// current filter query straight to it, so "filter didn't find it" has an obvious next step.
if ($('#sessFulltext')) $('#sessFulltext').onclick = () => openGlobalSearch(($('#sessSearch').value || '').trim());

// ---- multi-select delete ----
function visibleSessions() {
  const q = $('#sessSearch').value.toLowerCase();
  return SESSIONS.filter((s) => sessionMatches(s, q, SESS_PROJ_FILTER));
}
function toggleSelect(id, item, on) {
  if (on) SELECTED.add(id); else SELECTED.delete(id);
  if (item) item.classList.toggle('selected', on);
  updateSelBar();
}
function updateSelBar() {
  const n = SELECTED.size;
  $('#selCount').textContent = n + t('sessions.ausgewaehlt');
  $('#selDelete').disabled = n === 0;
  const sp = sessSelProjectBtn(); sp.disabled = n === 0; sp.textContent = n ? t('projects.selProjekt').replace('{n}', fmtInt(n)) : t('projects.selProjektLeer');
  const selDelLbl = $('#selDelete').querySelector('.btxt'); if (selDelLbl) selDelLbl.textContent = n ? t('sessions.nLoeschen').replace('{n}', n) : t('sessions.auswahlLoeschen');
  const vis = visibleSessions();
  const all = vis.length > 0 && vis.every((s) => SELECTED.has(s.id));
  const some = vis.some((s) => SELECTED.has(s.id));
  const selAll = $('#selAll'); selAll.checked = all; selAll.indeterminate = !all && some;
}
function setSelMode(on) {
  SEL_MODE = on;
  if (!on) SELECTED.clear();
  $('#sessSelBar').classList.toggle('hidden', !on);
  $('#sessSelectBtn').classList.toggle('active', on);
  $('#sessSelectBtn').innerHTML = (on ? ic('close', 15) : ic('checkSquare', 15)) + ' <span class="btxt">' + (on ? t('sessions.auswahlBeenden') : t('html.auswaehlen')) + '</span>';
  renderSessions();
  updateSelBar();
}
// J5 — the bulk „Projekt…" for the selection, one POST; made here because index.html is another branch's ground
function sessSelProjectBtn() {
  let b = document.getElementById('selProject');
  if (b) return b;
  b = el('button', 'ghost-btn'); b.id = 'selProject'; b.type = 'button';
  b.onclick = () => { const ids = [...SELECTED]; if (ids.length) pickSessionProject(ids, b).then((ok) => { if (ok) setSelMode(false); }); };
  const del = $('#selDelete'); del.parentNode.insertBefore(b, del);
  return b;
}
$('#sessSelectBtn').onclick = () => setSelMode(!SEL_MODE);
$('#selCancel').onclick = () => setSelMode(false);
$('#selAll').onchange = (e) => {
  const on = e.target.checked;
  visibleSessions().forEach((s) => { if (on) SELECTED.add(s.id); else SELECTED.delete(s.id); });
  renderSessions(); updateSelBar();
};
$('#selDelete').onclick = async () => {
  const ids = [...SELECTED];
  if (!ids.length) return;
  if (!(await uiConfirm(t('sessions.confirmDeleteN').replace('{n}', ids.length), { title: t('sessions.sessionsLoeschen'), danger: true, okLabel: t('common.loeschen-2') }))) return;
  const targets = SESSIONS.filter((s) => SELECTED.has(s.id));
  let ok = 0, fail = 0, done = 0;
  const btn = $('#selDelete');
  // A15: write into .btxt only. The old code did btn.textContent = … which destroyed the icon+span
  // structure that updateSelBar() (and every later label update) relies on.
  const setLbl = (txt) => { const s = btn.querySelector('.btxt'); if (s) s.textContent = txt; else btn.textContent = txt; };
  btn.disabled = true; setLbl(t('sessions.loesche'));
  // A15: sequential deletes made 20 sessions feel like a hang — 4 in flight is fast without swamping
  // the local server (each delete moves a file into the backup dir).
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const s = targets[next++];
      try { await api('/api/session/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: s.project, id: s.id }) }); ok++; }
      catch { fail++; }
      done++; setLbl(t('sessions.loescheFortschritt').replace('{done}', done).replace('{n}', targets.length));
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));
  toast(t('sessions.nGeloeschtBackup').replace('{n}', ok) + (fail ? t('sessions.nFehlgeschlagen').replace('{n}', fail) : '') + ' ✓', fail ? 'err' : 'ok');
  setSelMode(false);
  if (SELECTED.has(OPEN_SESSION_ID) || ids.includes(OPEN_SESSION_ID)) OPEN_SESSION_ID = null;
  $('#transcript').innerHTML = '<div class="empty-state small"><div class="empty-glyph">≣</div><p>' + t('sessions.waehleEineSessionUm') + '</p></div>';
  await loadSessions();
};

// A4/A5: the viewer used to request the WHOLE transcript (no tail). On a 102 MB session that means the
// server parses every line into one unbounded event array and the view then builds 26 000+ divs — server
// and browser both stall for minutes. So: ask for a bounded tail, show the same truncation note the
// resume path uses, and put the unbounded load behind an explicit, size-aware confirm.
const TRANSCRIPT_TAIL = 400;
const TRANSCRIPT_TEXT_CAP = 8000; // per-event display cap: the server does not cap text on the tail=0 path
function fmtBytes(n) { n = Number(n) || 0; return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B'; }
function capForView(txt) { txt = String(txt == null ? '' : txt); return txt.length > TRANSCRIPT_TEXT_CAP ? txt.slice(0, TRANSCRIPT_TEXT_CAP) + '\n' + t('sessions.gekuerzt') : txt; }
// The „davon Subagenten" tooltip: one line per agent transcript, the workflow id in brackets where there
// is one. Its unit used to be a hardcoded German „Tokens" — in the English UI too. Named and at module
// level so it can be tested without a DOM (test/usage-notes.test.js).
function subAgentTooltip(agents) {
  return (agents || []).map((a) => a.agentId + (a.wf ? ' (' + a.wf + ')' : '') + ': ' + t('sessions.nTokens').replace('{n}', fmtNum(a.tokens))).join('\n');
}
async function openTranscript(s, item, opts) {
  opts = opts || {};
  OPEN_SESSION_ID = s.id; // A6: survive the next rerender
  $$('.session-item').forEach((i) => i.classList.toggle('active', i.dataset.id === s.id));
  if (item) item.classList.add('active');
  const tr = $('#transcript'); tr.innerHTML = '<div class="loading">' + t('sessions.transkriptWirdGeladen') + '</div>';
  try {
    const qs = (opts.full ? '' : 'tail=' + TRANSCRIPT_TAIL + '&') + 'project=' + encodeURIComponent(s.project) + '&id=' + encodeURIComponent(s.id);
    const r = await api('/api/transcript?' + qs);
    tr.innerHTML = '';
    const hdr = el('div');
    hdr.appendChild(Object.assign(el('h2'), { textContent: s.title || s.id.slice(0, 8), style: 'margin:0 0 3px;font-size:17px;' }));
    hdr.appendChild(Object.assign(el('div', 'si-proj'), { textContent: s.projectPath + '  ·  ' + s.id }));
    const btns = el('div'); btns.style.margin = '12px 0 0';
    const rb = iconBtn('primary-btn', 'play', { label: t('common.fortsetzen'), onClick: () => resumeSession(s, false) }); btns.appendChild(rb);
    const fb = iconBtn('ghost-btn', 'fork', { label: t('sessions.fork'), onClick: () => resumeSession(s, true) }); fb.style.marginLeft = '8px'; btns.appendChild(fb);
    const rnb = iconBtn('ghost-btn', 'edit', { label: t('chat.umbenennen'), onClick: () => renameSession(s) }); rnb.style.marginLeft = '8px'; btns.appendChild(rnb);
    const dlb = iconBtn('ghost-btn', 'trash', { label: t('common.loeschen-2'), onClick: () => deleteSession(s) }); dlb.style.marginLeft = '8px'; btns.appendChild(dlb);
    hdr.appendChild(btns);
    tr.appendChild(hdr);
    const m = r.meta || {};
    const money = (v) => (typeof fmtUSD === 'function' ? fmtUSD(v || 0) : '$' + (v || 0).toFixed(4));
    const meta = el('div', 't-meta');
    // Since PR-4 these numbers come from the SAME fold as the Usage view (deduped per answer, subagents
    // included) instead of from a second count of the same lines — so the tile and the Usage page can no
    // longer show two different figures for one session.
    const tiles = [[t('common.tokens'), fmtNum(m.tokens || 0)], [t('sessions.kostenEst'), money(m.cost)],
      [t('sessions.input'), fmtNum(m.input || 0)], [t('html.output'), fmtNum(m.output || 0)],
      [t('sessions.cacheRead'), fmtNum(m.cacheRead || 0)],
      // the majority model, with the others named in the tooltip — never the last frame that carried one
      [t('common.modell'), m.model || '—', (m.models || []).join(', ')],
      [t('sessions.deineTurns'), String(m.userTurns || 0)], [t('sessions.modellAufrufe'), String(m.messages || 0)]];
    // „davon Subagenten" — up to 70 % of a session's cost lives in its subagent transcripts, and the panel
    // did not read a single one of them before PR-4. Shown only where there are any.
    if (m.agentFiles > 0) tiles.push([t('sessions.davonSubagenten'), String(m.subMessages || 0) + ' · ' + money(m.subCost), subAgentTooltip(m.agents)]);
    tiles.push([t('sessions.gestartet'), m.firstTs ? new Date(m.firstTs).toLocaleString() : '—']);
    tiles.forEach(([k, v, title]) => { const it = el('div', 'tm-item'); it.appendChild(el('div', 'tm-k', k)); it.appendChild(el('div', 'tm-v', v)); if (title) it.title = title; meta.appendChild(it); });
    tr.appendChild(meta);
    // truncation note + the escape hatch, worded like the resume path's note
    if (r.truncated > 0) {
      const note = el('div', 'history-note', t('sessions.transkriptGekuerzt').replace('{n}', (r.events || []).length).replace('{t}', r.truncated));
      const more = el('button', 'ghost-btn t-loadall', t('sessions.transkriptVollstaendig'));
      more.onclick = async () => {
        const size = s.size ? fmtBytes(s.size) : t('sessions.unbekannt');
        if (!(await uiConfirm(t('sessions.transkriptVollstaendigFrage').replace('{size}', size).replace('{n}', r.truncated), { title: t('sessions.transkriptVollstaendigTitel'), danger: true, okLabel: t('sessions.transkriptVollstaendig') }))) return;
        openTranscript(s, item, { full: true });
      };
      note.appendChild(document.createTextNode(' '));
      note.appendChild(more);
      tr.appendChild(note);
    }
    for (const e of r.events) {
      // tools come as plain names on the tail=0 path and as { name, id, input } objects when a tail was
      // requested (lib/sessions.js passes withInputs = tail > 0) — handle both, never print [object Object]
      const toolNames = (e.tools || []).map((tl) => (tl && typeof tl === 'object') ? (tl.name || '?') : String(tl));
      const ev = el('div', 't-event t-' + e.kind);
      if (e.kind === 'summary') { ev.appendChild(el('div', 't-summary', '❝ ' + capForView(e.text))); }
      else {
        ev.appendChild(el('div', 't-role', e.kind === 'user' ? t('common.du') : e.kind === 'assistant' ? 'Claude' : e.kind));
        if (e.thinking) ev.appendChild(el('div', 't-tools', t('sessions.gedanke')));
        if (e.text) ev.appendChild(el('div', 't-body', capForView(e.text)));
        if (toolNames.length) ev.appendChild(el('div', 't-tools', '⚙ ' + toolNames.join(', ')));
        if (e.kind === 'tool_result') ev.appendChild(el('div', 't-tools', e.count + t('sessions.toolErgebnisSe')));
      }
      if (e.text || toolNames.length || e.kind === 'summary' || e.thinking || e.kind === 'tool_result') tr.appendChild(ev);
    }
  } catch (e) {
    // A9: an empty pane plus a dead toast used to be the whole error report
    errorCard(tr, t('sessions.transkriptFehler') + e.message, () => openTranscript(s, item, opts));
  }
}

async function resumeSession(s, fork) {
  $$('.nav-item').forEach((b) => b.classList.remove('active'));
  $('.nav-item[data-view="chat"]').classList.add('active');
  $$('.view').forEach((v) => v.classList.remove('active'));
  $('#view-chat').classList.add('active');
  // CHAT-FLOW-4 — the session is already open in a tab of THIS window: go there instead of resuming it a
  // second time (the second resume ended the first tab's process — or is now refused by the server, with a
  // card that would wrongly send you to „another tab or window" for a tab right next to it). Sitzungsliste,
  // palette, the usage table and offerLastSession all come through here. A fork is a new session: never asked.
  const open = !fork && typeof findSessionTab === 'function' ? findSessionTab(s.id) : null;
  if (open) { activateTab(open); toast(t('sessions.schonOffen'), 'ok'); return; }
  // reuse the active tab only while it is UNTOUCHED (chat.js tabUntouched), otherwise open a new one. „No id and
  // no rows" was not enough (P-0): a fresh tab with roots, an agent or an MCP scope set up for something else is
  // empty too, and the start body takes all of them off the tab — the resumed session would run with them.
  if (!tabUntouched(ACTIVE)) newTab();
  const tab = ACTIVE; // capture: the awaits below let the ACTIVE tab change under us
  setTabTitle(tab, s.title || s.id.slice(0, 8));
  $('#cwdInput').value = s.projectPath;
  // J6 (Julian, F1 a) — an EXPLICIT project's start values, copied visibly before the start; '' or no entry: none
  let took = null;
  if (!fork && s.projectId) {
    if (typeof ensureProjects === 'function') await ensureProjects();
    const p = typeof projById === 'function' ? projById(s.projectId) : null;
    if (p && tab === ACTIVE) took = { name: p.name, what: projectApplyOnResume(tab, p) };
  }
  try {
    await startChat({ resume: s.id, cwd: s.projectPath, fork: !!fork }, tab);
    if (took && took.what.length) toast(t('projects.resumeUebernommen').replace('{name}', took.name).replace('{what}', took.what.join(' · ')), 'ok');
    await renderResumeHistory(s, tab);
    toast((fork ? t('sessions.forkVon') : t('sessions.fortsetzenVon')) + s.id.slice(0, 8) + '… ' + (fork ? t('sessions.abzweigenUndFortfahren') : t('sessions.sendeEineNachrichtZum')), 'ok');
  } catch (e) {
    // held by another tab or window: startChat has put the card into the tab — ask about the takeover now,
    // since that is what the click was for; declined, the card stays and offers it again
    if (e && e.code === 'session-open-elsewhere' && typeof takeBackTab === 'function') {
      try { if (await takeBackTab(tab)) holdQueueAfterResume(tab); } catch (e2) { toast(t('sessions.fortsetzenFehlgeschlagen') + e2.message, 'err'); }
      return;
    }
    toast(t('sessions.fortsetzenFehlgeschlagen') + e.message, 'err');
  }
}
// Show the prior conversation in the chat window on resume/fork (the model
// already has full context via --resume; this is the visual transcript).
// `tab` is the OWNER of this transcript, passed explicitly by the resume/restart family. The `await` below
// yields the event loop, so the ACTIVE tab may change (a click, or a second resume) before it resolves — we
// therefore paint into `tab.msgEl` directly and re-assert the module-global `chat = tab` only around the
// SYNCHRONOUS paint (addMsg/addToolCard read that global), restoring it afterwards. This is what keeps a
// mid-flight tab switch from bleeding one session's transcript into another tab (and from leaving a black pane).
async function renderResumeHistory(s, tab) {
  tab = tab || chat;
  let r;
  try { r = await api('/api/transcript?tail=220&project=' + encodeURIComponent(s.project) + '&id=' + encodeURIComponent(s.id)); if (tab._resuming && typeof resumeStage === 'function') resumeStage(tab, 'paint'); }
  catch (e) {
    if (typeof hideResumeLoading === 'function') hideResumeLoading(tab); // also re-enables the composer (ToDo 01/04)
    // black-screen guard: startChat already emptied tab.msgEl, so a failed transcript fetch would leave a
    // blank pane. Restore a "history unavailable" note (the model still has full context via --resume) and,
    // if this tab is visible, un-hide the empty-state instead of showing nothing.
    // A transcript that is GONE ('transcript-missing') is not a failure to shout about: a restored tab
    // whose session file was deleted hit this on every reload and left a STICKY error toast (errors
    // wait for a click, see toast()) carrying a raw ENOENT with a full path. Say it plainly, once.
    const gone = /transcript-missing/.test(e.message || '');
    if (tab.msgEl && !tab.msgEl.childElementCount) {
      tab.msgEl.appendChild(el('div', 'history-note', gone ? t('sessions.verlaufExistiertNichtMehr') : t('sessions.verlaufKonnteNichtGeladen')));
    }
    toast(gone ? t('sessions.verlaufExistiertNichtMehr') : (t('sessions.verlaufNichtLadbar') + e.message), gone ? 'warn' : 'err');
    return;
  }
  const events = r.events || [];
  // PF-1 — the plan as the server folded it out of the WHOLE transcript (not just this tail), adopted BEFORE the
  // paint: the ExitPlanMode history cards say where their plan stands, and a step's first report in the tail
  // becomes its jump target (planResumeMarks) — the same two things the live path does (chat-side.js).
  // …with the orphan under it and the newest proposal's name (PF-1b) — `undefined` from an older server keeps the tab's
  if (typeof planAdoptResumed === 'function') planAdoptResumed(tab, r.plan, { orphan: r.planOrphan, last: r.planLast });
  const planMarks = (typeof planResumeMarks === 'function') ? planResumeMarks(tab, events) : new Map();
  const cardById = {}; // tool_use_id -> tool card, to attach outputs
  let firstUserText = ''; // fallback title source for a resumed chat that never got one (ToDo: reload → "Neuer Chat")
  for (const e of events) if (e.kind === 'user' && e.text && e.text.trim()) { firstUserText = e.text.trim(); break; }
  // open points of THIS tab that got their live card back in this paint (see below) — a Set rather than a DOM
  // query, because the older slices paint into a detached box the query would not see
  const liveCarded = new Set();
  // paint ONE transcript event into the ambient render target. `silent` (all historical cards) skips the
  // per-card steps repaint, the per-card scroll and the per-line word-diff DP — see addToolCard/addToolOutput.
  const paintEvent = (e) => {
    if (e.kind === 'user' && e.text && e.text.trim()) addMsg('user', e.text, { ts: e.ts, hist: true, injected: !!e.injected });
    else if (e.kind === 'assistant') {
      // skip thinking-only / empty — but NOT a row that carries a stop reason worth a banner. A refusal
      // RETRACTS the text it had already streamed („Wire uuids of the already-streamed messages this
      // refusal concerns"), so the row that most needs the „Antwort verweigert" line is exactly the one
      // with no text and no tools. Returning ahead of the banner meant the one end reason that survives a
      // reload at all was carried through lib/sessions and then dropped at the very last step.
      // (30 % of the assistant rows in this machine's corpus — 16 762 of 56 612 — take this early exit.)
      if (!e.text.trim() && !(e.tools && e.tools.length) && !e.stopReason) return;
      const { b } = addMsg('assistant', '', { ts: e.ts, hist: true });
      // PF-1 — the ```plan-status reports leave the text as they do live (takePlanStatus). Their state is in
      // tab.plan already — the server folded them — so here they are only cut out; the message a step was first
      // reported in becomes its jump target, as it would have been live. A block that is not JSON stays readable
      // (planStatusStrip's rule), and a message that was nothing else is hidden like a live one (.only-status).
      const text = (e.text.indexOf('```plan-status') >= 0 && typeof planStatusStrip === 'function') ? planStatusStrip(e.text) : e.text;
      const lifted = text !== e.text;
      const marks = planMarks.get(e);
      if (marks && b.parentElement) { tab._planRows = tab._planRows || {}; marks.forEach((id) => { tab._planRows[id] = b.parentElement; }); }
      // D2 — a resumed transcript carries the raw ```offene-punkte``` JSON just like a live turn does.
      // Strip it and paint the same card, in history mode: readable, but it does not re-open questions
      // in the rail (a point from three days ago has usually answered itself) and sends nothing.
      if (text.trim()) {
        const stripped = (typeof openPointsStrip === 'function') ? openPointsStrip(text) : text;
        setAssistantText(b, stripped);
        if (stripped !== text && typeof addOpenPointsCard === 'function') {
          // …except a point that is still OPEN on this tab: a restart/resume repaints the very transcript the
          // tab's questions came from, and as a history card it lost its id — the rail row had nothing to jump
          // to and the card could not answer it. That one gets its live card back (once: the newest
          // occurrence, the head is painted first); everything else stays a record.
          const live = [], past = [];
          openPointsExtract(text).forEach((f) => {
            const p = (tab.openPoints || []).find((o) => o && !o.done && o.id && openPointKey(o) === openPointKey(f));
            if (p && !liveCarded.has(p.id)) { liveCarded.add(p.id); live.push(p); } else past.push(f);
          });
          if (live.length) addOpenPointsCard(b, tab, live, {});
          if (past.length) addOpenPointsCard(b, tab, past, { history: true });
        }
      } else b.style.display = 'none';
      let toolCards = 0, planCards = 0;
      (e.tools || []).forEach((tl) => {
        // PF-1 — an ExitPlanMode is a plan, not a tool call: a record card with title, outcome and state instead
        // of an 8000-character JSON fragment (the server sends {title, file, chars} for it, lib/sessions tailTool).
        // An older server still sends the capped input — that one keeps the generic card.
        if (tl && tl.name === 'ExitPlanMode' && tl.plan && typeof addPlanHistoryCard === 'function') {
          const card = addPlanHistoryCard(b, tab, tl);
          if (card) { planCards++; cardById[tl.id] = card; }
          return;
        }
        toolCards++;
        const card = addToolCard(b, tl.name, tl.input, { silent: true }); if (card && tl.id) cardById[tl.id] = card;
      });
      // Same rule as the live pump: a row whose only content is tool cards must go with them when the
      // tool display is off, instead of standing there as a bare „Claude" head. A resumed transcript
      // holds no thinking blocks, so only the tools half applies here — plus the status-only row (PF-1),
      // and a plan card counts as content that no display switch hides.
      if (!text.trim() && (toolCards || lifted) && typeof markHideableRow === 'function') {
        markHideableRow(b, { text: '', thinking: '', tools: toolCards, status: lifted, other: planCards });
      }
      // G2 — the one end reason a RELOAD does not lose (lib/sessions carries it; see turn-end.js for why
      // the others are irreversibly gone). Without this row a resumed tab shows a truncated answer as a
      // finished one — i.e. exactly half of this PR would be invisible after every browser reload.
      const sb = (typeof turnEndStopBanner === 'function') ? turnEndStopBanner(e.stopReason) : null;
      if (sb) addMsg('system', '⚠ ' + t(sb.key) + ' (' + sb.raw + ')', { error: true, ts: e.ts, hist: true });
    } else if (e.kind === 'tool_result' && Array.isArray(e.results)) {
      e.results.forEach((rr) => {
        const card = rr.tool_use_id && cardById[rr.tool_use_id];
        if (!card) return;
        // the answer an ExitPlanMode got (approved / „Weiter planen" + feedback) belongs into its plan card (PF-1)
        if (card.classList && card.classList.contains('plan-hist')) { if (typeof planHistoryCardResult === 'function') planHistoryCardResult(tab, card, rr.text); return; }
        if (rr.text && rr.text.trim()) addToolOutput(card, rr.text, rr.is_error, { silent: true });
      });
    }
  };
  // P4: this loop used to paint up to 220 events SYNCHRONOUSLY — each with a markdown render and, per Edit
  // card, a per-line word-diff DP — blocking the main thread for seconds while the loader looked frozen. Paint
  // the newest ~30 now (that's what the user reads), then fill in the rest in idle slices. The split is aligned
  // on a turn boundary so no tool_use/tool_result pair straddles it (the card lookup would miss).
  const gen = tab._resumeGen = (tab._resumeGen || 0) + 1;
  const HEAD = 30;
  let cut = Math.max(0, events.length - HEAD);
  for (let k = 0; cut > 0 && k < 60 && events[cut].kind !== 'user'; k++) cut--;
  const older = events.slice(0, cut), head = events.slice(cut);
  const realHost = tab.msgEl;
  const saved = chat; chat = tab; // re-assert the ambient render target for the synchronous paint below
  try {
    if (tab === ACTIVE) $('#chatEmpty').classList.add('hidden');
    realHost.innerHTML = '';
    if (r.truncated > 0 && !older.length) realHost.appendChild(el('div', 'history-note', t('sessions.fruehereNachrichtenAusgeblendetVollstaendige')));
    head.forEach(paintEvent);
    realHost.appendChild(el('div', 'history-sep', t('sessions.fortsetzungNeueNachrichtenErscheinen')));
    // a resumed chat that never got a title (e.g. first message was attachment-only, or started outside the panel)
    // would otherwise show "Neuer Chat" after a reload — derive one from its first user message
    if (firstUserText && !tab.manualTitle && isDefaultTitle(tab)) setTabTitle(tab, firstUserText);
  } finally { chat = saved; }
  if (typeof hideResumeLoading === 'function') hideResumeLoading(tab); // newest messages are up → composer usable (ToDo 01/04)
  // pin the resumed transcript to the newest message: force-scroll after layout settles (ToDo 03)
  if (tab === ACTIVE) { tab.stick = true; requestAnimationFrame(() => { if (tab === ACTIVE) scrollBottom(true); }); }
  if (older.length) paintOlderSlices(tab, realHost, older, paintEvent, gen, r.truncated);
  if (typeof renderSteps === 'function') renderSteps();
}
// The older part is painted between frames into a DETACHED host and inserted above the newest messages in ONE
// DOM operation, so nothing jumps while it fills and the scroll position stays put. A newer resume/start bumps
// tab._resumeGen, which stops a stale filler. (P4)
function paintOlderSlices(tab, realHost, older, paintEvent, gen, truncated) {
  const box = el('div', 'history-older');
  const SLICE = 8;
  let i = 0;
  const next = window.requestIdleCallback ? (fn) => window.requestIdleCallback(fn, { timeout: 150 }) : (fn) => requestAnimationFrame(fn);
  const step = () => {
    if (tab._resumeGen !== gen || !realHost.isConnected) return; // superseded (or the tab was closed)
    const end = Math.min(older.length, i + SLICE);
    // addMsg/addToolCard append to `chat.msgEl` → point the tab's host at the detached box for this slice only
    tab.msgEl = box;
    try { withTab(tab, () => { for (; i < end; i++) paintEvent(older[i]); }); }
    finally { tab.msgEl = realHost; }
    if (i < older.length) { next(step); return; }
    if (truncated > 0) box.insertBefore(el('div', 'history-note', t('sessions.fruehereNachrichtenAusgeblendetVollstaendige')), box.firstChild);
    const wasBottom = tab.stick;
    realHost.insertBefore(box, realHost.firstChild);
    if (tab === ACTIVE && wasBottom) scrollBottom(true);
  };
  next(step);
}


// ============================================================
//  PROJEKT-ZUORDNUNG (Projekte, Stufe 2 — J1/J4/J5/J6)
// ============================================================
// One implementation for the tab menu (chat.js openTabMenu), the status chip (chat-status.js) and the sessions
// list. A label is only ever written by a click (POST /api/projects/assign) or by a start that named the project
// (J1); nothing here assigns by itself. pid: 'p-…' = project · '' = deliberately none · null = never decided.
let SESS_PROJ_FILTER = 'all'; // 'all' | 'none' | 'p-…'
function sessProjName(pid) {
  const p = typeof projById === 'function' ? projById(pid) : null;
  if (p) return p.name;
  // N3 — „deleted" only once the list has loaded; while it loads the label is unknown, not gone
  return (typeof PROJECTS_DATA !== 'undefined' && PROJECTS_DATA) ? t('projects.chipGeloescht') : '…';
}
// J14 — the project a row is listed under: the explicit label, else a folder rule (projectDerived) where nothing was
// decided ('' = deliberately none blocks the rule). A rule is a label only — it never sets a start value (J6).
function sessProjOf(s) {
  if (s.projectId) return { pid: s.projectId, derived: false };
  if (typeof s.projectId !== 'string' && typeof s.projectDerived === 'string' && s.projectDerived) return { pid: s.projectDerived, derived: true };
  return null;
}
function sessHiddenInAll(s) {
  const o = sessProjOf(s); const p = o && typeof projById === 'function' ? projById(o.pid) : null;
  return !!(p && p.hideInAll);
}
// how many rows „Alle" leaves out for hideInAll (the search still applies — the hint counts what it would show)
function sessHiddenCount(q) {
  return SESSIONS.filter((s) => sessHiddenInAll(s) && sessionMatches(s, q, sessProjOf(s).pid)).length;
}
// the ONE filter for the list, the count, „Alle" and the bulk actions (it was two copies of the same expression)
function sessionMatches(s, q, pf) {
  pf = pf || 'all';
  const own = sessProjOf(s); const pid = own ? own.pid : '';
  if (pf === 'all' && pid && sessHiddenInAll(s)) return false;
  if (pf === 'none' && pid) return false;
  if (pf !== 'all' && pf !== 'none' && pid !== pf) return false;
  if (!q) return true;
  const pn = pid ? sessProjName(pid) : '';
  return ((s.title || '') + (s.preview || '') + (s.summary || '') + (s.projectPath || '') + s.id + ' ' + pn).toLowerCase().includes(q);
}
// The chip in si-top: solid = assigned, dashed = deliberately none (''), nothing = never decided (null).
function sessProjChip(s) {
  const own = sessProjOf(s);
  if (own && own.derived) { // J14: dashed and said in words — a rule counted it, nobody assigned it
    const dn = sessProjName(own.pid);
    const c = el('span', 'proj-si-chip derived', '◆ ' + dn + ' · ' + t('projects.siPerRegel'));
    c.title = t('projects.siPerRegelTitel').replace('{name}', dn);
    return c;
  }
  if (typeof s.projectId !== 'string') return null;
  if (!s.projectId) { const c = el('span', 'proj-si-chip none', t('projects.siOhne')); c.title = t('projects.siOhneTitel'); return c; }
  const name = sessProjName(s.projectId);
  const c = el('span', 'proj-si-chip', '◆ ' + name);
  c.title = t('projects.siChipTitel').replace('{name}', name);
  return c;
}
// Filter chips: Alle · each project that labels a listed session · Ohne Projekt. Rebuilt with the list; the caret
// goes back to the chip that was pressed (the row is new).
function sessProjFilterRow() {
  const used = [...new Set(SESSIONS.map((s) => (sessProjOf(s) || {}).pid).filter(Boolean))];
  if (!used.length && SESS_PROJ_FILTER === 'all') return null;
  const row = el('div', 'proj-filter'); row.setAttribute('role', 'group'); row.setAttribute('aria-label', t('projects.filterLabel'));
  const chip = (key, label) => {
    const b = el('button', 'proj-filter-chip' + (SESS_PROJ_FILTER === key ? ' on' : ''), label);
    b.type = 'button'; b.dataset.pf = key; b.setAttribute('aria-pressed', String(SESS_PROJ_FILTER === key));
    b.onclick = () => { SESS_PROJ_FILTER = key; renderSessions(); const n = document.querySelector('.proj-filter-chip[data-pf="' + key + '"]'); if (n) n.focus(); };
    row.appendChild(b);
  };
  chip('all', t('projects.filterAlle'));
  used.forEach((pid) => chip(pid, '◆ ' + sessProjName(pid)));
  if (SESS_PROJ_FILTER !== 'all' && SESS_PROJ_FILTER !== 'none' && !used.includes(SESS_PROJ_FILTER)) chip(SESS_PROJ_FILTER, '◆ ' + sessProjName(SESS_PROJ_FILTER));
  chip('none', t('projects.filterOhne'));
  return row;
}

// The popover: the active projects + „Ohne Projekt". On the overlay stack (Esc); Esc or a pick hands the caret
// back to `returnTo` — the menu item that opened it is gone by then (WCAG 2.4.3). Resolves the pick ('p-…' | '')
// or undefined when closed without one.
function openProjectPicker(o) {
  o = o || {};
  const old = document.getElementById('projPicker'); if (old) old.remove();
  return Promise.resolve(typeof ensureProjects === 'function' ? ensureProjects() : null).then(() => new Promise((resolve) => {
    const m = el('div', 'ctx-menu proj-pop'); m.id = 'projPicker';
    m.setAttribute('role', 'menu'); m.setAttribute('aria-label', o.title || t('projects.popTitel'));
    m.appendChild(el('div', 'ctx-head', o.title || t('projects.popTitel')));
    let release = null, done = false, outside = null;
    const close = (v) => {
      if (done) return; done = true;
      if (release) release();
      if (outside) document.removeEventListener('mousedown', outside);
      m.remove();
      if (o.returnTo && typeof o.returnTo.focus === 'function' && o.returnTo.isConnected !== false) { try { o.returnTo.focus(); } catch { /* */ } }
      resolve(v);
    };
    const items = [];
    const item = (label, v) => {
      const cur = o.current === v;
      const b = el('div', 'ctx-item' + (cur ? ' cur' : ''), (cur ? '✓ ' : '') + label);
      b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', String(cur)); b.tabIndex = -1;
      b.onclick = (e) => { if (e && e.stopPropagation) e.stopPropagation(); close(v); };
      b.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); close(v); } };
      items.push(b); m.appendChild(b);
    };
    const list = ((typeof PROJECTS_DATA !== 'undefined' && PROJECTS_DATA) || []).filter((p) => !p.archived || p.id === o.current);
    if (!list.length) m.appendChild(el('div', 'ctx-item disabled', t('projects.popKeine')));
    list.forEach((p) => item('◆ ' + p.name, p.id));
    m.appendChild(el('div', 'ctx-sep'));
    item(t('projects.siOhne'), '');
    m.onkeydown = (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement);
      const n = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1) + items.length) % items.length];
      if (n) n.focus();
    };
    document.body.appendChild(m);
    if (typeof positionMenuAt === 'function') positionMenuAt(m, o.anchor || null);
    if (typeof overlayPush === 'function') release = overlayPush(m, { onEsc: () => close(undefined), restoreFocus: false, trap: false });
    outside = (e) => { if (!m.contains(e.target)) close(undefined); };
    setTimeout(() => { if (!done) document.addEventListener('mousedown', outside); }, 0);
    const first = items.find((b) => b.classList.contains('cur')) || items[0];
    if (first) first.focus();
  }));
}
// ONE POST for every id (the route takes up to 500). Mirrors the answer into every copy of the session list the
// panel keeps, and into the open tabs of those sessions — in memory only (persisting is J7, after PR-15b).
async function assignSessionsToProject(ids, pid) {
  ids = (ids || []).filter(Boolean);
  if (!ids.length) return false;
  await api('/api/projects/assign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionIds: ids, projectId: pid }) });
  const hit = (id) => ids.some((x) => String(x).toLowerCase() === String(id).toLowerCase());
  (SESSIONS || []).forEach((s) => { if (hit(s.id)) s.projectId = pid; });
  if (typeof PROJ_SESSIONS !== 'undefined' && PROJ_SESSIONS) PROJ_SESSIONS.forEach((s) => { if (hit(s.id)) s.projectId = pid; });
  if (typeof PROJ_ASSIGNED !== 'undefined') ids.forEach((id) => { if (pid) PROJ_ASSIGNED.set(String(id).toLowerCase(), pid); else PROJ_ASSIGNED.delete(String(id).toLowerCase()); });
  if (typeof TABS !== 'undefined') TABS.forEach((tb) => { const sid = tb.sessionId || (tb.pending && tb.pending.sessionId); if (sid && hit(sid)) tb.projectId = pid; });
  return true;
}
// „when does it act" — computed ONCE (at the start, at an assign), never in renderStatusBar (chat.js promptSnapshotFresh)
function projectEffectKey(fresh) { return fresh === true ? 'projects.anweisungenWirkStart' : fresh === false ? 'projects.anweisungenWirkNeu' : 'projects.anweisungenWirkUnbelegt'; }
// The start's answer (chat-events.js startChat): what the process RUNS with — the base of „geändert seit Start".
function projectAdoptStart(tab, r, fresh) {
  if (!r || !Object.prototype.hasOwnProperty.call(r, 'project')) return; // an older server says nothing
  const p = r.project;
  if (p && p.id) { tab.projectId = p.id; tab._projectRun = p.id; tab._projectAt = Number(p.updatedAt) || 0; tab._projectName = p.name || ''; }
  else { tab._projectRun = ''; tab._projectAt = null; if (!(fresh && tab.projectId === '')) tab.projectId = undefined; }
  tab._projectNote = null;
  if (r.projectError) toast(t('projects.startSpeicherFehler') + r.projectError, 'warn');
  if (p && p.id && typeof promptSnapshotFresh === 'function') {
    promptSnapshotFresh().then((v) => { tab._projectNote = projectEffectKey(v); }).catch(() => {});
  }
}
// J4 — the tab menu's / status chip's pick. Unstarted: only the tab's value (it goes with the start). Started: the
// session's label, and the running process restarts to take it — after asking, because a restart rewrites the whole
// context into the prompt cache (critic N7).
async function assignTabProject(tab, pid) {
  if (pid === undefined || pid === tab.projectId) return;
  const name = pid ? sessProjName(pid) : '';
  const sid = tab.sessionId || (tab.pending && tab.pending.sessionId);
  if (!sid) {
    if (tab.id || tab._starting) { toast(t('projects.tabKeineId'), 'warn'); return; }
    tab.projectId = pid;
    toast(pid ? t('projects.tabGiltBeimStart').replace('{name}', name) : t('projects.tabOhneBeimStart'), 'ok');
    if (tab === ACTIVE && typeof renderStatusBar === 'function') renderStatusBar();
    return;
  }
  try { await assignSessionsToProject([sid], pid); } catch (e) { toast(e.message, 'err'); return; }
  const fresh = typeof promptSnapshotFresh === 'function' ? await promptSnapshotFresh() : null;
  tab._projectNote = projectEffectKey(fresh);
  if (tab === ACTIVE && typeof renderStatusBar === 'function') renderStatusBar();
  const what = pid ? t('projects.zugeordnet').replace('{name}', name) : t('projects.tabOhneGesetzt');
  if (!tab.id) { toast(what + ' — ' + t(tab._projectNote), 'ok'); return; } // dormant: its next start is the resume
  const n = Number(tab.ctxTokens) || 0;
  const ok = await uiConfirm(t('projects.neustartFrage') + ' ' + (n ? t('projects.neustartKosten').replace('{n}', fmtInt(n)) : t('projects.neustartKostenOhneZahl')), {
    title: t('projects.neustartTitel'), okLabel: t('projects.neustartJetzt'), cancelLabel: t('projects.neustartSpaeter'),
  });
  if (!ok) { toast(what + ' — ' + t(tab._projectNote), 'ok'); return; }
  if (typeof restartWhenIdle === 'function') await restartWhenIdle(tab, t('projects.neustartGrund'), t('projects.neustartFertig'));
}
function openTabProjectPicker(tab, anchor) {
  const at = anchor || tab.tabEl || null;
  return openProjectPicker({ anchor: at, returnTo: at, current: tab.projectId })
    .then((pid) => (pid === undefined ? undefined : assignTabProject(tab, pid)));
}
// J5 — „Projekt…" on one session, and the bulk version for the selection (one POST)
async function pickSessionProject(ids, anchor, current) {
  const pid = await openProjectPicker({ anchor, returnTo: anchor, current, title: ids.length > 1 ? t('projects.popTitelN').replace('{n}', fmtInt(ids.length)) : undefined });
  if (pid === undefined) return false;
  try { await assignSessionsToProject(ids, pid); }
  catch (e) { toast(e.message, 'err'); return false; }
  toast(pid ? t('projects.massZugeordnet').replace('{n}', fmtInt(ids.length)).replace('{name}', sessProjName(pid)) : t('projects.massOhne').replace('{n}', fmtInt(ids.length)), 'ok');
  renderSessions();
  return true;
}
// J6 — resuming a session with an EXPLICIT project copies its start values into the tab, visibly (selectors, tab
// menu) and before the start: extra folders, agent, model, effort, mode. Never the cwd (the session's folder),
// never the MCP scope (the session's stored choice), never a bypass mode (projectStartValues filters it).
// -> the list of what was taken over (for the toast), [] when nothing.
function projectApplyOnResume(tab, p) {
  if (!p || typeof projectStartValues !== 'function') return [];
  const sv = projectStartValues(p, { resume: true, posix: typeof projPosix === 'function' ? projPosix() : undefined });
  const took = [];
  const dom = tab === ACTIVE;
  // what the project leaves open stays what the selectors show now — the start reads them from there
  if (dom) { tab.modelSel = $('#modelSel').value; tab.effort = $('#effortSel').value; tab.permissionMode = $('#permMode').value; }
  if (sv.addDirs.length) { tab.addDirs = sv.addDirs.slice(); took.push(t('projects.uebAddDirs').replace('{n}', fmtInt(sv.addDirs.length))); }
  if (sv.agent) { tab.agent = sv.agent; took.push(t('projects.uebAgent').replace('{v}', sv.agent)); }
  if (sv.model && !(typeof projModelBlocked === 'function' && projModelBlocked(sv.model))) { tab.modelSel = sv.model; took.push(t('projects.uebModell').replace('{v}', sv.model)); }
  if (sv.effort) { tab.effort = sv.effort; took.push(t('projects.uebAufwand').replace('{v}', sv.effort)); }
  if (sv.permissionMode) { tab.permissionMode = sv.permissionMode; took.push(t('projects.uebModus').replace('{v}', typeof projModeLabel === 'function' ? projModeLabel(sv.permissionMode) : sv.permissionMode)); }
  tab.cfgTouched = true;
  tab.projectId = p.id;
  if (dom && typeof syncRunSelectors === 'function') syncRunSelectors(tab);
  if (dom && typeof renderStatusBar === 'function') renderStatusBar();
  return took;
}
