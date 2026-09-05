import { redirect } from 'next/navigation';
import { currentActor } from '@/server/auth/current-actor';
import { can } from '@/server/auth/policy';
import { ConsoleShell } from '../console-shell';
import { AnnouncementsPanel } from './announcements-panel';

export const dynamic = 'force-dynamic';

/**
 * `/admin/announcements` — the console's seventh panel: what an admin tells the whole group
 * ([3.17.15](docs/project/prd.md), [3.19.8](docs/project/prd.md)).
 *
 * The same carve-out every other panel took — there is no admin reference PNG, so it is composed
 * from docs/design-references/style-guide.md and the token layer, and `announcements.module.css`
 * composes from `admin.module.css` rather than restating it.
 *
 * **The gate decides what to render and authorises nothing.** Both announcement routes refuse a
 * member independently, and the suite drives that refusal directly rather than trusting this
 * redirect.
 */
export default async function AdminAnnouncementsPage() {
  const actor = await currentActor();
  if (!actor) redirect('/sign-in');
  if (!can(actor, 'announcement.send')) redirect('/');

  return (
    <ConsoleShell actor={actor} current="announcements">
      <AnnouncementsPanel />
    </ConsoleShell>
  );
}
