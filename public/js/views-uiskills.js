// Part of the Claude Code Control Panel front-end (split from app.js).
// Classic scripts share one global scope; load order in index.html is authoritative: render → chat → sessions → views → commands → boot.
// This file: views-uiskills.js

// ============================================================
//  UI SKILLS  (GUI-driven skills — a ```ui-skill JSON block in a command .md)
// ============================================================
const UI_BLOCK_RE = /```ui-skill\s*\n([\s\S]*?)\n```/;
// field types that carry an options[] list (used by builder + lint)
const OPTION_FIELD_TYPES = ['select', 'radio', 'tree', 'multiselect'];
// insert or replace the ui-skill block inside the skill body, preserving prose
function serializeSkillMd(body, manifest) {
  const block = '```ui-skill\n' + JSON.stringify(manifest, null, 2) + '\n```';
  const src = String(body || '');
  if (UI_BLOCK_RE.test(src)) return src.replace(UI_BLOCK_RE, block);
  return src.replace(/\s*$/, '') + '\n\n' + block + '\n';
}
// The prompt composer (uiFlattenOptions · uiRenderInputValue · uiExcludedValue · uiInterpolate ·
// uiComposePrompt) lives in public/js/ui-skill-prompt.js and is shared with the headless engine. This
// file used to carry its own copy of all five, and the copies drifted on ONE line — the boolean label —
// so the same skill sent a different PROMPT from an English panel than the scheduler sent from cron.
// Rule for every call site below: a PROMPT (or a preview/guard-scan of one) passes NO labels, so it
// reads 'Ja'/'Nein' whatever the panel language is — the model reads it next to the manifest's German
// promptTemplate. Only text a HUMAN reads passes UI_YESNO_LABELS(). A function, not a constant: the
// language can be switched while the panel runs.
function UI_YESNO_LABELS() { return { yes: t('chat-render.ja'), no: t('chat-render.nein') }; }

// The generic dialogs — uiModal/uiConfirm/uiAlert/uiPrompt — stood HERE until C3 and are now in
// public/js/dialogs.js. They never belonged to this view; this file is only their loudest CALLER. What
// stayed are the dialogs that carry UI-skill knowledge (the skill form, the file picker, the two skill
// pickers), and uiEditPromptModal below is now a single uiModal call rather than a fourth copy of one.

// --- shared skill favorites (Skills + UI Skills views, keyed by command/skill name) ---
let SKILL_FAVS = new Set();
async function loadSkillFavs() { try { const j = await api('/api/skill-favorites'); SKILL_FAVS = new Set(j.favorites || []); } catch { SKILL_FAVS = new Set(); } }
function isFav(name) { return SKILL_FAVS.has(name); }
async function toggleSkillFav(name) { try { const r = await api('/api/skill-favorites/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); if (r.favorite) SKILL_FAVS.add(name); else SKILL_FAVS.delete(name); return r.favorite; } catch (e) { toast(e.message, 'err'); return isFav(name); } }
function starBtn(name, after) { return iconBtn('fav-star' + (isFav(name) ? ' on' : ''), 'star', { title: isFav(name) ? t('views-uiskills.favoritEntfernen') : t('views-uiskills.alsFavorit'), onClick: async (e) => { e.stopPropagation(); await toggleSkillFav(name); if (after) after(); } }); }

// --- list + panel shell ---
let UISKILLS_DATA = null, UISKILL_SEL = null, UISKILL_TAB = 'run';

// → true when the list (and with it the panel) was re-read and re-rendered. BUILDER-1: the callers after a save
// render the panel themselves when this failed — the panel would otherwise go on showing the tab it showed before.
async function loadUiSkills() {
  const list = $('#uiskillList'); list.innerHTML = '<div class="loading">' + t('common.lade') + '</div>';
  try {
    const [j] = await Promise.all([api('/api/uiskills'), loadSkillFavs()]);
    UISKILLS_DATA = j.skills || [];
    // keep the current selection fresh (manifest may have changed) — or, if it left the list while its draft is
    // open, an orphan that keeps the draft reachable (uiSkillSelFresh)
    if (UISKILL_SEL) UISKILL_SEL = uiSkillSelFresh(UISKILL_SEL);
    renderUiSkillList();
    renderUiSkillPanel();
    return true;
  } catch (e) {
    // was: a 4-second toast and then an empty column with no explanation — the only view without an
    // error state (B11). Now it says what failed and offers the retry, like every other view.
    toast(e.message, 'err');
    if (typeof errorCard === 'function') errorCard('#uiskillList', e.message, () => loadUiSkills());
    else $('#uiskillList').innerHTML = '';
    return false;
  }
}
// BUILDER-1 — the selection after a list read. A skill that is no longer listed (deleted, or its ui-skill block no
// longer parses) used to drop the panel to the cockpit — and an open draft of it out of reach, still „unsaved" for
// beforeunload but nowhere to be seen. With a draft it stays selected as an ORPHAN: the edit tab only, and the
// builder says what is known about the file (paintBuilderFileNote). Without a draft there is nothing to keep.
function uiSkillSelFresh(sel) {
  const found = (UISKILLS_DATA || []).find((s) => s.name === sel.name) || null;
  if (BUILDER && BUILDER.name === sel.name) BUILDER.missing = !found;
  if (found || !builderDirty() || BUILDER.name !== sel.name) return found;
  return { name: sel.name, description: '', manifest: JSON.parse(BUILDER.saved), orphan: true };
}

function renderUiSkillList() {
  if (!UISKILLS_DATA) return;
  const q = ($('#uiskillSearch').value || '').toLowerCase();
  let items = UISKILLS_DATA.filter((s) => !q || (s.name + ' ' + (s.manifest.title || '') + ' ' + (s.description || '')).toLowerCase().includes(q));
  items = items.slice().sort((a, b) => {
    const fa = isFav(a.name), fb = isFav(b.name);
    if (fa !== fb) return fa ? -1 : 1;
    if ((b.lastRun || 0) !== (a.lastRun || 0)) return (b.lastRun || 0) - (a.lastRun || 0);
    return (a.manifest.title || a.name).localeCompare(b.manifest.title || b.name);
  });
  $('#uiskillsCount').textContent = UISKILLS_DATA.length + (UISKILLS_DATA.length === 1 ? ' Skill' : ' Skills');
  const list = $('#uiskillList'); list.innerHTML = '';
  list.appendChild(uiListCollapseBar());
  if (!items.length) {
    // Distinguish "nothing exists yet" from "your search hides everything" (B12) — the second one used
    // to show the create-a-skill hint, which is both wrong and a dead end.
    list.innerHTML = '';
    if (q && typeof emptyFiltered === 'function') emptyFiltered(list, () => { $('#uiskillSearch').value = ''; renderUiSkillList(); });
    else list.innerHTML = '<div class="empty-mini">' + t('views-uiskills.keineUiSkillsErstelle') + '</div>';
    return;
  }
  const favs = items.filter((s) => isFav(s.name)), rest = items.filter((s) => !isFav(s.name));
  if (favs.length) { list.appendChild(el('div', 'sess-group', t('common.favoriten'))); favs.forEach((s) => list.appendChild(uiSkillListItem(s))); }
  if (rest.length) { if (favs.length) list.appendChild(el('div', 'sess-group', t('common.alle'))); rest.forEach((s) => list.appendChild(uiSkillListItem(s))); }
  const layout = document.querySelector('#view-uiskills .uiskill-layout');
  if (layout) { layout.classList.toggle('list-collapsed', uiListCollapsed()); uiListApplyWidth(); }
}
// draggable splitter between list and content; width is remembered (double click resets)
function uiListApplyWidth() {
  const layout = document.querySelector('#view-uiskills .uiskill-layout');
  if (!layout) return;
  const w = uiPrefsGet('cc_uiskills_prefs').listWidth;
  if (typeof w === 'number' && w >= 180 && w <= 640) layout.style.setProperty('--uiskill-list-w', w + 'px');
  else layout.style.removeProperty('--uiskill-list-w');
}
function initUiSkillSplitter() {
  const sp = $('#uiskillSplitter');
  const layout = document.querySelector('#view-uiskills .uiskill-layout');
  if (!sp || !layout || sp._wired) return;
  sp._wired = true;
  const setW = (px) => { const w = Math.max(180, Math.min(640, Math.round(px))); const p = uiPrefsGet('cc_uiskills_prefs'); p.listWidth = w; uiPrefsSet('cc_uiskills_prefs', p); layout.style.setProperty('--uiskill-list-w', w + 'px'); };
  sp.onmousedown = (e) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = $('#uiskillList').getBoundingClientRect().width;
    document.body.classList.add('is-resizing');
    const move = (ev) => setW(w0 + (ev.clientX - x0));
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove('is-resizing'); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  };
  sp.ondblclick = () => { const p = uiPrefsGet('cc_uiskills_prefs'); delete p.listWidth; uiPrefsSet('cc_uiskills_prefs', p); layout.style.removeProperty('--uiskill-list-w'); };
  sp.onkeydown = (e) => { // keyboard-resizable
    const cur = $('#uiskillList').getBoundingClientRect().width;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setW(cur - 24); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setW(cur + 24); }
  };
}

// ◀ / ▶ : fold the list down to an icon rail; the choice survives a reload, the search box unfolds it
function uiListSetCollapsed(on) {
  const layout = document.querySelector('#view-uiskills .uiskill-layout');
  if (layout) layout.classList.toggle('list-collapsed', !!on);
  const p = uiPrefsGet('cc_uiskills_prefs'); p.listCollapsed = !!on; uiPrefsSet('cc_uiskills_prefs', p);
  const bar = document.querySelector('.uiskill-collapse');
  if (bar) { bar.textContent = on ? '▶' : '◀'; bar.title = on ? t('views-uiskills.listeAusklappen') : t('views-uiskills.listeEinklappen'); }
}
function uiListCollapsed() { return uiPrefsGet('cc_uiskills_prefs').listCollapsed === true; }
function uiListCollapseBar() {
  const on = uiListCollapsed();
  const b = el('button', 'uiskill-collapse', on ? '▶' : '◀');
  b.title = on ? t('views-uiskills.listeAusklappen') : t('views-uiskills.listeEinklappen');
  b.onclick = (e) => { e.stopPropagation(); uiListSetCollapsed(!uiListCollapsed()); };
  return b;
}
// one click for the everyday case: defaults + the inputs from last time, straight into a run.
// Goes through startUiRun, so required fields, validation, the write confirmation and the
// sensitive-data guard all apply exactly as from the form.
async function uiQuickStart(s) {
  const m = s.manifest || {};
  const defs = uiDefaultValues(m);
  const last = lastInputs(s.name) || {};
  Object.keys(last).forEach((k) => { if (k in defs) defs[k] = last[k]; });
  // BUILDER-1: the user kept a draft of another skill instead of switching → nothing switched, nothing started
  if (!(await openUiSkill(s))) return;
  startUiRun(s, defs, { autoRun: uiAutoRunDefault(), dryRun: false, mode: (m.steps || []).length ? RUN_MODE : 'single' });
}
function uiSkillListItem(s) {
  const m = s.manifest || {};
  const it = el('div', 'uiskill-item' + (UISKILL_SEL && UISKILL_SEL.name === s.name ? ' active' : ''));
  it.appendChild(el('span', 'usi-icon', m.icon || '▶'));
  const body = el('div', 'usi-body');
  const nameRow = el('div', 'usi-name-row');
  nameRow.appendChild(el('div', 'usi-name', m.title || s.name));
  // ▶ quick start: defaults + the inputs you used last time, straight into a run (write gate stays)
  const quick = el('button', 'usi-quick', '▶');
  const lastTxt = histInputsSummary(m, lastInputs(s.name) || {});
  quick.title = t('views-uiskills.schnellstart') + (lastTxt ? ' — ' + lastTxt : '');
  quick.onclick = (e) => { e.stopPropagation(); uiQuickStart(s); };
  nameRow.appendChild(quick);
  nameRow.appendChild(starBtn(s.name, renderUiSkillList));
  body.appendChild(nameRow);
  if (s.description) body.appendChild(el('div', 'usi-desc', s.description));
  const meta = el('div', 'usi-meta');
  meta.appendChild(el('span', 'usi-tag', (m.inputs || []).length + t('views-uiskills.felder')));
  meta.appendChild(el('span', 'usi-tag', (m.steps || []).length + t('views-uiskills.schritte')));
  if (m.writes) meta.appendChild(el('span', 'usi-tag warn', t('views-uiskills.schreibt')));
  if (s.runCount) meta.appendChild(el('span', 'usi-tag', s.runCount + '× · ' + uiTimeAgo(s.lastRun)));
  body.appendChild(meta);
  it.appendChild(body);
  it.onclick = () => openUiSkill(s);
  mkClickable(it, 'UI Skill: ' + ((s.manifest && s.manifest.title) || s.name));
  return it;
}

// `tab`: where to land ('run' unless said). → false when the user kept an unsaved builder draft of ANOTHER skill
// instead (BUILDER-1): the builder holds one draft, and opening another skill is what would replace it — so the
// question is asked here, before UISKILL_SEL moves, and not at every tab switch (those keep the draft).
// The selection is the LIST's entry of that name when there is one: a caller may hold an older object (the schedule
// button of a result card keeps the skill from the run's start), and its manifest is as old as the run.
async function openUiSkill(s, tab) {
  if (builderDirty() && BUILDER.name !== s.name && !(await builderDraftMayGo())) return false;
  UISKILL_SEL = (UISKILLS_DATA || []).find((x) => x.name === s.name) || s; UISKILL_TAB = tab || 'run';
  renderUiSkillList();
  renderUiSkillPanel();
  return true;
}

// Landing pane when no skill is selected. It used to repeat every skill as a tile — the same list that
// is already open right next to it, so the pane said nothing new. Show what the list CANNOT show instead:
// what actually happened across all skills (activity feed) and what the server will run next (schedules).
// Data comes from the run history + schedules that already exist; no new endpoints.
function cockKpi(chips, label, value) {
  const chip = el('span', 'ui-result-stat');
  chip.appendChild(el('span', 'urst-v', String(value)));
  chip.appendChild(el('span', 'urst-k', label));
  chips.appendChild(chip);
}
function cockRow(icon, title, sub, when) {
  const row = el('div', 'ui-cock-row');
  row.appendChild(el('span', 'uct-icon', icon));
  const main = el('div', 'ucr-main');
  main.appendChild(el('div', 'uct-name', title));
  if (sub) main.appendChild(el('div', 'uct-sum', sub));
  row.appendChild(main);
  if (when) row.appendChild(el('span', 'uct-when', when));
  return row;
}
async function renderUiSkillCockpit(p) {
  p.innerHTML = '';
  const head = el('div', 'uiskill-head');
  head.appendChild(el('span', 'uh-icon', '▦'));
  const ht = el('div', 'uh-title');
  ht.appendChild(el('h2', null, t('views-uiskills.cockpitTitel')));
  ht.appendChild(el('div', 'uh-sub', t('views-uiskills.cockpitSub')));
  head.appendChild(ht); p.appendChild(head);
  const wrap = el('div', 'ui-cockpit'); p.appendChild(wrap);
  wrap.appendChild(el('div', 'loading', t('common.lade')));
  let runs = [], scheds = [], costs = null;
  const [rRuns, rSched, rCost] = await Promise.all([
    api('/api/uiskill/runs?meta=1').catch(() => null),
    api('/api/uiskill/schedules').catch(() => null),
    // A4 — cost per radar. Own request and own failure mode: the join scans the whole transcript
    // corpus, so a slow or failing usage scan must not take the cockpit down with it.
    api('/api/uiskill/costs?days=30').catch(() => null),
  ]);
  costs = rCost;
  if (rRuns) runs = (rRuns.runs || []).slice().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  if (rSched) scheds = (rSched.schedules || []).filter((x) => x.enabled).sort((a, b) => (a.nextRun || Infinity) - (b.nextRun || Infinity));
  wrap.innerHTML = '';
  if (!(UISKILLS_DATA || []).length) { wrap.appendChild(el('div', 'empty-mini', t('views-uiskills.keineUiSkillsErstelle'))); return; }
  const skillByName = {}; (UISKILLS_DATA || []).forEach((s) => { skillByName[s.name] = s; });

  // --- KPI strip: the week at a glance -----------------------------------------------------------
  const week = Date.now() - 7 * 864e5;
  const recent = runs.filter((r) => (r.startedAt || 0) >= week);
  // 'aborted' (a restart ended the run, FLOW-2) is a problem too — it must not lift the success rate
  const bad = recent.filter((r) => r.status === 'error' || r.status === 'stopped' || r.status === 'aborted').length;
  const chips = el('div', 'ui-result-stats');
  cockKpi(chips, t('views-uiskills.cockpitLaeufe7'), recent.length);
  cockKpi(chips, t('views-uiskills.cockpitErfolg'), recent.length ? Math.round(((recent.length - bad) / recent.length) * 100) + '%' : '—');
  cockKpi(chips, t('views-uiskills.cockpitProbleme'), bad);
  cockKpi(chips, t('views-uiskills.cockpitZeitplaene'), scheds.length);
  // A4: "what does my automation cost per month" — the number for schedule tuning and for justifying
  // an EUC. Estimate, same list-price basis as Nutzung & Kosten.
  if (costs && costs.total != null) cockKpi(chips, t('views-uiskills.cockpitKosten30'), fmtMoney(costs.total));
  wrap.appendChild(chips);
  if (costs && costs.unpriced) wrap.appendChild(el('div', 'ui-cock-note', t('views-uiskills.kostenUnvollstaendig').replace('{n}', costs.unpriced)));

  // --- activity feed: what ran, across all skills -------------------------------------------------
  const secR = el('div', 'ui-cock-sec');
  secR.appendChild(el('h3', null, t('views-uiskills.cockpitLetzte')));
  if (!runs.length) secR.appendChild(el('div', 'empty-mini', t('views-uiskills.cockpitKeineLaeufe')));
  runs.slice(0, 10).forEach((r) => {
    const s = skillByName[r.name];
    const m = (s && s.manifest) || {};
    const dig = r.result ? uiResultDigest(normalizeResultData(r.result)) : null;
    // per-run cost, where "what did THIS run cost" is actually asked (A4)
    const rc = costs && costs.byRun && costs.byRun[r.id];
    const row = cockRow(m.icon || '▶', r.title || m.title || r.name,
      (dig && dig.summary) || '', uiTimeAgo(r.startedAt) + (r.durationMs ? ' · ' + fmtDur(r.durationMs) : '') + (rc && rc.priced ? ' · ' + fmtMoney(rc.cost) : ''));
    row.insertBefore(el('span', 'uh-badge ' + r.status, histStatusLabel(r.status)), row.firstChild);
    if (r.headless) row.querySelector('.uct-name').appendChild(el('span', 'usi-tag', t('views-uiskills.cockpitGeplantTag')));
    const acts = el('div', 'uct-acts');
    if (s) {
      const again = el('button', 'ghost-btn', '▶');
      again.title = t('views-uiskills.cockpitErneut');
      again.onclick = (e) => { e.stopPropagation(); uiQuickStart(s); };
      acts.appendChild(again);
      const h = el('button', 'ghost-btn', t('html.verlauf'));
      h.onclick = (e) => { e.stopPropagation(); openUiSkill(s, 'history'); };
      acts.appendChild(h);
      row.onclick = () => openUiSkill(s, 'history');
      mkClickable(row, (m.title || r.name) + ' — ' + t('html.verlauf'));
    }
    row.appendChild(acts);
    secR.appendChild(row);
  });
  wrap.appendChild(secR);

  // --- what the server will run next --------------------------------------------------------------
  const secS = el('div', 'ui-cock-sec');
  secS.appendChild(el('h3', null, t('views-uiskills.cockpitGeplant')));
  if (!scheds.length) secS.appendChild(el('div', 'empty-mini', t('views-uiskills.cockpitKeineZeitplaene')));
  scheds.slice(0, 6).forEach((sc) => {
    const s = skillByName[sc.name];
    // cost of THIS schedule over the window (A4) — exact where the run carried a scheduleId, else the
    // headless-runs-of-this-skill bucket (older records); plus the cap, if one is set.
    const sCost = costs && (costs.bySchedule || []).find((x) => x.scheduleId === sc.id || x.key === 'skill:' + sc.name);
    const sub = t('views-uiskills.naechsterLauf') + fmtWhen(sc.nextRun)
      + (sc.lastRun ? ' · ' + t('views-uiskills.zuletzt') + uiTimeAgo(sc.lastRun) + (sc.lastStatus ? ' (' + histStatusLabel(sc.lastStatus) + ')' : '') : '')
      + (sCost && sCost.cost ? ' · ' + t('views-uiskills.kosten30') + fmtMoney(sCost.cost) + (sCost.runs ? ' (' + t('views-uiskills.jeLauf') + fmtMoney(sCost.avgCost) + ')' : '') : '')
      + (sc.maxBudgetUsd ? ' · ' + t('views-uiskills.deckelJeLauf') + fmtMoney(sc.maxBudgetUsd) : '');
    const row = cockRow('🕘', sc.title || sc.name, sub, '');
    if (s) {
      const acts = el('div', 'uct-acts');
      const open = el('button', 'ghost-btn', t('views-uiskills.oeffnen'));
      open.onclick = (e) => { e.stopPropagation(); openUiSkill(s, 'schedule'); };
      acts.appendChild(open);
      row.appendChild(acts);
    }
    secS.appendChild(row);
  });
  wrap.appendChild(secS);
}
function renderUiSkillPanel() {
  const p = $('#uiskillPanel');
  if (!UISKILL_SEL) { renderUiSkillCockpit(p); return; }
  const s = UISKILL_SEL, m = s.manifest || {};
  // BUILDER-1: an orphan (its file left the list while its draft was open, uiSkillSelFresh) has nothing that could
  // run, be scheduled or have a history — only the draft
  if (s.orphan) UISKILL_TAB = 'edit';
  p.innerHTML = '';
  const head = el('div', 'uiskill-head');
  head.appendChild(el('span', 'uh-icon', m.icon || '▶'));
  const ht = el('div', 'uh-title');
  ht.appendChild(el('h2', 'uh-name', m.title || s.name));   // .uh-name: paintUiSkillHead repaints it in place
  ht.appendChild(el('div', 'uh-sub', '/' + s.name + (s.description ? ' · ' + s.description : '')));
  head.appendChild(ht);
  p.appendChild(head);
  const tabs = el('div', 'uiskill-subtabs'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', t('views-uiskills.uiSkillAnsicht'));
  [['run', 'play', t('views-uiskills.ausfuehren-2')], ['edit', 'edit', t('common.bearbeiten')], ['history', 'clock', t('html.verlauf')], ['schedule', 'calendar', t('views-uiskills.zeitplan')]].forEach(([id, icon, label]) => {
    const b = el('button', 'ust' + (UISKILL_TAB === id ? ' active' : '')); b.innerHTML = ic(icon, 14) + ' <span>' + label + '</span>';
    b.id = 'uiskillTab-' + id;
    b.setAttribute('aria-pressed', String(UISKILL_TAB === id));
    // the draft marker sits on the TAB, so a kept draft is visible from every other tab too (paintBuilderDirty)
    if (id === 'edit') { const dot = el('span', 'ust-draft hidden', '●'); dot.setAttribute('aria-hidden', 'true'); b.appendChild(dot); }
    if (s.orphan && id !== 'edit') { b.disabled = true; b.title = t('views-uiskills.entwurfTabGesperrt'); }
    b.onclick = () => { UISKILL_TAB = id; renderUiSkillPanel(); };
    tabs.appendChild(b);
  });
  p.appendChild(tabs);
  // Run and schedule use the SAVED file (the CLI reads /<name> from disk) — with a draft open, the panel says so
  // next to them instead of letting the form look like the version that was just edited.
  if ((UISKILL_TAB === 'run' || UISKILL_TAB === 'schedule') && builderDirty() && BUILDER.name === s.name) p.appendChild(builderDraftHint());
  const body = el('div', 'uiskill-tabbody'); p.appendChild(body);
  if (UISKILL_TAB === 'run') renderRunPanel(body, s);
  else if (UISKILL_TAB === 'edit') renderBuilderPanel(body, s);
  else if (UISKILL_TAB === 'schedule') renderSchedulePanel(body, s);
  else renderHistoryPanel(body, s);
  paintBuilderDirty();
}

// ---- Phase 2: run form (inputs) + prompt composition ----
function treeDefaults(input) {
  const out = [];
  const walk = (nodes) => (nodes || []).forEach((o) => { if (o.default) out.push(o.value); walk(o.children); });
  walk(input.options);
  return out;
}
function uiDefaultValues(manifest) {
  const v = {};
  (manifest.inputs || []).forEach((i) => {
    if (i.type === 'tree' || i.type === 'multiselect') v[i.id] = treeDefaults(i);
    else if (i.type === 'checkbox' || i.type === 'yesno') v[i.id] = !!i.default;
    else if (i.type === 'select' || i.type === 'radio') v[i.id] = (i.default != null) ? i.default : (((i.options || [])[0] || {}).value != null ? i.options[0].value : '');
    else if (i.type === 'tags') v[i.id] = Array.isArray(i.default) ? i.default.slice() : [];
    else v[i.id] = (i.default != null) ? i.default : '';
  });
  return v;
}
function isVisible(input, values) {
  const c = input.visibleIf;
  if (!c) return true;
  if (typeof c === 'string') return uiTruthy(values[c]);
  if (c && typeof c === 'object' && c.field) return values[c.field] === c.equals;
  return true;
}
function applyVisibility(scope, m, values) {
  (m.inputs || []).forEach((i) => { const row = scope.querySelector('[data-field="' + i.id + '"]'); if (row) row.classList.toggle('field-hidden', !isVisible(i, values)); });
}
function missingRequired(manifest, values) {
  return (manifest.inputs || []).filter((i) => i.required && isVisible(i, values) && (values[i.id] == null || values[i.id] === '' || (Array.isArray(values[i.id]) && !values[i.id].length)));
}
// per-skill remembered inputs + named presets (localStorage)
function uiPrefsGet(key) { try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; } }
function uiPrefsSet(key, obj) { try { localStorage.setItem(key, JSON.stringify(obj)); } catch { /* */ } }
function lastInputs(name) { return uiPrefsGet('cc_uiskill_last')[name] || null; }
function saveLastInputs(name, values, defaults) {
  const o = uiPrefsGet('cc_uiskill_last'); const keep = {}; const d = defaults || {};
  Object.keys(values || {}).forEach((k) => { if (JSON.stringify(values[k]) !== JSON.stringify(d[k])) keep[k] = values[k]; });
  if (Object.keys(keep).length) o[name] = keep; else delete o[name];
  uiPrefsSet('cc_uiskill_last', o);
}
function getPresets(name) { return uiPrefsGet('cc_uiskill_presets')[name] || {}; }
function savePreset(name, pn, values) { const o = uiPrefsGet('cc_uiskill_presets'); o[name] = o[name] || {}; o[name][pn] = values; uiPrefsSet('cc_uiskill_presets', o); }
function deletePreset(name, pn) { const o = uiPrefsGet('cc_uiskill_presets'); if (o[name]) { delete o[name][pn]; uiPrefsSet('cc_uiskill_presets', o); } }
// v2: früher wurden auch akzeptierte Defaults gemerkt und maskierten geänderte
// Manifest-Defaults — Alt-Bestand einmalig verwerfen (danach nur noch bewusste Anpassungen).
(function migrateUiskillLast(){ try { if (localStorage.getItem('cc_uiskill_last_v') !== '2') { localStorage.removeItem('cc_uiskill_last'); localStorage.setItem('cc_uiskill_last_v', '2'); } } catch { /* */ } })();

function buildTreeControl(input, values) {
  const wrap = el('div', 'ui-tree');
  const sel = new Set(Array.isArray(values[input.id]) ? values[input.id] : []);
  const rows = [];
  const commit = () => { values[input.id] = [...sel]; rows.forEach((r) => { if (r.childValues.length) { const n = r.childValues.filter((v) => sel.has(v)).length; r.cb.indeterminate = n > 0 && n < r.childValues.length; } }); };
  const render = () => {
    wrap.innerHTML = ''; rows.length = 0;
    const node = (o, depth) => {
      const line = el('label', 'ui-tree-node'); line.style.paddingLeft = (depth * 18) + 'px';
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = sel.has(o.value);
      const childValues = []; const collect = (n) => (n || []).forEach((c) => { childValues.push(c.value); collect(c.children); }); collect(o.children);
      cb.onchange = () => { if (cb.checked) { sel.add(o.value); childValues.forEach((v) => sel.add(v)); } else { sel.delete(o.value); childValues.forEach((v) => sel.delete(v)); } render(); };
      rows.push({ cb, childValues });
      line.appendChild(cb); line.appendChild(el('span', 'utn-label', o.label || o.value));
      wrap.appendChild(line);
      (o.children || []).forEach((c) => node(c, depth + 1));
    };
    (input.options || []).forEach((o) => node(o, 0));
    commit();
  };
  render();
  return wrap;
}

// field validation (pattern / min / max) — returns a message or '' (valid)
function fieldError(input, v) {
  const empty = v == null || v === '' || (Array.isArray(v) && !v.length);
  if (empty) return '';
  if (input.pattern && typeof v === 'string') { let re; try { re = new RegExp(input.pattern); } catch { re = null; } if (re && !re.test(v)) return input.errorMessage || t('views-uiskills.entsprichtNichtDemMuster'); }
  if (input.min != null || input.max != null) {
    if (input.type === 'number') { const n = Number(v); if (input.min != null && n < Number(input.min)) return input.errorMessage || (t('views-uiskills.minimum') + input.min); if (input.max != null && n > Number(input.max)) return input.errorMessage || (t('views-uiskills.maximum') + input.max); }
    else if (input.type === 'date') { if (input.min != null && String(v) < String(input.min)) return input.errorMessage || (t('views-uiskills.fruehestens-2') + input.min); if (input.max != null && String(v) > String(input.max)) return input.errorMessage || (t('views-uiskills.spaetestens-2') + input.max); }
    else if (typeof v === 'string') { if (input.min != null && v.length < Number(input.min)) return input.errorMessage || (t('views-uiskills.mindestens') + input.min + t('views-uiskills.zeichen')); if (input.max != null && v.length > Number(input.max)) return input.errorMessage || (t('views-uiskills.hoechstens') + input.max + t('views-uiskills.zeichen')); }
  }
  return '';
}
function validateFields(m, values) {
  const errs = [];
  (m.inputs || []).forEach((i) => { if (!isVisible(i, values)) return; const msg = fieldError(i, values[i.id]); if (msg) errs.push({ input: i, msg }); });
  return errs;
}
function markFieldError(row, msg) {
  if (!row) return;
  let em = row.querySelector('.ui-ferror');
  if (msg) { row.classList.add('invalid'); if (!em) { em = el('div', 'ui-ferror'); row.appendChild(em); } em.textContent = msg; }
  else { row.classList.remove('invalid'); if (em) em.remove(); }
}
// file picker modal (reuses /api/files) → resolves a relative path string or null
// One of the TWO overlays the first roll-call could not see, and nobody had ever looked at it either: no
// Esc handler, no focus trap, not in the stack, three bare `ov.remove()` exits — and its scrim class
// `uiskill-picker-ov` had no CSS
// rule at all, so a „modal" appended to document.body rendered as a plain block at the bottom of the page.
// It is opened FROM the UI-skill form (itself a uiModal), so Esc used to close the form underneath and
// leave this one behind as an orphan with an unresolved Promise. It now uses the same `modal-overlay` /
// `modal` chrome as the two UI-skill pickers, which is where its z-index, its scrim and its focus trap
// come from. The roll-call in test/overlay-stack.test.js enforces the scrim convention it violated.
function pickFileModal(cwd) {
  return new Promise((resolve) => {
    let settled = false, release = null;
    const ov = el('div', 'modal-overlay');
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
    const box = el('div', 'modal uiskill-picker');
    // ONE exit for all four ways out (Esc, scrim, Abbrechen, a row) — the Promise must resolve exactly
    // once and the stack entry must go with it, which three independent `ov.remove()` calls cannot promise.
    const finish = (v) => { if (settled) return; settled = true; if (release) release(); ov.remove(); resolve(v); };
    box.appendChild(el('div', 'ub-sec-title', t('views-uiskills.dateiWaehlen')));
    const search = el('input', 'ui-input'); search.placeholder = t('views-uiskills.suche'); box.appendChild(search);
    const list = el('div', 'uiskill-picker-list'); box.appendChild(list);
    const cancel = el('button', 'ghost-btn', t('html.abbrechen')); cancel.onclick = () => finish(null); box.appendChild(cancel);
    ov.appendChild(box); ov.onclick = (e) => { if (e.target === ov) finish(null); };
    document.body.appendChild(ov);
    // autofocus:false — the search field is the target, not the first tabbable element. Enter in it walks
    // the caret into the list (the second Enter is render.js's activator), same as the skill launcher.
    release = overlayPush(ov, { box, autofocus: false, onEsc: () => finish(null), onEnter: () => overlayFocusFirst(list, '.uiskill-picker-item') });
    search.focus();
    let tmr = null;
    const load = async () => {
      let files = [], refused = '';
      try { const r = await api('/api/files?cwd=' + encodeURIComponent(cwd || '') + '&q=' + encodeURIComponent(search.value.trim())); files = r.files || []; }
      catch (e) { if (e && e.code === 'cwd-refused') refused = String(e.message || ''); }
      list.innerHTML = '';
      // A cwd the server REFUSES (GET /api/files, code `cwd-refused`) is not "no matches": this picker is
      // handed the skill manifest's run.cwd, and „Keine Treffer" would blame the search for a directory
      // that was never read. Same reader as the composer's @-menu (chat-composer.js updateAt).
      if (refused) { list.appendChild(el('div', 'empty-mini', '⚠ ' + t('common.ordnerAbgelehnt') + refused)); return; }
      if (!files.length) { list.appendChild(el('div', 'empty-mini', t('views-uiskills.keineTreffer'))); return; }
      files.forEach((f) => { const b = el('button', 'uiskill-picker-item'); b.appendChild(el('div', 'upi-name', f)); b.onclick = () => finish(f); list.appendChild(b); });
    };
    search.oninput = () => { clearTimeout(tmr); tmr = setTimeout(load, 200); };
    load();
  });
}
function buildInput(input, values, ctx) {
  const row = el('div', 'ui-field'); row.setAttribute('data-field', input.id);
  row.addEventListener('input', () => { row.classList.remove('invalid'); const em = row.querySelector('.ui-ferror'); if (em) em.remove(); }, true);
  row.addEventListener('change', () => { row.classList.remove('invalid'); const em = row.querySelector('.ui-ferror'); if (em) em.remove(); }, true);
  const lab = el('label', 'ui-flabel', input.label || input.id);
  if (input.required) lab.appendChild(el('span', 'ui-req', ' *'));
  row.appendChild(lab);
  const ty = input.type;
  if (ty === 'text' || ty === 'number' || ty === 'date') {
    const inp = el('input', 'ui-input'); inp.type = (ty === 'number' ? 'number' : ty === 'date' ? 'date' : 'text');
    if (input.placeholder) inp.placeholder = input.placeholder;
    if (input.min != null) inp.min = input.min;
    if (input.max != null) inp.max = input.max;
    inp.value = values[input.id] != null ? values[input.id] : '';
    inp.oninput = () => { values[input.id] = (ty === 'number' ? (inp.value === '' ? '' : Number(inp.value)) : inp.value); };
    inp.onblur = () => markFieldError(row, fieldError(input, values[input.id]));
    row.appendChild(inp);
  } else if (ty === 'textarea') {
    const inp = el('textarea', 'ui-input ui-textarea'); if (input.placeholder) inp.placeholder = input.placeholder;
    inp.value = values[input.id] || ''; inp.rows = input.rows || 3;
    inp.oninput = () => { values[input.id] = inp.value; };
    inp.onblur = () => markFieldError(row, fieldError(input, values[input.id]));
    row.appendChild(inp);
  } else if (ty === 'checkbox') {
    const w = el('label', 'ui-check'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!values[input.id];
    cb.onchange = () => { values[input.id] = cb.checked; };
    w.appendChild(cb); w.appendChild(el('span', null, input.checkboxLabel || t('views-uiskills.aktiviert'))); row.appendChild(w);
  } else if (ty === 'yesno') {
    const seg = el('div', 'ui-seg');
    [[t('chat-render.ja'), true], [t('chat-render.nein'), false]].forEach(([label, val]) => {
      const b = el('button', 'ui-seg-btn' + (!!values[input.id] === val ? ' active' : '')); b.type = 'button'; b.textContent = label;
      b.onclick = () => { values[input.id] = val; [...seg.children].forEach((c) => c.classList.remove('active')); b.classList.add('active'); };
      seg.appendChild(b);
    });
    row.appendChild(seg);
  } else if (ty === 'select') {
    const s = el('select', 'ui-input');
    (input.options || []).forEach((o) => { const op = el('option'); op.value = o.value; op.textContent = o.label || o.value; if (values[input.id] === o.value) op.selected = true; s.appendChild(op); });
    s.onchange = () => { values[input.id] = s.value; };
    row.appendChild(s);
  } else if (ty === 'radio') {
    const grp = el('div', 'ui-radio');
    (input.options || []).forEach((o) => {
      const w = el('label', 'ui-radio-opt' + (values[input.id] === o.value ? ' active' : ''));
      const r = el('input'); r.type = 'radio'; r.name = 'uir_' + input.id; r.checked = values[input.id] === o.value;
      r.onchange = () => { values[input.id] = o.value; [...grp.children].forEach((c) => c.classList.remove('active')); w.classList.add('active'); };
      w.appendChild(r); w.appendChild(el('span', null, o.label || o.value)); grp.appendChild(w);
    });
    row.appendChild(grp);
  } else if (ty === 'tags') {
    const box = el('div', 'ui-tags');
    const arr = Array.isArray(values[input.id]) ? values[input.id] : (values[input.id] = []);
    const render = (focus) => {
      box.innerHTML = '';
      arr.forEach((tag, i) => { const chip = el('span', 'ui-tag-chip'); chip.appendChild(el('span', null, tag)); const x = el('button', 'ui-tag-x'); x.type = 'button'; x.innerHTML = ic('close', 11); x.onclick = () => { arr.splice(i, 1); render(true); }; chip.appendChild(x); box.appendChild(chip); });
      const inp = el('input', 'ui-tag-input'); inp.placeholder = arr.length ? '' : (input.placeholder || t('views-uiskills.tagEnter'));
      inp.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); const val = inp.value.trim().replace(/,$/, ''); if (val && !arr.includes(val)) { arr.push(val); render(true); } } else if (e.key === 'Backspace' && !inp.value && arr.length) { arr.pop(); render(true); } };
      inp.onblur = () => { const val = inp.value.trim(); if (val && !arr.includes(val)) { arr.push(val); render(false); } };
      box.appendChild(inp);
      if (focus) inp.focus();
    };
    render(false);
    row.appendChild(box);
  } else if (ty === 'file') {
    const wrap = el('div', 'ui-file');
    const inp = el('input', 'ui-input'); inp.readOnly = true; inp.placeholder = t('views-uiskills.keineDateiGewaehlt'); inp.value = values[input.id] || '';
    const cwd = (ctx && ctx.cwd) || input.cwd || (UISKILL_SEL && UISKILL_SEL.manifest && UISKILL_SEL.manifest.run && UISKILL_SEL.manifest.run.cwd) || '';
    const btn = el('button', 'ghost-btn', t('views-uiskills.waehlen')); btn.type = 'button';
    btn.onclick = async () => { const f = await pickFileModal(cwd); if (f != null) { values[input.id] = f; inp.value = f; } };
    const clr = iconBtn('ghost-btn', 'close', { size: 14, title: t('views-uiskills.leeren-2') }); clr.onclick = () => { values[input.id] = ''; inp.value = ''; };
    wrap.appendChild(inp); wrap.appendChild(btn); wrap.appendChild(clr);
    row.appendChild(wrap);
  } else if (ty === 'tree' || ty === 'multiselect') {
    row.appendChild(buildTreeControl(input, values));
  } else {
    row.appendChild(el('div', 'empty-mini', t('views-uiskills.unbekannterFeldtyp') + ty));
  }
  if (input.help) row.appendChild(el('div', 'ui-fhelp', input.help));
  // SELECT-NAME — same gap as in ubRow, and here it covers every field type a skill manifest can declare:
  // the `.ui-flabel` above is a sibling with no `for`, so a skill form was a column of unnamed inputs.
  // One pass over the controls this branch just built, and only where no name was set (the checkbox and
  // radio branches wrap their own <label> and are already named by it).
  row.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]), select, textarea')
    .forEach((c) => ubLabel(c, (input.label || input.id) + (input.required ? ' *' : '')));
  return row;
}

let RUN_VALUES = {};
let RUN_SKILL = null;
let RUN_MODE = 'single';
let UISKILL_PREFILL = null;
function uiTruthy(v) { if (Array.isArray(v)) return v.length > 0; return !!v; }
function uiPresetBar(skill, m) {
  const bar = el('div', 'ui-preset-bar');
  bar.appendChild(el('span', 'ui-preset-lbl', t('views-uiskills.presets')));
  const names = Object.keys(getPresets(skill.name));
  if (names.length) {
    const sel = el('select', 'ui-input ui-preset-sel');
    sel.appendChild(Object.assign(el('option'), { value: '', textContent: t('views-uiskills.laden') }));
    names.forEach((n) => sel.appendChild(Object.assign(el('option'), { value: n, textContent: n })));
    sel.onchange = () => { const p = getPresets(skill.name)[sel.value]; if (p) { RUN_VALUES = Object.assign(uiDefaultValues(m), JSON.parse(JSON.stringify(p))); renderUiSkillPanel(); } };
    bar.appendChild(sel);
    const del = iconBtn('ghost-btn ui-preset-del', 'trash', { size: 14, title: t('views-uiskills.gewaehltesPresetLoeschen') }); del.onclick = async () => { if (sel.value && await uiConfirm(t('views-uiskills.preset') + sel.value + t('common.loeschen'), { danger: true, okLabel: t('common.loeschen-2') })) { deletePreset(skill.name, sel.value); renderUiSkillPanel(); } }; bar.appendChild(del);
  } else bar.appendChild(el('span', 'ui-preset-none', t('views-uiskills.nochKeine')));
  const save = iconBtn('ghost-btn ui-preset-save', 'plus', { size: 14, label: t('views-uiskills.speichern') }); save.onclick = async () => { const pn = ((await uiPrompt(t('views-uiskills.presetName'), '', { title: t('views-uiskills.presetSpeichern'), okLabel: t('common.speichern') })) || '').trim(); if (pn) { savePreset(skill.name, pn, JSON.parse(JSON.stringify(RUN_VALUES))); toast(t('views-uiskills.preset-2') + pn + t('views-uiskills.gespeichert'), 'ok'); renderUiSkillPanel(); } }; bar.appendChild(save);
  return bar;
}
// The run tab is a form with a result underneath — and once the run is going, the result is what you
// came for. So everything that is *input* lives in one foldable panel (`#uiRunSetup`): it folds itself
// away when a run starts (see startUiRun), keeps a summary of the values it was started with, and
// sticks to the top while you read the result, so the next run stays one click away.
let SETUP_FOLD = null, RUN_OPT_REFS = null;
function runSetupFolded(name) {
  if (!SETUP_FOLD) SETUP_FOLD = Object.assign({}, uiPrefsGet('cc_uiskill_setup'));
  return SETUP_FOLD[name] === true;
}
function setRunSetupFolded(on, persist) {
  if (!UISKILL_SEL) return;
  if (!SETUP_FOLD) SETUP_FOLD = Object.assign({}, uiPrefsGet('cc_uiskill_setup'));
  SETUP_FOLD[UISKILL_SEL.name] = !!on;
  // Only a deliberate click survives a reload. The automatic fold at run start does not — otherwise a
  // skill you ran once would greet you with a folded form forever.
  if (persist) { const o = uiPrefsGet('cc_uiskill_setup'); o[UISKILL_SEL.name] = !!on; uiPrefsSet('cc_uiskill_setup', o); }
  paintRunSetup();
}
function uiSetupChip(k, v, cls) {
  const c = el('span', 'ui-setup-chip' + (cls ? ' ' + cls : ''));
  if (k) c.appendChild(el('span', 'usc-k', k));
  c.appendChild(el('span', 'usc-v', v));
  c.title = (k ? k + ': ' : '') + v;
  return c;
}
const SETUP_SUM_MAX = 4;
// What the folded panel says: the filled-in fields, then the run flags — a checked "Testlauf" or
// "Stapel-Lauf" changes what Start does, so it must stay readable while the form is away.
function uiSetupSummary(m, values) {
  const wrap = el('div', 'ui-setup-sum');
  const filled = (m.inputs || []).filter((i) => {
    const v = values[i.id];
    return !(v == null || v === '' || v === false || (Array.isArray(v) && !v.length));
  });
  filled.slice(0, SETUP_SUM_MAX).forEach((i) => {
    const txt = uiRenderInputValue(i, values[i.id], UI_YESNO_LABELS()) || '—'; // DISPLAY: a folded setup chip, localised
    wrap.appendChild(uiSetupChip(i.label || i.id, txt.length > 46 ? txt.slice(0, 45) + '…' : txt));
  });
  if (filled.length > SETUP_SUM_MAX) wrap.appendChild(uiSetupChip('', '+' + (filled.length - SETUP_SUM_MAX), 'muted'));
  if (!filled.length) wrap.appendChild(uiSetupChip('', (m.inputs || []).length ? t('views-uiskills.keineEingaben') : t('views-uiskills.setupOhneFelder'), 'muted'));
  const r = RUN_OPT_REFS || {};
  if (r.dry && r.dry.checked) wrap.appendChild(uiSetupChip('', t('views-uiskills.flagTestlauf'), 'warn'));
  if (r.batch && r.batch.checked) wrap.appendChild(uiSetupChip('', t('views-uiskills.flagStapel'), 'warn'));
  if ((m.steps || []).length && RUN_MODE === 'steps') wrap.appendChild(uiSetupChip('', t('views-uiskills.flagSchritte'), 'muted'));
  if (r.auto && r.auto.checked) wrap.appendChild(uiSetupChip('', t('views-uiskills.flagAuto'), 'muted'));
  return wrap;
}
function paintRunSetup() {
  const box = document.getElementById('uiRunSetup');
  if (!box || !UISKILL_SEL) return;
  const m = UISKILL_SEL.manifest || {};
  const on = runSetupFolded(UISKILL_SEL.name);
  box.classList.toggle('folded', on);
  const btn = box.querySelector('.ui-setup-toggle');
  if (btn) { btn.setAttribute('aria-expanded', String(!on)); btn.title = on ? t('views-uiskills.setupAusklappen') : t('views-uiskills.setupEinklappen'); }
  const caret = box.querySelector('.usc-caret'); if (caret) caret.textContent = on ? '▸' : '▾';
  const sum = box.querySelector('.ui-setup-sum'); if (sum) sum.replaceWith(uiSetupSummary(m, RUN_VALUES));
}
function renderRunPanel(host, s) {
  const m = s.manifest || {};
  // preserve entered values across mode toggles / sub-tab redraws; reset only on skill change or prefill
  if (RUN_SKILL !== s.name || UISKILL_PREFILL) {
    RUN_VALUES = uiDefaultValues(m); RUN_SKILL = s.name;
    if (!UISKILL_PREFILL) { const last = lastInputs(s.name); if (last) Object.keys(last).forEach((k) => { if (k in RUN_VALUES) RUN_VALUES[k] = last[k]; }); }
  }
  if (UISKILL_PREFILL) { Object.keys(UISKILL_PREFILL).forEach((k) => { if (k in RUN_VALUES) RUN_VALUES[k] = UISKILL_PREFILL[k]; }); UISKILL_PREFILL = null; }
  host.innerHTML = '';
  RUN_OPT_REFS = null;
  const setup = el('div', 'ui-setup'); setup.id = 'uiRunSetup';
  const sHead = el('div', 'ui-setup-head');
  const sToggle = el('button', 'ui-setup-toggle'); sToggle.type = 'button';
  sToggle.setAttribute('aria-controls', 'uiRunSetupBody');
  sToggle.appendChild(el('span', 'usc-caret', '▾'));
  sToggle.appendChild(el('span', 'usc-title', t('views-uiskills.setupTitel')));
  sToggle.appendChild(el('span', 'usc-count', (m.inputs || []).length + t('views-uiskills.felder')));
  sToggle.onclick = () => setRunSetupFolded(!runSetupFolded(s.name), true);
  sHead.appendChild(sToggle);
  setup.appendChild(sHead);
  const sBody = el('div', 'ui-setup-body'); sBody.id = 'uiRunSetupBody';
  setup.appendChild(sBody);
  host.appendChild(setup);
  const tabHost = host;
  host = sBody;   // everything below is input — it belongs inside the foldable body
  if ((m.inputs || []).length) host.appendChild(uiPresetBar(s, m));
  const form = el('div', 'ui-run-form');
  if ((m.inputs || []).length) (m.inputs).forEach((input) => form.appendChild(buildInput(input, RUN_VALUES, { cwd: (m.run || {}).cwd })));
  else form.appendChild(el('div', 'empty-mini', t('views-uiskills.dieserSkillHatKeine')));
  host.appendChild(form);
  applyVisibility(form, m, RUN_VALUES);
  form.addEventListener('input', () => applyVisibility(form, m, RUN_VALUES));
  form.addEventListener('change', () => applyVisibility(form, m, RUN_VALUES));
  // Ctrl/Cmd+Enter anywhere in the form starts the run
  form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); const b = $('#uiStartBtn'); if (b && !b.disabled) b.click(); } });

  // execution mode (only when the skill defines steps)
  if ((m.steps || []).length) {
    const modeRow = el('div', 'ui-mode');
    modeRow.appendChild(el('span', 'ui-mode-lbl', t('views-uiskills.modus')));
    const seg = el('div', 'ui-seg');
    [['single', t('views-uiskills.einzelPrompt')], ['steps', t('views-uiskills.schrittFuerSchritt')]].forEach(([v, l]) => { const b = el('button', 'ui-seg-btn' + (RUN_MODE === v ? ' active' : '')); b.type = 'button'; b.textContent = l; b.onclick = () => { RUN_MODE = v; renderUiSkillPanel(); }; seg.appendChild(b); });
    modeRow.appendChild(seg);
    host.appendChild(modeRow);
    if (RUN_MODE === 'steps') host.appendChild(renderStepPlan(m, RUN_VALUES));
  }

  const opts = el('div', 'ui-run-opts');
  // AUTO-RANK — five checkboxes in one row, and one of them hands every tool permission of the run away
  // before it is asked for. „Testlauf", „Prompt vorher zeigen", „benachrichtigen" and „Stapel-Lauf" cost
  // you nothing if you tick them by accident; this one is the one that cannot be taken back, and it is
  // also the one that REMEMBERS itself as the default for every future run (the `onchange` below writes
  // cc_uiskills_prefs). It therefore does not look like its four harmless neighbours: own class, ⚠ in the
  // label, and the tooltip it already had. Not a colour alone (1.4.1) — the glyph is in the text.
  const autoWrap = el('label', 'ui-check ui-check-risk');
  autoWrap.title = t('views-uiskills.beantwortetToolFreigabenAutomatisch');
  const autoCb = el('input'); autoCb.type = 'checkbox'; autoCb.checked = !!uiAutoRunDefault();
  autoCb.onchange = () => { try { const p = JSON.parse(localStorage.getItem('cc_uiskills_prefs') || '{}'); p.autoRun = autoCb.checked; localStorage.setItem('cc_uiskills_prefs', JSON.stringify(p)); } catch { /* */ } };
  autoWrap.appendChild(autoCb); autoWrap.appendChild(el('span', null, '⚠ ' + t('views-uiskills.freigabenAutomatischErlaubenAls')));
  opts.appendChild(autoWrap);
  const dryWrap = el('label', 'ui-check'); const dryCb = el('input'); dryCb.type = 'checkbox'; dryWrap.appendChild(dryCb); dryWrap.appendChild(el('span', null, t('views-uiskills.testlaufPlanModusSchreibt'))); opts.appendChild(dryWrap);
  const editWrap = el('label', 'ui-check'); const editCb = el('input'); editCb.type = 'checkbox'; editWrap.appendChild(editCb); editWrap.appendChild(el('span', null, t('views-uiskills.promptVorDemSenden'))); opts.appendChild(editWrap);
  const notifyWrap = el('label', 'ui-check'); const notifyCb = el('input'); notifyCb.type = 'checkbox'; notifyCb.checked = uiNotifyEnabled();
  notifyCb.onchange = async () => { if (notifyCb.checked && 'Notification' in window && Notification.permission !== 'granted') { try { const perm = await Notification.requestPermission(); if (perm !== 'granted') { notifyCb.checked = false; toast(t('views-uiskills.benachrichtigungenVomBrowserBlockiert'), 'err'); } } catch { /* */ } } try { const p = JSON.parse(localStorage.getItem('cc_uiskills_prefs') || '{}'); p.notify = notifyCb.checked; localStorage.setItem('cc_uiskills_prefs', JSON.stringify(p)); } catch { /* */ } };
  notifyWrap.appendChild(notifyCb); notifyWrap.appendChild(el('span', null, t('views-uiskills.beiFertigstellungBenachrichtigen'))); opts.appendChild(notifyWrap);
  // batch (one run per line) — available when there is a text/number/select field to vary
  let batchCb = null, batchField = null, batchLines = null;
  const batchable = (m.inputs || []).filter((i) => ['text', 'textarea', 'number', 'date', 'select', 'file'].includes(i.type));
  if (batchable.length) { const bWrap = el('label', 'ui-check'); batchCb = el('input'); batchCb.type = 'checkbox'; bWrap.appendChild(batchCb); bWrap.appendChild(el('span', null, t('views-uiskills.stapelLaufEineZeile'))); opts.appendChild(bWrap); }
  // P3 — „Projekt (nur Etikett)": the run's session counts into that project's figures, nothing more
  let labelPid = null;
  const projWrap = el('label', 'ui-check ui-proj-label');
  projWrap.title = t('views-uiskills.projektEtikettHint');
  projWrap.appendChild(el('span', null, t('views-uiskills.projektEtikett')));
  projWrap.appendChild(uiProjectLabelSelect(null, (v) => { labelPid = v; }));
  opts.appendChild(projWrap);
  if (m.writes) opts.appendChild(el('span', 'ui-writes-warn', t('views-uiskills.schreibtInExterneSysteme-3')));
  host.appendChild(opts);
  // the folded head mirrors these flags — keep the boxes reachable from there
  RUN_OPT_REFS = { auto: autoCb, dry: dryCb, edit: editCb, notify: notifyCb, batch: batchCb };

  let batchBox = null;
  if (batchable.length) {
    batchBox = el('div', 'ui-batch-box hidden');
    batchField = el('select', 'ui-input'); batchable.forEach((i) => { const o = el('option'); o.value = i.id; o.textContent = i.label || i.id; batchField.appendChild(o); });
    batchBox.appendChild(ubRow(t('views-uiskills.feldJeZeile'), batchField));
    batchLines = el('textarea', 'ui-input ui-textarea'); batchLines.rows = 4; batchLines.placeholder = t('views-uiskills.einWertProZeile');
    batchBox.appendChild(ubRow(t('views-uiskills.werteEineZeileEin'), batchLines));
    batchCb.onchange = () => batchBox.classList.toggle('hidden', !batchCb.checked);
    host.appendChild(batchBox);
  }

  const bar = el('div', 'ui-run-bar');
  const startBtn = iconBtn('primary-btn', 'play', { label: t('views-uiskills.start') }); startBtn.id = 'uiStartBtn';
  startBtn.onclick = () => {
    if (batchCb && batchCb.checked) {
      const lines = (batchLines.value || '').split('\n').map((x) => x.trim()).filter(Boolean);
      if (!lines.length) { toast(t('views-uiskills.bitteWerteEingebenEine'), 'err'); return; }
      startBatch(s, RUN_VALUES, { autoRun: autoCb.checked, dryRun: dryCb.checked, mode: (m.steps || []).length ? RUN_MODE : 'single', editPrompt: editCb.checked, labelProjectId: labelPid }, batchField.value, lines);
    } else startUiRun(s, RUN_VALUES, { autoRun: autoCb.checked, dryRun: dryCb.checked, editPrompt: editCb.checked, mode: (m.steps || []).length ? RUN_MODE : 'single', labelProjectId: labelPid });
  };
  const prevBtn = iconBtn('ghost-btn', 'display', { label: t('views-uiskills.promptVorschau') });
  const tabBtn = iconBtn('ghost-btn', 'chat', { label: t('views-uiskills.alsChatTab'), title: t('views-uiskills.diesenSkillInEinem') });
  tabBtn.onclick = async () => {
    const miss = missingRequired(m, RUN_VALUES);
    if (miss.length) { setRunSetupFolded(false, false); miss.forEach((i) => { const f = document.querySelector('#view-uiskills [data-field="' + i.id + '"]'); if (f) f.classList.add('invalid'); }); toast(t('views-uiskills.pflichtfelderFehlen') + miss.map((i) => i.label || i.id).join(', '), 'err'); return; }
    if (m.writes && !(await uiConfirm(t('views-uiskills.dieserSkillKannIn'), { danger: true, title: t('views-uiskills.schreibenMoeglich'), okLabel: t('views-uiskills.starten') }))) return; // writes gate — parity with the modal path
    if (typeof launchInNewTab === 'function') { const run = m.run || {}; launchInNewTab({ prompt: uiComposePrompt(s, RUN_VALUES, {}), title: m.title || s.name, cwd: run.cwd || '', model: run.model || '', effort: run.effort || '', permissionMode: run.permissionMode || 'plan', uiSkill: { name: s.name, manifest: m, values: JSON.parse(JSON.stringify(RUN_VALUES)) } }); }
    else toast(t('views-uiskills.chatNichtVerfuegbar'), 'err');
  };
  bar.appendChild(startBtn); bar.appendChild(prevBtn); bar.appendChild(tabBtn);
  setup.appendChild(bar);   // stays visible when the fields fold away — one click to run again
  // The value summary is a SIBLING of the bar, not part of the head: folded, it then owns a full line
  // under "Eingaben · [Start]" instead of being squeezed into the ~460px the bar leaves over. With nine
  // fields that squeeze put every chip on a line of its own — a five-line sticky block with the Start
  // button floating in the middle of it (reported 2026-09-30: "der Start-Knopf sieht komisch aus").
  setup.appendChild(uiSetupSummary(m, RUN_VALUES));

  const prev = el('pre', 'ui-prompt-preview hidden'); tabHost.appendChild(prev);
  prevBtn.onclick = () => {
    if (RUN_MODE === 'steps' && (m.steps || []).length) prev.textContent = planSteps(s, RUN_VALUES).map((st, i) => t('views-uiskills.schritt') + (i + 1) + ': ' + (st.title || st.id) + '\n' + uiInterpolate(st.prompt || st.title || '', m, RUN_VALUES, { autoRun: autoCb.checked })).join('\n\n');
    else prev.textContent = uiComposePrompt(s, RUN_VALUES, { autoRun: autoCb.checked });
    prev.classList.toggle('hidden');
  };

  const out = el('div', 'ui-run-output'); out.id = 'uiRunOutput'; tabHost.appendChild(out);
  // re-attach this skill's run cards (+ batch summary) so switching sub-tabs keeps live/finished runs
  const bs = BATCH_SUMMARIES.get(s.name); if (bs) out.appendChild(bs);
  out.appendChild(runsContainer(s.name));
  updateStartBtn();
  paintRunSetup();   // folded state survives sub-tab switches and skill changes
}
// global auto-run default (persisted, default OFF for safety)
function uiAutoRunDefault() { try { return JSON.parse(localStorage.getItem('cc_uiskills_prefs') || '{}').autoRun === true; } catch { return false; } }

// ---- Phase B: step-by-step plan + orchestration ----
function renderStepPlan(m, values) {
  const box = el('div', 'ui-step-plan'); box.id = 'uiStepPlan';
  box.appendChild(el('div', 'ui-sec-mini', t('views-uiskills.schritteHaekchenZumEin')));
  (m.steps || []).forEach((st, i) => {
    const active = !st.enabledBy || uiTruthy(values[st.enabledBy]);
    const row = el('label', 'ui-step' + (active ? '' : ' off')); row.setAttribute('data-step', st.id);
    const cb = el('input'); cb.type = 'checkbox'; cb.setAttribute('data-step-cb', st.id);
    cb.checked = active; cb.disabled = !active || !st.optional;
    row.appendChild(cb);
    row.appendChild(el('span', 'step-mark', '○'));
    let label = (i + 1) + '. ' + (st.title || st.id);
    if (st.confirm) label += '  🔒';
    if (st.enabledBy) label += t('views-uiskills.nurWenn') + st.enabledBy + ')';
    row.appendChild(el('span', 'step-title', label));
    box.appendChild(row);
  });
  return box;
}
function planSteps(skill, values) {
  const m = skill.manifest || {};
  const out = [];
  (m.steps || []).forEach((st) => {
    if (st.enabledBy && !uiTruthy(values[st.enabledBy])) return;
    if (st.optional) { const cb = document.querySelector('#uiStepPlan [data-step-cb="' + st.id + '"]'); if (cb && !cb.checked) return; }
    out.push(st);
  });
  return out;
}
let STEP_TIMES = {};
function uiNotifyEnabled() { try { return JSON.parse(localStorage.getItem('cc_uiskills_prefs') || '{}').notify === true; } catch { return false; } }
function uiNotify(title, body) { try { if (uiNotifyEnabled() && 'Notification' in window && Notification.permission === 'granted') { const n = new Notification(title, { body }); n.onclick = () => { window.focus(); try { n.close(); } catch { /* */ } }; } } catch { /* */ } }
function markStep(run, id, status) {
  if (run) run.stepStatus[id] = status;
  const row = run && run.stepEls ? run.stepEls[id] : document.querySelector('#uiStepPlan [data-step="' + id + '"]');
  if (!row) return;
  row.classList.remove('running', 'done', 'error', 'skipped'); row.classList.add(status);
  const mk = row.querySelector('.step-mark'); if (mk) mk.textContent = status === 'done' ? '✓' : status === 'error' ? '✕' : status === 'running' ? '◐' : status === 'skipped' ? '⤼' : '○';
  const key = (run ? run.id + ':' : '') + id;
  if (status === 'running') STEP_TIMES[key] = Date.now();
  else if (STEP_TIMES[key] && ['done', 'error', 'skipped'].includes(status)) {
    const ms = Date.now() - STEP_TIMES[key]; delete STEP_TIMES[key];
    let dur = row.querySelector('.step-dur'); if (!dur) { dur = el('span', 'step-dur'); row.appendChild(dur); }
    dur.textContent = ms < 1000 ? ms + 'ms' : (fmtDuration(ms) || Math.round(ms / 1000) + 's');
  }
}
function uiSendAndAwait(run, prompt) {
  return new Promise((resolve) => {
    run._await = resolve; run.lastError = false;
    api('/api/chat/' + run.chatId + '/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: prompt }) })
      .catch(() => { run.lastError = true; const r = run._await; run._await = null; if (r) r(); });
  });
}
// function, not a load-time const — the hint must resolve in the CURRENT language at send time
const DRY_HINT = () => t('views-uiskills.testlaufNurBeschreibenWas');
// generic in-transcript choice gate → resolves with the chosen action key
function uiGate(run, cls, title, choices, prevText) {
  expandRunTranscript(run); // a question must never hide behind a folded transcript
  return new Promise((resolve) => {
    const box = el('div', cls);
    box.appendChild(el('div', 'ui-gate-q', title));
    if (prevText) { const p = el('div', 'ui-gate-prev'); p.textContent = t('views-uiskills.vorherigerOutput') + String(prevText).trim().slice(0, 400); box.appendChild(p); }
    const row = el('div', 'ui-perm-row');
    choices.forEach(([key, label, kind]) => { const b = el('button', kind || 'ghost-btn', label); b.onclick = () => { box.remove(); resolve(key); }; row.appendChild(b); });
    box.appendChild(row);
    run.tab.msgEl.appendChild(box); uiRunScroll(run, true);
  });
}
function uiConfirmGate(run, st) {
  const prev = ([...run.tab.msgEl.querySelectorAll('.msg.assistant .bubble')].pop() || {}).innerText;
  return uiGate(run, 'ui-gate', t('views-uiskills.bestaetigungVorSchritt') + (st.title || st.id), [['go', t('chat-render.weiter'), 'primary-btn'], ['skip', t('views-uiskills.ueberspringen')], ['stop', t('views-uiskills.stop'), 'ghost-btn danger']], prev);
}
function uiRetryGate(run, st) {
  return uiGate(run, 'ui-gate err', t('views-uiskills.schrittFehlgeschlagen') + (st.title || st.id), [['retry', t('views-uiskills.wiederholen'), 'primary-btn'], ['skip', t('views-uiskills.ueberspringen')], ['stop', t('views-uiskills.stop'), 'ghost-btn danger']]);
}
function uiWaitIfPaused(run) {
  return new Promise((resolve) => { const check = () => { if (!run || !run.paused) resolve(); else setTimeout(check, 200); }; check(); });
}
// editable prompt modal before sending (single mode) → resolves edited text or null (cancel)
// This WAS a hand-built overlay — the other one the roll-call missed — and like the file picker it had no Esc handler, no focus
// trap, no stack entry, three bare `ov.remove()` exits and a scrim class with no CSS rule. It is a
// „multiline prompt with Senden/Abbrechen", i.e. exactly what uiModal already is, so it is one call now
// instead of the fifteen lines it had: Esc (→ null), the focus trap, the z-index from the stack depth and
// the focus handed back to the opener all come from there. `wide` because a 14-row prompt in the standard
// 480 px modal is unreadable; the old bespoke box was 560 px, `.modal-wide` is 760.
function uiEditPromptModal(prompt) {
  return uiModal({
    icon: '✎', title: t('views-uiskills.promptVorDemSenden'), wide: true,
    input: { value: prompt, multiline: true, rows: 14 },
    escValue: null,
    actions: [
      { label: t('html.abbrechen'), value: null },
      { label: t('views-uiskills.senden'), returnsInput: true, primary: true },
    ],
  });
}
async function runSteps(run, opts, steps) {
  const skill = run.skill, values = run.values;
  let hadError = false;
  for (const st of steps) {
    if (!run || run.done || run.status === 'stopped') break;
    await uiWaitIfPaused(run);
    if (run.status === 'stopped') break;
    if (st.confirm && !opts.autoRun) {
      const go = await uiConfirmGate(run, st);
      if (go === 'stop') { run.status = 'stopped'; break; }
      if (go === 'skip') { markStep(run, st.id, 'skipped'); continue; }
    }
    let settled = false;
    while (!settled) {
      markStep(run, st.id, 'running'); uiRunStatus(run, t('views-uiskills.schritt-4') + (st.title || st.id), 'run');
      const p = uiInterpolate(st.prompt || st.title || '', skill.manifest, values, opts);
      let sendText = opts.dryRun ? DRY_HINT() + p : p;
      if (opts.editPrompt && !opts.autoRun) { const edited = await uiEditPromptModal(sendText); if (edited == null) { run.status = 'stopped'; settled = true; break; } sendText = edited; }
      await uiSendAndAwait(run, sendText);
      if (run.status === 'stopped') { settled = true; break; }
      // CHAT-FLOW-4 — a chat tab or another window took the session over mid-step (`_superseded`, uiRunBody): the
      // process is gone and this run does not resume, so [Wiederholen] could never work — the run is stopped, and
      // uiRunFinish says by what. The step did not complete: marked as an error, not as skipped.
      if (run.superseded) { markStep(run, st.id, 'error'); run.status = 'stopped'; settled = true; break; }
      if (run.lastError) {
        markStep(run, st.id, 'error');
        if (opts.autoRun) { hadError = true; settled = true; run.status = 'stopped'; break; }
        const r = await uiRetryGate(run, st);
        if (r === 'retry') { run.lastError = false; continue; }
        if (r === 'stop') { run.status = 'stopped'; settled = true; break; }
        markStep(run, st.id, 'skipped'); run.lastError = false; settled = true; break; // skip
      }
      markStep(run, st.id, 'done'); settled = true;
    }
    if (run.status === 'stopped') break;
  }
  uiRunFinish(run, run && run.status === 'stopped' && !hadError ? 'stopped' : (hadError ? 'error' : 'done'));
}

// ---- Phase 3: runner engine (Phase A — one composed prompt, real skill in a chat process) ----
// ---- multi-run engine: each run is its own object + DOM card (concurrency) ----
const RUNS = new Map();            // runId -> run
let RUN_SEQ = 0;
let ACTIVE_LIMIT = 3;              // max concurrent interactive runs / batch pool size
const RUNS_CONTAINERS = new Map(); // skillName -> .ui-runs element holding run cards
const BATCH_SUMMARIES = new Map(); // skillName -> batch summary element
function runsContainer(name) { let c = RUNS_CONTAINERS.get(name); if (!c) { c = el('div', 'ui-runs'); RUNS_CONTAINERS.set(name, c); } return c; }
function activeRuns() { return [...RUNS.values()].filter((r) => !r.done); }
// DISPLAY: the sentence inside the „really write?" confirmation dialog — it goes to uiConfirm(), never
// to the model, and the prose around it at the fallback below is localised too. So it passes labels,
// unlike every prompt/preview call site.
// `autoRun` rides along too, and that is not cosmetic: a `{{#autoRun}}…{{/autoRun}}` block in an
// effectTemplate used to be dropped here unconditionally, because only `labels` was passed. The prompt
// path (uiComposePrompt) does pass it — so the MODEL was told about the auto-run part while the dialog
// asking „really write?" was not. A confirmation that UNDER-states the effect is the one direction this
// dialog must never fail in, and it would have failed hardest for an unattended run. No manifest uses the
// block inside an effectTemplate today (checked), so this keeps the first one that does honest.
function uiWriteEffect(skill, values, autoRun) {
  const m = skill.manifest || {};
  if (m.effectTemplate) return uiInterpolate(m.effectTemplate, m, values, { labels: UI_YESNO_LABELS(), autoRun: !!autoRun }).trim();
  return t('views-uiskills.derSkill') + (m.title || skill.name) + t('views-uiskills.kannObjekteInExternen');
}
function uiRunStatus(run, text, kind) { if (!run || !run.statusEl) return; run.statusEl.textContent = text; run.dotEl.className = 'urs-dot ' + (kind || ''); }
// m:ss for humans — "4:10" says more about a long run than "250s".
// NOT called fmtClock: classic scripts share one global scope, and this file loads after
// chat-render.js, whose fmtClock(ts) formats a wall-clock TIME. The duplicate name silently won, so
// every message timestamp in the transcript (C13) read „29835839:35" instead of „09:35" — a duration
// formatter fed an epoch. Different job, different name.
function fmtDur(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return s < 60 ? s + 's' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function lastDuration(name) { const v = uiPrefsGet('cc_uiskill_lastdur')[name]; return typeof v === 'number' ? v : 0; }
// "heute 18:30" / "morgen 06:00" / "Fr, 06:00" instead of a bare timestamp
function fmtWhen(ts) {
  if (!ts) return '—';
  const d = new Date(ts), now = new Date();
  const time = d.toLocaleTimeString(LANG === 'en' ? 'en-US' : 'de-DE', { hour: '2-digit', minute: '2-digit' });
  const day = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const tomorrow = new Date(now.getTime() + 86400000);
  if (day(d, now)) return t('views-uiskills.heute') + time;
  if (day(d, tomorrow)) return t('views-uiskills.morgen') + time;
  if (d - now < 7 * 86400000 && d > now) return d.toLocaleDateString(LANG === 'en' ? 'en-US' : 'de-DE', { weekday: 'short' }) + ', ' + time;
  return d.toLocaleDateString(LANG === 'en' ? 'en-US' : 'de-DE') + ' ' + time;
}
// row keys of a skill's PREVIOUS result — the basis for "neu seit letztem Lauf"
function lastKeys(name) { const v = uiPrefsGet('cc_uiskill_lastkeys')[name]; return Array.isArray(v) ? v : null; }
function saveLastKeys(name, norm) {
  const keys = uiResultRowKeys(norm);
  if (!keys.length) return;                       // an empty/0-row result must not erase the baseline
  const o = uiPrefsGet('cc_uiskill_lastkeys'); o[name] = keys.slice(0, 500); uiPrefsSet('cc_uiskill_lastkeys', o);
}
function uiRunTick(run) {
  if (!run || !run.metaEl) return;
  const elapsed = Date.now() - run.startedAt;
  const tin = run.tokensIn || 0, tout = run.tokensOut || 0;
  const tok = (tin || tout) ? ' · ↑' + fmtNum(tin) + ' ↓' + fmtNum(tout) + ' Σ' + fmtNum(tin + tout) + ' tok' : '';
  // where are we, and how long did this skill take last time? (no fake percentage bar)
  let step = '';
  const steps = run.steps || [];
  if (run.mode === 'steps' && steps.length) {
    const st = run.stepStatus || {};
    const settled = steps.filter((s) => ['done', 'skipped', 'error'].indexOf(st[s.id]) >= 0).length;
    const cur = steps.find((s) => st[s.id] === 'running');
    step = t('views-uiskills.schritt-5') + Math.min(settled + (cur ? 1 : 0), steps.length) + '/' + steps.length + (cur ? ' · ' + (cur.title || cur.id) : '') + ' · ';
  }
  const last = run.done ? 0 : lastDuration(run.skill.name);
  run.metaEl.textContent = '(' + step + fmtDur(elapsed) + tok + (last ? ' · ' + t('views-uiskills.zuletzt') + fmtDur(last) : '') + ')';
}
// The card is BUILT inside the assistant bubble (hydration happens where the ```ui-result block stands),
// but "Ergebnis zuerst" hides every direct child of .ui-run-msgs that isn't itself a .ui-result — so a
// card nested in a .msg went invisible with its parent and the run looked empty (while the same card was
// fine in a chat tab, which never collapses). Lift it out to be a direct, FIRST child: it survives the
// fold and lands at the top, which is also where you want to read it.
// Safe to re-parent here: run.tab is a pseudo-tab (uiRunPseudoTab), never ACTIVE, so reRenderAssistants()
// — which rebuilds bubbles from dataset.raw and would re-hydrate a second card — never touches it.
function promoteResultCard(run, card) {
  if (!run || !run.tab || !run.tab.msgEl || !card) return card;
  const host = run.tab.msgEl;
  if (card.parentNode !== host || host.firstChild !== card) host.insertBefore(card, host.firstChild);
  card.classList.add('is-promoted');
  return card;
}
// "Ergebnis zuerst": fold the transcript away once the card is there; gates/follow-ups unfold it again
function collapseRunTranscript(run) {
  if (!run || !run.card || !run.tab) return;
  if (uiPrefsGet('cc_uiskills_prefs').noResultFirst) return;
  const n = run.tab.msgEl.querySelectorAll('.msg').length;
  if (!n) return;
  run.card.classList.add('result-first');
  const acts = run.card.querySelector('.ui-run-finish');
  if (!acts || acts.querySelector('.ui-run-showtrans')) return;
  const btn = el('button', 'ghost-btn ui-run-showtrans', t('views-uiskills.transkriptZeigen') + ' (' + n + ')');
  btn.onclick = () => { expandRunTranscript(run); btn.remove(); };
  acts.appendChild(btn);
}
function expandRunTranscript(run) {
  if (run && run.card) run.card.classList.remove('result-first');
}
let _titleTimer = null;
function flashDocTitle(msg) {
  const orig = document.title; let on = true; clearInterval(_titleTimer);
  _titleTimer = setInterval(() => { document.title = on ? msg : orig; on = !on; }, 900);
  const clear = () => { clearInterval(_titleTimer); document.title = orig; window.removeEventListener('focus', clear); };
  window.addEventListener('focus', clear);
}
// stick-to-bottom only while the user is already near the end — scrolling up to read must not be yanked
// back down by every SSE event; force=true for gates/permission prompts that need attention
function uiRunScroll(run, force) {
  if (!run || !run.tab || !run.tab.msgEl) return;
  const m = run.tab.msgEl;
  if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 80) m.scrollTop = m.scrollHeight;
}
function updateStartBtn() { const b = $('#uiStartBtn'); if (!b) return; const atLimit = activeRuns().length >= ACTIVE_LIMIT; b.disabled = atLimit; const lbl = b.querySelector('.btxt'); if (lbl) lbl.textContent = atLimit ? t('views-uiskills.max-3') + ACTIVE_LIMIT + t('views-uiskills.aktiv') : t('views-uiskills.start'); }
function uiRunPseudoTab(host) {
  const msgEl = el('div', 'ui-run-msgs'); host.appendChild(msgEl);
  return { id: null, msgEl, current: null, toolCards: {}, steps: [], stick: true, streaming: false, phase: '', tokenBase: 0, tokenLive: 0, turnStart: 0, model: null, sessionId: null, title: t('views-uiskills.uiSkill-2'), tabEl: null, queue: [] };
}
// route runner SSE through the shared render helpers with `chat` swapped to this run's pseudo-tab
function uiRunHandle(run, ev) {
  if (!run) return;
  // Every frame carries the chat's monotonic seq (`_seq` = the SSE `id:`). Drop what this run has already
  // seen and remember how far we got — a re-attached stream replays from the top unless it is told better
  // (see uiRunReattach). Without this a follow-up turn re-rendered the whole finished turn and was closed
  // by ITS STALE `result` frame: card "fertig" + transcript collapsed + EventSource shut, while the CLI had
  // only just started the approved work and then hung on a tool permission nobody could answer any more
  // (reported 2026-09-30 for /sync-acme-proj: "habe was ausgewählt, aber der Sync startet nicht").
  if (typeof ev._seq === 'number') {
    if (ev._seq <= (run.lastSeq || 0)) return;
    run.lastSeq = ev._seq;
  }
  const saved = chat; chat = run.tab;
  try { uiRunBody(run, ev); } finally { chat = saved; }
}
function uiRunBody(run, ev) {
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') {
        if (ev.session_id) { run.sessionId = ev.session_id; chat.sessionId = ev.session_id; uiRunStatus(run, t('views-uiskills.laeuft'), 'run'); }
        if (ev.model && run.modelEl) run.modelEl.textContent = ev.model;
      }
      break;
    case 'stream_event': {
      const e = ev.event; if (!e) break;
      // append as a text node (O(delta)) instead of textContent += (O(n) copy per token → O(n²));
      // the final `assistant` event re-renders as markdown via setAssistantText.
      if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && e.delta.text) { ensureBubble().textEl.appendChild(document.createTextNode(e.delta.text)); uiRunScroll(run); }
      break;
    }
    case 'assistant': {
      const content = (ev.message && ev.message.content) || [];
      const textParts = [];
      content.forEach((b) => {
        if (b.type === 'text' && b.text) textParts.push(b.text);
        else if (b.type === 'tool_use') { const cur = ensureBubble(); const card = addToolCard(cur.textEl, b.name, b.input || {}); if (card) run.tab.toolCards[b.id] = card; cur.hasTools = true; } // null while tool display is off (P6)
      });
      if (textParts.length) { const cur = ensureBubble(); setAssistantText(cur.textEl, textParts.join('')); cur.textEl.classList.remove('streaming'); cur.consumed = true; }
      uiRunScroll(run);
      break;
    }
    case 'user': {
      const content = (ev.message && ev.message.content) || [];
      content.forEach((b) => {
        if (b.type !== 'tool_result') return;
        let txt = liveToolResultText(b);
        // The CLI denies non-allow-listed tools (esp. MCP) in plan/default/acceptEdits WITHOUT
        // emitting a can_use_tool control-request — surface that clearly instead of a buried error.
        if (b.is_error && /requested permissions to use|haven'?t granted it yet/i.test(txt || '')) {
          const m = (txt || '').match(/use (mcp__[\w.-]+|[A-Za-z][\w.-]*)/);
          uiRunPermDenied(run, m ? m[1] : null);
        }
        const card = run.tab.toolCards[b.tool_use_id];
        if (card && txt) { if (txt.length > 4000) txt = txt.slice(0, 4000) + t('chat-events.gekuerzt'); addToolOutput(card, txt, !!b.is_error); }
      });
      break;
    }
    case 'control_request':
      if (ev.request && ev.request.subtype === 'can_use_tool') uiRunPermission(run, ev);
      break;
    case 'result':
      if (ev.usage) {
        run.tokensOut = (run.tokensOut || 0) + (ev.usage.output_tokens || 0);
        run.tokensIn = (run.tokensIn || 0) + (ev.usage.input_tokens || 0) + (ev.usage.cache_read_input_tokens || 0) + (ev.usage.cache_creation_input_tokens || 0);
      }
      uiRunTick(run);
      // whoever awaits a turn owns the event: steps mode, or a follow-up turn fired from the result card
      if (run.mode === 'steps' || run._await) { run.lastError = !!ev.is_error; const r = run._await; run._await = null; if (r) r(); }
      else uiRunFinish(run, ev.is_error ? 'error' : (run.status === 'stopped' ? 'stopped' : 'done'), ev);
      break;
    case '_exit':
      if (run._await) { run.lastError = !!ev.code; const r = run._await; run._await = null; r(); }
      else uiRunFinish(run, run.status === 'stopped' ? 'stopped' : (ev.code ? 'error' : 'done'), ev);
      break;
    case '_error':
      if (run._await) { run.lastError = true; const r = run._await; run._await = null; r(); }
      else uiRunFinish(run, run.status === 'stopped' ? 'stopped' : 'error', ev);
      break;
    case '_superseded':
      // CHAT-FLOW-4 — a chat tab or another window took this run's session over ([Hier übernehmen]); the server
      // ends the process right after this frame. Closed HERE, so the end of the stream is not read as a lost
      // connection (uiRunStreamLost would re-attach to a chat that is gone and then say „Verbindung verloren").
      // Recorded as stopped — it was stopped, by the takeover — and the status line says by what (uiRunFinish).
      run.superseded = true;
      if (run.es) { try { run.es.close(); } catch { /* */ } run.es = null; }
      if (run._await) { run.lastError = true; const r = run._await; run._await = null; r(); }
      else uiRunFinish(run, 'stopped', ev);
      break;
  }
}
function uiRunPermission(run, ev) {
  expandRunTranscript(run); // same for a tool-permission prompt
  const req = ev.request || {};
  const requestId = ev.request_id || ev.requestId;
  const tool = req.tool_name || req.toolName || 'tool';
  const post = (behavior) => api('/api/chat/' + run.chatId + '/permission', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, behavior }) }).catch(() => {});
  // autoRun auto-approves everything; "Immer" blesses a specific tool for the rest of this run.
  if (run.autoRun || (run.alwaysAllow && run.alwaysAllow.has(tool))) { post('allow'); return; }
  const box = el('div', 'ui-perm');
  box.appendChild(el('div', 'ui-perm-q', t('views-uiskills.toolFreigabe') + tool));
  if (req.description) box.appendChild(el('div', 'ui-perm-desc', req.description));
  const pre = el('pre', 'ui-perm-input'); pre.textContent = JSON.stringify(req.input || req.tool_input || {}, null, 2); box.appendChild(pre);
  const bp = req.blocked_path || req.blockedPath; if (bp) box.appendChild(el('div', 'ui-perm-blocked', t('views-uiskills.blockierterPfad') + bp));
  const persistWrap = el('label', 'ui-perm-persist'); const persistCb = el('input'); persistCb.type = 'checkbox';
  persistWrap.appendChild(persistCb); persistWrap.appendChild(el('span', null, t('views-uiskills.dauerhaftSettingsLocal')));
  const row = el('div', 'ui-perm-row');
  const allow = el('button', 'primary-btn', t('common.erlauben'));
  const always = el('button', 'ghost-btn', t('views-uiskills.immer')); always.title = t('views-uiskills.diesesToolFuerDen');
  const deny = el('button', 'ghost-btn', t('common.ablehnen'));
  const waiterKey = 'run:' + run.id + ':' + requestId;
  const done = () => { if (typeof clearPermWaiter === 'function') clearPermWaiter(waiterKey); box.remove(); };
  allow.onclick = () => { done(); post('allow'); };
  deny.onclick = () => { done(); post('deny'); };
  always.onclick = async () => {
    done();
    run.alwaysAllow = run.alwaysAllow || new Set();
    run.alwaysAllow.add(tool);                                   // rest of this run: auto-approve
    if (persistCb.checked && tool && typeof localPermAdd === 'function') {
      try { await localPermAdd('allow', tool); } catch { /* localPermAdd reports its own failure */ }
    }
    post('allow');
  };
  row.appendChild(allow); row.appendChild(always); row.appendChild(deny);
  box.appendChild(row); box.appendChild(persistWrap);
  run.tab.msgEl.appendChild(box); uiRunScroll(run, true);
  try { box.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* */ }   // make the prompt visible immediately
  // register the floating "Freigabe ausstehend" jump target
  if (typeof registerPermWaiter === 'function') registerPermWaiter(waiterKey, () => {
    try { box.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* */ }
    box.classList.remove('perm-flash'); void box.offsetWidth; box.classList.add('perm-flash');
    const a = box.querySelector('.primary-btn'); if (a) a.focus();
  });
}
// Fallback banner — with `--permission-prompt-tool stdio` the CLI now normally asks (the inline
// Erlauben/Ablehnen prompt fires). This only shows when a tool is denied WITHOUT a prompt — a
// standing deny-rule, plan/Testlauf mode, or an edge tool the CLI still auto-denies.
function uiRunPermDenied(run, tool) {
  run.permDenied = run.permDenied || new Set();
  const key = tool || '_';
  if (run.permDenied.has(key)) return; run.permDenied.add(key);
  run.hadPermDenied = true;
  const mode = (run.skill.manifest.run || {}).permissionMode || 'plan';
  const box = el('div', 'ui-perm-denied');
  box.appendChild(el('div', 'upd-title', t('views-uiskills.toolNichtFreigegeben') + (tool ? ': ' + tool : '')));
  box.appendChild(el('div', 'upd-body', t('views-uiskills.dasToolWurdeOhne') + mode + t('views-uiskills.bzwEineDenyRegel')));
  const row = el('div', 'upd-row');
  if (tool && typeof localPermAdd === 'function') {
    const allow = el('button', 'ghost-btn', t('views-uiskills.toolErlauben'));
    allow.onclick = async () => {
      allow.disabled = true;
      if (await localPermAdd('allow', tool)) allow.textContent = t('views-uiskills.erlaubtLaufNeuStarten');
      else allow.disabled = false;
    };
    row.appendChild(allow);
  }
  const openPerms = el('button', 'ghost-btn', t('views-uiskills.berechtigungenOeffnen'));
  openPerms.onclick = () => { if (typeof showView === 'function') showView('settings'); const nav = document.querySelector('.sett-nav a[href="#sec-perms"]'); if (nav) nav.click(); };
  row.appendChild(openPerms);
  box.appendChild(row);
  box.appendChild(el('div', 'upd-hint', t('views-uiskills.oderDenSkillIm')));
  run.tab.msgEl.appendChild(box); uiRunScroll(run, true);
}
function uiRunFinish(run, status, ev) {
  if (!run || run.done) return;
  run.done = true; run.status = status; run.streaming = false;
  if (typeof PERM_WAITERS !== 'undefined') for (const k of [...PERM_WAITERS.keys()]) if (k.indexOf('run:' + run.id + ':') === 0) clearPermWaiter(k); // drop any stale pending-approval marker
  if (run.timer) { clearInterval(run.timer); run.timer = null; }
  uiRunTick(run);
  if (run.es) { try { run.es.close(); } catch {} run.es = null; }
  if (ev && (ev.type === '_exit' || ev.type === '_error') && (ev.stderr || ev.message)) { const s = el('div', 'msg system'); s.textContent = ev.message || ev.stderr; run.tab.msgEl.appendChild(s); }
  // CHAT-FLOW-4 — why the run ended, when it was not the skill: taken over by another tab or window, or a
  // follow-up the server refused because one of those holds the session. „Gestoppt"/„Fehler" alone would
  // send the reader looking for a fault in the skill.
  if (run.superseded) uiRunStatus(run, t('views-uiskills.uebernommen'), 'stopped');
  else if (run.heldElsewhere) uiRunStatus(run, t('views-uiskills.sitzungAnderswoKurz'), 'error');
  else if (run.hadPermDenied && status === 'done') uiRunStatus(run, t('views-uiskills.toolNichtFreigegeben'), 'error');
  else uiRunStatus(run, status === 'done' ? t('views-uiskills.fertig-3') : status === 'error' ? t('views-uiskills.fehler') : t('views-uiskills.gestoppt-2'), status);
  if (run.stopBtn) run.stopBtn.remove();
  if (run.pauseBtn) run.pauseBtn.remove();
  updateStartBtn();
  // extract BEFORE recording — recordUiRun persists run.resultData into the history
  const mm = run.skill.manifest || {};
  const prevKeys = lastKeys(run.skill.name); // BEFORE recordUiRun overwrites the baseline
  const resultData = extractResults(mm, run.tab);
  run.resultData = resultData;
  run.resultMatches = resultData ? resultData.rows.map((r) => r.join(' ')) : [];
  recordUiRun(run, status);
  const label = (run.skill.manifest || {}).title || run.skill.name;
  run.tab.msgEl.querySelectorAll('.ui-run-finish').forEach((x) => x.remove()); // a follow-up turn must not stack footers
  const acts = el('div', 'ui-run-finish');
  const cp = iconBtn('ghost-btn', 'copy', { label: t('views-uiskills.transkriptKopieren') }); cp.onclick = () => { copyText(run.tab.msgEl.innerText); toast(t('views-uiskills.transkriptKopiert'), 'ok'); }; acts.appendChild(cp);
  if (run.sessionId && typeof openResumeInChat === 'function') { const rc = iconBtn('ghost-btn', 'chat', { label: t('views-uiskills.inChatFortsetzen') }); const sid = run.sessionId, cwd = (run.skill.manifest.run || {}).cwd; rc.onclick = () => openResumeInChat(sid, cwd); acts.appendChild(rc); }
  run.tab.msgEl.appendChild(acts);
  // The card is normally already IN the transcript (hydrated where the block appeared). Append one only
  // if this result is new — otherwise just re-arm the existing card so the follow-up button lives on.
  if (resultData) {
    const fp = uiResultFingerprint(resultData);
    const inline = [...run.tab.msgEl.querySelectorAll('.ui-result[data-fp]')].filter((c) => c.dataset.fp === fp).pop();
    if (inline) { inline.classList.remove('is-stale'); const mk = inline.querySelector('.ui-result-stalemark'); if (mk) mk.remove(); run.resultCard = inline; }
    else run.resultCard = renderResultBlock(mm, resultData, status, run, prevKeys); // incl. explicit 0-state
    promoteResultCard(run, run.resultCard); // top of the run, above the transcript AND above .ui-run-finish
    if (resultData.rows.length) collapseRunTranscript(run); // the result is what you came for
  }
  if (!run.batch) {
    const stTxt = status === 'done' ? t('views-uiskills.fertig-3') : status === 'error' ? t('views-uiskills.fehler') : t('views-uiskills.gestoppt');
    toast(t('views-uiskills.uiSkill-5') + label + t('views-uiskills.sym375kpt') + stTxt, status === 'error' ? 'err' : 'ok');
    const notLooking = document.hidden || !$('#view-uiskills').classList.contains('active');
    if (notLooking) { flashDocTitle((status === 'done' ? '✓ ' : '⚠ ') + label + ' ' + stTxt); uiNotify((status === 'done' ? '✓ ' : '⚠ ') + label, t('views-uiskills.uiSkill-4') + stTxt); }
  }
  uiRunScroll(run);
  if (run.onDone) { const cb = run.onDone; run.onDone = null; cb(run); }
  maybeChain(run);
}
// ---- hydration: a ```ui-result block becomes a real card WHERE IT STANDS in the transcript --------
// This is what makes the card appear mid-run (a skill that emits its block in an intermediate step is
// readable after ~1 minute instead of after the whole run) and gives ordinary chat tabs the same card
// as the UI-Skills view. render.js leaves a <details class="md-uiresult"> placeholder holding the raw
// JSON; we parse that, insert the card before it and keep the JSON as a collapsed "Rohdaten" footer.
function hydrateResultBlocks(container) {
  if (!container || !container.querySelectorAll || typeof uiResultNormalize !== 'function') return;
  const hosts = [...container.querySelectorAll('details.md-uiresult:not(.is-hydrated)')];
  if (!hosts.length) return;
  // whose transcript is this? → the manifest supplies actions/followUp, the run is what a follow-up continues
  let run = null, manifest = {}, chatTab = null, skillName = '';
  try {
    run = [...RUNS.values()].find((r) => r.tab && r.tab.msgEl && r.tab.msgEl.contains(container)) || null;
    if (run) { manifest = run.skill.manifest || {}; skillName = run.skill.name; }
    else {
      const tab = (typeof TABS !== 'undefined' ? TABS : []).find((x) => x && x.msgEl && x.uiSkill && x.msgEl.contains(container));
      // a UI-skill launched into a chat tab keeps its manifest on the tab → same actions, same buttons
      if (tab) { manifest = tab.uiSkill.manifest || {}; chatTab = tab; skillName = tab.uiSkill.name || ''; }
    }
  } catch { /* best effort — a card without a manifest still renders */ }
  hosts.forEach((host) => {
    host.classList.add('is-hydrated');
    const code = host.querySelector('code');
    let norm = null;
    try { norm = uiResultNormalize(JSON.parse(code ? code.textContent : '')); } catch { return; } // invalid → JSON stays visible
    if (!norm) return;
    // A re-render of the same block (raw/markdown or language toggle) must not stack a second card next
    // to the one already promoted out of this bubble — same fingerprint, same card.
    if (run && run.tab && run.tab.msgEl) {
      const dup = [...run.tab.msgEl.querySelectorAll('.ui-result.is-promoted[data-fp]')].find((c) => c.dataset.fp === uiResultFingerprint(norm));
      if (dup) { host.remove(); return; }
    }
    const card = renderResultBlock(manifest, norm, 'done', run, skillName ? lastKeys(skillName) : null, { tab: chatTab });
    host.parentNode.insertBefore(card, host);
    const sum = host.querySelector('summary');
    if (sum) sum.textContent = '{ } ' + t('views-uiskills.rohdaten');
    host.open = false;
    card.appendChild(host);
    // within one run, an earlier card is superseded by this one
    if (run && run.tab && run.tab.msgEl) {
      run.tab.msgEl.querySelectorAll('.ui-result[data-fp]').forEach((c) => { if (c !== card) markResultStale(c); });
      // Lift it to the top right away — a skill that emits its block in an intermediate step (e.g. the
      // sync skill's "plan" step) is then readable mid-run instead of only after the whole run.
      promoteResultCard(run, card);
      run.resultCard = card;
    }
  });
}
// ---- follow-up turns: keep working inside the finished run's own card (manifest result.followUp) ----
// uiRunFinish only closes the EventSource, not the chat process — so a follow-up re-attaches and sends.
// If the process is gone (orphan reaper, server restart), start a fresh one with `resume: <sessionId>`:
// same session, same context, output keeps landing in this card.
function uiRunReattach(run) {
  if (run.es) return;
  // `from=` picks up where this run stopped listening instead of replaying the finished turn (server:
  // /api/chat/<id>/stream). EventSource cannot send Last-Event-ID on a stream WE closed, so it has to
  // travel in the URL.
  run.es = new EventSource('/api/chat/' + run.chatId + '/stream' + (run.lastSeq ? '?from=' + run.lastSeq : ''));
  run.es.onmessage = (e) => { try { uiRunHandle(run, JSON.parse(e.data)); } catch (err) { console.warn('ui-run bad event', err); } };
  run.es.onerror = () => uiRunStreamLost(run);
}
// RUN-SSE — the error channel of a run was `onerror = () => {}` at both places that open the stream: the
// ONE kind of failure a run cannot report in-band (every other one arrives as a `_exit`/`_error`/`result`
// frame and is handled in uiRunHandle) was thrown away without a word. The consequence is not a missing
// toast, it is a lie that lasts: the card keeps its running dot, the 1 s ticker keeps counting up, and the
// run sits at „läuft" for ever — including a Testlauf, where that is all there is to look at. The chat tab
// has handled exactly this since #25 (chat-events.js, `readyState === 2` = CLOSED is fatal, everything
// else is EventSource reconnecting on its own); this is the same distinction for a run.
//
// What it does NOT do is call uiRunFinish('error'): we do not know that the skill failed. The process may
// well still be working — only our ear on it is gone. So: one silent re-attach (the usual cause is the
// panel server restarting underneath), and if that stream closes too, say THAT, with the one action that
// can still help. The run stays un-done, so „Stop" and a follow-up remain available.
function uiRunStreamLost(run) {
  if (!run || !run.es || run.es.readyState !== 2) return;  // 0 CONNECTING / 1 OPEN → it is retrying itself
  try { run.es.close(); } catch { /* */ }
  run.es = null;
  if (run.done) return;                                    // finished runs close their own stream
  if (!run._reattached && run.chatId) { run._reattached = true; uiRunReattach(run); return; }
  if (run.timer) { clearInterval(run.timer); run.timer = null; } // the clock would keep claiming progress
  uiRunStatus(run, t('views-uiskills.verbindungVerloren'), 'error');
  if (run.tab && run.tab.msgEl) { const s = el('div', 'msg system is-error'); s.textContent = '⚠ ' + t('views-uiskills.verbindungVerlorenHinweis'); run.tab.msgEl.appendChild(s); }
  // defensive on `run.skill`: this runs inside an onerror handler, where a thrown TypeError would be a
  // second swallowed failure in the very place that exists to stop swallowing them
  if (typeof logEvent === 'function') logEvent(((run.skill && run.skill.name) || '?') + ': ' + t('views-uiskills.verbindungVerloren'), 'err');
}
async function uiRunResume(run) {
  const m = run.skill.manifest || {};
  const body = { cwd: (m.run && m.run.cwd) || undefined, permissionMode: run.dryRun ? 'plan' : ((m.run && m.run.permissionMode) || 'plan'), model: (m.run && m.run.model) || undefined, fallbackModel: (m.run && m.run.fallbackModel) || undefined, effort: (m.run && m.run.effort) || undefined, resume: run.sessionId || undefined };
  // CHAT-FLOW-4 — the takeover the user confirmed on the „woanders offen" notice (uiRunHeldElsewhere), once
  if (run._takeover) { body.takeover = true; run._takeover = false; }
  // CHAT-FLOW-4 — our OWN stream goes BEFORE the POST. The server refuses to resume a session a browser
  // stream is attached to, and a follow-up re-attaches first (uiRunFollowUp) — so a /send that failed for any
  // other reason (network, 500) used to send this resume while the run's own stream still held its process,
  // and the run would have been refused by itself. Closed first, the server's settle window sees it go.
  if (run.es) { try { run.es.close(); } catch { /* */ } run.es = null; }
  const r = await api('/api/chat/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  run.chatId = r.chatId;
  run.heldElsewhere = false;
  run.lastSeq = 0;   // a new process = a new seq space (starts at 1); keeping the old high-water mark would drop every frame
  uiRunReattach(run);
}
function uiRunTurn(run, text) {
  const post = () => api('/api/chat/' + run.chatId + '/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  return new Promise((resolve) => {
    run._await = resolve; run.lastError = false;
    post().catch(async () => {
      try { await uiRunResume(run); await post(); }
      catch (e) {
        // held by a chat tab or another window (typically after „In Chat fortsetzen"): said as that, with the
        // takeover — not a bare „Fehler" on the card
        if (e && e.code === 'session-open-elsewhere') uiRunHeldElsewhere(run, text, e);
        run.lastError = true; const r = run._await; run._await = null; if (r) r();
      }
    });
  });
}
// CHAT-FLOW-4 — a follow-up turn of this run could not continue the session: another tab or window holds it.
// The run's text is kept on the notice, so [Hier übernehmen] can send exactly that turn again — with the
// takeover, and only after the same confirm a chat tab shows (fresh from GET /api/session/open, so a turn that
// is running there NOW is named).
function uiRunHeldElsewhere(run, text, err) {
  run.heldElsewhere = true;
  if (!run.tab || !run.tab.msgEl) return;
  run.tab.msgEl.querySelectorAll('.ui-run-elsewhere').forEach((x) => x.remove());
  const d = (err && err.data) || {};
  const box = el('div', 'msg system is-error ui-run-elsewhere');
  box.appendChild(el('div', null, '⇄ ' + t('views-uiskills.sitzungAnderswoText') + (d.busy ? ' ' + t('views-uiskills.sitzungAnderswoTurn') : '')));
  const take = el('button', 'ghost-btn', t('chat-events.hierUebernehmen'));
  take.onclick = async () => {
    let st = null;
    try { st = await api('/api/session/open?id=' + encodeURIComponent(run.sessionId || '')); } catch { st = null; }
    if (st && !st.open) { /* nobody holds it any more → the plain resume of the follow-up will do */ }
    else if (!(await uiConfirm(t(takeoverQuestion(st)), { title: t('chat.uebernehmenTitel'), danger: true, okLabel: t('chat.uebernehmenOk') }))) return;
    else run._takeover = true;
    // the confirm was for THIS follow-up: should it bail (another one is still running), the takeover is taken back
    // — left armed, a later resume of this run would send `takeover` nobody confirmed — and the notice comes back,
    // so the way to take over is not gone with it. (Once the follow-up runs, uiRunResume uses the takeover up:
    // whoever holds the session got it by a resume, and a resume ends every other process of the session — so the
    // run's own is gone, its /send fails and the turn resumes.)
    const notice = box.parentElement;
    box.remove();
    uiRunFollowUp(run, text, () => { run._takeover = false; if (notice) notice.appendChild(box); });
  };
  box.appendChild(take);
  run.tab.msgEl.appendChild(box);
  uiRunScroll(run, true);
}
async function uiRunFollowUp(run, text, onBail) {
  // Every bail-out here used to be a silent `return` — the card's button went dead and the user had
  // no idea why (reported 2026-09-17: "zweimal geklickt, nichts passiert"). Say it and hand control back.
  const bail = (key) => { toast(t(key), 'err'); if (typeof onBail === 'function') onBail(); };
  if (!run) return;
  if (run.followBusy) return bail('views-uiskills.folgeschrittNochAktiv');
  if (!run.chatId) return bail('views-uiskills.folgeschrittOhneSitzung');
  run.followBusy = true;
  run.followTurns = (run.followTurns || 0) + 1;
  run.done = false; run.status = 'running'; run.recorded = false; // the follow-up earns its own history entry
  if (!run.timer) run.timer = setInterval(() => uiRunTick(run), 1000);
  expandRunTranscript(run); // show what the follow-up actually does
  uiRunReattach(run);
  uiRunStatus(run, t('views-uiskills.folgeschrittLaeuft'), 'run');
  run.tab.msgEl.appendChild(el('div', 'ui-follow-echo', '↩ ' + String(text).replace(/\s+/g, ' ').slice(0, 240)));
  uiRunScroll(run, true);
  run.superseded = false; run.heldElsewhere = false; // a new turn — how the last one ended is history (CHAT-FLOW-4)
  await uiRunTurn(run, text);
  run.followBusy = false; run.done = false;                       // uiRunFinish bails out on a done run
  uiRunFinish(run, run.superseded ? 'stopped' : run.lastError ? 'error' : 'done');
}
// pipeline: feed a finished run's result columns into a chained skill's inputs (opt-in via manifest.chain)
function maybeChain(run) {
  const m = run.skill.manifest || {};
  if (!m.chain || !m.chain.skill || run.batch || run.status !== 'done' || run.followTurns) return; // chain once, on the original finish
  if ((run.chainDepth || 0) >= 4) { toast(t('views-uiskills.verkettungMaxTiefeErreicht'), 'err'); return; }
  const next = (UISKILLS_DATA || []).find((x) => x.name === m.chain.skill);
  if (!next) { toast(t('views-uiskills.verkettungSkill') + m.chain.skill + t('views-uiskills.nichtGefunden'), 'err'); return; }
  const nvals = uiDefaultValues(next.manifest || {});
  const rd = run.resultData; const firstRow = (rd && rd.rows[0]) || [];
  const colIndex = {}; (rd ? rd.columns : []).forEach((c, i) => { colIndex[c.id] = i; if (!(c.label in colIndex)) colIndex[c.label] = i; });
  Object.entries(m.chain.map || {}).forEach(([inputId, colName]) => {
    const cn = String(colName).replace(/[{}]/g, '').trim();
    if (cn in colIndex && inputId in nvals) nvals[inputId] = firstRow[colIndex[cn]];
  });
  toast(t('views-uiskills.verkettung') + (next.manifest.title || next.name), 'ok');
  startUiRun(next, nvals, { autoRun: run.autoRun, dryRun: run.dryRun, mode: 'single', chainDepth: (run.chainDepth || 0) + 1 });
}
// extract results from the transcript → normalized { source, summary, columns:[{id,label,type,linkBase?}], rows }.
// preferred: a ```ui-result JSON block (shared parser in ui-result.js); fallback: the legacy regex.
function extractResults(m, tab) {
  const text = [...tab.msgEl.querySelectorAll('.msg.assistant .bubble')].map((b) => b.dataset.raw || b.innerText).join('\n');
  return uiResultExtract(text) || uiResultFromPattern(text, m, { defaultLabel: t('views-uiskills.ergebnis') });
}
// old persisted runs / stray callers may still carry string columns → lift to the normalized shape
function normalizeResultData(data) {
  if (!data || !Array.isArray(data.columns) || !data.columns.length) return null;
  const columns = data.columns.map((c) => (c && typeof c === 'object') ? c : { id: String(c), label: String(c), type: 'text' });
  const out = { source: data.source || 'regex', summary: data.summary || '', columns, rows: Array.isArray(data.rows) ? data.rows : [] };
  if (Array.isArray(data.stats) && data.stats.length) out.stats = data.stats;     // v2 extras must survive
  if (Array.isArray(data.groups) && data.groups.length) out.groups = data.groups; // (history re-render!)
  if (Array.isArray(data.expand) && data.expand.length) out.expand = data.expand; // expandable rows (v3)
  else if (typeof data.expandSrc === 'string' && data.expandSrc) out.expandSrc = data.expandSrc; // …or their file
  return out;
}
// GFM table (for pasting into Jira/Teams/Markdown docs)
function resultToMarkdown(data) {
  const esc = (v) => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [];
  if (data.summary) lines.push(data.summary, '');
  lines.push('| ' + data.columns.map((c) => esc(c.label)).join(' | ') + ' |');
  lines.push('|' + data.columns.map(() => ' --- ').join('|') + '|');
  data.rows.forEach((r) => lines.push('| ' + r.map(esc).join(' | ') + ' |'));
  return lines.join('\n');
}
// SEC-7: csvRows (public/js/csv.js) instead of a local `esc`. Of the three CSV writers in this project
// this is the one whose cells are MODEL-written, so a value starting with `=`/`@`/`-` is likeliest here.
// The rule, and its deliberate exception for negative numbers, is documented in that file.
function resultToCsv(data) {
  return csvRows([data.columns.map((c) => c.label), ...data.rows]);
}
// ---- result card: KPI stats · collapsible sections · detail lines · filter (ui-result v2) ----------
// The layout lives in the column TYPES (see public/js/ui-result.js): a `group` column buckets rows into
// <details> sections instead of being a cell (several group columns = the grouping switch in the head),
// a `detail` column becomes a wrapped second line under its row. A v1 block (text/link/badge/number
// only) still renders as the plain flat table it always did.
const RESULT_VIEW_PREF = 'cc_uiskill_resultview'; // { "<card key>": "<group column id>" | "__flat" }
const RESULT_FLAT = '__flat';
function resultToneCls(tone) { return tone ? ' tone-' + tone : ''; }
function resultStatsStrip(stats) {
  const wrap = el('div', 'ui-result-stats');
  stats.forEach((s) => {
    const chip = el('span', 'ui-result-stat' + resultToneCls(s.tone));
    if (s.value !== '' && s.value != null) chip.appendChild(el('span', 'urst-v', String(s.value)));
    if (s.label) chip.appendChild(el('span', 'urst-k', String(s.label)));
    wrap.appendChild(chip);
  });
  return wrap;
}
// ⛶ full screen for a result: the card is MOVED into the overlay, never copied — so the checkbox
// selection, the filter, the sort order and the follow-up button all stay alive across the switch.
function toggleResultMax(box) {
  if (!box) return;
  if (box.classList.contains('is-max')) { closeResultMax(box); return; }
  const ph = el('div', 'ui-result-maxph');
  if (box.parentNode) box.parentNode.insertBefore(ph, box);
  const ov = el('div', 'ui-result-max-overlay');
  ov.appendChild(box);
  box.classList.add('is-max');
  box._maxPh = ph; box._maxOv = ov;
  ov.onclick = (e) => { if (e.target === ov) closeResultMax(box); };
  document.body.appendChild(ov);
  // Esc + Tab + z-index are the overlay stack's (overlays.js). This card had NO focus trap at all, which
  // on a maximised result (checkboxes, column menu, filter, follow-up button) meant Tab walked out of a
  // full-screen overlay into the page it covers. autofocus:false — the filter field is focused below.
  // The stack also fixes ZINDEX-1 here: this overlay was the one at z-index 60 that a uiConfirm() raised
  // from inside the card (z-index 50) opened BEHIND. Depth decides now, not two CSS constants.
  overlayPush(ov, { box, autofocus: false, onEsc: () => closeResultMax(box) });
  const btn = box.querySelector('.ui-result-max');
  if (btn) { btn.textContent = '⤡'; btn.title = t('views-uiskills.ergebnisVerkleinern'); }
  const f = box.querySelector('.ui-result-filter');
  if (f) f.focus();
}
function closeResultMax(box) {
  if (!box || !box.classList.contains('is-max')) return;
  box.classList.remove('is-max');
  if (box._maxOv) overlayPop(box._maxOv);
  const ph = box._maxPh;
  if (ph && ph.parentNode) { ph.parentNode.insertBefore(box, ph); ph.remove(); }
  if (box._maxOv) { box._maxOv.remove(); box._maxOv = null; }
  box._maxPh = null;
  const btn = box.querySelector('.ui-result-max');
  if (btn) { btn.textContent = '⛶'; btn.title = t('views-uiskills.ergebnisVergroessern'); }
}
// ---- card exports: a result is often the thing you forward to someone ------------------------------
// Rich-HTML clipboard is the reliable path (paste into Teams/Outlook/Word keeps the table); the PNG
// route uses the SVG-foreignObject trick and is best-effort — no dependencies either way.
function resultToHtml(data, title) {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const cols = data.columns.filter((c) => c.type !== 'group' && c.type !== 'detail');
  const gi = data.columns.findIndex((c) => c.type === 'group');
  const detIdx = data.columns.map((c, i) => (c.type === 'detail' ? i : -1)).filter((i) => i >= 0);
  const idxOf = (c) => data.columns.indexOf(c);
  let h = '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#222">';
  if (title) h += '<div style="font-weight:700;font-size:15px;margin-bottom:4px">' + esc(title) + '</div>';
  if (data.summary) h += '<div style="margin-bottom:8px">' + esc(data.summary) + '</div>';
  if (data.stats && data.stats.length) h += '<div style="margin-bottom:8px">' + data.stats.map((s) => '<b>' + esc(s.value) + '</b> ' + esc(s.label)).join(' &nbsp;·&nbsp; ') + '</div>';
  h += '<table border="1" cellspacing="0" cellpadding="5" style="border-collapse:collapse;border-color:#ccc">';
  h += '<tr style="background:#f2f2f2">' + (gi >= 0 ? '<th align="left">' + esc(data.columns[gi].label) + '</th>' : '') + cols.map((c) => '<th align="left">' + esc(c.label) + '</th>').join('') + '</tr>';
  // expand panels travel with the export only for the rows the caller passes in `data.expand`
  // (exportView re-indexes them to the exported rows and keeps the OPEN ones — exports follow what you see)
  const xcol = data.columns.find((c) => c.type === 'expand') || null;
  const xmap = {};
  (Array.isArray(data.expand) ? data.expand : []).forEach((e) => { if (e && typeof e.row === 'number') xmap[e.row] = e; });
  const span = cols.length + (gi >= 0 ? 1 : 0);
  const panelHtml = (e) => {
    const sides = e.sides || (xcol && xcol.sides) || ['', ''];
    const li = (items, side) => items.filter((it) => it.side === side).map((it) => '<div style="font-size:11.5px;color:#444">• ' + esc(it.text) + (it.mark ? ' <i>' + esc(it.mark) + '</i>' : '') + '</div>').join('');
    let p = '<table cellspacing="0" cellpadding="3" style="border-collapse:collapse;font-size:12px;margin:2px 0 4px 18px">';
    p += '<tr style="color:#666"><th></th><th align="left">' + esc(sides[0]) + '</th><th>⇄</th><th align="left">' + esc(sides[1]) + '</th></tr>';
    (e.rows || []).forEach((x) => {
      const items = Array.isArray(x.items) ? x.items : [];
      p += '<tr><td style="color:#666"><b>' + esc(x.label) + '</b></td><td>' + esc(x.left) + '</td><td align="center"><b>' + esc(x.mark) + '</b></td><td>' + esc(x.right) + '</td></tr>';
      if (x.note) p += '<tr><td></td><td colspan="3" style="color:#666;font-size:11.5px">' + esc(x.note) + '</td></tr>';
      const L = li(items, 'left'), R = li(items, 'right'), B = li(items, 'both');
      if (L || R) p += '<tr valign="top"><td></td><td>' + L + '</td><td></td><td>' + R + '</td></tr>';
      if (B) p += '<tr><td></td><td colspan="3">' + B + '</td></tr>';
    });
    p += '</table>';
    if (e.notes && e.notes.length) p += '<div style="color:#666;font-size:11.5px;margin-left:18px">' + e.notes.map(esc).join(' · ') + '</div>';
    return p;
  };
  data.rows.forEach((r, ri) => {
    h += '<tr>' + (gi >= 0 ? '<td>' + esc(r[gi]) + '</td>' : '') + cols.map((c) => '<td>' + esc(r[idxOf(c)]) + '</td>').join('') + '</tr>';
    const det = detIdx.map((i) => String(r[i] || '').trim()).filter(Boolean).join(' · ');
    if (det) h += '<tr><td colspan="' + span + '" style="color:#666;font-size:12px">' + esc(det) + '</td></tr>';
    if (xmap[ri]) h += '<tr><td colspan="' + span + '">' + panelHtml(xmap[ri]) + '</td></tr>';
  });
  return h + '</table></div>';
}
// plainText (optional, P2 „Bericht kopieren" in projects.js): the text/plain half when the caller has a fuller one than
// the table's own Markdown — the rich HTML still comes from `data`
async function copyResultHtml(data, title, plainText) {
  const html = resultToHtml(data, title);
  const text = typeof plainText === 'string' ? plainText : resultToMarkdown(data);
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
      toast(t('views-uiskills.alsHtmlKopiert'), 'ok');
      return;
    }
  } catch { /* fall through to plain text */ }
  copyText(text);
  toast(t('views-uiskills.markdownKopiert'), 'ok');
}
// PNG via <foreignObject>: the card's HTML is serialized WITH inlined computed styles (an SVG has no
// access to the page stylesheet). Chromium/Edge handle this; on failure we say so instead of pretending.
const PNG_STYLE_PROPS = ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-align',
  'border', 'border-radius', 'border-bottom', 'border-top', 'border-left', 'border-right', 'padding', 'margin',
  'display', 'flex-direction', 'align-items', 'justify-content', 'gap', 'flex-wrap', 'width', 'max-width', 'white-space', 'line-height', 'letter-spacing'];
function inlineStyles(src, dst) {
  const cs = getComputedStyle(src);
  let s = '';
  PNG_STYLE_PROPS.forEach((p) => { const v = cs.getPropertyValue(p); if (v) s += p + ':' + v + ';'; });
  dst.setAttribute('style', s);
  const a = src.children, b = dst.children;
  for (let i = 0; i < a.length && i < b.length; i++) inlineStyles(a[i], b[i]);
}
async function saveResultPng(box, name) {
  try {
    const w = Math.ceil(box.getBoundingClientRect().width) || 900;
    const clone = box.cloneNode(true);
    clone.querySelectorAll('.ui-result-head .ghost-btn, .ui-result-head .primary-btn, .ui-result-tools, .md-uiresult, input, .ui-result-checkcol, .ui-result-actcell, .urx-toggle').forEach((x) => x.remove());
    inlineStyles(box, clone);
    const wrap = document.createElement('div');
    wrap.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    wrap.style.cssText = 'width:' + w + 'px;background:' + getComputedStyle(box).backgroundColor + ';padding:14px;box-sizing:border-box';
    wrap.appendChild(clone);
    document.body.appendChild(wrap);
    const h = Math.ceil(wrap.getBoundingClientRect().height) || 600;
    document.body.removeChild(wrap);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">'
      + '<foreignObject width="100%" height="100%">' + new XMLSerializer().serializeToString(wrap) + '</foreignObject></svg>';
    const img = new Image();
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('render')); img.src = url; });
    const scale = 2; // crisp on a high-dpi screen / in a Teams post
    const cv = document.createElement('canvas'); cv.width = w * scale; cv.height = h * scale;
    const ctx = cv.getContext('2d'); ctx.scale(scale, scale); ctx.drawImage(img, 0, 0);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    if (!blob) throw new Error('toBlob');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (name || 'ergebnis').replace(/[^\w.-]/g, '_') + '.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(t('views-uiskills.bildGespeichert'), 'ok');
  } catch (e) {
    toast(t('views-uiskills.bildFehlgeschlagen'), 'err');
  }
}
// a finished card whose data a follow-up turn has superseded — dimmed, collapsed, labelled
function markResultStale(box) {
  if (!box || box.classList.contains('is-stale')) return;
  box.classList.add('is-stale');
  box.querySelectorAll('details.ui-result-sec').forEach((d) => { d.open = false; });
  const lbl = box.querySelector('.ui-result-lbl');
  if (lbl && !lbl.querySelector('.ui-result-stalemark')) lbl.appendChild(el('span', 'ui-result-stalemark', t('views-uiskills.ergebnisVeraltet')));
}
// prevKeys: row keys of the PREVIOUS run of the same skill → rows whose key is missing there are new
// `opts.tab` = the chat tab this card lives in (no `run`); it makes the follow-up buttons work there too.
function renderResultBlock(m, data, status, run, prevKeys, opts) {
  data = normalizeResultData(data);
  if (!data) return el('div', 'hidden');
  const newSet = uiResultNewSet(data, prevKeys);
  const newCount = Object.keys(newSet).length;
  const box = el('div', 'ui-result' + (status === 'error' ? ' is-err' : '')); // green on success, red only on error
  box.dataset.fp = uiResultFingerprint(data); // identity: "same block again" must not fake a fresh card
  const head = el('div', 'ui-result-head');
  const lblWrap = el('span', 'ui-result-lbl');
  lblWrap.appendChild(document.createTextNode((m.result && m.result.label) || t('views-uiskills.ergebnis')));
  lblWrap.appendChild(el('span', 'ui-result-count', String(data.rows.length)));
  if (newCount) lblWrap.appendChild(el('span', 'ui-result-newmark', '+' + newCount + ' ' + t('views-uiskills.neu-2')));
  head.appendChild(lblWrap);
  box.appendChild(head);
  if (data.summary) box.appendChild(el('div', 'ui-result-summary', data.summary));
  if (data.stats && data.stats.length) box.appendChild(resultStatsStrip(data.stats));
  // explicit 0-state — "nothing found" must look different from "no result block at all"
  if (!data.rows.length) { box.appendChild(el('div', 'ui-result-empty', t('views-uiskills.keineTrefferDerLauf'))); return box; }
  // exports follow what you SEE: with an active filter they carry the visible rows, not all of them
  // (silently exporting 100 rows after filtering down to 2 was the old trap). `filtered` marks it.
  const exportView = () => {
    const on = rowEntries.filter((e) => e.on);
    const filtered = on.length !== rowEntries.length;
    const out = { summary: data.summary, columns: data.columns, rows: (filtered ? on.map((e) => e.r) : data.rows) };
    // open comparison panels go along, re-indexed to the exported rows (closed ones stay out — "what you see")
    const src = filtered ? on : rowEntries;
    const xp = src.map((e, i) => (e.open && expIdx.get(e.ri)) ? Object.assign({}, expIdx.get(e.ri), { row: i }) : null).filter(Boolean);
    if (xp.length) out.expand = xp;
    return { data: out, filtered };
  };
  const exportNote = (base, x) => base + (x.filtered ? ' (' + t('views-uiskills.gefiltert') + ': ' + x.data.rows.length + ')' : '');
  const copyAll = iconBtn('ghost-btn ui-result-act', 'copy', { label: t('views-uiskills.alleKopieren') });
  copyAll.onclick = () => { const x = exportView(); copyText(x.data.rows.map((r) => r.join('\t')).join('\n')); toast(exportNote(t('views-uiskills.ergebnisseKopiert'), x), 'ok'); };
  const mdBtn = iconBtn('ghost-btn ui-result-act', 'copy', { label: 'Markdown', title: t('views-uiskills.alsMarkdownTabelle') });
  mdBtn.onclick = () => { const x = exportView(); copyText(resultToMarkdown(x.data)); toast(exportNote(t('views-uiskills.markdownKopiert'), x), 'ok'); };
  const csvBtn = iconBtn('ghost-btn ui-result-act', 'download', { label: t('views-uiskills.csv') });
  csvBtn.onclick = () => { const x = exportView(); const blob = new Blob([resultToCsv(x.data)], { type: 'text/csv;charset=utf-8' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = ((m.title || 'ergebnisse') + '').replace(/[^\w.-]/g, '_') + '.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
  const htmlBtn = iconBtn('ghost-btn ui-result-act', 'copy', { label: t('views-uiskills.fuerTeams'), title: t('views-uiskills.fuerTeamsHint') });
  htmlBtn.onclick = () => { const x = exportView(); copyResultHtml(x.data, (m.result && m.result.label) || (m.title || '')); };
  const pngBtn = iconBtn('ghost-btn ui-result-act', 'download', { label: t('views-uiskills.bild'), title: t('views-uiskills.bildHint') });
  pngBtn.onclick = () => saveResultPng(box, (m.title || 'ergebnis'));
  const maxBtn = el('button', 'ghost-btn ui-result-act ui-result-max', '⛶');
  maxBtn.title = t('views-uiskills.ergebnisVergroessern');
  maxBtn.onclick = () => toggleResultMax(box);
  head.appendChild(copyAll); head.appendChild(mdBtn); head.appendChild(csvBtn); head.appendChild(htmlBtn); head.appendChild(pngBtn);
  // 🕘 turn this very run into a schedule (prefilled with the inputs that produced this result)
  if (run && run.skill) {
    const schedBtn = iconBtn('ghost-btn ui-result-act', 'calendar', { label: t('views-uiskills.zeitplan'), title: t('views-uiskills.zeitplanAusLauf') });
    schedBtn.onclick = async () => {
      // The ORDER carries this: the prefill is consumed only by renderRunPanel, so it is set before the switch
      // renders the run tab. A switch the user refused (BUILDER-1: a kept draft of another skill) drops it again —
      // left lying, the next run tab of ANY skill would pick it up and overwrite its form.
      UISKILL_PREFILL = JSON.parse(JSON.stringify(run.values || {}));
      if (!(await openUiSkill(run.skill))) { UISKILL_PREFILL = null; return; }   // renders the run tab → RUN_VALUES picks up the prefill
      UISKILL_TAB = 'schedule'; renderUiSkillPanel();
      toast(t('views-uiskills.zeitplanVorbefuellt'), 'ok');
    };
    head.appendChild(schedBtn);
  }
  head.appendChild(maxBtn);
  const chipBtn = (v) => { const chip = el('button', 'ui-result-chip', v); chip.title = t('views-uiskills.kopieren'); chip.onclick = () => { copyText(v); toast(t('views-uiskills.kopiert') + v, 'ok'); }; return chip; };
  // typed cell renderer (ui-result block); legacy regex results keep the manifest-linkBase issue-key heuristic
  const manifestLinkBase = (m.result && m.result.linkBase) || '';
  const keyRe = /^[A-Z][A-Z0-9]+-\d+$/;
  const mkLink = (href, v) => { const a = el('a', 'ui-result-chip ui-result-link', v); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.title = t('views-uiskills.ticketOeffnen') + v; return a; };
  const cellEl = (v, col, inTable) => {
    const s = String(v == null ? '' : v).trim();
    if (col && col.type === 'link') {
      if (col.linkBase && s) return mkLink(col.linkBase + s, v);            // linkBase is https-whitelisted in uiResultNormalize
      if (/^https?:\/\//i.test(s)) return mkLink(s, v);
    }
    if (manifestLinkBase && keyRe.test(s)) return mkLink(manifestLinkBase + s, v);
    if (col && col.type === 'expand') return el('span', 'ui-result-plain', v); // text fallback; the strip is built in mkTable
    // badge: click filters the card to exactly this value (second click / ✕ clears it)
    if (col && col.type === 'badge') {
      const b = el('button', 'ui-result-badge is-click' + resultToneCls(uiResultToneFor(col, s)), v);
      b.title = t('views-uiskills.nurDieseZeilen') + s;
      b.onclick = () => setColFilter(col.id, s);
      return b;
    }
    if (col && col.type === 'number') { const n = chipBtn(v); n.classList.add('num'); return n; }
    // block-typed text cells render as calm plain text inside tables; chips stay for single-column lists
    if (inTable && data.source === 'block' && (!col || col.type === 'text')) return el('span', 'ui-result-plain', v);
    return chipBtn(v);
  };
  // optional per-row actions: result.actions[] → open another UI-skill's form pre-filled from a row.
  // single (per-row button) + multi-select bulk (checkboxes + a head button that runs the selection sequentially).
  const actions = (m.result && Array.isArray(m.result.actions)) ? m.result.actions : [];
  const colIndex = {}; data.columns.forEach((c, i) => { colIndex[c.id] = i; if (!(c.label in colIndex)) colIndex[c.label] = i; });
  const selected = new Set();
  const prefillFromRow = (a, r) => {
    const prefill = {};
    Object.entries(a.map || {}).forEach(([inputId, colName]) => {
      const cn = String(colName).replace(/[{}]/g, '').trim();
      if (cn in colIndex) prefill[inputId] = r[colIndex[cn]];
      else if (cn === '$value' || data.columns.length === 1) prefill[inputId] = r[0];
    });
    return prefill;
  };
  const launchAction = (a, r) => {
    const next = (typeof UISKILLS_DATA !== 'undefined' ? UISKILLS_DATA : []).find((x) => x.name === a.skill);
    if (!next) { toast(t('views-uiskills.skill') + (a.skill || '') + t('views-uiskills.nichtGefunden'), 'err'); return Promise.resolve(); }
    return Promise.resolve(openUiSkillFormForTab(next, prefillFromRow(a, r))); // openUiSkillFormForTab returns the modal promise → sequential await
  };
  // `when: {"<column>": "<value>"|[…]}` restricts an action to the rows it actually applies to
  // (without it a "create clone" button would sit on all 100 rows and mean nothing on 99 of them)
  const actionMatches = (a, r) => {
    if (!a.when || typeof a.when !== 'object' || Array.isArray(a.when)) return true;
    return Object.keys(a.when).every((col) => {
      const ci = colIndex[String(col).replace(/[{}]/g, '').trim()];
      if (ci == null) return true;
      const v = String(r[ci] == null ? '' : r[ci]).trim().toLowerCase();
      const want = a.when[col];
      return (Array.isArray(want) ? want : [want]).some((x) => String(x).trim().toLowerCase() === v);
    });
  };
  const rowActs = (r) => {
    const wrap = el('span', 'ui-result-rowacts');
    actions.forEach((a) => {
      if (!actionMatches(a, r)) return;
      const b = el('button', 'ui-result-chip ui-result-actbtn', a.label || '▶');
      b.title = t('views-uiskills.skillStarten') + (a.skill || '');
      b.onclick = () => launchAction(a, r);
      wrap.appendChild(b);
    });
    return wrap;
  };
  // bulk buttons in the head (one per action), acting on the checkbox selection, run sequentially with one upfront confirm
  const bulkBtns = [];
  const refreshBulk = () => bulkBtns.forEach((x) => { x.btn.textContent = x.base + ' (' + selected.size + ')'; x.btn.disabled = selected.size === 0; });
  if (actions.length) {
    actions.forEach((a) => {
      const base = t('views-uiskills.auswahl-2') + (a.label || t('views-uiskills.starten-2'));
      const bb = el('button', 'ghost-btn ui-result-act ui-result-bulk', base + ' (0)');
      bb.disabled = true;
      bb.onclick = async () => {
        const rows = [...selected].sort((x, y) => x - y).map((i) => data.rows[i]).filter((r) => actionMatches(a, r));
        if (!rows.length) return;
        const msg = rows.length + t('views-uiskills.ticketS') + (a.label || t('views-uiskills.starten-2')) + t('views-uiskills.fuerJedesOeffnetSich');
        const ok = (typeof uiConfirm === 'function') ? await uiConfirm(msg, { title: t('views-uiskills.sammelaktion'), okLabel: t('views-uiskills.starten') }) : confirm(msg);
        if (!ok) return;
        for (const r of rows) { await launchAction(a, r); }
        toast(t('views-uiskills.sammelaktionAbgeschlossen') + rows.length + ')', 'ok');
      };
      head.appendChild(bb);
      bulkBtns.push({ btn: bb, base });
    });
  }
  const mkCheck = (rowIdx) => { const c = el('input', 'ui-result-check'); c.type = 'checkbox'; c.checked = selected.has(rowIdx); c.setAttribute('aria-label', t('views-uiskills.zeileAuswaehlen') + (rowIdx + 1)); c.onchange = () => { if (c.checked) selected.add(rowIdx); else selected.delete(rowIdx); refreshBulk(); refreshFollow(); }; return c; };
  // ---- column roles: `group`/`detail` columns leave the table body and become layout
  let bodyCols = data.columns.map((c, i) => ({ c, i })).filter((x) => x.c.type !== 'group' && x.c.type !== 'detail');
  const groupCols = data.columns.map((c, i) => ({ c, i })).filter((x) => x.c.type === 'group');
  const detailCols = data.columns.map((c, i) => ({ c, i })).filter((x) => x.c.type === 'detail');
  if (!bodyCols.length) bodyCols = data.columns.map((c, i) => ({ c, i })); // block with nothing but roles → show all
  const gmeta = uiResultBuckets(data, 0).meta; // id→group AND label→group (rows may carry either)
  // ---- expandable rows: `expand[]` entries by row index; `open` is per row and lives only in the DOM
  // (the card is moved, never re-created, on full screen — so the state survives without persistence)
  const expIdx = new Map((Array.isArray(data.expand) ? data.expand : []).map((e) => [e.row, e]));
  const expandCols = data.columns.map((c, i) => ({ c, i })).filter((x) => x.c.type === 'expand');
  const rowEntries = data.rows.map((r, ri) => ({ r, ri, on: true, tr: null, dtr: null, xtr: null, tg: null, open: !!(expIdx.get(ri) && expIdx.get(ri).open) }));
  const sidesOf = (entry) => entry.sides || (expandCols[0] && expandCols[0].c.sides) || ['', ''];
  let refreshRowsBtn = () => {};
  const setOpen = (en, open) => {
    en.open = !!open;
    if (en.xtr) en.xtr.classList.toggle('is-hidden', !en.open || !en.on);
    if (en.tr) en.tr.classList.toggle('is-open', en.open);
    if (en.tg) { en.tg.textContent = en.open ? '▾' : '▸'; en.tg.setAttribute('aria-expanded', en.open ? 'true' : 'false'); en.tg.title = t(en.open ? 'views-uiskills.vergleichZuklappen' : 'views-uiskills.vergleichAufklappen'); }
    refreshRowsBtn();
  };
  const mkToggle = (en) => {
    const tg = el('button', 'urx-toggle', en.open ? '▾' : '▸');
    tg.type = 'button';
    tg.setAttribute('aria-expanded', en.open ? 'true' : 'false');
    tg.title = t(en.open ? 'views-uiskills.vergleichZuklappen' : 'views-uiskills.vergleichAufklappen');
    tg.onclick = (e) => { e.stopPropagation(); setOpen(en, !en.open); };
    en.tg = tg;
    return tg;
  };
  // collapsed cell of an expand column: ▸ + one toned chip per dimension ("Kmt ◀ 18 · 2 ▶") — the
  // "where is this pair out of sync" answer without opening anything; the chip's tooltip carries both sides
  const expandCell = (en, x) => {
    const entry = expIdx.get(en.ri);
    const wrap = el('span', 'urx-cell');
    if (!entry) { wrap.appendChild(el('span', 'ui-result-plain', String(en.r[x.i] == null ? '' : en.r[x.i]))); return wrap; }
    wrap.appendChild(mkToggle(en));
    const sides = sidesOf(entry);
    const strip = el('span', 'urx-strip');
    entry.rows.forEach((d) => {
      const chip = el('button', 'urx-chip' + resultToneCls(d.tone), (d.short || d.label) + (d.mark ? ' ' + d.mark : ''));
      chip.type = 'button';
      chip.title = d.label + ': ' + [sides[0] + ' ' + (d.left || '–'), d.mark || '–', sides[1] + ' ' + (d.right || '–')].join('  |  ') + (d.note ? '\n' + d.note : '');
      chip.onclick = (e) => { e.stopPropagation(); setOpen(en, !en.open); };
      strip.appendChild(chip);
    });
    wrap.appendChild(strip);
    return wrap;
  };
  // expanded panel: a 4-column table (dimension | left side | what happens | right side); line items
  // sit under the side they belong to, `both` items span; notes + legend close the panel
  const mkList = (items) => {
    const td = el('td', 'urx-v');
    if (!items.length) return td;
    const ul = el('ul', 'urx-list');
    items.forEach((it) => {
      const li = el('li', 'urx-item' + resultToneCls(it.tone));
      li.appendChild(el('span', 'urx-t', it.text));
      if (it.mark) li.appendChild(el('span', 'urx-imark' + resultToneCls(it.tone), it.mark));
      ul.appendChild(li);
    });
    td.appendChild(ul);
    return td;
  };
  const mkPanel = (entry) => {
    const sides = sidesOf(entry);
    const wrap = el('div', 'urx');
    const tbl = el('table', 'urx-table');
    const thr = el('tr');
    thr.appendChild(el('th', 'urx-l', ''));
    thr.appendChild(el('th', 'urx-side', sides[0]));
    thr.appendChild(el('th', 'urx-m', '⇄'));
    thr.appendChild(el('th', 'urx-side', sides[1]));
    tbl.appendChild(thr);
    entry.rows.forEach((d) => {
      const tr = el('tr', 'urx-dim' + resultToneCls(d.tone));
      tr.appendChild(el('td', 'urx-l', d.label));
      const tl = el('td', 'urx-v'); tl.appendChild(el('span', 'urx-t', d.left)); tr.appendChild(tl);
      const tm = el('td', 'urx-m' + resultToneCls(d.tone)); tm.appendChild(el('span', 'urx-t urx-mark', d.mark)); tr.appendChild(tm);
      const trr = el('td', 'urx-v'); trr.appendChild(el('span', 'urx-t', d.right)); tr.appendChild(trr);
      tbl.appendChild(tr);
      if (d.note) { const nr = el('tr', 'urx-note'); nr.appendChild(el('td', 'urx-l', '')); const td = el('td'); td.colSpan = 3; td.appendChild(el('span', 'urx-t', d.note)); nr.appendChild(td); tbl.appendChild(nr); }
      const items = Array.isArray(d.items) ? d.items : [];
      const L = items.filter((it) => it.side === 'left'), R = items.filter((it) => it.side === 'right'), B = items.filter((it) => it.side === 'both');
      if (L.length || R.length) { const ir = el('tr', 'urx-items'); ir.appendChild(el('td', 'urx-l', '')); ir.appendChild(mkList(L)); ir.appendChild(el('td', 'urx-m', '')); ir.appendChild(mkList(R)); tbl.appendChild(ir); }
      if (B.length) { const br = el('tr', 'urx-items'); br.appendChild(el('td', 'urx-l', '')); const td = mkList(B); td.colSpan = 3; br.appendChild(td); tbl.appendChild(br); }
    });
    wrap.appendChild(tbl);
    if (entry.notes && entry.notes.length) {
      const nt = el('div', 'urx-notes');
      nt.appendChild(el('span', 'urx-k', t('views-uiskills.hinweise') + ': '));
      entry.notes.forEach((n, i) => { if (i) nt.appendChild(document.createTextNode(' · ')); nt.appendChild(el('span', 'urx-t', n)); });
      wrap.appendChild(nt);
    }
    const legend = expandCols[0] && expandCols[0].c.legend;
    if (legend) wrap.appendChild(el('div', 'urx-legend', legend));
    return wrap;
  };
  let colFilter = null;   // { id, idx, value } — set by clicking a badge
  let onlyNew = false;    // "nur Neues" toggle, only offered when there IS something new
  // per-card view prefs (grouping, open sections, hidden columns, density) — keyed by title + columns
  const prefs = uiPrefsGet(RESULT_VIEW_PREF);
  const cardKey = ((m.title || (m.result && m.result.label) || 'ergebnis') + '#' + data.columns.map((c) => c.id).join(','));
  const hideKey = cardKey + '|hide', denseKey = cardKey + '|dense';
  const hidden = new Set(Array.isArray(prefs[hideKey]) ? prefs[hideKey] : []);
  let dense = prefs[denseKey] === true;
  const persistView = () => { prefs[hideKey] = [...hidden]; prefs[denseKey] = dense; uiPrefsSet(RESULT_VIEW_PREF, prefs); };
  // click a column head to sort; the comparator lives in ui-result.js (numeric-aware, natural order)
  let sortIdx = -1, sortDir = 1;
  const sortEntries = (entries) => {
    if (sortIdx < 0) return entries;
    const cmp = uiResultRowCmp(sortIdx, sortDir, (data.columns[sortIdx] || {}).type === 'number');
    return entries.slice().sort((a, b) => cmp(a.r, b.r));
  };
  const shownCols = () => { const v = bodyCols.filter((x) => !hidden.has(x.c.id)); return v.length ? v : bodyCols; }; // never hide everything
  const mkTable = (entriesIn) => {
    const entries = sortEntries(entriesIn);
    const cols = shownCols();
    // only tables that actually carry an applicable action get the action column
    const hasAct = !!actions.length && entries.some((en) => actions.some((a) => actionMatches(a, en.r)));
    // a row-scoped follow-up selects rows, so it needs its own checkboxes — independent of actions[].
    // Coupling the two hid the selection in every section without a matching action (/sync-acme-proj:
    // "Klon anlegen" matched only the orphan section, so G1…G7 could never be approved from the card).
    const canCheck = hasAct || !!(followBtns.length && followScope === 'row');
    const colSpan = cols.length + (canCheck ? 1 : 0) + (hasAct ? 1 : 0);
    if (cols.length === 1 && !detailCols.length) { // single-column results keep the compact chip list
      const chips = el('div', 'ui-result-chips');
      entries.forEach((en) => {
        if (canCheck || hasAct) { const row = el('div', 'ui-result-chiprow'); if (canCheck) row.appendChild(mkCheck(en.ri)); row.appendChild(cellEl(en.r[cols[0].i], cols[0].c, false)); if (hasAct) row.appendChild(rowActs(en.r)); chips.appendChild(row); en.tr = row; }
        else { const c = cellEl(en.r[cols[0].i], cols[0].c, false); chips.appendChild(c); en.tr = c; }
      });
      return chips;
    }
    const table = el('table', 'ui-result-table');
    const hr = el('tr');
    if (canCheck) { const th = el('th', 'ui-result-checkcol'); const all = el('input'); all.type = 'checkbox'; all.title = t('views-uiskills.alleAuswaehlen'); all.setAttribute('aria-label', t('views-uiskills.alleAuswaehlen')); all.onchange = () => { table.querySelectorAll('input.ui-result-check').forEach((c) => { if (c.checked !== all.checked) { c.checked = all.checked; c.onchange(); } }); }; th.appendChild(all); hr.appendChild(th); }
    const hasXcol = cols.some((x) => x.c.type === 'expand'); // hidden expand column → the toggle moves into the first cell
    cols.forEach((x) => {
      const sorted = sortIdx === x.i;
      const sortable = x.c.type !== 'expand'; // a chip strip has no natural order
      const th = el('th', 'th-' + x.c.type + (sortable ? ' is-sortable' : '') + (sorted ? ' sorted-' + (sortDir > 0 ? 'asc' : 'desc') : ''), x.c.label);
      if (sortable) {
        th.title = t('views-uiskills.spalteSortieren');
        th.tabIndex = 0; th.setAttribute('role', 'button');                       // sortable by keyboard too
        th.setAttribute('aria-sort', sorted ? (sortDir > 0 ? 'ascending' : 'descending') : 'none');
        const sort = () => { if (sortIdx === x.i) sortDir = -sortDir; else { sortIdx = x.i; sortDir = 1; } renderBody(); applyFilter(); };
        th.onclick = sort;
        th.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort(); } };
      }
      hr.appendChild(th);
    });
    if (hasAct) hr.appendChild(el('th', null, ''));
    table.appendChild(hr);
    entries.forEach((en) => {
      const tr = el('tr' + '', newSet[en.ri] ? 'is-new' : null);
      const xe = expIdx.get(en.ri) || null;
      if (canCheck) { const td = el('td', 'ui-result-checkcol'); td.appendChild(mkCheck(en.ri)); tr.appendChild(td); }
      cols.forEach((x, ci) => {
        const td = el('td', 'td-' + x.c.type);
        if (ci === 0 && xe && !hasXcol) td.appendChild(mkToggle(en));
        if (ci === 0 && newSet[en.ri]) { const n = el('span', 'ui-result-rownew', t('views-uiskills.neu-3')); n.title = t('views-uiskills.seitLetztemLauf'); td.appendChild(n); }
        td.appendChild(x.c.type === 'expand' ? expandCell(en, x) : cellEl(en.r[x.i], x.c, true));
        tr.appendChild(td);
      });
      if (hasAct) { const td = el('td', 'ui-result-actcell'); td.appendChild(rowActs(en.r)); tr.appendChild(td); }
      if (xe && en.open) tr.classList.add('is-open');
      table.appendChild(tr); en.tr = tr;
      // detail columns → one wrapped line under the row (long text must not squeeze a table column)
      const parts = detailCols.map((x) => ({ label: x.c.label, v: String(en.r[x.i] == null ? '' : en.r[x.i]).trim() })).filter((p) => p.v);
      if (parts.length) {
        const dtr = el('tr', 'ui-result-detailrow');
        const td = el('td'); td.colSpan = colSpan;
        parts.forEach((p) => { const line = el('div', 'urd-line'); if (detailCols.length > 1) line.appendChild(el('span', 'urd-k', p.label + ': ')); line.appendChild(el('span', 'urd-v', p.v)); td.appendChild(line); });
        dtr.appendChild(td); table.appendChild(dtr); en.dtr = dtr;
      }
      // expand entry → the comparison panel as a full-width row, hidden until the row is opened
      if (xe) {
        const xtr = el('tr', 'ui-result-expandrow' + (en.open ? '' : ' is-hidden'));
        const td = el('td'); td.colSpan = colSpan;
        td.appendChild(mkPanel(xe));
        xtr.appendChild(td); table.appendChild(xtr); en.xtr = xtr;
      }
    });
    const scroll = el('div', 'ui-result-scroll'); // 8 columns in a narrow window must scroll, not overflow
    scroll.appendChild(table);
    return scroll;
  };
  // ---- follow-up: approve a selection right here and continue in the SAME run/tab (manifest result.followUp[s])
  // A card may offer SEVERAL approvals over ONE selection. /sync-acme-proj needs exactly two, because
  // a row is a ticket pair whose actions split by blast radius: "internal only" (PROJ, never armed) and
  // "everything incl. ACME" (customer-visible, armed). One button per manifest entry; label, prompt and
  // confirmTones differ, the selection is shared. `followUp` (singular) keeps working unchanged.
  const fus = (() => {
    const r = m.result || {};
    const list = Array.isArray(r.followUps) ? r.followUps : (r.followUp ? [r.followUp] : []);
    return list.filter((x) => x && typeof x === 'object' && x.prompt).slice(0, 4);
  })();
  const followScope = (fus[0] && fus[0].scope === 'row') ? 'row' : 'group'; // one scope per card: one selection
  const tonesOf = (fu) => (Array.isArray(fu.confirmTones) ? fu.confirmTones : ['err']);
  const selSec = new Set();
  const secChecks = [];   // section-head checkboxes, rebuilt by renderBody — kept in sync by refreshFollow
  const followBtns = [];  // [{ btn, fu, base, armed }] — armed state is per button, selection is not
  // A card in a chat tab has no `run`, but it is the SAME card with the same buttons: the approval goes
  // out as the next message of that tab. Without this, every card outside the UI-skills view was
  // decorative — which is what the sync card looked like in a plain /sync-acme-proj chat.
  const followRun = (run && !run.batch) ? run : null;
  const followTab = followRun ? null : ((opts && opts.tab) || null);
  const rowKeyCol = (() => {
    const want = fus[0] && fus[0].valueColumn ? String(fus[0].valueColumn) : '';
    const hit = data.columns.findIndex((c) => c.id === want || c.label === want);
    return hit >= 0 ? hit : (bodyCols[0] ? bodyCols[0].i : 0);
  })();
  const followSel = () => (followScope === 'row'
    ? [...selected].sort((a, b) => a - b).map((i) => String(data.rows[i][rowKeyCol] || '').trim()).filter(Boolean)
    : [...selSec]);
  // is the process that produced this card still writing? (mid-run card / mid-turn chat tab)
  // A chat tab is busy beyond `streaming`: a HELD gate blocks the CLI inside can_use_tool while nothing
  // streams (FLOW-3), and a queued entry has not left the tab yet. In both states a follow-up sent from
  // here is only QUEUED — judged by `streaming` alone the card reported „✓ Folgeschritt beendet" for a
  // step that never went out, and a follow-up step may write.
  const followBusy = () => !!(followRun && !followRun.done)
    || !!(followTab && (followTab.streaming || hasHeldGate(followTab) || (followTab.queue || []).length));
  let followLocked = false;   // an approval went out from this card → it stays spent (see lock())
  // The end of a run is not an event this card can subscribe to (a chat tab has none at all), so the
  // wait is polled — only while it IS waiting, and only as long as the card is still on the page.
  let followBusyTimer = null;
  const watchFollowBusy = () => {
    if (followBusyTimer) return;
    followBusyTimer = setInterval(() => {
      if (followBusy() && box.isConnected) return;
      clearInterval(followBusyTimer); followBusyTimer = null;
      if (box.isConnected) refreshFollow();
    }, 1000);
  };
  // shown next to the buttons while they wait — a grey button with no reason is what "nothing happens" looks like
  const followWait = el('span', 'ui-result-chip ui-result-follow-wait is-hidden', '⏳ ' + t('views-uiskills.freigabeErstNachLauf'));
  const refreshFollow = () => {
    if (!followBtns.length) return;
    // a section head mirrors its rows: fully ticked → checked, partly → indeterminate
    if (followScope === 'row') {
      secChecks.forEach((s) => {
        const n = s.idx.filter((i) => selected.has(i)).length;
        s.cb.checked = n > 0 && n === s.idx.length;
        s.cb.indeterminate = n > 0 && n < s.idx.length;
      });
    }
    const n = followSel().length;
    // Why an approval cannot go out right now — the button carries the answer (uiFollowGate). The
    // 'busy' case is the one that used to look broken: the card is readable mid-run on purpose, so the
    // buttons enabled themselves on the first tick and a click then only raised a toast (reported
    // 2026-09-30: "habe was ausgewählt, aber der Sync startet nicht").
    const gate = uiFollowGate({ selected: n, busy: followBusy(), locked: followLocked });
    // a new-tab follow-up does not race this run and never spends the card → only the selection gates it
    const gateFor = (f) => (uiFollowTarget(f.fu) === 'newTab' ? uiFollowGate({ selected: n }) : gate);
    const anyBusy = followBtns.some((f) => gateFor(f) === 'busy');
    if (followWait) followWait.classList.toggle('is-hidden', !anyBusy);
    // any change to the selection disarms every button again
    followBtns.forEach((f) => {
      const g = gateFor(f);
      f.armed = false; f.btn.classList.remove('armed');
      f.btn.textContent = f.base + ' (' + n + ')';
      f.btn.disabled = g !== '';
      f.btn.title = g === 'busy' ? t('views-uiskills.laufLaeuftNoch') : (f.fu.title ? String(f.fu.title) : '');
    });
    if (anyBusy) watchFollowBusy();   // wake the buttons up when the run ends
  };
  // which selected sections/rows are risky FOR THIS button's confirmTones?
  const riskyFor = (confirmTones, ids) => {
    const risky = [];
    const seen = new Set();
    const add = (meta, fallback) => {
      const mm = meta || { label: fallback };
      if (!mm.label || seen.has(mm.label)) return;
      seen.add(mm.label); risky.push(mm);
    };
    const sectionOf = (row) => {
      for (const x of groupCols) { const mm = gmeta[String(row[x.i] || '').trim()]; if (mm) return mm; }
      return null;
    };
    if (followScope === 'group') {
      ids.forEach((id) => { const mm = gmeta[id]; if (confirmTones.indexOf((mm && mm.tone) || '') >= 0) add(mm, id); });
    } else {
      // a row is risky through its section's tone OR through a badge cell of its own (e.g. "→ ACME")
      // OR through a dimension row of its comparison panel (a red "2 ▶" = a customer-visible write)
      [...selected].sort((a, b) => a - b).forEach((i) => {
        const row = data.rows[i];
        if (!row) return;
        const sec = sectionOf(row);
        const byBadge = bodyCols.some((x) => x.c.type === 'badge'
          && confirmTones.indexOf(uiResultToneFor(x.c, row[x.i]) || '') >= 0);
        const xe = expIdx.get(i);
        const byPanel = !!xe && (xe.rows || []).some((d) => confirmTones.indexOf(d.tone || '') >= 0);
        if (byBadge || byPanel || confirmTones.indexOf((sec && sec.tone) || '') >= 0) add(sec, String(row[rowKeyCol] || '').trim());
      });
    }
    return risky;
  };
  // the row indices behind the current selection — what {{rows}} renders (group scope: every row of a ticked section)
  const followRowIdx = () => {
    if (followScope === 'row') return [...selected].sort((a, b) => a - b);
    const out = [];
    data.rows.forEach((row, i) => {
      if (groupCols.some((x) => { const v = String(row[x.i] || '').trim(); return selSec.has((gmeta[v] && gmeta[v].id) || v); })) out.push(i);
    });
    return out;
  };
  // A `target:"newTab"` follow-up opens its own chat tab, so it works on any card — also in the run
  // history, where there is no run or tab to continue. Same-run follow-ups still need one.
  const fusShown = fus.filter((fu) => uiFollowTarget(fu) === 'newTab' || followRun || followTab);
  if (fusShown.length) {
    fusShown.forEach((fu, fi) => {
      const base = fu.label || t('views-uiskills.auswahlAusfuehren');
      // the first entry is the safe default; later ones are the wider-reaching variants
      const btn = el('button', (fi === 0 ? 'primary-btn' : 'ghost-btn') + ' ui-result-act ui-result-follow', base + ' (0)');
      btn.disabled = true;
      if (fu.title) btn.title = String(fu.title);
      const self = { btn, fu, base, armed: false };
      btn.onclick = () => {
        const ids = followSel();
        const newTab = uiFollowTarget(fu) === 'newTab';
        // mid-run / mid-turn cards are read-only: an approval must not race the process that produced
        // it. refreshFollow already disables the button for exactly this (and says why) — this stays as
        // the net for a click that slips through between a turn starting and the next refresh.
        // A new-tab follow-up races nothing and spends nothing: only an empty selection stops it.
        const gate = newTab ? uiFollowGate({ selected: ids.length }) : uiFollowGate({ selected: ids.length, busy: followBusy(), locked: followLocked });
        if (gate === 'busy') { toast(t('views-uiskills.laufLaeuftNoch'), 'err'); refreshFollow(); return; }
        if (gate) return;
        // two-stage instead of a modal: a risky (customer-visible) selection first names its effect IN
        // the button. Row scope must arm too — one checked row can write to the customer just like a
        // whole section. A button whose confirmTones are empty never arms: that IS the safe variant.
        const risky = riskyFor(tonesOf(fu), ids);
        if (risky.length && !self.armed) {
          self.armed = true; btn.classList.add('armed');
          btn.textContent = t('views-uiskills.wirklich') + risky.map((x) => x.label).join(', ') + (risky[0].note ? ' — ' + risky[0].note : '');
          return;
        }
        const text = uiFollowPrompt(fu, { ids, rowIdx: followRowIdx(), data, expand: expIdx });
        // `target:"newTab"`: a fresh chat tab with its own permission mode (default plan) — the card stays
        // live and unlocked, so a second selection can go into a second tab. The prompt carries the rows
        // ({{rows}}) because the new session never saw this run.
        if (newTab) {
          if (typeof launchInNewTab !== 'function') { toast(t('views-uiskills.folgeschrittOhneLauf'), 'err'); return; }
          const rc = m.run || {};
          const pick = (k) => (typeof fu[k] === 'string' ? fu[k] : (rc[k] || ''));
          self.armed = false; btn.classList.remove('armed'); btn.textContent = base + ' (' + ids.length + ')';
          launchInNewTab({ prompt: text, title: String(fu.tabTitle || fu.label || m.title || 'Plan'), cwd: pick('cwd'), model: pick('model'), effort: pick('effort'), permissionMode: typeof fu.permissionMode === 'string' && fu.permissionMode ? fu.permissionMode : 'plan' });
          const done = el('span', 'ui-result-chip ui-result-follow-status', '↗ ' + t('views-uiskills.folgeschrittNeuerTab') + ' (' + ids.length + ')');
          head.querySelectorAll('.ui-result-follow-status.is-newtab').forEach((x) => x.remove());
          done.classList.add('is-newtab');
          head.appendChild(done);
          return;
        }
        // Lock/stale only once the turn is really on its way: a bail-out used to leave the card dead
        // and silent (buttons disabled, "veraltet", no toast) — the click looked like it did nothing.
        const lock = () => {
          followLocked = true;   // spent — and refreshFollow must not wake the buttons up again
          // drop the armed wording too, otherwise "Wirklich: …" keeps standing there while it runs
          followBtns.forEach((f) => { f.armed = false; f.btn.classList.remove('armed'); f.btn.textContent = f.base + ' (' + ids.length + ')'; f.btn.disabled = true; });
          markResultStale(box);
        };
        // a bail-out inside uiRunFollowUp never sent anything → hand the buttons back (2026-09-17)
        const unlock = () => { followLocked = false; refreshFollow(); };
        // ...and while it runs, say so ON THE CARD. The work itself scrolls by in the transcript, which
        // is usually collapsed, and the card only changes once the follow-up emits its own result block —
        // so for minutes the card looked untouched (reported 2026-09-17: "zweimal geklickt, nichts passiert",
        // while the mail had in fact gone out).
        const t0 = Date.now();
        const chip = el('span', 'ui-result-chip ui-result-follow-status', '');
        const mmss = () => { const s = Math.round((Date.now() - t0) / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
        let tick = null;
        const chipRun = () => {
          head.appendChild(chip);
          const paint = () => { chip.textContent = '⏳ ' + t('views-uiskills.folgeschrittLaeuft') + ' ' + mmss(); };
          paint(); tick = setInterval(paint, 1000);
        };
        const chipStop = (failed) => {
          if (tick) { clearInterval(tick); tick = null; }
          chip.textContent = (failed ? '⚠ ' : '✓ ') + t(failed ? 'views-uiskills.folgeschrittAbgebrochen' : 'views-uiskills.folgeschrittBeendet') + ' · ' + mmss();
        };
        // the third outcome, for a step that went into the chat tab's QUEUE: handed over, not finished
        const chipQueued = () => {
          if (tick) { clearInterval(tick); tick = null; }
          chip.textContent = '↳ ' + t('views-uiskills.folgeschrittInWarteschlange');
          chip.title = t('views-uiskills.folgeschrittInWarteschlangeTitel');
        };
        if (followRun) {
          lock(); chipRun();
          uiRunFollowUp(followRun, text, () => { chipStop(true); unlock(); })
            .then(() => { if (tick) chipStop(!!followRun.lastError); });
        } else if (followTab && typeof sendMessage === 'function') {
          lock(); chipRun();
          // queue/gate/self-heal all live in sendMessage; it resolves once the text is either POSTED (the tab
          // is then streaming) or QUEUED — and those two outcomes are not the same promise to the user.
          sendMessage({ text, tab: followTab }).then(() => {
            // QUEUED: the chip must stop here. „Leaving the queue" is not „ran": ⏹ Stop, the × on the chip and
            // a dying process all drop the entry, and each of those made the chip claim „✓ fertig — Ergebnis
            // unten" for a step that never went out (and the result of a queued step never lands on THIS card
            // anyway). So it says where the step is; the queue strip above the composer is the live state.
            if ((followTab.queue || []).some((q) => q.text === text)) { chipQueued(); return; }
            // Nothing went out and nothing is running: the send failed (the bubble says „⚠ nicht gesendet")
            // or the sensitive-data guard was declined. Either way the buttons come back.
            if (!followBusy()) { chipStop(true); unlock(); return; }
            // POSTED: watch for the end of that turn — streaming is already on, so there is nothing to wait for
            const watch = setInterval(() => {
              if (!box.isConnected) { clearInterval(watch); return; } // card unmounted → stop polling (as watchFollowBusy does)
              if (!followBusy()) { clearInterval(watch); chipStop(false); }
            }, 1000);
          });
        } else { toast(t('views-uiskills.folgeschrittOhneLauf'), 'err'); unlock(); }
      };
      head.appendChild(btn);
      followBtns.push(self);
    });
    head.appendChild(followWait);   // stands right behind the buttons it explains
  }
  // ---- toolbar (grouping switch · live filter · expand/collapse · visible count) + sections
  const openKey = cardKey + '|open';
  let openMem = Array.isArray(prefs[openKey]) ? prefs[openKey] : null; // remembered section state, null = use defaults
  const persistOpen = () => { openMem = secs.filter((s) => s.det.open).map((s) => s.key); prefs[openKey] = openMem; uiPrefsSet(RESULT_VIEW_PREF, prefs); };
  let curGroup = groupCols.length ? (prefs[cardKey] || groupCols[0].c.id) : RESULT_FLAT;
  if (curGroup !== RESULT_FLAT && !groupCols.some((x) => x.c.id === curGroup)) curGroup = groupCols[0].c.id;
  const tools = el('div', 'ui-result-tools');
  const bodyEl = el('div', 'ui-result-body');
  const noHit = el('div', 'ui-result-empty is-hidden', t('views-uiskills.keineZeilePasst'));
  const visCnt = el('span', 'ui-result-vis', '');
  const filter = el('input', 'ui-result-filter'); filter.type = 'search'; filter.placeholder = t('views-uiskills.filtern');
  const expandBtn = el('button', 'ghost-btn ui-result-act', t('views-uiskills.alleAusklappen'));
  // "Details auf-/zuklappen": every VISIBLE row with a panel at once (the per-row ▸ stays for single rows)
  const rowsBtn = el('button', 'ghost-btn ui-result-act ui-result-rowsbtn', t('views-uiskills.detailsAufklappen'));
  const withPanel = () => rowEntries.filter((en) => en.on && expIdx.has(en.ri));
  refreshRowsBtn = () => { rowsBtn.textContent = t(withPanel().some((en) => !en.open) ? 'views-uiskills.detailsAufklappen' : 'views-uiskills.detailsZuklappen'); };
  rowsBtn.onclick = () => { const open = withPanel().some((en) => !en.open); withPanel().forEach((en) => setOpen(en, open)); refreshRowsBtn(); };
  const secs = [];
  // filter hits are marked inside the cell — built from text nodes, never innerHTML (model-authored text)
  const HL_SEL = '.ui-result-plain, .urd-v, .ui-result-badge, .urx-t';
  const highlight = (rowEl, q) => {
    if (!rowEl || !rowEl.querySelectorAll) return;
    rowEl.querySelectorAll(HL_SEL).forEach((cell) => {
      if (cell.dataset.hlRaw == null) cell.dataset.hlRaw = cell.textContent;
      const raw = cell.dataset.hlRaw;
      const low = raw.toLowerCase();
      const first = q ? low.indexOf(q) : -1;
      if (first < 0) { if (cell.dataset.hlOn) { cell.textContent = raw; delete cell.dataset.hlOn; } return; }
      cell.textContent = '';
      let pos = 0, i = first;
      while (i >= 0) {
        if (i > pos) cell.appendChild(document.createTextNode(raw.slice(pos, i)));
        cell.appendChild(el('mark', null, raw.substr(i, q.length)));
        pos = i + q.length;
        i = low.indexOf(q, pos);
      }
      if (pos < raw.length) cell.appendChild(document.createTextNode(raw.slice(pos)));
      cell.dataset.hlOn = '1';
    });
  };
  const applyFilter = () => {
    const q = filter.value.trim().toLowerCase();
    let vis = 0;
    rowEntries.forEach((en) => {
      // three filters, combined: text · badge click · "nur Neues" (text also searches the row's panel)
      const xe = expIdx.get(en.ri);
      en.on = uiResultMatch(en.r, q, xe)
        && (!colFilter || String(en.r[colFilter.idx] == null ? '' : en.r[colFilter.idx]).trim() === colFilter.value)
        && (!onlyNew || !!newSet[en.ri]);
      // a hit that lives only inside the panel must not hide behind a closed row
      if (q && en.on && xe && !en.open && !uiResultMatch(en.r, q)) setOpen(en, true);
      if (en.tr) { en.tr.classList.toggle('is-hidden', !en.on); highlight(en.tr, q); }
      if (en.dtr) { en.dtr.classList.toggle('is-hidden', !en.on); highlight(en.dtr, q); }
      if (en.xtr) { en.xtr.classList.toggle('is-hidden', !en.on || !en.open); highlight(en.xtr, q); }
      if (en.on) vis++;
    });
    refreshRowsBtn();
    const anyFilter = !!q || !!colFilter || onlyNew;
    secs.forEach((s) => {
      const n = s.entries.filter((e) => e.on).length;
      s.count.textContent = String(n);
      s.det.classList.toggle('is-hidden', anyFilter && n === 0);
      if (anyFilter && n > 0) s.det.open = true;          // a hit must not hide inside a closed section
    });
    // any of the three filters is enough to owe the user a count (text, badge value, "nur Neues")
    const active = !!q || !!colFilter || onlyNew;
    visCnt.textContent = active ? vis + ' / ' + data.rows.length + ' ' + t('views-uiskills.zeilen') : '';
    noHit.classList.toggle('is-hidden', !(active && vis === 0));
  };
  const renderBody = () => {
    bodyEl.textContent = ''; secs.length = 0; secChecks.length = 0;
    rowEntries.forEach((en) => { en.tr = null; en.dtr = null; en.xtr = null; en.tg = null; });
    expandBtn.textContent = t('views-uiskills.alleAusklappen');
    if (curGroup === RESULT_FLAT) { bodyEl.appendChild(mkTable(rowEntries)); return; }
    const gi = (groupCols.find((x) => x.c.id === curGroup) || groupCols[0]).i;
    const b = uiResultBuckets(data, gi, t('views-uiskills.ohneGruppe')); // order + id/label resolution: ui-result.js
    const used = b.order;
    used.forEach((k) => {
      const list = b.map[k].map((i) => rowEntries[i]);
      const meta = b.meta[k] || null;
      const det = el('details', 'ui-result-sec' + resultToneCls(meta && meta.tone));
      // default collapsed; a remembered open-state for this card wins over the default
      det.open = openMem ? openMem.indexOf(k) >= 0 : (used.length === 1 || !!(meta && meta.open === true));
      const sh = el('summary', 'ui-result-sechead');
      sh.addEventListener('click', () => setTimeout(persistOpen, 0)); // only USER toggles are remembered
      if (followBtns.length) {
        const secIdx = list.map((en) => en.ri);
        const cb = el('input', 'ui-result-seccheck'); cb.type = 'checkbox';
        cb.checked = followScope === 'row' ? (secIdx.length > 0 && secIdx.every((i) => selected.has(i))) : selSec.has(k);
        cb.title = ((gmeta[k] && gmeta[k].label) || k) + ' ' + t('views-uiskills.auswaehlen-2');
        cb.setAttribute('aria-label', cb.title);
        cb.onclick = (e) => e.stopPropagation();          // ticking a section must not toggle it open
        cb.onchange = () => {
          if (followScope === 'row') {
            // shortcut: tick a whole section without expanding it, then refine row by row
            secIdx.forEach((i) => { if (cb.checked) selected.add(i); else selected.delete(i); });
            det.querySelectorAll('input.ui-result-check').forEach((c) => { c.checked = cb.checked; });
            det.querySelectorAll('th.ui-result-checkcol input').forEach((c) => { c.checked = cb.checked; });
            refreshBulk();
          } else if (cb.checked) selSec.add(k); else selSec.delete(k);
          refreshFollow();
        };
        sh.appendChild(cb);
        secChecks.push({ cb, idx: secIdx });
      }
      sh.appendChild(el('span', 'ui-result-secdot', ''));
      sh.appendChild(el('span', 'ui-result-seclbl', (meta && meta.label) || k));
      const cEl = el('span', 'ui-result-seccount', String(list.length));
      sh.appendChild(cEl);
      if (meta && meta.note) sh.appendChild(el('span', 'ui-result-secnote', meta.note));
      det.appendChild(sh);
      det.appendChild(mkTable(list));
      bodyEl.appendChild(det);
      secs.push({ det, count: cEl, entries: list, key: k });
    });
  };
  // badge click → exact-value filter; shown as a removable chip next to the search box
  const setColFilter = (colId, value) => {
    const idx = data.columns.findIndex((c) => c.id === colId);
    if (idx < 0) return;
    colFilter = (colFilter && colFilter.id === colId && colFilter.value === value) ? null : { id: colId, idx, value: String(value).trim() };
    renderTools(); applyFilter();
  };
  // column picker: a small popover with one checkbox per column (group/detail columns are layout, not cells)
  const openColPicker = (anchor) => {
    document.querySelectorAll('.ui-result-cols').forEach((x) => x.remove());
    const pop = el('div', 'ui-result-cols');
    bodyCols.forEach((x) => {
      const lab = el('label', 'ui-check');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !hidden.has(x.c.id);
      cb.onchange = () => { if (cb.checked) hidden.delete(x.c.id); else hidden.add(x.c.id); persistView(); renderTools(); renderBody(); applyFilter(); };
      lab.appendChild(cb); lab.appendChild(el('span', null, x.c.label));
      pop.appendChild(lab);
    });
    if (detailCols.length) {
      const lab = el('label', 'ui-check');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !dense;
      cb.onchange = () => { dense = !cb.checked; persistView(); box.classList.toggle('is-dense', dense); renderTools(); };
      lab.appendChild(cb); lab.appendChild(el('span', null, t('views-uiskills.detailzeilen')));
      pop.appendChild(lab);
    }
    const close = el('button', 'ghost-btn', t('common.schliessen'));
    close.onclick = () => pop.remove();
    pop.appendChild(close);
    anchor.parentNode.insertBefore(pop, anchor.nextSibling);
    setTimeout(() => { // click outside closes
      const off = (e) => { if (!pop.contains(e.target) && e.target !== anchor) { pop.remove(); document.removeEventListener('click', off, true); } };
      document.addEventListener('click', off, true);
    }, 0);
  };
  const renderTools = () => {
    tools.textContent = '';
    if (newCount) { // "nur Neues" — the whole point of a recurring radar
      const nb = el('button', 'urseg-btn ui-result-newbtn' + (onlyNew ? ' on' : ''), t('views-uiskills.nurNeues') + ' (' + newCount + ')');
      nb.onclick = () => { onlyNew = !onlyNew; renderTools(); applyFilter(); };
      tools.appendChild(nb);
    }
    if (colFilter) {
      const chip = el('button', 'ui-result-fchip', (data.columns[colFilter.idx].label || colFilter.id) + ': ' + colFilter.value + ' ✕');
      chip.title = t('views-uiskills.filterEntfernen');
      chip.onclick = () => { colFilter = null; renderTools(); applyFilter(); };
      tools.appendChild(chip);
    }
    if (groupCols.length) {
      const seg = el('div', 'ui-result-seg');
      seg.appendChild(el('span', 'urseg-lbl', t('views-uiskills.gruppierung')));
      const mkSeg = (id, label) => { const b = el('button', 'urseg-btn' + (curGroup === id ? ' on' : ''), label); b.onclick = () => { if (curGroup === id) return; curGroup = id; prefs[cardKey] = id; uiPrefsSet(RESULT_VIEW_PREF, prefs); renderTools(); renderBody(); applyFilter(); }; return b; };
      groupCols.forEach((x) => seg.appendChild(mkSeg(x.c.id, x.c.label)));
      seg.appendChild(mkSeg(RESULT_FLAT, t('views-uiskills.flach')));
      tools.appendChild(seg);
    }
    if (data.rows.length >= 8) tools.appendChild(filter);
    if (curGroup !== RESULT_FLAT) tools.appendChild(expandBtn);
    if (expIdx.size) { refreshRowsBtn(); tools.appendChild(rowsBtn); }
    // compact = detail lines off → roughly half the height when you only want the overview
    if (detailCols.length) {
      const db = el('button', 'urseg-btn' + (dense ? ' on' : ''), dense ? t('views-uiskills.kompakt') : t('views-uiskills.normal'));
      db.title = t('views-uiskills.dichteHint');
      db.onclick = () => { dense = !dense; persistView(); box.classList.toggle('is-dense', dense); renderTools(); };
      tools.appendChild(db);
    }
    if (bodyCols.length > 2) {
      const cb = el('button', 'urseg-btn' + (hidden.size ? ' on' : ''), t('views-uiskills.spalten') + (hidden.size ? ' (−' + hidden.size + ')' : ''));
      cb.title = t('views-uiskills.spaltenHint');
      cb.onclick = (e) => { e.stopPropagation(); openColPicker(cb); };
      tools.appendChild(cb);
    }
    tools.appendChild(visCnt);
  };
  expandBtn.onclick = () => {
    const anyClosed = secs.some((s) => !s.det.open);
    secs.forEach((s) => { s.det.open = anyClosed; });
    expandBtn.textContent = anyClosed ? t('views-uiskills.alleEinklappen') : t('views-uiskills.alleAusklappen');
    persistOpen();
  };
  filter.oninput = debounce(applyFilter, 120);
  if (groupCols.length || data.rows.length >= 8 || newCount || detailCols.length || bodyCols.length > 2 || expIdx.size || data.expandSrc) box.appendChild(tools);
  box.appendChild(bodyEl); box.appendChild(noHit);
  if (dense) box.classList.add('is-dense');
  renderTools(); renderBody(); applyFilter();
  // Panel data from a file (`expandSrc`): the card renders at once with the text fallback, the file is
  // fetched through the server (path allowlist = registered UI-skill cwds) and the rows are upgraded in
  // place — same closure state, so selection/filter/sort survive. History entries never get here: the
  // server inlines the data when the run is persisted.
  if (data.expandSrc && !expIdx.size) {
    const hint = el('span', 'ui-result-loading', t('views-uiskills.detailsLaden'));
    tools.appendChild(hint);
    api('/api/uiskill/result-file?src=' + encodeURIComponent(data.expandSrc) + '&rows=' + data.rows.length)
      .then((r) => {
        const list = uiResultExpand((r && r.expand) || [], data.rows.length);
        if (!list.length) throw new Error(t('views-uiskills.detailsNichtVerfuegbar'));
        data.expand = list;
        list.forEach((e) => { expIdx.set(e.row, e); const en = rowEntries[e.row]; if (en) en.open = !!e.open; });
        hint.remove();
        renderTools(); renderBody(); applyFilter();
      })
      .catch((e) => { hint.textContent = t('views-uiskills.detailsNichtVerfuegbar'); hint.title = String((e && e.message) || e); hint.classList.add('is-err'); });
  }
  return box;
}
function stopUiRun(run) {
  if (!run || !run.chatId || run.done) return;
  run.status = 'stopped';
  api('/api/chat/' + run.chatId + '/interrupt', { method: 'POST' }).catch(() => {});
  uiRunStatus(run, t('views-uiskills.gestoppt-3'), 'stopped');
}
// Hard-dispose a run when its card is closed: stop the process, tear down es/timer,
// and release any batch-worker slot waiting on onDone (otherwise the pool hangs).
function disposeRun(run) {
  if (!run) return;
  if (run.timer) { clearInterval(run.timer); run.timer = null; }
  if (run.es) { try { run.es.close(); } catch {} run.es = null; }
  if (run.chatId && !run.done) api('/api/chat/' + run.chatId + '/stop', { method: 'POST' }).catch(() => {});
  run.done = true; run.status = run.status === 'running' ? 'stopped' : run.status;
  if (run.onDone) { const cb = run.onDone; run.onDone = null; cb(run); }
}
// C4 — the transcript that is stored with a run. `msgEl.innerText` was two defects in one property:
// reading it forces a full LAYOUT of the entire transcript at the moment a run ends (the visible hang
// docs/ideas.md C4 names), and it returns the text that is VISIBLE — so everything the display switches
// hide (thinking blocks, tool cards, a folded diff) silently dropped out of the record, which made the
// stored history depend on checkboxes that have nothing to do with the run.
// `textContent` costs no layout and sees all of it. Taken on the CONTAINER it would also glue the
// messages into one line, and this text is read by a human (openTranscriptModal puts it in a <pre>) —
// so: textContent per message, joined by a blank line. No layout, nothing hidden, shape intact.
function uiTranscriptText(msgEl) {
  if (!msgEl) return '';
  const msgs = msgEl.querySelectorAll ? [...msgEl.querySelectorAll('.msg')] : [];
  if (!msgs.length) return String(msgEl.textContent || '').trim(); // no messages yet (or a non-DOM stand-in)
  return msgs.map((m) => String(m.textContent || '').trim()).filter(Boolean).join('\n\n');
}
function recordUiRun(run, status) {
  if (!run || run.recorded) return; run.recorded = true;
  const m = run.skill.manifest || {};
  // remember how long a successful run takes → the next run can say "zuletzt 4:10"
  if (status === 'done') { const o = uiPrefsGet('cc_uiskill_lastdur'); o[run.skill.name] = Date.now() - run.startedAt; uiPrefsSet('cc_uiskill_lastdur', o); }
  if (status === 'done' && run.resultData) saveLastKeys(run.skill.name, run.resultData); // baseline for the next run's "+n neu"
  const stepResults = (run.steps || []).map((st) => ({ id: st.id, title: st.title || st.id, status: (run.stepStatus && run.stepStatus[st.id]) || 'pending' }));
  const body = { name: run.skill.name, title: m.title || run.skill.name, inputs: run.values, startedAt: run.startedAt, status, sessionId: run.sessionId, dryRun: !!run.dryRun, mode: run.mode, durationMs: Date.now() - run.startedAt, steps: stepResults, result: run.resultData || null, transcript: uiTranscriptText(run.tab && run.tab.msgEl).slice(0, 40000) };
  api('/api/uiskill/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}
async function startUiRun(skill, values, opts) {
  const m = skill.manifest || {};
  const miss = missingRequired(m, values);
  if (miss.length) {
    setRunSetupFolded(false, false);   // never scroll to a field that is folded away
    miss.forEach((i) => { const f = document.querySelector('#view-uiskills [data-field="' + i.id + '"]'); if (f) f.classList.add('invalid'); });
    const first = document.querySelector('#view-uiskills .ui-field.invalid'); if (first) { const c = first.querySelector('input,textarea,select'); if (c) c.focus(); first.scrollIntoView({ block: 'center' }); }
    toast(t('views-uiskills.pflichtfelderFehlen') + miss.map((i) => i.label || i.id).join(', '), 'err');
    if (opts.onDone) opts.onDone(null);   // never leave a batch worker awaiting
    return;
  }
  if (!opts.batch) {
    const verr = validateFields(m, values);
    if (verr.length) {
      setRunSetupFolded(false, false);
      verr.forEach((e) => { const f = document.querySelector('#view-uiskills [data-field="' + e.input.id + '"]'); markFieldError(f, e.msg); });
      const first = document.querySelector('#view-uiskills .ui-field.invalid'); if (first) first.scrollIntoView({ block: 'center' });
      toast(t('views-uiskills.ungueltigeEingaben') + verr.map((e) => e.input.label || e.input.id).join(', '), 'err');
      if (opts.onDone) opts.onDone(null);
      return;
    }
  }
  if (!opts.batch && activeRuns().length >= ACTIVE_LIMIT) { toast(t('views-uiskills.max-2') + ACTIVE_LIMIT + t('views-uiskills.gleichzeitigeLaeufeBitteWarten'), 'err'); return; }
  const mode = ((m.steps || []).length && opts.mode === 'steps') ? 'steps' : 'single';
  let steps = null, prompt = '';
  if (mode === 'steps') { steps = planSteps(skill, values); if (!steps.length) { toast(t('views-uiskills.keineAktivenSchritteAusgewaehlt'), 'err'); if (opts.onDone) opts.onDone(null); return; } }
  else { prompt = uiComposePrompt(skill, values, opts); if (opts.dryRun) prompt = DRY_HINT() + prompt; }
  // safety: writes → one-line effect confirmation before running (policy: confirm shared-system writes)
  if (m.writes && !opts.dryRun && !opts.skipWriteConfirm && !(await uiConfirm(t('views-uiskills.schreibtInExterneSysteme-2') + uiWriteEffect(skill, values, opts.autoRun) + t('views-uiskills.jetztAusfuehren'), { danger: true, title: t('views-uiskills.schreibenBestaetigen'), okLabel: t('views-uiskills.ausfuehren-2') }))) { if (opts.onDone) opts.onDone(null); return; }
  const guardText = mode === 'steps' ? steps.map((st) => uiInterpolate(st.prompt || '', m, values, opts)).join('\n') : prompt;
  if (typeof DISPLAY !== 'undefined' && DISPLAY.guard && !opts.skipGuard && typeof scanSensitive === 'function') {
    const hits = scanSensitive(guardText);
    if (hits.length && !(await uiConfirm(t('views-uiskills.moeglicherweiseSensibleDatenErkannt') + hits.join(', ') + t('views-uiskills.trotzdemAusfuehren'), { danger: true, title: t('views-uiskills.sensibleDaten'), okLabel: t('chat-composer.trotzdemSenden') }))) { if (opts.onDone) opts.onDone(null); return; }
  }
  // edit-before-send (single mode) — final review of the composed prompt
  if (mode === 'single' && opts.editPrompt) { const edited = await uiEditPromptModal(prompt); if (edited == null) { if (opts.onDone) opts.onDone(null); return; } prompt = edited; }
  saveLastInputs(skill.name, JSON.parse(JSON.stringify(values)), uiDefaultValues(m));
  // build a per-run card (concurrency-safe: everything hangs off `run`, not a global)
  const card = el('div', 'ui-run-card');
  const head = el('div', 'ui-run-status');
  const dot = el('span', 'urs-dot run'); const statusText = el('span', 'urs-text', t('common.startet'));
  const titleEl = el('span', 'urs-title', (m.icon || '▶') + ' ' + (m.title || skill.name));
  const modelEl = el('span', 'urs-model', (m.run && m.run.model) || t('views-uiskills.standard'));
  const metaEl = el('span', 'urs-meta', '');
  head.appendChild(dot); head.appendChild(titleEl);
  if (opts.dryRun) { const dry = el('span', 'urs-dry'); dry.innerHTML = ic('flask', 12) + t('views-uiskills.testlauf-2'); head.appendChild(dry); }
  head.appendChild(statusText); head.appendChild(modelEl); head.appendChild(metaEl);
  const run = { id: 'r' + (++RUN_SEQ), chatId: null, es: null, tab: null, card, mode, skill, values: JSON.parse(JSON.stringify(values)), autoRun: !!opts.autoRun, dryRun: !!opts.dryRun, batch: !!opts.batch, onDone: opts.onDone || null, chainDepth: opts.chainDepth || 0, paused: false, startedAt: Date.now(), sessionId: null, statusEl: statusText, dotEl: dot, modelEl, metaEl, stopBtn: null, pauseBtn: null, steps: steps || [], stepStatus: {}, stepEls: {}, tokensIn: 0, tokensOut: 0, timer: null, done: false, status: 'running', recorded: false, lastError: false, _await: null };
  const stopBtn = iconBtn('ghost-btn urs-stop', 'stop', { size: 14, label: t('views-uiskills.stop'), onClick: () => stopUiRun(run) }); run.stopBtn = stopBtn;
  if (mode === 'steps') { const pauseBtn = el('button', 'ghost-btn urs-pause'); pauseBtn.innerHTML = ic('pause', 14) + ' <span class="btxt">' + t('views-uiskills.pause') + '</span>'; pauseBtn.onclick = () => { run.paused = !run.paused; pauseBtn.innerHTML = (run.paused ? ic('play', 14) : ic('pause', 14)) + ' <span class="btxt">' + (run.paused ? t('common.fortsetzen') : t('views-uiskills.pause')) + '</span>'; uiRunStatus(run, run.paused ? t('views-uiskills.pausiert-2') : t('views-uiskills.laeuft'), run.paused ? 'stopped' : 'run'); }; head.appendChild(pauseBtn); run.pauseBtn = pauseBtn; }
  head.appendChild(stopBtn);
  const closeBtn = iconBtn('urs-close', 'close', { size: 13, title: t('views-uiskills.karteSchliessen'), onClick: () => { disposeRun(run); RUNS.delete(run.id); card.remove(); updateStartBtn(); } }); head.appendChild(closeBtn);
  // collapse toggle — fold the transcript/steps/result away, keep the status header (like a panel)
  const caret = el('button', 'urs-caret'); caret.textContent = '▾'; caret.title = t('views-uiskills.einAusklappen');
  caret.onclick = () => { const c = card.classList.toggle('collapsed'); caret.textContent = c ? '▸' : '▾'; };
  head.insertBefore(caret, head.firstChild);
  card.appendChild(head);
  if (mode === 'steps') {
    const plan = el('div', 'ui-run-steps');
    steps.forEach((st, i) => { const r = el('div', 'ui-step'); r.setAttribute('data-step', st.id); r.appendChild(el('span', 'step-mark', '○')); r.appendChild(el('span', 'step-title', (i + 1) + '. ' + (st.title || st.id) + (st.confirm ? '  🔒' : ''))); plan.appendChild(r); run.stepEls[st.id] = r; });
    card.appendChild(plan);
  }
  run.tab = uiRunPseudoTab(card);
  RUNS.set(run.id, run);
  runsContainer(skill.name).appendChild(card);
  // the form has done its job — fold it away so the result owns the space (the head keeps the values,
  // the start bar stays; not persisted, so opening the skill fresh still shows the fields)
  if (UISKILL_SEL && UISKILL_SEL.name === skill.name) setRunSetupFolded(true, false);
  updateStartBtn();
  run.timer = setInterval(() => uiRunTick(run), 1000);
  try {
    const body = { cwd: (m.run && m.run.cwd) || undefined, permissionMode: opts.dryRun ? 'plan' : ((m.run && m.run.permissionMode) || 'plan'), model: (m.run && m.run.model) || undefined, fallbackModel: (m.run && m.run.fallbackModel) || undefined, effort: (m.run && m.run.effort) || undefined };
    // P3 — the label only (server.js: recordFreshStart; no projectId, so no instructions and no start values)
    if (opts.labelProjectId) body.labelProjectId = opts.labelProjectId;
    const r = await api('/api/chat/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    run.chatId = r.chatId;
    run.es = new EventSource('/api/chat/' + r.chatId + '/stream');
    run.es.onmessage = (e) => { try { uiRunHandle(run, JSON.parse(e.data)); } catch (err) { console.warn('ui-run bad event', err); } };
    run.es.onerror = () => uiRunStreamLost(run); // RUN-SSE — see uiRunStreamLost: this was `() => {}`
    if (mode === 'steps') { uiRunStatus(run, t('views-uiskills.laeuft'), 'run'); runSteps(run, opts, steps); }
    else { await api('/api/chat/' + r.chatId + '/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: prompt }) }); uiRunStatus(run, t('views-uiskills.laeuft'), 'run'); }
  } catch (e) { toast(e.message, 'err'); uiRunStatus(run, t('common.fehler-2') + e.message, 'error'); run.done = true; run.status = 'error'; updateStartBtn(); if (run.onDone) { const cb = run.onDone; run.onDone = null; cb(run); } }
}

// ---- Bundle 5: batch runs (one run per line, sequential) ----
let BATCH_ABORT = false;
async function startBatch(skill, values, opts, field, lines) {
  const m = skill.manifest || {};
  const miss = missingRequired(m, values).filter((i) => i.id !== field);
  if (miss.length) { miss.forEach((i) => { const f = document.querySelector('#view-uiskills [data-field="' + i.id + '"]'); if (f) f.classList.add('invalid'); }); toast(t('views-uiskills.pflichtfelderFehlen') + miss.map((i) => i.label || i.id).join(', '), 'err'); return; }
  const verr = validateFields(m, values).filter((e) => e.input.id !== field);
  if (verr.length) { verr.forEach((e) => { const f = document.querySelector('#view-uiskills [data-field="' + e.input.id + '"]'); markFieldError(f, e.msg); }); toast(t('views-uiskills.ungueltigeEingaben') + verr.map((e) => e.input.label || e.input.id).join(', '), 'err'); return; }
  const stepBatch = opts.mode === 'steps' && (m.steps || []).length > 0;
  const batchAutoRun = stepBatch ? true : !!opts.autoRun;
  if (stepBatch && !opts.autoRun) toast(t('views-uiskills.stapelImSchrittModus'), 'ok');
  if (m.writes && !opts.dryRun && !(await uiConfirm(t('views-uiskills.stapelLauf') + lines.length + t('views-uiskills.laeufeSchreibenInExterne') + uiWriteEffect(skill, values, opts.autoRun) + t('views-uiskills.alle') + lines.length + t('views-uiskills.ausfuehren'), { danger: true, title: t('views-uiskills.stapelLaufBestaetigen'), okLabel: t('views-uiskills.alleAusfuehren') }))) return;
  // one-time sensitive-data guard over all lines
  if (typeof DISPLAY !== 'undefined' && DISPLAY.guard && typeof scanSensitive === 'function') {
    const sample = lines.map((line) => { const v = Object.assign({}, values); v[field] = line; return uiComposePrompt(skill, v, opts); }).join('\n');
    const hits = scanSensitive(sample);
    if (hits.length && !(await uiConfirm(t('views-uiskills.moeglicherweiseSensibleDatenErkannt') + hits.join(', ') + t('views-uiskills.trotzdemAusfuehren'), { danger: true, title: t('views-uiskills.sensibleDaten'), okLabel: t('chat-composer.trotzdemSenden') }))) return;
  }
  const out = $('#uiRunOutput');
  const sum = el('div', 'ui-batch-sum'); sum.id = 'uiBatchSummary';
  const old = BATCH_SUMMARIES.get(skill.name); if (old) old.remove();
  BATCH_SUMMARIES.set(skill.name, sum);
  out.insertBefore(sum, runsContainer(skill.name));
  const pool = Math.max(1, Math.min(ACTIVE_LIMIT, lines.length));
  sum.appendChild(el('div', 'ui-sec-mini', t('views-uiskills.stapelLauf-2') + lines.length + t('views-uiskills.laeufeBisZu') + pool + t('views-uiskills.parallel') + (opts.dryRun ? t('views-uiskills.testlauf') : '')));
  const rows = lines.map((line) => { const r = el('div', 'ui-batch-row'); const dot = el('span', 'ubr-dot'); r.appendChild(dot); r.appendChild(el('span', 'ubr-line', field + ' = ' + line)); const res = el('span', 'ubr-res', t('views-uiskills.wartet')); r.appendChild(res); sum.appendChild(r); return { line, r, dot, res }; });
  BATCH_ABORT = false;
  const stopAll = iconBtn('ghost-btn danger', 'stop', { size: 14, label: t('views-uiskills.stapelStoppen'), onClick: () => { BATCH_ABORT = true; activeRuns().forEach((r) => { if (r.batch) stopUiRun(r); }); } }); sum.appendChild(stopAll);
  let ok = 0, idx = 0;
  const runOne = (row) => new Promise((resolve) => {
    const v = Object.assign({}, values); v[field] = row.line;
    const fi = m.inputs.find((i) => i.id === field); const lineErr = fi ? fieldError(fi, v[field]) : '';
    if (lineErr) { row.dot.className = 'ubr-dot error'; row.res.textContent = '✕ ' + lineErr; resolve(); return; }
    row.dot.className = 'ubr-dot run'; row.res.textContent = t('views-uiskills.laeuft');
    startUiRun(skill, v, { autoRun: batchAutoRun, dryRun: opts.dryRun, labelProjectId: opts.labelProjectId, batch: true, skipWriteConfirm: true, skipGuard: true, mode: stepBatch ? 'steps' : 'single', onDone: (run) => {
      const st = run ? run.status : 'error';
      row.dot.className = 'ubr-dot ' + st;
      const matches = (run && run.resultMatches) || [];
      row.res.textContent = matches.length ? '→ ' + matches.join(', ') : (st === 'done' ? '✓' : st === 'error' ? '✕' : '■');
      if (st === 'done') ok++;
      resolve();
    } });
  });
  const worker = async () => { while (true) { if (BATCH_ABORT) return; const i = idx++; if (i >= rows.length) return; await runOne(rows[i]); } };
  await Promise.all(Array.from({ length: pool }, worker));
  stopAll.remove();
  sum.appendChild(el('div', 'ui-batch-done', t('views-uiskills.fertig') + ok + '/' + lines.length + t('views-uiskills.erfolgreich')));
  toast(t('views-uiskills.stapelLaufFertig') + ok + '/' + lines.length, ok === lines.length ? 'ok' : 'err');
  if (document.hidden || !$('#view-uiskills').classList.contains('active')) flashDocTitle(t('views-uiskills.stapel') + ok + '/' + lines.length);
}

// ---- Phase 4: visual builder ----
// BUILDER-1 — the builder's draft. `manifest` is what the form shows and every field handler writes into; `saved`
// is the snapshot of the manifest as it was last loaded or written, `hash` the version of the file it came from
// (sent back as If-Match). „Unsaved" is the difference between the two — computed, not a flag set in forty
// handlers: the raw import replaces the whole object and is still seen, a field type added next year needs no
// line for it, and typing a change back makes the draft clean again. `raw` holds the raw-JSON view while it is
// open ({ base, text }); `gone` / `changed` / `missing` are what the panel FOUND OUT about the file (deleted /
// written elsewhere since / no longer in the list) — said on screen by paintBuilderFileNote, never guessed.
let BUILDER = null;
// One number per builder render. Two renders in flight (a save rendered the panel twice) used to race: the GET
// that answered LAST set BUILDER, while the form on screen edited the other manifest — and the next „Gespeichert"
// wrote the one nobody saw. An answer for an older render is dropped now.
let BUILDER_SEQ = 0;
function builderSnapshot(m) { return JSON.stringify(m); }
function builderRawPending() { return !!(BUILDER && BUILDER.raw && BUILDER.raw.text !== BUILDER.raw.base); }
function builderDirty() { return !!BUILDER && typeof BUILDER.saved === 'string' && (builderSnapshot(BUILDER.manifest) !== BUILDER.saved || builderRawPending()); }
function uniqueId(arr, base) { let i = 1, id = base + i; while (arr.some((o) => o.id === id)) { i++; id = base + i; } return id; }
function fmDescription(md) { const m = String(md).match(/^---\s*\n([\s\S]*?)\n---/); if (!m) return ''; const d = m[1].match(/^description:\s*(.*)$/m); return d ? d[1].replace(/^["']|["']$/g, '').trim() : ''; }
function ubInput(value, oninput, placeholder) { const i = el('input', 'ui-input'); i.value = value != null ? value : ''; if (placeholder) i.placeholder = placeholder; i.oninput = () => oninput(i.value); return i; }
// SELECT-NAME — the `.ui-flabel` is a SIBLING of the control, not a wrapper, and carries no `for`: it
// looks like a label and is one visually, but it names nothing. Counted in this file: the row helper below
// is CALLED from 30 places (the builder's permission/effort/placeholder/type/visibility dropdowns, the
// batch field, the schedule form incl. its project label, P3) — 31 textual occurrences minus its own definition — and every
// control in them reached a screen reader as „Kombinationsfeld" with no name. Naming the control from the
// text that already labels it is the whole fix, and it belongs HERE rather than at 30 call sites.
// `for`/`id` would be the other way; it needs a unique id per control, which these rows do not have.
//
// …and `aria-label` alone is only enough on a control. 29 of the 30 rows hand in an <input>/<select>/
// <textarea>; ONE hands in a bare <div> (the weekday buttons of the schedule form), and a name on a
// generic element is not reliably exposed — that group was effectively unnamed. A generic target
// therefore gets `role="group"` with the name, which is what makes the name count. The rule lives here
// rather than at that one call site for the same reason as the rest of this helper: the next non-control
// row would otherwise be unnamed again, silently.
function ubLabel(control, label) {
  if (!control || !control.setAttribute || !label) return control;
  if (!control.getAttribute('aria-label')) control.setAttribute('aria-label', String(label));
  // the list is inline rather than a module constant so the function can be LIFTED whole into a test
  const named = ['input', 'select', 'textarea', 'button', 'meter', 'progress', 'output'];
  const tag = String(control.tagName || '').toLowerCase();
  if (!named.includes(tag) && !control.getAttribute('role')) control.setAttribute('role', 'group');
  return control;
}
function ubRow(label, control) { const r = el('div', 'ui-field'); r.appendChild(el('label', 'ui-flabel', label)); r.appendChild(ubLabel(control, label)); return r; }
// P3 — the panel's projects as a <select> ('' = no label), filled from ensureProjects (projects.js); archived ones are
// left out unless one is the current value. onChange(id | null).
function uiProjectLabelSelect(cur, onChange) {
  const sel = el('select', 'ui-input');
  const fill = () => {
    sel.innerHTML = '';
    const o0 = el('option', null, t('views-uiskills.projektEtikettKeins')); o0.value = ''; sel.appendChild(o0);
    const list = (typeof PROJECTS_DATA !== 'undefined' && Array.isArray(PROJECTS_DATA)) ? PROJECTS_DATA : [];
    list.filter((p) => !p.archived || p.id === cur).forEach((p) => { const o = el('option', null, p.name); o.value = p.id; sel.appendChild(o); });
    sel.value = cur || '';
  };
  fill();
  if (typeof ensureProjects === 'function') Promise.resolve(ensureProjects()).then(() => { if (document.contains(sel)) { fill(); sel.value = cur || ''; } }).catch(() => {});
  sel.onchange = () => { cur = sel.value || null; onChange(cur); };
  return sel;
}
function ubCheck(label, checked, onchange) { const w = el('label', 'ui-check'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!checked; cb.onchange = () => onchange(cb.checked); w.appendChild(cb); w.appendChild(el('span', null, label)); return w; }
// → the permission mode an unattended run of this schedule will REALLY get, or '' while the allowed list is
// unknown (then nothing is claimed). A deliberate mirror of lib/pure.js headlessPermissionMode, which the
// browser cannot require — including its order, because the order is the whole point: a dry or read-only run
// is `plan` whatever the manifest asks for, and only a writing run reaches the mode check. The duplication is
// pinned: test/ultracode-honesty.test.js runs both over the same matrix and fails the moment they diverge.
// `okModes` is STATE.headlessPermModes, i.e. the server's own HEADLESS_PERM_MODES rather than a copy here.
function schedEffectivePermMode(wantMode, okModes, o) {
  o = o || {};
  if (o.dryRun || !o.allowWrites) return 'plan';
  if (!okModes || !okModes.length) return '';          // nothing to check against → say nothing
  const want = wantMode ? String(wantMode) : 'acceptEdits';
  return okModes.includes(want) ? want : 'acceptEdits';
}

async function renderBuilderPanel(host, s) {
  const seq = ++BUILDER_SEQ;
  // BUILDER-1: a draft of THIS skill is kept. Tab, view and language switches and every list reload land here,
  // and each of them used to re-read the file and rebuild BUILDER from it — the draft was gone on the way back.
  // What is still read is the file underneath, quietly (builderProbe), so a kept draft cannot hide that it is old.
  // An orphan is kept even once it is clean again (typed back): it has no file to load, and the GET below would
  // leave an empty pane with a 404 toast instead of the builder that offers „Als neue Datei anlegen".
  if (BUILDER && BUILDER.name === s.name && (builderDirty() || s.orphan)) {
    if (BUILDER.raw) drawRawJson(host); else drawBuilder(host);
    builderProbe(BUILDER, seq);
    return;
  }
  // …and a draft of ANOTHER skill is not loaded over either. Every way to another skill asks first (openUiSkill,
  // „Neuer UI-Skill", „Aus Skill erstellen"); a path that ever does not must not lose it silently here.
  if (builderDirty()) { drawForeignDraft(host); return; }
  host.innerHTML = '<div class="loading">' + t('common.lade') + '</div>';
  let content = '', hash = '';
  try { const r = await api('/api/cfgfile?kind=commands&name=' + encodeURIComponent(s.name)); content = r.content || ''; hash = r.hash || ''; }
  catch (e) { if (seq !== BUILDER_SEQ) return; host.innerHTML = ''; toast(e.message, 'err'); return; }
  if (seq !== BUILDER_SEQ) return;   // a newer render owns BUILDER and the screen
  // The manifest comes from the SAME answer as the hash and the prose. Built from s.manifest (the list as last
  // read), it paired a version the CLI or a second window had written since with the manifest from before: the
  // If-Match told the server „seen it", and the save wrote the old manifest back over theirs without a 409. Same
  // rule as the list (lib/skills.js extractUiManifest), so what is shown is what /api/uiskills would list now.
  let fileMan = null;
  const mm = UI_BLOCK_RE.exec(content);
  try { fileMan = mm ? JSON.parse(mm[1]) : null; } catch { /* no valid block */ }
  if (!fileMan || typeof fileMan !== 'object') fileMan = null;
  const manifest = JSON.parse(JSON.stringify(fileMan || s.manifest || {}));
  manifest.inputs = manifest.inputs || []; manifest.steps = manifest.steps || []; manifest.run = manifest.run || {};
  // the snapshot is taken AFTER the defaults above — they are not a change anybody made. Without a valid block in
  // the file the builder can only show the list's version — and says so (noBlock → paintBuilderFileNote).
  BUILDER = { name: s.name, body: content, hash, manifest, preview: false, saved: builderSnapshot(manifest), noBlock: !fileMan };
  // The list is that old too — the run tab, the head and the list itself follow the file. AFTER the builder is
  // built: the patch rewrites s.manifest in place, and the builder must not depend on it having run.
  if (fileMan && JSON.stringify(fileMan) !== JSON.stringify(s.manifest)) uiSkillCachePatch(s.name, JSON.stringify(fileMan));
  drawBuilder(host);
}
// BUILDER-1 — a kept draft was loaded a while ago: one quiet look at the file. Deleted, or written by someone else
// since? Said at once (paintBuilderFileNote) — the save itself is guarded by If-Match either way. A probe that gets
// no answer claims nothing, and one a save overtook is dropped: it read the file BEFORE that save.
async function builderProbe(b, seq) {
  const h0 = b.hash;
  let gone = false, changed = false;
  try { const r = await api('/api/cfgfile?kind=commands&name=' + encodeURIComponent(b.name)); changed = !!h0 && !!r.hash && r.hash !== h0; }
  catch (e) { if (e && e.data && e.data.code === 'missing') gone = true; else return; }
  if (seq !== BUILDER_SEQ || BUILDER !== b || b.hash !== h0 || b.saving) return;
  b.gone = gone; b.changed = changed;
  paintBuilderFileNote();
}
// the net under the guards: a draft of ANOTHER skill is in the builder — say so and lead there, rather than load
// this skill over it
function drawForeignDraft(host) {
  host.innerHTML = '';
  const box = el('div', 'ub-lint');
  box.appendChild(el('div', 'ub-lint-head', '⚠ ' + t('views-uiskills.entwurfFremd').replace('{name}', BUILDER.name)));
  const go = el('button', 'primary-btn', t('views-uiskills.entwurfZuSkill').replace('{name}', BUILDER.name));
  go.onclick = builderShowDraft;
  const acts = el('div', 'ub-flags'); acts.appendChild(go); box.appendChild(acts);
  host.appendChild(box);
}
// select the skill the draft belongs to — or its orphan, when it is no longer listed — and open its builder
function builderShowDraft() {
  if (!BUILDER) return;
  UISKILL_SEL = uiSkillSelFresh({ name: BUILDER.name });
  UISKILL_TAB = 'edit';
  renderUiSkillList(); renderUiSkillPanel();
}

let DRAG = null;
function makeDraggable(card, grip, arr, idx, host) {
  grip.draggable = true;
  grip.addEventListener('dragstart', (e) => { DRAG = { arr, idx }; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(idx)); } catch { /* */ } card.classList.add('dragging'); });
  grip.addEventListener('dragend', () => card.classList.remove('dragging'));
  card.addEventListener('dragover', (e) => { if (DRAG && DRAG.arr === arr) { e.preventDefault(); card.classList.add('drag-over'); } });
  card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
  card.addEventListener('drop', (e) => { card.classList.remove('drag-over'); if (DRAG && DRAG.arr === arr && DRAG.idx !== idx) { e.preventDefault(); const [mv] = arr.splice(DRAG.idx, 1); arr.splice(idx, 0, mv); DRAG = null; drawBuilder(host); } });
}
function lintManifest(m) {
  const w = [];
  const ids = (m.inputs || []).map((i) => i.id);
  ids.forEach((id, i) => { if (ids.indexOf(id) !== i) w.push(t('views-uiskills.doppelteFeldId') + id); });
  const known = new Set(ids);
  const refs = (str) => (String(str || '').match(/\{\{\s*([\w.]+)\s*\}\}/g) || []).map((x) => x.replace(/[{}#/]/g, '').trim().split('.')[0]).filter((r) => r && r !== 'autoRun');
  refs(m.promptTemplate).forEach((r) => { if (!known.has(r)) w.push(t('views-uiskills.prompttemplateNutztUnbekanntesFeld') + r + '}}'); });
  (m.inputs || []).forEach((i) => { if (OPTION_FIELD_TYPES.includes(i.type) && !(i.options || []).length) w.push(t('views-uiskills.feld-2') + (i.label || i.id) + t('views-uiskills.hatKeineOptionen')); if (typeof i.visibleIf === 'string' && !known.has(i.visibleIf)) w.push(t('views-uiskills.feld-2') + (i.label || i.id) + t('views-uiskills.sichtbarWennUnbekannt') + i.visibleIf); if (i.pattern) { try { new RegExp(i.pattern); } catch { w.push(t('views-uiskills.feld-2') + (i.label || i.id) + t('views-uiskills.ungueltigesMusterRegex')); } } });
  (m.steps || []).forEach((st) => { if (st.enabledBy && !known.has(st.enabledBy)) w.push(t('views-uiskills.schritt-3') + (st.title || st.id) + t('views-uiskills.enabledbyUnbekannt') + st.enabledBy); refs(st.prompt).forEach((r) => { if (!known.has(r)) w.push(t('views-uiskills.schritt-3') + (st.title || st.id) + t('views-uiskills.nutztUnbekanntesFeld') + r + '}}'); }); });
  return [...new Set(w)];
}
function exportManifest() {
  const blob = new Blob([JSON.stringify(BUILDER.manifest, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = BUILDER.name + '.ui-skill.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function insertAtCursor(ta, text) { const s = ta.selectionStart != null ? ta.selectionStart : ta.value.length, e = ta.selectionEnd != null ? ta.selectionEnd : s; ta.value = ta.value.slice(0, s) + text + ta.value.slice(e); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); ta.selectionStart = ta.selectionEnd = s + text.length; }
function placeholderMenu(m, ta) {
  const sel = el('select', 'ui-input ub-ph-sel');
  sel.appendChild(Object.assign(el('option'), { value: '', textContent: t('views-uiskills.platzhalter-2') }));
  (m.inputs || []).forEach((i) => { sel.appendChild(Object.assign(el('option'), { value: '{{' + i.id + '}}', textContent: '{{' + i.id + '}} — ' + (i.label || i.id) })); if (i.type === 'tree' || i.type === 'multiselect') sel.appendChild(Object.assign(el('option'), { value: '{{' + i.id + '.excluded}}', textContent: '{{' + i.id + '.excluded}}' })); });
  sel.appendChild(Object.assign(el('option'), { value: '{{#autoRun}}…{{/autoRun}}', textContent: '{{#autoRun}}…{{/autoRun}}' }));
  sel.onchange = () => { if (sel.value) { insertAtCursor(ta, sel.value); sel.value = ''; } };
  return sel;
}
function drawBuilder(host) {
  const m = BUILDER.manifest;
  host.innerHTML = '';
  const wrap = el('div', 'ui-builder');
  const tb = el('div', 'ub-toolbar');
  const save = iconBtn('primary-btn', 'save', { label: t('common.speichern'), onClick: () => saveBuilder() });
  const test = iconBtn('ghost-btn', 'save', { label: t('views-uiskills.speichernTesten'), onClick: () => saveAndTest() });
  // BUILDER-1: „● ungespeichert" and the way out of a kept draft — both shown only while there is one
  const dirty = el('span', 'dirty-badge hidden', t('html.ungespeichert')); dirty.id = 'ubDirty';
  const discard = iconBtn('ghost-btn hidden', 'close', { label: t('views-uiskills.entwurfVerwerfen'), onClick: builderDiscardAsk }); discard.id = 'ubDiscard';
  const prev = iconBtn('ghost-btn' + (BUILDER.preview ? ' on' : ''), 'display', { label: t('common.vorschau'), onClick: () => { BUILDER.preview = !BUILDER.preview; drawBuilder(host); } });
  const raw = iconBtn('ghost-btn', 'braces', { label: t('views-uiskills.rawImport'), onClick: () => drawRawJson(host) });
  const exp = iconBtn('ghost-btn', 'download', { label: t('views-uiskills.export'), onClick: exportManifest });
  const del = iconBtn('ghost-btn danger', 'trash', { label: t('common.loeschen-2'), onClick: deleteUiSkill }); del.id = 'ubDelete';
  tb.appendChild(save); tb.appendChild(test); tb.appendChild(dirty); tb.appendChild(discard); tb.appendChild(prev); tb.appendChild(raw); tb.appendChild(exp); tb.appendChild(del);
  wrap.appendChild(tb);
  // what is known about the FILE under the draft (deleted / changed elsewhere / not listed) — paintBuilderFileNote
  const fileNote = el('div', 'ub-lint hidden'); fileNote.id = 'ubFileNote';
  wrap.appendChild(fileNote);
  const warns = lintManifest(m);
  if (warns.length) { const lw = el('div', 'ub-lint'); lw.appendChild(el('div', 'ub-lint-head', '⚠ ' + warns.length + t('views-uiskills.hinweisE'))); warns.forEach((x) => lw.appendChild(el('div', 'ub-lint-item', x))); wrap.appendChild(lw); }
  wrap.appendChild(builderMeta(host, m));
  wrap.appendChild(builderInputs(host, m));
  wrap.appendChild(builderSteps(host, m));
  wrap.appendChild(builderTemplate(m));
  // Every field writes into BUILDER.manifest on input/change; ONE delegated listener repaints the marker, so a
  // field nobody has written yet is covered without remembering it. Structural edits redraw (the call below).
  wrap.addEventListener('input', paintBuilderDirty);
  wrap.addEventListener('change', paintBuilderDirty);
  host.appendChild(wrap);
  if (BUILDER.preview) {
    const pv = el('div', 'ub-preview');
    pv.appendChild(el('div', 'ub-sec-title', t('views-uiskills.formularVorschau')));
    const vals = uiDefaultValues(m);
    if (m.inputs.length) m.inputs.forEach((inp) => pv.appendChild(buildInput(inp, vals, { cwd: (m.run || {}).cwd })));
    else pv.appendChild(el('div', 'empty-mini', t('views-uiskills.keineFelder')));
    host.appendChild(pv);
  }
  paintBuilderDirty();   // …and with it the note about the file (paintBuilderFileNote)
}
// Says it while it is true: the badge and „Verwerfen" in the builder's bar, and the dot on the „Bearbeiten" tab —
// seen from every other tab too, which is where a kept draft would otherwise be forgotten.
function paintBuilderDirty() {
  const mine = builderDirty() && !!UISKILL_SEL && BUILDER.name === UISKILL_SEL.name;
  const badge = $('#ubDirty'); if (badge) badge.classList.toggle('hidden', !mine);
  const disc = $('#ubDiscard'); if (disc) disc.classList.toggle('hidden', !mine);
  const tab = $('#uiskillTab-edit');
  if (tab) {
    const dot = tab.querySelector('.ust-draft'); if (dot) dot.classList.toggle('hidden', !mine);
    // the dot is aria-hidden; the name of the tab carries the same fact for a screen reader
    if (mine) { tab.title = t('views-uiskills.entwurfAria'); tab.setAttribute('aria-label', t('common.bearbeiten') + ' — ' + t('views-uiskills.entwurfAria')); }
    else { tab.title = ''; tab.removeAttribute('aria-label'); }
  }
  // the file note speaks of „your draft" only while there is one — typed back, it must stop saying so
  paintBuilderFileNote();
}
// What the panel found out about the file under the draft — only facts: GET said „missing" (gone), a version that
// is not the one the draft was loaded from (changed), the list no longer has the skill (missing), or the file holds
// no valid ui-skill block although the list still had one (noBlock, renderBuilderPanel). „Your draft is only here"
// is said while there IS a draft; a builder typed back to clean still holds the last loaded state, and says that.
function paintBuilderFileNote() {
  const box = $('#ubFileNote'); if (!box || !BUILDER) return;
  const b = BUILDER, dirty = builderDirty();
  const kind = b.gone ? 'gone' : b.changed ? 'changed' : b.missing ? 'missing' : b.noBlock ? 'noblock' : '';
  // nothing to delete once the file is gone — the confirmation would promise a backup and the server answer 404
  const del = $('#ubDelete'); if (del) del.classList.toggle('hidden', kind === 'gone');
  // Rebuilt only when what it says changes. This runs on every `input` AND on the `change` a blur fires — and the
  // blur of a click on one of these buttons comes between its mousedown and its mouseup: rebuilt there, the button
  // under the pointer was replaced and the click went nowhere („Als neue Datei anlegen" right after typing).
  const key = kind + '|' + dirty;
  if (box.noteKey === key) return;
  box.noteKey = key;
  box.innerHTML = '';
  box.classList.toggle('hidden', !kind);
  if (!kind) return;
  const msg = {
    gone: dirty ? 'views-uiskills.entwurfBannerGeloescht' : 'views-uiskills.entwurfBannerGeloeschtSauber',
    changed: 'views-uiskills.entwurfBannerGeaendert',
    missing: dirty ? 'views-uiskills.entwurfBannerFehlt' : 'views-uiskills.entwurfBannerFehltSauber',
    noblock: 'views-uiskills.entwurfBannerKeinBlock',
  }[kind];
  box.appendChild(el('div', 'ub-lint-head', '⚠ ' + t(msg).replace('{name}', b.name)));
  const acts = el('div', 'ub-file-acts');
  if (kind === 'gone') { const c = el('button', 'primary-btn', t('views-uiskills.entwurfNeuAnlegen')); c.onclick = builderCreateAgain; acts.appendChild(c); }
  const d = el('button', 'ghost-btn', t(kind === 'changed' ? 'views.settVerwerfen' : dirty ? 'views-uiskills.entwurfVerwerfen' : 'common.schliessen')); d.onclick = builderDiscardAsk;
  acts.appendChild(d);
  box.appendChild(acts);
}
// Next to the run and schedule tabs while a draft is open: those use the SAVED file.
function builderDraftHint() {
  const box = el('div', 'ub-draft-note');
  box.appendChild(el('span', null, '● ' + t('views-uiskills.entwurfHinweisLauf')));
  const go = el('button', 'ghost-btn', t('views-uiskills.entwurfZumEntwurf'));
  go.onclick = () => { UISKILL_TAB = 'edit'; renderUiSkillPanel(); };
  box.appendChild(go);
  return box;
}

function builderMeta(host, m) {
  const sec = el('div', 'ub-sec');
  sec.appendChild(el('div', 'ub-sec-title', t('views-uiskills.allgemein')));
  const grid = el('div', 'ub-grid');
  grid.appendChild(ubRow(t('views-bug.titel'), ubInput(m.title, (v) => m.title = v, t('views-uiskills.zBCopyJira'))));
  grid.appendChild(ubRow(t('views-uiskills.iconEmoji'), ubInput(m.icon, (v) => m.icon = v, '▶')));
  const perm = el('select', 'ui-input');
  [['plan', t('views-uiskills.planReadOnlySicher')], ['acceptEdits', 'acceptEdits'], ['bypassPermissions', 'bypassPermissions']].forEach(([v, l]) => { const o = el('option'); o.value = v; o.textContent = l; if ((m.run.permissionMode || 'plan') === v) o.selected = true; perm.appendChild(o); });
  perm.onchange = () => m.run.permissionMode = perm.value;
  grid.appendChild(ubRow(t('views-uiskills.permissionMode'), perm));
  grid.appendChild(ubRow(t('views-uiskills.modellOptional'), ubInput(m.run.model, (v) => { if (v) m.run.model = v; else delete m.run.model; }, t('views-uiskills.leerStandard'))));
  // G3 — the stand-in model (`--fallback-model`). Built exactly like the model field above, and deleted
  // rather than stored as '' for the same reason: an empty string here would reach the spawn.
  grid.appendChild(ubRow(t('views-uiskills.ersatzmodellOptional'), ubInput(m.run.fallbackModel, (v) => { if (v) m.run.fallbackModel = v; else delete m.run.fallbackModel; }, t('views-uiskills.ersatzmodellPlaceholder'))));
  const eff = el('select', 'ui-input');
  [['', t('views-uiskills.standard')], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max']].forEach(([v, l]) => { const o = el('option'); o.value = v; o.textContent = l; if ((m.run.effort || '') === v) o.selected = true; eff.appendChild(o); });
  eff.onchange = () => { if (eff.value) m.run.effort = eff.value; else delete m.run.effort; };
  grid.appendChild(ubRow(t('views-uiskills.effortOptional'), eff));
  grid.appendChild(ubRow(t('views-uiskills.arbeitsverzeichnisCwdOptional'), ubInput(m.run.cwd, (v) => { if (v) m.run.cwd = v; else delete m.run.cwd; }, t('views-uiskills.leerStandardCwd'))));
  sec.appendChild(grid);
  sec.appendChild(ubRow(t('views-bug.beschreibung'), ubInput(m.description, (v) => m.description = v, t('views-uiskills.kurzbeschreibungErscheintInDer'))));
  sec.appendChild(ubCheck(t('views-uiskills.schreibtInExterneSysteme'), m.writes, (v) => m.writes = v));
  const rg = el('div', 'ub-grid');
  rg.appendChild(ubRow(t('views-uiskills.ergebnisRegexOptional'), ubInput(m.result && m.result.pattern, (v) => { m.result = m.result || {}; m.result.pattern = v; }, t('views-uiskills.zBProjD'))));
  rg.appendChild(ubRow(t('views-uiskills.ergebnisLabel'), ubInput(m.result && m.result.label, (v) => { m.result = m.result || {}; m.result.label = v; }, t('views-uiskills.neuerProjKey'))));
  sec.appendChild(rg);
  // structured result channel: append the German ui-result instruction paragraph to the promptTemplate
  const addContract = (grouped) => { m.promptTemplate = (m.promptTemplate ? String(m.promptTemplate).replace(/\s*$/, '') + '\n\n' : '') + uiResultContractSnippet(null, grouped); drawBuilder(host); toast(t('views-uiskills.ergebnisKontraktEingefuegt'), 'ok'); };
  const contract = el('button', 'ghost-btn', t('views-uiskills.ergebnisKontraktEinfuegen'));
  contract.title = t('views-uiskills.ergebnisKontraktHint');
  contract.onclick = () => addContract(false);
  // grouped variant: sections + KPI strip + detail line — the shape long results need (ui-result v2)
  const contractG = el('button', 'ghost-btn', t('views-uiskills.ergebnisKontraktGruppiert'));
  contractG.title = t('views-uiskills.ergebnisKontraktGruppiertHint');
  contractG.onclick = () => addContract(true);
  const cRow = el('div', 'ub-flags'); cRow.appendChild(contract); cRow.appendChild(contractG); sec.appendChild(cRow);
  return sec;
}

function builderInputs(host, m) {
  const sec = el('div', 'ub-sec');
  const head = el('div', 'ub-sec-head');
  head.appendChild(el('div', 'ub-sec-title', t('views-uiskills.eingabefelder') + m.inputs.length + ')'));
  const add = el('button', 'ghost-btn', t('views-uiskills.feld')); add.onclick = () => { m.inputs.push({ id: uniqueId(m.inputs, 'feld'), type: 'text', label: t('views-uiskills.neuesFeld') }); drawBuilder(host); };
  head.appendChild(add); sec.appendChild(head);
  if (!m.inputs.length) sec.appendChild(el('div', 'empty-mini', t('views-uiskills.nochKeineFelderMit')));
  m.inputs.forEach((inp, idx) => sec.appendChild(builderInputCard(host, m, inp, idx)));
  return sec;
}
function builderInputCard(host, m, inp, idx) {
  const card = el('div', 'ub-item');
  const bar = el('div', 'ub-item-bar');
  const grip = el('span', 'ub-grip', '⠿'); grip.title = t('views-uiskills.ziehenZumSortieren'); bar.appendChild(grip);
  const typeSel = el('select', 'ui-input ub-type');
  [['text', t('views-uiskills.text')], ['textarea', t('views-uiskills.mehrzeilig')], ['tags', t('views-uiskills.tags')], ['number', t('views-uiskills.zahl')], ['date', t('views-uiskills.datum')], ['file', t('views-uiskills.datei')], ['checkbox', t('views-uiskills.checkbox')], ['yesno', t('views-uiskills.jaNein')], ['select', t('views-uiskills.auswahl')], ['radio', t('views-uiskills.radioEinzel')], ['tree', t('views-uiskills.baumMehrfach')], ['multiselect', t('views-uiskills.mehrfachauswahl')]].forEach(([v, l]) => { const o = el('option'); o.value = v; o.textContent = l; if (inp.type === v) o.selected = true; typeSel.appendChild(o); });
  typeSel.onchange = () => { inp.type = typeSel.value; if (OPTION_FIELD_TYPES.includes(inp.type) && !inp.options) inp.options = [{ value: 'opt1', label: t('views-uiskills.option1') }]; drawBuilder(host); };
  bar.appendChild(typeSel);
  const spacer = el('span', 'ub-spacer'); bar.appendChild(spacer);
  const dup = el('button', 'ub-mini'); dup.innerHTML = ic('copy', 13); dup.title = t('views-uiskills.duplizieren'); dup.onclick = () => { const copy = JSON.parse(JSON.stringify(inp)); copy.id = uniqueId(m.inputs, inp.id + '_copy'); m.inputs.splice(idx + 1, 0, copy); drawBuilder(host); };
  const up = el('button', 'ub-mini'); up.innerHTML = ic('chevronUp', 13); up.title = t('views-uiskills.nachOben'); up.onclick = () => { if (idx > 0) { const a = m.inputs; [a[idx - 1], a[idx]] = [a[idx], a[idx - 1]]; drawBuilder(host); } };
  const dn = el('button', 'ub-mini'); dn.innerHTML = ic('chevronDown', 13); dn.title = t('views-uiskills.nachUnten'); dn.onclick = () => { if (idx < m.inputs.length - 1) { const a = m.inputs; [a[idx + 1], a[idx]] = [a[idx], a[idx + 1]]; drawBuilder(host); } };
  const rm = el('button', 'ub-mini danger'); rm.innerHTML = ic('trash', 13); rm.onclick = () => { m.inputs.splice(idx, 1); drawBuilder(host); };
  bar.appendChild(dup); bar.appendChild(up); bar.appendChild(dn); bar.appendChild(rm);
  card.appendChild(bar);
  makeDraggable(card, grip, m.inputs, idx, host);
  const grid = el('div', 'ub-grid');
  grid.appendChild(ubRow(t('views-uiskills.id'), ubInput(inp.id, (v) => inp.id = v.replace(/[^\w]/g, '') || inp.id)));
  grid.appendChild(ubRow(t('views-uiskills.label'), ubInput(inp.label, (v) => inp.label = v)));
  if (['text', 'textarea', 'number', 'tags'].includes(inp.type)) grid.appendChild(ubRow(t('views-uiskills.platzhalter'), ubInput(inp.placeholder, (v) => inp.placeholder = v)));
  card.appendChild(grid);
  card.appendChild(ubCheck(t('views-uiskills.pflichtfeld'), inp.required, (v) => inp.required = v));
  const vis = el('select', 'ui-input');
  vis.appendChild(Object.assign(el('option'), { value: '', textContent: t('views-uiskills.immerSichtbar') }));
  (m.inputs || []).filter((x) => x.id !== inp.id).forEach((x) => { const o = el('option'); o.value = x.id; o.textContent = t('views-uiskills.nurWenn-2') + (x.label || x.id); if (inp.visibleIf === x.id) o.selected = true; vis.appendChild(o); });
  vis.onchange = () => { if (vis.value) inp.visibleIf = vis.value; else delete inp.visibleIf; };
  card.appendChild(ubRow(t('views-uiskills.sichtbarWenn'), vis));
  if (['text', 'textarea', 'number', 'date', 'tags'].includes(inp.type)) {
    const vg = el('div', 'ub-grid');
    if (['text', 'textarea', 'tags'].includes(inp.type)) vg.appendChild(ubRow(t('views-uiskills.musterRegex'), ubInput(inp.pattern, (v) => { if (v) inp.pattern = v; else delete inp.pattern; }, t('views-uiskills.zBAcmeD'))));
    vg.appendChild(ubRow(inp.type === 'number' ? t('views-uiskills.min-2') : (inp.type === 'date' ? t('views-uiskills.fruehestens') : t('views-uiskills.minLaenge')), ubInput(inp.min, (v) => { if (v !== '') inp.min = v; else delete inp.min; })));
    vg.appendChild(ubRow(inp.type === 'number' ? t('views-uiskills.max') : (inp.type === 'date' ? t('views-uiskills.spaetestens') : t('views-uiskills.maxLaenge')), ubInput(inp.max, (v) => { if (v !== '') inp.max = v; else delete inp.max; })));
    card.appendChild(vg);
    card.appendChild(ubRow(t('views-uiskills.fehlermeldungOptional'), ubInput(inp.errorMessage, (v) => { if (v) inp.errorMessage = v; else delete inp.errorMessage; })));
  }
  if (OPTION_FIELD_TYPES.includes(inp.type)) card.appendChild(builderOptions(host, inp));
  return card;
}
function builderOptions(host, inp) {
  const box = el('div', 'ub-opts');
  box.appendChild(el('div', 'ub-opts-title', t('views-uiskills.optionen')));
  (inp.options || []).forEach((o, i) => {
    const row = el('div', 'ub-opt-row');
    row.appendChild(ubInput(o.value, (v) => o.value = v.replace(/[^\w-]/g, ''), t('views-uiskills.value')));
    row.appendChild(ubInput(o.label, (v) => o.label = v, t('views-uiskills.label')));
    if (inp.type === 'tree' || inp.type === 'multiselect') row.appendChild(ubCheck(t('views-uiskills.default'), o.default, (v) => o.default = v));
    const rm = el('button', 'ub-mini danger'); rm.innerHTML = ic('close', 13); rm.onclick = () => { inp.options.splice(i, 1); drawBuilder(host); }; row.appendChild(rm);
    box.appendChild(row);
  });
  const add = el('button', 'ghost-btn ub-opt-add', t('views-uiskills.option')); add.onclick = () => { inp.options = inp.options || []; inp.options.push({ value: 'opt' + (inp.options.length + 1), label: t('views-uiskills.option-2') }); drawBuilder(host); };
  box.appendChild(add);
  return box;
}

function builderSteps(host, m) {
  const sec = el('div', 'ub-sec');
  const head = el('div', 'ub-sec-head');
  head.appendChild(el('div', 'ub-sec-title', t('views-uiskills.schritte-2') + m.steps.length + ')'));
  const add = el('button', 'ghost-btn', t('views-uiskills.schritt-2')); add.onclick = () => { m.steps.push({ id: uniqueId(m.steps, 'step'), title: t('views-uiskills.neuerSchritt'), prompt: '' }); drawBuilder(host); };
  head.appendChild(add); sec.appendChild(head);
  sec.appendChild(el('div', 'ub-hint', t('views-uiskills.schritteErscheinenAlsCheckliste')));
  if (!m.steps.length) sec.appendChild(el('div', 'empty-mini', t('views-uiskills.nochKeineSchritte')));
  m.steps.forEach((st, idx) => sec.appendChild(builderStepCard(host, m, st, idx)));
  return sec;
}
function builderStepCard(host, m, st, idx) {
  const card = el('div', 'ub-item');
  const bar = el('div', 'ub-item-bar');
  const grip = el('span', 'ub-grip', '⠿'); grip.title = t('views-uiskills.ziehenZumSortieren'); bar.appendChild(grip);
  bar.appendChild(el('span', 'ub-step-n', '#' + (idx + 1)));
  bar.appendChild(el('span', 'ub-spacer'));
  const dup = el('button', 'ub-mini'); dup.innerHTML = ic('copy', 13); dup.title = t('views-uiskills.duplizieren'); dup.onclick = () => { const copy = JSON.parse(JSON.stringify(st)); copy.id = uniqueId(m.steps, st.id + '_copy'); m.steps.splice(idx + 1, 0, copy); drawBuilder(host); };
  const up = el('button', 'ub-mini'); up.innerHTML = ic('chevronUp', 13); up.title = t('views-uiskills.nachOben'); up.onclick = () => { if (idx > 0) { const a = m.steps; [a[idx - 1], a[idx]] = [a[idx], a[idx - 1]]; drawBuilder(host); } };
  const dn = el('button', 'ub-mini'); dn.innerHTML = ic('chevronDown', 13); dn.title = t('views-uiskills.nachUnten'); dn.onclick = () => { if (idx < m.steps.length - 1) { const a = m.steps; [a[idx + 1], a[idx]] = [a[idx], a[idx + 1]]; drawBuilder(host); } };
  const rm = el('button', 'ub-mini danger'); rm.innerHTML = ic('trash', 13); rm.onclick = () => { m.steps.splice(idx, 1); drawBuilder(host); };
  bar.appendChild(dup); bar.appendChild(up); bar.appendChild(dn); bar.appendChild(rm);
  card.appendChild(bar);
  makeDraggable(card, grip, m.steps, idx, host);
  card.appendChild(ubRow(t('views-bug.titel'), ubInput(st.title, (v) => st.title = v)));
  const ta = el('textarea', 'ui-input ui-textarea'); ta.rows = 2; ta.value = st.prompt || ''; ta.placeholder = t('views-uiskills.promptFuerDiesenSchritt'); ta.oninput = () => st.prompt = ta.value;
  const promptRow = ubRow(t('commands.prompt-2'), ta); promptRow.querySelector('.ui-flabel').appendChild(placeholderMenu(m, ta));
  card.appendChild(promptRow);
  const flags = el('div', 'ub-flags');
  flags.appendChild(ubCheck(t('views-uiskills.optionalCheckboxZumEin'), st.optional, (v) => st.optional = v));
  flags.appendChild(ubCheck(t('views-uiskills.bestaetigungGateVorDem'), st.confirm, (v) => st.confirm = v));
  card.appendChild(flags);
  const eb = el('select', 'ui-input');
  const none = el('option'); none.value = ''; none.textContent = t('views-uiskills.immerAktiv'); eb.appendChild(none);
  (m.inputs || []).forEach((i) => { const o = el('option'); o.value = i.id; o.textContent = t('views-uiskills.nurWenn-2') + (i.label || i.id); if (st.enabledBy === i.id) o.selected = true; eb.appendChild(o); });
  eb.onchange = () => { if (eb.value) st.enabledBy = eb.value; else delete st.enabledBy; };
  card.appendChild(ubRow(t('views-uiskills.aktivWenn'), eb));
  return card;
}

function builderTemplate(m) {
  const sec = el('div', 'ub-sec');
  const head = el('div', 'ub-sec-head');
  head.appendChild(el('div', 'ub-sec-title', t('views-uiskills.promptTemplatePhaseA')));
  const ta = el('textarea', 'ui-input ui-textarea ub-tpl'); ta.rows = 8; ta.value = m.promptTemplate || ''; ta.placeholder = '/' + BUILDER.name + ' {{feld}}'; ta.oninput = () => m.promptTemplate = ta.value;
  head.appendChild(placeholderMenu(m, ta)); sec.appendChild(head);
  sec.appendChild(el('div', 'ub-hint', t('views-uiskills.platzhalterFeldIdFeld')));
  sec.appendChild(ta);
  return sec;
}

// BUILDER-1: the raw text is part of the draft (`BUILDER.raw`). Typed but not yet applied, it used to vanish on
// „Zurück" and on any tab switch; now a tab switch brings the raw view back with it, „Zurück" asks before it
// throws away text that was never applied, and a save refuses while it is pending (builderWrite).
function drawRawJson(host) {
  const b = BUILDER;
  if (!b.raw) { const base = JSON.stringify(b.manifest, null, 2); b.raw = { base, text: base }; }
  const wrap = el('div', 'ui-builder');
  wrap.appendChild(el('div', 'ub-sec-title', t('views-uiskills.rawJsonManifest')));
  const ta = el('textarea', 'ui-input ui-textarea ub-raw'); ta.rows = 24; ta.value = b.raw.text;
  ta.oninput = () => { b.raw.text = ta.value; paintBuilderDirty(); };
  wrap.appendChild(ta);
  const bar = el('div', 'ub-toolbar');
  const apply = el('button', 'primary-btn', t('chat.uebernehmen')); apply.onclick = () => { try { const o = JSON.parse(ta.value); if (!o || typeof o !== 'object') throw new Error(t('views-uiskills.keinObjekt')); o.inputs = o.inputs || []; o.steps = o.steps || []; o.run = o.run || {}; b.manifest = o; b.raw = null; drawBuilder(host); toast(t('views-uiskills.uebernommenNochNichtGespeichert'), 'ok'); } catch (e) { toast(t('views-uiskills.jsonFehler') + e.message, 'err'); } };
  const back = el('button', 'ghost-btn', t('views-uiskills.zurueck'));
  // „Zurück" throws away the raw TEXT only — the manifest draft stays. „Entwurf verwerfen" means everything unsaved
  // everywhere else in the builder, so this button has its own label.
  back.onclick = async () => {
    if (b.raw && b.raw.text !== b.raw.base && !(await uiConfirm(t('views-uiskills.rohJsonVerwerfenFrage'), { danger: true, title: t('views-uiskills.rawJsonManifest'), okLabel: t('views-uiskills.textVerwerfen') }))) return;
    b.raw = null; drawBuilder(host);
  };
  const dirty = el('span', 'dirty-badge hidden', t('html.ungespeichert')); dirty.id = 'ubDirty';
  bar.appendChild(apply); bar.appendChild(back); bar.appendChild(dirty); wrap.appendChild(bar);
  host.innerHTML = ''; host.appendChild(wrap);
  paintBuilderDirty();
}

// BUILDER-1 — → true only when the file on disk now holds what the builder shows; every refusal and failure says
// why (a toast or the conflict dialog) and returns false, with the draft untouched. saveBuilder used to report
// nothing at all, so „Speichern & testen" switched to the run tab — with the old manifest — whatever happened.
// One write per draft at a time: a second click while the PUT is out gets the first one's answer, instead of a
// second PUT whose version the first is about to make stale (that read as „changed elsewhere" — SETT_SAVING).
async function persistBuilder(opts) {
  const b = BUILDER;
  // a „Speichern" with nothing loaded is a screen that outlived its draft — say so instead of doing nothing
  if (!b) { toast(t('views-uiskills.nichtsZuSpeichern'), 'err'); return false; }
  if (b.saving) return b.saving;
  b.saving = builderWrite(b, opts || {});
  try { return await b.saving; } finally { b.saving = null; }
}
// The snapshot and the text are taken BEFORE the PUT: the form stays live while it is out, and what is typed in
// that time was not sent — a snapshot taken afterwards counted it as saved, and the reload after the save threw it
// away. After the await everything goes into `b`, the draft this save belongs to, not into whatever BUILDER is by
// then: a „Verwerfen" in between would otherwise hand A's text to B, or throw on null after a write that worked.
// opts.tag: the version to overwrite (the one a 409 reported); opts.create: write a NEW file, never over one.
async function builderWrite(b, opts) {
  if (b.raw && b.raw.text !== b.raw.base) { toast(t('views-uiskills.rohJsonOffen'), 'err'); return false; }
  const m = b.manifest;
  const ids = (m.inputs || []).map((i) => i.id);
  // only an ERROR blocks — lintManifest's warnings are hints the builder shows, and a skill with one still runs
  if (new Set(ids).size !== ids.length) { toast(t('views-uiskills.doppelteFeldIdsBitte'), 'err'); return false; }
  const snap = builderSnapshot(m);
  const content = serializeSkillMd(b.body, m);
  const headers = { 'Content-Type': 'application/json' };
  const tag = opts.tag !== undefined ? opts.tag : b.hash;
  if (!opts.create && tag) headers['If-Match'] = '"' + tag + '"';
  const payload = { kind: 'commands', name: b.name, content };
  if (opts.create) payload.create = true;
  let r;
  try { r = await api('/api/cfgfile', { method: 'PUT', headers, body: JSON.stringify(payload) }); }
  catch (e) {
    const d = (e && e.data) || {};
    if (d.code === 'changed') return builderConflict(b, d);
    // the server compares without case and names the file it found — X.md against the draft x is „/X", not „/x"
    if (d.code === 'exists') { toast(t('views-uiskills.entwurfNameBelegt').replace('{name}', String(d.existing || '').replace(/\.md$/i, '') || b.name), 'err'); return false; }
    if (d.code === 'unreadable') { toast(t('views-uiskills.entwurfUnlesbar').replace('{name}', b.name), 'err'); return false; }
    toast((e && e.message) || String(e), 'err');
    return false;
  }
  b.body = content; b.saved = snap; b.hash = (r && r.hash) || '';
  b.gone = false; b.changed = false; b.missing = false; b.noBlock = false;   // the file holds this block now
  uiSkillCachePatch(b.name, snap);
  toast(t('common.gespeichert'), 'ok');
  if (BUILDER === b) paintBuilderDirty();   // the badge, the tab dot — and the file note, cleared above
  return true;
}
// The 409 of a save that would have overwritten something nobody in this builder has seen. Three answers, like the
// settings editor; „Abbrechen" (and Esc) writes nothing and keeps the draft.
async function builderConflict(b, d) {
  if (d.exists === false) {
    b.gone = true; if (BUILDER === b) paintBuilderFileNote();
    const v = await uiModal({
      icon: '⚠', title: t('views-uiskills.entwurfGeloeschtTitel'), message: t('views-uiskills.entwurfGeloeschtText').replace('{name}', b.name), escValue: 'cancel',
      actions: [
        { label: t('html.abbrechen'), value: 'cancel' },
        { label: t('views-uiskills.entwurfVerwerfen'), value: 'discard', kind: 'danger-btn' },
        { label: t('views-uiskills.entwurfNeuAnlegen'), value: 'create', primary: true },
      ],
    });
    if (v === 'create') return builderWrite(b, { create: true });
    if (v === 'discard' && BUILDER === b) await builderDiscard();
    return false;
  }
  b.changed = true; if (BUILDER === b) paintBuilderFileNote();
  const v = await uiModal({
    icon: '⚠', title: t('views.settGeaendertTitel'), message: t('views-uiskills.entwurfGeaendertText').replace('{name}', b.name), escValue: 'cancel',
    actions: [
      { label: t('html.abbrechen'), value: 'cancel' },
      { label: t('views.settUeberschreiben'), value: 'overwrite', kind: 'danger-btn' },
      { label: t('html.neuLaden'), value: 'reload', primary: true },
    ],
  });
  // the version to overwrite is the one the 409 just reported — a file that changes AGAIN meanwhile asks again
  if (v === 'overwrite') return builderWrite(b, { tag: d.hash || '' });
  if (v === 'reload' && BUILDER === b) await builderDiscard();
  return false;
}
// BUILDER-1 — after a save the cached list still held the OLD manifest, and everything that opens a skill reads it:
// the run tab, the schedule, the head of the panel. A save from the „switch skill?" question, or one whose list
// reload failed, led back to the old version there. One file changed → patch it in place (the rule of
// patchMemCacheEntry). renderBuilderPanel patches it too, when the file it just read holds another manifest.
function uiSkillCachePatch(name, snap) {
  (UISKILLS_DATA || []).forEach((s) => { if (s.name === name) s.manifest = JSON.parse(snap); });
  if (UISKILL_SEL && UISKILL_SEL.name === name && !(UISKILLS_DATA || []).includes(UISKILL_SEL)) UISKILL_SEL.manifest = JSON.parse(snap);
  renderUiSkillList();
  if (UISKILL_SEL && UISKILL_SEL.name === name) paintUiSkillHead();
}
// the head of the panel (icon, title) from the selection's manifest — in place, so a patched cache does not leave
// the old title above a builder that shows the new one until the next full render
function paintUiSkillHead() {
  const p = $('#uiskillPanel'), head = p && p.querySelector('.uiskill-head');
  if (!head || !UISKILL_SEL) return;
  const m = UISKILL_SEL.manifest || {};
  const icon = head.querySelector('.uh-icon'); if (icon) icon.textContent = m.icon || '▶';
  const name = head.querySelector('.uh-name'); if (name) name.textContent = m.title || UISKILL_SEL.name;
}
// → true when saved. loadUiSkills renders the panel itself; the second render that stood here started a second GET
// for a second host, one of them already detached (the race BUILDER_SEQ closes). Rendered by hand only when the
// list read failed, so the panel does not go on showing the tab it showed before.
// The tab is set only while the panel still shows the skill that was saved: a switch to another skill while the PUT
// was out (the question answers „Speichern" or „Verwerfen" meanwhile) is not pulled back, nor its run form reset.
async function saveBuilder() {
  const name = BUILDER && BUILDER.name;
  if (!(await persistBuilder())) return false;
  if (!UISKILL_SEL || UISKILL_SEL.name !== name) return true;
  UISKILL_TAB = 'edit';
  if (!(await loadUiSkills())) renderUiSkillPanel();
  return true;
}
// „Speichern & testen" = save, then the run FORM of the saved version; it starts no run. Only after a save that
// worked: switching after a failed one showed the old manifest as if it were the new one. RUN_SKILL is reset
// BEFORE the render, so renderRunPanel fills the fields of the new manifest instead of keeping the old values.
async function saveAndTest() {
  const name = BUILDER && BUILDER.name;
  if (!(await persistBuilder())) return false;
  if (!UISKILL_SEL || UISKILL_SEL.name !== name) return true;
  UISKILL_TAB = 'run'; RUN_SKILL = null;
  if (!(await loadUiSkills())) renderUiSkillPanel();
  return true;
}
// Asked only where the draft would really be replaced: another skill, „Neuer UI-Skill", „Aus Skill erstellen". Tab,
// view and language switches keep it silently (renderBuilderPanel) and mark it (paintBuilderDirty). Three answers
// like memDraftMayGo — without „Abbrechen" the dialog forces the choice it asks about — and a save that FAILED is
// not „the draft is safe now". A save whose conflict dialog dropped the draft („Neu laden", „Entwurf verwerfen") has
// nothing left to keep either: the way is free, rather than a halt that makes the user click again.
async function builderDraftMayGo() {
  if (!builderDirty()) return true;
  const b = BUILDER;
  const v = await uiModal({
    icon: '⚠', title: t('views-uiskills.entwurfTitel'),
    message: t('views-uiskills.entwurfFrage').replace('{name}', b.name),
    escValue: 'cancel',
    actions: [
      { label: t('html.abbrechen'), value: 'cancel' },
      { label: t('views-uiskills.entwurfVerwerfen'), value: 'discard', kind: 'danger-btn' },
      { label: t('common.speichern'), value: 'save', primary: true },
    ],
  });
  if (v === 'save') return (await persistBuilder()) || BUILDER !== b;
  if (v === 'discard') {
    if (BUILDER === b) {
      BUILDER = null;
      // The screen follows at once. The caller may still stop after this (an overwrite declined, a failed read or
      // PUT): left standing, the form showed the discarded draft with „● ungespeichert", and its „Speichern" had
      // nothing to save. An orphan has no file behind it — the cockpit, as in builderDiscard.
      if (UISKILL_SEL && UISKILL_SEL.orphan) UISKILL_SEL = null;
      renderUiSkillList(); renderUiSkillPanel();
    }
    return true;
  }
  return false;
}
// Throw the draft away and show the file as it is NOW — a fresh list read, not the cached manifest the draft
// started from. An orphan has no file left to show, so the panel goes back to the cockpit.
async function builderDiscard() {
  BUILDER = null;
  if (UISKILL_SEL && UISKILL_SEL.orphan) UISKILL_SEL = null;
  if (!(await loadUiSkills())) renderUiSkillPanel();
}
// the „Verwerfen" buttons: an explicit act, but one click away from ten minutes of work — so it asks once
// — and says what comes after: the saved file, or (deleted, not listed, no valid block) nothing the builder can show
async function builderDiscardAsk() {
  if (!BUILDER) return;
  const b = BUILDER, noFile = !!(b.gone || b.missing || b.noBlock || (UISKILL_SEL && UISKILL_SEL.orphan));
  const ask = noFile ? 'views-uiskills.entwurfVerwerfenFrageWeg' : 'views-uiskills.entwurfVerwerfenFrage';
  if (builderDirty() && !(await uiConfirm(t(ask).replace('{name}', b.name), { danger: true, title: t('views-uiskills.entwurfTitel'), okLabel: t('views-uiskills.entwurfVerwerfen') }))) return;
  await builderDiscard();
}
// „Als neue Datei anlegen": the draft of a deleted skill, written under its name as a NEW file — refused (409
// exists) if something has taken the name in the meantime, never an overwrite of it
async function builderCreateAgain() {
  const name = BUILDER && BUILDER.name;
  if (!(await persistBuilder({ create: true }))) return false;
  if (!UISKILL_SEL || UISKILL_SEL.name !== name) return true;
  UISKILL_TAB = 'edit';
  if (!(await loadUiSkills())) renderUiSkillPanel();
  return true;
}
// ↻ in the list header. The builder keeps a draft across a list reload now, so an EXPLICIT reload asks — the rule of
// the settings editor's settReload: discard the draft and show the files as they are, or keep editing.
async function uiSkillsReload() {
  if (!builderDirty()) return loadUiSkills();
  if (!(await uiConfirm(t('views-uiskills.entwurfNeuLadenFrage').replace('{name}', BUILDER.name), { danger: true, title: t('views-uiskills.entwurfTitel'), okLabel: t('views.settVerwerfen') }))) return false;
  await builderDiscard();
  return true;
}
async function deleteUiSkill() {
  if (!BUILDER) return;
  if (!(await uiConfirm(t('views-uiskills.uiSkill') + BUILDER.name + t('views-uiskills.loeschenDieMdWird'), { danger: true, title: t('views-uiskills.uiSkillLoeschen'), okLabel: t('common.loeschen-2') }))) return;
  try { await api('/api/cfgfile/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'commands', name: BUILDER.name }) }); toast(t('views-uiskills.geloescht'), 'ok'); UISKILL_SEL = null; BUILDER = null; if (!(await loadUiSkills())) renderUiSkillPanel(); } catch (e) { toast(e.message, 'err'); }
}

// topbar: create new / convert an existing command into a UI skill
async function uiskillCreateNew() {
  const name = await uiPrompt(t('views-uiskills.nameDesNeuenUi'), 'mein-ui-skill', { title: t('views-uiskills.neuerUiSkill'), okLabel: t('views-uiskills.erstellen') });
  if (!name) return;
  const clean = name.replace(/[^\w.-]/g, ''); if (!clean) { toast(t('views-uiskills.ungueltigerName'), 'err'); return; }
  // BUILDER-1: the new skill opens in the builder — over a draft that would be gone, so it is asked about first
  if (!(await builderDraftMayGo())) return;
  let existing = []; try { const d = await api('/api/skills'); existing = (d.commands || []).map((c) => c.name); } catch { /* ignore */ }
  if (existing.includes(clean) && !(await uiConfirm(t('views-uiskills.command') + clean + t('views-uiskills.existiertBereitsUeberschreiben'), { danger: true, title: t('views-uiskills.ueberschreiben-2'), okLabel: t('views-uiskills.ueberschreiben') }))) return;
  const manifest = { version: 1, title: name, icon: '▶', description: '', writes: false, run: { permissionMode: 'plan' }, inputs: [{ id: 'thema', type: 'text', label: t('views-uiskills.thema'), required: true }], steps: [], promptTemplate: '/' + clean + ' {{thema}}' };
  const body = '---\ndescription: ' + name + '\n---\n\n# ' + name + t('views-uiskills.beschreibungDesSkills');
  try { await api('/api/cfgfile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'commands', name: clean, content: serializeSkillMd(body, manifest) }) }); toast(t('views-uiskills.erstellt'), 'ok'); await loadUiSkills(); const s = UISKILLS_DATA.find((x) => x.name === clean); if (s) { UISKILL_SEL = s; UISKILL_TAB = 'edit'; renderUiSkillList(); renderUiSkillPanel(); } } catch (e) { toast(e.message, 'err'); }
}
async function uiskillFromSkillPick() {
  let data; try { data = await api('/api/skills'); } catch (e) { toast(e.message, 'err'); return; }
  const uiNames = new Set((UISKILLS_DATA || []).map((s) => s.name));
  const cmdNames = new Set((data.commands || []).map((c) => c.name));
  const cmds = (data.commands || []).filter((c) => !uiNames.has(c.name)).map((c) => ({ name: c.name, description: c.description, source: 'command' }));
  const bundled = (data.skills || []).filter((c) => !uiNames.has(c.name) && !cmdNames.has(c.name)).map((c) => ({ name: c.name, description: c.description, source: 'bundled' }));
  const all = [...cmds, ...bundled];
  if (!all.length) { toast(t('views-uiskills.keineWeiterenSkillsZum'), 'err'); return; }
  const ov = el('div', 'modal-overlay');
  ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
  const box = el('div', 'modal uiskill-picker');
  // This dialog had NO Esc handler and NO focus trap: Esc fell through to the global chain in commands.js
  // (which, with a turn running, armed the abort) and Tab walked straight into the page behind it. It also
  // disappeared via three separate bare `ov.remove()` calls — exactly the shape that leaves a corpse on
  // the overlay stack. One `close()` now, and overlayPrune() is the net under it.
  const close = () => { overlayPop(ov); ov.remove(); };
  box.appendChild(el('div', 'ub-sec-title', t('views-uiskills.ausSkillErstellenSkill')));
  box.appendChild(el('div', 'ub-hint', t('views-uiskills.esWirdEineKopie')));
  const list = el('div', 'uiskill-picker-list');
  all.forEach((c) => { const b = el('button', 'uiskill-picker-item'); const nm = el('div', 'upi-name', '/' + c.name); if (c.source === 'bundled') nm.appendChild(el('span', 'upi-src', t('views-uiskills.bundled'))); b.appendChild(nm); if (c.description) b.appendChild(el('div', 'upi-desc', c.description)); b.onclick = () => { close(); convertToUiSkill(c.name, c.source); }; list.appendChild(b); });
  box.appendChild(list);
  const cancel = el('button', 'ghost-btn', t('html.abbrechen')); cancel.onclick = close; box.appendChild(cancel);
  ov.appendChild(box); ov.onclick = (e) => { if (e.target === ov) close(); };
  document.body.appendChild(ov);
  overlayPush(ov, { box, onEsc: close });
}
async function convertToUiSkill(name, source) {
  // BUILDER-1: every way out of here opens a builder — the new skill, or the existing -ui skill when the overwrite
  // is declined (that branch writes nothing) — so the open draft is asked about before anything else
  if (!(await builderDraftMayGo())) return;
  source = source || 'command';
  const target = (name + '-ui').replace(/[^\w.-]/g, '');
  // DATA-UI-2 — the server DOES guard the target: /api/skill/duplicate answers 409 „existiert bereits"
  // and copies nothing (server.js POST /api/skill/duplicate). This function used to swallow exactly that
  // 409 (`if (!/existiert/i.test(...))` fell through without a word) and then PUT a freshly generated
  // manifest over the file anyway — so „Aus Skill erstellen" silently replaced an existing `-ui` skill,
  // including every input, step and run setting someone had edited into it. The refusal is now the
  // question it always was. (The overwrite itself cannot be refused server-side: the PUT it goes through
  // is the editor's own save route, whose job IS to overwrite — the 409 above is the create-guard.)
  try { await api('/api/skill/duplicate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, source, target }) }); }
  catch (e) {
    if (!(e.status === 409 || /existiert/i.test(e.message))) { toast(e.message, 'err'); return; }
    const ok = await uiConfirm(t('views-uiskills.uiSkillExistiert').replace('{name}', target),
      { danger: true, title: t('views-uiskills.ueberschreiben-2'), okLabel: t('views-uiskills.ueberschreiben') });
    if (!ok) { const ex = (UISKILLS_DATA || []).find((x) => x.name === target); if (ex) { UISKILL_SEL = ex; UISKILL_TAB = 'edit'; renderUiSkillList(); renderUiSkillPanel(); } return; }
  }
  let content = ''; try { const r = await api('/api/cfgfile?kind=commands&name=' + encodeURIComponent(target)); content = r.content || ''; } catch (e) { toast(e.message, 'err'); return; }
  const steps = (typeof skillFlow === 'function' ? (skillFlow(content) || []) : []).map((st, i) => ({ id: 'step' + (i + 1), title: st.title, prompt: '' }));
  const hasArgs = /\$ARGUMENTS/.test(content);
  const manifest = { version: 1, title: name, icon: '▶', description: fmDescription(content), writes: false, run: { permissionMode: 'plan' }, inputs: hasArgs ? [{ id: 'arguments', type: 'text', label: t('html.argumente'), placeholder: '$ARGUMENTS' }] : [], steps, promptTemplate: '/' + target + (hasArgs ? ' {{arguments}}' : '') };
  try { await api('/api/cfgfile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'commands', name: target, content: serializeSkillMd(content, manifest) }) }); toast(t('views-uiskills.uiSkillErstellt') + target, 'ok'); await loadUiSkills(); const s = UISKILLS_DATA.find((x) => x.name === target); if (s) { UISKILL_SEL = s; UISKILL_TAB = 'edit'; renderUiSkillList(); renderUiSkillPanel(); } } catch (e) { toast(e.message, 'err'); }
}

// ---- Phase 5: run history (Verlauf) ----
function uiTimeAgo(ts) {
  const d = Date.now() - ts; const m = Math.floor(d / 60000);
  if (m < 1) return t('render.geradeEben');
  if (m < 60) return t('common.vorNMin').replace('{n}', m);
  const h = Math.floor(m / 60); if (h < 24) return t('common.vorNStd').replace('{n}', h);
  return t('common.vorNTg').replace('{n}', Math.floor(h / 24));
}
// 'aborted' = ended by a server restart/shutdown (FLOW-2); 'deferred' = not started while the CLI updated.
// Both used to fall through to „lief" — which reads as a run that went fine.
// 'missing-skill' = the schedule's skill no longer exists (FLOW-7, lib/engine.js runScheduled). THIS is
// the reader that status is written for: without it the row would read „lief" and claim a run happened.
function histStatusLabel(s) {
  return s === 'done' ? t('views-uiskills.fertig-3') : s === 'error' ? t('views-uiskills.fehler') : s === 'stopped' ? t('views-uiskills.gestoppt-2')
    : s === 'aborted' ? t('views-uiskills.abgebrochen') : s === 'deferred' ? t('views-uiskills.verschoben')
      : s === 'missing-skill' ? t('views-uiskills.skillFehlt') : t('views-uiskills.lief');
}
function histInputsSummary(manifest, values) {
  // DISPLAY: the run-history line a human reads, localised
  const parts = (manifest.inputs || []).map((i) => (i.label || i.id) + ': ' + (uiRenderInputValue(i, (values || {})[i.id], UI_YESNO_LABELS()) || '—'));
  return parts.join('  ·  ') || t('views-uiskills.keineEingaben');
}
function rerunFromHistory(run) { UISKILL_PREFILL = run.inputs || {}; UISKILL_TAB = 'run'; renderUiSkillPanel(); toast(t('views-uiskills.eingabenUebernommenPruefenUnd'), 'ok'); }
async function openRunTranscript(sessionId) {
  showView('sessions');
  if (typeof SESSIONS === 'undefined' || !SESSIONS || !SESSIONS.length) { try { await loadSessions(); } catch { /* */ } }
  const sess = (typeof SESSIONS !== 'undefined' ? SESSIONS : []).find((x) => x.id === sessionId);
  if (sess && typeof openTranscript === 'function') openTranscript(sess);
  else toast(t('views-uiskills.sessionNichtGefundenEvtl'), 'err');
}
function openTranscriptModal(run) {
  const body = el('div', 'ui-transcript-wrap');
  const bar = el('div', 'ui-result-head');
  const cp = iconBtn('ghost-btn ui-result-act', 'copy', { label: t('common.kopieren') }); cp.onclick = () => { copyText(run.transcript || ''); toast(t('views-uiskills.transkriptKopiert'), 'ok'); };
  bar.appendChild(cp); body.appendChild(bar);
  // rotated = older than the newest 20 runs, so writeUiRuns dropped the raw text to keep
  // ui-skill-runs.json small. Say WHY instead of opening an empty pane.
  const noText = run.transcriptRotated ? t('views-uiskills.transkriptRotiert') : t('views-uiskills.keinTranskriptGespeichert');
  const pre = el('pre', 'ui-transcript-view'); pre.textContent = run.transcript || noText; body.appendChild(pre);
  uiModal({ icon: '📄', title: t('views-uiskills.transkript') + (run.title || run.name), body, wide: true, escValue: null, actions: [{ label: t('common.schliessen'), value: null, primary: true }] });
}
function fmtDuration(ms) { if (!ms) return ''; const s = Math.round(ms / 1000); if (s < 60) return s + 's'; return Math.floor(s / 60) + 'm ' + (s % 60) + 's'; }
let HIST_FILTER = { status: '', dry: false, q: '' };
function exportHistory(runs, s) {
  const rows = [[t('views-uiskills.zeit'), t('views-uiskills.status'), t('views-uiskills.testlauf-3'), t('views-uiskills.modus-2'), t('views-uiskills.dauerMs'), t('views-uiskills.eingaben')]];
  runs.forEach((r) => rows.push([new Date(r.startedAt).toISOString(), r.status, r.dryRun ? t('views-uiskills.ja') : t('views-uiskills.nein'), r.mode || '', String(r.durationMs || 0), histInputsSummary(s.manifest, r.inputs)]));
  const csv = csvRows(rows); // SEC-7, see public/js/csv.js — the inputs summary is user text
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'verlauf-' + s.name + '.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(runs.length + t('views-uiskills.laeufeAlsCsvExportiert'), 'ok');
}
function histItemEl(host, s, run, prevKeys, cmpSel, refreshCmp) {
  const it = el('div', 'ui-hist-item');
  const top = el('div', 'uh-top');
  if (cmpSel && run.result && run.result.rows && run.result.rows.length) { // select two → compare
    const cb = el('input', 'uh-cmp'); cb.type = 'checkbox'; cb.checked = cmpSel.indexOf(run.id) >= 0;
    cb.title = t('views-uiskills.zumVergleichWaehlen'); cb.setAttribute('aria-label', cb.title);
    cb.onchange = () => {
      const at = cmpSel.indexOf(run.id);
      if (cb.checked && at < 0) { if (cmpSel.length >= 2) { cb.checked = false; toast(t('views-uiskills.nurZweiLaeufe'), 'err'); return; } cmpSel.push(run.id); }
      else if (!cb.checked && at >= 0) cmpSel.splice(at, 1);
      if (refreshCmp) refreshCmp();
    };
    top.appendChild(cb);
  }
  top.appendChild(el('span', 'uh-badge ' + run.status, histStatusLabel(run.status)));
  if (run.dryRun) top.appendChild(el('span', 'uh-badge dry', t('views-uiskills.test-2')));
  if (run.mode === 'steps') top.appendChild(el('span', 'uh-mini-tag', t('common.schritte')));
  top.appendChild(el('span', 'uh-time', uiTimeAgo(run.startedAt) + (run.durationMs ? ' · ' + fmtDuration(run.durationMs) : '')));
  const del = el('button', 'uh-del', '🗑'); del.title = t('views-uiskills.eintragLoeschen'); del.onclick = async () => { try { await api('/api/uiskill/runs/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: run.id }) }); renderHistoryPanel(host, s); } catch (e) { toast(e.message, 'err'); } };
  top.appendChild(del);
  it.appendChild(top);
  it.appendChild(el('div', 'uh-inputs', histInputsSummary(s.manifest, run.inputs)));
  if (Array.isArray(run.steps) && run.steps.length) {
    const sd = el('div', 'uh-steps');
    run.steps.forEach((st) => { const r = el('div', 'uh-step ' + (st.status || '')); r.appendChild(el('span', 'uhstep-mark', st.status === 'done' ? '✓' : st.status === 'error' ? '✕' : st.status === 'skipped' ? '⤼' : '•')); r.appendChild(el('span', null, st.title || st.id)); sd.appendChild(r); });
    it.appendChild(sd);
  }
  // persisted result (ui-result block or regex fallback) — re-rendered with the same card as live runs
  if (run.result && run.result.rows && run.result.rows.length) it.appendChild(renderResultBlock(s.manifest, run.result, run.status, null, prevKeys));
  const acts = el('div', 'uh-acts');
  const reNow = el('button', 'ghost-btn', '▶ ' + t('views-uiskills.erneutAusfuehren'));
  reNow.onclick = () => {
    UISKILL_PREFILL = JSON.parse(JSON.stringify(run.inputs || {}));
    UISKILL_TAB = 'run'; renderUiSkillPanel();
    const values = Object.assign(uiDefaultValues(s.manifest), JSON.parse(JSON.stringify(run.inputs || {})));
    startUiRun(s, values, { autoRun: uiAutoRunDefault(), dryRun: !!run.dryRun, mode: run.mode === 'steps' ? 'steps' : 'single' }); // same gates as Start (Pflichtfelder/Writes)
  };
  acts.appendChild(reNow);
  const re = el('button', 'ghost-btn', t('views-uiskills.eingabenUebernehmen')); re.onclick = () => rerunFromHistory(run); acts.appendChild(re);
  // `transcriptRotated && !sessionId` = the raw text was rotated out and there is no session to fall
  // back to → still offer the button, so the modal can explain the rotation instead of nothing at all.
  if (run.hasTranscript || run.transcript || (run.transcriptRotated && !run.sessionId)) {
    const tr = el('button', 'ghost-btn', t('views-uiskills.transkript-2'));
    tr.onclick = async () => { // transcripts are stripped from the meta list → lazy-load the single run
      let full = run;
      if (!run.transcript) { try { const d = await api('/api/uiskill/runs/' + encodeURIComponent(run.id)); full = d.run || run; } catch (e) { toast(e.message, 'err'); return; } }
      openTranscriptModal(full);
    };
    acts.appendChild(tr);
  }
  else if (run.sessionId) { const tr = el('button', 'ghost-btn', t('views-uiskills.transkript-2')); tr.onclick = () => openRunTranscript(run.sessionId); acts.appendChild(tr); }
  it.appendChild(acts);
  return it;
}
async function renderHistoryPanel(host, s) {
  host.innerHTML = '<div class="loading">' + t('common.lade') + '</div>';
  let allRuns = [];
  try { const r = await api('/api/uiskill/runs?name=' + encodeURIComponent(s.name) + '&meta=1'); allRuns = (r.runs || []).reverse(); } // server filters + strips fat transcripts
  catch (e) { host.innerHTML = ''; toast(e.message, 'err'); return; }
  host.innerHTML = '';
  if (!allRuns.length) { host.appendChild(el('div', 'empty-mini', t('views-uiskills.nochKeineDurchlaeufeFuer'))); return; }
  const ok = allRuns.filter((r) => r.status === 'done').length;
  const stats = el('div', 'ui-hist-stats');
  stats.appendChild(el('span', 'uhs-kpi', allRuns.length + t('views-uiskills.laeufe')));
  stats.appendChild(el('span', 'uhs-kpi', ok + t('views-uiskills.erfolgreich')));
  stats.appendChild(el('span', 'uhs-kpi', t('views-uiskills.zuletzt-2') + uiTimeAgo(allRuns[0].startedAt)));
  const exp = el('button', 'ghost-btn', t('views-uiskills.csv-2')); exp.onclick = () => exportHistory(filtered(), s); stats.appendChild(exp);
  // DATA-UI-3 — this button lives in ONE skill's Verlauf and used to empty the whole store: every other
  // skill's runs with it, no copy anywhere. It now names the skill and the number it is about (the number
  // comes from the list this panel just loaded, which is this skill's runs), and the route scopes the
  // delete to that name and writes a backup first.
  const clr = el('button', 'ghost-btn', t('views-uiskills.verlaufLeeren'));
  clr.onclick = async () => {
    const msg = t('views-uiskills.verlaufLeerenFrage').replace('{n}', allRuns.length).replace('{name}', (s.manifest && s.manifest.title) || s.name);
    if (!(await uiConfirm(msg, { danger: true, title: t('views-uiskills.verlaufLeeren'), okLabel: t('views-uiskills.leeren') }))) return;
    try {
      const r = await api('/api/uiskill/runs/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: s.name }) });
      // say what really happened, and that there is a way back — a silent redraw to an empty list is the
      // one answer this action must not give
      toast(t('views-uiskills.verlaufGeleert').replace('{n}', r.removed != null ? r.removed : allRuns.length) + (r.backup ? t('views-uiskills.verlaufBackup') : ''), 'ok');
      renderHistoryPanel(host, s);
    } catch (e) { toast(e.message, 'err'); }
  };
  stats.appendChild(clr);
  host.appendChild(stats);
  const fbar = el('div', 'ui-hist-filter');
  const seg = el('div', 'ui-seg');
  [['', t('common.alle')], ['done', '✓'], ['error', '✕'], ['stopped', '■'], ['aborted', '⚠']].forEach(([v, l]) => { const b = el('button', 'ui-seg-btn' + (HIST_FILTER.status === v ? ' active' : '')); b.type = 'button'; b.textContent = l; b.onclick = () => { HIST_FILTER.status = v; [...seg.children].forEach((c) => c.classList.remove('active')); b.classList.add('active'); draw(); }; seg.appendChild(b); });
  fbar.appendChild(seg);
  const dryW = el('label', 'ui-check'); const dcb = el('input'); dcb.type = 'checkbox'; dcb.checked = HIST_FILTER.dry; dcb.onchange = () => { HIST_FILTER.dry = dcb.checked; draw(); }; dryW.appendChild(dcb); dryW.appendChild(el('span', null, t('views-uiskills.nurTestlaeufe'))); fbar.appendChild(dryW);
  const search = el('input', 'ui-input ui-hist-search'); search.placeholder = t('views-uiskills.eingabenErgebnisseDurchsuchen'); search.value = HIST_FILTER.q; search.oninput = () => { HIST_FILTER.q = search.value; draw(); }; fbar.appendChild(search);
  host.appendChild(fbar);
  const list = el('div', 'ui-hist'); host.appendChild(list);
  const filtered = () => allRuns.filter((run) => {
    if (HIST_FILTER.status && run.status !== HIST_FILTER.status) return false;
    if (HIST_FILTER.dry && !run.dryRun) return false;
    if (HIST_FILTER.q) { const hay = (histInputsSummary(s.manifest, run.inputs) + ' ' + (run.result && run.result.rows ? run.result.rows.map((r) => r.join(' ')).join(' ') : '')).toLowerCase(); if (!hay.includes(HIST_FILTER.q.toLowerCase())) return false; }
    return true;
  });
  // pick two runs → "was ist dazugekommen, weggefallen, geändert?" (uiResultCompare)
  const cmpSel = [];
  const cmpBar = el('div', 'ui-hist-cmp is-hidden');
  const cmpBtn = el('button', 'primary-btn ui-result-act', t('views-uiskills.vergleichen'));
  const cmpInfo = el('span', 'ui-result-vis', '');
  const cmpOut = el('div', 'ui-hist-cmpout');
  cmpBar.appendChild(cmpInfo); cmpBar.appendChild(cmpBtn);
  const refreshCmp = () => {
    cmpInfo.textContent = cmpSel.length + '/2 ' + t('views-uiskills.laeufeGewaehlt');
    cmpBtn.disabled = cmpSel.length !== 2;
    cmpBar.classList.toggle('is-hidden', cmpSel.length === 0);
    if (cmpSel.length !== 2) cmpOut.textContent = '';
  };
  cmpBtn.onclick = () => {
    const [a, b] = cmpSel.map((id) => allRuns.find((r) => r.id === id));
    const newer = (a.startedAt >= b.startedAt) ? a : b;
    const older = (newer === a) ? b : a;
    const diff = uiResultCompare(normalizeResultData(newer.result), normalizeResultData(older.result));
    cmpOut.textContent = '';
    if (!diff) { cmpOut.appendChild(el('div', 'empty-mini', t('views-uiskills.nichtVergleichbar'))); return; }
    const cols = (newer.result.columns || []).map((c) => (c && typeof c === 'object') ? c : { id: String(c), label: String(c), type: 'text' });
    const rows = []
      .concat(diff.added.map((i) => [t('views-uiskills.dazugekommen')].concat(newer.result.rows[i])))
      .concat(diff.changed.map((i) => [t('views-uiskills.geaendert')].concat(newer.result.rows[i])))
      .concat(diff.removed.map((i) => [t('views-uiskills.weggefallen')].concat(older.result.rows[i])));
    const synth = {
      source: 'block',
      summary: uiTimeAgo(older.startedAt) + ' → ' + uiTimeAgo(newer.startedAt) + ': +' + diff.added.length + ' / ~' + diff.changed.length + ' / −' + diff.removed.length,
      stats: [
        { label: t('views-uiskills.dazugekommen'), value: String(diff.added.length), tone: 'ok' },
        { label: t('views-uiskills.geaendert'), value: String(diff.changed.length), tone: 'warn' },
        { label: t('views-uiskills.weggefallen'), value: String(diff.removed.length), tone: 'muted' },
      ],
      groups: [
        { id: t('views-uiskills.dazugekommen'), label: t('views-uiskills.dazugekommen'), tone: 'ok', open: true },
        { id: t('views-uiskills.geaendert'), label: t('views-uiskills.geaendert'), tone: 'warn', open: true },
        { id: t('views-uiskills.weggefallen'), label: t('views-uiskills.weggefallen'), tone: 'muted' },
      ],
      columns: [{ id: '__diff', label: t('views-uiskills.aenderung'), type: 'group' }].concat(cols),
      rows,
    };
    cmpOut.appendChild(renderResultBlock({ result: { label: t('views-uiskills.vergleich') } }, synth, 'done', null, null));
  };
  const draw = () => {
    list.innerHTML = '';
    const runs = filtered();
    if (!runs.length) { list.appendChild(el('div', 'empty-mini', t('views-uiskills.keineLaeufeFuerDiesen'))); return; }
    runs.forEach((run, i) => {
      // the next older run with a result is the baseline for this one's "+n neu"
      const older = runs.slice(i + 1).find((r) => r.result && r.result.rows && r.result.rows.length);
      const prevKeys = older ? uiResultRowKeys(normalizeResultData(older.result)) : null;
      list.appendChild(histItemEl(host, s, run, prevKeys, cmpSel, refreshCmp));
    });
    refreshCmp();
  };
  host.appendChild(cmpBar); host.appendChild(cmpOut);
  draw();
}

// ---- Phase E2: server-side schedule (headless engine) ----
// function, not a load-time const — weekday labels must re-resolve on a live language switch
const SCHED_DAY_LABELS = () => [t('views-uiskills.so'), t('views-uiskills.mo'), t('views-uiskills.di'), t('views-uiskills.mi'), t('views-uiskills.do'), t('views-uiskills.fr'), t('views-uiskills.sa')];
function schedDesc(sc) { const tm = sc.timing || {}; if (tm.type === 'interval') return t('views-uiskills.alle-2') + (tm.minutes || 60) + t('views-uiskills.min'); if (tm.type === 'daily') return t('views-uiskills.taeglich') + (tm.time || '09:00') + (tm.days && tm.days.length < 7 ? ' (' + tm.days.map((d) => SCHED_DAY_LABELS()[d]).join(',') + ')' : ''); return '—'; }
let SCHED_POLL = null;
// M2 — which values a new schedule is built from. `RUN_VALUES` is the RUN TAB's form state, and it is
// only ever (re)filled by renderRunPanel: open „Neuer UI-Skill" or „Aus Skill erstellen" (both land on
// the EDIT tab, views-uiskills.js uiskillCreateNew / convertToUiSkill), click „Zeitplan", and the global
// still holds the PREVIOUS skill's answers — which then got stored as this skill's nightly inputs under
// this skill's field labels. So the values are taken from the run form only while they demonstrably
// belong to this skill (`RUN_SKILL`), otherwise they are rebuilt the same way renderRunPanel would:
// manifest defaults plus the inputs this skill was last run with.
function schedFormValues(skill) {
  const m = (skill && skill.manifest) || {};
  if (RUN_SKILL === skill.name) return JSON.parse(JSON.stringify(RUN_VALUES));
  const v = uiDefaultValues(m);
  const last = lastInputs(skill.name);
  if (last) Object.keys(last).forEach((k) => { if (k in v) v[k] = last[k]; });
  return v;
}
async function renderSchedulePanel(host, s) {
  host.innerHTML = '<div class="loading">' + t('common.lade') + '</div>';
  const m = s.manifest || {};
  let all = [], engine = [];
  try { const r = await api('/api/uiskill/schedules'); all = (r.schedules || []).filter((x) => x.name === s.name); }
  catch (e) { host.innerHTML = ''; toast(e.message, 'err'); return; }
  try { const er = await api('/api/uiskill/engine/runs'); engine = (er.runs || []).filter((x) => x.name === s.name); } catch { /* engine list is best-effort */ }
  host.innerHTML = '';
  host.appendChild(el('div', 'ui-sched-note', t('views-uiskills.serverZeitplanLaeuftOhne')));
  // --- new schedule from the current run form values ---
  const box = el('div', 'ui-sched-new');
  box.appendChild(el('div', 'ub-sec-title', t('views-uiskills.neuerZeitplan')));
  // M2 — snapshot, taken once per draw: what this schedule will really store (see schedFormValues).
  const schedValues = schedFormValues(s);
  // „Nutzt die aktuellen Eingaben aus dem Tab Ausführen" was the ONLY statement about these values, and it
  // was the one that could be false — so it is said only while it is true, and the other case says what is
  // really happening instead of standing next to it as a contradiction.
  box.appendChild(el('div', 'ub-hint', RUN_SKILL === s.name ? t('views-uiskills.nutztDieAktuellenEingaben') : t('views-uiskills.zeitplanWerteQuelle')));
  // …and the values themselves, because a value nobody displays is how M2 survived in the first place.
  box.appendChild(el('div', 'uh-inputs', histInputsSummary(m, schedValues)));
  let timing = { type: 'interval', minutes: 60 };
  const typeSel = el('select', 'ui-input');
  [['interval', t('views-uiskills.alleNMinuten')], ['daily', t('views-uiskills.taeglichZuUhrzeit')]].forEach(([v, l]) => { const o = el('option'); o.value = v; o.textContent = l; typeSel.appendChild(o); });
  const timingBody = el('div', 'ui-sched-timing');
  const drawTiming = () => {
    timingBody.innerHTML = '';
    if (typeSel.value === 'interval') { timing = { type: 'interval', minutes: 60 }; const n = el('input', 'ui-input'); n.type = 'number'; n.min = '1'; n.value = '60'; n.oninput = () => timing.minutes = Number(n.value) || 60; timingBody.appendChild(ubRow(t('views-uiskills.minuten'), n)); }
    else {
      timing = { type: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] };
      const tp = el('input', 'ui-input'); tp.type = 'time'; tp.value = '09:00'; tp.oninput = () => timing.time = tp.value;
      timingBody.appendChild(ubRow(t('views-uiskills.uhrzeit'), tp));
      const daysWrap = el('div', 'ui-sched-days');
      // SCHED-1: clicking the last weekday off used to be silent, and `days: []` then ran SEVEN days a
      // week (lib/pure computeNextRun's `days.length ? days : [0..6]` fallback). The route refuses it now;
      // this line is why the user is not surprised by that refusal.
      const daysWarn = el('div', 'ub-hint warn hidden', '⚠ ' + t('views-uiskills.zeitplanOhneWochentag'));
      const syncDays = () => daysWarn.classList.toggle('hidden', timing.days.length > 0);
      SCHED_DAY_LABELS().forEach((lbl, idx) => {
        const b = el('button', 'ui-seg-btn' + (timing.days.includes(idx) ? ' active' : '')); b.type = 'button'; b.textContent = lbl;
        b.onclick = () => { const i = timing.days.indexOf(idx); if (i >= 0) timing.days.splice(i, 1); else timing.days.push(idx); b.classList.toggle('active'); syncDays(); };
        daysWrap.appendChild(b);
      });
      timingBody.appendChild(ubRow(t('views-uiskills.wochentage'), daysWrap));
      timingBody.appendChild(daysWarn);
    }
  };
  typeSel.onchange = drawTiming; drawTiming();
  box.appendChild(ubRow(t('views-uiskills.rhythmus'), typeSel));
  box.appendChild(timingBody);
  let dryRun = true, allowWrites = false;
  // assigned once the warning line below exists; the two checkboxes that DECIDE the cap call it, which is
  // why it is declared up here rather than next to the line it repaints
  let syncPermWarn = () => {};
  box.appendChild(ubCheck(t('views-uiskills.testlaufPlanModusSchreibt'), true, (v) => { dryRun = v; syncPermWarn(); }));
  // A3 — a dollar ceiling per run. Until now the only bound on an unattended run was the engine's
  // 10-minute timeout, which limits TIME, not spend: a schedule that loops fast can burn a lot inside
  // it. Empty = no cap (unchanged); the server clamps to 100.
  let maxBudgetUsd = null;
  const budgetInp = el('input', 'ui-input'); budgetInp.type = 'number'; budgetInp.min = '0'; budgetInp.step = '0.5';
  budgetInp.placeholder = t('views-uiskills.budgetPlaceholder');
  budgetInp.oninput = () => { const n = Number(budgetInp.value); maxBudgetUsd = (Number.isFinite(n) && n > 0) ? n : null; };
  box.appendChild(ubRow(t('views-uiskills.budgetJeLauf'), budgetInp));
  // G3 — per-schedule stand-in model, overriding the skill's own run block (same precedence as the
  // budget above). Here rather than only in the manifest because the reason to want one is the time of
  // day: a 03:00 run has nobody to retry it when the primary model is overloaded. Empty = none; the
  // server stores null, so a blank field can never become `--fallback-model ""`.
  let fallbackModel = '';
  const fbInp = el('input', 'ui-input');
  fbInp.placeholder = t('views-uiskills.ersatzmodellPlaceholder');
  fbInp.oninput = () => { fallbackModel = fbInp.value.trim(); };
  box.appendChild(ubRow(t('views-uiskills.ersatzmodellJeLauf'), fbInp));
  box.appendChild(el('div', 'ub-hint', t('views-uiskills.ersatzmodellHint')));
  // Ultracode for an UNATTENDED run. OFF by default, and it has to be opted into HERE: buildSpawnPolicy
  // (lib/pure.js) never takes the panel's GLOBAL Ultracode switch over for a headless run, only this field —
  // one workflow fans one task out into many agents, and nobody is watching.
  // The note states the MEASUREMENT rather than a warning, because without a number this reads like a
  // performance toggle: with a $2 cap the main session reached $2.13 and three workflow agents wrote
  // SEPARATE transcripts worth another $1.67 — $3.80 against a $2 ceiling. `--max-budget-usd` never saw them.
  let ultracode = false;
  const ucW = ubCheck(t('views-uiskills.ultracodeImZeitplan'), false, (v) => { ultracode = v; });
  box.appendChild(ucW);
  const ucNote = el('div', 'ub-hint warn', t('views-uiskills.ultracodeBudgetHinweis'));
  box.appendChild(ucNote);
  // …and whether the manifest's model can do it at all. Same un-awaited probe the tab dialog uses (it can
  // spawn claude.exe on a cold cache), and it fails OPEN: until the answer lands — or if it never does —
  // the opt-in stays reachable, because „not checked" must not read as „not possible".
  api('/api/ultracode/support?model=' + encodeURIComponent((m.run && m.run.model) || ''))
    .then((r) => {
      if (!r || r.supported !== false || !document.contains(ucW)) return;
      const cb = ucW.querySelector('input');
      if (cb) { cb.checked = false; cb.disabled = true; }
      ultracode = false;
      ucW.classList.add('disabled');
      // the reason, not just the greyed-out box: „disabled" without it is the state nobody can act on
      ucNote.textContent = '⚠ ' + t('views-uiskills.ultracodeModellKannNicht').replace('{m}', (m.run && m.run.model) || t('views-uiskills.standard'));
    })
    .catch(() => { /* a failed probe leaves the opt-in reachable */ });
  // An unattended run cannot keep every permission mode. lib/pure headlessPermissionMode caps anything
  // outside HEADLESS_PERM_MODES to `acceptEdits`, because the other modes decide WITHOUT asking the engine's
  // `can_use_tool` responder — and that responder is where the headless allow-list and the shell denial
  // live, i.e. the only guard an unwatched run has. A manifest may legitimately ask for bypassPermissions
  // (the builder offers it for WATCHED runs), so this is not an error; the schedule just has to say what
  // will actually happen before it is set to run every night. The allowed list comes from /api/state, so it
  // is the SAME list the cap reads rather than a copy here that would stop matching one day.
  // It has to name the cap that will REALLY apply, and that is not the one this line used to name. The
  // schedule's own two switches decide it before the mode does: headlessPermissionMode's FIRST branch is
  // `dryRun || !allowWrites → plan`, and both of those are the defaults here — so for the ordinary schedule
  // the effective mode is `plan`, while the warning claimed `acceptEdits` and then never changed again when
  // the user turned the test run off. Hence a mirror of that function (the matrix is pinned against the real
  // one in test/ultracode-honesty.test.js) and a line that is recomputed on every change that feeds it.
  //
  // `wantMode` is what the manifest DECLARES, raw — '' when it declares none, and handed on exactly like that.
  // A `|| 'plan'` here would be a second, quieter version of the same lie, because the real function defaults
  // an ABSENT request to `acceptEdits`: for a manifest with no permissionMode on a writing schedule the run
  // gets acceptEdits while the mirror would have answered „plan". A mirror may only ever be handed what the
  // real function is handed.
  const wantMode = (m.run && m.run.permissionMode) ? String(m.run.permissionMode) : '';
  const okModes = (typeof STATE === 'object' && STATE && Array.isArray(STATE.headlessPermModes)) ? STATE.headlessPermModes : null;
  const permWarn = el('div', 'ub-hint warn hidden');
  box.appendChild(permWarn);
  syncPermWarn = () => {
    const eff = schedEffectivePermMode(wantMode, okModes, { dryRun, allowWrites });
    // A manifest that declares nothing has nothing to be capped AGAINST, so there is no claim to correct and
    // the line stays silent — the warning exists to say „you asked for X and will get Y", not to narrate.
    const capped = !!eff && !!wantMode && eff !== wantMode;
    permWarn.classList.toggle('hidden', !capped);
    permWarn.textContent = capped ? '⚠ ' + t('views-uiskills.permModusGedeckelt').replace('{m}', wantMode).replace('{e}', eff) : '';
  };
  syncPermWarn();
  // P3 — „Projekt (nur Etikett)": lib/engine.js labels the run's session on its init frame; the spawn never sees it
  let projectId = null;
  box.appendChild(ubRow(t('views-uiskills.projektEtikett'), uiProjectLabelSelect(null, (v) => { projectId = v; })));
  box.appendChild(el('div', 'ub-hint', t('views-uiskills.projektEtikettHint')));
  let writesW = null;
  if (m.writes) {
    writesW = ubCheck(t('views-uiskills.schreibenErlaubenUnbeaufsichtigt'), false, async (v) => {
      // schedValues, not RUN_VALUES (M2): this sentence describes what the nightly run will WRITE, so it
      // has to describe the values that are actually going to be stored
      if (v) { const okc = await uiConfirm(t('views-uiskills.unbeaufsichtigteSchreibendeLaeufe') + uiWriteEffect(s, schedValues, true) + t('views-uiskills.diesIstEineAi'), { danger: true, title: t('views-uiskills.schreibenImZeitplan'), okLabel: t('views-uiskills.aktivieren') }); if (!okc) { const cb = writesW.querySelector('input'); cb.checked = false; allowWrites = false; syncPermWarn(); return; } }
      allowWrites = v;
      syncPermWarn();
    });
    box.appendChild(writesW);
  }
  const createBtn = el('button', 'primary-btn', t('views-uiskills.zeitplanAnlegen'));
  createBtn.onclick = async () => {
    // SCHED-1 — the same two refusals the route makes, here so they can name the field instead of
    // arriving as a bare 400. The route stays the guard; this is the explanation.
    const miss = missingRequired(m, schedValues);
    if (miss.length) { toast(t('views-uiskills.zeitplanPflichtfelder').replace('{fields}', miss.map((i) => i.label || i.id).join(', ')), 'err'); return; }
    if (timing.type === 'daily' && !(timing.days || []).length) { toast(t('views-uiskills.zeitplanOhneWochentag'), 'err'); return; }
    const body = { name: s.name, title: m.title || s.name, values: schedValues, timing, dryRun, allowWrites: allowWrites && !dryRun, enabled: true, maxBudgetUsd, fallbackModel: fallbackModel || undefined, ultracode, projectId: projectId || undefined };
    try { await api('/api/uiskill/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); toast(t('views-uiskills.zeitplanAngelegt'), 'ok'); renderSchedulePanel(host, s); } catch (e) { toast(e.message, 'err'); }
  };
  box.appendChild(createBtn);
  host.appendChild(box);
  // --- existing schedules ---
  const list = el('div', 'ui-sched-list');
  if (!all.length) {
    const empty = el('div', 'empty-mini');
    empty.appendChild(el('span', null, t('views-uiskills.nochKeineZeitplaeneFuer')));
    const jump = el('button', 'ghost-btn', t('views-uiskills.zeitplanAnlegenHier')); // say what to do next
    jump.onclick = () => { const b = host.querySelector('.ui-sched-new .primary-btn'); if (b) { b.scrollIntoView({ block: 'center', behavior: 'smooth' }); b.classList.add('perm-flash'); setTimeout(() => b.classList.remove('perm-flash'), 1200); } };
    empty.appendChild(jump);
    list.appendChild(empty);
  }
  all.forEach((sc) => {
    const it = el('div', 'ui-sched-item');
    const top = el('div', 'uh-top');
    top.appendChild(el('span', 'uh-badge ' + (sc.enabled ? 'done' : 'stopped'), sc.enabled ? t('views-uiskills.aktiv-2') : t('views-uiskills.pausiert')));
    if (sc.dryRun) top.appendChild(el('span', 'uh-badge dry', t('views-uiskills.test-2')));
    if (sc.allowWrites && !sc.dryRun) top.appendChild(el('span', 'usi-tag warn', t('views-uiskills.schreibt')));
    if (sc.maxBudgetUsd) top.appendChild(el('span', 'usi-tag', '≤ ' + fmtMoney(sc.maxBudgetUsd)));
    // G3 — visible on the saved schedule, not only in the form that created it: „this run may answer from
    // another model" is the kind of setting nobody remembers having ticked three weeks later.
    if (sc.fallbackModel) top.appendChild(el('span', 'usi-tag', '↷ ' + sc.fallbackModel));
    // marked as a warning next to the budget tag on purpose: this is the one setting here that the budget
    // tag next to it does NOT bound (the workflow's agents spend outside `--max-budget-usd`)
    if (sc.ultracode) { const uct = el('span', 'usi-tag warn', '🌀 Ultracode'); uct.title = t('views-uiskills.ultracodeBudgetHinweis'); top.appendChild(uct); }
    top.appendChild(el('span', 'uh-time', schedDesc(sc)));
    it.appendChild(top);
    it.appendChild(el('div', 'uh-inputs', t('views-uiskills.naechsterLauf') + fmtWhen(sc.nextRun) + (sc.lastRun ? ' · ' + t('views-uiskills.zuletzt') + uiTimeAgo(sc.lastRun) + (sc.lastStatus ? ' (' + histStatusLabel(sc.lastStatus) + ')' : '') : '')));
    it.appendChild(el('div', 'uh-inputs', histInputsSummary(s.manifest, sc.values)));
    const acts = el('div', 'uh-acts');
    const toggle = el('button', 'ghost-btn', sc.enabled ? t('views-uiskills.pausieren') : t('views-uiskills.aktivieren-2')); toggle.onclick = async () => { try { await api('/api/uiskill/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({}, sc, { enabled: !sc.enabled })) }); renderSchedulePanel(host, s); } catch (e) { toast(e.message, 'err'); } }; acts.appendChild(toggle);
    const runNow = el('button', 'ghost-btn', t('views-uiskills.jetztServer')); runNow.onclick = async () => { try { await api('/api/uiskill/schedules/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sc.id }) }); toast(t('views-uiskills.serverLaufGestartetErscheint'), 'ok'); } catch (e) { toast(e.message, 'err'); } }; acts.appendChild(runNow);
    const del = el('button', 'ghost-btn danger', '🗑'); del.onclick = async () => { if (await uiConfirm(t('views-uiskills.zeitplanLoeschen-2'), { danger: true, title: t('views-uiskills.zeitplanLoeschen'), okLabel: t('common.loeschen-2') })) { try { await api('/api/uiskill/schedules/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sc.id }) }); renderSchedulePanel(host, s); } catch (e) { toast(e.message, 'err'); } } }; acts.appendChild(del);
    it.appendChild(acts);
    list.appendChild(it);
  });
  host.appendChild(list);
  // --- live/last engine runs (headless) for this skill ---
  const eng = el('div', 'ui-sched-list');
  eng.appendChild(el('div', 'ub-sec-title', t('views-uiskills.serverLaeufeEngine')));
  if (!engine.length) eng.appendChild(el('div', 'empty-mini', t('views-uiskills.nochKeineEngineLaeufe')));
  engine.slice(0, 12).forEach((r) => {
    const it = el('div', 'ui-sched-item');
    const top = el('div', 'uh-top');
    // 'aborted' (shutdown, FLOW-2), 'deferred' (CLI update) and 'stopped' are no „fertig": the first never
    // finished, the second never started, the third was ended by hand — 'stopped' fell through to „fertig"
    // and made a stopped run look successful. 'running' must be the class .uh-badge.running carries; 'run'
    // had no rule at all, so a live run wore no colour.
    const st = r.status === 'running' ? 'running' : r.status === 'error' ? 'error' : r.status === 'stopped' ? 'stopped'
      : r.status === 'aborted' ? 'aborted' : r.status === 'deferred' ? 'deferred' : 'done';
    const badge = el('span', 'uh-badge ' + st, r.status === 'running' ? t('views-uiskills.laeuft') : r.status === 'error' ? t('common.fehler')
      : r.status === 'stopped' ? t('views-uiskills.gestoppt') : r.status === 'aborted' ? t('views-uiskills.abgebrochenKurz')
        : r.status === 'deferred' ? t('views-uiskills.verschoben') : t('views-uiskills.fertig-2'));
    if (st === 'aborted') badge.title = t('views-uiskills.abgebrochenTitel');
    else if (st === 'deferred') badge.title = t('views-uiskills.verschobenTitel');
    top.appendChild(badge);
    if (r.dryRun) top.appendChild(el('span', 'uh-badge dry', t('views-uiskills.test')));
    else if (r.allowWrites) top.appendChild(el('span', 'usi-tag warn', t('commands.schreibt')));
    top.appendChild(el('span', 'uh-time', new Date(r.startedAt).toLocaleString() + (r.durationMs ? ' · ' + (r.durationMs / 1000).toFixed(1) + 's' : '')));
    it.appendChild(top);
    // digest from lib/engine.js: one summary line + one count chip per section (never whole rows)
    if (r.summary) it.appendChild(el('div', 'uh-inputs', r.summary));
    if (r.result && r.result.length) {
      const chips = el('div', 'ui-result-stats');
      if (r.rowCount) { const c = el('span', 'ui-result-stat'); c.appendChild(el('span', 'urst-v', String(r.rowCount))); c.appendChild(el('span', 'urst-k', t('views-uiskills.zeilen'))); chips.appendChild(c); }
      r.result.slice(0, 9).forEach((line) => {
        const i = String(line).lastIndexOf(' · ');
        const chip = el('span', 'ui-result-stat');
        if (i > 0) { chip.appendChild(el('span', 'urst-v', String(line).slice(i + 3))); chip.appendChild(el('span', 'urst-k', String(line).slice(0, i))); }
        else chip.appendChild(el('span', 'urst-k', String(line)));
        chips.appendChild(chip);
      });
      it.appendChild(chips);
    }
    eng.appendChild(it);
  });
  host.appendChild(eng);
  // light auto-refresh only while a headless run is active (self-stops on nav away)
  clearTimeout(SCHED_POLL);
  if (engine.some((r) => r.status === 'running')) SCHED_POLL = setTimeout(() => { if ($('#view-uiskills').classList.contains('active') && UISKILL_TAB === 'schedule' && UISKILL_SEL && UISKILL_SEL.name === s.name) renderSchedulePanel(host, s); }, 4000);
}
// ---- Skill / UI-Skill launcher → new chat tab (CB-E) ----
async function openSkillLauncher() {
  const ov = el('div', 'modal-overlay');
  ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
  const box = el('div', 'modal uiskill-picker');
  // Same three defects as uiskillFromSkillPick: no Esc, no focus trap, and three bare `ov.remove()`
  // exits that would never have left the overlay stack. Plus Enter did nothing at all although the
  // search field is what opens focused — overlayFocusFirst walks it into the result list.
  const close = () => { overlayPop(ov); ov.remove(); };
  box.appendChild(el('div', 'ub-sec-title', t('views-uiskills.skillInNeuemChat')));
  box.appendChild(el('div', 'ub-hint', t('views-uiskills.uiSkillsOeffnenEin')));
  const search = el('input', 'ui-input'); search.placeholder = t('views-uiskills.suche'); box.appendChild(search);
  const list = el('div', 'uiskill-picker-list'); box.appendChild(list);
  const cancel = el('button', 'ghost-btn', t('html.abbrechen')); cancel.onclick = close; box.appendChild(cancel);
  ov.appendChild(box); ov.onclick = (e) => { if (e.target === ov) close(); };
  document.body.appendChild(ov);
  overlayPush(ov, { box, autofocus: false, onEsc: close, onEnter: () => overlayFocusFirst(list, '.uiskill-picker-item') });
  setTimeout(() => search.focus(), 0);
  let all = [], loadingCmds = true;
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    list.innerHTML = '';
    const items = all.filter((x) => !q || (x.name + ' ' + (x.title || '') + ' ' + (x.desc || '')).toLowerCase().includes(q)).slice(0, 60);
    items.forEach((x) => {
      const b = el('button', 'uiskill-picker-item');
      const nm = el('div', 'upi-name', (x.kind === 'ui' ? '▶ ' : '/') + x.title);
      if (x.kind === 'ui') nm.appendChild(el('span', 'upi-src', t('views-uiskills.uiSkill-3')));
      b.appendChild(nm);
      if (x.desc) b.appendChild(el('div', 'upi-desc', x.desc));
      b.onclick = () => { close(); if (x.kind === 'ui') openUiSkillFormForTab(x.skill); else if (typeof prefillNewTab === 'function') prefillNewTab('/' + x.name + ' ', x.name); };
      list.appendChild(b);
    });
    if (!items.length && !loadingCmds) list.appendChild(el('div', 'empty-mini', t('common.nichtsGefunden')));
    if (loadingCmds) list.appendChild(el('div', 'empty-mini', t('views-uiskills.slashBefehleWerdenGeladen')));
  };
  search.oninput = draw;
  if (!UISKILLS_DATA) { try { await loadUiSkills(); } catch { /* */ } }
  const uiSkills = (UISKILLS_DATA || []).map((s) => ({ kind: 'ui', name: s.name, title: (s.manifest && s.manifest.title) || s.name, desc: s.description, skill: s }));
  all = [...uiSkills]; draw();
  try {
    const data = await api('/api/skills');
    const uiNames = new Set(uiSkills.map((s) => s.name)); const seen = new Set();
    const cmds = [...(data.commands || []), ...(data.skills || [])].filter((c) => !uiNames.has(c.name) && (seen.has(c.name) ? false : (seen.add(c.name), true))).map((c) => ({ kind: 'cmd', name: c.name, title: c.name, desc: c.description }));
    all = [...uiSkills, ...cmds];
  } catch { /* */ }
  loadingCmds = false;
  if (document.body.contains(ov)) draw();
}
function openUiSkillFormForTab(skill, prefill) {
  const m = skill.manifest || {};
  const values = uiDefaultValues(m);
  if (prefill && typeof prefill === 'object') Object.assign(values, prefill); // per-row action pre-fill (result.actions)
  const form = el('div', 'ui-run-form');
  if ((m.inputs || []).length) (m.inputs).forEach((input) => form.appendChild(buildInput(input, values, { cwd: (m.run || {}).cwd })));
  else form.appendChild(el('div', 'empty-mini', t('views-uiskills.dieserSkillHatKeine')));
  applyVisibility(form, m, values);
  form.addEventListener('input', () => applyVisibility(form, m, values));
  form.addEventListener('change', () => applyVisibility(form, m, values));
  return uiModal({ icon: m.icon || '▶', title: (m.title || skill.name) + t('views-uiskills.neuerChatTab'), body: form, wide: true, escValue: null,
    actions: [{ label: t('html.abbrechen'), value: null }, { label: t('views-uiskills.inNeuemTab'), value: '__go__', primary: true }] })
    .then(async (v) => {
      if (v !== '__go__') return;
      const miss = missingRequired(m, values);
      if (miss.length) { toast(t('views-uiskills.pflichtfelderFehlen') + miss.map((i) => i.label || i.id).join(', '), 'err'); return; }
      const verr = validateFields(m, values);
      if (verr.length) { toast(t('views-uiskills.ungueltigeEingaben') + verr.map((e) => e.input.label || e.input.id).join(', '), 'err'); return; }
      if (m.writes && !(await uiConfirm(t('views-uiskills.dieserSkillKannIn'), { danger: true, title: t('views-uiskills.schreibenMoeglich'), okLabel: t('views-uiskills.starten') }))) return;
      if (typeof launchInNewTab === 'function') { const run = m.run || {}; launchInNewTab({ prompt: uiComposePrompt(skill, values, {}), title: m.title || skill.name, cwd: run.cwd || '', model: run.model || '', effort: run.effort || '', permissionMode: run.permissionMode || 'plan', uiSkill: { name: skill.name, manifest: m, values: JSON.parse(JSON.stringify(values)) } }); }
    });
}
// ---- chat integration: slash-menu form + result capture for chat-tab runs ----
function uiSkillByName(name) { return (UISKILLS_DATA || []).find((s) => s.name === name) || null; }
// boot-time fill of UISKILLS_DATA (for the composer slash menu) without rendering the hidden view
async function ensureUiSkillsData() {
  if (UISKILLS_DATA) return;
  try { const j = await api('/api/uiskills'); if (!UISKILLS_DATA) UISKILLS_DATA = j.skills || []; } catch { /* */ }
}
// slash-menu selection of a UI skill → clear the composer token, open the form modal
function openUiSkillSlash(skill) {
  if (typeof hideSlash === 'function') hideSlash();
  const ci = $('#composerInput');
  if (ci) { ci.value = ''; if (typeof autoGrow === 'function') autoGrow(); }
  if (typeof saveDraft === 'function') saveDraft();
  openUiSkillFormForTab(skill);
}
// a chat tab launched from a UI-skill form finished a turn → same result card + history entry as
// pseudo-tab runs.
// The entry is written when there is something worth keeping — NOT on the first turn that happens to
// end. A skill with confirm gates (or an approval from the card) answers over several turns and emits
// its ui-result block in a later one; recording turn 1 stored the regex fallback ("SYNC FERTIG") and
// locked the entry, so cockpit tile, schedule digest and "neu seit letztem Lauf" stayed empty for the
// whole skill. A genuinely new block in a later turn earns its own entry, like uiRunFollowUp does.
function uiSkillChatTurnResult(tab, ev) {
  const info = tab.uiSkill;
  if (!info) return;
  const status = ev.is_error ? 'error' : 'done';
  const data = extractResults(info.manifest || {}, tab);
  const fp = data ? uiResultFingerprint(data) : '';
  const isBlock = !!data && data.source === 'block';
  if (!isBlock && !ev.is_error && !info.recorded) return;        // no block yet → wait for a later turn
  if (info.recorded && (!isBlock || fp === info.lastFp)) return; // same result again → no duplicate
  info.recorded = true; info.lastFp = fp; // set synchronously before any async work → duplicate-proof
  // the block is normally already hydrated into a card inside the bubble → don't append a second one
  if (data && !tab.msgEl.querySelector('.ui-result[data-fp="' + CSS.escape(fp) + '"]')) {
    tab.msgEl.appendChild(renderResultBlock(info.manifest || {}, data, status, null, lastKeys(info.name), { tab }));
  }
  if (isBlock) saveLastKeys(info.name, data); // baseline for the next run's "+n neu" — after rendering
  api('/api/uiskill/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    name: info.name, title: (info.manifest && info.manifest.title) || info.name, inputs: info.values || {},
    startedAt: info.startedAt || Date.now(), status, sessionId: tab.sessionId, dryRun: false, mode: 'single',
    durationMs: Date.now() - (info.startedAt || Date.now()), steps: [], result: data,
    transcript: uiTranscriptText(tab.msgEl).slice(0, 40000), // C4 — see uiTranscriptText
  }) }).catch(() => {});
}
$('#uiskillSearch').addEventListener('input', debounce(renderUiSkillList));
$('#uiskillSearch').addEventListener('focus', () => { if (uiListCollapsed()) uiListSetCollapsed(false); }); // searching needs the list
initUiSkillSplitter();
$('#uiskillsReload').onclick = uiSkillsReload;
$('#uiskillNew').onclick = uiskillCreateNew;
$('#uiskillFromSkill').onclick = uiskillFromSkillPick;

