import { MyNotes } from './my-notes';

export const dynamic = 'force-dynamic';

/**
 * `/notes` — **My notes**: every note the member wrote, across every teaching, each inside the
 * thread it belongs to. Reached from the dashboard's *Notes* tile.
 *
 * Nothing is read here — the list is the member's own and comes over the API, which is what
 * decides which rows a reader may see.
 */
export default function MyNotesPage() {
  return <MyNotes />;
}
