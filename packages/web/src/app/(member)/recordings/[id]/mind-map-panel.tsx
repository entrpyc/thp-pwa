'use client';

import { useEffect, useState } from 'react';
import {
  recordingMindMapPath,
  type MindMapNode,
  type MindMapView,
  type RecordingMindMapPayload,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { MindMapCanvas } from '@/client/mind-map/mind-map-canvas';
import { track } from '@/client/observability/analytics';
import { useRecordingContent } from './recording-content';
import styles from './mind-map.module.css';

/**
 * **The `Mindmap` tab of `pages/recording.png`** ([3.8.3](docs/project/prd.md),
 * [3.8.4](docs/project/prd.md)) — the teaching's concepts as a tree a member walks — and, with
 * `chapter` set, the same tab on the chapter page, read through one chapter.
 *
 * The reference draws the tab and nothing draws the panel, so this is `style-guide.md` filling it
 * the way the scripture and transcript panels already do, around one canvas.
 *
 * - **Fetched on mount**, which is the strip's "fetched when first opened": the panel exists only
 *   while the tab is open, so opening it is what asks. **A failure stays inside it**: the player,
 *   the notes and the transcript are unaffected by anything that happens here.
 * - **Read-only.** What the map says was decided in Pending Reviews ([3.8.2](docs/project/prd.md));
 *   nothing here edits and nothing here could.
 * - **On the chapter page, the chapter is the root.** The map's first level is the chapter list
 *   ([3.8.1](docs/project/prd.md)), so the chapter's own branch is found among the root's children
 *   — by the moment it starts at, which is what a chapter node is anchored to, and by its title
 *   when the moment has moved under an edit — and drawn with that node at the left. A chapter the
 *   map has no branch for says so rather than showing an empty box.
 * - **A timestamp goes to the moment without sound** ([3.8.4](docs/project/prd.md)) — through
 *   `seekToMs` on the recording content, which is the same door a note's timestamp uses: a seek on
 *   the loaded teaching, a paused load of this one when the player holds another. The play
 *   control beside it is `playFromMs`, the same door the chapter page's play control uses.
 * - **Full screen is the same canvas, larger.** The inline panel is a fixed height a phone can
 *   scroll past; the control fixes the same element to the viewport, so what was folded stays
 *   folded and the scroll position survives. Escape or the close control brings it back.
 */
export function MindMapPanel({
  recordingId,
  chapter,
}: {
  recordingId: string;
  /** On the chapter page: which chapter's branch to draw, with that chapter as the root. */
  chapter?: { readonly startMs: number; readonly title: string };
}) {
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

  const root = map == null ? null : chapter === undefined ? map.root : chapterBranch(map.root, chapter);
  const subject = chapter === undefined ? 'this teaching' : 'this chapter';

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
      ) : root === null ? (
        // The map predates this chapter — a list regenerated after the map was approved — and has
        // no branch for it.
        <p className={styles.quiet}>The mind map has no branch for this chapter yet.</p>
      ) : (
        <div
          className={fullScreen ? styles.fullScreen : styles.inline}
          role={fullScreen ? 'dialog' : undefined}
          aria-modal={fullScreen ? true : undefined}
          aria-label={fullScreen ? 'Mind map, full screen' : undefined}
        >
          <div className={styles.bar}>
            <p className={styles.hint}>
              Press › to fold a branch. Press a time to go to that moment, or ▶ to play from it.
            </p>
            <button
              className={styles.control}
              type="button"
              aria-pressed={fullScreen}
              onClick={() => {
                track('mind_map_acted', {
                  action: fullScreen ? 'full_screen_off' : 'full_screen_on',
                  recording_id: content.recordingId,
                });
                setFullScreen(!fullScreen);
              }}
            >
              {fullScreen ? 'Close full screen' : 'Full screen'}
            </button>
          </div>
          <MindMapCanvas
            root={root}
            label={`Mind map of ${subject}`}
            className={fullScreen ? styles.fill : styles.fixed}
            onSeek={(ms) => {
              track('mind_map_acted', { action: 'seek', recording_id: content.recordingId });
              content.seekToMs(ms);
            }}
            onPlay={(ms) => {
              track('mind_map_acted', { action: 'play', recording_id: content.recordingId });
              content.playFromMs(ms);
            }}
            onFold={(folded) =>
              track('mind_map_acted', { action: folded ? 'collapsed' : 'expanded', recording_id: content.recordingId })
            }
          />
        </div>
      )}
    </section>
  );
}

/**
 * The chapter's node among the root's children: the one anchored at the chapter's start, else the
 * one that carries its title. `null` when the map has neither — it was approved against a
 * different chapter list.
 */
export function chapterBranch(
  root: MindMapNode,
  chapter: { readonly startMs: number; readonly title: string },
): MindMapNode | null {
  return (
    root.children.find((one) => one.anchorMs === chapter.startMs) ??
    root.children.find((one) => one.label === chapter.title) ??
    null
  );
}
