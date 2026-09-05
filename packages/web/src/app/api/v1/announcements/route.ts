import { permits } from '@/server/api/access';
import { ApiSuccess, apiRoute } from '@/server/api/route';
import { listAnnouncementsFor, sendAnnouncementFor } from '@/server/notifications/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/announcements` — what an admin tells the whole group
 * ([3.17.9](docs/project/prd.md), [3.17.17](docs/project/prd.md), [3.19.8](docs/project/prd.md)).
 *
 * **Operator-only at both methods.** A member reads what they were told through their own
 * notifications; the list of sends, with who sent each and how many it reached, is the console's
 * question.
 */

/** Send one. `201` — a send is a resource, and this is the request that created it. */
export const POST = apiRoute(permits('announcement.send'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return new ApiSuccess(await sendAnnouncementFor(context.actor, body), 201);
});

/** Every past send, newest first. */
export const GET = apiRoute(permits('announcement.list'), async (_request, context) =>
  listAnnouncementsFor(context.actor),
);
