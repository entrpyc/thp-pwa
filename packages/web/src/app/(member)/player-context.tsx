'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  PLAYBACK_SPEED_PATH,
  nextPlaybackSpeed,
  recordingNotesPath,
  recordingPlaybackPath,
  recordingProgressPath,
  recordingTranscriptPath,
  type NoteView,
  type NotesPayload,
  type PlaybackGrantPayload,
  type TranscriptPayload,
  type TranscriptSegmentView,
} from '@thp/shared';
import { apiFetch } from '@/client/api-client';
import { shouldRenewGrant } from '@/client/playback/renewal';
import { shouldWriteProgress, type ProgressEventKind } from '@/client/playback/cadence';

/**
 * **The player, mounted once for the whole member surface.**
 *
 * The `<audio>` element and every piece of transport state live here rather than on the recording
 * page, and that is the one decision in this story that is expensive to walk back. Three things
 * force it: `bottom-navigation/default.png` is a **docked bar** with its own title slot, which only
 * makes sense app-wide; `pages/dashboard.png`'s *Resume recording* card assumes a member leaves the
 * recording page and comes back; and Story 5's caption pill floats above this same bar. Mounting
 * the element on the recording page would be smaller today and would mean moving the element, its
 * transport state, its speed and its progress timer in Story 5.
 *
 * What the provider owns, and why each is here rather than in a component:
 *
 * - **The grant, and replacing it.** A signed URL lasts an hour and a teaching can run to ninety
 *   minutes, so renewal is the ordinary path. Position and play state are captured before the swap
 *   and restored after it, so a member hears nothing.
 * - **The speed.** Applied to the element the moment it changes and pushed to the account
 *   afterwards, so the control answers instantly and the next teaching starts at the same rate.
 * - **The position, and how often it is pushed.** The *decision* is
 *   {@link shouldWriteProgress} — a pure function — so the cadence is assertable without a clock;
 *   this file is only the wiring that calls it.
 * - **The transcript, and whether captions are on** (Story 5). Here rather than on the recording
 *   page because the caption pill **outlives that page**: a member who turns captions on and walks
 *   back to the library keeps seeing the current line, and a transcript owned by the page would
 *   have gone with it. Fetched on first need — the tab mounted, or captions turned on — so a member
 *   who does neither downloads nothing, and cleared when a different teaching is opened so the pill
 *   can never caption the wrong one.
 * - **The notes, and the composer's frozen anchor** (the notes scope). Here for the same reason the
 *   transcript is, and one stronger: the note markers render on the docked transport wherever it
 *   travels (active-scope prd 3.2.7), and the composer is reachable from the transport's own menu
 *   (3.1.2) — notes owned by the recording page would go with that page. **Fetched when the
 *   recording is opened** rather than when the tab is, because the markers are visible without the
 *   tab ever being pressed.
 *
 * **Opening a recording never plays it.** A member who opens a teaching on a phone in company has
 * not asked for sound. The page loads the media, restores the stored position once metadata has
 * arrived, and waits.
 */

export interface LoadedRecording {
  readonly id: string;
  readonly title: string;
}

/**
 * The loaded teaching's transcript, once something has asked for it.
 *
 * `segments` is empty for a published teaching that has none — an answer, not a failure, and what
 * the tab's empty state renders from.
 */
export interface LoadedTranscript {
  readonly recordingId: string;
  readonly segments: readonly TranscriptSegmentView[];
}

/**
 * The loaded teaching's notes, as this member may see them.
 *
 * Empty is an answer rather than a failure — a teaching nobody has annotated — which is why the
 * failure is a separate flag and not `null` doing double duty.
 */
export interface LoadedNotes {
  readonly recordingId: string;
  readonly notes: readonly NoteView[];
}

export interface PlayerApi {
  readonly loaded: LoadedRecording | null;
  readonly playing: boolean;
  readonly currentMs: number;
  /** `0` until the element has told us; nothing stores a duration, so this is the only source. */
  readonly durationMs: number;
  readonly speed: number;
  /** The loaded teaching's transcript, or `null` until something has needed it. */
  readonly transcript: LoadedTranscript | null;
  /** Whether the caption pill is showing. Off by default, and session state — never written to `user`. */
  readonly captionsOn: boolean;
  /** The loaded teaching's notes, or `null` while the first fetch is in flight or after it failed. */
  readonly notes: LoadedNotes | null;
  /** Whether the last notes fetch for the loaded teaching failed. Drives 5.2.7's retry. */
  readonly notesFailed: boolean;
  /**
   * The position the composer is anchored to, **frozen when it opened**, or `null` while it is
   * closed (active-scope prd 3.1.1).
   *
   * Held here rather than by the panel because 3.1.2's second entry point is the transport, which
   * outlives the recording page — two entry points reading one anchor cannot disagree about which
   * moment is being annotated.
   */
  readonly composerAnchorMs: number | null;
  /**
   * The note the member has just asked to be taken to, or `null` — the channel a transport marker
   * reaches the Notes tab through (active-scope prd 3.2.5).
   *
   * Here for the same reason the notes are: the marker that sets it lives on the docked transport,
   * which the member layout mounts, and the tab that reacts to it is on the recording page. They
   * have no other common owner, and the alternative — a note id in the address bar — would put an
   * internal identifier in front of the member and still do nothing when they are on another screen.
   *
   * It is a **request, not a selection**: the panel clears it once it has scrolled, so pressing the
   * same marker twice takes the member there twice.
   */
  readonly revealedNoteId: string | null;
  /** Load a teaching and seek to `startAtMs`, without playing. Re-opening the current one is a no-op. */
  open(recording: LoadedRecording, startAtMs: number | null): void;
  toggle(): void;
  seekToMs(ms: number): void;
  skipMs(deltaMs: number): void;
  cycleSpeed(): void;
  /** Fetch the transcript if nothing has yet. Safe to call on every mount — it asks once. */
  requestTranscript(): void;
  setCaptions(on: boolean): void;
  /** Put a corrected line back in the loaded transcript, so the list and the pill agree with it. */
  applyCorrection(segment: TranscriptSegmentView): void;
  /** Read the loaded teaching's notes again — after a write, or after a failure the member retried. */
  refreshNotes(): void;
  /** Freeze the anchor at the position the player holds right now, and open the composer. */
  openComposer(): void;
  closeComposer(): void;
  /** Ask whichever screen is showing the notes to scroll to this one and mark it. */
  revealNote(noteId: string): void;
  /** Said by the screen that has done it, so the next press is a fresh request. */
  clearRevealedNote(): void;
}

const PlayerContext = createContext<PlayerApi | null>(null);

/**
 * **The breadcrumb trail** — set by whichever page has one, cleared when it unmounts.
 *
 * Widened in Story 6 from a single current title to an **optional parent plus a current**, which is
 * the shape `top-navigation/default.png` has always drawn: a recording in a series reads
 * `home › series › recording`, and the parent is a link because getting back to the series in one
 * press is the whole point of the segment. A recording in no series keeps today's two-segment
 * trail, so nothing about the library or the landing changed.
 */
export interface BreadcrumbParent {
  readonly label: string;
  readonly href: string;
}

export interface BreadcrumbTrail {
  readonly parent: BreadcrumbParent | null;
  readonly current: string | null;
}

const EMPTY_TRAIL: BreadcrumbTrail = { parent: null, current: null };

const BreadcrumbContext = createContext<{
  readonly trail: BreadcrumbTrail;
  setTrail(trail: BreadcrumbTrail): void;
} | null>(null);

export function usePlayer(): PlayerApi {
  const value = useContext(PlayerContext);
  if (value === null) throw new Error('usePlayer used outside the member layout');
  return value;
}

/**
 * Name this page in the breadcrumb for as long as it is mounted.
 *
 * `parentLabel` and `parentHref` are passed apart rather than as an object so the effect's
 * dependencies are the two strings themselves — an object literal rebuilt on every render would
 * re-run the effect on every render and clear the trail it had just set.
 */
export function useBreadcrumbTrail(
  current: string | null,
  parentLabel: string | null = null,
  parentHref: string | null = null,
): void {
  const context = useContext(BreadcrumbContext);
  const setTrail = context?.setTrail;
  useEffect(() => {
    setTrail?.({
      parent:
        parentLabel === null || parentHref === null
          ? null
          : { label: parentLabel, href: parentHref },
      current,
    });
    return () => setTrail?.(EMPTY_TRAIL);
  }, [setTrail, current, parentLabel, parentHref]);
}

export function useBreadcrumbTrailValue(): BreadcrumbTrail {
  return useContext(BreadcrumbContext)?.trail ?? EMPTY_TRAIL;
}

/** How often the near-expiry check runs. Cheap — it compares two numbers. */
const RENEWAL_CHECK_MS = 15_000;

export function PlayerProvider({
  initialSpeed,
  children,
}: {
  initialSpeed: number;
  children: ReactNode;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);

  const [loaded, setLoaded] = useState<LoadedRecording | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [speed, setSpeed] = useState(initialSpeed);
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbTrail>(EMPTY_TRAIL);
  const [transcript, setTranscript] = useState<LoadedTranscript | null>(null);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [notes, setNotes] = useState<LoadedNotes | null>(null);
  const [notesFailed, setNotesFailed] = useState(false);
  const [composerAnchorMs, setComposerAnchorMs] = useState<number | null>(null);
  const [revealedNoteId, setRevealedNoteId] = useState<string | null>(null);

  /** The live grant. A ref because the renewal ticker reads it without re-subscribing. */
  const grant = useRef<PlaybackGrantPayload | null>(null);
  /** Where to seek once metadata arrives — a resume position, or a position being restored. */
  const seekOnLoad = useRef<number | null>(null);
  /** Whether to resume playing once metadata arrives, after a grant swap mid-listen. */
  const playOnLoad = useRef(false);
  const loadedRef = useRef<LoadedRecording | null>(null);
  const speedRef = useRef(initialSpeed);
  const lastWriteAt = useRef<number | null>(null);
  /** Guards a renewal already in flight, so an error storm makes one request rather than many. */
  const renewing = useRef(false);
  /**
   * The last position the element reported **while it had a source it could read**.
   *
   * Kept beside the element rather than read off it at renewal time, and that is not bookkeeping
   * for its own sake: pointing a media element at a new source resets `currentTime` to zero and a
   * source that has *failed* has already been reset by the time `error` fires. Reading the element
   * then would restore a member to the beginning of a teaching they were forty minutes into.
   */
  const positionRef = useRef(0);
  /**
   * Whether the **member** wants sound — not whether the element is currently producing it.
   *
   * The two diverge exactly when it matters: swapping the source pauses the element, so the element
   * always reads "paused" during a renewal. This follows the presses instead, which is what makes
   * "in the same play state" mean the state the member chose.
   */
  const wantsPlay = useRef(false);
  /**
   * The recording whose transcript has been asked for.
   *
   * A ref rather than derived from `transcript`, because it has to be set the moment the request
   * goes out rather than when it comes back — the tab mounting and captions being turned on in the
   * same second are two callers, and they must produce one request.
   */
  const transcriptAskedFor = useRef<string | null>(null);

  const pointAt = useCallback(async (recordingId: string): Promise<void> => {
    const element = audioRef.current;
    if (element === null) return;
    const minted = await apiFetch<PlaybackGrantPayload>(recordingPlaybackPath(recordingId), {
      credentials: 'include',
    });
    grant.current = minted;
    element.src = minted.url;
    element.load();
  }, []);

  /**
   * Read a teaching's notes into the store.
   *
   * **It cannot reach playback.** No `audioRef`, no grant, no ticker — a notes failure leaves the
   * store empty and the track marker-less, which is 3.2.11 and the Availability NFR, and is the
   * whole reason this is a separate request rather than part of the one that points the element.
   *
   * The late-answer guard is the transcript fetch's, for the same reason: a slow answer about the
   * previous teaching must not become the current one's list.
   */
  const loadNotes = useCallback((recordingId: string): void => {
    setNotesFailed(false);
    void apiFetch<NotesPayload>(recordingNotesPath(recordingId), { credentials: 'include' })
      .then((payload) => {
        if (loadedRef.current?.id !== recordingId) return;
        setNotes({ recordingId, notes: payload.notes });
      })
      .catch(() => {
        if (loadedRef.current?.id !== recordingId) return;
        // Cleared rather than left stale: 3.2.11 wants no markers over a failure, not the previous
        // answer wearing this teaching's name.
        setNotes(null);
        setNotesFailed(true);
      });
  }, []);

  const open = useCallback(
    (recording: LoadedRecording, startAtMs: number | null): void => {
      // Re-opening what is already loaded is what makes playback survive navigating away and back:
      // returning to a teaching that is playing must not re-point the element at a fresh grant.
      if (loadedRef.current?.id === recording.id) return;
      loadedRef.current = recording;
      setLoaded(recording);
      setCurrentMs(startAtMs ?? 0);
      setDurationMs(0);
      lastWriteAt.current = null;
      positionRef.current = startAtMs ?? 0;
      wantsPlay.current = false;
      seekOnLoad.current = startAtMs;
      playOnLoad.current = false;
      // A different teaching: the transcript in hand describes the previous one, so the pill would
      // caption the wrong words until a new one arrived.
      transcriptAskedFor.current = null;
      setTranscript(null);
      // The same argument as the transcript, and one more: the anchor a composer left open on the
      // previous teaching would point at a moment in a recording nobody is listening to.
      setNotes(null);
      setComposerAnchorMs(null);
      // A note id from the previous teaching names nothing in this one's list.
      setRevealedNoteId(null);
      // Fetched **on open rather than on tab open**, because the markers (3.2.4) are visible on the
      // transport without the Notes tab ever being pressed.
      loadNotes(recording.id);
      void pointAt(recording.id).catch(() => {
        // Nothing to say on screen: the bar is a transport, not an error surface. The play control
        // simply does nothing until a grant arrives, and the next renewal tick tries again.
      });
    },
    [loadNotes, pointAt],
  );

  /**
   * Replace the grant under a listen in progress, keeping the member where they were.
   *
   * Position and play state are read off the element *before* the source changes, because setting
   * `src` resets both — and restored on the other side, which is the whole of "without the member
   * noticing".
   */
  const renew = useCallback(async (): Promise<void> => {
    const element = audioRef.current;
    const recording = loadedRef.current;
    if (element === null || recording === null || renewing.current) return;
    renewing.current = true;
    try {
      seekOnLoad.current = positionRef.current;
      playOnLoad.current = wantsPlay.current;
      await pointAt(recording.id);
    } catch {
      // Keep the captured position: the next tick will try again with it still in hand.
    } finally {
      renewing.current = false;
    }
  }, [pointAt]);

  /** Push the position, if this event and this moment call for one. */
  const pushProgress = useCallback((event: ProgressEventKind): void => {
    const element = audioRef.current;
    const recording = loadedRef.current;
    if (element === null || recording === null) return;

    const positionMs = Math.round(element.currentTime * 1000);
    const now = Date.now();
    if (!shouldWriteProgress({ event, positionMs, lastWriteAt: lastWriteAt.current, now })) return;

    lastWriteAt.current = now;
    void apiFetch(recordingProgressPath(recording.id), {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ positionMs }),
    }).catch(() => {
      // A dropped position costs the member a few seconds of re-listening. Retrying it would be
      // the outbox [§3.18](docs/project/prd.md) defers, so it is dropped deliberately.
    });
  }, []);

  // The element's events, bound once. Everything the transport renders is read from here rather
  // than tracked in parallel, so the bar cannot disagree with what is actually playing.
  useEffect(() => {
    const element = audioRef.current;
    if (element === null) return;

    const onLoadedMetadata = () => {
      element.playbackRate = speedRef.current;
      setDurationMs(Number.isFinite(element.duration) ? Math.round(element.duration * 1000) : 0);
      // Seeking before metadata has loaded is silently clamped to zero, which is why the resume
      // position waits for this event rather than being applied when the page mounts.
      const target = seekOnLoad.current;
      if (target !== null) {
        element.currentTime = target / 1000;
        seekOnLoad.current = null;
      }
      if (playOnLoad.current) {
        playOnLoad.current = false;
        void element.play().catch(() => undefined);
      }
    };
    // `readyState === HAVE_NOTHING` is the element after a source has been swapped or has failed;
    // its `currentTime` is zero and means nothing, so it is not recorded as a position.
    const remember = () => {
      if (element.readyState >= 1) positionRef.current = Math.round(element.currentTime * 1000);
    };
    const onTimeUpdate = () => {
      remember();
      setCurrentMs(Math.round(element.currentTime * 1000));
      pushProgress('tick');
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      pushProgress('pause');
    };
    const onSeeked = () => {
      remember();
      setCurrentMs(Math.round(element.currentTime * 1000));
      pushProgress('seek');
    };
    // The definite signal that a grant has died — including for a reason the clock cannot know.
    const onError = () => void renew();

    element.addEventListener('loadedmetadata', onLoadedMetadata);
    element.addEventListener('timeupdate', onTimeUpdate);
    element.addEventListener('play', onPlay);
    element.addEventListener('pause', onPause);
    element.addEventListener('seeked', onSeeked);
    element.addEventListener('error', onError);
    return () => {
      element.removeEventListener('loadedmetadata', onLoadedMetadata);
      element.removeEventListener('timeupdate', onTimeUpdate);
      element.removeEventListener('play', onPlay);
      element.removeEventListener('pause', onPause);
      element.removeEventListener('seeked', onSeeked);
      element.removeEventListener('error', onError);
    };
  }, [pushProgress, renew]);

  // The tab going away is the last moment anything is guaranteed to run, and on a phone it is
  // usually the end of the sitting.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') pushProgress('hide');
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [pushProgress]);

  // The pre-emptive half of renewal, so the member does not hear the gap the error path costs.
  useEffect(() => {
    const timer = setInterval(() => {
      const held = grant.current;
      if (held === null || loadedRef.current === null) return;
      if (shouldRenewGrant({ expiresAt: held.expiresAt, now: Date.now() })) void renew();
    }, RENEWAL_CHECK_MS);
    return () => clearInterval(timer);
  }, [renew]);

  const toggle = useCallback((): void => {
    const element = audioRef.current;
    if (element === null || element.src === '') return;
    // The press is what sets the intent, which is what a renewal restores.
    wantsPlay.current = element.paused;
    if (element.paused) void element.play().catch(() => undefined);
    else element.pause();
  }, []);

  const seekToMs = useCallback((ms: number): void => {
    const element = audioRef.current;
    if (element === null) return;
    const next = Math.max(0, ms);
    element.currentTime = next / 1000;
    positionRef.current = next;
    setCurrentMs(next);
  }, []);

  const skipMs = useCallback((deltaMs: number): void => {
    const element = audioRef.current;
    if (element === null) return;
    const next = Math.max(0, element.currentTime * 1000 + deltaMs);
    element.currentTime = next / 1000;
    positionRef.current = Math.round(next);
    setCurrentMs(Math.round(next));
  }, []);

  /**
   * Next step, applied to the element first and written to the account afterwards.
   *
   * Optimistic on purpose: the rate a member hears must change on the press, and the write is what
   * makes the *next* teaching start there. A failed write costs the persistence, not the press.
   */
  const cycleSpeed = useCallback((): void => {
    const next = nextPlaybackSpeed(speedRef.current);
    speedRef.current = next;
    setSpeed(next);
    if (audioRef.current !== null) audioRef.current.playbackRate = next;
    void apiFetch(PLAYBACK_SPEED_PATH, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ speed: next }),
    }).catch(() => undefined);
  }, []);

  /**
   * Fetch the loaded teaching's transcript, once.
   *
   * Both callers — the tab mounting and captions being turned on — call this unconditionally, and
   * the ref is what turns "whoever needs it first" into one request. A failure leaves it unasked
   * so the next mount tries again; there is nothing to say on screen, because a transcript that did
   * not arrive is a tab with nothing in it rather than a broken player.
   */
  const requestTranscript = useCallback((): void => {
    const recording = loadedRef.current;
    if (recording === null || transcriptAskedFor.current === recording.id) return;
    transcriptAskedFor.current = recording.id;

    void apiFetch<TranscriptPayload>(recordingTranscriptPath(recording.id), {
      credentials: 'include',
    })
      .then((payload) => {
        // The teaching may have changed while this was in flight; a late answer about the previous
        // one must not become the pill's words.
        if (loadedRef.current?.id !== recording.id) return;
        setTranscript({
          recordingId: recording.id,
          segments: payload.transcript?.segments ?? [],
        });
      })
      .catch(() => {
        if (transcriptAskedFor.current === recording.id) transcriptAskedFor.current = null;
      });
  }, []);

  const setCaptions = useCallback(
    (on: boolean): void => {
      setCaptionsOn(on);
      if (on) requestTranscript();
    },
    [requestTranscript],
  );

  const applyCorrection = useCallback((corrected: TranscriptSegmentView): void => {
    setTranscript((held) =>
      held === null
        ? held
        : {
            ...held,
            // Replaced in place rather than re-sorted: the neighbour rule the API enforces means a
            // correction can never move a line past the one beside it, so the order still holds.
            segments: held.segments.map((one) => (one.id === corrected.id ? corrected : one)),
          },
    );
  }, []);

  const refreshNotes = useCallback((): void => {
    const recording = loadedRef.current;
    if (recording === null) return;
    loadNotes(recording.id);
  }, [loadNotes]);

  /**
   * Freeze the anchor at the position the player holds **now**.
   *
   * `positionRef` rather than the `currentMs` state, because it is the position that is right
   * before anything has played: `open()` seeds it with the restored resume position, so a note
   * written on a teaching that has never been played anchors there rather than at `00:00`
   * (active-scope prd 3.1.3).
   *
   * **Nothing here touches the element.** Opening the composer neither pauses nor moves playback
   * (3.1.2 of the composer's own rules, 3.1.1's second sentence) — the freeze is what stops the
   * moment drifting while the note is typed, not a pause.
   */
  const openComposer = useCallback((): void => {
    setComposerAnchorMs(positionRef.current);
  }, []);

  const closeComposer = useCallback((): void => {
    setComposerAnchorMs(null);
  }, []);

  const revealNote = useCallback((noteId: string): void => {
    setRevealedNoteId(noteId);
  }, []);

  const clearRevealedNote = useCallback((): void => {
    setRevealedNoteId(null);
  }, []);

  const player = useMemo<PlayerApi>(
    () => ({
      loaded,
      playing,
      currentMs,
      durationMs,
      speed,
      transcript,
      captionsOn,
      notes,
      notesFailed,
      composerAnchorMs,
      revealedNoteId,
      open,
      toggle,
      seekToMs,
      skipMs,
      cycleSpeed,
      requestTranscript,
      setCaptions,
      applyCorrection,
      refreshNotes,
      openComposer,
      closeComposer,
      revealNote,
      clearRevealedNote,
    }),
    [
      loaded,
      playing,
      currentMs,
      durationMs,
      speed,
      transcript,
      captionsOn,
      notes,
      notesFailed,
      composerAnchorMs,
      revealedNoteId,
      open,
      toggle,
      seekToMs,
      skipMs,
      cycleSpeed,
      requestTranscript,
      setCaptions,
      applyCorrection,
      refreshNotes,
      openComposer,
      closeComposer,
      revealNote,
      clearRevealedNote,
    ],
  );

  const crumb = useMemo(
    () => ({ trail: breadcrumb, setTrail: setBreadcrumb }),
    [breadcrumb],
  );

  return (
    <BreadcrumbContext.Provider value={crumb}>
      <PlayerContext.Provider value={player}>
        {children}
        {/*
          Always mounted, never controls. The transport bar is the controls, and a second set of
          native ones would be a second answer to what is playing. `preload="metadata"` is what lets
          a resume position be restored — and what keeps a seek to an unbuffered position a genuine
          range request to the object store rather than a read out of a file already downloaded.
        */}
        <audio ref={audioRef} preload="metadata" aria-label="Teaching audio" />
      </PlayerContext.Provider>
    </BreadcrumbContext.Provider>
  );
}
