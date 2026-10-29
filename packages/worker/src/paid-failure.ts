import type { ProviderMeta } from '@thp/db';

/**
 * **A failure that already cost money.**
 *
 * The spend ledger is one aggregate over `job.provider_meta.costUsd` (packages/db/src/spend.ts).
 * A handler that pays a provider and then throws — the transcript written but under the confidence
 * gate, a model that answered in the wrong shape, a second embedding batch refused after the first
 * was billed — used to leave a failed row with no meta, and the ledger read that run as free. An
 * admin re-running a step that always fails *after* the provider call could therefore spend without
 * bound while the ceiling never moved (security audit 2026-10-28, finding 8).
 *
 * So a handler that has paid attaches what it has paid to whatever it throws, and the runner
 * writes that meta onto the failed row exactly as it writes a succeeded one's. The shape is the
 * same `providerMeta` a success would have recorded, which is what lets the ledger sum both
 * statuses with one query.
 *
 * `cause` is kept, so the log line still carries the original stack.
 */
export class PaidFailure extends Error {
  readonly providerMeta: ProviderMeta;

  constructor(message: string, providerMeta: ProviderMeta, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PaidFailure';
    this.providerMeta = providerMeta;
  }
}

/**
 * The failure to throw once money has been spent: the error as it is when it already carries its
 * spend, and the same message wrapped with the spend when it does not. Idempotent, so a handler
 * that re-wraps on the way out does not lose what an inner throw attached.
 */
export function withSpend(cause: unknown, providerMeta: ProviderMeta): PaidFailure {
  if (cause instanceof PaidFailure) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new PaidFailure(message, providerMeta, { cause });
}

/** What a thrown failure says it cost, or `null` for one that cost nothing it knows of. */
export function spendOfFailure(cause: unknown): ProviderMeta | null {
  return cause instanceof PaidFailure ? cause.providerMeta : null;
}
