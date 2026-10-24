'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PinMomentControl } from '../../../../highlights/pin-moment-control';
import {
  formatTimecode,
  memberRecordingPath,
  recordingPagePath,
  recordingProgressPath,
  seriesPagePath,
  type PlaybackProgressPayload,
  type RecordingPayload,
  type RecordingView as Recording,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { track } from '@/client/observability/analytics';
import { useBreadcrumbTrail, usePlayer } from '../../../../player-context';
import { NotesPanel } from '../../notes-panel';
import {
  RecordingContentProvider,
  toLoaded,
  useRecordingContentFor,
} from '../../recording-content';
import {
  arrivedFromList,
  isPlainPress,
  recordingTabHref,
  tabFromAddress,
  writeTabToAddress,
} from '../../round-trip';
import { ScripturePanel } from '../../scripture-panel';
import { TranscriptPanel } from '../../transcript-panel';
import styles from '../../../../screens.module.css';

/** The strip's tabs, by the name each takes in the address — the recording page's, minus one. */
const TABS = ['notes', 'scripture', 'transcript'] as const;

/** The strip is single-select, as the recording page's is. `null` is all closed. */
type OpenTab = (typeof TABS)[number] | null;

/**
 * **The chapter page** ([3.22.13](docs/project/prd.md)–[3.22.15](docs/project/prd.md)).
 *
 * *The recording page read through one theme* — which is not a turn of phrase, it is the
 * construction: the same hero band under the same cover, the same three panels, mounted with one
 * extra prop. Nothing here is a second implementation of anything on the recording page, and that
 * is what stops a note or a citation reading differently depending on which page a member opened it
 * from.
 *
 * - **Its title and summary sit under the recording's cover**
 *   ([3.22.3](docs/project/prd.md), [3.22.13](docs/project/prd.md)). A chapter carries no artwork of
 *   its own — it is part of a teaching rather than a second thing to brand — so the band is the
 *   series' cover, exactly as it is on the recording page.
 * - **The recording's tabs sit beside them, each scoped to this chapter's span**
 *   ([3.22.14](docs/project/prd.md)). A note belongs to the chapter its timestamp falls in, a
 *   citation to the chapter its anchor falls in, and the transcript stops at the boundaries.
 * - **It offers a route back to the recording it came from** ([3.22.13](docs/project/prd.md)) — the
 *   back control over the band, pointing at the teaching with its chapter list open rather than at
 *   the library. The address is what decides that, so a member who arrived from a link gets the
 *   same route back as one who walked here. A member who *did* walk here — pressed a row on that
 *   list — goes back through history instead, which is what brings the list back at the offset
 *   they left it; see the control below and `round-trip.ts`.
 * - **The breadcrumb draws the whole path** — `home › series › recording › chapter` — which is a
 *   different question from the one the back control answers. Back is *one press up*; the trail is
 *   *where this page sits*, and a chapter sits inside a teaching inside a study. Naming only the
 *   teaching was the old trail obeying a shape that could hold one ancestor.
 * - **Opening it loads the teaching and does not play it**
 *   ([3.22.12](docs/project/prd.md)). A member who tapped a chapter has not asked for sound. The
 *   position restored is the member's own stored one, **not the chapter's start**: this page is a
 *   reading of a stretch of the teaching, and seeking somebody's playback because they opened a page
 *   would be the page taking a decision the play control is for.
 * - **A note written here is anchored to the playback position**
 *   ([3.22.15](docs/project/prd.md)) — the composer inside the notes panel is the same composer,
 *   reading the same anchor from the same provider. A chapter is a lens over member content, never
 *   its owner, so there is nothing here to write a chapter id onto a note with.
 */
export function ChapterScreen({
  recordingId,
  chapterId,
  canCorrect,
  canModerate,
}: {
  recordingId: string;
  chapterId: string;
  canCorrect: boolean;
  canModerate: boolean;
}) {
  const player = usePlayer();
  const [recording, setRecording] = useState<Recording | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * Notes unless the address names another tab — read once at mount, written on every press, for
   * the reason the recording page gives: the entry a member comes back to names the tab they left
   * open (`round-trip.ts`). Every tab here is always drawn, so there is no fallback to make.
   */
  const params = useSearchParams();
  const [openTab, setOpenTab] = useState<OpenTab>(() => tabFromAddress(params, TABS) ?? 'notes');
  /** The same press opens and closes; only the open is counted (observability.md § 5.2). */
  const chooseTab = (next: Exclude<OpenTab, null>) => {
    if (openTab !== next) track('tab_opened', { tab: next, surface: 'chapter', recording_id: recordingId });
    const open = openTab === next ? null : next;
    setOpenTab(open);
    writeTabToAddress(open, 'notes');
  };
  /**
   * Whether the teaching's page is the history entry behind this one — a row on its chapter list
   * was pressed to get here. Decided once, on arrival, and false until then, so the back control is
   * a plain link for the first paint and stays one for a page opened from a link (`round-trip.ts`).
   */
  const [fromList, setFromList] = useState(false);
  useEffect(() => {
    setFromList(arrivedFromList(recordingId, chapterId));
  }, [chapterId, recordingId]);
  /** The stored position, kept for the moment the play control hands the player over. */
  const [startAtMs, setStartAtMs] = useState<number | null>(null);

  /**
   * The chapter list, out of the player's when this teaching holds the player and out of the page's
   * own fetch when it does not — see `recording-content.tsx`.
   *
   * Usually the player's own list is in hand — opening the teaching fetches it, because the
   * transport names the chapter playing on every screen. But arriving here while listening to
   * something else leaves the player alone (see `openIfIdle` below), so the page asks for the list
   * itself: the chapter's title and summary are what this page *is*, and a page that answered
   * "press play to find out what this chapter is called" would be gating reading on sound. The
   * same source feeds the notes panel below, so a member hearing another teaching reads this
   * chapter's notes all the same.
   *
   * `chapter` is `null` while the list is in flight, and `null` for good if the id names no
   * chapter of this teaching — the two are told apart below by whether the list itself has arrived.
   */
  const content = useRecordingContentFor(recordingId, recording, startAtMs);
  const chapters = content.chapters;
  const chapter = chapters?.find((one) => one.id === chapterId) ?? null;

  /**
   * `home › series › recording › chapter` — **the whole path down to here**.
   *
   * It used to be `home › recording › chapter`, because the trail could hold one ancestor and the
   * teaching was the better of the two: it is where this page's own back route goes
   * ([3.22.13](docs/project/prd.md)), and a trail that disagreed with the back control would be two
   * answers to one question. That was a constraint of the shape rather than a decision about the
   * product, and the shape now carries a list — so the series goes back in *above* the teaching,
   * where it always belonged, and the back control still points at the teaching. The trail says
   * where you are; the back control says where one press takes you. Those were never the same claim.
   *
   * The series comes off the recording payload, exactly as the recording page's does, so a chapter
   * opened from a link draws the same path as one walked to. A teaching in no series simply names
   * one fewer ancestor.
   */
  useBreadcrumbTrail(
    chapter?.title ?? null,
    recording === null
      ? []
      : [
          ...(recording.series == null
            ? []
            : [{ label: recording.series.title, href: seriesPagePath(recording.series.id), kind: 'series' as const }]),
          { label: recording.title, href: recordingPagePath(recordingId), kind: 'recording' as const },
        ],
    'chapter',
  );

  const { openIfIdle } = player;
  useEffect(() => {
    let live = true;

    async function load(): Promise<void> {
      // The same pair the recording page asks for, and for the same reason: the player needs both
      // before it can point the element anywhere, and asking in sequence would seek twice.
      const [payload, progress] = await Promise.all([
        apiFetch<RecordingPayload>(memberRecordingPath(recordingId), { credentials: 'include' }),
        apiFetch<PlaybackProgressPayload>(recordingProgressPath(recordingId), {
          credentials: 'include',
        }),
      ]);
      if (!live) return;
      setRecording(payload.recording);
      setStartAtMs(progress.positionMs);
      setFailure(null);
      // `openIfIdle`, exactly as the recording page: arriving here must not stop what a member is
      // in the middle of hearing. The play control is what hands the player over.
      openIfIdle(toLoaded(payload.recording), progress.positionMs);
    }

    void load().catch((caught: unknown) => {
      if (!live) return;
      setRecording(null);
      setFailure(
        caught instanceof ApiClientError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.',
      );
    });

    return () => {
      live = false;
    };
  }, [openIfIdle, recordingId]);

  const cover = recording?.series?.artworkUrl ?? null;

  /**
   * **The band keeps the cover's proportion while the page is still loading.** Most studies have a
   * cover, so the likeliest shape is the 3:1 band; drawing the coverless strip first and growing
   * it when the payload lands moved everything below it on nearly every open. A study that turns
   * out to have no cover settles to the strip once that is known — and so does a page that could
   * not be loaded, which has nothing to reserve room for.
   */
  const covered = cover !== null || (recording === null && failure === null);

  return (
    <>
      <div className={`${styles.hero}${covered ? ` ${styles.heroCovered}` : ''}`}>
        {/*
          The cover of the series the *teaching* is in ([3.22.3](docs/project/prd.md)): a chapter is
          shown under the cover of the recording it belongs to, because it is part of a teaching
          rather than a second thing to brand.
        */}
        {cover === null ? null : (
          <>
            <img className={styles.heroArt} src={cover} alt="" />
            <span className={styles.heroFade} aria-hidden="true" />
          </>
        )}
        {/*
          **The route back to the recording** ([3.22.13](docs/project/prd.md)) — to the teaching this
          chapter divides, with its chapter list open: that list is what this chapter is a row of.
          The recording page's own back control goes to the study or the library, which makes two
          presses out of here and each of them somewhere a member meant to be.

          The href is that address, always, so the control reads the same when the page was opened
          from a link and a middle-click opens the teaching in a tab. A plain press when the
          teaching's page is the entry behind this one goes back through history instead — the one
          way to land on *that* entry rather than on a fresh one, which is what puts the list back
          at the offset it was left at, and what keeps the browser's own back from looping to this
          chapter again.
        */}
        <Link
          className={styles.back}
          href={recordingTabHref(recordingId, 'chapters')}
          aria-label="Back to the teaching"
          onClick={(event) => {
            if (!fromList || !isPlainPress(event)) return;
            event.preventDefault();
            window.history.back();
          }}
        >
          <span aria-hidden="true">‹</span>
        </Link>
      </div>

      {failure === null ? null : <p className={styles.failure}>{failure}</p>}

      {chapter === null ? (
        failure === null ? (
          <p className={styles.quiet}>
            {chapters !== null
              ? // The list arrived and this id is not in it — a chapter that was merged away or a
                // regeneration that replaced the list while the member was reading it. It says so
                // and offers the teaching, which is the only place left to go.
                'That chapter is no longer part of this teaching. It may have been rewritten since you opened this page.'
              : 'Loading the chapter…'}
          </p>
        ) : null
      ) : (
        <>
          <header className={styles.detailHead}>
            {/*
              The one filled circle on this screen, as on the recording page — and here it seeks to
              the chapter and plays, because on this page *play* can only mean this chapter
              ([3.22.12](docs/project/prd.md)). When the transport still holds whatever the member
              was hearing when they arrived, the press is the decision: this teaching takes the
              player over, from this chapter's start, playing — which is what `playFromMs` on the
              page's content does for a teaching the player does not hold.
            */}
            <button
              className={styles.detailPlay}
              type="button"
              aria-label={`Play from ${chapter.title}`}
              onClick={() => content.playFromMs(chapter.startMs)}
            >
              <span aria-hidden="true">▶</span>
            </button>
            <div className={styles.detailText}>
              <h1 className={styles.detailTitle}>{chapter.title}</h1>
              <p className={styles.detailMeta}>
                Chapter {chapter.position} · {formatTimecode(chapter.startMs)}–
                {formatTimecode(chapter.endMs)}
              </p>
            </div>
            {/* Pin this chapter — its opening moment — to Highlights (3.15.2, 3.15.4). */}
            <PinMomentControl recordingId={recordingId} positionMs={chapter.startMs} label="this chapter" />
          </header>

          {/*
            The chapter's summary, in the page body where the recording page puts a teaching's
            ([3.22.3](docs/project/prd.md)). Not clamped, unlike a teaching's summary: a chapter's is
            one to three sentences by definition (4.19), so there is nothing to collapse.
          */}
          <p className={styles.chapterSummary}>{chapter.summary}</p>

          {/*
            **The strip and its panels do not wait for this teaching to hold the player**, exactly
            as the recording page's do not: the notes panel reads from `content`, which is this
            teaching's own list whatever the player is holding, and nothing under the strip starts
            sound. The play control above is the one press that does.
          */}
          <RecordingContentProvider value={content}>
          {/*
            **The recording's tabs, scoped** ([3.22.13](docs/project/prd.md),
            [3.22.14](docs/project/prd.md)). The same strip in the same order as the recording page,
            minus `Chapters` — a chapter does not divide into chapters, and a tab that took the
            member back to the list they came from is a loop rather than a destination.
          */}
          <div className={styles.tabs} role="tablist" aria-label="Chapter contents">
            <button
              className={`${styles.tab} ${styles.notesTab}`}
              type="button"
              role="tab"
              aria-selected={openTab === 'notes'}
              onClick={() => chooseTab('notes')}
            >
              <span className={styles.notesIcon} aria-hidden="true">
                ✎
              </span>
              Notes
            </button>
            {/*
              Drawn whatever the teaching cites, unlike the recording page's. `hasScripture` says
              whether the *teaching* has references; whether this chapter has any is a question about
              anchors that the payload cannot answer without being fetched — so the tab is offered and
              the panel states the empty case, which is the honest order of those two facts.
            */}
            <button
              className={styles.tab}
              type="button"
              role="tab"
              aria-selected={openTab === 'scripture'}
              onClick={() => chooseTab('scripture')}
            >
              Scripture
            </button>
            {/*
              Drawn whenever the recording page's strip draws it — the two strips are one control a
              member reads twice, and a tab that vanished on one screen and not the other would read
              as a bug rather than as a decision. It was hidden on both for a while by operator
              decision, and came back on both; see `recording-view.tsx` for the whole of it.
            */}
            <button
              className={styles.tab}
              type="button"
              role="tab"
              aria-selected={openTab === 'transcript'}
              onClick={() => chooseTab('transcript')}
            >
              Transcript
            </button>
          </div>

          {openTab === 'notes' ? (
            <NotesPanel
              recordingId={recordingId}
              canModerate={canModerate}
              chapterId={chapterId}
            />
          ) : null}

          {openTab === 'scripture' ? (
            <ScripturePanel recordingId={recordingId} chapterId={chapterId} />
          ) : null}

          {openTab === 'transcript' ? (
            <TranscriptPanel
              recordingId={recordingId}
              canCorrect={canCorrect}
              chapterId={chapterId}
            />
          ) : null}
          </RecordingContentProvider>
        </>
      )}
    </>
  );
}
