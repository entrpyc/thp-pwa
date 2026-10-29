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
import { SEARCHABLE_KINDS } from '../search';
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
 * - `'title'` — **the one exception**: a published teaching's title, as the catalogue shows it to
 *   every member. It is public content, never a member's, and it exists so an insight can be
 *   read by title rather than by UUID. Bounded to {@link MAX_ANALYTICS_TITLE_LENGTH} characters.
 *   Nothing a member wrote may ever be typed with it.
 * - a `readonly string[]` — an enum: exactly these words and no other string.
 *
 * There is no `'string'`, and that absence is the privacy rule.
 */
export type AnalyticsPropertyKind = 'id' | 'id?' | 'number' | 'boolean' | 'title' | readonly string[];

/** A title longer than this is cut, so a property can never be a paragraph. */
export const MAX_ANALYTICS_TITLE_LENGTH = 200;

export const ANALYTICS_INSTALL_SOURCES = ['browser', 'pwa', 'ios_store', 'android_store'] as const;
export type AnalyticsInstallSource = (typeof ANALYTICS_INSTALL_SOURCES)[number];

const TABS = ['about', 'reflection', 'chapters', 'scripture', 'notes', 'transcript', 'mindmap', 'related'] as const;
const TAB_SURFACES = ['recording', 'chapter'] as const;
const NOTIFICATION_CHANNELS = ['in_app', 'push'] as const;

/** The transport's controls: the play/pause button, the two ten-second skips, the scrubber. */
export const PLAYBACK_CONTROL_ACTIONS = ['play', 'pause', 'jump_back', 'jump_forward', 'seek'] as const;
/** What a reader does on somebody's note, short of writing one. */
export const NOTE_INTERACTIONS = [
  'reply_opened',
  'reaction_added',
  'reaction_removed',
  'timestamp_clicked',
  'image_viewed',
] as const;
export const HIGHLIGHT_ACTIONS = ['added', 'removed', 'revisited'] as const;
/**
 * What was highlighted, by the surface it was highlighted from: a note, the moment playing (the
 * transport's marker or a transcript line), a chapter (its opening moment, from the chapter list
 * or the chapter page), or a whole teaching. The server stores the first three as two kinds —
 * a chapter *is* a moment — so this is the only place the distinction exists.
 */
export const HIGHLIGHT_TARGETS = ['note', 'moment', 'chapter', 'recording'] as const;
export const SEARCH_RESULT_ACTIONS = ['link', 'play'] as const;
/** The search's per-teaching cap, as words so the enum rule holds. */
export const SEARCH_PER_TEACHING_WORDS = ['one', 'three', 'all'] as const;
/** What a hit can be: the searchable kinds, which `search.ts` owns. */
export const SEARCH_HIT_KINDS = SEARCHABLE_KINDS;
export const FLOW_TRACKER_ACTIONS = [
  'session_started',
  'past_session_opened',
  'recording_opened',
  'chapter_opened',
  'chapter_checked',
  'chapter_unchecked',
  'play_clicked',
  'related_chapter_opened',
  'related_play_clicked',
] as const;
export const TRANSCRIPT_ACTIONS = ['follow_on', 'follow_off', 'jump_to_current', 'downloaded', 'row_clicked'] as const;
export const MIND_MAP_ACTIONS = ['full_screen_on', 'full_screen_off', 'collapsed', 'expanded', 'seek', 'play'] as const;
/** The `···` menu on the transport bar and the tools inside it. */
export const PLAYER_MENU_ACTIONS = ['opened', 'chapters_opened', 'note_opened', 'captions_on', 'captions_off'] as const;

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
  '/profile/downloads',
  '/profile/notifications',
  '/profile/settings',
  '/feedback',
  '/search',
  '/highlights',
  '/notes',
  '/flow-tracker',
  '/flow-tracker/start',
  '/flow-tracker/sessions/[id]',
  '/prayer-requests',
  '/prayer-requests/new',
  '/prayer-requests/[id]',
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
    /** The teaching's published title, so "plays by title" is a breakdown rather than a lookup. */
    recording_title: 'title',
    series_id: 'id?',
    /** Whether the play began above position zero — a resume rather than a start. */
    resumed: 'boolean',
    speed: 'number',
  },
  /** One press on the transport: play, pause, a ten-second skip, or a drag of the scrubber. */
  playback_controlled: {
    action: PLAYBACK_CONTROL_ACTIONS,
    recording_id: 'id',
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
    /** How many pictures were attached; the sum over the event is "images uploaded". */
    image_count: 'number',
  },
  /** A reader acting on a note that exists: a reply opened, a reaction, a timestamp, a picture. */
  note_interacted: {
    action: NOTE_INTERACTIONS,
    recording_id: 'id',
  },
  /**
   * A highlight pinned, unpinned, or returned to from the Highlights page (a press on a row's play
   * or its link). `target` is what was highlighted, as the member saw it.
   */
  highlight_acted: {
    action: HIGHLIGHT_ACTIONS,
    target: HIGHLIGHT_TARGETS,
    recording_id: 'id',
  },
  /**
   * A search answered — one per request the page made, so a change to a control with words in
   * the box counts, because it is a new search. Never the words. The kinds searched travel as
   * one boolean each because a set is not an enum.
   */
  search_submitted: {
    /** 0 is words only, 1 is meaning only; the stops between lean one way or the other. */
    blend: 'number',
    per_teaching: SEARCH_PER_TEACHING_WORDS,
    kind_segment: 'boolean',
    kind_chapter: 'boolean',
    kind_note: 'boolean',
    kind_summary: 'boolean',
    kind_recording: 'boolean',
    result_count: 'number',
    meaning_available: 'boolean',
  },
  /** A hit acted on: its link followed, or its moment played in place. */
  search_result_opened: {
    action: SEARCH_RESULT_ACTIONS,
    kind: SEARCH_HIT_KINDS,
    recording_id: 'id',
    /** The hit's place in the list, from zero. */
    rank: 'number',
  },
  /** "Show more" pressed; `offset` is how many rows were already shown. */
  search_expanded: {
    offset: 'number',
  },
  /** One press in the Flow Tracker; never an answer, a rating or a question's words. */
  flow_tracker_acted: {
    action: FLOW_TRACKER_ACTIONS,
    session_id: 'id?',
    recording_id: 'id?',
  },
  transcript_acted: {
    action: TRANSCRIPT_ACTIONS,
    recording_id: 'id',
  },
  mind_map_acted: {
    action: MIND_MAP_ACTIONS,
    recording_id: 'id',
  },
  player_menu_acted: {
    action: PLAYER_MENU_ACTIONS,
    recording_id: 'id',
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
  /**
   * The tool's own name for leaving a page, sent with the same properties as the view it closes
   * so its session, bounce and time-on-page insights work. Sent when the route changes and when
   * the page is hidden; closing the app is the last leave of the last view.
   */
  $pageleave: {
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
        : K extends 'title'
          ? string
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
  if (kind === 'title') return typeof value === 'string' && value.trim() !== '';
  return typeof value === 'string' && (kind as readonly string[]).includes(value);
}

/** A title as it may leave: trimmed and cut to the bound, so a value is never a paragraph. */
export function analyticsTitle(value: string): string {
  return value.trim().slice(0, MAX_ANALYTICS_TITLE_LENGTH);
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
      clean[key] =
        kind === 'title' ? analyticsTitle(value as string) : (value as string | number | boolean | null);
    }
  }
  return clean;
}
