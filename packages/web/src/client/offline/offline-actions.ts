import {
  FLOW_QUESTION_BANK_PATH,
  FLOW_SESSIONS_PATH,
  FLOW_TEACHINGS_PATH,
  HIGHLIGHTS_PATH,
  MAX_NOTE_FOLDERS,
  MY_NOTES_PATH,
  NOTE_FOLDERS_FULL_MESSAGE,
  NOTE_FOLDERS_PATH,
  NOTE_FOLDER_EXISTS_MESSAGE,
  NOTIFICATIONS_PATH,
  PLAYBACK_SPEED_PATH,
  PUSH_PREFERENCES_PATH,
  SOS_PATH,
  flowSessionPath,
  isFlowRating,
  isGapRating,
  normaliseNoteFolderName,
  recordingTranscriptPath,
  sosPath,
  sosUrgencyRank,
  type FlowQuestionBankPayload,
  type FlowQuestionSeed,
  type FlowReadingGroup,
  type FlowSessionItemView,
  type FlowSessionSummary,
  type FlowSessionView,
  type FlowSessionsPayload,
  type FlowTeachingsPayload,
  type HighlightListPayload,
  type HighlightRecordingRef,
  type HighlightView,
  type MyNotesPayload,
  type NoteFolderView,
  type NoteFoldersPayload,
  type NoteView,
  type NotificationListPayload,
  type NotificationView,
  type PushPreferencesPayload,
  type SosAuthorView,
  type SosListPayload,
  type SosReplyView,
  type SosSignalDetailView,
  type SosSignalPayload,
  type SosSignalView,
  type SosUrgency,
  type TranscriptPayload,
} from '@thp/shared';
import type { DownloadRecord } from './schema';

/**
 * **What a member can do with no connection, beyond writing a note**
 * ([3.18.18](docs/project/prd.md)).
 *
 * Each action here is a write the API would take — a reply, a reaction, a highlight, a prayer
 * request, an answer in the Flow Tracker, a notification read — met while the server cannot be
 * reached. Two things happen to it, and this file decides both:
 *
 * 1. **The device's copy of what the screens read is changed** the way the server would have
 *    changed it, and the request is answered with the payload the server would have answered. The
 *    screens are not edited for any of this: one that renders the answer renders this one, and
 *    one that reads its list again is answered from the copy that now holds the change.
 * 2. **The request is queued**, to be sent as it was made when the connection returns
 *    (`replay.ts`). What the server then says is the truth; this file's answer is the best
 *    reading of it the device could make alone.
 *
 * **Pure.** Every function takes a {@link World} — the device's copies, the account, a clock and
 * an id minter — and answers an {@link Outcome}. The wiring to IndexedDB is `offline-api.ts`; the
 * unit test drives this with a map.
 *
 * **Things made offline carry an id the device minted**, and the queue remembers where the real
 * one will be in the server's answer (`creates`). A later action on the same thing is queued with
 * the device's id and re-addressed at replay; one that *removes* a thing the server has never
 * heard of cancels the queued creation instead of queueing a removal (`cancel`).
 *
 * **What is refused rather than queued:** an action on something the device holds no copy of — a
 * note on a teaching that is not downloaded, a prayer request never opened — because there is
 * nothing to show the change on, and a queued write the member cannot see is a surprise later.
 */

export interface StoredSessionUser {
  readonly id: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly preferredPlaybackSpeed?: number;
}

export interface World {
  readonly userId: string;
  /** ISO 8601 — the device's clock, used for every "when" an action stamps. */
  readonly now: string;
  readonly user: StoredSessionUser | null;
  mintId(): string;
  /** The device's copy of a `GET`, by the path the screen asks for, or `undefined`. */
  read<T>(path: string): T | undefined;
  /** Every path a copy is held for. */
  paths(): readonly string[];
  write(path: string, body: unknown): void;
  downloads(): readonly DownloadRecord[];
  putDownload(record: DownloadRecord): void;
  setSpeed(speed: number): void;
  /** Whether this id was minted on the device by a creation that is still queued. */
  isQueuedTemp(id: string): boolean;
}

/** Where, in the server's answer to a queued creation, the real id of a device-minted one is. */
export interface Created {
  readonly temp: string;
  /** A dotted path into the response body, e.g. `signal.id` or `session.items.3.id`. */
  readonly at: string;
}

export interface QueueInstruction {
  /** What the member did, for the sentence printed if the server refuses it later. */
  readonly label: string;
  readonly creates?: readonly Created[];
  /** A queued request with the same key is replaced by this one: the last press is the one sent. */
  readonly coalesce?: string;
  /** A teaching whose notes the replay changes, so the player reads them again afterwards. */
  readonly recordingId?: string;
}

export type Outcome =
  | {
      readonly status: number;
      readonly body: unknown;
      /** Absent when nothing is to be sent — the action undid something the server never saw. */
      readonly queue?: QueueInstruction;
      /** A device-minted id whose queued requests are dropped: the thing was removed before it was sent. */
      readonly cancel?: string;
    }
  | { readonly refused: true; readonly status: number; readonly code: string; readonly message: string };

function refuse(message: string, status = 503, code = 'service_unavailable'): Outcome {
  return { refused: true, status, code, message };
}

const NOT_HELD = 'You are offline, and this has not been opened on this device yet.';
const NOT_SENT_YET = 'That was written offline and has not been sent yet. Try again when you are back online.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// =================================================================================================
// Notes
// =================================================================================================

/** Change one note anywhere in a tree; `null` removes it. Answers the new tree and the note found. */
function changeNote(
  notes: readonly NoteView[],
  id: string,
  change: (note: NoteView) => NoteView | null,
): { readonly notes: NoteView[]; readonly found: NoteView | null; readonly after: NoteView | null } {
  let found: NoteView | null = null;
  let after: NoteView | null = null;
  const next: NoteView[] = [];
  for (const note of notes) {
    if (note.id === id) {
      found = note;
      after = change(note);
      if (after !== null) next.push(after);
      continue;
    }
    const inner = changeNote(note.replies, id, change);
    if (inner.found !== null) {
      found = inner.found;
      after = inner.after;
      next.push({ ...note, replies: inner.notes });
    } else {
      next.push(note);
    }
  }
  return { notes: next, found, after };
}

/** Apply a change to a note wherever a download holds it. Answers what it became, and where. */
function changeHeldNote(
  world: World,
  id: string,
  change: (note: NoteView) => NoteView | null,
): { readonly found: NoteView; readonly after: NoteView | null; readonly recordingId: string } | null {
  for (const download of world.downloads()) {
    const result = changeNote(download.notes, id, change);
    if (result.found === null) continue;
    world.putDownload({ ...download, notes: result.notes });
    return { found: result.found, after: result.after, recordingId: download.recordingId };
  }
  return null;
}

function changeMyNotes(world: World, change: (entries: MyNotesPayload['entries']) => MyNotesPayload['entries']): void {
  const held = world.read<MyNotesPayload>(MY_NOTES_PATH);
  if (held === undefined) return;
  world.write(MY_NOTES_PATH, { ...held, entries: change(held.entries) });
}

function reply(world: World, recordingId: string, body: Record<string, unknown>): Outcome {
  const parentId = body['parentId'];
  const text = body['text'];
  if (typeof parentId !== 'string' || typeof text !== 'string') return refuse('You are offline.');
  if (parentId.startsWith('pending:')) return refuse(NOT_SENT_YET);
  const download = world.downloads().find((one) => one.recordingId === recordingId);
  if (download === undefined) return refuse('You are offline, and this teaching is not downloaded.');
  if (text.trim() === '' && !Array.isArray(body['images'])) return refuse('You are offline.');

  const written: NoteView = {
    id: `pending:${world.mintId()}`,
    timestampMs: null,
    authorId: world.userId,
    authorDisplayName: world.user?.displayName ?? 'You',
    authorAvatarUrl: world.user?.avatarUrl ?? null,
    visibility: 'public',
    mine: true,
    text,
    createdAt: world.now,
    deleted: false,
    pinned: false,
    replies: [],
    reactions: [],
    myReaction: null,
    images: [],
  };
  const result = changeNote(download.notes, parentId, (parent) => ({
    ...parent,
    replies: [...parent.replies, { ...written, visibility: parent.visibility }],
  }));
  if (result.found === null) return refuse(NOT_HELD);
  if (result.found.deleted) return refuse('That note has been removed.', 409, 'note_removed');
  world.putDownload({ ...download, notes: result.notes });
  return { status: 200, body: { note: written }, queue: { label: 'A reply', recordingId } };
}

function editNote(world: World, id: string, body: Record<string, unknown>): Outcome {
  if (id.startsWith('pending:')) return refuse(NOT_SENT_YET);
  const text = body['text'];
  if (typeof text !== 'string') return refuse('You are offline.');
  // Pictures the note keeps are named by their id; a new one is uploaded at replay and is not
  // drawn until then.
  const kept = new Set(
    Array.isArray(body['images'])
      ? (body['images'] as unknown[]).flatMap((one) => (isRecord(one) && typeof one['id'] === 'string' ? [one['id']] : []))
      : [],
  );
  const hasImages = Array.isArray(body['images']);
  const result = changeHeldNote(world, id, (note) =>
    note.deleted || !note.mine
      ? note
      : { ...note, text, images: hasImages ? note.images.filter((image) => kept.has(image.id)) : note.images },
  );
  if (result === null) return refuse(NOT_HELD);
  if (result.found.deleted) return refuse('That note has been removed.', 409, 'note_removed');
  changeMyNotes(world, (entries) =>
    entries.map((entry) => (entry.note.id === id ? { ...entry, note: { ...entry.note, text } } : entry)),
  );
  const highlights = world.read<HighlightListPayload>(HIGHLIGHTS_PATH);
  if (highlights !== undefined) {
    world.write(HIGHLIGHTS_PATH, {
      ...highlights,
      highlights: highlights.highlights.map((one) =>
        one.note?.id === id ? { ...one, note: { ...one.note, text } } : one,
      ),
    });
  }
  return {
    status: 200,
    body: { note: result.after },
    queue: { label: 'An edit to a note', coalesce: `note-edit:${id}`, recordingId: result.recordingId },
  };
}

function deleteNote(world: World, id: string): Outcome {
  if (id.startsWith('pending:')) return refuse(NOT_SENT_YET);
  // The tombstone the server answers: the fact of a note, and nothing it said.
  const result = changeHeldNote(world, id, (note) =>
    note.deleted
      ? note
      : {
          ...note,
          deleted: true,
          text: '',
          authorId: null,
          authorAvatarUrl: null,
          reactions: [],
          myReaction: null,
          images: [],
        },
  );
  if (result === null) return refuse(NOT_HELD);
  if (result.found.deleted) return refuse('That note has been removed.', 409, 'note_removed');
  changeMyNotes(world, (entries) => entries.filter((entry) => entry.note.id !== id));
  const highlights = world.read<HighlightListPayload>(HIGHLIGHTS_PATH);
  if (highlights !== undefined) {
    world.write(HIGHLIGHTS_PATH, {
      ...highlights,
      highlights: highlights.highlights.filter((one) => one.note?.id !== id),
    });
  }
  return {
    status: 200,
    body: { note: result.after },
    queue: { label: 'Removing a note', recordingId: result.recordingId },
  };
}

function react(world: World, id: string, emoji: string | null): Outcome {
  if (id.startsWith('pending:')) return refuse(NOT_SENT_YET);
  const result = changeHeldNote(world, id, (note) => {
    if (note.deleted) return note;
    // Take the member's earlier reaction out of the counts, then put the new one in.
    let reactions = note.reactions
      .map((one) => (one.emoji === note.myReaction ? { ...one, count: one.count - 1 } : one))
      .filter((one) => one.count > 0);
    if (emoji !== null) {
      reactions = reactions.some((one) => one.emoji === emoji)
        ? reactions.map((one) => (one.emoji === emoji ? { ...one, count: one.count + 1 } : one))
        : [...reactions, { emoji, count: 1 }];
    }
    return { ...note, reactions, myReaction: emoji };
  });
  if (result === null) return refuse(NOT_HELD);
  if (result.found.deleted) return refuse('That note has been removed.', 409, 'note_removed');
  return {
    status: 200,
    body: { note: result.after },
    queue: { label: 'A reaction', coalesce: `note-reaction:${id}`, recordingId: result.recordingId },
  };
}

// =================================================================================================
// Note folders
// =================================================================================================

function sortFolders(folders: readonly NoteFolderView[]): NoteFolderView[] {
  return [...folders].sort(
    (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.createdAt.localeCompare(b.createdAt),
  );
}

function folders(world: World): NoteFolderView[] | null {
  return world.read<NoteFoldersPayload>(NOTE_FOLDERS_PATH)?.folders.slice() ?? null;
}

function answerFolders(world: World, next: readonly NoteFolderView[], queue: QueueInstruction | undefined, cancel?: string): Outcome {
  const payload: NoteFoldersPayload = { folders: sortFolders(next) };
  world.write(NOTE_FOLDERS_PATH, payload);
  return { status: 200, body: payload, ...(queue === undefined ? {} : { queue }), ...(cancel === undefined ? {} : { cancel }) };
}

function createFolder(world: World, body: Record<string, unknown>): Outcome {
  const held = folders(world);
  if (held === null) return refuse(NOT_HELD);
  const name = normaliseNoteFolderName(body['name']);
  if (name === null) return refuse('Give the folder a name.', 400, 'invalid_input');
  if (held.some((one) => one.name.toLowerCase() === name.toLowerCase())) {
    return refuse(NOTE_FOLDER_EXISTS_MESSAGE, 409, 'note_folder_exists');
  }
  if (held.length >= MAX_NOTE_FOLDERS) return refuse(NOTE_FOLDERS_FULL_MESSAGE, 409, 'note_folders_full');
  const id = world.mintId();
  // The server answers the whole list; the new folder is found in it by name at replay.
  return answerFolders(world, [...held, { id, name, noteIds: [], createdAt: world.now }], {
    label: `The folder “${name}”`,
    creates: [{ temp: id, at: `folders[name=${name}].id` }],
  });
}

function renameFolder(world: World, id: string, body: Record<string, unknown>): Outcome {
  const held = folders(world);
  if (held === null || !held.some((one) => one.id === id)) return refuse(NOT_HELD);
  const name = normaliseNoteFolderName(body['name']);
  if (name === null) return refuse('Give the folder a name.', 400, 'invalid_input');
  if (held.some((one) => one.id !== id && one.name.toLowerCase() === name.toLowerCase())) {
    return refuse(NOTE_FOLDER_EXISTS_MESSAGE, 409, 'note_folder_exists');
  }
  return answerFolders(
    world,
    held.map((one) => (one.id === id ? { ...one, name } : one)),
    { label: 'Renaming a folder', coalesce: `folder-name:${id}` },
  );
}

function deleteFolder(world: World, id: string): Outcome {
  const held = folders(world);
  if (held === null) return refuse(NOT_HELD);
  const next = held.filter((one) => one.id !== id);
  // A folder made offline and removed offline never reaches the server at all.
  if (world.isQueuedTemp(id)) return answerFolders(world, next, undefined, id);
  return answerFolders(world, next, { label: 'Removing a folder' });
}

function fileNote(world: World, noteId: string, body: Record<string, unknown>): Outcome {
  const held = folders(world);
  if (held === null) return refuse(NOT_HELD);
  if (noteId.startsWith('pending:')) return refuse(NOT_SENT_YET);
  const wanted = body['folderIds'];
  if (!Array.isArray(wanted) || wanted.some((one) => typeof one !== 'string')) return refuse('You are offline.');
  const into = new Set(wanted as string[]);
  if ([...into].some((id) => !held.some((one) => one.id === id))) return refuse('That folder is not yours.', 404, 'not_found');
  return answerFolders(
    world,
    held.map((one) => {
      const without = one.noteIds.filter((id) => id !== noteId);
      return { ...one, noteIds: into.has(one.id) ? [...without, noteId] : without };
    }),
    { label: 'Filing a note', coalesce: `note-folders:${noteId}` },
  );
}

// =================================================================================================
// Highlights
// =================================================================================================

function recordingRefOf(download: DownloadRecord): HighlightRecordingRef {
  const recording = download.recording;
  return {
    id: download.recordingId,
    title: recording.title,
    description: recording.description ?? null,
    recordedAt: recording.recordedAt,
    series:
      recording.series === null || recording.series === undefined
        ? null
        : { id: recording.series.id, title: recording.series.title, artworkUrl: recording.series.artworkUrl ?? null },
  };
}

/** The teaching a highlight would be on, from whatever on the device already describes it. */
function recordingRef(world: World, recordingId: string, held: readonly HighlightView[]): HighlightRecordingRef | null {
  const download = world.downloads().find((one) => one.recordingId === recordingId);
  if (download !== undefined) return recordingRefOf(download);
  return held.find((one) => one.recording.id === recordingId)?.recording ?? null;
}

function addHighlight(world: World, body: Record<string, unknown>): Outcome {
  const list = world.read<HighlightListPayload>(HIGHLIGHTS_PATH);
  if (list === undefined) return refuse(NOT_HELD);
  const held = list.highlights;
  const kind = body['kind'];
  let entry: HighlightView | null = null;
  const base = { id: world.mintId(), pinnedAt: world.now, segment: null };

  if (kind === 'note' && typeof body['noteId'] === 'string') {
    const noteId = body['noteId'];
    if (noteId.startsWith('pending:')) return refuse(NOT_SENT_YET);
    const already = held.find((one) => one.kind === 'note' && one.note?.id === noteId);
    if (already !== undefined) return { status: 200, body: list };
    for (const download of world.downloads()) {
      const found = changeNote(download.notes, noteId, (note) => note).found;
      if (found === null) continue;
      entry = { ...base, kind: 'note', recording: recordingRefOf(download), positionMs: found.timestampMs, note: { id: noteId, text: found.text } };
      break;
    }
    if (entry === null) {
      const mine = world.read<MyNotesPayload>(MY_NOTES_PATH)?.entries.find((one) => one.note.id === noteId);
      if (mine !== undefined) {
        const known = recordingRef(world, mine.recording.id, held);
        entry = {
          ...base,
          kind: 'note',
          recording: known ?? {
            id: mine.recording.id,
            title: mine.recording.title,
            description: null,
            recordedAt: '',
            series: mine.recording.series === null ? null : { ...mine.recording.series, artworkUrl: null },
          },
          positionMs: mine.note.timestampMs,
          note: { id: noteId, text: mine.note.text },
        };
      }
    }
  } else if ((kind === 'segment' || kind === 'recording') && typeof body['recordingId'] === 'string') {
    const recording = recordingRef(world, body['recordingId'], held);
    if (recording === null) return refuse(NOT_HELD);
    if (kind === 'recording') {
      const already = held.find((one) => one.kind === 'recording' && one.recording.id === recording.id);
      if (already !== undefined) return { status: 200, body: list };
      entry = { ...base, kind: 'recording', recording, positionMs: null, note: null };
    } else {
      const positionMs = body['positionMs'];
      if (typeof positionMs !== 'number' || !Number.isFinite(positionMs) || positionMs < 0) return refuse('You are offline.');
      const at = Math.round(positionMs);
      const already = held.find((one) => one.kind === 'segment' && one.recording.id === recording.id && one.positionMs === at);
      if (already !== undefined) return { status: 200, body: list };
      // The server snaps a moment to the transcript line under it. With the transcript on the
      // device the same line is found here; without it the entry is the bare moment until sent.
      const line =
        world
          .read<TranscriptPayload>(recordingTranscriptPath(recording.id))
          ?.transcript?.segments.find((one) => at >= one.startMs && at < one.endMs) ?? null;
      if (line !== null) {
        const snapped = held.find((one) => one.kind === 'segment' && one.recording.id === recording.id && one.positionMs === line.startMs);
        if (snapped !== undefined) return { status: 200, body: list };
      }
      entry = {
        ...base,
        kind: 'segment',
        recording,
        positionMs: line?.startMs ?? at,
        segment: line === null ? null : { startMs: line.startMs, endMs: line.endMs, text: line.text },
        note: null,
      };
    }
  }
  if (entry === null) return refuse(NOT_HELD);

  const payload: HighlightListPayload = { highlights: [entry, ...held] };
  world.write(HIGHLIGHTS_PATH, payload);
  // The server answers the whole list, newest first: the one just made is the first.
  return {
    status: 200,
    body: payload,
    queue: { label: 'A highlight', creates: [{ temp: entry.id, at: 'highlights.0.id' }] },
  };
}

function removeHighlight(world: World, id: string): Outcome {
  const list = world.read<HighlightListPayload>(HIGHLIGHTS_PATH);
  if (list === undefined) return refuse(NOT_HELD);
  const payload: HighlightListPayload = { highlights: list.highlights.filter((one) => one.id !== id) };
  world.write(HIGHLIGHTS_PATH, payload);
  if (world.isQueuedTemp(id)) return { status: 200, body: payload, cancel: id };
  return { status: 200, body: payload, queue: { label: 'Removing a highlight' } };
}

// =================================================================================================
// Prayer requests
// =================================================================================================

function isSosList(path: string): boolean {
  return path === SOS_PATH || path.startsWith(`${SOS_PATH}?`);
}

/** Change every held copy of the board — the open list, the resolved one, the dashboard's card. */
function changeSosLists(world: World, change: (list: SosListPayload) => SosListPayload): void {
  for (const path of world.paths()) {
    if (!isSosList(path)) continue;
    const held = world.read<SosListPayload>(path);
    if (held !== undefined && Array.isArray(held.signals)) world.write(path, change(held));
  }
}

function summaryOf(detail: SosSignalDetailView): SosSignalView {
  const { prayingNames: _names, prayingAnonymousCount: _count, replies: _replies, ...summary } = detail;
  void _names;
  void _count;
  void _replies;
  return summary;
}

function me(world: World): SosAuthorView {
  return { id: world.userId, displayName: world.user?.displayName ?? 'You', avatarUrl: world.user?.avatarUrl ?? null };
}

/** Write a changed signal to its own copy and to its row on every list that shows it. */
function putSignal(world: World, signal: SosSignalDetailView): Outcome['status'] {
  world.write(sosPath(signal.id), { signal } satisfies SosSignalPayload);
  const row = summaryOf(signal);
  changeSosLists(world, (list) => ({
    ...list,
    signals: list.signals.map((one) => (one.id === signal.id ? row : one)),
  }));
  return 200;
}

function heldSignal(world: World, id: string): SosSignalDetailView | null {
  return world.read<SosSignalPayload>(sosPath(id))?.signal ?? null;
}

function raiseSignal(world: World, body: Record<string, unknown>): Outcome {
  const urgency = body['urgency'] as SosUrgency;
  const description = body['description'];
  if (typeof description !== 'string' || description.trim() === '' || typeof urgency !== 'string') {
    return refuse('Describe the request and choose how urgent it is.', 400, 'invalid_input');
  }
  const anonymous = body['anonymous'] === true;
  const signal: SosSignalDetailView = {
    id: world.mintId(),
    urgency,
    description: description.trim(),
    author: me(world),
    anonymous,
    mine: true,
    raisedAt: world.now,
    closedAt: null,
    closingNote: null,
    prayingCount: 0,
    praying: false,
    prayingAnonymously: false,
    replyCount: 0,
    prayingNames: [],
    prayingAnonymousCount: 0,
    replies: [],
  };
  world.write(sosPath(signal.id), { signal });
  const row = summaryOf(signal);
  changeSosLists(world, (list) =>
    list.status !== 'open'
      ? list
      : {
          ...list,
          signals: [row, ...list.signals].sort(
            (a, b) => sosUrgencyRank(a.urgency) - sosUrgencyRank(b.urgency) || b.raisedAt.localeCompare(a.raisedAt),
          ),
          openCounts: { ...list.openCounts, [urgency]: (list.openCounts[urgency] ?? 0) + 1 },
        },
  );
  return {
    status: 201,
    body: { signal },
    queue: { label: 'A prayer request', creates: [{ temp: signal.id, at: 'signal.id' }] },
  };
}

function addSosReply(replies: readonly SosReplyView[], parentId: string, written: SosReplyView): SosReplyView[] | null {
  let placed = false;
  const next = replies.map((one) => {
    if (one.id === parentId) {
      placed = true;
      return { ...one, replies: [...one.replies, written] };
    }
    const inner = addSosReply(one.replies, parentId, written);
    if (inner === null) return one;
    placed = true;
    return { ...one, replies: inner };
  });
  return placed ? next : null;
}

function removeSosReply(replies: readonly SosReplyView[], id: string): { readonly replies: SosReplyView[]; readonly removed: number } {
  let removed = 0;
  const next: SosReplyView[] = [];
  for (const one of replies) {
    if (one.id === id) {
      removed += 1;
      continue;
    }
    const inner = removeSosReply(one.replies, id);
    removed += inner.removed;
    next.push(inner.removed === 0 ? one : { ...one, replies: inner.replies });
  }
  return { replies: next, removed };
}

function replyToSignal(world: World, id: string, body: Record<string, unknown>): Outcome {
  const signal = heldSignal(world, id);
  if (signal === null) return refuse(NOT_HELD);
  if (signal.closedAt !== null) return refuse('This request has been closed.', 400, 'invalid_input');
  const text = body['text'];
  if (typeof text !== 'string' || text.trim() === '') return refuse('Write the reply.', 400, 'invalid_input');
  const written: SosReplyView = {
    id: world.mintId(),
    text: text.trim(),
    // On the member's own anonymous request their replies carry the request's author line.
    author: signal.mine ? signal.author : me(world),
    mine: true,
    createdAt: world.now,
    replies: [],
  };
  const parentId = body['parentId'];
  let replies: SosReplyView[] | null;
  if (typeof parentId === 'string' && parentId !== '') {
    if (world.isQueuedTemp(parentId)) return refuse(NOT_SENT_YET);
    replies = addSosReply(signal.replies, parentId, written);
    if (replies === null) return refuse('That reply is no longer there.', 404, 'not_found');
  } else {
    replies = [...signal.replies, written];
  }
  const next: SosSignalDetailView = { ...signal, replies, replyCount: signal.replyCount + 1 };
  putSignal(world, next);
  // The reply's real id is deep in the answer and nothing queued needs it except its own removal,
  // which a device-minted id turns into a cancellation.
  return { status: 201, body: { signal: next }, queue: { label: 'A reply to a prayer request', creates: [{ temp: written.id, at: '' }] } };
}

function deleteSosReply(world: World, id: string, replyId: string): Outcome {
  const signal = heldSignal(world, id);
  if (signal === null) return refuse(NOT_HELD);
  const result = removeSosReply(signal.replies, replyId);
  if (result.removed === 0) return refuse('That reply is no longer there.', 404, 'not_found');
  const next: SosSignalDetailView = { ...signal, replies: result.replies, replyCount: Math.max(0, signal.replyCount - 1) };
  putSignal(world, next);
  if (world.isQueuedTemp(replyId)) return { status: 200, body: { signal: next }, cancel: replyId };
  return { status: 200, body: { signal: next }, queue: { label: 'Removing a reply' } };
}

function setPraying(world: World, id: string, praying: boolean, body: Record<string, unknown>): Outcome {
  const signal = heldSignal(world, id);
  if (signal === null) return refuse(NOT_HELD);
  if (praying && signal.closedAt !== null) return refuse('This request has been closed.', 400, 'invalid_input');
  const name = world.user?.displayName ?? 'You';
  // Take the member's earlier press out, whichever way it was made, then put the new one in.
  let prayingCount = signal.prayingCount - (signal.praying ? 1 : 0);
  let prayingAnonymousCount = signal.prayingAnonymousCount - (signal.praying && signal.prayingAnonymously ? 1 : 0);
  let prayingNames = signal.praying && !signal.prayingAnonymously ? signal.prayingNames.filter((one) => one !== name) : [...signal.prayingNames];
  const anonymous = praying && body['anonymous'] === true;
  if (praying) {
    prayingCount += 1;
    if (anonymous) prayingAnonymousCount += 1;
    else prayingNames = [...prayingNames, name];
  }
  const next: SosSignalDetailView = {
    ...signal,
    praying,
    prayingAnonymously: anonymous,
    prayingCount: Math.max(0, prayingCount),
    prayingAnonymousCount: Math.max(0, prayingAnonymousCount),
    prayingNames,
  };
  putSignal(world, next);
  return { status: 200, body: { signal: next }, queue: { label: 'Praying for a request', coalesce: `sos-praying:${id}` } };
}

function closeSignal(world: World, id: string, body: Record<string, unknown>): Outcome {
  const signal = heldSignal(world, id);
  if (signal === null) return refuse(NOT_HELD);
  if (signal.closedAt !== null) return refuse('This request has already been closed.', 400, 'invalid_input');
  const note = typeof body['note'] === 'string' && body['note'].trim() !== '' ? body['note'].trim() : null;
  const next: SosSignalDetailView = { ...signal, closedAt: world.now, closingNote: note };
  world.write(sosPath(id), { signal: next });
  const row = summaryOf(next);
  changeSosLists(world, (list) => {
    const without = list.signals.filter((one) => one.id !== id);
    const wasOpen = without.length !== list.signals.length;
    const openCounts =
      list.openCounts[signal.urgency] === undefined
        ? list.openCounts
        : { ...list.openCounts, [signal.urgency]: Math.max(0, list.openCounts[signal.urgency] - 1) };
    if (list.status === 'resolved') return { ...list, signals: [row, ...without], openCounts };
    return { ...list, signals: without, openCounts: wasOpen ? openCounts : list.openCounts };
  });
  return { status: 200, body: { signal: next }, queue: { label: 'Closing a prayer request' } };
}

// =================================================================================================
// The Flow Tracker
// =================================================================================================

function sessions(world: World): FlowSessionsPayload | null {
  return world.read<FlowSessionsPayload>(FLOW_SESSIONS_PATH) ?? null;
}

function summaryOfSession(session: FlowSessionView): FlowSessionSummary {
  const { items: _items, readingList: _list, ...summary } = session;
  void _items;
  void _list;
  return summary;
}

/** The gaps, grouped by teaching — what the server answers, less the related reading it adds. */
function localReadingList(items: readonly FlowSessionItemView[]): FlowReadingGroup[] {
  const gaps = items.filter((one) => one.rating !== null && isGapRating(one.rating));
  const groups: FlowReadingGroup[] = [];
  // Oldest teaching first: the reverse of the order the questions were asked in.
  for (const item of [...gaps].reverse()) {
    const key = item.recording?.id ?? null;
    const group = groups.find((one) => (one.recording?.id ?? null) === key);
    const row = { item, taggedTeachings: [], related: [] };
    if (group === undefined) groups.push({ recording: item.recording, rows: [row] });
    else (group.rows as (typeof row)[]).push(row);
  }
  return groups;
}

function putSession(world: World, session: FlowSessionView): void {
  world.write(flowSessionPath(session.id), { session });
  const held = sessions(world);
  if (held === null) return;
  const summary = summaryOfSession(session);
  const completed = held.completed.filter((one) => one.id !== session.id);
  world.write(FLOW_SESSIONS_PATH, {
    active: session.status === 'in_progress' ? summary : held.active?.id === session.id ? null : held.active,
    completed: session.status === 'complete' ? [summary, ...completed] : completed,
  } satisfies FlowSessionsPayload);
}

function startSession(world: World, body: Record<string, unknown>): Outcome {
  const teachings = world.read<FlowTeachingsPayload>(FLOW_TEACHINGS_PATH);
  const bank = world.read<FlowQuestionBankPayload>(FLOW_QUESTION_BANK_PATH);
  const held = sessions(world);
  if (teachings === undefined || bank === undefined || held === null) {
    return refuse('You are offline, and the Flow Tracker’s questions are not on this device yet.');
  }
  if (held.active !== null) {
    return refuse('You already have a session in progress.', 409, 'flow_session_in_progress');
  }
  const wanted = body['recordingIds'];
  if (!Array.isArray(wanted) || wanted.length === 0) return refuse('Pick at least one teaching.', 400, 'invalid_input');
  const picked = new Set(wanted.filter((one): one is string => typeof one === 'string'));
  // The library's order, as the server takes them: newest first.
  const range = teachings.teachings.filter((one) => picked.has(one.id));
  if (range.length !== picked.size) return refuse('That teaching is not available.', 404, 'not_found');

  const seeds: FlowQuestionSeed[] = range.flatMap((one) => bank.byTeaching[one.id] ?? []);
  const tagIds = [...new Set(range.flatMap((one) => one.tagIds))].filter((id) => (bank.byTag[id]?.length ?? 0) > 0);
  tagIds.sort((a, b) => (bank.byTag[a]?.[0]?.tag?.name ?? '').localeCompare(bank.byTag[b]?.[0]?.tag?.name ?? ''));
  for (const id of tagIds) seeds.push(...(bank.byTag[id] ?? []));

  const items: FlowSessionItemView[] = seeds.map((seed, index) => ({
    ...seed,
    id: world.mintId(),
    position: index + 1,
    rating: null,
    answeredAt: null,
    done: false,
  }));
  const done = items.length === 0;
  const session: FlowSessionView = {
    id: world.mintId(),
    status: done ? 'complete' : 'in_progress',
    startedAt: world.now,
    completedAt: done ? world.now : null,
    teachings: range.map(({ questionCount: _count, tagIds: _tags, ...ref }) => {
      void _count;
      void _tags;
      return ref;
    }),
    teachingCount: range.length,
    questionCount: items.length,
    answeredCount: 0,
    gapCount: 0,
    items,
    readingList: done ? [] : null,
  };
  putSession(world, session);
  return {
    status: 201,
    body: { session },
    queue: {
      label: 'A Flow Tracker session',
      // The server assembles the same questions in the same order, so position names the item.
      creates: [
        { temp: session.id, at: 'session.id' },
        ...items.map((item, index) => ({ temp: item.id, at: `session.items.${index}.id` })),
      ],
    },
  };
}

function heldSession(world: World, id: string): FlowSessionView | null {
  return world.read<{ session: FlowSessionView }>(flowSessionPath(id))?.session ?? null;
}

function answerItem(world: World, sessionId: string, itemId: string, body: Record<string, unknown>): Outcome {
  const session = heldSession(world, sessionId);
  if (session === null) return refuse(NOT_HELD);
  if (session.status !== 'in_progress') return refuse('This session is no longer taking answers.', 400, 'invalid_input');
  const rating = body['rating'];
  if (!isFlowRating(rating)) return refuse('Choose a number from 1 to 5.', 400, 'invalid_input');
  if (!session.items.some((one) => one.id === itemId)) return refuse('There is no such question.', 404, 'not_found');
  const items = session.items.map((one) => (one.id === itemId ? { ...one, rating, answeredAt: world.now } : one));
  const answered = items.filter((one) => one.rating !== null);
  const complete = answered.length === items.length;
  const next: FlowSessionView = {
    ...session,
    items,
    answeredCount: answered.length,
    gapCount: answered.filter((one) => one.rating !== null && isGapRating(one.rating)).length,
    status: complete ? 'complete' : 'in_progress',
    completedAt: complete ? world.now : null,
    readingList: complete ? localReadingList(items) : null,
  };
  putSession(world, next);
  return { status: 200, body: { session: next }, queue: { label: 'An answer in the Flow Tracker', coalesce: `flow-answer:${itemId}` } };
}

function markItem(world: World, sessionId: string, itemId: string, body: Record<string, unknown>): Outcome {
  const session = heldSession(world, sessionId);
  if (session === null) return refuse(NOT_HELD);
  const done = body['done'] === true;
  if (!session.items.some((one) => one.id === itemId)) return refuse('There is no such question.', 404, 'not_found');
  const change = (one: FlowSessionItemView): FlowSessionItemView => (one.id === itemId ? { ...one, done } : one);
  const next: FlowSessionView = {
    ...session,
    items: session.items.map(change),
    readingList:
      session.readingList === null
        ? null
        : session.readingList.map((group) => ({ ...group, rows: group.rows.map((row) => ({ ...row, item: change(row.item) })) })),
  };
  putSession(world, next);
  return { status: 200, body: { session: next }, queue: { label: 'A mark in the Flow Tracker', coalesce: `flow-done:${itemId}` } };
}

function abandonSession(world: World, sessionId: string): Outcome {
  const session = heldSession(world, sessionId);
  if (session === null) return refuse(NOT_HELD);
  const next: FlowSessionView = session.status === 'in_progress' ? { ...session, status: 'abandoned' } : session;
  putSession(world, next);
  // A session started offline and abandoned offline never reaches the server.
  if (world.isQueuedTemp(sessionId)) return { status: 200, body: { session: next }, cancel: sessionId };
  return { status: 200, body: { session: next }, queue: { label: 'Leaving a Flow Tracker session' } };
}

function deleteSession(world: World, sessionId: string): Outcome {
  const held = sessions(world);
  if (held === null) return refuse(NOT_HELD);
  if (held.active?.id === sessionId) return refuse('A session in progress cannot be removed.', 400, 'invalid_input');
  const payload: FlowSessionsPayload = { ...held, completed: held.completed.filter((one) => one.id !== sessionId) };
  world.write(FLOW_SESSIONS_PATH, payload);
  if (world.isQueuedTemp(sessionId)) return { status: 200, body: payload, cancel: sessionId };
  return { status: 200, body: payload, queue: { label: 'Removing a Flow Tracker session' } };
}

// =================================================================================================
// Notifications, and the speed
// =================================================================================================

function isNotificationList(path: string): boolean {
  return path === NOTIFICATIONS_PATH || path.startsWith(`${NOTIFICATIONS_PATH}?`);
}

function notificationPages(world: World): { path: string; page: NotificationListPayload }[] {
  return world.paths().flatMap((path) => {
    if (!isNotificationList(path)) return [];
    const page = world.read<NotificationListPayload>(path);
    return page !== undefined && Array.isArray(page.notifications) ? [{ path, page }] : [];
  });
}

function markRead(world: World, id: string): Outcome {
  const pages = notificationPages(world);
  let found: NotificationView | null = null;
  for (const { page } of pages) found ??= page.notifications.find((one) => one.id === id) ?? null;
  if (found === null) return refuse(NOT_HELD);
  const wasUnread = found.readAt === null;
  const read: NotificationView = wasUnread ? { ...found, readAt: world.now } : found;
  let unreadCount = 0;
  for (const { path, page } of pages) {
    unreadCount = Math.max(0, page.unreadCount - (wasUnread ? 1 : 0));
    world.write(path, { ...page, unreadCount, notifications: page.notifications.map((one) => (one.id === id ? read : one)) });
  }
  return { status: 200, body: { notification: read, unreadCount }, queue: { label: 'Marking a notification read', coalesce: `notification-read:${id}` } };
}

function markAllRead(world: World): Outcome {
  const pages = notificationPages(world);
  if (pages.length === 0) return refuse(NOT_HELD);
  const marked = pages.find((one) => one.path === NOTIFICATIONS_PATH)?.page.unreadCount ?? pages[0]?.page.unreadCount ?? 0;
  for (const { path, page } of pages) {
    world.write(path, {
      ...page,
      unreadCount: 0,
      notifications: page.notifications.map((one) => (one.readAt === null ? { ...one, readAt: world.now } : one)),
    });
  }
  return { status: 200, body: { marked, unreadCount: 0 }, queue: { label: 'Marking notifications read', coalesce: 'notifications-read-all' } };
}

function setPushPreference(world: World, body: Record<string, unknown>): Outcome {
  const held = world.read<PushPreferencesPayload>(PUSH_PREFERENCES_PATH);
  if (held === undefined) return refuse(NOT_HELD);
  const category = body['category'];
  const pushEnabled = body['pushEnabled'];
  if (typeof category !== 'string' || typeof pushEnabled !== 'boolean' || !held.categories.some((one) => one.category === category)) {
    return refuse('That category is not one your account receives.', 400, 'invalid_input');
  }
  const payload: PushPreferencesPayload = {
    ...held,
    categories: held.categories.map((one) => (one.category === category ? { ...one, pushEnabled } : one)),
  };
  world.write(PUSH_PREFERENCES_PATH, payload);
  return { status: 200, body: payload, queue: { label: 'A notification setting', coalesce: `push-preference:${category}` } };
}

function setSpeed(world: World, body: Record<string, unknown>): Outcome {
  const speed = body['speed'];
  if (typeof speed !== 'number') return refuse('You are offline.');
  world.setSpeed(speed);
  return { status: 200, body: { speed }, queue: { label: 'The playback speed', coalesce: 'playback-speed' } };
}

// =================================================================================================
// The table
// =================================================================================================

const ID = '([^/?]+)';

type Handler = (world: World, match: RegExpExecArray, body: Record<string, unknown>) => Outcome;

const ACTIONS: readonly (readonly [method: string, pattern: RegExp, handler: Handler])[] = [
  ['POST', new RegExp(`^/recordings/${ID}/notes$`), (w, m, b) => reply(w, m[1] as string, b)],
  ['PATCH', new RegExp(`^/notes/${ID}$`), (w, m, b) => editNote(w, m[1] as string, b)],
  ['DELETE', new RegExp(`^/notes/${ID}$`), (w, m) => deleteNote(w, m[1] as string)],
  ['PUT', new RegExp(`^/notes/${ID}/reaction$`), (w, m, b) => (typeof b['emoji'] === 'string' ? react(w, m[1] as string, b['emoji']) : refuse('You are offline.'))],
  ['DELETE', new RegExp(`^/notes/${ID}/reaction$`), (w, m) => react(w, m[1] as string, null)],
  ['PUT', new RegExp(`^/notes/${ID}/folders$`), (w, m, b) => fileNote(w, m[1] as string, b)],
  ['POST', /^\/users\/me\/note-folders$/, (w, _m, b) => createFolder(w, b)],
  ['PATCH', new RegExp(`^/users/me/note-folders/${ID}$`), (w, m, b) => renameFolder(w, m[1] as string, b)],
  ['DELETE', new RegExp(`^/users/me/note-folders/${ID}$`), (w, m) => deleteFolder(w, m[1] as string)],
  ['POST', /^\/users\/me\/highlights$/, (w, _m, b) => addHighlight(w, b)],
  ['DELETE', new RegExp(`^/users/me/highlights/${ID}$`), (w, m) => removeHighlight(w, m[1] as string)],
  ['PUT', new RegExp(`^${PLAYBACK_SPEED_PATH}$`), (w, _m, b) => setSpeed(w, b)],
  ['POST', /^\/sos$/, (w, _m, b) => raiseSignal(w, b)],
  ['POST', new RegExp(`^/sos/${ID}/replies$`), (w, m, b) => replyToSignal(w, m[1] as string, b)],
  ['DELETE', new RegExp(`^/sos/${ID}/replies/${ID}$`), (w, m) => deleteSosReply(w, m[1] as string, m[2] as string)],
  ['PUT', new RegExp(`^/sos/${ID}/praying$`), (w, m, b) => setPraying(w, m[1] as string, true, b)],
  ['DELETE', new RegExp(`^/sos/${ID}/praying$`), (w, m) => setPraying(w, m[1] as string, false, {})],
  ['POST', new RegExp(`^/sos/${ID}/close$`), (w, m, b) => closeSignal(w, m[1] as string, b)],
  // A report changes nothing the member reads; it is kept and sent, and answered as received.
  ['POST', new RegExp(`^/sos/${ID}/report$`), (w) => ({ status: 201, body: { reportId: w.mintId() }, queue: { label: 'A report' } })],
  ['POST', /^\/users\/me\/flow-sessions$/, (w, _m, b) => startSession(w, b)],
  ['PUT', new RegExp(`^/users/me/flow-sessions/${ID}/items/${ID}$`), (w, m, b) => answerItem(w, m[1] as string, m[2] as string, b)],
  ['PUT', new RegExp(`^/users/me/flow-sessions/${ID}/items/${ID}/done$`), (w, m, b) => markItem(w, m[1] as string, m[2] as string, b)],
  ['POST', new RegExp(`^/users/me/flow-sessions/${ID}/abandon$`), (w, m) => abandonSession(w, m[1] as string)],
  ['DELETE', new RegExp(`^/users/me/flow-sessions/${ID}$`), (w, m) => deleteSession(w, m[1] as string)],
  ['PUT', new RegExp(`^/notifications/${ID}/read$`), (w, m) => markRead(w, m[1] as string)],
  ['PUT', /^\/notifications\/read$/, (w) => markAllRead(w)],
  ['PUT', /^\/notifications\/push-preferences$/, (w, _m, b) => setPushPreference(w, b)],
];

/**
 * What an offline write becomes, or `null` when it is not one this device can keep — which leaves
 * the request failing exactly as it did before there was a queue.
 *
 * The one write decided elsewhere is a new top-level note (`offlineNoteWrite`): it predates this
 * table, travels through `/sync`, and is matched before this is asked. A `POST …/notes` reaches
 * here only when it names a parent.
 */
export function offlineAction(method: string, path: string, body: unknown, world: World): Outcome | null {
  const bare = path.split('?')[0] ?? path;
  for (const [verb, pattern, handler] of ACTIONS) {
    if (verb !== method) continue;
    const match = pattern.exec(bare);
    if (match === null) continue;
    return handler(world, match, isRecord(body) ? body : {});
  }
  return null;
}

/**
 * Which `GET`s the device keeps a copy of, to be answered with when the server cannot be reached
 * and changed by the actions above. Everything the screens these actions live on read.
 */
const KEPT_READS: readonly RegExp[] = [
  // A downloaded teaching's transcript: what makes a line of it highlightable with no connection.
  new RegExp(`^/recordings/${ID}/transcript$`),
  /^\/users\/me\/notes$/,
  /^\/users\/me\/note-folders$/,
  /^\/users\/me\/highlights$/,
  /^\/sos(\?.*)?$/,
  new RegExp(`^/sos/${ID}$`),
  /^\/flow-tracker\/teachings$/,
  /^\/flow-tracker\/questions$/,
  /^\/users\/me\/flow-sessions$/,
  new RegExp(`^/users/me/flow-sessions/${ID}$`),
  /^\/notifications(\?.*)?$/,
  /^\/notifications\/push-preferences$/,
];

export function isKeptRead(path: string): boolean {
  return KEPT_READS.some((pattern) => pattern.test(path));
}
