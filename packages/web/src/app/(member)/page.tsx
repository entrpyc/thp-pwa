import { Landing } from './landing';

export const dynamic = 'force-dynamic';

/**
 * `/` — the member landing.
 *
 * **This file replaced the placeholder home screen**, which existed only so a signed-in person had
 * somewhere to be and the sign-out control had somewhere to live. Both moved: the landing is
 * `pages/dashboard.png`, and sign-out is an entry in the navigation menu, as is the temporary link
 * to the admin console the placeholder used to carry.
 *
 * The layout is what checks for a session; this is only the composition.
 */
export default function MemberLandingPage() {
  return <Landing />;
}
