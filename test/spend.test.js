'use strict';
// Zero-dependency unit tests: `node --test` (or `node --test test/`).
// Covers the Enterprise Spend-Limit-Manager payload sanitizer in ../lib/spend.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeSpend, isSpendOrigin, findOrOpenSpendTab, SPEND_URL, SPEND_ORIGIN, DEBUG_BROWSER_CMD } = require('../lib/spend');

// real shape captured from ai-tool-dashboard.example.com/ai-tools/spend/api/* (2026-08-25)
const FIXTURE = {
  ok: true,
  me: { oid: '17d0…', upn: 'jane.doe@example.com', name: 'Doe, Jane (Example Corp)', entitled: true, approver: 'Alex Approver', isApprover: false, basePath: '/ai-tools/spend' },
  overview: {
    entitled: true,
    orgs: [{ uuid: '45be…', name: 'Example Corp', limit: 5000, spent: 123.45, baseline: 30, expiresAt: '2026-11-01T14:45:44.796Z', disabled: false, centralApproval: false }],
    pending: null,
    approverKnown: true,
  },
  requests: { rows: [
    { requestId: 'cb86…', amount: 5000, durationDays: 96, expiresAt: '2026-11-01T14:45:44.796Z', status: 'Provisioned', createdAt: '2026-07-28T14:45:44.796Z', decidedBy: 'alex.approver@example.com' },
    { requestId: '9c4e…', amount: 5000, durationDays: 96, expiresAt: '2026-11-01T14:44:32.925Z', status: 'Superseded', createdAt: '2026-07-28T14:44:32.925Z', decidedBy: 'alex.approver@example.com' },
  ] },
};

test('sanitizeSpend: keeps the real dashboard shape (org numbers, approver, request history)', () => {
  const s = sanitizeSpend(FIXTURE);
  assert.equal(s.me.name, 'Doe, Jane (Example Corp)');
  assert.equal(s.me.approver, 'Alex Approver');
  assert.equal(s.orgs.length, 1);
  assert.equal(s.orgs[0].limit, 5000);
  assert.equal(s.orgs[0].spent, 123.45);
  assert.equal(s.orgs[0].baseline, 30);
  assert.equal(s.orgs[0].expiresAt, '2026-11-01T14:45:44.796Z');
  assert.equal(s.pending, null);
  assert.equal(s.requests.length, 2);
  assert.equal(s.requests[0].status, 'Provisioned');
  assert.equal(s.requests[1].decidedBy, 'alex.approver@example.com');
});

test('sanitizeSpend: coerces junk — non-numeric numbers → null, long strings capped, extra orgs cut', () => {
  const s = sanitizeSpend({
    me: { name: 'x'.repeat(500), entitled: 1 },
    overview: { orgs: Array.from({ length: 15 }, (_, i) => ({ name: 'Org' + i, limit: 'zwanzigtausend', spent: '12.5' })) },
    requests: { rows: [{ amount: 'viel', status: 'y'.repeat(200) }] },
  });
  assert.equal(s.me.name.length, 120);
  assert.equal(s.me.entitled, true);
  assert.equal(s.orgs.length, 10);
  assert.equal(s.orgs[0].limit, null);
  assert.equal(s.orgs[0].spent, 12.5);
  assert.equal(s.requests[0].amount, null);
  assert.equal(s.requests[0].status.length, 40);
});

test('sanitizeSpend: pending object is normalized; garbage input → null', () => {
  const s = sanitizeSpend({ me: { name: 'a' }, overview: { orgs: [], pending: { amount: '300', status: 'Pending' } } });
  assert.deepEqual(s.pending, { amount: 300, status: 'Pending', createdAt: '' });
  assert.equal(sanitizeSpend(null), null);
  assert.equal(sanitizeSpend('html login page'), null);
  assert.equal(sanitizeSpend({}), null);
  assert.equal(sanitizeSpend({ overview: { orgs: [] } }), null);
});

test('exports: dashboard URL + recipe-canonical debug command are wired', () => {
  assert.equal(SPEND_URL, 'https://ai-tool-dashboard.example.com/ai-tools/spend');
  assert.ok(DEBUG_BROWSER_CMD.includes('--remote-debugging-port=9222'));
  assert.ok(DEBUG_BROWSER_CMD.includes('edge-debug'));
});

// ---- alert #32 (js/incomplete-url-substring-sanitization) ----------------------------------------
// findOrOpenSpendTab used `url.startsWith(SPEND_ORIGIN)` to pick the CDP target, and then
// Runtime.evaluate's a fetch WITH COOKIES in whatever tab it picked. A prefix test accepts
// https://ai-tool-dashboard.example.com.evil.tld/… , i.e. a page in the debug browser that is not the
// dashboard could have received that request and answered the panel's cache. Now the origin is parsed.
test('isSpendOrigin: only the real dashboard origin, whatever the path', () => {
  for (const u of [
    SPEND_URL,
    SPEND_ORIGIN,
    SPEND_ORIGIN + '/',
    SPEND_ORIGIN + '/ai-tools/spend/api/overview?x=1#h',
    SPEND_ORIGIN + '/auth/login?redirect=/ai-tools/spend', // mid-SSO, still the dashboard
    'https://ai-tool-dashboard.example.com:443/ai-tools/spend', // default port, same origin
  ]) assert.equal(isSpendOrigin(u), true, 'the dashboard itself: ' + u);
});

test('isSpendOrigin: rejects lookalike origins a startsWith test let through', () => {
  for (const u of [
    SPEND_ORIGIN + '.evil.tld/ai-tools/spend',        // our origin as a PREFIX of theirs
    SPEND_ORIGIN + '@evil.tld/ai-tools/spend',        // our host as the userinfo
    'https://evil.tld/?next=' + SPEND_ORIGIN + '/ai-tools/spend',
    'https://evil.tld/ai-tool-dashboard.example.com/ai-tools/spend',
    'https://sub.ai-tool-dashboard.example.com/ai-tools/spend',
    'http://ai-tool-dashboard.example.com/ai-tools/spend', // scheme downgrade is a different origin
    'about:blank', 'chrome://newtab/', 'devtools://devtools/bundled/x.html', '', null, undefined, 42, {},
  ]) assert.equal(isSpendOrigin(u), false, 'must not be taken for the dashboard: ' + String(u));
});

// ---- alert #32, the CALL SITE ---------------------------------------------------------------------
// isSpendOrigin being right is only half of it: the tab findOrOpenSpendTab RETURNS is the tab
// fetchSpendViaCdp runs `fetch(..., {credentials:'include'})` in. These tests drive the selection
// itself through the module's injection seam (a fake CDP transport instead of 127.0.0.1:9222), so a
// future edit to the pick — dropping the predicate, moving it, accepting the wrong target type —
// fails here instead of silently handing the session cookie to whatever tab happens to be open.
function fakeCdp({ lists, newTab }) {
  const calls = [];
  const queue = lists.slice();
  const cdp = async (method, pathname) => {
    calls.push(method + ' ' + pathname);
    if (pathname === '/json/list') return queue.length > 1 ? queue.shift() : queue[0];
    if (pathname.startsWith('/json/new')) return newTab;
    return null;
  };
  return { cdp, calls };
}
const page = (id, url, ws) => ({ id, type: 'page', url, webSocketDebuggerUrl: ws === undefined ? 'ws://127.0.0.1:9222/devtools/page/' + id : ws });

test('findOrOpenSpendTab: picks the dashboard tab, not the lookalike sitting next to it', async () => {
  const targets = [page('E', SPEND_ORIGIN + '.evil.tld/ai-tools/spend'), page('R', SPEND_URL)];
  const { cdp, calls } = fakeCdp({ lists: [targets], newTab: null });
  const { tab, created } = await findOrOpenSpendTab({ cdp, waitMs: 0 });
  assert.equal(tab.id, 'R', 'the real dashboard is the only acceptable target');
  assert.equal(created, false);
  assert.ok(!calls.some((c) => c.includes('/json/new')), 'an existing dashboard tab must be reused');
});

test('findOrOpenSpendTab: opens its own tab rather than use any near-miss target', async () => {
  const targets = [
    page('1', SPEND_ORIGIN + '.evil.tld/ai-tools/spend'),          // our origin as a prefix of theirs
    page('2', 'http://ai-tool-dashboard.example.com/ai-tools/spend'), // scheme downgrade
    page('3', 'https://evil.tld/?next=' + SPEND_URL),                // our url in the query
    { id: '4', type: 'iframe', url: SPEND_URL, webSocketDebuggerUrl: 'ws://x' }, // right origin, not a page
    page('5', SPEND_URL, null),                                      // right origin, no debugger url
  ];
  const { cdp, calls } = fakeCdp({ lists: [targets], newTab: null });
  await assert.rejects(() => findOrOpenSpendTab({ cdp, waitMs: 0 }), (e) => e.code === 'cdp-unreachable');
  assert.ok(calls.some((c) => c.startsWith('PUT /json/new')), 'none of those may be picked — it must open its own');
});

test('findOrOpenSpendTab: a freshly opened tab counts only once it LANDS on the dashboard origin', async () => {
  const midSso = page('N', 'https://login.microsoftonline.com/common/oauth2/authorize?redirect=' + SPEND_URL);
  const landed = page('N', SPEND_URL);
  const { cdp } = fakeCdp({ lists: [[], [midSso], [landed]], newTab: { id: 'N' } });
  const { tab, created } = await findOrOpenSpendTab({ cdp, waitMs: 5000, pollMs: 1 });
  assert.equal(created, true);
  assert.equal(tab.url, SPEND_URL, 'the mid-SSO url must not be mistaken for the dashboard');
});

test('findOrOpenSpendTab: a tab that ends up on a lookalike origin is never handed back', async () => {
  const { cdp } = fakeCdp({ lists: [[], [page('N', SPEND_ORIGIN + '.evil.tld/ai-tools/spend')]], newTab: { id: 'N' } });
  await assert.rejects(() => findOrOpenSpendTab({ cdp, waitMs: 40, pollMs: 1 }), (e) => e.code === 'auth');
});
