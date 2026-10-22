import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LEGAL_LINKS, LegalLinks } from '@/app/(public)/legal-links';

/**
 * The legal links row. Two properties: nothing at all when the list is empty — not a wrapper, not
 * a border — and one link per entry, in the order given, when it is not.
 */
describe('the legal links row', () => {
  it('ships with an empty list, because the pages it would link to do not exist yet', () => {
    expect(LEGAL_LINKS).toEqual([]);
  });

  it('renders nothing for an empty list, even when the host hands it a class to wear', () => {
    expect(renderToStaticMarkup(createElement(LegalLinks, null))).toBe('');
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
