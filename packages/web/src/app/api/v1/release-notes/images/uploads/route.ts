import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { grantReleaseNoteImageUpload } from '@/server/release-notes/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/release-notes/images/uploads` — permission to send one picture for a post: the
 * grant half of the avatar's three-step upload. Behind `release-note.create`, because a picture is
 * only ever part of writing a post.
 */
export const POST = apiRoute(permits('release-note.create'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  return grantReleaseNoteImageUpload(context.actor, body);
});
