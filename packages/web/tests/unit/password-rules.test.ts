import { describe, expect, it } from 'vitest';
import { MINIMUM_PASSWORD_LENGTH, PASSWORD_RULE_TEXT, checkPassword } from '@thp/shared';
import { MINIMUM_PASSWORD_LENGTH as SEEDER_MINIMUM } from '@/server/auth/seed-admin';

/**
 * Assumption 10 of the step plan: the password rules are set once and read by everything that
 * applies them. Step 4's reset joins the list; until then the seed command and the invitation
 * accept route are the two, and this file is what stops them coming apart.
 */

describe('one statement of the password rules', () => {
  it('is what the seed command applies, not a second copy of the same number', () => {
    expect(SEEDER_MINIMUM).toBe(MINIMUM_PASSWORD_LENGTH);
  });

  it('is printable, and says the number it enforces', () => {
    // The accept screen shows this before anybody can fail it. A rule that does not state its own
    // threshold is a rule you learn by being refused.
    expect(PASSWORD_RULE_TEXT).toContain(String(MINIMUM_PASSWORD_LENGTH));
  });

  it('accepts a password somebody would actually choose', () => {
    expect(checkPassword('a-genuinely-chosen-passphrase')).toBeNull();
    expect(checkPassword('x'.repeat(MINIMUM_PASSWORD_LENGTH))).toBeNull();
  });

  it.each([
    ['nothing at all', ''],
    ['one character short', 'x'.repeat(MINIMUM_PASSWORD_LENGTH - 1)],
    ['only spaces', ' '.repeat(MINIMUM_PASSWORD_LENGTH + 2)],
    ['the word password', 'Password123456'],
  ])('refuses %s, with a reason', (_label, password) => {
    const reason = checkPassword(password);
    expect(reason).not.toBeNull();
    expect((reason ?? '').length).toBeGreaterThan(0);
  });

  it('refuses the email address as the password, in any casing', () => {
    expect(checkPassword('Person@Example.Test', { email: 'person@example.test' })).not.toBeNull();
  });

  it('never repeats the password in the reason it gives', () => {
    // The reason is printed on a screen, logged by the seed command, and may end up in a
    // screenshot. It must not be able to carry the secret with it.
    const secret = 'Password-Not-A-Secret-1';
    expect(checkPassword(secret, { email: 'person@example.test' })).not.toContain(secret);
    expect(checkPassword('sh0rt', { email: 'person@example.test' })).not.toContain('sh0rt');
  });
});
