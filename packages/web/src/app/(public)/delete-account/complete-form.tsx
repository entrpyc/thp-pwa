'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import {
  ACCOUNT_DELETED_PAGE_PATH,
  ACCOUNT_DELETION_COMPLETE_PATH,
  type AccountDeletedPayload,
  type CompleteAccountDeletionRequest,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { resetAnalytics } from '@/client/observability/analytics';
import { DELETION_CONFIRMATION_WORD, isDeletionConfirmed } from './confirmation';
import styles from './delete-account.module.css';
import { WhatDeletionDoes } from './what-deletion-does';

/**
 * Finishing from the mailed link: the token names the account, the password proves the person
 * ([3.1.8](docs/project/prd.md)).
 *
 * The same form as the settings card, on the public surface, because it is the same act: the
 * explanation, the current password, the typed word, one button. The address is a real read-only
 * input rather than a line of text so a password manager has a username to match the password
 * field against — the person reached this page from an inbox, and may well not remember which
 * password this account had.
 *
 * **Refusals leave the link alive**, and the screen says so by keeping the form: a wrong password
 * and the last-admin case each arrive in the API's words, the fields keep what was typed, and the
 * same link works again inside the hour once the person has fixed what refused. A dead token
 * cannot reach this form at all — the page resolves it on the server first.
 *
 * Success lands on `/account-deleted`, as the signed-in door does. No cookie to clear: this browser
 * had no session for the account, or had one that died with the row.
 */

const UNREACHABLE = 'Could not reach the server. Nothing has changed — check your connection and try again.';

export function CompleteDeletionForm({ email, token }: { email: string; token: string }) {
  const router = useRouter();
  const emailId = useId();
  const passwordId = useId();
  const confirmationId = useId();
  const hintId = useId();
  const errorId = useId();

  const [password, setPassword] = useState('');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const ready = password !== '' && isDeletionConfirmed(typed);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting || !ready) return;
    setSubmitting(true);
    setError(null);

    try {
      const body: CompleteAccountDeletionRequest = { token, password };
      await apiFetch<AccountDeletedPayload>(ACCOUNT_DELETION_COMPLETE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      resetAnalytics();
      router.replace(ACCOUNT_DELETED_PAGE_PATH);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : UNREACHABLE);
      setSubmitting(false);
    }
  }

  return (
    <div className={`${styles.card} ${error === null ? '' : styles.cardErrored}`}>
      <div>
        <h1 className={styles.title}>Delete this account</h1>
        <p className={styles.subtitle}>
          You opened a deletion link for the account below. Confirm with its password to finish.
        </p>
      </div>

      <WhatDeletionDoes />

      {/*
        `POST`, for the reason `sign-in-form.tsx` sets out: a password typed on a page whose URL
        carries the token that authorises using it.
      */}
      <form className={styles.form} method="post" onSubmit={onSubmit} noValidate>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={emailId}>
            Email
          </label>
          <input
            className={styles.readonlyValue}
            id={emailId}
            name="email"
            type="email"
            autoComplete="username"
            readOnly
            value={email}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={passwordId}>
            Current password
          </label>
          <input
            className={styles.input}
            id={passwordId}
            name="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            {...(error === null ? {} : { 'aria-describedby': errorId })}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={confirmationId}>
            Type {DELETION_CONFIRMATION_WORD} to confirm
          </label>
          <input
            className={styles.input}
            id={confirmationId}
            name="confirmation"
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            aria-describedby={hintId}
          />
          <p className={styles.rule} id={hintId}>
            The button unlocks when the word matches.
          </p>
        </div>

        {error === null ? null : (
          <p className={styles.error} id={errorId} role="alert">
            {error}
          </p>
        )}

        <button className={styles.submit} type="submit" disabled={!ready || submitting}>
          {submitting ? 'Deleting…' : 'Yes, delete my account'}
        </button>
      </form>
    </div>
  );
}
