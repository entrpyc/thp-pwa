import { redirect } from 'next/navigation';
import { currentActor } from '@/server/auth/current-actor';
import { can } from '@/server/auth/policy';
import { ConsoleShell } from '../console-shell';
import { ReleaseNotesPanel } from './release-notes-panel';

export const dynamic = 'force-dynamic';

/**
 * `/admin/release-notes` — where an admin writes, changes and removes the posts that say what is
 * new.
 *
 * The carve-out every other panel took: there is no admin reference PNG, so it is composed from
 * the style guide and the token layer, and `release-notes.module.css` composes from
 * `admin.module.css`.
 *
 * **The gate decides what to render and authorises nothing.** Every write route refuses a member
 * independently.
 */
export default async function AdminReleaseNotesPage() {
  const actor = await currentActor();
  if (!actor) redirect('/sign-in');
  if (!can(actor, 'release-note.create')) redirect('/');

  return (
    <ConsoleShell actor={actor} current="release-notes">
      <ReleaseNotesPanel />
    </ConsoleShell>
  );
}
