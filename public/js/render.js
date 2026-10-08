// Part of the Claude Code Control Panel front-end (split from app.js).
// Classic scripts share one global scope; load order in index.html is authoritative: render → chat → sessions → views → commands → boot.
// This file: render.js

'use strict';
// ============================================================
//  Claude Code Control Panel — frontend
// ============================================================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
// coalesce burst events (e.g. per-keystroke list rebuilds) into one call after `ms` of quiet
const debounce = (fn, ms = 160) => { let t; return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); }; };

// ============================================================
//  i18n (EN/DE) + language-driven currency (€/$)
// ============================================================
let LANG = 'de';
try { const s = localStorage.getItem('ccui-lang'); if (s === 'en' || s === 'de') LANG = s; } catch { /* */ }
// central keyed i18n (GitHub #21): t('area.slug') → the active language's string from the I18N dictionary (i18n.js, loaded first).
// typeof-guarded: if i18n.js ever fails to load, every caller degrades to the raw key instead of a load-time ReferenceError.
function t(key) { var D = (typeof I18N === 'undefined') ? null : I18N; var d = D && D[LANG]; var v = d && d[key]; if (v == null) v = D && D.de && D.de[key]; return v == null ? key : v; }
const EUR_RATE = 0.92; // USD→EUR estimate; displayed costs are list-price estimates anyway (no live fetch)
// NUM-LOC — the locale EVERY number in this panel is formatted with. `n.toLocaleString()` with no locale
// follows the BROWSER's, not the panel's: on an English Windows the German UI printed „1,234,567" and
// „1.5K", i.e. a thousands separator that reads as a decimal point to the person looking at it. The panel
// already does this correctly for dates (relTime below, the spend card) — these two helpers are so the
// rest of it can, in one place, instead of each call site remembering the ternary.
function numLocale() { return LANG === 'en' ? 'en-US' : 'de-DE'; }
function fmtInt(n) { const v = Number(n) || 0; try { return v.toLocaleString(numLocale()); } catch { return String(v); } }
function fmtDec(n, digits) {
  const v = Number(n) || 0; const d = digits == null ? 1 : digits;
  try { return v.toLocaleString(numLocale(), { minimumFractionDigits: d, maximumFractionDigits: d }); }
  catch { return v.toFixed(d); }
}
// …and the percent sign with it: German sets a space before it (DIN 5008), English does not. Counted in
// views-usage.js at the start of this run: FIVE displays print a percent into visible text (donut legend,
// KPI delta arrow, cache-hit tile, subagent share, spend limit). Two wrote „ %" by hand (share, spend
// limit) and three wrote „%" (legend, delta, cache hit) — same panel, same language, two spellings. All
// five go through this function now; `digits` is what keeps the delta arrow at 0 decimals (ideas.md H3
// still owns the question whether it should have one).
function fmtPct(n, digits) { return fmtDec(n, digits == null ? 1 : digits) + (LANG === 'en' ? '%' : ' %'); }
// language-driven money: DE → € (× rate, de-DE), EN → $ (en-US). Keep fine precision for sub-unit costs.
// MONEY-0: „0,0000 €" made two claims this number cannot support. Four decimals promise a precision a
// list-price ESTIMATE does not have, and for a value that merely ROUNDS to zero the string says the thing
// was free — the one reading nobody may take away from a cost display. So zero prints as zero (no
// decimals, nothing to misread), and anything below the last printable digit says „< 0,0001 €" instead.
function fmtMoney(usd) {
  usd = Number(usd) || 0;
  const de = LANG !== 'en';
  const v = de ? usd * EUR_RATE : usd;
  const cur = (val, dec) => {
    try { return new Intl.NumberFormat(de ? 'de-DE' : 'en-US', { style: 'currency', currency: de ? 'EUR' : 'USD', minimumFractionDigits: dec, maximumFractionDigits: dec }).format(val); }
    catch { return (de ? '€' : '$') + val.toFixed(dec); }
  };
  if (v === 0) return cur(0, 0);
  // 0,00005 is the value that still rounds to 0,0001 at four decimals — below it the printed figure
  // would be all zeros, which is the case this branch exists for.
  if (Math.abs(v) < 0.00005) return (v < 0 ? '> -' : '< ') + cur(0.0001, 4);
  return cur(v, Math.abs(v) >= 1 ? 2 : 4);
}
// relabel static index.html chrome tagged with data-i18n (+ -title/-ph/-aria/-label) → keys into the I18N dictionary
function applyStaticI18n() {
  document.querySelectorAll('[data-i18n]').forEach((e) => { e.textContent = t(e.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach((e) => { e.title = t(e.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-ph]').forEach((e) => e.setAttribute('placeholder', t(e.dataset.i18nPh)));
  document.querySelectorAll('[data-i18n-aria]').forEach((e) => e.setAttribute('aria-label', t(e.dataset.i18nAria)));
  document.querySelectorAll('[data-i18n-label]').forEach((e) => e.setAttribute('data-label', t(e.dataset.i18nLabel)));
  if (typeof hydrateIcons === 'function') hydrateIcons(); // re-apply data-label chips as icon+text
  if (typeof refreshEventBell === 'function') refreshEventBell(); // hydrateIcons wiped the 🔔 counter
}
// re-render whichever view is currently active (so a live language switch re-renders its dynamic content)
function reloadActiveView() {
  const a = document.querySelector('.nav-item.active'); const v = a && a.dataset.view;
  const call = (n) => { try { if (typeof window[n] === 'function') window[n](); } catch { /* */ } };
  if (v === 'sessions') call('loadSessions'); else if (v === 'settings') call('loadSettings');
  else if (v === 'mcp') call('loadMcp'); else if (v === 'usage') call('loadUsage');
  else if (v === 'memory') call('loadMemory'); else if (v === 'skills') call('loadSkills');
  else if (v === 'uiskills') call('loadUiSkills'); else if (v === 'system') call('loadSystem');
  else if (v === 'projects') call('loadProjects'); // P-1 — an open editor draft survives this (projects.js)
}
// switch language: persist, relabel static chrome, re-render chat chrome + the active view, reflect the flags
function applyLang(l) {
  LANG = (l === 'en') ? 'en' : 'de';
  try { localStorage.setItem('ccui-lang', LANG); } catch { /* */ }
  document.documentElement.lang = LANG;
  applyStaticI18n();
  const call = (n, ...a) => { try { if (typeof window[n] === 'function') window[n](...a); } catch { /* */ } };
  // loadCorrections is in this list on purpose: reloadActiveView() below routes Settings through
  // loadSettings(), which early-returns on its viewOnce guard — so the correction list would keep the
  // previous language until a reload (the same class of bug the earlier i18n passes chased).
  // The two sidebar update pills live OUTSIDE every view, so reloadActiveView() below never touches
  // them — their labels/tooltips stayed in the old language until the next 10-minute poll.
  // refreshSubagentNote for the same reason as loadCorrections: its text is written by JS, so the
  // static-i18n pass above walks straight past it (#34).
  // renderQueueStrip for the same reason: the strip is drawn by JS, so its head and the
  // „Alles zusammenfassen" button stayed in the old language while messages were waiting in it.
  // repaintSettEditors: the settings editors' validity badges are static i18n (an invalid editor read
  // „gültig" after a switch) and their broken-file banner is drawn by JS (stayed in the old language).
  // repaintAccentNote: the accent note under the colour field prints two measured contrast ratios with
  // their own wording („dunkel"/„hell", the drift warning) — JS-written, so the static pass walks past it.
  // planHistoryCardsRelabel (PF-1): a resumed transcript's plan cards are drawn by JS, in every tab — and so are the
  // live cards of an orphaned proposal (planCardsRelabel, PF-1b: „Plan liegt vor", ▶ Plan starten, the reason line).
  ['renderTabs', 'renderStatusBar', 'renderQueueStrip', 'renderTodoStrip', 'renderAgentStrip', 'renderSteps', 'populateModelSelect', 'rebuildDisplayDropdowns', 'refreshThemeBtn', 'refreshNavRailBtn', 'chatSideRefresh', 'refreshRailLabels', 'loadCorrections', 'refreshSubagentNote', 'applyEffortCap', 'repaintClaudeBinNote', 'repaintAccentNote', 'refreshAppVersion', 'refreshCliVersion', 'repaintSettEditors', 'planCardsRelabel', 'planHistoryCardsRelabel'].forEach((fn) => call(fn));
  // The context line is drawn by JS too, and for ANY active tab — not only for one that has a number
  // (CTX-3/CTX-7): a tab still waiting on its measurement shows „wird gemessen…", which is exactly as
  // language-dependent as the percentage. The `ctxTokens &&` guard that used to sit here also left the
  // tooltip wrong, because applyStaticI18n above restores #ctxGauge's static `data-i18n-title` and only
  // updateCtxGauge writes the real one (ctxGaugeTitle).
  try { if (typeof ACTIVE !== 'undefined' && ACTIVE && typeof updateCtxGauge === 'function') updateCtxGauge(ACTIVE); } catch { /* */ }
  reloadActiveView();
  document.querySelectorAll('#langFlags .lang-flag').forEach((b) => b.classList.toggle('active', b.dataset.lang === LANG));
}
document.documentElement.lang = LANG;

// --- lightweight, safe markdown -> HTML ---
// `"` included: escaped text flows into href="…" (mdInline link rule) — an unescaped quote in a
// model-authored link target could otherwise break out of the attribute (onmouseover=… injection).
function mdEscape(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// --- tiny zero-dependency syntax highlighter (SAP-aware, multi-language) ---
const HL_KEYWORDS = new Set((
  'await async function return if else elif for while do switch case break continue new class extends super this const let var import export default from typeof instanceof in of try catch finally throw yield delete void ' +
  'def lambda pass raise with as global nonlocal print not and or is del assert ' +
  'public private protected static final abstract interface enum namespace implements package void int long float double boolean char short byte ' +
  'fn pub use mod match loop move ref where trait dyn impl struct string bool usize i32 i64 u32 u64 ' +
  'func type go defer chan select map range var val fun object companion when sealed suspend ' +
  'select insert update delete from where into inner join left right outer on group by order having values set create table drop alter view index as distinct union ' +
  // ABAP / CDS
  'data types method endmethod methods class endclass definition implementation interface endinterface if elseif endif loop endloop form endform perform call module endfunction ' +
  'move append modify read exit check others begin end declare local sy tables parameters report write skip uline constants field-symbols assign create raise exception ' +
  'do enddo while endwhile case endcase when concatenate split condense translate clear refresh free commit rollback wait message export import corresponding ' +
  'define associations association composition projection root parent redirected annotate extend metadata using key cast preserving ' +
  // shell
  'echo then fi done esac export unset shift'
).split(/\s+/).map((s) => s.toLowerCase()));

function hlGeneric(code, lang) {
  const hash = ['bash', 'sh', 'shell', 'zsh', 'console', 'python', 'py', 'ruby', 'rb', 'yaml', 'yml', 'toml', 'perl', 'r', 'make', 'makefile', 'dockerfile', 'abap', 'cds', 'ddls'].includes(lang);
  const re = hash
    ? /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"[^\n]*)|('(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(@[\w.]+)|(\b\d[\w.]*\b)|([A-Za-z_$][\w$-]*)/g
    : /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(@[\w.]+)|(\b\d[\w.]*\b)|([A-Za-z_$][\w$]*)/g;
  // note: ABAP uses " for line comments and ' for strings — handled by the `hash` regex
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += mdEscape(code.slice(last, m.index));
    const t = m[0];
    if (m[1]) out += '<span class="hl-com">' + mdEscape(t) + '</span>';
    else if (m[2]) out += '<span class="hl-str">' + mdEscape(t) + '</span>';
    else if (m[3]) out += '<span class="hl-anno">' + mdEscape(t) + '</span>';
    else if (m[4]) out += '<span class="hl-num">' + mdEscape(t) + '</span>';
    else {
      const lw = t.toLowerCase();
      if (['true', 'false', 'null', 'none', 'nil', 'undefined', 'abap_true', 'abap_false'].includes(lw)) out += '<span class="hl-lit">' + mdEscape(t) + '</span>';
      else if (HL_KEYWORDS.has(lw)) out += '<span class="hl-kw">' + mdEscape(t) + '</span>';
      else out += mdEscape(t);
    }
    last = re.lastIndex;
  }
  out += mdEscape(code.slice(last));
  return out;
}
function hlAttrs(s) {
  return s.replace(/([\w:.-]+)(\s*=\s*)("[^"]*"|'[^']*')|([\w:.-]+)/g, (full, name, eq, val, bare) => {
    if (name) return '<span class="hl-attr">' + mdEscape(name) + '</span>' + mdEscape(eq) + '<span class="hl-str">' + mdEscape(val) + '</span>';
    if (bare) return '<span class="hl-attr">' + mdEscape(bare) + '</span>';
    return mdEscape(full);
  });
}
function hlXml(code) {
  const re = /(<!--[\s\S]*?-->)|(<[!?]?\/?)([\w:.-]+)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?>)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += mdEscape(code.slice(last, m.index));
    if (m[1]) out += '<span class="hl-com">' + mdEscape(m[1]) + '</span>';
    else out += '<span class="hl-punct">' + mdEscape(m[2]) + '</span>' + '<span class="hl-tag">' + mdEscape(m[3]) + '</span>' + hlAttrs(m[4] || '') + '<span class="hl-punct">' + mdEscape(m[5]) + '</span>';
    last = re.lastIndex;
  }
  out += mdEscape(code.slice(last));
  return out;
}
function hlProps(code) {
  return code.split('\n').map((line) => {
    if (/^\s*[#!]/.test(line)) return '<span class="hl-com">' + mdEscape(line) + '</span>';
    const m = line.match(/^(\s*)([^=:]+?)(\s*[=:]\s*)(.*)$/);
    if (m) return mdEscape(m[1]) + '<span class="hl-attr">' + mdEscape(m[2]) + '</span>' + '<span class="hl-punct">' + mdEscape(m[3]) + '</span>' + '<span class="hl-str">' + mdEscape(m[4]) + '</span>';
    return mdEscape(line);
  }).join('\n');
}
function highlightCode(code, lang) {
  code = String(code == null ? '' : code);
  lang = (lang || '').toLowerCase();
  if (['xml', 'html', 'htm', 'xhtml', 'svg', 'xsd', 'wsdl', 'xslt'].includes(lang)) return hlXml(code);
  if (['properties', 'ini', 'conf', 'env', 'cfg'].includes(lang)) return hlProps(code);
  return hlGeneric(code, lang);
}
// --- clipboard ---
function copyText(str) {
  const ok = () => toast(t('render.kopiert'), 'ok');
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(str).then(ok, () => fallbackCopy(str, ok)); return; }
  } catch {}
  fallbackCopy(str, ok);
}
function fallbackCopy(t, ok) {
  const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); ok(); } catch {} ta.remove();
}
// --- inline SVG icon set (Feather-style, matches the nav) ---
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  play: '<path d="M7 5l12 7-12 7z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor" stroke="none"/>',
  sparkle: '<path d="M12 3c.5 4 2.5 6 6.5 6.5-4 .5-6 2.5-6.5 6.5-.5-4-2.5-6-6.5-6.5C9.5 9 11.5 7 12 3z" fill="currentColor" stroke="none"/><path d="M19 3.5l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9L16.5 6l1.9-.6z" fill="currentColor" stroke="none"/>',
  display: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  steps: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor" stroke="none"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  pin: '<path d="M9 3h6l-1 5 3 4H7l3-4z"/><path d="M12 16v5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  wrap: '<path d="M4 6h16M4 12h13a3 3 0 0 1 0 6h-3m0 0 2-2m-2 2 2 2M4 18h5"/>',
  reload: '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>',
  chevronUp: '<path d="M18 15l-6-6-6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronLeft: '<path d="M15 18l-6-6 6-6"/>',
  chevronRight: '<path d="M9 18l6-6-6-6"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5 5h14l3 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
  star: '<path d="M12 3l2.9 6 6.1.9-4.5 4.3 1.1 6.1L12 17.8 6.4 20.3l1.1-6.1L3 9.9 9.1 9z"/>',
  play2: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M11 9l4 3-4 3z" fill="currentColor" stroke="none"/>',
  download: '<path d="M12 3v12M7 11l5 5 5-5M4 21h16"/>',
  pause: '<rect x="7" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.6" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  fork: '<circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="6" r="2.6"/><path d="M6 8.6v6.8M18 8.6c0 5-3.4 6.6-6.6 7.4"/>',
  braces: '<path d="M8 4c-1.8 0-2.6 1-2.6 2.8v2C5.4 10.3 4.6 11.2 3.4 11.7c1.2.5 2 1.4 2 2.9v2C5.4 19 6.2 20 8 20M16 4c1.8 0 2.6 1 2.6 2.8v2c0 1.5.8 2.4 2 2.9-1.2.5-2 1.4-2 2.9v2C18.6 19 17.8 20 16 20"/>',
  flask: '<path d="M9 3h6M10 3v5.5L4.9 17.4A2 2 0 0 0 6.6 20.5h10.8a2 2 0 0 0 1.7-3.1L14 8.5V3"/><path d="M7.5 14.5h9"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.5 12c0-.5-.05-1-.13-1.47l1.9-1.48-1.9-3.29-2.25.9a7.5 7.5 0 0 0-2.55-1.47L14.1 2.7h-3.8l-.37 2.52a7.5 7.5 0 0 0-2.55 1.47l-2.25-.9-1.9 3.29 1.9 1.48a7.6 7.6 0 0 0 0 2.94l-1.9 1.48 1.9 3.29 2.25-.9a7.5 7.5 0 0 0 2.55 1.47l.37 2.52h3.8l.37-2.52a7.5 7.5 0 0 0 2.55-1.47l2.25.9 1.9-3.29-1.9-1.48c.08-.47.13-.97.13-1.47z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4.5M12 8h.01"/>',
  leaf: '<path d="M4 20c0-9 6-15 16-15 0 10-6 16-15 16M5 19c2.5-4.5 6-7.5 10-9"/>',
  hook: '<path d="M13 4a4 4 0 0 0-4 4v8a3 3 0 0 1-6 0"/><circle cx="13" cy="4" r="2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  auto: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/>',
  checkSquare: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12l3 3 5-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  save: '<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M8 3v5h7M7.5 21v-6h9v6"/>',
  palette: '<circle cx="8.5" cy="7.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="13" cy="6.2" r="1.1" fill="currentColor" stroke="none"/><circle cx="16.8" cy="9.2" r="1.1" fill="currentColor" stroke="none"/><circle cx="6.8" cy="12" r="1.1" fill="currentColor" stroke="none"/><path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-.9-.5-1.3-.3-.3-.5-.8-.5-1.2 0-1 .8-1.8 1.8-1.8H16a5 5 0 0 0 5-5c0-3.9-4-6.7-9-6.7z"/>',
  plug: '<path d="M9 2v5M15 2v5M7 7h10v3a5 5 0 0 1-10 0z"/><path d="M12 15v7"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 13 18 8z"/><path d="M13.7 19a2 2 0 0 1-3.4 0"/>',
  bug: '<rect x="8" y="8" width="8" height="12" rx="4"/><path d="M12 8v12M9.5 8a2.5 2.5 0 0 1 5 0M10 5.2 9 3.4M14 5.2l1-1.8M8 12H3.8M8 15.4l-3.6 1.8M8 8.6 4.4 6.8M16 12h4.2M16 15.4l3.6 1.8M16 8.6 19.6 6.8"/>',
  // budget cap (A3) and extra working dirs (A15) and the plans browser (A7)
  coin: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M14.2 9.6c-.5-.7-1.3-1-2.2-1-1.2 0-2 .6-2 1.5s.8 1.3 2 1.5 2 .6 2 1.5-.9 1.5-2 1.5c-.9 0-1.7-.3-2.2-1"/>',
  folders: '<path d="M4 8V6a2 2 0 0 1 2-2h3l2 2h5a2 2 0 0 1 2 2v1"/><path d="M2 11a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"/>',
  map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
  // subagent policy (#34): model, ceilings, and whether a chat may spawn agents at all
  bot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M8.5 13v1.5M15.5 13v1.5M2.5 12.5v3M21.5 12.5v3"/><circle cx="12" cy="3.2" r="1.3"/>',
  // ICON-DUP: „Leitplanken" and „Berechtigungen" both drew `lock` in the Settings jump bar, so two of
  // nine chips were the same picture — and the jump bar is scanned by SHAPE, which is the only reason it
  // carries icons at all. The shield is the glyph that section already uses in its own checkbox (🛡).
  shield: '<path d="M12 3l8 3v5.5c0 4.8-3.3 8.4-8 9.5-4.7-1.1-8-4.7-8-9.5V6z"/>',
  // P-1 — a PROJECT (start profile + label). Not `folder`/`folders`: those already stand for the cwd and the
  // additional directories, and a project is neither. Same shape as its nav button in index.html.
  project: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
};
function ic(name, size) {
  const p = ICONS[name]; if (!p) return '';
  const s = size || 18;
  return '<svg class="ic" viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
}
function copyBtn(getText, title) {
  const b = el('button', 'copy-btn'); b.type = 'button'; b.title = title || t('common.kopieren'); b.setAttribute('aria-label', title || t('common.kopieren')); b.innerHTML = ic('copy', 15);
  b.onclick = (e) => { e.stopPropagation(); e.preventDefault(); copyText(getText()); };
  return b;
}
function pinBtn(onClick) {
  const b = el('button', 'tc-pin'); b.type = 'button'; b.title = t('render.imPanelAnheften'); b.setAttribute('aria-label', t('render.imPanelAnheften')); b.innerHTML = ic('pin', 15);
  b.onclick = (e) => { e.stopPropagation(); e.preventDefault(); onClick(); };
  return b;
}
// make a non-native clickable element keyboard-operable (role=button + focusable)
function mkClickable(elem, label) {
  elem.setAttribute('role', 'button');
  if (!elem.hasAttribute('tabindex')) elem.tabIndex = 0;
  if (label) elem.setAttribute('aria-label', label);
  return elem;
}
// one global handler: Enter/Space activates any focused role=button that isn't a
// native control (keeps every clickable card operable without per-site keydown)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  const t = e.target;
  if (!t || !t.getAttribute || t.getAttribute('role') !== 'button') return;
  if (/^(BUTTON|A|INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
  e.preventDefault();
  t.click();
});
// generic icon (± label) button — one recipe for all JS-generated chrome
// The label is TEXT, never markup: it used to be concatenated into innerHTML, so a name that happens to
// contain "<" (a server- or model-supplied one, e.g. a skill/session title) was parsed as HTML. The icon
// is still innerHTML — it is this file's own SVG string — the label is appended as a text node.
function labelSpan(label) {
  const s = el('span', 'btxt'); s.textContent = String(label); return s;
}
function iconBtn(cls, iconName, opts) {
  opts = opts || {};
  const b = el('button', cls); b.type = 'button';
  b.innerHTML = ic(iconName, opts.size || 15);
  if (opts.label) { b.appendChild(document.createTextNode(' ')); b.appendChild(labelSpan(opts.label)); }
  if (opts.title) b.title = opts.title;
  const al = opts.title || opts.label; if (al) b.setAttribute('aria-label', al);
  if (opts.onClick) b.onclick = opts.onClick;
  return b;
}
// swap static chrome placeholders (data-ic / data-label) for SVG icons
function hydrateIcons() {
  document.querySelectorAll('[data-ic]').forEach((elx) => {
    const name = elx.getAttribute('data-ic');
    const size = +elx.getAttribute('data-ic-size') || (elx.classList.contains('empty-glyph') ? 40 : 16);
    const label = elx.getAttribute('data-label');
    elx.innerHTML = ic(name, size); // same rule as iconBtn: icon as markup, label as text
    if (label) { elx.appendChild(document.createTextNode(' ')); elx.appendChild(labelSpan(label)); }
  });
}
// add a header bar (language · wrap · copy · copy-as-markdown · preview) to code blocks
function decorateCode(container) {
  container.querySelectorAll('pre.md-pre').forEach((pre) => {
    if (pre.previousElementSibling && pre.previousElementSibling.classList.contains('code-head')) return;
    const code = pre.querySelector('code');
    const text = () => code ? code.innerText : pre.innerText;
    const lang = ((code && code.className.match(/lang-([\w+.-]+)/)) || [])[1] || '';
    const head = el('div', 'code-head');
    head.appendChild(el('span', 'code-lang', lang || 'text'));
    const acts = el('span', 'code-actions');
    const act = (html, title, fn, cls) => { const b = el('button', 'code-act' + (cls ? ' ' + cls : '')); b.innerHTML = html; b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); b.onclick = (e) => { e.stopPropagation(); e.preventDefault(); fn(b); }; return b; };
    acts.appendChild(act(ic('wrap', 14), t('render.zeilenumbruchAnAus'), (b) => { pre.classList.toggle('wrap'); b.classList.toggle('on'); }));
    const looksHtml = /^(html|xml|svg|xhtml)$/i.test(lang) || (!lang && /<[a-z!][\s\S]*>/i.test(text()));
    if (looksHtml) acts.appendChild(act(ic('play', 14), t('render.vorschauImPanel'), () => sidecarPreview(text(), t('common.vorschau'))));
    acts.appendChild(act('<span class="code-md">md</span>', t('render.alsMarkdownCodeblockKopieren'), () => copyText('```' + (lang || '') + '\n' + text() + '\n```')));
    acts.appendChild(act(ic('copy', 14), t('render.codeKopieren'), () => copyText(text())));
    head.appendChild(acts);
    pre.parentNode.insertBefore(head, pre);
  });
}

// --- language + line diff (for Edit/Write tool cards) ---
function extLang(fp) {
  const ext = (String(fp || '').match(/\.([a-z0-9]+)(?:[?#].*)?$/i) || [])[1] || '';
  const map = { abap: 'abap', cds: 'cds', ddls: 'cds', asddls: 'cds', js: 'js', mjs: 'js', cjs: 'js', ts: 'ts', jsx: 'js', tsx: 'ts', json: 'json', xml: 'xml', view: 'xml', fragment: 'xml', html: 'html', htm: 'html', css: 'css', scss: 'css', less: 'css', md: 'markdown', sql: 'sql', properties: 'properties', yaml: 'yaml', yml: 'yaml', sh: 'bash', bash: 'bash', py: 'python', java: 'java', go: 'go', rs: 'rust' };
  return map[ext.toLowerCase()] || '';
}
function diffLines(aStr, bStr) {
  const a = String(aStr == null ? '' : aStr).split('\n');
  const b = String(bStr == null ? '' : bStr).split('\n');
  const n = a.length, m = b.length;
  if (n * m > 400000) { // guard: skip LCS for huge inputs
    return a.map((s) => ({ t: '-', s })).concat(b.map((s) => ({ t: '+', s })));
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', s: a[i] }); i++; }
    else { out.push({ t: '+', s: b[j] }); j++; }
  }
  while (i < n) out.push({ t: '-', s: a[i++] });
  while (j < m) out.push({ t: '+', s: b[j++] });
  return out;
}
function diffEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function diffTokenize(s) { return String(s).match(/\s+|[^\s]+/g) || []; }
// intra-line word diff → { a:[{c,s}], b:[{c,s}] } (c = changed)
function wordDiffMark(aLine, bLine) {
  const a = diffTokenize(aLine), b = diffTokenize(bLine), n = a.length, m = b.length;
  if (n * m > 40000 || (!n && !m)) return null;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const aOut = [], bOut = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { aOut.push({ c: false, s: a[i] }); bOut.push({ c: false, s: b[j] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { aOut.push({ c: true, s: a[i++] }); }
    else { bOut.push({ c: true, s: b[j++] }); }
  }
  while (i < n) aOut.push({ c: true, s: a[i++] });
  while (j < m) bOut.push({ c: true, s: b[j++] });
  return { a: aOut, b: bOut };
}
function diffRow(cls, gutter, innerHtml) {
  const line = el('div', 'diff-line ' + cls);
  line.appendChild(el('span', 'diff-gutter', gutter));
  const code = el('span', 'diff-code'); code.innerHTML = innerHtml || '&nbsp;';
  line.appendChild(code);
  return line;
}
function renderDiff(oldStr, newStr, lang) {
  const wrap = el('div', 'diff');
  const rows = diffLines(oldStr, newStr);
  // very large diffs (e.g. a big Write, or many cards on resume) cost a synchronous highlight burst
  // at build time; skip per-line syntax highlighting past a threshold — still readable as plain text.
  const bigDiff = rows.length > 300;
  const markTok = (toks) => toks.map((t) => t.c ? '<span class="dw">' + diffEsc(t.s) + '</span>' : diffEsc(t.s)).join('');
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    if (r.t === '-' && rows[k + 1] && rows[k + 1].t === '+') {
      const wd = wordDiffMark(r.s, rows[k + 1].s);
      if (wd) { wrap.appendChild(diffRow('del', '−', markTok(wd.a))); wrap.appendChild(diffRow('add', '+', markTok(wd.b))); k++; continue; }
    }
    const cls = r.t === '+' ? 'add' : r.t === '-' ? 'del' : 'ctx';
    wrap.appendChild(diffRow(cls, r.t === '+' ? '+' : r.t === '-' ? '−' : ' ', (bigDiff ? diffEsc(r.s) : highlightCode(r.s, lang)) || '&nbsp;'));
  }
  return wrap;
}

// The fenced blocks the panel LIFTS out of a message instead of showing them: the UI-skill result (its card),
// the open points (their card + rail row) and the plan status (the plan group in the rail, PF-1). While one is
// still streaming its raw JSON must never be painted — renderMarkdown below swaps the open tail away, and the
// stream renderer (chat-render.js renderStreamEl) must not switch into fence mode for them. One list for both,
// so a fourth block cannot be hidden in one place and streamed raw in the other.
const MD_LIFTED_FENCES = ['ui-result', 'offene-punkte', 'plan-status'];
const MD_LIFTED_FENCE_RE = new RegExp('^```(?:' + MD_LIFTED_FENCES.join('|') + ')');
// `opts.stream`: the text is still arriving (chat-render.js renderStreamEl, its live tail) — see plan-status below.
function renderMarkdown(src, opts) {
  src = String(src == null ? '' : src);
  // a still-open ```ui-result fence at the very end (streaming) would render as raw JSON prose —
  // swap the unfinished tail for a pending marker until the closing fence arrives
  src = src.replace(/```ui-result[^\n]*\n(?![\s\S]*```)[\s\S]*$/, '⏳ ' + t('render.ergebnisWirdErstellt'));
  // …same for a half-written ```offene-punkte block: the finished message turns it into cards (CHAT-FLOW-8)
  src = src.replace(/```offene-punkte[^\n]*\n(?![\s\S]*```)[\s\S]*$/, '⏳ ' + t('render.offenePunkteWerdenGesammelt'));
  // …and a half-written ```plan-status block simply goes: the finished message moves it into the rail, and
  // it is two lines long — a marker would only flicker in and out of the bubble at every step change. No
  // newline required after the tag: the extractor also reads a block whose JSON starts on the fence line.
  // WHILE STREAMING only, and only up to a blank line: a block whose closing fence never comes is the model's
  // slip, and it used to swallow everything after it in the FINISHED message too (the report unapplied, the
  // prose gone). The finished text goes through planStatusStrip first, which reads such a block up to its blank
  // line (plan-progress.js planStatusOpenTail) — so the stream hides exactly what the final render drops.
  if (opts && opts.stream) src = src.replace(/```plan-status(?![\w-])(?![\s\S]*```)[\s\S]*?(?:\n[ \t]*\n|$)/, '');
  // …and before any of them can match, the fence line itself arrives in pieces („```off") — drop such a
  // trailing partial opener instead of flashing it as prose for a frame
  src = src.replace(/(^|\n)```([\w-]+)$/, (all, pre, tag) => (MD_LIFTED_FENCES.some((f) => f.startsWith(tag)) ? pre : all));
  // split on fenced code blocks; with 2 capture groups split() yields
  // [text, lang, code, text, lang, code, ...]  ([\w-]* so "ui-result" survives as a lang tag)
  const parts = src.split(/```([\w-]*)\n?([\s\S]*?)```/g);
  let html = '';
  for (let k = 0; k < parts.length; k++) {
    if (k % 3 === 0) { html += renderMdBlocks(parts[k] || ''); }
    else if (k % 3 === 2) {
      const lang = (parts[k - 1] || '').replace(/[^\w-]/g, '');
      const code = (parts[k] || '').replace(/\n$/, '');
      // ui-result data block → compact collapsible placeholder (the result card renders it);
      // an unparseable block falls through to the plain code block for debugging
      if (lang === 'ui-result' && typeof uiResultNormalize === 'function') {
        let norm = null; try { norm = uiResultNormalize(JSON.parse(code)); } catch { /* invalid → code block */ }
        if (norm) {
          html += '<details class="md-uiresult"><summary>📊 ' + t('render.ergebnis') + ' (' + norm.rows.length + ' ' + t('render.zeilen') + ')</summary>'
            + '<pre class="md-pre"><code class="lang-json">' + mdEscape(code) + '</code></pre></details>';
          continue;
        }
      }
      // a complete open-points block before its message is finished (the stream) → the same compact
      // placeholder; the frame's end replaces it with the cards. Invalid JSON stays a readable code block —
      // it is never lifted (openPointsStrip keeps it), so this is the only place it can be seen.
      if (lang === 'offene-punkte' && typeof openPointsNormalize === 'function') {
        let pts = null; try { pts = openPointsNormalize(JSON.parse(code)); } catch { /* invalid → code block */ }
        if (pts && pts.length) {
          html += '<details class="md-oppoints"><summary>❓ ' + t('render.offenePunkte') + ' (' + pts.length + ')</summary>'
            + '<pre class="md-pre"><code class="lang-json">' + mdEscape(code) + '</code></pre></details>';
          continue;
        }
      }
      // a complete plan-status block → nothing at all: the rail shows the state, and planStatusStrip takes the
      // block out of the finished message anyway. Exactly ITS rule (any JSON goes, not-JSON stays a readable
      // code block), so the bubble cannot show something mid-stream that the finished message no longer has.
      if (lang === 'plan-status') {
        let isJson = false; try { JSON.parse(code); isJson = true; } catch { /* invalid → code block */ }
        if (isJson) continue;
      }
      html += '<pre class="md-pre"><code class="lang-' + lang + '">' + highlightCode(code, lang) + '</code></pre>';
    }
  }
  return html;
}

function mdInline(t) {
  t = mdEscape(t);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t;
}

function renderMdBlocks(src) {
  const lines = src.split('\n');
  let html = '', i = 0, m;
  const special = (l) => /^(#{1,6})\s/.test(l) || /^\s*([-*+])\s/.test(l) || /^\s*\d+\.\s/.test(l) || /^\s*>/.test(l) || /^\s*(---|\*\*\*|___)\s*$/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    if (m = line.match(/^(#{1,6})\s+(.*)$/)) { const l = m[1].length; html += '<h' + l + ' class="md-h">' + mdInline(m[2]) + '</h' + l + '>'; i++; continue; }
    if (/^\s*([-*+])\s+/.test(line)) { html += '<ul class="md-ul">'; while (i < lines.length && /^\s*([-*+])\s+/.test(lines[i])) { html += '<li>' + mdInline(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>'; i++; } html += '</ul>'; continue; }
    if (/^\s*\d+\.\s+/.test(line)) { html += '<ol class="md-ol">'; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { html += '<li>' + mdInline(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>'; i++; } html += '</ol>'; continue; }
    if (/^\s*>\s?/.test(line)) { const q = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; } html += '<blockquote>' + mdInline(q.join(' ')) + '</blockquote>'; continue; }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { html += '<hr>'; i++; continue; }
    // GFM table: header row + separator row of ---/:
    if (/\|/.test(line) && i + 1 < lines.length && /\|/.test(lines[i + 1]) && /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(lines[i + 1])) {
      const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const header = splitRow(line); i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && /\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      html += '<table class="md-table"><thead><tr>' + header.map((h) => '<th>' + mdInline(h) + '</th>').join('') + '</tr></thead><tbody>';
      rows.forEach((r) => { html += '<tr>' + r.map((c) => '<td>' + mdInline(c) + '</td>').join('') + '</tr>'; });
      html += '</tbody></table>';
      continue;
    }
    const para = [line]; i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !special(lines[i])) { para.push(lines[i]); i++; }
    html += '<p>' + mdInline(para.join('\n')).replace(/\n/g, '<br>') + '</p>';
  }
  return html;
}

// X-CCUI is the CSRF token that needs no token: the server refuses a browser's state-changing /api call
// without it, and a foreign page cannot add a custom header without a CORS preflight the server never
// answers. MERGED into the caller's headers (not replacing them), so a Content-Type survives.
const CCUI_HEADER = 'X-CCUI';
function withCcuiHeader(opts) {
  const o = Object.assign({}, opts);
  const h = new Headers(o.headers || {});
  h.set(CCUI_HEADER, '1');
  o.headers = h;
  return o;
}
// claude.exe gone (a failed update moved it away and put nothing back): the path that is missing plus
// the previous version(s) still lying next to it — renaming one back is the way out.
function cliMissingText(data) {
  const old = (data && Array.isArray(data.oldFiles)) ? data.oldFiles : [];
  // N12: a binary on a share that does not answer is not „missing" — renaming files back would not help
  if (data && data.unreachable) return t('render.cliNichtErreichbar').replace('{s}', String(data.timeoutSec || '?')) + ((data && data.exe) || 'claude.exe');
  return t('render.cliFehlt') + ((data && data.exe) || 'claude.exe')
    + (old.length ? t('render.cliAlteDateien') + old.join(', ') : '');
}
// B1/B2: the codes every CLI-spawning route answers with, translated ONCE here — chat start, doctor,
// MCP probes, enhance … all show `e.message` already, and used to show the bare code `cli-updating`.
// `busy-updating` is /api/restart refusing while an update runs; `what` says which one, so the text can.
// `shutting-down` (#4) is chat start / a scheduled run refusing because shutdown() has begun — a restart
// is usually what began it, so the retry is a moment away, not an error to chase.
// SCHED-1's two refusals belong here for the same reason, and because the create dialog is not the only
// way to meet them: the Pausieren/Aktivieren button of an EXISTING schedule re-POSTs the stored row, and
// switching a pre-guard row back ON is refused on purpose (test/data-guards-routes.test.js) — which
// arrived as the bare English server sentence „invalid timing: daily needs at least one weekday", i.e.
// exactly the shape SPEND-ERR abolishes one card away. `bad-timing` covers FOUR server refusals, so only
// the one we can name gets the dialog's own sentence; the rest get the class plus the technical sentence,
// the same split spendErrorHelp() makes. The string match is pinned against lib/pure.js by a test, so it
// cannot rot into a wrong claim. `fields` are the ids the ROUTE names — the dialog says labels because it
// has the manifest, this layer does not.
const SCHED_NO_WEEKDAY = 'daily needs at least one weekday';
function apiErrorText(data, fallback) {
  const code = data && data.code;
  if (code === 'cli-updating') return t('render.cliWirdAktualisiert');
  if (code === 'cli-missing') return cliMissingText(data);
  if (code === 'shutting-down') return t('render.panelFaehrtHerunter');
  // N12 — the chat start asked the cwd / --add-dir first and it did not answer within the deadline
  if (code === 'path-unreachable') {
    return t('render.pfadNichtErreichbar').replace('{s}', String(data.timeoutSec || '?')).replace('{path}', String(data.path || ''))
      + (data.remembered ? t('render.pfadNichtErreichbarGemerkt') : '');
  }
  // CHAT-FLOW-4 — a resume the server refused because another tab or window holds the session. The chat tab
  // shows its own card for it; this is the sentence every OTHER place that toasts e.message gets (a deferred
  // restart, a UI-skill follow-up) instead of the server's English „session open elsewhere".
  if (code === 'session-open-elsewhere') return t('render.sitzungAnderswoOffen');
  if (code === 'busy-updating') return t(data.what === 'pull' ? 'render.neustartBlockiertPull' : data.what === 'cli' ? 'render.neustartBlockiertCli' : 'render.neustartBlockiert');
  if (code === 'bad-timing') {
    const raw = (data && data.error) || '';
    if (raw.includes(SCHED_NO_WEEKDAY)) return t('views-uiskills.zeitplanOhneWochentag');
    return t('render.zeitplanRhythmusUngueltig') + (raw ? ' (' + raw + ')' : '');
  }
  if (code === 'missing-required') return t('views-uiskills.zeitplanPflichtfelder').replace('{fields}', (data && Array.isArray(data.fields) ? data.fields : []).join(', '));
  return (data && data.error) || fallback;
}
async function api(path, opts) {
  const r = await fetch(path, withCcuiHeader(opts));
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  // The thrown Error carries the response along: a route that explains itself in extra fields (the
  // files a `dirty-main` refusal names, for example) used to have all of that dropped here, leaving
  // callers to regex the error code out of `message` and guess the rest.
  if (!r.ok) { const e = new Error(apiErrorText(data, r.statusText)); e.status = r.status; e.code = (data && data.code) || ''; e.data = data; throw e; }
  return data;
}

// Toasts vanish after 4 seconds — so every one of them is also kept in a small event log that the
// 🔔 in the header shows. Answers "was ist passiert, während ich in einem anderen Fenster war?".
const EVENTS = [];
// H4: `opts.undo = { label, onClick }` adds ONE button to the toast and gives it a longer life. The undo
// affordance in this panel was invented twice before (the queue's `.cq-undo` chip, the composer's
// `#editingChip`) and both live next to the thing they undo — there is no such place for a chip that
// vanished from a rail, so the recovery travels with the notice. Its label reuses
// `chat-composer.rueckgaengig` instead of adding a second word for the same act.
// 12 s, not 4,2: an undo you cannot reach in time is not an undo. Not sticky either — a routine revoke
// that waits for a click would nag, and the × is right there. Erroring stays stickier than undoing.
const TOAST_MS = 4200, TOAST_UNDO_MS = 12000;
function toast(msg, kind = '', opts = {}) {
  const t = el('div', 'toast ' + kind, msg);
  const dismiss = () => { t.style.opacity = '0'; t.style.transform = 'translateX(20px)'; setTimeout(() => t.remove(), 250); };
  const closeBtn = () => {
    const x = el('button', 'toast-x', '×'); x.type = 'button';
    x.setAttribute('aria-label', 'schließen');
    x.onclick = (e) => { e.stopPropagation(); dismiss(); };
    t.appendChild(x);
  };
  // Kinds: '' (info) · 'ok' · 'warn' · 'err'. An ERROR that auto-dismisses after 4,2 s is a failure you
  // can miss entirely by looking away for five seconds — afterwards it exists only in the 🔔 log (B15).
  // So errors, and ONLY errors, wait for a click. Everything else keeps the timer: an acknowledgement or
  // a heads-up has nothing to acknowledge, and making it sticky both demands a click for nothing and
  // makes the notice look like a failure. That is why the context/handoff warning is 'warn', not 'err'.
  if (kind === 'err') {
    t.classList.add('sticky');
    closeBtn();
  } else if (opts && opts.undo && typeof opts.undo.onClick === 'function') {
    t.classList.add('sticky', 'toast-act');
    const u = el('button', 'toast-undo', '↩ ' + (opts.undo.label || t18nUndo()));
    u.type = 'button';
    // one shot: the state is back, a second click would have nothing left to restore
    u.onclick = (e) => { e.stopPropagation(); u.disabled = true; dismiss(); opts.undo.onClick(); };
    t.appendChild(u);
    closeBtn();
    setTimeout(dismiss, TOAST_UNDO_MS);
  } else setTimeout(dismiss, TOAST_MS);
  $('#toasts').appendChild(t);
  logEvent(msg, kind);
}
// Its own function because inside toast() the local `const t = el('div', …)` SHADOWS the global t(),
// so a t('…') call in there would try to invoke a <div>.
function t18nUndo() { return typeof t === 'function' ? t('chat-composer.rueckgaengig') : 'rückgängig'; }
// Into the 🔔 log WITHOUT a toast. For things worth keeping but not worth interrupting for — e.g. a
// `system` frame the panel has no renderer for (a newer CLI emits subtypes this build never saw).
// Dropping those silently is how "the CLI told us and the panel said nothing" happens; a toast for
// each would be noise. So: recorded, countable, readable — and never in the way.
function logEvent(msg, kind) {
  EVENTS.unshift({ msg: String(msg), kind: kind || '', at: Date.now(), seen: false });
  if (EVENTS.length > 30) EVENTS.length = 30;
  if (typeof refreshEventBell === 'function') refreshEventBell();
}

// 🔔 event log: unseen counter on the bell, click shows the list (newest first)
// BELL-1 — the badge says two different things and used to say only one of them honestly. HOW MANY went
// past is the number; WHETHER one of them was a failure is the colour, and the colour was hard-wired to
// --danger. Three „Markdown kopiert" acknowledgements therefore produced the same red badge a failed
// scheduled run does, which makes the red worthless in both directions. Pure (no DOM) so the rule can be
// read by a test and so the count and the colour cannot drift into two functions.
function eventBellState(events) {
  const unseen = (events || []).filter((e) => e && !e.seen);
  const kind = unseen.some((e) => e.kind === 'err') ? 'err' : unseen.some((e) => e.kind === 'warn') ? 'warn' : '';
  return { unseen: unseen.length, kind };
}
function refreshEventBell() {
  const b = $('#eventBell'); if (!b) return;
  const st = eventBellState(EVENTS);
  // the counter is re-created, not just read: the bell is a data-ic button, and hydrateIcons rewrites
  // its innerHTML on every language switch — a looked-up dot would silently disappear there
  let dot = b.querySelector('.eb-dot');
  if (!dot) { dot = el('span', 'eb-dot hidden'); b.appendChild(dot); }
  dot.className = 'eb-dot' + (st.kind ? ' ' + st.kind : '') + (st.unseen === 0 ? ' hidden' : '');
  dot.textContent = st.unseen > 9 ? '9+' : String(st.unseen);
}
// The bell reports on the whole panel, but every view brings its own header — so it moves with the
// active view instead of living in one of them (leftmost, i.e. in the chat left of "Anzeige").
function mountEventBell() {
  const b = $('#eventBell'); if (!b) return;
  const host = document.querySelector('.view.active .topbar-actions');
  if (host && b.parentElement !== host) host.insertBefore(b, host.firstChild);
  refreshEventBell();
}
function openEventLog() {
  const box = el('div', 'ev-log');
  if (!EVENTS.length) box.appendChild(el('div', 'empty-mini', t('render.keineEreignisse')));
  EVENTS.forEach((e) => {
    const row = el('div', 'ev-row' + (e.kind === 'err' ? ' err' : e.kind === 'ok' ? ' ok' : ''));
    row.appendChild(el('span', 'ev-when', new Date(e.at).toLocaleTimeString()));
    row.appendChild(el('span', 'ev-msg', e.msg));
    box.appendChild(row);
  });
  EVENTS.forEach((e) => { e.seen = true; });
  refreshEventBell();
  if (typeof uiModal === 'function') uiModal({ icon: '🔔', title: t('render.letzteEreignisse'), body: box, escValue: null, actions: [{ label: t('common.schliessen'), value: null, primary: true }] });
}
// in-panel error state with a retry button — for view loads whose failure used to leave a blank
// panel with only a 4s toast as explanation (the toast dies, the blank stays)
function errorCard(container, message, retryFn) {
  const c = typeof container === 'string' ? $(container) : container; if (!c) return;
  c.innerHTML = '';
  const box = el('div', 'error-card');
  box.appendChild(el('div', 'ec-msg', '⚠ ' + (message || t('common.fehler'))));
  if (retryFn) { const b = el('button', 'ghost-btn', t('common.erneutVersuchen')); b.onclick = retryFn; box.appendChild(b); }
  c.appendChild(box);
}
// A FILTERED list that finds nothing used to end in a bare "nichts gefunden" (B12) — a dead end, because
// the filter that caused it may be a chip three cards up, or a search field you already forgot about.
// Same shape everywhere: what happened, and the one button that gets you out.
function emptyFiltered(container, onReset, message) {
  const c = typeof container === 'string' ? $(container) : container; if (!c) return;
  const box = el('div', 'empty-filtered');
  box.appendChild(el('div', 'ef-msg', message || t('common.keineTrefferFilter')));
  if (onReset) { const b = el('button', 'ghost-btn', '⨯ ' + t('common.filterZuruecksetzen')); b.onclick = onReset; box.appendChild(b); }
  c.appendChild(box);
  return box;
}
// trapFocus moved to public/js/overlays.js (PR-9a) — it belongs next to the overlay stack that installs
// it, and its „what is tabbable" rules got unit-tested there (test/overlay-stack.test.js).

function relTime(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return t('render.geradeEben');
  if (s < 3600) { const n = Math.floor(s / 60); return t('common.vorNMin').replace('{n}', n); }
  if (s < 86400) { const n = Math.floor(s / 3600); return t('common.vorNStd').replace('{n}', n); }
  if (s < 604800) { const n = Math.floor(s / 86400); return t('common.vorNTg').replace('{n}', n); }
  return new Date(ms).toLocaleDateString(LANG === 'en' ? 'en-US' : 'de-DE');
}

// ============================================================
//  Sidecar (artifact panel): pin a diff/file/code, or live-preview markup
// ============================================================
const SIDECAR = { mode: 'view', raw: '', lang: '', kind: 'code', node: null };
function openSidecar() { $('#sidecar').classList.remove('hidden'); }
// Closing drops the node reference too: the subagent detail view (#34) polls while it is on screen and
// keys that on `SIDECAR.node` still being its own — a stale reference would keep a dead panel alive.
function closeSidecar() { $('#sidecar').classList.add('hidden'); SIDECAR.node = null; }
function sidecarToggleTabs(showPreview) {
  $('#scTabView').classList.toggle('active', !showPreview);
  $('#scTabPreview').classList.toggle('active', showPreview);
}
// CHAT-SEC-1 — the HTML preview wraps the markup in a document whose FIRST head child is a CSP.
//
// What `sandbox=''` already does, and why it is not enough: an empty sandbox revokes scripts, forms,
// same-origin, plugins and top-level navigation. It does NOT stop SUBRESOURCE loads. So an HTML artifact
// from a model or a tool result — `<img src="https://…/1.gif?who=…">`, `<link rel=stylesheet>`, a CSS
// `url()`, a nested `<iframe src>`, `<meta http-equiv=refresh>` — still makes the browser call a foreign
// host the moment the user opens the preview tab. That is a read receipt plus whatever the path and query
// of the URL carry, and it needs no script at all.
//
// `default-src 'none'` closes that; the three exceptions are what a preview must still be able to do:
//   · `style-src 'unsafe-inline'`: an inline <style>/style= is the usual way such markup is styled, and
//     inline CSS with default-src 'none' cannot fetch anything (a `url()` is covered by img/font-src).
//   · `img-src data:`: a data: image carries no request; a remote one does, so remote stays blocked.
//   · `frame-ancestors 'self'` and no `base-uri`: belt to the sandbox's braces.
// NOT granted: connect-src, font-src, media-src, form-action — all remain 'none'.
//
// WHY A WRAPPER and not an insertion: a `<meta http-equiv=Content-Security-Policy>` is only honoured as a
// child of <head>, and `html` here is anything from a bare `<table>` fragment to a full document with its
// own <head>. Wrapping is the only form that puts the meta in a real head FIRST in every one of those
// cases — a stray inner `<html>`/`<head>`/`<meta charset>` tag is ignored by the parser, an inner
// `<style>` still applies, so nothing a preview needs is lost.
// NOT the `csp` iframe attribute: it only applies to `src` navigations, never to `srcdoc`.
function previewDoc(html) {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'";
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="' + csp + '">'
    + '</head><body>' + String(html == null ? '' : html) + '</body></html>';
}
function renderSidecar() {
  const body = $('#sidecarBody'); body.innerHTML = '';
  // A ready-built DOM node instead of a string to highlight (#34, the subagent detail view). The panel
  // is already the place for "look at this while you keep working" — resizable, non-blocking, right of
  // the rail — so it gains a third kind instead of a second panel being invented next to it.
  if (SIDECAR.kind === 'node' && SIDECAR.node) { body.appendChild(SIDECAR.node); return; }
  if (SIDECAR.mode === 'preview') {
    const html = SIDECAR.kind === 'diff' ? '' : SIDECAR.raw;
    if (!html || !/<[a-z!]/i.test(html)) { body.appendChild(el('div', 'sc-empty', t('render.keineDarstellbareMarkupVorschau'))); return; }
    const frame = el('iframe'); frame.setAttribute('sandbox', ''); // no scripts, no same-origin — safe render
    frame.srcdoc = previewDoc(html);
    body.appendChild(frame);
  } else {
    if (SIDECAR.kind === 'diff') { body.appendChild(renderDiff(SIDECAR.old || '', SIDECAR.raw, SIDECAR.lang)); }
    else { const pre = el('pre'); pre.innerHTML = highlightCode(SIDECAR.raw, SIDECAR.lang); body.appendChild(pre); }
  }
}
function sidecarShow(o) { // {title, raw, lang, kind:'code'|'diff'|'node', old, node}
  Object.assign(SIDECAR, { mode: 'view', kind: 'code', old: '', lang: '', node: null }, o);
  $('#sidecarTitle').textContent = o.title || '';
  const canPreview = SIDECAR.kind !== 'diff' && /<[a-z!]/i.test(SIDECAR.raw || '');
  $('#scTabPreview').classList.toggle('hidden', !canPreview);
  sidecarToggleTabs(false);
  renderSidecar();
  openSidecar();
}
function sidecarPreview(raw, title) {
  sidecarShow({ title: title || t('common.vorschau'), raw, lang: 'html', kind: 'code' });
  SIDECAR.mode = 'preview'; sidecarToggleTabs(true); renderSidecar();
}
$('#sidecarClose').onclick = closeSidecar;
$('#sidecarCopy').onclick = () => copyText(SIDECAR.raw || '');
$('#scTabView').onclick = () => { SIDECAR.mode = 'view'; sidecarToggleTabs(false); renderSidecar(); };
$('#scTabPreview').onclick = () => { SIDECAR.mode = 'preview'; sidecarToggleTabs(true); renderSidecar(); };
// drag to resize
(function () {
  const grip = $('#sidecarResize'), panel = $('#sidecar'); let startX, startW;
  const move = (e) => { const w = Math.min(Math.max(startW + (startX - e.clientX), 320), Math.round(window.innerWidth * 0.7)); panel.style.width = w + 'px'; };
  const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.style.userSelect = ''; };
  grip.addEventListener('mousedown', (e) => { startX = e.clientX; startW = panel.offsetWidth; document.body.style.userSelect = 'none'; document.addEventListener('mousemove', move); document.addEventListener('mouseup', up); });
})();

let STATE = null; // /api/state cache

// ---------------- Theme ----------------
const themeOrder = ['auto', 'dark', 'light'];
function applyTheme(th) {
  document.documentElement.setAttribute('data-theme', th); localStorage.setItem('ccui-theme', th);
  const b = document.getElementById('themeBtn');
  if (b) {
    const name = th === 'light' ? 'sun' : th === 'dark' ? 'moon' : 'auto';
    const label = th === 'light' ? t('render.themeHell') : th === 'dark' ? t('render.themeDunkel') : t('render.themeAuto');
    b.innerHTML = ic(name, 16) + '<span>' + label + '</span>';
  }
}
// applyLang hook: relabel the theme button in the new language (it overwrites its own data-i18n text)
function refreshThemeBtn() { applyTheme(document.documentElement.getAttribute('data-theme') || 'auto'); }
$('#themeBtn').onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme') || 'auto';
  applyTheme(themeOrder[(themeOrder.indexOf(cur) + 1) % 3]);
  toast(t('render.theme') + document.documentElement.getAttribute('data-theme'));
  if ($('#view-usage').classList.contains('active')) loadUsage();
};
applyTheme(localStorage.getItem('ccui-theme') || 'auto');

// ---------------- Navigation rail ----------------
// The sidebar as the 64px icon rail, by choice — the same rail ≤820px forces (styles.css), now also on a
// normal window where the labels cost width the chat could use. Labels stay reachable as the nav items'
// tooltips. Applied here at load, next to the theme, so a reload does not first paint the wide sidebar.
function applyNavRail(on, persist) {
  document.documentElement.classList.toggle('nav-rail', !!on);
  if (persist) { try { localStorage.setItem('ccui-nav-rail', on ? '1' : '0'); } catch { /* private mode */ } }
  const b = document.getElementById('navRailBtn');
  if (!b) return;
  const label = on ? t('render.navAusklappen') : t('render.navEinklappen');
  b.innerHTML = ic(on ? 'chevronRight' : 'chevronLeft', 16);
  b.title = label; b.setAttribute('aria-label', label);
  b.setAttribute('aria-expanded', on ? 'false' : 'true');
}
function refreshNavRailBtn() { applyNavRail(document.documentElement.classList.contains('nav-rail'), false); }
if ($('#navRailBtn')) $('#navRailBtn').onclick = () => applyNavRail(!document.documentElement.classList.contains('nav-rail'), true);
applyNavRail(localStorage.getItem('ccui-nav-rail') === '1', false);
if ($('#eventBell')) { $('#eventBell').onclick = openEventLog; refreshEventBell(); }

// "?" anywhere outside an input → the shortcut overview. Single source of truth: the Settings
// table is CLONED, so a shortcut documented there shows up here automatically (and vice versa).
function openShortcuts() {
  const src = document.querySelector('.kbd-table');
  const body = el('div', 'kbd-overlay-body');
  if (src) body.appendChild(src.cloneNode(true));
  else body.appendChild(el('div', 'empty-mini', t('render.keineKuerzel')));
  uiModal({ icon: '⌨', title: t('render.tastenkuerzel'), body, wide: true, escValue: null, actions: [{ label: t('common.schliessen'), value: null, primary: true }] });
}
document.addEventListener('keydown', (e) => {
  if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return; // typing wins
  // „a dialog is open" is the overlay stack's answer now, not a CSS selector's: the selector saw only
  // `.modal-overlay` and therefore opened a second dialog on top of the palette, the maximised result
  // card and the compare overlay (three of the thirteen) — and it is the stack that knows the order.
  if (typeof overlayCount === 'function' && overlayCount()) return;
  e.preventDefault();
  openShortcuts();
});

// ---------------- View switching ----------------
// Tabs, rail width, folds and drafts are all persisted — the ACTIVE VIEW was not, so every reload and
// every self-restart dropped you back into the chat (B5). Deliberately NOT a hash router: the jump
// bars in Settings/System already own the fragment with their #sec-* anchors.
const VIEW_KEY = 'cc_view';
function rememberView(v) { try { if (v) localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ } }
function restoreView() {
  let v = null;
  try { v = localStorage.getItem(VIEW_KEY); } catch { /* */ }
  // 'chat' is the boot default and restoreTabs() owns it — clicking the nav item here would fight it
  if (!v || v === 'chat') return;
  const nav = document.querySelector('.nav-item[data-view="' + v + '"]');
  if (nav) nav.click();
}
$$('.nav-item').forEach((btn) => {
  btn.onclick = () => {
    $$('.nav-item').forEach((b) => { b.classList.remove('active'); b.removeAttribute('aria-current'); });
    btn.classList.add('active'); btn.setAttribute('aria-current', 'page');
    const v = btn.dataset.view;
    rememberView(v);
    $$('.view').forEach((s) => s.classList.remove('active'));
    $('#view-' + v).classList.add('active');
    if (typeof mountEventBell === 'function') mountEventBell(); // 🔔 follows into the new view's header
    // B9: a hidden view's sections have no geometry, so the jump-bar marker has to be recomputed once
    // the view is actually on screen
    if (typeof repaintSectionNav === 'function') requestAnimationFrame(repaintSectionNav);
    if (typeof closeNav === 'function') closeNav(true); // F-Drawer: picking a view dismisses the off-canvas nav
    if (v === 'sessions') loadSessions();
    if (v === 'projects') loadProjects(); // P-1 (public/js/projects.js)
    if (v === 'settings') loadSettings();
    if (v === 'mcp') loadMcp();
    if (v === 'usage') loadUsage();
    if (v === 'memory') loadMemory();
    if (v === 'skills') loadSkills();
    if (v === 'uiskills') loadUiSkills();
    if (v === 'system') loadSystem(); // System hosts the Report-Bug section too (loadSystem calls loadBug)
  };
});

