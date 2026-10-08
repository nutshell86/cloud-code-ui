'use strict';
// A13 — the prompt history's decisions: what a CLI history line means, what gets stored for a panel
// prompt, and how the two lists become one. All pure, so none of this needs a file on disk.
//
// The CLI lines below are REAL shapes from ~/.claude/history.jsonl (2.1.285), including the two that
// caused the design: a paste entry (whose payload must never leave the server) and the TUI's own
// "[Pasted text #1 +6 lines]" placeholder, which is the proof that this file is terminal-only — the
// panel expands its paste chips before sending and can never produce that text.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCliHistoryLine, parseCliHistory, appendPanelPrompt, mergeHistory } = require('../lib/history');

const LINE_PLAIN = '{"display":"/effort","pastedContents":{},"timestamp":1790773572007,"project":"C:\\\\WINDOWS\\\\system32","sessionId":"70a51853-d85a-489a-8f00-68e1a6ab9325"}';
const LINE_PASTE = '{"display":"[Pasted text #1 +9 lines]","pastedContents":{"1":{"id":1,"type":"text","content":"SECRET-TOKEN-abc123\\nline2"}},"timestamp":1790000000000,"project":"C:\\\\x","sessionId":"s2"}';

test('parseCliHistoryLine: the measured shape, and the paste payload stays behind', () => {
  const e = parseCliHistoryLine(LINE_PLAIN);
  assert.deepEqual(e, {
    text: '/effort', ts: 1790773572007, project: 'C:\\WINDOWS\\system32',
    sessionId: '70a51853-d85a-489a-8f00-68e1a6ab9325', pastes: 0, source: 'cli',
  });
  const p = parseCliHistoryLine(LINE_PASTE);
  assert.equal(p.pastes, 1, 'the UI must be able to SAY a paste belonged to it');
  // the whole reason pastedContents is not carried over: these blocks hold whatever was on the clipboard
  assert.ok(!JSON.stringify(p).includes('SECRET-TOKEN'), 'pasted content must not reach the browser');
});

test('parseCliHistoryLine: a torn or empty line is skipped, never fatal', () => {
  for (const bad of ['', '   ', '{not json', '{}', '{"display":"   "}', 'null', '[]']) {
    assert.equal(parseCliHistoryLine(bad), null, JSON.stringify(bad));
  }
});

test('parseCliHistory: newest first and capped, whatever order the file is in', () => {
  const text = [LINE_PASTE, 'garbage', '', LINE_PLAIN].join('\n');
  const list = parseCliHistory(text);
  assert.equal(list.length, 2, 'the unparseable line is dropped, not counted');
  assert.equal(list[0].text, '/effort', 'newest first — the file order is not authoritative (the CLI rewrites it when it prunes)');
  assert.equal(parseCliHistory(text, 1).length, 1);
  assert.deepEqual(parseCliHistory(''), []);
  assert.deepEqual(parseCliHistory(null), []);
});

test('appendPanelPrompt: re-sending the same prompt refreshes it instead of doubling it', () => {
  let l = appendPanelPrompt([], { text: 'eins', ts: 1000, project: 'C:/a', sessionId: 's', model: 'm' });
  l = appendPanelPrompt(l, { text: 'eins', ts: 2000 });
  assert.equal(l.length, 1, 'you re-sent it, you did not write it twice');
  assert.equal(l[0].ts, 2000, 'but it IS more recent now');
  assert.equal(l[0].project, 'C:/a', 'and it keeps the metadata it had');
  l = appendPanelPrompt(l, { text: 'zwei', ts: 3000 });
  assert.deepEqual(l.map((x) => x.text), ['eins', 'zwei'], 'append order = reads like a log');
  // …but a prompt that comes back LATER is a new entry, not a merge: only the direct repeat is folded
  l = appendPanelPrompt(l, { text: 'eins', ts: 4000 });
  assert.equal(l.length, 3);
});

test('appendPanelPrompt: caps on entries and on a pasted wall of text', () => {
  let l = [];
  for (let i = 0; i < 12; i++) l = appendPanelPrompt(l, { text: 'p' + i, ts: i }, { entries: 5 });
  assert.equal(l.length, 5);
  assert.equal(l[0].text, 'p7', 'the OLDEST entries are the ones that go');
  const long = appendPanelPrompt([], { text: 'x'.repeat(50) }, { chars: 10 })[0].text;
  assert.equal(long.length, 11, '10 chars + the ellipsis that says it was cut');
  assert.ok(long.endsWith('…'));
  // empty input must not create a row (the composer already filters, this is the sink)
  assert.deepEqual(appendPanelPrompt([], { text: '   ' }), []);
});

test('mergeHistory: one row per prompt text, newest metadata, both source marks', () => {
  const cli = [{ text: 'gleicher prompt', ts: 1000, project: 'C:/term', sessionId: 'c1', pastes: 0 }];
  const panel = [{ text: 'gleicher prompt', ts: 5000, project: 'C:/panel', sessionId: 'p1', model: 'sonnet' }];
  const r = mergeHistory(cli, panel, {});
  assert.equal(r.items.length, 1, 'the same prompt from both sources is ONE row');
  assert.deepEqual(r.items[0].sources.sort(), ['cli', 'panel']);
  assert.equal(r.items[0].ts, 5000);
  assert.equal(r.items[0].project, 'C:/panel', 'the most recent use owns the metadata');
  assert.equal(r.items[0].model, 'sonnet');
});

test('mergeHistory: sorted newest first, filtered case-insensitively, capped with a truthful flag', () => {
  const panel = [
    { text: 'ABAP Klasse lesen', ts: 3000 },
    { text: 'jira ticket kopieren', ts: 2000 },
    { text: 'abap unit laufen lassen', ts: 1000 },
  ];
  const all = mergeHistory([], panel, {});
  assert.deepEqual(all.items.map((i) => i.ts), [3000, 2000, 1000]);
  assert.equal(all.truncated, false);

  const q = mergeHistory([], panel, { q: 'AbAp' });
  assert.deepEqual(q.items.map((i) => i.ts), [3000, 1000], 'a query is not a token');
  assert.equal(q.total, 2);

  const cut = mergeHistory([], panel, { limit: 2 });
  assert.equal(cut.items.length, 2);
  assert.equal(cut.total, 3, 'total is what MATCHED, so the UI can say „3 Treffer, gekürzt"');
  assert.equal(cut.truncated, true);
});

test('mergeHistory: garbage in either source is ignored, never thrown on', () => {
  const r = mergeHistory(null, [{ text: '' }, null, { ts: 5 }, { text: 'ok', ts: 1 }], {});
  assert.deepEqual(r.items.map((i) => i.text), ['ok']);
  assert.equal(mergeHistory('nope', 'also nope', {}).items.length, 0);
});
