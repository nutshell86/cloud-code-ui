'use strict';
// Tests for lib/sessions.js against the synthetic corpus in test/fixtures/ (no real ~/.claude, no
// personal data). Covers what WP-1 changed:
//   • scanSessions: counts/preview/summary AND the authoritative cwd (F2 — a hyphenated project dir
//     cannot be decoded back, so projectPath must come from the transcript)
//   • searchSessions: hits + the coverage signals (indexedFiles / skippedFiles) that replaced the
//     silent 8MB cutoff (F3)
//   • the resumable parse: after an append, folding the tail must equal a full re-parse (F6)
//
// The CLAUDE_UI_CLAUDE_DIR / CLAUDE_UI_DATA_DIR seams MUST be set before lib/paths is required —
// node --test gives every test file its own process, so this cannot affect the other suites.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures', 'projects');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-sessions-test-'));
fs.cpSync(FIXTURES, path.join(TMP, 'projects'), { recursive: true });
process.env.CLAUDE_UI_CLAUDE_DIR = TMP;
process.env.CLAUDE_UI_DATA_DIR = TMP;
// Cleanup on process exit, NOT in a per-suite after(): suites share this one corpus, and a suite-local
// after() ran while the next suite still needed the files.
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const { scanSessions, searchSessions, readTranscript } = require('../lib/sessions');
const PLAIN = path.join(TMP, 'projects', 'C--Users-dev-plain');
const SESS1 = path.join(PLAIN, '11111111-1111-4111-8111-111111111111.jsonl');
const byId = (list, id) => list.find((s) => s.id.startsWith(id));

// one appended user+assistant pair, deliberately full of multi-byte characters: the resumable parse
// restarts at a BYTE offset, so a char-vs-byte mix-up would desync exactly here
function appendPair(file, n) {
  const lines = [
    JSON.stringify({ type: 'user', cwd: 'C:\\Users\\dev\\plain', timestamp: '2026-01-08T07:0' + n + ':00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Nachtrag ' + n + ' — Grüße äöü 😀' }] } }),
    JSON.stringify({ type: 'assistant', cwd: 'C:\\Users\\dev\\plain', timestamp: '2026-01-08T07:0' + n + ':05.000Z', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Antwort ' + n }], usage: { input_tokens: 7, output_tokens: 3 } } }),
  ];
  fs.appendFileSync(file, lines.join('\n') + '\n');
}

describe('lib/sessions — scanSessions over the fixture corpus', () => {
  let sessions;
  before(async () => { sessions = await scanSessions(); });

  it('finds every fixture session with the right counts, preview and summary', () => {
    assert.equal(sessions.length, 3, 'expected the 3 fixture transcripts');
    const s1 = byId(sessions, '11111111');
    assert.equal(s1.messages, 2);
    assert.equal(s1.summary, 'Fixture: Widget-Session');
    assert.equal(s1.preview, 'Wie baue ich ein Widget?');
    assert.equal(s1.title, 'Fixture: Widget-Session'); // summary wins over the id fallback
    assert.equal(byId(sessions, '33333333').messages, 3);
    assert.equal(byId(sessions, '22222222').messages, 3);
  });

  it('projectPath is the transcript cwd, NOT the lossy dir-name decode (F2)', () => {
    const { decodeProject } = require('../lib/core');
    const hyph = byId(sessions, '22222222');
    assert.equal(hyph.projectPath, 'C:\\Users\\dev\\my-project');
    // the bug this replaces: the encoded dir name decodes to a path that never existed
    assert.equal(decodeProject('C--Users-dev-my-project'), 'C:\\Users\\dev\\my\\project');
    assert.notEqual(hyph.projectPath, decodeProject(hyph.project));
    // the hyphen-free project decodes correctly and must be unchanged
    assert.equal(byId(sessions, '11111111').projectPath, 'C:\\Users\\dev\\plain');
  });

  it('resumable parse: an append folds into the cached aggregate and matches a full re-parse (F6)', async () => {
    const before = byId(await scanSessions(), '11111111').messages;
    appendPair(SESS1, 1);
    const afterOne = byId(await scanSessions(), '11111111').messages;
    assert.equal(afterOne, before + 2, 'appended pair not counted exactly once');
    appendPair(SESS1, 2); // second append resumes from the offset the first one left behind
    const afterTwo = byId(await scanSessions(), '11111111').messages;
    assert.equal(afterTwo, before + 4);
    // ground truth: a virgin full parse of the same file must agree with the folded aggregate
    const raw = fs.readFileSync(SESS1, 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((o) => o.type === 'user' || o.type === 'assistant').length;
    assert.equal(afterTwo, raw, 'resumable aggregate drifted from a full re-parse');
  });

  it('a trailing PARTIAL line is not consumed and does not corrupt the count (F6)', async () => {
    const before = byId(await scanSessions(), '11111111').messages;
    fs.appendFileSync(SESS1, '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"halb geschrie');
    assert.equal(byId(await scanSessions(), '11111111').messages, before, 'a half-written line was counted');
    fs.appendFileSync(SESS1, 'ben"}]}}\n'); // the CLI finishes the line
    assert.equal(byId(await scanSessions(), '11111111').messages, before + 1, 'the completed line was not picked up');
  });
});

describe('lib/sessions — searchSessions coverage signals (F3)', () => {
  it('finds a term in a session and reports how many files were indexed', async () => {
    const r = await searchSessions('zebrastreifen', 20);
    assert.equal(r.indexedFiles, 3);
    assert.deepEqual(r.skippedFiles, []);
    assert.deepEqual(r.truncatedFiles, []);
    assert.ok(r.hits.length >= 1, 'no hit for a term that is in the corpus');
    const hit = r.hits.find((h) => h.sessionId.startsWith('22222222'));
    assert.ok(hit, 'hit is not attributed to the right session');
    assert.match(hit.snippet.toLowerCase(), /zebrastreifen/);
    assert.equal(hit.projectPath, 'C:\\Users\\dev\\my-project'); // authoritative path here too
  });

  it('a query shorter than 2 chars returns the empty shape, not an array', async () => {
    const r = await searchSessions('a', 20);
    assert.deepEqual(r, { hits: [], indexedFiles: 0, skippedFiles: [], truncatedFiles: [] });
  });

  it('an unreadable .jsonl is REPORTED as skipped instead of silently dropped (F3)', async () => {
    // (kept before the isMeta suite below, which adds a 4th transcript to the corpus)
    // a directory named like a transcript: stat() succeeds, the read fails (EISDIR) — the same
    // observable situation as a locked/vanished file, and the signal the old code swallowed
    const broken = path.join(PLAIN, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl');
    await fsp.mkdir(broken, { recursive: true });
    try {
      const r = await searchSessions('zebrastreifen', 20);
      assert.ok(r.skippedFiles.includes(path.basename(broken)), 'unreadable file missing from skippedFiles: ' + JSON.stringify(r.skippedFiles));
      assert.equal(r.indexedFiles, 3, 'the readable files must still be searched');
      assert.ok(r.hits.length >= 1, 'one bad file must not kill the whole search');
    } finally { await fsp.rm(broken, { recursive: true, force: true }); }
  });
});

// G2, the resume half. The transcript holds NO `result` line (measured over the live corpus), so after a
// reload the subtype, errors[], terminal_reason, permission_denials and subagent_stats of a turn are gone
// for good — nothing can bring them back. `message.stop_reason` IS persisted, and it is the one end
// reason that changes how the TEXT must be read: without it a reload silently turns a truncated answer
// back into a complete-looking one, i.e. half of this PR would be invisible after every F5.
// Ordering, like the isMeta suite below: this one REWRITES the 33333333 fixture and then removes it, so it
// has to stay behind every suite that pins the 3-transcript counts — and ahead of isMeta, which claims the
// last slot for the 4th transcript it adds.
describe('lib/sessions — a resumed transcript keeps the one end reason it has (G2)', () => {
  const SESS_STOP = path.join(PLAIN, '33333333-3333-4333-8333-333333333333.jsonl');
  function line(obj) { return JSON.stringify(obj) + '\n'; }
  function assistant(text, stopReason) {
    return line({ type: 'assistant', cwd: 'C:\\Users\\dev\\plain', timestamp: '2026-02-01T08:00:00.000Z',
      message: { role: 'assistant', model: 'claude-opus-5', stop_reason: stopReason, content: [{ type: 'text', text }], usage: { input_tokens: 5, output_tokens: 2 } } });
  }
  before(() => {
    fs.writeFileSync(SESS_STOP,
      line({ type: 'user', cwd: 'C:\\Users\\dev\\plain', message: { role: 'user', content: [{ type: 'text', text: 'Frage eins' }] } })
      + assistant('eine ganz normale Antwort', 'end_turn')
      + assistant('ich rufe ein Werkzeug auf', 'tool_use')
      + assistant('diese Antwort bricht mitten im Satz', 'max_tokens')
      + assistant('und diese sprengt das Fenster', 'model_context_window_exceeded')
      + assistant('und diese wurde verweigert', 'refusal'));
  });
  after(() => { try { fs.rmSync(SESS_STOP, { force: true }); } catch { /* */ } });

  it('carries max_tokens / model_context_window_exceeded / refusal into the transcript payload', async () => {
    const r = await readTranscript('C--Users-dev-plain', '33333333-3333-4333-8333-333333333333', { tail: 50 });
    const stops = r.events.filter((e) => e.kind === 'assistant').map((e) => e.stopReason);
    assert.deepEqual(stops, [undefined, undefined, 'max_tokens', 'model_context_window_exceeded', 'refusal']);
  });

  it('…and says NOTHING for the two values that are on almost every line', async () => {
    const r = await readTranscript('C--Users-dev-plain', '33333333-3333-4333-8333-333333333333', { tail: 50 });
    const normal = r.events.filter((e) => e.kind === 'assistant' && /normal|Werkzeug/.test(e.text));
    assert.equal(normal.length, 2);
    normal.forEach((e) => assert.ok(!('stopReason' in e), 'end_turn/tool_use would add a field to every single event'));
  });
});

// H3 — isMeta lines. The CLI injects harness bookkeeping as `type:"user"` records: 171 of them on the
// live corpus, every one type user, none with usage, so this cannot move a token or a cent. What it moves
// is the TURN count (8.62 % of all turns corpus-wide are phantom, up to 23.1 % in one session) and — the
// effect nobody had noticed — the TITLE: 20 of 294 sessions took their preview from an isMeta line,
// because the old guard only rejected text starting with '<' and 112 of the 171 lines do not.
// Runs LAST on purpose: it adds a 4th transcript, which the counts above are pinned to.
describe('lib/sessions — isMeta is bookkeeping, not a turn and not a title (H3)', () => {
  const ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const FILE = path.join(PLAIN, ID + '.jsonl');
  const { readTranscript } = require('../lib/sessions');

  // ONE cwd constant, double-backslashed. The first version of this fixture wrote 'C:\Users\dev\plain' in
  // single quotes, where \U \d \p are not escape sequences at all: the transcript carried the cwd
  // "C:Usersdevplain", i.e. a transcript sitting in C--Users-dev-plain that claimed a path that does not
  // exist. Every assertion below happened to pass anyway (they read counts, not the path), so the fixture
  // was quietly testing something else than it said — hence the projectPath assertion that now pins it.
  const CWD = 'C:\\Users\\dev\\plain';

  before(() => {
    fs.writeFileSync(FILE, [
      // deliberately does NOT start with '<' — that is the whole point
      JSON.stringify({ type: 'user', isMeta: true, cwd: CWD, timestamp: '2026-01-11T08:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Caveat: Dateien wurden ausserhalb geaendert.' }] } }),
      JSON.stringify({ type: 'user', cwd: CWD, timestamp: '2026-01-11T08:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Was ich wirklich gefragt habe' }] } }),
      JSON.stringify({ type: 'assistant', cwd: CWD, timestamp: '2026-01-11T08:00:02.000Z', message: { id: 'msg_h3', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Antwort' }], usage: { input_tokens: 5, output_tokens: 2 } } }),
    ].join('\n') + '\n');
  });
  after(() => { try { fs.rmSync(FILE); } catch { /* */ } });

  it('the fixture really is a Windows path — a single-quoted "C:\\Users" is not one', () => {
    assert.equal(CWD, 'C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + 'dev' + String.fromCharCode(92) + 'plain');
    const written = JSON.parse(fs.readFileSync(FILE, 'utf8').split('\n')[0]);
    assert.equal(written.cwd, CWD, 'the cwd lost its backslashes on the way into the transcript');
  });

  it('is not counted as a message and never becomes the preview or the title', async () => {
    const s = byId(await scanSessions(), 'cccccccc');
    assert.equal(s.messages, 2, 'the isMeta line was counted as a message');
    assert.equal(s.preview, 'Was ich wirklich gefragt habe');
    assert.equal(s.title, 'Was ich wirklich gefragt habe', 'the session title came from a harness note');
    // F2: the projectPath comes from the transcript's own cwd, so a broken fixture cwd shows up HERE —
    // and the isMeta line is the one that carries it, which is the second reason this assertion belongs
    // in this suite: an isMeta record is a legitimate source for the authoritative cwd.
    assert.equal(s.projectPath, CWD, 'the cwd of an isMeta line must still be the authoritative project path');
  });

  it('is not counted as one of your turns', async () => {
    const r = await readTranscript('C--Users-dev-plain', ID, { tail: 0 });
    assert.equal(r.meta.userTurns, 1, 'a harness note was counted as a turn you took');
    assert.equal(r.meta.messages, 1, 'one model call');
    assert.equal(r.meta.output, 2, 'and its numbers come from the shared fold');
    assert.ok(!r.events.some((e) => e.kind === 'user' && /Caveat/.test(e.text || '')), 'the isMeta line must not be rendered as a turn');
  });
});

// PF-1 — an ExitPlanMode in the resumed tail is a history card, not a tool card: {title, file, chars, preview}.
// The preview is the plan as MARKDOWN, capped like the generic card's input was — the one copy of an EARLIER
// plan's text left, since the CLI writes every plan of a session into the same plan file. Runs after the
// isMeta suite and removes its transcript again, so the counts pinned above are not touched.
describe('lib/sessions — an ExitPlanMode in the tail (PF-1)', () => {
  const ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const FILE = path.join(PLAIN, ID + '.jsonl');
  const CWD = 'C:\Users\dev\plain';
  const PLAN = '# Plan: Langer Plan\n\n' + 'Eine Zeile des Plans.\n'.repeat(1000);
  const PFILE = 'C:\Users\dev\.claude\plans\langer-plan.md';
  before(() => {
    fs.writeFileSync(FILE, [
      JSON.stringify({ type: 'user', cwd: CWD, timestamp: '2026-01-12T08:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Plane das' }] } }),
      JSON.stringify({ type: 'assistant', cwd: CWD, timestamp: '2026-01-12T08:00:01.000Z', message: { id: 'msg_pf', role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'tool_use', id: 'toolu_pf1', name: 'ExitPlanMode', input: { plan: PLAN, planFilePath: PFILE } }], usage: { input_tokens: 5, output_tokens: 2 } } }),
    ].join('\n') + '\n');
  });
  after(() => { try { fs.rmSync(FILE); } catch { /* */ } });

  it('title, file and size — and the first 8000 characters as markdown instead of a JSON fragment', async () => {
    const r = await readTranscript('C--Users-dev-plain', ID, { tail: 50 });
    const epm = r.events.flatMap((e) => e.tools || []).find((t) => t && t.name === 'ExitPlanMode');
    assert.ok(epm, 'the ExitPlanMode call is in the tail');
    assert.equal(epm.input, undefined, 'no capped input object');
    assert.equal(epm.plan.title, 'Langer Plan');
    assert.equal(epm.plan.file, PFILE);
    assert.equal(epm.plan.chars, PLAN.length);
    assert.ok(PLAN.length > 8000);
    assert.equal(epm.plan.preview, PLAN.slice(0, 8000));
  });
});
