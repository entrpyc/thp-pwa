import { ReleaseNotePost } from './release-note-post';

export const dynamic = 'force-dynamic';

/**
 * `/release-notes/{id}` — one post. Where a row of the list goes, and where a new-feature
 * notification lands. The layout checks the session; the post comes over the API, which is what
 * answers an id that is not a post.
 */
export default async function ReleaseNotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReleaseNotePost releaseNoteId={id} />;
}
