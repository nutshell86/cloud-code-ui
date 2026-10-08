// Part of the Claude Code Control Panel front-end (split from app.js).
// Classic scripts share one global scope; load order in index.html is authoritative: render → chat → sessions → views → commands → boot.
// This file: views-skills.js

// ============================================================
//  SKILLS
// ============================================================
let SKILLS_DATA = null, SKILL_SEL = null;
async function loadSkills() {
  $('#skillsList').innerHTML = '<div class="loading">' + t('views-skills.skillsWerdenGeladenStartet') + '</div>';
  try {
    const [j] = await Promise.all([api('/api/skills'), loadSkillFavs()]);
    SKILLS_DATA = j;
    if (Array.isArray(j.slashCommands) && j.slashCommands.length) CHAT_COMMANDS = j.slashCommands.map((c) => '/' + c);
    renderSkills();
  } catch (e) { errorCard('#skillsList', t('views-skills.skillsListeFehler') + e.message, loadSkills); } // A9: in-pane error + retry instead of a blank list
}
function skillListItem(s, source) {
  const it = el('div', 'skill-item' + (SKILL_SEL && SKILL_SEL.name === s.name && SKILL_SEL.source === source ? ' active' : ''));
  const top = el('div', 'ski-top');
  top.appendChild(el('span', 'ski-name', '/' + s.name));
  const right = el('div', 'ski-top-right');
  right.appendChild(el('span', 'ski-badge ' + source, source === 'command' ? t('common.command') : t('html.skill')));
  right.appendChild(starBtn(s.name, renderSkills));
  top.appendChild(right);
  it.appendChild(top);
  if (s.description) it.appendChild(el('div', 'ski-desc', s.description));
  it.onclick = () => openSkillDetail(s, source);
  mkClickable(it, t('views-skills.ariaSkill') + s.name);
  return it;
}
function renderSkills() {
  if (!SKILLS_DATA) return;
  const q = ($('#skillSearch').value || '').toLowerCase();
  const match = (s) => !q || (s.name + ' ' + (s.description || '')).toLowerCase().includes(q);
  const cmds = SKILLS_DATA.commands.filter(match), skills = SKILLS_DATA.skills.filter(match);
  $('#skillsCount').textContent = (SKILLS_DATA.commands.length + SKILLS_DATA.skills.length) + t('views-skills.gesamt');
  const list = $('#skillsList'); list.innerHTML = '';
  // pinned favorites across commands + skills
  const favCmds = cmds.filter((s) => isFav(s.name)), favSkills = skills.filter((s) => isFav(s.name));
  if (favCmds.length || favSkills.length) {
    list.appendChild(el('div', 'sess-group', t('common.favoriten')));
    favCmds.forEach((s) => list.appendChild(skillListItem(s, 'command')));
    favSkills.forEach((s) => list.appendChild(skillListItem(s, 'skill')));
  }
  if (cmds.length) { list.appendChild(el('div', 'sess-group', t('views-skills.deineCommandsEditierbar'))); cmds.forEach((s) => list.appendChild(skillListItem(s, 'command'))); }
  if (skills.length) { list.appendChild(el('div', 'sess-group', t('views-skills.verfuegbareSkills'))); skills.forEach((s) => list.appendChild(skillListItem(s, 'skill'))); }
  if (!cmds.length && !skills.length) {
    // "nichts gefunden" with an active search is a dead end — offer the reset (B12)
    if (q && typeof emptyFiltered === 'function') emptyFiltered(list, () => { $('#skillSearch').value = ''; renderSkills(); });
    else list.innerHTML = '<div class="empty-mini">' + t('common.nichtsGefunden') + '</div>';
  }
}
// parse a markdown body into an ordered "Ablaufplan" (steps)
function skillFlow(md) {
  const lines = String(md || '').replace(/^---[\s\S]*?---\s*/, '').split('\n');
  const h2 = []; let cur = null;
  for (const ln of lines) {
    const mh = ln.match(/^##\s+(.*)$/);
    if (mh) { cur = { title: mh[1].replace(/[#*`]/g, '').trim(), subs: [] }; h2.push(cur); continue; }
    const mb = ln.match(/^\s*(?:\d+\.|[-*])\s+(.*)$/);
    if (mb && cur) { const t = mb[1].replace(/\*\*/g, '').trim(); if (t.length > 2 && cur.subs.length < 6) cur.subs.push(t.length > 90 ? t.slice(0, 88) + '…' : t); }
  }
  if (h2.length >= 2) return h2;
  // fallback: top-level numbered list
  const steps = [];
  for (const ln of lines) { const m = ln.match(/^\s*\d+\.\s+(.*)$/); if (m) { const t = m[1].replace(/\*\*/g, '').trim(); steps.push({ title: t.length > 100 ? t.slice(0, 98) + '…' : t, subs: [] }); } }
  return steps.length >= 2 ? steps : null;
}
async function openSkillDetail(s, source) {
  SKILL_SEL = { name: s.name, source };
  renderSkills();
  const d = $('#skillDetail'); d.innerHTML = '<div class="loading">' + t('common.lade') + '</div>';
  let j; try { j = await api('/api/skill?source=' + source + '&name=' + encodeURIComponent(s.name)); } catch (e) { errorCard(d, t('views-skills.skillDetailFehler') + e.message, () => openSkillDetail(s, source)); return; }
  d.innerHTML = '';
  const head = el('div', 'skd-head');
  const h = el('h2'); h.textContent = '/' + s.name; head.appendChild(h);
  head.appendChild(el('span', 'ski-badge ' + source, source === 'command' ? t('common.command') : t('html.skill')));
  d.appendChild(head);
  if (s.description) d.appendChild(el('div', 'skd-desc', s.description));
  // actions
  const acts = el('div', 'skd-actions');
  const use = iconBtn('primary-btn', 'chat', { label: t('views-skills.imChatVerwenden') }); use.onclick = () => useSkill(s.name); acts.appendChild(use);
  if (source === 'command') { const e = iconBtn('ghost-btn', 'edit', { label: t('common.bearbeiten') }); e.onclick = () => openCfg('commands', s.name); acts.appendChild(e); }
  if (j.available) {
    const ex = iconBtn('ghost-btn', 'download', { label: t('views-skills.exportMd') }); ex.onclick = () => { const blob = new Blob([j.content], { type: 'text/markdown' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = s.name + '.md'; a.click(); URL.revokeObjectURL(url); toast(t('commands.exportiert') + s.name + '.md', 'ok'); }; acts.appendChild(ex);
    const dup = iconBtn('ghost-btn', 'fork', { label: t('views-skills.duplizieren') }); dup.onclick = async () => { const target = await uiPrompt(t('views-skills.neuerCommandName'), s.name + '-copy', { title: t('views-skills.commandDuplizieren'), okLabel: t('views-skills.duplizieren') }); if (!target) return; try { const r = await api('/api/skill/duplicate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: s.name, source, target }) }); toast(t('views-skills.dupliziert') + r.name, 'ok'); await loadSkills(); openSkillDetail({ name: r.name, description: s.description }, 'command'); } catch (e) { toast(e.message, 'err'); } }; acts.appendChild(dup);
    // convert this skill into a GUI-driven UI Skill (scaffolds a <name>-ui command with a ui-skill manifest,
    // then jumps to the UI-Skills builder). Reuses the same converter as the UI-Skills "Aus Skill…" picker.
    const conv = iconBtn('ghost-btn', 'sparkle', { label: t('views-skills.inUiSkillUmwandeln') });
    conv.onclick = async () => { conv.disabled = true; try { await convertToUiSkill(s.name, source); if (typeof showView === 'function') showView('uiskills'); } finally { conv.disabled = false; } };
    acts.appendChild(conv);
  }
  d.appendChild(acts);
  // frontmatter chips
  const fm = j.frontmatter || {};
  const chips = el('div', 'skd-meta');
  Object.keys(fm).filter((k) => k !== 'description').forEach((k) => { const c = el('span', 'skd-chip'); c.textContent = k + ': ' + fm[k]; chips.appendChild(c); });
  if (/\$ARGUMENTS/.test(j.content || '')) { const c = el('span', 'skd-chip arg'); c.textContent = '$ARGUMENTS'; chips.appendChild(c); }
  if (j.path) { const c = el('span', 'skd-chip path'); c.textContent = j.path; chips.appendChild(c); }
  if (chips.childElementCount) d.appendChild(chips);
  if (!j.available) { d.appendChild(el('div', 'skd-note', t('views-skills.inhaltNichtLokalVerfuegbar'))); return; }
  // Ablaufplan
  const flow = skillFlow(j.content);
  if (flow) {
    const fs = el('div', 'skd-section'); fs.appendChild(el('h3', null, t('views-skills.ablaufplan')));
    const fl = el('ol', 'skd-flow');
    flow.forEach((st) => { const li = el('li'); li.appendChild(el('div', 'sf-title', st.title)); if (st.subs && st.subs.length) { const ul = el('ul', 'sf-subs'); st.subs.forEach((x) => ul.appendChild(el('li', null, x))); li.appendChild(ul); } fl.appendChild(li); });
    fs.appendChild(fl); d.appendChild(fs);
  }
  // full body
  const bs = el('div', 'skd-section'); bs.appendChild(el('h3', null, t('views-skills.inhalt')));
  const body = el('div', 'skd-body bubble'); body.innerHTML = renderMarkdown(j.content.replace(/^---[\s\S]*?---\s*/, '')); decorateCode(body);
  bs.appendChild(body); d.appendChild(bs);
}
function useSkill(name) {
  $$('.nav-item').forEach((b) => b.classList.remove('active'));
  $('.nav-item[data-view="chat"]').classList.add('active');
  $$('.view').forEach((v) => v.classList.remove('active'));
  $('#view-chat').classList.add('active');
  const inp = $('#composerInput'); inp.value = '/' + name + ' '; inp.focus(); autoGrow(); hideSlash();
  toast(t('views-skills.eingefuegt') + name + t('views-skills.argumenteAnpassenUndSenden'), 'ok');
}
$('#skillSearch').addEventListener('input', debounce(renderSkills));
$('#skillsReload').onclick = loadSkills;
$('#cmdNew').onclick = () => newCfg('commands', t('views-skills.descriptionWasDieserCommand'));

