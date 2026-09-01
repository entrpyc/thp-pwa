'use client';

import { useRouter } from 'next/navigation';
import { ScripturePanel } from '../recordings/[id]/scripture-panel';
import { useBreadcrumbTrail, usePlayer } from '../player-context';
import styles from './now-playing.module.css';

/**
 * **The now-playing view** — `pages/player.png`.
 *
 * The reference draws exactly two things and this builds exactly those two: a large square cover,
 * and the teaching's scripture references beneath it (scope prd 3.3.2, 3.3.3). Nothing else from
 * the recording page comes with them — no notes, no transcript, no summary, no mind map — because
 * `pages/player.png` draws none of them and scope prd § 5 rules them out by name.
 *
 * **It owns no playback state and renders no transport control** (scope prd 3.3.4; scope tdd 1.7).
 * What is playing is read from the same player context the docked bar reads, and the docked bar is
 * still on screen underneath this view — so play, pause, seek and speed are one control each in the
 * whole product rather than two that can disagree. That is also why opening and closing this view
 * cannot interrupt the audio: the element is mounted in the member layout and this route is a
 * sibling of the one the member came from, so neither transition unmounts anything.
 *
 * **Closing goes back rather than to a fixed screen** (scope prd 3.3.1). A member reaches this from
 * the transport, and the transport travels — the screen behind it is the library on one press and a
 * series page on the next, so the only honest destination is wherever they were.
 *
 * **Nothing is fetched here for the cover.** It arrived with the teaching when it was opened, on
 * the loaded recording (scope plan 2.4), and it is the *series'* cover — a teaching in no series
 * has none, and the view renders without one rather than substituting a placeholder (scope prd
 * 3.3.5).
 */
export function NowPlayingScreen() {
  const player = usePlayer();
  const router = useRouter();
  const loaded = player.loaded;

  useBreadcrumbTrail(loaded?.title ?? null);

  return (
    <section className={styles.view} aria-label="Now playing">
      <div className={styles.head}>
        {/*
          `router.back()` rather than a link to a named screen: this view is opened from a bar that
          is on every member screen, so "where the member was" is the only destination that is right
          more than once. A view opened by its address directly has nothing of ours behind it, and
          the press then leaves the way any back press would.
        */}
        <button
          className={styles.close}
          type="button"
          aria-label="Close now playing"
          onClick={() => router.back()}
        >
          <span aria-hidden="true">‹</span>
        </button>
        {/*
          `pages/player.png` prints no title, and a screen with no heading at all is a screen a
          screen reader cannot summarise — so the teaching names the view without being drawn.
        */}
        {/*
          The chapter playing is named **on the same footing as the recording**
          ([3.22.19](docs/project/prd.md)), which here means in the same heading: the teaching and
          the part of it that is playing, read as one name by anybody who cannot see the screen.
          A teaching with no chapters keeps exactly the heading it had.
        */}
        <h1 className={styles.hiddenTitle}>
          {loaded === null
            ? 'Now playing'
            : player.currentChapter === null
              ? loaded.title
              : `${loaded.title} — ${player.currentChapter.title}`}
        </h1>
      </div>

      {loaded === null ? (
        // Reachable by opening the address before anything has been played — the transport is not
        // on screen either in that state, so saying so is the whole of the answer.
        <p className={styles.quiet}>Nothing is playing yet. Open a teaching to start listening.</p>
      ) : (
        <>
          {/*
            The square of `pages/player.png` (scope prd 3.3.2) — **labelled** with the series, like
            the transport's tile and unlike every cover that sits beside its own title: nothing on
            this view says which study this is, so 4.3 asks for the name here rather than for
            silence. A teaching in no series, or in one with no cover, draws nothing at all rather
            than an empty frame (scope prd 3.3.5).
          */}
          {loaded.artworkUrl === null ? null : (
            <img
              className={styles.cover}
              src={loaded.artworkUrl}
              alt={loaded.seriesTitle ?? ''}
            />
          )}

          {/*
            **The chapter playing, named where a member can see it**
            ([3.22.19](docs/project/prd.md)).

            The heading above carries both names for a screen reader; this is the visible half, and
            it is the chapter alone because the teaching is already named on the transport that is
            still on screen underneath this view. A teaching with no chapters draws nothing here
            rather than an empty line — the same line every surface in this scope draws for a
            teaching too short to divide (3.22.4).
          */}
          {player.currentChapter === null ? null : (
            <p className={styles.chapter}>{player.currentChapter.title}</p>
          )}

          {/*
            The recording page's own panel, mounted here unchanged (scope tdd 1.7). It reads the
            same route under the same rules, so a reference a member sees here and a reference they
            see on the teaching's page cannot differ — including the empty case, which the panel
            states rather than leaving as blank space (scope prd 3.3.6).
          */}
          <ScripturePanel recordingId={loaded.id} />
        </>
      )}
    </section>
  );
}
