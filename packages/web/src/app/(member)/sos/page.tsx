import { SosBoard } from './sos-board';

export const dynamic = 'force-dynamic';

/**
 * `/sos` — the board ([3.16.4](docs/project/prd.md)). The home card is the way in; the layout's
 * session check is the only one it needs, and every route behind it refuses an anonymous caller
 * independently.
 */
export default function SosPage() {
  return <SosBoard />;
}
