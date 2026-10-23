import { RECORDINGS_PATH, type RecordingSeriesRef } from './recordings';

/**
 * **Cross-referencing's vocabulary** ([3.9](docs/project/prd.md)) — what a link *is*, how many a
 * chapter may carry, how the strongest are chosen, and the shape the recording page reads them in.
 * Stated once here because three processes agree on it: the worker that writes links, the API
 * that reads them back under the same cap, and the page that draws them.
 *
 * **One basis today.** project tdd 3.3 names three — embedding similarity, a shared tag and a
 * shared scripture citation — and the product decision for this round was to build the first
 * alone: links are drawn from the transcript ([3.9.1](docs/project/prd.md)) and from nothing
 * else, so a member is never shown a link whose reason is "both were tagged *grace*". The enum
 * exists with one member rather than being left out so that a second basis is a value added to
 * this list and a `ALTER TYPE … ADD VALUE`, not a column added to every row.
 */
export const CROSS_REFERENCE_BASES = ['semantic'] as const;

export type CrossReferenceBasis = (typeof CROSS_REFERENCE_BASES)[number];

export function isCrossReferenceBasis(value: unknown): value is CrossReferenceBasis {
  return (
    typeof value === 'string' && (CROSS_REFERENCE_BASES as readonly string[]).includes(value)
  );
}

/**
 * **How many links a chapter carries: three.**
 *
 * The product decision, taken over "ten per teaching" and "everything above a threshold": a
 * member listening to one part of a teaching is offered at most three other moments, each in a
 * different teaching, and nothing while the part they are in has none. Three is the number that
 * fits under a tab strip without becoming a list to scroll, and per *chapter* rather than per
 * teaching because the chapter is the unit a member is listening to
 * ([3.22](docs/project/prd.md)) — a ninety-minute teaching with one theme per chapter should not
 * spend its whole allowance on the first.
 *
 * It is applied **twice**, deliberately: by the worker when it decides what to write for a
 * teaching's own chapters, and again by the read, because a teaching also *receives* links other
 * teachings' runs found ([3.9.6](docs/project/prd.md)) and a chapter can therefore hold more rows
 * than it may show. One constant and one function ({@link pickStrongest}) are what keep the two
 * applications the same rule.
 */
export const CROSS_REFERENCES_PER_CHAPTER = 3;

/** What the selection needs to know about a candidate link. The rest of the row rides along. */
export interface RankedCandidate {
  /** Cosine similarity, 0..1. The whole of the ranking. */
  readonly score: number;
  /** The sentence of *this* teaching the link is anchored to. */
  readonly sourceSegmentId: string;
  /** Where that sentence starts, which breaks a tie in favour of the earlier moment. */
  readonly sourceStartMs: number;
  /** The teaching the link points at. */
  readonly targetRecordingId: string;
}

/**
 * **The strongest `limit` links of one chapter**, by one rule:
 *
 * 1. Highest score first; between equal scores, the earlier sentence.
 * 2. A link is taken only if its other teaching has not already been taken for this chapter —
 *    three links to three moments of one other teaching are a weaker offer than one each to
 *    three teachings, and the strongest of them is still there.
 * 3. A link is taken only if its own sentence has not already been taken — one sentence is one
 *    moment, and two links anchored to it would open as one row with two destinations.
 * 4. Stop at `limit`.
 *
 * Pure, and the same function on both sides of the wire, so what the worker writes and what the
 * API shows cannot disagree about which three a chapter has.
 */
export function pickStrongest<T extends RankedCandidate>(
  candidates: readonly T[],
  limit: number = CROSS_REFERENCES_PER_CHAPTER,
): T[] {
  const ordered = [...candidates].sort(
    (a, b) => b.score - a.score || a.sourceStartMs - b.sourceStartMs,
  );
  const chosen: T[] = [];
  const recordingsTaken = new Set<string>();
  const sentencesTaken = new Set<string>();
  for (const candidate of ordered) {
    if (chosen.length >= limit) break;
    if (recordingsTaken.has(candidate.targetRecordingId)) continue;
    if (sentencesTaken.has(candidate.sourceSegmentId)) continue;
    chosen.push(candidate);
    recordingsTaken.add(candidate.targetRecordingId);
    sentencesTaken.add(candidate.sourceSegmentId);
  }
  return chosen;
}

/**
 * **Which chapter a moment of a teaching belongs to**, by the arithmetic project tdd 3.8 makes
 * the rule everywhere: the chapter whose start is the latest one at or before the moment.
 *
 * Its own helper beside `chapterAt` rather than that function, for two reasons. The worker reads
 * chapters off the database, where a chapter has no `endMs` (project tdd 3.7) — so the shape here
 * is only an id and a start. And the question is bucketing rather than "what is playing": every
 * sentence of a transcript has to land in exactly one bucket for the cap to mean anything, so a
 * sentence spoken before the first chapter's start — a transcript that opens on a moment the
 * chapter list does not — is bucketed with the first chapter rather than left in none.
 *
 * `null` only for a teaching with no chapters at all, which is then one bucket: the whole
 * teaching carries one chapter's worth of links.
 */
export function chapterIdAt(
  chapters: readonly { readonly id: string; readonly startMs: number }[],
  offsetMs: number,
): string | null {
  if (chapters.length === 0) return null;
  const ordered = [...chapters].sort((a, b) => a.startMs - b.startMs);
  let found = ordered[0] as { readonly id: string; readonly startMs: number };
  for (const chapter of ordered) {
    if (chapter.startMs <= offsetMs) found = chapter;
    else break;
  }
  return found.id;
}

// =================================================================================================
// The wire contract
// =================================================================================================

/** A teaching's related moments, under the API prefix ([3.9.2](docs/project/prd.md)). */
export function recordingCrossReferencesPath(recordingId: string): string {
  return `${RECORDINGS_PATH}/${recordingId}/cross-references`;
}

/**
 * **One related moment in another teaching** ([3.9.5](docs/project/prd.md)) — what the page
 * needs to name it and to open it there: the teaching, its series, and the moment.
 *
 * `text` is the sentence that matched, so the row can say *what* is related rather than only
 * that something is; it is the transcript's words and nothing generated.
 */
export interface RelatedSegmentView {
  readonly recordingId: string;
  readonly title: string;
  readonly series: RecordingSeriesRef | null;
  readonly segmentId: string;
  /** Where to open the other teaching, in milliseconds from its start. */
  readonly startMs: number;
  readonly text: string;
  /** Cosine similarity, 0..1. Shown to nobody; the order the links come in. */
  readonly score: number;
  readonly basis: CrossReferenceBasis;
}

/**
 * **The links one sentence of this teaching triggered** ([3.9.2](docs/project/prd.md)), with the
 * chapter that sentence falls in so the page can show a group while that chapter is playing and
 * not otherwise. `chapterId` is `null` for a teaching with no chapters, whose one group of groups
 * shows throughout.
 */
export interface CrossReferenceGroupView {
  readonly segmentId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly chapterId: string | null;
  /** Strongest first. Never more than {@link CROSS_REFERENCES_PER_CHAPTER} across a chapter's groups. */
  readonly links: readonly RelatedSegmentView[];
}

/** Payload of `GET /api/v1/recordings/{id}/cross-references`. Groups in the order they are spoken. */
export interface RecordingCrossReferencesPayload {
  readonly groups: readonly CrossReferenceGroupView[];
}
