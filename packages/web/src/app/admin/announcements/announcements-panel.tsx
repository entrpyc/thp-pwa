'use client';

import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import {
  ANNOUNCEMENTS_PATH,
  ANNOUNCEMENT_KINDS,
  MAX_ANNOUNCEMENT_BODY_LENGTH,
  MAX_ANNOUNCEMENT_TITLE_LENGTH,
  NOTIFICATION_KIND_LABEL,
  ONBOARDING_IDS,
  type AnnouncementKind,
  type AnnouncementListPayload,
  type AnnouncementView,
  type OnboardingId,
  type SendAnnouncementPayload,
  type SendAnnouncementRequest,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from './announcements.module.css';

/**
 * The compose form and the list of every past send ([3.17.15](docs/project/prd.md),
 * [3.19.8](docs/project/prd.md)).
 *
 * A client module: it imports no server module, holds no database access, and calls the absolute
 * API origin like every other call the client makes.
 *
 * Three things this screen is careful about:
 *
 * 1. **The kind is a pill pair, not a dropdown.** Two mutually exclusive choices, one of them
 *    current, is the role picker's shape, and it reads at a glance which voice the message goes
 *    out in — the admin's, or the product's.
 * 2. **A new feature asks for its onboarding, and only then.** The field appears with the kind,
 *    and the id is typed rather than picked — the list of onboardings is a fact about the code,
 *    and an admin adding a feature has just added its id there. The server refuses an id it does
 *    not know, and the refusal is printed here beside text that is still in the form.
 * 3. **Sending takes a confirming press.** It reaches every member at once and cannot be unsent,
 *    so the press that does it is the second one, and the confirmation says so.
 */

function describeFailure(caught: unknown): string {
  return caught instanceof ApiClientError
    ? caught.message
    : 'Could not reach the server. Check your connection and try again.';
}

function formatSentAt(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

/** `42 members`, `1 member`. Spelled by suffix so no role name is a string literal here. */
function members(count: number): string {
  return `${count} member${count === 1 ? '' : 's'}`;
}

/** `Sent by Ada on 5 Sept 2026, 10:12 · 42 members`. */
export function describeSend(entry: AnnouncementView): string {
  return `Sent by ${entry.sentByDisplayName} on ${formatSentAt(entry.sentAt)} · ${members(entry.recipientCount)}`;
}

const KIND_HINT: Record<AnnouncementKind, string> = {
  announcement:
    'A message from you to everybody. It has no link — the notification is the message.',
  new_feature:
    'A notice from the product that something is new. Pressing it opens the onboarding you name below.',
};

export function AnnouncementsPanel() {
  const titleId = useId();
  const bodyId = useId();
  const onboardingId = useId();

  const [kind, setKind] = useState<AnnouncementKind>('announcement');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [onboarding, setOnboarding] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [sends, setSends] = useState<readonly AnnouncementView[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const loadSends = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiFetch<AnnouncementListPayload>(ANNOUNCEMENTS_PATH, {
        credentials: 'include',
      });
      // Rendered in the order the API sent — newest first — and never re-sorted here.
      setSends(payload.announcements);
      setListError(null);
    } catch (caught) {
      setSends(null);
      setListError(describeFailure(caught));
    }
  }, []);

  useEffect(() => {
    void loadSends();
  }, [loadSends]);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (busy) return;
    setFailure(null);
    setDone(null);
    setConfirming(true);
  }

  async function send(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setDone(null);
    // The id is sent as typed and checked by the server against the list it holds — this screen
    // does not decide what an onboarding is, it only asks. The cast is the wire type's, not a
    // claim: a wrong id comes back as the refusal printed below.
    const request: SendAnnouncementRequest =
      kind === 'new_feature'
        ? { kind, title, body, onboardingId: onboarding.trim() as OnboardingId }
        : { kind, title, body };
    try {
      const payload = await apiFetch<SendAnnouncementPayload>(ANNOUNCEMENTS_PATH, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      const sent = payload.announcement;
      setDone(`“${sent.title}” is sent to ${members(sent.recipientCount)}.`);
      setTitle('');
      setBody('');
      setOnboarding('');
      setConfirming(false);
      await loadSends();
    } catch (caught) {
      // Refused: what was typed stays exactly where it is, so being refused costs the press alone.
      setFailure(describeFailure(caught));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-labelledby="send-announcement-heading">
        <div>
          <h2 className={styles.sectionTitle} id="send-announcement-heading">
            Send a notification
          </h2>
          <p className={styles.sectionNote}>
            It goes to every active member at once, in their notification centre. It cannot be
            unsent.
          </p>
        </div>

        <form className={styles.form} onSubmit={onSubmit} noValidate>
          <div className={styles.fieldTight}>
            <span className={styles.label} id="announcement-kind-label">
              Kind
            </span>
            <div className={styles.kindPicker} role="group" aria-labelledby="announcement-kind-label">
              {ANNOUNCEMENT_KINDS.map((option) => (
                <button
                  key={option}
                  className={styles.kindOption}
                  type="button"
                  aria-pressed={kind === option}
                  disabled={busy}
                  onClick={() => {
                    setKind(option);
                    setConfirming(false);
                  }}
                >
                  {NOTIFICATION_KIND_LABEL[option]}
                </button>
              ))}
            </div>
            <p className={styles.hint}>{KIND_HINT[kind]}</p>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={titleId}>
              Title
            </label>
            <input
              className={styles.input}
              id={titleId}
              name="title"
              type="text"
              autoComplete="off"
              maxLength={MAX_ANNOUNCEMENT_TITLE_LENGTH}
              disabled={busy}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={bodyId}>
              Message
            </label>
            <textarea
              className={styles.textarea}
              id={bodyId}
              name="body"
              rows={4}
              maxLength={MAX_ANNOUNCEMENT_BODY_LENGTH}
              disabled={busy}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
            <p className={styles.hint}>
              {body.length.toLocaleString('en-GB')} / {MAX_ANNOUNCEMENT_BODY_LENGTH.toLocaleString('en-GB')}
            </p>
          </div>

          {kind === 'new_feature' ? (
            <div className={styles.field}>
              <label className={styles.label} htmlFor={onboardingId}>
                Onboarding id
              </label>
              <input
                className={styles.input}
                id={onboardingId}
                name="onboardingId"
                type="text"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                value={onboarding}
                onChange={(event) => setOnboarding(event.target.value)}
              />
              <p className={styles.hint}>
                The onboarding a press opens, as it is named in the code. Known today:{' '}
                {ONBOARDING_IDS.join(', ')}.
              </p>
            </div>
          ) : null}

          {confirming ? (
            <div className={styles.confirm}>
              <p className={styles.confirmText}>
                Send “{title.trim() || 'this'}” to every active member? It cannot be unsent.
              </p>
              <div className={styles.confirmActions}>
                <button
                  className={styles.actionStrong}
                  type="button"
                  disabled={busy}
                  onClick={() => void send()}
                >
                  {busy ? 'Sending…' : 'Yes, send it'}
                </button>
                <button
                  className={styles.action}
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button className={styles.submit} type="submit" disabled={busy}>
              Send to all members
            </button>
          )}

          {failure === null ? null : (
            <p className={styles.failure} role="alert">
              {failure}
            </p>
          )}
          {done === null ? null : (
            <p className={styles.done} role="status">
              {done}
            </p>
          )}
        </form>
      </section>

      <section className={styles.section} aria-labelledby="sent-announcements-heading">
        <div>
          <h2 className={styles.sectionTitle} id="sent-announcements-heading">
            Sent
          </h2>
          <p className={styles.sectionNote}>
            Everything sent from this panel, newest first, with who sent it and how many members it
            reached at the time.
          </p>
        </div>

        {listError !== null ? (
          <p className={styles.failure} role="alert">
            {listError}
          </p>
        ) : sends === null ? (
          <p className={styles.sectionNote}>Loading…</p>
        ) : sends.length === 0 ? (
          <p className={styles.empty}>Nothing sent yet. The first one will appear here.</p>
        ) : (
          <ul className={styles.list}>
            {sends.map((entry) => (
              <li className={styles.listRow} key={entry.id}>
                <div className={styles.rowIdentity}>
                  <p className={styles.rowName}>
                    <span className={styles.chip}>{NOTIFICATION_KIND_LABEL[entry.kind]}</span>{' '}
                    {entry.title}
                  </p>
                  <p className={styles.rowBody}>{entry.body}</p>
                  <p className={styles.rowMeta}>
                    {describeSend(entry)}
                    {entry.onboardingId === null ? null : ` · opens ${entry.onboardingId}`}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
