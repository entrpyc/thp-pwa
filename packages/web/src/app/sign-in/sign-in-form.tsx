'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import { AUTH_SESSION_PATH, FORGOT_PASSWORD_PAGE_PATH, SIGN_UP_PAGE_PATH } from '@thp/shared';
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
        <p className={styles.subtitle}>Welcome back to Teaching Hub.</p>
      </div>

      {/*
        **`method="post"` on a form that never posts**, and it is not decoration.

        The handler below calls `preventDefault`, so on every ordinary submission this attribute does
        nothing. The submission it exists for is the one where the handler is *not there yet*: React
        has to hydrate before `onSubmit` is attached, and a form submitted before that — a fast
        typist pressing Enter, a slow device, a bundle that failed — is submitted by the browser
        itself, using the default method. The default is `GET`, which puts every field in the query
        string. That would send this form's **password** into the address bar, the history, the
        server's access log and every proxy in between.

        `POST` puts them in a request body instead. The page route does not answer `POST`, so the
        member gets an error rather than a session — which is the honest outcome for a press that
        happened before the page was ready, and is the outcome they got before, minus the leak.
      */}
      <form className={styles.form} method="post" onSubmit={onSubmit} noValidate>
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
          Inside the form and after the button, so they are the next things a keyboard reaches after
          failing — and always present, not revealed by a refusal. A reset flow nobody can get to
          from where they failed is a flow that does not exist, and the same is true of registering:
          the two reasons a sign-in fails are a password you have forgotten and an account you never
          made, so both ways out are here (docs/project/prd.md, 3.1.15).
        */}
        <Link className={styles.link} href={FORGOT_PASSWORD_PAGE_PATH}>
          Forgotten your password?
        </Link>

        <Link className={styles.link} href={SIGN_UP_PAGE_PATH}>
          New here? Create an account
        </Link>
      </form>
    </div>
  );
}
