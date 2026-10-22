import type { ResolveReportPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { routeParam } from '@/server/api/params';
import { apiRoute } from '@/server/api/route';
import { resolveReportFor } from '@/server/reports/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/reports/:id/resolve` — **close this report, and every other open report on the
 * same note, with one outcome.** `dismissed` leaves the note up; `removed` deletes it through the
 * same path an admin's Delete in the note menu takes, so the audit line ([3.12.10](docs/project/prd.md))
 * is written by the one function that writes it. Each reporter is told afterwards.
 *
 * `POST` rather than `PUT`, because what it creates is a decision, and a decision already taken is
 * not overwritten: a report somebody else closed a moment ago answers the stored outcome and
 * `closed: 0`. The answer is the queue as it now stands.
 */
export const POST = apiRoute(permits('report.resolve'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const payload: ResolveReportPayload = await resolveReportFor(
    context.actor,
    await routeParam(context.params, 'id'),
    body,
  );
  return payload;
});
