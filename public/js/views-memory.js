// Part of the Claude Code Control Panel front-end (split from app.js).
// Classic scripts share one global scope; load order in index.html is authoritative: render → chat → sessions → views → commands → boot.
// This file: views-memory.js

// ============================================================
//  MEMORY
// ============================================================
let MEM = { project: null, name: null }, MEM_DATA = null, MEM_MODE = 'preview';
// DATA-2: the text openMemory last put into the editor (and saveMemory last wrote). The baseline for
// „is there an unsaved draft" — the editor's own value is the only copy of it, so nothing else can tell.
let MEM_LOADED = '';
// function, not a load-time const — labels must re-resolve on a live language switch
const MEM_TYPES = () => ({ user: t('views-memory.user'), feedback: t('views-memory.feedback'), project: t('views-memory.projekt'), reference: t('views-memory.referenz') });
// A17: the server payload carries only metadata (name/description/type/links), so a content search has to
// bring its own text. This cache is filled from two sides: every file the user OPENS lands here for free,
// and "Inhalte durchsuchen" bulk-fetches the rest with a visible progress count. Keyed 'project|name',
// values are lowercased so the filter never re-lowercases 60 files per keystroke.
const MEM_TEXT = new Map();
let MEM_SCAN = { running: false, done: 0, total: 0, scanned: false };
const memKey = (project, name) => project + '|' + name;

async function loadMemory(force) {
  // A11: /api/memory re-reads ~60 files on every call. Entering the view repeatedly must not pay that
  // again — the ↻ button (and a language switch, via the LANG-keyed guard) is the way to force a refetch.
  if (!viewOnce('memory', force) && MEM_DATA) { renderMemoryList(); return; }
  const list = $('#memList'); list.innerHTML = '<div class="loading">' + t('common.lade') + '</div>';
  // accessible name for the editor textarea (its <label> is the toolbar, which screen readers don't tie to it)
  if ($('#memEditor')) $('#memEditor').setAttribute('aria-label', t('views-memory.memEditorLabel'));
  try {
    MEM_DATA = await api('/api/memory');
    renderMemoryList();
  } catch (e) {
    // A9: a blank list + a 4s toast left no explanation behind — show the failure in the pane, with a retry
    errorCard(list, t('views-memory.memListeFehler') + e.message, () => loadMemory(true));
  }
}
// A17: metadata match first (free), content match only for files whose text we already hold
function memMatches(f, project, q) {
  if (!q) return true;
  if ((f.name + ' ' + (f.description || '') + ' ' + (f.type || '')).toLowerCase().includes(q)) return true;
  const txt = MEM_TEXT.get(memKey(project, f.name));
  return !!(txt && txt.includes(q));
}
function renderMemoryList() {
  const list = $('#memList'); list.innerHTML = '';
  const j = MEM_DATA; if (!j) return;
  const q = ($('#memSearch').value || '').toLowerCase();
  let total = 0, contentHits = 0;
  for (const g of j.groups) {
    const files = g.files.filter((f) => memMatches(f, g.project, q));
    if (!files.length) continue;
    list.appendChild(el('div', 'mem-group-label', g.projectPath));
    for (const f of files) {
      total++;
      const item = el('div', 'mem-item' + (MEM.project === g.project && MEM.name === f.name ? ' active' : ''));
      const top = el('div', 'mi-top');
      top.appendChild(el('div', 'mi-name', f.name.replace(/\.md$/, '')));
      if (f.type && MEM_TYPES()[f.type]) top.appendChild(el('span', 'mi-type ' + f.type, MEM_TYPES()[f.type]));
      // mark rows that only matched because of their TEXT — otherwise the hit looks arbitrary
      if (q && !(f.name + ' ' + (f.description || '') + ' ' + (f.type || '')).toLowerCase().includes(q)) { top.appendChild(el('span', 'mi-type mi-hit', t('views-memory.memInhaltTreffer'))); contentHits++; }
      item.appendChild(top);
      if (f.description) item.appendChild(el('div', 'mi-desc', f.description));
      item.appendChild(el('div', 'mi-meta', (f.size / 1024).toFixed(1) + ' KB · ' + relTime(f.mtime) + (f.links && f.links.length ? ' · 🔗' + f.links.length : '')));
      item.onclick = () => openMemory(g.project, f.name);
      mkClickable(item, t('views-memory.ariaMemory') + f.name);
      list.appendChild(item);
    }
  }
  if (!total) {
    list.innerHTML = '';
    // with a search active, offer the way back instead of a bare verdict (B12)
    if (q && typeof emptyFiltered === 'function') emptyFiltered(list, () => { const s = $('#memSearch'); if (s) s.value = ''; renderMemoryList(); });
    else list.appendChild(el('div', 'empty-mini', t('common.nichtsGefunden')));
    // honest hint: the filter only saw metadata + already-fetched text, so "nothing" may just mean "not scanned yet"
    if (q && !MEM_SCAN.scanned) list.appendChild(el('div', 'empty-mini mem-scan-hint', t('views-memory.memInhalteHinweis')));
  } else if (q && contentHits) { list.appendChild(el('div', 'empty-mini mem-scan-hint', t('views-memory.memInhalteGefunden').replace('{n}', contentHits))); }
  if (MEM_MODE === 'graph') renderMemGraph(); // #memSearch highlights nodes, so the map follows the filter
}
// A17: bulk-fetch the files we don't have yet, with a visible progress count (concurrency 5 — enough to
// hide the per-request latency, low enough that the local server stays responsive to everything else).
async function scanMemContents() {
  if (MEM_SCAN.running || !MEM_DATA) return;
  const todo = [];
  MEM_DATA.groups.forEach((g) => g.files.forEach((f) => { if (!MEM_TEXT.has(memKey(g.project, f.name))) todo.push({ project: g.project, name: f.name }); }));
  const btn = $('#memContentSearch'); const lbl = btn && btn.querySelector('.btxt');
  if (!todo.length) { MEM_SCAN.scanned = true; renderMemoryList(); toast(t('views-memory.memInhalteFertig').replace('{n}', MEM_TEXT.size), 'ok'); return; }
  MEM_SCAN = { running: true, done: 0, total: todo.length, scanned: false };
  if (btn) btn.disabled = true;
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const it = todo[next++];
      try {
        const r = await api('/api/memory/file?project=' + encodeURIComponent(it.project) + '&name=' + encodeURIComponent(it.name));
        MEM_TEXT.set(memKey(it.project, it.name), String(r.content || '').toLowerCase());
      } catch { MEM_TEXT.set(memKey(it.project, it.name), ''); } // don't retry a broken file on every keystroke
      MEM_SCAN.done++;
      if (lbl) lbl.textContent = t('views-memory.memInhalteGeladen').replace('{n}', MEM_SCAN.done).replace('{m}', MEM_SCAN.total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, todo.length) }, worker));
  MEM_SCAN.running = false; MEM_SCAN.scanned = true;
  if (btn) btn.disabled = false;
  if (lbl) lbl.textContent = t('views-memory.memInhalteSuchen');
  renderMemoryList();
  toast(t('views-memory.memInhalteFertig').replace('{n}', MEM_TEXT.size), 'ok');
}
// resolve a [[wiki-link]] target to a memory file within the same project
// NOTE: the local variable is `tgt`, NOT `t` — a local `t` here would shadow the global translator.
function resolveMemLink(project, target) {
  const g = (MEM_DATA && MEM_DATA.groups || []).find((x) => x.project === project);
  if (!g) return null;
  const tgt = String(target || '').toLowerCase().replace(/\.md$/, '');
  return g.files.find((f) => f.name.replace(/\.md$/, '').toLowerCase() === tgt) || null;
}
function renderMemPreview(content, project) {
  const box = $('#memPreview');
  box.innerHTML = renderMarkdown(content.replace(/^---[\s\S]*?---\s*/, ''));
  decorateCode(box);
  // turn [[name]] occurrences in text nodes into clickable links
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  const hits = []; let n;
  while ((n = walker.nextNode())) { if (/\[\[[^\]]+\]\]/.test(n.nodeValue)) hits.push(n); }
  hits.forEach((node) => {
    const frag = document.createDocumentFragment(); let last = 0; const s = node.nodeValue; const re = /\[\[([^\]]+)\]\]/g; let m;
    while ((m = re.exec(s))) {
      if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
      const tgt = m[1].trim(); const found = resolveMemLink(project, tgt);
      const a = el('span', 'wikilink' + (found ? '' : ' missing'), tgt);
      if (found) { a.onclick = () => openMemory(project, found.name); mkClickable(a, t('views-memory.ariaMemoryLink') + tgt); } else a.title = t('views-memory.nochKeineMemoryDatei');
      frag.appendChild(a); last = re.lastIndex;
    }
    if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
    node.parentNode.replaceChild(frag, node);
  });
  // MEM-LINK — and the Markdown links, which renderMarkdown has already turned into real <a href="x.md">.
  // Left alone they are the worst of the three outcomes: they LOOK like working links and they navigate the
  // panel away to http://127.0.0.1:<port>/x.md (a 404 page, panel gone, unsaved draft with it). Since the
  // CLI writes MEMORY.md exactly this way, that is the state of every link in the file this view opens on.
  // Same treatment as a [[wiki-link]] from here on: open the file in place, or mark it as not existing.
  box.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    const tgt = memoryLinkTargets('[x](' + href + ')')[0]; // one rule for „is this a memory-file link"
    if (!tgt) return;                                      // external / another directory → a normal link
    const found = resolveMemLink(project, tgt);
    const span = el('span', 'wikilink' + (found ? '' : ' missing'), a.textContent || tgt);
    if (found) { span.onclick = () => openMemory(project, found.name); mkClickable(span, t('views-memory.ariaMemoryLink') + tgt); }
    else span.title = t('views-memory.nochKeineMemoryDatei');
    a.parentNode.replaceChild(span, a);
  });
}
function renderBacklinks(project, name) {
  const box = $('#memBacklinks'); box.innerHTML = '';
  const g = (MEM_DATA && MEM_DATA.groups || []).find((x) => x.project === project); if (!g) return;
  const self = name.replace(/\.md$/, '').toLowerCase();
  const from = g.files.filter((f) => (f.links || []).some((l) => l.toLowerCase().replace(/\.md$/, '') === self));
  if (!from.length) return;
  box.appendChild(el('div', 'mem-bl-h', t('views-memory.verlinktVon')));
  from.forEach((f) => { const a = el('span', 'wikilink', f.name.replace(/\.md$/, '')); a.onclick = () => openMemory(project, f.name); mkClickable(a, t('views-memory.ariaMemory') + f.name); box.appendChild(a); });
}
function setMemMode(mode) {
  MEM_MODE = mode;
  $('#memPreview').classList.toggle('hidden', mode !== 'preview');
  $('#memEditor').classList.toggle('hidden', mode !== 'edit');
  if ($('#memGraph')) $('#memGraph').classList.toggle('hidden', mode !== 'graph');
  // The graph is a view of ALL files, so the "pick a file on the left" placeholder is both wrong and
  // greedy here — it kept half the pane and squeezed the canvas into a band. Restore it on the way out
  // only if no file is open (openMemory hides it itself).
  if ($('#memEmpty')) $('#memEmpty').classList.toggle('hidden', mode === 'graph' || !!MEM.name);
  // a11y: a segmented control is a group of toggles — .active alone is invisible to a screen reader
  [...$('#memMode').children].forEach((b) => { const on = b.dataset.m === mode; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
  if (mode === 'graph') renderMemGraph();
}
// ---- DATA-2: the unsaved draft ----
// Switching files used to blank the editor (`ed.value = ''` below) without a word, so ten minutes of
// typing were gone with one click in the list — and with no server round-trip there is nothing to
// recover from, which is exactly why this guard belongs in the BROWSER: the draft never existed anywhere
// else. Three answers, not two: „Abbrechen" has to stay reachable, otherwise the dialog itself forces the
// choice it is asking about.
function memDirty() {
  const ed = $('#memEditor');
  if (!ed || ed.disabled || !MEM.name) return false; // no file open / still loading → no draft to lose
  return ed.value !== MEM_LOADED;
}
// The reader for that state: without it the question below arrives out of nowhere.
function paintMemDirty() {
  const note = $('#memNote'); if (!note) return;
  const mark = t('views-memory.memUngespeichert');
  if (memDirty()) note.textContent = mark;
  else if (note.textContent === mark) note.textContent = ''; // don't wipe „Gespeichert ✓ · Backup"
}
async function memDraftMayGo() {
  if (!memDirty()) return true;
  const v = await uiModal({
    icon: '⚠', title: t('views-memory.memEntwurfTitel'),
    message: t('views-memory.memEntwurfFrage').replace('{name}', MEM.name),
    escValue: 'cancel',
    actions: [
      { label: t('html.abbrechen'), value: 'cancel' },
      { label: t('views-memory.memEntwurfVerwerfen'), value: 'discard', kind: 'danger-btn' },
      { label: t('common.speichern'), value: 'save', primary: true },
    ],
  });
  // a save that FAILED must not count as „draft is safe now" — the editor keeps the text and we stay put
  if (v === 'save') return await saveMemory();
  return v === 'discard';
}
async function openMemory(project, name) {
  if (!(await memDraftMayGo())) return; // DATA-2 — ask BEFORE MEM moves, so the question can name the file
  MEM = { project, name };
  renderMemoryList();
  $('#memEmpty').classList.add('hidden'); $('#memToolbar').classList.remove('hidden');
  // A1 (data loss): at this point the editor still holds the PREVIOUS file's text. If the fetch below
  // fails, an enabled Save over that stale text writes file A's content into file B. So blank and LOCK
  // the editor before the await and only re-arm it once this file's content has actually arrived.
  const ed = $('#memEditor'); ed.value = ''; ed.disabled = true;
  $('#memSave').disabled = true; $('#memNote').textContent = '';
  $('#memFileName').textContent = name;
  $('#memPreview').innerHTML = '<div class="loading">' + t('common.lade') + '</div>'; $('#memPreview').classList.remove('hidden'); $('#memEditor').classList.add('hidden');
  if ($('#memGraph')) $('#memGraph').classList.add('hidden');
  // A16: the server always refuses to delete the index (400) — a destructive confirm for an impossible
  // action is pure noise, so disable the button and say why in its tooltip.
  const isIndex = /^MEMORY\.md$/i.test(name);
  $('#memDelete').disabled = isIndex;
  $('#memDelete').title = isIndex ? t('views-memory.memRootIndex') : t('common.loeschen-2');
  try {
    const r = await api('/api/memory/file?project=' + encodeURIComponent(project) + '&name=' + encodeURIComponent(name));
    ed.value = r.content; ed.disabled = false;
    MEM_LOADED = r.content; // DATA-2: from here on, any deviation is an unsaved draft
    MEM_TEXT.set(memKey(project, name), String(r.content || '').toLowerCase()); // A17: an opened file is free search fuel
    $('#memSave').disabled = false;
    renderMemPreview(r.content, project); renderBacklinks(project, name); setMemMode('preview');
  } catch (e) {
    // A1: back to a clean empty state — no half-open file, no armed Save over foreign content
    MEM = { project: null, name: null }; MEM_LOADED = '';
    $('#memBacklinks').innerHTML = '';
    $('#memToolbar').classList.add('hidden');
    $('#memFileName').textContent = t('html.dateiWaehlen');
    $('#memPreview').classList.remove('hidden');
    errorCard($('#memPreview'), t('views-memory.memLadefehler') + e.message, () => openMemory(project, name));
    renderMemoryList();
  }
}
// A11: after saving ONE file, re-reading all ~60 via /api/memory is pure waste — everything the list
// shows (size/mtime/description/type/links) is derivable from the text we just wrote, so patch in place.
function patchMemCacheEntry(project, name, content) {
  const g = (MEM_DATA && MEM_DATA.groups || []).find((x) => x.project === project); if (!g) return;
  const f = g.files.find((x) => x.name === name); if (!f) return;
  const fm = content.match(/^---([\s\S]*?)---/);
  const head = fm ? fm[1] : '';
  const desc = (head.match(/^\s*description:\s*(.+)$/m) || [])[1];
  const type = (head.match(/\btype:\s*([\w|-]+)/) || [])[1];
  f.size = (typeof TextEncoder === 'function') ? new TextEncoder().encode(content).length : content.length;
  f.mtime = Date.now();
  if (desc != null) f.description = desc.trim().replace(/^['"]|['"]$/g, '');
  if (type != null) f.type = type.split('|')[0].trim();
  f.links = memoryLinkTargets(content);
  MEM_TEXT.set(memKey(project, name), content.toLowerCase());
}
// MEM-LINK — the browser's half of „what does this memory file link to". A deliberate mirror of
// lib/pure.js memoryLinkTargets, which this file cannot require (classic script, and the server module is
// not shipped to the browser); the duplication is PINNED — test/views-polish.test.js lifts this function
// out of the shipped source and runs both over the same table, so they cannot drift the way the prompt
// composer once did. Read the reasoning there, not twice: the short version is that `[[wiki]]` was the only
// form recognised, and the CLI writes MEMORY.md in plain Markdown (`[title](slug.md)`), so for the index
// file of the whole memory set the count was 0 and the graph had no edges.
function memoryLinkTargets(content) {
  const src = String(content == null ? '' : content);
  const out = [];
  const push = (raw) => {
    let v = String(raw == null ? '' : raw).trim();
    if (!v || v.startsWith('#')) return;
    v = v.split('#')[0].trim();
    if (!v) return;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) return;   // https:, mailto:, C: …
    if (v.startsWith('//')) return;
    if (v.includes('/') || v.includes('\\')) return;    // outside this memory dir
    out.push(v.replace(/\.md$/i, ''));
  };
  for (const m of src.matchAll(/\[\[([^\]\n]+)\]\]/g)) push(m[1]);
  for (const m of src.matchAll(/\[[^\]\n]*\]\(([^()\s]+)\)/g)) push(m[1]);
  const seen = new Set(), uniq = [];
  out.forEach((v) => { const k = v.toLowerCase(); if (!seen.has(k)) { seen.add(k); uniq.push(v); } });
  return uniq;
}
// Answers whether the file on disk now holds what the editor shows — memDraftMayGo() reads it, so a
// failed save must come back false rather than letting the draft be dropped as „saved".
async function saveMemory() {
  if (!MEM.name) return false;
  try {
    const content = $('#memEditor').value;
    const r = await api('/api/memory/file', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: MEM.project, name: MEM.name, content }) });
    MEM_LOADED = content; // DATA-2: this IS the file now — the draft marker goes away
    $('#memNote').textContent = t('common.gespeichert') + (r.backup ? t('views-memory.backup') : ''); toast(t('views-memory.memoryGespeichert'), 'ok');
    renderMemPreview(content, MEM.project);
    patchMemCacheEntry(MEM.project, MEM.name, content); // A11: one file changed → patch, don't refetch 60
    renderMemoryList(); renderBacklinks(MEM.project, MEM.name);
    return true;
  } catch (e) { toast(e.message, 'err'); return false; }
}
$('#memSave').onclick = saveMemory;
if ($('#memEditor')) $('#memEditor').addEventListener('input', paintMemDirty); // DATA-2: say it while it is true
$('#memReload').onclick = () => loadMemory(true);
$('#memSearch').addEventListener('input', debounce(renderMemoryList));
if ($('#memContentSearch')) $('#memContentSearch').onclick = scanMemContents;
$('#memMode').onclick = (e) => { const b = e.target.closest('button'); if (b) setMemMode(b.dataset.m); };
$('#memExport').onclick = () => { const blob = new Blob([$('#memEditor').value], { type: 'text/markdown' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = MEM.name || 'memory.md'; a.click(); URL.revokeObjectURL(url); };
$('#memDelete').onclick = async () => {
  if (!MEM.name || /^MEMORY\.md$/i.test(MEM.name)) return; // A16: guarded twice — the button is also disabled
  if (!(await uiConfirm(t('views-memory.memory') + MEM.name + t('views-memory.loeschenInsBackupVerschoben'), { title: t('views-memory.memoryLoeschen'), danger: true, okLabel: t('common.loeschen-2') }))) return;
  try { await api('/api/memory/file/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: MEM.project, name: MEM.name }) }); toast(t('views-memory.geloeschtBackup'), 'ok'); MEM_TEXT.delete(memKey(MEM.project, MEM.name)); MEM = { project: null, name: null }; $('#memToolbar').classList.add('hidden'); $('#memPreview').innerHTML = ''; $('#memBacklinks').innerHTML = ''; $('#memEmpty').classList.remove('hidden'); loadMemory(true); }
  catch (e) { toast(e.message, 'err'); }
};
$('#memNew').onclick = async () => {
  const groups = (MEM_DATA && MEM_DATA.groups) || [];
  if (!groups.length) { toast(t('views-memory.keinProjektMitMemory'), 'err'); return; }
  // A2: the old default was g[0] — raw readdir order, which here is a 5-file side project, not the
  // 55-file working set. Prefer the group matching STATE.defaultCwd, else the one with the most files.
  const norm = (s) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const want = norm(STATE && STATE.defaultCwd);
  const byPath = want ? groups.find((g) => norm(g.projectPath) === want) : null;
  const def = byPath || groups.slice().sort((a, b) => b.files.length - a.files.length)[0];
  const body = el('div', 'mem-new-form');
  body.appendChild(el('label', 'ui-flabel', t('views-memory.memNeuProjekt')));
  const sel = el('select', 'ui-input'); sel.style.width = '100%';
  groups.forEach((g) => { const o = el('option'); o.value = g.project; o.textContent = g.projectPath + '  ·  ' + t('views-memory.nDateien').replace('{n}', g.files.length); sel.appendChild(o); });
  sel.value = def.project;
  body.appendChild(sel);
  body.appendChild(el('label', 'ui-flabel', t('views-memory.memNeuName')));
  const nameInp = el('input', 'ui-input'); nameInp.style.width = '100%'; nameInp.placeholder = 'mein-fakt';
  body.appendChild(nameInp);
  const pathLine = el('div', 'mem-new-path'); body.appendChild(pathLine);
  const slugOf = (v) => (String(v || '').trim().replace(/[^\w.-]/g, '-').replace(/\.md$/, '') || '…') + '.md';
  // show the resulting path BEFORE creating — that is what makes the project choice checkable
  const paint = () => { const g = groups.find((x) => x.project === sel.value) || def; pathLine.textContent = t('views-memory.memNeuPfad') + ' ' + g.projectPath.replace(/[\\/]+$/, '') + '/memory/' + slugOf(nameInp.value); };
  paint();
  sel.onchange = paint; nameInp.addEventListener('input', paint);
  nameInp.addEventListener('keydown', (e) => { if (e.key !== 'Enter') return; e.preventDefault(); const ok = body.closest('.modal') && body.closest('.modal').querySelector('.primary-btn'); if (ok) ok.click(); });
  const p = uiModal({ icon: '✎', title: t('views-memory.neueMemory'), body, escValue: false, actions: [{ label: t('html.abbrechen'), value: false }, { label: t('common.anlegen'), value: true, primary: true }] });
  setTimeout(() => nameInp.focus(), 0); // queued after uiModal's own focus call, so the name field wins
  if (!(await p)) return;
  const raw = nameInp.value.trim(); if (!raw) return;
  const slug = raw.replace(/[^\w.-]/g, '-').replace(/\.md$/, '') + '.md';
  const project = sel.value;
  const tmpl = '---\nname: ' + slug.replace(/\.md$/, '') + '\ndescription: ' + t('views-memory.einzeiligeZusammenfassung') + '\nmetadata:\n  type: project\n---\n\n' + t('views-memory.derFakt') + '\n';
  try {
    // DATA-3: `create: true` → the route refuses a name that already exists in any capitalisation (NTFS
    // would have overwritten the other spelling). The check cannot live here: this list is a snapshot,
    // and the CLI writes memory files itself.
    await api('/api/memory/file', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, name: slug, content: tmpl, create: true }) });
    toast(t('views-memory.angelegt'), 'ok'); await loadMemory(true); openMemory(project, slug); setMemMode('edit');
  } catch (e) {
    // the refusal names the file that is in the way — offer it instead of a dead end
    if (e.code === 'exists') {
      const existing = (e.data && e.data.existing) || slug;
      if (await uiConfirm(t('views-memory.memExistiert').replace('{name}', existing), { title: t('views-memory.neueMemory'), okLabel: t('views-memory.memOeffnen') })) { await loadMemory(true); openMemory(project, existing); }
      return;
    }
    toast(e.message, 'err');
  }
};

// ============================================================
//  F-Graph — the memory link graph
//  Everything is already client-side: /api/memory gives per file { name, size, type, links[] } and
//  resolveMemLink() turns a [[target]] into a file. Unresolvable targets (prose ABOUT the [[…]] syntax,
//  e.g. "[[wiki-links]]") are DROPPED by default — turning them into nodes would invent hub files that
//  do not exist. A toggle shows them as dashed stubs hanging off their source, never as shared nodes.
// ============================================================
let MEM_GRAPH_PROJECT = null;   // which project group the graph shows
let MEM_GRAPH_GHOSTS = false;   // show unresolvable link targets as dashed stubs
let MEM_GRAPH_STATS = null;     // { nodes, edges, ms } — also rendered into the footer
const MEM_LAYOUTS = new Map();  // signature -> [{ name, x, y }] — memo, so a re-render keeps the same map
const MEM_TYPE_VAR = { user: '--viz-1', project: '--viz-2', reference: '--viz-3', feedback: '--accent' };
const GRAPH_W = 900, GRAPH_H = 560, GRAPH_FR_MAX = 200; // above GRAPH_FR_MAX nodes: pure circle (FR is O(n²))

function memGraphData(project) {
  const g = (MEM_DATA && MEM_DATA.groups || []).find((x) => x.project === project);
  if (!g) return { nodes: [], edges: [], ghosts: [] };
  const nodes = g.files.map((f) => ({ name: f.name, label: f.name.replace(/\.md$/, ''), type: f.type || '', size: f.size || 0, links: (f.links || []).length, x: 0, y: 0, deg: 0 }));
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const edges = [], ghosts = [];
  g.files.forEach((f) => {
    (f.links || []).forEach((l) => {
      const hit = resolveMemLink(project, l);
      const from = byName.get(f.name);
      if (!from) return;
      if (!hit || hit.name === f.name) { ghosts.push({ from, target: l }); return; } // unresolvable (or self) → no fake hub
      const to = byName.get(hit.name); if (!to) return;
      edges.push({ from, to });
      from.deg++; to.deg++;
    });
  });
  return { nodes, edges, ghosts };
}
// Deterministic layout: circular seed ordered by type+name, then Fruchterman–Reingold for a FIXED number
// of iterations. No RNG anywhere — the same file set must always produce the same picture, otherwise the
// map reshuffles on every re-render and stops being recognisable. Memoised per node/edge signature.
function memGraphLayout(nodes, edges) {
  const sig = nodes.length + '|' + edges.length + '|' + nodes.map((n) => n.name).join(',');
  const memo = MEM_LAYOUTS.get(sig);
  // memo hit → reuse the coordinates AND report the originally measured cost (not 0, which would
  // make the footer claim a free layout)
  if (memo) { const m = new Map(memo.pos.map((p) => [p.name, p])); nodes.forEach((n) => { const p = m.get(n.name); if (p) { n.x = p.x; n.y = p.y; } }); return memo.ms; }
  const t0 = (performance && performance.now) ? performance.now() : Date.now();
  const n = nodes.length; if (!n) return 0;
  const pad = 46, W = GRAPH_W, H = GRAPH_H;
  const seed = nodes.slice().sort((a, b) => (a.type || '~~').localeCompare(b.type || '~~') || a.label.localeCompare(b.label));
  const R = Math.min(W, H) * 0.38;
  seed.forEach((nd, i) => { const a = -Math.PI / 2 + (i / n) * 2 * Math.PI; nd.x = W / 2 + R * Math.cos(a); nd.y = H / 2 + R * Math.sin(a); });
  if (n > 1 && n <= GRAPH_FR_MAX) {
    const iters = 150, k = Math.sqrt((W * H) / n);
    let temp = Math.min(W, H) * 0.09; const cool = temp / (iters + 1);
    const dx = new Float64Array(n), dy = new Float64Array(n);
    const idx = new Map(nodes.map((nd, i) => [nd, i]));
    for (let it = 0; it < iters; it++) {
      dx.fill(0); dy.fill(0);
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {            // repulsion (all pairs)
        let vx = nodes[i].x - nodes[j].x, vy = nodes[i].y - nodes[j].y;
        let d = Math.sqrt(vx * vx + vy * vy); if (d < 0.01) { vx = (i - j) * 0.01 + 0.01; vy = 0.01; d = 0.02; }
        const f = (k * k) / d, ux = vx / d, uy = vy / d;
        dx[i] += ux * f; dy[i] += uy * f; dx[j] -= ux * f; dy[j] -= uy * f;
      }
      for (const e of edges) {                                                  // attraction (along edges)
        const i = idx.get(e.from), j = idx.get(e.to); if (i == null || j == null) continue;
        let vx = nodes[i].x - nodes[j].x, vy = nodes[i].y - nodes[j].y;
        const d = Math.sqrt(vx * vx + vy * vy) || 0.01;
        const f = (d * d) / k, ux = vx / d, uy = vy / d;
        dx[i] -= ux * f; dy[i] -= uy * f; dx[j] += ux * f; dy[j] += uy * f;
      }
      for (let i = 0; i < n; i++) {
        const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1, step = Math.min(d, temp);
        nodes[i].x = Math.max(pad, Math.min(W - pad, nodes[i].x + (dx[i] / d) * step));
        nodes[i].y = Math.max(pad, Math.min(H - pad, nodes[i].y + (dy[i] / d) * step));
      }
      temp -= cool;
    }
  }
  const ms = ((performance && performance.now) ? performance.now() : Date.now()) - t0;
  MEM_LAYOUTS.set(sig, { pos: nodes.map((nd) => ({ name: nd.name, x: nd.x, y: nd.y })), ms });
  return ms;
}
function renderMemGraph() {
  const host = $('#memGraph'); if (!host) return;
  host.innerHTML = '';
  const groups = (MEM_DATA && MEM_DATA.groups) || [];
  if (!groups.length) { host.appendChild(el('div', 'empty-mini', t('views-memory.graphLeer'))); return; }
  // svgEl/cssVar live in views-usage.js — guard in case the load order ever changes (classic scripts)
  if (typeof svgEl !== 'function' || typeof cssVar !== 'function') { host.appendChild(el('div', 'empty-mini', t('views-memory.graphKeineHelfer'))); return; }
  // default group: the one holding the open file, else the biggest (the real working set)
  if (!groups.some((g) => g.project === MEM_GRAPH_PROJECT)) {
    MEM_GRAPH_PROJECT = (MEM.project && groups.some((g) => g.project === MEM.project)) ? MEM.project
      : groups.slice().sort((a, b) => b.files.length - a.files.length)[0].project;
  }
  const project = MEM_GRAPH_PROJECT;
  // --- toolbar: group selector + ghost toggle ---
  const bar = el('div', 'mg-bar');
  if (groups.length > 1) {
    const seg = el('span', 'seg mg-groups'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', t('views-memory.graphProjekt'));
    groups.forEach((g) => {
      const b = el('button', g.project === project ? 'active' : null, g.projectPath.split(/[\\/]/).filter(Boolean).pop() + ' (' + g.files.length + ')');
      b.type = 'button'; b.title = g.projectPath;
      b.setAttribute('aria-pressed', g.project === project ? 'true' : 'false');
      b.onclick = () => { MEM_GRAPH_PROJECT = g.project; renderMemGraph(); };
      seg.appendChild(b);
    });
    bar.appendChild(seg);
  }
  const gh = el('label', 'mg-ghost-toggle'); gh.title = t('views-memory.graphGeisterTitel');
  const cb = el('input'); cb.type = 'checkbox'; cb.checked = MEM_GRAPH_GHOSTS;
  cb.onchange = () => { MEM_GRAPH_GHOSTS = cb.checked; renderMemGraph(); };
  gh.appendChild(cb); gh.appendChild(el('span', null, t('views-memory.graphGeister')));
  bar.appendChild(gh);
  const foot = el('span', 'mg-foot'); bar.appendChild(foot);
  host.appendChild(bar);

  const { nodes, edges, ghosts } = memGraphData(project);
  if (!nodes.length) { host.appendChild(el('div', 'empty-mini', t('views-memory.graphLeer'))); return; }
  const ms = memGraphLayout(nodes, edges);
  MEM_GRAPH_STATS = { project, nodes: nodes.length, edges: edges.length, ghosts: ghosts.length, ms: Math.round(ms * 10) / 10 };
  foot.textContent = t('views-memory.graphFuss').replace('{n}', nodes.length).replace('{e}', edges.length).replace('{ms}', MEM_GRAPH_STATS.ms) + (ghosts.length ? ' · ' + t('views-memory.graphNGeister').replace('{n}', ghosts.length) : '');

  const q = ($('#memSearch').value || '').toLowerCase();
  const maxSize = Math.max(1, ...nodes.map((n) => n.size));
  const colOf = (ty) => cssVar(MEM_TYPE_VAR[ty] || '--text-faint');
  const wrap = el('div', 'mg-canvas');
  const svg = svgEl('svg', { viewBox: '0 0 ' + GRAPH_W + ' ' + GRAPH_H, class: 'mg-svg', 'aria-hidden': 'true', focusable: 'false' });
  const gEdges = svgEl('g', { class: 'mg-edges' }), gNodes = svgEl('g', { class: 'mg-nodes' });
  const tip = el('div', 'chart-tip');
  // adjacency, so hover can dim everything that is NOT connected — pure classList work, no re-render
  const adj = new Map(nodes.map((n) => [n, new Set([n])]));
  const inc = new Map(nodes.map((n) => [n, []]));
  edges.forEach((e) => {
    // quadratic Bézier: control point pushed perpendicular to the chord so parallel edges stay tellable apart
    const mx = (e.from.x + e.to.x) / 2, my = (e.from.y + e.to.y) / 2;
    const vx = e.to.x - e.from.x, vy = e.to.y - e.from.y, len = Math.sqrt(vx * vx + vy * vy) || 1;
    const cx = mx - (vy / len) * len * 0.12, cy = my + (vx / len) * len * 0.12;
    const path = svgEl('path', { class: 'mg-edge', d: 'M' + e.from.x.toFixed(1) + ' ' + e.from.y.toFixed(1) + ' Q' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ' ' + e.to.x.toFixed(1) + ' ' + e.to.y.toFixed(1), fill: 'none', stroke: cssVar('--viz-axis'), 'stroke-width': 1.2 });
    gEdges.appendChild(path);
    adj.get(e.from).add(e.to); adj.get(e.to).add(e.from);
    inc.get(e.from).push(path); inc.get(e.to).push(path);
  });
  if (MEM_GRAPH_GHOSTS) {
    // dashed stub per (source, target) pair — deliberately NOT shared between sources, so a prose target
    // like "[[wiki-links]]" can never look like a hub that many files point at
    ghosts.forEach((gt, i) => {
      const a = (i / Math.max(1, ghosts.length)) * 2 * Math.PI;
      const ex = Math.max(12, Math.min(GRAPH_W - 12, gt.from.x + Math.cos(a) * 52));
      const ey = Math.max(12, Math.min(GRAPH_H - 12, gt.from.y + Math.sin(a) * 52));
      gEdges.appendChild(svgEl('path', { class: 'mg-edge mg-ghost-edge', d: 'M' + gt.from.x.toFixed(1) + ' ' + gt.from.y.toFixed(1) + ' L' + ex.toFixed(1) + ' ' + ey.toFixed(1), fill: 'none', stroke: cssVar('--text-faint'), 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
      const gc = svgEl('circle', { class: 'mg-ghost', cx: ex.toFixed(1), cy: ey.toFixed(1), r: 3.5, fill: 'none', stroke: cssVar('--text-faint'), 'stroke-width': 1, 'stroke-dasharray': '2 2' });
      const ttl = svgEl('title'); ttl.textContent = gt.target + ' — ' + t('views-memory.graphGeisterTitel'); gc.appendChild(ttl);
      gEdges.appendChild(gc);
    });
  }
  // This network is dense (≈2.4 edges per node), so "2+ links" labelled 52 of 55 nodes — mush again.
  // Only the strongest hubs carry a permanent label; the cutoff is the degree of the 10th-ranked node.
  const LABEL_TOP = 10;
  const degCut = nodes.length <= 24 ? 0
    : (nodes.slice().sort((a, b) => b.deg - a.deg)[Math.min(LABEL_TOP, nodes.length) - 1] || { deg: 99 }).deg;
  nodes.forEach((n) => {
    const r = 5 + Math.sqrt(n.size / maxSize) * 9; // sqrt scale: area, not radius, tracks file size
    const hit = q && (n.label.toLowerCase().includes(q) || (MEM_TEXT.get(memKey(project, n.name)) || '').includes(q));
    const c = svgEl('circle', {
      class: 'mg-node' + (hit ? ' mg-hit' : '') + (MEM.project === project && MEM.name === n.name ? ' mg-open' : ''),
      cx: n.x.toFixed(1), cy: n.y.toFixed(1), r: r.toFixed(1), fill: colOf(n.type), stroke: cssVar('--panel'), 'stroke-width': 1.5,
    });
    c.style.cursor = 'pointer';
    const named = hit || n.deg >= degCut; // hubs + search hits; the rest: hover tooltip / sr-list
    const label = svgEl('text', { class: 'mg-label' + (named ? '' : ' mg-label-quiet'), x: n.x.toFixed(1), y: (n.y + r + 10).toFixed(1), 'text-anchor': 'middle', fill: cssVar('--viz-muted'), 'font-size': 9 });
    label.textContent = n.label.length > 22 ? n.label.slice(0, 21) + '…' : n.label;
    const show = () => {
      svg.classList.add('mg-dimmed');
      adj.get(n).forEach((m) => { if (m._el) m._el.classList.add('mg-on'); if (m._lbl) m._lbl.classList.add('mg-on'); });
      inc.get(n).forEach((p) => p.classList.add('mg-on'));
      tip.style.opacity = 1;
      tip.style.left = (n.x / GRAPH_W * 100) + '%'; tip.style.top = (n.y / GRAPH_H * 100) + '%';
      tip.textContent = t('views-memory.graphKnoten').replace('{name}', n.label).replace('{size}', (n.size / 1024).toFixed(1)).replace('{n}', n.deg);
    };
    const hide = () => {
      svg.classList.remove('mg-dimmed');
      [...svg.querySelectorAll('.mg-on')].forEach((x) => x.classList.remove('mg-on'));
      tip.style.opacity = 0;
    };
    c.addEventListener('mouseenter', show); c.addEventListener('mouseleave', hide);
    c.addEventListener('click', () => openMemory(project, n.name));
    label.addEventListener('click', () => openMemory(project, n.name));
    n._el = c; n._lbl = label;
    gNodes.appendChild(c); gNodes.appendChild(label);
  });
  svg.appendChild(gEdges); svg.appendChild(gNodes);
  wrap.appendChild(svg); wrap.appendChild(tip);
  host.appendChild(wrap);
  // legend (type → colour), reusing the list badges' vocabulary
  const lg = el('div', 'mg-legend');
  Object.keys(MEM_TYPE_VAR).forEach((ty) => { const it = el('span', 'clg-item'); const d = el('span', 'clg-dot'); d.style.background = cssVar(MEM_TYPE_VAR[ty]); it.appendChild(d); it.appendChild(document.createTextNode(MEM_TYPES()[ty] || ty)); lg.appendChild(it); });
  host.appendChild(lg);
  // a11y: the SVG is aria-hidden, so the same graph is offered as a screen-reader list
  const sr = el('div', 'vhidden');
  sr.appendChild(el('h3', null, t('views-memory.graphA11yTitel')));
  const ul = el('ul');
  nodes.forEach((n) => {
    const out = edges.filter((e) => e.from === n).map((e) => e.to.label);
    const into = edges.filter((e) => e.to === n).map((e) => e.from.label);
    ul.appendChild(el('li', null, n.label + ' → ' + t('views-memory.graphLinktAuf') + ': ' + (out.join(', ') || '—') + '; ' + t('views-memory.graphVerlinktVon') + ': ' + (into.join(', ') || '—')));
  });
  sr.appendChild(ul);
  host.appendChild(sr);
}
