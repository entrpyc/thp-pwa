import type { UploadGrantPayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { grantNoteImageUpload } from '@/server/notes/images';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/notes/images/uploads` — permission to send a picture for a note
 * ([3.12.22](docs/project/prd.md)): the grant half of the avatar's three-step upload, one resource
 * over. Behind `note.write`, because a picture is only ever the first half of a note.
 */
export const POST = apiRoute(permits('note.write'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const grant: UploadGrantPayload = await grantNoteImageUpload(context.actor, body);
  return grant;
});
