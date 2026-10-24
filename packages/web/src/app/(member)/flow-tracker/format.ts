/**
 * The two date renderings the Flow Tracker's screens share, matching the library's and the
 * console's, so the product reads one way.
 */

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** `12 Oct 2026`, from a `YYYY-MM-DD` date or an ISO timestamp. */
export function formatDay(iso: string): string {
  const parsed = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(parsed.getTime()) ? iso : DAY.format(parsed);
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
