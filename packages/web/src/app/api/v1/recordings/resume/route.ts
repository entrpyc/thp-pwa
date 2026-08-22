import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { readResume } from '@/server/playback/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/recordings/resume` — **what the landing offers to pick back up**
 * (Story 4 Ticket 04, `pages/dashboard.png`).
 *
 * A static segment beside `/recordings/:id` rather than a top-level `/playback` resource: what it
 * answers *is* a recording, chosen by this member's most recent position. Behind
 * `recording.browse`, because that is what it is — a read of the library, narrowed to one row.
 *
 * The row it picks must still be published: a teaching taken down by
 * [3.2.11](docs/project/prd.md) does not come back through a resume card.
 */
export const GET = apiRoute(permits('recording.browse'), async (_request, context) =>
  readResume(context.actor),
);
