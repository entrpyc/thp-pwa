import type { SessionUser } from '@thp/shared';
import { describeActor, type Actor } from '@/server/auth/policy';
import { mintArtworkGrant } from '@/server/series/artwork-grant';

/**
 * **The session payload, whole** — what every route that answers "who am I" hands back.
 *
 * `describeActor` is the policy module's and stays synchronous: it reads the row and nothing else.
 * The one field it cannot give is the avatar, which travels as a signed URL rather than as the key
 * the row holds, and signing is the store's answer. This is where the two meet, and it is the only
 * place they do — sign-in, sign-up, invitation acceptance, password-reset completion and the
 * "who am I" read all come through here, so what a client is told about the picture beside its
 * own name is one function's decision.
 *
 * The grant is the same day-cacheable one a series cover is handed out under, for the same reason:
 * an avatar is on every note its owner wrote and is fetched on every page that lists them, and a
 * URL that changed per page would be the picture flashing on every navigation.
 */
export async function describeSessionUser(actor: Actor): Promise<SessionUser> {
  return { ...describeActor(actor), avatarUrl: await mintArtworkGrant(actor.avatarKey) };
}
