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
import { usePathname } from 'next/navigation';
import {
  PLAYBACK_SPEED_PATH,
  RESUME_PATH,
  chapterAt,
  isPlaybackSpeed,
  isRecordingPagePath,
  nextPlaybackSpeed,
  recordingChaptersPath,
  recordingNotesPath,
  recordingPlaybackPath,
  recordingProgressPath,
  recordingTranscriptPath,
  type ChapterView,
  type ChaptersPayload,
  type NoteView,
  type NotesPayload,
  type PlaybackGrantPayload,
  type ResumePayload,
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
  /**
   * The cover of the series this teaching is in, for the transport's tile (scope prd 3.2.4), or
   * `null` when there is none to show — no series, or a series with no cover.
   *
   * **Carried on the loaded teaching rather than fetched by the bar.** The transport is mounted in
   * the member layout and never remounts, so a fetch of its own would be a second answer to a
   * question the recording payload has already answered — and it would have to be re-asked on every
   * navigation the bar survives. What `open` is handed is what the slot shows until it is opened
   * again.
   */
  readonly artworkUrl: string | null;
  /** The series' title, which is what labels the tile — it stands alone (scope prd 4.3). */
  readonly seriesTitle: string | null;
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

/**
 * The loaded teaching's chapters ([3.22](docs/project/prd.md)).
 *
 * **Fetched when the teaching is opened**, like the notes and unlike the transcript, and for a
 * stronger version of the same reason (project tdd 5.9): the transport names the chapter playing on
 * every member screen ([3.22.16](docs/project/prd.md)) and draws its boundaries on the track
 * ([3.22.17](docs/project/prd.md)), so the client needs the whole list wherever the member is —
 * not only when a tab is open. "Which chapter is playing" is then arithmetic over a handful of
 * offsets on each tick rather than a request.
 *
 * `chapters` is empty for a teaching too short to hold two ([3.22.4](docs/project/prd.md)), which is
 * an answer rather than a failure — and the one every surface reads as *draw no chapters here*.
 */
export interface LoadedChapters {
  readonly recordingId: string;
  readonly chapters: readonly ChapterView[];
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
   * The loaded teaching's chapters, or `null` while the first fetch is in flight or after it failed
   * ([3.22](docs/project/prd.md)).
   *
   * `null` and an empty list are deliberately different: `null` is *we do not know yet*, and an
   * empty list is *this teaching has none* ([3.22.4](docs/project/prd.md)). Every surface draws
   * nothing for either, which is why there is no `chaptersFailed` beside the notes' flag — a
   * teaching with no chapters and a chapter fetch that failed look identical to a member and
   * neither is worth a retry control, where a note that did not arrive is a marker the member knows
   * should be there.
   */
  readonly chapters: LoadedChapters | null;
  /**
   * **The chapter playing now** ([3.22.16](docs/project/prd.md)), or `null`.
   *
   * Derived here rather than by each surface, because three of them read it — the transport's second
   * line, the now-playing view and the scrubber — and three derivations of one arithmetic is three
   * chances to disagree about which chapter a boundary belongs to.
   *
   * `null` on a teaching with no chapters, and for the seconds before the first chapter's start on a
   * teaching whose transcript begins after a moment of silence. Both draw nothing rather than
   * guessing at the first chapter.
   */
  readonly currentChapter: ChapterView | null;
  /**
   * The moment a note being written is anchored to — **or `null` while it is still following
   * playback** (active-scope prd 3.1.1).
   *
   * A composer opens *armed*: the moment it shows is wherever the player is, and it moves with the
   * teaching, because a member who opened the tab ten minutes ago has not decided anything yet. The
   * **first keystroke** is the decision, and it locks the moment here — so a note about a sentence
   * does not drift to a sentence thirty seconds later while it is being typed. Saving arms it again
   * for the next note.
   *
   * Held here rather than by the panel because 3.1.2's second entry point is the transport, which
   * outlives the recording page — two entry points reading one anchor cannot disagree about which
   * moment is being annotated, and neither can two mounts of the same composer.
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
  /**
   * Seek there **and play** — the chapter row's play control
   * ([3.22.12](docs/project/prd.md)).
   *
   * Its own method rather than a seek followed by a toggle, because a toggle on a teaching that is
   * already playing would pause it: a member pressing play on a chapter has asked for that chapter,
   * playing, whatever the transport was doing a moment before.
   */
  playFromMs(ms: number): void;
  skipMs(deltaMs: number): void;
  /** The next step, wrapping — what the rate pill does on a tap. */
  cycleSpeed(): void;
  /** One named step — what the picker the pill opens on a hold does. Anything else is ignored. */
  chooseSpeed(speed: number): void;
  /** Fetch the transcript if nothing has yet. Safe to call on every mount — it asks once. */
  requestTranscript(): void;
  setCaptions(on: boolean): void;
  /** Put a corrected line back in the loaded transcript, so the list and the pill agree with it. */
  applyCorrection(segment: TranscriptSegmentView): void;
  /**
   * Put a rewritten chapter list back in the store, after an admin edited one
   * ([3.22.7](docs/project/prd.md)).
   *
   * The **whole list**, never one chapter, because a boundary move changes where the chapter before
   * it ends and a merge removes a row: an update that patched one entry would leave the transport's
   * divisions describing a tiling that no longer exists. Every chapter write answers with the list
   * for exactly this reason.
   *
   * Ignored when it names a teaching that is not the one loaded — a late answer about a recording
   * the member has since left must not become this one's chapters, which is the guard every fetch in
   * this provider already takes.
   */
  replaceChapters(recordingId: string, chapters: readonly ChapterView[]): void;
  /** Read the loaded teaching's notes again — after a write, or after a failure the member retried. */
  refreshNotes(): void;
  /** Let the moment follow playback again — a composer opening, closing, or having just saved. */
  releaseComposerAnchor(): void;
  /** Fix the moment where the player is now. The first keystroke calls it; every later one is a no-op. */
  lockComposerAnchor(): void;
  /** Ask whichever screen is showing the notes to scroll to this one and mark it. */
  revealNote(noteId: string): void;
  /** Said by the screen that has done it, so the next press is a fresh request. */
  clearRevealedNote(): void;
}

const PlayerContext = createContext<PlayerApi | null>(null);

/**
 * **The breadcrumb trail** — set by whichever page has one, cleared when it unmounts.
 *
 * Widened in Story 6 from a single current title to a parent plus a current, which is the shape
 * `top-navigation/default.png` draws: a recording in a series reads `home › series › recording`,
 * and the parent is a link because getting back to the series in one press is the whole point of the
 * segment.
 *
 * **Widened again to a list of ancestors**, because the chapter page has two of them. A chapter is
 * inside a teaching which is inside a study, and a trail that could only hold one of those had to
 * choose — it chose the teaching, and a member three levels down was shown a path that quietly
 * skipped where they actually were. One `parent` was never a rule about the product, only about what
 * the shape could carry; a list carries what is true.
 *
 * The ancestors are **outermost first**, the order they are read in, so a page states its path the
 * way it would be spoken: study, then teaching, then the chapter you are on. A page with none keeps
 * the two-segment trail the library and the landing have always drawn.
 */
export interface BreadcrumbParent {
  readonly label: string;
  readonly href: string;
}

export interface BreadcrumbTrail {
  /** Outermost first. Every one is a link; the current page is the only segment that is not. */
  readonly ancestors: readonly BreadcrumbParent[];
  readonly current: string | null;
}

const NO_ANCESTORS: readonly BreadcrumbParent[] = [];

const EMPTY_TRAIL: BreadcrumbTrail = { ancestors: NO_ANCESTORS, current: null };

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
 * `ancestors` is **outermost first** and every caller rebuilds it on every render, which is the one
 * hazard this hook has to handle: an array literal in a dependency list is a new identity each time,
 * so the effect would re-run on every render and clear the trail it had just set. The previous shape
 * dodged that by taking the parent apart into two strings; a list cannot be taken apart, so the
 * effect is keyed on the array's **content** instead and reads the array itself through a ref. The
 * result is the same property as before — the trail is written when what it says changes, and not
 * otherwise — without the caller having to memoise anything.
 */
export function useBreadcrumbTrail(
  current: string | null,
  ancestors: readonly BreadcrumbParent[] = NO_ANCESTORS,
): void {
  const context = useContext(BreadcrumbContext);
  const setTrail = context?.setTrail;

  // Content, not identity. The separators are control characters, which cannot occur in a title
  // or a path — so no two different trails collide on one key, which a readable separator like
  // `|` would eventually let them do. Written as escapes: a literal control character in source
  // is invisible in every editor and is lost by the first tool that trims the line.
  const key = ancestors.map((one) => `${one.label}\u0000${one.href}`).join('\u0001');

  const latest = useRef(ancestors);
  latest.current = ancestors;

  useEffect(() => {
    setTrail?.({ ancestors: latest.current, current });
    return () => setTrail?.(EMPTY_TRAIL);
  }, [setTrail, current, key]);
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
  // Which member screen is showing — read only to decide whether the last sitting is restored.
  const pathname = usePathname();

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
  const [chapters, setChapters] = useState<LoadedChapters | null>(null);
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

  /**
   * Read a teaching's chapters into the store ([3.22](docs/project/prd.md)).
   *
   * **It cannot reach playback**, exactly as the notes read cannot: a chapter fetch that fails
   * leaves the transport without a second line and the track without its divisions, and leaves the
   * audio alone. That is the same trade 3.2.11 and the Availability NFR already take for the note
   * markers, and it is the whole reason this is a separate request rather than part of the one that
   * points the element.
   *
   * The late-answer guard is the notes fetch's, for the reason it gives: a slow answer about the
   * previous teaching must not become the current one's list — which here would put the wrong
   * chapter name on the bar and the wrong boundaries on the track.
   */
  const loadChapters = useCallback((recordingId: string): void => {
    void apiFetch<ChaptersPayload>(recordingChaptersPath(recordingId), { credentials: 'include' })
      .then((payload) => {
        if (loadedRef.current?.id !== recordingId) return;
        setChapters({ recordingId, chapters: payload.chapters });
      })
      .catch(() => {
        if (loadedRef.current?.id !== recordingId) return;
        // Cleared rather than left stale, for the notes' reason: no divisions over a failure, not
        // the previous teaching's divisions wearing this one's name.
        setChapters(null);
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
      // And the previous teaching's chapters would name the wrong theme on the bar and draw
      // boundaries at moments this teaching has nothing at.
      setChapters(null);
      /*
       * **The previous teaching's audio goes now, not when the new grant arrives.**
       *
       * `pointAt` replaces the source only if it succeeds, so a grant that fails left the element
       * holding the *last* teaching — the bar naming one recording while the element held another,
       * and a press on play producing the wrong sound. It also left that recording's metadata in
       * place, which silently clamped this one's restored position to the previous one's duration.
       *
       * Dropping the source is not a cost on the ordinary path: the grant is on its way, and
       * `renew` is the case where the source must survive — it keeps the same teaching and does not
       * come through here.
       */
      const element = audioRef.current;
      if (element !== null) {
        element.removeAttribute('src');
        element.load();
      }
      // Fetched **on open rather than on tab open**, because the markers (3.2.4) are visible on the
      // transport without the Notes tab ever being pressed.
      loadNotes(recording.id);
      // The same argument, one step stronger: the chapter playing is named on the bar and its
      // boundaries drawn on the track on **every** member screen (3.22.16, 3.22.17), so there is no
      // tab whose opening could be what asks for them.
      loadChapters(recording.id);
      void pointAt(recording.id).catch(() => {
        // Nothing to say on screen: the bar is a transport, not an error surface. The play control
        // simply does nothing until a grant arrives, and the next renewal tick tries again.
      });
    },
    [loadChapters, loadNotes, pointAt],
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

  /*
   * **The sitting survives the app being closed.** On the first load of the member surface, the
   * teaching this member was last part-way through is opened into the player — so the transport is
   * already docked, already naming it and already holding the position, and picking it back up is
   * the play control rather than a walk to the recording page to find it again.
   *
   * Opened and **not played**: sound a member did not ask for is the failure this trades against,
   * and a browser would refuse the autoplay regardless. `open` sets `wantsPlay` false and arms the
   * seek, which is exactly the state the recording page leaves the bar in.
   *
   * **Not on a teaching's own page.** That route opens a teaching itself, so restoring one here
   * would be a second grant, a second notes fetch and a stretch of seconds where the bar names the
   * *previous* sitting before the page replaces it — work nobody asked for and a bar that lies
   * while it is going on. Every other member screen has no teaching of its own and is exactly where
   * this belongs.
   *
   * Twice guarded against clobbering a real choice even so — before the request and again when it
   * answers. A member can navigate onto a teaching while this is in flight, and the row that comes
   * back is then the previous sitting: dropping it there is what stops a slow answer from replacing
   * what somebody is listening to.
   */
  useEffect(() => {
    if (loadedRef.current !== null || isRecordingPagePath(pathname)) return;
    let live = true;

    void apiFetch<ResumePayload>(RESUME_PATH, { credentials: 'include' })
      .then((payload) => {
        const row = payload.resume;
        if (!live || row === null || loadedRef.current !== null) return;
        open(
          {
            id: row.recordingId,
            title: row.title,
            artworkUrl: row.artworkUrl,
            seriesTitle: row.seriesTitle,
          },
          row.positionMs,
        );
      })
      .catch(() => {
        // Nothing to say: no bar is the state the surface was already in, and the member reaches
        // every teaching through the library exactly as before.
      });

    return () => {
      live = false;
    };
  }, [open, pathname]);

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

  /**
   * Seek there and play ([3.22.12](docs/project/prd.md)).
   *
   * The seek is written the same way `seekToMs` writes it — the element, the ref and the state
   * together, so the scrubber does not fall back to where it came from — and `wantsPlay` is set
   * before the play, because that is the flag a grant renewal restores. A press on a chapter is a
   * press for sound, and it has to survive the URL under it being replaced mid-listen.
   */
  const playFromMs = useCallback((ms: number): void => {
    const element = audioRef.current;
    if (element === null) return;
    const next = Math.max(0, ms);
    element.currentTime = next / 1000;
    positionRef.current = next;
    setCurrentMs(next);
    wantsPlay.current = true;
    void element.play().catch(() => undefined);
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
   * A step, applied to the element first and written to the account afterwards.
   *
   * Optimistic on purpose: the rate a member hears must change on the press, and the write is what
   * makes the *next* teaching start there. A failed write costs the persistence, not the press.
   *
   * Both ways into the rate come through here — the pill's tap, which asks for the next step, and
   * the picker it opens on a hold, which asks for one by name. One path to the element, one write,
   * and no chance of the two disagreeing about what "set the speed" involves.
   */
  const chooseSpeed = useCallback((next: number): void => {
    // A rate the tuple does not name is a rate the column would refuse; nothing that reaches here
    // should carry one, and a silent no-op is better than a request that comes back 400.
    if (!isPlaybackSpeed(next) || next === speedRef.current) return;
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

  const cycleSpeed = useCallback((): void => {
    chooseSpeed(nextPlaybackSpeed(speedRef.current));
  }, [chooseSpeed]);

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

  const replaceChapters = useCallback(
    (recordingId: string, next: readonly ChapterView[]): void => {
      if (loadedRef.current?.id !== recordingId) return;
      setChapters({ recordingId, chapters: next });
    },
    [],
  );

  const refreshNotes = useCallback((): void => {
    const recording = loadedRef.current;
    if (recording === null) return;
    loadNotes(recording.id);
  }, [loadNotes]);

  /**
   * Let the moment follow playback again.
   *
   * Called when a composer opens, when it closes, and **after every save** — a member who has just
   * written one note is composing nothing, so the next note starts from wherever the teaching has
   * reached rather than from where they opened the tab.
   */
  const releaseComposerAnchor = useCallback((): void => {
    setComposerAnchorMs(null);
  }, []);

  /**
   * Fix the moment where the player is **now**, and only if it is not already fixed.
   *
   * The updater form is what makes "the first keystroke decides" true without reading state: every
   * later keystroke calls this and finds a moment already held.
   *
   * `positionRef` rather than the `currentMs` state, because it is the position that is right
   * before anything has played: `open()` seeds it with the restored resume position, so a note
   * written on a teaching that has never been played anchors there rather than at `00:00`
   * (active-scope prd 3.1.3).
   *
   * **Nothing here touches the element.** Writing a note neither pauses nor moves playback (3.1.1) —
   * the lock is what stops the moment drifting while the note is typed, not a pause.
   */
  const lockComposerAnchor = useCallback((): void => {
    setComposerAnchorMs((held) => held ?? positionRef.current);
  }, []);

  const revealNote = useCallback((noteId: string): void => {
    setRevealedNoteId(noteId);
  }, []);

  const clearRevealedNote = useCallback((): void => {
    setRevealedNoteId(null);
  }, []);

  /**
   * **Which chapter is playing** ([3.22.16](docs/project/prd.md)) — arithmetic over a handful of
   * offsets, re-run whenever the position moves (project tdd 5.9).
   *
   * Memoised on the list and the position rather than computed inside the API object, so the three
   * surfaces that read it get one answer per tick rather than one each. It stays correct offline for
   * the same reason it costs nothing: no request is involved.
   */
  const currentChapter = useMemo(
    () => (chapters === null ? null : chapterAt(chapters.chapters, currentMs)),
    [chapters, currentMs],
  );

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
      chapters,
      currentChapter,
      composerAnchorMs,
      revealedNoteId,
      open,
      toggle,
      seekToMs,
      playFromMs,
      skipMs,
      cycleSpeed,
      chooseSpeed,
      requestTranscript,
      setCaptions,
      applyCorrection,
      replaceChapters,
      refreshNotes,
      releaseComposerAnchor,
      lockComposerAnchor,
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
      chapters,
      currentChapter,
      composerAnchorMs,
      revealedNoteId,
      open,
      toggle,
      seekToMs,
      playFromMs,
      skipMs,
      cycleSpeed,
      chooseSpeed,
      requestTranscript,
      setCaptions,
      applyCorrection,
      replaceChapters,
      refreshNotes,
      releaseComposerAnchor,
      lockComposerAnchor,
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
