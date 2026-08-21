import { describe, expect, it } from 'vitest';
import { MINIMUM_PASSWORD_LENGTH, seedAdmin } from '@/server/auth/seed-admin';

/**
 * The refusals only. Whether the command actually creates an account, and what running it twice
 * does, are integration questions — see packages/web/tests/integration/seed-admin.test.ts.
 */
describe('the seed-admin command refuses rather than seeding a guessable account', () => {
  const valid = {
    email: 'first.admin@example.test',
    displayName: 'First Admin',
    password: 'a-genuinely-chosen-passphrase',
  };

  it.each([
    ['no password', { ...valid, password: undefined }],
    ['an empty password', { ...valid, password: '' }],
    ['whitespace only', { ...valid, password: '            ' }],
    ['a short password', { ...valid, password: 'x'.repeat(MINIMUM_PASSWORD_LENGTH - 1) }],
    ['the word password', { ...valid, password: 'Password123456' }],
    ['the email as the password', { ...valid, password: valid.email }],
    ['no email', { ...valid, email: undefined }],
    ['a non-address', { ...valid, email: 'not-an-address' }],
    ['no display name', { ...valid, displayName: '   ' }],
  ])('refuses %s', async (_label, input) => {
    const outcome = await seedAdmin(input);
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') throw new Error('unreachable');
    expect(outcome.reason).not.toBe('');
  });

  it('says which variable is wrong, so the operator does not have to guess', async () => {
    const outcome = await seedAdmin({ ...valid, password: 'short' });
    if (outcome.status !== 'refused') throw new Error('expected a refusal');
    expect(outcome.reason).toContain('SEED_ADMIN_PASSWORD');
    expect(outcome.reason).toContain(String(MINIMUM_PASSWORD_LENGTH));
  });

  it('never puts the password in the reason it gives', async () => {
    const outcome = await seedAdmin({ ...valid, password: 'Password123456' });
    if (outcome.status !== 'refused') throw new Error('expected a refusal');
    expect(outcome.reason).not.toContain('Password123456');
  });
});
