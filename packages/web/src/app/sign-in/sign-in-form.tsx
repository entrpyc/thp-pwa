'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import { AUTH_SESSION_PATH, FORGOT_PASSWORD_PAGE_PATH } from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from './sign-in.module.css';

/**
 * The sign-in form.
 *
 * A client module: it imports no server module and holds no database access, and it calls the
 * absolute API origin like every other call the client makes — the boundary Ticket 1 established and
 * the import-boundary guard enforces.
 *
 * Two behaviours the tests pin, both about what being refused feels like: what you typed in the
 * email field survives a failure, and a failure does not reload the page.
 */
export function SignInForm() {
  const router = useRouter();
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      await apiFetch(AUTH_SESSION_PATH, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      // The session cookie is set; `/` is a server component and re-reads it.
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
        <h1 className={styles.title}>Sign in</h1>
        <p className={styles.subtitle}>Teaching Hub is invitation only.</p>
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
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            {...(error === null ? {} : { 'aria-describedby': errorId })}
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
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            {...(error === null ? {} : { 'aria-describedby': errorId })}
          />
        </div>

        {error === null ? null : (
          <p className={styles.error} id={errorId} role="alert">
            {error}
          </p>
        )}

        <button className={styles.submit} type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>

        {/*
          Inside the form and after the button, so it is the next thing a keyboard reaches after
          failing — and always present, not revealed by a refusal. A reset flow nobody can get to
          from where they failed is a flow that does not exist.
        */}
        <Link className={styles.link} href={FORGOT_PASSWORD_PAGE_PATH}>
          Forgotten your password?
        </Link>
      </form>
    </div>
  );
}
