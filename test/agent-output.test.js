'use strict';
// #34 — reading a subagent's own transcript. Two halves, both of which have a way of failing silently:
//   · the PATH check is the only thing between a query string and an arbitrary file read;
//   · the LINE parser reads a file that is being appended to while it is read, so a half-written last
//     line is the normal case, not an edge case. Consuming it would drop that record AND desynchronise
//     every later poll by starting mid-JSON.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { agentOutputPathOk, parseAgentOutput, recordEvents, toolOneLiner, lastAssistantText } = require('../lib/agent-output');

const TMP = os.tmpdir();
const ok = (...p) => path.join(TMP, 'claude', ...p);

describe('#34 agentOutputPathOk — an allowlist, not a sanitiser', () => {
  it('accepts the shape the CLI really reports', () => {
    assert.equal(agentOutputPathOk(ok('C--Users-x', 'sess-1', 'tasks', 'a63e23d858826849f.output')), true);
  });
  it('refuses anything outside %TEMP%/claude', () => {
    assert.equal(agentOutputPathOk(path.join(os.homedir(), '.claude', 'settings.json')), false);
    assert.equal(agentOutputPathOk(path.join(TMP, 'other', 'x.output')), false);
    // a directory whose name merely STARTS with the root — the classic prefix-match hole
    assert.equal(agentOutputPathOk(path.join(TMP, 'claude-evil', 'x.output')), false);
  });
  it('refuses traversal, the wrong extension and junk', () => {
    assert.equal(agentOutputPathOk(ok('s', 'tasks', '..', '..', '..', '.claude', 'settings.json')), false);
    assert.equal(agentOutputPathOk(ok('s', 'tasks', 'a.output.txt')), false);
    assert.equal(agentOutputPathOk(ok('s', 'tasks', 'a\u0000.output')), false);
    assert.equal(agentOutputPathOk(''), false);
    assert.equal(agentOutputPathOk(null), false);
    assert.equal(agentOutputPathOk(TMP), false);
  });
  it('accepts the root itself only with a real file under it', () => {
    assert.equal(agentOutputPathOk(path.join(TMP, 'claude')), false);
    assert.equal(agentOutputPathOk(path.join(TMP, 'claude', 'x.output')), true);
  });
});

// The records are the shapes measured in a real .output file (claude 2.1.276): the opening record is a
// `user` message whose content is a plain STRING (the assignment), everything after it is the ordinary
// block-array shape.
const line = (o) => JSON.stringify(o) + '\n';
const userPrompt = { isSidechain: true, type: 'user', timestamp: '2026-09-18T10:00:00.000Z', message: { role: 'user', content: 'Explore the repo …' } };
const toolCall = { isSidechain: true, type: 'assistant', timestamp: '2026-09-18T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'C:\\x\\a.txt' } }] } };
const answer = { isSidechain: true, type: 'assistant', timestamp: '2026-09-18T10:00:09.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Report: all good' }] } };

describe('#34 parseAgentOutput — a file that grows while it is read', () => {
  it('turns records into display events', () => {
    const { events } = parseAgentOutput(line(userPrompt) + line(toolCall) + line(answer));
    assert.deepEqual(events.map((e) => e.kind), ['prompt', 'tool', 'text']);
    assert.equal(events[1].name, 'Read');
    assert.equal(events[1].summary, 'C:\\x\\a.txt');
    assert.equal(events[2].text, 'Report: all good');
  });

  it('leaves a half-written last line for the next poll', () => {
    // The whole file as it will eventually be on disk, and the moment mid-write when the poll hits it.
    const complete = line(userPrompt) + line(toolCall);
    const whole = complete + line(answer);
    const halfWritten = whole.slice(0, complete.length + 18);   // the last record is torn
    const r = parseAgentOutput(halfWritten);
    assert.equal(r.events.length, 2, 'the torn record must not be reported');
    assert.equal(r.consumed, Buffer.byteLength(complete, 'utf8'), 'and the next read has to resume at its start');
    // The next poll reads from `consumed` — a BYTE offset into the file, exactly like the route does.
    const rest = Buffer.from(whole, 'utf8').subarray(r.consumed).toString('utf8');
    const r2 = parseAgentOutput(rest);
    assert.equal(r2.events.length, 1, 'the record that was torn last time must arrive now');
    assert.equal(r2.events[0].kind, 'text');
  });

  it('counts BYTES, not characters — a resume offset is a byte offset', () => {
    const rec = { isSidechain: true, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Grüße über Bäume — 🌳' }] } };
    const text = line(rec);
    const r = parseAgentOutput(text);
    assert.equal(r.consumed, Buffer.byteLength(text, 'utf8'));
    assert.notEqual(r.consumed, text.length, 'the fixture must actually contain multi-byte characters');
  });

  it('skips a torn line in the middle instead of failing the whole read', () => {
    const { events } = parseAgentOutput('{"broken":\n' + line(answer));
    assert.equal(events.length, 1);
  });

  it('caps the response and resumes exactly at the first unreported line', () => {
    const text = line(toolCall).repeat(5);
    const r = parseAgentOutput(text, { maxEvents: 2 });
    assert.equal(r.events.length, 2);
    assert.equal(r.truncated, true);
    assert.equal(r.consumed, Buffer.byteLength(line(toolCall).repeat(2), 'utf8'),
      'a capped read must not consume a line whose events it did not deliver');
  });

  it('drops the agent-s own tool_results and attachments (they are not activity)', () => {
    const result = { isSidechain: true, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'file contents' }] } };
    const att = { isSidechain: true, type: 'attachment', message: { role: 'user', content: [] } };
    assert.deepEqual(parseAgentOutput(line(result) + line(att)).events, []);
  });

  it('shortens long texts and says so', () => {
    const long = { isSidechain: true, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(900) }] } };
    const e = parseAgentOutput(line(long)).events[0];
    assert.equal(e.full, true);
    assert.ok(e.text.length < 900);
  });

  it('empty input is not an error', () => {
    assert.deepEqual(parseAgentOutput('').events, []);
    assert.equal(parseAgentOutput('').consumed, 0);
    assert.deepEqual(parseAgentOutput(null).events, []);
  });
});

describe('#34 helpers', () => {
  it('toolOneLiner picks the field that says what the call did', () => {
    assert.equal(toolOneLiner('Bash', { command: 'git status', description: 'Show status' }), 'Show status');
    assert.equal(toolOneLiner('Bash', { command: 'git status' }), 'git status');
    assert.equal(toolOneLiner('Grep', { pattern: 'foo.*bar' }), 'foo.*bar');
    assert.equal(toolOneLiner('Weird', { nothing: 1 }), '');
    assert.equal(toolOneLiner('Weird', null), '');
  });
  it('recordEvents never throws on a shape it has not seen', () => {
    assert.deepEqual(recordEvents(null), []);
    assert.deepEqual(recordEvents({}), []);
    assert.deepEqual(recordEvents({ message: 42 }), []);
    assert.deepEqual(recordEvents({ message: { content: [null, 7, { type: 'text' }] } }), []);
  });
  it('lastAssistantText returns the closing report', () => {
    const { events } = parseAgentOutput(line(answer) + line(toolCall));
    assert.equal(lastAssistantText(events), 'Report: all good');
    assert.equal(lastAssistantText([]), '');
  });
});
