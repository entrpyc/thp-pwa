'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  ACCEPTED_ARTWORK_LABEL,
  AUTH_SESSION_PATH,
  AVATAR_PATH,
  AVATAR_UPLOADS_PATH,
  MAX_ARTWORK_LABEL,
  MAX_DISPLAY_NAME_LENGTH,
  USERS_PATH,
  checkDisplayName,
  monogramFor,
  type AccountSummary,
  type SessionPayload,
  type SessionUser,
  type UploadGrantPayload,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { checkChosenArtwork, encodeAvatar } from '@/client/artwork/encode';
import styles from './profile.module.css';

/**
 * **The profile screen** — a picture and a name, each saved on its own.
 *
 * Two cards rather than one form, because they are two writes with two different shapes: the name
 * is a `PATCH` of one field, and the picture is the cover's three-step upload with the bytes going
 * straight to the store. A single Save that did both would have to answer "which half failed", and
 * a member who has just typed their name should not lose it because a picture was refused.
 *
 * Three rules, and each is the report form's:
 *
 * 1. **Typed text survives every refusal.** The name field is never cleared on a failure.
 * 2. **The refusal is the API's own sentence when the API had one.** An over-long name and an
 *    upload that did not finish are different problems with different answers.
 * 3. **The rule is shown before it is failed.** `checkDisplayName` is the API's own check, read
 *    from `@thp/shared`, so the screen and the route cannot disagree about what a name is.
 *
 * What the screen renders from is the session user the API answered with, not a prop: every write
 * answers with the whole user, and the screen adopts that answer — so what is painted after a save
 * is what the server stored, and never what the client hoped.
 */

const NAME_FAILED = 'Could not save your name. It is still here — try again in a moment.';
const PICTURE_FAILED = 'Could not save your picture. Try again in a moment.';

export function ProfilePanel() {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    void apiFetch<SessionPayload>(AUTH_SESSION_PATH, { credentials: 'include' })
      .then((payload) => setUser(payload.user))
      .catch(() => setLoadFailed(true));
  }, []);

  /*
   * The layout rendered the transport bar and the menu from the actor it read server-side, and
   * the admin console prints the name from the same read. A refresh after a write is what brings
   * those into step with what this screen has just been told.
   */
  function adopt(next: SessionUser): void {
    setUser(next);
    router.refresh();
  }

  return (
    <>
      <header className={styles.pageHead}>
        <h1 className={styles.pageTitle}>My profile</h1>
        <p className={styles.pageLead}>
          The name others see on your notes, and the picture beside it.
        </p>
      </header>

      {loadFailed ? (
        <p className={styles.failure} role="alert">
          Could not load your profile. Reload the page to try again.
        </p>
      ) : user === null ? (
        <p className={styles.quiet}>Loading…</p>
      ) : (
        <>
          <PictureCard user={user} onChanged={adopt} />
          <NameCard user={user} onChanged={adopt} />
        </>
      )}
    </>
  );
}

// =================================================================================================

function PictureCard({
  user,
  onChanged,
}: {
  user: SessionUser;
  onChanged: (next: SessionUser) => void;
}) {
  const inputId = useId();
  const [busy, setBusy] = useState<'uploading' | 'removing' | null>(null);
  const [note, setNote] = useState<{ tone: 'done' | 'refused'; text: string } | null>(null);

  async function onChosen(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const chosen = event.target.files?.[0];
    // Cleared at once, so choosing the same file again after a refusal fires a change event.
    event.target.value = '';
    if (chosen === undefined || busy !== null) return;

    // Refused before anything is encoded and before any grant is asked for, so a file the product
    // does not accept costs a press rather than a round trip. The API asks the same question twice
    // more — of the declared type, and of what actually landed.
    const complaint = checkChosenArtwork(chosen);
    if (complaint !== null) {
      setNote({ tone: 'refused', text: complaint });
      return;
    }

    setBusy('uploading');
    setNote(null);
    try {
      const encoded = await encodeAvatar(chosen);
      const grant = await apiFetch<UploadGrantPayload>(AVATAR_UPLOADS_PATH, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: chosen.name,
          contentType: encoded.contentType,
          size: encoded.blob.size,
        }),
      });

      // The bytes go to the store, not to the API — exactly as a cover's do.
      const sent = await fetch(grant.url, {
        method: 'PUT',
        headers: { 'content-type': grant.contentType },
        body: encoded.blob,
      });
      if (!sent.ok) throw new Error('the upload did not complete');

      const payload = await apiFetch<SessionPayload>(AVATAR_PATH, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: grant.key }),
      });
      onChanged(payload.user);
      setNote({ tone: 'done', text: 'Your picture is saved.' });
    } catch (caught) {
      setNote({ tone: 'refused', text: describeFailure(caught, PICTURE_FAILED) });
    } finally {
      setBusy(null);
    }
  }

  async function onRemove(): Promise<void> {
    if (busy !== null) return;
    setBusy('removing');
    setNote(null);
    try {
      const payload = await apiFetch<SessionPayload>(AVATAR_PATH, {
        method: 'DELETE',
        credentials: 'include',
      });
      onChanged(payload.user);
      setNote({ tone: 'done', text: 'Your picture is removed.' });
    } catch (caught) {
      setNote({ tone: 'refused', text: describeFailure(caught, PICTURE_FAILED) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={styles.card} aria-label="Your picture">
      <h2 className={styles.cardTitle}>Picture</h2>

      <div className={styles.portraitRow}>
        {user.avatarUrl === null ? (
          <span className={styles.portraitMonogram} role="img" aria-label="No picture yet">
            {monogramFor(user.displayName)}
          </span>
        ) : (
          <img className={styles.portrait} src={user.avatarUrl} alt="Your picture" />
        )}

        <div className={styles.portraitControls}>
          <p className={styles.prose}>
            Shown beside your name on the notes you share. {ACCEPTED_ARTWORK_LABEL}, up to{' '}
            {MAX_ARTWORK_LABEL}; it is cropped to a square.
          </p>
          <div className={styles.actions}>
            {/*
              A label styled as the primary control, over a file input that is not painted: the
              native control's own button cannot take the product's shape, and a label is what
              opens the picker by keyboard as well as by press.
            */}
            <label className={styles.primary} htmlFor={inputId}>
              {busy === 'uploading'
                ? 'Saving…'
                : user.avatarUrl === null
                  ? 'Choose a picture'
                  : 'Replace picture'}
            </label>
            <input
              className={styles.fileInput}
              id={inputId}
              name="avatar"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={busy !== null}
              onChange={(event) => void onChosen(event)}
            />
            {user.avatarUrl === null ? null : (
              <button
                className={styles.secondary}
                type="button"
                disabled={busy !== null}
                onClick={() => void onRemove()}
              >
                {busy === 'removing' ? 'Removing…' : 'Remove picture'}
              </button>
            )}
          </div>
        </div>
      </div>

      {note === null ? null : (
        <p
          className={note.tone === 'refused' ? styles.failure : styles.done}
          role={note.tone === 'refused' ? 'alert' : 'status'}
        >
          {note.text}
        </p>
      )}
    </section>
  );
}

// =================================================================================================

function NameCard({
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

/** The API's own sentence when it had one; the screen's fallback when it did not. */
function describeFailure(caught: unknown, fallback: string): string {
  return caught instanceof ApiClientError ? caught.message : fallback;
}
