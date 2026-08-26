import { redirect } from 'next/navigation';
import { currentActor } from '@/server/auth/current-actor';
import { can } from '@/server/auth/policy';
import { ConsoleShell } from '../console-shell';
import { SeriesPanel } from './series-panel';

export const dynamic = 'force-dynamic';

/**
 * `/admin/series` — the console's fifth panel: name a study, and see what is in it.
 *
 * The same carve-out every other panel took — there is no admin reference PNG, so it is composed
 * from docs/design-references/style-guide.md and the token layer, and `series.module.css`
 * composes from `admin.module.css` rather than restating it.
 *
 * **This panel owns create, rename and description, and nothing else.** Putting a recording *into*
 * a series is a control on the Recordings panel, because
 * core-listening scope prd § Epic flows → B assigns a series while reviewing a
 * teaching immediately before publishing it — which is the screen the admin is already on.
 *
 * **The gate decides what to render and authorises nothing.** Every series route refuses a member
 * independently, and the suite drives that refusal directly rather than trusting this redirect.
 */
export default async function AdminSeriesPage() {
  const actor = await currentActor();
  if (!actor) redirect('/sign-in');
  if (!can(actor, 'series.list')) redirect('/');

  return (
    <ConsoleShell actor={actor} current="series">
      <SeriesPanel />
    </ConsoleShell>
  );
}
