'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import {
  BIBLE_BOOKS,
  MAX_STEERING_PROMPT_LENGTH,
  REVIEWS_PATH,
  REVIEW_FIELD,
  REVIEW_KIND_LABEL,
  REVIEW_RECORDING_PARAM,
  checkCitation,
  citationKey,
  citationsEqual,
  findBook,
  formatCitation,
  reviewPath,
  reviewRegeneratePath,
  type CitationCheck,
  type ReviewItemView,
  type ReviewListPayload,
  type ScriptureCitation,
  type SubmittedReference,
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

/**
 * **One row of a list-shaped draft, while an admin is working on it** (2.1.1).
 *
 * Held as the four things a citation is made of, each as the text of its own control, because that
 * is what the admin is editing — a half-typed chapter is not a number and a blank verse is not a
 * zero. It becomes a citation on the way out, through the same validator the worker and the API
 * use.
 *
 * `from` is **which proposal this row came from** — its index in the machine's list, or `null` for
 * one a person added. It is the only thing the form knows that the server cannot work out for
 * itself, and it is what separates 3.2.9's "edited by an admin" from its "added by one".
 */
interface DraftRow {
  /** Stable across edits, so React keeps the input an admin is typing in. */
  readonly key: string;
  readonly from: number | null;
  readonly book: string;
  readonly chapter: string;
  readonly verseStart: string;
  readonly verseEnd: string;
}

/** The machine's proposal, as rows an admin can take apart. */
function rowsFrom(citations: readonly ScriptureCitation[]): DraftRow[] {
  return citations.map((citation, index) => ({
    key: `proposed-${index}`,
    from: index,
    book: citation.book,
    chapter: String(citation.chapter),
    verseStart: String(citation.verseStart),
    verseEnd: String(citation.verseEnd),
  }));
}

/**
 * The citation a row currently names, or what is wrong with it — from the one validator, so the
 * screen and the server cannot disagree about what a citation is.
 *
 * A blank verse reads as the whole chapter, which is the only thing a blank can honestly mean
 * here. A blank chapter does not: it is refused, in the canon's own words.
 */
function checkRow(row: DraftRow): CitationCheck {
  return checkCitation({
    book: row.book,
    chapter: Number(row.chapter),
    verseStart: row.verseStart === '' ? null : Number(row.verseStart),
    verseEnd: row.verseEnd === '' ? null : Number(row.verseEnd),
  });
}

/**
 * What is wrong with each row, in the order they are shown (3.2.5).
 *
 * The canon's answer per row, plus the one thing only the list knows — that a passage is already
 * in it. Computed for the whole list on every keystroke rather than stored, so a row stops
 * complaining the moment the row above it changes.
 */
function problemsIn(rows: readonly DraftRow[]): (string | null)[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const checked = checkRow(row);
    if (!checked.ok) return checked.problem.message;

    const key = citationKey(checked.citation);
    if (seen.has(key)) return 'That passage is already in the list.';
    seen.add(key);
    return null;
  });
}

/** How a row reads — the citation once it is one, and a best effort while it is being typed. */
function labelOf(row: DraftRow): string {
  const checked = checkRow(row);
  if (checked.ok) return formatCitation(checked.citation);
  return `${findBook(row.book)?.name ?? row.book} ${row.chapter}`.trim();
}

/** Whether the admin has changed the list they were given (4.17.5). */
function listChanged(rows: readonly DraftRow[], proposed: readonly ScriptureCitation[]): boolean {
  if (rows.length !== proposed.length) return true;
  return rows.some((row, index) => {
    if (row.from !== index) return true;
    const checked = checkRow(row);
    const original = proposed[index];
    return !checked.ok || original === undefined || !citationsEqual(checked.citation, original);
  });
}

/** A row as the approve request carries it. */
function toSubmitted(row: DraftRow): SubmittedReference {
  return {
    book: row.book,
    chapter: Number(row.chapter),
    verseStart: row.verseStart === '' ? null : Number(row.verseStart),
    verseEnd: row.verseEnd === '' ? null : Number(row.verseEnd),
    from: row.from,
  };
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
  const proposed = Array.isArray(item.fields[field])
    ? (item.fields[field] as readonly ScriptureCitation[])
    : [];
  const [values, setValues] = useState<Record<string, string>>(() => ({
    [field]: typeof item.fields[field] === 'string' ? (item.fields[field] as string) : '',
  }));
  const [rows, setRows] = useState<DraftRow[]>(() => rowsFrom(proposed));
  /** How many rows this admin has added, so an added row's key is its own. */
  const [addedCount, setAddedCount] = useState(0);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const problems = spec.shape === 'list' ? problemsIn(rows) : [];
  const edited =
    spec.shape === 'list'
      ? listChanged(rows, proposed)
      : (values[field] ?? '') !== (item.fields[field] ?? '');

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

  /**
   * Approve — the whole draft, in whatever shape it is.
   *
   * A list holding a refusal is not sent at all: the row already says what is wrong with it
   * (3.2.5), and a press that produced a 400 saying the same thing would be a round trip to learn
   * what is on the screen.
   */
  function approve(): void {
    if (spec.shape !== 'list') {
      void send('approve', reviewPath(item.id), {
        action: 'approve',
        fields: { [field]: values[field] ?? '' },
      });
      return;
    }
    if (problems.some((one) => one !== null)) {
      setNote('Put the reference the list is complaining about right before approving.');
      return;
    }
    void send('approve', reviewPath(item.id), {
      action: 'approve',
      fields: { [field]: rows.map(toSubmitted) },
    });
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
              A label for a control, a plain caption for a list — the list is a set of controls
              rather than one, and each row names its own. The list names itself through
              `aria-labelledby` instead.
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
              <CitationList
                rows={rows}
                problems={problems}
                labelledBy={`${promptId}-draft`}
                disabled={busy !== null}
                onChange={(index, patch) =>
                  setRows(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)))
                }
                onRemove={(index) => setRows(rows.filter((_, at) => at !== index))}
                onAdd={() => {
                  setRows([
                    ...rows,
                    {
                      key: `added-${addedCount}`,
                      // Nothing the machine proposed, which is what makes it a person's (3.2.9).
                      from: null,
                      // The first book of the canon and its first chapter: a real citation the
                      // admin corrects, rather than a blank the form has to have an opinion about.
                      book: BIBLE_BOOKS[0]?.id ?? '',
                      chapter: '1',
                      verseStart: '',
                      verseEnd: '',
                    },
                  ]);
                  setAddedCount(addedCount + 1);
                }}
              />
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
              onClick={() => approve()}
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
 * **A list-shaped draft: one row per citation, each one correctable** (1.5.1, 2.1.1, 2.2.1).
 *
 * Every row is the four things a citation is made of, as four controls — a book to pick, a
 * chapter, and the verses it runs between. Never a text box: a citation typed as prose is a
 * citation somebody has to parse back, which is the whole of what
 * [§ 6 Content integrity](docs/active-scope/prd.md) refuses.
 *
 * **A row is thrown out on one press.** Removing one is an edit to a draft that is not saved until
 * the admin approves, so the confirming press stays where it belongs — on discard, which is what
 * actually destroys something.
 *
 * **Every row says what is wrong with it, against itself** (3.2.5). The refusal lives inside the
 * row's own group, so a list of four with one bad chapter reads as one bad row rather than as a
 * form that will not submit.
 *
 * **An empty list says so in words** (1.5.3). An empty box would read as a draft that failed; what
 * actually happened is that the machine read the teaching and found no scripture in it — and the
 * admin can still add what it missed, which is the only way [3.2.4](docs/active-scope/prd.md) is
 * reachable at all for such a teaching.
 */
function CitationList({
  rows,
  problems,
  labelledBy,
  disabled,
  onChange,
  onRemove,
  onAdd,
}: {
  rows: readonly DraftRow[];
  problems: readonly (string | null)[];
  labelledBy: string;
  disabled: boolean;
  onChange: (index: number, patch: Partial<DraftRow>) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
}) {
  return (
    <>
      {rows.length === 0 ? (
        <p className={styles.empty}>
          The machine found no scripture in this teaching. Approving records that; discarding leaves
          the teaching without a reviewed list.
        </p>
      ) : (
        <ul className={styles.citations} aria-labelledby={labelledBy}>
          {rows.map((row, index) => {
            const label = labelOf(row);
            return (
              <li className={styles.citation} key={row.key}>
                {/*
                  A group, named by the citation it currently reads as — so every control inside it
                  is "the chapter of Romans 8:1–4" rather than "a chapter" (§ 6 Accessibility), and
                  the name follows what the admin types.
                */}
                <fieldset className={styles.citationGroup} disabled={disabled}>
                  <legend className={styles.citationLegend}>{label}</legend>
                  <div className={styles.citationControls}>
                    <select
                      className={styles.select}
                      aria-label="Book"
                      value={row.book}
                      onChange={(event) => onChange(index, { book: event.target.value })}
                    >
                      {BIBLE_BOOKS.map((book) => (
                        <option key={book.id} value={book.id}>
                          {book.name}
                        </option>
                      ))}
                    </select>
                    <input
                      className={styles.number}
                      type="number"
                      min={1}
                      aria-label="Chapter"
                      value={row.chapter}
                      onChange={(event) => onChange(index, { chapter: event.target.value })}
                    />
                    <input
                      className={styles.number}
                      type="number"
                      min={1}
                      aria-label="First verse"
                      value={row.verseStart}
                      onChange={(event) => onChange(index, { verseStart: event.target.value })}
                    />
                    <input
                      className={styles.number}
                      type="number"
                      min={1}
                      aria-label="Last verse"
                      value={row.verseEnd}
                      onChange={(event) => onChange(index, { verseEnd: event.target.value })}
                    />
                    <button
                      className={styles.action}
                      type="button"
                      aria-label={`Remove ${label}`}
                      onClick={() => onRemove(index)}
                    >
                      Remove
                    </button>
                  </div>
                  {problems[index] === undefined || problems[index] === null ? null : (
                    <p className={styles.rowRefusal} role="alert">
                      {problems[index]}
                    </p>
                  )}
                </fieldset>
              </li>
            );
          })}
        </ul>
      )}

      <div className={styles.citationAdd}>
        <button className={styles.action} type="button" disabled={disabled} onClick={onAdd}>
          Add a reference
        </button>
      </div>
    </>
  );
}
