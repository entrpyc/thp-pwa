import { SESSION } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { readNotificationsFor } from '@/server/notifications/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/notifications` — **the centre's list and the bell's count**
 * ([3.17.2](docs/project/prd.md), [3.17.3](docs/project/prd.md)).
 *
 * Behind a session and nothing more: the rows are keyed on the caller's own id, so there is no
 * resource to authorise against — the shape playback progress and onboarding completion take.
 */
export const GET = apiRoute(SESSION, async (_request, context) => readNotificationsFor(context.actor));
