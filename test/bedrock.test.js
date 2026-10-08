'use strict';
// lib/bedrock.js — "which models may this machine's Bedrock role invoke?".
//
// The fixtures below are NOT invented: they are the verbatim answers of bedrock-runtime in
// eu-central-1 on 2026-09-24, measured with the empty-body probe this module sends (account
// 123456789012, role BedrockFederatedRole). They are pinned because the whole module rests on ONE
// assumption about AWS — that authorization is evaluated BEFORE request validation, so "400 because the
// body is empty" proves the call was allowed — and if that ever changes, a test has to fail rather than
// the dropdown quietly hiding every model the user has.
//
// The 403 InvalidSignatureException row is the one that matters most: the first measurement of this
// account signed the path as sent instead of twice-encoding the colon in "…-v1:0", got that error for
// every colon-bearing id, and wrote "Haiku 4.5 and Sonnet 4.5 are forbidden" into a memory file. They
// are not. A 403 is only a denial when AWS names it AccessDenied.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifyProbe, bedrockConfig, regionPrefix, readAwsCreds, credsExpired, parseIni } = require('../lib/bedrock');

const MEASURED = [
  { what: 'authorized (only the empty body was rejected)', verdict: 'allowed',
    raw: { status: 400, errType: 'ValidationException', message: "'messages' must not be empty" } },
  { what: 'authorized, older profile wording', verdict: 'allowed',
    raw: { status: 400, errType: 'ValidationException', message: 'messages: Field required' } },
  { what: 'no such model under this prefix', verdict: 'absent',
    raw: { status: 400, errType: 'ValidationException', message: 'The provided model identifier is invalid.' } },
  { what: 'forbidden by the IAM policy', verdict: 'denied',
    raw: { status: 403, errType: 'AccessDeniedException',
      message: 'User: arn:aws:sts::123456789012:assumed-role/BedrockFederatedRole/jane.doe@example.com is not authorized to perform: bedrock:InvokeModelWithResponseStream' } },
  { what: 'our own signing bug — NOT a statement about entitlement', verdict: 'unknown',
    raw: { status: 403, errType: 'InvalidSignatureException', message: 'The request signature we calculated does not match the signature you provided.' } },
];

describe('classifyProbe', () => {
  for (const c of MEASURED) {
    it(`${c.raw.status} ${c.raw.errType} → ${c.verdict} (${c.what})`, () => {
      assert.equal(classifyProbe(c.raw), c.verdict);
    });
  }
  it('an expired session is unknown, never a denial (it would empty the whole dropdown)', () => {
    assert.equal(classifyProbe({ status: 403, errType: 'ExpiredTokenException', message: 'The security token included in the request is expired' }), 'unknown');
  });
  it('no answer at all (VPN down, timeout) is unknown', () => {
    for (const r of [{ status: 0, errType: 'NetworkError' }, { status: 0, errType: 'Timeout' }, { status: 500 }, null])
      assert.equal(classifyProbe(r), 'unknown');
  });
  it('a real 200 is allowed', () => assert.equal(classifyProbe({ status: 200 }), 'allowed'));
});

describe('bedrockConfig', () => {
  const clean = (fn) => {
    const keep = {};
    for (const k of ['CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE']) { keep[k] = process.env[k]; delete process.env[k]; }
    try { return fn(); } finally { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  };
  it('reads the switch out of the settings.json env block (the only place it exists on this machine)', () => clean(() => {
    const cfg = bedrockConfig({ env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-central-1', AWS_PROFILE: 'ClaudeCode' } });
    assert.deepEqual(cfg, { enabled: true, region: 'eu-central-1', profile: 'ClaudeCode' });
  }));
  it('a real env var wins over settings.json — the order the CLI itself applies them in', () => clean(() => {
    process.env.AWS_REGION = 'us-east-1';
    assert.equal(bedrockConfig({ env: { CLAUDE_CODE_USE_BEDROCK: 'true', AWS_REGION: 'eu-central-1' } }).region, 'us-east-1');
  }));
  it('no settings, no env → not on Bedrock (first-party menu stays untouched)', () => clean(() => {
    for (const s of [null, {}, { env: null }, { env: { CLAUDE_CODE_USE_BEDROCK: '0' } }])
      assert.equal(bedrockConfig(s).enabled, false);
  }));
  it('profile defaults to "default", region is NOT guessed (a wrong region = wrong ids)', () => clean(() => {
    const cfg = bedrockConfig({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } });
    assert.equal(cfg.profile, 'default');
    assert.equal(cfg.region, '');
  }));
});

describe('regionPrefix', () => {
  it('maps an AWS region to the GEO prefix of the cross-region inference profile', () => {
    assert.equal(regionPrefix('eu-central-1'), 'eu');
    assert.equal(regionPrefix('eu-west-3'), 'eu');
    assert.equal(regionPrefix('ap-northeast-1'), 'apac');
    assert.equal(regionPrefix('us-east-1'), 'us');
    assert.equal(regionPrefix('us-gov-west-1'), 'us-gov');
    assert.equal(regionPrefix(''), 'us', 'the CLI default, and a wrong guess surfaces as "absent"');
  });
});

describe('AWS credentials file', () => {
  it('parses the INI the corporate auth helper writes, incl. its non-standard x-expiration', () => {
    const ini = parseIni([
      '# written by corporate-auth-helper',
      '[ClaudeCode]',
      'aws_access_key_id = AKIAEXAMPLE',
      'aws_secret_access_key = secret/value+with=chars',
      'aws_session_token = tok==',
      'x-expiration = 2026-09-25T00:51:17Z',
      '',
      '[other]',
      'aws_access_key_id = NOPE',
    ].join('\n'));
    assert.equal(ini.ClaudeCode.aws_access_key_id, 'AKIAEXAMPLE');
    assert.equal(ini.ClaudeCode.aws_secret_access_key, 'secret/value+with=chars', 'a value may contain = and /');
    assert.equal(ini.ClaudeCode['x-expiration'], '2026-09-25T00:51:17Z');
    assert.equal(ini.other.aws_access_key_id, 'NOPE');
  });

  it('readAwsCreds finds the named profile and nothing else', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-aws-')), 'credentials');
    fs.writeFileSync(file, '[ClaudeCode]\naws_access_key_id=A\naws_secret_access_key=B\naws_session_token=C\nx-expiration=2099-01-01T00:00:00Z\n');
    const keep = process.env.AWS_SHARED_CREDENTIALS_FILE;
    process.env.AWS_SHARED_CREDENTIALS_FILE = file;
    try {
      const c = readAwsCreds('ClaudeCode');
      assert.equal(c.accessKeyId, 'A');
      assert.equal(c.expiration, '2099-01-01T00:00:00Z');
      assert.equal(readAwsCreds('missing'), null, 'an unknown profile is null, not half a credential');
    } finally {
      if (keep === undefined) delete process.env.AWS_SHARED_CREDENTIALS_FILE; else process.env.AWS_SHARED_CREDENTIALS_FILE = keep;
      fs.rmSync(path.dirname(file), { recursive: true, force: true }); // every verify run left one ccui-aws-* behind
    }
  });

  it('credsExpired only claims expiry when it can read a date', () => {
    assert.equal(credsExpired({ expiration: '2000-01-01T00:00:00Z' }), true);
    assert.equal(credsExpired({ expiration: '2099-01-01T00:00:00Z' }), false);
    for (const c of [null, {}, { expiration: '' }, { expiration: 'soon' }]) assert.equal(credsExpired(c), false);
  });
});
