import { MediaSession as ShellMediaSession } from '@capgo/capacitor-media-session';
import { shellPlatform } from '@/client/platform';

/**
 * **The lock screen inside the Android store shell** ([3.2.6](docs/project/prd.md); tdd § 2.1).
 *
 * In a browser the player drives `navigator.mediaSession` and the platform draws the lock screen
 * from it. Android's WebView has **no Media Session API at all** — no `navigator.mediaSession`
 * and no `MediaMetadata` constructor (checked on an API 37 emulator) — so a teaching keeps playing
 * when the phone locks and there is no way to pause it short of unlocking the phone and finding
 * the app. The Capacitor plugin `@capgo/capacitor-media-session` is that missing half — a native
 * `MediaSession` behind a foreground service, which is also what keeps the process alive once the
 * system starts shedding background work.
 *
 * What is decided here is that **the player should not know about the plugin.** It talks to one
 * object with the four members of the Media Session API it uses, and this module answers that
 * object: inside the Android shell, an adapter that forwards each call to the plugin; everywhere
 * else, `null`, and the player goes on reading `navigator.mediaSession` exactly as before — so the
 * browser suite, which watches that object, is unaffected.
 *
 * **iOS keeps the browser path on purpose.** WebKit wires `navigator.mediaSession` to the system's
 * now-playing centre itself, and the plugin's iOS side is the same web implementation, so routing
 * through it would be a second writer to the same screen. If a device test on a Mac finds the iOS
 * lock screen empty, the switch is the one condition in {@link shellMediaSession}.
 *
 * Fire-and-forget: every plugin method returns a promise, and the player's calls are synchronous
 * property writes four times a second. A rejection is swallowed rather than surfaced because the
 * worst it can mean is a lock screen a tick out of date, and the next declaration corrects it; an
 * unhandled rejection would be a console error in the member's app for the same non-event.
 */

/** The members of `MediaSession` the player drives; `navigator.mediaSession` satisfies it as is. */
export interface PlayerMediaSession {
  metadata: MediaMetadata | null;
  playbackState: MediaSessionPlaybackState;
  setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void;
  /** Optional because an older browser carries the session and not this method. */
  setPositionState?(state?: MediaPositionState): void;
}

/**
 * The actions the plugin's native side draws a button for. `setActionHandler` throws for any
 * other — the same contract as a browser that does not know an action — and the player already
 * registers each action on its own so that one refusal costs nothing else.
 */
const SHELL_ACTIONS = [
  'play',
  'pause',
  'seekbackward',
  'seekforward',
  'previoustrack',
  'nexttrack',
  'seekto',
  'stop',
] as const;

type ShellAction = (typeof SHELL_ACTIONS)[number];

function isShellAction(action: MediaSessionAction): action is ShellAction {
  return (SHELL_ACTIONS as readonly string[]).includes(action);
}

function swallow(promise: Promise<unknown>): void {
  promise.catch(() => {
    // The next declaration says it again; see the module comment.
  });
}

/** The adapter. One per page, created on first use, because the plugin holds one session. */
class ShellSessionAdapter implements PlayerMediaSession {
  #metadata: MediaMetadata | null = null;
  #playbackState: MediaSessionPlaybackState = 'none';

  get metadata(): MediaMetadata | null {
    return this.#metadata;
  }

  /**
   * Empty strings rather than an empty object when clearing: the plugin keeps whatever field a
   * call leaves out, so "nothing is loaded" has to be said explicitly or the notification goes on
   * naming the previous teaching.
   */
  set metadata(value: MediaMetadata | null) {
    this.#metadata = value;
    swallow(
      ShellMediaSession.setMetadata(
        value === null
          ? { title: '', artist: '', album: '', artwork: [] }
          : {
              title: value.title,
              artist: value.artist,
              album: value.album,
              artwork: value.artwork.map((image) => ({
                src: image.src,
                ...(image.sizes === '' ? {} : { sizes: image.sizes }),
                ...(image.type === '' ? {} : { type: image.type }),
              })),
            },
      ),
    );
  }

  get playbackState(): MediaSessionPlaybackState {
    return this.#playbackState;
  }

  /** `playing` and `paused` start the foreground service and its notification; `none` ends them. */
  set playbackState(value: MediaSessionPlaybackState) {
    this.#playbackState = value;
    swallow(ShellMediaSession.setPlaybackState({ playbackState: value }));
  }

  setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void {
    if (!isShellAction(action)) {
      throw new TypeError(`The store shell's media session has no "${action}" action.`);
    }
    swallow(
      ShellMediaSession.setActionHandler(
        { action },
        handler === null
          ? null
          : (details) => {
              // The plugin reports `seekTime: null` for every action but `seekto`, where the API
              // leaves it out; forwarded as is, a `stop` would read as a seek to zero.
              handler({
                action,
                ...(typeof details.seekTime === 'number' ? { seekTime: details.seekTime } : {}),
              });
            },
      ),
    );
  }

  /**
   * The plugin has no "clear": called with nothing, which the player does when there is nothing
   * true to declare, this says nothing. That is safe because the player declares `paused` or
   * `none` in the same breath, and the device only extrapolates a clock while it is told
   * `playing`.
   */
  setPositionState(state?: MediaPositionState): void {
    if (state === undefined) return;
    const { duration, position, playbackRate } = state;
    swallow(
      ShellMediaSession.setPositionState({
        ...(duration === undefined ? {} : { duration }),
        ...(position === undefined ? {} : { position }),
        ...(playbackRate === undefined ? {} : { playbackRate }),
      }),
    );
  }
}

/**
 * The `MediaMetadata` the WebView lacks, with the shape the player reads back through the adapter.
 *
 * The player builds its metadata with `new MediaMetadata(init)` and treats a missing constructor
 * as "nothing can be named" — right for an old browser, where the session is missing too, and
 * wrong here, where the session is the plugin's and only the constructor is missing. Supplying it
 * is cheaper and safer than teaching the player a second way to say the same thing: the browser
 * path stays byte-for-byte what the browser suite watches. Installed only inside the Android
 * shell, and only when the WebView has none of its own, so a future WebView that gains the API
 * keeps its real one. Fields default the way the spec's do: empty strings, an empty list.
 */
class ShellMediaMetadata {
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly artwork: readonly MediaImage[];

  constructor(init: MediaMetadataInit = {}) {
    this.title = init.title ?? '';
    this.artist = init.artist ?? '';
    this.album = init.album ?? '';
    this.artwork = (init.artwork ?? []).map((image) => ({
      src: image.src,
      sizes: image.sizes ?? '',
      type: image.type ?? '',
    }));
  }
}

function installMediaMetadata(): void {
  const scope = globalThis as { MediaMetadata?: unknown };
  if (typeof scope.MediaMetadata !== 'function') scope.MediaMetadata = ShellMediaMetadata;
}

let adapter: ShellSessionAdapter | null = null;

/**
 * The session to drive inside the Android store shell, or `null` anywhere else — a browser, the
 * installed PWA, the iOS shell and the server render alike — where the caller falls back to
 * `navigator.mediaSession`.
 */
export function shellMediaSession(): PlayerMediaSession | null {
  if (shellPlatform() !== 'android') return null;
  if (adapter === null) {
    installMediaMetadata();
    adapter = new ShellSessionAdapter();
  }
  return adapter;
}
