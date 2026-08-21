import { describe, expect, it } from 'vitest';
import {
  invitationHtml,
  invitationMessage,
  invitationText,
  type InvitationMessageInput,
} from '@/server/mail/invitation-message';

/**
 * The message itself, without a transport in the way.
 *
 * The property worth pinning here is the one a person can be locked out by: **the plain-text part
 * carries the same working link as the HTML part**. A text client, a notification preview and some
 * accessibility tooling read that part and nothing else, and an invitation whose only link lives
 * inside a table layout is an invitation some people cannot accept.
 */

const ACCEPT_URL = 'https://hub.example.test/accept-invitation?token=an-opaque-token-value';

function input(overrides: Partial<InvitationMessageInput> = {}): InvitationMessageInput {
  return {
    to: 'invitee@example.test',
    invitedByName: 'Ada Teacher',
    acceptUrl: ACCEPT_URL,
    expiresAt: new Date('2026-09-01T10:00:00.000Z'),
    ...overrides,
  };
}

/** The same way a text client finds a link: scan for the scheme, take to whitespace. */
function linksIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/\S+/g)].map((match) => match[0]);
}

describe('the invitation message', () => {
  it('is HTML with a plain-text alternative, and both are non-empty', () => {
    const message = invitationMessage(input());
    expect(message.to).toBe('invitee@example.test');
    expect(message.subject.length).toBeGreaterThan(0);
    expect(message.html).toContain('<html');
    expect(message.text.trim().length).toBeGreaterThan(0);
    expect(message.text).not.toContain('<');
  });

  it('carries the accept link in the plain-text part, extractable as a link', () => {
    const links = linksIn(invitationText(input()));
    expect(links).toContain(ACCEPT_URL);
  });

  it('carries the same link in the HTML part, as the one thing to press', () => {
    const html = invitationHtml(input());
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    // Exactly one link target, and it is the accept URL. Everything else is text.
    expect([...new Set(hrefs)]).toEqual([ACCEPT_URL]);
  });

  it('says who invited you, and falls back cleanly when that account is gone', () => {
    expect(invitationText(input())).toContain('Ada Teacher');
    const orphaned = invitationText(input({ invitedByName: null }));
    expect(orphaned).toContain('invited');
    expect(orphaned).not.toContain('null');
    expect(orphaned).not.toContain('undefined');
  });

  it('says when it expires, as a date rather than a countdown', () => {
    // A countdown computed at send time is wrong by the time an inbox is read.
    expect(invitationText(input())).toContain('1 September 2026');
    expect(invitationHtml(input())).toContain('1 September 2026');
  });

  it('never tells the reader which role they are being given', () => {
    // An inbox is not the place to advertise which addresses are worth attacking. "Ask an admin to
    // send a new one" is copy about who to go to, so what is checked for is the *assignment*.
    const message = invitationMessage(input());
    const whole = `${message.text}\n${message.html}`.toLowerCase();
    for (const phrase of ['as an admin', 'as a member', 'your role', 'role:', 'administrator']) {
      expect(whole, phrase).not.toContain(phrase);
    }
  });

  it('embeds no image and no remote asset, so images-off changes nothing', () => {
    const html = invitationHtml(input());
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/background-image/i);
    expect(html).not.toMatch(/<link\b[^>]*stylesheet/i);
  });

  it('escapes a display name rather than letting it close a tag', () => {
    const html = invitationHtml(input({ invitedByName: '<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes once, not twice — an ampersand in a name stays an ampersand', () => {
    const html = invitationHtml(input({ invitedByName: 'Ada & Grace' }));
    expect(html).toContain('Ada &amp; Grace');
    expect(html).not.toContain('&amp;amp;');
  });
});
