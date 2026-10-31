// Every icon the product shows, generated from one piece of art.
//
// Run from the repository root: `npm --workspace @thp/shell run assets`. It needs `sharp`, which
// the root install already carries as a dependency of Next, so nothing is added for it.
//
// The source is `packages/web/brand/mark.png` — the mark on a transparent background, square, at
// whatever size it was drawn. Nothing is served from there; this script derives every file that is:
//
// - **The web app's icons.** `public/icons/icon-192.png` and `icon-512.png` (the manifest's `any`
//   entries, the first of which is also the browser tab's icon — `app-theme.ts`, `APP_ICON`),
//   `public/icons/maskable-512.png` (the mark drawn smaller so Android's launcher crop keeps it
//   whole), `src/app/apple-icon.png` (what Safari's *Add to Home Screen* uses) and
//   `src/app/favicon.ico` (what a browser asks for before it has read the document). All on the
//   document background, because a launcher tile and a home-screen icon are opaque squares.
// - **Android** launcher icons at the five densities (legacy square and round, and the adaptive
//   foreground at 108 dp with the mark in the 66 dp safe zone), and the splash drawable at the
//   portrait and landscape densities Capacitor's template names. Android 12+ draws its own splash
//   (the icon on `windowSplashScreenBackground`, styles.xml); the drawables are for 11 and earlier.
// - **iOS** — the app icon at 1024 px, and the launch image at 2732 px in the three scales the
//   asset catalogue lists: one square, the mark centred on the background, which `scaleAspectFill`
//   in LaunchScreen.storyboard crops to any screen without the mark leaving the middle.
//
// Why generate rather than check in hand-made art: the tab icon, the PWA icon and the store icons
// are one identity, so replacing the art is one write — the source file — followed by this script.
// The background colour is `APP_BACKGROUND_COLOUR` from `app-theme.ts`, read from the file so it
// cannot drift. Nothing here spells a colour.

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const web = resolve(root, 'packages/web');
const shell = resolve(root, 'packages/shell');
const mark = resolve(web, 'brand/mark.png');

const theme = readFileSync(resolve(web, 'src/app/app-theme.ts'), 'utf8');
const background = /APP_BACKGROUND_COLOUR = '(#[0-9A-Fa-f]{6})'/.exec(theme)?.[1];
if (background === undefined) throw new Error('APP_BACKGROUND_COLOUR not found in app-theme.ts');

/** The mark alone, scaled to fit a `side` square, centred on a transparent square of that size. */
async function markOn(side, markRatio, canvasBackground) {
  const markSide = Math.round(side * markRatio);
  const resized = await sharp(mark).resize(markSide, markSide, { fit: 'contain' }).png().toBuffer();
  return sharp({ create: { width: side, height: side, channels: 4, background: canvasBackground } })
    .composite([{ input: resized, gravity: 'centre' }])
    .png();
}

const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

/**
 * A square of the background colour with the mark scaled to `markRatio` of the side, centred —
 * what every opaque icon is. The art has no straight edges, so it is drawn a little inside the
 * square rather than touching it: a mark that fills its tile to the edge reads as cropped.
 */
const composed = (side, markRatio = 0.86) => markOn(side, markRatio, background);

/** A rectangle of the background colour with the mark centred, for a splash drawable. */
async function splash(width, height) {
  const markSide = Math.round(Math.min(width, height) * 0.3);
  const resized = await sharp(mark).resize(markSide, markSide, { fit: 'contain' }).png().toBuffer();
  return sharp({ create: { width, height, channels: 4, background } })
    .composite([{ input: resized, gravity: 'centre' }])
    .png();
}

/**
 * The mark alone on transparency, inside the 66 dp safe zone of a 108 dp adaptive icon — the
 * foreground layer; the background layer (`ic_launcher_background`) shows through the launcher's
 * crop around it.
 */
const foreground = (side) => markOn(side, 66 / 108, transparent);

async function write(image, path) {
  mkdirSync(dirname(path), { recursive: true });
  await image.toFile(path);
  console.log('wrote', path.slice(root.length + 1));
}

/**
 * An `.ico` holding PNG-encoded images — the form every current browser reads, and the one that
 * needs no BMP encoder: a 6-byte header, a 16-byte directory entry per image, then the PNG files
 * back to back. Sizes of 256 are written as 0 in the directory, as the format says.
 */
async function ico(sides) {
  const images = await Promise.all(
    sides.map(async (side) => ({ side, png: await (await composed(side)).toBuffer() })),
  );
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ side, png }, i) => {
    const entry = i * 16;
    directory.writeUInt8(side >= 256 ? 0 : side, entry);
    directory.writeUInt8(side >= 256 ? 0 : side, entry + 1);
    directory.writeUInt8(0, entry + 2); // colours in palette: none
    directory.writeUInt8(0, entry + 3); // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...images.map(({ png }) => png)]);
}

// --------------------------------------------------------------------------------------- web app

await write(await composed(192), resolve(web, 'public/icons/icon-192.png'));
await write(await composed(512), resolve(web, 'public/icons/icon-512.png'));
// Maskable: Android may crop a circle out of the square, so the mark stays inside the inner 80 %.
await write(await composed(512, 0.64), resolve(web, 'public/icons/maskable-512.png'));
// iOS rounds the corners itself and wants no transparency under them.
await write(
  sharp(await (await composed(180)).toBuffer()).flatten({ background }).png(),
  resolve(web, 'src/app/apple-icon.png'),
);
{
  const path = resolve(web, 'src/app/favicon.ico');
  mkdirSync(dirname(path), { recursive: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, await ico([16, 32, 48]));
  console.log('wrote', path.slice(root.length + 1));
}

// ---------------------------------------------------------------------------------------- Android

const res = resolve(shell, 'android/app/src/main/res');
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

for (const [density, scale] of Object.entries(densities)) {
  const legacy = Math.round(48 * scale);
  // The legacy icon is the opaque square — what pre-adaptive launchers draw.
  await write(await composed(legacy), resolve(res, `mipmap-${density}/ic_launcher.png`));
  const roundMask = Buffer.from(
    `<svg width="${legacy}" height="${legacy}"><circle cx="${legacy / 2}" cy="${legacy / 2}" r="${legacy / 2}"/></svg>`,
  );
  await write(
    sharp(await (await composed(legacy, 0.78)).toBuffer()).composite([{ input: roundMask, blend: 'dest-in' }]).png(),
    resolve(res, `mipmap-${density}/ic_launcher_round.png`),
  );
  await write(await foreground(Math.round(108 * scale)), resolve(res, `mipmap-${density}/ic_launcher_foreground.png`));
}

const splashes = {
  'drawable': [480, 320],
  'drawable-land-mdpi': [480, 320],
  'drawable-land-hdpi': [800, 480],
  'drawable-land-xhdpi': [1280, 720],
  'drawable-land-xxhdpi': [1600, 960],
  'drawable-land-xxxhdpi': [1920, 1280],
  'drawable-port-mdpi': [320, 480],
  'drawable-port-hdpi': [480, 800],
  'drawable-port-xhdpi': [720, 1280],
  'drawable-port-xxhdpi': [960, 1600],
  'drawable-port-xxxhdpi': [1280, 1920],
};
for (const [dir, [width, height]] of Object.entries(splashes)) {
  await write(await splash(width, height), resolve(res, `${dir}/splash.png`));
}

// -------------------------------------------------------------------------------------------- iOS

const assets = resolve(shell, 'ios/App/App/Assets.xcassets');
// The store icon has no alpha channel: App Store Connect refuses one with transparency.
await write(
  sharp(await (await composed(1024)).toBuffer()).flatten({ background }).png(),
  resolve(assets, 'AppIcon.appiconset/AppIcon-512@2x.png'),
);
for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  await write(await splash(2732, 2732), resolve(assets, `Splash.imageset/${name}`));
}
