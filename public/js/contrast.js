'use strict';
// WCAG contrast arithmetic — browser (classic script) AND Node (require'd by test/contrast.test.js).
// Dependency-free and side-effect-free (ctx.js / turn-end.js spirit): no t()/tt(), no DOM.
//
// WHY this file exists: the panel's primary buttons printed WHITE text on the Claude coral
// (`.primary-btn`, `.send-btn`, `.opt-send`, `.df-chip.active`, `.ui-seg-btn.active`,
// `.skd-flow > li::before`). Measured with the formula below: 3,12:1 at the `--accent` end of the
// gradient and 2,03:1 at the `--accent-2` end — WCAG AA asks 4,5:1 for text this size (13px/600 is not
// „large": large starts at 24px, or 18,66px when bold). Nobody noticed for the same reason nobody
// notices it next time: „sieht gut aus" is not a measurement, and the panel had no way to produce one.
//
// So the arithmetic lives here, as the ONE definition the stylesheet is checked against, and the check
// is a test (test/contrast.test.js reads the real values out of public/styles.css — not a copy).
//
// The second, harder half: ⚙ Anzeige → Akzentfarbe lets the user pick ANY hex, and
// applyAccent() (views.js) writes it into `--accent`. A fixed text colour in the stylesheet is
// therefore a promise the user can break with one click — a pale yellow accent makes a white label
// invisible again, and the panel would keep claiming otherwise. That is why the text colour is
// DERIVED from the accent (accentSurface below) instead of written down.
//
// Formula: WCAG 2.x relative luminance. Channel c/255 → linear (c<=0.03928 ? c/12.92 :
// ((c+0.055)/1.055)^2.4) → L = 0.2126R + 0.7152G + 0.0722B → ratio = (Lmax+0.05)/(Lmin+0.05).

var WCAG_AA_TEXT = 4.5;  // normal text
var WCAG_AA_LARGE = 3;   // >= 24px, or >= 18.66px bold
// Same figure, DIFFERENT rule, and it gets its own name so a failure message can cite the right one:
// 1.4.11 Non-text Contrast asks 3:1 for the visual boundary of a CONTROL against its surroundings. The
// revoke × on a grant chip is the case that forced this constant — it is a 6,4 px glyph that is the only
// way to undo a permission, so „it is only decoration" stopped being true for it.
var WCAG_NON_TEXT = 3;

// The ink the panel prefers on a warm/light accent: a very dark brown out of the coral family rather
// than pure black, because pure black next to a warm surface reads as a rendering fault. It is a
// CANDIDATE, not a rule — if it does not reach 4,5:1 against the accent the ladder below moves on.
var ACCENT_INK_DARK = '#2a1a10';
var ACCENT_INK_LIGHT = '#ffffff';

function contrastParseHex(hex) {
  var s = String(hex == null ? '' : hex).trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  var n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function contrastToHex(rgb) {
  var p = function (v) { var s = Math.max(0, Math.min(255, Math.round(v))).toString(16); return s.length < 2 ? '0' + s : s; };
  return '#' + p(rgb[0]) + p(rgb[1]) + p(rgb[2]);
}
// A token like `rgba(94,194,122,.16)` is not a colour yet — it is a colour plus whatever is BEHIND it,
// and the panel stacks three of those on the revoke × of a grant chip (rail `--panel` → the chip's
// `--success-bg` → the glyph's own `opacity`). Measuring the rgba() as if it were opaque is how that ×
// „passed" at 5,24:1 while the eye saw 1,43:1. Returns { rgb, a }; a plain hex is a = 1.
function contrastParseColor(v) {
  var s = String(v == null ? '' : v).trim();
  var hex = contrastParseHex(s);
  if (hex) return { rgb: hex, a: 1 };
  var m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (!m) return null;
  return { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] };
}
// src-over composite of `top` onto an OPAQUE `bottom`, rounded to 8-bit channels like the compositor
// does, so a number here and a pixel in the browser agree. `alphaMul` is the element's CSS `opacity`,
// which multiplies the colour's own alpha. A translucent `bottom` returns null rather than a guess — the
// caller has to say what is under it, because that is the whole point of this function.
function contrastOver(top, bottom, alphaMul) {
  var t = contrastParseColor(top), b = contrastParseColor(bottom);
  if (!t || !b || b.a !== 1) return null;
  var a = t.a * (alphaMul == null ? 1 : alphaMul);
  return contrastToHex([
    t.rgb[0] * a + b.rgb[0] * (1 - a),
    t.rgb[1] * a + b.rgb[1] * (1 - a),
    t.rgb[2] * a + b.rgb[2] * (1 - a),
  ]);
}
function srgbToLinear(c) {
  var v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function relLuminance(hex) {
  var rgb = contrastParseHex(hex);
  if (!rgb) return null;
  return 0.2126 * srgbToLinear(rgb[0]) + 0.7152 * srgbToLinear(rgb[1]) + 0.0722 * srgbToLinear(rgb[2]);
}
// The ratio formula on two LUMINANCES that are already known. Split out of contrastRatio() so accentText()
// below can walk a lightness ramp against ten fixed surfaces without re-deriving their luminance on every
// step (that is a 10× difference over a 24.389-colour sweep) — same arithmetic, one definition, not a
// second one.
function contrastRatioLum(la, lb) {
  if (la == null || lb == null) return null;
  var hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}
// null for an unparseable colour — NOT 1 or 21. A contrast we could not compute must not look like a
// pass (nor like a failure that sends somebody hunting a colour that does not exist).
function contrastRatio(a, b) { return contrastRatioLum(relLuminance(a), relLuminance(b)); }
// Rounded DOWN to two decimals on purpose: a ratio printed as „4,50" that is really 4,4996 would be a
// pass claimed by rounding. Used by the test's failure messages and by the CHANGELOG numbers.
function contrastRound(r) { return r == null ? null : Math.floor(r * 100) / 100; }

function contrastLighten(hex, f) {
  var rgb = contrastParseHex(hex);
  if (!rgb) return null;
  return contrastToHex([
    rgb[0] + (255 - rgb[0]) * f,
    rgb[1] + (255 - rgb[1]) * f,
    rgb[2] + (255 - rgb[2]) * f,
  ]);
}

// The worst ratio of one text colour against a SET of backgrounds. A gradient button has two stops and
// the label crosses both, so the lighter stop is not a detail — it is where the old white text fell to
// 2,03:1 while the darker stop still managed 3,12:1 and made the defect look half as bad as it was.
function contrastWorst(fg, bgs) {
  var worst = Infinity;
  for (var i = 0; i < bgs.length; i++) {
    var r = contrastRatio(fg, bgs[i]);
    if (r == null) return null;
    if (r < worst) worst = r;
  }
  return worst === Infinity ? null : worst;
}
// Best candidate out of the ladder, by worst-case ratio. Order matters: the first candidate that CLEARS
// the threshold wins, so the panel's warm ink is kept wherever it is legible instead of jumping to
// white for a fraction of a point.
function contrastPick(bgs, min, candidates) {
  var list = candidates || [ACCENT_INK_DARK, ACCENT_INK_LIGHT, '#000000'];
  var best = null;
  for (var i = 0; i < list.length; i++) {
    var r = contrastWorst(list[i], bgs);
    if (r == null) continue;
    if (r >= min) return { color: list[i], ratio: r, ok: true };
    if (!best || r > best.ratio) best = { color: list[i], ratio: r, ok: false };
  }
  return best;
}

// The whole accent surface, derived from one user-chosen hex: the gradient's two stops AND the text
// colour that is legible on BOTH of them.
//
// WHY the gradient is part of the derivation and not left alone: for a mid-luminance accent there is no
// text colour that clears 4,5:1 against both stops at once. Worked example — accent #595959 with the
// stock 22 % lift gives #808080: pure black reaches only 3,04:1 on #595959, pure white only 3,95:1 on
// #808080. Keeping the lift and picking „the better of two failures" would be exactly this project's
// habit of asserting something nobody checked. So the lift is REDUCED until one ink works, and in the
// last resort dropped to 0 — a single-colour surface, where max(white, black) is >= 4,58:1 for every
// possible colour (the crossover sits at (L+0.05)^2 = 0.0525). That is why this function cannot fail.
var ACCENT_LIFTS = [0.22, 0.12, 0.06, 0];
function accentSurface(hex, min) {
  var base = contrastParseHex(hex);
  if (!base) return null;
  var want = min == null ? WCAG_AA_TEXT : min;
  var accent = contrastToHex(base);
  var last = null;
  for (var i = 0; i < ACCENT_LIFTS.length; i++) {
    var lift = ACCENT_LIFTS[i];
    var accent2 = lift ? contrastLighten(accent, lift) : accent;
    var pick = contrastPick([accent, accent2], want, null);
    last = { accent: accent, accent2: accent2, onAccent: pick.color, ratio: pick.ratio, lift: lift, ok: pick.ok };
    if (pick.ok) return last;
  }
  return last; // lift 0 always clears `want` for want <= 4.58; returned anyway so a caller can see `ok`
}

// --- K1: the accent as a TEXT colour, on the panel's own surfaces -------------------------------
//
// accentSurface() above answers „what ink goes ON the accent". This half answers the opposite and far
// more common question: 116 declarations in public/styles.css write the accent itself as a FOREGROUND
// (`color: var(--accent)` 114 ×, `color: var(--accent-2)` 2 ×) on ordinary panel surfaces — `.bubble a`,
// `.tc-name`, `.cl-hash`, `.si-proj`, `.m-tool.hit` and so on. Measured against the real stylesheet
// values, the SHIPPED coral never reached AA there: worst case 2,00:1 in light mode and 2,92:1 in dark
// (both on an --accent-glow chip), and on the plain surfaces 3,12:1 (--panel, light) / 2,96 (--panel-2) /
// 2,86 (--bg). A freely chosen accent is worse: #ffff00 is 1,07:1 on the light --panel, #000080 is
// 1,01:1 on the dark one. So the same argument as for --on-accent applies, with the roles swapped.
//
// WHY A SEPARATE RAMP instead of contrastPick()'s candidate ladder: there the text is allowed to be any
// ink (dark brown, white, black) because the SURFACE is what the user chose. Here the TEXT is the thing
// the user chose. Replacing it with „some colour that passes" would be a different lie — the user picks
// a colour in a `type="color"` field and the panel shows another one. So HUE and HSL SATURATION are kept
// EXACTLY and only the lightness moves, by the smallest amount that reaches the threshold.
//
// WHEN THAT IS NOT ENOUGH: mathematically it always „works" — pushed far enough the ramp ends at black or
// white, which clears any surface. That is precisely the silent failure to avoid. So the travel is
// measured (`shift`, in HSL lightness units) and compared against ACCENT_FG_MAX_SHIFT; past that the
// result is still used (legible text beats a faithful hue in a change whose subject is contrast) but it
// is flagged `faithful: false`, and views.js prints that under the colour field. „Quietly approximated"
// is the one outcome this function cannot produce.
function contrastToHsl(hex) {
  var rgb = contrastParseHex(hex);
  if (!rgb) return null;
  var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
  var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
  var h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, s, l];
}
function contrastFromHsl(h, s, l) {
  var c = (1 - Math.abs(2 * l - 1)) * s, hp = ((h % 360) + 360) % 360 / 60;
  var x = c * (1 - Math.abs((hp % 2) - 1)), m = l - c / 2, r, g, b;
  if (hp < 1) { r = c; g = x; b = 0; } else if (hp < 2) { r = x; g = c; b = 0; }
  else if (hp < 3) { r = 0; g = c; b = x; } else if (hp < 4) { r = 0; g = x; b = c; }
  else if (hp < 5) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; }
  return contrastToHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

// The surfaces accent-coloured text can land on, PER THEME. This is a copy of six tokens out of
// public/styles.css, and the copy is deliberate: a browser can only read the ACTIVE theme's variables,
// while applyAccent() has to derive a value for both themes at once (data-theme="auto" follows the OS
// live, so the inactive theme's value must exist before anybody switches). The guard against a copy going
// stale is the same one --on-accent has: test/contrast.test.js reads all THREE theme blocks out of the
// stylesheet and fails if any of these hexes, or any of the derived literals below, disagree with it.
var ACCENT_FG_SURFACES = {
  dark: { '--bg': '#17161a', '--bg-2': '#1e1d22', '--panel': '#232228', '--panel-2': '#2a2930', '--code-bg': '#141317', '--user-bubble': '#2f2a3a' },
  light: { '--bg': '#f6f5f3', '--bg-2': '#efeeeb', '--panel': '#ffffff', '--panel-2': '#faf9f7', '--code-bg': '#f2f0ec', '--user-bubble': '#f0e7e0' },
};
// 17 of the 116 rules bring their own background: `background: var(--accent-glow)` — a 28 % tint of the
// accent, so the surface MOVES with the accent and a fixed surface list would miss it entirely (that tint
// is where the shipped coral bottoms out at 2,00:1 / 2,92:1). It is composited over the four page/panel
// surfaces only: every one of those 17 selectors is a chip or badge in a panel, rail or nav
// (`.nav-busy`, `.ag-own`, `.sett-nav a.here`, `.ski-badge.command`, `.m-badge.upd`, …), never inside a
// code block or a user bubble. `.nav-item.active` mixes the accent at 10 % instead; 28 % pulls the
// surface further towards the accent and is therefore the stricter of the two, so covering .28 covers it.
var ACCENT_GLOW_ALPHA = 0.28;
var ACCENT_FG_TINT_ON = ['--bg', '--bg-2', '--panel', '--panel-2'];
function accentFgSurfaces(accentHex, mode) {
  var map = ACCENT_FG_SURFACES[mode], rgb = contrastParseHex(accentHex);
  if (!map || !rgb) return null;
  var glow = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + ACCENT_GLOW_ALPHA + ')';
  var out = [], k;
  for (k in map) if (Object.prototype.hasOwnProperty.call(map, k)) out.push(map[k]);
  for (var i = 0; i < ACCENT_FG_TINT_ON.length; i++) out.push(contrastOver(glow, map[ACCENT_FG_TINT_ON[i]]));
  return out;
}

// How far the lightness may travel before „this is your colour, a little darker" becomes „this is not
// your colour". A JUDGEMENT, like ACCENT_INK_DARK above — but a bounded one, and these two measured cases
// are what bounds it: the shipped coral needs 0,238 in light mode and still reads as a darker rust (it
// must NOT warn — it is the one accent this project has looked at and accepted), while #000080 needs
// 0,512 in dark mode and arrives at #8686ff, a periwinkle nobody would call navy (it MUST warn). 0,30 is
// the roundest value in that gap, and the strictest round value that still lets the shipped default
// through. Both cases are pinned in test/contrast.test.js, so moving this constant breaks them loudly.
var ACCENT_FG_MAX_SHIFT = 0.30;
// 1/512 of the lightness range — finer than the 8-bit channels the result is rounded to, so the search
// grid is never the limiting factor.
var ACCENT_FG_STEPS = 512;

// Smallest lightness move that lets `hex` reach `min`:1 against every surface of `mode`.
// Returns { color, ratio, shift, met, faithful, dir } — `met` is „reached the threshold", `faithful` is
// „and still looks like the colour the user picked". Both are separate on purpose: the caller must be
// able to say WHICH half failed.
function accentText(hex, mode, min) {
  var hsl = contrastToHsl(hex), bgs = accentFgSurfaces(hex, mode);
  if (!hsl || !bgs) return null;
  var want = min == null ? WCAG_AA_TEXT : min;
  var h = hsl[0], s = hsl[1], l0 = hsl[2];
  var lums = [];
  for (var j = 0; j < bgs.length; j++) lums.push(relLuminance(bgs[j]));
  var at = function (k, dir) {
    var l = Math.max(0, Math.min(1, l0 + dir * k / ACCENT_FG_STEPS));
    var c = contrastFromHsl(h, s, l), lc = relLuminance(c), worst = Infinity;
    for (var i2 = 0; i2 < lums.length; i2++) {
      var r2 = contrastRatioLum(lc, lums[i2]);
      if (r2 < worst) worst = r2;
    }
    return { color: c, ratio: worst, shift: Math.abs(l - l0), dir: dir };
  };
  var here = at(0, -1);
  if (here.ratio >= want) return { color: here.color, ratio: here.ratio, shift: 0, met: true, faithful: true, dir: 0 };
  // Which way to move: whichever END of the lightness axis is better against these surfaces. For a
  // homogeneous surface set (all light, or all dark — which both themes are) the ratio grows monotonically
  // as the text moves away from them, so the binary search below is sound; the final re-measurement on the
  // ROUNDED hex catches the case where it is not, instead of trusting the assumption.
  var down = at(ACCENT_FG_STEPS, -1), up = at(ACCENT_FG_STEPS, 1);
  var dir = down.ratio >= up.ratio ? -1 : 1;
  var end = dir < 0 ? down : up;
  if (end.ratio < want) return { color: end.color, ratio: end.ratio, shift: end.shift, met: false, faithful: false, dir: dir };
  var lo = 0, hi = ACCENT_FG_STEPS;
  while (lo < hi) { var mid = (lo + hi) >> 1; if (at(mid, dir).ratio >= want) hi = mid; else lo = mid + 1; }
  var got = at(lo, dir);
  while (got.ratio < want && lo < ACCENT_FG_STEPS) { lo++; got = at(lo, dir); } // 8-bit rounding safety net
  return {
    color: got.color, ratio: got.ratio, shift: got.shift, dir: dir,
    met: got.ratio >= want, faithful: got.ratio >= want && got.shift <= ACCENT_FG_MAX_SHIFT,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    srgbToLinear, relLuminance, contrastRatio, contrastRound, contrastParseHex, contrastToHex,
    contrastParseColor, contrastOver, contrastLighten, contrastWorst, contrastPick, accentSurface, contrastRatioLum,
    contrastToHsl, contrastFromHsl, accentFgSurfaces, accentText,
    WCAG_AA_TEXT, WCAG_AA_LARGE, WCAG_NON_TEXT, ACCENT_INK_DARK, ACCENT_INK_LIGHT, ACCENT_LIFTS,
    ACCENT_FG_SURFACES, ACCENT_FG_TINT_ON, ACCENT_GLOW_ALPHA, ACCENT_FG_MAX_SHIFT, ACCENT_FG_STEPS,
  };
}
