'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Chrome's install event. It is not in the DOM lib because no standard describes it — only
 * Chromium fires it — so the two members this file touches are declared here.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/*
 * The captured event lives at module scope, not in state, because Chrome fires it once and does not
 * fire it again for a component that mounts later. The member menu is closed on arrival and the
 * button therefore mounts long after the event has been and gone; a listener inside the component
 * would miss it every time. This module is imported by the navigation, so the listener is installed
 * as soon as the client bundle runs — which is early enough — and `useSyncExternalStore` is how the
 * button then reads a value that changed outside React.
 *
 * Calling `preventDefault` is what suppresses Chrome's own mini-infobar, which is the trade this
 * makes: the prompt is ours to offer from the menu, so it has to be offered.
 */
let deferredPrompt: BeforeInstallPromptEvent | null = null;
const subscribers = new Set<() => void>();

function publish(): void {
  for (const notify of subscribers) notify();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    publish();
  });
  // Installing consumes the prompt; a stale one would offer to install what is already installed.
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    publish();
  });
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

/**
 * Is this an iPhone or an iPad? iPadOS reports itself as a Mac, and the only thing that separates
 * it from a desktop Safari is that it answers to touch.
 */
function isAppleTouchDevice(): boolean {
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return true;
  return /macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
}

/** Already launched from the home screen — `navigator.standalone` is the older iOS spelling. */
function isInstalled(): boolean {
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/**
 * **Install the hub to a phone's home screen** — the menu's last entry before *Sign out*.
 *
 * One row that behaves differently on the two platforms, because the platforms are different in a
 * way no library papers over:
 *
 * - **Android** hands us a prompt to fire when we choose. The row spends it.
 * - **iOS** has no such API and never will have one; *Add to Home Screen* lives in the Safari share
 *   sheet and can only be reached by hand. The row therefore says where the button is. That is the
 *   whole feature on iOS, and pretending otherwise — a row that looks like it installs and then
 *   does nothing — is worse than telling someone to tap Share.
 *
 * The row renders **nothing at all** when there is nothing to offer: already installed, or a
 * browser that has not offered a prompt. A permanently dead *Install app* entry is the disabled
 * control this navigation refuses elsewhere.
 *
 * Both checks run in an effect rather than during render because both read the browser. The server
 * renders no row, and so does the first client paint, which is what keeps hydration honest.
 */
export function InstallApp({
  className,
  hintClassName,
}: {
  className?: string | undefined;
  hintClassName?: string | undefined;
}) {
  const prompt = useSyncExternalStore(
    subscribe,
    () => deferredPrompt,
    () => null,
  );
  const [platform, setPlatform] = useState<'pending' | 'ios' | 'other'>('pending');
  const [installed, setInstalled] = useState(true);
  const [showIosSteps, setShowIosSteps] = useState(false);

  useEffect(() => {
    setPlatform(isAppleTouchDevice() ? 'ios' : 'other');
    setInstalled(isInstalled());
  }, []);

  if (installed) return null;

  if (prompt !== null) {
    return (
      <li>
        <button
          className={className}
          type="button"
          onClick={() => {
            void prompt.prompt();
          }}
        >
          Install app
        </button>
      </li>
    );
  }

  if (platform !== 'ios') return null;

  return (
    <>
      <li>
        <button
          className={className}
          type="button"
          aria-expanded={showIosSteps}
          onClick={() => setShowIosSteps((was) => !was)}
        >
          Install app
        </button>
      </li>
      {showIosSteps ? (
        <li className={hintClassName}>
          In Safari, tap Share, then <strong>Add to Home Screen</strong>. You will sign in once more
          inside the installed app.
        </li>
      ) : null}
    </>
  );
}
