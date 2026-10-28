import { StartSession } from './start-session';

export const dynamic = 'force-dynamic';

/**
 * `/flow-tracker/start` — pick the teachings to introspect on ([3.14.2](docs/project/prd.md)):
 * the chronological list of every published teaching, newest first, one or several of them.
 */
export default function FlowTrackerStartPage() {
  return <StartSession />;
}
