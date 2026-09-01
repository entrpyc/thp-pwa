import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_BACKGROUND_COLOUR, APP_ICON } from '@/app/app-theme';
import manifest from '@/app/manifest';
import { parseCustomProperties } from '../../../../tools/style-tokens';

/**
 * **The one colour literal outside a stylesheet has to equal the token it stands for.**
 *
 * `app-theme.ts` exists because the PWA manifest and the `themeColor` viewport field are read by the
 * operating system before anything has rendered, so neither can resolve `--color-bg`. That makes it
 * the one value in the client that is spelled twice by necessity — once in `tokens.css` for the
 * document, and once in TypeScript for the launcher — and two spellings of one colour is exactly
 * the drift `tools/style-tokens.ts` exists to catch. It cannot catch this pair, because one half is
 * on its allowlist.
 *
 * So the pair is checked here instead: the stylesheet is read, its `--color-bg` is parsed by the
 * guard's own parser, and the two are compared. A launch screen that flashed a different colour
 * before the first paint would otherwise be a thing nobody notices until it is on a phone.
 */
describe('the theme colour the launcher paints', () => {
  it('is the same colour the document is', () => {
    const tokens = parseCustomProperties(
      readFileSync(resolve(import.meta.dirname, '..', '..', 'src', 'app', 'tokens.css'), 'utf8'),
    );

    expect(tokens.get('--color-bg')).toBe(APP_BACKGROUND_COLOUR);
  });
});

/**
 * **The tab and the home screen draw one mark.**
 *
 * They are the same file rather than two copies — {@link APP_ICON} — so this is not a comparison of
 * pixels but of who points where: the manifest's `any` entry at 192, the document's `icons`
 * metadata, and a file actually sitting in `public` behind both. Getting any one of the three
 * wrong is silent: a browser that cannot fetch an icon draws its own placeholder and says nothing,
 * which is exactly how a tab ends up generic while the installed app looks right.
 *
 * The layout is read as text rather than imported, because importing it would pull the document's
 * stylesheets into a node test to learn one string.
 */
describe('the icon the browser tab draws', () => {
  it('is the file the manifest installs', () => {
    const listed = manifest().icons ?? [];
    const any = listed.filter((icon) => icon.purpose === 'any');

    expect(any.map((icon) => icon.src)).toContain(APP_ICON);
  });

  it('is what the document actually points the tab at', () => {
    const layout = readFileSync(
      resolve(import.meta.dirname, '..', '..', 'src', 'app', 'layout.tsx'),
      'utf8',
    );

    // The metadata names the constant rather than spelling a path, which is the whole of how the
    // two surfaces are kept from drifting.
    expect(layout).toContain('icon: APP_ICON');
  });

  it('is a file that is actually served', () => {
    const file = resolve(import.meta.dirname, '..', '..', 'public', ...APP_ICON.split('/'));

    expect(readFileSync(file).length).toBeGreaterThan(0);
  });
});
