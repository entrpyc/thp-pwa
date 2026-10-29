import { describe, expect, it } from 'vitest';
import { clientAddress } from '@/server/api/client-address';
import { createRateLimiter } from '@/server/api/rate-limit';
import { describeWait } from '@/server/api/budgets';

/**
 * The rate limiter, its key, and the policy over the two.
 *
 * All of it is driven with an injected clock rather than by waiting, which is what lets the window
 * behaviour be asserted exactly — a limiter test that passes because a real second went by has
 * proved that a second went by. The integration suite proves the same limiter is wired to the
 * route; this file is where the arithmetic lives.
 */

const T0 = 1_700_000_000_000;

describe('the sliding-window limiter', () => {
  it('allows up to the limit and refuses the next one', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000, maxKeys: 10 });

    expect(limiter.spend('a', T0).allowed).toBe(true);
    expect(limiter.spend('a', T0).allowed).toBe(true);
    expect(limiter.spend('a', T0).allowed).toBe(true);

    const refused = limiter.spend('a', T0);
    expect(refused.allowed).toBe(false);
    expect(refused.spent).toBe(3);
  });

  it('counts each key separately', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 10 });

    expect(limiter.spend('a', T0).allowed).toBe(true);
    expect(limiter.spend('a', T0).allowed).toBe(false);
    // A different caller is untouched by the first one's spending.
    expect(limiter.spend('b', T0).allowed).toBe(true);
  });

  it('slides: a request falls out of the window exactly when it ages past it', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 10 });

    expect(limiter.spend('a', T0).allowed).toBe(true);
    expect(limiter.spend('a', T0 + 999).allowed).toBe(false);
    // A request made at T0 occupies a 1000ms window until T0 + 1000, and is gone *at* it. Pinned
    // because it is the boundary `retryAfterMs` is computed against: the moment the wait reaches
    // zero has to be the moment the next request is allowed, or the number the caller was handed
    // sends them back one millisecond early.
    expect(limiter.spend('a', T0 + 1000).allowed).toBe(true);
  });

  it('hands back a wait that is over exactly when the budget frees up', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 10 });

    limiter.spend('a', T0);
    const refused = limiter.spend('a', T0 + 250);
    expect(refused.retryAfterMs).toBe(750);
    // Waiting precisely that long is enough — never one millisecond short of it.
    expect(limiter.spend('a', T0 + 250 + refused.retryAfterMs).allowed).toBe(true);
  });

  it('is a sliding window and not a fixed one — no double burst at the boundary', () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, maxKeys: 10 });

    // Two spent at the very end of what a fixed window would call "this window".
    expect(limiter.spend('a', T0 + 900).allowed).toBe(true);
    expect(limiter.spend('a', T0 + 999).allowed).toBe(true);
    // A fixed window would reset here and allow two more immediately. A sliding one does not.
    expect(limiter.spend('a', T0 + 1001).allowed).toBe(false);
  });

  it('says how long until the budget frees up, measured from the oldest request', () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, maxKeys: 10 });

    limiter.spend('a', T0);
    limiter.spend('a', T0 + 400);

    const refused = limiter.spend('a', T0 + 500);
    // The oldest is at T0 and leaves the window at T0 + 1000, which is 500ms away.
    expect(refused.retryAfterMs).toBe(500);
  });

  it('does not extend the block when a refused caller keeps trying', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 10 });

    limiter.spend('a', T0);
    const first = limiter.spend('a', T0 + 100);
    const afterHammering = [1, 2, 3, 4].map((n) => limiter.spend('a', T0 + 100 + n));

    expect(first.allowed).toBe(false);
    expect(afterHammering.every((verdict) => !verdict.allowed)).toBe(true);
    // A refusal spends nothing, so the wait keeps counting down rather than resetting.
    expect(afterHammering[3]?.retryAfterMs).toBeLessThan(first.retryAfterMs);
    // And the caller is free again exactly when the one request they did spend ages out.
    expect(limiter.spend('a', T0 + 1001).allowed).toBe(true);
  });

  it('evicts the least recently seen key rather than growing without bound', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2 });

    limiter.spend('oldest', T0);
    limiter.spend('middle', T0 + 1);
    limiter.spend('newest', T0 + 2);

    expect(limiter.size()).toBe(2);
    // `oldest` was dropped, so it gets a fresh budget; `middle` and `newest` kept theirs.
    expect(limiter.spend('oldest', T0 + 3).allowed).toBe(true);
    expect(limiter.spend('newest', T0 + 3).allowed).toBe(false);
  });

  it('does not let a caller evict themselves into a fresh budget by hammering', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 1 });

    expect(limiter.spend('a', T0).allowed).toBe(true);
    // Every one of these is refused, and none of them drops `a` to make room for `a`.
    for (let n = 1; n <= 5; n += 1) {
      expect(limiter.spend('a', T0 + n).allowed).toBe(false);
    }
  });

  it.each([
    ['a limit of zero', { limit: 0, windowMs: 1000, maxKeys: 1 }],
    ['a fractional limit', { limit: 1.5, windowMs: 1000, maxKeys: 1 }],
    ['a window of zero', { limit: 1, windowMs: 0, maxKeys: 1 }],
    ['no room for a single key', { limit: 1, windowMs: 1000, maxKeys: 0 }],
  ])('refuses to be built with %s', (_label, policy) => {
    expect(() => createRateLimiter(policy)).toThrowError();
  });
});

describe('who the request came from', () => {
  const request = (headers: Record<string, string>) =>
    new Request('https://example.test/api/v1/auth/sign-up', { method: 'POST', headers });

  it('prefers X-Real-IP, which the proxy overwrites', () => {
    expect(clientAddress(request({ 'x-real-ip': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('takes the LAST X-Forwarded-For entry, because that is the one the proxy appended', () => {
    // The first entries are whatever the caller sent. Trusting them hands the caller their own
    // bucket key and makes the limit free to bypass.
    expect(clientAddress(request({ 'x-forwarded-for': '10.0.0.1, 10.0.0.2, 203.0.113.7' }))).toBe(
      '203.0.113.7',
    );
  });

  it('prefers X-Real-IP over anything in X-Forwarded-For', () => {
    const headers = { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.4' };
    expect(clientAddress(request(headers))).toBe('203.0.113.7');
  });

  it('answers null when nothing in front of the app said who called', () => {
    expect(clientAddress(request({}))).toBeNull();
  });

  it.each([
    ['an empty header', { 'x-real-ip': '   ' }],
    ['a trailing comma only', { 'x-forwarded-for': ' , ' }],
    ['an absurdly long value', { 'x-real-ip': 'x'.repeat(200) }],
  ])('answers null for %s rather than making it a key', (_label, headers) => {
    expect(clientAddress(request(headers))).toBeNull();
  });

  it('reads one host as one key however it was written', () => {
    expect(clientAddress(request({ 'x-real-ip': '[::1]:443' }))).toBe('::1');
    expect(clientAddress(request({ 'x-real-ip': '::1' }))).toBe('::1');
    expect(clientAddress(request({ 'x-real-ip': '203.0.113.7:51234' }))).toBe('203.0.113.7');
    expect(clientAddress(request({ 'x-real-ip': '203.0.113.7' }))).toBe('203.0.113.7');
  });
});


describe('the wait a person is told about', () => {
  it.each([
    [1, '1 second'],
    [45, '45 seconds'],
    [60, '1 minute'],
    [61, '2 minutes'],
    [600, '10 minutes'],
  ])('describes %i seconds as "%s"', (seconds, expected) => {
    expect(describeWait(seconds)).toBe(expected);
  });
});

function captureMessage(run: () => void): string {
  try {
    run();
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
  throw new Error('expected the call to be refused');
}
