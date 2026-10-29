import {
  DELETION_TOKEN_PARAM,
  type AccountDeletionPreviewPayload,
  type AccountDeletionRequestedPayload,
} from '@thp/shared';
import { PUBLIC } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { tokenGuard } from '@/server/auth/token-limits';
import { accountDeletionGuard } from '@/server/account-deletion/limits';
import {
  previewAccountDeletion,
  requestAccountDeletion,
} from '@/server/account-deletion/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/auth/account-deletion` — asking for a deletion link from outside a session, and asking
 * what a link is for ([3.1.8](docs/project/prd.md)).
 *
 * Both are on `server/auth/allowlist.ts` and argued there. The page that calls them is a later
 * ticket; the routes ship now so the link the message carries has somewhere to land when it does.
 */

/**
 * Ask for a link. **Answers one fixed payload for every outcome**, and is rate-limited per caller
 * and across the route before the body is read — the reset request's two rules, for the reset
 * request's reasons.
 */
export const POST = apiRoute(PUBLIC, async (request): Promise<AccountDeletionRequestedPayload> => {
  accountDeletionGuard().enforce(request);

  const body: unknown = await request.json().catch(() => null);
  return requestAccountDeletion(body);
});

/** Preview: the address the token was mailed to, so a dead link can say so before a password is typed. */
export const GET = apiRoute(PUBLIC, async (request): Promise<AccountDeletionPreviewPayload> => {
  tokenGuard().enforce(request);
  const token = new URL(request.url).searchParams.get(DELETION_TOKEN_PARAM);
  return previewAccountDeletion(token);
});
