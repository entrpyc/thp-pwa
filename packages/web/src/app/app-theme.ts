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

/**
 * **The mark, in the one file the browser tab and the manifest both point at.**
 *
 * A tab icon and an installed app's icon are the same identity, so they are the same *file* rather
 * than two files somebody has to keep in step: the manifest lists this as its 192px `any` entry
 * and the document's `icons` metadata points the tab at it. Replacing the art is therefore one
 * write, and there is no state in which the hub in a tab and the hub on a home screen disagree
 * about what it looks like.
 *
 * The other two entries in the manifest are the same mark at other sizes and for the launcher's
 * crop, and iOS reads `apple-icon.png` beside this module instead — none of the three is what a
 * tab draws, which is why this one is named here.
 */
export const APP_ICON = '/icons/icon-192.png';
