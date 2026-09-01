/**
 * Who a request came from, for the one purpose a rate limit needs it for.
 *
 * **This is a trust question, not a parsing question**, which is the whole reason it is a module
 * with an argument rather than one line at the call site. The process never sees the peer socket:
 * it is behind nginx (deploy/nginx/thp.conf), so the only evidence of who called is a header — and
 * a header is something the caller can also write. Get the choice wrong and the limiter is not
 * merely weak, it is *free to bypass*: an attacker sends a different forged address on every
 * request and every one lands in a bucket of its own.
 *
 * So the order below is by **who wrote the value**, never by which header is more conventional:
 *
 * 1. **`X-Real-IP`** — nginx sets it to `$remote_addr` with `proxy_set_header`, which *replaces*
 *    anything the client sent under that name. Whatever arrives here was written by the proxy, so
 *    it is the peer that actually connected. This is the one to trust, and it is first.
 * 2. **The last entry of `X-Forwarded-For`** — nginx sets it to `$proxy_add_x_forwarded_for`,
 *    which **appends** the peer to whatever list the client supplied. So the header reads
 *    `<anything the caller invented>, <the real peer>`, and only the final element was written by
 *    the proxy. Taking the *first* element is the classic version of this bug and would hand the
 *    caller their own bucket key; this takes the last, and never anything else.
 * 3. **`null`** — no proxy in front, or one that sets neither header.
 *
 * `null` is a real answer rather than a failure, and what the limiter does with it is a decision
 * that belongs to the limiter (see `rate-limit.ts`): every such caller shares one bucket, which
 * over-restricts rather than under-restricts, and is what a limiter should do when it cannot tell
 * two callers apart.
 */

/** Bounded, because it is a map key and a log field, and neither wants an unbounded header. */
const MAX_ADDRESS_LENGTH = 64;

export function clientAddress(request: Request): string | null {
  const real = clean(request.headers.get('x-real-ip'));
  if (real !== null) return real;

  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded === null) return null;

  // The last non-empty element, for the reason set out above. `pop()` on the split would take an
  // empty string from a trailing comma, so the list is filtered before the end is read.
  const hops = forwarded
    .split(',')
    .map((hop) => clean(hop))
    .filter((hop): hop is string => hop !== null);
  return hops.length === 0 ? null : (hops[hops.length - 1] ?? null);
}

/**
 * Trim, drop the empty, drop the absurd, and normalise the two ways an address can be written that
 * mean the same host — so `[::1]:443` and `::1` are not two buckets.
 */
function clean(value: string | null): string | null {
  if (value === null) return null;
  let trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > MAX_ADDRESS_LENGTH) return null;

  // A bracketed IPv6 literal, with or without a port: `[::1]` or `[::1]:443`.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(trimmed);
  if (bracketed?.[1] !== undefined) return bracketed[1].toLowerCase();

  // `1.2.3.4:5678` — a port on an IPv4 address. A bare IPv6 address also contains colons, so this
  // only strips one when there is exactly one and what follows it is digits.
  const withPort = /^([^:]+):\d+$/.exec(trimmed);
  if (withPort?.[1] !== undefined) trimmed = withPort[1];

  return trimmed.toLowerCase();
}
