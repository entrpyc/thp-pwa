'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import {
  PASSWORD_RESET_COMPLETE_PATH,
  PASSWORD_RULE_TEXT,
  checkPassword,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from './reset-password.module.css';

/**
 * Choosing the new password, and being back inside.
 *
 * The same three things shape it as shape the accept form, because they are the same three things:
 *
 * 1. **The rule is printed before it can be broken**, read from the same module the API checks
 *    against, so the screen cannot promise a rule the server does not apply.
 * 2. **Being refused costs nothing.** The field keeps what was typed, the page does not reload, and
 *    the message says what is wrong rather than that something is.
 * 3. **Finishing lands you inside in one motion.** The response carries the session cookie, so
 *    there is no moment where the password is new and the person is looking at a sign-in form. That
 *    is the difference between finishing and starting again.
 *
 * The address is a real, read-only input rather than a line of text, so a password manager has a
 * username field to attach the replaced credential to.
 */
export function ResetPasswordForm({ email, token }: { email: string; token: string }) {
  const router = useRouter();
  const emailId = useId();
  const passwordId = useId();
  const ruleId = useId();
  const errorId = useId();

  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    // Checked here first only so the answer is instant. The API checks the same rules against the
    // same module and is what actually refuses — the client holds no decision.
    const weakness = checkPassword(password, { email });
    if (weakness !== null) {
      setError(weakness);
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await apiFetch(PASSWORD_RESET_COMPLETE_PATH, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      // The session cookie is set by that response; `/` is a server component and re-reads it.
      router.replace('/');
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiClientError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.',
      );
      setSubmitting(false);
    }
  }

  return (
    <div className={`${styles.card} ${error === null ? '' : styles.cardErrored}`}>
      <div>
        <h1 className={styles.title}>Choose a new password</h1>
        <p className={styles.subtitle}>One field, and you are back in.</p>
      </div>

      {/*
        `POST`, for the reason `sign-in-form.tsx` sets out. The same pairing as the accept screen: a
        password being chosen, on a page whose URL carries the token that authorises choosing it.
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
            New password
          </label>
          <input
            className={styles.input}
            id={passwordId}
            name="password"
            type="password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby={error === null ? ruleId : `${ruleId} ${errorId}`}
          />
          <p className={styles.rule} id={ruleId}>
            {PASSWORD_RULE_TEXT}
          </p>
        </div>

        {error === null ? null : (
          <p className={styles.error} id={errorId} role="alert">
            {error}
          </p>
        )}

        <button className={styles.submit} type="submit" disabled={submitting}>
          {submitting ? 'Setting your password…' : 'Set password and continue'}
        </button>
      </form>
    </div>
  );
}
