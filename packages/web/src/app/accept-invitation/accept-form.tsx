'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import {
  INVITATIONS_ACCEPT_PATH,
  PASSWORD_RULE_TEXT,
  checkPassword,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from './accept-invitation.module.css';

/**
 * Choosing a password, and being inside.
 *
 * The three things this form is shaped by, all of them feel rather than function:
 *
 * 1. **The rule is printed before it can be broken.** `PASSWORD_RULE_TEXT` is under the field from
 *    the moment the screen loads, read from the same module the API checks against — so the screen
 *    cannot promise a rule the server does not apply.
 * 2. **Being refused costs nothing.** The field keeps what was typed, the page does not reload, and
 *    the message says what is wrong rather than that something is.
 * 3. **Accepting lands you inside in one motion.** The response carries the session cookie, so
 *    there is no moment where the account exists and the person is looking at a sign-in form.
 *
 * The address is a real, read-only input rather than a line of text: a password manager needs a
 * username field to attach the new credential to, and this is the only screen where the credential
 * is being created.
 */
export function AcceptInvitationForm({ email, token }: { email: string; token: string }) {
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
      await apiFetch(INVITATIONS_ACCEPT_PATH, {
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
        <h1 className={styles.title}>Choose a password</h1>
        <p className={styles.subtitle}>One field, and you are in.</p>
      </div>

      <form className={styles.form} onSubmit={onSubmit} noValidate>
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
            Password
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
          {submitting ? 'Setting up your account…' : 'Set password and continue'}
        </button>
      </form>
    </div>
  );
}
