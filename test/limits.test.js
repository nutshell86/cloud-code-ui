'use strict';
// The rate-limit frame the panel used to drop on the floor. The field names and types below are NOT
// invented: they are the ones the 2.1.278 binary carries around `rate_limit_info` („Rate limit event
// emitted when rate limit info changes"), and `resetsAt` really is an epoch in SECONDS — which is the
// whole reason this arithmetic is a tested unit instead of three inline expressions in the status bar.
// A wrong unit here would not crash anything; it would print „Reset 01:00" for a limit that lifts
// tomorrow, and look entirely plausible while doing it.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { rateLimitEpochMs, normalizeRateLimit, rateLimitPending, monitorCardInfo } = require('../public/js/limits');

const SEC = 1758646320;            // 2025-09-23 in seconds
const MS = SEC * 1000;
const REJECTED = {
  status: 'rejected', rateLimitType: 'unified_five_hour', resetsAt: SEC,
  unifiedRateLimitFallbackAvailable: true, isUsingOverage: false, overageStatus: 'disabled',
  overageResetsAt: 0, overageDisabledReason: 'not_enrolled',
};

describe('limits — the epoch the CLI sends is in seconds', () => {
  it('scales a seconds epoch to milliseconds', () => {
    assert.equal(rateLimitEpochMs(SEC), MS);
  });
  it('leaves a value that is already in milliseconds alone', () => {
    assert.equal(rateLimitEpochMs(MS), MS);
  });
  it('treats missing, zero and nonsense as "no time given"', () => {
    for (const v of [undefined, null, 0, -5, '', 'bald', NaN]) assert.equal(rateLimitEpochMs(v), 0);
  });
});

describe('limits — normalizeRateLimit reports only what the frame said', () => {
  it('reads the measured rejection shape completely', () => {
    const rl = normalizeRateLimit(REJECTED);
    assert.equal(rl.status, 'rejected');
    assert.equal(rl.rejected, true);
    assert.equal(rl.type, 'unified_five_hour');
    assert.equal(rl.resetsAtMs, MS);
    assert.equal(rl.fallbackAvailable, true);
    assert.equal(rl.usingOverage, false);
    assert.equal(rl.overageDisabledReason, 'not_enrolled');
  });
  it('accepts the snake_case spelling of every field', () => {
    const rl = normalizeRateLimit({
      status: 'rejected', rate_limit_type: 'unified_weekly', resets_at: SEC,
      unified_rate_limit_fallback_available: true, is_using_overage: true, overage_resets_at: SEC,
    });
    assert.equal(rl.type, 'unified_weekly');
    assert.equal(rl.resetsAtMs, MS);
    assert.equal(rl.fallbackAvailable, true);
    assert.equal(rl.usingOverage, true);
    assert.equal(rl.overageResetsAtMs, MS);
  });
  it('invents no reset time when the frame carries none', () => {
    const rl = normalizeRateLimit({ status: 'rejected' });
    assert.equal(rl.resetsAtMs, 0);
  });
  it('returns null for a frame with nothing in it', () => {
    for (const v of [null, undefined, 'rejected', 42, {}, { foo: 1 }]) assert.equal(normalizeRateLimit(v), null);
  });
});

describe('limits — when the chip is worth showing', () => {
  it('shows a rejection until its reset time has passed', () => {
    const rl = normalizeRateLimit(REJECTED);
    assert.equal(rateLimitPending(rl, MS - 60000), true);
    assert.equal(rateLimitPending(rl, MS + 60000), false);
  });
  it('keeps a rejection without a reset time pending', () => {
    // the limit was not withdrawn just because the CLI did not say when it ends
    assert.equal(rateLimitPending(normalizeRateLimit({ status: 'rejected' }), MS), true);
  });
  it('stays quiet for a limit that is merely being respected', () => {
    const rl = normalizeRateLimit({ status: 'allowed', rateLimitType: 'unified_five_hour', resetsAt: SEC });
    assert.equal(rateLimitPending(rl, MS - 60000), false);
  });
  it('shows a warning state while it lasts, and an overage always', () => {
    assert.equal(rateLimitPending(normalizeRateLimit({ status: 'allowed_warning', resetsAt: SEC }), MS - 1000), true);
    assert.equal(rateLimitPending(normalizeRateLimit({ status: 'allowed_warning', resetsAt: SEC }), MS + 1000), false);
    assert.equal(rateLimitPending(normalizeRateLimit({ status: 'allowed', isUsingOverage: true }), MS), true);
  });
  it('is false without a limit at all', () => {
    assert.equal(rateLimitPending(null, MS), false);
  });
});

describe('limits — a Monitor watch: a duration becomes a deadline', () => {
  const NOW = 1790000000000;
  it('turns timeout_ms into a clock time', () => {
    const m = monitorCardInfo({ description: 'CI beobachten', timeout_ms: 300000, command: 'npm test' }, NOW);
    assert.equal(m.deadlineMs, NOW + 300000);
    assert.equal(m.persistent, false);
    assert.equal(m.what, 'npm test');
    assert.equal(m.ws, false);
    assert.equal(m.desc, 'CI beobachten');
  });
  it('treats timeout 0 as PERSISTENT, not as a deadline of "now"', () => {
    // the difference that matters: „runs until stopped" vs „already over"
    const m = monitorCardInfo({ timeout_ms: 0, command: 'ls' }, NOW);
    assert.equal(m.persistent, true);
    assert.equal(m.deadlineMs, 0);
  });
  it('prefers the websocket url and marks it as one', () => {
    const m = monitorCardInfo({ ws: { url: 'wss://example/stream' }, timeout_ms: 1800000 }, NOW);
    assert.equal(m.ws, true);
    assert.equal(m.what, 'wss://example/stream');
    assert.equal(m.deadlineMs, NOW + 1800000);
  });
  it('invents nothing from an empty or broken input', () => {
    for (const v of [{}, null, undefined, 'nope', 42]) {
      const m = monitorCardInfo(v, NOW);
      assert.equal(m.what, '');
      assert.equal(m.desc, '');
      assert.equal(m.persistent, true);
      assert.equal(m.deadlineMs, 0);
    }
    assert.equal(monitorCardInfo({ timeout_ms: -5, command: 'x' }, NOW).persistent, true);
    assert.equal(monitorCardInfo({ timeout_ms: 'bald', command: 'x' }, NOW).deadlineMs, 0);
  });
  it('honours an explicit persistent flag even with a timeout', () => {
    assert.equal(monitorCardInfo({ timeout_ms: 300000, persistent: true }, NOW).persistent, true);
  });
});
