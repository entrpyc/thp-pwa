/**
 * **The highlighter** — the one icon every highlight control draws, so a member learns it once.
 *
 * Lucide's `highlighter`, the shape the operator chose: the marker's body held at a slant over
 * the page, and the cap of ink it leaves at the lower left. `currentColor`, the stroke width
 * the transport's icons use. `marked` is the pressed state: the whole icon turns the highlights
 * orange — the stroke alone, nothing filled — so *highlighted* reads at a glance without a second
 * word, and in the colour the squares on the track are.
 */
export function MarkerIcon({ marked, size = 18 }: { marked: boolean; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={marked ? { color: 'var(--color-highlights)' } : undefined}
    >
      {/* The ink at the tip. */}
      <path d="m9 11-6 6v3h9l3-3" />
      {/* The body. */}
      <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
    </svg>
  );
}
