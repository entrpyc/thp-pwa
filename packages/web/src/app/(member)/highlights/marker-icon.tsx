/**
 * **The highlighter** — the one icon every highlight control draws, so a member learns it once.
 *
 * A marker held at a slant over a stroke of ink, in the app's line style (`currentColor`, the
 * stroke width the transport's icons use). `marked` is the pressed state: the whole icon turns the
 * highlights orange, the body fills and the stroke under the tip goes solid, so *highlighted* reads
 * at a glance without a second word — and in the colour the dots on the track are.
 */
export function MarkerIcon({ marked, size = 18 }: { marked: boolean; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      style={marked ? { color: 'var(--color-highlights)' } : undefined}
    >
      {/* The body, held at a slant. */}
      <path
        d="M9.5 15.5 5 11l8.5-8.5a2.1 2.1 0 0 1 3 0l1.5 1.5a2.1 2.1 0 0 1 0 3Z"
        fill={marked ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      {/* The tip. */}
      <path d="M5 11 3.5 16.5 9.5 15.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      {/* The stroke of ink. */}
      <path
        d="M4 20.5h16"
        fill="none"
        stroke="currentColor"
        strokeWidth={marked ? 3 : 1.8}
        strokeLinecap="round"
        opacity={marked ? 1 : 0.6}
      />
    </svg>
  );
}
