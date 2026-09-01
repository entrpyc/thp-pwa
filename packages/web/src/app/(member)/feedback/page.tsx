import { FeedbackForm } from './feedback-form';

export const dynamic = 'force-dynamic';

/**
 * `/feedback` — where a member says something is broken, or says what could be better.
 *
 * Inside `(member)` rather than beside `/sign-in`, so it wears the same chrome as everything else a
 * signed-in person sees and so the layout's session check is the only one it needs. The menu item
 * that reaches it is in that layout's navigation; the layout redirects an anonymous caller, and the
 * route behind the form refuses one independently.
 */
export default function FeedbackPage() {
  return <FeedbackForm />;
}
