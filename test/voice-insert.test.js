'use strict';
// Voice input: a final segment goes in at the caret, exactly once; the interim text stays out of the field.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { voiceSplit, voiceJoin } = require('../public/js/voice-insert.js');

// the browser path in one line: insert over [s, e) with voiceJoin's spacing, caret after the words
function insert(v, s, e, text) {
  const j = voiceJoin(v.slice(0, s), text, v.slice(e));
  return { value: v.slice(0, s) + j.text + v.slice(e), caret: s + j.caret };
}
const res = (...xs) => xs.map(([text, isFinal]) => ({ isFinal, 0: { transcript: text } }));

describe('voiceJoin — the segment lands where the caret is, with sane spacing', () => {
  it('into an empty field: no padding at all', () => {
    assert.deepEqual(insert('', 0, 0, ' hallo welt '), { value: 'hallo welt', caret: 10 });
  });
  it('in the MIDDLE of typed text, both sides kept and spaced', () => {
    const v = 'Bitte prüfeZ_EXAMPLE';
    assert.equal(insert(v, 11, 11, 'die Klasse').value, 'Bitte prüfe die Klasse Z_EXAMPLE');
  });
  it('at the end, after a space: no double space', () => {
    assert.equal(insert('Hallo ', 6, 6, 'Welt').value, 'Hallo Welt');
  });
  it('at the start: a space behind, none in front', () => {
    assert.equal(insert('Welt', 0, 0, 'Hallo').value, 'Hallo Welt');
  });
  it('over a SELECTION: the selection is replaced, nothing else', () => {
    assert.equal(insert('eins zwei drei', 5, 9, 'vier').value, 'eins vier drei');
  });
  it('punctuation and brackets: no space before „.", none after „("', () => {
    assert.equal(insert('fertig', 6, 6, '. Danke').value, 'fertig. Danke');
    assert.equal(insert('siehe (', 7, 7, 'Anhang').value, 'siehe (Anhang');
    assert.equal(insert('A B', 1, 1, 'x').value, 'A x B');
    assert.equal(insert('Wort,', 4, 4, 'mehr').value, 'Wort mehr,');
  });
  it('the caret sits right after the dictated words — the next segment follows them', () => {
    let r = insert('Anfang Ende', 7, 7, 'Mitte');
    assert.equal(r.value, 'Anfang Mitte Ende');
    r = insert(r.value, r.caret, r.caret, 'und mehr');
    assert.equal(r.value, 'Anfang Mitte und mehr Ende');
  });
  it('an empty segment changes nothing', () => {
    assert.deepEqual(voiceJoin('abc', '   ', 'def'), { text: '', caret: 0 });
  });
});

describe('voiceSplit — finals once, interim apart', () => {
  it('separates final from interim', () => {
    const sp = voiceSplit(res(['hallo', true], [' wel', false]), 0, -1);
    assert.deepEqual(sp.finals, [{ i: 0, text: 'hallo' }]);
    assert.equal(sp.interim, 'wel');
  });
  it('a final the engine delivers again (same index) is not inserted twice', () => {
    const r = res(['hallo', true], [' welt', true]);
    const a = voiceSplit(r, 0, -1);
    assert.equal(a.finals.length, 2);
    const b = voiceSplit(r, 0, 1);
    assert.equal(b.finals.length, 0, 'everything up to doneIdx is already in the field');
  });
  it('starts at resultIndex — earlier results are not looked at', () => {
    const sp = voiceSplit(res(['alt', true], ['neu', true]), 1, -1);
    assert.deepEqual(sp.finals.map((x) => x.text), ['neu']);
  });
  it('empty or missing results are harmless', () => {
    assert.deepEqual(voiceSplit(null, 0, -1), { finals: [], interim: '' });
    assert.deepEqual(voiceSplit(res(['  ', true]), 0, -1).finals, []);
  });
});

describe('wiring — the handler no longer rewrites the whole field', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat-composer.js'), 'utf8');
  const a = SRC.indexOf('// --- voice input'), b = SRC.indexOf('// --- prompt enhancer');
  const voice = SRC.slice(a, b);
  it('no frozen base text, no `composer.value =` in the voice block', () => {
    assert.ok(a >= 0 && b > a, 'voice block not found');
    assert.doesNotMatch(voice, /baseText/);
    assert.doesNotMatch(voice, /composer\.value\s*=[^=]/);
    assert.match(voice, /voiceSplit\(/);
    assert.match(voice, /voiceJoin\(/);
  });
  it('a tab switch ends the dictation', () => {
    const chat = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');
    assert.match(chat, /prevActive !== t && typeof stopVoiceInput === 'function'\) stopVoiceInput\(\)/);
  });
  it('sending the composer text ends the dictation — a send the panel makes by itself does not', () => {
    const a2 = SRC.indexOf('async function sendMessage('), b2 = SRC.indexOf('const open = ', a2);
    assert.ok(a2 >= 0 && b2 > a2, 'sendMessage head not found');
    assert.match(SRC.slice(a2, b2), /if \(fromComposer && typeof stopVoiceInput === 'function'\) stopVoiceInput\(\);/);
  });
  it('the preview element and the pure module are in the page, the module before chat-composer.js', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.match(html, /id="voicePreview"[^>]*aria-live="polite"/);
    const i = html.indexOf('/js/voice-insert.js'), j = html.indexOf('/js/chat-composer.js');
    assert.ok(i > 0 && j > i);
  });
});
