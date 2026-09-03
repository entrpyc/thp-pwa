import type { SessionPayload } from '@thp/shared';
import { SESSION } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { clearAvatar, setAvatar } from '@/server/accounts/avatar';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/users/me/avatar` — the picture beside your own name
 * ([3.1.12](docs/project/prd.md)).
 *
 * `me` rather than an id in the path, and a session rather than a policy action, exactly as the
 * playback-speed route: the only avatar anybody may set is their own, and a path that could name
 * somebody else's would need an ownership rule to refuse what it should never have been able to
 * express. An admin ends accounts and changes roles; the face on one is not an operator control.
 *
 * `PUT` points the account at the upload that landed, after the store has been asked what is
 * actually behind the key. `DELETE` takes the picture away — the pointer goes back to `null`, which
 * is the state every account starts in, and the object stays in the store, where nothing can delete
 * it.
 */
export const PUT = apiRoute(SESSION, async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const payload: SessionPayload = await setAvatar(context.actor, body);
  return payload;
});

export const DELETE = apiRoute(SESSION, async (_request, context) => {
  const payload: SessionPayload = await clearAvatar(context.actor);
  return payload;
});
