import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The public document, rendered to markup with the session answered by a stub.
 *
 * The one thing the component decides for itself is where "back" falls back to, and it decides it
 * from the session — so the session module is replaced here with an answer the test chooses, and
 * everything under it (the cookie jar, the database) is never loaded. The router behind the back
 * route is stubbed for the same reason: outside Next there is none, and the markup is what this
 * file is about.
 */
vi.mock('@/server/auth/current-actor', () => ({ currentActor: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ back: vi.fn() }) }));

import { currentActor } from '@/server/auth/current-actor';
import { PublicDocument } from '@/app/(public)/public-document';

const session = vi.mocked(currentActor);

const SECTIONS = [
  { heading: 'What we keep', body: createElement('p', null, 'Your email address and your notes.') },
  {
    heading: 'Who to ask',
    body: createElement('p', null, 'Write to ', createElement('a', { href: 'mailto:hi@example.test' }, 'us')),
  },
];

async function render(signedIn: boolean, updatedOn = '2026-03-03'): Promise<string> {
  // A stand-in actor: the component asks only whether there is one.
  session.mockResolvedValue(signedIn ? ({ id: 'someone' } as never) : null);
  const element = await PublicDocument({ title: 'Privacy policy', updatedOn, sections: SECTIONS });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  session.mockReset();
});

describe('a public document', () => {
  it('draws the title, the day it was last updated, and every section under its own heading', async () => {
    const html = await render(false);

    expect(html).toContain('<h1 class="');
    expect(html).toContain('Privacy policy</h1>');
    // The day as a person reads it, with the machine-readable day beside it. React spells the
    // attribute `dateTime` in static markup; the browser reads it case-insensitively.
    expect(html).toContain('Last updated <time dateTime="2026-03-03">3 March 2026</time>');
    expect(html).toContain('What we keep</h2>');
    expect(html).toContain('Your email address and your notes.');
    expect(html).toContain('Who to ask</h2>');
    expect(html).toContain('href="mailto:hi@example.test"');
    // Sections in the order given, headings before their bodies.
    expect(html.indexOf('What we keep')).toBeLessThan(html.indexOf('Who to ask'));
  });

  it('sends a reader without a session back to sign-in', async () => {
    const html = await render(false);
    expect(html).toContain('href="/sign-in"');
    expect(html).toMatch(/href="\/sign-in"[^>]*>Back<\/a>/);
    expect(html).not.toContain('href="/"');
  });

  it('sends a reader with a session back to the app', async () => {
    const html = await render(true);
    expect(html).toMatch(/href="\/"[^>]*>Back<\/a>/);
    expect(html).not.toContain('href="/sign-in"');
  });

  it('refuses a date that is not a calendar day rather than printing "Invalid Date"', async () => {
    await expect(render(false, 'March 3rd')).rejects.toThrow(/YYYY-MM-DD/);
    await expect(render(false, '2026-03-03T10:00:00Z')).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('names the same day whatever zone the server is in', async () => {
    // A day, not an instant: the last day of a year must not print as the first of the next.
    const html = await render(false, '2025-12-31');
    expect(html).toContain('31 December 2025');
  });
});
