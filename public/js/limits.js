// Part of the Claude Code Control Panel front-end.
// Classic scripts share one global scope; load order in index.html is authoritative.
// This file: limits.js — deadlines and limits, as arithmetic. Pure, no DOM. Two things live here
// because they are the same kind of claim („until when is this true?") with the same honesty rule
// (never invent a time the CLI did not send): the `rate_limit_event` frame, and a `Monitor` watch's
// deadline.
//
// Measured on 2.1.278 (the binary describes it as „Rate limit event emitted when rate limit info
// changes"; one such frame arrived in a probe run, so the type really does reach the panel):
//   {type:'rate_limit_event', rate_limit_info:{…}, uuid, session_id}
//   rate_limit_info: status · rateLimitType · resetsAt · unifiedRateLimitFallbackAvailable ·
//                    isUsingOverage · overageStatus · overageResetsAt · overageDisabledReason
// The panel had no case for it at all: the one frame that explains why a turn stands still was dropped
// on the floor, and „nothing happens" looked exactly like „the panel is broken".
//
// Two honesty rules are baked in here, because both failure modes are worse than showing less:
//   · `resetsAt` is an epoch in SECONDS. Handed to `new Date()` unchanged it produces a 1970 clock time
//     that looks like a real answer. Converted here, once.
//   · a missing field stays missing (null / 0). Nothing derives a reset time from „now + something".
// `status` is only pinned for the one value the binary spells out (`rejected`); the warning states are
// matched loosely on purpose — their exact spelling is not verified, and a mis-guessed string must not
// silently switch the chip off.
var RATE_LIMIT_MS_FLOOR = 1e11; // below this an epoch is in seconds, above it already in milliseconds

function rateLimitEpochMs(v) {
  var n = Number(v);
  if (!isFinite(n) || n <= 0) return 0;
  return n < RATE_LIMIT_MS_FLOOR ? Math.round(n * 1000) : Math.round(n);
}
function rateLimitPick(info, camel, snake) {
  if (!info) return undefined;
  return info[camel] !== undefined ? info[camel] : info[snake];
}
// rate_limit_info → the shape the status strip renders. null = nothing worth telling the user.
function normalizeRateLimit(info) {
  if (!info || typeof info !== 'object') return null;
  var status = String(info.status || '').trim();
  var type = String(rateLimitPick(info, 'rateLimitType', 'rate_limit_type') || '').trim();
  var out = {
    status: status,
    type: type,
    rejected: status === 'rejected',
    warning: /warn|approach|near/i.test(status),
    resetsAtMs: rateLimitEpochMs(rateLimitPick(info, 'resetsAt', 'resets_at')),
    fallbackAvailable: !!rateLimitPick(info, 'unifiedRateLimitFallbackAvailable', 'unified_rate_limit_fallback_available'),
    usingOverage: !!rateLimitPick(info, 'isUsingOverage', 'is_using_overage'),
    overageStatus: String(rateLimitPick(info, 'overageStatus', 'overage_status') || '').trim(),
    overageResetsAtMs: rateLimitEpochMs(rateLimitPick(info, 'overageResetsAt', 'overage_resets_at')),
    overageDisabledReason: String(rateLimitPick(info, 'overageDisabledReason', 'overage_disabled_reason') || '').trim(),
  };
  if (!out.status && !out.type && !out.resetsAtMs && !out.usingOverage) return null;
  return out;
}
// Is this worth a chip right now? „allowed" with nothing else to say is not: a limit that is merely
// being respected is the normal state of every turn, and a permanent chip for it would train the eye to
// ignore the one case that matters. A rejection without a reset time stays pending — it has not been
// withdrawn just because the CLI did not say when it ends.
function rateLimitPending(rl, now) {
  if (!rl) return false;
  var t = Number(now) > 0 ? Number(now) : Date.now();
  var future = !rl.resetsAtMs || rl.resetsAtMs > t;
  if (rl.rejected) return future;
  if (rl.usingOverage) return true;
  return rl.warning && future;
}

// --- a Monitor's watch window (D) ----------------------------------------------------------------
// MonitorInput (sdk-tools.d.ts): description · timeout_ms (default 300000, capped at 1800000) ·
// command OR ws{url,protocols}. `timeout_ms` is a DURATION, and the card shows a clock time — because
// „watches always have a deadline" (2.1.271) only helps as an answer to „until when".
// 0 / missing is NOT a deadline of „now": it means persistent (runs until TaskStop or session end).
function monitorCardInfo(input, now) {
  var i = (input && typeof input === 'object') ? input : {};
  var t = Number(i.timeout_ms);
  var timeoutMs = (isFinite(t) && t > 0) ? t : 0;
  var ws = (i.ws && typeof i.ws === 'object') ? String(i.ws.url || '') : '';
  var base = Number(now) > 0 ? Number(now) : Date.now();
  return {
    desc: String(i.description || '').trim(),
    ws: !!ws,
    what: ws || String(i.command || '').trim(),
    timeoutMs: timeoutMs,
    persistent: !timeoutMs || i.persistent === true,
    deadlineMs: timeoutMs ? base + timeoutMs : 0,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rateLimitEpochMs, normalizeRateLimit, rateLimitPending, monitorCardInfo, RATE_LIMIT_MS_FLOOR };
}
