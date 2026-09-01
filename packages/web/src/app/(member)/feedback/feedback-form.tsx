'use client';

import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import {
  DASHBOARD_PAGE_PATH,
  FEEDBACK_KINDS,
  FEEDBACK_PATH,
  MAX_FEEDBACK_DESCRIPTION_LENGTH,
  MAX_FEEDBACK_TITLE_LENGTH,
  feedbackKindHint,
  feedbackKindLabel,
  type FeedbackKind,
  type FeedbackSubmittedPayload,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from './feedback.module.css';

/**
 * **The report form** — a title, a description, and which of the two it is.
 *
 * Three decisions, and each is about the same thing: a member has just hit something broken, and
 * this screen should not be the second broken thing they hit.
 *
 * 1. **The text survives every refusal.** Nothing below clears a field on a failure, so a report
 *    the server would not take costs a press rather than a paragraph — the rule the note composer
 *    already holds, for the same reason. It is cleared exactly once, after a send that worked.
 * 2. **The refusal is the API's own sentence when the API had one.** An over-long title and a mail
 *    provider that is down are different problems with different answers, and a single "something
 *    went wrong" would hide which of them the member is looking at.
 * 3. **The toggle is two labelled buttons rather than a switch.** A switch has an off state, and
 *    neither of these is the absence of the other; the labels say in words which is which, and the
 *    line beneath says what each one means.
 *
 * Every rule this applies — both ceilings, both fields non-empty, a real kind — is applied again by
 * the API independently. The disabled submit is a courtesy; the limit is the server's.
 */

/**
 * When the description's count appears.
 *
 * Not a fraction of the ceiling, on the same reasoning the note composer's threshold is not: the
 * rule is a number of characters, and deriving it would make changing the ceiling silently move
 * where the warning starts.
 */
const COUNT_APPEARS_FROM = 3_600;

const CEILING_LABEL = MAX_FEEDBACK_DESCRIPTION_LENGTH.toLocaleString('en-GB');

/** What a member reads when the send failed for a reason the API did not put into words. */
const SEND_FAILED_MESSAGE =
  'Could not send your report. Your text is still here — try again in a moment.';

export function FeedbackForm() {
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();

  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Counted after trimming on both fields, so padding cannot push a real report over a ceiling and
  // a box holding nothing but spaces is a box holding nothing — exactly what the API measures.
  const titleCount = title.trim().length;
  const descriptionCount = description.trim().length;
  const overLimit =
    titleCount > MAX_FEEDBACK_TITLE_LENGTH || descriptionCount > MAX_FEEDBACK_DESCRIPTION_LENGTH;
  const incomplete = titleCount === 0 || descriptionCount === 0;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (sending || incomplete || overLimit) return;
    setSending(true);
    setFailure(null);

    try {
      await apiFetch<FeedbackSubmittedPayload>(FEEDBACK_PATH, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, title: title.trim(), description: description.trim() }),
      });
      setTitle('');
      setDescription('');
      setSent(true);
    } catch (caught) {
      // The API's own sentence when it had one: it knows whether this was an over-long title or a
      // provider that is down, and it says so in words a member can act on.
      setFailure(caught instanceof ApiClientError ? caught.message : SEND_FAILED_MESSAGE);
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <>
        <header className={styles.pageHead}>
          <h1 className={styles.pageTitle}>Thank you</h1>
          <p className={styles.pageLead}>Your report is on its way.</p>
        </header>
        <section className={styles.card}>
          <p className={styles.prose}>
            Somebody will read it. There is no reply to wait for here — if it needs one, it will come
            to the address you sign in with.
          </p>
          <div className={styles.actions}>
            <button className={styles.secondary} type="button" onClick={() => setSent(false)}>
              Send another
            </button>
            <Link className={styles.link} href={DASHBOARD_PAGE_PATH}>
              Back to the dashboard
            </Link>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <header className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Report a bug or send feedback</h1>
        <p className={styles.pageLead}>
          Tell us what happened and it goes straight to whoever maintains this.
        </p>
      </header>

      <form className={styles.card} onSubmit={onSubmit} aria-label="Report a bug or send feedback">
        {/*
          Rendered from the vocabulary rather than from two hand-written buttons: the labels, the
          hints and the values are declared once in `@thp/shared`, so the toggle cannot come to
          disagree with the subject line the message goes out under.
        */}
        <div className={styles.kinds} role="group" aria-label="What kind of report is this">
          {FEEDBACK_KINDS.map((one) => (
            <button
              key={one}
              className={styles.kindOption}
              type="button"
              aria-pressed={kind === one}
              onClick={() => setKind(one)}
            >
              {feedbackKindLabel(one)}
            </button>
          ))}
        </div>
        <p className={styles.kindHint}>{feedbackKindHint(kind)}</p>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={titleId}>
            Title
          </label>
          <input
            className={styles.input}
            id={titleId}
            name="title"
            type="text"
            maxLength={MAX_FEEDBACK_TITLE_LENGTH}
            autoComplete="off"
            placeholder={
              kind === 'bug' ? 'What goes wrong, in a line?' : 'What would you change, in a line?'
            }
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={descriptionId}>
            Description
          </label>
          <textarea
            className={styles.textArea}
            id={descriptionId}
            name="description"
            rows={8}
            placeholder={
              kind === 'bug'
                ? 'What were you doing, what did you expect, and what happened instead?'
                : 'What is on your mind?'
            }
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            {...(failure === null ? {} : { 'aria-describedby': errorId })}
          />
          {descriptionCount < COUNT_APPEARS_FROM ? null : (
            <p
              className={
                descriptionCount > MAX_FEEDBACK_DESCRIPTION_LENGTH ? styles.countOver : styles.count
              }
            >
              {descriptionCount > MAX_FEEDBACK_DESCRIPTION_LENGTH
                ? `${CEILING_LABEL} characters maximum.`
                : `${descriptionCount.toLocaleString('en-GB')} / ${CEILING_LABEL}`}
            </p>
          )}
        </div>

        {failure === null ? null : (
          <p className={styles.failure} id={errorId} role="alert">
            {failure}
          </p>
        )}

        <div className={styles.actions}>
          <button
            className={styles.primary}
            type="submit"
            disabled={incomplete || overLimit || sending}
          >
            {sending ? 'Sending…' : 'Send report'}
          </button>
        </div>
      </form>
    </>
  );
}
