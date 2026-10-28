/**
 * **The Flow Tracker icon** — a path winding through three stops, in the app's line style
 * (`currentColor`, the stroke the series icon uses). It is the shape on the landing's
 * *Flow Tracker* tile, where the member learns it: a route back through the teaching, stop by stop.
 */
export function FlowIcon({ size = 20 }: { size?: number }) {
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
      {/* The three stops. */}
      <circle cx="5" cy="5" r="2.5" />
      <circle cx="19" cy="12" r="2.5" />
      <circle cx="5" cy="19" r="2.5" />
      {/* The route between them: out to the middle stop and back. */}
      <path d="M7.5 5c5 0 4 7 9 7" />
      <path d="M16.5 12c-5 0-4 7-9 7" />
    </svg>
  );
}
