import { ProfilePanel } from './profile-panel';

export const dynamic = 'force-dynamic';

/**
 * `/profile` — the identity page: the two things about an account that another member sees
 * ([3.1.12](docs/project/prd.md)), the name on their notes and the picture beside it.
 *
 * The root of the profile, with its sections beside it (`sections.ts`); what concerns only the
 * owner — the session, and what later tickets add — is a section, not a card here. Inside
 * `(member)` so it wears the same chrome as everything else a signed-in person sees and so
 * the layout's session check is the only one it needs. The panel reads the session over the API
 * rather than taking the actor as a prop, because every write it makes answers with the session
 * user and the screen should render from one source, not from a prop that goes stale on the first
 * save.
 */
export default function ProfilePage() {
  return <ProfilePanel />;
}
