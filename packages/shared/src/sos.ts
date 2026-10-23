/**
 * **The SOS signal on the wire** ([3.16](docs/project/prd.md); [4.15](docs/project/prd.md)) — a
 * prayer emergency channel: any member can reach the whole group, and the group can respond.
 *
 * What lives here is everything the three screens, the home card, the API and the database have
 * to agree about:
 *
 * 1. **The four urgencies**, in the order the board sorts them, with the words the PRD's table
 *    gives each. Derived into the database's `sos_urgency` enum rather than restated
 *    (tools/domain-declarations.ts registers it).
 * 2. **The ceilings.** How long a description, a reply and a closing note may be, and how many
 *    signals one member may hold open at once ([3.16.12](docs/project/prd.md)).
 * 3. **The wire contract** — the paths, the requests, the views — so the board, the signal page
 *    and the card all render the same row.
 *
 * **Nothing here is private** ([3.16.13](docs/project/prd.md)): every signal and every reply is
 * read by every member, so the author travels by name on every view, and there is no anonymous
 * shape to carry.
 */

// =================================================================================================
// The vocabulary
// =================================================================================================

/**
 * The four urgency colours, **most urgent first** — which is also the order the board lists them
 * in ([3.16.4](docs/project/prd.md)), so "most urgent" is this tuple's index and nothing else.
 */
export const SOS_URGENCIES = ['red', 'orange', 'yellow', 'green'] as const;

export type SosUrgency = (typeof SOS_URGENCIES)[number];

export function isSosUrgency(value: unknown): value is SosUrgency {
  return typeof value === 'string' && (SOS_URGENCIES as readonly string[]).includes(value);
}

/** The colour's name, as the picker and the row print it. */
export const SOS_URGENCY_LABEL: Record<SosUrgency, string> = {
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
};

/** When to use each — the PRD's own table, word for word, printed under the picker. */
export const SOS_URGENCY_MEANING: Record<SosUrgency, string> = {
  red: 'Immediate crisis — acute danger or medical emergency',
  orange: 'Serious situation needing prompt prayer',
  yellow: 'Difficult but not urgent — an ongoing struggle',
  green: 'General prayer request, no urgency',
};

/** Where an urgency sorts: `red` first. The database's `case` and the client's sort both read this. */
export function sosUrgencyRank(urgency: SosUrgency): number {
  return SOS_URGENCIES.indexOf(urgency);
}

/**
 * The board's order ([3.16.4](docs/project/prd.md)): most urgent first, and within one urgency the
 * most recently raised first. A pure comparator so the server's order and a client re-sort after
 * an optimistic change cannot disagree.
 */
export function compareSosSignals(
  a: { readonly urgency: SosUrgency; readonly raisedAt: string },
  b: { readonly urgency: SosUrgency; readonly raisedAt: string },
): number {
  const byUrgency = sosUrgencyRank(a.urgency) - sosUrgencyRank(b.urgency);
  if (byUrgency !== 0) return byUrgency;
  return b.raisedAt.localeCompare(a.raisedAt);
}

/** The two lists the board draws ([3.16.4](docs/project/prd.md), [3.16.10](docs/project/prd.md)). */
export const SOS_STATUSES = ['open', 'resolved'] as const;

export type SosStatus = (typeof SOS_STATUSES)[number];

export function isSosStatus(value: unknown): value is SosStatus {
  return typeof value === 'string' && (SOS_STATUSES as readonly string[]).includes(value);
}

// =================================================================================================
// The ceilings
// =================================================================================================

/**
 * A description is "short free text" ([3.16.2](docs/project/prd.md)): a couple of sentences saying
 * what prayer is needed. Five hundred characters is a paragraph, and it is the ceiling the
 * database holds too, so the number lives here once.
 */
export const MAX_SOS_DESCRIPTION_LENGTH = 500;

/** A reply is "a short message of encouragement or scripture" ([3.16.6](docs/project/prd.md)). */
export const MAX_SOS_REPLY_LENGTH = 500;

/** The optional note an author leaves when closing ([3.16.8](docs/project/prd.md)). */
export const MAX_SOS_CLOSING_NOTE_LENGTH = 500;

/**
 * **How many signals one member may hold open at once** ([3.16.12](docs/project/prd.md)) — the
 * cap that keeps the channel an emergency channel. Ten is far past what one person carries at
 * once and far short of what a runaway client could raise; the eleventh is refused with
 * `sos_limit` and a sentence saying to close one first.
 */
export const MAX_OPEN_SOS_PER_MEMBER = 10;

/** How many open signals the home card previews ([3.16.4](docs/project/prd.md) is the board's job). */
export const SOS_CARD_PREVIEW_COUNT = 3;

// =================================================================================================
// The routes
// =================================================================================================

/**
 * The signals, relative to the `/api/v1` prefix. `GET` lists them — `?status=open` (the default)
 * or `?status=resolved` — and `POST` raises one.
 */
export const SOS_PATH = '/sos';

export const SOS_STATUS_PARAM = 'status';

/** `GET` reads one signal in full — replies and who is praying; `DELETE` is an admin's removal (3.16.11). */
export function sosPath(signalId: string): string {
  return `${SOS_PATH}/${signalId}`;
}

/** `POST` closes a signal ([3.16.8](docs/project/prd.md), [3.16.9](docs/project/prd.md)). */
export function sosClosePath(signalId: string): string {
  return `${sosPath(signalId)}/close`;
}

/** `PUT` says the caller is praying; `DELETE` takes it back ([3.16.5](docs/project/prd.md)). */
export function sosPrayingPath(signalId: string): string {
  return `${sosPath(signalId)}/praying`;
}

/** `POST` replies ([3.16.6](docs/project/prd.md)). */
export function sosRepliesPath(signalId: string): string {
  return `${sosPath(signalId)}/replies`;
}

/** `DELETE` removes one reply — the author's own, or any by an admin. */
export function sosReplyPath(signalId: string, replyId: string): string {
  return `${sosRepliesPath(signalId)}/${replyId}`;
}

/** The board, on the web origin — where the home card goes ([3.16.4](docs/project/prd.md)). */
export const SOS_PAGE_PATH = '/prayer-requests';

/** The form that raises a signal ([3.16.1](docs/project/prd.md)). */
export const SOS_NEW_PAGE_PATH = `${SOS_PAGE_PATH}/new`;

/** One signal's page — where a notification about it lands ([3.17.3](docs/project/prd.md)). */
export function sosPagePath(signalId: string): string {
  return `${SOS_PAGE_PATH}/${signalId}`;
}

// =================================================================================================
// The views
// =================================================================================================

/** Who raised or replied — never anonymous ([3.16.13](docs/project/prd.md)). */
export interface SosAuthorView {
  readonly id: string;
  /** The display name ([3.1.12](docs/project/prd.md)); a monogram is drawn from it. */
  readonly displayName: string;
  /** A signed grant to the avatar, or `null` for the monogram. Never the key. */
  readonly avatarUrl: string | null;
}

/** One signal as the board lists it. */
export interface SosSignalView {
  readonly id: string;
  readonly urgency: SosUrgency;
  readonly description: string;
  readonly author: SosAuthorView;
  /** Whether the reading member raised it — what shows the Close control. */
  readonly mine: boolean;
  /** ISO 8601. The sort key within one urgency. */
  readonly raisedAt: string;
  /** ISO 8601 once closed, `null` while open ([3.16.10](docs/project/prd.md)). */
  readonly closedAt: string | null;
  /** The author's closing note, when they left one ([3.16.8](docs/project/prd.md)). */
  readonly closingNote: string | null;
  /** How many members have pressed Praying ([3.16.5](docs/project/prd.md)). */
  readonly prayingCount: number;
  /** Whether the reading member is among them. */
  readonly praying: boolean;
  readonly replyCount: number;
}

export interface SosReplyView {
  readonly id: string;
  readonly text: string;
  readonly author: SosAuthorView;
  readonly mine: boolean;
  /** ISO 8601. */
  readonly createdAt: string;
  /**
   * The thread under a top-level reply, oldest first — one level deep, so a reply inside a thread
   * always carries an empty list. Removing the top-level reply removes the thread with it.
   */
  readonly replies: readonly SosReplyView[];
}

/** One signal in full — the signal page. */
export interface SosSignalDetailView extends SosSignalView {
  /** The display names of everybody praying, in the order they pressed. */
  readonly prayingNames: readonly string[];
  /** The top-level replies, oldest first — a conversation reads downwards; each carries its thread. */
  readonly replies: readonly SosReplyView[];
}

/**
 * Payload of `GET /api/v1/sos`. `signals` is the list asked for, in the board's order;
 * `openCounts` is how many **open** signals there are at each urgency, whichever list was asked
 * for, so the home card's four chips and the board's Open tab read one request.
 */
export interface SosListPayload {
  readonly status: SosStatus;
  readonly signals: readonly SosSignalView[];
  readonly openCounts: Record<SosUrgency, number>;
}

/** Payload of `DELETE /api/v1/sos/{id}` — the signal is gone, and this is the id that went. */
export interface SosRemovedPayload {
  readonly signalId: string;
}

/** Payload of every write on one signal, and of `GET /api/v1/sos/{id}`: the signal as it now reads. */
export interface SosSignalPayload {
  readonly signal: SosSignalDetailView;
}

/** Body of `POST /api/v1/sos`. */
export interface RaiseSosRequest {
  readonly urgency: SosUrgency;
  readonly description: string;
}

/** Body of `POST /api/v1/sos/{id}/close`. The note is the author's and optional; an admin sends none. */
export interface CloseSosRequest {
  readonly note?: string | null;
}

/**
 * Body of `POST /api/v1/sos/{id}/replies`. `parentId` names the reply this one answers; absent or
 * null, it answers the signal itself. Naming a reply inside a thread attaches to the thread's top.
 */
export interface ReplyToSosRequest {
  readonly text: string;
  readonly parentId?: string | null;
}

// =================================================================================================
// The sentences
// =================================================================================================

/**
 * The title every member reads when a signal is raised ([3.17.7](docs/project/prd.md)). Names the
 * member and the colour, because the colour is the one word that says how to read the rest.
 */
export function sosRaisedNotificationTitle(displayName: string, urgency: SosUrgency): string {
  return `${displayName} raised a ${SOS_URGENCY_LABEL[urgency].toLowerCase()} prayer request`;
}

/**
 * The title an author reads when somebody replies ([3.17.8](docs/project/prd.md)). Spelled here,
 * like the note titles, so account deletion can rewrite it with the placeholder's name.
 */
export function sosReplyNotificationTitle(displayName: string): string {
  return `${displayName} replied to your prayer request`;
}

/** The title a reply's author reads when somebody answers in their thread. */
export function sosThreadReplyNotificationTitle(displayName: string): string {
  return `${displayName} replied to you on a prayer request`;
}

/** What a member reads when the cap refuses an eleventh signal. */
export const SOS_LIMIT_MESSAGE = `You already have ${MAX_OPEN_SOS_PER_MEMBER} open prayer requests. Close one before raising another.`;
