'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import {
  MAX_STEERING_PROMPT_LENGTH,
  REVIEWS_PATH,
  REVIEW_FIELD,
  REVIEW_KIND_LABEL,
  REVIEW_RECORDING_PARAM,
  formatCitation,
  reviewPath,
  reviewRegeneratePath,
  type ReviewItemView,
  type ReviewListPayload,
  type ScriptureCitation,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from './reviews.module.css';

/**
 * The queue, and the form over one item of it.
 *
 * A client module. It imports no server module, holds no database access, and calls the absolute
 * API origin like every other call the client makes. Four decisions worth stating:
 *
 * 1. **Nothing here branches on `kind`.** A row renders `fields` and `provenance`, whatever they
 *    hold, and the labels come from one map in `@thp/shared`. A later epic's scripture references
 *    or tags arrive as a value of the enum and this file does not change — which is the property
 *    the single-table review gate exists to buy, and it is only real if the screen has it too.
 * 2. **The draft is shown in full, in a textarea.** Plain text with line breaks is sufficient
 *    (docs/project/prd.md, 3.6.8), so there is no toolbar, no markdown rendering and no formatting
 *    control — and the same box the admin reads in is the one they edit in, because a separate
 *    "edit" mode is a click between reading something and fixing it.
 * 3. **The four actions are what an admin can do to a draft** — approve it, approve their edit of
 *    it, ask for another, or throw it away (3.6.6–3.6.10). Discard takes a confirming press;
 *    approve and regenerate do not. The same line the other panels draw: the direction that
 *    destroys something gets the second press.
 * 4. **A deep link opens the form.** The recordings row links here with `?recording=…`, which is
 *    docs/project/prd.md 3.6.4's "from the recording page" served without a per-recording admin
 *    page existing. Read from the URL once on mount rather than through a router hook, so the panel
 *    needs no Suspense boundary around it.
 */

/** One fixed rendering of a date, so a console read in two places says the same thing. */
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function formatDay(iso: string): string {
  const parsed = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? iso : DAY.format(parsed);
}

/** Thousands separated, because a word count is read as a size rather than as a number. */
const COUNT = new Intl.NumberFormat('en-GB');

function describeFailure(caught: unknown): string {
  return caught instanceof ApiClientError
    ? caught.message
    : 'Could not reach the server. Check your connection and try again.';
}

/** What a field is called on screen, from the one map both kinds are described by. */
function labelFor(field: string): string {
  return field.charAt(0).toUpperCase() + field.slice(1);
}

export function ReviewsPanel() {
  const [reviews, setReviews] = useState<readonly ReviewItemView[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  /** The recording named in the URL, until the first load has had a chance to honour it. */
  const [wantedRecording, setWantedRecording] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiFetch<ReviewListPayload>(REVIEWS_PATH, { credentials: 'include' });
      // Rendered in the order the API sent, never re-sorted here: the query orders by the date
      // recorded, and a second ordering in the client is a second answer to "what is most recent".
      setReviews(payload.reviews);
      setListError(null);
    } catch (caught) {
      setReviews(null);
      setListError(describeFailure(caught));
    }
  }, []);

  useEffect(() => {
    const asked = new URLSearchParams(window.location.search).get(REVIEW_RECORDING_PARAM);
    setWantedRecording(asked);
    void load();
  }, [load]);

  // The deep link, honoured once the queue is in hand: the recording's first open draft is opened.
  useEffect(() => {
    if (wantedRecording === null || reviews === null) return;
    const found = reviews.find((one) => one.recordingId === wantedRecording);
    if (found) setOpenId(found.id);
    setWantedRecording(null);
  }, [wantedRecording, reviews]);

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-labelledby="reviews-heading">
        <div>
          <h2 className={styles.sectionTitle} id="reviews-heading">
            Pending Reviews
          </h2>
          <p className={styles.sectionNote}>
            Everything the machine has drafted and nobody has looked at yet, newest recording first.
            Nothing here is visible to a member. Approving a summary publishes the summary; the
            teaching itself goes live from the Recordings panel.
          </p>
        </div>

        {listError !== null ? (
          <p className={styles.failure} role="alert">
            {listError}
          </p>
        ) : reviews === null ? (
          <p className={styles.sectionNote}>Loading reviews…</p>
        ) : reviews.length === 0 ? (
          <p className={styles.empty}>
            Nothing is waiting. Drafts appear here once a recording has been transcribed.
          </p>
        ) : (
          <ul className={styles.list}>
            {reviews.map((item) => (
              <ReviewRow
                key={item.id}
                item={item}
                open={openId === item.id}
                onOpen={() => setOpenId(openId === item.id ? null : item.id)}
                onDone={async () => {
                  setOpenId(null);
                  await load();
                }}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** What the row is doing, so the buttons can say it and two presses cannot overlap. */
type Busy = 'approve' | 'discard' | 'regenerate' | null;

/**
 * One item: the recording it is about, the draft in full, and the four things that can be done to
 * it.
 */
function ReviewRow({
  item,
  open,
  onOpen,
  onDone,
}: {
  item: ReviewItemView;
  open: boolean;
  onOpen: () => void;
  onDone: () => Promise<void>;
}) {
  const promptId = useId();
  const spec = REVIEW_FIELD[item.kind];
  const field = spec.name;
  const [values, setValues] = useState<Record<string, string>>(() => ({
    [field]: typeof item.fields[field] === 'string' ? (item.fields[field] as string) : '',
  }));
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const citations = Array.isArray(item.fields[field])
    ? (item.fields[field] as readonly ScriptureCitation[])
    : [];
  // A list is read-only in this group, so nothing about it can have been edited. Task 2.1 is what
  // gives a list an edited state, and it is the same flag when it does.
  const edited =
    spec.shape === 'text' && (values[field] ?? '') !== (item.fields[field] ?? '');

  async function send(what: Busy, path: string, body: unknown): Promise<void> {
    if (busy !== null) return;
    setBusy(what);
    setNote(null);
    setConfirmingDiscard(false);
    try {
      await apiFetch(path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      await onDone();
    } catch (caught) {
      // What was typed stays exactly where it is: being refused should cost the press and nothing
      // else. The queue is not reloaded, because nothing changed.
      setNote(describeFailure(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className={styles.listRow}>
      <div className={styles.rowIdentity}>
        <p className={styles.rowName}>{item.recordingTitle}</p>
        <p className={styles.rowMeta}>
          Recorded <time dateTime={item.recordedAt}>{formatDay(item.recordedAt)}</time> ·{' '}
          {COUNT.format(item.wordCount)} words
        </p>
      </div>

      <div className={styles.rowControls}>
        <span className={styles.chip}>{REVIEW_KIND_LABEL[item.kind]}</span>
        <button className={styles.action} type="button" onClick={onOpen}>
          {open ? 'Close' : 'Review'}
        </button>
      </div>

      {open ? (
        <div className={styles.form}>
          <div className={styles.field}>
            {/*
              A label for a control, a plain caption for a list — there is nothing focusable behind
              a read-only list, and `htmlFor` pointing at nothing is worse for a screen reader than
              not saying it. The list names itself through `aria-labelledby` instead.
            */}
            {spec.shape === 'list' ? (
              <p className={styles.label} id={`${promptId}-draft`}>
                {labelFor(field)}
              </p>
            ) : (
              <label className={styles.label} htmlFor={`${promptId}-draft`}>
                {labelFor(field)}
              </label>
            )}
            {/*
              **The draft, rendered by what shape its field is** — not by which kind it is
              (1.5.1). A paragraph gets the box it is edited in; a list gets a list. Tags and mind
              maps arrive as a third shape and a third arm here, rather than as a branch naming an
              artefact.

              Nothing truncates a paragraph: an admin cannot judge a summary they can only see the
              first line of, which is the whole of 3.6.5.
            */}
            {spec.shape === 'list' ? (
              <CitationList citations={citations} labelledBy={`${promptId}-draft`} />
            ) : (
              <textarea
                className={styles.textarea}
                id={`${promptId}-draft`}
                name={field}
                rows={item.kind === 'summary' ? 14 : 4}
                disabled={busy !== null}
                value={values[field] ?? ''}
                onChange={(event) => setValues({ ...values, [field]: event.target.value })}
              />
            )}
            <p className={styles.provenance}>
              Drafted by {item.provenance.model} ({item.provenance.modelVersion}), prompt{' '}
              {item.provenance.promptVersion}
              {item.provenance.steeringPrompt === null
                ? ''
                : ` · asked for again: “${item.provenance.steeringPrompt}”`}
              {edited ? ' · edited' : ''}
            </p>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${promptId}-steer`}>
              Ask for another (optional)
            </label>
            <input
              className={styles.input}
              id={`${promptId}-steer`}
              name="prompt"
              type="text"
              autoComplete="off"
              maxLength={MAX_STEERING_PROMPT_LENGTH}
              placeholder="Say what the draft missed"
              disabled={busy !== null}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </div>

          <div className={styles.formActions}>
            <button
              className={styles.submit}
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void send(
                  'approve',
                  reviewPath(item.id),
                  // A list is approved whole and as it stands: there is nothing to send back
                  // because there was nothing to edit (1.5.4).
                  spec.shape === 'list'
                    ? { action: 'approve' }
                    : { action: 'approve', fields: { [field]: values[field] ?? '' } },
                )
              }
            >
              {busy === 'approve' ? 'Approving…' : edited ? 'Approve with edits' : 'Approve'}
            </button>

            <button
              className={styles.action}
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void send(
                  'regenerate',
                  reviewRegeneratePath(item.id),
                  prompt.trim() === '' ? {} : { prompt: prompt.trim() },
                )
              }
            >
              {busy === 'regenerate' ? 'Queueing…' : 'Regenerate'}
            </button>

            <button
              className={styles.action}
              type="button"
              disabled={busy !== null}
              onClick={() =>
                confirmingDiscard
                  ? void send('discard', reviewPath(item.id), { action: 'discard' })
                  : setConfirmingDiscard(true)
              }
            >
              {busy === 'discard' ? 'Discarding…' : 'Discard'}
            </button>
          </div>

          {/*
            The confirming press, and only for the direction that throws something away. It says
            what is lost and what is not — the recording stays publishable either way, which is the
            fact an admin hesitating over this button actually needs (3.6.10).
          */}
          {confirmingDiscard ? (
            <div className={styles.confirm}>
              <p className={styles.confirmText}>
                Discard this {REVIEW_KIND_LABEL[item.kind].toLowerCase()}? Nothing is published from
                it, and the recording can still go live without one.
              </p>
              <div className={styles.confirmActions}>
                <button
                  className={styles.actionStrong}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void send('discard', reviewPath(item.id), { action: 'discard' })}
                >
                  Yes, discard it
                </button>
                <button
                  className={styles.action}
                  type="button"
                  onClick={() => setConfirmingDiscard(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {note === null ? null : (
            <p className={styles.rowRefusal} role="alert">
              {note}
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}

/**
 * **A list-shaped draft: one row per citation** (1.5.1).
 *
 * Read-only here. Editing a row, removing one and adding one the machine missed are Task 2.1 and
 * Task 2.2, and the verse text beneath each citation is Task 3.3 — this is the list, and the two
 * presses under it are the ones the form already had.
 *
 * **An empty list says so in words** (1.5.3). An empty box would read as a draft that failed;
 * what actually happened is that the machine read the teaching and found no scripture in it, and
 * an admin approving that is recording a fact rather than accepting a blank.
 */
function CitationList({
  citations,
  labelledBy,
}: {
  citations: readonly ScriptureCitation[];
  labelledBy: string;
}) {
  if (citations.length === 0) {
    return (
      <p className={styles.empty}>
        The machine found no scripture in this teaching. Approving records that; discarding leaves
        the teaching without a reviewed list.
      </p>
    );
  }

  return (
    <ul className={styles.citations} aria-labelledby={labelledBy}>
      {citations.map((citation) => (
        <li className={styles.citation} key={`${citation.book}-${citation.chapter}-${citation.verseStart}-${citation.verseEnd}`}>
          {formatCitation(citation)}
        </li>
      ))}
    </ul>
  );
}
