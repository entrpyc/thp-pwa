import type { RecordingListPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { ApiSuccess, apiRoute } from '@/server/api/route';
import { finaliseUpload, listAllRecordings } from '@/server/recordings/service';

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
 * Every recording, newest `recorded_at` first — the order decided by the query, so the client has
 * no second answer to "what is most recent". No pagination and no filters: there are five
 * recordings, and a control nobody needs is a control somebody has to maintain.
 */
export const GET = apiRoute(permits('recording.list'), async (_request, context) => {
  const payload: RecordingListPayload = { recordings: await listAllRecordings(context.actor) };
  return payload;
});
