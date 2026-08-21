import { apiRoute } from '@/server/api/route';

/**
 * The negative control: a route defined **without stating its access**. It must not compile.
 *
 * This is the whole of what "unauthenticated requests are refused by construction rather than by
 * review" claims. If this file ever compiles, the claim is false and the guard test says so.
 *
 * Nothing here suppresses the error — no suppression comment of any kind — because the guard test
 * reads tsc's output for this filename, and a suppressed error is a silent pass.
 */
export const GET = apiRoute(() => ({ ok: true }));
