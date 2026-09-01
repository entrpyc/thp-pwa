import {
  deleteChapter,
  findChapterById,
  findTranscriptByRecording,
  findTranscriptEndMs,
  findVisibleRecording,
  insertChapter,
  listChapters,
  listSegments,
  updateChapter,
  withTransaction,
  type ChapterRow,
  type Executor,
} from '@thp/db';
import {
  MAX_CHAPTER_SUMMARY_LENGTH,
  MAX_CHAPTER_TITLE_LENGTH,
  MIN_CHAPTERS,
  type ChapterView,
  type ChaptersPayload,
  type EditChapterRequest,
  type SplitChapterRequest,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';

/**
 * **A teaching's chapters, as a member reads them and as an admin edits them**
 * ([3.22](docs/project/prd.md)).
 *
 * Two things this module owns and nothing else does.
 *
 * **The derivation.** A stored chapter is a start with two pieces of text on it; a
 * {@link ChapterView} carries a position and an end as well, and both are facts about the row's
 * *neighbours* rather than about the row (project tdd 3.7). {@link describeChapters} is the one
 * place either is computed, which is what stops the recording page and the transport ever disagreeing
 * about where a chapter ends.
 *
 * **The tiling, kept true through every edit** ([3.22.2](docs/project/prd.md),
 * [3.22.7](docs/project/prd.md)). Because a chapter has no end, a gap is not representable — so
 * what the edit paths have to protect is narrower than it looks, and it is exactly three things:
 *
 * 1. A boundary stays **strictly between its neighbours'**. A move that crossed one would reorder
 *    the list, and reordering is not an edit anybody asked for — 3.22.7's move "ends one chapter and
 *    starts the next", which is only what it says while the pair stays the pair.
 * 2. A boundary lands on **a transcript segment's start** ([3.22.5](docs/project/prd.md)). No
 *    chapter opens half a sentence in.
 * 3. The **first chapter keeps the first boundary**. Moving it would put the opening of the teaching
 *    in no chapter at all, which is the one hole the no-end design cannot rule out on its own.
 *
 * A merge is checked against nothing but "there is something before it", and a split against
 * nothing but 2 — because neither can produce a gap or an overlap however it is aimed.
 *
 * **One gate, and it is the recording's** ([3.22.6](docs/project/prd.md)). Chapters ride
 * publication, so the only question the read asks is the one `findVisibleRecording` already answers
 * for the teaching itself — the same read the recording page, the transcript and the scripture panel
 * go through. There is no second publication state on a chapter and nothing here compares one.
 */

/**
 * **The stored rows, with the position and the end each reader needs.**
 *
 * `rows` must be in `start_ms` order, which is what `listChapters` decides — position is that
 * order, one-based, and an unsorted list would number the teaching wrongly rather than merely
 * inconveniently.
 *
 * `transcriptEndMs` is where the **last** chapter ends ([4.19](docs/project/prd.md)); every other
 * end is the next row's start. A list with rows and no transcript end is a state the pipeline
 * cannot produce — the step that wrote the rows read the transcript — so it falls back to the last
 * start, which keeps the last chapter empty rather than making it unbounded.
 */
export function describeChapters(
  rows: readonly ChapterRow[],
  transcriptEndMs: number | null,
): ChapterView[] {
  return rows.map((row, index) => ({
    id: row.id,
    position: index + 1,
    startMs: row.startMs,
    endMs: rows[index + 1]?.startMs ?? transcriptEndMs ?? row.startMs,
    title: row.title,
    summary: row.summary,
    editedByAdmin: row.editedByAdmin,
  }));
}

/**
 * **A published teaching's chapters, as a member reads them** ([3.22.10](docs/project/prd.md)).
 *
 * **An empty list is the ordinary answer**, not an error: a teaching too short to hold two chapters
 * has none ([3.22.4](docs/project/prd.md)), and so does one whose generation has not run. Both are
 * the same fact as far as a member is concerned — there are no chapters here — and the surfaces
 * leave the tab out rather than drawing an empty one.
 */
export async function readChaptersFor(
  actor: Actor,
  recordingId: string,
): Promise<ChaptersPayload> {
  const visible = await findVisibleRecording(recordingId, { includeUnpublished: false });
  if (visible === null) {
    logger.warn('chapters.read.refused', {
      actorId: actor.id,
      action: 'recording.browse',
      target: `recording:${recordingId}`,
      reason: 'not-visible',
      code: 'not_found',
    });
    throw ApiError.notFound('There is no such teaching.');
  }

  const chapters = await readChapterList(recordingId);

  logger.info('chapters.read', {
    actorId: actor.id,
    action: 'recording.browse',
    target: `recording:${recordingId}`,
    chapters: chapters.length,
  });

  return { chapters };
}

/**
 * The derived list for one recording, with **no gate applied**.
 *
 * Used by the read above once the gate has answered, and by the scoped reads
 * ([3.22.14](docs/project/prd.md)) which have each already asked their own route's gate about the
 * same recording. Exported so the three cannot each build a list of their own — a chapter's span has
 * to be the same span whichever tab is asking for it.
 */
export async function readChapterList(
  recordingId: string,
  executor?: Executor,
): Promise<ChapterView[]> {
  const [rows, endMs] = await Promise.all([
    listChapters(recordingId, executor),
    findTranscriptEndMs(recordingId, executor),
  ]);
  return describeChapters(rows, endMs);
}

/**
 * **The span a chapter covers**, or `null` when this recording has no such chapter
 * (project tdd 5.9).
 *
 * The half-open interval `[start, next start)`, computed from the same list the client holds — which
 * is why a scoped read takes a chapter **id** rather than a pair of offsets: neither side sends the
 * other a boundary, and a client cannot ask for a span that is not a chapter.
 *
 * A chapter id belonging to a *different* recording answers `null` rather than that chapter's span.
 * A scope is a narrowing of the teaching in the path, and one that came from somewhere else is not
 * a narrowing of anything.
 */
export async function findChapterScope(
  recordingId: string,
  chapterId: string,
): Promise<ChapterView | null> {
  const chapters = await readChapterList(recordingId);
  return chapters.find((one) => one.id === chapterId) ?? null;
}

/**
 * The scope a request asked for, refusing an id that names no chapter of this teaching.
 *
 * `null` in, `null` out: a request with no `?chapter=` is not scoped, which is the ordinary read
 * and not a special case. A request naming a chapter that does not exist is refused rather than
 * answered unscoped — a member whose scope silently widened would be shown the whole teaching's
 * notes under one chapter's heading.
 */
export async function requireChapterScope(
  recordingId: string,
  chapterId: string | null,
): Promise<ChapterView | null> {
  if (chapterId === null) return null;
  const scope = await findChapterScope(recordingId, chapterId);
  if (scope === null) throw ApiError.notFound('There is no such chapter of this teaching.');
  return scope;
}

// =================================================================================================
// Editing in place ([3.22.7](docs/project/prd.md), [3.19.14](docs/project/prd.md))
// =================================================================================================

/**
 * **Retitle a chapter, rewrite its summary, move its boundary** — one action and one write
 * ([3.22.7](docs/project/prd.md)).
 *
 * The read of the neighbours and the write happen **in one transaction**, because the caller is
 * deciding whether a write is legal against rows a second admin may be moving at the same moment. A
 * check outside the write's transaction has a window in it, and the window is exactly wide enough
 * for two boundaries to cross.
 *
 * Answers with the whole list rather than the row, because a boundary move changes where the
 * chapter *before* it ends: a payload carrying one chapter would be a payload that is wrong about
 * two of them.
 */
export async function editChapter(
  actor: Actor,
  chapterId: string,
  body: unknown,
): Promise<ChaptersPayload> {
  const request = parseEdit(body);

  const recordingId = await withTransaction(async (tx) => {
    const chapter = await requireChapter(chapterId, tx);
    const siblings = await listChapters(chapter.recordingId, tx);
    const index = siblings.findIndex((one) => one.id === chapterId);

    if (request.startMs !== chapter.startMs) {
      await checkBoundary(chapter.recordingId, siblings, index, request.startMs, tx);
    }

    await updateChapter(
      {
        id: chapterId,
        title: request.title,
        summary: request.summary,
        startMs: request.startMs,
      },
      tx,
    );
    return chapter.recordingId;
  });

  logger.info('chapter.edit', {
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'chapter.edit',
    target: `chapter:${chapterId}`,
    recordingId,
  });

  return { chapters: await readChapterList(recordingId) };
}

/**
 * **Cut a chapter in two** ([3.22.7](docs/project/prd.md)).
 *
 * One insert. The chapter being split keeps its start and its title and simply ends earlier,
 * because it ends where the next one begins and there is now a nearer next one — so a split cannot
 * leave a gap and cannot half-fail.
 *
 * The new boundary must be a transcript segment's start strictly inside this chapter: on the
 * chapter's own start it is not a cut, and past its end it is a cut in a different chapter.
 */
export async function splitChapter(
  actor: Actor,
  chapterId: string,
  body: unknown,
): Promise<ChaptersPayload> {
  const request = parseSplit(body);

  const recordingId = await withTransaction(async (tx) => {
    const chapter = await requireChapter(chapterId, tx);
    const siblings = await listChapters(chapter.recordingId, tx);
    const index = siblings.findIndex((one) => one.id === chapterId);
    const next = siblings[index + 1];

    if (request.startMs <= chapter.startMs) {
      throw ApiError.invalidInput('A split has to fall after the start of the chapter it divides.');
    }
    if (next !== undefined && request.startMs >= next.startMs) {
      throw ApiError.invalidInput('A split has to fall before the start of the next chapter.');
    }
    await requireSegmentStart(chapter.recordingId, request.startMs, tx);

    await insertChapter(
      {
        recordingId: chapter.recordingId,
        startMs: request.startMs,
        title: request.title,
        summary: request.summary,
        generatedBy: chapter.generatedBy,
      },
      tx,
    );
    return chapter.recordingId;
  });

  logger.info('chapter.split', {
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'chapter.edit',
    target: `chapter:${chapterId}`,
    recordingId,
  });

  return { chapters: await readChapterList(recordingId) };
}

/**
 * **Join a chapter to the one before it** ([3.22.7](docs/project/prd.md)).
 *
 * One delete: removing this chapter's boundary is what merges the pair either side of it, and the
 * chapter before it runs on to where this one used to end without being written to at all.
 *
 * **The first chapter cannot be merged.** It has no boundary of its own to remove — its start is
 * the start of the teaching — so the request names no pair.
 *
 * **A merge that would leave one chapter empties the list** ([3.22.4](docs/project/prd.md)). Every
 * surface leaves chapters out rather than offering a single row that is the whole teaching, so a
 * two-chapter teaching merged into one has no chapters, and the delete takes both.
 */
export async function mergeChapter(
  actor: Actor,
  chapterId: string,
): Promise<ChaptersPayload> {
  const outcome = await withTransaction(async (tx) => {
    const chapter = await requireChapter(chapterId, tx);
    const siblings = await listChapters(chapter.recordingId, tx);
    const index = siblings.findIndex((one) => one.id === chapterId);

    if (index <= 0) {
      throw ApiError.invalidInput(
        'The first chapter starts where the teaching does, so there is nothing before it to merge into.',
      );
    }

    // Two chapters merged is one chapter, which 3.22.4 refuses — so the survivor goes as well and
    // the teaching has none. Done here rather than left to the reader, because a list of one is a
    // state no surface will draw and therefore a state nothing should be able to store.
    const emptied = siblings.length <= MIN_CHAPTERS;
    for (const one of emptied ? siblings : [chapter]) {
      await deleteChapter(one.id, tx);
    }

    return { recordingId: chapter.recordingId, emptied };
  });

  logger.info('chapter.merge', {
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'chapter.edit',
    target: `chapter:${chapterId}`,
    recordingId: outcome.recordingId,
    // Worth a field of its own: a merge that emptied the list is the one that took a row the admin
    // did not name, and an operator reading this back should not have to infer it.
    emptied: outcome.emptied,
  });

  return { chapters: await readChapterList(outcome.recordingId) };
}

// =================================================================================================
// The rules
// =================================================================================================

/** The chapter, or the refusal a caller reads. Asked before anything is written, every time. */
async function requireChapter(id: string, executor: Executor): Promise<ChapterRow> {
  const chapter = await findChapterById(id, executor);
  if (chapter === null) throw ApiError.notFound('There is no chapter with that id.');
  return chapter;
}

/**
 * **Where a boundary may be moved to** ([3.22.2](docs/project/prd.md),
 * [3.22.5](docs/project/prd.md), [3.22.7](docs/project/prd.md)).
 *
 * Strictly between the neighbours' starts, on a segment's start, and never the first chapter's.
 * Each refusal says which of the three it is, because an admin dragging a boundary needs to know
 * whether they went too far or landed between two sentences.
 */
async function checkBoundary(
  recordingId: string,
  siblings: readonly ChapterRow[],
  index: number,
  startMs: number,
  executor: Executor,
): Promise<void> {
  if (index === 0) {
    throw ApiError.invalidInput(
      'The first chapter starts where the teaching does, and that boundary cannot be moved.',
    );
  }

  const previous = siblings[index - 1];
  const next = siblings[index + 1];

  if (previous !== undefined && startMs <= previous.startMs) {
    throw ApiError.invalidInput('A boundary has to stay after the start of the chapter before it.');
  }
  if (next !== undefined && startMs >= next.startMs) {
    throw ApiError.invalidInput('A boundary has to stay before the start of the chapter after it.');
  }

  await requireSegmentStart(recordingId, startMs, executor);
}

/**
 * **A boundary falls on the start of a transcript segment, never inside one**
 * ([3.22.5](docs/project/prd.md)).
 *
 * Checked against the transcript rather than trusted from the client, because it is the requirement
 * rather than a convenience the form offers: "no chapter opens half a sentence in" is only true if
 * the API is what says so.
 *
 * A recording with no transcript has no legal boundary at all, and a chapter on such a recording is
 * a state the pipeline cannot produce — so this refuses rather than waving it through.
 */
async function requireSegmentStart(
  recordingId: string,
  startMs: number,
  executor: Executor,
): Promise<void> {
  const transcript = await findTranscriptByRecording(recordingId, executor);
  if (transcript === null) {
    throw ApiError.invalidInput('This teaching has no transcript, so a boundary has nowhere to sit.');
  }
  const segments = await listSegments(transcript.id, executor);
  if (!segments.some((one) => one.startMs === startMs)) {
    throw ApiError.invalidInput(
      'A chapter has to begin where a line of the transcript begins, so that no chapter opens ' +
        'half a sentence in.',
    );
  }
}

interface ParsedEdit {
  readonly title: string;
  readonly summary: string;
  readonly startMs: number;
}

/**
 * All three fields together, for the reason a transcript correction sends all three of its own: an
 * edit states what the chapter now says and where it now starts, and a partial body would make "the
 * admin left the boundary alone" and "the form forgot to send it" the same request.
 */
function parseEdit(body: unknown): ParsedEdit {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with the chapter’s title, summary and start.');
  }
  const { title, summary, startMs } = body as Partial<EditChapterRequest>;
  return {
    title: checkTitle(title),
    summary: checkSummary(summary),
    startMs: checkStartMs(startMs),
  };
}

function parseSplit(body: unknown): ParsedEdit {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object naming where to split and what to call it.');
  }
  const { title, summary, startMs } = body as Partial<SplitChapterRequest>;
  return {
    title: checkTitle(title),
    summary: checkSummary(summary),
    startMs: checkStartMs(startMs),
  };
}

function checkTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw ApiError.invalidInput('Give the chapter a title.');
  }
  const title = value.trim();
  if (title.length > MAX_CHAPTER_TITLE_LENGTH) {
    throw ApiError.invalidInput(
      `A chapter title is ${MAX_CHAPTER_TITLE_LENGTH} characters or fewer.`,
    );
  }
  return title;
}

/**
 * An empty summary is refused rather than stored blank: [4.19](docs/project/prd.md) says a chapter
 * carries one, and a surface drawing a heading over nothing is worse than a form that asked again.
 */
function checkSummary(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw ApiError.invalidInput('Give the chapter a summary.');
  }
  const summary = value.trim();
  if (summary.length > MAX_CHAPTER_SUMMARY_LENGTH) {
    throw ApiError.invalidInput(
      `A chapter summary is ${MAX_CHAPTER_SUMMARY_LENGTH} characters or fewer.`,
    );
  }
  return summary;
}

function checkStartMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw ApiError.invalidInput('A chapter starts at a whole number of milliseconds.');
  }
  return value;
}
