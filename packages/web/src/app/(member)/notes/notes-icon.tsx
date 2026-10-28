/**
 * **The notes icon** — a sheet with lines and a pencil across its corner, in the app's line style
 * (`currentColor`, the stroke the series icon uses). It is the shape on the landing's *Notes*
 * tile, where the member learns it.
 */
export function NotesIcon({ size = 20 }: { size?: number }) {
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
      {/* The sheet, its top-right corner left open for the pencil. */}
      <path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
      {/* Two written lines. */}
      <path d="M8 13h5M8 17h8" />
      {/* The pencil. */}
      <path d="m18.5 2.5 3 3L14 13h-3v-3l7.5-7.5Z" />
    </svg>
  );
}
