import { FlowHome } from './flow-home';

export const dynamic = 'force-dynamic';

/**
 * `/flow-tracker` — the member's Flow Tracker ([3.14.1](docs/project/prd.md),
 * [3.14.10](docs/project/prd.md)): the session in progress, or the way to start one, and the
 * completed sessions beneath. Its own page, reached from the menu.
 *
 * Nothing is read here — the sessions are the member's own and come over the API, which is what
 * refuses anybody else's ([3.14.8](docs/project/prd.md)).
 */
export default function FlowTrackerPage() {
  return <FlowHome />;
}
