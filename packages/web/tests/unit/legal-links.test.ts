import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DELETE_ACCOUNT_PAGE_PATH,
  PRIVACY_PAGE_PATH,
  SUPPORT_PAGE_PATH,
  TERMS_PAGE_PATH,
} from '@thp/shared';
import { LEGAL_LINKS, LegalLinks } from '@/app/(public)/legal-links';

/**
 * The legal links row. Three properties: the shipped list names exactly the pages that exist, in
 * the order a store reviewer reads them; nothing at all when the list is empty — not a wrapper,
 * not a border; and one link per entry, in the order given, when it is not.
 */
describe('the legal links row', () => {
  it('ships with the four pages the app stores require, policy first', () => {
    // The paths are the vocabulary's, so the row and the store consoles cite the same ones. The
    // deletion-request page is last: the one link a member is meant to need once.
    expect(LEGAL_LINKS).toEqual([
      { href: PRIVACY_PAGE_PATH, label: 'Privacy policy' },
      { href: TERMS_PAGE_PATH, label: 'Terms' },
      { href: SUPPORT_PAGE_PATH, label: 'Support' },
      { href: DELETE_ACCOUNT_PAGE_PATH, label: 'Delete account' },
    ]);
  });

  it('draws the shipped list when the host names none', () => {
    const html = renderToStaticMarkup(createElement(LegalLinks, null));
    expect(html.match(/<li>/g)).toHaveLength(LEGAL_LINKS.length);
    for (const link of LEGAL_LINKS) expect(html).toContain(`href="${link.href}"`);
  });

  it('renders nothing for an empty list, even when the host hands it a class to wear', () => {
    expect(renderToStaticMarkup(createElement(LegalLinks, { links: [] }))).toBe('');
    expect(renderToStaticMarkup(createElement(LegalLinks, { links: [], className: 'footer' }))).toBe('');
  });

  it('renders one link per entry, in order, inside a named navigation landmark', () => {
    const html = renderToStaticMarkup(
      createElement(LegalLinks, {
        className: 'footer',
        links: [
          { href: '/privacy', label: 'Privacy policy' },
          { href: '/terms', label: 'Terms' },
        ],
      }),
    );

    expect(html).toContain('<nav aria-label="Legal"');
    expect(html).toContain(' footer"');
    expect(html).toMatch(/<a [^>]*href="\/privacy"[^>]*>Privacy policy<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/terms"[^>]*>Terms<\/a>/);
    expect(html.indexOf('/privacy')).toBeLessThan(html.indexOf('/terms'));
    expect(html.match(/<li>/g)).toHaveLength(2);
  });
});
