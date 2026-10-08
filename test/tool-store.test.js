'use strict';
// The store behind „Werkzeuge aus" — and the caps that make it safe to have at all. Two properties are
// worth pinning here, because both failure modes are invisible in the UI:
//   · the caps: the LIVE path truncates nothing (a Write input can be a whole file, an output 200 000
//     characters), so an uncapped store would be a memory leak that only shows up as a slow browser.
//   · the shape: an oversized input becomes exactly what the resume path produces
//     ({_truncated, preview}), so a rebuilt card is indistinguishable from one painted from the
//     transcript — that is asserted against lib/sessions.js itself, not against a copy of the rule.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  TOOL_STORE_MAX, TOOL_STORE_OUTS, TOOL_STORE_CHARS, TOOL_STORE_CUT,
  toolStoreCapInput, toolStoreCapText, toolStoreSize, toolStorePut, toolStoreOut,
} = require('../public/js/tool-store');
const { capToolInput } = require('../lib/sessions');

const big = (n) => 'x'.repeat(n);

describe('tool-store — capping a tool input', () => {
  it('leaves an input that fits completely alone (so it still renders as a diff)', () => {
    const input = { file_path: 'a.js', old_string: 'a', new_string: 'b' };
    assert.equal(toolStoreCapInput(input), input); // same object, not a copy
  });
  it('turns an oversized input into the resume path\'s preview shape', () => {
    const out = toolStoreCapInput({ content: big(20000) });
    assert.equal(out._truncated, true);
    assert.ok(out.preview.endsWith(TOOL_STORE_CUT));
    assert.equal(out.preview.length, TOOL_STORE_CHARS + TOOL_STORE_CUT.length);
  });
  it('is the SAME rule the resume path uses (lib/sessions.js capToolInput)', () => {
    const input = { content: big(20000) };
    assert.deepEqual(capToolInput(input), toolStoreCapInput(input));
    const small = { content: 'hi' };
    assert.equal(capToolInput(small), small);
  });
  it('survives an input JSON.stringify cannot handle', () => {
    const circular = { name: 'x' }; circular.self = circular;
    const out = toolStoreCapInput(circular);
    assert.equal(typeof out, 'string'); // the string form is all there is
    assert.ok(out.length <= TOOL_STORE_CHARS);
  });
  it('caps text with a marker and leaves short text untouched', () => {
    assert.equal(toolStoreCapText('kurz'), 'kurz');
    const t = toolStoreCapText(big(TOOL_STORE_CHARS + 10));
    assert.ok(t.endsWith(TOOL_STORE_CUT));
    assert.equal(t.length, TOOL_STORE_CHARS + TOOL_STORE_CUT.length + 1); // + the newline before the marker
    assert.equal(toolStoreCapText(null), '');
  });
});

describe('tool-store — the store itself is bounded', () => {
  it('stores a call and reports success', () => {
    const store = {};
    assert.equal(toolStorePut(store, 'id1', 'Read', { file_path: 'a.js' }), true);
    assert.equal(toolStoreSize(store), 1);
    assert.equal(store.id1.name, 'Read');
    assert.deepEqual(store.id1.outs, []);
  });
  it('refuses a NEW call beyond the cap and says so', () => {
    const store = {};
    for (let i = 0; i < TOOL_STORE_MAX; i++) assert.equal(toolStorePut(store, 'id' + i, 'Read', {}), true);
    assert.equal(toolStorePut(store, 'over', 'Read', {}), false);
    assert.equal(toolStoreSize(store), TOOL_STORE_MAX);
    assert.equal(store.over, undefined);
  });
  it('still allows overwriting a call that is already stored at the cap', () => {
    const store = {};
    for (let i = 0; i < TOOL_STORE_MAX; i++) toolStorePut(store, 'id' + i, 'Read', {});
    assert.equal(toolStorePut(store, 'id0', 'Write', { content: 'x' }), true);
    assert.equal(store.id0.name, 'Write');
    assert.equal(toolStoreSize(store), TOOL_STORE_MAX);
  });
  it('needs a store and an id', () => {
    assert.equal(toolStorePut(null, 'id', 'Read', {}), false);
    assert.equal(toolStorePut({}, '', 'Read', {}), false);
  });
});

describe('tool-store — outputs of a hidden call', () => {
  it('attaches a capped output to its call', () => {
    const store = {};
    toolStorePut(store, 'id1', 'Bash', { command: 'ls' });
    assert.equal(toolStoreOut(store, 'id1', big(20000), false), true);
    assert.equal(store.id1.outs.length, 1);
    assert.ok(store.id1.outs[0].text.endsWith(TOOL_STORE_CUT));
    assert.equal(store.id1.outs[0].isError, false);
  });
  it('drops an output whose call was never stored', () => {
    const store = {};
    assert.equal(toolStoreOut(store, 'unknown', 'hi', false), false);
    assert.equal(toolStoreSize(store), 0); // no entry conjured up
  });
  it('drops empty output and stops at the per-call cap', () => {
    const store = {};
    toolStorePut(store, 'id1', 'BashOutput', {});
    assert.equal(toolStoreOut(store, 'id1', '   \n ', false), false);
    for (let i = 0; i < TOOL_STORE_OUTS; i++) assert.equal(toolStoreOut(store, 'id1', 'line ' + i, false), true);
    assert.equal(toolStoreOut(store, 'id1', 'one too many', false), false);
    assert.equal(store.id1.outs.length, TOOL_STORE_OUTS);
  });
  it('keeps the error flag', () => {
    const store = {};
    toolStorePut(store, 'id1', 'Bash', {});
    toolStoreOut(store, 'id1', 'boom', true);
    assert.equal(store.id1.outs[0].isError, true);
  });
});
