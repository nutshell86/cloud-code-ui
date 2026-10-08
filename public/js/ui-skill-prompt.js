'use strict';
// Shared UI-skill PROMPT composition — browser (classic script) AND Node (require'd by lib/engine.js).
// Keep this file dependency-free and side-effect-free (pure.js spirit); no t()/DOM here.
//
// It used to exist TWICE: lib/pure.js for the headless scheduler, public/js/views-uiskills.js for the
// panel. The two copies differed in exactly one line — the boolean label — and that one line made the
// same skill send a DIFFERENT PROMPT depending on who started it: the panel rendered `true` through
// i18n ('Ja' in German, 'Yes' in English), the scheduler always wrote 'Ja'. So an English panel and the
// cron tick asked the model two different questions from one promptTemplate.
//
// The rule this module fixes that with:
//   · the PROMPT is deterministic German. The model reads it, and the promptTemplates around it are
//     German prose — a template that says „Nur wenn {{pdf}}" must not suddenly read „Nur wenn Yes".
//     So uiRenderInputValue without `labels` answers 'Ja'/'Nein', whatever the panel language is.
//   · a DISPLAY caller — a summary chip, a history line — may pass `labels: {yes, no}` from i18n and
//     gets the localised word. It has to ASK for that; it is never the default.
// Everything else (selects, trees, tags) was already language-independent: those labels come out of
// the manifest, which is authored once per skill.
function uiFlattenOptions(input) {
  const out = [];
  (input.options || []).forEach((o) => {
    out.push({ value: o.value, label: o.label || o.value });
    (o.children || []).forEach((c) => out.push({ value: c.value, label: c.label || c.value }));
  });
  return out;
}
// labels (optional): { yes, no } — ONLY a display caller passes this; see the header.
function uiRenderInputValue(input, val, labels) {
  const t = input.type;
  if (t === 'checkbox' || t === 'yesno') return val ? ((labels && labels.yes) || 'Ja') : ((labels && labels.no) || 'Nein');
  if (t === 'select' || t === 'radio') { const o = (input.options || []).find((x) => x.value === val); return o ? (o.label || o.value) : (val == null ? '' : String(val)); }
  if (t === 'tree' || t === 'multiselect') { const sel = Array.isArray(val) ? val : []; return uiFlattenOptions(input).filter((o) => sel.includes(o.value)).map((o) => o.label).join(', '); }
  if (t === 'tags') return (Array.isArray(val) ? val : []).join(', ');
  return val == null ? '' : String(val);
}
function uiExcludedValue(input, val) {
  if (input.type !== 'tree' && input.type !== 'multiselect') return '';
  const sel = Array.isArray(val) ? val : [];
  return uiFlattenOptions(input).filter((o) => !sel.includes(o.value)).map((o) => o.label).join(', ');
}
// {{id}}, {{id.excluded}} and {{#autoRun}}…{{/autoRun}} substitution.
// opts: { autoRun, labels } — `labels` rides along in opts so the prompt path keeps passing nothing.
function uiInterpolate(str, manifest, values, opts) {
  opts = opts || {};
  let out = String(str || '');
  out = out.replace(/\{\{#autoRun\}\}([\s\S]*?)\{\{\/autoRun\}\}/g, (mm, inner) => (opts.autoRun ? inner : ''));
  const byId = {}; (manifest.inputs || []).forEach((i) => { byId[i.id] = i; });
  out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (mm, key) => { const [id, mod] = String(key).split('.'); const input = byId[id]; if (!input) return ''; if (mod === 'excluded') return uiExcludedValue(input, values[id]); return uiRenderInputValue(input, values[id], opts.labels); });
  return out;
}
function uiComposePrompt(skill, values, opts) {
  const m = skill.manifest || {};
  const first = (m.inputs || [])[0];
  const tpl = m.promptTemplate || ('/' + skill.name + (first ? ' {{' + first.id + '}}' : ''));
  return uiInterpolate(tpl, m, values, opts).trim();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { uiFlattenOptions, uiRenderInputValue, uiExcludedValue, uiInterpolate, uiComposePrompt };
}
