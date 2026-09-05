import { SESSION } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { markAllReadFor } from '@/server/notifications/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `PUT /api/v1/notifications/read` — **everything this account has is read.**
 *
 * `PUT` because it states an end state rather than performing a step: a second press finds
 * nothing unread and answers the same shape with `marked: 0`.
 */
export const PUT = apiRoute(SESSION, async (_request, context) => markAllReadFor(context.actor));
