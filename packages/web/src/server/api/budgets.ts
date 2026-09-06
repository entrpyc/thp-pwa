/**
 * What every request budget shares, and nothing that belongs to one of them.
 *
 * Two things, both small enough that duplicating them would have been the easy choice and the
 * wrong one: how a budget's number is read from the environment, and how a wait is described to a
 * person. Registration wrote both first (`server/auth/sign-up-limits.ts`); sign-in needs the same
 * two (docs/project/rate-limits.md § 2), and a third budget will need them again. Keeping them
 * here means a rule such as "a setting that is not a positive whole number is refused naming the
 * variable" is one rule, stated once, and holds for every budget at the same time.
 */

export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * A positive whole number from the environment, or its default.
 *
 * Refused rather than clamped when it is anything else: a limit of `0` or `lots` is a deployment
 * that meant something and got nothing, and the honest answer is the variable's name in an error.
 */
export function readBudgetCount(env: EnvSource, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} is "${raw}", which is not a positive whole number. See .env.example.`);
  }
  return parsed;
}

/** A wait a person can act on. Nobody reads "in 437 seconds" and does anything different. */
export function describeWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** `retryAfterMs` as the whole seconds a `Retry-After` header carries, never below one. */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}
