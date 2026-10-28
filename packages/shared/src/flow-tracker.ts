import { USERS_PATH } from './accounts';
import { CHAPTERS_PATH } from './chapters';
import { TAGS_PATH } from './tags';

/**
 * **The Flow Tracker on the wire** ([3.14](docs/project/prd.md); [4.12](docs/project/prd.md),
 * [4.13](docs/project/prd.md)) — a member's private route back into the teaching after they lost
 * the thread of it.
 *
 * A self-reflection tool, never a test. The question a chapter asks is not *do you remember this*
 * but *have you been able to live this out*, and the answer is one of five words about the member's
 * own week ([3.14.6](docs/project/prd.md)). Nothing here scores anything
 * ([3.14.9](docs/project/prd.md)): what a session produces is a reading list.
 *
 * Four things live here because the worker, the API, the member pages and the admin console each
 * have to agree about them:
 *
 * 1. **The vocabulary** — the five answers, which of them indicate a gap, the three states a
 *    session can be in, and what a question can be attached to. Each is derived into a database
 *    enum rather than restated (tools/domain-declarations.ts registers them).
 * 2. **The routes.** The member's sessions live under `/users/me`, the shape Highlights and the
 *    blocked list take: the only session anybody may read or change is their own
 *    ([3.14.8](docs/project/prd.md)), and a path that could name somebody else's would need an
 *    ownership rule to refuse what it should never have been able to express. No admin route lists
 *    anybody's sessions, and none will.
 * 3. **The views** every screen renders from, so the question screen and the reading list cannot
 *    disagree about what was asked or what was answered.
 * 4. **The admin contract** for curating questions ([3.14.11](docs/project/prd.md)): one on a
 *    chapter, edited where the chapter is; a bank on a tag, edited where the tag is.
 */

// =================================================================================================
// The vocabulary
// =================================================================================================

/**
 * **The five answers**, in the order the screen offers them ([3.14.6](docs/project/prd.md)):
 * from not remembering the chapter at all, through having spent no time on it and some progress,
 * to a number of experiences and seeing its result in one's life.
 *
 * The order is the scale, from information that never landed to a teaching lived out. The keys are
 * the database enum's values and predate the labels; they stay as they are so no answer already
 * given has to be rewritten.
 */
export const FLOW_ANSWERS = [
  'dont_remember',
  'recall_slightly',
  'remember_well',
  'not_embodied',
  'experience_daily',
] as const;

export type FlowAnswer = (typeof FLOW_ANSWERS)[number];

export function isFlowAnswer(value: unknown): value is FlowAnswer {
  return typeof value === 'string' && (FLOW_ANSWERS as readonly string[]).includes(value);
}

/** What each answer says on the button, worded close to the operator's own phrasing. */
export const FLOW_ANSWER_LABEL: Record<FlowAnswer, string> = {
  dont_remember: "I don't remember anything about that",
  recall_slightly: "I haven't spent time on that",
  remember_well: 'I have some progress with it',
  not_embodied: 'I have number of experiences with it',
  experience_daily: 'I see the result of that in my life',
};

/**
 * **Which answers put the chapter on the reading list** ([3.14.6](docs/project/prd.md)).
 *
 * Not remembering it, not having spent time on it, and having only some progress with it are gaps;
 * a number of experiences and seeing its result in one's life are not. The list is about living the
 * teaching out rather than holding it as information, which is why the first three count.
 */
export function isGapAnswer(answer: FlowAnswer): boolean {
  return answer === 'dont_remember' || answer === 'recall_slightly' || answer === 'remember_well';
}

/**
 * **The three states a session can be in** ([3.14.10](docs/project/prd.md)). One session is in
 * progress at a time; it completes when every question has an answer, or is abandoned when the
 * member starts another instead.
 */
export const FLOW_SESSION_STATUSES = ['in_progress', 'complete', 'abandoned'] as const;

export type FlowSessionStatus = (typeof FLOW_SESSION_STATUSES)[number];

export function isFlowSessionStatus(value: unknown): value is FlowSessionStatus {
  return typeof value === 'string' && (FLOW_SESSION_STATUSES as readonly string[]).includes(value);
}

/**
 * **What a question is attached to** ([3.14.4](docs/project/prd.md), [3.14.11](docs/project/prd.md)):
 * a chapter (the ordinary case, generated), a chapterless recording (generated from its summary),
 * or a tag (written by an admin, asked once per session whose range carries the tag).
 *
 * The same three words name the kind of a session item, because an item is a question as it was
 * asked — snapshotted with the scope it came from.
 */
export const FLOW_QUESTION_SCOPES = ['chapter', 'recording', 'tag'] as const;

export type FlowQuestionScope = (typeof FLOW_QUESTION_SCOPES)[number];

export function isFlowQuestionScope(value: unknown): value is FlowQuestionScope {
  return typeof value === 'string' && (FLOW_QUESTION_SCOPES as readonly string[]).includes(value);
}

/** The most a question may be. A question, not a paragraph about one. */
export const MAX_FLOW_QUESTION_LENGTH = 500;

/**
 * How many related chapters of other teachings a reading-list row carries at most
 * ([3.14.6](docs/project/prd.md)). Three: the row is a route back in, not a search result.
 */
export const MAX_RELATED_CHAPTERS = 3;

// =================================================================================================
// The routes
// =================================================================================================

/** The Flow Tracker's own page on the web origin, reached from the menu ([3.14.1](docs/project/prd.md)). */
export const FLOW_TRACKER_PAGE_PATH = '/flow-tracker';

/** Where a session is started: the chronological list of teachings ([3.14.2](docs/project/prd.md)). */
export const FLOW_TRACKER_START_PAGE_PATH = `${FLOW_TRACKER_PAGE_PATH}/start`;

/** One session's page — the question screen while it runs, the reading list once it is complete. */
export function flowSessionPagePath(sessionId: string): string {
  return `${FLOW_TRACKER_PAGE_PATH}/sessions/${sessionId}`;
}

/**
 * The teachings a session can start from, relative to the `/api/v1` prefix: every published
 * teaching, newest first, with how many questions each would contribute.
 */
export const FLOW_TEACHINGS_PATH = '/flow-tracker/teachings';

/**
 * The signed-in account's sessions. `GET` answers the one in progress and the completed ones;
 * `POST` starts a new one from a divergence point.
 */
export const FLOW_SESSIONS_PATH = `${USERS_PATH}/me/flow-sessions`;

/** One session of the caller's own. */
export function flowSessionPath(sessionId: string): string {
  return `${FLOW_SESSIONS_PATH}/${sessionId}`;
}

/** `POST` marks the session abandoned ([3.14.10](docs/project/prd.md)). */
export function flowSessionAbandonPath(sessionId: string): string {
  return `${flowSessionPath(sessionId)}/abandon`;
}

/** `PUT` answers one question of the session. */
export function flowSessionItemPath(sessionId: string, itemId: string): string {
  return `${flowSessionPath(sessionId)}/items/${itemId}`;
}

/** `PUT` ticks a reading-list row off, or un-ticks it ([3.14.9](docs/project/prd.md)). */
export function flowSessionItemDonePath(sessionId: string, itemId: string): string {
  return `${flowSessionItemPath(sessionId, itemId)}/done`;
}

/** The generated question on one chapter, where an admin rewrites it ([3.14.11](docs/project/prd.md)). */
export function chapterQuestionPath(chapterId: string): string {
  return `${CHAPTERS_PATH}/${chapterId}/question`;
}

/** A tag's question bank: `GET` lists it, `POST` adds to it ([3.14.11](docs/project/prd.md)). */
export function tagQuestionsPath(tagId: string): string {
  return `${TAGS_PATH}/${tagId}/questions`;
}

/** One question of a tag's bank: `PUT` rewrites it, `DELETE` removes it. */
export function tagQuestionPath(tagId: string, questionId: string): string {
  return `${tagQuestionsPath(tagId)}/${questionId}`;
}

// =================================================================================================
// Bodies and payloads — the member's side
// =================================================================================================

/** The study a teaching is in, as a Flow Tracker row prints it: its name and a signed cover URL. */
export interface FlowSeriesRef {
  readonly id: string;
  readonly title: string;
  readonly artworkUrl: string | null;
}

/** A teaching as the start screen lists it, and as a session item names the one it came from. */
export interface FlowTeachingRef {
  readonly id: string;
  readonly title: string;
  /** `YYYY-MM-DD`. */
  readonly recordedAt: string;
  readonly series: FlowSeriesRef | null;
}

/**
 * One row of the start screen ([3.14.2](docs/project/prd.md)): the teaching, how many generated
 * questions it would contribute, and which tags it carries — so the screen can say how many
 * questions a pick would cover before the member confirms.
 */
export interface FlowTeachingView extends FlowTeachingRef {
  /** Generated questions on this teaching: one per chapter, or one for a chapterless teaching. */
  readonly questionCount: number;
  /** The tags on it, by id; `tagQuestionCounts` on the payload says what each adds. */
  readonly tagIds: readonly string[];
}

/** Payload of `GET /api/v1/flow-tracker/teachings`. Newest first, the order the start screen draws. */
export interface FlowTeachingsPayload {
  readonly teachings: readonly FlowTeachingView[];
  /** How many bank questions each tag carries, by tag id. A tag with none is absent. */
  readonly tagQuestionCounts: Readonly<Record<string, number>>;
}

/** Body of `POST /api/v1/users/me/flow-sessions`: the teaching the member fell behind at. */
export interface StartFlowSessionRequest {
  readonly divergenceRecordingId: string;
}

/** Body of `PUT …/items/{id}`. */
export interface AnswerFlowItemRequest {
  readonly answer: FlowAnswer;
}

/** Body of `PUT …/items/{id}/done`. */
export interface MarkFlowItemRequest {
  readonly done: boolean;
}

/** The chapter a question came from, as it was when the question was asked. */
export interface FlowChapterRef {
  /** `null` once the chapter has been deleted or regenerated away; the title and start survive. */
  readonly id: string | null;
  readonly title: string;
  /** The chapter's summary as asked ([3.14.5](docs/project/prd.md)); `null` on a related chapter, which prints its title alone. */
  readonly summary: string | null;
  readonly startMs: number;
}

/**
 * **One question of a session, as it was asked** ([3.14.3](docs/project/prd.md),
 * [3.14.10](docs/project/prd.md)).
 *
 * The text, the chapter's title and start are snapshots: an admin rewriting a question or a
 * regeneration replacing the chapter changes nothing about a question the member already saw. What
 * is live is `chapter.id`, which goes `null` when the chapter no longer exists — an answered item
 * keeps its place on the list, an unanswered one is dropped from the session.
 */
export interface FlowSessionItemView {
  readonly id: string;
  /** Its place in the session, counting from 1, in the order the questions are asked. */
  readonly position: number;
  readonly kind: FlowQuestionScope;
  readonly question: string;
  /** The teaching the question is about; `null` for a tag question, which is about several. */
  readonly recording: FlowTeachingRef | null;
  /** Present on a `chapter` item. */
  readonly chapter: FlowChapterRef | null;
  /** Present on a `tag` item. */
  readonly tag: { readonly id: string; readonly name: string } | null;
  readonly answer: FlowAnswer | null;
  /** ISO 8601, or `null` while unanswered. */
  readonly answeredAt: string | null;
  /** Whether the member ticked this row off the reading list ([3.14.9](docs/project/prd.md)). */
  readonly done: boolean;
}

/** A related chapter of another teaching, beneath a reading-list row ([3.14.6](docs/project/prd.md), [3.9.8](docs/project/prd.md)). */
export interface FlowRelatedChapter {
  readonly recording: FlowTeachingRef;
  readonly chapter: FlowChapterRef;
}

/** One row of the reading list: the item, where to open it, and what else speaks to it. */
export interface FlowReadingRow {
  readonly item: FlowSessionItemView;
  /**
   * The teachings in the session's range carrying this tag — only on a `tag` row, which is about
   * several teachings rather than one and recommends them all.
   */
  readonly taggedTeachings: readonly FlowTeachingRef[];
  readonly related: readonly FlowRelatedChapter[];
}

/**
 * The reading list grouped by teaching, **oldest first** ([3.14.9](docs/project/prd.md)) — the
 * member reads from where they lost the flow towards today. A group with no teaching holds the tag
 * rows, which span several.
 */
export interface FlowReadingGroup {
  readonly recording: FlowTeachingRef | null;
  readonly rows: readonly FlowReadingRow[];
}

/** A session as the Flow Tracker page lists it ([3.14.10](docs/project/prd.md)). */
export interface FlowSessionSummary {
  readonly id: string;
  readonly status: FlowSessionStatus;
  /** ISO 8601. */
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly divergence: FlowTeachingRef;
  /** How many teachings the range covered, and how many questions. */
  readonly teachingCount: number;
  readonly questionCount: number;
  readonly answeredCount: number;
  /** How many answers indicated a gap — the length of the reading list. */
  readonly gapCount: number;
}

/**
 * One session in full: every live item in the order asked, and — once complete — the reading list.
 * `readingList` is `null` while the session is in progress or abandoned.
 */
export interface FlowSessionView extends FlowSessionSummary {
  readonly items: readonly FlowSessionItemView[];
  readonly readingList: readonly FlowReadingGroup[] | null;
}

/** Payload of `GET /api/v1/users/me/flow-sessions`. */
export interface FlowSessionsPayload {
  readonly active: FlowSessionSummary | null;
  /** Completed sessions, newest first. Abandoned ones are not listed. */
  readonly completed: readonly FlowSessionSummary[];
}

/** Payload of every read and write of one session: the session as it now stands. */
export interface FlowSessionPayload {
  readonly session: FlowSessionView;
}

// =================================================================================================
// Bodies and payloads — the admin's side ([3.14.11](docs/project/prd.md))
// =================================================================================================

/** Body of `PUT /api/v1/chapters/{id}/question` and of the tag-bank writes. */
export interface SetFlowQuestionRequest {
  readonly text: string;
}

/** A question in a tag's bank. */
export interface TagQuestionView {
  readonly id: string;
  readonly text: string;
  /** ISO 8601. */
  readonly createdAt: string;
}

/** Payload of every tag-bank read and write: the bank as it now stands, oldest first. */
export interface TagQuestionsPayload {
  readonly questions: readonly TagQuestionView[];
}

/** Payload of `PUT /api/v1/chapters/{id}/question`. */
export interface ChapterQuestionPayload {
  readonly chapterId: string;
  readonly question: string;
}

// =================================================================================================
// The rules both sides compute
// =================================================================================================

/** The first unanswered item, or `null` when every one is answered. */
export function nextUnanswered(items: readonly FlowSessionItemView[]): FlowSessionItemView | null {
  return items.find((one) => one.answer === null) ?? null;
}

/** The items whose answer indicates a gap, in the order they were asked. */
export function gapItems(items: readonly FlowSessionItemView[]): FlowSessionItemView[] {
  return items.filter((one) => one.answer !== null && isGapAnswer(one.answer));
}

export const FLOW_SESSION_IN_PROGRESS_MESSAGE =
  'You already have a session in progress. Continue it, or abandon it before starting another.';
