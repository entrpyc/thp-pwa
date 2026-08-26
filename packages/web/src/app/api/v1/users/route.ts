import type { AccountListPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { listAllAccounts } from '@/server/accounts/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/users` — every account with its display name, address, role and active state.
 *
 * Admin-only through the policy module, which is what makes "a member cannot read the member list"
 * a refusal the API issues rather than a control the interface happens not to render. There is no
 * interface yet; core-listening scope plan § Ticket 5 builds it over this.
 *
 * **No password hash and no token of any kind**, which is a property of `AccountSummary` rather than
 * of this handler remembering to strip one.
 */
export const GET = apiRoute(permits('account.list'), async (_request, context) => {
  const payload: AccountListPayload = { accounts: await listAllAccounts(context.actor) };
  return payload;
});
