'use strict';
// Navigation rail by choice: the ≤820px icon rail, also on a normal window, behind a button that is remembered.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CSS = read('public/styles.css');
const HTML = read('public/index.html');
const RENDER = read('public/js/render.js');

// every `@media (<cond>) { … }` block whose condition matches, with its body
function mediaBlocks(cond) {
  const out = [];
  let i = 0;
  const head = '@media (' + cond + ') {';
  while ((i = CSS.indexOf(head, i)) >= 0) {
    let depth = 0, j = i + head.length - 1;
    for (; j < CSS.length; j++) { if (CSS[j] === '{') depth++; else if (CSS[j] === '}' && --depth === 0) break; }
    out.push(CSS.slice(i, j + 1)); i = j;
  }
  return out;
}

describe('nav rail — CSS', () => {
  it('every :root.nav-rail rule sits inside @media (min-width: 561px) — the drawer below keeps its labels', () => {
    const inside = mediaBlocks('min-width: 561px').join('\n');
    const all = CSS.match(/:root\.nav-rail[^{]*\{/g) || [];
    assert.ok(all.length >= 8, 'the rail rules exist: ' + all.length);
    const outside = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media \(min-width: 561px\) \{[\s\S]*?\n\}/g, '');
    assert.doesNotMatch(outside, /:root\.nav-rail/,'a nav-rail rule outside the ≥561px block would overrule the drawer');
    assert.match(inside, /:root\.nav-rail \.app \{ grid-template-columns: 64px 1fr; \}/);
  });
  it('the forced rail (≤820px) hides the fold button — there is nothing to fold there', () => {
    assert.ok(mediaBlocks('max-width: 820px').some((b) => /\.nav-rail-btn \{ display: none; \}/.test(b)));
  });
  it('in the rail the running-turns badge goes to the icon corner and the footer pills drop their text', () => {
    const forced = mediaBlocks('min-width: 561px) and (max-width: 820px').join('\n');
    assert.match(forced, /\.nav-item \.nav-busy \{ position: absolute;/);
    assert.match(forced, /\.pr-pill > span:not\(\.pr-dot\)/);
  });
});

describe('nav rail — wiring', () => {
  it('the button is in the brand row, with aria-expanded and aria-controls naming the sidebar', () => {
    assert.match(HTML, /<button id="navRailBtn" class="nav-rail-btn" type="button" aria-expanded="true" aria-controls="sidebar"><\/button>/);
    // the id the button names exists in the markup itself (mountNavDrawer only sets it when missing) — and it is what
    // lets a local fold-addon (Sergej's prototype checks `.brand [aria-controls]`) see that the panel has its own
    assert.match(HTML, /<aside class="sidebar" id="sidebar">/);
    const brand = HTML.indexOf('<div class="brand">'), nav = HTML.indexOf('<nav class="nav">'), btn = HTML.indexOf('id="navRailBtn"');
    assert.ok(brand < btn && btn < nav);
  });
  it('render.js applies the remembered state at load and relabels on a language switch', () => {
    assert.match(RENDER, /applyNavRail\(localStorage\.getItem\('ccui-nav-rail'\) === '1', false\);/);
    assert.match(RENDER, /'refreshNavRailBtn'/);
    assert.match(RENDER, /localStorage\.setItem\('ccui-nav-rail'/);
  });
  it('the shortcut card and the README document the button', () => {
    assert.match(HTML, /data-i18n="html\.klickNavigation"/);
    assert.match(read('README.md'), /\| `«` at the top of the navigation \|/);
  });
});

describe('text size — the browser zoom, made findable', () => {
  it('quick settings, the chat display menu, the shortcut card and the README all name Strg +/−/0', () => {
    assert.match(HTML, /data-i18n="html\.textgroessePanelHinweis"/);
    assert.match(HTML, /data-i18n="html\.ganzesPanelZoom"/);
    assert.match(HTML, /data-i18n="html\.panelZoomKuerzel"/);
    assert.match(read('README.md'), /\| `Strg\/⌘ \+` \/ `−` \/ `0` \|/);
  });
});
