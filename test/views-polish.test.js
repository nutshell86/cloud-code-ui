'use strict';
// PR-9b, second pass — the polish findings of the 2026-10-01 browser review (section H).
//
// Every one of them is a place where the panel SHOWED something it had not checked: a badge that was red
// whatever it counted, a label built out of internal identifiers, a number in the wrong language, an error
// code offered as an explanation, a sticky bar on top of the thing it had just scrolled to.
//
// HOW the browser halves are tested: public/js/*.js are classic scripts with no exports (they need the
// whole app's globals), so the functions under test are LIFTED OUT OF THE SHIPPED SOURCE BY NAME and run
// against fake globals — the same seam test/views-data-guards.test.js, test/ultracode-honesty.test.js and
// test/agent-lanes.test.js use. If one of them is renamed or reindented these tests fail loudly instead of
// quietly testing a copy. What cannot be lifted (a stylesheet rule, an attribute in index.html, one call
// inside a 700-line function) is pinned as TEXT on the token a regression would have to remove — the same
// compromise as test/status-strip.test.js, and with comments stripped first so a comment that happens to
// name the token cannot satisfy the assertion.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const RENDER_SRC = read('public/js/render.js');
const CHAT_RENDER_SRC = read('public/js/chat-render.js');
const SIDE_SRC = read('public/js/chat-side.js');
const VIEWS_SRC = read('public/js/views.js');
const USAGE_SRC = read('public/js/views-usage.js');
const UIS_SRC = read('public/js/views-uiskills.js');
const MEM_SRC = read('public/js/views-memory.js');
// index.html with its COMMENTS BLANKED, offsets and line numbers preserved. Not cosmetic: the first
// version of the select guard below counted `<label>` openings in the raw file, and a comment added in this
// very change — „…sit inside their <label> and are named by it" — left the balance one too high for every
// element after it, so all four nameless selects looked wrapped in a label and the guard passed on the
// defect it was written for. The mutation run is what found that (removing the aria-label stayed GREEN).
// Every structural assertion over the markup therefore reads this, never the raw text.
const HTML = read('public/index.html').replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
const CSS = read('public/styles.css');
// Enumerated, not listed: a scan that is supposed to cover „the panel" has to ASK the directory, or it
// quietly stops covering the file somebody adds next week. Same argument verify.js makes about its own
// suite list. 34 files when this was written — the number is not asserted, the enumeration is the point.
const BROWSER_FILES = fs.readdirSync(path.join(ROOT, 'public', 'js'))
  .filter((f) => f.endsWith('.js')).sort().map((f) => 'public/js/' + f);
const { memoryLinkTargets: serverMemoryLinks } = require('../lib/pure');

// ---- the lifting seam (same rule as test/views-data-guards.test.js) --------------------------------
function liftFn(src, name, rel) {
  const one = new RegExp('^(?:async )?function ' + name + '\\(.*\\}[ \\t]*$', 'm');
  const multi = new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?^\\}', 'm');
  const m = one.exec(src) || multi.exec(src);
  assert.ok(m, name + '() not found in ' + rel + ' — renamed or reindented? Then these tests prove nothing.');
  return m[0];
}
function bundle(pieces, names, env) {
  const keys = Object.keys(env);
  const body = pieces.join('\n') + '\nreturn { ' + names.join(', ') + ' };';
  return new Function(...keys, body)(...keys.map((k) => env[k]));
}
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*$/gm, '');
// a CSS declaration block by selector, comments removed — so a rule cannot be "present" in prose only
function cssRule(selector) {
  const src = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = new RegExp('(^|\\})\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'm');
  const m = re.exec(src);
  return m ? m[2] : null;
}

// ====================================================================================================
// BELL-1 — the 🔔 badge counted everything in red and missed the failures that mattered
// ====================================================================================================
function loadBell() {
  return bundle([liftFn(RENDER_SRC, 'eventBellState', 'render.js')], ['eventBellState'], {});
}
describe('BELL-1 — the bell says HOW MANY and WHETHER one of them failed, separately', () => {
  it('three acknowledgements are three, and they are not red', () => {
    const { eventBellState } = loadBell();
    const s = eventBellState([{ kind: 'ok', seen: false }, { kind: '', seen: false }, { kind: 'ok', seen: false }]);
    assert.equal(s.unseen, 3);
    assert.equal(s.kind, '', 'an info/ok toast must not produce the same badge a failed run does');
  });

  it('one error among them turns it red; a warning is a warning', () => {
    const { eventBellState } = loadBell();
    assert.equal(eventBellState([{ kind: 'ok', seen: false }, { kind: 'err', seen: false }]).kind, 'err');
    assert.equal(eventBellState([{ kind: 'ok', seen: false }, { kind: 'warn', seen: false }]).kind, 'warn');
    assert.equal(eventBellState([{ kind: 'err', seen: false }, { kind: 'warn', seen: false }]).kind, 'err', 'the worst one wins');
  });

  it('SEEN entries count for nothing — neither for the number nor for the colour', () => {
    const { eventBellState } = loadBell();
    const s = eventBellState([{ kind: 'err', seen: true }, { kind: 'ok', seen: false }]);
    assert.equal(s.unseen, 1);
    assert.equal(s.kind, '', 'an error you already read must not keep the badge red for ever');
  });

  it('the stylesheet actually distinguishes them (the rule, not just the class name)', () => {
    const base = cssRule('.event-bell .eb-dot');
    assert.ok(base, '.event-bell .eb-dot rule missing');
    assert.ok(!/background:\s*var\(--danger\)/.test(base), 'the NEUTRAL badge must not be --danger — that was the defect');
    const err = cssRule('.event-bell .eb-dot.err');
    assert.ok(err && /var\(--danger\)/.test(err), '.eb-dot.err must be the red one');
    assert.ok(cssRule('.event-bell .eb-dot.warn'), '.eb-dot.warn missing');
  });

  it('refreshEventBell writes the kind onto the dot — otherwise the rule above is unreachable', () => {
    const fn = noComments(liftFn(RENDER_SRC, 'refreshEventBell', 'render.js'));
    assert.match(fn, /eventBellState\(/, 'the painter must ask the pure rule, not count by itself again');
    assert.match(fn, /dot\.className\s*=/, 'the kind has to reach the element as a class');
  });

  it('a turn that DIED lands in the log — the one failure that reached it through nothing', () => {
    const fn = noComments(liftFn(CHAT_RENDER_SRC, 'addTurnError', 'chat-render.js'));
    assert.match(fn, /logEvent\(/, 'addTurnError must log: no toast is shown for it, and the tab may be in the background');
    assert.match(fn, /'err'/, 'it is an error, so it has to count as one');
    assert.match(fn, /tab\.title/, 'the record is useless without WHICH chat ended');
  });
});

// ====================================================================================================
// RAIL-1 — ~100 standing rules kept the approvals rail from ever folding itself away
// ====================================================================================================
function loadRail() {
  return bundle([liftFn(SIDE_SRC, 'railAutoAction', 'chat-side.js')], ['railAutoAction'], {});
}
describe('RAIL-1 — standing rules are a reference, not news', () => {
  it('nothing at all → fold (unchanged)', () => {
    const { railAutoAction } = loadRail();
    assert.equal(railAutoAction({}, {}), 'fold');
    assert.equal(railAutoAction({ points: 0, session: 0, persisted: 0, agents: 0, running: 0 }, { userExpanded: true }), 'fold',
      'an EMPTY rail folds even against your click — there is nothing in it to show');
  });

  it('90 standing rules and nothing else → fold (this is the defect)', () => {
    const { railAutoAction } = loadRail();
    assert.equal(railAutoAction({ persisted: 90 }, {}), 'fold', '220px for one collapsed <details> was the reported bug');
  });

  it('…unless you opened it yourself — then it stays open', () => {
    const { railAutoAction } = loadRail();
    assert.equal(railAutoAction({ persisted: 90 }, { userExpanded: true }), '',
      'a repaint during a turn must not shut the drawer you just pulled open to revoke a rule');
  });

  it('a question, a session grant or an agent lane keeps it open — with or without rules', () => {
    const { railAutoAction } = loadRail();
    assert.equal(railAutoAction({ persisted: 90, points: 1 }, {}), 'open');
    assert.equal(railAutoAction({ persisted: 90, session: 2 }, {}), 'open');
    assert.equal(railAutoAction({ persisted: 90, agents: 3, running: 2 }, {}), 'open');
    assert.notEqual(railAutoAction({ persisted: 90, agents: 3, running: 0 }, {}), 'fold',
      '„√3" is a finished agent, i.e. a RESULT — folding it away is losing news');
  });

  it('your own collapse is not undone by a new grant (the rule that already existed)', () => {
    const { railAutoAction } = loadRail();
    assert.equal(railAutoAction({ session: 2 }, { userCollapsed: true }), '');
  });
});

// ====================================================================================================
// POP-B — raw `<b>` in the display popover, and the guard that keeps markup out of every data-i18n key
// ====================================================================================================
describe('POP-B — a data-i18n value is TEXT, so it may not carry markup', () => {
  it('no key referenced by data-i18n contains a tag — in either language', () => {
    const I18N = requireI18N();
    const keys = [...HTML.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(keys.length > 100, 'expected the static chrome to be i18n-tagged — found ' + keys.length);
    const bad = [];
    keys.forEach((k) => {
      ['de', 'en'].forEach((loc) => {
        const v = I18N[loc] && I18N[loc][k];
        if (typeof v === 'string' && /<\/?[a-zA-Z][^>]*>/.test(v)) bad.push(loc + ' ' + k + ': ' + v.slice(0, 60));
      });
    });
    assert.deepEqual(bad, [], 'applyStaticI18n() assigns these with textContent — a tag in the value is PRINTED');
  });

  it('the „Offene Punkte sammeln" hint keeps its emphasis as an element', () => {
    assert.match(HTML, /<b data-i18n="html\.offenePunkteSammelnEine">/, 'the bold word is markup in index.html now');
  });

  it('…and the MIRROR direction: no data-i18n element may CONTAIN markup either', () => {
    // The guard above reads dictionary VALUES, so it never saw index.html's own `<b>` inside a data-i18n
    // element — `applyStaticI18n()` overwrites with textContent, so on the first paint the emphasis AND the
    // markup's wording vanish in favour of the dictionary's. One offender existed when this was written
    // (the „Antwortvorschläge" hint, which said „+ Neu" in markup and „neuen Chat" in the dictionary).
    // The split pattern — span + <b data-i18n> + plain punctuation — is the fix, and it is what the
    // „Stil-Wechsel" line has always done.
    //
    // Walk from each attribute BACK to its `<tag` instead of matching whole opening tags: the attribute
    // regex that looked obvious reached only 275 of the 381 elements, i.e. a guard with a 28 % blind spot.
    // Measured here: 381 elements, 0 unreadable.
    const VOID = /^(input|img|br|hr|meta|link|area|base|col|embed|source|track|wbr)$/i;
    const bad = [], skipped = [];
    const at = /\bdata-i18n="/g;
    let m, scanned = 0;
    while ((m = at.exec(HTML))) {
      const lt = HTML.lastIndexOf('<', m.index);
      const tm = /^<([a-z][a-z0-9]*)/i.exec(HTML.slice(lt, lt + 20));
      const gt = HTML.indexOf('>', m.index);
      if (!tm || gt < 0) { skipped.push('unparsable opening tag at offset ' + m.index); continue; }
      const tag = tm[1];
      if (VOID.test(tag) || HTML[gt - 1] === '/') continue;   // no children possible
      const close = HTML.indexOf('</' + tag, gt);
      if (close < 0) { skipped.push('<' + tag + '> is never closed'); continue; }
      scanned++;
      const inner = HTML.slice(gt + 1, close);
      if (/<[a-z]/i.test(inner)) {
        bad.push('line ' + HTML.slice(0, m.index).split('\n').length + ' <' + tag + '>: ' + inner.trim().slice(0, 60));
      }
    }
    assert.deepEqual(skipped, [], 'an element this guard cannot read is an element it does not guard');
    assert.ok(scanned > 300, 'expected the static chrome to be scanned — found only ' + scanned + ' elements');
    assert.deepEqual(bad, [], 'textContent assignment DELETES these children on the first paint — split the string instead');
  });
});
// the dictionary is a plain object literal — read it the way the app does, without a DOM
function requireI18N() {
  const src = read('public/js/i18n.js').replace(/^\uFEFF/, '');
  return new Function(src + '\nreturn I18N;')();
}

// ====================================================================================================
// NAV-STICK / NAV-LAST — the jump bar covered its target, and never marked the last section
// ====================================================================================================
function loadNav() {
  return bundle([liftFn(VIEWS_SRC, 'sectionNavPick', 'views.js')], ['sectionNavPick'], {});
}
describe('NAV-LAST — „which section am I reading" at the bottom of the scroller', () => {
  const rects = [{ id: 'a', top: -400, height: 500 }, { id: 'b', top: 100, height: 500 }, { id: 'c', top: 600, height: 120 }];
  it('mid-scroll: the last one that passed the edge', () => {
    const { sectionNavPick } = loadNav();
    assert.equal(sectionNavPick(rects, 40, false), 'a');
    assert.equal(sectionNavPick([{ id: 'a', top: -400, height: 500 }, { id: 'b', top: 30, height: 500 }], 40, false), 'b');
  });

  it('at the bottom: the LAST section, whatever its top edge says', () => {
    const { sectionNavPick } = loadNav();
    assert.equal(sectionNavPick(rects, 40, true), 'c',
      'a final card shorter than the viewport never crosses the edge — its chip could never light up');
  });

  it('above the first section: the first one below the edge, not nothing', () => {
    const { sectionNavPick } = loadNav();
    assert.equal(sectionNavPick([{ id: 'a', top: 300, height: 500 }, { id: 'b', top: 900, height: 500 }], 40, false), 'a');
  });

  it('a hidden view reports no geometry and therefore no answer', () => {
    const { sectionNavPick } = loadNav();
    assert.equal(sectionNavPick([{ id: 'a', top: 0, height: 0 }], 40, false), null);
    assert.equal(sectionNavPick([], 40, true), null);
  });
});
describe('NAV-STICK — a clicked section does not land underneath the sticky bar', () => {
  it('the targets carry a scroll offset, and it is the MEASURED bar height', () => {
    const rule = cssRule('.settings-scroll [id^="sec-"], .settings-scroll [id^="sys-"], .settings-scroll #envCard');
    assert.ok(rule, 'no scroll-margin-top rule for the jump targets');
    assert.match(rule, /scroll-margin-top/);
    assert.match(rule, /var\(--secnav-h/, 'a hard-coded offset goes stale the moment the bar wraps to two rows');
  });

  it('…and something writes that variable from a real measurement', () => {
    const src = noComments(VIEWS_SRC);
    assert.match(src, /setProperty\('--secnav-h'/, 'the CSS variable has no writer — the rule above would use its fallback for ever');
    assert.match(src, /getBoundingClientRect\(\)\.height/);
  });
});

// ====================================================================================================
// SETT-ORDER / ICON-DUP — the Settings view opened on „Info", and two chips drew the same picture
// ====================================================================================================
describe('SETT-ORDER — the jump bar and the cards below it tell the same story', () => {
  const navBlock = (id) => {
    const m = new RegExp('<nav class="sett-nav" id="' + id + '">([\\s\\S]*?)</nav>').exec(HTML);
    assert.ok(m, '#' + id + ' not found');
    return [...m[1].matchAll(/href="#([^"]+)"/g)].map((x) => x[1]);
  };

  it('Settings opens on the settings, not on the changelog', () => {
    const ids = navBlock('settNav');
    assert.equal(ids[0], 'sec-quick', 'the first chip is the first card, and the first card is what you came for');
    assert.equal(ids[ids.length - 1], 'sec-info', 'Info is reference material — last, and still one click away');
    assert.ok(HTML.indexOf('id="sec-quick"') < HTML.indexOf('id="sec-info"'), 'the DOM has to agree, or the view still opens on Info');
  });

  it('every bar lists its targets in DOM order (otherwise the highlight walks backwards)', () => {
    ['settNav', 'sysNav'].forEach((nav) => {
      const ids = navBlock(nav);
      const at = ids.map((id) => {
        const i = HTML.indexOf('id="' + id + '"');
        assert.ok(i > 0, nav + ' points at #' + id + ', which does not exist');
        return i;
      });
      assert.deepEqual(at.slice().sort((a, b) => a - b), at, nav + ': chip order and card order disagree');
    });
  });

  it('ICON-DUP: no two chips of one bar draw the same icon', () => {
    ['settNav', 'sysNav'].forEach((nav) => {
      const m = new RegExp('<nav class="sett-nav" id="' + nav + '">([\\s\\S]*?)</nav>').exec(HTML);
      const icons = [...m[1].matchAll(/data-ic="([^"]+)"/g)].map((x) => x[1]);
      assert.equal(new Set(icons).size, icons.length, nav + ' repeats an icon: ' + icons.join(', '));
    });
  });

  it('…and the icon it now uses exists in the table (an unknown name renders NOTHING)', () => {
    const navIcons = [...HTML.matchAll(/<nav class="sett-nav"[\s\S]*?<\/nav>/g)].join('');
    [...navIcons.matchAll(/data-ic="([^"]+)"/g)].map((m) => m[1]).forEach((name) => {
      assert.match(RENDER_SRC, new RegExp('^\\s{2}' + name + ':', 'm'), 'ICONS has no „' + name + '" — ic() returns an empty string for it');
    });
  });
});

// ====================================================================================================
// CO-CHECK / CORR-BTN / AUTO-RANK — three controls that looked wrong about what they are
// ====================================================================================================
describe('CO-CHECK — the class carries its own layout, not only inside two containers', () => {
  it('.co-check is styled as a class', () => {
    const rule = cssRule('.co-check');
    assert.ok(rule, '.co-check had NO rule of its own — six of its fifteen uses were unstyled <label>s');
    assert.match(rule, /display:\s*flex/);
    assert.match(rule, /cursor:\s*pointer/);
  });

  it('…and it is used outside the two containers that used to style it', () => {
    const outside = ['sec-guard', 'sec-subagents'].map((sec) => {
      const i = HTML.indexOf('id="' + sec + '"');
      const j = HTML.indexOf('</div>\n\n', i);
      return (HTML.slice(i, j).match(/class="co-check"/g) || []).length;
    });
    assert.ok(outside[0] > 0 && outside[1] > 0, 'if these cards stop using .co-check, the base rule above is no longer needed');
  });
});
describe('CORR-BTN — the correction button is not a browser-default button', () => {
  it('it declares its own surface', () => {
    const rule = cssRule('.corr-btn');
    assert.ok(rule, '.corr-btn rule missing');
    assert.match(rule, /background:/, 'without a background this <button> is ButtonFace — a bright box on a dark theme');
    assert.match(rule, /border:/);
    assert.ok(!/^\s*opacity:\s*\.55;\s*$/.test(rule), 'opacity alone was the whole rule, and that was the defect');
  });

  it('there is still no global button reset that would have covered it', () => {
    const src = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/(^|\})\s*button\s*\{/m.test(src), 'a global button rule would change this finding — recheck .corr-btn');
  });
});
describe('AUTO-RANK — the one run option that gives away every permission does not look like the rest', () => {
  it('it carries its own class and a glyph, not just a tooltip', () => {
    const src = noComments(UIS_SRC);
    assert.match(src, /'ui-check ui-check-risk'/, 'the auto-approve checkbox is ranked with the four harmless ones again');
    assert.match(src, /'⚠ ' \+ t\('views-uiskills\.freigabenAutomatischErlaubenAls'\)/, 'colour alone is not a signal (1.4.1)');
  });

  it('…and the class has a rule, so the markup is not decoration', () => {
    const rule = cssRule('.ui-check.ui-check-risk');
    assert.ok(rule, '.ui-check-risk has no stylesheet rule — the class would be a no-op');
    assert.match(rule, /var\(--warning/);
  });
});

// ====================================================================================================
// CAT-EMPTY — the options catalogue answered „no match" with a blank area
// ====================================================================================================
function loadCatalog(opts) {
  const calls = { empty: [], items: 0 };
  const field = { value: (opts && opts.q) || '' };
  const box = { innerHTML: '', appendChild: () => { calls.items++; } };
  const env = {
    $: (sel) => (sel === '#catList' ? box : sel === '#catSearch' ? field : null),
    STATE: { settings: { parsed: {} }, settingsLocal: { parsed: {} } },
    SETTINGS_REF: () => (opts && opts.ref) || [{ key: 'model', desc: 'das Modell', file: 'main', example: 'x' }],
    el: () => ({ appendChild: () => {} }),
    iconBtn: () => ({}),
    t: (k) => k,
    emptyFiltered: (c, reset, msg) => { calls.empty.push({ msg, reset }); },
    insertSetting: () => {},
  };
  const api = bundle([liftFn(VIEWS_SRC, 'renderCatalog', 'views.js')], ['renderCatalog'], env);
  return Object.assign(api, { calls, field });
}
describe('CAT-EMPTY — a search with no hits says so, and offers the way back', () => {
  it('no match → the shared empty state, naming the term', () => {
    const c = loadCatalog({ q: 'zzz' });
    c.renderCatalog();
    assert.equal(c.calls.empty.length, 1, 'a blank list under a filled search box reads as „broken", not as „no match"');
    assert.equal(c.calls.empty[0].msg, 'views.katalogKeinTreffer');
    assert.equal(c.calls.items, 0);
  });

  it('its reset clears the FIELD too — the field is the filter here', () => {
    const c = loadCatalog({ q: 'zzz' });
    c.renderCatalog();
    c.calls.empty[0].reset();
    assert.equal(c.field.value, '', 'resetting the list but keeping the text leaves the two contradicting each other');
  });

  it('a hit still renders rows and no empty state', () => {
    const c = loadCatalog({ q: 'model' });
    c.renderCatalog();
    assert.equal(c.calls.empty.length, 0);
    assert.ok(c.calls.items > 0);
  });
});

// ====================================================================================================
// RUN-SSE — a run's stream could die without a word
// ====================================================================================================
function loadRunSse(state) {
  const log = { status: [], msgs: [], events: [], reattached: 0, cleared: 0 };
  const run = Object.assign({
    skill: { name: 'demo' }, done: false, chatId: 'c1', timer: 7,
    es: { readyState: 2, close() { log.closed = true; } },
    tab: { msgEl: { appendChild: (n) => log.msgs.push(n) } },
  }, state || {});
  const env = {
    t: (k) => k,
    el: (tag, cls) => ({ tag, cls, textContent: '' }),
    uiRunStatus: (r, text, kind) => log.status.push({ text, kind }),
    uiRunReattach: () => { log.reattached++; },
    logEvent: (msg, kind) => log.events.push({ msg, kind }),
    clearInterval: () => { log.cleared++; },
  };
  const api = bundle([liftFn(UIS_SRC, 'uiRunStreamLost', 'views-uiskills.js')], ['uiRunStreamLost'], env);
  return { run, log, call: () => api.uiRunStreamLost(run) };
}
describe('RUN-SSE — the error channel of a run is not `() => {}` any more', () => {
  it('a TRANSIENT drop is left alone — EventSource retries by itself', () => {
    [0, 1].forEach((rs) => {
      const c = loadRunSse({ es: { readyState: rs, close() { c.log.closed = true; } } });
      c.call();
      assert.equal(c.log.status.length, 0, 'readyState ' + rs + ' is not a failure');
      assert.equal(c.log.reattached, 0);
      assert.ok(c.run.es, 'the stream must stay — closing it is what would break the retry');
    });
  });

  it('the FIRST fatal close is re-attached silently (usually a server restart)', () => {
    const c = loadRunSse();
    c.call();
    assert.equal(c.log.reattached, 1);
    assert.equal(c.log.status.length, 0, 'nothing to report yet — the reconnect may well work');
    assert.equal(c.run._reattached, true);
  });

  it('the SECOND one is reported — and does not claim the skill failed', () => {
    const c = loadRunSse({ _reattached: true });
    c.call();
    assert.deepEqual(c.log.status, [{ text: 'views-uiskills.verbindungVerloren', kind: 'error' }]);
    assert.equal(c.log.cleared, 1, 'the ticker must stop — a clock still counting up claims progress nobody can see');
    assert.equal(c.log.msgs.length, 1, 'the transcript gets the explanation, not just the dot');
    assert.equal(c.log.events.length, 1, 'and the 🔔 log, because the view may not be on screen');
    assert.equal(c.run.done, false, 'we do NOT know the run failed — „Stop" and a follow-up stay available');
  });

  it('a finished run closes its stream and says nothing', () => {
    const c = loadRunSse({ done: true });
    c.call();
    assert.equal(c.log.status.length, 0);
    assert.equal(c.log.reattached, 0);
    assert.equal(c.run.es, null);
  });

  it('both stream openings are wired to it — one unwired `onerror` is the whole defect back', () => {
    const src = noComments(UIS_SRC);
    assert.ok(!/onerror\s*=\s*\(\)\s*=>\s*\{\s*\}/.test(src), 'an empty onerror is a swallowed failure');
    assert.equal((src.match(/onerror = \(\) => uiRunStreamLost\(run\)/g) || []).length, 2,
      'views-uiskills.js opens the run stream twice (startUiRun + uiRunReattach) — both need the handler');
  });
});

// ====================================================================================================
// NUM-LOC / MONEY-0 — numbers in the browser's language, and „0,0000 €"
// ====================================================================================================
function loadFmt(lang) {
  return bundle([
    liftFn(RENDER_SRC, 'numLocale', 'render.js'), liftFn(RENDER_SRC, 'fmtInt', 'render.js'),
    liftFn(RENDER_SRC, 'fmtDec', 'render.js'), liftFn(RENDER_SRC, 'fmtPct', 'render.js'),
    liftFn(RENDER_SRC, 'fmtMoney', 'render.js'),
    liftFn(USAGE_SRC, 'fmtNum', 'views-usage.js'), liftFn(USAGE_SRC, 'fmtTok', 'views-usage.js'),
  ], ['numLocale', 'fmtInt', 'fmtDec', 'fmtPct', 'fmtMoney', 'fmtNum', 'fmtTok'], { LANG: lang, EUR_RATE: 0.92 });
}
describe('NUM-LOC — the panel formats numbers in the panel\'s language', () => {
  it('German: a dot groups thousands and a comma is the decimal mark', () => {
    const f = loadFmt('de');
    assert.equal(f.fmtInt(1234567), '1.234.567');
    assert.equal(f.fmtDec(1.5, 1), '1,5');
    assert.equal(f.fmtNum(1500), '1,5K', '„1.5K" reads as one-point-five in English and as 15 hundred in German');
    assert.equal(f.fmtTok(2500000), '2,50M', 'the DIGIT count is unchanged (two below 10M) — only the separator moves');
    assert.equal(f.fmtPct(63.45), '63,5 %', 'DIN 5008 puts a space before the sign');
  });

  it('English: the other way round, and no space before the percent sign', () => {
    const f = loadFmt('en');
    assert.equal(f.fmtInt(1234567), '1,234,567');
    assert.equal(f.fmtNum(1500), '1.5K');
    assert.equal(f.fmtPct(63.45), '63.5%');
  });

  it('no number in the panel asks toLocaleString for the BROWSER\'s locale any more', () => {
    // `new Date(x).toLocaleString()` is a DIFFERENT question and stays allowed: a wall-clock timestamp is
    // read in the operating system's format on purpose. This pattern matches the `value.toLocaleString()`
    // form, which is how both number sites were written (`m.tokens.toLocaleString()`).
    //
    // Every file under public/js, NOT a list of the seven that had the defect. verify.js argues against
    // hand-written suite lists for this exact reason: the list cannot know about the file added next week,
    // so it ages into a guard that passes because it never looked. Measured when this changed: 34 files.
    const offenders = [];
    BROWSER_FILES.forEach((rel) => {
      const src = noComments(read(rel));
      [...src.matchAll(/([A-Za-z_$][\w$.]*)\.toLocaleString\(\)/g)]
        .forEach((m) => { if (!/[Dd]ate/.test(m[1])) offenders.push(rel + ': ' + m[1]); });
    });
    assert.deepEqual(offenders, [], 'on an English Windows these print „1,234,567" into the German UI — use fmtInt/fmtDec');
  });

  it('the five percent displays of the usage view all go through fmtPct', () => {
    // The finding named FOUR and there are five: donut legend, KPI delta arrow, cache-hit tile, subagent
    // share, spend limit. Two wrote „ %" by hand, three wrote „%" — so the finding's own count was the
    // thing that was not checked. `fill.style.width = … + '%'` is a CSS length and MUST keep the dot;
    // those lines are excluded by name rather than by hoping the pattern misses them.
    const src = noComments(USAGE_SRC);
    const raw = src.split('\n')
      .map((l, i) => ({ n: i + 1, l }))
      .filter(({ l }) => /\+\s*'%'/.test(l) && !/style\.(width|left|top|height)|setAttribute\(|offset:/.test(l));
    assert.deepEqual(raw.map((r) => r.n + ': ' + r.l.trim().slice(0, 80)), [],
      'a visible percent built by hand prints „63.5%" into the German UI — use fmtPct(value, digits)');
    assert.equal((src.match(/fmtPct\(/g) || []).length, 5, 'five displays, five calls — one of them went missing');
  });
});
describe('MONEY-0 — a cost display may not say „free" and may not invent precision', () => {
  // Intl puts a NO-BREAK space before „€" — normalise it, or this file asserts an invisible character
  const sp = (s) => String(s).replace(/ /g, ' ');
  it('exactly zero prints as zero, without four decimals', () => {
    assert.equal(sp(loadFmt('de').fmtMoney(0)), '0 €', '„0,0000 €" was the finding: four decimals of nothing');
    assert.equal(sp(loadFmt('en').fmtMoney(0)), '$0');
  });

  it('a value that merely ROUNDS to zero says so instead of claiming nothing was spent', () => {
    assert.equal(sp(loadFmt('de').fmtMoney(0.00001)), '< 0,0001 €');
    assert.equal(sp(loadFmt('en').fmtMoney(0.00001)), '< $0.0001');
    // the boundary is the value that still rounds to the last printable digit
    assert.equal(sp(loadFmt('en').fmtMoney(0.00005)), '$0.0001', 'from here the real figure is printable');
  });

  it('ordinary amounts are unchanged — this fix may not move any number that was already right', () => {
    const en = loadFmt('en');
    assert.equal(sp(en.fmtMoney(12.5)), '$12.50');
    assert.equal(sp(en.fmtMoney(0.0025)), '$0.0025');
    assert.equal(sp(en.fmtMoney(1)), '$1.00');
    // German converts at EUR_RATE and keeps FOUR decimals below one unit — both as before
    assert.equal(sp(loadFmt('de').fmtMoney(1)), '0,9200 €');
    assert.equal(sp(loadFmt('de').fmtMoney(2)), '1,84 €');
  });
});

// ====================================================================================================
// RAW-KEY — „· tokens / day" next to buttons labelled „Tokens" and „Tag"
// ====================================================================================================
describe('RAW-KEY — the Verlauf card names what it shows in words, not in identifiers', () => {
  function loadLabel(lang) {
    const I18N = requireI18N();
    return bundle([liftFn(USAGE_SRC, 'usageViewLabel', 'views-usage.js')], ['usageViewLabel'],
      { t: (k) => (I18N[lang][k] == null ? k : I18N[lang][k]) });
  }
  it('German', () => {
    assert.equal(loadLabel('de').usageViewLabel('tokens', 'day'), 'Tokens / Tag');
    assert.equal(loadLabel('de').usageViewLabel('cost', 'month'), 'Kosten / Monat');
  });
  it('English', () => {
    assert.equal(loadLabel('en').usageViewLabel('messages', 'week'), 'Messages / Week');
  });
  it('an unknown value shows itself rather than a wrong word', () => {
    assert.equal(loadLabel('de').usageViewLabel('kittens', 'day'), 'kittens / Tag');
  });
  it('the card and the chart\'s accessible label both go through it', () => {
    const src = noComments(USAGE_SRC);
    assert.match(src, /usageViewLabel\(usageView\.metric, usageView\.group\)/, 'the only caller is the one that was printing the raw values');
    assert.ok(!/usageView\.metric \+ ' \/ ' \+ usageView\.group/.test(src), 'the raw concatenation is what showed „· tokens / day"');
    assert.equal((src.match(/tsLbl/g) || []).length, 3, 'one label, used by the card subtitle AND the chart label');
  });
  it('every metric/group the markup offers has a word here — a new segment must not reappear raw', () => {
    const I18N = requireI18N();
    const { usageViewLabel } = loadLabel('de');
    const seg = (id, attr) => {
      const m = new RegExp('<span class="seg" id="' + id + '">([\\s\\S]*?)</span>').exec(HTML);
      assert.ok(m, '#' + id + ' not found');
      return [...m[1].matchAll(new RegExp(attr + '="([^"]+)"', 'g'))].map((x) => x[1]);
    };
    seg('tsMetric', 'data-m').forEach((v) => assert.ok(Object.values(I18N.de).includes(usageViewLabel(v, 'day').split(' / ')[0]),
      'metric „' + v + '" has no translated label — it would print raw'));
    seg('tsGroup', 'data-g').forEach((v) => assert.ok(Object.values(I18N.de).includes(usageViewLabel('tokens', v).split(' / ')[1]),
      'grouping „' + v + '" has no translated label — it would print raw'));
  });
});

// ====================================================================================================
// SPEND-ERR — the 502 that arrived as „CDP evaluate timeout" and nothing else
// ====================================================================================================
describe('SPEND-ERR — every refusal of the spend refresh has a title AND a next step', () => {
  const { spendErrorHelp } = bundle([liftFn(USAGE_SRC, 'spendErrorHelp', 'views-usage.js')], ['spendErrorHelp'], {});
  it('the two codes that already had help still have it', () => {
    assert.equal(spendErrorHelp('cdp-unreachable').cmd, true);
    assert.equal(spendErrorHelp('auth').cmd, false);
    assert.ok(spendErrorHelp('auth').body);
  });

  it('the codes a reader actually meets are covered — including the unknown one', () => {
    ['fetch-failed', 'unexpected-payload', '', undefined, 'something-new'].forEach((code) => {
      const h = spendErrorHelp(code);
      assert.ok(h && h.title && h.body, 'no help for „' + code + '" — this is how „CDP evaluate timeout" became the whole message');
    });
  });

  it('every key it names exists in both languages', () => {
    const I18N = requireI18N();
    ['cdp-unreachable', 'auth', 'unexpected-payload', 'fetch-failed'].forEach((code) => {
      const h = spendErrorHelp(code);
      ['title', 'body'].forEach((part) => {
        assert.ok(I18N.de[h[part]], 'missing de: ' + h[part]);
        assert.ok(I18N.en[h[part]], 'missing en: ' + h[part]);
      });
    });
  });

  it('the card asks this function and keeps the technical sentence as a DETAIL', () => {
    const src = noComments(USAGE_SRC);
    assert.match(src, /spendErrorHelp\(err\.error\)/, 'renderSpend must use the mapping, not its own ternary');
    assert.match(src, /'spend-err-detail'/, 'the raw message is still needed when someone asks for help — just not as the title');
    assert.ok(cssRule('.spend-err-detail'), '.spend-err-detail has no rule');
  });
});

// ====================================================================================================
// SCHED-1, the READER half — reactivating an old schedule showed the bare English server sentence
// ====================================================================================================
describe('SCHED-1 — the schedule refusals read like the dialog, wherever they surface', () => {
  const loadReader = (lang) => bundle([
    liftFn(RENDER_SRC, 'apiErrorText', 'render.js'),
  ], ['apiErrorText'], { t: (k) => { const I = requireI18N(); const v = I[lang][k]; assert.ok(v, 'no ' + lang + ' value for ' + k); return v; },
    cliMissingText: () => 'x', SCHED_NO_WEEKDAY: 'daily needs at least one weekday' });

  it('the Pausieren/Aktivieren button no longer shows „invalid timing: daily needs at least one weekday"', () => {
    // The route refuses switching a pre-guard schedule back ON (data-guards-routes.test.js pins that), and
    // the button turns a 400 into toast(e.message) — so the route's English sentence WAS the whole message.
    for (const lang of ['de', 'en']) {
      const txt = loadReader(lang).apiErrorText({ code: 'bad-timing', error: 'invalid timing: daily needs at least one weekday' }, 'Bad Request');
      assert.ok(!/invalid timing/.test(txt), lang + ': the raw server sentence is still the message — ' + txt);
      assert.ok(txt.length > 30, lang + ': that is not an explanation — ' + txt);
    }
  });

  it('the OTHER three bad-timing refusals get the class, not a sentence about weekdays', () => {
    // `bad-timing` covers four server refusals. Claiming „no weekday selected" for a broken HH:MM would be
    // the same defect one layer down: a message nobody checked against the cause.
    const r = loadReader('de');
    for (const error of ['invalid timing: daily needs time as HH:MM', 'invalid timing: timing type must be interval or daily', 'invalid timing: daily days must be an array']) {
      const txt = r.apiErrorText({ code: 'bad-timing', error }, 'Bad Request');
      assert.ok(!/Wochentag gewählt/.test(txt), 'claims a missing weekday for „' + error + '"');
      assert.ok(txt.includes(error), 'the technical sentence is dropped — SPEND-ERR keeps it as a detail: ' + txt);
    }
  });

  it('a missing required field names the fields the ROUTE sent', () => {
    const txt = loadReader('de').apiErrorText({ code: 'missing-required', error: 'required inputs missing: thema', fields: ['thema', 'werk'] }, 'Bad Request');
    assert.match(txt, /thema, werk/, 'the field list is what makes this actionable');
    assert.ok(!/required inputs missing/.test(txt), 'still the raw sentence: ' + txt);
  });

  it('the string it matches on is the one lib/pure.js produces — pinned, so the match cannot rot', () => {
    // The reader distinguishes the weekday case by the server's own wording. That is only safe while the
    // wording is pinned: rename it in lib/pure.js and this fails instead of the message quietly degrading
    // to the generic branch.
    const { normalizeScheduleTiming } = require('../lib/pure');
    const out = normalizeScheduleTiming({ type: 'daily', time: '03:00', days: [] });
    assert.equal(out.error, 'daily needs at least one weekday');
    assert.match(RENDER_SRC, /const SCHED_NO_WEEKDAY = 'daily needs at least one weekday'/,
      'render.js must match on exactly the string lib/pure.js returns');
  });

  it('…and the unchanged codes still read as before', () => {
    const r = loadReader('de');
    assert.equal(r.apiErrorText({ code: 'shutting-down' }, 'x'), requireI18N().de['render.panelFaehrtHerunter']);
    assert.equal(r.apiErrorText({ error: 'plain' }, 'x'), 'plain', 'an uncoded error still shows itself');
    assert.equal(r.apiErrorText(null, 'Bad Request'), 'Bad Request');
  });

  // CHAT-FLOW-4 — every place that toasts e.message (a deferred restart, a UI-skill follow-up) meets the
  // start route's refusal; the server's English „session open elsewhere" is not a sentence for the reader
  it('a resume refused because another tab or window holds the session reads as that, in both languages', () => {
    for (const lang of ['de', 'en']) {
      assert.equal(loadReader(lang).apiErrorText({ code: 'session-open-elsewhere', error: 'session open elsewhere', busy: false }, 'Conflict'),
        requireI18N()[lang]['render.sitzungAnderswoOffen']);
    }
  });
});

// ====================================================================================================
// SELECT-NAME — dropdowns whose visible label names nothing
// ====================================================================================================
describe('SELECT-NAME — every select has an accessible name', () => {
  // the same reading the measurement used: aria-label, aria-labelledby, or an enclosing <label>
  function selects() {
    const lines = HTML.split(/\r?\n/);
    const out = [];
    lines.forEach((l, i) => {
      let m; const re = /<select\b([^>]*)>/g;
      while ((m = re.exec(l))) {
        const upto = lines.slice(0, i).join('\n') + '\n' + l.slice(0, m.index);
        const opens = (upto.match(/<label\b/g) || []).length;
        const closes = (upto.match(/<\/label>/g) || []).length;
        out.push({
          line: i + 1, id: (m[1].match(/id="([^"]+)"/) || [])[1] || '(no id)',
          named: /aria-label=/.test(m[1]) || /aria-labelledby=/.test(m[1]) || opens > closes,
        });
      }
    });
    return out;
  }

  it('in index.html — all of them', () => {
    const all = selects();
    assert.ok(all.length >= 13, 'expected at least the 13 selects measured on 2026-10-03, found ' + all.length);
    const nameless = all.filter((s) => !s.named).map((s) => s.id + '@' + s.line);
    assert.deepEqual(nameless, [], 'a select with only a `title` is named by its tooltip, and #hookEvent had nothing at all');
  });

  it('the three in the chat bar name themselves SHORT, not with their tooltip sentence', () => {
    const permMode = /<select id="permMode"[^>]*>/.exec(HTML);
    assert.ok(permMode, '#permMode not found');
    assert.match(permMode[0], /aria-label="Berechtigungsmodus"/, 'the tooltip explains; the aria-label names');
    assert.match(permMode[0], /data-i18n-aria="html\.berechtigungsmodus"/, 'and it has to survive a language switch');
  });

  it('every data-i18n-aria key resolves (a typo here produces a raw key as the NAME)', () => {
    const I18N = requireI18N();
    [...HTML.matchAll(/data-i18n-aria="([^"]+)"/g)].map((m) => m[1]).forEach((k) => {
      assert.ok(I18N.de[k] && I18N.en[k], 'data-i18n-aria="' + k + '" has no entry in both locales');
    });
  });

  it('the dynamically built skill form names its controls from the label beside them', () => {
    const env = {};
    const { ubLabel } = bundle([liftFn(UIS_SRC, 'ubLabel', 'views-uiskills.js')], ['ubLabel'], env);
    const mk = (tagName) => { const a = {}; return { tagName, attrs: a, setAttribute: (k, v) => { a[k] = v; }, getAttribute: (k) => a[k] }; };
    assert.equal(ubLabel(mk('SELECT'), 'Transport').attrs['aria-label'], 'Transport');
    const own = mk('SELECT'); own.attrs['aria-label'] = 'mine';
    assert.equal(ubLabel(own, 'Transport').attrs['aria-label'], 'mine', 'an explicit name wins');
    assert.doesNotThrow(() => ubLabel(null, 'x'));
  });

  it('a row whose target is NOT a control gets a role, because a bare name on a <div> is not exposed', () => {
    // The weekday group of the schedule form is the one such row (1 of the 30): `ubRow(…wochentage,
    // daysWrap)` hands in a plain <div> of buttons. `aria-label` on a generic element is not reliably
    // exposed, so that group stayed unnamed while every other row was fixed — a real accessibility
    // defect behind a passing guard. `role="group"` is what makes the name count.
    const { ubLabel } = bundle([liftFn(UIS_SRC, 'ubLabel', 'views-uiskills.js')], ['ubLabel'], {});
    const mk = (tagName) => { const a = {}; return { tagName, attrs: a, setAttribute: (k, v) => { a[k] = v; }, getAttribute: (k) => a[k] }; };
    const div = ubLabel(mk('DIV'), 'Wochentage');
    assert.equal(div.attrs['aria-label'], 'Wochentage');
    assert.equal(div.attrs.role, 'group', 'a <div> needs a role before its name is announced at all');
    for (const tag of ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']) {
      assert.equal(ubLabel(mk(tag), 'x').attrs.role, undefined, tag + ' is already a named control — a role would MIS-state it');
    }
    const own = mk('DIV'); own.attrs.role = 'radiogroup';
    assert.equal(ubLabel(own, 'x').attrs.role, 'radiogroup', 'an explicit role wins, same rule as the name');
  });

  it('…and both builders route through it', () => {
    const src = noComments(UIS_SRC);
    assert.match(src, /r\.appendChild\(ubLabel\(control, label\)\)/, 'ubRow builds 30 rows whose label names nothing without this');
    assert.match(src, /\.forEach\(\(c\) => ubLabel\(c, \(input\.label \|\| input\.id\)/, 'buildInput covers every manifest field type');
  });

  it('the row helper is called 30 times — the comment above it says so, and both are counted here', () => {
    // Ungenauigkeit #2 of the review: the comment claimed 30. `ubRow(` occurs 30× in the file and one of
    // them is the definition, so 29 was the call-site count — 30 since P3's „Projekt (nur Etikett)" row in the schedule form. Counted from the source with comments stripped,
    // because a comment that happens to contain the token would otherwise inflate exactly this number.
    const src = noComments(UIS_SRC);
    const total = (src.match(/ubRow\(/g) || []).length;
    const defs = (src.match(/^function ubRow\(/gm) || []).length;
    assert.equal(defs, 1, 'one definition expected');
    assert.equal(total - defs, 30, 'the call-site count moved — then the comment above ubLabel is stale too');
    assert.match(UIS_SRC, /is CALLED from 30 places/, 'the comment has to carry the number this test counts');
  });
});

// ====================================================================================================
// MEM-LINK / MEM-SORT — the memory view ignored the link form the CLI actually writes
// ====================================================================================================
const LINK_CASES = [
  // [markdown, expected targets] — the first case is MEMORY.md as the CLI writes it
  ['- [sap-adt MCP limits](sap-adt-mcp-limits.md) — what the server can do', ['sap-adt-mcp-limits']],
  ['[](x.md)', ['x'], 'an EMPTY link text is still a link — the target is what counts'],
  ['see [[wiki-target]] please', ['wiki-target'], 'the old form keeps working'],
  ['[a](one.md) and [[one]] again', ['one'], 'de-duplicated across both forms'],
  ['[A](Mixed.md) [b](mixed.md)', ['Mixed'], 'case-insensitive de-dup, first spelling kept'],
  ['[ext](https://example.com/x.md)', [], 'a URL is not a memory file'],
  ['[m](mailto:a@b.c)', [], 'nor a mail link'],
  ['[up](../other.md)', [], 'nor another directory'],
  ['[sub](dir/x.md)', [], 'nor a subdirectory'],
  ['[win](C:\\tmp\\x.md)', [], 'nor an absolute Windows path'],
  ['[frag](#section)', [], 'a fragment points inside this file'],
  ['[both](x.md#top)', ['x'], 'a fragment on a file still names the file'],
  ['[no ext](plain)', ['plain'], 'the .md is optional — resolveMemLink strips it either way'],
  ['nothing here at all', []],
];
describe('MEM-LINK — both link forms, one rule, two runtimes', () => {
  const { memoryLinkTargets: browserMemoryLinks } = bundle(
    [liftFn(MEM_SRC, 'memoryLinkTargets', 'views-memory.js')], ['memoryLinkTargets'], {});

  LINK_CASES.forEach(([md, want, why]) => {
    it('server: ' + JSON.stringify(md).slice(0, 56) + (why ? ' — ' + why : ''), () => {
      assert.deepEqual(serverMemoryLinks(md), want);
    });
  });

  it('the browser mirror answers identically on every case — it cannot require the server module', () => {
    LINK_CASES.forEach(([md, want]) => {
      assert.deepEqual(browserMemoryLinks(md), want, 'drifted on: ' + md);
    });
  });

  it('the server reader uses it (the 🔗 count, the backlinks and the graph all read `links`)', () => {
    const src = noComments(read('lib/skills.js'));
    assert.match(src, /links: memoryLinkTargets\(content\)/);
    assert.ok(!/matchAll\(\/\\\[\\\[/.test(src), 'the old wiki-only regex is gone from listMemory');
  });

  it('the preview turns a Markdown link into the same in-panel jump, instead of navigating away', () => {
    const src = noComments(liftFn(MEM_SRC, 'renderMemPreview', 'views-memory.js'));
    assert.match(src, /querySelectorAll\('a\[href\]'\)/, 'renderMarkdown emits real <a href="x.md"> — left alone they leave the panel');
    assert.match(src, /openMemory\(project, found\.name\)/);
    assert.match(src, /memoryLinkTargets\(/, 'the same rule decides what counts as a memory link');
  });
});
describe('MEM-SORT — the project groups come out in a readable order', () => {
  it('sorted by the path that is PRINTED, not by the encoded directory name', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-mem-'));
    try {
      // readdir order is „aaa, zzz"; the paths they print are the other way round
      const mk = (dir, cwd, body) => {
        const d = path.join(root, 'projects', dir);
        fs.mkdirSync(path.join(d, 'memory'), { recursive: true });
        fs.writeFileSync(path.join(d, 's.jsonl'), JSON.stringify({ cwd }) + '\n');
        fs.writeFileSync(path.join(d, 'memory', 'MEMORY.md'), body);
      };
      mk('aaa', 'Z:\\zulu', '- [one](one.md)\n');
      mk('zzz', 'A:\\alpha', '- [two](two.md)\n');
      // lib/paths reads the seam once, at require time → set it before the first require of this module
      process.env.CLAUDE_UI_CLAUDE_DIR = root;
      delete require.cache[require.resolve('../lib/paths')];
      delete require.cache[require.resolve('../lib/core')];
      delete require.cache[require.resolve('../lib/skills')];
      const { listMemory } = require('../lib/skills');
      const groups = await listMemory();
      assert.deepEqual(groups.map((g) => g.projectPath), ['A:\\alpha', 'Z:\\zulu'],
        'readdir order („aaa" first) is not the order the list shows');
      // and the link form the CLI writes arrived as a link
      assert.deepEqual(groups[0].files[0].links, ['two']);
    } finally {
      delete process.env.CLAUDE_UI_CLAUDE_DIR;
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});
