import { readBibleTranslation, resolvePassages } from '@thp/bible';
import { findScriptureReferences, findVisibleRecording } from '@thp/db';
import {
  checkCitation,
  compareCitations,
  formatCitation,
  type PassagePayload,
  type RecordingScripturePayload,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';

/**
 * **The passage behind a citation, while the review form is open**
 * ([3.3.4](docs/active-scope/prd.md)).
 *
 * One read, and it is what makes a wrong-but-plausible citation catchable: an admin who has just
 * typed `Romans 8:1–4` sees the words before they approve it, so a reference that reads right and
 * *is* wrong is caught by reading rather than by remembering.
 *
 * **It resolves through the same cache-aside path the draft step uses**, so the row a teaching's
 * draft already fetched is served from our own database rather than asked for again — and a
 * citation nobody has ever cited is fetched once and held for everybody afterwards.
 *
 * **A passage with no text is `null`, not a failure.** A source that is down is
 * [3.3.6](docs/active-scope/prd.md)'s worst case and degrades to a citation without text; answering
 * with an error would make the review form unusable over a convenience.
 *
 * **Nothing here writes verse text on anybody's say-so.** The only input is a citation, checked by
 * the same validator the worker and the approve path use — which is the half of
 * [3.3.8](docs/active-scope/prd.md) that is a fact about the API rather than about a screen.
 */
export async function readPassageFor(
  actor: Actor,
  query: URLSearchParams,
): Promise<PassagePayload> {
  const checked = checkCitation({
    book: query.get('book') ?? '',
    chapter: Number(query.get('chapter')),
    verseStart: numberOrNull(query.get('verseStart')),
    verseEnd: numberOrNull(query.get('verseEnd')),
  });
  if (!checked.ok) throw ApiError.invalidInput(checked.problem.message);

  const resolved = await resolvePassages([checked.citation]);
  const verses = resolved.passages[0]?.verses ?? [];

  logger.info('scripture.passage', {
    actorId: actor.id,
    action: 'review.list',
    target: `passage:${formatCitation(checked.citation)}`,
    verses: verses.length,
    fetched: resolved.fetched,
    held: resolved.held,
  });

  // Joined into one paragraph, with no verse numbers in it — [§ 5.1](docs/active-scope/prd.md) says
  // the passage is plain text, and a number the reader did not ask for is markup by another name.
  return { passage: verses.length === 0 ? null : verses.map((one) => one.text).join(' ') };
}

/** A blank verse reads as the whole chapter, which is what a blank can honestly mean here. */
function numberOrNull(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  return Number(value);
}

/**
 * **A published teaching's scripture, as a member reads it** ([3.4.2](docs/active-scope/prd.md)–
 * [3.4.5](docs/active-scope/prd.md)).
 *
 * **One gate, and it is the recording's.** References ride publication
 * ([3.2.13](docs/active-scope/prd.md)), so the only question asked here is the one
 * `findVisibleRecording` already answers for the teaching itself — the same read the recording page
 * and the transcript go through, reached through the same `recording.browse` the route declares.
 * There is no second publication state on a reference and nothing here compares one.
 *
 * **An empty list is the ordinary answer.** A teaching whose draft nobody has approved has no rows,
 * and a discarded draft leaves its citations in the closed `review_item` and writes none — so both
 * read as no references without this function knowing which happened. That is the point: the only
 * thing that puts a row in front of a member is an approval.
 *
 * **Canon order is applied here rather than in the query**, because the order is the position of a
 * book in the canon table and that table is declared once, in `@thp/shared`.
 *
 * **A Bible source that is down degrades to citations without text** (§ 6 Operability). The port
 * promises never to throw, so a page load cannot fail over a passage — the reference arrives with
 * `passage: null` and the panel says so.
 */
export async function readScriptureFor(
  actor: Actor,
  recordingId: string,
): Promise<RecordingScripturePayload> {
  const visible = await findVisibleRecording(recordingId, { includeUnpublished: false });
  if (visible === null) {
    logger.warn('scripture.read.refused', {
      actorId: actor.id,
      action: 'recording.browse',
      target: `recording:${recordingId}`,
      reason: 'not-visible',
      code: 'not_found',
    });
    throw ApiError.notFound('There is no such teaching.');
  }

  const citations = (await findScriptureReferences(recordingId))
    .map((row) => ({
      book: row.book,
      chapter: row.chapter,
      verseStart: row.verseStart,
      verseEnd: row.verseEnd,
    }))
    .sort(compareCitations);

  const resolved = await resolvePassages(citations);

  logger.info('scripture.read', {
    actorId: actor.id,
    action: 'recording.browse',
    target: `recording:${recordingId}`,
    references: citations.length,
    fetched: resolved.fetched,
    held: resolved.held,
  });

  return {
    references: resolved.passages.map((one) => ({
      ...one.citation,
      passage: one.verses.length === 0 ? null : one.verses.map((verse) => verse.text).join(' '),
    })),
    // Which translation the words are ([3.7.9](docs/project/prd.md#L164)). Read from the same
    // configuration the cache keys itself by, so the name on screen and the rows behind it can
    // never disagree about what was fetched.
    translation: readBibleTranslation(),
  };
}
