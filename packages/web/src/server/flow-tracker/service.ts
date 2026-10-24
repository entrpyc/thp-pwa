import {
  abandonFlowSession,
  answerFlowSessionItem,
  completeFlowSession,
  countQuestionsByRecording,
  countQuestionsByTag,
  countUnansweredFlowItems,
  findActiveFlowSessionForMember,
  findFlowSessionForMember,
  insertFlowSession,
  isUniqueViolation,
  listFlowSessionItems,
  listFlowSessionsForMember,
  listQuestionsForRecordings,
  listRelatedChapters,
  listTagQuestionsForTags,
  listTagsForRecordings,
  listVisibleRecordings,
  setFlowSessionItemDone,
  type FlowSessionItemRow,
  type FlowSessionListRow,
  type NewFlowSessionItem,
  type VisibleRecordingRow,
} from '@thp/db';
import {
  FLOW_SESSION_IN_PROGRESS_MESSAGE,
  MAX_RELATED_CHAPTERS,
  isFlowAnswer,
  isGapAnswer,
  type FlowReadingGroup,
  type FlowReadingRow,
  type FlowSessionItemView,
  type FlowSessionPayload,
  type FlowSessionSummary,
  type FlowSessionView,
  type FlowSessionsPayload,
  type FlowTeachingRef,
  type FlowTeachingsPayload,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';
import { mintArtworkGrant } from '@/server/series/artwork-grant';

/**
 * **The Flow Tracker, from the member's side** ([3.14](docs/project/prd.md)) — the teachings a
 * session can start from, starting one, answering it, and reading the route back in.
 *
 * Who may is the policy module's answer, asked by the routes, and every session is the caller's
 * own by construction: nothing in the path names whose ([3.14.8](docs/project/prd.md)). What this
 * module decides is **what a session holds** — which teachings are in range, which questions are
 * asked and in what order — and **what a gap recommends**.
 *
 * **Every write answers the session as it now stands**, the shape every Highlights write takes: a
 * screen that pressed an answer renders what came back rather than merging a verdict into a session
 * it fetched earlier.
 *
 * **Refusals say nothing about what exists.** A session that is not the caller's and an id that is
 * nobody's are both `not_found` with the same sentence.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_SUCH_SESSION = 'There is no such session.';
const NO_SUCH_TEACHING = 'That teaching is not available.';

// =================================================================================================
// The start screen
// =================================================================================================

/**
 * **Every published teaching, newest first, with how many questions each would contribute**
 * ([3.14.2](docs/project/prd.md)). The same list and the same order the library shows, because the
 * range a session covers is "from this teaching to the most recent", and that only means one thing
 * while there is one order.
 */
export async function listFlowTeachingsFor(actor: Actor): Promise<FlowTeachingsPayload> {
  const rows = await listVisibleRecordings({ includeUnpublished: false });
  const ids = rows.map((row) => row.id);
  const [questions, tagsByRecording, tagQuestions] = await Promise.all([
    countQuestionsByRecording(),
    listTagsForRecordings(ids),
    countQuestionsByTag(),
  ]);

  const teachings = await Promise.all(
    rows.map(async (row) => ({
      ...(await teachingRef(row)),
      questionCount: questions.get(row.id) ?? 0,
      tagIds: (tagsByRecording.get(row.id) ?? []).map((one) => one.id),
    })),
  );

  logger.info('flow.teachings.read', {
    actorId: actor.id,
    action: 'flow.read',
    target: 'recording:*',
    count: teachings.length,
  });

  return { teachings, tagQuestionCounts: Object.fromEntries(tagQuestions) };
}

// =================================================================================================
// Sessions
// =================================================================================================

/** The member's sessions: the one in progress, and the completed ones newest first ([3.14.10](docs/project/prd.md)). */
export async function listFlowSessionsFor(actor: Actor): Promise<FlowSessionsPayload> {
  const rows = await listFlowSessionsForMember(actor.id);
  const active = rows.find((row) => row.status === 'in_progress') ?? null;
  const completed = rows.filter((row) => row.status === 'complete');
  return {
    active: active === null ? null : await summarise(active),
    completed: await Promise.all(completed.map(summarise)),
  };
}

/**
 * **Start a session from the teaching the member fell behind at** ([3.14.2](docs/project/prd.md),
 * [3.14.3](docs/project/prd.md), [3.14.5](docs/project/prd.md)).
 *
 * The range is every published teaching from the most recent back to the divergence point, in the
 * library's order. The questions are assembled in the order they are asked: newest teaching first,
 * and within a teaching the last chapter first — then the bank questions of every tag the range
 * carries, each once, which are about several teachings and so come after all of them.
 *
 * Everything the session asks is **snapshotted** as it stands now ([3.14.10](docs/project/prd.md)):
 * the question's text, the chapter's title and start. What stays live is the chapter id.
 *
 * One session in progress at a time is the table's rule: the unique violation it raises is read
 * here as `flow_session_in_progress`.
 */
export async function startFlowSessionFor(actor: Actor, body: unknown): Promise<FlowSessionPayload> {
  const divergenceId = parseId(
    (body as { divergenceRecordingId?: unknown } | null)?.divergenceRecordingId,
    'divergenceRecordingId must be a recording id.',
  );

  const visible = await listVisibleRecordings({ includeUnpublished: false });
  const at = visible.findIndex((row) => row.id === divergenceId);
  if (at < 0) throw ApiError.notFound(NO_SUCH_TEACHING);
  const range = visible.slice(0, at + 1);
  const rangeIds = range.map((row) => row.id);

  const [sources, tagsByRecording] = await Promise.all([
    listQuestionsForRecordings(rangeIds),
    listTagsForRecordings(rangeIds),
  ]);

  const items: NewFlowSessionItem[] = [];
  for (const teaching of range) {
    const own = sources
      .filter((one) => one.recordingId === teaching.id)
      // Within a teaching, from its last chapter back to its first (3.14.5).
      .sort((a, b) => (b.chapterStartMs ?? 0) - (a.chapterStartMs ?? 0));
    for (const one of own) {
      items.push(
        one.scope === 'chapter'
          ? {
              kind: 'chapter',
              recordingId: teaching.id,
              chapterId: one.chapterId,
              tagId: null,
              question: one.text,
              title: one.chapterTitle ?? teaching.title,
              summary: one.chapterSummary,
              startMs: one.chapterStartMs,
            }
          : {
              kind: 'recording',
              recordingId: teaching.id,
              chapterId: null,
              tagId: null,
              question: one.text,
              title: teaching.title,
              summary: teaching.description,
              startMs: null,
            },
      );
    }
  }

  const tagIds = [...new Set([...tagsByRecording.values()].flat().map((one) => one.id))];
  for (const one of await listTagQuestionsForTags(tagIds)) {
    items.push({
      kind: 'tag',
      recordingId: null,
      chapterId: null,
      tagId: one.tagId,
      question: one.text,
      title: one.tagName,
      summary: null,
      startMs: null,
    });
  }

  let created;
  try {
    created = await insertFlowSession({
      userId: actor.id,
      divergenceRecordingId: divergenceId,
      teachingCount: range.length,
      items,
    });
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      throw ApiError.flowSessionInProgress(FLOW_SESSION_IN_PROGRESS_MESSAGE);
    }
    throw cause;
  }

  logger.info('flow.session.start', {
    actorId: actor.id,
    action: 'flow.start',
    target: `flow_session:${created.id}`,
    divergenceRecordingId: divergenceId,
    teachings: range.length,
    questions: items.length,
  });

  // A session with nothing to ask is complete the moment it starts: a range of teachings none of
  // which has questions yet. It is a reading list with nothing on it rather than a screen with no
  // next question.
  if (items.length === 0) await completeFlowSession(created.id, actor.id);

  return { session: await readSession(actor, created.id) };
}

/** One session of the caller's own, in full. */
export async function readFlowSessionFor(actor: Actor, sessionId: string): Promise<FlowSessionPayload> {
  const id = parseId(sessionId, 'That is not a session id.');
  return { session: await readSession(actor, id) };
}

/**
 * **Answer one question** ([3.14.6](docs/project/prd.md)). Only while the session is in progress;
 * a session that has completed or been abandoned is not asking. When the answer was the last one
 * missing, the session completes in the same request, so the answer that completes it is answered
 * with the reading list.
 */
export async function answerFlowItemFor(
  actor: Actor,
  sessionId: string,
  itemId: string,
  body: unknown,
): Promise<FlowSessionPayload> {
  const id = parseId(sessionId, 'That is not a session id.');
  const item = parseId(itemId, 'That is not a question id.');
  const answer = (body as { answer?: unknown } | null)?.answer;
  if (!isFlowAnswer(answer)) {
    throw ApiError.invalidInput('answer must be one of the five answers the scale offers.');
  }

  const session = await requireSession(actor, id);
  if (session.status !== 'in_progress') {
    throw ApiError.invalidInput('This session is no longer taking answers.');
  }
  if (!(await answerFlowSessionItem(id, item, answer))) {
    throw ApiError.notFound('There is no such question in this session.');
  }

  const remaining = await countUnansweredFlowItems(id);
  const completed = remaining === 0 && (await completeFlowSession(id, actor.id));

  logger.info('flow.session.answer', {
    actorId: actor.id,
    action: 'flow.answer',
    target: `flow_session:${id}`,
    // The item, never the answer: what a member said about their own week is theirs (3.14.8).
    item,
    remaining,
    completed,
  });

  return { session: await readSession(actor, id) };
}

/** The member gave the session up ([3.14.10](docs/project/prd.md)). Abandoning what is not in progress changes nothing. */
export async function abandonFlowSessionFor(actor: Actor, sessionId: string): Promise<FlowSessionPayload> {
  const id = parseId(sessionId, 'That is not a session id.');
  await requireSession(actor, id);
  const abandoned = await abandonFlowSession(id, actor.id);
  logger.info('flow.session.abandon', {
    actorId: actor.id,
    action: 'flow.abandon',
    target: `flow_session:${id}`,
    abandoned,
  });
  return { session: await readSession(actor, id) };
}

/** Tick a reading-list row off, or un-tick it ([3.14.9](docs/project/prd.md)). */
export async function markFlowItemFor(
  actor: Actor,
  sessionId: string,
  itemId: string,
  body: unknown,
): Promise<FlowSessionPayload> {
  const id = parseId(sessionId, 'That is not a session id.');
  const item = parseId(itemId, 'That is not a question id.');
  const done = (body as { done?: unknown } | null)?.done;
  if (typeof done !== 'boolean') throw ApiError.invalidInput('done must be true or false.');

  await requireSession(actor, id);
  if (!(await setFlowSessionItemDone(id, item, done))) {
    throw ApiError.notFound('There is no such question in this session.');
  }
  logger.info('flow.session.mark', {
    actorId: actor.id,
    action: 'flow.mark',
    target: `flow_session:${id}`,
    item,
    done,
  });
  return { session: await readSession(actor, id) };
}

// =================================================================================================
// Describing
// =================================================================================================

async function requireSession(actor: Actor, id: string): Promise<FlowSessionListRow> {
  const row = await findFlowSessionForMember(id, actor.id);
  if (row === null) throw ApiError.notFound(NO_SUCH_SESSION);
  return row;
}

async function readSession(actor: Actor, id: string): Promise<FlowSessionView> {
  const row = await requireSession(actor, id);
  const items = await Promise.all((await listFlowSessionItems(id)).map(describeItem));
  const summary = await summarise(row);
  return {
    ...summary,
    items,
    readingList: row.status === 'complete' ? await readingList(items) : null,
  };
}

async function summarise(row: FlowSessionListRow): Promise<FlowSessionSummary> {
  return {
    id: row.id,
    status: row.status,
    startedAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    divergence: {
      id: row.divergenceRecordingId,
      title: row.divergenceTitle,
      recordedAt: row.divergenceRecordedAt,
      series: await seriesRef(row.divergenceSeriesId, row.divergenceSeriesTitle, row.divergenceSeriesArtworkKey),
    },
    teachingCount: row.teachingCount,
    questionCount: row.questionCount,
    answeredCount: row.answeredCount,
    gapCount: row.gapCount,
  };
}

async function describeItem(row: FlowSessionItemRow): Promise<FlowSessionItemView> {
  return {
    id: row.id,
    position: row.position,
    kind: row.kind,
    question: row.question,
    recording:
      row.recordingId === null || row.recordingTitle === null || row.recordingRecordedAt === null
        ? null
        : {
            id: row.recordingId,
            title: row.recordingTitle,
            recordedAt: row.recordingRecordedAt,
            series: await seriesRef(row.seriesId, row.seriesTitle, row.seriesArtworkKey),
          },
    chapter:
      row.kind === 'chapter'
        ? { id: row.chapterId, title: row.title, summary: row.summary, startMs: row.startMs ?? 0 }
        : null,
    tag: row.kind === 'tag' && row.tagId !== null ? { id: row.tagId, name: row.tagName ?? row.title } : null,
    answer: row.answer,
    answeredAt: row.answeredAt?.toISOString() ?? null,
    done: row.doneAt !== null,
  };
}

/**
 * **The reading list** ([3.14.9](docs/project/prd.md), [3.14.6](docs/project/prd.md),
 * [3.14.7](docs/project/prd.md)): every item whose answer indicates a gap, grouped by teaching from
 * the oldest in range forward, and within a teaching from its first chapter on — the member reads
 * from where they lost the flow towards today. Beneath a chapter row, the related chapters of other
 * teachings, from the cross-reference layer; beneath a tag row, the teachings in range that carry
 * the tag.
 */
async function readingList(items: readonly FlowSessionItemView[]): Promise<FlowReadingGroup[]> {
  const gaps = items.filter((one) => one.answer !== null && isGapAnswer(one.answer));
  const byTeaching = new Map<string, { recording: FlowTeachingRef; rows: FlowReadingRow[] }>();
  const tagRows: FlowReadingRow[] = [];

  // The teachings the session covered, for a tag row's recommendations — read off the items, which
  // is the range as it was asked.
  const covered = new Map<string, FlowTeachingRef>();
  for (const one of items) if (one.recording !== null) covered.set(one.recording.id, one.recording);

  const spans = chapterSpans(items);

  // Oldest first: the items were asked newest first, so the reverse is the reading order.
  for (const item of [...gaps].reverse()) {
    if (item.kind === 'tag') {
      tagRows.push({ item, taggedTeachings: [], related: [] });
      continue;
    }
    if (item.recording === null) continue;
    const group = byTeaching.get(item.recording.id) ?? { recording: item.recording, rows: [] };
    byTeaching.set(item.recording.id, group);
    group.rows.push({ item, taggedTeachings: [], related: await relatedFor(item, spans.get(item.id)) });
  }

  const groups: FlowReadingGroup[] = [...byTeaching.values()];
  if (tagRows.length > 0) {
    const tagged = await listTagsForRecordings([...covered.keys()]);
    groups.push({
      recording: null,
      rows: tagRows.map((row) => ({
        ...row,
        taggedTeachings: [...covered.values()]
          .filter((teaching) => (tagged.get(teaching.id) ?? []).some((one) => one.id === row.item.tag?.id))
          // Oldest first, as every group reads.
          .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)),
      })),
    });
  }
  return groups;
}

interface Span {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * **Each chapter item's span, as it stood when asked**, keyed by item id. Derived from the items of
 * its teaching rather than from the chapters as they are now: a chapter ends where the next one
 * began, and the last one runs on — the open end is the largest integer, since a cross-reference's
 * source sentence is always inside the teaching. The same half-open arithmetic the chapter page
 * uses (project tdd 3.8), over the snapshot rather than the live list.
 */
function chapterSpans(items: readonly FlowSessionItemView[]): Map<string, Span> {
  const byTeaching = new Map<string, FlowSessionItemView[]>();
  for (const one of items) {
    if (one.kind !== 'chapter' || one.chapter === null || one.recording === null) continue;
    const list = byTeaching.get(one.recording.id) ?? [];
    byTeaching.set(one.recording.id, list);
    list.push(one);
  }
  const spans = new Map<string, Span>();
  for (const list of byTeaching.values()) {
    const ordered = [...list].sort((a, b) => (a.chapter?.startMs ?? 0) - (b.chapter?.startMs ?? 0));
    ordered.forEach((one, index) => {
      spans.set(one.id, {
        startMs: one.chapter?.startMs ?? 0,
        endMs: ordered[index + 1]?.chapter?.startMs ?? Number.MAX_SAFE_INTEGER,
      });
    });
  }
  return spans;
}

/**
 * The chapters of other teachings that speak to this one ([3.14.6](docs/project/prd.md),
 * [3.9.8](docs/project/prd.md)). Nothing for a whole-teaching item or a tag item.
 */
async function relatedFor(item: FlowSessionItemView, span: Span | undefined) {
  if (item.kind !== 'chapter' || item.chapter === null || item.recording === null) return [];
  if (span === undefined) return [];
  const rows = await listRelatedChapters(item.recording.id, span.startMs, span.endMs, MAX_RELATED_CHAPTERS);
  return Promise.all(
    rows.map(async (row) => ({
      recording: {
        id: row.recordingId,
        title: row.recordingTitle,
        recordedAt: row.recordedAt,
        series: await seriesRef(row.seriesId, row.seriesTitle, row.seriesArtworkKey),
      },
      chapter: { id: row.chapterId, title: row.chapterTitle, summary: null, startMs: row.chapterStartMs },
    })),
  );
}

// =================================================================================================
// Refs
// =================================================================================================

async function teachingRef(row: VisibleRecordingRow): Promise<FlowTeachingRef> {
  return {
    id: row.id,
    title: row.title,
    recordedAt: row.recordedAt,
    series: await seriesRef(row.seriesId, row.seriesTitle, row.seriesArtworkKey),
  };
}

async function seriesRef(
  id: string | null,
  title: string | null,
  artworkKey: string | null,
): Promise<FlowTeachingRef['series']> {
  if (id === null || title === null) return null;
  return { id, title, artworkUrl: await mintArtworkGrant(artworkKey) };
}

/** The id as a uuid, or the refusal — before it reaches a statement that would throw on it. */
function parseId(value: unknown, message: string): string {
  if (typeof value !== 'string') throw ApiError.invalidInput(message);
  const trimmed = value.trim();
  if (!UUID.test(trimmed)) throw ApiError.invalidInput(message);
  return trimmed.toLowerCase();
}
