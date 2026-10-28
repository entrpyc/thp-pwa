'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  FLOW_ANSWERS,
  FLOW_ANSWER_LABEL,
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
  type FlowAnswer,
  type FlowReadingGroup,
  type FlowReadingRow,
  type FlowSessionItemView,
  type FlowSessionPayload,
  type FlowSessionView as Session,
  type FlowTeachingRef,
  type MarkFlowItemRequest,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { useBreadcrumbTrail, usePlayer } from '../../../player-context';
import { formatDay, plural } from '../../format';
import styles from '../../flow-tracker.module.css';

/**
 * **One session** ([3.14.5](docs/project/prd.md)–[3.14.10](docs/project/prd.md)).
 *
 * While it runs: **one question per screen**. The teaching's cover, title and date; the chapter's
 * title and summary; the question; the five answers; a progress line. Pressing an answer sends it
 * and moves on to the next unanswered question; *Back* steps to the question before, where the
 * answer given is shown pressed and can be changed. *Pause and come back later* is a link to the
 * Flow Tracker page — nothing is lost, because every answer was saved as it was pressed.
 *
 * Once complete: **the reading list** ([3.14.9](docs/project/prd.md)), grouped by teaching from the
 * oldest in range forward. Each group's head opens the teaching's page; each row names the chapter
 * as a link to its page, shows the member's own answer as a quiet label, offers play-from-here
 * ([3.14.7](docs/project/prd.md)), nests the related chapters of other teachings beneath it, and
 * can be ticked off.
 *
 * **It reads what the API answers and decides nothing** — with one exception for feel. A tick is
 * shown as ticked the moment it is pressed, and only that row waits on the write; the session the
 * write answers then replaces the whole, and a failed write puts the tick back. Without that, every
 * checkbox went grey while the list reloaded, which read as the list emptying and refilling.
 */

const LOAD_FAILED = 'Could not load this session. Reload the page to try again.';
const WRITE_FAILED = 'Could not save that. Nothing has changed — try again in a moment.';

export function SessionView({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [missing, setMissing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Reading-list rows whose tick is on its way to the server. */
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  /** The question on screen while running — `null` means "the next unanswered one". */
  const [showing, setShowing] = useState<string | null>(null);

  useBreadcrumbTrail(
    session === null ? 'Session' : session.status === 'complete' ? 'What to live out' : 'Session',
    [{ label: 'Flow Tracker', href: FLOW_TRACKER_PAGE_PATH }],
  );

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

  /** Tick a row: shown at once, written behind, put back if the write fails. */
  async function mark(item: FlowSessionItemView, done: boolean): Promise<void> {
    if (pending.has(item.id)) return;
    setPending((was) => new Set(was).add(item.id));
    setFailure(null);
    setSession((was) => (was === null ? was : withDone(was, item.id, done)));
    const body: MarkFlowItemRequest = { done };
    try {
      const payload = await apiFetch<FlowSessionPayload>(flowSessionItemDonePath(sessionId, item.id), {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      setSession(payload.session);
    } catch (caught) {
      setSession((was) => (was === null ? was : withDone(was, item.id, !done)));
      setFailure(caught instanceof ApiClientError ? caught.message : WRITE_FAILED);
    } finally {
      setPending((was) => {
        const next = new Set(was);
        next.delete(item.id);
        return next;
      });
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
        pending={pending}
        failure={failure}
        onMark={(item, done) => void mark(item, done)}
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
          onAnswer={(answer) => {
            const body: AnswerFlowItemRequest = { answer };
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

/** The session with one item's tick changed, in both the items and the reading list it was built from. */
function withDone(session: Session, itemId: string, done: boolean): Session {
  const flip = (item: FlowSessionItemView): FlowSessionItemView => (item.id === itemId ? { ...item, done } : item);
  return {
    ...session,
    items: session.items.map(flip),
    readingList:
      session.readingList === null
        ? null
        : session.readingList.map((group) => ({
            ...group,
            rows: group.rows.map((row) => ({ ...row, item: flip(row.item) })),
          })),
  };
}

// =================================================================================================
// The question screen (3.14.5, 3.14.6)
// =================================================================================================

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
  onAnswer: (answer: FlowAnswer) => void;
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

      <hr className={styles.divider} />

      <div className={styles.subject}>
        <h2 className={styles.subjectTitle}>Question</h2>
        <p className={styles.subjectSummary}>{item.question}</p>
      </div>

      <ul className={styles.answers} aria-label="Your answer">
        {FLOW_ANSWERS.map((answer) => (
          <li key={answer}>
            <button
              className={styles.answer}
              type="button"
              disabled={busy}
              aria-pressed={item.answer === answer}
              onClick={() => onAnswer(answer)}
            >
              {FLOW_ANSWER_LABEL[answer]}
            </button>
          </li>
        ))}
      </ul>

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
  pending,
  failure,
  onMark,
}: {
  session: Session;
  pending: ReadonlySet<string>;
  failure: string | null;
  onMark: (item: FlowSessionItemView, done: boolean) => void;
}) {
  const groups = session.readingList ?? [];
  const rows = groups.reduce((sum, group) => sum + group.rows.length, 0);

  return (
    <>
      <header className={styles.pageHead}>
        <h1 className={styles.pageTitle}>What to live out</h1>
        <p className={styles.pageLead}>
          {rows === 0
            ? 'Nothing to revisit — every part of the teaching since then is one you are living out. Well done.'
            : `${plural(rows, 'chapter')} to revisit and live out, from the oldest teaching towards today. Tick each one off as you go.`}
        </p>
        <p className={styles.progress}>
          From {session.divergence.title} ({formatDay(session.divergence.recordedAt)}) ·{' '}
          {plural(session.teachingCount, 'teaching')} · {plural(session.questionCount, 'question')}
          {session.completedAt === null ? '' : ` · completed ${formatDay(session.completedAt)}`}
        </p>
      </header>

      {groups.map((group, index) => (
        <ReadingGroup key={group.recording?.id ?? `themes-${index}`} group={group} pending={pending} onMark={onMark} />
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
  pending,
  onMark,
}: {
  group: FlowReadingGroup;
  pending: ReadonlySet<string>;
  onMark: (item: FlowSessionItemView, done: boolean) => void;
}) {
  const label = group.recording?.title ?? 'Across these teachings';
  const head = (
    <>
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
    </>
  );
  return (
    <section className={styles.card} aria-label={label}>
      {/* The whole head opens the teaching's page; the themes group has no page to open. */}
      {group.recording === null ? (
        <div className={styles.groupHead}>{head}</div>
      ) : (
        <Link className={styles.groupLink} href={recordingPagePath(group.recording.id)}>
          {head}
        </Link>
      )}
      <ol className={styles.readingRows}>
        {group.rows.map((row) => (
          <ReadingRowView
            key={row.item.id}
            row={row}
            teaching={group.recording}
            pending={pending.has(row.item.id)}
            onMark={onMark}
          />
        ))}
      </ol>
    </section>
  );
}

function ReadingRowView({
  row,
  teaching,
  pending,
  onMark,
}: {
  row: FlowReadingRow;
  teaching: FlowTeachingRef | null;
  pending: boolean;
  onMark: (item: FlowSessionItemView, done: boolean) => void;
}) {
  const player = usePlayer();
  const { item } = row;
  const title = item.chapter?.title ?? item.tag?.name ?? item.recording?.title ?? item.question;
  const tickId = `tick-${item.id}`;
  /** Where the title opens: the chapter's page, or the teaching's for a chapterless one (3.14.7). */
  const href =
    teaching !== null && item.kind !== 'tag'
      ? item.chapter?.id != null
        ? chapterPagePath(teaching.id, item.chapter.id)
        : recordingPagePath(teaching.id)
      : null;

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
        disabled={pending}
        aria-label={`Done: ${title}`}
        onChange={(event) => onMark(item, event.target.checked)}
      />
      <div className={styles.readingText}>
        {href === null ? (
          <label className={styles.readingTitle} htmlFor={tickId}>
            {title}
          </label>
        ) : (
          <Link className={styles.readingTitleLink} href={href}>
            {title}
          </Link>
        )}
        {item.answer === null ? null : (
          <span className={styles.readingAnswer}>You said: {FLOW_ANSWER_LABEL[item.answer]}</span>
        )}
      </div>

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
