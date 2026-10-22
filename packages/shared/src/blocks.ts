import { USERS_PATH } from './accounts';

/**
 * **Member blocks on the wire** — the contract behind one member choosing not to see another,
 * which Apple guideline 1.2 and Google Play's UGC policy require of a product with member-written
 * content.
 *
 * What a block *does* is not described here, because the client holds no decision: a blocked
 * member's notes, replies and reactions are absent from what the API answers, and a reply or a
 * reaction across a block is refused with `blocked`. This file is only the list a member keeps and
 * the two writes that change it.
 */

/**
 * The signed-in account's blocked list, relative to the `/api/v1` prefix. `GET` lists it.
 *
 * `me` rather than an id in the path, exactly as the avatar and playback-speed routes: the only
 * blocked list anybody may read or change is their own, and a path that could name somebody
 * else's would need an ownership rule to refuse what it should never have been able to express.
 */
export const MEMBER_BLOCKS_PATH = `${USERS_PATH}/me/blocks`;

/** `POST` blocks this member; `DELETE` unblocks them. Both answer the list as it now stands. */
export function memberBlockPath(memberId: string): string {
  return `${MEMBER_BLOCKS_PATH}/${memberId}`;
}

/**
 * One blocked member, as the list shows them: who, by the name they go by, and since when.
 *
 * No avatar and no e-mail. The list exists so a member can find the name and press Unblock;
 * a picture of somebody they chose not to see is not what that screen is for, and an address is
 * never a member's to read.
 */
export interface BlockedMemberView {
  readonly id: string;
  readonly displayName: string;
  /** ISO 8601. */
  readonly blockedAt: string;
}

/**
 * Payload of `GET /api/v1/users/me/blocks`, and of both writes — the list as it now stands,
 * display names A to Z, so a screen never has to merge a write's answer into a list it fetched
 * earlier.
 */
export interface BlockListPayload {
  readonly blocked: readonly BlockedMemberView[];
}
