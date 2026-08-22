/**
 * The negative control for tools/origin-boundary.ts. Both ways a same-host assumption gets in: a
 * module that is not one of the two permitted readers reaching for the variable, and one working
 * the origin out from the page it was served by — which needs no variable at all, and is exactly
 * what a packaged build cannot do.
 */
export function apiBase(): string {
  return process.env.NEXT_PUBLIC_API_ORIGIN ?? location.origin;
}

export function alsoLeaked(): string {
  return `https://${location.host}/api/v1`;
}
