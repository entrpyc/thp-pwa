'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import {
  ADMIN_REVIEWS_PAGE_PATH,
  MAX_RECORDING_DESCRIPTION_LENGTH,
  REVIEW_RECORDING_PARAM,
  chapterQuestionPath,
  recordingChaptersPath,
  recordingPath,
  recordingPublishPath,
  recordingSeriesPath,
  recordingSummaryPath,
  recordingSummaryUnpublishPath,
  recordingTagsPath,
  recordingUnpublishPath,
  type ChapterView,
  type ChaptersPayload,
  type RecordingSummary,
  type SeriesView,
  type TagView,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { DateField } from '../date-field';
import { PipelinePanel } from '../pipeline/pipeline-panel';
import { ReviewsPanel } from '../reviews/reviews-panel';
import { TagEditor } from '../tag-editor';
import styles from './recording-editor.module.css';

/**
 * **Everything an admin does to one teaching, in one place.**
 *
 * The row in the list says four things and offers two presses; this is where the rest went. It is
 * a modal over the list rather than a page, because an admin working the list opens one teaching,
 * fixes what is wrong, and goes back to the list — and a page would make that a navigation with a
 * back button to find.
 *
 * What is here, and how each thing saves:
 *
 * - **Title, date recorded, description** — one *Save details* press, one `PATCH` of the row.
 * - **Series** and **tags** — saved on change, as they were on the row: one press per decision.
 * - **Summary** — the live one is edited in place (`PUT …/summary`) or sent back to draft; where
 *   there is no live summary the editor says where it is and links there.
 * - **Reflection questions** — one per chapter, each saved on its own (`PUT /chapters/:id/question`).
 * - **Pipeline** and **pending reviews** — the two console panels, filtered to this recording and
 *   rendered without their own headings. Every control on them works here as it does there.
 * - **Publish / Unpublish** and **Delete** — the two gates, each the confirming kind in the
 *   direction that takes something away.
 *
 * The modal holds nothing the API does not: every write here is a route that refuses a member
 * on its own, and the dialog closing is the one thing that happens without asking the server.
 */

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function formatDay(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : DAY.format(parsed);
}

function describeFailure(caught: unknown): string {
  return caught instanceof ApiClientError
    ? caught.message
    : 'Could not reach the server. Check your connection and try again.';
}

type Busy =
  | 'details'
  | 'series'
  | 'summary'
  | 'summaryDown'
  | 'publish'
  | 'unpublish'
  | 'delete'
  | `question:${string}`
  | null;

export function RecordingEditor({
  entry,
  series,
  tags,
  translation,
  onChanged,
  onClose,
  onDeleted,
}: {
  entry: RecordingSummary;
  series: readonly SeriesView[];
  tags: readonly TagView[];
  translation: string;
  onChanged: () => Promise<void>;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const titleId = useId();
  const headingId = useId();
  const dateId = useId();
  const descriptionId = useId();
  const summaryId = useId();
  const seriesId = useId();

  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'unpublish' | 'delete' | null>(null);

  // Seeded once, when the editor opens on this recording. A reload that lands while somebody is
  // typing must not overwrite what they typed; *Save* is what brings the two back together.
  const [titleDraft, setTitleDraft] = useState(entry.title);
  const [dateDraft, setDateDraft] = useState(entry.recordedAt);
  const [descriptionDraft, setDescriptionDraft] = useState(entry.description ?? '');
  const [summaryDraft, setSummaryDraft] = useState(entry.summary ?? '');

  const [chapters, setChapters] = useState<readonly ChapterView[] | null>(null);
  const [chaptersError, setChaptersError] = useState<string | null>(null);
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({});

  const live = entry.publishedAt !== null;

  const loadChapters = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiFetch<ChaptersPayload>(recordingChaptersPath(entry.id), {
        credentials: 'include',
      });
      setChapters(payload.chapters);
      setChaptersError(null);
      setQuestionDrafts((current) => {
        const next = { ...current };
        for (const chapter of payload.chapters) {
          if (next[chapter.id] === undefined) next[chapter.id] = chapter.question ?? '';
        }
        return next;
      });
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.status === 404) {
        // Nothing to read is not a failure to read: a teaching with no chapters has no questions.
        setChapters([]);
        setChaptersError(null);
        return;
      }
      setChapters(null);
      setChaptersError(describeFailure(caught));
    }
  }, [entry.id]);

  useEffect(() => {
    void loadChapters();
  }, [loadChapters]);

  // The page behind the modal stays where it is, and Escape is the way out that needs no mouse.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  async function send(
    what: Busy,
    path: string,
    init: RequestInit,
    said: string,
    after?: () => Promise<void>,
  ): Promise<boolean> {
    if (busy !== null) return false;
    setBusy(what);
    setNote(null);
    setDone(null);
    setConfirming(null);
    try {
      await apiFetch(path, { credentials: 'include', ...init });
      await (after ?? onChanged)();
      setDone(said);
      return true;
    } catch (caught) {
      setNote(describeFailure(caught));
      return false;
    } finally {
      setBusy(null);
    }
  }

  const POST = { method: 'POST' as const };
  const JSON_HEADERS = { 'content-type': 'application/json' };

  return (
    <div className={styles.scrim} onClick={onClose}>
      <div
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.head}>
          <div className={styles.headText}>
            <h2 className={styles.heading} id={headingId}>
              {entry.title}
            </h2>
            <p className={styles.headMeta}>
              Recorded <time dateTime={entry.recordedAt}>{formatDay(entry.recordedAt)}</time>
              {' · '}
              <span className={live ? styles.chipLive : styles.chip}>
                {live ? 'Live' : 'Not published'}
              </span>
            </p>
          </div>
          <button className={styles.close} type="button" aria-label="Close" onClick={onClose}>
            <span aria-hidden="true">×</span>
          </button>
        </header>

        {note === null ? null : (
          <p className={styles.refusal} role="alert">
            {note}
          </p>
        )}
        {done === null ? null : (
          <p className={styles.done} role="status">
            {done}
          </p>
        )}

        {/* ------------------------------------------------------------------ details */}
        <section className={styles.block} aria-labelledby={`${headingId}-details`}>
          <h3 className={styles.blockTitle} id={`${headingId}-details`}>
            Details
          </h3>
          <div className={styles.detailsRow}>
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
                disabled={busy !== null}
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
              />
            </div>
            <div className={styles.fieldTight}>
              <label className={styles.label} htmlFor={dateId}>
                Date recorded
              </label>
              <DateField
                id={dateId}
                name="recordedAt"
                label="Date recorded"
                disabled={busy !== null}
                value={dateDraft}
                onChange={setDateDraft}
              />
            </div>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={descriptionId}>
              Description
            </label>
            <textarea
              className={styles.textarea}
              id={descriptionId}
              name="description"
              rows={4}
              maxLength={MAX_RECORDING_DESCRIPTION_LENGTH}
              disabled={busy !== null}
              value={descriptionDraft}
              onChange={(event) => setDescriptionDraft(event.target.value)}
            />
            <p className={styles.hint}>
              What members read under the title. The machine's draft arrives through Pending
              Reviews; this is where it is rewritten afterwards.
            </p>
          </div>
          <div className={styles.actions}>
            <button
              className={styles.submit}
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void send(
                  'details',
                  recordingPath(entry.id),
                  {
                    method: 'PATCH',
                    headers: JSON_HEADERS,
                    body: JSON.stringify({
                      title: titleDraft,
                      recordedAt: dateDraft,
                      description: descriptionDraft,
                    }),
                  },
                  'Details saved.',
                )
              }
            >
              {busy === 'details' ? 'Saving…' : 'Save details'}
            </button>
          </div>
        </section>

        {/* -------------------------------------------------------- series and tags */}
        <section className={styles.block} aria-labelledby={`${headingId}-where`}>
          <h3 className={styles.blockTitle} id={`${headingId}-where`}>
            Series and tags
          </h3>
          <div className={styles.fieldTight}>
            <label className={styles.label} htmlFor={seriesId}>
              Series
            </label>
            <select
              className={styles.select}
              id={seriesId}
              name="seriesId"
              aria-label={`Series for ${entry.title}`}
              disabled={busy !== null}
              value={entry.series?.id ?? ''}
              onChange={(event) =>
                void send(
                  'series',
                  recordingSeriesPath(entry.id),
                  {
                    method: 'PUT',
                    headers: JSON_HEADERS,
                    body: JSON.stringify({
                      seriesId: event.target.value === '' ? null : event.target.value,
                    }),
                  },
                  'Series saved.',
                )
              }
            >
              <option value="">No series</option>
              {series.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.title}
                </option>
              ))}
            </select>
          </div>
          <TagEditor
            tags={entry.tags}
            suggestions={tags}
            path={recordingTagsPath(entry.id)}
            subject={entry.title}
            disabled={busy !== null}
            onChanged={onChanged}
          />
        </section>

        {/* ------------------------------------------------------------------ summary */}
        <section className={styles.block} aria-labelledby={`${headingId}-summary`}>
          <h3 className={styles.blockTitle} id={`${headingId}-summary`}>
            Summary
          </h3>
          {entry.summary === null ? (
            <p className={styles.hint}>
              {live
                ? 'No summary is live for this teaching. Approve its draft under Pending reviews below, or in '
                : 'The summary becomes editable here once it is approved and the teaching is live. Until then it is drafted and approved under Pending reviews below, or in '}
              <a
                className={styles.link}
                href={`${ADMIN_REVIEWS_PAGE_PATH}?${REVIEW_RECORDING_PARAM}=${entry.id}`}
              >
                Review drafts
              </a>
              .
            </p>
          ) : (
            <>
              <div className={styles.field}>
                <label className={styles.label} htmlFor={summaryId}>
                  Summary
                </label>
                <textarea
                  className={styles.textarea}
                  id={summaryId}
                  name="content"
                  rows={8}
                  disabled={busy !== null}
                  value={summaryDraft}
                  onChange={(event) => setSummaryDraft(event.target.value)}
                />
              </div>
              <div className={styles.actions}>
                <button
                  className={styles.submit}
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    void send(
                      'summary',
                      recordingSummaryPath(entry.id),
                      {
                        method: 'PUT',
                        headers: JSON_HEADERS,
                        body: JSON.stringify({ content: summaryDraft }),
                      },
                      'Summary saved. It is still live.',
                    )
                  }
                >
                  {busy === 'summary' ? 'Saving…' : 'Save summary'}
                </button>
                <button
                  className={styles.action}
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    void send(
                      'summaryDown',
                      recordingSummaryUnpublishPath(entry.id),
                      POST,
                      'The summary is back in draft. The teaching is still live.',
                    )
                  }
                >
                  {busy === 'summaryDown' ? 'Taking down…' : 'Summary to draft'}
                </button>
              </div>
            </>
          )}
        </section>

        {/* ------------------------------------------------------- reflection questions */}
        <section className={styles.block} aria-labelledby={`${headingId}-questions`}>
          <h3 className={styles.blockTitle} id={`${headingId}-questions`}>
            Reflection questions
          </h3>
          {chaptersError !== null ? (
            <p className={styles.refusal} role="alert">
              {chaptersError}
            </p>
          ) : chapters === null ? (
            <p className={styles.hint}>Loading chapters…</p>
          ) : chapters.length === 0 ? (
            <p className={styles.hint}>
              {live
                ? 'This teaching has no chapters, so there are no questions to edit. They are written by the pipeline once chapters exist.'
                : 'Chapters ride the teaching’s publication, so its reflection questions appear here once it is published.'}
            </p>
          ) : (
            <ul className={styles.questions} aria-label="Reflection questions by chapter">
              {chapters.map((chapter) => {
                const key = `question:${chapter.id}` as const;
                const draft = questionDrafts[chapter.id] ?? '';
                return (
                  <li key={chapter.id} className={styles.question}>
                    <label className={styles.label} htmlFor={`${headingId}-q-${chapter.id}`}>
                      {chapter.title}
                    </label>
                    <textarea
                      className={styles.textarea}
                      id={`${headingId}-q-${chapter.id}`}
                      rows={2}
                      disabled={busy !== null}
                      value={draft}
                      placeholder={chapter.question === null ? 'Not written yet' : undefined}
                      onChange={(event) =>
                        setQuestionDrafts((current) => ({
                          ...current,
                          [chapter.id]: event.target.value,
                        }))
                      }
                    />
                    <div className={styles.actions}>
                      <button
                        className={styles.action}
                        type="button"
                        disabled={busy !== null || draft.trim() === ''}
                        onClick={() =>
                          void send(
                            key,
                            chapterQuestionPath(chapter.id),
                            {
                              method: 'PUT',
                              headers: JSON_HEADERS,
                              body: JSON.stringify({ text: draft }),
                            },
                            `Question saved for “${chapter.title}”.`,
                            loadChapters,
                          )
                        }
                      >
                        {busy === key ? 'Saving…' : 'Save question'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* ----------------------------------------------------------------- pipeline */}
        <section className={styles.block} aria-labelledby={`${headingId}-pipeline`}>
          <h3 className={styles.blockTitle} id={`${headingId}-pipeline`}>
            Pipeline
          </h3>
          <PipelinePanel recordingId={entry.id} embedded />
        </section>

        {/* ---------------------------------------------------------- pending reviews */}
        <section className={styles.block} aria-labelledby={`${headingId}-reviews`}>
          <h3 className={styles.blockTitle} id={`${headingId}-reviews`}>
            Pending reviews
          </h3>
          <ReviewsPanel translation={translation} recordingId={entry.id} embedded />
        </section>

        {/* -------------------------------------------------------------- publication */}
        <section className={styles.block} aria-labelledby={`${headingId}-publication`}>
          <h3 className={styles.blockTitle} id={`${headingId}-publication`}>
            Publication
          </h3>
          <div className={styles.actions}>
            {live ? (
              <button
                className={styles.action}
                type="button"
                disabled={busy !== null}
                onClick={() => setConfirming('unpublish')}
              >
                {busy === 'unpublish' ? 'Taking down…' : 'Unpublish'}
              </button>
            ) : (
              <button
                className={styles.submit}
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void send('publish', recordingPublishPath(entry.id), POST, 'The teaching is live.')
                }
              >
                {busy === 'publish' ? 'Publishing…' : 'Publish'}
              </button>
            )}
            <button
              className={styles.actionDanger}
              type="button"
              disabled={busy !== null}
              onClick={() => setConfirming('delete')}
            >
              {busy === 'delete' ? 'Deleting…' : 'Delete recording'}
            </button>
          </div>

          {confirming === 'unpublish' ? (
            <div className={styles.confirm}>
              <p className={styles.confirmText}>
                Unpublish “{entry.title}”? Members stop seeing it immediately. Nothing is deleted —
                the summary, the transcript and everything else stay exactly as they are.
              </p>
              <div className={styles.confirmActions}>
                <button
                  className={styles.actionStrong}
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    void send(
                      'unpublish',
                      recordingUnpublishPath(entry.id),
                      POST,
                      'The teaching is no longer visible to members.',
                    )
                  }
                >
                  Yes, unpublish it
                </button>
                <button className={styles.action} type="button" onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {confirming === 'delete' ? (
            <div className={styles.confirm}>
              <p className={styles.confirmText}>
                Permanently delete “{entry.title}”? This cannot be undone. The audio, transcript,
                chapters, summary, scripture, mind map, and every member’s notes, highlights and
                positions on this teaching go with it. Unpublish instead if it may come back.
              </p>
              <div className={styles.confirmActions}>
                <button
                  className={styles.actionStrong}
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    void send(
                      'delete',
                      recordingPath(entry.id),
                      { method: 'DELETE' },
                      'Deleted.',
                      onDeleted,
                    )
                  }
                >
                  Yes, delete permanently
                </button>
                <button className={styles.action} type="button" onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
