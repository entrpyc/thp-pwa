import type { SaveSoundProfilePayload, SoundProfilePayload } from '@thp/shared';
import { permits } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { readSoundProfile, saveSoundProfile } from '@/server/sound-profile/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/api/v1/sound-profile` — the one named profile every recording is processed under
 * ([3.4.5](docs/project/prd.md)).
 *
 * `GET` answers the version in force **and** which version processed each recording, on one
 * payload, because the panel reads them together: the number, and the library it applies to.
 *
 * `PUT` saves the next version. `PUT` rather than `POST` because the body is the whole profile
 * — every knob, not a change to one — and the same body twice leaves the same profile, the second
 * time refused as unchanged rather than written twice. It never edits a version that exists
 * ([3.4.7](docs/project/prd.md)); what it writes is a row with the next number.
 */
export const GET = apiRoute(permits('sound-profile.read'), async (_request, context) => {
  const payload: SoundProfilePayload = await readSoundProfile(context.actor);
  return payload;
});

export const PUT = apiRoute(permits('sound-profile.update'), async (request, context) => {
  const body: unknown = await request.json().catch(() => null);
  const payload: SaveSoundProfilePayload = await saveSoundProfile(context.actor, body);
  return payload;
});
