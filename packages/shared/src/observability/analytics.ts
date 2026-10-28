/**
 * **The analytics vocabulary** — every event the product sends to its analytics tool, with every
 * property, in one place (docs/project/observability.md § 5.2).
 *
 * Written as a runtime schema the types are derived from, rather than as types alone, for one
 * reason: the privacy rule in observability.md § 5.5 has to be *checked*, not trusted. A property
 * is an opaque id, a number, a boolean, or one of a short list of words — never free text — and
 * `tests/guards/analytics-vocabulary.test.ts` walks this table to say so. The same table is what
 * {@link sanitiseAnalyticsProperties} reads at runtime, so a call site that passes something the
 * vocabulary does not name sends nothing for it, and a note's text cannot reach the tool even
 * through a mistake.
 *
 * Mirrors `DomainEvent` in shape — one exhaustive table, one typed function signature — and
 * deliberately shares nothing with it: a domain event is a fact the system records about itself; an
 * analytics event is a question about members, and the two vocabularies answer to different rules.
 *
 * **No SDK here.** This file is importable by the client and the server alike and names no
 * provider; the two adapters that do are the only files allowed to
 * (`tests/guards/analytics-boundary.test.ts`).
 */

import { NOTE_VISIBILITIES } from '../notes';
import { NOTIFICATION_KINDS } from '../notifications';
import type { Role } from '../roles';

/**
 * What analytics may know about who is acting (docs/project/observability.md § 5.2): the
 * account's opaque id as the distinct id, and the role as the one person property, so an admin
 * listening while testing can be kept apart from members in every insight.
 *
 * Built by the policy module — the one module that reads an actor's role
 * (tools/role-usage.ts) — and passed through the adapter whole, so nothing else has a reason to
 * reach for the field.
 */
export interface AnalyticsPerson {
  readonly accountId: string;
  readonly properties: { readonly role: Role };
}

/**
 * What a property may be.
 *
 * - `'id'` — an opaque UUID the API already uses: an account, a recording, a series. Never an
 *   e-mail, never a name.
 * - `'id?'` — the same, or `null` where the thing is optional (a recording in no series).
 * - `'number'` — a count, a duration, a rate.
 * - `'boolean'`.
 * - a `readonly string[]` — an enum: exactly these words and no other string.
 *
 * There is no `'string'`, and that absence is the privacy rule.
 */
export type AnalyticsPropertyKind = 'id' | 'id?' | 'number' | 'boolean' | readonly string[];

export const ANALYTICS_INSTALL_SOURCES = ['browser', 'pwa', 'ios_store', 'android_store'] as const;
export type AnalyticsInstallSource = (typeof ANALYTICS_INSTALL_SOURCES)[number];

const TABS = ['about', 'reflection', 'chapters', 'scripture', 'notes', 'transcript', 'mindmap', 'related'] as const;
const TAB_SURFACES = ['recording', 'chapter'] as const;
const NOTIFICATION_CHANNELS = ['in_app', 'push'] as const;

/**
 * The route patterns a page view may name — the member-area page files as they stand, with the
 * dynamic segments as their parameter names rather than their values. A URL never travels; the id
 * a page is about travels beside the pattern as its own property.
 */
export const ANALYTICS_ROUTES = [
  '/',
  '/recordings',
  '/recordings/[id]',
  '/recordings/[id]/chapters/[chapterId]',
  '/series',
  '/series/[id]',
  '/now-playing',
  '/notifications',
  '/profile',
  '/feedback',
] as const;
export type AnalyticsRoute = (typeof ANALYTICS_ROUTES)[number];

/**
 * The table. Keys are event names; values are each event's properties and their kinds.
 *
 * `$pageview` is the analytics tool's own name for a page view and is kept so its built-in
 * page-view insights work unchanged; everything else is a `snake_case` noun and past-tense verb.
 */
export const ANALYTICS_EVENTS = {
  /**
   * A unique play: the first time audio starts after a recording is loaded into the player.
   * Pausing and resuming the same loaded recording fires nothing more; navigating away and back,
   * or opening the app again, loads it afresh and is a new play. Streams, listeners and returns
   * are all read from this one event (observability.md § 5.4).
   */
  playback_started: {
    recording_id: 'id',
    series_id: 'id?',
    /** Whether the play began above position zero — a resume rather than a start. */
    resumed: 'boolean',
    speed: 'number',
  },
  /**
   * A member has listened to at least 80% of a recording, accumulated across visits with seeking
   * excluded. Sent **server-side** once per member per recording, ever (observability.md § 5.3).
   */
  playback_completed: {
    recording_id: 'id',
    series_id: 'id?',
  },
  tab_opened: {
    tab: TABS,
    surface: TAB_SURFACES,
    recording_id: 'id',
  },
  note_created: {
    recording_id: 'id',
    visibility: NOTE_VISIBILITIES,
    is_reply: 'boolean',
  },
  chapter_jumped: {
    recording_id: 'id',
    chapter_index: 'number',
  },
  speed_changed: {
    speed: 'number',
  },
  notification_opened: {
    kind: NOTIFICATION_KINDS,
    channel: NOTIFICATION_CHANNELS,
  },
  $pageview: {
    route: ANALYTICS_ROUTES,
    recording_id: 'id?',
    series_id: 'id?',
  },
} as const satisfies Record<string, Record<string, AnalyticsPropertyKind>>;

/**
 * Sent with every event by the adapter, not by the call site. `app_version` is the release tag
 * the client was built from; `install_source` is how the app was opened.
 */
export const ANALYTICS_COMMON_PROPERTIES = {
  app_version: 'version',
  install_source: ANALYTICS_INSTALL_SOURCES,
} as const;

export type AnalyticsEventName = keyof typeof ANALYTICS_EVENTS;

type ValueOf<K> = K extends 'id'
  ? string
  : K extends 'id?'
    ? string | null
    : K extends 'number'
      ? number
      : K extends 'boolean'
        ? boolean
        : K extends readonly (infer E)[]
          ? E
          : never;

/** The properties an event takes, as a type: what a call site must pass, and may not exceed. */
export type AnalyticsProperties<N extends AnalyticsEventName> = {
  readonly [P in keyof (typeof ANALYTICS_EVENTS)[N]]: ValueOf<(typeof ANALYTICS_EVENTS)[N][P]>;
};

/**
 * The one signature both adapters expose. Returns nothing and throws nothing: analytics never
 * blocks or fails anything (observability.md § 6.8).
 */
export type TrackFunction = <N extends AnalyticsEventName>(
  name: N,
  properties: AnalyticsProperties<N>,
) => void;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a value is what the kind says it is. An `'id'` is held to the UUID shape, so a string
 * that is not an id — however it got there — is not an id.
 */
export function matchesAnalyticsKind(value: unknown, kind: AnalyticsPropertyKind): boolean {
  if (kind === 'id') return typeof value === 'string' && UUID_PATTERN.test(value);
  if (kind === 'id?') return value === null || (typeof value === 'string' && UUID_PATTERN.test(value));
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (kind === 'boolean') return typeof value === 'boolean';
  return typeof value === 'string' && (kind as readonly string[]).includes(value);
}

/**
 * The properties the vocabulary names for this event, with the values that match their kinds —
 * and nothing else. A key the table does not list is dropped; a value that is not what its kind
 * says is dropped. What comes back is what may leave the product.
 *
 * Returns `null` for an event name the table does not know, so an unknown name sends nothing at
 * all rather than an event with no properties.
 */
export function sanitiseAnalyticsProperties(
  name: string,
  properties: Readonly<Record<string, unknown>>,
): Record<string, string | number | boolean | null> | null {
  if (!Object.hasOwn(ANALYTICS_EVENTS, name)) return null;
  const schema = ANALYTICS_EVENTS[name as AnalyticsEventName] as Readonly<
    Record<string, AnalyticsPropertyKind>
  >;
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [key, kind] of Object.entries(schema)) {
    const value = properties[key];
    if (matchesAnalyticsKind(value, kind)) {
      clean[key] = value as string | number | boolean | null;
    }
  }
  return clean;
}
