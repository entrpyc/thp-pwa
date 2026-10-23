import { SESSION } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { deleteReplyFor } from '@/server/sos/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `DELETE /api/v1/sos/:id/replies/:replyId` — **an author takes their own reply down, or an admin
 * moderates.** The owned `sos.reply.delete` first and `sos.moderate` only where it denied, for the
 * audit reason the note route gives.
 */
export const DELETE = apiRoute(SESSION, async (_request, context) =>
  deleteReplyFor(
    context.actor,
    await routeParam(context.params, 'id'),
    await routeParam(context.params, 'replyId'),
  ),
);
