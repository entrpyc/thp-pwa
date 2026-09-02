'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  recordingChaptersPath,
  recordingNotesPath,
  type ChapterView,
  type ChaptersPayload,
  type NoteView,
  type NotesPayload,
  type RecordingView as Recording,
} from '@thp/shared';
import { apiFetch } from '@/client/api-client';
import { usePlayer, type LoadedRecording, type PlayerApi } from '../../player-context';

/**
 * **What a recording page's panels read** — the notes, the chapters, the moment a note anchors to
 * and the two ways of going to a moment — behind one interface, whichever teaching the player holds.
 *
 * The panels used to read all of this straight off the player, which holds it for **the teaching
 * being heard** and nothing else. That was right for as long as opening a page meant loading its
 * teaching into the transport. It stopped being right when arriving on a page stopped silencing
 * what a member was already hearing (`openIfIdle`): a member listening to one teaching who opened
 * another found its notes and chapters withheld behind "press play to switch", because panels drawn
 * off the player would have shown the *playing* teaching's notes under the *opened* teaching's title.
 *
 * So the page decides where its content comes from, once, here:
 *
 * - **When the player holds this teaching**, the content is the player's. Same lists the transport
 *   draws its markers and its chapter line from, same anchor the transport's own composer sheet
 *   reads, same seek — nothing is fetched twice and nothing can disagree.
 * - **When it holds a different one**, the page fetches this teaching's notes and chapters itself
 *   and keeps them for as long as it is on screen. Reading a teaching's notes has never needed
 *   sound; only the player's *store* did.
 *
 * What changes with the source is spelled out on each member below, and the rule under all of it is
 * the one the play control already follows: **nothing here starts sound the member did not ask
 * for.** Going to a moment in a teaching the player does not hold loads that teaching *at* the moment
 * — paused, exactly as opening its page would — and only the row's own play control plays it.
 */
export interface RecordingContent {
  readonly recordingId: string;
  /** Whether the player holds this teaching. `false` while a member is hearing another one. */
  readonly current: boolean;
  /** This teaching's notes, or `null` while the first fetch is in flight or after it failed. */
  readonly notes: readonly NoteView[] | null;
  /** Whether the last notes fetch for this teaching failed. Drives the panel's retry. */
  readonly notesFailed: boolean;
  /** This teaching's chapters, or `null` while unknown. Empty for a teaching that has none. */
  readonly chapters: readonly ChapterView[] | null;
  /**
   * Where this teaching **is**: the player's position when it holds the teaching, and the member's
   * stored position when it does not — the moment the play control would start from, and so the
   * moment a note written now is about.
   */
  readonly positionMs: number;
  /** The moment a note being written is anchored to, or `null` while it still follows `positionMs`. */
  readonly composerAnchorMs: number | null;
  /** Read this teaching's notes again — after a write, or after a failure the member retried. */
  refreshNotes(): void;
  /** Put a rewritten chapter list back, after an admin edited one. The whole list, never one row. */
  replaceChapters(chapters: readonly ChapterView[]): void;
  /**
   * Go to a moment **without sound**. On the loaded teaching this is a seek; on any other it loads
   * that teaching at the moment, paused, so a member who pressed a timestamp in the notes lands where
   * the note was written and decides about sound themselves.
   */
  seekToMs(ms: number): void;
  /** Go to a moment **and play** — a chapter row's play control. Loads the teaching first if it must. */
  playFromMs(ms: number): void;
  /** Fix the composer's moment where the teaching is now, unless it is already fixed. */
  lockComposerAnchor(): void;
  /** Let the composer's moment follow the teaching again. */
  releaseComposerAnchor(): void;
}

const RecordingContentContext = createContext<RecordingContent | null>(null);

export const RecordingContentProvider = RecordingContentContext.Provider;

/** What the transport carries for a teaching, read off the page's payload. */
export function toLoaded(recording: Recording): LoadedRecording {
  return {
    id: recording.id,
    title: recording.title,
    // The transport's tile is the series' cover, handed over with the teaching rather than fetched
    // by the bar — the page is the one place that knows both (scope prd 3.2.4).
    artworkUrl: recording.series?.artworkUrl ?? null,
    seriesTitle: recording.series?.title ?? null,
  };
}

/**
 * The player's own content, for **the loaded teaching**.
 *
 * What a panel reads when no page has said otherwise — the transport's composer sheet, which is
 * always about the teaching being heard. `current` is true by construction.
 */
function fromPlayer(player: PlayerApi): RecordingContent {
  const loadedId = player.loaded?.id ?? '';
  return {
    recordingId: loadedId,
    current: true,
    notes: player.notes?.notes ?? null,
    notesFailed: player.notesFailed,
    chapters: player.chapters?.chapters ?? null,
    positionMs: player.currentMs,
    composerAnchorMs: player.composerAnchorMs,
    refreshNotes: player.refreshNotes,
    replaceChapters: (chapters) => player.replaceChapters(loadedId, chapters),
    seekToMs: player.seekToMs,
    playFromMs: player.playFromMs,
    lockComposerAnchor: player.lockComposerAnchor,
    releaseComposerAnchor: player.releaseComposerAnchor,
  };
}

/**
 * The content a panel reads: the page's, when a page has provided one, and the player's otherwise.
 */
export function useRecordingContent(): RecordingContent {
  const provided = useContext(RecordingContentContext);
  const player = usePlayer();
  const own = useMemo(() => fromPlayer(player), [player]);
  return provided ?? own;
}

/** A fetched list, tagged with the teaching it answers for so a late answer cannot be misread. */
interface Held<T> {
  readonly recordingId: string;
  readonly list: readonly T[];
}

/**
 * **A page's content for one teaching** — the player's while the player holds it, and the page's
 * own fetch while it does not.
 *
 * `recording` is `null` until the page's payload has landed, and nothing is fetched before then:
 * the page opens the teaching into the transport at that same moment when it can (`openIfIdle`),
 * and whether it could is what decides whether this hook has anything to fetch at all.
 *
 * `startAtMs` is the member's stored position on this teaching, which is `positionMs` while the
 * player holds something else: it is where pressing play would start, so it is the moment a note
 * written on this page is about.
 */
export function useRecordingContentFor(
  recordingId: string,
  recording: Recording | null,
  startAtMs: number | null,
): RecordingContent {
  const player = usePlayer();
  const current = player.loaded?.id === recordingId;

  const [heldNotes, setHeldNotes] = useState<Held<NoteView> | null>(null);
  /** The teaching whose last notes fetch failed, so a failure on one cannot show on the next. */
  const [notesFailedFor, setNotesFailedFor] = useState<string | null>(null);
  const [heldChapters, setHeldChapters] = useState<Held<ChapterView> | null>(null);
  const [anchorMs, setAnchorMs] = useState<number | null>(null);

  /**
   * The teaching this hook is about **right now**, for the fetches to check their answer against.
   * A ref because the answer lands after any number of renders, and a page walked from one teaching
   * to the next keeps this hook mounted — the previous teaching's late answer must not become the
   * next one's list, which is the guard every fetch in the player takes for the same reason.
   */
  const activeId = useRef(recordingId);
  activeId.current = recordingId;

  const readNotes = useCallback((id: string): void => {
    setNotesFailedFor((held) => (held === id ? null : held));
    void apiFetch<NotesPayload>(recordingNotesPath(id), { credentials: 'include' })
      .then((payload) => {
        if (activeId.current !== id) return;
        setHeldNotes({ recordingId: id, list: payload.notes });
      })
      .catch(() => {
        if (activeId.current !== id) return;
        // Cleared rather than left stale, as the player clears its own: a failure shows as a
        // failure, not as the previous answer wearing this teaching's name.
        setHeldNotes(null);
        setNotesFailedFor(id);
      });
  }, []);

  const readChapters = useCallback((id: string): void => {
    void apiFetch<ChaptersPayload>(recordingChaptersPath(id), { credentials: 'include' })
      .then((payload) => {
        if (activeId.current !== id) return;
        setHeldChapters({ recordingId: id, list: payload.chapters });
      })
      .catch(() => {
        if (activeId.current !== id) return;
        setHeldChapters(null);
      });
  }, []);

  /*
   * Fetch only when there is something to fetch for: the teaching is known, and the player does not
   * hold it. When the player takes it over — the play control, a timestamp — the player fetches
   * both lists itself and this hook's copies simply stop being read.
   */
  useEffect(() => {
    if (recording === null || current) return;
    readNotes(recordingId);
    readChapters(recordingId);
  }, [current, readChapters, readNotes, recording, recordingId]);

  // The moment a note is about, when the player holds something else: where play would start.
  const storedMs = startAtMs ?? 0;
  const loaded = useMemo(() => (recording === null ? null : toLoaded(recording)), [recording]);

  const refreshNotes = useCallback((): void => readNotes(recordingId), [readNotes, recordingId]);
  const replaceChapters = useCallback(
    (chapters: readonly ChapterView[]): void => setHeldChapters({ recordingId, list: chapters }),
    [recordingId],
  );
  const { open, openAndPlay } = player;
  const seekToMs = useCallback(
    (ms: number): void => {
      if (loaded !== null) open(loaded, ms);
    },
    [loaded, open],
  );
  const playFromMs = useCallback(
    (ms: number): void => {
      if (loaded !== null) openAndPlay(loaded, ms);
    },
    [loaded, openAndPlay],
  );
  const lockComposerAnchor = useCallback((): void => {
    setAnchorMs((held) => held ?? storedMs);
  }, [storedMs]);
  const releaseComposerAnchor = useCallback((): void => setAnchorMs(null), []);

  return useMemo<RecordingContent>(() => {
    if (current) return fromPlayer(player);
    return {
      recordingId,
      current: false,
      notes: heldNotes?.recordingId === recordingId ? heldNotes.list : null,
      notesFailed: notesFailedFor === recordingId,
      chapters: heldChapters?.recordingId === recordingId ? heldChapters.list : null,
      positionMs: storedMs,
      composerAnchorMs: anchorMs,
      refreshNotes,
      replaceChapters,
      seekToMs,
      playFromMs,
      lockComposerAnchor,
      releaseComposerAnchor,
    };
  }, [
    anchorMs,
    current,
    heldChapters,
    heldNotes,
    lockComposerAnchor,
    notesFailedFor,
    playFromMs,
    player,
    recordingId,
    refreshNotes,
    releaseComposerAnchor,
    replaceChapters,
    seekToMs,
    storedMs,
  ]);
}
