// Part of the Claude Code Control Panel front-end (split from app.js).
// Classic scripts share one global scope; load order in index.html is authoritative: render → chat → sessions → views → commands → boot.
// This file: views-usage.js

// ============================================================
//  USAGE & COST
// ============================================================
// NUM-LOC — `toFixed` always writes a DOT, so a German panel printed „1.5K" tokens: not a rounding error
// but a digit-grouping one to the person reading it („eintausendfünfhundert"?). fmtDec (render.js) formats
// in the panel's language; the magnitude letters stay as they are — K/M/B are the suffixes this panel has
// always used and they are not words to translate.
function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return fmtDec(v / 1e9, 2) + 'B';
  if (v >= 1e6) return fmtDec(v / 1e6, 1) + 'M';
  if (v >= 1e3) return fmtDec(v / 1e3, 1) + 'K';
  return fmtInt(v);
}

// --- SVG chart helpers ---
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) { const e = document.createElementNS(SVGNS, tag); for (const k in (attrs || {})) e.setAttribute(k, attrs[k]); return e; }
// per-render memo: cssVar() is called hundreds of times inside chart loops/hover handlers, and each
// getComputedStyle can force a style recalc. Cache is reset at the start of renderUsage and on any
// accent/theme change (below), so values never go stale.
let _cssVarCache = null;
function cssVar(n) {
  if (_cssVarCache && n in _cssVarCache) return _cssVarCache[n];
  const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888';
  if (_cssVarCache) _cssVarCache[n] = v;
  return v;
}

// a11y: an <svg> without a name is announced as "graphic" and nothing else. One helper so all charts
// get role=img + aria-label + an in-SVG <title> (the title also serves as the native browser tooltip).
// NOT a full sr data table — the numbers live in the KPI tiles and the Sitzungen table below the charts.
function chartSvg(attrs, label) {
  const s = svgEl('svg', Object.assign({ role: 'img' }, attrs || {}));
  if (label) { s.setAttribute('aria-label', label); const ti = svgEl('title'); ti.textContent = label; s.appendChild(ti); }
  return s;
}
function buildTimeSeries(container, series, opts) {
  opts = opts || {}; container.innerHTML = '';
  if (!series.length) { container.innerHTML = '<div class="chart-empty">' + t('views-usage.keineDatenImZeitraum') + '</div>'; return; }
  const W = 640, H = 190, pl = 48, pr = 14, pt = 12, pb = 26, iw = W - pl - pr, ih = H - pt - pb;
  const maxV = Math.max(...series.map((d) => d.value), 0) || 1, n = series.length;
  const xAt = (i) => n === 1 ? pl + iw / 2 : pl + (i / (n - 1)) * iw;
  const yAt = (v) => pt + ih - (v / maxV) * ih;
  const color = opts.color || cssVar('--accent'), grid = cssVar('--viz-grid'), muted = cssVar('--viz-muted');
  const s = chartSvg({ viewBox: `0 0 ${W} ${H}` }, opts.label);
  [0, 0.5, 1].forEach((f) => {
    const y = pt + ih - f * ih;
    s.appendChild(svgEl('line', { x1: pl, y1: y, x2: W - pr, y2: y, stroke: grid, 'stroke-width': 1 }));
    const t = svgEl('text', { x: pl - 7, y: y + 3, 'text-anchor': 'end', fill: muted, 'font-size': 10 });
    t.textContent = opts.fmt ? opts.fmt(maxV * f) : Math.round(maxV * f); s.appendChild(t);
  });
  let dLine = ''; series.forEach((d, i) => { dLine += (i ? 'L' : 'M') + xAt(i).toFixed(1) + ' ' + yAt(d.value).toFixed(1); });
  if (opts.area) {
    const gid = 'g' + Math.random().toString(36).slice(2, 7);
    const defs = svgEl('defs'), lg = svgEl('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
    const st1 = svgEl('stop', { offset: '0%' }); st1.setAttribute('stop-color', color); st1.setAttribute('stop-opacity', 0.32);
    const st2 = svgEl('stop', { offset: '100%' }); st2.setAttribute('stop-color', color); st2.setAttribute('stop-opacity', 0.02);
    lg.appendChild(st1); lg.appendChild(st2); defs.appendChild(lg); s.appendChild(defs);
    s.appendChild(svgEl('path', { d: dLine + `L${xAt(n - 1).toFixed(1)} ${pt + ih}L${xAt(0).toFixed(1)} ${pt + ih}Z`, fill: `url(#${gid})` }));
  }
  s.appendChild(svgEl('path', { d: dLine, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  const xl = svgEl('text', { x: pl, y: H - 8, fill: muted, 'font-size': 10 }); xl.textContent = series[0].date.slice(5); s.appendChild(xl);
  const xr = svgEl('text', { x: W - pr, y: H - 8, 'text-anchor': 'end', fill: muted, 'font-size': 10 }); xr.textContent = series[n - 1].date.slice(5); s.appendChild(xr);
  const cross = svgEl('line', { y1: pt, y2: pt + ih, stroke: cssVar('--viz-axis'), 'stroke-width': 1, opacity: 0 });
  const dot = svgEl('circle', { r: 4, fill: color, stroke: cssVar('--panel'), 'stroke-width': 2, opacity: 0 });
  s.appendChild(cross); s.appendChild(dot);
  const tip = el('div', 'chart-tip');
  s.appendChild(svgEl('rect', { x: pl, y: pt, width: iw, height: ih, fill: 'transparent' }));
  container.appendChild(s); container.appendChild(tip);
  s.addEventListener('mousemove', (ev) => {
    const rect = s.getBoundingClientRect(); const px = (ev.clientX - rect.left) / rect.width * W;
    let i = n === 1 ? 0 : Math.round((px - pl) / iw * (n - 1)); i = Math.max(0, Math.min(n - 1, i));
    const x = xAt(i), y = yAt(series[i].value);
    cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('opacity', 1);
    dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('opacity', 1);
    tip.style.opacity = 1; tip.style.left = (x / W * rect.width) + 'px'; tip.style.top = (y / H * rect.height) + 'px';
    tip.textContent = series[i].date + ' · ' + (opts.fmt ? opts.fmt(series[i].value) : series[i].value);
  });
  s.addEventListener('mouseleave', () => { cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); tip.style.opacity = 0; });
}

// two lines sharing one X axis, each with its own Y scale (left = A, right = B) — e.g. Tokens vs. Kosten
function buildDualSeries(container, legendEl, series, A, B) {
  container.innerHTML = ''; if (legendEl) legendEl.innerHTML = '';
  if (!series.length) { container.innerHTML = '<div class="chart-empty">' + t('views-usage.keineDatenImZeitraum') + '</div>'; return; }
  const W = 640, H = 190, pl = 48, pr = 54, pt = 12, pb = 26, iw = W - pl - pr, ih = H - pt - pb, n = series.length;
  const maxA = Math.max(...series.map((d) => d.a), 0) || 1, maxB = Math.max(...series.map((d) => d.b), 0) || 1;
  const xAt = (i) => n === 1 ? pl + iw / 2 : pl + (i / (n - 1)) * iw;
  const yA = (v) => pt + ih - (v / maxA) * ih, yB = (v) => pt + ih - (v / maxB) * ih;
  const grid = cssVar('--viz-grid'), muted = cssVar('--viz-muted');
  const s = chartSvg({ viewBox: `0 0 ${W} ${H}` }, A.label + ' / ' + B.label);
  [0, 0.5, 1].forEach((f) => {
    const y = pt + ih - f * ih;
    s.appendChild(svgEl('line', { x1: pl, y1: y, x2: W - pr, y2: y, stroke: grid, 'stroke-width': 1 }));
    const tl = svgEl('text', { x: pl - 7, y: y + 3, 'text-anchor': 'end', fill: A.color, 'font-size': 10 }); tl.textContent = A.fmt(maxA * f); s.appendChild(tl);
    const tr = svgEl('text', { x: W - pr + 7, y: y + 3, fill: B.color, 'font-size': 10 }); tr.textContent = B.fmt(maxB * f); s.appendChild(tr);
  });
  const path = (key, yfn, color) => { let d = ''; series.forEach((p, i) => { d += (i ? 'L' : 'M') + xAt(i).toFixed(1) + ' ' + yfn(p[key]).toFixed(1); }); s.appendChild(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' })); };
  path('a', yA, A.color); path('b', yB, B.color);
  const xl = svgEl('text', { x: pl, y: H - 8, fill: muted, 'font-size': 10 }); xl.textContent = series[0].date; s.appendChild(xl);
  const xr = svgEl('text', { x: W - pr, y: H - 8, 'text-anchor': 'end', fill: muted, 'font-size': 10 }); xr.textContent = series[n - 1].date; s.appendChild(xr);
  const cross = svgEl('line', { y1: pt, y2: pt + ih, stroke: cssVar('--viz-axis'), 'stroke-width': 1, opacity: 0 });
  const dotA = svgEl('circle', { r: 3.5, fill: A.color, stroke: cssVar('--panel'), 'stroke-width': 2, opacity: 0 });
  const dotB = svgEl('circle', { r: 3.5, fill: B.color, stroke: cssVar('--panel'), 'stroke-width': 2, opacity: 0 });
  s.appendChild(cross); s.appendChild(dotA); s.appendChild(dotB);
  const tip = el('div', 'chart-tip');
  s.appendChild(svgEl('rect', { x: pl, y: pt, width: iw, height: ih, fill: 'transparent' }));
  container.appendChild(s); container.appendChild(tip);
  s.addEventListener('mousemove', (ev) => {
    const rect = s.getBoundingClientRect(); const px = (ev.clientX - rect.left) / rect.width * W;
    let i = n === 1 ? 0 : Math.round((px - pl) / iw * (n - 1)); i = Math.max(0, Math.min(n - 1, i));
    const x = xAt(i);
    cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('opacity', 1);
    dotA.setAttribute('cx', x); dotA.setAttribute('cy', yA(series[i].a)); dotA.setAttribute('opacity', 1);
    dotB.setAttribute('cx', x); dotB.setAttribute('cy', yB(series[i].b)); dotB.setAttribute('opacity', 1);
    tip.style.opacity = 1; tip.style.left = (x / W * rect.width) + 'px'; tip.style.top = (pt / H * rect.height) + 'px';
    tip.textContent = series[i].date + ' · ' + A.label + ' ' + A.fmt(series[i].a) + ' · ' + B.label + ' ' + B.fmt(series[i].b);
  });
  s.addEventListener('mouseleave', () => { cross.setAttribute('opacity', 0); dotA.setAttribute('opacity', 0); dotB.setAttribute('opacity', 0); tip.style.opacity = 0; });
  if (legendEl) { [A, B].forEach((o) => { const sp = el('span', 'clg-item'); const dot = el('span', 'clg-dot'); dot.style.background = o.color; sp.appendChild(dot); sp.appendChild(document.createTextNode(o.label)); legendEl.appendChild(sp); }); }
}

function buildDonut(container, legendEl, segs, opts) {
  opts = opts || {}; const fmt = opts.fmt || fmtNum, unit = opts.unit || t('views-usage.tokens');
  container.innerHTML = ''; legendEl.innerHTML = '';
  const total = segs.reduce((a, b) => a + b.value, 0);
  if (!total) { container.innerHTML = '<div class="chart-empty">' + t('views-usage.keine') + unit + '.</div>'; return; }
  const size = 180, r = 64, cx = size / 2, cy = size / 2, w = 26, C = 2 * Math.PI * r;
  const s = chartSvg({ viewBox: `0 0 ${size} ${size}` }, opts.label);
  s.appendChild(svgEl('circle', { cx, cy, r, fill: 'none', stroke: cssVar('--viz-grid'), 'stroke-width': w }));
  const center = svgEl('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: cssVar('--text'), 'font-size': 16, 'font-weight': 600 });
  const sub = svgEl('text', { x: cx, y: cy + 16, 'text-anchor': 'middle', fill: cssVar('--viz-muted'), 'font-size': 9 });
  const setC = (a, b) => { center.textContent = a; sub.textContent = b; };
  let off = 0; const gap = 2.5;
  segs.forEach((seg) => {
    const frac = seg.value / total, len = Math.max(0, frac * C - gap);
    const c = svgEl('circle', { cx, cy, r, fill: 'none', stroke: seg.color, 'stroke-width': w, 'stroke-dasharray': `${len} ${C - len}`, 'stroke-dashoffset': -off, transform: `rotate(-90 ${cx} ${cy})` });
    c.style.cursor = 'pointer';
    c.addEventListener('mouseover', () => { c.setAttribute('stroke-width', w + 5); setC(fmt(seg.value), seg.label); });
    c.addEventListener('mouseout', () => { c.setAttribute('stroke-width', w); setC(fmt(total), unit); });
    s.appendChild(c); off += frac * C;
  });
  s.appendChild(center); s.appendChild(sub); setC(fmt(total), unit);
  container.appendChild(s);
  segs.forEach((seg) => {
    const rr = el('div', 'dl-row'); const dot = el('span', 'dl-dot'); dot.style.background = seg.color;
    rr.appendChild(dot); rr.appendChild(el('div', 'dl-name', seg.label));
    // NUM-LOC: the fifth percent display of this view, and the last one still writing „%" by hand. 0
    // decimals as before — fmtPct only takes over the separator and the German space before the sign.
    rr.appendChild(el('div', 'dl-val', fmt(seg.value) + ' · ' + fmtPct(seg.value / total * 100, 0)));
    legendEl.appendChild(rr);
  });
}

// stacked vertical bars over time (composition)
function buildStackedBars(container, rows, series, opts) {
  opts = opts || {}; const fmt = opts.fmt || fmtTok; container.innerHTML = '';
  if (!rows.length) { container.innerHTML = '<div class="chart-empty">' + t('views-usage.keineDatenImZeitraum') + '</div>'; return; }
  const W = 640, H = 190, pl = 48, pr = 12, pt = 12, pb = 26, iw = W - pl - pr, ih = H - pt - pb;
  const totals = rows.map((r) => series.reduce((a, s) => a + (r[s.key] || 0), 0));
  const maxV = Math.max(...totals, 0) || 1, n = rows.length, bw = iw / n, muted = cssVar('--viz-muted'), grid = cssVar('--viz-grid');
  const s = chartSvg({ viewBox: `0 0 ${W} ${H}` }, opts.label);
  [0, 0.5, 1].forEach((f) => { const y = pt + ih - f * ih; s.appendChild(svgEl('line', { x1: pl, y1: y, x2: W - pr, y2: y, stroke: grid, 'stroke-width': 1 })); const t = svgEl('text', { x: pl - 7, y: y + 3, 'text-anchor': 'end', fill: muted, 'font-size': 10 }); t.textContent = fmt(maxV * f); s.appendChild(t); });
  const tip = el('div', 'chart-tip');
  rows.forEach((r, i) => {
    let acc = 0; const x = pl + i * bw + bw * 0.12, wBar = bw * 0.76;
    series.forEach((seg) => {
      const v = r[seg.key] || 0; if (!v) return; const h = (v / maxV) * ih; const y = pt + ih - (acc + v) / maxV * ih;
      const rect = svgEl('rect', { x, y, width: wBar, height: Math.max(0, h), fill: seg.color });
      rect.addEventListener('mouseover', () => { tip.style.opacity = 1; tip.style.left = (x / W * 100) + '%'; tip.style.top = (y / H * 100) + '%'; tip.textContent = r.label + ' · ' + seg.label + ' ' + fmt(v); });
      rect.addEventListener('mouseout', () => { tip.style.opacity = 0; });
      s.appendChild(rect); acc += v;
    });
  });
  const xl = svgEl('text', { x: pl, y: H - 8, fill: muted, 'font-size': 10 }); xl.textContent = rows[0].label; s.appendChild(xl);
  const xr = svgEl('text', { x: W - pr, y: H - 8, 'text-anchor': 'end', fill: muted, 'font-size': 10 }); xr.textContent = rows[n - 1].label; s.appendChild(xr);
  container.appendChild(s); container.appendChild(tip);
}

// punchcard heatmap: weekday × hour bubble grid ("wann arbeite ich")
function buildPunchcard(container, punch) {
  container.innerHTML = '';
  const rows = [1, 2, 3, 4, 5, 6, 0], labels = [t('views-usage.mo'), t('views-usage.di'), t('views-usage.mi'), t('views-usage.do'), t('views-usage.fr'), t('views-usage.sa'), t('views-usage.so')];
  const max = Math.max(1, ...punch.flat());
  const cw = 26, rh = 26, padL = 34, padT = 8, padB = 20;
  const W = padL + 24 * cw + 6, H = padT + 7 * rh + padB;
  const s = chartSvg({ viewBox: `0 0 ${W} ${H}`, width: W, height: H }, t('views-usage.chartHeat'));
  const muted = cssVar('--viz-muted'), color = cssVar('--accent');
  const tip = el('div', 'chart-tip');
  rows.forEach((wd, ri) => {
    const cy = padT + ri * rh + rh / 2;
    const tl = svgEl('text', { x: 0, y: cy + 3, fill: muted, 'font-size': 10 }); tl.textContent = labels[ri]; s.appendChild(tl);
    for (let h = 0; h < 24; h++) {
      const v = punch[wd][h], cx = padL + h * cw + cw / 2;
      s.appendChild(svgEl('circle', { cx, cy, r: 2, fill: cssVar('--viz-grid') })); // baseline dot
      if (v > 0) {
        const frac = v / max, r = 3 + Math.sqrt(frac) * 9;
        const c = svgEl('circle', { cx, cy, r, fill: color, opacity: (0.3 + 0.7 * frac).toFixed(2) });
        c.style.cursor = 'pointer';
        // the hour is the LOCAL hour of the call (and so is the day it is booked under) — say so, the
        // transcript's own timestamps are UTC and "Mo 14:00" with no caveat invites the wrong reading
        c.addEventListener('mouseover', () => { tip.style.opacity = 1; tip.style.left = (cx / W * 100) + '%'; tip.style.top = (cy / H * 100) + '%'; tip.textContent = labels[ri] + ' ' + h + ':00 ' + t('views-usage.lokalzeit') + ' · ' + fmtTok(v); });
        c.addEventListener('mouseout', () => { tip.style.opacity = 0; });
        s.appendChild(c);
      }
    }
  });
  [0, 6, 12, 18, 23].forEach((h) => { const t = svgEl('text', { x: padL + h * cw + cw / 2, y: H - 6, 'text-anchor': 'middle', fill: muted, 'font-size': 9 }); t.textContent = h; s.appendChild(t); });
  container.appendChild(s); container.appendChild(tip);
}

// GitHub-style calendar heatmap from byDay (kept as an alternative)

// --- date filter ---
let usageRange = { from: null, to: null, preset: 'all' };
// LOCAL calendar date, because that is what the server now buckets by — and what a person means by
// "heute". toISOString() gave the UTC date, so between 00:00 and 01:59 local the „heute" chip selected
// YESTERDAY and the view came back empty.
function isoLocal(d) { const p = (v) => (v < 10 ? '0' : '') + v; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
function isoDaysAgo(days) { return isoLocal(new Date(Date.now() - days * 864e5)); }
function renderDateFilter(dataRange) {
  const f = $('#dateFilter'); f.innerHTML = '';
  [['today', t('views-usage.heute')], ['all', t('views-usage.gesamt')], ['7', t('views-usage.n7Tage')], ['30', t('views-usage.n30Tage')], ['90', t('views-usage.n90Tage')]].forEach(([k, label]) => {
    const c = el('button', 'df-chip' + (usageRange.preset === k ? ' active' : ''), label);
    c.onclick = () => {
      usageRange.preset = k;
      if (k === 'today') { usageRange.from = usageRange.to = isoDaysAgo(0); } // only today's usage
      else { usageRange.from = k === 'all' ? null : isoDaysAgo(+k); usageRange.to = null; }
      loadUsage(true);
    };
    f.appendChild(c);
  });
  f.appendChild(el('span', 'df-sep'));
  const fromI = el('input'); fromI.type = 'date'; fromI.value = usageRange.from || (dataRange ? dataRange.min : '');
  const toI = el('input'); toI.type = 'date'; toI.value = usageRange.to || (dataRange ? dataRange.max : '');
  if (dataRange) { fromI.min = toI.min = dataRange.min; fromI.max = toI.max = dataRange.max; }
  fromI.onchange = () => { usageRange.from = fromI.value || null; usageRange.preset = 'custom'; loadUsage(true); };
  toI.onchange = () => { usageRange.to = toI.value || null; usageRange.preset = 'custom'; loadUsage(true); };
  f.appendChild(el('span', 'muted', t('views-usage.von'))); f.appendChild(fromI);
  f.appendChild(el('span', 'muted', t('views-usage.bis'))); f.appendChild(toI);
}

// NUM-LOC — same as fmtNum above: the decimal separator follows the panel's language, not toFixed's dot.
function fmtTok(v) { v = Number(v) || 0; return v >= 1e6 ? fmtDec(v / 1e6, v < 1e7 ? 2 : 1) + 'M' : v >= 1e3 ? fmtInt(Math.round(v / 1e3)) + 'k' : fmtInt(Math.round(v)); }
// estimated cost — currency follows the UI language (DE → €, EN → $) via fmtMoney (render.js). Kept as the
// shared global formatter so every cost site (chat.js/sessions.js/Usage) converts automatically. (i18n)
function fmtUSD(v) { return (typeof fmtMoney === 'function') ? fmtMoney(v) : '$' + (Math.abs(v || 0) >= 1 ? (v || 0).toFixed(2) : (v || 0).toFixed(4)); }
function modelTokens(m) { return (m.input || 0) + (m.output || 0) + (m.cacheRead || 0) + (m.cacheWrite || 0); }
let USAGE_DATA = null, USAGE_OPTS = null;
// project = the CLI's FOLDER (byProject); pproject (P3) = a PANEL project 'p-…' | '~none' | '~free' — the sessions the
// project cockpit counts (explicit + per folder rule, lib/projects.js sessionGroupFn), filtered on the server
const usageFilter = { project: '', model: '', pproject: '' };
const usageView = { metric: 'tokens', group: 'day', sort: 'tokens', dir: -1, search: '' };
// RAW-KEY — the „Verlauf" card's subtitle and the chart's accessible label were built as
// `usageView.metric + ' / ' + usageView.group`, i.e. out of the INTERNAL values of two segmented controls.
// The German panel therefore read „· tokens / day" next to buttons labelled „Tokens" and „Tag": the only
// untranslated string in the view, and the one that names what the chart below it shows. No new keys — the
// segment buttons in index.html already carry these six words, so the same key is used here.
function usageViewLabel(metric, group) {
  const M = { tokens: 'common.tokens', messages: 'html.nachrichten', cost: 'html.kosten' };
  const G = { day: 'html.tag', week: 'html.woche', month: 'html.monat' };
  // an unknown value shows itself rather than nothing: a fourth metric added to index.html and forgotten
  // here must be visible as a gap, not hidden behind a wrong word
  return (M[metric] ? t(M[metric]) : String(metric)) + ' / ' + (G[group] ? t(G[group]) : String(group));
}
function usageQS() { const qs = []; if (usageRange.from) qs.push('from=' + usageRange.from); if (usageRange.to) qs.push('to=' + usageRange.to); if (usageFilter.project) qs.push('project=' + encodeURIComponent(usageFilter.project)); if (usageFilter.model) qs.push('model=' + encodeURIComponent(usageFilter.model)); if (usageFilter.pproject) qs.push('pproject=' + encodeURIComponent(usageFilter.pproject)); return qs.length ? '?' + qs.join('&') : ''; }
function periodKey(dateStr, group) {
  if (group === 'month') return dateStr.slice(0, 7);
  // built in LOCAL time and formatted back in LOCAL time. Mixing the two (local midnight in, toISOString
  // out) shifted EVERY week label one day back — Monday 2026-09-28 printed as 2026-09-27.
  if (group === 'week') { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoLocal(d); }
  return dateStr;
}
function groupDays(byDay, group) {
  if (group === 'day') return byDay.map((d) => ({ ...d, label: d.date.slice(5) }));
  const m = new Map();
  byDay.forEach((d) => { const k = periodKey(d.date, group); const e = m.get(k) || { date: k, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, cost: 0, costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0 }; ['tokens', 'input', 'output', 'cacheRead', 'cacheWrite', 'messages', 'cost', 'costInput', 'costOutput', 'costCacheRead', 'costCacheWrite'].forEach((f) => { e[f] += d[f] || 0; }); m.set(k, e); });
  return [...m.values()].sort((a, b) => a.date < b.date ? -1 : 1).map((e) => ({ ...e, label: group === 'month' ? e.date : e.date.slice(5) }));
}
function kpiTile(label, val, sub, cur, prev) {
  const k = el('div', 'kpi'); k.appendChild(el('div', 'k-label', label));
  const vl = el('div', 'k-value', val);
  // NUM-LOC: the delta arrow keeps its 0 decimals (ideas.md H3 is the open question whether it should) —
  // fmtPct is here for the separator and the German space before the sign, which is all that was wrong.
  if (prev != null && prev > 0 && cur != null) { const pct = (cur - prev) / prev * 100; const up = pct >= 0; const b = el('span', 'k-delta ' + (up ? 'up' : 'down')); b.textContent = (up ? '▲' : '▼') + fmtPct(Math.abs(pct), 0); b.title = t('views-usage.vsVorperiode') + fmtNum(prev) + ')'; vl.appendChild(b); }
  k.appendChild(vl); k.appendChild(el('div', 'k-sub', sub)); return k;
}
async function loadUsage(force) {
  // A10: /api/usage rescans every project's jsonl usage entries — once per view entry is plenty, the
  // date-filter chips / project & model dropdowns / ↻ all force a genuine refetch.
  if (!viewOnce('usage', force) && USAGE_DATA) { renderUsage(); return; }
  if (typeof loadSpend === 'function') loadSpend(); // official enterprise spend card (cheap cache GET)
  $('#kpiRow').innerHTML = '<div class="loading">' + t('views-usage.tokenNutzungUeberAlle') + '</div>';
  try {
    const j = await api('/api/usage' + usageQS());
    USAGE_DATA = j;
    renderDateFilter(j.range);
    if (!usageFilter.project && !usageFilter.model && !usageFilter.pproject) USAGE_OPTS = { projects: j.byProject, models: j.byModel }; // the options of the UNFILTERED data only
    populateUsageFilters();
    renderUsage();
  } catch (e) { errorCard('#kpiRow', e.message, () => loadUsage(true)); }
}
function populateUsageFilters() {
  const opts = USAGE_OPTS || { projects: [], models: [] };
  // themed custom dropdowns (same ccSelect helper as the Anzeige dialog) instead of native white <select>s
  const projOpts = [{ value: '', label: t('views-usage.alleOrdner') }].concat(opts.projects.map((p) => ({ value: p.project, label: p.projectPath.split(/[\\/]/).pop() + ' (' + fmtTok(p.tokens) + ')' })));
  const modelOpts = [{ value: '', label: t('views-usage.alleModelle') }].concat(opts.models.map((m) => ({ value: m.model, label: m.model })));
  const mount = (sel, cur, options, apply) => {
    const host = $(sel); if (!host || typeof ccSelect !== 'function') return;
    host.innerHTML = '';
    host.appendChild(ccSelect(cur, options, (v, isPreview) => { if (isPreview || v === cur) return; apply(v); }));
  };
  mount('#uProjectMount', usageFilter.project, projOpts, (v) => { usageFilter.project = v; loadUsage(true); });
  mount('#uModelMount', usageFilter.model, modelOpts, (v) => { usageFilter.model = v; loadUsage(true); });
  // P3 — the panel's projects (archived ones too: their sessions still cost), then the two buckets without one
  if (typeof PROJECTS_DATA !== 'undefined' && !PROJECTS_DATA && typeof ensureProjects === 'function') ensureProjects().then((d) => { if (d) populateUsageFilters(); });
  mount('#uPProjectMount', usageFilter.pproject, usagePProjectOpts(), (v) => { usageFilter.pproject = v; loadUsage(true); });
}
function usagePProjectOpts() {
  const list = (typeof PROJECTS_DATA !== 'undefined' && Array.isArray(PROJECTS_DATA)) ? PROJECTS_DATA : [];
  return [{ value: '', label: t('views-usage.allePanelProjekte') }]
    .concat(list.map((p) => ({ value: p.id, label: p.name + (p.archived ? ' (' + t('projects.archiviert') + ')' : '') })))
    .concat([{ value: '~free', label: t('views-usage.pprojektFrei') }, { value: '~none', label: t('views-usage.pprojektOhne') }]);
}
// The honest footnote under the numbers. Four things the view used to keep to itself:
//   • how much of this is subagent/workflow spend (invisible until PR-4 counted it at all)
//   • which tokens have NO price — /api/usage has returned unpricedTokens/unpricedModels since WP-1 and
//     nothing ever rendered them, which is how 396.8 M Opus-5.5 tokens sat at $0.00 without a word
//   • that the FOLD ITSELF failed on some lines. lib/core.js foldLines wraps the per-line callback in
//     `try {} catch {}` ("a bad line must not kill the scan"), so a defect in the fold is swallowed and
//     reports a plausible-looking 0 — one measurement run did exactly that. scanUsage has carried
//     foldErrors/parseErrors/foldError since PR-4 and nothing showed them, which left the counter as
//     useless as the exception it replaced. A silent fold error is the most expensive kind of wrong
//     number: every figure above it still LOOKS right. Both counters are 0 on the live corpus (464 files,
//     measured 2026-10-02), so this note is not noise — if it ever shows up, something really is broken.
//   • where the numbers come from, and that side calls without a transcript line are not in them
// Split out of renderUsage() so it can be tested without a DOM (test/usage-notes.test.js).
function usageNotes(j, totalTokens) {
  const tot = j.total, notes = [];
  // the fold's own errors go FIRST — they qualify everything that follows
  if (j.foldErrors > 0) notes.push('⚠ ' + t('views-usage.faltungsfehler').replace('{n}', String(j.foldErrors)).replace('{msg}', j.foldError || '?'));
  if (j.parseErrors > 0) notes.push(t('views-usage.parsefehler').replace('{n}', String(j.parseErrors)));
  if (tot.subTokens > 0 || tot.agentFiles > 0) {
    const share = totalTokens ? (tot.subTokens / totalTokens * 100) : 0;
    notes.push(t('views-usage.davonSub') + fmtUSD(tot.subCost || 0) + ' · ' + fmtTok(tot.subTokens || 0) + ' (' + fmtPct(share) + ') · ' + (tot.agentFiles || 0) + '×');
  }
  if (j.unpricedTokens > 0) notes.push(t('views-usage.unpricedHinweis').replace('{n}', fmtTok(j.unpricedTokens)).replace('{models}', (j.unpricedModels || []).join(', ') || '?'));
  if (j.undatedMessages > 0) notes.push(t('views-usage.ohneZeitstempel').replace('{n}', String(j.undatedMessages)));
  notes.push(t('views-usage.quelleFrames'));
  return notes;
}
function renderUsage() {
  const j = USAGE_DATA; if (!j) return;
  _cssVarCache = {}; // fresh CSS-var memo for this dashboard render
  const tot = j.total, p = j.prevTotal, totalTokens = tot.input + tot.output + tot.cacheRead + tot.cacheWrite;
  const prevTokens = p ? p.input + p.output + p.cacheRead + p.cacheWrite : null;
  const cacheHit = (tot.cacheRead + tot.input) ? (tot.cacheRead / (tot.cacheRead + tot.input) * 100) : 0;
  const perSess = tot.sessions ? Math.round(totalTokens / tot.sessions) : 0;
  const outRatio = tot.input ? (tot.output / tot.input) : 0;
  $('#usageScope').textContent = (usageRange.preset === 'all' ? t('views-usage.alleSessions') : (usageRange.from || '…') + ' → ' + (usageRange.to || t('views-usage.jetzt'))) + (usageFilter.project ? t('views-usage.n1Ordner') : '') + (usageFilter.pproject ? ' · ' + ((usagePProjectOpts().find((o) => o.value === usageFilter.pproject) || {}).label || usageFilter.pproject) : '') + (usageFilter.model ? ' · ' + usageFilter.model : '');
  const row = $('#kpiRow'); row.innerHTML = '';
  row.appendChild(kpiTile(t('views-usage.tokensGesamt'), fmtNum(totalTokens), tot.messages + t('views-usage.calls') + tot.sessions + t('sessions.sessions'), totalTokens, prevTokens));
  row.appendChild(kpiTile(t('views-usage.kostenGeschaetzt'), fmtUSD(tot.cost), t('views-usage.geschaetztListenpreise'), tot.cost, p ? p.cost : null));
  row.appendChild(kpiTile(t('html.nachrichten'), fmtNum(tot.messages), t('sessions.modellAufrufe'), tot.messages, p ? p.messages : null));
  row.appendChild(kpiTile(t('views-usage.session'), fmtNum(perSess), t('views-usage.tokensProSession')));
  row.appendChild(kpiTile(t('views-usage.aktiveTage-2'), String(j.activeDays), t('views-usage.mitAktivitaetImZeitraum')));
  row.appendChild(kpiTile(t('views-usage.cacheTreffer'), fmtPct(cacheHit), fmtNum(tot.cacheRead) + t('views-usage.ausCache')));
  row.appendChild(kpiTile(t('views-usage.outputInput'), fmtDec(outRatio, 2) + '×', fmtNum(tot.output) + ' out · ' + fmtNum(tot.input) + ' in'));
  // cost-focused KPIs (all estimates, derived client-side from total/activeDays/messages)
  const costPerSess = tot.sessions ? tot.cost / tot.sessions : 0;
  const costPerDay = j.activeDays ? tot.cost / j.activeDays : 0;
  const costPerMsg = tot.messages ? tot.cost / tot.messages : 0;
  row.appendChild(kpiTile(t('views-usage.kostenSession'), fmtUSD(costPerSess), t('views-usage.geschaetzt-2'), costPerSess, p && p.sessions ? p.cost / p.sessions : null));
  row.appendChild(kpiTile(t('views-usage.kostenTag'), fmtUSD(costPerDay), j.activeDays + t('views-usage.aktiveTage')));
  row.appendChild(kpiTile(t('views-usage.projektion30T'), fmtUSD(costPerDay * 30), t('views-usage.beiAktuellemTag')));
  row.appendChild(kpiTile(t('views-usage.kostenCall'), fmtUSD(costPerMsg), t('views-usage.proModellAufruf')));
  const notes = usageNotes(j, totalTokens);
  const noteEl = el('div', 'kpi-note', notes.join('  ·  '));
  // A fold error is the ONE footnote that says the figures ABOVE are wrong, so it does not get to share
  // the faint grey of the others. Inline, because the token already exists and this is the only place
  // that needs it.
  if (j.foldErrors > 0) { noteEl.style.color = 'var(--warning-text)'; noteEl.style.fontWeight = '600'; }
  row.appendChild(noteEl);

  // time series (metric + grouping)
  const grouped = groupDays(j.byDay, usageView.group);
  const metricKey = usageView.metric === 'messages' ? 'messages' : usageView.metric === 'cost' ? 'cost' : 'tokens';
  const fmtM = usageView.metric === 'messages' ? fmtNum : usageView.metric === 'cost' ? fmtUSD : fmtTok;
  const tsLbl = usageViewLabel(usageView.metric, usageView.group);
  $('#tsRangeLbl').textContent = '· ' + tsLbl;
  buildTimeSeries($('#chartCost'), grouped.map((d) => ({ date: d.label, value: d[metricKey] })), { color: cssVar('--accent'), area: true, fmt: fmtM, label: t('views-usage.chartVerlauf') + ' — ' + tsLbl });

  // cumulative spend (running-sum of estimated cost)
  let acc = 0;
  buildTimeSeries($('#chartCumulative'), grouped.map((d) => { acc += d.cost || 0; return { date: d.label, value: acc }; }), { color: cssVar('--viz-2'), area: true, fmt: fmtUSD, label: t('views-usage.chartKumuliert') });

  // combined Tokens (left axis) × Kosten (right axis)
  buildDualSeries($('#chartCombo'), $('#comboLegend'), grouped.map((d) => ({ date: d.label, a: d.tokens || 0, b: d.cost || 0 })),
    { label: t('common.tokens'), color: cssVar('--viz-1'), fmt: fmtTok },
    { label: t('html.kosten'), color: cssVar('--viz-2'), fmt: fmtUSD });

  // cost composition over time ($), mirroring the token composition but weighted by price
  buildStackedBars($('#chartCostStack'), grouped, [
    { key: 'costCacheRead', label: t('views-usage.cacheLesen'), color: cssVar('--viz-3') },
    { key: 'costInput', label: t('views-usage.eingabe'), color: cssVar('--viz-1') },
    { key: 'costOutput', label: t('chat-render.ausgabe'), color: cssVar('--viz-2') },
    { key: 'costCacheWrite', label: t('views-usage.cacheSchreiben'), color: cssVar('--viz-4') },
  ], { fmt: fmtUSD, label: t('views-usage.chartKostenStack') });

  // cost share by model (donut)
  const costPalette = ['--viz-1', '--viz-2', '--viz-3', '--viz-4', '--viz-5', '--accent'];
  buildDonut($('#chartCostDonut'), $('#costLegend'), (j.byModel || []).map((x, i) => ({ label: x.model, value: x.cost || 0, color: cssVar(costPalette[i % costPalette.length]) })), { fmt: fmtUSD, unit: t('views-usage.geschaetzt'), label: t('views-usage.chartKostenDonut') });

  // punchcard heatmap (weekday × hour)
  buildPunchcard($('#chartHeat'), j.punch || Array.from({ length: 7 }, () => new Array(24).fill(0)));

  // stacked composition over time
  buildStackedBars($('#chartStack'), grouped, [
    { key: 'cacheRead', label: t('views-usage.cacheLesen'), color: cssVar('--viz-3') },
    { key: 'input', label: t('views-usage.eingabe'), color: cssVar('--viz-1') },
    { key: 'output', label: t('chat-render.ausgabe'), color: cssVar('--viz-2') },
    { key: 'cacheWrite', label: t('views-usage.cacheSchreiben'), color: cssVar('--viz-4') },
  ], { label: t('views-usage.chartStack') });

  // composition donut
  buildDonut($('#chartTokens'), $('#tokensLegend'), [
    { label: t('views-usage.eingabe'), value: tot.input, color: cssVar('--viz-1') },
    { label: t('chat-render.ausgabe'), value: tot.output, color: cssVar('--viz-2') },
    { label: t('views-usage.cacheLesen'), value: tot.cacheRead, color: cssVar('--viz-3') },
    { label: t('views-usage.cacheSchreiben'), value: tot.cacheWrite, color: cssVar('--viz-4') },
  ], { label: t('views-usage.chartTokens') });

  // by project + by model bars (tokens)
  renderUsageBars('#projectBars', (j.byProject || []).map((x) => ({ label: x.projectPath.split(/[\\/]/).pop(), value: x.tokens, title: x.projectPath })));
  renderUsageBars('#modelBars', (j.byModel || []).map((x) => ({ label: x.model, value: modelTokens(x) })));
  // cost bars (estimated USD)
  renderUsageBars('#modelCostBars', (j.byModel || []).map((x) => ({ label: x.model, value: x.cost || 0 })), fmtUSD);
  renderUsageBars('#projectCostBars', (j.byProject || []).map((x) => ({ label: x.projectPath.split(/[\\/]/).pop(), value: x.cost || 0, title: x.projectPath })), fmtUSD);

  renderUsageSessions();
}
function renderUsageBars(sel, items, fmt) {
  const fmtV = fmt || fmtTok;
  const bars = $(sel); if (!bars) return; bars.innerHTML = '';
  const list = items.filter((x) => x.value > 0);
  if (!list.length) { bars.innerHTML = '<div class="empty-mini">' + t('views-usage.keineDatenImZeitraum') + '</div>'; return; }
  const maxT = Math.max(...list.map((x) => x.value), 1);
  list.forEach((x) => { const rr = el('div', 'bar-row'); const lb = el('div', 'b-label', x.label); if (x.title) lb.title = x.title; rr.appendChild(lb); const track = el('div', 'bar-track'); const fill = el('div', 'bar-fill'); fill.style.width = Math.max(2, (x.value / maxT) * 100) + '%'; track.appendChild(fill); rr.appendChild(track); rr.appendChild(el('div', 'b-val', fmtV(x.value))); bars.appendChild(rr); });
}
function renderUsageSessions() {
  const j = USAGE_DATA; if (!j) return;
  const q = usageView.search.toLowerCase();
  let rows = (j.bySession || []).filter((s) => !q || ((s.title || '') + ' ' + s.projectPath + ' ' + s.id + ' ' + (s.model || '')).toLowerCase().includes(q));
  const k = usageView.sort, dir = usageView.dir;
  rows = rows.slice().sort((a, b) => { let av = a[k], bv = b[k]; if (k === 'title' || k === 'model') { av = (av || '').toLowerCase(); bv = (bv || '').toLowerCase(); return av < bv ? -dir : av > bv ? dir : 0; } return ((av || 0) - (bv || 0)) * dir; });
  $('#sessCountLbl').textContent = '· ' + rows.length + (q ? t('views-usage.gefiltert') : '');
  const tb = $('#topSessions').querySelector('tbody'); tb.innerHTML = '';
  // A12: an empty result rendered an empty <tbody> — indistinguishable from "still loading"
  if (!rows.length) {
    const tr = el('tr', 'u-empty-row'); const td = el('td', null, q ? t('common.nichtsGefunden') : t('views-usage.keineSitzungen'));
    td.colSpan = 8; tr.appendChild(td); tb.appendChild(tr); syncSortHeaders();
    return;
  }
  const CUT = 60;
  rows.slice(0, CUT).forEach((s) => {
    const tr = el('tr'); const c1 = el('td', 'u-cell-open');
    c1.appendChild(Object.assign(el('div', 'u-id'), { textContent: s.title || s.id.slice(0, 8) }));
    c1.appendChild(Object.assign(el('div', 'u-proj'), { textContent: s.projectPath + ' · ' + s.id.slice(0, 8) }));
    // A12: the row's only action was "start a chat" — a jump out of the analysis. Reading the transcript
    // is what a cost table invites, so the name cell now opens the viewer (▶ Fortsetzen stays on the right).
    c1.onclick = () => { showView('sessions'); if (typeof openTranscript === 'function') openTranscript(s, null); };
    c1.title = t('views-usage.transkriptOeffnen');
    mkClickable(c1, t('views-usage.transkriptOeffnen') + ': ' + (s.title || s.id.slice(0, 8)));
    tr.appendChild(c1);
    // the MAJORITY model plus how many others this session used — it used to print the last model that
    // happened to carry a frame, which labelled four sessions „<synthetic>"
    const mc = el('td', null, s.model || '—');
    if ((s.modelCount || 0) > 1) { mc.appendChild(el('span', 'u-model-more', ' +' + (s.modelCount - 1))); mc.title = (s.models || []).join(', ') + ' (' + t('views-usage.weitereModelle') + ')'; }
    tr.appendChild(mc);
    tr.appendChild(Object.assign(el('td', 'num'), { textContent: String(s.messages) }));
    tr.appendChild(Object.assign(el('td', 'num'), { textContent: fmtNum(s.tokens) }));
    tr.appendChild(Object.assign(el('td', 'num'), { textContent: fmtNum(s.output || 0) }));
    // The subagent share goes INTO the cost cell rather than into a column of its own: only 10-11 of 297
    // sessions have agent files at all, so a 9th column would be empty for 96 % of the table — but where
    // it exists it is up to 70 % of the session's cost, which must not be unlabelled.
    const cc = el('td', 'num', fmtUSD(s.cost || 0));
    if ((s.subCost || 0) > 0 || (s.subTokens || 0) > 0) cc.appendChild(el('div', 'u-sub-note', t('views-usage.davonSubKurz') + fmtUSD(s.subCost || 0)));
    tr.appendChild(cc);
    tr.appendChild(Object.assign(el('td', 'num'), { textContent: relTime(s.mtime) }));
    const c6 = el('td'); const rb = el('button', 'mini-btn', '▶'); rb.title = t('common.fortsetzen'); rb.setAttribute('aria-label', t('common.fortsetzen')); rb.onclick = () => resumeSession(s, false); c6.appendChild(rb); tr.appendChild(c6);
    tb.appendChild(tr);
  });
  // A12: the 60-row cut was silent — say how many rows are hidden and how to see them
  if (rows.length > CUT) {
    const tr = el('tr', 'u-more-row'); const td = el('td', null, t('common.nWeitere').replace('{n}', rows.length - CUT) + ' · ' + t('views-usage.nWeitereHinweis'));
    td.colSpan = 8; tr.appendChild(td); tb.appendChild(tr);
  }
  syncSortHeaders();
}
// a11y: reflect the active sort on the header cells (aria-sort) — .num/cursor alone told a screen
// reader nothing about which column is sorted, or that the headers are actionable at all.
function syncSortHeaders() {
  $$('#topSessions thead th[data-sort]').forEach((th) => {
    const on = usageView.sort === th.dataset.sort;
    th.setAttribute('aria-sort', on ? (usageView.dir < 0 ? 'descending' : 'ascending') : 'none');
    th.classList.toggle('sorted', on);
    th.title = t('views-usage.sortierenNach').replace('{label}', th.textContent); // re-resolved here, so a language switch relabels it
  });
}
// controls  (#uProject/#uModel are now themed ccSelect dropdowns built in populateUsageFilters)
// a11y: segmented toggles need aria-pressed — .active is invisible to assistive tech
function segPress(sel) { [...$(sel).children].forEach((c) => c.setAttribute('aria-pressed', c.classList.contains('active') ? 'true' : 'false')); }
$('#tsMetric').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; usageView.metric = b.dataset.m; [...$('#tsMetric').children].forEach((c) => c.classList.toggle('active', c === b)); segPress('#tsMetric'); renderUsage(); };
$('#tsGroup').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; usageView.group = b.dataset.g; [...$('#tsGroup').children].forEach((c) => c.classList.toggle('active', c === b)); segPress('#tsGroup'); renderUsage(); };
segPress('#tsMetric'); segPress('#tsGroup');
$('#uSessSearch').addEventListener('input', debounce((e) => { usageView.search = e.target.value; renderUsageSessions(); }));
// sortable headers: focusable + role=button, so the global Enter/Space handler in render.js activates them
$$('#topSessions thead th[data-sort]').forEach((th) => {
  th.style.cursor = 'pointer'; th.tabIndex = 0; th.setAttribute('role', 'button'); th.setAttribute('aria-sort', 'none');
  th.onclick = () => { const k = th.dataset.sort; if (usageView.sort === k) usageView.dir *= -1; else { usageView.sort = k; usageView.dir = (k === 'title' || k === 'model') ? 1 : -1; } renderUsageSessions(); };
});
$('#usageReload').onclick = () => loadUsage(true);
// ccuiApiUrl: a NAVIGATION, so the window.fetch wrapper (public/js/api-token.js) never sees it and the N9
// token has to go in the query — otherwise the CSV export downloads a 401 instead of a table.
$('#usageCsv').onclick = () => { window.location.href = ccuiApiUrl('/api/usage.csv' + usageQS()); };

// ============================================================
//  Enterprise Spend-Limit-Manager (Claude Enterprise) — the OFFICIAL monthly spend, next to the local
//  token estimates below. Data comes via the server (/api/spend), which fetches it through
//  the logged-in debug browser (CDP :9222); the card itself only ever renders the cached snapshot.
// ============================================================
let SPEND_AUTO_TRIED = false; // one silent refresh attempt per app session when the cache is stale
// EUR, not $ — the Spend-Limit-Manager settles in EUR (the card's own hint says so);
// rendering the official EUR figures with a $ sign right next to real € estimates was wrong
function spendFmtEUR(n) { return n == null ? '—' : Number(n).toLocaleString(LANG === 'en' ? 'en-US' : 'de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }); }
async function loadSpend(force) {
  const mount = $('#spendCard'); if (!mount) return;
  let snap;
  try { snap = await api('/api/spend'); } catch { return; }
  renderSpend(snap, null);
  const stale = !snap.fetchedAt || (Date.now() - snap.fetchedAt) > 12 * 3600 * 1000;
  if (force || (stale && !SPEND_AUTO_TRIED)) { SPEND_AUTO_TRIED = true; refreshSpend(false); }
}
async function refreshSpend(manual) {
  const mount = $('#spendCard'); if (!mount) return;
  mount.classList.add('spend-busy');
  let out;
  try { const r = await fetch('/api/spend/refresh', withCcuiHeader({ method: 'POST' })); out = await r.json(); }
  catch { out = { error: 'fetch-failed', message: t('views-usage.serverNichtErreichbar') }; }
  mount.classList.remove('spend-busy');
  if (out && out.fetchedAt) {
    renderSpend(out, null);
    if (manual) toast(t('views-usage.spendAktualisiert'), 'ok');
  } else {
    let snap = null; try { snap = await api('/api/spend'); } catch { /* */ }
    renderSpend(snap || { fetchedAt: null, data: null }, out || {});
    if (manual) toast((out && out.message) || t('common.fehler'), 'err');
  }
}
function renderSpend(snap, err) {
  const mount = $('#spendCard'); if (!mount) return;
  mount.classList.remove('hidden'); mount.innerHTML = '';
  const head = el('div', 'spend-head');
  head.appendChild(el('span', 'spend-title', t('views-usage.spendTitel')));
  const actions = el('div', 'spend-actions');
  const link = el('a', 'ghost-btn', t('views-usage.dashboardOeffnen'));
  link.href = (snap && snap.dashboardUrl) || 'https://ai-tool-dashboard.example.com/ai-tools/spend';
  link.target = '_blank'; link.rel = 'noopener';
  const rf = el('button', 'ghost-btn', '↻ ' + t('views-usage.aktualisieren'));
  rf.onclick = () => refreshSpend(true);
  actions.appendChild(link); actions.appendChild(rf);
  head.appendChild(actions);
  mount.appendChild(head);
  const d = snap && snap.data;
  if (d && Array.isArray(d.orgs) && d.orgs.length) {
    d.orgs.forEach((o) => {
      const row = el('div', 'spend-org');
      const meta = el('div', 'spend-meta');
      const pct = (o.limit && o.spent != null) ? Math.min(100, o.spent / o.limit * 100) : null;
      meta.appendChild(el('span', 'spend-amount', spendFmtEUR(o.spent)));
      meta.appendChild(el('span', 'spend-limit', t('views-usage.vonBetrag') + spendFmtEUR(o.limit) + (pct != null ? ' (' + fmtPct(pct) + ')' : '')));
      if (o.name && d.orgs.length > 1) meta.appendChild(el('span', 'spend-limit', o.name));
      row.appendChild(meta);
      const bar = el('div', 'spend-bar');
      const fill = el('div', 'spend-fill ' + (pct == null ? '' : pct < 60 ? 'ok' : pct < 85 ? 'warn' : 'danger'));
      fill.style.width = (pct == null ? 0 : Math.max(1.5, pct)) + '%';
      bar.appendChild(fill); row.appendChild(bar);
      const bits = [];
      if (o.baseline != null) bits.push(t('views-usage.baseline') + spendFmtEUR(o.baseline));
      if (o.expiresAt) { const dte = new Date(o.expiresAt); if (!isNaN(dte)) bits.push(t('views-usage.limitAktivBis') + dte.toLocaleDateString(LANG === 'en' ? 'en-US' : 'de-DE')); }
      bits.push(t('views-usage.resetMonatsanfang'));
      if (o.spent != null && snap.fetchedAt) { // month-end projection, anchored on the fetch date
        const f = new Date(snap.fetchedAt);
        const days = new Date(f.getFullYear(), f.getMonth() + 1, 0).getDate();
        bits.push(t('views-usage.hochrechnung') + spendFmtEUR(Math.round(o.spent / Math.max(1, f.getDate()) * days)));
      }
      row.appendChild(el('div', 'spend-sub', bits.join(' · ')));
      mount.appendChild(row);
    });
  } else if (!err || !err.error) {
    mount.appendChild(el('div', 'spend-sub', t('views-usage.nochKeineDatenGeladen')));
  }
  const info = [];
  if (d && d.pending && d.pending.amount != null) info.push(t('views-usage.antragOffen') + spendFmtEUR(d.pending.amount));
  else if (d && Array.isArray(d.requests) && d.requests.length && d.requests[0].status) info.push(t('views-usage.letzterAntrag') + spendFmtEUR(d.requests[0].amount) + ' · ' + d.requests[0].status);
  if (d && d.me && d.me.approver) info.push(t('views-usage.genehmiger') + d.me.approver);
  if (info.length) mount.appendChild(el('div', 'spend-sub', info.join('  ·  ')));
  mount.appendChild(el('div', 'spend-note', t('views-usage.spendHinweis')));
  mount.appendChild(el('div', 'spend-foot', t('views-usage.stand') + (snap && snap.fetchedAt ? relTime(snap.fetchedAt) : '—')));
  if (err && err.error) {
    const h = spendErrorHelp(err.error);
    const box = el('div', 'spend-err');
    box.appendChild(el('div', 'spend-err-title', t(h.title)));
    box.appendChild(el('div', 'spend-err-body', t(h.body)));
    const cmd = err.debugCmd || (snap && snap.debugCmd);
    // the command belongs to the two codes a debug browser can fix — including `fetch-failed`, where a tab
    // that no longer answers is the usual cause and restarting it is the usual remedy
    if (h.cmd && cmd) {
      const pre = el('pre', 'spend-cmd'); pre.textContent = cmd; pre.title = t('views-uiskills.kopieren');
      pre.onclick = () => { copyText(cmd); toast(t('views-usage.kommandoKopiert'), 'ok'); };
      box.appendChild(pre);
    }
    // SPEND-ERR: the technical sentence is KEPT — it is the only thing that distinguishes „CDP evaluate
    // timeout" from „unexpected-payload" when someone asks for help — but as a detail line under the
    // explanation, not AS the explanation.
    if (err.message && err.message !== t(h.title)) box.appendChild(el('div', 'spend-err-detail', err.message));
    mount.appendChild(box);
  }
}
// SPEND-ERR — what each refusal of POST /api/spend/refresh MEANS and what to do about it.
// `cdp-unreachable` and `auth` had a title and a help text; everything else fell through to
// `err.message` AS THE TITLE and no body at all — so the 502 a reader actually meets („CDP evaluate
// timeout", straight out of lib/spend.js, or „unexpected-payload") arrived as a bare technical string with
// nothing to do next, in the one card of the panel whose data comes from a browser the user has to run
// themselves. A separate function so the mapping is total by construction (a default, not a dangling
// ternary) and so a test can read it without building the card.
function spendErrorHelp(code) {
  if (code === 'cdp-unreachable') return { title: 'views-usage.debugBrowserNichtErreichbar', body: 'views-usage.debugBrowserStartenHinweis', cmd: true };
  if (code === 'auth') return { title: 'views-usage.anmeldungNoetig', body: 'views-usage.anmeldungHinweis', cmd: false };
  if (code === 'unexpected-payload') return { title: 'views-usage.spendStrukturTitel', body: 'views-usage.spendStrukturHinweis', cmd: false };
  return { title: 'views-usage.spendAbrufTitel', body: 'views-usage.spendAbrufHinweis', cmd: true };
}

