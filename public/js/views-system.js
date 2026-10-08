// Part of the Claude Code Control Panel front-end (split from app.js).
// Classic scripts share one global scope; load order in index.html is authoritative: render → chat → sessions → views → commands → boot.
// This file: views-system.js

// ============================================================
//  SYSTEM (doctor, account, statusline, subagents, output-styles)
// ============================================================
// A10: this used to spawn THREE CLI processes on every single nav click into System — `claude doctor`
// (45 s timeout), `claude auth status` and `claude --version` + an npm registry lookup. Now it runs once
// per language, ↻ forces a fresh run, and the doctor only runs when its own button is pressed.
async function loadSystem(force) {
  if (!viewOnce('system', force)) return;
  const info = $('#authInfo'); info.innerHTML = '<div class="loading">' + t('views-system.pruefeAuthentifizierung') + '</div>';
  api('/api/auth').then((j) => {
    const s = j.status; info.innerHTML = '';
    if (s) {
      const badge = el('div', 'auth-badge ' + (s.loggedIn ? 'in' : 'out')); badge.appendChild(el('span', 'd')); badge.appendChild(el('span', null, s.loggedIn ? t('views-system.angemeldet') : t('views-system.abgemeldet'))); info.appendChild(badge);
      const grid = el('div', 'auth-grid'); grid.style.marginTop = '12px';
      [[t('views-system.email'), s.email], [t('views-system.organisation'), s.orgName], [t('chat.plan'), s.subscriptionType], [t('views-system.methode'), s.authMethod], [t('views-system.provider'), s.apiProvider]].forEach(([k, v]) => { if (v) { const it = el('div', 'ag-item'); it.appendChild(el('div', 'ag-k', k)); it.appendChild(el('div', 'ag-v', String(v))); grid.appendChild(it); } });
      info.appendChild(grid);
    } else { info.appendChild(Object.assign(el('pre', 'doctor-out'), { textContent: j.raw || j.error || t('views-system.keinStatus') })); }
  }).catch((e) => { errorCard(info, t('views-system.authFehler') + e.message, () => loadSystem(true)); });
  if (!STATE) { try { STATE = await api('/api/state'); } catch { /* */ } }
  const s = (STATE.settings || {}).parsed || {};
  const sl = s.statusLine || {};
  $('#slType').value = sl.type || ''; $('#slCommand').value = sl.command || '';
  $('#activeStyle').value = s.outputStyle || '';
  loadCfg('agents', 'agentsList');
  loadCfg('output-styles', 'stylesList');
  loadPlans(); // A7 — plan-mode artefacts
  loadSysInfo();
  loadBackups();
  doctorIdle(); // A10: NOT runDoctor() — `claude doctor` is a 45 s CLI spawn, it needs a deliberate click
  if (typeof loadBug === 'function') loadBug(); // Report-Bug section now lives inside the System view (ToDo 07)
}
// The binary diagnosis lives here (path · source · every checked path), the input for it lives in
// Settings. Rather than duplicate the field into a second view — two inputs for one value invite the
// „which one counts?" question — the row links into it and puts the cursor there.
function jumpToClaudeBinField() {
  showView('settings');
  const inp = $('#qsClaudeBin');
  if (!inp) return; // older markup / view not present: the jump is a convenience, never a requirement
  // after the view switch, in a rAF so the layout the scroll needs actually exists
  requestAnimationFrame(() => {
    const sec = $('#sec-quick');
    if (sec) { try { sec.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch { /* */ } }
    inp.focus(); inp.select();
  });
}
function claudeBinEditLink() {
  const b = el('button', 'sys-link', t('views-system.inEinstellungenAendern'));
  b.type = 'button';
  b.title = t('views-system.inEinstellungenAendernTitle');
  b.onclick = jumpToClaudeBinField;
  return b;
}
async function loadSysInfo() {
  const box = $('#sysInfo'); box.innerHTML = '<div class="loading">' + t('common.lade') + '</div>';
  try {
    const j = await api('/api/sysinfo');
    box.innerHTML = '';
    const grid = el('div', 'sys-grid');
    const row = (k, v, extra) => { const it = el('div', 'sys-item'); it.appendChild(el('div', 'sys-k', k)); const vv = el('div', 'sys-v'); vv.textContent = v; if (extra) vv.appendChild(extra); it.appendChild(vv); grid.appendChild(it); };
    // Claude Code (CLI): painted by refreshCliVersion() below, so the row carries the same badge AND
    // the update button the sidebar pill offers — it used to only ever SAY "↑ 2.1.267" and leave you
    // to find a terminal. sysinfo's value is the immediate placeholder so the row never flashes empty.
    { const it = el('div', 'sys-item'); it.appendChild(el('div', 'sys-k', t('views-system.claudeCode'))); const vv = el('div', 'sys-v'); vv.id = 'sysCliVer'; vv.textContent = (j.cliVersion || '—') + ' '; it.appendChild(vv); grid.appendChild(it); }
    // App (Control Panel) version vs origin/main — filled async (git fetch can take a moment) (ToDo 05)
    { const it = el('div', 'sys-item'); it.appendChild(el('div', 'sys-k', t('views-system.appVersion'))); const vv = el('div', 'sys-v'); vv.id = 'sysAppVer'; vv.textContent = t('views-system.pruefe'); it.appendChild(vv); grid.appendChild(it); }
    row(t('views-system.node'), j.node); row(t('views-system.os'), j.platform + ' ' + j.release + ' · ' + j.arch);
    row(t('views-system.uptime'), Math.floor(j.uptimeSec / 60) + 'm ' + (j.uptimeSec % 60) + 's · Port ' + j.port);
    row(t('views-system.plugins'), String(j.pluginCount));
    // WHERE the binary was found is as interesting as the path itself: on another machine it lives
    // somewhere else entirely, and a miss is only fixable when the search is visible (lib/paths
    // resolveClaudeBin → source + tried).
    // The diagnosis is here, the input is in Settings — so this row links straight into that field
    // instead of making the reader go looking for it (jumpToClaudeBinField below).
    row(t('views-system.claudeExe'), j.claudeExe + (j.claudeBinSource ? '  ·  ' + j.claudeBinSource : ''), claudeBinEditLink());
    if (j.claudeExeExists === false) {
      const it = el('div', 'sys-item');
      it.appendChild(el('div', 'sys-k', t('views-system.claudeExeSuche')));
      const vv = el('div', 'sys-v bad');
      vv.textContent = t('views-system.claudeExeNichtGefunden')
        + (j.claudeInstallMethod ? ' · installMethod=' + j.claudeInstallMethod : '');
      const tried = j.claudeBinTried || [];
      if (tried.length) vv.title = t('views-system.claudeExeGeprueft') + '\n' + tried.join('\n');
      it.appendChild(vv); grid.appendChild(it);
    }
    row(t('views-system.claude'), j.claudeDir);
    // B5: how many claude.exe run on this machine — the number the CLI update's lock warning is about.
    // „unbekannt" is a state of its own (tasklist failed / not Windows), shown, not hidden: the update
    // asks before it goes ahead in exactly that case, and this row is where the reason can be read.
    if ('claudeRunning' in j) {
      const it = el('div', 'sys-item');
      it.appendChild(el('div', 'sys-k', t('views-system.claudeProzesse')));
      const vv = el('div', 'sys-v');
      if (typeof j.claudeRunning === 'number') vv.textContent = String(j.claudeRunning);
      else {
        const b = el('span', 'sys-badge warn', t('views-system.claudeProzesseUnbekannt'));
        b.title = t('views-system.claudeProzesseUnbekanntTitle');
        vv.appendChild(b);
      }
      if (j.cliUpdating) { const u = el('span', 'sys-badge upd', t('views-system.cliWirdAktualisiert')); vv.appendChild(document.createTextNode(' ')); vv.appendChild(u); }
      it.appendChild(vv); grid.appendChild(it);
    }
    box.appendChild(grid);
    refreshAppVersion(); // fills #sysAppVer + the sidebar update pill (ToDo 05)
    refreshCliVersion(); // fills #sysCliVer + the sidebar CLI-update pill
    // env card
    const envKeys = Object.keys(j.env || {});
    if (envKeys.length) { $('#envCard').hidden = false; const l = $('#sysEnvList'); l.innerHTML = ''; envKeys.forEach((k) => l.appendChild(el('div', 'm-env-row', k + '=' + j.env[k]))); }
    else { $('#envCard').hidden = true; }
    const envBadge = $('#sysNavEnv'); if (envBadge) envBadge.hidden = !envKeys.length; // hide the Env sub-nav badge when the card is empty
  } catch (e) { errorCard(box, t('views-system.sysinfoFehler') + e.message, loadSysInfo); }
}
// App (Control Panel) self-version vs origin/main (ToDo 05). One fetch updates: the System-view row
// (#sysAppVer, if rendered), the About-card subtitle (#aboutVer), and the sidebar "Update" pill. Called
// from loadSysInfo and from boot. Degrades silently when off-VPN (fetchOk:false).
let APP_VERSION = null;
let _verAutoRetried = false; // #27: allow exactly one silent retry per page load if the first check is "offline"
let _verTimer = null;        // the periodic re-check (see scheduleVersionCheck)
let _verBusy = '';           // non-empty while an update/restart runs → the pill shows THAT, not a stale count
let _verBusyWhat = '';       // 'update' | 'restart' — which of the two it is (see setUpdateBusy)
let _verGen = 0;             // bumped by every check and by setUpdateBusy — only the newest answer paints
// The check used to run exactly once, at page load. The panel stays open for days, so the pill kept
// showing whatever happened to be true when the tab was opened — which, right after an update, is
// "nothing", and a commit landing an hour later stayed invisible until a reload. Re-check on a timer
// and whenever the window regains focus (coming back to the panel is exactly when you want to know).
// The server caches the remote call for 15s, so a focus burst costs nothing.
const VERSION_POLL_MS = 10 * 60 * 1000;
let _verLastCheck = 0;
function scheduleVersionCheck() {
  if (_verTimer) clearTimeout(_verTimer);
  _verTimer = setTimeout(() => {
    if (!_cliBusy) refreshCliVersion(); // the CLI check rides the same timer (server caches it 5 min)
    if (!_verBusy) refreshAppVersion(); else scheduleVersionCheck();
  }, VERSION_POLL_MS);
}
window.addEventListener('focus', () => {
  if (_verBusy || Date.now() - _verLastCheck < 60000) return; // don't hammer it on every alt-tab
  refreshAppVersion();
  if (!_cliBusy) refreshCliVersion();
});
// Progress lives ON the pill: the update used to be a confirm dialog followed by up to 60 seconds of
// nothing, which is indistinguishable from a button that does not work. B3: the label carries a
// seconds counter (a 40-s pull that visibly counts is "working", a frozen spinner is "hung"), and the
// System row's buttons are locked for the duration — they stayed clickable and started a second run.
const _busyTicks = {};
function paintBusyPill(id, label, since) {
  clearInterval(_busyTicks[id]); _busyTicks[id] = null;
  const pill = $('#' + id);
  if (!pill || !label) return pill;
  const t0 = since || Date.now();
  const paint = () => {
    const s = Math.max(0, Math.round((Date.now() - t0) / 1000));
    pill.innerHTML = '<span class="up-spin"></span><span>' + label + (s >= 2 ? ' · ' + s + ' s' : '') + '</span>';
  };
  pill.classList.remove('hidden');
  pill.classList.add('is-busy');
  pill.title = label;
  pill.onclick = null;
  paint();
  _busyTicks[id] = setInterval(paint, 1000);
  return pill;
}
function lockRowButtons(rowId, locked) {
  document.querySelectorAll('#' + rowId + ' button').forEach((b) => { b.disabled = !!locked; });
}
// `what` names WHAT is busy ('restart' for this window's own server restart, else an update): stored as a
// sentinel, not compared against the translated label, so the re-entry guard below can say the truth even
// after the language was switched mid-flight.
function setUpdateBusy(label, what) {
  _verBusy = label || '';
  _verBusyWhat = label ? (what || 'update') : '';
  _verGen++; // a check still in flight from before this change must not paint over it (refreshAppVersion)
  lockRowButtons('sysAppVer', !!label);
  const pill = paintBusyPill('updatePill', label);
  if (!label) {
    // Drop the spinner NOW and only then re-check. Repainting from the (async) check alone left the
    // pill spinning and unclickable for the length of a round trip after a failure had already been
    // reported — which reads as "it is still working" when it is not.
    if (pill) { pill.classList.remove('is-busy'); pill.classList.add('hidden'); }
    refreshAppVersion();
  }
}
// A request the busy pill waits on gets a ceiling: past it the pill stops spinning and says so, instead
// of spinning for as long as the browser keeps the socket. The server-side work is NOT cancelled by
// this (git / `claude update` run on) — the next check shows how it ended.
function fetchWithCeiling(url, opts, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return fetch(url, withCcuiHeader(Object.assign({}, opts, { signal: ac.signal }))).finally(() => clearTimeout(timer));
}
const PULL_CEILING_MS = 3 * 60 * 1000;       // git fetch + pull --ff-only (+ checkout main)
const CLI_UPDATE_CEILING_MS = 11 * 60 * 1000; // lib/cli UPDATE_TIMEOUT_MS (10 min) + two --version
function ceilingText(ms) { return t('views-system.keineAntwortNach') + Math.round(ms / 60000) + ' min' + t('views-system.keineAntwortNachRest'); }
async function refreshAppVersion() {
  if (_verBusy) return APP_VERSION; // a running update owns the pill
  const gen = ++_verGen;
  _verLastCheck = Date.now();
  scheduleVersionCheck();
  let av = null, routeMissing = false;
  try {
    const r = await fetch('/api/version', { cache: 'no-store' });
    if (r.status === 404) routeMissing = true; // the running server predates the /api/version route → restart needed
    else if (r.ok) av = await r.json();
  } catch { /* network / unreachable */ }
  // B3: the busy check above only holds for the moment the request left. An answer that was still out
  // when an update started (setUpdateBusy bumps the generation) would rebuild the row with live buttons
  // and stop the busy pill's counter mid-run; one that a newer check overtook would paint the older
  // state over it. Neither paints — the end-of-busy refresh and the newer check each bring their own.
  // The caller still gets this answer (syncAppVersion's pre-flight reads dirtyCount from it).
  if (gen !== _verGen) return av;
  APP_VERSION = av;
  // #27 cold-start safety net: if the first check comes back "offline" (a transient cold GHE call at boot), retry
  // once, silently, a few seconds later — so a fresh page load can't stay stuck on a false "offline". Fires at most
  // once per load, so a genuine off-VPN state still settles on "offline" without looping.
  if (av && !av.fetchOk && !av.serverStale && !_verAutoRetried) { _verAutoRetried = true; setTimeout(refreshAppVersion, 4000); }
  const needsRestart = routeMissing || !!(av && av.serverStale); // running process older than the code on disk
  const ab = $('#aboutVer'); if (ab && av && av.current) ab.textContent = av.current + (av.branch && av.branch !== 'main' ? ' · ' + av.branch : '');
  // sidebar pill: "Neustart" when the server needs a restart, else "Update · N" when behind origin/main.
  // The pill now PERFORMS the action it advertises — it used to only `showView('system')`, so clicking
  // it looked like nothing happened at all (especially when the System view was already open).
  // "Update · N" is gated on compareOk so a failed comparison can't show a phantom update.
  const canUpdate = !!(av && av.fetchOk && av.compareOk !== false && av.behind > 0);
  const pill = $('#updatePill');
  paintBusyPill('updatePill', ''); // a "Prüfe…" from syncAppVersion's pre-flight ends with this answer
  if (pill) {
    pill.classList.remove('is-busy');
    if (needsRestart) {
      pill.classList.remove('hidden');
      pill.innerHTML = '<span class="up-dot"></span><span>' + t('views-system.neustart') + '</span>';
      pill.title = t('views-system.derServerLaeuftAuf');
      pill.onclick = () => restartServer();
    } else if (canUpdate) {
      pill.classList.remove('hidden');
      pill.innerHTML = '<span class="up-dot"></span><span>' + t('views-system.update') + ' · ' + av.behind + '</span>';
      pill.title = t('views-system.dieAppIst') + av.behind + t('views-system.commitSHinterOrigin')
        + (av.dirtyCount ? '\n' + dirtyHint(av) : ''); // the tooltip says it before the click does

      // one click = the whole job (pull, switch to main if needed, restart, reload). Sending the user
      // to the System view first only meant they had to find a second button there.
      pill.onclick = () => syncAppVersion();
    } else { pill.classList.add('hidden'); }
  }
  const v = $('#sysAppVer');
  if (v) {
    v.innerHTML = '';
    const rb = el('button', 'sys-ver-reload'); rb.type = 'button'; rb.innerHTML = ic('reload', 13); rb.title = t('views-system.erneutPruefen');
    rb.onclick = () => { v.textContent = t('views-system.pruefe'); refreshAppVersion(); };
    if (routeMissing) {
      v.textContent = t('views-system.serverVeraltetNeustartNoetig');
      const ex = el('span', 'sys-badge upd', t('views-system.neustart')); ex.title = t('views-system.derLaufendeServerKennt');
      v.appendChild(ex); v.appendChild(rb); return APP_VERSION;
    }
    if (!av) { v.textContent = t('views-system.nichtVerfuegbar'); v.appendChild(rb); return APP_VERSION; }
    v.textContent = (av.current || '?') + (av.branch ? ' · ' + av.branch : '') + (av.serverStale && av.boot ? ' · ' + t('views-system.server') + av.boot : '') + ' ';
    let ex;
    if (av.serverStale) { ex = el('span', 'sys-badge upd', t('views-system.neustartNoetig')); ex.title = t('views-system.serverLaeuftAuf') + (av.boot || '?') + t('views-system.festplatteAuf') + (av.current || '?') + t('views-system.bitteNeuStarten'); }
    else if (!av.fetchOk) { ex = el('span', 'sys-badge', t('views-system.offline')); ex.title = av.note || ''; }
    // honest states instead of a made-up "1 behind": unpushed local commits / an unusable comparison
    else if (av.localOnly) { ex = el('span', 'sys-badge', t('views-system.nichtGepusht')); ex.title = t('views-system.dieseCommitsLiegenNurLokal'); }
    else if (av.compareOk === false) { ex = el('span', 'sys-badge', t('views-system.vergleichNichtMoeglich')); ex.title = av.note || ''; }
    else if (av.behind > 0) { ex = el('span', 'sys-badge upd', '↑ ' + av.behind + t('views-system.hinterOriginMain')); ex.title = av.remoteSubject || ''; }
    else if (av.ahead > 0) { ex = el('span', 'sys-badge ok', '↓ ' + av.ahead + t('views-system.vorOriginMain')); ex.title = t('views-system.lokaleCommitsNochNicht'); }
    else { ex = el('span', 'sys-badge ok', t('views-system.aktuell')); }
    v.appendChild(ex);
    // NOT part of the if/else chain above — that one picks a single badge, and "1 behind" and "3 files
    // changed" are both true at the same time. This is the state that decides whether the ⤓ next to it
    // can do anything at all, so it gets its own badge instead of taking the other one's place.
    if (av.dirtyCount) {
      const d = el('span', 'sys-badge warn', '✎ ' + av.dirtyCount + ' ' + t('views-system.geaendertKurz'));
      d.title = dirtyHint(av);
      v.appendChild(d);
    }
    if (canUpdate) { // 1-click sync when genuinely behind the remote (#27)
      const sb = el('button', 'sys-ver-reload'); sb.type = 'button'; sb.innerHTML = ic('download', 13); sb.title = t('views-system.jetztAktualisierenGitPull');
      sb.onclick = () => syncAppVersion();
      v.appendChild(sb);
    }
    if (av.serverStale) { // the panel can restart its own server now — "Neustart nötig" is no longer a dead end
      const xb = el('button', 'sys-ver-reload'); xb.type = 'button'; xb.innerHTML = ic('reload', 13); xb.title = t('views-system.serverJetztNeuStarten');
      xb.onclick = () => restartServer();
      v.appendChild(xb);
    }
    v.appendChild(rb);
  }
  return APP_VERSION;
}
// The whole update, as ONE action: pull --ff-only (switching to main first when needed), restart the
// server, reload the page. It used to stop after the pull with a toast telling you to restart yourself,
// and the branch refusal needed a second dialog — after every merged PR you sit on a feature branch, so
// that was the normal case, not the edge case. One confirmation up front now covers all of it.
// The local changes that stand between the update button and a fast-forward, as one sentence plus the
// file names. Shared by the badge tooltip, the sidebar pill's tooltip and the pre-flight dialog, so all
// three say the same thing — and `dirty` is capped server-side, hence the „+n" tail.
function dirtyHint(av) {
  const files = Array.isArray(av && av.dirty) ? av.dirty : [];
  const more = (av.dirtyCount || files.length) - files.length;
  return t('views-system.lokaleAenderungenBlockieren') + ' ' + files.join(', ') + (more > 0 ? ' … +' + more : '');
}
// B3: re-entry guard for the whole action, dialogs included. `_verBusy` only covers the pull itself;
// between the click and the confirmation lie a GET (git fetch, seconds) and a dialog, and a second
// click in that window used to open a second dialog and, once both were confirmed, a second pull.
let _syncing = false;
async function syncAppVersion(opts) {
  if (_syncing || _verBusy) return;
  _syncing = true;
  try { await syncAppVersionOnce(opts || {}); } finally { _syncing = false; }
}
async function syncAppVersionOnce(opts) {
  // Feedback at once: the pre-flight GET below can take seconds, and nothing on screen moved meanwhile.
  lockRowButtons('sysAppVer', true);
  paintBusyPill('updatePill', t('views-system.pruefeKurz'));
  // Pre-flight on FRESH state, not on the last poll: a dirty tree makes this whole action impossible,
  // so it is worth re-reading before asking for a confirmation that could not be honoured anyway —
  // and re-reading rather than trusting a reading from minutes ago, because by now the user may well
  // have committed. refreshAppVersion() is the one GET and repaints row + pill on the way.
  const fresh = await refreshAppVersion();
  if (fresh && fresh.dirtyCount) { await uiAlert(dirtyHint(fresh), { title: t('views-system.aktualisieren') }); return; }
  if (!opts.skipConfirm && !(await uiConfirm(t('views-system.updateFrage') + restartDraftNote(), { title: t('views-system.aktualisieren'), okLabel: t('views-system.aktualisierenNeustarten') }))) return;
  setUpdateBusy(t('views-system.aktualisiere'));
  try {
    // switchToMain is sent from the start: the confirmation already said the update runs on main.
    // Same contract as api() (throws with .status/.data), plus the ceiling.
    const resp = await fetchWithCeiling('/api/version/pull', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ switchToMain: true }),
    }, PULL_CEILING_MS);
    const r = await resp.json().catch(() => ({}));
    if (!resp.ok) { const e = new Error((r && r.error) || resp.statusText); e.status = resp.status; e.data = r; throw e; }
    if (r && r.switched) toast(t('views-system.zuMainGewechseltVon') + r.switched, 'ok');
    // say what actually happened: a pull that fast-forwards nothing used to report success anyway,
    // which read as "the update button does nothing"
    if (r && r.changed === false) { toast(t('views-system.bereitsAktuellNichtsGeaendert'), 'ok'); setUpdateBusy(''); return; }
    toast(t('views-system.aktualisiertServerNeuStarten'), 'ok');
    await restartServer({ skipConfirm: true }); // owns the pill from here (and reloads on success)
  } catch (e) {
    setUpdateBusy('');
    const msg = String(e.message || e);
    if (e && e.name === 'AbortError') { await uiAlert(ceilingText(PULL_CEILING_MS), { title: t('views-system.aktualisieren') }); return; }
    // B1: another window (or a click that slipped past the guard above) is already pulling. Nothing
    // failed — say so, and let the running one finish its restart.
    if (e && e.data && e.data.code === 'already-running') { toast(t('views-system.laeuftBereitsApp'), 'info'); return; }
    // Name the obstacle in a dialog, not in a toast that is gone four seconds later.
    // `dirty-main` is tested FIRST because /dirty/ matches it too — and on main nothing is being
    // switched: the pull would have overwritten local changes, so the answer is "commit or stash
    // these files", with the files named. Without this the update simply failed with git's own
    // stderr and the button looked dead.
    if (/dirty-main/.test(msg)) {
      const d = (e && e.data) || {};
      const files = Array.isArray(d.files) ? d.files : [];
      const shown = files.slice(0, 8).join(', ');
      const more = d.count > 8 ? ' … +' + (d.count - 8) : '';
      await uiAlert(t('views-system.arbeitsbaumNichtSauber') + (shown ? ' ' + shown + more : ''), { title: t('views-system.aktualisieren') });
      return;
    }
    if (/dirty/.test(msg)) { await uiAlert(t('views-system.wechselNurMitSauberem'), { title: t('views-system.aktualisieren') }); return; }
    if (/no-token/.test(msg)) { await uiAlert(t('views-system.keinGithubTokenGefunden'), { title: t('views-system.aktualisieren') }); return; }
    await uiAlert(t('views-mcp.updateFehlgeschlagen') + msg, { title: t('views-system.aktualisieren') });
  }
}
// Restart the panel's own server process (POST /api/restart spawns a detached successor, then exits),
// then wait for it to come back and reload the page. Without this, "Neustart nötig" had no action at all.
// B4: the reload is OURS, so it must not be stopped by our own "a tab is still streaming" guard
// (boot.js beforeunload) — the restart has just ended those turns anyway, and the dialog left the page
// stuck on a server that no longer exists.
let RELOAD_FOR_RESTART = false;
function reloadAfterRestart() { RELOAD_FOR_RESTART = true; location.reload(); }
// BUILDER-1 — that reload skips the beforeunload warning, so an unsaved memory or UI-skill builder draft went with
// it without a word. The two confirmations in front of every restart (restartServer, syncAppVersionOnce) are the
// last place that can name them: '' when there is none, else one more paragraph for the message.
function restartDraftNote() {
  const open = [];
  if (typeof memDirty === 'function' && memDirty()) open.push(MEM.name);
  if (typeof builderDirty === 'function' && builderDirty()) open.push('/' + BUILDER.name);
  return open.length ? '\n\n' + t('views-system.neustartEntwurf').replace('{list}', open.join(', ')) : '';
}
// The OLD process still answers for a few seconds (shutdown() lets its chats end, and a keep-alive
// socket outlives server.close()), so "ping ok" alone could reload onto the server that is going away.
// Only a process younger than the restart request counts.
async function newServerUp(sinceMs) {
  try {
    const r = await fetch('/api/ping', { cache: 'no-store' });
    if (!r.ok) return false;
    const j = await r.json().catch(() => null);
    if (!j || typeof j.uptime !== 'number') return true; // an older successor without uptime: up is up
    return j.uptime <= (Date.now() - sinceMs) / 1000 + 2;
  } catch { return false; /* still down */ }
}
async function restartServer(opts) {
  opts = opts || {};
  // This window's own update already owns the app pill, and not every restart button is locked by it
  // (views.js „Jetzt neu starten" is not). A restart on top would relabel the pill and, once refused,
  // clear the busy state of a pull that is still running. syncAppVersion's follow-up restart is the one
  // call that arrives busy on purpose — it is also the only one that passes skipConfirm.
  // „Ein Update läuft bereits" was told even when _verBusy held nothing but THIS window's own restart, which
  // sent the user looking for an update that isn't running. Name what really is (the pill shows it with its
  // seconds counter) — the restart case says „Starte neu…", like the pill.
  if (_verBusy && !opts.skipConfirm) { toast(_verBusyWhat === 'restart' ? t('views-system.starteNeu') : t('views-system.laeuftBereitsApp'), 'info'); return; }
  if (!opts.skipConfirm && !(await uiConfirm(t('views-system.serverNeuStartenLaufende') + restartDraftNote(), { title: t('views-system.serverNeuStarten'), okLabel: t('views-system.neuStarten') }))) return;
  setUpdateBusy(t('views-system.starteNeu'), 'restart');
  const since = Date.now();
  let log = '';
  try { const r = await api('/api/restart', { method: 'POST' }); log = (r && r.log) || ''; }
  catch (e) {
    // #2: refused because `claude update` or a self-pull is running — exiting now would cut it off
    // mid-way. Nothing restarts, so no waiting for a successor and no reload; only this call's
    // „Starte neu…" goes back. The running update keeps its own busy state: the CLI pill (re-checked,
    // so an update started in another window shows up here too — a no-op while it is this window's)
    // or the other window's app pill. apiErrorText names what is running.
    if (e && e.code === 'busy-updating') {
      setUpdateBusy('');
      if (e.data && e.data.what === 'cli') refreshCliVersion();
      await uiAlert(e.message, { title: t('views-system.serverNeuStarten') });
      return;
    }
    // An HTTP answer means the server refused and is still the old one. No answer at all (reset, the
    // process already gone) can just as well mean the restart is under way — wait and see.
    if (e && e.status) { setUpdateBusy(''); await uiAlert(t('views-system.neustartFehlgeschlagen') + String(e.message || e), { title: t('views-system.serverNeuStarten') }); return; }
  }
  const WAIT_TRIES = 60, WAIT_MS = 500; // ~30s: the successor waits for the old listener to release the port
  for (let i = 0; i < WAIT_TRIES; i++) {
    await new Promise((r) => setTimeout(r, WAIT_MS));
    if (await newServerUp(since)) { reloadAfterRestart(); return; }
  }
  // Fallback: keep looking for two more minutes in the background (a slow disk, a cold Defender scan
  // of node.exe) and reload the moment it is there — the dialog below is a status, not the end of it.
  (async () => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      if (await newServerUp(since)) { reloadAfterRestart(); return; }
    }
  })();
  setUpdateBusy('');
  // „neustartDauertLaenger" ends by telling you to check the log — a promise we can only keep when the POST
  // answered with the path. On the network-error path above it never did (log stays ''), and the dialog then
  // pointed at a file it had not named. Without a path it says what we DO know instead: nothing answered, and
  // the state keeps being re-checked — which is exactly what the background loop above does.
  await uiAlert(log
    ? t('views-system.neustartDauertLaenger') + t('views-system.neustartLogHinweis') + log
    : t('views-system.keineAntwortNach') + Math.round(WAIT_TRIES * WAIT_MS / 1000) + ' s' + t('views-system.keineAntwortNachRest'),
    { title: t('views-system.serverNeuStarten') });
}
// ============================================================
//  Claude Code CLI (claude.exe) — same two-surface treatment as the app's own update: a sidebar pill
//  that PERFORMS the update, and a System row that shows the state and offers the same button. The row
//  used to be read-only ("↑ 2.1.267"), which told you an update exists and then made you find a
//  terminal to apply it. `claude update` (server side) picks the right install method itself.
// ============================================================
let CLI_VERSION = null;
let _cliBusy = ''; // non-empty while an update runs → the pill shows THAT, not a stale version
let _cliGen = 0;   // bumped by every check and by setCliBusy — only the newest answer paints
function setCliBusy(label) {
  _cliBusy = label || '';
  _cliGen++; // see refreshCliVersion: an answer from before this change is dropped
  lockRowButtons('sysCliVer', !!label);
  const pill = paintBusyPill('cliUpdatePill', label);
  if (!label) { // drop the spinner NOW, then re-check (see setUpdateBusy for why the order matters)
    if (pill) { pill.classList.remove('is-busy'); pill.classList.add('hidden'); }
    refreshCliVersion(true);
  }
}
let _cliUpdatingPoll = null; // re-check while ANOTHER window's update runs (see refreshCliVersion)
function cliMethodLabel(m) {
  if (m === 'npm-global') return 'npm (global)';
  if (m === 'npm-local') return 'npm (local)';
  if (m === 'native') return t('views-system.cliMethodeNativ');
  return t('views-system.cliMethodeUnbekannt');
}
// force=true asks the server to skip its 5-minute cache (used after an update and by the ↻ button).
async function refreshCliVersion(force) {
  if (_cliBusy) return CLI_VERSION; // a running update owns the pill
  const gen = ++_cliGen;
  let cv = null;
  try { const r = await fetch('/api/cli/version' + (force ? '?force=1' : ''), { cache: 'no-store' }); if (r.ok) cv = await r.json(); }
  catch { /* server down / route missing (older server) → stay silent, the app pill already says so */ }
  // B3: same rule as refreshAppVersion. The forced check that a 409 („claude-running") starts takes
  // seconds; „Trotzdem" inside that window starts the update (setCliBusy bumps the generation), and the
  // late answer — updating:false, canUpdate:true — would unlock the row and stop the pill's counter.
  if (gen !== _cliGen) return cv;
  CLI_VERSION = cv;
  const canUpdate = !!(cv && cv.updateAvailable && cv.canUpdate);
  // B1/B3: an update started elsewhere (second window, the other pill) is reported by the server as
  // `updating`. Show it as running and look again in a few seconds — before, this window offered the
  // same update a second time and a click on it ran into a locked binary.
  const elsewhere = !!(cv && cv.updating);
  clearTimeout(_cliUpdatingPoll); _cliUpdatingPoll = null;
  if (elsewhere) _cliUpdatingPoll = setTimeout(() => { if (!_cliBusy) refreshCliVersion(true); }, 5000);
  const pill = $('#cliUpdatePill');
  paintBusyPill('cliUpdatePill', '');
  if (pill) {
    pill.classList.remove('is-busy');
    if (elsewhere) {
      paintBusyPill('cliUpdatePill', t('views-system.cliAktualisiere'), Number(cv.updatingSince) || 0);
    } else if (canUpdate) {
      pill.classList.remove('hidden');
      pill.innerHTML = '<span class="up-dot"></span><span>Claude · ' + cv.latest + '</span>';
      pill.title = t('views-system.cliNeueVersion') + cv.latest + ' (' + t('views-system.cliInstalliert') + (cv.current || '?') + ')';
      pill.onclick = () => updateCli();
    } else { pill.classList.add('hidden'); }
  }
  const v = $('#sysCliVer');
  if (v) {
    v.innerHTML = '';
    const rb = el('button', 'sys-ver-reload'); rb.type = 'button'; rb.innerHTML = ic('reload', 13); rb.title = t('views-system.erneutPruefen');
    rb.onclick = () => { v.textContent = t('views-system.pruefe'); refreshCliVersion(true); };
    if (!cv) { v.textContent = t('views-system.nichtVerfuegbar'); v.appendChild(rb); return CLI_VERSION; }
    v.textContent = (cv.current || '—') + ' ';
    let ex;
    if (elsewhere) { ex = el('span', 'sys-badge upd', t('views-system.cliWirdAktualisiert')); ex.title = t('views-system.cliLaeuftBereits'); }
    else if (!cv.current) { ex = el('span', 'sys-badge bad', t('views-system.cliNichtGestartet')); ex.title = cv.note || ''; }
    else if (cv.updateAvailable) { ex = el('span', 'sys-badge upd', '↑ ' + cv.latest); ex.title = t('views-system.cliNeueVersion') + cv.latest + (cv.lastPublished ? ' · ' + cv.lastPublished.slice(0, 10) : ''); }
    else if (cv.latest) { ex = el('span', 'sys-badge ok', t('views-system.aktuell')); ex.title = 'npm: ' + cv.latest; }
    else { ex = el('span', 'sys-badge', t('views-system.offline')); ex.title = cv.note || ''; }
    v.appendChild(ex);
    if (cv.method) { const m = el('span', 'sys-badge', cliMethodLabel(cv.method)); m.title = cv.exe || ''; v.appendChild(m); }
    if (canUpdate) {
      const ub = el('button', 'sys-ver-reload'); ub.type = 'button'; ub.innerHTML = ic('download', 13); ub.title = t('views-system.cliUpdateJetzt');
      ub.onclick = () => updateCli();
      v.appendChild(ub);
    }
    v.appendChild(rb);
  }
  return CLI_VERSION;
}
// One action: confirm → `claude update` → say what actually changed. The 409 „claude-running" answer is
// not an error to swallow: Windows locks the running claude.exe, so the user has to decide whether to
// close their sessions or try anyway — with the real numbers in front of them.
// B3: the same re-entry guard as syncAppVersion — it spans the dialogs, not just the request.
let _cliSyncing = false;
async function updateCli(opts) {
  if (_cliSyncing || _cliBusy) return;
  _cliSyncing = true;
  try { await updateCliOnce(opts || {}); } finally { _cliSyncing = false; }
}
async function updateCliOnce(opts) {
  const cv = CLI_VERSION || {};
  if (!opts.skipConfirm) {
    const msg = t('views-system.cliUpdateFrage') + (cv.current || '?') + ' → ' + (cv.latest || '?')
      + t('views-system.cliUpdateMethode') + cliMethodLabel(cv.method)
      + t('views-system.cliUpdateHinweis');
    if (!(await uiConfirm(msg, { title: t('views-system.cliAktualisieren'), okLabel: t('views-system.aktualisieren') }))) return;
  }
  setCliBusy(t('views-system.cliAktualisiere'));
  // raw fetch, not api(): the 409 carries the process COUNTS, and api() throws away everything but .error
  let r = null, data = null;
  try {
    r = await fetchWithCeiling('/api/cli/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: !!opts.force }),
    }, CLI_UPDATE_CEILING_MS);
    data = await r.json().catch(() => ({}));
  } catch (e) {
    setCliBusy('');
    const detail = e && e.name === 'AbortError' ? ceilingText(CLI_UPDATE_CEILING_MS) : t('views-system.cliUpdateFehlgeschlagen') + String((e && e.message) || e);
    await uiAlert(detail, { title: t('views-system.cliAktualisieren') });
    return;
  }
  const code = (data && (data.code || data.error)) || '';
  if (r.status === 409 && code === 'already-running') {
    // B1: someone else's update is running. Not a failure — the pill takes over showing it
    // (refreshCliVersion sees `updating` and polls until it is done).
    setCliBusy('');
    toast(t('views-system.cliLaeuftBereits'), 'info');
    return;
  }
  if (r.status === 409 && code === 'claude-running') {
    setCliBusy('');
    // The panel's own chats are a SUBSET of the machine's claude.exe processes — but only when the
    // process count worked at all (null off-Windows, and a miss is possible). Taking the larger of the
    // two is the only way this never renders "es laufen noch 0 … davon im Panel: 1".
    const n = Math.max(Number(data.procs) || 0, Number(data.chats) || 0);
    const msg = t('views-system.cliLaeuft1') + n + t('views-system.cliLaeuftProzesse')
      + (data.chats ? t('views-system.cliLaeuftPanel') + data.chats : '')
      + t('views-system.cliLaeuftHinweis');
    if (await uiConfirm(msg, { title: t('views-system.cliAktualisieren'), okLabel: t('views-system.cliTrotzdem') })) {
      return updateCliOnce({ skipConfirm: true, force: true });
    }
    return;
  }
  if (r.status === 409 && code === 'process-state-unknown') {
    // B5: the process list could not be read — that used to count as "nothing running" and let the
    // update through blind. Now it is the user's call, with the reason in front of them.
    setCliBusy('');
    if (await uiConfirm(t('views-system.cliProzesseUnbekannt'), { title: t('views-system.cliAktualisieren'), okLabel: t('views-system.cliTrotzdem') })) {
      return updateCliOnce({ skipConfirm: true, force: true });
    }
    return;
  }
  setCliBusy('');
  if (!r.ok) {
    // B2: the binary is GONE after a failed update — a different, worse failure than "locked": no chat
    // starts until it is back. Name the leftover previous version(s) next to it, that is the way back.
    if (code === 'cli-missing' || (data && data.missing)) {
      await uiAlert(cliMissingText(data), { title: t('views-system.cliAktualisieren') });
      return;
    }
    const detail = (data && (data.error || data.output)) || r.statusText;
    await uiAlert(t('views-system.cliUpdateFehlgeschlagen') + detail + (data && data.locked ? t('views-system.cliGesperrtHinweis') : ''), { title: t('views-system.cliAktualisieren') });
    return;
  }
  // „success" from the updater is not proof the binary moved — the server compares --version before/after
  if (data.changed) toast(t('views-system.cliAktualisiertAuf') + data.after + t('views-system.cliLaufendeChats'), 'ok');
  else toast(t('views-system.cliBereitsAktuell'), 'ok');
}
// ---------------------------------------------------------------------------
//  Backups (PR-14). 91 files (measured) stood here in ONE flat column sorted by mtime, with the first 100
//  rendered and the rest silently dropped — and „Wiederherstellen" asked „… wiederherstellen?" and then
//  overwrote the destination without ever showing what would change.
//  Both halves are decided in public/js/backups-view.js (pure, tested); everything below only translates
//  the tokens it returns and draws them. The token→key maps are TOTAL on purpose: every value
//  BACKUP_DIFF_TARGETS / BACKUP_DIFF_CONTENTS / BACKUP_STAMP_SOURCES can hold has an entry, and
//  test/backups-view.test.js reads this file as text to prove it — a token added there without a label
//  here would render an empty dialog, which is how a whole PR in this repo once shipped mute.
// ---------------------------------------------------------------------------
function relBackupKind(k) { return { session: t('views-system.session'), cfg: t('views-system.config'), settings: t('views-system.settings'), file: t('views-system.datei-2'), 'session?': t('views-system.session-2'), other: t('views-system.datei') }[k] || k; }
const BK_TARGET_KEY = { new: 'views-system.backupZielNeu', overwrite: 'views-system.backupZielUeberschreiben', blocked: 'views-system.backupZielBlockiert' };
const BK_CONTENT_KEY = { diff: 'views-system.backupInhaltDiff', 'diff-blocked': 'views-system.backupInhaltDiffBlockiert', identical: 'views-system.backupInhaltIdentisch', binary: 'views-system.backupInhaltBinaer', 'too-large': 'views-system.backupInhaltZuGross' };
const BK_NOTE_KEY = { moved: 'views-system.backupWirdVerschoben', kept: 'views-system.backupBleibtErhalten', 'pruned-self': 'views-system.backupPruneDieses', 'pruned-other': 'views-system.backupPruneAnderes' };
const BK_SIDE_KEY = { current: 'views-system.backupSeiteAktuell', backup: 'views-system.backupSeiteBackup', both: 'views-system.backupSeiteBeide' };
const BK_STAMP_KEY = { name: 'views-system.backupZeitAusName', mtime: 'views-system.backupZeitAusDatei' };
// Where a backup came from, but ONLY where that adds something: the per-row `kind` chip (relBackupKind)
// already says Session/Settings, and printing it twice is how the first draft rendered
// „📄 Settings 📄 Settings settings.local.json". What it does NOT say is which collection a cfg backup
// came from — it flattens agents/commands/output-styles into one „Config" — and that „memory" exists at
// all. cfgLabel() must not be asked blind for that: its else-branch answers „Command" for everything.
function backupCollLabel(c) {
  if (c === 'memory') return t('views-system.backupCollMemory');
  if (c === 'agents' || c === 'commands' || c === 'output-styles') return cfgLabel(c);
  return '';
}
const bkKB = (n) => (Number(n) / 1024).toFixed(1) + ' KB';
const bkLocale = () => (LANG === 'en' ? 'en-US' : 'de-DE');
const bkExact = (ms) => new Date(Number(ms) || 0).toLocaleString(bkLocale());
function backupDayLabel(day) {
  const off = backupDayOffset(day, Date.now());
  if (off === 0) return t('views-system.backupHeute');
  if (off === 1) return t('views-system.backupGestern');
  const m = /^(\d+)-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return String(day || '');
  const d = new Date(2000, Number(m[2]) - 1, Number(m[3])); d.setFullYear(Number(m[1]));
  return d.toLocaleDateString(bkLocale(), { weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });
}
// Which day groups the user has open. Kept per page load, not per load of this list: a restore reloads the
// list, and collapsing everything the reader had just opened is how you lose your place mid-task.
let BK_OPEN = null;
function bkFold(cls, headNodes, open, onToggle) {
  const det = el('details', cls);
  det.open = !!open;
  const sum = el('summary', 'bk-foldhead');
  headNodes.forEach((n) => sum.appendChild(n));
  det.appendChild(sum);
  if (onToggle) det.ontoggle = () => onToggle(det.open);
  return det;
}
async function loadBackups() {
  const box = $('#backupsList'); box.innerHTML = '<div class="loading">' + t('common.lade') + '</div>';
  try {
    const j = await api('/api/backups');
    const g = backupGroups(j.backups || []);
    // The count is the SERVER's list length, not what got rendered: the old view said „91 Einträge" and
    // drew 100 at most, so backup 101 was gone from the page with nothing saying so. Groups collapse, so
    // there is no reason left to cap anything.
    $('#backupCount').textContent = '· ' + g.total + t('views-system.eintraege');
    box.innerHTML = '';
    if (!g.total) { box.innerHTML = '<div class="cfg-empty">' + t('views-system.keineBackups') + '</div>'; return; }
    if (BK_OPEN === null) BK_OPEN = new Set(g.days.length ? [g.days[0].day] : []); // newest day open on the first paint
    g.days.forEach((d) => box.appendChild(backupDayNode(d)));
    if (g.unmatched.length) box.appendChild(backupUnmatchedNode(g.unmatched));
  } catch (e) { errorCard(box, t('views-system.backupsFehler') + e.message, loadBackups); }
}
function bkCountChip(n, title) { const c = el('span', 'bk-count', String(n)); if (title) c.title = title; return c; }
function backupDayNode(d) {
  const head = [el('span', 'bk-day', backupDayLabel(d.day))];
  const chip = bkCountChip(d.count, t('views-system.backupAnzahl') + d.count + ' · ' + t('views-system.backupDateien') + d.files.length);
  head.push(chip);
  const det = bkFold('bk-group', head, BK_OPEN.has(d.day), (open) => { if (open) BK_OPEN.add(d.day); else BK_OPEN.delete(d.day); });
  const inner = el('div', 'bk-groupbody');
  d.files.forEach((fg) => inner.appendChild(backupFileNode(fg)));
  det.appendChild(inner);
  return det;
}
// One logical file inside a day. A single version is a plain row — wrapping one item in a collapsible
// would hide it behind a click for nothing; several versions fold, because `settings.local.json` alone has
// 30 of them here.
function backupFileNode(fg) {
  const coll = backupCollLabel(fg.collection);
  if (fg.count === 1) return backupItemNode(fg.items[0], fg.file, coll);
  const head = [];
  if (coll) head.push(el('span', 'bk-coll', coll));
  head.push(el('span', 'bk-file', fg.file));
  head.push(bkCountChip(fg.count, t('views-system.backupVersionen') + fg.count));
  const det = bkFold('bk-filegroup', head, false);
  const inner = el('div', 'bk-filebody');
  // inside a multi-version group the file name is already in the header — what tells the versions apart
  // is the exact moment, so that is what each row is labelled with
  fg.items.forEach((it) => inner.appendChild(backupItemNode(it, bkExact(it.stampMs), '')));
  det.appendChild(inner);
  return det;
}
function backupItemNode(it, label, coll) {
  const bk = it.entry;
  const row = el('div', 'backup-item');
  const main = el('div', 'bk-main');
  main.appendChild(el('span', 'bk-kind ' + bk.kind, relBackupKind(bk.kind)));
  if (coll) main.appendChild(el('span', 'bk-coll', coll));
  const nm = el('span', 'bk-name', label);
  nm.title = bk.name; // the raw name, always reachable — the grouping must not hide what the file is called
  main.appendChild(nm);
  row.appendChild(main);
  const meta = el('div', 'bk-meta');
  // The time is the one from the NAME where there is one (= when the backup was made). mtime survives
  // fs.rename, so for a deleted session it is when that session was last written, not when it was
  // deleted — 27 of the 91 backups here disagree by at least a day. The title says which of the two
  // this is instead of leaving the reader to assume.
  const when = el('span', null, relTime(it.stampMs));
  when.title = t(BK_STAMP_KEY[it.stampFrom]) + bkExact(it.stampMs);
  meta.appendChild(when);
  meta.appendChild(el('span', null, bkKB(bk.size)));
  // ccuiApiUrl: this is a NAVIGATION, not a fetch — the window.fetch wrapper (public/js/api-token.js)
  // cannot reach it, so the N9 token has to ride in the query, the same way it does for EventSource.
  // Without it the download answers 401 JSON and the user gets a file called „download" full of an error.
  const dl = el('button', 'mini-btn', '⭳'); dl.title = t('views-system.download'); dl.onclick = () => { window.location.href = ccuiApiUrl('/api/backups/download?name=' + encodeURIComponent(bk.name)); }; meta.appendChild(dl);
  if (bk.restorable) { const rs = el('button', 'mini-btn', t('views-system.wiederherstellen-3')); rs.onclick = () => restoreBackup(bk); meta.appendChild(rs); }
  row.appendChild(meta);
  return row;
}
// The names no rule reads. Visible, downloadable, and labelled as unassigned — a backup that is merely
// missing from the view is one its owner stops looking for.
function backupUnmatchedNode(items) {
  const head = [el('span', 'bk-day bk-day-unmatched', t('views-system.backupNichtZugeordnet')), bkCountChip(items.length)];
  const det = bkFold('bk-group', head, false);
  const inner = el('div', 'bk-groupbody');
  inner.appendChild(el('div', 'bk-hint', t('views-system.backupNichtZugeordnetHinweis')));
  items.forEach((it) => inner.appendChild(backupItemNode(it, it.entry.name, '')));
  det.appendChild(inner);
  return det;
}
// What the dialog shows before anything is written: the destination path, which of the three outcomes this
// is, whether the backup survives it, and the diff — or a sentence where a diff would be a lie.
function backupPreviewBody(pv) {
  const body = el('div', 'bk-preview');
  const head = el('div', 'bk-pv-row');
  head.appendChild(el('span', 'bk-pv-k', t('views-system.backupZiel')));
  head.appendChild(Object.assign(el('span', 'bk-pv-path'), { textContent: pv.dest || '—' }));
  body.appendChild(head);
  body.appendChild(el('div', 'bk-pv-state ' + pv.target, t(BK_TARGET_KEY[pv.target])));
  // What becomes of the backup itself is not a detail: a session/cfg restore CONSUMES it (fs.rename), so
  // afterwards it is gone from this list, and a settings restore at the retention limit deletes a backup
  // while copying — this one or an uninvolved one. All four cases plus „say nothing at all" (blocked, where
  // nothing is written) are decided in backups-view.js backupKeepNote(); the names of the casualties are
  // appended unconditionally, so a second one can never be swallowed by the sentence.
  const note = backupKeepNote(pv);
  if (note) {
    const gone = Array.isArray(pv.prunes) ? pv.prunes : [];
    body.appendChild(el('div', 'bk-pv-note', t(BK_NOTE_KEY[note]) + gone.join(' · ')));
  }
  const sizes = el('div', 'bk-pv-row');
  sizes.appendChild(el('span', 'bk-pv-k', t('views-system.backupGroessen')));
  sizes.appendChild(el('span', 'bk-pv-sizes', t('views-system.backupGroesseAktuell')
    + (pv.exists ? bkKB(pv.currentBytes) : t('views-system.backupExistiertNicht'))
    + ' · ' + t('views-system.backupGroesseBackup') + bkKB(pv.backupBytes)));
  body.appendChild(sizes);
  const side = pv.bigSide || pv.binarySide;
  // The caption is a claim about an effect, so it is decided by target × content and not by content alone
  // (backups-view.js backupContentCaption) — under `blocked` there is no effect to announce.
  body.appendChild(el('div', 'bk-pv-cap', t(BK_CONTENT_KEY[backupContentCaption(pv)])
    + (pv.content === 'too-large' ? ' ' + bkKB(pv.limit) : '')
    + (side ? ' · ' + t(BK_SIDE_KEY[side]) : '')));
  if (pv.content === 'diff') {
    // the repo's own diff (render.js renderDiff + chat-render.js capDiffHeight), not a second one: the
    // Edit/Write tool cards and the permission dialog already read this way. WHICH side is which comes from
    // backups-view.js backupDiffSides() — swapped, every restore would read mirrored.
    const sides = backupDiffSides(pv);
    const d = renderDiff(sides.old, sides.new, extLang(pv.dest));
    body.appendChild(typeof capDiffHeight === 'function' ? capDiffHeight(d) : d);
  }
  return body;
}
async function restoreBackup(bk) {
  let pv = null;
  try { pv = await api('/api/backups/preview?name=' + encodeURIComponent(bk.name)); }
  catch (e) {
    // The preview refuses exactly what the restore refuses (no cwd in the transcript, an unusable cfg
    // target, a download-only kind) — so this IS the answer, not a failed pre-flight. Saying it here beats
    // asking for a confirmation the restore would then reject.
    await uiAlert(e.message, { title: t('views-system.backupVorschauTitel') });
    return;
  }
  const actions = [{ label: t('html.abbrechen'), value: false }];
  // No button for the blocked case: a session/cfg restore onto an existing file answers 409 and changes
  // nothing, so offering it would be a button that can only fail. The diff above still explains why you
  // might want the ⭳ download instead.
  if (pv.target !== 'blocked') {
    actions.push(pv.target === 'overwrite'
      ? { label: t('views-system.wiederherstellen-2'), value: true, kind: 'danger-btn' }
      : { label: t('views-system.wiederherstellen-2'), value: true, primary: true });
  }
  const go = await uiModal({
    icon: '↩', title: t('views-system.backupVorschauTitel') + (bk.id || bk.target || bk.name),
    body: backupPreviewBody(pv), wide: true, escValue: false, actions,
  });
  if (go !== true) return;
  try {
    const r = await api('/api/backups/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: bk.name }) });
    toast(t('views-system.wiederhergestellt') + (r.restoredTo || 'ok'), 'ok');
    loadBackups();
    if (bk.kind === 'session') loadSessions();
    if (bk.kind === 'cfg') reloadCfgViews(bk.cfgKind);
    // the settings view and STATE still held the replaced file; an editor with unsaved text keeps it
    // (and its old hash), so saving it later asks instead of overwriting the restored file
    if (bk.kind === 'settings' && typeof loadSettings === 'function') loadSettings(true);
  } catch (e) { toast(e.message, 'err'); }
}
function colorizeDoctor(text) {
  const out = $('#doctorOut'); out.innerHTML = '';
  String(text || '').split('\n').forEach((line) => {
    let cls = '';
    if (/✓|✔|√|\bok\b|passed|success/i.test(line)) cls = 'dl-ok';
    else if (/✗|✖|✕|fail|error|missing|not found/i.test(line)) cls = 'dl-bad';
    else if (/⚠|warn/i.test(line)) cls = 'dl-warn';
    out.appendChild(Object.assign(el('div', 'dl-line ' + cls), { textContent: line }));
  });
}
// A10: the idle state — an honest "not run yet" instead of silently burning 45 s of CLI time per click
function doctorIdle() {
  const out = $('#doctorOut'), btn = $('#doctorRun');
  if (btn) { const b = btn.querySelector('.btxt'); if (b) b.textContent = t('views-system.doctorStart'); else btn.textContent = t('views-system.doctorStart'); btn.disabled = false; }
  if (out) { out.innerHTML = ''; out.appendChild(el('div', 'doctor-idle', t('views-system.doctorHinweis'))); }
}
async function runDoctor() {
  const out = $('#doctorOut'), btn = $('#doctorRun');
  btn.disabled = true; out.innerHTML = '<div class="loading">' + t('html.pruefe') + '</div>';
  try { const j = await api('/api/doctor'); colorizeDoctor(j.output || j.error || t('views-system.keineAusgabe')); }
  catch (e) { errorCard(out, t('common.fehler-2') + e.message, runDoctor); }
  finally { btn.disabled = false; const b = btn.querySelector('.btxt'); if (b) b.textContent = t('html.neuPruefen'); else btn.textContent = t('html.neuPruefen'); }
}
async function loadCfg(kind, listId) {
  const box = $('#' + listId); box.innerHTML = '<div class="loading">' + t('common.lade') + '</div>';
  try {
    const j = await api('/api/cfgfiles?kind=' + kind);
    box.innerHTML = '';
    if (!j.files.length) { box.innerHTML = '<div class="cfg-empty">' + t('views-system.nochKeineNeuZum') + '</div>'; return; }
    j.files.forEach((f) => { const c = el('div', 'cfg-card'); c.appendChild(el('div', 'cc-name', f.name)); if (f.description) c.appendChild(el('div', 'cc-desc', f.description)); c.onclick = () => openCfg(kind, f.name); mkClickable(c, f.name); box.appendChild(c); });
  } catch (e) { errorCard(box, t('views-system.cfgListeFehler') + e.message, () => loadCfg(kind, listId)); }
}
// ---------------------------------------------------------------------------
// Plans (A7) — ~/.claude/plans/*.md. The panel could show every other artefact of a session (memory,
// agents, styles, backups) but not the PLANS, even though a plan is the condensed result of the most
// expensive thinking a session does. Read, reuse as a prompt, delete.
// ---------------------------------------------------------------------------
async function loadPlans() {
  const box = $('#plansList'); if (!box) return;
  box.innerHTML = '<div class="loading">' + t('common.lade') + '</div>';
  try {
    const j = await api('/api/plans');
    box.innerHTML = '';
    if (!j.plans.length) { box.innerHTML = '<div class="cfg-empty">' + t('views-system.keinePlaene') + '</div>'; return; }
    j.plans.forEach((p) => {
      const c = el('div', 'cfg-card');
      c.appendChild(el('div', 'cc-name', p.title));
      if (p.teaser) c.appendChild(el('div', 'cc-desc', p.teaser));
      c.appendChild(el('div', 'cc-meta', relTime(p.mtime) + ' · ' + (p.size / 1024).toFixed(1) + ' KB'));
      c.onclick = () => openPlan(p);
      mkClickable(c, p.title);
      box.appendChild(c);
    });
  } catch (e) { errorCard(box, t('views-system.plaeneFehler') + e.message, loadPlans); }
}
async function openPlan(p) {
  let content = '';
  try { content = (await api('/api/plan?name=' + encodeURIComponent(p.name))).content; }
  catch (e) { toast(e.message, 'err'); return; }
  const body = el('div', 'plan-view');
  body.innerHTML = (typeof renderMarkdown === 'function') ? renderMarkdown(content) : mdEscape(content);
  const choice = await uiModal({
    icon: '🗺', title: p.title, body, wide: true, escValue: null,
    actions: [
      { label: t('views-system.planLoeschen'), value: 'del', kind: 'danger-btn' },
      { label: t('common.kopieren'), value: 'copy' },
      { label: t('views-system.planAlsPrompt'), value: 'prompt', primary: true },
      { label: t('common.schliessen'), value: null },
    ],
  });
  if (choice === 'copy') { try { await navigator.clipboard.writeText(content); toast(t('views-system.planKopiert'), 'ok'); } catch { toast(t('common.fehler'), 'err'); } }
  else if (choice === 'prompt') {
    // a fresh tab, not the current one: a plan is a new piece of work, and dropping 200 lines into a
    // running conversation is how you lose both
    if (typeof newTab === 'function') newTab();
    if (typeof showView === 'function') showView('chat');
    if (typeof composerSet === 'function') composerSet(content, t('views-system.planUebernommen'));
  } else if (choice === 'del') {
    if (!(await uiConfirm(t('views-system.planLoeschenFrage') + p.title + '"', { title: t('views-system.planLoeschen'), danger: true, okLabel: t('common.loeschen-2') }))) return;
    try { await api('/api/plan?name=' + encodeURIComponent(p.name), { method: 'DELETE' }); toast(t('views-system.planGeloescht'), 'ok'); loadPlans(); }
    catch (e) { toast(e.message, 'err'); }
  }
}
// Config-file edit dialog: openCfgOverlay/closeCfgOverlay moved to public/js/dialogs.js (C3). CFG_CTX
// stayed — it is this view's state („which file am I editing"), not the dialog's.
let CFG_CTX = { kind: null, name: null };
const cfgLabel = (k) => k === 'agents' ? t('views-system.subagent') : k === 'output-styles' ? t('views-system.outputStyle') : t('common.command');
function reloadCfgViews(kind) {
  if (kind === 'commands') loadSkills();
  else { loadCfg('agents', 'agentsList'); loadCfg('output-styles', 'stylesList'); }
}
async function openCfg(kind, name) {
  CFG_CTX = { kind, name };
  try {
    const j = await api('/api/cfgfile?kind=' + kind + '&name=' + encodeURIComponent(name));
    $('#cfgTitle').textContent = cfgLabel(kind) + ': ' + name;
    $('#cfgEditor').value = j.content;
    $('#cfgDelete').classList.remove('hidden');
    openCfgOverlay();
    setTimeout(() => $('#cfgEditor').focus(), 0);
  } catch (e) { toast(e.message, 'err'); }
}
async function newCfg(kind, template) {
  const name = await uiPrompt(t('views-system.neuer') + cfgLabel(kind) + t('views-system.nameKebabCase'), '', { title: t('views-system.neuer') + cfgLabel(kind), okLabel: t('common.anlegen') });
  if (!name || !name.trim()) return;
  CFG_CTX = { kind, name: name.trim() };
  $('#cfgTitle').textContent = cfgLabel(kind) + ': ' + name.trim();
  $('#cfgEditor').value = template;
  $('#cfgDelete').classList.add('hidden');
  openCfgOverlay();
  setTimeout(() => $('#cfgEditor').focus(), 0);
}
$('#agentNew').onclick = () => newCfg('agents', t('views-system.nameMyAgentDescription'));
$('#styleNew').onclick = () => newCfg('output-styles', t('views-system.nameMyStyleDescription'));
$('#cfgCancel').onclick = closeCfgOverlay;
// PR-11 — a saved skill is on DISK, but a session that is already running carries its skill listing in its
// CONTEXT: until now the file the user had just edited was not the one the model saw, and nothing said so.
// `reload_skills` is a real control of this binary (claude.exe 2.1.288, read for free: „Reloads skills from
// disk and returns the refreshed skill list.", with its own branch in the stdio dispatcher) and takes no
// arguments. Fired for EVERY running session, because the file is global and reloading only the active tab
// would leave the others quietly stale — which is the shape of the bug being fixed here.
// The outcome is REPORTED, not assumed: a session that did not answer leaves the toast saying so, because a
// reload nobody confirmed must not look like one that worked.
// `commands` only. Agents and output styles have their own controls (reload_plugins /
// reload_output_styles) which are NOT measured here — see docs/ideas.md.
async function reloadSkillsInSessions() {
  const tabs = (typeof TABS !== 'undefined' && Array.isArray(TABS)) ? TABS : [];
  const ids = [...new Set(tabs.filter((tb) => tb && tb.id && !tb._exited).map((tb) => tb.id))];
  const out = { asked: ids.length, ok: 0, offen: 0 };
  await Promise.all(ids.map(async (id) => {
    try {
      const r = await api('/api/chat/' + id + '/reload-skills', { method: 'POST' });
      if (r && r.unconfirmed) out.offen++; else out.ok++;
    } catch { out.offen++; }   // a 409 (the process ended in between) counts as „not done", not as done
  }));
  return out;
}
$('#cfgSave').onclick = async () => {
  if (!CFG_CTX.name) return;
  try {
    await api('/api/cfgfile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: CFG_CTX.kind, name: CFG_CTX.name, content: $('#cfgEditor').value }) });
    const kind = CFG_CTX.kind;
    // The DIALOG closes and the list refreshes at once — the write to disk is done at this point, and
    // nothing about the sessions can undo it. Only the TOAST waits, because it is one sentence about both
    // halves („Gespeichert · n Sitzungen haben neu gelesen") and splitting it into two toasts would make the
    // normal case noisy. In practice that wait is the control's 20 ms–1 s; the worst case is a session that
    // never answers, and then the 5 s delay is itself the message — the toast says the reload is unconfirmed.
    closeCfgOverlay();
    reloadCfgViews(kind);
    if (kind !== 'commands') { toast(t('views.gespeichert'), 'ok'); return; }
    const r = await reloadSkillsInSessions();
    if (!r.asked) toast(t('views.gespeichert'), 'ok');
    else if (!r.offen) toast(t('views.gespeichert') + ' · ' + t('views-system.skillsNeuGelesen').replace('{n}', String(r.ok)), 'ok');
    else toast(t('views.gespeichert') + ' · ' + t('views-system.skillsReloadOffen').replace('{n}', String(r.offen)), 'warn');
  } catch (e) { toast(e.message, 'err'); }
};
$('#cfgDelete').onclick = async () => {
  if (!CFG_CTX.name || !(await uiConfirm(t('views-system.loeschen') + CFG_CTX.name + t('views-system.insBackupVerschoben'), { title: t('common.loeschen-2'), danger: true, okLabel: t('common.loeschen-2') }))) return;
  try {
    await api('/api/cfgfile/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: CFG_CTX.kind, name: CFG_CTX.name }) });
    toast(t('views-system.geloescht'), 'ok'); closeCfgOverlay();
    reloadCfgViews(CFG_CTX.kind);
  } catch (e) { toast(e.message, 'err'); }
};
$('#doctorRun').onclick = runDoctor;
$('#backupsReload').onclick = loadBackups;
// both as named changes to settings.json (patchSettingsFile, views.js) — not a whole-file PUT rebuilt
// from the STATE of the last load, which undid whatever changed in the file since (DATA-2)
$('#slSave').onclick = async () => {
  const type = $('#slType').value, cmd = $('#slCommand').value.trim();
  const ops = (type === 'command' && cmd)
    ? [{ op: 'set', path: ['statusLine', 'type'], value: 'command' }, { op: 'set', path: ['statusLine', 'command'], value: cmd }] // padding & co. stay
    : [{ op: 'delete', path: ['statusLine'] }];
  if (await patchSettingsFile('main', ops, t('views-system.statuszeileGespeichert'))) $('#slNote').textContent = t('common.gespeichert');
};
$('#activeStyleSave').onclick = () => {
  const v = $('#activeStyle').value.trim();
  patchSettingsFile('main', [v ? { op: 'set', path: ['outputStyle'], value: v } : { op: 'delete', path: ['outputStyle'] }], t('views-system.aktiverOutputStyleGespeichert'));
};
$('#sysReload').onclick = () => loadSystem(true);
if ($('#plansReload')) $('#plansReload').onclick = () => loadPlans();

