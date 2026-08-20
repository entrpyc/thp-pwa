/**
 * The absolute origin the client calls. Read from configuration and never defaulted to "the host
 * this page came from" — that default is exactly what a packaged Capacitor build cannot satisfy
 * (docs/prd.md, 5.2.2), and the only way to keep it honest is for the client to have no fallback.
 *
 * The literal `process.env.NEXT_PUBLIC_API_ORIGIN` is inlined at build time; it must stay written
 * out in full rather than read through a variable key.
 */
export function readApiOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_API_ORIGIN;
  if (!configured || configured.trim() === '') {
    throw new Error(
      'NEXT_PUBLIC_API_ORIGIN is not set. The client calls an absolute API origin and has no ' +
        'same-host fallback by design — see .env.example.',
    );
  }
  return normaliseOrigin(configured);
}

/** Strip a trailing slash so joining a path never produces a double slash. */
export function normaliseOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '');
}
