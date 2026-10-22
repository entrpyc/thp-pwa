'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  TERMS_ACCEPTANCE_PATH,
  TERMS_PAGE_PATH,
  TERMS_REQUIRED_MESSAGE,
  TERMS_VERSION,
  type TermsAcceptancePayload,
  type TermsAcceptanceRequest,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { POSTING_RULES } from '@/app/(public)/terms/posting-rules';
import styles from './notes.module.css';

/**
 * **The terms prompt** — what a composer shows when the API refused a note with `terms_required`
 * (Google Play's UGC policy: a member accepts the terms before they post).
 *
 * **Refusal-driven, not pre-emptive.** The client is never told whether the account has accepted
 * the terms; it learns by trying to post. That keeps the decision where every other note rule is —
 * on the server, applied again on every write — and means a member who accepted on their phone
 * is not asked again on their laptop by a screen holding a stale flag. The price is one refused
 * request per member per terms change, and the text they wrote stays in the box above this prompt
 * while they read.
 *
 * **The posting rules are the terms page's own list**, imported rather than restated
 * (`posting-rules.ts` says why): a member accepts here exactly the sentences `/terms` publishes.
 * The link opens the full page; the prompt is the summary a person can read in the moment.
 *
 * **Accepting sends the version the prompt was built with.** `TERMS_VERSION` is compiled into the
 * client, so a tab left open across a deploy that changed the terms sends the old date and is
 * refused with a sentence that says to reload — rather than recording acceptance of words it
 * never showed. On success `onAccepted` fires, and the composer saves again by itself: the member
 * pressed Save once and meant it.
 */
export function TermsPrompt({
  onAccepted,
  onDismiss,
}: {
  onAccepted: () => void;
  onDismiss: () => void;
}) {
  const [accepting, setAccepting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  function accept(): void {
    if (accepting) return;
    setAccepting(true);
    setFailure(null);
    const request: TermsAcceptanceRequest = { termsVersion: TERMS_VERSION };
    void apiFetch<TermsAcceptancePayload>(TERMS_ACCEPTANCE_PATH, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
      .then(() => onAccepted())
      .catch((caught: unknown) => {
        setFailure(
          caught instanceof ApiClientError
            ? caught.message
            : 'Could not record that. Check your connection and try again.',
        );
      })
      .finally(() => setAccepting(false));
  }

  return (
    <div className={styles.termsPrompt} role="group" aria-label="Accept the terms of use">
      <p className={styles.moderationTitle} role="status">
        {TERMS_REQUIRED_MESSAGE}
      </p>
      <ul className={styles.termsRules} aria-label="Posting rules">
        {POSTING_RULES.map((rule) => (
          <li key={rule}>{rule}</li>
        ))}
      </ul>
      <p className={styles.visibilityHint}>
        The full <Link href={TERMS_PAGE_PATH}>terms of use</Link> (dated {TERMS_VERSION}) say more.
      </p>
      {failure === null ? null : (
        <p className={styles.cardFailure} role="alert">
          {failure}
        </p>
      )}
      <div className={styles.composerActions}>
        <button className={styles.primary} type="button" disabled={accepting} onClick={accept}>
          {accepting ? 'Recording…' : 'I accept the terms'}
        </button>
        <button className={styles.secondary} type="button" onClick={onDismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}

/** Whether a refused write was the terms gate — the one refusal the composers answer with a prompt. */
export function isTermsRequired(caught: unknown): boolean {
  return caught instanceof ApiClientError && caught.code === 'terms_required';
}
