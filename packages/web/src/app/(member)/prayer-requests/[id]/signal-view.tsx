'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import {
  MAX_SOS_CLOSING_NOTE_LENGTH,
  MAX_SOS_REPLY_LENGTH,
  SOS_PAGE_PATH,
  SOS_URGENCY_LABEL,
  SOS_URGENCY_MEANING,
  sosClosePath,
  sosPath,
  sosPrayingPath,
  sosRepliesPath,
  sosReplyPath,
  type CloseSosRequest,
  type ReplyToSosRequest,
  type SosRemovedPayload,
  type SosReplyView,
  type SosSignalDetailView,
  type SosSignalPayload,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { useBreadcrumbTrail } from '../../player-context';
import { TermsPrompt, isTermsRequired } from '../../recordings/[id]/terms-prompt';
import { AuthorLine } from '../author-line';
import { whenRaised } from '../format';
import { UrgencyDot } from '../urgency-dot';
import styles from '../sos.module.css';

/**
 * **One signal** — the request, who is praying, the replies, and the controls that end it.
 *
 * Every write replaces the whole signal with the API's answer rather than splicing a change in,
 * so the praying count, the names and the reply list cannot disagree after a press. A press that
 * fails leaves what was on screen as it was and says why underneath.
 *
 * What a member sees is decided by two facts: `signal.mine` (the API's, so the client never
 * compares ids) shows Close and the closing-note field; `canModerate` (the page's, from the policy
 * module) shows Close and Remove on anybody's, and Remove on any reply. Neither permits anything —
 * the API refuses on its own.
 */

const FAILED_MESSAGE = 'Could not do that. Check your connection and try again.';

export function SignalView({ signalId, canModerate }: { signalId: string; canModerate: boolean }) {
  const router = useRouter();
  const [signal, setSignal] = useState<SosSignalDetailView | null>(null);
  const [missing, setMissing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [termsNeeded, setTermsNeeded] = useState(false);
  /** The top-level reply whose thread has the inline reply box open, if any. */
  const [answering, setAnswering] = useState<string | null>(null);

  useBreadcrumbTrail(
    signal === null ? 'Prayer request' : `${SOS_URGENCY_LABEL[signal.urgency]} prayer request`,
    [{ label: 'Prayer requests', href: SOS_PAGE_PATH }],
  );

  useEffect(() => {
    let stale = false;
    void apiFetch<SosSignalPayload>(sosPath(signalId), { credentials: 'include' })
      .then((payload) => {
        if (!stale) setSignal(payload.signal);
      })
      .catch((caught: unknown) => {
        if (stale) return;
        if (caught instanceof ApiClientError && caught.code === 'not_found') setMissing(true);
        else setFailure(caught instanceof ApiClientError ? caught.message : FAILED_MESSAGE);
      });
    return () => {
      stale = true;
    };
  }, [signalId]);

  /** One write, then the signal as it now reads. `terms_required` opens the prompt instead of a sentence. */
  async function write(path: string, init: { method: string; body?: unknown }): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setFailure(null);
    try {
      const payload = await apiFetch<SosSignalPayload>(path, {
        method: init.method,
        credentials: 'include',
        ...(init.body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
      });
      setSignal(payload.signal);
      return true;
    } catch (caught) {
      if (isTermsRequired(caught)) setTermsNeeded(true);
      else setFailure(caught instanceof ApiClientError ? caught.message : FAILED_MESSAGE);
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** A reply to the signal, or into one top-level reply's thread. The thread's box closes once sent. */
  async function sendReply(text: string, parentId: string | null): Promise<boolean> {
    const sent = await write(sosRepliesPath(signalId), {
      method: 'POST',
      body: { text, parentId } satisfies ReplyToSosRequest,
    });
    if (sent && parentId !== null) setAnswering(null);
    return sent;
  }

  /** Removing a top-level reply takes its thread with it, so one with a thread asks first. */
  async function removeReply(reply: SosReplyView): Promise<void> {
    if (busy) return;
    if (reply.replies.length > 0) {
      const under =
        reply.replies.length === 1
          ? 'the reply under it'
          : `the ${reply.replies.length} replies under it`;
      if (!window.confirm(`Remove this reply and ${under}? This cannot be undone.`)) return;
    }
    await write(sosReplyPath(signalId, reply.id), { method: 'DELETE' });
  }

  async function remove(): Promise<void> {
    if (busy) return;
    if (!window.confirm('Remove this prayer request for everybody? Its replies go with it. This cannot be undone.')) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await apiFetch<SosRemovedPayload>(sosPath(signalId), { method: 'DELETE', credentials: 'include' });
      router.push(SOS_PAGE_PATH);
    } catch (caught) {
      setFailure(caught instanceof ApiClientError ? caught.message : FAILED_MESSAGE);
      setBusy(false);
    }
  }

  if (missing) {
    return (
      <>
        <header className={styles.pageHead}>
          <h1 className={styles.pageTitle}>No such prayer request</h1>
          <p className={styles.pageLead}>It may have been removed.</p>
        </header>
        <Link className={styles.link} href={SOS_PAGE_PATH}>
          Back to the board
        </Link>
      </>
    );
  }

  if (signal === null) {
    return failure === null ? (
      <p className={styles.quiet}>Loading…</p>
    ) : (
      <p className={styles.failure} role="alert">
        {failure}
      </p>
    );
  }

  const open = signal.closedAt === null;
  const mayClose = open && (signal.mine || canModerate);

  return (
    <>
      <header className={styles.pageHead}>
        <div className={styles.signalHead}>
          <UrgencyDot urgency={signal.urgency} />
          <h1 className={styles.pageTitle}>{SOS_URGENCY_LABEL[signal.urgency]} prayer request</h1>
          <span className={styles.status}>{open ? 'Open' : 'Resolved'}</span>
        </div>
        <p className={styles.pageLead}>{SOS_URGENCY_MEANING[signal.urgency]}</p>
      </header>

      <section className={styles.card} aria-label="The prayer request">
        <AuthorLine author={signal.author} at={signal.raisedAt} />
        <p className={styles.text}>{signal.description}</p>
        {signal.closedAt === null ? null : (
          <>
            <p className={styles.when}>Resolved {whenRaised(signal.closedAt)}</p>
            {signal.closingNote === null ? null : (
              <p className={styles.closingNote}>{signal.closingNote}</p>
            )}
          </>
        )}

        <div className={styles.prayingRow}>
          <button
            className={styles.praying}
            type="button"
            aria-pressed={signal.praying}
            disabled={busy || !open}
            onClick={() =>
              void write(sosPrayingPath(signalId), { method: signal.praying ? 'DELETE' : 'PUT' })
            }
          >
            🙏 {signal.praying ? 'Praying' : 'I am praying'}
          </button>
          {signal.prayingCount === 0 ? null : (
            <span className={styles.prayingCount}>
              {signal.prayingCount === 1 ? '1 member praying' : `${signal.prayingCount} members praying`}
            </span>
          )}
        </div>
        {signal.prayingNames.length === 0 ? null : (
          <p className={styles.names} aria-label="Who is praying">
            {signal.prayingNames.join(', ')}
          </p>
        )}
      </section>

      {failure === null ? null : (
        <p className={styles.failure} role="alert">
          {failure}
        </p>
      )}

      <section className={styles.card} aria-label="Replies">
        <h2 className={styles.sectionTitle}>
          {signal.replies.length === 0
            ? 'No replies yet'
            : signal.replies.length === 1
              ? '1 reply'
              : `${signal.replies.length} replies`}
        </h2>
        {signal.replies.length === 0 ? null : (
          <ul className={styles.replies}>
            {signal.replies.map((reply) => (
              <li className={styles.reply} key={reply.id}>
                <ReplyBlock
                  reply={reply}
                  busy={busy}
                  canModerate={canModerate}
                  onRemove={() => void removeReply(reply)}
                  action={
                    open && !termsNeeded && answering !== reply.id ? (
                      <button
                        className={styles.quietAction}
                        type="button"
                        disabled={busy}
                        onClick={() => setAnswering(reply.id)}
                      >
                        Reply
                      </button>
                    ) : null
                  }
                />
                {reply.replies.length === 0 && answering !== reply.id ? null : (
                  <ul className={styles.thread} aria-label={`Replies to ${reply.author.displayName}`}>
                    {reply.replies.map((answer) => (
                      <li className={styles.threadReply} key={answer.id}>
                        <ReplyBlock
                          reply={answer}
                          busy={busy}
                          canModerate={canModerate}
                          onRemove={() => void removeReply(answer)}
                          action={null}
                        />
                      </li>
                    ))}
                    {answering === reply.id ? (
                      <li className={styles.threadReply}>
                        <ReplyForm
                          busy={busy}
                          label={`Reply to ${reply.author.displayName}`}
                          onCancel={() => setAnswering(null)}
                          onSend={(text) => sendReply(text, reply.id)}
                        />
                      </li>
                    ) : null}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        {termsNeeded ? (
          <TermsPrompt onAccepted={() => setTermsNeeded(false)} onDismiss={() => setTermsNeeded(false)} />
        ) : open ? (
          <ReplyForm
            busy={busy}
            label="A word of encouragement or scripture"
            onSend={(text) => sendReply(text, null)}
          />
        ) : (
          <p className={styles.quiet}>This prayer request has been resolved. Replies are closed.</p>
        )}
      </section>

      {mayClose || canModerate ? (
        <section className={styles.card} aria-label="Ending the prayer request">
          {mayClose ? (
            <CloseForm
              busy={busy}
              withNote={signal.mine}
              onClose={(note) =>
                write(sosClosePath(signalId), {
                  method: 'POST',
                  body: { note } satisfies CloseSosRequest,
                })
              }
            />
          ) : null}
          {canModerate ? (
            <button
              className={`${styles.secondary} ${styles.raiseFull}`}
              type="button"
              disabled={busy}
              onClick={() => void remove()}
            >
              Remove prayer request
            </button>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

/** One reply as drawn — who, when, the text, and the quiet actions at the right: Reply and Remove. */
function ReplyBlock({
  reply,
  busy,
  canModerate,
  action,
  onRemove,
}: {
  reply: SosReplyView;
  busy: boolean;
  canModerate: boolean;
  action: ReactNode;
  onRemove: () => void;
}) {
  return (
    <>
      <div className={styles.replyHead}>
        <AuthorLine author={reply.author} at={reply.createdAt} />
        <span className={styles.replyActions}>
          {action}
          {reply.mine || canModerate ? (
            <button className={styles.quietAction} type="button" disabled={busy} onClick={onRemove}>
              Remove
            </button>
          ) : null}
        </span>
      </div>
      <p className={styles.text}>{reply.text}</p>
    </>
  );
}

function ReplyForm({
  busy,
  label,
  onSend,
  onCancel,
}: {
  busy: boolean;
  label: string;
  onSend: (text: string) => Promise<boolean>;
  /** Present on the inline box inside a thread, which can be closed again unsent. */
  onCancel?: () => void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const count = text.trim().length;
  const over = count > MAX_SOS_REPLY_LENGTH;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || count === 0 || over) return;
    if (await onSend(text.trim())) setText('');
  }

  return (
    <form className={styles.field} onSubmit={onSubmit} aria-label={label}>
      <label className={styles.fieldLabel} htmlFor={id}>
        {label}
      </label>
      <textarea
        className={styles.textArea}
        id={id}
        rows={3}
        value={text}
        placeholder="Everybody will read it."
        autoFocus={onCancel !== undefined}
        onChange={(event) => setText(event.target.value)}
      />
      <p className={over ? styles.countOver : styles.count}>
        {over
          ? `${MAX_SOS_REPLY_LENGTH} characters maximum.`
          : `${count} / ${MAX_SOS_REPLY_LENGTH}`}
      </p>
      <div className={styles.actions}>
        <button className={styles.primary} type="submit" disabled={busy || count === 0 || over}>
          Reply
        </button>
        {onCancel === undefined ? null : (
          <button className={styles.secondary} type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function CloseForm({
  busy,
  withNote,
  onClose,
}: {
  busy: boolean;
  withNote: boolean;
  onClose: (note: string | null) => Promise<boolean>;
}) {
  const id = useId();
  const [opened, setOpened] = useState(false);
  const [note, setNote] = useState('');
  const count = note.trim().length;
  const over = count > MAX_SOS_CLOSING_NOTE_LENGTH;

  if (!opened) {
    return (
      <button
        className={`${styles.secondary} ${styles.raiseFull}`}
        type="button"
        disabled={busy}
        onClick={() => setOpened(true)}
      >
        Close this prayer request
      </button>
    );
  }

  return (
    <form
      className={styles.field}
      aria-label="Close this prayer request"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || over) return;
        void onClose(withNote && count > 0 ? note.trim() : null);
      }}
    >
      <h2 className={styles.sectionTitle}>Close this prayer request</h2>
      {withNote ? (
        <>
          <label className={styles.fieldLabel} htmlFor={id}>
            Closing note (optional)
          </label>
          <textarea
            className={styles.textArea}
            id={id}
            rows={3}
            value={note}
            placeholder="How did it go? What should the group know?"
            onChange={(event) => setNote(event.target.value)}
          />
          <p className={over ? styles.countOver : styles.count}>
            {over
              ? `${MAX_SOS_CLOSING_NOTE_LENGTH} characters maximum.`
              : `${count} / ${MAX_SOS_CLOSING_NOTE_LENGTH}`}
          </p>
        </>
      ) : (
        <p className={styles.quiet}>The prayer request moves to the resolved list. The replies stay with it.</p>
      )}
      <div className={styles.actions}>
        <button className={styles.primary} type="submit" disabled={busy || over}>
          Mark as resolved
        </button>
        <button className={styles.secondary} type="button" disabled={busy} onClick={() => setOpened(false)}>
          Keep it open
        </button>
      </div>
    </form>
  );
}
