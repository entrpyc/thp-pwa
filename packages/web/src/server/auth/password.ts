import { hash, verify, type Algorithm, type Options } from '@node-rs/argon2';

/**
 * Password hashing. **argon2id**, via `@node-rs/argon2` — prebuilt binaries, so the deploy host
 * never needs a compiler toolchain.
 *
 * The parameters below are a budget, not a copied default. The target host
 * (docs/architecture.md § the netcup VPS) also runs Postgres and the worker, so 64 MiB of memory
 * per in-flight sign-in is the ceiling worth paying. Measured at ~30 ms on the development machine
 * — the right order for a box several times slower under load, where it lands near 100 ms. Sign-in
 * is a once-a-month action, so that is invisible to the person and expensive to an attacker.
 *
 * The salt is generated per hash by the library and encoded into the stored string, which is why
 * hashing one password twice produces two different values that both verify.
 */
const PARAMETERS: Options = {
  // 2 is `Algorithm.Argon2id`. Spelled as the number because the package declares it as an ambient
  // `const enum`, which `isolatedModules` will not let us import as a value.
  algorithm: 2 as Algorithm,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
};

/**
 * A hash of nothing anybody knows, used to spend the same time on an unknown address as on a known
 * one. Without it, "no such account" returns in a millisecond and "wrong password" in a hundred,
 * and the identical error envelope discloses by timing what it refuses to disclose in words.
 */
let decoyHash: Promise<string> | undefined;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, PARAMETERS);
}

/**
 * `false` for a wrong password *and* for a malformed stored hash — never a throw.
 *
 * No parameters are passed: argon2 encodes them in the hash string, so a hash written under an
 * earlier budget keeps verifying after the budget is raised.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

/** Burn the same work as a real verification, then fail. Called when the address is unknown. */
export async function verifyAgainstDecoy(password: string): Promise<false> {
  decoyHash ??= hashPassword('decoy for the constant-time comparison; never a real credential');
  await verifyPassword(await decoyHash, password);
  return false;
}
