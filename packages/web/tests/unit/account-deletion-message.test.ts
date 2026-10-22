import { describe, expect, it } from 'vitest';
import {
  accountDeletionHtml,
  accountDeletionMessage,
  accountDeletionText,
  type AccountDeletionMessageInput,
} from '@/server/mail/account-deletion-message';

/**
 * The account-deletion message, without a transport in the way.
 *
 * The reset message's properties, checked again rather than inherited in prose, plus the three a
 * deletion message specifically owes its reader: what will happen, that the link alone does
 * nothing, and how long it lasts.
 */

const DELETION_URL = 'https://hub.example.test/delete-account?token=an-opaque-token-value';

function input(overrides: Partial<AccountDeletionMessageInput> = {}): AccountDeletionMessageInput {
  return {
    to: 'person@example.test',
    deletionUrl: DELETION_URL,
    expiresAt: new Date('2026-09-01T10:00:00.000Z'),
    ...overrides,
  };
}

function linksIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/\S+/g)].map((match) => match[0]);
}

describe('the account-deletion message', () => {
  it('is HTML with a plain-text alternative, and both are non-empty', () => {
    const message = accountDeletionMessage(input());
    expect(message.to).toBe('person@example.test');
    expect(message.subject.toLowerCase()).toContain('delete');
    expect(message.html).toContain('<html');
    expect(message.text.trim().length).toBeGreaterThan(0);
    expect(message.text).not.toContain('<');
  });

  it('carries the link in the plain-text part and as the one thing to press in the HTML', () => {
    expect(linksIn(accountDeletionText(input()))).toContain(DELETION_URL);
    const hrefs = [...accountDeletionHtml(input()).matchAll(/href="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect([...new Set(hrefs)]).toEqual([DELETION_URL]);
  });

  it('says what deleting does, and that public notes stay under the placeholder name', () => {
    for (const part of [accountDeletionText(input()), accountDeletionHtml(input())]) {
      expect(part.toLowerCase()).toContain('private notes');
      expect(part).toContain('Removed member');
    }
  });

  it('says the link alone does nothing and that the password is needed', () => {
    for (const part of [accountDeletionText(input()), accountDeletionHtml(input())]) {
      expect(part.toLowerCase()).toContain('not you');
      expect(part.toLowerCase()).toContain('password');
      expect(part.toLowerCase()).toContain('alone does nothing');
    }
  });

  it('says when the link stops working, as a time rather than a countdown', () => {
    for (const part of [accountDeletionText(input()), accountDeletionHtml(input())]) {
      expect(part).toContain('10:00');
      expect(part).toContain('1 September');
      expect(part.toLowerCase()).toContain('one hour');
    }
  });

  it('discloses nothing about the account beyond that deletion was requested', () => {
    const message = accountDeletionMessage(input());
    const whole = `${message.text}\n${message.html}`.toLowerCase();
    for (const forbidden of ['as an admin', 'your role', 'administrator', 'displayname', 'created']) {
      expect(whole, forbidden).not.toContain(forbidden);
    }
    expect(whole).not.toContain('person@example.test');
  });

  it('embeds no image and no remote asset, and escapes the URL', () => {
    const html = accountDeletionHtml(input());
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/<link\b[^>]*stylesheet/i);
    const hostile = accountDeletionHtml(
      input({ deletionUrl: 'https://hub.example.test/delete-account?token="><script>x</script>' }),
    );
    expect(hostile).not.toContain('<script>');
    expect(hostile).toContain('&quot;');
  });
});
