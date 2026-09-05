import { redirect } from 'next/navigation';
import { currentActor } from '@/server/auth/current-actor';
import { can } from '@/server/auth/policy';
import { ConsoleShell } from '../console-shell';
import { TagsPanel } from './tags-panel';

export const dynamic = 'force-dynamic';

/**
 * `/admin/tags` — the console's sixth panel: the taxonomy itself ([4.7](docs/project/prd.md)).
 *
 * The same carve-out every other panel took — there is no admin reference PNG, so it is composed
 * from docs/design-references/style-guide.md and the token layer, and `tags.module.css` composes
 * from `admin.module.css` rather than restating it.
 *
 * **This panel owns the names and nothing else.** Creating a tag ahead of using it, fixing a
 * spelling everywhere at once, and removing a tag from the whole library are what it is for.
 * Putting a tag *on* a recording or a series is a control on that item's own row, on the
 * Recordings and Series panels, because that is the screen an admin is already on when they
 * decide what a teaching is about.
 *
 * **The gate decides what to render and authorises nothing.** Every tag route refuses a member
 * independently, and the suite drives that refusal directly rather than trusting this redirect.
 */
export default async function AdminTagsPage() {
  const actor = await currentActor();
  if (!actor) redirect('/sign-in');
  if (!can(actor, 'tag.list')) redirect('/');

  return (
    <ConsoleShell actor={actor} current="tags">
      <TagsPanel />
    </ConsoleShell>
  );
}
