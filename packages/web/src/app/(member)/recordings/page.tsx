import { redirect } from 'next/navigation';
import { DASHBOARD_PAGE_PATH } from '@thp/shared';

export const dynamic = 'force-dynamic';

/**
 * `/recordings` — **no page any more**, by the operator's decision. The library that listed every
 * teaching here is gone; the dashboard's tiles and the series pages are the ways to a teaching.
 * The address still resolves, to the dashboard, so a bookmark or a history entry from before lands
 * somewhere rather than on a 404 — and `/recordings/{id}` beneath it is untouched.
 */
export default function MemberLibraryPage() {
  redirect(DASHBOARD_PAGE_PATH);
}
