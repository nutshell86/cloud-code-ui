// Part of the Claude Code Control Panel front-end (split from app.js).
// Classic scripts share one global scope; load order in index.html is authoritative: render → chat → sessions → views → commands → boot.
// This file: views.js

// ============================================================
//  View-load guard (A10/A11)
//  render.js calls loadSystem()/loadMcp()/loadUsage()/loadSettings()/loadMemory() on EVERY nav click.
//  For System that meant three CLI spawns per click (doctor 45 s, auth status, --version + npm lookup);
//  for Memory a re-read of ~60 files. So each of those loaders now runs once and offers an explicit ↻.
//  The key carries LANG on purpose: applyLang → reloadActiveView must genuinely re-render in the new
//  language, and a LANG-keyed guard gives that for free without touching render.js.
// ============================================================
const VIEW_LOADED = Object.create(null);
function viewOnce(key, force) {
  const k = key + '|' + LANG;
  if (!force && VIEW_LOADED[k]) return false;
  VIEW_LOADED[k] = true;
  return true;
}

// ============================================================
//  SETTINGS
// ============================================================
// ORIG = what each editor was loaded with: its text (the dirty check) and the file's hash (If-Match on
// save, so a file that changed underneath answers 409 instead of being overwritten — DATA-2).
let ORIG = { main: '', local: '', mainHash: '', localHash: '' };
const SETT_FILES = {
  main: { stateKey: 'settings', file: 'settings.json', editor: 'editMain', badge: 'validMain', broken: 'brokenMain', note: 'noteMain', endpoint: '/api/config/settings' },
  local: { stateKey: 'settingsLocal', file: 'settings.local.json', editor: 'editLocal', badge: 'validLocal', broken: 'brokenLocal', note: 'noteLocal', endpoint: '/api/config/settings-local' },
};
function validate(editorId, badgeId) {
  const txt = $('#' + editorId).value;
  const badge = $('#' + badgeId);
  // an unreadable file's empty editor is not "valid": nothing was read (once typed into, the text is checked)
  const which = Object.keys(SETT_FILES).find((w) => SETT_FILES[w].editor === editorId);
  if (which && txt === ORIG[which] && settUnreadable(STATE && STATE[SETT_FILES[which].stateKey])) {
    badge.textContent = t('views.nichtLesbar'); badge.classList.add('invalid'); return true;
  }
  try { JSON.parse(txt || '{}'); badge.textContent = t('html.gueltig'); badge.classList.remove('invalid'); return true; }
  catch (e) { badge.textContent = t('views.ungueltigesJson'); badge.classList.add('invalid'); return false; }
}
// DATA-1: a file that does not parse is shown as the bytes it holds, never as `{}` — `{}` read as
// "valid, empty", and the next save wrote exactly that over the Bedrock env.
const settBroken = (snap) => !!(snap && snap.exists && snap.parsed == null);
// …and one that could not be read at all (locked, no permission, a folder in its place) has no text to
// show: the editor stays empty, the banner says so, and save() does not offer that empty text as the file.
const settUnreadable = (snap) => !!(snap && snap.unreadable);
function settEditorText(snap) {
  // without a leading BOM: the server parses past it, the browser's JSON.parse does not — a repaired
  // file would stay „ungültig" over a character nobody can see. If-Match is the server's hash anyway.
  if (settBroken(snap)) { const r = snap.raw || ''; return r.charCodeAt(0) === 0xFEFF ? r.slice(1) : r; }
  return JSON.stringify((snap && snap.parsed) || {}, null, 2);
}
// The banner names what the editor holds: the file's raw text, or — once typed into — the user's own
// text (claiming "this is the raw text" over an edit would be wrong). refreshDirty calls this on every
// keystroke, so it only rebuilds when that state (or the language) actually changes.
function paintSettBroken(which) {
  const f = SETT_FILES[which], box = $('#' + f.broken); if (!box) return;
  const snap = STATE && STATE[f.stateKey];
  const ed = $('#' + f.editor);
  const dirty = !!ed && ed.value !== ORIG[which];
  const state = !settBroken(snap) ? '' : settUnreadable(snap) ? (dirty ? 'unreadableDirty' : 'unreadable') : dirty ? 'dirty' : 'raw';
  const key = state && [state, LANG, snap.error || ''].join('|');
  if (box._state === key) return;
  box._state = key;
  box.innerHTML = '';
  box.classList.toggle('hidden', !state);
  if (!state) return;
  const msg = { unreadable: 'views.settUnlesbar', unreadableDirty: 'views.settUnlesbarDirty', dirty: 'views.settKaputtDirty', raw: 'views.settKaputt' }[state];
  box.appendChild(el('div', 'ec-msg', t(msg).replace('{file}', f.file)));
  if (snap.error) box.appendChild(el('div', 'sb-err', t(settUnreadable(snap) ? 'views.settUnlesbarFehler' : 'views.settKaputtFehler') + snap.error));
}
// Both badges are static i18n (data-i18n="html.gueltig"), so a language switch resets an invalid
// editor's badge to „gültig"; and loadSettings — keyed by LANG in viewOnce — does not run again on the
// second switch back. applyLang (render.js) calls this, so badge and banner follow the language.
function repaintSettEditors() {
  for (const which of Object.keys(SETT_FILES)) {
    const f = SETT_FILES[which];
    if (!$('#' + f.editor)) continue;
    validate(f.editor, f.badge);
    paintSettBroken(which);
  }
  refreshDirty();
}
// Put a file's fresh snapshot (what every settings write now answers with) into STATE and the editor.
// An editor with unsaved text keeps it — and keeps the hash it was loaded from, so its save meets the
// "file has changed" dialog instead of silently undoing what changed underneath. `discard` is the
// explicit reload that throws the unsaved text away.
function applySettingsSnapshot(which, snap, discard) {
  if (!snap || !STATE) return;
  const f = SETT_FILES[which];
  STATE[f.stateKey] = snap;
  const ed = $('#' + f.editor);
  if (ed && (discard || ed.value === ORIG[which])) {
    // ORIG from what the textarea now HOLDS, not from what was assigned: its value comes back with
    // CRLF normalised to LF, so a broken file saved with Windows line ends read as dirty forever
    ed.value = settEditorText(snap); ORIG[which] = ed.value; ORIG[which + 'Hash'] = snap.hash || '';
    if (which === 'main') paintQuickSettings();
  }
  // always: a kept (dirty) editor's badge may have been reset by a language switch in the meantime
  if (ed) validate(f.editor, f.badge);
  paintSettBroken(which);
  if (typeof refreshDirty === 'function') refreshDirty();
}
function paintQuickSettings() {
  const s = (STATE.settings || {}).parsed || {};
  // A value the three static options do not cover is PRESERVED as its own ⚠ option instead of leaving the
  // select blank — the same remedy the catalog's select branch uses, not a second one. This is a debt the
  // catalog change created: `theme` was taken out of SETTINGS_CATALOG (two live controls for one key could
  // contradict each other), and the row that went carried all SEVEN schema values and kept an unknown one
  // visible. Without this, `theme: "dark-ansi"` or any `custom:<name>` leaves `#qsTheme` on selectedIndex
  // -1 — a blank box over a value that IS set, and the next change writes one of three over it. The option
  // is rebuilt on every paint, so it disappears again as soon as the value becomes a known one.
  quickSelect('#qsTheme', s.theme || 'auto');
  quickSelect('#qsEffort', s.effortLevel || 'high');
  $('#qsModel').value = s.model || '';
}
// …the one place that knows it: a select whose current value has no option gets one, marked.
function quickSelect(sel, value) {
  const el2 = $(sel);
  if (!el2) return;
  el2.querySelectorAll('option[data-foreign]').forEach((o) => o.remove());
  const known = [...el2.options].some((o) => o.value === value);
  if (!known && value) {
    const o = el('option', null, value + ' ⚠');
    o.value = value; o.setAttribute('data-foreign', '1');
    el2.appendChild(o);
  }
  el2.value = value;
}
async function loadSettings(force, discard) {
  // ↻ (and a save) also re-arms the hook-catalog read: a session that timed out or does not know the
  // control is remembered as asked (see loadHookCatalog), and this is the explicit action that un-remembers
  // it. Before the viewOnce guard, because that guard is exactly what a ↻ is meant to get past.
  if (force) HOOK_LISTING_FOR = '';
  // …and ENTERING the view is the moment to ask, which has to happen BEFORE the viewOnce guard below: that
  // guard is what kept the editor on its labelled fallback: the view is loaded once at boot (no chat yet),
  // and every later entry early-returned without reaching renderFriendly at all. Found in the sight check.
  // Cheap and not awaited — it returns at once when this session's answer is already cached.
  loadHookCatalog();
  // A10: entering Settings refetched /api/state + the changelog every time; ↻ (and every save below,
  // which passes force) is what really needs fresh data.
  if (!viewOnce('settings', force) && STATE) return;
  try {
    STATE = await api('/api/state');
    // through applySettingsSnapshot: a language switch (which reloads this view) or a ↻ must not
    // overwrite text that is still being edited
    applySettingsSnapshot('main', STATE.settings, discard);
    applySettingsSnapshot('local', STATE.settingsLocal, discard);
    $('#qsAccent').value = localStorage.getItem('ccui-accent') || '#d97757';
    if ($('#qsDefaultCwd')) $('#qsDefaultCwd').value = (STATE && STATE.defaultCwd) || '';
    // D1/D2/D4 — the standing context lives in ui-prefs.json, not in settings.json (it is a panel
    // concept, not a CLI setting), so it comes from STATE.prefs
    const pr = (STATE && STATE.prefs) || {};
    if ($('#qsGuardrails')) $('#qsGuardrails').value = pr.guardrails || '';
    if ($('#qsUseCorrections')) $('#qsUseCorrections').checked = pr.useCorrections !== false;
    if ($('#qsOpenPoints')) $('#qsOpenPoints').checked = pr.openPoints !== false;
    if ($('#qsPlanProgress')) $('#qsPlanProgress').checked = pr.planProgress !== false; // PF-1, default on
    paintPromptSnapshot(); // PR-S — select + what it does with the installed CLI
    if ($('#qsClaudeBin')) $('#qsClaudeBin').value = pr.claudeBin || '';
    if ($('#qsMcpWait')) $('#qsMcpWait').value = pr.mcpStartupWaitMs || '';
    paintSubagentPrefs(pr.subagents || {}); // #34 — the standing subagent policy
    // What a start right now WOULD use (server re-resolves live), not the running constant: otherwise a
    // reload or a language switch would swallow the „wirkt erst nach einem Neustart" hint of a saved path.
    paintClaudeBinNote({
      claudeBinResolved: STATE.claudeBinResolved || STATE.claudeExe,
      claudeBinSource: STATE.claudeBinResolvedSource || STATE.claudeBinSource,
      claudeBinExists: STATE.claudeBinResolved ? STATE.claudeBinResolvedExists : STATE.claudeExeExists,
      restartNeeded: !!STATE.claudeBinRestartNeeded,
    });
    loadCorrections();
    renderFriendly();   // → renderHooks → renderHookEvents + loadHookCatalog (PR-11, not awaited)
    loadInfo();
  } catch (e) {
    toast(e.message, 'err');
    // visible in-view error too — a failed load otherwise leaves stale editors that read as current
    if (typeof errorCard === 'function') errorCard('#moreSettings', e.message, () => loadSettings(true));
  }
}

// --- D1/D2/D4: standing context (guardrails, the two switches, the correction store) ---------------
// All three write to ui-prefs.json / corrections.json and end up in the SAME appended system prompt,
// composed server-side (lib/pure composeAppendSystem). Kept together because a reader has to see what
// a new chat is actually given.
async function saveGuardPrefs(patch, note) {
  try {
    const r = await api('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    // The server answers with the NORMALISED policy (an out-of-range ceiling is clamped there, #34), so
    // the cached copy has to take its answer rather than the values that were sent.
    // MERGE, don't replace: this used to build a fresh object, so saving a guardrail dropped
    // `claudeBin` out of the cached prefs (and would now drop the MCP wait too). The route answers
    // with the keys it touched; everything else has to survive.
    if (STATE) STATE.prefs = Object.assign({}, STATE.prefs, { guardrails: r.guardrails, useCorrections: r.useCorrections, openPoints: r.openPoints, subagents: r.subagents || {}, mcpStartupWaitMs: r.mcpStartupWaitMs || 0, includeHookEvents: r.includeHookEvents === true, forwardSubagentText: r.forwardSubagentText !== false, ultracode: r.ultracode === true, planProgress: r.planProgress !== false, promptSnapshot: r.promptSnapshot === 'on' ? 'on' : 'off' });
    if (note && $('#guardNote')) { $('#guardNote').textContent = note; setTimeout(() => { if ($('#guardNote')) $('#guardNote').textContent = ''; }, 2500); }
    if (typeof renderStatusBar === 'function') renderStatusBar(); // the 🛡 chip may have appeared/vanished
    return r;
  } catch (e) { toast(e.message, 'err'); return null; }
}
// --- #34: the standing subagent policy (ui-prefs.json, same store as the guardrails) ---------------
// One painter and one collector, so the card can never show something the server would store
// differently. Saving goes through saveGuardPrefs, i.e. through the same normalising POST.
function paintSubagentPrefs(sa) {
  if (!$('#saAllow')) return;
  $('#saAllow').value = sa.allow === false ? '0' : '1';
  $('#saModel').value = sa.model || '';
  $('#saForce').checked = !!sa.force;
  $('#saConcurrent').value = sa.maxConcurrent || '';
  $('#saPerSession').value = sa.maxPerSession || '';
  $('#saDepth').value = sa.maxDepth || '';
  // the two stream switches live next to the policy but are their own prefs keys
  const pr = (STATE && STATE.prefs) || {};
  if ($('#saForward')) $('#saForward').checked = pr.forwardSubagentText !== false;
  if ($('#saHooks')) $('#saHooks').checked = pr.includeHookEvents === true;
  if ($('#saUltracode')) $('#saUltracode').checked = pr.ultracode === true;
  refreshSubagentNote();
  if (typeof refreshUltracodeNote === 'function') refreshUltracodeNote();
}
// Two states worth spelling out, because both look like a bug otherwise: „off" makes the other fields
// meaningless, and „erzwingen" without a concrete model does nothing at all (lib/pure drops it).
function refreshSubagentNote() {
  const note = $('#saNote'); if (!note) return;
  const off = $('#saAllow') && $('#saAllow').value === '0';
  const model = $('#saModel') ? $('#saModel').value : '';
  const force = $('#saForce');
  if (force) { force.disabled = !model || model === 'inherit' || off; if (force.disabled) force.checked = false; }
  ['#saModel', '#saConcurrent', '#saPerSession', '#saDepth'].forEach((s) => { if ($(s)) $(s).disabled = off; });
  note.textContent = off ? t('views.subagentenAusHinweis')
    : (model && model !== 'inherit' && force && force.checked) ? t('views.subagentenErzwungenHinweis') : '';
}
function collectSubagentPrefs() {
  const int = (sel) => { const n = parseInt(($(sel) && $(sel).value) || '', 10); return Number.isFinite(n) && n > 0 ? n : undefined; };
  const out = {};
  if ($('#saAllow').value === '0') { out.allow = false; return out; } // off means off — see lib/pure
  if ($('#saModel').value) out.model = $('#saModel').value;
  if ($('#saForce').checked) out.force = true;
  if (int('#saConcurrent')) out.maxConcurrent = int('#saConcurrent');
  if (int('#saPerSession')) out.maxPerSession = int('#saPerSession');
  if (int('#saDepth')) out.maxDepth = int('#saDepth');
  return out;
}
async function saveSubagentPrefs() {
  refreshSubagentNote();
  const r = await saveGuardPrefs({ subagents: collectSubagentPrefs() }, t('common.gespeichert'));
  // Repaint from the ANSWER: a ceiling typed out of range comes back clamped, and a field that keeps
  // showing the rejected number is a settings page that lies about what is in effect.
  if (r) paintSubagentPrefs(r.subagents || {});
}
// The two stream switches: their own keys, saved on their own, so a change here never rewrites the
// policy object next to them.
['#saForward', '#saHooks'].forEach((sel) => {
  const node = $(sel); if (!node) return;
  node.onchange = () => saveGuardPrefs(sel === '#saForward'
    ? { forwardSubagentText: $('#saForward').checked }
    : { includeHookEvents: $('#saHooks').checked }, t('views.giltAbNaechstemStart'));
});
['#saAllow', '#saModel', '#saForce', '#saConcurrent', '#saPerSession', '#saDepth'].forEach((sel) => {
  const node = $(sel); if (!node) return;
  // `change` (not `input`) on the number fields: saving on every keystroke would write "1" on the way
  // to "12" and the clamped answer would fight the cursor.
  node.onchange = saveSubagentPrefs;
});
// Ultracode as the default for new chats — its own key, like the two stream switches above. A running
// chat is NOT changed by this (that is the tab menu's live switch); the note below says so, because a
// global switch that silently leaves the open session alone is the kind of thing you only notice later.
if ($('#saUltracode')) {
  $('#saUltracode').onchange = async () => {
    await saveGuardPrefs({ ultracode: $('#saUltracode').checked }, t('views.giltAbNaechstemStart'));
    refreshUltracodeNote();
  };
}
// Says whether the CURRENT default model can do ultracode at all. Measured, not assumed: the route asks
// the CLI's own model list for `supportedEffortLevels` (xhigh is the requirement). Without this, ticking
// the box on a Haiku default would look like it worked — the CLI accepts the key and ignores it.
async function refreshUltracodeNote() {
  const note = $('#saUcNote'); if (!note) return;
  if (!$('#saUltracode') || !$('#saUltracode').checked) { note.textContent = ''; return; }
  const model = (typeof CHAT_DEFAULTS === 'object' && CHAT_DEFAULTS.model) || '';
  // The probe spawns claude.exe for the `initialize` handshake when its 60 s cache is cold — MEASURED at
  // 3.6 s even with the fake binary. A row that just stays blank for that long reads as broken, so it
  // says it is checking (the same „◌ prüfe…" idea the MCP tiles use).
  note.textContent = '◌ ' + t('views.ultracodePruefe');
  const name = model || t('views.ultracodeStandardmodell');
  try {
    const r = await api('/api/ultracode/support?model=' + encodeURIComponent(model));
    // the field may have been switched off again while we waited — then the note is not ours any more
    if (!$('#saUltracode') || !$('#saUltracode').checked) { note.textContent = ''; return; }
    if (r.supported === false) note.textContent = '⚠ ' + t('views.ultracodeModellKannNicht').replace('{m}', name);
    else if (r.source === 'cli') note.textContent = t('views.ultracodeModellKann').replace('{m}', name);
    else note.textContent = t('views.ultracodeUngeprueft');
  } catch { note.textContent = t('views.ultracodeUngeprueft'); } // a failed probe is „not checked", not „fine"
}

async function loadCorrections() {
  const box = $('#corrList'); if (!box) return;
  box.innerHTML = '<div class="loading">' + t('common.lade') + '</div>';
  try {
    const j = await api('/api/corrections');
    const list = (j.corrections || []).slice().reverse(); // newest first — that is the injection order
    box.innerHTML = '';
    if ($('#corrCount')) $('#corrCount').textContent = list.length ? t('views.korrekturenAnzahl').replace('{n}', list.length).replace('{i}', j.injected) : '';
    if (!list.length) { box.appendChild(el('div', 'empty-mini', t('views.keineKorrekturen'))); return; }
    list.forEach((c, i) => {
      const row = el('div', 'corr-item' + (i >= j.injected ? ' corr-stale' : ''));
      const txt = el('div', 'corr-text', c.text); row.appendChild(txt);
      const meta = el('div', 'corr-meta');
      meta.appendChild(el('span', null, relTime(c.at) + (c.origin ? ' · ' + c.origin : '')));
      // An entry past the cap must LOOK inactive — a stale rule that silently stopped applying while
      // still sitting in the list is worse than no list at all.
      if (i >= j.injected) meta.appendChild(el('span', 'corr-tag', t('views.korrekturNichtMehrAktiv')));
      const del = el('button', 'mini-btn', '🗑'); del.title = t('common.loeschen-2');
      del.onclick = async () => {
        if (!(await uiConfirm(t('views.korrekturLoeschenFrage'), { title: t('views.korrekturLoeschen'), danger: true, okLabel: t('common.loeschen-2') }))) return;
        try { await api('/api/corrections?id=' + encodeURIComponent(c.id), { method: 'DELETE' }); loadCorrections(); } catch (e) { toast(e.message, 'err'); }
      };
      meta.appendChild(del);
      row.appendChild(meta);
      box.appendChild(row);
    });
  } catch (e) { errorCard(box, e.message, loadCorrections); }
}
// --- Claude binary: the manual way out when auto-detection misses -----------------------------------
// The detection order itself lives in lib/paths (resolveClaudeBin); this field is step 2 of it. The
// note is the whole value of the field: which path is in effect, how it was found, what it answers to
// `--version`, and whether the running server still holds the old one.
let CLAUDE_BIN_STATE = null; // last known detection state, so a language switch can repaint the note
function repaintClaudeBinNote() { if (CLAUDE_BIN_STATE) paintClaudeBinNote(CLAUDE_BIN_STATE); }
function paintClaudeBinNote(info) {
  const el2 = $('#claudeBinNote');
  if (!el2) return;
  CLAUDE_BIN_STATE = info || null;
  el2.innerHTML = '';
  const i = info || {};
  const parts = [];
  parts.push((i.claudeBinExists === false ? t('views.binNichtGefunden') : t('views.binAktuell')) + (i.claudeBinResolved || '—'));
  if (i.claudeBinSource) parts.push(t('views.binQuelle') + i.claudeBinSource);
  // neutral wording on purpose: the probe proves what the FILE answers, and a wrong file answering
  // „26.7.0" must not read as „claude 26.7.0"
  if (i.claudeBinVersion) parts.push(t('views.binVersion') + i.claudeBinVersion);
  else if (i.claudeBinError) parts.push(t('views.binKeineAntwort') + i.claudeBinError);
  if (i.restartNeeded) parts.push(t('views.binNachNeustart'));
  el2.appendChild(document.createTextNode(parts.join(' · ') + ' '));
  el2.classList.toggle('bad', i.claudeBinExists === false);
  // a changed path only takes effect on the next start (CLAUDE_EXE is a require-time constant), so the
  // note carries the action instead of sending the user to the System view for it
  if (i.restartNeeded && typeof restartServer === 'function') {
    const b = el('button', 'ghost-btn', t('views.binJetztNeuStarten'));
    b.onclick = () => restartServer();
    el2.appendChild(b);
  }
}
// The ceiling for the first turn's MCP wait. Saved on `change`, and repainted from the ANSWER —
// the server clamps below 1 s and above 10 min, and a field that keeps showing the rejected number
// is a settings page that lies about what is in effect.
if ($('#qsMcpWait')) $('#qsMcpWait').onchange = async () => {
  const raw = $('#qsMcpWait').value.trim();
  const r = await saveGuardPrefs({ mcpStartupWaitMs: raw === '' ? 0 : Number(raw) }, t('common.gespeichert'));
  if (r) $('#qsMcpWait').value = r.mcpStartupWaitMs || '';
};
if ($('#qsClaudeBin')) $('#qsClaudeBin').onchange = async (e) => {
  try {
    const r = await api('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claudeBin: e.target.value }) });
    // A server process older than this field ignores the key and answers 200 without the bin block —
    // the note would then paint „Aktuell: —" over a path that was never stored. Name the real obstacle.
    if (r.claudeBinResolved === undefined) {
      toast(t('views.binServerVeraltet'), 'err');
      e.target.value = (STATE && STATE.prefs && STATE.prefs.claudeBin) || '';
      return;
    }
    if (STATE) STATE.prefs = Object.assign({}, STATE.prefs, { claudeBin: r.claudeBin || '' });
    e.target.value = r.claudeBin || ''; // server-side trim/unquote wins
    paintClaudeBinNote(r);
    toast(t('common.gespeichert'), r.claudeBinExists === false ? 'err' : 'ok');
  } catch (err) {
    toast(err.message, 'err'); // 400 = relative path / file not found, with the path in the message
    // nothing was stored → the field must not keep showing an override that does not exist
    e.target.value = (STATE && STATE.prefs && STATE.prefs.claudeBin) || '';
  }
};

if ($('#guardSave')) $('#guardSave').onclick = () => saveGuardPrefs({ guardrails: $('#qsGuardrails').value }, t('common.gespeichert'));
if ($('#qsUseCorrections')) $('#qsUseCorrections').onchange = (e) => saveGuardPrefs({ useCorrections: e.target.checked }, t('common.gespeichert'));
if ($('#qsOpenPoints')) $('#qsOpenPoints').onchange = (e) => saveGuardPrefs({ openPoints: e.target.checked }, t('common.gespeichert'));
// PF-1 — takes effect at once for the rail and for the next plan approval: STATE.prefs is what both read, and
// saveGuardPrefs ends in renderStatusBar → chatSideRefresh, whose signature includes the switch.
if ($('#qsPlanProgress')) $('#qsPlanProgress').onchange = (e) => saveGuardPrefs({ planProgress: e.target.checked }, t('common.gespeichert'));
// PR-S — the prompt snapshot. „Gilt ab dem nächsten Start" is exact here: a running process keeps what it
// was launched with, and the NEXT launch — a new chat or a resume — is where the choice takes effect.
if ($('#qsPromptSnapshot')) {
  $('#qsPromptSnapshot').onchange = async (e) => {
    await saveGuardPrefs({ promptSnapshot: e.target.value === 'on' ? 'on' : 'off' }, t('views.giltAbNaechstemStart'));
    paintPromptSnapshot(); // from the ANSWER (saveGuardPrefs merged it), so the select never shows an unsaved value
  };
}
// Repainted from STATE: the stored choice, and a note that says what it does on THIS machine — the flag is
// only passed when the installed CLI lists it in its --help (lib/cli.js), and „not proven" (null) is a
// different sentence from „not supported" (false), because only the second one is a fact about the CLI.
function paintPromptSnapshot() {
  const sel = $('#qsPromptSnapshot'); if (!sel) return;
  const pr = (STATE && STATE.prefs) || {};
  sel.value = pr.promptSnapshot === 'on' ? 'on' : 'off';
  const note = $('#snapNote'); if (!note) return;
  const flag = STATE ? STATE.promptSnapshotFlag : null;
  if (sel.value === 'on') note.textContent = t('views.promptSnapshotAnWirkung');
  else if (flag === true) note.textContent = '✓ ' + t('views.promptSnapshotFlagOk');
  else if (flag === false) note.textContent = '⚠ ' + t('views.promptSnapshotFlagFehlt');
  else note.textContent = t('views.promptSnapshotFlagUngeprueft');
}

// --- Info cards: about + live changelog ---
let INFO_LOADED = false;
async function loadInfo() {
  // about (from STATE)
  if (STATE) {
    $('#aboutHost').textContent = t('views.laeuftAuf1270') + location.port + '  ·  claude.exe: ' + (STATE.claudeExeExists ? t('views.gefunden') : t('views.nichtGefunden'));
  }
  renderConnDetail();
  if (INFO_LOADED) return; // changelog is static per session (↻ button re-fetches on demand)
  await loadChangelog();
}
// fetch + render the live git-log changelog. Cached per session via INFO_LOADED; the ↻ button forces a re-fetch.
async function loadChangelog() {
  try {
    const j = await api('/api/changelog');
    const list = $('#changelogList'); list.innerHTML = '';
    if (!j.commits || !j.commits.length) { list.innerHTML = '<div class="empty-mini">' + (j.error || t('views.keinGitVerlauf')) + '</div>'; return; }
    $('#clCount').textContent = j.commits.length + t('views.commits');
    let lastDay = '';
    j.commits.forEach((c) => {
      const day = (c.date || '').slice(0, 10);
      if (day !== lastDay) { list.appendChild(el('div', 'cl-day', day)); lastDay = day; }
      const row = el('div', 'cl-item');
      row.appendChild(el('span', 'cl-time', (c.date || '').slice(11)));
      row.appendChild(el('span', 'cl-hash', c.hash));
      row.appendChild(el('span', 'cl-subj', c.subject));
      list.appendChild(row);
    });
    if (STATE) $('#aboutVer').textContent = j.commits.length + t('views.commitsAktuell') + j.commits[0].hash + ' (' + j.commits[0].date + ')';
    INFO_LOADED = true;
  } catch (e) { const d = el('div', 'empty-mini', e.message); $('#changelogList').innerHTML = ''; $('#changelogList').appendChild(d); }
}
// ↻ refresh the changelog card on demand (git log may have advanced since the session started)
if ($('#clReload')) $('#clReload').onclick = () => { INFO_LOADED = false; $('#changelogList').innerHTML = '<div class="loading">' + t('html.ladeChangelog') + '</div>'; loadChangelog(); };
// live "Verbindung" card body — driven by the global CONN (updated by pingServer in boot.js)
function renderConnDetail() {
  const box = $('#connDetail'); if (!box) return;
  const c = (typeof CONN !== 'undefined') ? CONN : { ok: null };
  const up = (s) => { if (s == null) return '—'; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return (h ? h + 'h ' : '') + (h || m ? m + 'm ' : '') + sec + 's'; };
  const status = c.ok === true ? '<span class="conn-on">' + t('views.verbunden') + '</span>' : c.ok === false ? '<span class="conn-off">' + t('views.getrennt') + '</span>' : '<span class="conn-wait">' + t('views.wirdGeprueft') + '</span>';
  const rows = [
    [t('html.status'), status],
    [t('views.endpunkt'), '<span class="mono">127.0.0.1:' + location.port + '</span>'],
    [t('views.latenz'), (c.ok && c.latency != null) ? c.latency + ' ms' : '—'],
    [t('views.serverLaufzeit'), up(c.uptime)],
    [t('views.aktiveSessions'), c.chats != null ? String(c.chats) : '—'],
    [t('views.letzterKontakt'), c.lastOk ? new Date(c.lastOk).toLocaleTimeString() : '—'],
  ];
  box.innerHTML = rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');
}

// --- friendly controls: permissions + env ---
// The little ✕ that deletes a permission, an env variable or a hook. It used to be a <span> carrying
// an onclick: not focusable, no Enter/Space, and announced as nothing at all by a screen reader — for
// a control that WRITES settings.json. iconBtn gives a real <button> with an aria-label; the styling
// survives because the CSS selectors are class-based (.perm-chip .x / .env-row .x).
function removeX(label, onClick) {
  const b = iconBtn('x', 'close', { size: 12, title: label });
  b.onclick = onClick;
  return b;
}
// onRemove gets the chip's VALUE, not the list without it: the list is the browser's copy, and the
// server removes the value from the file as it is now (PATCH pull) — see patchSettingsFile
function renderChips(id, arr, onRemove) {
  const box = $('#' + id); box.innerHTML = '';
  if (!arr.length) box.appendChild(el('span', 'empty-mini', t('views.keine')));
  arr.forEach((v) => { const c = el('span', 'perm-chip'); c.appendChild(el('span', null, v)); c.appendChild(removeX(t('views.entfernen') + v, () => onRemove(v))); box.appendChild(c); });
}
// ---- every settings change outside the full-text editors (DATA-2) ----
// They all used to PUT the whole file, rebuilt from STATE — as old as the last load. Two actions in a
// row, or a rule the CLI granted in between, and the earlier change was gone. Now each one sends only
// what it changes ({ops}, lib/pure applySettingsOps) and the server merges that into the file on disk,
// under its lock. Resolves true/false so a caller can clear its input / mark its button only on success.
// What a refused write tells the user. `conflict` and `shape` are both 409 but mean different things:
// someone changed that entry meanwhile (try again) vs. the file holds another type there (a retry fails
// the same way — the server's text names the key).
function settWriteRefusal(code, f, msg) {
  if (code === 'unparsable') return t('views.settKaputtToast').replace('{file}', f.file);
  if (code === 'unreadable') return t('views.settUnlesbarToast').replace('{file}', f.file);
  if (code === 'conflict') return t('views.settKonflikt');
  if (code === 'shape') return t('views.settForm').replace('{file}', f.file).replace('{why}', msg);
  return msg;
}
async function patchSettingsFile(which, ops, okMsg) {
  const f = SETT_FILES[which];
  try {
    const r = await api(f.endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ops }) });
    applySettingsSnapshot(which, r.settings);
    renderFriendly();
    if (okMsg) toast(okMsg, 'ok');
    return true;
  } catch (e) {
    const d = e.data || {};
    // a refused write still says what the file holds now → show that, not the browser's guess
    if (d.settings) applySettingsSnapshot(which, d.settings);
    renderFriendly(); // also puts a toggled checkbox / select back to what is really stored
    toast(settWriteRefusal(d.code, f, e.message), 'err');
    return false;
  }
}
// permissions.allow / .deny in settings.local.json — also used by the chat's "always allow" buttons
function localPermAdd(which, rule) {
  return patchSettingsFile('local', [{ op: 'push', path: ['permissions', which], value: rule }], t('views.berechtigungenGespeichert'));
}
function localPermRemove(which, rule) {
  return patchSettingsFile('local', [{ op: 'pull', path: ['permissions', which], value: rule }], t('views.berechtigungenGespeichert'));
}
// clear an input after a successful save — unless it was edited again while the save ran (UX-6)
function clearIfUnchanged(sel, was) { const i = $(sel); if (i && i.value.trim() === was) i.value = ''; }
// curated, real Claude Code settings (settings.json) with descriptions + control type.
// Functions, not load-time consts: the t() labels must re-resolve on a live language switch
// (reloadActiveView re-renders the view, but a const would keep the boot language forever).
// PR-11 — grown from TWO entries to the list below, and every key in it is PROVEN. The source is the
// settings schema in claude.exe 2.1.288: ONE object literal at offset 204 644 191, 69 118 bytes, walked with
// depth tracking (strings, parens and regex literals skipped) — 182 top-level keys, no duplicates. Scripts
// and output in C:/Users/you/ccui-ctxprobe/ (bin-settings4.js → settings-keys-toplevel.json for the
// names, bin-settings6/7.js for the type, the enum values and each key's OWN describe text).
//
// THREE THINGS THAT WENT WRONG WHILE EXTRACTING THIS, because they are the reason to trust the list:
//  1. a naive `key:()=>` regex without depth tracking finds 187 keys and INVENTS three — `shape` and
//     `permissionsShape` (zod helper names inside the nested `autoMode` object, which borrow their
//     neighbours' describe texts) and `xaaIdp` (outside the block). A catalog entry for a key the CLI does
//     not know is worse than a gap, so the depth walk is a precondition, not diligence.
//  2. the first describe extraction took the first `.describe(` after a key and gave `statusLine` the text
//     of its own `refreshInterval` SUBFIELD („Re-run the status line command every N seconds"). Each text
//     below is the one at the key's own nesting level — and `spellcheck` and `voice`, which read like
//     booleans, turned out to be OBJECTS that way and are therefore NOT in this list.
//  3. „182" is a LOWER BOUND, not a count: ten top-level spreads (nine `...!1`, i.e. feature-flagged groups
//     compiled to false, one env-driven, one generated) hide further keys. A literal proves what stands
//     there, not what the CLI accepts — so nothing here claims to be complete.
//
// `def` is THREE-valued on purpose: true/false where the CLI's own text states the default, and null where
// it does not. A checkbox that shows „off" for a key whose default nobody stated would be this project's
// failure class in miniature — so null renders INDETERMINATE and the row says „Standard unbekannt".
// `werte` makes a row a SELECT, and those value lists are the enum literals out of the same schema (or, for
// some of them, a variable the schema points at, resolved in the binary: `jQr` = editorMode, `X7o` =
// teammateMode). An enum whose values could NOT be resolved is not in this list at all — `maxEffortLevel`
// points at `lu`, a two-letter name that IS resolvable (`["low","medium","high","xhigh","max"]`) but is
// re-used several times in the bundle, so it was not adopted. Worth stating precisely, because „not
// findable" and „findable but ambiguous" are different claims: the first was wrong. The effect is the safe
// direction either way — a missing row is a gap, an invented one is a key the user writes for nothing.
const SETTINGS_CATALOG = () => [
  // --- commits / git ---
  { key: 'attribution', type: 'bool', def: null, label: t('views.catAttribution'), desc: t('views.catAttributionDesc') },
  { key: 'includeCoAuthoredBy', type: 'bool', def: true, veraltet: 'attribution', label: t('views.coAuthoredByIn'), desc: t('views.fuegtDieCoAuthored') },
  { key: 'includeGitInstructions', type: 'bool', def: true, label: t('views.catGitInstructions'), desc: t('views.catGitInstructionsDesc') },
  // --- context / turns ---
  { key: 'cleanupPeriodDays', type: 'number', def: 30, label: t('views.transkriptAufbewahrungTage'), desc: t('views.wieLangeChatTranskripte') },
  { key: 'autoCompactEnabled', type: 'bool', def: null, label: t('views.catAutoCompact'), desc: t('views.catAutoCompactDesc') },
  { key: 'alwaysThinkingEnabled', type: 'bool', def: true, label: t('views.catThinking'), desc: t('views.catThinkingDesc') },
  // `effortLevel` is NOT here, and `theme` is not down in the editor/display block either — see the note on
  // the quick settings at the end of this list.
  // --- workflows / ultracode ---
  { key: 'enableWorkflows', type: 'bool', def: null, label: t('views.catWorkflows'), desc: t('views.catWorkflowsDesc') },
  { key: 'workflowSizeGuideline', type: 'select', werte: ['unrestricted', 'small', 'medium', 'large'], label: t('views.catWorkflowSize'), desc: t('views.catWorkflowSizeDesc') },
  // „nur Terminal" — and this marking is REASONED FROM THE CODE, not measured, which is why it says so in
  // the chip's tooltip. The keyword branch is gated on `isHumanTypedPrompt`
  // (`S?.isHumanTypedPrompt && !S.suppressWorkflowKeyword && ZWt() ? … : []`, claude.exe 2.1.288
  // @215212645), and that flag is set only in the interactive REPL path (`isHumanTypedPrompt: Re` beside
  // `setAppState`/`sessionScratch`, @220184054). The panel sends `{type:'user',message:{role:'user',content}}`
  // over stdin with no `origin` (lib/chat.js sendToChat), so nothing sets the flag for it. The setting is
  // real and worth offering — it just cannot change anything about a turn sent from here.
  { key: 'workflowKeywordTriggerEnabled', type: 'bool', def: true, nurTerminal: true, label: t('views.catWorkflowKeyword'), desc: t('views.catWorkflowKeywordDesc') },
  // --- hooks / MCP ---
  { key: 'disableAllHooks', type: 'bool', def: null, label: t('views.catDisableHooks'), desc: t('views.catDisableHooksDesc') },
  { key: 'enableAllProjectMcpServers', type: 'bool', def: null, label: t('views.catProjectMcp'), desc: t('views.catProjectMcpDesc') },
  // --- editor / display (all of these are terminal-side; the panel has its own theme switch) ---
  { key: 'editorMode', type: 'select', werte: ['normal', 'vim'], nurTerminal: true, label: t('views.catEditorMode'), desc: t('views.catEditorModeDesc') },
  { key: 'viewMode', type: 'select', werte: ['default', 'verbose', 'focus'], nurTerminal: true, label: t('views.catViewMode'), desc: t('views.catViewModeDesc') },
  { key: 'verbose', type: 'bool', def: null, label: t('views.catVerbose'), desc: t('views.catVerboseDesc') },
  { key: 'maxProseWidth', type: 'number', def: null, min: 40, label: t('views.catProseWidth'), desc: t('views.catProseWidthDesc') },
  // --- shell / tools ---
  { key: 'defaultShell', type: 'select', werte: ['bash', 'powershell'], label: t('views.catShell'), desc: t('views.catShellDesc') },
  { key: 'bashOutputMaxChars', type: 'number', def: 30000, label: t('views.catBashOut'), desc: t('views.catBashOutDesc') },
  { key: 'fileCheckpointingEnabled', type: 'bool', def: null, label: t('views.catCheckpoint'), desc: t('views.catCheckpointDesc') },
  { key: 'respectGitignore', type: 'bool', def: true, label: t('views.catGitignore'), desc: t('views.catGitignoreDesc') },
  // --- updates ---
  { key: 'autoUpdatesChannel', type: 'select', werte: ['latest', 'stable', 'rc'], label: t('views.catChannel'), desc: t('views.catChannelDesc') },
  // TWO KEYS ARE DELIBERATELY ABSENT, and they were in here until the review: `theme` and `effortLevel`.
  // The SAME settings view already has a live control for each in the Schnelleinstellungen card above
  // (#qsTheme, #qsEffort — index.html, both writing through patchMain), so a catalog row for them is a second
  // control for one key on one page. That is the exact reason `includeCoAuthoredBy`, `cleanupPeriodDays` and
  // `enableAllProjectMcpServers` were taken OUT of SETTINGS_REF in this same PR („zwei Bedienelemente für
  // einen Key, die sich über seinen Zustand widersprechen können") — and they can: the quick settings only
  // edit the TEXTAREA, the catalog saves immediately, and applySettingsSnapshot skips paintQuickSettings
  // while the editor is dirty. The visible failure was sharper still: the two value ranges differed (theme
  // auto/dark/light up there against the schema's seven here), so setting `theme` to „dark-ansi" from the
  // catalog left `$('#qsTheme').value = 'dark-ansi'` with no matching option — selectedIndex -1, and the
  // dropdown above went BLANK, saying nothing at all about the value in the file.
  // `theme` keeps its SETTINGS_REF row, which is where its values beyond the quick list live (incl.
  // „custom:<name>"); `effortLevel`'s whole enum is already on offer up there.
];
// Broader reference of documented settings keys (insert into the JSON editor to edit). This is where the
// keys live whose VALUE is an object, an array or free text — a switch cannot offer those, and a half-built
// control for a nested shape would write invalid settings. Same proof as SETTINGS_CATALOG above: every key
// is in the 182 of the schema literal, and the description follows the key's OWN describe text.
// One existing row was CHECKED and left alone, which is worth a line because the check nearly went the
// other way: `statusLine`'s „eigene Statuszeile aus einem Kommando" matches the key's OWN describe
// („Custom status line display configuration", and the object does require type: 'command'). The first
// extraction offered „Re-run the status line command every N seconds" for it — that is the text of its
// `refreshInterval` SUBFIELD, and adopting it would have replaced a correct description with a wrong one
// while looking like a measurement-backed fix. See the note in SETTINGS_CATALOG.
const SETTINGS_REF = () => [
  { key: 'model', file: 'main', desc: t('views.standardmodellFuerNeueSessions'), example: 'claude-sonnet-5' },
  { key: 'theme', file: 'main', desc: t('views.uiThemeDerCli'), example: 'dark' },
  { key: 'outputStyle', file: 'main', desc: t('views.aktiverOutputStyleName'), example: 'Explanatory' },
  // `includeCoAuthoredBy`, `cleanupPeriodDays` and `enableAllProjectMcpServers` used to be here AS WELL as
  // in SETTINGS_CATALOG above. Since PR-11 they have a real control up there (switch / number field, saves
  // immediately), and offering the same key a second time as an „insert into the JSON editor" template is
  // two controls for one setting that can disagree about its state. They are gone from this list.
  // `attribution` stays in BOTH on purpose, and only because its value space is bigger than its control: it
  // is a union of a boolean and a per-channel object, so the switch above covers the boolean arm and this
  // list inserts the object one. (`theme` used to be the second such pair. It is no longer in
  // SETTINGS_CATALOG at all — the quick settings own that key, see the note at the end of that list — so its
  // row here is now the ONLY place its remaining values, including „custom:<name>", can be reached.)
  { key: 'env', file: 'main', desc: t('views.umgebungsvariablenDieInJede'), example: { KEY: 'value' } },
  { key: 'apiKeyHelper', file: 'main', desc: t('views.skriptKommandoDasEinen'), example: '/bin/generate_token.sh' },
  { key: 'statusLine', file: 'main', desc: t('views.eigeneStatuszeileAusEinem'), example: { type: 'command', command: '~/.claude/statusline.sh' } },
  { key: 'hooks', file: 'main', desc: t('views.automatischeKommandosBeiEvents'), example: {} },
  { key: 'permissions', file: 'local', desc: t('views.berechtigungenAllowDenyAsk'), example: { allow: [], deny: [], defaultMode: 'default' } },
  // --- PR-11, the object/array/free-text keys (proven in the schema literal, see SETTINGS_CATALOG) ---
  // `attribution` is a UNION of a boolean and this object (`Fe([M(), i])` in the schema): the switch above
  // writes the boolean arm, this inserts the per-channel one. An empty string hides the attribution.
  { key: 'attribution', file: 'main', desc: t('views.refAttribution'), example: { commit: '', pr: '' } },
  { key: 'fallbackModel', file: 'main', desc: t('views.refFallbackModel'), example: ['claude-sonnet-5'] },
  // the example carries a REAL subfield of this object (`symlinkDirectories`, an array of strings) with the
  // value the CLI's own text names as the common case. A first draft here invented `{ include: [] }` — a key
  // the schema does not have, i.e. exactly the „catalog entry for something nobody confirmed" this list is
  // supposed not to contain. The object also has sparsePaths · baseRef · bgIsolation · location.
  { key: 'worktree', file: 'main', desc: t('views.refWorktree'), example: { symlinkDirectories: ['node_modules'] } },
  { key: 'plansDirectory', file: 'main', desc: t('views.refPlansDir'), example: '.claude/plans' },
  { key: 'autoMemoryDirectory', file: 'main', desc: t('views.refMemoryDir'), example: '~/.claude/memory' },
  { key: 'skillListingMaxDescChars', file: 'main', desc: t('views.refSkillListing'), example: 1536 },
  { key: 'disableBundledSkills', file: 'main', desc: t('views.refBundledSkills'), example: true },
  { key: 'syncClaudeAiSkills', file: 'main', desc: t('views.refSyncSkills'), example: false },
  { key: 'timeZone', file: 'main', desc: t('views.refTimeZone'), example: 'Europe/Berlin' },
];
function patchSetting(key, val) {
  const op = (val === null || val === '') ? { op: 'delete', path: [key] } : { op: 'set', path: [key], value: val };
  return patchSettingsFile('main', [op], t('views.gespeichert'));
}
function renderMoreSettings() {
  const s = (STATE.settings || {}).parsed || {};
  const box = $('#moreSettings'); if (!box) return; box.innerHTML = '';
  SETTINGS_CATALOG().forEach((c) => {
    const row = el('div', 'setting-row');
    const info = el('div', 'sr-info');
    const head = el('div', 'sr-label'); head.appendChild(el('span', null, c.label));
    head.appendChild(el('code', 'sr-key', c.key));   // the key itself, so the row is searchable by what it writes
    // „nur Terminal": the setting is real and is saved, but a turn sent from this panel cannot be affected
    // by it. The tooltip says WHY and that the reason is read from the code rather than measured — the
    // distinction this project pays for when it is skipped.
    if (c.nurTerminal) { const ch = el('span', 'sr-chip', t('views.catNurTerminal')); ch.title = t('views.catNurTerminalWarum'); head.appendChild(ch); }
    // a deprecated key keeps its control (it still works and still defaults to true) and names its successor
    if (c.veraltet) { const ch = el('span', 'sr-chip sr-old', t('views.catVeraltet') + c.veraltet); ch.title = t('views.catVeraltetWarum').replace('{neu}', c.veraltet); head.appendChild(ch); }
    info.appendChild(head);
    info.appendChild(el('div', 'sr-desc', c.desc));
    row.appendChild(info);
    const has = Object.prototype.hasOwnProperty.call(s, c.key);
    if (c.type === 'bool') {
      const cb = el('input'); cb.type = 'checkbox';
      // FOUR states, and which one it is comes from public/js/settings-catalog.js so a test can reach the
      // decision without a DOM: the key is set to a boolean (show it) · it is not set and the CLI states its
      // default (show that, labelled „Standard") · it is not set and NOBODY stated a default (indeterminate,
      // labelled „Standard unbekannt") · the key IS set, to something that is not a boolean at all.
      // That last one is `attribution`, whose schema is a union of a boolean and a per-channel object, and
      // it is the mirror of the ⚠ option the select branch builds below — same remedy, not a second one:
      // show it, keep it, and do not let a click write a boolean over it. Without this the box read „AN" for
      // `{ commit: '', pr: '' }`, i.e. for the value that switches attribution OFF, and one click deleted
      // the per-channel configuration. See the comment in settings-catalog.js for the CLI's own wording.
      const st = settingsBoolState(c, s);
      cb.checked = st.haken;
      if (st.unbestimmt) cb.indeterminate = true;
      if (st.fremd) {
        cb.disabled = true;
        // the row says what IS there and where to edit it — the reference list below has an „einfügen"
        // template for exactly this key, which is also how the state gets here in the first place
        info.appendChild(el('div', 'sr-desc sr-fremd', t('views.catFremdeForm')));
      } else {
        cb.onchange = () => patchSetting(c.key, cb.checked);
      }
      const lab = el('label', 'sr-toggle'); lab.appendChild(cb);
      lab.appendChild(el('span', 'sr-state', st.fremd ? '⚠' : (st.standard ? t('views.standard') : (st.unbestimmt ? t('views.standardUnbekannt') : ''))));
      row.appendChild(lab);
    } else if (c.type === 'select') {
      // A key that only accepts certain values gets the list of them — and that list is the enum out of the
      // CLI's own schema, never a hand-written one (see SETTINGS_CATALOG). The empty entry DELETES the key,
      // which is not the same as any of its values: „unset" is its own state, and for several of these keys
      // the CLI's default is explicitly „depends" (enableWorkflows: „Unset = default by plan").
      const selEl = el('select', 'sr-sel');
      const none = el('option', null, t('html.nichtGesetzt')); none.value = ''; selEl.appendChild(none);
      (c.werte || []).forEach((v) => { const o = el('option', null, v); o.value = v; selEl.appendChild(o); });
      // a value the CLI schema does not list (hand-written into the JSON editor, or a newer CLI) is SHOWN
      // instead of silently falling back to „(nicht gesetzt)" — that would misreport the file's content
      const cur = has ? String(s[c.key]) : '';
      if (cur && !(c.werte || []).includes(cur)) { const o = el('option', null, cur + ' ⚠'); o.value = cur; selEl.appendChild(o); }
      selEl.value = cur;
      selEl.onchange = () => patchSetting(c.key, selEl.value === '' ? null : selEl.value);
      row.appendChild(selEl);
    } else {
      const inp = el('input', 'sr-num'); inp.type = 'number'; inp.value = has ? s[c.key] : '';
      // the placeholder is the DEFAULT, so an empty field is not mistaken for „0" — and it stays empty when
      // the CLI states no default, rather than printing „null"
      if (c.def != null) inp.placeholder = String(c.def);
      if (c.min != null) inp.min = String(c.min);
      inp.onchange = () => patchSetting(c.key, inp.value === '' ? null : Number(inp.value));
      row.appendChild(inp);
    }
    box.appendChild(row);
  });
}
function renderCatalog() {
  const box = $('#catList'); if (!box) return; box.innerHTML = '';
  const q = ($('#catSearch') && $('#catSearch').value || '').toLowerCase();
  const mainKeys = (STATE.settings || {}).parsed || {}, localKeys = (STATE.settingsLocal || {}).parsed || {};
  const hits = SETTINGS_REF().filter((r) => !q || (r.key + ' ' + r.desc).toLowerCase().includes(q));
  // CAT-EMPTY — a search with no hits emptied the list and said nothing: a blank panel under a search box
  // with your own text still in it, which reads as „broken" rather than as „no match". emptyFiltered()
  // exists for exactly this (B12) and brings the way out with it — the reset also clears the field, because
  // the field IS the filter here and leaving it full would contradict the list it no longer describes.
  if (!hits.length) {
    emptyFiltered(box, () => { const f = $('#catSearch'); if (f) f.value = ''; renderCatalog(); },
      q ? t('views.katalogKeinTreffer').replace('{q}', q) : t('views.katalogLeer'));
    return;
  }
  hits.forEach((r) => {
    const present = Object.prototype.hasOwnProperty.call(r.file === 'local' ? localKeys : mainKeys, r.key);
    const it = el('div', 'cat-item');
    const info = el('div', 'cat-info');
    const top = el('div', 'cat-top');
    top.appendChild(el('span', 'cat-key', r.key));
    top.appendChild(el('span', 'cat-file ' + r.file, r.file === 'local' ? 'settings.local' : 'settings.json'));
    if (present) top.appendChild(el('span', 'cat-present', t('views.gesetzt')));
    info.appendChild(top);
    info.appendChild(el('div', 'cat-desc', r.desc));
    it.appendChild(info);
    const btn = iconBtn('mini-btn', present ? 'download' : 'plus', { size: 13, label: present ? t('views.zeigen') : t('views.einfuegen') });
    btn.onclick = () => insertSetting(r);
    it.appendChild(btn);
    box.appendChild(it);
  });
}
function insertSetting(r) {
  const editorId = r.file === 'local' ? 'editLocal' : 'editMain';
  let obj; try { obj = JSON.parse($('#' + editorId).value || '{}'); } catch { toast(t('views.jsonErstKorrigieren'), 'err'); return; }
  if (!Object.prototype.hasOwnProperty.call(obj, r.key)) obj[r.key] = r.example;
  $('#' + editorId).value = JSON.stringify(obj, null, 2);
  validate(editorId, editorId === 'editMain' ? 'validMain' : 'validLocal');
  refreshDirty();
  // scroll to + focus the editor, select the inserted key
  const ta = $('#' + editorId); ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const idx = ta.value.indexOf('"' + r.key + '"');
  if (idx >= 0) { ta.focus(); try { ta.setSelectionRange(idx, idx + r.key.length + 2); } catch {} }
  toast(r.key + t('views.eingefuegtPruefenSpeichern'), 'ok');
}
function renderFriendly() {
  const perms = (((STATE.settingsLocal || {}).parsed || {}).permissions) || {};
  $('#permDefaultMode').value = perms.defaultMode || '';
  renderMoreSettings();
  renderCatalog();
  renderChips('allowList', perms.allow || [], (v) => localPermRemove('allow', v));
  renderChips('denyList', perms.deny || [], (v) => localPermRemove('deny', v));
  const env = (((STATE.settings || {}).parsed || {}).env) || {};
  const box = $('#envList'); box.innerHTML = '';
  const keys = Object.keys(env);
  if (!keys.length) box.appendChild(el('span', 'empty-mini', t('views.keine')));
  keys.forEach((k) => { const row = el('div', 'env-row'); row.appendChild(Object.assign(el('span', 'env-kv'), { textContent: k + ' = ' + env[k] })); row.appendChild(removeX(t('views.entfernen') + k, () => saveEnv(k, null))); box.appendChild(row); });
  renderHooks();
}
function renderHooks() {
  const hooks = (((STATE.settings || {}).parsed || {}).hooks) || {};
  const box = $('#hookList'); box.innerHTML = ''; let any = false;
  Object.keys(hooks).forEach((ev) => {
    (hooks[ev] || []).forEach((entry, ei) => {
      (entry.hooks || []).forEach((h, hi) => {
        any = true;
        const row = el('div', 'env-row');
        row.appendChild(Object.assign(el('span', 'env-kv'), { textContent: ev + '  [' + (entry.matcher || '*') + ']  →  ' + (h.command || h.type || '') }));
        row.appendChild(removeX(t('views.entfernen') + ev + ' ' + (entry.matcher || '*'), () => removeHook(ev, entry, hi)));
        box.appendChild(row);
      });
    });
  });
  if (!any) box.appendChild(el('span', 'empty-mini', t('views.keineHooksKonfiguriert')));
  renderHookEvents();
  // …and ask the CLI if we have not asked THIS session yet. Fire-and-forget: it returns at once when the
  // answer is already cached (or no session exists), so this cannot loop back into the render.
  loadHookCatalog();
}

// ---- PR-11: the hook EVENT catalog, read from the CLI instead of hard-coded -------------------------
// The editor offered nine `<option>` elements and claimed „Matcher gilt für PreToolUse/PostToolUse; für
// andere Events leer lassen". MEASURED 2026-10-03: the CLI knows 33 events and says PER EVENT whether its
// hooks take a matcher — 23 of the 33 do. Seven of the nine on offer take one, five of those seven being
// events the hint denied, while `Stop` (for which it suggested `*`) takes none. The counts are asserted
// against the stored catalog in test/hooks-catalog.test.js, not quoted: this comment named 22 instead of 23
// and passed the five denied events off as the total of the nine, until the review counted them. See
// public/js/hooks-catalog.js for the measurement and for why the fallback must be labelled.
//
// THE ONE DESIGN DECISION THE MEASUREMENT DOES NOT MAKE: `get_hooks_listing` is a CONTROL request, so it
// needs a running session — and this editor is session-free. Resolved as „both, and say which": the catalog
// is read from any running chat when there is one, and from the nine known names when there is not, and in
// the second case the note under the field says it was not read and the matcher column says „unbekannt"
// rather than guessing a yes or a no. That last part is the point: a silent fallback that LOOKS like a
// reading is how the wrong matcher rule survived in the first place.
let HOOK_LISTING = null;      // what the CLI answered · null = not read (no session, or no answer)
let HOOK_LISTING_FOR = '';    // the chat it was asked of — a different/restarted session is asked again
let HOOK_LISTING_BUSY = false; // one read in flight at a time (see loadHookCatalog)
// Any STARTED, non-exited tab will do: `eventCatalog` is a property of the BINARY and `hooks`/`policy` of
// the settings files, so neither depends on which conversation asks. Reading from the active tab only would
// make the catalog disappear whenever the user happens to stand in a fresh, unstarted tab.
function hookChatId() {
  const tabs = (typeof TABS !== 'undefined' && Array.isArray(TABS)) ? TABS : [];
  const tb = tabs.find((x) => x && x.id && !x._exited);
  return tb ? tb.id : '';
}
// Asked at most ONCE per session id, and never recursively: this is called FROM the render path
// (renderHooks), so it must return without rendering when there is nothing new to fetch — otherwise
// render → load → render is a loop. The answer is a property of the binary and of the settings files, both
// of which this panel is the one changing, so a per-render read would be traffic for an answer that cannot
// have moved.
//
// WHY IT IS CALLED FROM THE RENDER PATH AT ALL, and not only from loadSettings: found in the sight check.
// `loadSettings` early-returns on its `viewOnce` guard, and the panel loads the settings view once at boot —
// i.e. BEFORE any chat exists. The first (and only) read therefore found no session, and the editor kept
// showing its labelled fallback for the rest of the browser session even after a chat had started. Honest,
// but needlessly so.
// A FAILED read marks the id as well: a session that times out or does not know the control is not asked
// again on every repaint. The way back is the view's own ↻ (loadSettings(force) clears the mark), which is
// the same shape ctx.js uses for „this process cannot answer" — remember it, and let an explicit action
// re-arm it.
async function loadHookCatalog() {
  const id = hookChatId();
  if (!id) {
    // no session to ask → the fallback. Only repaint when something actually changes, since this runs from
    // the render path.
    if (HOOK_LISTING || HOOK_LISTING_FOR) { HOOK_LISTING = null; HOOK_LISTING_FOR = ''; renderHookEvents(); }
    return;
  }
  if (HOOK_LISTING_FOR === id || HOOK_LISTING_BUSY) return;
  HOOK_LISTING_BUSY = true;
  try {
    const r = await api('/api/chat/' + id + '/hooks');
    // `unconfirmed` = the CLI did not answer (a timeout, or a binary without this control). That is NOT an
    // empty catalog: it goes to the labelled fallback, exactly like „no session at all".
    HOOK_LISTING = (r && r.ok && !r.unconfirmed) ? r : null;
  } catch { HOOK_LISTING = null; }
  HOOK_LISTING_FOR = id;       // asked — answered or not (see above)
  HOOK_LISTING_BUSY = false;
  renderHookEvents();
}
function renderHookEvents() {
  const sel = $('#hookEvent'); if (!sel) return;
  const rows = hookEventRows(HOOK_LISTING);
  const keep = sel.value;
  sel.innerHTML = '';
  rows.forEach((r) => {
    const o = el('option', null, r.name + (r.hookCount ? '  · ' + r.hookCount : ''));
    o.value = r.name;
    // the CLI's own one-line summary, verbatim — the same rule the context tooltip follows for
    // `autocompactSource`: it is the CLI's sentence, and translating 33 of them would invent meanings and
    // go stale at the next release. The column HEADINGS are i18n keys; this text is data.
    if (r.summary) o.title = r.summary;
    sel.appendChild(o);
  });
  // keep the user's choice across a re-render, unless that event is no longer offered
  if (keep && rows.some((r) => r.name === keep)) sel.value = keep;
  paintHookEventNote();
  renderHookPolicy();
}
// The note under the field, and the matcher input's own state — ONE function, so the two can never say
// different things about one event (they were one hard-coded sentence before, and it was wrong).
function paintHookEventNote() {
  const sel = $('#hookEvent'), note = $('#hookEventNote'), mi = $('#hookMatcher');
  if (!sel || !note) return;
  const rows = hookEventRows(HOOK_LISTING);
  const row = hookEventRow(rows, sel.value);
  const st = hookMatcherState(row);
  note.innerHTML = '';
  // where the list comes from — first, because it qualifies everything after it
  note.appendChild(el('span', rows.length && rows[0].gelesen ? 'hk-read' : 'hk-guess',
    (rows.length && rows[0].gelesen)
      ? t('views.hookEventsGelesen').replace('{n}', String(rows.length))
      : t('views.hookEventsNichtGelesen').replace('{n}', String(rows.length))));
  // …then what that means for the matcher field of the event SELECTED right now
  note.appendChild(el('span', null, ' · ' + t('views.hookMatcher' + (st === 'ja' ? 'Ja' : st === 'nein' ? 'Nein' : 'Unbekannt'))));
  if (row && row.summary) note.appendChild(el('span', 'hk-sum', ' · ' + row.summary));
  if (mi) {
    // A field that cannot be used is DISABLED and says why, instead of silently accepting a value the CLI
    // will ignore. „unbekannt" leaves it usable: refusing input on a guess would be the same overreach as
    // the old sentence, just in the other direction.
    mi.disabled = (st === 'nein');
    mi.title = t('views.hookMatcher' + (st === 'ja' ? 'Ja' : st === 'nein' ? 'Nein' : 'Unbekannt'));
    if (st === 'nein') mi.value = '';
  }
}
// What the CLI says is IN FORCE — including the hooks this panel cannot see at all (plugin and managed
// ones), with where each comes from, and whether an administrator switched them off. Read-only on purpose:
// the panel can only write the files it owns, and offering a ✕ on a managed or plugin hook would promise a
// deletion it cannot perform.
function renderHookPolicy() {
  const box = $('#hookEffective'); if (!box) return;
  box.innerHTML = '';
  if (!HOOK_LISTING) return;
  const pol = HOOK_LISTING.policy || {};
  // FIVE policy flags, not four: `policyUnreadable` is the one the CLI spreads in conditionally, and it is the
  // one that matters most — „what the organization configured is unknown", so what will actually run here is
  // unknown too. It was missing while the heading below said „Wirksam".
  const flags = ['allDisabled', 'disabledByPolicy', 'managedOnly', 'pluginOnly', 'policyUnreadable'].filter((k) => pol[k] === true);
  if (flags.length) {
    const w = el('p', 'hint hk-policy', '⚠ ' + flags.map((k) => t('views.hookPolicy' + k.charAt(0).toUpperCase() + k.slice(1))).join(' · '));
    box.appendChild(w);
  }
  // THE SESSION MODES, which the first version of this panel never asked for. They do not restrict what the
  // panel may WRITE — it edits settings.json as a file and never calls the CLI's `edit_hook` control, so
  // locking the form here would claim an inability the panel does not have. What they do say is that the
  // hooks listed below (and the ones the form adds) DO NOT FIRE in this session, which is the opposite of
  // what the heading promises — so it is said, with the CLI's own way out appended verbatim.
  // `managedHooksStillApply` is a MANDATORY boolean of the safeMode object, and it exists because the answer
  // „nothing here runs" would otherwise be wrong: the CLI says with this very field that MANAGED hooks keep
  // firing. Carrying it to the browser and reading it nowhere, while the line above it claims the absolute,
  // is the same rule this round broke `editable` for — one field further on. So the qualifier is rendered.
  const mode = (key, m, qualifier) => {
    if (!m) return;
    const extra = (qualifier && m[qualifier] === true) ? ' ' + t('views.hookVerwalteteLaufenWeiter') : '';
    const p = el('p', 'hint hk-policy', '⚠ ' + t(key) + extra + (m.exitHint ? ' · ' + m.exitHint : ''));
    box.appendChild(p);
  };
  mode('views.hookBareMode', HOOK_LISTING.bareMode);
  mode('views.hookSafeMode', HOOK_LISTING.safeMode, 'managedHooksStillApply');
  // …and the settings files the merge SKIPPED: their hooks are „neither listed nor running", so neither this
  // list nor the panel's own one above can show them. The file name is the CLI's own string.
  (HOOK_LISTING.errors || []).forEach((e) => {
    box.appendChild(el('p', 'hint hk-policy', '⚠ ' + t('views.hookDateiFehler').replace('{f}', e.file || '?') + (e.message ? ' · ' + e.message : '')));
  });
  // The rows the panel's own list above cannot show: everything not out of ~/.claude/settings.json. SPLIT by
  // `disabled`, because „listed" is not „in force" — a row the CLI marked disabled under a heading that says
  // „Wirksam" is this project's failure class with the evidence already in hand.
  const fremd = (HOOK_LISTING.hooks || []).filter((h) => h && h.source && h.source !== 'userSettings');
  const hookRow = (h) => {
    const row = el('div', 'env-row hk-foreign' + (h.disabled ? ' hk-off' : ''));
    // The matcher is printed only when there IS one. The list above (the panel's own settings file) fills an
    // empty matcher with „*", which is a reasonable shorthand for a rule the user wrote — but here it would
    // claim a wildcard the CLI did not report, on events that take no matcher at all (measured: `Stop`,
    // `UserPromptSubmit` and eight more). Seen in the sight check as „SessionStart [*]".
    row.appendChild(Object.assign(el('span', 'env-kv'), {
      textContent: h.event + (h.matcher ? '  [' + h.matcher + ']' : '') + '  →  ' + (h.text || h.type || ''),
    }));
    // `sourceLabel` is the CLI's own wording for the origin („User settings (~/.claude/settings.json)",
    // „Plugin (name)") — verbatim, because it names a file path this panel must not paraphrase.
    // The two qualifiers that make „Wirksam" too strong for a row the CLI did NOT mark disabled: an
    // if-condition (the hook fires only while it holds) and runsOnce (it may already have had its one turn).
    // A remark on the row, not a third heading, because they do not say „does not run" — they say „not
    // always", and a heading could not carry the condition's own text. Appended BEFORE `hk-src`, which
    // carries `margin-left:auto` and must stay the rightmost thing in the row.
    const q = [];
    if (h.condition) q.push(t('views.hookNurWenn').replace('{c}', h.condition));
    if (h.once) q.push(t('views.hookNurEinmal'));
    if (q.length) row.appendChild(el('span', 'hk-qual', q.join(' · ')));
    row.appendChild(el('span', 'hk-src', h.sourceLabel || h.source));
    return row;
  };
  const laufen = fremd.filter((h) => !h.disabled);
  const aus = fremd.filter((h) => h.disabled);
  if (laufen.length) {
    box.appendChild(el('div', 'hk-h', t('views.hookWirksamFremd')));
    laufen.forEach((h) => box.appendChild(hookRow(h)));
  }
  if (aus.length) {
    // its own heading, not a footnote: the reason is in the blocks above (policy · safeMode · bareMode), which
    // is what the CLI's own describe for `disabled` points at.
    box.appendChild(el('div', 'hk-h hk-h-off', t('views.hookGesperrt')));
    aus.forEach((h) => box.appendChild(hookRow(h)));
  }
}
// A hook is named by its VALUE, not by its index in the browser's copy: the server takes out exactly
// this entry (strict pull — if it changed meanwhile that is a conflict, not a wrong deletion). An entry
// with several commands loses just the one, and goes back in without it.
function removeHook(ev, entry, hi) {
  const ops = [{ op: 'pull', path: ['hooks', ev], value: entry, strict: true }];
  if ((entry.hooks || []).length > 1) {
    const rest = JSON.parse(JSON.stringify(entry)); rest.hooks.splice(hi, 1);
    ops.push({ op: 'push', path: ['hooks', ev], value: rest });
  }
  return patchSettingsFile('main', ops, t('views.hooksGespeichert'));
}
// the note and the matcher field follow the SELECTED event — the whole point of reading `supportsMatcher`
if ($('#hookEvent')) $('#hookEvent').onchange = paintHookEventNote;
$('#hookAdd').onclick = async () => {
  const ev = $('#hookEvent').value, matcher = $('#hookMatcher').value.trim(), cmd = $('#hookCmd').value.trim();
  if (!cmd) { toast(t('views.kommandoErforderlich'), 'err'); return; }
  const entry = { hooks: [{ type: 'command', command: cmd }] };
  if (matcher && matcher !== '*') entry.matcher = matcher;
  if (!(await patchSettingsFile('main', [{ op: 'push', path: ['hooks', ev], value: entry }], t('views.hooksGespeichert')))) return;
  clearIfUnchanged('#hookMatcher', matcher); clearIfUnchanged('#hookCmd', cmd);
};
function saveEnv(key, val) {
  const op = val === null ? { op: 'delete', path: ['env', key] } : { op: 'set', path: ['env', key], value: val };
  return patchSettingsFile('main', [op], t('views.envGespeichert'));
}
$('#allowAdd').onclick = async () => { const v = $('#allowInput').value.trim(); if (!v) return; if (await localPermAdd('allow', v)) clearIfUnchanged('#allowInput', v); };
$('#denyAdd').onclick = async () => { const v = $('#denyInput').value.trim(); if (!v) return; if (await localPermAdd('deny', v)) clearIfUnchanged('#denyInput', v); };
$('#envAdd').onclick = async () => {
  const k = $('#envKey').value.trim(); const v = $('#envVal').value; if (!k) return;
  if (!(await saveEnv(k, v))) return;
  clearIfUnchanged('#envKey', k);
  if ($('#envVal').value === v) $('#envVal').value = ''; // the value is not trimmed — compare it as typed
};

// --- panel accent color ---
// H7/B8: the gradient's second stop and the text colour on top of it are DERIVED here, not guessed.
// Before, this wrote `--accent-2 = lighten(hex, 0.22)` and left the text at the stylesheet's literal
// `#fff` — so every accent lighter than the coral produced a label the user could not read, and a pale
// yellow accent produced none at all. accentSurface() (public/js/contrast.js) returns the whole triple:
// it keeps the 22 % lift while one ink clears 4,5:1 against BOTH stops and flattens the gradient when no
// ink can (the mid-luminance band).
//
// The size of that promise, walked EXHAUSTIVELY over all 16.777.216 accents a 6-digit hex can express:
// zero failures, worst case exactly 4,5000:1 (at #fe206d), 2,76 % of the cube flattened. The case in
// test/contrast.test.js samples every 9th channel value for runtime — 29³ = 24.389 colours, 636 of them
// flattened (2,61 %) — and asserts both of those numbers, so this sentence cannot drift again.
// WHY both numbers are spelled out: the first version of this sentence called the repo sweep 636 THOUSAND
// colours — the flattened-gradient hit count read as the sample size, 26× too large. In a change whose one
// claim is that contrast is COMPUTED and not estimated, that invented figure sat inside the proof itself.
//
// The stock coral deliberately falls through to the `else` branch and lets the stylesheet's own values
// stand: `--accent-2: #e8a87c` there is HAND-PICKED and is not lighten('#d97757', 0.22) (= #e1957c).
// Overwriting it would silently restyle every button for users who never chose an accent. The test
// asserts that the CSS pair and the derived pair both clear AA, and that the derived ink for the stock
// coral is exactly the `--on-accent` written in the stylesheet — that equality is the only thing
// stopping the two halves from drifting.
// K1 — the OTHER direction: the accent written as a text colour on an ordinary panel surface. That is the
// bulk of its use (112 declarations), and nothing derived it: measured against the worst surface each theme
// offers, the shipped coral was 2,07:1 in light mode and 3,03:1 in dark, a chosen #ffff00 is 1,07:1 on the
// light --panel and #000080 is 1,01:1 on the dark one. accentText() (contrast.js) answers it the only way
// that does not swap the user's colour for a different one: hue and HSL saturation are kept EXACTLY, only
// the lightness moves, by the least amount that reaches the threshold.
//
// WHERE THE LINE BETWEEN THE TWO TOKENS RUNS, and it is drawn on evidence, not by eye:
// The count was 116 when this was measured; main has since removed exactly four of them (and added none,
// counted selector by selector). test/contrast.test.js carries the accounting and the correction.
//   --accent-fg    4,5:1 — WCAG 1.4.3 normal text. 96 of the 112. This is also the DEFAULT for anything
//                  whose font-size is inherited rather than declared (89 of them), because an inherited
//                  size cannot be read out of the stylesheet and the strict side is the only honest guess.
//   --accent-fg-lg 3:1 — WCAG 1.4.3 large text AND 1.4.11 non-text, the same figure under two rules. 15 of
//                  them, and each one has positive evidence IN THE SOURCE that it paints a glyph or an icon
//                  rather than a label: a `content:` with a single character in the rule itself
//                  (`.bubble.streaming::after` ▏, `.qr-btn.qr-cli::before` ✨, `.si-prev.named::before` ✎,
//                  `.ui-result-table th.sorted-asc/desc::after` ▴▾), an svg-sizing child rule next to it
//                  (`.nav-item.active .ni`, `.perm-icon`), or one line of JS that fills it and nothing else
//                  (`.tc-caret` ▸ chat-render.js, `.step-mark` ◐ chat-render.js + views-uiskills.js ×2,
//                  `.todo-mark` ◐ chat-render.js, `.cc-dd-check` ✓ chat-composer.js, `.cso-staged` ⧉
//                  chat-side.js, `.cs-pin:hover` ic('pin') chat-status.js).
// Two rules deliberately get the STRICTER token although they are glyphs: `.usi-quick` and
// `.cs-pin.is-pinned` fade themselves with `opacity: .55`, which eats roughly half the ratio, so the 3:1
// token would land at 2,46:1 / 2,19:1 while 4,5:1 at least reaches 3,29:1 in dark mode. Light mode stays
// at 2,61:1 there — see „Not covered" in the CHANGELOG and K8 in docs/ideas.md; that is an opacity defect,
// not a token defect, and pretending the token fixed it is the thing this file exists to prevent.
// `.empty-glyph` keeps plain `var(--accent)`: a 42 px icon at `opacity: .55` whose message is in the <p>
// beside it, i.e. pure decoration, which both 1.4.3 and 1.4.11 exempt — and at that opacity no token could
// deliver a ratio anyway (1,81:1 light / 2,46:1 dark, measured).
//
// WHY FOUR properties and not two: the derivation depends on the THEME (lighten on dark surfaces, darken on
// light ones), but root.style beats every theme block and `data-theme="auto"` follows the OS while the panel
// is open. So JS writes both bases and the cascade picks — public/styles.css maps --accent-fg to the right
// base in all three theme blocks.
function applyAccent(hex) {
  if (typeof _cssVarCache !== 'undefined') _cssVarCache = null; // invalidate the cssVar memo — colours change
  const root = document.documentElement;
  const custom = hex && /^#[0-9a-f]{6}$/i.test(hex) && hex.toLowerCase() !== '#d97757';
  const s = (custom && typeof accentSurface === 'function') ? accentSurface(hex) : null;
  if (s) {
    const n = parseInt(s.accent.slice(1), 16);
    root.style.setProperty('--accent', s.accent);
    root.style.setProperty('--accent-2', s.accent2);
    root.style.setProperty('--on-accent', s.onAccent);
    root.style.setProperty('--accent-glow', `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.28)`);
  } else {
    ['--accent', '--accent-2', '--on-accent', '--accent-glow'].forEach((v) => root.style.removeProperty(v));
  }
  const fg = accentTextTones(custom ? hex : '#d97757');
  if (custom && fg) {
    root.style.setProperty('--accent-fg-dark', fg.dark.color);
    root.style.setProperty('--accent-fg-light', fg.light.color);
    root.style.setProperty('--accent-fg-lg-dark', fg.lgDark.color);
    root.style.setProperty('--accent-fg-lg-light', fg.lgLight.color);
  } else {
    // the stylesheet literals ARE these four values for the stock coral (test/contrast.test.js asserts the
    // equality), so removing them is not a fallback to something unmeasured
    ['--accent-fg-dark', '--accent-fg-light', '--accent-fg-lg-dark', '--accent-fg-lg-light'].forEach((v) => root.style.removeProperty(v));
  }
  paintAccentNote(fg);
}
// all four derived tones for one accent, or null when contrast.js is not loaded
function accentTextTones(hex) {
  if (typeof accentText !== 'function') return null;
  const d = accentText(hex, 'dark'), l = accentText(hex, 'light');
  if (!d || !l) return null;
  return { hex, dark: d, light: l, lgDark: accentText(hex, 'dark', WCAG_AA_LARGE), lgLight: accentText(hex, 'light', WCAG_AA_LARGE) };
}
// The measurement, printed where the colour is chosen. WHY it is always on screen and not only on failure:
// the one defect this whole change answers is a contrast nobody could see a number for. And WHY the
// „faithful" half is a separate sentence: a tone that reached 4,5:1 by travelling halfway across the
// lightness axis is legible but is no longer the colour in the picker, and silently serving it would be the
// same class of lie in the other direction.
let ACCENT_NOTE_STATE = null; // so a language switch can repaint without re-deriving
function repaintAccentNote() { if (ACCENT_NOTE_STATE) paintAccentNote(ACCENT_NOTE_STATE); }
function paintAccentNote(fg) {
  const el2 = $('#accentNote');
  if (!el2) return;
  ACCENT_NOTE_STATE = fg || null;
  if (!fg) { el2.textContent = ''; el2.classList.remove('warn'); return; }
  const num = (r) => String(contrastRound(r)).replace('.', ',') + ':1';
  const pts = (s) => Math.round(s * 100);
  const drift = [];
  if (!fg.dark.faithful) drift.push(t('html.dunkel') + ' ' + pts(fg.dark.shift));
  if (!fg.light.faithful) drift.push(t('html.hell') + ' ' + pts(fg.light.shift));
  el2.textContent = t('views.accentFgTone')
    + t('html.dunkel') + ' ' + fg.dark.color + ' ' + num(fg.dark.ratio) + ' · '
    + t('html.hell') + ' ' + fg.light.color + ' ' + num(fg.light.ratio)
    + (drift.length ? t('views.accentFgDrift') + drift.join(', ') + t('views.accentFgShiftUnit') : t('views.accentFgOk'));
  // `.hint.warn`, not `.hint.bad` — --danger as 12px text is 3,12:1 on the card in light mode, and a warning
  // that fails its own rule is the joke this change is here to stop telling
  el2.classList.toggle('warn', drift.length > 0);
}
$('#qsAccent').oninput = (e) => { localStorage.setItem('ccui-accent', e.target.value); applyAccent(e.target.value); };
if ($('#qsDefaultCwd')) $('#qsDefaultCwd').onchange = async (e) => { // default cwd for new chats (panel pref, ToDo 07a)
  try {
    const r = await api('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultCwd: e.target.value.trim() }) });
    if (STATE) STATE.defaultCwd = r.defaultCwd;
    if (typeof refreshCwdList === 'function') refreshCwdList();
    toast(t('views.standardArbeitsverzeichnis') + (r.defaultCwd || '(Home)'), 'ok');
  } catch (err) { toast(err.message, 'err'); }
};
function patchMain(key, val) {
  let obj; try { obj = JSON.parse($('#editMain').value || '{}'); } catch { toast(t('views.jsonKorrigierenBevorDie'), 'err'); return; }
  if (val === '' || val == null) delete obj[key]; else obj[key] = val;
  $('#editMain').value = JSON.stringify(obj, null, 2);
  validate('editMain', 'validMain');
  refreshDirty(); // the quick settings only edit the text — say that it now differs from the file (UX-5)
}
$('#qsTheme').onchange = (e) => patchMain('theme', e.target.value);
$('#qsEffort').onchange = (e) => patchMain('effortLevel', e.target.value);
$('#qsModel').onchange = (e) => patchMain('model', e.target.value.trim());
function refreshDirty() {
  $('#dirtyMain').classList.toggle('hidden', $('#editMain').value === ORIG.main);
  $('#dirtyLocal').classList.toggle('hidden', $('#editLocal').value === ORIG.local);
  paintSettBroken('main'); paintSettBroken('local'); // "raw text" vs. "your edit" — rebuilt only on change
}
$('#editMain').addEventListener('input', () => { validate('editMain', 'validMain'); refreshDirty(); });
$('#editLocal').addEventListener('input', () => { validate('editLocal', 'validLocal'); refreshDirty(); });
$('#permDefaultMode').onchange = (e) => {
  const path = ['permissions', 'defaultMode'];
  patchSettingsFile('local', [e.target.value ? { op: 'set', path, value: e.target.value } : { op: 'delete', path }], t('views.standardModusGespeichert'));
};
$$('[data-format]').forEach((b) => b.onclick = () => {
  const id = b.dataset.format;
  try { $('#' + id).value = JSON.stringify(JSON.parse($('#' + id).value || '{}'), null, 2); validate(id, id === 'editMain' ? 'validMain' : 'validLocal'); refreshDirty(); toast(t('views.formatiert'), 'ok'); }
  catch { toast(t('views.ungueltigesJsonNichtFormatierbar'), 'err'); }
});
// smooth-scroll section nav
// section sub-nav (Settings #settNav AND System #sysNav) — smooth-scroll to the target card
// NAV-STICK: `block: 'start'` puts the section's top edge at the top of the SCROLLER — which is where the
// sticky bar is, so the bar landed on top of the heading you just clicked and the section appeared to
// start at its second paragraph. The offset is not a guessed constant: paint() below already measures the
// bar (it wraps to two rows on a narrow window) and writes it into --secnav-h, which styles.css turns into
// `scroll-margin-top` on every [id^="sec-"]/[id^="sys-"] target. So scrollIntoView stays the mechanism —
// the browser does the arithmetic, including for a `#hash` landing and for keyboard-focus scrolling.
$$('.sett-nav a').forEach((a) => a.onclick = (e) => { e.preventDefault(); const t = $(a.getAttribute('href')); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
// …and mark where you ARE (B9). The bar jumped to a section but never said which one you were reading,
// so in a long view it was a launcher, not an orientation. One observer per bar over that bar's own
// targets, and aria-current="location" reports the result to AT.
function initSectionNavHighlight() {
  document.querySelectorAll('.sett-nav').forEach((nav) => {
    if (nav._secWired) return; // idempotent — this runs on every view load
    const links = [...nav.querySelectorAll('a')];
    const targets = links.map((a) => $(a.getAttribute('href'))).filter(Boolean);
    if (!targets.length) return;
    const scroller = nav.closest('.settings-scroll') || nav.parentElement;
    // Decide from GEOMETRY, not from an IntersectionObserver's visible-set. First attempt used the
    // observer's set and marked the wrong link: with a small window #sec-more ended 18px ABOVE the
    // scroller and still counted, so it stayed highlighted while #sec-guard filled the screen. The
    // question "which section am I reading" is simply "which one last passed the top edge" — one pass
    // over ~8 rects, cheap enough for a scroll handler and impossible to get subtly wrong.
    const paint = () => {
      const navH = nav.getBoundingClientRect().height;
      // NAV-STICK — the one measurement both halves need: the highlight edge, and the scroll offset the
      // stylesheet applies so a clicked section does not land underneath this bar.
      scroller.style.setProperty('--secnav-h', Math.round(navH) + 'px');
      const edge = scroller.getBoundingClientRect().top + navH;
      // atBottom: the scroller cannot scroll any further. 2px of slack because a fractional
      // scrollTop/clientHeight (zoom, a device pixel ratio that is not 1) never adds up exactly.
      const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2;
      const best = sectionNavPick(targets.map((sec) => {
        const r = sec.getBoundingClientRect();
        return { id: sec.id, top: r.top, height: r.height };
      }), edge, atBottom);
      links.forEach((a) => {
        const on = !!best && a.getAttribute('href') === '#' + best;
        a.classList.toggle('here', on);
        if (on) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
      });
    };
    let queued = false;
    const onScroll = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; paint(); }); };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    nav._secWired = true;
    nav._secPaint = paint;
    paint();
  });
}
// Which chip is „here", as arithmetic over measured rects — pure, so the two cases that used to be wrong
// can be stated as a test instead of as a scroll by hand.
// `rects` = [{ id, top, height }] in DOM order, `edge` = the y below the sticky bar, `atBottom` = the
// scroller is at its end.
//
// NAV-LAST — the rule „which section last passed the top edge" cannot ever reach the final one: the last
// card is usually shorter than the viewport, so at maximum scrollTop its top edge is still BELOW the edge
// and the chip BEFORE it stayed lit. Read off the two bars as they stand AFTER this PR (SETT-ORDER moved
// the Settings „Info" card to the end): the chip that can never light is the LAST one — „Info" in Settings,
// „Fehler melden" in System — and the one that stayed lit instead is its predecessor, „JSON" and „Stile".
// So you scrolled to the very bottom and the bar pointed one card up. Being at the bottom is itself the
// answer there: the last section is the one you are looking at, whatever its top edge says.
function sectionNavPick(rects, edge, atBottom) {
  const vis = (rects || []).filter((r) => r && !(r.height === 0 && r.top === 0)); // hidden view → no geometry
  if (!vis.length) return null;
  if (atBottom) return vis[vis.length - 1].id;
  let best = null, bestAbove = -Infinity, bestBelow = Infinity;
  vis.forEach((r) => {
    const d = r.top - edge;
    if (d <= 1) { if (d > bestAbove) { bestAbove = d; best = r.id; } }               // last one above the edge
    else if (bestAbove === -Infinity && d < bestBelow) { bestBelow = d; best = r.id; } // else the first below
  });
  return best;
}
// the sections only have a geometry once their view is visible → repaint after a view switch
function repaintSectionNav() { document.querySelectorAll('.sett-nav').forEach((n) => { if (n._secPaint) n._secPaint(); }); }
$('#catSearch').addEventListener('input', debounce(renderCatalog));

// The full-text editor saves the whole file, so it says WHICH file it is replacing: If-Match carries
// the hash of the text it was loaded from. Changed on disk since (the CLI, a switch above, another
// window) → 409 `changed` and a choice instead of a silent overwrite. `tag` is the hash to send on a
// deliberate overwrite — the one the 409 just reported.
// One save per file at a time: a double click sent the second PUT with the hash the first one had
// just made stale, and answered a save that worked with the "file has changed" dialog.
const SETT_SAVING = Object.create(null);
async function save(which, tag) {
  const f = SETT_FILES[which];
  if (SETT_SAVING[which] && tag === undefined) return; // the overwrite from the dialog runs inside the first one
  if (!validate(f.editor, f.badge)) { toast(t('views.ungueltigesJsonNichtGespeichert'), 'err'); return; }
  // an unreadable file has no text in the editor — saving would offer that emptiness as its content
  if (settUnreadable(STATE && STATE[f.stateKey])) { toast(t('views.settUnlesbarToast').replace('{file}', f.file), 'err'); return; }
  const hash = tag !== undefined ? tag : ORIG[which + 'Hash'];
  const btn = $(which === 'main' ? '#saveMain' : '#saveLocal');
  const outer = !SETT_SAVING[which];
  SETT_SAVING[which] = true;
  if (btn) btn.disabled = true;
  try {
    const parsed = JSON.parse($('#' + f.editor).value || '{}');
    const headers = { 'Content-Type': 'application/json' };
    if (hash) headers['If-Match'] = '"' + hash + '"';
    const r = await api(f.endpoint, { method: 'PUT', headers, body: JSON.stringify({ parsed }) });
    // the editor now shows the file as written — and STATE knows it too, so the next comfort action
    // and the friendly lists start from it, not from the load before
    applySettingsSnapshot(which, r.settings, true);
    renderFriendly();
    $('#' + f.note).textContent = t('common.gespeichert') + (r.backup ? t('views.backupErstellt') : '');
    toast(t('views.gespeichert'), 'ok');
  } catch (e) {
    const d = e.data || {};
    if (d.code === 'changed' && d.settings) {
      const choice = await uiModal({
        icon: '⚠', title: t('views.settGeaendertTitel'), message: t('views.settGeaendertText').replace('{file}', f.file), escValue: 'cancel',
        actions: [
          { label: t('html.abbrechen'), value: 'cancel' },
          { label: t('views.settUeberschreiben'), value: 'overwrite', kind: 'danger-btn' },
          { label: t('html.neuLaden'), value: 'reload', primary: true },
        ],
      });
      // awaited, so the guard below stays set until the overwrite is through
      if (choice === 'overwrite') return await save(which, d.settings.hash || '');
      if (choice === 'reload') { applySettingsSnapshot(which, d.settings, true); renderFriendly(); }
      return;
    }
    if (d.settings) applySettingsSnapshot(which, d.settings); // keeps the typed text, updates the banner
    toast(settWriteRefusal(d.code, f, e.message), 'err');
  } finally {
    if (outer) { SETT_SAVING[which] = false; if (btn) btn.disabled = false; }
  }
}
$('#saveMain').onclick = () => save('main');
$('#saveLocal').onclick = () => save('local');
// "Zurücksetzen" = show the file as it is NOW. ORIG is only the text the editor was loaded with; a
// comfort action or the CLI may have changed the file since (STATE holds that newer snapshot). A reset
// to the old text and version met the „changed" dialog on the next save, and Überschreiben undid that change.
$$('[data-reset]').forEach((b) => b.onclick = () => {
  const which = b.dataset.reset === 'main' ? 'main' : 'local';
  const f = SETT_FILES[which];
  const snap = STATE && STATE[f.stateKey];
  if (snap) applySettingsSnapshot(which, snap, true);
  else { $('#' + f.editor).value = ORIG[which]; validate(f.editor, f.badge); }
  refreshDirty(); // UX-5: the "ungespeichert" marker stayed on after a reset
});
// Reload used to overwrite a dirty editor without asking (typed text lost). loadSettings now keeps
// unsaved text (applySettingsSnapshot), so an explicit reload asks: discard the typed text and show
// the file (discard=true), or keep editing.
$('#settReload').onclick = async () => {
  const dirty = $('#editMain').value !== ORIG.main || $('#editLocal').value !== ORIG.local;
  if (!dirty) return loadSettings(true);
  if (!(await uiConfirm(t('views.settVerwerfenFrage'), { danger: true, okLabel: t('views.settVerwerfen') }))) return;
  loadSettings(true, true);
};

