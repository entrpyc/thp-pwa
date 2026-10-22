import type { AccountDeletedPayload } from '@thp/shared';
import { PUBLIC } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { completeAccountDeletion } from '@/server/account-deletion/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/auth/account-deletion/complete` — the mailed token plus the current password,
 * and the account is gone ([3.1.8](docs/project/prd.md)).
 *
 * No cookie is set or cleared: the caller has no session, and every session the account had went
 * with the row. The answer is the same payload the signed-in route gives, so the later page has
 * one thing to render.
 */
export const POST = apiRoute(PUBLIC, async (request): Promise<AccountDeletedPayload> => {
  const body: unknown = await request.json().catch(() => null);
  return completeAccountDeletion(body);
});
