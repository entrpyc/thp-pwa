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

/**
 * The picked teachings in one line — `Walking, Standing and Running` — with the rest counted once
 * the line would run long: `Walking, Standing and 3 more`. A session's rows and heads name what
 * it covered ([3.14.2](docs/project/prd.md)), and a pick can be the whole library.
 */
export function listTitles(titles: readonly string[], most = 3): string {
  if (titles.length <= most) {
    if (titles.length <= 1) return titles[0] ?? '';
    return `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`;
  }
  const shown = titles.slice(0, most - 1);
  return `${shown.join(', ')} and ${titles.length - shown.length} more`;
}
