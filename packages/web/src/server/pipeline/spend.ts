import {
  findUserById,
  formatUsd,
  raiseSpendCeilingToday,
  readSpendCeilingUsdPerDay,
  readSpendLedger,
  spendCeilingReached,
  type SpendLedger,
} from '@thp/db';
import {
  MAX_SPEND_CEILING_RAISE_USD,
  MAX_SPEND_RAISE_REASON_LENGTH,
  isSpendingStep,
  type PipelineStep,
  type RaiseSpendCeilingRequest,
  type SpendPayload,
  type SpendView,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';

/**
 * The daily spend ceiling, from the API's side (docs/project/prd.md, 3.19.16 and 3.21.2.8;
 * docs/project/rate-limits.md § 3).
 *
 * The worker is where the ceiling is *enforced* — it refuses a paid step before calling the
 * provider, and that check has to exist whatever this file does. What this file adds is the two
 * things an admin at the pipeline view needs: the number, and the fix.
 *
 * - **The number.** Today's spend against today's ceiling, on the same payload as the recordings,
 *   so the view shows the failure and its cause in one refresh.
 * - **The fix.** A raise for the rest of the day, floored at the configured default and capped so
 *   a mistyped amount cannot be an instruction to spend without limit.
 *
 * And one courtesy: a re-run or a regenerate that would be refused by the worker a minute from
 * now is refused here, now, with the same numbers — so an admin pressing the button learns why
 * rather than reading a failed row later. The automatic enqueue on upload does **not** ask: the
 * upload has already happened, the job belongs in the ledger, and it will fail with the named
 * reason if the ceiling holds when the worker reaches it.
 */

export async function readSpendView(): Promise<SpendView> {
  return describeLedger(await readSpendLedger(readSpendCeilingUsdPerDay()));
}

/**
 * Refuse now what the worker would refuse later. A free step never asks.
 *
 * Read fresh each time rather than cached: the ledger moves whenever a job finishes, and an admin
 * who has just raised the ceiling should find the very next press allowed.
 */
export async function requireSpendHeadroom(step: PipelineStep): Promise<void> {
  if (!isSpendingStep(step)) return;
  const ledger = await readSpendLedger(readSpendCeilingUsdPerDay());
  if (!spendCeilingReached(ledger)) return;
  throw ApiError.spendCeilingReached(
    `Today's paid work has reached its ceiling (${formatUsd(ledger.todayUsd)} of ` +
      `${formatUsd(ledger.ceilingUsd)}). Raise the ceiling from the pipeline view, or wait for ` +
      'the day to end.',
  );
}

/**
 * Raise today's ceiling ([3.19.16](docs/project/prd.md)).
 *
 * The number is the whole ceiling for the rest of the day, not an increment, because that is the
 * number the ledger enforces and the only reading that survives being looked at tomorrow. Below
 * the configured default it is refused naming the floor; above {@link MAX_SPEND_CEILING_RAISE_USD}
 * it is refused naming the cap. Both are `invalid_input`: the request was understood and the
 * number was wrong.
 */
export async function raiseSpendCeiling(actor: Actor, body: unknown): Promise<SpendPayload> {
  const defaultUsd = readSpendCeilingUsdPerDay();
  const requested = parseRaiseRequest(body, defaultUsd);
  const before = await readSpendLedger(defaultUsd);

  const raise = await raiseSpendCeilingToday({
    ceilingUsd: requested.ceilingUsd,
    raisedBy: actor.id,
    reason: requested.reason,
  });

  logger.warn('spend.ceiling.raised', {
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'spend.raise',
    target: 'spend-ceiling:today',
    fromUsd: before.ceilingUsd,
    toUsd: raise.ceilingUsd,
    requestedUsd: requested.ceilingUsd,
    reason: requested.reason,
  });

  return { spend: await readSpendView() };
}

async function describeLedger(ledger: SpendLedger): Promise<SpendView> {
  let raisedByName: string | null = null;
  if (ledger.raise?.raisedBy) {
    raisedByName = (await findUserById(ledger.raise.raisedBy))?.displayName ?? null;
  }
  return {
    todayUsd: ledger.todayUsd,
    byStep: ledger.byStep,
    ceilingUsd: ledger.ceilingUsd,
    defaultUsd: ledger.defaultUsd,
    raise:
      ledger.raise === null
        ? null
        : {
            ceilingUsd: ledger.raise.ceilingUsd,
            raisedBy: ledger.raise.raisedBy,
            raisedByName,
            raisedAt: ledger.raise.raisedAt.toISOString(),
            reason: ledger.raise.reason,
          },
    dayEndsAt: ledger.dayEndsAt.toISOString(),
  };
}

function parseRaiseRequest(
  body: unknown,
  defaultUsd: number,
): { readonly ceilingUsd: number; readonly reason: string | null } {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with the ceiling in dollars.');
  }
  const { ceilingUsd, reason } = body as Partial<RaiseSpendCeilingRequest>;

  if (typeof ceilingUsd !== 'number' || !Number.isFinite(ceilingUsd)) {
    throw ApiError.invalidInput('Give the ceiling as a number of dollars.');
  }
  // To the cent, so what is written is what the screen will read back.
  const rounded = Math.round(ceilingUsd * 100) / 100;
  if (rounded < defaultUsd) {
    throw ApiError.invalidInput(
      `The ceiling cannot go below the configured ${formatUsd(defaultUsd)} a day.`,
    );
  }
  if (rounded > MAX_SPEND_CEILING_RAISE_USD) {
    throw ApiError.invalidInput(
      `The ceiling cannot be raised above ${formatUsd(MAX_SPEND_CEILING_RAISE_USD)} in one day. ` +
        'A deliberate backfill larger than that is a configuration change, not a raise.',
    );
  }

  if (reason === undefined || reason === null) return { ceilingUsd: rounded, reason: null };
  if (typeof reason !== 'string') {
    throw ApiError.invalidInput('The reason, if given, is a short sentence.');
  }
  const trimmed = reason.trim();
  if (trimmed.length > MAX_SPEND_RAISE_REASON_LENGTH) {
    throw ApiError.invalidInput(
      `Keep the reason to ${MAX_SPEND_RAISE_REASON_LENGTH} characters.`,
    );
  }
  return { ceilingUsd: rounded, reason: trimmed === '' ? null : trimmed };
}
