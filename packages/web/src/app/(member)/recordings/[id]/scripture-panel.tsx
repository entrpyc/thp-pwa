'use client';

import { useEffect, useState } from 'react';
import {
  formatCitation,
  recordingScripturePath,
  type RecordingScripturePayload,
  type ScriptureReadingView,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from './scripture.module.css';

/**
 * **The `Scripture` tab of `pages/recording.png`** — the passages a teaching was built on.
 *
 * The reference draws the tab and **nothing draws the panel**
 * ([§ 5.1](docs/active-scope/prd.md)), so this is `style-guide.md` filling it the way the
 * transcript and notes panels already do: one card per reference, the citation as its heading and
 * the verse text as its body.
 *
 * Four things it deliberately does not decide:
 *
 * - **Which references exist.** The payload is what an admin approved on a published teaching
 *   ([3.4.5](docs/active-scope/prd.md)); nothing here filters and nothing here could widen it.
 * - **What order they are in.** Canon order is the API's answer
 *   ([3.4.2](docs/active-scope/prd.md)), computed from the one canon table — a second sort here
 *   would be a second opinion about the same question.
 * - **How a citation is spelled.** `formatCitation` is the review form's function too, so the two
 *   surfaces cannot drift.
 * - **Whether there is a tab at all.** That is the strip's decision, taken off the recording
 *   payload before this component is ever mounted ([3.4.4](docs/active-scope/prd.md)).
 *
 * **Fetched on mount**, which is the strip's "fetched when first opened"
 * ([3.4.6](docs/active-scope/prd.md)) — the panel exists only while the tab is open, so opening it
 * is what asks. **A failure stays inside it** ([3.4.7](docs/active-scope/prd.md)): the player, the
 * notes and the transcript are unaffected by anything that happens here.
 *
 * **Nothing in it navigates** ([3.4.8](docs/active-scope/prd.md)). A citation is text, because the
 * destination `project prd 3.7.6` would give it is the cross-referencing layer and that layer does
 * not exist — a link to nowhere is worse than no link.
 */
export function ScripturePanel({ recordingId }: { recordingId: string }) {
  const [references, setReferences] = useState<readonly ScriptureReadingView[] | null>(null);
  const [translation, setTranslation] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;

    void apiFetch<RecordingScripturePayload>(recordingScripturePath(recordingId), {
      credentials: 'include',
    })
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
  }, [recordingId]);

  return (
    <section className={styles.panel} aria-label="Scripture">
      {failure !== null ? (
        <p className={styles.failure}>{failure}</p>
      ) : references === null ? (
        <p className={styles.quiet}>Loading the scripture…</p>
      ) : references.length === 0 ? (
        // Reachable only if the list emptied between the page load that drew the tab and this
        // fetch — an admin approving an empty list in the meantime. It says so rather than
        // showing an empty box.
        <p className={styles.quiet}>This teaching has no scripture references.</p>
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
