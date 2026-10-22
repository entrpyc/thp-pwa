/**
 * **Which store shell, if any, this page is running inside.** The Capacitor shell injects a
 * `Capacitor` object into the WebView before any page script runs, and its `getPlatform()` is the
 * one signal the web app has that it is inside a native wrapper rather than a browser tab
 * (docs/project/tdd.md decision 4.3). The shell carries no product logic, so everything that
 * behaves differently in a store build — install prompts, download storage, push — decides from
 * this one reader instead of each feeling for `window.Capacitor` on its own.
 *
 * `null` is "a browser", which includes the installed PWA: that distinction is display-mode's,
 * not the bridge's (see `detectInstallSource` in observability/config.ts).
 */

export type ShellPlatform = 'ios' | 'android';

/** The one property of a window the question reads, so a test can hand in a plain object. */
export interface ShellView {
  readonly Capacitor?: { readonly getPlatform?: () => string };
}

/**
 * Pure form: reads the bridge off whatever it is given. `getPlatform()` answers `'web'` when the
 * bridge is present but the page is served to a browser — the Capacitor runtime does that in a
 * bundled app — and that is a browser as far as the product is concerned.
 */
export function shellPlatformOf(view: ShellView): ShellPlatform | null {
  const platform = view.Capacitor?.getPlatform?.();
  if (platform === 'ios' || platform === 'android') return platform;
  return null;
}

/** Reads `window`; `null` where there is none, so a server render can call it safely. */
export function shellPlatform(): ShellPlatform | null {
  if (typeof window === 'undefined') return null;
  return shellPlatformOf(window as unknown as ShellView);
}
