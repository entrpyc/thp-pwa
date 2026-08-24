import { resolvePassages } from '@thp/bible';
import { checkCitation, formatCitation, type PassagePayload } from '@thp/shared';
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
