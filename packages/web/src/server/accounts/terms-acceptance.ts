import { recordTermsAcceptance } from '@thp/db';
import {
  TERMS_VERSION,
  termsAcceptanceIsCurrent,
  type TermsAcceptancePayload,
  type TermsAcceptanceRequest,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';

/**
 * **Record that the signed-in account accepted the terms in force** (Google Play UGC policy: a
 * member accepts the terms before they post).
 *
 * The shape `writeAnalyticsPreference` has: parse, write the row, log, answer with what the row
 * holds. The parse is the one decision here: the body carries the version the screen showed, and
 * **only the current version is accepted**. A prompt rendered against an older `TERMS_VERSION` —
 * a tab left open across a deploy that changed the terms — is refused with a sentence that says to
 * reload, rather than recorded as acceptance of words the member did not see. The refusal is
 * `invalid_input`, not `terms_required`: the member is not being asked to accept, they are being
 * told the screen is stale.
 *
 * Accepting twice is fine and writes a fresh moment, which is the truthful record of what the
 * member just did. Nothing is sent to analytics about it.
 */
export async function acceptTermsFor(actor: Actor, body: unknown): Promise<TermsAcceptancePayload> {
  const version = parseVersion(body);
  const written = await recordTermsAcceptance(actor.id, version);
  if (written === null) throw ApiError.notFound('There is no such account.');

  logger.info('account.terms.accept', {
    actorId: actor.id,
    action: 'account.terms',
    target: `user:${actor.id}`,
    termsVersion: written.termsAcceptedVersion,
  });

  return {
    termsVersion: written.termsAcceptedVersion,
    acceptedAt: written.termsAcceptedAt.toISOString(),
  };
}

function parseVersion(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with termsVersion.');
  }
  const { termsVersion } = body as Partial<TermsAcceptanceRequest>;
  if (!termsAcceptanceIsCurrent(typeof termsVersion === 'string' ? termsVersion : null)) {
    throw ApiError.invalidInput(
      `The terms have changed since this screen loaded. Reload and accept the terms dated ${TERMS_VERSION}.`,
    );
  }
  return termsVersion as string;
}
