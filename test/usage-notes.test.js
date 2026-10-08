'use strict';
// The two places where PR-4's numbers have to SAY something, in both languages.
//
// M1 — the fold's error counters. lib/core.js foldLines wraps the per-line callback in `try {} catch {}`
// ("a bad line must not kill the scan"), so a defect inside the fold is swallowed and the panel reports a
// plausible-looking 0 (one measurement run did exactly that). scanUsage carries foldErrors / parseErrors /
// foldError for that reason — and nothing rendered them, which made the counter as silent as the exception
// it was supposed to replace. A fold error is the most expensive kind of wrong number: every figure above
// it still looks right.
//
// M4 — the „davon Subagenten" tooltip had its unit hardcoded as German „Tokens", in the English UI too.
//
// Both live in browser scripts (no exports, they need the whole app's globals), so the two functions that
// decide what the view SAYS are lifted out of the source BY NAME and run against fake globals — the same
// seam test/agent-lanes.test.js uses for chat-render.js. That way the wiring itself is under test, not a
// copy of it.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'public', 'js');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

// The REAL dictionary, not a stub: a key that exists only in `de` is the bug this file is here to catch.
const I18N = new Function(read('i18n.js') + '\nreturn I18N;')();
// render.js's t() falls back to I18N.de when a key is missing in the active language, so a forgotten
// English string shows up as German instead of as a failure. This t() does NOT forgive that.
function strictT(lang) {
  return (key) => {
    const v = I18N[lang] && I18N[lang][key];
    assert.ok(v != null, 'i18n key "' + key + '" is missing in I18N.' + lang);
    return v;
  };
}
function loadFn(file, name, env) {
  const src = read(file);
  const m = src.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
  assert.ok(m, name + '() not found in public/js/' + file + ' — renamed or reindented?');
  const names = Object.keys(env);
  return new Function(...names, m[0] + '\nreturn ' + name + ';')(...names.map((k) => env[k]));
}
// the few globals these two functions touch, shaped like render.js's but trivially predictable
const fmtNum = (n) => String(Number(n) || 0);
const fmtTok = (n) => String(Number(n) || 0) + 'tok';
const fmtUSD = (n) => '$' + (Number(n) || 0).toFixed(2);
// fmtPct (render.js) since NUM-LOC: the subagent share is formatted in the PANEL's language and carries the
// German spacing before the sign. Stubbed as predictably as the three above.
const fmtPct = (n, d) => (Number(n) || 0).toFixed(d == null ? 1 : d) + ' %';
const notesFor = (lang, j) => loadFn('views-usage.js', 'usageNotes', { t: strictT(lang), fmtUSD, fmtTok, fmtPct })(j, 1000);
const tooltipFor = (lang, agents) => loadFn('sessions.js', 'subAgentTooltip', { t: strictT(lang), fmtNum })(agents);

// a clean /api/usage payload: no errors, no unpriced tokens, no subagents
const clean = () => ({
  total: { subTokens: 0, subCost: 0, agentFiles: 0 },
  unpricedTokens: 0, unpricedModels: [], undatedMessages: 0,
  foldErrors: 0, parseErrors: 0, foldError: '',
});

describe('Usage view — a fold error must become VISIBLE (M1)', () => {
  it('says nothing about errors when there are none', () => {
    for (const lang of ['de', 'en']) {
      const notes = notesFor(lang, clean());
      assert.equal(notes.length, 1, lang + ': only the provenance note belongs under a clean scan');
      assert.ok(!/⚠/.test(notes.join(' ')), lang + ': a clean scan must not cry wolf');
    }
  });

  it('names the count AND the first exception message — in de and en', () => {
    const j = Object.assign(clean(), { foldErrors: 12, foldError: 'rec.d[day] is undefined' });
    for (const lang of ['de', 'en']) {
      const notes = notesFor(lang, j);
      const first = notes[0];
      assert.match(first, /⚠/, lang + ': the fold error does not lead the footnote');
      assert.match(first, /\b12\b/, lang + ': the number of failed lines is not shown');
      assert.match(first, /rec\.d\[day\] is undefined/, lang + ': "12 lines failed" without a reason is not actionable');
      assert.ok(!/\{n\}|\{msg\}/.test(first), lang + ': an unsubstituted placeholder reached the screen: ' + first);
    }
    // and the two languages really are two languages, not one string served twice
    assert.notEqual(notesFor('de', j)[0], notesFor('en', j)[0], 'the English footnote is the German one');
    assert.match(notesFor('en', j)[0], /incomplete/);
  });

  it('reports malformed JSON lines separately from a failed fold', () => {
    const notes = notesFor('en', Object.assign(clean(), { parseErrors: 3 }));
    assert.match(notes[0], /\b3\b.*JSON/, 'a line that is not JSON is a different failure from a throwing fold');
    assert.ok(!/⚠/.test(notes[0]), 'a trailing half-written line is not an alarm');
  });

  it('keeps the footnotes that already existed, and keeps them in order', () => {
    const j = Object.assign(clean(), {
      foldErrors: 1, foldError: 'boom', parseErrors: 2, undatedMessages: 4,
      unpricedTokens: 500, unpricedModels: ['claude-opus-5-5'],
      total: { subTokens: 400, subCost: 1.5, agentFiles: 2 },
    });
    const notes = notesFor('de', j);
    assert.equal(notes.length, 6, 'fold · parse · subagents · unpriced · undated · provenance — one is missing');
    assert.match(notes[0], /⚠/, 'the fold error must qualify everything below it, so it goes first');
    assert.match(notes[2], /400tok/, 'the subagent share');
    assert.match(notes[3], /claude-opus-5-5/, 'the unpriced footnote');
    assert.match(notes[4], /4/, 'the undated calls');
  });
});

describe('Session detail — the subagent tooltip is translated (M4)', () => {
  const agents = [{ agentId: 'agent-aaa111', wf: '', tokens: 1234 }, { agentId: 'agent-bbb222', wf: 'wf_7', tokens: 9 }];

  it('names every agent transcript, with its workflow where there is one', () => {
    const lines = tooltipFor('de', agents).split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^agent-aaa111: 1234 /);
    assert.match(lines[1], /^agent-bbb222 \(wf_7\): 9 /);
  });

  it('the UNIT comes from i18n, not from a German literal in the source', () => {
    assert.equal(tooltipFor('de', agents).split('\n')[1], 'agent-bbb222 (wf_7): 9 Tokens');
    assert.equal(tooltipFor('en', agents).split('\n')[1], 'agent-bbb222 (wf_7): 9 tokens',
      'the English tooltip still says the German „Tokens" — the literal was never routed through t()');
    assert.ok(!/\{n\}/.test(tooltipFor('en', agents)), 'an unsubstituted placeholder reached the tooltip');
  });

  it('a session without agent transcripts gets an empty tooltip, never the string "undefined"', () => {
    assert.equal(tooltipFor('en', undefined), '');
    assert.equal(tooltipFor('en', []), '');
  });
});
