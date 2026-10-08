'use strict';
// The i18n dictionary, guarded against the three failures it cannot report by itself.
//
// Read from the SOURCE, not by requiring the module — same reason test/routes.test.js reads server.js as
// text: once JS has parsed the object literal a duplicate key is INVISIBLE (the later definition silently
// wins), so the one defect this file found at introduction could not be seen any other way. Two of them
// existed: `chat-composer.rueckgaengig` was defined twice with DIFFERENT values, and the two inline chip
// links that wanted the lowercase spelling had been quietly rendering the capitalised one for months.
//
// What is guarded:
//  1. no key twice inside one locale with a different value — the silent-winner case above;
//  2. de and en carry the SAME key set — render.js falls back to I18N.de[key] when the active locale
//     lacks a key, so a missing English string shows German with no warning anywhere;
//  3. every key is actually referenced — a dictionary nobody prunes grows dead weight (23 keys at
//     introduction), and C2 in docs/ideas.md is about exactly that parse cost;
//  4. and the reverse: every t()/tt()/data-i18n reference resolves, so a typo is a test failure instead
//     of a raw key printed into the UI.
// Deliberately NO assertion on the NUMBER of keys: that would rot on every feature, the way the
// docs/ideas.md counters did. All four checks above are self-maintaining.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const I18N_FILE = path.join(PUB, 'js', 'i18n.js');
const SRC = fs.readFileSync(I18N_FILE, 'utf8');
const LINES = SRC.split(/\r?\n/);
// A dictionary entry: `  'key': 'value',` — the key may carry escaped quotes, the value is anything up
// to an optional trailing comma. Verified below to cover every entry with no stragglers, which is what
// makes "the parse missed a duplicate" impossible.
const KV = /^\s*'((?:[^'\\]|\\.)*)':\s*(.*?),?\s*$/;

function localeBounds() {
  let de = -1, en = -1;
  LINES.forEach((l, i) => { if (de < 0 && /^  de: \{/.test(l)) de = i; else if (en < 0 && /^  en: \{/.test(l)) en = i; });
  assert.ok(de >= 0 && en > de, 'both locale blocks must be findable — did i18n.js change shape?');
  return { de, en };
}
// -> { entries: [{key, value, line}], stragglers: [lineNo] }
function parseBlock(from, to) {
  const entries = [], stragglers = [];
  for (let i = from; i < to; i++) {
    const l = LINES[i];
    if (!l.trim() || /^\s*\/\//.test(l) || /^\s*[}{]/.test(l)) continue;
    const m = KV.exec(l);
    if (!m) { stragglers.push(i + 1); continue; }
    entries.push({ key: m[1], value: m[2], line: i + 1 });
  }
  return { entries, stragglers };
}
const B = localeBounds();
const DE = parseBlock(B.de + 1, B.en);
const EN = parseBlock(B.en + 1, LINES.length);

// ---- the reference scan ---------------------------------------------------------------------------
// Two different scans on purpose, because the two directions need opposite error tolerances.
//  · BROAD (any key-shaped single-quoted literal) for "is this key used?": keys reach t() through
//    conditionals (`t(cond ? 'a.x' : 'a.y')`) and through object-literal maps (views.js:69), so a scan
//    that only looks right after `t(` would declare ~24 LIVE keys dead and this guard would delete them.
//    Over-counting here is the safe direction: it can only miss a dead key, never kill a live one.
//  · NARROW (only `t('…')` / `tt('…')` / data-i18n*) for "does this reference exist?": a broad scan picks
//    up CSS selectors and file names ('settings.json', 'pre.md-pre') that are not keys at all.
const SOURCES = fs.readdirSync(path.join(PUB, 'js')).filter((f) => f.endsWith('.js') && f !== 'i18n.js')
  .map((f) => path.join('public/js', f)).concat(['public/index.html']);
// `//` comment lines are stripped first: chat.js:7 and render.js:20 both write `t('area.slug')` as a
// DOC EXAMPLE, and without the strip the reverse check would fail on a comment.
const BODIES = SOURCES.map((rel) => ({ rel, text: fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n') }));

// All three quote styles, because this is the scan whose over-counting is the SAFE direction (above) and
// whose under-counting is the dangerous one: a single `t("chat.foo")` or `tt(`chat.foo`)` written with the
// other quote would make this guard report a LIVE key as dead, and the invited fix is to DELETE it. There is
// no such reference today (measured) — but the cost of accepting all three is a key the guard might not prune,
// and the cost of accepting one is a key it tells you to throw away while the UI still asks for it.
const KEYISH = /['"`]([A-Za-z][\w-]*\.[\w.-]+)['"`]/g;          // broad
const CALL = /\btt?\(\s*'((?:[^'\\]|\\.)*)'/g;                   // narrow
const ATTR = /data-i18n(?:-\w+)?="([^"]+)"/g;
// `tt('chat-side.sammelnModus' + mode)` — the key is composed at runtime. The prefixes are HARVESTED
// from the code instead of hardcoded here, so a new dynamic key family does not need a test change.
const PREFIX = /\btt?\(\s*'([A-Za-z][\w.-]*)'\s*\+/g;
const collect = (re, pick) => { const s = new Set(); for (const b of BODIES) { re.lastIndex = 0; let m; while ((m = re.exec(b.text))) s.add(pick ? pick(m, b) : m[1]); } return s; };
const BROAD = new Set([...collect(KEYISH), ...collect(ATTR)]);
const NARROW = new Set([...collect(CALL), ...collect(ATTR)]);
const PREFIXES = [...collect(PREFIX)];

describe('public/js/i18n.js — the dictionary guards', () => {
  it('the parse covers every entry (no stragglers) — otherwise the checks below prove nothing', () => {
    assert.deepEqual(DE.stragglers, [], 'de lines the entry regex did not understand');
    assert.deepEqual(EN.stragglers, [], 'en lines the entry regex did not understand');
    assert.ok(DE.entries.length > 1000 && EN.entries.length > 1000, 'both blocks must actually have been read');
  });

  it('no key is defined twice with a DIFFERENT value inside one locale', () => {
    for (const [name, block] of [['de', DE], ['en', EN]]) {
      const byKey = new Map();
      for (const e of block.entries) { if (!byKey.has(e.key)) byKey.set(e.key, []); byKey.get(e.key).push(e); }
      const bad = [];
      for (const [key, list] of byKey) {
        if (list.length < 2) continue;
        const values = new Set(list.map((e) => e.value));
        // Naming BOTH line numbers is the point: the later definition wins, so "which one do I see on
        // screen" is the first question a reader has.
        bad.push(name + '.' + key + ' at lines ' + list.map((e) => e.line).join(' and ')
          + (values.size > 1 ? ' with DIFFERENT values ' + [...values].join(' vs ') + ' — the LAST one wins'
            : ' (same value — harmless, but still a duplicate)'));
      }
      assert.deepEqual(bad, [], 'duplicate keys in ' + name + ':\n  ' + bad.join('\n  '));
    }
  });

  it('de and en carry the same key set — a gap falls back to German with no warning', () => {
    const d = new Set(DE.entries.map((e) => e.key)), n = new Set(EN.entries.map((e) => e.key));
    const onlyDe = [...d].filter((k) => !n.has(k));
    const onlyEn = [...n].filter((k) => !d.has(k));
    assert.deepEqual(onlyDe, [], 'missing in en (would silently render German): ' + onlyDe.join(', '));
    assert.deepEqual(onlyEn, [], 'missing in de (render.js falls back to de — these would render nothing): ' + onlyEn.join(', '));
  });

  it('the dynamic-prefix harvest still finds the composed key families', () => {
    // If a refactor makes this regex match nothing, the unused-key check below would start reporting
    // live keys as dead — and the obvious "fix" is to delete them. So the harvest guards itself.
    assert.ok(PREFIXES.includes('chat-side.sammelnModus'), 'harvested prefixes: ' + JSON.stringify(PREFIXES));
    assert.ok(PREFIXES.includes('chat-side.sammelnModusKurz'), 'harvested prefixes: ' + JSON.stringify(PREFIXES));
  });

  it('every key is referenced from public/js or public/index.html', () => {
    const dead = DE.entries.filter((e) => !BROAD.has(e.key) && !PREFIXES.some((p) => e.key.startsWith(p)))
      .map((e) => e.key + ' (line ' + e.line + ')');
    assert.deepEqual(dead, [], dead.length + ' key(s) nobody asks for — delete them or wire them up:\n  ' + dead.join('\n  '));
  });

  // One wording guard, not a sweep. This single sentence was the only place in the UI that claimed Ultracode
  // and the reasoning effort were the same knob („es braucht die Aufwandsstufe xhigh" / „it needs the xhigh
  // effort level"). They are not: since CLI 2.1.284 Ultracode „no longer forces xhigh effort and stays on at
  // any effort level", so „max + Ultracode" is legitimate — what needs xhigh is the MODEL. The wrong claim
  // has a real origin (the terminal shortcut `/effort ultracode` DOES map to level xhigh and set the flag),
  // which is exactly why a reader would „correct" it back, and why it is pinned here rather than just fixed.
  it('no Ultracode string claims the SESSION needs the xhigh effort level', () => {
    const bad = [];
    for (const [name, block] of [['de', DE], ['en', EN]]) {
      for (const e of block.entries) {
        if (!/ultracode/i.test(e.key) && !/ultracode/i.test(e.value)) continue;
        // „braucht ein Modell mit xhigh" is right; „braucht die Aufwandsstufe xhigh" is the error
        if (/(Aufwandsstufe xhigh|xhigh effort level|effort level xhigh)/i.test(e.value)) bad.push(name + '.' + e.key + ' (line ' + e.line + '): ' + e.value);
      }
    }
    assert.deepEqual(bad, [], 'Ultracode is a switch of its own — the MODEL must do xhigh, the session need not run at it:\n  ' + bad.join('\n  '));
    // …and the reason still has to NAME the requirement, or this guard could be satisfied by saying nothing
    for (const [name, block] of [['de', DE], ['en', EN]]) {
      const e = block.entries.find((x) => x.key === 'chat.ultracodeGrundModell');
      assert.ok(e && /xhigh/.test(e.value), name + '.chat.ultracodeGrundModell must still say which requirement is missing');
    }
  });

  it("every t()/tt()/data-i18n reference resolves to a key that exists", () => {
    const have = new Set(DE.entries.map((e) => e.key));
    const missing = [...NARROW].filter((r) => !have.has(r)
      // a harvested prefix is not a key itself — `tt('chat-side.sammelnModus' + mode)` contributes the
      // literal prefix to the narrow scan, and only prefix+suffix is ever looked up
      && !PREFIXES.includes(r));
    assert.deepEqual(missing, [], 'referenced but undefined (renders the raw key in the UI): ' + missing.join(', '));
  });
});
