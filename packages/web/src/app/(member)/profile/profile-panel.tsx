'use client';

import { useRouter } from 'next/navigation';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type SyntheticEvent,
} from 'react';
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
import {
  centreSquare,
  checkChosenArtwork,
  encodeAvatar,
  moveSquare,
  resizeSquare,
  type CropSquare,
} from '@/client/artwork/encode';
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
  /*
   * The file the member chose, waiting for its crop. An object URL rather than a data URL because
   * a phone photo is several megabytes and a data URL would copy it into a string; it is revoked
   * the moment the sheet closes, whichever way it closes.
   */
  const [pending, setPending] = useState<{ file: File; url: string } | null>(null);
  const [viewing, setViewing] = useState(false);

  function onChosen(event: ChangeEvent<HTMLInputElement>): void {
    const chosen = event.target.files?.[0];
    // Cleared at once, so choosing the same file again after a refusal fires a change event.
    event.target.value = '';
    if (chosen === undefined || busy !== null || pending !== null) return;

    // Refused before anything is encoded and before any grant is asked for, so a file the product
    // does not accept costs a press rather than a round trip. The API asks the same question twice
    // more — of the declared type, and of what actually landed.
    const complaint = checkChosenArtwork(chosen);
    if (complaint !== null) {
      setNote({ tone: 'refused', text: complaint });
      return;
    }

    // Nothing is encoded and no grant is asked for until the crop is confirmed: a grant is budgeted
    // (3.1.22), and a member who looks at the picture and changes their mind has spent none of it.
    setNote(null);
    setPending({ file: chosen, url: URL.createObjectURL(chosen) });
  }

  function closeCrop(): void {
    if (pending !== null) URL.revokeObjectURL(pending.url);
    setPending(null);
  }

  function onCropRefused(text: string): void {
    closeCrop();
    setNote({ tone: 'refused', text });
  }

  async function onCropped(square: CropSquare): Promise<void> {
    if (pending === null || busy !== null) return;
    const chosen = pending.file;
    closeCrop();

    setBusy('uploading');
    setNote(null);
    try {
      const encoded = await encodeAvatar(chosen, square);
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
          /*
            The portrait is a press as well as a picture: at this size a face is recognisable and
            a crop is not, and a member who has just saved one wants to see what the circle holds.
            `key`ed on the URL so a replaced picture is a fresh element rather than a cached one.
          */
          <button
            className={styles.portraitPress}
            type="button"
            aria-label="View your picture"
            onClick={() => setViewing(true)}
          >
            <img
              key={user.avatarUrl}
              className={styles.portrait}
              src={user.avatarUrl}
              alt="Your picture"
            />
          </button>
        )}

        <div className={styles.portraitControls}>
          <p className={styles.prose}>
            Shown beside your name on the notes you share. {ACCEPTED_ARTWORK_LABEL}, up to{' '}
            {MAX_ARTWORK_LABEL}; you choose the square it is cropped to.
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
              disabled={busy !== null || pending !== null}
              onChange={onChosen}
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

      {pending === null ? null : (
        <CropSheet
          src={pending.url}
          onCropped={(square) => void onCropped(square)}
          onCancel={closeCrop}
          onRefused={onCropRefused}
        />
      )}
      {viewing && user.avatarUrl !== null ? (
        <PictureViewer src={user.avatarUrl} onClose={() => setViewing(false)} />
      ) : null}
    </section>
  );
}

// =================================================================================================

/**
 * **The crop step** — the chosen picture, a square over it, and two answers.
 *
 * The square is held in **source pixels** and painted in percentages, so the same region reads the
 * same whether the sheet is on a phone or a desktop and nothing here has to know how big the image
 * was painted — until a drag, where the pointer's movement in painted pixels is scaled up by the
 * painted width against the natural width. Every move and every zoom goes through `encode.ts`'s
 * pure geometry, which is where the rule "stay on the picture" lives and is tested.
 *
 * The square is a focusable control as well as a drag target: arrow keys move it, so the crop is
 * reachable from a keyboard, and the zoom is a plain range input for the same reason.
 *
 * The one thing it refuses: a file whose declared type was an image and whose bytes are not. The
 * `<img>` is the first decode the file meets, and its error is the file's refusal.
 */
function CropSheet({
  src,
  onCropped,
  onCancel,
  onRefused,
}: {
  src: string;
  onCropped: (square: CropSquare) => void;
  onCancel: () => void;
  onRefused: (text: string) => void;
}) {
  const titleId = useId();
  const zoomId = useId();
  const imageRef = useRef<HTMLImageElement>(null);
  const [picture, setPicture] = useState<{ width: number; height: number } | null>(null);
  const [square, setSquare] = useState<CropSquare | null>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  function onLoaded(event: SyntheticEvent<HTMLImageElement>): void {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    if (naturalWidth === 0 || naturalHeight === 0) {
      onRefused('That file could not be read as a picture.');
      return;
    }
    setPicture({ width: naturalWidth, height: naturalHeight });
    setSquare(centreSquare(naturalWidth, naturalHeight));
  }

  /** How many source pixels one painted pixel is — read at the moment it is needed, never cached. */
  function sourcePerPainted(): number {
    const painted = imageRef.current?.getBoundingClientRect().width ?? 0;
    return picture === null || painted === 0 ? 1 : picture.width / painted;
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    const held = drag.current;
    if (held === null || held.pointerId !== event.pointerId || picture === null) return;
    const scale = sourcePerPainted();
    const dx = (event.clientX - held.x) * scale;
    const dy = (event.clientY - held.y) * scale;
    drag.current = { ...held, x: event.clientX, y: event.clientY };
    setSquare((current) =>
      current === null ? current : moveSquare(picture.width, picture.height, current, dx, dy),
    );
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>): void {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (picture === null) return;
    // A step of one fiftieth of the square: fine enough to place a face, coarse enough to cross a
    // picture in a held key.
    const steps: Record<string, readonly [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const step = steps[event.key];
    if (step === undefined) return;
    event.preventDefault();
    setSquare((current) => {
      if (current === null) return current;
      const by = Math.max(1, Math.round(current.size / 50));
      return moveSquare(picture.width, picture.height, current, step[0] * by, step[1] * by);
    });
  }

  /*
   * Zoom is the inverse of the square's edge: 1 is the whole shorter edge, 4 is a quarter of it. A
   * range input wants a number that grows with the thing it does, and "zoom in" is a bigger number.
   */
  const shortest = picture === null ? 1 : Math.min(picture.width, picture.height);
  const zoom = square === null ? 1 : shortest / square.size;

  function onZoom(event: ChangeEvent<HTMLInputElement>): void {
    if (picture === null) return;
    const next = Number(event.target.value);
    setSquare((current) =>
      current === null
        ? current
        : resizeSquare(picture.width, picture.height, current, shortest / next),
    );
  }

  useEffect(() => {
    function onEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [onCancel]);

  const frame =
    picture === null || square === null
      ? null
      : {
          left: `${(square.x / picture.width) * 100}%`,
          top: `${(square.y / picture.height) * 100}%`,
          width: `${(square.size / picture.width) * 100}%`,
          height: `${(square.size / picture.height) * 100}%`,
        };

  return (
    <div className={styles.scrim}>
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 className={styles.cardTitle} id={titleId}>
          Crop your picture
        </h2>
        <p className={styles.prose}>Drag the square to the part you want. It is shown as a circle.</p>

        <div className={styles.cropStageRow}>
          <div className={styles.cropStage}>
            <img
              ref={imageRef}
              className={styles.cropImage}
              src={src}
              alt=""
              draggable={false}
              onLoad={onLoaded}
              onError={() => onRefused('That file could not be read as a picture.')}
            />
            {frame === null ? null : (
              <div
                className={styles.cropSquare}
                style={frame}
                role="img"
                aria-label="The square that will be kept. Arrow keys move it."
                tabIndex={0}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onKeyDown={onKeyDown}
              />
            )}
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={zoomId}>
            Zoom
          </label>
          <input
            className={styles.zoom}
            id={zoomId}
            type="range"
            min={1}
            max={4}
            step={0.01}
            value={zoom}
            disabled={square === null}
            onChange={onZoom}
          />
        </div>

        <div className={styles.actions}>
          <button
            className={styles.primary}
            type="button"
            disabled={square === null}
            onClick={() => {
              if (square !== null) onCropped(square);
            }}
          >
            Use this picture
          </button>
          <button className={styles.secondary} type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// =================================================================================================

/**
 * **The viewer** — the saved picture at the width of the screen, and a way out. A press on the
 * scrim closes it as the close control does, and so does Escape: the three ways a member expects a
 * layer over the page to give way.
 */
function PictureViewer({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    function onEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [onClose]);

  return (
    <div className={styles.scrim} onClick={onClose}>
      <div
        className={styles.viewer}
        role="dialog"
        aria-modal="true"
        aria-label="Your picture, enlarged"
        onClick={(event) => event.stopPropagation()}
      >
        <img className={styles.viewerImage} src={src} alt="Your picture, enlarged" />
        <div className={styles.actions}>
          <button className={styles.secondary} type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
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
