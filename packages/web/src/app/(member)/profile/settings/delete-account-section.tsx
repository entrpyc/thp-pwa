'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import {
  ACCOUNT_DELETED_PAGE_PATH,
  ME_PATH,
  type AccountDeletedPayload,
  type DeleteOwnAccountRequest,
} from '@thp/shared';
import { apiFetch } from '@/client/api-client';
import { resetAnalytics } from '@/client/observability/analytics';
import { offlineManager } from '@/client/offline/manager';
import {
  DELETION_CONFIRMATION_WORD,
  isDeletionConfirmed,
} from '@/app/(public)/delete-account/confirmation';
import { WhatDeletionDoes } from '@/app/(public)/delete-account/what-deletion-does';
import { describeFailure } from '../describe-failure';
import styles from '../profile.module.css';
import formStyles from './delete-account-section.module.css';
import { SettingsSection } from './settings-section';

/**
 * **Delete account** — the settings page's last section: the in-app door Apple 5.1.1(v) and Google
 * Play require ([3.1.8](docs/project/prd.md)), on `DELETE /api/v1/users/me`.
 *
 * Last on the page, below the session and the consent, because it is the one card whose button
 * should never be the first thing under a thumb. What it says before anything can be pressed is
 * `WhatDeletionDoes` — the erasure convention of packages/db/src/README.md in plain words, shared
 * with the public page so the two doors describe one deletion.
 *
 * **Three steps, each deliberate:**
 *
 * 1. **A first press opens the form; it deletes nothing.** The card at rest is the explanation and
 *    one outlined button, the shape admin deactivation has. The solid fill appears only once the
 *    person has asked for it, and it is the card's one primary action.
 * 2. **The password proves the person; a typed word proves the intention** (operator decision,
 *    recorded in `confirmation.ts`). The submit stays disabled until both are there, so a password
 *    manager's one keystroke cannot be the whole act.
 * 3. **Refusals are the API's sentences.** Wrong password (`password_incorrect`) and the last
 *    active admin (`last_admin`) each arrive with a message that says what to do next — check it, or
 *    promote somebody first — and rewriting either here would throw away the only part the person
 *    can act on. The form keeps what was typed, and the card never says something the account does
 *    not hold.
 *
 * **Success leaves the app in one motion.** The response already cleared the cookie and every
 * session row went with the account, so the client's part is to forget the analytics identity and
 * replace the current page with `/account-deleted` — `replace`, so back does not return to a
 * settings page for an account that no longer exists, and `refresh`, so nothing rendered under the
 * old session survives in the router cache.
 */

const UNREACHABLE =
  'Could not reach the server. Nothing has changed — check your connection and try again.';

export function DeleteAccountSection() {
  const router = useRouter();
  const passwordId = useId();
  const confirmationId = useId();
  const hintId = useId();
  const failureId = useId();

  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const ready = password !== '' && isDeletionConfirmed(typed);

  function cancel(): void {
    setOpen(false);
    setPassword('');
    setTyped('');
    setFailure(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting || !ready) return;
    setSubmitting(true);
    setFailure(null);

    try {
      const body: DeleteOwnAccountRequest = { password };
      await apiFetch<AccountDeletedPayload>(ME_PATH, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      // Deliberately left "submitting": the button reads "Deleting…" until the page is gone.
      resetAnalytics();
      // What sign-out forgets on the device, this forgets too: the draft and who was signed in.
      await offlineManager().deactivate().catch(() => undefined);
      router.replace(ACCOUNT_DELETED_PAGE_PATH);
      router.refresh();
    } catch (caught) {
      setFailure(describeFailure(caught, UNREACHABLE));
      setSubmitting(false);
    }
  }

  return (
    <SettingsSection
      title="Delete account"
      lead="Permanently delete your account and everything private to it. This is the one thing in the app that nobody can undo."
    >
      <WhatDeletionDoes />

      {open ? (
        <form className={formStyles.form} onSubmit={onSubmit} noValidate>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor={passwordId}>
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
              {...(failure === null ? {} : { 'aria-describedby': failureId })}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor={confirmationId}>
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
            <p className={styles.quiet} id={hintId}>
              The button unlocks when the word matches.
            </p>
          </div>

          {failure === null ? null : (
            <p className={styles.failure} id={failureId} role="alert">
              {failure}
            </p>
          )}

          <div className={styles.actions}>
            <button className={styles.primary} type="submit" disabled={!ready || submitting}>
              {submitting ? 'Deleting…' : 'Yes, delete my account'}
            </button>
            <button
              className={styles.secondary}
              type="button"
              onClick={cancel}
              disabled={submitting}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className={styles.actions}>
          <button className={styles.secondary} type="button" onClick={() => setOpen(true)}>
            Delete my account
          </button>
        </div>
      )}
    </SettingsSection>
  );
}
