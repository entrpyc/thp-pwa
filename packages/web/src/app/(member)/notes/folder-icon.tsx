/**
 * **The folder** — the one icon every folder control draws, beside the highlighter it sits next to.
 *
 * Lucide's `folder`: the tab at the top left and the body below it, `currentColor`, the stroke
 * width the transport's icons use. `filed` is the state when the note is in at least one folder:
 * the body fills with the accent's soft tint while the outline stays, so *filed* reads at a
 * glance without a second word — and in the product's accent rather than the highlights orange,
 * because a folder is not a highlight.
 */
export function FolderIcon({ filed, size = 18 }: { filed: boolean; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filed ? 'var(--color-primary-soft)' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}
