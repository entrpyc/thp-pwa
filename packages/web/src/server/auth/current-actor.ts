import { cookies } from 'next/headers';
import { SESSION_COOKIE_NAME } from '@thp/shared';
import { actorForToken } from './session';
import type { Actor } from './policy';

/**
 * The signed-in account, for a **server component**. Route handlers read the cookie off the
 * `Request` instead (see `readSessionCookie`); this is the same resolution through Next's cookie
 * store, so a page and a route can never disagree about who is calling.
 *
 * A page using this decides what to *render*. It is not an authorisation decision: every piece of
 * data a page shows still comes from an API route that refuses independently.
 */
export async function currentActor(): Promise<Actor | null> {
  const store = await cookies();
  return actorForToken(store.get(SESSION_COOKIE_NAME)?.value ?? null);
}
