import { describe, expect, it } from 'vitest';
import { hashPassword, verifyAgainstDecoy, verifyPassword } from '@/server/auth/password';

const PASSWORD = 'a passphrase nobody else has chosen';

describe('password hashing', () => {
  it('produces a hash that is not the password, nor any obvious encoding of it', async () => {
    const stored = await hashPassword(PASSWORD);

    expect(stored).not.toBe(PASSWORD);
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(Buffer.from(PASSWORD).toString('base64'));
    expect(stored).not.toContain(Buffer.from(PASSWORD).toString('base64url'));
    expect(stored).not.toContain(Buffer.from(PASSWORD).toString('hex'));
  });

  it('ships argon2id', async () => {
    expect(await hashPassword(PASSWORD)).toMatch(/^\$argon2id\$/);
  });

  it('salts per password: the same input hashed twice differs, and both verify', async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);

    expect(first).not.toBe(second);
    expect(await verifyPassword(first, PASSWORD)).toBe(true);
    expect(await verifyPassword(second, PASSWORD)).toBe(true);
  });

  it('verifies the right password and refuses a wrong one', async () => {
    const stored = await hashPassword(PASSWORD);

    expect(await verifyPassword(stored, PASSWORD)).toBe(true);
    expect(await verifyPassword(stored, `${PASSWORD} `)).toBe(false);
    expect(await verifyPassword(stored, PASSWORD.toUpperCase())).toBe(false);
    expect(await verifyPassword(stored, '')).toBe(false);
  });

  it('returns false rather than throwing on a stored value that is not a hash', async () => {
    for (const nonsense of ['', 'not-a-hash', '$argon2id$broken', '{}']) {
      await expect(verifyPassword(nonsense, PASSWORD)).resolves.toBe(false);
    }
  });

  it('spends real work on the decoy, so an unknown address answers no faster than a known one', async () => {
    // Warm the decoy first: the cost being measured is the verification, not the one-off hash.
    await verifyAgainstDecoy('warm');

    const stored = await hashPassword(PASSWORD);
    const realStart = performance.now();
    await verifyPassword(stored, 'wrong password entirely');
    const real = performance.now() - realStart;

    const decoyStart = performance.now();
    expect(await verifyAgainstDecoy('wrong password entirely')).toBe(false);
    const decoy = performance.now() - decoyStart;

    // Same order of magnitude is the property; an exact match is not achievable or needed.
    expect(decoy).toBeGreaterThan(real / 4);
  });
});
