import { redirect } from 'next/navigation';
import { currentActor } from '@/server/auth/current-actor';
import { can } from '@/server/auth/policy';
import { ConsoleShell } from '../console-shell';
import { ReportsPanel } from './reports-panel';

export const dynamic = 'force-dynamic';

/**
 * `/admin/reports` — the console's ninth panel: **every note a member has asked an admin to look
 * at** (Apple guideline 1.2's "timely responses", Google Play's UGC policy's "a way for the
 * operator to remove it").
 *
 * Its own panel rather than a section of Pending Reviews, although both are queues an admin
 * works: the review queue is what the *machine* drafted for a person to approve, and this is what
 * a *member* flagged for a person to judge. Mixing them would make one list two kinds of decision,
 * and would put a member's report through a screen whose every control is about summaries.
 *
 * The same carve-out every other panel took — no admin reference PNG exists, so it is composed
 * from docs/design-references/style-guide.md and the token layer, and `reports.module.css`
 * composes from `admin.module.css` rather than restating it.
 *
 * **The gate decides what to render and authorises nothing.** `GET /api/v1/reports` and the
 * resolve route each refuse a member independently, and the suite drives those refusals directly.
 */
export default async function AdminReportsPage() {
  const actor = await currentActor();
  if (!actor) redirect('/sign-in');
  if (!can(actor, 'report.list')) redirect('/');

  return (
    <ConsoleShell actor={actor} current="reports">
      <ReportsPanel />
    </ConsoleShell>
  );
}
