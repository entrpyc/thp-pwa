/**
 * **The download icon** — an arrow dropping into an open tray, the shape the operator chose, in
 * the app's line style (`currentColor`, the stroke the transport's icons use). `held` is the
 * state once the teaching is on the device: the tray's floor thickens into a solid bar, so
 * *downloaded* reads without a word, on top of the pressed wash the button itself takes.
 */
export function DownloadIcon({ held, size = 20 }: { held: boolean; size?: number }) {
  const line = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      {/* The arrow, dropping in. */}
      <path d="M12 3v11M7.5 9.5 12 14l4.5-4.5" {...line} />
      {/* The open tray: two sides and a floor. */}
      <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" {...line} />
      {held ? <path d="M6.5 20h11" stroke="currentColor" strokeWidth="4" strokeLinecap="round" /> : null}
    </svg>
  );
}
