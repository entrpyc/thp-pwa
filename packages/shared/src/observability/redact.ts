/**
 * **What a provider's own words may carry out of a process.**
 *
 * A refusal's body is quoted onto the failed job row, into the log and into the error tracker,
 * because an operator needs to read which end refused and why. A provider that echoes the request
 * back echoes the URL it was handed — and for the transcriber that URL is a presigned `GET` on the
 * original audio, valid for two hours (docs/security-audit-2026-10-29.md, finding 19). So before any
 * provider text leaves the process that received it: every URL loses its query string, which is
 * where a signature lives, and the whole is clipped to the length the row already allowed.
 *
 * In `@thp/shared` rather than beside the adapters because two packages hold the same adapter
 * (`@thp/embed` and the worker's copy of it are held identical by a test) and both need it.
 */
export const MAX_PROVIDER_DETAIL_LENGTH = 400;

/** `https://host/path?X-Amz-…` becomes `https://host/path?…`; anything else is left as it was. */
export function redactProviderText(text: string): string {
  return text.replace(/(https?:\/\/[^\s"'<>?#]+)\?[^\s"'<>#]*/g, '$1?…').slice(0, MAX_PROVIDER_DETAIL_LENGTH);
}
