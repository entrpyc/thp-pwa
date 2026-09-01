/**
 * **What a chapter is, said once for the whole repository** ([3.22](docs/project/prd.md),
 * [4.19](docs/project/prd.md)).
 *
 * A chapter is a *named span* of one teaching. The worker proposes the spans, an admin edits them
 * in place, the member surfaces read them, and all three agree here rather than each carrying its
 * own arithmetic — because "which chapter is playing" is answered on every playback tick, in the
 * transport, on the scrubber, on the recording page and on the chapter page, and five answers to
 * one question is five chances to disagree.
 *
 * Three properties this file is shaped by:
 *
 * 1. **A chapter is a start, not a span** (project tdd 3.7). The stored row carries `start_ms` and
 *    no end: a chapter ends where the next one begins, and the last ends where the transcript does.
 *    {@link ChapterView} carries an `endMs` because the *reader* needs one, and it is derived on
 *    the way out rather than stored — which is what makes [3.22.2](docs/project/prd.md)'s tiling
 *    unrepresentable-broken rather than merely validated.
 * 2. **Position is derived too.** The number a list shows is the row's place in `start_ms` order,
 *    which is total and stable because the starts are unique per recording. See
 *    {@link ChapterView.position}.
 * 3. **Membership is arithmetic, never a pointer** (project tdd 3.8). A note, a citation and a
 *    transcript line belong to the chapter whose half-open span `[startMs, endMs)` contains their
 *    offset — computed by {@link chapterAt} and {@link isInChapter}, which the client and the API
 *    both call, so a note cannot be in one chapter on screen and another on the wire.
 */

import { CHAPTERS_SEGMENT, RECORDINGS_PATH, recordingPagePath } from './recordings';

// =================================================================================================
// The shape of a chapter list
// =================================================================================================

/**
 * **One chapter, as every surface reads it.**
 *
 * `position` and `endMs` are derived rather than stored ([4.19](docs/project/prd.md) — *End: not
 * stored*), and they are derived **once, on the way out of the API**, so no client re-derives them
 * and no two clients derive them differently.
 */
export interface ChapterView {
  readonly id: string;
  /**
   * Its place in the teaching, counting from 1 — the number the list shows
   * ([3.22.10](docs/project/prd.md)).
   *
   * Derived from `start_ms` order rather than stored, and that is not a saving: a stored position
   * would have to be renumbered by every split and every merge, which turns
   * [3.22.7](docs/project/prd.md)'s "one write to one row" (project tdd 3.7) into a rewrite of
   * every row after the one that changed, each of which must not half-fail.
   */
  readonly position: number;
  /** Inclusive start offset from the beginning of the recording, in milliseconds. */
  readonly startMs: number;
  /**
   * Exclusive end offset — **the next chapter's start**, and for the last chapter the end of the
   * transcript ([4.19](docs/project/prd.md)).
   *
   * Derived, and derived server-side: the last chapter's end is the end of the final transcript
   * segment, which is the only length this product knows about a recording
   * ([4.2](docs/project/prd.md), *Duration: auto-derived*) and which no client holds.
   */
  readonly endMs: number;
  readonly title: string;
  /** One short paragraph, plain text with line breaks ([3.22.3](docs/project/prd.md)). */
  readonly summary: string;
  /**
   * Whether a human has changed this chapter's title, summary or start
   * ([4.19](docs/project/prd.md), [4.17.5](docs/project/prd.md)).
   *
   * It travels because [3.22.8](docs/project/prd.md) asks a re-run to name what it discards, and
   * what it discards is exactly the rows carrying this.
   */
  readonly editedByAdmin: boolean;
}

/**
 * Payload of `GET /api/v1/recordings/{id}/chapters`.
 *
 * **An empty list is the ordinary answer**, not a failure: a teaching too short to hold two
 * chapters gets none ([3.22.4](docs/project/prd.md)), and so does one whose generation has not run
 * yet. Every surface that would show chapters leaves them out rather than drawing one row that is
 * the whole teaching, so the two cases read the same and correctly so.
 */
export interface ChaptersPayload {
  readonly chapters: readonly ChapterView[];
}

// =================================================================================================
// The shape the generator proposes, and the rules the handler holds it to
// =================================================================================================

/**
 * How long a chapter should be ([3.22.4](docs/project/prd.md)) — fifteen to twenty-five minutes,
 * aiming at the middle.
 *
 * Declared here rather than in the worker because two things read them: the worker, which asks the
 * model for spans in this range and refuses boundaries that would produce one below the floor, and
 * the *prompt*, which states the range to the model. A number spelled in both places is a number
 * that drifts in one of them.
 */
export const MIN_CHAPTER_MS = 15 * 60 * 1_000;

export const MAX_CHAPTER_MS = 25 * 60 * 1_000;

/** What the generator aims at, and what a fake divides by. The middle of the range above. */
export const TARGET_CHAPTER_MS = 20 * 60 * 1_000;

/**
 * **The fewest chapters a teaching may have** ([3.22.4](docs/project/prd.md)).
 *
 * Two, and the requirement is explicit about why: a recording too short to hold two gets none, and
 * every surface leaves them out rather than "offering a single row that is the whole teaching".
 * A list of one is therefore not a smaller list — it is a list that should not exist, and the
 * worker writes none rather than one.
 */
export const MIN_CHAPTERS = 2;

/**
 * How many chapters a recording of this length can hold, at the target length.
 *
 * One statement of the arithmetic, read by the worker when it decides whether to ask at all and by
 * the fake generator when it decides how many to propose — so "too short for two" means the same
 * thing on both sides of the port.
 */
export function chaptersThatFit(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.floor(durationMs / TARGET_CHAPTER_MS);
}

// =================================================================================================
// Membership — the arithmetic that replaces a pointer (project tdd 3.8)
// =================================================================================================

/**
 * **Whether this offset falls in this chapter** — `[startMs, endMs)`, half-open.
 *
 * Half-open is the whole of [3.22.2](docs/project/prd.md)'s "no gaps and no overlaps" as a
 * predicate: a note sitting exactly on a boundary belongs to the chapter that *starts* there and
 * to no other, so nothing is in two chapters and nothing between the first start and the last end
 * is in none.
 *
 * The same function is called by the API when it scopes a chapter page's tabs and by the client
 * when it buckets the notes it is already holding ([3.22.14](docs/project/prd.md); project tdd 5.9)
 * — which is what makes "client and server bucket a note identically" a fact rather than a hope.
 */
export function isInChapter(chapter: ChapterView, offsetMs: number): boolean {
  return offsetMs >= chapter.startMs && offsetMs < chapter.endMs;
}

/**
 * **The chapter playing at this offset**, or `null`.
 *
 * `null` has two causes and they are both ordinary: a teaching with no chapters
 * ([3.22.4](docs/project/prd.md)), and an offset before the first chapter's start — which is where
 * a recording whose transcript begins after a moment of silence sits for those first seconds.
 * Callers draw nothing in either case rather than guessing at the first chapter, because the
 * transport naming a chapter that is not playing is worse than it naming none.
 *
 * A linear scan: a teaching holds four or five chapters, and an index over five entries is more
 * code than the loop it replaces.
 */
export function chapterAt(
  chapters: readonly ChapterView[],
  offsetMs: number,
): ChapterView | null {
  return chapters.find((chapter) => isInChapter(chapter, offsetMs)) ?? null;
}

/**
 * **The list a member's search narrows to** ([3.22.11](docs/project/prd.md)).
 *
 * Title *and* summary, case-insensitively, on the chapters of the teaching in front of them and
 * nothing else — searching the library is [3.10](docs/project/prd.md) and is not this. A blank
 * query is not a search and answers the whole list, which is what makes clearing the field the way
 * back rather than a state with its own control.
 *
 * Here rather than in the panel because it is a rule about what matches, and the same rule is what
 * a test asserts without a browser in the way.
 */
export function filterChapters(
  chapters: readonly ChapterView[],
  query: string,
): readonly ChapterView[] {
  const wanted = query.trim().toLowerCase();
  if (wanted === '') return chapters;
  return chapters.filter(
    (chapter) =>
      chapter.title.toLowerCase().includes(wanted) ||
      chapter.summary.toLowerCase().includes(wanted),
  );
}

// =================================================================================================
// The wire contract
// =================================================================================================

/** This teaching's chapters, under the API prefix ([3.22.10](docs/project/prd.md)). */
export function recordingChaptersPath(recordingId: string): string {
  return `${RECORDINGS_PATH}/${recordingId}/chapters`;
}

/** Paths of the chapter resource itself, relative to the `/api/v1` prefix. */
export const CHAPTERS_PATH = '/chapters';

/** One chapter, where a retitle, a rewrite and a boundary move are `PUT`. */
export function chapterPath(chapterId: string): string {
  return `${CHAPTERS_PATH}/${chapterId}`;
}

/**
 * Where a chapter is cut in two ([3.22.7](docs/project/prd.md)).
 *
 * `POST` to a named sub-resource rather than a `PUT` of the row, for the reason publishing is a
 * sub-resource of a recording: what this does is not edit a chapter, it makes a second one.
 */
export function chapterSplitPath(chapterId: string): string {
  return `${chapterPath(chapterId)}/split`;
}

/**
 * Where a chapter is joined to the one before it ([3.22.7](docs/project/prd.md)).
 *
 * **Backwards, always.** A boundary is one thing shared by the pair either side of it, so "merge
 * these two" names the boundary between them — and the boundary a chapter owns is its own start.
 * Merging therefore removes *this* chapter's start and the chapter before it absorbs the span,
 * which is one delete rather than a delete and a rewrite. The first chapter has no boundary of its
 * own to remove and the route refuses it.
 */
export function chapterMergePath(chapterId: string): string {
  return `${chapterPath(chapterId)}/merge`;
}

/**
 * **Which chapter a read is scoped to** ([3.22.14](docs/project/prd.md); project tdd 5.9).
 *
 * A chapter *id*, never a pair of offsets: the span is `[start, next start)` and both sides
 * compute it from the same list, so neither has to send the other a boundary — and a client cannot
 * ask for a span that is not a chapter.
 */
export const CHAPTER_SCOPE_PARAM = 'chapter';

/** A recording read narrowed to one chapter's span. */
export function scopedToChapter(path: string, chapterId: string): string {
  const join = path.includes('?') ? '&' : '?';
  return `${path}${join}${CHAPTER_SCOPE_PARAM}=${encodeURIComponent(chapterId)}`;
}

/**
 * One chapter's page, on the web origin ([3.22.13](docs/project/prd.md)).
 *
 * Built from the recording's own page path, so a chapter's address is a teaching's address with
 * something added — which is what a chapter is, and what makes
 * {@link isRecordingPagePath} able to recognise both as routes that open a teaching.
 */
export function chapterPagePath(recordingId: string, chapterId: string): string {
  return `${recordingPagePath(recordingId)}/${CHAPTERS_SEGMENT}/${chapterId}`;
}

/**
 * Body of `PUT /api/v1/chapters/{id}` — a retitle, a rewrite, a boundary move, or all three
 * ([3.22.7](docs/project/prd.md)).
 *
 * All three fields together, for the reason a transcript correction sends all three of its own: an
 * edit states what the chapter now says and where it now starts, and a partial body would make
 * "the admin left the boundary alone" and "the form forgot to send it" the same request.
 */
export interface EditChapterRequest {
  readonly title: string;
  readonly summary: string;
  readonly startMs: number;
}

/**
 * Body of `POST /api/v1/chapters/{id}/split`.
 *
 * `startMs` is where the second chapter begins — a transcript segment's start strictly inside this
 * chapter ([3.22.5](docs/project/prd.md)). The title and summary are the *new* chapter's; the one
 * being split keeps its own, because a split does not rename what was already there.
 */
export interface SplitChapterRequest {
  readonly startMs: number;
  readonly title: string;
  readonly summary: string;
}

/**
 * Payload of every chapter write — **the whole list as it now reads**.
 *
 * The same shape the read answers with, and that is deliberate: a split adds a row, a merge removes
 * one and a boundary move changes what the row *after* it spans, so no write here can honestly
 * answer with one chapter. The tiling is the artefact (project tdd 3.7), so the tiling is what a
 * writer gets back.
 */
export type ChapterWritePayload = ChaptersPayload;

/** The most a chapter title may be. A name for a stretch of teaching, not a sentence about it. */
export const MAX_CHAPTER_TITLE_LENGTH = 200;

/** The most a chapter summary may be — one short paragraph ([4.19](docs/project/prd.md)). */
export const MAX_CHAPTER_SUMMARY_LENGTH = 2_000;
