'use strict';
// H7/B8 — WCAG AA for the panel's accent surfaces.
//
// Everything here is MEASURED against public/styles.css itself, never against a copy of the colours in
// this file. A test that carries its own palette proves that the test agrees with the test; the defect
// it has to catch is somebody lowering a value in the stylesheet, so the stylesheet is the input.
//
// The defect this pins: six rules wrote a literal `#fff` on an accent background. Measured =>
// 3,12:1 against --accent and 2,03:1 against --accent-2, against the 4,5:1 AA asks for 13px/600 text.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  contrastRatio, contrastRound, relLuminance, srgbToLinear, contrastParseHex, contrastLighten,
  contrastWorst, contrastOver, accentSurface, WCAG_AA_TEXT, WCAG_AA_LARGE, WCAG_NON_TEXT,
  contrastToHsl, contrastFromHsl, accentText, accentFgSurfaces,
  ACCENT_FG_SURFACES, ACCENT_FG_TINT_ON, ACCENT_GLOW_ALPHA, ACCENT_FG_MAX_SHIFT, ACCENT_FG_STEPS,
} = require('../public/js/contrast');

const CSS_PATH = path.join(__dirname, '..', 'public', 'styles.css');
const CSS = fs.readFileSync(CSS_PATH, 'utf8');

// --- a deliberately dumb CSS reader -------------------------------------------------------------
// Innermost `… { … }` pairs only. The stylesheet has no CSS nesting, so an @media prelude is simply
// swallowed into the preceding selector text and every real declaration block is still matched on its
// own. Anything cleverer would be a second thing that can be wrong.
function cssBlocks(src) {
  const out = [];
  const re = /([^{}]*)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src))) out.push({ sel: m[1].trim().split('\n').pop().trim(), body: m[2] });
  return out;
}
const BLOCKS = cssBlocks(CSS);
// The custom properties of one selector, last definition wins (that is also what the browser does).
function varsOf(selPredicate) {
  const vars = {};
  BLOCKS.filter((b) => selPredicate(b.sel)).forEach((b) => {
    const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
    let m;
    while ((m = re.exec(b.body))) vars[m[1]] = m[2].trim();
  });
  return vars;
}
const ROOT_VARS = varsOf((s) => s === ':root');
const ACCENT_VARS = ['--accent', '--accent-2', '--on-accent'];

// The accent triple is theme-independent (the test below pins that). NOTHING else is: `--panel` is
// #232228 in dark and #ffffff in light, so one number for anything painted on a panel would be a
// half-truth — which is exactly how the revoke × read as „5,24:1, fine" while light mode showed 1,43:1.
// Blocks are visited in file order and the last definition wins, same as the cascade.
// `auto` is the third block and it is the one that gets forgotten: it is the DEFAULT (index.html ships
// data-theme="auto"), it only applies under a prefers-color-scheme media query, and a token missing there
// inherits the dark value into a white panel. So it is measured like the other two, not assumed to equal
// `light`.
const THEME_BLOCK = {
  dark: (s) => /^:root,\s*:root\[data-theme="dark"\]$/.test(s),
  auto: (s) => s === ':root[data-theme="auto"]',
  light: (s) => s === ':root[data-theme="light"]',
};
const THEMES = {
  dark: varsOf((s) => s === ':root' || THEME_BLOCK.dark(s)),
  auto: varsOf((s) => s === ':root' || THEME_BLOCK.auto(s)),
  light: varsOf((s) => s === ':root' || THEME_BLOCK.light(s)),
};
// one level of var(--x); the stylesheet never nests custom properties deeper than that
function resolveVar(theme, value) {
  const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(String(value == null ? '' : value).trim());
  if (!m) return String(value == null ? '' : value).trim();
  assert.ok(theme[m[1]], 'var(' + m[1] + ') is not defined for this theme');
  return theme[m[1]].trim();
}
// the declarations of ONE selector, exactly as the stylesheet writes them (undefined = not declared,
// which is the assertion that matters for `opacity`)
function declsOf(sel) {
  const out = {};
  const hits = BLOCKS.filter((b) => b.sel === sel);
  assert.ok(hits.length, 'selector "' + sel + '" is not in public/styles.css any more');
  hits.forEach((b) => {
    const re = /(?:^|[;{\s])([a-z][a-z-]*)\s*:\s*([^;]+);/g;
    let m;
    while ((m = re.exec(b.body))) out[m[1]] = m[2].trim();
  });
  return out;
}

test('styles.css defines the accent triple as plain hex in the shared :root', () => {
  for (const v of ACCENT_VARS) {
    assert.ok(ROOT_VARS[v], v + ' is missing from the bare `:root` block of public/styles.css');
    assert.ok(contrastParseHex(ROOT_VARS[v]),
      v + ' = "' + ROOT_VARS[v] + '" is not a plain hex colour; the contrast check cannot measure it');
  }
});

// WHY this is a test and not a comment: the whole "5,36:1 in light AND dark" claim rests on the triple
// being theme-independent. The day somebody adds `--accent: #...` to the light block, one number stops
// covering two themes and every other assertion here becomes a half-truth.
test('no theme block redefines the accent triple — one measurement covers light and dark', () => {
  const themed = BLOCKS.filter((b) => /data-theme|prefers-color-scheme/.test(b.sel) || /^:root(,|\s|$)/.test(b.sel));
  for (const b of themed) {
    if (b.sel === ':root') continue;
    for (const v of ACCENT_VARS) {
      assert.ok(!new RegExp(v.replace('-', '\\-') + '\\s*:').test(b.body),
        'theme selector "' + b.sel + '" redefines ' + v + ' — then light and dark need separate numbers');
    }
  }
});

test('--on-accent clears AA against BOTH gradient stops (the measured defect)', () => {
  const ink = ROOT_VARS['--on-accent'], a1 = ROOT_VARS['--accent'], a2 = ROOT_VARS['--accent-2'];
  const r1 = contrastRatio(ink, a1), r2 = contrastRatio(ink, a2);
  assert.ok(r1 >= WCAG_AA_TEXT, 'text on --accent (' + a1 + ') is ' + contrastRound(r1) + ':1, needs ' + WCAG_AA_TEXT);
  assert.ok(r2 >= WCAG_AA_TEXT, 'text on --accent-2 (' + a2 + ') is ' + contrastRound(r2) + ':1, needs ' + WCAG_AA_TEXT);
  // the numbers that went into the CHANGELOG — a drift that still passes 4,5 should still be visible
  assert.equal(contrastRound(r1), 5.36);
  assert.equal(contrastRound(r2), 8.23);
  // and the old value must stay a failure, so nobody "restores" it believing it was fine
  assert.ok(contrastRatio('#ffffff', a1) < WCAG_AA_TEXT);
  assert.ok(contrastRatio('#ffffff', a2) < WCAG_AA_LARGE);
});

// The guard with teeth: it is not enough that --on-accent is good, every accent surface has to USE it.
// Reintroducing `color: #fff` next to `background: var(--accent)` is precisely how this regressed the
// first time, and it reads perfectly innocent in a diff.
test('every rule that paints text on an accent background uses var(--on-accent)', () => {
  const accentBg = /background(?:-color)?\s*:\s*(?:linear-gradient\([^;]*var\(--accent|var\(--accent(?:-2)?\)\s*;)/;
  const checked = [];
  for (const b of BLOCKS) {
    if (!accentBg.test(b.body)) continue;
    const m = b.body.match(/(?:^|[;{\s])color\s*:\s*([^;]+);/);
    if (!m) continue; // dots, bars and fills carry no text — nothing to be legible
    checked.push(b.sel);
    assert.equal(m[1].trim(), 'var(--on-accent)',
      'rule "' + b.sel + '" paints text on an accent background with "' + m[1].trim()
      + '" instead of var(--on-accent) — that colour is not derived from the user\'s accent');
  }
  // without this, a renamed class would make the whole test vacuously green
  assert.ok(checked.length >= 6, 'only ' + checked.length + ' accent surfaces found (' + checked.join(', ')
    + ') — the selectors moved and this guard stopped guarding anything');
});

test('the stylesheet default and the derivation in applyAccent() cannot drift apart', () => {
  const derived = accentSurface(ROOT_VARS['--accent']);
  assert.equal(derived.onAccent, ROOT_VARS['--on-accent'],
    'accentSurface("' + ROOT_VARS['--accent'] + '") picks ' + derived.onAccent
    + ' but styles.css ships --on-accent: ' + ROOT_VARS['--on-accent']
    + ' — a user who sets the accent to exactly the default colour would see a different label colour');
  assert.ok(derived.ok);
});

// --- the custom accent (⚙ Anzeige → Akzentfarbe) ------------------------------------------------
// The sample is derived, not typed: the comment in views.js quotes this count, and the test below reads
// the quote back. A step changed here without touching the comment is therefore a red test, not a stale
// sentence — which is exactly how „636k-colour sweep" survived in that comment for a whole review round.
const SWEEP_STEP = 9;
const SWEEP_N = Math.pow(Math.ceil(256 / SWEEP_STEP), 3); // 29³ = 24389
const SWEEP_FLATTENED = 636;                              // hit count of the flattened gradients, NOT the sample size
test('accentSurface() clears AA for every accent a user can pick', () => {
  let worst = { ratio: Infinity, hex: null }, flattened = 0, n = 0;
  for (let r = 0; r < 256; r += SWEEP_STEP) {
    for (let g = 0; g < 256; g += SWEEP_STEP) {
      for (let b = 0; b < 256; b += SWEEP_STEP) {
        const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
        const s = accentSurface(hex);
        n++;
        assert.ok(s.ok, 'accentSurface(' + hex + ') gave up at ' + contrastRound(s.ratio) + ':1');
        // the promise is about the SURFACE, so re-measure the ink against both stops it returned
        const got = contrastWorst(s.onAccent, [s.accent, s.accent2]);
        assert.ok(got >= WCAG_AA_TEXT, hex + ' → ink ' + s.onAccent + ' only reaches ' + contrastRound(got));
        if (s.lift === 0) flattened++;
        if (got < worst.ratio) worst = { ratio: got, hex };
      }
    }
  }
  assert.equal(n, SWEEP_N, 'the sweep walked ' + n + ' colours, not the ' + SWEEP_N + ' the comments quote');
  // Documented, not just asserted: the gradient is dropped for the mid-luminance band, where no single
  // ink can clear 4,5:1 against a lifted stop AND the base. The EXACT count is pinned because it is a
  // number that got printed — a band check ("2–4 % is fine") would have let 636 be quoted as 636.000.
  assert.equal(flattened, SWEEP_FLATTENED,
    'flattened gradients: ' + flattened + ' of ' + n + ' — the published figure is ' + SWEEP_FLATTENED);
  assert.ok(worst.ratio >= WCAG_AA_TEXT, 'worst accent ' + worst.hex + ' → ' + contrastRound(worst.ratio));
});

// The comment above applyAccent() is the only place a reader is told HOW WIDE the AA promise is, so it
// is the place where a wrong number does the most damage — and it had one: „636k-colour sweep", the hit
// count of the flattened gradients glued onto the sample size, 26× too large. A prose claim nobody can
// fail is the defect class of this project, so the prose is read back here.
const VIEWS_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views.js'), 'utf8');
const I18N_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'i18n.js'), 'utf8');
const ACCENT_COMMENT = VIEWS_SRC.slice(
  VIEWS_SRC.indexOf('// --- panel accent color ---'), VIEWS_SRC.indexOf('function applyAccent'));
const deNum = (s) => Number(String(s).replace(/\./g, '').replace(',', '.'));

test('the numbers in the applyAccent() comment are the numbers that were measured', () => {
  assert.ok(ACCENT_COMMENT.length > 200, 'the accent comment block moved — this guard found nothing to read');
  // the one that was invented, named so a copy-paste of the old sentence fails loudly
  assert.ok(!/636k/.test(VIEWS_SRC), 'views.js claims a „636k-colour sweep" again — the sweep is ' + SWEEP_N + ' colours');

  const sample = ACCENT_COMMENT.match(/29³ = ([\d.]+) colours, (\d+) of them/);
  assert.ok(sample, 'the comment no longer states the sample size and the flattened count of the repo sweep');
  assert.equal(deNum(sample[1]), SWEEP_N, 'the comment quotes a sample size the test does not walk');
  assert.equal(deNum(sample[2]), SWEEP_FLATTENED, 'the comment quotes a flattened count the test does not produce');

  // the exhaustive run is too slow to repeat per suite (16,7 M × accentSurface), so what is checked here
  // is the arithmetic that makes it verifiable: the cube size, and the worst case pointwise.
  const cube = ACCENT_COMMENT.match(/all ([\d.]+) accents/);
  assert.ok(cube, 'the comment no longer says how large the exhaustive run was');
  assert.equal(deNum(cube[1]), 256 * 256 * 256);

  const worstClaim = ACCENT_COMMENT.match(/worst case exactly ([\d,]+):1 \(at (#[0-9a-f]{6})\)/);
  assert.ok(worstClaim, 'the comment no longer names the global worst case');
  const s = accentSurface(worstClaim[2]);
  assert.ok(s.ok, 'the accent named as the worst case does not even pass: ' + worstClaim[2]);
  assert.equal(contrastRound(contrastWorst(s.onAccent, [s.accent, s.accent2])), deNum(worstClaim[1]),
    worstClaim[2] + ' does not measure ' + worstClaim[1] + ':1');
});

test('accentSurface() keeps the warm ink where it is legible and flips only when it must', () => {
  assert.equal(accentSurface('#d97757').onAccent, '#2a1a10'); // the stock coral
  assert.equal(accentSurface('#ffee00').onAccent, '#2a1a10'); // pale yellow: white was 1,1:1 here
  assert.equal(accentSurface('#1a2b5c').onAccent, '#ffffff'); // navy: the warm ink is unreadable
  assert.equal(accentSurface('#000000').onAccent, '#ffffff');
  // the mid-grey trap from the module header: #595959 with the stock 22 % lift has NO passing ink
  assert.ok(contrastWorst('#ffffff', ['#595959', contrastLighten('#595959', 0.22)]) < WCAG_AA_TEXT);
  assert.ok(contrastWorst('#000000', ['#595959', contrastLighten('#595959', 0.22)]) < WCAG_AA_TEXT);
  const s = accentSurface('#595959');
  assert.ok(s.ok && s.lift < 0.22, 'expected a reduced lift, got ' + s.lift);
});

// contrastRound()'s own comment says „used by the CHANGELOG numbers", and the sweep above says „the
// numbers that went into the CHANGELOG". For a whole review round there WAS no such entry — the origin of
// 5,36 / 8,23 was reconstructable only from this file. A reference to a document nobody wrote is the same
// defect class as a ratio nobody measured, so the document is read back here, and the figures in it are
// compared against what the stylesheet measures right now.
// NOTE (public snapshot): three tests stood here. They read CHANGELOG.md and docs/ideas.md back and compared
// the contrast ratios printed there against what the stylesheet measures right now — a guard against
// documented numbers drifting away from the code. Both documents are working papers of the internal
// repository this snapshot was extracted from and are not part of it (see docs/README.md), so the guard had
// nothing left to read and was removed rather than left to fail. What it protected is still covered: the
// ratios, the token split and the exemptions are pinned by the tests below, against the stylesheet itself.
// German decimal comma, because that is how the entry prints a ratio
const printed = (r) => String(contrastRound(r)).replace('.', ',');



// Same contract one level down: K1's own entry has to print what K1 measured, and K1's own leftover has to be
// carried somewhere. Both halves are read back, because „erledigt" without a named reach is how B8 got planned
// twice in the first place.

// --- K1: the accent as a TEXT colour -------------------------------------------------------------
// The half H7 left open, and the bigger half: 112 declarations wrote the accent as a FOREGROUND on
// ordinary panel surfaces. Measured against the worst surface each theme has, the shipped coral was
// 2,07:1 in light mode and 3,03:1 in dark — and every test above stayed green, because they only look at
// accent BACKGROUNDS. Same shape as the grant-× hole, one layer out.
//
// Everything below is measured against public/styles.css and against contrast.js' derivation, never
// against a third copy of the numbers.
const FG_TOKENS = { '--accent-fg': WCAG_AA_TEXT, '--accent-fg-lg': WCAG_AA_LARGE };
const FG_BASE = {
  '--accent-fg': { dark: '--accent-fg-dark', light: '--accent-fg-light' },
  '--accent-fg-lg': { dark: '--accent-fg-lg-dark', light: '--accent-fg-lg-light' },
};
// `auto` is the light palette, so it derives from the light bases — asserted below, not assumed.
const FG_BASE_FOR = { dark: 'dark', auto: 'light', light: 'light' };

test('the four derived text tones are plain hex in the shared :root', () => {
  for (const tok of Object.keys(FG_BASE)) {
    for (const mode of ['dark', 'light']) {
      const base = FG_BASE[tok][mode];
      assert.ok(ROOT_VARS[base], base + ' is missing from the bare `:root` block — applyAccent() overwrites it, '
        + 'so without a literal there the STOCK accent would have no text tone at all');
      assert.ok(contrastParseHex(ROOT_VARS[base]), base + ' = "' + ROOT_VARS[base] + '" is not a plain hex colour');
    }
  }
});

// The failure this pins is the cheapest one to ship: a token added to two theme blocks out of three. The
// third block then inherits the OTHER theme's value — a tone lightened for dark panels, printed on white.
test('both text tones are mapped in ALL THREE theme blocks, each to its own base', () => {
  for (const mode of Object.keys(THEME_BLOCK)) {
    const own = varsOf(THEME_BLOCK[mode]);
    for (const tok of Object.keys(FG_BASE)) {
      const want = 'var(' + FG_BASE[tok][FG_BASE_FOR[mode]] + ')';
      assert.equal(own[tok], want, 'the ' + mode + ' block maps ' + tok + ' to ' + own[tok] + ' instead of ' + want
        + ' — a theme block that does not map it inherits the other theme\'s tone');
    }
  }
});

// contrast.js carries a COPY of six surface hexes per theme, and that copy is the one place this change
// could rot quietly: a browser can only read the active theme's variables, so applyAccent() cannot look the
// inactive theme's surfaces up. This is the guard that makes the copy safe — and it reads all three blocks,
// so the auto block drifting away from the light block is caught too.
test('contrast.js\' surface copy is the stylesheet, in every theme block', () => {
  for (const mode of Object.keys(THEME_BLOCK)) {
    const own = varsOf(THEME_BLOCK[mode]), want = ACCENT_FG_SURFACES[FG_BASE_FOR[mode]];
    for (const name of Object.keys(want)) {
      assert.equal(own[name], want[name], 'the ' + mode + ' block has ' + name + ': ' + own[name]
        + ' while contrast.js derives against ' + want[name] + ' — the derivation is measuring a surface that is gone');
    }
  }
  // and the glow alpha the tint surfaces are built from is the one the stylesheet actually paints
  const glow = ROOT_VARS['--accent-glow'];
  assert.match(glow, new RegExp(',\\s*' + String(ACCENT_GLOW_ALPHA).replace('.', '\\.') + '\\s*\\)$'),
    '--accent-glow is ' + glow + ' but contrast.js composites at alpha ' + ACCENT_GLOW_ALPHA);
  for (const name of ACCENT_FG_TINT_ON) assert.ok(ACCENT_FG_SURFACES.dark[name], 'tint surface ' + name + ' is not a surface');
});

test('the text tones in the stylesheet are exactly what accentText() derives — and clear their rule', () => {
  // the numbers that went into the CHANGELOG; the ones above them are what the panel shipped before
  const expect = {
    dark: { '--accent-fg': ['#e5a48e', 4.52], '--accent-fg-lg': ['#d97757', 3.03] },
    light: { '--accent-fg': ['#983f22', 4.55], '--accent-fg-lg': ['#c6522d', 3] },
  };
  const accent = ROOT_VARS['--accent'];
  for (const mode of ['dark', 'light']) {
    const bgs = accentFgSurfaces(accent, mode);
    for (const tok of Object.keys(FG_TOKENS)) {
      const css = ROOT_VARS[FG_BASE[tok][mode]];
      const derived = accentText(accent, mode, FG_TOKENS[tok]);
      assert.equal(derived.color, css, 'styles.css ships ' + FG_BASE[tok][mode] + ': ' + css + ' but accentText('
        + accent + ', ' + mode + ', ' + FG_TOKENS[tok] + ') derives ' + derived.color
        + ' — a user who picks exactly the default colour would see a different text tone than the default does');
      const got = contrastWorst(css, bgs);
      assert.ok(got >= FG_TOKENS[tok], tok + ' in ' + mode + ' mode is ' + contrastRound(got) + ':1 on its worst surface, needs ' + FG_TOKENS[tok]);
      assert.equal(contrastRound(got), expect[mode][tok][1], tok + ' in ' + mode + ' now measures ' + contrastRound(got)
        + ':1, not the published ' + expect[mode][tok][1]);
      assert.equal(css, expect[mode][tok][0]);
      assert.ok(derived.met && derived.faithful, tok + ' in ' + mode + ' is not a faithful tone of the default accent');
    }
    // the defect itself must stay a failure, or somebody „restores" the old colour believing it was fine
    assert.ok(contrastWorst(accent, bgs) < WCAG_AA_TEXT, 'var(--accent) as text now passes in ' + mode + ' — then this guard is about nothing');
  }
  // the numbers the CHANGELOG prints for the old state
  assert.equal(contrastRound(contrastWorst(accent, accentFgSurfaces(accent, 'dark'))), 3.03);
  assert.equal(contrastRound(contrastWorst(accent, accentFgSurfaces(accent, 'light'))), 2.07);
  assert.equal(contrastRound(contrastWorst(ROOT_VARS['--accent-2'], accentFgSurfaces(accent, 'dark'))), 4.65);
  assert.equal(contrastRound(contrastWorst(ROOT_VARS['--accent-2'], accentFgSurfaces(accent, 'light'))), 1.35);
  // and the plain-surface figures docs/ideas.md quotes for K1, so the ticket and the fix cite the same thing
  assert.equal(contrastRound(contrastRatio(accent, THEMES.light['--panel'])), 3.12);
  assert.equal(contrastRound(contrastRatio(accent, THEMES.light['--panel-2'])), 2.96);
  assert.equal(contrastRound(contrastRatio(accent, THEMES.light['--bg'])), 2.86);
  assert.equal(contrastRound(contrastRatio('#ffff00', THEMES.light['--panel'])), 1.07);
  assert.equal(contrastRound(contrastRatio('#000080', THEMES.dark['--panel'])), 1.01);
});

// --- which of the 112 got which token, and nothing left over ------------------------------------
// WHY 112 AND NOT THE 116 THIS CHANGE MEASURED. 116 was right against the base this branch was cut from.
// Merging main (50 commits: PR-5/6/7/10/14) removed exactly four, each accounted for rather than written
// off: three sat in blocks main had deleted — `.ag-kind.bg` and `.ag-own` belonged to the „Läufe" view
// that PR #66 removed, and `.queue-badge:hover` is dead in main's CSS *and* its JS (both counted) — and
// the fourth is `.chat-queue .cq-undo:hover`, where CHAT-FLOW-11 replaced the colour hover with a
// background hover, so there is no text colour left to fix. Counted selector by selector between the
// merge-base stylesheet and origin/main: base 114 + 2, main 110 + 2, lost 4, **gained 0**.
// A correction worth keeping, because it is the failure class this very section is about: the first draft of
// this note claimed the merge „brought four" (`.mcp-foot .mcp-apply`, `.chat-status .cs-ultra`,
// `.seg button.active`, `.uh-badge.running`). It did not. Those four were in the base all along; the
// conflict had reverted them to `var(--accent)` because main touched the rules around them, and the sweep
// was re-applied to them by hand. Four reverted is not four new.
// Net: 100 → 96 in the 4,5:1 class, the 15 glyphs and the one decoration unchanged.
// U1 (PR-12) added the 113th: `.tool-card.is-brief > summary .tc-name` — the tool NAME on a compact card
// (⚙ Workflow, 🧰 ToolSearch, …). It is a LABEL, read as text, so it takes `--accent-fg` (4,5:1) and not
// the 3:1 glyph token; it is in the 4,5:1 class by the same rule as the `.tool-card.is-agent` name next to
// it, which this inventory already held. So: 96 → 97 in the 4,5:1 class, nothing else moved.
// Every `color: var(--accent…)` declaration in the stylesheet, in file order. Deliberately counts
// DECLARATIONS and not lines: several of these rules are one-liners with more than one colour in them.
function accentColorDecls() {
  const out = [];
  for (const b of BLOCKS) {
    const re = /(^|[;{])\s*color\s*:\s*var\(\s*(--accent[\w-]*)\s*\)/g;
    let m;
    while ((m = re.exec(b.body))) out.push({ sel: b.sel, token: m[2] });
  }
  return out;
}
// 15 declarations, 14 selectors — `.ui-step.running .step-mark` is styled twice. Each one carries positive
// evidence in the source that it paints a glyph or an icon and not a label; the evidence per selector is
// listed in the applyAccent() comment in public/js/views.js. This list is the review gate: a NEW rule
// cannot quietly settle for 3:1, it has to be added here by somebody who names the evidence.
const FG_LG_RULES = [
  '.bubble.streaming::after',                 // content: "▏"
  '.cc-dd-check',                             // chat-composer.js: el('span','cc-dd-check','✓')
  '.chat-status .cs-pin:hover',               // chat-status.js: ic('pin', 13)
  '.cs-open .cso-staged',                     // chat-side.js: el('span','cso-staged','⧉')
  '.nav-item.active .ni',                     // .nav-item .ni svg { width: 18px }
  '.perm-icon',                               // .perm-icon svg { width: 20px }
  '.qr-btn.qr-cli::before',                   // content: '✨ '
  '.si-prev.named::before',                   // content: "✎ "
  '.step-item.running .step-mark',            // chat-render.js: '◐'
  '.todo-item.in_progress .todo-mark',        // chat-render.js: todoMark(status)
  '.tool-card.has-out > summary .tc-caret',   // chat-render.js: el('span','tc-caret','▸')
  '.ui-result-table th.sorted-asc::after',    // content: ' ▴'
  '.ui-result-table th.sorted-desc::after',   // content: ' ▾'
  '.ui-step.running .step-mark',              // views-uiskills.js: '◐'
  '.ui-step.running .step-mark',
];
// The one rule that keeps the raw accent, and the only one: a 42 px icon at opacity .55 whose message is in
// the <p> next to it. Pure decoration is exempt from 1.4.3 AND 1.4.11 — and at that opacity no token could
// deliver a ratio anyway, which is measured below rather than asserted in prose.
const FG_DECORATION = ['.empty-glyph'];

// 07.10.: 113 → 115 — the queue's ↪ (.chat-queue .cq-inj:hover) and the bubble's „↪ eingespeist" (.msg .msg-inj), both text-size --accent-fg
test('all 115 accent-as-text declarations carry a token, and the split is the documented one', () => {
  const decls = accentColorDecls();
  assert.equal(decls.length, 115, 'the stylesheet now has ' + decls.length + ' accent-as-text declarations, not the 115 '
    + 'this change counted — a new one has appeared or the reader stopped seeing them (see the note above on '
    + 'why this is 112 and not the 116 of the first measurement)');
  const by = {};
  decls.forEach((d) => { (by[d.token] = by[d.token] || []).push(d.sel); });
  assert.equal(by['--accent-2'], undefined, '--accent-2 is a gradient stop, not a text colour: ' + (by['--accent-2'] || []).join(', '));
  assert.deepEqual((by['--accent'] || []).sort(), FG_DECORATION,
    'these rules paint raw var(--accent) as text: ' + (by['--accent'] || []).join(', ')
    + ' — only documented decoration may, everything else needs --accent-fg or --accent-fg-lg');
  assert.deepEqual((by['--accent-fg-lg'] || []).slice().sort(), FG_LG_RULES.slice().sort(),
    'the 3:1 list drifted: ' + (by['--accent-fg-lg'] || []).join(' | '));
  assert.equal(by['--accent-fg-lg'].length, 15);
  assert.equal(by['--accent-fg'].length, 99, 'the 4,5:1 class holds ' + by['--accent-fg'].length + ' declarations, not 99');
  assert.equal(by['--accent-fg'].length + by['--accent-fg-lg'].length + FG_DECORATION.length, 115);
});

// WHY this is its own test: these two rules fade THEMSELVES. A token cannot undo an `opacity`, so claiming
// them as „fixed" would be the exact failure this suite exists for. They get the STRICTER token because 4,5
// survives the fade better than 3 does — and what is left over is a number here, in the CHANGELOG and in
// docs/ideas.md, not a silence.
const FADED = { '.usi-quick': '--panel', '.chat-status .cs-pin.is-pinned': '--panel' };
test('the two accent glyphs that fade themselves are measured, not claimed', () => {
  const expect = { dark: 3.29, light: 2.61 };
  for (const sel of Object.keys(FADED)) {
    const d = declsOf(sel);
    assert.equal(d.color, 'var(--accent-fg)', sel + ' uses ' + d.color + ' — a faded rule needs the 4,5:1 token, '
      + 'because opacity .55 costs it roughly half the ratio (--accent-fg-lg would land at 2,46:1 / 2,19:1)');
    assert.equal(d.opacity, '.55', sel + ' no longer declares opacity .55 — then re-measure and move the pinned numbers');
    for (const mode of ['dark', 'light']) {
      const under = THEMES[mode][FADED[sel]];
      const ink = resolveVar(THEMES[mode], THEMES[mode]['--accent-fg']); // the tone THIS theme really uses
      const r = contrastRatio(contrastOver(ink, under, parseFloat(d.opacity)), under);
      assert.equal(contrastRound(r), expect[mode], sel + ' at rest is ' + contrastRound(r) + ':1 in ' + mode + ' mode, not the published ' + expect[mode]);
    }
  }
  // dark clears the 3:1 a control needs, light does NOT — that is the open half, and it has to stay visible
  assert.ok(expect.dark >= WCAG_NON_TEXT);
  assert.ok(expect.light < WCAG_NON_TEXT);
});

test('the decoration exemption is measured too, and justified where a reader will look', () => {
  const d = declsOf(FG_DECORATION[0]);
  assert.equal(d.color, 'var(--accent)');
  assert.equal(d.opacity, '.55');
  assert.ok(parseFloat(d['font-size']) >= 24, FG_DECORATION[0] + ' is ' + d['font-size'] + ' — below 24 px it is not large text either');
  const expect = { dark: 2.46, light: 1.81 };
  for (const mode of ['dark', 'light']) {
    const under = THEMES[mode]['--panel'];
    assert.equal(contrastRound(contrastRatio(contrastOver(THEMES[mode]['--accent'], under, 0.55), under)), expect[mode]);
  }
  // the justification is not allowed to live only in a commit message
  assert.match(VIEWS_SRC, /`\.empty-glyph` keeps plain `var\(--accent\)`/,
    'views.js no longer says why the one raw-accent rule is allowed to stay');
});

// --- the derivation itself ----------------------------------------------------------------------
test('accentText() keeps hue and saturation and moves only lightness', () => {
  for (const hex of ['#d97757', '#ffff00', '#000080', '#5ec27a', '#ff00ff', '#1a2b5c']) {
    const [h0, s0, l0] = contrastToHsl(hex);
    for (const mode of ['dark', 'light']) {
      const a = accentText(hex, mode);
      const [h1, s1, l1] = contrastToHsl(a.color);
      // the returned colour must BE the ramp: same hue, same saturation, lightness moved by exactly `shift`
      // in direction `dir`. 8-bit rounding is the only thing allowed to touch it.
      assert.equal(contrastFromHsl(h0, s0, l0 + a.dir * a.shift), a.color,
        hex + ' → ' + a.color + ' (' + mode + ') is not the same hue/saturation at a different lightness');
      assert.ok(Math.abs(Math.abs(l1 - l0) - a.shift) < 0.01, 'the reported shift is not the lightness that moved');
      if (a.shift > 0) assert.ok(s0 === 0 || Math.abs(h1 - h0) < 1, 'the hue moved: ' + h0 + ' → ' + h1);
    }
  }
  // HSL round-trips exactly for the colours the panel ships
  for (const hex of ['#d97757', '#e8a87c', '#2a1a10', '#ffffff', '#000000', '#232228']) {
    const [h, s, l] = contrastToHsl(hex);
    assert.equal(contrastFromHsl(h, s, l), hex);
  }
  assert.equal(contrastToHsl('nope'), null);
  assert.equal(accentText('nope', 'dark'), null);
  assert.equal(accentText('#d97757', 'sepia'), null, 'an unknown theme must be null, not a guess at its surfaces');
});

// The constant that decides when „derived" turns into „a different colour" is a judgement — so it is bounded
// by the two measured cases named in contrast.js, and they are read back here. Moving ACCENT_FG_MAX_SHIFT
// out of that gap breaks this test, which is the point: the stock coral must never start warning, and the
// navy that becomes periwinkle must never stop.
test('ACCENT_FG_MAX_SHIFT sits between the two cases that justify it', () => {
  const coral = accentText(ROOT_VARS['--accent'], 'light');
  assert.equal(Math.round(coral.shift * 1000), 230, 'the shipped coral needs ' + coral.shift + ' in light mode now');
  assert.ok(coral.met && coral.faithful, 'the shipped default would warn about itself');
  const navy = accentText('#000080', 'dark');
  assert.equal(navy.color, '#8686ff');
  assert.equal(Math.round(navy.shift * 1000), 512);
  assert.ok(navy.met, 'the navy case still has to be LEGIBLE — legibility is what is never given up');
  assert.ok(!navy.faithful, 'navy → #8686ff is reported as faithful; then nothing is ever reported');
  assert.ok(coral.shift < ACCENT_FG_MAX_SHIFT && ACCENT_FG_MAX_SHIFT < navy.shift,
    ACCENT_FG_MAX_SHIFT + ' is not between ' + coral.shift + ' (must pass) and ' + navy.shift + ' (must warn)');
});

// The binary search in accentText() assumes the ratio grows monotonically as the tone moves away from the
// surfaces. Assumption + nobody checking is this project's defect class, so it is checked against a
// brute-force walk of the same grid. 216 colours × 2 themes × 2 thresholds.
test('the binary search finds the same tone a full linear walk does', () => {
  const brute = (hex, mode, min) => {
    const [h, s, l0] = contrastToHsl(hex), bgs = accentFgSurfaces(hex, mode);
    for (let k = 0; k <= ACCENT_FG_STEPS; k++) {
      for (const dir of (k === 0 ? [-1] : [-1, 1])) {
        const c = contrastFromHsl(h, s, Math.max(0, Math.min(1, l0 + dir * k / ACCENT_FG_STEPS)));
        if (contrastWorst(c, bgs) >= min) return c;
      }
    }
    return null;
  };
  let n = 0;
  for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) {
    const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    for (const mode of ['dark', 'light']) {
      for (const min of [WCAG_AA_TEXT, WCAG_AA_LARGE]) {
        n++;
        assert.equal(accentText(hex, mode, min).color, brute(hex, mode, min), hex + ' / ' + mode + ' / ' + min);
      }
    }
  }
  assert.equal(n, 6 * 6 * 6 * 4);
});

// The size of the promise, over every accent the colour field can produce. Same sample as the
// accentSurface() sweep above (every 9th channel value, 29³ = 24.389), so the two halves of the accent
// story are measured on the same grid. Runtime ~4 s for 4 derivations per colour.
test('accentText() reaches its threshold for every accent a user can pick, in both themes', () => {
  const unfaithful = { dark: { text: 0, large: 0 }, light: { text: 0, large: 0 } };
  let n = 0, worst = { dark: { shift: -1, hex: null }, light: { shift: -1, hex: null } };
  for (let r = 0; r < 256; r += SWEEP_STEP) {
    for (let g = 0; g < 256; g += SWEEP_STEP) {
      for (let b = 0; b < 256; b += SWEEP_STEP) {
        const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
        n++;
        for (const mode of ['dark', 'light']) {
          const a = accentText(hex, mode), l = accentText(hex, mode, WCAG_AA_LARGE);
          assert.ok(a.met, 'accentText(' + hex + ', ' + mode + ') stopped at ' + contrastRound(a.ratio) + ':1');
          assert.ok(l.met, 'accentText(' + hex + ', ' + mode + ', 3) stopped at ' + contrastRound(l.ratio) + ':1');
          // re-measure the returned tone against the surfaces it claims to clear
          assert.ok(contrastWorst(a.color, accentFgSurfaces(hex, mode)) >= WCAG_AA_TEXT, hex + ' → ' + a.color);
          if (!a.faithful) unfaithful[mode].text++;
          if (!l.faithful) unfaithful[mode].large++;
          if (a.shift > worst[mode].shift) worst[mode] = { shift: a.shift, hex };
        }
      }
    }
  }
  assert.equal(n, SWEEP_N);
  // „Reached" is not „faithful", and the gap is a number rather than a shrug: these are the accents whose
  // text tone the panel flags in ⚙ Anzeige instead of pretending. EXACT, because the CHANGELOG prints them.
  assert.deepEqual(unfaithful, { dark: { text: 3015, large: 810 }, light: { text: 4750, large: 2148 } },
    'the flagged counts are now ' + JSON.stringify(unfaithful) + ' — the published figures are dark 3015/810, light 4750/2148');
  // the extremes: a near-black accent in dark mode and a near-white one in light mode travel furthest
  assert.equal(worst.dark.hex, '#000009');
  assert.equal(worst.light.hex, '#fcfcea');
});

// --- the note under the colour field ------------------------------------------------------------
// The ONE thing that makes „not reachable without distorting the colour" visible instead of silent. A
// derivation nobody can see the result of is the state this change started from.
test('the panel prints the measurement where the accent is chosen', () => {
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(HTML, /<p class="hint" id="accentNote">/, 'index.html has no #accentNote under the accent field');
  assert.ok(HTML.indexOf('id="qsAccent"') < HTML.indexOf('id="accentNote"'), 'the note is not next to the field it explains');
  for (const key of ['views.accentFgTone', 'views.accentFgOk', 'views.accentFgDrift', 'views.accentFgShiftUnit']) {
    assert.ok(VIEWS_SRC.includes("'" + key + "'"), 'views.js never prints ' + key);
  }
  // the warning branch has to be reachable AND has to flag the field, not just add a sentence
  assert.match(VIEWS_SRC, /classList\.toggle\('warn', drift\.length > 0\)/, 'the note never turns into a warning');
  assert.match(VIEWS_SRC, /faithful/, 'paintAccentNote() does not look at the faithful flag at all');
  // …and the warning itself has to pass the rule it is warning about. `.hint.bad` (var(--danger)) would not:
  // on `.card`'s --panel that is 3,12:1 in light mode, for a 12 px line. Measured in all three theme blocks.
  const warn = declsOf('.hint.warn');
  assert.equal(warn.color, 'var(--text)', '.hint.warn is ' + warn.color + ' — a chromatic token fails light mode here');
  assert.ok(parseFloat(warn['font-weight']) >= 600, 'the warning carries no non-colour signal (WCAG 1.4.1)');
  // BOTH dictionary entries, not „somewhere in the file": the first version of this assertion was
  // /⚠/.test(I18N_SRC), and a mutation that stripped the glyph from the GERMAN string alone stayed green
  // because the English one still carried it. A guard that one language can satisfy for the other is no guard.
  const drift = [...I18N_SRC.matchAll(/'views\.accentFgDrift':\s*'([^']*)'/g)].map((m) => m[1]);
  assert.equal(drift.length, 2, 'views.accentFgDrift is defined ' + drift.length + '× — de and en are not both there');
  drift.forEach((s, i) => assert.ok(/⚠/.test(s), 'the drift string #' + (i + 1) + ' lost its ⚠ — then the warning '
    + 'rests on colour and weight alone (WCAG 1.4.1): ' + JSON.stringify(s)));
  const surface = resolveVar(THEMES.dark, declsOf('.card').background);
  assert.equal(surface, THEMES.dark['--panel'], '.card no longer sits on --panel — re-measure the note');
  const expect = { dark: 13.41, auto: 16.07, light: 16.07 };
  for (const mode of Object.keys(THEME_BLOCK)) {
    const r = contrastRatio(THEMES[mode]['--text'], THEMES[mode]['--panel']);
    assert.ok(r >= WCAG_AA_TEXT, 'the accent note is ' + contrastRound(r) + ':1 in ' + mode + ' mode');
    assert.equal(contrastRound(r), expect[mode]);
    // the token that was NOT chosen, so the reason stays measurable and does not become folklore
    if (mode !== 'dark') {
      assert.ok(contrastRatio(THEMES[mode]['--danger'], THEMES[mode]['--panel']) < WCAG_AA_TEXT,
        '--danger now passes as 12px text in ' + mode + ' mode — then .hint.bad would have been fine after all');
    }
  }
  // a language switch must repaint it, or the note is stale in the other language
  const RENDER_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'render.js'), 'utf8');
  assert.match(RENDER_SRC, /'repaintAccentNote'/, 'applyLang() does not repaint the accent note');
  // all four derived properties are written, and all four are removed again for the stock accent
  for (const v of ['--accent-fg-dark', '--accent-fg-light', '--accent-fg-lg-dark', '--accent-fg-lg-light']) {
    assert.ok(VIEWS_SRC.includes("'" + v + "'"), 'applyAccent() never sets ' + v);
  }
  assert.match(VIEWS_SRC, /\['--accent-fg-dark', '--accent-fg-light', '--accent-fg-lg-dark', '--accent-fg-lg-light'\]\.forEach\(\(v\) => root\.style\.removeProperty\(v\)\)/,
    'applyAccent() does not clear all four derived tones when the accent goes back to the default — '
    + 'a leftover inline value would outrank every theme block');
});

// The README carried the K1 defect as a documented CAVEAT („covers accent SURFACES, not the accent as
// text", with 3,12:1 and 1,07:1 printed). Fixing the code and leaving that paragraph standing would have been
// the same defect with the sign flipped: a document asserting something nobody re-checked. So the paragraph is
// read back here, and its numbers are re-measured — it is the only page a user reads before picking a colour.
test('the README no longer carries K1 as an open caveat — and its numbers are measured', () => {
  const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.ok(!/covers accent SURFACES, not the accent as text/.test(README),
    'the README still tells the user the accent as text is uncovered, although K1 covered it');
  const para = /- \*\*The accent-contrast guarantee[^\n]*(\n  [^\n]*)*/.exec(README);
  assert.ok(para, 'the accent-contrast caveat is gone from the README entirely — then nobody is told where the promise stops');
  for (const tok of ['`--accent-fg`', '`--accent-fg-lg`']) assert.ok(para[0].includes(tok), 'the README does not name ' + tok);
  // the two gaps have to stay named, with the identifiers docs/ideas.md uses
  assert.match(para[0], /\*\*K8\*\*/, 'the README no longer names the opacity gap');
  assert.match(para[0], /\*\*K2\*\*/, 'the README no longer names the semantic-token gap');
  // and the one ratio it prints has to be the one that is true right now
  const faded = contrastRatio(contrastOver(ROOT_VARS['--accent-fg-light'], THEMES.light['--panel'], 0.55), THEMES.light['--panel']);
  assert.ok(para[0].includes('**' + printed(faded) + ':1**'),
    'the README prints a light-mode figure for the faded glyphs that is not the measured ' + printed(faded) + ':1');
});

// --- a CONTROL, not a label: WCAG 1.4.11 ---------------------------------------------------------
// WHY this section exists: H4 made the × of a grant chip the ONLY way to take a permission back, and
// shipped it as `opacity: .55; color: inherit`. Composited over the real stack that is 2,67:1 in dark and
// 1,43:1 in light — an invisible control, in the change whose subject is contrast. Every test above stayed
// green, because they only look at accent BACKGROUNDS and at 4,5:1 for text. So the stack is rebuilt here:
// rail background → the chip's translucent tint → the glyph with whatever opacity it carries.
const GRANT_X = '.cs-grant .cs-grant-x';
const GRANT_X_ON = '.cs-grant .cs-grant-x:hover, .cs-grant .cs-grant-x:focus-visible';

// `.cs-grant` sits in the approvals rail, so the bottom layer is the rail's own background — read from
// the stylesheet, not assumed, because `--panel` is the whole reason the two themes differ here.
function grantSurfaces(theme) {
  const rail = resolveVar(theme, declsOf('.chat-side').background);
  const session = contrastOver(resolveVar(theme, declsOf('.cs-grant').background), rail);
  // .cs-grant-perm overrides the chip background on the same element (standing rules are not „granted green")
  const perm = contrastOver(resolveVar(theme, declsOf('.cs-grant-perm').background), session);
  assert.ok(session && perm, 'a chip background could not be composited — a translucent token with nothing under it?');
  return { session, perm };
}
// the ratio of a glyph against what is actually behind it, honouring its own background and `opacity`
function glyphRatio(theme, decls, surface) {
  const bg = decls.background;
  const under = (!bg || bg === 'none' || bg === 'transparent') ? surface : contrastOver(resolveVar(theme, bg), surface);
  const fg = contrastOver(resolveVar(theme, decls.color), under, decls.opacity == null ? 1 : parseFloat(decls.opacity));
  assert.ok(under && fg, 'the glyph stack did not composite: color=' + decls.color + ' background=' + bg);
  return contrastRatio(fg, under);
}

test('the revoke × is perceivable AT REST — 3:1 for a control (WCAG 1.4.11)', () => {
  const rest = declsOf(GRANT_X);
  // the two decisions the measurement rests on, stated as assertions so the next edit cannot undo them quietly
  assert.equal(rest.opacity, undefined,
    'the × is faded again (opacity: ' + rest.opacity + ') — .55 is exactly what put its rest state at 1,43:1 in light mode');
  assert.notEqual(rest.color, 'inherit',
    'the × inherits the chip colour again — inherited --success measures 1,96:1 on its own tint in light, '
    + 'and this × is the ONLY control that revokes a grant');
  // Pinned, not just bounded: these four are the numbers the styles.css comment and the CHANGELOG print.
  const expect = { dark: { session: 4.7, perm: 5.81 }, light: { session: 4.98, perm: 5.34 } };
  // The 3:1 rule is checked for ALL four before any pinned value is, on purpose: a colour that holds in
  // dark and dies in light must report „1,96:1 in light", not „5,24 is not 4,70 in dark" — the second
  // message sends the reader to the wrong theme, which is how this defect stayed invisible once already.
  const got = {};
  for (const mode of Object.keys(expect)) {
    const theme = THEMES[mode], surf = grantSurfaces(theme);
    got[mode] = {};
    for (const which of ['session', 'perm']) got[mode][which] = { r: glyphRatio(theme, rest, surf[which]), on: surf[which] };
  }
  for (const mode of Object.keys(expect)) {
    for (const which of ['session', 'perm']) {
      const { r, on } = got[mode][which];
      assert.ok(r >= WCAG_NON_TEXT, 'the × at rest on the ' + which + ' chip is ' + contrastRound(r) + ':1 in '
        + mode + ' mode (glyph on ' + on + ') — 1.4.11 asks ' + WCAG_NON_TEXT + ':1 for a control');
    }
  }
  for (const mode of Object.keys(expect)) {
    for (const which of ['session', 'perm']) {
      assert.equal(contrastRound(got[mode][which].r), expect[mode][which],
        'the ' + which + ' chip × in ' + mode + ' mode now measures ' + contrastRound(got[mode][which].r)
        + ':1, not the published ' + expect[mode][which] + ':1');
    }
  }
});

test('hover and focus on the × hold in BOTH themes, not only in dark', () => {
  const on = declsOf(GRANT_X_ON);
  // the trap this pins: --danger as the hover TEXT colour is 3,16:1 in dark but 2,40:1 in light, so the
  // obvious „make it red" would have shipped a brand-new failing pair into the contrast change itself.
  // `.toast-undo:hover` in the same stylesheet already answers it with --text; this is that same answer.
  assert.equal(on.color, 'var(--text)',
    'the hover colour is ' + on.color + ' — a chromatic token here fails light mode (--danger is 2,40:1 there)');
  const expect = { dark: { session: 8.41, perm: 10.08 }, light: { session: 12.38, perm: 13.28 } };
  for (const mode of Object.keys(expect)) {
    const theme = THEMES[mode], surf = grantSurfaces(theme);
    for (const which of ['session', 'perm']) {
      const r = glyphRatio(theme, on, surf[which]);
      assert.ok(r >= WCAG_NON_TEXT, 'hover/focus on the ' + which + ' chip × is only ' + contrastRound(r) + ':1 in ' + mode);
      assert.equal(contrastRound(r), expect[mode][which]);
    }
  }
});

test('the revoke × is large enough to hit — 24 px (WCAG 2.5.8)', () => {
  const rest = declsOf(GRANT_X);
  for (const prop of ['min-width', 'min-height']) {
    assert.ok(rest[prop], GRANT_X + ' declares no ' + prop + ' — the hit area is whatever one glyph happens to be');
    assert.ok(parseFloat(rest[prop]) >= 24, GRANT_X + ' ' + prop + ' is ' + rest[prop]
      + ' — WCAG 2.5.8 asks 24 px, and before this change the × was 18,4 × 15 px, 5,6 % of the chip that used to be the button');
  }
  // Honest about what this is: a SOURCE assertion. There is no layout layer in this suite, so it catches
  // the regression that happened (the chip stopped being the button and nothing replaced its hit area),
  // not every way a box can still end up small.
});

// --- the arithmetic itself, against values that can be checked by hand --------------------------
test('relative luminance follows the WCAG definition at its fixed points', () => {
  assert.equal(relLuminance('#ffffff'), 1);
  assert.equal(relLuminance('#000000'), 0);
  assert.equal(contrastRound(contrastRatio('#ffffff', '#000000')), 21);
  assert.equal(contrastRatio('#d97757', '#d97757'), 1);
  // the linear ramp below the 0.03928 knee is linear, above it is the 2.4 power curve
  assert.ok(Math.abs(srgbToLinear(5) - (5 / 255 / 12.92)) < 1e-12);
  assert.ok(Math.abs(srgbToLinear(255) - 1) < 1e-12);
  // case and short form are the same colour; junk is not a colour
  assert.equal(relLuminance('#FFF'), relLuminance('#ffffff'));
  assert.equal(relLuminance('rgb(1,2,3)'), null);
  assert.equal(contrastRatio('#fff', 'nope'), null, 'an unmeasurable pair must be null, never a pass');
  // the gradient lift is a plain channel interpolation towards white
  assert.equal(contrastLighten('#000000', 0.5), '#808080');
  assert.equal(contrastLighten('#d97757', 0.22), '#e1957c');
  // compositing — the half the grant-chip measurement rests on: a translucent token is not a colour
  // until something is behind it, and CSS `opacity` multiplies the colour's own alpha on top of that
  assert.equal(contrastOver('rgba(0,0,0,0.5)', '#ffffff'), '#808080');
  assert.equal(contrastOver('#ffffff', '#000000', 0.5), '#808080');
  assert.equal(contrastOver('rgba(255,255,255,1)', '#000000'), '#ffffff');
  assert.equal(contrastOver('#123456', '#ffffff'), '#123456', 'an opaque top layer hides the backdrop entirely');
  assert.equal(contrastOver('rgba(255,255,255,.5)', 'rgba(0,0,0,.5)'), null,
    'a see-through backdrop is not a backdrop — guessing one is how an rgba() gets measured as if it were opaque');
  assert.equal(contrastOver('nope', '#fff'), null);
});

// --- PF-1: a proposed plan — the state is a sign, not a fade ----------------------------------------------
// WHY: the first version said „not approved yet" with `.cside-plan.is-proposed .cside-chips { opacity: .72 }`,
// i.e. over the WHOLE group. On the rail's --panel that is 4,00:1 dark / 3,11:1 light for --text-dim (the state
// line, every step title, the [Plan öffnen] button) and 3,38:1 / 3,03:1 for --text-faint (group headings, the ×
// that puts the plan away) — 11–12 px text below 4,5:1, and two of them are controls. The same class of defect
// the grant × had (above): every token passed on its own, the opacity on top of them was never measured. So the
// text a proposed plan shows is composited over the real stack WITH whatever opacity that rule carries, and the
// sign that replaced the fade is measured as what it is — a graphical object (1.4.11).
const PLAN_PROPOSED = '.cside-plan.is-proposed .cside-chips';
// selector → what it is in a proposed plan (planRailGroup: head, steps or the empty line, note, foot)
const PLAN_PROPOSED_TEXT = [
  ['.cside-plan .csp-title', 'the title'],
  ['.cside-plan .csp-state', 'the state line „wartet auf Freigabe"'],
  ['.todo-item.pending .todo-text', 'a step title'],
  ['.todo-item.pending .todo-mark', 'a step\'s □'],
  ['.csp-gh', 'a group heading'],
  ['.cside-plan .csp-empty', 'the line „keine Schritte erkannt"'],
  ['.csp-note, .csp-unrep', 'a note'],
  ['.cside-plan .csp-btn, .plan-hist .csp-btn', 'the [Plan öffnen] button'],
  ['.cside-plan .csp-x', 'the × that puts the plan away'],
];

test('PF-1: a proposed plan keeps every text in its group at AA — dashed, not faded', () => {
  const rule = declsOf(PLAN_PROPOSED);
  assert.equal(rule.opacity, undefined,
    'the proposed plan is faded again (opacity: ' + rule.opacity + ') — .72 put --text-dim at 3,11:1 in light mode');
  const fade = rule.opacity == null ? 1 : parseFloat(rule.opacity);
  // every pair against AA first, the pinned figures after — so a failure names the theme and the element
  const worst = {};
  for (const mode of Object.keys(THEME_BLOCK)) {
    const theme = THEMES[mode], bg = resolveVar(theme, declsOf('.chat-side').background);
    worst[mode] = Infinity;
    for (const [sel, what] of PLAN_PROPOSED_TEXT) {
      const d = declsOf(sel);
      assert.ok(d.color, sel + ' declares no colour — then this list no longer describes the group');
      const r = contrastRatio(contrastOver(resolveVar(theme, d.color), bg, fade), bg);
      assert.ok(r >= WCAG_AA_TEXT, what + ' (' + sel + ') in a proposed plan is ' + contrastRound(r) + ':1 in '
        + mode + ' mode — AA asks ' + WCAG_AA_TEXT + ':1');
      worst[mode] = Math.min(worst[mode], r);
    }
  }
  const expect = { dark: 5.17, auto: 5.38, light: 5.38 }; // --text-faint at full strength
  for (const mode of Object.keys(expect)) assert.equal(contrastRound(worst[mode]), expect[mode], 'the weakest text in a proposed plan drifted in ' + mode);
  // the sign that replaced the fade: dashed (the panel's „only a wish so far"), in a colour that can be seen
  assert.match(String(rule['border-left'] || ''), /\bdashed\b/, 'the proposed plan lost its dashed rule — then only the state line says it is not approved');
  const sign = /var\(\s*--[\w-]+\s*\)/.exec(rule['border-left']);
  assert.ok(sign, 'the dashed rule carries no theme token: ' + rule['border-left']);
  for (const mode of Object.keys(THEME_BLOCK)) {
    const theme = THEMES[mode], bg = resolveVar(theme, declsOf('.chat-side').background);
    const r = contrastRatio(resolveVar(theme, sign[0]), bg);
    assert.ok(r >= WCAG_NON_TEXT, 'the dashed rule is ' + contrastRound(r) + ':1 in ' + mode + ' — 1.4.11 asks ' + WCAG_NON_TEXT + ':1');
    // and the old fade stays a measured failure, so nobody „restores" it believing it was fine
    assert.ok(contrastRatio(contrastOver(theme['--text-dim'], bg, 0.72), bg) < WCAG_AA_TEXT,
      'opacity .72 over --text-dim now passes in ' + mode + ' — then the reason for this rule is gone, re-measure');
  }
});

// --- PF-1b: the checklist, the orphan card, the composer chip, the folded attachment ---------------------------
// WHY: every new text sits on a surface of its own (the rail, a dimmed button, the plan card's accent tint, the chip,
// the attachment's --panel-2) and every new sign is either a graphical object (the running step's accent edge, the
// chip's frame) or a word — none of them a fade. Measured over the real stack from public/styles.css, in all three
// theme blocks, so a token lowered there turns this red instead of a screenshot.
const PF1B_TEXT = [
  // [text rule, backdrop rule (its `background`), what it is]
  ['.cside-plan .csp-btn.is-primary[aria-disabled="true"]', '.cside-plan .csp-btn.is-primary[aria-disabled="true"]', '„⏳ startet nach diesem Turn"'],
  ['.att-chip.plan-chip', '.att-chip', 'the chip „📋 Plan-Fortschritt mitsenden" (on)'],
  ['.att-chip.plan-chip.is-off', '.att-chip', 'the chip, switched off'],
  ['.att-chip.plan-chip .pc-state', '.att-chip', 'its word „an"/„aus"'],
  ['.plan-att summary', '.plan-att', 'the folded „📋 Plan-Fortschritt" of a user row'],
  ['.plan-att .plan-att-body', '.plan-att', 'its step list'],
  ['.plan-att .plan-att-proto', '.plan-att', 'its protocol line'],
];
test('PF-1b: every new text is at AA on its own surface — and the new signs are objects at 3:1, not fades', () => {
  for (const mode of Object.keys(THEME_BLOCK)) {
    const theme = THEMES[mode];
    for (const [sel, bgSel, what] of PF1B_TEXT) {
      const d = declsOf(sel), bg = resolveVar(theme, declsOf(bgSel).background);
      assert.equal(d.opacity, undefined, what + ' is faded (' + sel + ')');
      assert.ok(d.color, sel + ' declares no colour');
      const r = contrastRatio(resolveVar(theme, d.color), bg);
      assert.ok(r >= WCAG_AA_TEXT, what + ' is ' + contrastRound(r) + ':1 in ' + mode + ' (' + sel + ')');
    }
    // the orphan card's reason line sits on the plan card's tint: color-mix(in srgb, var(--accent) N%, var(--panel))
    const mix = /color-mix\(in srgb,\s*(var\(--[\w-]+\))\s+(\d+)%,\s*(var\(--[\w-]+\))\)/.exec(declsOf('.plan-group').background);
    assert.ok(mix, 'the plan card is no longer a colour-mix tint — re-measure its texts: ' + declsOf('.plan-group').background);
    const card = contrastOver(resolveVar(theme, mix[1]), resolveVar(theme, mix[3]), Number(mix[2]) / 100);
    const why = contrastRatio(resolveVar(theme, declsOf('.plan-group .plan-why').color), card);
    assert.ok(why >= WCAG_AA_TEXT, 'the orphan card\'s reason line is ' + contrastRound(why) + ':1 in ' + mode);
    // the running step's accent edge and the chip's frame against what they stand on (1.4.11) — the edge on the rail
    // AND on the row's own :hover / :focus-visible background, where the raw accent was 2,97:1 in the light theme
    const rail = resolveVar(theme, declsOf('.chat-side').background), panel = resolveVar(theme, declsOf('.att-chip').background);
    const hover = resolveVar(theme, declsOf('.cside-plan .csp-step:hover').background);
    assert.equal(resolveVar(theme, declsOf('.cside-plan .csp-step:focus-visible').background), hover, 'focus and hover share the backdrop measured here');
    for (const [sel, prop, on, what] of [
      ['.cside-plan .csp-step.is-current', 'box-shadow', rail, 'the running step\'s edge'],
      ['.cside-plan .csp-step.is-current', 'box-shadow', hover, 'the running step\'s edge under :hover/:focus-visible'],
      ['.cside-plan .csp-step.is-current.paused', 'box-shadow', rail, 'a paused step\'s edge'],
      ['.cside-plan .csp-step.is-current.paused', 'box-shadow', hover, 'a paused step\'s edge under :hover/:focus-visible'],
      ['.att-chip.plan-chip', 'border-color', panel, 'the chip\'s frame (on)'],
      ['.att-chip.plan-chip.is-off', 'border-color', panel, 'the chip\'s dashed frame (off)'],
    ]) {
      const tok = /var\(\s*--[\w-]+\s*\)/.exec(String(declsOf(sel)[prop] || ''));
      assert.ok(tok, sel + ' ' + prop + ' carries no theme token');
      // twice: --accent-fg-lg is itself var(--accent-fg-lg-dark|light) (the accent picker rewrites those two)
      const r = contrastRatio(resolveVar(theme, resolveVar(theme, tok[0])), on);
      assert.ok(r >= WCAG_NON_TEXT, what + ' is ' + contrastRound(r) + ':1 in ' + mode + ' — 1.4.11 asks ' + WCAG_NON_TEXT);
    }
  }
  // the filled ▶ uses the accent ink — the guard above („every rule that paints text on an accent background")
  // covers it; this only makes sure it IS one of those rules and not a hand-picked colour
  assert.equal(declsOf('.cside-plan .csp-btn.is-primary').color, 'var(--on-accent)');
});

// --- P-1: Projekte — the tiles, the project page, the editor dialog -----------------------------------------------
// WHY: a whole new view, so every text it writes is listed with the surface it sits on and measured in all three theme
// blocks — not a screenshot. Two rules the block was written against are pinned too: nothing fades (a state is a dashed
// frame or a glyph, the PF-1 lesson), and --danger / --warning never paint TEXT (as text they are 2,96:1 / 2,2:1 on the
// light panels — they draw the edges, the words stay --text or --warning-text).
const P1_TEXT = [
  // [text rule, backdrop rule (its `background`), what it is]
  ['.pt-name', '.proj-tile', 'a tile\'s name'],
  ['.pt-desc', '.proj-tile', 'a tile\'s description'],
  ['.pt-meta', '.proj-tile', '„3 Sitzungen · zuletzt …"'],
  ['.proj-warn', '.proj-warn', 'the ⚠ badge'],
  ['.proj-tag', '.proj-tag', '„archiviert"'],
  ['.proj-chip', '.proj-chip', 'a start value'],
  ['.proj-chip .pc-k', '.proj-chip', 'its label'],
  ['.proj-chip.unset .pc-v', '.proj-chip', '„Standard" (not set by the project)'],
  ['.pd-name', 'body', 'the page title'],
  ['.pd-desc', 'body', 'the description'],
  ['.pd-desc.empty', 'body', '„Keine Beschreibung."'],
  ['.proj-empty-sub', 'body', 'the empty state\'s second line'],
  ['.proj-lint li', '.proj-lint li', 'a stored warning'],
  ['.pd-instr', '.pd-instr', 'the instructions'],
  ['.pd-instr.empty', '.pd-instr', '„Keine Anweisungen."'],
  ['.pe-sec-title', '.pe-sec', 'an editor section title'],
  ['.pe-hint', '.pe-sec', 'a field hint'],
  ['.pe-hint', '.modal', 'a hint above the sections'],
  ['.pe-from', '.modal', '„Vorbelegt mit den Startwerten des Tabs …"'],
  ['.pe-warn', '.pe-sec', 'a warning inside a section'],
  ['.pe-warn', '.modal', 'the dropped-bypass line'],
  ['.pe-fwarn', '.pe-sec', 'a live warning under its field'],
  ['.pe-ferror', '.pe-sec', '„✕ zu lang …" under its field'],
  ['.pe-errors', '.pe-errors', 'the „Nicht gespeichert" list'],
  ['.pe-counter', '.pe-sec', '„44 / 2.000"'],
  ['.pe-counter.over', '.pe-sec', '„⚠ 2.001 / 2.000 — zu lang"'],
  ['.pe-mcp-sum', '.pe-sec', '„1 ausgewählt"'],
  ['.pe-mcp-note', '.pe-mcp-list', '„nicht konfiguriert"'],
  ['.swatch.pe-swatch-none', '.swatch.pe-swatch-none', 'the „no colour" swatch'],
  // a REUSED class is measured where this view puts it: .danger-btn wrote --danger as its label, 2,87:1 on the
  // light --bg (the Gegencheck of 05.10. — the new pairs above were all fine, the borrowed one was not)
  ['.danger-btn', 'body', '„Löschen" on the project page'],
  ['.danger-btn', '.modal', '„Verwerfen" in the unsaved-draft question'],
  // the „Sitzung zuordnen…" checklist sits in a dialog
  ['.pe-hint', '.pd-pick-rows', 'the picker\'s note (inside the list frame, worst case)'],
  // Stufe 2 — the status chip, the list chip (solid / dashed „ohne"), the filter chips. „geändert seit Start" is said
  // in words; the --warning edge only repeats it.
  ['.proj-cs-chip', '.proj-cs-chip', 'the status chip „◆ X"'],
  ['.proj-si-chip', '.proj-si-chip', 'a session\'s project chip'],
  ['.proj-si-chip.none', '.proj-si-chip', 'the dashed „Ohne Projekt"'],
  ['.proj-si-chip.derived', '.proj-si-chip', 'the dashed „◆ X · per Regel" (J14)'],
  ['.proj-hidden-hint', 'body', '„n Sitzungen ausgeblendet" above the list (J14)'],
  ['.proj-filter-chip', '.proj-filter-chip', 'a project filter chip'],
  ['.proj-filter-chip.on', '.proj-filter-chip', 'the pressed filter chip'],
];
test('P-1: every Projekte text is at AA on its own surface, in all three themes — and nothing fades', () => {
  for (const mode of Object.keys(THEME_BLOCK)) {
    const theme = THEMES[mode];
    for (const [sel, bgSel, what] of P1_TEXT) {
      const d = declsOf(sel), bg = resolveVar(theme, declsOf(bgSel).background);
      assert.ok(d.color, sel + ' declares no colour — then it inherits one nobody measured here');
      // twice: --warning-text is var(--warning) in the dark block
      const r = contrastRatio(resolveVar(theme, resolveVar(theme, d.color)), bg);
      assert.ok(r >= WCAG_AA_TEXT, what + ' (' + sel + ') is ' + contrastRound(r) + ':1 in ' + mode + ' — AA asks ' + WCAG_AA_TEXT);
    }
  }
  const mine = BLOCKS.filter((b) => /^\.(proj-|pt-|pd-|pe-)/.test(b.sel) || /\.proj-editor|\.pe-/.test(b.sel));
  assert.ok(mine.length >= 60, 'the Projekte block was not found (' + mine.length + ' rules)');
  for (const b of mine) {
    assert.ok(!/(^|[;{\s])opacity\s*:/.test(b.body), b.sel + ' fades — dashed or a glyph, not an opacity');
    assert.ok(!/(^|[;{\s])color\s*:\s*var\(--(danger|warning)\)/.test(b.body), b.sel + ' writes --danger/--warning as TEXT (below AA in light)');
  }
});

// --- P-2 cockpit (Teil 1b): the new texts on their own surfaces, all three themes — EN/light is measured here, not by eye
const P2_TEXT = [
  ['.proj-sug', '.proj-sug', 'the „n Vorschläge“ badge'],
  ['.pt-cost', '.proj-tile', '„30 Tage: … (Schätzung)“ on a tile'],
  ['.pd-ov-loading', '.pd-ov-loading', 'the loading line'],
  ['.pd-ov-text', '.pd-ov-loading', 'its text'],
  ['.pd-ov-secs', '.pd-ov-loading', 'its seconds'],
  ['.pd-ov-err', '.pd-ov-err', 'a failed read'],
  ['.pd-last-src', '.pd-last', '„Quelle: …“'],
  ['.pd-last-who', '.pd-last', '„Du“ / „Claude“'],
  ['.pd-last-text', '.pd-last', 'the last prompt / answer'],
  ['.pd-cost-k', '.pd-cost', '„30 Tage“ / „gesamt“'],
  ['.pd-cost-v', '.pd-cost', 'the estimated amount'],
  ['.proj-jira', '.proj-chip', 'a Jira link in its chip'],
];
test('P-2: every cockpit text is at AA on its own surface, in all three themes', () => {
  for (const mode of Object.keys(THEME_BLOCK)) {
    const theme = THEMES[mode];
    for (const [sel, bgSel, what] of P2_TEXT) {
      const d = declsOf(sel), bg = resolveVar(theme, declsOf(bgSel).background);
      assert.ok(d.color, sel + ' declares no colour');
      const r = contrastRatio(resolveVar(theme, resolveVar(theme, d.color)), bg);
      assert.ok(r >= WCAG_AA_TEXT, what + ' (' + sel + ') is ' + contrastRound(r) + ':1 in ' + mode);
    }
  }
});

// --- PF-2: the model's own tasks under a plan step ------------------------------------------------------------
// WHY: the task rows (chat-side.js planStepTasks) are the smallest text in the rail (11 px) and sit one level below a
// step — exactly where a „make it quieter" fade would creep in. They carry NO colour of their own: the strip's state
// rules (.todo-item.<state>) paint them, so those are measured here on the rail itself, in all three theme blocks —
// the text at 4,5:1, the mark (a state glyph: ✓ ⏳ ☐) at 3:1 like the step's own (1.4.11) — and the task rules are
// pinned to declare neither a colour nor an opacity, so the measurement stays the one that applies.
// What this measurement found on the way: the ✓/√ of a finished task or step was raw --success, 2,22:1 on the light
// --panel (7,12:1 dark) — for the strip and the plan's steps since they exist. It is --success-text now (the
// --warning-text pattern: the same green in dark, #2e7d46 = 5,07:1 in both light blocks).
test('PF-2: the tasks under a step are at AA on the rail, and the strip\'s rows on its own box — the strip\'s state colours, no fade', () => {
  for (const sel of ['.cside-plan .csp-tasks', '.cside-plan .csp-task', '.cside-plan .csp-task .todo-mark', '.cside-plan .csp-task .todo-text']) {
    const d = declsOf(sel);
    assert.equal(d.opacity, undefined, sel + ' is faded');
    assert.equal(d.color, undefined, sel + ' paints a colour of its own — then the state rules measured below are no longer what it shows');
  }
  // Two surfaces, the same rules: the rail the steps stand on, and #chatTodos above the composer — the strip prints the
  // same .todo-item rows (its √ included) on its own box, --panel-2, not on the rail's --panel (counter-check: a lighter
  // --panel-2 would have dropped the strip's √ below AA with no test noticing).
  const strip = declsOf('.chat-todos .ct-det').background;
  assert.ok(/var\(--[\w-]+\)/.test(String(strip || '')), 'the strip\'s box carries no theme token — re-measure: ' + strip);
  for (const mode of Object.keys(THEME_BLOCK)) {
    const theme = THEMES[mode];
    for (const [where, bg] of [['the rail', resolveVar(theme, declsOf('.chat-side').background)], ['the strip', resolveVar(theme, strip)]]) {
      for (const state of ['pending', 'in_progress', 'completed']) {
        const text = contrastRatio(resolveVar(theme, resolveVar(theme, declsOf('.todo-item.' + state + ' .todo-text').color)), bg);
        assert.ok(text >= WCAG_AA_TEXT, 'a ' + state + ' task\'s text is ' + contrastRound(text) + ':1 on ' + where + ' in ' + mode + ' — AA asks ' + WCAG_AA_TEXT);
        const mark = contrastRatio(resolveVar(theme, resolveVar(theme, declsOf('.todo-item.' + state + ' .todo-mark').color)), bg);
        assert.ok(mark >= WCAG_NON_TEXT, 'a ' + state + ' task\'s mark is ' + contrastRound(mark) + ':1 on ' + where + ' in ' + mode + ' — 1.4.11 asks ' + WCAG_NON_TEXT);
      }
      // the ✓ found on the way: --success-text, and at AA (it is a character, the strip and the steps print it too)
      const done = contrastRatio(resolveVar(theme, resolveVar(theme, declsOf('.todo-item.completed .todo-mark').color)), bg);
      assert.ok(done >= WCAG_AA_TEXT, 'the ✓ of a finished task/step is ' + contrastRound(done) + ':1 on ' + where + ' in ' + mode);
      if (mode !== 'dark') {
        assert.ok(contrastRatio(theme['--success'], bg) < WCAG_NON_TEXT,
          'raw --success now passes on ' + where + ' (light) — then --success-text has no reason left, re-measure');
      }
    }
  }
  assert.equal(declsOf('.todo-item.completed .todo-mark').color, 'var(--success-text)');
});
