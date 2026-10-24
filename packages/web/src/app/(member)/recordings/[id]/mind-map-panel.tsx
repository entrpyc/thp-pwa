'use client';

import { useEffect, useState } from 'react';
import { recordingMindMapPath, type MindMapView, type RecordingMindMapPayload } from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { MindMapCanvas } from '@/client/mind-map/mind-map-canvas';
import { useRecordingContent } from './recording-content';
import styles from './mind-map.module.css';

/**
 * **The `Mindmap` tab of `pages/recording.png`** ([3.8.3](docs/project/prd.md),
 * [3.8.4](docs/project/prd.md)) — the teaching's concepts as a tree a member walks.
 *
 * The reference draws the tab and nothing draws the panel, so this is `style-guide.md` filling it
 * the way the scripture and transcript panels already do, around one canvas.
 *
 * - **Fetched on mount**, which is the strip's "fetched when first opened": the panel exists only
 *   while the tab is open, so opening it is what asks. **A failure stays inside it**: the player,
 *   the notes and the transcript are unaffected by anything that happens here.
 * - **Read-only.** What the map says was decided in Pending Reviews ([3.8.2](docs/project/prd.md));
 *   nothing here edits and nothing here could.
 * - **A timestamp goes to the moment without sound** ([3.8.4](docs/project/prd.md)) — through
 *   `seekToMs` on the recording content, which is the same door a note's timestamp uses: a seek on
 *   the loaded teaching, a paused load of this one when the player holds another.
 * - **Full screen is the same canvas, larger.** The inline panel is a fixed height a phone can
 *   scroll past; the control fixes the same element to the viewport, so what was expanded stays
 *   expanded and the scroll position survives. Escape or the close control brings it back.
 */
export function MindMapPanel({ recordingId }: { recordingId: string }) {
  const content = useRecordingContent();
  const [map, setMap] = useState<MindMapView | null | undefined>(undefined);
  const [failure, setFailure] = useState<string | null>(null);
  const [fullScreen, setFullScreen] = useState(false);

  useEffect(() => {
    let live = true;

    void apiFetch<RecordingMindMapPayload>(recordingMindMapPath(recordingId), {
      credentials: 'include',
    })
      .then((payload) => {
        if (!live) return;
        setMap(payload.mindMap);
        setFailure(null);
      })
      .catch((caught: unknown) => {
        if (!live) return;
        setMap(undefined);
        setFailure(
          caught instanceof ApiClientError
            ? caught.message
            : 'Could not load this teaching’s mind map. Check your connection and try again.',
        );
      });

    return () => {
      live = false;
    };
  }, [recordingId]);

  // Escape leaves full screen, as it leaves any overlay; the listener exists only while it is on.
  useEffect(() => {
    if (!fullScreen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFullScreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullScreen]);

  return (
    <section className={styles.panel} aria-label="Mind map">
      {failure !== null ? (
        <p className={styles.failure}>{failure}</p>
      ) : map === undefined ? (
        <p className={styles.quiet}>Loading the mind map…</p>
      ) : map === null ? (
        // Reachable only if the map went away between the page load that drew the tab and this
        // fetch — a regenerated draft replacing it in the meantime. It says so rather than
        // showing an empty box.
        <p className={styles.quiet}>This teaching has no mind map yet.</p>
      ) : (
        <div
          className={fullScreen ? styles.fullScreen : styles.inline}
          role={fullScreen ? 'dialog' : undefined}
          aria-modal={fullScreen ? true : undefined}
          aria-label={fullScreen ? 'Mind map, full screen' : undefined}
        >
          <div className={styles.bar}>
            <p className={styles.hint}>
              Press a theme to open it. Press a time to go to that moment.
            </p>
            <button
              className={styles.control}
              type="button"
              aria-pressed={fullScreen}
              onClick={() => setFullScreen(!fullScreen)}
            >
              {fullScreen ? 'Close full screen' : 'Full screen'}
            </button>
          </div>
          <MindMapCanvas
            root={map.root}
            label="Mind map of this teaching"
            className={fullScreen ? styles.fill : styles.fixed}
            onSeek={(ms) => content.seekToMs(ms)}
          />
        </div>
      )}
    </section>
  );
}
