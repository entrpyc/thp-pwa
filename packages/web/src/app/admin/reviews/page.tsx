import { redirect } from 'next/navigation';
import { currentActor } from '@/server/auth/current-actor';
import { can } from '@/server/auth/policy';
import { ConsoleShell } from '../console-shell';
import { ReviewsPanel } from './reviews-panel';

export const dynamic = 'force-dynamic';

/**
 * `/admin/reviews` — the console's fourth panel: **everything the machine has drafted and nobody
 * has looked at yet** (docs/project/prd.md, 3.19.2).
 *
 * This is the screen the whole story is for. Until it existed, a generated summary was two rows in
 * a table nobody could see, and `published_at` was a column nothing wrote. After it, reviewing is
 * editing rather than writing, and member visibility is one condition an admin deliberately opens.
 *
 * The same carve-out the first three panels took — no admin reference PNG exists, so it is composed
 * from docs/design referencess png/style-guide.md and the token layer, and `reviews.module.css`
 * composes from `admin.module.css` rather than restating it, so the four panels cannot drift.
 *
 * **The gate decides what to render and authorises nothing.** `GET /api/v1/reviews`, the resolve
 * route and the regenerate route each refuse a member independently, and the suite drives those
 * refusals directly rather than trusting this redirect.
 */
export default async function AdminReviewsPage() {
  const actor = await currentActor();
  if (!actor) redirect('/sign-in');
  if (!can(actor, 'review.list')) redirect('/');

  return (
    <ConsoleShell actor={actor} current="reviews">
      <ReviewsPanel />
    </ConsoleShell>
  );
}
