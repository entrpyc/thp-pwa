import { Suspense } from 'react';
import { SearchScreen } from './search-screen';

export const dynamic = 'force-dynamic';

/**
 * `/search?q=…` — the results page ([3.10](docs/project/prd.md)). The layout checks the session;
 * this is the composition. The query and every filter live in the address and are read by the
 * client screen, which is why it sits under `Suspense`: Next asks for one around anything that
 * reads the search params during a server render.
 */
export default function SearchPage() {
  return (
    <Suspense fallback={null}>
      <SearchScreen />
    </Suspense>
  );
}
