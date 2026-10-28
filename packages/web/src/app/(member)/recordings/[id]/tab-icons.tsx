import type { ReactNode } from 'react';

/**
 * **The recording page's tab icons** — one line drawing per entry in the strip, in the app's line
 * style (`currentColor`, the stroke the landing's tiles use), so the strip reads as the same kind
 * of thing as the *Notes* / *Highlights* / *Series* / *Flow Tracker* tiles on the dashboard. Every
 * icon is decorative: the label beside it is the tab's accessible name, and `aria-hidden` keeps
 * the drawing out of it.
 */
function Icon({ size, children }: { size: number; children: ReactNode }) {
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
      {children}
    </svg>
  );
}

/** *About* — an information mark in a circle. */
export function AboutIcon({ size = 20 }: { size?: number }) {
  return (
    <Icon size={size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </Icon>
  );
}

/** *Reflection* — a speech bubble carrying a question mark. */
export function ReflectionIcon({ size = 20 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M21 12a8 8 0 0 1-8 8H8l-4 3v-7.5A8 8 0 0 1 12 4h1a8 8 0 0 1 8 8Z" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.4V14M12 17h.01" />
    </Icon>
  );
}

/** *Chapters* — a numbered list, three rows. */
export function ChaptersIcon({ size = 20 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </Icon>
  );
}

/** *Scripture* — an open book. */
export function ScriptureIcon({ size = 20 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M12 6.5C10.5 5 8.5 4.5 3 4.5v14c5.5 0 7.5.5 9 2 1.5-1.5 3.5-2 9-2v-14c-5.5 0-7.5.5-9 2Z" />
      <path d="M12 6.5v14" />
    </Icon>
  );
}

/** *Transcript* — a sheet of written lines. */
export function TranscriptIcon({ size = 20 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" />
      <path d="M14 3v6h6" />
      <path d="M8 13h8M8 17h5" />
    </Icon>
  );
}

/** *Mindmap* — a centre node with three branches. */
export function MindmapIcon({ size = 20 }: { size?: number }) {
  return (
    <Icon size={size}>
      <circle cx="12" cy="12" r="2.5" />
      <circle cx="5" cy="6" r="2" />
      <circle cx="19" cy="6" r="2" />
      <circle cx="12" cy="20" r="2" />
      <path d="m10.3 10.6-3.6-3.1M13.7 10.6l3.6-3.1M12 14.5V18" />
    </Icon>
  );
}

/** *Related* — two chain links. */
export function RelatedIcon({ size = 20 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.5 1.5" />
      <path d="M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.5-1.5" />
    </Icon>
  );
}
