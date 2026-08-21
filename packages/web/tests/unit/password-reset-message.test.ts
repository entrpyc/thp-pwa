import { describe, expect, it } from 'vitest';
import {
  passwordResetHtml,
  passwordResetMessage,
  passwordResetText,
  type PasswordResetMessageInput,
} from '@/server/mail/password-reset-message';

/**
 * The second message this product sends, without a transport in the way.
 *
 * The properties are the invitation message's, checked again rather than assumed — a template that
 * inherits a decision only in prose has not inherited it. What is specific to this one is what a
 * reset owes its reader: how long the link lasts, and that ignoring it is safe.
 */

const RESET_URL = 'https://hub.example.test/reset-password?token=an-opaque-token-value';

function input(overrides: Partial<PasswordResetMessageInput> = {}): PasswordResetMessageInput {
  return {
    to: 'person@example.test',
    resetUrl: RESET_URL,
    expiresAt: new Date('2026-09-01T10:00:00.000Z'),
    ...overrides,
  };
}

/** The same way a text client finds a link: scan for the scheme, take to whitespace. */
function linksIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/\S+/g)].map((match) => match[0]);
}

describe('the password-reset message', () => {
  it('is HTML with a plain-text alternative, and both are non-empty', () => {
    const message = passwordResetMessage(input());
    expect(message.to).toBe('person@example.test');
    expect(message.subject.length).toBeGreaterThan(0);
    expect(message.html).toContain('<html');
    expect(message.text.trim().length).toBeGreaterThan(0);
    expect(message.text).not.toContain('<');
  });

  it('carries the reset link in the plain-text part, extractable as a link', () => {
    expect(linksIn(passwordResetText(input()))).toContain(RESET_URL);
  });

  it('carries the same link in the HTML part, as the one thing to press', () => {
    const hrefs = [...passwordResetHtml(input()).matchAll(/href="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect([...new Set(hrefs)]).toEqual([RESET_URL]);
  });

  it('says when the link stops working, as a time rather than a countdown', () => {
    // A countdown computed at send time is wrong by the time an inbox is read.
    for (const part of [passwordResetText(input()), passwordResetHtml(input())]) {
      expect(part).toContain('10:00');
      expect(part).toContain('1 September');
      expect(part.toLowerCase()).toContain('one hour');
    }
  });

  it('says what to do if it was not you, and that nothing has changed yet', () => {
    const message = passwordResetMessage(input());
    for (const part of [message.text, message.html]) {
      expect(part.toLowerCase()).toContain('not you');
      expect(part.toLowerCase()).toContain('nothing has changed');
    }
  });

  it('discloses nothing about the account beyond that a reset was requested', () => {
    const message = passwordResetMessage(input());
    const whole = `${message.text}\n${message.html}`.toLowerCase();
    // A denylist of account fields and of anything that names a role. The message lands in an
    // inbox, and an inbox is not the place to advertise which addresses are worth attacking.
    for (const forbidden of [
      'as an admin',
      'as a member',
      'your role',
      'role:',
      'administrator',
      'displayname',
      'password_hash',
      'created',
      'last signed in',
    ]) {
      expect(whole, forbidden).not.toContain(forbidden);
    }
    // Not even the address it is going to — the recipient is looking at their own inbox.
    expect(whole).not.toContain('person@example.test');
  });

  it('embeds no image and no remote asset, so images-off changes nothing', () => {
    const html = passwordResetHtml(input());
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/background-image/i);
    expect(html).not.toMatch(/<link\b[^>]*stylesheet/i);
  });

  it('escapes the URL rather than letting it close an attribute', () => {
    const html = passwordResetHtml(
      input({ resetUrl: 'https://hub.example.test/reset-password?token="><script>x</script>' }),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;');
  });
});
