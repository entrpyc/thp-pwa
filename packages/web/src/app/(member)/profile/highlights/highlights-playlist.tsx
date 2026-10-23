'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  formatTimecode,
  recordingProgressPath,
  seriesPagePath,
  type HighlightView,
  type PlaybackProgressPayload,
} from '@thp/shared';
import { apiFetch } from '@/client/api-client';
import { useHighlights } from '../../highlights/highlights-store';
import { highlightHref } from '../../highlights/open-at';
import { usePlayer } from '../../player-context';
import profile from '../profile.module.css';
import styles from './highlights.module.css';

/**
 * **The playlist** ([3.15.6](docs/project/prd.md)) — every entry the member pinned, newest first,
 * each with its title, its series, the date it was pinned, and the note's text or a line about
 * the moment.
 *
 * **It reads what the API answers and decides nothing.** The order is the server's, and every
 * Remove renders the list the `DELETE` answered rather than dropping a row by hand — so a screen
 * that was stale when the button was pressed is right after it ([3.15.8](docs/project/prd.md)).
 *
 * **Two ways to open an entry, and only one of them makes sound** ([3.15.7](docs/project/prd.md),
 * [3.2.12](docs/project/prd.md)): the row is a link to the teaching's page *at the entry's moment*,
 * and opening a page is never a decision about sound; the play control beside it loads the
 * teaching into the docked transport at that moment and plays, staying on this list — the way a
 * chapter row's play control works — so a member can work through their Highlights without
 * leaving them. A whole-teaching entry has no moment of its own, so its play control asks for the
 * member's stored position first and resumes there, which is what pressing play on that teaching
 * does everywhere else.
 *
 * **Remove takes no confirmation.** It is one press to undo — the pin control on the teaching, the
 * moment or the note — and nothing is lost in between: the entry pointed at content that is still
 * exactly where it was.
 */

const PINNED = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function pinnedOn(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : PINNED.format(parsed);
}

/**
 * The line under the title: the note's text for a note, the transcript line for a snapped moment,
 * and the admin's description for a whole teaching — or, for a moment with no line under it, the
 * timecode alone, which is all the entry knows.
 */
function describe(entry: HighlightView): string | null {
  if (entry.note !== null) return entry.note.text;
  if (entry.segment !== null) return entry.segment.text;
  if (entry.kind === 'segment' && entry.positionMs !== null) {
    return `From ${formatTimecode(entry.positionMs)}`;
  }
  return entry.recording.description;
}

function kindLabel(entry: HighlightView): string {
  switch (entry.kind) {
    case 'note':
      return 'Note';
    case 'segment':
      return 'Moment';
    default:
      return 'Teaching';
  }
}

export function HighlightsPlaylist() {
  const player = usePlayer();
  const { highlights, busy, failure, unpin } = useHighlights();
  const [playFailure, setPlayFailure] = useState<string | null>(null);

  async function play(entry: HighlightView): Promise<void> {
    setPlayFailure(null);
    const { recording } = entry;
    let at = entry.positionMs;
    if (at === null) {
      // A whole teaching resumes where the member had got to (3.2.12). The position is asked for
      // at the press rather than carried on every row: most rows are never played from here.
      try {
        const progress = await apiFetch<PlaybackProgressPayload>(
          recordingProgressPath(recording.id),
          { credentials: 'include' },
        );
        at = progress.positionMs;
      } catch {
        at = null;
      }
    }
    if (player.loaded?.id === recording.id) {
      // Already in the transport: seek there and play, or just play where it is.
      if (at !== null) player.playFromMs(at);
      else if (!player.playing) player.toggle();
      return;
    }
    player.openAndPlay(
      {
        id: recording.id,
        title: recording.title,
        artworkUrl: recording.series?.artworkUrl ?? null,
        seriesTitle: recording.series?.title ?? null,
        seriesId: recording.series?.id ?? null,
      },
      at,
    );
  }

  return (
    <section className={profile.card} aria-label="Highlights playlist">
      {highlights === null && failure === null ? (
        <p className={profile.quiet} role="status">
          Loading…
        </p>
      ) : null}

      {highlights !== null && highlights.length === 0 ? (
        <p className={profile.done} role="status">
          Nothing pinned yet. Pin a teaching from its page or a series, a moment from the player,
          or one of your notes from its menu.
        </p>
      ) : null}

      {highlights !== null && highlights.length > 0 ? (
        <ol className={styles.list} aria-label="Pinned entries">
          {highlights.map((entry) => {
            const description = describe(entry);
            const title = entry.recording.title;
            return (
              <li className={styles.entry} key={entry.id}>
                <Link
                  className={styles.open}
                  href={highlightHref(entry.recording.id, entry.positionMs)}
                  aria-label={`Open ${title}${entry.positionMs === null ? '' : ` at ${formatTimecode(entry.positionMs)}`}`}
                >
                  <span className={styles.kind}>{kindLabel(entry)}</span>
                  <span className={styles.title}>{title}</span>
                  {description === null ? null : (
                    <span className={styles.description}>{description}</span>
                  )}
                  <span className={styles.meta}>
                    {entry.positionMs === null ? null : `${formatTimecode(entry.positionMs)} · `}
                    Pinned {pinnedOn(entry.pinnedAt)}
                  </span>
                </Link>
                {/* The series as its own link, beside the row rather than inside it (the library's shape). */}
                {entry.recording.series === null ? null : (
                  <Link className={styles.series} href={seriesPagePath(entry.recording.series.id)}>
                    {entry.recording.series.title}
                  </Link>
                )}
                <div className={styles.controls}>
                  <button
                    className={styles.play}
                    type="button"
                    aria-label={`Play ${title}`}
                    onClick={() => void play(entry)}
                  >
                    <span aria-hidden="true">▶</span>
                  </button>
                  <button
                    className={profile.secondary}
                    type="button"
                    aria-label={`Remove ${title} from Highlights`}
                    disabled={busy}
                    onClick={() => void unpin(entry.id).catch(() => undefined)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}

      {failure === null ? null : <p className={profile.failure}>{failure}</p>}
      {playFailure === null ? null : <p className={profile.failure}>{playFailure}</p>}
    </section>
  );
}
