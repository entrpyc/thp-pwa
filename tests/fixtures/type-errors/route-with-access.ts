import { SESSION } from '@/server/api/access';
import { apiRoute } from '@/server/api/route';

/**
 * The positive control. A route that states its access compiles — without this, the negative
 * control below would pass for any reason at all, including the fixture failing to resolve.
 */
export const GET = apiRoute(SESSION, (_request, context) => ({ actorId: context.actor.id }));
