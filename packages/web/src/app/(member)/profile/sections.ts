import {
  HIGHLIGHTS_PAGE_PATH,
  NOTIFICATION_SETTINGS_PAGE_PATH,
  PROFILE_DOWNLOADS_PAGE_PATH,
  PROFILE_PAGE_PATH,
} from '@thp/shared';

/**
 * **The profile's sections** — the one list the section strip under *My profile* renders from.
 *
 * The profile is a small set of pages under one heading: the identity page at `/profile`, and one
 * page per section beside it. Each page is its own route folder, so a ticket that adds a section
 * touches its own folder and one line here, and two such tickets never edit the same file.
 *
 * **To add a section:**
 *
 * 1. Make `profile/<name>/page.tsx` — a page like `settings/page.tsx`, with its own `<h2>`; the
 *    layout already draws the `<h1>` and this strip above it.
 * 2. Add one entry below, in the order the strip should show it. `href` is the route the folder
 *    made; `id` is what a test or a style may hang off.
 *
 * **Only a section that exists is listed.** A destination that is planned and not yet built has
 * no entry, rather than an entry drawn disabled or a page that says "coming soon": the codebase's
 * rule for a deferred destination is to drop it, so nothing here can point at a route that
 * answers 404. When its ticket lands, its entry lands with it — downloads was the last to arrive
 * this way.
 *
 * Pure data — no component — so a unit test and the strip read the same list.
 */
export type ProfileSection = {
  readonly id: string;
  /** What the strip prints. */
  readonly label: string;
  readonly href: string;
};

export const PROFILE_SECTIONS: readonly ProfileSection[] = [
  { id: 'identity', label: 'Profile', href: PROFILE_PAGE_PATH },
  { id: 'highlights', label: 'Highlights', href: HIGHLIGHTS_PAGE_PATH },
  { id: 'settings', label: 'Settings', href: `${PROFILE_PAGE_PATH}/settings` },
  { id: 'notifications', label: 'Notifications', href: NOTIFICATION_SETTINGS_PAGE_PATH },
  // Downloads arrived with 3.18: what this device holds for this account, deleted per row.
  { id: 'downloads', label: 'Downloads', href: PROFILE_DOWNLOADS_PAGE_PATH },
];

/**
 * Which section an address is in, so the strip can mark it current.
 *
 * The identity page is the root, and every other section lives under it — so the root matches only
 * itself, and a section matches its own page and anything beneath it (`/profile/settings/anything`
 * is still Settings). An address under `/profile` that no section claims answers `null`: the strip
 * then marks nothing, which is the honest answer rather than a guess.
 */
export function sectionFor(pathname: string): ProfileSection | null {
  const trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  for (const section of PROFILE_SECTIONS) {
    if (section.href === PROFILE_PAGE_PATH) {
      if (trimmed === section.href) return section;
      continue;
    }
    if (trimmed === section.href || trimmed.startsWith(`${section.href}/`)) return section;
  }
  return null;
}
