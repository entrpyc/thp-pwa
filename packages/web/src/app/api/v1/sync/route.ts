import type { SyncPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { syncOutbox } from '@/server/offline/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/sync` — **the offline sync endpoint** (project tdd 2.2, 5.3;
 * [3.18.12](docs/project/prd.md), [3.18.14](docs/project/prd.md), [3.18.15](docs/project/prd.md)).
 *
 * One request on reconnect, carrying the device's outbox and the ids of the downloads it holds.
 * The entries are applied through the live services — a position lands where a live position
 * lands, a note where a live note lands — and each answers as the live route would have, so the
 * outbox is a late arrival of the same writes rather than a second kind of write. The answer also
 * names which downloads the member may no longer hold.
 *
 * Behind `recording.browse`, which both roles hold: the entries are about recordings, and each one
 * re-asks the finer question (publication, terms, the word filter, `note.write`) inside the service
 * exactly as the live route would. A refusal is a per-entry result, never a failed request.
 */
export const POST = apiRoute(permits('recording.browse'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const payload: SyncPayload = await syncOutbox(context.actor, body);
  return payload;
});
