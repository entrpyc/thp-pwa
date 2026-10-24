'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { formatTimecode, monogramFor, recordingPagePath, type NoteView } from '@thp/shared';
import { segmentAt } from '@/client/transcript/current-segment';
import { NoteImages } from '../recordings/[id]/note-images';
import { ScripturePanel } from '../recordings/[id]/scripture-panel';
import { useBreadcrumbTrail, usePlayer } from '../player-context';
import { notesNear } from './notes-near';
import styles from './now-playing.module.css';

/**
 * **The now-playing view** — the screen for *this moment* of the teaching.
 *
 * Everything on it answers one question: what is being said right now, and what has been written
 * about it? The cover is a backdrop rather than the subject — blurred, dimmed and filling the top of
 * the screen so that the line being spoken can be read large across it. Under the hero, the notes
 * anchored near the playhead; under those, the teaching's scripture. (Mind maps and time-anchored
 * scripture come later; for now the scripture panel is the recording page's own, unfiltered.)
 *
 * **It owns no playback state and renders no transport control** (scope prd 3.3.4; scope tdd 1.7).
 * What is playing is read from the same player context the docked bar reads, and the docked bar is
 * still on screen underneath this view — so play, pause, seek and speed are one control each in the
 * whole product rather than two that can disagree. That is also why opening and closing this view
 * cannot interrupt the audio: the element is mounted in the member layout and this route is a
 * sibling of the one the member came from, so neither transition unmounts anything.
 *
 * **Captions are always on here, whatever the pill's switch says.** The view asks the player for
 * the transcript and the finer caption clock through `attendCaptions` without touching the switch;
 * the transport keeps drawing its pill here as on every other screen when the switch is on, so the
 * bar is the same bar wherever it is docked. Between lines the previous line stays, dimmed, so a
 * pause in the voice is not a flash of empty hero.
 *
 * **Notes are read, not written.** A card is the author, the moment, the whole text and its
 * pictures; pressing it opens the teaching's Notes tab, where the composer, replies, reactions and
 * the rest already live. The row is gone entirely when nothing is near — a heading over an empty
 * list would be a promise about a quiet stretch.
 *
 * **Closing goes back rather than to a fixed screen** (scope prd 3.3.1). A member reaches this from
 * the transport, and the transport travels — so the only honest destination is wherever they were.
 */
export function NowPlayingScreen() {
  const player = usePlayer();
  const router = useRouter();
  const loaded = player.loaded;

  useBreadcrumbTrail(loaded?.title ?? null, [], 'recording');

  // Fetch the transcript and run the caption clock for as long as this view is mounted.
  useEffect(() => player.attendCaptions(), [player.attendCaptions]);

  const spoken =
    player.transcript === null || loaded === null || player.transcript.recordingId !== loaded.id
      ? null
      : segmentAt(player.transcript.segments, player.currentMs);
  const spokenText = spoken === null || spoken.text.trim() === '' ? null : spoken.text;

  /*
   * The last line that had words, kept for the gaps. Keyed by teaching so a line from the previous
   * recording cannot outlive a change of teaching, and refreshed whenever a new line is spoken.
   */
  const [held, setHeld] = useState<{ recordingId: string; text: string } | null>(null);
  useEffect(() => {
    if (loaded !== null && spokenText !== null) setHeld({ recordingId: loaded.id, text: spokenText });
  }, [loaded, spokenText]);
  const heldText = held !== null && loaded !== null && held.recordingId === loaded.id ? held.text : null;
  const caption = spokenText ?? heldText;
  const captionDim = spokenText === null && heldText !== null;

  const near =
    loaded === null || player.notes === null || player.notes.recordingId !== loaded.id
      ? []
      : notesNear(player.notes.notes, player.currentMs);

  return (
    <section className={styles.view} aria-label="Now playing">
      {/*
        `pages/player.png` prints no title, and a screen with no heading at all is a screen a screen
        reader cannot summarise — so the teaching names the view without being drawn. The chapter
        playing is named **on the same footing as the recording** ([3.22.19](docs/project/prd.md)),
        which here means in the same heading. A teaching with no chapters keeps the heading it had.
      */}
      <h1 className={styles.hiddenTitle}>
        {loaded === null
          ? 'Now playing'
          : player.currentChapter === null
            ? loaded.title
            : `${loaded.title} — ${player.currentChapter.title}`}
      </h1>

      <div className={styles.hero}>
        {/*
          The cover as a backdrop — **labelled** with the series, like the transport's tile and
          unlike every cover that sits beside its own title: nothing else on this view says which
          study this is (scope prd 4.3). A teaching in no series, or in one with no cover, draws the
          hero on the page's own surface rather than on a placeholder (scope prd 3.3.5).
        */}
        {loaded === null || loaded.artworkUrl === null ? null : (
          <img className={styles.heroArt} src={loaded.artworkUrl} alt={loaded.seriesTitle ?? ''} />
        )}
        <div className={styles.heroShade} aria-hidden="true" />

        <div className={styles.heroTop}>
          {/*
            `router.back()` rather than a link to a named screen: this view is opened from a bar
            that is on every member screen, so "where the member was" is the only destination that
            is right more than once. A view opened by its address directly has nothing of ours
            behind it, and the press then leaves the way any back press would.
          */}
          <button
            className={styles.close}
            type="button"
            aria-label="Close now playing"
            onClick={() => router.back()}
          >
            <span aria-hidden="true">‹</span>
          </button>
        </div>

        <div className={styles.heroBody}>
          {loaded === null ? (
            // Reachable by opening the address before anything has been played — the transport is
            // not on screen either in that state, so saying so is the whole of the answer.
            <p className={styles.quiet}>Nothing is playing yet. Open a teaching to start listening.</p>
          ) : caption === null ? null : (
            <p
              className={`${styles.caption}${captionDim ? ` ${styles.captionDim}` : ''}`}
              aria-live="polite"
            >
              {caption}
            </p>
          )}
        </div>

        {/*
          **The chapter playing, named where a member can see it** ([3.22.19](docs/project/prd.md)).
          The heading above carries both names for a screen reader; this is the visible half, and it
          is the chapter alone because the teaching is already named on the transport underneath. A
          teaching with no chapters draws nothing here rather than an empty line (3.22.4).
        */}
        {player.currentChapter === null ? null : (
          <p className={styles.heroChapter}>{player.currentChapter.title}</p>
        )}
      </div>

      {loaded === null ? null : (
        <>
          {near.length === 0 ? null : (
            <section className={styles.notesRow} aria-label="Notes near this moment">
              <h2 className={styles.rowTitle}>Notes near this moment</h2>
              <ul className={styles.notes}>
                {near.map((note) => (
                  <NearNote key={note.id} note={note} recordingId={loaded.id} />
                ))}
              </ul>
            </section>
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

/**
 * One note near the playhead, read-only.
 *
 * The author line, the moment and the text are one link to the teaching's Notes tab — the surface
 * that can do something about the note. The pictures sit outside the link, because each already
 * opens its own viewer and a control inside a link is two presses competing for one finger.
 */
function NearNote({ note, recordingId }: { note: NoteView; recordingId: string }) {
  return (
    <li className={styles.note}>
      <Link className={styles.noteLink} href={`${recordingPagePath(recordingId)}?tab=notes`}>
        <span className={styles.noteHead}>
          {note.authorAvatarUrl === null ? (
            <span className={styles.monogram} aria-hidden="true">
              {monogramFor(note.authorDisplayName)}
            </span>
          ) : (
            <img className={styles.avatar} src={note.authorAvatarUrl} alt="" />
          )}
          <span className={styles.noteAuthor}>{note.authorDisplayName}</span>
          <span className={styles.noteTime}>
            {note.timestampMs === null ? '' : formatTimecode(note.timestampMs)}
          </span>
        </span>
        {note.text === '' ? null : <span className={styles.noteText}>{note.text}</span>}
      </Link>
      {note.images.length === 0 ? null : <NoteImages images={note.images} />}
    </li>
  );
}
