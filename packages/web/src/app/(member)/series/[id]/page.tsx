import { SeriesScreen } from './series-view';

export const dynamic = 'force-dynamic';

/** `/series/{id}` — one series. The layout checks the session; this is the composition. */
export default async function MemberSeriesDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SeriesScreen seriesId={id} />;
}
