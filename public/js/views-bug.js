// Part of the Claude Code Control Panel front-end (split from app.js).
// Classic scripts share one global scope; load order in index.html is authoritative.
// This file: views-bug.js — "Report Bug" view (ToDo 04) + PR-status footer (ToDo 03).
// Both talk to your-org/claude-code-ui via the GHE-backed server endpoints (/api/bug, /api/bugs, /api/prs).

// ============================================================
//  REPORT BUG → GitHub issue (ToDo 04)
// ============================================================
function bugCats() {
  return [
    { v: 'bug', label: t('views-bug.fehler') },
    { v: 'enhancement', label: t('views-bug.verbesserung') },
    { v: 'question', label: t('views-bug.frage') },
  ];
}
let BUG_DIAG = true; // include safe diagnostics (default on)

function loadBug() {
  const box = $('#bugView'); if (!box) return;
  box.innerHTML = '';

  const note = el('div', 'bug-note card');
  note.innerHTML = t('views-bug.meldetEinenFehlerOder')
    + '<span class="mono">your-org/claude-code-ui</span>. '
    + t('views-bug.sichtbarFuerDieHcm');
  box.appendChild(note);

  const form = el('div', 'bug-form card');
  // category
  form.appendChild(el('label', 'bug-flabel', t('views-bug.art')));
  const cat = el('select', 'bug-input'); cat.id = 'bugCat';
  bugCats().forEach((c) => { const o = el('option', null, c.label); o.value = c.v; cat.appendChild(o); });
  form.appendChild(cat);
  // title
  form.appendChild(el('label', 'bug-flabel', t('views-bug.titel') + ' *'));
  const title = el('input', 'bug-input'); title.id = 'bugTitle'; title.maxLength = 160;
  title.placeholder = t('views-bug.kurzePraegnanteZusammenfassung');
  title.oninput = () => title.classList.remove('invalid');
  form.appendChild(title);
  // description
  form.appendChild(el('label', 'bug-flabel', t('views-bug.beschreibung') + ' *'));
  const desc = el('textarea', 'bug-input bug-textarea'); desc.id = 'bugDesc'; desc.rows = 9;
  desc.value = t('views-bug.schritteZumReproduzieren1');
  desc.oninput = () => desc.classList.remove('invalid');
  form.appendChild(desc);
  // diagnostics toggle
  const diagRow = el('label', 'bug-diag-row');
  const cb = el('input'); cb.type = 'checkbox'; cb.id = 'bugDiag'; cb.checked = BUG_DIAG;
  cb.onchange = () => { BUG_DIAG = cb.checked; };
  diagRow.appendChild(cb);
  diagRow.appendChild(el('span', null, t('views-bug.diagnoseAnhaengenAppCli')));
  form.appendChild(diagRow);
  // actions
  const acts = el('div', 'bug-actions');
  const submit = iconBtn('primary-btn', 'send', { label: t('views-bug.issueAnlegen') });
  submit.onclick = () => submitBug(false);
  const dry = iconBtn('ghost-btn', 'flask', { label: t('views-bug.testlauf'), title: t('views-bug.prueftTokenPayloadOhne') });
  dry.onclick = () => submitBug(true);
  acts.appendChild(submit); acts.appendChild(dry);
  form.appendChild(acts);
  form.appendChild(el('div', 'bug-result', '')).id = 'bugResult';
  box.appendChild(form);

  const recent = el('div', 'bug-recent card');
  recent.appendChild(el('h3', null, t('views-bug.zuletztGemeldet')));
  recent.appendChild(el('div', 'bug-recent-list loading', t('common.lade')));
  box.appendChild(recent);
  loadBugIssues();
}

async function submitBug(dryRun) {
  const title = ($('#bugTitle').value || '').trim();
  const description = ($('#bugDesc').value || '').trim();
  const category = $('#bugCat').value || 'bug';
  const includeDiagnostics = $('#bugDiag').checked;
  const res = $('#bugResult'); res.className = 'bug-result';
  if (!title) { $('#bugTitle').classList.add('invalid'); $('#bugTitle').focus(); toast(t('views-bug.bitteEinenTitelAngeben'), 'err'); return; }
  if (!dryRun) {
    const ok = await uiConfirm(
      t('views-bug.einGithubIssueIn'),
      { title: t('views-bug.issueAnlegen'), icon: '🐞', okLabel: t('common.anlegen') });
    if (!ok) return;
  }
  res.className = 'bug-result loading'; res.textContent = t('views-bug.sende');
  try {
    const j = await api('/api/bug' + (dryRun ? '?dryRun=1' : ''), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description, category, includeDiagnostics, ua: navigator.userAgent, view: 'bug' }),
    });
    res.className = 'bug-result'; res.innerHTML = '';
    if (j.dryRun) {
      res.appendChild(el('div', 'bug-ok', '🧪 ' + t('views-bug.testlaufOkWuerdeEin') + j.target + t('views-bug.anlegenLabel') + (j.labels || []).join(', ') + ').'));
      const pre = el('pre', 'bug-preview'); pre.textContent = j.bodyPreview || ''; res.appendChild(pre);
    } else {
      const ok = el('div', 'bug-ok', '✓ ' + t('views-bug.issueAngelegt'));
      const a = el('a', 'bug-link', '#' + j.number); a.href = j.html_url; a.target = '_blank'; a.rel = 'noopener'; ok.appendChild(a);
      res.appendChild(ok);
      toast(t('views-bug.issue') + j.number + t('views-bug.angelegt'), 'ok');
      loadBugIssues();
    }
  } catch (e) {
    res.className = 'bug-result'; res.innerHTML = '';
    const msg = String(e.message || e);
    if (/no-token/.test(msg)) {
      res.appendChild(el('div', 'bug-err', '⚠ ' + t('views-bug.keinGithubTokenGefunden')));
      res.appendChild(el('div', 'mono bug-err-path', '~/.config/ghe/credentials.json'));
    } else {
      res.appendChild(el('div', 'bug-err', '⚠ ' + msg + (/schannel|handshake|ENOTFOUND|timeout|ETIMEDOUT/i.test(msg) ? ' — ' + t('views-bug.istDasVpnVerbunden') : '')));
    }
  }
}

async function loadBugIssues() {
  const list = document.querySelector('.bug-recent-list'); if (!list) return;
  try {
    const j = await api('/api/bugs');
    list.classList.remove('loading'); list.innerHTML = '';
    if (!j.ok) { list.appendChild(el('div', 'bug-empty', j.reason === 'no-token' ? t('views-bug.keinGithubTokenListe') : t('views-bug.nichtErreichbarVpn'))); return; }
    if (!j.issues.length) { list.appendChild(el('div', 'bug-empty', t('views-bug.keineOffenenIssues'))); return; }
    j.issues.forEach((i) => {
      const row = el('a', 'bug-issue'); row.href = i.url; row.target = '_blank'; row.rel = 'noopener';
      row.appendChild(el('span', 'bi-num', '#' + i.number));
      row.appendChild(el('span', 'bi-title', i.title));
      (i.labels || []).forEach((l) => row.appendChild(el('span', 'bi-label', l)));
      list.appendChild(row);
    });
  } catch (e) { list.classList.remove('loading'); list.innerHTML = ''; list.appendChild(el('div', 'bug-empty', String(e.message || e))); }
}

// ============================================================
//  PR-status footer pill (ToDo 03) — open PRs of your-org/claude-code-ui + review state
// ============================================================
function prWorstState(prs) {
  if (prs.some((p) => p.state === 'changes')) return 'changes';
  if (prs.some((p) => p.state === 'pending')) return 'pending';
  if (prs.some((p) => p.state === 'draft')) return 'draft';
  return 'approved';
}
function prStateLabel(s) {
  return { approved: t('views-bug.freigegeben'), pending: t('views-bug.offen'), changes: t('views-bug.aenderungen'), draft: t('views-bug.entwurf') }[s] || s;
}
// The footer pill carried the review state in COLOUR only (B10) — same problem as the tab dots. The
// glyph plus the state label as a title make it readable without relying on hue.
function prStateGlyph(s) { return { approved: '✓', pending: '…', changes: '✕', draft: '◦' }[s] || '·'; }
function prDot(state) { const d = el('span', 'pr-dot', prStateGlyph(state)); d.title = prStateLabel(state); return d; }
async function loadPrFooter() {
  const pill = $('#prPill'); if (!pill) return;
  try {
    const j = await api('/api/prs');
    if (!j.ok || !j.prs || !j.prs.length) { pill.classList.add('hidden'); pill._prs = null; return; }
    pill._prs = j.prs;
    const worst = prWorstState(j.prs);
    pill.className = 'pr-pill state-' + worst;
    pill.innerHTML = '';
    pill.appendChild(prDot(worst));
    pill.appendChild(el('span', '', j.prs.length + ' ' + (j.prs.length === 1 ? t('views-bug.offenePr') : t('views-bug.offenePrs'))));
    // the count goes into the tooltip too: in the icon rail the pill shows only its dot
    pill.title = j.prs.length + ' ' + (j.prs.length === 1 ? t('views-bug.offenePr') : t('views-bug.offenePrs')) + ' · ' + t('views-bug.reviewStatus') + prStateLabel(worst);
    pill.onclick = openPrModal;
    pill.classList.remove('hidden');
  } catch { pill.classList.add('hidden'); }
}
function openPrModal() {
  const pill = $('#prPill'); const prs = (pill && pill._prs) || [];
  const body = el('div', 'pr-modal-list');
  if (!prs.length) body.appendChild(el('div', 'bug-empty', t('views-bug.keineOffenenPrs')));
  prs.forEach((p) => {
    const row = el('a', 'pr-row state-' + p.state); row.href = p.url; row.target = '_blank'; row.rel = 'noopener';
    row.appendChild(prDot(p.state));
    row.appendChild(el('span', 'pr-num', '#' + p.number));
    row.appendChild(el('span', 'pr-title', p.title));
    row.appendChild(el('span', 'pr-state', prStateLabel(p.state)));
    body.appendChild(row);
  });
  uiModal({ title: t('html.offenePullRequests'), icon: '⇅', body, actions: [{ label: t('common.schliessen'), value: true, primary: true }] });
}
