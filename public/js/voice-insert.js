'use strict';
// Voice input — which recognised text goes where. Browser (classic script) AND Node (require'd by the tests).
// Dependency-free and side-effect-free; no t()/DOM here.
//
// The old handler froze the composer text at the moment 🎤 was pressed and, on EVERY recognition step,
// wrote `that frozen text + everything recognised so far` back into the field. Whatever was typed or
// corrected while listening was gone at the next step, and the dictation always landed at the end, never at
// the caret. Now only FINAL segments touch the field — each exactly once, at the caret — and the text that is
// still being recognised is shown next to the field (#voicePreview), never in it.

// The new final segments since `doneIdx` and the interim text. `results` is a SpeechRecognitionResultList
// or an array shaped like one: [{ isFinal, 0: { transcript } }, …]. `resultIndex` is the event's own
// „first changed result"; `doneIdx` is the highest index already inserted (-1 at the start), so a final
// result the engine re-delivers is never inserted twice.
function voiceSplit(results, resultIndex, doneIdx) {
  const finals = [];
  let interim = '';
  const n = results ? results.length : 0;
  for (let i = Math.max(0, resultIndex | 0); i < n; i++) {
    const r = results[i];
    if (!r) continue;
    const text = String((r[0] && r[0].transcript) || '');
    if (r.isFinal) { if (i > doneIdx && text.trim()) finals.push({ i, text }); }
    else interim += text;
  }
  return { finals, interim: interim.replace(/\s+/g, ' ').trim() };
}

// Spacing around a segment dropped between `before` and `after`: a space in front unless the text already
// ends in whitespace (or an opening bracket/quote) or the segment starts with punctuation; a space behind
// when a word follows directly. `caret` is the offset after the dictated words, before that trailing space —
// so the next segment lands right behind them and gets its own leading space.
const VOICE_PUNCT_START = /^[.,;:!?…)\]}»“"'%]/;
const VOICE_OPEN_END = /[([{„«]$/;
function voiceJoin(before, text, after) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!t) return { text: '', caret: 0 };
  const b = String(before || ''), a = String(after || '');
  const lead = (b && !/\s$/.test(b) && !VOICE_OPEN_END.test(b) && !VOICE_PUNCT_START.test(t)) ? ' ' : '';
  const trail = (a && !/^\s/.test(a) && !VOICE_PUNCT_START.test(a)) ? ' ' : '';
  return { text: lead + t + trail, caret: lead.length + t.length };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { voiceSplit, voiceJoin };
}
