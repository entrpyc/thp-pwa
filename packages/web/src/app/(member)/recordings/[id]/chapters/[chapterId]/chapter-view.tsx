'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  formatTimecode,
  memberRecordingPath,
  recordingChaptersPath,
  recordingPagePath,
  recordingProgressPath,
  seriesPagePath,
  type ChaptersPayload,
  type PlaybackProgressPayload,
  type RecordingPayload,
  type RecordingView as Recording,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { useBreadcrumbTrail, usePlayer } from '../../../../player-context';
import { NotesPanel } from '../../notes-panel';
import { ScripturePanel } from '../../scripture-panel';
import { TranscriptPanel } from '../../transcript-panel';
import styles from '../../../../screens.module.css';

/** The strip is single-select, as the recording page's is. `null` is all closed. */
type OpenTab = 'scripture' | 'notes' | 'transcript' | null;

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
 *   citation to the chapter its anchor falls in, and the transcript stops at the boundaries — the
 *   last of those still true of the panel, which is intact and merely unreachable while the
 *   `Transcript` tab is hidden. See the strip below.
 * - **It offers a route back to the recording it came from** ([3.22.13](docs/project/prd.md)) — the
 *   back control over the band, pointing at the teaching rather than at the library. The address is
 *   what decides that, so a member who arrived from a link gets the same route back as one who
 *   walked here.
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
  const [openTab, setOpenTab] = useState<OpenTab>('notes');
  /** The stored position, kept for the moment the play control hands the player over. */
  const [startAtMs, setStartAtMs] = useState<number | null>(null);

  /** Whether this teaching holds the player — false while a member is still hearing another one. */
  const isCurrent = player.loaded?.id === recordingId;

  /**
   * The chapter list this page reads when the player is holding a **different** teaching.
   *
   * Usually the player's own list is in hand — opening the teaching fetches it, because the
   * transport names the chapter playing on every screen. But arriving here while listening to
   * something else leaves the player alone (see `openIfIdle` below), so the page asks for the list
   * itself: the chapter's title and summary are what this page *is*, and a page that answered
   * "press play to find out what this chapter is called" would be gating reading on sound.
   */
  const [fallbackChapters, setFallbackChapters] = useState<{
    readonly recordingId: string;
    readonly chapters: ChaptersPayload['chapters'];
  } | null>(null);
  useEffect(() => {
    if (isCurrent) return;
    let live = true;
    void apiFetch<ChaptersPayload>(recordingChaptersPath(recordingId), { credentials: 'include' })
      .then((payload) => {
        if (live) setFallbackChapters({ recordingId, chapters: payload.chapters });
      })
      .catch(() => {
        // The page falls back to its loading line; the teaching link above it still works.
      });
    return () => {
      live = false;
    };
  }, [isCurrent, recordingId]);

  /**
   * The chapter, out of the player's list when this teaching holds the player and out of the
   * page's own fetch when it does not.
   *
   * `null` while the list is in flight, and `null` for good if the id names no chapter of this
   * teaching — the two are told apart below by whether the list itself has arrived.
   */
  const chapters =
    player.chapters?.recordingId === recordingId
      ? player.chapters
      : fallbackChapters?.recordingId === recordingId
        ? fallbackChapters
        : null;
  const chapter = chapters?.chapters.find((one) => one.id === chapterId) ?? null;

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
            : [{ label: recording.series.title, href: seriesPagePath(recording.series.id) }]),
          { label: recording.title, href: recordingPagePath(recordingId) },
        ],
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
      openIfIdle(
        {
          id: payload.recording.id,
          title: payload.recording.title,
          artworkUrl: payload.recording.series?.artworkUrl ?? null,
          seriesTitle: payload.recording.series?.title ?? null,
        },
        progress.positionMs,
      );
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
          chapter divides rather than to browser history, so it behaves the same when the page was
          opened from a link. The recording page's own back control goes to the library, which makes
          two presses out of here and each of them somewhere a member meant to be.
        */}
        <Link
          className={styles.back}
          href={recordingPagePath(recordingId)}
          aria-label="Back to the teaching"
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
              ([3.22.12](docs/project/prd.md)).
            */}
            <button
              className={styles.detailPlay}
              type="button"
              aria-label={`Play from ${chapter.title}`}
              onClick={() =>
                isCurrent
                  ? player.playFromMs(chapter.startMs)
                  : // The transport still holds whatever the member was hearing when they arrived.
                    // The press is the decision: this teaching takes the player over, from this
                    // chapter's start, playing.
                    recording === null
                    ? undefined
                    : player.openAndPlay(
                        {
                          id: recording.id,
                          title: recording.title,
                          artworkUrl: recording.series?.artworkUrl ?? null,
                          seriesTitle: recording.series?.title ?? null,
                        },
                        chapter.startMs,
                      )
              }
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
          </header>

          {/*
            The chapter's summary, in the page body where the recording page puts a teaching's
            ([3.22.3](docs/project/prd.md)). Not clamped, unlike a teaching's summary: a chapter's is
            one short paragraph by definition (4.19), so there is nothing to collapse.
          */}
          <p className={styles.chapterSummary}>{chapter.summary}</p>

          {/*
            **The strip and its panels wait for this teaching to hold the player**, exactly as the
            recording page's do and for the same reason: everything behind the tabs reads from the
            player, which is still holding whatever the member was hearing when they arrived.
          */}
          {!isCurrent ? (
            <p className={styles.quiet}>
              You are listening to something else. Press play to switch to this teaching and open
              its notes.
            </p>
          ) : (
            <>
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
              onClick={() => setOpenTab((open) => (open === 'notes' ? null : 'notes'))}
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
              onClick={() => setOpenTab((open) => (open === 'scripture' ? null : 'scripture'))}
            >
              Scripture
            </button>
            {/*
              **`Transcript` is hidden**, the same operator decision the recording page's strip
              carries and for the same reason — the two strips are one control a member reads twice,
              and a tab that vanished on one screen and not the other would read as a bug rather
              than as a decision. See `recording-view.tsx` for the whole of it.

              <button
                className={styles.tab}
                type="button"
                role="tab"
                aria-selected={openTab === 'transcript'}
                onClick={() => setOpenTab((open) => (open === 'transcript' ? null : 'transcript'))}
              >
                Transcript
              </button>
            */}
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
            </>
          )}
        </>
      )}
    </>
  );
}
