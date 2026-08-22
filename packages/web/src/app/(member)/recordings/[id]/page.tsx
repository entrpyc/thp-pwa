import { currentActor } from '@/server/auth/current-actor';
import { can } from '@/server/auth/policy';
import { RecordingScreen } from './recording-view';

export const dynamic = 'force-dynamic';

/**
 * `/recordings/{id}` — one teaching.
 *
 * The id is handed to the client screen and **no content is read here**: the page's whole body comes
 * from the API, which is what refuses an unpublished id — an unpublished teaching rendered as an
 * empty page would be the client holding a decision.
 *
 * The one thing asked server-side is `transcript.correct`, and it decides **whether an affordance is
 * drawn** and nothing else — the same shape the member layout already uses for the console link. The
 * correction route refuses on its own ([3.1.5](docs/project/prd.md)); a member who forged this flag
 * would see a button that does not work.
 */
export default async function RecordingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await currentActor();
  return <RecordingScreen recordingId={id} canCorrect={can(actor, 'transcript.correct')} />;
}
