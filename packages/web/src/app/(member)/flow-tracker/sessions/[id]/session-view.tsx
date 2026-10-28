'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  FLOW_RATINGS,
  FLOW_RATING_ENDS,
  FLOW_TRACKER_PAGE_PATH,
  FLOW_TRACKER_START_PAGE_PATH,
  chapterPagePath,
  flowSessionItemDonePath,
  flowSessionItemPath,
  flowSessionPath,
  formatTimecode,
  nextUnanswered,
  recordingPagePath,
  type AnswerFlowItemRequest,
  type FlowRating,
  type FlowReadingGroup,
  type FlowReadingRow,
  type FlowSessionItemView,
  type FlowSessionPayload,
  type FlowSessionView as Session,
  type FlowTeachingRef,
  type MarkFlowItemRequest,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { useBreadcrumbTrail, usePlayer, useTransportHidden } from '../../../player-context';
import { formatDay, listTitles, plural } from '../../format';
import styles from '../../flow-tracker.module.css';

/**
 * **One session** ([3.14.5](docs/project/prd.md)–[3.14.10](docs/project/prd.md)).
 *
 * While it runs: **one question per screen**. The teaching's cover, title and date; the chapter's
 * title and summary; the question; the scale of 1 to 5 as a row of radio buttons with its two ends
 * worded; a progress line. Choosing a rating sends it and moves on to the next unanswered question;
 * *Back* steps to the question before, where the rating given is shown chosen and can be changed.
 * *Pause and come back later* is a link to the Flow Tracker page — nothing is lost, because every
 * rating was saved as it was chosen. The transport stays out of sight for as long as the session
 * is asking.
 *
 * Once complete: **the list of parts to focus on** ([3.14.9](docs/project/prd.md)), grouped by
 * teaching from the oldest picked forward. Each row names the chapter, shows the member's own
 * rating as a quiet label, offers play-from-here and the chapter's page ([3.14.7](docs/project/prd.md)),
 * nests the related chapters of other teachings beneath it, and can be ticked off.
 *
 * **It reads what the API answers and decides nothing.** Every rating and every tick renders the
 * session the write answered rather than patching a row by hand.
 */

const LOAD_FAILED = 'Could not load this session. Reload the page to try again.';
const WRITE_FAILED = 'Could not save that. Nothing has changed — try again in a moment.';

export function SessionView({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [missing, setMissing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The question on screen while running — `null` means "the next unanswered one". */
  const [showing, setShowing] = useState<string | null>(null);

  useBreadcrumbTrail(
    session === null ? 'Session' : session.status === 'complete' ? 'Your route back in' : 'Session',
    [{ label: 'Flow Tracker', href: FLOW_TRACKER_PAGE_PATH }],
  );
  useTransportHidden(session !== null && session.status === 'in_progress');

  useEffect(() => {
    let stale = false;
    void apiFetch<FlowSessionPayload>(flowSessionPath(sessionId), { credentials: 'include' })
      .then((payload) => {
        if (!stale) setSession(payload.session);
      })
      .catch((caught: unknown) => {
        if (stale) return;
        if (caught instanceof ApiClientError && caught.code === 'not_found') setMissing(true);
        else setFailure(caught instanceof ApiClientError ? caught.message : LOAD_FAILED);
      });
    return () => {
      stale = true;
    };
  }, [sessionId]);

  async function write(path: string, body: unknown): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      const payload = await apiFetch<FlowSessionPayload>(path, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      setSession(payload.session);
    } catch (caught) {
      setFailure(caught instanceof ApiClientError ? caught.message : WRITE_FAILED);
    } finally {
      setBusy(false);
    }
  }

  if (missing) {
    return (
      <>
        <header className={styles.pageHead}>
          <h1 className={styles.pageTitle}>Flow Tracker</h1>
        </header>
        <section className={styles.card}>
          <p className={styles.quiet}>There is no such session.</p>
          <div className={styles.actions}>
            <Link className={styles.secondary} href={FLOW_TRACKER_PAGE_PATH}>
              Back to the Flow Tracker
            </Link>
          </div>
        </section>
      </>
    );
  }

  if (session === null) {
    return (
      <>
        <header className={styles.pageHead}>
          <h1 className={styles.pageTitle}>Flow Tracker</h1>
        </header>
        <section className={styles.card}>
          {failure === null ? (
            <p className={styles.quiet} role="status">
              Loading…
            </p>
          ) : (
            <p className={styles.failure}>{failure}</p>
          )}
        </section>
      </>
    );
  }

  if (session.status === 'complete') {
    return (
      <ReadingList
        session={session}
        busy={busy}
        failure={failure}
        onMark={(item, done) => {
          const body: MarkFlowItemRequest = { done };
          void write(flowSessionItemDonePath(session.id, item.id), body);
        }}
      />
    );
  }

  if (session.status === 'abandoned') {
    return (
      <>
        <header className={styles.pageHead}>
          <h1 className={styles.pageTitle}>Flow Tracker</h1>
        </header>
        <section className={styles.card}>
          <p className={styles.pageLead}>
            This session was abandoned on {session.startedAt === null ? '' : formatDay(session.startedAt)}.
          </p>
          <div className={styles.actions}>
            <Link className={styles.primary} href={FLOW_TRACKER_START_PAGE_PATH}>
              Start a new session
            </Link>
          </div>
        </section>
      </>
    );
  }

  const items = session.items;
  const current = (showing === null ? null : items.find((one) => one.id === showing)) ?? nextUnanswered(items);
  const index = current === null ? -1 : items.indexOf(current);

  return (
    <>
      <header className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Flow Tracker</h1>
        <p className={styles.progress} role="status">
          {current === null
            ? `${plural(items.length, 'question')}`
            : `Question ${index + 1} of ${items.length} · ${session.answeredCount} answered`}
        </p>
      </header>

      {current === null ? (
        <section className={styles.card}>
          <p className={styles.quiet}>There is nothing left to answer.</p>
        </section>
      ) : (
        <QuestionScreen
          item={current}
          busy={busy}
          canGoBack={index > 0}
          onBack={() => {
            const previous = items[index - 1];
            if (previous !== undefined) setShowing(previous.id);
          }}
          onAnswer={(rating) => {
            const body: AnswerFlowItemRequest = { rating };
            setShowing(null);
            void write(flowSessionItemPath(session.id, current.id), body);
          }}
        />
      )}

      {failure === null ? null : (
        <p className={styles.failure} role="alert">
          {failure}
        </p>
      )}
    </>
  );
}

// =================================================================================================
// The question screen (3.14.5, 3.14.6)
// =================================================================================================

/** What a rung of the scale is called to a screen reader: the ends carry their words. */
function ratingLabel(rating: FlowRating): string {
  if (rating === 1) return `1 — ${FLOW_RATING_ENDS.low}`;
  if (rating === 5) return `5 — ${FLOW_RATING_ENDS.high}`;
  return String(rating);
}

function QuestionScreen({
  item,
  busy,
  canGoBack,
  onBack,
  onAnswer,
}: {
  item: FlowSessionItemView;
  busy: boolean;
  canGoBack: boolean;
  onBack: () => void;
  onAnswer: (rating: FlowRating) => void;
}) {
  const kind = item.kind === 'chapter' ? 'Chapter' : item.kind === 'tag' ? 'Theme' : 'Teaching';
  return (
    <section className={styles.question} aria-label={`Question ${item.position}`}>
      {item.recording === null ? null : <Teaching teaching={item.recording} />}

      <div className={styles.subject}>
        <p className={styles.subjectKind}>{kind}</p>
        <h2 className={styles.subjectTitle}>
          {item.kind === 'chapter' && item.chapter !== null
            ? item.chapter.title
            : item.kind === 'tag' && item.tag !== null
              ? item.tag.name
              : item.recording?.title}
        </h2>
        {item.chapter?.summary ? <p className={styles.subjectSummary}>{item.chapter.summary}</p> : null}
      </div>

      <p className={styles.prompt}>{item.question}</p>

      <fieldset className={styles.scale} disabled={busy}>
        <legend className={styles.scaleLegend}>Your answer, from 1 to 5</legend>
        <div className={styles.scaleRow} role="radiogroup" aria-label="Your answer">
          {FLOW_RATINGS.map((rating) => {
            const id = `rating-${item.id}-${rating}`;
            return (
              <label className={styles.scaleStep} key={rating} htmlFor={id}>
                <input
                  className={styles.scaleInput}
                  id={id}
                  type="radio"
                  name={`rating-${item.id}`}
                  value={rating}
                  checked={item.rating === rating}
                  aria-label={ratingLabel(rating)}
                  onChange={() => onAnswer(rating)}
                />
                <span className={styles.scaleNumber} aria-hidden="true">
                  {rating}
                </span>
              </label>
            );
          })}
        </div>
        <div className={styles.scaleEnds} aria-hidden="true">
          <span className={styles.scaleEnd}>{FLOW_RATING_ENDS.low}</span>
          <span className={styles.scaleEnd}>{FLOW_RATING_ENDS.high}</span>
        </div>
      </fieldset>

      <div className={styles.questionFoot}>
        <button className={styles.textLink} type="button" disabled={!canGoBack || busy} onClick={onBack}>
          ‹ Back
        </button>
        <Link className={styles.textLink} href={FLOW_TRACKER_PAGE_PATH}>
          Pause and come back later
        </Link>
      </div>
    </section>
  );
}

function Teaching({ teaching }: { teaching: FlowTeachingRef }) {
  return (
    <div className={styles.teaching}>
      {teaching.series?.artworkUrl == null ? null : (
        <img className={styles.rowCover} src={teaching.series.artworkUrl} alt="" />
      )}
      <div className={styles.teachingText}>
        <p className={styles.teachingTitle}>{teaching.title}</p>
        <p className={styles.teachingMeta}>
          {teaching.series === null ? '' : `${teaching.series.title} · `}
          {formatDay(teaching.recordedAt)}
        </p>
      </div>
    </div>
  );
}

// =================================================================================================
// The reading list (3.14.6, 3.14.7, 3.14.9)
// =================================================================================================

function ReadingList({
  session,
  busy,
  failure,
  onMark,
}: {
  session: Session;
  busy: boolean;
  failure: string | null;
  onMark: (item: FlowSessionItemView, done: boolean) => void;
}) {
  const groups = session.readingList ?? [];
  const rows = groups.reduce((sum, group) => sum + group.rows.length, 0);

  return (
    <>
      <header className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Your route back in</h1>
        <p className={styles.pageLead}>
          {rows === 0
            ? 'Nothing to focus on — every part you reflected on is one you are living out. Well done.'
            : `${plural(rows, 'part')} you might want to focus on, oldest teaching first. Tick each one off as you go.`}
        </p>
        <p className={styles.progress}>
          {listTitles(session.teachings.map((one) => one.title))} ·{' '}
          {plural(session.teachingCount, 'teaching')} · {plural(session.questionCount, 'question')}
          {session.completedAt === null ? '' : ` · completed ${formatDay(session.completedAt)}`}
        </p>
      </header>

      {groups.map((group, index) => (
        <ReadingGroup key={group.recording?.id ?? `themes-${index}`} group={group} busy={busy} onMark={onMark} />
      ))}

      {failure === null ? null : (
        <p className={styles.failure} role="alert">
          {failure}
        </p>
      )}

      <div className={styles.actions}>
        <Link className={styles.secondary} href={FLOW_TRACKER_PAGE_PATH}>
          Back to the Flow Tracker
        </Link>
      </div>
    </>
  );
}

function ReadingGroup({
  group,
  busy,
  onMark,
}: {
  group: FlowReadingGroup;
  busy: boolean;
  onMark: (item: FlowSessionItemView, done: boolean) => void;
}) {
  const label = group.recording?.title ?? 'Across these teachings';
  return (
    <section className={styles.card} aria-label={label}>
      <div className={styles.groupHead}>
        {group.recording?.series?.artworkUrl == null ? null : (
          <img className={styles.rowCover} src={group.recording.series.artworkUrl} alt="" />
        )}
        <div className={styles.group}>
          <h2 className={styles.groupTitle}>{label}</h2>
          {group.recording === null ? (
            <p className={styles.groupMeta}>Themes running through the teachings in this session</p>
          ) : (
            <p className={styles.groupMeta}>
              {group.recording.series === null ? '' : `${group.recording.series.title} · `}
              {formatDay(group.recording.recordedAt)}
            </p>
          )}
        </div>
      </div>
      <ol className={styles.readingRows}>
        {group.rows.map((row) => (
          <ReadingRowView key={row.item.id} row={row} teaching={group.recording} busy={busy} onMark={onMark} />
        ))}
      </ol>
    </section>
  );
}

function ReadingRowView({
  row,
  teaching,
  busy,
  onMark,
}: {
  row: FlowReadingRow;
  teaching: FlowTeachingRef | null;
  busy: boolean;
  onMark: (item: FlowSessionItemView, done: boolean) => void;
}) {
  const player = usePlayer();
  const { item } = row;
  const title = item.chapter?.title ?? item.tag?.name ?? item.recording?.title ?? item.question;
  const tickId = `tick-${item.id}`;

  /** The one press that asks for sound: load the teaching at the chapter's start and play (3.14.7). */
  function play(target: FlowTeachingRef, atMs: number | null): void {
    if (player.loaded?.id === target.id) {
      if (atMs !== null) player.playFromMs(atMs);
      else if (!player.playing) player.toggle();
      return;
    }
    player.openAndPlay(
      {
        id: target.id,
        title: target.title,
        artworkUrl: target.series?.artworkUrl ?? null,
        seriesTitle: target.series?.title ?? null,
        seriesId: target.series?.id ?? null,
      },
      atMs,
    );
  }

  return (
    <li className={`${styles.readingRow}${item.done ? ` ${styles.readingDone}` : ''}`}>
      <input
        className={styles.tick}
        id={tickId}
        type="checkbox"
        checked={item.done}
        disabled={busy}
        aria-label={`Done: ${title}`}
        onChange={(event) => onMark(item, event.target.checked)}
      />
      <label className={styles.readingText} htmlFor={tickId}>
        <span className={styles.readingTitle}>{title}</span>
        {item.rating === null ? null : (
          <span className={styles.readingAnswer}>You rated this {item.rating} of 5</span>
        )}
      </label>

      {teaching !== null && item.kind !== 'tag' ? (
        <div className={styles.ways}>
          <button
            className={styles.play}
            type="button"
            aria-label={`Play ${teaching.title}${item.chapter === null ? '' : ` from ${formatTimecode(item.chapter.startMs)}`}`}
            onClick={() => play(teaching, item.chapter?.startMs ?? null)}
          >
            <span aria-hidden="true">▶</span>
          </button>
          <Link
            className={styles.openLink}
            href={
              item.chapter?.id != null
                ? chapterPagePath(teaching.id, item.chapter.id)
                : recordingPagePath(teaching.id)
            }
          >
            {item.chapter?.id != null ? 'Open chapter' : 'Open teaching'}
          </Link>
        </div>
      ) : null}

      {row.related.length > 0 ? (
        <ul className={styles.related} aria-label={`Related to ${title}`}>
          <li className={styles.relatedLead}>Also speaks to this:</li>
          {row.related.map((related) => (
            <li className={styles.relatedRow} key={`${related.recording.id}:${related.chapter.id}`}>
              <Link
                className={styles.relatedLink}
                href={
                  related.chapter.id === null
                    ? recordingPagePath(related.recording.id)
                    : chapterPagePath(related.recording.id, related.chapter.id)
                }
              >
                {related.recording.title} · {related.chapter.title}
              </Link>
              <button
                className={styles.textLink}
                type="button"
                aria-label={`Play ${related.recording.title} from ${formatTimecode(related.chapter.startMs)}`}
                onClick={() => play(related.recording, related.chapter.startMs)}
              >
                ▶ {formatTimecode(related.chapter.startMs)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {row.taggedTeachings.length > 0 ? (
        <ul className={styles.related} aria-label={`Teachings about ${title}`}>
          <li className={styles.relatedLead}>Teachings in this session on this theme:</li>
          {row.taggedTeachings.map((tagged) => (
            <li className={styles.relatedRow} key={tagged.id}>
              <Link className={styles.relatedLink} href={recordingPagePath(tagged.id)}>
                {tagged.title}
              </Link>
              <span>{formatDay(tagged.recordedAt)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
