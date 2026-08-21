'use client';

import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import { PASSWORD_RESET_PATH } from '@thp/shared';
import { apiFetch } from '@/client/api-client';
import styles from './forgot-password.module.css';

/**
 * Asking for a reset link.
 *
 * **This is the one screen in the product that must be deliberately unhelpful**, and the whole
 * design problem is that it should not feel it. The API answers identically for an address that has
 * an account and one that does not — that is the enumeration rule — so the confirmation cannot tell
 * you whether it worked. What it can do is sound like care rather than a shrug: it says what
 * happens *if* the address is one of ours, how long the link lasts, and where to look if nothing
 * arrives.
 *
 * Two consequences follow from that, and both are deliberate:
 *
 * 1. **Every submission lands on the same confirmation.** There is no branch, because there is
 *    nothing to branch on: the client is told the same thing the server tells everybody.
 * 2. **A failure to reach the server is the only error this screen can show.** Anything the API
 *    answers is a success by construction.
 */
export function ForgotPasswordForm() {
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
      await apiFetch(PASSWORD_RESET_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setSent(true);
    } catch {
      // The API cannot fail this request on its merits — it answers the same payload for every
      // outcome — so anything caught here is the network, and saying so is honest.
      setError('Could not reach the server. Check your connection and try again.');
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
          link to choose a new password is on its way. It can take a minute — if it has not arrived,
          look in your spam folder before asking again.
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
        <h1 className={styles.title}>Reset your password</h1>
        <p className={styles.subtitle}>
          Tell us the address you sign in with and we will send you a link.
        </p>
      </div>

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
            autoFocus
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
