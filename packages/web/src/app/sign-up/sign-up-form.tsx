'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import { PASSWORD_RULE_TEXT, SIGN_UP_PATH, checkPassword } from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from './sign-up.module.css';

/**
 * The registration form.
 *
 * It is sign-in's form with two differences, and both are about the fact that this screen *creates*
 * something:
 *
 * 1. **The password rule is printed before it can be broken**, read from the same shared module the
 *    API checks against — so the screen cannot promise a rule the server does not apply. The same
 *    argument `accept-form.tsx` makes: a rule you only learn by being refused is an exam.
 * 2. **`autoComplete="new-password"`**, so a password manager offers to generate and store one
 *    rather than offering the credential for an account that does not exist yet.
 *
 * Everything else is deliberately the same: what you typed survives a refusal, a refusal does not
 * reload the page, and the response carries the session cookie so registering lands you inside in
 * one motion rather than handing you an account and then a sign-in form.
 */
export function SignUpForm() {
  const router = useRouter();
  const emailId = useId();
  const passwordId = useId();
  const ruleId = useId();
  const errorId = useId();

  const [email, setEmail] = useState('');
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
      await apiFetch(SIGN_UP_PATH, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
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
        <h1 className={styles.title}>Create your account</h1>
        <p className={styles.subtitle}>
          An email address and a password. You join as a member; an admin sets anything beyond that.
        </p>
      </div>

      {/*
        `POST` for the reason `sign-in-form.tsx` sets out at length: a submission that beats
        hydration is made by the browser itself with the default method, and the default is `GET`,
        which would put this form's password in the address bar, the history and every access log
        between here and the server.
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
            autoComplete="new-password"
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
          {submitting ? 'Creating your account…' : 'Create account'}
        </button>

        {/*
          Inside the form and after the button, the way `/sign-in` carries its route to
          `/forgot-password`: the next thing a keyboard reaches after being told the address is
          already taken is the screen that address belongs on.
        */}
        <Link className={styles.link} href="/sign-in">
          Already have an account? Sign in
        </Link>
      </form>
    </div>
  );
}
