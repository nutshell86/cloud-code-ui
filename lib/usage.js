'use strict';
// Usage & cost aggregation for the "Usage & Cost" view.
// Since PR-4 this module owns NO parsing and NO cache of its own: it is a pure PROJECTION over the one
// shared fold in lib/corpus.js (which also feeds lib/sessions.js, so the corpus is read once instead of
// twice, and the session detail can no longer contradict this page). What that changed, in numbers:
//   • tokens and cost are deduped per message.id (max-wins, per file) — the panel used to count every
//     usage LINE and therefore showed 2.15x the tokens and 2.52x the cost
//   • subagent/workflow transcripts are included, attributed to their parent session, and reported
//     separately as sub* so they can never silently inflate a session
//   • day buckets are LOCAL, like the hour axis always was
//   • byModel/byProject/byDay are keyed per MESSAGE model instead of the session's last-seen model
//     (28.99 % of tokens and 33.76 % of cost sat in the wrong model row)
const { costParts, readSessionNames, readCustomNames, projectPathOf, chooseTitle } = require('./core');
const { scanCorpus, weekdayOf } = require('./corpus');

// previous equal-length window immediately before [from,to] (for Δ comparison)
function prevWindow(from, to) {
  if (!from) return null;
  const t = to || new Date().toISOString().slice(0, 10);
  const dFrom = new Date(from + 'T00:00:00Z'), dTo = new Date(t + 'T00:00:00Z');
  if (isNaN(dFrom) || isNaN(dTo) || dTo < dFrom) return null;
  const lenDays = Math.round((dTo - dFrom) / 864e5) + 1;
  const pTo = new Date(dFrom.getTime() - 864e5), pFrom = new Date(pTo.getTime() - (lenDays - 1) * 864e5);
  return { from: pFrom.toISOString().slice(0, 10), to: pTo.toISOString().slice(0, 10) };
}

// A per-(day × model) token bucket priced through the ONE cost formula in lib/core.js. Exact rather
// than an approximation: cost is linear in every token field for a fixed model, so pricing the summed
// bucket equals summing the per-message costs — PROVIDED the ephemeral cache split is carried, which is
// why the bucket keeps eph5m/eph1h separately (a 1h write bills at 2x, a 5m write at 1.25x; dropping
// the split reprices 307.7 M of 588.5 M cache-write tokens and loses 7.0 % of the total).
function priceBucket(model, b) {
  const usage = {
    input_tokens: b[0], output_tokens: b[1], cache_read_input_tokens: b[2],
    cache_creation_input_tokens: b[3],
    cache_creation: { ephemeral_5m_input_tokens: b[4], ephemeral_1h_input_tokens: b[5] },
  };
  const cp = costParts(usage, model);
  return {
    input: b[0], output: b[1], cacheRead: b[2], cacheWrite: b[3], messages: b[6],
    tokens: b[0] + b[1] + b[2] + b[3],
    cost: cp.total, costInput: cp.inCost, costOutput: cp.outCost, costCacheRead: cp.crCost, costCacheWrite: cp.cwCost,
    priced: cp.priced,
  };
}
const blankAgg = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, cost: 0, costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, sessions: 0, subTokens: 0, subCost: 0, subMessages: 0, agentFiles: 0 });
function addAgg(agg, p) {
  agg.input += p.input; agg.output += p.output; agg.cacheRead += p.cacheRead; agg.cacheWrite += p.cacheWrite;
  agg.messages += p.messages; agg.cost += p.cost;
  agg.costInput += p.costInput; agg.costOutput += p.costOutput; agg.costCacheRead += p.costCacheRead; agg.costCacheWrite += p.costCacheWrite;
}

// opts (all optional): project, model — the Usage view's filters. P-2 cockpit, additive (absent = the response is
// byte-for-byte what it was):
//   groupOf(sessionId, sess) → key | null   every session in the window is booked into `byGroup[key]` BEFORE the
//                                           `limit` cut — the list cap is a display rule, a project's sum must not
//                                           depend on whether its sessions made the top 100 (190 sessions sit
//                                           behind it on the live corpus, 15 of them in system32). A throwing
//                                           callback books that session nowhere (null), it does not fail the scan.
//   recentFrom 'YYYY-MM-DD' (a LOCAL day)   each session and group also carries recentCost / recentTokens for the
//                                           days ≥ recentFrom — „30 Tage" and „gesamt" out of ONE pass instead of two.
// P3, additive the same way:
//   groupDays true                          each byGroup entry also carries `days: { 'YYYY-MM-DD': messages }` (the
//                                           project page's activity bars) — summed per group, never per session row.
//   sessionFilter(sessionId, projectPath)   → false drops the session like the project filter does (the Usage view's
//                                           „Panel-Projekt", lib/projects.js sessionGroupFn). Applied AFTER the full
//                                           data range is read, so the date picker (`range`) does not move with it.
//                                           A throwing callback drops that session (it does not fail the scan).
async function scanUsage(from, to, limit, opts = {}) {
  const fProject = opts.project || null, fModel = opts.model || null;
  const groupOf = typeof opts.groupOf === 'function' ? opts.groupOf : null;
  const recentFrom = typeof opts.recentFrom === 'string' && opts.recentFrom ? opts.recentFrom : null;
  const groupDays = opts.groupDays === true;
  const sessionFilter = typeof opts.sessionFilter === 'function' ? opts.sessionFilter : null;
  const byGroup = new Map();
  const prev = prevWindow(from, to);
  const total = blankAgg(), prevTotal = blankAgg();
  const byModel = new Map(), byProject = new Map(), byDay = new Map();
  const byHour = new Array(24).fill(0), byWeekday = new Array(7).fill(0);
  const punch = Array.from({ length: 7 }, () => new Array(24).fill(0)); // weekday × hour
  const activeDays = new Set();
  const unpricedModels = new Set(); // model ids whose tokens are counted but priced at 0
  let unpricedTokens = 0, undatedTokens = 0, undatedMessages = 0;
  const bySession = [];
  let minDay = null, maxDay = null; // full data range, ignoring filters
  const [names, custom] = await Promise.all([readSessionNames(), readCustomNames()]);
  const corpus = await scanCorpus();
  const inRange = (day, lo, hi) => (!lo || day >= lo) && (!hi || day <= hi);

  for (const g of corpus.bySession.values()) {
    const recs = g.main ? [g.main, ...g.agents] : g.agents;
    if (!recs.length) continue;
    // An orphan agent group (no sibling parent transcript) does not occur on the live corpus, but it
    // needs a defined answer: its tokens are real and attributable, so they are counted and listed
    // rather than silently dropped — hiding them would make the KPI row disagree with the table.
    const head = g.main || recs[0];
    // full data range (ignores every filter) — it feeds the date picker
    for (const rec of recs) for (const day in rec.d) { if (!day) continue; if (!minDay || day < minDay) minDay = day; if (!maxDay || day > maxDay) maxDay = day; }
    // The model filter now means "this session used this model", applied to the MESSAGES of that model
    // rather than to the session's last-seen model: the old rule dropped a whole multi-model session
    // (and the 16 multi-model sessions on this corpus are the biggest ones there are).
    if (fProject && g.project !== fProject) continue;
    if (fModel) { let has = false; for (const rec of recs) if (rec.md[fModel]) { has = true; break; } if (!has) continue; }

    const projPath = projectPathOf(g.project, head.cwd); // transcript cwd, not the lossy dir-name decode
    if (sessionFilter) { let keep = false; try { keep = !!sessionFilter(g.session, projPath); } catch { keep = false; } if (!keep) continue; }
    const sess = { id: g.session, project: g.project, projectPath: projPath, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, cost: 0, model: '', models: [], modelCount: 0, mtime: head.m, summary: head.summary, preview: head.preview, subTokens: 0, subCost: 0, subMessages: 0, agentFiles: g.agents.length };
    if (recentFrom) { sess.recentCost = 0; sess.recentTokens = 0; } // P-2 — only when asked for: /api/usage keeps its shape
    const sessModels = new Map(); // model -> tokens, for the session label and the models list
    const sessDays = groupDays ? new Map() : null; // P3 — day -> messages, booked into the group below
    let inWindow = false;

    for (const rec of recs) {
      const isSub = rec.kind !== 'main';
      for (const day in rec.d) {
        const bucket = rec.d[day];
        for (const model in bucket.m) {
          if (fModel && model !== fModel) continue;
          const p = priceBucket(model, bucket.m[model]);
          if (!p.tokens && !p.messages) continue;
          if (!day) { undatedTokens += p.tokens; undatedMessages += p.messages; } // reported, never dropped
          if (prev && day && inRange(day, prev.from, prev.to)) addAgg(prevTotal, p);
          if (day && !inRange(day, from, to)) continue;
          inWindow = true;
          addAgg(total, p);
          sess.input += p.input; sess.output += p.output; sess.cacheRead += p.cacheRead; sess.cacheWrite += p.cacheWrite;
          sess.messages += p.messages; sess.cost += p.cost; sess.tokens += p.tokens;
          if (recentFrom && day && day >= recentFrom) { sess.recentCost += p.cost; sess.recentTokens += p.tokens; }
          if (isSub) { sess.subTokens += p.tokens; sess.subCost += p.cost; sess.subMessages += p.messages; total.subTokens += p.tokens; total.subCost += p.cost; total.subMessages += p.messages; }
          sessModels.set(model, (sessModels.get(model) || 0) + p.tokens);
          const mm = byModel.get(model) || { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, cost: 0, costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0 };
          addAgg(mm, p); byModel.set(model, mm);
          const pm = byProject.get(g.project) || { project: g.project, projectPath: projPath, tokens: 0, messages: 0, cost: 0, sessions: new Set() };
          pm.tokens += p.tokens; pm.messages += p.messages; pm.cost += p.cost; pm.sessions.add(g.session); byProject.set(g.project, pm);
          if (!p.priced) {
            unpricedTokens += p.tokens;
            // '<synthetic>' is a pseudo-model on frames whose every token field is 0 (63 lines live) —
            // listing it as "unpriced" buries the one model that really is missing a rate.
            if (model !== '<synthetic>') unpricedModels.add(model);
          }
          if (!day) continue;
          if (sessDays) sessDays.set(day, (sessDays.get(day) || 0) + p.messages);
          activeDays.add(day);
          const e = byDay.get(day) || { date: day, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, cost: 0, costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0 };
          e.tokens += p.tokens; e.input += p.input; e.output += p.output; e.cacheRead += p.cacheRead; e.cacheWrite += p.cacheWrite;
          e.messages += p.messages; e.cost += p.cost; e.costInput += p.costInput; e.costOutput += p.costOutput; e.costCacheRead += p.costCacheRead; e.costCacheWrite += p.costCacheWrite;
          byDay.set(day, e);
        }
        // The hour axes, per MODEL — so the punchcard obeys the model filter instead of contradicting it.
        // It used to run outside this loop over a day-level histogram, gated only by "did this day use the
        // filtered model at all": with a filter active it then showed the OTHER models' hours too (on the
        // 16 multi-model sessions of the live corpus that is most of the picture).
        if (!day || !bucket.h || !inRange(day, from, to)) continue;
        const wd = weekdayOf(day); // derived from the LOCAL day key, so the two axes finally agree
        for (const model in bucket.h) {
          if (fModel && model !== fModel) continue;
          const hh = bucket.h[model];
          for (let h = 0; h < 24; h++) { if (!hh[h]) continue; byHour[h] += hh[h]; byWeekday[wd] += hh[h]; punch[wd][h] += hh[h]; }
        }
      }
    }
    if (!inWindow || !sess.messages) continue; // a session with no usage in the window is not a row
    // The session's model label: the MAJORITY model by tokens, '<synthetic>' skipped. It used to be the
    // last model-carrying frame, which parked 47.3 M real tokens of 4 sessions in a `<synthetic>` row.
    const ranked = [...sessModels.entries()].filter(([m]) => m !== '<synthetic>').sort((a, b) => b[1] - a[1]);
    sess.models = ranked.map(([m]) => m);
    sess.modelCount = sess.models.length;
    sess.model = ranked.length ? ranked[0][0] : (sessModels.size ? [...sessModels.keys()][0] : 'unknown');
    sess.title = chooseTitle(sess, custom, names).title;
    total.sessions++;
    total.agentFiles += sess.agentFiles;
    bySession.push(sess);
    if (groupOf) {
      let key = null;
      try { key = groupOf(g.session, sess); } catch { key = null; }
      sess.group = key == null ? null : String(key);
      if (sess.group !== null) {
        const e = byGroup.get(sess.group) || { group: sess.group, sessions: 0, tokens: 0, messages: 0, cost: 0, subCost: 0, recentCost: 0, recentTokens: 0, recentSessions: 0 };
        e.sessions++; e.tokens += sess.tokens; e.messages += sess.messages; e.cost += sess.cost; e.subCost += sess.subCost;
        if (recentFrom && sess.recentTokens) { e.recentCost += sess.recentCost; e.recentTokens += sess.recentTokens; e.recentSessions++; }
        if (sessDays) { if (!e.days) e.days = Object.create(null); for (const [day, n] of sessDays) e.days[day] = (e.days[day] || 0) + n; }
        byGroup.set(sess.group, e);
      }
    }
  }

  bySession.sort((a, b) => b.tokens - a.tokens);
  const days = [...byDay.values()].sort((a, b) => a.date < b.date ? -1 : 1);
  const mtok = (m) => (m.input || 0) + (m.output || 0) + (m.cacheRead || 0) + (m.cacheWrite || 0);
  const models = [...byModel.values()].sort((a, b) => mtok(b) - mtok(a));
  const projects = [...byProject.values()].map((p) => ({ project: p.project, projectPath: p.projectPath, tokens: p.tokens, messages: p.messages, cost: p.cost, sessions: p.sessions.size })).sort((a, b) => b.tokens - a.tokens);
  const sessOut = limit === 0 ? bySession : bySession.slice(0, limit || 100);
  const extra = {};
  if (groupOf) extra.byGroup = [...byGroup.values()].sort((a, b) => b.cost - a.cost); // over ALL sessions, see opts
  if (recentFrom) extra.recentFrom = recentFrom;
  return {
    ...extra,
    total, prevTotal: prev ? prevTotal : null, prevRange: prev, byModel: models, byProject: projects,
    bySession: sessOut, byDay: days, byHour, byWeekday, punch, activeDays: activeDays.size,
    range: minDay ? { min: minDay, max: maxDay } : null,
    // tokens the cost estimate could NOT price (unknown model id) — the honest footnote to `total.cost`
    unpricedTokens, unpricedModels: [...unpricedModels].sort(),
    // usage lines with no timestamp (0 on the live corpus). Counted in the totals, absent from byDay —
    // reported rather than silently dropped, which is what the old day guard did.
    undatedTokens, undatedMessages,
    // A defect in the shared fold must not look like a plausible 0 (lib/core.js foldLines swallows
    // callback exceptions), so the scan's own error counters travel with the numbers — and the FIRST
    // exception message with them, because "12 lines failed" without a reason is not actionable. The
    // Usage view renders all three (public/js/views-usage.js usageNotes).
    foldErrors: corpus.stats.foldErrors, parseErrors: corpus.stats.parseErrors, foldError: corpus.stats.foldError,
  };
}
// SEC-7: the cell encoder moved to public/js/csv.js — ONE rule for the three CSV writers this project
// has (this route, and the two in views-uiskills.js), the same way lib/engine.js shares
// public/js/ui-skill-prompt.js with the browser. Re-exported so the route keeps its import.
const { csvCell } = require('../public/js/csv');

module.exports = { scanUsage, csvCell, priceBucket };
