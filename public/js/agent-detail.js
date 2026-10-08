'use strict';
// ============================================================
//  Subagent detail view (#34) — everything about ONE agent, in the sidecar.
//
//  WHY: the rail row has ~220px and three short lines. Everything else about an agent — its assignment,
//  its model, what it cost, which tools it used, what it found, and above all WHAT IT IS DOING RIGHT
//  NOW — lived in a `title` tooltip: not scrollable, not copyable, gone on the next mouse move. A
//  spawned agent can run for minutes and spend real money, and the honest answer to "what is it doing?"
//  was "watch the two-second activity line and hope".
//
//  The live part is not guesswork: a backgrounded agent writes its OWN transcript as JSONL while it
//  works (`outputFile` on the launch receipt — see lib/agent-output.js). The server hands it over
//  incrementally, so this view shows the agent's actual tool calls and intermediate texts, not counters.
//
//  Reading model: the lane object is the truth about STATE (agent-lanes.js owns that), this file only
//  reads it through laneMetrics(). Nothing here writes to a lane.
// ============================================================

const AGENT_POLL_MS = 2000;      // while the agent runs; a task_progress arrives about as often
let AGENT_DETAIL = null;         // { id, tab, node, offset, timer, events, raw, showRaw }

function agentDetailStop() {
  if (AGENT_DETAIL && AGENT_DETAIL.timer) clearInterval(AGENT_DETAIL.timer);
  if (AGENT_DETAIL) AGENT_DETAIL.timer = null;
}
// The lane may have been pruned from the rail while the panel is open (the afterglow runs out after two
// minutes, agent-lanes.js). The archive on the tab keeps the last snapshot, so the detail view survives
// the row — without it, "open the details, read for three minutes" would end in an empty panel.
function agentLaneById(tab, id) {
  if (!tab || !id) return null;
  const live = (tab.agents || []).find((a) => a && a.id === id);
  if (live) return live;
  return (tab.agentArchive && tab.agentArchive[id]) || null;
}

function agentStatusLabel(m) {
  if (m.live) return tt('agent-detail.statusLaeuft');
  if (m.aborted) return tt('agent-detail.statusAbgebrochen');
  if (m.stale) return tt('agent-detail.statusKeinSignal');
  if (m.status === 'error') return tt('agent-detail.statusFehler');
  return tt('agent-detail.statusFertig');
}
function agentKv(grid, label, value, title) {
  if (value == null || value === '') return;
  const k = el('div', 'ad-k', label);
  const v = el('div', 'ad-v', String(value));
  if (title) v.title = title;
  grid.appendChild(k); grid.appendChild(v);
}
function agentSection(parent, label) {
  const s = el('section', 'ad-sec');
  s.appendChild(el('h4', 'ad-h', label));
  parent.appendChild(s);
  return s;
}

// The numbers, from the same normalised read the rail uses — so the panel can never disagree with the
// row it was opened from. Absent values stay absent instead of being zero-filled (laneMetrics keeps
// that promise; a "0 tok" that only means "nobody reported" is worse than no line).
function agentDetailFacts(sec, m, a) {
  const grid = el('div', 'ad-grid');
  const model = m.model ? ((typeof modelMenuLabel === 'function' && modelMenuLabel(m.model)) || shortModel(m.model)) : '';
  agentKv(grid, tt('agent-detail.modell'), model
    + (m.modelsUsed ? ' (' + m.modelsUsed.map(laneModelId).map(shortModel).join(' → ') + ')' : ''), m.modelRaw);
  agentKv(grid, tt('agent-detail.dauer'), Math.max(0, Math.round((m.elapsedMs || 0) / 1000)) + 's');
  if (m.tokens) agentKv(grid, tt('agent-detail.tokens'), fmtInt(m.tokens), tt('chat-render.agentTokensHinweis')); // NUM-LOC: the PANEL's language, not the browser's
  const cost = (m.usage && typeof turnCostUSD === 'function') ? turnCostUSD(m.usage, m.model) : 0;
  // No cost line for a backgrounded agent that only reported a total: cache reads cost a tenth of fresh
  // input, so a total cannot be priced. An estimate here would be a made-up number on a money field.
  if (cost > 0) agentKv(grid, tt('agent-detail.kosten'), (typeof fmtUSD === 'function') ? fmtUSD(cost) : '$' + cost.toFixed(4));
  if (m.toolUses) agentKv(grid, tt('agent-detail.toolAufrufe'), String(m.toolUses));
  const tools = [];
  if (m.reads) tools.push(m.reads + '× Read');
  if (m.searches) tools.push(m.searches + '× Search');
  if (m.bash) tools.push(m.bash + '× Bash');
  if (m.edits) tools.push(m.edits + '× Edit');
  if (tools.length) agentKv(grid, tt('agent-detail.werkzeuge'), tools.join(' · '));
  if (m.linesAdded || m.linesRemoved) agentKv(grid, tt('agent-detail.zeilen'), '+' + (m.linesAdded || 0) + ' / −' + (m.linesRemoved || 0));
  if (m.bg) agentKv(grid, tt('agent-detail.ausfuehrung'), m.sessionUrl ? tt('agent-detail.remote') : tt('agent-detail.hintergrund'));
  if (m.worktreeBranch) agentKv(grid, tt('agent-detail.worktree'), m.worktreeBranch);
  else if (m.isolation && m.isolation !== 'none') agentKv(grid, tt('agent-detail.isolation'), m.isolation);
  if (m.depth > 1) agentKv(grid, tt('agent-detail.tiefe'), String(m.depth) + ' ' + tt('agent-detail.tiefeHinweis'));
  if (m.endStatus) agentKv(grid, tt('agent-detail.abschluss'), m.endStatus);
  if (m.agentId) agentKv(grid, tt('agent-detail.agentId'), m.agentId);
  if (a && a.start) agentKv(grid, tt('agent-detail.gestartet'), new Date(a.start).toLocaleTimeString());
  sec.appendChild(grid);
}

// The live activity line — the same two facts the rail shows, but here they get a whole row and are
// rewritten in place on every poll, so the panel is never staler than the row that opened it.
function agentDetailPaintLive(m) {
  const box = AGENT_DETAIL && AGENT_DETAIL.node && AGENT_DETAIL.node.querySelector('.ad-now');
  if (!box) return;
  box.classList.toggle('hidden', !m.live);
  if (!m.live) return;
  box.textContent = (m.phase || m.lastTool)
    ? '▸ ' + (m.phase || m.lastTool) + (m.lastTool && m.phase ? ' · ' + m.lastTool : '')
    : tt('agent-detail.arbeitet');
}

function agentEventRow(e) {
  const row = el('div', 'ad-ev ad-ev-' + (e.kind || 'text'));
  const time = e.ts ? new Date(e.ts).toLocaleTimeString() : '';
  if (time) row.appendChild(el('span', 'ad-ev-t', time));
  if (e.kind === 'tool') {
    row.appendChild(el('span', 'ad-ev-n', e.name || 'tool'));
    if (e.summary) row.appendChild(el('span', 'ad-ev-s', e.summary));
  } else if (e.kind === 'prompt') {
    row.appendChild(el('span', 'ad-ev-n', tt('agent-detail.auftrag')));
    row.appendChild(el('span', 'ad-ev-s', e.text || ''));
  } else {
    row.appendChild(el('span', 'ad-ev-n', e.kind === 'thinking' ? tt('agent-detail.denkt') : tt('agent-detail.schreibt')));
    const s = el('span', 'ad-ev-s', e.text || '');
    if (e.full) s.title = tt('agent-detail.gekuerzt');
    row.appendChild(s);
  }
  return row;
}
// Append only what is new. Rebuilding the list on every poll would reset the scroll position of a
// running agent's log every two seconds — the one thing that makes a live log unreadable.
function agentDetailAppendEvents(events) {
  const d = AGENT_DETAIL; if (!d || !events || !events.length) return;
  const list = d.node.querySelector('.ad-log'); if (!list) return;
  const empty = list.querySelector('.ad-log-empty'); if (empty) empty.remove();
  // "stick to the bottom" only if the reader IS at the bottom — scrolling up to read something must
  // not be undone by the next arriving line.
  const stick = Math.abs(list.scrollHeight - list.scrollTop - list.clientHeight) < 24;
  events.forEach((e) => list.appendChild(agentEventRow(e)));
  d.events.push(...events);
  const cnt = d.node.querySelector('.ad-log-count');
  if (cnt) cnt.textContent = String(d.events.length);
  if (stick) list.scrollTop = list.scrollHeight;
}

// One fetch of whatever the agent has written since `offset`. Errors are shown once and stop the poll:
// a broken path or a deleted temp file would otherwise retry every two seconds for the whole session.
async function agentDetailPoll() {
  const d = AGENT_DETAIL; if (!d) return;
  // The panel was closed (or another artifact was pinned into the sidecar): stop, don't keep polling a
  // detached node. closeSidecar() only clears its own state — the ticker has to notice by itself.
  if (typeof SIDECAR === 'undefined' || SIDECAR.node !== d.node) { agentDetailStop(); AGENT_DETAIL = null; return; }
  if (document.hidden) return;                       // a hidden tab needs no live log
  if (d._busy) return; d._busy = true;
  try {
    const j = await api('/api/agent/output?file=' + encodeURIComponent(d.file) + '&offset=' + d.offset);
    if (!AGENT_DETAIL || AGENT_DETAIL !== d) return;  // panel was closed/switched while we waited
    if (j.restarted) { d.offset = 0; }                // file was recreated → read it from the top
    d.offset = j.nextOffset || 0;
    agentDetailAppendEvents(j.events || []);
    const note = d.node.querySelector('.ad-log-note');
    if (note) {
      note.textContent = j.missing ? tt('agent-detail.nochKeineAusgabe') : (j.truncated ? tt('agent-detail.gekuerztHinweis') : '');
      note.classList.toggle('hidden', !note.textContent);
    }
    const lane = agentLaneById(d.tab, d.id);
    const m = lane ? laneMetrics(lane) : null;
    if (m) {
      agentDetailPaintLive(m);
      // The agent finished while the panel was open: one last read (the closing report is written after
      // the notification), then stop polling. Without the extra pass the final answer never arrives.
      if (!m.live && j.eof) { agentDetailStop(); agentDetailPaintResult(m); }
    }
  } catch (e) {
    agentDetailStop();
    const note = d.node.querySelector('.ad-log-note');
    if (note) { note.textContent = String(e.message || e); note.classList.remove('hidden'); }
  } finally { d._busy = false; }
}

// The closing report: the lane's own summary if the notification carried one, else the last text the
// agent wrote in its transcript. Both can be absent (a killed agent) — then the section stays away.
function agentDetailPaintResult(m) {
  const d = AGENT_DETAIL; if (!d) return;
  const box = d.node.querySelector('.ad-result'); if (!box) return;
  let text = m.summary || '';
  // else the agent's last words: from its transcript file if it wrote one, otherwise from the text
  // the CLI forwarded (a foreground agent has nothing else).
  if (!text) {
    for (let i = d.events.length - 1; i >= 0 && !text; i--) {
      const e = d.events[i];
      if (e && e.kind === 'text' && e.text) text = e.text;
    }
  }
  if (!text && m.texts) {
    for (let i = m.texts.length - 1; i >= 0 && !text; i--) {
      if (m.texts[i].kind === 'text') text = m.texts[i].text;
    }
  }
  box.innerHTML = '';
  box.classList.toggle('hidden', !text);
  if (!text) return;
  box.appendChild(el('h4', 'ad-h', tt('agent-detail.ergebnis')));
  const pre = el('pre', 'ad-pre'); pre.textContent = text;
  pre.appendChild(copyBtn(() => text, tt('common.kopieren')));
  box.appendChild(pre);
}

// Forwarded text arrived for a lane (--forward-subagent-text). Only the panel that is showing THAT
// agent cares, and only while it has no transcript file of its own — a backgrounded agent's file is
// the fuller record (it has the tool calls too), so the forwarded copy would just duplicate it.
function agentDetailNoteText(laneId) {
  const d = AGENT_DETAIL;
  if (!d || d.id !== laneId || d.file) return;
  const lane = agentLaneById(d.tab, laneId);
  if (lane) agentDetailPaintTexts(laneMetrics(lane));
}
// Render the forwarded blocks as log rows. Rebuilt from the lane rather than appended incrementally:
// the lane caps and drops its oldest blocks, so "append what is new" would drift out of step with it.
function agentDetailPaintTexts(m) {
  const d = AGENT_DETAIL; if (!d) return;
  const list = d.node.querySelector('.ad-log'); if (!list) return;
  const texts = m.texts || [];
  if (!texts.length) return;
  const stick = Math.abs(list.scrollHeight - list.scrollTop - list.clientHeight) < 24;
  list.innerHTML = '';
  texts.forEach((t) => list.appendChild(agentEventRow({ ts: t.at, kind: t.kind === 'thinking' ? 'thinking' : 'text', text: t.text })));
  const cnt = d.node.querySelector('.ad-log-count');
  if (cnt) cnt.textContent = String(texts.length);
  if (stick) list.scrollTop = list.scrollHeight;
}
// Entry point: called from the rail row, from the status-strip badge and from the agent tool card in
// the transcript. Re-opening the SAME agent is a no-op refresh rather than a rebuild, so the log keeps
// its scroll position when you click the row twice.
function agentDetailShow(lane, tab) {
  if (!lane) return;
  const t = tab || (typeof ACTIVE !== 'undefined' ? ACTIVE : null);
  const m = laneMetrics(lane);
  agentDetailStop();
  const node = el('div', 'agent-detail');

  const head = el('div', 'ad-head');
  head.appendChild(el('span', 'ad-ico', agentIcon(m.type)));
  head.appendChild(el('span', 'ad-type', (m.depth > 1 ? '↳ ' : '') + m.type));
  const st = el('span', 'ad-status ' + (m.live ? 'running' : (m.status === 'error' ? 'error' : 'done')), agentStatusLabel(m));
  head.appendChild(st);
  node.appendChild(head);
  if (m.desc) node.appendChild(el('div', 'ad-desc', m.desc));
  const now = el('div', 'ad-now' + (m.live ? '' : ' hidden'));
  node.appendChild(now);

  agentDetailFacts(agentSection(node, tt('agent-detail.kennzahlen')), m, lane);

  if (m.prompt) {
    const sec = agentSection(node, tt('agent-detail.auftrag'));
    const pre = el('pre', 'ad-pre'); pre.textContent = m.prompt;
    pre.appendChild(copyBtn(() => m.prompt, tt('chat-render.promptKopieren')));
    sec.appendChild(pre);
  }

  // The live log. Only backgrounded agents write a transcript file; a foreground agent has none, and
  // the section says so instead of showing an empty box that looks broken.
  const logSec = agentSection(node, tt('agent-detail.verlauf'));
  const cnt = el('span', 'ad-log-count', '0'); logSec.querySelector('.ad-h').appendChild(cnt);
  const note = el('div', 'ad-log-note hidden'); logSec.appendChild(note);
  const log = el('div', 'ad-log');
  // Three cases, and the empty line has to name the right one: a transcript file being read, text
  // forwarded from a foreground agent, or nothing at all (the flag is off and there is no file).
  const hasTexts = !!(m.texts && m.texts.length);
  log.appendChild(el('div', 'ad-log-empty', m.outputFile ? tt('common.lade')
    : hasTexts ? '' : tt('agent-detail.keinTranskript')));
  logSec.appendChild(log);

  const result = el('div', 'ad-result hidden'); node.appendChild(result);

  if (m.outputFile) {
    const foot = el('div', 'ad-foot');
    const pathEl = el('span', 'ad-path', m.outputFile); pathEl.title = m.outputFile;
    foot.appendChild(pathEl);
    foot.appendChild(copyBtn(() => m.outputFile, tt('agent-detail.pfadKopieren')));
    node.appendChild(foot);
  }

  AGENT_DETAIL = { id: lane.id, tab: t, node, file: m.outputFile || '', offset: 0, timer: null, events: [] };
  sidecarShow({ title: (m.desc || m.type), node, kind: 'node', raw: m.prompt || '' });
  // Always start at the head. The sidecar is a reused container, so opening a SECOND agent would
  // otherwise inherit wherever the previous one was scrolled to — and the head is the part that says
  // which agent you are even looking at.
  const scroller = $('#sidecarBody'); if (scroller) scroller.scrollTop = 0;
  if (m.outputFile) {
    agentDetailPoll();
    // Poll only while it runs. A finished agent's file is complete after the first read — and the
    // ticker is the one thing that must not outlive the panel (agentDetailStop on close/switch).
    if (m.live) AGENT_DETAIL.timer = setInterval(agentDetailPoll, AGENT_POLL_MS);
  } else {
    // no file → whatever the CLI forwarded is the whole record (foreground agents)
    agentDetailPaintTexts(m);
    agentDetailPaintResult(m);
  }
  if (!m.live) agentDetailPaintResult(m);
}
