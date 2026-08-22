import type { RecordingListPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { ApiSuccess, apiRoute } from '@/server/api/route';
import { finaliseUpload, listRecordingsFor } from '@/server/recordings/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/recordings` — the collection.
 *
 * Admin-only through the policy module, which is what makes "a member cannot upload" and "a member
 * cannot see what has been uploaded" refusals the API issues rather than controls the interface
 * happens not to render (docs/project/prd.md, 3.2.1 — admin-only in this epic).
 *
 * **Nothing downstream is triggered here.** docs/project/prd.md 3.5.1's "transcription triggers on
 * upload completing" is wired in Story 2 Ticket 03; this route deliberately leaves that edge
 * unconnected, and the recording it writes is inert until then.
 */

/** Finalise an upload. `201` — the recording is a resource, and this is the request that created it. */
export const POST = apiRoute(permits('recording.upload'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return new ApiSuccess(await finaliseUpload(context.actor, body), 201);
});

/**
 * Every recording **this caller may see**, newest `recorded_at` first — the order decided by the
 * query, so the client has no second answer to "what is most recent". No pagination and no
 * filters: there are five recordings, and a control nobody needs is a control somebody has to
 * maintain.
 *
 * **Both roles, one route** (Story 3 Ticket 04). `recording.browse` is what admits the caller; what
 * separates the two answers is whether they also satisfy `recording.list`, and the service asks
 * that question once. A member sees published rows without the object key — refused by the API,
 * not merely absent from an interface (docs/project/prd.md, 3.1.2, 3.1.5).
 *
 * One route rather than two so Story 4 Ticket 01 builds its library on this and does not invent a
 * second answer to "what may this person see".
 */
export const GET = apiRoute(permits('recording.browse'), async (_request, context) => {
  const payload: RecordingListPayload = { recordings: await listRecordingsFor(context.actor) };
  return payload;
});
