import { PushNotifications } from '@capacitor/push-notifications';
import {
  PUSH_SUBSCRIPTIONS_PATH,
  type PushPlatform,
  type RegisterPushSubscriptionPayload,
  type RegisterPushSubscriptionRequest,
  type UnregisterPushSubscriptionPayload,
  type UnregisterPushSubscriptionRequest,
} from '@thp/shared';
import { apiFetch } from '@/client/api-client';
import { shellPlatform } from '@/client/platform';

/**
 * **This device, as a push target** ([3.17.1](docs/project/prd.md), [5.2.5](docs/project/prd.md)).
 *
 * Three platforms, one object. In a browser or the installed PWA the device is a Web Push
 * subscription made through the service worker; inside a store shell it is an APNs or FCM token
 * the Capacitor plugin hands back. The settings section and the sign-out button talk to this
 * module and never to either, in the manner of `shell-media-session.ts`: the surface that behaves
 * differently in a store build decides from `shellPlatform()` once, here.
 *
 * **Nothing here runs on a page load.** Every function is called from a press — *Turn on push on
 * this device*, *Sign out* — which is the one thing Apple guideline 5.1.2 and every browser's
 * permission model require: a prompt a member did not ask for is refused by Chrome and Safari
 * outright and refused by App Review on sight.
 *
 * **The endpoint is remembered in `localStorage`** so sign-out can name it to the server. In a
 * browser the subscription could be read back from the worker, but the shell's token cannot be
 * re-asked without re-registering, and one remembered string serves both. It is the address and
 * nothing else; a device that loses it simply re-registers on the next press.
 */

const ENDPOINT_KEY = 'thp.push.endpoint';

export type PushSupport =
  /** A browser with the Push API; the member may still have to install the PWA first on iOS. */
  | 'web'
  | 'ios'
  | 'android'
  /** No Push API and no shell: an old browser, a private window, an http:// page. */
  | 'unsupported';

/** What this page can do about push, decided once. */
export function pushSupport(): PushSupport {
  const shell = shellPlatform();
  if (shell !== null) return shell;
  if (typeof window === 'undefined') return 'unsupported';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'unsupported';
  }
  return 'web';
}

export type PushPermission = 'granted' | 'denied' | 'prompt' | 'unsupported';

/** The platform's answer, without asking. */
export async function pushPermission(): Promise<PushPermission> {
  const support = pushSupport();
  if (support === 'unsupported') return 'unsupported';
  if (support === 'web') {
    const state = Notification.permission;
    return state === 'default' ? 'prompt' : state;
  }
  const { receive } = await PushNotifications.checkPermissions();
  if (receive === 'granted') return 'granted';
  if (receive === 'denied') return 'denied';
  return 'prompt';
}

/** The address this device registered, if it has. */
export function rememberedEndpoint(): string | null {
  try {
    return window.localStorage.getItem(ENDPOINT_KEY);
  } catch {
    return null;
  }
}

function remember(endpoint: string | null): void {
  try {
    if (endpoint === null) window.localStorage.removeItem(ENDPOINT_KEY);
    else window.localStorage.setItem(ENDPOINT_KEY, endpoint);
  } catch {
    // Private mode. The next press registers again, which is harmless: the endpoint is unique.
  }
}

export type EnableResult =
  | { readonly ok: true; readonly platform: PushPlatform }
  | { readonly ok: false; readonly reason: 'denied' | 'unsupported' | 'no-key' | 'failed' };

/**
 * **Ask, subscribe, register.** Called from the button and nowhere else.
 *
 * On the web the permission prompt is the browser's, raised by `pushManager.subscribe` itself;
 * a denial is answered `denied` and the member is told where to change their mind. `publicKey`
 * is the deployment's VAPID public key, from the preferences payload; without one a browser
 * cannot subscribe, and the section never offers the button.
 *
 * In a shell the plugin asks, then registers with APNs or FCM and answers the token on an event
 * rather than from `register()`, so the token is awaited with a bound: a device with no Google
 * services, say, never fires it.
 */
export async function enablePushOnThisDevice(publicKey: string | null): Promise<EnableResult> {
  const support = pushSupport();
  if (support === 'unsupported') return { ok: false, reason: 'unsupported' };

  if (support === 'web') {
    if (publicKey === null) return { ok: false, reason: 'no-key' };
    let subscription: PushSubscription;
    try {
      const registration = await navigator.serviceWorker.ready;
      subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(publicKey),
        }));
    } catch {
      return { ok: false, reason: Notification.permission === 'denied' ? 'denied' : 'failed' };
    }
    const json = subscription.toJSON();
    const keys = json.keys;
    if (!json.endpoint || !keys?.['p256dh'] || !keys['auth']) return { ok: false, reason: 'failed' };
    return register({
      platform: 'web',
      endpoint: json.endpoint,
      keys: { p256dh: keys['p256dh'], auth: keys['auth'] },
    });
  }

  const permission = await PushNotifications.requestPermissions();
  if (permission.receive !== 'granted') return { ok: false, reason: 'denied' };
  let token: string;
  try {
    token = await shellToken();
  } catch {
    return { ok: false, reason: 'failed' };
  }
  return register({ platform: support, endpoint: token });
}

async function register(request: RegisterPushSubscriptionRequest): Promise<EnableResult> {
  try {
    await apiFetch<RegisterPushSubscriptionPayload>(PUSH_SUBSCRIPTIONS_PATH, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch {
    return { ok: false, reason: 'failed' };
  }
  remember(request.endpoint);
  return { ok: true, platform: request.platform };
}

/**
 * Re-register a token the shell has rotated. The plugin's `registration` event fires on every
 * `register()` and on a platform-driven rotation; the listener component hands the token here,
 * and only a token that differs from the remembered one costs a request.
 */
export async function adoptShellToken(token: string): Promise<void> {
  const platform = shellPlatform();
  if (platform === null || token === rememberedEndpoint()) return;
  await register({ platform, endpoint: token });
}

/**
 * **Forget this device** — the sign-out button's first act, while the session still exists to
 * authorise it. The server row goes, then the browser's own subscription, so a dead endpoint is
 * never left for the next event to discover. Best effort throughout: sign-out must not be held
 * up by a push service, and a row left behind is removed the first time a push to it answers
 * *gone*.
 */
export async function disablePushOnThisDevice(): Promise<void> {
  const endpoint = rememberedEndpoint();
  if (endpoint !== null) {
    const body: UnregisterPushSubscriptionRequest = { endpoint };
    await apiFetch<UnregisterPushSubscriptionPayload>(PUSH_SUBSCRIPTIONS_PATH, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => undefined);
    remember(null);
  }
  if (pushSupport() === 'web') {
    try {
      const registration = await navigator.serviceWorker.ready;
      await (await registration.pushManager.getSubscription())?.unsubscribe();
    } catch {
      // No worker, no subscription, or a browser that refuses: nothing to undo.
    }
  }
}

/** The plugin answers the token on an event; one registration, one bounded wait. */
function shellToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void cleanup();
      reject(new Error('no registration token within 20 s'));
    }, 20_000);
    const handles: Promise<{ remove(): Promise<void> }>[] = [];
    const cleanup = async () => {
      clearTimeout(timer);
      for (const handle of handles) await (await handle).remove().catch(() => undefined);
    };
    handles.push(
      PushNotifications.addListener('registration', (token) => {
        void cleanup();
        resolve(token.value);
      }),
      PushNotifications.addListener('registrationError', (error) => {
        void cleanup();
        reject(new Error(error.error));
      }),
    );
    void PushNotifications.register().catch((cause: unknown) => {
      void cleanup();
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    });
  });
}

/** `pushManager.subscribe` wants the VAPID public key as raw bytes, and it is published base64url. */
export function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}
