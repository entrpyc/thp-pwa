import { SeriesListing } from './series-listing';

export const dynamic = 'force-dynamic';

/** `/series` — the series listing. The layout checks the session; this is the composition. */
export default function MemberSeriesPage() {
  return <SeriesListing />;
}
