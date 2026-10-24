import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  DASHBOARD_PAGE_PATH,
  NEW_USER_ONBOARDING_ID,
  PROFILE_PAGE_PATH,
  ROLE,
  type Role,
} from '@thp/shared';
import { completeOnboarding } from '@thp/db';
import { PROFILE_SECTIONS } from '@/app/(member)/profile/sections';
import {
  closeTestDatabase,
  createAccount,
  testDatabase,
  type TestAccount,
} from '../support/accounts';

/**
 * **The profile screen, driven in a real browser** (docs/project/prd.md 3.1.12).
 *
 * The API's half is `profile.test.ts`; what a fetch cannot answer is what this file asks. Whether
 * the menu entry reaches the screen. Whether the section strip under the heading is the sections
 * list and nothing else, marks where the member is, and carries them to `/profile/settings` and
 * back — and whether signing out from there ends the session. Whether a saved name is what the
 * next page load shows. Whether
 * a chosen picture is actually decoded, cropped to the square the member chose and re-encoded by
 * the browser before anything is sent — which is the one property of the upload that only a canvas
 * can prove — whether cancelling the crop asks the API for nothing, and whether what comes back is
 * painted and opens larger.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await closeTestDatabase();
});

/**
 * A fresh account that has already been through the new-user tour. The member layout routes an
 * account that has not into the onboarding before anything else renders, and that is the tour's
 * business, not this screen's — so the completion is recorded up front, the way a member who has
 * used the product for a week already has it.
 */
async function memberPastTheTour(label: string, role: Role = ROLE.member): Promise<TestAccount> {
  const account = await createAccount(databaseUrl, role, label);
  await completeOnboarding(account.id, NEW_USER_ONBOARDING_ID, testDatabase(databaseUrl));
  return account;
}

async function signInAs(
  account: TestAccount,
  viewport: { width: number; height: number } = DESKTOP,
): Promise<Page> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${baseUrl}${DASHBOARD_PAGE_PATH}`, { timeout: 30_000 });
  return page;
}

async function onTheProfile(
  account: TestAccount,
  viewport: { width: number; height: number } = DESKTOP,
): Promise<Page> {
  const page = await signInAs(account, viewport);
  await page.goto(`${baseUrl}${PROFILE_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => page.getByRole('button', { name: 'Save name' }).count(), { timeout: 30_000 })
    .toBe(1);
  return page;
}

/**
 * The label of the section the strip marks current, read off `aria-current` — or `null` when the
 * strip marks nothing, which is what a section no entry claims would show. Exactly one link may
 * carry the mark; two would be a strip that cannot say where the member is.
 */
async function currentSection(page: Page): Promise<string | null> {
  const marked = page
    .getByRole('navigation', { name: 'Profile sections' })
    .getByRole('link')
    .and(page.locator('[aria-current="page"]'));
  const count = await marked.count();
  if (count === 0) return null;
  expect(count).toBe(1);
  return marked.innerText();
}

/**
 * A real PNG, drawn in the browser: a landscape rectangle with a distinct left and right band, so
 * that "the centre square was taken" is something the pixels can answer rather than the size alone.
 */
async function landscapePng(page: Page, width: number, height: number): Promise<Buffer> {
  const dataUrl = await page.evaluate(
    ([w, h]) => {
      const canvas = document.createElement('canvas');
      canvas.width = w as number;
      canvas.height = h as number;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('no 2d context');
      context.fillStyle = '#ff0000';
      context.fillRect(0, 0, w as number, h as number);
      context.fillStyle = '#0000ff';
      const edge = h as number;
      context.fillRect(((w as number) - edge) / 2, 0, edge, edge);
      return canvas.toDataURL('image/png');
    },
    [width, height],
  );
  return Buffer.from(dataUrl.split(',')[1] ?? '', 'base64');
}

/**
 * What was stored: the object fetched from the bucket by the signed URL the screen painted from,
 * then decoded in the page, so the assertion is about what is in the store rather than about
 * anything the screen claims. Fetched outside the page because a cross-origin image drawn onto a
 * canvas taints it, and a tainted canvas answers no pixels. Answers the size and the four corners.
 */
async function storedPicture(
  page: Page,
): Promise<{ width: number; height: number; corners: number[][] }> {
  const src = await page
    .getByRole('img', { name: 'Your picture', exact: true })
    .getAttribute('src');
  const fetched = await page.request.get(src ?? '');
  expect(fetched.ok()).toBe(true);
  expect(fetched.headers()['content-type']).toBe('image/webp');
  const encoded = (await fetched.body()).toString('base64');
  return page.evaluate(async (base64) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('no 2d context');
    context.drawImage(bitmap, 0, 0);
    const corner = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data];
    return {
      width: bitmap.width,
      height: bitmap.height,
      corners: [
        corner(2, 2),
        corner(bitmap.width - 3, 2),
        corner(2, bitmap.height - 3),
        corner(bitmap.width - 3, bitmap.height - 3),
      ],
    };
  }, encoded);
}

/**
 * The zoom slider, set the way React hears it: through the prototype's own setter, so React's
 * value tracker sees the change, and then an `input` event. Playwright's `fill` will not drive a
 * range input.
 */
async function setZoom(page: Page, zoom: number): Promise<void> {
  await page.getByLabel('Zoom').evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(element, String(value));
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, zoom);
}

describe('getting there', () => {
  it('is reached from the navigation menu, and refuses an anonymous visitor', async () => {
    const member = await memberPastTheTour('profile-menu');
    const page = await signInAs(member);
    try {
      await page.getByRole('button', { name: 'Menu' }).click();
      await page
        .getByRole('list', { name: 'Navigation' })
        .getByRole('link', { name: 'My profile' })
        .click();
      await page.waitForURL(`${baseUrl}${PROFILE_PAGE_PATH}`, { timeout: 30_000 });
      await expect
        .poll(() => page.getByRole('heading', { level: 1, name: 'My profile' }).count(), {
          timeout: 30_000,
        })
        .toBe(1);
    } finally {
      await page.context().close();
    }

    // Every section is behind the same check — the layout's — so each refuses as the root does.
    for (const section of PROFILE_SECTIONS) {
      const context = await browser.newContext({ viewport: DESKTOP });
      const anonymous = await context.newPage();
      try {
        await anonymous.goto(`${baseUrl}${section.href}`, { waitUntil: 'domcontentloaded' });
        await anonymous.waitForURL(/\/sign-in/, { timeout: 30_000 });
      } finally {
        await context.close();
      }
    }
  }, 120_000);
});

describe('the sections', () => {
  const settings = PROFILE_SECTIONS.find((section) => section.id === 'settings');
  if (settings === undefined) throw new Error('the settings section is not listed');

  it('are the list, in order, with the current one marked — and the strip is on every section', async () => {
    const member = await memberPastTheTour('profile-sections');
    const page = await onTheProfile(member, PHONE);
    try {
      const strip = page.getByRole('navigation', { name: 'Profile sections' });
      const labels = PROFILE_SECTIONS.map((section) => section.label);

      // The identity page: the strip is the list, and the root entry is the one marked current.
      await expect.poll(() => strip.getByRole('link').allInnerTexts()).toEqual(labels);
      expect(await currentSection(page)).toBe('Profile');
      // The breadcrumb names the place: home › My profile, and nothing between.
      const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
      const crumb = crumbs.locator('[aria-current="page"]');
      await expect.poll(() => crumb.count(), { timeout: 30_000 }).toBe(1);
      expect(await crumb.textContent()).toBe('My profile');
      expect(await crumbs.getByRole('listitem').count()).toBe(2);

      // Across to settings by the strip: same heading, same strip, the mark has moved, and the
      // page beneath is the settings page — its own h2 and its first section, the way out.
      await strip.getByRole('link', { name: settings.label }).click();
      await page.waitForURL(`${baseUrl}${settings.href}`, { timeout: 30_000 });
      await expect
        .poll(() => page.getByRole('heading', { level: 2, name: 'Settings' }).count(), {
          timeout: 30_000,
        })
        .toBe(1);
      expect(await page.getByRole('heading', { level: 1, name: 'My profile' }).count()).toBe(1);
      await expect.poll(() => currentSection(page)).toBe(settings.label);
      // A section is one level down: home › My profile › Settings, with My profile a link back.
      await expect.poll(() => crumb.textContent(), { timeout: 30_000 }).toBe(settings.label);
      expect(await crumbs.getByRole('link', { name: 'My profile' }).getAttribute('href')).toBe(
        PROFILE_PAGE_PATH,
      );
      expect(await page.getByRole('region', { name: 'Session' }).isVisible()).toBe(true);
      expect(await page.getByRole('button', { name: 'Save name' }).count()).toBe(0);

      // And back, by the strip again: the identity page, with its cards.
      await strip.getByRole('link', { name: 'Profile' }).click();
      await page.waitForURL(`${baseUrl}${PROFILE_PAGE_PATH}`, { timeout: 30_000 });
      await expect
        .poll(() => page.getByRole('button', { name: 'Save name' }).count(), { timeout: 30_000 })
        .toBe(1);
      await expect.poll(() => currentSection(page)).toBe('Profile');
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('marks the section on a hard load of its address, and signing out from it ends the session', async () => {
    const member = await memberPastTheTour('profile-settings-exit');
    const page = await signInAs(member);
    try {
      await page.goto(`${baseUrl}${settings.href}`, { waitUntil: 'domcontentloaded' });
      await expect.poll(() => currentSection(page), { timeout: 30_000 }).toBe(settings.label);

      await page
        .getByRole('region', { name: 'Session' })
        .getByRole('button', { name: 'Sign out' })
        .click();
      await page.waitForURL(/\/sign-in/, { timeout: 30_000 });

      // The session is gone server-side, not only on this tab: the profile now refuses this browser.
      await page.goto(`${baseUrl}${PROFILE_PAGE_PATH}`, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(/\/sign-in/, { timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('the name', () => {
  it('shows the current name, saves a new one, and the next load shows what was saved', async () => {
    const member = await memberPastTheTour('profile-name');
    const page = await onTheProfile(member);
    try {
      const field = page.getByLabel('Display name');
      await expect.poll(() => field.inputValue()).toBe(member.displayName);
      // Nothing to save until something changed.
      expect(await page.getByRole('button', { name: 'Save name' }).isDisabled()).toBe(true);

      await field.fill('  Ada Lovelace  ');
      await page.getByRole('button', { name: 'Save name' }).click();
      await expect
        .poll(() => page.getByRole('status').filter({ hasText: 'Ada Lovelace' }).count(), {
          timeout: 30_000,
        })
        .toBe(1);
      // Trimmed by the API, and what the field then holds is the API's answer.
      await expect.poll(() => field.inputValue()).toBe('Ada Lovelace');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => page.getByLabel('Display name').inputValue(), { timeout: 30_000 })
        .toBe('Ada Lovelace');
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('says the rule while it is being broken, and will not send a name over the ceiling', async () => {
    const member = await memberPastTheTour('profile-long');
    const page = await onTheProfile(member);
    try {
      const field = page.getByLabel('Display name');
      // `maxLength` stops the keyboard at the ceiling; typing past it is what a paste does.
      await field.evaluate((element) => {
        (element as HTMLInputElement).removeAttribute('maxlength');
      });
      await field.fill('x'.repeat(81));
      await expect.poll(() => page.getByText('names go up to 80').count()).toBe(1);
      expect(await page.getByRole('button', { name: 'Save name' }).isDisabled()).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});

describe('the picture', () => {
  it('starts as initials, becomes the chosen picture squared in the browser, and can be removed', async () => {
    const member = await memberPastTheTour('profile-picture');
    const page = await onTheProfile(member, PHONE);
    try {
      // No picture: the monogram, and no remove control to press.
      await expect.poll(() => page.getByRole('img', { name: 'No picture yet' }).count()).toBe(1);
      expect(await page.getByRole('button', { name: 'Remove picture' }).count()).toBe(0);

      // A 1600 × 800 landscape, whose centre 800 × 800 is blue and whose wings are red.
      const png = await landscapePng(page, 1600, 800);
      await page.locator('input[name="avatar"]').setInputFiles({
        name: 'me.png',
        mimeType: 'image/png',
        buffer: png,
      });

      // The crop step, confirmed where it starts: the centre square.
      const sheet = page.getByRole('dialog', { name: 'Crop your picture' });
      await expect.poll(() => sheet.count(), { timeout: 30_000 }).toBe(1);
      await sheet.getByRole('button', { name: 'Use this picture' }).click();

      const portrait = page.getByRole('img', { name: 'Your picture', exact: true });
      await expect.poll(() => portrait.count(), { timeout: 60_000 }).toBe(1);
      await expect
        .poll(() => portrait.getAttribute('src'), { timeout: 30_000 })
        .toContain('X-Amz-Signature');

      // 512 square — the bound — and blue at every corner, which only the centre square of the
      // source is.
      const stored = await storedPicture(page);
      expect(stored.width).toBe(512);
      expect(stored.height).toBe(512);
      for (const [red, green, blue] of stored.corners) {
        expect(blue, 'a corner was not blue: the centre square was not what was stored').toBeGreaterThan(
          200,
        );
        expect(red).toBeLessThan(60);
        expect(green).toBeLessThan(60);
      }

      // The saved picture opens larger from the portrait, and closes again.
      await page.getByRole('button', { name: 'View your picture' }).click();
      const viewer = page.getByRole('dialog', { name: 'Your picture, enlarged' });
      await expect.poll(() => viewer.count()).toBe(1);
      expect(await viewer.getByRole('img', { name: 'Your picture, enlarged' }).getAttribute('src')).toBe(
        await portrait.getAttribute('src'),
      );
      await viewer.getByRole('button', { name: 'Close' }).click();
      await expect.poll(() => viewer.count()).toBe(0);

      await page.getByRole('button', { name: 'Remove picture' }).click();
      await expect
        .poll(() => page.getByRole('img', { name: 'No picture yet' }).count(), { timeout: 30_000 })
        .toBe(1);
      expect(await portrait.count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('stores the square the member chose — zoomed in and dragged to the left wing', async () => {
    const member = await memberPastTheTour('profile-crop');
    const page = await onTheProfile(member, PHONE);
    try {
      const requests: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes('/avatar')) requests.push(request.url());
      });

      const png = await landscapePng(page, 1600, 800);
      await page.locator('input[name="avatar"]').setInputFiles({
        name: 'me.png',
        mimeType: 'image/png',
        buffer: png,
      });
      const sheet = page.getByRole('dialog', { name: 'Crop your picture' });
      await expect.poll(() => sheet.count(), { timeout: 30_000 }).toBe(1);
      const square = sheet.getByLabel('The square that will be kept', { exact: false });
      await expect.poll(() => square.count()).toBe(1);

      // Zoom 2: a 400 square, which starts in the blue centre.
      await setZoom(page, 2);
      // Dragged to the left edge of the stage and well past it: clamped to x = 0, which is the red
      // wing and nothing else.
      const box = await square.boundingBox();
      if (box === null) throw new Error('the crop square was not painted');
      const fromX = box.x + box.width / 2;
      const fromY = box.y + box.height / 2;
      await page.mouse.move(fromX, fromY);
      await page.mouse.down();
      await page.mouse.move(1, fromY, { steps: 8 });
      await page.mouse.up();

      // Choosing and cropping asked the API for nothing: the grant is budgeted (3.1.22).
      expect(requests).toEqual([]);
      await sheet.getByRole('button', { name: 'Use this picture' }).click();

      const portrait = page.getByRole('img', { name: 'Your picture', exact: true });
      await expect.poll(() => portrait.count(), { timeout: 60_000 }).toBe(1);
      await expect
        .poll(() => portrait.getAttribute('src'), { timeout: 30_000 })
        .toContain('X-Amz-Signature');

      // 400 square — under the bound, so not scaled up — and red at every corner.
      const stored = await storedPicture(page);
      expect(stored.width).toBe(400);
      expect(stored.height).toBe(400);
      for (const [red, green, blue] of stored.corners) {
        expect(red, 'a corner was not red: the chosen square was not what was stored').toBeGreaterThan(
          200,
        );
        expect(green).toBeLessThan(60);
        expect(blue).toBeLessThan(60);
      }
    } finally {
      await page.context().close();
    }
  }, 180_000);

  it('cancels the crop without asking for a grant, and the picture is as it was', async () => {
    const member = await memberPastTheTour('profile-crop-cancel');
    const page = await onTheProfile(member);
    try {
      const requests: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes('/avatar')) requests.push(request.url());
      });

      const png = await landscapePng(page, 1600, 800);
      await page.locator('input[name="avatar"]').setInputFiles({
        name: 'me.png',
        mimeType: 'image/png',
        buffer: png,
      });
      const sheet = page.getByRole('dialog', { name: 'Crop your picture' });
      await expect.poll(() => sheet.count(), { timeout: 30_000 }).toBe(1);
      await sheet.getByRole('button', { name: 'Cancel' }).click();
      await expect.poll(() => sheet.count()).toBe(0);

      expect(await page.getByRole('img', { name: 'No picture yet' }).count()).toBe(1);
      expect(requests).toEqual([]);
      // The picker is live again: the same file can be chosen a second time.
      expect(await page.locator('input[name="avatar"]').isDisabled()).toBe(false);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('refuses a file that is not an image before anything is sent, in the API’s own words', async () => {
    const member = await memberPastTheTour('profile-not-image');
    const page = await onTheProfile(member);
    try {
      const requests: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes('/avatar')) requests.push(request.url());
      });
      await page.locator('input[name="avatar"]').setInputFiles({
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('not a picture'),
      });
      await expect
        .poll(() => page.getByRole('alert').filter({ hasText: 'JPEG, PNG or WebP' }).count())
        .toBe(1);
      expect(requests).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});
