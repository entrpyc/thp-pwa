import {
  clearSosPraying,
  closeSosSignal,
  countOpenSosSignalsByAuthor,
  countOpenSosSignalsByUrgency,
  deleteSosReply,
  deleteSosSignal,
  findSosReplyById,
  findSosSignalById,
  findSosSignalForViewer,
  insertSosReply,
  insertSosSignal,
  listSosPrayingNames,
  listSosReplies,
  listSosSignals,
  setSosPraying,
  type SosReplyRow,
  type SosSignalListRow,
} from '@thp/db';
import {
  MAX_OPEN_SOS_PER_MEMBER,
  MAX_SOS_CLOSING_NOTE_LENGTH,
  MAX_SOS_DESCRIPTION_LENGTH,
  MAX_SOS_REPLY_LENGTH,
  SOS_LIMIT_MESSAGE,
  TERMS_REQUIRED_MESSAGE,
  isSosStatus,
  isSosUrgency,
  termsAcceptanceIsCurrent,
  type SosAuthorView,
  type SosListPayload,
  type SosRemovedPayload,
  type SosReplyView,
  type SosSignalDetailView,
  type SosSignalPayload,
  type SosSignalView,
  type SosStatus,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import { authorise } from '@/server/auth/authorise';
import { can, type Actor } from '@/server/auth/policy';
import { BLOCKED_WORD_MESSAGE, findBlockedWord } from '@/server/notes/filter';
import {
  notifySosRaised,
  notifySosReply,
  notifySosThreadReply,
} from '@/server/notifications/service';
import { audit } from '@/server/observability/audit';
import { logger } from '@/server/observability/logger';
import { mintArtworkGrant } from '@/server/series/artwork-grant';

/**
 * **The SOS channel** ([3.16](docs/project/prd.md)) — raising, reading, responding to and ending a
 * signal, with the policy asked once per act.
 *
 * Four rules the whole module keeps:
 *
 * 1. **What a member may read is the store's `where`**, not a check here. Every read goes through
 *    `findSosSignalForViewer` or `listSosSignals`, which hide a signal by a member either side of
 *    a block; a signal they hide is `not_found` to the caller, the same answer as for an id nobody
 *    has, so the route discloses neither.
 * 2. **Every write answers the signal as it now reads.** The screens replace what they hold with
 *    the answer rather than guessing, so a praying press and a reply cannot leave the count and the
 *    list disagreeing.
 * 3. **A signal and a reply are posts** (Google Play's UGC policy; Apple guideline 1.2), so each
 *    is behind the same two gates a note is: current terms acceptance, and the word filter.
 * 4. **Owned then moderated**, in that order, exactly as `deleteNote` asks: an author closing their
 *    own signal satisfies the owned `sos.close` and is not logged as moderation; an admin closing
 *    somebody else's fails it and is asked `sos.moderate`, which is what the audit line records.
 */

// =================================================================================================
// Reading
// =================================================================================================

/** The board's list for one status, and the open counts whichever status was asked for. */
export async function listSignalsFor(actor: Actor, rawStatus: string | null): Promise<SosListPayload> {
  authorise(actor, 'sos.read', 'sos');
  const status: SosStatus = rawStatus === null || rawStatus === '' ? 'open' : parseStatus(rawStatus);
  const [rows, openCounts] = await Promise.all([
    listSosSignals({ viewerId: actor.id, open: status === 'open' }),
    countOpenSosSignalsByUrgency(actor.id),
  ]);
  const avatars = await signAvatars(rows.map((row) => row.authorAvatarKey));
  return {
    status,
    signals: rows.map((row) => describeSignal(row, actor, avatars)),
    openCounts,
  };
}

/** One signal in full, as this member may read it. */
export async function readSignalFor(actor: Actor, signalId: string): Promise<SosSignalPayload> {
  authorise(actor, 'sos.read', `sos:${signalId}`);
  return { signal: await detail(await requireVisible(actor, signalId), actor) };
}

// =================================================================================================
// Raising
// =================================================================================================

/**
 * Raise a signal ([3.16.1](docs/project/prd.md)–[3.16.3](docs/project/prd.md)).
 *
 * The cap ([3.16.12](docs/project/prd.md)) is counted and then written without a lock: two raises
 * from one member in the same instant could leave them at eleven, and the cost of that is nothing
 * the channel cannot bear — the eleventh is one more card on the board, not a breach of anything a
 * member is owed. The broadcast is the notification service's, after the row is committed.
 */
export async function raiseSignalFor(actor: Actor, body: unknown): Promise<SosSignalPayload> {
  authorise(actor, 'sos.raise', 'sos');
  requireTermsAccepted(actor, 'sos.raise', 'sos');
  const fields = asObject(body, 'Send a JSON object with the urgency and a description.');

  const { urgency } = fields;
  if (!isSosUrgency(urgency)) {
    throw ApiError.invalidInput('Choose one of the four urgency colours.');
  }
  const description = parseText(fields['description'], {
    empty: 'Say what prayer is needed.',
    ceiling: MAX_SOS_DESCRIPTION_LENGTH,
    field: 'description',
  });
  requireAllowedWords(actor, description, 'sos.raise', 'sos');

  if ((await countOpenSosSignalsByAuthor(actor.id)) >= MAX_OPEN_SOS_PER_MEMBER) {
    logger.warn('sos.refused', {
      actorId: actor.id,
      action: 'sos.raise',
      reason: 'open-limit',
      code: 'sos_limit',
      limit: MAX_OPEN_SOS_PER_MEMBER,
    });
    throw ApiError.sosLimit(SOS_LIMIT_MESSAGE);
  }

  const row = await insertSosSignal({ authorId: actor.id, urgency, description });
  logger.info('sos.raise', { ...audit(actor, 'sos.raise', `sos:${row.id}`), urgency });

  await notifySosRaised({ signalId: row.id, urgency, description, author: actor });

  return { signal: await detail(await requireVisible(actor, row.id), actor) };
}

// =================================================================================================
// Responding
// =================================================================================================

/** Press Praying ([3.16.5](docs/project/prd.md)). Pressing again is the same state. */
export async function setPrayingFor(actor: Actor, signalId: string): Promise<SosSignalPayload> {
  authorise(actor, 'sos.respond', `sos:${signalId}`);
  const signal = await requireVisible(actor, signalId);
  requireOpen(signal, 'This prayer request has been closed, so there is nothing more to pray for here.');
  await setSosPraying({ signalId, userId: actor.id });
  return { signal: await detail(await requireVisible(actor, signalId), actor) };
}

/** Take Praying back. Clearing what was never set succeeds — the member asked for a state and has it. */
export async function clearPrayingFor(actor: Actor, signalId: string): Promise<SosSignalPayload> {
  authorise(actor, 'sos.respond', `sos:${signalId}`);
  await requireVisible(actor, signalId);
  await clearSosPraying({ signalId, userId: actor.id });
  return { signal: await detail(await requireVisible(actor, signalId), actor) };
}

/**
 * Reply ([3.16.6](docs/project/prd.md)). The author is told ([3.16.7](docs/project/prd.md)) unless
 * the author is the one replying. The block rule needs no second question here: a signal by a
 * member either side of a block is one `requireVisible` already answered `not_found` for.
 *
 * **In a thread**, when the body names a parent: the parent must be one of this signal's replies,
 * and a parent that is itself inside a thread stands for the thread's top, so threads stay one
 * level deep whatever the client sends. The thread's author is told too, unless they are the
 * replier or the signal's author.
 */
export async function replyFor(actor: Actor, signalId: string, body: unknown): Promise<SosSignalPayload> {
  authorise(actor, 'sos.respond', `sos:${signalId}`);
  const signal = await requireVisible(actor, signalId);
  requireOpen(signal, 'This prayer request has been closed. Thank the author on a new one if you like.');
  requireTermsAccepted(actor, 'sos.respond', `sos:${signalId}`);

  const fields = asObject(body, 'Send a JSON object with the reply text.');
  const text = parseText(fields['text'], {
    empty: 'Write a few words first.',
    ceiling: MAX_SOS_REPLY_LENGTH,
    field: 'reply',
  });
  requireAllowedWords(actor, text, 'sos.respond', `sos:${signalId}`);
  const thread = await parseParent(fields['parentId'], signalId);

  await insertSosReply({ signalId, authorId: actor.id, parentId: thread?.id ?? null, text });
  logger.info('sos.reply', {
    ...audit(actor, 'sos.respond', `sos:${signalId}`),
    parentId: thread?.id ?? null,
  });

  await notifySosReply({ signalId, authorId: signal.authorId, replier: actor, replyText: text });
  if (thread !== null) {
    await notifySosThreadReply({
      signalId,
      signalAuthorId: signal.authorId,
      threadAuthorId: thread.authorId,
      replier: actor,
      replyText: text,
    });
  }

  return { signal: await detail(await requireVisible(actor, signalId), actor) };
}

/**
 * Remove a reply — the author's own, or anybody's by an admin. Owned first, moderation only where
 * the owned question denied, for the audit reason the module comment gives.
 */
export async function deleteReplyFor(
  actor: Actor,
  signalId: string,
  replyId: string,
): Promise<SosSignalPayload> {
  await requireVisible(actor, signalId);
  const reply = await findSosReplyById(replyId);
  if (reply === null || reply.signalId !== signalId) {
    throw ApiError.notFound('There is no such reply.');
  }
  const moderating = !can(actor, 'sos.reply.delete', {
    kind: 'sos_reply',
    id: replyId,
    ownerId: reply.authorId,
  });
  if (moderating) authorise(actor, 'sos.moderate', `sos_reply:${replyId}`);

  await deleteSosReply(replyId);
  logger.info(moderating ? 'sos.moderate' : 'sos.reply.delete', {
    ...audit(actor, moderating ? 'sos.moderate' : 'sos.reply.delete', `sos_reply:${replyId}`),
    signalId,
  });
  return { signal: await detail(await requireVisible(actor, signalId), actor) };
}

// =================================================================================================
// Ending
// =================================================================================================

/**
 * Close a signal ([3.16.8](docs/project/prd.md), [3.16.9](docs/project/prd.md)).
 *
 * The closing note is the author's ([4.15](docs/project/prd.md): author-set): an admin closing
 * somebody else's signal sends none, and a body that carries one is refused rather than written
 * under the author's name.
 */
export async function closeSignalFor(actor: Actor, signalId: string, body: unknown): Promise<SosSignalPayload> {
  const signal = await requireVisible(actor, signalId);
  const moderating = !can(actor, 'sos.close', { kind: 'sos', id: signalId, ownerId: signal.authorId });
  if (moderating) authorise(actor, 'sos.moderate', `sos:${signalId}`);
  requireOpen(signal, 'This prayer request has already been closed.');

  const fields = body === null || body === undefined ? {} : asObject(body, 'Send a JSON object, or nothing.');
  const rawNote = fields['note'];
  let note: string | null = null;
  if (rawNote !== undefined && rawNote !== null && rawNote !== '') {
    if (moderating) {
      throw ApiError.invalidInput('Only the member who raised a prayer request can leave a closing note.');
    }
    note = parseText(rawNote, {
      empty: 'Write the closing note, or leave it out.',
      ceiling: MAX_SOS_CLOSING_NOTE_LENGTH,
      field: 'closing note',
    });
    requireAllowedWords(actor, note, 'sos.close', `sos:${signalId}`);
  }

  const closed = await closeSosSignal({ signalId, closedBy: actor.id, note });
  if (closed === null) throw ApiError.invalidInput('This prayer request has already been closed.');

  logger.info(moderating ? 'sos.moderate' : 'sos.close', {
    ...audit(actor, moderating ? 'sos.moderate' : 'sos.close', `sos:${signalId}`),
    outcome: 'closed',
  });
  return { signal: await detail(await requireVisible(actor, signalId), actor) };
}

/**
 * Remove a signal entirely ([3.16.11](docs/project/prd.md)) — admin only, and a hard delete: the
 * replies, the acknowledgements and every notice that pointed at it go through the cascades.
 */
export async function removeSignalFor(actor: Actor, signalId: string): Promise<SosRemovedPayload> {
  authorise(actor, 'sos.moderate', `sos:${signalId}`);
  const signal = await findSosSignalById(signalId);
  if (signal === null) throw ApiError.notFound('There is no such prayer request.');
  await deleteSosSignal(signalId);
  logger.info('sos.moderate', {
    ...audit(actor, 'sos.moderate', `sos:${signalId}`),
    outcome: 'removed',
    authorId: signal.authorId,
  });
  return { signalId };
}

// =================================================================================================
// Preconditions
// =================================================================================================

/** The signal as this member may read it, or `not_found` — for a missing id and a hidden row alike. */
async function requireVisible(actor: Actor, signalId: string): Promise<SosSignalListRow> {
  const row = await findSosSignalForViewer(signalId, actor.id);
  if (row === null) throw ApiError.notFound('There is no such prayer request.');
  return row;
}

function requireOpen(signal: SosSignalListRow, message: string): void {
  if (signal.closedAt === null) return;
  throw ApiError.invalidInput(message);
}

/** The UGC gate the notes service holds, for the same reason: a signal and a reply are posts. */
function requireTermsAccepted(actor: Actor, action: string, target: string): void {
  if (termsAcceptanceIsCurrent(actor.termsAcceptedVersion)) return;
  logger.warn('sos.refused', {
    actorId: actor.id,
    action,
    target,
    reason: 'terms-not-accepted',
    code: 'terms_required',
    accepted: actor.termsAcceptedVersion,
  });
  throw ApiError.termsRequired(TERMS_REQUIRED_MESSAGE);
}

/** Every SOS text is read by the whole group, so every one is checked. The log carries the word, never the text. */
function requireAllowedWords(actor: Actor, text: string, action: string, target: string): void {
  const word = findBlockedWord(text);
  if (word === null) return;
  logger.warn('sos.refused', {
    actorId: actor.id,
    action,
    target,
    reason: 'blocked-word',
    code: 'invalid_input',
    word,
  });
  throw ApiError.invalidInput(BLOCKED_WORD_MESSAGE);
}

// =================================================================================================
// Describing
// =================================================================================================

async function detail(row: SosSignalListRow, actor: Actor): Promise<SosSignalDetailView> {
  const [replies, prayingNames] = await Promise.all([
    listSosReplies(row.id, actor.id),
    listSosPrayingNames(row.id, actor.id),
  ]);
  const avatars = await signAvatars([
    row.authorAvatarKey,
    ...replies.map((reply) => reply.authorAvatarKey),
  ]);
  return {
    ...describeSignal(row, actor, avatars),
    prayingNames,
    replies: threaded(replies, actor, avatars),
  };
}

/**
 * The flat, oldest-first list as threads: each top-level reply carrying the replies that answer
 * it. A reply whose parent the viewer may not see (a block hides it) is listed at the top level
 * rather than dropped, so the count on the row and the replies under it still agree.
 */
function threaded(
  rows: readonly SosReplyRow[],
  reader: Actor,
  avatars: ReadonlyMap<string, string>,
): SosReplyView[] {
  const tops = new Map<string, { view: SosReplyView; replies: SosReplyView[] }>();
  const orphans: SosReplyView[] = [];
  for (const row of rows) {
    if (row.parentId === null) {
      const replies: SosReplyView[] = [];
      tops.set(row.id, { view: describeReply(row, reader, avatars, replies), replies });
    }
  }
  for (const row of rows) {
    if (row.parentId === null) continue;
    const top = tops.get(row.parentId);
    if (top === undefined) orphans.push(describeReply(row, reader, avatars, []));
    else top.replies.push(describeReply(row, reader, avatars, []));
  }
  return [...[...tops.values()].map((top) => top.view), ...orphans];
}

function describeSignal(
  row: SosSignalListRow,
  reader: Actor,
  avatars: ReadonlyMap<string, string>,
): SosSignalView {
  return {
    id: row.id,
    urgency: row.urgency,
    description: row.description,
    author: author(row.authorId, row.authorDisplayName, row.authorAvatarKey, avatars),
    mine: row.authorId === reader.id,
    raisedAt: row.raisedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    closingNote: row.closingNote,
    prayingCount: row.prayingCount,
    praying: row.praying,
    replyCount: row.replyCount,
  };
}

function describeReply(
  row: SosReplyRow,
  reader: Actor,
  avatars: ReadonlyMap<string, string>,
  replies: SosReplyView[],
): SosReplyView {
  return {
    id: row.id,
    text: row.text,
    author: author(row.authorId, row.authorDisplayName, row.authorAvatarKey, avatars),
    mine: row.authorId === reader.id,
    createdAt: row.createdAt.toISOString(),
    replies,
  };
}

function author(
  id: string,
  displayName: string,
  avatarKey: string | null,
  avatars: ReadonlyMap<string, string>,
): SosAuthorView {
  return {
    id,
    displayName,
    avatarUrl: avatarKey === null ? null : (avatars.get(avatarKey) ?? null),
  };
}

/** One signed URL per distinct avatar key, as the notes service does and for its reason. */
async function signAvatars(keys: readonly (string | null)[]): Promise<ReadonlyMap<string, string>> {
  const distinct = [...new Set(keys.filter((key): key is string => key !== null))];
  const signed = await Promise.all(distinct.map((key) => mintArtworkGrant(key)));
  const byKey = new Map<string, string>();
  distinct.forEach((key, index) => {
    const url = signed[index];
    if (url !== null && url !== undefined) byKey.set(key, url);
  });
  return byKey;
}

// =================================================================================================
// Reading the body
// =================================================================================================

function parseStatus(value: string): SosStatus {
  if (isSosStatus(value)) return value;
  throw ApiError.invalidInput('Ask for the open prayer requests or the resolved ones.');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The reply a new one answers, or `null` for a reply to the signal itself. Must be one of this
 * signal's; a parent inside a thread stands for the thread's top.
 */
async function parseParent(value: unknown, signalId: string): Promise<SosReplyRow | null> {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw ApiError.invalidInput('Name the reply to answer, or leave it out.');
  }
  const named = await findSosReplyById(value);
  if (named === null || named.signalId !== signalId) {
    throw ApiError.invalidInput('The reply to answer is not on this prayer request.');
  }
  if (named.parentId === null) return named;
  const top = await findSosReplyById(named.parentId);
  if (top === null) throw ApiError.invalidInput('The reply to answer is not on this prayer request.');
  return top;
}

function asObject(body: unknown, complaint: string): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) throw ApiError.invalidInput(complaint);
  return body as Record<string, unknown>;
}

/** Trimmed, non-empty and under the ceiling — refused rather than cut, so nothing is lost silently. */
function parseText(
  value: unknown,
  rule: { readonly empty: string; readonly ceiling: number; readonly field: string },
): string {
  if (typeof value !== 'string' || value.trim() === '') throw ApiError.invalidInput(rule.empty);
  const trimmed = value.trim();
  if (trimmed.length > rule.ceiling) {
    throw ApiError.invalidInput(
      `The ${rule.field} can be at most ${rule.ceiling.toLocaleString('en-GB')} characters.`,
    );
  }
  return trimmed;
}

