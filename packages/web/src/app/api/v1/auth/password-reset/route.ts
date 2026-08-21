import {
  RESET_TOKEN_PARAM,
  type PasswordResetPreviewPayload,
  type PasswordResetRequestedPayload,
} from '@thp/shared';
import { PUBLIC } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import {
  previewPasswordReset,
  requestPasswordReset,
} from '@/server/password-reset/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/auth/password-reset` — asking for a link, and asking what a link is for.
 *
 * Both are on `server/auth/allowlist.ts`, the single list of exceptions to "every route requires a
 * session"; declaring them `PUBLIC` here would do nothing on its own. Somebody who cannot sign in is
 * by definition anonymous, which is why this pair exists at all.
 */

/**
 * Ask for a reset link. **Answers one fixed payload for every outcome** — sent, unknown address,
 * deactivated account, malformed input, transport down — because a response that told the
 * difference would tell an anonymous caller which addresses have accounts. It is the enumeration
 * rule sign-in already holds, and it is why this route cannot report success or failure honestly.
 */
export const POST = apiRoute(PUBLIC, async (request): Promise<PasswordResetRequestedPayload> => {
  const body: unknown = await request.json().catch(() => null);
  return requestPasswordReset(body);
});

/**
 * Preview. What lets a dead link say "expired, ask for another" *before* somebody chooses a
 * password, rather than after they have typed one into a form that was always going to fail.
 *
 * It answers with one field — the address the token was already mailed to — to a caller already
 * holding that token.
 */
export const GET = apiRoute(PUBLIC, async (request): Promise<PasswordResetPreviewPayload> => {
  const token = new URL(request.url).searchParams.get(RESET_TOKEN_PARAM);
  return previewPasswordReset(token);
});
