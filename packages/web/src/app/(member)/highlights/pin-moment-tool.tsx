'use client';

import { usePlayer } from '../player-context';
import { momentEntry } from './highlights-lookup';
import { useHighlights } from './highlights-store';

/**
 * **Pin this moment, from the transport** ([3.15.2](docs/project/prd.md), [3.15.4](docs/project/prd.md)
 * "while listening") — a tool in the `···` strip beside Chapters, the composer and CC.
 *
 * It reads the player: the loaded teaching and where it has got to, which is the moment the press
 * captures — on whatever screen the member is on, because the bar is. The server snaps that
 * position to the line being spoken, so pressing twice in one sentence is one entry, and the tool
 * reads *pinned* for as long as a pinned line is playing: the same press, during that line, unpins
 * it. It takes the strip's own class so it draws as the tools beside it do, and the pressed state
 * is the strip's too.
 *
 * `onPressed` is the strip closing behind the press, the rule every tool there follows — passed in
 * rather than reached for, so this file knows nothing of the toolbar's state and the transport's
 * line that mounts it stays one line.
 */
export function PinMomentTool({
  className,
  onPressed,
}: {
  /** The strip's own tool class, so the pin draws as the tools beside it. */
  className: string | undefined;
  onPressed: () => void;
}) {
  const player = usePlayer();
  const { highlights, busy, toggle } = useHighlights();
  const loaded = player.loaded;
  if (loaded === null) return null;

  const positionMs = player.currentMs;
  const existing = highlights === null ? null : momentEntry(highlights, loaded.id, positionMs);
  const pinned = existing !== null;

  return (
    <button
      className={className}
      type="button"
      aria-pressed={pinned}
      aria-label={pinned ? 'Unpin this moment' : 'Pin this moment'}
      disabled={highlights === null || busy}
      onClick={() => {
        onPressed();
        void toggle(existing, { kind: 'segment', recordingId: loaded.id, positionMs });
      }}
    >
      <span aria-hidden="true">{pinned ? '★' : '☆'}</span>
    </button>
  );
}
