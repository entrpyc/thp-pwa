'use client';

import { useId, useState, type FormEvent } from 'react';
import {
  MAX_DISPLAY_NAME_LENGTH,
  USERS_PATH,
  checkDisplayName,
  type AccountSummary,
  type SessionUser,
} from '@thp/shared';
import { apiFetch } from '@/client/api-client';
import { describeFailure } from './describe-failure';
import styles from './profile.module.css';

/**
 * **The name** — the identity page's second card: one field, one `PATCH`.
 *
 * It stays on `/profile` rather than moving to `/profile/settings`, because [3.1.12](docs/project/prd.md)
 * describes the profile as a display name and an avatar — the two things another member sees on a
 * note's author line. Settings is for what nobody else sees.
 *
 * Three rules, and each is the report form's:
 *
 * 1. **Typed text survives every refusal.** The field is never cleared on a failure.
 * 2. **The refusal is the API's own sentence when the API had one.**
 * 3. **The rule is shown before it is failed.** `checkDisplayName` is the API's own check, read
 *    from `@thp/shared`, so the screen and the route cannot disagree about what a name is.
 */

const NAME_FAILED = 'Could not save your name. It is still here — try again in a moment.';

export function NameCard({
  user,
  onChanged,
}: {
  user: SessionUser;
  onChanged: (next: SessionUser) => void;
}) {
  const nameId = useId();
  const errorId = useId();
  const [name, setName] = useState(user.displayName);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ tone: 'done' | 'refused'; text: string } | null>(null);

  // The API's own rule, read from the shared module, so the screen refuses exactly what the route
  // would — and can say so before the press rather than after it.
  const complaint = checkDisplayName(name);
  const unchanged = name.trim() === user.displayName;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving || complaint !== null || unchanged) return;

    setSaving(true);
    setNote(null);
    try {
      const saved = await apiFetch<AccountSummary>(`${USERS_PATH}/${user.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: name.trim() }),
      });
      // The PATCH answers with the account summary rather than the session user; the two agree on
      // the name, and the rest of the user is what it was — including the picture.
      onChanged({ ...user, displayName: saved.displayName });
      setName(saved.displayName);
      setNote({ tone: 'done', text: `Your name is now ${saved.displayName}.` });
    } catch (caught) {
      setNote({ tone: 'refused', text: describeFailure(caught, NAME_FAILED) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className={styles.card} onSubmit={onSubmit} aria-label="Your name">
      <h2 className={styles.cardTitle}>Name</h2>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor={nameId}>
          Display name
        </label>
        <input
          className={styles.input}
          id={nameId}
          name="displayName"
          type="text"
          autoComplete="name"
          maxLength={MAX_DISPLAY_NAME_LENGTH}
          value={name}
          onChange={(event) => setName(event.target.value)}
          {...(complaint === null ? {} : { 'aria-describedby': errorId, 'aria-invalid': true })}
        />
        {/*
          The rule, while it is being broken. Blank is the one complaint not worth printing under
          an empty box — the disabled button says it — so only the ceiling is voiced here.
        */}
        {complaint === null || name.trim() === '' ? null : (
          <p className={styles.fieldError} id={errorId}>
            {complaint}
          </p>
        )}
      </div>

      <p className={styles.quiet}>Signed in as {user.email}. Your address is not shown to others.</p>

      {note === null ? null : (
        <p
          className={note.tone === 'refused' ? styles.failure : styles.done}
          role={note.tone === 'refused' ? 'alert' : 'status'}
        >
          {note.text}
        </p>
      )}

      <div className={styles.actions}>
        <button
          className={styles.primary}
          type="submit"
          disabled={saving || complaint !== null || unchanged}
        >
          {saving ? 'Saving…' : 'Save name'}
        </button>
      </div>
    </form>
  );
}
