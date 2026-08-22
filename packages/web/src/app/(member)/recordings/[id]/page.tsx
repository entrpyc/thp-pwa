import { RecordingScreen } from './recording-view';

export const dynamic = 'force-dynamic';

/**
 * `/recordings/{id}` — one teaching.
 *
 * The id is handed to the client screen and nothing is read here: the page's whole content comes
 * from the API, which is what refuses an unpublished id — an unpublished teaching rendered as an
 * empty page would be the client holding a decision.
 */
export default async function RecordingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RecordingScreen recordingId={id} />;
}
