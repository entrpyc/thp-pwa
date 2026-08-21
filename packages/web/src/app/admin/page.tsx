import { redirect } from 'next/navigation';
import { currentActor } from '@/server/auth/current-actor';
import { can } from '@/server/auth/policy';
import { ConsoleShell } from './console-shell';
import { UserManagementPanel } from './user-management-panel';

export const dynamic = 'force-dynamic';

/**
 * `/admin` — the operator console's first panel, and the last step of movement 1.
 *
 * There is no `pages/admin.png`. By operator decision this screen takes the same carve-out steps
 * 2, 3 and 4 received: it is composed from docs/design referencess png/style-guide.md and the token
 * layer, and admin.module.css states every extrapolation that involved. `pages/dashboard.png` is
 * the *member* dashboard and belongs to a later ticket; the top-navigation references are member
 * chrome carrying no admin entry, so the console wears its own header rather than borrowing one.
 *
 * **The gate here decides what to render. It does not authorise anything.** Every row this screen
 * shows is fetched from an API route that refuses a member independently — a member who reaches
 * `GET /api/v1/users` with a forged navigation still gets `forbidden`, which is the property
 * docs/epics/epic-core-listening/implementation-plan.md § Standing constraints asks for and which the suite drives directly.
 *
 * A member is sent to `/` rather than shown a 404: the API answers `forbidden` and not
 * `not_found` to a member who calls the same data, so a 404 here would be the only place in the
 * product pretending the console is not there.
 *
 * The shell and its panel list moved to `console-shell.tsx` when the second panel arrived — which
 * is all "the shell is where every later panel hangs" ever had to mean.
 */
export default async function AdminPage() {
  const actor = await currentActor();
  if (!actor) redirect('/sign-in');
  if (!can(actor, 'account.list')) redirect('/');

  return (
    <ConsoleShell actor={actor} current="users">
      <UserManagementPanel signedInId={actor.id} signedInName={actor.displayName} />
    </ConsoleShell>
  );
}
