import { currentActor } from '@/server/auth/current-actor';
import { can } from '@/server/auth/policy';
import { ChapterScreen } from './chapter-view';

export const dynamic = 'force-dynamic';

/**
 * `/recordings/{id}/chapters/{chapterId}` — **one chapter of one teaching**
 * ([3.22.13](docs/project/prd.md)).
 *
 * The two ids are handed to the client screen and **no content is read here**, exactly as the
 * recording page reads none: the page's whole body comes from the API, which is what refuses an
 * unpublished teaching and a chapter id that names nothing.
 *
 * **A route under the recording rather than beside it**, because that is what a chapter is — a part
 * of a teaching, reachable only through the teaching it divides. It also means the back route is a
 * fact about the address rather than about the navigation that reached it, which is what lets
 * [3.22.13](docs/project/prd.md)'s "route back to the recording it came from" be right whether the
 * member arrived from the Chapters tab or from a link somebody sent them.
 *
 * The same two affordance flags the recording page asks for, for the same reason: each decides
 * whether a control is *drawn* and nothing else. The chapter editing controls are deliberately not
 * among them — chapters are edited in place on the recording ([3.22.7](docs/project/prd.md)), which
 * is where the whole list is visible and where moving one boundary can be seen to move the two
 * chapters it belongs to.
 */
export default async function ChapterPage({
  params,
}: {
  params: Promise<{ id: string; chapterId: string }>;
}) {
  const { id, chapterId } = await params;
  const actor = await currentActor();
  return (
    <ChapterScreen
      recordingId={id}
      chapterId={chapterId}
      canCorrect={can(actor, 'transcript.correct')}
      canModerate={can(actor, 'note.moderate')}
    />
  );
}
