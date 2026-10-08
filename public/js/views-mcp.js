// Part of the Claude Code Control Panel front-end (split from app.js).
// Classic scripts share one global scope; load order in index.html is authoritative: render → chat → sessions → views → commands → boot.
// This file: views-mcp.js

// ============================================================
//  MCP & PLUGINS
// ============================================================
// H6 — `s.status` is whatever the CLI's health check printed, and when a server is down that is a whole
// stack of prose („✗ failed: MCP error -32000: Connection closed / spawn uvx ENOENT / …"). It went into
// the pill verbatim, and .status-pill is `white-space: nowrap; flex: none`, so one broken server stretched
// its card across the grid and pushed the name out of view.
//
// Shortening it is the easy half. The half that matters: THE FULL TEXT MUST STAY REACHABLE. That error
// is the only thing in the panel that says why the server is down — cutting it to fit would trade a
// layout bug for a missing diagnosis, which is the same mistake in a nicer shape. So: the pill carries
// the short form plus the whole thing in its `title`, and the warning line below the pill becomes a
// <details> whose open body holds the untouched text, verbatim and selectable.
// turnEndClip() (public/js/turn-end.js) is the panel's existing one-line clipper — same collapse of
// whitespace, same ellipsis, no second implementation.
var MCP_PILL_CHARS = 42, MCP_ATTENTION_CHARS = 150;
function mcpShort(s, max) {
  if (typeof turnEndClip === 'function') return turnEndClip(s, max);
  var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
// true when the short form really dropped something — only then is an expander honest
function mcpWasCut(s, max) { return mcpShort(s, max) !== String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
// „nicht erreichbar" + the CLI's reason + what to do about it. A short reason stays a plain line (nothing
// to expand); a long one becomes a fold whose body is the raw text, so the diagnosis is one click away
// instead of gone.
//
// The hint („‚Neu verbinden' im Detail") is a SIBLING of the fold, never a child of it. The first version
// appended it inside the <details>, which hid the only instruction in the card behind a closed fold —
// i.e. precisely in the long-error case this function exists for, while a short error kept it in the line
// and the version before the PR showed it always. That is the same defect as a truncated error text one
// level up: not the diagnosis is missing, but what to do with it.
// The summary tooltip carries the raw reason FIRST and the „expand" wording after it, because at a closed
// fold the hover is the only complete answer to „why is it down" the card has.
function mcpAttention(status) {
  const raw = String(status == null ? '' : status).trim();
  const lead = t('views-mcp.nichtErreichbar-2');
  const tail = t('views-mcp.neuVerbindenImDetail');
  if (!raw || !mcpWasCut(raw, MCP_ATTENTION_CHARS)) {
    const d = el('div', 'm-attention', lead + (raw ? ' — ' + raw.replace(/\s+/g, ' ') : '') + tail);
    if (raw) d.title = raw;
    return d;
  }
  const box = el('div', 'm-attention'); // carries the warning colour/spacing the fold used to carry itself
  const det = el('details', 'm-attention-fold');
  const sum = el('summary', null, lead + ' — ' + mcpShort(raw, MCP_ATTENTION_CHARS));
  sum.title = raw + '\n\n' + t('views-mcp.vollerFehler');
  det.appendChild(sum);
  // textContent, not innerHTML: a CLI error may contain < > and must be shown as the CLI wrote it
  const body = el('pre', 'm-attention-raw'); body.textContent = raw;
  det.appendChild(body);
  box.appendChild(det);
  box.appendChild(el('div', 'm-hint', tail.replace(/^\s*[—·-]\s*/, '')));
  return box;
}
function cachedTools() { try { return JSON.parse(localStorage.getItem('cc_mcp_tools') || 'null'); } catch { return null; } }
let MCP_SERVERS = [], MCP_TOOLS = null; // MCP_TOOLS = probe result { tools:{ <name>:{tools,version,error,transport,ts} }, ts }
// per-server tools — prefer the direct MCP probe (/api/mcp/tools: asks each reachable stdio server via
// the MCP protocol, no chat needed) and fall back to the chat-init snapshot; report WHY it's empty.
function mcpToolsInfo(name) {
  if (MCP_TOOLS && MCP_TOOLS.tools && MCP_TOOLS.tools[name]) {
    const r = MCP_TOOLS.tools[name];
    if (r.probing) return { names: [], probing: true, source: 'probe' };
    return { names: (r.tools || []).map((t) => t.name), version: r.version || '', error: r.error || '', transport: r.transport || '', ts: r.ts, source: 'probe' };
  }
  const c = cachedTools();
  if (c && Array.isArray(c.tools)) { const pre = 'mcp__' + name + '__'; const names = c.tools.filter((t) => t.startsWith(pre)).map((t) => t.slice(pre.length)); if (names.length) return { names, version: '', error: '', ts: c.ts, source: 'chat' }; }
  return { names: [], version: '', error: '', source: 'none' };
}
// Probe each server INDIVIDUALLY (parallel) so every card updates the moment its own probe finishes
// (npx servers take ~9s, node ~0.4s) — real per-server progress instead of one long all-or-nothing wait.
async function loadMcpTools(force) {
  const servers = MCP_SERVERS || [];
  if (!servers.length) return;
  MCP_TOOLS = (MCP_TOOLS && MCP_TOOLS.tools) ? MCP_TOOLS : { tools: {}, ts: Date.now() };
  const btn = $('#mcpToolsBtn'); const lbl = btn && btn.querySelector('.btxt');
  if (btn) btn.disabled = true;
  servers.forEach((s) => { MCP_TOOLS.tools[s.name] = { probing: true }; }); // spinner per card
  renderMcpServers(servers);
  let done = 0;
  await Promise.all(servers.map(async (s) => {
    try { const r = await api('/api/mcp/tools?name=' + encodeURIComponent(s.name) + (force ? '&force=1' : '')); MCP_TOOLS.tools[s.name] = (r.tools && r.tools[s.name]) || { error: t('views-mcp.keineAntwort') }; }
    catch (e) { MCP_TOOLS.tools[s.name] = { error: e.message }; }
    MCP_TOOLS.ts = Date.now(); done++;
    if (lbl) lbl.textContent = t('views-mcp.frageAb') + done + '/' + servers.length;
    renderMcpServers(servers); // reflect this server's result immediately (progress)
  }));
  if (btn) btn.disabled = false; if (lbl) lbl.textContent = t('views-mcp.toolsAbfragen');
}
function transportIcon(tr) { return /http|sse/i.test(tr) ? '🌐' : /stdio|npx|node|cmd|uvx|python/i.test(tr) ? '⌨' : '🔌'; }
async function reprobeOne(name) { // re-query one server's tools and merge into MCP_TOOLS
  const r = await api('/api/mcp/tools?force=1&name=' + encodeURIComponent(name));
  MCP_TOOLS = MCP_TOOLS || { tools: {}, ts: Date.now() };
  MCP_TOOLS.tools = MCP_TOOLS.tools || {}; Object.assign(MCP_TOOLS.tools, r.tools || {}); MCP_TOOLS.ts = r.ts;
}
function renderMcpServers(servers) {
  MCP_SERVERS = servers || [];
  const grid = $('#mcpGrid'); grid.innerHTML = '';
  if (!servers.length) { grid.innerHTML = '<div class="empty-mini">' + t('views-mcp.keineMcpServerKonfiguriert') + '</div>'; return; }
  const q = ($('#mcpToolSearch') && $('#mcpToolSearch').value || '').toLowerCase();
  // health summary + tool-probe age (Phase 4/3)
  const okN = servers.filter((s) => s.ok).length;
  const pendingN = servers.filter((s) => s.ok !== true && s.ok !== false).length; // health not resolved
  const anyUnknown = servers.some((s) => s.healthUnknown);
  const summary = el('div', 'm-summary', pendingN
    ? ('🖧 ' + servers.length + t('views-mcp.server') + (anyUnknown ? t('views-mcp.statusUnbekannt') : t('views-mcp.pruefeStatus')))
    : ('🖧 ' + servers.length + t('views-mcp.server') + okN + t('views-mcp.verbunden') + (okN < servers.length ? ' · ' + (servers.length - okN) + t('views-mcp.nichtErreichbar') : '')));
  if (MCP_TOOLS && MCP_TOOLS.ts) summary.appendChild(el('span', 'm-summary-ts', t('views-mcp.toolsAbgefragt') + relTime(MCP_TOOLS.ts)));
  grid.appendChild(summary);
  if (!MCP_TOOLS && !cachedTools()) grid.appendChild(el('div', 'm-tools-hint', t('views-mcp.nochKeineToolListe')));
  const sorted = servers.slice().sort((a, b) => (b.ok ? 1 : 0) - (a.ok ? 1 : 0)); // connected first
  let shown = 0;
  for (const s of sorted) {
    const info = mcpToolsInfo(s.name);
    const tools = info.names;
    const matchTools = q ? tools.filter((t) => t.toLowerCase().includes(q)) : tools;
    if (q && !matchTools.length && !s.name.toLowerCase().includes(q)) continue; // tool search filters cards
    shown++;
    const checking = (s.ok !== true && s.ok !== false); // health not resolved → neutral state
    const unknown = checking && s.healthUnknown; // health check ran but gave nothing (kept from config)
    // Two sources can disagree, and one of them is demonstrably right: the CLI health check gives up
    // after 30 s, while our own probe just listed this server's tools (a `uvx pkg@latest` server needs
    // ~28 s to start). Calling that server "nicht erreichbar" is simply false — it is SLOW.
    const slowNotDown = s.ok === false && info.source === 'probe' && tools.length > 0;
    const item = el('div', 'mcp-item' + (s.ok === false && !slowNotDown ? ' down' : ''));
    const top = el('div', 'm-top');
    const nm = el('span', 'm-name'); nm.appendChild(el('span', 'm-icon', transportIcon(s.transport))); nm.appendChild(el('span', null, s.name));
    if (info.version) nm.appendChild(el('span', 'm-verchip', 'v' + info.version)); // real server version (serverInfo)
    top.appendChild(nm);
    const st = el('span', 'status-pill ' + (unknown ? 'unknown' : checking ? 'checking' : slowNotDown ? 'unknown' : (s.ok ? 'ok' : 'bad')));
    st.textContent = unknown ? t('views-mcp.unbekannt') : checking ? t('views-mcp.pruefe') : slowNotDown ? t('views-mcp.langsam')
      : ((s.ok ? '● ' : '○ ') + mcpShort(s.status || (s.ok ? t('views-mcp.verbunden-2') : t('views-mcp.getrennt')), MCP_PILL_CHARS));
    if (s.status) st.title = s.status; // H6: always, not only for the slow case — the pill may be the clipped one now
    top.appendChild(st);
    item.appendChild(top);
    item.appendChild(el('div', 'm-transport', s.transport));
    if (slowNotDown) item.appendChild(el('div', 'm-hint', t('views-mcp.healthTimeoutTrotzdemTools').replace('{n}', tools.length)));
    else if (s.ok === false) item.appendChild(mcpAttention(s.status));
    // server detail (lazy via /api/mcp/get)
    const detWrap = el('details', 'm-detail');
    detWrap.appendChild(el('summary', null, t('views-mcp.details')));
    const dbody = el('div', 'm-detail-body'); dbody.innerHTML = '<div class="loading">…</div>';
    detWrap.appendChild(dbody);
    let loaded = false;
    const loadDetail = async () => {
      dbody.innerHTML = '<div class="loading">…</div>';
      try {
        const j = await api('/api/mcp/get?name=' + encodeURIComponent(s.name));
        const d = j.detail || {}; dbody.innerHTML = '';
        // re-checking `mcp get` re-connects/health-checks — reflect it in the top pill live (Phase 2).
        // H6: this is the SECOND place that fills the pill, and it has to clip exactly like the first —
        // „Neu verbinden" on a failing server was otherwise enough to blow the card up again.
        if (typeof d.ok === 'boolean') {
          st.className = 'status-pill ' + (d.ok ? 'ok' : 'bad');
          const txt = d.status || (d.ok ? t('views-mcp.verbunden-2') : t('views-mcp.getrennt'));
          st.textContent = (d.ok ? '● ' : '○ ') + mcpShort(txt, MCP_PILL_CHARS);
          st.title = txt;
          s.ok = d.ok; if (d.status) s.status = d.status;
        }
        const dl = el('dl', 'm-dl');
        const add = (k, v) => { if (!v) return; dl.appendChild(el('dt', null, k)); dl.appendChild(Object.assign(el('dd', 'mono'), { textContent: v })); };
        add(t('html.scope'), d.scope); add(t('html.typ'), d.type);
        add(t('common.command'), d.command ? (d.command + (d.args ? ' ' + d.args : '')) : ''); add(t('html.url'), d.url);
        dbody.appendChild(dl);
        const envKeys = Object.keys(d.env || {});
        if (envKeys.length) { dbody.appendChild(el('div', 'm-env-h', t('views-mcp.umgebung'))); const ew = el('div', 'm-env'); envKeys.forEach((k) => ew.appendChild(el('div', 'm-env-row', k + '=' + d.env[k]))); dbody.appendChild(ew); }
        const acts = el('div', 'm-actions');
        const cfgBtn = iconBtn('mini-btn', 'copy', { label: t('views-mcp.config'), title: t('views-mcp.configKopieren') }); cfgBtn.onclick = () => copyText(j.raw || ''); acts.appendChild(cfgBtn);
        // "Neu verbinden" = re-health-check (reconnect) + refresh pill + re-probe this server's tools.
        const rc = el('button', 'mini-btn', t('views-mcp.neuVerbinden')); rc.title = t('views-mcp.frischerVerbindungsversuchStatusTools');
        rc.onclick = async () => {
          rc.disabled = true; rc.textContent = t('views-mcp.verbinde');
          try { await loadDetail(); await reprobeOne(s.name); renderMcpServers(MCP_SERVERS); }
          catch (e) { toast(e.message, 'err'); rc.disabled = false; rc.textContent = t('views-mcp.neuVerbinden'); }
        };
        acts.appendChild(rc);
        const isOAuth = /http|sse/i.test(d.type || s.transport);
        if (isOAuth) {
          const li = el('button', 'mini-btn', t('views-mcp.authentifizieren')); li.title = t('views-mcp.oauthLoginOeffnetGgf');
          li.onclick = async () => { li.disabled = true; li.textContent = t('views-mcp.login-2'); try { const r = await api('/api/mcp/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: s.name }) }); toast(r.timedOut ? t('views-mcp.loginGestartetEvtlIm') : t('views-mcp.login') + (r.output || 'ok').slice(0, 80), r.ok ? 'ok' : 'err'); } catch (e) { toast(e.message, 'err'); } li.disabled = false; li.textContent = t('views-mcp.authentifizieren'); }; acts.appendChild(li);
          const lo = el('button', 'mini-btn', t('views-mcp.logout-2')); lo.title = t('views-mcp.oauthCredentialsLoeschen');
          lo.onclick = async () => { if (!(await uiConfirm(t('views-mcp.oauthCredentialsFuer') + s.name + t('common.loeschen'), { title: t('views-mcp.oauthLogout'), danger: true, okLabel: t('common.loeschen-2') }))) return; try { await api('/api/mcp/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: s.name }) }); toast(t('views-mcp.logout'), 'ok'); } catch (e) { toast(e.message, 'err'); } }; acts.appendChild(lo);
        }
        dbody.appendChild(acts);
        dbody.appendChild(el('div', 'm-hint', t('views-mcp.mcpVerbindungenBestehenPro')));
      } catch (e) { dbody.innerHTML = ''; dbody.appendChild(el('div', 'empty-mini', e.message)); }
    };
    detWrap.addEventListener('toggle', async () => { if (!detWrap.open || loaded) return; loaded = true; await loadDetail(); });
    item.appendChild(detWrap);
    // tools — always present, with honest empty states (Phase 1)
    if (tools.length) {
      const det = el('details', 'm-tools'); if (q && matchTools.length) det.open = true;
      det.appendChild(el('summary', null, '🧩 ' + tools.length + t('views-mcp.tools') + (q && matchTools.length !== tools.length ? ' · ' + matchTools.length + t('views-mcp.treffer') : '')));
      const wrap = el('div', 'm-tool-list');
      (q ? matchTools : tools).forEach((t) => { const c = el('span', 'm-tool' + (q && t.toLowerCase().includes(q) ? ' hit' : '')); c.textContent = t; wrap.appendChild(c); });
      det.appendChild(wrap);
      item.appendChild(det);
    } else if (info.probing) {
      item.appendChild(el('div', 'm-tools-empty m-probing', t('views-mcp.frageToolsAb')));
    } else {
      const msg = info.error ? (t('views-mcp.keineTools') + info.error)
        : s.ok === false ? t('views-mcp.nichtVerbundenKeineTools')
        : !MCP_TOOLS ? t('views-mcp.toolsNochNichtAbgefragt')
        : t('views-mcp.keineToolsGemeldet');
      item.appendChild(el('div', 'm-tools-empty', msg));
    }
    // update / last-updated section — ALWAYS present so every tile has its own "⟳ prüfen" (ToDo 06)
    {
      const u = s.update;
      const verRow = el('div', 'm-ver');
      let ver = '';
      if (u) {
        if ((u.kind === 'npm' || u.kind === 'pypi') && u.latest) ver = 'v' + u.latest;
        else if (u.kind === 'git' && u.current) ver = u.branch + ' @ ' + u.current;
      }
      if (ver) verRow.appendChild(el('span', null, ver));
      const lu = u && (u.lastUpdated || u.date); // commit date / npm publish / PyPI upload / file mtime
      if (lu) { const ts = Date.parse(lu); if (!isNaN(ts)) verRow.appendChild(el('span', 'm-ver-age', t('views-mcp.aktualisiert-2') + relTime(ts))); }
      if (verRow.childElementCount) item.appendChild(verRow);
      const row = el('div', 'm-update');
      if (u) { const cls = u.updateAvailable ? 'upd' : (u.status && /fail/i.test(u.status) ? 'bad' : 'ok'); row.appendChild(el('span', 'm-badge ' + cls, u.status || u.kind)); }
      const chk = el('button', 'mini-btn m-check', t('views-mcp.pruefen')); chk.title = t('views-mcp.diesenServerAufUpdates');
      chk.onclick = () => checkOneMcp(s.name, chk);
      row.appendChild(chk);
      if (u && u.updateAvailable && u.kind === 'git') {
        const btn = el('button', 'mini-btn do-update', t('views-mcp.update'));
        btn.onclick = async () => {
          btn.disabled = true; btn.textContent = t('views-mcp.aktualisiere');
          try { await api('/api/mcp/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: s.name }) }); toast(s.name + t('views-mcp.aktualisiert'), 'ok'); checkOneMcp(s.name); }
          catch (e) { toast(t('views-mcp.updateFehlgeschlagen') + e.message, 'err'); btn.disabled = false; btn.textContent = t('views-mcp.update'); }
        };
        row.appendChild(btn);
      }
      item.appendChild(row);
    }
    const rm = iconBtn('m-remove', 'close', { size: 13, label: t('views-mcp.entfernen') }); rm.onclick = () => removeMcp(s.name); item.appendChild(rm);
    grid.appendChild(item);
  }
  // A filtered list that finds nothing gets the house treatment: say why, and offer the way out
  // (render.js emptyFiltered) — a bare "nichts gefunden" leaves you hunting for the search field.
  if (!shown) emptyFiltered(grid, () => { $('#mcpToolSearch').value = ''; renderMcpServers(MCP_SERVERS); }, t('views-mcp.keineToolsServerPassen'));
}
async function removeMcp(name) {
  if (!(await uiConfirm(t('views-mcp.mcpServer') + name + t('views-mcp.entfernenDiesAendertDeine'), { title: t('views-mcp.mcpServerEntfernen'), danger: true, okLabel: t('chat-composer.entfernen') }))) return;
  try { await api('/api/mcp/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); toast(name + t('views-mcp.entfernt'), 'ok'); loadMcp(true); }
  catch (e) { toast(t('views-mcp.entfernenFehlgeschlagen') + e.message, 'err'); }
}
// Add-server modal — openMcpOverlay/closeMcpOverlay moved to public/js/dialogs.js (C3). The WIRING stays
// here: it is not the dialog, it is what this view does with one.
$('#mcpAdd').onclick = openMcpOverlay;
$('#ma-cancel').onclick = closeMcpOverlay;
$('#ma-transport').onchange = () => { const isHttp = $('#ma-transport').value !== 'stdio'; $('#ma-http').classList.toggle('hidden', !isHttp); $('#ma-stdio').classList.toggle('hidden', isHttp); };
$('#ma-submit').onclick = async () => {
  const transport = $('#ma-transport').value;
  const body = { name: $('#ma-name').value.trim(), transport, scope: $('#ma-scope').value };
  if (!body.name) { toast(t('views-mcp.nameErforderlich'), 'err'); return; }
  if (transport === 'stdio') {
    body.command = $('#ma-command').value.trim();
    // Quote-aware: the placeholder in this very field shows a Windows path, and splitting on plain
    // whitespace tore `"C:\Program Files\x"` into two arguments.
    body.args = ($('#ma-args').value.trim().match(/(?:[^\s"]+|"[^"]*")+/g) || []).map((a) => a.replace(/^"|"$/g, ''));
    body.env = $('#ma-env').value.split('\n').map((l) => l.trim()).filter(Boolean);
  } else {
    body.url = $('#ma-url').value.trim();
    body.headers = $('#ma-headers').value.split('\n').map((l) => l.trim()).filter(Boolean);
  }
  const btn = $('#ma-submit'); btn.disabled = true; btn.textContent = t('views-mcp.fuegeHinzu');
  try {
    await api('/api/mcp/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    toast(body.name + t('views-mcp.hinzugefuegt'), 'ok');
    closeMcpOverlay();
    ['ma-name', 'ma-command', 'ma-args', 'ma-env', 'ma-url', 'ma-headers'].forEach((id) => { $('#' + id).value = ''; });
    // …and the two selects, so the next "+ Server hinzufügen" starts from the default form again
    // instead of the last transport with its fields hidden.
    $('#ma-transport').value = 'stdio'; $('#ma-scope').value = 'user'; $('#ma-transport').onchange();
    loadMcp(true);
  } catch (e) { toast(t('views-mcp.hinzufuegenFehlgeschlagen') + e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = t('html.serverHinzufuegen-2'); }
};
async function loadMcp(force) {
  if (!viewOnce('mcp', force) && MCP_SERVERS.length) { renderMcpServers(MCP_SERVERS); return; }
  const grid = $('#mcpGrid'); grid.innerHTML = '<div class="loading">' + t('views-mcp.serverWerdenGeladen') + '</div>';
  loadPlugins();
  // 1) paint tiles INSTANTLY from the health-free config list (no `claude mcp list` connect check)
  let base = [];
  try {
    const c = await api('/api/mcp/configured');
    if (c.servers && c.servers.length) { base = c.servers; $('#mcpCount').textContent = '· ' + base.length + t('views-mcp.konfiguriert'); renderMcpServers(base); }
  } catch { /* fall through to the health call */ }
  // 2) fill health in afterward — one `claude mcp list`, off the first-paint path. Health only ANNOTATES
  //    the configured set (ok/status); a transient empty/failed check must NOT wipe the known tiles
  //    (the first `claude mcp list` after a cold CLI sometimes comes back empty — retry once).
  try {
    let health = [];
    try { const r = await api('/api/mcp'); health = r.servers || []; } catch (e) { if (!base.length) throw e; }
    if (!health.length && base.length) { await new Promise((r) => setTimeout(r, 1200)); try { const r2 = await api('/api/mcp'); health = r2.servers || []; } catch { /* keep base */ } }
    if (health.length) {
      // merge by name: config = authoritative set, health supplies ok/status (+ its transport string)
      const byName = new Map(health.map((h) => [h.name, h]));
      let merged = base.length
        ? base.map((s) => { const h = byName.get(s.name); return h ? { ...s, ok: h.ok, status: h.status, transport: h.transport || s.transport } : { ...s, healthUnknown: true }; })
        : health.slice();
      if (base.length) health.forEach((h) => { if (!base.some((s) => s.name === h.name)) merged.push(h); }); // health-only extras
      $('#mcpCount').textContent = '· ' + merged.length + t('views-mcp.konfiguriert');
      renderMcpServers(merged);
      if ($('#mcpAutoProbe') && $('#mcpAutoProbe').checked) loadMcpTools();
    } else if (base.length) {
      // health unavailable → KEEP the configured tiles (mark status unknown), never wipe to empty
      renderMcpServers(base.map((s) => ({ ...s, healthUnknown: true })));
      toast(t('views-mcp.mcpStatusKonnteNicht'), 'err');
    } else {
      renderMcpServers([]);
    }
  } catch (e) { if (!base.length) errorCard(grid, t('views-mcp.mcpGridFehler') + e.message, () => loadMcp(true)); else toast(e.message, 'err'); }
}
// Bulk update check. Two rules learned the hard way: the tiles STAY on screen (this call takes tens
// of seconds — registry lookups plus a `git fetch` per repo, and blanking the grid for that long
// looks like the view broke), and the answer is MERGED onto the known servers by name instead of
// replacing them. An empty answer means "the check failed", never "you have no MCP servers" — that
// substitution is what made the button wipe the grid and then report "alle Server aktuell".
async function checkMcpUpdates() {
  const grid = $('#mcpGrid'); const btn = $('#mcpCheck'); const prev = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = t('views-mcp.pruefe'); }
  if (!MCP_SERVERS.length) grid.innerHTML = '<div class="loading">' + t('views-mcp.pruefeNpmRegistryAmp') + '</div>';
  try {
    const r = await api('/api/mcp?updates=1');
    const found = r.servers || [];
    if (!found.length) {
      // a 200 can still carry an error code (`cli-updating` while `claude update` runs) — api() only
      // translates thrown errors, so translate it here instead of showing the raw code
      const why = apiErrorText(r, t('views-mcp.keineAntwort'));
      if (MCP_SERVERS.length) renderMcpServers(MCP_SERVERS); // keep what we know
      else errorCard(grid, t('views-mcp.updatePruefungFehlgeschlagen') + why, checkMcpUpdates);
      toast(t('views-mcp.updatePruefungFehlgeschlagen') + why, 'err');
      return;
    }
    // merge: update info always, health only when this response actually carried one (the server
    // falls back to the config list when `claude mcp list` is unavailable — don't overwrite a known
    // ok/status with "unknown" in that case)
    const byName = new Map(MCP_SERVERS.map((s) => [s.name, s]));
    for (const h of found) {
      const s = byName.get(h.name);
      if (!s) { MCP_SERVERS.push(h); byName.set(h.name, h); continue; }
      s.update = h.update;
      if (typeof h.ok === 'boolean') { s.ok = h.ok; if (h.status) s.status = h.status; }
    }
    $('#mcpCount').textContent = '· ' + MCP_SERVERS.length + t('views-mcp.konfiguriert');
    renderMcpServers(MCP_SERVERS);
    const n = MCP_SERVERS.filter((s) => s.update && s.update.updateAvailable).length;
    // "aktuell" may only be claimed for servers that were really reachable — say how many weren't.
    const failed = MCP_SERVERS.filter((s) => s.update && /fail|timeout|unknown/i.test(s.update.status || s.update.kind || '')).length;
    const tail = failed ? (' · ' + failed + t('views-mcp.ohneErgebnis')) : '';
    toast((n ? (n + t('views-mcp.updateSVerfuegbar')) : t('views-mcp.alleServerAktuell')) + tail, (n || failed) ? '' : 'ok');
  } catch (e) {
    if (MCP_SERVERS.length) { renderMcpServers(MCP_SERVERS); toast(t('views-mcp.updatePruefungFehlgeschlagen') + e.message, 'err'); }
    else errorCard(grid, t('views-mcp.mcpGridFehler') + e.message, checkMcpUpdates);
  } finally { if (btn) { btn.disabled = false; btn.textContent = prev; } }
}
// check ONE server (per-tile ⟳ prüfen, ToDo 06) — merges the result onto that server + re-renders
async function checkOneMcp(name, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const info = await api('/api/mcp/check?name=' + encodeURIComponent(name));
    const s = (MCP_SERVERS || []).find((x) => x.name === name);
    if (s) { s.update = info.update || info; renderMcpServers(MCP_SERVERS); }
    const u = info.update || info;
    toast(u && u.updateAvailable ? (name + t('views-mcp.updateVerfuegbar') + (u.status || '') + ')') : (name + ': ' + ((u && u.status) || t('views-mcp.geprueft'))), u && u.updateAvailable ? '' : 'ok');
  } catch (e) { toast(t('views-mcp.updatePruefungFehlgeschlagen') + e.message, 'err'); }
  // A re-render replaces this button — but only if the server was still in the list. Restoring it
  // unconditionally is what keeps a stale tile's "⟳ prüfen" from sticking on "…" forever.
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = t('views-mcp.pruefen'); } }
}
$('#mcpReload').onclick = () => loadMcp(true);
$('#mcpCheck').onclick = checkMcpUpdates;
if ($('#mcpToolsBtn')) $('#mcpToolsBtn').onclick = () => loadMcpTools(true);
if ($('#mcpAutoProbe')) { $('#mcpAutoProbe').checked = localStorage.getItem('cc_mcp_autoprobe') === '1'; $('#mcpAutoProbe').onchange = (e) => localStorage.setItem('cc_mcp_autoprobe', e.target.checked ? '1' : '0'); } // opt-in warm-up
$('#mcpToolSearch').addEventListener('input', debounce(() => { if (MCP_SERVERS.length) renderMcpServers(MCP_SERVERS); }));
// Inventory download. A plain `location.href` looked broken: the route asks every server for its
// config (tens of seconds), and until the attachment arrives nothing on the page moves. Fetch it
// with a busy state instead, then hand the browser a blob.
$('#mcpInventory').onclick = async () => {
  const btn = $('#mcpInventory'); const lbl = btn.querySelector('.btxt'); const prev = lbl && lbl.textContent;
  btn.disabled = true; if (lbl) lbl.textContent = t('views-mcp.erzeuge');
  try {
    const r = await fetch('/api/mcp/inventory');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a'); a.href = url; a.download = 'mcp-inventory.md';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) { toast(t('views-mcp.inventarFehlgeschlagen') + e.message, 'err'); }
  finally { btn.disabled = false; if (lbl) lbl.textContent = prev; }
};
async function loadPlugins() {
  const list = $('#pluginsList'); list.innerHTML = '';
  try {
    if (!STATE) STATE = await api('/api/state');
    const plugins = STATE.enabledPlugins || {};
    const keys = Object.keys(plugins);
    if (!keys.length) { list.innerHTML = '<div class="empty-mini">' + t('views-mcp.keinePluginsAktiviert') + '</div>'; return; }
    for (const k of keys) {
      const row = el('div', 'plugin-row');
      const left = el('div', 'p-left');
      left.appendChild(el('span', 'p-name', k));
      const ver = (STATE.pluginVersions || {})[k];
      if (ver) left.appendChild(el('span', 'p-ver', 'v' + ver));
      row.appendChild(left);
      const sw = el('label', 'switch');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!plugins[k];
      cb.onchange = () => togglePlugin(k, cb.checked, cb);
      sw.appendChild(cb); sw.appendChild(el('span', 'slider'));
      row.appendChild(sw);
      list.appendChild(row);
    }
  } catch (e) { toast(e.message, 'err'); }
}
// One named change (enabledPlugins.<name>) instead of re-reading /api/state and PUTting the whole file
// back — the read and the write were two requests apart, so anything written in between was lost.
// A refused write puts the switch back.
async function togglePlugin(name, on, cb) {
  const ok = await patchSettingsFile('main', [{ op: 'set', path: ['enabledPlugins', name], value: on }], name.split('@')[0] + (on ? t('views-mcp.aktiviert') : t('views-mcp.deaktiviert')) + ' ✓');
  if (!ok) { if (cb) cb.checked = !on; return; }
  try { STATE = await api('/api/state'); } catch { /* the switch is saved; the plugin list refreshes on the next load */ }
}

