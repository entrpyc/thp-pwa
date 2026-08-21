import { redirect } from 'next/navigation';
import { currentActor } from '@/server/auth/current-actor';
import { can } from '@/server/auth/policy';
import { ConsoleShell } from '../console-shell';
import { RecordingsPanel } from './recordings-panel';

export const dynamic = 'force-dynamic';

/**
 * `/admin/recordings` — the console's second panel: put a teaching in, and see what is already in.
 *
 * The same carve-out as the first panel — no admin reference PNG exists, so it is composed from
 * docs/design referencess png/style-guide.md and the token layer, and `recordings.module.css`
 * composes from `admin.module.css` rather than restating it, so the two panels cannot drift.
 *
 * **The gate decides what to render and authorises nothing.** `GET /api/v1/recordings` and both
 * upload routes refuse a member independently, and the suite drives that refusal directly rather
 * than trusting this redirect.
 *
 * Nothing here is member-visible. A recording exists; it is not published (Story 3 Ticket 04), it
 * has no transcript (Story 2 Ticket 03), and there is no way to play it (Story 4 Ticket 02).
 */
export default async function AdminRecordingsPage() {
  const actor = await currentActor();
  if (!actor) redirect('/sign-in');
  if (!can(actor, 'recording.list')) redirect('/');

  return (
    <ConsoleShell actor={actor} current="recordings">
      <RecordingsPanel />
    </ConsoleShell>
  );
}
