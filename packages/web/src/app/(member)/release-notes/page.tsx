import { ReleaseNotesListing } from './release-notes-listing';

export const dynamic = 'force-dynamic';

/**
 * `/release-notes` — every post that says what is new, newest first. Reached from the menu, and
 * from a new-feature notification whose own post has since been deleted. The layout checks the
 * session; the list comes over the API.
 */
export default function ReleaseNotesPage() {
  return <ReleaseNotesListing />;
}
