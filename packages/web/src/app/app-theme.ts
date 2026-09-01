/**
 * **The document's background colour, spelled once, for the two consumers that cannot read CSS.**
 *
 * `tokens.css` declares `--color-bg` and every stylesheet composes from it. Two surfaces cannot:
 * the PWA manifest, which the launcher reads as JSON before anything has rendered, and the
 * `themeColor` viewport field, which Android paints the status bar and the task-switcher header
 * with. Both are consumed by the operating system rather than by the document, so a custom property
 * is not something either can resolve.
 *
 * So the rule is *answered* rather than dodged, exactly as `server/mail/theme.ts` answers it for the
 * invitation email: one module holds the literal, `tools/style-tokens.ts` names that module in
 * {@link COLOUR_LITERAL_FILES}, and the surfaces that need the value import it. Spelling it in both
 * of them instead would put the same hex in two files with nothing keeping them in step — which is
 * the drift the guard exists to catch, and it did.
 *
 * **It must equal `--color-bg` in `tokens.css`**, and nothing can check that from here: a `.ts`
 * module cannot read a custom property, which is the whole reason this file exists.
 * `packages/web/tests/unit/app-theme.test.ts` reads the stylesheet and asserts the two agree.
 */
export const APP_BACKGROUND_COLOUR = '#01101F';
