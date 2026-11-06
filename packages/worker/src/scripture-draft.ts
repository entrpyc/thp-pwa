import {
  checkAnchorMs,
  checkCitation,
  citationKey,
  compareCitations,
  type DraftedCitation,
  type ProposedCitation,
} from '@thp/shared';
import type { TranscriptLine } from './generate/generator';

/**
 * **What the machine proposed, turned into what an admin reviews** (Task 1.3).
 *
 * The one step between a model's answer and a draft an admin opens, and it does three things: it
 * drops what cannot be a citation, it drops what the transcript does not bear out, and it collapses
 * what is the same citation twice.
 *
 * The first and the last are scope prd 3.1.3–scope prd 3.1.5, and exist for the same reason — *the
 * admin reviews what the machine got right*. A review spent deleting `Hezekiah 3:2` and the same
 * verse listed twice is a review nobody finishes, and neither of those is a judgement a person is
 * needed for.
 *
 * The middle one is the fix for a draft full of passages the speaker never mentioned. A passage is a
 * citation of *this teaching* only when the speaker named it or quoted it, and the model is asked to
 * prove that by pointing at the line (`anchorMs`) and copying the words (`evidence`). Here the proof
 * is checked: the anchor has to be the offset of a real line, and the evidence has to be in the
 * transcript at or just after that line. A proposal that fails either is a passage the model
 * associated with the topic rather than heard, and it is dropped — which also means every citation
 * that reaches an admin is placed, so the chapter's scripture tab
 * ([3.22.14](docs/project/prd.md)) has something to show.
 *
 * **Dropping is counted, never silent.** How many went is recorded against the job that produced
 * them, so a prompt that starts hallucinating books or passages is visible on the pipeline panel as
 * a number climbing rather than as drafts quietly getting shorter.
 *
 * It lives in the worker rather than behind the generation port because it is not a question about
 * the provider: the same resolution would be needed whatever answered.
 */

export interface ScriptureDraft {
  /** What survived, in canon order, with no passage listed twice. */
  readonly citations: readonly DraftedCitation[];
  /** How many proposals were not citations of anything, for the job's record. */
  readonly dropped: number;
  /**
   * How many were real citations the transcript did not bear out: no anchor, an anchor that is not
   * a line, or evidence that is not in the transcript there. Counted apart from `dropped` because
   * it names a different failure of the prompt — not "invented a book" but "invented a mention".
   */
  readonly unsupported: number;
  /** How many survivors were repeats of a passage already in the list. */
  readonly duplicates: number;
}

/**
 * How many lines after the anchored one the evidence may run into.
 *
 * A reference spoken across a line break — "turn with me to Romans" / "chapter eight" — is one
 * mention, and ASR cuts lines where the speaker breathed rather than where the sentence ended.
 * Two lines of slack covers that; the whole transcript would not, because then an anchor and its
 * evidence could point at two different places and the anchor would prove nothing.
 */
const EVIDENCE_WINDOW_LINES = 2;

/** Evidence shorter than this is a number or a word, not a mention, and proves nothing. */
const MIN_EVIDENCE_LENGTH = 3;

/**
 * Text as it is compared: lower-cased, with punctuation gone and whitespace collapsed.
 *
 * The model copies what it was shown, but it tidies as it copies — a comma dropped, a curly quote
 * straightened — and the check is about whether the words were said, not whether the punctuation
 * matched.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The transcript, indexed for the question the resolver asks of it: is this offset a line, and
 * what is said from there on?
 */
export interface TranscriptIndex {
  /** The normalised text of the line at this offset and the few after it, or null for no line. */
  readonly windowAt: (anchorMs: number) => string | null;
}

/** Build the index once per transcript, however many proposals are checked against it. */
export function indexTranscript(lines: readonly TranscriptLine[]): TranscriptIndex {
  const normalised = lines.map((line) => normalise(line.text));
  const at = new Map<number, number>();
  lines.forEach((line, index) => {
    if (!at.has(line.startMs)) at.set(line.startMs, index);
  });
  return {
    windowAt(anchorMs) {
      const index = at.get(anchorMs);
      if (index === undefined) return null;
      return normalised.slice(index, index + EVIDENCE_WINDOW_LINES + 1).join(' ');
    },
  };
}

/** Whether the transcript bears a proposal out: the anchor is a line, and the evidence is said there. */
function isSupported(one: ProposedCitation, transcript: TranscriptIndex): boolean {
  const anchor = checkAnchorMs(one.anchorMs);
  if (anchor === null) return false;
  const window = transcript.windowAt(anchor);
  if (window === null) return false;
  const evidence = normalise(one.evidence ?? '');
  if (evidence.length < MIN_EVIDENCE_LENGTH) return false;
  return window.includes(evidence);
}

/**
 * Resolve a model's proposals into the draft an admin will see.
 *
 * Canon order rather than the order the model happened to propose them
 * (scope prd 3.4.2) — the list is read top to bottom by a person who knows what
 * order the books come in, and the machine's order carries no information.
 *
 * `transcript` is what the model was shown. The handler always passes it; without one there is
 * nothing to check an anchor against, so the support check is skipped and a proposal stands on the
 * canon check alone — the question a caller with no transcript is asking.
 */
export function resolveProposedCitations(
  proposed: readonly ProposedCitation[],
  transcript?: TranscriptIndex,
): ScriptureDraft {
  const found = new Map<string, DraftedCitation>();
  let dropped = 0;
  let unsupported = 0;
  let duplicates = 0;

  for (const one of proposed) {
    const checked = checkCitation(one);
    if (!checked.ok) {
      dropped += 1;
      continue;
    }
    if (transcript !== undefined && !isSupported(one, transcript)) {
      unsupported += 1;
      continue;
    }
    const key = citationKey(checked.citation);
    if (found.has(key)) {
      /*
       * **The first anchor wins, and the repeat is still a repeat.**
       *
       * A model that proposed the same passage at two moments has proposed one reference
       * (scope prd 3.2.5 — a teaching cites a passage once), and the honest anchor for it is the
       * first place it came up rather than the last. Counting it as a duplicate is unchanged: the
       * number means "how much of the answer was not usable", and a second copy is not usable
       * however it is anchored.
       */
      duplicates += 1;
      continue;
    }
    found.set(key, { ...checked.citation, anchorMs: checkAnchorMs(one.anchorMs) });
  }

  return {
    citations: [...found.values()].sort(compareCitations),
    dropped,
    unsupported,
    duplicates,
  };
}

/**
 * Read what the port handed over without trusting its contents.
 *
 * The adapter proved the answer was a *list of objects*; whether each object has a book and a
 * chapter in it is this side's question, and an entry that does not is a proposal that cannot be
 * checked — so it is dropped and counted with the rest.
 */
export function readProposedCitations(value: unknown): ProposedCitation[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const one = (entry ?? {}) as Record<string, unknown>;
    return {
      book: typeof one['book'] === 'string' ? one['book'] : '',
      chapter: typeof one['chapter'] === 'number' ? one['chapter'] : Number.NaN,
      verseStart: typeof one['verseStart'] === 'number' ? one['verseStart'] : null,
      verseEnd: typeof one['verseEnd'] === 'number' ? one['verseEnd'] : null,
      // Read as it came and checked by `checkAnchorMs` above, so "the model wrote nothing" and
      // "the model wrote something that is not an offset" reach one decision rather than two.
      anchorMs: typeof one['anchorMs'] === 'number' ? one['anchorMs'] : null,
      evidence: typeof one['evidence'] === 'string' ? one['evidence'] : null,
    };
  });
}
