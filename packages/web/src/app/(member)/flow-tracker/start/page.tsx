import { StartSession } from './start-session';

export const dynamic = 'force-dynamic';

/**
 * `/flow-tracker/start` — pick the point of divergence ([3.14.2](docs/project/prd.md)): the
 * chronological list of every published teaching, newest first.
 */
export default function FlowTrackerStartPage() {
  return <StartSession />;
}
