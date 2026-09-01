'use client';

import { useEffect, useState } from 'react';
import {
  formatCitation,
  recordingScripturePath,
  scopedToChapter,
  type RecordingScripturePayload,
  type ScriptureReadingView,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from './scripture.module.css';

/**
 * **The `Scripture` tab of `pages/recording.png`** — the passages a teaching was built on.
 *
 * The reference draws the tab and **nothing draws the panel**
 * (scope prd), so this is `style-guide.md` filling it the way the
 * transcript and notes panels already do: one card per reference, the citation as its heading and
 * the verse text as its body.
 *
 * Four things it deliberately does not decide:
 *
 * - **Which references exist.** The payload is what an admin approved on a published teaching
 *   (scope prd 3.4.5); nothing here filters and nothing here could widen it.
 * - **What order they are in.** Canon order is the API's answer
 *   (scope prd 3.4.2), computed from the one canon table — a second sort here
 *   would be a second opinion about the same question.
 * - **How a citation is spelled.** `formatCitation` is the review form's function too, so the two
 *   surfaces cannot drift.
 * - **Whether there is a tab at all.** That is the strip's decision, taken off the recording
 *   payload before this component is ever mounted (scope prd 3.4.4).
 *
 * **Fetched on mount**, which is the strip's "fetched when first opened"
 * (scope prd 3.4.6) — the panel exists only while the tab is open, so opening it
 * is what asks. **A failure stays inside it** (scope prd 3.4.7): the player, the
 * notes and the transcript are unaffected by anything that happens here.
 *
 * **Nothing in it navigates** (scope prd 3.4.8). A citation is text, because the
 * destination `project prd 3.7.6` would give it is the cross-referencing layer and that layer does
 * not exist — a link to nowhere is worse than no link.
 *
 * **It is now on two screens.** The now-playing view of `pages/player.png` mounts this same panel
 * for the teaching that is playing (scope prd 3.3.3; scope tdd 1.7), which is what stops that view
 * from being a second reading of the same passages under different rules. Nothing about the panel
 * changed to allow it: it already took a recording id and already read the one route, and the
 * empty case it already states is what scope prd 3.3.6 asks that view for.
 */
export function ScripturePanel({
  recordingId,
  chapterId = null,
}: {
  recordingId: string;
  /**
   * **The chapter this panel is scoped to**, or `null` for the whole teaching
   * ([3.22.14](docs/project/prd.md)).
   *
   * A chapter *id* rather than a span, because the span is the server's to compute from the same
   * list the client holds (project tdd 5.9) — so neither side sends the other a boundary, and a
   * panel cannot ask for a stretch of teaching that is not a chapter.
   */
  chapterId?: string | null;
}) {
  const [references, setReferences] = useState<readonly ScriptureReadingView[] | null>(null);
  const [translation, setTranslation] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;

    const path = recordingScripturePath(recordingId);
    void apiFetch<RecordingScripturePayload>(
      chapterId === null ? path : scopedToChapter(path, chapterId),
      { credentials: 'include' },
    )
      .then((payload) => {
        if (!live) return;
        setReferences(payload.references);
        setTranslation(payload.translation);
        setFailure(null);
      })
      .catch((caught: unknown) => {
        if (!live) return;
        setReferences(null);
        setFailure(
          caught instanceof ApiClientError
            ? caught.message
            : 'Could not load this teaching’s scripture. Check your connection and try again.',
        );
      });

    return () => {
      live = false;
    };
  }, [chapterId, recordingId]);

  return (
    <section className={styles.panel} aria-label="Scripture">
      {failure !== null ? (
        <p className={styles.failure}>{failure}</p>
      ) : references === null ? (
        <p className={styles.quiet}>Loading the scripture…</p>
      ) : references.length === 0 ? (
        <p className={styles.quiet}>
          {chapterId === null
            ? // Reachable only if the list emptied between the page load that drew the tab and this
              // fetch — an admin approving an empty list in the meantime. It says so rather than
              // showing an empty box.
              'This teaching has no scripture references.'
            : /*
               * A chapter with no citations anchored inside it, which is **ordinary** rather than
               * exceptional ([3.22.14](docs/project/prd.md), [3.7.10](docs/project/prd.md)): a
               * reference the transcript gave no position for belongs to the recording rather than
               * to any chapter, so it is read on the teaching's own tab — and this says where.
               */
              'No scripture is cited in this chapter. The teaching’s own page lists every passage it was built on.'}
        </p>
      ) : (
        <>
          {/*
            **Which translation these words are** (`project prd` 3.7.9). The product holds one and
            offers no choice between translations, so the only thing a member can be told is which
            one they are reading — said once above the list rather than on every card, because it is
            true of all of them.
          */}
          <p className={styles.translation}>{translation}</p>
          <ol className={styles.references}>
            {references.map((reference) => (
              <li className={styles.reference} key={formatCitation(reference)}>
                <h3 className={styles.citation}>{formatCitation(reference)}</h3>
                {reference.passage === null ? (
                  <p className={styles.quiet}>The passage could not be loaded.</p>
                ) : (
                  <p className={styles.passage}>{reference.passage}</p>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
