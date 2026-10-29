// The shell's icons and splash screens, generated from the web app's own mark.
//
// Run from the repository root: `node packages/shell/tools/generate-assets.mjs`. It needs `sharp`,
// which the root install already carries as a dependency of Next, so nothing is added for it.
//
// Why generate rather than check in hand-made art: the tab icon, the PWA icon and the store icon
// are one identity (packages/web/src/app/app-theme.ts, `APP_ICON`), so the store assets are
// *derived* from the file the manifest already points at, and replacing the art is one write —
// `packages/web/public/icons/icon-512.png` — followed by this script. The background colour is
// `APP_BACKGROUND_COLOUR` from the same module, read from the file so it cannot drift.
//
// What is written:
//
// - Android launcher icons at the five densities (legacy square and round, and the adaptive
//   foreground at 108 dp with the mark in the 66 dp safe zone), and the splash drawable at the
//   portrait and landscape densities Capacitor's template names. Android 12+ draws its own splash
//   (the icon on `windowSplashScreenBackground`, styles.xml); the drawables are for 11 and earlier.
// - The iOS app icon at 1024 px, and the launch image at 2732 px in the three scales the asset
//   catalogue lists — one square, the mark centred on the background, which `scaleAspectFill` in
//   LaunchScreen.storyboard crops to any screen without the mark leaving the middle.
//
// Nothing here spells a colour: the two the output needs come from the token module and from the
// mark itself.

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const shell = resolve(root, 'packages/shell');
const mark = resolve(root, 'packages/web/public/icons/icon-512.png');

const theme = readFileSync(resolve(root, 'packages/web/src/app/app-theme.ts'), 'utf8');
const background = /APP_BACKGROUND_COLOUR = '(#[0-9A-Fa-f]{6})'/.exec(theme)?.[1];
if (background === undefined) throw new Error('APP_BACKGROUND_COLOUR not found in app-theme.ts');

/** A square of the background colour with the mark scaled to `markRatio` of the side, centred. */
async function composed(side, markRatio) {
  const markSide = Math.round(side * markRatio);
  const resized = await sharp(mark).resize(markSide, markSide, { fit: 'contain' }).png().toBuffer();
  return sharp({ create: { width: side, height: side, channels: 4, background } })
    .composite([{ input: resized, gravity: 'centre' }])
    .png();
}

/** A rectangle of the background colour with the mark centred, for a splash drawable. */
async function splash(width, height) {
  const markSide = Math.round(Math.min(width, height) * 0.3);
  const resized = await sharp(mark).resize(markSide, markSide, { fit: 'contain' }).png().toBuffer();
  return sharp({ create: { width, height, channels: 4, background } })
    .composite([{ input: resized, gravity: 'centre' }])
    .png();
}

/** The mark alone, circular, on a transparent square — the adaptive icon's foreground layer. */
async function foreground(side) {
  // The mark's own file is the circle on the document background; the launcher wants the circle
  // alone on transparency so the background layer (ic_launcher_background) shows through the crop.
  const inner = Math.round(side * (66 / 108));
  const circle = Buffer.from(
    `<svg width="${inner}" height="${inner}"><circle cx="${inner / 2}" cy="${inner / 2}" r="${inner / 2}"/></svg>`,
  );
  // `trim` cuts the file to the circle's own bounds (it trims the background colour inwards),
  // so the mask below has no ring of background to leave around the circle.
  const cut = await sharp(mark)
    .trim()
    .resize(inner, inner)
    .composite([{ input: circle, blend: 'dest-in' }])
    .png()
    .toBuffer();
  return sharp({ create: { width: side, height: side, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: cut, gravity: 'centre' }])
    .png();
}

async function write(image, path) {
  mkdirSync(dirname(path), { recursive: true });
  await image.toFile(path);
  console.log('wrote', path.slice(root.length + 1));
}

// ---------------------------------------------------------------------------------------- Android

const res = resolve(shell, 'android/app/src/main/res');
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

for (const [density, scale] of Object.entries(densities)) {
  const legacy = Math.round(48 * scale);
  // The legacy icon is the whole mark file (circle on background) — what pre-adaptive launchers draw.
  await write(await composed(legacy, 1), resolve(res, `mipmap-${density}/ic_launcher.png`));
  const roundMask = Buffer.from(
    `<svg width="${legacy}" height="${legacy}"><circle cx="${legacy / 2}" cy="${legacy / 2}" r="${legacy / 2}"/></svg>`,
  );
  await write(
    sharp(await (await composed(legacy, 1)).toBuffer()).composite([{ input: roundMask, blend: 'dest-in' }]).png(),
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
  sharp(await (await composed(1024, 1)).toBuffer()).flatten({ background }).png(),
  resolve(assets, 'AppIcon.appiconset/AppIcon-512@2x.png'),
);
for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  await write(await splash(2732, 2732), resolve(assets, `Splash.imageset/${name}`));
}
