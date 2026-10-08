'use strict';
// Which Claude models may this machine's Bedrock role actually invoke?
//
// Nothing on disk answers that. With `CLAUDE_CODE_USE_BEDROCK=1` the CLI stops writing its
// entitlement caches into ~/.claude.json (see the Bedrock section in lib/models.js) because the
// answer lives in an AWS IAM policy — and a policy is not readable from here either: listing it needs
// `iam:GetRolePolicy`, which a federated Bedrock role does not have. The only honest source is Bedrock
// itself, so the panel asks it.
//
// THE PROBE COSTS NOTHING. It POSTs an EMPTY body (`{}`) to
// `/model/<id>/invoke-with-response-stream`. AWS evaluates signature → IAM authorization → request
// validation in that order, so an authorized model gets as far as validation and answers
// 400 ValidationException ("'messages' must not be empty") without ever reaching the model; a
// forbidden one is stopped one step earlier with 403 AccessDeniedException. No tokens, no billing.
// Measured against eu-central-1 on 2026-09-24 for every verdict this file can produce.
//
// GOTCHA that cost the first measurement its credibility: SigV4 requires each path segment to be
// URI-encoded TWICE for every service except S3. Model ids carry a colon (`…-v1:0`), so signing the
// path as sent produces 403 **InvalidSignatureException** — which looks exactly like a denial in a
// status-code table and made Haiku 4.5 and Sonnet 4.5 look forbidden when they are not. Hence
// `signedPath` vs `requestPath` below, and hence 403 is only read as a denial when AWS names the
// error AccessDenied.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { BEDROCK_ACCESS_FILE } = require('./paths');
const { BEDROCK_CANDIDATES, bedrockBase } = require('./models');
const { errorText } = require('./core'); // the one rule for "what of an exception may a client read"

const SERVICE = 'bedrock';
const PROBE_BODY = '{}';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // a probe is free; this only keeps /api/models off the network

// Is this machine on Bedrock, and with which region/profile? The CLI reads its own settings.json `env`
// block into the environment of every run, so that block is as authoritative as a real env var here —
// and on this machine it is the ONLY place the Bedrock switch exists. A real env var still wins,
// because that is the order the CLI itself applies them in.
function bedrockConfig(settingsParsed) {
  const senv = (settingsParsed && typeof settingsParsed.env === 'object' && settingsParsed.env) || {};
  const pick = (k) => String(process.env[k] || senv[k] || '').trim();
  const flag = pick('CLAUDE_CODE_USE_BEDROCK');
  return {
    enabled: /^(1|true|yes)$/i.test(flag),
    region: pick('AWS_REGION') || pick('AWS_DEFAULT_REGION') || '',
    profile: pick('AWS_PROFILE') || 'default',
  };
}

// Cross-region inference profiles are prefixed by GEO, not by region: eu-central-1 → "eu.…".
// Anything unmapped falls back to "us." — the CLI's own default — and the probe will simply report
// "absent" if that is wrong, which is visible rather than silently wrong.
function regionPrefix(region) {
  const r = String(region || '').toLowerCase();
  if (r.startsWith('eu-')) return 'eu';
  if (r.startsWith('ap-')) return 'apac';
  if (r.startsWith('us-gov-')) return 'us-gov';
  return 'us';
}

// ~/.aws/credentials is an INI file; the corporate auth helper rewrites the [ClaudeCode] section on every
// `helper auth` and adds a non-standard `x-expiration`. Only the keys named here are read, and the
// secret material never leaves this module (callers get `expiration` and nothing else).
function credentialsPath() {
  return process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), '.aws', 'credentials');
}
function parseIni(text) {
  const out = {};
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) { cur = sec[1].trim(); out[cur] = out[cur] || {}; continue; }
    if (!cur) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[cur][line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}
function readAwsCreds(profile) {
  let ini;
  try { ini = parseIni(fs.readFileSync(credentialsPath(), 'utf8')); } catch { return null; }
  const sec = ini[profile] || ini[`profile ${profile}`];
  if (!sec || !sec.aws_access_key_id || !sec.aws_secret_access_key) return null;
  return {
    accessKeyId: sec.aws_access_key_id,
    secretAccessKey: sec.aws_secret_access_key,
    sessionToken: sec.aws_session_token || '',
    expiration: sec['x-expiration'] || sec.expiration || '',
  };
}
// Expired credentials answer 403 ExpiredTokenException for EVERY model — which would look like "the
// role lost all its models". Checked up front so the caller can say "log in again" instead.
function credsExpired(cred) {
  if (!cred || !cred.expiration) return false;
  const t = Date.parse(cred.expiration);
  return Number.isFinite(t) && t <= Date.now();
}

// RFC-3986 encoding of one path segment (encodeURIComponent leaves !'()* alone, AWS does not).
function encodeSeg(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg, 'utf8').digest();

// One signed request. Returns the raw HTTP answer; the verdict is derived by classifyProbe so the
// classification stays testable without a network.
function invokeProbe(cred, region, modelId, { timeout = 20000 } = {}) {
  const host = `bedrock-runtime.${region}.amazonaws.com`;
  const seg = encodeSeg(modelId);
  const requestPath = `/model/${seg}/invoke-with-response-stream`;
  const signedPath = `/model/${encodeSeg(seg)}/invoke-with-response-stream`; // twice-encoded: see file header
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);

  const hdrs = { 'content-type': 'application/json', host, 'x-amz-date': amzDate };
  if (cred.sessionToken) hdrs['x-amz-security-token'] = cred.sessionToken;
  const names = Object.keys(hdrs).sort();
  const canonical = [
    'POST', signedPath, '',
    names.map((k) => `${k}:${hdrs[k]}\n`).join(''),
    names.join(';'),
    sha256hex(PROBE_BODY),
  ].join('\n');
  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  let key = hmac('AWS4' + cred.secretAccessKey, dateStamp);
  for (const part of [region, SERVICE, 'aws4_request']) key = hmac(key, part);
  const signature = crypto.createHmac('sha256', key).update(toSign, 'utf8').digest('hex');

  const headers = {
    'content-type': 'application/json',
    'x-amz-date': amzDate,
    'content-length': Buffer.byteLength(PROBE_BODY),
    authorization: `AWS4-HMAC-SHA256 Credential=${cred.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
  if (cred.sessionToken) headers['x-amz-security-token'] = cred.sessionToken;

  return new Promise((resolve) => {
    const req = https.request({ host, path: requestPath, method: 'POST', headers, timeout }, (res) => {
      let buf = '';
      res.on('data', (d) => { if (buf.length < 4096) buf += d; });
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        errType: String(res.headers['x-amzn-errortype'] || '').split(':')[0],
        message: messageOf(buf),
      }));
    });
    req.on('error', (e) => resolve({ status: 0, errType: 'NetworkError', message: errorText(e) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, errType: 'Timeout', message: '' }); });
    req.end(PROBE_BODY);
  });
}
function messageOf(raw) {
  try { const j = JSON.parse(raw); return String(j.message || j.Message || raw).slice(0, 300); }
  catch { return String(raw || '').slice(0, 300); }
}

// The whole point of the probe, kept pure. 'unknown' is deliberately NOT a denial: a signature bug, an
// expired token or a dropped VPN must never be able to delete a model from the user's dropdown.
function classifyProbe(r) {
  const status = Number(r && r.status) || 0;
  const type = String((r && r.errType) || '');
  const msg = String((r && r.message) || '');
  if (status === 200) return 'allowed';
  if (status === 400) return /model identifier is invalid|invalid model identifier/i.test(msg) ? 'absent' : 'allowed';
  if (status === 404) return 'absent';
  if (status === 403) return /AccessDenied/i.test(type) ? 'denied' : 'unknown';
  return 'unknown';
}

// Probe the candidate table for one region. Ids that do not exist under the region prefix are retried
// as `global.*` (Fable and Mythos only ship as global cross-region profiles), so "not available here"
// and "available but forbidden" stay distinguishable — that difference is the entire argument in a
// ticket to the platform team.
async function probeAll(cred, region, { limit = 4 } = {}) {
  const prefix = regionPrefix(region);
  const run = async (ids) => {
    const out = [];
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++];
        const raw = await invokeProbe(cred, region, id);
        out.push({ id, verdict: classifyProbe(raw), status: raw.status, detail: raw.message, errType: raw.errType });
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, worker));
    return out;
  };

  const first = await run(BEDROCK_CANDIDATES.map((c) => `${prefix}.anthropic.${c.id}`));
  const absent = first.filter((r) => r.verdict === 'absent').map((r) => bedrockBase(r.id));
  const second = absent.length ? await run(absent.map((b) => `global.anthropic.${b}`)) : [];

  const byBase = new Map();
  const rank = { allowed: 3, denied: 2, unknown: 1, absent: 0 };
  for (const r of first.concat(second)) {
    const base = bedrockBase(r.id);
    const prev = byBase.get(base);
    if (!prev || rank[r.verdict] > rank[prev.verdict]) byBase.set(base, { ...r, base });
  }
  return BEDROCK_CANDIDATES
    .map((c) => byBase.get(bedrockBase(c.id)))
    .filter(Boolean);
}

async function readCache() {
  try { const o = JSON.parse(fs.readFileSync(BEDROCK_ACCESS_FILE, 'utf8')); return (o && typeof o === 'object') ? o : null; }
  catch { return null; }
}
function writeCache(obj) {
  try { fs.writeFileSync(BEDROCK_ACCESS_FILE, JSON.stringify(obj, null, 2)); } catch { /* cache only */ }
}
// A cached answer is stale as soon as the credentials it was measured with are gone: a new `helper
// auth` can mean a new role, and a changed region/profile certainly means new ids.
function cacheUsable(cache, cfg, cred) {
  if (!cache || !Array.isArray(cache.models) || !cache.models.length) return false;
  if (cache.region !== cfg.region || cache.profile !== cfg.profile) return false;
  if (cred && cache.credExpiration && cache.credExpiration !== cred.expiration) return false;
  return (Date.now() - Number(cache.checkedAt || 0)) < CACHE_TTL_MS;
}

// The one entry point for callers. Never throws, never returns credential material; on any failure it
// reports `error` and an empty model list, which the menu builder turns into "offer everything, judge
// nothing" instead of an empty dropdown.
async function getBedrockAccess(cfg, { force = false } = {}) {
  const base = { region: cfg.region, profile: cfg.profile, checkedAt: 0, models: [], error: '' };
  if (!cfg.region) return { ...base, error: 'no-region' };
  const cred = readAwsCreds(cfg.profile);
  const cache = await readCache();
  if (!force && cacheUsable(cache, cfg, cred)) return { ...cache, error: '' };
  if (!cred) return { ...base, error: 'no-credentials' };
  if (credsExpired(cred)) return { ...(cacheUsable(cache, cfg, null) ? cache : base), error: 'credentials-expired' };
  let models;
  try { models = await probeAll(cred, cfg.region); }
  catch (e) { return { ...base, error: errorText(e).slice(0, 200) }; }
  // Every single answer 'unknown' = we measured nothing (VPN gone, clock skew, signing broken). Keeping
  // that as a result would blank the dropdown, so it is reported as a failure instead.
  if (!models.length || models.every((m) => m.verdict === 'unknown')) {
    return { ...base, error: 'probe-inconclusive', models: [] };
  }
  const fresh = {
    region: cfg.region, profile: cfg.profile, checkedAt: Date.now(),
    credExpiration: cred.expiration || '', models, error: '',
  };
  writeCache(fresh);
  return fresh;
}

module.exports = {
  bedrockConfig, regionPrefix, readAwsCreds, credsExpired, credentialsPath,
  classifyProbe, invokeProbe, probeAll, getBedrockAccess, parseIni, CACHE_TTL_MS,
};
