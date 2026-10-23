'use client';

import { usePlayer } from '../player-context';
import { momentEntry } from './highlights-lookup';
import { useHighlights } from './highlights-store';
import { MarkerIcon } from './marker-icon';

/**
 * **Highlight this moment, from the transport** ([3.15.2](docs/project/prd.md), [3.15.4](docs/project/prd.md)
 * "while listening") — the marker on the bar itself, just left of the speed pill. It was a tool in
 * the `···` strip until the operator moved it out: a highlight is one press, and a press behind a
 * strip is two.
 *
 * It reads the player: the loaded teaching and where it has got to, which is the moment the press
 * captures — on whatever screen the member is on, because the bar is. The server snaps that
 * position to the line being spoken, so pressing twice in one sentence is one entry, and the
 * marker reads *highlighted* for as long as a highlighted line is playing: the same press, during
 * that line, takes it back. It takes the bar's own class so it draws as the `···` beside it does,
 * and `aria-pressed` carries the state the filled marker shows.
 */
export function PinMomentTool({
  className,
}: {
  /** The bar's own round control class, so the marker draws as the `···` beside it. */
  className: string | undefined;
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
      aria-label={pinned ? 'Remove highlight from this moment' : 'Highlight this moment'}
      disabled={highlights === null || busy}
      onClick={() => void toggle(existing, { kind: 'segment', recordingId: loaded.id, positionMs })}
    >
      <MarkerIcon marked={pinned} />
    </button>
  );
}
