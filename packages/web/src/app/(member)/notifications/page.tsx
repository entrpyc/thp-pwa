import { NotificationsCentre } from './notifications-centre';

export const dynamic = 'force-dynamic';

/**
 * `/notifications` — the centre the bell opens ([3.17.2](docs/project/prd.md)).
 *
 * Inside `(member)` so it wears the same chrome as everything else a signed-in person sees, so the
 * layout's session check is the only one it needs, and so it reads the same list the bell counts
 * from. The rows themselves come from an API route that refuses independently.
 */
export default function NotificationsPage() {
  return <NotificationsCentre />;
}
