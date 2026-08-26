import {
  checkCitation,
  citationKey,
  compareCitations,
  type ProposedCitation,
  type ScriptureCitation,
} from '@thp/shared';

/**
 * **What the machine proposed, turned into what an admin reviews** (Task 1.3).
 *
 * The one step between a model's answer and a draft an admin opens, and it does exactly two
 * things: it drops what cannot be a citation, and it collapses what is the same citation twice.
 *
 * Both are scope prd 3.1.3–scope prd 3.1.5, and both exist for
 * the same reason — *the admin reviews what the machine got right*. A review spent deleting
 * `Hezekiah 3:2` and the same verse listed twice is a review nobody finishes, and neither of those
 * is a judgement a person is needed for.
 *
 * **Dropping is counted, never silent.** How many went is recorded against the job that produced
 * them, so a prompt that starts hallucinating books is visible on the pipeline panel as a number
 * climbing rather than as drafts quietly getting shorter.
 *
 * It lives in the worker rather than behind the generation port because it is not a question about
 * the provider: the same resolution would be needed whatever answered.
 */

export interface ScriptureDraft {
  /** What survived, in canon order, with no passage listed twice. */
  readonly citations: readonly ScriptureCitation[];
  /** How many proposals were not citations of anything, for the job's record. */
  readonly dropped: number;
  /** How many survivors were repeats of a passage already in the list. */
  readonly duplicates: number;
}

/**
 * Resolve a model's proposals into the draft an admin will see.
 *
 * Canon order rather than the order the model happened to propose them
 * (scope prd 3.4.2) — the list is read top to bottom by a person who knows what
 * order the books come in, and the machine's order carries no information.
 */
export function resolveProposedCitations(
  proposed: readonly ProposedCitation[],
): ScriptureDraft {
  const found = new Map<string, ScriptureCitation>();
  let dropped = 0;
  let duplicates = 0;

  for (const one of proposed) {
    const checked = checkCitation(one);
    if (!checked.ok) {
      dropped += 1;
      continue;
    }
    const key = citationKey(checked.citation);
    if (found.has(key)) {
      duplicates += 1;
      continue;
    }
    found.set(key, checked.citation);
  }

  return {
    citations: [...found.values()].sort(compareCitations),
    dropped,
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
    };
  });
}
