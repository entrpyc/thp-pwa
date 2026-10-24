/**
 * **The series icon** — a stack of teachings, three sheets fanned behind one another, in the app's
 * line style (`currentColor`, the stroke the transport's icons use). It is the shape on the
 * landing's *Series* tile, where the member learns it, and the only place it is drawn so far.
 */
export function SeriesIcon({ size = 20 }: { size?: number }) {
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
    >
      {/* The top sheet. */}
      <path d="m12 3 9 4.5-9 4.5-9-4.5L12 3Z" />
      {/* The two behind it. */}
      <path d="m3 12 9 4.5 9-4.5" />
      <path d="m3 16.5 9 4.5 9-4.5" />
    </svg>
  );
}
