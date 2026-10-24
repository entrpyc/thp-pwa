import { SessionView } from './session-view';

export const dynamic = 'force-dynamic';

/**
 * `/flow-tracker/sessions/:id` — one session ([3.14.5](docs/project/prd.md),
 * [3.14.9](docs/project/prd.md)): the question screen while it runs, the reading list once it is
 * complete. The session is the member's own and comes over the API, which refuses anybody else's.
 */
export default async function FlowSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SessionView sessionId={id} />;
}
