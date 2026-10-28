'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  DASHBOARD_PAGE_PATH,
  memberRecordingPath,
  recordingProgressPath,
  seriesPagePath,
  type PlaybackProgressPayload,
  type RecordingPayload,
  type RecordingView as Recording,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { BackRoute } from '../../../back-route';
import { track } from '@/client/observability/analytics';
import { useBreadcrumbTrail, usePlayer } from '../../player-context';
import { DownloadControl } from '../../downloads/download-control';
import { openAtFromAddress } from '../../highlights/open-at';
import { ChaptersPanel } from './chapters-panel';
import { MindMapPanel } from './mind-map-panel';
import { NotesPanel } from './notes-panel';
import { RecordingContentProvider, toLoaded, useRecordingContentFor } from './recording-content';
import { ReflectionCard, questionsOf } from './reflection';
import { listOffsetLeftHere, tabFromAddress, writeTabToAddress } from './round-trip';
import {
  AboutIcon,
  ChaptersIcon,
  MindmapIcon,
  ReflectionIcon,
  RelatedIcon,
  ScriptureIcon,
  TranscriptIcon,
} from './tab-icons';
import { NotesIcon } from '../../notes/notes-icon';
import { RelatedTeachings, useRelatedGroups } from './related-teachings';
import { ScripturePanel } from './scripture-panel';
import { TranscriptPanel } from './transcript-panel';
import { TagLabels } from '../../tag-labels';
import styles from '../../screens.module.css';

/** The strip's tabs, by the name each takes in the address (`?tab=chapters`). */
const TABS = ['notes', 'about', 'reflection', 'chapters', 'scripture', 'transcript', 'mindmap', 'related'] as const;

/** The strip is single-select: opening one tab closes the others, and `null` is all closed. */
type OpenTab = (typeof TABS)[number] | null;

/**
 * **The recording page** — `pages/recording.png`.
 *
 * The reference, read against what this epic has:
 *
 * - **The hero band is the cover of the series this teaching is in**, the column's width and 3:1 as
 *   `pages/chapter.png` draws it, with the back control over it (scope prd 3.2.3, 3.2.7). The
 *   cover is the *series'* — a recording has none of its own — so every teaching in one study
 *   shows the same picture, and a teaching in no series keeps the flat band (scope prd 3.2.6).
 * - **A tab strip holding the reference's five tabs and three more** — `Notes`, `About`,
 *   `Reflection`, `Chapters`, `Scripture`, `Transcript`, `Mindmap`, `Related` — each drawn when the
 *   teaching has something behind it: `Chapters` arrived with [3.22.10](docs/project/prd.md) and
 *   `Mindmap` with [3.8.3](docs/project/prd.md). `About` holds the description and the summary —
 *   description first, then summary, which is what a member reads in: the chosen line about the
 *   teaching, then what was said in it — and is drawn only when the teaching has either.
 *   `Reflection` lists the chapters' Flow Tracker questions (`reflection.tsx`), and is drawn only
 *   once a chapter has one. `Related` holds the
 *   moments in other teachings anchored to the part playing ([3.9.2](docs/project/prd.md)), and is
 *   drawn only for a teaching that has a related moment somewhere in it. The strip is
 *   **single-select**, the way the reference reads it: opening `Notes` closes `Scripture`.
 * - **`Transcript` is always drawn** (3.5.3, 3.5.4). `Scripture`, `Chapters` and `Mindmap` come
 *   and go with what a teaching has; the transcript is the one thing every published teaching
 *   has, so its tab is the one entry besides `Notes` that is always there.
 * - **`Mindmap` is drawn only for a teaching whose map an admin approved**
 *   ([3.8.2](docs/project/prd.md)) — the same line as `Scripture`, off the payload's `hasMindMap`.
 * - **`Scripture` is drawn only for a teaching that has some** (active-scope prd 3.4.4) — the same
 *   line, one step further: a destination with no data behind it is left out rather than offered
 *   empty. The recording payload carries `hasScripture` so that decision costs no request.
 * - **`Notes` starts open; everything else starts closed.** A member who never presses a tab
 *   downloads nothing behind it — pressing it is what asks, and pressing it again puts it away.
 *   The notes are the exception at both ends: they are fetched when the *teaching* is opened,
 *   because their markers show on the transport without the tab (active-scope prd 3.2.4), so the
 *   panel is drawing something the page already holds and there is nothing to save by hiding it.
 * - **`Chapters` is drawn only for a teaching that has some** ([3.22.10](docs/project/prd.md)) —
 *   the same line 3.4.4 draws for `Scripture`, and the requirement says so outright: a recording
 *   with no chapters ([3.22.4](docs/project/prd.md)) does not show the tab at all. It costs no
 *   request either, but for a different reason: the chapters were fetched when the *teaching* was
 *   opened, because the transport names the chapter playing on every screen
 *   ([3.22.16](docs/project/prd.md)) — so, like the notes, the panel draws something the page
 *   already holds.
 * - **No download control.** Deferred; dropped rather than disabled.
 * - **Coming back from a chapter lands where the member left**: the `Chapters` tab open and the
 *   list at the offset it had when the row was pressed. The open tab is in the address and the
 *   offset is on the history entry, and the chapter page's back control goes back through history
 *   when this page is the entry behind it — `round-trip.ts` is the whole of it. A direct link to
 *   a teaching is none of that, and opens `Notes` at the top as it always has.
 *
 * **Opening the page loads the teaching and does not play it.** The stored position is restored
 * once the element has metadata — seeking before that is silently clamped to zero — and the member
 * presses play when they want sound.
 *
 * **The back control goes back through browser history** — to the study, the library, a search,
 * whatever the teaching was opened from — and falls back to the series this teaching is in, or to
 * the library for a teaching in none, for a member who arrived from a shared link and has no history
 * to go back to (`back-route.tsx`).
 */
export function RecordingScreen({
  recordingId,
  canCorrect,
  canModerate,
  canEditChapters,
}: {
  recordingId: string;
  /** Whether to render the correction affordance. It grants nothing — the API refuses a member. */
  canCorrect: boolean;
  /** Whether to render the admin entries in a note's overflow. It grants nothing either. */
  canModerate: boolean;
  /** Whether to render the chapter edit, split and merge controls. It grants nothing either. */
  canEditChapters: boolean;
}) {
  const player = usePlayer();
  const [recording, setRecording] = useState<Recording | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * The stored position, kept for the play control. Usually `openIfIdle` has already handed it to
   * the player on mount — but when another teaching was playing then, the hand-over happens at the
   * play press instead, and the position has to still be in hand at that moment.
   */
  const [startAtMs, setStartAtMs] = useState<number | null>(null);
  /*
   * **Notes is open when the page is**, unless the address names another tab. Every other tab is
   * a download a member asks for, but the notes are already in hand — the player fetches them on
   * open, because the transport's markers draw from them without any tab being pressed — so
   * opening the panel costs nothing and is what a member came to the page for. Pressing it still
   * closes it.
   *
   * The address is read once, at mount, and written on every press (`round-trip.ts`). That is how
   * the tab survives the trip to a chapter page and back — by this page's control or by the
   * browser's, since either lands on an entry whose address names it — and why `?tab=chapters` is
   * where the chapter page's back control points. The bare address is Notes, so a direct link
   * opens as it always has.
   */
  const params = useSearchParams();
  const [openTab, setOpenTab] = useState<OpenTab>(() => tabFromAddress(params, TABS) ?? 'notes');

  /**
   * **The panel area holds its height while a tab is swapped**, so the page cannot jump under the
   * member who pressed the tab.
   *
   * Without this, a press is three layouts rather than one: the open panel unmounts, the document
   * loses its height, and a member scrolled past what is left is **clamped** to the new bottom —
   * the page visibly slides down. The new panel then fetches, its content arrives, the document
   * grows again and the browser's scroll anchoring puts the position back. Measured on the
   * scripture tab, that round trip is about fifty milliseconds and a hundred and twenty pixels: too
   * fast to follow and far too big to miss.
   *
   * So the region keeps the height it had until giving it up would move nothing. What is held is a
   * `min-height` on the panels' own wrapper rather than the scroll position, because a scroll
   * position cannot be restored to somewhere the document no longer reaches — by the time the
   * clamp has happened, the room to put it back is gone.
   */
  const panelRegion = useRef<HTMLDivElement | null>(null);
  const [floorPx, setFloorPx] = useState(0);

  /**
   * Read the panel area's height **before** the swap, which is the only moment it can be read: one
   * render later the outgoing panel is gone and its height with it.
   */
  const chooseTab = (next: OpenTab) => {
    setFloorPx(panelRegion.current?.getBoundingClientRect().height ?? 0);
    // An open is counted; the same press closing the tab is not (observability.md § 5.2).
    if (next !== null && openTab !== next) {
      track('tab_opened', { tab: next, surface: 'recording', recording_id: recordingId });
    }
    const open = openTab === next ? null : next;
    setOpenTab(open);
    writeTabToAddress(open, 'notes');
  };

  /**
   * Let the held height go the moment letting it go moves nothing.
   *
   * "Nothing" is a measurement, not a delay: the region shrinks by whatever the floor is holding
   * beyond the panel's own content, and that is safe exactly when the document is still tall enough
   * to reach the bottom of the window afterwards. A panel that arrives taller than the floor
   * releases on its first paint; a genuinely shorter one waits — for its own content, or for the
   * member to scroll up far enough that the space is no longer holding the page open — which is
   * what the observer and the two listeners are for. Until then the page carries some empty space
   * below the panel, which is invisible where it sits and cannot move anything.
   */
  useEffect(() => {
    if (floorPx === 0) return;
    const region = panelRegion.current;
    if (region === null) return;

    const release = () => {
      const panel = region.firstElementChild;
      const natural = panel === null ? 0 : panel.getBoundingClientRect().height;
      const shrinkBy = Math.max(0, floorPx - natural);
      const room = document.documentElement.scrollHeight - shrinkBy;
      if (shrinkBy === 0 || room >= window.scrollY + window.innerHeight) setFloorPx(0);
    };

    release();
    /*
     * **The observer watches the panel, not the region.** The region's height is exactly what the
     * floor is pinning, so it has no news to give — it is the panel inside it that grows when its
     * fetch lands, and that growth is usually what makes the floor safe to drop.
     */
    const observer = new ResizeObserver(release);
    const panel = region.firstElementChild;
    if (panel === null) observer.observe(region);
    else observer.observe(panel);
    window.addEventListener('scroll', release, { passive: true });
    window.addEventListener('resize', release);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', release);
      window.removeEventListener('resize', release);
    };
  }, [floorPx, openTab]);

  /**
   * `home › series › recording` when this teaching is in one, and today's two segments when it is
   * not (Story 6). The series comes off the recording payload rather than off the navigation that
   * reached the page, so opening a teaching from a link draws the same trail as walking to it.
   */
  useBreadcrumbTrail(
    recording?.title ?? null,
    recording?.series == null
      ? []
      : [{ label: recording.series.title, href: seriesPagePath(recording.series.id) }],
    'recording',
  );

  const { openIfIdle } = player;
  useEffect(() => {
    let live = true;

    async function load(): Promise<void> {
      // The recording and the position together: the player needs both before it can point the
      // element anywhere, and asking for them in sequence would seek twice.
      const [payload, progress] = await Promise.all([
        apiFetch<RecordingPayload>(memberRecordingPath(recordingId), { credentials: 'include' }),
        apiFetch<PlaybackProgressPayload>(recordingProgressPath(recordingId), {
          credentials: 'include',
        }),
      ]);
      if (!live) return;
      setRecording(payload.recording);
      // A highlight's address names a moment ([3.15.7](docs/project/prd.md)); otherwise the stored position.
      const startMs = openAtFromAddress() ?? progress.positionMs;
      setStartAtMs(startMs);
      setFailure(null);
      // `openIfIdle`, not `open`: arriving on the page loads the teaching into the transport only
      // when doing so silences nothing. A member listening to something else keeps hearing it, and
      // this teaching takes the player over at the play control instead.
      openIfIdle(toLoaded(payload.recording), startMs);
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

  const isCurrent = player.loaded?.id === recordingId;

  /**
   * What the strip and its panels read: the player's notes and chapters while the player holds this
   * teaching, and the page's own fetch of them while a member is still hearing another one. See
   * `recording-content.tsx` — it is what lets the panels draw before the play control is pressed,
   * without ever showing another teaching's notes under this one's title.
   */
  const content = useRecordingContentFor(recordingId, recording, startAtMs);
  const hasChapters = (content.chapters?.length ?? 0) > 0;
  /**
   * The chapters' reflection questions, in chapter order, for the `Reflection` tab. They ride the
   * chapter list rather than the page's payload, so a teaching whose questions have not been
   * generated yet simply has none here — and no tab, the line the strip draws for every tab with
   * nothing behind it.
   */
  const questions = useMemo(() => questionsOf(content.chapters), [content.chapters]);
  const hasReflection = questions.length > 0;
  /** `About` is drawn only when there is something to read in it. */
  const hasAbout =
    recording !== null && (recording.description !== null || recording.summary !== null);
  /**
   * `Related` is drawn only for a teaching with a related moment somewhere in it — the same line
   * `Scripture` and `Chapters` draw. The groups are fetched here, once per teaching, so the strip
   * can decide before the tab is pressed; the panel filters them to the part playing.
   */
  const relatedGroups = useRelatedGroups(recordingId);
  const hasRelated = (relatedGroups?.length ?? 0) > 0;

  /**
   * **An address naming a tab the strip does not draw falls back to Notes.** `?tab=chapters` is the
   * route back from a chapter page, and a chapter page can outlive its chapter — a list regenerated
   * or merged while a member was reading one — so the address can name a tab the teaching no longer
   * has; `?tab=scripture` on a teaching that cites nothing is the same case by another road. The
   * strip decides what it draws off what the page holds, and the open tab follows that decision
   * rather than the address. The chapters case waits for the list: `null` is "not known yet", not
   * "none", and the tab is not drawn either way until it is.
   */
  useEffect(() => {
    if (recording === null) return;
    const undrawn =
      (openTab === 'about' && !hasAbout) ||
      // The reflection case waits for the chapter list too, as the chapters case does.
      (openTab === 'reflection' && content.chapters !== null && !hasReflection) ||
      (openTab === 'chapters' && content.chapters !== null && !hasChapters) ||
      (openTab === 'scripture' && !recording.hasScripture) ||
      (openTab === 'mindmap' && !recording.hasMindMap) ||
      // The related case waits for the list too: `null` is "not known yet", not "none".
      (openTab === 'related' && relatedGroups !== null && !hasRelated);
    if (!undrawn) return;
    setOpenTab('notes');
    writeTabToAddress('notes', 'notes');
  }, [content.chapters, hasAbout, hasChapters, hasReflection, hasRelated, openTab, recording, relatedGroups]);

  /**
   * **Put the list back where it was left**, on the way back from a chapter.
   *
   * The offset is on this history entry if and only if a row was pressed on this very visit
   * (`round-trip.ts`), so a fresh open of the same address finds nothing here. It is applied the
   * moment the list is on screen — not before, because a document that does not yet hold the rows
   * has nowhere to scroll to — and in a layout effect so the jump lands before that first paint: an
   * effect after it would show the member the top of the list for a frame and then move them.
   * Once, because an admin's edit can rewrite the list afterwards and that is not a return.
   */
  const listRestored = useRef(false);
  useLayoutEffect(() => {
    if (listRestored.current || recording === null || openTab !== 'chapters' || !hasChapters) {
      return;
    }
    listRestored.current = true;
    const offset = listOffsetLeftHere();
    if (offset !== null) window.scrollTo(0, offset);
  }, [hasChapters, openTab, recording]);

  /**
   * The band holds the back control and is drawn before the teaching arrives, so the cover is read
   * defensively here rather than inside the branch that renders the loaded page.
   */
  const cover = recording?.series?.artworkUrl ?? null;

  /**
   * **The band keeps the cover's proportion while the page is still loading.** Most studies have a
   * cover, so the likeliest shape is the 3:1 band; drawing the coverless strip first and growing
   * it when the payload lands moved everything below it on nearly every open. A study that turns
   * out to have no cover settles to the strip once that is known — and so does a page that could
   * not be loaded, which has nothing to reserve room for.
   */
  const covered = cover !== null || (recording === null && failure === null);

  /**
   * **Where back lands when there is no history to step through**: the study this teaching is part
   * of, and the dashboard only for a teaching that is in none.
   *
   * It is the same destination the breadcrumb's parent segment points at, read off the same field of
   * the same payload — so the two controls that mean "up from here" cannot disagree. The label names
   * that fallback, because it is the one destination the control is sure of before it is pressed.
   *
   * A teaching in no series goes to the dashboard, because there is no study page to return to and
   * the library that used to stand in is gone (the operator's decision); that is the ordinary case
   * rather than a degraded one, exactly as the missing cover above is. The same fallback covers the
   * moment before the payload lands, when the band is already drawn and there is nothing yet to
   * know — the breadcrumb draws its two segments in that window for the same reason.
   */
  const series = recording?.series ?? null;
  const back =
    series === null
      ? { href: DASHBOARD_PAGE_PATH, label: 'Back to the dashboard' }
      : { href: seriesPagePath(series.id), label: `Back to ${series.title}` };

  return (
    <>
      <div className={`${styles.hero}${covered ? ` ${styles.heroCovered}` : ''}`}>
        {/*
          The cover of the *series* this teaching is in — a recording has none of its own (scope
          prd 3.2.3). A teaching in no series has no ref to read one from, which is 3.2.6's case
          here and is ordinary rather than degraded.
        */}
        {cover === null ? null : (
          <>
            <img className={styles.heroArt} src={cover} alt="" />
            <span className={styles.heroFade} aria-hidden="true" />
          </>
        )}
        <BackRoute className={styles.back} fallbackHref={back.href} aria-label={back.label}>
          <span aria-hidden="true">‹</span>
        </BackRoute>
      </div>

      {failure === null ? null : <p className={styles.failure}>{failure}</p>}

      {recording === null ? (
        failure === null ? (
          <p className={styles.quiet}>Loading the teaching…</p>
        ) : null
      ) : (
        <>
          <header className={styles.detailHead}>
            {/*
              The one filled circle on this screen, exactly where the reference puts it. It is the
              same player the docked bar drives — pressing either is pressing the same element.
            */}
            <button
              className={styles.detailPlay}
              type="button"
              aria-label={isCurrent && player.playing ? 'Pause' : 'Play'}
              onClick={() =>
                isCurrent
                  ? player.toggle()
                  : // The transport holds a different teaching (it was playing when this page
                    // arrived, so the page left it alone). The press is the decision: this
                    // teaching takes the player over, at the stored position, playing.
                    player.openAndPlay(toLoaded(recording), startAtMs)
              }
            >
              <span aria-hidden="true">{isCurrent && player.playing ? '❚❚' : '▶'}</span>
            </button>
            <div className={styles.detailText}>
              <h1 className={styles.detailTitle}>{recording.title}</h1>
              <p className={styles.detailMeta}>Recorded {formatDay(recording.recordedAt)}</p>
              {/*
                The teaching's tags, as labels under the date ([4.7](docs/project/prd.md)) — read
                off the payload, so a teaching opened from a link shows the same labels as one
                walked to. Nothing at all for a teaching with none, which is most of them.
              */}
              <TagLabels tags={recording.tags} />
            </div>
            <DownloadControl recordingId={recordingId} title={recording.title} />
          </header>

          {/*
            `pages/recording.png`'s strip, same pill shape and same spacing. The order is `Notes`,
            then `About`, then `Chapters`, then `Scripture` — the reference draws `Scripture` first,
            but `Notes` is the tab a member returns to and the one entry that is always there, so it
            takes the first slot rather than moving whenever a teaching happens to cite nothing.
            `About` sits beside it because it is what a member reads before anything else here.
            `Mindmap` and `Related` are entries here, not different controls.

            Every tab takes the same selected state — the purple every other selected thing takes.
            `Notes` used to carry a pencil and the notes green here; the operator took both out, so
            the strip reads as one control with no entry claiming to be a different kind of thing.
          */}
          {/*
            **The strip and its panels do not wait for this teaching to hold the player.** A member
            still hearing another teaching reads this one's notes and chapters all the same: the
            panels draw from `content`, which is the page's own fetch of *this* teaching while the
            player holds a different one, so nothing under this title can be another recording's.
            Nothing under the strip starts sound either — the play control above is what hands the
            player over, and until it is pressed the other teaching keeps playing.
          */}
          <RecordingContentProvider value={content}>
          <div className={styles.tabGrid} role="tablist" aria-label="Teaching contents">
            <button
              className={styles.tabTile}
              type="button"
              role="tab"
              aria-selected={openTab === 'notes'}
              onClick={() => chooseTab('notes')}
            >
              <span className={styles.tabTileIcon}>
                <NotesIcon size={22} />
              </span>
              Notes
            </button>
            {/*
              **Description first, then summary**, behind one tab. The description is what an admin
              wrote *about* this teaching — a line or two, chosen, and the same text the library row
              carries. The summary is generated from what was actually said, two paragraphs of it;
              it answers a question the description has just raised rather than the other way
              round. Absent entirely for a teaching that has neither — the line the strip draws for
              every tab with nothing behind it.
            */}
            {hasAbout ? (
              <button
                className={styles.tabTile}
                type="button"
                role="tab"
                aria-selected={openTab === 'about'}
                onClick={() => chooseTab('about')}
              >
                <span className={styles.tabTileIcon}>
                  <AboutIcon size={22} />
                </span>
                About
              </button>
            ) : null}
            {/*
              **The reflection questions, a tab of their own** — one per chapter, in chapter order,
              to read rather than to answer (`reflection.tsx`). They sat under the summary inside
              `About` for a while; the operator moved them out, because a list of questions is not
              prose about the teaching and a member looking for them should find them by name.
              Absent for a teaching whose chapters have no questions yet, decided off the same list
              `Chapters` is decided off.
            */}
            {hasReflection ? (
              <button
                className={styles.tabTile}
                type="button"
                role="tab"
                aria-selected={openTab === 'reflection'}
                onClick={() => chooseTab('reflection')}
              >
                <span className={styles.tabTileIcon}>
                  <ReflectionIcon size={22} />
                </span>
                Reflection
              </button>
            ) : null}
            {/*
              Absent entirely rather than disabled for a teaching that cites nothing (3.4.4) — the
              same line the strip already draws for `Chapter` and `Mindmap`, decided off the payload
              the page already has rather than off a passage nobody asked for.
            */}
            {/*
              Absent entirely for a teaching with no chapters (3.22.10) — the same line, decided off
              the list the page already holds rather than off a flag on the recording payload,
              because that list is fetched when the teaching is opened regardless (3.22.16) and a
              second answer to "does this teaching have chapters" could disagree with the first.
            */}
            {hasChapters ? (
              <button
                className={styles.tabTile}
                type="button"
                role="tab"
                aria-selected={openTab === 'chapters'}
                onClick={() => chooseTab('chapters')}
              >
                <span className={styles.tabTileIcon}>
                  <ChaptersIcon size={22} />
                </span>
                Chapters
              </button>
            ) : null}
            {recording.hasScripture ? (
              <button
                className={styles.tabTile}
                type="button"
                role="tab"
                aria-selected={openTab === 'scripture'}
                onClick={() => chooseTab('scripture')}
              >
                <span className={styles.tabTileIcon}>
                  <ScriptureIcon size={22} />
                </span>
                Scripture
              </button>
            ) : null}
            {/*
              `Transcript` is always drawn: every published teaching has been transcribed (3.5.1),
              so unlike `Chapters` and `Scripture` there is no payload fact to decide it on, and the
              panel states the empty case itself for the rare teaching whose transcript is not there
              yet. It was hidden for a while by operator decision — commented in place rather than
              dropped, with `transcript-screen.test.ts` and `transcript-correction-screen.test.ts`
              skipped alongside — and bringing it back was this element and those two un-skips.
            */}
            <button
              className={styles.tabTile}
              type="button"
              role="tab"
              aria-selected={openTab === 'transcript'}
              onClick={() => chooseTab('transcript')}
            >
              <span className={styles.tabTileIcon}>
                <TranscriptIcon size={22} />
              </span>
              Transcript
            </button>
            {/*
              `Mindmap`, last as the reference draws it, and **drawn only for a teaching whose map
              an admin has approved** ([3.8.2](docs/project/prd.md), [3.8.3](docs/project/prd.md))
              — the same line `Scripture` draws, decided off the same payload flag.
            */}
            {recording.hasMindMap ? (
              <button
                className={styles.tabTile}
                type="button"
                role="tab"
                aria-selected={openTab === 'mindmap'}
                onClick={() => chooseTab('mindmap')}
              >
                <span className={styles.tabTileIcon}>
                  <MindmapIcon size={22} />
                </span>
                Mindmap
              </button>
            ) : null}
            {/*
              `Related` — the moments in other teachings anchored to the part playing (3.9.2) —
              last, and **drawn only for a teaching with a related moment somewhere in it**: the
              strip decides off the groups fetched above, and the panel narrows them to the chapter
              playing. It used to be a strip above the tabs that drew nothing until it had something
              to say; as a tab, the empty part is stated inside the panel instead.
            */}
            {hasRelated ? (
              <button
                className={styles.tabTile}
                type="button"
                role="tab"
                aria-selected={openTab === 'related'}
                onClick={() => chooseTab('related')}
              >
                <span className={styles.tabTileIcon}>
                  <RelatedIcon size={22} />
                </span>
                Related
              </button>
            ) : null}
          </div>

          {/*
            **One wrapper around whichever panel is open**, and the thing whose height is held
            across a swap — see `floorPx` above. It is drawn while a tab is open and while a floor
            is still being held for a tab that has just closed, and not at all otherwise: an empty
            element left in the column would spend a gap on nothing.
          */}
          {openTab === null && floorPx === 0 ? null : (
            <div
              ref={panelRegion}
              style={floorPx === 0 ? undefined : { minHeight: `${floorPx}px` }}
            >
              {openTab === 'notes' ? (
                <NotesPanel recordingId={recordingId} canModerate={canModerate} />
              ) : null}

              {/*
                Both blocks are shown whole, with nothing to open: a description is two or three
                sentences and a summary two paragraphs by generation, so a clamp would hide a few
                lines behind a control that costs a press to get them back.
              */}
              {openTab === 'about' && hasAbout ? (
                <div className={styles.aboutPanel}>
                  {recording.description === null ? null : (
                    <section className={styles.card} aria-label="Description">
                      <h2 className={styles.cardTitle}>Description</h2>
                      <p className={styles.prose}>{recording.description}</p>
                    </section>
                  )}
                  {recording.summary === null ? null : (
                    <section className={styles.card} aria-label="Summary">
                      <h2 className={styles.cardTitle}>Summary</h2>
                      <p className={styles.prose}>{recording.summary}</p>
                    </section>
                  )}
                </div>
              ) : null}

              {/* Guarded as its tab is: the address can name this panel before the list has arrived. */}
              {openTab === 'reflection' && hasReflection ? (
                <ReflectionCard questions={questions} />
              ) : null}

              {/* Guarded as its tab is: the address can name this panel before the list has arrived. */}
              {openTab === 'chapters' && hasChapters ? (
                <ChaptersPanel recordingId={recordingId} canEdit={canEditChapters} />
              ) : null}

              {openTab === 'scripture' ? <ScripturePanel recordingId={recordingId} /> : null}

              {openTab === 'transcript' ? (
                <TranscriptPanel recordingId={recordingId} canCorrect={canCorrect} />
              ) : null}

              {openTab === 'mindmap' && recording.hasMindMap ? (
                <MindMapPanel recordingId={recordingId} />
              ) : null}

              {openTab === 'related' && hasRelated && relatedGroups !== null ? (
                <RelatedTeachings recordingId={recordingId} groups={relatedGroups} />
              ) : null}
            </div>
          )}
          </RecordingContentProvider>
        </>
      )}
    </>
  );
}

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function formatDay(iso: string): string {
  const parsed = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? iso : DAY.format(parsed);
}
