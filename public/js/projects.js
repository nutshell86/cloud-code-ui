// Part of the Claude Code Control Panel front-end.
// Classic scripts share one global scope; load order in index.html is authoritative: render → chat → sessions → projects → views → commands → boot.
// This file: projects.js — P-1 „Projekte", Stufe 1: the view (tiles + a page per project), the editor dialog,
// „Neuer Chat im Projekt" and „Aus aktuellem Tab anlegen". P-2 Teil 1 adds the cockpit (last state, live plans,
// plan files, costs as an estimate, suggestions) and „Nicht zugeordnet, nach Kosten" under the tiles; P1 (07.10.) lays
// the page out in two columns of foldable sections (projFoldSec, PROJ_DETAIL_SECS / PROJ_DETAIL_COLS). P2 adds start
// orders that open a chat AND send (projRunStarter), „Projektwissen" (linked memory files) and „Bericht kopieren". P4 adds
// „Repos & PRs" (projSecRepos: local git state, open GHE PRs — its own request, GET /api/projects/repos).
//
// WHAT A PROJECT IS (Julian, 05.10.): a START PROFILE plus a LABEL. „Neuer Chat im Projekt" copies the start
// values VISIBLY into an ordinary tab — the selectors, the tab menu and the MCP picker then show exactly what
// the chat will start with, and every one of them can still be changed in that tab before the first message.
// Nothing is applied behind the user's back: the copy IS the mechanism (projectStartValues, projects-core.js).
// The working directory stays the main folder (system32) unless a project sets one, which the editor warns
// about — the CLI keys memory and session folder on the cwd, so the repo is meant to travel as an ADDITIONAL
// directory instead.
//
// STUFE 2: a fresh start sends `tab.projectId` (chat-events.js startChat) and the server records the label and puts
// the instructions into the system prompt; the tab menu, the status chip, the sessions list and the resume copy
// live in sessions.js / chat-status.js; `tab.projectId` survives a reload (chat.js persistTabs/restoreTabs, J7).
// The editor is a dialog on the overlay stack (overlays.js: focus trap, Esc, z-order). Its draft lives in
// PROJ_DRAFT, never only in the DOM: projEditorDraw() rebuilds the form FROM that object, so a redraw — a
// language switch, the MCP list arriving, a background reload of the view — re-renders the labels and keeps
// every typed character. A click next to the dialog does NOT close it (uiModal's scrim would, without asking).

let PROJECTS_DATA = null;     // GET /api/projects → [record + sessionCount, lastActivity]; null = not loaded yet
let PROJ_SESSIONS = null;     // GET /api/sessions items (each with projectId) — the page's session list
// sel = the project whose page is open (null = the tiles); focus = where the caret goes after the next build
const PROJ_VIEW = { sel: null, gen: 0, focus: null };
let PROJ_DRAFT = null;        // the open editor (see projEditorDraw) — the only copy of an unsaved draft
let _projEnsure = null;
// session id (lower case) → pid of assignments made by a click (this page, the tab menu, the sessions list): a session
// has no transcript in the session list before its first turn, and its tab row must not offer [Zuordnen] again. A
// start that named the project needs no entry — its answer says so (tab._projectRun, sessions.js projectAdoptStart).
const PROJ_ASSIGNED = new Map();

// i18n keys for the token sets of projects-core.js — a token without a label would render as an empty line
// (test/projects-ui.test.js demands a key per code, in both languages).
const PROJ_ERR_KEYS = {
  type: 'projects.errType', required: 'projects.errRequired', 'too-long': 'projects.errTooLong',
  'too-many': 'projects.errTooMany', invalid: 'projects.errInvalid', 'bypass-forbidden': 'projects.errBypass',
  nul: 'projects.errNul', unc: 'projects.errUnc', relative: 'projects.errRelative',
  duplicate: 'projects.errDuplicate', unknown: 'projects.errUnknown', conflict: 'projects.errConflict',
  blocked: 'projects.errBlocked',
};
const PROJ_WARN_KEYS = {
  'cwd-missing': 'projects.warnCwdMissing', 'cwd-custom': 'projects.warnCwdCustom',
  'adddir-missing': 'projects.warnAddDirMissing', 'adddir-unc': 'projects.warnAddDirUnc',
  'path-unchecked': 'projects.warnPathUnchecked', 'mcp-unknown': 'projects.warnMcpUnknown',
  'perm-noask': 'projects.warnPermNoask', 'jira-placeholder': 'projects.warnJiraPlaceholder',
  'memory-missing': 'projects.warnMemoryMissing',
};
const PROJ_FIELD_KEYS = {
  name: 'projects.fName', description: 'projects.fBeschreibung', hue: 'projects.fFarbe', cwd: 'projects.fCwd',
  addDirs: 'projects.fAddDirs', mcpServers: 'projects.fMcp', model: 'common.modell', effort: 'html.aufwandsstufe',
  permissionMode: 'html.berechtigungsmodus', agent: 'projects.fAgent', instructions: 'projects.fAnweisungen',
  archived: 'projects.fArchiviert', projects: 'projects.fProjekte', id: 'projects.fId',
  paths: 'projects.fRegeln', hideInAll: 'projects.fInAlleAusblenden', jiraKeys: 'projects.fJiraKeys',
  starters: 'projects.fStartauftraege', memory: 'projects.fProjektwissen',
};
// The selectors' own wording (index.html #effortSel / #permMode), so a project says „🏃 hoch" where the tab says it.
const PROJ_EFFORT_KEYS = { low: 'html.niedrig-2', medium: 'html.mittel-2', high: 'html.hoch-2', xhigh: 'html.xhigh-2', max: 'html.max-2' };
const PROJ_MODE_KEYS = {
  plan: 'html.planNurLesen-2', manual: 'html.manuellFragtImmer', default: 'html.standardFragtNach',
  auto: 'html.autoCliEntscheidet', acceptEdits: 'html.aenderungenUebernehmen', dontAsk: 'html.ohneRueckfragenRegelnGelten',
};

function projPost(path, body) {
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
// Every label table above is read through this. A code from a file or a response is DATA, and a plain object
// answers `constructor` / `toString` with a function — t(fn) hands the function back and `.replace` throws, which
// took the whole view down over one hand-edited warning (lib/projects.js filters those too; this is the second
// line, for every table, not only the one that was hit).
const projKeyOf = (map, k) => ((typeof k === 'string' && Object.prototype.hasOwnProperty.call(map, k)) ? map[k] : '');
function projErrorMsg(e) {
  const k = e && projKeyOf(PROJ_ERR_KEYS, e.code);
  let s = k ? t(k).replace('{max}', e.max != null ? fmtInt(e.max) : '') : String((e && (e.message || e.code)) || t('common.fehler'));
  if (k && e.value != null && e.value !== '') s += ' (' + String(e.value) + ')';
  return s;
}
function projErrorText(e) {
  const fk = e && e.field && projKeyOf(PROJ_FIELD_KEYS, e.field);
  return (fk ? t(fk) : t('projects.fAllgemein')) + ': ' + projErrorMsg(e);
}
function projWarningText(w) {
  const k = w && projKeyOf(PROJ_WARN_KEYS, w.code);
  if (!k) return String((w && w.code) || '');
  const v = Array.isArray(w.value) ? w.value.join(', ') : (w.value == null ? '' : String(w.value));
  return t(k).replace('{value}', w.code === 'perm-noask' ? projModeLabel(w.value) : v);
}
function projModeLabel(m) { const k = projKeyOf(PROJ_MODE_KEYS, m); return k ? t(k) : String(m || ''); }
function projEffortLabel(e) { const k = projKeyOf(PROJ_EFFORT_KEYS, e); return k ? t(k) : String(e || ''); }
// A button whose visible word STARTS its accessible name (WCAG 2.5.3 „Label in Name"): iconBtn names a button by
// its tooltip when it has one (render.js), so „Lösen" was „Zuordnung zu diesem Projekt aufheben …" for a screen
// reader and unreachable by „Lösen klicken" for voice control. The tooltip stays — as the title, i.e. the
// description. Icon-only buttons (no label) keep iconBtn's rule: there the tooltip IS the only name.
function projBtn(cls, icon, opts) {
  const b = iconBtn(cls, icon, opts);
  if (opts && opts.label) b.setAttribute('aria-label', opts.label);
  if (opts && opts.fk) b.dataset.fk = opts.fk;
  return b;
}
// The model's label as the model menu writes it (glyph + console name); a value the menu does not list keeps
// its id — the honest outcome, same rule as ensureModelOption in chat.js.
function projModelLabel(v) {
  const sel = $('#modelSel');
  const o = sel ? [...sel.options].find((x) => x.value === v) : null;
  return o ? o.textContent : (typeof shortModel === 'function' ? shortModel(v) : v);
}
function projModelBlocked(v) {
  const list = (typeof MODELS_CACHE !== 'undefined' && MODELS_CACHE && MODELS_CACHE.models) || [];
  const hit = list.find((m) => m.value === v);
  return !!(hit && hit.blocked);
}
function projMainCwd() { return (typeof STATE !== 'undefined' && STATE && (STATE.defaultCwd || STATE.home)) || ''; }
// The SERVER's path grammar for projects-core (projectIsAbsolute): its main folder says which one it is — a
// Windows server reports `C:\…`, a POSIX one `/…`. Unknown = Windows, the panel's home.
function projPosix() { return /^\//.test(projMainCwd()); }
function projById(id) { return (PROJECTS_DATA || []).find((p) => p.id === id) || null; }
// J2 — when the instructions take effect, by chat.js promptSnapshotFresh (asked once per load, see loadProjects):
// true = at the next start or resume · false = new sessions and after a compaction · null/unasked = not proven.
let PROJ_FRESH = null;
function projInstrNote() {
  return t(PROJ_FRESH === true ? 'projects.anweisungenWirkStart' : PROJ_FRESH === false ? 'projects.anweisungenWirkNeu' : 'projects.anweisungenWirkUnbelegt');
}

// ---- loading ------------------------------------------------------------------------------------------------
// Paint from what is already loaded FIRST (a language switch re-renders at once), then fetch. Both scans share
// the corpus fold (lib/corpus.js dedupes per file), so the session list costs nothing extra once warm.
// A broken store is a 500 `store-corrupt` (lib/projects.js — the file was left untouched): that is said in the
// view instead of an empty list, because „no projects" would be a lie and invite re-creating them.
async function loadProjects() {
  const gen = ++PROJ_VIEW.gen;
  const body = $('#projBody');
  if (PROJECTS_DATA) renderProjects();
  else if (body) { body.innerHTML = ''; body.appendChild(el('div', 'loading', t('projects.lade'))); }
  // the open editor follows the language too — redrawn FROM the draft, so nothing typed is lost (M5)
  if (PROJ_DRAFT) projEditorDraw();
  try {
    const fresh = typeof promptSnapshotFresh === 'function' ? promptSnapshotFresh().catch(() => null) : null;
    const [r, s, f] = await Promise.all([api('/api/projects'), api('/api/sessions').catch(() => null), fresh]);
    if (gen !== PROJ_VIEW.gen) return;
    PROJ_FRESH = f === true || f === false ? f : null;
    if (PROJ_DRAFT) projEditorDraw();
    PROJECTS_DATA = Array.isArray(r && r.projects) ? r.projects : [];
    if (s && Array.isArray(s.sessions)) PROJ_SESSIONS = s.sessions;
    renderProjects();
  } catch (e) {
    if (gen !== PROJ_VIEW.gen) return;
    if (body) errorCard(body, (e && e.code === 'store-corrupt' ? t('projects.speicherKaputt') : t('projects.ladeFehler')) + (e && e.message ? e.message : ''), loadProjects);
  }
}
// Once, on demand — for the palette's „Neuer Chat: <Projekt>" group (commands.js), which must not force a visit
// to the view. Silent on failure; a later call retries.
function ensureProjects() {
  if (PROJECTS_DATA) return Promise.resolve(PROJECTS_DATA);
  if (!_projEnsure) {
    _projEnsure = api('/api/projects')
      .then((r) => { PROJECTS_DATA = (r && Array.isArray(r.projects)) ? r.projects : []; return PROJECTS_DATA; })
      .catch(() => { _projEnsure = null; return null; });
  }
  return _projEnsure;
}
// Opening a page puts the caret on its heading, going back puts it on the tile it came from (WCAG 2.4.3): the
// rebuild of #projBody used to drop it on <body>, and a keyboard user started over from the top of the panel.
function projOpen(id) {
  const prev = PROJ_VIEW.sel;
  PROJ_VIEW.sel = id || null;
  PROJ_VIEW.focus = id ? ['pd-name'] : (prev ? ['tile:' + prev] : null);
  renderProjects();
  const body = $('#projBody'); if (body) body.scrollTop = 0;
}

// ---- the view -----------------------------------------------------------------------------------------------
// FOCUS ACROSS A REBUILD: every control in #projBody a keyboard user can land on carries `data-fk`, a key that
// names the same control in the next build (`tile:<pid>`, `act-edit`, `sess-unassign:<sid>` …). renderProjects
// puts the caret back on it — or, when an action said where it should go next (PROJ_VIEW.focus, a list of
// candidates: the row it removed is gone, so the next one, else the section), there. Focus OUTSIDE the body (the
// search field, an open dialog) is never pulled in: a background reload must not steal the caret.
function projFocusFk(body, keys) {
  for (const k of keys || []) {
    if (k === '#projNew') { const n = $('#projNew'); if (n) { try { n.focus(); } catch { /* */ } return true; } continue; }
    const n = body.querySelector('[data-fk="' + String(k).replace(/"/g, '') + '"]');
    if (n && !projFoldHidden(n, body)) { try { n.focus(); } catch { /* */ } return true; }
  }
  return false;
}
// inside a CLOSED <details> (a section, an older „Letzter Stand"), unless it is that details' own summary: focus()
// on it does nothing in a browser, so the next candidate — usually the section's head — takes the caret
function projFoldHidden(n, body) {
  for (let c = n, x = n.parentNode; x && x !== body; c = x, x = x.parentNode) {
    if (x.tagName === 'DETAILS' && !x.open && c.tagName !== 'SUMMARY') return true;
  }
  return false;
}
function renderProjects() {
  const body = $('#projBody'); if (!body) return;
  const list = PROJECTS_DATA || [];
  const cnt = $('#projCount');
  if (cnt) cnt.textContent = projCountText(list.length, null);
  const p = PROJ_VIEW.sel ? projById(PROJ_VIEW.sel) : null;
  if (PROJ_VIEW.sel && !p && PROJECTS_DATA) PROJ_VIEW.sel = null; // deleted meanwhile → back to the tiles
  const page = p ? p.id : 'grid';
  const keep = body.dataset.page === page ? body.scrollTop : 0;
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  const had = (a && a !== body && body.contains(a) && a.dataset && a.dataset.fk) ? [a.dataset.fk] : null;
  const want = PROJ_VIEW.focus || had;
  PROJ_VIEW.focus = null;
  body.dataset.page = page;
  body.innerHTML = '';
  if (p) renderProjectDetail(body, p); else renderProjectGrid(body, list);
  body.scrollTop = keep;
  if (want) projFocusFk(body, want);
}
// „3 Projekte", and while the search filters: „1 / 3 Projekte" — the form the session list uses (sessions.js
// updateSessCount, A13), so a filtered view never claims the total as what it shows
function projCountText(total, shown) {
  const all = t(total === 1 ? 'projects.einProjekt' : 'projects.nProjekte').replace('{n}', fmtInt(total));
  return (shown != null && shown !== total) ? fmtInt(shown) + ' / ' + all : all;
}
// most recently used first; a project nobody used yet by its last edit
function projSorted(list) {
  return list.slice().sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
}
function renderProjectGrid(body, list) {
  if (!list.length) {
    body.appendChild(projEmptyState());
    const ds = projDraftsSec(); if (ds) body.appendChild(ds); // P5 — the drafts are most useful exactly here
    return;
  }
  const q = (($('#projSearch') || {}).value || '').trim().toLowerCase();
  const hit = (p) => !q || [p.name, p.description, p.cwd, p.agent, p.model].concat(p.addDirs || []).join('\n').toLowerCase().includes(q);
  const shown = projSorted(list).filter(hit);
  const cnt = $('#projCount');
  if (cnt && q) cnt.textContent = projCountText(list.length, shown.length);
  if (!shown.length) { emptyFiltered(body, () => { $('#projSearch').value = ''; renderProjects(); }); return; }
  const active = shown.filter((p) => !p.archived), arch = shown.filter((p) => p.archived);
  const grid = (items) => { const g = el('div', 'proj-grid'); items.forEach((p) => g.appendChild(projectTileEl(p))); return g; };
  if (active.length) body.appendChild(grid(active));
  if (arch.length) { body.appendChild(el('div', 'sess-group', t('projects.archiviertGruppe'))); body.appendChild(grid(arch)); }
  if (!q) {
    const ds = projDraftsSec(); if (ds) body.appendChild(ds);
    body.appendChild(projUnassignedSec(list));
  }
}
function projEmptyState() {
  const box = el('div', 'empty-state proj-empty');
  const g = el('div', 'empty-glyph'); g.innerHTML = ic('project', 40); box.appendChild(g);
  box.appendChild(el('h2', null, t('projects.leerTitel')));
  box.appendChild(el('p', null, t('projects.leerText')));
  box.appendChild(el('p', 'proj-empty-sub', t('projects.leerOrdner')));
  const acts = el('div', 'proj-empty-acts');
  acts.appendChild(projBtn('primary-btn', 'plus', { label: t('projects.neu'), fk: 'empty-new', onClick: () => openProjectEditor(null) }));
  acts.appendChild(projBtn('ghost-btn', 'copy', { label: t('projects.ausTab'), title: t('projects.ausTabTooltip'), fk: 'empty-fromtab', onClick: () => projectFromTab() }));
  box.appendChild(acts);
  return box;
}
// derivedCount = the sessions a folder rule labels (listProjects keeps them out of sessionCount) — said apart
function projActivityText(p) {
  const n = p.sessionCount || 0, r = p.derivedCount || 0;
  if (!n && !r) return t('projects.keineSitzung');
  return t(n === 1 ? 'projects.eineSitzung' : 'projects.nSitzungen').replace('{n}', fmtInt(n))
    + (r ? ' ' + t('projects.plusPerRegel').replace('{n}', fmtInt(r)) : '')
    + (p.lastActivity ? ' · ' + t('projects.zuletzt') + relTime(p.lastActivity) : '');
}
// The start values as chips. „Zeigen statt verstecken": the page shows every value, an unset one as „Standard"
// with a dashed frame (it is the tab's own default then, not the project's); a tile shows only what IS set.
function projStartChips(p, compact) {
  const dirs = p.addDirs || [];
  const mcp = p.mcpServers;
  const specs = [
    { k: 'projects.chipOrdner', v: p.cwd || t('projects.hauptordner'), unset: !p.cwd, title: p.cwd || projMainCwd(), mono: !!p.cwd },
    { k: 'projects.chipZusatz', v: dirs.length ? (compact ? fmtInt(dirs.length) : dirs.join(' · ')) : t('projects.keine'), unset: !dirs.length, title: dirs.join('\n'), mono: !!dirs.length && !compact },
    { k: 'projects.chipMcp', v: mcp === null || mcp === undefined ? t('projects.mcpAlle') : !mcp.length ? t('projects.mcpKeine') : (compact ? fmtInt(mcp.length) : mcp.join(', ')), unset: mcp === null || mcp === undefined, title: Array.isArray(mcp) ? mcp.join('\n') : '' },
    { k: 'common.modell', v: p.model ? projModelLabel(p.model) : t('projects.standardWert'), unset: !p.model },
    { k: 'projects.chipEffort', v: p.effort ? projEffortLabel(p.effort) : t('projects.standardWert'), unset: !p.effort },
    { k: 'projects.chipModus', v: p.permissionMode ? projModeLabel(p.permissionMode) : t('projects.standardWert'), unset: !p.permissionMode },
    { k: 'projects.chipAgent', v: p.agent || t('projects.keiner'), unset: !p.agent },
  ];
  return specs.filter((s) => !compact || !s.unset).map((s) => {
    const c = el('span', 'proj-chip' + (s.unset ? ' unset' : ''));
    c.appendChild(el('span', 'pc-k', t(s.k)));
    c.appendChild(el('span', 'pc-v' + (s.mono ? ' mono' : ''), s.v));
    if (s.title) c.title = s.title;
    return c;
  });
}
function projHueOn(node, hue) {
  if (hue == null) node.classList.add('no-hue'); else node.style.setProperty('--proj-hue', String(hue));
}
function projectTileEl(p) {
  const tile = el('div', 'proj-tile' + (p.archived ? ' is-archived' : ''));
  projHueOn(tile, p.hue);
  tile.dataset.pid = p.id;
  const head = el('div', 'pt-head');
  head.appendChild(el('span', 'pt-name', p.name));
  const warns = Array.isArray(p.warnings) ? p.warnings : [];
  if (warns.length) {
    const b = el('span', 'proj-warn', '⚠ ' + fmtInt(warns.length));
    b.title = warns.map(projWarningText).join('\n');
    b.setAttribute('aria-label', t('projects.nHinweise').replace('{n}', fmtInt(warns.length)));
    head.appendChild(b);
  }
  if (p.archived) head.appendChild(el('span', 'proj-tag', t('projects.archiviert')));
  const ovAll = PROJ_OV.data[''];
  const ob = ovAll && Array.isArray(ovAll.projects) ? ovAll.projects.find((x) => x.id === p.id) : null;
  if (ob && ob.suggestCount) {
    const n = el('span', 'proj-sug', t(ob.suggestCount === 1 ? 'projects.einVorschlag' : 'projects.nVorschlaege').replace('{n}', fmtInt(ob.suggestCount)));
    n.title = t('projects.vorschlaegeTooltip');
    head.appendChild(n);
  }
  tile.appendChild(head);
  if (p.description) tile.appendChild(el('div', 'pt-desc', p.description));
  if (ob) tile.appendChild(el('div', 'pt-cost', t('projects.kachelKosten').replace('{d}', fmtInt((ovAll.window && ovAll.window.days) || 30)).replace('{c}', projMoney(ob.recentCost))));
  const chips = el('div', 'pt-chips');
  projStartChips(p, true).forEach((c) => chips.appendChild(c));
  if (chips.childElementCount) tile.appendChild(chips);
  const foot = el('div', 'pt-foot');
  foot.appendChild(el('span', 'pt-meta', projActivityText(p)));
  // the buttons as ONE group: three flex siblings wrapped one by one, so in English (a longer „New chat")
  // the ✎ stood alone on a line of its own
  const btns = el('div', 'pt-acts');
  btns.appendChild(projBtn('mini-btn', 'play', { label: t('projects.neuerChat'), title: t('projects.neuerChatTooltip').replace('{name}', p.name), fk: 'tile-chat:' + p.id, onClick: (e) => { e.stopPropagation(); newChatInProject(p, e.currentTarget); } }));
  // P2 — the first three start orders; the page shows all of them (a tile with five more buttons would be a toolbar)
  (p.starters || []).slice(0, PROJ_TILE_STARTERS).forEach((s, i) => btns.appendChild(projStarterBtn(p, s, i, 'mini-btn', 'tile-start:' + p.id + ':' + i)));
  btns.appendChild(projBtn('mini-btn si-ico', 'edit', { title: t('projects.bearbeiten'), fk: 'tile-edit:' + p.id, onClick: (e) => { e.stopPropagation(); openProjectEditor(p); } }));
  foot.appendChild(btns);
  tile.appendChild(foot);
  tile.onclick = () => projOpen(p.id);
  mkClickable(tile, t('projects.projektA11y') + p.name);
  tile.dataset.fk = 'tile:' + p.id;
  return tile;
}
// ---- P1: foldable sections ----------------------------------------------------------------------------------
// A section is a <details class="pd-fold">: its <summary> carries the h3 (with the count) and a one-line summary
// (`.pd-fold-sum`), so a CLOSED section still says what is in it. Open/closed is remembered per key — the same for
// every project — in localStorage cc_proj_folds; a key never toggled takes defaultOpen. The fk anchor `sec-<key>` sits
// on the summary: where the caret lands when the row it was on is gone, also in a closed section (the summary is a
// native Tab stop). fill(box) draws the content — at once when open, else on the first open: a closed „Nicht
// zugeordnet" builds no rows at all (mirrors bkFold, views-system.js).
const PROJ_FOLDS_KEY = 'cc_proj_folds';
function projFolds() {
  try { const v = JSON.parse(localStorage.getItem(PROJ_FOLDS_KEY) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
function projFoldOpen(key, dflt) { const v = projFolds()[key]; return typeof v === 'boolean' ? v : !!dflt; }
function projFoldSet(key, open) {
  const all = projFolds();
  if (all[key] === open) return;
  all[key] = open;
  try { localStorage.setItem(PROJ_FOLDS_KEY, JSON.stringify(all)); } catch { /* private mode / quota */ }
}
function projFoldSec(key, title, count, summary, defaultOpen, fill) {
  const det = el('details', 'ui-cock-sec pd-sec pd-fold');
  det.dataset.key = key;
  det.open = projFoldOpen(key, defaultOpen);
  const sum = el('summary', 'pd-fold-head');
  sum.dataset.fk = 'sec-' + key;
  sum.appendChild(el('h3', null, count != null ? title + ' (' + fmtInt(count) + ')' : title));
  if (summary) sum.appendChild(el('span', 'pd-fold-sum', summary));
  det.appendChild(sum);
  const box = el('div', 'pd-fold-body');
  det.appendChild(box);
  let filled = false;
  const draw = () => { if (filled || !fill) return; filled = true; fill(box); };
  if (det.open) draw();
  // also fires for the `open` set above (a browser queues it) — a no-op then: same state, already drawn
  det.ontoggle = () => { projFoldSet(key, det.open); if (det.open) draw(); };
  return det;
}
// Long lists show `cap` rows and „Weitere n zeigen"; each click adds `cap` more. Kept per list key for this page load
// (a background rebuild must not fold the list back). The caret goes to the first row that came in.
const PROJ_MORE = {};
function projCapped(box, key, items, cap, drawRow, fkOf) {
  const n = cap + (PROJ_MORE[key] || 0);
  items.slice(0, n).forEach(drawRow);
  const rest = items.length - n;
  if (rest <= 0) return;
  box.appendChild(projBtn('ghost-btn pd-more', 'chevronDown', {
    label: t('projects.weitereZeigen').replace('{n}', fmtInt(Math.min(rest, cap))).replace('{rest}', fmtInt(rest)), fk: 'more:' + key,
    onClick: () => {
      PROJ_MORE[key] = (PROJ_MORE[key] || 0) + cap;
      PROJ_VIEW.focus = [fkOf ? fkOf(items[n]) : '', 'more:' + key].filter(Boolean);
      renderProjects();
    },
  }));
}
function projRow(icon, name, sub, when) {
  const row = el('div', 'ui-cock-row pd-row');
  row.appendChild(el('span', 'uct-icon', icon));
  const main = el('div', 'ucr-main');
  main.appendChild(el('div', 'uct-name', name));
  if (sub) main.appendChild(el('div', 'uct-sum', sub));
  row.appendChild(main);
  if (when) row.appendChild(el('span', 'uct-when', when));
  return row;
}
const projSidOf = (tb) => (tb && (tb.sessionId || (tb.pending && tb.pending.sessionId))) || null;
const projSameId = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
// ---- P1: ▶ Fortsetzen / Transkript / Plan on a row of the overview ------------------------------------------
// r = an overview row (the server adds project, projectPath, projectId, plan). The session list's own item wins —
// it is what resumeSession and openTranscript are fed everywhere else. Fortsetzen NEVER labels: it resumes as the
// session list does (resumeSession takes the start values over only for an explicit project).
function projSessRef(r) {
  const s = (PROJ_SESSIONS || []).find((x) => projSameId(x.id, r.id));
  return s || { id: r.id, project: r.project, projectPath: r.projectPath, title: r.title, projectId: r.projectId };
}
// the tab that holds this session and runs a live plan — its plan is shown there (the sidecar), not the file
function projPlanTab(r) {
  return (typeof TABS !== 'undefined' ? TABS : []).find((tb) => projSameId(projSidOf(tb), r.id) && tb.plan && Array.isArray(tb.plan.steps)) || null;
}
function projShowPlan(r) {
  const tb = projPlanTab(r);
  if (tb && typeof planShowSidecar === 'function') { showView('chat'); activateTab(tb); planShowSidecar(tb, tb.plan); return; }
  if (!r.plan || typeof openPlan !== 'function') return;
  const known = Object.values(PROJ_OV.data).flatMap((d) => (Array.isArray(d.plans) ? d.plans : [])).find((x) => x.name === r.plan);
  openPlan({ name: r.plan, title: (known && known.title) || r.plan });
}
// kinds: 'r' ▶ Fortsetzen · 't' Transkript · 'p' Plan (only when there is one). compact = icon buttons, named by
// their tooltip (iconBtn); otherwise the visible word starts the name (projBtn, WCAG 2.5.3).
function projSessActs(acts, r, fkp, kinds, compact) {
  const name = projSessName(r);
  const btn = (kind, icon, labelKey, tipKey, run) => acts.appendChild(projBtn(compact ? 'ghost-btn si-ico' : 'ghost-btn', icon, Object.assign(
    { fk: fkp + '-' + kind + ':' + r.id, onClick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); run(); } },
    compact ? { title: t(labelKey) + ': ' + name } : { label: t(labelKey), title: tipKey ? t(tipKey) : undefined })));
  if (kinds.includes('r')) btn('r', 'play', 'common.fortsetzen', 'projects.fortsetzenTooltip', () => resumeSession(projSessRef(r), false));
  if (kinds.includes('t')) btn('t', 'steps', 'projects.transkript', null, () => { showView('sessions'); openTranscript(projSessRef(r)); });
  if (kinds.includes('p') && (r.plan || projPlanTab(r))) btn('p', 'map', 'projects.planZeigen', null, () => projShowPlan(r));
}
// The page (P1, Julian 07.10. „Zwei Spalten, klappbar"): the head with the actions on the right, the start values as
// one line of chips, the warnings right under them; then two columns — the WORK on the left, the CONTEXT on the right.
// The sections and their order live HERE and nowhere else: a later section („Repos & PRs", „Projektwissen") is one
// function plus one entry. draw(c) → a section, or null when there is nothing to show; c = { p, ov, blk, key, open }.
const PROJ_DETAIL_SECS = {
  last: { open: true, draw: projSecLast },
  liveplan: { open: true, draw: projSecLivePlan },
  tabs: { open: true, draw: projSecTabs },
  sug: { open: true, draw: projSecSuggestions },
  sessions: { open: false, draw: projSecSessions },
  cost: { open: true, draw: projSecCost },
  repos: { open: true, draw: projSecRepos },
  memory: { open: true, draw: projSecMemory },
  plans: { open: false, draw: projSecPlans },
  rules: { open: false, draw: projSecRules },
  instr: { open: false, draw: projSecInstr },
};
const PROJ_DETAIL_COLS = [['last', 'liveplan', 'tabs', 'sug', 'sessions'], ['cost', 'repos', 'memory', 'plans', 'rules', 'instr']];
function renderProjectDetail(body, p) {
  const wrap = el('div', 'proj-detail'); body.appendChild(wrap);
  wrap.appendChild(projBtn('ghost-btn pd-back', 'chevronLeft', { label: t('projects.alleProjekte'), fk: 'back', onClick: () => projOpen(null) }));
  const head = el('div', 'pd-head');
  projHueOn(head, p.hue);
  const top = el('div', 'pd-head-top');
  const main = el('div', 'pd-head-main');
  const nameRow = el('div', 'pd-name-row');
  // the caret lands HERE when the page opens: the name is what a screen reader should say first, and the next
  // Tab is „Neuer Chat" (tabindex -1 — a target, not a Tab stop of its own)
  const h2 = el('h2', 'pd-name', p.name); h2.tabIndex = -1; h2.dataset.fk = 'pd-name';
  nameRow.appendChild(h2);
  if (p.archived) nameRow.appendChild(el('span', 'proj-tag', t('projects.archiviert')));
  main.appendChild(nameRow);
  main.appendChild(el('p', 'pd-desc' + (p.description ? '' : ' empty'), p.description || t('projects.keineBeschreibung')));
  top.appendChild(main);
  // Neuer Chat first and primary; then (P2) every start order and „Bericht kopieren", then ✎ and 🗑 — those two are
  // icons, named by their tooltip (iconBtn)
  const acts = el('div', 'pd-acts');
  acts.appendChild(projBtn('primary-btn', 'plus', { label: t('projects.neuerChat'), title: t('projects.neuerChatTooltip').replace('{name}', p.name), fk: 'act-chat', onClick: (e) => newChatInProject(p, e && e.currentTarget) }));
  (p.starters || []).forEach((s, i) => acts.appendChild(projStarterBtn(p, s, i, 'ghost-btn', 'act-start:' + i)));
  acts.appendChild(projBtn('ghost-btn', 'copy', { label: t('projects.berichtKopieren'), title: t('projects.berichtKopierenTooltip'), fk: 'act-report', onClick: () => projCopyReport(p) }));
  acts.appendChild(projBtn('ghost-btn si-ico', 'edit', { title: t('projects.bearbeiten'), fk: 'act-edit', onClick: () => openProjectEditor(p) }));
  acts.appendChild(projBtn('danger-btn si-ico', 'trash', { title: t('common.loeschen-2'), fk: 'act-del', onClick: () => deleteProjectUi(p) }));
  top.appendChild(acts);
  head.appendChild(top);
  const chips = el('div', 'pd-chips');
  projStartChips(p, false).forEach((c) => chips.appendChild(c));
  head.appendChild(chips);
  wrap.appendChild(head);
  // P3 — the overview of THIS window (projOvKey: id|days), and its figures right under the head
  const ovKey = projOvKey(p.id);
  projOvLoad(ovKey);
  const ov = PROJ_OV.data[ovKey] || null;
  const blk = ov && Array.isArray(ov.projects) ? ov.projects.find((x) => x.id === p.id) : null;
  wrap.appendChild(projKpiBar(p, ov, blk));

  // what the last SAVE measured — dated, because it is a measurement and the disk may have changed since
  const warns = Array.isArray(p.warnings) ? p.warnings : [];
  if (warns.length) {
    const sec = el('div', 'ui-cock-sec pd-sec pd-hints');
    sec.appendChild(el('h3', null, t('projects.hinweise') + ' (' + fmtInt(warns.length) + ')'));
    if (p.checkedAt) sec.appendChild(el('div', 'ui-cock-note', t('projects.gemessenBeimSpeichern').replace('{when}', relTime(p.checkedAt))));
    const ul = el('ul', 'proj-lint');
    warns.forEach((w) => ul.appendChild(el('li', null, '⚠ ' + projWarningText(w))));
    sec.appendChild(ul);
    wrap.appendChild(sec);
  }

  const cols = el('div', 'pd-cols');
  PROJ_DETAIL_COLS.forEach((keys, i) => {
    const col = el('div', 'pd-col ' + (i ? 'pd-col-ctx' : 'pd-col-work'));
    keys.forEach((key) => {
      const s = PROJ_DETAIL_SECS[key];
      const node = s && s.draw({ p, ov, blk, key, open: s.open });
      if (node) col.appendChild(node);
    });
    cols.appendChild(col);
  });
  wrap.appendChild(cols);
}
// 1 · Letzter Stand — what was said last, by whom, when, in which session: the newest in full, the two before it as
// one-liners that open
function projSecLast(c) {
  const { p, ov } = c;
  const rec = ov && Array.isArray(ov.recent) ? ov.recent : [];
  const sum = rec[0] ? projSessName(rec[0]) + ' · ' + relTime(rec[0].mtime) : '';
  return projFoldSec(c.key, t('projects.letzterStand'), null, sum, c.open, (box) => {
    if (projOvState(box, p.id) || !ov) return;
    if (!rec.length) { box.appendChild(el('div', 'empty-mini', t('projects.keinStand'))); return; }
    rec.forEach((r, i) => {
      if (!i) { box.appendChild(projLastBox(r)); return; }
      const d = el('details', 'pd-last-old');
      const s = el('summary', 'pd-last-oldhead');
      s.dataset.fk = 'last-old:' + r.id;
      s.appendChild(el('span', 'pd-last-oldname', projSessName(r)));
      const gist = r.lastPrompt || r.lastText || r.recap || '';
      if (gist) s.appendChild(el('span', 'pd-last-gist', gist));
      const st = projStamp(r.mtime); if (st) s.appendChild(st);
      d.appendChild(s);
      d.appendChild(projLastBox(r));
      box.appendChild(d);
    });
  });
}
function projLastBox(r) {
  const box = el('div', 'pd-last');
  const src = el('div', 'pd-last-src');
  src.appendChild(el('span', null, t('projects.quelle') + projSessName(r)));
  src.title = r.id || '';
  if (r.derived) src.appendChild(projRuleTag());
  const acts = el('div', 'uct-acts pd-last-acts');
  projSessActs(acts, r, 'last', 'rtp', false);
  src.appendChild(acts);
  box.appendChild(src);
  const line = (who, text, at) => {
    if (!text) return;
    const l = el('div', 'pd-last-line');
    l.appendChild(el('span', 'pd-last-who', who));
    l.appendChild(el('span', 'pd-last-text', text));
    const st = projStamp(at); if (st) l.appendChild(st);
    box.appendChild(l);
  };
  line(t('projects.du'), r.lastPrompt, r.lastPromptAt);
  line('Claude', r.lastText, r.lastTextAt);
  line(t('projects.zusammenfassung'), r.recap, r.recapAt);
  if (!r.lastPrompt && !r.lastText && !r.recap) box.appendChild(el('div', 'empty-mini', t('projects.keinText')));
  return box;
}
// 2 · Aktueller Plan — the open tabs' live plans; a click goes there (nothing is changed in the tab)
function projSecLivePlan(c) {
  const live = projTabsOf(c.p).filter((tb) => tb.plan && Array.isArray(tb.plan.steps) && ['proposed', 'active', 'done'].includes(tb.plan.state));
  if (!live.length || typeof planCounts !== 'function') return null;
  return projFoldSec(c.key, t('projects.aktuellerPlan'), live.length, projPlanLine(live[0].plan), c.open, (box) => {
    live.forEach((tb) => {
      const row = projRow('🗺', tb.title, projPlanLine(tb.plan), '');
      const a = el('div', 'uct-acts');
      a.appendChild(projBtn('ghost-btn', 'chat', { label: t('projects.zumTab'), fk: 'plan-go:' + tb.uid, onClick: (e) => { e.stopPropagation(); showView('chat'); activateTab(tb); } }));
      row.appendChild(a);
      box.appendChild(row);
    });
  });
}
// 3 · Offene Tabs of this project (tab.projectId). One started WITH it is labelled by its start (tab._projectRun);
// only a started one whose session is not labelled yet gets an explicit [Zuordnen].
function projSecTabs(c) {
  const p = c.p;
  const tabs = (typeof TABS !== 'undefined' ? TABS : []).filter((tb) => tb.projectId === p.id);
  if (!tabs.length) return null;
  const run = tabs.filter((tb) => tb.streaming).length;
  return projFoldSec(c.key, t('projects.offeneTabs'), tabs.length, run ? fmtInt(run) + ' ' + t('projects.tabLaeuft') : '', c.open, (box) => {
    tabs.forEach((tb) => {
      const sid = projSidOf(tb);
      const known = sid && (PROJ_SESSIONS || []).find((s) => projSameId(s.id, sid));
      const labelled = known ? known.projectId === p.id : (tb._projectRun === p.id || PROJ_ASSIGNED.get(String(sid).toLowerCase()) === p.id);
      const row = projRow('⧉', tb.title, projTabState(tb, sid), '');
      const a = el('div', 'uct-acts');
      a.appendChild(projBtn('ghost-btn', 'chat', { label: t('projects.zumTab'), fk: 'tab-go:' + tb.uid, onClick: (e) => { e.stopPropagation(); showView('chat'); activateTab(tb); } }));
      if (sid && !labelled) a.appendChild(projBtn('ghost-btn', 'pin', { label: t('projects.zuordnen'), title: t('projects.zuordnenTooltip'), fk: 'tab-assign:' + tb.uid, onClick: (e) => { e.stopPropagation(); projAssign([sid], p.id, p, ['tab-go:' + tb.uid, 'sec-tabs']); } }));
      else if (labelled) a.appendChild(el('span', 'proj-tag', '✓ ' + t('projects.zugeordnetTag')));
      row.appendChild(a);
      box.appendChild(row);
    });
  });
}
// 4 · Vorschläge — shown, never applied: ✓ labels, ✕ writes '' (deliberately without — it never comes back)
function projSecSuggestions(c) {
  const { p, ov } = c;
  if (!ov || !Array.isArray(ov.suggestions)) return null;
  const sug = ov.suggestions;
  const strong = sug.filter((s) => s.strength === 'strong').length;
  return projFoldSec(c.key, t('projects.vorschlaege'), sug.length, strong ? t('projects.nStark').replace('{n}', fmtInt(strong)) : '', c.open, (box) => {
    if (!sug.length) { box.appendChild(el('div', 'empty-mini', t('projects.keineVorschlaege'))); return; }
    box.appendChild(el('div', 'ui-cock-note', t('projects.vorschlaegeHinweis')));
    const ids = sug.map((s) => s.id);
    box.appendChild(projBtn('ghost-btn pd-sug-all', 'checkSquare', { label: t('projects.alleUebernehmen').replace('{n}', fmtInt(ids.length)), fk: 'sug-all', onClick: () => projAssign(ids, p.id, p, ['sec-sug']) }));
    projCapped(box, 'sug:' + p.id, sug, 5, (s, i) => {
      const why = (s.reasons || []).map(projReasonText).join(' · ');
      const row = projRow(s.strength === 'strong' ? '◆' : '◇', projSessName(s), why + ' · ' + projMoney(s.cost), relTime(s.mtime));
      row.title = s.id;
      row.appendChild(el('span', 'proj-tag', t(s.strength === 'strong' ? 'projects.stark' : 'projects.schwach')));
      const next = sug[i + 1] || sug[i - 1];
      const after = [next ? 'sug-ok:' + next.id : '', 'sec-sug'];
      const a = el('div', 'uct-acts');
      projSessActs(a, s, 'sug', 't', true);
      a.appendChild(projBtn('ghost-btn', 'checkSquare', { label: t('projects.uebernehmen'), title: t('projects.uebernehmenTooltip'), fk: 'sug-ok:' + s.id, onClick: (e) => { e.stopPropagation(); projAssign([s.id], p.id, p, after); } }));
      a.appendChild(projBtn('ghost-btn', 'close', { label: t('projects.ablehnen'), title: t('projects.ablehnenTooltip'), fk: 'sug-no:' + s.id, onClick: (e) => { e.stopPropagation(); projAssign([s.id], '', p, after); } }));
      row.appendChild(a);
      box.appendChild(row);
    }, (s) => 'sug-ok:' + s.id);
  });
}
// 5 · Sitzungen — the ones THIS project labels: the stored assignment, and (Grundpflege a) the ones a folder rule
// labels, marked „per Regel" with [Fest zuordnen] instead of [Lösen] (GET /api/sessions decorates every item)
function projSecSessions(c) {
  const p = c.p;
  const mine = (PROJ_SESSIONS || []).filter((s) => s.projectId === p.id || (s.projectId === null && s.projectDerived === p.id))
    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  const sum = mine.length && mine[0].mtime ? t('projects.zuletzt') + relTime(mine[0].mtime) : '';
  const fkOf = (s) => (s.projectId === p.id ? 'sess-unassign:' : 'sess-fix:') + s.id;
  return projFoldSec(c.key, t('projects.sitzungen'), PROJ_SESSIONS ? mine.length : null, sum, c.open, (box) => {
    if (!PROJ_SESSIONS) box.appendChild(el('div', 'empty-mini', t('projects.sitzungenUnbekannt')));
    else if (!mine.length) box.appendChild(el('div', 'empty-mini', t('projects.keineSitzungenText')));
    projCapped(box, 'sessions:' + p.id, mine, 10, (s, i) => {
      const row = projRow('💬', s.title || s.preview || s.id.slice(0, 8), s.projectPath, relTime(s.mtime));
      row.title = s.id;
      const ruled = s.projectId !== p.id;
      if (ruled) row.appendChild(projRuleTag());
      const a = el('div', 'uct-acts');
      a.appendChild(projBtn('ghost-btn', 'play', { label: t('common.fortsetzen'), title: t('projects.fortsetzenTooltip'), fk: 'sess-resume:' + s.id, onClick: (e) => { e.stopPropagation(); resumeSession(s, false); } }));
      const next = mine[i + 1] || mine[i - 1];
      const after = [next ? fkOf(next) : '', 'sess-pick', 'sec-sessions'];
      if (ruled) a.appendChild(projBtn('ghost-btn', 'pin', { label: t('projects.festZuordnen'), title: t('projects.festZuordnenTooltip'), fk: 'sess-fix:' + s.id, onClick: (e) => { e.stopPropagation(); projAssign([s.id], p.id, p, after); } }));
      // null, not '': „Lösen" forgets the decision; '' would store „deliberately without a project", the state
      // that suppresses every later suggestion (P-2)
      else a.appendChild(projBtn('ghost-btn', 'close', { label: t('projects.loesen'), title: t('projects.loesenTooltip'), fk: 'sess-unassign:' + s.id, onClick: (e) => { e.stopPropagation(); projAssign([s.id], null, p, after); } }));
      row.appendChild(a);
      box.appendChild(row);
    }, fkOf);
    // The general way to label a session that is not in an open tab of this project — one started outside the
    // project belongs here just as well.
    if (PROJ_SESSIONS) {
      const pick = el('div', 'pd-pick');
      pick.appendChild(projBtn('ghost-btn', 'pin', { label: t('projects.sitzungZuordnen'), title: t('projects.sitzungZuordnenTooltip'), fk: 'sess-pick', onClick: () => projPickSessions(p) }));
      box.appendChild(pick);
    }
  });
}
// 6 · Kosten — a SCHÄTZUNG, worded as „Nutzung & Kosten" words it
function projSecCost(c) {
  const { ov, blk } = c;
  if (!blk) return null;
  const all = !!ov.window && ov.window.days === 0; // P3 „Gesamt": the window IS all-time — one figure, not two equal ones
  const days = fmtInt((ov.window && ov.window.days) || 30);
  const sum = all ? t('projects.kostenNurGesamt').replace('{g}', projMoney(blk.cost))
    : t('projects.kostenKurz').replace('{d}', days).replace('{c}', projMoney(blk.recentCost)).replace('{g}', projMoney(blk.cost));
  return projFoldSec(c.key, t('projects.kosten'), null, sum, c.open, (box) => {
    const sums = el('div', 'pd-cost-sums');
    const fig = (k, v) => {
      const f = el('div', 'pd-cost');
      f.appendChild(el('span', 'pd-cost-k', t(k).replace('{d}', days)));
      f.appendChild(el('span', 'pd-cost-v', projMoney(v)));
      sums.appendChild(f);
    };
    if (!all) fig('projects.kosten30', blk.recentCost);
    fig('projects.kostenGesamt', blk.cost);
    box.appendChild(sums);
    box.appendChild(el('div', 'ui-cock-note', t(all ? 'projects.kostenHinweisGesamt' : 'projects.kostenHinweis').replace('{n}', fmtInt(blk.sessions)).replace('{r}', fmtInt(blk.derivedSessions || 0)).replace('{d}', days)
      + (ov.unpricedTokens ? ' ' + t('projects.ohnePreis').replace('{n}', fmtInt(ov.unpricedTokens)) : '')));
    (blk.top || []).forEach((s) => {
      const row = projRow('💬', projSessName(s), all ? projMoney(s.cost) : projMoney(s.recentCost) + ' / ' + projMoney(s.cost), relTime(s.mtime));
      row.title = s.id;
      if (s.derived) row.appendChild(projRuleTag());
      const a = el('div', 'uct-acts');
      projSessActs(a, s, 'cost', 'rt', true);
      row.appendChild(a);
      box.appendChild(row);
    });
  });
}
// P3 · Kennzahlen — right under the head: the window switch (7/30/90/Gesamt, aria-pressed), the figures of that window
// (cockKpi's markup, views-uiskills.js — not called: this file runs without that one) and the activity bars. Costs are
// the estimate „Nutzung & Kosten" shows. While a window is read the figures say „…", never a 0 that is not one.
function projWinLabel(d) { return d ? t('projects.zeitraumTage').replace('{d}', fmtInt(d)) : t('projects.zeitraumGesamt'); }
function projKpi(box, label, value) {
  const chip = el('span', 'ui-result-stat');
  chip.appendChild(el('span', 'urst-v', String(value)));
  chip.appendChild(el('span', 'urst-k', label));
  box.appendChild(chip);
}
function projShare(part, whole) {
  if (!(whole > 0)) return '—';
  const v = (part / whole) * 100;
  if (v > 0 && v < 1) return '< 1 %';
  return typeof fmtPct === 'function' ? fmtPct(v, 0) : Math.round(v) + ' %';
}
function projKpiBar(p, ov, blk) {
  const bar = el('div', 'pd-kpi');
  const seg = el('div', 'seg pd-win');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', t('projects.zeitraum'));
  PROJ_WINDOWS.forEach((d) => {
    const on = d === PROJ_DAYS.v;
    const b = el('button', on ? 'active' : null, projWinLabel(d));
    b.type = 'button';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.dataset.fk = 'win:' + d;
    b.onclick = () => { if (PROJ_DAYS.v === d) return; PROJ_DAYS.v = d; PROJ_VIEW.focus = ['win:' + d]; renderProjects(); };
    seg.appendChild(b);
  });
  bar.appendChild(seg);
  const stats = el('div', 'ui-result-stats pd-kpis');
  const v = (x) => (blk ? x() : '…');
  projKpi(stats, t('projects.kpiSitzungen') + (blk && blk.recentDerivedSessions ? ' · ' + t('projects.kpiDavonRegel').replace('{n}', fmtInt(blk.recentDerivedSessions)) : ''), v(() => fmtInt(blk.recentSessions || 0)));
  projKpi(stats, t('projects.kpiKosten'), v(() => projMoney(blk.recentCost)));
  projKpi(stats, t('projects.kpiAnteil'), v(() => projShare(blk.recentCost, ov.totals && ov.totals.recentCost)));
  projKpi(stats, t('projects.kpiTabs'), fmtInt(projTabsOf(p).length));
  projKpi(stats, t('projects.kpiPlaene'), ov && Array.isArray(ov.plans) ? fmtInt(ov.plans.length) : '…');
  bar.appendChild(stats);
  if (ov && Array.isArray(ov.activity) && ov.activity.length) bar.appendChild(projSpark(ov.activity));
  return bar;
}
// series = messages per day, oldest first (the overview's `activity`). Inline SVG bars, one per day, scaled to the
// busiest day; the picture is decoration for a screen reader — the role=img label says what it shows in words.
function projSpark(series) {
  const n = series.length;
  const max = series.reduce((m, x) => Math.max(m, x || 0), 0);
  const total = series.reduce((m, x) => m + (x || 0), 0);
  const active = series.filter((x) => x > 0).length;
  const W = 270, H = 28, step = W / n, bw = Math.max(1, step - (n > 40 ? 1 : 2));
  let rects = '';
  series.forEach((x, i) => {
    const h = x > 0 ? Math.max(2, Math.round((x / max) * H)) : 1;
    rects += '<rect class="' + (x > 0 ? 'on' : 'z') + '" x="' + (i * step).toFixed(2) + '" y="' + (H - h) + '" width="' + bw.toFixed(2) + '" height="' + h + '"/>';
  });
  const wrap = el('div', 'pd-spark-wrap');
  const label = t('projects.sparkA11y').replace('{d}', fmtInt(n)).replace('{n}', fmtInt(total)).replace('{a}', fmtInt(active)).replace('{m}', fmtInt(max));
  const sp = el('span', 'pd-spark');
  sp.setAttribute('role', 'img');
  sp.setAttribute('aria-label', label);
  sp.title = label;
  sp.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true" focusable="false">' + rects + '</svg>';
  wrap.appendChild(sp);
  wrap.appendChild(el('span', 'pd-spark-cap', t('projects.sparkTitel').replace('{d}', fmtInt(n))));
  return wrap;
}
// 6a · Repos & PRs (P4) — the git state of the project's local folders and the open PRs of their GHE remotes. Its OWN
// request (GET /api/projects/repos), never part of the overview: a slow disk or a GHE call off the VPN must not hold the
// page's figures. Kept per id + updatedAt (an edit of the folders reads again), 60 s like the overview, [↻] reads at once
// past the server's memo. A failed read is null (.catch) — the section says so, the rest of the page is untouched.
const PROJ_REPOS = { data: {}, busy: {}, err: {} };
const PROJ_REPOS_FRESH_MS = 60000;
function projReposLoad(key, id, force) {
  const have = PROJ_REPOS.data[key];
  if (PROJ_REPOS.busy[key]) return;
  if (!force && (PROJ_REPOS.err[key] || (have && Date.now() - have._at < PROJ_REPOS_FRESH_MS))) return;
  PROJ_REPOS.busy[key] = true; delete PROJ_REPOS.err[key];
  api('/api/projects/repos?id=' + encodeURIComponent(id) + (force ? '&fresh=1' : '')).catch(() => null).then((r) => {
    delete PROJ_REPOS.busy[key];
    if (r && Array.isArray(r.repos)) PROJ_REPOS.data[key] = Object.assign({}, r, { _at: Date.now() });
    else PROJ_REPOS.err[key] = true;
    if (force) PROJ_VIEW.focus = ['repos-reload', 'sec-repos'];
    if (PROJ_VIEW.sel === id) renderProjects();
  });
  if (force) renderProjects();
}
// „main ↑2 ↓0 · 3 geändert · 2 Worktrees" — ↑/↓ only with an upstream (without one there is nothing to count against)
function projRepoLine(r) {
  const parts = [];
  if (r.detached) parts.push(t('projects.reposLosgeloest'));
  else parts.push(r.branch + (r.upstream ? ' ↑' + fmtInt(r.ahead) + ' ↓' + fmtInt(r.behind) : ' (' + t('projects.reposOhneUpstream') + ')'));
  parts.push(r.changed ? t('projects.reposGeaendert').replace('{n}', fmtInt(r.changed)) : t('projects.reposSauber'));
  const wt = r.worktrees ? r.worktrees.count : 0;
  if (wt) parts.push(wt === 1 ? t('projects.reposEinWorktree') : t('projects.reposWorktrees').replace('{n}', fmtInt(wt)));
  return parts.join(' · ');
}
const PROJ_PR_STATE = { draft: 'projects.prEntwurf', pending: 'projects.prOffen', approved: 'projects.prFreigegeben', changes: 'projects.prAenderungen' };
// a PR link only when it is https on the repo's own (GHE) host — the server already dropped every other one
function projPrHref(u, host) {
  try { const x = new URL(String(u)); return x.protocol === 'https:' && !!host && x.host === host ? x.href : ''; } catch { return ''; }
}
function projRepoPrs(box, p, r) {
  const prs = r.prs || { status: 'not-ghe', items: [] };
  const note = (txt, warn) => { const n = el('div', 'ui-cock-note pd-pr-note' + (warn ? ' warn' : ''), txt); box.appendChild(n); };
  if (prs.status === 'not-ghe') return note(r.remote ? t('projects.prsNichtGhe').replace('{host}', r.remote.host) : t('projects.prsKeinRemote'));
  if (prs.status === 'no-token') return note(t('projects.prsKeinToken'));
  if (prs.status === 'offline') return note(prs.http ? t('projects.prsHttp').replace('{n}', fmtInt(prs.http)) : t('projects.prsOffline'), true);
  if (prs.status === 'partial') note(t('projects.prsTeilweise'), true);
  const items = Array.isArray(prs.items) ? prs.items : [];
  if (!items.length) return note(t('projects.prsKeine'));
  if (prs.total > items.length) note(t('projects.prsAuswahl').replace('{n}', fmtInt(items.length)).replace('{total}', fmtInt(prs.total)));
  projCapped(box, 'prs:' + p.id + ':' + r.top, items, 5, (pr) => {
    const row = projRow('⇅', '#' + pr.number + ' ' + pr.title, [pr.author, pr.branch].filter(Boolean).join(' · '), '');
    row.classList.add('pd-pr');
    if (pr.mine) row.appendChild(el('span', 'proj-tag pd-pr-mine', t('projects.prMein')));
    row.appendChild(el('span', 'proj-tag pd-pr-state ' + pr.state, t(PROJ_PR_STATE[pr.state] || 'projects.prOffen')));
    const href = projPrHref(pr.url, r.remote && r.remote.host);
    if (href) {
      const a = el('a', 'ghost-btn pd-pr-link', t('projects.prOeffnen'));
      a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.title = t('projects.prOeffnenTooltip').replace('{n}', String(pr.number));
      a.dataset.fk = 'pr-open:' + r.top + ':' + pr.number;
      row.appendChild(a);
    }
    box.appendChild(row);
  }, (pr) => 'pr-open:' + r.top + ':' + pr.number);
}
function projSecRepos(c) {
  const p = c.p;
  if (![p.cwd, ...(p.addDirs || [])].some(Boolean)) return null; // no folder of its own — nothing to look at
  const key = p.id + '|' + (p.updatedAt || 0);
  projReposLoad(key, p.id, false);
  const d = PROJ_REPOS.data[key] || null;
  const repos = d ? d.repos.filter((r) => r.repo) : [];
  const sum = d ? (repos[0] ? repos[0].name + ': ' + projRepoLine(repos[0]) : t('projects.reposKeinRepo')) : '';
  return projFoldSec(c.key, t('projects.repos'), d ? repos.length : null, sum, c.open, (box) => {
    const head = el('div', 'pd-repo-head');
    head.appendChild(el('div', 'ui-cock-note', t('projects.reposHinweis') + (d && d.checkedAt ? ' ' + t('projects.reposGelesen').replace('{when}', relTime(d.checkedAt)) : '')));
    head.appendChild(projBtn('ghost-btn si-ico', 'reload', { title: t('projects.reposNeuLesen'), fk: 'repos-reload', onClick: () => projReposLoad(key, p.id, true) }));
    box.appendChild(head);
    if (PROJ_REPOS.busy[key]) { const b = el('div', 'empty-mini', t('projects.reposLaedt')); b.setAttribute('role', 'status'); box.appendChild(b); }
    if (PROJ_REPOS.err[key]) { const e = el('div', 'pd-ov-err', '✕ ' + t('projects.reposFehler')); e.setAttribute('role', 'alert'); box.appendChild(e); }
    if (!d) return;
    d.repos.forEach((r) => {
      if (!r.repo) { box.appendChild(projRow('📁', r.dir, t('projects.reposKeinRepo'), '')); return; }
      const row = projRow('⎇', r.name, projRepoLine(r), '');
      row.title = r.top;
      if (r.gone) row.appendChild(el('span', 'proj-tag proj-missing', t('projects.reposUpstreamWeg')));
      if (r.gitError) row.appendChild(el('span', 'proj-tag proj-missing', t('projects.reposGitFehler')));
      box.appendChild(row);
      ((r.worktrees && r.worktrees.list) || []).forEach((w) => {
        const wr = projRow('⑂', w.branch || t('projects.reposLosgeloest'), w.path, '');
        wr.classList.add('pd-repo-wt');
        box.appendChild(wr);
      });
      projRepoPrs(box, p, r);
    });
    if (d.skipped && d.skipped.length) box.appendChild(el('div', 'ui-cock-note', t('projects.reposUebersprungen').replace('{n}', fmtInt(d.skipped.length))));
  });
}
// 6b · Projektwissen (P2) — the linked memory files as the overview read them NOW: title, type, age, [Öffnen] into the
// memory view (openMemory takes the CLI folder + the name); a file gone since it was linked says „fehlt". A new chat of
// the project is told to read them before its first answer (lib/pure composeAppendSystem) — when that reaches a resumed
// session is the instructions' rule, so the note says it in their words (projInstrNote / PROJ_FRESH).
function projSecMemory(c) {
  const { p, ov } = c;
  const names = Array.isArray(p.memory) ? p.memory : [];
  if (!names.length) return null;
  const files = ov && Array.isArray(ov.memory) ? ov.memory : null;
  const gone = files ? files.filter((f) => !f.exists).length : 0;
  const sum = !files ? '' : gone ? t('projects.wissenFehltKurz').replace('{n}', fmtInt(gone)) : files.map((f) => f.title || f.name).join(' · ');
  return projFoldSec(c.key, t('projects.projektwissen'), names.length, sum, c.open, (box) => {
    if (projOvState(box, p.id) || !files) return;
    box.appendChild(el('div', 'ui-cock-note', t('projects.wissenHinweis') + ' ' + projInstrNote()));
    projCapped(box, 'memory:' + p.id, files, 5, (f) => {
      const row = projRow('🧠', f.title || f.name, f.description || f.name, '');
      row.title = f.name;
      if (f.type) row.appendChild(el('span', 'proj-tag', f.type));
      const st = f.exists ? projStamp(f.mtime) : null; if (st) row.appendChild(st);
      const a = el('div', 'uct-acts');
      if (f.exists && ov.memoryProject) {
        a.appendChild(projBtn('ghost-btn', 'folder', { label: t('projects.planOeffnen'), title: t('projects.wissenOeffnenTooltip').replace('{name}', f.name), fk: 'mem-open:' + f.name,
          onClick: (e) => { e.stopPropagation(); showView('memory'); if (typeof openMemory === 'function') openMemory(ov.memoryProject, f.name); } }));
      } else if (!f.exists) a.appendChild(el('span', 'proj-tag proj-missing', t('projects.wissenFehlt')));
      row.appendChild(a);
      box.appendChild(row);
    }, (f) => 'mem-open:' + f.name);
  });
}
// 7 · Pläne — plan files the project's sessions wrote (slug → file), as the file is NOW
function projSecPlans(c) {
  const { p, ov } = c;
  if (!ov || !Array.isArray(ov.plans) || !ov.plans.length) return null;
  return projFoldSec(c.key, t('projects.plaene'), ov.plans.length, ov.plans[0].title || ov.plans[0].name, c.open, (box) => {
    box.appendChild(el('div', 'ui-cock-note', t('projects.plaeneHinweis')));
    projCapped(box, 'plans:' + p.id, ov.plans, 5, (pl) => {
      const row = projRow('📄', pl.title || pl.name, pl.teaser || pl.name, '');
      if (pl.derived) row.appendChild(projRuleTag());
      const st = projStamp(pl.mtime); if (st) { st.textContent = t('projects.dateiStand') + st.textContent; row.appendChild(st); }
      const a = el('div', 'uct-acts');
      a.appendChild(projBtn('ghost-btn', 'map', { label: t('projects.planOeffnen'), fk: 'plan-open:' + pl.name, onClick: (e) => { e.stopPropagation(); if (typeof openPlan === 'function') openPlan({ name: pl.name, title: pl.title || pl.name }); } }));
      row.appendChild(a);
      box.appendChild(row);
    }, (pl) => 'plan-open:' + pl.name);
  });
}
// 8 · Zuordnung — the rules and keys as stored (edited in the editor)
function projSecRules(c) {
  const p = c.p;
  const rules = p.paths || [], keys = p.jiraKeys || [];
  const sum = t('projects.zuordnungKurz').replace('{r}', fmtInt(rules.length)).replace('{j}', fmtInt(keys.length));
  return projFoldSec(c.key, t('projects.zuordnungRegeln'), null, sum, c.open, (box) => {
    box.appendChild(el('div', 'ui-cock-note', t('projects.regelnHinweis')));
    const chips = el('div', 'pd-chips');
    if (!rules.length) chips.appendChild(el('span', 'proj-chip unset', t('projects.keineRegeln')));
    rules.forEach((r) => { const x = el('span', 'proj-chip'); x.appendChild(el('span', 'pc-k', t('projects.fRegeln'))); x.appendChild(el('span', 'pc-v mono', r)); chips.appendChild(x); });
    keys.forEach((k) => { const x = el('span', 'proj-chip'); x.appendChild(el('span', 'pc-k', 'Jira')); x.appendChild(projJiraLink(k)); chips.appendChild(x); });
    if (p.hideInAll) chips.appendChild(el('span', 'proj-chip', t('projects.fInAlleAusblenden')));
    box.appendChild(chips);
  });
}
// 9 · Anweisungen — as stored, with WHEN they act (J2)
function projSecInstr(c) {
  const p = c.p;
  const n = (p.instructions || '').length;
  return projFoldSec(c.key, t('projects.fAnweisungen'), null, n ? t('projects.nZeichen').replace('{n}', fmtInt(n)) : t('projects.keine'), c.open, (box) => {
    box.appendChild(el('div', 'ui-cock-note', projInstrNote()));
    box.appendChild(el('div', 'pd-instr' + (p.instructions ? '' : ' empty'), p.instructions || t('projects.keineAnweisungen')));
  });
}
// A tab another window holds (#96 two windows) is not "started" here — say where it lives, like the chat does.
function projTabState(tb, sid) {
  if (typeof tabHeldElsewhere === 'function' && tabHeldElsewhere(tb)) return '⇄ ' + t('chat.anderswoOffen') + (sid ? ' · ' + sid.slice(0, 8) : '');
  return tb.streaming ? t('projects.tabLaeuft') : sid ? t('projects.tabGestartet').replace('{id}', sid.slice(0, 8)) : t('projects.tabUngestartet');
}
// „Sitzung zuordnen…": a checklist. Without a search: the sessions WITHOUT a project (never decided, or deliberately
// none — the user picks, nothing is suggested), newest first, the most recent PROJ_PICK_MAX of them. With a search
// (Grundpflege b): ALL sessions but this project's own, by title, preview, id or folder — at most PROJ_PICK_MAX hits,
// one labelled elsewhere says „(jetzt: X)". The ticks live in a Set, so a narrower search does not drop them.
// One POST for all ticked.
const PROJ_PICK_MAX = 40;
async function projPickSessions(p) {
  const all = (PROJ_SESSIONS || []).slice().sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  const free = all.filter((s) => !s.projectId);
  const others = all.filter((s) => s.projectId !== p.id);
  const picked = new Set();
  const box = el('div', 'pd-pick-list');
  let rows = null;
  // the boxes on screen are read once more at the end — a tick set without a change event (a test, a script) counts too
  const sync = () => { if (rows) rows.querySelectorAll('input').forEach((cb) => { if (cb.checked) picked.add(cb.dataset.sid); else picked.delete(cb.dataset.sid); }); };
  if (!others.length) box.appendChild(el('div', 'pe-hint', t('projects.sitzungZuordnenLeer')));
  else {
    const q = el('input', 'ui-input pd-pick-search'); q.type = 'search';
    q.placeholder = t('projects.sitzungSuchePh'); q.setAttribute('aria-label', t('projects.sitzungSuchePh'));
    const note = el('div', 'pe-hint'); note.setAttribute('aria-live', 'polite');
    rows = el('div', 'mcp-check-list pd-pick-rows');
    const draw = () => {
      sync();
      const needle = String(q.value || '').trim().toLowerCase();
      const hits = needle ? others.filter((s) => [s.title, s.preview, s.id, s.projectPath].join('\n').toLowerCase().includes(needle)) : free;
      const list = hits.slice(0, PROJ_PICK_MAX);
      note.textContent = needle
        ? t('projects.sitzungSucheTreffer').replace('{n}', fmtInt(list.length)).replace('{total}', fmtInt(hits.length))
        : (free.length ? t('projects.sitzungZuordnenText').replace('{n}', fmtInt(list.length)).replace('{total}', fmtInt(free.length)) : t('projects.sitzungZuordnenLeer'));
      rows.textContent = '';
      list.forEach((s) => {
        const lab = el('label', 'mcp-check');
        const cb = el('input'); cb.type = 'checkbox'; cb.dataset.sid = s.id; cb.checked = picked.has(s.id);
        cb.onchange = () => { if (cb.checked) picked.add(s.id); else picked.delete(s.id); };
        lab.appendChild(cb);
        const other = s.projectId ? projById(s.projectId) : null;
        lab.appendChild(el('span', 'mcp-name', (s.title || s.preview || s.id.slice(0, 8)) + ' · ' + relTime(s.mtime)
          + (s.projectId ? ' ' + t('projects.jetztBei').replace('{name}', other ? other.name : s.projectId) : '')));
        rows.appendChild(lab);
      });
    };
    q.oninput = draw;
    box.appendChild(q); box.appendChild(note); box.appendChild(rows);
    draw();
  }
  const v = await uiModal({
    icon: '◆', title: t('projects.sitzungZuordnenTitel').replace('{name}', p.name), body: box, wide: true, escValue: 'cancel',
    actions: others.length
      ? [{ label: t('html.abbrechen'), value: 'cancel' }, { label: t('projects.zuordnen'), value: 'assign', primary: true }]
      : [{ label: t('html.abbrechen'), value: 'cancel' }],
  });
  sync();
  const ids = [...picked];
  if (v !== 'assign' || !ids.length) return false;
  await projAssign(ids, p.id, p, ['sess-pick', 'sec-sessions']);
  return true;
}

// ---- P-2 cockpit: costs, plans, last state, suggestions ------------------------------------------------------
// GET /api/projects/overview, one answer per page: '' = the tiles + „Nicht zugeordnet", 'p-…' = that project.
// Cold, the server folds every transcript first (tens of seconds) — the page says so with a running clock instead
// of an empty area, and keeps an older answer on screen while a newer one is read (`_stale`).
const PROJ_OV = { data: {}, err: {}, busy: {}, gen: 0 };
// P3 — the page's window: 7 / 30 / 90 days or 0 = „Gesamt", one for every project page of this page load. A page's
// overview is kept per id AND window (`id|days`), so switching back is instant; the tiles and „Nicht zugeordnet"
// keep the server's default 30 under the key ''. The default is not sent (`?id=` alone = 30 days).
const PROJ_WINDOWS = [7, 30, 90, 0];
const PROJ_DAYS = { v: 30 };
const projOvKey = (id) => (id ? id + '|' + PROJ_DAYS.v : '');
const PROJ_OV_FRESH_MS = 60000;   // older than this, a visit reads again (the server memo answers 20 s itself)
const PROJ_BULK = new Set();      // ticked rows of „Nicht zugeordnet" — survive a rebuild
const PROJ_BULK_PICK = { pid: '' };
let _projOvTimer = null;
function projOvInvalidate() {
  PROJ_OV.gen++; PROJ_OV.busy = {}; PROJ_OV.err = {};
  Object.keys(PROJ_OV.data).forEach((k) => { PROJ_OV.data[k]._stale = true; });
}
function projOvLoad(key, force) {
  const have = PROJ_OV.data[key];
  if (PROJ_OV.busy[key]) return;
  if (!force && (PROJ_OV.err[key] || (have && !have._stale && Date.now() - have._at < PROJ_OV_FRESH_MS))) return;
  const gen = PROJ_OV.gen;
  PROJ_OV.busy[key] = Date.now(); delete PROJ_OV.err[key];
  projOvTick();
  const [oid, od] = String(key).split('|');
  api('/api/projects/overview' + (oid ? '?id=' + encodeURIComponent(oid) + (od && od !== '30' ? '&days=' + encodeURIComponent(od) : '') : '')).then((r) => {
    if (gen !== PROJ_OV.gen) return;
    PROJ_OV.data[key] = Object.assign({}, r || {}, { _at: Date.now() });
  }, (e) => {
    if (gen !== PROJ_OV.gen) return;
    PROJ_OV.err[key] = (e && e.message) || t('common.fehler');
  }).then(() => {
    if (gen !== PROJ_OV.gen) return;
    delete PROJ_OV.busy[key];
    if (force) PROJ_VIEW.focus = ['sec-' + (key ? 'last' : 'free')];
    renderProjects();
  });
  if (force) renderProjects(); // the retry button is replaced by the running clock at once
}
// the seconds in every loading line, without a rebuild (a rebuild every second would steal the caret)
function projOvTick() {
  if (_projOvTimer || typeof setInterval !== 'function') return;
  _projOvTimer = setInterval(() => {
    if (!Object.keys(PROJ_OV.busy).length) { clearInterval(_projOvTimer); _projOvTimer = null; return; }
    const body = $('#projBody'); if (!body) return;
    body.querySelectorAll('[data-ov-since]').forEach((n) => { n.textContent = projOvSecs(Number(n.dataset.ovSince)); });
  }, 1000);
}
const projOvSecs = (since) => fmtInt(Math.max(0, Math.round((Date.now() - (since || Date.now())) / 1000))) + ' s';
// what stands in a section while its numbers are read, or when the read failed — never an empty area, never a 0.
// true = nothing to show yet (the caller draws no content). id = a project id ('' = the tiles' overview); P3 reads it
// in the page's current window.
function projOvState(sec, id) {
  const key = projOvKey(id);
  if (PROJ_OV.err[key]) {
    const e = el('div', 'pd-ov-err', '✕ ' + t('projects.ovFehler') + PROJ_OV.err[key]);
    e.setAttribute('role', 'alert');
    e.appendChild(projBtn('mini-btn', 'reload', { label: t('projects.ovNochmal'), fk: 'ov-retry:' + id, onClick: () => projOvLoad(key, true) }));
    sec.appendChild(e);
    return true;
  }
  if (!PROJ_OV.busy[key]) return !PROJ_OV.data[key];
  const box = el('div', 'pd-ov-loading'); box.setAttribute('role', 'status');
  const bar = el('div', 'pd-ov-bar'); bar.appendChild(el('span')); box.appendChild(bar);
  box.appendChild(el('span', 'pd-ov-text', PROJ_OV.data[key] ? t('projects.ovAktualisiert') : t('projects.ovLaedt')));
  const s = el('span', 'pd-ov-secs', projOvSecs(PROJ_OV.busy[key])); s.dataset.ovSince = String(PROJ_OV.busy[key]); s.setAttribute('aria-hidden', 'true');
  box.appendChild(s);
  sec.appendChild(box);
  return !PROJ_OV.data[key];
}
const projMoney = (v) => (typeof fmtMoney === 'function' ? fmtMoney(v) : '$' + (Number(v) || 0).toFixed(2));
function projStamp(ts) {
  if (!ts) return null;
  const n = el('span', 'uct-when', relTime(ts));
  try { n.title = new Date(ts).toLocaleString(); } catch { /* */ }
  return n;
}
const projRuleTag = () => el('span', 'proj-tag proj-rule', t('projects.perRegel'));
const projSessName = (s) => s.title || (s.id ? s.id.slice(0, 8) : '');
function projReasonText(r) {
  if (!r) return '';
  if (r.reason === 'plan') return t('projects.grundPlan').replace('{plan}', r.plan || '');
  if (r.reason === 'path') return t('projects.grundRegel');
  if (r.reason === 'jira') return t('projects.grundJira').replace('{keys}', (r.keys || []).join(', ')).replace('{n}', fmtInt(r.mentions || 0));
  return String(r.reason || '');
}
// https only, a fixed host, the key held to the allow-list shape — a stored value never becomes a URL of its own
function projJiraLink(key) {
  if (typeof key !== 'string' || !PROJECT_JIRA_KEY_RE.test(key)) return el('span', 'proj-jira', String(key));
  const a = el('a', 'proj-jira', key);
  a.href = 'https://jira.example.com/browse/' + encodeURIComponent(key);
  a.target = '_blank'; a.rel = 'noopener noreferrer';
  return a;
}
// the plan a tab of this project is running — read from tab.plan (plan-progress.js), never written
function projPlanLine(pl) {
  const c = planCounts(pl);
  if (pl.state === 'done') return '✓ ' + t('projects.planFertig').replace('{n}', fmtInt(c.total));
  if (pl.state === 'proposed') return t('projects.planVorgeschlagen').replace('{n}', fmtInt(c.total));
  if (c.index) {
    const cur = typeof planCurrentStep === 'function' ? planCurrentStep(pl) : null;
    return '⏳ ' + t('projects.planSchritt').replace('{i}', fmtInt(c.index)).replace('{n}', fmtInt(c.total)) + ' · ' + (pl.activeForm || (cur && cur.title) || '');
  }
  return t('projects.planErledigt').replace('{d}', fmtInt(c.done)).replace('{n}', fmtInt(c.total));
}
// the open tabs of a project: started from it (tab.projectId), or showing a session labelled with it
function projTabsOf(p) {
  return (typeof TABS !== 'undefined' ? TABS : []).filter((tb) => {
    if (tb.projectId === p.id) return true;
    const sid = projSidOf(tb); if (!sid) return false;
    const s = (PROJ_SESSIONS || []).find((x) => projSameId(x.id, sid));
    return s ? s.projectId === p.id : PROJ_ASSIGNED.get(String(sid).toLowerCase()) === p.id;
  });
}
// „Nicht zugeordnet, nach Kosten" under the tiles: no entry and no rule, the 20 most expensive. CLOSED by default (P1,
// Julian 07.10.) — its head still says how many and what they cost; the rows are built only when it opens, 10 at a
// time. Ticked rows go to ONE project in ONE POST (the bar sits ABOVE the rows); a row's own suggestion has its ✓.
function projUnassignedSec(list) {
  projOvLoad('');
  const ov = PROJ_OV.data[''] || null;
  const u = ov && ov.unassigned;
  const sum = u ? t('projects.freiKurz').replace('{n}', fmtInt(u.sessions)).replace('{d}', fmtInt((ov.window && ov.window.days) || 30))
    .replace('{c}', projMoney(u.recentCost)).replace('{g}', projMoney(u.cost))
    : PROJ_OV.err[''] ? '✕ ' + t('common.fehler') : PROJ_OV.busy[''] ? t('projects.ovLaedtKurz') : '';
  const sec = projFoldSec('free', t('projects.nichtZugeordnet'), u ? u.sessions : null, sum, false, (box) => projFreeFill(box, list, u));
  sec.classList.add('pd-free');
  return sec;
}
// ---- P5: „Neue Projekte vorschlagen" ------------------------------------------------------------------------------
// Drafts out of the sessions nobody has decided yet (lib/projects.js → projects-core projectClusters), ABOVE „Nicht
// zugeordnet" and in the empty state too. A draft does nothing by itself: [Als Projekt anlegen…] opens the editor
// pre-filled, and only its save — with the visible tick still set — assigns the sessions. [✕] hides a draft in THIS
// browser only (localStorage cc_proj_drafts_off, by the draft's key: the same signal stays hidden when it comes back).
const PROJ_DRAFTS_OFF_KEY = 'cc_proj_drafts_off';
const PROJ_DRAFTS_OFF_MAX = 200;
const PROJ_DRAFT_WHY = { key: 'projects.entwurfGrundKey', dir: 'projects.entwurfGrundDir', mcp: 'projects.entwurfGrundMcp' };
function projDraftsOff() {
  try { const v = JSON.parse(localStorage.getItem(PROJ_DRAFTS_OFF_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
function projDraftsOffSet(list) {
  try { localStorage.setItem(PROJ_DRAFTS_OFF_KEY, JSON.stringify(list.slice(-PROJ_DRAFTS_OFF_MAX))); } catch { /* private mode / quota */ }
}
function projDraftHide(dr) {
  const off = projDraftsOff();
  if (!off.includes(dr.key)) off.push(dr.key);
  projDraftsOffSet(off);
  PROJ_VIEW.focus = ['sec-drafts'];
  renderProjects();
}
function projDraftWhy(dr) {
  const w = dr.why || {};
  const k = projKeyOf(PROJ_DRAFT_WHY, w.signal);
  return k ? t(k).replace('{v}', String(w.value || '')).replace('{n}', fmtInt(w.sessions || 0)) : '';
}
// null = nothing to say: not read yet (the „Nicht zugeordnet" head shows the loading state), or no draft and none hidden
function projDraftsSec() {
  projOvLoad('');
  const ov = PROJ_OV.data[''] || null;
  if (!ov) return null;
  const all = Array.isArray(ov.drafts) ? ov.drafts.filter((x) => x && typeof x.key === 'string') : [];
  const off = projDraftsOff();
  const shown = all.filter((x) => !off.includes(x.key));
  const hidden = all.length - shown.length;
  if (!shown.length && !hidden) return null;
  const sum = shown.length ? shown.slice(0, 3).map((x) => x.name).join(' · ') : t('projects.entwuerfeAusgeblendet').replace('{n}', fmtInt(hidden));
  const sec = projFoldSec('drafts', t('projects.entwuerfe'), shown.length, sum, shown.length > 0, (box) => {
    box.appendChild(el('div', 'ui-cock-note', t('projects.entwuerfeHinweis')));
    shown.forEach((dr) => {
      const row = el('div', 'ui-cock-row pd-row pd-draft-row');
      const main = el('div', 'ucr-main');
      // an existing project already works on this (projectClusters `target`) — offered as „add to", never a duplicate
      const tp = dr.target ? projById(dr.target) : null;
      const tv = dr.why && typeof dr.why.value === 'string' ? dr.why.value : '';
      main.appendChild(el('div', 'uct-name', tp
        ? t(dr.kind === 'dir' ? 'projects.entwurfZielDir' : 'projects.entwurfZielKey').replace('{n}', fmtInt(dr.sessions || 0)).replace('{m}', fmtInt(dr.targetSessions || 0)).replace('{v}', tv).replace('{name}', tp.name)
        : dr.name + ' · ' + t('projects.nSitzungen').replace('{n}', fmtInt(dr.sessions || 0))));
      main.appendChild(el('div', 'uct-sum', projDraftWhy(dr)));
      row.appendChild(main);
      const st = projStamp(dr.lastActivity); if (st) row.appendChild(st);
      const a = el('div', 'uct-acts');
      if (tp) a.appendChild(projBtn('mini-btn', 'pin', { label: t('projects.zuProjektZuordnen').replace('{name}', tp.name), fk: 'draft-join:' + dr.key, onClick: (e) => { e.stopPropagation(); projDraftJoin(dr, tp); } }));
      else a.appendChild(projBtn('mini-btn', 'plus', { label: t('projects.alsProjektAnlegen'), title: t('projects.alsProjektAnlegenTooltip'), fk: 'draft-new:' + dr.key, onClick: (e) => { e.stopPropagation(); projDraftCreate(dr); } }));
      a.appendChild(projBtn('ghost-btn si-ico', 'close', { title: t('projects.entwurfAusblenden'), fk: 'draft-off:' + dr.key, onClick: (e) => { e.stopPropagation(); projDraftHide(dr); } }));
      row.appendChild(a);
      box.appendChild(row);
    });
    if (hidden) {
      const b = projBtn('ghost-btn pd-more', 'reload', { label: t('projects.entwuerfeWiederZeigen').replace('{n}', fmtInt(hidden)), fk: 'drafts-show', onClick: () => { projDraftsOffSet([]); PROJ_VIEW.focus = ['sec-drafts']; renderProjects(); } });
      box.appendChild(b);
    }
  });
  sec.classList.add('pd-drafts');
  return sec;
}
// the editor, pre-filled — nothing is written before its save (and the sessions only with the tick)
function projDraftCreate(dr) {
  const v = dr.values || {};
  const strs = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
  openProjectEditor(null, {
    values: { name: String(dr.name || ''), jiraKeys: strs(v.jiraKeys), addDirs: strs(v.addDirs), mcpServers: Array.isArray(v.mcpServers) ? strs(v.mcpServers) : null },
    fromDraft: { key: dr.key, sessionIds: strs(dr.sessionIds), titles: strs(dr.titles) },
  });
}
// „Zu <Projekt> zuordnen…": a confirmation with the titles and a visible, ticked „take the folder over as an additional
// folder". The folder goes first, through the project's own save path with its version (baseUpdatedAt → 409 when the
// project changed meanwhile: then NOTHING is assigned); the sessions then through projAssign like every assignment.
// One run per draft at a time (PROJ_STARTING's rule): a double click must not save the folder twice or open two dialogs.
const PROJ_JOINING = new Set();
async function projDraftJoin(dr, p) {
  if (PROJ_JOINING.has(dr.key)) return false;
  PROJ_JOINING.add(dr.key);
  try { return await projDraftJoinRun(dr, p); } finally { PROJ_JOINING.delete(dr.key); }
}
async function projDraftJoinRun(dr, p) {
  const ids = (Array.isArray(dr.sessionIds) ? dr.sessionIds : []).filter((x) => typeof x === 'string');
  const titles = Array.isArray(dr.titles) ? dr.titles : [];
  if (!ids.length) return false;
  const dir = dr.kind === 'dir' && dr.why && typeof dr.why.value === 'string' ? dr.why.value : '';
  const have = !dir || (p.addDirs || []).some((x) => projectPathKey(x) === projectPathKey(dir));
  const body = el('div', 'pe-draft');
  const ul = el('ul', 'pe-draft-list');
  ul.setAttribute('aria-label', t('projects.entwurfSitzungen'));
  ids.forEach((id, i) => { const li = el('li', null, typeof titles[i] === 'string' && titles[i] ? titles[i] : id.slice(0, 8)); li.title = id; ul.appendChild(li); });
  body.appendChild(ul);
  let cb = null;
  if (!have) {
    const lab = el('label', 'ui-check');
    cb = el('input'); cb.type = 'checkbox'; cb.checked = true; cb.dataset.pk = 'draft-adddir';
    lab.appendChild(cb); lab.appendChild(el('span', null, t('projects.entwurfOrdnerUebernehmen').replace('{v}', dir)));
    body.appendChild(lab);
  }
  const v = await uiModal({
    icon: '📁', title: t('projects.zuProjektZuordnen').replace('{name}', p.name), body, escValue: 'cancel',
    message: t('projects.entwurfZuordnenFrage').replace('{n}', fmtInt(ids.length)).replace('{name}', p.name),
    actions: [{ label: t('html.abbrechen'), value: 'cancel' }, { label: t('projects.nZuordnen').replace('{n}', fmtInt(ids.length)), value: 'ok', primary: true }],
  });
  if (v !== 'ok') return false;
  const withDir = !!(cb && cb.checked);
  if (withDir) {
    const patch = { id: p.id, addDirs: (p.addDirs || []).concat([dir]) };
    if (Number.isFinite(p.updatedAt)) patch.baseUpdatedAt = p.updatedAt;
    try {
      const r = await projPost('/api/projects', { project: patch });
      if (r && r.project) projStoreRecord(r.project);
    } catch (e) {
      toast(e && e.status === 409 ? t('projects.entwurfKonflikt').replace('{name}', p.name) : ((e && e.message) || t('common.fehler')), 'err');
      return false;
    }
  }
  const ok = await projAssign(ids, p.id, projById(p.id) || p, ['sec-drafts']);
  // the folder is saved, the assignment is not — say exactly that (the draft stays offered for the retry)
  if (!ok) { if (withDir) toast(t('projects.entwurfOrdnerOhneZuordnung'), 'err'); return false; }
  projDraftForget(dr.key);
  return true;
}
// the draft's signal belongs to a project now — the stale answer on screen must not offer it again
function projDraftForget(key) {
  const ov = PROJ_OV.data[''];
  if (ov && Array.isArray(ov.drafts)) ov.drafts = ov.drafts.filter((x) => !x || x.key !== key);
}
// the checkbox at the top of the editor: visibly ticked, the sessions listed by title — never a silent assignment
function projDraftAssignBlock(d) {
  const fd = d.fromDraft;
  const box = el('div', 'pe-draft');
  box.appendChild(el('div', 'pe-hint pe-from', t('projects.ausEntwurfHinweis')));
  const lab = el('label', 'ui-check');
  const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!fd.assign; cb.dataset.pk = 'draft-assign';
  cb.onchange = () => { fd.assign = cb.checked; };
  lab.appendChild(cb); lab.appendChild(el('span', null, t('projects.entwurfZuordnen').replace('{n}', fmtInt(fd.ids.length))));
  box.appendChild(lab);
  const ul = el('ul', 'pe-draft-list');
  ul.setAttribute('aria-label', t('projects.entwurfSitzungen'));
  fd.ids.forEach((id, i) => { const li = el('li', null, fd.titles[i] || id.slice(0, 8)); li.title = id; ul.appendChild(li); });
  box.appendChild(ul);
  return box;
}

const PROJ_FREE_CAP = 10;
function projFreeFill(box, list, u) {
  if (projOvState(box, '') || !u) return;
  const top = u.top || [];
  box.appendChild(el('div', 'ui-cock-note', t('projects.nichtZugeordnetHinweis').replace('{c}', projMoney(u.recentCost)).replace('{g}', projMoney(u.cost))
    .replace('{n}', fmtInt(top.length))));
  if (!top.length) { box.appendChild(el('div', 'empty-mini', t('projects.allesZugeordnet'))); return; }
  [...PROJ_BULK].forEach((id) => { if (!top.some((s) => s.id === id)) PROJ_BULK.delete(id); });
  const targets = projSorted(list).filter((x) => !x.archived);
  if (!targets.some((x) => x.id === PROJ_BULK_PICK.pid)) PROJ_BULK_PICK.pid = targets.length ? targets[0].id : '';
  const shown = top.slice(0, PROJ_FREE_CAP + (PROJ_MORE.free || 0));
  const bar = el('div', 'pd-bulk');
  // „Alle auswählen" = the rows on screen (10, more after „Weitere … zeigen")
  const allLab = el('label', 'pd-bulk-all');
  const all = el('input'); all.type = 'checkbox'; all.dataset.fk = 'free-all';
  all.checked = shown.every((s) => PROJ_BULK.has(s.id));
  all.onchange = () => {
    shown.forEach((s) => { if (all.checked) PROJ_BULK.add(s.id); else PROJ_BULK.delete(s.id); });
    box.querySelectorAll('.pd-free-row input').forEach((cb) => { cb.checked = PROJ_BULK.has(cb.dataset.sid); });
    projBulkSync();
  };
  allLab.appendChild(all); allLab.appendChild(el('span', null, t('projects.alleAuswaehlen')));
  bar.appendChild(allLab);
  const sel = el('select', 'ui-input pe-select'); sel.dataset.fk = 'free-target';
  sel.setAttribute('aria-label', t('projects.zielProjekt'));
  targets.forEach((x) => { const o = el('option', null, x.name); o.value = x.id; sel.appendChild(o); });
  sel.value = PROJ_BULK_PICK.pid;
  sel.onchange = () => { PROJ_BULK_PICK.pid = sel.value; projBulkSync(); };
  const go = projBtn('primary-btn pd-bulk-go', 'pin', { label: t('projects.nZuordnen').replace('{n}', fmtInt(PROJ_BULK.size)), fk: 'free-go', onClick: () => projBulkAssign() });
  go.disabled = !PROJ_BULK.size || !targets.length;
  bar.appendChild(sel); bar.appendChild(go);
  box.appendChild(bar);
  // compact: the name, under it costs and folder; the id in the tooltip, the actions as icons
  projCapped(box, 'free', top, PROJ_FREE_CAP, (s) => {
    const row = el('div', 'ui-cock-row pd-row pd-free-row');
    row.title = s.id;
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = PROJ_BULK.has(s.id); cb.dataset.fk = 'free-cb:' + s.id; cb.dataset.sid = s.id;
    cb.setAttribute('aria-label', t('projects.auswaehlen') + projSessName(s));
    cb.onchange = () => { if (cb.checked) PROJ_BULK.add(s.id); else PROJ_BULK.delete(s.id); projBulkSync(); };
    row.appendChild(cb);
    const main = el('div', 'ucr-main');
    main.appendChild(el('div', 'uct-name', projSessName(s)));
    main.appendChild(el('div', 'uct-sum', projMoney(s.recentCost) + ' / ' + projMoney(s.cost) + ' · ' + (s.projectPath || '')));
    row.appendChild(main);
    const st = projStamp(s.mtime); if (st) row.appendChild(st);
    const a = el('div', 'uct-acts');
    const hit = Array.isArray(s.suggest) && s.suggest[0];
    const hp = hit && projById(hit.projectId);
    if (hp) a.appendChild(projBtn('ghost-btn', 'checkSquare', { label: hp.name, title: t('projects.vorschlagVon') + (hit.reasons || []).map(projReasonText).join(' · '), fk: 'free-ok:' + s.id, onClick: (e) => { e.stopPropagation(); projAssign([s.id], hp.id, hp, ['sec-free']); } }));
    projSessActs(a, s, 'free', 'rt', true);
    row.appendChild(a);
    box.appendChild(row);
  }, (s) => 'free-cb:' + s.id);
}
// the count on the button and „Alle auswählen" follow the ticks in place — a rebuild per tick would move the caret
function projBulkSync() {
  const body = $('#projBody'); const go = body && body.querySelector('.pd-bulk-go'); if (!go) return;
  go.disabled = !PROJ_BULK.size || !PROJ_BULK_PICK.pid;
  const lbl = t('projects.nZuordnen').replace('{n}', fmtInt(PROJ_BULK.size));
  const sp = go.querySelector('.btxt'); if (sp) sp.textContent = lbl; else go.textContent = lbl;
  go.setAttribute('aria-label', lbl);
  const all = body.querySelector('[data-fk="free-all"]');
  if (all) all.checked = [...body.querySelectorAll('.pd-free-row input')].every((cb) => cb.checked);
}
async function projBulkAssign() {
  const ids = [...PROJ_BULK], p = projById(PROJ_BULK_PICK.pid);
  if (!ids.length || !p) return;
  await projAssign(ids, p.id, p, ['sec-free']);
}

// ---- assign / delete ----------------------------------------------------------------------------------------
// pid: 'p-…' = label · null = forget the decision (the session is „never decided" again)
// focus: where the caret goes in the rebuilt page (projFocusFk candidates) — the button that was clicked may be gone
async function projAssign(ids, pid, p, focus) {
  try {
    await projPost('/api/projects/assign', { sessionIds: ids, projectId: pid });
    (PROJ_SESSIONS || []).forEach((s) => { if (ids.some((id) => projSameId(id, s.id))) s.projectId = pid; });
    ids.forEach((id) => { if (pid) PROJ_ASSIGNED.set(String(id).toLowerCase(), pid); else PROJ_ASSIGNED.delete(String(id).toLowerCase()); });
    projOvForget(ids);
    toast(pid ? t('projects.zugeordnet').replace('{name}', p ? p.name : '') : pid === '' ? t('projects.bewusstOhne') : t('projects.geloest'), 'ok');
    if (focus) PROJ_VIEW.focus = focus.filter(Boolean);
    renderProjects();
    await loadProjects(); // the counts on the tiles come from the server
    return true;
  } catch (e) { toast(e.message, 'err'); return false; }
}
// a decided session leaves the suggestion and „nicht zugeordnet" lists AT ONCE — the stale answer stays on screen
// while the new one is read (a cold read takes long), and must not offer the same row a second time
function projOvForget(ids) {
  const gone = (r) => ids.some((id) => projSameId(id, r.id));
  ids.forEach((id) => PROJ_BULK.delete(id));
  Object.values(PROJ_OV.data).forEach((d) => {
    if (Array.isArray(d.suggestions)) d.suggestions = d.suggestions.filter((r) => !gone(r));
    if (d.unassigned && Array.isArray(d.unassigned.top)) d.unassigned.top = d.unassigned.top.filter((r) => !gone(r));
    // P5 — a draft holding a decided session is out of date as a whole (its counts, its name); the reload recomputes it
    if (Array.isArray(d.drafts)) d.drafts = d.drafts.filter((x) => !(x && Array.isArray(x.sessionIds) && x.sessionIds.some((id) => gone({ id }))));
  });
  projOvInvalidate();
}
async function deleteProjectUi(p) {
  // assignedCount = every label the delete removes (from the map); sessionCount only counts sessions that already
  // have a transcript, so it said nothing about one assigned from its open tab before its first turn
  const n = Number.isFinite(p.assignedCount) ? p.assignedCount : (p.sessionCount || 0);
  const msg = t('projects.loeschenFrage').replace('{name}', p.name)
    + (n ? '\n\n' + t('projects.loeschenSitzungen').replace('{n}', fmtInt(n)) : '')
    + '\n\n' + t('projects.loeschenBackup');
  if (!(await uiConfirm(msg, { title: t('projects.loeschenTitel'), danger: true, okLabel: t('common.loeschen-2') }))) return;
  try {
    const r = await projPost('/api/projects/delete', { id: p.id });
    (PROJ_SESSIONS || []).forEach((s) => { if (s.projectId === p.id) s.projectId = null; });
    [...PROJ_ASSIGNED].forEach(([k, v]) => { if (v === p.id) PROJ_ASSIGNED.delete(k); });
    PROJECTS_DATA = (PROJECTS_DATA || []).filter((x) => x.id !== p.id);
    // J7 — open tabs follow: the labels are gone, and an unstarted tab would otherwise start with an unknown id (400)
    (typeof TABS !== 'undefined' ? TABS : []).forEach((tb) => { if (tb.projectId === p.id) tb.projectId = undefined; });
    if (PROJ_VIEW.sel === p.id) PROJ_VIEW.sel = null;
    // the page (and its Löschen button) is gone: the caret goes to the first tile, else to „Neues Projekt"
    const first = projSorted(PROJECTS_DATA).find((x) => !x.archived) || PROJECTS_DATA[0];
    PROJ_VIEW.focus = [first ? 'tile:' + first.id : '', 'empty-new', '#projNew'].filter(Boolean);
    renderProjects();
    toast(t('projects.geloescht').replace('{name}', p.name).replace('{n}', fmtInt((r && r.unassigned) || 0)), 'ok');
    loadProjects();
  } catch (e) { toast(e.message, 'err'); }
}

// ---- „Neuer Chat im Projekt" ----------------------------------------------------------------------------------
// The start values onto a fresh (or untouched) tab, as copies, BEFORE activateTab — and with cfgTouched, otherwise activateTab
// paints the global defaults into the selectors (applyChatDefaults) and the start reads THOSE (the trap
// forkCopyLaunch in chat.js is written against; same mechanism, nothing in chat.js changed). A value the project
// leaves open is the tab's own default, exactly as in any new tab: CHAT_DEFAULTS for model/effort/mode, the main
// folder for the cwd, every server for MCP. projectId goes with the start (J1), and tabUntouched() counts it, so
// resumeSession never reuses such a tab for a foreign session.
// The TITLE (P1, Julian 07.10. „Projekt, dann Thema" — replaces J13, which left it at „Neuer Chat"): the project's
// name as a PLACEHOLDER. defaultTitle stays true, so the first message still names the tab (chat-composer.js
// sendMessage → setTabTitle), exactly as it replaces „Neuer Chat"; a title the user chose is never touched.
// A START ORDER (P2) names the tab by its label instead (`title`). That one is NOT left replaceable: the order's own
// prompt goes out right after this, and setTabTitle would swap the label for the first 25 characters of that prompt —
// the tab would then be named after the text the button already stands for. It is not manualTitle either: a rename
// in the tab still works, and nothing treats it as the user's choice.
function projectApplyToTab(tab, sv, mcp, p, title) {
  if (sv.cwd) tab.cwd = sv.cwd;
  if (sv.addDirs && sv.addDirs.length) tab.addDirs = sv.addDirs.slice();
  if (Array.isArray(mcp)) tab.mcpServers = mcp.slice(); // null (all) stays unset: the fresh session's default IS all
  if (sv.agent) tab.agent = sv.agent;
  if (sv.hue != null) { tab.hue = sv.hue; tab.hueManual = true; }
  const d = (typeof CHAT_DEFAULTS !== 'undefined' && CHAT_DEFAULTS) || {};
  tab.modelSel = sv.model || d.model || '';
  tab.effort = sv.effort || d.effort || '';
  tab.permissionMode = sv.permissionMode || d.permMode || 'plan';
  tab.cfgTouched = true;
  tab.projectId = p.id;
  if (!tab.manualTitle && (typeof isDefaultTitle !== 'function' || isDefaultTitle(tab))) {
    if (title) { tab.title = title.length > 26 ? title.slice(0, 25) + '…' : title; tab.defaultTitle = false; } // = chat.js setTabTitle's cut
    else { tab.title = p.name; tab.defaultTitle = true; }
  }
  return tab;
}
// One start per project at a time: the MCP look-up and the questions below are awaited BEFORE anything visible
// happens, and a second click in that window opened a second tab (measured with a held response).
const PROJ_STARTING = new Set();
const PROJ_MCP_LOOKUP_MS = 5000; // api() has no deadline of its own; past this the names go in unchecked, said so
function projWithin(promise, ms) {
  return new Promise((resolve, reject) => {
    const tm = setTimeout(() => reject(new Error(t('projects.keineAntwort').replace('{s}', fmtInt(Math.round(ms / 1000))))), ms);
    promise.then((v) => { clearTimeout(tm); resolve(v); }, (e) => { clearTimeout(tm); reject(e); });
  });
}
// trigger = the button that was clicked (optional): disabled and aria-busy while the start is being prepared.
// opts (P2, a start order): { firstMessage, title } — the tab is named `title` and `firstMessage` is SENT at once
// (Julian 07.10.: „Startaufträge senden sofort"). Resolves with the new tab, or null when nothing opened.
async function newChatInProject(p, trigger, opts) {
  if (typeof p === 'string') p = projById(p);
  if (!p) return null;
  if (PROJ_STARTING.has(p.id)) return null;
  PROJ_STARTING.add(p.id);
  const busy = (trigger && typeof trigger.setAttribute === 'function') ? trigger : null;
  if (busy) { busy.disabled = true; busy.setAttribute('aria-busy', 'true'); }
  try { return await projNewChat(p, opts || {}); } finally {
    PROJ_STARTING.delete(p.id);
    if (busy) { busy.disabled = false; busy.removeAttribute('aria-busy'); }
  }
}
// MCP names are checked against /api/mcp/configured FIRST (critic H3 — see projectMcpReconcile): removed ones are
// said, and when none is left although the project named some, the user decides; a silent „no servers" would be
// a different chat than the one the project describes.
async function projNewChat(p, opts) {
  const o = opts || {};
  const sv = projectStartValues(p, { posix: projPosix() });
  // measured at the last save: a path that did not answer in time — a dead network drive under a local letter
  // (Z:) — holds the WHOLE panel ~44 s at the start, because lib/chat.js checks the cwd and every --add-dir with a
  // synchronous existsSync. The project would repeat that on every chat, so the user decides first.
  const unchecked = (p.warnings || []).filter((w) => w && w.code === 'path-unchecked' && typeof w.value === 'string' && w.value);
  if (unchecked.length) {
    const keys = new Set(unchecked.map((w) => projectPathKey(w.value)));
    const choice = await uiModal({
      icon: '⚠', title: t('projects.pfadUngeprueftTitel'),
      message: t('projects.pfadUngeprueftFrage').replace('{name}', p.name).replace('{paths}', unchecked.map((w) => w.value).join('\n')),
      escValue: 'cancel',
      actions: [
        { label: t('html.abbrechen'), value: 'cancel' },
        { label: t('projects.pfadTrotzdem'), value: 'keep' },
        { label: t('projects.pfadOhne'), value: 'without', primary: true },
      ],
    });
    if (choice === 'without') {
      if (sv.cwd && keys.has(projectPathKey(sv.cwd))) sv.cwd = '';
      sv.addDirs = sv.addDirs.filter((d) => !keys.has(projectPathKey(d)));
    } else if (choice !== 'keep') return null;
  }
  let mcp = sv.mcpServers;
  if (Array.isArray(mcp) && mcp.length) {
    let configured = null;
    try { configured = (((await projWithin(api('/api/mcp/configured'), PROJ_MCP_LOOKUP_MS)) || {}).servers || []).map((s) => s.name); }
    catch (e) { toast(t('projects.mcpUngeprueft') + (e && e.message ? e.message : ''), 'warn'); }
    const r = projectMcpReconcile(mcp, configured);
    if (r.removed.length && !r.emptied) toast(t('projects.mcpEntfernt').replace('{names}', r.removed.join(', ')), 'warn');
    if (r.emptied) { // the question names them itself — a toast saying the same next to it would be noise
      const choice = await uiModal({
        icon: '⚠', title: t('projects.mcpLeerTitel'),
        message: t('projects.mcpLeerFrage').replace('{name}', p.name).replace('{names}', r.removed.join(', ')),
        escValue: 'cancel',
        actions: [
          { label: t('html.abbrechen'), value: 'cancel' },
          { label: t('projects.mcpLeerKeine'), value: 'none' },
          { label: t('projects.mcpLeerAlle'), value: 'all' },
        ],
      });
      if (choice !== 'none' && choice !== 'all') return null;
      mcp = choice === 'none' ? [] : null;
    } else mcp = r.keep;
  }
  // a model the IAM policy forbids is a guaranteed 403 on the first turn — the menu would never leave it
  // selected either (populateModelSelect), so the project's pick yields to the tab's default, and says so
  if (sv.model && projModelBlocked(sv.model)) { toast(t('projects.modellGesperrt').replace('{model}', sv.model), 'warn'); sv.model = ''; }
  // measured at the last save: a missing cwd makes the CLI start silently in the user folder (lib/chat.js)
  const cwdGone = (p.warnings || []).find((w) => w.code === 'cwd-missing');
  if (cwdGone) toast(projWarningText(cwdGone), 'warn');
  if (typeof showView === 'function') showView('chat');
  // the one empty tab a fresh panel opens with is used instead of a second one next to it — but only while it is
  // UNTOUCHED in every sense a start reads (chat.js tabUntouched, P-0; since J10 a folder of its own counts too).
  const act = typeof ACTIVE !== 'undefined' ? ACTIVE : null;
  const reuse = typeof tabUntouched === 'function' && !!act && tabUntouched(act);
  const tab = reuse ? act : makeTab();
  const first = typeof o.firstMessage === 'string' ? o.firstMessage.trim() : '';
  projectApplyToTab(tab, sv, mcp, p, first && typeof o.title === 'string' ? o.title.trim() : '');
  activateTab(tab);
  if (reuse && typeof renderTabs === 'function') renderTabs(); // re-activating the active tab skips the tab bar (its colour, its title)
  const ci = $('#composerInput'); if (ci) ci.focus();
  if (!first) { toast(t('projects.neuerChatToast').replace('{name}', p.name), 'ok'); return tab; }
  // P2 — the start order goes out HERE: after every question above (a cancel returned before any tab existed, so
  // nothing is sent then) and still inside newChatInProject, i.e. before PROJ_STARTING lets go — a second click on the
  // same order while the start is on its way opens no second tab. An explicit text leaves the composer alone
  // (chat-composer.js sendMessage); ensureChatStarted starts the session with the start values copied above.
  // „gesendet" only once it went: sendMessage returns quietly when the sensitive-data question is cancelled, and the
  // order would then be gone with a toast claiming the opposite — it is put into the composer instead (_lastSent is
  // what sendMessage records for a message that really went out)
  const before = tab._lastSent;
  try { await sendMessage({ text: first, tab }); } catch (e) { toast((e && e.message) || t('common.fehler'), 'err'); }
  if (tab._lastSent !== before) toast(t('projects.startauftragToast').replace('{label}', o.title || '').replace('{name}', p.name), 'ok');
  else {
    if (typeof ACTIVE !== 'undefined' && tab === ACTIVE && typeof composerSet === 'function') composerSet(first);
    toast(t('projects.startauftragNichtGesendet').replace('{label}', o.title || ''), 'warn');
  }
  return tab;
}
// A start order's button: its label is the visible word (projBtn, WCAG 2.5.3), the tooltip says that it SENDS — a
// click is a message to Claude, not a prefilled composer — and shows the beginning of the prompt.
const PROJ_TILE_STARTERS = 3;
function projStarterBtn(p, s, i, cls, fk) {
  const prompt = String(s.prompt || '');
  const tip = t('projects.startauftragTooltip').replace('{name}', p.name).replace('{prompt}', prompt.length > 200 ? prompt.slice(0, 199) + '…' : prompt);
  return projBtn(cls + ' pd-starter', 'send', { label: s.label, title: tip, fk, onClick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); return projRunStarter(p, i, e && e.currentTarget); } });
}
// by index into the CURRENT record: a save between render and click may have changed the list — then the order the
// button showed is looked up again by its label, and a vanished one starts nothing
function projRunStarter(p, i, trigger, label) {
  const cur = projById(p.id) || p;
  const list = Array.isArray(cur.starters) ? cur.starters : [];
  const want = label || ((p.starters || [])[i] || {}).label;
  const s = list[i] && (!want || list[i].label === want) ? list[i] : list.find((x) => x.label === want);
  if (!s) return Promise.resolve(null);
  return newChatInProject(cur, trigger, { firstMessage: s.prompt, title: s.label });
}

// ---- P2: „Bericht kopieren" ------------------------------------------------------------------------------------
// A status report of the project for a mail or a Teams message: last state, plans (files + live tabs), the sessions
// of the last 7 days (explicit + per rule) and the Jira keys. It reads NO cost, token or share figure — not one field
// of the overview's cost half is touched (Julian: no costs in anything that leaves the panel; test/projects-ui pins
// it against an overview full of them). -> { md, data } — md is the plain text, data the ui-result table the rich
// copy (views-uiskills.js copyResultHtml) renders as HTML.
const PROJ_REPORT_DAYS = 7;
function projStampText(ms) {
  if (!ms) return '';
  const d = new Date(ms), z = (v) => (v < 10 ? '0' : '') + v;
  return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes());
}
// €/$/EUR/USD next to a number, either side — the money a free-text line may carry
const PROJ_REPORT_MONEY_RE = /(?:[€$]\s?\d|\d(?:[\d.,]*\d)?\s?(?:€|\$|EUR\b|USD\b))/i;
function projReport(p, ov, sessions, now) {
  const at = Number.isFinite(now) ? now : Date.now();
  const md = [], rows = [];
  const G = { last: t('projects.letzterStand'), plans: t('projects.plaene'), sess: t('projects.berichtSitzungen').replace('{d}', fmtInt(PROJ_REPORT_DAYS)), jira: 'Jira' };
  const one = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  // the report carries no costs (Julian: no amounts in anything shown to others) — and a line Claude wrote may name one
  // itself („… kostet 0,64 $"): such a sentence is left out, and the report says so, never half-masked
  const noMoney = (s) => one(s).split(/(?<=[.!?])\s+/).map((x) => (PROJ_REPORT_MONEY_RE.test(x) ? t('projects.berichtBetragAusgelassen') : x)).join(' ');
  md.push('# ' + t('projects.berichtTitel').replace('{name}', p.name));
  if (p.description) md.push('', p.description);
  md.push('', t('projects.berichtStand').replace('{when}', projStampText(at)));
  // Letzter Stand — the newest session of the overview, its three lines
  md.push('', '## ' + G.last);
  const r = ov && Array.isArray(ov.recent) ? ov.recent[0] : null;
  if (!r) { md.push(t('projects.keinStand')); rows.push([G.last, t('projects.keinStand'), '']); }
  else {
    md.push(t('projects.quelle') + projSessName(r) + ' · ' + projStampText(r.mtime));
    [[t('projects.du'), r.lastPrompt, r.lastPromptAt], ['Claude', r.lastText, r.lastTextAt], [t('projects.zusammenfassung'), r.recap, r.recapAt]].forEach(([who, text, when]) => {
      if (!text) return;
      md.push('- ' + who + ': ' + noMoney(text));
      rows.push([G.last, who + ': ' + noMoney(text), projStampText(when || r.mtime)]);
    });
  }
  // Pläne — the live plans of the open tabs, then the plan files
  md.push('', '## ' + G.plans);
  const live = typeof planCounts === 'function'
    ? projTabsOf(p).filter((tb) => tb.plan && Array.isArray(tb.plan.steps) && ['proposed', 'active', 'done'].includes(tb.plan.state)) : [];
  live.forEach((tb) => { const line = projPlanLine(tb.plan); md.push('- ' + t('projects.berichtLive') + ': ' + tb.title + ' — ' + line); rows.push([G.plans, t('projects.berichtLive') + ': ' + tb.title, line]); });
  const files = ov && Array.isArray(ov.plans) ? ov.plans : [];
  files.forEach((pl) => { md.push('- ' + (pl.title || pl.name) + ' (' + pl.name + ') · ' + t('projects.dateiStand') + projStampText(pl.mtime)); rows.push([G.plans, pl.title || pl.name, t('projects.dateiStand') + projStampText(pl.mtime)]); });
  if (!live.length && !files.length) md.push(t('projects.berichtKeinePlaene'));
  // Sitzungen der letzten 7 Tage — the list the page shows (explicit + per rule), newest first
  const from = at - PROJ_REPORT_DAYS * 86400000;
  const mine = (Array.isArray(sessions) ? sessions : []).filter((s) => (s.projectId === p.id || (s.projectId === null && s.projectDerived === p.id)) && (s.mtime || 0) >= from)
    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  md.push('', '## ' + G.sess + ' (' + fmtInt(mine.length) + ')');
  mine.forEach((s) => {
    const name = s.title || s.preview || s.id.slice(0, 8);
    const rule = s.projectId === p.id ? '' : ' · ' + t('projects.perRegel');
    md.push('- ' + one(name) + ' · ' + projStampText(s.mtime) + rule);
    rows.push([G.sess, one(name) + rule, projStampText(s.mtime)]);
  });
  if (!mine.length) md.push(t('projects.berichtKeineSitzungen'));
  // Jira — the project's keys, each as its link (the same fixed host as projJiraLink)
  md.push('', '## ' + G.jira);
  const keys = (p.jiraKeys || []).filter((k) => typeof k === 'string' && PROJECT_JIRA_KEY_RE.test(k));
  keys.forEach((k) => { const url = 'https://jira.example.com/browse/' + encodeURIComponent(k); md.push('- ' + k + ' — ' + url); rows.push([G.jira, k, url]); });
  if (!keys.length) md.push(t('projects.berichtKeineJira'));
  const data = {
    summary: p.description || '',
    columns: [{ label: t('projects.berichtBereich'), type: 'group' }, { label: t('projects.berichtEintrag') }, { label: t('projects.berichtWann') }],
    rows,
  };
  return { md: md.join('\n') + '\n', data };
}
// the overview of the page is used when it is loaded (last state, plans); without it the report says „no session"
// for the last state rather than waiting — the sessions and keys come from what the page already holds
async function projCopyReport(p) {
  const rep = projReport(p, PROJ_OV.data[projOvKey(p.id)] || null, PROJ_SESSIONS || [], Date.now());
  const title = t('projects.berichtTitel').replace('{name}', p.name);
  if (typeof copyResultHtml === 'function') return copyResultHtml(rep.data, title, rep.md);
  if (typeof copyText === 'function') { copyText(rep.md); toast(t('projects.berichtKopiert'), 'ok'); }
}

// ---- „Aus aktuellem Tab anlegen" ------------------------------------------------------------------------------
// The editor, pre-filled with what the active tab would start with: for the ACTIVE tab that is the selectors
// (the start reads them from there, chat-events.js), the MCP scope as the picker shows it (the tab's own, else
// the session's stored one). The tab's guardrails are NOT moved (critic M9): the editor offers to COPY them into
// the instructions with one click, and the tab keeps its own either way. A bypass mode is not storable — the
// prefill drops it and says so.
async function projectFromTab(tab) {
  tab = tab || (typeof ACTIVE !== 'undefined' ? ACTIVE : null);
  if (!tab) { toast(t('projects.keinTab'), 'warn'); return; }
  const active = tab === ACTIVE;
  const pick = (sel, own) => (active && $(sel) ? $(sel).value : (own || ''));
  const model = pick('#modelSel', tab.modelSel), effort = pick('#effortSel', tab.effort);
  const mode = pick('#permMode', tab.permissionMode);
  let mcp = tab.mcpServers;
  const stored = tab.sessionId || tab._mcpFrom;
  if (mcp === undefined && stored) { try { mcp = (await api('/api/session/mcp?id=' + encodeURIComponent(stored))).selection; } catch { /* the picker's fallback: all */ } }
  const main = projMainCwd();
  const cwd = (tab.cwd && (!main || projectPathKey(tab.cwd) !== projectPathKey(main))) ? tab.cwd : '';
  const values = {
    name: isDefaultTitle(tab) ? '' : tab.title,
    hue: typeof tab.hue === 'number' ? tab.hue : null,
    cwd, addDirs: (tab.addDirs || []).slice(),
    mcpServers: Array.isArray(mcp) ? mcp.slice() : null,
    model, effort, permissionMode: mode === 'bypassPermissions' ? '' : mode,
    agent: tab.agent || '',
  };
  openProjectEditor(null, { values, fromTab: { title: tab.title, guardrails: tab.guardrails || '', permDropped: mode === 'bypassPermissions' } });
}

// ---- the editor ---------------------------------------------------------------------------------------------
function projDraftValues(src) {
  const s = src || {};
  return {
    name: typeof s.name === 'string' ? s.name : '',
    description: typeof s.description === 'string' ? s.description : '',
    hue: typeof s.hue === 'number' ? s.hue : null,
    cwd: typeof s.cwd === 'string' ? s.cwd : '',
    addDirs: Array.isArray(s.addDirs) ? s.addDirs.slice() : [],
    mcpServers: Array.isArray(s.mcpServers) ? s.mcpServers.slice() : null,
    model: s.model || '', effort: s.effort || '', permissionMode: s.permissionMode || '',
    agent: s.agent || '', instructions: typeof s.instructions === 'string' ? s.instructions : '',
    archived: !!s.archived,
    // P-2 cockpit fields (section „Zuordnung"); an update sends only what changed (projDraftPatch)
    paths: Array.isArray(s.paths) ? s.paths.slice() : [], hideInAll: !!s.hideInAll,
    jiraKeys: Array.isArray(s.jiraKeys) ? s.jiraKeys.slice() : [],
    // P2 — copied DEEP: a start order is an object, and a shared one would let a typed label edit the stored record
    starters: Array.isArray(s.starters) ? s.starters.map((x) => ({ label: String((x && x.label) || ''), prompt: String((x && x.prompt) || '') })) : [],
    memory: Array.isArray(s.memory) ? s.memory.slice() : [],
  };
}
// what Speichern sends — blank directory rows dropped, paths trimmed; `id` = an update (a merge on the server)
function projDraftBody(d) {
  const v = d.values;
  const out = {
    name: v.name, description: v.description, hue: v.hue, cwd: String(v.cwd || '').trim(),
    addDirs: v.addDirs.map((x) => String(x || '').trim()).filter(Boolean),
    mcpServers: Array.isArray(v.mcpServers) ? v.mcpServers.slice() : null,
    model: v.model, effort: v.effort, permissionMode: v.permissionMode, agent: String(v.agent || '').trim(),
    instructions: v.instructions, archived: !!v.archived,
    paths: v.paths.map((x) => String(x || '').trim()).filter(Boolean), hideInAll: !!v.hideInAll,
    jiraKeys: v.jiraKeys.map((x) => String(x || '').trim()).filter(Boolean),
    // a row with both halves empty is an unused editor row (projects-core drops it too); one half empty stays and is NAMED
    starters: v.starters.map((x) => ({ label: String(x.label || '').trim(), prompt: String(x.prompt || '').trim() })).filter((x) => x.label || x.prompt),
    memory: v.memory.map((x) => String(x || '').trim()).filter(Boolean),
  };
  if (d.id) out.id = d.id;
  return out;
}
const projDraftKey = (d) => JSON.stringify(projDraftBody(d));
function projDirty() { return !!PROJ_DRAFT && projDraftKey(PROJ_DRAFT) !== PROJ_DRAFT.base; }
// What Speichern sends for an UPDATE: only the fields this editor changed against what it loaded, plus the
// version it loaded (`baseUpdatedAt`). The full draft used to go out, so a save from a window opened earlier put
// back every field another window had changed since — silently (lib/projects.js now answers that with 409). And
// with only the changed fields, „keep mine" after a conflict lays exactly those over the newer state.
function projDraftPatch(d, body) {
  let base = {};
  try { base = JSON.parse(d.base); } catch { /* then every field counts as changed */ }
  const out = { id: d.id };
  if (Number.isFinite(d.baseUpdatedAt)) out.baseUpdatedAt = d.baseUpdatedAt;
  for (const k of Object.keys(body)) if (k !== 'id' && JSON.stringify(body[k]) !== JSON.stringify(base[k])) out[k] = body[k];
  return out;
}

// p = a stored project (edit) or null (new); opts.values = a prefill (Aus Tab), opts.fromTab = its source.
// opts.fromDraft (P5) = { key, sessionIds, titles } — a draft of „Neue Projekte vorschlagen“: the editor shows its sessions
// with a ticked box, and projEditorSave assigns them after a successful CREATE only while the box is still ticked.
// One editor at a time: a second open brings the first one back into focus instead of replacing its draft.
function openProjectEditor(p, opts) {
  opts = opts || {};
  if (PROJ_DRAFT) { const f = PROJ_DRAFT.box && PROJ_DRAFT.box.querySelector('[data-pk]'); if (f) f.focus(); return; }
  const ov = el('div', 'modal-overlay proj-editor-overlay');
  ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'projEdTitle');
  const box = el('div', 'modal proj-editor');
  ov.appendChild(box); document.body.appendChild(ov);
  const opener = document.activeElement;
  const d = {
    id: p ? p.id : null, values: projDraftValues(opts.values || p), errors: [], saving: false,
    baseUpdatedAt: p && Number.isFinite(p.updatedAt) ? p.updatedAt : undefined,
    // the opener by its focus key as well: a background reload rebuilds the page under the dialog, and the
    // overlay stack can only hand the caret back to the node it saw — by then no longer in the document
    openerFk: (opener && opener.dataset && opener.dataset.fk) || null,
    mcpConfigured: undefined, mcpError: '', agents: [], memGroups: null, fromTab: opts.fromTab || null, ov, box,
    fromDraft: (!p && opts.fromDraft && Array.isArray(opts.fromDraft.sessionIds) && opts.fromDraft.sessionIds.length)
      ? { key: String(opts.fromDraft.key || ''), ids: opts.fromDraft.sessionIds.slice(), titles: Array.isArray(opts.fromDraft.titles) ? opts.fromDraft.titles.slice() : [], assign: true }
      : null, release: null, focusNext: null,
  };
  d.base = projDraftKey(d);
  PROJ_DRAFT = d;
  // no trap autofocus (the name field is the target below); Enter in a single-line field saves, like uiModal
  d.release = overlayPush(ov, { box, autofocus: false, onEsc: () => { projEditorClose(); }, onEnter: () => { projEditorSave(); } });
  projEditorDraw();
  setTimeout(() => { const f = box.querySelector('[data-pk="name"]'); if (f && PROJ_DRAFT === d) f.focus(); }, 0);
  // the two lists the form offers — each on its own, each allowed to fail without taking the editor with it
  api('/api/mcp/configured').then((r) => {
    if (PROJ_DRAFT !== d) return;
    d.mcpConfigured = ((r && r.servers) || []).map((s) => s.name); projEditorDraw();
  }).catch((e) => { if (PROJ_DRAFT !== d) return; d.mcpConfigured = null; d.mcpError = (e && e.message) || ''; projEditorDraw(); });
  api('/api/cfgfiles?kind=agents').then((r) => {
    if (PROJ_DRAFT !== d) return;
    d.agents = ((r && r.files) || []).map((f) => f.name).filter(Boolean); projEditorDraw();
  }).catch(() => { /* no list — the field still takes a typed name */ });
  // P2 — the memory files offered for „Projektwissen" (the memory view's own list); without it a name is typed
  api('/api/memory').then((r) => {
    if (PROJ_DRAFT !== d) return;
    d.memGroups = (r && Array.isArray(r.groups)) ? r.groups : []; projEditorDraw();
  }).catch(() => { /* no list — the save still checks every name */ });
}
// The files the memory folder of the draft's effective cwd holds (its own cwd, else the main folder) — the same folder
// the server checks the names against on save (lib/projects.js memoryFolderOf), matched by the comparison key.
function projMemNames(d) {
  const cwd = String(d.values.cwd || '').trim() || projMainCwd();
  const g = (d.memGroups || []).find((x) => x && x.projectPath && projectPathKey(x.projectPath) === projectPathKey(cwd));
  return g && Array.isArray(g.files) ? g.files.map((f) => f.name).filter((n) => typeof n === 'string') : [];
}
// one row per start order: the label (a line), the prompt (a textarea), × — the rows of projListBlock with two fields
function projStartersBlock(d) {
  const v = d.values;
  const wrap = el('div', 'pe-dirs pe-starters');
  v.starters.forEach((s, i) => {
    const r = el('div', 'pe-starter-row');
    const lab = projInput('starters', s.label, (x) => { v.starters[i].label = x; }, { idx: 'l' + i, placeholder: t('projects.startLabelPh') });
    lab.setAttribute('aria-label', t('projects.startLabel') + ' ' + (i + 1));
    const pr = projInput('starters', s.prompt, (x) => { v.starters[i].prompt = x; }, { idx: 'p' + i, multiline: true, rows: 2, placeholder: t('projects.startPromptPh') });
    pr.setAttribute('aria-label', t('projects.startPrompt') + ' ' + (i + 1));
    r.appendChild(lab); r.appendChild(pr);
    const x = el('button', 'mini-btn si-ico pe-dir-x', '×'); x.type = 'button';
    x.title = t('projects.startEntfernen'); x.setAttribute('aria-label', t('projects.startEntfernen') + ': ' + (s.label || (i + 1)));
    x.dataset.pk = 'starters-x'; x.dataset.idx = String(i);
    x.onclick = () => { v.starters.splice(i, 1); projClearFieldErrors('starters'); projEditorDraw(); };
    r.appendChild(x);
    wrap.appendChild(r);
  });
  const add = iconBtn('mini-btn', 'plus', { label: t('projects.startHinzu'), onClick: () => { v.starters.push({ label: '', prompt: '' }); d.focusNext = { pk: 'starters', idx: 'l' + (v.starters.length - 1) }; projEditorDraw(); } });
  add.dataset.pk = 'starters-add';
  if (v.starters.length >= PROJECT_CAPS.starters) { add.disabled = true; add.title = t('projects.startMax').replace('{n}', PROJECT_CAPS.starters); }
  wrap.appendChild(add);
  return wrap;
}
// focus survives the redraw: the control is found again by its data-pk/data-idx, with its caret
function projFocusMark(box) {
  const a = document.activeElement;
  if (!a || !box.contains(a) || !a.dataset || !a.dataset.pk) return null;
  let s = null, e = null; try { s = a.selectionStart; e = a.selectionEnd; } catch { /* not a text control */ }
  return { pk: a.dataset.pk, idx: a.dataset.idx || '', s, e };
}
function projFocusRestore(box, m) {
  if (!m) return;
  const f = [...box.querySelectorAll('[data-pk]')].find((x) => x.dataset.pk === m.pk && (x.dataset.idx || '') === m.idx);
  if (!f) return;
  try { f.focus(); if (m.s != null && typeof f.setSelectionRange === 'function') f.setSelectionRange(m.s, m.e); } catch { /* */ }
}
function projField(key, label, control, hint) {
  const d = PROJ_DRAFT;
  const f = el('div', 'ui-field pe-field');
  f.dataset.field = key;
  // a form control gets a real <label for>; a composite (swatches, directory rows, the MCP list) is a named group
  const formCtl = !!(control && control.tagName && /^(INPUT|TEXTAREA|SELECT)$/i.test(control.tagName));
  const lab = el(formCtl ? 'label' : 'div', 'ui-flabel', label);
  if (formCtl) { control.id = 'pe-' + key; lab.htmlFor = control.id; }
  else { lab.id = 'pe-l-' + key; control.setAttribute('role', 'group'); control.setAttribute('aria-labelledby', lab.id); }
  f.appendChild(lab); f.appendChild(control);
  if (hint) f.appendChild(el('div', 'pe-hint', hint));
  const w = el('div', 'pe-fwarn'); w.dataset.warnFor = key; f.appendChild(w); // filled by projEditorLint
  const errs = d.errors.filter((e) => e.field === key);
  if (errs.length) { f.classList.add('is-invalid'); errs.forEach((e) => f.appendChild(el('div', 'pe-ferror', '✕ ' + projErrorMsg(e)))); }
  return f;
}
function projInput(key, value, onInput, opts) {
  opts = opts || {};
  const i = el(opts.multiline ? 'textarea' : 'input', 'ui-input' + (opts.multiline ? ' ui-textarea' : '') + (opts.mono ? ' pe-mono' : ''));
  if (opts.multiline) i.rows = opts.rows || 3; else i.type = 'text';
  i.value = value == null ? '' : value;
  if (opts.placeholder) i.placeholder = opts.placeholder;
  if (opts.list) i.setAttribute('list', opts.list);
  i.spellcheck = !opts.mono;
  i.dataset.pk = key; if (opts.idx != null) i.dataset.idx = String(opts.idx);
  i.oninput = () => { onInput(i.value); projClearFieldErrors(key); projEditorLint(); };
  return i;
}
// An error stops describing a field the moment the field is edited — otherwise „zu lang" stays under a text that
// the counter next to it already calls fine. Removed in place (no redraw: the caret stays where it is); the next
// Speichern validates everything again anyway.
function projClearFieldErrors(key) {
  const d = PROJ_DRAFT; if (!d || !d.errors.some((e) => e.field === key)) return;
  d.errors = d.errors.filter((e) => e.field !== key);
  const f = [...d.box.querySelectorAll('.pe-field')].find((x) => x.dataset.field === key);
  if (f) { f.classList.remove('is-invalid'); [...f.querySelectorAll('.pe-ferror')].forEach((x) => x.remove()); }
  [...d.box.querySelectorAll('.pe-errors li')].forEach((li) => { if (li.dataset.field === key) li.remove(); });
  const box = d.box.querySelector('.pe-errors');
  if (box && !d.errors.length) box.remove();
}
function projSelect(key, options, value, onChange) {
  const s = el('select', 'ui-input pe-select');
  s.dataset.pk = key;
  options.forEach((o) => { const opt = el('option', null, o.label); opt.value = o.value; if (o.disabled) opt.disabled = true; s.appendChild(opt); });
  s.value = value;
  s.onchange = () => { onChange(s.value); projClearFieldErrors(key); projEditorLint(); };
  return s;
}
// „n / max", and past the cap a word, not only a colour: the text is refused on save, not cut (projects-core)
function projCounter(key, len, max) {
  const c = el('div', 'pe-counter');
  c.dataset.for = key;
  projCounterSet(c, len, max);
  return c;
}
function projCounterSet(c, len, max) {
  const over = len > max;
  c.className = 'pe-counter' + (over ? ' over' : '');
  c.textContent = (over ? '⚠ ' : '') + fmtInt(len) + ' / ' + fmtInt(max) + (over ? ' — ' + t('projects.zuLang') : '');
}
// The live warnings — what projects-core says without any measurement (the paths are measured on save) — into
// the slot under their field, without a redraw, so typing never loses the caret.
function projEditorLint() {
  const d = PROJ_DRAFT; if (!d || !d.box) return;
  const warns = projectWarnings(projDraftBody(d), { mcpConfigured: Array.isArray(d.mcpConfigured) ? d.mcpConfigured : null, mainCwd: projMainCwd() });
  [...d.box.querySelectorAll('.pe-fwarn')].forEach((slot) => {
    const mine = warns.filter((w) => w.field === slot.dataset.warnFor);
    slot.textContent = mine.map((w) => '⚠ ' + projWarningText(w)).join('\n');
    slot.className = 'pe-fwarn' + (mine.length ? ' on' : '');
  });
  const v = d.values;
  [...d.box.querySelectorAll('.pe-counter')].forEach((c) => {
    if (c.dataset.for === 'description') projCounterSet(c, v.description.length, PROJECT_CAPS.description);
    if (c.dataset.for === 'instructions') projCounterSet(c, v.instructions.length, PROJECT_CAPS.instructions);
  });
}
// MCP checkbox semantics = the tab picker's (chat.js applyTabMcp): every configured server ticked = null (no
// scoping), none = [] (deliberately none), else the ticked names. A stored name the config does not list any more
// stays in the list as its own row (with its warning) until it is unticked — never dropped silently.
function projMcpSet(name, on) {
  const d = PROJ_DRAFT; if (!d) return;
  const conf = Array.isArray(d.mcpConfigured) ? d.mcpConfigured : [];
  const v = d.values;
  const cur = v.mcpServers === null ? conf.slice() : v.mcpServers.slice();
  let next = on ? (cur.includes(name) ? cur : cur.concat([name])) : cur.filter((x) => x !== name);
  next = conf.filter((x) => next.includes(x)).concat(next.filter((x) => !conf.includes(x)));
  const allConf = conf.length > 0 && conf.every((x) => next.includes(x)) && next.every((x) => conf.includes(x));
  v.mcpServers = allConf ? null : next;
  projClearFieldErrors('mcpServers');
  projEditorDraw();
}
function projMcpBlock(d) {
  const v = d.values;
  const wrap = el('div', 'pe-mcp');
  const sel = v.mcpServers;
  const summary = sel === null ? t('projects.mcpAlleLang') : !sel.length ? t('projects.mcpKeineLang') : t('projects.mcpNAusgewaehlt').replace('{n}', fmtInt(sel.length));
  wrap.appendChild(el('div', 'pe-mcp-sum', summary));
  if (d.mcpConfigured === undefined) { wrap.appendChild(el('div', 'loading', t('common.lade'))); return wrap; }
  if (d.mcpConfigured === null) {
    // nothing to tick against → the stored choice stays exactly as it is (no checkbox could claim otherwise)
    wrap.appendChild(el('div', 'pe-warn', '⚠ ' + t('projects.mcpListeFehlt') + (d.mcpError ? ' (' + d.mcpError + ')' : '')));
    return wrap;
  }
  const conf = d.mcpConfigured;
  const unknown = Array.isArray(sel) ? sel.filter((n) => !conf.includes(n)) : [];
  if (!conf.length && !unknown.length) { wrap.appendChild(el('div', 'empty-mini', t('chat.keineMcpServerKonfiguriert'))); return wrap; }
  const list = el('div', 'mcp-check-list pe-mcp-list');
  const row = (name, known) => {
    const lab = el('label', 'mcp-check' + (known ? '' : ' pe-mcp-unknown'));
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = sel === null ? known : sel.includes(name);
    cb.dataset.pk = 'mcp'; cb.dataset.idx = name;
    cb.onchange = () => projMcpSet(name, cb.checked);
    lab.appendChild(cb); lab.appendChild(el('span', 'mcp-name', name));
    if (!known) lab.appendChild(el('span', 'pe-mcp-note', t('projects.mcpNichtKonfiguriert')));
    list.appendChild(lab);
  };
  conf.forEach((n) => row(n, true));
  unknown.forEach((n) => row(n, false));
  wrap.appendChild(list);
  const btns = el('div', 'pe-row-btns');
  const all = el('button', 'mini-btn', t('common.alle')); all.type = 'button'; all.dataset.pk = 'mcp-all';
  all.onclick = () => { v.mcpServers = null; projEditorDraw(); };
  const none = el('button', 'mini-btn', t('chat.keine')); none.type = 'button'; none.dataset.pk = 'mcp-none';
  none.onclick = () => { v.mcpServers = []; projEditorDraw(); };
  btns.appendChild(all); btns.appendChild(none);
  wrap.appendChild(btns);
  return wrap;
}
function projDirsBlock(d) {
  return projListBlock(d, 'addDirs', { placeholder: 'C:\\Users\\…\\repo', del: 'projects.ordnerEntfernen', add: 'projects.ordnerHinzu', max: 'projects.ordnerMax', mono: true });
}
// one row per entry, × removes, + adds — the directory rows, and (P-2) the folder rules and the Jira keys
function projListBlock(d, key, o) {
  const v = d.values;
  const wrap = el('div', 'pe-dirs');
  v[key].forEach((val, i) => {
    const r = el('div', 'pe-dir-row');
    r.appendChild(projInput(key, val, (x) => { v[key][i] = x; }, { mono: o.mono, idx: i, placeholder: o.placeholder, list: o.list }));
    if (o.link) { const l = o.link(String(val || '').trim().toUpperCase()); if (l) r.appendChild(l); }
    const x = el('button', 'mini-btn si-ico pe-dir-x', '×'); x.type = 'button';
    x.title = t(o.del); x.setAttribute('aria-label', t(o.del) + ': ' + (val || ''));
    x.dataset.pk = key + '-x'; x.dataset.idx = String(i);
    x.onclick = () => { v[key].splice(i, 1); projClearFieldErrors(key); projEditorDraw(); };
    r.appendChild(x);
    wrap.appendChild(r);
  });
  const add = iconBtn('mini-btn', 'plus', { label: t(o.add), onClick: () => { v[key].push(''); d.focusNext = { pk: key, idx: String(v[key].length - 1) }; projEditorDraw(); } });
  add.dataset.pk = key + '-add';
  if (v[key].length >= PROJECT_CAPS[key]) { add.disabled = true; add.title = t(o.max).replace('{n}', PROJECT_CAPS[key]); }
  wrap.appendChild(add);
  return wrap;
}
function projModelOptions(cur) {
  const out = [{ value: '', label: t('projects.chatStandard') }];
  const sel = $('#modelSel');
  (sel ? [...sel.options] : []).forEach((o) => { if (o.value) out.push({ value: o.value, label: o.textContent, disabled: o.disabled }); });
  if (cur && !out.some((o) => o.value === cur)) out.push({ value: cur, label: cur });
  return out;
}
// Rebuilds the form FROM PROJ_DRAFT — never the other way round. Called on open, on every structural change, when
// a list arrives, and from loadProjects (language switch, background reload): the labels follow LANG, the values
// are the draft's, the focused control gets its caret back.
function projEditorDraw() {
  const d = PROJ_DRAFT; if (!d || !d.box) return;
  const box = d.box, v = d.values;
  const focus = d.focusNext || projFocusMark(box);
  d.focusNext = null;
  const oldBody = box.querySelector('.pe-body');
  const scroll = oldBody ? oldBody.scrollTop : 0;
  box.innerHTML = '';
  const head = el('div', 'modal-head pe-head');
  head.appendChild(el('span', 'perm-icon', '◆'));
  const h = el('h3', null, d.id ? t('projects.editorBearbeiten') : t('projects.editorNeu')); h.id = 'projEdTitle';
  head.appendChild(h);
  box.appendChild(head);
  const body = el('div', 'pe-body');
  box.appendChild(body);
  if (d.fromTab) body.appendChild(el('div', 'pe-hint pe-from', t('projects.ausTabHinweis').replace('{title}', d.fromTab.title || '')));
  if (d.fromTab && d.fromTab.permDropped) body.appendChild(el('div', 'pe-warn', '⚠ ' + t('projects.bypassNichtUebernommen')));
  if (d.fromDraft) body.appendChild(projDraftAssignBlock(d));
  if (d.errors.length) {
    const eb = el('div', 'pe-errors'); eb.setAttribute('role', 'alert');
    eb.appendChild(el('div', 'pe-errors-head', t('projects.nichtGespeichert')));
    const ul = el('ul');
    d.errors.forEach((e) => { const li = el('li', null, '✕ ' + projErrorText(e)); li.dataset.field = e.field || ''; ul.appendChild(li); });
    eb.appendChild(ul);
    body.appendChild(eb);
  }

  const sec = (title) => { const s = el('div', 'pe-sec'); s.appendChild(el('div', 'pe-sec-title', title)); body.appendChild(s); return s; };
  const s1 = sec(t('projects.secAllgemein'));
  s1.appendChild(projField('name', t('projects.fName') + ' *', projInput('name', v.name, (x) => { v.name = x; })));
  const sw = el('div', 'swatch-row pe-swatches'); sw.setAttribute('role', 'group'); sw.setAttribute('aria-label', t('projects.fFarbe'));
  const swatch = (hue) => {
    const b = el('button', 'swatch' + (hue === null ? ' pe-swatch-none' : '') + (v.hue === hue ? ' sel' : ''), hue === null ? '–' : null);
    b.type = 'button';
    if (hue !== null) b.style.background = 'hsl(' + hue + ' 65% 55%)';
    const lbl = hue === null ? t('projects.keineFarbe') : t('projects.farbton').replace('{n}', hue);
    b.title = lbl; b.setAttribute('aria-label', lbl); b.setAttribute('aria-pressed', v.hue === hue ? 'true' : 'false');
    b.dataset.pk = 'hue'; b.dataset.idx = String(hue);
    b.onclick = () => { v.hue = hue; projClearFieldErrors('hue'); projEditorDraw(); };
    sw.appendChild(b);
  };
  swatch(null);
  (typeof TAB_HUES !== 'undefined' ? TAB_HUES : []).forEach(swatch);
  s1.appendChild(projField('hue', t('projects.fFarbe'), sw, t('projects.farbeHinweis')));
  const desc = projField('description', t('projects.fBeschreibung'), projInput('description', v.description, (x) => { v.description = x; }, { multiline: true, rows: 2 }));
  desc.appendChild(projCounter('description', v.description.length, PROJECT_CAPS.description));
  s1.appendChild(desc);

  const s2 = sec(t('projects.secStart'));
  const main = projMainCwd();
  s2.appendChild(projField('cwd', t('projects.fCwd'), projInput('cwd', v.cwd, (x) => { v.cwd = x; }, { mono: true, placeholder: main ? t('projects.cwdPlaceholder').replace('{main}', main) : '' }),
    t('projects.cwdHinweis').replace('{main}', main || '—')));
  s2.appendChild(projField('addDirs', t('projects.fAddDirs'), projDirsBlock(d), t('projects.addDirsHinweis')));
  s2.appendChild(projField('mcpServers', t('projects.fMcp'), projMcpBlock(d), t('projects.mcpHinweis')));
  const grid = el('div', 'pe-grid');
  grid.appendChild(projField('model', t('common.modell'), projSelect('model', projModelOptions(v.model), v.model, (x) => { v.model = x; })));
  grid.appendChild(projField('effort', t('html.aufwandsstufe'), projSelect('effort',
    [{ value: '', label: t('projects.chatStandard') }].concat(PROJECT_EFFORTS.map((e) => ({ value: e, label: projEffortLabel(e) }))), v.effort, (x) => { v.effort = x; })));
  grid.appendChild(projField('permissionMode', t('html.berechtigungsmodus'), projSelect('permissionMode',
    [{ value: '', label: t('projects.chatStandard') }].concat(PROJECT_PERM_MODES.map((m) => ({ value: m, label: projModeLabel(m) }))), v.permissionMode, (x) => { v.permissionMode = x; }),
  t('projects.modusHinweis')));
  const agentIn = projInput('agent', v.agent, (x) => { v.agent = x; }, { mono: true, list: 'peAgentList' });
  const agentF = projField('agent', t('projects.fAgent'), agentIn);
  if (d.agents.length) { const dl = el('datalist'); dl.id = 'peAgentList'; d.agents.forEach((n) => { const o = el('option'); o.value = n; dl.appendChild(o); }); agentF.appendChild(dl); }
  grid.appendChild(agentF);
  s2.appendChild(grid);

  const s3 = sec(t('projects.fAnweisungen'));
  const instr = projField('instructions', t('projects.fAnweisungen'), projInput('instructions', v.instructions, (x) => { v.instructions = x; }, { multiline: true, rows: 6 }), projInstrNote());
  instr.appendChild(projCounter('instructions', v.instructions.length, PROJECT_CAPS.instructions));
  if (d.fromTab && d.fromTab.guardrails) {
    const cp = el('button', 'mini-btn pe-copy-guard', t('projects.leitplankenKopieren')); cp.type = 'button'; cp.dataset.pk = 'copy-guard';
    cp.title = t('projects.leitplankenKopierenTooltip');
    cp.onclick = () => { v.instructions = (v.instructions ? v.instructions.replace(/\s+$/, '') + '\n' : '') + d.fromTab.guardrails; projEditorDraw(); };
    instr.appendChild(cp);
  }
  s3.appendChild(instr);
  if (d.id) {
    const ac = el('label', 'ui-check'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!v.archived; cb.dataset.pk = 'archived';
    cb.onchange = () => { v.archived = cb.checked; };
    ac.appendChild(cb); ac.appendChild(el('span', null, t('projects.archivierenLabel')));
    s3.appendChild(ac);
  }

  // P2: what a chat of the project starts WITH — orders that send at once, and the memory files it is told to read
  const s3b = sec(t('projects.secStartauftraege'));
  s3b.appendChild(projField('starters', t('projects.fStartauftraege'), projStartersBlock(d), t('projects.startauftraegeHinweis')));
  const memNames = projMemNames(d);
  const memF = projField('memory', t('projects.fProjektwissen'), projListBlock(d, 'memory', { placeholder: t('projects.wissenPlatzhalter'), del: 'projects.wissenEntfernen', add: 'projects.wissenHinzu', max: 'projects.wissenMax', mono: true, list: memNames.length ? 'peMemList' : '' }),
    t('projects.wissenEditorHinweis').replace('{cwd}', String(v.cwd || '').trim() || projMainCwd() || '—') + ' ' + projInstrNote());
  if (memNames.length) { const dl = el('datalist'); dl.id = 'peMemList'; memNames.forEach((n) => { const o = el('option'); o.value = n; dl.appendChild(o); }); memF.appendChild(dl); }
  s3b.appendChild(memF);

  // P-2: what LABELS sessions — never what starts them (a rule steers no start; the hint says so)
  const s4 = sec(t('projects.secZuordnung'));
  s4.appendChild(projField('paths', t('projects.fRegeln'), projListBlock(d, 'paths', { placeholder: 'C:\\Atlas*', del: 'projects.regelEntfernen', add: 'projects.regelHinzu', max: 'projects.regelMax', mono: true }), t('projects.regelnEditorHinweis')));
  s4.appendChild(projField('jiraKeys', t('projects.fJiraKeys'), projListBlock(d, 'jiraKeys', { placeholder: 'ACME-4909', del: 'projects.jiraEntfernen', add: 'projects.jiraHinzu', max: 'projects.jiraMax', mono: true,
    link: (k) => (PROJECT_JIRA_KEY_RE.test(k) ? projJiraLink(k) : null) }), t('projects.jiraEditorHinweis')));
  const hc = el('label', 'ui-check'); const hcb = el('input'); hcb.type = 'checkbox'; hcb.checked = !!v.hideInAll; hcb.dataset.pk = 'hideInAll';
  hcb.onchange = () => { v.hideInAll = hcb.checked; };
  hc.appendChild(hcb); hc.appendChild(el('span', null, t('projects.fInAlleAusblenden')));
  s4.appendChild(hc);
  s4.appendChild(el('div', 'pe-hint', t('projects.hideInAllHinweis')));

  const foot = el('div', 'modal-actions pe-foot');
  const cancel = el('button', 'ghost-btn', t('html.abbrechen')); cancel.type = 'button'; cancel.dataset.pk = 'cancel';
  cancel.onclick = () => { projEditorClose(); };
  const save = el('button', 'primary-btn', d.saving ? t('projects.speichert') : t('common.speichern')); save.type = 'button'; save.dataset.pk = 'save';
  save.disabled = !!d.saving;
  save.onclick = () => { projEditorSave(); };
  foot.appendChild(cancel); foot.appendChild(save);
  box.appendChild(foot);
  body.scrollTop = scroll;
  projEditorLint();
  projFocusRestore(box, focus);
}
// Esc, Abbrechen and a reload all come through here. A changed draft is asked about with THREE answers
// (views-memory.js memDraftMayGo): without „Weiter bearbeiten" the dialog would force the choice it asks about.
async function projEditorClose(force) {
  const d = PROJ_DRAFT; if (!d) return true;
  if (!force && projDirty()) {
    const v = await uiModal({
      icon: '⚠', title: t('projects.entwurfTitel'), message: t('projects.entwurfFrage'), escValue: 'cancel',
      actions: [
        { label: t('projects.weiterBearbeiten'), value: 'cancel' },
        { label: t('projects.verwerfen'), value: 'discard', kind: 'danger-btn' },
        { label: t('common.speichern'), value: 'save', primary: true },
      ],
    });
    if (PROJ_DRAFT !== d) return true;
    if (v === 'save') return projEditorSave();
    if (v !== 'discard') return false;
  }
  if (PROJ_DRAFT !== d) return true;
  projEditorDetach(d);
  return true;
}
// Closes the dialog. The overlay stack hands the caret back to the button that opened it — unless a background
// reload rebuilt the page meanwhile and that node is gone; then the same control in the new build gets it.
// focus = candidates for the rebuild the caller does next (renderProjects); without it nothing is rebuilt, and a
// lost caret goes straight to the opener's successor.
function projEditorDetach(d, focus) {
  if (PROJ_DRAFT === d) PROJ_DRAFT = null;
  if (d.release) d.release();
  if (d.ov) d.ov.remove();
  const body = $('#projBody'); if (!body) return;
  if (focus) { PROJ_VIEW.focus = focus; return; }
  const a = document.activeElement;
  const lost = !a || a === document.body || (typeof a.isConnected === 'boolean' && !a.isConnected);
  if (lost && d.openerFk) projFocusFk(body, [d.openerFk]);
}
// a record from the server into PROJECTS_DATA — the per-request numbers (counts, last activity) are kept, the
// stored fields are the server's
function projStoreRecord(p) {
  const keep = projById(p.id);
  const rec = Object.assign({}, p, {
    sessionCount: keep ? keep.sessionCount : 0, lastActivity: keep ? keep.lastActivity : null,
    assignedCount: keep && Number.isFinite(keep.assignedCount) ? keep.assignedCount : 0,
  });
  PROJECTS_DATA = [rec].concat((PROJECTS_DATA || []).filter((x) => x.id !== p.id));
  return rec;
}
// Validates with the SAME rules the route applies (projects-core) before it sends; the route's own 400 comes back
// as the same token list. Either way the dialog stays open with the draft and names every field.
async function projEditorSave() {
  const d = PROJ_DRAFT; if (!d || d.saving) return false;
  const body = projDraftBody(d);
  const v = projectValidate(body, { posix: projPosix() });
  if (!v.ok) { d.errors = v.errors; projEditorDraw(); projEditorShowErrors(d); return false; }
  d.saving = true; d.errors = []; projEditorDraw();
  let r;
  try { r = await projPost('/api/projects', { project: d.id ? projDraftPatch(d, body) : body }); } catch (e) {
    if (PROJ_DRAFT !== d) return false;
    d.saving = false;
    if (e && e.status === 409 && e.data && e.data.project && e.data.project.id === d.id) { projEditorDraw(); return projEditorConflict(d, e.data.project); }
    d.errors = (e && e.data && Array.isArray(e.data.errors) && e.data.errors.length) ? e.data.errors : [{ field: '', code: '', message: (e && e.message) || '' }];
    projEditorDraw(); projEditorShowErrors(d);
    return false;
  }
  const p = r.project;
  const onView = !!($('#view-projects') && $('#view-projects').classList.contains('active'));
  // P5 — a draft's sessions: only after a CREATE that went through, only with the tick, and through the same route as
  // every other assignment (projAssign: one POST, its own toast). Read here, before the dialog lets go of the draft.
  const fromDraft = r.created ? d.fromDraft : null;
  const assignIds = fromDraft && fromDraft.assign ? fromDraft.ids.slice() : [];
  // the caret after the save: an edit returns to the page's Bearbeiten button, a new project lands on its name
  if (PROJ_DRAFT === d) projEditorDetach(d, onView ? (r.created ? ['pd-name'] : ['act-edit', 'pd-name']) : null);
  projStoreRecord(p);
  PROJ_VIEW.sel = p.id;
  toast(t(r.created ? 'projects.angelegt' : 'projects.gespeichert').replace('{name}', p.name), 'ok');
  if (p.warnings && p.warnings.length) toast(t('projects.gespeichertHinweise').replace('{n}', fmtInt(p.warnings.length)), 'warn');
  if (fromDraft) { projDraftForget(fromDraft.key); projOvInvalidate(); }
  if (assignIds.length) await projAssign(assignIds, p.id, p);
  else if (onView) { renderProjects(); loadProjects(); }
  return true;
}
// 409: the project was saved somewhere else since this editor loaded it. Three answers, the safe one first (it is
// what Esc and the initial focus mean): keep editing · drop this draft and show the stored state · lay MY changed
// fields over the stored state (projDraftPatch on the new base — what I did not touch stays as the other save
// left it). Never a silent overwrite, in either direction.
async function projEditorConflict(d, cur) {
  projStoreRecord(cur);
  const v = await uiModal({
    icon: '⚠', title: t('projects.konfliktTitel'), message: t('projects.konfliktFrage').replace('{name}', cur.name || ''), escValue: 'cancel',
    actions: [
      { label: t('projects.weiterBearbeiten'), value: 'cancel' },
      { label: t('projects.konfliktLaden'), value: 'load' },
      { label: t('projects.konfliktMeine'), value: 'mine' },
    ],
  });
  if (PROJ_DRAFT !== d) return false;
  if (v === 'mine') { d.baseUpdatedAt = cur.updatedAt; return projEditorSave(); }
  if (v === 'load') {
    const onView = !!($('#view-projects') && $('#view-projects').classList.contains('active'));
    // the opener as the last candidate: unlike a save, this answer does not open the page, so an editor opened from
    // a tile's ✎ is rebuilt on the overview — where neither act-edit nor pd-name exists, and an explicit list
    // replaces renderProjects' fallback to the focused control (the caret ended on <body>)
    projEditorDetach(d, onView ? ['act-edit', 'pd-name', d.openerFk].filter(Boolean) : null);
    if (onView) renderProjects();
    toast(t('projects.konfliktGeladen').replace('{name}', cur.name || ''), 'ok');
  }
  return false;
}
function projEditorShowErrors(d) {
  const b = d && d.box && d.box.querySelector('.pe-body');
  if (b) b.scrollTop = 0;
}

// a reload throws an unsaved draft away as silently as a closed dialog would — same guard as the memory editor
window.addEventListener('beforeunload', (e) => {
  if (typeof RELOAD_FOR_RESTART !== 'undefined' && RELOAD_FOR_RESTART) return;
  if (projDirty()) { e.preventDefault(); e.returnValue = ''; }
});
if ($('#projSearch')) $('#projSearch').addEventListener('input', debounce(() => { if (PROJ_VIEW.sel) PROJ_VIEW.sel = null; renderProjects(); }));
if ($('#projNew')) $('#projNew').onclick = () => openProjectEditor(null);
if ($('#projFromTab')) $('#projFromTab').onclick = () => projectFromTab();
if ($('#projReload')) $('#projReload').onclick = () => { projOvInvalidate(); loadProjects(); };
