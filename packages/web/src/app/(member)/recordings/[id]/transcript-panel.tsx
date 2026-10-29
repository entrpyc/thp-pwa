'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import {
  formatTimecode,
  isInChapter,
  recordingSummaryRegeneratePath,
  transcriptSegmentPath,
  type CorrectSegmentPayload,
  type TranscriptSegmentView,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { track } from '@/client/observability/analytics';
import { shellPlatform } from '@/client/platform';
import { segmentAt } from '@/client/transcript/current-segment';
import { transcriptFileName, transcriptFileText } from '@/client/transcript/transcript-file';
import { DownloadIcon } from '../../downloads/download-icon';
import { momentEntry } from '../../highlights/highlights-lookup';
import { useHighlights } from '../../highlights/highlights-store';
import { MarkerIcon } from '../../highlights/marker-icon';
import pins from '../../highlights/highlights.module.css';
import { usePlayer } from '../../player-context';
import styles from './transcript.module.css';

/**
 * **The `Transcript` tab of `pages/recording.png`** — the transcript a member reads along with.
 *
 * Its behaviours, and each is a line in the reference or a sentence in
 * [3.5.3](docs/project/prd.md)–[3.5.4](docs/project/prd.md):
 *
 * - **The line being spoken is highlighted**, driven off the player context's `currentMs` — the
 *   position the element already reports on `timeupdate` and `seeked`. No second timer, and no
 *   second idea of where the teaching is.
 * - **Selecting a line seeks there.** Every line is a real button, so the transcript is walkable
 *   and operable from a keyboard, and it calls the player's `seekToMs` rather than touching the
 *   element. It does **not** start playback: a member reading a paused teaching has not asked for
 *   sound, which is the rule opening a recording already follows.
 * - **A header above the lines holds the reading controls.** *Follow along* is a switch: on, the
 *   view keeps the highlighted row centred; a member-initiated scroll turns it off, because a
 *   member who has scrolled away has said where they want to be and a view that dragged them back
 *   would be fighting them. Selecting any line turns it back on. *Jump to current* beside it
 *   centres the highlighted row once, and leaves the switch where it was — a member who has
 *   stopped following and wants one look at the line playing has not asked to be followed again.
 *   Scrolling this component did itself does not count as a member scroll — see
 *   {@link scrollToCurrent}. At the header's far end, *Download* hands the lines over as a file.
 * - **Every line carries the highlighter** ([3.15.2](docs/project/prd.md)): the same marker the
 *   transport's tool and the chapter header draw, pinning that line's start, which the server snaps
 *   to the line itself — so a line pinned here and the same line pinned while it played are one
 *   entry, and the row reads highlighted the moment the store answers.
 * - **An admin corrects a line in place** ([3.5.5](docs/project/prd.md)) and is then offered a
 *   summary and a set of scripture references built on the corrected words
 *   ([3.5.6](docs/project/prd.md), scope prd 3.1.10). The offer never fires by
 *   itself, and declining it does nothing at all.
 *
 * `canCorrect` hides the affordance and grants nothing: the API is what refuses a member, which is
 * the standing constraint of
 * core-listening scope plan § Standing constraints.
 */
export function TranscriptPanel({
  recordingId,
  canCorrect,
  chapterId = null,
}: {
  recordingId: string;
  canCorrect: boolean;
  /**
   * **The chapter this panel is scoped to**, or `null` for the whole teaching
   * ([3.22.14](docs/project/prd.md)).
   *
   * When it is set the lines are narrowed **here rather than by a second fetch**: the provider holds
   * the whole transcript, because the caption pill needs it wherever the member is, and a scoped
   * request would download the teaching's words twice. The narrowing rule is `isInChapter` — the
   * same half-open interval the API scopes its own read by (project tdd 5.9), so the tab and the
   * route bucket a line identically.
   *
   * Because a boundary always sits on a segment's start ([3.22.5](docs/project/prd.md)), the
   * transcript "stops at its boundaries" exactly: no line is ever cut in half by one.
   */
  chapterId?: string | null;
}) {
  const player = usePlayer();
  const { highlights, busy, toggle } = useHighlights();
  const listRef = useRef<HTMLOListElement>(null);
  const [following, setFollowing] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [offered, setOffered] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  /**
   * The scroll position this component last set.
   *
   * Auto-scrolling fires a `scroll` event exactly like a finger does, and a component that could
   * not tell them apart would suspend its own following on the first tick. Comparing against what
   * was written — read back after the assignment, so a clamped value still matches — is what
   * separates the two without a timer.
   */
  const ourScrollTop = useRef<number | null>(null);

  const { requestTranscript } = player;
  useEffect(() => {
    // Called on every mount; the provider answers it once per loaded recording.
    requestTranscript();
  }, [requestTranscript]);

  /*
   * **Narrowed to the chapter's span when the page asked for one**
   * ([3.22.14](docs/project/prd.md)). `isInChapter` is the rule, and it is the same call the API
   * makes when it scopes its own read — so the tab and the route bucket a line identically without
   * either sending the other a boundary (project tdd 5.9).
   *
   * `scope` is `null` when the chapter is not in the list yet, and the whole transcript is what is
   * shown until it arrives. That is the honest fallback: showing nothing would make a slow chapter
   * fetch look like a chapter with no words in it.
   */
  const scope =
    chapterId === null
      ? null
      : (player.chapters?.chapters.find((one) => one.id === chapterId) ?? null);

  const all = player.transcript?.segments ?? null;
  const segments =
    all === null || scope === null ? all : all.filter((one) => isInChapter(scope, one.startMs));

  // The highlight follows the player over the *whole* teaching and is simply absent while playback
  // is outside this chapter — which is right: the line being spoken is not in this chapter's list.
  const current = segments === null ? null : segmentAt(segments, player.currentMs);
  const currentId = current?.id ?? null;

  /**
   * A line the member has highlighted reads in the highlights orange ([3.15.2](docs/project/prd.md)),
   * and its marker reads pressed. The entry covers the line it was snapped to, so asking about the
   * line's start is asking whether that line is one of theirs — the same question the transport's
   * marker asks, and the entry the row's marker removes when pressed again.
   */
  const entryOf = (segment: TranscriptSegmentView) =>
    highlights === null ? null : momentEntry(highlights, recordingId, segment.startMs);

  /**
   * Centre the highlighted row in the list, without scrolling the page around it.
   *
   * The row's place is measured against the list's own box rather than read off `offsetTop`: that
   * property answers relative to the nearest *positioned* ancestor, which the list is not, so it
   * described the row's place on the page and the view landed wherever that happened to be.
   */
  const scrollToCurrent = useCallback((): void => {
    const list = listRef.current;
    if (list === null || currentId === null) return;
    const row = list.querySelector<HTMLElement>(`[data-segment="${currentId}"]`);
    if (row === null) return;

    // Written rather than `scrollIntoView`, because that also scrolls every ancestor — including
    // the page — and the transcript following itself must not move the rest of the screen.
    const rowTop = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    list.scrollTop = rowTop - (list.clientHeight - row.clientHeight) / 2;
    ourScrollTop.current = list.scrollTop;
  }, [currentId]);

  useEffect(() => {
    if (following) scrollToCurrent();
  }, [following, scrollToCurrent]);

  const onScroll = useCallback((): void => {
    const list = listRef.current;
    if (list === null) return;
    if (ourScrollTop.current !== null && Math.abs(list.scrollTop - ourScrollTop.current) <= 1) {
      return;
    }
    ourScrollTop.current = null;
    setFollowing(false);
  }, []);

  const select = useCallback(
    (segment: TranscriptSegmentView): void => {
      track('transcript_acted', { action: 'row_clicked', recording_id: recordingId });
      player.seekToMs(segment.startMs);
      // Selecting a line is a member saying where they want to be, which is the clearest possible
      // signal that they want the transcript to keep up again.
      setFollowing(true);
    },
    [player],
  );

  /**
   * Hand the lines on screen over as a file — the chapter's on the chapter page, the teaching's on
   * the recording page, named for whichever it is.
   *
   * In a browser an anchor with `download` is the whole mechanism. Inside the store shell a WebView
   * does nothing with such an anchor, so the file is written to the app's Documents through the
   * same plugin the offline downloads use, and the line below the header says where it went —
   * there is no save dialog to say it for us.
   */
  const download = useCallback(async (): Promise<void> => {
    if (segments === null) return;
    const text = transcriptFileText(segments);
    const name = transcriptFileName(player.loaded?.title ?? '', scope?.title ?? null);
    setFailure(null);
    setSaved(null);
    try {
      if (shellPlatform() !== null) {
        await Filesystem.writeFile({
          path: name,
          data: text,
          directory: Directory.Documents,
          encoding: Encoding.UTF8,
          recursive: true,
        });
        setSaved(`Saved to your Documents as ${name}.`);
        return;
      }
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = name;
        anchor.rel = 'noopener';
        anchor.click();
      } finally {
        // The click has handed the URL to the browser's downloader; revoking on the next tick
        // keeps the blob alive long enough for it to be read.
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch {
      setFailure('Could not save the transcript. Try again in a moment.');
    }
  }, [segments, player.loaded?.title, scope?.title]);

  if (segments === null) {
    return <p className={styles.quiet}>Loading the transcript…</p>;
  }

  if (segments.length === 0) {
    return <p className={styles.quiet}>This teaching has no transcript yet.</p>;
  }

  return (
    <div className={styles.panel}>
      {failure === null ? null : <p className={styles.failure}>{failure}</p>}

      {offered ? (
        <RegenerationOffer
          recordingId={recordingId}
          onDismiss={() => setOffered(false)}
          onFailure={setFailure}
        />
      ) : null}

      <div className={styles.header}>
        <div className={styles.headerGroup}>
          <button
            className={styles.switch}
            type="button"
            role="switch"
            aria-checked={following}
            onClick={() => {
              track('transcript_acted', { action: following ? 'follow_off' : 'follow_on', recording_id: recordingId });
              setFollowing((on) => !on);
            }}
          >
            <span className={styles.switchKnob} aria-hidden="true" />
            <span>Follow along</span>
          </button>
          <button
            className={styles.jump}
            type="button"
            disabled={currentId === null}
            onClick={() => {
              track('transcript_acted', { action: 'jump_to_current', recording_id: recordingId });
              scrollToCurrent();
            }}
          >
            Jump to current
          </button>
        </div>
        <button
          className={styles.download}
          type="button"
          aria-label="Download transcript"
          onClick={() => {
            track('transcript_acted', { action: 'downloaded', recording_id: recordingId });
            void download();
          }}
        >
          <DownloadIcon held={false} size={18} />
          <span>Download</span>
        </button>
      </div>

      {saved === null ? null : (
        <p className={styles.quiet} role="status">
          {saved}
        </p>
      )}

      <ol className={styles.lines} ref={listRef} onScroll={onScroll} aria-label="Transcript">
        {segments.map((segment) => {
          const entry = entryOf(segment);
          const pinned = entry !== null;
          const at = formatTimecode(segment.startMs);
          return (
            <li key={segment.id} className={styles.line}>
              {editing === segment.id ? (
                <CorrectionForm
                  recordingId={recordingId}
                  segment={segment}
                  onCancel={() => setEditing(null)}
                  onSaved={(corrected) => {
                    player.applyCorrection(corrected);
                    setEditing(null);
                    setFailure(null);
                    // The offer appears **after** the correction is saved, never before.
                    setOffered(true);
                  }}
                  onFailure={setFailure}
                />
              ) : (
                <>
                  <button
                    className={styles.lineButton}
                    type="button"
                    data-segment={segment.id}
                    data-highlighted={pinned ? 'true' : undefined}
                    aria-current={segment.id === currentId ? 'true' : undefined}
                    onClick={() => select(segment)}
                  >
                    <span className={styles.lineTime}>{at}</span>
                    <span className={styles.lineText}>{segment.text}</span>
                  </button>
                  <button
                    className={`${pins.pin} ${styles.linePin}`}
                    type="button"
                    aria-pressed={pinned}
                    aria-label={`${pinned ? 'Remove highlight from' : 'Highlight'} the line at ${at}`}
                    disabled={highlights === null || busy}
                    onClick={() => {
                      track('highlight_acted', {
                        action: pinned ? 'removed' : 'added',
                        target: 'moment',
                        recording_id: recordingId,
                      });
                      void toggle(entry, {
                        kind: 'segment',
                        recordingId,
                        positionMs: segment.startMs,
                      });
                    }}
                  >
                    <MarkerIcon marked={pinned} size={16} />
                  </button>
                  {canCorrect ? (
                    <button
                      className={styles.correct}
                      type="button"
                      aria-label={`Correct the line at ${at}`}
                      onClick={() => setEditing(segment.id)}
                    >
                      Correct
                    </button>
                  ) : null}
                </>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * The inline correction form — text and both timings, which is exactly what an admin may change.
 *
 * The offsets are milliseconds in a number field rather than a timecode picker: the timings this
 * corrects are millisecond offsets, and a picker that rounded them to seconds would make a
 * correction of a boundary impossible to express.
 */
function CorrectionForm({
  recordingId,
  segment,
  onCancel,
  onSaved,
  onFailure,
}: {
  recordingId: string;
  segment: TranscriptSegmentView;
  onCancel(): void;
  onSaved(corrected: TranscriptSegmentView): void;
  onFailure(message: string | null): void;
}) {
  const [text, setText] = useState(segment.text);
  const [startMs, setStartMs] = useState(String(segment.startMs));
  const [endMs, setEndMs] = useState(String(segment.endMs));
  const [saving, setSaving] = useState(false);

  return (
    <form
      className={styles.form}
      aria-label="Correct this line"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        onFailure(null);
        void apiFetch<CorrectSegmentPayload>(transcriptSegmentPath(recordingId, segment.id), {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, startMs: Number(startMs), endMs: Number(endMs) }),
        })
          .then((payload) => onSaved(payload.segment))
          .catch((caught: unknown) => {
            onFailure(
              caught instanceof ApiClientError
                ? caught.message
                : 'Could not save that correction. Check your connection and try again.',
            );
          })
          .finally(() => setSaving(false));
      }}
    >
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Line</span>
        <textarea
          className={styles.textArea}
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <div className={styles.timings}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Start (ms)</span>
          <input
            className={styles.input}
            type="number"
            value={startMs}
            onChange={(event) => setStartMs(event.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>End (ms)</span>
          <input
            className={styles.input}
            type="number"
            value={endMs}
            onChange={(event) => setEndMs(event.target.value)}
          />
        </label>
      </div>
      <div className={styles.formActions}>
        <button className={styles.primary} type="submit" disabled={saving}>
          Save correction
        </button>
        <button className={styles.secondary} type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The offer ([3.5.6](docs/project/prd.md)) — which **offers and does not act**.
 *
 * Accepting enqueues one `generate_draft`; the live summary stays visible to members until an admin
 * approves the new draft in Pending Reviews, which is the same press that publishes any summary.
 * Dismissing it does nothing at all — no job, no review item.
 */
function RegenerationOffer({
  recordingId,
  onDismiss,
  onFailure,
}: {
  recordingId: string;
  onDismiss(): void;
  onFailure(message: string | null): void;
}) {
  const [asking, setAsking] = useState(false);
  const [asked, setAsked] = useState(false);

  if (asked) {
    return (
      <section className={styles.offer} aria-label="Regeneration asked for">
        <p className={styles.offerText}>
          A fresh summary and a fresh set of scripture references are being written. They will be
          waiting in Pending Reviews — what members see does not change until you approve them.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.offer} aria-label="Regenerate the summary and scripture references">
      <p className={styles.offerText}>
        Line corrected. Would you like the summary and the scripture references written again from
        the corrected words?
      </p>
      <div className={styles.formActions}>
        <button
          className={styles.primary}
          type="button"
          disabled={asking}
          onClick={() => {
            setAsking(true);
            onFailure(null);
            void apiFetch(recordingSummaryRegeneratePath(recordingId), {
              method: 'POST',
              credentials: 'include',
            })
              .then(() => setAsked(true))
              .catch((caught: unknown) => {
                onFailure(
                  caught instanceof ApiClientError
                    ? caught.message
                    : 'Could not ask for a new draft. Check your connection and try again.',
                );
              })
              .finally(() => setAsking(false));
          }}
        >
          Regenerate summary and scripture
        </button>
        <button className={styles.secondary} type="button" onClick={onDismiss}>
          Not now
        </button>
      </div>
    </section>
  );
}
