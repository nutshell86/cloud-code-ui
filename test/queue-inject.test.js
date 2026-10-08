'use strict';
// „↪ Jetzt einspeisen" + editing a queued entry (Julian, 07.10.). Measured the same day (CLI 2.1.292, live probe): a
// user message written to stdin WHILE a turn runs reaches the model at the next tool boundary of the SAME turn — kept
// in the transcript as a `queued_command` attachment (mode „prompt"). So a queued text no longer has to wait for the
// turn's end; this pins which entries may go, what goes out, what comes back on failure, and the history read-back.
// The CLAUDE_UI_CLAUDE_DIR seam must be set before lib/paths is required.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-queue-inject-'));
process.env.CLAUDE_UI_CLAUDE_DIR = TMP;
const { liftFn } = require('./event-pump');
const Q = require('../public/js/queue-merge.js');
const { readTranscript } = require('../lib/sessions');

const PUB = path.join(__dirname, '..', 'public', 'js');
const COMPOSER = fs.readFileSync(path.join(PUB, 'chat-composer.js'), 'utf8');
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

describe('queueItemInjectable / queueInjectTake — what may go into a running turn', () => {
  it('plain text yes; a command, a file, a plan entry no', () => {
    assert.equal(Q.queueItemInjectable({ text: 'erkläre Schritt 3 genauer' }), true);
    assert.equal(Q.queueItemInjectable({ text: '/clear' }), false);
    assert.equal(Q.queueItemInjectable({ text: 'mit Bild', attachments: [{ kind: 'image' }] }), false);
    assert.equal(Q.queueItemInjectable({ text: 'plan starten', plan: true }), false);
    assert.equal(Q.queueItemInjectable({ text: 'x', planFor: 'toolu_1' }), false);
  });
  it('the badge takes the LEADING run and stops at the first entry that may not go — nothing slips ahead of a /clear', () => {
    const a = { text: 'a' }, b = { text: 'b' }, c = { text: '/clear' }, d = { text: 'd' };
    const r = Q.queueInjectTake([a, b, c, d]);
    assert.deepEqual(r.take, [a, b]);
    assert.deepEqual(r.rest, [c, d]);
    assert.deepEqual(Q.queueInjectTake([c, a]).take, []);
  });
});

function harness(tab, over) {
  const calls = { injected: [], toasts: [], changed: 0, answered: [] };
  const known = Object.assign(Object.create(null), {
    ACTIVE: tab, tt: (k) => k, toast: (m, k) => calls.toasts.push([String(m), k]),
    queueInjectLive: () => true, queueItemInjectable: Q.queueItemInjectable, queueMergeItems: Q.queueMergeItems,
    queueRestoreTaken: Q.queueRestoreTaken, queueChanged: () => { calls.changed++; },
    injectNow: (t, text) => { calls.injected.push(text); return Promise.resolve(over && 'ok' in over ? over.ok : true); },
    openPointsAnswerFrom: (t, text) => calls.answered.push(text),
    uiPrompt: async () => (over && 'edit' in over ? over.edit : null),
  });
  const stub = () => undefined;
  const env = new Proxy(known, {
    has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
    get: (t, k) => (typeof k !== 'string' ? undefined : k in t ? t[k] : stub),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  const src = ['injectQueued', 'editQueued'].map((n) => liftFn(COMPOSER, n, 'chat-composer.js')).join('\n');
  const fn = new Function('__env', 'with (__env) {\n' + src + '\nreturn { injectQueued, editQueued };\n}')(env);
  return { fn, calls };
}
const flush = () => new Promise((r) => setImmediate(r));

describe('injectQueued — out of the queue, as ONE message, back to the front if it fails', () => {
  it('two entries → one numbered message; they leave the queue; open points are answered only after delivery', async () => {
    const a = { text: 'A erklärt Schritt 2', queuedAt: 1 }, b = { text: 'B noch dazu', queuedAt: 2 }, c = { text: '/compact' };
    const tab = { queue: [a, b, c] };
    const h = harness(tab);
    h.fn.injectQueued(tab, [a, b]);
    assert.deepEqual(tab.queue, [c], 'they leave at once — a second click cannot send them twice');
    await flush();
    assert.equal(h.calls.injected.length, 1);
    assert.match(h.calls.injected[0], /^chat-composer\.mehrereAnliegen\n\n1\. A erklärt Schritt 2\n\n2\. B noch dazu$/);
    assert.equal(h.calls.answered.length, 1);
    assert.deepEqual(h.calls.toasts.at(-1), ['chat-composer.eingespeist', 'ok']);
  });
  it('a single entry goes as it is', async () => {
    const a = { text: 'nur das' };
    const tab = { queue: [a] };
    const h = harness(tab);
    h.fn.injectQueued(tab, [a]);
    await flush();
    assert.deepEqual(h.calls.injected, ['nur das']);
  });
  it('a failed delivery puts them back at the FRONT, in order', async () => {
    const a = { text: 'a' }, b = { text: 'b' }, c = { text: 'später getippt' };
    const tab = { queue: [a, b] };
    const h = harness(tab, { ok: false });
    h.fn.injectQueued(tab, [a, b]);
    tab.queue.push(c); // typed while the POST was out
    await flush();
    assert.deepEqual(tab.queue, [a, b, c]);
    assert.equal(h.calls.answered.length, 0);
    assert.deepEqual(h.calls.toasts.at(-1), ['chat-composer.einspeisenZurueck', 'err']);
  });
  it('entries that may not go are never taken, even when passed in', async () => {
    const cmd = { text: '/clear' };
    const tab = { queue: [cmd] };
    const h = harness(tab);
    h.fn.injectQueued(tab, [cmd]);
    await flush();
    assert.deepEqual(h.calls.injected, []);
    assert.deepEqual(tab.queue, [cmd]);
  });
});

describe('editQueued — in place, the entry keeps its position', () => {
  it('the new text replaces the old one; a merged entry becomes ONE message again', async () => {
    const a = { text: 'a' }, m = { text: 'Mehrere…\n\n1. x\n\n2. y', parts: ['x', 'y'], merged: 2 }, c = { text: 'c' };
    const tab = { queue: [a, m, c] };
    const h = harness(tab, { edit: '  x und y zusammen, genauer  ' });
    await h.fn.editQueued(tab, m);
    assert.deepEqual(tab.queue.map((it) => it.text), ['a', 'x und y zusammen, genauer', 'c']);
    assert.ok(!('parts' in m) && !('merged' in m));
  });
  it('cancel changes nothing; an entry flushed meanwhile is not resurrected; empty is not saved', async () => {
    const a = { text: 'a' };
    let tab = { queue: [a] };
    await harness(tab, { edit: null }).fn.editQueued(tab, a);
    assert.equal(a.text, 'a');
    const gone = { text: 'weg' }; tab = { queue: [] };
    const h = harness(tab, { edit: 'neu' });
    await h.fn.editQueued(tab, gone);
    assert.equal(gone.text, 'weg');
    assert.deepEqual(h.calls.toasts.at(-1), ['chat-composer.schonGesendet', 'warn']);
    tab = { queue: [a] };
    await harness(tab, { edit: '   ' }).fn.editQueued(tab, a);
    assert.equal(a.text, 'a');
  });
});

describe('wiring', () => {
  it('chip text = edit button, ↪ per chip and the badge in the merge look — only while a turn can take it', () => {
    assert.match(COMPOSER, /const txt = el\('button', 'cq-txt'/);
    assert.match(COMPOSER, /else txt\.onclick = \(\) => editQueued\(ACTIVE, item\);/);
    assert.match(COMPOSER, /if \(live && queueItemInjectable\(item\)\) \{/);
    assert.match(COMPOSER, /el\('button', 'cq-merge cq-inject'/);
    assert.match(COMPOSER, /function queueInjectLive\(tab\) \{ return !!\(tab && tab\.id && tab\.streaming && !\(typeof hasHeldGate === 'function' && hasHeldGate\(tab\)\)\); \}/);
  });
  it('the plan list is asked for mid-turn the moment unknown step IDs arrive (once per plan)', () => {
    const side = fs.readFileSync(path.join(PUB, 'chat-side.js'), 'utf8');
    assert.match(side, /if \(!p\.steps\.length && tab\._planAutoAsked !== p\.id && typeof injectNow === 'function'/);
    assert.match(side, /injectNow\(tab, planStepsRequestMessage\(tt\('chat-side\.planSchritteFrage'\), p\)\);/);
  });
});

describe('lib/sessions readTranscript — an injected message comes back in the history', () => {
  it('a queued_command of mode „prompt" from a human is a user event marked injected; notifications are not', async () => {
    const proj = 'C--probe', id = '11111111-2222-3333-4444-555555555555';
    fs.mkdirSync(path.join(TMP, 'projects', proj), { recursive: true });
    const lines = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Lies a.txt' }] }, timestamp: '2026-10-07T10:00:00Z' },
      { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: [{ type: 'text', text: 'Zusatz: BANANE' }] }, timestamp: '2026-10-07T10:00:02Z' },
      { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification>x</task-notification>' } },
      { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: '<agent-message from="a">hi</agent-message>' } },
      { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'von woanders', origin: { kind: 'plugin', name: 'p' } } },
      { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'intern', isMeta: true } },
    ];
    fs.writeFileSync(path.join(TMP, 'projects', proj, id + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const r = await readTranscript(proj, id);
    const users = r.events.filter((e) => e.kind === 'user');
    assert.deepEqual(users.map((e) => [e.text, !!e.injected]), [['Lies a.txt', false], ['Zusatz: BANANE', true]]);
  });
});
