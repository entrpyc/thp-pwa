import type { ReportListPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { listReportsFor } from '@/server/reports/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/reports` — **every open report, oldest first**, with the note as it reads now, its
 * author, the reporter and the teaching it is on. The console's queue, and admin-only: a member has
 * nothing waiting on them here, and a report they could read would name the member who made it.
 */
export const GET = apiRoute(permits('report.list'), async (_request, context) => {
  const payload: ReportListPayload = await listReportsFor(context.actor);
  return payload;
});
