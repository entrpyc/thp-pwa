/**
 * **The one file in the codebase allowed to spell a colour out.**
 *
 * Email clients do not support CSS custom properties, and several strip `<style>` blocks outright,
 * so the invitation template cannot compose from `app/tokens.css` the way every screen does. It has
 * to inline literal values. The style-token guard is therefore *answered* here rather than obeyed:
 * `tools/style-tokens.ts` scans application TypeScript for raw colours and exempts this file **by
 * name**, so the exception is one path in a list rather than a pattern anything can match.
 *
 * The values below are the token layer's, verbatim. They cannot drift silently:
 * `packages/web/tests/unit/mail-theme.test.ts` reads `app/tokens.css` and asserts every entry here
 * equals the token it names — the same mechanism that keeps `tokens.css` equal to the style guide.
 *
 * Keep the chain in order when a colour changes: edit the guide, then `tokens.css`, then this.
 */
export const MAIL_THEME = {
  /** `--color-bg` */
  bg: '#01101F',
  /** `--color-surface` */
  surface: '#0A1A2C',
  /** `--color-surface-raised` */
  surfaceRaised: '#0F2438',
  /** `--color-primary` */
  primary: '#6F2BDD',
  /** `--color-text` */
  text: '#FCFCFC',
  /** `--color-text-muted` */
  textMuted: '#8A97AC',
  /** `--color-text-dim` */
  textDim: '#6B7A90',
  /** `--radius-md` */
  radiusMd: '12px',
  /** `--radius-sm` */
  radiusSm: '8px',
  /** `--space-4` */
  space4: '16px',
  /** `--space-6` */
  space6: '24px',
  /** `--space-8` */
  space8: '32px',
  /** `--font-sans` */
  fontSans: '"Inter", system-ui, -apple-system, sans-serif',
} as const;

/**
 * Which token each entry above is a copy of. The test walks this map rather than a restatement of
 * it, so adding a value here without saying where it came from fails rather than passing quietly.
 */
export const MAIL_THEME_TOKENS: Readonly<Record<keyof typeof MAIL_THEME, string>> = {
  bg: '--color-bg',
  surface: '--color-surface',
  surfaceRaised: '--color-surface-raised',
  primary: '--color-primary',
  text: '--color-text',
  textMuted: '--color-text-muted',
  textDim: '--color-text-dim',
  radiusMd: '--radius-md',
  radiusSm: '--radius-sm',
  space4: '--space-4',
  space6: '--space-6',
  space8: '--space-8',
  fontSans: '--font-sans',
};
