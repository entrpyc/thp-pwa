'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  formatTimecode,
  recordingSummaryRegeneratePath,
  transcriptSegmentPath,
  type CorrectSegmentPayload,
  type TranscriptSegmentView,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { segmentAt } from '@/client/transcript/current-segment';
import { usePlayer } from '../../player-context';
import styles from './transcript.module.css';

/**
 * **The `Transcript` tab of `pages/recording.png`** — the transcript a member reads along with.
 *
 * Four behaviours, and each is a line in the reference or a sentence in
 * [3.5.3](docs/project/prd.md)–[3.5.4](docs/project/prd.md):
 *
 * - **The line being spoken is highlighted**, driven off the player context's `currentMs` — the
 *   position the element already reports on `timeupdate` and `seeked`. No second timer, and no
 *   second idea of where the teaching is.
 * - **Selecting a line seeks there.** Every line is a real button, so the transcript is walkable
 *   and operable from a keyboard, and it calls the player's `seekToMs` rather than touching the
 *   element. It does **not** start playback: a member reading a paused teaching has not asked for
 *   sound, which is the rule opening a recording already follows.
 * - **The view follows the highlight, and stops fighting a member who scrolls.** A member-initiated
 *   scroll suspends the following and reveals *Jump to current*; pressing that, or selecting any
 *   line, resumes it. Scrolling this component did itself does not count as a member scroll — see
 *   {@link scrollToCurrent}.
 * - **An admin corrects a line in place** ([3.5.5](docs/project/prd.md)) and is then offered a
 *   summary and a set of scripture references built on the corrected words
 *   ([3.5.6](docs/project/prd.md), [3.1.10](docs/active-scope/prd.md)). The offer never fires by
 *   itself, and declining it does nothing at all.
 *
 * `canCorrect` hides the affordance and grants nothing: the API is what refuses a member, which is
 * the standing constraint of
 * docs/epics/epic-core-listening/implementation-plan.md § Standing constraints.
 */
export function TranscriptPanel({
  recordingId,
  canCorrect,
}: {
  recordingId: string;
  canCorrect: boolean;
}) {
  const player = usePlayer();
  const listRef = useRef<HTMLOListElement>(null);
  const [following, setFollowing] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [offered, setOffered] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

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

  const segments = player.transcript?.segments ?? null;
  const current = segments === null ? null : segmentAt(segments, player.currentMs);
  const currentId = current?.id ?? null;

  /** Centre the highlighted row in the list, without scrolling the page around it. */
  const scrollToCurrent = useCallback((): void => {
    const list = listRef.current;
    if (list === null || currentId === null) return;
    const row = list.querySelector<HTMLElement>(`[data-segment="${currentId}"]`);
    if (row === null) return;

    // Written rather than `scrollIntoView`, because that also scrolls every ancestor — including
    // the page — and the transcript following itself must not move the rest of the screen.
    list.scrollTop = row.offsetTop - list.clientHeight / 2 + row.clientHeight / 2;
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
      player.seekToMs(segment.startMs);
      // Selecting a line is a member saying where they want to be, which is the clearest possible
      // signal that they want the transcript to keep up again.
      setFollowing(true);
    },
    [player],
  );

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

      {following ? null : (
        <button
          className={styles.jump}
          type="button"
          onClick={() => {
            setFollowing(true);
            scrollToCurrent();
          }}
        >
          Jump to current
        </button>
      )}

      <ol className={styles.lines} ref={listRef} onScroll={onScroll} aria-label="Transcript">
        {segments.map((segment) => (
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
                  aria-current={segment.id === currentId ? 'true' : undefined}
                  onClick={() => select(segment)}
                >
                  <span className={styles.lineTime}>{formatTimecode(segment.startMs)}</span>
                  <span className={styles.lineText}>{segment.text}</span>
                </button>
                {canCorrect ? (
                  <button
                    className={styles.correct}
                    type="button"
                    aria-label={`Correct the line at ${formatTimecode(segment.startMs)}`}
                    onClick={() => setEditing(segment.id)}
                  >
                    Correct
                  </button>
                ) : null}
              </>
            )}
          </li>
        ))}
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
