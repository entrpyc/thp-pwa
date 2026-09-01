import type { FeedbackSubmittedPayload } from '@thp/shared';
import { SESSION } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';
import { submitFeedback } from '@/server/feedback/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/feedback` — report a bug, or say what could be better.
 *
 * **`SESSION` and not `PUBLIC`**, and the allowlist is untouched. The entry point is a member-menu
 * item, so every caller already has a session; and an unauthenticated route that composes a message
 * out of a stranger's text and mails it to a fixed address is a relay, which is a thing that gets
 * found and used for something other than reporting bugs. Requiring a session is also what lets the
 * message name who sent it without the wire carrying a `from` field anybody could set.
 *
 * **No policy action**, because there is nothing here to authorise beyond *who*: both roles report
 * bugs against the same product, and a rule that let one of them and not the other would be a rule
 * about which members are allowed to say something is broken.
 *
 * There is no `GET`. Nothing is stored, so there is nothing to list.
 */
export const POST = apiRoute(SESSION, async (request, context): Promise<FeedbackSubmittedPayload> => {
  const body: unknown = await request.json().catch(() => null);
  return submitFeedback(context.actor, body);
});
