import { currentActor } from '@/server/auth/current-actor';
import { can } from '@/server/auth/policy';
import { SignalView } from './signal-view';

export const dynamic = 'force-dynamic';

/**
 * `/sos/:id` — one signal ([3.16.5](docs/project/prd.md)–[3.16.9](docs/project/prd.md)). The page
 * learns once whether this account moderates, so the view can *show* Close and Remove on
 * somebody else's signal; the API is what permits them.
 */
export default async function SosSignalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await currentActor();
  return <SignalView signalId={id} canModerate={can(actor, 'sos.moderate')} />;
}
