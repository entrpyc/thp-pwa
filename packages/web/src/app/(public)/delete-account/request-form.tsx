'use client';

import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import { ACCOUNT_DELETION_PATH, type RequestAccountDeletionRequest } from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from './delete-account.module.css';
import { WhatDeletionDoes } from './what-deletion-does';

/**
 * Asking for a deletion link — the public half Google Play shows on the store listing, for a
 * person who no longer has the app ([3.1.8](docs/project/prd.md)).
 *
 * The forgot-password form's two rules, carried across unchanged because the exposure is the same:
 *
 * 1. **Every submission lands on the same confirmation.** The API answers one payload for a known
 *    address, an unknown one and nonsense, so there is nothing to branch on, and the confirmation
 *    cannot say whether it worked. What it can do is say what happens *if* the address is one of
 *    ours, how long the link lasts, where to look if nothing arrives — and, because this is a
 *    deletion, that the link alone does nothing.
 * 2. **The only refusal is the caller's budget**, and that message names a wait, never the address.
 *    Anything else caught here is the network.
 *
 * What this form adds is that it says what deletion does *before* the address field, the same
 * words the settings card shows. A reviewer with no account reads the same page a member does.
 */
export function RequestDeletionForm() {
  const emailId = useId();
  const errorId = useId();

  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const body: RequestAccountDeletionRequest = { email };
      await apiFetch(ACCOUNT_DELETION_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      setSent(true);
    } catch (caught) {
      setError(
        caught instanceof ApiClientError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.',
      );
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className={styles.card}>
        <div>
          <h1 className={styles.title}>Check your email</h1>
          <p className={styles.subtitle}>The link lasts one hour.</p>
        </div>
        <p className={styles.prose}>
          If {email.trim() === '' ? 'that address' : email.trim()} has a Teaching Hub account, a
          link to delete it is on its way. It can take a minute — if it has not arrived, look in
          your spam folder before asking again.
        </p>
        <p className={styles.prose}>
          The link alone deletes nothing. The page it opens asks for the account&rsquo;s password,
          so a message that reaches the wrong inbox cannot delete your account.
        </p>
        <Link className={styles.link} href="/sign-in">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className={`${styles.card} ${error === null ? '' : styles.cardErrored}`}>
      <div>
        <h1 className={styles.title}>Delete your account</h1>
        <p className={styles.subtitle}>
          For a member without the app. Tell us the address on the account and we will email you a
          link to finish.
        </p>
      </div>

      <WhatDeletionDoes />

      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={emailId}>
            Email
          </label>
          <input
            className={styles.input}
            id={emailId}
            name="email"
            type="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            {...(error === null ? {} : { 'aria-describedby': errorId })}
          />
        </div>

        {error === null ? null : (
          <p className={styles.error} id={errorId} role="alert">
            {error}
          </p>
        )}

        <button className={styles.submit} type="submit" disabled={submitting}>
          {submitting ? 'Sending…' : 'Send me a link'}
        </button>

        <Link className={styles.link} href="/sign-in">
          Back to sign in
        </Link>
      </form>
    </div>
  );
}
