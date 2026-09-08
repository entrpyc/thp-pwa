import { redirect } from 'next/navigation';
import { currentActor } from '@/server/auth/current-actor';
import { can } from '@/server/auth/policy';
import { ConsoleShell } from '../console-shell';
import { SoundProfilePanel } from './sound-profile-panel';

export const dynamic = 'force-dynamic';

/**
 * `/admin/sound-profile` — the console's eighth panel: the one profile every recording is
 * processed under ([3.4.5](docs/project/prd.md)), the way to hear a change before saving it
 * ([3.4.6](docs/project/prd.md)), and which version processed each teaching
 * ([3.4.7](docs/project/prd.md)).
 *
 * The same carve-out every other panel took — there is no admin reference PNG, so it is composed
 * from docs/design-references/style-guide.md and the token layer, and `sound-profile.module.css`
 * composes from `admin.module.css` rather than restating it.
 *
 * **The gate decides what to render and authorises nothing.** Every sound-profile route refuses a
 * member independently, and the suite drives that refusal directly rather than trusting this
 * redirect.
 */
export default async function AdminSoundProfilePage() {
  const actor = await currentActor();
  if (!actor) redirect('/sign-in');
  if (!can(actor, 'sound-profile.read')) redirect('/');

  return (
    <ConsoleShell actor={actor} current="sound-profile">
      <SoundProfilePanel />
    </ConsoleShell>
  );
}
