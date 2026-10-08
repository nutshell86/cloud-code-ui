'use strict';
// PR-9c — the five LOW-severity security points and the two honesty points next to them. All five were
// LATENT when they were written down, and that is the trap this suite is built against: a latent hole
// invites a fix that claims more than it does. So every case below pins BOTH halves — what the guard
// catches, and what it demonstrably does not.
//
// Covered here (pure, no server, no spawn):
//   SEC-3        args/url masking (lib/core) + its four readers, and the ONE place it must NOT happen
//   SEC-7        CSV formula neutralisation that keeps negative numbers intact (public/js/csv.js)
//   CHAT-SEC-1   the CSP the HTML preview wraps its markup in (public/js/render.js previewDoc)
//   FLOW-3       the live permission-mode switch waits for the CLI's verdict (lib/chat setChatMode)
// SEC-4 lives in test/github.test.js (it is about the git env), SEC-5 and FLOW-5 in
// test/schedules.test.js (route contracts), FLOW-7 in test/engine-policy.test.js, and the probe points
// in test/mcp-probe.test.js.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
// Own sandbox before lib/mcp, for the same reason test/mcp.test.js has one: lib/paths resolves
// CLAUDE_UI_CLAUDE_JSON at require time, and a bare `node --test` would otherwise read the real config.
const { makeSandbox } = require('./sandbox');
const SBX = makeSandbox('sec-low', { fakeCli: true });
Object.assign(process.env, SBX.env);
const core = require('../lib/core');
const { parseMcpGet, mcpGetPayload, mcpRowSafe, parseMcpTarget, configuredServers } = require('../lib/mcp');
const { csvCell, csvRows } = require('../public/js/csv');

// ---------------------------------------------------------------- SEC-3: args and url
// The masking in this project judged key→value MAPS (env, headers). An MCP server's `args` and `url`
// reach the browser and the Markdown inventory as single strings, and nothing looked at them.
describe('SEC-3 — argv and URL masking (lib/core)', () => {
  it('masks a token-shaped argv token, and leaves commands, paths and flags alone', () => {
    const argv = ['/c', 'npx', '@kraft2/ghe-mcp@latest', '--browser', 'msedge', 'C:\\Users\\x\\.claude\\dist\\index.js'];
    assert.deepEqual(core.maskArgv(argv), argv, 'a real configured argv of this machine must not be touched');
    // the shapes that ARE caught
    assert.match(core.maskArgToken('ghp_0123456789abcdefghijklmnopqrstuvwxyzAB'), /^gh••••AB$/);
    assert.match(core.maskArgToken('Bearer abc'), /••••/);
    assert.match(core.maskArgToken('Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0MTIzNDU2Nzg5'), /••••/);
  });

  it('masks the VALUE of a secret-named pair, both separators, and keeps the name readable', () => {
    assert.equal(core.maskArgToken('--token=supersecretvalue12345'), '--token=su••••45');
    assert.equal(core.maskArgToken('Authorization: Bearer abc'), 'Authorization: Be••••bc');
    // a harmless pair stays byte-identical — including the two shapes that must NOT be torn apart
    assert.equal(core.maskArgToken('C:\\Users\\x\\server.js'), 'C:\\Users\\x\\server.js');
    assert.equal(core.maskArgToken('https://mcp.example.net/mcp/'), 'https://mcp.example.net/mcp/');
    assert.equal(core.maskArgToken('--port=8787'), '--port=8787');
  });

  it('masks the token that FOLLOWS a secret-named flag — the thing a per-token rule cannot see', () => {
    assert.deepEqual(core.maskArgv(['mcp-remote', '--header', 'Authorization: Bearer abc', 'x']),
      ['mcp-remote', '--header', 'Authorization: Be••••bc', 'x']);
    assert.deepEqual(core.maskArgv(['srv', '--api-key', 'short', '--keep']), ['srv', '--api-key', '••••', '--keep']);
    // …and a flag whose name says nothing leaves its value alone: that is the documented GAP
    assert.deepEqual(core.maskArgv(['srv', '--key', 'abc']), ['srv', '--key', 'abc'],
      'a short secret behind a harmless flag is NOT covered — if this ever changes, say so in lib/core');
  });

  it('a printed argv line keeps its quoting', () => {
    assert.equal(core.maskArgsLine('node "C:\\Program Files\\s.js" --token=supersecretvalue12345'),
      'node "C:\\Program Files\\s.js" --token=su••••45');
    assert.equal(core.maskArgsLine(''), '', 'an empty line must not become " "');
  });

  it('a URL loses its userinfo password and its secret-named query values — and nothing else', () => {
    assert.equal(core.maskUrl('https://user:hunter2hunter2@git.example.net/x.git'), 'https://user:hu••••r2@git.example.net/x.git');
    assert.equal(core.maskUrl('https://h/mcp?token=abcdefghijklmnop&tenant=acme'), 'https://h/mcp?token=ab••••op&tenant=acme');
    // byte-identical when there is nothing to mask: a panel that prints a NORMALISED url (trailing
    // slash added, characters percent-encoded) would be telling its own small lie about the config
    const plain = 'https://mcp-atlassian.example.com/mcp/';
    assert.equal(core.maskUrl(plain), plain);
    assert.equal(core.maskUrl('https://h/a%20b?x=1'), 'https://h/a%20b?x=1');
    // the documented GAP: a secret in a PATH segment has no key name and no shape to judge
    const webhook = 'https://hooks.example.com/services/T0001/B0002/abcdefghijklmnopqrst';
    assert.equal(core.maskUrl(webhook), webhook, 'a path-segment secret is NOT covered — documented in lib/core');
  });

  it('maskTransport picks the right rule for the two shapes a transport has', () => {
    assert.equal(core.maskTransport('https://u:verysecretpassword@h/mcp'), 'https://u:ve••••rd@h/mcp');
    assert.equal(core.maskTransport('cmd /c npx pkg@latest'), 'cmd /c npx pkg@latest');
    assert.equal(core.maskTransport('node s.js --token=supersecretvalue12345'), 'node s.js --token=su••••45');
  });
});

describe('SEC-3 — the four readers that used to get it raw', () => {
  const GET_STDOUT = [
    'srv:', '  Scope: User config', '  Status: ✔ connected', '  Type: stdio',
    '  Command: node', '  Args: s.js --token=supersecretvalue12345', '  URL: https://u:hunter2hunter2@h/mcp',
  ].join('\n');

  it('parseMcpGet masks args and url (→ /api/mcp/get, "Config kopieren", the Markdown inventory)', () => {
    const d = parseMcpGet(GET_STDOUT);
    assert.equal(d.args, 's.js --token=su••••45');
    assert.equal(d.url, 'https://u:hu••••r2@h/mcp');
    assert.equal(d.command, 'node', 'a plain command must stay readable');
    // and nothing unmasked survives the whole payload — the F1 rule, now for these two fields too
    const wire = JSON.stringify(mcpGetPayload('srv', GET_STDOUT, null));
    assert.ok(!wire.includes('supersecretvalue12345'), 'the args secret reached the browser');
    assert.ok(!wire.includes('hunter2hunter2'), 'the url password reached the browser');
  });

  it('mcpRowSafe masks the `transport` line the MCP tiles print', () => {
    assert.deepEqual(mcpRowSafe({ name: 'a', transport: 'node s.js --token=supersecretvalue12345' }),
      { name: 'a', transport: 'node s.js --token=su••••45' });
    assert.deepEqual(mcpRowSafe({ name: 'b' }), { name: 'b' }, 'a row without a transport is handed back as it came');
  });

  // The MIRROR of the fix, and the reason the mask sits in the ROUTES and not in configuredServers():
  // that same `transport` string is ALSO the input to parseMcpTarget / pkgEntryMtime / npmInfo. A mask
  // applied one layer too early classifies `npx pkg@latest` by its masked text and silently kills every
  // update check — logic thrown away by the guard that was meant to protect it, which is this repo's
  // other recurring failure. So the contract is pinned at the SOURCE: configuredServers() hands back the
  // config byte-for-byte, secret and all, because nothing it feeds goes to a browser.
  it('…but configuredServers() must hand the transport back RAW — the mask belongs in the route', async () => {
    const SECRET = '--token=supersecretvalue12345';
    const raw = fs.readFileSync(SBX.env.CLAUDE_UI_CLAUDE_JSON, 'utf8');
    try {
      fs.writeFileSync(SBX.env.CLAUDE_UI_CLAUDE_JSON, JSON.stringify({ mcpServers: {
        np: { command: 'npx', args: ['-y', 'some-pkg@latest', SECRET] },
      } }));
      const [row] = await configuredServers();
      assert.equal(row.transport, 'npx -y some-pkg@latest ' + SECRET, 'masked here, and the update check is blind');
      assert.deepEqual(parseMcpTarget(row.transport), { kind: 'npm', pkg: 'some-pkg' });
      // …and the ROUTE's view of the same row is the masked one
      assert.equal(mcpRowSafe(row).transport, 'npx -y some-pkg@latest --token=su••••45');
    } finally { fs.writeFileSync(SBX.env.CLAUDE_UI_CLAUDE_JSON, raw); }
  });

  it('mcpStatusRowSafe keeps its allow-list AND masks the one field it lets through', () => {
    // PR-10 made `config` an allow-list because masking judges by key NAME, so `X-Internal-Token` walks
    // through. `url` is allowed BECAUSE the panel renders it — and a url can carry a credential in its own
    // VALUE (userinfo, a `?token=`), which an allow-list cannot see and maskUrl can. Both halves, one row.
    const { mcpStatusRowSafe } = require('../lib/chat');
    const row = mcpStatusRowSafe({
      name: 'jira', status: 'connected',
      config: { type: 'http', url: 'https://u:hunter2hunter2@h/mcp?token=abcdefghijklmnop', headers: { 'X-Internal-Token': 'PROBE-SECRET-AAA111' }, scope: 'dynamic' },
    });
    assert.deepEqual(Object.keys(row.config).sort(), ['type', 'url', 'withheld']);
    assert.equal(row.config.url, 'https://u:hu••••r2@h/mcp?token=ab••••op');
    assert.equal(row.config.withheld, 2, 'the panel must be able to SAY that something was held back');
    assert.ok(!JSON.stringify(row).includes('PROBE-SECRET-AAA111'));
    assert.ok(!JSON.stringify(row).includes('hunter2hunter2'));
  });
});

// ---------------------------------------------------------------- SEC-7: CSV
describe('SEC-7 — CSV formula neutralisation that does not break the numbers', () => {
  it('neutralises what can never be a number', () => {
    assert.equal(csvCell('=1+1'), "'=1+1");
    assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(csvCell('\tleading tab'), "'\tleading tab");
    // the DDE family: prefixed, and NOT quoted — the payload holds no ", comma or newline, so the quoting
    // rule has nothing to do. The neutralisation is the `'`, never the quotes (Excel strips those and
    // evaluates what is inside, which is why quoting alone was never a fix).
    assert.equal(csvCell("=cmd|' /C calc'!A0"), "'=cmd|' /C calc'!A0");
  });

  it('leaves a NEGATIVE NUMBER alone — the trap in every standard recipe', () => {
    // The usual advice prefixes `'` to anything starting with - or +, which turns every negative number
    // in /api/usage.csv into text and stops the column summing. That is a data defect introduced by a fix
    // for a data defect. The property asserted is the absence of the PREFIX; the comma variant is still
    // quoted, because a comma inside a field is a CSV question and has nothing to do with formulas.
    for (const n of ['-5', '-5.25', '-5,25', '+3', '-.5', '-1.2e-3', '+0', '0', '5']) {
      assert.ok(!csvCell(n).includes("'"), n + ' was turned into text by a formula prefix: ' + csvCell(n));
    }
    for (const n of ['-5', '-5.25', '+3', '-.5', '-1.2e-3']) {
      assert.equal(csvCell(n), n, n + ' must survive byte-identical');
    }
    assert.equal(csvCell('-5,25'), '"-5,25"', 'a decimal COMMA still needs CSV quoting — and only that');
  });

  it('…but a non-number starting with - or + IS neutralised', () => {
    assert.equal(csvCell('-- siehe unten'), "'-- siehe unten");
    assert.equal(csvCell('-5+cmd'), "'-5+cmd");
    assert.equal(csvCell('+ADD'), "'+ADD");
    // the KNOWN limit, pinned so it is a decision and not a surprise: a grouped number is not recognised
    assert.equal(csvCell('-1,234.56'), '"\'-1,234.56"', 'documented limit — no numeric cell this project writes is grouped');
  });

  it('still quotes exactly what RFC 4180 needs, and nothing more', () => {
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('two\nlines'), '"two\nlines"');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(undefined), '');
    assert.equal(csvCell(0), '0');
  });

  it('csvRows joins with CRLF, the way all three writers did', () => {
    assert.equal(csvRows([['a', 'b'], ['=x', '-5']]), "a,b\r\n'=x,-5");
  });

  it('and the three writers really use it — a shared rule nobody calls is not a rule', () => {
    const usage = fs.readFileSync(path.join(__dirname, '..', 'lib', 'usage.js'), 'utf8');
    assert.match(usage, /require\('\.\.\/public\/js\/csv'\)/, 'lib/usage.js must not keep its own esc()');
    const views = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views-uiskills.js'), 'utf8');
    assert.equal((views.match(/csvRows\(/g) || []).length, 2, 'resultToCsv AND exportHistory');
    assert.doesNotMatch(views, /\/\[",\\n\\r\]\/\.test/, 'a local esc() left behind means one of the two exports is unprotected');
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.match(html, /<script src="\/js\/csv\.js"><\/script>/, 'the browser half must actually be loaded');
    assert.ok(html.indexOf('/js/csv.js') < html.indexOf('/js/views-uiskills.js'), 'and loaded before its caller');
  });
});

// ---------------------------------------------------------------- CHAT-SEC-1: the preview CSP
// render.js is a classic script; node:vm loads the real file with stubs for the free variables it uses,
// the same harness test/status-strip.test.js introduced. No jsdom — this repo has no dependencies.
function loadPreviewDoc() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'render.js'), 'utf8');
  const ctx = {
    document: { createElement: () => ({ setAttribute() {}, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} }, style: {} }), addEventListener() {} },
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), localStorage: { getItem: () => null, setItem() {} } },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { clipboard: null, userAgent: '' },
    $: () => null, $$: () => [], el: () => ({ appendChild() {}, classList: { toggle() {}, add() {}, remove() {} } }),
    t: (k) => String(k), tt: (k) => String(k), setTimeout, clearTimeout, console,
  };
  vm.createContext(ctx);
  // Only the ONE function is needed, and the file's top level touches the DOM — so the function is
  // extracted by source and evaluated on its own. Brittle on purpose: if previewDoc is renamed or
  // removed, this throws instead of silently testing nothing.
  const start = src.indexOf('function previewDoc(');
  assert.ok(start > 0, 'previewDoc is gone from public/js/render.js');
  const end = src.indexOf('\nfunction renderSidecar(', start);
  assert.ok(end > start, 'previewDoc no longer sits in front of renderSidecar');
  vm.runInContext(src.slice(start, end) + '\n', ctx);
  return { fn: ctx.previewDoc, src };
}

describe('CHAT-SEC-1 — the HTML preview runs under a CSP, not only in a sandbox', () => {
  const { fn: previewDoc, src } = loadPreviewDoc();

  it('the CSP meta is the FIRST thing in a real <head>, whatever the markup was', () => {
    // A meta CSP outside <head> is ignored, and the input ranges from a bare fragment to a full document
    // with its own head — which is exactly why this wraps instead of inserting.
    for (const input of ['<table><tr><td>x</td></tr></table>', '<!doctype html><html><head><title>t</title></head><body>b</body></html>', '']) {
      const out = previewDoc(input);
      assert.match(out, /^<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"/);
      const headEnd = out.indexOf('</head>');
      assert.ok(out.indexOf('Content-Security-Policy') < headEnd, 'the policy must be inside the head');
      if (input) assert.ok(out.includes(input), 'the markup itself must survive verbatim');
    }
  });

  it('blocks every remote subresource — the thing `sandbox=""` does NOT block', () => {
    const csp = /content="([^"]+)"/.exec(previewDoc('<p>x</p>').split('Content-Security-Policy')[1])[1];
    assert.match(csp, /(^|;\s*)default-src 'none'/, 'without this, <img src=https://…> still calls out');
    for (const bad of ['connect-src', 'font-src', 'media-src', 'form-action', 'script-src']) {
      assert.ok(!csp.includes(bad), bad + ' must stay at default-src \'none\' rather than be granted');
    }
    // the three exceptions a preview needs, and their limits
    assert.match(csp, /style-src 'unsafe-inline'/, 'inline CSS is how such markup is styled');
    assert.match(csp, /img-src data:/);
    assert.ok(!/img-src[^;]*https?:/.test(csp), 'a remote image is a read receipt — it must stay blocked');
  });

  it('and the sandbox attribute is still there — the CSP is a second lock, not a replacement', () => {
    assert.match(src, /frame\.setAttribute\('sandbox', ''\)/);
    assert.match(src, /frame\.srcdoc = previewDoc\(html\)/, 'the raw markup must not be assigned directly any more');
  });
});

// ---------------------------------------------------------------- FLOW-3: the live mode switch
// A stub chat, like test/chatargs.test.js uses for the effort switch: setChatMode only touches
// chat.proc.stdin, chat.pendingControls and chat.meta, and what matters is what it does with the ANSWER.
function stubChat(answer) {
  const sent = [];
  const chat = {
    meta: { permissionMode: 'plan' },
    pendingControls: new Map(),
    proc: { stdin: { writable: true, write(line) {
      const obj = JSON.parse(line);
      sent.push(obj);
      const waiter = chat.pendingControls.get(obj.request_id);
      if (!waiter || answer === 'silent') return true;
      setImmediate(() => waiter(Object.assign({ request_id: obj.request_id }, answer)));
      return true;
    } } },
  };
  return { chat, sent };
}

describe('FLOW-3 — the live permission-mode switch reports the CLI, not the wish', () => {
  const { setChatMode } = require('../lib/chat');

  it('a REFUSAL is a refusal — not a green switch over an unchanged session', async () => {
    // MEASURED refusal reasons in claude.exe 2.1.288: invalid_mode, bypass_restricted, bypass_disabled,
    // bypass_not_launched (+ the auto_* family). Three of those are about bypassPermissions, i.e. exactly
    // the mode a managed policy takes away.
    const { chat } = stubChat({ subtype: 'error', error: 'bypassPermissions is restricted by your organization (bypass_restricted)' });
    const r = await setChatMode(chat, 'bypassPermissions');
    assert.equal(r.ok, false);
    assert.match(r.error, /bypass_restricted/, "the CLI's own wording has to reach the user");
    assert.equal(chat.meta.permissionMode, 'plan', 'and the session must not be recorded as switched');
  });

  it('the mode the SESSION reports wins over the one that was asked for', async () => {
    // The success payload echoes „the permission mode now in effect" (headless CLIs echo it) — so when the
    // CLI lands somewhere else, that is what the chip has to show.
    const { chat } = stubChat({ subtype: 'success', response: { mode: 'default' } });
    const r = await setChatMode(chat, 'acceptEdits');
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'default');
    assert.equal(r.unconfirmed, false);
    assert.equal(chat.meta.permissionMode, 'default');
  });

  it('an empty success acknowledgement falls back to the requested mode', async () => {
    // „other hosts may acknowledge with an empty object" — then the request IS the best information there is.
    const { chat } = stubChat({ subtype: 'success', response: {} });
    const r = await setChatMode(chat, 'acceptEdits');
    assert.deepEqual([r.ok, r.mode, r.unconfirmed], [true, 'acceptEdits', false]);
    assert.equal(chat.meta.permissionMode, 'acceptEdits');
  });

  it('a dead pipe is a failure, not a success', async () => {
    const chat = { meta: { permissionMode: 'plan' }, pendingControls: new Map(), proc: { stdin: { writable: false } } };
    const r = await setChatMode(chat, 'default');
    assert.equal(r.ok, false);
    assert.equal(chat.meta.permissionMode, 'plan');
  });

  it('nobody answered → the optimistic value stands, but it is LABELLED unconfirmed', async () => {
    // controlRequest resolves {ok:true, unconfirmed:true} on its CONTROL_TIMEOUT_MS (5 s), so `.ok` alone
    // proves nothing. The 5 s are really waited here rather than cut with a new env seam: a production
    // constant that exists for a test is the kind of thing that later gets set in production.
    const { chat } = stubChat('silent');
    const r = await setChatMode(chat, 'acceptEdits');
    assert.equal(r.ok, true);
    assert.equal(r.unconfirmed, true, 'a timeout must be distinguishable from a confirmed switch');
    assert.equal(r.mode, 'acceptEdits', 'the optimistic value stands — it is just not presented as fact');
    assert.equal(chat.meta.permissionMode, 'acceptEdits');
  });

  it('and the browser reads `mode` out of the answer instead of its own pick', () => {
    // Vokabular ohne Leser: the route may return the effective mode, but if applyLiveMode kept painting
    // the picked value the whole fix would be invisible — which is this repo's recurring failure.
    const chatJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');
    const fn = chatJs.slice(chatJs.indexOf('async function applyLiveMode('), chatJs.indexOf('const LIVE_EFFORT_LEVELS'));
    assert.match(fn, /const effective = \(r && typeof r\.mode === 'string' && r\.mode\) \? r\.mode : mode/);
    assert.match(fn, /t\.permissionMode = effective/);
    assert.match(fn, /r\.unconfirmed/, 'an unconfirmed switch must not read as a success');
    const renderJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat-render.js'), 'utf8');
    const plan = renderJs.slice(renderJs.indexOf('async function approvePlanMode('), renderJs.indexOf('function resolvePlanGate('));
    assert.match(plan, /r\.mode/, 'the ExitPlanMode path assumed its own "default" landed');
  });
});
