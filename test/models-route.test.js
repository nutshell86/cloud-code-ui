'use strict';
// GET /api/models — the wiring between the settings file, the Bedrock branch and the dropdown.
//
// This route is the one the 403 came through. On Bedrock, `~/.claude.json` carries no entitlement data
// at all, so the console-mirroring menu offers whatever the CLI knows and the "Default" entry inherits
// settings.json `model` unseen — which is how every new chat ended up starting a model the AWS role may
// not invoke. Boots a throwaway server against a temp ~/.claude (CLAUDE_UI_CLAUDE_DIR) and a temp
// ~/.claude.json (CLAUDE_UI_CLAUDE_JSON), and points AWS_SHARED_CREDENTIALS_FILE at a file that does not
// exist so the probe cannot reach the network from a test.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const os = require('os');
const fsp = require('fs/promises');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Every booted server reads the binary's --help at listen (PR-S, the --system-prompt-snapshot probe).
// Under verify.js the sandbox env brings the fake along; run on its own (`node --test` on this file) the
// server would otherwise spawn the machine's REAL claude.exe for it — no model call, but a test that
// touches the real binary all the same. So the seam is set here, not inherited.
const FAKE = path.join(ROOT, 'fake-claude.js').replace(/\\/g, '/');

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function get(port, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch {} resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject); r.end();
  });
}
async function waitUp(port, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await get(port, '/api/state'); if (r.status === 200) return; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('server did not come up on :' + port);
}

async function boot(settings, env) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-models-test-'));
  const claudeDir = path.join(dir, 'claude');
  await fsp.mkdir(claudeDir, { recursive: true });
  await fsp.writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));
  await fsp.writeFile(path.join(dir, 'claude.json'), '{}'); // no entitlement caches — exactly like a Bedrock machine
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, CLAUDE_UI_PORT: String(port), CLAUDE_UI_DATA_DIR: dir, CLAUDE_UI_FAKE_BIN: FAKE,
      CLAUDE_UI_CLAUDE_DIR: claudeDir, CLAUDE_UI_CLAUDE_JSON: path.join(dir, 'claude.json'),
      AWS_SHARED_CREDENTIALS_FILE: path.join(dir, 'no-such-credentials'),
      CLAUDE_CODE_USE_BEDROCK: '', AWS_REGION: '', AWS_PROFILE: '', // the fixture's settings.json decides
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitUp(port);
  return { port, dir, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill(); setTimeout(r, 1500); }) };
}

describe('GET /api/models — first-party machine', () => {
  let S;
  before(async () => { S = await boot({}, {}); });
  after(async () => { if (S) { await S.stop(); await fsp.rm(S.dir, { recursive: true, force: true }).catch(() => {}); } });

  it('no Bedrock switch → the console menu, and the client is told Bedrock is off', async () => {
    const r = await get(S.port, '/api/models');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.bedrock, { enabled: false });
    assert.deepEqual(r.json.models.map((m) => m.label), ['Default', 'Opus (1M)', 'Sonnet', 'Haiku']);
    assert.ok(r.json.pricing['claude-opus-5'], 'pricing rides along for the client-side turn cost');
  });
});

describe('GET /api/models — Bedrock machine whose default model cannot be measured', () => {
  let S;
  before(async () => {
    S = await boot({
      env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-central-1', AWS_PROFILE: 'ClaudeCode' },
      model: 'global.anthropic.claude-fable-5-1', // the value that produced the incident
    }, {});
  });
  after(async () => { if (S) { await S.stop(); await fsp.rm(S.dir, { recursive: true, force: true }).catch(() => {}); } });

  it('reports the Bedrock context it read out of settings.json', async () => {
    const b = (await get(S.port, '/api/models')).json.bedrock;
    assert.equal(b.enabled, true);
    assert.equal(b.region, 'eu-central-1');
    assert.equal(b.profile, 'ClaudeCode');
  });

  it('names the default model and says the measurement failed instead of pretending it passed', async () => {
    const b = (await get(S.port, '/api/models')).json.bedrock;
    assert.equal(b.error, 'no-credentials');
    assert.equal(b.defaultModel.id, 'global.anthropic.claude-fable-5-1');
    assert.equal(b.defaultModel.verdict, 'unknown', 'unmeasured is not "fine" and not "denied"');
  });

  it('an unmeasurable machine still gets a usable dropdown (never empty)', async () => {
    const r = await get(S.port, '/api/models');
    assert.ok(r.json.models.length >= 2);
    assert.equal(r.json.models[0].value, '');
  });
});
