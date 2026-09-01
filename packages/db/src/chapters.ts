import { and, asc, count, eq, sql } from 'drizzle-orm';
import { getDatabase, queryable, withTransaction, type Executor } from './client';
import { chapter, segment, transcript } from './schema';

/**
 * **Chapter reads and writes** ([3.22](docs/project/prd.md)). Query construction lives in this
 * package and nowhere else — the import-boundary guard refuses a `drizzle-orm` import outside it.
 *
 * Five statements, and the shape of the set is the design rather than an inventory:
 *
 * - {@link replaceChapters} is what the pipeline step writes with — **the whole list or none of
 *   it** ([3.22.9](docs/project/prd.md)). The tiling is the artefact and half of one is not a
 *   smaller artefact, so a generation that fails partway leaves the previous list standing.
 * - {@link updateChapter} is a retitle, a rewrite or a boundary move: **one write to one row**
 *   (project tdd 3.7). A boundary is shared by the pair either side of it, and because a chapter
 *   ends where the next begins, moving *this* chapter's start is what ends the one before it — so
 *   [3.22.7](docs/project/prd.md)'s single action is genuinely a single `UPDATE`.
 * - {@link insertChapter} is a split and {@link deleteChapter} is a merge, for the same reason: a
 *   split adds a boundary and a merge removes one, and neither touches any other row.
 * - {@link listChapters} is the one read, and it hands back rows in `start_ms` order, which *is*
 *   the order — see the schema for why position is derived rather than stored.
 *
 * **Nothing here derives `position` or `endMs`.** Both are facts about a chapter's neighbours
 * rather than about its row, and the last chapter's end is a fact about the *transcript*; deriving
 * them per read path is how two surfaces come to disagree about where a chapter ends. They are
 * derived once, on the way out of the API, in `packages/web/src/server/chapters/service.ts`.
 */

/** One row of `chapter`, as the rest of the application sees it. */
export interface ChapterRow {
  readonly id: string;
  readonly recordingId: string;
  /** Inclusive start offset from the beginning of the recording, in milliseconds. */
  readonly startMs: number;
  readonly title: string;
  readonly summary: string;
  /** Which model, which model version and which prompt version produced the list it was in. */
  readonly generatedBy: unknown;
  readonly editedByAdmin: boolean;
  readonly createdAt: Date;
}

/** One chapter as a writer supplies it. The id, the parent and the timestamp are the table's. */
export interface NewChapter {
  readonly startMs: number;
  readonly title: string;
  readonly summary: string;
  /**
   * Whether a human authored this row rather than a model.
   *
   * Written rather than defaulted, because both writers care: a generation writes `false` for every
   * row it produces, and the half of a split that an admin typed is `true` from birth — that
   * chapter never existed as anything a model proposed.
   */
  readonly editedByAdmin?: boolean;
}

/**
 * **Make this list the recording's chapters, replacing whatever was there**
 * ([3.22.9](docs/project/prd.md)).
 *
 * Delete-then-insert inside one transaction, which is the requirement written as a write: a run
 * either replaces the whole list or leaves the previous one standing, because there is no moment at
 * which half of it is committed. That is also what makes the step idempotent
 * ([3.21.2.6](docs/project/prd.md)) — dispatch is at-least-once, and running this twice leaves one
 * list rather than two.
 *
 * **An empty list is a legal call** and deletes everything. That is
 * [3.22.4](docs/project/prd.md)'s "a recording too short to hold two of them gets none", written as
 * the absence of rows — and it is also what a re-run on a recording whose transcript has since been
 * shortened correctly produces.
 *
 * `generatedBy` is one value for the whole list rather than per row, because it is a fact about the
 * *run*: one model call produced every boundary in it ([4.19](docs/project/prd.md),
 * [4.17.5](docs/project/prd.md)).
 *
 * Nested by design: the handler passes the transaction it is already writing its own outcome in.
 */
export async function replaceChapters(
  recordingId: string,
  chapters: readonly NewChapter[],
  generatedBy: unknown,
  executor: Executor = getDatabase(),
): Promise<ChapterRow[]> {
  return withTransaction(async (tx) => {
    await tx.delete(chapter).where(eq(chapter.recordingId, recordingId));
    if (chapters.length === 0) return [];

    const inserted = await tx
      .insert(chapter)
      .values(
        chapters.map((one) => ({
          recordingId,
          startMs: one.startMs,
          title: one.title,
          summary: one.summary,
          generatedBy,
          editedByAdmin: one.editedByAdmin ?? false,
        })),
      )
      .returning();

    // In the order a reader reads them, so a writer's answer and the next read agree without the
    // caller sorting. The insert's own order is the array's, which is not a guarantee worth relying
    // on when one line makes it a fact.
    return (inserted as ChapterRow[]).sort((a, b) => a.startMs - b.startMs);
  }, executor);
}

/**
 * **This teaching's chapters, in order** — `start_ms` ascending, which is the order and the source
 * of the position a list shows ([3.22.10](docs/project/prd.md)).
 *
 * Decided here rather than by whichever reader asks, so one answer to "what order is this teaching
 * in" exists. `chapter_recording_start_idx` is this read.
 */
export async function listChapters(
  recordingId: string,
  executor: Executor = getDatabase(),
): Promise<ChapterRow[]> {
  const rows = await queryable(executor)
    .select()
    .from(chapter)
    .where(eq(chapter.recordingId, recordingId))
    .orderBy(asc(chapter.startMs));
  return rows as ChapterRow[];
}

/** One chapter by id, or `null`. The recording is on the row, so the caller can place it. */
export async function findChapterById(
  id: string,
  executor: Executor = getDatabase(),
): Promise<ChapterRow | null> {
  const rows = await queryable(executor).select().from(chapter).where(eq(chapter.id, id)).limit(1);
  return (rows[0] as ChapterRow | undefined) ?? null;
}

/** An edit, as the caller that has already checked it supplies it. */
export interface ChapterEdit {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly startMs: number;
}

/**
 * Apply an edit — a retitle, a rewrite, a boundary move, or all three
 * ([3.22.7](docs/project/prd.md)).
 *
 * **`edited_by_admin` is set here rather than passed in**, because it is not something a caller
 * decides: this statement exists only on the path a human takes, so a row it touches has by
 * definition been changed by one ([4.19](docs/project/prd.md), [4.17.5](docs/project/prd.md)).
 * Nothing anywhere clears it — that a chapter was edited stays true of it until the list is
 * replaced, which is exactly what [3.22.8](docs/project/prd.md)'s confirmation counts.
 *
 * Whether the new start is legal — inside the neighbours' bounds, and on a transcript segment's
 * start ([3.22.5](docs/project/prd.md)) — is the service's question, asked inside the same
 * transaction. What this cannot break is the tiling, because there is nothing to break: one row,
 * one start, and the unique index refuses a start another chapter already holds.
 */
export async function updateChapter(
  input: ChapterEdit,
  executor: Executor = getDatabase(),
): Promise<ChapterRow> {
  const rows = await queryable(executor)
    .update(chapter)
    .set({
      title: input.title,
      summary: input.summary,
      startMs: input.startMs,
      editedByAdmin: true,
    })
    .where(eq(chapter.id, input.id))
    .returning();

  const row = rows[0] as ChapterRow | undefined;
  if (!row) throw new Error('updateChapter returned no row');
  return row;
}

/** A new chapter cut out of an existing one, as the split path supplies it. */
export interface ChapterInsert extends NewChapter {
  readonly recordingId: string;
  /** Carried from the chapter being split, so the pair still says which run produced the list. */
  readonly generatedBy: unknown;
}

/**
 * **Cut a chapter in two by adding a boundary inside it** ([3.22.7](docs/project/prd.md)).
 *
 * One insert and nothing else: the chapter being split keeps its own start and its own title, and
 * simply ends earlier — because it ends where the next one begins and there is now a nearer next
 * one. Nothing about the row being split changes, which is why splitting cannot half-fail.
 *
 * `generated_by` is carried from the chapter it was cut out of rather than left empty: the boundary
 * is a person's, and `edited_by_admin` says so, but the *list* is still the one that run produced.
 */
export async function insertChapter(
  input: ChapterInsert,
  executor: Executor = getDatabase(),
): Promise<ChapterRow> {
  const rows = await queryable(executor)
    .insert(chapter)
    .values({
      recordingId: input.recordingId,
      startMs: input.startMs,
      title: input.title,
      summary: input.summary,
      generatedBy: input.generatedBy,
      editedByAdmin: input.editedByAdmin ?? true,
    })
    .returning();

  const row = rows[0] as ChapterRow | undefined;
  if (!row) throw new Error('insertChapter returned no row');
  return row;
}

/**
 * **Join a chapter to the one before it, by removing its boundary**
 * ([3.22.7](docs/project/prd.md)).
 *
 * One delete. The chapter before it now runs to where this one used to end, because that is what
 * "ends where the next one begins" means once this row is gone — so a merge writes nothing to the
 * surviving row and there is no second write that must not half-fail.
 *
 * Answers whether a row went, so a caller can tell a merge from a merge of something already gone.
 */
export async function deleteChapter(
  id: string,
  executor: Executor = getDatabase(),
): Promise<boolean> {
  const rows = await queryable(executor)
    .delete(chapter)
    .where(eq(chapter.id, id))
    .returning({ id: chapter.id });
  return rows.length > 0;
}

/**
 * **How many of a recording's chapters a human has changed**
 * ([3.22.8](docs/project/prd.md)).
 *
 * What the confirmation before a re-run names. A count rather than the rows, because the sentence
 * needs a number and reading five rows to print one would be reading them for nothing.
 */
export async function countEditedChapters(
  recordingId: string,
  executor: Executor = getDatabase(),
): Promise<number> {
  const rows = await queryable(executor)
    .select({ edited: count() })
    .from(chapter)
    .where(and(eq(chapter.recordingId, recordingId), eq(chapter.editedByAdmin, true)));
  return Number(rows[0]?.edited ?? 0);
}

/**
 * **The same count for every recording at once**, keyed by recording id.
 *
 * The pipeline screen reads one row per recording and needs one number per row
 * ([3.22.8](docs/project/prd.md)); asking per recording would be one query per teaching in the
 * library for a sentence nobody has pressed towards yet. Recordings with no edited chapters are
 * absent rather than present carrying a zero — the caller reads a missing key as none, which is
 * what it is.
 */
export async function countEditedChaptersByRecording(
  executor: Executor = getDatabase(),
): Promise<Map<string, number>> {
  const rows = await queryable(executor)
    .select({ recordingId: chapter.recordingId, edited: count() })
    .from(chapter)
    .where(eq(chapter.editedByAdmin, true))
    .groupBy(chapter.recordingId);

  return new Map(rows.map((row) => [row.recordingId, Number(row.edited)]));
}

/**
 * **How long this recording is, as far as the product knows** ([4.2](docs/project/prd.md),
 * *Duration: auto-derived*).
 *
 * The end of the last transcript segment, and `null` for a recording that has not been transcribed
 * — which is the honest answer, because nothing in this product inspects an audio file on upload.
 *
 * It lives beside the chapters rather than beside the transcript because there is exactly one thing
 * that needs it: the **last** chapter's end ([4.19](docs/project/prd.md)). Every other end is the
 * next chapter's start, and a media element is what tells the player how long a teaching actually
 * runs. A recording with chapters always has a transcript — the step that wrote them read it — so
 * a `null` here beside a non-empty list is a state the pipeline cannot produce.
 */
export async function findTranscriptEndMs(
  recordingId: string,
  executor: Executor = getDatabase(),
): Promise<number | null> {
  const rows = await queryable(executor)
    .select({ endMs: sql<number | null>`max(${segment.endMs})` })
    .from(segment)
    .innerJoin(transcript, eq(segment.transcriptId, transcript.id))
    .where(eq(transcript.recordingId, recordingId));

  const found = rows[0]?.endMs;
  return found === null || found === undefined ? null : Number(found);
}
