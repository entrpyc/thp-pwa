// Capture App Store / Play Store screenshots from the live web app at iPhone 6.1"/6.3" size.
//
//   SHOT_EMAIL=... SHOT_PASSWORD=... node tools/store-screenshots.mjs [origin]
//
// Writes 1206x2622 PNGs (402x874 CSS px at 3x, the "iPhone with Dynamic Island" slot) to
// docs/project/store-assets/screenshots/. Apple scales these down for the 6.5" slot as well.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import sharp from 'sharp';

const origin = process.argv[2] ?? 'https://thp.indepthwebsolutions.com';
const email = process.env.SHOT_EMAIL;
const password = process.env.SHOT_PASSWORD;
if (!email || !password) {
  console.error('Set SHOT_EMAIL and SHOT_PASSWORD.');
  process.exit(1);
}

const outDir = 'docs/project/store-assets/screenshots';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 402, height: 874 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
});
const page = await context.newPage();

async function shot(name) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(800);
  const file = `${outDir}/${name}.png`;
  await page.screenshot({ path: file, fullPage: false });
  const { width, height } = await sharp(file).metadata();
  if (width !== 1206 || height !== 2622) {
    throw new Error(`${file} is ${width}x${height}, expected 1206x2622`);
  }
  console.log(`${name}.png  ${width}x${height}  ${page.url()}`);
}

await page.goto(`${origin}/sign-in`);
await page.fill('input[name="email"]', email);
await page.fill('input[name="password"]', password);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'), { timeout: 20000 });

// Skip onboarding if it appears.
if (page.url().includes('/onboarding')) {
  await page.goto(`${origin}/`);
}

await page.goto(`${origin}/`);
await shot('01-home');

const recordingHref = await page.locator('a[href^="/recordings/"]').first().getAttribute('href');
if (recordingHref) {
  await page.goto(`${origin}${recordingHref}`);
  await shot('02-recording');
  for (const [i, tab] of ['Transcript', 'Summary', 'Chapters', 'Notes', 'Mind map'].entries()) {
    const t = page.getByRole('tab', { name: new RegExp(tab, 'i') }).first();
    if (await t.count()) {
      await t.click();
      await shot(`0${3 + i}-recording-${tab.toLowerCase().replace(' ', '-')}`);
    }
  }
}

await page.goto(`${origin}/series`);
await shot('08-series');
await page.goto(`${origin}/prayer-requests`);
await shot('09-prayer-requests');
await page.goto(`${origin}/notes`);
await shot('10-my-notes');
await page.goto(`${origin}/notifications`);
await shot('11-notifications');

await browser.close();
